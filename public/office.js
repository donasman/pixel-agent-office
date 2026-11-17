// Office state from Claude Code hook events, plus the pixel drawing.
// Everyone sits at a fixed desk asleep; a subagent starting wakes a staff member, finishing puts them back to sleep
// and sends a report flying to the boss. reduce() and hit() are plain logic checked by office.test.js; step() draws.
// The art (rooms, people, bubbles, screens) comes from the pixel-art design via tools/import-design.js.
(function () {
  const W = 192, H = 144; // logical pixels, scaled up by an integer factor so pixels stay crisp
  // The design's layout: a desk is its partition's top-left; desk 0 is the boss's, 1..8 are staff desks.
  const DESKS = [{ x: 73, y: 37, w: 46 }, ...[77, 117].flatMap(y => [7, 53, 99, 145].map(x => ({ x, y, w: 34 })))];
  const SPOTS = [[134, 28], [40, 28]]; // where temps stand when every desk is taken
  const PILE = { x: 108, y: 42 }; // the boss's in-tray

  const TOOL_STATUS = {
    Edit: 'typing', Write: 'typing', MultiEdit: 'typing', NotebookEdit: 'typing',
    Read: 'reading', Grep: 'reading', Glob: 'reading', WebFetch: 'reading', WebSearch: 'reading',
    Bash: 'running', PowerShell: 'running', Agent: 'delegating', Task: 'delegating',
    SubagentHandback: 'typing', // a subagent writing up its report for the main agent
  };
  const STATUS_KO = {
    sleeping: '꿀잠 중', thinking: '생각 중', typing: '코드 작성', reading: '자료 조사', running: '명령 실행',
    working: '작업 중', delegating: '업무 지시', waiting: '승인 대기',
  };
  const TEST_CMD = /\b(npm|pnpm|yarn|bun)\b[^|&;]*\btest\b|\b(pytest|jest|vitest|mocha)\b|\b(cargo|go|dotnet|mvn|gradle|deno)\s+test\b/;
  const COMMIT_CMD = /\bgit\s+commit\b/;
  // clothing colours from the design (the roster's dots): the boss per model, then staff desks 1..8, then temps
  const OUTFITS = { sonnet: '#d97757', opus: '#3a3d52', haiku: '#7cc47a', fable: '#7c4dcf' };
  const SHIRTS = ['#e8ecf4', '#f0c9c4', '#5b6078', '#8aad6a', '#2f3e5c', '#d9a441', '#7a5c46', '#a3382f'];
  const TEMP_SHIRT = '#34548a';
  const PAPER_MS = 1200;
  const EFFECT_MS = { paper: PAPER_MS, confetti: 2500, clap: 1500, sparkle: 1000 };
  const CONFETTI = ['#f38ba8', '#f9e2af', '#a6e3a1', '#89b4fa', '#cba6f7', '#fab387'];
  const INK = '#22222c', PAPER = '#fbfbf8', HOT = '#f9e2af', RED = '#e64553'; // the design's bubble colours

  function newChar(id, kind, desk, n) {
    return {
      id, kind, desk, n, label: kind === 'boss' ? 'Claude' : '', task: '', status: 'sleeping', tool: null,
      busy: false, jobs: 0, history: [], since: 0, wokeAt: 0, petAt: 0,
      say: null, oopsAt: 0, failStreak: 0, lastReport: '', handback: '', model: null,
      color: kind === 'boss' ? OUTFITS.sonnet : kind === 'temp' ? TEMP_SHIRT : SHIRTS[(desk - 1) % SHIRTS.length],
    };
  }

  function createState() {
    const chars = { boss: newChar('boss', 'boss', 0, 0) };
    for (let i = 1; i < DESKS.length; i++) chars['desk' + i] = newChar('desk' + i, 'staff', i, i);
    return {
      chars, who: {}, bossSession: null, pendingTasks: [], knownTasks: {}, doneTools: new Set(), gone: new Map(),
      seq: DESKS.length, temps: 0, lights: null, cleaning: 0, effects: [], reports: 0,
    };
  }

  // A report (SubagentHandback) can arrive after its SubagentStop: file it with whoever wrote it.
  function lateReport(s, charId, msg) {
    const c = s.chars[charId];
    if (msg && c && c.lastReport === '완료') c.lastReport = firstLine(msg);
    return s;
  }

  // Hooks run async, so a fast tool's PostToolUse can arrive before its PreToolUse: remember finished tools.
  function markDone(s, id) {
    if (!id) return;
    s.doneTools.add(id);
    if (s.doneTools.size > 200) s.doneTools.delete(s.doneTools.values().next().value);
  }

  // A background Agent call's result names the subagent it launched, so its task is exact whatever order hooks arrive in.
  function assignTask(s, agentId, desc) {
    const sub = s.who[agentId] && s.chars[s.who[agentId]], i = s.pendingTasks.indexOf(desc);
    if (!sub) { s.knownTasks[agentId] = desc; return; }
    sub.task = desc;
    if (i >= 0) s.pendingTasks.splice(i, 1);
  }

  function takeTask(s, agentId) {
    if (!(agentId in s.knownTasks)) return s.pendingTasks.shift() || ''; // best guess: Agent calls in order
    const desc = s.knownTasks[agentId], i = s.pendingTasks.indexOf(desc);
    delete s.knownTasks[agentId];
    if (i >= 0) s.pendingTasks.splice(i, 1);
    return desc;
  }

  function setModel(s, name) {
    const m = Object.keys(OUTFITS).find(k => String(name || '').toLowerCase().includes(k));
    if (m) Object.assign(s.chars.boss, { model: m, color: OUTFITS[m] });
  }

  // First meaningful line of a subagent's final message (headings skipped, markdown stripped), for the card.
  function firstLine(msg) {
    const lines = String(msg || '').split('\n').map(l => l.trim()).filter(Boolean);
    const pick = lines.find(l => !l.startsWith('#')) || lines[0] || '';
    // strip emphasis and line markers only: a lone * is content (*.md)
    const line = pick.replace(/\*\*|__|`/g, '').replace(/^(#+|>|[-*])\s+/, '').replace(/\s+/g, ' ').trim() || '완료';
    return line.length > 40 ? line.slice(0, 39) + '…' : line;
  }

  // The character an event belongs to. A new subagent or teammate wakes up a sleeping staff member.
  function charFor(s, e, now) {
    const id = e.agent_id || e.session_id;
    if (!id) return null;
    if (s.who[id]) return s.chars[s.who[id]];
    if (e.hook_event_name === 'SubagentStop') return null;
    if (e.agent_id && s.gone.has(e.agent_id)) return null; // late event from a finished subagent: don't wake anyone
    // the first session is the boss; /clear, resume and compact give the boss a new session id
    if (!e.agent_id && (!s.bossSession || ['clear', 'resume', 'compact'].includes(e.source))) {
      s.bossSession = id;
      return s.chars[(s.who[id] = 'boss')];
    }
    const label = e.agent_type || 'teammate';
    const free = Object.values(s.chars).filter(c => c.kind === 'staff' && !c.busy);
    let c = free.find(f => f.label === label) || free[0]; // the same kind of agent gets its old desk back
    if (!c) { const n = ++s.seq; c = s.chars['temp' + n] = newChar('temp' + n, 'temp', -1, s.temps++); } // office full: a temp stands in
    Object.assign(c, { busy: true, label, task: '', tool: null, history: [], handback: '', since: now });
    c.jobs++;
    s.who[id] = c.id;
    return c;
  }

  function wake(c, status, now) {
    if (c.status === 'sleeping') { c.wokeAt = now; if (c.kind === 'boss') c.since = now; }
    c.status = status;
  }

  // A speech bubble: pixel-font text (ASCII only: the font has no Hangul) or an icon.
  function say(c, text, now, { ms = 2000, delay = 0, icon = null, ink = INK } = {}) {
    c.say = { text, icon, ink, from: now + delay, until: now + delay + ms };
  }

  function reduce(s, e, now = Date.now()) {
    const handback = e.tool_name === 'SubagentHandback' ? e.tool_input?.message : undefined;
    if (handback && s.gone.has(e.agent_id)) return lateReport(s, s.gone.get(e.agent_id), handback);
    const c = charFor(s, e, now);
    if (!c) return s;
    if (handback) c.handback = handback; // interactive claude: subagents report through this tool, not their last message
    const ev = e.hook_event_name, cmd = e.tool_name === 'Bash' ? String(e.tool_input?.command || '') : '';
    if (c.kind === 'boss' && e.model) setModel(s, e.model); // the server reads it from the transcript
    if (ev === 'SessionStart' || ev === 'UserPromptSubmit' || ev === 'PreToolUse') s.lights = null; // power is back
    switch (ev) {
      case 'SessionStart': if (c.kind !== 'boss') wake(c, 'thinking', now); break;
      case 'SubagentStart': c.task = takeTask(s, e.agent_id); wake(c, 'thinking', now); break;
      case 'UserPromptSubmit': wake(c, 'thinking', now); break;
      case 'PreToolUse':
        c.history = [...c.history, e.tool_name].slice(-5);
        if (s.doneTools.has(e.tool_use_id)) break; // arrived after its PostToolUse: the tool is already done
        if (TOOL_STATUS[e.tool_name] === 'delegating') s.pendingTasks.push(e.tool_input?.description || '');
        wake(c, TOOL_STATUS[e.tool_name] || 'working', now);
        c.tool = e.tool_name === 'SubagentHandback' ? '보고서' : e.tool_name;
        break;
      case 'PermissionRequest': wake(c, 'waiting', now); break;
      case 'PostToolUse':
        markDone(s, e.tool_use_id);
        if (TOOL_STATUS[e.tool_name] === 'delegating' && e.tool_response?.agentId) assignTask(s, e.tool_response.agentId, e.tool_input?.description || '');
        if (c.status !== 'sleeping') c.status = 'thinking';
        c.tool = null;
        c.failStreak = 0;
        if (TEST_CMD.test(cmd)) s.effects.push({ type: 'clap', at: now });
        if (COMMIT_CMD.test(cmd)) { s.effects.push({ type: 'confetti', at: now }); say(c, 'COMMIT!', now); }
        break;
      case 'PostToolUseFailure':
        markDone(s, e.tool_use_id);
        if (c.status !== 'sleeping') c.status = 'thinking';
        c.tool = null;
        if (e.is_interrupt) break; // the user pressed Esc: not the agent's mistake
        c.oopsAt = now;
        c.failStreak++;
        if (TEST_CMD.test(cmd)) say(c, 'FAIL', now, { ink: RED }); else say(c, 'OOPS', now);
        break;
      case 'Notification':
        if (e.notification_type === 'permission_prompt' || /permission/i.test(e.message || '')) wake(c, 'waiting', now);
        else c.status = 'sleeping';
        break;
      case 'Stop': c.status = 'sleeping'; c.tool = null; break;
      case 'StopFailure': s.lights = { reason: e.error || 'unknown' }; c.status = 'sleeping'; c.tool = null; break;
      case 'PreCompact': s.cleaning = now; say(s.chars.boss, 'TIDY', now, { ms: 120000 }); break;
      case 'PostCompact':
        s.cleaning = 0;
        s.reports = 0; // the report pile gets filed away
        s.chars.boss.say = null;
        s.effects.push({ type: 'sparkle', at: now });
        break;
      case 'PostModelSwitch': setModel(s, e.to_model); break;
      case 'SubagentStop': {
        const from = seat(c), report = firstLine(e.last_assistant_message || c.handback);
        Object.assign(c, { status: 'sleeping', tool: null, busy: false, lastReport: report });
        delete s.who[e.agent_id];
        s.gone.set(e.agent_id, c.id);
        if (s.gone.size > 200) s.gone.delete(s.gone.keys().next().value);
        if (c.kind === 'temp') delete s.chars[c.id];
        s.effects.push({ type: 'paper', at: now, x: from.x + 6, y: from.y + 8 });
        s.reports++;
        say(s.chars.boss, '', now, { ms: 3000, delay: PAPER_MS, icon: 'doc' }); // boss reads it once the paper lands
        break;
      }
    }
    return s;
  }

  // ---- the building: one floor (a whole office) per claude session ----
  const CLOSED_KEEP_MS = 10 * 60 * 1000; // a closed floor stays, lights off, so a restart in the same folder reopens it
  const STALE_MS = 2 * 60 * 60 * 1000; // silent this long = claude was killed without a SessionEnd

  function createBuilding() { return { floors: {}, alias: {}, ended: new Set(), seq: 0 }; }

  function closeFloor(f, now) {
    f.closedAt = now;
    for (const c of Object.values(f.state.chars)) Object.assign(c, { status: 'sleeping', tool: null });
    f.state.lights = { reason: 'closed' };
  }

  // Which floor a session's event belongs to; a session seen for the first time gets one.
  function floorFor(b, e, now) {
    const sid = e.session_id, ev = e.hook_event_name, project = e.project || 'claude';
    if (!sid) return null;
    if (ev === 'SessionStart') b.ended.delete(sid); // claude --resume brings an ended session back
    if (b.ended.has(sid)) return null; // a straggler from a session that already ended (hooks are async)
    if (b.alias[sid]) return b.floors[b.alias[sid]] || null;
    if (ev === 'SessionEnd' || ev === 'SubagentStop') return null;
    const here = Object.values(b.floors).filter(f => f.project === project);
    let f = null;
    if (ev === 'SessionStart' && ['clear', 'compact'].includes(e.source)) { // same terminal, new session id
      f = here.filter(x => !x.closedAt).sort((a, z) => (z.clearedAt || z.lastAt) - (a.clearedAt || a.lastAt))[0] || null;
    }
    if (!f) { // a restart in the same folder takes its closed floor back, fresh
      f = here.find(x => x.closedAt) || null;
      if (f) Object.assign(f, { state: createState(), closedAt: 0, clearedAt: 0 });
    }
    if (!f) {
      const used = new Set(Object.values(b.floors).map(x => x.n));
      let n = 1;
      while (used.has(n)) n++;
      const id = 'F' + ++b.seq;
      f = b.floors[id] = { id, n, project, state: createState(), lastAt: now, closedAt: 0, clearedAt: 0 };
    }
    b.alias[sid] = f.id;
    return f;
  }

  // Route a hook event to its session's floor and update that office. Returns the floor, or null.
  function route(b, e, now = Date.now()) {
    const f = floorFor(b, e, now);
    if (!f) return null;
    f.lastAt = now;
    if (e.hook_event_name === 'SessionEnd') {
      b.ended.add(e.session_id);
      if (b.ended.size > 500) b.ended.delete(b.ended.values().next().value);
      delete b.alias[e.session_id];
      if (e.reason === 'clear') f.clearedAt = now; // the same terminal goes on with a new session id
      else closeFloor(f, now);
      return f;
    }
    reduce(f.state, e, now);
    return f;
  }

  // Close floors claude left without a word; take away long-closed ones.
  function prune(b, now = Date.now()) {
    for (const f of Object.values(b.floors)) {
      if (!f.closedAt && now - f.lastAt > STALE_MS) closeFloor(f, now);
      if (f.closedAt && now - f.closedAt > CLOSED_KEEP_MS) {
        delete b.floors[f.id];
        for (const [sid, id] of Object.entries(b.alias)) if (id === f.id) delete b.alias[sid];
      }
    }
  }

  // What a floor's tab shows: busy, someone waiting for you, or closed.
  function floorStatus(f) {
    const cs = Object.values(f.state.chars);
    return { closed: !!f.closedAt, waiting: !f.closedAt && cs.some(c => c.status === 'waiting'), working: !f.closedAt && cs.some(c => c.status !== 'sleeping') };
  }

  // Top-left of a person's sprite: 16x28 seated cells sit at (desk.x+17, desk.y-15); temps stand.
  function seat(c) {
    if (c.desk < 0) { const [x, y] = SPOTS[c.n % SPOTS.length]; return { x: x - 6 * Math.floor(c.n / SPOTS.length), y, standing: true }; }
    const d = DESKS[c.desk];
    return { x: d.x + 17, y: d.y - 15 };
  }

  let view = { S: 1, ox: 0, oy: 0, dpr: 1 }; // last frame's scale/offset, to map clicks back to office pixels

  // Character under a point given in CSS pixels on the canvas, or null. Clicking a desk counts as its owner.
  function hit(s, cx, cy) {
    const x = (cx * view.dpr - view.ox) / view.S, y = (cy * view.dpr - view.oy) / view.S;
    return Object.values(s.chars).find(c => {
      const p = seat(c), d = DESKS[c.desk];
      const r = d ? { x: d.x, y: d.y - 9, w: d.w, h: 28 } : { x: p.x + 4, y: p.y, w: 16, h: 38 };
      return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    }) || null;
  }

  // ---- art ----

  let art = null, imgs = null, theme = 'day';
  function useArt(a, images) { art = a; imgs = images; }
  function setTheme(name) { if (art?.themes[name]) theme = name; return theme; }
  const themes = () => (art ? Object.keys(art.themes) : []);

  // 3x5 pixel font. Letters the design spelled on its nameplates come from art.json; the rest are drawn to match.
  const FONT = {
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
    F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
    K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
    P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
    Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
    4: '101101111001001', 5: '111100110001110', 6: '011100110101010', 7: '111001010010010', 8: '010101010101010',
    9: '010101011001110', '!': '010010010000010', '?': '110001010000010', '.': '000000000000010', '-': '000000111000000',
    ':': '000010000010000', '/': '001001010100100', ' ': '000000000000000',
  };
  const glyph = ch => (art?.glyphs[ch] ? art.glyphs[ch].join('') : FONT[ch] || FONT['?']);
  const textWidth = text => Math.max(0, text.length * 4 - 1);
  function text(R, str, x, y, color) {
    [...str].forEach((ch, i) => { const g = glyph(ch); for (let k = 0; k < 15; k++) if (g[k] === '1') R(x + i * 4 + (k % 3), y + ((k / 3) | 0), 1, 1, color); });
  }
  // what fits a 30px nameplate: the agent type's first word, letters and digits, 7 at most
  const plateText = label => (label === 'teammate' ? 'TEAM' : String(label).split(/[-_\s]/)[0].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7));

  // ---- drawing ----

  const POSE = { idle: 0, typeA: 1, typeB: 2, read: 3, raise: 4, sleep: 5 };
  const SCREEN_FOR = { typing: 'edit', reading: 'read', running: 'run', delegating: 'delegate', waiting: 'ask', thinking: 'think', working: 'think' };
  const ICON_FOR = { typing: 'edit', reading: 'read', running: 'run', delegating: 'delegate', waiting: 'ask', thinking: 'think', working: 'think' };
  const plus = (R, x, y, color) => { R(x + 1, y, 1, 3, color); R(x, y + 1, 3, 1, color); };

  function poseOf(c, t) {
    switch (c.status) {
      case 'sleeping': return POSE.sleep;
      case 'typing': case 'running': return Math.floor(t / 220) % 2 ? POSE.typeB : POSE.typeA;
      case 'reading': return POSE.read;
      case 'waiting': return POSE.raise;
      default: return POSE.idle;
    }
  }

  function rowOf(c) {
    const rows = art.people.rows;
    if (c.kind === 'boss') return rows[c.model] ?? rows.boss;
    return rows.staff[(c.desk - 1) % rows.staff.length];
  }

  // A bubble the design's way: rounded 1px outline, white (yellow when it needs you), a 2px tail under the middle.
  function textBubble(R, str, cx, bottom, { ink = INK, hot = false } = {}) {
    const w = textWidth(str) + 4, h = 10, x = Math.round(cx - Math.floor(w / 2)), y = bottom - h + 1;
    R(x + 1, y, w - 2, 1, INK); R(x + 1, y + 8, w - 2, 1, INK); R(x, y + 1, 1, 7, INK); R(x + w - 1, y + 1, 1, 7, INK);
    R(x + 1, y + 1, w - 2, 7, hot ? HOT : PAPER);
    R(x + Math.floor(w / 2) - 1, y + 9, 2, 1, INK);
    text(R, str, x + 2, y + 2, ink);
  }

  function iconBubble(ctx, R, name, cx, bottom) {
    if (name === 'doc') { // a report: a little page with lines
      textBubble(R, '  ', cx, bottom);
      const x = Math.round(cx) - 2, y = bottom - 7;
      R(x, y, 5, 5, '#4c4f69'); R(x + 1, y + 1, 3, 3, PAPER); R(x + 1, y + 2, 3, 1, '#9ca0b0');
      return;
    }
    const b = art.bubbles.items[name];
    if (b) ctx.drawImage(imgs.bubbles, b.x, b.y, b.w, b.h, Math.round(cx - Math.floor(b.w / 2)), bottom - b.h + 1, b.w, b.h);
  }

  function zzz(ctx, R, p, t, n) {
    const Z = ['1111', '0010', '0100', '1111'], z = ['111', '010', '111'];
    for (const [k, g, dx, dy] of [[0, Z, 17, 4], [1, z, 13, 9]]) {
      const ph = (t / 2400 + k * 0.5 + n * 0.13) % 1; // each drifts up and fades
      ctx.globalAlpha = 1 - ph;
      const x = p.x + dx + Math.round(ph * 3), y = p.y + dy - Math.round(ph * 8);
      g.forEach((row, j) => [...row].forEach((v, i) => { if (v === '1') R(x + i, y + j, 1, 1, i === row.length - 1 && j === 0 ? '#f9f8f3' : '#f3ede1'); }));
    }
    ctx.globalAlpha = 1;
  }

  function heart(R, x, y) {
    R(x, y, 2, 1, RED); R(x + 3, y, 2, 1, RED); R(x, y + 1, 5, 1, RED); R(x + 1, y + 2, 3, 1, RED); R(x + 2, y + 3, 1, 1, RED);
  }

  function drawOverlay(ctx, R, c, t, now, clap) {
    const p = seat(c), cx = p.x + (p.standing ? 12 : 8), bottom = p.y + (p.standing ? 2 : 4);
    if (now - c.petAt < 1000) heart(R, cx + 5, bottom - 2 - Math.floor((now - c.petAt) / 150));
    if (now - c.oopsAt < 1500) { // sweat drops
      const off = Math.floor((now - c.oopsAt) / 120) % 4;
      R(cx - 7, bottom + 5 + off, 1, 2, '#89dceb');
      R(cx + 6, bottom + 4 + off, 1, 2, '#89dceb');
    }
    if (clap) return textBubble(R, 'YAY!', cx, bottom);
    if (c.say && now >= c.say.from && now < c.say.until) {
      return c.say.icon ? iconBubble(ctx, R, c.say.icon, cx, bottom) : textBubble(R, c.say.text, cx, bottom, { ink: c.say.ink });
    }
    if (c.status === 'sleeping') return p.standing ? null : zzz(ctx, R, p, t, c.n);
    iconBubble(ctx, R, now - c.wokeAt < 900 ? 'wake' : ICON_FOR[c.status], cx, bottom);
  }

  function drawEffect(R, f, age, t) {
    if (f.type === 'paper') { // a report flying in an arc to the boss's in-tray
      const p = Math.min(1, age / PAPER_MS);
      const x = Math.round(f.x + (PILE.x - f.x) * p), y = Math.round(f.y + (PILE.y - 6 - f.y) * p - Math.sin(Math.PI * p) * 18);
      R(x, y, 7, 8, '#4c4f69'); R(x + 1, y + 1, 5, 6, PAPER); R(x + 2, y + 2, 3, 1, '#9ca0b0'); R(x + 2, y + 4, 3, 1, '#9ca0b0');
    } else if (f.type === 'confetti') {
      for (let i = 0; i < 48; i++) {
        const x = (i * 37 + Math.sin(age / 300 + i) * 4 + W) % W, y = -4 + (age / 1000) * (50 + ((i * 13) % 50)) - (i % 7) * 6;
        if (y > -2 && y < H) R(Math.round(x), Math.round(y), 1, 2, CONFETTI[i % CONFETTI.length]);
      }
    } else if (f.type === 'sparkle') {
      const d = DESKS[0];
      for (let k = 0; k < 5; k++) if ((Math.floor(t / 120) + k) % 2) plus(R, d.x + 4 + k * 9, d.y - 4 + (k % 2) * 8, HOT);
    }
  }

  function step(canvas, s, t) {
    const now = Date.now(), dpr = window.devicePixelRatio || 1;
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const S = Math.max(1, Math.floor(Math.min(cw / W, ch / H)));
    view = { S, ox: Math.floor((cw - W * S) / 2), oy: Math.floor((ch - H * S) / 2), dpr };
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#181825';
    ctx.fillRect(0, 0, cw, ch);
    if (!art || !imgs) return; // art still loading
    ctx.setTransform(S, 0, 0, S, view.ox, view.oy);
    ctx.imageSmoothingEnabled = false;
    const R = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
    s.effects = s.effects.filter(f => now - f.at < EFFECT_MS[f.type]);
    const chars = Object.values(s.chars), clap = s.effects.some(f => f.type === 'clap');
    const look = imgs.themes[theme], [cellW, cellH] = art.cell;

    ctx.drawImage(look.room, 0, 0);

    // people at their desks (in front of the partition, above the desk), temps standing in the open
    for (const c of chars) {
      const p = seat(c);
      const hop = now - c.wokeAt < 300 || now - c.petAt < 300 ? -2 : clap && Math.floor(t / 150) % 2 ? -1 : 0;
      if (p.standing) ctx.drawImage(look.standing, p.x, p.y + hop);
      else ctx.drawImage(look.people, poseOf(c, t) * cellW, rowOf(c) * cellH, cellW, cellH, p.x, p.y + hop, cellW, cellH);
    }

    // screens and nameplates
    const blink = Math.floor(t / 400) % 2;
    for (const c of chars) {
      const d = DESKS[c.desk];
      if (!d) continue;
      const scr = c.status === 'sleeping' ? -1 : art.screens.items.indexOf(SCREEN_FOR[c.status]); // asleep: the room's screen is off
      if (scr >= 0 && !(c.status === 'waiting' && blink)) ctx.drawImage(imgs.screens, scr * art.screens.w, 0, art.screens.w, art.screens.h, d.x + 3, d.y - 1, art.screens.w, art.screens.h);
      if (c.kind === 'staff' && c.label) { const str = plateText(c.label); text(R, str, d.x + 2 + Math.floor((30 - textWidth(str)) / 2), d.y + 13, art.themes[theme].plateInk); }
    }

    // report pile in the boss's in-tray (papers still in the air don't count yet)
    const pile = Math.min(6, s.reports - s.effects.filter(f => f.type === 'paper').length);
    for (let k = 0; k < pile; k++) R(PILE.x, PILE.y - k, 7, 1, k % 2 ? PAPER : '#bcc0cc');
    for (const c of chars) { // a monitor smoking after three failures in a row
      const d = DESKS[c.desk];
      if (!d || c.failStreak < 3) continue;
      for (let k = 0; k < 3; k++) { const ph = (t / 1500 + k / 3) % 1; ctx.globalAlpha = 1 - ph; R(Math.round(d.x + 6 + Math.sin(ph * 6 + k) * 2), Math.round(d.y - 4 - ph * 12), 3, 3, '#9399b2'); }
      ctx.globalAlpha = 1;
    }
    if (s.cleaning && now - s.cleaning < 120000) { // a robot vacuum doing laps down the aisle + sparkles over desks
      const rx = Math.floor(((now - s.cleaning) / 25) % (W + 16)) - 8;
      R(rx, 99, 9, 4, '#585b70'); R(rx + 1, 98, 7, 1, '#9399b2'); R(rx + 4, 99, 1, 1, blink ? '#f38ba8' : '#a6e3a1');
      DESKS.forEach((d, i) => { if ((Math.floor(t / 250) + i) % 3 === 0) plus(R, d.x + 20 + ((i * 7) % 10), d.y + 8, HOT); });
    }
    for (const f of s.effects) drawEffect(R, f, now - f.at, t);
    for (const c of chars) drawOverlay(ctx, R, c, t, now, clap);

    if (s.lights) { // blackout: lights off + a sign hanging from the ceiling
      ctx.fillStyle = 'rgba(17,17,27,0.7)';
      ctx.fillRect(0, 0, W, H);
      const str = { rate_limit: 'LIMIT', overloaded: 'OVERLOAD', closed: 'CLOSED' }[s.lights.reason] || 'ERROR';
      const w = textWidth(str) + 8, x = Math.round(W / 2 - w / 2);
      R(x + 2, 0, 1, 9, '#6c6f85'); R(x + w - 3, 0, 1, 9, '#6c6f85');
      R(x - 1, 8, w + 2, 11, INK); R(x, 9, w, 9, HOT);
      text(R, str, x + 4, 11, INK);
    }
  }

  const Office = { createState, reduce, createBuilding, route, prune, floorStatus, step, hit, setModel, useArt, setTheme, themes, plateText, STATUS_KO };
  if (typeof module === 'object') module.exports = Office;
  else window.Office = Office;
})();
