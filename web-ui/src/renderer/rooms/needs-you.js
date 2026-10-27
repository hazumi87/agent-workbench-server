// P01 (the design s12): seats that need the person, across every room the page knows, said where the person looks when they are elsewhere:
// the Workrooms item's number ("Workrooms, {n} waiting"), the browser tab's title "({n}) Needs you · Agent Workbench" while another tab is
// in front, and, when notifications are on and the page is not in front, ONE browser notification per waiting seat until it is answered:
// "{room name} needs you" / "@{seat} is waiting for your OK." Only a room's name and a seat's handle ever go into one, never the terminal
// or the line. A tap brings the tab forward and opens that room. The web build passes the factory in (rooms/page.js stays desktop-clean).

export const NEEDS_WORDS = Object.freeze({
  title: (n) => '(' + n + ') Needs you · Agent Workbench',
});
export const NEEDS_POLL_MS = 15000;
/** After the page first sees its rooms, the first answers can disagree (a stored snapshot, then the server): a wait seen in this window
 *  was already there, and is counted but never told. */
export const NEEDS_WARM_MS = 10000;

/** A live seat whose agent waits for the person (stopped at a prompt, seen or not, or blocked). */
export function seatNeedsYou(s) {
  const o = s && s.status === 'live' ? s.occupant : null;
  return !!o && (o.state == null || o.state === 'live') && (!!o.blocked || o.activity === 'waiting' || o.activity === 'waiting-seen');
}

/**
 * Every waiting seat in `rooms` (the page's room views): [{key, roomId, familyId, roomName, handle, fresh}] where `fresh` is an ask not yet
 * seen anywhere (the engine's "waiting", not "waiting-seen"). skip(roomId) leaves a room out (a disconnected one).
 */
export function waitingSeats(rooms, { skip } = {}) {
  return roomSeats(rooms, { skip }).filter((x) => x.waiting);
}
/** Every seat of every room the page knows, each with whether it waits ({..., waiting, fresh}). */
function roomSeats(rooms, { skip } = {}) {
  const out = [];
  for (const v of rooms || []) {
    if (!v || !v.room || !v.room.id || v.room.state === 'archived' || (skip && skip(v.room.id))) continue;
    for (const s of Array.isArray(v.seats) ? v.seats : []) {
      if (!s || !s.id || s.left_at) continue;
      const waiting = seatNeedsYou(s);
      out.push({ key: v.room.id + ':' + s.id, seatId: String(s.id), roomId: v.room.id, familyId: v.room.parent_id || v.room.id, roomName: String(v.room.name || 'A room'),
        handle: String(s.handle || ''), waiting, fresh: waiting && (s.occupant.activity === 'waiting' || !!s.occupant.blocked) });
    }
  }
  return out;
}

/**
 * deps: doc, win, fire(count) (the nav's 'rooms-waiting'), notify({room, seat, tag, onClick}) (browserActions.notifyNeedsYou),
 *       notifyOn() -> bool (Settings › Notifications on and allowed), openRoom(familyId, roomId), poll() (refresh the room list), timers
 */
export function createNeedsYou(deps) {
  const doc = deps.doc || globalThis.document;
  const win = deps.win || globalThis;
  const clock = deps.now || (() => Date.now());
  const timers = deps.timers || { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id) };
  let count = -1, list = [], ours = null, prior = null, disposed = false, warmUntil = 0;
  const handled = new Set(); // the waits already dealt with: one notification per wait
  const calm = new Set(); // seats this page has SEEN not waiting: only their next wait is news (a wait already there at load is not)
  const inFront = () => doc.visibilityState !== 'hidden' && (typeof doc.hasFocus !== 'function' || doc.hasFocus());

  function paintTitle() {
    const want = list.length && doc.visibilityState === 'hidden' ? NEEDS_WORDS.title(list.length) : null;
    if (want) {
      if (doc.title !== ours) prior = doc.title; // the app's own title, given back when we are done
      ours = want;
      doc.title = want;
    } else if (ours !== null) {
      if (doc.title === ours) doc.title = prior || doc.title;
      ours = null;
    }
  }

  function update(rooms, opts) {
    if (disposed) return;
    const all = roomSeats(rooms, opts);
    list = all.filter((x) => x.waiting);
    if (!warmUntil && all.length) warmUntil = clock() + NEEDS_WARM_MS;
    const warm = !warmUntil || clock() < warmUntil;
    if (list.length !== count) { count = list.length; try { deps.fire(count); } catch (e) { /* the nav's own error */ } }
    paintTitle();
    for (const x of all) if (!x.waiting) { calm.add(x.key); handled.delete(x.key); } // answered: a later wait is told again
    for (const x of list) {
      if (handled.has(x.key)) continue;
      handled.add(x.key);
      const news = calm.delete(x.key); // it was seen not waiting: this wait started while the page was open
      if (warm || !news || !x.fresh || inFront() || !deps.notifyOn()) continue; // there at load, already seen, or you are here
      try {
        deps.notify({ room: x.roomName, seat: x.handle, tag: ('wb-needs-' + x.seatId).slice(0, 80), onClick: () => { try { win.focus(); } catch (e) { /* the browser's call */ } deps.openRoom(x.familyId, x.roomId); } });
      } catch (e) { /* the browser refused: its own feedback said so */ }
    }
  }

  const onVisible = () => paintTitle();
  doc.addEventListener('visibilitychange', onVisible);
  const poll = timers.setInterval(() => { if (!disposed) deps.poll(); }, NEEDS_POLL_MS);

  return {
    update,
    count: () => Math.max(0, count),
    /** Signed out or another account: nothing waits, nothing was told. */
    reset() { list = []; handled.clear(); calm.clear(); count = -1; warmUntil = 0; update([]); },
    dispose() { disposed = true; timers.clearInterval(poll); doc.removeEventListener('visibilitychange', onVisible); list = []; paintTitle(); },
  };
}
