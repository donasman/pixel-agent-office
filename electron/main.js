// Terminal-included shell: real claude in terminal tabs on the left (one claude session per tab), the shared office page
// (core server) on the right.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const core = require('../core/server');
// English unless the app's language is Korean, like the pages (the locale is known once the app is ready)
const T = (en, ko) => (/^ko\b/i.test(app.getLocale()) ? ko : en);

// The plugin's own hooks, passed with --settings so the claude started here reports even without the plugin installed.
// Without Git Bash, claude runs hooks in PowerShell, so that machine gets the PowerShell variant.
const gitBash = require('../core/git-bash');
const HOOKS = path.join(__dirname, '..', gitBash ? 'plugin' : 'plugin-powershell', 'hooks', 'hooks.json');
// What the claude started here gets with --settings: the plugin's hooks, plus the office's status line (the one place
// claude hands out the subscription usage), which then shows your own status line, if you have one.
const SETTINGS = path.join(os.tmpdir(), 'agent-office-claude-settings.json');
fs.writeFileSync(SETTINGS, JSON.stringify({
  hooks: JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks,
  statusLine: { type: 'command', command: `node "${path.join(__dirname, '..', 'core', 'statusline.js').replace(/\\/g, '/')}"` },
}));
// your status line for a folder: the most specific settings file that sets one
function ownStatusLine(cwd) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  for (const f of [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'), path.join(claudeDir, 'settings.json')]) {
    try { const c = JSON.parse(fs.readFileSync(f, 'utf8')).statusLine?.command; if (c) return c; } catch {}
  }
  return '';
}
// Set when this app is launched from inside a claude session; inherited, they make our claude a child of that session
// (it then writes no transcript, so the office can't read its model). Our claude is a session of its own.
const PARENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|MESSAGING_SOCKET|MESSAGING_TOKEN))$/;
let win, office;
const terms = new Map(); // tab id -> { pty, session, cwd, ended }

// A claude that's killed sends no SessionEnd of its own: tell the office, so its floor closes (and a restart in that
// folder reopens it). A second SessionEnd for a session that did end is ignored.
function endSession(t) {
  if (t.ended) return Promise.resolve();
  t.ended = true;
  return new Promise(ok => {
    const r = http.request({ host: '127.0.0.1', port: office.port, method: 'POST', path: '/events', headers: { 'Content-Type': 'application/json' }, timeout: 1000 }, res => { res.resume(); res.on('end', ok); });
    r.on('error', ok);
    r.on('timeout', () => { r.destroy(); ok(); });
    r.end(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: t.session, cwd: t.cwd, reason: 'other' }));
  });
}

// node-pty's kill() leaves ConPTY handles that keep Electron alive on Windows, so end the whole claude tree instead.
function killClaude(id) {
  const t = terms.get(id);
  if (!t?.pty) return Promise.resolve();
  spawnSync('taskkill', ['/pid', String(t.pty.pid), '/T', '/F']);
  t.pty = null;
  return endSession(t);
}

function startClaude(id, cwd, cols, rows) {
  killClaude(id);
  if (typeof cwd !== 'string' || !fs.existsSync(cwd)) cwd = os.homedir();
  const t = { session: crypto.randomUUID(), cwd, ended: false }; // we name the session, so the office knows which floor is this tab's
  terms.set(id, t);
  win?.webContents.send('claude-session', id, t.session);
  const p = (t.pty = pty.spawn('claude.exe', ['--settings', SETTINGS, '--session-id', t.session], {
    name: 'xterm-256color', cols, rows, cwd,
    // Classic renderer: in claude's fullscreen renderer the mouse wheel is a no-op on native Windows, and
    // classic leaves output in xterm's scrollback so the wheel scrolls it. Only affects claude started here.
    // The to-do tools (TaskCreate...) feed the office's whiteboard; Claude Code gives current models them only on request.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !PARENT_SESSION_ENV.test(k))), CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS ?? '1',
      AGENT_OFFICE_STATUSLINE: ownStatusLine(cwd), AGENT_OFFICE_SHELL: gitBash ? 'bash' : 'powershell',
    },
  }));
  p.onData(d => win?.webContents.send('pty-data', id, d));
  p.onExit(() => {
    endSession(t);
    if (t.pty === p) { t.pty = null; win?.webContents.send('pty-exit', id); }
  });
}

ipcMain.on('start', (_, id, cwd, cols, rows) => startClaude(id, cwd, cols, rows));
ipcMain.on('pty-write', (_, id, d) => terms.get(id)?.pty?.write(d));
ipcMain.on('pty-resize', (_, id, cols, rows) => terms.get(id)?.pty?.resize(cols, rows));
ipcMain.on('close-tab', (_, id) => { killClaude(id); terms.delete(id); });
ipcMain.handle('pick-folder', async (_, defaultPath) => {
  const r = await dialog.showOpenDialog(win, { title: T('New session: the project folder to run Claude in', '새 세션: Claude를 실행할 프로젝트 폴더'), defaultPath, properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('flash', () => { if (win && !win.isFocused()) win.flashFrame(true); }); // taskbar blink when claude needs you
ipcMain.on('raise', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.focus(); });

app.whenReady().then(async () => {
  let cwd = process.argv[2];
  if (!cwd) {
    const r = await dialog.showOpenDialog({ title: T('The project folder to run Claude in', 'Claude를 실행할 프로젝트 폴더'), properties: ['openDirectory'] });
    cwd = r.canceled ? os.homedir() : r.filePaths[0];
  }
  office = await core.start(); // or attaches to the viewer already running

  win = new BrowserWindow({
    width: 1400, height: 820, backgroundColor: '#1e1e2e', title: 'Agent Office', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // the office page lives in an iframe, so it can't tell whether this window has focus: tell it
  win.on('focus', () => { win.flashFrame(false); win.webContents.send('win-focus', true); });
  win.on('blur', () => win.webContents.send('win-focus', false));
  win.loadFile(path.join(__dirname, 'index.html'), { query: { office: `http://127.0.0.1:${office.port}/`, cwd } });
});

app.on('window-all-closed', async () => {
  // every tab's floor closes, also in a viewer that outlives this app (wait up to a second for that)
  await Promise.race([Promise.all([...terms.keys()].map(killClaude)), new Promise(ok => setTimeout(ok, 1000))]);
  office?.close(); // removes the port file right away, so hooks go quiet
  app.exit(0);
});
