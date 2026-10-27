/**
 * MODULE WIDGET MANIFEST (src/server/modules/manifest.ts checkWidgetManifest; ported from workbench-app test/widget-manifest.test.mjs): the `widget`
 * class's manifest check (the design notes revision 1 R1.1). Pure. The bundled usage module (kept as test/fixtures/modules/widget-usage) passes;
 * every other shape is refused with a reason Modules can show.
 */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWidgetManifest, checkToolManifest } from '../src/server/modules/manifest.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'modules');

type Man = Record<string, unknown>;
const good = (over: Man = {}): Man => ({
  id: 'usage', name: 'Usage', version: '0.1.0', class: 'widget', icon: 'donut_large', contexts: ['app'],
  widget: { realm: 'app', sizes: { wide: [680, 152], tall: [236, 336] }, page: 'ui/widget.html', transparent: false },
  permissions: ['ui.widget'], ...over,
});
const w = (over: Man): Man => good({ widget: { ...(good().widget as Man), ...over } });
const isOk = (m: unknown): boolean => checkWidgetManifest(m).ok;
const reasonOf = (m: unknown): string => { const r = checkWidgetManifest(m); return r.ok ? '' : r.reason; };

console.log('\n[the bundled usage module passes, and the check returns only the widget part]');
{
  const man = JSON.parse(readFileSync(join(FIX, 'widget-usage', 'module.json'), 'utf8'));
  const r = checkWidgetManifest(man);
  ok(r.ok === true, 'usage passes');
  same(r.ok ? r.widget : null, { realm: 'app', sizes: { wide: [680, 152], tall: [236, 336] }, page: 'ui/widget.html', transparent: false }, 'the widget part');
}

console.log('\n[one declared size is enough]');
ok(isOk(w({ sizes: { tall: [236, 336] } })), 'tall only');
same((checkWidgetManifest(w({ sizes: { tall: [236, 336] } })) as { widget: { sizes: unknown } }).widget.sizes, { tall: [236, 336] }, 'and only tall comes back');

console.log('\n[the class, contexts, actions and main]');
ok(!isOk(good({ class: 'tool' })), 'class tool');
ok(!isOk(null), 'null');
ok(reasonOf(good({ class: 'tool' })) === 'class must be "widget"', 'the class reason');
ok(isOk(good({ contexts: undefined })), 'contexts may be left out');
for (const contexts of [['workroom'], ['app', 'workroom'], [], 'app']) ok(!isOk(good({ contexts })), 'contexts ' + JSON.stringify(contexts));
ok(/actions/.test(reasonOf(good({ actions: 'actions.json' }))), 'a widget has no actions');
ok(/main/.test(reasonOf(good({ main: 'main.js' }))), 'a widget has no main script');

console.log('\n[the only permission is ui.widget]');
ok(!isOk(good({ permissions: [] })), 'none');
ok(!isOk(good({ permissions: ['ui.widget', 'rooms.tasks.read'] })), 'a second one');
ok(!isOk(good({ permissions: 'ui.widget' })), 'not a list');

console.log('\n[widget has exactly realm, sizes, page and transparent]');
ok(!isOk(good({ widget: undefined })), 'no widget');
ok(!isOk(good({ widget: [] })), 'a list');
ok(!isOk(w({ extra: 1 })), 'an extra key');
{
  const { transparent: _t, ...noT } = good().widget as Man;
  ok(!isOk(good({ widget: noT })), 'a missing key');
}
ok(!isOk(w({ realm: 'room' })), 'room widgets are not in this seam');
ok(!isOk(w({ transparent: true })), 'transparent stays false in v1');

console.log('\n[sizes: wide and/or tall, whole numbers, 160-960 wide and 96-640 high]');
for (const sizes of [{}, { square: [200, 200] }, { wide: [159, 152] }, { wide: [961, 152] }, { wide: [680, 95] }, { wide: [680, 641] },
  { wide: [680.5, 152] }, { wide: ['680', 152] }, { wide: [680] }, { wide: [680, 152, 1] }, { wide: null }, [680, 152]]) {
  ok(!isOk(w({ sizes })), JSON.stringify(sizes));
}
ok(isOk(w({ sizes: { wide: [160, 96], tall: [960, 640] } })), 'the edges are fine');

console.log('\n[page: ui/<name>.html inside the module, the same rule as module windows]');
for (const page of ['widget.html', 'ui/../x.html', 'ui/sub/widget.html', 'ui/Widget.html', 'ui/widget.htm', '/ui/widget.html', 'ui/.hidden.html', 'https://x/ui/a.html', 7]) {
  ok(!isOk(w({ page })), 'page ' + String(page));
}

console.log('\n[the tool check is unchanged: a widget manifest is still not a tool]');
ok(checkToolManifest(good()).ok === false, 'checkToolManifest refuses it');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
