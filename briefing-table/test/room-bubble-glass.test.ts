/**
 * BUBBLE GLASS [bubble glass] Owner 2026-10-05, engine half:
 *   PATCH /api/rooms/:id/settings carries bubble_glass, an integer percent 50-200 | null
 *   (rooms.bubble_glass). Numbers clamp; a non-number is a 400 naming bubble_glass;
 *   null clears it (= 100, today's defaults).
 * SAFETY: temp table, in-process routes, no port. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-glass-'));
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


async function call(method: string, url: string, body?: unknown, human = true): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, url, body), resp(out), url.split('?')[0], ALICE, deps(human));
  return out;
}
try {
  const RID = table.createRoom({ name: 'Glass' }, { actor: 'user' }).result.id;
  const S = `/api/rooms/${RID}/settings`;
  console.log('\n[none stored reads as before]');
  eq(table.getRoom(RID)?.bubble_glass, null, 'a new room has bubble_glass null');
  console.log('\n[set / clamp / clear]');
  const a = await call('PATCH', S, { bubble_glass: 160 });
  ok(a.status === 200 && a.body?.room?.bubble_glass === 160, 'a magnitude is stored and answered');
  eq(table.getRoom(RID)?.bubble_glass, 160, '...and read back from the store');
  const g = await call('GET', `/api/rooms/${RID}`);
  eq(g.body?.room?.bubble_glass, 160, 'the room GET carries it');
  eq((await call('PATCH', S, { bubble_glass: 10 })).body.room.bubble_glass, 50, 'below the range clamps to 50');
  eq((await call('PATCH', S, { bubble_glass: 999 })).body.room.bubble_glass, 200, 'above the range clamps to 200');
  eq((await call('PATCH', S, { bubble_glass: 133.4 })).body.room.bubble_glass, 133, 'rounded to a whole percent');
  await call('PATCH', S, { bubble_glass: 160 });
  for (const [v, what] of [['160', 'a string'], [{}, 'an object'], [true, 'a boolean']] as const) {
    const x = await call('PATCH', S, { bubble_glass: v });
    ok(x.status === 400 && x.body?.field === 'bubble_glass', `refused: ${what} (${x.status} field ${x.body?.field})`);
  }
  eq(table.getRoom(RID)?.bubble_glass, 160, '...none of them was written');
  eq((await call('PATCH', S, { color: '#336699' })).body?.room?.bubble_glass, 160, 'another setting leaves it alone');
  const n = await call('PATCH', S, { bubble_glass: null });
  eq(n.body?.room?.bubble_glass, null, 'null clears it');
  eq(table.getRoom(RID)?.bubble_glass, null, '...in the store too');
} catch (e) {
  ok(false, `threw: ${(e as Error).stack ?? e}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
