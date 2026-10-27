/**
 * CREATE A WORKGROUP, the route (Owner 2026-10-04, item 3):
 * POST /api/rooms/:id/workgroups forms the room, moves the chosen agents, adds
 * the new ones, names the lead (phase 1, all or nothing), then starts the new
 * ones (phase 2, partial failures reported in words). GET .../family-check is
 * the sheet's live "@x is free" answer. In-process, a temp table, a stub
 * launcher: nothing listens, nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-wgcreate-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

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
    console.log(`  X  ${msg}`);
  }
}
const eq = (a: unknown, b: unknown, msg: string): void => ok(Object.is(a, b), `${msg} (got ${JSON.stringify(a)})`);

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  return r;
}
let launches: string[] = [];
const launchBodies: Array<Record<string, unknown>> = [];
let failLaunchFor = '';
async function call(method: string, url: string, body?: unknown, human = true): Promise<{ status: number; body: any }> {
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
  const launch = async (recipeId: string, _b: Record<string, unknown>, onPane: (p: string) => void) => {
    launchBodies.push(_b);
    if (recipeId === failLaunchFor) {
      throw Object.assign(new Error('the broker refused the spawn'), { status: 409 });
    }
    launches.push(recipeId);
    const paneid = `pane-${recipeId}-${launches.length}`;
    onPane(paneid);
    return { ok: true as const, paneid, url: `/p/${paneid}`, path: `/p/${paneid}`, placement: 'tab' };
  };
  await rooms.handle(req(method, url, body), r as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {}, human, launch });
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

try {
  for (const [id, name] of [['a', 'boss'], ['b', 'bee'], ['c', 'cat'], ['n1', 'newone'], ['n2', 'newtwo']]) {
    agent(id, name);
  }
  const M = table.createRoom({ name: 'Main', alias: 'main' }, { actor: 'user' }).result;
  const boss = seat(M.id, 'a', 'boss');
  const bee = seat(M.id, 'b', 'bee');
  const cat = seat(M.id, 'c', 'cat');
  const url = `/api/rooms/${M.id}/workgroups`;

  console.log('\n[family-check]');
  let r = await call('GET', `/api/rooms/${M.id}/family-check?alias=ops&handle=bee&handle=free-one&handle=lead`, undefined, false);
  eq(r.status, 200, 'a bearer (agent) may read the check');
  eq(r.body.alias.free, true, 'a free alias reads free');
  eq(r.body.handles[0].free, false, 'a taken handle reads taken');
  ok(/already taken/.test(r.body.handles[0].reason), '...with the engine words');
  eq(r.body.handles[1].free, true, 'a free handle reads free');
  eq(r.body.handles[2].free, false, 'a reserved handle reads not free');
  r = await call('GET', `/api/rooms/${M.id}/family-check?alias=main`);
  eq(r.body.alias.free, false, 'the main room alias is taken for a workgroup');
  r = await call('GET', `/api/rooms/${M.id}/family-check?alias=boss`);
  eq(r.body.alias.free, false, 'a seat handle is not a free alias');

  console.log('\n[refusals write nothing]');
  r = await call('POST', url, { name: 'Ops', move: [bee.id], lead: { move: bee.id } }, false);
  eq(r.status, 403, 'a bearer cannot create a workgroup (person cookie only)');
  r = await call('POST', url, { name: 'Ops', move: [], start: [], lead: { move: 'x' } });
  eq(r.status, 400, 'no agents is refused');
  r = await call('POST', url, { name: 'Ops', move: [bee.id], lead: { move: cat.id } });
  eq(r.status, 400, 'a lead that is not among the picks is refused');
  r = await call('POST', url, { name: 'Ops', move: [boss.id], lead: { move: boss.id } });
  eq(r.status, 409, 'moving the main lead is the existing 409');
  ok(/hand the lead over first/.test(r.body.error) && /moving @boss/.test(r.body.error), '...in words naming the step and the agent');
  r = await call('POST', url, { name: 'Ops', alias: 'main', move: [bee.id], lead: { move: bee.id } });
  eq(r.status, 409, 'a taken alias is refused (409)');
  r = await call('POST', url, { name: 'Ops', alias: 'ops', move: [bee.id], start: [{ recipe_id: 'n1', handle: 'cat' }], lead: { move: bee.id } });
  eq(r.status, 409, 'a start handle that clashes with the family is refused');
  ok(/adding @cat/.test(r.body.error), '...naming the agent');
  r = await call('POST', url, { name: 'Ops', alias: 'ops', start: [{ recipe_id: 'n1', handle: 'dup' }, { recipe_id: 'n2', handle: 'dup' }], lead: { start: 'n1' } });
  eq(r.status, 409, 'two new agents with one handle are refused');
  eq(table.listWorkgroups(M.id).length, 0, 'every refusal rolled back: no workgroup exists');
  eq(table.listSeats(M.id).length, 3, '...and the main room still holds its three seats');
  eq(launches.length, 0, '...and nothing was launched');

  console.log('\n[create: move + start + lead]');
  r = await call('POST', url, {
    name: 'Ops', alias: 'ops', color: '#1F8FA6',
    move: [bee.id, cat.id],
    start: [{ recipe_id: 'n1', handle: 'newone-ops' }, { recipe_id: 'n2' }],
    lead: { start: 'n1' },
  });
  eq(r.status, 200, 'create answers 200');
  eq(r.body.ok, true, 'no problems');
  const wg = r.body.room;
  eq(wg.parent_id, M.id, 'the workgroup sits under the main room');
  eq(wg.alias, 'ops', 'with its alias');
  eq(wg.color, '#1f8fa6', 'and its color');
  const wseats = table.listSeats(wg.id);
  eq(wseats.length, 4, 'four seats in the workgroup');
  eq(wseats.find((s: any) => s.handle === 'bee')?.id, bee.id, 'a moved seat keeps its id (same session)');
  eq(table.listSeats(M.id).map((s: any) => s.handle).join(','), 'boss', 'the main room keeps only its lead');
  eq(table.getRoom(wg.id)?.lead_seat, wseats.find((s: any) => s.handle === 'newone-ops')?.id, 'the lead is the one named (a new agent)');
  eq(r.body.lead, 'newone-ops', 'the answer names the lead');
  eq(launches.join(','), 'n1,n2', 'both new agents were started, fresh');
  ok(r.body.started.every((x: any) => x.ok), 'each start reports ok');
  ok(wseats.some((s: any) => s.handle === 'newtwo'), 'a start with no handle derives one from its project');
  ok(launchBodies.length > 0 && launchBodies.every((b) => b.surface === 'browser' && b.target === 'tab'), 'new agents start headless: no window opens on the desktop (Owner 2026-10-05)');

  console.log('\n[lead may be a moved agent]');
  agent('d', 'dee');
  const dee = seat(M.id, 'd', 'dee');
  r = await call('POST', url, { name: 'Two', move: [dee.id], lead: { move: dee.id } });
  eq(r.status, 200, 'a move-only workgroup is fine');
  eq(table.getRoom(r.body.room.id)?.lead_seat, dee.id, 'the moved agent leads');
  eq(r.body.room.alias, 'two', 'no typed alias: derived from the name');

  console.log('\n[partial failure is reported in words]');
  agent('e', 'eee');
  const eee = seat(M.id, 'e', 'eee');
  launches = [];
  failLaunchFor = 'n2';
  r = await call('POST', url, {
    name: 'Three', alias: 'three', move: [eee.id],
    start: [{ recipe_id: 'n1', handle: 'n1-three' }, { recipe_id: 'n2', handle: 'n2-three' }],
    lead: { move: eee.id },
  });
  eq(r.status, 200, 'the workgroup stands (200)');
  eq(r.body.partial, true, 'flagged partial');
  eq(r.body.problems.length, 1, 'exactly one problem');
  ok(/starting @n2-three failed: the broker refused the spawn/.test(r.body.problems[0]), 'it names the step, the agent and the reason');
  eq(r.body.started.find((x: any) => x.handle === 'n1-three')?.ok, true, 'the other start went through');
  ok(table.listSeats(r.body.room.id).some((s: any) => s.handle === 'n2-three'), 'the unstarted seat is in the workgroup, never-started');

  console.log('\n[a workgroup cannot hold one]');
  r = await call('POST', `/api/rooms/${wg.id}/workgroups`, { name: 'Deep', move: [bee.id], lead: { move: bee.id } });
  eq(r.status, 409, 'workgroups are made under the main room only');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM) */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
