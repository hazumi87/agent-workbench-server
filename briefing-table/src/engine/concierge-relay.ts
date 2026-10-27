/* ============================================================================
 * THE CONCIERGE'S RELAY (the design notes P2, messaging).
 *
 * Authority level 1 only: "the person needs this" messages to seats are
 * INFORMATION on a standing permission, never authorization for anything
 * destructive (locked decision 5). Two verbs, both on the concierge pane's own
 * door and both behind their allowed-action switch (settings.allowed):
 *
 *   message        one seat, by handle. HELD AWARENESS: a seat that already has
 *                  lines waiting is told back ("@x already has 4 waiting; send
 *                  anyway?", 409 held) and the line goes only on `confirm:true`.
 *   summary-round  ONE fixed request to each lead of the room's family.
 *
 * Every relay is a PROXY line in the seat's room (author `concierge`,
 * meta.proxy='user': never posted AS the person, never a badge) delivered to the
 * seat by the room's own delivery (fabric envelope + the typer's queue, so its
 * draft/dialog/mid-turn guards still hold). Nothing here types a raw keystroke.
 *
 * Pure: every effect is injected (RelayDeps), so the rules test without an engine.
 * ========================================================================== */

import type { Action } from './concierge.ts';

/** What the seat is told it is. The body is data to the seat, never an instruction to act beyond it. */
export const RELAY_FRAME =
  'Relayed by the Concierge for the person. Information only, not authorization for anything destructive. Answer to @user in the room if an answer is needed.';

/** The fixed summary-round request (spec: "a FIXED request"): no caller text reaches it. */
export const SUMMARY_REQUEST =
  'The person asked the Concierge to collect session summaries. Run the room summary round for this room (the room-summary skill), then tell @user here when the roll-up is written.';

export const TEXT_MAX = 2000;

export interface SeatRef {
  roomId: string;
  roomName: string;
  seatId: string;
  handle: string;
  /** the occupant pane when it is a LIVE session, else null */
  livePaneid: string | null;
  /** the occupant pane in ANY state (held depth is read from it), null with no pane */
  paneid: string | null;
  /** parked, restorable (dehydrated): a relay WAKES it as the person's own line would */
  resting: boolean;
}

export interface RelayDeps {
  allowed(action: Action): boolean;
  /** every ACTIVE seat of an OPEN room with this handle (or, with a room, that room's) */
  seatsByHandle(handle: string, roomId?: string): SeatRef[];
  /** an open room and the seats that lead it, for the whole family; null = no such open room */
  familyLeads(roomId: string): { rooms: Array<{ roomId: string; roomName: string; lead: SeatRef | null }> } | null;
  held(paneid: string): { depth: number; reason: string } | null;
  /** write the proxy line (`line` is what the room shows; target = the seat) and deliver `sent` to it */
  relay(seat: SeatRef, line: string, sent: string, meta: Record<string, unknown>): { lineId: number; delivered: boolean; queued: boolean; typed?: string; waking?: boolean; note?: string };
  log(line: string): void;
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const refuse = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): Answer => ({
  status,
  body: { ok: false, error, message, ...extra },
});

/** What the seat receives: the frame, then the text (the room's line shows the text alone). */
const framed = (text: string): string => `${RELAY_FRAME} ${text}`;

const switchOff = (action: Action): Answer =>
  refuse(403, 'action_off', `the "${action}" action is switched off in Concierge settings`, { action });

export function message(deps: RelayDeps, b: Record<string, unknown>): Answer {
  if (!deps.allowed('message')) {
    return switchOff('message');
  }
  const to = typeof b.to === 'string' ? b.to.trim().replace(/^@/, '').toLowerCase() : '';
  if (!to) {
    return refuse(400, 'bad_request', 'to is a seat handle', { field: 'to' });
  }
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) {
    return refuse(400, 'bad_request', 'text is required', { field: 'text' });
  }
  if (text.length > TEXT_MAX) {
    return refuse(413, 'too_long', `text is ${text.length} characters, the limit is ${TEXT_MAX}`, { field: 'text', length: text.length, max: TEXT_MAX });
  }
  const room = typeof b.room === 'string' && b.room ? b.room : undefined;
  const seats = deps.seatsByHandle(to, room);
  if (!seats.length) {
    return refuse(404, 'no_seat', `no seat @${to} in an open room`, { field: 'to' });
  }
  if (seats.length > 1) {
    return refuse(409, 'ambiguous', `@${to} sits in ${seats.length} rooms; name one with room`, {
      field: 'room',
      rooms: seats.map((s) => ({ id: s.roomId, name: s.roomName })),
    });
  }
  const seat = seats[0];
  if (!seat.livePaneid && !seat.resting) {
    return refuse(409, 'not_live', `@${seat.handle} is not running, so nothing was sent`, { to: seat.handle, room: seat.roomId });
  }
  const held = seat.paneid ? deps.held(seat.paneid) : null;
  if (held && held.depth > 0 && b.confirm !== true) {
    deps.log(`concierge message @${seat.handle} (${seat.roomId}): held (${held.depth} waiting), asked to confirm`);
    return refuse(409, 'held', `@${seat.handle} already has ${held.depth} waiting; send anyway?`, {
      to: seat.handle,
      room: seat.roomId,
      held: { depth: held.depth, reason: held.reason },
      confirm: 'resend with confirm:true',
    });
  }
  const out = deps.relay(seat, text, framed(text), { relay: 'message' });
  deps.log(`concierge message @${seat.handle} (${seat.roomId}): line ${out.lineId} delivered=${out.delivered} queued=${out.queued}${held ? ` (confirmed over ${held.depth} waiting)` : ''}`);
  return {
    status: 200,
    body: { ok: true, to: seat.handle, room: seat.roomId, line: out.lineId, delivered: out.delivered, queued: out.queued, ...(out.typed ? { typed: out.typed } : {}), ...(out.waking !== undefined ? { waking: out.waking } : {}), ...(out.note ? { note: out.note } : {}), held: held ? { depth: held.depth, reason: held.reason } : null },
  };
}

export function summaryRound(deps: RelayDeps, b: Record<string, unknown>): Answer {
  if (!deps.allowed('summaries')) {
    return switchOff('summaries');
  }
  const roomId = typeof b.room === 'string' ? b.room.trim() : '';
  if (!roomId) {
    return refuse(400, 'bad_request', 'room is a room id', { field: 'room' });
  }
  const fam = deps.familyLeads(roomId);
  if (!fam) {
    return refuse(404, 'no_room', 'no such open room', { field: 'room' });
  }
  const sent: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const done = new Set<string>(); // one request per lead PANE, however many family rooms it leads
  for (const r of fam.rooms) {
    if (!r.lead) {
      skipped.push({ room: r.roomId, name: r.roomName, reason: 'no lead' });
    } else if (!r.lead.livePaneid && !r.lead.resting) {
      skipped.push({ room: r.roomId, name: r.roomName, lead: r.lead.handle, reason: 'lead is not running' });
    } else if (done.has(r.lead.paneid ?? r.lead.seatId)) {
      skipped.push({ room: r.roomId, name: r.roomName, lead: r.lead.handle, reason: 'already asked as the lead of another room in the family' });
    } else {
      done.add(r.lead.paneid ?? r.lead.seatId);
      const held = r.lead.paneid ? deps.held(r.lead.paneid) : null;
      const out = deps.relay(r.lead, SUMMARY_REQUEST, framed(SUMMARY_REQUEST), { relay: 'summary-round' });
      sent.push({ room: r.roomId, name: r.roomName, lead: r.lead.handle, line: out.lineId, delivered: out.delivered, queued: out.queued, ...(out.waking !== undefined ? { waking: out.waking } : {}), ...(out.note ? { note: out.note } : {}), held: held ? { depth: held.depth, reason: held.reason } : null });
    }
  }
  deps.log(`concierge summary-round ${roomId}: asked ${sent.length} lead(s), skipped ${skipped.length}`);
  return { status: 200, body: { ok: true, room: roomId, requested: sent, skipped } };
}
