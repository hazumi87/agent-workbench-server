/**
 * Room composer attachments — the scratchpad's store rows, bytes and TTL sweep,
 * and the pure agent-facing text [ticket].
 *
 *   - rows are found only within (person, room): another person's file id is
 *     simply not there, and neither is the same file under another room;
 *   - the per-draft count cap refuses with 413 and both numbers, writing nothing;
 *   - the sweep removes an ABANDONED draft (its newest file older than the TTL)
 *     whole, keeps a draft with recent activity, removes rows of a room that no
 *     longer exists, and removes a file on disk with no row once it is older
 *     than the orphan grace (never a young one, which may be mid-write);
 *   - agentBody: the text, then one line per file with the reference; an
 *     attachments-only message is the block alone.
 *
 * SAFETY: a temp db (HARBOR_WB_TABLE) and a temp scratch dir, set BEFORE the
 * modules are imported. No engine, no port.
 */
import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-scratch-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_ROOM_SCRATCH_DIR = join(dir, 'room-scratch');
process.env.HARBOR_WB_ROOM_SCRATCH_TTL_MS = String(60_000);
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_IDENTITY = 'legacy';

const { table, RoomError } = await import('../src/table/endpoint.ts');
const scratch = await import('../src/engine/room-scratch.ts');
const attach = await import('../src/engine/room-attach.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${msg}${a === b ? '' : ` (got ${a}, want ${b})`}`);
}

const room = table.createRoom({ name: 'Scratch Room' }, { actor: 'user' }).result;
const other = table.createRoom({ name: 'Other Room' }, { actor: 'user' }).result;
const add = (userKey: string, roomId: string, name = 'a.png'): string => {
  const id = scratch.newId();
  scratch.write(id, Buffer.from(`bytes of ${name}`));
  table.addRoomScratch({ id, userKey, roomId, name, type: 'image/png', size: 10 }, 10);
  return id;
};

console.log('\n[private to (person, room)]');
const f1 = add('alice', room.id);
eq(table.listRoomScratch('alice', room.id).map((f) => f.id), [f1], "alice's draft holds her file");
eq(table.listRoomScratch('bob', room.id), [], "bob's draft in the same room is empty");
eq(table.getRoomScratch('bob', room.id, f1), undefined, "bob cannot find alice's file by its id");
eq(table.getRoomScratch('alice', other.id, f1), undefined, 'nor can alice under another room');
eq(scratch.read(f1)?.toString(), 'bytes of a.png', 'the bytes are on disk under the scratch dir');
ok(!existsSync(join(dir, 'room-scratch', 'x')) && readdirSync(join(dir, 'room-scratch')).includes(f1), 'named by id only (no file name on disk)');

console.log('\n[count cap]');
for (let i = 0; i < 2; i++) {
  add('carol', room.id, `c${i}.png`);
}
try {
  table.addRoomScratch({ id: scratch.newId(), userKey: 'carol', roomId: room.id, name: 'c9.png', type: 'image/png', size: 1 }, 2);
  ok(false, 'a third file past a cap of 2 is refused');
} catch (e) {
  ok(e instanceof RoomError && e.status === 413, 'a third file past a cap of 2: 413');
  ok(/holds 2 files/.test((e as Error).message) && /limit is 2/.test((e as Error).message), 'with both numbers', );
}
eq(table.countRoomScratch('carol', room.id), 2, 'and nothing was written');

console.log('\n[the TTL sweep]');
const now = Date.now();
eq(scratch.sweep(now), { rows: 0, orphans: 0 }, 'nothing abandoned yet: nothing swept');
const stray = add('dave', 'no-such-room');
eq(scratch.sweep(now).rows, 1, 'a row for a room that no longer exists is swept at once');
eq(scratch.read(stray), null, '...with its file');
/* an orphan file (a crash between write and insert): young stays, old goes */
const young = scratch.newId();
const old = scratch.newId();
writeFileSync(join(dir, 'room-scratch', young), 'y');
writeFileSync(join(dir, 'room-scratch', old), 'o');
const past = (now - 2 * 60 * 60 * 1000) / 1000;
utimesSync(join(dir, 'room-scratch', old), past, past);
eq(scratch.sweep(now).orphans, 1, 'an orphan file older than the grace is swept');
ok(existsSync(join(dir, 'room-scratch', young)) && !existsSync(join(dir, 'room-scratch', old)), '...a young one (maybe mid-write) is kept');
eq(scratch.sweep(now + 59_000).rows, 0, 'inside the TTL: every draft is kept');
const before = table.listRoomScratch('alice', room.id).length + table.listRoomScratch('carol', room.id).length;
eq(scratch.sweep(now + 61_000).rows, before, 'past the TTL from the newest file: the abandoned drafts go whole');
eq([table.listRoomScratch('alice', room.id).length, table.listRoomScratch('carol', room.id).length], [0, 0], '...rows gone');
eq(scratch.read(f1), null, '...files gone');

console.log('\n[agentBody]');
const files = [
  { name: 'hero.png', path: 'rooms/r-1/hero.png', url: 'http://share/raw/rooms/r-1/hero.png', raw: '/x', type: 'image/png', size: 1_258_291 },
  { name: 'brief.pdf', path: 'rooms/r-1/brief.pdf', url: 'http://share/raw/rooms/r-1/brief.pdf', raw: '/y', type: 'application/pdf', size: 319_488 },
];
eq(
  attach.agentBody('here are the refs', files).split('\n'),
  [
    'here are the refs',
    'attachments (2, in room assets):',
    '[1] hero.png · image/png · 1.2 MB · http://share/raw/rooms/r-1/hero.png',
    '[2] brief.pdf · application/pdf · 312 KB · http://share/raw/rooms/r-1/brief.pdf',
  ],
  'the text, then one line per file, numbered [n] when there are 2+ (ticket): name · type · size · reference',
);
eq(attach.agentBody('', files.slice(0, 1)).split('\n')[0], 'attachments (1, in room assets):', 'attachments only: the block alone');
eq(attach.agentBody('', files.slice(0, 1)).split('\n')[1], '- hero.png · image/png · 1.2 MB · http://share/raw/rooms/r-1/hero.png', 'one file keeps the plain dash, no number (ticket)');
eq(attach.agentBody('', [{ ...files[0], kind: 'note', title: 'T' }, { ...files[1], sent_id: 'abc', title: 'U', words: 3 }]).split('\n').slice(1).map((l) => l.slice(0, 4)), ['[1] ', '[2] '], 'notes (file and database) are numbered too (ticket)');
eq(attach.agentBody('just words', []), 'just words', 'no files: the text unchanged');
eq([attach.fmtSize(840), attach.fmtSize(4_800_000), attach.fmtSize(30 * 1024 * 1024)], ['840 B', '4.6 MB', '30 MB'], 'sizes a person reads');
ok(attach.isAssetsPanel({ icon: 'assets', title: 'Files' }) && attach.isAssetsPanel({ icon: null, title: ' assets ' }) && !attach.isAssetsPanel({ icon: 'tasks', title: 'Tasks' }), 'the Assets panel: icon assets or title Assets');
ok(
  attach.isAssetsPanel({ icon: null, title: 'Files', url: 'http://127.0.0.1:8206/rooms/r1/view' }, 'r1') &&
    attach.isAssetsPanel({ icon: null, title: 'Files', url: 'http://127.0.0.1:8206/rooms/r1/view/' }, 'r1'),
  "...or any panel on room-assets' view of THIS room, whatever its title",
);
ok(
  !attach.isAssetsPanel({ icon: null, title: 'Tasks', url: 'http://127.0.0.1:8207/rooms/r1/view' }, 'r1') &&
    !attach.isAssetsPanel({ icon: null, title: 'Files', url: 'http://127.0.0.1:8206/rooms/r2/view' }, 'r1') &&
    !attach.isAssetsPanel({ icon: null, title: 'Files', url: 'not a url' }, 'r1'),
  'not a sibling app on the same path, not another room, not a bad URL',
);
eq(attach.assetsPanelUrl('abc def'), 'http://127.0.0.1:8206/rooms/abc%20def/view', 'its view on room-assets\' fixed port');

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* held open by better-sqlite3 until exit */
}

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
