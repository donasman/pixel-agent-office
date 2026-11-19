// Checks the hook-event -> office-state logic. Event shapes match a real claude 2.1 hook capture.
const assert = require('node:assert');
const Office = require('../public/office.js');

// The office's words are English until the page says its language is Korean. The checks below read the Korean ones.
assert.equal(Office.statusText('sleeping'), 'Asleep');
assert.equal(Office.setLang('en-US'), false);
assert.equal(Office.setLang('ko-KR'), true);
assert.deepEqual([Office.statusText('sleeping'), Office.T('Allow', '허용')], ['꿀잠 중', '허용']);

const s = Office.createState();
const ev = (name, extra = {}) => Office.reduce(s, { session_id: 'S1', hook_event_name: name, ...extra }, 1000);
const { chars } = s;

assert.equal(Object.values(chars).filter(c => c.status === 'sleeping').length, 9, 'boss + 8 staff start asleep');

ev('SessionStart', { source: 'startup' });
assert.equal(chars.boss.status, 'sleeping', 'boss sleeps until given a prompt');
ev('UserPromptSubmit');
assert.deepEqual([chars.boss.status, chars.boss.wokeAt], ['thinking', 1000]);

ev('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Run Glob for *.js' } });
assert.equal(chars.boss.status, 'delegating');
ev('SubagentStart', { agent_id: 'A1', agent_type: 'Explore' });
assert.deepEqual([chars.desk1.label, chars.desk1.task, chars.desk1.status, chars.desk1.jobs], ['Explore', 'Run Glob for *.js', 'thinking', 1]);

ev('PreToolUse', { agent_id: 'A1', tool_name: 'Grep' });
assert.deepEqual([chars.desk1.status, chars.desk1.history], ['reading', ['Grep']]);
assert.equal(chars.boss.status, 'delegating', "a subagent's tools must not move the boss");

ev('SubagentStart', { agent_id: 'A2', agent_type: 'Plan' });
assert.equal(chars.desk2.label, 'Plan');
ev('SubagentStop', { agent_id: 'A1' });
ev('SubagentStop', { agent_id: 'A2' });
assert.deepEqual([chars.desk1.status, chars.desk1.busy, chars.desk1.label], ['sleeping', false, 'Explore'], 'back to sleep, keeps its role');
ev('SubagentStart', { agent_id: 'A3', agent_type: 'Plan' });
assert.equal(s.who.A3, 'desk2', 'the same kind of agent gets its old desk back');
assert.equal(chars.desk2.jobs, 2);

ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
assert.equal(chars.boss.status, 'waiting');
ev('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
assert.equal(chars.boss.status, 'sleeping');

Office.reduce(s, { session_id: 'S2', hook_event_name: 'SessionStart', source: 'clear' });
Office.reduce(s, { session_id: 'S2', hook_event_name: 'UserPromptSubmit' });
assert.equal(chars.boss.status, 'thinking', '/clear keeps the same boss');

Office.reduce(s, { session_id: 'T1', hook_event_name: 'SessionStart', source: 'startup' });
assert.equal(chars[s.who.T1].label, 'teammate', 'another session wakes a staff member as a teammate');

// 2 desks are busy (A3, T1), so 6 more fill the office and the 7th is a temp
for (let i = 0; i < 7; i++) ev('SubagentStart', { agent_id: 'X' + i, agent_type: 'general-purpose' });
assert.equal(chars[s.who.X5].kind, 'staff');
const temp = chars[s.who.X6];
assert.equal(temp.kind, 'temp', 'office full: extra agent is a standing temp');
ev('SubagentStop', { agent_id: 'X6' });
assert.equal(chars[temp.id], undefined, 'temp leaves when done');

ev('SubagentStop', { agent_id: 'ZZ' });
assert.equal(s.who.ZZ, undefined, 'stop for an unknown agent changes nothing');

// --- reactions (event shapes from a real claude 2.1.325 capture) ---
const at = (name, extra, now) => Office.reduce(s, { session_id: 'S2', hook_event_name: name, ...extra }, now);
const boss = chars.boss;

at('PermissionRequest', { tool_name: 'Write', tool_input: {} }, 2000);
assert.equal(boss.status, 'waiting');

for (let i = 0; i < 3; i++) at('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'exit 3' }, error: 'Exit code 3', is_interrupt: false }, 3000);
assert.deepEqual([boss.failStreak, boss.oopsAt, boss.say.text], [3, 3000, 'OOPS'], 'three failures: sweat + smoking monitor');
at('PostToolUse', { tool_name: 'Read', tool_input: {} }, 3100);
assert.equal(boss.failStreak, 0, 'a success clears the streak');
at('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'x' }, is_interrupt: true }, 3200);
assert.equal(boss.failStreak, 0, 'Esc is not the agent failing');
at('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm --prefix C:/x test' }, error: 'Exit code 1' }, 3300);
assert.deepEqual([boss.say.text, boss.say.ink], ['FAIL', '#e64553']);

s.effects = [];
at('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm --prefix C:/x test' } }, 4000);
at('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }, 4000);
assert.deepEqual(s.effects.map(f => f.type), ['clap', 'confetti']);
assert.equal(boss.say.text, 'COMMIT!');

const reportsBefore = s.reports;
ev('SubagentStart', { agent_id: 'R1', agent_type: 'Explore' });
const r1 = chars[s.who.R1];
Office.reduce(s, { session_id: 'S1', hook_event_name: 'SubagentStop', agent_id: 'R1', last_assistant_message: '## Result\n\n**There is 1 file** matching *.json in the working directory.' }, 5000);
assert.equal(r1.lastReport, 'There is 1 file matching *.json in the …', 'first line for the card, cut at 40');
assert.deepEqual([boss.say.icon, boss.say.from, s.reports - reportsBefore], ['doc', 6200, 1], 'boss reads it after the paper lands');
assert.ok(s.effects.some(f => f.type === 'paper'));

at('PreCompact', { trigger: 'auto' }, 7000);
assert.equal(s.cleaning, 7000);
at('PostCompact', { trigger: 'auto' }, 8000);
assert.deepEqual([s.cleaning, s.reports], [0, 0], 'compaction files the report pile away');

at('StopFailure', { error: 'rate_limit' }, 9000);
assert.equal(s.lights.reason, 'rate_limit');
at('UserPromptSubmit', {}, 9100);
assert.equal(s.lights, null, 'power is back on the next prompt');

Office.setModel(s, 'Opus');
assert.equal(boss.model, 'opus');
at('PostModelSwitch', { from_model: 'claude-opus-5-5', to_model: 'claude-haiku-5-5' }, 9200);
assert.equal(boss.model, 'haiku');

// --- async hooks: events can arrive out of order ---
at('PostToolUse', { tool_name: 'Glob', tool_use_id: 'T1' }, 9300);
at('PreToolUse', { tool_name: 'Glob', tool_use_id: 'T1' }, 9301);
assert.deepEqual([boss.status, boss.tool], ['thinking', null], 'a PreToolUse arriving after its PostToolUse does not restart the tool');

// background agent: Agent's PostToolUse names the launched subagent, even if SubagentStart arrives first or calls interleave
at('PreToolUse', { tool_name: 'Agent', tool_use_id: 'G1', tool_input: { description: 'first job' } }, 9400);
at('PreToolUse', { tool_name: 'Agent', tool_use_id: 'G2', tool_input: { description: 'second job' } }, 9400);
at('PostToolUse', { tool_name: 'Agent', tool_use_id: 'G2', tool_input: { description: 'second job' }, tool_response: { agentId: 'B2' } }, 9401);
Office.reduce(s, { session_id: 'S2', hook_event_name: 'SubagentStart', agent_id: 'B2', agent_type: 'Explore' }, 9402);
assert.equal(chars[s.who.B2].task, 'second job', 'matched by agentId, not by call order');
Office.reduce(s, { session_id: 'S2', hook_event_name: 'SubagentStart', agent_id: 'B1', agent_type: 'Explore' }, 9403);
assert.equal(chars[s.who.B1].task, 'first job');

// interactive claude: subagents report through the SubagentHandback tool, and SubagentStop has no last_assistant_message
const sub = (name, agent_id, extra = {}, now = 9600) => Office.reduce(s, { session_id: 'S2', hook_event_name: name, agent_id, agent_type: 'Explore', ...extra }, now);
sub('SubagentStart', 'H1');
const h1 = chars[s.who.H1];
sub('PreToolUse', 'H1', { tool_name: 'SubagentHandback', tool_use_id: 'HB1', tool_input: { message: '*.md 패턴으로 777개의 파일이 찾아졌습니다.' } });
assert.equal(h1.tool, '보고서');
sub('SubagentStop', 'H1');
assert.equal(h1.lastReport, '*.md 패턴으로 777개의 파일이 찾아졌습니다.', 'report comes from the handback, glob kept');
assert.equal(boss.say.icon, 'doc');

// async: the report can land after SubagentStop, and stray late events must not wake anyone
sub('SubagentStart', 'H2');
const h2 = chars[s.who.H2];
sub('SubagentStop', 'H2', {}, 9700);
assert.equal(h2.lastReport, '완료');
const busyBefore = Object.values(chars).filter(c => c.busy).length;
sub('PostToolUse', 'H2', { tool_name: 'Glob', tool_use_id: 'L1' }, 9701);
assert.equal(Object.values(chars).filter(c => c.busy).length, busyBefore, 'a late event from a finished subagent wakes nobody');
sub('PostToolUse', 'H2', { tool_name: 'SubagentHandback', tool_use_id: 'HB2', tool_input: { message: '## 결과\n테스트 3개 추가함' } }, 9702);
if (h2.kind !== 'temp') assert.equal(h2.lastReport, '테스트 3개 추가함', 'a late report still reaches the card');

// the server adds the model it read from the transcript; only the boss's events change the outfit
Office.reduce(s, { session_id: 'S2', hook_event_name: 'Stop', model: 'claude-opus-5-5' }, 9500);
assert.equal(boss.model, 'opus');
Office.reduce(s, { session_id: 'S2', hook_event_name: 'PreToolUse', agent_id: 'B1', tool_name: 'Read', model: 'claude-haiku-5-5' }, 9501);
assert.equal(boss.model, 'opus', "a subagent's model is not the boss's");

// default view is 1:1, so office pixels == CSS pixels: the design's boss desk is at (73,37) 46 wide, desk 1 at (7,77)
assert.equal(Office.hit(s, 96, 45).id, 'boss');
assert.equal(Office.hit(s, 20, 80).id, 'desk1');
assert.equal(Office.hit(s, 100, 66), null);

// nameplates hold 7 letters of the 3x5 pixel font: the agent type's first word
assert.deepEqual(['general-purpose', 'Explore', 'code-reviewer', 'teammate', 'statusline-setup'].map(Office.plateText), ['GENERAL', 'EXPLORE', 'CODE', 'TEAM', 'STATUSL']);
// everything said in a bubble must be in the pixel font (no Hangul)
for (const c of Object.values(chars)) if (c.say?.text) assert.match(c.say.text, /^[A-Z0-9!?.\-: /]*$/, `${c.id} says ${c.say.text}`);

// --- the building: a floor per claude session ---
{
  const b = Office.createBuilding();
  const go = (session_id, hook_event_name, extra = {}, now = 1000) => Office.route(b, { session_id, hook_event_name, project: 'readme', ...extra }, now);
  const one = go('A', 'SessionStart', { source: 'startup' });
  const two = go('B', 'SessionStart', { source: 'startup', project: 'blog' });
  assert.deepEqual([one.n, one.project, two.n, two.project], [1, 'readme', 2, 'blog'], 'two sessions, two floors');
  go('B', 'SubagentStart', { agent_id: 'b1', agent_type: 'Explore', project: 'blog' });
  assert.equal(two.state.chars.desk1.label, 'Explore', "a subagent works on its session's floor");
  assert.equal(one.state.chars.desk1.busy, false);

  // /clear: the same terminal goes on with a new session id, even if the SessionStart comes first (async hooks)
  go('A', 'UserPromptSubmit');
  go('A2', 'SessionStart', { source: 'clear' }, 1100);
  go('A', 'SessionEnd', { reason: 'clear' }, 1101);
  assert.equal(go('A2', 'UserPromptSubmit', {}, 1102), one, '/clear stays on the same floor');
  assert.equal(one.state.chars.boss.status, 'thinking', 'and the new session is still the boss');
  assert.equal(go('A', 'Stop', {}, 1103), null, 'stragglers from an ended session are dropped');
  assert.equal(b.alias.A, one.id, 'the id from before /clear still names the floor (the app knows its terminal by it)');

  // the app closes that terminal and says so under the id it knows: the floor closes, then reopens for the next claude
  {
    const b2 = Office.createBuilding();
    const g = (sid, ev, extra = {}, now = 1000) => Office.route(b2, { session_id: sid, hook_event_name: ev, project: 'x', ...extra }, now);
    const f = g('X', 'SessionStart', { source: 'startup' });
    g('Y', 'SessionStart', { source: 'clear' }, 1001);
    g('X', 'SessionEnd', { reason: 'clear' }, 1002);
    g('X', 'SessionEnd', { reason: 'other' }, 1003);
    assert.equal(Office.floorStatus(f).closed, true, 'a tab closed after /clear closes its floor');
  }

  // the restart bug: quit claude, start it again in the same folder -> the same floor, the new session is the boss
  go('A2', 'SessionEnd', { reason: 'prompt_input_exit' }, 2000);
  assert.deepEqual([Office.floorStatus(one).closed, one.state.lights.reason], [true, 'closed'], 'lights off when claude quits');
  const again = go('A3', 'SessionStart', { source: 'startup' }, 3000);
  go('A3', 'UserPromptSubmit', {}, 3001);
  assert.equal(again, one, 'a restart reopens the floor');
  assert.deepEqual([one.state.chars.boss.status, Object.values(one.state.chars).some(c => c.label === 'teammate')], ['thinking', false], 'the new session is the boss, not a TEAM desk');

  // a second session in the same folder while the first is open gets its own floor
  const three = go('C', 'SessionStart', { source: 'startup' }, 3100);
  assert.equal(three.n, 3);
  go('C', 'PermissionRequest', { tool_name: 'Write' }, 3200);
  assert.deepEqual(Office.floorStatus(three, 3300), { closed: false, waiting: true, working: true, stuck: false });

  // silent for hours = killed without SessionEnd; closed floors go away after 10 minutes
  Office.prune(b, 3200 + 3 * 3600e3);
  assert.equal(Office.floorStatus(two).closed, true);
  Office.prune(b, 3200 + 3 * 3600e3 + 11 * 60e3);
  assert.deepEqual(Object.keys(b.floors), [], 'closed floors are taken away');
}

// --- silent too long: a hung command, or claude closed mid-task ---
{
  const b = Office.createBuilding(), M = 60e3;
  const go = (hook_event_name, extra, now) => Office.route(b, { session_id: 'Q', project: 'p', hook_event_name, ...extra }, now);
  const f = go('UserPromptSubmit', {}, 0), { boss } = f.state.chars;
  go('PreToolUse', { tool_name: 'Bash', tool_use_id: 'q1', tool_input: { command: 'npm run dev' } }, 1000);
  assert.equal(Office.stuckFor(boss, 1000 + 4 * M), 0, '4 minutes is still fine');
  assert.equal(Office.stuckFor(boss, 1000 + 6 * M), 6 * M, 'a command silent for 6 minutes');
  assert.equal(Office.floorStatus(f, 1000 + 6 * M).stuck, true);
  go('PostToolUse', { tool_name: 'Bash', tool_use_id: 'q1' }, 2000);
  assert.equal(Office.stuckFor(boss, 2000 + 4 * M), 0, 'any event is a sign of life');

  go('PreToolUse', { tool_name: 'Agent', tool_use_id: 'q2', tool_input: { description: 'dig' } }, 3000);
  go('SubagentStart', { agent_id: 'qa', agent_type: 'Explore' }, 3000);
  const sub = f.state.chars[f.state.who.qa];
  assert.equal(Office.stuckFor(sub, 3000 + 6 * M), 0, 'thinking without a tool proves nothing (Esc sends no event)');
  go('PreToolUse', { agent_id: 'qa', tool_name: 'Bash', tool_use_id: 'q3', tool_input: { command: 'npm test' } }, 3000);
  assert.equal(Office.stuckFor(boss, 3000 + 10 * M), 0, 'the boss waiting on a subagent is not stuck');
  assert.equal(Office.stuckFor(sub, 3000 + 6 * M), 6 * M, "the subagent's silent command is");
  go('PermissionRequest', { agent_id: 'qa', tool_name: 'Bash' }, 4000);
  assert.equal(Office.stuckFor(sub, 4000 + 60 * M), 0, 'waiting for you is not stuck');
  go('SubagentStop', { agent_id: 'qa' }, 5000);
  go('PostToolUse', { tool_name: 'Agent', tool_use_id: 'q2' }, 5000);
  go('Stop', {}, 5001);
  assert.equal(Office.floorStatus(f, 5001 + 60 * M).stuck, false, 'asleep is not stuck');
  go('UserPromptSubmit', {}, 6000);
  go('SessionEnd', { reason: 'other' }, 6001);
  assert.equal(Office.floorStatus(f, 6001 + 60 * M).stuck, false, 'a closed floor is not stuck');
}

// --- answering a permission prompt from the office (the server adds _perm while it holds the hook) ---
{
  const b = Office.createBuilding();
  const go = (hook_event_name, extra = {}) => Office.route(b, { session_id: 'W', project: 'p', hook_event_name, ...extra }, 1000);
  const f = go('UserPromptSubmit'), { boss } = f.state.chars;
  go('PreToolUse', { tool_name: 'Bash', tool_use_id: 'w1' });
  go('PermissionRequest', { tool_name: 'Bash', ask: 'npm i', _perm: 'K1' });
  assert.deepEqual([boss.status, boss.perm], ['waiting', { id: 'K1', tool: 'Bash', ask: 'npm i' }]);
  go('PermissionDone', { _perm: 'OTHER', behavior: 'allow' });
  assert.equal(boss.perm.id, 'K1', "another question's answer changes nothing");
  go('PermissionDone', { _perm: 'K1', behavior: 'allow' });
  assert.deepEqual([boss.status, boss.perm], ['running', null], 'allowed: the command runs');
  go('PermissionRequest', { tool_name: 'Bash', ask: 'rm x' });
  assert.equal(boss.perm, null, 'no _perm: the office has no way to answer it');
  assert.equal(go('PermissionDone', { session_id: 'NEW', _perm: 'K9', behavior: 'gone' }), null, 'an answer for an unknown session opens no floor');
  go('PermissionDone', { agent_id: 'ghost', _perm: 'K9', behavior: 'gone' });
  assert.equal(Object.values(f.state.chars).filter(c => c.busy).length, 0, 'and wakes nobody');
}

// --- claude's to-do list, files edited, context (tool shapes from real claude 2.1 transcripts) ---
{
  const b = Office.createBuilding();
  const go = (hook_event_name, extra = {}) => Office.route(b, { session_id: 'T', project: 'p', hook_event_name, ...extra }, 1000);
  const s = go('UserPromptSubmit').state;
  go('PostToolUse', { tool_name: 'TaskCreate', tool_use_id: 't1', tool_input: { subject: 'Write tests', activeForm: 'Writing tests' }, tool_response: { task: { id: '1', subject: 'Write tests' } } });
  go('PostToolUse', { tool_name: 'TaskCreate', tool_use_id: 't2', tool_input: { subject: 'Ship it' }, tool_response: { task: { id: '2', subject: 'Ship it' } } });
  go('PostToolUse', { tool_name: 'TaskUpdate', tool_use_id: 't3', tool_input: { taskId: '1', status: 'in_progress' } });
  assert.deepEqual(Object.values(s.tasks).map(t => [t.subject, t.status, t.active]), [['Write tests', 'in_progress', 'Writing tests'], ['Ship it', 'pending', '']]);
  go('PostToolUse', { tool_name: 'TaskUpdate', tool_use_id: 't4', tool_input: { taskId: '2', status: 'deleted' } });
  go('PostToolUse', { tool_name: 'TaskUpdate', tool_use_id: 't5', tool_input: { taskId: '9', status: 'completed' } });
  assert.deepEqual(Object.keys(s.tasks), ['1', '9'], 'a deleted task goes; one made before the office opened still counts');
  go('PostToolUse', { tool_name: 'TodoWrite', tool_use_id: 't6', tool_input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] } });
  assert.deepEqual(Object.values(s.tasks).map(t => `${t.subject}:${t.status}`), ['a:completed', 'b:pending'], 'TodoWrite sends the whole list');

  go('SubagentStart', { agent_id: 'e1', agent_type: 'Explore' });
  go('PostToolUse', { tool_name: 'Edit', tool_use_id: 'f1', file: 'src/app.js' });
  go('PostToolUse', { agent_id: 'e1', tool_name: 'Write', tool_use_id: 'f2', file: 'src/app.js' });
  go('PostToolUse', { tool_name: 'Edit', tool_use_id: 'f3', file: 'README.md' });
  assert.deepEqual(s.files['src/app.js'], { n: 2, by: ['Claude', 'Explore'], at: 1000 });

  go('Stop', { model: 'claude-haiku-4-5', context: 150000 });
  assert.deepEqual([s.context, s.modelId, Office.windowOf(s.modelId)], [150000, 'claude-haiku-4-5', 200000]);
  assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-4-5', 'claude-opus-4-6', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'claude-fable-5-2', undefined].map(Office.windowOf),
    [1e6, 2e5, 1e6, 2e5, 2e5, 1e6, 1e6], 'context windows: current models 1M, the 4.5 generation and older 200K');
  go('SessionStart', { session_id: 'T2', source: 'clear' });
  assert.deepEqual([Object.keys(s.tasks).length, Object.keys(s.files).length], [0, 2], '/clear empties the to-do list; the files stay with the floor');
}

// --- agent teams (event order from a real claude 2.1.326 run): a teammate is a subagent of the lead's session, reports
// with SendMessage, and after its SubagentStop can be given more work, which starts with SubagentStart again ---
{
  const b = Office.createBuilding();
  const go = (hook_event_name, extra = {}, now = 1000) => Office.route(b, { session_id: 'L', project: 'p', hook_event_name, ...extra }, now);
  const s = go('UserPromptSubmit').state;
  const helper = { agent_id: 'h1', agent_type: 'helper' };
  go('PreToolUse', { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: 'Run echo and report' } });
  go('SubagentStart', helper);
  go('PostToolUse', { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: 'Run echo and report' } });
  go('PostToolUse', { ...helper, tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'echo first-job' } });
  go('PreToolUse', { ...helper, tool_name: 'SendMessage', tool_use_id: 'm1', tool_input: { to: 'team-lead', message: 'first-job' } });
  go('SubagentStop', { ...helper, last_assistant_message: 'echo printed first-job. I sent it to the lead.' }, 2000);
  const h = s.chars[s.gone.get('h1')];
  assert.deepEqual([h.lastReport, s.inbox[0].text, s.inbox[0].task], ['first-job', 'first-job', 'Run echo and report'], "the teammate's message is its report");

  go('PreToolUse', { tool_name: 'SendMessage', tool_use_id: 'm2', tool_input: { to: 'helper', message: 'Run `echo second-job` and report back.' } }, 3000);
  go('SubagentStart', helper, 3001);
  assert.deepEqual([s.who.h1, h.busy, h.jobs, h.task], [h.id, true, 2, 'Run `echo second-job` and report back.'], 'given more work, the same teammate wakes at its desk with the new task');
  go('PostToolUse', { ...helper, tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'echo second-job' } }, 3002);
  go('PostToolUse', { ...helper, tool_name: 'SendMessage', tool_use_id: 'm3', tool_input: { to: 'team-lead', message: 'second-job' } }, 3003);
  go('SubagentStop', helper, 3004);
  go('PostToolUse', { ...helper, tool_name: 'Read', tool_use_id: 'late' }, 3005);
  assert.deepEqual([s.inbox.length, s.inbox[0].text, h.busy], [2, 'second-job', false], 'two reports, newest first; a straggler after the stop wakes no one');

  const log = s.journal.map(j => `${j.who}: ${j.text}`);
  for (const line of ['Claude: 새 지시를 받음', 'helper: 일 시작: Run echo and report', 'helper: Bash echo first-job', 'helper: 보고: first-job', 'helper: 메시지 → team-lead: second-job']) {
    assert.ok(log.includes(line), `work log has "${line}": ${log.join(' / ')}`);
  }
  assert.deepEqual(s.journal.map(j => j.at), s.journal.map(j => j.at).slice().sort((x, y) => x - y), 'the log is in time order');
}

// --- the staff list: the agents a session has defined (.claude/agents, read by the server) ---
{
  const b = Office.createBuilding();
  const go = (hook_event_name, extra = {}, now = 1000) => Office.route(b, { session_id: 'R', project: 'p', hook_event_name, ...extra }, now);
  const defined = n => Array.from({ length: n }, (_, i) => ({ name: 'agent' + (i + 1), description: 'does ' + (i + 1) }));
  const s = go('SessionStart', { source: 'startup', agents: defined(10) }).state, { chars } = s;
  assert.deepEqual([chars.desk1.label, chars.desk8.label, chars.desk1.status, chars.desk1.busy], ['agent1', 'agent8', 'sleeping', false], 'named at their desks before any work; 8 desks, so 8 of the 10');
  assert.equal(s.roster.length, 10, 'all ten are on the list');
  go('SubagentStart', { agent_id: 'r3', agent_type: 'agent3' }, 2000);
  assert.equal(s.who.r3, 'desk3', 'work goes to its own desk');
  go('SubagentStop', { agent_id: 'r3', last_assistant_message: 'three done' }, 2500);
  go('SubagentStart', { agent_id: 'r9', agent_type: 'agent9' }, 3000);
  assert.deepEqual([s.who.r9, chars.desk1.label, chars.desk1.jobs, chars.desk1.lastReport], ['desk1', 'agent9', 1, ''], 'no desk of its own: it takes one whose name never worked');
  go('SubagentStart', { agent_id: 'rx', agent_type: 'Explore' }, 3100);
  assert.deepEqual([s.who.rx, chars.desk3.label, chars.desk3.lastReport], ['desk2', 'agent3', 'three done'], 'the desk that just worked is the last to be given away');
  go('UserPromptSubmit', { agents: defined(10) }, 4000); // the list comes again with every prompt
  assert.equal(Object.values(chars).filter(c => c.label === 'agent4').length, 1, 'nobody is seated twice');

  const few = Office.createState();
  Office.reduce(few, { session_id: 'S', hook_event_name: 'SessionStart', agents: defined(3) }, 1);
  Office.reduce(few, { session_id: 'S', hook_event_name: 'SubagentStart', agent_id: 'e', agent_type: 'Explore' }, 2);
  assert.equal(few.who.e, 'desk4', 'an agent with no file takes an unnamed desk, not a named one');

  // more at work than desks: temps stand in, and a standing place someone left is used again (counting on, they
  // would walk off the screen)
  const full = Office.createState(), sub = (ev, id) => Office.reduce(full, { session_id: 'S', hook_event_name: ev, agent_id: id, agent_type: 'general-purpose' }, 1);
  for (let i = 0; i < 10; i++) sub('SubagentStart', 'g' + i);
  assert.deepEqual([full.chars[full.who.g8].n, full.chars[full.who.g9].n], [0, 1]);
  sub('SubagentStop', 'g8');
  sub('SubagentStart', 'g10');
  assert.equal(full.chars[full.who.g10].n, 0);
  // six temps stand in the room (three to a place); the rest wait outside as a "+N" on the door and can't be clicked
  for (let i = 11; i < 18; i++) sub('SubagentStart', 'g' + i);
  assert.deepEqual([Office.hit(full, 150, 40)?.n, Office.hit(full, 121, 40)], [0, null], 'the first temp is there to click; where a seventh would stand, nobody is');
}

// the same log in English: every word the reducer writes
{
  Office.setLang('en');
  const s = Office.createState(), go = (name, extra = {}) => Office.reduce(s, { session_id: 'S1', hook_event_name: name, ...extra }, 1);
  go('SessionStart', { source: 'compact' });
  go('UserPromptSubmit');
  go('PreToolUse', { tool_name: 'Agent', tool_use_id: 'a', tool_input: { description: 'look around' } });
  go('SubagentStart', { agent_id: 'A', agent_type: 'Explore' });
  go('PreToolUse', { agent_id: 'A', tool_name: 'SubagentHandback', tool_use_id: 'h' });
  assert.equal(s.chars.desk1.tool, 'report');
  go('SubagentStop', { agent_id: 'A' });
  assert.equal(s.chars.desk1.lastReport, 'Done');
  go('PermissionRequest', { tool_name: 'Bash', ask: 'npm i', _perm: 'p1' });
  go('PermissionDone', { _perm: 'p1', behavior: 'deny' });
  go('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '2' } });
  go('PostToolUseFailure', { tool_name: 'Bash', error: 'exit 1' });
  go('StopFailure');
  const text = s.journal.map(j => j.text).join(' / ');
  assert.equal(text, 'Continuing after compaction / New instruction / Started: look around / Report: Done / Approval needed: Bash npm i / Denied from the office / To-do #2: edited / Bash failed: exit 1 / Stopped: error');
  assert.ok(!/[가-힣]/.test(text), 'no Korean in the English log');
}

{ // looks picked by right-click: per desk (and the boss), temps keep theirs; the list color follows the look
  const s = Office.createState();
  const boss = Object.values(s.chars).find(c => c.kind === 'boss'), staff = Object.values(s.chars).find(c => c.kind === 'staff' && c.desk === 3);
  assert.equal(Office.lookKey(boss), 'boss');
  assert.equal(Office.lookKey(staff), `desk${staff.desk}`);
  assert.equal(Office.lookKey({ kind: 'temp', desk: -1 }), null);
  Office.useArt({ people: { rows: { boss: 0, staff: [1, 2] }, clothes: ['#000', '#111', '#222', '#333'] } }, null);
  assert.equal(Office.colorOf(staff), staff.color, 'no pick: its own color');
  Office.setLooks({ [Office.lookKey(staff)]: 3 });
  assert.equal(Office.colorOf(staff), '#333', 'picked: the look\'s clothes');
  assert.equal(Office.colorOf(boss), boss.color, 'the boss is untouched');
  Office.setLooks({});
  Office.useArt(null, null);
}

console.log('office reducer ok');
