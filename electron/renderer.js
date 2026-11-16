// Left: real claude in xterm. Right: the shared office page (served by the core server) in an iframe.
const termEl = document.getElementById('term');
const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 14, cursorBlink: true, theme: { background: '#1e1e2e' } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(termEl);
fit.fit();
// Let the browser do Ctrl+V paste and Ctrl+C copy (when text is selected) instead of sending control chars.
term.attachCustomKeyEventHandler(e => !(e.type === 'keydown' && e.ctrlKey && (e.key === 'v' || (e.key === 'c' && term.hasSelection()))));

const frame = document.getElementById('office');
const officeUrl = new URLSearchParams(location.search).get('office');
const officeOrigin = new URL(officeUrl).origin;
frame.src = officeUrl;
const toOffice = (kind, value) => frame.contentWindow?.postMessage({ agentOffice: kind, value }, officeOrigin);
window.addEventListener('message', m => {
  if (m.origin !== officeOrigin || !m.data) return;
  if (m.data.agentOffice === 'flash') bridge.flash();
  else if (m.data.agentOffice === 'focus-terminal') term.focus();
});
bridge.onWindowFocus(focused => toOffice('focus', focused));

let alive = true;
bridge.onData(d => term.write(d));
bridge.onExit(() => {
  alive = false;
  term.write('\r\n\x1b[90m[claude 종료됨 — 아무 키나 누르면 다시 시작]\x1b[0m\r\n');
});
term.onData(d => {
  if (alive) return bridge.write(d);
  alive = true;
  term.reset();
  toOffice('reset');
  bridge.start(term.cols, term.rows);
});

new ResizeObserver(() => { fit.fit(); bridge.resize(term.cols, term.rows); }).observe(termEl);
bridge.start(term.cols, term.rows);
term.focus();
