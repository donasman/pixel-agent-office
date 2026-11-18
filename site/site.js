// The Agent Office site: language toggle, install tabs, copy buttons, and the live demo, which is the real office
// (office.js, copied in at build time) playing a scripted claude session. No server: events go straight to the reducer.
(() => {
  // ---- language: English is in the page; Korean replaces the [data-i18n] elements (our own constant strings) ----
  const KO = {
    eyebrow: 'Claude Code용 · 무료 오픈소스',
    h1: 'Claude Code 에이전트가 일하는 모습을 보세요.',
    sub: '세션을 도트 사무실로 보여 줍니다. 메인 에이전트는 보스, 서브에이전트는 직원입니다. 일을 받으면 깨어나 책상에서 일하고, 끝나면 보고서를 보스에게 날려 보냅니다. 모두 실시간입니다.',
    install: '설치',
    tabApp: '데스크톱 앱',
    noteNpx: 'Node.js 18 이상이 필요합니다. 처음 실행하면 Claude Code 플러그인을 설치할지 묻는데, Enter를 누르면 됩니다. 그다음부터는 터미널이든 IDE든 평소처럼 Claude Code를 쓰세요.',
    notePlugin: 'Claude Code 안에서 실행한 뒤 <code>npx pixel-agent-office</code>로 사무실을 여세요. Git이 없는 Windows에서는 <code>agent-office-powershell@agent-office</code>를 설치하세요.',
    noteApp: 'Windows 전용입니다. 왼쪽은 claude 터미널 탭, 오른쪽은 사무실이고, 플러그인이 필요 없습니다.',
    feed: '훅 이벤트',
    caption: '라이브 데모: 진짜 사무실 화면이 각본대로 움직이는 중입니다. 직원을 눌러 보세요.',
    featuresTitle: 'claude가 하는 일을 한눈에',
    f1: '사무실에서 승인하기',
    f1p: 'claude가 허락을 구하면 ? 말풍선과 알림음이 나옵니다. 사무실에서 허용하거나 거부할 수 있고, 사무실과 터미널 중 먼저 답한 쪽이 적용됩니다.',
    f2: '멈춘 작업 찾기',
    f2p: '5분 동안 아무 소식 없이 도는 명령은 책상과 층 탭에 표시됩니다.',
    f3: '보고서함과 업무 일지',
    f3p: '서브에이전트가 보낸 보고서 전문을 바로 복사할 수 있고, 세션마다 일어난 일이 시간순으로 쌓입니다.',
    f4: '컨텍스트·사용량 게이지',
    f4p: '보스의 컨텍스트가 얼마나 찼는지, 5시간·주간 한도를 얼마나 썼는지 보여 줍니다.',
    f5: '세션마다 한 층',
    f5p: 'claude를 여러 개 띄우면 폴더 이름을 단 층이 하나씩 생깁니다.',
    f6: '에이전트 팀',
    f6p: '팀원은 리더의 층에 책상을 받고, 일을 더 받으면 같은 책상에서 깨어납니다.',
    howTitle: '작동 방식',
    s1: '평소처럼 실행',
    s2t: '플러그인 훅', s2: '이벤트를 전달',
    s3t: '로컬 서버', s3: '127.0.0.1에서 받음',
    s4t: '사무실 창', s4: '그림으로 표시',
    howNote: '모든 것이 내 컴퓨터 안에서 돌아갑니다. 훅은 모델을 부르지 않아 토큰이 들지 않고, 사무실을 닫아 두면 아무 일도 하지 않습니다.',
    faqTitle: '자주 묻는 질문',
    q1: '토큰이 들거나 claude가 느려지나요?',
    a1: '아니요. 훅은 이벤트를 내 컴퓨터의 서버로 백그라운드에서 넘길 뿐입니다. 예외는 승인 훅 하나인데, 사무실이 열려 있을 때만 답을 기다립니다.',
    q2: '코드가 어딘가로 전송되나요?',
    a2: '아니요. 서버는 127.0.0.1에서만 받고, 사무실 화면은 내 브라우저에서 돌아갑니다.',
    q3: '무엇이 필요한가요?',
    a3: 'Claude Code와 Node.js 18 이상이 필요합니다. Windows에서 테스트했고, macOS와 Linux도 같은 bash 훅을 씁니다.',
    q4: '지우려면 어떻게 하나요?',
    a4: 'Claude Code에서 <code>/plugin uninstall agent-office@agent-office</code>를 실행하고 <code>~/.agent-office</code> 폴더를 지우세요.',
    footer: 'MIT 라이선스. 비공식 프로젝트이며 Anthropic과 관계가 없습니다.',
  };
  const nodes = [...document.querySelectorAll('[data-i18n]')];
  const EN = Object.fromEntries(nodes.map(n => [n.dataset.i18n, n.innerHTML]));
  const langBtn = document.getElementById('lang');
  let lang = 'en';
  function setLang(l) {
    lang = l;
    document.documentElement.lang = l;
    for (const n of nodes) n.innerHTML = (l === 'ko' ? KO : EN)[n.dataset.i18n] ?? EN[n.dataset.i18n];
    langBtn.textContent = l === 'ko' ? 'English' : '한국어';
    try { localStorage.setItem('lang', l); } catch {}
  }
  let saved = null;
  try { saved = localStorage.getItem('lang'); } catch {}
  setLang(saved || (/^ko\b/i.test(navigator.language || '') ? 'ko' : 'en'));
  langBtn.addEventListener('click', () => setLang(lang === 'ko' ? 'en' : 'ko'));

  // ---- install tabs (arrow keys move between them) ----
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function pick(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => pick(t));
    t.addEventListener('keydown', e => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (d) pick(tabs[(i + d + tabs.length) % tabs.length], true);
    });
  });

  // ---- a copy button on every command ----
  const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
  for (const row of document.querySelectorAll('.cmd')) {
    const text = row.querySelector('code').textContent;
    const b = document.createElement('button');
    b.className = 'copy';
    b.type = 'button';
    b.setAttribute('aria-label', `Copy: ${text}`);
    b.innerHTML = ICON_COPY;
    b.addEventListener('click', () => navigator.clipboard?.writeText(text).then(() => {
      b.innerHTML = ICON_DONE;
      setTimeout(() => (b.innerHTML = ICON_COPY), 1500);
    }, () => {}));
    row.append(b);
  }

  // ---- the demo ----
  const canvas = document.getElementById('demo');
  const feed = document.getElementById('feed');
  const themeBtn = document.getElementById('theme');
  const SID = 'demo';
  let state = Office.createState(), n = 0;
  const ev = (name, extra = {}) => ({ hook_event_name: name, session_id: SID, ...extra });
  const agent = id => ({ a1: { agent_id: 'a1', agent_type: 'Explore' }, a2: { agent_id: 'a2', agent_type: 'code-reviewer' } }[id] || {});
  // one tool call: PreToolUse now, PostToolUse after `ms`; who = null (the boss) or a subagent id
  const tool = (who, name, input, ms, response) => {
    const id = 't' + ++n;
    return [[0, ev('PreToolUse', { ...agent(who), tool_name: name, tool_input: input, tool_use_id: id })],
      [ms, ev('PostToolUse', { ...agent(who), tool_name: name, tool_input: input, tool_use_id: id, tool_response: response })]];
  };
  const task = (id, subject) => tool(null, 'TaskCreate', { subject }, 250, { task: { id, subject } });
  const update = (taskId, status) => tool(null, 'TaskUpdate', { taskId, status }, 150);
  const say = (who, toolName, arg) => ({ say: [who, toolName, arg] }); // a line in the event feed beside the office
  // The script: lanes of [wait ms since the previous step, event or feed line], merged by absolute time so the two
  // subagents can work side by side.
  const lane = steps => { let t = 0; return steps.map(([w, x]) => [(t += w), x]); };
  const main = lane([
    [400, ev('SessionStart', { source: 'startup' })],
    [600, say('you', '', { en: 'fix the bug that logs people out', ko: '로그아웃되는 버그 고쳐 줘' })],
    [0, ev('UserPromptSubmit')],
    [1000, say('Claude', 'TaskCreate', '3 to-dos')],
    ...task('1', 'Find why sessions expire'), [250, null], ...task('2', 'Fix the session check'), [250, null], ...task('3', 'Run the tests'),
    [400, null], ...update('1', 'in_progress'),
    [600, say('Claude', 'Agent', '→ Explore, code-reviewer')],
  ]);
  const start = main.at(-1)[0];
  const g1 = 't' + ++n, g2 = 't' + ++n;
  const delegate = lane([
    [start, ev('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Find where sessions expire' }, tool_use_id: g1 })],
    [300, ev('SubagentStart', agent('a1'))],
    [200, ev('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Review the auth module' }, tool_use_id: g2 })],
    [300, ev('SubagentStart', agent('a2'))],
  ]);
  const t0 = delegate.at(-1)[0];
  const explore = lane([
    [t0 + 600, say('Explore', 'Grep', '"expires"')], ...tool('a1', 'Grep', { pattern: 'expires' }, 1500),
    [200, say('Explore', 'Read', 'src/session.js')], ...tool('a1', 'Read', { file_path: 'src/session.js' }, 1700),
    [300, say('Explore', 'report', '→ boss')],
    ...tool('a1', 'SubagentHandback', { message: 'Sessions expire in src/session.js: the TTL is in seconds but the check compares milliseconds.' }, 1000),
    [200, ev('SubagentStop', agent('a1'))],
    [300, ev('PostToolUse', { tool_name: 'Agent', tool_input: { description: 'Find where sessions expire' }, tool_use_id: g1, tool_response: { agentId: 'a1' } })],
  ]);
  const review = lane([
    [t0 + 1100, say('code-reviewer', 'Read', 'src/auth.js')], ...tool('a2', 'Read', { file_path: 'src/auth.js' }, 1800),
    [200, say('code-reviewer', 'Bash', 'npm test')], ...tool('a2', 'Bash', { command: 'npm test' }, 2200),
    [400, say('code-reviewer', 'report', '→ boss')],
    ...tool('a2', 'SubagentHandback', { message: 'The auth module looks fine. One nit: the session cookie has no SameSite flag.' }, 1000),
    [200, ev('SubagentStop', agent('a2'))],
    [300, ev('PostToolUse', { tool_name: 'Agent', tool_input: { description: 'Review the auth module' }, tool_use_id: g2, tool_response: { agentId: 'a2' } })],
  ]);
  const t1 = Math.max(explore.at(-1)[0], review.at(-1)[0]);
  const [[, commitPre], [, commitPost]] = tool(null, 'Bash', { command: 'git commit -m "Fix session expiry"' }, 0);
  const finish = lane([
    [t1 + 600, null], ...update('1', 'completed'), ...update('2', 'in_progress'),
    [300, say('Claude', 'Edit', 'src/session.js')], ...tool(null, 'Edit', { file_path: 'src/session.js' }, 2000),
    [200, null], ...update('2', 'completed'), ...update('3', 'in_progress'),
    [300, say('Claude', 'Bash', 'npm test')], ...tool(null, 'Bash', { command: 'npm test' }, 1800),
    [200, null], ...update('3', 'completed'),
    [500, say('Claude', 'Bash', 'git commit -m "Fix session expiry"')],
    [0, commitPre],
    [300, ev('PermissionRequest', { tool_name: 'Bash', ask: 'git commit -m "Fix session expiry"' })],
    [0, say('Claude', '?', { en: 'asks to run git commit', ko: 'git commit 실행 허락을 구함' })],
    [2600, say('you', '', { en: 'allowed', ko: '허용함' })],
    [0, commitPost],
    [1600, ev('Stop')],
    [0, say('Claude', 'Stop', { en: 'done, waiting for you', ko: '끝, 다음 지시 대기' })],
    [5000, null],
  ]);
  const timeline = [...main, ...delegate, ...explore, ...review, ...finish].sort((a, z) => a[0] - z[0]);
  const LOOP_MS = timeline.at(-1)[0];

  function line(x) {
    const [who, toolName, arg] = x.say;
    const li = document.createElement('li');
    const part = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    li.append(part(who === 'you' ? 'who you' : 'who', who === 'you' ? '>' : who), ' ');
    if (toolName) li.append(part('tool', toolName), ' ');
    li.append(part('arg', typeof arg === 'object' ? arg[lang] : arg));
    feed.append(li);
    while (feed.children.length > 11) feed.firstElementChild.remove();
  }

  let begun = 0, next = 0;
  function tick() {
    const now = Date.now();
    if (!begun || now - begun > LOOP_MS) { begun = now; next = 0; state = Office.createState(); feed.replaceChildren(); }
    while (next < timeline.length && timeline[next][0] <= now - begun) {
      const x = timeline[next++][1];
      if (x?.say) line(x);
      else if (x) Office.reduce(state, x, now);
    }
  }
  setInterval(tick, 100);

  // office.js draws at a whole-number scale and pads the rest; size the canvas so that scale fills it exactly
  const demoBox = canvas.closest('.demo');
  function fitDemo() {
    const dpr = window.devicePixelRatio || 1;
    const room = demoBox.clientWidth - (matchMedia('(max-width: 860px)').matches ? 2 : 318); // the feed sits beside it when wide
    const S = Math.max(1, Math.floor(Math.min(room, 768) * dpr / 192));
    canvas.style.width = `${(S * 192) / dpr}px`;
    canvas.style.height = `${(S * 144) / dpr}px`;
  }
  fitDemo();
  window.addEventListener('resize', fitDemo);

  canvas.addEventListener('mousemove', e => { canvas.style.cursor = Office.hit(state, e.offsetX, e.offsetY) ? 'pointer' : ''; });
  canvas.addEventListener('click', e => { const c = Office.hit(state, e.offsetX, e.offsetY); if (c) c.petAt = Date.now(); });

  const THEME = { day: 'DAY', night: 'NIGHT', wood: 'WOOD' };
  let theme = 'day';
  themeBtn.addEventListener('click', () => {
    const list = Office.themes();
    theme = Office.setTheme(list[(list.indexOf(theme) + 1) % list.length] || 'day');
    themeBtn.textContent = THEME[theme] || theme.toUpperCase();
  });

  // the office's art, loaded the way the real page does it
  const img = src => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error(src)); i.src = 'art/' + src; });
  fetch('art/art.json').then(r => r.json()).then(async art => {
    const [people, standing, bubbles, screens] = await Promise.all([art.people.file, art.standing.file, art.bubbles.file, art.screens.file].map(img));
    const themes = {};
    for (const [name, t] of Object.entries(art.themes)) themes[name] = { room: await img(t.room), people: t.people ? await img(t.people) : people, standing: t.standing ? await img(t.standing) : standing };
    Office.useArt(art, { themes, bubbles, screens });
  }).catch(err => console.error('demo art failed to load:', err.message));

  requestAnimationFrame(function frame(t) {
    Office.step(canvas, state, t);
    requestAnimationFrame(frame);
  });
})();
