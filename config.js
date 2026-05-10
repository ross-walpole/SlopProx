// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// config.js — Single source of truth for all tunable detection parameters.
//
// Usage:
//   const config = require('./config');
//   config.init(userData);          // call once at startup (main.js)
//   config.get('textThreshold');    // read a value
//   config.set('textThreshold', 0.35); // update and persist
//
// Only overrides (deviations from DEFAULTS) are written to config.json,
// keeping the file clean and forward-compatible with new defaults.
// Reads from config.get() always return the correct value even before
// init() is called — they fall back to DEFAULTS so no startup ordering
// constraint is imposed on the modules that consume config.

const fs   = require('fs');
const path = require('path');

const DEFAULTS = {
  // ── Text detection ─────────────────────────────────────────────
  // textThreshold: confidence (0–1) required to classify text as AI-generated.
  // Lower = more sensitive (more blocks, more false positives).
  textThreshold:        0.45,

  // textMinLength: texts shorter than this are never sent for classification.
  // Raising this skips very short social posts; lowering catches short AI snippets.
  textMinLength:        50,

  // textShortLength: texts below this length trigger the short-text gate.
  // The gate caps model confidence to require heuristic corroboration.
  textShortLength:      280,

  // textShortGateCap: maximum model confidence allowed for short text without
  // heuristic corroboration. 0.60 × modelWeight(0.75) = 0.45, sitting at threshold.
  textShortGateCap:     0.60,

  // textModelWeight: fraction of the final confidence score supplied by the ML
  // model (remainder comes from the heuristic). Range: 0–1.
  textModelWeight:      0.75,

  // ML inference timeouts (milliseconds).
  textM1Timeout:        2500,
  textM2Timeout:        4000,

  // ── Image detection ────────────────────────────────────────────
  // imageThresholdPhoto / imageThresholdArt: confidence (0–1) required to flag
  // an image as AI-generated. Photos use a slightly lower bar because the model
  // is better calibrated on realistic photography; art/anime use a higher bar
  // to avoid false positives on stylised human-created work.
  imageThresholdPhoto:  0.70,
  imageThresholdArt:    0.75,

  // imageMinNaturalPx: minimum natural (intrinsic) image width or height.
  // Images smaller than this are skipped — they're likely icons or thumbnails.
  imageMinNaturalPx:    300,

  // imageMinDisplayPx: minimum rendered display size. An image that renders
  // too small on screen is not worth classifying even if it's large natively.
  imageMinDisplayPx:    200,

  // imageForceConfidence: confidence percentage (0–100) at which an image is
  // force-blocked even without page-prior corroboration. Set high to avoid
  // false positives from very confident individual verdicts.
  imageForceConfidence: 92,

  // ML inference timeout (milliseconds) — shared across all image models.
  imageInferenceTimeout: 15000,

  // imageFetchTimeout: HTTP timeout (milliseconds) for fetching image bytes.
  imageFetchTimeout:    12000,

  // ── Performance ────────────────────────────────────────────────
  // Token-bucket rate limits for the local classification API.
  // These protect the model from being flooded; most users won't need to change them.
  textRateLimitPerSec:  20,
  imageRateLimitPerSec:  5,
};

let _dataPath = null;
let _current  = { ...DEFAULTS };

function _write() {
  if (!_dataPath) return;
  try {
    // Only persist overrides — keeps config.json minimal and forward-compatible.
    const overrides = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (_current[key] !== DEFAULTS[key]) overrides[key] = _current[key];
    }
    fs.writeFileSync(_dataPath, JSON.stringify(overrides, null, 2));
  } catch {}
}

module.exports = {
  /** Exported so the UI can show default values and reset controls. */
  DEFAULTS,

  /** Call once in main.js after app.getPath('userData') is available. */
  init(userData) {
    _dataPath = path.join(userData, 'config.json');
    try {
      const saved = JSON.parse(fs.readFileSync(_dataPath, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (saved[key] !== undefined) _current[key] = saved[key];
      }
    } catch {}
  },

  /** Read a config value. Returns the default if key is unknown or init hasn't run yet. */
  get(key) {
    return _current[key] ?? DEFAULTS[key];
  },

  /** Persist a config override. Returns false if key is not a known config key. */
  set(key, value) {
    if (!(key in DEFAULTS)) return false;
    _current[key] = value;
    _write();
    return true;
  },

  /** Returns a shallow copy of the full current config (defaults merged with overrides). */
  all() {
    return { ..._current };
  },
};
