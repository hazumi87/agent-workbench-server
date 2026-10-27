/**
 * ROOM TEMPLATES, engine side (design review's note KB design-notes-id, option 3C): ONE strict format, role/recipe keys always, content OPTIONAL; import is all-or-nothing in one
 * transaction; export reads the live family. A scratch table and a scratch files folder; nothing listens.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-tpl-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_SEAT_WELCOME = '0';
const FILES = join(dir, 'files');
mkdirSync(FILES, { recursive: true });
const env = { HARBOR_WB_FILES_DIR: FILES };

const { table } = await import('../src/table/endpoint.ts');
const tpl = await import('../src/engine/room-template.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const throws = (fn: () => unknown, code: string, m: string, field?: RegExp): void => {
  try { fn(); ok(false, `${m} (accepted)`); } catch (e: any) { ok(e?.code === code && (!field || field.test(String(e.field ?? ''))), `${m} (${e?.code} ${e?.field ?? ''})`); }
};

const base = (): any => ({
  format: 'workbench-room-template', formatVersion: 1, key: 'my-team', name: 'My team', version: 2, brief: 'A small team.',
  room: { lead: 'boss', seats: [{ handle: 'helper', role: 'builder', recipe: 'builder' }, { handle: 'boss', role: 'lead', recipe: 'lead' }] },
  teams: [{ alias: 'plan', name: 'Plan', lead: 'planner', seats: [{ handle: 'scribe', role: 'builder', recipe: 'builder' }, { handle: 'planner', role: 'lead', recipe: 'lead' }] }],
  roomLead: 'boss', tools: [], permission: 'ask', folder: 'new',
  roles: { lead: { text: '# Lead\nLead the team.' }, builder: { text: '# Builder\nBuild things.' } },
  recipes: { lead: { vendor: 'claude-code', model: 'sonnet' }, builder: { vendor: 'codex-cli' } },
});

console.log('\n[validation: strict, all-or-nothing, before anything is written]');
ok(tpl.validateTemplate(base()).key === 'my-team', 'a good document validates');
throws(() => tpl.validateTemplate({ ...base(), surprise: 1 }), 'invalid', 'an unknown top-level field is refused', /surprise/);
throws(() => tpl.validateTemplate({ ...base(), room: { ...base().room, seats: [{ handle: 'a', role: 'r', recipe: 'x', initCmd: 'rm -rf' }] } }), 'invalid', 'an unknown seat field (initCmd) is refused, naming the path', /initCmd/);
throws(() => tpl.validateTemplate({ ...base(), recipes: { lead: { vendor: 'claude-code', initCmd: 'x' } } }), 'invalid', 'a carried recipe is a PROFILE: initCmd is refused', /initCmd/);
throws(() => tpl.validateTemplate({ ...base(), recipes: { lead: { vendor: 'claude-code', projectDir: '/x' } } }), 'invalid', '...and so is projectDir', /projectDir/);
throws(() => tpl.validateTemplate({ ...base(), recipes: { lead: { vendor: 'bash' } } }), 'invalid', 'a vendor outside the enum is refused', /vendor/);
throws(() => tpl.validateTemplate({ ...base(), formatVersion: 2 }), 'unsupported_format', 'a newer format is refused with its own code');
throws(() => tpl.validateTemplate({ ...base(), formatVersion: 0 }), 'invalid', 'a bad formatVersion is invalid');
throws(() => tpl.validateTemplate({ ...base(), format: 'something-else' }), 'invalid', 'a different format name is refused');
throws(() => tpl.validateTemplate({ ...base(), permission: 'bypass' }), 'invalid', "'bypass' does not exist in the format", /permission/);
throws(() => tpl.validateTemplate({ ...base(), folder: '/home/me/code' }), 'invalid', 'a folder is a CHOICE, never a path', /folder/);
throws(() => tpl.validateTemplate({ ...base(), room: { lead: 'ghost', seats: base().room.seats } }), 'invalid', 'the lead must be one of the room\'s own seats', /lead/);
throws(() => tpl.validateTemplate({ ...base(), teams: [{ ...base().teams[0], lead: 'boss' }] }), 'invalid', 'a team lead must be a seat of that team', /lead/);
throws(() => tpl.validateTemplate({ ...base(), room: { lead: 'room', seats: [{ handle: 'room', role: 'r', recipe: 'x' }] } }), 'invalid', 'a reserved handle is refused', /handle/);
throws(() => tpl.validateTemplate({ ...base(), room: { lead: 'Boss', seats: [{ handle: 'Boss', role: 'r', recipe: 'x' }] } }), 'invalid', 'a handle must already be a slug (no silent fixing in a file)', /handle/);
throws(() => tpl.validateTemplate({ ...base(), teams: [{ ...base().teams[0], seats: [{ handle: 'boss', role: 'lead', recipe: 'lead' }], lead: 'boss' }] }), 'invalid', 'a handle is unique across the family', /handle/);
throws(() => tpl.validateTemplate({ ...base(), teams: [{ ...base().teams[0], alias: 'boss' }] }), 'invalid', 'an alias shares the handle namespace', /alias/);
throws(() => tpl.validateTemplate({ ...base(), teams: [{ ...base().teams[0], alias: 'room' }] }), 'invalid', 'a reserved alias is refused', /alias/);
throws(() => tpl.validateTemplate({ ...base(), teams: Array.from({ length: 11 }, (_, i) => ({ alias: `t${i}`, name: `T${i}`, lead: `l${i}`, seats: [{ handle: `l${i}`, role: 'r', recipe: 'x' }] })) }), 'invalid', 'at most 10 teams', /teams/);
throws(() => tpl.validateTemplate({ ...base(), room: { lead: 's0', seats: Array.from({ length: 51 }, (_, i) => ({ handle: `s${i}`, role: 'r', recipe: 'x' })) }, teams: [] }), 'invalid', 'at most 50 seats', /seats/);
throws(() => tpl.validateTemplate({ ...base(), roles: { lead: { text: 'x'.repeat(16 * 1024 + 1) } } }), 'invalid', 'a role text over 16 KB is refused', /roles/);
throws(() => tpl.validateTemplate({ ...base(), roles: { lead: { text: 'a' }, ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`r${i}`, { text: 'x'.repeat(15 * 1024) }])) } }), 'invalid', 'all roles over 64 KB are refused', /roles/);
throws(() => tpl.validateTemplate({ ...base(), brief: 'bad\u0000char' }), 'invalid', 'a control character outside role text is refused', /brief/);
ok(tpl.validateTemplate({ ...base(), roles: { lead: { text: 'line\r\n\ttab' } } }).roles?.lead.text.includes('\t'), 'role text may carry newlines and tabs');
throws(() => tpl.validateTemplate(JSON.parse(JSON.stringify({ ...base(), brief: 'x'.repeat(300 * 1024) }))), 'invalid', 'a file over 256 KB is refused', /./);
throws(() => tpl.validateTemplate('not an object'), 'invalid', 'a non-object is refused');

console.log('\n[create: one transaction; the lead leads; keys resolve]');
let before = table.listRooms({}).length;
throws(() => tpl.createFromTemplate({ ...base(), recipes: undefined, roles: undefined }, { env }), 'missing_recipe', 'a recipe key with no local recipe and no carried profile: missing_recipe, naming it', /recipe/);
try {
  tpl.createFromTemplate({ ...base(), recipes: undefined, roles: undefined }, { env });
} catch (e: any) {
  ok(e.extra?.recipe === 'builder' && JSON.stringify(e.extra?.recipes?.sort()) === JSON.stringify(['builder', 'lead']), 'the error carries the missing keys as DATA: recipe (the first) and recipes (all of them), so no app parses the sentence');
}
ok(table.listRooms({}).length === before, '...and nothing was written');
const r1 = tpl.createFromTemplate(base(), { env });
ok(r1.status === 'created' && !!r1.room_id && Object.keys(r1.seats).sort().join() === 'boss,helper,planner,scribe' && Object.keys(r1.groups).join() === 'plan', 'created: the room, the team and four seats');
const room = table.getRoom(r1.room_id)!;
ok(room.name === 'My team' && room.brief === 'A small team.', 'name and brief');
ok(table.getSeat(room.lead_seat!)?.handle === 'boss', 'the declared lead leads, although `helper` is listed first (order in a file cannot change who leads)');
const team = table.getRoom(r1.groups.plan)!;
ok(team.parent_id === room.id && table.getSeat(team.lead_seat!)?.handle === 'planner', 'the team hangs under the room and its declared lead leads');
ok(r1.template.key === 'my-team' && r1.template.version === 2 && r1.folder === 'new', 'the answer carries the template key/version and the folder CHOICE (the app asks for the path)');
ok(JSON.stringify(r1.not_applied.sort()) === JSON.stringify(['permission']) || r1.not_applied.includes('permission'), 'permission is reported as NOT applied (the engine has no permission level yet), never silently dropped');
const seatRecipe = table.getSeat(r1.seats.boss)!.recipe_id!;
ok(seatRecipe === 'tpl-my-team-lead', 'a carried profile becomes a recipe scoped to the template (tpl-<key>-<recipe>)');
const rec = table.getRecipe(seatRecipe)!;
ok(rec.vendor === 'claude-code' && rec.model === 'sonnet' && rec.target === 'local' && !rec.initCmd && rec.projectDir === join(FILES, 'agents', 'lead'), 'materialised as a plain local recipe in the agent folder: no initCmd, no ssh');

console.log('\n[roles: written only where the folder is missing; the person\'s wins]');
ok(readFileSync(join(FILES, 'agents', 'lead', 'CLAUDE.md'), 'utf8').includes('Lead the team.') && existsSync(join(FILES, 'agents', 'lead', 'AGENTS.md')), 'agents/lead/CLAUDE.md and AGENTS.md written');
mkdirSync(join(FILES, 'agents', 'qa'), { recursive: true });
writeFileSync(join(FILES, 'agents', 'qa', 'CLAUDE.md'), 'MINE');
const d2 = { ...base(), key: 'second', roles: { qa: { text: 'THEIRS' } }, room: { lead: 'q1', seats: [{ handle: 'q1', role: 'qa', recipe: 'qa' }] }, teams: [], recipes: { qa: { vendor: 'claude-code' } }, roomLead: undefined };
const r2 = tpl.createFromTemplate(d2, { env });
ok(readFileSync(join(FILES, 'agents', 'qa', 'CLAUDE.md'), 'utf8') === 'MINE', 'an existing role folder is NEVER overwritten');
ok(r2.facts.some((f: string) => /agents\/qa/.test(f) && /kept/.test(f)), '...and a fact says yours was kept');

console.log('\n[recipes: local ones win; a carried profile that differs conflicts]');
table.upsertRecipe({ id: 'mine', name: 'Mine', target: 'local', projectDir: join(FILES, 'agents', 'mine'), vendor: 'claude-code', agent: null, model: 'opus', resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
const d3 = { ...base(), key: 'third', room: { lead: 'x1', seats: [{ handle: 'x1', role: 'mine', recipe: 'mine' }] }, teams: [], roles: undefined, recipes: { mine: { vendor: 'codex-cli' } }, roomLead: undefined };
const r3 = tpl.createFromTemplate(d3, { env });
ok(table.getSeat(r3.seats.x1)!.recipe_id === 'mine' && table.getRecipe('mine')!.model === 'opus', 'a recipe of the person\'s own with that key is used as is, never changed');
const dupe = { ...base(), key: 'fourth', room: { lead: 'y1', seats: [{ handle: 'y1', role: 'lead', recipe: 'lead' }] }, teams: [], roomLead: undefined };
before = table.listRooms({}).length;
const r4 = tpl.createFromTemplate(dupe, { env });
ok(r4.status === 'created' && table.getSeat(r4.seats.y1)!.recipe_id === 'tpl-fourth-lead', 'a different template makes its OWN scoped recipe');
table.upsertRecipe({ ...table.getRecipe('tpl-fifth-lead') ?? { id: 'tpl-fifth-lead', name: 'x', target: 'local', projectDir: null, vendor: 'codex-cli', agent: null, model: null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } } as never);
const clash = { ...dupe, key: 'fifth' };
before = table.listRooms({}).length;
throws(() => tpl.createFromTemplate(clash, { env }), 'recipe_conflict', 'a scoped recipe that exists with a DIFFERENT profile: recipe_conflict', /recipe/);
ok(table.listRooms({}).length === before, '...and nothing was created');

console.log('\n[repeatable, with an idempotency key for a lost reply]');
const dd = { ...dupe, key: 'sixth' };
const a = tpl.createFromTemplate(dd, { env, idempotencyKey: 'k-1' });
const b = tpl.createFromTemplate(dd, { env, idempotencyKey: 'k-1' });
ok(a.status === 'created' && b.status === 'replayed' && b.room_id === a.room_id, 'the same idempotency key: the committed answer again, no second room');
const c = tpl.createFromTemplate(dd, { env });
ok(c.status === 'created' && c.room_id !== a.room_id, 'without a key a template is REPEATABLE: a new room each time (no seeded marker)');
ok(!table.getStarterSeed('sixth'), '...and it never touches the starter marker table');

console.log('\n[export: keys always, content only when asked]');
const ex = tpl.exportTemplate(r1.room_id, { env });
ok(ex.format === 'workbench-room-template' && ex.formatVersion === 1 && ex.name === 'My team', 'export writes the format');
ok(ex.room.lead === 'boss' && ex.teams.length === 1 && ex.teams[0].alias === 'plan' && ex.teams[0].lead === 'planner', 'with explicit leads');
ok(!('roles' in ex) && !('recipes' in ex), 'no content unless asked (for this PC)');
const exFull = tpl.exportTemplate(r1.room_id, { env, embed: ['roles', 'recipes'] });
ok(exFull.roles?.lead?.text.includes('Lead the team.') && exFull.recipes?.['tpl-my-team-lead']?.vendor === 'claude-code', 'embed=roles,recipes carries role text and recipe PROFILES');
ok(JSON.stringify(exFull).indexOf(FILES) < 0 && !/projectDir|initCmd|target/.test(JSON.stringify(exFull.recipes)), 'never a path, never initCmd or target');
tpl.validateTemplate(exFull);
ok(true, 'an exported document passes the importer\'s own validator');
const exTeams = tpl.exportTemplate(r1.room_id, { env, teams: ['nope'] });
ok(exTeams.teams.length === 0, 'teams=<aliases> chooses which teams go');
throws(() => tpl.exportTemplate(r1.groups.plan, { env }), 'invalid', 'only a main room can be exported', /room/);
process.env.HARBOR_WB_FILES_DIR = FILES; // the routes read the process env
console.log('\n[the routes: a person\'s act]');
const { Readable } = await import('node:stream');
const rooms = await import('../src/server/rooms.ts');
async function call(method: string, url: string, body?: unknown, human = true): Promise<{ status: number; body: any }> {
  const q = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  q.method = method; q.url = url;
  q.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  const out = { status: 0, body: null as any };
  const res = { writeHead(s: number) { out.status = s; }, setHeader() {}, end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } } };
  await rooms.handle(q, res as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {}, human });
  return out;
}
const dRoute = { ...base(), key: 'viaroute', room: { lead: 'r1', seats: [{ handle: 'r1', role: 'lead', recipe: 'lead' }] }, teams: [], roomLead: undefined };
let rr = await call('POST', '/api/rooms/from-template', { doc: dRoute, idempotencyKey: 'route-1' });
ok(rr.status === 201 && rr.body.status === 'created' && rr.body.template.key === 'viaroute', 'POST /api/rooms/from-template: 201 with the created ids');
const rr2 = await call('POST', '/api/rooms/from-template', { doc: dRoute, idempotencyKey: 'route-1' });
ok(rr2.body.status === 'replayed' && rr2.body.room_id === rr.body.room_id, '...and a lost reply (same idempotency key) is answered again, not repeated');
rr = await call('POST', '/api/rooms/from-template', { doc: { ...dRoute, surprise: 1 } });
ok(rr.status === 400 && rr.body.code === 'invalid' && /surprise/.test(rr.body.field), 'an invalid document: 400 {code:\'invalid\', field: <json path>}');
rr = await call('POST', '/api/rooms/from-template', { doc: { ...dRoute, recipes: undefined } });
ok(rr.status === 400 && rr.body.code === 'missing_recipe' && rr.body.field === 'recipe' && rr.body.recipe === 'lead' && Array.isArray(rr.body.recipes), 'over HTTP: 400 {error, field:\'recipe\', code:\'missing_recipe\', recipe, recipes}');
rr = await call('POST', '/api/rooms/from-template', { doc: { ...dRoute, formatVersion: 9 } });
ok(rr.status === 400 && rr.body.code === 'unsupported_format', 'a newer format: 400 unsupported_format');
rr = await call('POST', '/api/rooms/from-template', { doc: dRoute }, false);
ok(rr.status === 403, 'an agent cannot create a room from a template (a person\'s act)');
rr = await call('POST', '/api/rooms/from-template', {});
ok(rr.status === 400 && rr.body.field === 'doc', 'no doc: 400 naming `doc`');
const gx = await call('GET', `/api/rooms/${r1.room_id}/template?embed=roles,recipes`);
ok(gx.status === 200 && gx.body.format === 'workbench-room-template' && !!gx.body.roles && !!gx.body.recipes, 'GET /api/rooms/:id/template?embed=roles,recipes');
ok((await call('GET', `/api/rooms/${r1.room_id}/template`, undefined, false)).status === 403, '...a person\'s act too');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
