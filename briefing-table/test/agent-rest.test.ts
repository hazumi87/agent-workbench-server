/**
 * AGENT REST, level 1 [agent rest] (Owner 2026-10-07, room interface): two global
 * idle levels for ALL agents.
 *
 *   - the condition (idle-rest.ts mayRest): exactly 'idle' (not background, not
 *     streaming), resumable, no draft, nothing held, not blocked, quiet >= restMinutes;
 *   - the settings: restEnabled / restMinutes validated, defaults off / 15;
 *   - the sweep (rooms.agentRestSweep) picks the right panes: room seats (a lead
 *     too) AND an agent in no room; not a streaming pane, not one with a draft, not a
 *     non-persistent seat; a fact in the seat's room; counted in the chatter report;
 *   - the wake: a person's line, an agent's line (the pane-token door, room_post) and a
 *     room-wide line wake a resting seat, and the line that woke it is TYPED after it
 *     is back; a fabric DM wakes a resting agent in no room (wakeRestedForDm);
 *   - level 2 is unchanged: a seat dehydrated by Disconnect is not woken by the
 *     person's line (the offline notice), and idleRestSweep with no hours does nothing.
 *
 * (A non-persistent seat is skipped by the sweep; not tested here: no store verb sets one.)
 * SAFETY: a temp table set BEFORE any import; a fake /pty socket on P(420) that
 * answers attach with pane.ready; a fake launcher; nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { P, assertFree } from './_scratch.mjs';

const SOCK_PORT = P(420);
await assertFree(SOCK_PORT, 'agent-rest.test.ts');

const dir = mkdtempSync(join(tmpdir(), 'wb-agent-rest-'));
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
const idle = await import('../src/engine/idle-rest.ts');
const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const chatterRoutes = await import('../src/server/chatter.ts');

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
async function until<T>(fn: () => T, good: (v: T) => boolean, ms = 5000): Promise<T> {
  const t0 = Date.now();
  let v = fn();
  while (!good(v) && Date.now() - t0 < ms) {
    await sleep(25);
    v = fn();
  }
  return v;
}
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
const doorLog: string[] = [];
const deps = (human: boolean) => ({ projector: async () => (x: any) => x, log: (l: string) => doorLog.push(l), human });
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

/* ---- fake panes: a pty that records writes, live in sessions + activity ---- */
const writes: Record<string, string[]> = {};
function goLive(pane: string, recipeId: string, agent: string): void {
  table.upsert({ paneid: pane, recipe_id: recipeId, server: 'local', vendor: 'claude-code', agent, session_id: null, state: 'live', generation: 1 } as never);
  writes[pane] ??= [];
  sessions.add(pane, { state: 'live', pty: { write: (d: string) => writes[pane].push(d) } } as never, null as never);
  activity.onLive(pane);
}
const agentOf: Record<string, string> = {};
async function endForCycle(paneid: string): Promise<{ ended: boolean; state: string | null }> {
  const row = table.get(paneid) as any;
  table.upsert({ ...row, state: 'dehydrated' });
  sessions.remove(paneid);
  activity.drop(paneid);
  return { ended: true, state: 'dehydrated' };
}

/* the fake /pty socket driveToReady attaches to */
const wss = new WebSocketServer({ port: SOCK_PORT, host: '127.0.0.1' });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'attach') {
      ws.send(JSON.stringify({ type: 'pane.ready', paneid: m.paneid }));
    }
  });
});
const launches: string[] = [];
rooms.setStartDeps({
  launch: async (recipeId: string, body: any, onPane?: (p: string) => void) => {
    const pane = typeof body?.pane === 'string' ? body.pane : `recipe:${recipeId}`;
    launches.push(pane);
    await sleep(150); // a real launch takes a while: the line is written before the pane is back
    goLive(pane, recipeId, agentOf[pane]);
    onPane?.(pane);
    return { ok: true, paneid: pane, url: '', path: '', placement: 'tab' };
  },
  endForCycle,
  socketUrl: () => `ws://127.0.0.1:${SOCK_PORT}/pty`,
  socketToken: () => 't',
  needsYou: () => null,
  ready: () => true,
} as never);

try {
  console.log('\n[the condition: mayRest]');
  const MIN = 60_000;
  const NOW = 10_000_000_000;
  const base = { state: 'idle', resumable: true, draft: false, held: 0, blocked: false, lastActiveAt: NOW - 20 * MIN };
  eq(idle.mayRest(base, 15, NOW, 0), true, 'idle 20 min, limit 15: rests');
  eq(idle.mayRest({ ...base, state: 'background' }, 15, NOW, 0), false, "'background' (watchers, sub-agents, background jobs) never rests");
  eq(idle.mayRest({ ...base, state: 'streaming' }, 15, NOW, 0), false, 'streaming never rests');
  eq(idle.mayRest({ ...base, state: 'waiting-seen' }, 15, NOW, 0), false, 'a question seen but unanswered never rests');
  eq(idle.mayRest({ ...base, draft: true }, 15, NOW, 0), false, 'a draft in the composer never rests');
  eq(idle.mayRest({ ...base, held: 1 }, 15, NOW, 0), false, 'a line held for it never rests');
  eq(idle.mayRest({ ...base, blocked: true }, 15, NOW, 0), false, 'blocked on the human never rests');
  eq(idle.mayRest({ ...base, resumable: false }, 15, NOW, 0), false, 'a shell (not resumable) never rests');
  eq(idle.mayRest({ ...base, lastActiveAt: NOW - 10 * MIN }, 15, NOW, 0), false, 'too recent (10 min of 15)');
  eq(idle.mayRest({ ...base, lastActiveAt: null }, 15, NOW, NOW - 16 * MIN), true, 'silent since boot: the boot time is the clock');

  console.log('\n[settings: restEnabled / restMinutes]');
  eq([idle.IDLE_REST_DEFAULTS.restEnabled, idle.IDLE_REST_DEFAULTS.restMinutes], [false, 15], 'defaults: off, 15 minutes');
  eq(idle.validIdleRestPatch({ restEnabled: true, restMinutes: 30 }), { restMinutes: 30, restEnabled: true }, 'valid patch');
  for (const bad of [0, 1441, 2.5, '15']) {
    let field = '';
    try {
      idle.validIdleRestPatch({ restMinutes: bad });
    } catch (e) {
      field = (e as any).field;
    }
    eq(field, 'restMinutes', `restMinutes ${JSON.stringify(bad)} refused`);
  }
  eq(idle.idleRestFrom({ restEnabled: 'yes', restMinutes: 99999 }).restMinutes, 15, 'a bad stored value reads as the default');

  /* ---- a room: @boss (lead), @worker, @busy (streaming), @drafty (a draft), @temp
     (a non-persistent seat), @parked (dehydrated by level 2), and video-to-3d in no room ---- */
  const AG = ['boss', 'worker', 'busy', 'drafty', 'parked', 'video-to-3d'];
  for (const a of AG) {
    const id = `rec-${a}`;
    table.upsertRecipe({
      id, name: a, target: 'local', projectDir: `/x/${a}`, vendor: 'claude-code', agent: a, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
    agentOf[`recipe:${id}`] = a;
    goLive(`recipe:${id}`, id, a);
  }
  activity.setOnChange((p, s) => typer.onActivity(p, s));
  const pane = (a: string) => `recipe:rec-${a}`;
  const R = table.createRoom({ name: 'Studio' }, { actor: 'user' }).result;
  const seat: Record<string, any> = {};
  for (const a of ['boss', 'worker', 'busy', 'drafty', 'parked']) {
    seat[a] = table.addSeat(R.id, { recipe_id: `rec-${a}`, occupant: pane(a) }, { actor: 'user' }).result;
  }
  if (table.getRoom(R.id)?.lead_seat !== seat.boss.id) {
    table.updateRoom(R.id, { lead_seat: seat.boss.id }, { actor: 'user' });
  }
  await endForCycle(pane('parked')); // level 2 put it to rest (no level-1 mark)
  activity.markUnknownDraft(pane('drafty'));
  const LINE = `/api/rooms/${R.id}/line`;

  /* [wake deliver] personWakes (default on) would wake the level-2 @parked seat on the
     person's lines below; this file tests level 1, so it is off here */
  table.setEngineSetting('agentComms', { personWakes: false });
  console.log('\n[the sweep: off by default]');
  const later = Date.now() + 20 * MIN;
  eq((await rooms.agentRestSweep(endForCycle, () => {}, later)).length, 0, 'restEnabled off: nothing rests');

  console.log('\n[the sweep: the right panes, in rooms and out]');
  table.setEngineSetting('idleRest', { restEnabled: true, restMinutes: 15 });
  activity.onData(pane('busy'), 'y'.repeat(900)); // streaming right now
  const logs: string[] = [];
  const rested = await rooms.agentRestSweep(endForCycle, (l) => logs.push(l), later);
  const names = rested.map((r) => r.slug).sort();
  const want = ['boss', 'video-to-3d', 'worker'];
  eq(names, want, 'rested: the lead, the worker and the agent in no room (not the streaming one, not the one with a draft, not the level-2 one)');
  ok(rested.find((r) => r.slug === 'video-to-3d')?.room === null, 'video-to-3d is in no room');
  ok(rooms.isRestedLevel1(pane('worker')) && rooms.isRestedLevel1(pane('video-to-3d')), 'marked as level-1 rested');
  ok(!rooms.isRestedLevel1(pane('parked')), 'a level-2 disconnect is not level 1');
  ok(logs.some((l) => l.includes('video-to-3d') && l.includes('resting (no cost)')), 'an engine log line for the agent in no room');
  eq((await rooms.agentRestSweep(endForCycle, () => {}, later)).length, 0, 'a second sweep finds nothing more');

  console.log('\n[wake: the person\'s line wakes the resting lead, and the line is typed after]');
  writes[pane('boss')] = [];
  const p1 = await call('POST', LINE, { text: '@boss please check the cuff renders' }, true);
  eq(p1.status, 200, 'posted');
  ok(JSON.stringify(p1.body).includes('waking it'), 'the delivery report says it is waking');
  const t1 = await until(() => writes[pane('boss')].join(''), (s) => s.includes('cuff renders'));
  ok(t1.includes('cuff renders'), 'the line that woke it is typed into the woken pane');
  await sleep(300);
  eq(writes[pane('boss')].join('').split('cuff renders').length - 1, 1, '...exactly once');
  ok(!rooms.isRestedLevel1(pane('boss')) && table.get(pane('boss'))?.state === 'live', 'live again, mark cleared');

  console.log('\n[wake: an agent\'s line (room_post, the pane-token door) wakes a resting member]');
  activity.onTurnStart(pane('boss'));
  activity.onResponseDone(pane('boss'));
  writes[pane('worker')] = [];
  const p2 = await asPane(pane('boss'), 'POST', LINE, { text: '@worker please export the hand at checkpoint 510' });
  eq(p2.status, 200, 'posted through the pane-token door');
  const t2 = await until(() => writes[pane('worker')].join(''), (s) => s.includes('checkpoint 510'));
  ok(t2.includes('checkpoint 510'), 'woken (the door carries no launcher: setStartDeps does) and the line is typed');

  await until(() => doorLog.filter((l) => l.includes('wake: ')).length, (n) => n >= 2); // both wakes finished
  console.log('\n[wake: a room-wide line wakes it too]');
  activity.onTurnStart(pane('worker'));
  activity.onResponseDone(pane('worker'));
  const again = await rooms.agentRestSweep(endForCycle, () => {}, Date.now() + 40 * MIN);
  ok(again.some((r) => r.slug === 'worker'), 'the worker rests again');
  writes[pane('worker')] = [];
  const p3 = await call('POST', LINE, { text: '@room status check for everyone please' }, true);
  eq(p3.status, 200, 'a room-wide line posted');

  const t3 = await until(() => writes[pane('worker')].join(''), (s) => s.includes('status check'));
  ok(t3.includes('status check'), 'the resting worker woke and got it');

  await until(() => doorLog.filter((l) => l.includes('wake: ')).length, (n) => n >= 6);
  console.log('\n[level 2 unchanged: a Disconnected seat is not woken by the person\'s line]');
  const p4 = await call('POST', LINE, { text: '@parked are you there' }, true);
  ok(JSON.stringify(p4.body).includes('offline'), 'the offline notice, as before');
  await sleep(200);
  eq(table.get(pane('parked'))?.state, 'dehydrated', 'still dehydrated');
  eq(await rooms.idleRestSweep(endForCycle, () => {}, Date.now() + 1000 * MIN), [], 'idleRestSweep with no hours set does nothing');

  console.log('\n[wake: a fabric DM to a resting agent in no room]');
  let restoredFor = '';
  const okRestore = async (slug: string) => {
    restoredFor = slug;
    goLive(pane('video-to-3d'), 'rec-video-to-3d', 'video-to-3d');
    return { ok: true, paneid: pane('video-to-3d') };
  };
  eq(await rooms.wakeRestedForDm('worker', okRestore, () => {}), false, 'a live agent: no restore');
  eq(restoredFor, '', '...the restore was not called');
  const dmLog: string[] = [];
  eq(await rooms.wakeRestedForDm('video-to-3d', okRestore, (l) => dmLog.push(l)), true, 'the resting agent is restored for the DM');
  eq(restoredFor, 'video-to-3d', '...by its slug');
  ok(!rooms.isRestedLevel1(pane('video-to-3d')) && dmLog.some((l) => l.includes('woken')), 'mark cleared, logged');
  await endForCycle(pane('video-to-3d'));
  table.setEngineSetting('agentRest.rested', { [pane('video-to-3d')]: { ts: 1, slug: 'video-to-3d' } });
  eq(await rooms.wakeRestedForDm('video-to-3d', async () => ({ ok: false, reason: 'restore-cap' }), () => {}), false, 'a failed restore answers false (the send goes on; the fabric answers not-live)');

  console.log('\n[report: rests and wakes]');
  const out = { status: 0, body: null as any };
  await chatterRoutes.handle(req('GET', '/api/chatter?hours=1'), resp(out), '/api/chatter', { human: false, log: () => {} });
  const r = out.body?.rest;
  ok(r && r.rested === want.length + again.length && r.woken >= 4, `rest counts in the chatter report (got ${JSON.stringify(r)})`);
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error).stack}`);
} finally {
  wss.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows: the store's own handle still holds the db open (EPERM); the temp dir is left behind */
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
