/* Plugin install, the folder walk (ported from workbench-app src/plugin-tree.js; the design notes C1, the design notes M6): read a
 * user plugin's folder for its tree hash at every scan. No link is followed (the root included), and what is read is what was looked at: each folder's
 * identity (device and inode, as bigints) is pinned when first seen and checked again after it is listed and once more at the end; each file is opened
 * without following a link where the platform can (O_NOFOLLOW), its handle must be the same file that lstat saw, and it is read through the handle with
 * the byte cap counted on bytes actually read. The zip reader's caps, names and clash rules (case, Unicode form) apply, so a zip and the folder it installs
 * to give the same files and hash (plugin-check.ts treeHash).
 * Limit: Node has no openat, so a writer racing inside <data>/plugins could still swap a folder and swap it back between two checks; the hash answers "did
 * the files change since you allowed them", not an active local attacker who can already write there (builder-three-2 [ref]). The engine runs on Linux,
 * where O_NOFOLLOW exists; the Windows branch (no O_NOFOLLOW, the handle identity check alone) stays for the app's tests and is reachable with noFollow:false.
 * test/modules-plugin-tree.test.ts. */
import nodeFs from 'node:fs';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { LIMITS, cleanName, type ZipLimits } from './plugin-zip.ts';
import type { PluginFile } from './plugin-check.ts';

export type Fs = typeof nodeFs;
export type TreeResult = { ok: true; files: PluginFile[] } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const NOFOLLOW: number = nodeFs.constants.O_NOFOLLOW || 0; // undefined on Windows: the handle identity check stands alone there

/** readTree(dir, limits?, fs?) → {ok:true, files:[{path, data}] sorted by path} or {ok:false, reason}. limits.noFollow:false acts as Windows (tests). */
export function readTree(dir: string, over: Partial<ZipLimits> & { noFollow?: boolean } = {}, fs: Fs = nodeFs): TreeResult {
  const L = { ...LIMITS, ...over };
  const dirs: Array<{ abs: string; id: BigIntStats }> = []; // pinned identities
  const look = (abs: string): BigIntStats | null => { try { return fs.lstatSync(abs, { bigint: true }); } catch { return null; } };
  const st = look(dir);
  if (!st) return fail('unreadable');
  if (st.isSymbolicLink()) return fail('link');
  if (!st.isDirectory()) return fail('unreadable');
  const files: PluginFile[] = [];
  const folded = new Set<string>();
  let count = 0, total = 0;

  function readFile(abs: string, before: BigIntStats): Buffer | string {
    let fd: number;
    try { fd = fs.openSync(abs, fs.constants.O_RDONLY | (L.noFollow === false ? 0 : NOFOLLOW)); } catch (e) { return (e as NodeJS.ErrnoException | null)?.code === 'ELOOP' ? 'link' : 'unreadable'; }
    try {
      const now = fs.fstatSync(fd, { bigint: true });
      if (!now.isFile() || !same(now, before)) return 'changed';
      const room = L.unpackedBytes - total;
      const want = Number(now.size);
      if (want > room) return 'too-big';
      const buf = Buffer.alloc(want + 1); // one byte more, to see a file that grew after fstat
      let got = 0, n: number;
      while (got < buf.length && (n = fs.readSync(fd, buf, got, buf.length - got, got)) > 0) got += n;
      if (got !== want) return got > want && got > room ? 'too-big' : 'changed';
      total += got;
      return buf.subarray(0, got);
    } finally {
      try { fs.closeSync(fd); } catch { /* closed */ }
    }
  }

  function walk(abs: string, rel: string, id: BigIntStats): string | null {
    dirs.push({ abs, id });
    let names: string[];
    try { names = fs.readdirSync(abs); } catch { return 'unreadable'; }
    const again = look(abs);
    if (!again || again.isSymbolicLink() || !again.isDirectory() || !same(again, id)) return 'changed';
    for (const name of names.sort()) {
      const r = rel ? rel + '/' + name : name;
      if (++count > L.entries) return 'too-many-files';
      const s = look(path.join(abs, name));
      if (!s) return 'unreadable';
      if (s.isSymbolicLink()) return 'link';
      const clean = cleanName(s.isDirectory() ? r + '/' : r);
      if (!clean) return 'bad-name';
      const fold = clean.path.toLowerCase();
      if (folded.has(fold)) return 'name-clash';
      folded.add(fold);
      if (s.isDirectory()) { const why = walk(path.join(abs, name), r, s); if (why) return why; continue; }
      if (!s.isFile()) return 'not-regular';
      const data = readFile(path.join(abs, name), s);
      if (typeof data === 'string') return data;
      files.push({ path: clean.path, data });
    }
    return null;
  }

  const why = walk(dir, '', st);
  if (why) return fail(why);
  for (const d of dirs) { // every folder is still the one that was listed
    const s = look(d.abs);
    if (!s || s.isSymbolicLink() || !s.isDirectory() || !same(s, d.id)) return fail('changed');
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, files };
}
