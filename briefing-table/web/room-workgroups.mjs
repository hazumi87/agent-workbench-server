/**
 * WORKGROUPS, the page's pure rules (Owner 2026-10-04, KB design-notes-id §10):
 * how a cross-posted line reads in the room that shows it, when a workgroup
 * notice is raised, and the header crumb. No DOM here, so a test can import it;
 * web/room.js paints from these answers.
 *
 * THE RULE the engine keeps and this page draws: a room shows every line written
 * in it, plus every line delivered to a seat in it. A line written HERE and
 * delivered only elsewhere is OUTGOING (dashed, "not posted in <this room>");
 * a line written elsewhere and delivered to a seat HERE is INCOMING ("from
 * <that room> -> @a, @b"). The engine's `entry.xpost` carries all of it.
 */

/** A room's label in a header: its alias when it has one, else its name. */
function roomLabel(t) {
  return t.alias || t.room_name;
}

/** `tool-operators/@claude-asset operator, apps/@alpha-platform` for an
 *  outgoing cross-post (targets in OTHER rooms only). */
export function outgoingTargets(xp) {
  return (xp?.targets ?? []).map((t) => `${roomLabel(t)}/@${t.handle}`);
}

/** The origin-room tag of an outgoing line that nobody in its own room got. */
export function outgoingTag(xp, roomName) {
  return `cross-post · not posted in ${roomName}`;
}

/** True when this entry is OUTGOING ONLY here: written in this room, delivered
 *  only to other rooms (nobody in this room, lead included, was addressed). */
export function isOutgoingOnly(xp) {
  return !!xp && xp.direction === 'out' && !xp.local;
}

/** `@a, @b` of an incoming line: who it reached in THIS room. */
export function incomingHandles(xp) {
  return (xp?.targets ?? []).map((t) => `@${t.handle}`).join(', ');
}

/** CROSS-POST FOLD [xpost fold] (Owner 2026-10-06: the same agent-to-agent line in two rooms read as chatter):
 *  an INCOMING copy of an agent's line that is not addressed to the person shows folded to its header line; the full
 *  text is one tap away and stays whole in the room it was written in. The addressed seat still received it. */
export function foldIncoming(xp, { toUser = false, byUser = false } = {}) {
  return xp?.direction === 'in' && !toUser && !byUser;
}

/* ---- CROSS-FAMILY UNREAD [cross unread] Owner 2026-10-06 ----
   The alert covers EVERY open room except the one on screen, not just this room's family. The data is the engine's
   GET /api/rooms/me/unread: [{roomId, name, familyHeadId, unread, newestId, color}], the unread counted exactly as the
   badges count it (what each room's default view shows, origin room only); newestId = the newest COUNTED line, so
   "View" can open the room that holds the newest one. */

/** The engine's rows as the notice's items: {id, name, unread, color, newestId, team}. `team` = the room belongs to a family of
 *  more than one open room (a main room with workgroups, or a workgroup): the words call those TEAMS, and a room that stands
 *  alone stays a room (Owner 2026-10-27: the strip said "3 rooms" for a main room and two teams). */
export function noticeRooms(rows) {
  const ok = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.roomId === 'string' && typeof r.unread === 'number');
  const size = new Map();
  for (const r of ok) {
    const head = r.familyHeadId ?? r.roomId;
    size.set(head, (size.get(head) ?? 0) + 1);
  }
  return ok.map((r) => ({ id: r.roomId, name: r.name, unread: r.unread, color: r.color ?? null, newestId: typeof r.newestId === 'number' ? r.newestId : null, team: (size.get(r.familyHeadId ?? r.roomId) ?? 1) > 1 }));
}

/** A family's rooms as notice items: the fallback when the cross-family read is unavailable. */
export function familyNoticeRooms(family) {
  const items = [...(family?.parent ? [family.parent] : []), ...(family?.workgroups ?? [])]
    .filter((r) => r.state !== 'archived' && typeof r.unread === 'number');
  return items.map((r) => ({ id: r.id, name: r.name, unread: r.unread, color: r.color ?? null, newestId: null, team: items.length > 1 }));
}

const byNewest = (a, b) => (b.newestId ?? -1) - (a.newestId ?? -1);

/** Rooms (other than the one on screen) that newly have unread lines since `prev` (a Map id -> unread, or null for the
 *  first look, which raises nothing: opening a page is not news). Newest first. */
export function noticeRaise(prev, rooms, currentRoomId) {
  if (!prev || !Array.isArray(rooms)) {
    return [];
  }
  return rooms.filter((r) => r.id !== currentRoomId && r.unread > (prev.get(r.id) ?? 0)).sort(byNewest);
}

/** The unread level of every room, for the next noticeRaise. */
export function unreadSnapshot(rooms) {
  const m = new Map();
  for (const r of rooms ?? []) {
    m.set(r.id, r.unread);
  }
  return m;
}

/** Rooms (other than the one on screen) that still hold unread lines, newest first: what the PHONE's persistent strip
 *  counts. Derived from the engine's per-person unread, so it clears by itself when the person visits those rooms. */
export function waitingRooms(rooms, currentRoomId) {
  return (rooms ?? []).filter((r) => r.id !== currentRoomId && r.unread > 0).sort(byNewest);
}

const cap = (n) => (n > 99 ? '99+' : String(n));

/** {lines, rooms, teams, newest, key}: the strip's numbers. `rooms` = how many places wait (the old name, kept), `teams` = how many of
 *  them are teams. `newest` = the room holding the newest counted line (View goes there);
 *  `key` = what the person dismissed (the newest line id, else the line total when ids are unavailable). */
export function noticeSummary(items) {
  const lines = items.reduce((a, r) => a + r.unread, 0);
  const newest = [...items].sort(byNewest)[0] ?? null;
  const ids = items.map((r) => r.newestId).filter((x) => typeof x === 'number');
  return { lines, rooms: items.length, teams: items.filter((r) => r.team).length, newest, key: ids.length ? Math.max(...ids) : lines };
}

/** What to call the places that wait: all teams -> "teams", none -> "rooms", a mix -> "rooms and teams". */
export function placeWord(sum) {
  return sum.teams > 0 && sum.teams === sum.rooms ? 'teams' : sum.teams > 0 ? 'rooms and teams' : 'rooms';
}

/** PHONE: the strip's words. Count only (Owner: "it's really about how many rather than where"). The sheet's title is this
 *  same text, so the two can never count differently. */
export function waitingText(sum) {
  return sum.rooms > 1 ? `${cap(sum.lines)} new in ${sum.rooms} ${placeWord(sum)}` : `${cap(sum.lines)} new`;
}

/** The sheet's sub-line, in the same words as the strip. */
export function chooseText(sum) {
  return sum.teams > 0 && sum.teams === sum.rooms ? 'choose a team' : sum.teams > 0 ? 'choose a room or team' : 'choose a room';
}

/** The sheet's accessible name, in the same words. */
export function waitingLabel(sum) {
  const w = placeWord(sum);
  return `${w[0].toUpperCase()}${w.slice(1)} with new messages`;
}

/** PC: the toast's names, newest first, at most 2 then "+N more". */
export function toastNames(items) {
  return { names: items.slice(0, 2), more: Math.max(0, items.length - 2) };
}

/** The ✕ hides the strip until something NEWER than what was dismissed arrives. */
export function stripHidden(sum, dismissedKey) {
  return dismissedKey !== null && sum.key <= dismissedKey;
}

/** `Message @lead ...` for the composer: who plain typing reaches. In a
 *  workgroup it also says where `@lead` goes. The tail ", or /help" is what
 *  the Tab hint rewrites (room.js paintTabHint), so it stays last. */
export function placeholderFor(room, leadHandle) {
  if (!leadHandle) {
    return null;
  }
  return room?.parent_id
    ? `Message @${leadHandle} (${room.name} lead), @lead for the main room, or /help`
    : `Message @${leadHandle}, @handle a seat, or /help`;
}

/** The same page for another room of the family, keeping every other query
 *  parameter (a shell tab keeps its frame's flags). */
export function roomHref(href, id) {
  const u = new URL(href, 'http://x');
  u.searchParams.set('room', id);
  u.hash = '';
  return `${u.pathname}${u.search}`;
}

/* ==== THE RAIL SPLIT [rail split] Owner 2026-10-05 (the design system [ref]) ==== */

/** The Seats bar's words: "Seats · <room name>", with the workgroup plate when
 *  the room is a workgroup. Pure so a test can drive it. */
/** The main room's Room-chat row, second line [layers] (the design system handoff 1.P): only what the badge at the right does not say. The chat's own count
 *  IS the badge, so it is not repeated in words unless the row has no workgroup news to say instead. n = this chat's unread, wgN = the
 *  workgroups' unread added. */
export function roomChatMeta(n, wgN) {
  return wgN > 0 ? `${wgN} new in workgroups` : n > 0 ? `${n} new` : 'main room';
}
/** The same row seen from a workgroup: "main room", or "main room · 3 new" (the main room's unread). */
export function mainRoomMeta(unread) {
  return unread > 0 ? `main room · ${unread} new` : 'main room';
}

export function seatsTitle(room) {
  return { prefix: 'Seats', name: room?.name ?? 'Room', plate: !!room?.parent_id };
}

/** The tabs of the + sheet per scope: the Room cell's + (Workgroup, App; the
 *  Workgroup tab only in a main room), the Seats cell's + (Add, Move), or null
 *  = the manager's own three (Agents, Workgroups, Apps). [id, label] pairs. */
export function addSheetTabs(scope, canWorkgroup) {
  if (scope === 'room') {
    return [...(canWorkgroup ? [['workgroups', 'Workgroup']] : []), ['apps', 'App']];
  }
  if (scope === 'seats') {
    return [['agents', 'Add'], ['move', 'Move']];
  }
  return null;
}

/** The rooms an agent can be moved HERE from: the family's other open rooms
 *  (the main room when this is a workgroup, and the siblings). */
export function moveSources(room, family) {
  const out = [];
  if (room?.parent_id && family?.parent) {
    out.push({ id: family.parent.id, name: family.parent.name, alias: family.parent.alias, main: true });
  }
  for (const w of family?.workgroups ?? []) {
    if (w.id !== room?.id && w.state !== 'archived') {
      out.push({ id: w.id, name: w.name, alias: w.alias, main: false });
    }
  }
  return out;
}
