// Single HTTP service: POST /classify, POST /classify-image, GET /status
// Port 8083, localhost only.

const http = require('http');
const { isAiSlop, isAiImage } = require('./classifier');
const { debugLog, logError } = require('./logger');
const state = require('./state');

const PORT = 8083;
let server = null;

function start(safeSend) {
  if (server) return;

  server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return;
    }

    // ── GET /status ────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        enabled: state.FILTER_ENABLED,
        imageDetectionEnabled: state.IMAGE_DETECTION_ENABLED,
        youtubeFilterEnabled: state.YOUTUBE_FILTER_ENABLED,
      }));
      return;
    }

    // ── POST /youtube-block ────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/youtube-block') {
      state.youtubeBlocked++;
      safeSend('youtube-count', state.youtubeBlocked);
      debugLog(`YouTube AI-disclosed video blocked (#${state.youtubeBlocked})`);
      res.writeHead(204); res.end();
      return;
    }

    // ── POST /classify ─────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/classify') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 50_000) { req.destroy(); return; }
      });
      req.on('end', async () => {
        if (res.destroyed) return;
        const text = body.trim();

        if (text.length < 50 || !state.FILTER_ENABLED) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ isSlop: false, confidence: 0 }));
          return;
        }

        try {
          const { confidence, method } = await isAiSlop(text);
          const isSlop = confidence > 0.38;
          debugLog(`Text [${isSlop ? 'SLOP' : 'real'} ${Math.round(confidence * 100)}% ${method}]: "${text.slice(0, 80).replace(/\n/g, ' ')}"`);
          if (isSlop) {
            state.filteredCount++;
            safeSend('filter-count', state.filteredCount);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ isSlop, confidence: Math.round(confidence * 100), method }));
        } catch (err) {
          logError(err);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ isSlop: false, confidence: 0 }));
        }
      });
      return;
    }

    // ── POST /classify-image ───────────────────────────────────────
    // Body: the image's src URL (sent by the extension content script).
    // Node.js fetches the URL directly — avoids all CORS/canvas-taint issues.
    if (req.method === 'POST' && req.url === '/classify-image') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 4096) { req.destroy(); return; } // URL is short
      });
      req.on('end', async () => {
        if (res.destroyed) return;

        const imageUrl = body.trim();
        const ok = (u) => u.startsWith('http://') || u.startsWith('https://');

        if (!imageUrl || !ok(imageUrl) || !state.FILTER_ENABLED || !state.IMAGE_DETECTION_ENABLED) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ isAiImage: false, confidence: 0 }));
          return;
        }

        try {
          const score  = await isAiImage(imageUrl);
          const isAi   = score > 0.95; // combined score: aiScore*(1-realScore) — false positives cluster at ≤93%, confirmed AI art at 96–100%
          if (isAi) {
            state.imagesBlocked++;
            safeSend('images-count', state.imagesBlocked);
          }
          debugLog(`Image [${isAi ? 'AI' : 'real'} ${Math.round(score * 100)}%]: ${imageUrl.slice(0, 80)}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ isAiImage: isAi, confidence: Math.round(score * 100), method: 'model' }));
        } catch (err) {
          logError(err);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ isAiImage: false, confidence: 0 }));
        }
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') logError(new Error(`Port ${PORT} already in use — service failed to start`));
    else logError(err);
  });

  server.listen(PORT, '127.0.0.1', () => debugLog(`Service running on http://127.0.0.1:${PORT}`));
}

function stop() {
  server?.close();
  server = null;
}

module.exports = { start, stop };
