// Terminal-included shell: real claude in a terminal on the left, the shared office page (core server) on the right.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const core = require('../core/server');

// The plugin's own hooks, passed with --settings so the claude started here reports even without the plugin installed.
const HOOKS = path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json');
// Set when this app is launched from inside a claude session; inherited, they make our claude a child of that session
// (it then writes no transcript, so the office can't read its model). Our claude is a session of its own.
const PARENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|MESSAGING_SOCKET|MESSAGING_TOKEN))$/;
let win, term, cwd, office;

// node-pty's kill() leaves ConPTY handles that keep Electron alive on Windows, so end the whole claude tree instead.
function killClaude() {
  if (term) spawnSync('taskkill', ['/pid', String(term.pid), '/T', '/F']);
  term = null;
}

function startClaude(cols, rows) {
  killClaude();
  const t = (term = pty.spawn('claude.exe', ['--settings', HOOKS], {
    name: 'xterm-256color', cols, rows, cwd,
    // Classic renderer: in claude's fullscreen renderer the mouse wheel is a no-op on native Windows, and
    // classic leaves output in xterm's scrollback so the wheel scrolls it. Only affects claude started here.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !PARENT_SESSION_ENV.test(k))), CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
  }));
  t.onData(d => win?.webContents.send('pty-data', d));
  t.onExit(() => { if (term === t) { term = null; win?.webContents.send('pty-exit'); } });
}

ipcMain.on('start', (_, cols, rows) => startClaude(cols, rows));
ipcMain.on('pty-write', (_, d) => term?.write(d));
ipcMain.on('pty-resize', (_, cols, rows) => term?.resize(cols, rows));
ipcMain.on('flash', () => { if (win && !win.isFocused()) win.flashFrame(true); }); // taskbar blink when claude needs you

app.whenReady().then(async () => {
  cwd = process.argv[2];
  if (!cwd) {
    const r = await dialog.showOpenDialog({ title: 'Claude를 실행할 프로젝트 폴더', properties: ['openDirectory'] });
    cwd = r.canceled ? os.homedir() : r.filePaths[0];
  }
  office = await core.start(); // or attaches to the viewer already running

  win = new BrowserWindow({
    width: 1400, height: 820, backgroundColor: '#1e1e2e', title: `Agent Office — ${cwd}`,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // the office page lives in an iframe, so it can't tell whether this window has focus: tell it
  win.on('focus', () => { win.flashFrame(false); win.webContents.send('win-focus', true); });
  win.on('blur', () => win.webContents.send('win-focus', false));
  win.loadFile(path.join(__dirname, 'index.html'), { query: { office: `http://127.0.0.1:${office.port}/` } });
});

app.on('window-all-closed', () => {
  killClaude();
  office?.close(); // removes the port file right away, so hooks go quiet
  app.exit(0);
});
