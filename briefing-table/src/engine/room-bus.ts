/**
 * ROOM BUS — the one place a room change is announced (the design notes
 * §1.5) [ticket].
 *
 * The table endpoint emits here AFTER a transaction commits: one `room.line`
 * per new line entry, and one `room.state` when a seat, the lead, the mode,
 * the name or the room's state changed. The WS layer (T5) subscribes and fans
 * out to the sockets subscribed to that room. NOBODY ELSE BROADCASTS — a
 * second emitter would be a second opinion about what happened in a room.
 *
 * Imports nothing from server/ (only a type from the table, which is erased),
 * so the engine layer can depend on it without a cycle.
 *
 * Best effort by design: a listener that throws is logged and skipped; it can
 * never fail the verb that emitted, because the write has already committed.
 */
import type { RoomLineEntry } from '../table/store.ts';

/* `room.read` (gate G item 2) is the one event NOT emitted by the table: a read
   state is an in-memory fact about an entry, owned by engine/room-reads.ts,
   which is therefore its only emitter. Same rule, second fact. */
/* `room.held` and `room.waiting` (Owner 2026-09-28: the seat row's "N held"
   and its badge must move the moment a held line clears, not on the next
   poll) are in-memory facts too, each with ONE emitter: room.held is the
   typer's queue (engine/room-typer.ts: depth / reason / cleared, and the pane
   ending), room.waiting is room-reads' per-seat count (a line joining or
   leaving the "really waiting" set). Small by design: the page patches one
   seat row instead of re-reading the room. */
export interface SeatWaiting {
  count: number;
  ids: number[];
}
export type RoomBusEvent =
  | { type: 'room.line'; entry: RoomLineEntry }
  | { type: 'room.state' }
  | { type: 'room.read'; entryId: number; handle: string; state: 'seen' | 'not-yet' | 'unknown' | 'waking' }
  | { type: 'room.held'; seatId: string; handle: string; held: Record<string, unknown> | null }
  | { type: 'room.waiting'; seatId: string; handle: string; waiting: SeatWaiting }
  /* [scratch seen] person set: that person's new counts (their windows only);
     person null: the room's assets or notes changed, every window re-reads its own */
  | { type: 'room.scratchpad'; person: string | null; counts?: unknown }
  /* Tasks changed somewhere in this room's family: every window re-reads its task list or summary */
  | { type: 'room.tasks' };
export type RoomBusListener = (roomId: string, ev: RoomBusEvent) => void;

/** Subscribe to this key to hear every room (the WS layer's one listener). */
export const ANY_ROOM = '*';

const listeners = new Map<string, Set<RoomBusListener>>();

export function on(roomId: string, fn: RoomBusListener): void {
  let set = listeners.get(roomId);
  if (!set) {
    set = new Set();
    listeners.set(roomId, set);
  }
  set.add(fn);
}

export function off(roomId: string, fn: RoomBusListener): void {
  const set = listeners.get(roomId);
  if (set?.delete(fn) && set.size === 0) {
    listeners.delete(roomId);
  }
}

export function emit(roomId: string, ev: RoomBusEvent): void {
  for (const key of [roomId, ANY_ROOM]) {
    for (const fn of [...(listeners.get(key) ?? [])]) {
      try {
        fn(roomId, ev);
      } catch (e) {
        console.error(`[room-bus] listener failed on ${ev.type} for ${roomId}: ${(e as Error)?.message ?? e}`);
      }
    }
  }
}

/** Listener count, per key or in total (diag). */
export function listenerCount(roomId?: string): number {
  if (roomId !== undefined) {
    return listeners.get(roomId)?.size ?? 0;
  }
  let n = 0;
  for (const set of listeners.values()) {
    n += set.size;
  }
  return n;
}
