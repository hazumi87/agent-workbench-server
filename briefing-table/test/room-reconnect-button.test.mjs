/**
 * RECONNECT IS A BUTTON, NEVER A SIDE EFFECT OF OPENING (Owner 2026-10-02, room
 * line 3245): opening a disconnected room must not wake its agents; Reconnect
 * lives at the right of the Seats header, left of the "+", and shows only
 * while the engine offers `reconnect`. Reads the SHIPPED web source (room.js
 * needs a browser); nothing listens, nothing spawns.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (${JSON.stringify(detail)})`);
  }
}
const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const rd = (f) => readFileSync(join(web, f), 'utf8').replace(/\r\n/g, '\n');
const js = rd('room.js');
const html = rd('room.html');
const css = rd('room.css');

console.log('[load never reconnects]');
const a = js.indexOf("q.get('reconnect') === '1'");
const blk = js.slice(a, js.indexOf('\n  }\n', a));
ok(a > 0 && /q\.delete\('reconnect'\)/.test(blk) && /replaceState/.test(blk), 'a stale reconnect=1 is still stripped from the address');
ok(!/reconnectAgents\(\)/.test(blk), 'the load path does not call reconnectAgents');
const calls = [...js.matchAll(/void reconnectAgents\(\)/g)].length;
ok(calls === 2, 'reconnectAgents() is called only by the two buttons (column + phone sheet)', calls);

console.log('\n[the button]');
const sc = html.indexOf('data-cell="seats"'); // [rail split] the Room cell is first now: slice the SEATS cell's header
const hw = html.slice(html.indexOf('<div class="cell-hw">', sc), html.indexOf('<div class="cell-b">', sc));
const iRec = hw.indexOf('id="reconnectBtn"');
const iAdd = hw.indexOf('id="addBtn"');
ok(iRec > 0 && iAdd > iRec, 'Reconnect sits in the Seats header, immediately left of the "+"');
ok(/id="reconnectBtn"[^>]*\bhidden\b/.test(hw), 'hidden until the engine offers it');
ok(/title="Reconnect room"/.test(hw) && /aria-label="Reconnect room"/.test(hw), 'title and aria-label are "Reconnect room"');
ok(!/class="rm-cycle"/.test(html) && !/\.rm-cycle \{/.test(css), 'the old header button is gone');
const sa = js.slice(js.indexOf('function setActions('), js.indexOf('function showCycle('));
ok(/querySelectorAll\('\.cell-hrec'\)/.test(sa) && /rb\.hidden = !state\.actions\.includes\('reconnect'\)/.test(sa), 'setActions shows every Reconnect button only while the action is offered');
ok(/rb\.disabled = state\.cycling/.test(sa), '...and disables it while a cycle runs');
ok(/\$\('reconnectBtn'\)\.addEventListener\('click', \(\) => void reconnectAgents\(\)\)/.test(js), 'a click runs reconnectAgents');
ok(/\.cell-hadd \{[^}]*width: 28px; height: 28px/.test(css) && /\.cell-hadd \{ width: 44px; height: 44px/.test(css), 'same 28px desktop / 44px phone box as the "+"');

console.log('\n[phone Agents sheet]');
const ph = js.slice(js.indexOf("const rec = $('reconnectBtn').cloneNode(true)"), js.indexOf('h3.append(grp)'));
ok(ph.length > 0 && /grp\.append\(rec, add\)/.test(ph), 'the sheet h3 carries Reconnect immediately left of the "+"');
ok(/rec\.hidden = !state\.actions\.includes\('reconnect'\)/.test(ph) && /reconnectAgents\(\)/.test(ph), '...shown only with the action, and it runs reconnectAgents');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
