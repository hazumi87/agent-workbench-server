/**
 * Standalone remote manager navigates THIS tab (Owner 2026-10-02, room line [ref]).
 * Slices the SHIPPED SAME_TAB / openStandalone / openRoom source and runs it for
 * the three modes: embedded (shell hub tab), remote standalone (phone/laptop),
 * local standalone (native window, loopback). No engine, no ports.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'web', 'manager.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  + ${msg}`); } else { failed++; console.log(`  X ${msg}`); }
}
function slice(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  if (i < 0 || j < 0) { throw new Error(`cannot slice ${start}`); }
  return src.slice(i, j);
}

const decide = slice('const SAME_TAB', '/* Ask the shell to mount');
const openRoomSrc = slice('function openRoom(', '/* ---- Assemble room');

function run(EMBEDDED, REMOTE) {
  const calls = [];
  const window = {
    location: { assign: (u) => calls.push(['assign', u]) },
    open: (u, t, f) => calls.push(['open', u, t, f]),
    parent: { postMessage: (m) => calls.push(['post', m]) },
  };
  const roomUrl = (id) => `/room.html?room=${encodeURIComponent(id)}`;
  new Function('EMBEDDED', 'REMOTE', 'window', 'roomUrl', `${decide}\n${openRoomSrc}\nopenRoom({id:'r1',name:'R'}, ['reconnect']);`)(EMBEDDED, REMOTE, window, roomUrl);
  return calls;
}

const remote = run(false, true);
ok(remote.length === 1 && remote[0][0] === 'assign' && remote[0][1] === '/room.html?room=r1', 'remote standalone: this tab navigates, no reconnect flag');
const local = run(false, false);
ok(local.length === 1 && local[0][0] === 'open' && local[0][3] === 'noopener', 'local standalone: still a new window');
const emb = run(true, true);
ok(emb.length === 1 && emb[0][0] === 'post' && emb[0][1].hwbOpenTab.url === '/room.html?room=r1', 'embedded: hwbOpenTab, no reconnect flag');
ok(!/'&reconnect=1'/.test(src), 'manager never appends reconnect=1');
const launch = slice('async launch(', 'return out;\n  },');
ok(/openStandalone\(out\.path\)/.test(launch) && !/window\.open/.test(launch), 'api.launch routes the remote path through openStandalone');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
