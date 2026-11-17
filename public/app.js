// Office page: hook events streamed by the core server -> office state -> drawing, roster, info card, sounds.
// Runs alone in a browser, or inside the Electron app's iframe; there it talks to the app with postMessage.
const embedded = window.parent !== window;
const toShell = kind => { if (embedded) window.parent.postMessage({ agentOffice: kind }, '*'); }; // carries no data

let state = Office.createState();
let selected = null; // id of the character whose info card is open
let resetAt = 0; // events from before the app restarted claude are ignored
let appFocused = embedded || document.hasFocus();

// Text nodes only below: task and report text come from the model.
const el = (tag, cls, ...kids) => { const n = document.createElement(tag); if (cls) n.className = cls; n.append(...kids); return n; };

const roster = document.getElementById('roster');
function renderRoster() {
  roster.replaceChildren(...Object.values(state.chars).filter(c => c.kind === 'boss' || c.busy).map(c => {
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
  const c = selected && state.chars[selected];
  card.hidden = !c;
  if (!c) return;
  const rows = [
    ['상태', Office.STATUS_KO[c.status] + (c.tool ? ` (${c.tool})` : '')],
    ['맡은 일', c.task || '-'],
    ['최근 도구', c.history.join(' → ') || '-'],
    ['이번 근무', c.status !== 'sleeping' && c.since ? mmss(Date.now() - c.since) : '-'],
  ];
  if (c.kind === 'boss') rows.push(['모델', c.model || '?'], ['받은 보고서', `${state.reports}장`]);
  else rows.push(['받은 업무', `${c.jobs}건`], ['마지막 보고', c.lastReport || '-']);
  cardBody.replaceChildren(
    el('strong', '', c.kind === 'boss' ? 'Claude (보스)' : c.label || `직원 ${c.desk}`),
    ...rows.map(([k, v]) => el('div', '', el('span', 'k', k), v)));
}
setInterval(renderCard, 1000); // keeps the work timer ticking

// Attention sounds, synthesized (no audio files). Muting is a per-viewer preference.
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

// The office's art comes from the pixel-art design (tools/import-design.js). Until it loads the canvas stays plain.
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

function apply(e) {
  if (e._t < resetAt) return;
  Office.reduce(state, e, e._t); // the server's receive time, so replayed history doesn't replay its effects
  renderRoster();
  renderCard();
  if (Date.now() - e._t > 3000) return; // history replayed on (re)connect: no sounds
  if (e.hook_event_name === 'PermissionRequest') notify([880, 1320]); // claude needs an answer
  else if (e.hook_event_name === 'Stop' && !appFocused) notify([660]); // done while you were elsewhere
}

const events = new EventSource('/stream');
events.onopen = () => { state = Office.createState(); renderRoster(); renderCard(); }; // the server replays its history on every (re)connect
events.onmessage = m => { try { apply(JSON.parse(m.data)); } catch {} };

if (embedded) {
  window.addEventListener('message', m => {
    if (m.source !== window.parent || !m.data) return;
    if (m.data.agentOffice === 'focus') appFocused = Boolean(m.data.value);
    else if (m.data.agentOffice === 'reset') { // the app restarted claude: start from an empty office
      resetAt = Date.now();
      state = Office.createState();
      selected = null;
      renderRoster();
      renderCard();
    }
  });
} else {
  window.addEventListener('focus', () => (appFocused = true));
  window.addEventListener('blur', () => (appFocused = false));
}

const canvas = document.getElementById('office');
canvas.addEventListener('mousemove', ev => { canvas.style.cursor = Office.hit(state, ev.offsetX, ev.offsetY) ? 'pointer' : ''; });
canvas.addEventListener('click', ev => {
  const c = Office.hit(state, ev.offsetX, ev.offsetY);
  selected = c && c.id;
  renderCard();
  if (!c) return;
  c.petAt = Date.now(); // hop + heart
  card.style.left = Math.max(8, Math.min(ev.offsetX + 12, document.body.clientWidth - card.offsetWidth - 8)) + 'px';
  card.style.top = Math.max(8, Math.min(ev.offsetY + 12, document.body.clientHeight - card.offsetHeight - 8)) + 'px';
  if (c.kind === 'boss') toShell('focus-terminal');
});
document.getElementById('card-close').addEventListener('click', () => { selected = null; renderCard(); });

requestAnimationFrame(function frame(t) {
  Office.step(canvas, state, t);
  requestAnimationFrame(frame);
});
