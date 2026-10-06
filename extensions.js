// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// extensions.js — tracks which browser extensions talk to the local service and
// whether they are new enough for this app. The app updates itself but the
// extension updates through the browser stores, so the two can drift apart.

// Oldest extension version this app works properly with. Raise it when an app
// release depends on the matching extension update; older extensions are then
// flagged in the EXTENSION tab and in the extension popup.
const MIN_EXTENSION_VERSION = '1.1.0';

// Extensions up to this version never announce themselves (POST /extension-hello
// came after it), so a connected extension that stays silent is at most this old.
const LAST_SILENT_VERSION = '1.1.0';

// { chrome: { version }, firefox: { version } } — version is null until announced.
const _seen = {};

// '1.10.0' vs '1.9.2' → 1. Missing or non-numeric parts count as 0.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// The browser sets Origin itself, so this can't be spoofed by a web page.
function browserFromOrigin(origin) {
  if (origin.startsWith('chrome-extension://')) return 'chrome';
  if (origin.startsWith('moz-extension://'))    return 'firefox';
  return null;
}

// Records a request from an extension origin, with its version if it announced one.
// Returns true when the status changed.
function note(origin, version) {
  const browser = browserFromOrigin(origin || '');
  if (!browser) return false;
  const prev = _seen[browser];
  const next = version || prev?.version || null;
  if (prev && prev.version === next) return false;
  _seen[browser] = { version: next };
  return true;
}

function status() {
  const silentOutdated = compareVersions(MIN_EXTENSION_VERSION, LAST_SILENT_VERSION) > 0;
  return {
    minVersion: MIN_EXTENSION_VERSION,
    extensions: Object.entries(_seen).map(([browser, { version }]) => ({
      browser,
      version,
      // null = can't tell (an older extension that never reports its version)
      outdated: version
        ? compareVersions(version, MIN_EXTENSION_VERSION) < 0
        : (silentOutdated ? true : null),
    })),
  };
}

module.exports = { MIN_EXTENSION_VERSION, LAST_SILENT_VERSION, compareVersions, browserFromOrigin, note, status };
