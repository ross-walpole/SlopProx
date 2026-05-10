// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

const mockttp = require('mockttp');
const fs      = require('fs');
const path    = require('path');
const { execSync }           = require('child_process');
const { isAiSlop }           = require('./classifier');
const { debugLog, logError } = require('./logger');
const state  = require('./state');
const counts = require('./counts');
const config = require('./config');
const pac    = require('./pac');

const PORT = 8081;

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
  'wikipedia.org', 'wikimedia.org',
  'msftconnecttest.com', 'dns.msftncsi.com', 'msftncsi.com',
  'windows.com', 'microsoft.com', 'akadns.net', 'azureedge.net',
];

let proxyServer    = null;
let safeSend       = () => {};
let showWindow     = () => {};
let injectedScript = '';
let injectedStyles = '';
let _activeAdDomains = AD_DOMAINS;

const recentSuggestions = new Map(); // hostname → timestamp (deduplication)

// ── Upstream proxy detection ───────────────────────────────────────────────────
// Reads the OS-configured proxy at startup. Returns a proxyUrl string (http://...,
// socks5://...) or a pac+http://... string for PAC-based configs.
// mockttp's proxy-agent handles all these formats natively.
function detectUpstreamProxy() {
  // 1. Environment variables — highest priority, cross-platform
  for (const k of ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy']) {
    if (process.env[k]) return process.env[k];
  }

  // 2. Windows registry
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"',
        { encoding: 'utf8', windowsHide: true }
      );
      const proxyEnabled = /ProxyEnable\s+REG_DWORD\s+0x1/m.test(out);
      if (proxyEnabled) {
        const m = out.match(/ProxyServer\s+REG_SZ\s+(.+)/m);
        if (m) {
          let server = m[1].trim();
          // Handle "http=proxy:8080;https=proxy:8080" protocol-specific format
          if (server.includes('=')) {
            server = server.match(/https=([^;]+)/)?.[1]
                  || server.match(/http=([^;]+)/)?.[1]
                  || server.split(';')[0];
          }
          if (!server.startsWith('http')) server = `http://${server}`;
          return server;
        }
      }
      // PAC file (AutoConfigURL) — lower priority than explicit proxy
      const pacM = out.match(/AutoConfigURL\s+REG_SZ\s+(.+)/m);
      if (pacM) {
        const url = pacM[1].trim();
        return url.startsWith('pac+') ? url : `pac+${url}`;
      }
    } catch (_) {}
  }

  // 3. macOS
  if (process.platform === 'darwin') {
    try {
      const out = execSync('scutil --proxy', { encoding: 'utf8' });
      const httpsOn = /HTTPSEnable\s*:\s*1/.test(out);
      const httpOn  = /HTTPEnable\s*:\s*1/.test(out);
      if (httpsOn || httpOn) {
        const host = (httpsOn
          ? out.match(/HTTPSProxy\s*:\s*(.+)/)?.[1]
          : out.match(/HTTPProxy\s*:\s*(.+)/)?.[1])?.trim();
        const port = (httpsOn
          ? out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1]
          : out.match(/HTTPPort\s*:\s*(\d+)/)?.[1]) || '8080';
        if (host) return `http://${host}:${port}`;
      }
      const pacUrl = out.match(/ProxyAutoConfigURLString\s*:\s*(.+)/)?.[1]?.trim();
      if (pacUrl) return pacUrl.startsWith('pac+') ? pacUrl : `pac+${pacUrl}`;
    } catch (_) {}
  }

  return null;
}

function isRealBrowserRequest(req) {
  if (!req?.headers) return false;
  const h = req.headers;
  const hasSecFetch    = !!(h['sec-fetch-mode'] || h['sec-fetch-dest'] || h['sec-fetch-site']);
  const hasClientHints = !!(h['sec-ch-ua'] || h['sec-ch-ua-mobile'] || h['sec-ch-ua-platform']);
  const hasUpgrade     = h['upgrade-insecure-requests'] === '1';
  const ua = String(h['user-agent'] || '');
  const looksLikeBrowserUA = ua.includes('Mozilla/5.0') && (
    ua.includes('Chrome/') || ua.includes('Edg/') ||
    ua.includes('Firefox/') || ua.includes('Brave/') || ua.includes('Safari/')
  );
  return hasSecFetch && (hasClientHints || hasUpgrade || looksLikeBrowserUA);
}

// Merges the hardcoded AD_DOMAINS list with an optional user-editable
// ad-domains.txt in userData (one domain per line, # comments allowed).
// Lets power users add new ad networks without waiting for a release.
function _loadAdDomains(userData) {
  if (!userData) return AD_DOMAINS;
  const overridePath = path.join(userData, 'ad-domains.txt');
  if (!fs.existsSync(overridePath)) return AD_DOMAINS;
  try {
    const extra = fs.readFileSync(overridePath, 'utf8')
      .split('\n')
      .map(l => l.trim().toLowerCase())
      .filter(l => l && !l.startsWith('#'));
    const merged = [...new Set([...AD_DOMAINS, ...extra])];
    debugLog(`Ad domain list: ${AD_DOMAINS.length} built-in + ${extra.length} from ad-domains.txt = ${merged.length} total`);
    return merged;
  } catch (err) {
    logError(err);
    return AD_DOMAINS;
  }
}

function init(sendFn, showWindowFn, userData) {
  safeSend   = sendFn;
  showWindow = showWindowFn || (() => {});
  injectedScript   = fs.readFileSync(path.join(__dirname, 'injected.js'),  'utf8');
  injectedStyles   = fs.readFileSync(path.join(__dirname, 'injected.css'), 'utf8');
  _activeAdDomains = _loadAdDomains(userData);
}

function isAdRequest(host, urlStr) {
  if (!state.AD_BLOCKING_ENABLED) return false;
  if (AD_WHITELIST.some(w => host.includes(w))) return false;
  return _activeAdDomains.some(d => host.includes(d)) || AD_URL_RE.test(urlStr);
}

function extractNonce(cspHeader) {
  if (!cspHeader) return '';
  const csp = Array.isArray(cspHeader) ? cspHeader.join('; ') : String(cspHeader);
  const m = csp.match(/'nonce-([A-Za-z0-9+/=_-]+)'/);
  return m ? m[1] : '';
}

function processHtml(body, cspHeader) {
  let nonce = extractNonce(cspHeader);
  if (!nonce) {
    const m = body.match(/<script[^>]+nonce="([^"]+)"/i);
    if (m) nonce = m[1];
  }
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const patterns  = JSON.stringify(state.TRUSTED_PATTERNS || []);
  const configTag = `<script id="sf-config"${nonceAttr}>window.__sfTrustedPatterns=${patterns};</script>`;
  const styleTag  = `<style id="sf-styles"${nonceAttr}>${injectedStyles}</style>`;
  const scriptTag = `<script id="sf-script"${nonceAttr}>${injectedScript}</script>`;
  let result = body;
  const headClose = result.lastIndexOf('</head>');
  if (headClose !== -1) result = result.slice(0, headClose) + configTag + styleTag + result.slice(headClose);
  else result += configTag + styleTag;
  const bodyClose = result.lastIndexOf('</body>');
  if (bodyClose !== -1) result = result.slice(0, bodyClose) + scriptTag + result.slice(bodyClose);
  else result += scriptTag;
  return result;
}

async function start(certsDir) {
  if (proxyServer || !state.PROXY_ENABLED) return true;

  const caCertPath = path.join(certsDir, 'ca.pem');
  const caKeyPath  = path.join(certsDir, 'ca.key');

  try {
    if (!fs.existsSync(caCertPath) || !fs.existsSync(caKeyPath)) {
      debugLog('Generating CA certificate...');
      const ca = await mockttp.generateCACertificate({
        subject: { commonName: 'SlopProx', organizationName: 'SlopProx — AI Slop Filter Local CA' }
      });
      fs.writeFileSync(caCertPath, ca.cert);
      fs.writeFileSync(caKeyPath, ca.key);
      debugLog('CA certificate saved');
      safeSend('status-update', 'CA certificate installed');
    }

    // ── True TLS passthrough for bypass domains ───────────────────────────────
    // mockttp's tlsPassthrough option works at the raw socket level, BEFORE
    // any TLS handshake or cert exchange. For bypassed hosts, mockttp reads
    // the SNI from the ClientHello and creates a raw TCP tunnel instead of
    // doing MITM. The client negotiates TLS directly with the real server —
    // the SlopProx CA cert is never presented. This is the only correct way
    // to bypass cert rejection in Apps, IDEs, Games etc.
    const tlsPassthrough = (state.BYPASS_DOMAINS || [])
      .filter(d => !d.includes('*') && !/^\d/.test(d))
      .map(hostname => ({ hostname }));

    proxyServer = mockttp.getLocal({
      https: { certPath: caCertPath, keyPath: caKeyPath, tlsPassthrough },
      http2: false,
    });

    const OWN_PAC = `http://127.0.0.1:${PORT}/filter.pac`;
    const rawUpstream = detectUpstreamProxy();
    const safeUpstream = (rawUpstream && !rawUpstream.replace(/^pac\+/, '').startsWith(`http://127.0.0.1:${PORT}`))
      ? rawUpstream : null;
    if (safeUpstream) debugLog(`Upstream proxy detected: ${safeUpstream}`);

    await proxyServer.forAnyRequest().thenPassThrough({
      proxyConfig: safeUpstream ? {
        proxyUrl: safeUpstream,
        noProxy: ['localhost', '127.0.0.1', ...state.BYPASS_DOMAINS],
      } : undefined,
      beforeRequest: async (req) => {
        const urlStr = req.url || '';
        if (urlStr.endsWith('/filter.pac')) {
          const pacBody = pac.generatePAC(PORT, state.BYPASS_DOMAINS);
          return { response: { statusCode: 200, headers: { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-cache, no-store' }, body: pacBody } };
        }
        if (!isRealBrowserRequest(req)) return;
        if (urlStr.endsWith('/__slop_filter_classify') && req.method === 'POST') {
          try {
            const rawText = await req.body.getText();
            if (rawText.length > 50000) return { response: { statusCode: 413, headers: {}, body: '' } };
            const text = rawText.trim().replace(/\s+/g, ' ');
            if (text.length < config.get('textMinLength') || !state.FILTER_ENABLED) {
              return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"isSlop":false,"confidence":0}' } };
            }
            const { confidence, method } = await isAiSlop(text);
            const isSlop = confidence > config.get('textThreshold');
            debugLog(`Text/proxy [${isSlop ? 'SLOP' : 'real'} ${Math.round(confidence * 100)}% ${method}]: "${text.slice(0, 80)}"`);
            if (isSlop) { state.filteredCount++; safeSend('filter-count', state.filteredCount); counts.schedule(state); }
            let _host = urlStr; try { _host = new URL(urlStr).hostname; } catch (_) {}
            if (isSlop || Math.random() < 0.15) safeSend('classification-entry', { ts: Date.now(), type: 'text', outcome: isSlop ? 'blocked' : 'passed', target: _host, confidence: Math.round(confidence * 100) });
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
          counts.schedule(state);
          safeSend('classification-entry', { ts: Date.now(), type: 'youtube', outcome: 'blocked', target: 'youtube.com', confidence: null });
          debugLog(`YouTube AI-disclosed video blocked (#${state.youtubeBlocked})`);
          return { response: { statusCode: 204, headers: {} } };
        }
      },
      beforeResponse: async (response, req) => {
        if (!state.PROXY_ENABLED) return;
        const urlStr = req?.url || '';
        let host = '';
        try { host = new URL(urlStr).hostname.toLowerCase(); } catch (_) {}
        if (state.BYPASS_DOMAINS.some(d => {
          if (d.includes('*')) {
            const pattern = d.replace(/\./g, '\\.').replace(/\*/g, '.*');
            return new RegExp('^' + pattern + '$', 'i').test(host);
          }
          return host.includes(d);
        })) return;
        if (!isRealBrowserRequest(req)) return;
        if (isAdRequest(host, urlStr)) {
          state.adsBlocked++;
          safeSend('ads-count', state.adsBlocked);
          counts.schedule(state);
          safeSend('classification-entry', { ts: Date.now(), type: 'ad', outcome: 'blocked', target: host, confidence: null });
          debugLog(`Ad blocked: ${host}`);
          return { statusCode: 204, headers: {} };
        }
        const rawCT = response.headers?.['content-type'];
        const contentType = (Array.isArray(rawCT) ? rawCT[0] : rawCT || '').toLowerCase();
        if (!contentType.includes('text/html')) return;
        if (host === '127.0.0.1' || host === 'localhost') return;
        if (!state.FILTER_ENABLED) return;
        const reqHeaders = req?.headers || {};
        const fetchDest  = (reqHeaders['sec-fetch-dest'] || '').toLowerCase();
        const fetchMode  = (reqHeaders['sec-fetch-mode'] || '').toLowerCase();
        if (fetchDest && fetchMode && (fetchMode !== 'navigate' || fetchDest !== 'document')) return;
        try {
          if (req?.method && req.method !== 'GET') return;
          const body = await response.body.getText();
          if (!body || body.length < 1000 || body.length > 800000) return;
          debugLog(`Injecting into: ${host} (${body.length} bytes)`);
          const cspHeader = response.headers?.['content-security-policy'] || '';
          const modified  = processHtml(body, cspHeader);
          const headers = { ...response.headers };
          if (Array.isArray(headers['content-security-policy'])) headers['content-security-policy'] = headers['content-security-policy'].join('; ');
          delete headers['content-security-policy-report-only'];
          headers['cache-control'] = 'no-cache, no-store, must-revalidate';
          headers['pragma'] = 'no-cache';
          headers['expires'] = '0';
          headers['content-length'] = Buffer.byteLength(modified, 'utf8').toString();
          return { statusCode: response.statusCode, headers, body: modified };
        } catch (e) { logError(e); }
      }
    });

    let _noiseCount = 0;
    let _noiseLastLog = 0;
    const _suppressBenign = () => {
      _noiseCount++;
      const now = Date.now();
      if (now - _noiseLastLog < 300000) return;
      const mins = _noiseLastLog ? Math.round((now - _noiseLastLog) / 60000) : '?';
      debugLog(`[TLS noise] ${_noiseCount} background TLS rejections in last ${mins}m — non-browser apps rejecting MITM CA cert (expected)`);
      _noiseCount = 0;
      _noiseLastLog = now;
    };

    proxyServer.on('tls-client-error', (failure) => {
      const hostname = failure?.tlsMetadata?.sniHostname || failure?.sniHostname || failure?.host || 'unknown-host';
      // Already bypassed — TLS errors here are expected in-flight noise, don't re-prompt
      if (state.BYPASS_DOMAINS.includes(hostname)) return;
      const errStr = JSON.stringify(failure);
      debugLog(`[TLS ERROR] Host: ${hostname} | Raw Error: ${errStr}`);
      // Two failure modes for cert rejection:
      // 1. TLS alert (OpenSSL error string present) — explicit rejection
      // 2. "closed" after handshakeTimestamp — client saw our CA cert and silently closed
      //    (common with Apps, IDEs, Games etc.)
      const handshakeFailed = failure?.timingEvents?.handshakeTimestamp !== undefined;
      // Some apps don't send a TLS alert — they open the CONNECT tunnel then TCP-reset
      // before the handshake completes (no handshakeTimestamp). Treat this as a cert rejection.
      const silentReset = failure?.timingEvents?.tunnelTimestamp !== undefined
        && failure?.timingEvents?.handshakeTimestamp === undefined
        && failure?.failureCause === 'reset';
      const isCertError = handshakeFailed || silentReset || /certificate|CERT|SSLV3_ALERT|alert certificate unknown|UNABLE_TO_GET_ISSUER/i.test(errStr);
      if (isCertError) {
        const now = Date.now();
        const last = recentSuggestions.get(hostname) || 0;
        if (now - last > 15000) {
          recentSuggestions.set(hostname, now);
          debugLog(`[TLS ERROR] Certificate error detected for ${hostname} — sending suggest-bypass toast`);
          showWindow();
          safeSend('suggest-bypass', {
            hostname: hostname,
            reason: 'Certificate validation failed (common with Apps, IDEs, Games etc.)'
          });
        } else {
          debugLog(`[TLS] Suppressed duplicate toast for ${hostname}`);
        }
      } else {
        // Only count as background noise if it's not a cert rejection we're handling
        _suppressBenign();
      }
    });

    proxyServer.on('request-error', _suppressBenign);
    proxyServer.on('client-error', _suppressBenign);

    await proxyServer.start(PORT);
    debugLog(`Proxy started on port ${PORT}`);
    safeSend('status-update', 'AI Slop Filter is running');
    safeSend('proxy-status', true);
    return true;

  } catch (err) {
    proxyServer = null;
    const message = err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use — close the conflicting application and try again`
      : (err.message || String(err));
    logError(err.code === 'EADDRINUSE' ? new Error(`Port ${PORT} is already in use`) : err);
    safeSend('proxy-start-failed', { code: err.code || 'UNKNOWN', message });
    return false;
  }
}

async function stop() {
  if (proxyServer) {
    await proxyServer.stop().catch(() => {});
    proxyServer = null;
  }
  safeSend('proxy-status', false);
}

module.exports = { init, start, stop, PORT };