/**
 * SEARCH SNIPPETS (Owner 2026-10-06; the design system BUILD-HANDOFF §1.K). One shared rule for room lines
 * and agent-chat history: a query is up to 6 words, every word must appear (case-insensitive),
 * newest first. A result shows about two lines of the post around the first match, as PARTS
 * the page renders — plain text and hits — so the matched words are bold and no marker
 * character ever reaches the screen. Pure; no I/O.
 */

export interface SnipPart {
  t: string;
  hit?: true;
}

export const MAX_TERMS = 6;
const CONTEXT = 90; // characters each side of the first hit: about two lines in a result row

/** The query's words: lowercased, unique, at most MAX_TERMS. Empty = nothing to search. */
export function terms(q: string): string[] {
  const out: string[] = [];
  for (const w of String(q ?? '').toLowerCase().split(/\s+/)) {
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

export function matchesAll(text: string, ts: readonly string[]): boolean {
  const low = text.toLowerCase();
  return ts.length > 0 && ts.every((t) => low.includes(t));
}

/** About two lines around the first hit; every word of the query in that window is a hit part. */
export function snippet(raw: string, ts: readonly string[], ctx = CONTEXT): SnipPart[] {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const low = text.toLowerCase();
  let first = -1;
  for (const t of ts) {
    const i = low.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  if (first < 0) {
    return [{ t: text.length > ctx * 2 ? text.slice(0, ctx * 2).trimEnd() + ' …' : text }];
  }
  let a = Math.max(0, first - ctx);
  let b = Math.min(text.length, first + ctx);
  if (a > 0) {
    const sp = text.indexOf(' ', a);
    if (sp >= 0 && sp < first) a = sp + 1;
  }
  if (b < text.length) {
    const sp = text.lastIndexOf(' ', b);
    if (sp > first) b = sp;
  }
  const win = text.slice(a, b);
  const wlow = win.toLowerCase();
  /* mark every occurrence of every word inside the window, merged left to right */
  const marks: Array<[number, number]> = [];
  for (const t of ts) {
    for (let i = wlow.indexOf(t); i >= 0; i = wlow.indexOf(t, i + t.length)) marks.push([i, i + t.length]);
  }
  marks.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  const parts: SnipPart[] = [];
  if (a > 0) parts.push({ t: '… ' });
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) parts.push({ t: win.slice(at, s) });
    parts.push({ t: win.slice(s, e), hit: true });
    at = e;
  }
  if (at < win.length) parts.push({ t: win.slice(at) });
  if (b < text.length) parts.push({ t: ' …' });
  return parts;
}

/** A LIKE pattern for one word, with the LIKE wildcards escaped (escape char = backslash). */
export function likePattern(t: string): string {
  const ESC = String.fromCharCode(92);
  return '%' + t.split(ESC).join(ESC + ESC).split('%').join(ESC + '%').split('_').join(ESC + '_') + '%';
}
export const LIKE_ESCAPE = String.fromCharCode(92);
