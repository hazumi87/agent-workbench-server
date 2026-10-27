/* ============================================================================
 * RUNTIME SWITCHES (the design notes §5.3, finding F22) [ticket].
 *
 * `runtimeFlag(name)` reads the runtime `config.json` — the same gitignored,
 * per-machine file `reapMs` and `debugUi` live in — on EVERY call, behind an
 * mtime check, so flipping a switch needs no engine restart. `debugUi` is read
 * once at boot and stays that way; these three are the ones this spec needs:
 *
 *   seatRestorable  (default false)    a human may seat a dehydrated session
 *   upgrade         (default false)    Restart onto channel (S2)
 *   collisionGuard  (default 'enforce') 'warn' logs a restore collision and
 *                                      proceeds — Owner's rollback lever only
 *
 * SAFE DEFAULTS, NEVER THE LAST GOOD VALUE. A missing or unparseable file reads
 * every switch at its default, so a typo can never leave a feature on; a parse
 * failure is logged. A switch is ON only for its exact literal (`true`,
 * `"warn"`) — anything else is its default.
 *
 * Every transition is logged once (name, old → new, the file's mtime), and
 * /health carries `flags`. Who may flip which switch is D14.
 * ========================================================================== */

import { readFileSync, statSync } from 'node:fs';
import { instancePath } from './data-dir.ts';


export interface Flags {
  seatRestorable: boolean;
  upgrade: boolean;
  collisionGuard: 'enforce' | 'warn';
}

export const DEFAULTS: Readonly<Flags> = Object.freeze({ seatRestorable: false, upgrade: false, collisionGuard: 'enforce' });

/* HARBOR_WB_CONFIG exists for the test harness (a scratch engine must not read
   the checkout's config.json); the engine itself reads the repo root's. */
const configPath = (): string => process.env.HARBOR_WB_CONFIG || instancePath('config.json');

let log: (line: string) => void = (l) => console.log(`[engine-flags] ${l}`);
export function setLog(fn: (line: string) => void): void {
  log = fn;
}

let current: Flags = { ...DEFAULTS };
/** What the last read keyed on: the file's mtime, or null when it was missing. */
let seen: { path: string; mtime: number | null } | null = null;

function fromConfig(cfg: Record<string, unknown>): Flags {
  return {
    seatRestorable: cfg.seatRestorable === true,
    upgrade: cfg.upgrade === true,
    collisionGuard: cfg.collisionGuard === 'warn' ? 'warn' : 'enforce',
  };
}

function refresh(): void {
  const path = configPath();
  let mtime: number | null;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    mtime = null;
  }
  if (seen && seen.path === path && seen.mtime === mtime) {
    return;
  }
  seen = { path, mtime };
  let next: Flags = { ...DEFAULTS };
  if (mtime !== null) {
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf8'));
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        next = fromConfig(cfg as Record<string, unknown>);
      } else {
        log(`config.json is not a JSON object — every switch reads its safe default`);
      }
    } catch (e) {
      log(`config.json unparseable (${(e as Error).message}) — every switch reads its safe default`);
    }
  }
  const stamp = mtime === null ? 'missing' : new Date(mtime).toISOString();
  for (const name of Object.keys(DEFAULTS) as Array<keyof Flags>) {
    if (next[name] !== current[name]) {
      log(`switch ${name}: ${String(current[name])} → ${String(next[name])} (config.json mtime ${stamp})`);
    }
  }
  current = next;
}

/** One switch, as the runtime config.json says right now. */
export function runtimeFlag<K extends keyof Flags>(name: K): Flags[K] {
  refresh();
  return current[name];
}

/** Every switch (the /health `flags` object). */
export function all(): Flags {
  refresh();
  return { ...current };
}

/** Tests only: forget what was read, back to the defaults. */
export function reset(): void {
  current = { ...DEFAULTS };
  seen = null;
}
