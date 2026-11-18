#!/usr/bin/env node
// npx pixel-agent-office: start the office server (or find the one already running) and open it in an app window.
// Stops by itself once every office window has been closed, which removes the port file and quiets the hooks.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { start } = require('../core/server');
const gitBash = require('../core/git-bash');

const IDLE_MS = Number(process.env.AGENT_OFFICE_IDLE_MS || 15000); // grace period: a page reload reconnects well within it

// A Chromium browser can open the page as an app window (no tabs, no address bar); otherwise use the default browser.
function appBrowser() {
  const env = process.env;
  const candidates = {
    win32: [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean).flatMap(dir => [
      path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]),
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser'].flatMap(b => (env.PATH || '').split(':').filter(Boolean).map(d => path.join(d, b))),
  }[process.platform] || [];
  return candidates.find(f => fs.existsSync(f));
}

function openWindow(url) {
  const browser = appBrowser();
  const [cmd, args] = browser ? [browser, [`--app=${url}`, '--window-size=960,720']]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] // '' = start's window title, quoted to "" by node
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => console.log(`Open ${url} in your browser.`)).unref();
}

// The one-line install: the plugin's hooks are what feed the office, so a run in a terminal offers to install the
// plugin with claude's own CLI when it's missing. (The commands are constants: nothing user-given reaches the shell.)
const PLUGIN = `${process.platform === 'win32' && !gitBash ? 'agent-office-powershell' : 'agent-office'}@agent-office`;
const claude = (args, stdio) => spawnSync(`claude ${args}`, { shell: true, encoding: 'utf8', stdio }); // shell: claude may be a .cmd
const byHand = `In Claude Code, run:\n  /plugin marketplace add donasman/pixel-agent-office\n  /plugin install ${PLUGIN}`;

async function offerPlugin() {
  let installed;
  try { installed = JSON.parse(claude('plugin list --json', 'pipe').stdout).map(p => p.id); } catch {
    return console.log(`\nCouldn't run the claude command to check for the Agent Office plugin. ${byHand}`);
  }
  if (installed.some(id => /^agent-office(-powershell)?@agent-office$/.test(id))) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => process.exit(0));
  console.log(`\nThe office needs the Claude Code plugin ${PLUGIN} to see claude at work.`);
  const answer = await new Promise(ok => rl.question('Install it now? [Y/n] ', ok));
  rl.close();
  if (/^n/i.test(answer.trim())) return console.log(`Not installed. To install it later: ${byHand}`);
  // shortcut: a marketplace added long ago isn't refreshed here, so an old copy of it installs an old version
  claude('plugin marketplace add donasman/pixel-agent-office', 'inherit');
  if (claude(`plugin install ${PLUGIN}`, 'inherit').status !== 0) return console.log(`The install didn't finish. ${byHand}`);
  console.log('Done. Restart any claude that was already running; claude started from now on shows up in the office.');
}

(async () => {
  const office = await start();
  const url = `http://127.0.0.1:${office.port}/`;
  if (!process.argv.includes('--no-open')) openWindow(url);
  if (office.attached) console.log(`Agent Office is already running: ${url}`);
  else {
    console.log(`Agent Office: ${url}\nCtrl+C stops it. Closing the office window stops it too.`);
    process.on('SIGINT', () => process.exit(0)); // process.exit runs the handler that removes the port file
    let seen = false, idleSince = 0;
    setInterval(() => {
      if (office.pages() > 0) { seen = true; idleSince = 0; return; }
      if (!seen) return; // --no-open, or the window hasn't connected yet
      idleSince ||= Date.now();
      if (Date.now() - idleSince >= IDLE_MS) { console.log('The office window was closed: stopping.'); process.exit(0); }
    }, 500);
  }
  if (process.stdin.isTTY && process.stdout.isTTY) await offerPlugin(); // can't ask in a script; the empty office shows how
})();
