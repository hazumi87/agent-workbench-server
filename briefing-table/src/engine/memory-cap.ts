/* THE MEMORY CAP [lead ruling 15583, platform's server incident]: the local engine watches its own memory and exits with code 75 when it
 * passes a ceiling, so the supervisor restarts it at once. RSS, not the V8 heap: the server runaway grew OFF the heap, where Node's heap
 * flags cannot bound it. This is the polite path; the supervisor's outside limit (about 1.5 times the ceiling) is the backstop for an
 * engine too stuck to check itself. Pure and injectable: no timers or process calls except through `deps`. */

/** EX_TEMPFAIL: "restart me now" (a short minimum delay and a restart-storm limit are the supervisor's). */
export const EXIT_MEMORY_CAP = 75;

/** The ceiling, from a measurement (lead ruling 16116): five rooms with live panes, 5 lines/s/room of 2000 characters, 20 KB/s of pane output
 *  each, notes every 2 s, for 10 minutes: engine RSS 174 -> 224 MB, peak 228 MB, +0.69 MB/min and levelling (scripts/measure-engine-memory.mjs).
 *  1024 MB is about 4.5 times that peak: room for a legitimate large history, low enough to catch a runaway early. Configurable through the
 *  build profile and the saved first-run settings (HARBOR_WB_MEMORY_CEILING_MB). */
export const DEFAULT_CEILING_MB = 1024;
/** The supervisor's outside limit, a multiple of the ceiling: it kills an engine too stuck to check itself. */
export const OUTSIDE_LIMIT_FACTOR = 1.5;
export const outsideLimitMb = (ceilingMb: number): number => Math.round(ceilingMb * OUTSIDE_LIMIT_FACTOR);
export const DEFAULT_CHECK_MS = 30_000;

export interface MemoryCapConfig {
  ceilingBytes: number;
  intervalMs: number;
}

/** From HARBOR_WB_MEMORY_CEILING_MB (0 = off) and HARBOR_WB_MEMORY_CHECK_MS. null = the cap is off. */
export function memoryCapConfig(env: Record<string, string | undefined>): MemoryCapConfig | null {
  const mb = env.HARBOR_WB_MEMORY_CEILING_MB?.trim();
  const ceilingMb = mb === undefined || mb === '' ? DEFAULT_CEILING_MB : Number(mb);
  if (!Number.isFinite(ceilingMb) || ceilingMb <= 0) {
    return null;
  }
  const ms = Number(env.HARBOR_WB_MEMORY_CHECK_MS?.trim() || DEFAULT_CHECK_MS);
  const intervalMs = Number.isFinite(ms) && ms >= 50 ? Math.floor(ms) : DEFAULT_CHECK_MS;
  return { ceilingBytes: Math.floor(ceilingMb * 1024 * 1024), intervalMs };
}

export interface MemoryCapDeps {
  rss: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  /** Called once, the first time a sample is over the ceiling. */
  onExceed: (rssBytes: number, ceilingBytes: number) => void;
}

/** Start sampling. Returns a stop function. Fires onExceed at most once. */
export function startMemoryCap(cfg: MemoryCapConfig, deps: MemoryCapDeps): () => void {
  let fired = false;
  const handle = deps.setInterval(() => {
    if (fired) {
      return;
    }
    const rss = deps.rss();
    if (rss > cfg.ceilingBytes) {
      fired = true;
      deps.onExceed(rss, cfg.ceilingBytes);
    }
  }, cfg.intervalMs);
  return () => deps.clearInterval(handle);
}

export const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/** The line written into every open room before the engine exits. */
export function memoryCapFact(rssBytes: number, ceilingBytes: number): string {
  return `local rooms are restarting to free memory (the engine used ${mb(rssBytes)} MB; the limit is ${mb(ceilingBytes)} MB). Nothing is lost.`;
}
