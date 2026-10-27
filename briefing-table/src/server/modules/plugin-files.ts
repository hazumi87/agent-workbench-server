/* Plugin install, the disk moves (ported from workbench-app src/plugin-files.js; the design notes F1 and its addendum; lead [ref];
 * the design notes M6): under <data>/plugins, pure apart from an injected fs. stage() writes exactly the checked files (plugin-check.ts
 * `files`) into a fresh .staging-<16 hex> folder, each opened with wx (never over an existing name or a planted link) and fsynced, then reads the folder
 * back with the tree walk: it must give the same tree hash, and its per-file hashes go into the consent record. A failed or partial stage leaves nothing
 * (a crash's leftovers go to sweep()). install() renames into place, keeping the old version as .backup-<id>-<ts> and putting it back if the swap fails;
 * remove() moves to a backup that restore() (Undo) brings back. Windows: renames within one volume and no directory fsync. test/modules-plugin-files.test.ts. */
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { readTree, type Fs } from './plugin-tree.ts';
import { treeHash, type PluginFile } from './plugin-check.ts';
import { cleanName } from './plugin-zip.ts';

const ID = /^[a-z][a-z0-9-]{0,40}$/; // as the check's id rule (no dots)
export const KEEP_BACKUPS = 2;
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const idOk = (id: unknown): boolean => typeof id === 'string' && id.length >= 2 && id.length <= 41 && ID.test(id) && !!cleanName(id);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
// a plugin's folder: its id for a zip install, or the name a hand-placed copy already has (builder-three-3 [ref])
const folderOk = (f: unknown): f is string => typeof f === 'string' && f.length >= 1 && f.length <= 80 && !f.startsWith('.') && !f.includes('/') && !!cleanName(f);
const reEscape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const backupRe = (folder: string): RegExp => new RegExp('^\\.backup-' + reEscape(folder) + '-(\\d{1,16})$');

function rmTree(fs: Fs, dir: string): void { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort; sweep() retries */ } }

export interface StageOptions { fs?: Fs; rand?: () => string }
export type StageResult = { ok: true; dir: string; fileHashes: Record<string, string> } | { ok: false; reason: 'stage-failed' | 'stage-mismatch' };

/** stage(root, files, hash, {fs, rand}) → {ok:true, dir, fileHashes} or {ok:false, reason: 'stage-failed'|'stage-mismatch'}. */
export function stage(root: string, files: readonly PluginFile[], hash: string, { fs = nodeFs, rand = () => randomBytes(8).toString('hex') }: StageOptions = {}): StageResult {
  let dir: string | null = null;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    dir = path.join(root, '.staging-' + rand());
    fs.mkdirSync(dir, { mode: 0o700 }); // fresh: fails if the name exists
    for (const f of files) {
      if (!cleanName(f.path)) throw new Error('bad path');
      const abs = path.join(dir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(abs, 'wx', 0o600);
      try {
        let off = 0;
        while (off < f.data.length) off += fs.writeSync(fd, f.data, off, f.data.length - off);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    if (dir) rmTree(fs, dir);
    return fail('stage-failed') as StageResult;
  }
  const back = readTree(dir, {}, fs);
  if (!back.ok || treeHash(back.files) !== hash) { rmTree(fs, dir); return fail('stage-mismatch') as StageResult; }
  return { ok: true, dir, fileHashes: Object.fromEntries(back.files.map((f) => [f.path, sha(f.data)])) };
}

const exists = (fs: Fs, p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** The plugin id living in <root>/<folder> (from its own module.json), '' for a folder that is not a plugin, null for none. */
export function occupant(root: string, folder: string, { fs = nodeFs }: { fs?: Fs } = {}): string | null {
  const dir = path.join(root, folder);
  let st;
  try { st = fs.lstatSync(dir); } catch { return null; }
  if (!st.isDirectory()) return '';
  try {
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'));
    return man && typeof man.id === 'string' ? man.id : '';
  } catch {
    return '';
  }
}

export interface InstallOptions { expect?: string | null; fs?: Fs; now?: () => number }

/**
 * install(root, id, stagedDir, {expect, fs, now}) → {ok:true, backup: name|null} or {ok:false, reason}.
 * expect (required; builder-three-3 [ref]): null for a new install (nothing may be in the place), or the id of the
 * plugin being updated (the place must hold exactly that plugin, read again now from its own module.json).
 */
export function install(root: string, id: string, staged: string, { expect, fs = nodeFs, now = () => Date.now() }: InstallOptions = {}): { ok: true; backup: string | null } | { ok: false; reason: string } {
  if (!folderOk(id) || !idOk(id)) return fail('bad-id'); // the folder is the plugin id: the one module id rule
  if (expect !== undefined && expect !== null && !idOk(expect)) return fail('bad-id');
  if (expect === undefined) { rmTree(fs, staged); return fail('no-expectation'); }
  const target = path.join(root, id);
  const here = occupant(root, id, { fs });
  const refuse = (reason: string): { ok: false; reason: string } => { rmTree(fs, staged); return fail(reason); };
  if (expect === null && here !== null) return refuse('occupied');
  if (expect !== null && here === null) return refuse('changed');
  if (expect !== null && here !== expect) return refuse('occupied');
  let backup: string | null = null;
  try {
    if (exists(fs, target)) {
      backup = '.backup-' + id + '-' + now();
      fs.renameSync(target, path.join(root, backup));
    }
    fs.renameSync(staged, target);
    return { ok: true, backup };
  } catch {
    if (backup && !exists(fs, target)) { try { fs.renameSync(path.join(root, backup), target); } catch { /* sweep keeps the backup */ } }
    rmTree(fs, staged);
    return fail('install-failed');
  }
}

/** remove(root, id, {fs, now}) → {ok:true, backup} or {ok:false, reason}. The folder is kept as a backup for Undo. */
export function remove(root: string, id: string, { fs = nodeFs, now = () => Date.now() }: { fs?: Fs; now?: () => number } = {}): { ok: true; backup: string } | { ok: false; reason: string } {
  if (!folderOk(id) || !idOk(id)) return fail('bad-id');
  const target = path.join(root, id);
  if (!exists(fs, target)) return fail('not-installed');
  const backup = '.backup-' + id + '-' + now();
  try { fs.renameSync(target, path.join(root, backup)); } catch { return fail('remove-failed'); }
  return { ok: true, backup };
}

/** restore(root, id, backup, {fs}): Undo of a remove. Only this plugin's own backup, only into an empty place. */
export function restore(root: string, id: string, backup: unknown, { fs = nodeFs }: { fs?: Fs } = {}): { ok: true } | { ok: false; reason: string } {
  if (!folderOk(id) || !idOk(id)) return fail('bad-id');
  if (typeof backup !== 'string' || !backupRe(id).test(backup)) return fail('bad-backup');
  const from = path.join(root, backup), target = path.join(root, id);
  if (!exists(fs, from)) return fail('no-backup');
  if (exists(fs, target)) return fail('exists');
  try { fs.renameSync(from, target); } catch { return fail('restore-failed'); }
  return { ok: true };
}

/** sweep(root, {fs}): at start-up, clear .staging-* left by a crash and keep the newest backups per plugin. */
export function sweep(root: string, { fs = nodeFs }: { fs?: Fs } = {}): void {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return; }
  const backups = new Map<string, Array<{ n: string; t: number }>>();
  for (const n of names) {
    if (/^\.staging-[0-9a-f]{16}$/.test(n)) { rmTree(fs, path.join(root, n)); continue; }
    const m = /^\.backup-(.+)-(\d{1,16})$/.exec(n);
    if (m) { if (!backups.has(m[1])) backups.set(m[1], []); backups.get(m[1])!.push({ n, t: Number(m[2]) }); }
  }
  for (const list of backups.values()) {
    list.sort((a, b) => b.t - a.t);
    for (const old of list.slice(KEEP_BACKUPS)) rmTree(fs, path.join(root, old.n));
  }
}
