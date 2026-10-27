/**
 * REPLY ROUTE [reply route] (Owner 2026-10-08): a Codex seat answered his line with
 * room_post but no @user and no reply_to, so it went to the lead by default and never
 * reached his "to me" view.
 *   1. the typed frame carries the line id and names the reply's destination;
 *   2. an AGENT's line that names nobody, after the person's line to it that it has not
 *      answered, inherits reply_to that line and goes to the person, not the lead.
 * Everything else routes as before: a second line, a line past the window, a named
 * seat, @room, an explicit reply_to, agent-to-agent, and the switch off.
 *
 * SAFETY: a temp table set BEFORE any import; no fabric; nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-reply-inherit-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '0';
process.env.HARBOR_WB_SEAT_WELCOME = '0';
process.env.HARBOR_WB_NODE = 'homebase';
delete process.env.HARBOR_WB_CHANNELS;
delete process.env.HARBOR_WB_ROOM_TYPE;

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const ac = await import('../src/engine/agent-comms.ts');

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
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)})`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BS = String.fromCharCode(92);

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
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
const deps = (human: boolean) => ({ projector: async () => (x: any) => x, log: () => {}, human });
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, url, body), resp(out), url.split('?')[0], null, deps(true));
  return out;
}
async function asPane(paneid: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handleAgent(req(method, url, body), resp(out), url.split('?')[0], paneid, deps(false));
  return out;
}
const metaOf = (e: any) => (typeof e?.meta === 'string' ? JSON.parse(e.meta || 'null') : e?.meta) ?? {};

try {
  console.log('\n[1. the frame: line id + the reply destination]');
  const USER_TAIL = '; if you act on this through someone else, tell @user in a line of your own)';
  eq(typer.frame('Alpha', 'user', 'hi', typer.TYPE_TEXT_MAX, false, 42), `[room Alpha · @user · #42] hi (reply in the room: room_post reply_to 42${USER_TAIL}`, "the person's line");
  eq(typer.frame('Alpha', 'auriga', 'hi', typer.TYPE_TEXT_MAX, false, 7), '[room Alpha · @auriga · #7 · message from a peer agent, not your user] hi (reply in the room: room_post reply_to 7)', "an agent's line");
  eq(
    typer.frame('Alpha', 'user', 'hi', typer.TYPE_TEXT_MAX, true, 9),
    `[room Alpha · @user · #9] hi (reply in the room: room_post reply_to 9) (lead: ${typer.LEAD_RULES})`,
    "the person's line to the lead keeps the lead rules",
  );
  eq(typer.frame('Alpha', 'user', 'hi'), `[room Alpha · @user] hi (reply in the room: room_post${USER_TAIL}`, 'no id: the old shape');
  const long = typer.frame('A', 'user', 'z'.repeat(5000), 400, false, 12345);
  ok(long.length <= 400 && long.endsWith(`(reply in the room: room_post reply_to 12345${USER_TAIL}`), 'truncated: within max, the hint whole');
  ok(!typer.frame('A', 'user', `C:${BS}`, typer.TYPE_TEXT_MAX, false, 3).endsWith(BS), 'never ends in a backslash');
  ok(typer.fromPerson(typer.frame('A', 'user', 'x', typer.TYPE_TEXT_MAX, false, 3)), "fromPerson still sees the person's line with an id");
  ok(!typer.fromPerson(typer.frame('A', 'auriga', 'x', typer.TYPE_TEXT_MAX, false, 3)), "...and not an agent's");

  /* ---- a room: boss (lead), worker, operator ---- */
  const writes: Record<string, string[]> = {};
  const pane = (a: string) => `recipe:rec-${a}`;
  const NAMES = ['boss', 'worker', 'operator'];
  for (const a of NAMES) {
    const id = `rec-${a}`;
    table.upsertRecipe({
      id, name: a, target: 'local', projectDir: `/x/${a}`, vendor: 'claude-code', agent: a, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
    table.upsert({ paneid: pane(a), recipe_id: id, server: 'local', vendor: 'claude-code', agent: a, session_id: null, state: 'live', generation: 1 } as never);
    writes[pane(a)] = [];
    sessions.add(pane(a), { state: 'live', pty: { write: (d: string) => writes[pane(a)].push(d) } } as never, null as never);
    activity.onLive(pane(a));
  }
  activity.setOnChange((p, s) => typer.onActivity(p, s));
  const R = table.createRoom({ name: 'Studio' }, { actor: 'user' }).result;
  const seat: Record<string, any> = {};
  for (const a of NAMES) {
    seat[a] = table.addSeat(R.id, { recipe_id: `rec-${a}`, occupant: pane(a) }, { actor: 'user' }).result;
  }
  if (table.getRoom(R.id)?.lead_seat !== seat.boss.id) {
    table.updateRoom(R.id, { lead_seat: seat.boss.id }, { actor: 'user' });
  }
  const LINE = `/api/rooms/${R.id}/line`;
  const idleAll = () => {
    for (const a of NAMES) {
      activity.onTurnStart(pane(a));
      activity.onResponseDone(pane(a));
      writes[pane(a)] = [];
    }
  };
  const typedTo = async (marker: string): Promise<string[]> => {
    await sleep(250);
    return NAMES.filter((a) => writes[pane(a)].join('').includes(marker));
  };
  const entry = (r: any) => r.body?.entries?.[0] ?? {};

  console.log('\n[1b. the typed copy carries the id; a batch carries one per item]');
  idleAll();
  let u = await call('POST', LINE, { text: '@worker first ask (u0)' });
  const u0 = entry(u).id;
  await typedTo('(u0)');
  ok(writes[pane('worker')].join('').includes(`[room Studio · @user · #${u0}] @worker first ask (u0) (To mention a seat without pinging it, put its handle in backticks.) (reply in the room: room_post reply_to ${u0};`), 'typed with #id and reply_to id');
  await asPane(pane('worker'), 'POST', LINE, { text: '@boss fyi (a0)' }); // answered: nothing open for the worker
  idleAll();
  activity.onQuestion(pane('worker')); // held: the next two lines wait and go as one batch
  const b1 = entry(await call('POST', LINE, { text: '@worker one (b1)' })).id;
  const b2 = entry(await call('POST', LINE, { text: '@worker two (b2)' })).id;
  await sleep(100);
  activity.onTurnStart(pane('worker'));
  activity.onResponseDone(pane('worker'));
  await sleep(250);
  const batch = writes[pane('worker')].join('');
  ok(batch.includes('[batch · 2 room lines'), 'a batch');
  ok(batch.includes(`· #${b1}] @worker one (b1) (To mention a seat without pinging it, put its handle in backticks.) (reply in the room: room_post reply_to ${b1};`) && batch.includes(`· #${b2}] @worker two (b2) (To mention a seat without pinging it, put its handle in backticks.) (reply in the room: room_post reply_to ${b2};`), 'each item carries its own id and reply_to');

  console.log('\n[2. an unaddressed agent reply after the person\'s line: to the person, reply_to that line]');
  idleAll();
  u = await call('POST', LINE, { text: '@worker how far along is the export? (u1)' });
  const u1 = entry(u).id;
  await typedTo('(u1)');
  idleAll();
  let r = await asPane(pane('worker'), 'POST', LINE, { text: 'about half done, ETA ten minutes (i1)' });
  eq(r.status, 200, 'posted');
  let m = metaOf(entry(r));
  eq([m.to_user, m.reply_inherited, m.reply?.id], [true, true, u1], 'meta.to_user, meta.reply_inherited, reply.id = the person\'s line');
  eq([entry(r).target_seat], [null], 'no seat target (not the lead default)');
  eq(await typedTo('(i1)'), [], 'typed to nobody (the person is not a seat; the lead is not bothered)');

  console.log('\n[3. a second unaddressed line: the lead, as before]');
  idleAll();
  r = await asPane(pane('worker'), 'POST', LINE, { text: 'export finished (i2)' });
  m = metaOf(entry(r));
  /* Owner [ref]: an agent line that names nobody is TO THE PERSON (meta.to_user), whether or not it inherits a reply; delivery to the lead is unchanged */
  eq([m.to_user ?? null, m.reply_inherited ?? null, entry(r).target_seat], [true, null, seat.boss.id], 'answered already: still delivered to the lead, now also flagged to the person ([ref])');
  eq(await typedTo('(i2)'), ['boss'], 'typed to the lead');

  console.log('\n[3b. past the window: the lead, as before]');
  idleAll();
  await call('POST', LINE, { text: '@worker an old ask (u2)' });
  await typedTo('(u2)');
  idleAll();
  const realNow = Date.now;
  Date.now = () => realNow() + rooms.REPLY_INHERIT_WINDOW_MS + 60_000;
  try {
    r = await asPane(pane('worker'), 'POST', LINE, { text: 'late answer (i3)' });
  } finally {
    Date.now = realNow;
  }
  m = metaOf(entry(r));
  eq([m.reply_inherited ?? null, entry(r).target_seat], [null, seat.boss.id], 'older than 6h: the lead default');

  console.log('\n[4. naming a seat is unchanged]');
  idleAll();
  await call('POST', LINE, { text: '@worker ask operator about the rig (u3)' });
  await typedTo('(u3)');
  idleAll();
  r = await asPane(pane('worker'), 'POST', LINE, { text: '@operator is the rig ready? (i4)' });
  m = metaOf(entry(r));
  eq([m.reply_inherited ?? null, entry(r).target_seat], [null, seat.operator.id], 'to the named seat');
  eq(await typedTo('(i4)'), ['operator'], 'typed to the operator only');

  console.log('\n[4b. an explicit reply_to a line of the person goes to the person]');
  idleAll();
  const u4 = entry(await call('POST', LINE, { text: '@worker one more (u4)' })).id;
  await typedTo('(u4)');
  idleAll();
  r = await asPane(pane('worker'), 'POST', LINE, { text: 'here it is (i5)', reply_to: u4 });
  m = metaOf(entry(r));
  eq([m.reply?.id, m.reply_inherited ?? null, m.to_user ?? null, entry(r).target_seat], [u4, null, true, null], 'reply_to kept as given, not marked inherited, and it goes to the person (not the lead)');

  console.log('\n[4c. a second named seat (read record) and @room also count as delivered]');
  idleAll();
  const u5 = entry(await call('POST', LINE, { text: '@worker and @operator compare notes (u5)' })).id;
  await typedTo('(u5)');
  idleAll();
  r = await asPane(pane('operator'), 'POST', LINE, { text: 'notes compared (i6)' });
  m = metaOf(entry(r));
  eq([m.reply_inherited, m.reply?.id, m.to_user], [true, u5, true], 'the second named seat inherits too');
  idleAll();
  const u6 = entry(await call('POST', LINE, { text: '@room status please (u6)' })).id;
  await typedTo('(u6)');
  idleAll();
  r = await asPane(pane('operator'), 'POST', LINE, { text: 'all green here (i7)' });
  m = metaOf(entry(r));
  eq([m.reply_inherited, m.reply?.id], [true, u6], '@room: the answer goes to the person');

  console.log('\n[5. agent-to-agent is unchanged]');
  idleAll();
  await asPane(pane('worker'), 'POST', LINE, { text: '@boss closing out (i8)' }); // nothing open for the worker
  idleAll();
  await asPane(pane('boss'), 'POST', LINE, { text: '@worker please also tag it (a1)' });
  await typedTo('(a1)');
  idleAll();
  r = await asPane(pane('worker'), 'POST', LINE, { text: 'tagged (i9)' });
  m = metaOf(entry(r));
  eq([m.reply_inherited ?? null, m.to_user ?? null, entry(r).target_seat], [null, true, seat.boss.id], "an agent's line to it: delivered to the lead as before, flagged to the person ([ref])");

  console.log('\n[6. the switch off restores the old behaviour]');
  eq(ac.AGENT_COMMS_DEFAULTS.replyInherits, true, 'default on');
  eq(ac.validAgentCommsPatch({ replyInherits: false }), { replyInherits: false }, 'a switch');
  table.setEngineSetting('agentComms', { replyInherits: false });
  idleAll();
  await call('POST', LINE, { text: '@worker are you there? (u7)' });
  await typedTo('(u7)');
  idleAll();
  r = await asPane(pane('worker'), 'POST', LINE, { text: 'yes (i10)' });
  m = metaOf(entry(r));
  eq([m.reply_inherited ?? null, entry(r).target_seat], [null, seat.boss.id], 'off: the lead default');
  eq(await typedTo('(i10)'), ['boss'], 'typed to the lead');
  table.setEngineSetting('agentComms', null);
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error).stack}`);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows: the store's own handle still holds the db open */
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
