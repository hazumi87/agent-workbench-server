/**
 * WORKGROUPS, engine half (Owner 2026-10-04, KB design-notes-id §3, §10): a main
 * room plus its workgroups is a FAMILY. Data (parent_id, alias, one nesting
 * level, family-unique handles, archive rules), routing (@handle anywhere in the
 * family, @lead = the head lead, @alias = that room's lead, @room = this room),
 * cross-posts (ONE line, shown in the room it was written in and in each room it
 * reached), moves, and the per-person badge cursor.
 *
 * Owner's worked scenario: main "Alpha-runtime Apps" (lead alpha-platform),
 * workgroup tool-dev (lead alpha-dev + the design system), workgroup
 * tool-operators (lead alpha-op + claude-asset-worker).
 *
 * SAFETY: a temp table set BEFORE any import; fabric off. Nothing listens,
 * nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-workgroups-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const { table, RoomError } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}
function same(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? msg : `${msg} (got ${a}, want ${b})`);
}
function refuses(fn: () => unknown, status: number, field: string, msg: string, has?: string): void {
  try {
    fn();
    ok(false, `${msg} — expected ${status} field:${field}, but it succeeded`);
  } catch (e) {
    const err = e as InstanceType<typeof RoomError>;
    const hit = e instanceof RoomError && err.status === status && err.field === field && (has === undefined || err.message.includes(has));
    ok(hit, `${msg} (${e instanceof RoomError ? `${err.status} field:${err.field} "${err.message}"` : String(e)})`);
  }
}

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  return r;
}
async function call(method: string, url: string, body?: unknown, human = false): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const r = {
    writeHead(s: number) {
      out.status = s;
    },
    setHeader() {},
    end(x?: unknown) {
      try {
        out.body = JSON.parse(String(x ?? ''));
      } catch {
        out.body = null;
      }
    },
  };
  await rooms.handle(req(method, url, body), r as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {}, human });
  return out;
}
const meta = (e: any) => (typeof e?.meta === 'string' ? JSON.parse(e.meta) : e?.meta);

function agent(id: string, name: string): void {
  table.upsertRecipe({
    id, name, target: 'local', projectDir: `/x/${name}`, vendor: 'claude-code', agent: name, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
  table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent: name, session_id: null, state: 'live', generation: 1 } as never);
}
const seat = (roomId: string, id: string, handle: string): any =>
  table.addSeat(roomId, { recipe_id: id, occupant: `recipe:${id}`, handle }, { actor: 'user' }).result;
const lineOf = (roomId: string): any[] => table.listLine(roomId, { limit: 500 }).filter((e: any) => e.kind === 'chat');
const chatBodies = (roomId: string): string[] => lineOf(roomId).map((e: any) => e.body);
const handles = (r: any): string[] => (r.body?.deliveries ?? []).map((d: any) => d.handle).sort();

try {
  for (const [id, name] of [['a', 'alpha-platform'], ['d', 'alpha-dev'], ['u', 'auriga'], ['o', 'alpha-op'], ['c', 'claude-asset-worker'], ['x', 'loner']]) {
    agent(id, name);
  }

  console.log('\n[A1 data: parent_id, alias, one level]');
  const M = table.createRoom({ name: 'Alpha-Platform Apps', alias: 'apps' }, { actor: 'user' }).result;
  eq(M.parent_id, null, 'a main room has no parent');
  eq(M.alias, 'apps', 'a main room may carry an alias');
  const Plain = table.createRoom({ name: 'Plain room' }, { actor: 'user' }).result;
  same([Plain.parent_id, Plain.alias], [null, null], 'an ordinary room reads exactly as before');
  const lead = seat(M.id, 'a', 'alpha-platform');
  eq(table.getRoom(M.id)?.lead_seat, lead.id, 'the first persistent seat leads the main room');
  const WG1 = table.createRoom({ name: 'Tool dev', parent_id: M.id, alias: 'tool-dev' }, { actor: 'user' });
  eq(WG1.result.parent_id, M.id, 'a workgroup names its main room');
  eq(WG1.result.alias, 'tool-dev', 'and its alias');
  ok(WG1.entries.some((e: any) => e.room_id === M.id && /workgroup "Tool dev"/.test(e.body)), 'the main room gets a fact about the new workgroup');
  const WG2 = table.createRoom({ name: 'Tool operators', parent_id: M.id }, { actor: 'user' }).result;
  eq(WG2.alias, 'tool-operators', 'a workgroup with no typed alias derives it from its name');
  refuses(() => table.createRoom({ name: 'Deep', parent_id: WG1.result.id, alias: 'deep' }, { actor: 'user' }), 409, 'parent_id', 'a workgroup of a workgroup is refused (one level)');
  refuses(() => table.createRoom({ name: 'Orphan', parent_id: 'nope', alias: 'orphan' }, { actor: 'user' }), 400, 'parent_id', 'a parent that does not exist is refused');
  refuses(() => table.createRoom({ name: 'Dup', parent_id: M.id, alias: 'tool-dev' }, { actor: 'user' }), 409, 'alias', 'an alias is unique across the family');
  refuses(() => table.createRoom({ name: 'Rsv', parent_id: M.id, alias: 'lead' }, { actor: 'user' }), 400, 'alias', 'a reserved word is not an alias');
  refuses(() => table.createRoom({ name: 'Rsv', parent_id: M.id, alias: 'room' }, { actor: 'user' }), 400, 'alias', '@room is not an alias either');
  refuses(() => table.createRoom({ name: 'Bad', parent_id: M.id, alias: '!!' }, { actor: 'user' }), 400, 'alias', 'a bad alias is refused');
  refuses(() => table.createRoom({ name: 'Clash', parent_id: M.id, alias: 'alpha-platform' }, { actor: 'user' }), 409, 'alias', 'an alias may not match a seat handle in the family');
  eq(table.createRoom({ name: 'Other fam', parent_id: Plain.id, alias: 'tool-dev' }, { actor: 'user' }).result.alias, 'tool-dev', 'the same alias is fine in ANOTHER family');
  const fam = table.listWorkgroups(M.id);
  same(fam.map((w: any) => w.alias), ['tool-dev', 'tool-operators'], 'a main room lists its workgroups, oldest first');

  const devLead = seat(WG1.result.id, 'd', 'alpha-dev');
  const auriga = seat(WG1.result.id, 'u', 'auriga');
  const opLead = seat(WG2.id, 'o', 'alpha-op');
  const claudeOp = seat(WG2.id, 'c', 'claude-asset-worker');

  console.log('\n[A1 handles are unique across the family]');
  refuses(() => table.addSeat(WG2.id, { project: 'x', handle: 'auriga' }, { actor: 'user' }), 409, 'handle', 'a handle held in a sibling workgroup is refused', 'Tool dev');
  refuses(() => table.addSeat(WG1.result.id, { project: 'x', handle: 'alpha-platform' }, { actor: 'user' }), 409, 'handle', 'a handle held in the main room is refused');
  refuses(() => table.addSeat(WG1.result.id, { project: 'x', handle: 'tool-operators' }, { actor: 'user' }), 409, 'handle', "a handle may not equal a room's alias");
  refuses(() => table.updateSeat(WG2.id, claudeOp.id, { handle: 'auriga' }, { actor: 'user' }), 409, 'handle', 'a rename into a sibling handle is refused');
  const ok1 = table.addSeat(WG2.id, { project: 'x', handle: 'fresh-one' }, { actor: 'user' }).result;
  eq(ok1.handle, 'fresh-one', 'a free handle is fine');
  const derived = table.addSeat(WG2.id, { project: 'auriga' }, { actor: 'user' }).result;
  ok(derived.handle !== 'auriga' && /^auriga\d/.test(derived.handle), `a DERIVED handle steps aside from a family handle (${derived.handle})`);
  table.removeSeat(WG2.id, derived.id, { actor: 'user' });
  table.removeSeat(WG2.id, ok1.id, { actor: 'user' });
  const sameInPlain = table.addSeat(Plain.id, { project: 'x', handle: 'auriga' }, { actor: 'user' }).result;
  eq(sameInPlain.handle, 'auriga', 'another family may reuse the handle');

  console.log('\n[A2 routing: user typing in workgroup 1 -> head lead + an agent in workgroup 2]');
  const uPost = (roomId: string, text: string, extra: Record<string, unknown> = {}) => call('POST', `/api/rooms/${roomId}/line`, { text, ...extra }, true);
  const r1 = await uPost(WG1.result.id, '@lead @claude-asset-worker please review the tool');
  eq(r1.status, 200, '200');
  same(handles(r1), ['alpha-platform', 'claude-asset-worker'], 'delivered to the HEAD lead and the workgroup-2 agent, nobody in workgroup 1');
  const e1 = r1.body.entries[0];
  eq(e1.room_id, WG1.result.id, 'ONE line row, authored in the room the user typed in');
  eq(e1.target, 'lead', 'stored target: lead');
  eq(e1.target_seat, lead.id, '...resolved to the HEAD lead, not the workgroup lead');
  eq(e1.xpost?.direction, 'out', 'in workgroup 1 it is OUTGOING');
  eq(e1.xpost?.local, 0, '...with nobody in workgroup 1 addressed');
  same(e1.xpost?.targets.map((t: any) => `${t.room_name}/@${t.handle}`).sort(), ['Alpha-Platform Apps/@alpha-platform', 'Tool operators/@claude-asset-worker'], 'the outgoing header names each room/@name');
  eq(chatBodies(WG1.result.id).length, 1, 'workgroup 1 shows only the user original');
  ok(chatBodies(M.id).includes('@lead @claude-asset-worker please review the tool'), 'the main room shows it (incoming)');
  ok(chatBodies(WG2.id).includes('@lead @claude-asset-worker please review the tool'), 'workgroup 2 shows it (incoming)');
  const inMain = (await call('GET', `/api/rooms/${M.id}/line`, undefined, true)).body.entries.find((e: any) => e.id === e1.id);
  eq(inMain?.xpost?.direction, 'in', 'the read API marks it INCOMING in the main room');
  eq(inMain?.xpost?.origin_name, 'Tool dev', '...from the origin room');
  same(inMain?.xpost?.targets.map((t: any) => t.handle), ['alpha-platform'], '...naming who it reached THERE');
  const inWg2 = (await call('GET', `/api/rooms/${WG2.id}/line`, undefined, true)).body.entries.find((e: any) => e.id === e1.id);
  same(inWg2?.xpost?.targets.map((t: any) => t.handle), ['claude-asset-worker'], 'and who it reached in workgroup 2');
  const wg1Seats = (await call('GET', `/api/rooms/${WG1.result.id}/line`, undefined, true)).body.entries.find((e: any) => e.id === e1.id);
  eq(wg1Seats?.xpost?.direction, 'out', 'the origin room reads it as out');
  ok(!table.listLine(WG2.id, { limit: 500 }).some((e: any) => e.kind === 'delivery' && e.room_id === WG2.id), 'no delivery noise leaks into the target room');

  console.log('\n[A3 an agent in workgroup 2 answers: out in WG2, in at main, never back in WG1]');
  const aPost = (roomId: string, paneid: string, text: string) => call('POST', `/api/rooms/${roomId}/line`, { text, from: { paneid } });
  const r2 = await aPost(WG2.id, 'recipe:c', '@lead reviewed, two notes');
  eq(r2.status, 200, '200');
  same(handles(r2), ['alpha-platform'], 'delivered to the head lead only (the op lead is NOT copied)');
  eq(r2.body.entries[0].room_id, WG2.id, "authored in the agent's own room");
  eq(r2.body.entries[0].xpost?.direction, 'out', 'outgoing in workgroup 2');
  ok(chatBodies(M.id).includes('@lead reviewed, two notes'), 'incoming in the main room');
  ok(!chatBodies(WG1.result.id).includes('@lead reviewed, two notes'), 'workgroup 1 (where the user typed) never sees it');

  console.log('\n[A3 the head lead replies to the agent: out in main, in at WG2, not WG1]');
  const r3 = await aPost(M.id, 'recipe:a', '@claude-asset-worker ship it');
  same(handles(r3), ['claude-asset-worker'], 'delivered to that agent in workgroup 2');
  eq(r3.body.entries[0].xpost?.direction, 'out', 'outgoing in the main room');
  ok(chatBodies(WG2.id).includes('@claude-asset-worker ship it'), 'incoming in workgroup 2');
  ok(!chatBodies(WG1.result.id).includes('@claude-asset-worker ship it'), 'not in workgroup 1');

  console.log('\n[A2 sibling alias, @lead, @room, default]');
  const r4 = await aPost(WG2.id, 'recipe:c', '@tool-dev can you add a verb to the tool?');
  same(handles(r4), ['alpha-dev'], 'a sibling alias reaches THAT workgroup lead from another workgroup');
  eq(r4.body.entries[0].target, 'tool-dev', 'stored target is the alias as typed');
  eq(r4.body.entries[0].target_seat, devLead.id, '...resolved to the workgroup lead seat');
  const r5 = await aPost(WG1.result.id, 'recipe:d', '@tool-operators restart the tool when you can');
  same(handles(r5), ['alpha-op'], 'and the other way round');
  const r5b = await aPost(WG1.result.id, 'recipe:d', '@apps what is the plan?');
  same(handles(r5b), ['alpha-platform'], "the main room's alias reaches the main lead");
  const r6 = await aPost(WG1.result.id, 'recipe:u', '@lead hello from auriga');
  same(handles(r6), ['alpha-platform'], '@lead from a workgroup is the HEAD lead, never the workgroup lead');
  const r7 = await aPost(WG1.result.id, 'recipe:u', 'plain words, no address');
  same(handles(r7), ['alpha-dev'], 'plain typing in a workgroup goes to ITS lead');
  eq(r7.body.entries[0].xpost, undefined, '...and is an ordinary line (no cross-post)');
  const r8 = await uPost(WG1.result.id, '@room everyone here');
  same(handles(r8), ['auriga', 'alpha-dev'].sort(), '@room reaches this room only');
  const r9 = await uPost(M.id, 'main room plain');
  same(handles(r9), ['alpha-platform'], 'plain typing in the main room goes to the main lead');
  const r10 = await uPost(M.id, '@lead main lead');
  same(handles(r10), ['alpha-platform'], '@lead in the main room is its own lead');
  const r11 = await uPost(WG1.result.id, '@nobody-here hi');
  eq(r11.body.status, 'refused', 'an unknown name is still refused');
  const r12 = await uPost(WG1.result.id, '@alpha-dev and @claude-asset-worker both');
  same(handles(r12), ['alpha-dev', 'claude-asset-worker'], 'a local and a cross-room recipient together');
  eq(r12.body.entries[0].xpost?.local, 1, 'the line is a NORMAL line for the local recipient (xpost.local = 1)');
  eq(meta(r12.body.entries[0]).xlocal, 1, '...recorded on the line');
  const r13 = await uPost(WG1.result.id, '@all hi');
  eq(r13.body.status, 'refused', '@all stays refused');

  console.log('\n[A5 the person badge]');
  const unread0 = table.unreadByRoom('owner');
  same([unread0[M.id], unread0[WG1.result.id], unread0[WG2.id]], [0, 0, 0], 'a first look starts at zero (no backlog)');
  await aPost(WG2.id, 'recipe:c', '@lead new thing');
  const unread1 = table.unreadByRoom('owner');
  eq(unread1[M.id], 0, 'the main room SHOWS the cross-posted line but does not badge it (origin only, Owner 2026-10-06)');
  eq(unread1[WG2.id], 1, 'the room the agent wrote in badges it');
  eq(unread1[WG1.result.id], 0, 'workgroup 1 shows nothing');
  await uPost(WG1.result.id, '@lead my own words');
  eq(table.unreadByRoom('owner')[WG2.id], 1, "the person's own lines never raise a badge");
  const newest = table.listLine(M.id, { limit: 1 })[0].id;
  eq(table.markRoomSeen('owner', M.id, newest), newest, 'seen advances the cursor');
  eq(table.markRoomSeen('owner', M.id, 1), newest, '...and never moves it back');
  eq(table.unreadByRoom('owner')[M.id], 0, 'opened = badge cleared');
  eq(table.unreadByRoom('someone-else')[M.id], 0, 'cursors are per person');

  console.log('\n[the badge counts what the "to me" view shows] Owner 2026-10-06');
  table.setRoomSettings(M.id, { feed_default: { kinds: ['chat', 'fact'], who: 'me' } } as never);
  const before = table.unreadByRoom('owner')[WG2.id];
  await aPost(WG2.id, 'recipe:c', '@lead model to agent');
  eq(table.unreadByRoom('owner')[WG2.id], before, 'an agent-to-agent line raises no badge under an inherited "to me"');
  await aPost(WG2.id, 'recipe:c', '@user for you');
  eq(table.unreadByRoom('owner')[WG2.id], before + 1, 'a line addressed to the person does');
  table.setRoomSettings(WG2.id, { feed_default: { kinds: ['chat'], who: '' } } as never);
  const all = table.unreadByRoom('owner')[WG2.id];
  ok(all > before + 1, `a room whose own view is "everyone" counts the agent-to-agent lines too (${all})`);
  await aPost(WG2.id, 'recipe:c', '@lead model to agent again');
  eq(table.unreadByRoom('owner')[WG2.id], all + 1, '...and every new one');
  console.log('\n[cross-family unread] Owner 2026-10-06');
  const lastLine = await aPost(WG2.id, 'recipe:c', '@user the newest counted line');
  const lastId = lastLine.body.entries[0].id;
  const det = table.unreadDetail('owner');
  ok(Array.isArray(det) && det.length >= 3 && det.every((r: any) => ['roomId', 'name', 'familyHeadId', 'unread', 'newestId', 'color'].every((k) => k in r)), 'one row per open room, with the documented fields');
  eq(det.find((r: any) => r.roomId === WG2.id)!.familyHeadId, M.id, 'a workgroup names its main room as the family head');
  eq(det.find((r: any) => r.roomId === M.id)!.familyHeadId, M.id, 'a main room is its own head');
  const counted2 = table.unreadByRoom('owner');
  ok(det.every((r: any) => r.unread === counted2[r.roomId]), 'the counts are exactly the badge counts (one source)');
  eq(det.find((r: any) => r.roomId === WG2.id)!.newestId, lastId, 'newestId is the newest COUNTED line of the room');
  const quiet = det.find((r: any) => r.unread === 0);
  ok(!quiet || quiet.newestId === null, 'a room with nothing unread has newestId null');
  const api = await call('GET', '/api/rooms/me/unread', undefined, true);
  eq(api.status, 200, 'GET /api/rooms/me/unread: 200 for a person');
  ok(Array.isArray(api.body?.rooms) && api.body.rooms.length === det.length, '...{rooms: [...]} over every open room');
  eq((await call('GET', '/api/rooms/me/unread', undefined, false)).status, 403, '...and a bearer (no human) is refused');
  console.log('\n[unread_to_me: always the lines addressed to the person] Owner 2026-10-25 ([ref])');
  {
    const c0 = table.unreadCounts('owner');
    eq(c0.unread[WG1.result.id], c0.toMe[WG1.result.id], 'a room whose feed is "me" (inherited from the main room): the two numbers are the same');
    ok(det.every((r: any) => 'unread_to_me' in r && 'newest_to_me' in r), 'every me/unread row carries unread_to_me and newest_to_me');
    ok(api.body.rooms.every((r: any) => typeof r.unread_to_me === 'number'), '...over the API too');
    await aPost(WG2.id, 'recipe:c', '@lead model to agent, to-me test');
    const agentLine = table.listLine(WG2.id, { limit: 1 })[0].id;
    const c1 = table.unreadCounts('owner');
    eq(c1.unread[WG2.id], c0.unread[WG2.id] + 1, 'WG2 (its own view is everyone): an agent-to-agent line raises unread');
    eq(c1.toMe[WG2.id], c0.toMe[WG2.id], '...and does NOT raise unread_to_me');
    const forMe = await aPost(WG2.id, 'recipe:c', '@user for you, to-me test');
    const forMeId = forMe.body.entries[0].id;
    const c2 = table.unreadCounts('owner');
    same([c2.unread[WG2.id], c2.toMe[WG2.id]], [c1.unread[WG2.id] + 1, c1.toMe[WG2.id] + 1], 'a line addressed to the person raises both');
    await aPost(WG2.id, 'recipe:c', '@lead one more agent-to-agent line');
    const row = table.unreadDetail('owner').find((r: any) => r.roomId === WG2.id)!;
    eq(row.newest_to_me, forMeId, 'newest_to_me is the newest line ADDRESSED to the person');
    ok((row.newestId as number) > forMeId && row.newestId !== row.newest_to_me, '...while newestId (the feed rule) is the later agent line');
    ok(agentLine < forMeId, '(setup: the agent-to-agent line came first)');
    const quietRow = table.unreadDetail('owner').find((r: any) => r.unread_to_me === 0);
    ok(!quietRow || quietRow.newest_to_me === null, 'a room with nothing addressed to the person has newest_to_me null');
    const newest = table.listLine(WG2.id, { limit: 1 })[0].id;
    table.markRoomSeen('owner', WG2.id, newest);
    const c3 = table.unreadCounts('owner');
    same([c3.unread[WG2.id], c3.toMe[WG2.id]], [0, 0], 'opening the room clears BOTH numbers');
    ok(table.unreadCounts('someone-else').toMe[WG2.id] > 0, 'cursors stay per person: another person still has those lines unread');
  }
  table.setRoomSettings(WG2.id, { feed_default: null } as never);
  table.setRoomSettings(M.id, { feed_default: null } as never);
  const listed = (await call('GET', '/api/rooms', undefined, true)).body;
  const mView = listed.find((v: any) => v.room.id === M.id);
  same(mView.family.workgroups.map((w: any) => w.alias), ['tool-dev', 'tool-operators'], 'GET /api/rooms lists the workgroups on the main room');
  eq(typeof mView.unread, 'number', '...with the person unread count');
  eq(typeof mView.family.workgroups[0].unread, 'number', '...and per workgroup');
  eq(typeof mView.unread_to_me, 'number', '...and unread_to_me beside it');
  eq(typeof mView.family.workgroups[0].unread_to_me, 'number', '...and per workgroup');
  eq(typeof listed.find((v: any) => v.room.id === WG1.result.id).family.parent.unread_to_me, 'number', '...and on the parent entry of a workgroup');
  eq(listed.find((v: any) => v.room.id === WG1.result.id).family.parent.id, M.id, 'a workgroup names its parent');
  /* [room last] Owner 2026-10-07: each room card shows its newest chat line */
  {
    const longBody = 'the Workbench card shows this line ' + 'x'.repeat(300);
    table.appendLine(M.id, { kind: 'chat', author: 'user', body: longBody } as any, { actor: 'user' });
    table.appendLine(M.id, { kind: 'fact', body: 'a fact is not the last line' } as any, { actor: 'user' });
    const again = (await call('GET', '/api/rooms', undefined, true)).body.find((v: any) => v.room.id === M.id);
    eq(again.last?.author, 'user', 'GET /api/rooms: last = the newest chat line (a later fact does not count)');
    ok(typeof again.last?.ts === 'number' && again.last.text.startsWith('the Workbench card shows this line') && again.last.text.length <= 160 && again.last.text.endsWith(String.fromCharCode(8230)), '...cut to 160 chars with an ellipsis');
  }
  const seenRoute = await call('PUT', `/api/rooms/${WG2.id}/seen`, { last_seen_line_id: 9999 }, true);
  eq(seenRoute.status, 200, 'PUT .../seen (a person)');
  eq((await call('PUT', `/api/rooms/${WG2.id}/seen`, { last_seen_line_id: 5 }, false)).status, 403, 'an agent bearer cannot move a person cursor');

  console.log('\n[A4 moves keep the name and the session]');
  const moved = await call('POST', `/api/rooms/${WG1.result.id}/seats/${auriga.id}/move`, { to_room: WG2.id }, true);
  eq(moved.status, 200, '200');
  eq(moved.body.seat.room_id, WG2.id, 'the seat is in workgroup 2');
  eq(moved.body.seat.handle, 'auriga', 'same handle');
  eq(moved.body.seat.occupant, 'recipe:u', 'same session (the pane stays)');
  eq(moved.body.seat.id, auriga.id, 'same seat row');
  ok(moved.body.entries.some((e: any) => e.room_id === WG1.result.id && e.body === '@auriga moved to the Tool operators workgroup · same name, same session'), 'the old room is told');
  ok(moved.body.entries.some((e: any) => e.room_id === WG2.id && e.body === '@auriga moved here from Tool dev · same name, same session'), 'the new room is told');
  same(table.listSeats(WG1.result.id).map((s: any) => s.handle), ['alpha-dev'], 'it left the old roster');
  ok(table.listSeats(WG2.id).some((s: any) => s.handle === 'auriga'), 'and joined the new one');
  const r14 = await aPost(WG2.id, 'recipe:c', '@auriga over to you');
  same(handles(r14), ['auriga'], 'it is addressable as before, now as a local seat');
  eq(r14.body.entries[0].xpost, undefined, '...a normal line, not a cross-post');
  eq((await aPost(WG2.id, 'recipe:u', '@lead from the new room')).body.entries[0].xpost?.direction, 'out', 'and it speaks from its new room');
  eq((await call('POST', `/api/rooms/${WG2.id}/seats/${opLead.id}/move`, { to_room: M.id }, true)).body?.field, 'seat', 'the lead cannot move (hand the lead over first)');
  eq((await call('POST', `/api/rooms/${WG2.id}/seats/${claudeOp.id}/move`, { to_room: Plain.id }, true)).status, 409, 'a move leaves the family: refused');
  eq((await call('POST', `/api/rooms/${WG2.id}/seats/${claudeOp.id}/move`, { to_room: WG2.id }, true)).status, 400, 'moving to the same room: refused');
  eq((await call('POST', `/api/rooms/${WG2.id}/seats/${claudeOp.id}/move`, { to_room: M.id })).status, 403, 'a bearer cannot move a seat');
  const toMain = await call('POST', `/api/rooms/${WG2.id}/seats/${auriga.id}/move`, { to_room: M.id }, true);
  ok(toMain.body.entries.some((e: any) => /main room "Alpha-Platform Apps"/.test(e.body)), 'a move to the main room says so');

  console.log('\n[A1 archive rules]');
  refuses(() => table.archiveRoom(M.id, { actor: 'user' }), 409, 'state', 'a main room with live workgroups cannot be archived', 'Tool dev');
  const lonely = table.createRoom({ name: 'Scratch group', parent_id: Plain.id, alias: 'scratch' }, { actor: 'user' }).result;
  eq(table.archiveRoom(lonely.id, { actor: 'user' }).result.state, 'archived', 'a workgroup archives on its own');
  eq(table.getRoom(Plain.id)?.state, 'open', '...its main room is untouched');
  eq(table.createRoom({ name: 'Again', parent_id: Plain.id, alias: 'scratch' }, { actor: 'user' }).result.alias, 'scratch', "an archived workgroup's alias is free again");
  refuses(() => table.createRoom({ name: 'In a box', parent_id: lonely.id, alias: 'x1' }, { actor: 'user' }), 409, 'parent_id', 'no workgroup under a workgroup, archived or not');
  const viaRoute = await call('POST', `/api/rooms/${M.id}/archive`, {}, true);
  eq(viaRoute.status, 409, 'the archive route answers 409');
  ok(String(viaRoute.body?.error ?? '').includes('Tool operators'), '...naming the live workgroups');
  for (const w of table.listWorkgroups(M.id)) {
    table.archiveRoom(w.id, { actor: 'user' });
  }
  eq(table.archiveRoom(M.id, { actor: 'user' }).result.state, 'archived', 'after its workgroups are archived the main room can be');
  refuses(() => table.reopenRoom(table.listWorkgroups(M.id)[0].id, { actor: 'user' }), 409, 'state', 'a workgroup cannot reopen under an archived main room');

  console.log('\n[A1 routes: create a workgroup, agent sees the family]');
  const mk = await call('POST', '/api/rooms', { name: 'Via route', parent_id: Plain.id, alias: 'via-route' }, true);
  eq(mk.status, 200, 'POST /api/rooms with parent_id');
  eq(mk.body.parent_id, Plain.id, '...returns it');
  eq(mk.body.alias, 'via-route', '...and its alias');
  eq((await call('POST', '/api/rooms', { name: 'Dup route', parent_id: Plain.id, alias: 'via-route' }, true)).status, 409, 'a clashing alias answers 409');
  const agentList = await call('GET', '/api/rooms', undefined, false);
  ok(Array.isArray(agentList.body), 'the room list answers');
} catch (e) {
  failed++;
  console.log(`  ✗ threw: ${(e as Error).stack}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM) */ }
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
