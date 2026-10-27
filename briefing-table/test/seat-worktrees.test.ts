/**
 * SEAT WORKTREES (Owner 2026-10-05, worktree convention, KB design-notes-id
 * section 12). Real git in temp dirs: a bare "origin", a project clone, and a
 * worktree root of the test's own (HARBOR_WB_WORKTREE_ROOT) - never
 * /srv/worktrees. Layers:
 *   1. engine/worktrees.ts: create, reuse, skips, and the removal rules (kept
 *      when dirty or unpushed, removed when clean and pushed, never a force,
 *      never a branch delete);
 *   2. the room routes with a stub launcher: the second same-project seat gets
 *      a worktree, the first does not, `worktree:'never'` and non-code vendors
 *      opt out, a restart reuses it, removal reports a room fact;
 *   3. the launch env: a worktree seat carries git's safe.directory pairs, a
 *      plain seat carries none.
 * Run with tsx.
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'wb-seatwt-'));
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
function execFileSyncOk(cwd: string): boolean {
  try {
    execFileSync('git', ['-C', cwd, 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

/* ---- fixtures: origin (bare), and a project clone with one commit on main ---- */
function mkProject(name: string): string {
  const origin = join(dir, 'origin', `${name}.git`);
  mkdirSync(origin, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  const proj = join(dir, 'code', name);
  mkdirSync(join(dir, 'code'), { recursive: true });
  execFileSync('git', ['clone', origin, proj], { stdio: 'ignore' });
  git(proj, 'checkout', '-b', 'main');
  writeFileSync(join(proj, 'README.md'), `# ${name}\n`);
  git(proj, 'add', '.');
  git(proj, 'commit', '-m', 'init');
  git(proj, 'push', 'origin', 'main');
  return proj;
}

try {
  const proj = mkProject('alpha');

  console.log('\n[ensureWorktree: create, reuse, skips]');
  let r = await wts.ensureWorktree({ projectDir: proj, name: 'seat-a' });
  ok(r.ok && r.created, 'first call creates it');
  const wtA = join(dir, 'wt', 'alpha', 'seat-a');
  ok(r.ok && r.path === wtA && r.branch === 'wg/seat-a', 'at <root>/<project>/<agent-name>, branch wg/<agent-name>');
  ok(existsSync(join(dir, 'wt', 'alpha', '_base', '.git')), 'a _base clone exists');
  eq(git(join(dir, 'wt', 'alpha', '_base'), 'config', 'core.sharedRepository'), 'group', '_base is group-shared');
  eq(git(wtA, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wg/seat-a', 'the worktree is on its branch');
  eq(git(wtA, 'rev-parse', 'HEAD'), git(proj, 'rev-parse', 'origin/main'), '...cut from origin/main');
  writeFileSync(join(wtA, 'mine.txt'), 'work');
  git(wtA, 'add', '.');
  git(wtA, 'commit', '-m', 'seat work');
  const tip = git(wtA, 'rev-parse', 'HEAD');
  r = await wts.ensureWorktree({ projectDir: proj, name: 'seat-a' });
  ok(r.ok && !r.created, 'a restart reuses the worktree');
  eq(git(wtA, 'rev-parse', 'HEAD'), tip, '...with its commit untouched (never reset)');
  r = await wts.ensureWorktree({ projectDir: join(dir, 'nowhere'), name: 'x' });
  ok(!r.ok, 'a non-git dir is skipped');
  const bare = join(dir, 'code', 'norigin');
  mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', bare], { stdio: 'ignore' });
  r = await wts.ensureWorktree({ projectDir: bare, name: 'x' });
  ok(!r.ok && /no origin/.test((r as any).reason), 'no origin remote is skipped, with the reason');
  r = await wts.ensureWorktree({ projectDir: proj, name: 'Bad Name' });
  ok(!r.ok && /slug/.test((r as any).reason), 'an agent name outside the slug grammar is refused');

  console.log('\n[removeWorktree: only clean AND fully pushed; never force, never a branch delete]');
  let rm = await wts.removeWorktree({ project: 'alpha', name: 'seat-a' });
  ok(rm.status === 'kept' && /unmerged work/.test((rm as any).reason), 'a clean tree with an UNPUSHED commit is kept: unmerged work');
  writeFileSync(join(wtA, 'dirty.txt'), 'x');
  rm = await wts.removeWorktree({ project: 'alpha', name: 'seat-a' });
  ok(rm.status === 'kept' && /unmerged work/.test((rm as any).reason), 'a dirty tree is kept: unmerged work');
  ok(existsSync(wtA), '...and still on disk');
  rmSync(join(wtA, 'dirty.txt'));
  git(wtA, 'push', 'origin', 'wg/seat-a');
  rm = await wts.removeWorktree({ project: 'alpha', name: 'seat-a' });
  eq(rm.status, 'removed', 'clean and fully pushed is removed');
  ok(!existsSync(wtA), '...gone from disk');
  ok(git(join(dir, 'wt', 'alpha', '_base'), 'branch', '--list', 'wg/seat-a') !== '', '...its branch is never deleted');
  rm = await wts.removeWorktree({ project: 'alpha', name: 'seat-a' });
  eq(rm.status, 'absent', 'nothing to remove is absent');
  r = await wts.ensureWorktree({ projectDir: proj, name: 'seat-a' });
  ok(r.ok && r.created && git(r.path, 'rev-parse', 'HEAD') === tip, 'a re-created seat gets its kept branch back, history intact');
  await wts.removeWorktree({ project: 'alpha', name: 'seat-a' });
  r = await wts.ensureWorktree({ projectDir: proj, name: 'fresh-one' });
  rm = await wts.removeWorktree({ project: 'alpha', name: 'fresh-one' });
  eq(rm.status, 'removed', 'a fresh clean worktree (at origin/main) is removed');
  const lockedBase = join(dir, 'wt', 'alpha', '_base');
  r = await wts.ensureWorktree({ projectDir: proj, name: 'locked-one' });
  git(lockedBase, 'worktree', 'lock', (r as any).path);
  rm = await wts.removeWorktree({ project: 'alpha', name: 'locked-one' });
  ok(rm.status === 'kept' && /locked/.test((rm as any).reason), 'a locked worktree is kept: locked (no force)');
  ok(wts.listOrphans('alpha', []).includes('locked-one') && !wts.listOrphans('alpha', []).includes('_base'), 'listOrphans lists, and skips _base');
  git(lockedBase, 'worktree', 'unlock', (r as any).path);
  await wts.removeWorktree({ project: 'alpha', name: 'locked-one' });

  console.log('\n[a moved root: repaired, then reused]');
  r = await wts.ensureWorktree({ projectDir: proj, name: 'mover' });
  const oldPath = (r as any).path;
  writeFileSync(join(oldPath, 'inflight.txt'), 'uncommitted');
  const rootB = join(dir, 'wt-moved');
  renameSync(join(dir, 'wt'), rootB);
  process.env.HARBOR_WB_WORKTREE_ROOT = rootB;
  ok(execFileSyncOk(join(rootB, 'alpha', 'mover')) === false, 'after the move its .git link is broken (git cannot read it)');
  r = await wts.ensureWorktree({ projectDir: proj, name: 'mover' });
  ok(r.ok && !r.created && r.path === join(rootB, 'alpha', 'mover'), 'a restart reuses it under the new root');
  ok(execFileSyncOk(join(rootB, 'alpha', 'mover')), '...after `git worktree repair` (git reads it again)');
  ok(existsSync(join(rootB, 'alpha', 'mover', 'inflight.txt')), '...with its uncommitted file intact');
  eq(git(join(rootB, 'alpha', 'mover'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'wg/mover', '...on its branch');
  await wts.removeWorktree({ project: 'alpha', name: 'mover' });
  renameSync(rootB, join(dir, 'wt'));
  process.env.HARBOR_WB_WORKTREE_ROOT = join(dir, 'wt');

  console.log('\n[the room routes]');
  function req(method: string, url: string, body?: unknown): any {
    const q = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
    q.method = method;
    q.url = url;
    q.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
    return q;
  }
  const logs: string[] = [];
  let launches = 0;
  async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
    const out = { status: 0, body: null as any };
    const res = {
      writeHead(s: number) { out.status = s; },
      setHeader() {},
      end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } },
    };
    const launch = async (_id: string, _b: Record<string, unknown>, onPane: (p: string) => void) => {
      launches++;
      const paneid = `recipe:${_id}#w${launches}`;
      onPane(paneid);
      return { ok: true as const, paneid, url: `/p/${paneid}`, path: `/p/${paneid}`, placement: 'tab' };
    };
    await rooms.handle(req(method, url, body), res as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: (m: string) => logs.push(m), human: true, launch });
    return out;
  }
  function recipe(id: string, dirPath: string, over: Record<string, unknown> = {}): void {
    table.upsertRecipe({
      id, name: id, target: 'local', projectDir: dirPath, vendor: 'claude-code', agent: id, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null, ...over,
    } as never);
  }
  const live = (id: string): void => table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent: id, session_id: null, state: 'live', generation: 1 } as never);
  const M = table.createRoom({ name: 'Main', alias: 'main' }, { actor: 'user' }).result;
  const seatOf = (id: string, handle: string): any => table.addSeat(M.id, { recipe_id: id, handle }, { actor: 'user' }).result;
  const start = (s: any, b: Record<string, unknown> = {}) => call('POST', `/api/rooms/${M.id}/seats/${s.id}/start`, b);

  recipe('first', proj);
  seatOf('first', 'lead-seat'); // the room's lead (a lead cannot be removed)
  live('first'); // the project's first instance, in the main checkout
  recipe('second', proj);
  const s2 = seatOf('second', 'second-seat');
  let a = await start(s2);
  eq(a.status, 200, 'the second instance starts');
  const wt2 = join(dir, 'wt', 'alpha', 'second-seat');
  ok(existsSync(wt2), '...in a worktree at <root>/alpha/second-seat');
  const pane2 = a.body.paneid;
  eq(JSON.stringify([table.getSessionWorktree(pane2)?.project, table.getSessionWorktree(pane2)?.name]), '["alpha","second-seat"]', '...bound to its pane as <project>/<name>, relative to the root (the per-session cwd)');
  ok(!('path' in (table.getSessionWorktree(pane2) as object)), '...never an absolute path');
  eq(table.getSessionWorktree(pane2)?.branch, 'wg/second-seat', '...with its branch');
  eq(a.body.seat?.occupant?.worktree ?? null, null, 'the occupant of a not-yet-attached pane has no row yet, so no payload (below: once it has one)');
  table.upsert({ paneid: pane2, recipe_id: 'second', server: 'local', vendor: 'claude-code', agent: 'second', session_id: null, state: 'live', generation: 1 } as never);
  let seats = await call("GET", `/api/rooms/${M.id}`);
  const payload = seats.body.seats.find((x: any) => x.handle === 'second-seat');
  eq(payload?.occupant?.worktree?.branch, 'wg/second-seat', 'the occupant payload carries worktree {path, branch}');
  eq(payload?.occupant?.worktree?.path, wt2, '...with the path');

  recipe('lonely', mkProject('beta'));
  a = await start(seatOf('lonely', 'lonely-seat'));
  eq(table.getSessionWorktree(a.body.paneid), undefined, 'the FIRST instance of a project gets no worktree');
  ok(!existsSync(join(dir, 'wt', 'beta')), '...and nothing is created for it');

  recipe('never', proj, { worktree: 'never' });
  a = await start(seatOf('never', 'never-seat'));
  eq(table.getSessionWorktree(a.body.paneid), undefined, "recipe worktree 'never' opts out");
  eq(table.getRecipe('never')?.worktree, 'never', "...and the column round-trips");
  recipe('shell', proj, { vendor: 'cli-manager' });
  a = await start(seatOf('shell', 'shell-seat'));
  eq(table.getSessionWorktree(a.body.paneid), undefined, 'a non-code vendor gets none');
  const plain = join(dir, 'code', 'plain');
  mkdirSync(plain, { recursive: true });
  recipe('p1', plain);
  live('p1');
  recipe('p2', plain);
  a = await start(seatOf('p2', 'p2-seat'));
  eq(table.getSessionWorktree(a.body.paneid), undefined, 'a non-git project is skipped');
  ok(logs.some((l) => /worktree not created for @p2-seat: .*not a git repository/.test(l)), '...with a log line');
  recipe('away', proj, { target: 'elsewhere' });
  process.env.HARBOR_WB_TARGETS = JSON.stringify({ targets: [
    { id: 'local', label: 'Local', kind: 'local' },
    { id: 'elsewhere', label: 'VRPC', kind: 'local', broker: 'vrpc' },
    { id: 'gptops', label: 'chat-ops', kind: 'local', broker: 'chatgpt', node: 'homebase' },
  ] });
  a = await start(seatOf('away', 'away-seat'));
  eq(table.getSessionWorktree(a.body.paneid), undefined, "another host's target is skipped");
  ok(logs.some((l) => /worktree not created for @away-seat: target elsewhere is not on this engine's host/.test(l)), '...with a log line');
  recipe('gpt', proj, { target: 'gptops', vendor: 'codex-cli' });
  a = await start(seatOf('gpt', 'gpt-seat'));
  ok(a.body.paneid && table.getSessionWorktree(a.body.paneid)?.name === 'gpt-seat', 'a seat that runs as ANOTHER account (chat-ops) still gets one');

  console.log('\n[restart reuses; removal reports a room fact]');
  writeFileSync(join(wt2, 'seat.txt'), 'work in progress');
  table.setState(pane2, 'killed');
  logs.length = 0;
  a = await start(s2);
  eq(a.status, 200, 'the seat restarts');
  ok(logs.some((l) => /worktree for @second-seat: .* reused/.test(l)), '...reusing its worktree');
  ok(existsSync(join(wt2, 'seat.txt')), '...with its uncommitted file intact');
  const lines = async (): Promise<string[]> => ((await call('GET', `/api/rooms/${M.id}/line`)).body.entries ?? []).map((e: any) => e.body ?? '');
  table.setState(a.body.paneid, 'killed');
  let d = await call('DELETE', `/api/rooms/${M.id}/seats/${s2.id}`, {});
  eq(d.status, 200, 'the seat is removed');
  ok(existsSync(wt2), 'a dirty worktree is kept');
  ok((await lines()).some((l) => /@second-seat's worktree .*kept: unmerged work/.test(l)), '...and the room is told: kept: unmerged work');
  const s3 = seatOf('gpt', 'gpt-seat-2');
  const wt3 = await wts.ensureWorktree({ projectDir: proj, name: 'gpt-seat-2' });
  ok(wt3.ok, 'a clean worktree for another seat');
  d = await call('DELETE', `/api/rooms/${M.id}/seats/${s3.id}`, {});
  ok(!existsSync(join(dir, 'wt', 'alpha', 'gpt-seat-2')), 'a clean, fully pushed worktree is removed with its seat');
  ok((await lines()).some((l) => /@gpt-seat-2's worktree wg\/gpt-seat-2 was removed/.test(l)), '...and the room is told');

  console.log('\n[the launch env]');
  const base = join(dir, 'wt', 'alpha', '_base');
  const rec: any = { id: 'r', name: 'r', target: 'local', projectDir: wt2, vendor: 'cli-manager', agent: 'r', runClaude: 0, model: null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null, created_at: 0, updated_at: 0, last_launched_at: null };
  const L: any = { id: 'local', label: 'L', kind: 'local', broker: 'local' };
  const SSH: any = { id: 'homebase', label: 'N', kind: 'ssh', sshAlias: 'some-alias', broker: 'local' };
  let spec: any = buildLaunch(rec, L, null, null, { paneid: 'p', worktree: { path: wt2, base } });
  const env = spec.descriptor.env ?? {};
  eq(env.GIT_CONFIG_COUNT, '2', 'a worktree seat: GIT_CONFIG_COUNT=2');
  eq(env.GIT_CONFIG_KEY_0, 'safe.directory', '...KEY_0 safe.directory');
  eq(env.GIT_CONFIG_VALUE_0, wt2, '...VALUE_0 the worktree');
  eq(env.GIT_CONFIG_KEY_1, 'safe.directory', '...KEY_1 safe.directory');
  eq(env.GIT_CONFIG_VALUE_1, base, '...VALUE_1 the _base');
  spec = buildLaunch(rec, L, null, null, { paneid: 'p' });
  ok(!Object.keys(spec.descriptor.env ?? {}).some((k) => k.startsWith('GIT_CONFIG')), 'a plain seat carries no GIT_CONFIG keys');
  spec = buildLaunch(rec, SSH, null, null, { paneid: 'p', worktree: { path: wt2, base } });
  const remote = JSON.stringify(spec.descriptor);
  ok(/GIT_CONFIG_COUNT=/.test(remote) && remote.includes('GIT_CONFIG_VALUE_1'), 'an ssh seat exports them on its command line');
  const g = gitSafeEnv(wt2, base, { GIT_CONFIG_COUNT: '3' });
  eq(g.GIT_CONFIG_COUNT, '5', 'an existing GIT_CONFIG_COUNT is appended to');
  eq(g.GIT_CONFIG_KEY_3, 'safe.directory', '...the new pairs take the next indices');
  eq(g.GIT_CONFIG_VALUE_4, base, '...both of them');
  ok(!('GIT_CONFIG_KEY_0' in g), '...and the existing ones are not overwritten');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the store still holds the db */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
