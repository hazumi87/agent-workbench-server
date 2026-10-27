/**
 * APP POSTS ROUTE ACROSS THE ROOM FAMILY [family app routing] Owner 2026-10-05.
 * A named seat (roomLine to 'requester', tool.for) resolves across the FAMILY
 * (handles are unique in it); an app's bound pane may post a tool line into any
 * room of its family; the line reaches the seat in the room where it sits.
 * Never across families. Replies (reply_to) already resolve the author's seat
 * across the family (replySeat) and are covered here too.
 *
 * SAFETY: temp table + tools dir set BEFORE any import; fabric off; no server.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-family-routing-'));
const toolsDir = join(dir, 'tools');
mkdirSync(toolsDir, { recursive: true });
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_TOOLS_DIR = toolsDir;
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const apps = await import('../src/engine/apps.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
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
  r.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  return r;
}
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const r = {
    writeHead(s: number) { out.status = s; },
    setHeader() {},
    end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } },
  };
  await rooms.handle(req(method, url, body), r as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {} });
  return out;
}
const U = { actor: 'user' as const };
const meta = (e: any) => (typeof e?.meta === 'string' ? JSON.parse(e.meta) : e?.meta);

function pane(id: string, agent: string): void {
  table.upsertRecipe({
    id, name: agent, target: 'local', projectDir: `/x/${agent}`, vendor: 'claude-code', agent, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
  table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent, session_id: null, state: 'live', generation: 1 } as never);
}
const seat = (roomId: string, id: string) => table.addSeat(roomId, { recipe_id: id, occupant: `recipe:${id}` }, U).result;

try {
  const root = join(toolsDir, 'asset-studio');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tool.json'), JSON.stringify({
    contract: 'tool/draft-0', name: 'Asset Studio', slug: 'asset-studio', version: '0.1.0', description: 'd', access: 'shared',
    endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
    panels: [{ title: 'Studio', icon: 'image', view: 'GET /rooms/:roomId/view' }],
  }));
  apps.registerApp(root, 'user');

  for (const [id, a] of [['rec-app', 'appbound'], ['rec-req', 'req'], ['rec-lead', 'lead1'], ['rec-far', 'far'], ['rec-farapp', 'farapp']]) pane(id, a);
  const H = table.createRoom({ name: 'Main' }, U).result;
  const W1 = table.createRoom({ name: 'G1', parent_id: H.id, alias: 'g1' }, U).result;
  const W2 = table.createRoom({ name: 'G2', parent_id: H.id, alias: 'g2' }, U).result;
  const H2 = table.createRoom({ name: 'Elsewhere' }, U).result;
  const appSeat = seat(H.id, 'rec-app');
  const leadSeat = seat(W1.id, 'rec-lead');
  const reqSeat = seat(W2.id, 'rec-req');
  const farSeat = seat(H2.id, 'rec-far');
  const farApp = seat(H2.id, 'rec-farapp');
  table.setLead?.(W1.id, leadSeat.id, U);
  table.addRoomApp(H.id, 'asset-studio', [{ title: 'Studio', icon: 'image', url: `http://127.0.0.1:9999/rooms/${H.id}/view`, scripts: false, uploads: false }], U);
  const from = { paneid: 'recipe:rec-app' };
  const tool = (f: string) => ({ slug: 'asset-studio', for: f });

  console.log('\n[announce: the bound pane posts into a workgroup, for a seat in a sibling]');
  const a = await call('POST', `/api/rooms/${W1.id}/line`, { text: 'Review #21 ready', from, tool: tool('@req') });
  eq(a.status, 200, 'announce from a pane with no seat in that workgroup: 200');
  const ae = a.body?.entries?.[0];
  eq([ae?.room_id, ae?.author_seat, ae?.target_seat], [H.id, appSeat.id, reqSeat.id], "written in the app pane's own room, addressed to the requester");
  eq(a.body?.deliveries?.map((d: any) => d.handle), ['req'], 'delivered to the requester');
  eq(table.getLineEntry(ae.id) && table.xpostView(table.getLineEntry(ae.id)!, W2.id)?.direction, 'in', "shown in the requester's room");
  eq(meta(ae)?.for, reqSeat.id, 'meta.for = the seat id');
  const own = await call('POST', `/api/rooms/${W1.id}/line`, { text: 'mine', from, tool: tool('user') });
  eq(own.status, 200, 'for "user" from the family pane: 200');

  console.log('\n[announce: refused where it should be]');
  eq((await call('POST', `/api/rooms/${W1.id}/line`, { text: 'x', from, tool: tool('@far') })).status, 400, 'a handle in ANOTHER family is not resolved (400)');
  eq((await call('POST', `/api/rooms/${H2.id}/line`, { text: 'x', from, tool: tool('@far') })).status, 403, 'a non-family room still refuses the pane (403)');
  eq((await call('POST', `/api/rooms/${W1.id}/line`, { text: 'x', from, tool: { slug: 'nope', for: '@req' } })).status, 403, 'an unregistered slug gets no family reach (403)');
  eq((await call('POST', `/api/rooms/${W1.id}/line`, { text: 'x', from: { paneid: 'recipe:rec-farapp' }, tool: tool('@req') })).status, 403, "another family's pane gets none (403)");
  /* [family escalate, MCP door] night test 2026-10-06: a plain line from a family
     pane is no longer refused; it is ESCALATED — written in the pane's own room
     (never in a room it holds no seat in), cross-posted to the named one. */
  const plain = await call('POST', `/api/rooms/${W1.id}/line`, { text: 'x', from });
  eq([plain.status, plain.body?.entries?.[0]?.room_id], [200, H.id], "a plain (non-tool) line from that pane is escalated: written in the pane's own room");

  console.log('\n[panel action: roomLine to requester in a sibling workgroup]');
  const post = { appName: 'Asset Studio', verb: 'send', roomLine: { text: 'Review 21 sent', to: '@req', data: { n: 21 } }, to: 'requester' as const, data: true };
  const deps = { projector: async () => (x: any) => x, log: () => {} } as any;
  const click = (room: any) => rooms.postPanelLine(room, 'asset-studio', post, 'owner', deps);
  const p = click(W1);
  eq(p.entries?.[0]?.room_id, W2.id, "the line is posted INTO the requester's room");
  eq([p.entries?.[0]?.target_seat, p.entries?.[0]?.author], [reqSeat.id, 'user'], 'addressed to the requester, by the person');
  eq(p.warning, undefined, 'no warning (evidence counted from the announce in the head)');
  const byId = rooms.postPanelLine(W1, 'asset-studio', { ...post, roomLine: { text: 'again', to: reqSeat.id } }, 'owner', deps);
  eq(byId.entries?.[0]?.room_id, W2.id, 'by seat id too');
  const far = rooms.postPanelLine(W1, 'asset-studio', { ...post, roomLine: { text: 'x', to: '@far' } }, 'owner', deps);
  ok(/names no seat in this room or its family/.test(far.warning ?? ''), 'a seat of another family: not resolved, warning');
  eq(far.entries?.[0]?.room_id, W1.id, '...and the line stays un-addressed in the clicked room');
  const lone = rooms.postPanelLine(W1, 'asset-studio', { ...post, roomLine: { text: 'x', to: '@lead1' } }, 'owner', deps);
  ok(/has not asked this app/.test(lone.warning ?? ''), 'no evidence for a family seat: still refused');
  const un = rooms.postPanelLine(W1, 'asset-studio', { ...post, roomLine: { text: 'hello' } }, 'owner', deps);
  eq(un.entries?.[0]?.room_id, W1.id, 'no `to`: the clicked room, to its lead (unchanged)');
  void farSeat; void farApp;

  console.log('\n[reply: reply_to a line whose author sits in a sibling workgroup]');
  const ping = await call('POST', `/api/rooms/${W2.id}/line`, { text: '@lead1 question', from: { paneid: 'recipe:rec-req' } });
  const pe = ping.body?.entries?.[0];
  eq(pe?.room_id, W2.id, "the sibling seat's line is written in its own room");
  const human = { projector: async () => (x: any) => x, log: () => {}, human: true } as any;
  const out = { status: 0, body: null as any };
  const rr = { writeHead(s: number) { out.status = s; }, setHeader() {}, end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } } };
  await rooms.handle(req('POST', `/api/rooms/${W1.id}/line`, { text: 'answer', reply_to: pe.id }), rr as any, `/api/rooms/${W1.id}/line`, null, human);
  eq(out.status, 200, 'the reply posts');
  eq(out.body?.deliveries?.map((d: any) => d.handle), ['req'], 'it goes straight to the sibling seat, not the lead');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM) */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
