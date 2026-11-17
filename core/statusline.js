// Claude Code status line for Agent Office. Claude hands a status line its subscription usage (rate_limits: the 5-hour
// and weekly windows) and nothing else does, so this passes that on to the office while it's open, then prints the
// status line you had before (the command in AGENT_OFFICE_STATUSLINE), or nothing.
// Setup: "statusLine": { "type": "command", "command": "node ~/.agent-office/statusline.js" } (the office copies this
// file there each time it starts; the desktop app sets it up for the claude it runs).
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', async () => {
  const input = Buffer.concat(chunks);
  await report(input);
  const own = process.env.AGENT_OFFICE_STATUSLINE;
  if (own) {
    const shell = process.env.AGENT_OFFICE_SHELL === 'powershell' ? ['powershell.exe', ['-NoProfile', '-Command', own]] : ['bash', ['-c', own]];
    const r = spawnSync(shell[0], shell[1], { input, timeout: 5000 });
    if (r.stdout) process.stdout.write(r.stdout);
  }
});

function report(input) {
  return new Promise(done => {
    let e, port;
    try {
      e = JSON.parse(input.toString('utf8'));
      port = fs.readFileSync(path.join(process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), '.agent-office'), 'port'), 'utf8').trim();
    } catch { return done(); } // the office isn't open
    if (!e || !e.rate_limits) return done();
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/status', headers: { 'Content-Type': 'application/json' }, timeout: 300 }, res => { res.resume(); res.on('end', done); });
    r.on('error', done);
    r.on('timeout', () => { r.destroy(); done(); });
    r.end(JSON.stringify({ session_id: e.session_id, rate_limits: e.rate_limits }));
  });
}
