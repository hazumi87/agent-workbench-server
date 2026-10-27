/**
 * Manager phone menu (Owner 2026-10-03, room line [ref] thread). Source slices, no
 * engine: createPlaces' noFullManager option, and manager-menu.mjs's item list.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => readFileSync(join(ROOT, 'web', f), 'utf8').replace(/\r\n/g, '\n');
let failed = 0;
let passed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); } }

// 1. createPlaces.fill: run its first lines with stubs, both option values.
const places = rd('room-places.mjs');
const i = places.indexOf('fill(body, section) {');
const j = places.indexOf('if (data.rooms === null)', i);
const head = places.slice(i + 'fill(body, section) {'.length, j);
function run(o) {
  const calls = [];
  new Function('o', 'fullManagerRow', 'data', 'Date', 'load', 'body', 'STALE_MS', `${head}`)(o, (b) => calls.push('full'), { at: Date.now() }, Date, () => {}, {}, 4000);
  return calls;
}
ok(run({}).length === 1, 'default: "Full Workbench" row is drawn');
ok(run({ noFullManager: false }).length === 1, 'noFullManager:false still draws it');
ok(run({ noFullManager: true }).length === 0, 'noFullManager:true omits it');

// 2. the menu's items and wiring.
const menu = rd('manager-menu.mjs');
const labels = [...menu.matchAll(/\{ label: '([^']+)'/g)].map((m) => m[1]);
ok(labels.join(',') === 'Settings,Account,Art', `items: ${labels.join(', ')}`);
ok(/href: '\/settings\.html'/.test(menu), 'Settings points at /settings.html');
ok(!/Reset (CLI Manager|Workbench)|Reload (CLI Manager|Workbench)|Assemble room/.test(menu.replace(/\/\*[\s\S]*?\*\//, '')), 'window-only items are not offered');
ok(/noFullManager: true/.test(menu), 'sheet uses the quick menu without its own manager row');
ok(/window\.parent !== window/.test(menu), 'embedded: no button');
ok(/Escape/.test(menu) && /scrim\.addEventListener\('click', close\)/.test(menu), 'scrim and Escape close');
ok(/\.catch\(\(e\) =>/.test(menu), 'open errors are caught and shown in the sheet');
ok(!/\.focus\(/.test(menu), 'nothing is focused');
const html = rd('manager.html');
ok(/places-sheet\.css/.test(html) && /id="mgrMenuBtn"/.test(html) && /id="phSheetBody"/.test(html), 'manager.html links the sheet css, button and sheet DOM');
ok(/import\('\/manager-menu\.mjs'\)/.test(rd('manager.js')), 'manager.js loads the menu');

console.log(`PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
