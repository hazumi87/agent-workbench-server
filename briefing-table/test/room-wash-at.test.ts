/**
 * SPOT POSITION PAD [hub-v2 sec 1.I] (Owner 2026-10-05), engine half:
 *   PATCH /api/rooms/:id/settings carries wash_at {x, y} (0-100) | null, stored
 *   per room (rooms.wash_at). Numbers clamp to the square; a non-number is a 400
 *   naming wash_at.<key>; null clears it (the art's own origin returns).
 * SAFETY: temp table, in-process routes, no port. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-wash-at-'));
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
const TILE = { id: 'animals-koi-busy-tint', blend: 'color', level: 100, strength: 60, zoom: 100 };

try {
  const RID = table.createRoom({ name: 'Wash at' }, { actor: 'user' }).result.id;
  const S = `/api/rooms/${RID}/settings`;
  console.log('\n[none stored reads as before]');
  eq(table.getRoom(RID)?.wash_at, null, 'a new room has wash_at null');
  console.log('\n[set / clamp / clear]');
  const a = await call('PATCH', S, { wash_at: { x: 80, y: 20 } });
  ok(a.status === 200 && a.body?.room?.wash_at?.x === 80 && a.body.room.wash_at.y === 20, 'a position is stored and answered');
  eq(JSON.stringify(table.getRoom(RID)?.wash_at), '{"x":80,"y":20}', '...and read back from the store');
  const g = await call('GET', `/api/rooms/${RID}`);
  eq(g.body?.room?.wash_at?.x, 80, 'the room GET carries it');
  const c = await call('PATCH', S, { wash_at: { x: -5, y: 140.26 } });
  ok(c.status === 200 && c.body.room.wash_at.x === 0 && c.body.room.wash_at.y === 100, 'off the square clamps to its edges');
  const d = await call('PATCH', S, { wash_at: { x: 33.33, y: 66.67 } });
  ok(d.body.room.wash_at.x === 33.3 && d.body.room.wash_at.y === 66.7, 'rounded to a tenth');
  await call('PATCH', S, { wash_at: { x: 80, y: 20 } });
  for (const [v, field, what] of [
    [{ x: '80', y: 20 }, 'wash_at.x', 'x a string'],
    [{ x: 80 }, 'wash_at.y', 'y missing'],
    [{ x: 80, y: null }, 'wash_at.y', 'y null'],
    [{ x: 80, y: 20, z: 1 }, 'wash_at.z', 'an unknown key'],
    ['center', 'wash_at', 'a string'],
    [[1, 2], 'wash_at', 'an array'],
  ] as const) {
    const x = await call('PATCH', S, { wash_at: v });
    ok(x.status === 400 && x.body?.field === field, `refused: ${what} (${x.status} field ${x.body?.field})`);
  }
  eq(table.getRoom(RID)?.wash_at?.x, 80, '...none of them was written');
  const o = await call('PATCH', S, { color: '#336699' });
  eq(o.body?.room?.wash_at?.x, 80, 'another setting leaves it alone');
  const n = await call('PATCH', S, { wash_at: null });
  eq(n.body?.room?.wash_at, null, 'null clears it (the art\'s own origin returns; it does not store 25 75)');
  eq(table.getRoom(RID)?.wash_at, null, '...in the store too');
} catch (e) {
  ok(false, `threw: ${(e as Error).stack ?? e}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
