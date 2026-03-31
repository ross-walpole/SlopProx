const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, clipboard } = require('electron');
const { exec, execSync, execFile } = require('child_process');
const path = require('path');
const fs   = require('fs');

const logger     = require('./logger');
const state      = require('./state');
const classifier = require('./classifier');
const proxy      = require('./proxy');
const service    = require('./service');

process.on('uncaughtException',  err => logger.logError(err));
process.on('unhandledRejection', err => logger.logError(err));

let mainWindow   = null;
let tray         = null;
let isQuitting   = false;
let certsDir     = null;
let caCertPath   = null;
let activePacUrl = null;
let extDestPath  = null; // set after installExtension; used by open-extension-folder

// ── IPC send helper ──────────────────────────────────────────────
function safeSend(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// ── System proxy (Windows) ───────────────────────────────────────
function setSystemProxy(enable) {
  if (!enable) {
    const cmd =
      `netsh winhttp reset proxy & ` +
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f & ` +
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL /t REG_SZ /d "" /f`;
    exec(cmd, { windowsHide: true }, err => {
      if (err) logger.logError(err);
      else logger.debugLog('System proxy disabled');
    });
    return;
  }

  if (activePacUrl) {
    const cmd =
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL /t REG_SZ /d "${activePacUrl}" /f & ` +
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f & ` +
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "127.0.0.1;localhost;<local>" /f`;
    exec(cmd, { windowsHide: true }, err => {
      if (err) logger.logError(err);
      else logger.debugLog(`System PAC proxy enabled: ${activePacUrl}`);
    });
    return;
  }

  const addr = `127.0.0.1:${proxy.PORT}`;
  const cmd =
    `netsh winhttp set proxy ${addr} "<local>" & ` +
    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d ${addr} /f & ` +
    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f & ` +
    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "127.0.0.1;localhost;<local>" /f`;
  exec(cmd, { windowsHide: true }, err => {
    if (err) logger.logError(err);
    else logger.debugLog(`System proxy enabled: ${addr}`);
  });
}

// ── Certificate installation ─────────────────────────────────────
function installCert() {
  logger.debugLog('Installing CA certificate...');
  safeSend('status-update', 'Installing CA certificate...');
  const ps = `Import-Certificate -FilePath '${caCertPath}' -CertStoreLocation Cert:\\CurrentUser\\Root -Confirm:$false`;
  execFile('powershell.exe', ['-Command', ps], { windowsHide: true }, err => {
    if (err) {
      logger.logError(err);
      safeSend('status-update', 'Auto-install failed — manual cert setup may be needed');
      safeSend('cert-ready', false);
    } else {
      safeSend('status-update', 'AI Slop Filter is running');
      safeSend('cert-ready', true);
    }
  });
}

// ── Extension helpers ────────────────────────────────────────────
function getExtDestPath() {
  return path.join(app.getPath('userData'), 'extension');
}

function isExtensionInstalled() {
  return fs.existsSync(path.join(getExtDestPath(), '.installed'));
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Opens the user's default Chromium-based browser to its extensions page.
//
// Exe lookup order (stops at first hit):
//  1. ProgId open command in HKCU\SOFTWARE\Classes  — most authoritative; this
//     is exactly what Windows uses when you click an https link.
//  2. ProgId open command in HKLM\SOFTWARE\Classes  — system-wide fallback.
//  3. HKCU App Paths                                — per-user installs (Brave, Vivaldi, Opera).
//  4. HKLM App Paths                                — system-wide installs (Edge, some Chrome).
//  5. Well-known LOCALAPPDATA / Program Files paths — last resort for common browsers.

const BROWSER_MAP = [
  // [ProgId fragment, exe name, extensions URL]
  ['BraveHTML',    'brave.exe',    'chrome://extensions'],  // Brave supports chrome:// alias
  ['ChromeHTML',   'chrome.exe',   'chrome://extensions'],
  ['MSEdgeHTM',    'msedge.exe',   'edge://extensions'],
  ['OperaStable',  'opera.exe',    'opera://extensions'],
  ['OperaGX',      'opera.exe',    'opera://extensions'],
  ['VivaldiHTML',  'vivaldi.exe',  'vivaldi://extensions'],
  ['ChromiumHTM',  'chromium.exe', 'chromium://extensions'],
  ['WaterfoxHTML', null, null], // Firefox-based — not compatible
  ['FirefoxHTML',  null, null], // Firefox-based — not compatible
];

const BROWSER_COMMON_PATHS = {
  'brave.exe':    [
    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
  'chrome.exe':   [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  'msedge.exe':   [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  'vivaldi.exe':  [
    path.join(process.env.LOCALAPPDATA || '', 'Vivaldi', 'Application', 'vivaldi.exe'),
  ],
  'opera.exe':    [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Opera', 'opera.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Opera GX', 'opera.exe'),
  ],
};

// Resolve the full exe path for a browser using all available lookup strategies.
// Calls done(exePath) on success, done(null) if not found.
function findExePath(progId, exeName, done) {
  const steps = [];

  // Steps 1–2: ProgId open command (contains the exact path Windows uses for this browser)
  if (progId) {
    for (const hive of ['HKCU', 'HKLM']) {
      const key = `${hive}\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`;
      steps.push(cb => exec(`reg query "${key}" /ve`, { windowsHide: true }, (e, out) => {
        // Value looks like:  "C:\...\brave.exe" -- "%1"
        const m = !e && out && out.match(/"([^"]+\.exe)"/i);
        cb(m && fs.existsSync(m[1]) ? m[1] : null);
      }));
    }
  }

  // Steps 3–4: App Paths (HKCU before HKLM to prefer per-user installs)
  for (const hive of ['HKCU', 'HKLM']) {
    const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`;
    steps.push(cb => exec(`reg query "${key}" /ve`, { windowsHide: true }, (e, out) => {
      const m = !e && out && out.match(/REG_SZ\s+(.+)/);
      const p = m ? m[1].trim().replace(/"/g, '') : null;
      cb(p && fs.existsSync(p) ? p : null);
    }));
  }

  // Step 5: well-known paths (synchronous fs.existsSync — no async needed)
  const common = (BROWSER_COMMON_PATHS[exeName] || []).filter(p => fs.existsSync(p));
  if (common.length) steps.push(cb => cb(common[0]));

  let i = 0;
  function next() {
    if (i >= steps.length) return done(null);
    steps[i++](result => (result ? done(result) : next()));
  }
  next();
}

// Launch a browser exe to a specific URL.
// Uses cmd's "start" command — this is how Windows itself opens URLs from the shell,
// and correctly handles single-instance browsers (Brave, Chrome, Edge) that are
// already running by routing the URL to the existing instance via their IPC channel.
function launchBrowser(exePath, extUrl) {
  const safePath = exePath.replace(/"/g, '\\"');
  exec(`start "" "${safePath}" "${extUrl}"`, { shell: true, windowsHide: true }, e => {
    if (e) logger.logError(e);
  });
}

function openBrowserExtensionsPage(callback) {
  exec(
    'reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId',
    { windowsHide: true },
    (err, stdout) => {
      const m = !err && stdout && stdout.match(/ProgId\s+REG_SZ\s+(\S+)/i);
      const progId = m ? m[1] : '';

      const entry = BROWSER_MAP.find(([id]) => progId.toLowerCase().includes(id.toLowerCase()));

      if (entry && entry[1]) {
        const [, exeName, extUrl] = entry;
        const name = exeName.replace('.exe', '').replace(/^\w/, c => c.toUpperCase());
        safeSend('browser-detected', { name, extUrl });
        findExePath(progId, exeName, exePath => {
          if (exePath) {
            logger.debugLog(`Launching ${exePath} → ${extUrl}`);
            launchBrowser(exePath, extUrl);
            callback(null);
          } else {
            logger.debugLog(`Could not locate ${exeName}; falling back to browser scan`);
            scanInstalledBrowsers(callback);
          }
        });
      } else if (entry && !entry[1]) {
        logger.debugLog(`Default browser ${progId} is Firefox-based; scanning for Chromium browser`);
        scanInstalledBrowsers(callback);
      } else {
        scanInstalledBrowsers(callback);
      }
    }
  );
}

function scanInstalledBrowsers(callback) {
  const candidates = BROWSER_MAP.filter(e => e[1]);
  let i = 0;
  function tryNext() {
    if (i >= candidates.length) { callback(new Error('No compatible Chromium browser found')); return; }
    const [, exeName, extUrl] = candidates[i++];
    findExePath(null, exeName, exePath => {
      if (exePath) {
        const name = exeName.replace('.exe', '').replace(/^\w/, c => c.toUpperCase());
        safeSend('browser-detected', { name, extUrl });
        logger.debugLog(`Launching ${exePath} → ${extUrl}`);
        launchBrowser(exePath, extUrl);
        callback(null);
      } else {
        tryNext();
      }
    });
  }
  tryNext();
}

function installExtension() {
  try {
    const extSrc  = path.join(__dirname, 'extension');
    const dest    = getExtDestPath();
    copyDirSync(extSrc, dest);
    extDestPath = dest;

    // Copy the folder path to clipboard for easy paste into Chrome's "Load unpacked" dialog
    clipboard.writeText(dest);

    // Write installed flag
    fs.writeFileSync(path.join(dest, '.installed'), '');

    // Open Chrome/Edge extensions page, then tell the renderer the path and status
    openBrowserExtensionsPage(err => {
      if (err) logger.logError(err);
      safeSend('extension-install-ready', dest);
      safeSend('extension-installed', true);
    });

    logger.debugLog(`Extension copied to: ${dest}`);
  } catch (err) {
    logger.logError(err);
    safeSend('status-update', 'Extension install failed — see debug log');
  }
}

// ── Window ───────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 780,
    resizable: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);

  mainWindow.webContents.once('did-finish-load', () => {
    safeSend('filter-status',          state.FILTER_ENABLED);
    safeSend('adblock-status',         state.AD_BLOCKING_ENABLED);
    safeSend('image-detection-status', state.IMAGE_DETECTION_ENABLED);
    safeSend('youtube-filter-status',  state.YOUTUBE_FILTER_ENABLED);
    safeSend('filter-count',           state.filteredCount);
    safeSend('ads-count',              state.adsBlocked);
    safeSend('images-count',           state.imagesBlocked);
    safeSend('youtube-count',          state.youtubeBlocked);
    safeSend('extension-installed',    isExtensionInstalled());
  });

  mainWindow.on('close', e => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

// ── Tray ─────────────────────────────────────────────────────────
function updateTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  if (!tray) {
    tray = new Tray(icon);
    tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
  }
  tray.setToolTip('AI Slop Filter');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state.FILTER_ENABLED ? 'Disable Filter' : 'Enable Filter', click: toggleFilter },
    { label: 'Open Dashboard', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// ── Toggle handlers ──────────────────────────────────────────────
// The proxy runs for the full lifetime of the app (needed for ad blocking regardless
// of text filter state). Toggling the text filter only gates ML classification —
// the proxy and system PAC are unaffected.
function toggleFilter() {
  state.FILTER_ENABLED = !state.FILTER_ENABLED;
  updateTray();
  safeSend('filter-status', state.FILTER_ENABLED);
  logger.debugLog(`Text filter ${state.FILTER_ENABLED ? 'enabled' : 'disabled'}`);
}

function toggleAdblock() {
  state.AD_BLOCKING_ENABLED = !state.AD_BLOCKING_ENABLED;
  safeSend('adblock-status', state.AD_BLOCKING_ENABLED);
  logger.debugLog(`Ad blocking ${state.AD_BLOCKING_ENABLED ? 'enabled' : 'disabled'}`);
}

function toggleImageDetection() {
  state.IMAGE_DETECTION_ENABLED = !state.IMAGE_DETECTION_ENABLED;
  safeSend('image-detection-status', state.IMAGE_DETECTION_ENABLED);
  logger.debugLog(`Image detection ${state.IMAGE_DETECTION_ENABLED ? 'enabled' : 'disabled'}`);

  // Load image model on first enable (~84 MB local ONNX)
  if (state.IMAGE_DETECTION_ENABLED && !classifier.isImageModelReady()) {
    classifier.loadImageModel(msg => safeSend('status-update', msg));
  }
}

function toggleYoutubeFilter() {
  state.YOUTUBE_FILTER_ENABLED = !state.YOUTUBE_FILTER_ENABLED;
  safeSend('youtube-filter-status', state.YOUTUBE_FILTER_ENABLED);
  logger.debugLog(`YouTube AI filter ${state.YOUTUBE_FILTER_ENABLED ? 'enabled' : 'disabled'}`);
}

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  logger.init(userData);

  const pac     = require('./pac');
  const pacText = pac.generatePAC(proxy.PORT);
  activePacUrl  = `http://127.0.0.1:${proxy.PORT}/filter.pac`;

  const cacheDir = path.join(userData, 'transformers-cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  process.env.TRANSFORMERS_CACHE = cacheDir;

  certsDir   = path.join(userData, 'certs');
  caCertPath = path.join(certsDir, 'ca.pem');
  if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

  createWindow();
  updateTray();

  proxy.init(safeSend, pacText);
  service.start(safeSend);

  // Clear any stale proxy left from a previous run before model downloads
  try { execSync('netsh winhttp reset proxy', { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  try { execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f', { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  try { execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL /t REG_SZ /d "" /f', { stdio: 'ignore', windowsHide: true }); } catch (_) {}

  await classifier.loadModel(msg => safeSend('status-update', msg));

  // Proxy always starts with the app — it serves ad blocking regardless of text filter state.
  await proxy.start(certsDir);
  setSystemProxy(true);
  setTimeout(installCert, 1500);
});

app.on('before-quit', () => {
  proxy.stop();
  service.stop();
  try { execSync('netsh winhttp reset proxy', { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  try { execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f', { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  try { execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v AutoConfigURL /t REG_SZ /d "" /f', { stdio: 'ignore', windowsHide: true }); } catch (_) {}
});

// ── IPC handlers ──────────────────────────────────────────────────
ipcMain.on('window-minimize',        () => mainWindow?.minimize());
ipcMain.on('window-close',           () => mainWindow?.close());
ipcMain.on('toggle-filter',          toggleFilter);
ipcMain.on('toggle-adblock',         toggleAdblock);
ipcMain.on('toggle-image-detection', toggleImageDetection);
ipcMain.on('toggle-youtube-filter',  toggleYoutubeFilter);
ipcMain.on('reinstall-cert',         installCert);
ipcMain.on('install-extension',      installExtension);
ipcMain.on('open-extension-folder',  () => {
  const dest = extDestPath || getExtDestPath();
  if (fs.existsSync(dest)) shell.showItemInFolder(dest);
});
ipcMain.on('open-debug-log',  () => shell.showItemInFolder(logger.debugLogPath));
ipcMain.on('open-external',  (_, url) => shell.openExternal(url));
ipcMain.on('reset-all', () => {
  state.filteredCount  = 0;
  state.adsBlocked     = 0;
  state.imagesBlocked  = 0;
  state.youtubeBlocked = 0;
  safeSend('filter-count',  0);
  safeSend('ads-count',     0);
  safeSend('images-count',  0);
  safeSend('youtube-count', 0);
  safeSend('status-update', 'Counters reset');
});
