// Agent Office core: receives Claude Code hook events (POST /events), streams them to office pages (GET /stream, SSE)
// and serves the office page (public/). Permission prompts can be answered from a page (POST /permission, /decide).
// While running it writes its port to ~/.agent-office/port: that file is how the hooks find it, and no file means the
// hooks stay silent. One server per machine: a second start attaches to the first.
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const MAX_BODY = 8 * 1024 * 1024; // hook payloads can carry whole files (Write/Edit), so accept big bodies, then slim them
const LOG_MAX = 1000; // events replayed to a page that opens late
const CLAUDE_DIR = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']); // claude's to-do list, drawn on the whiteboard
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']); // the files a floor lists

// A file as the office lists it: relative to the session's folder, else with ~ for the home folder.
function shortPath(p, cwd) {
  if (typeof p !== 'string' || !p) return undefined;
  let out = p;
  const rel = typeof cwd === 'string' ? path.relative(cwd, path.resolve(cwd, p)) : '';
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out = rel;
  else if (p.toLowerCase().startsWith(os.homedir().toLowerCase())) out = '~' + p.slice(os.homedir().length);
  return out.split(path.sep).join('/').slice(-200);
}

// Keep only what the office uses: payloads also hold file contents, command output and prompts.
function slim(e) {
  const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const id = v => (v == null ? undefined : String(v).slice(0, 20));
  const ti = e.tool_input || {}, tr = e.tool_response, task = TASK_TOOLS.has(e.tool_name);
  return {
    hook_event_name: e.hook_event_name, session_id: e.session_id, agent_id: e.agent_id, agent_type: e.agent_type,
    source: e.source, tool_name: e.tool_name, tool_use_id: e.tool_use_id,
    tool_input: {
      // message: a subagent's report (SubagentHandback), or a message between team members (SendMessage, to whom)
      description: cut(ti.description, 200), command: cut(ti.command, 300), message: cut(ti.message, 4000), to: cut(ti.to, 60),
      ...(task && {
        subject: cut(ti.subject, 120), activeForm: cut(ti.activeForm, 120), taskId: id(ti.taskId), status: cut(ti.status, 20),
        todos: Array.isArray(ti.todos) ? ti.todos.slice(0, 50).map(t => ({ content: cut(t?.content, 120), status: cut(t?.status, 20), activeForm: cut(t?.activeForm, 120) })) : undefined,
      }),
    },
    tool_response: !tr || typeof tr !== 'object' ? undefined
      : typeof tr.agentId === 'string' ? { agentId: tr.agentId }
      : task && tr.task && tr.task.id != null ? { task: { id: id(tr.task.id), subject: cut(tr.task.subject, 120) } } : undefined,
    file: e.hook_event_name === 'PostToolUse' && EDIT_TOOLS.has(e.tool_name) ? shortPath(ti.file_path ?? ti.notebook_path, e.cwd) : undefined,
    is_interrupt: e.is_interrupt, error: cut(e.error, 200), notification_type: e.notification_type, message: cut(e.message, 200),
    last_assistant_message: cut(e.last_assistant_message, 4000), to_model: e.to_model, trigger: e.trigger, reason: cut(e.reason, 40),
    project: typeof e.cwd === 'string' ? path.basename(e.cwd).slice(0, 60) : undefined, // the folder's name names its floor, not the whole path
    // what a permission prompt is about, for answering it from the office
    ask: e.hook_event_name === 'PermissionRequest' ? cut(ti.command ?? ti.file_path ?? ti.url ?? JSON.stringify(ti), 300) : undefined,
  };
}

// Hook events don't say which model the main agent runs or how full its context is; its transcript does. The last
// main-thread assistant line has both (other lines, like api-request-shape or side requests, can name another model);
// a compaction line after it gives the context left after compacting.
function lastAssistant(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"type":"assistant"') && !l.includes('"compactMetadata"')) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; } // the tail's first line is usually cut
    if (j.compactMetadata && Number(j.compactMetadata.postTokens) > 0) return { used: Number(j.compactMetadata.postTokens) };
    const m = j.message?.model, u = j.message?.usage || {};
    if (j.type === 'assistant' && !j.isSidechain && typeof m === 'string' && m.startsWith('claude-')) {
      const used = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((n, k) => n + (Number(u[k]) || 0), 0);
      return { model: m, used: used || undefined };
    }
  }
}
const models = new Map(), readAt = new Map(); // session_id -> model id / when its transcript was last read
const FRESH = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'PostCompact']); // always worth a fresh read
const inside = (file, dir) => {
  const f = path.resolve(file), d = dir + path.sep;
  return process.platform === 'win32' ? f.toLowerCase().startsWith(d.toLowerCase()) : f.startsWith(d);
};
function fromTranscript(e) {
  const sid = e.session_id;
  if (e.agent_id || typeof sid !== 'string') return {};
  if (e.hook_event_name === 'PostModelSwitch' && typeof e.to_model === 'string') models.set(sid, e.to_model);
  const t = e.transcript_path, now = Date.now();
  let context;
  if (typeof t === 'string' && t.endsWith('.jsonl') && inside(t, CLAUDE_DIR) && (FRESH.has(e.hook_event_name) || !models.has(sid) || now - (readAt.get(sid) || 0) > 5000)) {
    readAt.set(sid, now);
    // shortcut: reads only the transcript's last 256 KB; if no assistant line is in there, model and context come a turn later
    try {
      const fd = fs.openSync(t, 'r');
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, 256 * 1024), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const a = lastAssistant(buf.toString('utf8'));
        if (a?.model && !models.has(sid)) models.set(sid, a.model);
        context = a?.used;
      } finally { fs.closeSync(fd); }
    } catch {} // transcript not written yet
  }
  return { model: models.get(sid), context };
}

// The agents a session has defined, by name and description: the front matter of .claude/agents/*.md in its folder and
// in the claude config dir (the folder's wins a shared name). They are the office's staff list.
// shortcut: only the files directly in those two folders; agents in subfolders, from plugins or from --agents get
// their name when they first work, as before. Read those too if people miss them.
const AGENTS_MAX = 40;
const head = (file, n) => { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(n); return b.toString('utf8', 0, fs.readSync(fd, b, 0, n, 0)); } finally { fs.closeSync(fd); } };
function frontField(fm, key) {
  const lines = fm.split(/\r?\n/), i = lines.findIndex(l => l.startsWith(key + ':'));
  if (i < 0) return '';
  let v = lines[i].slice(key.length + 1).trim();
  if (/^[|>][+-]?$/.test(v)) { // a YAML block: the indented lines under the key
    const end = lines.findIndex((l, j) => j > i && /^\S/.test(l));
    v = lines.slice(i + 1, end < 0 ? undefined : end).join(' ');
  }
  return v.replace(/^(["'])(.*)\1$/, '$2').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}
function agentsOf(folder) {
  const found = new Map();
  for (const dir of [typeof folder === 'string' && path.isAbsolute(folder) && path.join(folder, '.claude', 'agents'), path.join(CLAUDE_DIR, 'agents')]) {
    let files = [];
    try { if (dir) files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch {} // none defined there
    for (const f of files) {
      if (found.size >= AGENTS_MAX) break;
      let fm;
      try { fm = /^---\r?\n([\s\S]*?)(?:\r?\n---|$)/.exec(head(path.join(dir, f), 8192).trimStart())?.[1]; } catch {}
      const name = fm ? frontField(fm, 'name').slice(0, 60) : ''; // no name: a note someone left there, not an agent
      if (name && !found.has(name)) found.set(name, frontField(fm, 'description').slice(0, 200));
    }
  }
  return [...found].map(([name, description]) => ({ name, description }));
}
const folders = new Map(); // session_id -> the folder it started in (a later cwd can be somewhere claude cd'ed to)
// Sent with a session's first event, its start and every prompt, so an agent added meanwhile shows up at the next prompt.
function staffList(e) {
  const sid = e.session_id, ev = e.hook_event_name;
  if (e.agent_id || typeof sid !== 'string') return {};
  const first = !folders.has(sid);
  if (first || ev === 'SessionStart') folders.set(sid, e.cwd);
  return first || ev === 'SessionStart' || ev === 'UserPromptSubmit' ? { agents: agentsOf(folders.get(sid)) } : {};
}

const sha1 = b => crypto.createHash('sha1').update(b).digest('hex');

function isOffice(port) {
  return new Promise(ok => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, res => {
      let b = '';
      res.on('data', d => (b += d));
      res.on('end', () => { try { ok(JSON.parse(b).app === 'agent-office'); } catch { ok(false); } });
    });
    r.on('error', () => ok(false));
    r.on('timeout', () => { r.destroy(); ok(false); });
  });
}

async function start({
  port = Number(process.env.AGENT_OFFICE_PORT || 47100), // a stable port keeps the page's origin (and its saved settings) the same
  home = process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), '.agent-office'),
} = {}) {
  const portFile = path.join(home, 'port');
  const clients = new Set(), log = [];
  // The same hook can be registered twice (the plugin + the app's --settings) and claude runs both: drop exact repeats.
  const recent = new Map(); // body hash -> receive time, oldest first
  let actual;

  const send = (res, status, type, body) => { res.writeHead(status, type ? { 'Content-Type': type } : {}); res.end(body); };

  function broadcast(out) {
    log.push(out);
    if (log.length > LOG_MAX) log.shift();
    const msg = `data: ${JSON.stringify(out)}\n\n`;
    for (const c of clients) c.write(msg);
  }

  function readJson(req, res, max, done) {
    // only the hooks' curl and the office page send JSON; another site can't without a CORS preflight we never answer
    if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415);
    let size = 0;
    const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > max) { send(res, 413); req.destroy(); } else chunks.push(d);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const raw = Buffer.concat(chunks);
      let v;
      try { v = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400); }
      done(v, raw);
    });
  }

  // Answering from the office: the PermissionRequest hook POSTs to /permission and waits for the reply. Claude shows
  // its own dialog meanwhile and takes whichever answer comes first, so holding the hook never blocks the terminal.
  const pending = new Map(); // id -> { id, key, sid, aid, tool, input, hooks: [res], timer }
  const HOLD_MS = 590 * 1000; // just under claude's 600 s hook timeout

  // The question is over: send the hook its decision (none: claude's dialog stays in charge) and tell the pages.
  function settle(id, behavior, decision) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    for (const r of p.hooks) if (!r.writableEnded) decision ? send(r, 200, 'application/json', JSON.stringify(decision)) : send(r, 204);
    broadcast({ hook_event_name: 'PermissionDone', session_id: p.sid, agent_id: p.aid, _perm: id, behavior, _t: Date.now() });
  }

  function hold(p, res) {
    p.hooks.push(res);
    res.on('close', () => { // claude killed the hook (timeout, exit): nobody to answer
      if (res.writableEnded) return;
      p.hooks = p.hooks.filter(r => r !== res);
      if (!p.hooks.length) settle(p.id, 'gone');
    });
  }

  // Events that show the question was answered in the terminal, or no longer matters, let the hook go.
  const ENDS = new Set(['Stop', 'StopFailure', 'SubagentStop', 'UserPromptSubmit']);
  function answered(e) {
    const ev = e.hook_event_name;
    for (const p of [...pending.values()]) {
      if (p.sid !== e.session_id) continue;
      const mine = p.aid === e.agent_id;
      const ran = (ev === 'PostToolUse' || ev === 'PostToolUseFailure') && e.tool_name === p.tool && sha1(JSON.stringify(e.tool_input)) === p.input;
      if (ev === 'SessionEnd' || (mine && (ENDS.has(ev) || ran))) settle(p.id, 'terminal');
    }
  }

  function receive(req, res, ask) {
    readJson(req, res, MAX_BODY, (e, raw) => {
      if (!e || typeof e.hook_event_name !== 'string') return send(res, 400);
      const now = Date.now(), key = sha1(raw);
      for (const [k, t] of recent) { if (now - t <= 5000) break; recent.delete(k); }
      if (recent.has(key)) { // distinct events always differ (tool_use_id, prompt_id, agent_id...): the same hook registered twice
        const p = ask && [...pending.values()].find(x => x.key === key);
        return p ? hold(p, res) : send(res, 204);
      }
      recent.set(key, now);
      const out = { ...slim(e), ...fromTranscript(e), ...staffList(e), _t: now };
      if (ask && clients.size) { // the office is open: wait for a page or the terminal to answer
        const id = crypto.randomUUID();
        const p = { id, key, sid: e.session_id, aid: e.agent_id, tool: e.tool_name, input: sha1(JSON.stringify(e.tool_input)), hooks: [], timer: setTimeout(() => settle(id, 'expired'), HOLD_MS) };
        pending.set(id, p);
        hold(p, res);
        out._perm = id;
      } else send(res, 204);
      broadcast(out);
      answered(e);
    });
  }

  function decide(req, res) {
    // only the office page itself: browsers always send Origin on a POST
    if (![`http://127.0.0.1:${actual}`, `http://localhost:${actual}`].includes(req.headers.origin)) return send(res, 403);
    readJson(req, res, 1024, v => {
      const { id, behavior } = v || {};
      if (!pending.has(id) || !['allow', 'deny'].includes(behavior)) return send(res, 409); // answered already, or never asked
      const decision = behavior === 'allow' ? { behavior } : { behavior, message: 'The user denied this from the Agent Office window.' };
      settle(id, behavior, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
      send(res, 204);
    });
  }

  // Subscription usage, from the status line script (core/statusline.js): account-wide, so one gauge for every floor.
  // Passed on only when a percentage moves, so the replay log doesn't fill up with repeats.
  let usage = '';
  function status(req, res) {
    readJson(req, res, 64 * 1024, v => {
      send(res, 204);
      const pick = w => (w && Number.isFinite(Number(w.used_percentage)) ? { pct: Math.round(Number(w.used_percentage)), resets: Number(w.resets_at) || 0 } : undefined);
      const rl = v?.rate_limits || {}, u = { five: pick(rl.five_hour), week: pick(rl.seven_day) };
      if (!u.five && !u.week) return;
      const key = JSON.stringify(u);
      if (key === usage) return;
      usage = key;
      broadcast({ hook_event_name: 'Usage', usage: u, _t: Date.now() });
    });
  }

  function stream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n'); // sends the headers now; without it the page only "opens" at the first event
    for (const m of log) res.write(`data: ${JSON.stringify(m)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function serveFile(pathname, res) {
    let file;
    try { file = path.join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)); } catch { return send(res, 400); }
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404);
    fs.readFile(file, (err, data) => (err ? send(res, 404) : send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', data)));
  }

  const server = http.createServer((req, res) => {
    // DNS rebinding guard: only answer requests addressed to this machine's loopback
    if (req.headers.host !== `127.0.0.1:${actual}` && req.headers.host !== `localhost:${actual}`) return send(res, 403);
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && pathname === '/events') return receive(req, res, false);
    if (req.method === 'POST' && pathname === '/permission') return receive(req, res, true);
    if (req.method === 'POST' && pathname === '/decide') return decide(req, res);
    if (req.method === 'POST' && pathname === '/status') return status(req, res);
    if (req.method !== 'GET') return send(res, 405);
    if (pathname === '/health') return send(res, 200, 'application/json', JSON.stringify({ app: 'agent-office', port: actual, pages: clients.size }));
    if (pathname === '/stream') return stream(req, res);
    serveFile(pathname, res);
  });

  const listen = p => new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(p, '127.0.0.1', () => { server.off('error', fail); ok(server.address().port); });
  });
  try {
    actual = await listen(port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    if (await isOffice(port)) return { port, attached: true, pages: () => 0, close: () => Promise.resolve() };
    actual = await listen(0); // something else owns the preferred port
  }

  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(portFile, String(actual));
  // a fixed place for the status line script, for a claude setting that has to name a path
  try { fs.copyFileSync(path.join(__dirname, 'statusline.js'), path.join(home, 'statusline.js')); } catch {}
  const removePortFile = () => { try { if (fs.readFileSync(portFile, 'utf8') === String(actual)) fs.rmSync(portFile); } catch {} };
  process.on('exit', removePortFile);
  return {
    port: actual,
    attached: false,
    pages: () => clients.size, // office pages connected right now
    close: () => new Promise(ok => {
      removePortFile(); // first, so hooks go quiet even if closing the sockets takes a while
      for (const id of [...pending.keys()]) settle(id, 'closed'); // waiting hooks go back to claude's own dialog
      for (const c of clients) c.end();
      server.close(() => ok());
    }),
  };
}

module.exports = { start };
