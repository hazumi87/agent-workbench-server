/**
 * E1: THE ENGINE-SERVED ROOM TOOLS (POST /mcp, server name `bt`; the design notes, briefing-table-mcp.md §2.1/§3.5).
 * Stateless JSON-RPC; the pane token is the only credential; every tool goes through the SAME functions as the HTTP agent door
 * (rooms.handleAgent), so scope, rate and byte-identical not_seated cannot differ between the two doors. A scratch table; nothing listens.
 */
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-btmcp-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_PANE_TOKENS = '1';
process.env.HARBOR_WB_SEAT_WELCOME = '0';
process.env.HARBOR_WB_BT_MCP = '1';
delete process.env.HARBOR_WB_MODE;

const { table } = await import('../src/table/endpoint.ts');
const paneTokens = await import('../src/engine/pane-tokens.ts');
const bt = await import('../src/server/bt-mcp.ts');
const rooms = await import('../src/server/rooms.ts');
const btTools = await import('../src/engine/bt-tools.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

function paneRow(paneid: string, recipe: string, state = 'live'): void {
  table.upsert({ paneid, recipe_id: recipe, server: 'local', vendor: 'claude-code', agent: recipe, session_id: null, state, generation: 1 } as never);
}
function recipe(id: string): void {
  table.upsertRecipe({ id, name: id, target: 'local', projectDir: join(dir, id), vendor: 'claude-code', agent: id, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
}
const tokenOf = (paneid: string): string => {
  const m = paneTokens.mint(paneid, 1, 'file');
  if (!m) throw new Error('no mint');
  return readFileSync(m.env[paneTokens.TOKEN_FILE_ENV], 'utf8');
};

interface Out { status: number; headers: Record<string, string>; json: any; raw: string }
async function post(body: unknown, opts: { token?: string | null; method?: string; cookie?: string; bearer?: string } = {}): Promise<Out> {
  const method = opts.method ?? 'POST';
  const q = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as any;
  q.method = method; q.url = '/mcp';
  q.headers = { 'content-type': 'application/json' } as Record<string, string>;
  if (opts.token) q.headers.authorization = `Bearer ${opts.token}`;
  if (opts.bearer) q.headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) q.headers.cookie = opts.cookie;
  const out: Out = { status: 0, headers: {}, json: null, raw: '' };
  const res = { writeHead(s: number, h?: Record<string, string>) { out.status = s; Object.assign(out.headers, h ?? {}); }, setHeader(k: string, v: string) { out.headers[k] = v; },
    end(x?: unknown) { out.raw = String(x ?? ''); try { out.json = JSON.parse(out.raw); } catch { out.json = null; } } };
  await bt.handle(q, res as any, { projector: async () => (x: any) => x, log: () => {} });
  return out;
}
const rpc = (method: string, params?: unknown, id: number | string = 1): unknown => ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
const call = (name: string, args: Record<string, unknown> = {}, id = 7): unknown => rpc('tools/call', { name, arguments: args }, id);
const toolBody = (o: Out): any => { try { return JSON.parse(o.json.result.content[0].text); } catch { return null; } };

const A = table.createRoom({ name: 'Alpha', alias: 'alpha' }, { actor: 'user' }).result;
const B = table.createRoom({ name: 'Beta', alias: 'beta' }, { actor: 'user' }).result;
recipe('ra'); recipe('rb');
paneRow('recipe:ra', 'ra');
paneRow('recipe:rb', 'rb');
const sa = table.addSeat(A.id, { recipe_id: 'ra', handle: 'steward' }, { actor: 'user' }).result;
table.startSeat(A.id, sa.id, 'recipe:ra', { actor: 'user', mode: 'rehydrate' } as never);
const sb = table.addSeat(B.id, { recipe_id: 'rb', handle: 'steward' }, { actor: 'user' }).result;
table.startSeat(B.id, sb.id, 'recipe:rb', { actor: 'user', mode: 'rehydrate' } as never);
const tokA = tokenOf('recipe:ra');
btTools.plan('recipe:ra');

console.log('\n[protocol: the stateless JSON-RPC table]');
let r = await post(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }), { token: tokA });
ok(btTools.listedAt?.('recipe:ra', 1) === null, 'initialize alone does not release Codex startup');
ok(r.status === 200 && r.json.result.serverInfo.name === 'bt' && /bt\/1/.test(r.json.result.serverInfo.version) && r.json.result.capabilities.tools, 'initialize answers serverInfo bt and a tools capability');
ok(r.json.result.protocolVersion === '2025-03-26', "...echoing the client's protocol version when supported");
r = await post(rpc('initialize', { protocolVersion: '1999-01-01' }), { token: tokA });
ok(typeof r.json.result.protocolVersion === 'string' && r.json.result.protocolVersion !== '1999-01-01', '...and answering the latest it supports when the client names one it does not');
r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { token: tokA });
ok(r.status === 202 && r.raw === '', 'a notification is 202 with no body');
r = await post(rpc('ping'), { token: tokA });
ok(r.status === 200 && JSON.stringify(r.json.result) === '{}', 'ping answers {}');
r = await post(rpc('no/such'), { token: tokA });
ok(r.json.error?.code === -32601, 'an unknown method is -32601');
r = await post(rpc('tools/list'));
ok(btTools.listedAt?.('recipe:ra', 1) === null, 'unauthenticated tools/list cannot release a pane');
r = await post(rpc('tools/list'), { token: tokA });
ok(typeof btTools.listedAt?.('recipe:ra', 1) === 'number' && btTools.listedAt?.('recipe:ra', 2) === null, 'authenticated tools/list releases only its current pane generation');
const names = (r.json.result.tools as any[]).map((t) => t.name).sort();
ok(JSON.stringify(names) === JSON.stringify(['handbook', 'room_list_mine', 'room_post', 'room_read', 'room_roster', 'session_whoami']), `tools/list: the five v1 tools plus the handbook (${names.join(', ')})`);
ok((r.json.result.tools as any[]).every((t) => t.inputSchema?.type === 'object' && /^[a-zA-Z0-9_-]{1,64}$/.test(t.name)), '...each with an object schema and a legal name');
ok(!(r.json.result.tools as any[]).some((t) => JSON.stringify(t.inputSchema).match(/"(from|author|handle|by)"/)), '...and none takes from / author / handle / by (identity is derived)');
r = await post([rpc('ping', undefined, 1), rpc('ping', undefined, 2)], { token: tokA });
ok(Array.isArray(r.json) && r.json.length === 2, 'a batch is answered per element');
r = await post(undefined, { method: 'GET' });
ok(r.status === 405, 'GET is 405 (no SSE stream)');
r = await post(undefined, { method: 'DELETE' });
ok(r.status === 405, 'DELETE is 405 (no sessions)');
r = await post('{not json', { token: tokA });
ok(r.json?.error?.code === -32700, 'a body that is not JSON is -32700');

console.log('\n[auth: pane token only; 401 only at initialize]');
r = await post(rpc('initialize', {}), {});
ok(r.status === 401, 'initialize with no credential: HTTP 401');
r = await post(rpc('initialize', {}), { bearer: 'not-a-token-at-all' });
ok(r.status === 401, 'initialize with an unknown bearer (the shared bearer looks the same): 401');
r = await post(rpc('initialize', {}), { cookie: 'wb_session=abc' });
ok(r.status === 401, 'initialize with only a cookie: 401 (cookies are never accepted)');
r = await post(call('room_list_mine'), { bearer: 'not-a-token-at-all' });
ok(r.status === 200 && r.json.result.isError === true && toolBody(r)?.error === 'token_invalid', 'tools/call with an unknown token: an isError result, never a 401, never run');
r = await post(call('room_list_mine'), {});
ok(r.status === 200 && r.json.result.isError === true && toolBody(r)?.error === 'token_invalid', 'tools/call with no token: the same');
r = await post(rpc('tools/list'), { bearer: 'not-a-token-at-all' });
ok(r.status === 200 && r.json.result.tools.length === 6, 'tools/list with a bad token is still the static list');
const tokB = tokenOf('recipe:rb');
table.revokePaneTokens('recipe:rb', 'test');
r = await post(call('room_list_mine'), { token: tokB });
ok(r.status === 200 && toolBody(r)?.error === 'token_revoked' && r.json.result.isError === true, 'a revoked token never runs a tool: isError token_revoked');
const tokB2 = tokenOf('recipe:rb');

console.log('\n[tools: the same scope as the HTTP door]');
r = await post(call('room_list_mine'), { token: tokA });
let b = toolBody(r);
ok(r.json.result.isError !== true && b.rooms.length === 1 && b.rooms[0].id === A.id && b.rooms[0].you.handle === 'steward', 'room_list_mine: only this pane\'s seated rooms, with its own seat');
ok(!JSON.stringify(b).includes(B.id), "...Beta (another pane's room) is not even named");
r = await post(call('room_post', { text: 'hello from A' }), { token: tokA });
b = toolBody(r);
ok(r.json.result.isError !== true && b.entry?.body === 'hello from A' || b?.entries?.some?.((e: any) => e.body === 'hello from A'), 'room_post: posts as this pane\'s seat (the room defaults to the one seated room)');
const lines = table.listLine(A.id, {});
ok(lines.some((e: any) => e.body === 'hello from A' && e.author === 'steward'), '...and the line is authored by the seat, found in the room');
r = await post(call('room_read', { limit: 5 }), { token: tokA });
b = toolBody(r);
ok(r.json.result.isError !== true && Array.isArray(b.entries), 'room_read: entries');
r = await post(call('room_roster'), { token: tokA });
b = toolBody(r);
ok(b.seats?.some((s: any) => s.handle === 'steward' && s.you === true), 'room_roster: seats, with you marked');
r = await post(call('session_whoami'), { token: tokA });
b = toolBody(r);
ok(b.paneid === 'recipe:ra' && b.generation === 1 && b.seats?.[0]?.handle === 'steward' && b.engine?.bt_version === 'bt/1' && !JSON.stringify(b).includes(tokA), 'session_whoami: pane, generation, seats, version; no secret');

console.log('\n[handbook(topic): read-only, a topic is only COMPARED to the listed files]');
{
  const hb = join(dir, 'handbook');
  mkdirSync(hb, { recursive: true });
  writeFileSync(join(hb, 'start-here.md'), '# Start here\n\nWelcome.\n');
  writeFileSync(join(hb, 'rooms.md'), '# Rooms\n\nA room is a place.\n');
  writeFileSync(join(hb, 'Bad_Name.md'), '# no\n');
  writeFileSync(join(hb, 'big.md'), '# Big\n' + 'x'.repeat(80 * 1024));
  writeFileSync(join(dir, 'secret.md'), 'TOPSECRET');
  try { symlinkSync(join(dir, 'secret.md'), join(hb, 'linked.md')); } catch { /* no symlinks here */ }
  process.env.HARBOR_WB_HANDBOOK_DIR = hb;
  let hr = await post(call('handbook'), { token: tokA });
  const list = toolBody(hr)?.topics ?? [];
  ok(hr.json.result.isError === false && list.map((t: any) => t.topic).join() === 'big,rooms,start-here', 'no topic: the list, sorted, only well-named regular files (a symlink and a bad name are not listed)');
  ok(list.find((t: any) => t.topic === 'rooms')?.title === 'Rooms', '...each with its title');
  hr = await post(call('handbook', { topic: 'rooms' }), { token: tokA });
  ok(toolBody(hr)?.text?.includes('A room is a place.'), 'a listed topic returns its text');
  for (const bad of ['../secret', '..', 'rooms.md', 'rooms/../rooms', '/etc/passwd', 'ROOMS', 'linked', 'nope', 'rooms\u0000', '%2e%2e%2fsecret']) {
    hr = await post(call('handbook', { topic: bad }), { token: tokA });
    ok(hr.json.result.isError === true && toolBody(hr)?.error === 'not_found' && !JSON.stringify(toolBody(hr)).includes('TOPSECRET'), `a bad topic is refused with the list, no file read: ${JSON.stringify(bad)}`);
  }
  hr = await post(call('handbook', { topic: 'big' }), { token: tokA });
  ok(toolBody(hr)?.truncated === true && toolBody(hr).text.length < 70 * 1024 && /not shown/.test(toolBody(hr).text), 'a long topic is cut at 64 KB with a note');
  process.env.HARBOR_WB_HANDBOOK_DIR = join(dir, 'no-such-folder');
  hr = await post(call('handbook'), { token: tokA });
  ok(hr.json.result.isError === false && (toolBody(hr)?.topics ?? []).length === 0, 'a missing folder is an empty handbook, not an error');
  process.env.HARBOR_WB_HANDBOOK_DIR = hb;
  process.env.HARBOR_WB_HANDBOOK = '0';
  const off = await post(rpc('tools/list'), { token: tokA });
  ok(!off.json.result.tools.some((t: any) => t.name === 'handbook') && off.json.result.tools.length === 5, 'HARBOR_WB_HANDBOOK=0: the tool is REMOVED from tools/list (not just empty)');
  hr = await post(call('handbook'), { token: tokA });
  ok(hr.json.result.isError === true && toolBody(hr)?.error === 'handbook_disabled', '...and a stale call to it answers handbook_disabled');
  const offStatic = await post(rpc('tools/list'), {});
  ok(!offStatic.json.result.tools.some((t: any) => t.name === 'handbook'), '...also in the static list a bad token sees');
  delete process.env.HARBOR_WB_HANDBOOK;
  ok((await post(rpc('tools/list'), { token: tokA })).json.result.tools.some((t: any) => t.name === 'handbook'), 'unset: back on');
  delete process.env.HARBOR_WB_HANDBOOK_DIR;
  hr = await post(call('handbook'), { token: tokA, body: undefined });
  ok(hr.json.result.isError === false, 'the shipped folder (docs/handbook) answers a list, even if still empty');
}

console.log('\n[the room argument accepts an id prefix of 8+ chars, only among the pane\'s own rooms]');
{
  const pre = await post(call('room_read', { room: A.id.slice(0, 8) }), { token: tokA });
  ok(pre.json.result.isError !== true, 'the first 8 characters of the pane\'s own room id name it (the ring prints exactly that)');
  const other8 = await post(call('room_read', { room: B.id.slice(0, 8) }), { token: tokA });
  ok(other8.json.result.isError === true && toolBody(other8)?.error === 'not_seated', "...but another pane's room by prefix is still not_seated");
  const short = await post(call('room_read', { room: A.id.slice(0, 4) }), { token: tokA });
  ok(short.json.result.isError === true, '...and a prefix under 8 characters names nothing');
}

console.log('\n[scope: byte-identical not_seated on both doors]');
// A real agent copies the doorbell's arguments; the abbreviated UUID previously
// returned not_seated, and a since equal to the notified line skipped that line.
const { ringFor } = await import('../src/engine/room-typer.ts');
const notified = table.appendLine(A.id, { kind: 'chat', body: '@steward please reply ok', target: '@steward' }, { actor: 'user' }).result[0];
const ring = ringFor([{ roomId: A.id, entryId: notified.id }]);
const ringArgs = /room_read (\{[^}]+\})/.exec(ring)?.[1];
ok(!!ringArgs, 'doorbell contains explicit room_read JSON arguments');
if (ringArgs) {
  const read = await post(call('room_read', JSON.parse(ringArgs)), { token: tokA });
  ok(read.json.result.isError !== true && toolBody(read).entries.some((e: any) => e.id === notified.id), 'following the doorbell reads the notified line in the authorized room');
}

const other = await post(call('room_read', { room: B.id }), { token: tokA });
const nonexistent = await post(call('room_read', { room: 'no-such-room-id' }), { token: tokA });
ok(other.json.result.isError === true && toolBody(other)?.error === 'not_seated', "room_read on another pane's room: isError not_seated");
ok(JSON.stringify(toolBody(other)) === JSON.stringify(toolBody(nonexistent)), 'a room that exists and one that does not give identical bytes');
const sb2 = table.addSeat(A.id, { recipe_id: 'rb', handle: 'second' }, { actor: 'user' }).result;
void sb2;
r = await post(call('room_post', { room: B.id, text: 'sneaky' }), { token: tokA });
ok(r.json.result.isError === true && !table.listLine(B.id, {}).some((e: any) => e.body === 'sneaky'), "room_post into another pane's room is refused and nothing is written");
r = await post(call('room_post', { text: 'x', from: 'recipe:rb' }), { token: tokA });
ok(!table.listLine(B.id, {}).some((e: any) => e.body === 'x'), 'an extra `from` argument is ignored: it cannot speak as another pane');
r = await post(call('room_nope'), { token: tokA });
ok(r.json.result.isError === true && toolBody(r)?.error === 'unknown_tool', 'an unknown tool is an isError unknown_tool');
r = await post(call('room_post', {}), { token: tokA });
ok(r.json.result.isError === true && /text/.test(JSON.stringify(toolBody(r))), 'room_post without text is an isError naming `text`');

console.log('\n[the rate is the HTTP door\'s: one budget]');
paneTokens.resetRates();
let limited = 0;
for (let i = 0; i < paneTokens.ROOM_POST_PER_MIN + 3; i++) {
  const x = await post(call('room_post', { text: `spam ${i}` }), { token: tokA });
  if (toolBody(x)?.error === 'rate_limited') limited++;
}
ok(limited >= 3, `after ${paneTokens.ROOM_POST_PER_MIN} posts a minute the rest are rate_limited (${limited} refused)`);

console.log('\n[the per-token tool profile: the ENGINE limits what a token may list and call]');
const tokRead = (() => { const m = paneTokens.mint('recipe:rb', 1, 'file', { profile: 'read' }); return readFileSync(m!.env[paneTokens.TOKEN_FILE_ENV], 'utf8'); })();
r = await post(rpc('tools/list'), { token: tokRead });
const readNames = (r.json.result.tools as any[]).map((t) => t.name).sort();
ok(JSON.stringify(readNames) === JSON.stringify(['handbook', 'room_list_mine', 'room_read', 'room_roster', 'session_whoami']), 'a read-profile token LISTS only the read tools (room_post is not even listed)');
r = await post(call('room_post', { text: 'should not post' }), { token: tokRead });
ok(r.json.result.isError === true && toolBody(r)?.error === 'tool_not_in_profile', 'and calling room_post with it is refused BY THE ENGINE, whatever the client sent');
ok(!table.listLine(B.id, {}).some((e: any) => e.body === 'should not post'), '...nothing was written');
r = await post(call('room_read'), { token: tokRead });
ok(r.json.result.isError !== true, '...while a read tool works');
r = await post(call('room_nope'), { token: tokRead });
ok(toolBody(r)?.error === 'unknown_tool', 'a tool that does not exist is still unknown_tool, not a profile refusal');
ok((await post(rpc('tools/list'), { token: tokA })).json.result.tools.length === 6, 'the default profile lists all six (the five plus the handbook)');
process.env.HARBOR_WB_MODE = 'local';
const hostTok = paneTokens.mintHost('recipe:rb', 1, 'read');
delete process.env.HARBOR_WB_MODE;
ok(!!hostTok && paneTokens.resolve((() => { const q: any = Readable.from([]); q.method = 'GET'; q.url = '/'; q.headers = { authorization: `Bearer ${hostTok.token}` }; return q; })())?.ok !== undefined, 'mintHost takes a profile too');
const unknownProf = paneTokens.mint('recipe:rb', 1, 'file', { profile: 'god-mode' });
const upTok = readFileSync(unknownProf!.env[paneTokens.TOKEN_FILE_ENV], 'utf8');
r = await post(rpc('tools/list'), { token: upTok });
ok(r.json.result.tools.length === 6, 'an unknown profile name at mint falls back to the DEFAULT (a mint never widens)');
const prof = await import('../src/engine/bt-profiles.ts');
ok(prof.toolsOf('god-mode').length === 5 && prof.toolsOf(undefined).length === 5, 'and a stored unknown profile read back resolves to the SMALLEST set, never the largest');
paneTokens.mint('recipe:rb', 1, 'file');

console.log('\n[the flag]');
process.env.HARBOR_WB_BT_MCP = '0';
r = await post(rpc('initialize', {}), { token: tokA });
ok(r.status === 404 && r.json?.error === 'mcp_disabled', 'HARBOR_WB_BT_MCP=0: /mcp answers 404 mcp_disabled');
r = await post(call('room_list_mine'), { token: tokA });
ok(r.json?.result?.isError === true && toolBody(r)?.error === 'mcp_disabled' || r.status === 404, '...a running pane\'s tool call is refused as mcp_disabled, not a crash');
delete process.env.HARBOR_WB_BT_MCP;
r = await post(rpc('initialize', {}), { token: tokA });
ok(r.status === 404, 'on a server engine it is off unless HARBOR_WB_BT_MCP=1');
process.env.HARBOR_WB_MODE = 'local';
r = await post(rpc('initialize', {}), { token: tokA });
ok(r.status === 200, 'in local mode it is on by default');
delete process.env.HARBOR_WB_MODE;
void rooms; void tokB2;
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
