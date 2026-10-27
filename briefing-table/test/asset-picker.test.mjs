/* ASSET PICKER, the room page's half [asset picker, Owner 2026-10-05].
 *
 *   node test/asset-picker.test.mjs
 *
 * web/room-app-dialog.mjs is pure, so cleanPick and the single-use gate window
 * run AS SHIPPED. web/room-cells.mjs is a DOM module (it cannot be imported),
 * so its wiring is checked on the SOURCE: the verb is read only from the
 * action port, passes the dialog's gate, requires the declared capability,
 * and the window is consumed by an action and opened by a pick only.
 * No backslash typed here. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanPick, openPickWindow, takePickWindow, pickedMessage, PICK_WINDOW_MS } from '../web/room-app-dialog.mjs';

let passed = 0;
let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${msg}`);
  } else {
    failed += 1;
    console.log(` FAIL  ${msg}${detail !== undefined ? `  (${JSON.stringify(detail)})` : ''}`);
  }
};
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cells = readFileSync(join(root, 'web', 'room-cells.mjs'), 'utf8');
const slice = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  return a < 0 || b < 0 ? '' : src.slice(a, b);
};

console.log('\n[the request]');
let r = cleanPick({ panel: 'pick', kind: 'image', sources: ['room'], title: '  Pick   one ' });
ok(r.ok && r.kind === 'image' && r.sources.join() === 'room' && r.title === 'Pick one', 'room only, title folded', r);
r = cleanPick({ kind: 'image', sources: ['library', 'room'] });
ok(r.ok && r.sources.join() === 'room,library' && r.title === '', 'both: Room first, then Library; no title is fine', r);
r = cleanPick({ kind: 'image', sources: ['room', 'room'] });
ok(r.ok && r.sources.join() === 'room', 'a repeated source counts once', r);
for (const [d, why] of [
  [{ kind: 'audio', sources: ['room'] }, 'bad kind'],
  [{ sources: ['room'] }, 'bad kind'],
  [{ kind: 'image' }, 'bad sources'],
  [{ kind: 'image', sources: [] }, 'bad sources'],
  [{ kind: 'image', sources: ['web'] }, 'bad sources'],
  [{ kind: 'image', sources: 'room' }, 'bad sources'],
  [{ kind: 'image', sources: ['room', 'library', 'room'] }, 'bad sources'],
  [{ kind: 'image', sources: ['room'], title: 5 }, 'bad title'],
  [null, 'bad request'],
]) {
  const x = cleanPick(d);
  ok(!x.ok && x.error === why, `refused: ${JSON.stringify(d)} -> ${why}`, x);
}
ok(cleanPick({ kind: 'image', sources: ['room'], title: 'x'.repeat(200) }).title.length === 80, 'title cut at 80');

console.log('\n[the single-use gate window]');
ok(PICK_WINDOW_MS === 10000, 'the window is 10 s');
let w = new Map();
ok(takePickWindow(w, 'p1', 1000) === false, 'no pick yet: nothing passes');
openPickWindow(w, 'p1', 1000);
ok(takePickWindow(w, 'p1', 1000 + 9999) === true, 'a pick opens it: the next action passes, inside 10 s');
ok(takePickWindow(w, 'p1', 1000 + 9999) === false, 'and it is ONE action: the second does not');
openPickWindow(w, 'p1', 1000);
ok(takePickWindow(w, 'p1', 1000 + 10001) === false, 'after 10 s it has lapsed');
ok(w.size === 0, 'and a lapsed window is cleared');
openPickWindow(w, 'p1', 1000);
ok(takePickWindow(w, 'p2', 1001) === false, 'another panel gets nothing');
ok(takePickWindow(w, 'p1', 1002) === true, 'and the first panel still has its own (a look by p2 did not take it)');
w = new Map();
ok(pickedMessage(null).cancelled === true && pickedMessage(null).items === undefined, 'a cancel answers {host, cancelled:true}');
ok(JSON.stringify(pickedMessage([{ source: 'library', library_id: 'a' }])) === '{"host":"picked","items":[{"source":"library","library_id":"a"}]}', 'a pick answers {host:picked, items}');
ok(takePickWindow(w, 'p1', 1) === false, 'a cancel opened nothing (the page opens a window only for a non-empty pick)');

console.log('\n[the wiring in web/room-cells.mjs]');
const openPick = slice(cells, 'function openPick(', '/* ---- ACTION:');
ok(openPick.length > 200, 'openPick found');
ok(/askGate\(navigator\.userActivation\?\.isActive/.test(openPick), 'the click gate: userActivation + the rate + the app status (askGate)');
ok(/host_caps/.test(openPick) && /'not declared'/.test(openPick), 'the declared capability is required');
ok(/cleanPick\(d\)/.test(openPick), 'the request is validated');
ok(/if \(picker\)/.test(openPick), 'one picker at a time');
ok(/if \(items\?\.length\)\s*\{\s*openPickWindow\(/.test(openPick), 'the window opens only for a non-empty pick (a cancel opens nothing)');
ok((cells.match(/openPickWindow\(/g) ?? []).length === 1, 'and nowhere else (one call)');
ok((cells.match(/takePickWindow\(/g) ?? []).length === 1, 'taken in one place (the action)');
const action = slice(cells, 'async function action(', '/* ---- COMPOSE');
ok(/const afterPick = takePickWindow\(pickWindows, c\.panel\.id/.test(action), 'an action consumes the window of ITS OWN panel');
ok(/isActive !== true && !afterPick/.test(action), 'the window only stands in for the click');
ok(/actionBusy\.has\(frame\) \|\| now - \(actionAt\.get\(frame\)/.test(action), 'the rate limit is still enforced after it');
ok(/ACTION_NAME\.test\(d\.name\)/.test(action) && action.indexOf('ACTION_NAME') < action.indexOf('takePickWindow'), 'a malformed ask never reaches (or burns) the window');
const handPort = slice(cells, 'function handPort(', 'async function action(');
ok(/d\.panel === 'pick'\)\s*\{\s*openPick\(v, d, port\)/.test(handPort), 'the verb is read from the action PORT');
ok(/d\.panel === 'pick'/.test(cells.slice(cells.indexOf("send dialogs on the action port"), cells.indexOf("send dialogs on the action port") + 300)), 'over window.postMessage a pick is refused (an agent cannot reach it)');
ok(!/pick/.test(slice(cells, "d.panel === 'compose'", "d.panel === 'action'")), 'no other door opens it');
ok(/openAssetPicker\(/.test(openPick) && (cells.match(/openAssetPicker\(/g) ?? []).length === 1, 'the picker is opened from there only');

console.log('\n[the picker module and room.html]');
const picker = readFileSync(join(root, 'web', 'asset-picker.mjs'), 'utf8');
ok(!/\.focus\(/.test(picker.replace(/x\.focus\(\{ preventScroll: true \}\)|opener\.focus\(\{ preventScroll: true \}\)|stops\[[^\n]*focus\(\)/g, '')), 'it focuses only the cancel button, the opener and trap stops (never a field)');
ok(!/<input|<textarea|createElement\('input'|createElement\('textarea'/.test(picker), 'no text field at all');
ok(/IntersectionObserver/.test(picker) && /const PAGE = 9/.test(picker), '9 at a time on an IntersectionObserver');
ok(/\/api\/library\/images\?offset=/.test(picker) && /\/api\/library\/thumb\//.test(picker), 'the library goes through the engine proxy');
ok(/\/asset-picker\.css/.test(readFileSync(join(root, 'web', 'room.html'), 'utf8')), 'room.html links the stylesheet');
const css = readFileSync(join(root, 'web', 'asset-picker.css'), 'utf8');
ok(/@media \(max-width: 600px\)/.test(css) && /border-radius: 14px 14px 0 0/.test(css), 'a bottom sheet at <= 600px, the places sheet corners');
ok((css.match(/{/g) ?? []).length === (css.match(/}/g) ?? []).length, 'braces balance');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
