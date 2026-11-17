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
// an office page that stays open: every event it gets lands in .got
const watch = port => {
  const got = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/stream' }, res => {
    let b = '';
    res.on('data', d => {
      b += d;
      let i;
      while ((i = b.indexOf('\n\n')) >= 0) { const block = b.slice(0, i); if (block.startsWith('data: ')) got.push(JSON.parse(block.slice(6))); b = b.slice(i + 2); }
    });
  });
  req.on('error', () => {});
  return { got, close: () => req.destroy() };
};

(async () => {
  const a = await core.start({ port: 0 });
  const portFile = path.join(process.env.AGENT_OFFICE_HOME, 'port');
  assert.equal(fs.readFileSync(portFile, 'utf8'), String(a.port), 'the port file tells hooks where to send');

  const live = listen(a.port);
  await tick(100);
  const big = 'x'.repeat(2_000_000);
  const res = await post(a.port, { hook_event_name: 'PreToolUse', session_id: 'S', cwd: path.join(tmp, 'my-project'), tool_name: 'Write', tool_use_id: 'T', tool_input: { file_path: 'a', content: big, description: 'd' } });
  assert.equal(res.status, 204);
  const [e] = await live;
  assert.deepEqual([e.hook_event_name, e.tool_name, e.tool_input.description, e.tool_input.content, e.tool_input.file_path], ['PreToolUse', 'Write', 'd', undefined, undefined], 'file contents are not streamed');
  assert.deepEqual([e.project, e.cwd], ['my-project', undefined], 'only the folder name, not its path');
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

  // --- what the to-do board, the file list and the context gauge need ---
  const board = watch(a.port);
  await tick(100);
  const proj = path.join(tmp, 'my-project');
  await post(a.port, { hook_event_name: 'PostToolUse', session_id: 'K', cwd: proj, tool_name: 'TaskCreate', tool_use_id: 'K1', tool_input: { subject: 'Write tests', description: 'details', activeForm: 'Writing tests' }, tool_response: { task: { id: 1, subject: 'Write tests' } } });
  await post(a.port, { hook_event_name: 'PostToolUse', session_id: 'K', cwd: proj, tool_name: 'Edit', tool_use_id: 'K2', tool_input: { file_path: path.join(proj, 'src', 'a.js'), old_string: 'x', new_string: 'y' } });
  await post(a.port, { hook_event_name: 'PostToolUse', session_id: 'K', cwd: proj, tool_name: 'Write', tool_use_id: 'K3', tool_input: { file_path: path.join(os.homedir(), 'notes.txt'), content: 'secret' } });
  fs.appendFileSync(transcript, '{"type":"assistant","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000,"output_tokens":40}}}\n');
  await post(a.port, { hook_event_name: 'Stop', session_id: 'S2', transcript_path: transcript, stop_hook_active: false });
  fs.appendFileSync(transcript, '{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":3250,"postTokens":900}}\n');
  await post(a.port, { hook_event_name: 'PostCompact', session_id: 'S2', transcript_path: transcript, trigger: 'auto' });
  await tick(150);
  const [made, edited, outside2, stop, compact] = board.got.slice(-5);
  board.close();
  assert.deepEqual([made.tool_input.subject, made.tool_input.activeForm, made.tool_response.task], ['Write tests', 'Writing tests', { id: '1', subject: 'Write tests' }], 'the to-do list');
  assert.deepEqual([edited.file, edited.tool_input.new_string], ['src/a.js', undefined], 'a file edited: its path in the project, not its contents');
  assert.equal(outside2.file, '~/notes.txt', 'outside the project: from the home folder');
  assert.deepEqual([stop.context, stop.model], [3250, 'claude-haiku-5-5'], 'context = everything the last answer was given and wrote');
  assert.equal(compact.context, 900, 'after compacting, what is left');

  // --- subscription usage from the status line script: passed on when it changes, and the script itself ---
  const gauge = watch(a.port);
  await tick(100);
  const status = body => request(a.port, { method: 'POST', path: '/status', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const limits = (five, week) => ({ session_id: 'S', rate_limits: { five_hour: { used_percentage: five, resets_at: 1800000000 }, seven_day: { used_percentage: week, resets_at: 1800500000 } } });
  assert.equal((await status(limits(33.4, 61))).status, 204);
  await status(limits(33.2, 61)); // same whole percentages: nothing new
  await status({ session_id: 'S' }); // a status line before the first API response: no rate_limits
  await status(limits(34, 61));
  await tick(100);
  assert.deepEqual(gauge.got.filter(x => x.hook_event_name === 'Usage').map(x => [x.usage.five.pct, x.usage.week.pct, x.usage.five.resets]), [[33, 61, 1800000000], [34, 61, 1800000000]]);
  assert.equal(gauge.got.at(-1).session_id, undefined, 'account-wide: belongs to no floor');
  const script = path.join(process.env.AGENT_OFFICE_HOME, 'statusline.js');
  assert.ok(fs.existsSync(script), 'the office puts the status line script where a claude setting can name it');
  const { spawn } = require('child_process');
  const run = (input, env) => new Promise(ok => {
    const p = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', () => ok(out.trim()));
    p.stdin.end(input);
  });
  assert.equal(await run(JSON.stringify(limits(50, 70)), { AGENT_OFFICE_STATUSLINE: 'echo my-own-line', AGENT_OFFICE_SHELL: 'bash' }), 'my-own-line', 'then it shows your own status line');
  await tick(100);
  assert.deepEqual([gauge.got.at(-1).usage.five.pct, gauge.got.at(-1).usage.week.pct], [50, 70], 'the script passed the usage on');
  assert.equal(await run('not json', {}), '', 'bad input: says nothing, breaks nothing');
  gauge.close();

  // --- answering a permission prompt from the office ---
  const origin = `http://127.0.0.1:${a.port}`;
  const ask = (command, extra = {}) => request(a.port, { method: 'POST', path: '/permission', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'P', tool_name: 'Bash', tool_input: { command }, ...extra }) });
  const decide = (id, behavior, headers = { Origin: origin }) => request(a.port, { method: 'POST', path: '/decide', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ id, behavior }) });
  const askedFor = (page, command) => page.got.find(x => x.hook_event_name === 'PermissionRequest' && x.ask === command);
  const doneFor = (page, id) => page.got.find(x => x.hook_event_name === 'PermissionDone' && x._perm === id);

  await tick(100); // the pages above have closed
  let t0 = Date.now();
  assert.equal((await ask('nobody looking')).status, 204, 'no office page open: the hook returns at once');
  assert.ok(Date.now() - t0 < 1000);

  const office = watch(a.port);
  await tick(100);
  const allowed = ask('npm install left-pad');
  await tick(100);
  const q = askedFor(office, 'npm install left-pad');
  assert.ok(q && q._perm, 'the page gets the question with an id to answer');
  assert.equal((await decide(q._perm, 'allow', {})).status, 403, 'no Origin: not the office page');
  assert.equal((await decide(q._perm, 'allow', { Origin: 'http://evil.example' })).status, 403, 'another site');
  assert.equal((await decide('nope', 'allow')).status, 409);
  assert.equal((await decide(q._perm, 'maybe')).status, 409);
  assert.equal((await decide(q._perm, 'allow')).status, 204);
  const reply = await allowed;
  assert.deepEqual([reply.status, JSON.parse(reply.body)], [200, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }], "the hook prints claude's allow");
  await tick(50);
  assert.equal(doneFor(office, q._perm).behavior, 'allow', 'every page hears it was answered');
  assert.equal((await decide(q._perm, 'deny')).status, 409, 'answered once only');

  const denied = ask('rm -rf build');
  await tick(100);
  await decide(askedFor(office, 'rm -rf build')._perm, 'deny');
  const no = JSON.parse((await denied).body).hookSpecificOutput.decision;
  assert.deepEqual([no.behavior, typeof no.message], ['deny', 'string'], 'a deny tells claude why');

  // answered in the terminal: the tool's PostToolUse lets the hook go, another tool's does not
  let settled = false;
  const viaTerminal = ask('touch b.txt').then(r => ((settled = true), r));
  await tick(100);
  const tq = askedFor(office, 'touch b.txt');
  await post(a.port, { hook_event_name: 'PostToolUse', session_id: 'P', tool_name: 'Bash', tool_use_id: 'X1', tool_input: { command: 'ls' } });
  await tick(100);
  assert.equal(settled, false, "another tool's result is not the answer");
  await post(a.port, { hook_event_name: 'PostToolUse', session_id: 'P', tool_name: 'Bash', tool_use_id: 'X2', tool_input: { command: 'touch b.txt' } });
  assert.equal((await viaTerminal).status, 204, 'no decision: the terminal answered');
  await tick(50);
  assert.equal(doneFor(office, tq._perm).behavior, 'terminal');

  // the same hook registered twice (plugin + --settings): both copies get the answer
  const twin = () => ask('npm publish', { agent_id: 'sub1' });
  const [copy1, copy2] = [twin(), twin()];
  await tick(100);
  assert.equal(office.got.filter(x => x.ask === 'npm publish').length, 1, 'asked once on the page');
  await decide(askedFor(office, 'npm publish')._perm, 'allow');
  assert.deepEqual([(await copy1).status, (await copy2).status], [200, 200]);

  // the hook killed by claude (its timeout, or claude quit): the question goes away
  const gone = http.request({ host: '127.0.0.1', port: a.port, method: 'POST', path: '/permission', headers: { 'Content-Type': 'application/json' } });
  gone.on('error', () => {});
  gone.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'P', tool_name: 'Bash', tool_input: { command: 'sleep 1000' } }));
  await tick(100);
  const gq = askedFor(office, 'sleep 1000');
  gone.destroy();
  await tick(100);
  assert.equal(doneFor(office, gq._perm).behavior, 'gone');

  // closing the office lets a waiting hook go at once, back to claude's own dialog
  const left = ask('git push');
  await tick(100);
  t0 = Date.now();
  await a.close();
  assert.equal((await left).status, 204);
  office.close();
  assert.ok(!fs.existsSync(portFile), 'closing removes the port file, so hooks go quiet');

  // the hooks the plugin installs: one silent async command per event the office uses
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const used = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'PostModelSwitch', 'SessionEnd'];
  assert.deepEqual(Object.keys(hooks).sort(), used.sort());
  const { PermissionRequest: [{ hooks: [asker] }], ...rest } = hooks;
  const commands = new Set(Object.values(rest).map(([{ hooks: [h] }]) => (assert.equal(h.async, true), assert.equal(h.type, 'command'), h.command)));
  assert.equal(commands.size, 1, 'every other event uses the same command');
  assert.match([...commands][0], /\.agent-office\/port.*exit 0$/);
  // the permission prompt's hook waits for the office's answer and prints it, so it can't be async
  assert.deepEqual([asker.type, asker.async], ['command', undefined]);
  assert.match(asker.command, /\.agent-office\/port.*\/permission".*exit 0$/);
  // the PowerShell variant (Windows without Git Bash) covers the same events, run by PowerShell
  const ps = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin-powershell', 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(ps).sort(), used.sort());
  for (const [e, [{ hooks: [h] }]] of Object.entries(ps)) assert.deepEqual([h.type, h.async, h.shell, h.command.includes('/permission')], ['command', e === 'PermissionRequest' ? undefined : true, 'powershell', e === 'PermissionRequest']);
  const versions = ['package.json', 'plugin/.claude-plugin/plugin.json', 'plugin-powershell/.claude-plugin/plugin.json'].map(f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).version);
  const market = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'marketplace.json'), 'utf8')).plugins.map(p => p.version);
  assert.equal(new Set([...versions, ...market]).size, 1, `one version everywhere: ${versions} / ${market}`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('server ok');
})().catch(err => { console.error(err); process.exit(1); });
