/**
 * PLUGIN ZIP READER (src/server/modules/plugin-zip.ts; ported from workbench-app test/plugin-zip.test.mjs and plugin-zip-proof.test.mjs): the zip reader,
 * pure plus node:zlib. It reads only what it can prove: the central directory, stored and deflated entries, sizes and CRCs that match, names that stay
 * inside the plugin's folder on Windows and Linux alike. Every refusal is named so the screen can say it in plain words. The engine's caps are the web
 * values (20 MB packed, 50 MB unpacked, 500 entries; P11 below).
 */
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readZip, LIMITS, cleanName } from '../src/server/modules/plugin-zip.ts';
import { makeZip, type MakeEntry } from './fixtures/make-zip.ts';
import { zip, type HostileRow } from './fixtures/plugin-hostile-zip.ts';
import { checkPlugin } from '../src/server/modules/plugin-check.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}
const verdict = (r: ReturnType<typeof readZip>): [boolean, string | undefined] => [r.ok, r.ok ? undefined : r.reason];
const reasonOf = (r: ReturnType<typeof readZip>): string | undefined => (r.ok ? undefined : r.reason);

const good = (): Buffer => makeZip([
  { name: 'hello/' },
  { name: 'hello/module.json', data: '{"id":"hello"}' },
  { name: 'hello/ui/page.html', data: '<p>hi</p>'.repeat(50) },
  { name: 'hello/raw.txt', data: 'stored', method: 'store' },
]);

console.log('\n[the engine\'s caps are the web values]');
same({ entries: LIMITS.entries, packedBytes: LIMITS.packedBytes, unpackedBytes: LIMITS.unpackedBytes, ratio: LIMITS.ratio, ratioFloor: LIMITS.ratioFloor },
  { entries: 500, packedBytes: 20 * 1024 * 1024, unpackedBytes: 50 * 1024 * 1024, ratio: 100, ratioFloor: 4 * 1024 }, 'LIMITS');
ok(Object.isFrozen(LIMITS), 'LIMITS is frozen');

console.log('\n[a good zip: entries in order, folders marked, bytes inflated and checked]');
{
  const r = readZip(good());
  ok(r.ok === true, 'reads');
  if (r.ok) {
    same(r.entries.map((e) => [e.path, e.dir]), [['hello', true], ['hello/module.json', false], ['hello/ui/page.html', false], ['hello/raw.txt', false]], 'paths and folder marks');
    ok(r.entries[2].data!.toString() === '<p>hi</p>'.repeat(50), 'deflated bytes');
    ok(r.entries[3].data!.toString() === 'stored', 'stored bytes');
    ok(r.entries[0].data === null, 'a folder has no data');
    ok(r.unpackedBytes === 14 + 450 + 6, 'unpacked total');
  }
}

console.log('\n[refusals of the container, each named]');
for (const [what, buf, reason] of [
  ['not a buffer', 'zip', 'not-a-zip'],
  ['empty', Buffer.alloc(0), 'not-a-zip'],
  ['random bytes', Buffer.alloc(100, 7), 'not-a-zip'],
  ['zip64', makeZip([{ name: 'a.txt', data: 'x' }], { zip64: true }), 'zip64'],
  ['split across disks', makeZip([{ name: 'a.txt', data: 'x' }], { disk: 1 }), 'multi-disk'],
  ['count that lies', makeZip([{ name: 'a.txt', data: 'x' }], { count: 2 }), 'corrupt'],
  ['an empty zip', makeZip([]), 'empty'],
] as const) same(verdict(readZip(buf)), [false, reason], what);

console.log('\n[refusals of entries: encrypted, unknown method, symlink, lying size or CRC, local name mismatch]');
for (const [what, entries, reason] of [
  ['encrypted', [{ name: 'a.txt', data: 'x', flags: 1 }], 'encrypted'],
  ['bzip2', [{ name: 'a.txt', data: 'x', method: 'bzip' }], 'method'],
  ['symlink', [{ name: 'a', data: '/etc/passwd', mode: 0o120777, method: 'store' }], 'link'],
  ['device', [{ name: 'a', data: '', mode: 0o20644, method: 'store' }], 'link'],
  ['size lies', [{ name: 'a.txt', data: 'hello', size: 3 }], 'corrupt'],
  ['size claims more than the stream holds', [{ name: 'a.txt', data: 'hello', size: 4000 }], 'corrupt'], // under the ratio floor, so the size check itself answers
  ['a stored entry whose size lies', [{ name: 'a.txt', data: 'hello', size: 3, method: 'store' }], 'corrupt'],
  ['crc lies', [{ name: 'a.txt', data: 'hello', crc: 1 }], 'corrupt'],
  ['local name differs', [{ name: 'a.txt', localName: '../a.txt', data: 'x' }], 'corrupt'],
] as ReadonlyArray<readonly [string, MakeEntry[], string]>) same(verdict(readZip(makeZip(entries))), [false, reason], what);

console.log('\n[names that would leave the folder or break on Windows are refused]');
for (const name of ['../a.txt', 'a/../../b', '/etc/x', '\\x', 'a\\b.txt', 'C:/x', 'c:x', 'a/./b', 'a//b', 'nul\u0000.txt', 'tab\t.txt',
  'CON', 'a/aux.js', 'lpt1.txt', 'COM9', 'name.', 'name ', 'a<b', 'a|b', 'a?b', 'a*b', 'a"b', 'a:b', 'x'.repeat(201)]) {
  same(verdict(readZip(makeZip([{ name, data: 'x' }]))), [false, 'bad-name'], JSON.stringify(name));
}
ok(cleanName('a/b.txt')?.path === 'a/b.txt' && cleanName('a/')?.dir === true && cleanName('') === null, 'cleanName: a file, a folder, nothing');

console.log('\n[two names that are the same file on Windows (case, Unicode form) or a file under a file are refused]');
for (const pair of [['Read.md', 'read.MD'], ['caf\u00e9.txt', 'cafe\u0301.txt'], ['a', 'a/b.txt'], ['a/b.txt', 'A']]) {
  same(verdict(readZip(makeZip(pair.map((name) => ({ name, data: 'x' }))))), [false, 'name-clash'], pair.join(' / '));
}

console.log('\n[size caps: entries, packed, unpacked, and a bomb by ratio]');
{
  const many = makeZip(Array.from({ length: 501 }, (_, i) => ({ name: 'f' + i, data: '', method: 'store' as const })));
  ok(reasonOf(readZip(many)) === 'too-many-files', '501 entries, over the default 500');
  ok(reasonOf(readZip(good(), { packedBytes: 100 })) === 'too-big', 'packed over a lowered cap');
  ok(reasonOf(readZip(good(), { unpackedBytes: 100 })) === 'too-big', 'unpacked over a lowered cap');
  const bomb = makeZip([{ name: 'z.bin', data: Buffer.alloc(3 * 1024 * 1024) }]);
  ok(reasonOf(readZip(bomb)) === 'bomb', 'a 3 MiB run of zeros');
  const text = makeZip([{ name: 'z.js', data: Buffer.from(Array.from({ length: 3000 }, (_, i) => 'const v' + i + ' = ' + i * 7 + ';').join('\n')) }]);
  ok(readZip(text).ok === true, 'ordinary code compresses far less than 100x');
}

console.log('\n[P11: the engine\'s zip caps, total unpacked and entry count, refused with their reasons]');
{
  const entry = (n: number): MakeEntry => ({ name: 'f' + n, data: '', method: 'store' });
  ok(readZip(makeZip(Array.from({ length: 500 }, (_, i) => entry(i)))).ok === true, '500 entries are fine');
  same(verdict(readZip(makeZip(Array.from({ length: 501 }, (_, i) => entry(i))))), [false, 'too-many-files'], '501 entries: too-many-files');
  same(verdict(readZip(makeZip(Array.from({ length: 2001 }, (_, i) => entry(i))))), [false, 'too-many-files'], '2001 entries (the app\'s old cap): too-many-files');
  ok(reasonOf(readZip(makeZip(Array.from({ length: 6 }, (_, i) => entry(i))), { entries: 5 })) === 'too-many-files', 'a lowered entries cap');
  ok(readZip(makeZip(Array.from({ length: 5 }, (_, i) => entry(i))), { entries: 5 }).ok === true, 'at a lowered entries cap it passes');

  // 52 MB of one-bit noise (a 1 MiB block repeated, so building it is quick): it deflates to an eighth or so (ratio ~8, far under the bomb ratio of
  // 100), so the packed zip stays under 20 MB and only the total unpacked size can refuse it
  const MB = 1024 * 1024;
  const noise = (n: number): Buffer => { const one = randomBytes(MB); for (let i = 0; i < MB; i++) one[i] &= 1; return Buffer.concat(Array.from({ length: Math.ceil(n / MB) }, () => one)).subarray(0, n); };
  const big = makeZip([{ name: 'a.bin', data: noise(26 * MB), level: 1 }, { name: 'b.bin', data: noise(26 * MB), level: 1 }]);
  ok(big.length < LIMITS.packedBytes, 'the packed zip is under the 20 MB packed cap (' + big.length + ' bytes)');
  same(verdict(readZip(big)), [false, 'too-big'], '52 MB unpacked in total: too-big');
  const justUnder = makeZip([{ name: 'a.bin', data: noise(1 * MB) }]);
  ok(readZip(justUnder, { unpackedBytes: 1 * MB }).ok === true, 'a 1 MiB entry passes a 1 MiB unpacked cap');
  ok(reasonOf(readZip(justUnder, { unpackedBytes: 1 * MB - 1 })) === 'too-big', 'and not a cap one byte lower');
  ok(reasonOf(readZip(Buffer.alloc(20 * MB + 1))) === 'too-big', 'a buffer over 20 MB packed: too-big, before any parsing');
  ok(reasonOf(readZip(Buffer.alloc(20 * MB))) === 'not-a-zip', 'a 20 MB buffer is read (and is not a zip)');
}

console.log('\n[the declared size is never trusted for inflating: a stream that inflates past it is refused]');
same(verdict(readZip(makeZip([{ name: 'a.txt', data: 'x'.repeat(5000), size: 10 }]))), [false, 'corrupt'], 'inflates past its declared size');

console.log('\n[names are NFC on the way out]');
{
  const r = readZip(makeZip([{ name: 'cafe\u0301.txt', data: 'x' }]));
  ok(r.ok && r.entries[0].path === 'caf\u00e9.txt', 'NFC');
}

console.log('\n[review: superscript device names are reserved on Windows too (COM1, LPT2)]');
for (const name of ['COM\u00b9.txt', 'lpt\u00b2', 'a/com\u00b3.js']) ok(reasonOf(readZip(makeZip([{ name, data: 'x' }]))) === 'bad-name', name);

console.log('\n[review: a local header must agree with the central one (flags, method, CRC, sizes), a data descriptor only zeroes them]');
for (const [what, local] of [
  ['local flags say encrypted', { flags: 0x0801 }],
  ['local method differs', { method: 99 }],
  ['local CRC differs', { crc: 12345 }],
  ['local packed size differs', { packed: 1 }],
  ['local size differs', { size: 1 }],
] as const) ok(reasonOf(readZip(makeZip([{ name: 'a.txt', data: 'hello', local }]))) === 'corrupt', what);
ok(readZip(makeZip([{ name: 'a.txt', data: 'hello', flags: 0x08, descriptor: true, local: { flags: 0x0808, crc: 0, packed: 0, size: 0 } }])).ok === true, 'a streamed zip (macOS) with a data descriptor reads, sizes from the central directory');

console.log('\n[review: the central directory must be exactly where and as large as the end record says, and ZIP64 extra fields are refused]');
ok(reasonOf(readZip(makeZip([{ name: 'a.txt', data: 'x' }], { cdSize: 0 }))) === 'corrupt', 'cdSize 0');
ok(reasonOf(readZip(makeZip([{ name: 'a.txt', data: 'x' }], { cdSize: 200 }))) === 'corrupt', 'cdSize 200');
{
  const z64 = Buffer.from([0x01, 0x00, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
  ok(reasonOf(readZip(makeZip([{ name: 'a.txt', data: 'x', extra: z64 }]))) === 'zip64', 'a central ZIP64 extra');
  ok(reasonOf(readZip(makeZip([{ name: 'a.txt', data: 'x', localExtra: z64 }]))) === 'zip64', 'a local ZIP64 extra');
}

console.log('\n[review: the 100x ratio applies to every entry over 4 KiB (the plan states the threshold)]');
ok(LIMITS.ratioFloor === 4 * 1024, 'the floor is 4 KiB');
ok(reasonOf(readZip(makeZip([{ name: 'z.bin', data: Buffer.alloc(128 * 1024) }]))) === 'bomb', '128 KiB of zeros');
ok(readZip(makeZip([{ name: 'z.bin', data: Buffer.alloc(4 * 1024) }])).ok === true, 'at the floor itself it is fine');

console.log('\n[proof: a data descriptor is checked, never believed]');
const row: HostileRow = { name: 'data.txt', data: 'hello', flags: 8, localCrc: 0, localPacked: 0, localSize: 0 };
for (const [name, edit] of Object.entries<Partial<HostileRow>>({ missing: {}, truncated: { descriptor: { truncate: 11 } }, crc: { descriptor: { crc: 1 } }, packed: { descriptor: { packed: 1 } }, size: { descriptor: { size: 1 } } })) {
  ok(readZip(zip([{ ...row, ...edit }])).ok === false, `descriptor refuses ${name}`);
}
for (const signed of [true, false]) for (const method of [0, 8]) for (const flags of [8, 0x808]) {
  const r = readZip(zip([{ ...row, method, flags, descriptor: { signed } }, { name: 'next', data: 'safe' }]));
  ok(r.ok && r.entries[0].data!.toString() === 'hello' && r.entries[1].data!.toString() === 'safe', `valid descriptor signed=${signed} method=${method} flags=${flags}`);
}
ok(readZip(zip([row, { name: 'next', data: 'safe' }])).ok === false, 'a descriptor cannot borrow the next local header');
ok(readZip(zip([{ ...row, descriptor: { truncate: 15 } }])).ok === false, 'a descriptor cannot borrow the central directory');
for (let bit = 0; bit < 16; bit++) {
  ok(readZip(zip([{ name: 'a', data: 'hello', flags: 0x800, localFlags: 0x800 ^ (1 << bit) }])).ok === false, `local/central flags must agree at bit ${bit}`);
  if (bit !== 3 && bit !== 11) ok(readZip(zip([{ name: 'a', flags: 1 << bit }])).ok === false, `unsupported flag bit ${bit} refused even when headers agree`);
}
for (const size of [4095, 4096, 4097]) {
  const r = readZip(zip([{ name: 'a', data: Buffer.alloc(size), method: 8 }]));
  ok(r.ok === (size <= 4096) && (size <= 4096 || reasonOf(r) === 'bomb'), `ratio floor at ${size} bytes`);
}
{
  const b = zip([{ name: 'a', data: Buffer.alloc(4096), method: 8 }]);
  ok(reasonOf(readZip(b, { unpackedBytes: 4095 })) === 'too-big', 'the floor exemption never exempts the unpacked cap');
  ok(reasonOf(readZip(b, { packedBytes: b.length - 1 })) === 'too-big', '...nor the packed cap');
  ok(reasonOf(readZip(zip(Array.from({ length: 501 }, (_, i) => ({ name: String(i), data: '' }))))) === 'too-many-files', '...nor the entry cap');
}
{
  const plugin = (data: HostileRow[]) => {
    const z = readZip(zip([{ name: 'module.json', data: JSON.stringify({ id: 'review-plugin', class: 'status-monitor' }) }, ...data]));
    return z.ok ? checkPlugin(z.entries, { classes: new Set(['status-monitor']) }) : { ok: false as const, reason: z.reason };
  };
  for (const hex of ['4d5a', '7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca', '2321']) {
    ok((() => { const r = plugin([{ name: 'image.png', data: Buffer.from(hex + '0000', 'hex') }]); return !r.ok && r.reason === 'program'; })(), `program magic ${hex} hidden behind an image name refused`);
  }
  const assets: Array<[string, string | Buffer]> = [['ui.js', 'export {};'], ['ui.css', 'p{}'], ['ui.html', '<p>hi</p>'], ['data.json', '{}'], ['icon.svg', '<svg/>'], ['a.png', Buffer.from('89504e470d0a1a0a', 'hex')], ['a.woff2', 'wOF2'], ['a.ttf', Buffer.from('00010000', 'hex')]];
  ok(plugin(assets.map(([name, data]) => ({ name, data }))).ok === true, 'legitimate code, data, images and fonts remain accepted');
}
{
  const inner = zip([{ name: 'inner', data: 'inside' }]);
  const innerEnd = inner.readUInt32LE(inner.length - 6);
  const outer = zip([{ name: 'outer', data: inner.subarray(0, innerEnd) }, { name: 'inner', data: 'inside' }]);
  const cd = outer.readUInt32LE(outer.length - 6), second = cd + 46 + Buffer.byteLength('outer');
  outer.writeUInt32LE(30 + Buffer.byteLength('outer'), second + 42);
  ok(readZip(outer).ok === false, 'central entries cannot claim overlapping local header/body spans');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
