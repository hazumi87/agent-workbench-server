/* THE ENGINE'S LAST MEMORY REPORT. The app supervisor MEASURES (the broker job's accounting plus the PC's free memory) and hands the
 * numbers in; the ENGINE decides (memory-budget.ts). This holds the latest report and calls it unknown once it is stale, so a supervisor
 * that died can never leave the engine believing there is room. Pure: the caller passes the clock. */
import type { MemoryFacts } from './memory-budget.ts';

/** A report older than this is no report. The supervisor is expected to send about every 10 s. */
export const MEMORY_STALE_MS = 60_000;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2 ** 50;

/** The supervisor's body -> facts, or null when it is not a usable report. */
export function parseReport(b: unknown): MemoryFacts | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return null;
  }
  const o = b as Record<string, unknown>;
  if (!num(o.usedBytes) || !num(o.freeBytes)) {
    return null;
  }
  if (o.jobCapBytes !== undefined && o.jobCapBytes !== null && !num(o.jobCapBytes)) {
    return null;
  }
  if (o.residentBytes !== undefined && !num(o.residentBytes)) {
    return null;
  }
  return {
    usedBytes: o.usedBytes,
    ...(typeof o.residentBytes === 'number' ? { residentBytes: o.residentBytes } : {}),
    freeBytes: o.freeBytes,
    jobCapBytes: typeof o.jobCapBytes === 'number' ? o.jobCapBytes : null,
  };
}

export class MemorySource {
  private facts: MemoryFacts | null = null;
  private at = 0;

  report(f: MemoryFacts, now: number): void {
    this.facts = f;
    this.at = now;
  }

  /** The latest report, or null when there is none or it is stale. */
  current(now: number): MemoryFacts | null {
    return this.facts && now - this.at <= MEMORY_STALE_MS ? this.facts : null;
  }
}
