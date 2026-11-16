// Checks the core server: event in -> SSE out, slimming, replay, guards, singleton, model lookup, port file, hooks.json.
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// keep the real ~/.agent-office/port and ~/.claude untouched
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-test-'));
process.env.AGENT_OFFICE_HOME = path.join(tmp, 'home');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const core = require('../core/server');

const request = (port, { method = 'GET', path: p = '/', headers = {}, body } = {}) => new Promise((ok, fail) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
    let b = '';
    res.on('data', d => (b += d));
    res.on('end', () => ok({ status: res.statusCode, body: b, type: res.headers['content-type'] }));
  });
  r.on('error', fail);
  r.end(body);
});
const post = (port, event) => request(port, { method: 'POST', path: '/events', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
// resolves with the first n events a page receives on /stream
const listen = (port, n = 1) => new Promise(ok => {
  http.get({ host: '127.0.0.1', port, path: '/stream' }, res => {
    let b = '';
    const got = [];
    res.on('data', d => {
      b += d;
      let i;
      while ((i = b.indexOf('\n\n')) >= 0) {
        const block = b.slice(0, i);
        if (block.startsWith('data: ')) got.push(JSON.parse(block.slice(6))); // ':' lines are SSE comments
        b = b.slice(i + 2);
      }
      if (got.length >= n) { res.destroy(); ok(got); }
    });
  });
});
const tick = ms => new Promise(ok => setTimeout(ok, ms));

(async () => {
  const a = await core.start({ port: 0 });
  const portFile = path.join(process.env.AGENT_OFFICE_HOME, 'port');
  assert.equal(fs.readFileSync(portFile, 'utf8'), String(a.port), 'the port file tells hooks where to send');

  const live = listen(a.port);
  await tick(100);
  const big = 'x'.repeat(2_000_000);
  const res = await post(a.port, { hook_event_name: 'PreToolUse', session_id: 'S', tool_name: 'Write', tool_use_id: 'T', tool_input: { file_path: 'a', content: big, description: 'd' } });
  assert.equal(res.status, 204);
  const [e] = await live;
  assert.deepEqual([e.hook_event_name, e.tool_name, e.tool_input.description, e.tool_input.content, e.tool_input.file_path], ['PreToolUse', 'Write', 'd', undefined, undefined], 'file contents are not streamed');
  assert.ok(e._t > 0, 'stamped with the receive time');

  const [replayed] = await listen(a.port);
  assert.deepEqual(replayed, e, 'a page opened later gets the history');

  assert.equal((await request(a.port, { method: 'POST', path: '/events', headers: { 'Content-Type': 'text/plain' }, body: '{"hook_event_name":"Stop"}' })).status, 415, 'cross-site form posts are refused');
  assert.equal((await request(a.port, { headers: { Host: 'evil.example' } })).status, 403, 'DNS rebinding is refused');
  assert.equal((await request(a.port, { path: '/..%2Fpackage.json' })).status, 404, 'no path traversal');
  assert.equal((await post(a.port, { nope: 1 })).status, 400);
  const page = await request(a.port);
  assert.equal(page.status, 200);
  assert.match(page.body, /<canvas id="office"/);
  assert.match((await request(a.port, { path: '/office.js' })).type, /javascript/);

  // the same hook registered twice (plugin + --settings) posts the same body twice: stream it once
  const dupes = listen(a.port, 3); // history (1) + two distinct events
  await tick(100);
  const once = { hook_event_name: 'PreToolUse', session_id: 'S', tool_name: 'Glob', tool_use_id: 'D1' };
  await post(a.port, once);
  await post(a.port, once);
  await post(a.port, { ...once, tool_use_id: 'D2' });
  const seen = await dupes;
  assert.deepEqual(seen.slice(1).map(x => x.tool_use_id), ['D1', 'D2'], 'exact repeats are dropped, distinct events are not');

  const b = await core.start({ port: a.port });
  assert.equal(b.attached, true, 'a second start attaches to the running server');

  // model from the transcript, only for files inside the claude config dir
  const tdir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
  fs.mkdirSync(tdir, { recursive: true });
  const transcript = path.join(tdir, 'S2.jsonl');
  // shape of a real transcript: side requests and subagent lines may name other models
  fs.writeFileSync(transcript, [
    '{"type":"user"}',
    '{"type":"assistant","message":{"model":"claude-haiku-5-5"}}',
    '{"type":"assistant","isSidechain":true,"message":{"model":"claude-sonnet-5-5"}}',
    '{"type":"assistant","message":{"model":"<synthetic>"}}',
    '{"type":"api-request-shape","model":"claude-opus-5-5"}',
  ].join('\n') + '\n');
  const outside = path.join(tmp, 'S3.jsonl');
  fs.writeFileSync(outside, '{"type":"assistant","message":{"model":"claude-opus-5-5"}}\n');
  const two = listen(a.port, 5); // history (3 events so far) + the two below
  await tick(100);
  await post(a.port, { hook_event_name: 'Stop', session_id: 'S2', transcript_path: transcript });
  await post(a.port, { hook_event_name: 'Stop', session_id: 'S3', transcript_path: outside });
  const [inDir, outDir] = (await two).slice(-2);
  assert.equal(inDir.model, 'claude-haiku-5-5');
  assert.equal(outDir.model, undefined, 'files outside the claude dir are not read');
  assert.equal(inDir.transcript_path, undefined, 'paths are not streamed');

  await a.close();
  assert.ok(!fs.existsSync(portFile), 'closing removes the port file, so hooks go quiet');

  // the hooks the plugin installs: one silent async command per event the office uses
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const used = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'PostModelSwitch'];
  assert.deepEqual(Object.keys(hooks).sort(), used.sort());
  const commands = new Set(Object.values(hooks).map(([{ hooks: [h] }]) => (assert.equal(h.async, true), assert.equal(h.type, 'command'), h.command)));
  assert.equal(commands.size, 1, 'every event uses the same command');
  assert.match([...commands][0], /\.agent-office\/port.*exit 0$/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('server ok');
})().catch(err => { console.error(err); process.exit(1); });
