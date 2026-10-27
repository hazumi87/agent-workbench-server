/* THE FOLDER-BACKED FILE STORE [master spec Part A4, lead order 15650]: the same five operations the agent-share client offers (list,
 * upload, read, move), answered from a folder on this PC instead of over HTTP, so a local room's assets live in the person's own
 * Documents folder. Used by agent-share.ts when HARBOR_WB_FILES_DIR is set (local mode). Behaviour mirrors the share's contract:
 * a ref is `<folder>/<name>`; an upload NEVER overwrites (a collision is saved as name-1.ext); a listing is NEWEST FIRST with mtime in
 * unix seconds; a move never overwrites; nothing is ever deleted (removal is a move into rooms/_removed).
 *
 * LAYOUT: a room's folder `rooms/<slug>-<id8>` holds its assets in `rooms/<slug>-<id8>/assets/` on disk (Part A layout, with notes and
 * history beside it), while the REF stays `rooms/<slug>-<id8>/<name>` so no caller changes. `rooms/_removed` is flat.
 *
 * SAFETY: a ref is data from a client. It is refused if it is absolute, has a `..` or empty segment, a backslash, a NUL, or resolves
 * (after symlinks) outside the root. Pure fs with the root passed in; no globals. */
import { constants as fsc, copyFileSync, createReadStream, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, sep } from 'node:path';

/* NOTE: erasable TypeScript only (no parameter properties, no enums): agent-share.ts imports this file and test/agent-share-config.test.mjs
   loads agent-share.ts with Node's own type stripping, which refuses anything else. */
export class RefError extends Error {
  readonly status: 400 | 404;
  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.name = 'RefError';
    this.status = status;
  }
}

const ASSETS = 'assets';

/** Windows will not make (or will quietly mangle) these: reserved device names with or without an extension, `:` (an alternate data
 *  stream), `<>"|?*`, control characters, and a trailing dot or space. Refused everywhere, on every OS, so a folder that syncs to a
 *  Windows PC can always be opened there. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$|^(conin|conout)\$$/i;
export function badSegment(seg: string): boolean {
  return seg === '' || seg === '.' || seg === '..' || /[<>:"|?*\\\u0000-\u001f]/.test(seg) || /[. ]$/.test(seg) || WIN_RESERVED.test(seg);
}

/** The longest full path the store will create: Windows stops at 260, and sync tools add a suffix. */
export const MAX_PATH_CHARS = 240;

function segments(ref: string): string[] {
  if (typeof ref !== 'string' || ref === '' || ref.includes('\0') || ref.includes('\\') || ref.startsWith('/') || /^[A-Za-z]:/.test(ref)) {
    throw new RefError('not a file store path');
  }
  const parts = ref.split('/');
  if (parts.some(badSegment)) {
    throw new RefError('not a file store path (a name Windows cannot keep: a reserved name, a colon, <>"|?*, or a trailing dot or space)');
  }
  return parts;
}

/** The folder on disk for a store FOLDER ref (rooms/<room> gets its assets/ subfolder; everything else maps 1:1). */
export function folderOnDisk(root: string, folder: string): string {
  const parts = segments(folder);
  const isRoomFolder = parts.length === 2 && parts[0] === 'rooms' && parts[1] !== '_removed';
  return join(root, ...parts, ...(isRoomFolder ? [ASSETS] : []));
}

/** A room's notes folder on disk (`rooms/<name>-<id8>/notes`), for the read-only note copies. */
export function notesDirOnDisk(root: string, roomFolder: string): string {
  const parts = segments(roomFolder);
  if (!(parts.length === 2 && parts[0] === 'rooms' && parts[1] !== '_removed')) {
    throw new RefError('not a room folder');
  }
  return join(root, ...parts, 'notes');
}

/** A room's history folder on disk (`rooms/<name>-<id8>/history`), for the chat-history export. */
export function historyDirOnDisk(root: string, roomFolder: string): string {
  const parts = segments(roomFolder);
  if (!(parts.length === 2 && parts[0] === 'rooms' && parts[1] !== '_removed')) {
    throw new RefError('not a room folder');
  }
  return join(root, ...parts, 'history');
}

/** Write a new file in `dir` ONLY if no file of that name exists (the export never rewrites): 'written' or 'exists'. Whole file or nothing. */
export function writeNew(root: string, dir: string, name: string, content: string): 'written' | 'exists' {
  if (!name || name !== basename(name) || badSegment(name)) {
    throw new RefError('a file name is a bare basename Windows can keep');
  }
  checkLength(join(dir, name));
  ensureDirInsideRoot(root, dir);
  const target = join(dir, name);
  if (existsSync(target)) {
    return 'exists';
  }
  const tmp = join(dir, `.${name}.part-${process.pid}`);
  writeFileSync(tmp, content, { flag: 'w' });
  try {
    createExclusive(tmp, target);
    return 'written';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return 'exists';
    }
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The file on disk for a REF (`<folder>/<name>`). */
export function fileOnDisk(root: string, ref: string): string {
  const parts = segments(ref);
  if (parts.length < 2) {
    throw new RefError('a ref is <folder>/<name>');
  }
  const name = parts[parts.length - 1];
  return join(folderOnDisk(root, parts.slice(0, -1).join('/')), name);
}

/** Refuse anything that, after symlinks, is not inside the root. Only called for paths that exist. */
function insideRoot(root: string, p: string): boolean {
  const r = realpathSync(root);
  const real = realpathSync(p);
  return real === r || real.startsWith(r + sep);
}

/** Make `dir` (and its parents) only after proving the deepest folder that already exists is inside the root once symlinks and junctions
 *  are resolved: a folder inside the root that points elsewhere must not get directories created at its target. */
export function ensureDirInsideRoot(root: string, dir: string): void {
  mkdirSync(root, { recursive: true }); // the files folder the person chose; it may not exist yet on a fresh start
  let probe = dir;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) {
      throw new RefError('not a file store path');
    }
    probe = up;
  }
  if (!insideRoot(root, probe)) {
    throw new RefError('not a file store path');
  }
  mkdirSync(dir, { recursive: true });
  if (!insideRoot(root, dir)) {
    throw new RefError('not a file store path');
  }
}

function checkLength(p: string): void {
  if (p.length > MAX_PATH_CHARS) {
    throw new RefError(`the path is ${p.length} characters; the limit is ${MAX_PATH_CHARS} (use a shorter file name)`);
  }
}

/** Put `from` at `to` ONLY if nothing is there: a hard link (fails if the target exists), else an exclusive copy for file systems
 *  without links. Throws the OS error (code EEXIST) when the name was taken; the caller picks the next name. */
function createExclusive(from: string, to: string): void {
  try {
    linkSync(from, to);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw e;
    }
  }
  copyFileSync(from, to, fsc.COPYFILE_EXCL);
}

const mimeByExt: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf', '.zip': 'application/zip',
};
export const mimeOf = (name: string): string => mimeByExt[extname(name).toLowerCase()] ?? 'application/octet-stream';

export interface LocalEntry {
  name: string;
  path: string;
  size: number;
  /** unix seconds (float) */
  mtime: number;
}

/** The files of a folder, newest first; [] when it does not exist yet. */
export function listFolder(root: string, folder: string): LocalEntry[] {
  const dir = folderOnDisk(root, folder);
  if (!existsSync(dir)) {
    return [];
  }
  if (!insideRoot(root, dir)) {
    throw new RefError('not a file store path');
  }
  const out: LocalEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name.startsWith('~$')) {
      continue; // half-written temp files and sync-tool lock files are not assets
    }
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) {
      continue; // folders and symlinks are not assets
    }
    out.push({ name, path: `${folder}/${name}`, size: st.size, mtime: st.mtimeMs / 1000 });
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

/** `name`, or name-1.ext, name-2.ext... the first that is free in `dir`. */
function freeName(dir: string, name: string, skip = 0): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let seen = 0;
  for (let i = 0; i < 100000; i++) {
    const cand = i === 0 ? name : `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, cand))) {
      if (seen >= skip) {
        return cand;
      }
      seen++;
    }
  }
  throw new RefError('too many files with that name');
}

/** Save bytes into `folder` (made if missing), never overwriting. Answers the ref as stored. */
export function putFile(root: string, folder: string, name: string, bytes: Buffer): string {
  if (!name || name !== basename(name) || name.includes('/') || badSegment(name)) {
    throw new RefError('a file name is a bare basename Windows can keep');
  }
  if (name.startsWith('.') || name.startsWith('~$')) {
    throw new RefError('a file name cannot start with a dot or ~$ (those are hidden from the assets list)');
  }
  const dir = folderOnDisk(root, folder);
  checkLength(join(dir, `${name}-99999`));
  /* leave room for the day this file is removed: rooms/_removed/<room-folder>--<name> is longer than rooms/<room-folder>/assets/<name> */
  const roomFolder = folder.split('/')[1] ?? '';
  checkLength(join(root, 'rooms', '_removed', `${roomFolder}--${name}-99999`));
  ensureDirInsideRoot(root, dir);
  const tmp = join(dir, `.upload.part-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, bytes, { flag: 'wx' });
  try {
    for (let i = 0; i < 1000; i++) {
      const stored = freeName(dir, name, i);
      try {
        createExclusive(tmp, join(dir, stored)); // the name is claimed or we try the next; a file made in between is never replaced
        return `${folder}/${stored}`;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw e;
        }
      }
    }
    throw new RefError('too many files with that name');
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface LocalFile {
  path: string;
  size: number;
  type: string;
  stream: () => NodeJS.ReadableStream;
}

/** One ref's file; throws RefError(404) when it is not there. */
export function openRef(root: string, ref: string): LocalFile {
  const p = fileOnDisk(root, ref);
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new RefError('no such file', 404);
  }
  if (!st.isFile() || !insideRoot(root, p)) {
    throw new RefError('no such file', 404);
  }
  return { path: p, size: st.size, type: mimeOf(p), stream: () => createReadStream(p) };
}

/** Move one file into another folder (made if missing), never overwriting. Answers the new ref. A file moved into rooms/_removed keeps
 *  its origin in its name (`<room-folder>--<name>`), so it can be put back. */
export function moveRef(root: string, from: string, toDir: string): string {
  const srcParts = segments(from);
  const src = openRef(root, from).path;
  let name = basename(src);
  if (toDir === 'rooms/_removed' && srcParts.length === 3 && srcParts[0] === 'rooms' && srcParts[1] !== '_removed') {
    name = `${srcParts[1]}--${name}`;
  }
  const dir = folderOnDisk(root, toDir);
  checkLength(join(dir, `${name}-99999`));
  ensureDirInsideRoot(root, dir);
  for (let i = 0; i < 1000; i++) {
    const stored = freeName(dir, name, i);
    try {
      createExclusive(src, join(dir, stored));
      try {
        rmSync(src, { force: true });
      } catch {
        try {
          rmSync(src, { force: true }); // an antivirus scan or a preview may hold the file for a moment: once more
        } catch (e2) {
          rmSync(join(dir, stored), { force: true }); // undo: the file must not be in two places
          throw new RefError(`the file is in use and could not be moved (${(e2 as Error).message})`);
        }
      }
      return `${toDir}/${stored}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e;
      }
    }
  }
  throw new RefError('too many files with that name');
}
