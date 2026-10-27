/**
 * PHONE NOTE EDITOR: FULL PAGE AND BACK (Owner 2026-10-02, room line [ref]).
 * The toggle lives in a closure of web/room-notes.mjs, so this reads the
 * SHIPPED source; the behavior (boxes, X not moving, caret kept) is measured in
 * test/room-notes.probe.mjs. Nothing listens, nothing spawns.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room-notes.mjs'), 'utf8').replace(/\r\n/g, '\n');
const m = src.slice(src.indexOf('const mount = () => {'), src.indexOf('if (phone) {\n      mount();'));

ok(/let full = startedFull;/.test(src) && /const startedFull = phone && from === 'assets'/.test(src), 'full is mutable; an Assets open starts full');
ok(/fs\.hidden = !phone \|\| startedFull/.test(src), 'the toggle shows on a phone opened from the chat only');
ok(/head\.append\(left, fs, clip, x\)/.test(src), 'the toggle sits left of the clip and X (X keeps its place)');
ok(/classList\.toggle\('nt-full', full\)/.test(m) && /classList\.toggle\('nt-chat', !full\)/.test(m), 'mount swaps nt-full / nt-chat');
ok(/h\.toggle\('nt-open', full\)/.test(m) && /h\.toggle\('nt-chat-open', !full\)/.test(m), 'mount sets exactly one of the two html classes');
ok(/\(full \? document\.body : o\.chatHost\(\)\)\.append\(card\)/.test(m), 'full re-parents to body, chat to chatHost');
ok(/setSelectionRange\(keep\.a, keep\.b, keep\.d\)/.test(m) && /ta\.scrollTop = keep\.t/.test(m), 'caret and scroll are put back after the move');
ok(!/\.focus\(\)/.test(m), 'mount never focuses');
ok(/'Back to message box'/.test(m) && /'Full page'/.test(m), 'labels: "Full page" / "Back to message box"');
ok(/if \(full\) \{\n\s+card\.style\.top/.test(src) || /card\.style\.top = `\$\{vv\?\.offsetTop/.test(src), 'size() reads the live full flag');
ok(/classList\.remove\('nt-open', 'nt-chat-open'\)/.test(src), 'teardown clears both html classes');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
