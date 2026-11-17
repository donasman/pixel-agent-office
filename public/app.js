// Office page: hook events streamed by the core server -> a building with one floor per claude session -> the floor
// you're looking at is drawn, with its roster and info card; tabs switch floors. Sounds come from every floor.
// Runs alone in a browser, or inside the Electron app's iframe; there it talks to the app with postMessage.
const embedded = window.parent !== window;
const toShell = kind => { if (embedded) window.parent.postMessage({ agentOffice: kind }, '*'); }; // carries no data

let building = Office.createBuilding();
let current = null; // id of the floor on screen
let selected = null; // id of the character whose info card is open
let pinned = null; // the Electron app's own claude session: its floor is the one to show
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
    const mark = st.waiting ? el('span', 'mark waiting', '?') : st.working ? el('span', 'mark working', '●') : '';
    const tab = el('button', st.closed ? 'closed' : '', `${f.n}F ${f.project}`, mark);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(f.id === current));
    tab.title = st.closed ? '세션 종료됨' : st.waiting ? '승인 대기 중' : st.working ? '일하는 중' : '대기 중';
    tab.addEventListener('click', () => show(f.id));
    return tab;
  }));
}

// ---- roster and info card (the floor on screen) ----
const roster = document.getElementById('roster');
function renderRoster() {
  roster.replaceChildren(...Object.values(office().chars).filter(c => c.kind === 'boss' || c.busy).map(c => {
    const dot = el('span', 'dot');
    dot.style.background = c.color;
    return el('li', '', dot, c.label + (c.task ? `: ${c.task}` : ''),
      el('span', 'st', ` — ${Office.STATUS_KO[c.status]}${c.tool ? ` (${c.tool})` : ''}`));
  }));
}

const card = document.getElementById('card');
const cardBody = document.getElementById('card-body');
const mmss = ms => `${Math.floor(ms / 60000)}분 ${Math.floor(ms / 1000) % 60}초`;
function renderCard() {
  const s = office(), c = selected && s.chars[selected];
  card.hidden = !c;
  if (!c) return;
  const rows = [
    ['상태', Office.STATUS_KO[c.status] + (c.tool ? ` (${c.tool})` : '')],
    ['맡은 일', c.task || '-'],
    ['최근 도구', c.history.join(' → ') || '-'],
    ['이번 근무', c.status !== 'sleeping' && c.since ? mmss(Date.now() - c.since) : '-'],
  ];
  if (c.kind === 'boss') rows.push(['모델', c.model || '?'], ['받은 보고서', `${s.reports}장`]);
  else rows.push(['받은 업무', `${c.jobs}건`], ['마지막 보고', c.lastReport || '-']);
  cardBody.replaceChildren(
    el('strong', '', c.kind === 'boss' ? 'Claude (보스)' : c.label || `직원 ${c.desk}`),
    ...rows.map(([k, v]) => el('div', '', el('span', 'k', k), v)));
}

function renderAll() { renderFloors(); renderRoster(); renderCard(); }
setInterval(() => { // ticks the work timer, closes silent floors, and finds a floor if ours went away
  Office.prune(building);
  if (!floor()) { const latest = Object.values(building.floors).sort((a, z) => z.lastAt - a.lastAt)[0]; show(latest ? latest.id : null); }
  renderAll();
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

// ---- the office's art, from the pixel-art design (tools/import-design.js); until it loads the canvas stays plain ----
const THEME_KO = { day: '주간', night: '야근', wood: '우드' };
const themeBtn = document.getElementById('theme');
let themeName = 'day';
try { themeName = localStorage.getItem('theme') || 'day'; } catch {}
const showTheme = () => { themeName = Office.setTheme(themeName); themeBtn.textContent = THEME_KO[themeName] || themeName; };
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
  const f = Office.route(building, e, e._t); // the server's receive time, so replayed history doesn't replay its effects
  if (!f) return;
  const replayed = Date.now() - e._t > 3000; // history replayed on (re)connect: no sounds, no jumping around
  choose(f, e, replayed);
  renderAll();
  if (replayed) return;
  if (e.hook_event_name === 'PermissionRequest') notify([880, 1320]); // claude needs an answer, on whatever floor
  else if (e.hook_event_name === 'Stop' && !appFocused) notify([660]); // done while you were elsewhere
}

const events = new EventSource('/stream');
events.onopen = () => { building = Office.createBuilding(); current = null; renderAll(); }; // the server replays its history on every (re)connect
events.onmessage = m => { try { apply(JSON.parse(m.data)); } catch (err) { console.error(err); } };

if (embedded) {
  window.addEventListener('message', m => {
    if (m.source !== window.parent || !m.data) return;
    if (m.data.agentOffice === 'focus') appFocused = Boolean(m.data.value);
    else if (m.data.agentOffice === 'session' && m.data.value !== pinned) { // the app started a claude with this session id
      // its previous claude is gone (it may have been killed without a SessionEnd): close that floor
      if (pinned) Office.route(building, { hook_event_name: 'SessionEnd', session_id: pinned, reason: 'other' });
      pinned = m.data.value;
      renderAll();
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
