// Linux/macOS end to end, run by .github/workflows/test.yml (it needs POSIX shells, so it's not part of npm test):
// - the one-line install, when the claude CLI is on PATH: the viewer in a terminal asks, installs the plugin from the
//   GitHub marketplace, and doesn't ask again;
// - the hooks in plugin/hooks/hooks.json, run by sh, bash and zsh the way Claude Code runs them (event JSON on stdin),
//   reach a running office; a permission prompt answered in the office goes back to the hook; with the office
//   closed every hook exits at once and prints nothing.
// Runs under a throwaway HOME on port 47199, so it never touches a real office or a real claude setup.
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-unix-'));
const env = { ...process.env, HOME: home, AGENT_OFFICE_PORT: '47199' };
const bin = path.join(__dirname, '..', 'bin', 'pixel-agent-office.js');
const portFile = path.join(home, '.agent-office', 'port');
const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf8')).hooks;
const command = ev => hooks[ev][0].hooks[0].command;
const shells = ['sh', 'bash', 'zsh'].filter(sh => spawnSync(sh, ['-c', 'exit 0']).status === 0);
const wait = ms => new Promise(ok => setTimeout(ok, ms));
const until = async (f, ms = 5000) => { for (let t = 0; t < ms; t += 50) { const v = f(); if (v) return v; await wait(50); } };
const claude = args => spawnSync(`claude ${args}`, { shell: true, encoding: 'utf8', env });

// The viewer in a real terminal: `script` gives it a pty (util-linux and BSD take different arguments).
function inTerminal(cmd) {
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', 'sh', '-c', cmd] : ['-qec', cmd, '/dev/null'];
  const p = spawn('script', args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '', asked = false;
  p.stdout.on('data', d => { out += d; if (!asked && /\[Y\/n\]/.test(out)) { asked = true; p.stdin.write('\r'); } });
  const timer = setTimeout(() => p.kill(), 180000);
  return new Promise(ok => p.on('exit', code => { clearTimeout(timer); ok({ code, asked, out }); }));
}

const server = spawn(process.execPath, [bin, '--no-open'], { env, stdio: 'ignore' });
const seen = [];

(async () => {
  const port = await until(() => { try { return fs.readFileSync(portFile, 'utf8').trim(); } catch {} });
  assert.equal(port, '47199', 'the office started and wrote its port file');
  http.get({ host: '127.0.0.1', port, path: '/stream' }, res => { // an office page, as far as the server knows
    let buf = '';
    res.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) if (buf.startsWith('data: ')) seen.push(JSON.parse(buf.slice(6, i)));
    });
  });
  await wait(300);

  if (claude('--version').status === 0) {
    const first = await inTerminal(`"${process.execPath}" "${bin}" --no-open`);
    assert.ok(first.asked && first.code === 0, `the first run asks and finishes:\n${first.out}`);
    const ids = JSON.parse(claude('plugin list --json').stdout).map(p => p.id);
    assert.ok(ids.includes('agent-office@agent-office'), `the plugin is installed: ${ids}`);
    const again = await inTerminal(`"${process.execPath}" "${bin}" --no-open`);
    assert.ok(!again.asked && again.code === 0, `the second run doesn't ask:\n${again.out}`);
    console.log('one-line install ok');
  } else console.log('one-line install skipped: no claude CLI');

  for (const sh of shells) {
    const base = { session_id: `${sh}-test`, cwd: path.join(home, 'my-app'), transcript_path: path.join(home, 'none.jsonl') };
    const got = ev => until(() => seen.find(m => m.session_id === base.session_id && m.hook_event_name === ev && (ev !== 'PermissionRequest' || m._perm)));
    for (const e of [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'hi' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'u1' },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'u1', tool_response: {} },
      { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
      { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' },
    ]) {
      const r = spawnSync(sh, ['-c', command(e.hook_event_name)], { env, input: JSON.stringify({ ...base, ...e }), encoding: 'utf8' });
      assert.ok(r.status === 0 && !r.stdout, `${sh}: ${e.hook_event_name} hook exits 0 silently`);
      assert.ok(await got(e.hook_event_name), `${sh}: ${e.hook_event_name} reaches the office`);
    }

    const ask = spawn(sh, ['-c', command('PermissionRequest')], { env });
    let answer = '';
    ask.stdout.on('data', d => { answer += d; });
    const exited = new Promise(ok => ask.on('exit', ok));
    ask.stdin.end(JSON.stringify({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }));
    const q = await got('PermissionRequest');
    assert.ok(q, `${sh}: the permission prompt shows in the office`);
    const status = await new Promise(ok => http.request({ host: '127.0.0.1', port, path: '/decide', method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } }, res => { res.resume(); ok(res.statusCode); })
      .end(JSON.stringify({ id: q._perm, behavior: 'allow' })));
    assert.equal(status, 204, `${sh}: the office's answer is taken`);
    assert.equal(await Promise.race([exited, wait(5000)]), 0, `${sh}: the waiting hook returns`);
    assert.match(answer, /"behavior":"allow"/, `${sh}: the hook hands claude the office's answer`);
  }

  fs.renameSync(portFile, portFile + '.off'); // the office is closed
  for (const sh of shells) for (const ev of ['PreToolUse', 'PermissionRequest']) {
    const t = Date.now(), r = spawnSync(sh, ['-c', command(ev)], { env, input: `{"hook_event_name":"${ev}"}`, encoding: 'utf8' });
    assert.ok(r.status === 0 && !r.stdout && !r.stderr && Date.now() - t < 1000, `${sh}: ${ev} with the office closed exits at once, quietly`);
  }
  console.log(`hooks ok (${shells.join(', ')})`);
  server.kill();
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
})().catch(err => { console.error(err); server.kill(); process.exit(1); });
