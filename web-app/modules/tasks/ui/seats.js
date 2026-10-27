// Tasks by seat (the owner's go, the team 2026-10-26; the design's Tasks §4): the groups and seat rows of the By seat view and
// the "quiet" rule, from the engine's timeline answer only (per group: seats [{handle, lead, state, stretches [{taskId,
// title, start, end, kind}]}], marks; no server change). Pure: no DOM, no clock of its own (now is passed in).
//
// Quiet (the stall-watch half that fits a page; display only): a seat that is not working (no open work stretch), not
// waiting on you (no open "needs" stretch), not left (state gone), and whose last work stretch ended QUIET_AFTER_MS or
// more ago. A seat with no work in the window is not called quiet: the page cannot tell when it last worked. The alarm
// half (repeats, waking the lead, with no browser open) is a server job, not this.

export const QUIET_AFTER_MS = 3 * 60 * 1000; // the owner's stall-watch default: quiet after 3 minutes

const clean = (x) =>
  x && Number.isFinite(x.start) && (x.end === null || Number.isFinite(x.end))
    ? { taskId: x.taskId, title: typeof x.title === 'string' ? x.title : '', start: x.start, end: x.end, kind: x.kind === 'needs' ? 'needs' : 'work' }
    : null;

/** One seat's row: its stretches in time order, and working / waiting / left / quiet as the design's §4 table says. */
function seatRow(s, now, quietAfterMs) {
  const stretches = (Array.isArray(s.stretches) ? s.stretches : []).map(clean).filter(Boolean).sort((a, b) => a.start - b.start);
  const work = stretches.filter((x) => x.kind === 'work');
  const working = work.some((x) => x.end === null);
  const waiting = stretches.some((x) => x.kind === 'needs' && x.end === null);
  const left = s.state === 'gone';
  const lastEnd = work.length && !working ? Math.max(...work.map((x) => x.end)) : null;
  const quietMs = !working && !waiting && !left && lastEnd !== null && now - lastEnd >= quietAfterMs ? now - lastEnd : null;
  return { handle: s.handle, lead: s.lead === true, left, working, waiting, quietMs, quietFrom: quietMs !== null ? lastEnd : null, stretches, dropped: Number.isInteger(s.dropped) ? s.dropped : 0 };
}

/**
 * timeline: the engine's answer; group: an alias or null for the whole room (its linked groups; every group starts
 * linked, the room's own included); now: ms.
 * → { groups: [{alias, linked, marks, rows: [...]}], quiet: number of distinct quiet seats, working, waiting }
 * In each group the lead first, then by handle; a seat that left goes last.
 */
export function seatGroups(timeline, { group = null, now, quietAfterMs = QUIET_AFTER_MS } = {}) {
  const all = timeline && Array.isArray(timeline.groups) ? timeline.groups : [];
  const picked = group ? all.filter((g) => g && g.alias === group) : all.filter((g) => g && g.linked);
  const quiet = new Set();
  const groups = picked.map((g) => {
    const rows = (Array.isArray(g.seats) ? g.seats : [])
      .filter((s) => s && typeof s.handle === 'string' && s.handle)
      .map((s) => seatRow(s, now, quietAfterMs));
    rows.sort((a, b) => (a.left !== b.left ? (a.left ? 1 : -1) : a.lead !== b.lead ? (a.lead ? -1 : 1) : a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
    for (const r of rows) if (r.quietMs !== null) quiet.add(r.handle);
    return {
      alias: String(g.alias || ''),
      linked: g.linked === true,
      marks: (Array.isArray(g.marks) ? g.marks : []).filter(Number.isFinite),
      rows,
      working: rows.filter((r) => r.working).length,
      quiet: rows.filter((r) => r.quietMs !== null).length,
    };
  });
  return { groups, quiet: quiet.size };
}

/** The card's note and the header's words: "1 seat quiet", "3 seats quiet"; null when none. */
export function quietCount(n) {
  return n > 0 ? (n === 1 ? '1 seat quiet' : n + ' seats quiet') : null;
}

/** "quiet 6 min", "quiet 1 h 10 min": whole minutes (the design's words table). */
export function quietWords(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 60) return 'quiet ' + min + ' min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return 'quiet ' + h + ' h' + (m ? ' ' + m + ' min' : '');
}
