// pac.js — Proxy Auto-Config

// Goal: only route genuine top-level HTML page navigations through the slop-filter
// proxy. Everything else goes DIRECT so the browser keeps its own TLS fingerprint,
// preventing auth failures on sites that do per-request TLS fingerprint checks
// (X.com, Instagram, etc.).
//
// Defense in depth: even if something slips through to the proxy, the proxy's own
// Sec-Fetch-Dest/Mode check ensures only real document navigations are modified.
module.exports = {
  generatePAC: function (port, bypassDomains) {
    // User-added bypass domains go DIRECT — no proxy, no MITM, no cert issues
    const bypassLines = (bypassDomains || [])
      .filter(d => d !== 'localhost' && d !== '127.0.0.1' && !d.includes('*') && !/^\d/.test(d))
      .map(d => `  if (lh === '${d}') return 'DIRECT';`)
      .join('\n');

    return `function FindProxyForURL(url, host) {
  var lh = host.toLowerCase();
  var lu = url.toLowerCase();
  var path = lu.split('?')[0];

  // ── User bypass list (managed via SlopProx UI) ───────────────────────────
${bypassLines}

  // ── Always-direct hosts ──────────────────────────────────────────────────
  // ML model downloads must go direct so the classifier can download before
  // the proxy is fully ready.
  // VS Code/IDE domains: Bypass proxy to avoid cert/MITM interference with extensions, chat, APIs.
  if (/^(?:.*\\.)?(?:huggingface\\.co|cdn-lfs(?:-us-1)?\\.huggingface\\.co|raw\\.githubusercontent\\.com|objects\\.githubusercontent\\.com|visualstudio\\.com|microsoftonline\\.com|vscode\\.dev|api\\.github\\.com|x\\.com|twitter\\.com|t\\.co|abs\\.twimg\\.com|pbs\\.twimg\\.com|video\\.twimg\\.com|twimg\\.com|amazonaws\\.com|cloudfront\\.net|fonts\\.googleapis\\.com|fonts\\.gstatic\\.com)$/.test(lh)) {
    return 'DIRECT';
  }

  // ── Windows / Edge system services — always DIRECT ───────────────────────
  // These use certificate pinning or TLS that rejects MITM CAs. Routing them
  // through the proxy causes SSL errors and adds noise. They carry no web content.
  if (/^(?:.*\\.)?(?:msedge\\.net|msedge\\.com|bing\\.com|live\\.com|login\\.microsoftonline\\.com|events\\.data\\.microsoft\\.com|settings-win\\.data\\.microsoft\\.com|watson\\.telemetry\\.microsoft\\.com|vortex\\.data\\.microsoft\\.com|browser\\.pipe\\.aria\\.microsoft\\.com|self\\.events\\.data\\.microsoft\\.com|edge\\.microsoft\\.com|config\\.edge\\.skype\\.com|business\\.bing\\.com|discord\\.com|discordapp\\.com|discord\\.gg|discord\\.media|gateway\\.discord\\.gg)$/.test(lh)) {
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
