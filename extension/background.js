// MV3 service worker — handles all HTTP requests to the local app server.
//
// Content scripts run in the page's security origin (e.g. https://x.com) and
// are blocked by Chrome's Private Network Access policy from fetching
// http://127.0.0.1. Background service workers run in the extension's own
// origin and are exempt from that restriction.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[AI Slop Filter] Extension installed');
});

const BASE = 'http://127.0.0.1:8083';

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg === 'ping') { respond('pong'); return true; }

  if (msg.type === 'status') {
    fetch(BASE + '/status', { signal: AbortSignal.timeout(800) })
      .then(r => r.json())
      .then(data => respond({ ok: true, data }))
      .catch(() => respond({ ok: false }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'classify') {
    fetch(BASE + '/classify', {
      method: 'POST',
      body: msg.text,
      headers: { 'Content-Type': 'text/plain' },
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
      headers: { 'Content-Type': 'text/plain' },
      signal: AbortSignal.timeout(20000),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => respond(data ? { ok: true, data } : { ok: false }))
      .catch(() => respond({ ok: false }));
    return true;
  }
});
