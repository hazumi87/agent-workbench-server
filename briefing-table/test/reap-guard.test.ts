/**
 * W5 (Owner, 2026-09-24) [ticket]: the windowless reaper is room-aware and
 * activity-aware. Two layers, no db, no pty, no port:
 *
 *   1. `reapHoldReason` — the pure predicate: a persistent seat in an OPEN
 *      room, or streaming / waiting, holds the reap; nothing else does.
 *   2. sessions.scheduleReap with an injected guard (setReapGuard) on a FAKE
 *      resident with a short per-session reap window: held while the guard
 *      holds, and reaped one full window after it clears — never earlier.
 *
 * Timing uses real timers with wide margins (reap window 120ms, guard poll
 * 20ms). The poll env is set BEFORE sessions.ts is imported: it reads it once.
 */
process.env.HARBOR_WB_REAP_GUARD_POLL_MS = '20';

const { reapHoldReason } = await import('../src/engine/reap-guard.ts');
const sessions = await import('../src/engine/sessions.ts');

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed += 1;
    console.log(`  ✓ ${msg} (${String(actual)})`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- predicate ---- */
console.log('\n[reapHoldReason — the predicate]');
type Held = Array<{ room: { state: string }; seat: { policy: string } }>;
const deps = (activity: string | null, seats: Held = []) => ({ activity: () => activity, seats: () => seats });
const seat = (state: string, policy: string) => ({ room: { state }, seat: { policy } });
eq(reapHoldReason('p', deps('idle')), null, 'idle, seated nowhere: reap as normal');
eq(reapHoldReason('p', deps(null)), null, 'unknown activity, seated nowhere: reap as normal');
eq(reapHoldReason('p', deps('streaming')), 'streaming', 'streaming holds');
eq(reapHoldReason('p', deps('waiting')), 'waiting', 'waiting (blocked on the user) holds');
eq(reapHoldReason('p', deps('waiting-seen')), 'waiting', 'waiting-seen (blocked, seen, not answered — v33, ticket) holds as waiting');
eq(reapHoldReason('p', deps('background')), null, 'background does not hold');
eq(reapHoldReason('p', deps('disconnected')), null, 'disconnected does not hold');
eq(reapHoldReason('p', deps('idle', [seat('open', 'persistent')])), 'room-seat', 'a persistent seat in an open room holds');
eq(reapHoldReason('p', deps('idle', [seat('archived', 'persistent')])), null, 'an ARCHIVED room holds nothing (stasis)');
eq(reapHoldReason('p', deps('idle', [seat('open', 'fresh')])), null, 'a fresh seat forgets by design: no hold');
eq(reapHoldReason('p', deps('idle', [seat('open', 'dispatched')])), null, 'a dispatched seat: no hold');
eq(reapHoldReason('p', deps('idle', [seat('open', 'pool')])), null, 'a pool seat: no hold');
eq(
  reapHoldReason('p', deps('idle', [seat('archived', 'persistent'), seat('open', 'persistent')])),
  'room-seat',
  'any ONE open persistent seat among several holds',
);

/* ------------------------------------------------------------ mechanics ---- */
console.log('\n[scheduleReap with an injected guard]');
const WINDOW = 120;
const logs: string[] = [];
const hold = new Map<string, string | null>();
sessions.setReapGuard((paneid) => hold.get(paneid) ?? null, (l) => logs.push(l));

function fake(paneid: string) {
  const r = sessions.add(paneid, { state: 'live' } as never, null as never);
  r.reapOverrideMs = WINDOW;
  let reapedAt: number | null = null;
  const t0 = Date.now();
  sessions.scheduleReap(r, () => {
    reapedAt = Date.now() - t0;
  });
  return { r, reaped: () => reapedAt };
}

// 1. No guard: reaped on the normal window.
const plain = fake('plain');
await sleep(WINDOW + 60);
eq(plain.reaped() !== null, true, 'no hold: reaped after one window');

// 2. Held throughout: never reaped while held; deferral visible in the diag.
hold.set('seated', 'room-seat');
const seated = fake('seated');
await sleep(WINDOW * 3);
eq(seated.reaped(), null, 'held by a room seat for 3 windows: NOT reaped');
const st = sessions.reapState().armed.find((a) => a.paneid === 'seated');
eq(st?.held, 'room-seat', 'reapState shows the hold reason');
eq((st?.hold?.deferrals ?? 0) >= 1, true, 'and counts the deferrals');
eq(sessions.reapState().guardPollMs, 20, 'and the guard poll');
eq(logs.some((l) => l.includes('reap deferred paneid=seated reason=room-seat')), true, 'the deferral is logged (reason, no content)');
eq(logs.filter((l) => l.includes('reap deferred paneid=seated')).length, 1, 'logged once per hold, not per re-arm');

// 3. The hold clears: reaped one full window AFTER it cleared, not before.
hold.set('seated', null);
await sleep(WINDOW / 2);
eq(seated.reaped(), null, 'half a window after clearing: still not reaped');
eq(logs.some((l) => l.includes('reap guard cleared paneid=seated')), true, 'the clear is logged');
await sleep(WINDOW + 80);
eq(seated.reaped() !== null, true, 'a full window after clearing: reaped');
eq(sessions.reapState().armed.some((a) => a.paneid === 'seated'), false, 'and no longer armed');

// 4. Held at detach, cleared BEFORE the timer fires: the window restarts from the clear.
hold.set('burst', 'streaming');
const burst = fake('burst');
await sleep(WINDOW * 0.75);
hold.set('burst', null); // stopped streaming at ~0.75 window
await sleep(WINDOW * 0.5); // original deadline (1.0 window) has passed
eq(burst.reaped(), null, 'original deadline passed, but <1 window since the stream stopped: NOT reaped');
await sleep(WINDOW + 80);
eq(burst.reaped() !== null, true, 'reaped a full window after the stream stopped');

// 5. A viewer attached at fire time: nothing happens (unchanged behaviour).
const watched = fake('watched');
watched.r.viewers.add({} as never);
await sleep(WINDOW + 60);
eq(watched.reaped(), null, 'a viewer present at fire time: not reaped');

// 6. A guard that throws holds (could-not-tell is not abandonment).
sessions.setReapGuard(() => {
  throw new Error('boom');
});
const broken = fake('broken');
await sleep(WINDOW * 2);
eq(broken.reaped(), null, 'a throwing guard holds the reap');
eq(sessions.reapState().armed.find((a) => a.paneid === 'broken')?.held, 'guard-error', 'reason guard-error');

// 7. cancelReap (a reattach) clears the arm and the hold.
sessions.cancelReap(broken.r);
eq(sessions.reapState().armed.some((a) => a.paneid === 'broken'), false, 'cancelReap disarms and forgets the hold');

// 8. reapMs <= 0 still means never: nothing is armed.
sessions.setReapGuard(() => null);
const pinned = sessions.add('pinned', { state: 'live' } as never, null as never);
pinned.reapOverrideMs = 0;
sessions.scheduleReap(pinned, () => {});
eq(sessions.reapState().armed.some((a) => a.paneid === 'pinned'), false, 'reap 0 = never: nothing armed');

for (const [id] of sessions.entries()) {
  sessions.remove(id);
}

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
