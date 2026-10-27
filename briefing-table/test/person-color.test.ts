/**
 * YOUR COLOR (Owner [ref], toolkit [ref]), engine half: the person's own
 * identity color on /api/rooms/me.
 *   - GET carries `color`: null until chosen;
 *   - PATCH {color:'#rrggbb'} stores it lower-cased; {color:null} clears it;
 *   - anything else is a 400 naming `color`, and nothing in the same PATCH is
 *     written (all-or-nothing with the other /me fields);
 *   - a person only (a bearer is 403); per person (one account's color never
 *     shows on another's).
 *
 * SAFETY: a temp table set BEFORE any import; in-process routes, no engine, no
 * port, nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-person-color-'));
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
  console.log('\n[your color on /api/rooms/me]');
  eq((await me(ALICE)).body?.color, null, 'null until chosen');
  const c1 = await me(ALICE, 'PATCH', { color: '#1F8FA6' });
  ok(c1.status === 200 && c1.body?.color === '#1f8fa6', `stored lower-cased (${c1.status} ${c1.body?.color})`);
  eq((await me(ALICE)).body?.color, '#1f8fa6', 'GET returns it');
  eq((await me(BOB)).body?.color, null, 'per person: bob has none');
  for (const [v, what] of [['red', 'a name'], ['#12345', 'five digits'], ['#1234567', 'seven digits'], [12, 'a number'], [{}, 'an object'], ['', 'empty']] as const) {
    const x = await me(ALICE, 'PATCH', { color: v });
    ok(x.status === 400 && x.body?.field === 'color', `refused: ${what} (${x.status} field ${x.body?.field})`);
  }
  eq((await me(ALICE)).body?.color, '#1f8fa6', '...and the refused values wrote nothing');
  const mixed = await me(ALICE, 'PATCH', { color: 'nope', handle: 'alice-new' });
  eq(mixed.status, 400, 'a bad color with another field: 400');
  ok((await me(ALICE)).body?.handle !== 'alice-new', '...and the other field was not written either (all-or-nothing)');
  const both = await me(ALICE, 'PATCH', { color: '#0dab49', tones: {} });
  eq(both.body?.color, '#0dab49', 'color rides along with another field');
  eq((await me(ALICE, 'PATCH', { color: '#ba08b4' }, false)).status, 403, 'a bearer: 403');
  eq((await me(ALICE)).body?.color, '#0dab49', '...nothing written');
  const cleared = await me(ALICE, 'PATCH', { color: null });
  ok(cleared.status === 200 && cleared.body?.color === null, 'null clears it');
  const empty = await me(ALICE, 'PATCH', {});
  ok(empty.status === 400 && /color \(your own #rrggbb/.test(empty.body?.error ?? ''), 'the empty-PATCH message names color');
} catch (e) {
  ok(false, `threw: ${(e as Error).stack ?? e}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
