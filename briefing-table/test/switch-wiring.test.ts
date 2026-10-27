/**
 * The switch's engine wiring (src/engine/switch/wiring.ts) driven by the REAL runner and a scratch table against a FAKE host:
 * ordering, what is written where, what happens to held lines, and that a target that never names its conversation is
 * never trusted with the room. No pty, no broker, no vendor.
 *
 * Revised 2026-10-11 (cloud agent, job 3) for the durable transfer: held lines live in the real typer_state and the real
 * journal of a scratch db, so the crash tests at BOTH boundaries (fence, release) check the stored rows, with stable ids:
 * every line once, in order, including one that arrives mid-switch. Plus confirmed fencing (unreachable = wait, never a
 * launch), target cleanup before the transfer only, retry after it, quota advisory, a missing project folder, and the
 * recovery word the wizard reads ("is back" only after the restore succeeded).
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'wb-switch-wiring-'));
process.env.HARBOR_WB_TABLE = join(dir, 'm.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';

const { table } = await import('../src/table/endpoint.ts');
const { runSwitch } = await import('../src/engine/switch/fsm.ts');
const { makeSwitchDeps } = await import('../src/engine/switch/wiring.ts');
const store = await import('../src/table/store.ts');
type SwitchHost = import('../src/engine/switch/wiring.ts').SwitchHost;
type HeldItem = import('../src/table/store.ts').HeldItem;

let failed = 0;
let checks = 0;
const ok = (c: unknown, m: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };

let n = 0;
const newOp = () => {
  n++;
  return table.createSwitch({
    op_id: `wop-${n}`, room_id: `wroom-${n}`, instance_id: 'inst', account_id: 'user', project_id: 'proj',
    from_recipe_id: 'r-claude', from_paneid: `old-pane-${n}`, from_seat_id: 'seat-old', from_vendor: 'claude-code',
    to_recipe_id: 'r-codex', to_vendor: 'codex-cli', to_model: 'gpt-6.1-sol', to_effort: 'medium', note: null, expected_lead_seat: 'seat-old',
  }).row;
};
const item = (entryId: number, text: string): HeldItem => ({ roomId: 'R', entryId, text, msgId: `line ${entryId}` });
const queued = (pane: string): HeldItem[] => {
  const raw = table.getTyperState(pane)?.items;
  return raw ? JSON.parse(raw) : [];
};
const ids = (items: HeldItem[]) => items.map((i) => store.heldIdOf(i)).join(',');

interface Opts { vendor: any; endOk: boolean; sessionId: string | null; seatOk: boolean; historyHas: boolean; unreachable: boolean; restoreOk: boolean; noDir: boolean; deliverThrows: number; endThrows: number }
interface Rig { host: SwitchHost; log: string[]; typed: Array<{ pane: string; text: string }>; delivered: Array<{ pane: string; ids: string }>; ended: string[]; endedTargets: string[]; restored: number; opts: Opts }
function rig(oldPane: string): Rig {
  const stopped = new Set<string>();
  const r: Rig = {
    log: [], typed: [], delivered: [], ended: [], endedTargets: [], restored: 0,
    opts: { vendor: { ok: true }, endOk: true, sessionId: 'codex-sess-1', seatOk: true, historyHas: true, unreachable: false, restoreOk: true, noDir: false, deliverThrows: 0, endThrows: 0 },
    host: null as unknown as SwitchHost,
  };
  r.host = {
    log: (l) => r.log.push(l),
    projectDirOf: () => (r.opts.noDir ? null : dir),
    vendorReady: async () => r.opts.vendor,
    extractHistory: async () => null,
    queuedOf: (p) => queued(p),
    forgetQueued: () => {},
    deliverReleased: (p, items) => {
      if (r.opts.deliverThrows > 0) {
        r.opts.deliverThrows--;
        throw new Error('crash after the release committed');
      }
      r.delivered.push({ pane: p, ids: ids(items) });
    },
    endOld: async (p) => {
      if (r.opts.endThrows > 0) {
        r.opts.endThrows--;
        throw new Error('crash after the hold committed');
      }
      r.ended.push(p);
      if (r.opts.endOk) stopped.add(p);
      return { ended: r.opts.endOk, state: r.opts.endOk ? 'dehydrated' : 'live' };
    },
    stopped: (p) => (r.opts.unreachable ? null : stopped.has(p)),
    restoreOld: async () => {
      r.restored++;
      r.log.push('restoreOld');
      return r.opts.restoreOk ? { ok: true, paneid: oldPane, unchanged: !stopped.has(oldPane) } : { ok: false, paneid: null, message: 'the restore failed' };
    },
    targetFor: () => null,
    launchTarget: async (_op, onPane) => {
      onPane('new-pane');
      return { ok: true, paneid: 'new-pane' };
    },
    endTarget: async (p) => {
      r.endedTargets.push(p);
    },
    sessionIdOf: () => r.opts.sessionId,
    typeLine: async (pane, text) => { r.typed.push({ pane, text }); return true; },
    historyHas: async () => r.opts.historyHas,
    swapSeat: () => (r.opts.seatOk ? { ok: true } : { ok: false, reason: 'lead-changed', message: 'the lead changed' }),
    sessionIdWaitMs: 50,
  };
  return r;
}
/* bankSessionId reads the table row of the target pane: give it one */
const bankRow = (paneid: string, sessionId: string) =>
  table.upsert({ paneid, recipe_id: 'r-codex', server: 'local', vendor: 'codex-cli', agent: null, session_id: sessionId, state: 'live', generation: 1 } as never);
const setup = () => {
  const op = newOp();
  table.setTyperItems(op.from_paneid!, JSON.stringify([item(11, 'held-1'), item(12, 'held-2')]));
  table.setTyperItems('new-pane', null);
  bankRow('new-pane', 'codex-sess-1');
  return { op, r: rig(op.from_paneid!) };
};

console.log('happy path: packet file, one delivery line, held lines move durably to the new pane');
{
  const { op, r } = setup();
  const out = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(out.row.state === 'done', `reaches done (${out.row.state}${out.row.error ? `: ${out.row.error}` : ''})`);
  ok(!!out.row.packet_path && existsSync(out.row.packet_path) && /Handover|handover|Pick up here/.test(readFileSync(out.row.packet_path, 'utf8')), 'the packet file exists and reads as a handover');
  ok(r.typed.length === 1 && r.typed[0].pane === 'new-pane' && r.typed[0].text.includes(op.op_id) && r.typed[0].text.includes(String(out.row.packet_sha256)), 'exactly one line is typed into the NEW pane, naming the packet and its digest');
  ok(queued(op.from_paneid!).length === 0, "the old pane's persisted queue is empty");
  ok(ids(queued('new-pane')) === 'R:11,R:12', "both held lines are in the NEW pane's persisted queue, once, in order");
  ok(r.delivered.length === 1 && r.delivered[0].pane === 'new-pane' && r.delivered[0].ids === 'R:11,R:12', 'and handed to its typer once');
  ok(table.heldSwitchLines(op.op_id).length === 0, 'the journal holds nothing afterwards');
  ok(r.ended.join() === op.from_paneid && r.endedTargets.length === 0, 'the old pane was ended once; the new one is kept');
}

console.log('crash at the FENCE boundary (after the hold committed, before the end), a line arrives mid-switch, resume');
{
  const { op, r } = setup();
  r.opts.endThrows = 1;
  let threw = false;
  try {
    await runSwitch(op.op_id, makeSwitchDeps(r.host));
  } catch {
    threw = true;
  }
  ok(threw && table.getSwitch(op.op_id)?.state === 'packet-saved', 'the "crash" leaves the operation at packet-saved');
  ok(ids(table.heldSwitchLines(op.op_id)) === 'R:11,R:12' && queued(op.from_paneid!).length === 0, 'the lines are in the journal and gone from the old queue: nothing in between to lose');
  table.appendSwitchLine(op.op_id, item(13, 'typed during the switch'));
  const out = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(out.row.state === 'done', `the resumed operation completes (${out.row.state})`);
  ok(ids(queued('new-pane')) === 'R:11,R:12,R:13', 'every line reaches the new assistant exactly once, in order, the mid-switch one last');
}

console.log('crash at the RELEASE boundary: before the commit, then after it; resume');
{
  const { op, r } = setup();
  const crashing = makeSwitchDeps(r.host);
  crashing.releaseHeld = async () => {
    throw new Error('crash before the release committed');
  };
  const first = await runSwitch(op.op_id, crashing);
  ok(first.waiting && first.row.state === 'lead-committed', 'stops after the transfer, waiting to retry');
  ok(ids(table.heldSwitchLines(op.op_id)) === 'R:11,R:12' && queued('new-pane').length === 0, 'before the commit: the lines are still in the journal');
  r.opts.deliverThrows = 1;
  const second = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(second.waiting && second.row.state === 'lead-committed' && r.endedTargets.length === 0, 'a crash AFTER the commit: still lead-committed, the new assistant is kept');
  ok(table.heldSwitchLines(op.op_id).length === 0 && ids(queued('new-pane')) === 'R:11,R:12', "after the commit: the lines are in the new pane's queue and nowhere else");
  const third = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(third.row.state === 'done' && ids(queued('new-pane')) === 'R:11,R:12', 'the retry completes without doubling a line');
}

console.log('the vendor is not ready: nothing is touched; quota is only a warning');
{
  const { op, r } = setup();
  r.opts.vendor = { ok: false, reason: 'login-needed', message: 'Sign in to ChatGPT first' };
  const out = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(out.row.state === 'failed-before-transfer' && /login-needed/.test(String(out.row.error)), "fails before transfer with the vendor's reason");
  ok(r.ended.length === 0 && r.typed.length === 0 && table.getSwitch(op.op_id)?.recovery === 'unchanged', 'the old assistant was never ended (recovery: unchanged)');
  const q = setup();
  q.r.opts.vendor = { ok: false, reason: 'quota-blocked', message: 'near the weekly limit' };
  ok((await runSwitch(q.op.op_id, makeSwitchDeps(q.r.host))).row.state === 'done', 'a quota warning never refuses');
  const w = setup();
  w.r.opts.vendor = { ok: true, warn: 'could not confirm Codex is signed in' };
  ok((await runSwitch(w.op.op_id, makeSwitchDeps(w.r.host))).row.state === 'done' && w.r.log.some((l) => /preflight warning/.test(l)), 'an unknown login warns and proceeds');
}

console.log('no project folder: a failure, never stuck at intent');
{
  const { op, r } = setup();
  r.opts.noDir = true;
  const out = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(out.row.state === 'failed-before-transfer' && /packet-failed/.test(String(out.row.error)), `fails before transfer (${out.row.error})`);
}

console.log('confirmed fencing: an unreachable host is unknown, so wait and launch nothing');
{
  const { op, r } = setup();
  r.opts.unreachable = true;
  const out = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(out.waiting && out.row.state === 'packet-saved' && /fence-unknown/.test(String(out.row.error)), 'waits at packet-saved with fence-unknown');
  ok(r.ended.length === 0 && r.typed.length === 0 && !table.getSwitch(op.op_id)?.launched_paneid, 'nothing was ended and no target was launched');
  ok(ids(table.heldSwitchLines(op.op_id)) === 'R:11,R:12', 'the held lines are safe in the journal meanwhile');
  r.opts.unreachable = false;
  const later = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(later.row.state === 'done' && ids(queued('new-pane')) === 'R:11,R:12', 'once the host answers, the switch completes with every line');
}

console.log('the old assistant would not end: its lines go back to it');
{
  const { op, r } = setup();
  r.opts.endOk = false;
  const out = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(out.row.state === 'failed-before-transfer' && /old-would-not-end/.test(String(out.row.error)), 'fails before transfer, saying why');
  ok(ids(queued(op.from_paneid!)) === 'R:11,R:12', "the lines are back in the old pane's queue");
}

console.log('the new assistant never names its conversation: its pane is ended, the old one comes back');
{
  const { op, r } = setup();
  r.opts.sessionId = null;
  const out = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(out.row.state === 'failed-before-transfer' && /session-id-unknown/.test(String(out.row.error)), 'fails before transfer: session-id-unknown');
  ok(r.endedTargets.join() === 'new-pane', 'the launched target is ended (it was journaled the moment it existed)');
  ok(r.restored === 1 && table.getSwitch(op.op_id)?.recovery === 'restored' && ids(queued(op.from_paneid!)) === 'R:11,R:12', 'the old assistant is back with its lines (recovery: restored)');
  ok(r.typed.length === 0, 'nothing was typed into the stranger');
}

console.log('the restore itself fails: recovery pending, never "is back"');
{
  const { op, r } = setup();
  r.opts.sessionId = null;
  r.opts.restoreOk = false;
  const out = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(out.row.state === 'failed-before-transfer' && table.getSwitch(op.op_id)?.recovery === 'pending', 'recovery: pending');
  ok(ids(table.heldSwitchLines(op.op_id)) === 'R:11,R:12', 'the lines stay safe in the journal until a pane can take them');
}

console.log('the lead changed during the switch: refused, target ended, old restored');
{
  const { op, r } = setup();
  r.opts.seatOk = false;
  const out = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(out.row.state === 'failed-before-transfer' && /lead-changed/.test(String(out.row.error)), 'fails before transfer: lead-changed');
  ok(r.endedTargets.join() === 'new-pane' && r.restored === 1, 'the target is ended and the old assistant restored');
}

console.log('context not confirmed: waits; cancel ends the target; or a person can continue');
{
  const { op, r } = setup();
  r.opts.historyHas = false;
  const first = await runSwitch(op.op_id, makeSwitchDeps(r.host));
  ok(first.waiting && first.row.state === 'context-delivered', 'stops at context-delivered, waiting');
  const c = setup();
  c.r.opts.historyHas = false;
  await runSwitch(c.op.op_id, makeSwitchDeps(c.r.host));
  const cancelled = await runSwitch(c.op.op_id, makeSwitchDeps(c.r.host), { cancel: true });
  ok(cancelled.row.state === 'cancelled' && c.r.endedTargets.join() === 'new-pane' && c.r.restored === 1, 'cancel before the transfer: target ended, old restored');
  const cont = await runSwitch(op.op_id, makeSwitchDeps(r.host), { acceptUncertainContext: true });
  ok(cont.row.state === 'done', 'continues to done when the person accepts');
  ok(r.typed.length === 1, 'the handover line was still typed only once');
}

console.log(`\nPASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
