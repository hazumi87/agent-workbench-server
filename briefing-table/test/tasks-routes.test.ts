/**
 * TASKS, the routes (src/server/tasks-routes.ts; KB design-notes-id), through BOTH doors against a real table: the person's (rooms.handle with a
 * window credential) and an agent's (rooms.handleAgent with a pane that holds a seat). Family scope, the per-route agent allow-list, person-only
 * verbs, who may do what, the author that can not be spoofed, the bounds, and the same bytes for a room that does not exist and one the pane
 * holds no seat in. A scratch table; nothing listens, nothing spawns.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-tasks-routes-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const { tasksEnabled } = await import('../src/server/tasks-routes.ts');
const paneTokensMod = await import('../src/engine/pane-tokens.ts');
const rulesMod = await import('../src/engine/tasks-rules.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const deps = (human: boolean): any => ({ projector: async () => (x: any) => x, log: () => {}, human });
function mkreq(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': 'application/json' };
  return r;
}
function mkres(out: { status: number; body: any }): any {
  return { writeHead(s: number) { out.status = s; }, setHeader() {}, end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } } };
}
/** the person's door */
async function person(method: string, url: string, body?: unknown, human = true): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(mkreq(method, url, body), mkres(out), url.split('?')[0], null, deps(human));
  return out;
}
/** an agent's door: `pane` is the pane that holds a seat; handled=false when the route is not on the agent allow-list at all */
async function agent(pane: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any; handled: boolean }> {
  const out = { status: 0, body: null as any };
  const handled = await rooms.handleAgent(mkreq(method, url, body), mkres(out), url.split('?')[0], pane, deps(false));
  return { ...out, handled };
}

function pane(id: string, name: string): string {
  table.upsertRecipe({ id, name, target: 'local', projectDir: `/x/${name}`, vendor: 'claude-code', agent: name, model: null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
  table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent: name, session_id: null, state: 'live', generation: 1 } as never);
  return `recipe:${id}`;
}
const seat = (roomId: string, id: string, handle: string): any => table.addSeat(roomId, { recipe_id: id, occupant: `recipe:${id}`, handle }, { actor: 'user' }).result;

/* the family: main "Project" (lead boss), workgroups plan (lead coordination, + writer) and build (lead pm, + dev); and a STRANGER family */
const bossP = pane('b', 'boss');
const stewardP = pane('p', 'steward');
const writerP = pane('w', 'writer');
const pmP = pane('m', 'pm');
const devP = pane('d', 'dev');
const strangerP = pane('s', 'stranger');
const M = table.createRoom({ name: 'Project' }, { actor: 'user' }).result;
const PLAN = table.createRoom({ name: 'Plan', parent_id: M.id, alias: 'plan' }, { actor: 'user' }).result;
const BUILD = table.createRoom({ name: 'Build', parent_id: M.id, alias: 'build' }, { actor: 'user' }).result;
seat(M.id, 'b', 'boss');
seat(PLAN.id, 'p', 'steward');
seat(PLAN.id, 'w', 'writer');
seat(BUILD.id, 'm', 'pm');
seat(BUILD.id, 'd', 'dev');
const OTHER = table.createRoom({ name: 'Elsewhere' }, { actor: 'user' }).result;
seat(OTHER.id, 's', 'stranger');
const T = (r: string, rest = ''): string => `/api/rooms/${r}/tasks${rest}`;

ok(rulesMod.WRITES_PER_MIN === paneTokensMod.ROOM_POST_PER_MIN, 'the write limit quoted in the 429 message is the real shared limit');

console.log('\n[the gate: on in local mode, off on the server until Owner decides]');
ok(tasksEnabled({}) === false && tasksEnabled({ HARBOR_WB_MODE: 'server' }) === false, 'a server engine: Tasks is OFF by default (the server keeps Vikunja)');
ok(tasksEnabled({ HARBOR_WB_MODE: 'local' }) === true, 'a local engine: ON');
ok(tasksEnabled({ HARBOR_WB_MODE: 'local', HARBOR_WB_TASKS: '0' }) === false, 'local with HARBOR_WB_TASKS=0: off (the env var wins both ways)');
ok(tasksEnabled({ HARBOR_WB_TASKS: '1' }) === true, 'a server engine with HARBOR_WB_TASKS=1: on');
const offReq = await person('GET', `/api/rooms/${M.id}/tasks`);
ok(offReq.status === 0 || offReq.status === 404, 'with it off, the route is not handled (nothing answers as Tasks)', offReq.status);
const offAgent = await agent(bossP, 'GET', `/api/rooms/${M.id}/tasks`);
ok(offAgent.handled === false, 'and the agent door does not have it on its allow-list');
process.env.HARBOR_WB_TASKS = '1'; // the rest of this suite runs with Tasks on


console.log('\n[the person: add, list, summary]');
const a1 = await person('POST', T(M.id), { title: 'Write the brief', group: 'plan', priority: 2 });
ok(a1.status === 200 && a1.body.task.title === 'Write the brief' && a1.body.task.group.alias === 'plan' && a1.body.task.priority === 2 && a1.body.task.status === 'open', 'the person adds a task to a group by alias');
const a2 = await person('POST', T(M.id), { title: 'Main-room chore' });
ok(a2.body.task.group.id === M.id, 'no group: the room the request names');
ok((await person('GET', T(M.id))).body.tasks.length === 2, 'list: the whole family');
ok((await person('GET', T(PLAN.id, '?group=plan'))).body.tasks.length === 1, 'list: one group');
ok((await person('GET', T(BUILD.id))).body.tasks.length === 2, 'the same family list from a workgroup\'s own URL');
ok((await person('GET', T(M.id, '?limit=9999'))).body.limit === 200 && (await person('GET', T(M.id, '?limit=0'))).body.limit === 1, 'limit is clamped to 1..200');
ok((await person('GET', T(M.id, '?status=nonsense'))).status === 400, 'a bad status filter is a 400');
ok((await person('GET', T(M.id, '?group=nope'))).status === 404, 'a group that does not exist is a 404');
const sm = (await person('GET', T(M.id, '/summary'))).body;
ok(sm.room.totalGroups === 3 && sm.groups.map((g: any) => g.alias).sort().join() === 'build,main,plan' && typeof sm.room.needsYou === 'number', 'summary: the room and every group, with aliases');
ok(!!(await person('GET', T(M.id, '/timeline?hours=99'))).body.groups, 'timeline answers (hours clamped)');
ok((await person('POST', T(M.id), { title: 'x' }, false)).status === 403, 'a request that is not a window credential is refused on the person\'s door');

console.log('\n[the author can not be spoofed, input is validated]');
for (const k of ['from', 'by', 'author', 'actor', 'handle', 'seat', 'user', 'sender']) {
  const r = await person('POST', T(M.id), { title: 'x', [k]: 'boss' });
  if (!(r.status === 400 && r.body.field === k)) ok(false, `"${k}" in the input is refused (got ${r.status})`);
}
ok((await person('POST', T(M.id), { title: 'x', author: 'boss' })).status === 400, 'every one of the eight spoofing keys is refused with a 400 naming it');
ok((await person('POST', T(M.id), { title: '' })).status === 400 && (await person('POST', T(M.id), { title: 'y'.repeat(201) })).status === 400, 'a title is 1..200');
ok((await person('POST', T(M.id), { title: 'ok', priority: 9 })).status === 400, 'priority is 0..5');
ok((await person('POST', T(M.id), { title: 'big', body: 'z'.repeat(17 * 1024) })).status === 400, 'a body over 16 KB is refused');

console.log('\n[a seat: any-seat verbs, and only its own status]');
const wr = await agent(writerP, 'POST', T(PLAN.id), { title: 'Draft intro' });
ok(wr.handled && wr.status === 200 && wr.body.task.group.alias === 'plan', 'a seat adds a task');
const wid = wr.body.task.id;
const cl = await agent(writerP, 'POST', T(PLAN.id, `/${wid}/claim`));
ok(cl.status === 200 && cl.body.task.claimed_by === 'writer', 'it claims it, as itself (the author comes from the pane)');
const dc = await agent(devP, 'POST', T(BUILD.id, `/${wid}/claim`));
ok(dc.status === 409, 'another seat cannot take a claimed task');
ok((await agent(writerP, 'POST', T(PLAN.id, `/${wid}/status`), { status: 'in-progress' })).body.task.status === 'in-progress', 'its own task: it sets the status');
const stOther = await agent(devP, 'POST', T(BUILD.id, `/${wid}/status`), { status: 'done' });
ok(stOther.status === 403, 'a seat cannot set the status of a task it has not claimed');
ok((await agent(devP, 'POST', T(BUILD.id, `/${wid}/flag`))).body.task.flagged === true, 'any seat can flag');
ok((await agent(devP, 'POST', T(BUILD.id, `/${wid}/priority`), { priority: 4 })).body.task.priority === 4, 'any seat can set a priority');
const subs = await agent(writerP, 'POST', T(PLAN.id, `/${wid}/subtasks`), { titles: ['One', 'Two'] });
ok(subs.status === 200 && subs.body.tasks.length === 2, 'and add subtasks');
ok((await agent(writerP, 'POST', T(PLAN.id, `/${wid}/subtasks`), { titles: [] })).status === 400, 'an empty subtask list is a 400');
ok((await agent(devP, 'POST', T(BUILD.id, `/${wid}/bug`))).body.task.bug === true, 'and mark a bug');
const spoofA = await agent(writerP, 'POST', T(PLAN.id), { title: 'sneaky', author: 'boss' });
ok(spoofA.status === 400 && spoofA.body.field === 'author', 'a seat can not name another author either');

console.log('\n[lead verbs: the group\'s lead, or the room lead for all]');
ok((await agent(writerP, 'POST', T(PLAN.id, `/${wid}/progress`), { pct: 50, note: 'half' })).status === 403, 'a plain seat can not set a %');
ok((await agent(pmP, 'POST', T(BUILD.id, `/${wid}/progress`), { pct: 50, note: 'half' })).status === 403, 'another group\'s lead can not set the % of this group\'s task');
const pr = await agent(stewardP, 'POST', T(PLAN.id, `/${wid}/progress`), { pct: 50, note: 'half way' });
ok(pr.status === 200 && pr.body.task.pct === 50, 'the group\'s lead sets a %');
const boss = await agent(bossP, 'POST', T(M.id, `/${wid}/progress`), { pct: 60, note: 'a bit more' });
ok(boss.status === 200 && boss.body.task.pct === 60, 'the room lead acts in every group');
ok((await agent(bossP, 'POST', T(M.id, `/${wid}/pin`))).body.task.pinned === true, 'the room lead pins');
ok((await agent(writerP, 'POST', T(PLAN.id, `/${wid}/pin`))).status === 403, 'a plain seat can not pin');
const asg = await agent(stewardP, 'POST', T(PLAN.id, `/${wid}/assign`), { group: 'build' });
ok(asg.status === 200 && asg.body.task.group.alias === 'build' && asg.body.task.from_group === 'plan' && asg.body.task.claimed_by === null, 'a lead assigns a task to another group by alias: it moves, says where from, drops the claim');
ok((await agent(writerP, 'POST', T(PLAN.id, `/${wid}/assign`), { group: 'plan' })).status === 403, 'a plain seat can not assign');
/* assigning an IN-PROGRESS task to a seat: it goes back to open and the stretch closes (the new owner starts it themselves) */
await agent(pmP, 'POST', T(BUILD.id, `/${wid}/claim`));
await agent(pmP, 'POST', T(BUILD.id, `/${wid}/status`), { status: 'in-progress' });
const openStretches = (): number => (table.withRoomDb((d: any) => d.prepare(`SELECT COUNT(*) AS n FROM task_stretches WHERE task_id=? AND end_at IS NULL`).get(wid)) as { n: number }).n;
ok(openStretches() === 1, 'before: pm works on it, one open stretch');
const asgSeat = await agent(pmP, 'POST', T(BUILD.id, `/${wid}/assign`), { seat: '@dev' });
ok(asgSeat.status === 200 && asgSeat.body.task.claimed_by === 'dev', 'assigning to a seat handle claims it for that seat');
ok(asgSeat.body.task.status === 'open' && openStretches() === 0, '...and an in-progress task goes back to open with its stretch closed: the timeline never shows work the new owner did not do');
ok((await agent(pmP, 'POST', T(BUILD.id, `/${wid}/assign`), { seat: 'nobody' })).status === 404, 'a target that does not exist is a 404');
const tp = await agent(stewardP, 'POST', T(PLAN.id, '/topics'), { name: 'Launch' });
ok(tp.status === 200 && tp.body.topics.length === 1, 'a lead adds a topic');
ok((await agent(writerP, 'POST', T(PLAN.id, '/topics'), { name: 'Nope' })).status === 403, 'a plain seat can not');
ok((await agent(stewardP, 'PUT', T(PLAN.id, '/focus'), { topic: tp.body.topics[0].id })).body.focus === tp.body.topics[0].id, 'a lead sets the focus');
ok((await agent(stewardP, 'POST', T(PLAN.id, '/link'))).body.group.linked === true && (await agent(stewardP, 'DELETE', T(PLAN.id, '/link'))).body.group.linked === false, 'a lead links and unlinks ITS group');
ok((await agent(stewardP, 'DELETE', T(PLAN.id, '/link'), undefined)).status === 200 && (await agent(pmP, 'DELETE', T(PLAN.id, '/link'))).status === 403, '...and another group\'s lead can not');
ok((await person('GET', T(M.id, '/summary'))).body.groups.find((g: any) => g.alias === 'plan').linked === false, 'the summary shows the unlinked group');
ok(typeof (await agent(writerP, 'GET', T(PLAN.id, '/summary'))).body.room.pct !== 'undefined', 'any seat reads the summary');

console.log('\n[ask the lead]');
const al = await agent(writerP, 'POST', T(PLAN.id, '/ask-lead'), { text: 'Which intro do you want?' });
ok(al.status === 200 && al.body.asked === 'steward', 'a seat asks its group lead');
ok(table.listLine(PLAN.id, { limit: 100 }).some((e: any) => e.kind === 'chat' && /^@steward Which intro do you want\?/.test(e.body) && e.author === 'writer'), 'it is a room line to the lead, signed by the asker');
ok((await agent(stewardP, 'POST', T(PLAN.id, '/ask-lead'), { text: 'me?' })).status === 409, 'a lead can not ask itself');
ok((await agent(writerP, 'POST', T(PLAN.id, '/ask-lead'), { text: '' })).status === 400, 'an empty question is a 400');

console.log('\n[person-only verbs never reach an agent]');
const pg = await agent(bossP, 'DELETE', T(M.id, `/${wid}`));
ok(pg.handled === false, 'purge is not on the agent allow-list at all (the room lead included)');
ok((await agent(bossP, 'PUT', T(M.id, `/groups/${PLAN.id}/link`), { linked: true })).handled === false, 'set-linked neither');
ok((await person('PUT', T(M.id, `/groups/${PLAN.id}/link`), { linked: true })).body.group.linked === true, 'the person flips any group');
ok((await person('DELETE', T(M.id, `/${wid}`))).body.purged === wid, 'the person purges');
ok((await person('GET', T(M.id, '?limit=200'))).body.tasks.every((t: any) => t.id !== wid), 'and it is gone');

console.log('\n[the family boundary, and not_seated bytes]');
const strangerAdd = await agent(strangerP, 'POST', T(OTHER.id), { title: 'Their task' });
const strangerId = strangerAdd.body.task.id;
ok(strangerAdd.status === 200, 'a stranger family has its own list');
ok((await agent(bossP, 'POST', T(M.id, `/${strangerId}/flag`))).status === 404, 'a task of another family reads as "no such task"');
ok((await person('POST', T(M.id, `/${strangerId}/status`), { status: 'done' })).status === 404, '...for the person too');
ok((await person('GET', T(M.id))).body.tasks.every((t: any) => t.title !== 'Their task'), 'and never appears in this family\'s list');
const unseated = await agent(strangerP, 'GET', T(M.id));
const missing = await agent(strangerP, 'GET', T('no-such-room-id'));
ok(unseated.status === 403 && unseated.body.error === 'not_seated' && JSON.stringify(unseated.body) === JSON.stringify(missing.body), 'a room the pane holds no seat in, and a room that does not exist: the SAME bytes');
const wrongRoomWrite = await agent(writerP, 'POST', T(BUILD.id), { title: 'from a plan seat in the build URL' });
ok(wrongRoomWrite.status === 403 && wrongRoomWrite.body.error === 'not_seated', 'a seat uses the URL of a room it holds a seat in (the group is chosen with `group`)');
ok((await agent(writerP, 'POST', T(PLAN.id), { title: 'in build by group', group: 'build' })).body.task.group.alias === 'build', 'and reaches another group of its family with `group`');

console.log('\n[builder-two\'s review, routes ([ref])]');
/* a fresh little family so the earlier scenarios do not interfere: Z (lead zed) with groups red (lead rae, + rob) and blue (lead bo, + bea) */
const zedP = pane('z1', 'zed');
const raeP = pane('z2', 'rae');
const robP = pane('z3', 'rob');
const boP = pane('z4', 'bo');
const beaP = pane('z5', 'bea');
const Z = table.createRoom({ name: 'Zed' }, { actor: 'user' }).result;
const RED = table.createRoom({ name: 'Red', parent_id: Z.id, alias: 'red' }, { actor: 'user' }).result;
const BLUE = table.createRoom({ name: 'Blue', parent_id: Z.id, alias: 'blue' }, { actor: 'user' }).result;
seat(Z.id, 'z1', 'zed');
seat(RED.id, 'z2', 'rae');
seat(RED.id, 'z3', 'rob');
seat(BLUE.id, 'z4', 'bo');
seat(BLUE.id, 'z5', 'bea');
const redTask = (await agent(raeP, 'POST', T(RED.id), { title: 'Red work' })).body.task;
await agent(robP, 'POST', T(RED.id, `/${redTask.id}/claim`));
ok((await agent(boP, 'POST', T(BLUE.id, `/${redTask.id}/status`), { status: 'done' })).status === 403, '1: the BLUE lead can not set a RED task to done');
ok((await agent(boP, 'DELETE', T(BLUE.id, `/${redTask.id}/claim`))).status === 403, '1: ...nor release the red seat\'s claim');
ok((await agent(beaP, 'DELETE', T(BLUE.id, `/${redTask.id}/claim`))).status === 403, '1: ...and a plain seat of another group cannot either');
ok((await agent(raeP, 'POST', T(RED.id, `/${redTask.id}/status`), { status: 'in-progress' })).body.task.status === 'in-progress', '1: the RED lead sets the status of its own group\'s task');
ok((await agent(zedP, 'POST', T(Z.id, `/${redTask.id}/status`), { status: 'blocked' })).body.task.status === 'blocked', '1: the room lead acts in every group');
ok((await agent(raeP, 'DELETE', T(RED.id, `/${redTask.id}/claim`))).body.task.claimed_by === null, '1: the group lead releases a claim in its group');
ok((await agent(zedP, 'POST', T(Z.id, '/link'), { group: 'red' })).status === 403 && (await agent(zedP, 'DELETE', T(Z.id, '/link'), { group: 'red' })).status === 403, '3: the room lead can NOT link or unlink a group that is not its own');
ok((await agent(raeP, 'DELETE', T(RED.id, '/link'))).body.group.linked === false && (await agent(raeP, 'POST', T(RED.id, '/link'))).body.group.linked === true, '3: the group\'s own lead can');
ok((await person('DELETE', T(Z.id, '/link'), { group: 'red' })).body.group.linked === false, '3: the person can flip any group');
ok((await person('POST', T(Z.id, '/link'), { group: 'red' })).body.group.linked === true, '3: ...and back');

console.log('\n[2: ask-lead is rate limited and reaches only the lead it names]');
const M_ROOM_FOR_ASK = (): string => Z.id;
const lines = (r: string): any[] => table.listLine(r, { limit: 500 }).filter((e: any) => e.kind === 'chat');
const askText = 'cc @bo @zed and everyone @all @room please look, mail me at noreply@example.com';
const robAsk = await agent(robP, 'POST', T(RED.id, '/ask-lead'), { text: askText });
ok(robAsk.status === 200 && robAsk.body.asked === 'rae', 'a seat asks its group lead');
const asked = lines(RED.id).filter((e: any) => /please look/.test(e.body)).pop();
ok(!!asked && asked.body === `@rae ${askText}`, '3: the text is saved AS WRITTEN (an email address keeps its @); only the lead\'s name leads it');
ok(asked && asked.target === 'rae', 'the line is addressed to rae alone', asked?.target);
for (const [name, room] of [['blue', BLUE], ['the main room', Z]] as const) {
  ok((table.listLine(room.id, { limit: 200 }) as any[]).every((e: any) => !/please look/.test(e.body ?? '')), `nothing was delivered to ${name} (bo and zed were named in the text, and are not reached)`);
}
const planAsk = await agent(beaP, 'POST', T(BLUE.id, '/ask-lead'), { group: 'red', text: 'a question for the red lead from a blue seat' });
ok(planAsk.status === 200 && planAsk.body.asked === 'rae', '6: a seat asks ANOTHER group\'s lead by naming the group');
const cross = lines(BLUE.id).filter((e: any) => /a question for the red lead/.test(e.body)).pop();
ok(!!cross && cross.target === 'rae' && cross.body.startsWith('@rae '), '6: the line is addressed to that lead and to nobody else (not to bo, the asker\'s own lead)', cross?.target);
ok((table.listLine(M_ROOM_FOR_ASK(), { limit: 200 }) as any[]).every((e: any) => !/a question for the red lead/.test(e.body ?? '')), '6: and it was not posted to any third room');
const tooMany = [];
for (let i = 0; i < 30; i++) tooMany.push((await agent(beaP, 'POST', T(BLUE.id, '/ask-lead'), { text: `q${i}` })).status);
ok(tooMany.includes(429), '2: the 21st write in a minute is a 429 (the same per-pane limit as room posts)', tooMany.filter((x) => x !== 200));
const limited = await agent(beaP, 'POST', T(BLUE.id, '/ask-lead'), { text: 'one more' });
ok(limited.status === 429 && limited.body.ok === false && limited.body.error === 'rate_limited' && typeof limited.body.retry_after === 'number', '4: the 429 has the room-post shape: {ok:false, error:"rate_limited", retry_after}', limited.body);
ok(/20 writes a minute \(room posts and task changes together\)/.test(limited.body.message), '4: and says the limit is shared', limited.body.message);
ok((await agent(beaP, 'POST', T(BLUE.id), { title: 'blocked by the rate' })).status === 429, '4: and task writes share that same limit');
ok((await agent(beaP, 'GET', T(BLUE.id))).status === 200, '4: reads are not limited');
ok((await person('POST', T(BLUE.id), { title: 'the person is never limited' })).status === 200, '4: nor is the person');

console.log('\n[10: assign names group or seat explicitly; a subtask lives in its parent\'s group]');
const at = (await agent(zedP, 'POST', T(Z.id), { title: 'To hand over' })).body.task;
ok((await agent(zedP, 'POST', T(Z.id, `/${at.id}/assign`), { to: 'red' })).status === 400, 'the old `to` is no longer accepted: say `group` or `seat`');
ok((await agent(zedP, 'POST', T(Z.id, `/${at.id}/assign`), { group: 'red', seat: 'rae' })).status === 400, 'both at once is a 400');
ok((await agent(zedP, 'POST', T(Z.id, `/${at.id}/assign`), {})).status === 400, 'neither is a 400');
ok((await agent(zedP, 'POST', T(Z.id, `/${at.id}/assign`), { group: 'nowhere' })).status === 404, 'an unknown group is a 404');
ok((await agent(zedP, 'POST', T(Z.id, `/${at.id}/assign`), { seat: 'nobody' })).status === 404, 'an unknown seat is a 404');
const toGroup = await agent(zedP, 'POST', T(Z.id, `/${at.id}/assign`), { group: 'red' });
ok(toGroup.body.task.group.alias === 'red' && toGroup.body.task.claimed_by === null, 'group: it moves');
const toSeat = await agent(raeP, 'POST', T(RED.id, `/${at.id}/assign`), { seat: '@rob' });
ok(toSeat.body.task.claimed_by === 'rob', 'seat: it goes to that seat (a leading @ is fine)');
const parent = (await person('POST', T(Z.id), { title: 'Parent in red', group: 'red' })).body.task;
const child = await person('POST', T(Z.id), { title: 'Child', parent: parent.id });
ok(child.status === 200 && child.body.task.group.alias === 'red' && child.body.task.parent_id === parent.id, 'add with a parent puts the child in the parent\'s group, whatever room the request names');
ok((await person('POST', T(Z.id), { title: 'Child', parent: parent.id, group: 'blue' })).status === 400, '...and a different group named alongside is a 400');

console.log('\n[12: every mutate route refuses the banned author keys, with or without a body; bad JSON is not swallowed]');
for (const [m, rest] of [['POST', `/${parent.id}/claim`], ['POST', `/${parent.id}/flag`], ['DELETE', `/${parent.id}/flag`], ['POST', `/${parent.id}/pin`], ['POST', `/${parent.id}/bug`], ['DELETE', `/${parent.id}/claim`]] as const) {
  const r = await agent(raeP, m, T(RED.id, rest), { author: 'zed' });
  if (!(r.status === 400 && r.body.field === 'author')) ok(false, `${m} ${rest.replace(/\d+/, ':id')} refuses "author" in the body (got ${r.status})`);
}
ok((await agent(raeP, 'POST', T(RED.id, `/${parent.id}/flag`), { by: 'zed' })).status === 400, 'a no-body route refuses a banned key too');
ok((await agent(raeP, 'POST', T(RED.id, '/link'), { actor: 'zed' })).status === 400, 'link refuses a banned key');
{
  const out = { status: 0, body: null as any };
  const r = mkreq('POST', T(RED.id, '/link'));
  const bad = Readable.from([Buffer.from('{ not json')]) as any;
  bad.method = 'POST'; bad.url = T(RED.id, '/link'); bad.headers = { 'content-type': 'application/json' };
  await rooms.handleAgent(bad, mkres(out), T(RED.id, '/link'), raeP, deps(false)).catch(() => {});
  void r;
  ok(out.status === 400, 'link with a body that is not JSON is a 400, not silently treated as empty', out.status);
}

console.log('\n[13: a task in an ARCHIVED group: only the person acts]');
const arch = table.createRoom({ name: 'Old', parent_id: Z.id, alias: 'old' }, { actor: 'user' }).result;
pane('z6', 'olly');
seat(arch.id, 'z6', 'olly');
const archTask = (await person('POST', T(Z.id), { title: 'In an old group', group: 'old' })).body.task;
table.archiveRoom(arch.id, { actor: 'user' });
ok((await agent(zedP, 'POST', T(Z.id, `/${archTask.id}/pin`))).status === 403, 'the room lead can not pin a task of an archived group');
ok((await agent(zedP, 'POST', T(Z.id, `/${archTask.id}/status`), { status: 'done' })).status === 403, '...nor change its status');
ok((await agent(raeP, 'POST', T(RED.id, `/${archTask.id}/flag`))).status === 403, '...and no seat acts on it at all');
ok((await person('POST', T(Z.id, `/${archTask.id}/status`), { status: 'done' })).body.task.status === 'done', 'the person still can');

console.log('\n[14, 15: a bad % in the path is not a 500; an empty ?limit= is the default]');
const bp = await person('GET', T(Z.id, '/%E0%A4%A'));
ok(bp.status !== 500, 'a path that is not valid percent-encoding does not 500', bp.status);
ok((await person('GET', T(Z.id, '?limit='))).body.limit === 50, 'an empty ?limit= answers the default (50)');
ok((await person('GET', T(Z.id, '/timeline?hours='))).status === 200, 'an empty ?hours= is the default too');
ok((await person('GET', T(Z.id))).body.tasks.every((t: any) => typeof t.needs_you === 'boolean'), 'every task says whether it needs the person');
const blockedOnly = (await person('POST', T(Z.id), { title: 'Blocked only' })).body.task;
const bo2 = await person('POST', T(Z.id, `/${blockedOnly.id}/status`), { status: 'blocked' });
ok(bo2.body.task.needs_you === false, '6: a task that is only blocked does NOT need the person');
ok((await person('POST', T(Z.id, `/${blockedOnly.id}/flag`))).body.task.needs_you === true, '6: flagged, it does');

console.log('\n[8: a seat that leaves the room releases its tasks]');
const leaveTask = (await agent(robP, 'POST', T(RED.id), { title: 'Rob is on it' })).body.task;
await agent(robP, 'POST', T(RED.id, `/${leaveTask.id}/claim`));
await agent(robP, 'POST', T(RED.id, `/${leaveTask.id}/status`), { status: 'in-progress' });
const robSeat = table.listSeats(RED.id).find((x: any) => x.handle === 'rob')!;
const busMod = await import('../src/engine/room-bus.ts');
const heard: string[] = [];
busMod.on(busMod.ANY_ROOM, (roomId: string, ev: any) => { if (ev.type === 'room.tasks') heard.push(roomId); });
table.removeSeat(RED.id, robSeat.id, { actor: 'user' });
ok(heard.includes(Z.id) && heard.includes(RED.id), '5: a seat leaving emits room.tasks for the family, so open windows re-read');
const afterLeave = (await person('GET', T(Z.id, '?limit=200'))).body.tasks.find((t: any) => t.id === leaveTask.id);
ok(afterLeave.claimed_by === null && afterLeave.status === 'in-progress', 'the task it had claimed is unclaimed and still open for someone else');
ok((table.withRoomDb((d: any) => d.prepare(`SELECT COUNT(*) AS n FROM task_stretches WHERE task_id=? AND end_at IS NULL`).get(leaveTask.id)) as { n: number }).n === 0, '...and its stretch is closed');

ok((await agent(zedP, 'POST', T(Z.id), { title: 'sneaky', seat: 'rae' })).status === 400, 'but `seat` on ANY other verb is still a refused author key');

console.log('\n[round 2, item 2: a non-string or blank `group` matches nothing]');
const gt = (await person('POST', T(Z.id), { title: 'Group target' })).body.task;
for (const bad of [5, ' ', '', {}, [], true]) {
  const a1 = await person('POST', T(Z.id, `/${gt.id}/assign`), { group: bad });
  const a2 = await person('POST', T(Z.id), { title: 'x', group: bad });
  const label = JSON.stringify(bad);
  if (!(a1.status === 400 || a1.status === 404)) ok(false, `assign {group:${label}} is refused (got ${a1.status})`);
  if (!(a2.status === 400)) ok(false, `add {group:${label}} is a 400 (got ${a2.status})`);
}
ok((await person('POST', T(Z.id, `/${gt.id}/assign`), { group: ' ' })).status === 400 && (await person('POST', T(Z.id, `/${gt.id}/assign`), { group: 5 })).status === 400, 'assign with a blank or numeric group is a 400 naming `group`');
ok((await person('POST', T(Z.id, `/${gt.id}/assign`), { group: ' ' })).body.field === 'group' && (await person('POST', T(Z.id), { title: 'x', group: 5 })).body.field === 'group', '...and says the field');
ok((await person('GET', T(Z.id))).body.tasks.find((t: any) => t.id === gt.id).group.id === Z.id, 'and the task did NOT move (it is still in the main room)');
ok((await person('POST', T(Z.id), { title: 'no group at all' })).status === 200, 'leaving `group` out is still fine');

console.log('\n[an unknown route is not handled]');
ok((await agent(bossP, 'GET', T(M.id, '/nonsense/extra'))).handled === false, 'and on the agent door it is not on the allow-list');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
