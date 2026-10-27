/**
 * WHAT THE RESTORE BANNER MAY OFFER, and how the live list is ordered.
 *
 * The engine half of this (one dated stamp batch per boot) is asserted in
 * test/reconcile.test.ts. This is the manager half: given the rows the engine
 * serves, which ones are news. Every clause here is a thing that was wrong on
 * the morning of 2026-09-17 — a banner offering day-old dead sessions while the
 * sessions actually lost from view were live, listed and silent.
 */
import {
  needsYouBadge, pickInterrupted, sortLive, windowBadge, windowLabel, INTERRUPTED_MAX_AGE_MS,
} from '../web/restore-offer.mjs';

let passed = 0;
let failed = 0;
function eq(actual, expected, msg) {
  if (Object.is(actual, expected)) {
    passed += 1;
    console.log(`  ✓ ${msg} (${String(actual)})`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const recipe = (id, name) => ({ id, name: name || id });
const row = (o) => ({
  paneid: `recipe:${o.id}`, state: 'dehydrated', interrupted: 1,
  interrupted_at: NOW - 5 * MIN, updated_at: NOW - 5 * MIN, attached: false, controller: null, ...o,
});
/** The manager's own lookup, as a function of a fixture map. */
const lookup = (map) => (r) => map.get(`recipe:${r.id}`) || null;

function fixture(specs) {
  const recipes = specs.map((s) => recipe(s.id, s.name));
  const map = new Map(specs.map((s) => [`recipe:${s.id}`, row(s)]));
  return { recipes, rowFor: lookup(map) };
}

console.log('\n[the ordinary case: this boot swept two projects, and both are offered]');
{
  const f = fixture([
    { id: 'harbor', name: 'Harbor', interrupted_at: NOW - 3 * MIN, updated_at: NOW - 30 * MIN },
    { id: 'platform', name: 'Platform', interrupted_at: NOW - 3 * MIN, updated_at: NOW - 2 * MIN },
  ]);
  const hit = pickInterrupted(f.recipes, f.rowFor, NOW);
  eq(hit.length, 2, 'both');
  eq(hit[0].recipe.name, 'Platform', 'NEWEST FIRST — within one batch the tiebreak is the session\'s own clock');
  eq(hit[1].recipe.name, 'Harbor', '...then the older one');
  eq(hit[0].at, NOW - 3 * MIN, 'and the batch time rides along, so the banner can say when');
}

console.log('\n[THE LATEST BATCH ONLY — the stamps that piled up are not this morning\'s news]');
{
  const f = fixture([
    { id: 'today', name: 'Today', interrupted_at: NOW - 2 * MIN },
    { id: 'earlier', name: 'Earlier', interrupted_at: NOW - 3 * HOUR },
    { id: 'earlier2', name: 'Earlier2', interrupted_at: NOW - 6 * HOUR },
  ]);
  const hit = pickInterrupted(f.recipes, f.rowFor, NOW);
  eq(hit.length, 1, 'one batch, never a union of every boot that ever swept');
  eq(hit[0].recipe.name, 'Today', '...the latest');
}

console.log('\n[DATED, OR NOT OFFERED — an undateable stamp is exactly the pile this fixes]');
{
  const f = fixture([{ id: 'legacy', name: 'Legacy', interrupted_at: null }]);
  eq(pickInterrupted(f.recipes, f.rowFor, NOW).length, 0,
    'a stamp from an engine that did not date them has unknowable age, so it is declined');
}
{
  /* And it must not poison a real batch beside it — an undated row is skipped,
     not treated as a batch of its own that outranks or blocks the dated one. */
  const f = fixture([
    { id: 'legacy', name: 'Legacy', interrupted_at: null },
    { id: 'real', name: 'Real', interrupted_at: NOW - MIN },
  ]);
  const hit = pickInterrupted(f.recipes, f.rowFor, NOW);
  eq(hit.length, 1, 'the dated row is still offered');
  eq(hit[0].recipe.name, 'Real', '...and it is the right one');
}

console.log('\n[WITHIN 24 H — after a day the answer to "did you just lose something?" is no]');
{
  const f = fixture([{ id: 'old', interrupted_at: NOW - (INTERRUPTED_MAX_AGE_MS + MIN) }]);
  eq(pickInterrupted(f.recipes, f.rowFor, NOW).length, 0, 'a day-old batch is history, not an offer');
}
{
  const f = fixture([{ id: 'edge', interrupted_at: NOW - (INTERRUPTED_MAX_AGE_MS - MIN) }]);
  eq(pickInterrupted(f.recipes, f.rowFor, NOW).length, 1, 'just inside the day still counts');
}

console.log('\n[DEHYDRATED ONLY — a killed row has no conversation to bring back]');
{
  const f = fixture([
    { id: 'shell', name: 'Shell', state: 'killed' },
    { id: 'claude', name: 'Claude', state: 'dehydrated' },
  ]);
  const hit = pickInterrupted(f.recipes, f.rowFor, NOW);
  eq(hit.length, 1, 'only the restorable one');
  eq(hit[0].recipe.name, 'Claude', '...and "restore" means restore, not "launch a fresh one"');
}
{
  const f = fixture([{ id: 'back', state: 'live' }]);
  eq(pickInterrupted(f.recipes, f.rowFor, NOW).length, 0,
    'a session that came BACK on its own is not interrupted any more');
}
{
  const f = fixture([{ id: 'clean', interrupted: 0 }]);
  eq(pickInterrupted(f.recipes, f.rowFor, NOW).length, 0, 'an unstamped row is never offered');
}
{
  const recipes = [recipe('ghost')];
  eq(pickInterrupted(recipes, () => null, NOW).length, 0,
    'a project that has never run has no row, and no offer');
}
eq(pickInterrupted([], () => null, NOW).length, 0, 'no projects at all is not a crash');

console.log('\n[a LIVE session with no window: say it out loud, and float it]');
eq(windowBadge({ state: 'live', attached: false }), 'no window', 'the unattached live row gets a visible chip');
eq(windowBadge({ state: 'live', attached: true }), null, '...and nothing else does — a chip on every row is unread');
eq(windowBadge({ state: 'dehydrated', attached: false }), null, 'a dehydrated row is not "running with no window"');
eq(windowLabel({ state: 'live', attached: false }), 'live · not in any window',
  'the long form says LIVE first — the session is fine, you just cannot see it');
eq(windowLabel({ state: 'live', attached: true, controller: 'haz-001' }), 'active · haz-001',
  'WHICH machine has it, unchanged — that is the fact that matters when it is attached');
eq(windowLabel({ state: 'live', attached: true, controller: null }), 'open · no one driving', 'attached, nobody typing');

console.log('\n[STILL BLOCKED after the alarm was seen: the row says so [ticket]]');
{
  const q = { reason: 'question', since: NOW };
  eq(needsYouBadge({ state: 'live', attached: true, activity: 'idle', blocked: q }), 'needs you: question',
    'an acknowledged (idle) pane still blocked on a questionnaire keeps a chip');
  eq(needsYouBadge({ state: 'live', attached: false, blocked: { reason: 'login', since: NOW } }), 'needs you: login',
    'the reason is the room\'s word');
  eq(needsYouBadge({ state: 'live', attached: true, activity: 'idle' }), null, 'an unblocked row gets none');
  eq(needsYouBadge({ state: 'dehydrated', blocked: q }), null, 'a row that is not live is not waiting on anyone');
  eq(needsYouBadge({ state: 'live', blocked: { since: NOW } }), null, 'no reason, no chip (never "needs you: undefined")');
  eq(needsYouBadge(null), null, 'no row is not a crash');
}

console.log('\n[ordering: forgotten sessions rise, and nothing shuffles between polls]');
{
  const rows = [
    { paneid: 'a', state: 'live', attached: true, controller: 'vrpc' },
    { paneid: 'b', state: 'live', attached: false },
    { paneid: 'c', state: 'live', attached: true, controller: null },
    { paneid: 'd', state: 'live', attached: false },
  ];
  const sorted = sortLive(rows);
  eq(sorted.map((r) => r.paneid).join(''), 'bdac', 'unattached first, and STABLE inside each group');
  eq(rows.map((r) => r.paneid).join(''), 'abcd', '...without mutating the caller\'s array');
  const same = sortLive(sorted);
  eq(same.map((r) => r.paneid).join(''), 'bdac', 'sorting an already-sorted list is a no-op (no poll-to-poll churn)');
}
eq(sortLive([]).length, 0, 'an empty list sorts to an empty list');
eq(sortLive(null).length, 0, 'and null does not throw');

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
