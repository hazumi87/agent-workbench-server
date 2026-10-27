/**
 * PLUGIN TREE (src/server/modules/plugin-tree.ts; ported from workbench-app test/plugin-tree.test.mjs): the folder walk the engine hashes at every scan.
 * It follows no link, reads only regular files, keeps the zip reader's caps and name rules, and gives the same files, so a zip and the folder it installs
 * to have the same tree hash. Real temp folders; the racing swaps go through an injected fs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readTree, type Fs } from '../src/server/modules/plugin-tree.ts';
import { readZip } from '../src/server/modules/plugin-zip.ts';
import { treeHash, type PluginFile } from '../src/server/modules/plugin-check.ts';
import { makeZip } from './fixtures/make-zip.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}
const made: string[] = [];
function tmpDir(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-plugin-tree-')); made.push(d); return d; }
function tmp(files: Record<string, string>): string {
  const dir = tmpDir();
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  return dir;
}
const files = (r: ReturnType<typeof readTree>): PluginFile[] => (r.ok ? r.files : []);
const reasonOf = (r: ReturnType<typeof readTree>): string | undefined => (r.ok ? undefined : r.reason);

// the real fs, called with arguments passed through untyped, for the wrappers below
const real = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
const wrap = (over: Record<string, unknown>): Fs => ({ ...fs, ...over }) as unknown as Fs;

console.log('\n[the folder gives the same files, and so the same hash, as the zip it came from]');
{
  const fl = { 'module.json': '{"id":"x"}', 'ui/page.html': '<p>hi</p>', 'ui/deep/a.css': 'p{}' };
  const t = readTree(tmp(fl));
  ok(t.ok === true, 'reads');
  same(files(t).map((f) => f.path), ['module.json', 'ui/deep/a.css', 'ui/page.html'], 'sorted paths');
  const z = readZip(makeZip(Object.entries(fl).map(([name, data]) => ({ name, data }))));
  ok(z.ok && treeHash(files(t)) === treeHash(z.entries.filter((e): e is Extract<typeof e, { dir: false }> => !e.dir)), 'the same tree hash as the zip');
}

console.log('\n[one changed byte changes the hash]');
{
  const dir = tmp({ 'module.json': '{"id":"x"}', 'a.js': 'one' });
  const before = treeHash(files(readTree(dir)));
  fs.writeFileSync(path.join(dir, 'a.js'), 'onf');
  ok(treeHash(files(readTree(dir))) !== before, 'a different hash');
}

console.log('\n[a link, to a file or a folder, is refused, never followed]');
{
  const outside = tmp({ 'secret.txt': 'x' });
  const dir = tmp({ 'module.json': '{}' });
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
  same(reasonOf(readTree(dir)), 'link', 'a file link');
  const dir2 = tmp({ 'module.json': '{}' });
  fs.symlinkSync(outside, path.join(dir2, 'sub'));
  ok(reasonOf(readTree(dir2)) === 'link', 'a folder link');
}

console.log('\n[the root itself must be a real folder, not a link to one]');
{
  const real1 = tmp({ 'module.json': '{}' });
  const parent = tmpDir();
  fs.symlinkSync(real1, path.join(parent, 'p'));
  ok(reasonOf(readTree(path.join(parent, 'p'))) === 'link', 'a linked root');
  ok(reasonOf(readTree(path.join(parent, 'missing'))) === 'unreadable', 'a missing root');
  ok(reasonOf(readTree(path.join(real1, 'module.json'))) === 'unreadable', 'a file as the root');
}

console.log('\n[caps and names: too many files, too many bytes, and a name the zip reader would refuse]');
{
  const many = tmp(Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['f' + i, 'x'])));
  ok(reasonOf(readTree(many, { entries: 5 })) === 'too-many-files', 'a lowered entries cap');
  ok(reasonOf(readTree(many, { unpackedBytes: 3 })) === 'too-big', 'a lowered bytes cap');
  ok(reasonOf(readTree(tmp({ 'module.json': '{}', 'name.': 'x' }))) === 'bad-name', 'a trailing dot');
}

// builder-three-2's race read of 05109f6 (application [ref]): swaps between check and use, growth, and the zip's clash rules.
console.log('\n[review: the root swapped for a link after it was checked is refused, and nothing from outside comes back]');
{
  const outside = tmp({ 'payload.txt': 'OUTSIDE' });
  const dir = tmp({ 'inside.txt': 'inside' });
  let done = false;
  const r = readTree(dir, {}, wrap({ readdirSync(p: string, ...a: unknown[]) { if (p === dir && !done) { done = true; fs.renameSync(dir, dir + '-old'); fs.symlinkSync(outside, dir); } return real.readdirSync(p, ...a); } }));
  ok(!r.ok && ['link', 'changed'].includes(r.reason), 'refused: ' + reasonOf(r));
}

console.log('\n[review: a file swapped for a link after it was checked is refused, read by a handle that is checked against the first look]');
{
  const outside = tmp({ 'payload.txt': 'OUTSIDE' });
  const dir = tmp({ 'a.txt': 'inside' });
  const f = path.join(dir, 'a.txt');
  let done = false;
  const swap = (): void => { if (!done) { done = true; fs.unlinkSync(f); fs.symlinkSync(path.join(outside, 'payload.txt'), f); } };
  const r = readTree(dir, {}, wrap({
    openSync(p: string, ...a: unknown[]) { if (p === f) swap(); return real.openSync(p, ...a); },
    readFileSync(p: string, ...a: unknown[]) { if (p === f) swap(); return real.readFileSync(p, ...a); },
  }));
  ok(!r.ok && ['link', 'changed'].includes(r.reason), 'refused: ' + reasonOf(r));
}

console.log('\n[review: a file that grows after its size was looked at cannot pass the byte cap; the cap counts bytes read]');
{
  const dir = tmp({ 'a.txt': 'x' });
  const f = path.join(dir, 'a.txt');
  const grow = (p: string): void => { if (p === f) fs.writeFileSync(f, Buffer.alloc(64, 65)); };
  const r = readTree(dir, { unpackedBytes: 16 }, wrap({
    openSync(p: string, ...a: unknown[]) { grow(p); return real.openSync(p, ...a); },
    readFileSync(p: string, ...a: unknown[]) { grow(p); return real.readFileSync(p, ...a); },
  }));
  ok(!r.ok && ['too-big', 'changed'].includes(r.reason), 'refused: ' + reasonOf(r));
}

console.log('\n[review: the folder follows the zip\'s clash rules (case, Unicode form)]');
ok(reasonOf(readTree(tmp({ 'A.txt': 'A', 'a.txt': 'B' }))) === 'name-clash', 'case');
{
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'café'), 'A');
  fs.writeFileSync(path.join(dir, 'café'), 'B');
  ok(reasonOf(readTree(dir)) === 'name-clash', 'Unicode form (a precomposed and a decomposed name side by side)');
}

console.log('\n[review: where open cannot refuse a link (Windows), the handle must still be the file lstat saw]');
{
  const outside = tmp({ 'payload.txt': 'OUTSIDE' });
  const dir = tmp({ 'a.txt': 'inside' });
  const f = path.join(dir, 'a.txt');
  let done = false;
  const r = readTree(dir, { noFollow: false }, wrap({ openSync(p: string, ...a: unknown[]) { if (p === f && !done) { done = true; fs.unlinkSync(f); fs.symlinkSync(path.join(outside, 'payload.txt'), f); } return real.openSync(p, ...a); } }));
  same([r.ok, reasonOf(r)], [false, 'changed'], 'changed');
}

console.log('\n[review: a file that grows after its handle was checked is caught by the bytes actually read]');
{
  const dir = tmp({ 'a.txt': 'x' });
  const f = path.join(dir, 'a.txt');
  const r = readTree(dir, {}, wrap({ fstatSync(fd: number, ...a: unknown[]) { const s = real.fstatSync(fd, ...a); fs.appendFileSync(f, 'more'); return s; } }));
  same([r.ok, reasonOf(r)], [false, 'changed'], 'changed');
}

console.log('\n[review: the root replaced by a link while its files were read is caught by the last check]');
{
  const dir = tmp({ 'a.txt': 'a' });
  let done = false;
  const r = readTree(dir, {}, wrap({ closeSync(fd: number) { fs.closeSync(fd); if (!done) { done = true; fs.renameSync(dir, dir + '-moved'); fs.symlinkSync(dir + '-moved', dir); } } }));
  same([r.ok, reasonOf(r)], [false, 'changed'], 'changed');
}

for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(d + '-old', { recursive: true, force: true }); fs.rmSync(d + '-moved', { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
