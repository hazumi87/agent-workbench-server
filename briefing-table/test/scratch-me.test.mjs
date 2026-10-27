/* "@me" on the person's own Scratchpad items [scratch real] (the design system 2026-10-08). node test/scratch-me.test.mjs */
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const v = rd('room-scratchpad-view.mjs');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  + ${m}`); } else { fail += 1; console.log(`  X ${m}`); } };
/* run the real asMe line against a few handles */
const m = /const asMe = \(h\) => \(([^;]+)\);/.exec(v);
ok(!!m, 'the view has one asMe rule');
const asMe = new Function('o', `return (h) => (${m[1]});`)({ me: () => 'owner' });
ok(asMe('user') === 'me' && asMe('owner') === 'me', 'the role name "user" and your own handle read "me"');
ok(asMe('zahkutya') === 'zahkutya' && asMe(null) === null, "someone else's handle stays theirs; no author stays none");
ok(v.includes('`@${asMe(n.author)}`') && (v.match(/`@\$\{asMe\(a\.addedBy\)\}`/g) ?? []).length === 2, 'notes, asset tiles and the opened asset all go through it (never a bare @user)');
ok(rd('room.js').includes('me: () => state.me?.handle ?? null,'), 'room.js tells the view who you are');
console.log(`PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
