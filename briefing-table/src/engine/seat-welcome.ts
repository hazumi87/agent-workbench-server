/**
 * What an agent is told the first time it can hear a room, and the first time
 * it is chatted with directly [room welcome, Owner 2026-10-05].
 *
 * Owner's first workgroup test: a new room lead answered room lines in its
 * terminal because it had not loaded room_post (a deferred MCP tool), and a
 * Codex agent in its own direct chat answered through Fabric instead of just
 * replying. So every agent seat gets ONE line saying where to answer, and the
 * first direct-chat message carries a one-sentence note the other way.
 *
 * DELIVERY IS FACT-FREE: the line is typed into the pane through the typer's
 * fabric run (roomId 'fabric', no entry), so it is never a room line, has no
 * read record and no badge, and nobody else in the room sees it. Once per
 * (seat, pane, room) in the table (seat_welcomes), so an engine restart does
 * not repeat it; a seat MOVE changes the room and so is a new key.
 */
import { table } from '../table/endpoint.ts';
import type { Room, RoomSeat } from '../table/endpoint.ts';
import * as roomTyper from './room-typer.ts';
import * as roomGuide from '../server/room-guide.ts';
import { agentComms } from './agent-comms.ts';
import * as btTools from './bt-tools.ts';
import { isLocalMode } from './local-mode.ts';

/** Agent CLIs only: an app or tool resident has no composer to be told anything in. */
const AGENT_VENDORS = new Set(['claude-code', 'codex-cli', 'gemini-cli']);

const TAIL =
  'Room lines reach you here. Answer them IN THE ROOM with room_post (to reach the user start with @user; @handle addresses a seat). ' +
  'If room_post is not in your tools, load it first: ToolSearch "select:mcp__fabric__room_post,mcp__fabric__room_read,mcp__fabric__fabric_ack". ' +
  'A reply only in your terminal is not seen. ' +
  'Talk between seats stays between those seats: do not start @user or copy the user on it. Address @user to report a result, ask a question, or ask for a decision.';

/** The same words for a pane that HAS the bt room tools (E1): no ToolSearch step, the tool is already there. */
const TAIL_TOOLS =
  'Room lines reach you here. Answer them IN THE ROOM with the room_post tool (the bt server: mcp__bt__room_post; to reach the user start with @user; @handle addresses a seat). ' +
  'A reply only in your terminal is not seen. ' +
  'Talk between seats stays between those seats: do not start @user or copy the user on it. Address @user to report a result, ask a question, or ask for a decision.';

/** A LOCAL pane with no bt tools (a vendor with no carrier yet, or bt that did not connect): there is no fabric here, so the fabric room_post is NOT an answer. */
const TAIL_LOCAL =
  'Room lines reach you here. Answer them IN THE ROOM: you have no room tools on this pane, so use the "Post and read" lines in the room guide (a curl with your pane token; start with @user to reach the user, @handle to address a seat). ' +
  'A reply only in your terminal is not seen. ' +
  'Talk between seats stays between those seats: do not start @user or copy the user on it. Address @user to report a result, ask a question, or ask for a decision.';

/** Was this seat's pane launched with the bt tools (bt-launch.ts)? Read at welcome time, so a resumed pane says what is true of it now. */
function tailFor(seat: RoomSeat): string {
  if (seat.occupant_kind === 'pane' && btTools.isPlanned(String(seat.occupant ?? ''))) return TAIL_TOOLS;
  return isLocalMode(process.env) ? TAIL_LOCAL : TAIL;
}

type Enqueue = (paneid: string, text: string) => 'injected' | 'queued' | 'off' | 'vendor';
let enqueue: Enqueue = roomTyper.enqueueFabricText;
/** Tests swap the typer for a stub. */
export function setTyper(fn: Enqueue | null): void {
  enqueue = fn ?? roomTyper.enqueueFabricText;
}

/** "the lead is @x" / "the lead is @x (you)"; '' when the room has no lead. */
function leadClause(room: Room, seat: RoomSeat): string {
  const leadId = table.getRoom(room.id)?.lead_seat; // fresh: a reload or a move can change it
  const lead = leadId ? table.getSeat(leadId) : undefined;
  return lead ? `the lead is @${lead.handle}${lead.id === seat.id ? ' (you)' : ''}` : '';
}

/** The lead's rules [chatter p2], for the lead's own welcome only ('' for anyone else). */
function leadRules(room: Room, seat: RoomSeat): string {
  return agentComms().leadRules && table.getRoom(room.id)?.lead_seat === seat.id ? ` As lead, for each of the person's lines: ${roomTyper.LEAD_RULES}.` : '';
}

/** [room guide] "Read this room's guide first: <path> (or GET <url>)", the file written now. */
function guide(room: Room): string {
  roomGuide.writeGuide(room.id);
  return roomGuide.guideLine(room.id);
}

/** The whole welcome for a seat that joined without a greeting of its own. */
export function welcomeText(room: Room, seat: RoomSeat): string {
  const parent = room.parent_id ? table.getRoom(room.parent_id) : undefined;
  const lead = leadClause(room, seat);
  return `You are @${seat.handle} in "${room.name}"${parent ? `, a workgroup of "${parent.name}"` : ''}${lead ? `; ${lead}` : ''}. ${tailFor(seat)}${leadRules(room, seat)} ${guide(room)}`;
}

/** What a reload's own greeting gets appended, so a reload is ONE line. */
export function welcomeAppendix(room: Room, seat: RoomSeat): string {
  const lead = leadClause(room, seat);
  return `${lead ? `Also, ${lead}. ` : ''}${tailFor(seat)}${leadRules(room, seat)} ${guide(room)}`;
}

/** Record that this (seat, pane, room) has been told (the reload line carried it). */
export function markWelcomed(room: Room, seat: RoomSeat): void {
  if (seat.occupant_kind === 'pane' && seat.occupant) {
    table.claimSeatWelcome(seat.id, String(seat.occupant), room.id);
  }
}

/**
 * Deliver the welcome to the seat's live pane, once. Never throws: a welcome
 * that cannot be delivered is a log line, not a failed start.
 */
export function welcomeSeat(room: Room, seat: RoomSeat, log: (line: string) => void = () => {}): 'sent' | 'already' | 'skipped' {
  try {
    if (process.env.HARBOR_WB_SEAT_WELCOME === '0') return 'skipped'; // kill switch (and the typer-queue tests)
    if (roomTyper.doorbellOn()) return 'skipped'; // W1: the engine types no welcome line; the seat's handle and the room guide reach it through its role file and room_roster/room_read
    const paneid = seat.occupant_kind === 'pane' ? String(seat.occupant ?? '') : '';
    const row = paneid ? table.get(paneid) : undefined;
    if (!paneid || !row || row.state !== 'live' || !AGENT_VENDORS.has(String(row.vendor ?? ''))) {
      return 'skipped';
    }
    const fresh = table.getSeat(seat.id) ?? seat;
    if (!table.claimSeatWelcome(seat.id, paneid, room.id)) {
      return 'already';
    }
    const r = enqueue(paneid, welcomeText(room, fresh));
    if (r === 'off' || r === 'vendor') {
      table.releaseSeatWelcome(seat.id, paneid, room.id); // not delivered: the next bind tries again
      return 'skipped';
    }
    log(`room ${room.id}: welcome ${r} for @${seat.handle} in ${paneid}`);
    return 'sent';
  } catch (e) {
    log(`room ${room.id}: welcome for @${seat.handle} failed: ${(e as Error).message}`);
    return 'skipped';
  }
}

/** Welcome every seat of a room that now holds a live agent pane (a bulk bind). */
export function welcomeRoomSeats(roomId: string, log?: (line: string) => void): void {
  const room = table.getRoom(roomId);
  if (!room) return;
  for (const s of table.listSeats(roomId)) welcomeSeat(room, s, log);
}

/** SEAT CONTEXT for the pane's role file (E1, bt-launch.ts writeRoleFile): who the seat is, in words, written at LAUNCH for a pane that has the bt tools. */
export function seatContextText(room: Room, seat: RoomSeat): string {
  const parent = room.parent_id ? table.getRoom(room.parent_id) : undefined;
  const lead = leadClause(room, seat);
  return `You are @${seat.handle} in "${room.name}"${parent ? `, a workgroup of "${parent.name}"` : ''}${lead ? `; ${lead}` : ''}. ${TAIL_TOOLS}${leadRules(room, seat)}`;
}
