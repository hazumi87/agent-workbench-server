/**
 * Global color palette, light-mode sweep, app title-bar tones, section menu
 * (hub V2, Owner 2026-10-05; handoff §1 D). Pure helpers run for real
 * (web/palette.mjs, web/app-tones.mjs, web/settings-palette.mjs prefOf); the
 * wiring is source-sliced (no browser). Run with node.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
const pal = await import('../web/palette.mjs');
const tones = await import('../web/app-tones.mjs');

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
const same = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

console.log('\n[the palette table]');
const keys = Object.keys(pal.PALETTES);
ok(keys.length === 21 && keys[keys.length - 1] === 'custom', `20 palettes + Customize... (${keys.length})`);
same(pal.MODES, ['dark', 'light'], 'modes');
same(pal.CUSTOM_KEYS, ['ink', 'surface', 'text', 'accent', 'neutral', 'cobalt', 'green', 'orchid', 'violet', 'orange'], 'ten custom colors');
const engine = read('src/engine/palette-prefs.ts');
const engineKeys = [...engine.match(/PALETTE_KEYS[^=]*= \[([\s\S]*?)\];/)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
same(engineKeys, keys, 'the engine validates the SAME key list, in order');
same(pal.tokens('aurora', null, 'dark'), {}, 'Aurora dark = no overrides (today\'s look unchanged)');
same(pal.tokens('nope', null, 'dark'), {}, 'an unknown key = no overrides');
same(pal.tokens('custom', null, 'dark'), {}, 'custom without colors = no overrides');
const need = ['ink', 'surface', 'surface2', 'surface3', 'border', 'border2', 'text', 'dim', 'dim2', 'nav', 'teal', 'sky', 'amber', 'coral', 'lime', 'magenta', 'indigo', 'cap-hover', 'ghost-fill', 'id-cobalt', 'id-green', 'id-orchid', 'id-violet', 'id-orange'];
for (const k of keys.filter((x) => x !== 'custom')) {
  for (const m of pal.MODES) {
    if (k === 'aurora' && m === 'dark') continue;
    const t = pal.tokens(k, null, m);
    if (!need.every((n) => typeof t[n] === 'string')) {
      ok(false, `${k}/${m} carries every token`);
    }
  }
}
ok(true, 'every palette x mode carries all 24 tokens');
const lt = pal.tokens('aurora', null, 'light');
ok(/^oklch\(0\.985 /.test(lt.ink) && /^oklch\(0\.25/.test(lt.text), 'Aurora light pins the light lightness (ink .985, text .25)');
ok(pal.tokens('contrast', null, 'dark').text.startsWith('oklch(1.000'), 'High contrast dark text is white');
ok(Object.keys(pal.tokens('midnight', null, 'dark')).every((n) => !/^wm-|room/.test(n)), 'a palette never writes room or watermark tokens');
const custom = { ink: '#101010', surface: '#202020', text: '#eeeeee', accent: '#22ccaa', neutral: '#888888', cobalt: '#3355ff', green: '#33aa55', orchid: '#cc55cc', violet: '#7755ee', orange: '#ee8833' };
const ct = pal.tokens('custom', custom, 'dark');
ok(ct.ink === '#101010' && ct.teal === '#22ccaa' && ct['id-orange'] === '#ee8833' && /color-mix/.test(ct.surface2), 'custom maps its ten colors and derives the rest');
ok(!('adaptRoom' in pal) && !('roomColor' in pal), 'adaptRoom / roomColor are NOT exported (a palette never moves a room color)');

console.log('\n[apply: tokens, data-mode, color-scheme, theme-color]');
/* hex() paints one pixel on a canvas: a stub that answers 1,2,3 is enough here */
globalThis.document = { createElement: () => ({ getContext: () => ({ clearRect() {}, fillRect() {}, set fillStyle(v) {}, getImageData: () => ({ data: [1, 2, 3, 255] }) }) }) };
function fakeDoc() {
  const props = new Map();
  const meta = { attrs: { content: '#0C1014' }, dataset: {}, getAttribute(n) { return this.attrs[n]; }, setAttribute(n, v) { this.attrs[n] = v; } };
  return {
    props, meta,
    documentElement: { dataset: {}, style: { colorScheme: '', setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } },
    querySelector: (q) => (q === 'meta[name="theme-color"]' ? meta : null),
  };
}
{
  const d = fakeDoc();
  pal.apply(d, pal.tokens('ocean', null, 'light'), 'light');
  ok(d.documentElement.dataset.mode === 'light' && d.documentElement.style.colorScheme === 'light' && d.props.has('--ink'), 'light: data-mode, color-scheme and --ink set');
  pal.apply(d, {}, 'dark');
  ok(d.documentElement.dataset.mode === 'dark' && d.props.size === 0 && d.meta.attrs.content === '#0C1014', 'back to Aurora dark: every override removed, theme-color restored');
}

console.log('\n[app title-bar tones]');
same(tones.TONES, ['cobalt', 'green', 'orchid', 'violet', 'orange'], 'the five identity tones');
same(tones.BUILTIN_APPS.map((a) => [a.key, a.tone]), [['tasks', 'cobalt'], ['assets', 'green'], ['studio', 'orchid'], ['voice', 'violet'], ['model', 'orange']], 'defaults: tasks cobalt, assets green, studio orchid, voice violet, model orange');
ok(tones.toneFor({ app_slug: 'room-tasks' }, {}) === 'cobalt' && tones.toneFor({ app_slug: 'image-studio' }, {}) === 'orchid', 'no override: the default table');
ok(tones.toneFor({ app_slug: 'room-tasks' }, { tasks: 'orange' }) === 'orange', 'an override (canonical key) wins over the table');
ok(tones.toneFor({ icon: 'list', title: 'Tasks' }, { tasks: 'violet' }) === 'violet', '...whatever spelling the panel arrives with');
ok(tones.toneFor({ app_slug: 'room-tasks' }, { tasks: 'teal' }) === 'cobalt', 'a stored value that is not one of the five is ignored');
ok(tones.toneFor({ app_slug: 'my-notes' }, {}) === tones.toneFor({ app_slug: 'my-notes' }, null), 'an unknown app hashes into the five, stably');
ok(tones.toneFor({ app_slug: 'my-notes' }, { 'my-notes': 'green' }) === 'green', 'an unknown app is overridden by its slug');
ok(tones.toneKey({ slug: 'model-studio', name: 'Model Studio' }) === 'model' && tones.toneKey({ slug: 'room-assets' }) === 'assets', 'a registry row (slug/name) maps to the same key');

console.log('\n[wiring: source]');
const cells = read('web/room-cells.mjs');
ok(/export function cellTone\(p\) \{\s*return toneFor\(p, userTones\);\s*\}/.test(cells) && /export function setUserTones/.test(cells) && /retone: \(\) =>/.test(cells), 'room-cells: cellTone = toneFor(override over the table); retone() on the cells');
const roomjs = read('web/room.js');
ok(/setUserTones\(me\.body\.tones\)/.test(roomjs) && /cells\?\.retone\(\)/.test(roomjs), 'room.js: tones loaded before the cells, refreshed on show');
const light = read('web/light-mode.css');
ok(!/\.wm-pane|--wm-term|--wm-wash/.test(light.replace(/\/\*[\s\S]*?\*\//g, '')), 'light-mode.css has NO .wm-pane / --wm-term / --wm-wash rule (HELD)');
ok(/html\[data-mode=light\] body \{[^}]*--rc-ink: oklch\(from var\(--room-c\) \.42/.test(light) && /--rc-wash: oklch\(from var\(--room-c\) \.93/.test(light), 'light: --rc-ink .42 and --rc-wash .93');
ok(/--room-accent: oklch\(from var\(--room-c\) \.50/.test(light) && /--pc-ink: oklch\(from var\(--pc\) \.42/.test(light) && /--pc-wash: oklch\(from var\(--pc\) \.96/.test(light) && /--pc-edge: oklch\(from var\(--pc\) \.84/.test(light), 'light: --room-accent .50, --pc-ink/-wash/-edge .42/.96/.84');
const lightCode = light.replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/\.hwb-(tab|sbar|barwash)/.test(lightCode), 'light-mode.css has no .hwb-tab / .hwb-sbar / .hwb-barwash rule (window-chrome v34 owns them, per tab)');
const pinV = (f) => Number(read(f).trim()); ok(pinV('web/aurora/window-chrome/VERSION') >= 34 && pinV('web/aurora/window-chrome/VERSION') === pinV('web/assets/aurora/window-chrome/VERSION'), 'both window-chrome pins are the same version, v34 or later');
const chromeCss = read('web/aurora/window-chrome/hwb-chrome.css');
ok(/\.hwb-tab\[data-mode=light\]/.test(chromeCss) && /\.hwb-sbar\[data-mode=light\]/.test(chromeCss), 'v34 chrome: tabs and the bar take their own data-mode');
const shellSrc = read('web/shell.html');
ok(/mode: isWorkroom\(t\) \? \(t\.roomMode \|\| undefined\)/.test(shellSrc) && /mode: \(isWorkroom\(t\) && t\.roomMode\) \|\| undefined/.test(shellSrc), 'shell passes the room override as tabs[].mode and s.mode');
ok(/hwbRoomMode/.test(read('web/room.js')) && /pal_mode === 'light'/.test(read('web/room.js')), 'the room page tells the shell its pal_mode');
for (const f of ['room', 'manager', 'shell', 'solo', 'settings', 'account', 'art', 'room-app']) {
  const h = read(`web/${f}.html`);
  ok(/<head>[\s\S]{0,200}<script src="\/palette-boot\.js"><\/script>/.test(h), `${f}.html: the palette boot script is first in <head> (no flash)`);
}
for (const f of ['room', 'manager', 'settings', 'solo', 'room-app', 'art']) {
  ok(read(`web/${f}.html`).includes('/light-mode.css'), `${f}.html links light-mode.css`);
}
const boot = read('web/palette-boot.js');
ok(/hwb\.palette\.v1/.test(boot) && /localStorage/.test(boot) && /try \{/.test(boot) && /\/api\/rooms\/me/.test(boot) && /storage/.test(boot), 'boot: cached copy (guarded storage), server reconcile, storage event');
ok(read('web/palette.mjs').includes("'hwb.palette.v1'"), 'palette.mjs writes the same cache key');
const st = read('web/settings.mjs');
const order = [...st.matchAll(/\{ id: '([a-z-]+)', title: '([^']+)'/g)].map((m) => m[1]);
same(order, ['you', 'voice', 'palette', 'apps', 'app-behavior', 'idle-rest', 'agent-comms', 'chatter', 'concierge'], 'menu order: You, Voice, Global color palette, Apps, App behavior, then the existing groups (Concierge last, cloud-agent job 2)');
ok(/id: 'palette', title: 'Global color palette'.*tag: 'new'/.test(st), 'a "new" tag on Global color palette');
ok(/rootMargin: '-10% 0px -70% 0px'/.test(st), 'the current link tracks scroll (IntersectionObserver, -10% 0 -70% 0)');
const css = read('web/settings.css');
ok(/\.st-main\.v2nav \{ max-width: 860px; display: grid; grid-template-columns: 200px minmax\(0, 560px\); gap: 0 36px; \}/.test(css), 'grid 200px | minmax(0,560px), gap 36px');
ok(/\.st-nav \{ position: sticky; top: 14px;/.test(css) && /min-height: 34px; padding: 0 12px; border-radius: 8px/.test(css) && /border-left: 2px solid transparent/.test(css), 'sticky nav top 14px; links 34px / 12px / r8');
ok(/scroll-margin-top: 24px/.test(css) && /border-left: 3px solid var\(--room-accent/.test(css) && /16%, var\(--surface2\)\), var\(--surface2\) 70%/.test(css), 'heading band: 16% -> surface2 70%, 3px edge, scroll-margin 24px');
ok(/@media \(max-width: 640px\)[\s\S]*flex-direction: row; gap: 6px; overflow-x: auto/.test(css), 'phone: the menu is a horizontal chip scroller');
const apps = read('web/settings-apps.mjs');
ok(/toneSwatches\(x, ctx\.me, ctx\.save/.test(apps) && /'sa-tb', 'Title bar'/.test(apps), 'each app card has a Title bar row');
const sp = read('web/settings-palette.mjs');
ok(/BUILTIN_APPS/.test(sp) && /the room color, always/.test(sp) && /tb-bar/.test(sp), 'the summary lists Seats (room color, always, no setting) + the apps');
ok(/Customize… unlocks the pickers/.test(sp) && /remember\(document, pref\)/.test(sp), 'copy as in the hub; applies at once');

/* CLI pages keep the design system dark (Owner 2026-10-05: light tokens turned terminal text black) */
ok(/<html lang="en" data-palette="off">/.test(read('web/solo.html')), 'solo.html (a CLI) opts out of the global palette');
ok(/getAttribute\('data-palette'\) === 'off'\) \{ root\.dataset\.mode = 'dark'; return; \}/.test(read('web/palette-boot.js')), 'palette-boot paints nothing on an opted-out page and stays dark');
ok(/html\[data-mode=light\] \.sess\.c4 \{[^}]*--c4-wash: oklch\(from var\(--brand-src, var\(--dim\)\) \.90/.test(read('web/light-mode.css')), 'light mode: manager cards get a pale wash (no dark .245 ground under dark text)');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
