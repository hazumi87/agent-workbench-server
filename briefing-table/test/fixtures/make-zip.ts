// A tiny zip writer for the plugin-zip tests (ported from workbench-app test/fixtures/make-zip.mjs): stored or deflated entries, with knobs to forge the bad
// cases (encrypted flag, symlink mode, a lying size, a local name that differs from the central one, zip64 markers).
import zlib from 'node:zlib';

function crc32(buf: Buffer): number {
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof native === 'function') return native(buf) >>> 0;
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

export interface MakeEntry {
  name: string;
  data?: string | Buffer;
  method?: 'store' | 'deflate' | 'bzip';
  /** zlib level for a deflated entry (default 6); a low level keeps a test with a very large entry quick */
  level?: number;
  flags?: number;
  mode?: number;
  size?: number;
  localName?: string;
  crc?: number;
  local?: { flags?: number; method?: number; crc?: number; packed?: number; size?: number };
  extra?: Buffer;
  localExtra?: Buffer;
  descriptor?: boolean;
}
export interface MakeOptions { comment?: string; count?: number; zip64?: boolean; disk?: number; cdSize?: number }

export function makeZip(entries: readonly MakeEntry[], { comment = '', count, zip64 = false, disk = 0, cdSize }: MakeOptions = {}): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const method = e.method === 'store' || e.name.endsWith('/') ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(data, e.level === undefined ? {} : { level: e.level }) : data;
    const name = Buffer.from(e.name, 'utf8');
    const lname = Buffer.from(e.localName ?? e.name, 'utf8');
    const flags = (e.flags ?? 0) | 0x0800;
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const L = e.local || {};
    const extra = e.extra || Buffer.alloc(0), lextra = e.localExtra || extra;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(L.flags ?? flags, 6); lh.writeUInt16LE(L.method ?? (e.method === 'bzip' ? 12 : method), 8);
    lh.writeUInt32LE(L.crc ?? crc, 14); lh.writeUInt32LE(L.packed ?? body.length, 18); lh.writeUInt32LE(L.size ?? size, 22); lh.writeUInt16LE(lname.length, 26); lh.writeUInt16LE(lextra.length, 28);
    const descriptor = e.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (e.descriptor) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(body.length, 8); descriptor.writeUInt32LE(size, 12); }
    locals.push(lh, lname, lextra, body, descriptor);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(e.method === 'bzip' ? 12 : method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(((e.mode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name, extra);
    offset += 30 + lname.length + lextra.length + body.length + descriptor.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const n = count ?? entries.length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(disk, 4);
  end.writeUInt16LE(zip64 ? 0xffff : n, 8); end.writeUInt16LE(zip64 ? 0xffff : n, 10);
  end.writeUInt32LE(cdSize ?? cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...locals, cd, end, Buffer.from(comment)]);
}
