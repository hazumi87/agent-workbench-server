/**
 * WAKE AND DELIVER [wake deliver] (Owner 2026-10-07, room interface; Agent comms `personWakes`,
 * default on).
 *   - the PERSON's line to a disconnected (restorable) seat wakes it; the line is typed
 *     once the CLI is ready, exactly once; the read state goes waking -> not-yet (delivered);
 *   - switch off: not delivered, the report offers `action: 'wake-deliver'`; the button
 *     (POST .../seats/:seatId/wake-deliver {lineId}) wakes and delivers it;
 *   - no session to restore: "not-delivered: @x is disconnected", reason no-session; the
 *     button answers 409;
 *   - the wake fails: a delivery fact "not-delivered: …" with reason wake-failed and the
 *     wake action, read state unknown;
 *   - an AGENT's line keeps today's rules (no wake while leadsWakeMembers is off);
 *   - the button is a person's only.
 * SAFETY: a temp table set BEFORE any import; a fake /pty socket on P(425); a fake launcher.
 * Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { P, assertFree } from './_scratch.mjs';

const SOCK_PORT = P(425);
await assertFree(SOCK_PORT, 'wake-deliver.test.ts');
const dir = mkdtempSync(join(tmpdir(), 'wb-wake-deliver-'));
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
const reads = await import('../src/engine/room-reads.ts');

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
const eq = (a: unknown, b: unknown, m: string): void => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await sleep(25);
  return fn();
}
function req(method: string, url: string, body?: unknown, bearer = false): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer t' } : {}) };
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
async function call(method: string, url: string, body?: unknown, human = true): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, url, body, !human), resp(out), url.split('?')[0], null, deps(human) as any);
  return out;
}
async function asPane(paneid: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handleAgent(req(method, url, body), resp(out), url.split('?')[0], paneid, deps(false) as any);
  return out;
}

const writes: Record<string, string[]> = {};
const pane = (a: string) => `recipe:rec-${a}`;
function goLive(a: string): void {
  table.upsert({ paneid: pane(a), recipe_id: `rec-${a}`, server: 'local', vendor: 'claude-code', agent: a, session_id: null, state: 'live', generation: 1 } as never);
  writes[pane(a)] ??= [];
  sessions.add(pane(a), { state: 'live', pty: { write: (d: string) => writes[pane(a)].push(d) } } as never, null as never);
  activity.onLive(pane(a));
}
async function disconnect(a: string): Promise<void> {
  table.upsert({ ...(table.get(pane(a)) as any), state: 'dehydrated' });
  sessions.remove(pane(a));
  activity.drop(pane(a));
}
const wss = new WebSocketServer({ port: SOCK_PORT, host: '127.0.0.1' });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'attach') ws.send(JSON.stringify({ type: 'pane.ready', paneid: m.paneid }));
  });
});
let failLaunch = false;
rooms.setStartDeps({
  launch: async (recipeId: string, body: any, onPane?: (p: string) => void) => {
    await sleep(150);
    if (failLaunch) throw new Error('launch refused (test)');
    const p = typeof body?.pane === 'string' ? body.pane : `recipe:${recipeId}`;
    goLive(p.slice('recipe:rec-'.length));
    onPane?.(p);
    return { ok: true, paneid: p, url: '', path: '', placement: 'tab' };
  },
  endForCycle: async () => ({ ended: true, state: 'dehydrated' }),
  socketUrl: () => `ws://127.0.0.1:${SOCK_PORT}/pty`,
  socketToken: () => 't',
  needsYou: () => null,
  ready: () => true,
} as never);

try {
  for (const a of ['boss', 'worker', 'ghost']) {
    table.upsertRecipe({
      id: `rec-${a}`, name: a, target: 'local', projectDir: `/x/${a}`, vendor: 'claude-code', agent: a, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
  }
  goLive('boss');
  goLive('worker');
  activity.setOnChange((p, s) => typer.onActivity(p, s));
  const R = table.createRoom({ name: 'Studio' }, { actor: 'user' }).result;
  const sb = table.addSeat(R.id, { recipe_id: 'rec-boss', occupant: pane('boss') }, { actor: 'user' }).result;
  const sw = table.addSeat(R.id, { recipe_id: 'rec-worker', occupant: pane('worker') }, { actor: 'user' }).result;
  const sg = table.addSeat(R.id, { recipe_id: 'rec-ghost' }, { actor: 'user' }).result; // never started: nothing to restore
  if (table.getRoom(R.id)?.lead_seat !== sb.id) table.updateRoom(R.id, { lead_seat: sb.id }, { actor: 'user' });
  const LINE = `/api/rooms/${R.id}/line`;
  const report = (r: any) => r.body.entries.find((e: any) => e.kind === 'delivery');
  const meta = (e: any) => (typeof e?.meta === 'string' ? JSON.parse(e.meta) : e?.meta);
  const readOf = (entryId: number, handle: string) => reads.readsFor({ id: entryId, room_id: R.id } as any)?.[handle];

  console.log('\n[the person\'s line to a disconnected seat: woken, delivered once, waking -> delivered]');
  await disconnect('worker');
  writes[pane('worker')] = [];
  let r = await call('POST', LINE, { text: '@worker please export the hand (w1)' });
  eq(r.status, 200, 'posted');
  const d1 = report(r);
  ok(d1?.body.includes('is disconnected — waking it') && meta(d1).reason === 'waking', `the report says it is waking (${d1?.body})`);
  const id1 = r.body.entries[0].id;
  eq(readOf(id1, 'worker'), 'waking', "read state 'waking'");
  ok(await until(() => writes[pane('worker')].join('').includes('(w1)')), 'typed into the woken pane');
  await sleep(300);
  eq(writes[pane('worker')].join('').split('(w1)').length - 1, 1, '...exactly once');
  ok(['not-yet', 'unknown', 'seen'].includes(String(readOf(id1, 'worker'))) && readOf(id1, 'worker') !== 'waking', `then delivered (${readOf(id1, 'worker')})`);

  console.log('\n[switch off: not delivered, a wake action; the button wakes and delivers]');
  table.setEngineSetting('agentComms', { personWakes: false });
  await disconnect('worker');
  writes[pane('worker')] = [];
  r = await call('POST', LINE, { text: '@worker the cuff numbers please (w2)' });
  const d2 = report(r);
  eq([meta(d2).reason, meta(d2).action, meta(d2).delivered], ['disconnected', 'wake-deliver', false], 'reason disconnected, action wake-deliver');
  await sleep(400);
  ok(!writes[pane('worker')].join('').includes('(w2)'), 'not typed');
  const id2 = r.body.entries[0].id;
  const btn = `/api/rooms/${R.id}/seats/${sw.id}/wake-deliver`;
  eq((await call('POST', btn, { lineId: id2 }, false)).status, 403, 'the button: a bearer is refused');
  const w = await call('POST', btn, { lineId: id2 });
  eq([w.status, w.body?.state], [200, 'waking'], 'the button: waking');
  eq(readOf(id2, 'worker'), 'waking', "read state 'waking' (was unknown)");
  ok(await until(() => writes[pane('worker')].join('').includes('(w2)')), 'then typed');
  eq((await call('POST', btn, { lineId: 999999 })).body?.field, 'lineId', 'a line of another room / no line: 400');
  table.setEngineSetting('agentComms', null);

  console.log('\n[the button on a live seat: delivered now]');
  writes[pane('worker')] = [];
  activity.onTurnStart(pane('worker'));
  activity.onResponseDone(pane('worker'));
  const live = await call('POST', btn, { lineId: id2 });
  eq([live.status, live.body?.state], [200, 'delivered'], 'state delivered');

  console.log('\n[nothing to restore: said plainly; the button 409]');
  r = await call('POST', LINE, { text: '@ghost are you there (w3)' });
  const d3 = report(r);
  ok(d3?.body === 'not-delivered: @ghost is disconnected (no session to restore)' && meta(d3).reason === 'no-session' && !meta(d3).action, `no-session, no action (${d3?.body})`);
  eq((await call('POST', `/api/rooms/${R.id}/seats/${sg.id}/wake-deliver`, { lineId: r.body.entries[0].id })).status, 409, 'the button: 409');

  console.log('\n[the wake fails: a not-delivered fact with the wake action]');
  failLaunch = true;
  await disconnect('worker');
  r = await call('POST', LINE, { text: '@worker one more thing (w4)' });
  const id4 = r.body.entries[0].id;
  let fact: any = null;
  await until(() => {
    for (let i = id4 + 1; i < id4 + 30; i++) {
      const e = table.getLineEntry(i);
      if (e && e.kind === 'delivery' && (e.body ?? '').includes('wake failed')) {
        fact = e;
        return true;
      }
    }
    return false;
  });
  ok(fact && meta(fact).reason === 'wake-failed' && meta(fact).action === 'wake-deliver' && meta(fact).line === id4, `not-delivered, wake-failed, with the action (${fact?.body})`);
  eq(readOf(id4, 'worker'), 'unknown', 'read state unknown');
  failLaunch = false;

  console.log('\n[an agent\'s line keeps today\'s rules: no wake]');
  writes[pane('worker')] = [];
  r = await asPane(pane('boss'), 'POST', LINE, { text: '@worker from the lead (w5)' });
  const d5 = report(r);
  ok(d5 && !d5.body.includes('waking') && d5.body.includes('offline'), `the offline notice, as before (${d5?.body})`);
  await sleep(400);
  ok(!writes[pane('worker')].join('').includes('(w5)'), 'not woken, not typed');
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error).stack}`);
} finally {
  wss.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
