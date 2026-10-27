/* THE LOCAL ENGINE'S DATA FOLDER [lead order 15616 item 5]: make sure it can be written, and that only one engine uses it.
 * service mode never calls this. The lock is a small JSON file holding the owner's pid; a lock whose process is gone is stale and is
 * replaced (an app crash must not block the next start). Known limit: a reused pid could look alive; the supervisor keeps one engine
 * per app, so this is a second line of defence, not the first. Deps injectable for tests. */
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_NAME = 'engine.lock';

export type DataDirResult = { ok: true; tookOverStale: boolean } | { ok: false; problem: string };

export interface DataDirDeps {
  pid: number;
  alive: (pid: number) => boolean;
  now: () => number;
}

export const realDeps: DataDirDeps = {
  pid: process.pid,
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
    }
  },
  now: () => Date.now(),
};

/** Create the folder if needed, prove it is writable, and take the lock. */
export function claimDataDir(dir: string, deps: DataDirDeps = realDeps): DataDirResult {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${deps.pid}`);
    writeFileSync(probe, 'x');
    rmSync(probe, { force: true });
  } catch (e) {
    return { ok: false, problem: `the data folder ${dir} is not writable (${(e as Error).message})` };
  }
  const lock = join(dir, LOCK_NAME);
  let tookOverStale = false;
  if (existsSync(lock)) {
    let owner = NaN;
    try {
      owner = Number(JSON.parse(readFileSync(lock, 'utf8')).pid);
    } catch {
      /* unreadable lock: treated as stale */
    }
    if (Number.isInteger(owner) && owner !== deps.pid && deps.alive(owner)) {
      return { ok: false, problem: `another local engine (pid ${owner}) is already using the data folder ${dir}` };
    }
    tookOverStale = true;
  }
  try {
    writeFileSync(lock, JSON.stringify({ pid: deps.pid, startedAt: deps.now() }));
  } catch (e) {
    return { ok: false, problem: `could not write the lock in ${dir} (${(e as Error).message})` };
  }
  return { ok: true, tookOverStale };
}

/** Remove our own lock (never someone else's). */
export function releaseDataDir(dir: string, pid: number = process.pid): void {
  const lock = join(dir, LOCK_NAME);
  try {
    if (Number(JSON.parse(readFileSync(lock, 'utf8')).pid) === pid) {
      rmSync(lock, { force: true });
    }
  } catch {
    /* nothing to release */
  }
}
