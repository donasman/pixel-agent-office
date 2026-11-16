// Checks the npx entry: it serves, keeps running while an office page is open, then stops by itself
// once the page goes away and removes the port file (so the hooks go quiet).
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-cli-'));
const portFile = path.join(home, 'port');
const cli = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'pixel-agent-office.js'), '--no-open'], {
  env: { ...process.env, AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: '0', AGENT_OFFICE_IDLE_MS: '800' },
  stdio: 'ignore',
});
const exit = new Promise(ok => cli.on('exit', () => ok(true)));
const wait = ms => new Promise(ok => setTimeout(ok, ms));

(async () => {
  let port;
  for (let i = 0; i < 50 && !port; i++) { await wait(100); try { port = fs.readFileSync(portFile, 'utf8'); } catch {} }
  assert.ok(port, 'started and wrote its port file');

  const page = http.get({ host: '127.0.0.1', port, path: '/stream' });
  page.on('error', () => {}); // destroyed below on purpose
  await wait(2000);
  assert.equal(cli.exitCode, null, 'keeps running while a page is open (longer than the idle grace)');

  page.destroy(); // the window closes
  assert.ok(await Promise.race([exit, wait(5000).then(() => false)]), 'stops by itself after the page closes');
  assert.ok(!fs.existsSync(portFile), 'and removes the port file');

  fs.rmSync(home, { recursive: true, force: true });
  console.log('cli ok');
})().catch(err => { cli.kill(); console.error(err); process.exit(1); });
