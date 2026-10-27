/** ROOM / TEAM ACTIVITY ROLLUP (engine/room-rollup.ts): working | background | idle | needs-you | none, loudest live seat, with counts. the design system chip, row 8b. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-rollup-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_SEAT_WELCOME = '0';

const { table } = await import('../src/table/endpoint.ts');
const ru = await import('../src/engine/room-rollup.ts');
const activity = await import('../src/engine/activity.ts');
const rooms = await import('../src/server/rooms.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const sig = (o: Partial<Parameters<typeof ru.seatSignalOf>[0]>): string => ru.seatSignalOf({ activity: 'idle', blocked: false, heldReason: null, cliPrompt: null, cliPromptReason: null, ...o });

console.log('\n[one seat -> a signal]');
ok(sig({}) === 'idle' && sig({ activity: 'streaming' }) === 'working' && sig({ activity: 'background' }) === 'background', 'idle / streaming = working / background');
ok(sig({ activity: 'waiting' }) === 'needs-you' && sig({ activity: 'waiting-seen' }) === 'needs-you', 'waiting needs you, also after it was SEEN (asks decay in loudness, never in existence)');
ok(sig({ blocked: true }) === 'needs-you', 'a login / permission / question prompt needs you');
ok(sig({ heldReason: 'draft' }) === 'needs-you' && sig({ heldReason: 'busy' }) === 'idle', 'held lines waiting on the person (draft) need you; a busy hold does not');
ok(sig({ cliPrompt: 'trust' }) === 'needs-you' && sig({ cliPrompt: 'login' }) === 'needs-you', 'a named first-run prompt needs you');
ok(sig({ cliPrompt: 'unknown', cliPromptReason: 'unmatched' }) === 'needs-you', 'an unnamed prompt that held the screen (unmatched) needs you');
ok(sig({ cliPrompt: 'unknown', cliPromptReason: 'no-screen' }) === 'idle' && sig({ cliPrompt: 'unknown', cliPromptReason: 'not-synced' }) === 'idle', 'cannot-tell-yet readings are NOT needs-you');
ok(sig({ cliPrompt: 'shell' }) === 'idle', 'a bare shell ("no agent is running") is NOT needs-you');
ok(sig({ activity: 'streaming', blocked: true }) === 'needs-you', 'needs-you outranks working on the same seat');

console.log('\n[a room -> the loudest seat and the counts]');
const r = (...s: Array<ReturnType<typeof sig> | null>): any => ru.rollupOf(s as never);
ok(r().state === 'none' && r(null, null).live === 0, 'no live seat: none');
ok(r('idle', 'idle').state === 'idle', 'idle');
ok(r('idle', 'background').state === 'background', 'background beats idle');
ok(r('background', 'working', 'idle').state === 'working', 'working beats background');
ok(r('working', 'needs-you', 'idle').state === 'needs-you', 'needs-you beats everything');
const mix = r('working', 'working', 'idle', null, 'needs-you');
ok(mix.live === 4 && mix.working === 2 && mix.idle === 1 && mix.needs_you === 1 && mix.background === 0, 'counts: live seats only (a seat with no live pane is not counted)');

console.log('\n[through the room views: the room and each team]');
function recipe(id: string): void {
  table.upsertRecipe({ id, name: id, target: 'local', projectDir: join(dir, id), vendor: 'claude-code', agent: id, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
}
const live = (paneid: string, recipeId: string, state = 'live'): void => table.upsert({ paneid, recipe_id: recipeId, server: 'local', vendor: 'claude-code', agent: recipeId, session_id: null, state, generation: 1 } as never);
const main = table.createRoom({ name: 'Main', alias: 'main' }, { actor: 'user' }).result;
const team = table.createRoom({ name: 'Team', parent_id: main.id, alias: 'team' }, { actor: 'user' }).result;
for (const id of ['a', 'b', 'c', 'd']) recipe(id);
const bind = (roomId: string, handle: string, id: string, state = 'live'): void => {
  live(`recipe:${id}`, id, state);
  const s = table.addSeat(roomId, { recipe_id: id, handle }, { actor: 'user' }).result;
  table.startSeat(roomId, s.id, `recipe:${id}`, { actor: 'user', mode: 'rehydrate' } as never);
};
bind(main.id, 'lead1', 'a');
bind(team.id, 'worker', 'b');
bind(team.id, 'gone', 'c', 'dehydrated');
async function detail(id: string): Promise<any> {
  const q = Readable.from([]) as any; q.method = 'GET'; q.url = `/api/rooms/${id}`; q.headers = { authorization: 'Bearer t' };
  const out: any = { body: null };
  const res = { writeHead() {}, setHeader() {}, end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } } };
  await rooms.handle(q, res as any, q.url, null, { projector: async () => (x: any) => x, log: () => {}, human: true });
  return out.body;
}
let d = await detail(main.id);
ok(d.rollup?.state === 'idle' && d.rollup.live === 1, 'the main room: one live idle seat -> idle');
ok(d.family.workgroups.find((w: any) => w.alias === 'team')?.rollup?.live === 1 && d.family.workgroups[0].rollup.state === 'idle', 'its team carries its own rollup (the dehydrated seat is not live)');
activity.setBlocked('recipe:b', { reason: 'permission', since: Date.now() });
d = await detail(main.id);
ok(d.family.workgroups[0].rollup.state === 'needs-you' && d.rollup.state === 'idle', 'a blocked seat in the team makes THE TEAM need you, not the main room (each room rolls up its own seats)');
const dt = await detail(team.id);
ok(dt.rollup.state === 'needs-you' && dt.rollup.needs_you === 1 && dt.rollup.live === 1, 'and the team\'s own view says the same');
activity.setBlocked('recipe:b', null);

console.log('\n[a pending Concierge sign-off needs the person]');
const rs = ru.rollupOf([] as never, 2) as any;
ok(rs.state === 'needs-you' && rs.needs_you === 2 && rs.signoffs === 2 && rs.live === 0, 'pending sign-offs make the room needs-you even with no live seat, and are counted');
const rs2 = ru.rollupOf(['working', 'idle'] as never, 1) as any;
ok(rs2.state === 'needs-you' && rs2.needs_you === 1 && rs2.working === 1 && rs2.live === 2, 'beside live seats: the loudest wins, counts add');
ok((ru.rollupOf(['idle'] as never) as any).signoffs === 0, 'none pending: signoffs 0');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
