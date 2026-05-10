// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// background.js - MV3 service worker — handles all HTTP requests to the local app server.
//
// Content scripts run in the page's security origin (e.g. https://x.com) and
// are blocked by Chrome's Private Network Access policy from fetching
// http://127.0.0.1. Background service workers run in the extension's own
// origin and are exempt from that restriction.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[AI Slop Filter] Extension installed');
});

const BASE = 'http://127.0.0.1:8083';

// Cached per service worker lifecycle — fetched once from /status.
let _serviceToken = '';

function _tokenHeaders(extra) {
  const h = { 'Content-Type': 'text/plain' };
  if (_serviceToken) h['X-SlopFilter-Token'] = _serviceToken;
  return Object.assign(h, extra);
}

// Fetch the token if we don't have one yet (happens on service worker restart).
async function _ensureToken() {
  if (_serviceToken) return;
  try {
    const r = await fetch(BASE + '/status', { signal: AbortSignal.timeout(800) });
    const data = await r.json();
    if (data.token) _serviceToken = data.token;
  } catch (_) {}
}

// ── DNR ad-block ruleset management ───────────────────────────────
// Tracks whether the 'ad-block' static ruleset is currently enabled so we
// don't call updateEnabledRulesets on every status poll (it's async + has
// write quota). Initialised to true to match the manifest default.
let _adBlockEnabled = true;

async function _updateAdBlockRuleset(enabled) {
  if (enabled === _adBlockEnabled) return;
  _adBlockEnabled = enabled;
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      enabled
        ? { enableRulesetIds: ['ad-block'], disableRulesetIds: [] }
        : { enableRulesetIds: [], disableRulesetIds: ['ad-block'] }
    );
  } catch (_) {}
}

// ── DNR ad-block counter ───────────────────────────────────────────
// onRuleMatchedDebug fires once per blocked request (requires declarative-
// NetRequestFeedback permission + unpacked extension — always true for
// SlopProx since it is sideloaded). Counts accumulate here and are flushed
// to the local service on every status poll (every ~2 s).
let _pendingAdCount = 0;
let _pendingAdHosts = [];

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
    if (info.rule.rulesetId !== 'ad-block') return;
    _pendingAdCount++;
    try {
      _pendingAdHosts.push(new URL(info.request.url).hostname);
    } catch (_) {}
  });
}

async function _reportAdBlockCount() {
  if (_pendingAdCount === 0) return;
  const delta = _pendingAdCount;
  const hosts = _pendingAdHosts;
  _pendingAdCount = 0;
  _pendingAdHosts = [];
  try {
    await _ensureToken();
    fetch(BASE + '/ad-count-report', {
      method: 'POST',
      body: JSON.stringify({ delta, hosts }),
      headers: _tokenHeaders({ 'Content-Type': 'application/json' }),
      signal: AbortSignal.timeout(1000),
    }).catch(() => {});
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'status') {
    fetch(BASE + '/status', { signal: AbortSignal.timeout(800) })
      .then(r => r.json())
      .then(data => {
        if (data.token) _serviceToken = data.token;
        _updateAdBlockRuleset(data.adBlockEnabled ?? true);
        _reportAdBlockCount();
        respond({ ok: true, data });
      })
      .catch(() => respond({ ok: false }));
    return true;
  }

  if (msg.type === 'classify') {
    _ensureToken()
      .then(() => fetch(BASE + '/classify', {
        method: 'POST',
        body: msg.text,
        headers: _tokenHeaders(),
        signal: AbortSignal.timeout(10000),
      }))
      .then(r => r.ok ? r.json() : null)
      .then(data => respond(data ? { ok: true, data } : { ok: false }))
      .catch(() => respond({ ok: false }));
    return true;
  }

  if (msg.type === 'youtubeBlock') {
    fetch(BASE + '/youtube-block', { method: 'POST', headers: _tokenHeaders(), signal: AbortSignal.timeout(800) })
      .then(() => respond({ ok: true }))
      .catch(() => respond({ ok: false }));
    return true;
  }

  if (msg.type === 'classifyImage') {
    _ensureToken()
      .then(() => fetch(BASE + '/classify-image', {
        method: 'POST',
        body: msg.url,
        headers: _tokenHeaders(),
        signal: AbortSignal.timeout(20000),
      }))
      .then(r => r.ok ? r.json() : null)
      .then(data => respond(data ? { ok: true, data } : { ok: false }))
      .catch(() => respond({ ok: false }));
    return true;
  }
});
