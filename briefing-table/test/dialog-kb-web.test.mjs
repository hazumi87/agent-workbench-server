// [dialog kb] source slices: dialogs stay above the soft keyboard.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const css = rd('room.css');
const mod = rd('dialog-keyboard.mjs');
const room = rd('room.js');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
const blk = css.slice(css.indexOf('DIALOGS ABOVE THE SOFT KEYBOARD'));
for (const c of ['rsm-dscrim', 'apc-scrim', 'nt-scrim', 'ad-scrim', 'dv-scrim']) {
  ok(new RegExp(`html\\.kb-up \\.${c}`).test(blk), `kb-up: the .${c} scrim becomes the visible area`);
}
ok(/inset: auto; left: 0; right: 0; top: var\(--vv-top, 0px\); height: var\(--vvh, 100%\);/.test(blk), 'the scrim = [--vv-top, --vv-top + --vvh]');
ok(/max-height: calc\(var\(--vvh, 100svh\) - 24px\); overflow-y: auto;/.test(blk), 'the card is capped to the visible area and scrolls inside');
ok(/html\.kb-up \.rsm-card \.ft, html\.kb-up \.apc-card \.ft \{ position: sticky; bottom: 0;/.test(blk), 'the buttons stay in reach (sticky footer)');
ok(/html\.kb-up \.rbf\.is-sheet \{ bottom: calc\(100% - var\(--vv-top, 0px\) - var\(--vvh, 100%\)\);/.test(blk), "the brief's bottom sheet docks to the visible bottom");
ok(/addEventListener\('focusin'/.test(mod) && /scrollIntoView\(\{ block: 'nearest'/.test(mod) && /\['room-kb', 'soft-kb'\]/.test(mod), 'a focused dialog field is scrolled into view on focus and as the keyboard changes');
ok(/import \{ mountDialogKeyboard \} from '\/dialog-keyboard\.mjs'/.test(room) && /mountDialogKeyboard\(\);/.test(room), 'the room page mounts it');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
