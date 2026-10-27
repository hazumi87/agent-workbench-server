/**
 * CREATE A WORKGROUP, the page half (Owner 2026-10-04, item 3-5):
 * the Create enable rule (web/room-add-workgroup.mjs workgroupNeed), the sheet's
 * three tabs, the entry points and the seat menu's Move to workgroup, read from
 * the SHIPPED sources (no browser: the screenshots are the harness's job).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (f) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
const { workgroupNeed, SWATCHES } = await import('../web/room-add-workgroup.mjs');
let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); } };

const free = (v) => ({ value: v, free: true });
const base = () => ({
  name: 'Ops', alias: 'ops', aliasCheck: free('ops'), handleChecks: new Map([['new-one', { free: true }]]),
  lead: 'm:1', picks: [{ key: 'm:1', locked: true, handle: 'dev' }, { key: 's:r', locked: false, handle: 'new-one' }],
});
console.log('\n[the enable rule]');
ok(workgroupNeed(base()) === '', 'name, free alias, agents, a lead, no clash: Create is on');
ok(workgroupNeed({ ...base(), name: ' ' }) === 'name it', 'no name: off');
ok(workgroupNeed({ ...base(), alias: '' }) !== '', 'no alias: off');
ok(/taken/.test(workgroupNeed({ ...base(), aliasCheck: { value: 'ops', free: false } })), 'a taken alias: off');
ok(workgroupNeed({ ...base(), aliasCheck: free('other') }) !== '', 'an alias not yet checked: off');
ok(workgroupNeed({ ...base(), alias: 'Bad Alias' }) !== '', 'a malformed alias: off');
ok(workgroupNeed({ ...base(), picks: [] }) === 'pick an agent', 'no agent: off');
ok(workgroupNeed({ ...base(), lead: null }) === 'pick a lead', 'no lead: off');
ok(workgroupNeed({ ...base(), lead: 'm:9' }) === 'pick a lead', 'a lead that is not picked: off');
ok(/already used/.test(workgroupNeed({ ...base(), handleChecks: new Map([['new-one', { free: false }]]) })), 'a handle that clashes in the family: off');
ok(/twice/.test(workgroupNeed({ ...base(), picks: [{ key: 'm:1', locked: true, handle: 'dev' }, { key: 's:r', locked: false, handle: 'dev' }] })), 'two agents with one handle: off');
ok(/alias/.test(workgroupNeed({ ...base(), picks: [{ key: 'm:1', locked: true, handle: 'ops' }] })), 'a handle equal to the alias: off');
ok(workgroupNeed({ ...base(), handleChecks: new Map() }) !== '', 'a new handle not yet checked: off');
ok(SWATCHES.length === 8, 'the 8 room swatches');

console.log('\n[the sheet and its entry points]');
const sheet = read('room-add-sheet.mjs');
ok(sheet.includes("['workgroups', 'Workgroups', wgTab.count()]") && sheet.indexOf("['agents', 'Agents'") < sheet.indexOf("'Workgroups'") && sheet.indexOf("'Workgroups'") < sheet.indexOf("['apps', 'Apps'"), 'tabs read Agents, Workgroups, Apps');
ok(sheet.includes('!!fixed && !fixed.parent_id'), 'the Workgroups tab exists only in a main room');
const js = read('room.js');
ok(js.includes("addMembers('room', 'workgroups')") && js.includes("{ a: 'wg', label: 'Add new workgroup'"), "the room row's ... offers Add new workgroup");
ok(js.includes('state.room.parent_id ? []') && js.includes('onWorkgroup'), 'main room only; a create lands back in the room');
const wg = read('room-add-workgroup.mjs');
ok(wg.includes('/workgroups`') && wg.includes('family-check'), 'one create call and the live check');
ok(wg.includes('readOnly = true'), 'a moved agent\'s handle is locked in');
const seatMenu = read('room-seat-menu.mjs');
ok(seatMenu.includes("label: 'Move to workgroup") && seatMenu.includes('/move`') && seatMenu.includes('Not moved'), 'the seat menu moves a seat and shows a refusal inline');
const css = read('room-add-sheet.css');
ok(/@media \(max-width: 600px\)[\s\S]*\.rwg-sw \{ width: 44px; height: 44px; \}/.test(css), 'phone: swatches are 44px targets');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
