/* SPOT POSITION PAD [hub-v2 sec 1.I] (Owner 2026-10-05, the design system 3385f69), web half: source-slice
 * checks (no browser). The painted behavior is covered by the Playwright harness. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const rd = (f) => readFileSync(join(W, f), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };

const wash = rd('room-wash.mjs');
const css = rd('room-hub.css');
const set = rd('room-art-settings.mjs');
const rc = rd('room-character.mjs');

ok(/export function mountSpotPad/.test(wash) && /role="slider" tabindex="0" aria-label="Spot position"/.test(wash), 'a slider named "Spot position"');
ok(/Spot at \$\{Math\.round\(a\.x\)\}%/.test(wash), 'readout "Spot at X% . Y%"');
ok(/TOUCH_LIFT = 56/.test(wash) && /pointerType === 'touch' \? TOUCH_LIFT : 0/.test(wash), 'touch aims 56px above the finger');
ok(/classList\.add\('wsp-aim'\)/.test(wash) && /classList\.remove\('wsp-aim'\)/.test(wash) && /\.wsp-pad\.aiming i \{ display: none/.test(css), 'press switches the cursor and hides the ring');
ok(/clamp\(n, 0, 100\)/.test(wash), 'a position clamps to the square');
ok(/e\.shiftKey \? 5 : 1/.test(wash) && /ArrowUp/.test(wash) && /ArrowDown/.test(wash), 'arrow keys nudge 1% (Shift 5%)');
ok(/addEventListener\('dblclick', \(\) => \{\s*void commitAt\(null\)/.test(wash), 'double-click saves NULL (it does not store 25 75)');
ok(!/x: 25, y: 75\s*\}\s*\)/.test(wash.replace(/\{ x: 25, y: 75 \};\s*\n\s*\}/, '')), 'no reset to a literal 25 75');
ok(/pointerup/.test(wash) && /void commitAt\(\{ x: a\.x, y: a\.y \}\)/.test(wash), 'release saves');

/* WATERMARK HOLD: no stored position writes no --wm-at; the class path is untouched */
ok(/if \(at\) \{\s*p\.style\.setProperty\('--wm-at'[\s\S]*?\} else \{\s*p\.style\.removeProperty\('--wm-at'\)/.test(wash), 'applyWash: a stored/live position writes --wm-at inline, otherwise REMOVES it');
ok(/spotAt = a && Number\.isFinite/.test(wash) && /let spotAt = null/.test(wash), 'the default is null, not 25 75');
const writers = ['room-wash.mjs', 'room-character.mjs', 'room.js', 'room-art-settings.mjs', 'logo-modal.mjs', 'room-tile.mjs'].filter((f) => /setProperty\('--wm-at'/.test(rd(f)));
ok(writers.join() === 'room-wash.mjs', `room-wash.mjs is the only writer of --wm-at (${writers})`);
ok(/wm-at-\$\{wm\.washFrom\}/.test(rd('logo-modal.mjs')), 'the .wm-at-<washFrom> class path is unchanged');
ok(/setSpotAt\(room && room\.wash_at\)/.test(rc), 'paintRoomCharacter hands the room position over (null when absent)');
ok(/'art_tile', 'wash_at', 'bubble_glass', 'pal'/.test(rd('room.js')), 'saveSettings keeps wash_at from the reply');
ok(/--wm-at, 25% 75%/.test(css), 'the tiled wash still reads --wm-at');

/* the precision cursor is Asset Studio's, verbatim */
const src = '/srv/code/tools/asset-studio/app/view.mjs';
let theirs = null;
try { theirs = /cursor:url\("(data:image\/svg\+xml,[^"]*)"\) 16 16/.exec(readFileSync(src, 'utf8'))?.[1]; } catch { /* repo absent: skip the compare */ }
const mine = /html\.wsp-aim[^{]*\{ cursor: url\("([^"]*)"\) 16 16/.exec(css)?.[1];
ok(!!mine && /%3Ccircle cx='16' cy='16' r='5'/.test(mine) && /stroke-width='3'/.test(mine) && /stroke-width='1'/.test(mine), 'the cursor SVG: ring r5 at 16 16, white 3px under black 1px, hotspot 16 16');
ok(theirs === null || theirs === mine, 'byte-identical to asset-studio app/view.mjs (html.marking cursor; matched by content, not line number)');
ok(/asset-studio\/app\/view\.mjs L257/.test(css), 'the source path and line are cited');
ok(css.includes(`.wsp-x { position: fixed; z-index: 99; width: 32px; height: 32px; margin: -16px 0 0 -16px; pointer-events: none; background: url("${mine}")`), 'the touch crosshair is the same SVG');
ok(/\.wsp-pad \{[^}]*width: 128px; height: 128px/.test(css) && /\.wsp-pad i \{[^}]*width: 14px; height: 14px/.test(css), '128px square, 14px ring');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'room-hub.css still has no hex values');

/* placement: above Spot | Edge */
ok(set.indexOf('padHost') > 0 && set.search(/art\.append\(radio, pick1, padHost, padMsg, washLabel, washHost/) > 0, 'Room settings > Art: the pad sits above Spot | Edge');
ok(/o\.save\(\{ wash_at: a \}, padMsg\)/.test(set), 'the pad saves wash_at through the settings PATCH');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
