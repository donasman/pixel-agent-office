// Office state from Claude Code hook events, plus the pixel drawing.
// Everyone sits at a fixed desk asleep; a subagent starting wakes a staff member, finishing puts them back to sleep
// and sends a report flying to the boss. reduce() and hit() are plain logic checked by office.test.js; step() draws.
(function () {
  const W = 192, H = 144; // logical pixels, scaled up by an integer factor so pixels stay crisp
  const DESKS = [{ x: 80, y: 40, w: 34 }]; // desk 0 is the boss's (wider: room for the report pile), 1..8 are staff desks
  for (const y of [78, 112]) for (let i = 0; i < 4; i++) DESKS.push({ x: 14 + i * 46, y, w: 24 });

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
  const OUTFITS = { opus: '#313244', sonnet: '#d97757', haiku: '#a6e3a1', fable: '#8839ef' }; // boss shirt per model
  const BLACKOUT_KO = { rate_limit: '한도 초과', overloaded: '과부하' };
  const PAPER_MS = 1200;
  const EFFECT_MS = { paper: PAPER_MS, confetti: 2500, clap: 1500, sparkle: 1000 };
  const SHIRTS = ['#40a02b', '#1e66f5', '#df8e1d', '#8839ef', '#179299', '#e64553', '#04a5e5', '#ea76cb'];
  const HAIRS = ['#4c3a2e', '#1e1e2e', '#a0522d', '#d9b26f', '#6c6f85'];
  const CONFETTI = ['#f38ba8', '#f9e2af', '#a6e3a1', '#89b4fa', '#cba6f7', '#fab387'];
  const FONT = '4px "Malgun Gothic", sans-serif';

  function newChar(id, kind, desk, n) {
    return {
      id, kind, desk, n, label: kind === 'boss' ? 'Claude' : '', task: '', status: 'sleeping', tool: null,
      busy: false, jobs: 0, history: [], since: 0, wokeAt: 0, petAt: 0,
      say: null, oopsAt: 0, failStreak: 0, lastReport: '', handback: '', model: null,
      color: kind === 'boss' ? '#d97757' : SHIRTS[n % SHIRTS.length],
    };
  }

  function createState() {
    const chars = { boss: newChar('boss', 'boss', 0, 0) };
    for (let i = 1; i < DESKS.length; i++) chars['desk' + i] = newChar('desk' + i, 'staff', i, i);
    return {
      chars, who: {}, bossSession: null, pendingTasks: [], knownTasks: {}, doneTools: new Set(), gone: new Map(),
      seq: DESKS.length, lights: null, cleaning: 0, effects: [], reports: 0,
    };
  }

  // A report (SubagentHandback) can arrive after its SubagentStop: file it with whoever wrote it.
  function lateReport(s, charId, msg) {
    const c = s.chars[charId], boss = s.chars.boss;
    if (!msg || !c || c.lastReport !== '완료') return s;
    c.lastReport = firstLine(msg);
    if (boss.say?.text === '보고: 완료') boss.say.text = '보고: ' + c.lastReport;
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

  // First meaningful line of a subagent's final message (headings skipped, markdown stripped), short enough for a bubble.
  function firstLine(msg) {
    const lines = String(msg || '').split('\n').map(l => l.trim()).filter(Boolean);
    const pick = lines.find(l => !l.startsWith('#')) || lines[0] || '';
    // strip emphasis and line markers only: a lone * is content (*.md)
    const line = pick.replace(/\*\*|__|`/g, '').replace(/^(#+|>|[-*])\s+/, '').replace(/\s+/g, ' ').trim() || '완료';
    return line.length > 24 ? line.slice(0, 23) + '…' : line;
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
    if (!c) { const n = ++s.seq; c = s.chars['temp' + n] = newChar('temp' + n, 'temp', -1, n); } // office full: a temp stands in
    Object.assign(c, { busy: true, label, task: '', tool: null, history: [], handback: '', since: now });
    c.jobs++;
    s.who[id] = c.id;
    return c;
  }

  function wake(c, status, now) {
    if (c.status === 'sleeping') { c.wokeAt = now; if (c.kind === 'boss') c.since = now; }
    c.status = status;
  }

  function say(c, text, now, ms = 2000, delay = 0) { c.say = { text, from: now + delay, until: now + delay + ms }; }

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
        if (COMMIT_CMD.test(cmd)) { s.effects.push({ type: 'confetti', at: now }); say(c, '커밋 완료!', now); }
        break;
      case 'PostToolUseFailure':
        markDone(s, e.tool_use_id);
        if (c.status !== 'sleeping') c.status = 'thinking';
        c.tool = null;
        if (e.is_interrupt) break; // the user pressed Esc: not the agent's mistake
        c.oopsAt = now;
        c.failStreak++;
        say(c, TEST_CMD.test(cmd) ? '테스트 실패… 휴' : '앗!', now);
        break;
      case 'Notification':
        if (e.notification_type === 'permission_prompt' || /permission/i.test(e.message || '')) wake(c, 'waiting', now);
        else c.status = 'sleeping';
        break;
      case 'Stop': c.status = 'sleeping'; c.tool = null; break;
      case 'StopFailure': s.lights = { reason: e.error || 'unknown' }; c.status = 'sleeping'; c.tool = null; break;
      case 'PreCompact': s.cleaning = now; say(s.chars.boss, '정리 중…', now, 120000); break;
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
        s.effects.push({ type: 'paper', at: now, x: from.x, y: from.y + 2 });
        s.reports++;
        say(s.chars.boss, '보고: ' + report, now, 4000, PAPER_MS); // boss reads it once the paper lands
        break;
      }
    }
    return s;
  }

  function seat(c) {
    if (c.desk < 0) return { x: 30 + ((c.n * 13) % 130), y: 56 };
    const d = DESKS[c.desk];
    return { x: d.x + 13, y: d.y - 10 }; // behind the desk, right of the monitor
  }

  let view = { S: 1, ox: 0, oy: 0, dpr: 1 }; // last frame's scale/offset, to map clicks back to office pixels

  // Character under a point given in CSS pixels on the canvas, or null. Clicking a desk counts as its owner.
  function hit(s, cx, cy) {
    const x = (cx * view.dpr - view.ox) / view.S, y = (cy * view.dpr - view.oy) / view.S;
    return Object.values(s.chars).find(c => {
      const p = seat(c), d = DESKS[c.desk];
      const r = d ? { x: d.x, y: p.y, w: d.w, h: d.y + 10 - p.y } : { x: p.x, y: p.y, w: 8, h: 12 };
      return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    }) || null;
  }

  // ---- drawing ----

  const plus = (R, x, y, color) => { R(x + 1, y, 1, 3, color); R(x, y + 1, 3, 1, color); };

  function drawDesk(R, d, i, owner, t) {
    const f = Math.floor(t / 200) % 4;
    R(d.x, d.y, d.w, 4, i ? '#a47148' : '#7f5539');
    R(d.x, d.y + 4, d.w, 6, i ? '#8b5e34' : '#6f4518');
    R(d.x + 1, d.y - 8, 10, 7, '#313244'); // monitor frame
    R(d.x + 5, d.y - 1, 2, 1, '#313244');
    const sx = d.x + 2, sy = d.y - 7, scr = c => R(sx, sy, 8, 5, c);
    switch (owner && owner.status) {
      case 'typing': scr('#1e1e2e'); for (let k = 0; k < 3; k++) R(sx + 1, sy + 1 + k, ((k * 3 + f) % 6) + 1, 1, '#a6e3a1'); break;
      case 'reading': scr('#eff1f5'); for (let k = 0; k < 3; k++) R(sx + 1, sy + 1 + k, 6 - ((k + f) % 2) * 2, 1, '#9ca0b0'); break;
      case 'running': scr('#11111b'); R(sx + 1, sy + 1, 4, 1, '#a6e3a1'); if (f % 2) R(sx + 1 + f, sy + 3, 1, 1, '#a6e3a1'); break;
      case 'delegating': scr('#89b4fa'); R(sx + 2, sy + 1, 4, 3, '#eff1f5'); break;
      case 'waiting': scr(f % 2 ? '#f9e2af' : '#fab387'); break;
      case 'thinking': case 'working': scr('#313244'); R(sx + 1 + ((f * 2) % 6), sy + 2, 1, 1, '#cdd6f4'); break;
      default: scr('#11111b'); // asleep: screen off
    }
  }

  function drawChar(R, c, t, now, clap) {
    const p = seat(c), sleeping = c.status === 'sleeping', f = Math.floor(t / 180) % 2;
    const hop = now - c.wokeAt < 300 || now - c.petAt < 300 || (clap && Math.floor(t / 150) % 2) ? -2 : 0;
    const x = p.x, y = p.y + (sleeping ? 3 : 0) + hop; // asleep: head down on the desk
    const skin = '#f5c9a6', eye = '#1e1e2e';
    const arm = (ax, ay, len) => { R(ax, ay, 1, len - 1, c.color); R(ax, ay + len - 1, 1, 1, skin); };
    R(x + 1, y, 6, 2, HAIRS[c.n % HAIRS.length]);
    R(x + 1, y + 2, 6, 3, skin);
    if (sleeping) { R(x + 1, y + 3, 2, 1, eye); R(x + 5, y + 3, 2, 1, eye); }
    else if ((t + c.n * 700) % 3200 > 150) { R(x + 2, y + 3, 1, 1, eye); R(x + 5, y + 3, 1, 1, eye); } // blink
    R(x + 1, y + 5, 6, 4, c.color);
    if (c.kind === 'boss') {
      if (c.model === 'opus') { R(x + 3, y + 5, 2, 1, '#eff1f5'); R(x + 3, y + 6, 2, 2, '#d20f39'); } // suit: collar + red tie
      else if (c.model === 'haiku') { R(x + 1, y - 1, 6, 2, '#1e66f5'); R(x + 6, y + 1, 2, 1, '#1e66f5'); } // casual: cap
      else if (c.model === 'fable') { R(x + 3, y - 4, 2, 1, '#8839ef'); R(x + 2, y - 3, 4, 1, '#8839ef'); R(x + 1, y - 2, 6, 2, '#8839ef'); R(x + 3, y - 2, 1, 1, '#f9e2af'); } // wizard hat
      else R(x + 3, y + 5, 2, 3, '#1e1e2e'); // tie
    }
    if (sleeping) { R(x, y + 6, 8, 2, c.color); R(x + 3, y + 6, 2, 1, skin); } // arms folded on the desk
    else if (c.status === 'typing') { arm(x, y + 5 + f, 3); arm(x + 7, y + 6 - f, 3); }
    else if (c.status === 'reading') { arm(x, y + 6, 3); arm(x + 7, y + 6, 3); R(x + 1, y + 6, 6, 3, '#eff1f5'); R(x + 2, y + 7, 4, 1, '#9ca0b0'); }
    else if (c.status === 'waiting') { arm(x, y + 5, 4); R(x + 7, y + 1, 1, 4, c.color); R(x + 7, y, 1, 1, skin); }
    else { arm(x, y + 5, 4); arm(x + 7, y + 5, 4); }
    R(x + 2, y + 9, 1, 3, '#45475a');
    R(x + 5, y + 9, 1, 3, '#45475a');
    if (now - c.oopsAt < 1500) { // sweat drops
      const off = Math.floor((now - c.oopsAt) / 120) % 4;
      R(x - 1, y + 1 + off, 1, 2, '#89dceb');
      R(x + 8, y + off, 1, 2, '#89dceb');
    }
  }

  function bubble(ctx, R, x, y, txt, hot) {
    ctx.font = FONT;
    ctx.textAlign = 'left';
    const w = Math.ceil(ctx.measureText(txt).width) + 3, by = y - 9;
    const bx = Math.max(2, Math.min(W - w - 2, Math.round(x + 4 - w / 2)));
    R(bx, by - 1, w, 8, '#1e1e2e'); R(bx - 1, by, w + 2, 6, '#1e1e2e');
    R(bx, by, w, 6, hot ? '#f9e2af' : '#eff1f5');
    R(x + 3, by + 7, 2, 1, '#1e1e2e');
    ctx.fillStyle = '#1e1e2e';
    ctx.fillText(txt, bx + 1.5, by + 3.3);
  }

  function zzz(ctx, c, x, y, t) {
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = '#1e1e2e';
    ctx.fillStyle = '#eff1f5';
    ctx.textAlign = 'left';
    for (let k = 0; k < 3; k++) {
      const ph = (t / 2400 + k / 3 + c.n * 0.13) % 1; // each z drifts up and fades
      ctx.globalAlpha = 1 - ph;
      ctx.font = `${(3 + ph * 2).toFixed(1)}px sans-serif`;
      ctx.strokeText('z', x + 6 + ph * 5, y + 2 - ph * 9);
      ctx.fillText('z', x + 6 + ph * 5, y + 2 - ph * 9);
    }
    ctx.globalAlpha = 1;
  }

  function heart(R, x, y) {
    const red = '#e64553';
    R(x, y, 2, 1, red); R(x + 3, y, 2, 1, red); R(x, y + 1, 5, 1, red); R(x + 1, y + 2, 3, 1, red); R(x + 2, y + 3, 1, 1, red);
  }

  function drawOverlay(ctx, R, c, t, now, clap) {
    const { x, y } = seat(c);
    if (now - c.petAt < 1000) heart(R, x + 8, y - 2 - Math.floor((now - c.petAt) / 150));
    if (clap) return bubble(ctx, R, x, y, '짝짝!', false);
    if (c.say && now >= c.say.from && now < c.say.until) return bubble(ctx, R, x, y, c.say.text, true);
    if (c.status === 'sleeping') return zzz(ctx, c, x, y, t);
    const txt = now - c.wokeAt < 900 ? '!'
      : c.status === 'thinking' ? '.'.repeat((Math.floor(t / 400) % 3) + 1)
      : c.status === 'waiting' ? '?' : c.tool;
    if (txt) bubble(ctx, R, x, y, txt, txt === '!' || txt === '?');
  }

  function smoke(ctx, R, d, t) {
    for (let k = 0; k < 3; k++) {
      const ph = (t / 1500 + k / 3) % 1;
      ctx.globalAlpha = 1 - ph;
      R(Math.round(d.x + 4 + Math.sin(ph * 6 + k) * 2), Math.round(d.y - 10 - ph * 12), 3, 3, '#9399b2');
    }
    ctx.globalAlpha = 1;
  }

  function drawEffect(R, f, age, t) {
    if (f.type === 'paper') { // report flying in an arc to the boss's pile
      const p = Math.min(1, age / PAPER_MS), d = DESKS[0], tx = d.x + 25, ty = d.y - 8;
      const x = Math.round(f.x + (tx - f.x) * p), y = Math.round(f.y + (ty - f.y) * p - Math.sin(Math.PI * p) * 18);
      R(x, y, 7, 8, '#1e1e2e'); R(x + 1, y + 1, 5, 6, '#eff1f5'); R(x + 2, y + 2, 3, 1, '#9ca0b0'); R(x + 2, y + 4, 3, 1, '#9ca0b0');
    } else if (f.type === 'confetti') {
      for (let i = 0; i < 48; i++) {
        const x = (i * 37 + Math.sin(age / 300 + i) * 4 + W) % W, y = -4 + (age / 1000) * (50 + ((i * 13) % 50)) - (i % 7) * 6;
        if (y > -2 && y < H) R(Math.round(x), Math.round(y), 1, 2, CONFETTI[i % CONFETTI.length]);
      }
    } else if (f.type === 'sparkle') {
      const d = DESKS[0];
      for (let k = 0; k < 4; k++) if ((Math.floor(t / 120) + k) % 2) plus(R, d.x + 2 + k * 8, d.y - 14 + (k % 2) * 6, '#f9e2af');
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
    ctx.setTransform(S, 0, 0, S, view.ox, view.oy);
    ctx.textBaseline = 'middle';
    const R = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
    s.effects = s.effects.filter(f => now - f.at < EFFECT_MS[f.type]);
    const chars = Object.values(s.chars), clap = s.effects.some(f => f.type === 'clap');
    const cleaning = s.cleaning && now - s.cleaning < 120000;

    // room
    R(0, 0, W, 28, '#45475a'); R(0, 27, W, 1, '#313244');
    for (const wx of [44, 124]) { R(wx, 6, 26, 15, '#cdd6f4'); R(wx + 1, 7, 24, 13, '#89b4fa'); R(wx + 12, 7, 1, 13, '#cdd6f4'); R(wx + 1, 13, 24, 1, '#cdd6f4'); }
    R(5, 7, 14, 21, '#6c4a2e'); R(6, 8, 12, 20, '#8b5a2b'); R(15, 18, 2, 2, '#f9e2af'); // door
    R(174, 8, 11, 11, '#cdd6f4'); R(179, 9, 1, 5, '#1e1e2e'); R(179, 13, 4, 1, '#1e1e2e'); // clock
    for (let y = 28; y < H; y += 8) for (let x = 0; x < W; x += 8) R(x, y, 8, Math.min(8, H - y), ((x >> 3) + ((y - 28) >> 3)) % 2 ? '#c9a97a' : '#bf9e6e');
    for (const px of [2, 180]) { R(px + 1, 118, 10, 10, '#40a02b'); R(px + 3, 114, 6, 6, '#40a02b'); R(px + 2, 128, 8, 8, '#a0522d'); } // plants

    // people, then desks in front of them (temps stand in the open)
    for (const c of chars) drawChar(R, c, t, now, clap);
    DESKS.forEach((d, i) => drawDesk(R, d, i, chars.find(c => c.desk === i), t));

    // report pile on the boss's desk (papers still in the air don't count yet)
    const pile = Math.min(6, s.reports - s.effects.filter(f => f.type === 'paper').length);
    for (let k = 0; k < pile; k++) R(DESKS[0].x + 25, DESKS[0].y - 1 - k, 7, 1, k % 2 ? '#eff1f5' : '#bcc0cc');
    for (const c of chars) if (c.failStreak >= 3 && c.desk >= 0) smoke(ctx, R, DESKS[c.desk], t); // monitor smoking

    if (cleaning) { // robot vacuum doing laps + sparkles over desks
      const rx = Math.floor(((now - s.cleaning) / 25) % (W + 16)) - 8;
      R(rx, 64, 9, 4, '#585b70'); R(rx + 1, 63, 7, 1, '#9399b2'); R(rx + 4, 64, 1, 1, Math.floor(t / 300) % 2 ? '#f38ba8' : '#a6e3a1');
      DESKS.forEach((d, i) => { if ((Math.floor(t / 250) + i) % 3 === 0) plus(R, d.x + 4 + ((i * 7) % 16), d.y - 3, '#f9e2af'); });
    }
    for (const f of s.effects) drawEffect(R, f, now - f.at, t);
    for (const c of chars) drawOverlay(ctx, R, c, t, now, clap);

    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#1e1e2e';
    for (const c of chars) if (c.desk >= 0 && c.label) ctx.fillText(c.label.slice(0, 16), DESKS[c.desk].x + DESKS[c.desk].w / 2, DESKS[c.desk].y + 14);

    if (s.lights) { // blackout: lights off + hanging sign
      ctx.fillStyle = 'rgba(17,17,27,0.7)';
      ctx.fillRect(0, 0, W, H);
      const txt = '⚡ ' + (BLACKOUT_KO[s.lights.reason] || '서버 오류');
      ctx.font = FONT;
      ctx.textAlign = 'left';
      const w = Math.ceil(ctx.measureText(txt).width) + 6, bx = Math.round(W / 2 - w / 2);
      R(bx + 2, 0, 1, 9, '#6c6f85'); R(bx + w - 3, 0, 1, 9, '#6c6f85');
      R(bx - 1, 8, w + 2, 10, '#1e1e2e'); R(bx, 9, w, 8, '#f9e2af');
      ctx.fillStyle = '#1e1e2e';
      ctx.fillText(txt, bx + 3, 13.3);
    }
  }

  const Office = { createState, reduce, step, hit, setModel, STATUS_KO };
  if (typeof module === 'object') module.exports = Office;
  else window.Office = Office;
})();
