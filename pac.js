// pac.js — Proxy Auto-Config
// Goal: only route genuine top-level HTML page navigations through the slop-filter
// proxy. Everything else goes DIRECT so the browser keeps its own TLS fingerprint,
// preventing auth failures on sites that do per-request TLS fingerprint checks
// (X.com, Instagram, etc.).
//
// Defense in depth: even if something slips through to the proxy, the proxy's own
// Sec-Fetch-Dest/Mode check ensures only real document navigations are modified.
module.exports = {
  generatePAC: function (port) {
    return `function FindProxyForURL(url, host) {
  var lh = host.toLowerCase();
  var lu = url.toLowerCase();
  var path = lu.split('?')[0];

  // ── Always-direct hosts ──────────────────────────────────────────────────
  // ML model downloads must go direct so the classifier can download before
  // the proxy is fully ready.
  if (/^(?:.*\\.)?(?:huggingface\\.co|cdn-lfs(?:-us-1)?\\.huggingface\\.co|raw\\.githubusercontent\\.com|objects\\.githubusercontent\\.com|x\\.com|twitter\\.com|t\\.co|abs\\.twimg\\.com|pbs\\.twimg\\.com|video\\.twimg\\.com|twimg\\.com)$/.test(lh)) {
    return 'DIRECT';
  }

  // ── Non-HTTP schemes ─────────────────────────────────────────────────────
  if (lu.indexOf('http') !== 0) return 'DIRECT';

  // ── File extension: skip non-HTML resources ──────────────────────────────
  // Assets (JS, CSS, images, fonts, media, data files) go direct.
  // This is the single most effective rule — covers the vast majority of
  // sub-resource requests on every site.
  if (/\\.(?:js|css|map|ico|png|jpg|jpeg|gif|webp|svg|avif|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|pdf|zip|gz|wasm|json|xml|txt|csv|rss|atom)(?:[?#]|$)/.test(path)) {
    return 'DIRECT';
  }

  // ── Path segments that indicate API / XHR / data traffic ────────────────
  // Matches the most common patterns across all major platforms.
  if (/\\/(?:api|apis|graphql|query|ajax|xhr|rpc|rest|v\\d+|data|json|feed|fetch|async|service|endpoint|action|auth|oauth|login|logout|token|session|account|profile|user|users|search|suggest|autocomplete|typeahead|analytics|track|pixel|beacon|log|logging|error|report|metrics|telemetry|push|pull|sync|stream|live|realtime|ws|socket|events|pipeline|flow|onboarding|1\\.1|2\\.0)\\//.test(lu)) {
    return 'DIRECT';
  }

  // ── YouTube watch/shorts pages must go through the proxy so the AI-label ──
  // filter script is injected. These are real HTML pages, not API calls.
  if (/^(?:www\\.)?youtube\\.com$/.test(lh) &&
      (/\\/watch(?:\\?|$)/.test(path) || /\\/shorts\\//.test(path))) {
    return 'PROXY 127.0.0.1:${port}';
  }

  // ── URL query string parameters that indicate API/data requests ──────────
  if (/[?&](?:q|query|search|s|variables|features|mutation|cursor|page|offset|limit|count|per_page|format|callback|jsonp|token|key|sig|signature|ts|timestamp|_|rand|v|ver|version|ref|src|utm_|fbclid|gclid|sessionid|csrf)=/.test(lu)) {
    return 'DIRECT';
  }

  // ── Common API path endings ──────────────────────────────────────────────
  if (/\\.(?:json|xml|rss|atom|csv|txt)$/.test(path)) {
    return 'DIRECT';
  }

  // ── Websocket upgrade ────────────────────────────────────────────────────
  if (lu.indexOf('ws://') === 0 || lu.indexOf('wss://') === 0) {
    return 'DIRECT';
  }

  // ── Everything else: real HTML page navigations → through slop filter ────
  return 'PROXY 127.0.0.1:${port}';
}`;
  }
};
