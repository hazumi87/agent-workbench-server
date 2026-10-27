/** DISSOLVE A WORKGROUP, page half (Owner [ref]): a source test, no browser. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (f) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m} (got ${JSON.stringify(a)})`);

const { dissolveSummary } = await import('../web/room-dissolve-room.mjs');
eq(dissolveSummary([{ id: '1', handle: 'a' }, { id: '2', handle: 'b' }, { id: '3', handle: 'c' }], '3', 'Studio'),
  "@a, @b and @c (lead) return to Studio. The group's history is kept. Nothing is deleted.", 'the confirm sentence lists the seats and marks the lead');
eq(dissolveSummary([{ id: '1', handle: 'a' }], null, 'Studio'), "@a returns to Studio. The group's history is kept. Nothing is deleted.", 'one seat reads singular');

const dlg = read('room-dissolve-room.mjs');
ok(/'rsm-card kb-capped'/.test(dlg), 'the card opts in to the keyboard cap');
ok(/role', 'alertdialog'/.test(dlg) && /'Cancel'/.test(dlg) && /'Dissolve'/.test(dlg), 'an alertdialog with Cancel and Dissolve');
ok(/\/dissolve`, \{ method: 'POST'/.test(dlg), 'POSTs /api/rooms/:id/dissolve');
ok(/yes\.disabled = true/.test(dlg), 'Dissolve stays off until the seats are read');

const rj = read('room.js');
ok(/import \{ openDissolveRoom \}/.test(rj), 'room.js imports the dialog');
const wgRow = rj.slice(rj.indexOf("const li = navRow(list, w, 'sub'"), rj.indexOf("list.closest('.rm-seats')"));
ok(/a: 'dis', label: 'Dissolve group/.test(wgRow), "the workgroup row's menu has 'Dissolve group…'");
const mainRows = rj.slice(rj.indexOf("rowMore(head, state.family.parent"), rj.indexOf("rowMore(head, state.family.parent") + 120);
ok(!/dis/.test(mainRows) && !/a: 'dis'/.test(rj.slice(rj.indexOf('function renderRoomRow'), rj.indexOf('const roomMenu'))), 'the main room rows have no Dissolve item');
ok(/it\.a === 'dis'/.test(rj) && /openDissolveRoom\(/.test(rj), 'choosing it opens the dialog');
ok(/menuToast\(`\$\{name\} dissolved/.test(rj), 'the result shows a toast');
ok(/DISSOLVE_PENDING = 'hwb\.room\.dissolve\.pending'/.test(rj) && /defer: r\.id === roomId && parentId/.test(rj), 'confirmed inside the group: a pending key + navigation to the root');
const run = rj.slice(rj.indexOf('async function runPendingDissolve'), rj.indexOf('async function boot()'));
ok(run.indexOf('removeItem(DISSOLVE_PENDING)') > -1 && run.indexOf('removeItem(DISSOLVE_PENDING)') < run.indexOf('/dissolve`'), 'the key is removed BEFORE the call (consume-once)');
ok(/60_000/.test(run) && /p\.rootId !== roomId/.test(run), 'it expires at 60 s and only runs on the named root');
ok(/kind: 'error'/.test(run), 'a refusal is an error toast');
ok(/c\.defer/.test(dlg), 'the dialog hands over to defer() instead of posting');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
