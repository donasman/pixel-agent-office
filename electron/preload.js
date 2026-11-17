const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  start: (cols, rows) => ipcRenderer.send('start', cols, rows),
  write: d => ipcRenderer.send('pty-write', d),
  resize: (cols, rows) => ipcRenderer.send('pty-resize', cols, rows),
  flash: () => ipcRenderer.send('flash'),
  onData: cb => ipcRenderer.on('pty-data', (_, d) => cb(d)),
  onExit: cb => ipcRenderer.on('pty-exit', () => cb()),
  onWindowFocus: cb => ipcRenderer.on('win-focus', (_, focused) => cb(focused)),
  onSession: cb => ipcRenderer.on('claude-session', (_, id) => cb(id)),
});
