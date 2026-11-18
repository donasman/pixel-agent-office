// Office page: hook events streamed by the core server -> a building with one floor per claude session -> the floor
// you're looking at is drawn, with its roster and info card; tabs switch floors. Sounds come from every floor.
// Runs alone in a browser, or inside the Electron app's iframe; there it talks to the app with postMessage.
const embedded = window.parent !== window;
// The parent can't be addressed by origin (a file:// page), so messages carry no data of ours; the one value ever sent
// back is a session id the app itself told us (appSessions).
const toShell = (kind, value) => { if (embedded) window.parent.postMessage({ agentOffice: kind, value }, '*'); };
const appSessions = new Set(); // the app's terminal tabs' claude sessions

// ---- language: English unless the browser's language is Korean. The page's own labels are English; Korean replaces
// them here (an attribute, or the text when none is named). Everything else picks with T(english, korean). ----
const T = Office.T;
const korean = Office.setLang(navigator.language);
const LOCALE = korean ? 'ko-KR' : 'en-US';
if (korean) {
  document.documentElement.lang = 'ko';
  for (const [sel, attr, text] of [
    ['#floors', 'aria-label', '층 (claude 세션)'],
    ['#follow', 'title', '일이 생긴 층으로 자동 이동'], ['#follow', '', '자동 이동'],
    ['#notify', 'title', '이 창을 안 보고 있을 때 승인 대기, 작업 완료, 멈춤을 윈도우 알림으로 알려 줘요'], ['#notify', '', '알림 켜기'],
    ['#theme', 'title', '사무실 테마 바꾸기'], ['#theme', '', '주간'],
    ['#mute', 'aria-label', '알림 소리 끄기'], ['#mute', 'title', '알림 소리 켜기/끄기'],
    ['#office', 'aria-label', '에이전트 사무실'], ['#tabs', 'aria-label', '아래 목록'],
    ['#card', 'aria-label', '캐릭터 정보'], ['#card-close', 'aria-label', '닫기'],
  ]) { const n = document.querySelector(sel); if (attr) n.setAttribute(attr, text); else n.textContent = text; }
}

let building = Office.createBuilding();
let current = null; // id of the floor on screen
let selected = null; // id of the character whose info card is open
let pinned = null; // the Electron app's tab in front runs this claude session: its floor is the one to show
let appFocused = embedded || document.hasFocus();
const EMPTY = Office.createState(); // drawn before any session has shown up
const floor = () => (current && building.floors[current]) || null;
const office = () => floor()?.state || EMPTY;

// Text nodes only below: task and report text come from the model.
const el = (tag, cls, ...kids) => { const n = document.createElement(tag); if (cls) n.className = cls; n.append(...kids); return n; };

// ---- floors ----
const floorsBar = document.getElementById('floors');
const followBtn = document.getElementById('follow');
let follow = !embedded; // the app shows its own terminal's floor; a browser follows the action
try { const saved = localStorage.getItem('follow'); if (saved) follow = saved === '1'; } catch {}
const showFollow = () => followBtn.setAttribute('aria-pressed', String(follow));
showFollow();
followBtn.addEventListener('click', () => {
  follow = !follow;
  try { localStorage.setItem('follow', follow ? '1' : '0'); } catch {}
  showFollow();
});

function show(id) {
  if (id === current) return;
  current = id;
  selected = null;
  const f = floor();
  document.title = f ? `${f.n}F ${f.project} — Agent Office` : 'Agent Office';
  renderAll();
}

// After an event on floor f: move there when it's the right thing to do.
function choose(f, e, replayed) {
  const pin = pinned && building.alias[pinned];
  if (pin && !follow) return show(pin);
  const cur = floor();
  if (!cur || replayed) return show(f.id); // nothing on screen yet, or catching up on history: end on the latest
  if (f.id === current || !follow) return;
  // someone needs you there, this floor is closed, or this floor has been quiet for 10s
  if (e.hook_event_name === 'PermissionRequest' || cur.closedAt || Date.now() - cur.lastAt > 10000) show(f.id);
}

function renderFloors() {
  const list = Object.values(building.floors).sort((a, z) => a.n - z.n);
  floorsBar.replaceChildren(...list.map(f => {
    const st = Office.floorStatus(f);
    const mark = st.waiting ? el('span', 'mark waiting', '?') : st.stuck ? el('span', 'mark stuck', '!') : st.working ? el('span', 'mark working', '●') : '';
    const tab = el('button', st.closed ? 'closed' : '', `${f.n}F ${f.project}`, mark);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(f.id === current));
    tab.title = st.closed ? T('Session ended', '세션 종료됨') : st.waiting ? T('Waiting for approval', '승인 대기 중') : st.stuck ? T('A tool has been running for a long time', '오래 안 끝나는 작업이 있음') : st.working ? T('Working', '일하는 중') : T('Idle', '대기 중');
    tab.addEventListener('click', () => pickFloor(f));
    return tab;
  }));
}

// A floor tab clicked. In the app: bring its terminal tab to the front if it has one; a floor of some other terminal
// stays on screen (unpinned) until the app's tab changes.
function pickFloor(f) {
  show(f.id);
  if (!embedded) return;
  const sid = [...appSessions].find(x => building.alias[x] === f.id);
  pinned = sid || null;
  if (sid) toShell('tab', sid);
}

// ---- roster and info card (the floor on screen) ----
const roster = document.getElementById('roster');
const nameOf = c => (c.kind === 'boss' ? 'Claude' : c.label || `${T('Staff', '직원')} ${c.desk}`);
const statusOf = c => Office.statusText(c.status) + (c.tool ? ` (${c.tool})` : '');
const lateOf = c => { const min = Math.floor(Office.stuckFor(c, Date.now()) / 60000); return min ? T(` ⚠ running for ${min} min`, ` ⚠ ${min}분째 안 끝남`) : ''; };
// A permission prompt the office can answer: what it's about, with allow / deny.
const firstShown = new Map(); // permission id -> when its buttons appeared: floors can switch under the cursor, so a click right after is ignored
function askRow(c) {
  const { id, tool, ask } = c.perm;
  if (!firstShown.has(id)) firstShown.set(id, Date.now());
  const answer = behavior => ev => {
    if (Date.now() - firstShown.get(id) < 700) return;
    const buttons = ev.currentTarget.parentElement.querySelectorAll('button');
    buttons.forEach(b => (b.disabled = true));
    const retry = () => buttons.forEach(b => (b.disabled = false));
    fetch('/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, behavior }) })
      .then(r => { if (!r.ok && r.status !== 409) retry(); }, retry); // 409: answered already; the PermissionDone event clears the row
  };
  const btn = (label, cls) => { const b = el('button', cls, label); b.addEventListener('click', answer(cls)); return b; };
  return el('li', 'ask', el('span', 'q', T('Approval needed', '승인 요청')), ` ${nameOf(c)}: ${tool} `, ask ? el('code', '', ask) : '', btn(T('Allow', '허용'), 'allow'), btn(T('Deny', '거부'), 'deny'));
}

// ---- the list under the office: people, claude's to-do list, files edited (plus any permission prompt, always) ----
const tabButtons = [...document.querySelectorAll('#tabs button')];
let tab = 'people';
try { tab = localStorage.getItem('tab') || 'people'; } catch {}
tabButtons.forEach(b => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  try { localStorage.setItem('tab', tab); } catch {}
  renderPanel();
}));

function personRow(c) {
  const dot = el('span', 'dot');
  dot.style.background = c.color;
  const late = lateOf(c);
  return el('li', '', dot, c.label + (c.task ? `: ${c.task}` : ''), el('span', 'st', ` — ${statusOf(c)}`), late ? el('span', 'late', late) : '');
}
const TICK = { completed: '✓', in_progress: '▶' };
function taskRow(t) {
  const li = el('li', `task ${t.status}`, el('span', 'tick', TICK[t.status] || '○'), t.status === 'in_progress' && t.active ? t.active : t.subject);
  li.title = t.subject;
  return li;
}
const fileRow = ([file, f]) => el('li', 'file', el('code', '', file), el('span', 'st', ` — ${f.by.join(', ')} · ${f.n}${T('×', '번')}`));
const hint = text => el('li', 'hint', text);
const clock = at => new Date(at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function copyButton(text) {
  const copy = el('button', 'copy', T('Copy', '복사'));
  copy.addEventListener('click', () => navigator.clipboard?.writeText(text).then(() => { copy.textContent = T('Copied', '복사됨'); }, () => { copy.textContent = T("Couldn't copy", '복사 안 됨'); }));
  return copy;
}
function reportRow(r) {
  const body = r.text ? el('pre', '', r.text) : el('p', 'hint', T('No report text arrived.', '보고 내용이 오지 않았어요.'));
  return el('li', 'report', el('details', '', el('summary', '', el('span', 'when', clock(r.at)), ` ${r.who}${r.task ? ` · ${r.task}` : ''}`), body, r.text ? copyButton(r.text) : ''));
}
// No claude session has shown up yet: how to connect claude to the office (the desktop app passes the hooks itself)
const setupRows = () => [
  hint(T('No word from claude yet. Its floor appears here once you start using claude. If this stays empty, install the plugin with the two commands below in Claude Code, then restart claude.',
    '아직 claude 소식이 없어요. claude를 쓰기 시작하면 여기 층이 생겨요. 계속 비어 있으면 Claude Code에서 아래 두 명령으로 플러그인을 설치하고 claude를 다시 시작하세요.')),
  ...['/plugin marketplace add donasman/pixel-agent-office', '/plugin install agent-office@agent-office'].map(cmd => el('li', 'setup', el('code', '', cmd), copyButton(cmd))),
  hint(T('On Windows without Git for Windows, run this instead of the second command: /plugin install agent-office-powershell@agent-office',
    'Git for Windows가 없는 Windows에서는 두 번째 명령 대신 /plugin install agent-office-powershell@agent-office')),
];
const logRow = j => el('li', 'log', el('span', 'when', clock(j.at)), el('span', 'who', ` ${j.who} `), j.text);

const tokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const ctxEl = document.getElementById('ctx');
function renderContext(s) {
  ctxEl.hidden = !s.context;
  if (!s.context) return;
  const win = Math.max(Office.windowOf(s.modelId), s.context), pct = Math.round((s.context / win) * 100);
  const fill = el('span', 'fill');
  Object.assign(fill.style, { width: `${pct}%`, background: pct >= 80 ? '#f38ba8' : pct >= 50 ? '#f9e2af' : '#a6e3a1' });
  ctxEl.title = T(`Claude's (the boss's) context: ${tokens(s.context)} / ${tokens(win)} tokens`, `Claude(보스)의 컨텍스트: ${tokens(s.context)} / ${tokens(win)} 토큰`);
  ctxEl.replaceChildren(`${T('Context', '컨텍스트')} ${pct}%`, el('span', 'bar', fill));
}

let rosterKey = '';
function renderPanel() {
  const s = office(), cs = Object.values(s.chars);
  const tasks = Object.values(s.tasks), done = tasks.filter(t => t.status === 'completed').length;
  const files = Object.entries(s.files).sort((a, z) => z[1].at - a[1].at);
  // the to-do tab only while claude keeps a list: Claude Code gives current models TaskCreate only with
  // CLAUDE_CODE_ENABLE_TODO_TOOLS=1 (older models, like Opus 4.7, by default)
  const view = tab === 'tasks' && !tasks.length ? 'people' : tab;
  const count = (name, n) => (n ? `${name} ${n}` : name);
  const label = { people: T('Staff', '직원'), tasks: `${T('To-do', '할 일')} ${done}/${tasks.length}`, files: count(T('Files', '파일'), files.length), reports: count(T('Reports', '보고서'), s.inbox.length), log: T('Log', '일지') };
  for (const b of tabButtons) {
    b.textContent = label[b.dataset.tab];
    b.hidden = b.dataset.tab === 'tasks' && !tasks.length;
    b.setAttribute('aria-selected', String(b.dataset.tab === view));
  }
  renderContext(s);
  const asks = cs.filter(c => c.perm && c.status === 'waiting'), people = cs.filter(c => c.kind === 'boss' || c.busy);
  const shown = view === 'tasks' ? tasks : view === 'files' ? files : view === 'reports' ? s.inbox.map(r => [r.at, r.text.length])
    : view === 'log' ? [s.journal.length, s.journal.at(-1)?.at] : people.map(c => [c.id, c.label, c.task, c.color, statusOf(c), lateOf(c)]);
  // rebuilt only when something shown changes, so buttons stay put under the cursor
  const key = JSON.stringify([current, view, asks.map(c => c.perm.id), shown]);
  if (key === rosterKey) return;
  rosterKey = key;
  const rows = !floor() && !embedded ? setupRows()
    : view === 'tasks' ? tasks.map(taskRow)
    : view === 'files' ? [...files.map(fileRow), hint(files.length
      ? T('Only files edited with Edit/Write are listed. Files changed by commands (Bash) are not.', 'Edit/Write로 고친 파일만 보여요. 명령(Bash)으로 바꾼 파일은 빠져요.')
      : T('Files claude edits with Edit/Write are listed here.', 'claude가 Edit/Write로 고친 파일이 여기 모여요.'))]
    : view === 'reports' ? (s.inbox.length ? s.inbox.map(reportRow) : [hint(T('Reports that subagents and teammates send back when they finish are collected here. Click one to read it in full.', '서브에이전트와 팀원이 일을 마치고 보낸 보고서가 여기 모여요. 누르면 전문이 보여요.'))])
    : view === 'log' ? (s.journal.length ? s.journal.slice().reverse().map(logRow) : [hint(T('What happens on this floor is logged here, in order.', '이 층에서 일어난 일이 시간순으로 쌓여요.'))])
    : people.map(personRow);
  roster.replaceChildren(...asks.map(askRow), ...rows);
}

const card = document.getElementById('card');
const cardBody = document.getElementById('card-body');
const mmss = ms => { const m = Math.floor(ms / 60000), sec = Math.floor(ms / 1000) % 60; return T(`${m}m ${sec}s`, `${m}분 ${sec}초`); };
function renderCard() {
  const s = office(), c = selected && s.chars[selected];
  card.hidden = !c;
  if (!c) return;
  const rows = [
    [T('Status', '상태'), statusOf(c) + lateOf(c)],
    [T('Task', '맡은 일'), c.task || '-'],
    [T('Last tools', '최근 도구'), c.history.join(' → ') || '-'],
    [T('Work time', '이번 근무'), c.status !== 'sleeping' && c.since ? mmss(Date.now() - c.since) : '-'],
  ];
  if (c.kind === 'boss') rows.push([T('Model', '모델'), c.model || '?'], [T('Context', '컨텍스트'), s.context ? `${tokens(s.context)} ${T('tokens', '토큰')}` : '-'], [T('Reports', '받은 보고서'), `${s.reports}${T('', '장')}`]);
  else rows.push([T('Jobs', '받은 업무'), `${c.jobs}${T('', '건')}`], [T('Last report', '마지막 보고'), c.lastReport || '-']);
  cardBody.replaceChildren(
    el('strong', '', c.kind === 'boss' ? T('Claude (boss)', 'Claude (보스)') : nameOf(c)),
    ...rows.map(([k, v]) => el('div', '', el('span', 'k', k), v)));
}

function renderAll() { renderFloors(); renderPanel(); renderCard(); }
setInterval(() => { // ticks the work timer, closes silent floors, finds a floor if ours went away, warns about silent people
  Office.prune(building);
  if (!floor()) { const latest = Object.values(building.floors).sort((a, z) => z.lastAt - a.lastAt)[0]; show(latest ? latest.id : null); }
  renderAll();
  warnStuck();
}, 1000);

// ---- attention sounds, synthesized (no audio files); muting is a per-viewer preference ----
const muteBtn = document.getElementById('mute');
let muted = false, audio;
try { muted = localStorage.getItem('muted') === '1'; } catch {}
const showMute = () => { muteBtn.textContent = muted ? '🔕' : '🔔'; muteBtn.setAttribute('aria-pressed', String(muted)); };
showMute();
muteBtn.addEventListener('click', () => {
  muted = !muted;
  try { localStorage.setItem('muted', muted ? '1' : '0'); } catch {}
  showMute();
});
function beep(freqs) {
  audio ??= new AudioContext();
  freqs.forEach((hz, i) => {
    const o = audio.createOscillator(), g = audio.createGain(), t0 = audio.currentTime + i * 0.12;
    o.frequency.value = hz;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
    o.connect(g).connect(audio.destination);
    o.start(t0);
    o.stop(t0 + 0.3);
  });
}
function notify(freqs) { toShell('flash'); if (!muted) beep(freqs); }

// ---- desktop notifications: what needs you, on any floor, while this window isn't the one in front ----
const notifyBtn = document.getElementById('notify');
// shortcut: no toasts in the desktop app: Windows shows an unpackaged Electron app's only with a Start Menu shortcut; it
// blinks the taskbar instead. Add a shortcut (shell.writeShortcutLink) if the app ever gets an installer.
const canToast = !embedded && 'Notification' in window;
const showNotifyBtn = () => { notifyBtn.hidden = !canToast || Notification.permission !== 'default'; };
showNotifyBtn();
notifyBtn.addEventListener('click', () => Notification.requestPermission().then(showNotifyBtn));
function toast(f, title, body) {
  if (appFocused || !canToast || Notification.permission !== 'granted') return;
  const n = new Notification(`${f.n}F ${f.project}: ${title}`, { body, tag: f.id, silent: true }); // one per floor; the sound is our beep
  n.onclick = () => { window.focus(); toShell('raise'); show(f.id); n.close(); };
}
const lineOf = (text, n = 120) => { // the first line that says something: markdown headings skipped
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  return (lines.find(l => !l.startsWith('#')) || lines[0] || '').replace(/\*\*|__|`/g, '').slice(0, n);
};

// A tool that won't finish: say so once. People already silent when the page (re)connects stay quiet; the extra
// 2 minutes cover a background window whose timers the browser slows to once a minute.
function warnStuck() {
  const now = Date.now();
  for (const f of Object.values(building.floors)) {
    if (f.closedAt) continue;
    for (const c of Object.values(f.state.chars)) {
      const late = Office.stuckFor(c, now);
      if (!late || late > Office.STUCK_MS + 120000 || c.warnedAt === c.seenAt) continue;
      c.warnedAt = c.seenAt;
      notify([520]);
      const min = Math.floor(late / 60000);
      toast(f, T(`A tool has been running for ${min} min`, `${min}분째 안 끝나는 작업`), `${nameOf(c)}: ${statusOf(c)} — ${T("check that it hasn't hung", '멈추지 않았는지 확인해 보세요')}`);
    }
  }
}

// ---- the office's art, from the pixel-art design (tools/import-design.js); until it loads the canvas stays plain ----
const THEME = { day: ['Day', '주간'], night: ['Late night', '야근'], wood: ['Wood', '우드'] };
const themeBtn = document.getElementById('theme');
let themeName = 'day';
try { themeName = localStorage.getItem('theme') || 'day'; } catch {}
const showTheme = () => { themeName = Office.setTheme(themeName); themeBtn.textContent = THEME[themeName] ? T(...THEME[themeName]) : themeName; };
themeBtn.addEventListener('click', () => {
  const list = Office.themes();
  themeName = list[(list.indexOf(themeName) + 1) % list.length] || 'day';
  showTheme();
  try { localStorage.setItem('theme', themeName); } catch {}
});
const loadImg = src => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('art/' + src)); i.src = 'art/' + src; });
fetch('art/art.json').then(r => r.json()).then(async art => {
  const [people, standing, bubbles, screens] = await Promise.all([art.people.file, art.standing.file, art.bubbles.file, art.screens.file].map(loadImg));
  const themes = {};
  for (const [name, t] of Object.entries(art.themes)) {
    themes[name] = { room: await loadImg(t.room), people: t.people ? await loadImg(t.people) : people, standing: t.standing ? await loadImg(t.standing) : standing };
  }
  Office.useArt(art, { themes, bubbles, screens });
  showTheme();
}).catch(err => console.error('office art failed to load:', err.message));

// ---- events ----
function apply(e) {
  if (e.hook_event_name === 'Usage') return renderUsage(e.usage); // the subscription's limits: one for the whole building
  const f = Office.route(building, e, e._t); // the server's receive time, so replayed history doesn't replay its effects
  if (!f) return;
  const replayed = Date.now() - e._t > 3000; // history replayed on (re)connect: no sounds, no jumping around
  choose(f, e, replayed);
  renderAll();
  if (replayed) return;
  const ev = e.hook_event_name, c = f.state.chars[f.state.who[e.agent_id || e.session_id]];
  if (ev === 'PermissionRequest') { // claude needs an answer, on whatever floor
    notify([880, 1320]);
    const what = `${c ? nameOf(c) : 'Claude'}: ${e.tool_name || ''} ${lineOf(e.ask)}${e._perm ? T(' — you can allow or deny it from the office', ' — 사무실에서 허용/거부할 수 있어요') : ''}`;
    setTimeout(() => { if (c?.status === 'waiting' && !f.closedAt) toast(f, T('Waiting for approval', '승인 대기'), what); }, 5000); // answered in the terminal by then: no toast
  } else if (ev === 'Stop' && !appFocused) { // done while you were elsewhere
    notify([660]);
    toast(f, T('Finished', '작업 완료'), lineOf(e.last_assistant_message) || T('Claude is waiting for your next instruction', 'Claude가 다음 지시를 기다려요'));
  } else if (ev === 'StopFailure') toast(f, T('Stopped', '작업 중단'), e.error || T('error', '오류'));
}

// ---- subscription usage (5-hour and weekly windows), from claude's status line (core/statusline.js) ----
const usageEl = document.getElementById('usage');
function renderUsage(u) {
  const parts = [[T('5h', '5시간'), u?.five], [T('Week', '주간'), u?.week]].filter(([, w]) => w);
  usageEl.hidden = !parts.length;
  usageEl.replaceChildren(...parts.map(([name, w]) => el('span', w.pct >= 80 ? 'hot' : w.pct >= 50 ? 'warm' : '', `${name} ${w.pct}%`)));
  const when = t => new Date(t * 1000).toLocaleString(LOCALE, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  usageEl.title = T('Subscription usage. ', '구독 사용량. ') + parts.map(([name, w]) => `${name}: ${w.pct}% ${T('used', '사용')}${w.resets ? T(`, resets ${when(w.resets)}`, `, ${when(w.resets)} 초기화`) : ''}`).join(' / ');
}

renderAll(); // the tabs' words in the right language from the first paint
const events = new EventSource('/stream');
events.onopen = () => { building = Office.createBuilding(); current = null; renderAll(); }; // the server replays its history on every (re)connect
events.onmessage = m => { try { apply(JSON.parse(m.data)); } catch (err) { console.error(err); } };

if (embedded) {
  window.addEventListener('message', m => {
    if (m.source !== window.parent || !m.data) return;
    if (m.data.agentOffice === 'focus') appFocused = Boolean(m.data.value);
    else if (m.data.agentOffice === 'sessions') { appSessions.clear(); for (const x of [].concat(m.data.value || [])) appSessions.add(String(x)); }
    else if (m.data.agentOffice === 'session') { // the app's tab in front runs this claude session: show its floor
      // (a claude the app ends gets its floor closed by a SessionEnd the app posts to the server)
      pinned = m.data.value;
      const id = building.alias[pinned];
      if (id) show(id);
      else renderAll(); // its first event will bring it up (choose)
    }
  });
} else {
  window.addEventListener('focus', () => (appFocused = true));
  window.addEventListener('blur', () => (appFocused = false));
}

// ---- clicking people ----
const canvas = document.getElementById('office');
canvas.addEventListener('mousemove', ev => { canvas.style.cursor = Office.hit(office(), ev.offsetX, ev.offsetY) ? 'pointer' : ''; });
canvas.addEventListener('click', ev => {
  const c = Office.hit(office(), ev.offsetX, ev.offsetY);
  selected = c && c.id;
  renderCard();
  if (!c) return;
  c.petAt = Date.now(); // hop + heart
  card.style.left = Math.max(8, Math.min(ev.offsetX + 12, document.body.clientWidth - card.offsetWidth - 8)) + 'px';
  card.style.top = Math.max(8, Math.min(canvas.offsetTop + ev.offsetY + 12, document.body.clientHeight - card.offsetHeight - 8)) + 'px';
  if (c.kind === 'boss') toShell('focus-terminal');
});
document.getElementById('card-close').addEventListener('click', () => { selected = null; renderCard(); });

requestAnimationFrame(function frame(t) {
  Office.step(canvas, office(), t);
  requestAnimationFrame(frame);
});
