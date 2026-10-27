/* WHAT THE RESTORE BANNER MAY OFFER, and how the live list is ordered.
 *
 * Pulled out of manager.js as pure functions for one reason: these are RULES,
 * and a rule nobody can run is a rule that drifts. They are unit-tested under
 * node (test/restore-offer.test.mjs, in `npm test`) instead of only through a
 * live probe.
 *
 * THE DEFECT THIS ENCODES (Owner, 2026-09-17): the banner offered a pile of
 * day-old dead sessions while the sessions he had actually lost from view were
 * still live and were never offered at all. Half of that is fixed engine-side
 * (one stamp batch per boot, dated — store.reconcileStaleLive); the other half
 * is here.
 */

/** A stamp older than this is history, not an offer. Nothing is deleted: those
 *  rows stay in Recently-closed, where Resume still works. The banner is a
 *  "did you just lose something?" prompt, and after a day the answer is no. */
export const INTERRUPTED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The projects the banner may offer to restore.
 *
 * Four rules, each one a thing that was wrong:
 *
 *  1. DEHYDRATED ONLY. A `killed` row is a non-resumable session (a bare shell,
 *     whose process died with its engine) — there is no conversation to bring
 *     back, so "restore" would silently mean "launch a fresh one". Offering it
 *     is what made the banner read as a list of dead things.
 *  2. THE LATEST BATCH ONLY. Every row swept by one boot shares one
 *     `interrupted_at`, so the newest value IS the last interruption. Older
 *     stamps cannot legitimately exist any more (the sweep clears them) but a
 *     db written by an older engine can still hold some.
 *  3. DATED, OR NOT OFFERED. A stamp with no `interrupted_at` came from an
 *     engine that did not date them, so its age is unknowable — and unknowable
 *     age is exactly the pile this fix exists to stop. Declining them is also
 *     what heals an already-accumulated table on the first run.
 *  4. WITHIN 24 H.
 *
 * Returns the recipes, newest session first, each with the row that justified
 * it — the caller needs both (the name from one, the age from the other).
 */
export function pickInterrupted(recipes, rowFor, now = Date.now()) {
  const cand = [];
  for (const r of recipes || []) {
    const row = rowFor(r);
    if (!row) { continue; }
    if (row.interrupted !== 1) { continue; }
    if (row.state !== 'dehydrated') { continue; }
    const at = typeof row.interrupted_at === 'number' ? row.interrupted_at : null;
    if (at === null) { continue; }
    if (now - at > INTERRUPTED_MAX_AGE_MS) { continue; }
    cand.push({ recipe: r, row, at });
  }
  if (cand.length === 0) { return []; }
  const newest = Math.max(...cand.map((c) => c.at));
  return cand
    .filter((c) => c.at === newest)
    /* Within one batch every stamp is the same instant, so the tiebreak is the
       session's own clock: the one you were last in, first. */
    .sort((a, b) => (b.row.updated_at || 0) - (a.row.updated_at || 0));
}

/**
 * IS ANYTHING SHOWING THIS SESSION?
 *
 * `attached` is the engine's "some window/viewer socket is bound to this pane".
 * A live session with none is running perfectly well with nothing on screen —
 * which is precisely the state Owner's platform and harbor sessions were in
 * after the shell reload ate their tabs, and precisely the state the list did
 * not say out loud: the text was computed and then put in the TOOLTIP only, so
 * the sole visible signal was the ring's hollow centre.
 */
export function windowState(row) {
  if (!row || row.state !== 'live') { return null; }
  if (!row.attached) { return 'nowindow'; }
  return row.controller ? 'driven' : 'open';
}

/** The short visible badge. Only the unattached case gets one: a chip on every
 *  row is a chip nobody reads, and it is the absence of a window that is news. */
export function windowBadge(row) {
  return windowState(row) === 'nowindow' ? 'no window' : null;
}

/**
 * STILL BLOCKED ON YOU, even after the alarm was seen [ticket].
 *
 * `blocked` (from /api/table) says the screen shows a prompt only a human
 * answers — login, permission, question. Seeing the pane silences the ALARM
 * (the ring leaves `waiting` for the still `waiting-seen`, window-chrome v33),
 * but the prompt is still there, and before this chip the row read as a plain
 * idle session: an unanswered questionnaire looked exactly like a finished
 * one. Quiet on purpose — the ring owns the loud register; this is the fact
 * (and the reason) that survives it. Same words the room uses.
 */
export function needsYouBadge(row) {
  const b = row && row.state === 'live' ? row.blocked : null;
  return b && typeof b.reason === 'string' && b.reason ? `needs you: ${b.reason}` : null;
}

/** The long form, for the tooltip. Unchanged wording for the attached cases —
 *  the machine name is the thing that matters there. */
export function windowLabel(row) {
  const st = windowState(row);
  if (st === 'nowindow') { return 'live · not in any window'; }
  if (st === 'driven') { return `active · ${row.controller}`; }
  if (st === 'open') { return 'open · no one driving'; }
  return 'live';
}

/**
 * UNATTACHED LIVE ROWS FLOAT.
 *
 * A running session with no window is the only row in this list you may have
 * forgotten about — everything else is already on somebody's screen. Sorting it
 * to the top is what would have put platform and harbor in front of Owner
 * instead of leaving him to notice a hollow ring.
 *
 * STABLE within each group: the caller's order (the table's own updated_at
 * DESC) is preserved, so rows do not shuffle between polls. Array.prototype.sort
 * is stable per spec, and the comparator returns 0 for same-group pairs.
 */
export function sortLive(rows) {
  const rank = (s) => (windowState(s) === 'nowindow' ? 0 : 1);
  return (rows || []).slice().sort((a, b) => rank(a) - rank(b));
}
