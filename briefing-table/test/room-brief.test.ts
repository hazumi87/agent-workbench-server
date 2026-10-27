/**
 * ROOM BRIEF, engine half [room brief] (Owner 2026-10-05): rooms.brief (markdown,
 * <= 8000), set by the lead's `/brief <markdown>` or the person's PATCH, cleared
 * with `/brief clear`, shown by a bare `/brief`. Changing it posts ONE fact line
 * that never carries the content. It reads back in room detail (what room_read
 * returns) and the family view carries has_brief. SAFETY: temp table, fabric off.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-brief-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const cmds = await import('../src/server/room-commands.ts');

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
const eq = (a: unknown, b: unknown, msg: string): void => ok(Object.is(a, b), `${msg} (got ${JSON.stringify(a)})`);

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
    writeHead(s: number) { out.status = s; },
    setHeader() {},
    end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } },
  };
  await rooms.handle(req(method, url, body), r as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {}, human });
  return out;
}
function agent(id: string, name: string): void {
  table.upsertRecipe({
    id, name, target: 'local', projectDir: `/x/${name}`, vendor: 'claude-code', agent: name, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
  table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent: name, session_id: null, state: 'live', generation: 1 } as never);
}
const seat = (roomId: string, id: string, handle: string): any =>
  table.addSeat(roomId, { recipe_id: id, occupant: `recipe:${id}`, handle }, { actor: 'user' }).result;
const facts = (roomId: string): string[] => table.listLine(roomId, { limit: 500 }).filter((e: any) => e.kind === 'fact').map((e: any) => e.body);

const SAMPLE = [
  '- **Asset-Studio-Dev (@alpha-dev):** anything about the Asset Studio app itself: features, layout, bugs, tests.',
  '- **Asset Studio (@alpha-studio):** production: renders, models, reviews, and work with the operators.',
  '- **Here (root, me):** the project as a whole: priorities, decisions across workgroups, asks to @operator and @briefing-table.',
].join('\n');

try {
  agent('l', 'lead-agent');
  agent('m', 'member-agent');
  agent('w', 'wg-agent');
  const M = table.createRoom({ name: 'Alpha Platform', alias: 'apps' }, { actor: 'user' }).result;
  const lead = seat(M.id, 'l', 'lead-agent');
  seat(M.id, 'm', 'member-agent');
  const WG = table.createRoom({ name: 'Dev', parent_id: M.id, alias: 'dev' }, { actor: 'user' }).result;
  seat(WG.id, 'w', 'wg-agent');
  const post = (roomId: string, paneid: string, text: string) => call('POST', `/api/rooms/${roomId}/line`, { text, from: { paneid } });
  const uPost = (roomId: string, text: string) => call('POST', `/api/rooms/${roomId}/line`, { text }, true);

  console.log('\n[parse] the /brief verb');
  const seats = [{ id: 's1', handle: 'lead-agent', is_lead: true }];
  const p1: any = cmds.parse('/brief ' + SAMPLE, seats);
  ok(p1.type === 'room' && p1.verb === 'brief' && p1.args.text === SAMPLE, 'a multi-line markdown body is kept whole');
  ok((cmds.parse('/brief clear', seats) as any).args.clear === true, '/brief clear');
  ok((cmds.parse('/brief', seats) as any).args.show === true, 'a bare /brief shows');
  ok(cmds.ROOM_COMMANDS.some((c) => c.word === 'brief' && c.class === 'executed' && c.usage.startsWith('/brief') && c.does.length > 0), 'the table lists /brief (usage, does, executed)');

  console.log('\n[set] the lead sets it by command');
  eq(table.getRoom(M.id)?.brief, null, 'a room starts with no brief');
  const none = await post(M.id, 'recipe:l', '/brief');
  ok(none.body?.status === 'refused' && /no brief yet/.test(none.body.refused?.error), 'a bare /brief with none says so');
  const set = await post(M.id, 'recipe:l', '/brief ' + SAMPLE);
  eq(set.body?.status, 'applied', 'the lead /brief applies');
  const r1 = table.getRoom(M.id)!;
  eq(r1.brief, SAMPLE, 'the markdown is stored verbatim');
  eq(r1.brief_by, 'lead-agent', 'brief_by is the lead handle');
  ok(typeof r1.brief_at === 'number' && r1.brief_at > 0, 'brief_at is stamped');
  const f = facts(M.id).filter((b) => /room brief/.test(b));
  eq(f.length, 1, 'ONE fact line posts');
  ok(f[0] === '@lead-agent updated the room brief' && !f[0].includes('Asset Studio'), 'the fact names the lead and never carries the content');
  const show = await post(M.id, 'recipe:m', '/brief');
  ok(show.body?.client?.action === 'brief' && show.body.client.data.brief === SAMPLE, 'any member can show it (the page opens the flyout)');
  eq((await post(M.id, 'recipe:l', '/brief ' + SAMPLE)).body?.status, 'applied', 'the same text again applies');
  eq(facts(M.id).filter((b) => /room brief/.test(b)).length, 1, 'an unchanged brief posts no second fact');

  console.log('\n[refuse] a non-lead and the size cap');
  const nl = await post(M.id, 'recipe:m', '/brief something else');
  ok(nl.body?.status === 'refused' && /room commands come from the user/.test(nl.body.refused?.error) && /\/brief/.test(nl.body.refused.error), 'a non-lead is refused in words');
  eq(table.getRoom(M.id)?.brief, SAMPLE, '...and nothing changed');
  /* the typed door shares the line's own 4000-character cap (LINE_BODY_MAX); the brief's 8000 is the PATCH door's */
  const big = await uPost(M.id, '/brief ' + 'x'.repeat(4001));
  eq(big.status, 400, 'a typed /brief over the line cap is refused by the line door');
  const edge = await call('PATCH', `/api/rooms/${M.id}`, { brief: 'y'.repeat(8000) }, true);
  eq(edge.status, 200, 'exactly 8000 characters is accepted');
  ok(!facts(M.id).some((b) => b.includes('yyyy')), 'the content is not in any fact');

  console.log('\n[person] PATCH /api/rooms/:id {brief}');
  const pa = await call('PATCH', `/api/rooms/${M.id}`, { brief: '## Hi\n\nOverview' }, true);
  eq(pa.status, 200, 'the person PATCHes');
  eq(pa.body?.room?.brief, '## Hi\n\nOverview', '...and the room answers with it');
  eq(table.getRoom(M.id)?.brief_by, 'user', 'brief_by is user');
  ok(facts(M.id).some((b) => b === 'the user updated the room brief'), 'the fact names the user');
  const tooBig = await call('PATCH', `/api/rooms/${M.id}`, { brief: 'z'.repeat(8001) }, true);
  eq(tooBig.status, 413, 'the PATCH cap answers 413');
  const nonLeadPatch = await call('PATCH', `/api/rooms/${M.id}`, { brief: 'mine', from: { paneid: 'recipe:m' } });
  ok(nonLeadPatch.status === 403, 'a non-lead seat over HTTP is 403');
  const leadPatch = await call('PATCH', `/api/rooms/${M.id}`, { brief: 'by lead', from: { paneid: 'recipe:l' } });
  eq(leadPatch.status, 200, 'the lead over HTTP is allowed');
  eq(table.getRoom(M.id)?.brief_by, 'lead-agent', '...and is credited');

  console.log('\n[read] room detail and the family view');
  await post(M.id, 'recipe:l', '/brief ' + SAMPLE);
  const det = await call('GET', `/api/rooms/${M.id}`, undefined, true);
  eq(det.body?.room?.brief, SAMPLE, 'room detail carries the brief');
  eq(det.body?.room?.brief_by, 'lead-agent', '...with who set it');
  eq(det.body?.family?.workgroups?.[0]?.has_brief, false, 'a workgroup with none reads has_brief false');
  const agentRead = await call('GET', `/api/rooms/${M.id}`, undefined, false);
  eq(agentRead.body?.room?.brief, SAMPLE, 'the agent door (what room_read reads) carries it too');
  await uPost(WG.id, '/brief Dev work: **bugs**');
  const det2 = await call('GET', `/api/rooms/${M.id}`, undefined, true);
  eq(det2.body?.family?.workgroups?.[0]?.has_brief, true, 'the family entry flips has_brief');
  const wgDet = await call('GET', `/api/rooms/${WG.id}`, undefined, true);
  eq(wgDet.body?.family?.parent?.has_brief, true, 'a workgroup sees the main room has_brief');
  eq(wgDet.body?.room?.brief, 'Dev work: **bugs**', 'each room has its own brief');
  eq(det2.body?.room?.brief, SAMPLE, '...the main room keeps the family overview');

  console.log('\n[clear]');
  const cl = await post(M.id, 'recipe:l', '/brief clear');
  eq(cl.body?.status, 'applied', '/brief clear applies');
  const rc = table.getRoom(M.id)!;
  ok(rc.brief === null && rc.brief_by === null && rc.brief_at === null, 'brief, by and at are all null');
  ok(facts(M.id).some((b) => b === '@lead-agent cleared the room brief'), 'a fact says it was cleared');
  const pc = await call('PATCH', `/api/rooms/${WG.id}`, { brief: null }, true);
  eq(pc.body?.room?.brief, null, 'PATCH null clears');
  void lead;
} catch (e) {
  failed++;
  console.log(`  ✗ threw: ${(e as Error).stack}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the store holds the db */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
