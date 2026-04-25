// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('logApi', {
  send:       (ch) => ipcRenderer.send(ch),
  onHistory:  (fn) => ipcRenderer.on('log-history',   (_, lines)   => fn(lines)),
  onLine:     (fn) => ipcRenderer.on('log-line',       (_, entry)   => fn(entry)),
  onVersion:  (fn) => ipcRenderer.on('app-version',    (_, version) => fn(version)),
});
