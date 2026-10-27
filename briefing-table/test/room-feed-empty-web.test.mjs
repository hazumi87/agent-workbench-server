// [feed empty] source slices: a feed that hides every loaded line fetches older pages (capped) and then says so.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const room = rd('room.js');
const html = rd('room.html');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
ok(/const FILL_PAGES = 5;/.test(room) && /while \(fillUsed < FILL_PAGES && !visibleLines\(\) && !state\.atStart && state\.minId !== null\)/.test(room), 'while nothing loaded is visible and the room has an older page, fetch older ones: at most 5');
ok(/async function loadNewest[\s\S]*?void ensureVisible\(\);[\s\S]*?\n\}/.test(room.slice(room.indexOf('async function loadNewest'), room.indexOf('async function loadOlder'))), 'after loadNewest');
const af = room.slice(room.indexOf('function applyFilters()'), room.indexOf('/** One kind on / off'));
ok(/paintFeedNote\(\);\s*void ensureVisible\(\);/.test(af), 'after any feed / filter change (applyFilters)');
ok(/function setWho\(who\) \{\s*fillUsed = 0;/.test(room) && /function toggleKind\(k\) \{[\s\S]*?\n  fillUsed = 0;/.test(room), 'the cap belongs to the feed: a user filter change resets it; the other triggers (load, poll) do not stack pages');
ok(/\? `No messages to you in the newest \$\{lines\}/.test(room) && /matches the filter\./.test(room), 'the note names the filter ("No messages to you in the newest N"), and any other filter');
ok(/id="feedNote"/.test(html) && /id="feedShowAll"/.test(html) && /\$\('feedShowAll'\)\.addEventListener\('click', \(\) => setFeed\(ALL_FEED\)\)/.test(room), '"Show all" is the way out; "load older" stays beside it');
ok(/if \(added && !\$\('feedNote'\)\.hidden\) \{\s*paintFeedNote\(\);/.test(room), 'a visible line arriving removes the note');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
