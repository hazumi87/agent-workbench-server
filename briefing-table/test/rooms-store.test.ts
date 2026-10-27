/**
 * Rooms store + endpoint verbs (the design notes §1, §6 "store" rows)
 * [ticket].
 *
 * Driven through the ENDPOINT (`table.*`), the only access surface, so the
 * bus emission after commit is exercised by the same calls. Covers every verb;
 * the four lead refusals (§1.6); reserved and duplicate-active handles; seat
 * history from_ts/to_ts; the fault injector (a CHECK failure inside a
 * transaction leaves seat, history and line counts unchanged); a 1000-entry
 * tight-loop burst paged back complete and in order via since, then
 * before/tail; the seat filter surviving a rename; the no-lead refusal.
 *
 * SAFETY: a temp db via HARBOR_WB_TABLE, set BEFORE the store is imported (it
 * reads the path at module load). data/mapping.db is never opened. No engine,
 * no broker, no port.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-rooms-store-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_IDENTITY = 'legacy';

const { table, RoomError } = await import('../src/table/endpoint.ts');
const bus = await import('../src/engine/room-bus.ts');
const Database = (await import('better-sqlite3')).default;

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
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)}${Object.is(actual, expected) ? '' : `, want ${JSON.stringify(expected)}`})`);
}
/** Expect a RoomError with this status and field. */
function refuses(fn: () => unknown, status: number, field: string, msg: string): void {
  try {
    fn();
    ok(false, `${msg} — expected ${status} field:${field}, but it succeeded`);
  } catch (e) {
    const re = e instanceof RoomError;
    const err = e as InstanceType<typeof RoomError>;
    ok(re && err.status === status && err.field === field, `${msg} (${re ? `${err.status} field:${err.field} "${err.message}"` : String(e)})`);
  }
}
function sameJson(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? msg : `${msg} (got ${a}, want ${b})`);
}
const meta = (e: { meta: string | null }): Record<string, unknown> => (e.meta ? JSON.parse(e.meta) : {});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A read-only side handle for counting rows (the store keeps its own).
const counts = (roomId: string, seatId?: string): { seats: number; history: number; line: number } => {
  const ro = new Database(process.env.HARBOR_WB_TABLE!, { readonly: true });
  try {
    return {
      seats: (ro.prepare(`SELECT COUNT(*) AS n FROM room_seats WHERE room_id=?`).get(roomId) as { n: number }).n,
      history: seatId
        ? (ro.prepare(`SELECT COUNT(*) AS n FROM room_seat_history WHERE seat_id=?`).get(seatId) as { n: number }).n
        : (ro.prepare(`SELECT COUNT(*) AS n FROM room_seat_history`).get() as { n: number }).n,
      line: (ro.prepare(`SELECT COUNT(*) AS n FROM room_line WHERE room_id=?`).get(roomId) as { n: number }).n,
    };
  } finally {
    ro.close();
  }
};

const events: Array<{ roomId: string; type: string; entryId?: number }> = [];
bus.on(bus.ANY_ROOM, (roomId, ev) => {
  events.push({ roomId, type: ev.type, entryId: ev.type === 'room.line' ? ev.entry.id : undefined });
});
const U = { actor: 'user' as const };

/* ------------------------------------------------------------------------ */
console.log('\n[createRoom / getRoom / listRooms]');
refuses(() => table.createRoom({ name: '   ' }, U), 400, 'name', 'an empty name is refused');
const before0 = events.length;
const c1 = table.createRoom({ name: 'Voice Hardware' }, U);
const R = c1.result.id;
eq(c1.result.state, 'open', 'a new room is open');
eq(c1.result.created_by, 'user', "created_by is 'user'");
eq(c1.result.lead_seat, null, 'a new room has no lead');
ok(typeof c1.result.idle_ms === 'number' && c1.result.idle_ms >= 0, 'idle_ms is derived on read');
eq(c1.entries.length, 1, 'one entry: the creation fact');
eq(c1.entries[0].kind, 'fact', "…of kind 'fact'");
eq(c1.entries[0].author, 'room', "…authored by 'room'");
eq(c1.entries[0].thread, null, 'thread is NULL on every Phase-1 row');
eq(events.length - before0, 2, 'bus: one room.line + one room.state, after commit');
ok(events.at(-1)!.type === 'room.state' && events.at(-2)!.entryId === c1.entries[0].id, 'bus: the line event carries the entry');
eq(table.getRoom(R)?.name, 'Voice Hardware', 'getRoom');
ok(table.listRooms().some((r) => r.id === R), 'listRooms lists it');
const c2 = table.createRoom({ name: 'Typed' }, { actor: 'user', commandText: '/new Typed' });
eq(c2.entries.map((e) => e.kind).join(','), 'command,fact', 'with commandText: the verbatim command, then the fact');
eq(meta(c2.entries[1]).cause, c2.entries[0].id, 'the fact carries meta.cause = the command id');
ok(c2.entries[0].id < c2.entries[1].id, 'ids strictly insertion-ordered');

/* ------------------------------------------------------------------------ */
console.log('\n[addSeat: handles, placeholders, reserved, duplicates, lead rule 3]');
const a1 = table.addSeat(R, { project: 'auriga' }, U);
const AURIGA = a1.result.id;
eq(a1.result.handle, 'auriga', 'the default handle is the project name');
eq(a1.result.handle_named, 1, 'an unsuffixed derived handle is a name');
eq(a1.result.policy, 'persistent', 'policy defaults to persistent');
eq(a1.result.occupant_kind, 'none', 'no occupant given: none');
eq(table.getRoom(R)?.lead_seat, AURIGA, 'rule 3: the first persistent seat becomes lead');
eq(a1.entries.map((e) => e.body).join(' | '), '@auriga was added to the room | @auriga is now the lead', 'two facts: added, and lead');
eq(a1.entries[0].target_seat, AURIGA, "the 'added' fact is about the seat (seat filter shows it)");
ok(a1.result.is_lead === true, 'is_lead is derived at read time');

const a2 = table.addSeat(R, { project: 'auriga' }, U);
const AURIGA2 = a2.result.id;
eq(a2.result.handle, 'auriga2', 'a collision auto-suffixes a placeholder');
eq(a2.result.handle_named, 0, '…and marks it unnamed (the roster nudges a rename)');
eq(table.getRoom(R)?.lead_seat, AURIGA, 'a second seat does not take the lead');

refuses(() => table.addSeat(R, { project: 'x', handle: 'Room' }, U), 400, 'handle', 'a TYPED reserved handle is a 400');
refuses(() => table.addSeat(R, { project: 'x', handle: '@all' }, U), 400, 'handle', 'a typed @all is a 400');
refuses(() => table.addSeat(R, { project: 'x', handle: 'auriga' }, U), 409, 'handle', 'a typed duplicate of an ACTIVE handle is a 409');
refuses(() => table.addSeat(R, { project: 'x', handle: '---' }, U), 400, 'handle', 'a typed handle with nothing usable is a 400');
refuses(() => table.addSeat(R, {}, U), 400, 'project', 'a seat needs a project, recipe or handle');
const aRoom = table.addSeat(R, { project: 'room' }, U);
eq(aRoom.result.handle, 'room2', "a DERIVED default on a reserved word takes the suffix path ('room2')");
eq(aRoom.result.handle_named, 0, '…as a placeholder');
const aLead = table.addSeat(R, { project: 'Lead' }, U);
eq(aLead.result.handle, 'lead2', "derived 'lead' -> 'lead2'");
const long = 'a'.repeat(64);
const l1 = table.addSeat(R, { project: long }, U);
const l2 = table.addSeat(R, { project: long }, U);
eq(l1.result.handle.length, 64, 'a 64-char stem is kept whole');
eq(l2.result.handle, `${'a'.repeat(63)}2`, 'the stem is TRUNCATED before the suffix, so the suffix survives');
const typed = table.addSeat(R, { project: 'home-ops', handle: 'Dot Hardware' }, U);
eq(typed.result.handle, 'dot-hardware', 'a typed handle is normalised the slug way');
eq(typed.result.project, 'home-ops', 'project is kept as a LABEL snapshot');

const segBefore = counts(R).seats;
refuses(() => table.addSeat(R, { project: 'x', policy: 'forgetful' }, U), 400, 'policy', 'an unknown policy fails its CHECK -> 400 field:policy');
eq(counts(R).seats, segBefore, '…and no seat row was written');

table.upsertRecipe({
  id: 'rcp-ha',
  name: 'Home Operations',
  target: 'local',
  projectDir: '/srv/code/home-ops/',
  vendor: 'claude-code',
  agent: 'home-ops',
  model: null,
  resume: 0,
  resumeName: null,
  initCmd: null,
  closeOnCleanExit: 0,
  statusPath: null,
  color: null,
  fg: null,
  bg: null,
  watermark: null,
  fontSize: null,
  logo: null,
});
const fromRecipe = table.addSeat(R, { recipe_id: 'rcp-ha' }, U);
eq(fromRecipe.result.recipe_id, 'rcp-ha', 'recipe_id is the fill source');
eq(fromRecipe.result.handle, 'home-ops', 'handle derives from the recipe projectDir basename (trailing slash ok)');
refuses(() => table.addSeat(R, { recipe_id: 'nope' }, U), 400, 'recipe_id', 'an unknown recipe is a 400');
eq(table.activeSeatsForRecipe('rcp-ha').length, 1, 'activeSeatsForRecipe finds the seat (the recipe-DELETE 409)');

/* ------------------------------------------------------------------------ */
console.log('\n[lead rule 3: a transient first seat does NOT become lead]');
const R2 = table.createRoom({ name: 'Swarm' }, U).result.id;
const sw = table.addSeat(R2, { project: 'auriga', handle: 'sketcher-swarm', policy: 'pool', pool_size: 20 }, U);
eq(table.getRoom(R2)?.lead_seat, null, 'a pool first seat leaves the lead NULL (no silent policy override)');
eq(sw.result.policy, 'pool', 'the policy decision is kept');
eq(sw.result.occupant_kind, 'pool', 'a pool seat is ONE seat with a count');
eq(sw.result.pool_size, 20, '…of 20');
eq(sw.result.policy_set_by, 'user', 'policy_set_by records who chose transient');
ok(typeof sw.result.policy_set_at === 'number', '…and when');
eq(sw.entries.length, 1, 'no lead fact');
ok(/forgets by design/.test(sw.entries[0].body ?? ''), "the 'added' fact says it forgets by design");

console.log('\n[no-lead refusal (§1.4): un-addressed text refused, addressed text fine]');
refuses(() => table.appendLine(R2, { kind: 'chat', body: 'hello' }, U), 409, 'target', 'un-addressed chat with no lead is refused');
refuses(
  () => table.appendLine(R2, { kind: 'command', body: '/session-summary' }, U),
  409,
  'target',
  'an un-addressed carried command with no lead is refused',
);
const addressed = table.appendLine(R2, { kind: 'chat', body: '@sketcher-swarm go', target: '@sketcher-swarm' }, U);
eq(addressed.result[0].target_seat, sw.result.id, '@handle still works with no lead');
const toRoom = table.appendLine(R2, { kind: 'chat', body: '@room pausing', target: 'room' }, U);
eq(toRoom.result[0].target, 'room', "@room: target 'room'");
eq(toRoom.result[0].target_seat, null, '…and target_seat NULL');
const lead2 = table.addSeat(R2, { project: 'kiosk' }, U);
eq(table.getRoom(R2)?.lead_seat, lead2.result.id, 'the next PERSISTENT seat of a lead-less room becomes lead');

/* ------------------------------------------------------------------------ */
console.log('\n[the four lead refusals (§1.6)]');
const fresh = table.addSeat(R, { project: 'fresh-one', policy: 'fresh' }, U);
refuses(() => table.updateRoom(R, { lead_seat: fresh.result.id }, U), 409, 'lead_seat', 'rule 1: a non-persistent seat cannot be lead');
refuses(() => table.updateSeat(R, AURIGA, { policy: 'fresh' }, U), 409, 'policy', "rule 2: the lead's policy cannot leave persistent");
refuses(() => table.removeSeat(R, AURIGA, U), 409, 'seat', 'rule 4: removing the lead is refused');
try {
  table.removeSeat(R, AURIGA, U);
} catch (e) {
  eq((e as Error).message, 'hand the lead over first', "…with 'hand the lead over first'");
}
eq(table.getRoom(R2)?.lead_seat, lead2.result.id, 'rule 3 (above): a transient first seat never became lead');
refuses(() => table.updateRoom(R, { lead_seat: null }, U), 400, 'lead_seat', 'the lead can be handed over, not cleared');
refuses(() => table.updateRoom(R, { lead_seat: 'no-such-seat' }, U), 404, 'lead_seat', 'an unknown lead seat is a 404');
refuses(() => table.updateRoom(R, { lead_seat: sw.result.id }, U), 404, 'lead_seat', "another room's seat is not this room's");

/* ------------------------------------------------------------------------ */
console.log('\n[updateRoom: name, lead handover (rule 5), mode; idempotent]');
const evBefore = events.length;
const noop = table.updateRoom(R, { name: 'Voice Hardware' }, U);
eq(noop.entries.length, 0, 'a patch that changes nothing writes nothing');
eq(events.length, evBefore, '…and emits nothing');
const hand = table.updateRoom(R, { lead_seat: AURIGA2 }, { actor: { seatId: AURIGA }, commandText: '/set lead @auriga2' });
eq(table.getRoom(R)?.lead_seat, AURIGA2, 'the lead is handed over');
eq(hand.entries.map((e) => e.kind).join(','), 'command,fact', 'rule 5: command + Room fact, one transaction');
eq(hand.entries[0].author, 'auriga', 'the command is authored by the acting seat (handle snapshot)');
eq(hand.entries[0].author_seat, AURIGA, '…and its seat id');
eq(hand.entries[1].body, '@auriga2 is now the lead (was @auriga)', 'the fact names both leads');
eq(meta(hand.entries[1]).from, AURIGA, 'meta.from = the old lead seat');
eq(hand.entries[1].target_seat, AURIGA2, "the fact is about the new lead's seat");
eq(events.at(-1)?.type, 'room.state', 'a lead change emits room.state');
const mode = table.updateRoom(R, { mode: 'autonomous', name: 'VH' }, U);
eq(table.getRoom(R)?.mode, 'autonomous', 'mode set');
eq(mode.entries.map((e) => e.body).join(' | '), 'the room was renamed "VH" | room mode: autonomous', 'a fact per changed field');
table.updateRoom(R, { mode: 'off' }, U);
eq(table.getRoom(R)?.mode, null, "mode 'off' clears it");
table.updateRoom(R, { lead_seat: AURIGA }, U);

/* ------------------------------------------------------------------------ */
console.log('\n[updateSeat: rename, policy]');
const ren = table.updateSeat(R, AURIGA2, { handle: '@Auriga-Design' }, { actor: 'user', commandText: '/rename @auriga2 to @auriga-design' });
eq(ren.result.handle, 'auriga-design', 'renamed (normalised)');
eq(ren.result.handle_named, 1, 'a rename makes the handle a real name');
eq(ren.entries[0].target, 'auriga2', 'the command entry snapshots the handle AS TYPED (pre-rename)');
eq(ren.entries[1].body, '@auriga2 is now @auriga-design', 'the rename fact');
refuses(() => table.updateSeat(R, AURIGA2, { handle: 'auriga' }, U), 409, 'handle', 'renaming onto an active handle: 409 (unique index)');
refuses(() => table.updateSeat(R, AURIGA2, { handle: 'lead' }, U), 400, 'handle', 'renaming onto a reserved handle: 400');
refuses(() => table.updateSeat(R, AURIGA2, { policy: 'sometimes' }, U), 400, 'policy', 'an unknown policy: 400 field:policy');
const pol = table.updateSeat(R, AURIGA2, { policy: 'dispatched' }, U);
eq(pol.result.policy, 'dispatched', 'a non-lead seat may go transient');
eq(pol.result.policy_set_by, 'user', 'policy_set_by');
ok(/forgets by design/.test(pol.entries[0].body ?? ''), 'the policy fact says it forgets by design');
table.updateSeat(R, AURIGA2, { policy: 'persistent' }, U);

/* ------------------------------------------------------------------------ */
console.log('\n[setOccupant: first fill, replace, history from_ts/to_ts, caches]');
table.upsert({ paneid: 'recipe:rcp-ha', recipe_id: 'rcp-ha', server: 'local', vendor: 'claude-code', agent: 'home-ops', session_id: 's1', state: 'live' });
table.upsert({ paneid: 'recipe:rcp-ha#2', recipe_id: 'rcp-ha', server: 'local', vendor: 'claude-code', agent: 'ha-two', session_id: 's2', state: 'live' });
const HA = fromRecipe.result.id;
const fill = table.setOccupant(R, HA, 'recipe:rcp-ha', U);
eq(fill.result.occupant_kind, 'pane', 'filled with a pane');
eq(fill.result.slug, 'home-ops', 'slug cache from sessions.agent');
eq(table.listSeatHistory(HA).length, 0, 'a FIRST fill writes no history row');
ok(/is now filled by pane recipe:rcp-ha/.test(fill.entries[0].body ?? ''), 'fill fact');
const since1 = fill.result.occupant_since!;
await sleep(5);
const rep = table.setOccupant(R, HA, 'recipe:rcp-ha#2', { actor: 'user', commandText: '/replace @home-ops with recipe:rcp-ha#2' });
const h1 = table.listSeatHistory(HA);
eq(h1.length, 1, 'replacing writes one history row');
eq(h1[0].occupant, 'recipe:rcp-ha', '…holding the FORMER occupant');
eq(h1[0].reason, 'replaced', "reason 'replaced'");
eq(h1[0].from_ts, since1, 'from_ts = the retired occupant_since');
eq(h1[0].to_ts, rep.result.occupant_since, 'to_ts = when the new occupant arrived');
ok(h1[0].to_ts > h1[0].from_ts!, 'to_ts after from_ts');
eq(rep.result.slug, 'ha-two', 'slug cache rewritten from the new occupant');
eq(meta(rep.entries[1]).history, h1[0].id, 'the fact cites the history row');
eq(rep.entries.map((e) => e.kind).join(','), 'command,fact', 'command + fact');
const rew = table.setOccupant(R, HA, 'recipe:other-recipe#3', U);
eq(rew.result.recipe_id, 'other-recipe', 'recipe_id rewritten from the recipe:<id># prefix (no session row)');
eq(rew.result.slug, null, 'no session row: slug cache NULL');
refuses(() => table.setOccupant(R, AURIGA2, 'recipe:other-recipe#3', U), 409, 'occupant', 'one pane cannot hold two seats in one room');
refuses(() => table.setOccupant(R, HA, { kind: 'ghost', id: 'x' } as never, U), 400, 'occupant', 'an unknown occupant kind: 400 names the API field (occupant), not the column');
const task = table.setOccupant(R, HA, { kind: 'task', id: 'task-9' }, U);
eq(task.result.occupant_kind, 'task', 'a task occupant');
const same = table.setOccupant(R, HA, { kind: 'task', id: 'task-9' }, U);
eq(same.entries.length, 0, 'setting the same occupant is a no-op');
const empty = table.setOccupant(R, HA, null, { actor: 'user', reason: 'ended' });
eq(empty.result.occupant_kind, 'none', 'emptied');
eq(empty.result.occupant_since, null, 'occupant_since cleared');
eq(table.listSeatHistory(HA).at(-1)?.reason, 'ended', "a caller-given reason ('ended') is recorded");
eq(table.listSeatHistory(HA).length, 4, 'every former occupant retained (4 rows)');

/* ------------------------------------------------------------------------ */
console.log('\n[fault injector: a CHECK failure mid-transaction rolls EVERYTHING back]');
table.setOccupant(R, HA, 'recipe:rcp-ha', U);
const seatBefore = table.getSeat(HA)!;
const c0 = counts(R, HA);
const evFault = events.length;
refuses(
  () => table.setOccupant(R, HA, 'recipe:rcp-ha#2', { actor: 'user', commandText: '/replace @home-ops', reason: 'bogus' as never }),
  400,
  'reason',
  'history reason fails its CHECK AFTER the seat update ran',
);
const c1b = counts(R, HA);
eq(c1b.seats, c0.seats, 'seat count unchanged');
eq(c1b.history, c0.history, 'history count unchanged');
eq(c1b.line, c0.line, 'line count unchanged (no command, no fact)');
eq(table.getSeat(HA)?.occupant, seatBefore.occupant, "the seat's occupant update was rolled back");
eq(table.getSeat(HA)?.occupant_since, seatBefore.occupant_since, '…and its occupant_since');
eq(events.length, evFault, 'nothing was broadcast');
const lb = counts(R).line;
refuses(
  () => table.appendLine(R, [{ kind: 'chat', body: 'first, fine' }, { kind: 'shout', body: 'second, bad kind' }], U),
  400,
  'kind',
  'a bad kind in a batch fails its CHECK after the first entry was inserted',
);
eq(counts(R).line, lb, 'the first entry of the batch was rolled back too');

/* ------------------------------------------------------------------------ */
console.log('\n[appendLine: authors, targets, caps, carried command + delivery]');
const chat = table.appendLine(R, { kind: 'chat', body: 'please review the plan' }, U).result[0];
eq(chat.author, 'user', "no from: author 'user'");
eq(chat.author_seat, null, '…author_seat NULL (what an approval citation checks)');
eq(chat.target, null, 'no @: target NULL (nothing was typed)');
eq(chat.target_seat, AURIGA, '…target_seat = the lead AS OF THE WRITE');
const byMember = table.appendLine(R, { kind: 'chat', body: 'on it', target: '@room' }, { actor: { seatId: AURIGA2 } }).result[0];
eq(byMember.author, 'auriga-design', 'a member post is authored by its handle snapshot');
eq(byMember.author_seat, AURIGA2, '…and seat id');
refuses(() => table.appendLine(R, { kind: 'chat', body: 'x' }, { actor: { seatId: sw.result.id } }), 403, 'from', 'a seat of ANOTHER room cannot post here');
refuses(() => table.appendLine(R, { kind: 'chat', body: 'x' }, { actor: { seatId: 'ghost' } }), 403, 'from', 'an unknown seat cannot post');
refuses(() => table.appendLine(R, { kind: 'chat', body: 'hi', target: '@all' }, U), 400, 'target', '@all is refused in Phase 1');
refuses(() => table.appendLine(R, { kind: 'chat', body: 'hi', target: '@nobody' }, U), 400, 'target', 'an unknown @handle is a 400');
refuses(() => table.appendLine(R, { kind: 'chat', body: '' }, U), 400, 'text', 'empty chat is a 400 field:text');
const cap = counts(R).line;
refuses(() => table.appendLine(R, { kind: 'chat', body: 'x'.repeat(4001) }, U), 400, 'text', 'over 4000 chars is REFUSED, not truncated');
eq(counts(R).line, cap, '…and nothing written');
eq(table.appendLine(R, { kind: 'chat', body: 'y'.repeat(4000) }, U).result[0].body?.length, 4000, 'exactly 4000 is fine');
const verbatim = '  @auriga   I approve   B.  ';
eq(table.appendLine(R, { kind: 'chat', body: verbatim, target: 'auriga' }, U).result[0].body, verbatim, 'the words are stored exactly as typed');
const leadTok = table.appendLine(R, { kind: 'chat', body: '@lead look', target: '@lead' }, U).result[0];
eq(leadTok.target_seat, AURIGA, '@lead resolves to the lead seat at write time');
const carried = table.appendLine(
  R,
  { kind: 'delivery', body: 'not delivered — occupant not live', target: 'auriga-design', asRoom: true },
  { actor: 'user', commandText: '/session-summary @auriga-design' },
);
eq(carried.entries.map((e) => e.kind).join(','), 'command,delivery', 'a carried command: the command entry + a delivery entry');
eq(carried.entries[0].author, 'user', 'the command is the user’s');
eq(carried.entries[0].target_seat, AURIGA2, "…addressed to the member's seat");
eq(carried.entries[1].author, 'room', 'the delivery report is the Room’s');
eq(meta(carried.entries[1]).cause, carried.entries[0].id, 'delivery meta.cause = the command id');

console.log('\n[the decay signal: only chat/command by a person or member bumps last_active_at]');
const t0 = table.getRoom(R)!.last_active_at;
await sleep(5);
table.updateRoom(R, { mode: 'autonomous' }, U);
table.appendLine(R, { kind: 'fact', body: 'status churn' }, U);
eq(table.getRoom(R)!.last_active_at, t0, 'facts and state changes never bump it');
await sleep(5);
table.appendLine(R, { kind: 'chat', body: 'still here' }, U);
ok(table.getRoom(R)!.last_active_at > t0, 'chat bumps it');

/* ------------------------------------------------------------------------ */
console.log('\n[removeSeat: never deletes, frees the handle, retains the occupant]');
table.setOccupant(R, typed.result.id, 'recipe:dot#1', U);
const rm = table.removeSeat(R, typed.result.id, { actor: 'user', commandText: '/remove @dot-hardware confirm' });
ok(typeof rm.result.left_at === 'number', 'left_at set');
eq(rm.result.occupant_kind, 'none', 'occupant emptied');
eq(table.listSeatHistory(typed.result.id).at(-1)?.reason, 'evicted', "occupant closed into history as 'evicted'");
ok(table.getSeat(typed.result.id) !== undefined, 'the seat row still exists');
ok(!table.listSeats(R).some((s) => s.id === typed.result.id), 'listSeats: active only');
ok(table.listSeats(R, { includeLeft: true }).some((s) => s.id === typed.result.id), 'listSeats includeLeft: shows it');
eq(table.seatByHandle(R, 'dot-hardware'), undefined, 'seatByHandle: a departed seat is not active');
eq(table.seatByHandle(R, 'dot-hardware', { includeLeft: true })?.id, typed.result.id, 'seatByHandle includeLeft finds it');
refuses(() => table.removeSeat(R, typed.result.id, U), 409, 'seat', 'removing twice is a 409');
refuses(() => table.updateSeat(R, typed.result.id, { handle: 'x' }, U), 409, 'seat', 'a departed seat cannot be updated');
refuses(() => table.updateRoom(R, { lead_seat: typed.result.id }, U), 409, 'lead_seat', 'rule 1: a departed seat cannot be lead');
const reuse = table.addSeat(R, { project: 'z', handle: 'dot-hardware' }, U);
eq(reuse.result.handle, 'dot-hardware', 'the handle is FREE again (partial unique index)');

/* ------------------------------------------------------------------------ */
console.log('\n[lookups: seatByHandle, roomsForPane, lineCounts, listSeats order]');
eq(table.seatByHandle(R, '@AURIGA')?.id, AURIGA, 'seatByHandle: @ optional, case-insensitive');
const rooms = table.roomsForPane('recipe:rcp-ha');
eq(rooms.length, 1, 'roomsForPane: one room holds this pane');
eq(rooms[0].seat.id, HA, '…in this seat');
table.updateRoom(R, { lead_seat: AURIGA2 }, U);
eq(table.listSeats(R)[0].id, AURIGA2, 'the lead sorts FIRST at read time…');
ok(table.getSeat(AURIGA2)!.position > table.getSeat(AURIGA)!.position, '…without rewriting positions');
table.updateRoom(R, { lead_seat: AURIGA }, U);
const lc = table.lineCounts(R);
ok(lc.chat > 0 && lc.fact > 0 && lc.command > 0 && lc.delivery > 0 && lc.attachment === 0, 'lineCounts: every kind present, zeros included');

/* ------------------------------------------------------------------------ */
console.log('\n[archive / reopen]');
refuses(() => table.reopenRoom(R, U), 409, 'state', 'reopen an open room: 409');
eq(table.activeSeatsForRecipe('rcp-ha').length, 1, 'before archive: the rcp-ha seat still pins its recipe');
const arc = table.archiveRoom(R, { actor: 'user', commandText: '/archive confirm' });
eq(arc.result.state, 'archived', 'archived');
eq(table.activeSeatsForRecipe('rcp-ha').length, 0, 'archived: its seats no longer pin the recipe (archive is stasis)');
eq(table.getSeat(fromRecipe.result.id)?.left_at, null, '…and the seat itself is untouched (still active, not left)');
eq(table.getSeat(fromRecipe.result.id)?.recipe_id, 'rcp-ha', '…recipe_id unchanged');
ok(typeof arc.result.archived_at === 'number', 'archived_at set');
refuses(() => table.archiveRoom(R, U), 409, 'state', 'archive twice: 409');
refuses(() => table.appendLine(R, { kind: 'chat', body: 'x' }, U), 409, 'state', 'nothing is posted into a room in a box');
refuses(() => table.addSeat(R, { project: 'q' }, U), 409, 'state', 'nor seated');
refuses(() => table.updateRoom(R, { name: 'q' }, U), 409, 'state', 'nor renamed');
eq(table.listRooms({ state: 'archived' }).some((r) => r.id === R), true, 'listRooms by state');
const reo = table.reopenRoom(R, U);
eq(reo.result.state, 'open', 'reopened');
eq(reo.result.archived_at, null, 'archived_at cleared');
eq(table.activeSeatsForRecipe('rcp-ha').length, 1, 'reopened: the seat pins its recipe again');

/* ------------------------------------------------------------------------ */
console.log('\n[listLine validation]');
refuses(() => table.listLine(R, { limit: 0 }), 400, 'limit', 'limit 0');
refuses(() => table.listLine(R, { limit: 1001 }), 400, 'limit', 'limit over 1000');
refuses(() => table.listLine(R, { kind: 'nope' }), 400, 'kind', 'unknown kind');
refuses(() => table.listLine(R, { since: -1 }), 400, 'since', 'negative since');
refuses(() => table.listLine(R, { before: 1.5 }), 400, 'before', 'fractional before');
ok(table.listLine(R, { kind: 'chat,command' }).every((e) => e.kind === 'chat' || e.kind === 'command'), 'kind accepts a comma list');

/* ------------------------------------------------------------------------ */
console.log('\n[a renamed seat: seat= still returns pre-rename entries]');
const RR = table.createRoom({ name: 'Rename' }, U).result.id;
const s1 = table.addSeat(RR, { project: 'auriga' }, U).result.id;
table.addSeat(RR, { project: 'kiosk' }, U);
const pre1 = table.appendLine(RR, { kind: 'chat', body: '@auriga i approve b', target: 'auriga' }, U).result[0];
const pre2 = table.appendLine(RR, { kind: 'chat', body: 'done', target: 'room' }, { actor: { seatId: s1 } }).result[0];
table.updateSeat(RR, s1, { handle: 'auriga-design' }, U);
const post = table.appendLine(RR, { kind: 'chat', body: '@auriga-design thanks', target: 'auriga-design' }, U).result[0];
const barn = table.appendLine(RR, { kind: 'chat', body: '@kiosk hi', target: 'kiosk' }, U).result[0];
const bySeat = table.listLine(RR, { seat: s1 });
const ids = bySeat.map((e) => e.id);
ok(ids.includes(pre1.id), "a pre-rename user->seat entry is still in the seat's view");
eq(bySeat.find((e) => e.id === pre1.id)?.target, 'auriga', '…with its original target text');
ok(ids.includes(pre2.id), 'a pre-rename entry AUTHORED by the seat is too');
eq(bySeat.find((e) => e.id === pre2.id)?.author, 'auriga', '…with its original author snapshot');
ok(ids.includes(post.id), 'and the post-rename one');
ok(!ids.includes(barn.id), "another seat's traffic is not");
ok(ids.every((id, i) => i === 0 || id > ids[i - 1]), 'in id order');

/* ------------------------------------------------------------------------ */
console.log('\n[a 1000-entry tight-loop burst pages back complete and in order]');
const RB = table.createRoom({ name: 'Burst' }, U).result.id;
table.addSeat(RB, { project: 'auriga' }, U);
const evBurst = events.length;
for (let i = 0; i < 1000; i++) {
  table.appendLine(RB, { kind: 'chat', body: `m${i}` }, U);
}
eq(events.filter((e, i) => i >= evBurst && e.roomId === RB && e.type === 'room.line').length, 1000, 'the bus heard 1000 room.line events');
const fwd: string[] = [];
const fwdIds: number[] = [];
let cursor = 0;
for (let guard = 0; guard < 100; guard++) {
  const page = table.listLine(RB, { since: cursor, kind: 'chat', limit: 137 });
  if (!page.length) {
    break;
  }
  fwd.push(...page.map((e) => e.body ?? ''));
  fwdIds.push(...page.map((e) => e.id));
  cursor = page.at(-1)!.id;
}
eq(fwd.length, 1000, 'since: all 1000 came back');
ok(fwd.every((b, i) => b === `m${i}`), 'since: in insertion order, no gap, no duplicate');
ok(fwdIds.every((id, i) => i === 0 || id > fwdIds[i - 1]), 'since: ids strictly increasing');
const tail = table.listLine(RB, { kind: 'chat', limit: 100 });
eq(tail.length, 100, 'no cursor: the newest 100');
eq(tail[0].body, 'm900', '…oldest of the tail first');
eq(tail.at(-1)!.body, 'm999', '…newest last');
const back: string[] = [];
let bcur = tail[0].id;
back.unshift(...tail.map((e) => e.body ?? ''));
for (let guard = 0; guard < 100; guard++) {
  const page = table.listLine(RB, { before: bcur, kind: 'chat', limit: 250 });
  if (!page.length) {
    break;
  }
  back.unshift(...page.map((e) => e.body ?? ''));
  bcur = page[0].id;
}
eq(back.length, 1000, 'before: paging back from the tail returns all 1000');
ok(back.every((b, i) => b === `m${i}`), 'before: in order, no gap, no duplicate');
eq(table.listLine(RB, { since: 0, limit: 1000 }).length, 1000, 'an unfiltered since=0 page holds creation facts + chat, capped at the limit');

/* ------------------------------------------------------------------------ */
console.log('\n[a seat actor may create a room; the refusal path never broadcasts]');
const byPane = table.createRoom({ name: 'From a pane' }, { actor: { seatId: AURIGA } });
eq(byPane.result.created_by, AURIGA, 'created_by is the SEAT id, never a handle');
refuses(() => table.createRoom({ name: 'x' }, { actor: { seatId: 'ghost' } }), 403, 'from', 'an unresolvable seat actor is a 403, never downgraded');
const evRef = events.length;
refuses(() => table.removeSeat(R, AURIGA, U), 409, 'seat', 'a refused verb…');
eq(events.length, evRef, '…emits nothing on the bus');
eq(bus.listenerCount(bus.ANY_ROOM), 1, 'bus: listener registered under ANY_ROOM');

/* ------------------------------------------------------------------------ */
console.log('\n[room authorship v2: a user\'s picture — per user, a checked data: URL or null]');
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG1 = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64')}`;
const WEBP1 = `data:image/webp;base64,${Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1').toString('base64')}`;
eq(table.getUserPicture('u-1'), null, 'no picture until one is set');
eq(table.setUserPicture('u-1', PNG1), PNG1, 'a PNG data: URL is stored');
eq(table.getUserPicture('u-1'), PNG1, '...and read back');
eq(table.getUserPicture('u-2'), null, 'per user: another user has none');
eq(table.setUserPicture('u-2', JPEG1), JPEG1, 'a JPEG is accepted');
eq(table.setUserPicture('u-2', WEBP1), WEBP1, 'a WebP is accepted (and replaces the JPEG)');
eq(table.getUserPicture('u-1'), PNG1, '...without touching u-1');
refuses(() => table.setUserPicture('u-1', 'https://example.com/me.png'), 400, 'picture', 'a URL is refused (only a data: URL)');
refuses(() => table.setUserPicture('u-1', 'data:image/svg+xml;base64,PHN2Zy8+'), 400, 'picture', 'an SVG is refused');
refuses(() => table.setUserPicture('u-1', PNG1.replace('image/png', 'image/jpeg')), 400, 'picture', 'bytes that are not the declared type are refused');
refuses(() => table.setUserPicture('u-1', 42), 400, 'picture', 'a non-string is refused');
refuses(() => table.setUserPicture('u-1', `data:image/png;base64,${'A'.repeat(400_000)}`), 413, 'picture', 'over the stored cap: 413, naming both numbers');
eq(table.getUserPicture('u-1'), PNG1, 'a refused write changed nothing');
eq(table.setUserPicture('u-1', null), null, 'null clears it');
eq(table.getUserPicture('u-1'), null, '...cleared');

/* ------------------------------------------------------------------------ */
console.log('\n[hidden rooms: per user, an array of existing room ids]');
{
  const H1 = table.createRoom({ name: 'Hide one' }, U).result.id;
  const H2 = table.createRoom({ name: 'Hide two' }, U).result.id;
  sameJson(table.getHiddenRooms('u-1'), [], 'none until set');
  sameJson(table.setHiddenRooms('u-1', [H1, H2, H1]), [H1, H2], 'stored, deduped in order');
  sameJson(table.getHiddenRooms('u-1'), [H1, H2], '...and read back');
  sameJson(table.getHiddenRooms('u-2'), [], 'per user: another user hides nothing');
  eq(table.getUserPicture('u-1'), null, 'hiding leaves the picture alone');
  table.setUserPicture('u-1', PNG1);
  sameJson(table.getHiddenRooms('u-1'), [H1, H2], '...and a picture write leaves hidden rooms alone');
  refuses(() => table.setHiddenRooms('u-1', 'nope'), 400, 'hiddenRooms', 'not an array: 400');
  refuses(() => table.setHiddenRooms('u-1', [H1, 'no-such-room']), 400, 'hiddenRooms', 'an unknown room id: 400');
  refuses(() => table.setHiddenRooms('u-1', [H1, 7]), 400, 'hiddenRooms', 'a non-string id: 400');
  refuses(() => table.setHiddenRooms('u-1', Array.from({ length: 501 }, (_, i) => `r-${i}`)), 413, 'hiddenRooms', 'over the cap: 413');
  sameJson(table.getHiddenRooms('u-1'), [H1, H2], 'a refused write changed nothing');
  sameJson(table.setHiddenRooms('u-1', []), [], '[] unhides everything');
  ok(table.listRooms().some((r) => r.id === H1) && table.listRooms().some((r) => r.id === H2), 'hiding changes no room: the list is whole');
}

/* ------------------------------------------------------------------------ */
console.log('\n[room drafts: per user per room, capped at DRAFT_BODY_MAX (higher than a send) [ticket]]');
{
  const D1 = table.createRoom({ name: 'Draft one' }, U).result.id;
  const D2 = table.createRoom({ name: 'Draft two' }, U).result.id;
  sameJson(table.getRoomDraft('u-1', D1), { text: '', updatedAt: null, replyTo: null }, 'none until written (no reply target either)');
  const w = table.setRoomDraft('u-1', D1, 'half a thought');
  ok(w.text === 'half a thought' && typeof w.updatedAt === 'number', 'written, with a time');
  eq(table.getRoomDraft('u-1', D1).text, 'half a thought', '...and read back');
  eq(table.getRoomDraft('u-1', D2).text, '', 'per room: the other room has none');
  eq(table.getRoomDraft('u-2', D1).text, '', 'per user: another person has none in the same room');
  table.setRoomDraft('u-2', D1, 'theirs');
  eq(table.getRoomDraft('u-1', D1).text, 'half a thought', "...and theirs does not touch mine");
  refuses(() => table.setRoomDraft('u-1', D1, 42), 400, 'text', 'a non-string: 400');
  /* ticket: a draft survives PAST the line's own send cap (LINE_BODY_MAX,
     4000) — its own cap is DRAFT_BODY_MAX (16000), so Owner can keep typing
     a long message without losing it, even though it cannot SEND yet. */
  ok(table.setRoomDraft('u-1', D1, 'x'.repeat(4001)).text.length === 4001, 'a draft OVER the line/send limit (4000) still saves');
  ok(table.setRoomDraft('u-1', D1, 'x'.repeat(5000)).text.length === 5000, '...5000 chars: well past the send cap, still fine');
  ok(table.setRoomDraft('u-1', D1, 'x'.repeat(16000)).text.length === 16000, 'exactly the draft limit (16000) is accepted');
  refuses(() => table.setRoomDraft('u-1', D1, 'x'.repeat(16001)), 413, 'text', 'over the draft limit (16000): 413');
  eq(table.getRoomDraft('u-1', D1).text.length, 16000, 'a refused write changed nothing (the 16000 draft still stands)');
  const c = table.setRoomDraft('u-1', D1, '');
  ok(c.text === '' && typeof c.updatedAt === 'number', "'' clears it and keeps WHEN it was cleared");
}

console.log('\n[your @name: per person, stored handle or the account-name default]');
{
  eq(table.getUserHandle('u-1'), null, 'no stored @name until one is set (the route derives the default)');
  eq(table.defaultUserHandle('Owner'), 'owner', 'default: the account name, lowercased');
  eq(table.defaultUserHandle('Owner example'), 'owner-example', 'default: normalised to the handle grammar');
  eq(table.defaultUserHandle(null), 'me', "default with no account name: 'me'");
  eq(table.defaultUserHandle('Lead'), 'me', "a default that lands on a reserved word: 'me'");
  eq(table.setUserHandle('u-1', 'owner'), 'owner', 'set u-1 to owner');
  eq(table.setUserHandle('u-2', 'dana'), 'dana', 'set u-2 to dana');
  eq(table.getUserHandle('u-1'), 'owner', 'per person: u-1 keeps its own');
  eq(table.getUserHandle('u-2'), 'dana', '...and u-2 its own');
  refuses(() => table.setUserHandle('u-1', 'auriga'), 409, 'handle', 'the handle of an active seat: 409');
  refuses(() => table.setUserHandle('u-1', 'all'), 400, 'handle', 'a reserved word: 400');
  refuses(() => table.setUserHandle('u-1', 'no way'), 400, 'handle', 'off the grammar: 400');
  eq(table.getUserHandle('u-1'), 'owner', 'a refused write changed nothing');
  eq(table.setUserHandle('u-1', null), null, 'null clears it (back to the default)');
  eq(table.getUserHandle('u-2'), 'dana', "...and does not touch another person's");
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* held open by better-sqlite3 until exit */
}

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
