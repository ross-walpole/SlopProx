const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('logApi', {
  send:       (ch) => ipcRenderer.send(ch),
  onHistory:  (fn) => ipcRenderer.on('log-history',   (_, lines)   => fn(lines)),
  onLine:     (fn) => ipcRenderer.on('log-line',       (_, entry)   => fn(entry)),
  onVersion:  (fn) => ipcRenderer.on('app-version',    (_, version) => fn(version)),
});
