/**
 * THE ROOM'S SWITCH HOST (the design notes §3 item 1) and the background RUNNER that drives one
 * operation to its end. `wiring.ts` holds the ordering; this file turns each host verb into an engine action:
 *
 *   endOld        = close its windows + end it for a cycle (EndReason 'cycle', the room Disconnect's end)
 *   stopped       = CONFIRMED stop: the row is not live AND the broker that held it answers (else unknown)
 *   restoreOld    = rooms.ts restores the old seat (a no-op when it never stopped; the restored pane keeps its id)
 *   launchTarget  = launch the target recipe FRESH and headless, with the preset as per-launch overrides, then drive it
 *                   past startup; a login or trust screen holds the handover and fails the switch before transfer
 *   sessionIdOf   = the id the vendor banked on the new pane's row (Claude: engine-minted; Codex: its SessionStart hook)
 *   typeLine      = the room typer's guarded path (startup, idle, no draft)
 *   historyHas    = read-only evidence in the target's own persisted history: Claude's transcript, Codex's
 *                   UserPromptSubmit hook record
 *   swapSeat      = remove the old seat and add the target's with the SAME handle, lead restored, in ONE transaction,
 *                   refused (`lead-changed`) unless the room's lead is still what it was when the switch began
 *
 * Every effect that needs a request's deps (launch, end, drive, restore) comes in through `RoomSwitchOps`, built by
 * rooms.ts, so this file imports nothing from the server and has no import cycle.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rollback, table } from '../../table/endpoint.ts';
import type { HeldItem, SwitchRow, SwitchState } from '../../table/store.ts';
import * as roomTyper from '../room-typer.ts';
import { transcriptPath } from '../vendors/claude-code.ts';
import type { HistoryExtract } from './packet.ts';
import { runExtractor } from './packet-sources.ts';
import { PRESETS, presetOfVendor } from './sibling.ts';
import type { Readiness } from './vendor-ready.ts';
import { makeSwitchDeps, type SwitchHost } from './wiring.ts';
import { runSwitch, type RunOptions, type RunResult } from './fsm.ts';

const EXTRACTOR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'vendor', 'history-extract.mjs');

export type DriveAnswer = { ok: true } | { ok: false; reason: string; detail?: string };

export interface RoomSwitchOps {
  log(line: string): void;
  launch(recipeId: string, body: Record<string, unknown>, onPane: (paneid: string) => void): Promise<{ paneid: string }>;
  endForCycle(paneid: string): Promise<{ ended: boolean; state: string | null }>;
  closeWindow(paneid: string): Promise<unknown>;
  /** attach as a headless viewer and wait until the pane is past startup (seat-reload-drive) */
  drive(paneid: string, recipeId: string): Promise<DriveAnswer>;
  /** true = provably not running; false = running; null = could not tell */
  paneStopped(paneid: string): boolean | null;
  /** the target vendor's login state in the target pane's own environment (three outcomes) */
  vendorReady(vendor: string, recipeId: string): Promise<Readiness>;
  /** the pane's pty (and so its transcripts) is on this engine's host */
  localPane(paneid: string): boolean;
  /** bring the old seat's assistant back; `unchanged` = it never stopped */
  restoreSeat(op: SwitchRow): Promise<{ ok: boolean; paneid: string | null; unchanged?: boolean; message?: string }>;
}

const brand = (vendor: string): string => (vendor === 'codex-cli' ? 'Codex' : vendor === 'claude-code' ? 'Claude' : vendor);

/** What a startup that did not reach ready means for the switch (the wizard's guidance comes from `reason`). */
export function notReady(vendor: string, d: { reason: string; detail?: string }): { reason: string; message: string } {
  const who = brand(vendor);
  const kind = d.detail ?? '';
  if (d.reason === 'needs-you' && /login/.test(kind)) {
    return { reason: 'login-needed', message: `${who} needs signing in before it can take over. Sign in to ${who}, then try again.` };
  }
  if (d.reason === 'needs-you' && /permission|trust/.test(kind)) {
    return { reason: 'trust-needed', message: `${who} is asking whether to trust the project folder. Nothing was answered for you; open ${who} once in this project, trust it, then try again.` };
  }
  if (d.reason === 'needs-you') {
    return { reason: 'needs-you', message: `${who} is waiting on a question only you can answer (${kind || 'a prompt'}).` };
  }
  return { reason: 'target-not-ready', message: `${who} did not finish starting (${d.reason}${d.detail ? `: ${d.detail}` : ''}).` };
}

function projectDirOf(recipeId: string): string | null {
  return table.getRecipe(recipeId)?.projectDir || null;
}

/** Does Claude's transcript for `sessionId` hold a USER message containing `needle`? Read-only. */
export function claudeTranscriptHas(dir: string, sessionId: string, needle: string): boolean {
  const path = transcriptPath(dir, sessionId);
  if (!existsSync(path)) return false;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    if (!line.includes(needle)) continue;
    try {
      const j = JSON.parse(line);
      if (j && j.type === 'user' && JSON.stringify(j.message ?? '').includes(needle)) return true;
    } catch {
      /* a torn last line: not evidence */
    }
  }
  return false;
}

export function makeRoomSwitchHost(ops: RoomSwitchOps): SwitchHost {
  return {
    log: (l) => ops.log(l),
    projectDirOf,
    sessionIdWaitMs: Number(process.env.HARBOR_WB_SWITCH_SESSION_WAIT_MS) || 30_000,

    async vendorReady(vendor, op) {
      return ops.vendorReady(vendor, op.to_recipe_id);
    },

    async extractHistory(op): Promise<HistoryExtract | null> {
      const paneid = op.from_paneid;
      const sid = paneid ? table.get(paneid)?.session_id : null;
      const cwd = projectDirOf(op.from_recipe_id);
      if (!paneid || !sid || !cwd || !ops.localPane(paneid)) return null;
      return runExtractor({ script: EXTRACTOR, vendor: op.from_vendor, sessionId: sid, cwd });
    },

    queuedOf: (paneid) => roomTyper.peekQueue(paneid) as unknown as HeldItem[],
    forgetQueued: (paneid) => roomTyper.forgetQueue(paneid),
    deliverReleased: (paneid, items) => roomTyper.adoptReleased(paneid, items as roomTyper.DrainedItem[]),

    async endOld(paneid) {
      try {
        await ops.closeWindow(paneid);
      } catch (e) {
        ops.log(`switch: closing ${paneid}'s windows failed (continuing): ${(e as Error).message}`);
      }
      return ops.endForCycle(paneid);
    },

    stopped: (paneid) => ops.paneStopped(paneid),

    restoreOld: (op) => ops.restoreSeat(op),

    targetFor(op) {
      const paneid = op.launched_paneid ?? op.target_paneid ?? null;
      const row = paneid ? table.get(paneid) : undefined;
      if (!paneid || !row || row.state !== 'live') return null;
      return { paneid, sessionId: row.session_id || null };
    },

    async launchTarget(op, onPane) {
      let paneid: string;
      try {
        const body: Record<string, unknown> = { fresh: true, target: 'tab', surface: 'browser' };
        if (op.to_model) body.model = op.to_model;
        if (op.to_effort) body.effort = op.to_effort;
        paneid = (await ops.launch(op.to_recipe_id, body, onPane)).paneid;
      } catch (e) {
        return { ok: false, reason: 'launch-failed', message: `${brand(op.to_vendor)} could not be started: ${(e as Error).message}` };
      }
      onPane(paneid);
      let d: DriveAnswer;
      try {
        d = await ops.drive(paneid, op.to_recipe_id);
      } catch (e) {
        d = { ok: false, reason: 'spawn-failed', detail: (e as Error).message };
      }
      if (!d.ok) {
        return { ok: false, ...notReady(op.to_vendor, d) };
      }
      return { ok: true, paneid };
    },

    async endTarget(paneid) {
      if (table.get(paneid)?.state !== 'live') return;
      try {
        await ops.closeWindow(paneid);
      } catch {
        /* best effort: the end below is what matters */
      }
      await ops.endForCycle(paneid);
    },

    sessionIdOf: (paneid) => table.get(paneid)?.session_id || null,

    async typeLine(paneid, text) {
      const r = roomTyper.enqueueHandover(paneid, text);
      return r === 'injected' || r === 'queued';
    },

    async historyHas(op, needle) {
      const paneid = op.target_paneid;
      if (!paneid || !op.target_session_id) return false;
      if (op.to_vendor === 'codex-cli') {
        return table.listPaneChat(paneid, { limit: 200 }).rows.some((r) => r.role === 'user' && r.text.includes(needle));
      }
      if (op.to_vendor === 'claude-code') {
        const dir = projectDirOf(op.to_recipe_id);
        return !!dir && ops.localPane(paneid) && claudeTranscriptHas(dir, op.target_session_id, needle);
      }
      return false;
    },

    swapSeat(op) {
      const old = op.from_seat_id ? table.getSeat(op.from_seat_id) : undefined;
      const target = op.target_paneid;
      if (!old || !target) {
        return { ok: false, reason: 'missing-seat', message: 'the seat being switched is gone' };
      }
      /* a replay after a crash between the swap's commit and the journal move: already done */
      if (table.listSeats(op.room_id).some((s) => s.occupant_kind === 'pane' && s.occupant === target)) {
        return { ok: true };
      }
      const r = table.roomBatch((tx) => {
        const room = table.getRoom(op.room_id);
        if (!room || room.state !== 'open') {
          throw new Rollback({ ok: false as const, reason: 'room-closed', message: 'the room is no longer open' });
        }
        if ((room.lead_seat ?? null) !== (op.expected_lead_seat ?? null)) {
          throw new Rollback({ ok: false as const, reason: 'lead-changed', message: 'the room\'s lead changed while switching; nothing was moved' });
        }
        const wasLead = room.lead_seat === old.id;
        tx.removeSeat(room.id, old.id, { actor: 'user', allowLeadRemoval: wasLead });
        const added = tx.addSeat(
          room.id,
          { handle: old.handle, policy: old.policy, pool_size: old.pool_size, recipe_id: op.to_recipe_id, occupant: target, autoLead: false },
          { actor: 'user' },
        );
        if (wasLead) {
          tx.updateRoom(room.id, { lead_seat: added.result.id }, { actor: 'user' });
        }
        return { ok: true as const };
      });
      if (!r.committed || !r.value.ok) {
        return r.value as unknown as { ok: false; reason: string; message: string };
      }
      const p = PRESETS[presetOfVendor(op.to_vendor) ?? 'claude'];
      try {
        table.appendLine(
          op.room_id,
          { kind: 'fact', body: `@${old.handle} now runs on ${brand(op.to_vendor)} (${op.to_model ?? p.model}, ${op.to_effort ?? p.effort} effort); the conversation was handed over from ${brand(op.from_vendor)}` } as any,
          { actor: 'user' },
        );
      } catch (e) {
        ops.log(`switch ${op.op_id}: room fact not written: ${(e as Error).message}`);
      }
      return { ok: true };
    },
  };
}

/* ---- the background runner ------------------------------------------------------------------
 * ONE runner per operation in this process. The person's Continue / Cancel flip flags on the live
 * control object; runSwitch reads them at every step. A runner that stops `waiting` is retried on a
 * short clock until RUN_WAIT_MS, then left for the person (context unconfirmed) or the sweep. */
interface Control {
  opts: RunOptions;
  running: boolean;
}
const controls = new Map<string, Control>();
const RUN_WAIT_MS = (): number => Number(process.env.HARBOR_WB_SWITCH_WAIT_MS) || 90_000;
const RUN_TICK_MS = (): number => Number(process.env.HARBOR_WB_SWITCH_TICK_MS) || 2_000;

function controlOf(opId: string): Control {
  let c = controls.get(opId);
  if (!c) {
    c = { opts: process.env.HARBOR_WB_SWITCH_CONTROL_FILE ? { haltAt: () => testControl().haltAt } : {}, running: false };
    controls.set(opId, c);
  }
  return c;
}

/** TEST-ONLY, inert unless HARBOR_WB_SWITCH_CONTROL_FILE is set (the scratch acceptance suite): a JSON file
 *  `{haltAt?: <state> | 'released', unreachable?: true}` that stops a runner at a boundary (the suite then kills the
 *  engine, which is the crash) or makes a fence's stop unconfirmable (an unreachable host). Re-read on every use. */
export function testControl(): { haltAt?: string; unreachable?: boolean } {
  const p = process.env.HARBOR_WB_SWITCH_CONTROL_FILE;
  if (!p) return {};
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export function isRunning(opId: string): boolean {
  return controls.get(opId)?.running === true;
}

/** Start (or nudge) the runner for one operation. Never throws; never two at once. */
export function startRunner(opId: string, ops: RoomSwitchOps, flags: { cancel?: boolean; accept?: boolean } = {}): void {
  const c = controlOf(opId);
  if (flags.cancel) c.opts.cancel = true;
  if (flags.accept) c.opts.acceptUncertainContext = true;
  if (c.running) return;
  c.running = true;
  const deps = makeSwitchDeps(makeRoomSwitchHost(ops));
  void (async () => {
    const deadline = Date.now() + RUN_WAIT_MS();
    let last: RunResult | null = null;
    try {
      for (;;) {
        last = await runSwitch(opId, deps, c.opts);
        if (!last.waiting || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, RUN_TICK_MS()));
      }
      ops.log(`switch ${opId}: runner stopped at ${last?.row.state}${last?.waiting ? ' (waiting)' : ''}`);
    } catch (e) {
      ops.log(`switch ${opId}: runner threw: ${(e as Error)?.stack ?? e}`);
    } finally {
      c.running = false;
      if (last && !last.waiting) controls.delete(opId);
    }
  })();
}

/** Boot and the periodic sweep: every active operation not already running is driven again. */
export function resumeAll(ops: RoomSwitchOps): number {
  let n = 0;
  for (const op of table.listActiveSwitches()) {
    if (!isRunning(op.op_id)) {
      startRunner(op.op_id, ops);
      n++;
    }
  }
  return n;
}

/** Tests only. */
export function resetRunners(): void {
  controls.clear();
}

/* ---- plain words (spec §1: never a state name) ---------------------------------------------- */
const REVERSIBLE: SwitchState[] = ['intent', 'packet-saved', 'fenced', 'target-identified', 'banked', 'context-delivered', 'context-accepted'];

export function isReversible(state: SwitchState): boolean {
  return REVERSIBLE.includes(state);
}

/** What the person reads about one operation. */
export function progressWords(op: SwitchRow): { words: string; done: boolean; ok: boolean | null; canCancel: boolean; canContinue: boolean } {
  const to = brand(op.to_vendor);
  const from = brand(op.from_vendor);
  const why = (op.error ?? '').replace(/^[a-z-]+: /, '');
  const reason = (op.error ?? '').split(':')[0];
  const base = { done: false, ok: null as boolean | null, canCancel: isReversible(op.state), canContinue: false };
  switch (op.state) {
    case 'intent':
      return { ...base, words: 'Saving where you are…' };
    case 'packet-saved':
      return { ...base, words: reason === 'fence-unknown' ? `Waiting to confirm ${from} has stopped before starting ${to}…` : `Stopping ${from}…` };
    case 'fenced':
      return { ...base, words: `Starting ${to}…` };
    case 'target-identified':
    case 'banked':
      return { ...base, words: 'Handing over…' };
    case 'context-delivered':
      return { ...base, words: `Handing over… ${to} has the saved summary but has not confirmed reading it yet.`, canContinue: true };
    case 'context-accepted':
      return { ...base, words: 'Handing over…' };
    case 'lead-committed':
      return { ...base, words: op.error ? `${to} has the room; delivering the lines you typed meanwhile (retrying)…` : `${to} has the room; delivering the lines you typed meanwhile…` };
    case 'done':
      return { ...base, done: true, ok: true, canCancel: false, words: `${to} is ready` };
    case 'cancelled':
      return { ...base, done: true, ok: false, canCancel: false, words: recoveryWords(op, from, 'Cancelled.') };
    case 'failed-before-transfer':
      return { ...base, done: true, ok: false, canCancel: false, words: recoveryWords(op, from, why ? `${why}` : 'The switch did not complete.') };
    case 'failed-after-transfer':
      return { ...base, done: true, ok: false, canCancel: false, words: `${to} has the room, but ${why || 'the lines you typed meanwhile could not be delivered'}.` };
    default:
      return { ...base, words: 'Working…' };
  }
}

/** "the old assistant is back" ONLY once the restore succeeded (or it never stopped); otherwise recovery pending. */
function recoveryWords(op: SwitchRow, from: string, said: string): string {
  const lead = /[.!?]$/.test(said.trim()) ? said.trim() : `${said.trim()}.`;
  if (op.recovery === 'restored') return `${lead} ${from} (your previous assistant) is back.`;
  if (op.recovery === 'unchanged') return `${lead} ${from} (your previous assistant) was never stopped.`;
  if (op.recovery === 'pending') return `${lead} Recovery pending: bringing ${from} back (use Start on the seat if it does not return).`;
  return `${lead} Recovery pending.`;
}
