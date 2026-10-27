/**
 * SEAT PROFILE ROUTE (toolkit [ref] (2)): PATCH /api/rooms/:id/seats/:sid/profile
 * {model?, effort?}, the room-scoped form of PATCH /api/sessions/:paneid/profile for
 * the Workbench seat menu's "Model & effort…". A person only (a bearer is 403), only
 * for a seat of that room, the body limited to {model, effort}; it sets the profile of
 * the pane the seat holds, for the NEXT launch (the seat need not be live).
 *
 * SAFETY: a temp table set BEFORE any import; in-process routes, no engine, no port,
 * nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-seat-profile-'));
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
  table.upsertRecipe({
    id: 'rec-a', name: 'a', target: 'local', projectDir: '/x/a', vendor: 'claude-code', agent: 'a', model: 'opus', resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
  table.upsert({ paneid: 'recipe:rec-a', recipe_id: 'rec-a', server: 'local', vendor: 'claude-code', agent: 'a', session_id: null, state: 'dehydrated', generation: 1 } as never);
  const R = table.createRoom({ name: 'Profile room' }, { actor: 'user' }).result;
  const R2 = table.createRoom({ name: 'Other room' }, { actor: 'user' }).result;
  const seat = table.addSeat(R.id, { recipe_id: 'rec-a', occupant: 'recipe:rec-a' }, { actor: 'user' }).result;
  const empty = table.addSeat(R.id, { handle: 'ghost', policy: 'persistent' } as never, { actor: 'user' }).result;
  const url = `/api/rooms/${R.id}/seats/${seat.id}/profile`;

  console.log('\n[set]');
  const a = await call('PATCH', url, { model: 'sonnet', effort: 'high' });
  ok(a.status === 200 && a.body?.profile?.model === 'sonnet' && a.body.profile.effort === 'high', `model and effort stored (${a.status} ${JSON.stringify(a.body?.profile)})`);
  eq(table.profileOf(table.get('recipe:rec-a'))?.model, 'sonnet', '...on the pane the seat holds (a dehydrated pane: no live session needed)');
  const b = await call('PATCH', url, { effort: 'low' });
  ok(b.status === 200 && b.body?.profile?.model === 'sonnet' && b.body.profile.effort === 'low', 'an absent key keeps its value');
  const c = await call('PATCH', url, { model: '' });
  ok(c.status === 200 && c.body?.profile?.model === null && c.body.profile.effort === 'low', "'' clears one key to the CLI's default");
  const d = await call('PATCH', url, { model: null, effort: null });
  ok(d.status === 200 && d.body?.profile?.model === null && d.body.profile.effort === null, 'null clears both');

  console.log('\n[refused]');
  eq((await call('PATCH', url, { model: 'sonnet' }, false)).status, 403, 'a bearer: 403');
  eq(table.profileOf(table.get('recipe:rec-a'))?.model ?? null, null, '...and it wrote nothing');
  for (const [body, field, what] of [
    [{ model: 'bad model!' }, 'model', 'a model name with a space and a bang'],
    [{ effort: 'ludicrous' }, 'effort', 'an effort the vendor has not got'],
    [{ model: 'sonnet', pane: 'recipe:other' }, 'pane', 'an extra key (a room client never names a pane)'],
    [{ paneid: 'recipe:other' }, 'paneid', 'a paneid'],
    [{}, 'model', 'an empty body'],
  ] as const) {
    const x = await call('PATCH', url, body);
    ok(x.status === 400 && x.body?.field === field, `${what}: 400 field ${x.body?.field}`);
  }
  eq(table.profileOf(table.get('recipe:rec-a'))?.model ?? null, null, '...none of the refused bodies wrote anything');
  const e = await call('PATCH', `/api/rooms/${R2.id}/seats/${seat.id}/profile`, { model: 'sonnet' });
  ok(e.status === 404 && e.body?.field === 'seat', "a seat id under another room: 404 (a room client cannot reach a seat it was not given)");
  const f = await call('PATCH', `/api/rooms/${R.id}/seats/${empty.id}/profile`, { model: 'sonnet' });
  ok(f.status === 409 && f.body?.field === 'seat', 'a seat with no pane: 409 "no session to set a profile on"');
  eq((await call('GET', url)).status === 200, false, 'GET on the profile path is not a route');
} catch (e) {
  ok(false, `threw: ${(e as Error).stack ?? e}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
