/* ROOM FILES for the web UI (web-first pilot): a per-room folder on the server, owned by the person, served by the engine with sign-in. NEVER the open agent-share.
 *   <root>/<room-id>/{notes,assets,files}/...      root = HARBOR_WB_FILES_DIR/rooms, else <data-dir>/rooms
 *   GET    /api/rooms/:id/files?dir=notes|assets|files&sub=<relative>   -> {entries:[{name, kind, size, mtime, etag?}]}
 *   GET    /api/rooms/:id/files/<dir>/<relative>                        -> the bytes (ETag; nosniff; sandbox CSP; attachment unless text/image/pdf)
 *   PUT    /api/rooms/:id/files/<dir>/<relative>   raw body, max 50 MB   -> {name, size, mtime, etag}; an EXISTING file needs If-Match (428/412), a new one may send If-None-Match: *
 *   POST   /api/rooms/:id/files/<dir>   raw body + x-filename            -> an upload that never overwrites (name-1.ext); {name, size, mtime, etag}
 *   DELETE /api/rooms/:id/files/<dir>/<relative>   (optional If-Match)
 * Reads: any signed-in caller. Writes: a PERSON only. Names reject `..`, absolute paths, NUL, backslash and dot-files; a symlink can never lead out of the room's folder.
 * ETag is the quoted SHA-256 of the bytes (opaque to the client: echo it back). Files are created 0640 and folders 0750 so the person's agents (same group) read them natively. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { sendJson } from './http-util.ts';
import { table } from '../table/endpoint.ts';
import { instancePath } from '../engine/data-dir.ts';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DIRS = ['notes', 'assets', 'files'] as const;
const ROUTE = /^\/api\/rooms\/([^/]+)\/files(?:\/([^/]+))?(?:\/(.+))?$/;

export function filesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.HARBOR_WB_FILES_DIR ?? '').trim();
  return v ? join(v, 'rooms') : instancePath('rooms');
}

/** A relative path inside a room folder: no empty, `.`, `..`, absolute, NUL, backslash, dot-file segment, and not absurdly deep or long. */
export function cleanRel(rel: string): string[] | null {
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return null;
  const parts = rel.split('/').filter((p) => p !== '');
  if (parts.length === 0 || parts.length > 6) return null;
  for (const p of parts) {
    if (p === '.' || p === '..' || p.startsWith('.') || p.length > 200) return null;
  }
  return parts;
}

/* The ETag is the quoted SHA-256 of the file's bytes, so a same-size, same-timestamp rewrite still changes it. AUTHORITATIVE reads (a GET, a precondition, a write's answer) always hash the bytes; only a LISTING may reuse a hash
   cached by (path, size, mtime), and a client must not take its revision from a listing. */
const etagCache = new Map<string, string>();
function etagFor(abs: string, st: { size: number; mtimeMs: number }, listing = false): string {
  const key = `${abs}|${st.size}|${st.mtimeMs}`;
  const hit = listing ? etagCache.get(key) : undefined;
  if (hit) return hit;
  const tag = `"${createHash('sha256').update(readFileSync(abs)).digest('hex')}"`;
  if (listing) {
    if (etagCache.size > 5000) etagCache.clear();
    etagCache.set(key, tag);
  }
  return tag;
}
const person = (res: ServerResponse): void => void sendJson(res, 403, { error: 'person_only', message: 'only the signed-in person changes room files' });

function readLimited(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (d: Buffer) => {
      total += d.length;
      if (total > max) {
        over = true;
        chunks.length = 0;
        return; // keep draining so the 413 can be delivered
      }
      chunks.push(d);
    });
    req.on('end', () => (over ? reject(Object.assign(new Error(`file too large: ${total} bytes (max ${max})`), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const SAFE_INLINE: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.csv': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
};

/** The absolute folder for (room, dir), created on demand; a realpath check keeps it inside the room folder. */
function folderFor(roomId: string, dir: string, create: boolean): string | null {
  const base = join(filesRoot(), roomId, dir);
  if (create) {
    if (!insideRoom(roomId, base)) return null; // containment BEFORE any mkdir: a refusal leaves nothing behind
    mkdirSync(base, { recursive: true, mode: 0o750 });
  } else if (!existsSync(base)) return base;
  return base;
}
/** The real path of `p`, or, when part of it does not exist yet, the real path of its deepest existing ancestor plus the missing tail (no link can hide in a part that is not there). */
function realNear(p: string): string {
  const tail: string[] = [];
  let cur = p;
  while (!existsSync(cur)) {
    tail.unshift(basename(cur));
    cur = dirname(cur);
  }
  return join(realpathSync(cur), ...tail);
}
/** Is `abs` inside this room's folder? ANCHORED ABOVE the room folder: the room folder's expected real location is <real files root>/<room id>, so a room folder that was swapped for a symlink (its realpath is
 *  elsewhere) fails here, and so does any symlink below it that leads out. The deepest existing ancestor decides, so a check BEFORE a mkdir/write is possible and a refusal has no side effect. */
function insideRoom(roomId: string, abs: string): boolean {
  try {
    const rootReal = realNear(filesRoot());
    const anchor = join(rootReal, roomId);
    let probe = abs;
    while (!existsSync(probe)) probe = dirname(probe);
    const real = realpathSync(probe);
    if (real === anchor || real.startsWith(anchor + sep)) return true;
    // nothing of the room folder exists yet (the deepest existing ancestor is above it): fine if the path is lexically under the room folder, since there is no link to follow
    return (anchor === real || anchor.startsWith(real + sep)) && (abs === join(filesRoot(), roomId) || abs.startsWith(join(filesRoot(), roomId) + sep));
  } catch {
    return false;
  }
}

export async function handle(req: IncomingMessage, res: ServerResponse, route: string, deps: { human: boolean }): Promise<boolean> {
  const m = ROUTE.exec(route.split('?')[0]);
  if (!m) return false;
  const roomId = decodeURIComponent(m[1]);
  const dir = m[2] ? decodeURIComponent(m[2]) : null;
  const rest = m[3] ? decodeURIComponent(m[3]) : null;
  const method = req.method ?? 'GET';
  if (!table.getRoom(roomId)) {
    sendJson(res, 404, { error: 'no such room' });
    return true;
  }
  const q = new URL(req.url ?? '/', 'http://engine.local').searchParams;
  try {
    /* ---- list ---- */
    if (method === 'GET' && dir === null) {
      const d = q.get('dir') ?? 'files';
      if (!(DIRS as readonly string[]).includes(d)) {
        sendJson(res, 400, { error: `dir is one of ${DIRS.join(', ')}`, field: 'dir' });
        return true;
      }
      const sub = q.get('sub');
      let abs = join(filesRoot(), roomId, d);
      if (sub) {
        const parts = cleanRel(sub);
        if (!parts) {
          sendJson(res, 400, { error: 'bad sub path', field: 'sub' });
          return true;
        }
        abs = join(abs, ...parts);
      }
      if (!existsSync(abs)) {
        sendJson(res, 200, { entries: [] });
        return true;
      }
      if (!insideRoom(roomId, abs)) {
        sendJson(res, 403, { error: 'outside-room' });
        return true;
      }
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && (e.isFile() || e.isDirectory()))
        .map((e) => {
          const st = statSync(join(abs, e.name));
          return e.isDirectory()
            ? { name: e.name, kind: 'dir' as const, size: 0, mtime: Math.floor(st.mtimeMs) }
            : { name: e.name, kind: 'file' as const, size: st.size, mtime: Math.floor(st.mtimeMs), etag: etagFor(join(abs, e.name), st, true) };
        })
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
      sendJson(res, 200, { entries });
      return true;
    }
    if (dir === null || !(DIRS as readonly string[]).includes(dir)) {
      sendJson(res, 400, { error: `the folder is one of ${DIRS.join(', ')}`, field: 'dir' });
      return true;
    }
    /* ---- upload that never overwrites ---- */
    if (method === 'POST' && rest === null) {
      if (!deps.human) return person(res), true;
      const hn = req.headers['x-filename'];
      const rawName = typeof hn === 'string' ? decodeURIComponent(hn) : '';
      const parts = cleanRel(rawName);
      if (!parts || parts.length !== 1) {
        sendJson(res, 400, { error: 'x-filename is a plain file name', field: 'x-filename' });
        return true;
      }
      const body = await readLimited(req, MAX_FILE_BYTES);
      const folder = folderFor(roomId, dir, true);
      if (!folder) {
        sendJson(res, 403, { error: 'outside-room' });
        return true;
      }
      let target = join(folder, ...parts);
      if (!insideRoom(roomId, target)) {
        sendJson(res, 403, { error: 'outside-room' });
        return true;
      }
      for (let n = 1; existsSync(target); n++) {
        const ext = extname(parts[parts.length - 1]);
        const stem = basename(parts[parts.length - 1], ext);
        target = join(dirname(target), `${stem}-${n}${ext}`);
      }
      writeAtomic(target, body);
      const st = statSync(target);
      sendJson(res, 200, { name: basename(target), size: st.size, mtime: Math.floor(st.mtimeMs), etag: etagFor(target, st) });
      return true;
    }
    const parts = rest ? cleanRel(rest) : null;
    if (!parts) {
      sendJson(res, 400, { error: 'a file path is required', field: 'path' });
      return true;
    }
    const abs = join(filesRoot(), roomId, dir, ...parts);
    /* ---- read ---- */
    if (method === 'GET') {
      if (!existsSync(abs) || !insideRoom(roomId, abs)) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const st = statSync(abs);
      if (!st.isFile()) {
        sendJson(res, 404, { error: 'not a file' });
        return true;
      }
      const ext = extname(abs).toLowerCase();
      const type = SAFE_INLINE[ext];
      res.writeHead(200, {
        'content-type': type ?? 'application/octet-stream',
        'content-length': String(st.size),
        etag: etagFor(abs, st),
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
        'cache-control': 'no-store',
        ...(type ? {} : { 'content-disposition': `attachment; filename="${basename(abs).replace(/["\r\n]/g, '_')}"` }),
      });
      createReadStream(abs).pipe(res);
      return true;
    }
    if (!deps.human) return person(res), true;
    /* ---- write ---- */
    if (method === 'PUT') {
      const ifMatch = req.headers['if-match'];
      const ifNone = req.headers['if-none-match'];
      /* the precondition, evaluated twice: before the body (cheap refusal) and AGAIN after it, synchronously with the write — nothing awaits between that check and the rename, so two held requests with one ETag cannot both pass */
      const refused = (): boolean => {
        if (!existsSync(abs)) {
          if (typeof ifMatch !== 'string') return false; // a plain create
          sendJson(res, 412, { error: 'gone' }); // an editor holding a revision must not recreate a file that was deleted meanwhile
          return true;
        }
        const cur = etagFor(abs, statSync(abs));
        if (ifNone === '*') {
          sendJson(res, 412, { error: 'changed', etag: cur });
          return true;
        }
        if (typeof ifMatch !== 'string') {
          sendJson(res, 428, { error: 'precondition-required', etag: cur });
          return true;
        }
        if (ifMatch !== cur) {
          sendJson(res, 412, { error: 'changed', etag: cur });
          return true;
        }
        return false;
      };
      if (refused()) return true;
      const body = await readLimited(req, MAX_FILE_BYTES);
      if (refused()) return true;
      if (!insideRoom(roomId, abs)) {
        sendJson(res, 403, { error: 'outside-room' });
        return true;
      }
      mkdirSync(dirname(abs), { recursive: true, mode: 0o750 });
      writeAtomic(abs, body);
      const st = statSync(abs);
      sendJson(res, 200, { name: basename(abs), size: st.size, mtime: Math.floor(st.mtimeMs), etag: etagFor(abs, st) });
      return true;
    }
    /* ---- delete ---- */
    if (method === 'DELETE') {
      if (!existsSync(abs) || !insideRoom(roomId, abs)) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const ifMatch = req.headers['if-match'];
      if (typeof ifMatch === 'string' && ifMatch !== etagFor(abs, statSync(abs))) {
        sendJson(res, 412, { error: 'changed', etag: etagFor(abs, statSync(abs)) });
        return true;
      }
      rmSync(abs, { force: true });
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 413) {
      sendJson(res, 413, { error: (e as Error).message, max: MAX_FILE_BYTES });
      return true;
    }
    throw e;
  }
}

function writeAtomic(target: string, body: Buffer): void {
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, body, { mode: 0o640 });
  renameSync(tmp, target);
}
