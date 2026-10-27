/**
 * REAP LEAKED SCRATCH BASIC INSTANCES (ticket). An aborted test run can leave a scratch engine / pty-broker behind, and on a
 * memory-scarce server that is a slow leak (Owner [ref]). This finds ONLY processes whose own environment names an instance
 * under `<tmp>/wb-basic-scratch-*` (a scratch Basic instance's data dir), kills their process groups, and removes the
 * abandoned temp homes. It never touches anything else: not the server engine, not a pty-broker without that marker, not
 * another test's engine.
 *
 *   npx tsx scripts/basic-scratch-reap.ts [--dry-run] [--min-age-sec N]
 *
 * --min-age-sec (default 0): only reap instances whose temp home is at least that old (so a run in progress is spared).
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK = join(tmpdir(), 'wb-basic-scratch-');

export interface Reaped {
  pid: number;
  home: string;
  killed: boolean;
}

function envOf(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch {
    return null;
  }
}

export function reapScratchBasic(opts: { dryRun?: boolean; minAgeSec?: number; exceptPids?: number[] } = {}): { processes: Reaped[]; homes: string[] } {
  const processes: Reaped[] = [];
  const homes = new Set<string>();
  const now = Date.now();
  const young = (home: string): boolean => {
    try {
      return now - statSync(home).mtimeMs < (opts.minAgeSec ?? 0) * 1000;
    } catch {
      return false;
    }
  };
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (pid === process.pid || opts.exceptPids?.includes(pid)) continue;
    const env = envOf(pid);
    const dd = env?.find((l) => l.startsWith('HARBOR_WB_DATA_DIR='));
    if (!dd || !dd.slice('HARBOR_WB_DATA_DIR='.length).startsWith(MARK)) continue;
    const home = dd.slice('HARBOR_WB_DATA_DIR='.length).replace(/\/\.workbench$/, '');
    if (young(home)) continue;
    homes.add(home);
    let killed = false;
    if (!opts.dryRun) {
      try {
        process.kill(-pid, 'SIGKILL'); // its process group (spawned detached by the runner)
        killed = true;
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
          killed = true;
        } catch {
          /* gone */
        }
      }
    }
    processes.push({ pid, home, killed });
  }
  // the pty-broker carries PTY_BROKER_* not HARBOR_WB_DATA_DIR: find it through its home marker in HOME
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    if (pid === process.pid || opts.exceptPids?.includes(pid) || processes.some((p) => p.pid === pid)) continue;
    const env = envOf(pid);
    const h = env?.find((l) => l.startsWith('HOME='));
    const home = h?.slice(5) ?? '';
    if (!home.startsWith(MARK) || young(home)) continue;
    homes.add(home);
    let killed = false;
    if (!opts.dryRun) {
      try {
        process.kill(-pid, 'SIGKILL');
        killed = true;
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
          killed = true;
        } catch {
          /* gone */
        }
      }
    }
    processes.push({ pid, home, killed });
  }
  // abandoned homes with no process left
  try {
    for (const d of readdirSync(tmpdir())) {
      const p = join(tmpdir(), d);
      if (p.startsWith(MARK) && !young(p)) homes.add(p);
    }
  } catch {
    /* tmp unreadable */
  }
  if (!opts.dryRun) {
    for (const h of homes) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  return { processes, homes: [...homes] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dryRun = process.argv.includes('--dry-run');
  const i = process.argv.indexOf('--min-age-sec');
  const r = reapScratchBasic({ dryRun, minAgeSec: i >= 0 ? Number(process.argv[i + 1]) || 0 : 0 });
  process.stdout.write(`${dryRun ? 'would reap' : 'reaped'} ${r.processes.length} process(es) in ${r.homes.length} scratch home(s)\n`);
  for (const p of r.processes) process.stdout.write(`  pid ${p.pid} (${p.home})${p.killed ? ' killed' : ''}\n`);
}
