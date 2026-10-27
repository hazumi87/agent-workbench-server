'use strict';
// Rail card admission in main (the design notes revision 10; the lead , , the mechanism
// approved ). The renderer draws a module's rail card only with main's admission: main keeps, per window,
// each module's admitted card ids in registration order and refuses a third, whatever the renderer does or fails to
// do; it checks its own catalog; kind 'room-tasks' needs rooms.tasks.read and a room whose main cache has a Room
// Tasks panel, and sorts first (main's rule on the source, never a number the module sends); any other kind is
// refused. A stale account selection, a window close, a module generation bump or a room change drops the cards.
// Pure: main hands in its own state. test/module-cards.test.mjs.

const MAX_CARDS = 2;
const CARD_ID = /^[a-z][a-z0-9-]{0,23}$/;
const KINDS = new Set(['room-tasks']); // and null, a plain card
const MAX_ROOM = 128;

/**
 * deps: catalog() → main's module state · moduleGen(id) · account() → {accountId, selectionVersion}
 *  roomKnown(roomId) → bool (main's rooms cache, current account) · roomTasksPanel(roomId) → bool
 */
function createCardAdmission(deps) {
  const wins = new Map(); // winId → Map(moduleId → { roomId, gen, accountId, selectionVersion, cards: [{cardId, kind, seq}] })
  let seq = 0;

  const entryOf = (id) => deps.catalog().find((m) => m.id === id) || null;
  const allowed = (m) => !!m && m.source === 'bundled' && m.enabled === true && !m.error && m.class === 'tool' &&
    !!m.tool && Array.isArray(m.tool.contexts) && m.tool.contexts.includes('workroom') && Array.isArray(m.permissions) && m.permissions.includes('ui.railCard');
  const current = (rec, moduleId) => {
    const a = deps.account() || {};
    return rec.accountId === a.accountId && rec.selectionVersion === a.selectionVersion && rec.gen === deps.moduleGen(moduleId) &&
      allowed(entryOf(moduleId)) && deps.roomKnown(rec.roomId);
  };
  const sorted = (cards) => [...cards].sort((x, y) => (x.kind === 'room-tasks' ? 0 : 1) - (y.kind === 'room-tasks' ? 0 : 1) || x.seq - y.seq);
  const refuse = (why) => ({ ok: false, why });

  return Object.freeze({
    /** {moduleId, cardId, kind, roomId} from the app page. → {ok, seq, kind} | {ok:false, why}. */
    admit(winId, a) {
      const moduleId = a && typeof a.moduleId === 'string' ? a.moduleId : '';
      const m = entryOf(moduleId);
      if (!allowed(m)) return refuse('not a bundled workroom tool with ui.railCard');
      const cardId = a.cardId;
      if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return refuse('a card id is a-z, digits and dashes, at most 24');
      const kind = a.kind === undefined || a.kind === null ? null : a.kind;
      if (kind !== null && !KINDS.has(kind)) return refuse('unknown card kind');
      const roomId = typeof a.roomId === 'string' && a.roomId.length <= MAX_ROOM ? a.roomId : '';
      if (!roomId || !deps.roomKnown(roomId)) return refuse('no such room here');
      if (kind === 'room-tasks') {
        if (!m.permissions.includes('rooms.tasks.read')) return refuse('room-tasks needs rooms.tasks.read');
        if (!deps.roomTasksPanel(roomId)) return refuse('no Room Tasks panel in this room');
      }
      const acct = deps.account() || {};
      let mods = wins.get(winId);
      if (!mods) wins.set(winId, (mods = new Map()));
      let rec = mods.get(moduleId);
      // a room change, a stale selection or a new generation starts the module's list afresh
      if (!rec || rec.roomId !== roomId || !current(rec, moduleId)) {
        rec = { roomId, gen: deps.moduleGen(moduleId), accountId: acct.accountId, selectionVersion: acct.selectionVersion, cards: [] };
        mods.set(moduleId, rec);
      }
      const others = rec.cards.filter((c) => c.cardId !== cardId);
      if (others.length >= MAX_CARDS) return refuse('a module has at most two rail cards');
      const card = { cardId, kind, seq: ++seq };
      rec.cards = [...others, card]; // the same id again replaces, with a new sequence
      return { ok: true, seq: card.seq, kind };
    },
    /** Forget exactly one admission: the card id AND the sequence it was admitted with (an old release never removes
     *  a fresh admission of the same id, a builder ). */
    release(winId, a) {
      const rec = wins.get(winId)?.get(a && a.moduleId);
      if (!rec || !a || !Number.isSafeInteger(a.seq)) return;
      rec.cards = rec.cards.filter((c) => !(c.cardId === a.cardId && c.seq === a.seq));
    },
    /** Is this card admitted, now, for this window, module and room? */
    isAdmitted(winId, a) {
      const rec = wins.get(winId)?.get(a && a.moduleId);
      return !!rec && rec.roomId === (a && a.roomId) && current(rec, a.moduleId) && rec.cards.some((c) => c.cardId === a.cardId);
    },
    /** The module's admitted cards, in main's order (room-tasks first, then registration). */
    admitted(winId, moduleId) {
      const rec = wins.get(winId)?.get(moduleId);
      return rec && current(rec, moduleId) ? sorted(rec.cards).map((c) => ({ ...c })) : [];
    },
    /** After any change main makes (account, selection, a module scan or setting, the rooms cache): drop what went stale. */
    checkAll() {
      for (const mods of wins.values()) for (const [moduleId, rec] of mods) if (!current(rec, moduleId)) mods.delete(moduleId);
    },
    windowGone(winId) {
      wins.delete(winId);
    },
  });
}

module.exports = { createCardAdmission, MAX_CARDS };
