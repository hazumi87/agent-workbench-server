/**
 * STARTER ROOMS SEED (row 7; the design notes): one transaction builds a template (recipes, rooms, workgroups,
 * startable seats, the brief) and writes a marker in the SAME transaction. Repeat = `already` with the same ids; a conflict or any throw
 * writes NOTHING; a delete or archive never gets the template recreated; nothing is started.
 * SAFETY: a temp table set BEFORE any import; fabric off. Nothing listens, nothing spawns.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-starter-seed-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';

const { table } = await import('../src/table/endpoint.ts');
const { seedStarter, SeedError } = await import('../src/engine/starter-seed.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const env = { HARBOR_WB_FILES_DIR: join(dir, 'files') };
const refused = (f: () => unknown): string | null => {
  try { f(); return null; } catch (e) { return e instanceof SeedError ? e.code : `threw ${(e as Error).message}`; }
};
const countRooms = (): number => table.listRooms({}).length;

console.log('\n[refusals before anything is written]');
ok(refused(() => seedStarter('no-such-template', 1, env)) === 'unknown_template', 'an unknown template is refused');
ok(refused(() => seedStarter('my-project', 0, env)) === 'invalid' && refused(() => seedStarter('my-project', 'x', env)) === 'invalid', 'a version that is not a positive whole number is refused');
ok(countRooms() === 0 && table.listRecipes().length === 0, 'and nothing was written');

console.log('\n[a recipe the user already owns on a reserved id: refuse, write NOTHING (the second reserved id conflicts after the first was created)]');
table.upsertRecipe({ id: 'starter-builder', name: 'My own', target: 'local', projectDir: null, agent: null, model: null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null, vendor: 'cli-manager' } as never);
ok(refused(() => seedStarter('my-project', 3, env)) === 'recipe_conflict', 'the user\'s recipe on starter-builder makes the whole seed refuse');
ok(countRooms() === 0 && table.getRecipe('starter-lead') === undefined, 'no room, and starter-lead (created earlier in the same transaction) was rolled back');
table.deleteRecipe('starter-builder');

console.log('\n[my-project: the first run]');
const r1 = seedStarter('my-project', 3, env);
ok(r1.status === 'created' && !!r1.room_id, 'created');
const main = table.getRoom(r1.room_id)!;
ok(main.name === 'My project' && main.parent_id === null, 'a main room named My project');
const wgs = table.listWorkgroups(main.id);
ok(wgs.map((w) => w.alias).sort().join() === 'build,design,plan,test', `four workgroups: ${wgs.map((w) => w.alias).sort().join()}`);
const seatsOf = (id: string): string[] => table.listSeats(id).map((s) => s.handle).sort();
ok(seatsOf(main.id).join() === 'project-lead', 'the base room holds project-lead');
const g = (a: string) => wgs.find((w) => w.alias === a)!;
ok(seatsOf(g('plan').id).join() === 'architect,planner' && seatsOf(g('design').id).join() === 'artist,brand' && seatsOf(g('build').id).join() === 'builder-1,builder-2,pm' && seatsOf(g('test').id).join() === 'test-plans,tester-1,tester-2', 'each group holds its seats');
const leadOf = (id: string): string | undefined => table.getSeat(table.getRoom(id)!.lead_seat ?? '')?.handle;
ok(leadOf(main.id) === 'project-lead' && leadOf(g('plan').id) === 'planner' && leadOf(g('design').id) === 'brand' && leadOf(g('build').id) === 'pm' && leadOf(g('test').id) === 'test-plans', 'the room lead and each team lead are the intended seats');
const all = [main, ...wgs].flatMap((r) => table.listSeats(r.id));
ok(all.length === 11, `11 seats (${all.length})`);
ok(all.every((s) => s.occupant === null || s.occupant_kind === 'none'), 'every seat is startable and holds no pane: nothing was started');
ok(all.every((s) => s.recipe_id === 'starter-lead' || s.recipe_id === 'starter-builder'), 'every seat uses one of the two starter recipes');
ok(all.filter((s) => s.recipe_id === 'starter-lead').length === 5 && all.filter((s) => s.recipe_id === 'starter-builder').length === 6, 'the room lead and the four team leads use starter-lead, the other six starter-builder');
ok(table.getRecipe('starter-lead')?.vendor === 'claude-code' && table.getRecipe('starter-builder')?.vendor === 'claude-code', 'both recipes are Claude');
ok(!!main.brief && main.brief.length > 0, 'the base room has a brief');
ok(Object.keys(r1.seats).length === 11 && r1.seats['project-lead'] === table.seatByHandle(main.id, 'project-lead')!.id && Object.keys(r1.groups).sort().join() === 'build,design,plan,test', 'the answer carries every seat id and group id');

console.log('\n[a repeat, a lost reply, a version bump]');
const roomsBefore = countRooms();
const r2 = seedStarter('my-project', 3, env);
ok(r2.status === 'already' && r2.room_id === r1.room_id && JSON.stringify(r2.seats) === JSON.stringify(r1.seats), 'a repeat answers `already` with the SAME ids');
const r3 = seedStarter('my-project', 4, env);
ok(r3.status === 'already' && r3.room_id === r1.room_id && countRooms() === roomsBefore, 'a newer version does nothing');

console.log('\n[preservation: a delete or archive is never undone by a retry]');
table.archiveRoom(g('test').id, { actor: 'user' });
ok(seedStarter('my-project', 3, env).status === 'already', 'after a workgroup is archived the seed still answers `already`');
ok(table.listWorkgroups(main.id).filter((w) => w.state !== 'archived').length === 3, 'and nothing was recreated');
for (const w of table.listWorkgroups(main.id)) {
  if (w.state !== 'archived') table.archiveRoom(w.id, { actor: 'user' });
}
table.archiveRoom(main.id, { actor: 'user' });
ok(seedStarter('my-project', 3, env).status === 'already' && countRooms() === roomsBefore, 'after the main room is archived: still `already`, no second My project');

console.log('\n[my-first-room, and a recipe the first template already made]');
const f = seedStarter('my-first-room', 1, env);
const fr = table.getRoom(f.room_id)!;
ok(f.status === 'created' && fr.name === 'My first room' && seatsOf(fr.id).join() === 'builder,planner' && leadOf(fr.id) === 'planner', 'two seats: planner (the room lead; `lead` is reserved by the engine) and builder, alongside My project\'s own planner: two families');
ok(table.listRecipes().filter((r) => r.id.startsWith('starter-')).length === 2, 'the two starter recipes are shared, not duplicated');
ok(seedStarter('my-first-room', 1, env).status === 'already', 'its repeat is `already` too');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
