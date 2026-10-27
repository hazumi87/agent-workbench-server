// [ipad keys] source slices: the rail Keys block (touch tablet) and the solo frame's hwbKeys handler.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const room = rd('room.js');
const solo = rd('solo.js');
const keys = rd('keypad-keys.mjs');
const html = rd('room.html');
const css = rd('room.css');
const ui = rd('touch-ui.mjs');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
ok(html.indexOf('data-cell="seats"') < html.indexOf('id="twKeys"') && html.indexOf('id="twKeys"') < html.indexOf('id="panelCells"'), 'the Keys cell sits under Seats, above the panel cells');
ok(/^\.tw-keys \{ display: none; \}/m.test(css) && /html\.touch-wide \.tw-keys \{ display: block; \}/.test(css), 'shown only on html.touch-wide');
ok(/\.tw-keys-grid \{ display: grid; grid-template-columns: repeat\(3, minmax\(44px, 1fr\)\)/.test(css), 'the keys are a 3-column grid (a numeric keypad)');
ok(/min-width: 44px; height: 48px/.test(css.slice(css.indexOf('.tw-keys-grid button'), css.indexOf('.tw-keys-note'))), 'keys are at least 44px');
ok(['Escape', 'Up', 'Tab', 'Left', 'Down', 'Right', 'Backtick', 'Newline', 'Enter'].every((a, i) => new RegExp(`aria: '${a}[^']*'`).test(keys) && keys.indexOf(`aria: '${a}`) === [...keys.matchAll(/aria: '/g)].map((m) => m.index)[i]), 'numpad order: esc up tab / left down right / backtick newline enter');
ok(/import \{ touchInput \} from '\/soft-keyboard\.mjs'/.test(ui) && /return touchInput\(\);/.test(ui), 'touch-wide uses the iPad-aware touchInput()');
ok((keys.match(/seq: /g) ?? []).length === 9 && /'\\x1b\[A'/.test(keys) && !/paste|font/i.test(keys.replace(/\/\*[\s\S]*?\*\//g, '')), 'the keypad set (enter, tab, newline, backtick, esc, 4 arrows); no paste / text size');
const fn = room.slice(room.indexOf('function openSeatFrame'), room.indexOf('/** Select an entry'));
ok(/postMessage\(\{ hwbKeys: k\.seq \}, location\.origin\)/.test(fn) && /addEventListener\('pointerdown', \(ev\) => \{\s*ev\.preventDefault\(\)/.test(fn), 'a key posts {hwbKeys} to the open seat frame on pointerdown + preventDefault (the keyboard stays up)');
ok(/b\.disabled = !open/.test(fn) && /Select an agent's CLI/.test(fn), "disabled with \"Select an agent's CLI\" when no CLI is open");
ok(/renderRoster\(\);\s*paintTwKeys\(\);/.test(room) && /frames\.delete\(seatId\);\s*\}\s*paintTwKeys\(\);/.test(room), 'repainted on select and when a frame is dropped');
const h = solo.slice(solo.indexOf('isKeypadSeq(ev.data?.hwbKeys)'), solo.indexOf('els.relaunch.addEventListener'));
ok(/ev\.origin === location\.origin/.test(h) && /if \(controlling\) \{\s*transport\.send\(\{ type: 'input', paneid, data: ev\.data\.hwbKeys \}\)/.test(h) && /reraiseControlPrompt\(\)/.test(h), 'solo: only from its own parent, only the keypad set, only when controlling (a viewer gets the control prompt)');
ok(/arrow: 0,[^}]*'Up'/.test(keys) && /arrow: 270,[^}]*'Left'/.test(keys) && /arrow: 180,[^}]*'Down'/.test(keys) && /arrow: 90,[^}]*'Right'/.test(keys) && /rotate\(\$\{k\.arrow\}deg\)/.test(room) && /\.tw-keys-grid button svg \{ width: 18px; height: 18px;/.test(css), 'the four arrows are ONE svg arrow, rotated, 18px (Auriga)');
ok(/icon: 'newline'/.test(keys) && /icon: 'tick'/.test(keys) && /class="kp-nl"/.test(room) && /svg\.kp-nl \{ width: 26px; height: 20px; \}/.test(css), 'shift+return and the backtick are SVGs at arrow weight (Auriga: the font glyphs are too small)');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
