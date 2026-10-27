/**
 * W3b terminal grants, the pure half (src/engine/term-grants.ts): the store
 * (TTL, single use, atomic redeem, mint rate), the §3 entitlement rule, the
 * Origin allow-list [R1], and the lifetime and input caps [R3], on a fake
 * clock. The socket half is test/term-grants-engine.test.ts.
 */
import {
  createGrantStore,
  createInputRate,
  entitlement,
  allowedOrigins,
  originAllowed,
  lifetimeVerdict,
  GRANT_TTL_MS,
  MINTS_PER_MINUTE,
  IDLE_MS,
  ABSOLUTE_MS,
  INPUT_FRAMES_PER_SECOND,
  type Lookups,
} from '../src/engine/term-grants.ts';

let failed = 0;
let total = 0;
const ok = (c: unknown, m: string) => {
  total++;
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failed++;
};

let t = 1_000_000;
const clock = () => t;
const fields = { personId: 'u1', credentialId: 's1', paneid: 'p1', intent: 'view' as const, roomId: 'r1', seatId: 'seat1' };

console.log('[store]');
{
  const s = createGrantStore(clock);
  const g = s.mint(fields);
  ok(/^[A-Za-z0-9_-]{43}$/.test(g), '32 random bytes, base64url');
  ok(s.mint(fields) !== g, 'every grant is fresh');
  const got = s.redeem(g);
  ok(got?.paneid === 'p1' && got.personId === 'u1' && got.credentialId === 's1', 'redeem returns what was minted');
  ok(s.redeem(g) === null, 'a grant is single use (reuse refused)');
}
{
  const s = createGrantStore(clock);
  const g = s.mint(fields);
  /* Two sockets presenting the same grant "at once": redeem is synchronous,
     so whichever runs first wins and the other sees nothing [R2]. */
  const results = [g, g].map((x) => s.redeem(x));
  ok(results.filter(Boolean).length === 1, 'concurrent redeem: exactly one wins');
}
{
  const s = createGrantStore(clock);
  const g = s.mint(fields);
  t += GRANT_TTL_MS;
  ok(s.redeem(g) === null, 'a grant at its 30 s expiry is refused');
  ok(s.redeem(g) === null, '...and was deleted all the same');
  const g2 = s.mint(fields);
  t += GRANT_TTL_MS - 1;
  ok(s.redeem(g2) !== null, 'a grant one ms inside its TTL redeems');
  ok(s.redeem('') === null && s.redeem(undefined) === null && s.redeem('nope') === null, 'empty, missing and unknown grants are refused');
}
{
  const s = createGrantStore(clock);
  s.mint(fields);
  t += GRANT_TTL_MS + 1;
  s.mint(fields);
  ok(s.size() === 1, 'expired grants are swept on the next mint');
}
{
  const s = createGrantStore(clock);
  let allowed = 0;
  for (let i = 0; i < MINTS_PER_MINUTE + 3; i++) allowed += s.allowMint('u1') ? 1 : 0;
  ok(allowed === MINTS_PER_MINUTE, `${MINTS_PER_MINUTE} mints per person per minute`);
  ok(s.allowMint('u2'), 'another person has their own minute');
  t += 60_000;
  ok(s.allowMint('u1'), 'the minute rolls over');
}

console.log('[entitlement §3]');
{
  const rooms: Record<string, { id: string; state: string }> = { r1: { id: 'r1', state: 'open' }, r2: { id: 'r2', state: 'archived' } };
  const seats = [
    { id: 'seat1', handle: 'agent', occupant_kind: 'pane', occupant: 'p1' },
    { id: 'seat2', handle: 'empty', occupant_kind: 'none', occupant: null },
  ];
  const panes: Record<string, string> = { p1: 'live', p2: 'live', p3: 'dehydrated' };
  const l: Lookups = { room: (id) => rooms[id], seats: () => seats, paneState: (p) => panes[p] };
  const e = (roomId: string, seat: string, paneid: string) => entitlement({ roomId, seat, paneid }, l);
  const good = e('r1', 'seat1', 'p1');
  ok(good.ok && good.handle === 'agent', 'the seat\'s live occupant is grantable');
  ok(e('r1', 'AGENT', 'p1').ok, 'the seat may be named by handle');
  const want = (r: ReturnType<typeof e>, status: number, field: string, msg: string) =>
    ok(!r.ok && r.status === status && r.field === field, `${msg} -> ${status} ${field}${r.ok ? '' : ` (${r.reason})`}`);
  want(e('nope', 'seat1', 'p1'), 404, 'room', 'no such room');
  want(e('r2', 'seat1', 'p1'), 403, 'paneid', 'an archived room');
  want(e('r1', 'gone', 'p1'), 404, 'seat', 'no such (current) seat');
  want(e('r1', 'seat1', 'zz'), 404, 'paneid', 'no such pane');
  want(e('r1', 'seat1', 'p2'), 403, 'paneid', 'a live pane that is not this seat\'s occupant (unseated: the command bridge)');
  want(e('r1', 'seat2', 'p2'), 403, 'paneid', 'an empty seat');
  panes.p1 = 'dehydrated';
  want(e('r1', 'seat1', 'p1'), 409, 'paneid', 'the occupant is not live');
}

console.log('[origin R1]');
{
  ok(JSON.stringify(allowedOrigins(undefined)) === '["app://workbench"]', 'default allow-list is app://workbench');
  ok(JSON.stringify(allowedOrigins(' a://x , https://y ')) === '["a://x","https://y"]', 'the env is a comma-separated list');
  const allow = allowedOrigins(undefined);
  ok(originAllowed({ origin: 'app://workbench' }, allow), 'app://workbench passes with the default');
  ok(!originAllowed({}, allow), 'a missing Origin is refused');
  ok(!originAllowed({ origin: 'https://evil.example' }, allow), 'a foreign Origin is refused');
  ok(!originAllowed({ origin: 'app://workbench.evil' }, allow), 'exact match only');
  ok(originAllowed({ origin: 'https://host.example.ts.net:8444', host: 'host.example.ts.net:8444', 'x-forwarded-proto': 'https' }, allow), 'the engine\'s own origin passes (its own pages)');
  ok(!originAllowed({ origin: 'http://host.example.ts.net:8444', host: 'host.example.ts.net:8444', 'x-forwarded-proto': 'https' }, allow), '...on the scheme it arrived on only');
  ok(!originAllowed({ origin: 'app://workbench' }, ['https://only.this']), 'an explicit list replaces the default');
}

console.log('[lifetime R3, fake clock]');
{
  const opened = 0;
  ok(lifetimeVerdict({ openedAt: opened, lastActivity: opened }, IDLE_MS - 1) === null, 'open under 30 min idle');
  ok(lifetimeVerdict({ openedAt: opened, lastActivity: opened }, IDLE_MS) === 'idle', '30 min with no input or output -> idle');
  ok(lifetimeVerdict({ openedAt: opened, lastActivity: ABSOLUTE_MS - 1 }, ABSOLUTE_MS - 1) === null, 'busy for 8 h less a ms: still open');
  ok(lifetimeVerdict({ openedAt: opened, lastActivity: ABSOLUTE_MS }, ABSOLUTE_MS) === 'absolute', 'busy at 8 h -> absolute');
}
{
  let now = 0;
  const rate = createInputRate(() => now);
  let passed = 0;
  for (let i = 0; i < INPUT_FRAMES_PER_SECOND; i++) passed += rate() ? 1 : 0;
  ok(passed === INPUT_FRAMES_PER_SECOND, `${INPUT_FRAMES_PER_SECOND} input frames in a second pass`);
  ok(!rate(), 'the next one inside the same second is over the cap');
  now += 1000;
  ok(rate(), 'a second later the window has moved on');
}

console.log(`PASS ${total - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
