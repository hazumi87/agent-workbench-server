/**
 * THE REAP GUARD — why a windowless pane must not be reaped YET (W5, Owner
 * 2026-09-24) [ticket].
 *
 * The windowless reap timer (sessions.scheduleReap) keys on "no viewer", and
 * viewer absence is not evidence of abandonment (sessions.ts, REAP_MS). Two
 * facts ARE evidence that a pane is wanted, so either one holds the reap off:
 *
 *   · it occupies a `persistent` seat in an OPEN room — a colleague the room
 *     expects to resume, not a leftover (wr §2.7: persistent is the default
 *     way a member is brought in). An archived room is stasis; a fresh /
 *     dispatched / pool seat forgets by design; neither holds anything.
 *   · its activity is `streaming` or `waiting` — it is working, or it is
 *     blocked on the user. Reaping either takes away exactly the thing a
 *     human will come back for. `waiting-seen` (window-chrome v33, ticket)
 *     is still blocked on the user — seen, not answered — so it holds as
 *     `waiting`; before v33 that pane read `idle` and could be reaped.
 *
 * PURE: the caller hands in how to read activity and rooms, so sessions.ts
 * never imports rooms (engine seam hygiene) and this is testable with no db.
 * Returns the REASON (logged and shown in the diag), or null when nothing
 * holds the reap.
 */

export type ReapHoldReason = 'room-seat' | 'streaming' | 'waiting';

export interface ReapGuardDeps {
  /** The pane's activity state word, or null when unknown. */
  activity(paneid: string): string | null;
  /** The rooms/seats this pane occupies (active seats only). */
  seats(paneid: string): Array<{ room: { state: string }; seat: { policy: string } }>;
}

export function reapHoldReason(paneid: string, deps: ReapGuardDeps): ReapHoldReason | null {
  if (deps.seats(paneid).some((h) => h.room.state === 'open' && h.seat.policy === 'persistent')) {
    return 'room-seat';
  }
  const a = deps.activity(paneid);
  if (a === 'waiting-seen') {
    return 'waiting'; // seen is still blocked (ticket)
  }
  return a === 'streaming' || a === 'waiting' ? a : null;
}
