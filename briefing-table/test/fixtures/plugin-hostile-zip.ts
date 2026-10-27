// Independent reviewer byte writer from [ref] (ported from workbench-app test/fixtures/plugin-hostile-zip.cjs); descriptor knobs added for positive and
// hostile controls. Unlike make-zip.ts it sets no UTF-8 flag and defaults to stored entries holding "x".
import zlib from 'node:zlib';

function crc32(b: Buffer): number {
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof native === 'function') return native(b) >>> 0;
  let c = 0xffffffff;
  for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}

export interface HostileDescriptor { signed?: boolean; crc?: number; packed?: number; size?: number; truncate?: number }
export interface HostileRow {
  name: string;
  localName?: string;
  data?: string | Buffer;
  method?: number;
  crc?: number;
  size?: number;
  extra?: Buffer;
  localExtra?: Buffer;
  flags?: number;
  localFlags?: number;
  localMethod?: number;
  localCrc?: number;
  localPacked?: number;
  localSize?: number;
  mode?: number;
  descriptor?: HostileDescriptor;
}

export function zip(rows: readonly HostileRow[], opts: { zip64?: boolean; cdSize?: number } = {}): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const r of rows) {
    const name = Buffer.from(r.name), ln = Buffer.from(r.localName ?? r.name), data = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data ?? 'x');
    const method = r.method ?? 0, body = method === 8 ? zlib.deflateRawSync(data) : data, crc = r.crc ?? crc32(data), size = r.size ?? data.length;
    const extra = r.extra ?? Buffer.alloc(0), le = r.localExtra ?? extra, l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt16LE(r.localFlags ?? r.flags ?? 0, 6); l.writeUInt16LE(r.localMethod ?? method, 8);
    l.writeUInt32LE(r.localCrc ?? crc, 14); l.writeUInt32LE(r.localPacked ?? body.length, 18); l.writeUInt32LE(r.localSize ?? size, 22); l.writeUInt16LE(ln.length, 26); l.writeUInt16LE(le.length, 28);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(r.flags ?? 0, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28); c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(((r.mode ?? 0o100644) * 65536) >>> 0, 38); c.writeUInt32LE(offset, 42);
    let descriptor: Buffer = Buffer.alloc(0);
    if (r.descriptor) {
      const d = r.descriptor, signed = d.signed !== false;
      descriptor = Buffer.alloc(signed ? 16 : 12); let at = 0;
      if (signed) { descriptor.writeUInt32LE(0x08074b50); at = 4; }
      descriptor.writeUInt32LE(d.crc ?? crc, at); descriptor.writeUInt32LE(d.packed ?? body.length, at + 4); descriptor.writeUInt32LE(d.size ?? size, at + 8);
      if (d.truncate !== undefined) descriptor = descriptor.subarray(0, d.truncate);
    }
    const local = Buffer.concat([l, ln, le, body, descriptor]); locals.push(local); centrals.push(c, name, extra); offset += local.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(opts.zip64 ? 0xffff : rows.length, 8); end.writeUInt16LE(opts.zip64 ? 0xffff : rows.length, 10); end.writeUInt32LE(opts.cdSize ?? cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
