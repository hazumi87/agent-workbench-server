/**
 * BUBBLE DISPLAY [rooms/bubbles] (Owner 2026-09-28), engine half: the two
 * per-PERSON view preferences the room page's Display group writes.
 *
 *   - GET /api/rooms/me carries bubbleTransparency (0-60) + bubbleBlur (0-16),
 *     0 / 0 until set;
 *   - PATCH sets either or both; a person only (a bearer is 403, nothing
 *     written); an integer in range, else 400 naming the field (never clamped);
 *   - all-or-nothing with the other /me fields (a bad bubble value writes no
 *     picture / @name);
 *   - PER PERSON: one account's values never show on another's, and the
 *     shared-token user ('user') is its own person.
 *
 * SAFETY: a temp table set BEFORE any import; in-process routes, no engine, no
 * port, nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-bubbles-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_NODE = 'homebase';
delete process.env.HARBOR_WB_IDENTITY; // legacy: a null principal is the shared-token user

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': 'application/json' };
  return r;
}
function resp(out: { status: number; body: any }): any {
  return {
    writeHead(s: number) {
      out.status = s;
    },
    setHeader() {},
    end(x?: unknown) {
      try {
        out.body = JSON.parse(String(x ?? ''));
      } catch {
        out.body = null;
      }
    },
  };
}
const person = (userId: string, username: string): any => ({
  userId, username, isAdmin: false, mustChangePassword: false, via: 'session', sessionId: 's', evidence: null, credentialCreatedAt: null,
});
const ALICE = person('u-alice', 'alice');
const BOB = person('u-bob', 'bob');
const deps = (human: boolean) => ({ projector: async () => (x: any) => x, log: () => {}, human });
async function me(principal: any, method = 'GET', body?: unknown, human = true): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, '/api/rooms/me', body), resp(out), '/api/rooms/me', principal, deps(human));
  return out;
}

try {
  console.log('\n[GET: 0 / 0 until set]');
  const a0 = await me(ALICE);
  eq(a0.status, 200, 'GET /api/rooms/me: 200');
  eq(a0.body?.bubbleTransparency, 0, '...bubbleTransparency 0 (opaque, today\'s look)');
  eq(a0.body?.bubbleBlur, 0, '...bubbleBlur 0');

  console.log('\n[PATCH: a person only]');
  const bearer = await me(ALICE, 'PATCH', { bubbleTransparency: 20 }, false);
  eq(bearer.status, 403, 'a bearer: 403');
  eq(bearer.body?.field, 'credential', '...naming the credential');
  eq((await me(ALICE)).body?.bubbleTransparency, 0, '...and nothing was written');

  console.log('\n[PATCH: set, read back]');
  const t = await me(ALICE, 'PATCH', { bubbleTransparency: 20 });
  eq(t.status, 200, 'PATCH {bubbleTransparency: 20}: 200');
  eq(t.body?.bubbleTransparency, 20, '...20 comes back');
  eq(t.body?.bubbleBlur, 0, '...the blur is untouched (and reported)');
  eq(t.body?.handle, 'alice', '...and the other /me fields still ride along');
  const b = await me(ALICE, 'PATCH', { bubbleBlur: 16 });
  eq(b.body?.bubbleBlur, 16, 'PATCH {bubbleBlur: 16}: 16 (the max)');
  eq(b.body?.bubbleTransparency, 20, '...transparency kept');
  const both = await me(ALICE, 'PATCH', { bubbleTransparency: 60, bubbleBlur: 0 });
  ok(both.status === 200 && both.body?.bubbleTransparency === 60 && both.body?.bubbleBlur === 0, 'one PATCH may carry both (60 / 0: the max, and 0 clears)');
  const r = await me(ALICE);
  ok(r.body?.bubbleTransparency === 60 && r.body?.bubbleBlur === 0, 'GET reads them back');

  console.log('\n[validation: an integer in range, refused (never clamped), naming the field]');
  for (const [field, value, what] of [
    ['bubbleTransparency', 61, 'transparency over 60'],
    ['bubbleTransparency', -5, 'transparency under 0'],
    ['bubbleTransparency', 12.5, 'transparency not whole'],
    ['bubbleTransparency', '20', 'transparency as a string'],
    ['bubbleTransparency', null, 'transparency null'],
    ['bubbleBlur', 17, 'blur over 16'],
    ['bubbleBlur', -1, 'blur under 0'],
    ['bubbleBlur', 1.5, 'blur not whole'],
    ['bubbleBlur', true, 'blur a boolean'],
  ] as const) {
    const x = await me(ALICE, 'PATCH', { [field]: value });
    ok(x.status === 400 && x.body?.field === field, `refused: ${what} (${x.status} field ${x.body?.field}: ${x.body?.error})`);
  }
  const after = await me(ALICE);
  ok(after.body?.bubbleTransparency === 60 && after.body?.bubbleBlur === 0, '...none of them was written');
  const half = await me(ALICE, 'PATCH', { bubbleTransparency: 10, bubbleBlur: 99 });
  eq(half.status, 400, 'a good transparency + a bad blur: 400');
  eq((await me(ALICE)).body?.bubbleTransparency, 60, '...all-or-nothing: the good one was not written');
  const withHandle = await me(ALICE, 'PATCH', { handle: 'alice-2', bubbleBlur: 40 });
  eq(withHandle.status, 400, 'an @name + a bad blur: 400');
  eq((await me(ALICE)).body?.handle, 'alice', '...all-or-nothing: the @name was not written');
  const noField = await me(ALICE, 'PATCH', {});
  ok(noField.status === 400 && /bubbleTransparency/.test(noField.body?.error ?? ''), `an empty PATCH names the bubble fields too (${noField.body?.error})`);

  console.log('\n[per person]');
  const b0 = await me(BOB);
  ok(b0.body?.bubbleTransparency === 0 && b0.body?.bubbleBlur === 0, 'another account starts at 0 / 0 (alice\'s 60 is hers)');
  await me(BOB, 'PATCH', { bubbleTransparency: 35, bubbleBlur: 4 });
  const a1 = await me(ALICE);
  ok(a1.body?.bubbleTransparency === 60 && a1.body?.bubbleBlur === 0, 'bob\'s write left alice\'s alone');
  const bb = await me(BOB);
  ok(bb.body?.bubbleTransparency === 35 && bb.body?.bubbleBlur === 4, '...and bob reads his own back');
  const u0 = await me(null);
  ok(u0.body?.bubbleTransparency === 0 && u0.body?.bubbleBlur === 0, 'the shared-token user (legacy, no principal) is its own person: 0 / 0');
  await me(null, 'PATCH', { bubbleTransparency: 5 });
  eq((await me(null)).body?.bubbleTransparency, 5, '...and writes its own');
  eq((await me(BOB)).body?.bubbleTransparency, 35, '...leaving the accounts alone');
  eq(table.getBubbleDisplay('u-nobody').bubbleTransparency, 0, 'the store: an unknown person reads the default');

  console.log('\n[enterSubmits (Owner 2026-10-04,): per person, null until set]');
  eq((await me(ALICE)).body?.enterSubmits, null, 'GET: null when never set (today\'s behavior)');
  const eb = await me(ALICE, 'PATCH', { enterSubmits: false }, false);
  eq(eb.status, 403, 'a bearer: 403');
  eq((await me(ALICE)).body?.enterSubmits, null, '...nothing written');
  const e1 = await me(ALICE, 'PATCH', { enterSubmits: false });
  ok(e1.status === 200 && e1.body?.enterSubmits === false, 'PATCH false: 200, false comes back');
  eq((await me(ALICE)).body?.enterSubmits, false, 'GET reads false back');
  eq((await me(ALICE, 'PATCH', { bubbleBlur: 3 })).body?.enterSubmits, false, 'another PATCH leaves it alone');
  const e2 = await me(ALICE, 'PATCH', { enterSubmits: 'no' });
  ok(e2.status === 400 && e2.body?.field === 'enterSubmits', 'a non-boolean: 400 naming the field');
  eq((await me(BOB)).body?.enterSubmits, null, 'another person is unaffected (null)');
  eq((await me(ALICE, 'PATCH', { enterSubmits: true })).body?.enterSubmits, true, 'true comes back');
} catch (e) {
  ok(false, `threw: ${(e as Error).stack ?? e}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
