// [room brief] Owner 2026-10-05: source slices for the (i) buttons, the one markdown renderer and the flyout rules.
import { readFileSync } from 'node:fs';

const room = readFileSync(new URL('../web/room.js', import.meta.url), 'utf8');
const fly = readFileSync(new URL('../web/room-brief.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/room-brief.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/room.html', import.meta.url), 'utf8');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}

const tree = room.slice(room.indexOf('function navRow'), room.indexOf('function renderFamilyTree'));
ok(!/briefBtn\(/.test(tree), 'NO room row carries the (i): it is on the room bar only (one name per level, Auriga 1.P)');
const roomRow = room.slice(room.indexOf('function renderRoomRow'), room.indexOf('const roomMenu'));
ok(!/briefBtn\(/.test(roomRow) && /name\.textContent = 'Room chat'/.test(roomRow), "the current room's own row is \"Room chat\" and carries no (i)");
const crumb = room.slice(room.indexOf('function paintCrumb'), room.indexOf('function paintPlaceholder'));
ok((crumb.match(/briefBtn\(/g) ?? []).length === 1 && /briefBtn\(sub && parent \? \{ id: parent\.id, name: parent\.name \} : room\)/.test(crumb), 'the room bar carries ONE (i), the MAIN room\'s, after "where you are" (Auriga 1.P)');
ok(/\$\('phBrief'\)\.append\(briefButton\('Room brief', \(b\) => showBrief\(state\.room, b\)\)\)/.test(room), 'the phone header carries it too (row 1, right)');
ok(/canSet: true/.test(room) && /r = briefRoomOf\(r\);/.test(room) && /headId: null/.test(room), 'the person can set it; a workgroup shows its main room\'s brief (one brief per family)');
ok(!/if \(kind === 'head'\) \{\s*top\.append\(briefBtn\(r\)\)/.test(room), 'the rail puts no (i) on the main room row any more (the bar has it)');
ok(/!briefIsOpen/.test(room) && /b\.client\?\.action === 'brief'/.test(room), 'rail redraw held while open; a bare /brief opens the flyout');

ok(/import \{ loadLibs, renderMarkdown \} from '\/room-doc-view\.mjs'/.test(fly) && /renderMarkdown\(await loadLibs\(\)/.test(fly), "renders with the room's one markdown renderer (room-doc-view)");
ok(!/marked\.parse|purify\.sanitize|innerHTML/.test(fly), 'no second renderer, no innerHTML');
ok(/'rbf-md dv dv-md'/.test(fly), "the text takes the room's document styles");
ok(/by \$\{room\.brief_by === 'user'/.test(fly) && /Main room brief/.test(fly) && /method: 'PATCH', json: \{ brief: text \|\| null \}/.test(fly), 'shows "by @lead · time"; the Main room brief link; Edit PATCHes {brief}');
ok(/if \(!c\.touch\) \{\s*ta\.focus\(\)/.test(fly) && /if \(!c\.touch\) \{\s*box\.focus/.test(fly), 'no programmatic focus on touch');
ok(/fontSize = '16px'/.test(fly) && /Math\.min\(360, window\.innerWidth - 16\)/.test(fly), '16px textarea; the popover is 360px wide');
ok(/\.rbf\.is-sheet \{/.test(css) && /\.rsm-menu/.test(css.split('\n')[1] + css.split('\n')[2]), 'phone bottom sheet; reuses the seat menu surface');
ok(/room-brief\.css/.test(html), 'the stylesheet is linked');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
