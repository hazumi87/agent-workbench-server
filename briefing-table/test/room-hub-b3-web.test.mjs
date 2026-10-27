/* ROOM ART MODEL + LINE WASH + ROOM SETTINGS [hub-v2], web half: source-slice checks
 * (no browser). The painted behavior is covered by the Playwright harness. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const rd = (f) => readFileSync(join(W, f), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };

const tile = rd('room-tile.mjs');
const ids = [...tile.matchAll(/T\('([a-z0-9-]+)'/g)].map((m) => m[1]);
ok(ids.length === 20, `20 tiles in the manifest (${ids.length})`);
const files = readdirSync(join(W, 'assets', 'tiles')).filter((f) => f.endsWith('.webp'));
ok(files.length === 20 && ids.every((i) => existsSync(join(W, 'assets', 'tiles', `${i}-512.webp`))), 'every manifest id has its file');
ok(ids.every((i) => /-(tint|hue|colour)$/.test(i) && /-(quiet|busy)-/.test(i)), 'set and density come from the file name');
ok(/tint: \['color', 60\], hue: \['hue', 55\], colour: \['none', 30\]/.test(tile), 'defaults by set: color/60, hue/55, none/30');
ok(/phone \? 192 : 256/.test(tile), 'tile 256 PC / 192 phone');
ok(/Math\.round\(cssSize \* dpr\)/.test(tile) && /N \* 3/.test(tile) && /\$\{src\}\|\$\{N\}/.test(tile), 'seams: N=round(css*dpr), 3x3 canvas, cache by src|N');
ok(['none', 'color', 'hue', 'saturation', 'luminosity', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'normal'].every((b) => tile.includes(`['${b}', `)), 'all 11 blends');

const wash = rd('room-wash.mjs');
ok(/dark: \{ s: 0\.3, e: 0\.16, l: 0\.46, r: 0\.08, lo: 0\.158, hi: 0\.947 \}/.test(wash), 'dark track and stops');
ok(/light: \{ s: 0\.925, e: 0\.975, l: 0\.66, r: 1, lo: 0\.235, hi: 1 \}/.test(wash), 'light track and stop');
ok(/clamp\(0,calc\(c \* \.40\),\.065\)/.test(wash) && /clamp\(0,calc\(c \* \.15\),\.028\)/.test(wash), 'dark chroma clamps unchanged');
ok(/-0\.01 : e\.key === 'ArrowRight' \? 0\.01/.test(wash) && /dblclick/.test(wash), 'arrow keys +-.01 and double-click reset');
/* ONLY writer of --wm-wash / --wm-term */
const writers = readdirSync(W).filter((f) => /\.(m?js|css|html)$/.test(f) && /setProperty\('--wm-(wash|term)'/.test(rd(f)));
ok(writers.join() === 'room-wash.mjs', `room-wash.mjs is the only writer of --wm-wash/--wm-term (${writers})`);
const hubcss = rd('room-hub.css') + rd('room.css') + rd('room-character.css');
ok(!/\.wm-pane\s*\{[^}]*--wm-(wash|term)/.test(hubcss), 'no stylesheet of ours sets --wm-wash/--wm-term on .wm-pane');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(rd('room-hub.css').replace(/\/\*[\s\S]*?\*\//g, '')), 'room-hub.css has no hex values');

const rc = rd('room-character.mjs');
ok(/paintTile\(line, \(room && room\.art_tile\) \|\| null\)/.test(rc), 'paintRoomCharacter paints the tile (null = today)');
ok(!/adaptRoom|roomFor/.test(rd('room-palette.mjs') + rd('room-art-settings.mjs')), 'a palette never adapts the room color');
const room = rd('room.js');
ok(!/Use the lead's color/.test(room), "the 'Use the lead's color' button is gone");
ok(/roomLookGroups\(\{/.test(room) && /roomArtEl: artGroup\.el/.test(room), "today's watermark group is wrapped as the Room art option");
ok(/'art_tile', 'wash_at', 'bubble_glass', 'pal', 'pal_mode'/.test(room), 'saveSettings keeps the new room fields');
const set = rd('room-art-settings.mjs');
const order = ['Art color', 'Palette color', "Lead's color", 'Sample colors', 'Custom color'].map((s) => set.search(new RegExp(`mkRow\\([\\"']${s}[\\"']\\)`)));
ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), 'color rows in the hub order');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
