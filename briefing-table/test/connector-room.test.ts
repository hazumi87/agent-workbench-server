/**
 * A connector-owned seat: a room line is ONE canonical submission and is never typed into the pane
 * (ticket). Disabled path: no connector is called. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-connector-room-'));
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
  for (const a of ['boss', 'codexer']) {
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
  const R = table.createRoom({ name: 'Connector room' }, { actor: 'user' }).result;
  const boss = table.addSeat(R.id, { recipe_id: 'rec-boss', occupant: pane('boss') }, { actor: 'user' }).result;
  const cx = table.addSeat(R.id, { recipe_id: 'rec-codexer', occupant: pane('codexer') }, { actor: 'user' }).result;
  table.updateRoom(R.id, { lead_seat: boss.id }, { actor: 'user' });
  const LINE = `/api/rooms/${R.id}/line`;
  for (const a of ['boss', 'codexer']) {
    activity.onTurnStart(pane(a));
    activity.onResponseDone(pane(a));
  }

  console.log('\n[an unbound seat is typed as always]');
  writes[pane('codexer')] = [];
  let r = await call('POST', LINE, { text: `@${cx.handle} plain line (m1)` }, true);
  await sleep(250);
  ok(writes[pane('codexer')].join('').includes('(m1)'), 'typed into the pane');
  await sleep(1500); // let its submit key land before the next case clears the log

  console.log('\n[the seat is now connector-owned]');
  table.createConnectorBinding('rt-room', pane('codexer'));
  writes[pane('codexer')] = [];
  r = await call('POST', LINE, { text: `@${cx.handle} owned line (m2)` }, true);
  await sleep(250);
  eq(r.status, 200, 'posted');
  eq(writes[pane('codexer')].join(''), '', 'NOTHING is typed into the pane (the connector is its only writer)');
  const d = (r.body?.deliveries ?? [])[0];
  eq([d?.delivered, d?.queued], [false, false], 'reported as held, not delivered');
  const e = r.body?.entries?.[0];
  eq(table.recordConnectorSubmission('rt-room', `room:${R.id}:line:${e.id}:seat:${cx.id}`, 'x'), 'conflict', 'the line was recorded as ONE canonical submission (same id, other content conflicts)');
  eq(e.reads?.[cx.handle], 'unknown', 'the read record says the connector holds it, not "seen"');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the db is still open on Windows */ }
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
