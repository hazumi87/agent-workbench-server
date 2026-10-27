/**
 * Project locks (the design notes): one advisory lock per project, in
 * memory, with a TTL. Pure: no db, no port, an explicit clock.
 */
import * as locks from '../src/engine/project-locks.ts';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}
function throwsField(fn: () => unknown, field: string, msg: string): void {
  try {
    fn();
    ok(false, `${msg} (did not throw)`);
  } catch (err) {
    ok(err instanceof locks.LockInputError && err.field === field, `${msg} (${(err as Error).message})`);
  }
}

const A: locks.LockHolder = { kind: 'pane', paneid: 'recipe:bt#1', slug: 'briefing-table' };
const B: locks.LockHolder = { kind: 'pane', paneid: 'recipe:bt#2', slug: 'briefing-table' };
const U: locks.LockHolder = { kind: 'user', key: 'user', name: null };
const T0 = 1_000_000;
const input = (ttl = 60) => ({ branch: 'main', note: 'merging', ttl_sec: ttl });

console.log('acquire / 409 / renew');
const a1 = locks.acquire('bt', A, input(), T0);
ok(a1.ok && !a1.renewed, 'first holder takes the lock');
const b1 = locks.acquire('bt', B, input(), T0 + 1000);
ok(!b1.ok && b1.status === 409, 'a second holder is 409');
ok(!b1.ok && b1.lock.holder.kind === 'pane' && b1.lock.holder.paneid === A.paneid, '409 names the current holder');
eq(locks.describeHolder(A), 'briefing-table (recipe:bt#1)', 'describeHolder names slug and pane');
const u1 = locks.acquire('bt', U, input(), T0 + 1000);
ok(!u1.ok, 'the user is a different holder from a pane');
const a2 = locks.acquire('bt', A, { branch: 'feat', note: null, ttl_sec: 120 }, T0 + 2000);
ok(a2.ok && a2.renewed, 'the same holder renews');
ok(a2.ok && a2.lock.branch === 'feat' && a2.lock.since === new Date(T0).toISOString(), 'renew keeps since, takes the new branch');
ok(a2.ok && a2.lock.expires_at === new Date(T0 + 2000 + 120_000).toISOString(), 'renew moves the expiry');
eq(locks.acquire('other', B, input(), T0).ok, true, 'locks are per project');

console.log('release');
const r1 = locks.release('bt', B, T0 + 3000);
ok(!r1.ok && r1.status === 403, 'only the holder may release (403)');
eq(locks.list('bt', T0 + 3000).length, 1, 'a refused release leaves the lock');
const r2 = locks.release('bt', A, T0 + 3000);
ok(r2.ok, 'the holder releases');
const r3 = locks.release('bt', A, T0 + 3000);
ok(!r3.ok && r3.status === 404, 'releasing nothing is 404');

console.log('TTL');
locks.acquire('ttl', A, input(10), T0);
eq(locks.list('ttl', T0 + 9_999).length, 1, 'held just before the TTL');
eq(locks.list('ttl', T0 + 10_000).length, 0, 'gone at the TTL');
ok(locks.acquire('ttl', B, input(), T0 + 10_000).ok, 'another holder may take an expired lock');

console.log('input');
throwsField(() => locks.parseLockBody({ ttl_sec: 0 }), 'ttl_sec', 'ttl_sec 0 refused');
throwsField(() => locks.parseLockBody({ ttl_sec: '60' }), 'ttl_sec', 'ttl_sec must be a number');
throwsField(() => locks.parseLockBody({ ttl_sec: 60.5 }), 'ttl_sec', 'ttl_sec must be whole');
throwsField(() => locks.parseLockBody({ ttl: '60' }), 'ttl', 'a bad `ttl` is refused naming `ttl`');
const over = locks.parseLockBody({ ttl_sec: 901 });
ok(over.ttl_sec === 900 && over.clamped_from === 901, 'ttl_sec over 900: clamped to 900, clamped_from says what was asked');
const alias = locks.parseLockBody({ ttl: 600 });
ok(alias.ttl_sec === 600 && alias.clamped_from === undefined && !alias.ttl_default, '`ttl` is accepted: 600 granted');
const aliasOver = locks.parseLockBody({ ttl: 3600 });
ok(aliasOver.ttl_sec === 900 && aliasOver.clamped_from === 3600, '`ttl` 3600: clamped, clamped_from 3600');
eq(locks.parseLockBody({ ttl_sec: 120, ttl: 600 }).ttl_sec, 120, 'both sent: ttl_sec wins');
eq(locks.parseLockBody({}).ttl_default, true, 'none sent: ttl_default');
throwsField(() => locks.parseLockBody({ note: 'x'.repeat(281) }), 'note', 'a long note refused');
eq(locks.parseLockBody({}).ttl_sec, locks.TTL_DEFAULT_SEC, 'ttl defaults');
eq(locks.parseLockBody({ ttl_sec: 900 }).ttl_sec, 900, '900 is allowed');

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
