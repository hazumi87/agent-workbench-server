/* THE ROOM CODE FOLDER (step C; planning KB design-notes-id). A room's code seats each work in their own git worktree of the room's code folder (seat-worktree.ts).
 * This file is the folder itself: inspect it, make a new project of it, and set it on a room. THREE OUTCOMES, never two, for "is it a git project": yes ('repo'),
 * no ('not-repo') and could-not-tell ('unknown': there is no git, or git would not answer) - so a PC without git is never told its folder "is not a project".
 *
 * Git is required to SET a code folder at all (the app dims the choices with "Needs git"); "no folder" never needs it. A picked folder that is not a git project is
 * ACCEPTED and not redirected: its seats share it and the room says so (the person decides whether to make it a project, makeProject). */
import { mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute as posixAbs, resolve as resolvePath, win32 } from 'node:path';
import { table, RoomError } from '../table/endpoint.ts';
import { runGit } from './worktrees.ts';
import { gitPath, GIT_NOT_INSTALLED } from './git-resolver.ts';

export type GitState = 'repo' | 'not-repo' | 'unknown';
export interface FolderInfo {
  exists: boolean;
  isDir: boolean;
  git: GitState;
  hasCommits: boolean | null;
}
export interface CodeFolderView {
  mode: 'existing' | 'new';
  path: string;
  git: GitState;
  /** the main room that carries it (a workgroup reads its family's) */
  owner: string;
}
export type SetResult =
  | { ok: true; codeFolder: CodeFolderView | null }
  | { ok: false; status: number; reason: string; field?: string; code?: string };

/** What the app reads to dim "Needs git": found, where, its version; or `{found:false, message:"git is not installed"}`. */
export async function gitStatus(): Promise<{ found: boolean; version: string | null; message?: string }> {
  if (!gitPath()) {
    return { found: false, version: null, message: GIT_NOT_INSTALLED };
  }
  const v = await runGit(['--version']);
  return v.ok ? { found: true, version: v.out } : { found: false, version: null, message: GIT_NOT_INSTALLED };
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
};

export async function inspectFolder(dir: string): Promise<FolderInfo> {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
    if (!isDir) {
      return { exists: true, isDir: false, git: 'unknown', hasCommits: null };
    }
  } catch {
    return { exists: false, isDir: false, git: 'unknown', hasCommits: null };
  }
  if (!gitPath()) {
    return { exists: true, isDir: true, git: 'unknown', hasCommits: null };
  }
  const top = await runGit(['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!top.ok) {
    /* "not a git repository" is a clear NO; anything else (dubious ownership, a failure to run) is could-not-tell */
    return { exists: true, isDir: true, git: /not a git repository/i.test(top.err) ? 'not-repo' : 'unknown', hasCommits: null };
  }
  if (real(top.out) !== real(dir)) {
    return { exists: true, isDir: true, git: 'not-repo', hasCommits: null }; // a sub-folder of a bigger repo is not THIS folder's project
  }
  const head = await runGit(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD']);
  return { exists: true, isDir: true, git: 'repo', hasCommits: head.ok };
}

/** Make a folder a git project (creating it, and its parents, if need be): `git init` on a branch called main, and a first, EMPTY commit so there is a HEAD to cut worktrees
 *  from. The commit uses the person's git identity when they have one, else the fallback `Workbench <workbench@localhost>` for that one commit only: it is never saved to
 *  any config. Existing files are not touched. Idempotent. */
export async function makeProject(dir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  gitStates.delete(dir);
  if (!gitPath()) {
    return { ok: false, reason: GIT_NOT_INSTALLED };
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `could not create ${dir}: ${(e as Error).message}` };
  }
  const info = await inspectFolder(dir);
  if (info.git === 'unknown') {
    return { ok: false, reason: `git would not answer for ${dir}` };
  }
  if (info.git === 'not-repo') {
    let r = await runGit(['init', '-b', 'main', dir]);
    if (!r.ok) {
      r = await runGit(['init', dir]); // git before 2.28 has no -b
      if (r.ok) {
        await runGit(['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
      }
    }
    if (!r.ok) {
      return { ok: false, reason: `git init failed: ${r.err}` };
    }
  }
  if (process.platform === 'win32') {
    await runGit(['-C', dir, 'config', 'core.longpaths', 'true']); // Windows' 260-character limit and worktree paths
  }
  if ((await inspectFolder(dir)).hasCommits) {
    return { ok: true };
  }
  const name = await runGit(['-C', dir, 'config', '--get', 'user.name']);
  const email = await runGit(['-C', dir, 'config', '--get', 'user.email']);
  const who = name.out && email.out ? [] : ['-c', 'user.name=Workbench', '-c', 'user.email=workbench@localhost'];
  const c = await runGit(['-C', dir, ...who, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Start of project']);
  return c.ok ? { ok: true } : { ok: false, reason: `the first commit failed: ${c.err}` };
}

/* The room detail is polled, and "is it a git project" costs a git process: remember the answer for a few seconds, and forget it the moment this module changes the folder. */
const GIT_STATE_TTL_MS = 5000;
const gitStates = new Map<string, { at: number; git: GitState }>();

export async function codeFolderView(roomId: string, now = Date.now()): Promise<CodeFolderView | null> {
  const f = table.familyCodeFolder(roomId);
  if (!f) {
    return null;
  }
  let hit = gitStates.get(f.dir);
  if (!hit || now - hit.at > GIT_STATE_TTL_MS) {
    hit = { at: now, git: (await inspectFolder(f.dir)).git };
    gitStates.set(f.dir, hit);
  }
  return { mode: f.mode, path: f.dir, git: hit.git, owner: f.roomId };
}

const absolute = (p: string): boolean => (process.platform === 'win32' ? win32.isAbsolute(p) : posixAbs(p));

export type CheckResult =
  | { ok: true; mode: 'existing' | 'new' | 'none'; dir: string | null }
  | { ok: false; status: number; reason: string; field?: string; code?: string };

/** Everything that can be checked WITHOUT touching anything: the mode, git, the path. Used before a room exists (creating a room with a folder must not leave an empty room
 *  behind when the folder is refused) and again by setCodeFolder. A 'new' folder is only CHECKED here, never created. */
export async function checkCodeFolder(input: { mode?: unknown; path?: unknown }): Promise<CheckResult> {
  const mode = input.mode;
  if (mode !== 'existing' && mode !== 'new' && mode !== 'none') {
    return { ok: false, status: 400, reason: "mode is 'existing', 'new' or 'none'", field: 'mode' };
  }
  if (mode === 'none') {
    return { ok: true, mode, dir: null };
  }
  if (!gitPath()) {
    return { ok: false, status: 409, reason: GIT_NOT_INSTALLED, code: 'no-git', field: 'mode' };
  }
  const raw = typeof input.path === 'string' ? input.path.trim() : '';
  if (!raw || !absolute(raw)) {
    return { ok: false, status: 400, reason: 'path is the full path of the code folder', field: 'path' };
  }
  const dir = resolvePath(raw);
  const info = await inspectFolder(dir);
  if (mode === 'existing') {
    if (!info.exists) {
      return { ok: false, status: 400, reason: `${dir} does not exist`, field: 'path' };
    }
    if (!info.isDir) {
      return { ok: false, status: 400, reason: `${dir} is not a folder`, field: 'path' };
    }
  } else {
    if (info.exists && !info.isDir) {
      return { ok: false, status: 400, reason: `${dir} is a file, not a folder`, field: 'path' };
    }
    if (info.exists && readdirSync(dir).length > 0) {
      return { ok: false, status: 409, reason: `${dir} is not empty; choose "use an existing folder" for a folder that already has files`, field: 'path' };
    }
  }
  return { ok: true, mode, dir };
}

/** Set (or clear) the room's code folder: 'existing' (the person's folder), 'new' (made here as a git project), or 'none'. Checks first and writes the room last, so a refusal
 *  leaves nothing behind. Only the MAIN room carries it. */
export async function setCodeFolder(roomId: string, input: { mode?: unknown; path?: unknown }, actor: 'user' | { seatId: string } = 'user'): Promise<SetResult> {
  const room = table.getRoom(roomId);
  if (!room) {
    return { ok: false, status: 404, reason: 'no such room' };
  }
  if (room.parent_id !== null) {
    return { ok: false, status: 409, reason: 'a workgroup uses its main room\'s code folder; set it on the main room', field: 'mode' };
  }
  const checked = await checkCodeFolder(input);
  if (!checked.ok) {
    return checked;
  }
  const opts = { actor } as Parameters<typeof table.setRoomCodeFolder>[2];
  if (checked.mode === 'none') {
    return finish(() => table.setRoomCodeFolder(roomId, { mode: 'none' }, opts), roomId);
  }
  const dir = checked.dir as string;
  if (checked.mode === 'new') {
    const made = await makeProject(dir);
    if (!made.ok) {
      return { ok: false, status: made.reason === GIT_NOT_INSTALLED ? 409 : 500, reason: made.reason, field: 'path', ...(made.reason === GIT_NOT_INSTALLED ? { code: 'no-git' } : {}) };
    }
  }
  const mode = checked.mode;
  return finish(() => table.setRoomCodeFolder(roomId, { mode, dir }, opts), roomId);
}

async function finish(write: () => unknown, roomId: string): Promise<SetResult> {
  gitStates.clear();
  try {
    write();
  } catch (e) {
    if (e instanceof RoomError) {
      return { ok: false, status: e.status, reason: e.message, field: e.field };
    }
    throw e;
  }
  return { ok: true, codeFolder: await codeFolderView(roomId) };
}
