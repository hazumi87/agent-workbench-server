/**
 * PROJECT CHANNEL — GET /api/projects/:slug/activity, assembled
 * (the design notes; the design notes §2.2).
 *
 * Who is working on project X right now, what origin says changed, and who
 * holds X's lock. Three sources, no copies: the engine's own table (live
 * sessions, seats), the project's origin through the engine-owned mirror
 * (project-mirror.ts), and the in-memory locks (project-locks.ts).
 *
 * The assembly is PURE over `ActivityDeps` so a unit test can hand it rows,
 * recipes, seats and a branch reader without a db, a broker or a port.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { projectBasename } from './agent-slug.ts';
import { git } from './project-mirror.ts';

export interface ActivityRow {
  paneid: string;
  recipe_id: string | null;
  vendor: string;
  agent: string | null;
  state: string;
  started_at?: number | null;
  fabric_instance?: string | null;
}
export interface ActivityRecipe {
  id: string;
  name: string;
  agent: string | null;
  projectDir: string | null;
  target: string;
}
export interface ActivitySeat {
  handle: string;
  occupant_kind: string;
  occupant: string | null;
}

/** THREE OUTCOMES (the DirCheck rule): known, remote (the dir is on another
 *  host, so this engine cannot tell), unknown (on this host but git could not
 *  say — not a repo, a timeout). Null never means "no branch". */
export type BranchInfo =
  | { branch: string; branch_status: 'known' }
  | { branch: null; branch_status: 'remote' | 'unknown'; branch_reason: string };

export interface LiveSession {
  paneid: string;
  slug: string | null;
  instance: string | null;
  vendor: string;
  node: string;
  since: string | null;
  recipe_id: string | null;
  name: string | null;
  seats: Array<{ room_id: string; room: string; handle: string }>;
  dir: string | null;
}
export type LiveEntry = Omit<LiveSession, 'dir'> & BranchInfo;

export interface ActivityDeps {
  sessions(): ActivityRow[];
  recipe(id: string): ActivityRecipe | null;
  /** The node a recipe's target does its work on (launch.ts hostOfTarget). */
  nodeOf(targetId: string): string;
  /** Is a recipe's target's disk THIS engine's disk (remoteFsAccess 'local')? */
  isLocal(targetId: string): boolean;
  openRooms(): Array<{ id: string; name: string }>;
  seats(roomId: string): ActivitySeat[];
  branchOf(dir: string): Promise<BranchInfo>;
}

/** The slugs a session could be filed under: the row's own slug, its recipe's
 *  slug, and the basename of its recipe's project dir (the registry node id,
 *  agent-slug.ts). A recipe with a custom slug on the SAME repo still counts. */
export function projectKeys(row: ActivityRow, recipe: ActivityRecipe | null): Set<string> {
  const keys = new Set<string>();
  for (const k of [row.agent, recipe?.agent, recipe?.projectDir ? projectBasename(recipe.projectDir) : null]) {
    if (k) {
      keys.add(k);
    }
  }
  return keys;
}

export function recipeKeys(recipe: ActivityRecipe): Set<string> {
  return projectKeys({ paneid: '', recipe_id: recipe.id, vendor: '', agent: null, state: '' }, recipe);
}

/** Every LIVE session of `slug`, with its seats and host — no git yet. */
export function liveSessions(slug: string, deps: ActivityDeps): LiveSession[] {
  const rooms = deps.openRooms();
  const seatsByPane = new Map<string, LiveSession['seats']>();
  for (const room of rooms) {
    for (const s of deps.seats(room.id)) {
      if (s.occupant_kind === 'pane' && s.occupant) {
        const list = seatsByPane.get(s.occupant) ?? [];
        list.push({ room_id: room.id, room: room.name, handle: s.handle });
        seatsByPane.set(s.occupant, list);
      }
    }
  }
  const out: LiveSession[] = [];
  for (const row of deps.sessions()) {
    if (row.state !== 'live') {
      continue;
    }
    const recipe = row.recipe_id ? deps.recipe(row.recipe_id) : null;
    if (!projectKeys(row, recipe).has(slug)) {
      continue;
    }
    out.push({
      paneid: row.paneid,
      slug: row.agent ?? recipe?.agent ?? null,
      instance: row.fabric_instance ?? null,
      vendor: row.vendor || 'unknown',
      node: recipe ? deps.nodeOf(recipe.target) : deps.nodeOf(''),
      since: row.started_at ? new Date(row.started_at).toISOString() : null,
      recipe_id: row.recipe_id,
      name: recipe?.name ?? null,
      seats: seatsByPane.get(row.paneid) ?? [],
      dir: recipe?.projectDir && deps.isLocal(recipe.target) ? recipe.projectDir : null,
    });
  }
  return out;
}

/** Live sessions plus the branch of each one's working dir (three outcomes).
 *  One git call per distinct dir. */
export async function liveWithBranches(slug: string, deps: ActivityDeps): Promise<LiveEntry[]> {
  const live = liveSessions(slug, deps);
  const byDir = new Map<string, Promise<BranchInfo>>();
  const entries: LiveEntry[] = [];
  for (const s of live) {
    const { dir, ...rest } = s;
    let info: BranchInfo;
    if (dir) {
      if (!byDir.has(dir)) {
        byDir.set(dir, deps.branchOf(dir));
      }
      info = await byDir.get(dir)!;
    } else {
      const recipe = s.recipe_id ? deps.recipe(s.recipe_id) : null;
      info = recipe?.projectDir
        ? { branch: null, branch_status: 'remote', branch_reason: `working dir is on ${s.node}, not this engine's host` }
        : { branch: null, branch_status: 'unknown', branch_reason: 'no project dir recorded' };
    }
    entries.push({ ...rest, ...info });
  }
  return entries;
}

/* ------------------------------------------------------------ git ---- */

/** HEAD's branch in a working dir on this host. Bounded; never throws. */
export async function branchOfDir(dir: string): Promise<BranchInfo> {
  if (!existsSync(dir)) {
    return { branch: null, branch_status: 'unknown', branch_reason: 'no such directory on this host' };
  }
  const r = await git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], 2_000);
  const name = r.stdout.trim();
  if (!r.ok || !name) {
    return { branch: null, branch_status: 'unknown', branch_reason: r.error ?? 'git gave no branch' };
  }
  return { branch: name, branch_status: 'known' };
}

export interface RepoInfo {
  /** The canonical checkout (the main worktree, not a linked one). */
  dir: string;
  origin: string;
}

/**
 * Which repo is project `slug`: the first recipe of the project whose dir is
 * on THIS host and is a git checkout with an `origin`. The canonical checkout
 * is the common git dir's parent, so a recipe pointing into a linked worktree
 * still resolves to the main checkout.
 */
export async function resolveRepo(
  slug: string,
  recipes: ActivityRecipe[],
  isLocal: (targetId: string) => boolean,
): Promise<RepoInfo | { reason: string }> {
  const mine = recipes.filter((r) => r.projectDir && recipeKeys(r).has(slug));
  if (!mine.length) {
    return { reason: `no recipe of project "${slug}" names a project dir` };
  }
  const local = mine.filter((r) => isLocal(r.target) && existsSync(r.projectDir!));
  if (!local.length) {
    return { reason: `no checkout of "${slug}" on this engine's host` };
  }
  let last = 'not a git checkout';
  for (const r of local) {
    const common = await git(['-C', r.projectDir!, 'rev-parse', '--path-format=absolute', '--git-common-dir'], 2_000);
    const origin = await git(['-C', r.projectDir!, 'remote', 'get-url', 'origin'], 2_000);
    if (!common.ok || !origin.ok || !origin.stdout.trim()) {
      last = common.error ?? origin.error ?? 'no origin remote';
      continue;
    }
    /* path.resolve: git prints forward slashes on Windows (C:/Users/...), and
       every comparison against a recipe's projectDir must use this host's own
       separators (vrpc1, 2026-09-28). */
    const c = resolve(common.stdout.trim());
    return { dir: basename(c) === '.git' ? dirname(c) : c, origin: origin.stdout.trim() };
  }
  return { reason: last };
}
