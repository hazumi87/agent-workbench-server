// Tasks seam S1 (the design notes S1, R1; revision 3 items 5 and 7): the pure half of the
// host-drawn rail card. checkCard() validates a module's descriptor before the host draws anything
// (plain text only, allow-listed glyphs, numbers in range, no extra fields); the binding ties every
// card, update and rooms.* event to its owner (module generation, account, engine, room/family), so a
// late update after a switch is dropped. No DOM here: rooms/page.js draws, modules.js admits.

const LIMITS = Object.freeze({ title: 40, line: 80, note: 40, spans: 48, seats: 8, badge: 999 });
const ICONS = new Set(['task_alt', 'checklist', 'monitoring', 'speed']);
const FIELDS = ['title', 'icon', 'pct', 'linked', 'spans', 'axis', 'line', 'badge', 'note'];
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
// No markup, no control characters (newlines and tabs included) and no bidi overrides or isolates,
// any of which could make a card read as something it is not (a builder's review, finding a).
const SPOOF = /[<>\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;
const plain = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && !SPOOF.test(s);
// Strict ISO-8601 date-time with seconds and a zone (finding b): Date.parse alone accepts "1".
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const iso = (s) => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s));
const fail = (error) => ({ ok: false, error });

/** A module's rail card descriptor → `{ ok, card }` (normalised) or `{ ok: false, error }`. */
export function checkCard(d) {
  if (!isObj(d)) {
    return fail('the descriptor must be an object');
  }
  const extra = Object.keys(d).find((k) => !FIELDS.includes(k));
  if (extra) {
    return fail('unknown field ' + extra);
  }
  if (!plain(d.title, LIMITS.title)) {
    return fail('title is plain text, 1 to ' + LIMITS.title + ' characters');
  }
  if (d.icon !== undefined && !ICONS.has(d.icon)) {
    return fail('icon must be one of the host glyphs');
  }
  if (d.pct !== null && d.pct !== undefined && !(typeof d.pct === 'number' && Number.isFinite(d.pct) && d.pct >= 0 && d.pct <= 100)) {
    return fail('pct is a number 0 to 100, or null');
  }
  if (d.linked !== null && d.linked !== undefined && typeof d.linked !== 'boolean') {
    return fail('linked is true, false or null');
  }
  const spans = d.spans ?? [];
  if (!Array.isArray(spans) || spans.length > LIMITS.spans || !spans.every((s) => isObj(s) && Object.keys(s).every((k) => ['a', 'b', 'n'].includes(k))
    && typeof s.a === 'number' && typeof s.b === 'number' && s.a >= 0 && s.b <= 1 && s.a < s.b
    && (s.n === 'needs' || (Number.isInteger(s.n) && s.n >= 1 && s.n <= LIMITS.seats)))) {
    return fail('spans: at most ' + LIMITS.spans + ' of {a, b, n} with 0 <= a < b <= 1 and n 1 to ' + LIMITS.seats + ' or "needs"');
  }
  if (d.axis !== undefined && d.axis !== null && !(isObj(d.axis) && iso(d.axis.from) && iso(d.axis.to) && Object.keys(d.axis).length === 2)) {
    return fail('axis is {from, to} as ISO times');
  }
  if (d.line !== undefined && d.line !== null && !plain(d.line, LIMITS.line)) {
    return fail('line is plain text, up to ' + LIMITS.line + ' characters');
  }
  // a short muted note after the % ("2 seats quiet", the design's Tasks §4): plain text, display only
  if (d.note !== undefined && d.note !== null && !plain(d.note, LIMITS.note)) {
    return fail('note is plain text, up to ' + LIMITS.note + ' characters');
  }
  const b = d.badge;
  if (b !== null && b !== undefined && !(isObj(b) && Object.keys(b).length === 2 && b.kind === 'needs' && Number.isInteger(b.count) && b.count >= 1 && b.count <= LIMITS.badge)) {
    return fail('badge is {count 1 to ' + LIMITS.badge + ', kind "needs"} or null');
  }
  return {
    ok: true,
    card: {
      title: d.title, icon: d.icon || 'task_alt', pct: d.pct ?? null, linked: d.linked ?? null,
      spans: spans.map((s) => ({ a: s.a, b: s.b, n: s.n })), axis: d.axis ? { from: d.axis.from, to: d.axis.to } : null,
      line: d.line || null, badge: b ? { count: b.count, kind: 'needs' } : null, note: d.note || null,
    },
  };
}

const owners = new WeakMap(); // binding -> the owner it was issued for (the frame/module never sees it)

/** An opaque, frozen binding for one owner: {moduleId, gen, accountEpoch, engineEpoch, roomId, familyId}. */
const ownerOk = (o) => !!o && ['moduleId', 'roomId', 'familyId'].every((k) => idStr(o[k]))
  && ['gen', 'accountEpoch', 'engineEpoch'].every((k) => Number.isInteger(o[k]));
const idStr = (x) => typeof x === 'string' && x.length > 0 && x.length <= 128;

/** An opaque, frozen binding for one owner. An incomplete or mistyped owner gives a binding that is never current (finding c). */
export function makeBinding(owner) {
  const b = Object.freeze({});
  if (ownerOk(owner)) {
    owners.set(b, Object.freeze({ ...owner }));
  }
  return b;
}

/** Is this binding the one issued for the owner as it is NOW? A copy, or any changed field, is not. */
export function bindingCurrent(b, now) {
  const o = b && owners.get(b);
  return !!o && ownerOk(now) && o.moduleId === now.moduleId && o.gen === now.gen && o.accountEpoch === now.accountEpoch
    && o.engineEpoch === now.engineEpoch && o.roomId === now.roomId && o.familyId === now.familyId;
}

/** S4 step 5: the owner a binding was issued for (a frozen copy), or null. Host-only: the frame never sees it. */
export function bindingOwner(b) {
  return (b && owners.get(b)) || null;
}

/** Does a rooms.* event belong to this binding's family, while the binding is current? */
export function eventForBinding(b, now, ev) {
  return bindingCurrent(b, now) && !!ev && ev.familyId === owners.get(b).familyId;
}

const idOk = (x) => typeof x === 'string' && x.length > 0 && x.length <= 128;
/**
 * The rooms.shown payload check, the renderer's copy of src/rooms/task-events.js checkShown (main is
 * CommonJS; this file is a renderer module): the same three fields, null for "no room shown", or
 * undefined when malformed (never delivered). A test holds the two to the same answers.
 */
export function checkShown(p) {
  if (p === null) {
    return null;
  }
  if (!isObj(p) || !Object.keys(p).every((k) => ['roomId', 'familyId', 'group'].includes(k)) || !idOk(p.roomId) || !idOk(p.familyId)) {
    return undefined;
  }
  if (p.group !== null && !idOk(p.group)) {
    return undefined;
  }
  return { roomId: p.roomId, familyId: p.familyId, group: p.group };
}

/**
 * The host's rail cards: up to two per module (revision 10, the owner ), keyed by (module, card id), each with
 * the binding it was registered under. update() and cardsFor() only honour a binding that is current for `now`
 * (the module's generation, the account, the engine and the room shown); a remove() kills a binding for good.
 * cardsFor(ctx, orderOf?, genOf?): the cards to draw for the room shown, in install order, then by the card's
 * a 'room-tasks' card first (main's rule on its source), then main's admission sequence (registration order). A
 * card registered without an id is the module's 'main' card.
 */
export const MAX_CARDS_PER_MODULE = 2;
const CARD_ID = /^[a-z][a-z0-9-]{0,23}$/;
export function createCardRegistry() {
  const recs = new Map(); // moduleId -> Map(cardId -> { binding, card, seq, kind })
  let ownSeq = 0; // a registration without main's sequence (tests, the one-card path) still has an order
  const find = (moduleId, binding) => {
    for (const [cardId, r] of recs.get(moduleId) || []) if (r.binding === binding) return cardId;
    return null;
  };
  return {
    /** seq: main's admission sequence (registration order); kind: null, or 'room-tasks' (main's rule: first). */
    register(moduleId, owner, cardId = 'main', seq = undefined, kind = null) {
      if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) throw new Error('a card id is a-z, digits and dashes, at most 24');
      if (seq === undefined) seq = ++ownSeq;
      else if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('a card sequence is a positive whole number from main');
      if (kind !== null && kind !== 'room-tasks') throw new Error('unknown card kind');
      const cards = recs.get(moduleId) || new Map();
      if (!cards.has(cardId) && cards.size >= MAX_CARDS_PER_MODULE) throw new Error('a module has at most two rail cards');
      const binding = makeBinding({ ...owner, moduleId });
      cards.delete(cardId); // a re-registration takes its new place
      cards.set(cardId, { binding, card: null, seq, kind });
      recs.set(moduleId, cards);
      return binding;
    },
    update(binding, desc, now) {
      const cardId = now ? find(now.moduleId, binding) : null;
      if (cardId === null || !bindingCurrent(binding, now)) {
        return false;
      }
      const c = checkCard(desc);
      if (!c.ok) {
        return false;
      }
      recs.get(now.moduleId).get(cardId).card = c.card;
      return true;
    },
    /** One card, or (no card id) every card of the module. */
    remove(moduleId, cardId) {
      if (cardId === undefined) {
        recs.delete(moduleId);
        return;
      }
      const cards = recs.get(moduleId);
      if (!cards) return;
      cards.delete(cardId);
      if (!cards.size) recs.delete(moduleId);
    },
    /** Every registration dies (its binding can never be current again): a room or visibility transition. */
    clear() {
      recs.clear();
    },
    cardsFor(ctx, orderOf = () => Infinity, genOf = null) {
      const out = [];
      for (const [moduleId, cards] of recs) {
        const now = { ...ctx, moduleId, gen: genOf ? genOf(moduleId) : ctx.gen };
        for (const [cardId, r] of cards) {
          if (r.card && bindingCurrent(r.binding, now)) {
            out.push({ moduleId, cardId, card: r.card, seq: r.seq, kind: r.kind });
          }
        }
      }
      const o = (id) => {
        const v = orderOf(id);
        return typeof v === 'number' && Number.isFinite(v) ? v : Infinity;
      };
      const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      const rt = (c) => (c.kind === 'room-tasks' ? 0 : 1);
      return out.sort((x, y) => o(x.moduleId) - o(y.moduleId) || cmp(x.moduleId, y.moduleId) || rt(x) - rt(y) || x.seq - y.seq)
        .map(({ moduleId, cardId, card }) => ({ moduleId, cardId, card }));
    },
    /** The binding of one card ('main' when no id is given). */
    bindingOf(moduleId, cardId = 'main') {
      return recs.get(moduleId)?.get(cardId)?.binding || null;
    },
    /** Every current registration with main's sequence: what a hide or a room transition releases. */
    registrations(moduleId) {
      const out = [];
      for (const [m, cards] of recs) if (moduleId === undefined || m === moduleId) for (const [cardId, r] of cards) out.push({ moduleId: m, cardId, seq: r.seq });
      return out;
    },
    bindingsOf(moduleId) {
      return [...(recs.get(moduleId)?.values() || [])].map((r) => r.binding);
    },
    /** Which of the module's cards a binding is, or null. */
    cardOf(moduleId, binding) {
      return find(moduleId, binding);
    },
  };
}
