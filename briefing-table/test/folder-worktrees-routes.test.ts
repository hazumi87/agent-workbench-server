/** ROOM CODE FOLDER WORKTREES through the room routes: room-scoped names, Clean up, and the shared-folder fact. Real git in temp dirs. */
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'wb-folderwt-routes-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';
process.env.HARBOR_WB_WORKTREE_ROOT = join(dir, 'wt');
process.env.HARBOR_WB_TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local' }] });
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'wb test';
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'noreply@example.com';
delete process.env.GIT_CONFIG_COUNT;

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const wts = await import('../src/engine/worktrees.ts');
const { buildLaunch, gitSafeEnv } = await import('../src/engine/launch.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  X  ${msg}`);
  }
}
const eq = (a: unknown, b: unknown, msg: string): void => ok(Object.is(a, b), `${msg} (got ${JSON.stringify(a)})`);

try {
  const proj = join(dir, 'code', 'delta');
  const mk = await (await import('../src/engine/code-folder.ts')).makeProject(proj);
  ok(mk.ok, 'a project folder');
  function req(method: string, url: string, body?: unknown): any {
    const q = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
    q.method = method; q.url = url;
    q.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
    return q;
  }
  let launches = 0;
  async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
    const out = { status: 0, body: null as any };
    const res = { writeHead(s: number) { out.status = s; }, setHeader() {}, end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } } };
    const launch = async (_id: string, _b: Record<string, unknown>, onPane: (p: string) => void) => {
      launches++;
      const paneid = `recipe:${_id}#f${launches}`;
      onPane(paneid);
      return { ok: true as const, paneid, url: `/p/${paneid}`, path: `/p/${paneid}`, placement: 'tab' };
    };
    await rooms.handle(req(method, url, body), res as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {}, human: true, launch });
    return out;
  }
  function recipe(id: string, dirPath: string): void {
    table.upsertRecipe({ id, name: id, target: 'local', projectDir: dirPath, vendor: 'claude-code', agent: id, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
  }
  const mkRoom = (name: string): any => table.createRoom({ name, alias: name.toLowerCase() }, { actor: 'user' }).result;
  const A = mkRoom('Alpha');
  const B = mkRoom('Beta');
  for (const R of [A, B]) {
    table.setRoomCodeFolder(R.id, { mode: 'existing', dir: proj }, { actor: 'user' });
  }
  recipe('ra', proj); recipe('rb', proj);
  const sa = table.addSeat(A.id, { recipe_id: 'ra', handle: 'steward' }, { actor: 'user' }).result;
  const sb = table.addSeat(B.id, { recipe_id: 'rb', handle: 'steward' }, { actor: 'user' }).result;
  const ra = await call('POST', `/api/rooms/${A.id}/seats/${sa.id}/start`, {});
  const rb = await call('POST', `/api/rooms/${B.id}/seats/${sb.id}/start`, {});
  ok(ra.status === 200 && rb.status === 200, 'both rooms start their steward (the lead seat, first of its project)');
  const wa = table.getSessionWorktree(ra.body.paneid);
  const wb = table.getSessionWorktree(rb.body.paneid);
  ok(!!wa && !!wb && wa.name !== wb.name && wa.branch !== wb.branch, 'two rooms on one folder, same handle: different worktrees and branches');
  ok(!!wa && existsSync(join(dir, 'wt', 'delta', wa.name)), '...on disk under <root>/<project>/<room-family>/<handle>');

  console.log('\n[clean up]');
  table.upsert({ paneid: ra.body.paneid, recipe_id: 'ra', server: 'local', vendor: 'claude-code', agent: 'ra', session_id: null, state: 'live', generation: 1 } as never);
  let c = await call('POST', `/api/rooms/${A.id}/seats/${sa.id}/worktree/clean`, {});
  ok(c.status === 200 && c.body.status === 'kept' && /running/.test(c.body.reason), 'a running seat is kept, with the reason');
  table.upsert({ paneid: ra.body.paneid, recipe_id: 'ra', server: 'local', vendor: 'claude-code', agent: 'ra', session_id: null, state: 'dehydrated', generation: 1 } as never);
  writeFileSync(join(dir, 'wt', 'delta', (wa as any).name, 'wip.txt'), 'x');
  c = await call('POST', `/api/rooms/${A.id}/seats/${sa.id}/worktree/clean`, {});
  ok(c.body.status === 'kept' && /unmerged work/.test(c.body.reason), 'a dirty one is kept: unmerged work');
  rmSync(join(dir, 'wt', 'delta', (wa as any).name, 'wip.txt'));
  c = await call('POST', `/api/rooms/${A.id}/seats/${sa.id}/worktree/clean`, {});
  ok(c.body.status === 'removed' && !existsSync(join(dir, 'wt', 'delta', (wa as any).name)), 'a clean one is removed');
  ok(!table.getSessionWorktree(ra.body.paneid), '...and its record is dropped');

  console.log('\n[a folder that is not a git project]');
  const plain = join(dir, 'code', 'plainfolder');
  mkdirSync(plain, { recursive: true });
  const P = mkRoom('Plainroom');
  table.setRoomCodeFolder(P.id, { mode: 'existing', dir: plain }, { actor: 'user' });
  recipe('rp', plain);
  const s1 = table.addSeat(P.id, { recipe_id: 'rp', handle: 'one' }, { actor: 'user' }).result;
  const s2 = table.addSeat(P.id, { recipe_id: 'rp', handle: 'two' }, { actor: 'user' }).result;
  const p1 = await call('POST', `/api/rooms/${P.id}/seats/${s1.id}/start`, {});
  await call('POST', `/api/rooms/${P.id}/seats/${s2.id}/start`, {});
  eq(table.getSessionWorktree(p1.body.paneid), undefined, 'no worktree in a non-git folder');
  const facts = table.searchLines(P.id, ['share', 'folder'], 50).filter((e: any) => /agents share this folder/.test(e.body || ''));
  eq(facts.length, 1, 'the room says "agents share this folder" once');
  ok(facts[0] && /not a git project/.test(facts[0].body), '...and why');
} catch (e) {
  failed++;
  console.log('  X  threw', e);
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
