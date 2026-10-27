/* ============================================================================
 * ROOM READ STATE (gate G item 2; W3-interim) [ticket].
 *
 * Per (room line entry, recipient seat): did the AGENT at that seat take the
 * entry in? THREE OUTCOMES, NEVER TWO (CLAUDE.md cross-cutting trap):
 *
 *   seen     POSITIVE EVIDENCE, and only positive evidence:
 *              (a) turn: room-typer INJECTED the line, and within WINDOW_MS a
 *                  TURN started in that pane — the UserPromptSubmit hook
 *                  (activity.isBusy), observed as the pane's transition into
 *                  `streaming`. Byte-rule `streaming` on a pane with no turn
 *                  hooks is NOT evidence: the composer echoing the injected
 *                  text alone can cross the byte floor.
 *              (b) posted: the seat authored a chat/command entry on the line
 *                  AFTER this entry (any vendor, typed or not).
 *              (c) fabric-ack (F4): the line's fabric copy to that seat stands
 *                  at `seen` or higher on the fabric's ack ladder
 *                  (mergeFabricAcks; upgrade only). AGENT-SIDE ONLY: the
 *                  engine never acks a room copy `seen` itself (fabric-
 *                  subscriber skips them on human input), so a `seen` rung
 *                  there is the agent's own fabric_ack.
 *            A HUMAN AT THE PANE IS NEVER EVIDENCE. Every recipient here is
 *            the AGENT at a seat; someone typing in its window (often the
 *            very draft that is holding the typed copy back) says nothing
 *            about whether the agent took the line in.
 *   not-yet  in flight: queued/held by the typer (draft, busy, waiting,
 *            settling, awaiting the previous line's idle), or injected with
 *            no turn observed YET (inside WINDOW_MS), or handed to the pane's
 *            fabric CHANNEL (why 'channel': never typed) with no evidence yet.
 *
 * WAITING (the seat badge, Owner 2026-09-28): only lines that are REALLY
 * waiting count — held/queued by the typer, or typed in with the turn not yet
 * started. A channel-delivered line awaiting evidence is not waiting on
 * anything the room can see; counting it made "7" read as a backlog when
 * nothing was held (waitingFor).
 *   unknown  could not tell: badge-only vendor, typing switched off, occupant
 *            not live at delivery, the queued line was dropped (FIFO overflow
 *            or the pane ended before it was typed), the pane ended while
 *            waiting for evidence, injected but no turn inside WINDOW_MS, or
 *            the engine restarted since (in-memory state lost — see readsFor).
 *
 * `seen` is terminal. `unknown` can still become `seen` (a later post is
 * evidence whatever came before). Nothing ever goes back to `not-yet`.
 *
 * WHY IN MEMORY, NOT room_line.meta: the line is append-only by rule (§1.4 —
 * approvals cite entry ids, there is deliberately no updateLine verb), and a
 * read state is a fact ABOUT an entry that changes after it is written. A
 * `delivery`-style follow-up entry per state change would flood the line with
 * status churn the room never asked to read. Losing it on restart is honest:
 * the answer becomes `unknown`, which is exactly what it is.
 *
 * Bounded: MAX_ENTRIES entries (oldest evicted) and TTL_MS. Counts only in
 * the diag; no message content is ever held here.
 * ========================================================================== */

import * as roomBus from './room-bus.ts';
import { table } from '../table/endpoint.ts';
import type { RoomLineEntry } from '../table/store.ts';

/** 'waking' [wake deliver]: the seat's agent is being restored; the line is delivered
 *  (-> 'not-yet') once it is up, then 'seen' on evidence as always. */
export type ReadState = 'seen' | 'not-yet' | 'unknown' | 'waking';

export const MAX_ENTRIES = 2000;
const TTL_MS = 24 * 60 * 60 * 1000;
/** How long after an inject a turn start still counts as that line's. */
export const windowMs = (): number => {
  const raw = process.env.HARBOR_WB_ROOM_SEEN_MS;
  const v = Number(raw);
  return raw && Number.isFinite(v) && v > 0 ? v : 30_000;
};

interface SeatRead {
  seatId: string;
  /** Snapshot at delivery; the CURRENT handle is used when the seat still exists. */
  handle: string;
  paneid: string | null;
  state: ReadState;
  /** Why, for the diag and the log (never content). */
  why: string;
  injectedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** F4: the slug the line's fabric copy was addressed to, once sent — the
   *  key that joins a row of GET /threads/<id>/acks back to this seat. */
  fabricTo?: string;
}
interface EntryReads {
  roomId: string;
  entryId: number;
  created: number;
  seats: Map<string, SeatRead>;
}

const entries = new Map<string, EntryReads>();
const key = (roomId: string, entryId: number): string => `${roomId}#${entryId}`;

let log: (line: string) => void = () => {};
export function setLog(fn: (line: string) => void): void {
  log = fn;
}

function handleOf(r: SeatRead): string {
  return table.getSeat(r.seatId)?.handle ?? r.handle;
}

function dispose(e: EntryReads): void {
  for (const r of e.seats.values()) {
    if (r.timer) clearTimeout(r.timer);
  }
}

function sweep(now: number): void {
  for (const [k, e] of entries) {
    if (now - e.created <= TTL_MS && entries.size <= MAX_ENTRIES) {
      break; // insertion order = age order
    }
    dispose(e);
    entries.delete(k);
  }
}

/** Does this record count on the seat badge (waitingFor's rule)? */
const counts = (r: SeatRead): boolean => r.state === 'not-yet' && r.why !== 'channel';

/* room.waiting (room-bus): the seat's badge set moved — a line joined it or
   left it. Emitted after the room.read of the same change. */
function emitWaiting(roomId: string, r: SeatRead): void {
  const ids = waitingFor(roomId, r.seatId);
  roomBus.emit(roomId, { type: 'room.waiting', seatId: r.seatId, handle: handleOf(r), waiting: { count: ids.length, ids } });
}

function set(e: EntryReads, r: SeatRead, state: ReadState, why: string): void {
  if (r.state === 'seen') {
    return; // terminal
  }
  if (state === 'not-yet' && r.state === 'unknown') {
    return; // never back to in-flight once we have said we cannot tell
  }
  if (r.state === state && r.why === why) {
    return;
  }
  const changed = r.state !== state;
  const counted = counts(r);
  r.state = state;
  r.why = why;
  if (state !== 'not-yet' && r.timer) {
    clearTimeout(r.timer);
    r.timer = null;
  }
  if (changed) {
    roomBus.emit(e.roomId, { type: 'room.read', entryId: e.entryId, handle: handleOf(r), state });
  }
  if (counted !== counts(r)) {
    emitWaiting(e.roomId, r);
  }
}

/**
 * The delivery path (rooms.ts deliverToSeat) opens a record BEFORE handing the
 * line to the typer, so a synchronous inject finds it. Initial state is
 * `not-yet` (queued), or `unknown` when the occupant is not live; the caller
 * then applies what the typer answered via `cannotTell`.
 */
export function open(
  roomId: string,
  entryId: number,
  seatId: string,
  handle: string,
  paneid: string | null,
  initial: { state: 'not-yet' | 'unknown' | 'waking'; why: string } = { state: 'not-yet', why: 'queued' },
): void {
  const now = Date.now();
  const k = key(roomId, entryId);
  let e = entries.get(k);
  if (!e) {
    e = { roomId, entryId, created: now, seats: new Map() };
    entries.set(k, e);
    sweep(now);
  }
  if (e.seats.has(seatId)) {
    return;
  }
  const r: SeatRead = { seatId, handle, paneid, state: initial.state, why: initial.why, injectedAt: null, timer: null };
  e.seats.set(seatId, r);
  roomBus.emit(roomId, { type: 'room.read', entryId, handle: handleOf(r), state: r.state });
  if (counts(r)) {
    emitWaiting(roomId, r);
  }
}

/** [wake deliver] A line held for a seat that was woken: it is now handed to `paneid`
 *  (the record moves to 'not-yet' / queued, exactly as a live delivery opens it), or
 *  the wake failed ('unknown' with why). Opens the record if there was none. */
export function delivered(roomId: string, entryId: number, seatId: string, handle: string, paneid: string | null, failed?: string): void {
  const e = entries.get(key(roomId, entryId));
  const r = e?.seats.get(seatId);
  if (!e || !r) {
    open(roomId, entryId, seatId, handle, paneid, failed ? { state: 'unknown', why: failed } : undefined);
    return;
  }
  r.paneid = paneid;
  if (failed) {
    set(e, r, 'unknown', failed);
  } else {
    force(e, r, 'not-yet', 'queued'); // a retry may follow an 'unknown': this IS new evidence
  }
}

/** [wake deliver] A line the person asked to wake-and-deliver: 'waking' now, whatever
 *  the record said (a retry of an undelivered line). */
export function waking(roomId: string, entryId: number, seatId: string, handle: string): void {
  const e = entries.get(key(roomId, entryId));
  const r = e?.seats.get(seatId);
  if (!e || !r) {
    open(roomId, entryId, seatId, handle, null, { state: 'waking', why: 'waking' });
    return;
  }
  r.paneid = null;
  force(e, r, 'waking', 'waking');
}

function force(e: EntryReads, r: SeatRead, state: ReadState, why: string): void {
  if (r.state === 'seen' || (r.state === state && r.why === why)) {
    return;
  }
  const counted = counts(r);
  const changed = r.state !== state;
  r.state = state;
  r.why = why;
  if (changed) {
    roomBus.emit(e.roomId, { type: 'room.read', entryId: e.entryId, handle: handleOf(r), state });
  }
  if (counted !== counts(r)) {
    emitWaiting(e.roomId, r);
  }
}

/** The entries addressed to this seat that are REALLY waiting (why 'queued'
 *  or 'injected', state not-yet): the seat badge's count. A line handed to
 *  the pane's fabric channel (why 'channel') is not. Ids, oldest first. */
export function waitingFor(roomId: string, seatId: string): number[] {
  const out: number[] = [];
  for (const e of entries.values()) {
    if (e.roomId !== roomId) {
      continue;
    }
    const r = e.seats.get(seatId);
    if (r && r.state === 'not-yet' && r.why !== 'channel') {
      out.push(e.entryId);
    }
  }
  return out.sort((a, b) => a - b);
}

/** What the delivery could not do, as `unknown` (not live / badge-only / typing off). */
export function cannotTell(roomId: string, entryId: number, seatId: string, why: string): void {
  const e = entries.get(key(roomId, entryId));
  const r = e?.seats.get(seatId);
  if (e && r) {
    set(e, r, 'unknown', why);
  }
}

function forPane(roomId: string, entryId: number, paneid: string): [EntryReads, SeatRead][] {
  const e = entries.get(key(roomId, entryId));
  if (!e) {
    return [];
  }
  return [...e.seats.values()].filter((r) => r.paneid === paneid).map((r) => [e, r]);
}

/** room-typer: the framed line was written to `paneid`. Evidence window opens. */
export function onInjected(roomId: string, entryId: number, paneid: string, at = Date.now()): void {
  for (const [e, r] of forPane(roomId, entryId, paneid)) {
    if (r.state !== 'not-yet') {
      continue;
    }
    r.injectedAt = at;
    r.why = 'injected';
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.timer = null;
      try {
        if (r.state === 'not-yet') {
          set(e, r, 'unknown', 'no-turn');
        }
      } catch (err) {
        log(`room-reads: expiry threw: ${(err as Error).message}`); // a throw in a timer is engine-fatal
      }
    }, windowMs() + 25);
    r.timer.unref?.();
  }
}

/** room-typer: a queued line will never be typed (overflow / pane ended). */
export function onDropped(roomId: string, entryId: number, paneid: string, why: string): void {
  for (const [e, r] of forPane(roomId, entryId, paneid)) {
    set(e, r, 'unknown', why);
  }
}

/**
 * Activity change for a pane (forwarded by room-typer.onActivity). `busy` is
 * activity.isBusy at the moment of the change: true only once a real turn is
 * running (UserPromptSubmit hook), which is the evidence we accept.
 */
export function onActivity(paneid: string, state: string, busy: boolean, now = Date.now()): void {
  if (state !== 'streaming' || !busy) {
    return;
  }
  const win = windowMs();
  for (const e of entries.values()) {
    for (const r of e.seats.values()) {
      if (r.paneid === paneid && r.state === 'not-yet' && r.injectedAt !== null && now >= r.injectedAt && now - r.injectedAt <= win) {
        set(e, r, 'seen', 'turn');
      }
    }
  }
}

/* ---------------------------------------------------------------------------
 * F4 — THE FABRIC'S ACK LADDER as a third kind of evidence (room-fabric.ts).
 * A seat's copy of a line was sent to the fabric addressed to `fabricTo`; when
 * the fabric reports that copy acked `seen` or further, the seat has seen it.
 * UPGRADE ONLY: `set` already refuses to leave `seen`, and nothing here ever
 * asks for anything but `seen` — `none`/`delivered` say nothing, and `demoted`
 * is the loudness clock, not a reader.
 *
 * WHO CLIMBED THE LADDER. The fabric's ack rows do not say who acked, so this
 * merge can only be as honest as the writers are. The one engine-side writer
 * of `seen` (fabric-subscriber's human-arrival ack) SKIPS room copies; what is
 * left is the recipient agent acking through its own instance (fabric-mcp's
 * fabric_ack). 2026-09-25 live: before that skip, two lines to @the design system read
 * `seen` from a human typing in its pane while the typed copies were still
 * held behind that draft.
 * ------------------------------------------------------------------------- */
const ACK_SEEN = new Set(['seen', 'answered', 'resolved']);

/** room-fabric: the copy for (entry, seat) went out addressed to `toSlug`. */
export function noteFabric(roomId: string, entryId: number, seatId: string, toSlug: string): void {
  const r = entries.get(key(roomId, entryId))?.seats.get(seatId);
  if (r) {
    r.fabricTo = toSlug;
  }
}

/** Merge rows of GET /threads/<id>/acks. Returns how many seats moved to seen. */
export function mergeFabricAcks(roomId: string, rows: Array<{ to?: unknown; ref?: unknown; ack?: unknown }>): number {
  const prefix = `room:${roomId}/line:`;
  let moved = 0;
  for (const row of rows) {
    if (typeof row.ref !== 'string' || !row.ref.startsWith(prefix) || !ACK_SEEN.has(row.ack as string)) {
      continue;
    }
    const e = entries.get(key(roomId, Number(row.ref.slice(prefix.length))));
    if (!e) {
      continue; // no record (restart / evicted): the derived `unknown` stands
    }
    for (const r of e.seats.values()) {
      if (r.fabricTo === row.to && r.state !== 'seen') {
        set(e, r, 'seen', 'fabric-ack');
        moved++;
      }
    }
  }
  return moved;
}

/** The pane is gone: anything still waiting for evidence there cannot get it. */
export function onPaneEnded(paneid: string): void {
  for (const e of entries.values()) {
    for (const r of e.seats.values()) {
      if (r.paneid === paneid && r.state === 'not-yet') {
        set(e, r, 'unknown', 'pane-ended');
      }
    }
  }
}

/* (b) posted: a seat that writes to the line after an entry has seen it. The
   bus fires AFTER the write commits; the new entry's own record does not exist
   yet (deliveries are recorded after the append), so only earlier ones move. */
const POSTS = new Set(['chat', 'command']);
roomBus.on(roomBus.ANY_ROOM, (roomId, ev) => {
  if (ev.type !== 'room.line' || !ev.entry.author_seat || !POSTS.has(ev.entry.kind)) {
    return;
  }
  const seatId = ev.entry.author_seat;
  for (const e of entries.values()) {
    if (e.roomId !== roomId || e.entryId >= ev.entry.id) {
      continue;
    }
    const r = e.seats.get(seatId);
    if (r) {
      set(e, r, 'seen', 'posted');
    }
  }
});

/** POSITIVE EVIDENCE (doorbell delivery): the seat's own agent pulled these lines with its token (room_read). The pull IS the acknowledgement. */
export function markPulled(roomId: string, entryIds: readonly number[], seatId: string): void {
  for (const id of entryIds) {
    const e = entries.get(key(roomId, id));
    const r = e?.seats.get(seatId);
    if (e && r) set(e, r, 'seen', 'pulled');
  }
}

/* Which seats an entry was addressed to, from the entry alone — used only
   when there is no in-memory record (engine restarted since, or evicted).
   `target_seat` is the one resolved recipient (named seat, or the lead at
   write time); `target='room'` is every seat active at the entry's time. A
   multi-@ entry stores only its first address, so its other recipients are not
   derivable and are left out rather than guessed. */
function derivedRecipients(entry: RoomLineEntry): string[] {
  if (!POSTS.has(entry.kind) || entry.author === 'room') {
    return [];
  }
  if (entry.target_seat) {
    return entry.target_seat === entry.author_seat ? [] : [entry.target_seat];
  }
  if (entry.target === 'room') {
    return table
      .listSeats(entry.room_id, { includeLeft: true })
      .filter((s) => s.id !== entry.author_seat && s.added_at <= entry.ts && (s.left_at === null || s.left_at > entry.ts))
      .map((s) => s.id);
  }
  return [];
}

/** [reply route] Was `entryId` handed to `seatId` (a read record was opened for it)?
 *  In memory: false after a restart, which only means "cannot tell here". */
export function deliveredTo(roomId: string, entryId: number, seatId: string): boolean {
  return entries.get(key(roomId, entryId))?.seats.has(seatId) ?? false;
}

/**
 * `reads` for one entry as GET .../line serves it: `{<handle>: state}`, or
 * undefined when the entry was delivered to nobody (field then absent).
 */
export function readsFor(entry: RoomLineEntry): Record<string, ReadState> | undefined {
  const e = entries.get(key(entry.room_id, entry.id));
  if (e && e.seats.size) {
    const out: Record<string, ReadState> = {};
    for (const r of e.seats.values()) {
      out[handleOf(r)] = r.state;
    }
    return out;
  }
  const seats = derivedRecipients(entry);
  if (!seats.length) {
    return undefined;
  }
  const out: Record<string, ReadState> = {};
  for (const id of seats) {
    const h = table.getSeat(id)?.handle;
    if (h) {
      out[h] = 'unknown';
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Counts only — never content. */
export function diag(): Record<string, unknown> {
  const byState: Record<ReadState, number> = { seen: 0, 'not-yet': 0, unknown: 0, waking: 0 };
  for (const e of entries.values()) {
    for (const r of e.seats.values()) {
      byState[r.state]++;
    }
  }
  return { entries: entries.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS, windowMs: windowMs(), byState };
}

/** Tests only. */
export function reset(): void {
  for (const e of entries.values()) {
    dispose(e);
  }
  entries.clear();
}
