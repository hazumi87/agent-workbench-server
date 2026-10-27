/**
 * SWITCH ASSISTANT, ACCEPTANCE ON A SCRATCH BASIC INSTANCE (the design notes §3, the matrix under item 8).
 * The real engine and pty-broker, provisioned by the real hosted script, with FAKE vendors (scripts/basic-scratch-instance.ts):
 * a compiled fake `claude` (trust dialog, auth status, a minimal transcript) and a fake `codex` (login status, the OBSERVED
 * login and trust screens, the engine's own hooks file fired like the real program's). Nothing here proves a real vendor:
 * real Claude/Codex acceptance stays a separate, human-run step (spec §8).
 *
 * Crashes are real: the suite stops a switch at a boundary through the test-only control file
 * (HARBOR_WB_SWITCH_CONTROL_FILE, inert unless set) and SIGKILLs the engine; the broker keeps the sessions, the restarted
 * engine resumes the switch from its journal.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
const { startScratchBasic } = await import('../scripts/basic-scratch-instance.ts');
type Scratch = Awaited<ReturnType<typeof startScratchBasic>>;
type Client = Awaited<ReturnType<Scratch['signIn']>>;

let failed = 0;
let checks = 0;
const ok = (c: unknown, m: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 15000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(300); } return await f(); };

/** Read a pane's screen through its own socket (the replay plus whatever follows). */
function watch(inst: Scratch, c: Client, paneid: string, recipe?: string): Promise<{ text(): string; close(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/pty`, { headers: { cookie: c.cookie } });
    let text = '';
    ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.paneid === paneid && (m.type === 'pane.data' || m.type === 'pane.replay')) text += m.data ?? ''; } catch { /* ignore */ } });
    ws.on('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify(recipe ? { type: 'attach', paneid, recipe, cols: 100, rows: 30 } : { type: 'attach', paneid, intent: 'view', cols: 100, rows: 30 }));
      resolve({ text: () => text, close: () => ws.close() });
    });
  });
}
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

const CTL = join(mkdtempSync(join(tmpdir(), 'wb-switch-ctl-')), 'switch-control.json');
const control = (v: Record<string, unknown> | null) => {
  if (v) writeFileSync(CTL, JSON.stringify(v)); else rmSync(CTL, { force: true });
};
const fake = (inst: Scratch, name: string, on: boolean) => {
  const dir = join(inst.home, '.fake-vendors');
  mkdirSync(dir, { recursive: true });
  if (on) writeFileSync(join(dir, name), 'on\n'); else rmSync(join(dir, name), { force: true });
};
const codexHeard = (inst: Scratch): string => {
  const p = join(inst.home, '.fake-vendors', 'codex-heard.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};
const trustClaude = (inst: Scratch, dirs: string[]) =>
  writeFileSync(join(inst.home, '.claude.json'), JSON.stringify({ projects: Object.fromEntries(dirs.map((d) => [d, { hasTrustDialogAccepted: true }])) }));

const roomView = async (c: Client, name: string) => ((await c.get('/api/rooms')).body as any[]).find((r) => r.room.name === name);
const builderSeat = async (c: Client) => (await roomView(c, 'Hello World')).seats.find((s: any) => s.handle === 'builder');
const row = async (c: Client, paneid: string) => ((await c.get('/api/table')).body?.sessions as any[] ?? []).find((r) => r.paneid === paneid);
const paneOf = (seat: any): string | null => (seat?.occupant && typeof seat.occupant === 'object' ? seat.occupant.id : seat?.occupant) ?? null;
const line = async (c: Client, roomId: string, text: string) => (await c.post(`/api/rooms/${roomId}/line`, { text })).body as any;

async function status(c: Client, roomId: string, seatId: string, opId: string): Promise<any> {
  return (await c.get(`/api/rooms/${roomId}/seats/${seatId}/switch/${opId}`)).body;
}
async function waitDone(c: Client, roomId: string, seatId: string, opId: string, ms = 60000): Promise<any> {
  let s: any = null;
  await until(async () => { s = await status(c, roomId, seatId, opId); return !!s?.done; }, ms);
  return s;
}
async function waitState(c: Client, roomId: string, seatId: string, opId: string, states: string[], ms = 60000): Promise<any> {
  let s: any = null;
  await until(async () => { s = await status(c, roomId, seatId, opId); return states.includes(s?.state); }, ms);
  return s;
}
/** Start the builder seat (if not live) and wait until its assistant is past startup. */
async function liveBuilder(inst: Scratch, c: Client): Promise<{ roomId: string; seat: any; paneid: string }> {
  const r = await roomView(c, 'Hello World');
  let seat = r.seats.find((s: any) => s.handle === 'builder');
  if (seat.status !== 'live') {
    const st = (await c.post(`/api/rooms/${r.room.id}/seats/${seat.id}/start`, { target: 'tab', surface: 'browser' })).body as any;
    const w = await watch(inst, c, st.paneid, seat.recipe_id);
    await until(() => /fake\) in|Codex \(fake\) ready/.test(w.text()), 15000);
    w.close();
    seat = await builderSeat(c);
  }
  await until(async () => (await builderSeat(c)).status === 'live', 10000);
  seat = await builderSeat(c);
  return { roomId: r.room.id, seat, paneid: paneOf(seat) as string };
}

const patch = async (inst: Scratch, c: Client, path: string, json: unknown) => {
  const r = await fetch(`${inst.base}${path}`, { method: 'PATCH', headers: { cookie: c.cookie, 'content-type': 'application/json' }, body: JSON.stringify(json) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const recipes = async (c: Client) => ((await c.get('/api/recipes')).body?.recipes ?? (await c.get('/api/recipes')).body ?? []) as any[];
const isLiveRow = async (c: Client, paneid: string | null) => !!paneid && (await row(c, paneid))?.state === 'live';
const dumpOnFail = (inst: Scratch, s: any, want: string) => {
  if (s?.state !== want) console.log(inst.engineLog().split('\n').filter((l) => /switch|agent-hook|room-type|startup|restor/i.test(l)).slice(-40).join('\n'));
};
/** Post a switch and return its id (asserting it was accepted). */
async function begin(c: Client, roomId: string, seatId: string, to: 'claude' | 'codex', what: string): Promise<string> {
  const r = await c.post(`/api/rooms/${roomId}/seats/${seatId}/switch`, { to });
  ok(r.status === 202 && typeof r.body?.opId === 'string', `${what}: the switch is accepted (${r.status} ${r.body?.error ?? ''})`);
  return r.body?.opId ?? '';
}

const engineEnv = {
  HARBOR_WB_SWITCH_SESSION_WAIT_MS: '6000',
  HARBOR_WB_SWITCH_TICK_MS: '500',
  HARBOR_WB_SWITCH_SWEEP_MS: '2000',
  HARBOR_WB_SEAT_RELOAD_WAIT_MS: '20000',
  HARBOR_WB_SWITCH_CONTROL_FILE: CTL,
};
const inst = await startScratchBasic({ engineEnv });
try {
  const c = await inst.signIn();
  const PROJECT = join(inst.home, 'dev', 'code', 'hello-world');
  trustClaude(inst, [PROJECT, join(inst.home, 'dev')]);

  console.log('Claude -> Codex: the room, handle and lead stay; the handover reaches Codex; later lines go to Codex');
  {
    const { roomId, seat, paneid: oldPane } = await liveBuilder(inst, c);
    const room0 = (await roomView(c, 'Hello World')).room;
    const wiz = (await c.get(`/api/rooms/${roomId}/seats/${seat.id}/switch`)).body as any;
    ok(wiz.current?.vendor === 'claude-code' && wiz.choices?.find((x: any) => x.to === 'claude')?.disabled === true, 'the wizard marks Claude current and disabled ("You\'re already using Claude")');
    ok(wiz.choices?.find((x: any) => x.to === 'codex')?.label === 'Codex: gpt-6.1-sol, medium effort', 'and offers exactly the Codex preset');
    const same = await c.post(`/api/rooms/${roomId}/seats/${seat.id}/switch`, { to: 'claude' });
    ok(same.status === 409 && /already using Claude/.test(JSON.stringify(same.body)), 'a same-vendor switch is refused by the server');
    const r = await c.post(`/api/rooms/${roomId}/seats/${seat.id}/switch`, { to: 'codex', note: 'keep going on the README' });
    ok(r.status === 202 && typeof r.body?.opId === 'string', 'the switch is accepted and answers early with its id');
    const opId = r.body.opId as string;
    const during = await line(c, roomId, '@builder typed during the switch');
    ok(/held for @builder/.test(JSON.stringify(during.entries ?? [])) || during.deliveries?.[0]?.queued === true, 'a line typed during the switch is held for the seat, never a wake');
    const s = await waitDone(c, roomId, seat.id, opId, 90000);
    ok(s?.state === 'done' && /Codex is ready/.test(s?.words ?? ''), `the switch finishes: "${s?.words}" (state ${s?.state}, error ${s?.error})`);
    const after = await builderSeat(c);
    const newPane = paneOf(after);
    const room1 = (await roomView(c, 'Hello World')).room;
    ok(after?.handle === 'builder' && newPane && newPane !== oldPane, 'the seat keeps its handle and now holds a different pane');
    ok(room1.lead_seat === after?.id || (room0.lead_seat !== seat.id && room1.lead_seat === room0.lead_seat), 'the lead stays on the seat (moved with it)');
    const nr = await row(c, newPane);
    ok(nr?.vendor === 'codex-cli' && typeof nr?.session_id === 'string' && nr.session_id.length > 8, 'the new pane is Codex with the session id its own hook banked');
    const w = await watch(inst, c, newPane);
    ok(await until(() => w.text().includes(`fake-codex heard: Handover ${opId}`), 10000), 'Codex received the ONE handover line naming the packet');
    ok(await until(() => count(w.text(), 'fake-codex heard: [room') >= 1 && w.text().includes('typed during the switch'), 15000), 'the line typed during the switch reached the NEW occupant');
    await line(c, roomId, '@builder after the switch');
    ok(await until(() => w.text().includes('after the switch'), 15000), 'a line after the switch goes to Codex');
    ok(count(w.text(), 'typed during the switch') === 1, 'and the held line arrived exactly once');
    w.close();
    const old = await c.get(`/api/rooms/${roomId}/seats/${seat.id}/switch/${opId}`);
    ok(old.status === 200 && old.body?.state === 'done', 'the status stays readable by the ORIGINAL seat id after the swap');
    ok(existsSync(join(PROJECT, '.workbench', 'handover', `${opId}.md`)), 'the packet file is in the project folder');
  }

  console.log('target not logged in (Claude): refused before anything changes; the Codex assistant was never stopped');
  {
    const { roomId, seat, paneid } = await liveBuilder(inst, c);
    fake(inst, 'needs-login', true);
    const opId = await begin(c, roomId, seat.id, 'claude', 'Codex -> Claude, logged out');
    const s = await waitDone(c, roomId, seat.id, opId);
    dumpOnFail(inst, s, 'failed-before-transfer');
    ok(s?.state === 'failed-before-transfer' && /^login-needed/.test(s?.error ?? ''), `fails before transfer: login-needed ("${s?.words}")`);
    ok(s?.recovery === 'unchanged' && /was never stopped/.test(s?.words ?? ''), 'and says the previous assistant was never stopped');
    ok(paneOf(await builderSeat(c)) === paneid && (await isLiveRow(c, paneid)), 'the seat still holds the same live Codex pane');
    fake(inst, 'needs-login', false);
  }

  console.log('Codex -> Claude (back): the ORIGINAL recipe with the preset; lines typed meanwhile arrive once, in order; the old side is never asked anything');
  {
    const { roomId, seat, paneid: oldPane } = await liveBuilder(inst, c);
    const ow = await watch(inst, c, oldPane);
    await sleep(800);
    const heardBefore = count(ow.text(), 'fake-codex heard:');
    const opId = await begin(c, roomId, seat.id, 'claude', 'Codex -> Claude');
    await line(c, roomId, '@builder first-during-7a1');
    await line(c, roomId, '@builder second-during-7a2');
    const s = await waitDone(c, roomId, seat.id, opId, 90000);
    dumpOnFail(inst, s, 'done');
    ok(s?.state === 'done' && /Claude is ready/.test(s?.words ?? ''), `the switch back finishes: "${s?.words}"`);
    ok(count(ow.text(), 'fake-codex heard:') === heardBefore, 'the outgoing (possibly exhausted) assistant was asked nothing: no line was typed into it');
    ow.close();
    const after = await builderSeat(c);
    const np = paneOf(after) as string;
    const nr = await row(c, np);
    ok(nr?.vendor === 'claude-code' && after?.recipe_id === 'hosted-builder', 'the seat runs the ORIGINAL Claude recipe again');
    const all = (await recipes(c)).map((r: any) => r.id);
    ok(all.includes('hosted-builder--codex') && !all.some((id: string) => id.startsWith('hosted-builder--claude')), 'there is never a third recipe');
    const w = await watch(inst, c, np);
    ok(await until(() => w.text().includes(`Handover ${opId}`), 10000), 'Claude received the handover line (and its transcript holds it: the switch confirmed it)');
    ok(await until(() => w.text().includes('second-during-7a2'), 15000), 'both lines typed during the switch reached Claude');
    const t = w.text();
    ok(count(t, 'first-during-7a1') === 1 && count(t, 'second-during-7a2') === 1 && t.indexOf('first-during-7a1') < t.indexOf('second-during-7a2'), 'exactly once each, in order');
    w.close();
  }

  console.log('target not logged in (Codex): refused before anything changes');
  {
    const { roomId, seat, paneid } = await liveBuilder(inst, c);
    fake(inst, 'codex-needs-login', true);
    const opId = await begin(c, roomId, seat.id, 'codex', 'Claude -> Codex, logged out');
    const s = await waitDone(c, roomId, seat.id, opId);
    ok(s?.state === 'failed-before-transfer' && /^login-needed/.test(s?.error ?? '') && s?.recovery === 'unchanged', `fails before transfer: login-needed, never stopped ("${s?.words}")`);
    ok(paneOf(await builderSeat(c)) === paneid && (await isLiveRow(c, paneid)), 'the seat still holds the same live Claude pane');
    fake(inst, 'codex-needs-login', false);
  }

  console.log('Codex at its trust prompt: no handover, the launched Codex is ended, Claude comes back with the line typed meanwhile');
  {
    const { roomId, seat, paneid } = await liveBuilder(inst, c);
    fake(inst, 'codex-force-trust', true);
    const opId = await begin(c, roomId, seat.id, 'codex', 'Claude -> Codex at the trust prompt');
    await line(c, roomId, '@builder during-trust-3c9');
    const s = await waitDone(c, roomId, seat.id, opId, 90000);
    dumpOnFail(inst, s, 'failed-before-transfer');
    ok(s?.state === 'failed-before-transfer' && /^trust-needed/.test(s?.error ?? ''), `fails before transfer: trust-needed ("${s?.words}")`);
    ok(s?.recovery === 'restored' && /is back/.test(s?.words ?? ''), '"the old assistant is back" only once the restore succeeded');
    if (s?.recovery !== 'restored') console.log(inst.engineLog().split('\n').filter((l) => /switch|restor|start|wake|spawn|exit/i.test(l)).slice(-40).join('\n'));
    ok(!(await isLiveRow(c, s?.to?.paneid)), 'the launched Codex was ended');
    const back = await builderSeat(c);
    ok(paneOf(back) === paneid && (await isLiveRow(c, paneid)), 'the seat holds the SAME pane id, live again');
    const w = await watch(inst, c, paneid);
    ok(await until(() => w.text().includes('during-trust-3c9'), 20000), 'the line typed meanwhile reached the restored Claude');
    ok(!w.text().includes(`Handover ${opId}`), 'and no handover line was typed anywhere near it');
    w.close();
    fake(inst, 'codex-force-trust', false);
  }

  console.log('the new assistant never names its conversation: held before transfer, its pane ended, Claude back');
  {
    const { roomId, seat, paneid } = await liveBuilder(inst, c);
    fake(inst, 'codex-no-hooks', true);
    const opId = await begin(c, roomId, seat.id, 'codex', 'Claude -> Codex with no hooks');
    const s = await waitDone(c, roomId, seat.id, opId, 90000);
    ok(s?.state === 'failed-before-transfer' && /^session-id-unknown/.test(s?.error ?? ''), `fails before transfer: session-id-unknown ("${s?.words}")`);
    ok(!(await isLiveRow(c, s?.to?.paneid)) && paneOf(await builderSeat(c)) === paneid && (await isLiveRow(c, paneid)), 'the launched Codex is ended and Claude is back on the same pane id');
    fake(inst, 'codex-no-hooks', false);
  }

  console.log('the lead changed during the switch: refused at the transfer, target ended, Claude restored');
  {
    const { roomId, seat, paneid } = await liveBuilder(inst, c);
    const lead0 = (await roomView(c, 'Hello World')).room.lead_seat;
    const helper = (await c.post(`/api/rooms/${roomId}/seats`, { recipe_id: 'hosted-platform', handle: 'helper' })).body?.seat;
    ok(!!helper?.id, 'a second (persistent) seat joins the room');
    control({ haltAt: 'context-accepted' });
    const opId = await begin(c, roomId, seat.id, 'codex', 'Claude -> Codex, lead moves');
    const mid = await waitState(c, roomId, seat.id, opId, ['context-accepted'], 60000);
    ok(mid?.state === 'context-accepted', 'the switch reached the moment before the transfer');
    const pr = await patch(inst, c, `/api/rooms/${roomId}`, { lead_seat: lead0 === helper?.id ? seat.id : helper?.id });
    ok(pr.status === 200, `the person hands the lead to another seat meanwhile (${pr.status} ${JSON.stringify(pr.body?.error ?? '')})`);
    control(null);
    const s = await waitDone(c, roomId, seat.id, opId, 60000);
    ok(s?.state === 'failed-before-transfer' && /^lead-changed/.test(s?.error ?? '') && s?.recovery === 'restored', `refused: lead-changed, Claude restored ("${s?.words}")`);
    ok(!(await isLiveRow(c, s?.to?.paneid)) && paneOf(await builderSeat(c)) === paneid, 'the target was ended and the seat is unchanged');
    if (lead0) await patch(inst, c, `/api/rooms/${roomId}`, { lead_seat: lead0 });
  }

  console.log('cancel before the transfer ends the launched target; another seat\'s request is refused meanwhile');
  {
    const { roomId, seat, paneid } = await liveBuilder(inst, c);
    control({ haltAt: 'banked' });
    const opId = await begin(c, roomId, seat.id, 'codex', 'Claude -> Codex, then cancel');
    const mid = await waitState(c, roomId, seat.id, opId, ['banked'], 60000);
    ok(mid?.state === 'banked' && !!mid?.to?.paneid && (await isLiveRow(c, mid.to.paneid)), 'the target is launched and identified');
    const other = (await roomView(c, 'Hello World')).seats.find((x: any) => x.handle === 'helper');
    const refused = await c.post(`/api/rooms/${roomId}/seats/${other?.id}/switch`, { to: 'codex' });
    ok(refused.status === 409 && /switch already in progress/.test(JSON.stringify(refused.body)), 'a different seat\'s request answers 409 "switch already in progress"');
    const again = await c.post(`/api/rooms/${roomId}/seats/${seat.id}/switch`, { to: 'codex' });
    ok(again.status === 202 && again.body?.joined === true && again.body?.opId === opId, 'the same seat\'s retry joins the operation');
    const cr = await c.post(`/api/rooms/${roomId}/seats/${seat.id}/switch/${opId}/cancel`, {});
    ok(cr.status === 202, 'cancel is accepted while reversible');
    control(null);
    const s = await waitDone(c, roomId, seat.id, opId, 60000);
    ok(s?.state === 'cancelled' && s?.recovery === 'restored', `cancelled, Claude restored ("${s?.words}")`);
    ok(!(await isLiveRow(c, mid?.to?.paneid)), 'the launched target was ended');
    ok(paneOf(await builderSeat(c)) === paneid && (await isLiveRow(c, paneid)), 'the seat holds its Claude pane again');
  }

  console.log('old pane unreachable at the fence: the switch waits and launches nothing; it proceeds once the stop is confirmed');
  {
    const { roomId, seat, paneid } = await liveBuilder(inst, c);
    control({ unreachable: true });
    const opId = await begin(c, roomId, seat.id, 'codex', 'Claude -> Codex, unreachable');
    await sleep(4000);
    const mid = await status(c, roomId, seat.id, opId);
    ok(mid?.state === 'packet-saved' && /^fence-unknown/.test(mid?.error ?? ''), `waits at the fence ("${mid?.words}")`);
    ok(!mid?.to?.paneid && (await isLiveRow(c, paneid)), 'nothing was launched and the old assistant was not ended');
    control(null);
    const s = await waitDone(c, roomId, seat.id, opId, 90000);
    ok(s?.state === 'done', `once the stop can be confirmed, the switch completes ("${s?.words}")`);
  }

  console.log('crash at the FENCE boundary: lines held before and after the crash arrive once, in order, at the new occupant');
  {
    const { roomId, seat } = await liveBuilder(inst, c); // Codex now
    control({ haltAt: 'fenced' });
    const opId = await begin(c, roomId, seat.id, 'claude', 'Codex -> Claude, crash at the fence');
    await line(c, roomId, '@builder crash-a-11');
    const mid = await waitState(c, roomId, seat.id, opId, ['fenced'], 60000);
    ok(mid?.state === 'fenced' && mid?.held >= 1, `stopped right after the fence with the line held (${mid?.held})`);
    await line(c, roomId, '@builder crash-b-12');
    control(null);
    await inst.restartEngine();
    await line(c, roomId, '@builder crash-c-13');
    const s = await waitDone(c, roomId, seat.id, opId, 90000);
    dumpOnFail(inst, s, 'done');
    ok(s?.state === 'done', `the restarted engine resumed the switch from its journal ("${s?.words}")`);
    const w = await watch(inst, c, paneOf(await builderSeat(c)) as string);
    ok(await until(() => w.text().includes('crash-c-13'), 20000), 'every line reached the new Claude');
    const t = w.text();
    ok(['crash-a-11', 'crash-b-12', 'crash-c-13'].every((x) => count(t, x) === 1) && t.indexOf('crash-a-11') < t.indexOf('crash-b-12') && t.indexOf('crash-b-12') < t.indexOf('crash-c-13'), 'exactly once each, in order');
    w.close();
  }

  console.log('crash at the RELEASE boundary (released, not yet done): nothing doubled, nothing dropped');
  {
    const { roomId, seat } = await liveBuilder(inst, c); // Claude now
    control({ haltAt: 'released' });
    const opId = await begin(c, roomId, seat.id, 'codex', 'Claude -> Codex, crash after release');
    await line(c, roomId, '@builder release-d-21');
    await line(c, roomId, '@builder release-e-22');
    const mid = await waitState(c, roomId, seat.id, opId, ['lead-committed'], 90000);
    await until(async () => (await status(c, roomId, seat.id, opId))?.held === 0, 10000);
    ok(mid?.state === 'lead-committed', 'the lead moved and the held lines were released; then the engine dies');
    const cancel = await c.post(`/api/rooms/${roomId}/seats/${seat.id}/switch/${opId}/cancel`, {});
    ok(cancel.status === 409, 'after the transfer cancel is refused: the new assistant is kept, never reverted');
    /* the crash lands AFTER the typer's own paste -> Tab write (Codex: 600 ms): a crash inside that window leaves a line
       typed but unsent in the composer, which is the typer's window, not the switch's (backlog, job 3) */
    await sleep(2500);
    control(null);
    await inst.restartEngine();
    const s = await waitDone(c, roomId, seat.id, opId, 60000);
    ok(s?.state === 'done', `resumed to done ("${s?.words}")`);
    /* what the program itself heard (its own log: the restarted engine's screen replay starts at adoption) */
    ok(await until(() => codexHeard(inst).includes('release-e-22'), 75000), 'both lines reached the new Codex (a line restored after a restart waits for an idle, or the typer\'s 60 s fallback)');
    await sleep(3000);
    const t = codexHeard(inst);
    ok(count(t, 'release-d-21') === 1 && count(t, 'release-e-22') === 1 && t.indexOf('release-d-21') < t.indexOf('release-e-22'), 'exactly once each, in order: the resumed switch released nothing twice');
  }
} finally {
  await inst.stop();
}

console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
