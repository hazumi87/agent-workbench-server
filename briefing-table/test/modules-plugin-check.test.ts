/**
 * PLUGIN CHECK (src/server/modules/plugin-check.ts; ported from workbench-app test/plugin-check.test.mjs): check a plugin from the zip reader's entries,
 * before anything touches disk. module.json at the root or in one top folder; the same checks the module scan applies (id, class, paths, the tool and
 * actions manifests); never a built-in or reserved id, never core, never a main script; no programs; every file the manifest names is present. The answer
 * is the dialog's summary and the tree hash the consent record pins.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readZip } from '../src/server/modules/plugin-zip.ts';
import { checkPlugin, treeHash, MODULE_CLASSES, BUNDLED_MODULE_IDS, type CheckOptions } from '../src/server/modules/plugin-check.ts';
import { makeZip, type MakeEntry } from './fixtures/make-zip.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}

const CLASSES = new Set(['cli-manager', 'status-monitor', 'concierge', 'workrooms', 'tool', 'widget']);
const opts: CheckOptions = { classes: CLASSES, reservedIds: new Set(['tasks', 'hello-tool', 'usage']), installed: new Map([['notes-plus', '0.1.0']]) };
const actions = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'modules', 'hello-tool', 'actions.json'), 'utf8');
const man = (o: Record<string, unknown> = {}): string => JSON.stringify({ id: 'notes-plus', name: 'Notes Plus', version: '0.2.0', class: 'tool', provides: ['hello.card'], contexts: ['dashboard', 'agent'], actions: 'actions.json', permissions: ['storage'], ...o });
const files = (m: string = man(), extra: MakeEntry[] = [], prefix = 'notes-plus/'): MakeEntry[] => [
  ...(prefix ? [{ name: prefix }] : []),
  { name: prefix + 'module.json', data: m },
  { name: prefix + 'actions.json', data: actions },
  { name: prefix + 'ui/page.html', data: '<p>notes</p>' },
  ...extra.map((e) => ({ ...e, name: prefix + e.name })),
];
const check = (list: MakeEntry[], o: CheckOptions = opts) => {
  const z = readZip(makeZip(list));
  if (!z.ok) throw new Error('zip refused: ' + z.reason);
  return checkPlugin(z.entries, o);
};
const refusal = (r: ReturnType<typeof checkPlugin>): [boolean, string | undefined, string | undefined] => (r.ok ? [true, undefined, undefined] : [false, r.reason, r.detail]);

console.log('\n[a good plugin in one top folder: the summary for the dialog and the files relative to the plugin]');
{
  const r = check(files());
  ok(r.ok === true, 'passes');
  if (r.ok) {
    same({ id: r.id, name: r.name, version: r.version, class: r.class, replaces: r.replaces }, { id: 'notes-plus', name: 'Notes Plus', version: '0.2.0', class: 'tool', replaces: '0.1.0' }, 'the summary');
    same(r.files.map((f) => f.path), ['actions.json', 'module.json', 'ui/page.html'], 'files relative to the plugin, sorted');
    ok(/^[0-9a-f]{64}$/.test(r.hash), 'a sha256 tree hash');
    same(r.grants, [], 'no gated grants');
    ok(r.wants === null, 'nothing wanted');
    ok(r.bytes === r.files.reduce((n, f) => n + f.data.length, 0), 'bytes add up');
  }
}

console.log('\n[module.json at the zip root works the same, and gives the same hash]');
{
  const a = check(files(man(), [], ''));
  const b = check(files());
  ok(a.ok && b.ok && a.hash === b.hash, 'same hash');
  const fresh = check(files(man({ id: 'brand-new' }), [], ''));
  ok(fresh.ok && fresh.replaces === null, 'a new id replaces nothing');
}

console.log('\n[the hash covers every path and byte, in a fixed order]');
{
  const f = (path: string, data: string) => ({ path, data: Buffer.from(data) });
  const base = treeHash([f('a.js', '1'), f('b/c.js', '2')]);
  ok(treeHash([f('b/c.js', '2'), f('a.js', '1')]) === base, 'order of the zip does not matter');
  ok(treeHash([f('a.js', '1'), f('b/c.js', '3')]) !== base, 'other bytes');
  ok(treeHash([f('a.js', '1'), f('b/d.js', '2')]) !== base, 'other path');
  ok(treeHash([f('a.js', '1b.js2')]) !== treeHash([f('a.js', '1'), f('b.js', '2')]), 'no path/data boundary shift');
}

console.log('\n[gated grants come back in their plain words for the dialog]');
{
  const r = check(files(man({ permissions: ['storage', 'microphone', 'concierge.send'] })));
  ok(r.ok, 'passes');
  if (r.ok) {
    same(r.grants, ['concierge.send', 'microphone'], 'grants in display order');
    ok(r.wants === 'send messages as you through Concierge and use your microphone', 'the words');
  }
}

console.log('\n[refusals, each named]');
for (const [what, list, reason] of [
  ['no module.json', files().filter((f) => !f.name.endsWith('module.json')), 'no-manifest'],
  ['two top folders', [...files(), { name: 'other/x.js', data: 'x' }], 'layout'],
  ['module.json not JSON', files('{nope'), 'bad-manifest'],
  ['module.json too big', files(man({ description: randomBytes(35 * 1024).toString('hex') })), 'bad-manifest'], // not compressible, so the reader passes it
  ['bad id', files(man({ id: 'Bad Id' })), 'bad-manifest'],
  ['unknown class', files(man({ class: 'daemon' })), 'bad-manifest'],
  ['a built-in id', files(man({ id: 'hello-tool' })), 'reserved-id'],
  ['the reserved Tasks id', files(man({ id: 'tasks' })), 'reserved-id'],
  ['core', files(man({ core: true })), 'core'],
  ['bad tool manifest', files(man({ provides: [] })), 'bad-manifest'],
  ['a main script', files(man({ main: 'index.js' }), [{ name: 'index.js', data: 'export function activate() {}' }]), 'bad-manifest'],
  ['a main script that points outside', files(man({ main: '../x.js' })), 'bad-manifest'],
  ['a main script that is missing', files(man({ main: 'missing.js' })), 'bad-manifest'],
  ['actions file missing', files().filter((f) => !f.name.endsWith('actions.json')), 'missing-file'],
  ['bad actions', files().map((f) => (f.name.endsWith('actions.json') ? { ...f, data: '{"actions":"nope"}' } : f)), 'bad-manifest'],
  ['an exe', files(man(), [{ name: 'bin/tool.exe', data: 'MZ' }]), 'program'],
  ['a dll in any case', files(man(), [{ name: 'x.DLL', data: 'MZ' }]), 'program'],
  ['a node addon', files(man(), [{ name: 'build/a.node', data: 'x' }]), 'program'],
  ['a powershell script', files(man(), [{ name: 'setup.ps1', data: 'x' }]), 'program'],
  ['a batch file', files(man(), [{ name: 'run.cmd', data: 'x' }]), 'program'],
  ['a shell script', files(man(), [{ name: 'run.sh', data: 'x' }]), 'program'],
  ['a PE file by its bytes', files(man(), [{ name: 'innocent.txt', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]) }]), 'program'],
] as ReadonlyArray<readonly [string, MakeEntry[], string]>) {
  same(refusal(check(list)).slice(0, 2), [false, reason], what);
}
ok(checkPlugin(null, opts).ok === false && refusal(checkPlugin(null, opts))[1] === 'no-manifest', 'no entries at all');

console.log('\n[a main script is refused whatever it holds, with its reason for the details line]');
{
  const r = check(files(man({ main: 'index.js' }), [{ name: 'index.js', data: 'export function activate() {}' }]));
  same(refusal(r), [false, 'bad-manifest', 'a plugin has no main script'], 'main: index.js');
  same(refusal(check(files(man({ main: null })))).slice(0, 2), [false, 'bad-manifest'], 'main: null');
  ok(check(files(man({ entry: 'ui/page.html' }))).ok === true, 'an entry page is not a main script');
}

console.log('\n[the refusal carries the manifest checker words where there are some, for the details line]');
ok(/provides is required/.test(refusal(check(files(man({ provides: [] }))))[2] ?? ''), 'provides is required');

console.log('\n["Update from zip..." on one plugin refuses a zip that is a different plugin]');
ok(check(files(), { ...opts, expectId: 'notes-plus' }).ok === true, 'the same plugin');
same(refusal(check(files(man({ id: 'other-thing' })), { ...opts, expectId: 'notes-plus' })), [false, 'different-plugin', 'other-thing'], 'another plugin');

console.log('\n[reserved ids are the app\'s bundled ones, and the defaults are the app\'s classes and ids]');
same([...BUNDLED_MODULE_IDS].sort(), ['cli-manager', 'hello-tool', 'status-monitor', 'tasks', 'usage', 'workrooms'], 'BUNDLED_MODULE_IDS');
same([...MODULE_CLASSES].sort(), ['cli-manager', 'concierge', 'status-monitor', 'tool', 'widget', 'workrooms'], 'MODULE_CLASSES');
for (const id of BUNDLED_MODULE_IDS) {
  const r = check(files(man({ id })), { installed: new Map() }); // no options: the defaults
  ok(refusal(r)[1] === 'reserved-id', 'by default ' + id + ' is reserved');
}
ok(check(files(man({ id: 'notes-plus' })), { installed: new Map() }).ok === true, 'by default a plain id passes');
same(refusal(check(files(man({ class: 'daemon' })), {})).slice(0, 2), [false, 'bad-manifest'], 'by default an unknown class is refused');

console.log('\n[review: the manifest id follows Windows folder rules and aliases are caught before the reserved lookup]');
for (const id of ['con', 'nul.x', 'com1', 'usage.', 'review-plugin.', 'a..b', 'lpt\u00b9']) {
  const r = check(files(man({ id })));
  ok(!r.ok && ['bad-manifest', 'reserved-id'].includes(r.reason), id + ': ' + (r.ok ? 'accepted' : r.reason));
}
for (const id of ['notes.plus', 'acme.notes', 'a.b']) {
  const r = check(files(man({ id })));
  ok(r.ok === false && (r as { reason: string }).reason === 'bad-manifest', 'a dotted id is refused (one module id rule, Server [ref]): ' + id);
}
ok(check(files(man({ id: 'notes-plus' }))).ok === true, 'letters, digits and dashes are fine');

console.log('\n[review: programs hidden by name or bytes: Mach-O 32 both byte orders, fat 64, scripts and a shebang]');
for (const [what, data] of [
  ['mach32', Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 0])],
  ['mach32 le', Buffer.from([0xce, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])],
  ['fat64', Buffer.from([0xca, 0xfe, 0xba, 0xbf, 0, 0, 0, 0])],
  ['shebang', Buffer.from('#!/bin/sh\necho hi\n')],
] as const) ok(refusal(check(files(man(), [{ name: 'image.txt', data }])))[1] === 'program', what);
for (const name of ['run.py', 'tool.pyw', 'x.rb', 'x.pl', 'x.ps1', 'x.applescript', 'x.jse', 'x.lnk', 'x.reg']) {
  ok(refusal(check(files(man(), [{ name, data: 'x' }])))[1] === 'program', name);
}

console.log('\n[review: a widget must ship the page it names]');
{
  const widget = (page = 'ui/w.html'): string => JSON.stringify({ id: 'w-plus', name: 'W', version: '1', class: 'widget', permissions: ['ui.widget'], widget: { realm: 'app', sizes: { wide: [320, 160] }, page, transparent: false } });
  const list = (m: string, withPage: boolean): MakeEntry[] => [{ name: 'module.json', data: m }, ...(withPage ? [{ name: 'ui/w.html', data: '<p>w</p>' }] : [])];
  ok(check(list(widget(), true)).ok === true, 'a widget with its page passes');
  same(refusal(check(list(widget(), false))), [false, 'missing-file', 'ui/w.html'], 'without its page: missing-file');
  ok(refusal(check(list(widget('ui/../x.html'), true)))[1] === 'bad-manifest', 'a bad widget page is a bad manifest');
  ok(refusal(check(list(JSON.stringify({ ...JSON.parse(widget()), main: 'main.js' }), true)))[2] === 'a plugin has no main script', 'a widget with a main script is refused as any plugin is');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
