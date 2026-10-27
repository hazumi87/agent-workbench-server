/**
 * Project activity assembly (the design notes): live sessions filtered
 * by project, the seat/room join, the three-outcome branch, and which repo a
 * project is. Pure deps for the assembly; real temp git repos (no network)
 * for branchOfDir / resolveRepo.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  liveSessions,
  liveWithBranches,
  branchOfDir,
  resolveRepo,
  type ActivityDeps,
  type ActivityRecipe,
  type ActivityRow,
  type BranchInfo,
} from '../src/engine/project-activity.ts';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}
function same(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? msg : `${msg}\n      got      ${a}\n      expected ${b}`);
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const tmp = mkdtempSync(join(tmpdir(), 'wb-proj-activity-'));
try {
  /* ---------------------------------------------------------- repos ---- */
  const origin = join(tmp, 'origin.git');
  g(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  const bt = join(tmp, 'briefing-table');
  g(tmp, 'clone', '--quiet', origin, bt);
  g(bt, 'commit', '--quiet', '--allow-empty', '-m', 'root');
  g(bt, 'push', '--quiet', 'origin', 'HEAD:main');
  g(bt, 'checkout', '--quiet', '-b', 'feature/x');
  const wt = join(tmp, 'wt-feature');
  g(bt, 'worktree', 'add', '--quiet', '-b', 'wt-branch', wt);

  /* ---------------------------------------------------------- deps ---- */
  const recipes: Record<string, ActivityRecipe> = {
    'rec-bt': { id: 'rec-bt', name: 'Briefing Table', agent: 'briefing-table', projectDir: bt, target: 'homebase' },
    'rec-bt-vrpc': { id: 'rec-bt-vrpc', name: 'BT on VRPC', agent: 'bt-vrpc', projectDir: 'C:/code/briefing-table', target: 'vrpc' },
    'rec-bt-wt': { id: 'rec-bt-wt', name: 'BT worktree', agent: 'briefing-table', projectDir: wt, target: 'homebase' },
    'rec-other': { id: 'rec-other', name: 'Auriga', agent: 'auriga', projectDir: join(tmp, 'auriga'), target: 'homebase' },
    'rec-gone': { id: 'rec-gone', name: 'Gone dir', agent: 'briefing-table', projectDir: join(tmp, 'nope'), target: 'homebase' },
    'rec-nodir': { id: 'rec-nodir', name: 'No dir', agent: 'briefing-table', projectDir: null, target: 'homebase' },
  };
  const rows: ActivityRow[] = [
    { paneid: 'p1', recipe_id: 'rec-bt', vendor: 'claude-code', agent: 'briefing-table', state: 'live', started_at: 1_700_000_000_000, fabric_instance: 'i-1' },
    { paneid: 'p2', recipe_id: 'rec-bt-vrpc', vendor: 'claude-code', agent: 'bt-vrpc', state: 'live' },
    { paneid: 'p3', recipe_id: 'rec-bt', vendor: 'claude-code', agent: 'briefing-table', state: 'dehydrated' },
    { paneid: 'p4', recipe_id: 'rec-other', vendor: 'claude-code', agent: 'auriga', state: 'live' },
    { paneid: 'p5', recipe_id: 'rec-bt-wt', vendor: 'gemini-cli', agent: 'briefing-table', state: 'live' },
    { paneid: 'p6', recipe_id: 'rec-gone', vendor: '', agent: 'briefing-table', state: 'live' },
    { paneid: 'p7', recipe_id: 'rec-nodir', vendor: 'cli-manager', agent: 'briefing-table', state: 'live' },
    { paneid: 'p8', recipe_id: null, vendor: 'cli-manager', agent: null, state: 'live' },
  ];
  const nodeOf: Record<string, string> = { homebase: 'homebase', vrpc: 'vrpc' };
  let branchCalls = 0;
  const deps: ActivityDeps = {
    sessions: () => rows,
    recipe: (id) => recipes[id] ?? null,
    nodeOf: (t) => nodeOf[t] ?? 'homebase',
    isLocal: (t) => t === 'homebase',
    openRooms: () => [
      { id: 'room-a', name: 'Workrooms build' },
      { id: 'room-b', name: 'Merge' },
    ],
    seats: (roomId) =>
      roomId === 'room-a'
        ? [
            { handle: 'bt', occupant_kind: 'pane', occupant: 'p1' },
            { handle: 'auriga', occupant_kind: 'pane', occupant: 'p4' },
            { handle: 'empty', occupant_kind: 'none', occupant: null },
          ]
        : [
            { handle: 'vrpc1', occupant_kind: 'pane', occupant: 'p2' },
            { handle: 'bt2', occupant_kind: 'pane', occupant: 'p1' },
          ],
    branchOf: (dir) => {
      branchCalls += 1;
      return branchOfDir(dir);
    },
  };

  console.log('live sessions filtered by project');
  const live = liveSessions('briefing-table', deps);
  same(live.map((s) => s.paneid), ['p1', 'p2', 'p5', 'p6', 'p7'], 'live rows of the project only (dehydrated, other project and bare pane excluded)');
  ok(live.some((s) => s.paneid === 'p2'), 'a recipe with its own slug on the same repo folder counts (basename match)');
  same(liveSessions('bt-vrpc', deps).map((s) => s.paneid), ['p2'], 'the custom slug finds its own session');
  same(liveSessions('auriga', deps).map((s) => s.paneid), ['p4'], 'another project sees only itself');

  console.log('seat / room join');
  const p1 = live.find((s) => s.paneid === 'p1')!;
  same(p1.seats, [
    { room_id: 'room-a', room: 'Workrooms build', handle: 'bt' },
    { room_id: 'room-b', room: 'Merge', handle: 'bt2' },
  ], 'a pane seated in two rooms lists both');
  same(live.find((s) => s.paneid === 'p5')!.seats, [], 'an unseated pane lists none');
  same(
    { slug: p1.slug, instance: p1.instance, vendor: p1.vendor, node: p1.node, since: p1.since, name: p1.name },
    { slug: 'briefing-table', instance: 'i-1', vendor: 'claude-code', node: 'homebase', since: new Date(1_700_000_000_000).toISOString(), name: 'Briefing Table' },
    'slug, instance, vendor, node, since, name',
  );
  ok(live.find((s) => s.paneid === 'p6')!.vendor === 'unknown', 'a missing vendor reads "unknown", never a guess');
  ok(live.find((s) => s.paneid === 'p2')!.node === 'vrpc', 'node comes from the recipe target');

  console.log('three-outcome branch');
  const withB = await liveWithBranches('briefing-table', deps);
  const by = (id: string) => withB.find((s) => s.paneid === id)! as unknown as BranchInfo & { dir?: string };
  same([by('p1').branch, by('p1').branch_status], ['feature/x', 'known'], 'a dir on this host: the checked-out branch');
  same([by('p5').branch, by('p5').branch_status], ['wt-branch', 'known'], 'a linked worktree: its own branch');
  same([by('p2').branch, by('p2').branch_status], [null, 'remote'], 'a dir on another host: remote (cannot tell), not "no branch"');
  same([by('p6').branch, by('p6').branch_status], [null, 'unknown'], 'a missing dir on this host: unknown');
  same([by('p7').branch, by('p7').branch_status], [null, 'unknown'], 'no project dir: unknown');
  ok(!('dir' in by('p1')), 'the local dir is not in the response');
  ok(branchCalls === 3, `one git call per distinct local dir (got ${branchCalls})`);
  const notRepo = await branchOfDir(tmp);
  same([notRepo.branch, notRepo.branch_status], [null, 'unknown'], 'a dir that is not a checkout: unknown');

  console.log('which repo is the project');
  const all = Object.values(recipes);
  const r1 = await resolveRepo('briefing-table', all, (t) => t === 'homebase');
  same(r1, { dir: bt, origin }, 'the canonical checkout (main worktree) and its origin');
  const r2 = await resolveRepo('briefing-table', [recipes['rec-bt-wt']], (t) => t === 'homebase');
  same(r2, { dir: bt, origin }, 'a recipe pointing into a linked worktree resolves to the main checkout');
  const r3 = await resolveRepo('bt-vrpc', all, (t) => t === 'homebase');
  ok('reason' in r3 && /on this engine's host/.test(r3.reason), 'a project whose only checkout is remote: a reason, not a guess');
  const r4 = await resolveRepo('nothing', all, () => true);
  ok('reason' in r4, 'an unknown project: a reason');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
