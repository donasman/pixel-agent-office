// Agent Office core: receives Claude Code hook events (POST /events), streams them to office pages (GET /stream, SSE)
// and serves the office page (public/). While running it writes its port to ~/.agent-office/port: that file is how the
// hooks find it, and no file means the hooks stay silent. One server per machine: a second start attaches to the first.
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

// Keep only what the office uses: payloads also hold file contents, command output and prompts.
function slim(e) {
  const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const ti = e.tool_input || {}, tr = e.tool_response;
  return {
    hook_event_name: e.hook_event_name, session_id: e.session_id, agent_id: e.agent_id, agent_type: e.agent_type,
    source: e.source, tool_name: e.tool_name, tool_use_id: e.tool_use_id,
    tool_input: { description: cut(ti.description, 200), command: cut(ti.command, 300), message: cut(ti.message, 400) }, // message: a subagent's report
    tool_response: tr && typeof tr === 'object' && typeof tr.agentId === 'string' ? { agentId: tr.agentId } : undefined,
    is_interrupt: e.is_interrupt, error: cut(e.error, 200), notification_type: e.notification_type, message: cut(e.message, 200),
    last_assistant_message: cut(e.last_assistant_message, 400), to_model: e.to_model, trigger: e.trigger, reason: cut(e.reason, 40),
    project: typeof e.cwd === 'string' ? path.basename(e.cwd).slice(0, 60) : undefined, // the folder's name names its floor, not the whole path
  };
}

// Hook events don't say which model the main agent runs; its transcript does. Only the main thread's assistant lines
// count: other lines (api-request-shape, side requests) can name a different model.
function lastAssistantModel(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"assistant"')) continue;
    let j;
    try { j = JSON.parse(lines[i]); } catch { continue; } // the tail's first line is usually cut
    const m = j.message?.model;
    if (j.type === 'assistant' && !j.isSidechain && typeof m === 'string' && m.startsWith('claude-')) return m;
  }
}
const models = new Map(); // session_id -> model id
const inside = (file, dir) => {
  const f = path.resolve(file), d = dir + path.sep;
  return process.platform === 'win32' ? f.toLowerCase().startsWith(d.toLowerCase()) : f.startsWith(d);
};
function modelOf(e) {
  if (e.agent_id || typeof e.session_id !== 'string') return undefined;
  if (e.hook_event_name === 'PostModelSwitch' && typeof e.to_model === 'string') models.set(e.session_id, e.to_model);
  const t = e.transcript_path;
  if (!models.has(e.session_id) && typeof t === 'string' && t.endsWith('.jsonl') && inside(t, CLAUDE_DIR)) {
    // shortcut: reads only the transcript's last 256 KB; if no assistant line is in there, the model shows up a turn later
    try {
      const fd = fs.openSync(t, 'r');
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, 256 * 1024), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const m = lastAssistantModel(buf.toString('utf8'));
        if (m) models.set(e.session_id, m);
      } finally { fs.closeSync(fd); }
    } catch {} // transcript not written yet
  }
  return models.get(e.session_id);
}

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

  function receive(req, res) {
    // only the hooks' curl sends JSON; a web page can't without a CORS preflight we never answer
    if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415);
    let size = 0;
    const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { send(res, 413); req.destroy(); } else chunks.push(d);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const raw = Buffer.concat(chunks);
      let e;
      try { e = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400); }
      if (!e || typeof e.hook_event_name !== 'string') return send(res, 400);
      send(res, 204);
      const now = Date.now(), key = crypto.createHash('sha1').update(raw).digest('hex');
      for (const [k, t] of recent) { if (now - t <= 5000) break; recent.delete(k); }
      if (recent.has(key)) return; // distinct events always differ (tool_use_id, prompt_id, agent_id...)
      recent.set(key, now);
      const out = { ...slim(e), model: modelOf(e), _t: now };
      log.push(out);
      if (log.length > LOG_MAX) log.shift();
      const msg = `data: ${JSON.stringify(out)}\n\n`;
      for (const c of clients) c.write(msg);
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
    if (req.method === 'POST' && pathname === '/events') return receive(req, res);
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
  const removePortFile = () => { try { if (fs.readFileSync(portFile, 'utf8') === String(actual)) fs.rmSync(portFile); } catch {} };
  process.on('exit', removePortFile);
  return {
    port: actual,
    attached: false,
    pages: () => clients.size, // office pages connected right now
    close: () => new Promise(ok => {
      removePortFile(); // first, so hooks go quiet even if closing the sockets takes a while
      for (const c of clients) c.end();
      server.close(() => ok());
    }),
  };
}

module.exports = { start };
