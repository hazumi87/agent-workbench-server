/* THE "TO ME" RULE, ONE COPY (Owner 2026-10-26: a To-me view that only filtered the newest loaded page showed nothing when the lines to the person were older).
 * The page (web/room.js) and the engine (GET .../line?to=me, src/server/rooms.ts) both read this module, so the filter and the paging cannot disagree.
 *
 *   toMeFlags(entry)              the flags the rule reads, from an API line (what the page also writes to the line's dataset)
 *   isToMe(flags, namesPerson)    the rule; `namesPerson` = a fact's own text names the person (web/fact-mentions.mjs factIsToMe), computed by the caller
 *   isHiddenFact(entry)           a fact for clients that fold it: drawn by nobody, so counted by nobody
 *
 * The prose of the rule (a quote never counts, a fact is to me only when flagged or named, a tool line only when I started it, "between agents") is on matchesWho
 * in web/room.js; the cases are test/fixtures/to-me-cases.json. Pure: no imports, so the engine and a browser can load it alike. */

function metaOf(e) {
  try {
    const m = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

export function toMeFlags(e) {
  const m = metaOf(e);
  return {
    kind: e.kind,
    author: e.author ?? '',
    authorSeat: e.author_seat ?? '',
    target: e.target ?? '',
    targetSeat: e.target_seat ?? '',
    /* addressed to THE USER: the explicit meta.to_user, or for an older line the stored shape (target = a handle or 'user', no seat) */
    toUser: m?.to_user === true || !!(e.target && !e.target_seat && e.target !== 'room' && e.target !== 'lead'),
    tool: m && typeof m.tool === 'string' ? m.tool : '',
    for: m && typeof m.tool === 'string' ? String(m.for ?? '') : '',
  };
}

export function isToMe(f, namesPerson = false) {
  if (f.kind === 'voice') {
    return true; // every voice line is part of the user's own conversation
  }
  if (f.kind === 'fact') {
    return namesPerson === true || f.toUser === true;
  }
  if (f.tool) {
    return f.for === 'user';
  }
  return (
    f.author === 'user' ||
    f.author === 'voice' ||
    f.author === 'concierge' || // its proxy lines are the person's own conversation
    f.target === 'room' ||
    f.toUser === true ||
    (!f.target && !!f.authorSeat && f.authorSeat === f.targetSeat) // the lead's unaddressed line is stored as to itself
  );
}

export function isHiddenFact(e) {
  if (e.kind !== 'fact') {
    return false;
  }
  const m = metaOf(e);
  return m?.hidden === true || m?.turn?.kind === 'closed';
}
