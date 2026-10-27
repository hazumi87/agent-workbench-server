/**
 * SCRATCHPAD IDS (row 10 / the design notes section 4): room_assets gets a stable 12-hex `asset_id` (minted at upload and by a one-time boot backfill,
 * NEVER on a GET) and an optional `batch_id` from the upload's x-batch header. A scratch table; nothing listens.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'wb-scratchids-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_FILES_DIR = join(dir, 'files');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

/* A table from BEFORE the columns existed, with an asset row, opened by the new code: the backfill gives it an id. */
const legacy = new Database(process.env.HARBOR_WB_TABLE);
legacy.exec(`CREATE TABLE room_assets (path TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL, added_by TEXT NOT NULL, added_at INTEGER NOT NULL)`);
legacy.prepare(`INSERT INTO room_assets VALUES ('rooms/old-12345678/a.png', 'room-old', 'a.png', 10, 'image/png', 'user', 1)`).run();
legacy.prepare(`INSERT INTO room_assets VALUES ('rooms/old-12345678/b.png', 'room-old', 'b.png', 11, 'image/png', 'user', 2)`).run();
legacy.close();

const { table } = await import('../src/table/endpoint.ts');

console.log('\n[a legacy table: the one-time backfill]');
const room = table.createRoom({ name: 'Ids', alias: 'ids' }, { actor: 'user' }).result;
const old = table.listAssetRecords('room-old');
ok(old.length === 2 && old.every((a: any) => /^[0-9a-f]{12}$/.test(a.asset_id)) && new Set(old.map((a: any) => a.asset_id)).size === 2, 'every old row got its own 12-hex asset_id at open');
const again = table.listAssetRecords('room-old');
ok(JSON.stringify(old.map((a: any) => a.asset_id).sort()) === JSON.stringify(again.map((a: any) => a.asset_id).sort()), '...and reading again mints nothing (ids are stable; never minted on a GET)');

console.log('\n[upload: mint at record time, keep it on a re-record, batch id from the header value]');
const r1 = table.recordAsset(room.id, { path: 'rooms/ids/a.png', name: 'a.png', size: 5, type: 'image/png', url: 'u', batchId: 'drop-1' }, { actor: 'user' }, true);
ok(/^[0-9a-f]{12}$/.test((r1.result as any).asset_id) && (r1.result as any).batch_id === 'drop-1', 'a new asset gets an id and its batch');
const id1 = (r1.result as any).asset_id;
const r1b = table.recordAsset(room.id, { path: 'rooms/ids/a.png', name: 'a.png', size: 6, type: 'image/png', url: 'u', batchId: 'drop-1' }, { actor: 'user' }, true);
ok((r1b.result as any).asset_id === id1, 'recording the SAME path again keeps its id (INSERT OR REPLACE would have lost it)');
const r2 = table.recordAsset(room.id, { path: 'rooms/ids/b.png', name: 'b.png', size: 5, type: 'image/png', url: 'u', batchId: 'drop-1' }, { actor: 'user' }, true);
const r3 = table.recordAsset(room.id, { path: 'rooms/ids/c.png', name: 'c.png', size: 5, type: 'image/png', url: 'u' }, { actor: 'user' }, true);
ok((r2.result as any).batch_id === 'drop-1' && (r3.result as any).batch_id === null, 'two files with one batch id share it; a file with none has null (its own batch)');
ok(new Set([id1, (r2.result as any).asset_id, (r3.result as any).asset_id]).size === 3, 'ids are unique');
for (const bad of ['', 'x'.repeat(65), 'has space', 'semi;colon', 'ü']) {
  const r = table.recordAsset(room.id, { path: `rooms/ids/bad-${Math.random()}.png`, name: 'bad.png', size: 1, type: 'image/png', url: 'u', batchId: bad }, { actor: 'user' }, true);
  ok((r.result as any).batch_id === null, `an invalid batch id is ignored: ${JSON.stringify(bad).slice(0, 20)}`);
}
console.log('\n[a move keeps the id]');
table.moveAssetRecord('rooms/ids/c.png', { path: 'rooms/ids/c-moved.png', room_id: room.id, name: 'c-moved.png' });
const moved = table.listAssetRecords(room.id).find((a: any) => a.path === 'rooms/ids/c-moved.png') as any;
ok(moved && moved.asset_id === (r3.result as any).asset_id, 'a renamed/moved asset keeps its asset_id');
console.log('\n[lookup by id]');
ok((table.assetById(id1) as any)?.path === 'rooms/ids/a.png' && table.assetById('0'.repeat(12)) === undefined && table.assetById('nothex') === undefined, 'assetById finds it, and an unknown or malformed id is undefined');
console.log('\n[the upload route: x-batch in, assetId and batchId out]');
const { Readable } = await import('node:stream');
const rooms = await import('../src/server/rooms.ts');
async function upload(name: string, batch?: string): Promise<any> {
  const q: any = Readable.from([Buffer.from('PNGDATA')]);
  q.method = 'POST'; q.url = `/api/rooms/${room.id}/assets`;
  q.headers = { authorization: 'Bearer t', 'x-filename': name, 'content-type': 'image/png', ...(batch !== undefined ? { 'x-batch': batch } : {}) };
  const out: any = { status: 0, body: null };
  const res = { writeHead(st: number) { out.status = st; }, setHeader() {}, end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } } };
  await rooms.handle(q, res as any, q.url, null, { projector: async () => (x: any) => x, log: () => {}, human: true });
  return out;
}
const u1 = await upload('one.png', 'drop-77');
const u2 = await upload('two.png', 'drop-77');
const u3 = await upload('three.png');
const u4 = await upload('four.png', 'bad batch!');
ok(u1.status === 200 && /^[0-9a-f]{12}$/.test(u1.body.assetId) && u1.body.batchId === 'drop-77' && u2.body.batchId === 'drop-77', 'two files with one x-batch share it, and each answer carries its assetId');
ok(u3.body.batchId === null && u4.body.batchId === null, 'no header, or an invalid one: no batch (its own)');
ok(new Set([u1.body.assetId, u2.body.assetId, u3.body.assetId, u4.body.assetId]).size === 4, 'four distinct ids');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
