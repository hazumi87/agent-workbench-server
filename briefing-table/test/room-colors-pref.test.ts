/**
 * roomColors: the person's auto room colour assignments, per PERSON (room_user_prefs.room_colors), next to `tones`.
 * { <roomId>: <swatch index 0..11> }, per-key merge, null clears a key, bounded to 200 rooms, anything else a 400 naming roomColors.<id>.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-roomcolors-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';

const { table } = await import('../src/table/endpoint.ts');
const { validRoomColorsPatch, ROOM_COLORS_MAX } = await import('../src/engine/palette-prefs.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const refuses = (fn: () => unknown, field: RegExp, m: string): void => {
  try { fn(); ok(false, `${m} (accepted)`); } catch (e: any) { ok(field.test(String(e.field ?? '')) || field.test(String(e.message)), `${m} (${e.field ?? e.message})`); }
};
const R1 = 'dddddddd-0000-4000-8000-0000000000d2';
const R2 = 'dddddddd-0000-4000-8000-0000000000d1';

console.log('\n[validation]');
ok(JSON.stringify(validRoomColorsPatch({ [R1]: 0, [R2]: 11 })) === JSON.stringify({ [R1]: 0, [R2]: 11 }), '0 and 11 are the ends of the swatch range');
ok(validRoomColorsPatch({ [R1]: null })[R1] === null, 'null clears one room');
refuses(() => validRoomColorsPatch({ [R1]: 12 }), /roomColors/, '12 is out of range');
refuses(() => validRoomColorsPatch({ [R1]: -1 }), /roomColors/, '-1 is out of range');
refuses(() => validRoomColorsPatch({ [R1]: 1.5 }), /roomColors/, 'a fraction is refused');
refuses(() => validRoomColorsPatch({ [R1]: '3' }), /roomColors/, 'a string is refused');
refuses(() => validRoomColorsPatch({ 'not a room id!': 3 }), /roomColors/, 'a key that is not a room id is refused');
refuses(() => validRoomColorsPatch([1, 2]), /roomColors/, 'an array is refused');
refuses(() => validRoomColorsPatch(null), /roomColors/, 'null as a whole is refused (clear a room by sending its key as null)');

console.log('\n[store: merge, clear, bound]');
ok(Object.keys(table.getUserRoomColors('user')).length === 0, 'starts empty');
table.setUserRoomColors('user', { [R1]: 4 });
table.setUserRoomColors('user', { [R2]: 7 });
ok(table.getUserRoomColors('user')[R1] === 4 && table.getUserRoomColors('user')[R2] === 7, 'a patch merges per key');
table.setUserRoomColors('user', { [R1]: null });
ok(!(R1 in table.getUserRoomColors('user')) && table.getUserRoomColors('user')[R2] === 7, 'null clears only that room');
ok(Object.keys(table.getUserRoomColors('someone-else')).length === 0, 'per person');
const many: Record<string, number> = {};
for (let i = 0; i < ROOM_COLORS_MAX + 1; i++) many[`room-${i}`] = i % 12;
refuses(() => table.setUserRoomColors('user', many), /roomColors/, `more than ${ROOM_COLORS_MAX} rooms is refused`);
ok(Object.keys(table.getUserRoomColors('user')).length === 1, '...and nothing was written');
console.log('\n[the route: PATCH / GET /api/rooms/me, no identity session (local mode shape)]');
const { Readable } = await import('node:stream');
const rooms = await import('../src/server/rooms.ts');
async function call(method: string, body?: unknown): Promise<{ status: number; body: any }> {
  const q = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  q.method = method; q.url = '/api/rooms/me';
  q.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  const out = { status: 0, body: null as any };
  const res = { writeHead(s: number) { out.status = s; }, setHeader() {}, end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } } };
  await rooms.handle(q, res as any, '/api/rooms/me', null, { projector: async () => (x: any) => x, log: () => {}, human: true });
  return out;
}
let r = await call('PATCH', { roomColors: { [R1]: 9 } });
ok(r.status === 200 && r.body.roomColors?.[R1] === 9, 'PATCH roomColors answers 200 with the merged map');
r = await call('GET');
ok(r.status === 200 && r.body.roomColors?.[R1] === 9 && 'tones' in r.body, 'GET carries roomColors next to tones');
r = await call('PATCH', { roomColors: { [R1]: 99 } });
ok(r.status === 400 && /roomColors/.test(String(r.body?.field)), 'a bad swatch is a 400 naming the field');
r = await call('GET');
ok(r.body.roomColors?.[R1] === 9, '...and nothing changed');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
