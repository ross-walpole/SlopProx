// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

const { contextBridge, ipcRenderer } = require('electron');

const SEND_CHANNELS = [
  'window-minimize', 'window-close',
  'toggle-filter', 'toggle-adblock', 'toggle-image-detection', 'toggle-youtube-filter',
  'toggle-proxy',
  'reset-all', 'open-debug-log', 'reinstall-cert',
  'install-extension', 'open-extension-folder', 'open-external',
  'set-setting',
  'install-update',
  'check-for-updates',
  'add-bypass', 'remove-bypass',
];

const INVOKE_CHANNELS = [
  'get-version',
];

const RECEIVE_CHANNELS = [
  'filter-status', 'adblock-status', 'image-detection-status', 'youtube-filter-status',
  'proxy-status',
  'filter-count', 'ads-count', 'images-count', 'youtube-count',
  'status-update',
  'cert-ready',
  'extension-install-ready',
  'extension-installed',
  'browser-detected',
  'image-model-progress',
  'settings-loaded',
  'update-available', 'update-progress', 'update-ready',
  'update-check-start', 'update-check-complete', 'update-check-error',
  'suggest-bypass',
  'bypass-domains',
  'classification-entry',
];

contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel, ...args) => {
    if (SEND_CHANNELS.includes(channel)) ipcRenderer.send(channel, ...args);
  },
  invoke: (channel, ...args) => {
    if (INVOKE_CHANNELS.includes(channel)) return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, callback) => {
    if (RECEIVE_CHANNELS.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },
});
