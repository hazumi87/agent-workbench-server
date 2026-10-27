// [ipad kb] source slices: the soft-keyboard handling no longer depends on the 600px phone block.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const css = rd('room.css');
const att = rd('room-attach.css');
const room = rd('room.js');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
const top = css.slice(0, css.indexOf('/* ---- ROOM ON PHONE v1'));
ok(/html\.kb-up body \{ height: var\(--vvh, 100%\); position: relative; top: var\(--vv-top, 0px\); \}/.test(top), 'html.kb-up: the page shrinks to --vvh at ANY width');
ok(/html\.kb-up \.rm-inputwrap textarea \{ max-height: var\(--ta-max, 30vh\); \}/.test(top), "the box's cap is what the keyboard leaves, at any width");
ok(/if \(!root\.classList\.contains\('kb-up'\)\) \{\s*if \(root\.style\.getPropertyValue\('--ta-max'\)\)/.test(room), 'capComposer runs on any kb-up (no isPhone() gate)');
const before = att.slice(0, att.indexOf('KEYBOARD UP at ANY width'));
const after = att.slice(att.indexOf('KEYBOARD UP at ANY width'));
ok(/html\.kb-up \.att-tile \{ height: 40px; \}/.test(after) && /html\.kb-up \.rm-tray \.att-tile\.is-note \{ --u:2px; \}/.test(after), 'the 40px tray under kb-up is outside the phone media block');
ok(!/html\.kb-up/.test(before.slice(before.indexOf('@media (max-width: 600px)'))), '...and none of it is left inside it');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
