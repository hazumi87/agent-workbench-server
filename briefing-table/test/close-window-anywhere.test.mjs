/**
 * Close window from anywhere (Owner 2026-10-03, room line after [ref]). Unit
 * test over the SHIPPED web source (sliced, no browser, no engine):
 *   - the seat menu's Close window enable rule: live AND (windows, frames or
 *     this page's own frame);
 *   - solo.js hands pane.frame-closed up to the room page, room frames only;
 *   - room.js drops the signalling frame and selects the room chat when that
 *     seat was showing (and leaves the selection alone when it was not).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = (f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}`);
  }
}

console.log('\n[seat menu enable rule]');
const menu = web('room-seat-menu.mjs');
const line = menu.split('\n').find((l) => l.includes("a: 'closew'"));
const offExpr = line?.match(/off: (.*?), why:/)?.[1];
ok(!!offExpr, 'found the closew off expression');
const off = (live, occ, own) => new Function('live', 'seat', 'o', `return ${offExpr};`)(live, { id: 's1', occupant: occ }, { ownFrame: () => own });
ok(off(true, { windows: 0, frames: 0 }, false) === true, 'live, nothing showing it: disabled');
ok(off(true, { windows: 1, frames: 0 }, false) === false, 'a window enables it');
ok(off(true, { windows: 0, frames: 1 }, false) === false, 'another device\'s room frame enables it');
ok(off(true, { windows: 0, frames: 0 }, true) === false, 'this page\'s own frame enables it');
ok(off(false, { windows: 2, frames: 1 }, true) === true, 'not live: disabled whatever shows it');

console.log('\n[solo.js signal]');
const solo = web('solo.js');
const sa = solo.indexOf("transport.on('pane.frame-closed'");
const sb = solo.indexOf('});', sa);
const handler = solo.slice(sa, sb + 3);
const run = (msgPane, roomFrame) => {
  const posted = [];
  let cb;
  const transport = { on: (t, f) => { cb = f; } };
  new Function('transport', 'paneid', 'roomFrame', 'window', handler)(transport, 'p1', roomFrame, { parent: { postMessage: (m) => posted.push(m) } });
  cb({ paneid: msgPane });
  return posted;
};
ok(JSON.stringify(run('p1', true)) === JSON.stringify([{ hwbFrameClosed: 'p1' }]), 'a room frame posts hwbFrameClosed to its parent');
ok(run('p1', false).length === 0, 'a plain window posts nothing');
ok(run('other', true).length === 0, 'another pane\'s signal is ignored');

console.log('\n[room.js reaction]');
const room = web('room.js');
const ra = room.indexOf("window.addEventListener('message', (ev) => {\n  if (ev.origin !== location.origin || !ev.data || typeof ev.data.hwbFrameClosed");
const rb = room.indexOf('\n});', ra);
ok(ra > 0 && rb > ra, 'found the room.js handler');
const rbody = room.slice(ra, rb + 4);
function page(sel) {
  const src = {};
  const frames = new Map([['s1', { el: { contentWindow: src } }], ['s2', { el: { contentWindow: {} } }]]);
  const state = { sel };
  const dropped = [];
  const selected = [];
  let listener;
  const window = { addEventListener: (t, f) => { listener = f; } };
  new Function('window', 'location', 'frames', 'state', 'dropFrame', 'select', rbody)(window, { origin: 'o' }, frames, state, (id) => dropped.push(id), (id) => selected.push(id));
  listener({ origin: 'o', source: src, data: { hwbFrameClosed: 'p1' } });
  return { dropped, selected };
}
let r = page('s1');
ok(JSON.stringify(r) === JSON.stringify({ dropped: ['s1'], selected: ['room'] }), 'the showing seat: frame dropped, room chat selected');
r = page('s2');
ok(r.dropped[0] === 's1' && r.selected.length === 0, 'a background seat: frame dropped, selection untouched');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
