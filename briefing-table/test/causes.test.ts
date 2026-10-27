/**
 * LOCAL CAUSES FEED (GET /api/local/causes?since=<n>): a bounded in-memory ring of fixed-code events for the app's cause.log.
 * Codes only: a seat start (started | vendor-missing | memory | no-project | refused) and a seat exit (ended-by-person | reaped |
 * restart-cycle | exited | crashed). No text, no command line, no path.
 */
const { record, read, exitCodeOf, startRefusalCode, CAUSES_MAX, _reset } = await import('../src/engine/causes.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

console.log('\n[the ring]');
_reset();
let r = read(0);
ok(r.next === 0 && r.events.length === 0 && r.gap === false, 'empty: next 0, no events, no gap');
record({ kind: 'seat-start', code: 'started', handle: 'steward', room: 'r1' });
record({ kind: 'seat-exit', code: 'crashed', exit_code: 1, handle: 'steward', room: 'r1' });
r = read(0);
ok(r.events.length === 2 && r.events[0].n === 1 && r.events[1].n === 2 && r.next === 2, 'events are numbered from 1 and next is the last number');
ok(typeof r.events[0].ts === 'number', 'each carries a ts');
r = read(1);
ok(r.events.length === 1 && r.events[0].code === 'crashed' && r.next === 2 && !r.gap, 'since=n returns only newer events');
r = read(2);
ok(r.events.length === 0 && r.next === 2 && !r.gap, 'nothing new: empty, same next');

console.log('\n[bounded; overflow and restart are said, not hidden]');
_reset();
for (let i = 0; i < CAUSES_MAX + 50; i++) record({ kind: 'seat-start', code: 'started' });
r = read(0);
ok(r.events.length === CAUSES_MAX && r.events[0].n === 51 && r.next === CAUSES_MAX + 50, `only the last ${CAUSES_MAX} are kept`);
ok(r.gap === false, 'asking from 0 is asking for everything held: no gap');
r = read(30);
ok(r.gap === true && r.events.length === CAUSES_MAX && r.dropped === 20, 'a since older than the oldest kept says gap: true and dropped: how many events are gone (50 - 30)');
r = read(CAUSES_MAX + 49);
ok(r.gap === false && r.events.length === 1, 'a since inside the ring has no gap');
r = read(9999);
ok(r.gap === true && r.dropped === 0 && r.events.length === CAUSES_MAX && r.next === CAUSES_MAX + 50, 'a since AHEAD of the engine (it restarted) says gap: true and sends what it has');

console.log('\n[only fixed codes get in]');
_reset();
record({ kind: 'seat-start', code: 'C:\\Users\\x\\claude --session-id 123' as never });
record({ kind: 'seat-exit', code: 'whatever' as never });
record({ kind: 'nope' as never, code: 'started' as never });
r = read(0);
ok(r.events.length === 0, 'an unknown kind or code is dropped, never stored');
record({ kind: 'seat-start', code: 'vendor-missing', vendor: 'claude-code', handle: 'a b' });
record({ kind: 'seat-start', code: 'vendor-missing', vendor: 'C:\\evil' as never });
r = read(0);
ok(r.events.length === 2 && r.events[0].vendor === 'claude-code' && r.events[1].vendor === undefined, 'vendor is kept only when it is a known vendor');
ok(r.events[0].handle === undefined, 'a handle that is not a slug is dropped');

console.log('\n[mapping]');
ok(exitCodeOf('user', 0) === 'ended-by-person' && exitCodeOf('reaped', null) === 'reaped' && exitCodeOf('cycle', null) === 'restart-cycle', 'endReason maps to its code');
ok(exitCodeOf(undefined, 0) === 'exited' && exitCodeOf(undefined, 1) === 'crashed' && exitCodeOf(undefined, null) === 'crashed', 'no reason: zero exits, anything else crashed');
ok(startRefusalCode({ code: 'vendor-missing' }) === 'vendor-missing' && startRefusalCode({ field: 'memory' }) === 'memory', 'a refusal maps by its code or field');
ok(startRefusalCode({ field: 'seat' }) === 'refused' && startRefusalCode({}) === 'refused', 'anything else is refused');
ok(startRefusalCode({ field: 'recipe_id' }) === 'no-project', 'a seat with no project is no-project');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
