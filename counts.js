// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// counts.js — Persistent lifetime counter storage.
// require() cache guarantees a single shared instance across main/proxy/service.

const fs   = require('fs');
const path = require('path');

let _dataPath  = null;
let _saveTimer = null;

function _write(counts) {
  if (!_dataPath) return;
  try { fs.writeFileSync(_dataPath, JSON.stringify(counts, null, 2)); } catch {}
}

function _snapshot(state) {
  return {
    filteredCount:  state.filteredCount,
    adsBlocked:     state.adsBlocked,
    imagesBlocked:  state.imagesBlocked,
    youtubeBlocked: state.youtubeBlocked,
  };
}

module.exports = {
  /** Call once at app startup with the userData directory path. */
  init(userData) {
    _dataPath = path.join(userData, 'counts.json');
  },

  /** Load persisted counts from disk. Returns {} on first run or parse error. */
  load() {
    try { return JSON.parse(fs.readFileSync(_dataPath, 'utf8')); } catch { return {}; }
  },

  /**
   * Schedule a debounced save — coalesces rapid increments into one disk write.
   * Call this after every counter increment in proxy.js / service.js.
   */
  schedule(state) {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      _write(_snapshot(state));
      _saveTimer = null;
    }, 2000);
  },

  /** Immediate save — use on reset-all so zeros are persisted right away. */
  flush(state) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    _write(_snapshot(state));
  },
};
