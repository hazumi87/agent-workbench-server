/**
 * MCP indicator, engine module (ticket): src/engine/mcp-calls.ts and
 * src/engine/mcp-labels.ts, with an injected emitter + clock. Boots nothing.
 *
 *  - tool-name parsing (hyphens/underscores in the server, `__` in the tool,
 *    the identifier-only alphabet) and the sink's cheap non-MCP pre-filter;
 *  - the label map, claude_ai_ connectors and the Title Case fallback;
 *  - frames: start shape, ok / isError / failed / interrupted-by-interrupt /
 *    denied, ms from the start, orphan end dropped, duplicate start ignored;
 *  - caller: main thread vs sub-agent (agent_id + agent_type);
 *  - Stop ends MAIN-thread calls only; SubagentStop ends that agent's;
 *    endPane ends all; the 30 min sweep; the 64-per-pane cap;
 *  - inFlight: oldest first, at most 8;
 *  - privacy: no tool input / output / error / reason text in any frame or log
 *    line; a throwing emitter never escapes.
 * Run with tsx.
 */
import * as mcp from '../src/engine/mcp-calls.ts';
import { mcpLabel } from '../src/engine/mcp-labels.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, a === e ? msg : `${msg} (got ${a}, want ${e})`);
}

const frames: mcp.McpFrame[] = [];
const everything: mcp.McpFrame[] = []; // never drained: the privacy check reads it
const logs: string[] = [];
const collect = (f: mcp.McpFrame): void => {
  frames.push(f);
  everything.push(f);
};
mcp.setEmitter(collect);
mcp.setLog((l) => logs.push(l));
const take = (): mcp.McpFrame[] => frames.splice(0, frames.length);

const SECRET = 'SECRET-PAYLOAD-7f3a';
const pre = (id: string, tool = 'mcp__sample-docs__search', extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_use_id: id,
  tool_input: { query: SECRET },
  ...extra,
});
const post = (id: string, response: unknown, tool = 'mcp__sample-docs__search') => ({
  hook_event_name: 'PostToolUse',
  tool_name: tool,
  tool_use_id: id,
  tool_input: { query: SECRET },
  tool_response: response,
});

console.log('\n[parseToolName]');
eq(mcp.parseToolName('mcp__example-task-mcp__dispatch_task'), { server: 'example-task-mcp', verb: 'dispatch_task' }, 'hyphens in the server, underscore in the tool');
eq(mcp.parseToolName('mcp__claude_ai_Claude_Docs__batch'), { server: 'claude_ai_Claude_Docs', verb: 'batch' }, 'single underscores stay in the server');
eq(mcp.parseToolName('mcp__srv__get__all'), { server: 'srv', verb: 'get__all' }, 'split at the FIRST __: a `__` inside the tool stays in the verb');
eq(mcp.parseToolName('mcp__plugin_x_db__query'), { server: 'plugin_x_db', verb: 'query' }, 'a plugin-scoped server');
eq(mcp.parseToolName(`mcp__${'s'.repeat(48)}__${'v'.repeat(64)}`)?.server.length, 48, 'a 48-char server with a 64-char tool parses');
eq(mcp.parseToolName(`mcp__${'s'.repeat(49)}__x`), null, 'a 49-char server is not an MCP tool (review: bounded chip text)');
eq(mcp.parseToolName(`mcp__x__${'v'.repeat(65)}`), null, 'a 65-char tool is not an MCP tool');
eq(mcp.isIgnorableToolHook('PreToolUse', `mcp__${'s'.repeat(49)}__x`), true, 'so the sink answers it as non-MCP');
for (const bad of ['Bash', 'mcp__solo', 'mcp____x', 'mcp__srv__', 'mcp__srv name__x', 'mcp__srv__do it', 'mcp__a.b__c', `mcp__a__${'x'.repeat(260)}`, 42, null, undefined]) {
  eq(mcp.parseToolName(bad), null, `not an MCP tool name: ${JSON.stringify(bad)?.slice(0, 30)}`);
}

console.log('\n[isIgnorableToolHook: the sink answers these before reading the table]');
eq(mcp.isIgnorableToolHook('PreToolUse', 'Bash'), true, 'PreToolUse Bash -> ignorable');
eq(mcp.isIgnorableToolHook('PostToolUse', 'Edit'), true, 'PostToolUse Edit -> ignorable');
eq(mcp.isIgnorableToolHook('PostToolUseFailure', undefined), true, 'a tool event with no tool name -> ignorable');
eq(mcp.isIgnorableToolHook('PreToolUse', 'mcp__fabric__send'), false, 'an MCP tool is not');
eq(mcp.isIgnorableToolHook('Stop', undefined), false, 'Stop is not a tool event');
eq(mcp.isIgnorableToolHook('Notification', undefined), false, 'Notification is not a tool event');

console.log('\n[labels]');
const known: Array<[string, string]> = [
  ['fabric', 'Fabric'],
];
for (const [k, v] of known) {
  eq(mcpLabel(k), v, `${k} -> ${v}`);
}
eq(mcpLabel('claude_ai_Gmail'), 'Gmail', 'claude_ai_Gmail -> Gmail');
eq(mcpLabel('claude_ai_Claude_Docs'), 'Claude Docs', 'claude_ai_Claude_Docs -> Claude Docs');
eq(mcpLabel('claude_ai_Google_Calendar'), 'Google Calendar', 'claude_ai_Google_Calendar -> Google Calendar');
eq(mcpLabel('some-server_name'), 'some-server_name', 'fallback: an unknown key is shown RAW, not humanised');
eq(mcpLabel('Your_Claude_login_expired_run_claude_login'), 'Your_Claude_login_expired_run_claude_login', 'so a made-up key is not turned into a sentence');
eq(mcpLabel('constructor'), 'constructor', 'a prototype key is not a known server');
eq(mcpLabel('claude_ai_Google_Drive'), 'Google Drive', 'claude_ai_Google_Drive -> Google Drive');
eq(mcpLabel('claude_ai_Session_expired_-_run_claude_login'), 'claude_ai_Session_expired_-_run_claude_login', 'an UNKNOWN claude_ai_ key is shown raw, not humanised');
eq(mcpLabel('claude_ai_Notion'), 'claude_ai_Notion', 'a real but unlisted connector is raw too (it gets a name by being added to the map)');
eq(mcpLabel('claude_ai__'), 'claude_ai__', 'claude_ai__ is raw');

console.log('\n[start + ok end]');
const P1 = 'recipe:one';
mcp.onHook(P1, pre('t1'), 1000);
let f = take();
eq(f.length, 1, 'PreToolUse -> one frame');
eq(f[0], {
  type: 'pane.mcp',
  paneid: P1,
  id: 't1',
  phase: 'start',
  server: 'sample-docs',
  label: 'sample-docs',
  verb: 'search',
  caller: { kind: 'agent', name: 'agent' },
  ts: 1000,
}, 'the start frame, exactly (no expectEnd)');
mcp.onHook(P1, post('t1', { content: [{ type: 'text', text: SECRET }] }), 1450);
f = take();
eq(f[0], {
  type: 'pane.mcp',
  paneid: P1,
  id: 't1',
  phase: 'end',
  server: 'sample-docs',
  label: 'sample-docs',
  verb: 'search',
  caller: { kind: 'agent', name: 'agent' },
  result: 'ok',
  ms: 450,
  ts: 1450,
}, 'PostToolUse -> ok, ms from the start, no why');
eq(mcp.inFlight(P1), [], 'nothing left in flight');

console.log('\n[error shapes]');
mcp.onHook(P1, pre('t2'), 2000);
mcp.onHook(P1, post('t2', { isError: true, content: [{ type: 'text', text: SECRET }] }), 2100);
f = take();
eq([f[1].result, f[1].why, f[1].ms], ['error', 'isError', 100], 'PostToolUse with tool_response.isError true -> error/isError');
mcp.onHook(P1, pre('t2b'), 2000);
mcp.onHook(P1, post('t2b', [{ type: 'text', text: SECRET }]), 2010);
mcp.onHook(P1, pre('t2c'), 2000);
mcp.onHook(P1, post('t2c', SECRET), 2010);
f = take();
eq([f[1].result, f[3].result], ['ok', 'ok'], 'an array or string tool_response is ok (no isError to read)');
mcp.onHook(P1, pre('t3'), 3000);
mcp.onHook(P1, { hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__sample-docs__search', tool_use_id: 't3', error: SECRET, is_interrupt: false }, 3300);
f = take();
eq([f[1].result, f[1].why, f[1].ms], ['error', 'failed', 300], 'PostToolUseFailure -> error/failed');
mcp.onHook(P1, pre('t4'), 4000);
mcp.onHook(P1, { hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__sample-docs__search', tool_use_id: 't4', error: SECRET, is_interrupt: true }, 4200);
f = take();
eq([f[1].result, f[1].why], ['warn', 'interrupted'], 'PostToolUseFailure with is_interrupt -> warn/interrupted');
mcp.onHook(P1, pre('t5'), 5000);
mcp.onHook(P1, { hook_event_name: 'PermissionDenied', tool_name: 'mcp__sample-docs__search', tool_use_id: 't5', reason: SECRET }, 5050);
f = take();
eq([f[1].result, f[1].why], ['warn', 'denied'], 'PermissionDenied -> warn/denied');

console.log('\n[orphans, duplicates, non-MCP]');
mcp.onHook(P1, post('never-started', {}), 6000);
eq(take().length, 0, 'an end with no start is dropped');
mcp.onHook(P1, pre('dup'), 6000);
mcp.onHook(P1, pre('dup'), 6001);
eq(take().length, 1, 'a second PreToolUse for an open id is ignored');
mcp.onHook(P1, post('dup', {}), 6002);
take();
mcp.onHook(P1, pre('b1', 'Bash'), 6000);
mcp.onHook(P1, { hook_event_name: 'PreToolUse', tool_name: 'mcp__fabric__send' }, 6000);
mcp.onHook(P1, { hook_event_name: 'PreToolUse', tool_name: 'mcp__fabric__send', tool_use_id: 'x'.repeat(201) }, 6000);
mcp.onHook(P1, { hook_event_name: 'Notification' }, 6000);
eq(take().length, 0, 'non-MCP tool, missing/oversized tool_use_id and other events emit nothing');

console.log('\n[callers; Stop ends the main thread only; SubagentStop ends that agent]');
const P2 = 'recipe:two';
mcp.onHook(P2, pre('m1', 'mcp__fabric__send'), 7000);
mcp.onHook(P2, pre('s1', 'mcp__example-tools__run_command', { agent_id: 'agent-a', agent_type: 'Explore' }), 7001);
mcp.onHook(P2, pre('s2', 'mcp__sample-host__exec', { agent_id: 'agent-b', agent_type: 'has space' }), 7002);
f = take();
eq(f.map((x) => x.caller), [{ kind: 'agent', name: 'agent' }, { kind: 'sub', name: 'Explore' }, { kind: 'sub', name: 'subagent' }], 'main / sub Explore / sub with a non-identifier type -> subagent');
const P2b = 'recipe:two-b';
mcp.onHook(P2b, pre('n1', 'mcp__fabric__send', { agent_id: 'x', agent_type: 'login.server.example.ts.net' }), 7003);
mcp.onHook(P2b, pre('n2', 'mcp__fabric__send', { agent_id: 'x', agent_type: 'a'.repeat(33) }), 7003);
mcp.onHook(P2b, pre('n3', 'mcp__fabric__send', { agent_id: 'x', agent_type: 'my-plugin:reviewer' }), 7003);
eq(take().map((x) => x.caller.name), ['subagent', 'subagent', 'my-plugin:reviewer'], "agent type: a '.' (host name) or over 32 chars -> subagent; plugin:agent kept");
mcp.endPane(P2b, 7004);
take();
eq(f.map((x) => x.label), ['Fabric', 'example-tools', 'sample-host'], 'labels resolved engine-side');
mcp.onHook(P2, { hook_event_name: 'Stop', last_assistant_message: SECRET }, 8000);
f = take();
eq(f.map((x) => [x.id, x.result, x.why, x.ms]), [['m1', 'warn', 'interrupted', 1000]], 'Stop ends the main-thread call only');
eq(mcp.inFlight(P2).map((x) => x.id), ['s1', 's2'], "the sub-agents' calls stay open");
mcp.onHook(P2, { hook_event_name: 'SubagentStop', agent_id: 'agent-a', agent_type: 'Explore' }, 8100);
f = take();
eq(f.map((x) => [x.id, x.why]), [['s1', 'interrupted']], "SubagentStop ends that agent's call only");
mcp.onHook(P2, { hook_event_name: 'SubagentStop' }, 8100);
eq(take().length, 0, 'SubagentStop with no agent_id ends nothing');

console.log('\n[pane end, inFlight bound, cap, sweep]');
mcp.endPane(P2, 9000);
f = take();
eq(f.map((x) => [x.id, x.result, x.why]), [['s2', 'warn', 'interrupted']], 'endPane ends every open call');
eq(mcp.inFlight(P2), [], 'and forgets the pane');
const P3 = 'recipe:three';
for (let i = 0; i < 10; i++) {
  mcp.onHook(P3, pre(`r${i}`), 10000 + i);
}
take();
eq(mcp.inFlight(P3).map((x) => x.id), ['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'], 'inFlight: at most 8, oldest first (newest last)');
ok(mcp.inFlight(P3).every((x) => x.phase === 'start' && x.type === 'pane.mcp'), 'inFlight holds start frames');
mcp.endPane(P3, 11000);
take();
const P4 = 'recipe:four';
const perToken = 1000 / mcp.START_PER_S; // spaced at the refill rate: never over budget
for (let i = 0; i < mcp.MAX_IN_FLIGHT; i++) {
  mcp.onHook(P4, pre(`c${i}`), 12000 + i * perToken);
}
eq(take().length, mcp.MAX_IN_FLIGHT, `${mcp.MAX_IN_FLIGHT} starts at the refill rate are all admitted`);
let logsBefore = logs.length;
mcp.onHook(P4, pre('c-over'), 12000 + mcp.MAX_IN_FLIGHT * perToken);
eq(take().length, 0, `at ${mcp.MAX_IN_FLIGHT} in flight a NEW start is ignored: no frame, no eviction`);
eq(mcp.inFlight(P4)[0]?.id, 'c56', 'the real calls are untouched (newest 8 still c56..c63)');
mcp.onHook(P4, post('c-over', {}), 12000 + mcp.MAX_IN_FLIGHT * perToken + 10);
eq(take().length, 0, "the ignored start's end is dropped (no start)");
eq(logs.length - logsBefore, 1, 'the drop is logged once');
mcp.endPane(P4, 40000);
take();

console.log('\n[flood bound: a per-pane start bucket]');
const P6 = 'recipe:flood';
logsBefore = logs.length;
for (let i = 0; i < 1000; i++) {
  mcp.onHook(P6, pre(`fl${i}`), 50000);
  mcp.onHook(P6, post(`fl${i}`, {}), 50000);
}
f = take();
eq([f.filter((x) => x.phase === 'start').length, f.filter((x) => x.phase === 'end').length], [mcp.START_BURST, mcp.START_BURST], `1000 start+end pairs in one instant -> only the ${mcp.START_BURST}-start burst reaches a window`);
for (let i = 0; i < 20; i++) {
  mcp.onHook(P6, pre(`fl-b${i}`), 51000);
}
eq(take().length, mcp.START_PER_S, `1 s later: ${mcp.START_PER_S} more (the refill)`);
eq(logs.length - logsBefore, 1, 'every drop in that minute is ONE log line');
for (let i = 0; i < mcp.START_BURST + 8; i++) {
  mcp.onHook(P6, pre(`fl-c${i}`), 50000 + 61000);
}
eq(take().length, mcp.START_BURST, 'a minute on the bucket is full again');
ok(logs.length - logsBefore === 2 && logs[logs.length - 1].includes('dropped 984 start(s)'), `and the next drop logs ONE line with the count since the last (967 + 16 unlogged + this 1: "${logs[logs.length - 1]}")`);
ok(mcp.START_BURST >= 8 && mcp.START_PER_S >= 1, 'a real parallel burst fits the bucket');
mcp.endPane(P6, 111001);
take();
for (let i = 0; i < mcp.START_BURST; i++) {
  mcp.onHook(P6, pre(`fl-d${i}`), 111001);
}
eq(take().length, mcp.START_BURST, 'endPane frees the bucket: a relaunched pane gets a full burst');
mcp.endPane(P6, 111002);
take();
const P7 = 'recipe:other';
mcp.onHook(P7, pre('o1'), 50000);
eq(take().length, 1, "a flood on one pane does not spend another pane's budget");
mcp.endPane(P7, 50001);
take();
const P5 = 'recipe:five';
mcp.onHook(P5, pre('old'), 20000);
mcp.onHook(P5, pre('young'), 20000 + mcp.STALE_MS - 1000);
take();
mcp.sweep(20000 + mcp.STALE_MS + 1);
f = take();
eq(f.map((x) => [x.id, x.why, x.ms]), [['old', 'interrupted', mcp.STALE_MS + 1]], 'the sweep ends only a call open longer than 30 min');
mcp.endPane(P5, 99999999);
take();

console.log('\n[Esc delivers no end: idle_prompt, StopFailure, SessionEnd]');
const PE = 'recipe:esc';
const E1 = 'sess-esc';
const OTHER = 'sess-other';
const withSid = (body: Record<string, unknown>, sid = E1) => ({ ...body, session_id: sid });
mcp.onHook(PE, withSid(pre('e-main', 'mcp__sample-host__exec')), 70000);
mcp.onHook(PE, withSid(pre('e-sub', 'mcp__fabric__send', { agent_id: 'ag-1', agent_type: 'Explore' })), 70001);
take();
for (const t of ['permission_prompt', 'elicitation_dialog', 'agent_needs_input', undefined]) {
  mcp.onHook(PE, withSid({ hook_event_name: 'Notification', notification_type: t, message: SECRET }), 70100);
}
eq(take().length, 0, 'a Notification other than idle_prompt ends nothing (a call may be waiting on a prompt)');
mcp.onHook(PE, withSid({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), 130000);
f = take();
eq(f.map((x) => [x.id, x.result, x.why, x.ms]), [['e-main', 'warn', 'interrupted', 60000]], "Notification idle_prompt ends the main thread's call (the Esc'd one)...");
eq(mcp.inFlight(PE).map((x) => x.id), ['e-sub'], '...and leaves the background sub-agent running');
mcp.onHook(PE, withSid(pre('e-main2', 'mcp__sample-host__exec')), 140000);
take();
mcp.onHook(PE, withSid({ hook_event_name: 'StopFailure', agent_id: 'ag-1', error: SECRET }), 140200);
f = take();
eq(f.map((x) => [x.id, x.why]), [['e-sub', 'interrupted']], "a SUB-AGENT's StopFailure (agent_id) ends only that agent's call...");
eq(mcp.inFlight(PE).map((x) => x.id), ['e-main2'], "...never the main thread's running call");
mcp.onHook(PE, withSid({ hook_event_name: 'StopFailure', error: SECRET, last_assistant_message: SECRET }), 140500);
f = take();
eq(f.map((x) => [x.id, x.why]), [['e-main2', 'interrupted']], 'a StopFailure with no agent_id ends main-thread calls like Stop');
mcp.onHook(PE, withSid(pre('e-main3', 'mcp__sample-host__exec')), 141000);
mcp.onHook(PE, withSid(pre('e-bg', 'mcp__fabric__send', { agent_id: 'bg-1', agent_type: 'general-purpose' })), 141000);
mcp.onHook(PE, withSid(pre('e-other', 'mcp__fabric__send'), OTHER), 141000);
take();
mcp.onHook(PE, withSid({ hook_event_name: 'SessionEnd', reason: 'clear' }), 142000);
f = take();
eq(f.map((x) => [x.id, x.why]), [['e-main3', 'interrupted']], "SessionEnd ends the session's MAIN-thread calls only...");
eq(mcp.inFlight(PE).map((x) => x.id), ['e-bg', 'e-other'], "...a background agent (kept running by /clear) and another session's call stay");
const PE2 = 'recipe:esc-other-pane';
mcp.onHook(PE2, withSid({ hook_event_name: 'SubagentStop', agent_id: 'bg-1' }, 'sess-after-clear'), 143000);
f = take();
eq(f.map((x) => [x.paneid, x.id, x.why]), [[PE, 'e-bg', 'interrupted']], "SubagentStop matches by agent_id on ANY pane, whatever (new) session id it carries");
mcp.onHook(PE, withSid(post('e-other', {}, 'mcp__fabric__send'), 'sess-after-clear'), 143100);
eq(take().map((x) => [x.id, x.result]), [['e-other', 'ok']], 'a PostToolUse ends by tool_use_id whatever session id it carries');
mcp.endPane(PE, 143500);
take();

console.log('\n[two live rows bank one session id: an end finds its start, not the matched row]');
const RA = 'recipe:row-a';
const RB = 'recipe:row-b';
const X = 'sess-x';
const Z = 'sess-z';
mcp.onHook(RA, { ...pre('x1', 'mcp__fabric__send'), session_id: X }, 60000);
mcp.onHook(RA, { ...pre('x2', 'mcp__sample-host__exec'), session_id: X }, 60001);
mcp.onHook(RB, { ...pre('z1', 'mcp__fabric__send'), session_id: Z }, 60002);
take();
mcp.onHook(RB, { ...post('x1', {}, 'mcp__fabric__send'), session_id: X }, 60100);
f = take();
eq(f.map((x) => [x.paneid, x.id, x.phase, x.result]), [[RA, 'x1', 'end', 'ok']], "a PostToolUse the sink routed to row B ends x1 on pane A, where its start is");
mcp.onHook(RB, { hook_event_name: 'Stop', session_id: X }, 60200);
f = take();
eq(f.map((x) => [x.paneid, x.id, x.why]), [[RA, 'x2', 'interrupted']], "a Stop for session X routed to row B ends X's call on pane A...");
eq(mcp.inFlight(RB).map((x) => x.id), ['z1'], "...and not pane B's call from session Z");
mcp.onHook(RB, { ...pre('x1', 'mcp__fabric__send'), session_id: X }, 60300);
mcp.onHook(RA, { ...pre('z1', 'mcp__fabric__send'), session_id: X }, 60300);
eq(take().map((x) => x.id), ['x1'], 'an id already open on ANY pane is not started again');
mcp.endPane(RA, 60400);
eq(take().length, 0, "endPane(A) ends only A's calls (none left)");
eq(mcp.inFlight(RB).map((x) => x.id), ['z1', 'x1'], "B's calls survive A's end");
mcp.endPane(RB, 60500);
f = take();
eq(f.map((x) => [x.paneid, x.id]), [[RB, 'z1'], [RB, 'x1']], 'endPane(B) ends its own');
mcp.onHook(RA, { ...post('z1', {}, 'mcp__fabric__send'), session_id: Z }, 60600);
eq(take().length, 0, 'the index is clean after endPane: a late end for an ended call is dropped');

console.log('\n[privacy + a throwing emitter]');
const all = JSON.stringify(everything);
mcp.setEmitter(() => {
  throw new Error('socket gone');
});
let threw = false;
try {
  mcp.onHook('recipe:six', pre('z1'), 1);
  mcp.onHook('recipe:six', post('z1', { isError: true }), 2);
  mcp.endPane('recipe:six', 3);
} catch {
  threw = true;
}
ok(!threw, 'an emitter that throws never escapes onHook / endPane');
mcp.setEmitter(collect);
ok(everything.length > 40 && !all.includes(SECRET) && !JSON.stringify(logs).includes(SECRET), 'no tool input / output / error / reason / message text in frames or log lines');
ok(logs.length > 0 && logs.every((l) => /^mcp: /.test(l)), `log lines are counts + paneids (${logs.length}: e.g. "${logs[0]}")`);

console.log(`\nPASS ${passed} FAIL ${failed}`);
if (failed) {
  process.exit(1);
}
