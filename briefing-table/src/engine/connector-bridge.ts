/**
 * THE ENGINE HALF OF THE CODEX CONNECTOR CONTRACT (ticket / 2031 / 2032) — DISABLED SCAFFOLDING.
 *
 * Contract: the connector repo's the design notes and the design notes.
 * Nothing here talks to a connector: no process is started and no resident is dispatched. What it
 * gives the engine is the seams the review named, all INERT until a binding row exists (rows are
 * only ever created by code that checks `enabled()`, i.e. HARBOR_WB_CONNECTOR=1):
 *
 *   1. identity     a STABLE runtime id per bound seat, never derived from a pane, and an
 *                   INCARNATION that is the connector's fence. `sessions.generation` bumps on
 *                   every spawn and is NOT the fence; incarnations move only by an explicit
 *                   handoff (store.handoffConnectorBinding, one transaction, intent replayed
 *                   until the connector acknowledges).
 *   2. guards       a connector-owned pane has ONE writer (the connector): the room typer and
 *                   raw pty input refuse it (`isOwned`), and hook / adoption id banking is
 *                   refused in the store so the connector's threadId stays authoritative.
 *   3. journal      the engine's durable outbox: a revisioned compare-and-set row per runtime,
 *                   handed to the connector as its DeliveryJournal.
 *   4. dedup        ONE canonical submission id per room line / fabric envelope, with a content
 *                   hash: same id + same content is a duplicate (never re-sent), same id +
 *                   different content is refused. Scoped to the runtime, so it spans handoffs.
 *
 * Kept free of the connector package on purpose: the shapes below are structural.
 */
import { createHash } from 'node:crypto';
import { table } from '../table/endpoint.ts';

/** Off unless explicitly turned on. Existing routes never consult anything but `isOwned`. */
export function enabled(): boolean {
  return process.env.HARBOR_WB_CONNECTOR === '1';
}

/** Does a connector binding own this pane? True whenever a row exists, flag or not: a pane that
 *  was bound must never fall back to a second writer because the flag was switched off. */
export function isOwned(paneid: string | null | undefined): boolean {
  return !!paneid && !!table.connectorBindingForPane(paneid);
}

/* ---- canonical submission ids ------------------------------------------------------------ */

/** A room line addressed to one seat. The same id the fabric envelope for that line carries
 *  (room:<room>:<entry>:<seat>) in canonical form, so the typed, channel and room-fabric thread
 *  copies of ONE line are ONE submission. */
export function roomSubmissionId(roomId: string, entryId: number, seatId: string): string {
  return `room:${roomId}:line:${entryId}:seat:${seatId}`;
}

/** A fabric message that is not a room line. */
export function fabricSubmissionId(envelopeId: string): string {
  return `fabric:${envelopeId}`;
}

export function contentHash(text: string, source: unknown): string {
  return createHash('sha256').update(JSON.stringify({ text, source: source ?? null })).digest('hex');
}

export type Offer = { status: 'not-owned' } | { status: 'new' | 'duplicate' | 'conflict'; runtimeId: string; submissionId: string };

/** Record one submission for the pane's connector runtime. Does NOT deliver (the connector path
 *  is disabled): it answers whether this id is new, a duplicate, or a conflicting reuse. */
export function offerSubmission(a: { paneid: string; submissionId: string; text: string; source?: unknown }): Offer {
  const b = table.connectorBindingForPane(a.paneid);
  if (!b) {
    return { status: 'not-owned' };
  }
  const status = table.recordConnectorSubmission(b.runtime_id, a.submissionId, contentHash(a.text, a.source));
  return { status, runtimeId: b.runtime_id, submissionId: a.submissionId };
}

/* ---- lease and journal handed to the connector ------------------------------------------- */

export interface Lease {
  runtimeInstanceId: string;
  generation: number; // the connector's word for the INCARNATION
  threadId: string;
  isCurrent(): boolean;
}

/** The exclusive-writer lease for the runtime's CURRENT incarnation. `isCurrent` is synchronous
 *  and false the moment the incarnation moves, a handoff is pending, or the pane is not live. */
export function leaseFor(runtimeId: string, isPaneLive: (paneid: string) => boolean): Lease | null {
  const b = table.getConnectorBinding(runtimeId);
  if (!b || !b.thread_id || b.state !== 'bound') {
    return null;
  }
  const incarnation = b.incarnation;
  return {
    runtimeInstanceId: runtimeId,
    generation: incarnation,
    threadId: b.thread_id,
    isCurrent() {
      const now = table.getConnectorBinding(runtimeId);
      return !!now && now.incarnation === incarnation && now.handoff === null && !!now.paneid && isPaneLive(now.paneid);
    },
  };
}

export interface JournalRecord {
  revision: number;
}
export interface Journal<R extends JournalRecord> {
  read(): Promise<R | undefined>;
  write(record: R, previousRevision: number | undefined): Promise<void>;
}

/** The connector's DeliveryJournal over the engine's durable outbox row: a read of the one JSON
 *  row, and a compare-and-set write that throws (writing nothing) on a stale revision. */
export function journalFor<R extends JournalRecord>(runtimeId: string): Journal<R> {
  return {
    async read() {
      const row = table.readConnectorOutbox(runtimeId);
      return row ? (JSON.parse(row.record) as R) : undefined;
    },
    async write(record, previousRevision) {
      table.writeConnectorOutbox(runtimeId, JSON.stringify(record), record.revision, previousRevision);
    },
  };
}

/* ---- the persist-before-acknowledge handshake and the handoff ---------------------------- */

/** Contract step 4: the connector's snapshot is `awaiting-engine-persistence`. Commit it (binding
 *  row + sessions.session_id in one transaction), and only then may the caller send
 *  `acknowledgePersisted`. Throws, writing nothing, on any mismatch. */
export function commitSnapshot(snapshot: {
  runtimeInstanceId: string;
  generation: number;
  revision: number;
  threadId: string;
  codexSessionId?: string | null;
}) {
  return table.commitConnectorBinding({
    runtimeId: snapshot.runtimeInstanceId,
    incarnation: snapshot.generation,
    revision: snapshot.revision,
    threadId: snapshot.threadId,
    codexSessionId: snapshot.codexSessionId,
  });
}

/** Engine half of an incarnation handoff. The returned row has `handoff: 'pending-connector'`
 *  until `acknowledgeHandoff`; callers replay the connector's handoff call while it is set. */
export function beginHandoff(runtimeId: string, paneid: string | null) {
  const b = table.getConnectorBinding(runtimeId);
  if (!b) {
    throw new Error(`no connector binding for ${runtimeId}`);
  }
  if (b.handoff === 'pending-connector') {
    return b; // a replay: the intent is already durable; the caller re-sends the connector call
  }
  return table.handoffConnectorBinding({ runtimeId, fromIncarnation: b.incarnation, toIncarnation: b.incarnation + 1, paneid });
}

export function acknowledgeHandoff(runtimeId: string, incarnation: number) {
  return table.ackConnectorHandoff(runtimeId, incarnation);
}

/** Can a restore resume this runtime's thread? Not until the connector has reported correlated
 *  history: an empty thread has no rollout, so `resume` would fail (review issue 4). */
export function restorable(paneid: string): boolean | null {
  const b = table.connectorBindingForPane(paneid);
  return b ? !!b.thread_id && b.materialized === 1 : null;
}
