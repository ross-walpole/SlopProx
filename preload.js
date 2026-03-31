const { contextBridge, ipcRenderer } = require('electron');

const SEND_CHANNELS = [
  'window-minimize', 'window-close',
  'toggle-filter', 'toggle-adblock', 'toggle-image-detection', 'toggle-youtube-filter',
  'reset-all', 'open-debug-log', 'reinstall-cert',
  'install-extension', 'open-extension-folder', 'open-external',
];

const RECEIVE_CHANNELS = [
  'filter-status', 'adblock-status', 'image-detection-status', 'youtube-filter-status',
  'filter-count', 'ads-count', 'images-count', 'youtube-count',
  'status-update',
  'cert-ready',
  'extension-install-ready',
  'extension-installed',
  'browser-detected',
];

contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel, ...args) => {
    if (SEND_CHANNELS.includes(channel)) ipcRenderer.send(channel, ...args);
  },
  on: (channel, callback) => {
    if (RECEIVE_CHANNELS.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },
});
