'use strict';
// The pane a seat has right now, from the room views main already holds: only a live or parked seat that has not left, in that room.
function seatPaneOf(views, roomId, seatId) {
  if (!Array.isArray(views) || typeof roomId !== 'string' || typeof seatId !== 'string') return null;
  const view = views.find((v) => v && ((v.room && v.room.id === roomId) || v.id === roomId));
  const seat = view && Array.isArray(view.seats) ? view.seats.find((x) => x && x.id === seatId) : null;
  if (!seat || seat.left_at || !['live', 'parked'].includes(seat.status)) return null;
  return seat.occupant && typeof seat.occupant.id === 'string' && seat.occupant.id ? seat.occupant.id : null;
}

/** A seat found by id alone: { roomId, paneId } when exactly one room has it live or parked, else null (an ambiguous id is refused). */
function locateSeat(views, seatId) {
  if (!Array.isArray(views) || typeof seatId !== 'string') return null;
  const found = [];
  for (const v of views) {
    const roomId = v && ((v.room && v.room.id) || v.id);
    const paneId = typeof roomId === 'string' ? seatPaneOf(views, roomId, seatId) : null;
    if (paneId && !found.some((f) => f.roomId === roomId)) found.push({ roomId, paneId });
  }
  return found.length === 1 ? found[0] : null;
}

module.exports = { seatPaneOf, locateSeat };
