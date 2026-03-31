// Single source of truth for AI slop detection.
// Used by both proxy.js (heuristic-only, server-side) and service.js (full ML + heuristic).

let isModelReady = false;
let textClassifier = null;
const classificationCache = new Map();
const CACHE_MAX = 200;

// ── Image models ─────────────────────────────────────────────────
let imageClassifier = null;
let _isImageModelReady = false;

// Model B: onnx-community/SMOGY-Ai-images-detector-ONNX
//   - Swin Transformer fine-tuned from Organika/sdxl-detector
//   - Confirmed coverage: Flux (83%), DALL-E (91%), Imagen (76%), SD (88%), SDXL (98%)
//   - Binary: AI generated vs Real, threshold 0.90
//   - ~52 MB (q4f16 quantized), downloaded on first use and cached
let modelBClassifier = null;
let _isModelBReady = false;
const MODEL_B_ID        = 'onnx-community/SMOGY-Ai-images-detector-ONNX';
const MODEL_B_THRESHOLD = 0.90;

let activeImageJobs = 0;
const IMAGE_QUEUE = [];
const MAX_IMG_CONCURRENT = 2;

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
];

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

  // ── Structural uniformity (strongest non-phrase signal) ──────────
  // Human writing varies sentence length; LLMs produce very uniform output.
  if (sentences.length > 6) {
    const lengths = sentences.map(s => s.split(/\s+/).length);
    const variance = lengths.reduce((a, b) => a + Math.pow(b - avgLen, 2), 0) / lengths.length;
    if (variance < 100) score += 8;       // very uniform → strong LLM signal
    else if (variance < 150) score += 4;
    if (avgLen > 20 && avgLen < 38) score += 3; // typical LLM sentence length
    if (Math.max(...lengths) - Math.min(...lengths) < 20) score += 4; // almost no range
  }

  // ── Slop phrases: +2 each — need several to score significantly ──
  // Use word-boundary anchors so "leveraging" doesn't match inside other words.
  for (const p of SLOP_PHRASES) {
    const re = new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(lower)) score += 2;
  }

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

  // ── LLM structural openers ────────────────────────────────────────
  // LLMs frequently start with "In this [article/guide/post]..." or end with
  // "In conclusion..." — very reliable signals when combined with other evidence.
  if (/\bin (this|our) (article|post|guide|tutorial|blog|piece)\b/i.test(text)) score += 3;
  if (/\bin conclusion[,.]?\s/i.test(text) || /\bto summarize[,.]?\s/i.test(text)) score += 4;
  if (/\bhope (this|you found this)\b/i.test(text)) score += 3;

  return Math.min(score, 40);
}

// Full classification: heuristic + optional ML model. Returns confidence 0–1.
//
// Blending strategy:
//   - When model is available, weight it at 55% (it's more reliable than heuristic
//     alone for GPT-4/Claude style output, which doesn't always use clichés).
//   - When BOTH signals agree (heuristic AND model both flag), use full blend.
//   - When only ONE signal flags, apply a 0.85x reduction to reduce false positives.
//     This keeps most borderline human writing (good article with 2 slop phrases)
//     below the 0.48 threshold even if the heuristic is elevated.
//   - When model is unavailable, heuristic alone requires a higher effective
//     threshold (scaled down so 0.48 gate is harder to reach alone).
// Returns { confidence: 0–1, method: 'heuristic' | 'model' | 'model+heuristic' }
//
// method reflects what actually drove the decision:
//   'heuristic'        — model unavailable or timed out; heuristic alone
//   'model'            — model ran but heuristic was low; model dominated
//   'model+heuristic'  — both signals fired and agreed; strongest signal
async function isAiSlop(text) {
  if (text.length < 50) return { confidence: 0, method: 'heuristic' };

  const key = text.slice(0, 500);
  if (classificationCache.has(key)) return classificationCache.get(key);

  const heuristicConf = Math.min(getSlopScore(text) / 9, 1.0);
  let confidence;
  let method = 'heuristic';

  if (isModelReady && textClassifier) {
    try {
      const result = await Promise.race([
        textClassifier(text.slice(0, 512)),
        new Promise(r => setTimeout(() => r(null), 6000)),
      ]);
      if (result?.[0]) {
        const { label, score } = result[0];
        const modelConf = (label === 'LABEL_1' || label.includes('fake')) ? score : (1 - score);
        const blend = heuristicConf * 0.45 + modelConf * 0.55;
        const bothAgree   = heuristicConf > 0.38 && modelConf > 0.52;
        // When the model is highly confident on its own (≥ 0.80), skip the
        // cross-signal penalty — clean AI text won't trigger the heuristic
        // but the model should still be trusted.
        const modelStrong = modelConf >= 0.80;
        confidence = (bothAgree || modelStrong) ? blend : blend * 0.82;
        method = bothAgree ? 'model+heuristic' : 'model';
      } else {
        confidence = heuristicConf * 0.72; // model timed out
        method = 'heuristic';
      }
    } catch (_) {
      confidence = heuristicConf * 0.72;
      method = 'heuristic';
    }
  } else {
    confidence = heuristicConf * 0.72;
    method = 'heuristic';
  }

  confidence = Math.min(confidence, 1.0);
  if (classificationCache.size >= CACHE_MAX) {
    classificationCache.delete(classificationCache.keys().next().value);
  }
  const result = { confidence, method };
  classificationCache.set(key, result);
  return result;
}

async function loadModel(onStatus) {
  const log = require('./logger');
  try {
    log.debugLog('Loading AI text detector...');
    onStatus('Loading AI text detector...');
    const { pipeline } = await import('@huggingface/transformers');
    textClassifier = await pipeline('text-classification', 'onnx-community/tmr-ai-text-detector-ONNX', {
      cache_dir: process.env.TRANSFORMERS_CACHE,
    });
    isModelReady = true;
    log.debugLog('AI text detector ready');
    onStatus('AI text detector ready');

    // Warm up: run one dummy inference so the ONNX runtime JIT-compiles the
    // graph now rather than on the first real user request. The first inference
    // is typically 2–5× slower than subsequent ones. This fires-and-forgets
    // so it doesn't block app startup.
    textClassifier('warming up').catch(() => {});

    return true;
  } catch (err) {
    log.logError(err);
    log.debugLog('Text model failed — using heuristic only');
    onStatus('Text model failed — using heuristic only');
    return false;
  }
}

// ── Image model ──────────────────────────────────────────────────
// Model A: yaya36095/ai-source-detector (converted to ONNX locally)
//   - ViT-Base-Patch16-224 fine-tuned for AI art detection
//   - Labels: stable_diffusion / midjourney / dalle / real / other_ai / other_ai_2
//   - combinedScore = aiScore * (1 - realScore), threshold > 0.95
//   - ~84 MB INT8 quantized

const path = require('path');
const AI_SOURCE_MODEL_PATH = path.join(__dirname, 'models', 'ai-source-detector-onnx');

// ── Image fetching ───────────────────────────────────────────────
// Fetch image bytes once and reuse for both C2PA and ML — avoids a
// second network round-trip that the HuggingFace pipeline would make
// internally if given a URL.


async function _fetchImageBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
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

async function loadImageModel(onStatus) {
  if (_isImageModelReady) return true;
  const log = require('./logger');
  try {
    log.debugLog('Loading AI image detector...');
    onStatus('Loading AI image detector (~84 MB)…');
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
    log.debugLog('AI image detector ready');
    onStatus('AI image detector ready');

    // Load Model B in background — doesn't block image detection going live.
    _loadModelB(onStatus);

    return true;
  } catch (err) {
    log.logError(err);
    log.debugLog('Image model failed — image detection unavailable');
    onStatus('Image model failed — image detection unavailable');
    return false;
  }
}

async function _loadModelB(onStatus) {
  if (_isModelBReady) return;
  const log = require('./logger');
  try {
    log.debugLog('Loading supplementary AI image detector (~52 MB)…');
    onStatus('Loading supplementary AI detector (~52 MB)…');
    const { pipeline } = await import('@huggingface/transformers');
    modelBClassifier = await pipeline(
      'image-classification',
      MODEL_B_ID,
      { dtype: 'q4f16', top_k: null, cache_dir: process.env.TRANSFORMERS_CACHE }
    );
    _isModelBReady = true;
    log.debugLog('Supplementary AI image detector ready');
    onStatus('Supplementary AI image detector ready');
  } catch (err) {
    log.logError(err);
    log.debugLog('Model B failed — running single-model mode');
  }
}

async function isAiImage(imageUrl) {
  if (!_isImageModelReady) return 0;
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

// other_ai_2 excluded — absorbs human-made digital content (screenshots, illustrations)
// and inflates false-positive rates. The four labels correspond to trained generator classes.
const KNOWN_AI_LABELS = new Set(['stable_diffusion', 'midjourney', 'dalle', 'other_ai']);

async function _runImageClassify(imageUrl) {
  const log = require('./logger');
  try {
    // Run all inference and buffer fetch in parallel:
    const mlTimeout = new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15000));
    const [mlResult, bResult, buf] = await Promise.all([
      Promise.race([imageClassifier(imageUrl), mlTimeout]).catch(() => null),
      (_isModelBReady && modelBClassifier)
        ? Promise.race([modelBClassifier(imageUrl), mlTimeout]).catch(() => null)
        : Promise.resolve(null),
      _fetchImageBuffer(imageUrl).catch(() => null),
    ]);

    // ── Pass 1: C2PA manifest ─────────────────────────────────────
    if (buf) {
      const c2pa = _checkC2PA(buf);
      if (c2pa === 'ai_generated') {
        log.debugLog(`C2PA: AI-generation manifest confirmed — ${imageUrl.slice(0, 80)}`);
        return 1.0;
      }
    }

    // ── Pass 2: Model A (ai-source-detector) ─────────────────────
    let score = 0;
    if (mlResult) {
      const scores    = Object.fromEntries(mlResult.map(r => [r.label, r.score]));
      const aiScore   = mlResult.reduce((sum, r) => KNOWN_AI_LABELS.has(r.label) ? sum + r.score : sum, 0);
      const realScore = scores['real'] ?? 0;
      const o2Score   = scores['other_ai_2'] ?? 0;

      log.debugLog(
        `SD:${Math.round((scores['stable_diffusion']??0)*100)}% ` +
        `MJ:${Math.round((scores['midjourney']??0)*100)}% ` +
        `DE:${Math.round((scores['dalle']??0)*100)}% ` +
        `OA:${Math.round((scores['other_ai']??0)*100)}% ` +
        `O2:${Math.round(o2Score*100)}%(excl) ` +
        `RL:${Math.round(realScore*100)}% ` +
        `→ ai:${Math.round(aiScore*100)}% — ${imageUrl.slice(0, 60)}`
      );

      if (o2Score > aiScore) {
        log.debugLog(`O2 dominant (${Math.round(o2Score*100)}% > ai ${Math.round(aiScore*100)}%) — suppressed`);
      } else {
        score = aiScore * (1 - realScore);
        log.debugLog(`[A] combined=${Math.round(score*100)}% — ${imageUrl.slice(0, 60)}`);
      }
    }

    // ── Pass 3: Model B (SMOGY — dual-role gate) ─────────────────
    // Role 1 — VETO: when A wants to block (≥95%) but B is very confident
    //   it's real (<5%), suppress. Fixes Model A false positives on sports
    //   thumbnails, movie stills, game screenshots, real photos that A
    //   misclassifies due to polished/stylised aesthetics.
    // Role 2 — CONFIRM: when A already suspects AI (≥50%) and B agrees
    //   (≥90%), push over the block threshold. Catches newer generators
    //   (Flux, Gemini) that score 50–90% on A alone.
    if (bResult) {
      const aiEntry = bResult.find(r => /ai|artificial|generated|fake/i.test(r.label));
      const bScore  = aiEntry?.score ?? 0;
      log.debugLog(`[B] AI:${Math.round(bScore*100)}% (${aiEntry?.label ?? '?'}) — ${imageUrl.slice(0, 60)}`);

      if (score >= 0.95 && bScore < 0.05) {
        log.debugLog(`[B] vetoed A (${Math.round(score*100)}% → suppressed, B=${Math.round(bScore*100)}%)`);
        return 0;
      }

      if (score >= 0.50 && bScore >= MODEL_B_THRESHOLD) {
        log.debugLog(`[B] confirmed (${Math.round(bScore*100)}%) — returning 1.0`);
        return 1.0;
      }
    }

    return score;
  } catch (_) {
    return 0;
  }
}

function isImageModelReady() { return _isImageModelReady; }

module.exports = { getSlopScore, isAiSlop, loadModel, loadImageModel, isAiImage, isImageModelReady };
