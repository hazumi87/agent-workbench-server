/* GIT ON WINDOWS (E4). The engine runs git for worktrees (worktrees.ts) and the project mirror. On Linux that is `sh -c 'umask 002; exec git "$@"'`,
 * which cannot work on Windows: there is no `sh`, and umask means nothing. And a git installed while the engine was running is not on the
 * engine's PATH yet. This module decides WHICH git and HOW to run it. PURE: the platform, the environment and the file-system check are passed in,
 * so the Windows rules are tested on Linux (test/git-resolver.test.ts); what that cannot prove is a real Windows run. */
import { existsSync } from 'node:fs';


/** The typed line a person reads when there is no git. Exact. */
export const GIT_NOT_INSTALLED = 'git is not installed';

export interface ResolveOpts {
  platform?: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}

/** Not Windows: `git`, found by the OS exactly as before. Windows: the first git.exe on PATH (the person's own choice), then the standard
 *  install locations (Program Files, Program Files (x86), a per-user LocalAppData install). null = not installed anywhere: never a guess. */
export function resolveGit(o: ResolveOpts = {}): string | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  /* HARBOR_WB_GIT: the person's (or a test's) override. `none` = git is not installed. Otherwise an ABSOLUTE path that exists; anything else is "no git", never a
     guess and never a relative path (the Windows current-directory trap, applied everywhere). */
  const override = (env.HARBOR_WB_GIT ?? '').trim();
  if (override) {
    if (override.toLowerCase() === 'none') {
      return null;
    }
    const isAbs = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(override) || override.startsWith('\\\\') : override.startsWith('/');
    return isAbs && exists(override) ? override : null;
  }
  if (platform !== 'win32') {
    return 'git';
  }
  const win = (...parts: string[]): string => parts.join('\\');
  /* ONLY an absolute directory is ever searched. On Windows the process search looks in the CURRENT directory first, so a relative entry
     (`.`, `bin`) or an empty one could run a git.exe sitting in a seat's worktree in place of the real git (design review [ref]). */
  const absolute = (d: string): boolean => /^[A-Za-z]:[\\/]/.test(d) || d.startsWith('\\\\');
  const dirs: string[] = (env.PATH ?? env.Path ?? '')
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, ''))
    .filter((d) => d && absolute(d));
  const candidates = dirs.flatMap((d) => [win(d, 'git.exe')]);
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
    if (base && absolute(base)) {
      candidates.push(win(base, 'Git', 'cmd', 'git.exe'));
    }
  }
  if (env.LOCALAPPDATA && absolute(env.LOCALAPPDATA)) {
    candidates.push(win(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
  }
  return candidates.find((c) => exists(c)) ?? null;
}

/** The process to start. Not Windows: through `sh` under umask 002, as before (files group-writable). Windows: git directly, arguments
 *  untouched (execFile does no shell parsing), no `sh`, no umask. */
export function gitCommand(platform: string, gitPath: string, args: string[]): { file: string; args: string[] } {
  if (platform === 'win32') {
    return { file: gitPath, args };
  }
  return { file: 'sh', args: ['-c', 'umask 002; exec git "$@"', 'sh', ...args] };
}

let cached: string | null | undefined;
let forced: string | null | undefined;
/** The git to use on this machine, looked up once and again after a miss (a person may install it while the engine runs). */
export function gitPath(): string | null {
  if (forced !== undefined) {
    return forced;
  }
  if (cached) {
    return cached;
  }
  cached = resolveGit();
  return cached;
}

/** TEST SEAM: force what gitPath() answers (null = not installed); undefined restores the real lookup. */
export function _setGitPath(p: string | null | undefined): void {
  forced = p;
  cached = undefined;
}
