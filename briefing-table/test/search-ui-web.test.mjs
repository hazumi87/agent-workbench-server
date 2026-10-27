// [search ui] source slices: the shared search panel and where it is wired.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const ui = rd('search-ui.mjs');
const css = rd('search-ui.css');
const room = rd('room.js');
const chat = rd('agent-chat.mjs');
const html = rd('room.html');
const solo = rd('solo.html');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
ok(/DEBOUNCE_MS = 120/.test(ui) && /abort\?\.abort\(\)/.test(ui) && /if \(q\.length < 2\)/.test(ui), 'debounce 120 ms, a stale answer is aborted, a query under 2 letters is just the hint');
ok(/strong/.test(ui) && !/innerHTML/.test(ui.replace(/\/\*[\s\S]*?\*\//g, '')) && /p\.hit/.test(ui), 'the snippet PARTS are rendered with textContent and <strong>: nothing is parsed as HTML');
ok(/newest first\$\{res\.more \? ' · older history not searched' : ''\}/.test(ui) && /No matches for “\$\{q\}”/.test(ui) && /Try fewer or different words\./.test(ui), 'the count line, the `more` note, and the no-match words');
ok(/e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/.test(ui) && /e\.key === 'Enter'/.test(ui) && /e\.key === 'Escape'/.test(ui) && /document\.addEventListener\('pointerdown', away, true\)/.test(ui), 'Up/Down/Enter/Esc, and a click outside closes it on a PC');
ok(/if \(!touch\) \{\s*input\.focus\(\);/.test(ui), 'no programmatic focus on a touch screen');
ok(/\.sr-pop \{[^}]*max-height: min\(72vh, 660px\)/.test(css) && /\.sr-sheet \.sr-input \{ height: 42px; font-size: 16px; \}/.test(css) && /\.sr-sn strong \{ font-weight: 700;/.test(css) && /html\[data-mode=light\] \.sr-au\.has-ink/.test(css), 'popover size, the 42px/16px phone field, the bold hit, and the light-mode author ink');
ok(/id="searchBtn"/.test(html) && /id="phSearch"/.test(html) && /search-ui\.css/.test(html) && /search-ui\.css/.test(solo), 'the room has the magnifier (PC and phone) and loads the sheet; solo loads it for the chat');
ok(/\/api\/rooms\/\$\{encodeURIComponent\(roomId\)\}\/search\?q=\$\{encodeURIComponent\(q\)\}&limit=50/.test(room) && /ev\.key\.toLowerCase\(\) === 'f'/.test(room), 'the room search calls the engine route; Ctrl/Cmd+F opens it on a PC');
ok(/async function scrollToLine\(id, \{ pages = LINE_PAGES_MAX \} = \{\}\)/.test(room) && /onPick: \(res\) => void scrollToLine\(res\.key, \{ pages: 200 \}\)/.test(room) && /sc\.scrollTo\(\{/.test(room) && /lineUnpin\(\);/.test(room), 'a pick pages in as far as it takes, scrolls the chat\'s own scroller (not scrollIntoView), and un-pins first');
ok(/\/chat\/search\?q=\$\{encodeURIComponent\(qs\)\}&limit=50/.test(chat) && /async function jumpTo\(id\)/.test(chat) && /loadOlder\(200\)/.test(chat) && /pinned = false; \/\/ the jump is a place to read/.test(chat), 'the chat search calls its route; a pick loads older history until the message is there, then centres it and does not snap back');
const tf = rd('time-format.mjs');
ok(/export function lineTime\(ts\) \{\s*return new Date\(ts\)\.toLocaleTimeString\(\[\], \{ hour: '2-digit', minute: '2-digit' \}\);/.test(tf), 'ONE clock: the viewer\'s local time, as the room line has always drawn it (12-hour with AM/PM in a 12-hour locale)');
ok(/import \{ lineTime \} from '\/time-format\.mjs'/.test(room) && /ts\.textContent = lineTime\(e\.ts\);/.test(room) && /const fmtTime = lineTime;/.test(chat) && /import \{ lineWhen \} from '\/time-format\.mjs'/.test(ui) && /whenWords = lineWhen/.test(ui), 'the room line, the agent chat and the search results all call it, so they cannot drift');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
