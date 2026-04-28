// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, Notification } = require('electron');
const { execSync, execFile } = require('child_process');
const path = require('path');
const fs   = require('fs');

const { autoUpdater }  = require('electron-updater');
const logger           = require('./logger');
const state            = require('./state');
const counts           = require('./counts');
const classifier       = require('./classifier');
const proxy            = require('./proxy');
const service          = require('./service');

process.on('uncaughtException',  err => logger.logError(err));
process.on('unhandledRejection', err => logger.logError(err));

// ── Single-instance lock ──────────────────────────────────────────
// A second launch (e.g. clicking the installer shortcut while already running)
// just focuses the existing window and exits — prevents port conflicts on 8081/8083.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Suppress mockttp's own console.error for TLS handshake failures — our
// tls-client-error handler already logs these via debugLog with proper context.
// Without this, every cert rejection prints a raw Error object to the console
// in addition to our formatted [TLS ERROR] line (duplicate noise).
const _origConsoleError = console.error.bind(console);
console.error = (...args) => {
  const first = String(args[0] ?? '');
  if (/^Unknown TLS error:/i.test(first)) return;
  _origConsoleError(...args);
};

// ── Settings ──────────────────────────────────────────────────────
// Persists only user-controlled preferences — NOT runtime counters or state.
const SETTINGS_DEFAULTS = {
  launchAtStartup:       false,
  minimizeToTray:        true,
  defaultTextFilter:     true,
  defaultAdBlocker:      true,
  defaultImageDetection: false,
  defaultYoutubeFilter:  true,
  imageModelsReady:      false,
  PROXY_ENABLED:   false,
  BYPASS_DOMAINS:  state.BYPASS_DOMAINS.slice(),
};

function _settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }

function _loadSettings() {
  try { return JSON.parse(fs.readFileSync(_settingsPath(), 'utf8')); } catch { return {}; }
}

function _saveSettings(patch) {
  try {
    const current = _loadSettings();
    fs.writeFileSync(_settingsPath(), JSON.stringify({ ...current, ...patch }, null, 2));
  } catch (err) { logger.logError(err); }
}

function _getSettings() {
  const saved = _loadSettings();
  // Auto-migrate: if imageModelsReady was never persisted but the model file
  // is already on disk (installed before the settings system existed), mark ready.
  if (!saved.imageModelsReady) {
    const modelFile = path.join(__dirname, 'models', 'ai-source-detector-onnx', 'onnx', 'model_quantized.onnx');
    if (fs.existsSync(modelFile)) {
      saved.imageModelsReady = true;
      _saveSettings({ imageModelsReady: true });
    }
  }
  return { ...SETTINGS_DEFAULTS, ...saved };
}

// ── App-level vars ────────────────────────────────────────────────
let mainWindow      = null;
let logWindow       = null;
let tray            = null;
let isQuitting      = false;
let _minimizeToTray = true;
let certsDir        = null;
let caCertPath      = null;
let extDestPath     = null; // set after installExtension; used by open-extension-folder

// ── IPC send helper ───────────────────────────────────────────────
function safeSend(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, ...args);
}

// ── System proxy (PAC file) ───────────────────────────────────────
function setSystemProxy(enabled) {
  const pacUrl = `http://127.0.0.1:${proxy.PORT}/filter.pac`;
  try {
    if (enabled) {
      execSync(
        `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL /t REG_SZ /d "${pacUrl}" /f` +
        ` && reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
        { windowsHide: true }
      );
      logger.debugLog(`System proxy set to PAC: ${pacUrl}`);
    } else {
      execSync(
        `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL /f 2>nul` +
        ` & reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
        { windowsHide: true }
      );
      logger.debugLog('System proxy cleared');
    }
  } catch (err) { logger.logError(err); }
}

// ── Certificate installation ──────────────────────────────────────
function installCert() {
  logger.debugLog('Installing CA certificate...');
  safeSend('status-update', 'Installing certificate...');
  const ps = `Import-Certificate -FilePath '${caCertPath}' -CertStoreLocation Cert:\\CurrentUser\\Root -Confirm:$false`;
  execFile('powershell.exe', ['-Command', ps], { windowsHide: true }, err => {
    if (err) {
      logger.logError(err);
      safeSend('status-update', 'Cert install failed — click Reinstall Cert to retry');
      safeSend('cert-ready', false);
    } else {
      safeSend('status-update', 'SlopProx is running');
      safeSend('cert-ready', true);
    }
  });
}

// ── Extension management ──────────────────────────────────────────
// Browsers supported for opening the extensions management page.
const BROWSER_MAP = [
  ['Brave',   'brave.exe',   'brave://extensions'],
  ['Chrome',  'chrome.exe',  'chrome://extensions'],
  ['Edge',    'msedge.exe',  'edge://extensions'],
  ['Vivaldi', 'vivaldi.exe', 'vivaldi://extensions'],
  ['Opera',   'opera.exe',   'opera://extensions'],
  ['Firefox', 'firefox.exe', 'about:debugging#/runtime/this-firefox'],
];

const BROWSER_PATHS = {
  'brave.exe':   [
    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
  'chrome.exe':  [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  'msedge.exe':  ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  'vivaldi.exe': [path.join(process.env.LOCALAPPDATA || '', 'Vivaldi', 'Application', 'vivaldi.exe')],
  'opera.exe':   [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Opera', 'opera.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Opera GX', 'opera.exe'),
  ],
};

function openBrowserExtensionsPage(callback) {
  for (const [, exe, url] of BROWSER_MAP) {
    const paths = BROWSER_PATHS[exe] || [];
    const found = paths.find(p => fs.existsSync(p));
    if (found) {
      execFile(found, [url], { windowsHide: false }, err => {
        if (err) logger.debugLog(`Failed to open ${exe}: ${err.message}`);
      });
      return callback(null);
    }
  }
  // Fallback: try shell.openExternal with chrome://extensions (works for default browser)
  shell.openExternal('chrome://extensions').catch(() => {});
  callback(null);
}

function getExtDestPath() {
  return path.join(app.getPath('userData'), 'extension');
}

function isExtensionInstalled() {
  const dest = extDestPath || getExtDestPath();
  return fs.existsSync(path.join(dest, 'manifest.json'));
}

function installExtension() {
  try {
    const dest = getExtDestPath();
    extDestPath = dest;
    fs.cpSync(path.join(__dirname, 'extension'), dest, { recursive: true, force: true });
    logger.debugLog(`Extension copied to: ${dest}`);

    openBrowserExtensionsPage(err => {
      if (err) logger.logError(err);
      safeSend('extension-install-ready', dest);
      safeSend('extension-installed', isExtensionInstalled());
    });
  } catch (err) {
    logger.logError(err);
    safeSend('status-update', 'Extension copy failed — see debug log');
  }
}

// ── Image model loading ───────────────────────────────────────────
function _startImageModelLoad() {
  classifier.loadImageModel(
    msg => safeSend('status-update', msg),
    prog => {
      safeSend('image-model-progress', prog);
      if (prog.done) {
        _saveSettings({ imageModelsReady: true });
        const active = prog.loaded;
        if (Notification.isSupported()) {
          new Notification({
            title: 'Image Detection Ready',
            body: `${active}-model ensemble active — AI image detection is running`,
            icon: path.join(__dirname, 'icon.png'),
          }).show();
        }
        safeSend('status-update', `Image detection ready — ${active}-model ensemble active`);
      }
    }
  );
}

// ── Tray ──────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state.PROXY_ENABLED ? 'Proxy: ON' : 'Proxy: OFF', enabled: false },
    { type: 'separator' },
    { label: 'Show Dashboard', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: state.PROXY_ENABLED ? 'Pause Proxy' : 'Resume Proxy', click: toggleProxy },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// ── Feature toggles ───────────────────────────────────────────────
async function toggleProxy() {
  state.PROXY_ENABLED = !state.PROXY_ENABLED;
  if (state.PROXY_ENABLED) {
    proxy.start(certsDir);
    setSystemProxy(true);
  } else {
    await proxy.stop();
    // Small delay to let connections close before clearing system proxy
    setTimeout(() => setSystemProxy(false), 500);
  }
  _saveSettings({ PROXY_ENABLED: state.PROXY_ENABLED });
  safeSend('proxy-status', state.PROXY_ENABLED);
  updateTray();
  logger.debugLog(`Proxy ${state.PROXY_ENABLED ? 'enabled' : 'disabled'}`);
}

function toggleImageDetection() {
  state.IMAGE_DETECTION_ENABLED = !state.IMAGE_DETECTION_ENABLED;
  safeSend('image-detection-status', state.IMAGE_DETECTION_ENABLED);
  logger.debugLog(`Image detection ${state.IMAGE_DETECTION_ENABLED ? 'enabled' : 'disabled'}`);
  if (state.IMAGE_DETECTION_ENABLED && !classifier.isImageModelReady())
    _startImageModelLoad();
}

// ── Auto-updater ──────────────────────────────────────────────────
autoUpdater.autoDownload             = true;
autoUpdater.autoInstallOnAppQuit     = false;
autoUpdater.allowPrerelease          = true;

autoUpdater.on('update-available', info => {
  logger.debugLog(`Update available: v${info.version}`);
  safeSend('update-available', info.version);
});
autoUpdater.on('download-progress', prog => {
  safeSend('update-progress', Math.round(prog.percent));
});
autoUpdater.on('update-downloaded', info => {
  logger.debugLog(`Update downloaded: v${info.version}`);
  safeSend('update-ready', info.version);
});
autoUpdater.on('error', err => {
  const msg = err?.message ?? '';
  // A 404 from GitHub's releases API simply means no release has been published yet —
  // treat it as "no update available" rather than a real error.
  if (msg.includes('404') || msg.includes('Unable to find latest version')) {
    logger.debugLog('Updater: no release found on GitHub — up to date');
  } else {
    logger.debugLog(`Updater error: ${msg}`);
  }
});

// ── Window ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560, height: 720,
    frame: false, resizable: false,
    backgroundColor: '#080d09',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);

  mainWindow.webContents.once('did-finish-load', () => {
    // Send all initial state to the renderer
    safeSend('filter-status',          state.FILTER_ENABLED);
    safeSend('adblock-status',         state.AD_BLOCKING_ENABLED);
    safeSend('image-detection-status', state.IMAGE_DETECTION_ENABLED);
    safeSend('youtube-filter-status',  state.YOUTUBE_FILTER_ENABLED);
    safeSend('proxy-status',           state.PROXY_ENABLED);
    safeSend('filter-count',           state.filteredCount);
    safeSend('ads-count',              state.adsBlocked);
    safeSend('images-count',           state.imagesBlocked);
    safeSend('youtube-count',          state.youtubeBlocked);
    safeSend('extension-installed',    isExtensionInstalled());
    safeSend('settings-loaded',        _getSettings());
    safeSend('bypass-domains',         { list: state.BYPASS_DOMAINS, protected: state.BYPASS_DOMAINS_PROTECTED });

    if (state.IMAGE_DETECTION_ENABLED && !classifier.isImageModelReady())
      _startImageModelLoad();

    // Proxy-off case: nothing else sends cert-ready, so fire it here once the
    // renderer is guaranteed to be listening. Proxy-on case is handled by installCert().
    if (!state.PROXY_ENABLED)
      setTimeout(() => safeSend('cert-ready', true), 100);

    if (app.isPackaged)
      setTimeout(() => autoUpdater.checkForUpdates().catch(err => logger.debugLog(`Auto-update check failed: ${err?.message}`)), 5000);
  });

  mainWindow.on('close', e => {
    if (!isQuitting && _minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    } else {
      isQuitting = true;
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      event.preventDefault();
      mainWindow.webContents.openDevTools();
    }
  });
}

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  logger.init(userData);
  counts.init(userData);

  // Load and apply persisted settings
  const settings = _getSettings();
  _minimizeToTray                = settings.minimizeToTray;
  state.FILTER_ENABLED           = settings.defaultTextFilter;
  state.AD_BLOCKING_ENABLED      = settings.defaultAdBlocker;
  state.IMAGE_DETECTION_ENABLED  = settings.defaultImageDetection
    && settings.imageModelsReady
    && isExtensionInstalled();
  state.YOUTUBE_FILTER_ENABLED   = settings.defaultYoutubeFilter;
  state.PROXY_ENABLED            = settings.PROXY_ENABLED;
  state.BYPASS_DOMAINS           = settings.BYPASS_DOMAINS || state.BYPASS_DOMAINS;
  app.setLoginItemSettings({ openAtLogin: settings.launchAtStartup, openAsHidden: true });

  // Seed in-memory counters from persisted all-time totals
  const savedCounts       = counts.load();
  state.filteredCount     = savedCounts.filteredCount  || 0;
  state.adsBlocked        = savedCounts.adsBlocked     || 0;
  state.imagesBlocked     = savedCounts.imagesBlocked  || 0;
  state.youtubeBlocked    = savedCounts.youtubeBlocked || 0;

  // Always sync extension source → userData on launch so CSS/JS updates are live
  try {
    const extDest = getExtDestPath();
    if (fs.existsSync(path.join(extDest, 'manifest.json'))) {
      fs.cpSync(path.join(__dirname, 'extension'), extDest, { recursive: true, force: true });
      logger.debugLog('Extension files synced to userData');
    }
  } catch (e) { logger.logError(e); }

  certsDir   = path.join(userData, 'certs');
  caCertPath = path.join(certsDir, 'ca.pem');
  if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

  // Set transformers cache directory so HuggingFace models land in userData
  const cacheDir = path.join(userData, 'transformers-cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  process.env.TRANSFORMERS_CACHE = cacheDir;

  createWindow();

  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('SlopProx — AI Slop Filter');
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
  updateTray();

  proxy.init(safeSend, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.flashFrame(true);
    }
  });

  if (state.PROXY_ENABLED) {
    await proxy.start(certsDir);
    setSystemProxy(true);
    setTimeout(installCert, 1500); // small delay so proxy is listening before cert prompt
  }

  service.start(safeSend);
  classifier.loadModel(msg => safeSend('status-update', msg));
});

// ── IPC handlers ──────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close',   () => {
  if (_minimizeToTray && !isQuitting) { mainWindow?.hide(); }
  else { isQuitting = true; app.quit(); }
});

ipcMain.on('toggle-filter',          () => {
  state.FILTER_ENABLED = !state.FILTER_ENABLED;
  safeSend('filter-status', state.FILTER_ENABLED);
  logger.debugLog(`Text filter ${state.FILTER_ENABLED ? 'on' : 'off'}`);
});
ipcMain.on('toggle-adblock',         () => {
  state.AD_BLOCKING_ENABLED = !state.AD_BLOCKING_ENABLED;
  safeSend('adblock-status', state.AD_BLOCKING_ENABLED);
  logger.debugLog(`Ad blocker ${state.AD_BLOCKING_ENABLED ? 'on' : 'off'}`);
});
ipcMain.on('toggle-image-detection', toggleImageDetection);
ipcMain.on('toggle-youtube-filter',  () => {
  state.YOUTUBE_FILTER_ENABLED = !state.YOUTUBE_FILTER_ENABLED;
  safeSend('youtube-filter-status', state.YOUTUBE_FILTER_ENABLED);
  logger.debugLog(`YouTube filter ${state.YOUTUBE_FILTER_ENABLED ? 'on' : 'off'}`);
});
ipcMain.on('toggle-proxy',           toggleProxy);

ipcMain.on('reinstall-cert', installCert);

ipcMain.on('install-extension',     installExtension);
ipcMain.on('open-extension-folder', () => {
  const dest = extDestPath || getExtDestPath();
  if (fs.existsSync(dest)) shell.showItemInFolder(dest);
  else shell.openPath(path.join(__dirname, 'extension'));
});

ipcMain.on('reset-all', () => {
  state.filteredCount  = 0;
  state.adsBlocked     = 0;
  state.imagesBlocked  = 0;
  state.youtubeBlocked = 0;
  counts.flush(state);
  safeSend('filter-count',  0);
  safeSend('ads-count',     0);
  safeSend('images-count',  0);
  safeSend('youtube-count', 0);
  safeSend('status-update', 'Counters reset');
});

function openLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) { logWindow.show(); logWindow.focus(); return; }
  logWindow = new BrowserWindow({
    width: 900, height: 600,
    minWidth: 680, minHeight: 420,
    frame: false, resizable: true,
    backgroundColor: '#000000',
    title: 'SlopProx — Debug Console',
    webPreferences: {
      preload: path.join(__dirname, 'preload-log.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  logWindow.loadFile('log-viewer.html');
  logWindow.setMenu(null);

  const logSub = (entry) => {
    if (logWindow && !logWindow.isDestroyed())
      logWindow.webContents.send('log-line', entry);
  };
  logger.subscribe(logSub);

  logWindow.webContents.once('did-finish-load', () => {
    logWindow.webContents.send('log-history', logger.getBuffer());
    logWindow.webContents.send('app-version', app.getVersion());
  });
  logWindow.on('closed', () => { logger.unsubscribe(logSub); logWindow = null; });
}

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.on('open-debug-log',       openLogWindow);
ipcMain.on('log-window-close',     () => logWindow?.close());
ipcMain.on('log-window-minimize',  () => logWindow?.minimize());

ipcMain.on('open-external', (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

const _ALLOWED_SETTINGS = new Set(['launchAtStartup', 'minimizeToTray', 'PROXY_ENABLED', 'soundEnabled', 'filterEnabled', 'imageDetectionEnabled', 'youtubeFilterEnabled', 'autoStart']);
ipcMain.on('set-setting', (_, { key, value }) => {
  if (!key || !_ALLOWED_SETTINGS.has(key)) return;
  _saveSettings({ [key]: value });
  if (key === 'launchAtStartup') app.setLoginItemSettings({ openAtLogin: !!value, openAsHidden: true });
  if (key === 'minimizeToTray')  _minimizeToTray = !!value;
  if (key === 'PROXY_ENABLED')   state.PROXY_ENABLED = !!value;
});

ipcMain.on('install-update', () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

ipcMain.on('check-for-updates', () => {
  logger.debugLog('Manual update check requested');

  if (!app.isPackaged) {
    // In development mode, skip actual check and immediately report no updates
    logger.debugLog('Development mode: skipping update check');
    safeSend('update-check-complete', { available: false, currentVersion: app.getVersion() });
    logger.debugLog('Sent update-check-complete in dev mode');
    return;
  }

  safeSend('update-check-start');

  autoUpdater.checkForUpdates()
    .then(result => {
      // cancellationToken is only non-null when an update is available and actively downloading.
      // updateInfo is always present (even when up-to-date), so it can't be used as the check.
      if (result && result.cancellationToken != null) {
        logger.debugLog(`Update available: v${result.updateInfo.version}`);
        // update-available event already fired and showed the banner;
        // send complete so the manual-check button is re-enabled
        safeSend('update-check-complete', { available: true, currentVersion: app.getVersion() });
      } else {
        logger.debugLog('No updates available');
        safeSend('update-check-complete', { available: false, currentVersion: app.getVersion() });
      }
    })
    .catch(error => {
      const msg = error?.message ?? '';
      // 404 = no release published yet — treat as up-to-date, not an error
      if (msg.includes('404') || msg.includes('Unable to find latest version')) {
        logger.debugLog('Manual update check: no release on GitHub — up to date');
        safeSend('update-check-complete', { available: false, currentVersion: app.getVersion() });
      } else {
        logger.logError(error);
        safeSend('update-check-error', msg || 'Failed to check for updates');
      }
    });
});

const _HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
ipcMain.on('add-bypass', (_, hostname) => {
  if (!hostname || hostname === 'unknown-host') return;
  const cleanHost = hostname.toLowerCase().trim();
  if (!_HOSTNAME_RE.test(cleanHost)) return;
  if (state.BYPASS_DOMAINS.includes(cleanHost)) return;
  state.BYPASS_DOMAINS.push(cleanHost);
  _saveSettings({ BYPASS_DOMAINS: state.BYPASS_DOMAINS });
  safeSend('bypass-domains', { list: state.BYPASS_DOMAINS, protected: state.BYPASS_DOMAINS_PROTECTED });
  logger.debugLog(`Added to bypass: ${cleanHost}`);
  proxy.stop();
  setTimeout(async () => {
    await proxy.start(certsDir);
    setSystemProxy(true); // re-write PAC URL to force WinINet to re-fetch with updated DIRECT entries
    safeSend('status-update', `Bypass added for ${cleanHost}`);
    if (Notification.isSupported()) {
      new Notification({
        title: 'Bypass added — action required',
        body: `${cleanHost} is now bypassed. Reload the page in your browser, or restart the app that was blocked.`,
        icon: path.join(__dirname, 'icon.png'),
      }).show();
    }
  }, 800);
});

ipcMain.on('remove-bypass', (_, hostname) => {
  if (!hostname) return;
  const cleanHost = hostname.toLowerCase().trim();
  if (state.BYPASS_DOMAINS_PROTECTED.includes(cleanHost)) return; // system domain — not removable
  const idx = state.BYPASS_DOMAINS.indexOf(cleanHost);
  if (idx === -1) return;
  state.BYPASS_DOMAINS.splice(idx, 1);
  _saveSettings({ BYPASS_DOMAINS: state.BYPASS_DOMAINS });
  safeSend('bypass-domains', { list: state.BYPASS_DOMAINS, protected: state.BYPASS_DOMAINS_PROTECTED });
  logger.debugLog(`Removed from bypass: ${cleanHost}`);
  proxy.stop();
  setTimeout(async () => {
    await proxy.start(certsDir);
    setSystemProxy(true); // re-fetch PAC so the host routes through proxy again
    safeSend('status-update', `Bypass removed — reopen ${cleanHost} to apply`);
  }, 800);
});

// ── Quit ──────────────────────────────────────────────────────────
app.on('before-quit', () => { isQuitting = true; });

app.on('will-quit', () => {
  // Remove system proxy on clean exit so the browser doesn't get stuck
  try { setSystemProxy(false); } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
