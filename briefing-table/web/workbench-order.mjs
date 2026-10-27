/* THE WORKBENCH'S AGENT ORDER (Owner, room [ref]): when the live list shows agents that sit in rooms, sort them by ROOT
 * (name order), then within the root: the root's own seats first, then each GROUP (workgroup, name order), then seat order
 * (lead first, then by handle). A seat reads "Root › Group · @handle" (a seat in a root: "Root · @handle").
 * ROOT = main room (no parent), GROUP = workgroup under it. Only OPEN rooms and seats that have not left count. A pane
 * seated in a root AND a group answers the root (manager-rooms.mjs roomOfPanes' rule). Pure: no DOM, no fetch. */
const by = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
const paneOf = (s) => (typeof s.occupant === 'object' ? s.occupant?.id : s.occupant_kind === 'pane' ? s.occupant : null);

/** pane id -> {rootId, rootName, groupName|null, handle, lead, room, rank:[rootName, groupRank, groupName]}. */
export function seatIndex(rooms) {
  const open = (rooms || []).filter((v) => v && v.room && v.room.state === 'open');
  const ids = new Set(open.map((v) => v.room.id));
  const nameOf = new Map(open.map((v) => [v.room.id, v.room.name]));
  const out = new Map();
  /* roots first, so a pane seated in both answers the root */
  const list = [...open].sort((a, b) => (a.room.parent_id && ids.has(a.room.parent_id) ? 1 : 0) - (b.room.parent_id && ids.has(b.room.parent_id) ? 1 : 0));
  for (const v of list) {
    const isGroup = !!v.room.parent_id && ids.has(v.room.parent_id);
    const rootId = isGroup ? v.room.parent_id : v.room.id;
    const rootName = isGroup ? nameOf.get(rootId) : v.room.name;
    for (const s of v.seats || []) {
      const pane = paneOf(s);
      if (!pane || out.has(pane) || (s.left_at !== null && s.left_at !== undefined)) {
        continue;
      }
      out.set(pane, {
        rootId,
        rootName,
        groupName: isGroup ? v.room.name : null,
        handle: s.handle || '',
        lead: v.room.lead_seat ? v.room.lead_seat === s.id : !!s.is_lead,
        room: v.room,
        isGroup,
      });
    }
  }
  return out;
}

/** "Root › Group · @handle" / "Root · @handle" (no handle: just the room part). */
export function seatLabel(info) {
  const room = info.groupName ? `${info.rootName} › ${info.groupName}` : info.rootName;
  return info.handle ? `${room} · @${info.handle}` : room;
}

/** Sort rows ({paneid}) that sit in an open room. Rows with no seat are NOT returned (the caller keeps its own order for
 *  them). Returns [{row, info}]. */
export function orderSeated(rows, rooms) {
  const idx = seatIndex(rooms);
  return rows
    .filter((r) => idx.has(r.paneid))
    .map((row) => ({ row, info: idx.get(row.paneid) }))
    .sort((a, b) => {
      const x = a.info;
      const y = b.info;
      return by(x.rootName, y.rootName) || by(x.rootId, y.rootId)
        || (x.isGroup ? 1 : 0) - (y.isGroup ? 1 : 0)
        || by(x.groupName ?? '', y.groupName ?? '') || by(x.room.id, y.room.id)
        || (y.lead ? 1 : 0) - (x.lead ? 1 : 0)
        || by(x.handle, y.handle) || by(a.row.paneid, b.row.paneid);
    });
}
