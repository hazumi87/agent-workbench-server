/**
 * A WORKGROUP WEARS ITS MAIN ROOM'S DESIGN, AND GETS ITS OWN COLOR [workgroup design]
 * Owner 2026-10-05. GET /api/rooms/:id resolves art / art_tile / wash_at / bubble_glass /
 * pal (+ pal_mode) from the main room for each field the workgroup leaves null; `inherited`
 * names them; the workgroup's own value wins; color is never inherited. A workgroup made with
 * no color is given a swatch no sibling and not the main room wears; the boot sweep re-picks
 * later duplicates, once. In-process, a temp table. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-wginherit-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const { pickRoomColor, hueDistance, ROOM_SWATCHES } = await import('../src/engine/room-color.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  X  ${msg}`);
  }
}
const eq = (a: unknown, b: unknown, msg: string): void => ok(Object.is(a, b), `${msg} (got ${JSON.stringify(a)})`);
const same = (a: unknown, b: unknown, msg: string): void => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  return r;
}
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const r = {
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
  const launch = async () => ({ ok: true as const, paneid: 'p', url: '/p', path: '/p', placement: 'tab' });
  await rooms.handle(req(method, url, body), r as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {}, human: true, launch } as any);
  return out;
}
function agent(id: string, name: string): void {
  table.upsertRecipe({
    id, name, target: 'local', projectDir: `/x/${name}`, vendor: 'claude-code', agent: name, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
  table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent: name, session_id: null, state: 'live', generation: 1 } as never);
}
const seat = (roomId: string, id: string, handle: string): any => table.addSeat(roomId, { recipe_id: id, occupant: `recipe:${id}`, handle }, { actor: 'user' }).result;
const TILE = { id: 'biomes-waves-quiet-tint', blend: 'color', level: 20, strength: 100, zoom: 100 };

try {
  console.log('\n[the picker]');
  eq(pickRoomColor([]), ROOM_SWATCHES[0], 'nothing used: the first swatch');
  const second = pickRoomColor([ROOM_SWATCHES[0]]);
  ok(second !== ROOM_SWATCHES[0] && hueDistance(second, ROOM_SWATCHES[0]) >= 30, 'one used: a swatch 30+ degrees of hue away');
  const nearDup = pickRoomColor(['#1f8fa7']);
  ok(nearDup !== ROOM_SWATCHES[0], 'a near-duplicate (#1f8fa7) counts as the first swatch being used');
  const far = pickRoomColor([...ROOM_SWATCHES]);
  ok((ROOM_SWATCHES as readonly string[]).includes(far), 'every swatch used: still a swatch (the farthest)');

  console.log('\n[inheritance]');
  for (const [id, n] of [['a', 'boss'], ['b', 'bee']]) {
    agent(id, n);
  }
  const M = table.createRoom({ name: 'Main', alias: 'main' }, { actor: 'user' }).result;
  seat(M.id, 'a', 'boss');
  const bee = seat(M.id, 'b', 'bee');
  table.setRoomSettings(M.id, { color: '#d9622b', art_tile: TILE, pal: 'forest', pal_mode: 'light', bubble_glass: 200, wash_at: { x: 30, y: 40 } });
  const W = table.createRoom({ name: 'UI', parent_id: M.id }, { actor: 'user' }).result;
  let r = await call('GET', `/api/rooms/${W.id}`);
  eq(r.status, 200, 'the workgroup detail answers');
  same(r.body.room.art_tile, TILE, 'art_tile comes from the main room');
  eq(r.body.room.pal, 'forest', 'pal comes from the main room');
  eq(r.body.room.pal_mode, 'light', 'pal_mode comes with it');
  eq(r.body.room.bubble_glass, 200, 'bubble_glass comes from the main room');
  same(r.body.room.wash_at, { x: 30, y: 40 }, 'wash_at comes from the main room');
  same([...r.body.inherited].sort(), ['art_tile', 'bubble_glass', 'pal', 'pal_mode', 'wash_at'], 'inherited lists exactly those (the main room has no art)');
  ok(r.body.room.color !== '#d9622b', 'color is never inherited');
  eq(table.getRoom(W.id)?.art_tile, null, 'the stored workgroup row is untouched (resolved at read)');

  /* [wg follow] Owner 2026-10-07: following is the default; its own values are only used with the switch off */
  eq(r.body.room.design_follow, true, 'a workgroup follows the room by default');
  r = await call('PATCH', `/api/rooms/${W.id}/settings`, { bubble_glass: 80, pal: 'ocean', pal_mode: 'dark' });
  eq(r.status, 200, 'the workgroup saves its own values');
  r = await call('GET', `/api/rooms/${W.id}`);
  eq(r.body.room.bubble_glass, 200, 'while following, the main room still wins (its own value is saved, unused)');
  eq(r.body.room.pal, 'forest', '...its palette too');
  eq(table.getRoom(W.id)?.bubble_glass, 80, '...and the stored row keeps its own value');
  eq((await call('PATCH', `/api/rooms/${W.id}/settings`, { design_follow: 'yes' })).status, 400, 'design_follow must be a boolean');
  r = await call('PATCH', `/api/rooms/${W.id}/settings`, { design_follow: false });
  eq(r.status, 200, 'the switch turns off');
  same([...r.body.inherited].sort(), ['art_tile', 'wash_at'], 'the PATCH answer lists what is still inherited');
  r = await call('GET', `/api/rooms/${W.id}`);
  eq(r.body.room.bubble_glass, 80, 'its own bubble_glass wins');
  eq(r.body.room.pal, 'ocean', 'its own palette wins');
  eq(r.body.room.pal_mode, 'dark', 'with its own mode');
  same(r.body.room.art_tile, TILE, 'a field it did not override still follows the main room');
  r = await call('PATCH', `/api/rooms/${W.id}/settings`, { bubble_glass: null, pal: null });
  r = await call('GET', `/api/rooms/${W.id}`);
  eq(r.body.room.bubble_glass, 200, 'Reset to main room (null) follows the main room again');
  ok(r.body.inherited.includes('pal') && r.body.inherited.includes('pal_mode'), '...and inherited says so');

  r = await call('PATCH', `/api/rooms/${W.id}/settings`, { bubble_glass: 80, design_follow: true });
  r = await call('GET', `/api/rooms/${W.id}`);
  eq(r.body.room.bubble_glass, 200, 'switched back on: it follows the main room again');
  r = await call('PATCH', `/api/rooms/${M.id}/settings`, { bubble_glass: 120 });
  r = await call('GET', `/api/rooms/${W.id}`);
  eq(r.body.room.bubble_glass, 120, 'change the room, the following workgroup changes with it');
  ok(r.body.room.color !== '#d9622b', '...and keeps its own color');
  r = await call('PATCH', `/api/rooms/${M.id}/settings`, { bubble_glass: 200 });
  r = await call('GET', `/api/rooms/${M.id}`);
  same(r.body.inherited, [], 'a main room inherits nothing');
  console.log('\n[default feed cascades] Owner 2026-10-05');
  const FEED = { kinds: ['chat', 'fact'], who: 'me' };
  r = await call('PATCH', `/api/rooms/${M.id}/settings`, { feed_default: FEED });
  eq(r.status, 200, 'the main room saves a default feed (who: me)');
  const W2 = table.createRoom({ name: 'Ops', parent_id: M.id }, { actor: 'user' }).result;
  r = await call('GET', `/api/rooms/${W2.id}`);
  ok(r.body.room.feed_default?.who === 'me' && r.body.inherited.includes('feed_default'), 'a workgroup with no feed of its own follows the main room\'s');
  r = await call('PATCH', `/api/rooms/${W2.id}/settings`, { feed_default: { kinds: ['chat'], who: '' } });
  r = await call('GET', `/api/rooms/${W2.id}`);
  ok(r.body.room.feed_default?.who === '' && !r.body.inherited.includes('feed_default'), 'its own saved feed wins');
  r = await call('PATCH', `/api/rooms/${W2.id}/settings`, { feed_default: null });
  r = await call('GET', `/api/rooms/${W2.id}`);
  ok(r.body.room.feed_default?.who === 'me', 'Reset to main room follows it again');

  eq(r.body.room.pal, 'forest', 'and shows its own');

  console.log('\n[auto color]');
  const url = `/api/rooms/${M.id}/workgroups`;
  agent('c', 'cat');
  agent('d', 'dee');
  const cat = seat(M.id, 'c', 'cat');
  const dee = seat(M.id, 'd', 'dee');
  r = await call('POST', url, { name: 'Client', move: [cat.id], lead: { move: cat.id } });
  eq(r.status, 200, 'a workgroup created with no color');
  const c1 = r.body.room.color;
  ok(/^#[0-9a-f]{6}$/.test(c1), 'gets one');
  ok(c1 !== table.getRoom(W.id)?.color && hueDistance(c1, table.getRoom(W.id)!.color!) >= 30, '...distinct (30+ degrees) from its sibling UI');
  ok(hueDistance(c1, '#d9622b') >= 30, '...and from the main room');
  r = await call('POST', url, { name: 'Chosen', color: '#C9A227', move: [dee.id], lead: { move: dee.id } });
  eq(r.body.room.color, '#c9a227', 'a chosen color is kept');

  console.log('\n[boot sweep]');
  const M2 = table.createRoom({ name: 'Other', alias: 'other' }, { actor: 'user' }).result;
  const k1 = table.createRoom({ name: 'One', parent_id: M2.id }, { actor: 'user' }).result;
  const k2 = table.createRoom({ name: 'Two', parent_id: M2.id }, { actor: 'user' }).result;
  table.setRoomSettings(k1.id, { color: '#1f8fa6' });
  table.setRoomSettings(k2.id, { color: '#1f8fa6' });
  const ch = table.dedupeWorkgroupColors();
  eq(ch.length, 1, 'one duplicate re-picked');
  eq(ch[0]?.id, k2.id, '...the later-created one');
  eq(table.getRoom(k1.id)?.color, '#1f8fa6', 'the earlier keeps its color');
  ok(hueDistance(table.getRoom(k2.id)!.color!, '#1f8fa6') >= 30, 'the later has a distinct one');
  eq(table.dedupeWorkgroupColors().length, 0, 'a second run changes nothing (idempotent)');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: EPERM */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
