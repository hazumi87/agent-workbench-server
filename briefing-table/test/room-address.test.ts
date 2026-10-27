/**
 * ADDRESSING: a line reaches ONLY who it names [address only] (Owner 2026-10-07,
 * room interface; the trigger was a line in Asset Studio, "I had to halt…
 * @other-builder can you…", which went to the lead AND the operator).
 *
 * Route level, in process (the room-reply pattern): who is TYPED, and how the line
 * is STORED (target / target_seat).
 *   - a seat named mid-text only: that seat, not the lead;
 *   - two names: both;
 *   - no names: the lead while unaddressedToLead is on (default), nobody when off
 *     (the line is still written, with no seat);
 *   - @room: everyone; an @name in backticks or an email: not an address;
 *   - an agent's line through the pane-token door follows the same rule;
 *   - a seat of a WORKGROUP named mid-text from the main room still resolves.
 *
 * SAFETY: a temp table set BEFORE any import; no fabric; nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-address-'));
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
async function call(method: string, url: string, body?: unknown, human = false): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, url, body), resp(out), url.split('?')[0], null, deps(human));
  return out;
}
async function asPane(paneid: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handleAgent(req(method, url, body), resp(out), url.split('?')[0], paneid, deps(false));
  return out;
}

try {
  const writes: Record<string, string[]> = {};
  const pane = (a: string) => `recipe:rec-${a}`;
  for (const a of ['boss', 'worker', 'operator', 'wgseat']) {
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
  const R = table.createRoom({ name: 'Asset Studio', alias: 'studio' }, { actor: 'user' }).result;
  const seat: Record<string, any> = {};
  for (const a of ['boss', 'worker', 'operator']) {
    seat[a] = table.addSeat(R.id, { recipe_id: `rec-${a}`, occupant: pane(a) }, { actor: 'user' }).result;
  }
  if (table.getRoom(R.id)?.lead_seat !== seat.boss.id) {
    table.updateRoom(R.id, { lead_seat: seat.boss.id }, { actor: 'user' });
  }
  const WG = table.createRoom({ name: 'Blender', parent_id: R.id, alias: 'blender' }, { actor: 'user' }).result;
  seat.wgseat = table.addSeat(WG.id, { recipe_id: 'rec-wgseat', occupant: pane('wgseat') }, { actor: 'user' }).result;
  const LINE = `/api/rooms/${R.id}/line`;
  const idleAll = () => {
    for (const a of ['boss', 'worker', 'operator', 'wgseat']) {
      activity.onTurnStart(pane(a));
      activity.onResponseDone(pane(a));
      writes[pane(a)] = [];
    }
  };
  const typedTo = async (marker: string): Promise<string[]> => {
    await sleep(250);
    return ['boss', 'worker', 'operator', 'wgseat'].filter((a) => writes[pane(a)].join('').includes(marker));
  };
  const entry = (r: any) => r.body?.entries?.[0] ?? {};
  const handleOf = (id: string | null) => (id ? table.getSeat(id)?.handle : null);

  console.log('\n[a seat named mid-text only: that seat, NOT the lead (a line)]');
  idleAll();
  let r = await call('POST', LINE, { text: 'I had to halt the run (m1). @operator can you check the cuff?' }, true);
  eq(r.status, 200, 'posted');
  eq(await typedTo('(m1)'), ['operator'], 'typed into the operator only');
  eq([entry(r).target, handleOf(entry(r).target_seat)], ['operator', 'operator'], 'stored as addressed to the operator');

  console.log('\n[two names: both]');
  idleAll();
  r = await call('POST', LINE, { text: 'please have @worker and @operator compare (m2)' }, true);
  eq(await typedTo('(m2)'), ['worker', 'operator'], 'both named seats, not the lead');

  console.log('\n[no names: the lead (unaddressedToLead on, the default)]');
  idleAll();
  r = await call('POST', LINE, { text: 'what is the status (m3)' }, true);
  eq(await typedTo('(m3)'), ['boss'], 'the lead');
  eq([entry(r).target, handleOf(entry(r).target_seat)], [null, 'boss'], 'stored as the lead default');

  console.log('\n[no names, unaddressedToLead off: written, delivered to nobody]');
  table.setEngineSetting('agentComms', { unaddressedToLead: false });
  idleAll();
  r = await call('POST', LINE, { text: 'just thinking out loud (m4)' }, true);
  eq(r.status, 200, 'posted');
  eq(await typedTo('(m4)'), [], 'typed nowhere');
  eq([entry(r).body, entry(r).target, entry(r).target_seat], ['just thinking out loud (m4)', null, null], 'written to the room with no seat (never the lead)');
  idleAll();
  r = await asPane(pane('worker'), 'POST', LINE, { text: 'note to self, the export is slow (m5)' });
  eq([r.status, await typedTo('(m5)')], [200, []], "an agent's unaddressed line (room_post): delivered to nobody too");
  table.setEngineSetting('agentComms', null);

  console.log('\n[@room, backticks, email]');
  idleAll();
  r = await call('POST', LINE, { text: '@room heads up (m6)' }, true);
  eq(await typedTo('(m6)'), ['boss', 'worker', 'operator'], '@room: everyone in the room');
  idleAll();
  r = await call('POST', LINE, { text: 'run `ping @operator` when ready (m7)' }, true);
  eq(await typedTo('(m7)'), ['boss'], 'a backticked @name is quoted: nobody named, so the lead');
  idleAll();
  r = await call('POST', LINE, { text: 'mail noreply@example.com about it (m8)' }, true);
  eq(await typedTo('(m8)'), ['boss'], 'an email is not an address: the lead');

  console.log('\n[an agent line (pane-token door) follows the same rule]');
  idleAll();
  r = await asPane(pane('boss'), 'POST', LINE, { text: 'Astra reported the palm (m9); @worker please export it' });
  eq([r.status, await typedTo('(m9)')], [200, ['worker']], "the lead names the worker mid-text: only the worker (never the lead's own pane)");

  console.log('\n[family: a workgroup seat named mid-text from the main room]');
  idleAll();
  r = await call('POST', LINE, { text: 'when ready, @wgseat take the rig (m10)' }, true);
  eq(await typedTo('(m10)'), ['wgseat'], 'resolved across the family, delivered there only');
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error).stack}`);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows: the store's own handle still holds the db open (EPERM); the temp dir is left behind */
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
