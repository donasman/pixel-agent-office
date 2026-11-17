const { contextBridge, ipcRenderer } = require('electron');

// Terminal calls take the tab's id: each tab runs its own claude.
contextBridge.exposeInMainWorld('bridge', {
  start: (id, cwd, cols, rows) => ipcRenderer.send('start', id, cwd, cols, rows),
  write: (id, d) => ipcRenderer.send('pty-write', id, d),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', id, cols, rows),
  close: id => ipcRenderer.send('close-tab', id),
  pickFolder: defaultPath => ipcRenderer.invoke('pick-folder', defaultPath),
  flash: () => ipcRenderer.send('flash'),
  raise: () => ipcRenderer.send('raise'),
  onData: cb => ipcRenderer.on('pty-data', (_, id, d) => cb(id, d)),
  onExit: cb => ipcRenderer.on('pty-exit', (_, id) => cb(id)),
  onWindowFocus: cb => ipcRenderer.on('win-focus', (_, focused) => cb(focused)),
  onSession: cb => ipcRenderer.on('claude-session', (_, id, session) => cb(id, session)),
});
