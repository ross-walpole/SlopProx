// HTTPS MITM proxy — intercepts HTML page navigations, injects the slop-filter
// script + styles, and blocks ad domains. API calls and social-media traffic are
// routed DIRECT by the PAC file and never reach this proxy.

const mockttp = require('mockttp');
const fs      = require('fs');
const path    = require('path');
const { isAiSlop }        = require('./classifier');
const { debugLog, logError } = require('./logger');
const state = require('./state');

const PORT = 8081;

// Ad-domain blocklist — matched against the request host
const AD_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'google-analytics.com', 'googletagmanager.com',
  'adnxs.com', 'advertising.com', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com',
  'criteo.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com',
  'adform.net', 'adsafeprotected.com', 'adsrvr.org', 'bidswitch.net',
  'smartadserver.com', 'equativ.com', 'mgid.com', 'adtech.com', '2o7.net', 'omtrdc.net',
  'scorecardresearch.com', 'quantserve.com', 'krxd.net', 'demdex.net', 'dm-dna.com',
];

const AD_URL_RE = /\/(ad|ads|advert|banner|pixel|beacon|tracking|analytics|imp|click|syndication)\//i;

const AD_WHITELIST = [
  'youtube.com', 'netflix.com', 'google.com', 'github.com', 'localhost',
  'wikipedia.org', 'wikimedia.org',   // beacon/analytics paths in wiki URLs
  'msftconnecttest.com', 'dns.msftncsi.com', 'msftncsi.com',
  'windows.com', 'microsoft.com', 'akadns.net', 'azureedge.net',
];

let proxyServer   = null;
let safeSend      = () => {};
let injectedScript = '';
let injectedStyles = '';
let pacContent    = '';

// Called once at startup — caches all injected content and wires up the IPC callback.
function init(sendFn, pac) {
  safeSend      = sendFn;
  pacContent    = pac || '';
  injectedScript = fs.readFileSync(path.join(__dirname, 'injected.js'),  'utf8');
  injectedStyles = fs.readFileSync(path.join(__dirname, 'injected.css'), 'utf8');
}

function isAdRequest(host, urlStr) {
  if (!state.AD_BLOCKING_ENABLED) return false;
  if (AD_WHITELIST.some(w => host.includes(w))) return false;
  return AD_DOMAINS.some(d => host.includes(d)) || AD_URL_RE.test(urlStr);
}

// Extract the nonce value from a Content-Security-Policy header value.
// When a nonce is present, browsers ignore 'unsafe-inline' — our injected
// script/style must carry the matching nonce to be executed.
// The header value may be a string or an array (when multiple CSP headers are sent).
function extractNonce(cspHeader) {
  if (!cspHeader) return '';
  const csp = Array.isArray(cspHeader) ? cspHeader.join('; ') : String(cspHeader);
  const m = csp.match(/'nonce-([A-Za-z0-9+/=_-]+)'/);
  return m ? m[1] : '';
}

// Pure string injection — never runs a full HTML parser (cheerio), so it can
// never corrupt inline JSON blobs, SPA bootstrap data, or signed script content.
function processHtml(body, cspHeader) {
  let nonce = extractNonce(cspHeader);
  // Fallback: grab nonce from an existing <script nonce="..."> in the raw HTML
  if (!nonce) {
    const m = body.match(/<script[^>]+nonce="([^"]+)"/i);
    if (m) nonce = m[1];
  }

  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const styleTag  = `<style id="sf-styles"${nonceAttr}>${injectedStyles}</style>`;
  const scriptTag = `<script id="sf-script"${nonceAttr}>${injectedScript}</script>`;

  // Insert style just before </head>, script just before </body>.
  // Use lastIndexOf so we don't match closing tags inside templates/comments.
  let result = body;
  const headClose = result.lastIndexOf('</head>');
  if (headClose !== -1) result = result.slice(0, headClose) + styleTag + result.slice(headClose);
  else result += styleTag;

  const bodyClose = result.lastIndexOf('</body>');
  if (bodyClose !== -1) result = result.slice(0, bodyClose) + scriptTag + result.slice(bodyClose);
  else result += scriptTag;

  return result;
}

// Mockttp uses console.error() directly for connection-level errors that are
// entirely benign in a MITM proxy context (non-HTTP clients, mid-TLS aborts,
// socket hang-ups during cert install, parse errors from raw TCP traffic).
// Intercept console.error once to route these to debugLog instead of stderr.
const _origConsoleError = console.error;
const _BENIGN_PROXY_RE  = /failed to handle request|parse error|expected http|ECONNRESET|EPIPE/i;
console.error = (...args) => {
  const msg = args.map(a => (a && a.message) || String(a)).join(' ');
  if (_BENIGN_PROXY_RE.test(msg)) { debugLog(`[proxy noise suppressed] ${msg}`); return; }
  _origConsoleError(...args);
};

async function start(certsDir) {
  if (proxyServer) return;

  const caCertPath = path.join(certsDir, 'ca.pem');
  const caKeyPath  = path.join(certsDir, 'ca.key');

  try {
    if (!fs.existsSync(caCertPath) || !fs.existsSync(caKeyPath)) {
      debugLog('Generating CA certificate...');
      const ca = await mockttp.generateCACertificate();
      fs.writeFileSync(caCertPath, ca.cert);
      fs.writeFileSync(caKeyPath, ca.key);
      debugLog('CA certificate saved');
    }

    proxyServer = mockttp.getLocal({
      https: { certPath: caCertPath, keyPath: caKeyPath },
      http2: false, // reduces TLS fingerprint surface
    });

    await proxyServer.forAnyRequest().thenPassThrough({

      // ── beforeRequest: intercept our own synthetic endpoints before forwarding ──
      beforeRequest: async (req) => {
        const urlStr = req.url || '';

        // Serve the PAC file. Chrome fetches this as a plain HTTP GET to our port,
        // so we intercept it here rather than letting it reach the real server.
        if (urlStr.endsWith('/filter.pac')) {
          return { response: { statusCode: 200, headers: { 'content-type': 'application/x-ns-proxy-autoconfig' }, body: pacContent } };
        }

        // ── Proxy-relay endpoints ──────────────────────────────────────────────
        // injected.js uses relative URLs (/__slop_filter_*) which the browser
        // treats as same-origin, bypassing CSP connect-src entirely. We handle
        // them here so they never reach the real server.
        if (urlStr.endsWith('/__slop_filter_classify') && req.method === 'POST') {
          try {
            const text = (await req.body.getText()).trim().replace(/\s+/g, ' ');
            if (text.length < 60 || !state.FILTER_ENABLED) {
              return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"isSlop":false,"confidence":0}' } };
            }
            const { confidence, method } = await isAiSlop(text);
            const isSlop = confidence > 0.38;
            debugLog(`Text/proxy [${isSlop ? 'SLOP' : 'real'} ${Math.round(confidence * 100)}% ${method}]: "${text.slice(0, 80)}"`);
            if (isSlop) { state.filteredCount++; safeSend('filter-count', state.filteredCount); }
            return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isSlop, confidence: Math.round(confidence * 100), method }) } };
          } catch (_) {
            return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"isSlop":false,"confidence":0}' } };
          }
        }

        if (urlStr.endsWith('/__slop_filter_status') && req.method === 'GET') {
          return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: state.FILTER_ENABLED, youtubeFilterEnabled: state.YOUTUBE_FILTER_ENABLED }) } };
        }

        if (urlStr.endsWith('/__slop_filter_youtube') && req.method === 'POST') {
          state.youtubeBlocked++;
          safeSend('youtube-count', state.youtubeBlocked);
          debugLog(`YouTube AI-disclosed video blocked (#${state.youtubeBlocked})`);
          return { response: { statusCode: 204, headers: {} } };
        }
      },

      // ── beforeResponse: ad blocking + HTML injection ───────────────────────
      // mockttp passes (response, request) — the request is the second param.
      beforeResponse: async (response, req) => {
        const urlStr = req?.url || '';
        let host = '';
        try { host = new URL(urlStr).hostname.toLowerCase(); } catch (_) {}

        // Ad blocking
        if (isAdRequest(host, urlStr)) {
          state.adsBlocked++;
          safeSend('ads-count', state.adsBlocked);
          debugLog(`Ad blocked: ${host}`);
          return { statusCode: 204, headers: {} };
        }

        const rawCT = response.headers?.['content-type'];
        const contentType = (Array.isArray(rawCT) ? rawCT[0] : rawCT || '').toLowerCase();
        if (!contentType.includes('text/html')) return;
        if (host === '127.0.0.1' || host === 'localhost') return;

        // Sec-Fetch headers reliably identify genuine page navigations vs XHR/fetch.
        // Only filter if both headers are present (some clients omit them).
        const reqHeaders = req?.headers || {};
        const fetchDest  = (reqHeaders['sec-fetch-dest']  || '').toLowerCase();
        const fetchMode  = (reqHeaders['sec-fetch-mode']  || '').toLowerCase();
        if (fetchDest && fetchMode && (fetchMode !== 'navigate' || fetchDest !== 'document')) return;

        try {
          if (req?.method && req.method !== 'GET') return;

          const body = await response.body.getText();
          if (!body || body.length < 1000 || body.length > 800_000) return;

          debugLog(`Injecting into: ${host} (${body.length} bytes)`);
          const cspHeader = response.headers?.['content-security-policy'] || '';
          const modified  = processHtml(body, cspHeader);

          const headers = { ...response.headers };
          // Normalize CSP to a string — mockttp may return it as an array when the
          // server sent multiple headers with the same name.
          if (Array.isArray(headers['content-security-policy'])) {
            headers['content-security-policy'] = headers['content-security-policy'].join('; ');
          }
          // Remove report-only CSP — it would generate noise in the browser console
          // for our injected elements.
          delete headers['content-security-policy-report-only'];
          headers['cache-control']  = 'no-cache, no-store, must-revalidate';
          headers['pragma']         = 'no-cache';
          headers['expires']        = '0';
          headers['content-length'] = Buffer.byteLength(modified, 'utf8').toString();

          return { statusCode: response.statusCode, headers, body: modified };
        } catch (e) {
          logError(e);
        }
      },
    });

    // Suppress expected low-level connection errors that mockttp surfaces as
    // unhandled events. These fire when:
    //   - Non-HTTP traffic hits the proxy port (OS apps, update services)
    //   - Browser aborts a connection mid-TLS during cert install window
    //   - Socket hang-ups on keep-alive connections that the client dropped
    // None of these indicate a real problem — suppressing keeps the log clean.
    const BENIGN_ERRORS = /aborted|socket hang up|parse error|expected http|ECONNRESET|EPIPE|ENOTFOUND/i;
    proxyServer.on('request-error', (req, err) => {
      if (!BENIGN_ERRORS.test(err?.message || '')) logError(err);
    });

    await proxyServer.start(PORT);
    debugLog(`Proxy started on port ${PORT}`);
    safeSend('status-update', 'AI Slop Filter is running');

  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      logError(new Error(`Port ${PORT} is already in use`));
      safeSend('status-update', `Error: Port ${PORT} in use — restart the app`);
    } else {
      logError(err);
    }
  }
}

function stop() {
  proxyServer?.stop().catch(() => {});
  proxyServer = null;
}

module.exports = { init, start, stop, PORT };
