/**
 * THE SCRATCHPAD HEADER NEVER SHOWS A NUMBER THE LIST CANNOT BACK (client [ref], the design system wording): the engine lists a WINDOW of notes (pinned + last 24 h,
 * topped up to 10) and counts ALL unarchived ones, so "Notes · 18" sat above ten cards with no way to the other eight. Until the paginated index (row 10) lands,
 * wherever fewer notes are shown than counted the header says "Showing 10 of 18 notes" (singular only for a total of 1). Pure: titleOf takes the shown count.
 */
import { titleOf } from '../web/scratchpad-title.mjs';

let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };

ok(titleOf('notes', 0, 18, 10) === 'Notes · Showing 10 of 18 notes', 'fewer shown than counted: "Showing 10 of 18 notes" (the reported case)');
ok(titleOf('notes', 3, 18, 10) === 'Notes · 3 new · Showing 10 of 18 notes', 'with new notes: the new count stays, then the truth about the list');
ok(titleOf('notes', 0, 1, 0) === 'Notes · Showing 0 of 1 note', 'singular only for a total of 1');
ok(titleOf('notes', 0, 18, 18) === 'Notes · 18', 'equal counts: unchanged');
ok(titleOf('notes', 2, 18, 18) === 'Notes · 2 new of 18', 'equal counts with new ones: unchanged');
ok(titleOf('notes', 0, 5) === 'Notes · 5', 'no shown count given (older callers): unchanged');
ok(titleOf('notes', 0, 10, 12) === 'Notes · 10', 'a shown count above the total is not a window: unchanged');
ok(titleOf('assets', 0, 43, 20) === 'Assets · 43', 'assets are never windowed: unchanged whatever is passed');
ok(titleOf('assets', 3, 43) === 'Assets · 3 new of 43', 'assets with new ones: unchanged');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
