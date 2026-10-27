// [rename workgroup] Owner 2026-10-05: source slices for the Rename... menu items and the PATCH body.
import { readFileSync } from 'node:fs';

const room = readFileSync(new URL('../web/room.js', import.meta.url), 'utf8');
const dlg = readFileSync(new URL('../web/room-rename-room.mjs', import.meta.url), 'utf8');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}

const main = room.slice(room.indexOf("THE ROOM ROW'S ..."), room.indexOf('const roomMenu'));
ok(/a: 'ren', label: 'Rename/.test(main), 'the main room row offers Rename');
ok(/state\.room\.parent_id \? \[\] : \[\{ a: 'wg'/.test(main), 'Add new workgroup stays main-room only');
const tree = room.slice(room.indexOf('function renderFamilyTree'), room.indexOf('function keepUnread'));
ok((tree.match(/rowMore\(/g) ?? []).length === 2, 'the head row (in a workgroup) and every workgroup row get the menu');
ok(/method: 'PATCH', json: \{ name \}/.test(dlg) && !/json: \{[^}]*alias/.test(dlg), 'the dialog PATCHes the name only, never the alias');
ok(/stays the same/.test(dlg) && /Escape/.test(dlg) && /e\.key === 'Enter'/.test(dlg), 'alias shown read-only; Enter saves, Esc cancels');
ok(/if \(!c\.touch\) \{\s*input\.focus\(\)/.test(dlg), 'no programmatic focus on touch');
ok(/!roomMenu\.isOpen\(\) && !renameRoomOpen/.test(room) && /done: \(\) => fetchRoom\(\)/.test(room), 'rail redraw held while open; a save refreshes via fetchRoom');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
