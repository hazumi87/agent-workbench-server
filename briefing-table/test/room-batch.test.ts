/**
 * table.roomBatch (src/table/endpoint.ts + store.roomBatch; assemble-room
 * §4.2) [ticket]: several room verbs as ONE store transaction.
 *
 *  - a committed batch writes everything and announces it, in order, only
 *    after the commit;
 *  - `throw new Rollback(value)` (a dry run, a refused row) writes NOTHING —
 *    no room row, no seat, no line entry — announces nothing, and hands the
 *    value back; reads inside the batch saw its own writes;
 *  - any other throw propagates with nothing written or announced;
 *  - a verb refused INSIDE the batch and caught rolls back only itself (a
 *    savepoint), so the batch can report it and carry on.
 *
 * SAFETY: a temp db via HARBOR_WB_TABLE set BEFORE any import. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-batch-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');

const { table, Rollback, RoomError } = await import('../src/table/endpoint.ts');
const roomBus = await import('../src/engine/room-bus.ts');

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  }
}
const events: string[] = [];
roomBus.on(roomBus.ANY_ROOM, (_roomId, ev) => events.push(ev.type));
table.upsertRecipe({
  id: 'rec-a', name: 'Alpha', target: 'local', projectDir: '/x/alpha', vendor: 'claude-code', agent: 'alpha', model: null, resume: 0,
  resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
} as never);
const lines = () => table.listRooms().reduce((n, r) => n + table.listLine(r.id).length, 0);

console.log('\n[a rolled-back batch leaves no trace]');
{
  const out = table.roomBatch((tx) => {
    const room = tx.createRoom({ name: 'Ghost' }, { actor: 'user' }).result;
    tx.addSeat(room.id, { recipe_id: 'rec-a' }, { actor: 'user' });
    const seen = { rooms: table.listRooms().length, seats: table.listSeats(room.id).length, lead: table.getRoom(room.id)?.lead_seat !== null };
    throw new Rollback(seen);
  });
  eq(out.committed, false, 'committed:false');
  eq(out.value.rooms, 1, 'inside the batch, the room was readable');
  eq(out.value.seats, 1, '...with its seat');
  eq(out.value.lead, true, '...and its lead');
  eq(table.listRooms().length, 0, 'after it: no room row');
  eq(lines(), 0, 'no line entry');
  eq(events.length, 0, 'nothing announced on the room bus');
}

console.log('\n[any other throw: nothing written, nothing announced, it propagates]');
{
  let threw = '';
  try {
    table.roomBatch((tx) => {
      tx.createRoom({ name: 'Half' }, { actor: 'user' });
      throw new Error('boom');
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  eq(threw, 'boom', 'the error propagates');
  eq(table.listRooms().length, 0, 'no room row');
  eq(events.length, 0, 'nothing announced');
}

console.log('\n[a committed batch writes and announces, after the commit]');
{
  const out = table.roomBatch((tx) => {
    const room = tx.createRoom({ name: 'Real' }, { actor: 'user' }).result;
    tx.addSeat(room.id, { recipe_id: 'rec-a', handle: 'one' }, { actor: 'user' });
    /* A refused verb, caught: a savepoint, so only it rolls back. */
    let refused = '';
    try {
      tx.addSeat(room.id, { recipe_id: 'rec-a', handle: 'one' }, { actor: 'user' });
    } catch (e) {
      refused = e instanceof RoomError ? e.field : 'other';
    }
    tx.addSeat(room.id, { recipe_id: 'rec-a', handle: 'two' }, { actor: 'user' });
    eq(events.length, 0, 'nothing announced while the batch is open');
    return { id: room.id, refused };
  });
  eq(out.committed, true, 'committed:true');
  eq(out.value.refused, 'handle', 'the caught refusal named its field');
  eq(table.listSeats(out.value.id).map((s) => s.handle).join(','), 'one,two', 'the other verbs kept their writes');
  eq(events.filter((t) => t === 'room.line').length, lines(), 'every line entry written was announced once');
  eq(events.includes('room.state'), true, 'room.state announced');
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* win32: the in-process store still holds the db open (EPERM) until exit */
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
