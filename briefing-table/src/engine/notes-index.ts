/* ============================================================================
 * ROOM NOTES INDEXING [ticket]. Keywords (top terms by tf x idf) and the
 * index-now / idle-sweep machinery. A note is indexed on close, on attach, or
 * when the sweep finds it dirty and idle (a refresh or disconnect ended the
 * editor); never per keystroke. Logs counts and ids only, never text.
 * ========================================================================== */

import { table } from '../table/endpoint.ts';

export const KEYWORDS_MAX = 12;
/** A dirty note is indexed once it has been idle this long. */
export const IDLE_MS = 30_000;
export const SWEEP_MS = 15_000;
export const EMPTY_MS = 600_000; // an empty note this old is an abandoned "New note"

const STOP = new Set(
  (
    'a about above after again against all also am an and any are aren as at be because been before being below between both but by ' +
    'can cannot could did do does doing done down during each few for from further had has have having he her here hers him his how i if ' +
    'in into is it its itself just let me more most my no nor not now of off on once only or other our ours out over own same she should so ' +
    'some such than that the their theirs them then there these they this those through to too under until up us very was we were what ' +
    'when where which while who whom why will with would you your yours yes get got like one two also really still much many may might ' +
    'say said want need going know think see use used using'
  ).split(' '),
);

/** What a room's other notes say about a term: n indexed notes, df(term) of
 *  them contain it. Absent (a lone call), every term weighs the same. */
export interface TermStats {
  n: number;
  df: (term: string) => number;
}

interface Seen {
  n: number;
  first: number;
  firstLine: boolean;
  nudge: boolean;
  shown: string;
}

/* A term is a run of letters and digits, 3+ characters, not a stopword. */
function scan(text: string): Map<string, Seen> {
  const seen = new Map<string, Seen>();
  const lineEnd = text.search(/\n/);
  const firstEnd = lineEnd < 0 ? text.length : lineEnd;
  let i = 0;
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const tok = m[0];
    const low = tok.toLowerCase();
    if (low.length < 3 || STOP.has(low)) {
      continue;
    }
    const at = m.index ?? 0;
    const digit = /\p{N}/u.test(tok);
    const allCaps = tok.length > 1 && tok === tok.toUpperCase() && tok !== tok.toLowerCase();
    /* a name: capitalized with something before it in the sentence */
    let back = at - 1;
    while (back >= 0 && /[ \t]/.test(text[back])) {
      back--;
    }
    const mid = back >= 0 && !/[.!?\n\r]/.test(text[back]);
    const name = mid && tok[0] !== tok[0].toLowerCase() && tok[0] === tok[0].toUpperCase();
    const e = seen.get(low);
    if (e) {
      e.n++;
      e.firstLine ||= at < firstEnd;
      e.nudge ||= digit || name;
    } else {
      seen.set(low, { n: 1, first: i++, firstLine: at < firstEnd, nudge: digit || name, shown: digit || allCaps ? tok : low });
    }
  }
  return seen;
}

/** The distinct terms of a text (what the room's term table counts). */
export function termsOf(text: string): string[] {
  return [...scan(text).keys()];
}

/** Top terms by weight = tf x idf, idf = ln((N + 1) / (df + 1)) + 1 over the
 *  room's indexed notes; x1.5 for a term in the note's first line, x1.3 for a
 *  name (capitalized mid-sentence) or a term with a digit (ticket, v2). Ties:
 *  higher tf, then first appearance. Lowercase, except an all-caps or digit-
 *  bearing term keeps the casing it first appeared with. */
export function keywordsOf(text: string, max = KEYWORDS_MAX, stats?: TermStats): string[] {
  const weight = (k: string, e: Seen): number => {
    const idf = stats ? Math.log((stats.n + 1) / (stats.df(k) + 1)) + 1 : 1;
    return e.n * idf * (e.firstLine ? 1.5 : 1) * (e.nudge ? 1.3 : 1);
  };
  return [...scan(text).entries()]
    .map(([k, e]) => ({ e, w: weight(k, e) }))
    .sort((a, b) => b.w - a.w || b.e.n - a.e.n || a.e.first - b.e.first)
    .slice(0, max)
    .map((x) => x.e.shown);
}

/* A note's TAGS (what its card shows) are a few topics, not its words back again
   (the design system [ref]): at most three, and none for a note too short to have a topic. */
export const TAGS_MAX = 3;
export const TAGS_MIN_TERMS = 8;
export function tagsOf(text: string, max = TAGS_MAX, stats?: TermStats): string[] {
  if (scan(text).size < TAGS_MIN_TERMS) {
    return [];
  }
  return keywordsOf(text, Math.min(max, TAGS_MAX), stats);
}

/** The two halves the table needs to index or re-rank a note. */
export const ranker = { keywords: tagsOf, terms: termsOf };

/** Index one note now. Returns the row, or undefined when it does not exist. */
export function indexNote(id: string) {
  return table.indexRoomNote(id, ranker);
}

/** Re-rank every note's keywords with the room's current counts, once at
 *  start: pass 1 fills the term table for notes that predate it, pass 2
 *  re-ranks, both in small batches so boot never waits on it. Only the note
 *  being indexed is ever re-ranked afterward, so other notes' keywords can be
 *  a little stale as the room grows; that is accepted. Never throws. */
export function rerankAll(log: (line: string) => void, batch = 20): void {
  let ids: string[] = [];
  try {
    ids = table.allRoomNoteIds();
  } catch {
    return;
  }
  let done = 0;
  let failed = 0;
  const run = (pass: 1 | 2, from: number): void => {
    for (const id of ids.slice(from, from + batch)) {
      try {
        if (pass === 1) {
          table.fillRoomNoteTerms(id, termsOf);
        } else {
          table.rerankRoomNote(id, ranker);
          done++;
        }
      } catch {
        failed++;
      }
    }
    if (from + batch < ids.length) {
      setTimeout(() => run(pass, from + batch), 0);
    } else if (pass === 1) {
      setTimeout(() => run(2, 0), 0);
    } else {
      log(`room notes: re-ranked ${done} note(s)${failed ? `, ${failed} failed` : ''}`);
    }
  };
  setTimeout(() => run(1, 0), 0);
}

/** Close a note: an empty (or whitespace-only) one is removed instead of indexed.
 *  Returns the indexed row; null when it was removed; undefined when it does not exist. */
export function closeNote(id: string) {
  const row = table.indexRoomNote(id, ranker);
  if (row && !row.text.trim()) {
    table.removeRoomNote(id);
    return null;
  }
  return row;
}

/** Index every dirty note idle for IDLE_MS, and remove empty notes untouched for
 *  EMPTY_MS (updated_at, so a box someone just emptied is not pulled from under them).
 *  Never throws. */
export function sweep(now = Date.now(), idleMs = IDLE_MS): number {
  let n = 0;
  try {
    for (const id of table.emptyRoomNoteIds(now - EMPTY_MS)) {
      table.removeRoomNote(id);
      n++;
    }
    for (const id of table.dirtyRoomNoteIds(now - idleMs)) {
      if (indexNote(id)) {
        n++;
      }
    }
  } catch {
    /* the table is unreadable right now: the next tick tries again */
  }
  return n;
}

let timer: NodeJS.Timeout | null = null;

export function startSweep(log: (line: string) => void): void {
  if (timer) {
    return;
  }
  timer = setInterval(() => {
    const n = sweep();
    if (n) {
      log(`room notes: indexed ${n} idle note(s)`);
    }
  }, SWEEP_MS);
  timer.unref();
}

export function stopSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
