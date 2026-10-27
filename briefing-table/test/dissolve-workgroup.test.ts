/**
 * DISSOLVE A WORKGROUP (Owner [ref]): store verb + route + room command. Header of
 * workgroups.test.ts follows (same harness).
 * WORKGROUPS, engine half (Owner 2026-10-04, KB design-notes-id §3, §10): a main
 * room plus its workgroups is a FAMILY. Data (parent_id, alias, one nesting
 * level, family-unique handles, archive rules), routing (@handle anywhere in the
 * family, @lead = the head lead, @alias = that room's lead, @room = this room),
 * cross-posts (ONE line, shown in the room it was written in and in each room it
 * reached), moves, and the per-person badge cursor.
 *
 * Owner's worked scenario: main "Alpha-runtime Apps" (lead alpha-platform),
 * workgroup tool-dev (lead alpha-dev + the design system), workgroup
 * tool-operators (lead alpha-op + claude-asset-worker).
 *
 * SAFETY: a temp table set BEFORE any import; fabric off. Nothing listens,
 * nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-dissolve-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const { table, RoomError } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}
function same(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? msg : `${msg} (got ${a}, want ${b})`);
}
function refuses(fn: () => unknown, status: number, field: string, msg: string, has?: string): void {
  try {
    fn();
    ok(false, `${msg} — expected ${status} field:${field}, but it succeeded`);
  } catch (e) {
    const err = e as InstanceType<typeof RoomError>;
    const hit = e instanceof RoomError && err.status === status && err.field === field && (has === undefined || err.message.includes(has));
    ok(hit, `${msg} (${e instanceof RoomError ? `${err.status} field:${err.field} "${err.message}"` : String(e)})`);
  }
}

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  return r;
}
async function call(method: string, url: string, body?: unknown, human = false): Promise<{ status: number; body: any }> {
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
  await rooms.handle(req(method, url, body), r as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {}, human });
  return out;
}
const meta = (e: any) => (typeof e?.meta === 'string' ? JSON.parse(e.meta) : e?.meta);
function agent(id: string, name: string): void {
  table.upsertRecipe({
    id, name, target: 'local', projectDir: `/x/${name}`, vendor: 'claude-code', agent: name, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
  table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent: name, session_id: null, state: 'live', generation: 1 } as never);
}
const seat = (roomId: string, id: string, handle: string): any =>
  table.addSeat(roomId, { recipe_id: id, occupant: `recipe:${id}`, handle }, { actor: 'user' }).result;
const facts = (roomId: string): string[] => table.listLine(roomId, { limit: 500 }).filter((e: any) => e.kind === 'fact').map((e: any) => e.body);
const active = (roomId: string): any[] => table.listSeats(roomId).filter((s: any) => !s.left_at);

try {
  for (const [id, name] of [['a', 'main-lead'], ['d', 'dev-lead'], ['u', 'auriga'], ['w', 'worker'], ['s', 'studio-agent'], ['q', 'quiet']]) {
    agent(id, name);
  }
  console.log('\n[store: dissolve with the main room led]');
  const M = table.createRoom({ name: 'Studio', alias: 'studio' }, { actor: 'user' }).result;
  const mainLead = seat(M.id, 'a', 'main-lead');
  const G = table.createRoom({ name: 'Dev room', parent_id: M.id, alias: 'dev' }, { actor: 'user' }).result;
  const devLead = seat(G.id, 'd', 'dev-lead');
  const auriga = seat(G.id, 'u', 'auriga');
  const worker = seat(G.id, 'w', 'worker');
  eq(table.getRoom(G.id)?.lead_seat, devLead.id, 'the group has its own lead');
  refuses(() => table.moveSeat(G.id, devLead.id, M.id, { actor: 'user' }), 409, 'seat', 'moveSeat still refuses the lead', 'hand the lead over first');
  const histBefore = table.listLine(G.id, { limit: 500 }).length;
  const out = table.dissolveWorkgroup(G.id, { actor: 'user' });
  same(out.result.moved.map((s: any) => s.id).sort(), [devLead.id, auriga.id, worker.id].sort(), 'every seat moved, the lead included');
  for (const s of [devLead, auriga, worker]) {
    const now = table.getSeat(s.id);
    ok(now.room_id === M.id && now.handle === s.handle && now.occupant === s.occupant && now.occupant_kind === s.occupant_kind, `@${s.handle}: same row, handle and pane, now in the main room`);
    ok(!table.getSeat(s.id).is_lead, `@${s.handle} is an ordinary seat`);
  }
  eq(table.getRoom(M.id)?.lead_seat, mainLead.id, "the main room's own lead is untouched");
  const gr = table.getRoom(G.id);
  eq(gr?.state, 'archived', 'the group is closed (archived), not deleted');
  eq(gr?.lead_seat, null, "the closed group's lead pointer is cleared");
  eq(active(G.id).length, 0, 'the group holds no active seat');
  eq(active(M.id).length, 4, 'the main room holds all four');
  ok(!table.listRooms({ state: 'open' }).some((r: any) => r.id === G.id), 'it leaves the open list');
  ok(table.listLine(G.id, { limit: 500 }).length >= histBefore, 'its history is still readable');
  ok(facts(M.id).some((b) => /^Workgroup Dev room dissolved: @dev-lead, @auriga and @worker returned to this room; its history is kept\./.test(b)), 'the main room says who returned');
  ok(facts(G.id).includes('dissolved into Studio'), 'the closed group keeps "dissolved into <parent>"');
  ok(facts(M.id).some((b) => /@auriga moved here from Dev room/.test(b)) && facts(G.id).some((b) => /@auriga moved to the main room/.test(b)), "'moved' facts in both rooms");
  const dm = out.entries.find((e: any) => /dissolved:/.test(e.body));
  ok(meta(dm)?.dissolved === G.id && meta(dm)?.parent_has_lead === true, 'the fact carries machine meta');
  refuses(() => table.dissolveWorkgroup(G.id, { actor: 'user' }), 409, 'state', 'a closed group cannot be dissolved again');

  console.log('\n[store: a leaderless main room is not auto-promoted]');
  const M2 = table.createRoom({ name: 'Bare main' }, { actor: 'user' }).result;
  const G2 = table.createRoom({ name: 'Solo group', parent_id: M2.id, alias: 'solo' }, { actor: 'user' }).result;
  const sl = seat(G2.id, 's', 'studio-agent');
  eq(table.getRoom(M2.id)?.lead_seat, null, 'precondition: the main room has no lead');
  const o2 = table.dissolveWorkgroup(G2.id, { actor: 'user' });
  eq(o2.result.parentHasLead, false, 'reports the parent has no lead');
  eq(table.getRoom(M2.id)?.lead_seat, null, 'still leaderless: nothing promoted');
  ok(facts(M2.id).some((b) => /@studio-agent returned to this room.*has no lead/.test(b)), 'the fact says so');
  eq(table.getSeat(sl.id).room_id, M2.id, 'the seat is in the main room');

  console.log('\n[store: refusals]');
  refuses(() => table.dissolveWorkgroup(M.id, { actor: 'user' }), 409, 'id', 'a main room cannot be dissolved', 'main room');
  const G3 = table.createRoom({ name: 'Archived grp', parent_id: M.id, alias: 'arch' }, { actor: 'user' }).result;
  table.archiveRoom(G3.id, { actor: 'user' });
  refuses(() => table.dissolveWorkgroup(G3.id, { actor: 'user' }), 409, 'state', 'an archived room is refused');
  refuses(() => table.dissolveWorkgroup('nope', { actor: 'user' }), 404, 'id', 'an unknown room is 404');
  refuses(() => table.createRoom({ name: 'Deep', parent_id: G.id, alias: 'deep' }, { actor: 'user' }), 409, 'parent_id', 'nested groups cannot exist (one level), so no child-group case');

  console.log('\n[store: all or nothing]');
  const M4 = table.createRoom({ name: 'Atomic main' }, { actor: 'user' }).result;
  const G4 = table.createRoom({ name: 'Atomic grp', parent_id: M4.id, alias: 'atomic' }, { actor: 'user' }).result;
  const first = seat(G4.id, 'q', 'quiet');
  /* a second group seat on a pane the main room already holds: its move is refused */
  const holder = table.addSeat(M4.id, { project: 'x', handle: 'holder', occupant: 'recipe:a' }, { actor: 'user' }).result;
  const clash = table.addSeat(G4.id, { project: 'x', handle: 'clasher', occupant: 'recipe:a' }, { actor: 'user' }).result;
  const linesM = table.listLine(M4.id, { limit: 500 }).length;
  const linesG = table.listLine(G4.id, { limit: 500 }).length;
  const leadG4 = table.getRoom(G4.id)?.lead_seat;
  refuses(() => table.dissolveWorkgroup(G4.id, { actor: 'user' }), 409, 'occupant', 'a pane clash in the main room refuses the whole dissolve', 'already holds');
  eq(table.getSeat(first.id).room_id, G4.id, 'the seat moved first is back in the group');
  eq(table.getSeat(clash.id).room_id, G4.id, 'the clashing seat stays');
  eq(table.getRoom(G4.id)?.state, 'open', 'the group is still open');
  eq(table.getRoom(G4.id)?.lead_seat, leadG4, 'its lead pointer is unchanged');
  ok(table.listLine(M4.id, { limit: 500 }).length === linesM && table.listLine(G4.id, { limit: 500 }).length === linesG, 'no fact was written in either room');
  ok(holder.id !== undefined, 'the main room seat is intact');

  console.log('\n[root, not sibling group (Owner [ref])]');
  const R = table.createRoom({ name: 'Root room' }, { actor: 'user' }).result;
  const GA = table.createRoom({ name: 'Group A', parent_id: R.id, alias: 'ga' }, { actor: 'user' }).result;
  const GB = table.createRoom({ name: 'Group B', parent_id: R.id, alias: 'gb' }, { actor: 'user' }).result;
  const bs = table.addSeat(GB.id, { project: 'x', handle: 'bseat' }, { actor: 'user' }).result;
  const ob = table.dissolveWorkgroup(GB.id, { actor: 'user' });
  eq(table.getSeat(bs.id).room_id, R.id, 'dissolving B lands the seat in the ROOT');
  eq(ob.result.parent.id, R.id, 'the result names the root');
  ok(facts(R.id).some((b) => /Group B dissolved: @bseat returned to this room/.test(b)), 'the fact is in the root');
  eq(table.getRoom(GA.id)?.state, 'open', 'sibling A is untouched');
  eq(active(GA.id).length, 0, '...and received nothing');

  console.log('\n[route + command]');
  const M5 = table.createRoom({ name: 'Route main' }, { actor: 'user' }).result;
  const G5 = table.createRoom({ name: 'Route grp', parent_id: M5.id, alias: 'rgrp' }, { actor: 'user' }).result;
  const s5 = table.addSeat(G5.id, { project: 'x', handle: 'routed' }, { actor: 'user' }).result;
  eq((await call('POST', `/api/rooms/${G5.id}/dissolve`, {}, false)).status, 403, 'a non-window credential is refused');
  eq(table.getRoom(G5.id)?.state, 'open', '...and nothing changed');
  eq((await call('POST', `/api/rooms/${M5.id}/dissolve`, {}, true)).status, 409, 'a main room answers 409');
  const ok5 = await call('POST', `/api/rooms/${G5.id}/dissolve`, {}, true);
  eq(ok5.status, 200, 'POST /api/rooms/:id/dissolve');
  same(ok5.body.moved, [{ seat: s5.id, handle: 'routed' }], 'answers the moved seats');
  ok(ok5.body.parent === M5.id && ok5.body.closed === true, 'answers parent and closed:true');
  eq(table.getSeat(s5.id).room_id, M5.id, 'the seat is in the main room');

  const G6 = table.createRoom({ name: 'Cmd grp', parent_id: M5.id, alias: 'cgrp' }, { actor: 'user' }).result;
  const s6 = table.addSeat(G6.id, { project: 'x', handle: 'cmdseat' }, { actor: 'user' }).result;
  const c1 = await call('POST', `/api/rooms/${G6.id}/line`, { text: '/dissolve' }, true);
  eq(c1.body?.status, 'confirm', '/dissolve asks first');
  ok(/@cmdseat/.test(c1.body?.confirm?.prompt ?? '') && /Nothing is deleted/.test(c1.body?.confirm?.prompt ?? ''), 'the prompt lists the seats and says nothing is deleted');
  eq(table.getRoom(G6.id)?.state, 'open', 'nothing happened yet');
  const c2 = await call('POST', `/api/rooms/${G6.id}/line`, { text: '/dissolve', confirm: c1.body.confirm.token }, true);
  eq(c2.body?.status, 'applied', 'the confirm token applies it');
  eq(table.getSeat(s6.id).room_id, M5.id, 'the seat returned');
  const c3 = await call('POST', `/api/rooms/${M5.id}/line`, { text: '/dissolve' }, true);
  eq(c3.body?.status, 'refused', '/dissolve in a main room is refused before asking');
} catch (e) {
  failed++;
  console.log(`  ✗ threw: ${(e as Error).stack}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the store still holds the db */ }
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
