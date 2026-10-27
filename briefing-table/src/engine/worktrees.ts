/**
 * SEAT WORKTREES (Owner 2026-10-05, worktree convention, KB design-notes-id §12).
 *
 * A code-writing seat that is the SECOND instance of a project works in its own
 * git worktree, never in the project's main checkout:
 *
 *   <root>/<project>/_base          a normal clone of the project's origin. The
 *                                   engine only `git fetch`es here and runs
 *                                   `git worktree add/remove`; it never edits
 *                                   this working tree.
 *   <root>/<project>/<agent-name>   the seat's worktree, branch wg/<agent-name>
 *                                   cut from a freshly fetched origin/main.
 *
 * <root> is HARBOR_WB_WORKTREE_ROOT, default /srv/worktrees (server). The
 * VRPC side is NOT here: it needs a narrow worktree.add/remove verb (design
 * note in the build report).
 *
 * RULES THAT ARE THE POINT
 *   - A restarted seat REUSES its branch and worktree. Never reset, never
 *     recreate: the seat's unmerged work is in there.
 *   - Removal only when the tree is clean AND the branch is fully pushed;
 *     otherwise "kept: unmerged work" / "kept: locked". Never force, merge,
 *     prune or delete a branch. A sweep may only LIST orphans.
 *   - Created as the engine's own account, group-shared: dirs 2775 (setgid),
 *     umask 002, repo core.sharedRepository=group.
 *
 * Every git call is async (a first clone can take a while and the engine is one
 * process) and serialized per project so two seats starting at once cannot race
 * on the same _base.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isSlug, normalizeSlug, projectBasename } from './agent-slug.ts';
import { dataDir, instancePath } from './data-dir.ts';
import { gitCommand, gitPath, GIT_NOT_INSTALLED } from './git-resolver.ts';

export const DEFAULT_ROOT = './worktrees';

export function worktreeRoot(): string {
  return process.env.HARBOR_WB_WORKTREE_ROOT || (dataDir() ? instancePath('worktrees') : DEFAULT_ROOT);
}

/** Vendors that write code into the project (a worktree only helps those). */
export const CODE_VENDORS: readonly string[] = ['claude-code', 'codex-cli', 'gemini-cli'];

export interface WorktreeRef {
  path: string;
  branch: string;
}

export type EnsureResult =
  | { ok: true; created: boolean; path: string; branch: string; project: string; name: string }
  | { ok: false; reason: string };

export type RemoveResult =
  | { status: 'removed'; path: string; branch: string }
  | { status: 'absent' }
  | { status: 'kept'; path: string; branch: string; reason: string };

interface GitOut {
  ok: boolean;
  out: string;
  err: string;
}

/** `git` under umask 002 on Linux (so every file/dir the engine's git makes is group writable); on Windows git.exe directly, found by
 *  git-resolver.ts (no `sh`, no umask). No prompt may ever block the engine. No git at all is `{ok:false, err:"git is not installed"}`. */
function git(args: string[], cwd?: string): Promise<GitOut> {
  const bin = gitPath();
  if (!bin) {
    return Promise.resolve({ ok: false, out: '', err: GIT_NOT_INSTALLED });
  }
  const cmd = gitCommand(process.platform, bin, args);
  return new Promise((done) => {
    execFile(
      cmd.file,
      cmd.args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 },
      (e, stdout, stderr) => done({ ok: !e, out: String(stdout).trim(), err: (String(stderr) || (e ? e.message : '')).trim() }),
    );
  });
}

/** Run git (the engine's way: umask 002 through sh on Linux, git.exe directly on Windows). Exported for code-folder.ts. */
export const runGit = git;

const chains = new Map<string, Promise<unknown>>();
/** One operation at a time per project dir. */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => undefined));
  return next;
}

/** The project name a recipe's worktrees live under: the slug of the basename of
 *  its projectDir. Null when it does not satisfy the slug grammar. */
export function projectNameOf(projectDir: string | null | undefined): string | null {
  if (!projectDir) {
    return null;
  }
  const n = normalizeSlug(projectBasename(projectDir));
  return n && isSlug(n) ? n : null;
}

/** A worktree name is a slug, or (a room code folder's) <room-family-slug>/<handle>. */
export function isWorktreeName(name: string): boolean {
  const parts = name.split('/');
  return parts.length >= 1 && parts.length <= 2 && parts.every((p) => isSlug(p));
}

export function worktreePath(project: string, name: string): string {
  return join(worktreeRoot(), project, name);
}

export function branchOf(name: string): string {
  return `wg/${name}`;
}

function tryGroup(dir: string): void {
  try {
    chmodSync(dir, 0o2775); // setgid + rwxrwxr-x; the group follows the parent
  } catch {
    /* not ours to chmod (a test tmp, an inherited dir): the umask still holds */
  }
}

/**
 * Create the seat's worktree, or reuse the one that is already there. Never
 * throws: a refusal is `{ok:false, reason}` and the seat simply starts in the
 * main checkout, with the reason logged by the caller.
 */
export function ensureWorktree(opts: { projectDir: string; name: string }): Promise<EnsureResult> {
  const project = projectNameOf(opts.projectDir);
  if (!project) {
    return Promise.resolve({ ok: false, reason: `project name from "${opts.projectDir}" is not a slug` });
  }
  if (!isSlug(opts.name)) {
    return Promise.resolve({ ok: false, reason: `agent name "${opts.name}" is not a slug` });
  }
  if (!gitPath()) {
    return Promise.resolve({ ok: false, reason: GIT_NOT_INSTALLED });
  }
  return serial(project, () => ensureInner(opts.projectDir, project, opts.name)).catch((e) => ({
    ok: false as const,
    reason: `worktree create failed: ${(e as Error).message}`,
  }));
}

async function ensureInner(projectDir: string, project: string, name: string): Promise<EnsureResult> {
  if (!existsSync(join(projectDir, '.git'))) {
    return { ok: false, reason: `${projectDir} is not a git repository` };
  }
  const o = await git(['-C', projectDir, 'remote', 'get-url', 'origin']);
  if (!o.ok || !o.out) {
    return { ok: false, reason: `${projectDir} has no origin remote` };
  }
  const root = worktreeRoot();
  const pdir = join(root, project);
  mkdirSync(pdir, { recursive: true, mode: 0o2775 });
  tryGroup(pdir);
  const base = join(pdir, '_base');
  if (!existsSync(join(base, '.git'))) {
    const c = await git(['-c', 'protocol.ext.allow=never', 'clone', '--', o.out, base]); // L7: a remote URL that starts with '-' is a path, never an option; no ext:: helper
    if (!c.ok) {
      return { ok: false, reason: `base clone failed: ${c.err}` };
    }
  }
  await git(['-C', base, 'config', 'core.sharedRepository', 'group']);
  const f = await git(['-C', base, 'fetch', 'origin']);
  if (!f.ok) {
    return { ok: false, reason: `fetch failed: ${f.err}` };
  }
  const path = join(pdir, name);
  const branch = branchOf(name);
  if (existsSync(path)) {
    // REUSE: a restarted seat keeps its branch and worktree, untouched. If the
    // root was MOVED the worktree's .git link points at the old place: repair
    // the links (a no-op otherwise) and look again.
    const linked = async (): Promise<boolean> => {
      const common = await git(['-C', path, 'rev-parse', '--git-common-dir']);
      return common.ok && safeReal(resolve(path, common.out)) === safeReal(join(base, '.git'));
    };
    let same = await linked();
    if (!same) {
      await git(['-C', base, 'worktree', 'repair', path]);
      same = await linked();
    }
    return same
      ? { ok: true, created: false, path, branch, project, name }
      : { ok: false, reason: `${path} exists and is not a worktree of ${base}` };
  }
  const hasBranch = (await git(['-C', base, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
  let add: GitOut;
  if (hasBranch) {
    add = await git(['-C', base, 'worktree', 'add', path, branch]); // kept from an earlier removal: reuse, never reset
  } else {
    if (!(await git(['-C', base, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])).ok) {
      return { ok: false, reason: 'origin/main does not exist' };
    }
    add = await git(['-C', base, 'worktree', 'add', '-b', branch, path, 'origin/main']);
  }
  if (!add.ok) {
    return { ok: false, reason: `git worktree add failed: ${add.err}` };
  }
  tryGroup(path);
  return { ok: true, created: true, path, branch, project, name };
}

/**
 * A ROOM CODE FOLDER's worktree (step C, planning KB design-notes-id): every code seat of a room whose code folder is a git project works in its own
 * worktree OF THAT FOLDER (no _base clone, no origin needed). Same place and branch convention as ensureWorktree (<root>/<project>/<name>, wg/<name>), so
 * everything that resolves a seat's folder from (project, name) keeps working. Cut from the folder's default branch (origin/HEAD when there is a remote),
 * else from the folder's HEAD. A restart REUSES it, never resets. Never throws.
 */
export function ensureFolderWorktree(opts: { codeDir: string; name: string }): Promise<EnsureResult> {
  const project = projectNameOf(opts.codeDir);
  if (!project) {
    return Promise.resolve({ ok: false, reason: `project name from "${opts.codeDir}" is not a slug` });
  }
  if (!isWorktreeName(opts.name)) {
    return Promise.resolve({ ok: false, reason: `agent name "${opts.name}" is not a slug` });
  }
  if (!gitPath()) {
    return Promise.resolve({ ok: false, reason: GIT_NOT_INSTALLED });
  }
  return serial(project, () => folderInner(opts.codeDir, project, opts.name)).catch((e) => ({
    ok: false as const,
    reason: `worktree create failed: ${(e as Error).message}`,
  }));
}

async function folderInner(codeDir: string, project: string, name: string): Promise<EnsureResult> {
  if (!existsSync(join(codeDir, '.git'))) {
    return { ok: false, reason: `${codeDir} is not a git repository` };
  }
  const head = await git(['-C', codeDir, 'rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head.ok) {
    return { ok: false, reason: `${codeDir} has no commit to start from` };
  }
  if (process.platform === 'win32') {
    await git(['-C', codeDir, 'config', 'core.longpaths', 'true']); // worktree paths are long
  }
  const path = join(worktreeRoot(), project, name);
  mkdirSync(dirname(path), { recursive: true });
  const branch = branchOf(name);
  if (existsSync(path)) {
    await git(['-C', codeDir, 'worktree', 'repair', path]);
    const common = await git(['-C', path, 'rev-parse', '--git-common-dir']);
    return common.ok && safeReal(resolve(path, common.out)) === safeReal(join(codeDir, '.git'))
      ? { ok: true, created: false, path, branch, project, name }
      : { ok: false, reason: `${path} exists and is not a worktree of ${codeDir}` };
  }
  const hasBranch = (await git(['-C', codeDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
  let add: GitOut;
  if (hasBranch) {
    add = await git(['-C', codeDir, 'worktree', 'add', path, branch]);
  } else {
    const od = await git(['-C', codeDir, 'symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD']);
    add = await git(['-C', codeDir, 'worktree', 'add', '-b', branch, path, od.ok && od.out ? od.out : 'HEAD']);
  }
  if (!add.ok) {
    return { ok: false, reason: `git worktree add failed: ${add.err}` };
  }
  return { ok: true, created: true, path, branch, project, name };
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Remove a seat's worktree ONLY if its tree is clean and its branch is fully
 * pushed. Anything else is kept and says why. No --force, no merge, no prune,
 * no branch delete. EPERM / "locked" is retried, then reported as locked.
 */
export function removeWorktree(opts: { project: string; name: string; explicit?: boolean }): Promise<RemoveResult> {
  if (!isSlug(opts.project) || !isWorktreeName(opts.name)) {
    return Promise.resolve({ status: 'absent' });
  }
  return serial(opts.project, () => removeInner(opts.project, opts.name, opts.explicit === true)).catch((e) => ({
    status: 'kept' as const,
    path: worktreePath(opts.project, opts.name),
    branch: branchOf(opts.name),
    reason: `kept: ${(e as Error).message}`,
  }));
}

/** Re-point a worktree's links after the root was moved (a no-op when they are
 *  right). Safe to call before any use of an existing worktree. */
export function repairWorktree(project: string, name: string): Promise<void> {
  if (!isSlug(project) || !isSlug(name)) {
    return Promise.resolve();
  }
  return serial(project, async () => {
    const path = worktreePath(project, name);
    if (existsSync(path)) {
      await git(['-C', join(worktreeRoot(), project, '_base'), 'worktree', 'repair', path]);
    }
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function removeInner(project: string, name: string, explicit: boolean): Promise<RemoveResult> {
  const path = worktreePath(project, name);
  if (!existsSync(path)) {
    return { status: 'absent' };
  }
  const branch = branchOf(name);
  const base = join(worktreeRoot(), project, '_base');
  const kept = (reason: string): RemoveResult => ({ status: 'kept', path, branch, reason });
  if (!existsSync(join(base, '.git'))) {
    /* ensureFolderWorktree's: no _base, and no remote to judge 'pushed' by. Only the person's Clean up removes it, and only when it is clean (its branch, with
       every commit, stays in the folder's repo). */
    if (!explicit) {
      return kept('kept: it is a worktree of your code folder, so it is only removed by Clean up');
    }
    const common = await git(['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common.ok || !common.out) {
      return kept('kept: locked');
    }
    const repo = dirname(common.out);
    const dirty = await git(['-C', path, 'status', '--porcelain']);
    if (!dirty.ok) {
      return kept('kept: locked');
    }
    if (dirty.out) {
      return kept('kept: unmerged work');
    }
    const r = await git(['-C', repo, 'worktree', 'remove', path]); // no --force, ever
    return r.ok ? { status: 'removed', path, branch } : kept(`kept: ${r.err.split('\n')[0] || 'git refused'}`);
  }
  await git(['-C', base, 'worktree', 'repair', path]); // a moved root: fix the links first
  const st = await git(['-C', path, 'status', '--porcelain']);
  if (!st.ok) {
    return kept('kept: locked'); // cannot even read it: do not touch it
  }
  if (st.out) {
    return kept('kept: unmerged work');
  }
  await git(['-C', base, 'fetch', 'origin']); // a failed fetch just means we judge on what we know
  for (const ref of [`refs/heads/${branch}`, 'HEAD']) {
    const tip = await git(['-C', path, 'rev-parse', '--verify', '--quiet', ref]);
    if (!tip.ok) {
      continue; // the branch was never created / HEAD only: judged by the other ref
    }
    const on = await git(['-C', path, 'branch', '-r', '--contains', tip.out]);
    if (!on.ok || !on.out.trim()) {
      return kept('kept: unmerged work');
    }
  }
  let last = '';
  for (let i = 0; i < 3; i++) {
    const r = await git(['-C', base, 'worktree', 'remove', path]); // no --force, ever
    if (r.ok) {
      return { status: 'removed', path, branch };
    }
    last = r.err;
    if (!/locked|EPERM|permission denied|busy/i.test(last)) {
      return kept(`kept: ${last.split('\n')[0] || 'git refused'}`);
    }
    await sleep(300);
  }
  return kept('kept: locked');
}

/** Orphans for a LIST only: worktree dirs under <root>/<project> whose name is
 *  not in `liveNames`. The caller reports them; nothing here removes anything. */
export function listOrphans(project: string, liveNames: Iterable<string>): string[] {
  const live = new Set(liveNames);
  try {
    return readdirSync(join(worktreeRoot(), project), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== '_base' && !live.has(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}
