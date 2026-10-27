// Tasks (first-party, class tool, role tasks): the pure core. The engine's Tasks routes (KB
// design-notes-id §5 summary, §6 timeline) → the rail card descriptor the host draws
// (the design notes S1) and the by-% list order. No DOM, no network, no clock: index.js feeds it.

import { seatGroups, quietCount } from './seats.js';

/** The host's descriptor limits (S1). The host validates again; these keep us inside them. */
export const LIMITS = Object.freeze({ title: 40, line: 80, maxSpans: 48, maxSeats: 8 });

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// The engine sends epoch milliseconds (an open interval has end: null, meaning "until `to`"); ISO also accepted.
const ms = (v) => (typeof v === 'number' ? v : Date.parse(v));
const iso = (v) => new Date(ms(v)).toISOString();

/**
 * One lane of the timeline as fractions of the window: `{a, b, n}` with 0 <= a < b <= 1, and n the
 * number of seats working (1..maxSeats) or 'needs'. Clipped to the window, zero-length dropped, and
 * at most maxSpans, keeping the newest (a rail card shows "what is going on now").
 */
export function laneSpans(lane, from, to) {
  if (!lane) {
    return [];
  }
  const t0 = ms(from);
  const t1 = ms(to);
  const span = t1 - t0;
  if (!(span > 0)) {
    return [];
  }
  const frac = (v) => Math.min(1, Math.max(0, (ms(v) - t0) / span));
  const endOf = (v) => (v === null || v === undefined ? t1 : v);
  const out = [];
  for (const s of lane.segments || []) {
    const n = Math.min(LIMITS.maxSeats, Math.max(0, Math.floor(Number(s.working) || 0)));
    const a = frac(s.start);
    const b = frac(endOf(s.end));
    if (n >= 1 && a < b) {
      out.push({ a, b, n });
    }
  }
  for (const s of lane.needs || []) {
    const a = frac(s.start);
    const b = frac(endOf(s.end));
    if (a < b) {
      out.push({ a, b, n: 'needs' });
    }
  }
  out.sort((x, y) => x.a - y.a || x.b - y.b);
  return out.length > LIMITS.maxSpans ? out.slice(out.length - LIMITS.maxSpans) : out;
}

/**
 * The rail card for the room (group null) or one group, or null when there is nothing to show (the
 * engine has Tasks off, or the group is not in this family). The room card has no link glyph.
 */
export function cardDescriptor(summary, timeline, group, now = null) {
  if (!summary || !summary.room) {
    return null;
  }
  // "· 2 seats quiet" after the % (the design's Tasks §4): muted, display only; only when now is given (the clock is the caller's)
  const quiet = timeline && Number.isFinite(now) ? quietCount(seatGroups(timeline, { group: group ?? null, now }).quiet) : null;
  const withNote = (d) => (quiet ? { ...d, note: quiet } : d);
  const axis = timeline ? { from: iso(timeline.from), to: iso(timeline.to) } : null;
  if (group === null || group === undefined) {
    const r = summary.room;
    return withNote({
      title: clip('Tasks · Room', LIMITS.title),
      icon: 'task_alt',
      pct: r.pct ?? null,
      linked: null,
      spans: timeline ? laneSpans(timeline.room, timeline.from, timeline.to) : [],
      axis,
      line: clip(`${r.linkedGroups} of ${r.totalGroups} groups on the room plan · ${r.open} open`, LIMITS.line),
      badge: r.needsYou > 0 ? { count: r.needsYou, kind: 'needs' } : null,
    });
  }
  const g = (summary.groups || []).find((x) => x.alias === group);
  if (!g) {
    return null;
  }
  const lane = timeline ? (timeline.groups || []).find((x) => x.alias === group) : null;
  return withNote({
    title: clip(`Tasks · ${g.alias}`, LIMITS.title),
    icon: 'task_alt',
    pct: g.pct ?? null,
    linked: !!g.linked,
    spans: lane ? laneSpans(lane, timeline.from, timeline.to) : [],
    axis,
    line: clip(g.linked ? g.activity || `${g.open} open` : `on its own plan · ${g.activity || `${g.open} open`}`, LIMITS.line),
    badge: g.needsYou > 0 ? { count: g.needsYou, kind: 'needs' } : null,
  });
}

/** The by-% list: flagged ("needs you") first, then most done; a stable order for ties (by id). */
export function sortForList(tasks) {
  return tasks.slice().sort((x, y) => (y.flagged ? 1 : 0) - (x.flagged ? 1 : 0) || y.pct - x.pct || x.id - y.id);
}
