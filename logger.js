// logger.js — no electron dependency.
// main.js must call logger.init(app.getPath('userData')) before the app starts.
// Falls back to console-only if init() hasn't been called yet.
const fs = require('fs');
const path = require('path');

let debugLogPath = null;
let errorLogPath = null;

function init(userDataPath) {
  debugLogPath = path.join(userDataPath, 'debug.log');
  errorLogPath = path.join(userDataPath, 'crash.log');
}

function debugLog(msg) {
  console.log('[DEBUG]', msg);
  if (debugLogPath) fs.appendFileSync(debugLogPath, `${new Date().toISOString()} | ${msg}\n`);
}

function logError(err) {
  console.error(err);
  if (errorLogPath) fs.appendFileSync(errorLogPath, `${new Date().toISOString()} | ${err.stack || err}\n`);
}

module.exports = {
  init,
  debugLog,
  logError,
  get debugLogPath() { return debugLogPath; },
};
