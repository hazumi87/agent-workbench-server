/**
 * MODULE BUDGETS AND APPROVALS (src/server/modules/budget.ts and approval.ts; ported from workbench-app test/module-budget-approval.test.mjs).
 * Budgets, per the C3 table: per frame 8 in flight and 16 KiB a request; per module 20 a second (burst 40) and 256 KiB a second; per app 60 a
 * second (burst 120) and 1 MiB a second; over any of them the answer is `slow`. Approvals: minted when the person confirms a delete, 60 s, single
 * use, bound to window, module, gen, account, engine, room, verb and task; a replay, an expiry or any scope change is refused (and burns the
 * token). Pure.
 */
import { isDeepStrictEqual } from 'node:util';
import { createBudget, LIMITS, type BudgetTicket } from '../src/server/modules/budget.ts';
import { createApprovals } from '../src/server/modules/approval.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}

console.log('\n[the numbers are the C3 table]');
same(LIMITS, {
  inflightPerFrame: 8, requestBytes: 16 * 1024,
  moduleRate: 20, moduleBurst: 40, moduleBytesPerSec: 256 * 1024,
  appRate: 60, appBurst: 120, appBytesPerSec: 1024 * 1024,
  replyBytes: 256 * 1024,
}, 'LIMITS');
ok(Object.isFrozen(LIMITS), 'LIMITS is frozen');

console.log('\n[a 40-request burst from one module is admitted; the 41st is slow; it refills at 20 a second]');
{
  let t = 0;
  const b = createBudget({ now: () => t });
  const tickets: BudgetTicket[] = [];
  let admitted = 0;
  for (let i = 0; i < 40; i++) {
    const r = b.take({ module: 'tasks', frame: 'f' + (i % 8) + '.' + i, bytes: 10 });
    if (r.ok) { admitted++; tickets.push(r); }
  }
  ok(admitted === 40, 'all 40 of the burst are admitted');
  same(b.take({ module: 'tasks', frame: 'fx', bytes: 10 }), { ok: false, kind: 'slow' }, 'the 41st is slow');
  for (const r of tickets) r.done();
  t += 1000;
  let n = 0;
  for (let i = 0; i < 30; i++) { const r = b.take({ module: 'tasks', frame: 'g' + i, bytes: 10 }); if (r.ok) { n++; r.done(); } }
  ok(n === 20, 'one second refills 20 (got ' + n + ')');
}

console.log('\n[a 1000-request flood from one frame: at most 8 in flight and at most the burst admitted]');
{
  const b = createBudget({ now: () => 0 });
  let admitted = 0;
  const held: BudgetTicket[] = [];
  for (let i = 0; i < 1000; i++) { const r = b.take({ module: 'tasks', frame: 'one', bytes: 10 }); if (r.ok) { admitted++; held.push(r); } }
  ok(admitted === 8, 'eight in flight, the rest slow (got ' + admitted + ')');
  for (const r of held) r.done();
  let more = 0;
  for (let i = 0; i < 1000; i++) { const r = b.take({ module: 'tasks', frame: 'one', bytes: 10 }); if (r.ok) { more++; r.done(); } }
  ok(more === 32, 'the rest of the 40 burst, then slow (got ' + more + ')');
}

console.log('\n[two modules each under their own rate but over the app burst together are capped]');
{
  const b = createBudget({ now: () => 0 });
  let n = 0;
  for (const m of ['a', 'b', 'c', 'd']) for (let i = 0; i < 40; i++) { const r = b.take({ module: m, frame: m + i, bytes: 1 }); if (r.ok) { n++; r.done(); } }
  ok(n === 120, 'the app burst is 120 (got ' + n + ')');
}

console.log('\n[bytes: a request over 16 KiB is refused; the module byte budget caps sustained traffic]');
{
  const b = createBudget({ now: () => 0 });
  same(b.take({ module: 'tasks', frame: 'f', bytes: 16 * 1024 + 1 }), { ok: false, kind: 'slow' }, 'over 16 KiB is slow');
  let sent = 0;
  for (let i = 0; i < 40; i++) { const r = b.take({ module: 'tasks', frame: 'f' + i, bytes: 16 * 1024 }); if (r.ok) { sent += 16 * 1024; r.done(); } }
  ok(sent === 256 * 1024, 'sixteen 16 KiB requests fill the second (got ' + sent + ')');
}

console.log('\n[a byte count that is not a finite non-negative number reads as too big]');
{
  const b = createBudget({ now: () => 0 });
  for (const bytes of [-1, NaN, Infinity, '5', null, undefined, {}]) ok(b.take({ module: 'tasks', frame: 'f', bytes }).ok === false, 'bytes ' + String(bytes));
  ok(b.take({ module: 'tasks', frame: 'f', bytes: 0 }).ok === true, 'zero bytes is fine');
}

console.log('\n[done() is idempotent and a refused take has nothing to release]');
{
  const b = createBudget({ now: () => 0 });
  const r = b.take({ module: 'tasks', frame: 'f', bytes: 1 });
  if (r.ok) { r.done(); r.done(); }
  let eight = true;
  for (let i = 0; i < 8; i++) if (!b.take({ module: 'tasks', frame: 'f', bytes: 1 }).ok) eight = false;
  ok(eight, 'eight more are admitted after a double done()');
  ok(b.take({ module: 'tasks', frame: 'f', bytes: 1 }).ok === false, 'the ninth in flight is slow');
}

console.log('\n[replyOk caps a reply at 256 KiB]');
{
  const b = createBudget({ now: () => 0 });
  ok(b.replyOk(256 * 1024) === true, '256 KiB is fine');
  ok(b.replyOk(256 * 1024 + 1) === false, 'one byte over is not');
  ok(b.replyOk(-1) === false && b.replyOk(NaN) === false && b.replyOk('1') === false, 'a negative, NaN or non-number size is not');
}

console.log('\n[an approval is single use and bound to its whole scope]');
const scope = { window: 1, module: 'tasks', gen: 3, accountId: 'acc', selectionVersion: 2, engineEpoch: 5, room: 'r1', verb: 'purge', taskId: 9 };
{
  const a = createApprovals({ now: () => 0 });
  const tok = a.mint(scope);
  ok(typeof tok === 'string' && /^[0-9a-f]{32}$/.test(tok), 'a 32-character hex token');
  ok(a.take(tok, { ...scope }) === true, 'taken once for its scope');
  ok(a.take(tok, { ...scope }) === false, 'a replay is refused');
}

console.log('\n[any scope change refuses and burns the token]');
{
  const a = createApprovals({ now: () => 0 });
  for (const [k, v] of Object.entries({ window: 2, module: 'usage', gen: 4, accountId: 'other', selectionVersion: 3, engineEpoch: 6, room: 'r2', verb: 'unflag', taskId: 10 })) {
    const tok = a.mint(scope);
    ok(a.take(tok, { ...scope, [k]: v }) === false, k + ' changed: refused');
    ok(a.take(tok, scope) === false, k + ': burned after the mismatch');
  }
}

console.log('\n[an approval expires after 60 s; unknown and malformed tokens are refused]');
{
  let t = 0;
  const a = createApprovals({ now: () => t });
  const tok = a.mint(scope);
  t += 60001;
  ok(a.take(tok, scope) === false, 'expired at 60.001 s');
  ok(a.take('0'.repeat(32), scope) === false, 'an unknown token');
  ok(a.take(null, scope) === false, 'null');
  ok(a.take({}, scope) === false, 'an object');
  const tok2 = a.mint(scope);
  t += 60000;
  ok(a.take(tok2, scope) === true, 'exactly 60 s is still good');
  const tok3 = a.mint(scope);
  ok(a.take(tok3, null) === false, 'no scope to match');
}

console.log('\n[mint refuses a scope with missing or malformed fields; at most 16 open per window, oldest dropped]');
{
  const a = createApprovals({ now: () => 0 });
  ok(a.mint({ ...scope, taskId: undefined }) === null, 'a missing taskId');
  ok(a.mint({ ...scope, room: 7 }) === null, 'a room that is not text');
  ok(a.mint({ ...scope, room: '' }) === null && a.mint({ ...scope, module: 'x'.repeat(129) }) === null, 'an empty or over-long text');
  ok(a.mint({ ...scope, gen: -1 }) === null && a.mint({ ...scope, window: 1.5 }) === null, 'a negative or fractional int');
  ok(a.mint({ ...scope, accountId: null }) !== null, 'accountId may be null');
  ok(a.mint(null) === null && a.mint(undefined) === null, 'no scope');
  const toks: Array<string | null> = [];
  for (let i = 0; i < 20; i++) toks.push(a.mint({ ...scope, taskId: i + 1 }));
  ok(a.take(toks[0], { ...scope, taskId: 1 }) === false, 'the oldest is dropped');
  ok(a.take(toks[19], { ...scope, taskId: 20 }) === true, 'the newest stands');
  const other = a.mint({ ...scope, window: 2 });
  ok(a.take(other, { ...scope, window: 2 }) === true, 'another window has its own 16');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
