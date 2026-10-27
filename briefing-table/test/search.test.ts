/**
 * SEARCH [search] Owner 2026-10-06 (the design system BUILD-HANDOFF §1.K): the snippet rule, room line search
 * (GET /api/rooms/:id/search) and agent-chat search (agentChat.chatSearch over a Codex pane's
 * hook-delivered log, so no transcript files are needed). Temp table, no server. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-search-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const snip = await import('../src/engine/search-snippet.ts');
const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const agentChat = await import('../src/engine/agent-chat.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => {
  if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); }
};
const eq = (a: unknown, b: unknown, m: string): void => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': 'application/json' };
  return r;
}
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const r = {
    writeHead(s: number) { out.status = s; },
    setHeader() {},
    end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } },
  };
  await rooms.handle(req(method, url, body), r as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {}, human: true } as any);
  return out;
}
const plain = (parts: Array<{ t: string; hit?: true }>) => parts.map((p) => p.t).join('');
const hits = (parts: Array<{ t: string; hit?: true }>) => parts.filter((p) => p.hit).map((p) => p.t);

try {
  console.log('\n[snippet]');
  eq(snip.terms('  Workbench  SCALE workbench '), ['workbench', 'scale'], 'words: lowercased, unique');
  ok(snip.matchesAll('they said the Workbench must scale', ['workbench', 'scale']), 'every word must appear');
  ok(!snip.matchesAll('the workbench only', ['workbench', 'scale']), '...a missing word is no match');
  const long = 'x '.repeat(200) + 'they said they wanted the Workbench to be scaled to fit the entire organization, so we have to ' + 'y '.repeat(200);
  const parts = snip.snippet(long, ['workbench']);
  eq(hits(parts), ['Workbench'], 'the hit keeps its own casing and is a part of its own');
  ok(plain(parts).startsWith('… ') && plain(parts).endsWith(' …'), 'cut on both sides: marked with an ellipsis');
  ok(plain(parts).length < 260, 'about two lines');
  ok(!/\*\*/.test(plain(parts)), 'no bold markers in the text');
  eq(snip.likePattern('50%_a'), '%50' + String.fromCharCode(92) + '%' + String.fromCharCode(92) + '_a%', 'LIKE wildcards in a word are escaped');

  console.log('\n[room search]');
  const R = table.createRoom({ name: 'Main', alias: 'main' }, { actor: 'user' }).result;
  const W = table.createRoom({ name: 'UI', parent_id: R.id }, { actor: 'user' }).result;
  table.appendLine(R.id, { kind: 'fact', body: 'the workbench should scale to the org' } as any, { actor: 'user' });
  table.appendLine(R.id, { kind: 'fact', body: 'unrelated line' } as any, { actor: 'user' });
  const late = table.appendLine(R.id, { kind: 'fact', body: 'Workbench rename is moving' } as any, { actor: 'user' });
  table.appendLine(W.id, { kind: 'fact', body: 'a workbench line in the workgroup' } as any, { actor: 'user' });
  table.appendLine(R.id, { kind: 'fact', body: '100% done, really' } as any, { actor: 'user' });
  let r = await call('GET', `/api/rooms/${R.id}/search?q=workbench`);
  eq(r.status, 200, 'the route answers');
  eq(r.body.results.length, 2, 'two lines of THIS room match (the workgroup line is not shown here)');
  ok(plain(r.body.results[0].snippet).includes('rename'), 'newest first (the later line leads)');
  void late;
  ok(r.body.results.every((x: any) => hits(x.snippet).every((h: string) => h.toLowerCase() === 'workbench')), 'snippets mark the word');
  r = await call('GET', `/api/rooms/${R.id}/search?q=workbench%20scale`);
  eq(r.body.results.length, 1, 'every word must match');
  r = await call('GET', `/api/rooms/${R.id}/search?q=0%25`);
  eq(r.body.results.length, 1, 'a % in the query is literal, not a wildcard');
  r = await call('GET', `/api/rooms/${R.id}/search?q=`);
  eq(r.body.results.length, 0, 'an empty query finds nothing');
  r = await call('GET', `/api/rooms/${W.id}/search?q=workbench`);
  eq(r.body.results.length, 1, 'the workgroup finds its own line');

  console.log('\n[agent-chat search: a Codex pane, hook-delivered log]');
  const P = 'recipe:search-codex#1';
  table.upsert({ paneid: P, recipe_id: null, server: 'local', vendor: 'codex-cli', agent: null, session_id: null, state: 'live' } as never);
  agentChat.recordHookTurn(P, 'user', 'please make the Workbench search fast');
  agentChat.recordHookTurn(P, 'agent', 'done: search is fast now');
  agentChat.recordHookTurn(P, 'user', 'unrelated');
  const deps = { row: (id: string) => table.get(id) as any, log: () => {} } as any;
  const s = await agentChat.chatSearch(P, new URLSearchParams({ q: 'search fast' }), deps);
  eq(s.status, 200, 'answers');
  eq((s.body as any).results.length, 2, 'both turns with both words');
  eq((s.body as any).results[0].role, 'agent', 'newest first');
  ok((s.body as any).results.every((x: any) => x.at === null), 'found on the newest page: at = null');
  const none = await agentChat.chatSearch(P, new URLSearchParams({ q: 'zebra' }), deps);
  eq((none.body as any).results.length, 0, 'no match: empty');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: EPERM */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
