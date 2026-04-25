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

// Token obtained from /status — required by /classify and /classify-image.
// Cached here so we only fetch it once per service worker lifecycle.
let _serviceToken = '';

function _tokenHeaders(extra) {
  const h = { 'Content-Type': 'text/plain' };
  if (_serviceToken) h['X-SlopFilter-Token'] = _serviceToken;
  return Object.assign(h, extra);
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'status') {
    fetch(BASE + '/status', { signal: AbortSignal.timeout(800) })
      .then(r => r.json())
      .then(data => {
        // Cache the token for subsequent classify calls
        if (data.token) _serviceToken = data.token;
        respond({ ok: true, data });
      })
      .catch(() => respond({ ok: false }));
    return true;
  }

  if (msg.type === 'classify') {
    fetch(BASE + '/classify', {
      method: 'POST',
      body: msg.text,
      headers: _tokenHeaders(),
      signal: AbortSignal.timeout(10000),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => respond(data ? { ok: true, data } : { ok: false }))
      .catch(() => respond({ ok: false }));
    return true;
  }

  if (msg.type === 'youtubeBlock') {
    fetch(BASE + '/youtube-block', { method: 'POST', signal: AbortSignal.timeout(800) })
      .then(() => respond({ ok: true }))
      .catch(() => respond({ ok: false }));
    return true;
  }

  if (msg.type === 'classifyImage') {
    fetch(BASE + '/classify-image', {
      method: 'POST',
      body: msg.url,
      headers: _tokenHeaders(),
      signal: AbortSignal.timeout(20000),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => respond(data ? { ok: true, data } : { ok: false }))
      .catch(() => respond({ ok: false }));
    return true;
  }
});
