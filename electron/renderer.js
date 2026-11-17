// Left: claude in terminal tabs, one claude session per tab. Right: the shared office page (served by the core server) in
// an iframe, showing the floor of the tab in front.
const params = new URLSearchParams(location.search);
const frame = document.getElementById('office');
const officeOrigin = new URL(params.get('office')).origin;
frame.src = params.get('office');
const toOffice = (kind, value) => frame.contentWindow?.postMessage({ agentOffice: kind, value }, officeOrigin);

const tabsEl = document.getElementById('tabs');
const termsEl = document.getElementById('terms');
const tabs = new Map(); // id -> { term, fit, el, cwd, session, alive }
let active = null, nextId = 1;
const folderName = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
const button = (cls, text, onClick) => { const b = document.createElement('button'); b.className = cls; b.textContent = text; b.addEventListener('click', onClick); return b; };

function renderTabs() {
  const items = [...tabs].map(([id, t], i) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(id === active));
    const name = button('name', `${i + 1} ${folderName(t.cwd)}`, () => show(id));
    name.title = t.cwd;
    tab.append(name);
    if (tabs.size > 1) {
      const x = button('close', '×', () => closeTab(id));
      x.setAttribute('aria-label', `${i + 1}번 탭 닫기 (claude 종료)`);
      tab.append(x);
    }
    return tab;
  });
  const add = button('add', '+ 새 세션', newSession);
  add.title = '폴더를 골라 claude를 하나 더 실행해요. 사무실에 층이 하나 생겨요.';
  tabsEl.replaceChildren(...items, add);
}

function show(id) {
  const t = tabs.get(id);
  if (!t) return;
  active = id;
  for (const [k, x] of tabs) x.el.hidden = k !== id;
  t.fit.fit();
  bridge.resize(id, t.term.cols, t.term.rows);
  t.term.focus();
  document.title = `Agent Office — ${t.cwd}`;
  if (t.session) toOffice('session', t.session); // the office shows this tab's floor
  renderTabs();
}

function newTab(cwd) {
  const id = nextId++, el = document.createElement('div');
  el.className = 'term';
  termsEl.append(el);
  for (const x of tabs.values()) x.el.hidden = true; // open the new terminal visible, so it measures right
  const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 14, cursorBlink: true, theme: { background: '#1e1e2e' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // Let the browser do Ctrl+V paste and Ctrl+C copy (when text is selected) instead of sending control chars.
  term.attachCustomKeyEventHandler(e => !(e.type === 'keydown' && e.ctrlKey && (e.key === 'v' || (e.key === 'c' && term.hasSelection()))));
  const t = { term, fit, el, cwd, session: null, alive: true };
  tabs.set(id, t);
  term.onData(d => {
    if (t.alive) return bridge.write(id, d);
    t.alive = true;
    term.reset();
    bridge.start(id, cwd, term.cols, term.rows); // a new session: the office reopens this folder's floor for it
  });
  show(id);
  bridge.start(id, cwd, term.cols, term.rows);
}

async function newSession() {
  const cwd = await bridge.pickFolder(tabs.get(active)?.cwd);
  if (cwd) newTab(cwd);
  else tabs.get(active)?.term.focus();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t || tabs.size < 2) return;
  bridge.close(id); // ends its claude; its floor closes
  t.term.dispose();
  t.el.remove();
  tabs.delete(id);
  if (active === id) show([...tabs.keys()].pop());
  else renderTabs();
}

bridge.onSession((id, session) => {
  const t = tabs.get(id);
  if (!t) return;
  t.session = session;
  if (id === active) toOffice('session', session);
});
bridge.onData((id, d) => tabs.get(id)?.term.write(d));
bridge.onExit(id => {
  const t = tabs.get(id);
  if (!t) return;
  t.alive = false;
  t.term.write('\r\n\x1b[90m[claude 종료됨 — 아무 키나 누르면 다시 시작]\x1b[0m\r\n');
});

window.addEventListener('message', m => {
  if (m.origin !== officeOrigin || !m.data) return;
  if (m.data.agentOffice === 'flash') bridge.flash();
  else if (m.data.agentOffice === 'focus-terminal') tabs.get(active)?.term.focus();
  else if (m.data.agentOffice === 'raise') bridge.raise(); // a notification was clicked
});
bridge.onWindowFocus(focused => toOffice('focus', focused));
// the first message can arrive before the office page has loaded: tell it again once it has
frame.addEventListener('load', () => { const s = tabs.get(active)?.session; if (s) toOffice('session', s); });

new ResizeObserver(() => { const t = tabs.get(active); if (t) { t.fit.fit(); bridge.resize(active, t.term.cols, t.term.rows); } }).observe(termsEl);
newTab(params.get('cwd'));
