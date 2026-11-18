// Left: claude in terminal tabs, one claude session per tab. Right: the shared office page (served by the core server) in
// an iframe, showing the floor of the tab in front.
const params = new URLSearchParams(location.search);
const frame = document.getElementById('office');
const officeOrigin = new URL(params.get('office')).origin;
frame.src = params.get('office');
const toOffice = (kind, value) => frame.contentWindow?.postMessage({ agentOffice: kind, value }, officeOrigin);

const tabsEl = document.getElementById('tabs');
const termsEl = document.getElementById('terms');
// English unless the app's language is Korean: the same test the office page in the iframe makes
const korean = /^ko\b/i.test(navigator.language);
const T = (en, ko) => (korean ? ko : en);
if (korean) { document.documentElement.lang = 'ko'; tabsEl.setAttribute('aria-label', 'claude 세션'); frame.title = '에이전트 사무실'; }
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
      x.setAttribute('aria-label', T(`Close tab ${i + 1} (ends its claude)`, `${i + 1}번 탭 닫기 (claude 종료)`));
      tab.append(x);
    }
    return tab;
  });
  const add = button('add', T('+ New session', '+ 새 세션'), newSession);
  add.title = T('Pick a folder and run another claude there. The office gets one more floor.', '폴더를 골라 claude를 하나 더 실행해요. 사무실에 층이 하나 생겨요.');
  const quick = document.createElement('div');
  quick.className = 'quick';
  quick.append(...QUICK.map(([text, title, run]) => { const b = button('', text, run); b.title = title; return b; }));
  tabsEl.replaceChildren(...items, add, quick);
  toOffice('sessions', [...tabs.values()].map(x => x.session).filter(Boolean)); // so a floor tab clicked there can bring its terminal tab here
}

// Quick buttons for the tab in front. Ctrl+U first empties claude's input line, so a command isn't glued to half-typed
// text; Enter waits until claude's command menu has caught up.
function command(text) {
  const id = active, t = tabs.get(id);
  if (!t?.alive) return;
  bridge.write(id, '\x15');
  setTimeout(() => bridge.write(id, text), 150);
  setTimeout(() => bridge.write(id, '\r'), 800);
  t.term.focus();
}
// claude is mid-turn when its footer says "esc to interrupt"; Esc on an idle prompt would bring back the last command
function working(t) {
  const b = t.term.buffer.active;
  for (let i = b.length - 1, seen = 0; i >= 0 && seen < 12; i--) {
    const line = b.getLine(i)?.translateToString(true) || '';
    if (!line.trim()) continue;
    seen++;
    if (/esc to interrupt/i.test(line)) return true;
  }
  return false;
}
const QUICK = [
  [T('Stop', '중단'), T("Stops claude's turn (Esc). Only sent while claude is working.", 'claude가 하던 일을 멈춰요 (Esc). 일하는 중일 때만 보내요.'), () => { const t = tabs.get(active); if (t?.alive && working(t)) bridge.write(active, '\x1b'); t?.term.focus(); }],
  ['/compact', T('Summarizes the conversation to free up context', '대화를 요약해서 컨텍스트를 줄여요'), () => command('/compact')],
  ['/clear', T('Clears the conversation and starts over. The office floor stays.', '대화를 지우고 새로 시작해요. 사무실 층은 그대로예요.'), () => { if (confirm(T("Clear this tab's conversation and start over? (/clear)", '이 탭의 대화를 지우고 새로 시작할까요? (/clear)'))) command('/clear'); else tabs.get(active)?.term.focus(); }],
];

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
  renderTabs();
});
bridge.onData((id, d) => tabs.get(id)?.term.write(d));
bridge.onExit(id => {
  const t = tabs.get(id);
  if (!t) return;
  t.alive = false;
  t.term.write(`\r\n\x1b[90m[${T('claude ended — press any key to start it again', 'claude 종료됨 — 아무 키나 누르면 다시 시작')}]\x1b[0m\r\n`);
});

window.addEventListener('message', m => {
  if (m.origin !== officeOrigin || !m.data) return;
  if (m.data.agentOffice === 'flash') bridge.flash();
  else if (m.data.agentOffice === 'focus-terminal') tabs.get(active)?.term.focus();
  else if (m.data.agentOffice === 'raise') bridge.raise(); // a notification was clicked
  else if (m.data.agentOffice === 'tab') { // a floor tab clicked in the office: its terminal tab comes to the front
    const id = [...tabs].find(([, t]) => t.session === m.data.value)?.[0];
    if (id) show(id);
  }
});
bridge.onWindowFocus(focused => toOffice('focus', focused));
// the first message can arrive before the office page has loaded: tell it again once it has
frame.addEventListener('load', () => { const s = tabs.get(active)?.session; if (s) toOffice('session', s); });

// Refit once the size settles: every pty resize makes claude redraw its screen, so not on every frame of a drag.
let refit;
new ResizeObserver(() => {
  clearTimeout(refit);
  refit = setTimeout(() => { const t = tabs.get(active); if (t) { t.fit.fit(); bridge.resize(active, t.term.cols, t.term.rows); } }, 80);
}).observe(termsEl);

// The bar between the terminal and the office: drag it (or arrow keys on it) to share the width; double-click resets.
const left = document.getElementById('left'), split = document.getElementById('split');
split.setAttribute('aria-label', T('Resize the terminal and the office', '터미널과 사무실 크기 조절'));
split.title = T('Drag to resize. Double-click resets it.', '끌어서 크기를 조절해요. 더블클릭하면 처음대로.');
split.setAttribute('aria-valuemin', 20);
split.setAttribute('aria-valuemax', 80);
function setSplit(pct) {
  pct = Math.min(80, Math.max(20, pct));
  left.style.flexBasis = `${pct}%`;
  split.setAttribute('aria-valuenow', Math.round(pct));
  try { localStorage.setItem('split', pct); } catch {}
}
let savedSplit = 55;
try { savedSplit = Number(localStorage.getItem('split')) || 55; } catch {}
setSplit(savedSplit);
split.addEventListener('pointerdown', e => { split.setPointerCapture(e.pointerId); document.body.classList.add('dragging'); });
split.addEventListener('pointermove', e => { if (split.hasPointerCapture(e.pointerId)) setSplit((e.clientX / innerWidth) * 100); });
split.addEventListener('lostpointercapture', () => { document.body.classList.remove('dragging'); tabs.get(active)?.term.focus(); });
split.addEventListener('dblclick', () => setSplit(55));
split.addEventListener('keydown', e => {
  const step = { ArrowLeft: -2, ArrowRight: 2 }[e.key];
  if (step) { e.preventDefault(); setSplit(parseFloat(left.style.flexBasis) + step); }
});
newTab(params.get('cwd'));
