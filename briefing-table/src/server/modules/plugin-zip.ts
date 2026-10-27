/* Plugin install, the zip reader (ported from workbench-app src/plugin-zip.js; the design notes step 1, the design notes M6). Pure
 * apart from node:zlib; no native module and no dependency. It trusts nothing it cannot check: the central directory is walked, every local header
 * must agree with it, only stored and deflated entries are read, inflating is capped at the declared size and the CRC must match. Names must stay
 * inside the plugin's folder on Windows as well as Linux (no traversal, drive, backslash, reserved device name, trailing dot or space, or two names
 * that are one file on a case-insensitive disk). Every refusal is a short reason the screen words. The engine's caps are the web values (20 MB
 * packed, 50 MB unpacked in total, 500 entries; the app had 50 MB, 200 MB and 2000); `over` lowers or raises them for a test. test/modules-plugin-zip.test.ts. */
import zlib from 'node:zlib';

export interface ZipLimits {
  entries: number;
  packedBytes: number;
  unpackedBytes: number;
  ratio: number;
  ratioFloor: number;
  nameLength: number;
}
export const LIMITS: Readonly<ZipLimits> = Object.freeze({ entries: 500, packedBytes: 20 * 1024 * 1024, unpackedBytes: 50 * 1024 * 1024, ratio: 100, ratioFloor: 4 * 1024, nameLength: 200 }); // ratio: any entry over ratioFloor (builder-three-2 [ref])
const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i; // Windows also reserves COM¹-³, LPT¹-³
const BAD_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\]/;

export type ZipReason =
  | 'not-a-zip' | 'zip64' | 'multi-disk' | 'empty' | 'too-many-files' | 'too-big' | 'corrupt' | 'encrypted' | 'method' | 'link' | 'bad-name' | 'name-clash' | 'bomb';
export type ZipEntry = { path: string; dir: true; data: null } | { path: string; dir: false; data: Buffer };
export type ZipResult = { ok: true; entries: ZipEntry[]; unpackedBytes: number } | { ok: false; reason: ZipReason };

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof native === 'function') return native(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[i] = c >>> 0; }
  }
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const fail = (reason: ZipReason): { ok: false; reason: ZipReason } => ({ ok: false, reason });
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A zip entry name → a clean relative path, or null. Folders end in '/'. */
export function cleanName(raw: string): { path: string; dir: boolean } | null {
  const isDir = raw.endsWith('/');
  const body = isDir ? raw.slice(0, -1) : raw;
  if (!body || body.length > LIMITS.nameLength || body.startsWith('/') || /^[A-Za-z]:/.test(body)) return null;
  const parts = body.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || BAD_CHARS.test(p) || RESERVED.test(p) || /[. ]$/.test(p)) return null;
  }
  return { path: body.normalize('NFC'), dir: isDir };
}

/** 'zip64' when an extra block carries a ZIP64 field, 'corrupt' when the blocks overrun, else null. */
function extraProblem(extra: Buffer): 'zip64' | 'corrupt' | null {
  let i = 0;
  while (i < extra.length) {
    if (i + 4 > extra.length) return 'corrupt';
    const id = extra.readUInt16LE(i), len = extra.readUInt16LE(i + 2);
    if (i + 4 + len > extra.length) return 'corrupt';
    if (id === 0x0001) return 'zip64';
    i += 4 + len;
  }
  return null;
}

function findEnd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === EOCD) return i;
  return -1;
}

/**
 * readZip(buffer, limits?) → {ok:true, entries:[{path, dir, data}], unpackedBytes} or {ok:false, reason}.
 * Reasons: not-a-zip, zip64, multi-disk, empty, too-many-files, too-big, corrupt, encrypted, method, link,
 * bad-name, name-clash, bomb.
 */
export function readZip(buf: unknown, over: Partial<ZipLimits> = {}): ZipResult {
  const L: ZipLimits = { ...LIMITS, ...over };
  if (!Buffer.isBuffer(buf) || buf.length < 22) return fail('not-a-zip');
  if (buf.length > L.packedBytes) return fail('too-big');
  const e = findEnd(buf);
  if (e < 0) return fail('not-a-zip');
  const disk = buf.readUInt16LE(e + 4), cdDisk = buf.readUInt16LE(e + 6);
  const nDisk = buf.readUInt16LE(e + 8), n = buf.readUInt16LE(e + 10);
  const cdSize = buf.readUInt32LE(e + 12), cdOff = buf.readUInt32LE(e + 16);
  if (n === 0xffff || nDisk === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) return fail('zip64');
  if (disk !== 0 || cdDisk !== 0 || nDisk !== n) return fail('multi-disk');
  if (n === 0) return fail('empty');
  if (n > L.entries) return fail('too-many-files');
  if (cdOff + cdSize !== e) return fail('corrupt'); // the directory ends exactly at the end record

  const entries: ZipEntry[] = [];
  const spans: Array<[number, number]> = []; // local header, body and any descriptor must own distinct bytes
  const seen = new Map<string, 'dir' | 'file'>(); // folded path → kind
  let total = 0;
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (p + 46 > e || buf.readUInt32LE(p) !== CEN) return fail('corrupt');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), packed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const made = buf.readUInt16LE(p + 4) >> 8, attr = buf.readUInt32LE(p + 38), off = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > e) return fail('corrupt');
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const extraBad = extraProblem(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (extraBad) return fail(extraBad);

    if (flags & 0x41) return fail('encrypted'); // bit 0 encrypted, bit 6 strong encryption
    if (flags & ~0x0808) return fail('corrupt'); // only descriptor and UTF-8 flags are supported
    if (method !== 0 && method !== 8) return fail('method');
    if (made === 3) { // unix: only regular files and folders
      const type = (attr >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) return fail('link');
    }
    let name: string;
    try { name = utf8.decode(rawName); } catch { return fail('bad-name'); }
    const clean = cleanName(name);
    if (!clean) return fail('bad-name');

    const fold = clean.path.toLowerCase();
    if (seen.has(fold)) return fail('name-clash');
    const parts = fold.split('/');
    for (let k = 1; k < parts.length; k++) if (seen.get(parts.slice(0, k).join('/')) === 'file') return fail('name-clash');
    if (!clean.dir) for (const key of seen.keys()) if (key.startsWith(fold + '/')) return fail('name-clash');
    seen.set(fold, clean.dir ? 'dir' : 'file');

    total += size;
    if (total > L.unpackedBytes) return fail('too-big');
    if (size > L.ratioFloor && size > packed * L.ratio) return fail('bomb');

    if (off + 30 > cdOff || buf.readUInt32LE(off) !== LOC) return fail('corrupt');
    const lNameLen = buf.readUInt16LE(off + 26), lExtraLen = buf.readUInt16LE(off + 28);
    if (!buf.subarray(off + 30, off + 30 + lNameLen).equals(rawName)) return fail('corrupt');
    // the local header must agree with the central one; a data descriptor (bit 3) only lets it carry zeros
    const lFlags = buf.readUInt16LE(off + 6), lMethod = buf.readUInt16LE(off + 8);
    const lCrc = buf.readUInt32LE(off + 14), lPacked = buf.readUInt32LE(off + 18), lSize = buf.readUInt32LE(off + 22);
    if (lFlags !== flags || lMethod !== method) return fail('corrupt');
    const agrees = (l: number, c: number): boolean => l === c || (flags & 0x08) !== 0 && l === 0;
    if (!agrees(lCrc, crc) || !agrees(lPacked, packed) || !agrees(lSize, size)) return fail('corrupt');
    if (off + 30 + lNameLen + lExtraLen > cdOff) return fail('corrupt');
    const lExtraBad = extraProblem(buf.subarray(off + 30 + lNameLen, off + 30 + lNameLen + lExtraLen));
    if (lExtraBad) return fail(lExtraBad);
    const start = off + 30 + lNameLen + lExtraLen;
    if (start + packed > cdOff) return fail('corrupt');
    const body = buf.subarray(start, start + packed);
    let end = start + packed;
    if (flags & 0x08) {
      // Central sizes bound the body. The descriptor is evidence to check, never a new size source.
      const matches = (at: number): boolean => at + 12 <= cdOff && buf.readUInt32LE(at) === crc
        && buf.readUInt32LE(at + 4) === packed && buf.readUInt32LE(at + 8) === size;
      if (end + 16 <= cdOff && buf.readUInt32LE(end) === 0x08074b50 && matches(end + 4)) end += 16;
      else if (matches(end)) end += 12; // unsigned form (including a CRC equal to the signature)
      else return fail('corrupt');
    }
    if (spans.some(([a, b]) => off < b && end > a)) return fail('corrupt');
    spans.push([off, end]);

    let data: Buffer;
    if (method === 0) {
      if (packed !== size) return fail('corrupt');
      data = Buffer.from(body);
    } else {
      try { data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, size) }); } catch { return fail('corrupt'); }
      if (data.length !== size) return fail('corrupt');
    }
    if (crc32(data) !== crc) return fail('corrupt');
    if (clean.dir && data.length) return fail('corrupt');
    entries.push(clean.dir ? { path: clean.path, dir: true, data: null } : { path: clean.path, dir: false, data });
  }
  if (p !== cdOff + cdSize) return fail('corrupt'); // the walked directory is exactly the declared size
  return { ok: true, entries, unpackedBytes: total };
}
