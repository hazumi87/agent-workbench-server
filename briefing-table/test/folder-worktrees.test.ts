/**
 * ROOM CODE FOLDER WORKTREES (step C): every code seat gets its own worktree of the room's code folder, with no origin needed.
 * Real git in temp dirs; the worktree root is the test's own.
 */
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'wb-folderwt-'));
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

const wts = await import('../src/engine/worktrees.ts');
const { prepareSeatWorktree } = await import('../src/engine/seat-worktree.ts');
const { makeProject } = await import('../src/engine/code-folder.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

try {
  const proj = join(dir, 'code', 'gamma');
  ok((await makeProject(proj)).ok, 'a new project has a first commit');

  console.log('\n[no remote: cut from the folder HEAD]');
  const a = await wts.ensureFolderWorktree({ codeDir: proj, name: 'fam-a/steward' });
  ok(a.ok && a.created && a.path === join(dir, 'wt', 'gamma', 'fam-a', 'steward') && a.branch === 'wg/fam-a/steward', 'first seat gets <root>/<project>/<handle> on wg/<handle>');
  const b = await wts.ensureFolderWorktree({ codeDir: proj, name: 'fam-a/builder' });
  ok(b.ok && b.created && a.ok && b.path !== a.path, 'a second seat gets its own');
  ok(a.ok && git(a.path, 'rev-parse', 'HEAD') === git(proj, 'rev-parse', 'HEAD'), 'cut from the folder HEAD');
  ok(!existsSync(join(dir, 'wt', 'gamma', '_base')), 'no _base clone');
  if (a.ok) {
    writeFileSync(join(a.path, 'mine.txt'), 'work');
    git(a.path, 'add', '.');
    git(a.path, 'commit', '-m', 'seat work');
    const tip = git(a.path, 'rev-parse', 'HEAD');
    const again = await wts.ensureFolderWorktree({ codeDir: proj, name: 'fam-a/steward' });
    ok(again.ok && !again.created && git(a.path, 'rev-parse', 'HEAD') === tip, 'a restart reuses it, untouched');
  }

  console.log('\n[cut from origin/HEAD when there is a remote]');
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  git(proj, 'remote', 'add', 'origin', origin);
  git(proj, 'push', 'origin', 'main');
  git(proj, 'fetch', 'origin');
  git(proj, 'remote', 'set-head', 'origin', 'main');
  writeFileSync(join(proj, 'local-only.txt'), 'x');
  git(proj, 'add', '.');
  git(proj, 'commit', '-m', 'unpushed on main');
  const c = await wts.ensureFolderWorktree({ codeDir: proj, name: 'fam-a/tester' });
  ok(c.ok && git(c.path, 'rev-parse', 'HEAD') === git(proj, 'rev-parse', 'origin/main') && git(c.path, 'rev-parse', 'HEAD') !== git(proj, 'rev-parse', 'HEAD'), 'cut from origin/main, not the local main');

  console.log('\n[refusals and removal]');
  const notRepo = join(dir, 'plain');
  mkdirSync(notRepo);
  const n = await wts.ensureFolderWorktree({ codeDir: notRepo, name: 'x' });
  ok(!n.ok && /not a git repository/.test((n as any).reason), 'a plain folder is refused with the reason');
  ok(!(await wts.ensureFolderWorktree({ codeDir: proj, name: 'Bad Name' })).ok, 'a handle outside the slug grammar is refused');
  const rm = await wts.removeWorktree({ project: 'gamma', name: 'fam-a/steward' });
  ok(rm.status === 'kept' && existsSync(join(dir, 'wt', 'gamma', 'fam-a', 'steward')), 'the automatic removal keeps a folder worktree, even a clean one');
  const dirtyPath = join(dir, 'wt', 'gamma', 'fam-a', 'builder');
  writeFileSync(join(dirtyPath, 'wip.txt'), 'x');
  const rd = await wts.removeWorktree({ project: 'gamma', name: 'fam-a/builder', explicit: true });
  ok(rd.status === 'kept' && /unmerged work/.test((rd as any).reason) && existsSync(dirtyPath), 'Clean up keeps a dirty one and says why');
  const rc = await wts.removeWorktree({ project: 'gamma', name: 'fam-a/steward', explicit: true });
  ok(rc.status === 'removed' && !existsSync(join(dir, 'wt', 'gamma', 'fam-a', 'steward')), 'Clean up removes a clean one');
  ok(git(proj, 'branch', '--list', 'wg/fam-a/steward') !== '', '...and its branch (with every commit) stays in the repo');
  const other = await wts.ensureFolderWorktree({ codeDir: proj, name: 'fam-b/builder' });
  ok(other.ok && other.path !== dirtyPath, 'the same handle in another room family gets a different worktree');

  console.log('\n[the seat decision]');
  const recipe: any = { id: 'r1', vendor: 'claude-code', target: 'local', projectDir: join(dir, 'elsewhere'), worktree: null };
  const seat: any = { handle: 'lead1', occupant_kind: null, occupant: null };
  const logs: string[] = [];
  const w = await prepareSeatWorktree(recipe, seat, (m) => logs.push(m), { dir: proj, family: 'fam-a' });
  ok(w && w.project === 'gamma' && w.name === 'fam-a/lead1' && existsSync(w.path), 'with a code folder, even the FIRST seat (the lead) gets a worktree');
  ok((await prepareSeatWorktree({ ...recipe, worktree: 'never' }, seat, () => {}, { dir: proj, family: 'fam-a' })) === null, "worktree:'never' still opts out");
  ok((await prepareSeatWorktree({ ...recipe, vendor: 'cli-manager' }, seat, () => {}, { dir: proj, family: 'fam-a' })) === null, 'a non-code vendor gets none');
  const w2 = await prepareSeatWorktree(recipe, { ...seat, handle: 'lead2' }, () => {}, null);
  ok(w2 === null, 'no code folder: the old rule (first instance of a project, no worktree)');
} catch (e) {
  failed++;
  console.log('  X  threw', e);
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
