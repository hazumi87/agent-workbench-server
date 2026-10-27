/* ============================================================================
 * F4 — ROOMS ON FABRIC THREADS (the design notes §6, docs/workrooms-
 * build.md §2.8) [ticket].
 *
 * A room is ONE pinned fabric thread (agreed with platform on the relay,
 * 2026-09-25: fabric-service `POST /threads {topic, by, pinned}` +
 * `GET /threads/<id>/acks`). Membership stays the engine's; the fabric carries
 * a durable copy of each line to each agent seat and keeps an ack ladder per
 * copy, which room read state reads back as evidence.
 *
 * IN ADDITION TO, NEVER INSTEAD OF, the room door. rooms.ts deliverToSeat has
 * already put the line in front of the seat's pane and typed it before this
 * runs; the fabric copy is the durable record plus a read-state source. So:
 *   · the copy is never typed or re-badged (fabric.deliver skips any envelope
 *     whose ref starts `room:` — that is the no-double-typing rule);
 *   · a fabric that is down, slow or refusing changes NOTHING about the room —
 *     every call here is fire-and-forget or bounded, caught, and logged once.
 *
 *   thread  opened on the FIRST delivery in a room with rooms.thread NULL,
 *           topic = room name, pinned (exempt from the 14-day idle close),
 *           stored once (store.setRoomThread: NULL -> id only)
 *   copy    one envelope per AGENT seat recipient that has a slug (a live
 *           occupant pane with sessions.agent; human seats never):
 *             {to: <seat's work slug if checked in, else its agent slug>,
 *              thread, kind: 'ask' when the line @-addressed that seat, else
 *              'notice', class: 'coordination', body: <entry body>,
 *              ref: room:<roomId>/line:<entryId>}
 *           sent AS THE AUTHOR's pane (its checked-in instance, or the engine
 *           stamp — fabric-checkin.sendAs); a user-authored line is from 'user'
 *   turn    the reply-turn "your turn" line (turnLine below): the one line the
 *           ENGINE writes for a seat. Same envelope, signed as the room
 *           (`room-<id8>`), always an 'ask'
 *   reads   GET /threads/<id>/acks when a line GET asks, cached 5 s per
 *           thread; ack >= seen upgrades the seat to seen (room-reads)
 *
 * Flag: HARBOR_WB_ROOM_FABRIC (default '1'; '0' = rooms exactly as before F4).
 * ========================================================================== */

import * as connectorBridge from './connector-bridge.ts';
import * as fabricCheckin from './fabric-checkin.ts';
import * as fabricSub from './fabric-subscriber.ts';
import * as roomReads from './room-reads.ts';
import * as channels from './channels.ts';
import { table } from '../table/endpoint.ts';
import type { Room, RoomSeat, RoomLineEntry } from '../table/endpoint.ts';

const ACKS_CACHE_MS = 5_000;
const ACKS_TIMEOUT_MS = 1_500;

export function enabled(): boolean {
  return process.env.HARBOR_WB_ROOM_FABRIC !== '0' && fabricSub.endpoint().enabled;
}

let log: (line: string) => void = () => {};
export function setLog(fn: (line: string) => void): void {
  log = fn;
}

/* ONE LINE PER STATE CHANGE — a fabric that is down for a week must not write
   a line per room message saying so. */
let down = false;
function noteDown(why: string): void {
  if (!down) {
    down = true;
    log(`room fabric: unreachable (${why}) — rooms carry on without it`);
  }
}
function noteUp(): void {
  if (down) {
    down = false;
    log('room fabric: reachable again');
  }
}

function livePane(seat: RoomSeat | undefined): { paneid: string; agent: string } | null {
  if (!seat || seat.occupant_kind !== 'pane' || !seat.occupant) {
    return null;
  }
  const row = table.get(seat.occupant);
  return row && row.state === 'live' && row.agent ? { paneid: seat.occupant, agent: row.agent } : null;
}

/* A room's first two lines can race to open its thread; one open per room. */
const opening = new Map<string, Promise<string | null>>();

async function ensureThread(room: Room, authorPane: string | null, by: string): Promise<string | null> {
  const current = table.getRoom(room.id)?.thread;
  if (current) {
    return current;
  }
  let p = opening.get(room.id);
  if (!p) {
    p = (async () => {
      const r = await fabricCheckin.request(
        'POST',
        '/threads',
        { topic: room.name.slice(0, 200), by, pinned: true },
        fabricCheckin.identityOf(authorPane)?.instance ?? null,
      );
      if (r.status !== 200 || typeof r.body?.thread !== 'string') {
        log(`room ${room.id}: fabric thread not opened — HTTP ${r.status} ${r.body?.error ?? ''}`.trim());
        return null;
      }
      const stored = table.setRoomThread(room.id, r.body.thread)?.thread ?? r.body.thread;
      log(`room ${room.id}: bound to fabric thread ${stored} (pinned)`);
      return stored;
    })().finally(() => opening.delete(room.id));
    opening.set(room.id, p);
  }
  return p;
}

/**
 * Send the fabric copy of one line entry to each agent seat among
 * `recipients` (the seats the room door just delivered to). `addressed` = the
 * seat ids the line named with an @ (they get kind 'ask'). Fire-and-forget:
 * returns at once, never throws.
 */
export function fanOut(room: Room, entry: RoomLineEntry, recipients: RoomSeat[], addressed: string[], bodyOverride?: string): void {
  /* bodyOverride: what the agents are told when it is more than the entry's
     text — a message's attachment references (ticket) */
  const body = bodyOverride ?? entry.body;
  if (!enabled() || !body) {
    return;
  }
  void (async () => {
    try {
      const author = entry.author_seat ? livePane(table.getSeat(entry.author_seat)) : null;
      /* The author as the fabric will know it: a seat's live pane, or the
         user. A seat whose pane has no live slug has no honest `from`, so its
         line stays room-only (never re-labelled as the user). */
      if (entry.author_seat && !author) {
        log(`room ${room.id}: line #${entry.id} not copied to the fabric — the author seat has no live slug`);
        return;
      }
      const from = author ? author.agent : 'user';
      const targets = recipients
        .map((seat) => ({ seat, pane: livePane(seat) }))
        .filter((t): t is { seat: RoomSeat; pane: { paneid: string; agent: string } } => t.pane !== null)
        .filter((t) => !connectorBridge.isOwned(t.pane.paneid)); // [connector] its line is ONE canonical submission, not a third copy
      if (!targets.length) {
        return;
      }
      const thread = await ensureThread(room, author?.paneid ?? null, fabricCheckin.identityOf(author?.paneid)?.slug ?? from);
      if (!thread) {
        return;
      }
      let sent = 0;
      for (const t of targets) {
        const to = fabricCheckin.identityOf(t.pane.paneid)?.slug ?? t.pane.agent;
        const r = await fabricCheckin.sendAs(author?.paneid ?? null, {
          from,
          to,
          thread,
          kind: addressed.includes(t.seat.id) ? 'ask' : 'notice',
          class: 'coordination',
          body,
          ref: `room:${room.id}/line:${entry.id}`,
        });
        if (r.status >= 200 && r.status < 300) {
          roomReads.noteFabric(room.id, entry.id, t.seat.id, to);
          sent++;
        } else {
          log(`room ${room.id}: line #${entry.id} → @${t.seat.handle} fabric copy refused HTTP ${r.status} ${r.body?.error ?? ''}`.trim());
        }
      }
      noteUp();
      log(`room ${room.id}: line #${entry.id} copied to fabric thread ${thread} for ${sent}/${targets.length} seat(s)`);
    } catch (e) {
      noteDown((e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message);
    }
  })();
}

/* THE RECONNECT NOTICE (Owner 2026-09-27). After the room's Reconnect each
   restored seat gets ONE fabric message, signed as the room itself
   (`room-<id8>`: never the user, never another agent), because a channel
   arrival is the one thing the startup hold does not stop: the agent takes a
   turn, its Stop hook clears the hold, and the user's typed lines flow. It
   waits for the new pane to be live, checked in with a slug, AND holding a
   live channel: a VRPC pane's channel rides the engine relay, which pushes
   only what arrives after it connects, so a notice sent earlier was lost
   (vrpc1, 2026-09-27: sent 1 s after launch, never seen). ~2 minutes. */
export const RECONNECT_NOTICE =
  'The room was offline, and now you are back. Any background tasks you had running were ended when it went offline; check and restart anything you still need.';

export function roomSender(roomId: string): string {
  return `room-${roomId.slice(0, 8).toLowerCase()}`;
}

export function noticeOnReconnect(
  room: Room,
  seat: RoomSeat,
  paneid: string,
  opts: { tries?: number; everyMs?: number } = {},
): Promise<'sent' | 'refused' | 'gave-up' | 'off'> {
  if (!enabled()) {
    return Promise.resolve('off');
  }
  const tries = opts.tries ?? 40;
  const everyMs = opts.everyMs ?? 3_000;
  return (async () => {
    for (let i = 0; i < tries; i++) {
      try {
        if (table.get(paneid)?.state === 'live') {
          await fabricCheckin.ensure(paneid);
          const to = fabricCheckin.identityOf(paneid)?.slug;
          if (to && (await channels.channelLive(paneid))) {
            const r = await fabricCheckin.sendAs(null, {
              from: roomSender(room.id),
              to,
              kind: 'notice',
              class: 'coordination',
              body: RECONNECT_NOTICE,
            });
            const ok = r.status >= 200 && r.status < 300;
            log(`room ${room.id}: reconnect notice → @${seat.handle} (${to}) ${ok ? 'sent' : `refused HTTP ${r.status} ${r.body?.error ?? ''}`.trim()}`);
            return ok ? 'sent' : 'refused';
          }
        }
      } catch (e) {
        noteDown((e as Error).message);
      }
      await new Promise((res) => setTimeout(res, everyMs));
    }
    log(`room ${room.id}: reconnect notice → @${seat.handle} gave up: ${paneid} never came up with a fabric slug and a live channel`);
    return 'gave-up';
  })();
}

/* ONE NOTICE TO A LIVE SEAT, signed as the room (Owner 2026-10-03): the reload's "Lead sends it" asks the lead to welcome
   the reloaded seat as itself, so the engine never speaks as the user. No
   channel wait: the lead is already running and the fabric mailbox is durable. */
export async function noticeSeat(room: Room, seat: RoomSeat, paneid: string, body: string): Promise<'sent' | 'refused' | 'off' | 'no-slug'> {
  if (!enabled()) return 'off';
  try {
    await fabricCheckin.ensure(paneid);
    const to = fabricCheckin.identityOf(paneid)?.slug;
    if (!to) return 'no-slug';
    const r = await fabricCheckin.sendAs(null, { from: roomSender(room.id), to, kind: 'notice', class: 'coordination', body });
    const ok = r.status >= 200 && r.status < 300;
    log(`room ${room.id}: notice → @${seat.handle} (${to}) ${ok ? 'sent' : `refused HTTP ${r.status}`}`);
    return ok ? 'sent' : 'refused';
  } catch (e) {
    noteDown((e as Error).message);
    return 'refused';
  }
}

/* THE TURN LINE [reply turns] (Owner 2026-10-11, room lines [ref] / [ref]). The
   line that hands a seat the floor is the ENGINE's: nobody authored it, so it
   cannot ride fanOut (an author-less line fans out as `user`, and a seat's
   channel drops `user` mail: the person's words reach an agent as a prompt).
   rooms.ts used to hand it to deliverToSeat alone, which does not type into a
   pane with a live channel because the fabric copy is what carries a line
   there, and no copy was sent. server, 2026-10-11: three floors timed out with
   both seats idle and nothing in either mailbox. So: signed as the room, an
   'ask', on the room's thread, with the room ref (fabric.deliver reads the ref
   as a room copy: never typed, never re-badged). Measured the same day with
   this exact envelope: an idle seat's turn starts in under 60 ms and a busy
   seat takes it as its next turn. Fire-and-forget like fanOut. The body holds
   the grant: it is never logged, here or on a refusal. */
export function turnLine(room: Room, entry: RoomLineEntry, seat: RoomSeat, body: string): void {
  if (!enabled() || !body) {
    return;
  }
  void (async () => {
    const what = `room ${room.id}: turn line #${entry.id} → @${seat.handle}`;
    try {
      const pane = livePane(seat);
      if (!pane) {
        log(`${what} not sent to the fabric — the seat has no live slug`);
        return;
      }
      if (connectorBridge.isOwned(pane.paneid)) {
        return; // [connector] its line is ONE canonical submission (deliverToSeat), not a second copy
      }
      const from = roomSender(room.id);
      const thread = await ensureThread(room, null, from);
      if (!thread) {
        log(`${what} not sent to the fabric — the room has no fabric thread`);
        return;
      }
      const to = fabricCheckin.identityOf(pane.paneid)?.slug ?? pane.agent;
      const r = await fabricCheckin.sendAs(null, { from, to, thread, kind: 'ask', class: 'coordination', body, ref: `room:${room.id}/line:${entry.id}` });
      if (r.status >= 200 && r.status < 300) {
        roomReads.noteFabric(room.id, entry.id, seat.id, to);
        noteUp();
        log(`${what} (${to}) sent on fabric thread ${thread}`);
      } else {
        log(`${what} (${to}) fabric refused HTTP ${r.status} ${r.body?.error ?? ''}`.trim());
      }
    } catch (e) {
      /* a lost turn line stalls a floor until its timer runs out, so each one
         is named (a floor handover is rare; this is not a line per message) */
      const why = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message;
      noteDown(why);
      log(`${what} not sent to the fabric — unreachable (${why})`);
    }
  })();
}

const acksFetched = new Map<string, number>();

/**
 * Before a line GET serves `reads`: merge the thread's ack ladder into room
 * read state (upgrade only). At most one fabric call per thread per 5 s, and
 * bounded at 1.5 s; a fabric that is down costs the GET nothing but that.
 */
export async function refreshReads(room: Room): Promise<void> {
  if (!enabled() || !room.thread) {
    return;
  }
  const now = Date.now();
  if (now - (acksFetched.get(room.thread) ?? 0) < ACKS_CACHE_MS) {
    return;
  }
  acksFetched.set(room.thread, now);
  try {
    const r = await fabricCheckin.request('GET', `/threads/${encodeURIComponent(room.thread)}/acks`, undefined, null, ACKS_TIMEOUT_MS);
    if (r.status !== 200 || !Array.isArray(r.body?.acks)) {
      log(`room ${room.id}: fabric acks unavailable — HTTP ${r.status} ${r.body?.error ?? ''}`.trim());
      return;
    }
    noteUp();
    const moved = roomReads.mergeFabricAcks(room.id, r.body.acks);
    if (moved) {
      log(`room ${room.id}: ${moved} read(s) upgraded to seen from the fabric ack ladder`);
    }
  } catch (e) {
    noteDown((e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message);
  }
}

/** Tests only. */
export function reset(): void {
  opening.clear();
  acksFetched.clear();
  down = false;
}
