/**
 * A WORKGROUP SEAT ESCALATES TO THE ROOT ROOM [family escalate] Owner 2026-10-05.
 * Through the PANE-TOKEN door (what fabric's room_post calls): @lead, a family
 * handle and a sibling alias parse exactly as a person's typed line; `room` may
 * name the family head or a sibling (id or name) from a seated pane; the line is
 * authored by the pane's own seat, lives in ITS room and is cross-posted into
 * the named room, addressed to that room's lead when no @handle leads. A room of
 * another family is refused in words. SAFETY: temp table, fabric off, no server.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-family-escalate-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const paneTokens = await import('../src/engine/pane-tokens.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? msg : `${msg} (got ${a}, want ${b})`);
}
function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': 'application/json' };
  return r;
}
const deps = { projector: async () => (x: any) => x, log: () => {}, human: false } as any;
async function agent(paneid: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const r = {
    writeHead(s: number) { out.status = s; },
    setHeader() {},
    end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } },
  };
  await rooms.handleAgent(req(method, url, body), r as any, url.split('?')[0], paneid, deps);
  return out;
}
const U = { actor: 'user' as const };
function pane(id: string, agentName: string): void {
  table.upsertRecipe({
    id, name: agentName, target: 'local', projectDir: `/x/${agentName}`, vendor: 'claude-code', agent: agentName, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
  table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent: agentName, session_id: null, state: 'live', generation: 1 } as never);
}
const seat = (roomId: string, id: string) => table.addSeat(roomId, { recipe_id: id, occupant: `recipe:${id}` }, U).result;

try {
  for (const [id, a] of [['r-hl', 'rootlead'], ['r-hm', 'rootmate'], ['r-w1l', 'studiolead'], ['r-w2l', 'sibling'], ['r-fl', 'farlead']]) pane(id, a);
  const H = table.createRoom({ name: 'Alpha Platform Apps' }, U).result;
  const W1 = table.createRoom({ name: 'Studio', parent_id: H.id, alias: 'studio' }, U).result;
  const W2 = table.createRoom({ name: 'Sibling Group', parent_id: H.id, alias: 'sib' }, U).result;
  const F = table.createRoom({ name: 'Far Room' }, U).result;
  const hl = seat(H.id, 'r-hl');
  const hm = seat(H.id, 'r-hm');
  const w1l = seat(W1.id, 'r-w1l');
  const w2l = seat(W2.id, 'r-w2l');
  const fl = seat(F.id, 'r-fl');
  const me = 'recipe:r-w1l';
  const post = async (room: string, text: string) => {
    paneTokens.resetRates();
    return agent(me, 'POST', `/api/rooms/${room}/line`, { text });
  };
  const view = (r: { body: any }) => {
    const e = r.body?.entries?.[0];
    return { status: r.body?.status, room: e?.room_id, author: e?.author_seat, to: e?.target_seat, deliv: (r.body?.deliveries ?? []).map((d: any) => d.handle) };
  };

  console.log('\n[the same parse as a typed line, from a workgroup seat]');
  const lead = view(await post(W1.id, '@lead need a decision'));
  console.log('   @lead ->', JSON.stringify(lead));
  ok(lead.status, '@lead answers');
  const h = view(await post(W1.id, `@${hm.handle} ping`));
  eq([h.author, h.to, h.deliv], [w1l.id, hm.id, [hm.handle]], 'a head seat handle reaches that seat');
  const s = view(await post(W1.id, `@${w2l.handle} ping`));
  eq([s.author, s.to, s.deliv], [w1l.id, w2l.id, [w2l.handle]], 'a sibling seat handle reaches that seat');
  const al = view(await post(W1.id, '@sib hello'));
  eq(al.deliv, [w2l.handle], '@<sibling alias> reaches that room\'s lead');
  const root = view(await post(W1.id, '@root hello'));
  console.log('   @root ->', JSON.stringify(root));

  console.log('\n[room = the head / a sibling, by id or name]');
  const byId = view(await post(H.id, 'escalating'));
  eq([byId.room, byId.author, byId.to, byId.deliv], [W1.id, w1l.id, hl.id, [hl.handle]], 'room=<head id>: authored by the pane\'s seat, lives in its room, addressed to the head lead');
  const x = (await post(H.id, 'escalating')).body?.entries?.[0];
  eq(table.xpostView(table.getLineEntry(x.id)!, H.id)?.direction, 'in', '...and shown in the head room (cross-post)');
  const byName = view(await post('Alpha Platform Apps', 'by name'));
  eq(byName.deliv, [hl.handle], 'room=<head name> reaches the head lead');
  const sib = view(await post(W2.id, 'to the sibling'));
  eq(sib.deliv, [w2l.handle], 'room=<sibling id> reaches the sibling lead');
  const named = view(await post(H.id, `@${hm.handle} direct`));
  eq(named.deliv, [hm.handle], 'an @handle in the text wins over the room\'s lead');

  console.log('\n[another family is refused in words]');
  const far = await post(F.id, 'hi');
  eq(far.status, 403, 'room of another family: 403');
  ok(/@lead/.test(far.body?.message ?? '') && /Alpha Platform Apps/.test(far.body?.message ?? ''), `the refusal names what is allowed (${far.body?.message})`);
  const none = await post('no-such-room', 'hi');
  eq(none.body?.message, far.body?.message, 'a room that does not exist gets the same words');
  const own = await agent('recipe:r-fl', 'POST', `/api/rooms/${H.id}/line`, { text: 'hi' });
  eq(own.status, 403, 'a pane of the other family cannot post into this family');
  eq((await agent(me, 'GET', `/api/rooms/${H.id}/line`)).status, 403, 'READ of the head stays seated-only');

  console.log('\n[the BEARER + from door (what the fabric MCP room_post uses) — night test 2026-10-06]');
  const bearer = async (room: string, b: Record<string, unknown>): Promise<{ status: number; body: any }> => {
    const out = { status: 0, body: null as any };
    const r = {
      writeHead(s: number) { out.status = s; },
      setHeader() {},
      end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } },
    };
    const u = `/api/rooms/${room}/line`;
    await rooms.handle(req('POST', u, b), r as any, u, null, deps);
    return out;
  };
  const bh = await bearer(H.id, { from: { paneid: me }, text: 'from the MCP door' });
  eq(bh.status, 200, 'a workgroup seat posting to its HEAD room is not 403');
  const bv = view(bh);
  eq([bv.room, bv.author, bv.to, bv.deliv], [W1.id, w1l.id, hl.id, [hl.handle]], '...authored by its own seat, lives in its room, addressed to the head lead');
  const ask = (await bearer(H.id, { from: { paneid: 'recipe:r-hm' }, text: `@${w1l.handle} please ack` })).body?.entries?.[0];
  ok(ask?.id, 'a head seat asks the workgroup seat');
  const rep = view(await bearer(H.id, { from: { paneid: me }, text: 'the export is rerunning with the new cuff settings', reply_to: ask.id }));
  eq([rep.status, rep.deliv], ['posted', [hm.handle]], 'the reply (reply_to a head-room line) goes back to the asker');
  eq((await bearer(F.id, { from: { paneid: me }, text: 'hi' })).status, 403, 'another family is still 403 at the bearer door');
  eq((await bearer(H.id, { from: { paneid: 'recipe:r-fl' }, text: 'hi' })).status, 403, 'a pane of another family is still 403');

  paneTokens.resetRates();
  for (let i = 0; i < paneTokens.ROOM_POST_PER_MIN; i++) await agent(me, 'POST', `/api/rooms/${H.id}/line`, { text: 'x' });
  eq((await agent(me, 'POST', `/api/rooms/${H.id}/line`, { text: 'x' })).status, 429, 'the room_post rate limit still applies');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM) */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
