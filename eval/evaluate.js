// eval/evaluate.js — run the labeled dataset through the classifier and report metrics.
// Usage: node eval/evaluate.js [--heuristic-only] [--threshold 0.60]

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const { getSlopScore, isAiSlop, loadModel } = require('../classifier');

const THRESHOLD = parseFloat(process.argv.find((a, i, arr) => arr[i-1] === '--threshold') || '0.60');
const HEURISTIC_ONLY = process.argv.includes('--heuristic-only');
const PLATFORM_FILTER = process.argv.find((a, i, arr) => arr[i-1] === '--platform');

async function main() {
  if (!HEURISTIC_ONLY) {
    process.env.TRANSFORMERS_CACHE = path.join(__dirname, '..', 'models');
    console.log('Loading text model…');
    await loadModel(msg => process.stdout.write(`  ${msg}\r`));
    console.log('');
  }

  const datasetPath = path.join(__dirname, 'dataset.jsonl');
  const lines = fs.readFileSync(datasetPath, 'utf8').trim().split('\n');
  const samples = lines.map(l => JSON.parse(l));

  const filtered = PLATFORM_FILTER
    ? samples.filter(s => s.platform === PLATFORM_FILTER)
    : samples;

  console.log(`\nEvaluating ${filtered.length} samples (threshold=${THRESHOLD}${HEURISTIC_ONLY ? ', heuristic-only' : ''}${PLATFORM_FILTER ? `, platform=${PLATFORM_FILTER}` : ''})\n`);

  let tp = 0, fp = 0, tn = 0, fn = 0;
  const falsePositives = [];
  const falseNegatives = [];
  const allResults = [];

  for (const sample of filtered) {
    let confidence, method;
    if (HEURISTIC_ONLY) {
      const score = getSlopScore(sample.text);
      confidence = Math.min(score / 16, 1.0);
      method = 'heuristic';
    } else {
      ({ confidence, method } = await isAiSlop(sample.text));
    }

    const predicted = confidence > THRESHOLD ? 1 : 0;
    const correct = predicted === sample.label;

    allResults.push({ ...sample, confidence: Math.round(confidence * 100), method, predicted, correct });

    if (sample.label === 1 && predicted === 1) tp++;
    else if (sample.label === 0 && predicted === 1) fp++;
    else if (sample.label === 0 && predicted === 0) tn++;
    else fn++;

    if (sample.label === 0 && predicted === 1) falsePositives.push(sample);
    if (sample.label === 1 && predicted === 0) falseNegatives.push(sample);
  }

  const precision = tp / (tp + fp) || 0;
  const recall    = tp / (tp + fn) || 0;
  const f1        = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  const accuracy  = (tp + tn) / filtered.length;

  console.log('── Results ─────────────────────────────────────────');
  console.log(`Accuracy:  ${pct(accuracy)}`);
  console.log(`Precision: ${pct(precision)}  (of flagged items, how many were actually AI)`);
  console.log(`Recall:    ${pct(recall)}  (of AI items, how many were caught)`);
  console.log(`F1:        ${pct(f1)}`);
  console.log('');
  console.log('── Confusion matrix ────────────────────────────────');
  console.log(`  TP (AI correctly flagged):     ${String(tp).padStart(3)}`);
  console.log(`  TN (human correctly passed):   ${String(tn).padStart(3)}`);
  console.log(`  FP (human wrongly flagged):    ${String(fp).padStart(3)}  ← false positives`);
  console.log(`  FN (AI missed):                ${String(fn).padStart(3)}  ← false negatives`);
  console.log('');

  // Per-platform breakdown
  const platforms = [...new Set(filtered.map(s => s.platform))];
  console.log('── Per-platform breakdown ──────────────────────────');
  for (const plat of platforms) {
    const platSamples = allResults.filter(s => s.platform === plat);
    const pFP = platSamples.filter(s => s.label === 0 && s.predicted === 1).length;
    const pFN = platSamples.filter(s => s.label === 1 && s.predicted === 0).length;
    const pTP = platSamples.filter(s => s.label === 1 && s.predicted === 1).length;
    const pTN = platSamples.filter(s => s.label === 0 && s.predicted === 0).length;
    const pAcc = (pTP + pTN) / platSamples.length;
    console.log(`  ${plat.padEnd(10)} acc=${pct(pAcc)}  FP=${pFP}  FN=${pFN}  (${platSamples.length} samples)`);
  }
  console.log('');

  // Edge case breakdown
  const edgeSamples = allResults.filter(s => s.edge_case);
  const edgeFP = edgeSamples.filter(s => s.label === 0 && s.predicted === 1).length;
  const edgeFN = edgeSamples.filter(s => s.label === 1 && s.predicted === 0).length;
  console.log(`── Edge cases (n=${edgeSamples.length}) ─────────────────────────────`);
  console.log(`  FP on edge-case human text: ${edgeFP}`);
  console.log(`  FN on edge-case AI text:    ${edgeFN}`);
  console.log('');

  if (falsePositives.length > 0) {
    console.log(`── False positives (human text flagged as AI) — ${falsePositives.length} ──`);
    for (const s of falsePositives) {
      const r = allResults.find(r => r.id === s.id);
      console.log(`  [${s.platform}${s.edge_case ? '*' : ' '}] conf=${r.confidence}% — "${s.text.slice(0, 90).replace(/\n/g,' ')}"`);
    }
    console.log('');
  }

  if (falseNegatives.length > 0) {
    console.log(`── False negatives (AI text missed) — ${falseNegatives.length} ──`);
    for (const s of falseNegatives) {
      const r = allResults.find(r => r.id === s.id);
      console.log(`  [${s.platform}${s.edge_case ? '*' : ' '}] conf=${r.confidence}% — "${s.text.slice(0, 90).replace(/\n/g,' ')}"`);
    }
  }

  // Score distribution
  console.log('\n── Confidence distribution ─────────────────────────');
  const buckets = { '0-20':0, '21-40':0, '41-60':0, '61-80':0, '81-100':0 };
  for (const r of allResults) {
    if (r.confidence <= 20) buckets['0-20']++;
    else if (r.confidence <= 40) buckets['21-40']++;
    else if (r.confidence <= 60) buckets['41-60']++;
    else if (r.confidence <= 80) buckets['61-80']++;
    else buckets['81-100']++;
  }
  for (const [range, count] of Object.entries(buckets)) {
    const bar = '█'.repeat(Math.round(count / filtered.length * 40));
    console.log(`  ${range.padEnd(7)} ${String(count).padStart(3)}  ${bar}`);
  }
}

function pct(n) { return `${Math.round(n * 100)}%`.padStart(4); }

main().catch(err => { console.error(err); process.exit(1); });
