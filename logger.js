// logger.js — no electron dependency.

// main.js must call logger.init(app.getPath('userData')) before the app starts.
// Falls back to console-only if init() hasn't been called yet.
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Per-session random salt — regenerated each run so URL hashes cannot be
// reverse-engineered via rainbow table even if log files are shared.
const _LOG_SALT = crypto.randomBytes(16).toString('hex');

let debugLogPath = null;
let errorLogPath = null;
const _lastRotateCheck = {};

// In-memory ring buffer for the live log viewer window
const _ringBuffer    = [];
const _MAX_RING      = 500;
const _logSubscribers = new Set();

function _pushEntry(entry) {
  _ringBuffer.push(entry);
  if (_ringBuffer.length > _MAX_RING) _ringBuffer.shift();
  for (const fn of _logSubscribers) { try { fn(entry); } catch (_) {} }
}

function init(userDataPath) {
  debugLogPath = path.join(userDataPath, 'debug.log');
  errorLogPath = path.join(userDataPath, 'crash.log');
  // Rotate logs if >10MB
  rotateIfNeeded(debugLogPath, 10 * 1024 * 1024);
  rotateIfNeeded(errorLogPath, 10 * 1024 * 1024);
}

function rotateIfNeeded(filePath, maxSize) {
  const now = Date.now();
  if (_lastRotateCheck[filePath] && now - _lastRotateCheck[filePath] < 60000) return;
  _lastRotateCheck[filePath] = now;
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > maxSize) {
    const backup = filePath + '.old';
    fs.renameSync(filePath, backup);
  }
}

function debugLog(msg) {
  const anonymized = msg.replace(/https?:\/\/[^ \t\r\n]+/g, url => {
    const hash = crypto.createHash('sha256').update(_LOG_SALT + url).digest('hex').slice(0, 8);
    return `http://[redacted-${hash}]`;
  });
  const ts = new Date().toISOString();
  console.log('[DEBUG]', anonymized);
  const entry = { ts, level: 'debug', msg: anonymized };
  _pushEntry(entry);
  if (debugLogPath) {
    fs.appendFileSync(debugLogPath, `${ts} | ${anonymized}\n`);
    rotateIfNeeded(debugLogPath, 10 * 1024 * 1024);
  }
}

function logError(err) {
  const anonymized = (err.stack || err.toString()).replace(/https?:\/\/[^ \t\r\n]+/g, url => {
    const hash = crypto.createHash('sha256').update(_LOG_SALT + url).digest('hex').slice(0, 8);
    return `http://[redacted-${hash}]`;
  });
  const ts = new Date().toISOString();
  console.error(anonymized);
  const entry = { ts, level: 'error', msg: anonymized };
  _pushEntry(entry);
  if (errorLogPath) {
    fs.appendFileSync(errorLogPath, `${ts} | ${anonymized}\n`);
    rotateIfNeeded(errorLogPath, 10 * 1024 * 1024);
  }
}

module.exports = {
  init,
  debugLog,
  logError,
  subscribe:   (fn) => _logSubscribers.add(fn),
  unsubscribe: (fn) => _logSubscribers.delete(fn),
  getBuffer:   ()   => [..._ringBuffer],
  get debugLogPath() { return debugLogPath; },
};
