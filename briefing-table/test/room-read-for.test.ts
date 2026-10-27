/**
 * room_read's ADDRESSED filter [digest #5] (Owner 2026-10-07): GET /api/rooms/:id/line
 * with `for=<seat id|handle>`, `for=me` (pane-token door) or `for_pane=<paneid>` (the
 * fabric MCP's bearer door) returns only lines addressed to that seat: its stored target
 * (named first, or the lead by default) or any leading @address naming it; never @room
 * lines, facts/deliveries, or the seat's own lines. Forward from `since`, or the newest.
 *
 * SAFETY: a temp table set BEFORE any import; nothing spawns, nothing listens.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-read-for-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_ROOM_TYPE = '0';

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
const same = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

function req(method: string, url: string): any {
  const r = Readable.from([]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: 'Bearer t' };
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
const deps = { projector: async () => (x: any) => x, log: () => {}, human: false };
async function call(url: string): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req('GET', url), resp(out), url.split('?')[0], null, deps as never);
  return out;
}
async function asPane(paneid: string, url: string): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handleAgent(req('GET', url), resp(out), url.split('?')[0], paneid, deps as never);
  return out;
}
const bodies = (r: { body: any }) => (r.body?.entries ?? []).map((e: any) => e.body);

try {
  const U = { actor: 'user' as const };
  for (const a of ['ann', 'bob', 'cat']) {
    table.upsert({ paneid: `recipe:${a}`, recipe_id: null, server: 'local', vendor: 'codex-cli', agent: a, session_id: null, state: 'live' } as never);
  }
  const room = table.createRoom({ name: 'Read For' }, U).result;
  const lead = table.addSeat(room.id, { project: 'ann', handle: 'ann', occupant: 'recipe:ann' } as never, U).result;
  const bob = table.addSeat(room.id, { project: 'bob', handle: 'bob', occupant: 'recipe:bob' } as never, U).result;
  const cat = table.addSeat(room.id, { project: 'cat', handle: 'cat', occupant: 'recipe:cat' } as never, U).result;
  if (table.getRoom(room.id)?.lead_seat !== lead.id) {
    table.updateRoom(room.id, { lead_seat: lead.id }, U);
  }
  const put = (body: string, target: string | null, actor: any = U, kind = 'chat') =>
    table.appendLine(room.id, [{ kind, body, target } as never], actor).entries[0];
  const first = put('@bob do one', 'bob');
  put('everyone, a note', 'room');
  put('to the lead by default', null);
  put('@cat @bob both of you', 'cat');
  put('@bob my own line', 'bob', { actor: { seatId: bob.id } });
  put('the fact', null, U, 'fact');
  put('@cat only cat', 'cat');
  put('@bob do two', 'bob');
  const LINE = `/api/rooms/${room.id}/line`;

  console.log('\n[addressedTo (pure)]');
  const e = (o: Record<string, unknown>) => ({ id: 1, room_id: room.id, ts: 0, kind: 'chat', author: 'user', author_seat: null, target: null, target_seat: null, thread: null, body: '', ref: null, meta: null, ...o }) as never;
  ok(rooms.addressedTo(e({ target: 'bob', target_seat: bob.id }), bob), 'stored target = the seat');
  ok(rooms.addressedTo(e({ target: 'cat', target_seat: cat.id, body: '@cat @Bob, hi' }), bob), 'a later leading @address names it');
  ok(!rooms.addressedTo(e({ target: 'room', body: '@bob x' }), bob), 'never an @room line');
  ok(rooms.addressedTo(e({ target: 'cat', target_seat: cat.id, body: '@cat hi, and (@bob too' }), bob), '[address only] an @bob mid-text addresses it too');
  ok(!rooms.addressedTo(e({ target: 'cat', target_seat: cat.id, body: '@cat see `@bob` in the log' }), bob), '...but not an @bob inside code');
  ok(!rooms.addressedTo(e({ kind: 'delivery', target: 'bob', target_seat: bob.id }), bob), 'never a delivery report');
  ok(!rooms.addressedTo(e({ target: 'bob', target_seat: bob.id, author_seat: bob.id }), bob), 'never its own line');

  console.log('\n[GET line?for=: only the seat\'s lines]');
  let r = await call(`${LINE}?for=bob`);
  same([r.status, bodies(r)], [200, ['@bob do one', '@cat @bob both of you', '@bob do two']], 'for=<handle>: named, named second, not its own, not @room');
  same(r.body?.for, 'bob', '...and says whose');
  r = await call(`${LINE}?for=${lead.id}&since=${first.id}`);
  same(bodies(r), ['to the lead by default'], 'for=<seat id> + since: the lead gets the un-addressed line');
  r = await call(`${LINE}?for_pane=recipe:bob&since=${first.id - 1}&limit=2`);
  same([bodies(r), r.body?.next_since], [['@bob do one', '@cat @bob both of you'], r.body?.entries?.[1]?.id], 'for_pane (the MCP door) + since + limit: a page, with next_since');
  r = await call(`${LINE}?for_pane=recipe:bob&since=${r.body?.next_since}`);
  same(bodies(r), ['@bob do two'], '...the next page from next_since');
  r = await call(`${LINE}?for=bob&limit=1`);
  same(bodies(r), ['@bob do two'], 'no since: the newest addressed line');
  r = await call(`${LINE}?for=nobody`);
  same([r.status, r.body?.field], [400, 'for'], 'an unknown seat is 400 for');
  r = await call(`${LINE}?for=me`);
  same([r.status, r.body?.field], [400, 'for'], 'for=me on the bearer door is 400 (no seat to be)');
  r = await call(`${LINE}?for_pane=recipe:ghost`);
  same([r.status, r.body?.field], [400, 'for_pane'], 'a pane with no seat here is 400 for_pane');

  console.log('\n[pane-token door: for=me]');
  r = await asPane('recipe:cat', `${LINE}?for=me`);
  same([r.status, bodies(r)], [200, ['@cat @bob both of you', '@cat only cat']], 'for=me reads as the pane\'s own seat');
  r = await call(LINE);
  ok(['everyone, a note', 'the fact', '@bob my own line'].every((b) => bodies(r).includes(b)), 'no filter: the whole line, as before');
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* held open */
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
