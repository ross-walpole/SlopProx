// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// classifier.js

// Single source of truth for AI slop detection.
// Used by both proxy.js (heuristic-only, server-side) and service.js (full ML + heuristic).

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');
const sharp  = require('sharp');
const { logError, debugLog } = require('./logger');
const config = require('./config');

// ── Model integrity verification ─────────────────────────────────
// SHA256 hashes of the quantized ONNX files for Models B and C.
// Set to null to skip verification (first run / hash not yet pinned).
// After first download, hashes are logged — pin them here for subsequent releases.
const KNOWN_MODEL_HASHES = {
  'onnx-community/SMOGY-Ai-images-detector-ONNX':    'ea91833531059e3f24997b07c88569c3b0922d56a405d0976ec5a175240c974b',
  'onnx-community/Deep-Fake-Detector-v2-Model-ONNX': '3519c22b9695f99ddc00821228eeac91239065a90bfbdb4917858b3ec1dcfc42',
};

async function _verifyAndLogModelFiles(modelCacheDir, modelId) {
  try {
    if (!fs.existsSync(modelCacheDir)) return;
    const onnxFiles = fs.readdirSync(modelCacheDir).filter(f => f.endsWith('.onnx'));
    for (const f of onnxFiles) {
      const filePath = path.join(modelCacheDir, f);
      // Stream-hash instead of readFileSync — avoids blocking the event loop for ~50–90 MB ONNX files.
      const hash = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => h.update(chunk));
        stream.on('end', () => resolve(h.digest('hex')));
      });
      const expected = KNOWN_MODEL_HASHES[modelId];
      if (expected === null) {
        debugLog(`[ModelIntegrity] ${modelId}/${f} SHA256=${hash} (not yet pinned)`);
      } else if (hash !== expected) {
        fs.unlinkSync(filePath);
        throw new Error(`Model integrity check FAILED for ${modelId}/${f} — file removed. Expected ${expected.slice(0,16)}… got ${hash.slice(0,16)}…`);
      } else {
        debugLog(`[ModelIntegrity] ${modelId}/${f} OK`);
      }
    }
  } catch (err) {
    if (err.message?.includes('integrity check FAILED')) throw err;
    logError(err);
  }
}

let isModelReady = false;
let textClassifier = null;

// ── Text Model 2 ─────────────────────────────────────────────────
// Second independent text classifier trained on different data.
// Loaded in the background after Model 1 is ready.
// Different training distribution gives genuine independent vote — the
// ensemble only boosts confidence when both models agree.
let textClassifier2 = null;
let isModel2Ready = false;
let _textModel2RetryTimer = null;
const MODEL2_ID    = 'onnx-community/e5-small-lora-ai-generated-detector-ONNX';
const MODEL2_LABEL = 'AI text detector v2 (E5-small LoRA)';

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache   = new Map();
  }

  has(key) { return this.cache.has(key); }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
  }

  get size() { return this.cache.size; }
}

const classificationCache = new LRUCache(500);

// ── Image models ─────────────────────────────────────────────────
let imageClassifier = null;
let _isImageModelReady = false;

// Model A label (primary gate)
const MODEL_A_LABEL = 'Multi-label AI image classifier';

// Model B: onnx-community/SMOGY-Ai-images-detector-ONNX
//   - Swin Transformer fine-tuned from Organika/sdxl-detector
//   - Confirmed coverage: Flux (83%), DALL-E (91%), Imagen (76%), SD (88%), SDXL (98%)
//   - Binary: AI generated vs Real
//   - ~52 MB (q4f16 quantized), downloaded on first use and cached
let modelBClassifier = null;
let _isModelBReady = false;
const MODEL_B_ID    = 'onnx-community/SMOGY-Ai-images-detector-ONNX';
const MODEL_B_LABEL = 'Diffusion model detector (SDXL · Flux · DALL-E)';

// Model C: onnx-community/Deep-Fake-Detector-v2-Model-ONNX
//   - ViT-Base fine-tuned on real vs deepfake/AI-generated images
//   - Labels: "Realism" (0) / "Deepfake" (1)
//   - Adds a third independent vote to the ensemble; particularly useful when
//     Model A (multi-label) and Model B (SDXL-biased) disagree
//   - ~87 MB (model_quantized.onnx), downloaded on first use and cached
let modelCClassifier = null;
let _isModelCReady = false;
const MODEL_C_ID    = 'onnx-community/Deep-Fake-Detector-v2-Model-ONNX';
const MODEL_C_LABEL = 'Deepfake & synthetic image detector';

let _modelBRetryTimer = null;
let _modelCRetryTimer = null;

// Model D slot — reserved for a future anime/illustration specialist.
// Currently disabled: no BEiT or suitable anime-specific ONNX model is
// available in transformers.js 3.x (BeitImageProcessor not supported).
// Style detection still benefits FP reduction via the adaptive threshold.
let modelDClassifier = null;
let _isModelDReady = false;
const MODEL_D_ID    = null;
const MODEL_D_LABEL = 'Anime & illustration detector';

// Ensemble uses a simple mean across whichever models fired — equal weight
// per available model, with consensus/veto adjustments applied on top.

// ── Heuristic content-type router ────────────────────────────────
// Replaces the CLIP zero-shot model (~600 MB download) with a fast
// pixel-based heuristic. The only routing decision that matters is
// "is this a screenshot/UI meme?" so we can skip detection on it.
// Screenshots have three highly reliable signals:
//   1. Aspect ratio matching common screen sizes (16:9, 16:10, 4:3, 21:9)
//   2. Very low colour entropy — UI chrome is mostly flat, uniform regions
//   3. High proportion of near-identical rows (horizontal bands of solid colour)

let activeImageJobs = 0;
const IMAGE_QUEUE = [];
// Scale concurrency to available CPU cores: half the logical cores, min 2, max 6.
const MAX_IMG_CONCURRENT = Math.min(6, Math.max(2, Math.floor(os.cpus().length / 2)));

// High-signal phrases — chosen for low false-positive rate in human writing.
// Each entry is tested as a whole word/phrase boundary (regex \b) to avoid
// matching substrings inside longer words (e.g. "leveraging" inside "overleveraging").
// Phrases that commonly appear in genuine human writing are excluded.
const SLOP_PHRASES = [
  // Classic LLM clichés
  'delve into', 'delves into',
  'nuanced understanding', 'nuanced approach',
  'it is worth noting that', "it's worth noting",
  'it is important to note', "it's important to note",
  'this underscores', 'this highlights the importance',
  'in today\'s rapidly evolving', "in today's fast-paced",
  'unlock the potential', 'unlock your potential',
  'game-changer',
  'holistic approach', 'synergistic',
  'foster a culture of', 'foster innovation',
  'leverage the power of',
  'dive deep into', 'dive deeper into',
  'comprehensive guide', 'shed light on',
  'navigate the complexities',
  'embark on a journey', 'seamlessly integrates',
  'robust framework', 'at the forefront of',
  'revolutionize the way',
  'without further ado', 'in the realm of',
  'let\'s explore', 'i\'ll walk you through',
  'by the end of this', 'in this article, we will',
  'with that being said', 'having said that',
  // Feed / social post LLM markers (very low human rate)
  'key takeaways',
  'actionable insights',
  'let me know in the comments',
  'in the ever-evolving',
  'stay ahead of the curve',
  'thrilled to announce',
  // Structural LLM transitions
  'it goes without saying',
  'at its core',
  'moving forward,',
  'in summary,',
  'to put it simply',
  'make no mistake',
  'pave the way',
  'cutting-edge',
  'best practices',
  'the bottom line is',
  'a testament to',
  'when it comes to',
  // Additional high-signal LLM phrases (low human rate, sourced from HC3/GPT datasets)
  'i hope this helps',
  'i hope this article',
  'feel free to',
  'certainly!',
  'great question',
  'as an ai',
  'as a language model',
  'let me clarify',
  'in essence,',
  'it\'s important to note',
  'it is important to understand',
  'as we delve',
  'this article will',
  'this guide will',
  'we will explore',
  'let\'s dive into',
  'transformative impact',
  'landscape is constantly',
  'ever-changing landscape',
  'multifaceted approach',
  'it\'s worth mentioning',
  'it should be noted',
  'it\'s crucial to',
  'it is crucial to',
  'paramount importance',
  'underscore the importance',
  'in the context of',
  'plays a crucial role',
  'plays a pivotal role',
  'in recent years,',
  // Gerund/variant forms missing from original list
  'navigating the complexities',
  'fostering genuine',
  'fostering authentic',
  'fostering a culture',
  'competitive landscape',
  'moving forward in',
  'the game-changer is',
  'it is paramount',
  'the bottom line:',
  'what truly matters',
  'thrilled to be',
  'excited to share',
  'excited to announce',
];

// Pre-compile phrase regexes once at module load — avoids ~116 RegExp constructions
// per classification call (significant on feed pages with many posts).
const SLOP_PHRASE_RES = SLOP_PHRASES.map(p =>
  new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
);

// Returns a score 0–40. Pure heuristic, synchronous.
// NOTE: length alone is NOT a signal — many long real articles would false-positive.
// Structural signals (sentence uniformity) only fire on 6+ sentence texts.
function getSlopScore(text) {
  let score = 0;
  const lower = text.toLowerCase();

  // Protect common abbreviations before sentence-splitting so "Dr. Smith"
  // doesn't become two sentences. Replace the dot with a placeholder.
  const safeText = text.replace(
    /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Ave|Blvd|Dept|Inc|Ltd|Corp|vs|etc|approx|est|fig|no|vol|pp|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|U\.S|e\.g|i\.e)\./gi,
    '$1\u2024' // one-dot leader, visually identical but won't split
  );
  const sentences = safeText.split(/[.!?]+/).filter(s => s.trim().length > 8);
  const words = text.split(/\s+/).filter(w => w.length > 2);
  const avgLen = sentences.length ? words.length / sentences.length : 0;
  // Shared across structural-uniformity and burstiness checks below.
  const lengths = sentences.map(s => s.split(/\s+/).length);

  // ── Academic text whitelist ───────────────────────────────────────
  // Deduct before structural signals — academic prose has uniformly structured
  // sentences and low burstiness by convention, not because it's AI-generated.
  const citationNum    = (text.match(/\[\d+(?:,\s*\d+)*\]/g) || []).length;
  const citationAuthor = (text.match(/\([A-Z][a-zA-Zé\-]+(?:\s+(?:&\s+)?[A-Z][a-zA-Zé\-]+)*,\s*\d{4}[a-z]?\)/g) || []).length;
  const sectionHeads   = (text.match(/^(?:\d+\.)+\s+[A-Z]/gm) || []).length;
  const totalCitations = citationNum + citationAuthor;
  if      (totalCitations >= 4) score -= 10;
  else if (totalCitations >= 2) score -= 6;
  else if (totalCitations >= 1) score -= 3;
  if (sectionHeads >= 2) score -= 3;

  // ── Structural uniformity ──────────────────────────────────────────
  // Weights reduced — uniform sentence structure is common in all professional
  // writing, not just LLM output. Phrase signals are more discriminative.
  if (sentences.length > 6) {
    const variance = lengths.reduce((a, b) => a + Math.pow(b - avgLen, 2), 0) / lengths.length;
    if (variance < 100) score += 3;
    else if (variance < 150) score += 1;
    if (Math.max(...lengths) - Math.min(...lengths) < 20) score += 2;
  }

  // ── Short-text structural openers (2–5 sentences) ─────────────────
  // Long texts get structural uniformity scoring above. Short AI snippets
  // (social posts, tweets, Discord messages) don't have enough sentences
  // to measure uniformity, so instead we look for LLM opener/closer patterns
  // that appear at very high rates in short-form AI content.
  if (sentences.length >= 2 && sentences.length <= 5) {
    if (/\blet me (walk you through|explain|break (this|it) down)\b/i.test(text)) score += 4;
    if (/\bhere'?s (why|what|how|the thing)\b/i.test(text)) score += 3;
    if (/\bthe (truth|reality|key|secret) is\b/i.test(text)) score += 3;
    if (/\b(this is|that'?s) (why|how|what)\b/i.test(text)) score += 2;
    if (/\bin (today'?s|this) (world|age|era|landscape|digital)\b/i.test(text)) score += 3;
    if (/\bwhether you('?re| are)\b/i.test(text)) score += 2;
    if (/\b(drop|comment|share) (below|your thoughts|if you)\b/i.test(text)) score += 4;
    if (/\bfollow (me|us) for (more|updates)\b/i.test(text)) score += 4;
    if (/\b(what do you think|let me know your thoughts)\b/i.test(text)) score += 3;
  }

  // ── Human-content whitelist — reduce score for signals of real writing ──
  // URLs, @mentions, and code blocks are reliable human signals — AI-generated
  // social posts almost never include these. Hashtags are NOT included: AI posts
  // on LinkedIn/Twitter routinely append #Leadership #Growth etc., so counting
  // them as a human signal causes false negatives on AI content.
  const humanSignals = (text.match(/https?:\/\/\S+/g) || []).length          // URLs
    + (text.match(/@[\w]+/g) || []).length                                    // @mentions
    + (text.match(/```[\s\S]*?```|`[^`]+`/g) || []).length;                   // code blocks
  if (humanSignals >= 2) score -= 6;
  else if (humanSignals >= 1) score -= 3;

  // ── Slop phrases: +2 each — for short texts require 2+ hits to score ─
  // Short posts (< 200 chars) with only one cliché phrase are often just
  // enthusiastic human writing. Require at least two phrase hits to penalise.
  let phraseHits = 0;
  for (const re of SLOP_PHRASE_RES) {
    if (re.test(lower)) phraseHits++;
  }
  const phraseScore = (text.length < 200 && phraseHits < 2) ? 0 : phraseHits * 2;
  score += phraseScore;

  // ── Formatting tell-tales ────────────────────────────────────────
  const emojiCount = (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  if (emojiCount > 8) score += 6;
  else if (emojiCount > 4) score += 3;

  if (/[✅✔️✔]/u.test(text)) score += 5;
  if ((text.match(/^[•\-–—*]/gm) || []).length > 3) score += 4;   // heavy bullet use
  if ((text.match(/^\d+\.\s/gm) || []).length >= 3)  score += 4;  // numbered list (1. 2. 3.)

  // ── Lexical diversity: LLMs repeat filler words frequently ───────
  const wordCounts = {};
  for (const w of words) wordCounts[w] = (wordCounts[w] || 0) + 1;
  const uniqueRatio = Object.keys(wordCounts).length / (words.length || 1);
  if (uniqueRatio < 0.48) score += 4;
  if (uniqueRatio < 0.40) score += 3;

  // ── Burstiness / coefficient of variation ────────────────────────
  if (sentences.length >= 4) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (mean > 0) {
      const std = Math.sqrt(lengths.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / lengths.length);
      const cv  = std / mean;
      if (cv < 0.25) score += 3;
      else if (cv < 0.35) score += 1;
    }
  }

  // ── LLM structural openers ────────────────────────────────────────
  // LLMs frequently start with "In this [article/guide/post]..." or end with
  // "In conclusion..." — very reliable signals when combined with other evidence.
  if (/\bin (this|our) (article|post|guide|tutorial|blog|piece)\b/i.test(text)) score += 3;
  if (/\bin conclusion[,.]?\s/i.test(text) || /\bto summarize[,.]?\s/i.test(text)) score += 4;
  if (/\bhope (this|you found this)\b/i.test(text)) score += 3;

  return Math.max(0, Math.min(score, 40));
}

// ── Stylometric signal ────────────────────────────────────────────
// Two pure-JS signals orthogonal to phrase-matching and ML classification.
//
// 1. Inter-sentence Jaccard similarity: LLMs produce locally cohesive prose
//    where adjacent sentences share vocabulary at ~12-25% overlap. Human
//    writing is burstier: ~5-12%. Measured on word sets (words > 3 chars).
//
// 2. Opener repetition: LLMs reuse the same 1-2 word sentence starters
//    within a block ("The", "This", "In", "It"). Human writers vary openers.
//
// Returns 0–1 (higher = more AI-like), or null for text with < 4 sentences.
function getStylometricScore(text) {
  const safeText = text.replace(
    /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|U\.S)\./gi,
    '$1․'
  );
  const sentences = safeText
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).length >= 3);

  if (sentences.length < 4) return null;

  const wordSets = sentences.map(s =>
    new Set(s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3))
  );

  let jaccardSum = 0, jaccardCount = 0;
  for (let i = 0; i < wordSets.length - 1; i++) {
    const a = wordSets[i], b = wordSets[i + 1];
    if (a.size === 0 || b.size === 0) continue;
    const inter = [...a].filter(w => b.has(w)).length;
    jaccardSum += inter / (a.size + b.size - inter);
    jaccardCount++;
  }
  const avgJaccard = jaccardCount > 0 ? jaccardSum / jaccardCount : 0;

  const openers = sentences.map(s => s.split(/\s+/).slice(0, 2).join(' ').toLowerCase());
  const openerRepetition = 1 - (new Set(openers).size / openers.length);

  // Calibrated: LLM text scores > 0.6, human text < 0.4 in practice
  const jaccardScore = Math.min(avgJaccard / 0.20, 1.0);
  const score = jaccardScore * 0.65 + openerRepetition * 0.35;

  debugLog(`[Stylo] jaccard=${avgJaccard.toFixed(3)} openerRep=${openerRepetition.toFixed(3)} score=${score.toFixed(2)}`);
  return Math.min(score, 1.0);
}

// Parse AI confidence from a transformers.js classification result array.
// Handles models with varying label conventions: LABEL_1/Fake/AI/ChatGPT vs LABEL_0/Real/Human.
function _parseModelConf(labels) {
  if (!labels || !Array.isArray(labels) || labels.length === 0) return null;
  const AI_RE    = /^(label_1|fake|ai|machine|generated|synthetic|gpt|chatgpt|bot)$/i;
  const HUMAN_RE = /^(label_0|real|human|genuine|authentic)$/i;
  const aiEntry    = labels.find(r => AI_RE.test(r.label));
  const humanEntry = labels.find(r => HUMAN_RE.test(r.label));
  if (aiEntry)    return aiEntry.score;
  if (humanEntry) return 1 - humanEntry.score;
  return 1 - labels[0].score; // fallback: assume dominant label is the predicted class
}

// ── Full text ensemble ────────────────────────────────────────────
// Three-signal ensemble: ML Model 1 + ML Model 2 (when loaded) + heuristic.
// Stylometric score provides a fourth tie-breaker signal on longer text.
//
// Blending:
//   model 75% · heuristic 25%
//   Two-model consensus: both high → boost 10%; one vetoes (< 0.35) → cut 35%
//   Short-text gate (< 280 chars): without any corroboration (heuristic or
//     stylometric) the model alone is unreliable — cap model influence so
//     final confidence stays below the 0.60 threshold.
//   Stylometric: boosts when all signals agree; penalises model-only cases
//     where prose looks human at the structural level.
//   Agreement bonus: no penalty when heuristic + model agree (> 0.40/0.55)
//     or ensemble confidence is very high on non-short text (≥ 0.90).
// Returns { confidence: 0–1, method: string }
async function isAiSlop(text) {
  if (text.length < config.get('textMinLength')) return { confidence: 0, method: 'heuristic' };

  const key = text.slice(0, 512);
  if (classificationCache.has(key)) return classificationCache.get(key);

  const heuristicConf    = Math.max(0, Math.min(getSlopScore(text) / 16, 1.0));
  const stylometricConf  = getStylometricScore(text); // null when < 4 sentences

  if (!isModelReady || !textClassifier) {
    // Do not cache pre-model results — the same text must get ML scoring once the model loads.
    return { confidence: heuristicConf, method: 'heuristic' };
  }

  let _t1Id, _t2Id;
  const [r1, r2] = await Promise.all([
    Promise.race([
      textClassifier(text.slice(0, 512)),
      new Promise(r => { _t1Id = setTimeout(() => r(null), config.get('textM1Timeout')); }),
    ]).catch(() => null),
    (isModel2Ready && textClassifier2)
      ? Promise.race([
          textClassifier2(text.slice(0, 512)),
          new Promise(r => { _t2Id = setTimeout(() => r(null), config.get('textM2Timeout')); }),
        ]).catch(() => null)
      : Promise.resolve(null),
  ]).finally(() => { clearTimeout(_t1Id); clearTimeout(_t2Id); });

  const m1Conf = _parseModelConf(r1);
  const m2Conf = _parseModelConf(r2);

  debugLog(`[M1] ${m1Conf !== null ? Math.round(m1Conf*100)+'%' : 'fail'} [M2] ${m2Conf !== null ? Math.round(m2Conf*100)+'%' : 'n/a'} [Heur] ${Math.round(heuristicConf*100)}%${stylometricConf !== null ? ` [Stylo] ${Math.round(stylometricConf*100)}%` : ''}`);

  if (m1Conf === null) {
    const result = { confidence: heuristicConf, method: 'heuristic' };
    classificationCache.set(key, result);
    return result;
  }

  // ── Model ensemble (majority vote + consensus/veto) ───────────
  let modelConf;
  let modelMethod;
  if (m2Conf !== null) {
    const avg         = (m1Conf + m2Conf) / 2;
    const bothHigh    = m1Conf >= 0.70 && m2Conf >= 0.70;
    const oneVetoes   = m1Conf < 0.35  || m2Conf < 0.35;
    if (bothHigh)    { modelConf = Math.min(avg * 1.10, 1.0); }
    else if (oneVetoes) { modelConf = avg * 0.65; }
    else             { modelConf = avg; }
    modelMethod = 'model+model2';
  } else {
    modelConf   = m1Conf;
    modelMethod = 'model';
  }

  // ── Short-text gate ───────────────────────────────────────────
  // The text model scores 90-99% AI on casual human social media posts.
  // Require heuristic or stylometric corroboration for short text — without
  // it, cap model influence below the decision threshold.
  const isShort         = text.length < config.get('textShortLength');
  const hasCorroboration = heuristicConf > 0 || (stylometricConf !== null && stylometricConf > 0.50);
  if (isShort && !hasCorroboration) {
    // Cap model influence so blended output stays at or below the decision threshold.
    modelConf = Math.min(modelConf, config.get('textShortGateCap'));
  }

  // ── Blend ─────────────────────────────────────────────────────
  const _mw = config.get('textModelWeight');
  let confidence = heuristicConf * (1 - _mw) + modelConf * _mw;

  // ── Stylometric adjustment ────────────────────────────────────
  if (stylometricConf !== null) {
    if (stylometricConf > 0.60 && modelConf > 0.60) {
      confidence = Math.min(confidence * 1.06, 1.0); // all signals agree
    } else if (stylometricConf < 0.30 && modelConf > 0.60) {
      confidence *= 0.82; // structure looks human despite model firing
    }
  }

  // ── Agreement penalty ─────────────────────────────────────────
  const bothAgree   = heuristicConf > 0.40 && modelConf > 0.55;
  const strongEnsemble = modelConf >= 0.90 && !isShort;
  if (!bothAgree && !strongEnsemble) confidence *= 0.85;

  const method = heuristicConf > 0 ? `${modelMethod}+heuristic` : modelMethod;
  confidence = Math.min(confidence, 1.0);
  const result = { confidence, method };
  classificationCache.set(key, result);
  return result;
}

let _textModelRetryTimer = null;

async function loadModel(onStatus, _attempt = 1) {
  // Cancel any pending retry if loadModel is called again manually
  if (_textModelRetryTimer)  { clearTimeout(_textModelRetryTimer);  _textModelRetryTimer  = null; }
  if (_textModel2RetryTimer) { clearTimeout(_textModel2RetryTimer); _textModel2RetryTimer = null; }
  try {
    debugLog('Loading AI text detector...');
    onStatus('Loading AI text detector...');
    const { pipeline } = await import('@huggingface/transformers');
    textClassifier = await pipeline('text-classification', 'onnx-community/tmr-ai-text-detector-ONNX', {
      dtype: 'fp32', // only model.onnx exists in this repo — suppress dtype warning
      cache_dir: process.env.TRANSFORMERS_CACHE,
      top_k: null,   // return all labels so we can find the AI class by name
    });
    isModelReady = true;
    _textModelRetryTimer = null;
    debugLog('AI text detector ready');
    onStatus('AI text detector ready');

    textClassifier('warming up').catch(() => {});

    // Load Model 2 in background — independent vote for the ensemble.
    _loadModel2(onStatus);

    return true;
  } catch (err) {
    logError(err);
    if (_attempt < 3) {
      const delay = _attempt * 30000; // 30s, 60s
      debugLog(`Text model failed (attempt ${_attempt}) — retrying in ${delay / 1000}s`);
      onStatus(`Text model failed — retrying in ${delay / 1000}s…`);
      _textModelRetryTimer = setTimeout(() => loadModel(onStatus, _attempt + 1), delay);
    } else {
      debugLog('Text model failed after 3 attempts — using heuristic only');
      onStatus('Text model failed — using heuristic only');
    }
    return false;
  }
}

async function _loadModel2(onStatus, _attempt = 1) {
  if (isModel2Ready) return;
  if (_textModel2RetryTimer) { clearTimeout(_textModel2RetryTimer); _textModel2RetryTimer = null; }
  try {
    debugLog(`Loading ${MODEL2_LABEL}…`);
    onStatus(`Loading ${MODEL2_LABEL}…`);
    const { pipeline } = await import('@huggingface/transformers');
    textClassifier2 = await pipeline('text-classification', MODEL2_ID, {
      dtype: 'q8',
      cache_dir: process.env.TRANSFORMERS_CACHE,
      top_k: null,
    });
    isModel2Ready = true;
    debugLog(`${MODEL2_LABEL} ready`);
    onStatus(`${MODEL2_LABEL} ready`);
    textClassifier2('warming up').catch(() => {});
  } catch (err) {
    logError(err);
    if (_attempt < 3) {
      const delay = _attempt * 30000;
      debugLog(`${MODEL2_LABEL} failed (attempt ${_attempt}) — retrying in ${delay / 1000}s`);
      _textModel2RetryTimer = setTimeout(() => _loadModel2(onStatus, _attempt + 1), delay);
    } else {
      debugLog(`${MODEL2_LABEL} failed after 3 attempts — ensemble will use Model 1 only`);
      onStatus('Text Model 2 unavailable — using single model');
    }
  }
}

// ── Image model ──────────────────────────────────────────────────
// Model A: yaya36095/ai-source-detector (converted to ONNX locally)
//   - ViT-Base-Patch16-224 fine-tuned for AI art detection
//   - Labels: stable_diffusion / midjourney / dalle / real / other_ai / other_ai_2
//   - combinedScore = aiScore * (1 - realScore), threshold > 0.95
//   - ~84 MB INT8 quantized

const AI_SOURCE_MODEL_PATH = path.join(__dirname, 'models', 'ai-source-detector-onnx');

// ── Image fetching ───────────────────────────────────────────────
// Fetch image bytes once and reuse for both C2PA and ML — avoids a
// second network round-trip that the HuggingFace pipeline would make
// internally if given a URL.

const _PRIVATE_IP_RE = /^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\[?(::1|fc00:|fd)/i;

async function _fetchImageBuffer(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid image URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Non-HTTP URL blocked');
  if (_PRIVATE_IP_RE.test(parsed.hostname) || parsed.hostname === 'localhost') throw new Error('Private IP blocked');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.get('imageFetchTimeout'));
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// ── C2PA manifest check ──────────────────────────────────────────
// Content Credentials / C2PA embeds cryptographically signed provenance
// metadata directly in the image file. Major AI platforms that embed it:
//   - DALL-E 3 (via ChatGPT / Bing Image Creator) — contains 'openai'
//   - Adobe Firefly — contains 'Adobe Firefly'
//   - Google Imagen 3 — contains 'Imagen 3'
//   - Microsoft Designer / Copilot — contains 'Microsoft'
//
// Detection strategy: scan the raw bytes for the JUMBF namespace marker
// ('c2pa') which appears as ASCII in every C2PA manifest's description
// box, then look for either the explicit AI-generation assertion label
// ('c2pa.ai.generated') or a known AI generator identifier in the claim.
//
// Limitations:
//   - Social media platforms (Reddit, Twitter, Discord) re-encode images
//     on upload, stripping the manifest entirely. Coverage ≈ 1–5% of
//     AI images in the wild, but when it fires it is zero-false-positive.
//   - Midjourney and most SD pipelines do not embed C2PA at all.
//   - PNG/WebP store JUMBF in different structures than JPEG APP11 but
//     the label scan works across formats since labels are always ASCII.

// ── AI image URL patterns ─────────────────────────────────────────
// Checked before fetching the image — zero cost, high confidence.
// Returns a score (0–1) on first match, or null if no match.

const AI_IMAGE_URL_PATTERNS = [
  { re: /oaidalleapiprodscus\.blob\.core\.windows\.net/i, score: 1.0 },
  { re: /cdn\.openai\.com/i,                              score: 1.0 },
  { re: /cdn\.midjourney\.com/i,                          score: 1.0 },
  { re: /cdn\.discordapp\.com.*?midjourney/i,             score: 0.98 },
  { re: /cdn\.leonardo\.ai/i,                             score: 1.0 },
  { re: /cdn\.runwayml\.com|assets\.runwayml\.com/i,      score: 1.0 },
  { re: /\bpika\.art\b/i,                                 score: 1.0 },
  { re: /\bklingai\.com\b|\bkling\.ai\b/i,                score: 1.0 },
  { re: /\bhailuoai\.com\b|\bminimaxi\.com\b/i,           score: 0.98 },
  { re: /imagefx\.google\.com/i,                          score: 1.0 },
  { re: /aisandbox-pa\.googleapis\.com/i,                 score: 1.0 },
  { re: /\bblackforestlabs\.ai\b/i,                       score: 1.0 },
  { re: /grok\.com\/(?:images|g\/gen)/i,                  score: 1.0 },
  { re: /firefly\.adobe\.com/i,                           score: 0.98 },
  { re: /ideogram\.ai/i,                                  score: 0.98 },
  { re: /cdn\.stability\.ai/i,                            score: 0.98 },
  { re: /app\.sora\.com/i,                                score: 0.98 },
  { re: /bing\.com\/images\/create/i,                     score: 0.98 },
  { re: /designer\.microsoft\.com/i,                      score: 0.98 },
  { re: /images\.nightcafe\.studio/i,                     score: 0.98 },
  { re: /image\.cdn2?\.seaart\.ai/i,                      score: 0.98 },
  { re: /\bviggle\.ai\b/i,                                score: 0.97 },
  { re: /playground\.com\/images\//i,                     score: 0.95 },
  { re: /\btensor\.art\b/i,                               score: 0.95 },
  { re: /getimg\.ai/i,                                    score: 0.95 },
  { re: /civitai\.com/i,                                  score: 0.90 },
];

function _checkAiUrl(url) {
  for (const { re, score } of AI_IMAGE_URL_PATTERNS) {
    if (re.test(url)) return score;
  }
  return null;
}

// ── PNG tEXt/iTXt chunk AI signatures ────────────────────────────
// AUTOMATIC1111, ComfyUI, NovelAI, InvokeAI, and Fooocus embed generation
// parameters directly into PNG tEXt chunks as ASCII. These strings are
// visible in the raw buffer and survive until the image is re-encoded.

const _PNG_AI_PATTERNS = [
  Buffer.from('Negative prompt:'),          // AUTOMATIC1111 / WebUI / Forge
  Buffer.from('CFG scale:'),                // AUTOMATIC1111 SD parameters
  Buffer.from('Model hash:'),               // AUTOMATIC1111 model reference
  Buffer.from('KSampler'),                  // ComfyUI sampler node
  Buffer.from('CheckpointLoaderSimple'),    // ComfyUI checkpoint node
  Buffer.from('FluxGuidance'),              // ComfyUI Flux guidance node
  Buffer.from('"software":"NovelAI"'),      // NovelAI Comment chunk
  Buffer.from('invokeai_metadata'),         // InvokeAI iTXt chunk
  Buffer.from('fooocus_version'),           // Fooocus metadata
  Buffer.from('trainedAlgorithmicMedia'),   // IPTC AI-generated declaration
  Buffer.from('SynthID'),                   // Google SynthID watermark declaration
];

const _PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

// Returns 'ai_generated' | null
function _checkPNGChunks(buf) {
  if (!buf.slice(0, 4).equals(_PNG_SIG)) return null;
  for (const pattern of _PNG_AI_PATTERNS) {
    if (buf.includes(pattern)) return 'ai_generated';
  }
  return null;
}

// ── C2PA manifest check ──────────────────────────────────────────
// Content Credentials / C2PA embeds cryptographically signed provenance
// metadata directly in the image file. Major AI platforms that embed it:
//   - DALL-E 3 (via ChatGPT / Bing Image Creator) — contains 'openai'
//   - Adobe Firefly — contains 'Adobe Firefly'
//   - Google Imagen 3 — contains 'Imagen 3'
//   - Microsoft Designer / Copilot — contains 'Microsoft'
//
// Detection strategy: scan the raw bytes for the JUMBF namespace marker
// ('c2pa') which appears as ASCII in every C2PA manifest's description
// box, then look for either the explicit AI-generation assertion label
// ('c2pa.ai.generated') or a known AI generator identifier in the claim.
//
// Limitations:
//   - Social media platforms (Reddit, Twitter, Discord) re-encode images
//     on upload, stripping the manifest entirely. Coverage ≈ 1–5% of
//     AI images in the wild, but when it fires it is zero-false-positive.
//   - Midjourney and most SD pipelines do not embed C2PA at all.
//   - PNG/WebP store JUMBF in different structures than JPEG APP11 but
//     the label scan works across formats since labels are always ASCII.

const _C2PA_NS     = Buffer.from('c2pa');
const _C2PA_AI_GEN = Buffer.from('c2pa.ai.generated');
const _C2PA_GENS   = [
  Buffer.from('Adobe Firefly'),
  Buffer.from('openai'),
  Buffer.from('Imagen 3'),
  Buffer.from('Microsoft Designer'),
];

// Returns 'ai_generated' | 'signed_not_ai' | null (no manifest).
function _checkC2PA(buf) {
  if (!buf.includes(_C2PA_NS)) return null;
  if (buf.includes(_C2PA_AI_GEN)) return 'ai_generated';
  for (const gen of _C2PA_GENS) {
    if (buf.includes(gen)) return 'ai_generated';
  }
  return 'signed_not_ai';
}

// ── Image model ──────────────────────────────────────────────────

let _imageModelRetryTimer = null;

async function loadImageModel(onStatus, onProgress, _attempt = 1) {
  if (_isImageModelReady) return true;
  if (_imageModelRetryTimer) { clearTimeout(_imageModelRetryTimer); _imageModelRetryTimer = null; }

  const _TOTAL = 2 + (MODEL_D_ID ? 1 : 0) + 1; // A + B + C [+ D]

  try {
    debugLog(`Loading ${MODEL_A_LABEL} (~84 MB)…`);
    onStatus(`Loading image detection ensemble (1/${_TOTAL}) — ${MODEL_A_LABEL}…`);
    // Signal loading has started so the UI can show the progress bar immediately
    onProgress?.({ loaded: 0, total: _TOTAL, label: MODEL_A_LABEL, ok: null, done: false });

    const { pipeline } = await import('@huggingface/transformers');
    imageClassifier = await pipeline(
      'image-classification',
      AI_SOURCE_MODEL_PATH,
      {
        dtype: 'q8',   // loads model_quantized.onnx
        top_k: null,   // return all labels so we can find 'real'
      }
    );
    _isImageModelReady = true;
    debugLog(`${MODEL_A_LABEL} ready`);
    onProgress?.({ loaded: 1, total: _TOTAL, label: MODEL_A_LABEL, ok: true, done: false });

    // Load Models B, C, and D in background — track completion for the done event
    let _bgDone = 0;
    const _bgTotal = _TOTAL - 1;
    const _onBgComplete = (label, ok) => {
      _bgDone++;
      onProgress?.({ loaded: 1 + _bgDone, total: _TOTAL, label, ok, done: _bgDone === _bgTotal });
    };

    _loadModelB(onStatus, _onBgComplete);
    _loadModelC(onStatus, _onBgComplete);
    if (MODEL_D_ID) _loadModelD(onStatus, _onBgComplete);

    return true;
  } catch (err) {
    logError(err);
    if (_attempt < 3) {
      const delay = _attempt * 30000;
      debugLog(`Image model failed (attempt ${_attempt}) — retrying in ${delay / 1000}s`);
      onStatus(`Image model failed — retrying in ${delay / 1000}s…`);
      _imageModelRetryTimer = setTimeout(() => loadImageModel(onStatus, onProgress, _attempt + 1), delay);
    } else {
      debugLog('Image model failed after 3 attempts — image detection unavailable');
      onStatus('Image model failed — image detection unavailable');
    }
    return false;
  }
}

async function _loadModelB(onStatus, onDone, _attempt = 1) {
  if (_isModelBReady) { onDone?.(MODEL_B_LABEL, true); return; }
  if (_modelBRetryTimer) { clearTimeout(_modelBRetryTimer); _modelBRetryTimer = null; }
  try {
    debugLog(`Loading ${MODEL_B_LABEL} (~52 MB)…`);
    if (onStatus) onStatus(`Loading ${MODEL_B_LABEL} (~52 MB)…`);
    const { pipeline } = await import('@huggingface/transformers');
    modelBClassifier = await pipeline(
      'image-classification',
      MODEL_B_ID,
      { dtype: 'q4f16', top_k: null, cache_dir: process.env.TRANSFORMERS_CACHE }
    );
    const modelDir = path.join(process.env.TRANSFORMERS_CACHE || '', MODEL_B_ID.replace('/', path.sep), 'onnx');
    await _verifyAndLogModelFiles(modelDir, MODEL_B_ID);
    _isModelBReady = true;
    debugLog(`${MODEL_B_LABEL} ready`);
    onDone?.(MODEL_B_LABEL, true);
  } catch (err) {
    logError(err);
    if (_attempt < 3) {
      const delay = _attempt * 30000;
      debugLog(`${MODEL_B_LABEL} failed (attempt ${_attempt}) — retrying in ${delay / 1000}s`);
      if (_attempt === 1) onDone?.(MODEL_B_LABEL, false); // release progress bar; retry is silent
      _modelBRetryTimer = setTimeout(() => _loadModelB(onStatus, null, _attempt + 1), delay);
    } else {
      debugLog(`${MODEL_B_LABEL} failed after 3 attempts`);
      if (_attempt === 1) onDone?.(MODEL_B_LABEL, false);
    }
  }
}

async function _loadModelC(onStatus, onDone, _attempt = 1) {
  if (_isModelCReady) { onDone?.(MODEL_C_LABEL, true); return; }
  if (_modelCRetryTimer) { clearTimeout(_modelCRetryTimer); _modelCRetryTimer = null; }
  try {
    debugLog(`Loading ${MODEL_C_LABEL} (~87 MB)…`);
    if (onStatus) onStatus(`Loading ${MODEL_C_LABEL} (~87 MB)…`);
    const { pipeline } = await import('@huggingface/transformers');
    modelCClassifier = await pipeline(
      'image-classification',
      MODEL_C_ID,
      { dtype: 'q8', top_k: null, cache_dir: process.env.TRANSFORMERS_CACHE }
    );
    const modelDir = path.join(process.env.TRANSFORMERS_CACHE || '', MODEL_C_ID.replace('/', path.sep), 'onnx');
    await _verifyAndLogModelFiles(modelDir, MODEL_C_ID);
    _isModelCReady = true;
    debugLog(`${MODEL_C_LABEL} ready`);
    onDone?.(MODEL_C_LABEL, true);
  } catch (err) {
    logError(err);
    if (_attempt < 3) {
      const delay = _attempt * 30000;
      debugLog(`${MODEL_C_LABEL} failed (attempt ${_attempt}) — retrying in ${delay / 1000}s`);
      if (_attempt === 1) onDone?.(MODEL_C_LABEL, false);
      _modelCRetryTimer = setTimeout(() => _loadModelC(onStatus, null, _attempt + 1), delay);
    } else {
      debugLog(`${MODEL_C_LABEL} failed after 3 attempts — ensemble will use A+B only`);
      if (_attempt === 1) onDone?.(MODEL_C_LABEL, false);
    }
  }
}

async function _loadModelD(onStatus, onDone) {
  if (_isModelDReady || !MODEL_D_ID) return; // disabled when no model is configured
  try {
    debugLog(`Loading ${MODEL_D_LABEL} (~88 MB)…`);
    if (onStatus) onStatus(`Loading ${MODEL_D_LABEL} (~88 MB)…`);
    const { pipeline } = await import('@huggingface/transformers');
    modelDClassifier = await pipeline(
      'image-classification',
      MODEL_D_ID,
      { dtype: 'q8', top_k: null, cache_dir: process.env.TRANSFORMERS_CACHE }
    );
    _isModelDReady = true;
    debugLog(`${MODEL_D_LABEL} ready`);
    onDone?.(MODEL_D_LABEL, true);
  } catch (err) {
    logError(err);
    debugLog(`${MODEL_D_LABEL} failed`);
    onDone?.(MODEL_D_LABEL, false);
  }
}

// ── Single shared image decode ────────────────────────────────────
// Decodes the image buffer ONCE to a 256×256 (max) raw pixel grid.
// All heuristic passes (screenshot, style, Laplacian) operate on this
// shared pixel array — eliminating 5 redundant sharp pipeline invocations
// that would otherwise each re-decode the full compressed buffer.
//
// Returns { w, h, px, ch, W, H } or null on error:
//   w, h  — original image dimensions
//   px    — Uint8Array of W×H×ch raw pixels (RGB or RGBA)
//   ch    — channels per pixel (3 or 4)
//   W, H  — actual decoded dimensions (≤ 256)
async function _decodeShared(buf) {
  if (!buf) return null;
  try {
    // One metadata call for original dimensions + EXIF (cheap, header-only read).
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (w < 100 || h < 100) return null;

    // Single decode to 256×256 max — enough resolution for all heuristics.
    // toColourspace('srgb') ensures grayscale/CMYK inputs become 3-channel RGB
    // before removeAlpha() strips transparency, guaranteeing ch=3 for RawImage.
    const { data, info } = await sharp(buf)
      .resize(256, 256, { fit: 'inside', withoutEnlargement: false })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return { w, h, px: data, ch: info.channels, W: info.width, H: info.height, meta };
  } catch (_) {
    return null;
  }
}

// Detect screenshot/UI capture from shared decoded pixels + original dimensions.
function _isScreenshotFromShared(shared) {
  if (!shared) return false;
  const { w, h, px, ch, W, H } = shared;

  // ── 1. Aspect ratio — landscape/ultra-wide desktop + tall mobile only ─
  // Portrait AI art ratios (9:16, 3:4, 2:3) intentionally excluded.
  const ar = w / h;
  const SCREEN_ARS = [16/9, 16/10, 4/3, 21/9, 9/19.5, 9/20, 9/21];
  const arMatch = SCREEN_ARS.some(r => Math.abs(ar - r) < 0.04);

  // ── 2. Colour entropy across 3 row samples ────────────────────────
  // Sample rows at 15%, 47%, 80% of decoded height.
  const rowFracs = [0.15, 0.47, 0.80];
  let totalEntropy = 0;
  for (const frac of rowFracs) {
    const rowY = Math.floor(H * frac);
    const colors = new Set();
    for (let x = 0; x < W; x++) {
      const i = (rowY * W + x) * ch;
      colors.add((px[i] >> 3) * 1024 + (px[i+1] >> 3) * 32 + (px[i+2] >> 3));
    }
    totalEntropy += colors.size / W;
  }
  const colorEntropy = totalEntropy / rowFracs.length;

  if (arMatch && colorEntropy < 0.07) return true;
  if (colorEntropy < 0.03)            return true;
  return false;
}

// Style detection from shared pixels — no separate sharp call.
function _detectStyleFromShared(shared) {
  if (!shared) return 'unknown';
  const { px, ch, W, H } = shared;

  let totalSat = 0;
  const satValues = [];
  const count = W * H;

  for (let i = 0; i < px.length; i += ch) {
    const r = px[i] / 255, g = px[i+1] / 255, b = px[i+2] / 255;
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    const sat = max > 0 ? delta / max : 0;
    totalSat += sat;
    satValues.push(sat);
  }

  if (count === 0) return 'unknown';
  const avgSat = totalSat / count;
  const satVariance = satValues.reduce((a, s) => a + (s - avgSat) ** 2, 0) / count;

  debugLog(`[StyleRouter] avgSat=${avgSat.toFixed(3)} satVariance=${satVariance.toFixed(3)}`);
  if (avgSat > 0.38 && satVariance > 0.06) return 'anime';
  // satVariance relaxed from 0.05 → 0.08: real portraits contain mixed tones
  // (skin, hair, background) that push variance above 0.05 without being "anime".
  if (avgSat < 0.28 && satVariance < 0.08) return 'photo';
  return 'unknown';
}

// Laplacian variance computed directly from shared pixels — no separate sharp call.
// Operates on the 256×256 decoded grid (vs the old 512×512), 4× fewer pixels
// with equivalent discriminative power at this scale.
function _laplacianFromShared(shared) {
  if (!shared) return 0.5;
  const { px, ch, W, H } = shared;

  // Convert to greyscale in-place (BT.601 coefficients)
  const grey = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * ch;
    grey[i] = px[o] * 0.299 + px[o+1] * 0.587 + px[o+2] * 0.114;
  }

  // 4-neighbour Laplacian kernel: centre×4 − NSEW
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      const lap = 4 * grey[idx] - grey[idx - 1] - grey[idx + 1]
                                 - grey[idx - W] - grey[idx + W];
      sum  += lap;
      sum2 += lap * lap;
      n++;
    }
  }
  const mean     = sum / n;
  const variance = sum2 / n - mean * mean;
  // Not used in the forensic blend (modern AI art has same variance as real photos)
  // but kept for debug visibility.
  debugLog(`[Laplacian] variance=${Math.round(variance)} (informational only)`);
  return Math.min(variance / 500, 1.0);
}

// Old _isScreenshot / _computeLaplacianVariance removed.
// Replaced by _isScreenshotFromShared / _laplacianFromShared above,
// which operate on the single shared _decodeShared() pixel grid.

// EXIF metadata forensics — uses already-parsed sharp metadata from _decodeShared.
// Returns { signal: 1.0 (human) | 0.05 (AI) | 0.5 (ambiguous), hasCamera: bool }
function _getExifSignal(metadata) {
  if (!metadata) return { signal: 0.5, hasCamera: false };
  try {
    if (!metadata.exif || metadata.exif.length < 8) return { signal: 0.5, hasCamera: false };

    // Search the raw EXIF buffer as ASCII — embedded strings (Software, Make,
    // Model, Artist) are always ASCII-encoded in the TIFF IFD structure, so
    // they appear as readable substrings even in the binary buffer.
    const exifAscii = metadata.exif.toString('ascii');

    const AI_TAGS = [
      // Stable Diffusion ecosystem
      'Stable Diffusion', 'StableDiffusion', 'stable-diffusion-webui', 'AUTOMATIC1111', 'Automatic1111',
      'ComfyUI', 'InvokeAI', 'Fooocus', 'NovelAI', 'sd-webui', 'Forge',
      // Major platforms
      'DALL-E', 'Midjourney', 'Adobe Firefly', 'Firefly generated',
      'Imagen', 'ImageFX', 'Ideogram', 'Leonardo.Ai', 'NightCafe',
      // Newer generators
      'Flux', 'FLUX.1', 'flux.1', 'black-forest-labs',
      'RunwayML', 'Runway Gen', 'Pika Labs',
      'Kling', 'Kling AI', 'Hailuo',
      'Microsoft Designer', 'Microsoft Copilot',
      'Sora',
      // Watermark / provenance declarations
      'SynthID', 'trainedAlgorithmicMedia',
    ];

    const HUMAN_TAGS = [
      'Adobe Photoshop', 'Adobe Lightroom', 'Capture One', 'Darktable',
      'RawTherapee', 'GIMP', 'Krita', 'Procreate', 'Clip Studio Paint',
      'Paint Tool SAI', 'Affinity Photo', 'Affinity Designer', 'Pixelmator',
      'iPhone', 'NIKON', 'Canon', 'SONY', 'FUJIFILM', 'Olympus',
      'Panasonic', 'Leica', 'Hasselblad', 'Phase One', 'Snapseed',
      'Samsung', 'Xiaomi', 'Huawei', 'OnePlus', 'Google Pixel',
    ];

    // Camera make/model present in EXIF Make or Model fields — phones and
    // DSLRs always embed these; AI generators never do.
    const CAMERA_MAKERS = [
      'NIKON', 'Canon', 'SONY', 'FUJIFILM', 'Olympus', 'Panasonic',
      'Leica', 'Hasselblad', 'Phase One', 'Apple', 'Samsung', 'Xiaomi',
      'Huawei', 'OnePlus', 'Google', 'LGE', 'Motorola', 'RICOH', 'Pentax',
    ];
    const hasCamera = CAMERA_MAKERS.some(m => exifAscii.includes(m));

    // GPS data in EXIF is an extraordinarily strong "real photo" signal.
    // Real phone photos almost always have GPS; AI generators never do.
    // The GPS IFD marker (0x8825) appears as binary but the 'GPS' ASCII label
    // in the XMP sidecar or the string 'GPSLatitude' appears in verbose EXIF.
    // GPS IFD pointer tag is 0x8825 — check for the two-byte sequence in both TIFF endiannesses.
    // Do NOT use Buffer.includes(number): that tests for a single byte value (0x88 and 0x25 are
    // common in any binary data), giving a near-permanent true regardless of actual GPS presence.
    const gpsByteSeq = metadata.exif.indexOf(Buffer.from([0x88, 0x25])) !== -1
                    || metadata.exif.indexOf(Buffer.from([0x25, 0x88])) !== -1;
    const hasGps = exifAscii.includes('GPS') || gpsByteSeq;

    for (const tag of AI_TAGS) {
      if (exifAscii.includes(tag)) {
        debugLog(`[EXIF] AI signature: "${tag}"`);
        return { signal: 0.05, hasCamera: false };
      }
    }
    for (const tag of HUMAN_TAGS) {
      if (exifAscii.includes(tag)) {
        debugLog(`[EXIF] Human tool: "${tag}" hasCamera=${hasCamera} hasGps=${hasGps}`);
        return { signal: hasGps ? 1.0 : 0.90, hasCamera };
      }
    }

    // No tool tag but camera maker/GPS detected
    if (hasCamera || hasGps) {
      debugLog(`[EXIF] Camera/GPS detected — hasCamera=${hasCamera} hasGps=${hasGps}`);
      return { signal: hasGps ? 1.0 : 0.90, hasCamera };
    }

    return { signal: 0.5, hasCamera: false }; // EXIF present but no recognized tool
  } catch (_) {
    return { signal: 0.5, hasCamera: false };
  }
}

// Returns { score: 0–1, style: 'photo'|'anime'|'unknown' }
// Callers apply the appropriate threshold:
//   photo   → 0.70
//   anime / unknown → 0.75  (harder threshold for stylised content)
async function isAiImage(imageUrl) {
  if (!_isImageModelReady) return { score: 0, style: 'unknown' };
  return new Promise((resolve, reject) => {
    IMAGE_QUEUE.push({ imageUrl, resolve, reject });
    _drainImageQueue();
  });
}

function _drainImageQueue() {
  if (activeImageJobs >= MAX_IMG_CONCURRENT || IMAGE_QUEUE.length === 0) return;
  const { imageUrl, resolve, reject } = IMAGE_QUEUE.shift();
  activeImageJobs++;
  _runImageClassify(imageUrl)
    .then(resolve)
    .catch(reject)
    .finally(() => { activeImageJobs--; _drainImageQueue(); });
}

const KNOWN_AI_LABELS = new Set(['stable_diffusion', 'midjourney', 'dalle', 'other_ai']);

// Image classification cache
const imageClassificationCache = new LRUCache(100);

async function _runImageClassify(imageUrl) {
  // Strip query string for cache key — CDN signed URLs rotate signatures but
  // point to the same image content.
  let cacheKey = imageUrl;
  try { const u = new URL(imageUrl); u.search = ''; cacheKey = u.toString(); } catch (_) {}
  if (imageClassificationCache.has(cacheKey)) {
    return imageClassificationCache.get(cacheKey);
  }

  // ── Pass 0: URL pattern check (zero-latency, zero-network) ───────
  const urlScore = _checkAiUrl(imageUrl);
  if (urlScore !== null) {
    debugLog(`[URL] AI source domain confirmed — ${imageUrl.slice(0, 80)}`);
    const result = { score: urlScore, style: 'unknown' };
    imageClassificationCache.set(cacheKey, result);
    return result;
  }

  try {
    // ── Fetch once ────────────────────────────────────────────────
    const buf = await _fetchImageBuffer(imageUrl).catch(() => null);

    // ── Pass 1: C2PA manifest ─────────────────────────────────────
    if (buf) {
      const c2pa = _checkC2PA(buf);
      if (c2pa === 'ai_generated') {
        debugLog(`C2PA: AI-generation manifest confirmed — ${imageUrl.slice(0, 80)}`);
        const result = { score: 1.0, style: 'unknown' };
        imageClassificationCache.set(cacheKey, result);
        return result;
      }
    }

    // ── Pass 1b: PNG tEXt/iTXt chunk AI signatures ────────────────
    if (buf) {
      const pngChunk = _checkPNGChunks(buf);
      if (pngChunk === 'ai_generated') {
        debugLog(`PNG chunks: AI generator parameters found — ${imageUrl.slice(0, 80)}`);
        const result = { score: 0.99, style: 'unknown' };
        imageClassificationCache.set(cacheKey, result);
        return result;
      }
    }

    // ── Shared decode (one sharp call for all heuristics) ─────────
    // Decodes to 256×256 max RGB; all pixel-based checks run on this grid.
    const shared = await _decodeShared(buf);

    // If we fetched the buffer but couldn't decode it, the image is too small,
    // corrupt, or otherwise unsuitable (icon, tracking pixel, thumbnail). Skip ML.
    if (buf && !shared) {
      const result = { score: 0, style: 'unknown' };
      imageClassificationCache.set(cacheKey, result);
      return result;
    }

    // ── Stage 1: Screenshot router ────────────────────────────────
    if (_isScreenshotFromShared(shared)) {
      debugLog(`[Router] Screenshot detected — skipping ML — ${imageUrl.slice(0, 60)}`);
      const result = { score: 0, style: 'screenshot' };
      imageClassificationCache.set(cacheKey, result);
      return result;
    }

    // ── Stage 2: Forensic signals from shared pixels ──────────────
    const exifResult = _getExifSignal(shared?.meta);
    const exifSignal = exifResult.signal;
    const hasCamera  = exifResult.hasCamera;
    const lapScore   = _laplacianFromShared(shared);
    debugLog(`[Forensic] EXIF=${Math.round(exifSignal*100)}% Lap=${Math.round(lapScore*100)}% camera=${hasCamera}`);

    // Hard veto: camera EXIF + high natural noise = real photo, skip ML
    if (hasCamera && lapScore > 0.60) {
      debugLog(`[Veto] Camera EXIF + high Lap → definitely real — ${imageUrl.slice(0, 60)}`);
      const result = { score: 0.05, style: 'photo' };
      imageClassificationCache.set(cacheKey, result);
      return result;
    }

    // ── Stage 3: Style detection from shared pixels ───────────────
    const style = _detectStyleFromShared(shared);
    debugLog(`[Style] ${style} — ${imageUrl.slice(0, 60)}`);

    // ── Stage 4: ML detectors ────────────────────────────────────
    // Build a RawImage from the already-decoded shared pixels — no HTTP
    // re-fetch, no JPEG re-encode, no data URL. The pipeline's internal
    // ImageProcessor handles resizing to the model's expected input size.
    // Fallback to the original URL if shared decode failed.
    let modelInput = imageUrl;
    if (shared) {
      try {
        const { RawImage } = await import('@huggingface/transformers');
        // shared.px is a 3-channel (RGB) Buffer after removeAlpha()
        modelInput = new RawImage(new Uint8ClampedArray(shared.px), shared.W, shared.H, 3);
      } catch (_) { /* keep URL fallback */ }
    }

    let _mlTimeoutId;
    const mlTimeout = new Promise((_, r) => { _mlTimeoutId = setTimeout(() => r(new Error('timeout')), config.get('imageInferenceTimeout')); });
    const useModelD = _isModelDReady && modelDClassifier && style !== 'photo';

    const [mlResult, bResult, cResult, dResult] = await Promise.all([
      Promise.race([imageClassifier(modelInput), mlTimeout])
        .catch(err => { debugLog(`[A] inference error: ${err?.message?.slice(0, 80)}`); return null; }),
      (_isModelBReady && modelBClassifier)
        ? Promise.race([modelBClassifier(modelInput), mlTimeout])
            .catch(err => { debugLog(`[B] inference error: ${err?.message?.slice(0, 80)}`); return null; })
        : Promise.resolve(null),
      (_isModelCReady && modelCClassifier)
        ? Promise.race([modelCClassifier(modelInput), mlTimeout])
            .catch(err => { debugLog(`[C] inference error: ${err?.message?.slice(0, 80)}`); return null; })
        : Promise.resolve(null),
      useModelD
        ? Promise.race([modelDClassifier(modelInput), mlTimeout])
            .catch(err => { debugLog(`[D] inference error: ${err?.message?.slice(0, 80)}`); return null; })
        : Promise.resolve(null),
    ]).finally(() => clearTimeout(_mlTimeoutId));

    // ── Stage 5: Per-model scores ──────────────────────────────────
    // aScore: Model A (multi-label photorealism detector)
    let aScore = 0;
    if (mlResult) {
      const scores    = Object.fromEntries(mlResult.map(r => [r.label, r.score]));
      const aiScore   = mlResult.reduce((sum, r) => KNOWN_AI_LABELS.has(r.label) ? sum + r.score : sum, 0);
      const realScore = scores['real'] ?? 0;
      const o2Score   = scores['other_ai_2'] ?? 0;
      debugLog(
        `[A] SD:${Math.round((scores['stable_diffusion']??0)*100)}% ` +
        `MJ:${Math.round((scores['midjourney']??0)*100)}% ` +
        `DE:${Math.round((scores['dalle']??0)*100)}% ` +
        `OA:${Math.round((scores['other_ai']??0)*100)}% ` +
        `O2:${Math.round(o2Score*100)}%(excl) ` +
        `RL:${Math.round(realScore*100)}%`
      );
      if (o2Score <= aiScore) {
        aScore = aiScore * (1 - realScore);
      }
      debugLog(`[A] score=${Math.round(aScore*100)}%`);
    }

    // bScore: Model B (Swin-T binary, strong on SDXL/Flux)
    let bScore = 0;
    if (bResult) {
      const aiEntry = bResult.find(r => /ai|artificial|generated|fake/i.test(r.label));
      bScore = aiEntry?.score ?? 0;
      debugLog(`[B] score=${Math.round(bScore*100)}% (${aiEntry?.label ?? '?'})`);
    }

    // cScore: Model C (ViT-Large, art/deepfake)
    let cScore = 0;
    if (cResult) {
      const aiEntry = cResult.find(r => /ai|artificial|generated|fake/i.test(r.label));
      cScore = aiEntry?.score ?? 0;
      debugLog(`[C] score=${Math.round(cScore*100)}% (${aiEntry?.label ?? '?'})`);
    }

    // dScore: Model D (anime/illustration specialist — only for non-photo style)
    let dScore = 0;
    if (dResult) {
      const aiEntry = dResult.find(r => /ai|artificial|generated|fake/i.test(r.label));
      dScore = aiEntry?.score ?? 0;
      debugLog(`[D] score=${Math.round(dScore*100)}% (${aiEntry?.label ?? '?'})`);
    }

    // ── Stage 6: Weighted ensemble with consensus/veto ────────────
    //
    // Model A (ai-source-detector) is photorealism-biased — trained on SD/MJ/DALL-E
    // photorealistic outputs. It systematically under-scores anime and stylised AI
    // art (0.20–0.35 typical), dragging the ensemble below threshold.
    // For anime/unknown style, drop Model A and use B+C only.
    // For photo style, keep A+B+C — Model A performs best on photorealism.

    let allScores;
    const isPhotoStyle = style === 'photo';

    let animeBBlind = false;
    if (style === 'anime' || (style === 'unknown' && !mlResult)) {
      // Anime / unknown-without-A path: B + C (+ D if available)
      //
      // B-blind mode: Model B (Swin-T SDXL/Flux detector) was trained on photorealistic
      // diffusion outputs and scores 0% on anime/illustration AI art. When B < 0.15 for
      // the anime path and no D model is available, drop B and promote C as the sole
      // signal — a C score ≥ 0.75 reliably indicates AI-generated anime/illustration.
      if (style === 'anime' && !dResult && bResult && bScore < 0.15 && cResult) {
        animeBBlind = true;
        allScores = [cScore];
        debugLog(`[Ensemble] C-primary (B blind ${Math.round(bScore*100)}% for anime): C=${Math.round(cScore*100)}%`);
      } else {
        allScores = [
          dResult ? dScore : null,
          bResult ? bScore : null,
          cResult ? cScore : null,
        ].filter(s => s !== null);
        debugLog(`[Ensemble] B+C path (A excluded for style=${style}): B=${Math.round(bScore*100)}% C=${Math.round(cScore*100)}%`);
      }
    } else if (dResult) {
      allScores = [bScore, cScore, dScore].filter(s => s !== null);
      debugLog(`[Ensemble] B+C+D path: B=${Math.round(bScore*100)}% C=${Math.round(cScore*100)}% D=${Math.round(dScore*100)}%`);
    } else if (isPhotoStyle) {
      // Photo path: B + C only. Model A (ai-source-detector) is excluded because
      // it is calibrated on SD/MJ/DALL-E datasets that heavily feature professional
      // portrait-style images, causing it to fire 95-100% on real portrait photography
      // (clean backgrounds, studio lighting, press-style framing). B and C are better
      // calibrated for the real vs AI binary on photographic content.
      allScores = [
        bResult ? bScore : null,
        cResult ? cScore : null,
      ].filter(s => s !== null);
      if (mlResult) debugLog(`[Ensemble] A=${Math.round(aScore*100)}% excluded for photo — B+C path: B=${Math.round(bScore*100)}% C=${Math.round(cScore*100)}%`);
    } else {
      // Standard path: A + B + C
      allScores = [
        mlResult ? aScore : null,
        bResult  ? bScore : null,
        cResult  ? cScore : null,
      ].filter(s => s !== null);
    }

    const availableModels = allScores.length;
    let score;
    const weighted = availableModels > 0
      ? allScores.reduce((a, b) => a + b, 0) / availableModels
      : 0;

    if (availableModels >= 2) {
      // Photo style uses tighter thresholds throughout — portrait photography
      // produces high B scores (professional composition mimics AI headshots) and
      // moderate C scores, so we require stronger model agreement before flagging.
      const agreeFloor     = isPhotoStyle ? 0.65 : 0.35;
      const highConfBar    = isPhotoStyle ? 0.82 : 0.70;
      // Photo consensusMult 0.84: B=100%+C≤77% (real portrait ceiling) → 88.5%×0.84=74.3% (pass)
      //                           B=100%+C≥79% (AI portrait floor)     → 89.5%×0.84=75.2% (flag)
      const consensusMult  = isPhotoStyle ? 0.84 : 1.00;
      const partialMult    = isPhotoStyle ? 0.68 : 0.80;

      // allAgreeAi: every model leans AI above agreeFloor.
      const allAgreeAi  = allScores.every(s => s > agreeFloor);

      // twoHighConf: ≥2 models are confidently AI (≥highConfBar). Triggers boost.
      const twoHighConf = allScores.filter(s => s >= highConfBar).length >= 2;

      // hardVetoReal: majority strongly say "real" (< 0.25 for AI).
      const hardVetoReal = allScores.filter(s => s < 0.25).length >= Math.ceil(availableModels / 2);

      // strongDissent: one model is firmly "real" (< 0.30). Suppresses the
      // twoHighConf boost even when two others agree — guards against group portraits
      // and complex scenes where style=unknown routes A+C to a boost while B vetoes.
      const strongDissent = allScores.some(s => s < 0.30);

      if (hardVetoReal) {
        score = weighted * 0.25;
        debugLog(`[Ensemble] Hard veto (majority real): ${Math.round(weighted*100)}% → ${Math.round(score*100)}%`);
      } else if (twoHighConf && !strongDissent) {
        score = Math.min(weighted * 1.10, 1.0);
        debugLog(`[Ensemble] High-conf boost: ${Math.round(weighted*100)}% → ${Math.round(score*100)}%`);
      } else if (allAgreeAi) {
        score = weighted * consensusMult;
        debugLog(`[Ensemble] Consensus: ${Math.round(weighted*100)}% → ${Math.round(score*100)}%`);
      } else {
        score = weighted * partialMult;
        debugLog(`[Ensemble] Partial: ${Math.round(weighted*100)}% → ${Math.round(score*100)}%`);
      }
    } else if (availableModels === 1) {
      // animeBBlind: B is trained on SDXL/Flux and blind to anime AI — C is the only
      // reliable signal. Use 0.95 so C=82% → 77.9% clears the 0.75 threshold.
      // Standard single-model: 0.75 to require higher C confidence before flagging.
      const singleMult = animeBBlind ? 0.95 : 0.75;
      score = allScores[0] * singleMult;
      debugLog(`[Ensemble] ${animeBBlind ? 'C-primary (B blind)' : 'Single-model'}: ${Math.round(allScores[0]*100)}% → ${Math.round(score*100)}%`);
    } else {
      score = 0;
      debugLog(`[Ensemble] No models available`);
    }

    // ── Stage 7: Forensic blend ───────────────────────────────────
    // Laplacian variance is NOT useful for modern AI art: diffusion model outputs
    // are sharp and detailed, producing the same variance range as real photos.
    // Only EXIF signal is used, and only when it's actually informative (≠ 0.5).
    // Social media strips EXIF, so for Reddit/Twitter images we trust ML directly.
    let ensembleScore;
    if (exifSignal !== 0.5) {
      // EXIF is informative (AI tool tag → 0.05, camera/GPS → 0.9–1.0)
      ensembleScore = score * 0.85 + (1 - exifSignal) * 0.15;
    } else {
      // No EXIF data — trust ML score directly, no forensic adjustment
      ensembleScore = score;
    }

    // ── Stage 8: Style-adaptive threshold applied by caller ────────
    // Tag the result with the detected style so service.js can apply
    // the right threshold (0.70 photo / 0.75 art+anime).
    ensembleScore = Math.min(ensembleScore, 1.0);
    debugLog(`[Ensemble] Final: ${Math.round(ensembleScore*100)}% style=${style} — ${imageUrl.slice(0, 60)}`);

    const result = { score: ensembleScore, style };
    imageClassificationCache.set(cacheKey, result);
    return result;
  } catch (err) {
    logError(err);
    return { score: 0, style: 'unknown' };
  }
}



function isImageModelReady() { return _isImageModelReady; }

function isTextModel2Ready() { return isModel2Ready; }

module.exports = {
  getSlopScore, isAiSlop, loadModel, loadImageModel, isAiImage, isImageModelReady, isTextModel2Ready,
};
