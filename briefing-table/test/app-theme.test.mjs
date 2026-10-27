/**
 * App theme [app theme] the design system [ref], Owner 2026-10-05: the {host:'theme'}
 * message (web/app-theme.mjs, run for real with palette.mjs tokens) and its
 * wiring in room-cells / room-app / room-palette (source-sliced, no browser).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeMessage, withMode } from '../web/app-theme.mjs';
import { tokens, PALETTES } from '../web/palette.mjs';

let failed = 0;
let passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.log(`  ✗ ${m}`); } };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');

console.log('\n[message shape]');
const dark = themeMessage(tokens, { key: 'aurora', mode: 'dark' }, 'dark');
ok(dark.host === 'theme' && dark.mode === 'dark' && JSON.stringify(dark.tokens) === '{}', 'aurora dark: mode dark, empty map');
ok(!('room' in dark), 'no room color: room omitted');
const other = Object.keys(PALETTES).find((k) => k !== 'aurora' && !PALETTES[k].custom);
const lit = themeMessage(tokens, { key: other, mode: 'light' }, 'light', '#336699');
ok(lit.mode === 'light' && Object.keys(lit.tokens).length > 0 && Object.keys(lit.tokens).every((k) => !k.startsWith('--')), 'light palette: mode light, tokens without "--"');
ok(lit.room === '#336699', 'room color carried');
ok(!('room' in themeMessage(tokens, null, 'dark', 'red')), 'a non-hex room color is omitted; no pref = aurora dark');
ok(themeMessage(tokens, { key: 'aurora', mode: 'light' }, 'light').mode === 'light', 'aurora light is light');

console.log('\n[?mode=light hint]');
ok(withMode('/f/t/tok/view', 'dark') === '/f/t/tok/view', 'dark: unchanged');
ok(withMode('/f/t/tok/view', 'light') === '/f/t/tok/view?mode=light', 'light, no query');
ok(withMode('/f/view?surface=large', 'light') === '/f/view?surface=large&mode=light', 'light, existing query kept');
ok(withMode('/f/view?x=1#h', 'light') === '/f/view?x=1&mode=light#h', 'fragment kept');
ok(withMode('https://a.b/p?q=1', 'light') === 'https://a.b/p?q=1&mode=light', 'absolute url');

console.log('\n[wiring]');
const cells = read('web/room-cells.mjs');
const hp = cells.slice(cells.indexOf('function handPort'));
ok(hp.indexOf("host: 'surface'") > 0 && hp.indexOf('tellTheme(v); // right after the surface') > hp.indexOf("host: 'surface'"), 'room-cells: theme sent after surface');
ok(cells.includes("withMode(withSurface(url, v.surface), currentTheme().mode)"), 'room-cells: frame src gets the mode hint');
ok(/addEventListener\('palette-change', broadcastTheme\)/.test(cells) && /addEventListener\('room-palette', broadcastTheme\)/.test(cells) && cells.includes("e.key === 'hwb.palette.v1'"), 'room-cells: re-sent on global change, room override, other tab');
ok(/for \(const v of \[c\.cv, c\.lv, c\.vv, c\.mv, c\.dv\]\) \{\n\s+if \(v\) \{ tellTheme\(v, msg\)/.test(cells), 'room-cells: broadcast reaches every view port');
ok(cells.includes('effectivePref()') && read('web/room-palette.mjs').includes('return roomPref || globalPref();'), 'effective = room override else global');
ok(read('web/palette.mjs').includes("new CustomEvent('palette-change')"), 'applyPref announces palette-change (Dark/Light and global pref both go through it)');
ok(read('web/room-palette.mjs').includes('roomPref = want ?'), 'room override tracked on paint (Dark/Light of the room too)');
const app = read('web/room-app.mjs');
ok(app.indexOf('tellTheme();') > app.indexOf("kind: 'window'"), 'room-app: theme after surface');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
