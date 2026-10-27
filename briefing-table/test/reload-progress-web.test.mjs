// [reload progress] source slices: the seat Reload card shows progress, never cancels, resolves itself.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const m = rd('room-seat-menu.mjs');
const room = rd('room.js');
const css = rd('room.css');
let passed = 0;
let failed = 0;
function ok(c, msg) {
  if (c) { passed++; console.log(`  + ${msg}`); } else { failed++; console.log(`  X ${msg}`); }
}
const card = m.slice(m.indexOf('const STILL_MS'), m.indexOf('return { decorate, statusFor, holding, openMenu };'));
ok(/hd\.append\('Reloading ', el\('code', '', `@\$\{seat\.handle\}`\), '\u2026'\)/.test(card) && /yes\.remove\(\)/.test(card), 'on press the card becomes "Reloading @handle…" and the Reload button goes');
ok(/el\('button', 'rsm-xclose'\)/.test(card) && /x\.addEventListener\('click', \(\) => close\(false\)\)/.test(card) && /no\.textContent = 'Close'/.test(card), 'an X and a Close are there; closing only hides the card (no request is cancelled)');
ok(/submitting = false;\s*let r;/.test(card), 'tap outside / Esc / Close are never blocked while the request runs (they used to wait for the answer)');
ok(/const STILL_MS = Number\(window\.HWB_RELOAD_STILL_MS\) \|\| 30_000;/.test(card) && /Still waiting: the seat may have reloaded already\. Check the room; you can close this\./.test(card), 'after ~30 s with nothing: "Still waiting: ... check the room", still closable');
ok(/startsWith\(`@\$\{seat\.handle\} re-added from project defaults`\)/.test(card) && /now\.occupant\.id !== oldOcc/.test(card), 'it resolves itself on the "re-added" fact or the seat taking a NEW occupant (a rollback keeps the old one)');
ok(/\/line\?limit=12/.test(card), 'the fact is read by the card itself (with push live the page does not poll lines)');
ok(/Reloaded @\$\{seat\.handle\}/.test(card) && /if \(settled\) \{[\s\S]*?menuToast\(`@\$\{seat\.handle\}: the reload reported a problem/.test(card), '"Reloaded @handle" toast; a late failing answer after a close still says so');
ok(/seats: \(\) => state\.seats,/.test(room), 'room.js hands the card the seat list');
ok(/\.rsm-xclose \{ position: absolute; top: 4px; right: 6px; width: 44px; height: 44px;/.test(css), 'the X is a 44px target');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
