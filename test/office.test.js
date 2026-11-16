// Checks the hook-event -> office-state logic. Event shapes match a real claude 2.1 hook capture.
const assert = require('node:assert');
const Office = require('../public/office.js');

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
assert.deepEqual([boss.failStreak, boss.oopsAt, boss.say.text], [3, 3000, '앗!'], 'three failures: sweat + smoking monitor');
at('PostToolUse', { tool_name: 'Read', tool_input: {} }, 3100);
assert.equal(boss.failStreak, 0, 'a success clears the streak');
at('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'x' }, is_interrupt: true }, 3200);
assert.equal(boss.failStreak, 0, 'Esc is not the agent failing');
at('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm --prefix C:/x test' }, error: 'Exit code 1' }, 3300);
assert.equal(boss.say.text, '테스트 실패… 휴');

s.effects = [];
at('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm --prefix C:/x test' } }, 4000);
at('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } }, 4000);
assert.deepEqual(s.effects.map(f => f.type), ['clap', 'confetti']);

const reportsBefore = s.reports;
ev('SubagentStart', { agent_id: 'R1', agent_type: 'Explore' });
const r1 = chars[s.who.R1];
Office.reduce(s, { session_id: 'S1', hook_event_name: 'SubagentStop', agent_id: 'R1', last_assistant_message: '## Result\n\n**There is 1 file** matching *.json in the working directory.' }, 5000);
assert.equal(r1.lastReport, 'There is 1 file matchin…');
assert.deepEqual([boss.say.text, boss.say.from, s.reports - reportsBefore], ['보고: There is 1 file matchin…', 6200, 1], 'boss reads it after the paper lands');
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
assert.match(h1.lastReport, /^\*\.md 패턴으로 777개의 파일이 .*…$/, 'report comes from the handback, glob kept, cut for the bubble');
assert.equal(boss.say.text, '보고: ' + h1.lastReport);

// async: the report can land after SubagentStop, and stray late events must not wake anyone
sub('SubagentStart', 'H2');
const h2 = chars[s.who.H2];
sub('SubagentStop', 'H2', {}, 9700);
assert.equal(boss.say.text, '보고: 완료');
const busyBefore = Object.values(chars).filter(c => c.busy).length;
sub('PostToolUse', 'H2', { tool_name: 'Glob', tool_use_id: 'L1' }, 9701);
assert.equal(Object.values(chars).filter(c => c.busy).length, busyBefore, 'a late event from a finished subagent wakes nobody');
sub('PostToolUse', 'H2', { tool_name: 'SubagentHandback', tool_use_id: 'HB2', tool_input: { message: '## 결과\n테스트 3개 추가함' } }, 9702);
assert.deepEqual(h2.kind === 'temp' ? [boss.say.text] : [h2.lastReport, boss.say.text], h2.kind === 'temp' ? ['보고: 완료'] : ['테스트 3개 추가함', '보고: 테스트 3개 추가함']);

// the server adds the model it read from the transcript; only the boss's events change the outfit
Office.reduce(s, { session_id: 'S2', hook_event_name: 'Stop', model: 'claude-opus-5-5' }, 9500);
assert.equal(boss.model, 'opus');
Office.reduce(s, { session_id: 'S2', hook_event_name: 'PreToolUse', agent_id: 'B1', tool_name: 'Read', model: 'claude-haiku-5-5' }, 9501);
assert.equal(boss.model, 'opus', "a subagent's model is not the boss's");

// default view is 1:1, so office pixels == CSS pixels: boss desk is at (84,40) 24 wide
assert.equal(Office.hit(s, 96, 45).id, 'boss');
assert.equal(Office.hit(s, 20, 80).id, 'desk1');
assert.equal(Office.hit(s, 100, 66), null);

console.log('office reducer ok');
