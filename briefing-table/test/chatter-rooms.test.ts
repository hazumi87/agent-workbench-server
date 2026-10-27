/**
 * CHATTER phase 2 [chatter p2] (Owner 2026-10-06), the room half, route level:
 *
 *   - ACK-ONLY: an agent seat's acknowledgement is refused at the line door
 *     (422 ack_only, naming fabric_ack), on the bearer + from door AND the
 *     pane-token door (room_post); nothing is written; the person is never held;
 *     an ack that carries a report passes;
 *   - LEAD ECHO: the lead re-telling the person what another seat told them in
 *     the last 15 minutes is held (409 lead_echo, naming the earlier line, with a
 *     confirm token); resending with the token posts it, once; a non-lead, a line
 *     not to the person, and a different line all pass;
 *   - LEAD RULES: a person's line typed to the lead carries the lead hint (and not
 *     the "tell @user" clause); typed to a member it does not; the lead's welcome
 *     carries the rules, a member's does not;
 *   - the report counts every refusal and the confirm.
 *
 * SAFETY: a temp table set BEFORE any import; no fabric; nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-chatter-rooms-'));
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
const seatWelcome = await import('../src/engine/seat-welcome.ts');
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
async function until<T>(fn: () => T, good: (v: T) => boolean, ms = 3000): Promise<T> {
  const t0 = Date.now();
  let v = fn();
  while (!good(v) && Date.now() - t0 < ms) {
    await sleep(20);
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
async function report(): Promise<any> {
  const out = { status: 0, body: null as any };
  await chatterRoutes.handle(req('GET', '/api/chatter?hours=1'), resp(out), '/api/chatter', { human: false, log: () => {} });
  return out.body;
}

try {
  /* ---- a room: @lead (the lead), @worker, @other ---- */
  const writes: Record<string, string[]> = {};
  for (const [id, agent] of [['rec-l', 'lead'], ['rec-w', 'worker'], ['rec-o', 'other']]) {
    table.upsertRecipe({
      id, name: agent, target: 'local', projectDir: `/x/${agent}`, vendor: 'claude-code', agent, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
    const pane = `recipe:${id}`;
    table.upsert({ paneid: pane, recipe_id: id, server: 'local', vendor: 'claude-code', agent, session_id: null, state: 'live', generation: 1 } as never);
    writes[pane] = [];
    sessions.add(pane, { state: 'live', pty: { write: (d: string) => writes[pane].push(d) } } as never, null as never);
    activity.onLive(pane);
  }
  activity.setOnChange((p, s) => typer.onActivity(p, s));
  const L = 'recipe:rec-l';
  const W = 'recipe:rec-w';
  const O = 'recipe:rec-o';
  const R = table.createRoom({ name: 'Studio' }, { actor: 'user' }).result;
  const sl = table.addSeat(R.id, { recipe_id: 'rec-l', occupant: L }, { actor: 'user' }).result;
  const sw = table.addSeat(R.id, { recipe_id: 'rec-w', occupant: W }, { actor: 'user' }).result;
  table.addSeat(R.id, { recipe_id: 'rec-o', occupant: O }, { actor: 'user' });
  if (table.getRoom(R.id)?.lead_seat !== sl.id) {
    table.updateRoom(R.id, { lead_seat: sl.id }, { actor: 'user' });
  }
  eq(table.getRoom(R.id)?.lead_seat, sl.id, 'setup: @lead leads');
  /* [agent comms] the rules default to 'watch' and lead rules to off; the phase-2
     sections below test ENFORCEMENT, so they switch it on first (the watch and off
     modes are tested at the end). */
  table.setEngineSetting('agentComms', { ackOnly: 'enforce', leadEcho: 'enforce', leadRules: true });
  const LINE = `/api/rooms/${R.id}/line`;
  const count = () => table.chatterSource(0).lines.length;
  const idle = (p: string) => {
    activity.onTurnStart(p);
    activity.onResponseDone(p);
  };

  console.log('\n[ack-only: refused at the line door, both doors; the person is never held]');
  let n0 = count();
  const ack = await call('POST', LINE, { text: '@user Received.', from: { paneid: W } });
  eq([ack.status, ack.body?.error], [422, 'ack_only'], 'bearer + from: an ack-only line is 422 ack_only');
  ok(!/fabric_ack/.test(ack.body?.message ?? '') && /Post only when you have news/.test(ack.body?.message ?? ''), '...telling the agent to post only with news (this engine has no fabric tools, so the refusal names none)');
  eq(count(), n0, '...and nothing is written');
  const ack2 = await asPane(W, 'POST', LINE, { text: '@lead Understood, thanks!' });
  eq([ack2.status, ack2.body?.error], [422, 'ack_only'], 'pane-token door (room_post): refused too');
  const ack3 = await asPane(W, 'POST', LINE, { text: '@lead ack r15-worker-77jse' });
  eq(ack3.status, 422, 'a test-round "ack <token>" is an ack too');
  const real = await call('POST', LINE, {
    text: '@lead Ack. Noted the faster fill/padding routine, your reported 2e-7 maximum difference, and the fresh-stack rerun route for the earlier timeout.',
    from: { paneid: W },
  });
  eq(real.status, 200, 'an ack that carries a report passes');
  const person = await call('POST', LINE, { text: '@lead Got it', }, true);
  eq(person.status, 200, "the person's own \"Got it\" is never held");
  await sleep(50);
  idle(L);
  idle(W);

  console.log('\n[lead echo: held, names the earlier line; confirm posts it once]');
  const told = await call('POST', LINE, { text: '@user the revised palm is ready for your look at the back view link', from: { paneid: W } });
  eq(told.status, 200, 'the worker tells the person');
  const toldId = told.body.entries[0].id;
  n0 = count();
  const ECHO = '@user Astra: the revised palm is ready for your look, back view link here';
  const held = await asPane(L, 'POST', LINE, { text: ECHO });
  eq([held.status, held.body?.error, held.body?.line], [409, 'lead_echo', toldId], 'the lead re-telling it: 409 lead_echo naming the earlier line');
  ok(typeof held.body?.confirm === 'string' && held.body.message.includes(`line ${toldId}`) && held.body.message.includes(held.body.confirm), '...with a confirm token, named in the message');
  eq(count(), n0, '...nothing written');
  const wrongText = await asPane(L, 'POST', LINE, { text: ECHO + ' extra', confirm: held.body.confirm });
  eq(wrongText.status, 409, 'the token confirms THAT text only');
  const posted = await asPane(L, 'POST', LINE, { text: ECHO, confirm: held.body.confirm });
  eq(posted.status, 200, 'resent with the token: posted');
  const again = await asPane(L, 'POST', LINE, { text: ECHO, confirm: held.body.confirm });
  eq(again.status, 409, 'a token is used once');
  const other = await call('POST', LINE, { text: ECHO, from: { paneid: O } });
  eq(other.status, 200, 'a non-lead saying the same is not held by this rule');
  const notToPerson = await call('POST', LINE, { text: '@worker the revised palm is ready for your look at the back view link?', from: { paneid: L } });
  eq(notToPerson.status, 200, "the lead's line to a seat (not the person) passes");
  const different = await asPane(L, 'POST', LINE, { text: '@user the kilt strips need a second pass on the buckles before review' });
  eq(different.status, 200, 'a different line to the person passes');
  await sleep(50);
  idle(L);
  idle(W);
  idle(O);

  console.log('\n[lead rules: typed with the person\'s lines to the lead only]');
  writes[L].length = 0;
  writes[W].length = 0;
  await call('POST', LINE, { text: '@lead please ask the worker for the hand renders' }, true);
  const toLead = (await until(() => writes[L].join(''), (s) => s.includes('hand renders'))) as string;
  ok(toLead.includes(typer.LEAD_HINT.trim()), "the person's line typed to the lead carries the lead rules");
  ok(!toLead.includes('tell @user'), '...and not the "tell @user" clause the rules forbid');
  await call('POST', LINE, { text: '@worker please render the hand' }, true);
  const toWorker = (await until(() => writes[W].join(''), (s) => s.includes('render the hand'))) as string;
  ok(toWorker.includes('; if you act on this through someone else, tell @user in a line of your own)') && !toWorker.includes('(lead:'), 'typed to a member: the existing hint, no lead rules');
  eq(typer.frame('A', 'worker', 'x', typer.TYPE_TEXT_MAX, true).includes('(lead:'), false, "an agent's line to the lead carries no lead rules");
  const leadSeat = table.getSeat(sl.id)!;
  const workerSeat = table.getSeat(sw.id)!;
  ok(seatWelcome.welcomeText(R, leadSeat).includes(typer.LEAD_RULES), "the lead's welcome carries the rules");
  ok(seatWelcome.welcomeAppendix(R, leadSeat).includes(typer.LEAD_RULES), "...and a reload's appendix for the lead");
  ok(!seatWelcome.welcomeText(R, workerSeat).includes(typer.LEAD_RULES), "a member's welcome does not");

  console.log('\n[the report counts the refusals and the confirm]');
  const rep = await report();
  eq(rep.refused?.ack_only, { worker: 3 }, 'ack_only: 3 by @worker');
  eq(rep.refused?.lead_echo, { [sl.handle]: 3 }, 'lead_echo: 3 holds of the lead seat (first, wrong text, reused token)');
  eq(rep.echo_confirms, 1, 'one confirm used');

  console.log('\n[agent comms: watch = evaluated and recorded, the line goes through unchanged]');
  idle(L);
  idle(W);
  table.setEngineSetting('agentComms', { ackOnly: 'watch', leadEcho: 'watch', leadRules: false });
  n0 = count();
  const wAck = await call('POST', LINE, { text: '@user Noted.', from: { paneid: W } });
  eq(wAck.status, 200, 'watch: an ack-only line is posted');
  eq(count(), n0 + 1, '...and written');
  const wEcho = await call('POST', LINE, { text: ECHO, from: { paneid: L } });
  eq([wEcho.status, wEcho.body?.confirm], [200, undefined], 'watch: the lead echo is posted, no confirm token');
  let rep3 = await report();
  eq(rep3.watched?.ack_only, { worker: 1 }, 'watched: the ack, by @worker');
  eq(rep3.watched?.lead_echo, { [sl.handle]: 1 }, 'watched: the echo, by the lead');
  eq([rep3.refused?.ack_only, rep3.refused?.lead_echo], [{ worker: 3 }, { [sl.handle]: 3 }], 'enforced refusals counted apart, unchanged');
  ok(rep3.findings.some((f: any) => f.kind === 'watched' && f.seat === 'worker' && f.examples[0] === 'ack_only'), 'a watched finding');

  console.log('\n[agent comms: off = not evaluated at all]');
  table.setEngineSetting('agentComms', { ackOnly: 'off', leadEcho: 'off' });
  eq((await call('POST', LINE, { text: '@user Thanks.', from: { paneid: W } })).status, 200, 'off: an ack-only line is posted');
  eq((await call('POST', LINE, { text: ECHO + ' again', from: { paneid: L } })).status, 200, 'off: a lead echo is posted');
  rep3 = await report();
  eq([rep3.watched?.ack_only, rep3.watched?.lead_echo], [{ worker: 1 }, { [sl.handle]: 1 }], '...and nothing more is recorded');

  console.log('\n[agent comms: lead rules off (the default) = the lead gets the members\' hint]');
  table.setEngineSetting('agentComms', null);
  await sleep(50);
  idle(L);
  writes[L].length = 0;
  await call('POST', LINE, { text: '@lead please check the cuff renders', }, true);
  const toLead2 = (await until(() => writes[L].join(''), (s) => s.includes('cuff renders'))) as string;
  ok(toLead2.includes('; if you act on this through someone else, tell @user in a line of your own)') && !toLead2.includes('(lead:'), 'typed to the lead: USER_REPLY_HINT, no lead rules');
  ok(!seatWelcome.welcomeText(R, leadSeat).includes(typer.LEAD_RULES), "the lead's welcome carries no rules");
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
