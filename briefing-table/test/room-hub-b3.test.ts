/**
 * ROOM ART MODEL + PALETTE OVERRIDE + LINE WASH [hub-v2] (Owner 2026-10-05, the design system
 * b0f8099 sec 1.E/F/G), engine half:
 *   - PATCH /api/rooms/:id/settings carries art_tile {id, blend, level, strength,
 *     zoom} | null, pal (a palette key) | null, pal_mode (dark | light) | null;
 *     a bad value is a 400 naming the field, nothing written;
 *   - PATCH /api/rooms/me carries wash {dark:{spot,edge}, light:{spot,edge}} | null,
 *     clamped to the track and its stop, per person per mode.
 *
 * (header of the test it was copied from follows)
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

const dir = mkdtempSync(join(tmpdir(), 'wb-room-hub-b3-'));
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
  const RID = table.createRoom({ name: 'Hub b3' }, { actor: 'user' }).result.id;
  const S = `/api/rooms/${RID}/settings`;
  console.log('\n[a room with none of it reads as before]');
  const r0 = (await call('GET', `/api/rooms/${RID}`)).body?.room ?? table.getRoom(RID);
  ok(r0.art_tile === null && r0.pal === null && r0.pal_mode === null, 'art_tile / pal / pal_mode are null');

  console.log('\n[art_tile]');
  const t1 = await call('PATCH', S, { art_tile: TILE });
  ok(t1.status === 200 && JSON.stringify(t1.body?.room?.art_tile) === JSON.stringify(TILE), 'a valid tile is stored and answered');
  eq(JSON.stringify(table.getRoom(RID)?.art_tile), JSON.stringify(TILE), '...and read back from the store');
  const t2 = await call('PATCH', S, { art_tile: { ...TILE, blend: 'soft-light', level: 40.4, strength: 0, zoom: 200 } });
  ok(t2.status === 200 && t2.body?.room?.art_tile?.blend === 'soft-light' && t2.body.room.art_tile.level === 40 && t2.body.room.art_tile.strength === 0 && t2.body.room.art_tile.zoom === 200, 'every blend, 0 strength and 200 zoom are in range (level rounds)');
  for (const [v, field, what] of [
    [{ ...TILE, id: 'nope' }, 'art_tile.id', 'an id that is not a tile id'],
    [{ ...TILE, id: '../x-quiet-tint' }, 'art_tile.id', 'a path-shaped id'],
    [{ ...TILE, blend: 'dodge' }, 'art_tile.blend', 'an unknown blend'],
    [{ ...TILE, level: 9 }, 'art_tile.level', 'level under 10'],
    [{ ...TILE, level: 101 }, 'art_tile.level', 'level over 100'],
    [{ ...TILE, strength: -1 }, 'art_tile.strength', 'strength under 0'],
    [{ ...TILE, zoom: 49 }, 'art_tile.zoom', 'zoom under 50'],
    [{ ...TILE, zoom: 201 }, 'art_tile.zoom', 'zoom over 200'],
    [{ ...TILE, zoom: '100' }, 'art_tile.zoom', 'zoom a string'],
    [{ ...TILE, extra: 1 }, 'art_tile.extra', 'an unknown key'],
    [{ id: TILE.id }, 'art_tile.blend', 'a missing key'],
    ['koi', 'art_tile', 'a string'],
  ] as const) {
    const x = await call('PATCH', S, { art_tile: v });
    ok(x.status === 400 && x.body?.field === field, `refused: ${what} (${x.status} field ${x.body?.field})`);
  }
  eq(table.getRoom(RID)?.art_tile?.blend, 'soft-light', '...none of them was written');
  eq((await call('PATCH', S, { art_tile: null })).body?.room?.art_tile, null, 'null clears it (the room art paints again)');

  console.log('\n[pal / pal_mode]');
  const p1 = await call('PATCH', S, { pal: 'ocean' });
  ok(p1.status === 200 && p1.body?.room?.pal === 'ocean' && p1.body.room.pal_mode === 'dark', 'a palette alone starts Dark');
  const p2 = await call('PATCH', S, { pal_mode: 'light' });
  ok(p2.status === 200 && p2.body?.room?.pal === 'ocean' && p2.body.room.pal_mode === 'light', 'the mode follows');
  for (const [v, field, what] of [
    [{ pal: 'custom' }, 'pal', 'custom (a person\'s, not a room\'s)'],
    [{ pal: 'nope' }, 'pal', 'an unknown palette'],
    [{ pal: 3 }, 'pal', 'a number'],
    [{ pal_mode: 'dim' }, 'pal_mode', 'an unknown mode'],
  ] as const) {
    const x = await call('PATCH', S, v);
    ok(x.status === 400 && x.body?.field === field, `refused: ${what} (${x.status} field ${x.body?.field})`);
  }
  const p3 = await call('PATCH', S, { pal: null });
  ok(p3.status === 200 && p3.body?.room?.pal === null && p3.body.room.pal_mode === null, 'pal null = Reset to global: the mode goes with it');
  const p4 = await call('PATCH', S, { pal_mode: 'light' });
  ok(p4.status === 400 && p4.body?.field === 'pal_mode', 'a mode with no palette: 400');
  const bearer = await call('PATCH', S, { pal: 'sky' }, false);
  eq(bearer.status, 403, 'a bearer: 403');
  eq(table.getRoom(RID)?.pal, null, '...nothing written');

  console.log('\n[wash on /api/rooms/me]');
  const w0 = (await me(ALICE)).body?.wash;
  ok(w0?.dark?.spot === 0.3 && w0.dark.edge === 0.16 && w0.light.spot === 0.925 && w0.light.edge === 0.975, 'GET: the defaults (dark equals today\'s .30 / .16)');
  const w1 = await me(ALICE, 'PATCH', { wash: { dark: { spot: 0.2, edge: 0.12 } } });
  ok(w1.status === 200 && w1.body?.wash?.dark?.spot === 0.2 && w1.body.wash.dark.edge === 0.12, 'a dark spot/edge is stored');
  eq(w1.body?.wash?.light?.spot, 0.925, '...the light mode is untouched');
  const w2 = await me(ALICE, 'PATCH', { wash: { dark: { spot: 0.9, edge: 0.01 } } });
  ok(w2.body?.wash?.dark?.spot === 0.4 && w2.body.wash.dark.edge === 0.1, 'past the stops: spot clamps to L .40, edge to L .10');
  const w3 = await me(ALICE, 'PATCH', { wash: { light: { spot: 0.5, edge: 0.9 } } });
  ok(w3.body?.wash?.light?.spot === 0.74 && w3.body.wash.light.edge === 0.9, 'light: the spot stops at L .74 (auriga dc48334)');
  const w4 = await me(ALICE, 'PATCH', { wash: { dark: { spot: 0.2, edge: 0.3 } } });
  ok(w4.body?.wash?.dark?.edge === 0.2, 'the handles cannot cross (dark edge held at the spot)');
  eq((await me(BOB)).body?.wash?.dark?.spot, 0.3, 'per person: bob still has the defaults');
  for (const [v, field, what] of [
    [{ dark: { spot: 'x', edge: 0.1 } }, 'wash.dark.spot', 'a non-number'],
    [{ dark: { spot: 0.2 } }, 'wash.dark.edge', 'a missing edge'],
    [{ dusk: {} }, 'wash.dusk', 'an unknown mode'],
    [{ dark: { spot: 0.2, edge: 0.1, x: 1 } }, 'wash.dark.x', 'an unknown key'],
    ['dark', 'wash', 'a string'],
  ] as const) {
    const x = await me(ALICE, 'PATCH', { wash: v });
    ok(x.status === 400 && x.body?.field === field, `refused: ${what} (${x.status} field ${x.body?.field})`);
  }
  const wb = await me(ALICE, 'PATCH', { wash: { dark: { spot: 0.3, edge: 0.16 } } }, false);
  eq(wb.status, 403, 'a bearer: 403');
  const w5 = await me(ALICE, 'PATCH', { wash: null });
  ok(w5.status === 200 && w5.body?.wash?.dark?.spot === 0.3 && w5.body.wash.light.edge === 0.975, 'null resets both modes to the defaults');
} catch (e) {
  ok(false, `threw: ${(e as Error).stack ?? e}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
