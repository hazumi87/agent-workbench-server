/**
 * ADDRESS RULES THROUGH THE POST ROUTE (Owner [ref]/[ref]/[ref], toolkit [ref]/[ref]):
 *   - quoted text does not address (so a seat named only in quotes is not woken);
 *   - an agent's "@user" is stored as the person's handle, outside code and quotes;
 *   - an agent line that names nobody is stored "to me" (meta.to_user) and still goes to the lead.
 * In-process (postLineAs), no engine, no port. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-address-routes-'));
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


const D = deps(false);
const meta = (e: any) => (typeof e?.meta === 'string' ? JSON.parse(e.meta) : (e?.meta ?? {}));

try {
  for (const [id, agent] of [['rec-lead', 'chief'], ['rec-bee', 'bee'], ['rec-ant', 'ant']]) {
    table.upsertRecipe({
      id, name: agent, target: 'local', projectDir: `/x/${agent}`, vendor: 'claude-code', agent, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
    table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent, session_id: null, state: 'live', generation: 1 } as never);
  }
  const R = table.createRoom({ name: 'Address room' }, { actor: 'user' }).result;
  const lead = table.addSeat(R.id, { recipe_id: 'rec-lead', occupant: 'recipe:rec-lead', handle: 'chief' } as never, { actor: 'user' }).result;
  const bee = table.addSeat(R.id, { recipe_id: 'rec-bee', occupant: 'recipe:rec-bee', handle: 'bee' } as never, { actor: 'user' }).result;
  const ant = table.addSeat(R.id, { recipe_id: 'rec-ant', occupant: 'recipe:rec-ant', handle: 'ant' } as never, { actor: 'user' }).result;
  const as = (seat: any, text: string, userHandle = 'owner') => {
    const r: any = rooms.postLineAs(R, { seatId: seat.id } as never, text, { userHandle }, D as never);
    const e = r.entries?.[0];
    return { r, e, m: meta(e), to: (r.deliveries ?? []).map((d: any) => d.handle ?? d.seat) };
  };

  console.log('\n[@user becomes the person\'s handle]');
  let x = as(bee, '@user pong: ping');
  ok(x.e?.body === '@owner pong: ping', `stored as "@owner pong: ping" (${JSON.stringify(x.e?.body)})`);
  ok(x.m.to_user === true, '...and it is still addressed to the person');
  x = as(bee, 'he said "@user ping" and `@user` too');
  ok(x.e?.body === 'he said "@user ping" and `@user` too', 'a quoted or backticked @user stays as typed');
  x = as(bee, '@user pong: ping', 'user');
  ok(x.e?.body === '@user pong: ping', "a person with no handle of their own (the default 'user'): unchanged");
  const person = rooms.postLineAs(R, 'user' as never, '@user hello', { userHandle: 'owner' }, D as never) as any;
  ok(person.entries?.[0]?.body === '@user hello', "the person's own line is never rewritten");

  console.log('\n[quotes do not address a seat]');
  x = as(bee, 'tell "@ant" later');
  ok(!x.to.includes('ant') && !x.to.includes(ant.id), 'a seat named only inside quotes is not delivered to');
  x = as(bee, '@ant please look');
  ok(x.to.some((h: string) => h === 'ant' || h === ant.id) || x.e?.target === 'ant', 'the same seat named plainly is addressed');

  console.log('\n[an agent line that names nobody is to the person]');
  x = as(bee, 'status: the build is green');
  ok(x.m.to_user === true, 'stored with meta.to_user');
  ok(x.e?.target === 'chief' || x.e?.target_seat === lead.id, '...and still addressed to the lead (delivery unchanged)');
  x = as(bee, 'done, see the "@ant" example');
  ok(x.m.to_user === true, 'quotes and code are stripped first: only a quoted name is still "names nobody"');
  x = as(bee, '@ant a plain address to a seat');
  ok(x.m.to_user !== true, 'a line that names a seat is not to the person');
  x = as(lead, 'no address from the chief');
  ok(x.m.to_user === true, "the lead's un-addressed line is to the person too");
  const own = rooms.postLineAs(R, 'user' as never, 'a plain line from the person', { userHandle: 'owner' }, D as never) as any;
  ok(own.entries?.[0] && meta(own.entries[0]).to_user !== true && (own.entries[0].target === 'chief' || own.entries[0].target_seat === lead.id), "the person's own un-addressed line is not flagged and the lead picks it up");
} catch (e) {
  ok(false, `threw: ${(e as Error).stack ?? e}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
