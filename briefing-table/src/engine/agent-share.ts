/* ============================================================================
 * AGENT-SHARE CLIENT for room assets (room thin app #2) [ticket].
 *
 * agent-share is the VRPC drop box (harbor repo, `agent_share.py`, :8215):
 * open on the tailnet, NO auth by design, plain http. What it offers today,
 * and therefore all this module uses:
 *   - POST /api/upload?dir=<folder>&mkdir=1   multipart; NEVER overwrites (a
 *                                      collision is saved as name-1.ext);
 *                                      answers {ok, saved:[<ref>]}. `mkdir=1`
 *                                      is now honoured (harbor d06f6b6) — a
 *                                      missing folder is created rather than
 *                                      400 "target dir missing" — but the
 *                                      engine still handles that status for
 *                                      an older/unpatched share.
 *   - GET  /api/list?dir=<folder>     JSON, NEWEST FIRST by mtime: 200
 *                                      {dir, sig, entries:[{name, path,
 *                                      type:"file"|"dir", size (bytes; null
 *                                      for dirs), mtime (unix seconds,
 *                                      float), url (absolute raw URL; null
 *                                      for dirs)}]}; a missing dir is 404
 *                                      {"error":"no such dir"}.
 *   - GET  /raw/<ref>                 the bytes (content-type by extension).
 *   - POST /api/move {from, to_dir, mkdir}  move ONE file to another folder, never
 *                                      overwrites (name-1 on a collision); answers
 *                                      {ok, path}. No rename, no delete: the engine
 *                                      renames by copy + move-aside and removes by
 *                                      moving into REMOVED_DIR [scratch seen].
 *
 * WHY THE ENGINE IS IN THE PATH AT ALL: the room page is https (Serve), so an
 * <img> or fetch at http://…:8215 is mixed content; and the engine is where
 * the credential check and the room→folder mapping live.
 * ========================================================================== */

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import * as folderStore from './local-file-store.ts';
import { instancePath } from './data-dir.ts';

/** LOCAL MODE: when HARBOR_WB_FILES_DIR names a folder (the person's Documents\\agent-workbench), the store IS that folder and no
 *  HTTP share is used or needed. Read per call. */
export function filesRoot(): string | null {
  const v = (process.env.HARBOR_WB_FILES_DIR || '').trim();
  /* HOSTED: the room files are the engine's own folder (<files dir | data dir>/rooms/<room>/{notes,assets,files}); the open agent-share is never used */
  return v || (process.env.HARBOR_WB_HOSTED === '1' ? instancePath() : null);
}

export const SHARE_TIMEOUT_MS = Number(process.env.HARBOR_WB_AGENT_SHARE_TIMEOUT_MS) || 10_000;
const UPLOAD_TIMEOUT_MS = 6 * SHARE_TIMEOUT_MS;

/** Thrown when no file store is configured. There is no default address: a host that has not set one has no
 *  store, and says so, instead of reaching for somebody else's network. */
export class ShareNotConfigured extends Error {
  constructor(why = 'HARBOR_WB_AGENT_SHARE_URL is not set') {
    /* a HOSTED engine's person must never read an operator sentence or a variable name: the message is a fixed code the page words (the room files live in the engine's files tree there, so this means HARBOR_WB_FILES_DIR was not honoured) */
    if (process.env.HARBOR_WB_HOSTED === '1') {
      super('file-store-missing');
      this.name = 'ShareNotConfigured';
      return;
    }
    super(`The room file store is not set up (${why}). Set HARBOR_WB_AGENT_SHARE_URL to your file store's address (see contracts/asset-store.md) and restart the engine, or have the person type /set store <address> in a room.`);
    this.name = 'ShareNotConfigured';
  }
}

/** A store address checked: http(s) only, trailing slashes trimmed. Pure. */
export function parseShareAddress(raw: string): { ok: true; base: string } | { ok: false; error: string } {
  const r = raw.trim();
  let u: URL;
  try {
    u = new URL(r);
  } catch {
    return { ok: false, error: 'is not a URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'must start with http:// or https://' };
  }
  return { ok: true, base: r.replace(/\/+$/, '') };
}

/** The address a PERSON set with `/set store` (kept in the engine's settings; rooms.ts wires the reader). The environment
 *  variable wins over it, so an operator's setting is never silently overridden. */
let storedBase: () => string | null = () => null;
export function setStoredBase(fn: () => string | null): void {
  storedBase = fn;
}
/** Where the address in use comes from, for a status read. */
export function shareSource(): 'env' | 'setting' | 'folder' | 'none' {
  if (filesRoot()) {
    return 'folder';
  }
  if ((process.env.HARBOR_WB_AGENT_SHARE_URL || '').trim()) {
    return 'env';
  }
  return storedBase() ? 'setting' : 'none';
}

/** The share's base URL, read per call (a test points it at a stub). Throws ShareNotConfigured when it is unset
 *  or not an http(s) address. */
export function shareBase(): string {
  if (filesRoot()) {
    return pathToFileURL(filesRoot() as string).href.replace(/\/+$/, ''); // a folder store has no HTTP base; this is its address
  }
  const fromEnv = (process.env.HARBOR_WB_AGENT_SHARE_URL || '').trim();
  const raw = fromEnv || (storedBase() ?? '').trim();
  const name = fromEnv ? 'HARBOR_WB_AGENT_SHARE_URL' : 'the address set with /set store';
  if (!raw) {
    throw new ShareNotConfigured();
  }
  const p = parseShareAddress(raw);
  if (!p.ok) {
    throw new ShareNotConfigured(`${name} ${p.error}`);
  }
  return p.base;
}

/** Whether a file store is configured (for health and for routes that should answer 503 before they start). */
export function shareConfigured(): boolean {
  try {
    shareBase();
    return true;
  } catch {
    return false;
  }
}

const quotePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/** The agent-facing absolute URL of a ref (what agent-share's "copy url" gives). */
export function refUrl(ref: string): string {
  const root = filesRoot();
  if (root) {
    return pathToFileURL(folderStore.fileOnDisk(root, ref)).href; // agents are local processes: the file itself
  }
  return `${shareBase()}/raw/${quotePath(ref)}`;
}

/** The share's own browse page for a folder. */
export function folderUrl(folder: string): string {
  const root = filesRoot();
  if (root) {
    return pathToFileURL(folderStore.folderOnDisk(root, folder)).href;
  }
  return `${shareBase()}/${quotePath(folder)}/`;
}

/**
 * A client-supplied file name, reduced to a safe basename — the same rules as
 * agent-share's sanitize_name (so what we record is what it stores), plus
 * refusing `.`/`..` and capping the length. Null when nothing is left.
 */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const bs = String.fromCharCode(92);
  const base = raw.split(bs).join('/').split('/').pop() ?? '';
  let out = '';
  for (const ch of base) {
    const c = ch.codePointAt(0)!;
    out += c < 0x20 || c === 0x7f || '<>:"|?*'.includes(ch) ? '_' : ch;
  }
  out = out.trim();
  if (!out || out === '.' || out === '..' || out.length > 200) {
    return null;
  }
  return out;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/** A MIME type from a file name's extension (the share types files the same way). */
export function typeOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

/** The coarse tile kind (image|audio|video|text|file) the old HTML listing
 *  used to hand us per-entry. The JSON `/api/list` doesn't carry it, so it's
 *  derived from the same extension→MIME table `typeOf` uses. */
export function kindOf(name: string): string {
  const t = typeOf(name);
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('text/') || t === 'application/json') return 'text';
  return 'file';
}

export type UploadResult =
  | { ok: true; path: string }
  | { ok: false; status: number; error: string; field: string };

function multipart(name: string, type: string, bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----wbasset${randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Upload one file into `folder`. The ref it answers is AS STORED (name-1 on a collision). */
export async function upload(folder: string, name: string, type: string, bytes: Buffer): Promise<UploadResult> {
  const root = filesRoot();
  if (root) {
    try {
      return { ok: true, path: folderStore.putFile(root, folder, name, bytes) };
    } catch (e) {
      return { ok: false, status: e instanceof folderStore.RefError ? 400 : 500, error: `could not save to the files folder: ${(e as Error).message}`, field: 'file-store' };
    }
  }
  const { body, contentType } = multipart(name, type, bytes);
  let base: string;
  try {
    base = shareBase();
  } catch (e) {
    return { ok: false, status: 503, error: (e as Error).message, field: 'file-store' };
  }
  let r: Response;
  try {
    r = await fetch(`${base}/api/upload?dir=${encodeURIComponent(folder)}&mkdir=1`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 502, error: `could not reach agent-share: ${(e as Error).message}`, field: 'agent-share' };
  }
  const j = (await r.json().catch(() => null)) as { ok?: boolean; saved?: string[]; error?: string } | null;
  if (r.ok && j?.ok && Array.isArray(j.saved) && typeof j.saved[0] === 'string') {
    return { ok: true, path: j.saved[0] };
  }
  if (r.status === 400 && j?.error === 'target dir missing') {
    return {
      ok: false,
      status: 502,
      error: `agent-share has no folder "${folder}" and cannot create one over HTTP yet — create it under the share root on the VRPC`,
      field: 'folder',
    };
  }
  return { ok: false, status: 502, error: `agent-share refused the upload (${r.status}): ${j?.error ?? 'no detail'}`, field: 'agent-share' };
}

export interface ShareEntry {
  /** The ref, `<folder>/<name>`. */
  path: string;
  name: string;
  /** Derived from the extension (`kindOf`): image | audio | video | text | file. */
  kind: string;
  /** Exact bytes, from the JSON listing. */
  size: number | null;
  /** Unix seconds (float), from the JSON listing. */
  mtime: number;
}

interface ListApiEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
  mtime: number;
  url: string | null;
}

/** The files in `folder`, newest first; [] when the folder does not exist yet.
 *  Throws (message says why) when the share cannot be read — could-not-tell,
 *  never an empty list. */
export async function list(folder: string): Promise<ShareEntry[]> {
  const root = filesRoot();
  if (root) {
    return folderStore.listFolder(root, folder).map((e) => ({ path: e.path, name: e.name, kind: kindOf(e.name), size: e.size, mtime: e.mtime }));
  }
  const r = await fetch(`${shareBase()}/api/list?dir=${encodeURIComponent(folder)}`, {
    signal: AbortSignal.timeout(SHARE_TIMEOUT_MS),
  });
  if (r.status === 404) {
    return [];
  }
  if (!r.ok) {
    throw new Error(`agent-share listing answered ${r.status}`);
  }
  const j = (await r.json().catch(() => null)) as { entries?: ListApiEntry[] } | null;
  if (!j || !Array.isArray(j.entries)) {
    throw new Error('agent-share listing answered no entries');
  }
  return j.entries
    .filter((e) => e.type === 'file')
    .map((e) => ({ path: e.path, name: e.name, kind: kindOf(e.name), size: e.size, mtime: e.mtime }));
}

/** GET/HEAD one ref's bytes (the caller streams `body`). The timeout covers
 *  the wait for HEADERS only: a large file may take longer than that to move. */
export async function fetchRaw(ref: string, method: 'GET' | 'HEAD'): Promise<Response> {
  const root = filesRoot();
  if (root) {
    try {
      const f = folderStore.openRef(root, ref);
      const headers = { 'content-type': f.type, 'content-length': String(f.size) };
      return new Response(method === 'HEAD' ? null : (Readable.toWeb(f.stream() as Readable) as unknown as ReadableStream), { status: 200, headers });
    } catch (e) {
      return new Response(null, { status: e instanceof folderStore.RefError ? e.status : 500 });
    }
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`agent-share silent for ${SHARE_TIMEOUT_MS} ms`)), SHARE_TIMEOUT_MS);
  try {
    return await fetch(refUrl(ref), { method, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Where a removed room asset goes: recoverable by hand, never deleted [scratch seen]. */
export const REMOVED_DIR = 'rooms/_removed';

/** Move one file to another folder (made if missing). Answers the new ref. */
export async function move(from: string, toDir: string): Promise<{ ok: true; path: string } | { ok: false; status: number; error: string }> {
  const root = filesRoot();
  if (root) {
    try {
      return { ok: true, path: folderStore.moveRef(root, from, toDir) };
    } catch (e) {
      return { ok: false, status: e instanceof folderStore.RefError ? e.status : 500, error: `could not move in the files folder: ${(e as Error).message}` };
    }
  }
  let base: string;
  try {
    base = shareBase();
  } catch (e) {
    return { ok: false, status: 503, error: (e as Error).message };
  }
  let r: Response;
  try {
    r = await fetch(`${base}/api/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to_dir: toDir, mkdir: true }),
      signal: AbortSignal.timeout(SHARE_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 502, error: `could not reach agent-share: ${(e as Error).message}` };
  }
  const j = (await r.json().catch(() => null)) as { ok?: boolean; path?: string; error?: string } | null;
  if (r.ok && j?.ok && typeof j.path === 'string') {
    return { ok: true, path: j.path };
  }
  return { ok: false, status: r.status === 404 ? 404 : 502, error: `agent-share refused the move (${r.status}): ${j?.error ?? 'no detail'}` };
}
