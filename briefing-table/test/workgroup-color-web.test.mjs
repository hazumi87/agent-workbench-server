/**
 * THE WORKGROUP COLOR, the page half [workgroup design] Owner 2026-10-05: the create sheet
 * sends no color unless a swatch was pressed; a workgroup row's menu has Color... which
 * PATCHes that room's settings {color}; a workgroup's Room settings say what it inherits and
 * offer Reset to main room. Read from the SHIPPED sources (no browser).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (f) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); } };

const room = read('room.js');
const col = read('room-color-room.mjs');
const wg = read('room-add-workgroup.mjs');

console.log('\n[create sheet]');
ok(/color: null,/.test(wg), 'the sheet starts with no color chosen');
ok(/\.\.\.\(w\.color \? \{ color: w\.color \} : \{\}\)/.test(wg), 'the payload carries color only when a swatch was pressed');

console.log('\n[Color... menu]');
const fam = room.slice(room.indexOf('function renderFamilyTree'), room.indexOf('/** A push carries no person'));
ok(/\{ a: 'col', label: 'Color\\u2026', icon: 'col' \}/.test(fam), 'each workgroup row has Color... in its menu');
ok(!/rowMore\(head,[^\n]*'col'/.test(fam), 'the main room row does not (its color lives in Room settings)');
ok(/it\.a === 'col'[\s\S]*openRoomColor\(/.test(room), 'choosing it opens the picker');
ok(/\/settings`, \{ method: 'PATCH', json: \{ color: pick \} \}/.test(col), 'the picker PATCHes the room settings with {color}');
ok(/type = 'color'/.test(col) && /c\.swatches/.test(col), 'it offers the sample swatches plus Custom');
ok(/catch \(e\)[\s\S]*err\.textContent/.test(col), 'a failure is shown inline');

console.log('\n[inheritance in Room settings]');
ok(/state\.inherited = r\.body\.inherited \?\? \[\]/.test(room), 'the room read keeps `inherited`');
ok(/patch = \{ \.\.\.patch, pal: state\.room\.pal \}/.test(room), 'a mode flip on an inherited palette sends the palette too');
ok(/Reset to main room/.test(room) && /patch\[f\] = null/.test(room), 'Reset to main room PATCHes null for the field');
ok(/from \$\{main\}/.test(room), 'an inherited row says "from <main room>"');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
