/**
 * THE SWITCH'S ENGINE WIRING [ticket]: turns the FSM's steps (fsm.ts) into engine actions through a small HOST interface.
 *
 * Why a host interface: every action here (end a pane, launch a recipe, type a line, move a seat) already lives in rooms.ts /
 * index.ts and needs a request's deps. The host is built there; this module holds only the ORDERING and the decisions, so
 * the whole thing runs in a unit test against a fake host with no pty, no broker and no vendor.
 *
 * CLI-FIRST (Owner [ref], connector [ref]): the target's session id is whatever the vendor's own hook banked on the table row
 * for the new pane. If it never arrives the switch HOLDS (before the transfer), restoring the old assistant: it never
 * guesses an id, and never moves the lead onto a session it cannot name.
 *
 * REVISED 2026-10-11 (cloud agent, job 3, after the server agents' review):
 *  - HELD LINES MOVE DURABLY (spec §3 item 4): the old pane's queued lines go into the journal and out of its persisted
 *    typer queue in ONE transaction (store.holdSwitchLines); release writes them into the receiving pane's persisted queue
 *    and empties the journal in ONE transaction (store.releaseSwitchLines), deduplicated by a stable id. No in-memory map.
 *  - FENCING IS CONFIRMED (§3 item 1): a pane counts as stopped only when the host can prove it (`stopped` true). An
 *    unreachable host is UNKNOWN: the step answers `fence-unknown`, the runner waits and retries, and no target launches.
 *  - TARGET CLEANUP BEFORE TRANSFER ONLY: a launched target is ended on cancel and on any failure before the lead moves
 *    (restoreOld does both, target first: one active writer). After the transfer the new assistant is kept.
 *  - QUOTA IS ADVISORY (§4): a quota warning never refuses; an unknown login warns and proceeds.
 */
import { table } from '../../table/endpoint.ts';
import type { HeldItem, SwitchRow } from '../../table/store.ts';
import type { StepFailure, SwitchDeps } from './fsm.ts';
import { contextLine } from './fsm.ts';
import { buildPacket, type HistoryExtract, type PacketInput } from './packet.ts';
import { gatherGit, gatherNotes, gatherRoomLines, savePacketFile } from './packet-sources.ts';

export interface SwitchHost {
  log(line: string): void;
  /** the project folder the recipe works in (the packet is written inside it), or null when it has none */
  projectDirOf(recipeId: string): string | null;
  /** Can the target vendor start for this person right now? `warn` = could not tell, or quota: proceed anyway. */
  vendorReady(vendor: string, op: SwitchRow): Promise<{ ok: true; warn?: string } | { ok: false; reason: 'login-needed' | 'not-installed' | 'quota-blocked' | 'unavailable'; message: string }>;
  /** the vendored read-only history extractor on the OLD session's transcript; null = unavailable (the packet is built without it) */
  extractHistory(op: SwitchRow): Promise<HistoryExtract | null>;
  /** the old pane's queued typer items, NOT removed (the journal move removes them, durably) */
  queuedOf(paneid: string): HeldItem[];
  /** clear a pane's IN-MEMORY typer queue once the journal holds its lines (its persisted queue is already empty) */
  forgetQueued(paneid: string): void;
  /** hand lines that were just written into a pane's persisted queue to its in-memory typer, oldest first */
  deliverReleased(paneid: string, items: HeldItem[]): void;
  /** end the old pane at a safe boundary (EndReason cycle). `ended:false` = it would not end, nothing changed. */
  endOld(paneid: string): Promise<{ ended: boolean; state: string | null }>;
  /** CONFIRMED stop: true = provably not running; false = running; null = could not tell (its host is unreachable) */
  stopped(paneid: string): boolean | null;
  /** Bring the old seat's assistant back. `unchanged` = it never stopped. The pane id it now runs in. */
  restoreOld(op: SwitchRow): Promise<{ ok: boolean; paneid: string | null; unchanged?: boolean; message?: string }>;
  /** the LIVE pane already launched for THIS operation (idempotency), if any, with its session id once banked */
  targetFor(op: SwitchRow): { paneid: string; sessionId: string | null } | null;
  /** launch the target recipe fresh and drive it past startup; `onPane` is called the moment its pane id exists */
  launchTarget(op: SwitchRow, onPane: (paneid: string) => void): Promise<{ ok: true; paneid: string } | { ok: false; reason: string; message: string }>;
  /** end a target launched for this operation (only ever before the lead transfer) */
  endTarget(paneid: string): Promise<void>;
  /** the session id the vendor banked for that pane, or null while unknown */
  sessionIdOf(paneid: string): string | null;
  /** type one line into a pane as the room's typer would (queued if the composer is busy); true = accepted by the typer */
  typeLine(paneid: string, text: string): Promise<boolean>;
  /** does the target's persisted history contain this operation's delivered line? read-only evidence */
  historyHas(op: SwitchRow, needle: string): Promise<boolean>;
  /** Replace the room's old seat with the target's, same handle, in ONE transaction; the lead moves ONLY if the
   *  room's lead is still `op.expected_lead_seat`. */
  swapSeat(op: SwitchRow): { ok: true } | { ok: false; reason: string; message: string };
  /** how long to wait for the vendor to bank the session id */
  sessionIdWaitMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function makeSwitchDeps(host: SwitchHost): SwitchDeps {
  const fail = (reason: string, message: string): StepFailure => ({ ok: false, reason, message });
  /** release the journal's lines into `paneid` (its persisted queue first, then its typer) */
  const release = (op: SwitchRow, paneid: string): number => {
    const added = table.releaseSwitchLines(op.op_id, paneid);
    if (added.length) {
      host.deliverReleased(paneid, added);
    }
    return added.length;
  };

  return {
    log: (l) => host.log(l),

    async preflight(op) {
      const r = await host.vendorReady(op.to_vendor, op);
      if (r.ok) {
        if (r.warn) host.log(`switch ${op.op_id}: preflight warning (proceeding): ${r.warn}`);
        return { ok: true };
      }
      if (r.reason === 'quota-blocked') {
        host.log(`switch ${op.op_id}: quota warning (advisory, proceeding): ${r.message}`);
        return { ok: true };
      }
      return fail(r.reason, r.message);
    },

    async savePacket(op) {
      const dir = host.projectDirOf(op.from_recipe_id) ?? host.projectDirOf(op.to_recipe_id);
      if (!dir) {
        throw new Error('the project has no folder to save the handover in');
      }
      const input: PacketInput = {
        op: {
          opId: op.op_id, roomId: op.room_id, projectId: op.project_id, instanceId: op.instance_id, createdAt: op.created_at,
          from: { vendor: op.from_vendor, model: null, effort: null },
          to: { vendor: op.to_vendor, model: op.to_model, effort: op.to_effort },
          note: op.note,
        },
        project: { dir, worktree: null },
        roomLines: gatherRoomLines(op.room_id),
        notes: gatherNotes(op.room_id, Date.now()),
        git: await gatherGit(dir),
        unfinished: [],
        attachments: [],
        history: await host.extractHistory(op),
      };
      const p = buildPacket(input);
      return savePacketFile(dir, op.op_id, p.text);
    },

    async fence(op) {
      const paneid = op.from_paneid;
      if (!paneid) {
        return fail('no-old-pane', 'the assistant being replaced has no running session to hand over from');
      }
      /* the queued lines move into the journal FIRST, durably, so whatever happens next they are not lost */
      table.holdSwitchLines(op.op_id, paneid, host.queuedOf(paneid));
      host.forgetQueued(paneid);
      const before = host.stopped(paneid);
      if (before === true) {
        return { ok: true, fromPaneid: paneid }; // a replay after a crash between the end and the journal move
      }
      if (before === null) {
        return fail('fence-unknown', 'cannot confirm the current assistant stopped (its host is unreachable); waiting before starting the new one');
      }
      const ended = await host.endOld(paneid);
      if (!ended.ended) {
        release(op, paneid); // nothing changed: its lines go back where they were
        return fail('old-would-not-end', `the current assistant did not end (state ${ended.state ?? 'unknown'}); nothing was changed`);
      }
      if (host.stopped(paneid) !== true) {
        return fail('fence-unknown', 'the current assistant was asked to end but its stop cannot be confirmed yet; waiting');
      }
      return { ok: true, fromPaneid: paneid };
    },

    async restoreOld(op) {
      /* ONE active writer: a target launched for this operation goes first. Re-read: the runner may hold a row from
         before the launch was journaled. */
      const cur = table.getSwitch(op.op_id) ?? op;
      const launched = cur.target_paneid ?? cur.launched_paneid ?? null;
      if (launched) {
        try {
          await host.endTarget(launched);
        } catch (e) {
          host.log(`switch ${op.op_id}: ending the launched target ${launched} failed: ${(e as Error).message}`);
        }
      }
      const r = await host.restoreOld(op);
      table.setSwitchRecovery(op.op_id, r.ok ? (r.unchanged ? 'unchanged' : 'restored') : 'pending');
      if (r.ok && r.paneid) {
        release(op, r.paneid);
      }
      if (!r.ok) {
        throw new Error(r.message ?? 'the previous assistant could not be restored');
      }
    },

    async findTarget(op) {
      const t = host.targetFor(op);
      return t && t.sessionId ? { paneid: t.paneid, sessionId: t.sessionId } : null;
    },

    async startTarget(op) {
      /* a target this operation already launched and that is still running is WAITED ON, never launched twice */
      let paneid = host.targetFor(op)?.paneid ?? null;
      if (!paneid) {
        const l = await host.launchTarget(op, (p) => table.noteSwitchLaunch(op.op_id, p));
        if (!l.ok) return fail(l.reason, l.message);
        table.noteSwitchLaunch(op.op_id, l.paneid);
        paneid = l.paneid;
      }
      const deadline = Date.now() + (host.sessionIdWaitMs ?? 30_000);
      let id = host.sessionIdOf(paneid);
      while (!id && Date.now() < deadline) {
        await sleep(500);
        id = host.sessionIdOf(paneid);
      }
      if (!id) {
        const who = op.to_vendor === 'codex-cli' ? 'Codex' : op.to_vendor === 'claude-code' ? 'Claude' : op.to_vendor;
        return fail('session-id-unknown', `the new ${who} assistant started but never reported which conversation it is, so it cannot be trusted with the room`);
      }
      return { ok: true, paneid, sessionId: id };
    },

    async bankSessionId(op) {
      if (!op.target_paneid || !op.target_session_id) {
        return fail('missing-target', 'no target to bank');
      }
      const r = table.get(op.target_paneid);
      if (!r || r.session_id !== op.target_session_id) {
        return fail('bank-mismatch', 'the new assistant\'s conversation id changed before it was recorded');
      }
      return { ok: true, bindingRevision: op.revision };
    },

    async deliverContext(op) {
      if (!op.target_paneid) return fail('missing-target', 'no target to deliver to');
      const ok = await host.typeLine(op.target_paneid, contextLine(op));
      return ok ? { ok: true } : fail('not-delivered', 'the new assistant could not take the handover line');
    },

    async contextAccepted(op) {
      return (await host.historyHas(op, op.op_id)) ? 'accepted' : 'waiting';
    },

    async transferLead(op) {
      const r = host.swapSeat(op);
      return r.ok ? { ok: true } : fail(r.reason, r.message);
    },

    async releaseHeld(op) {
      if (!op.target_paneid) return;
      release(op, op.target_paneid);
    },
  };
}
