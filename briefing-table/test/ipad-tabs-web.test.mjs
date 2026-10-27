// [ipad tabs] source slices: a touch tablet's room / agent page hands itself to the shell's tab strip.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const gate = rd('ipad-shell-gate.mjs');
const room = rd('room.js');
const solo = rd('solo.js');
const manager = rd('manager.js');
const shell = rd('shell.html');
const kb = rd('soft-keyboard.mjs');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
ok(/import \{ isTouchWide, phoneSized, touchWanted \} from '\/touch-ui\.mjs'/.test(gate) && /return isTouchWide\(\) \|\| isDesktopBrowser\(\);/.test(gate), 'the gate is the same touch-wide test as the rest (coarse pointer or iPad desktop-class, wider than a phone)');
ok(/window\.parent !== window/.test(gate) && /get\('shell'\) === '0'/.test(gate), 'a framed page never redirects; ?shell=0 opts out');
ok(/location\.replace\(shellUrlFor\(location\.pathname, location\.search\)\)/.test(gate) && /\/shell\.html\?tabs=\$\{encodeURIComponent\(pathname \+ search\)\}/.test(gate) && /await new Promise\(\(\) => \{\}\)/.test(gate), 'it hands the page to /shell.html?tabs=<this page> and never settles, so the page does not start');
ok(/import \{ enteringShell \} from '\/ipad-shell-gate\.mjs';/.test(room) && /import \{ enteringShell \} from '\/ipad-shell-gate\.mjs';/.test(solo), 'room.js and solo.js import it first (a `from` import, so the asset versioning rewrites it)');
ok(room.indexOf("from '/ipad-shell-gate.mjs'") < room.indexOf("from '/transport.mjs'") && solo.indexOf("from '/ipad-shell-gate.mjs'") < solo.indexOf("from '/vendor/xterm/xterm.mjs'"), '...ahead of every other import');
ok(/html\.touch-wide \.hwb-caps, html\.no-host \.hwb-caps \{ display: none; \}/.test(shell), 'no window caption cluster in a plain browser on a tablet');
ok(/html\.kb-up body \{ height: var\(--vvh, 100%\)/.test(shell) && /trackSoftKeyboard\(\{ event: 'shell-kb' \}\)/.test(shell) && /postMessage\(\{ hwbKb: \{ up \} \}, location\.origin\)/.test(shell) && /stageEl\.addEventListener\('load', tellFrames, true\)/.test(shell), 'the shell tracks the keyboard once, shrinks, and tells every tab frame (and each as it loads)');
ok(/let fromParent = null;/.test(kb) && /ev\.source === window\.parent && ev\.origin === location\.origin/.test(kb) && /fromParent \? fromParent\.up : vv\.scale/.test(kb) && /fromParent \? window\.innerHeight : vv\.height/.test(kb), 'a framed page follows the shell\'s word; with no such message the measurement is unchanged');
ok(/import \{ enteringShell \} from '\/ipad-shell-gate\.mjs';/.test(manager) && manager.indexOf("from '/ipad-shell-gate.mjs'") < manager.indexOf("from '/logo-modal.mjs'"), 'manager.js has the same gate, first (it lands as the shell\'s hub tab)');
ok(/pathname === '\/manager\.html' \|\| pathname === '\/'\) \{\s*return '\/shell\.html';/.test(gate), 'the CLI Manager (manager.html AND the root) goes in with no ?tabs= (it is the hub tab; no duplicate)');
ok(/\|\| p === '\/'; \/\/ the engine serves the Manager at the root too/.test(shell), 'the shell recognises the root as the hub too');
/* Owner 2026-10-05: an iPhone (desktop mode / rotated) was treated as a tablet and wrapped in the shell */
const tui = readFileSync(new URL('../web/touch-ui.mjs', import.meta.url), 'utf8');
const shellSrc = readFileSync(new URL('../web/shell.html', import.meta.url), 'utf8');
ok(/Math\.min\(w, h\) < 700/.test(tui) && /\(forced \|\| !phoneSized\(\)\)/.test(tui), 'a phone-sized screen (shorter side < 700) is never a touch tablet, unless ?touch=1');
ok(/phoneSized\(\) && window\.matchMedia\?\.\('\(pointer: coarse\)'\)\?\.matches/.test(shellSrc) && /location\.replace\(first\)/.test(shellSrc), 'a phone that lands in the shell goes back to its page');
/* [desktop shell] a mouse desktop in a plain browser enters the shell too, with a persistent opt-out */
ok(/return isTouchWide\(\) \|\| isDesktopBrowser\(\);/.test(gate) && /hwb\.shell\.desktop/.test(gate) && /getItem\(DESKTOP_OPT_OUT_KEY\) === '0'/.test(gate), 'a desktop browser enters the shell; localStorage hwb.shell.desktop=0 opts out (try/catch guarded)');
ok(/touchWanted\(\) \|\| phoneSized\(\) \|\| !mm\('\(min-width: 601px\)'\)/.test(gate) && /display-mode: standalone/.test(gate) && /navigator\.webdriver === true/.test(gate), 'a finger, a phone screen, a phone-width window, a standalone app window and automation are not wrapped by default');
ok(/html\.no-host \.hwb-caps/.test(shell) && /!\(window\.chrome && window\.chrome\.webview\)/.test(shell), 'no caption cluster in any plain browser tab (no window host)');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
