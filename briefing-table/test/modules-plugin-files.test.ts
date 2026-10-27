/**
 * PLUGIN FILES (src/server/modules/plugin-files.ts; ported from workbench-app test/plugin-files.test.mjs; the design notes F1): the disk
 * moves, on real temp folders. Stage writes exactly the checked files with wx into a fresh folder and reads them back to the same tree hash (and per-file
 * hashes for the consent record); a failed or partial stage leaves nothing; install or update swaps folders with a backup and rolls back; remove moves to
 * a backup that Undo restores; the start-up sweep clears stale staging and keeps two backups per plugin; ids that are not plain folder names are refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { stage, install, remove, restore, sweep, occupant, KEEP_BACKUPS } from '../src/server/modules/plugin-files.ts';
import { treeHash, type PluginFile } from '../src/server/modules/plugin-check.ts';
import { readTree, type Fs } from '../src/server/modules/plugin-tree.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}
const made: string[] = [];
const root = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-plugin-files-')); made.push(d); return d; };
const files = (tag = '1'): PluginFile[] => [
  { path: 'module.json', data: Buffer.from('{"id":"notes-plus","v":"' + tag + '"}') },
  { path: 'ui/page.html', data: Buffer.from('<p>' + tag + '</p>') },
];
const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
const entries = (dir: string): string[] => fs.readdirSync(dir).sort();
const real = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
const wrap = (over: Record<string, unknown>): Fs => ({ ...fs, ...over }) as unknown as Fs;
/** stage and require success, for the setup steps */
function staged(r: string, fl: PluginFile[]): string {
  const s = stage(r, fl, treeHash(fl));
  if (!s.ok) throw new Error('stage failed: ' + s.reason);
  return s.dir;
}
const read = (...p: string[]): string => fs.readFileSync(path.join(...p), 'utf8');
const verdict = (r: { ok: boolean; reason?: string }): [boolean, string | undefined] => [r.ok, r.reason];

console.log('\n[stage writes exactly the files, reads them back to the same hash, and gives per-file hashes]');
{
  const r = root();
  const fl = files();
  const s = stage(r, fl, treeHash(fl));
  ok(s.ok === true, 'stages');
  if (s.ok) {
    ok(/^\.staging-[0-9a-f]{16}$/.test(path.basename(s.dir)), 'a fresh .staging-<16 hex> folder');
    const back = readTree(s.dir);
    ok(back.ok && treeHash(back.files) === treeHash(fl), 'the folder hashes as the files did');
    same(s.fileHashes, { 'module.json': sha(fl[0].data), 'ui/page.html': sha(fl[1].data) }, 'per-file hashes');
  }
}

console.log('\n[stage refuses when what is on disk is not what was checked, and leaves nothing behind]');
{
  const r = root();
  same(verdict(stage(r, files(), 'f'.repeat(64))), [false, 'stage-mismatch'], 'stage-mismatch');
  same(entries(r), [], 'nothing left');
}

console.log('\n[a write that fails half way (a kill mid-stage) leaves nothing behind]');
{
  const r = root();
  let n = 0;
  const failing = wrap({ writeSync(...a: unknown[]) { if (++n === 2) throw Object.assign(new Error('boom'), { code: 'EIO' }); return real.writeSync(...a); } });
  same(verdict(stage(r, files(), treeHash(files()), { fs: failing })), [false, 'stage-failed'], 'stage-failed');
  same(entries(r), [], 'nothing left');
}

console.log('\n[stage never writes through a planted link: wx refuses an existing name]');
{
  const r = root();
  const outside = root();
  const fl = files();
  let planted = false;
  const planting = wrap({ mkdirSync(p: string, ...a: unknown[]) { const out = real.mkdirSync(p, ...a); if (!planted && path.basename(p).startsWith('.staging-')) { planted = true; fs.symlinkSync(path.join(outside, 'x'), path.join(p, 'module.json')); } return out; } });
  same(verdict(stage(r, fl, treeHash(fl), { fs: planting })), [false, 'stage-failed'], 'stage-failed');
  same(entries(outside), [], 'nothing written outside');
  same(entries(r), [], 'nothing left');
}

console.log('\n[a path the zip reader would refuse is never written]');
{
  const r = root();
  const bad = [{ path: '../escape.txt', data: Buffer.from('x') }];
  same(verdict(stage(r, bad, treeHash(bad))), [false, 'stage-failed'], 'stage-failed');
  same(entries(r), [], 'nothing left, and nothing above the root');
}

console.log('\n[install a new plugin: the staged folder becomes <root>/<id>]');
{
  const r = root();
  same(install(r, 'notes-plus', staged(r, files()), { expect: null }), { ok: true, backup: null }, 'installed');
  same(entries(r), ['notes-plus'], 'only the plugin folder is left');
}

console.log('\n[update: the old folder goes to a backup, the new one takes its place; a failed swap puts the old one back]');
{
  const r = root();
  install(r, 'notes-plus', staged(r, files('1')), { expect: null });
  const u = install(r, 'notes-plus', staged(r, files('2')), { expect: 'notes-plus', now: () => 1000 });
  ok(u.ok && u.backup === '.backup-notes-plus-1000', 'the backup is named for the id and the time');
  ok(/"v":"2"/.test(read(r, 'notes-plus', 'module.json')), 'the new version is in place');
  ok(/"v":"1"/.test(read(r, '.backup-notes-plus-1000', 'module.json')), 'the old version is in the backup');
  const s3 = staged(r, files('3'));
  let n = 0;
  const failing = wrap({ renameSync(a: string, b: string) { if (++n === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real.renameSync(a, b); } });
  same(verdict(install(r, 'notes-plus', s3, { expect: 'notes-plus', fs: failing, now: () => 2000 })), [false, 'install-failed'], 'install-failed');
  ok(/"v":"2"/.test(read(r, 'notes-plus', 'module.json')), 'the installed version is untouched');
  ok(!fs.existsSync(s3), 'the failed stage is cleared');
}

console.log('\n[remove moves the plugin to a backup; restore (Undo) brings it back; restore refuses when something is there]');
{
  const r = root();
  install(r, 'notes-plus', staged(r, files()), { expect: null });
  const rm = remove(r, 'notes-plus', { now: () => 3000 });
  same(rm, { ok: true, backup: '.backup-notes-plus-3000' }, 'removed to a backup');
  same(entries(r), ['.backup-notes-plus-3000'], 'only the backup is left');
  same(restore(r, 'notes-plus', rm.ok ? rm.backup : ''), { ok: true }, 'restored');
  same(entries(r), ['notes-plus'], 'back in place');
  ok(!restore(r, 'notes-plus', '.backup-notes-plus-3000').ok && (restore(r, 'notes-plus', '.backup-notes-plus-3000') as { reason: string }).reason === 'no-backup', 'a second Undo finds no backup');
  ok((remove(r, 'nothing-here') as { reason: string }).reason === 'not-installed', 'nothing to remove');
}

console.log('\n[restore only takes a backup of the same plugin, by its own name]');
{
  const r = root();
  for (const b of ['../x', '.backup-other-1', 'notes-plus', '.staging-design-notes-id', 7, null]) ok((restore(r, 'notes-plus', b) as { reason: string }).reason === 'bad-backup', String(b));
}

console.log('\n[the sweep clears stale staging and keeps the newest two backups per plugin]');
{
  ok(KEEP_BACKUPS === 2, 'two backups are kept');
  const r = root();
  for (const n of ['.staging-0000000000000001', '.backup-a-1', '.backup-a-2', '.backup-a-3', '.backup-b-5', 'a']) fs.mkdirSync(path.join(r, n));
  sweep(r);
  same(entries(r), ['.backup-a-2', '.backup-a-3', '.backup-b-5', 'a'], 'swept');
  sweep(path.join(r, 'missing')); // a missing root is not an error
  ok(true, 'a missing root is quietly ignored');
}

console.log('\n[ids that are not plain folder names are refused everywhere]');
{
  const r = root();
  const s = staged(r, files());
  for (const id of ['../x', 'a/b', '.hidden', 'CON', 'x.', '', 'acme.notes']) {
    ok((install(r, id, s, { expect: null }) as { reason: string }).reason === 'bad-id', 'install ' + JSON.stringify(id));
    ok((remove(r, id) as { reason: string }).reason === 'bad-id', 'remove ' + JSON.stringify(id));
  }
}

console.log('\n[restore never overwrites: with a plugin back in place, Undo of the old remove is refused]');
{
  const r = root();
  install(r, 'notes-plus', staged(r, files('1')), { expect: null });
  const rm = remove(r, 'notes-plus', { now: () => 4000 });
  install(r, 'notes-plus', staged(r, files('2')), { expect: null });
  ok((restore(r, 'notes-plus', rm.ok ? rm.backup : '') as { reason: string }).reason === 'exists', 'exists');
  ok(/"v":"2"/.test(read(r, 'notes-plus', 'module.json')), 'the new one is untouched');
}

// builder-three-3's security read of 23e050c (application [ref]): the target is bound to what main saw at the pick.
console.log('\n[review: install refuses a folder held by another plugin, or one that changed since the pick]');
{
  const r = root();
  fs.mkdirSync(path.join(r, 'new-plugin'));
  fs.writeFileSync(path.join(r, 'new-plugin', 'module.json'), JSON.stringify({ id: 'old-plugin' }));
  const s = staged(r, files());
  ok((install(r, 'new-plugin', s, { expect: null }) as { reason: string }).reason === 'occupied', 'a new install never moves anything aside');
  ok(read(r, 'new-plugin', 'module.json') === JSON.stringify({ id: 'old-plugin' }), 'the other plugin is untouched');
  ok(!fs.existsSync(s), 'the stage is cleared');
  ok((install(r, 'new-plugin', staged(r, files()), { expect: 'new-plugin' }) as { reason: string }).reason === 'occupied', 'an update only replaces the same plugin');
  ok((install(r, 'gone-plugin', staged(r, files()), { expect: 'gone-plugin' }) as { reason: string }).reason === 'changed', 'the plugin to update is no longer there');
  ok((install(r, '.x', 'y', {}) as { reason: string }).reason === 'bad-id', 'a dot folder');
  ok((install(r, 'notes-plus', staged(r, files()), { expect: 'Bad Id' }) as { reason: string }).reason === 'bad-id', 'an expected id that is not an id');
}

console.log('\n[review: an update replaces only the same plugin, read from its own module.json]');
{
  const r = root();
  install(r, 'notes-plus', staged(r, files('1')), { expect: null });
  same(install(r, 'notes-plus', staged(r, files('2')), { expect: 'notes-plus', now: () => 5000 }), { ok: true, backup: '.backup-notes-plus-5000' }, 'updated');
  ok(occupant(r, 'notes-plus') === 'notes-plus', 'occupant reads the id');
  ok(occupant(r, 'nothing-here') === null, 'occupant of nothing is null');
  fs.writeFileSync(path.join(r, 'afile'), 'x');
  ok(occupant(r, 'afile') === '', 'a file is not a plugin');
}

console.log('\n[review: install without an expectation is refused (the caller must always say what it saw)]');
{
  const r = root();
  const s = staged(r, files());
  ok((install(r, 'notes-plus', s) as { reason: string }).reason === 'no-expectation', 'no-expectation');
  ok(!fs.existsSync(s), 'and the stage is cleared');
}

for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
