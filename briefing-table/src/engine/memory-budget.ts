/* MEMORY BUDGET (item 3; design review [ref]). PURE: no clock, no I/O, no db. The ENGINE decides here; the app supervisor MEASURES
 * (job accounting) and hands the numbers in, so there is no broker change and this module is testable against a fake source.
 *
 * budget = min(job cap, what this PC can give the agents) where the second is (agents' use + PC free memory).
 * used / budget >= sleepAt  -> sleep the least-recently-active IDLE seat (idle-rest's never-rest rules: never one working, waiting
 *                              on the person, or holding a draft);
 * used / budget >= refuseAt -> refuse a new start and show the numbers. A wake is a start: it waits for room.
 * Memory that cannot be measured is its own answer ('unknown'), said out loud; it never refuses silently and never claims there is room.
 * The 70/85 defaults await Owner (day plan row 3); callers may pass others. */

export interface MemoryFacts {
  /** Bytes the agent processes have COMMITTED (the job object's accounting, children and MCP servers included). The job cap is a commit
   *  limit, so this is what is compared with `jobCapBytes`. */
  usedBytes: number;
  /** Bytes of that which are RESIDENT (working set). Compared with the PC's free PHYSICAL memory. Omitted = the same number as
   *  `usedBytes` (older reports, and a supervisor that can only measure one). */
  residentBytes?: number;
  /** Bytes this PC has free right now. */
  freeBytes: number;
  /** The broker job cap in bytes, or null if there is none. */
  jobCapBytes: number | null;
}

export interface MemoryThresholds {
  sleepAt: number;
  refuseAt: number;
}

export const MEMORY_DEFAULTS: Readonly<MemoryThresholds> = Object.freeze({ sleepAt: 0.7, refuseAt: 0.85 });

export type MemoryLevel = 'ok' | 'sleep' | 'refuse' | 'unknown';

export interface MemoryVerdict {
  level: MemoryLevel;
  /** used / budget, 0..1+; null when unknown. */
  fraction: number | null;
  budgetBytes: number | null;
  usedBytes: number | null;
  /** The numbers alone, e.g. "1800 MB of 2048 MB in use (88%)" (MB = 1024 x 1024 bytes, rounded); null when unknown. */
  numbers: string | null;
  /** One plain sentence, for a refusal or a room fact. */
  text: string;
}

const MB = 1024 * 1024;
const mb = (b: number): string => `${Math.round(b / MB)} MB`;
const sane = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function assess(facts: MemoryFacts | null, t: MemoryThresholds = MEMORY_DEFAULTS): MemoryVerdict {
  if (!facts || !sane(facts.usedBytes) || !sane(facts.freeBytes) || (facts.residentBytes !== undefined && !sane(facts.residentBytes)) || (facts.jobCapBytes !== null && !sane(facts.jobCapBytes))) {
    return { level: 'unknown', fraction: null, budgetBytes: null, usedBytes: null, numbers: null, text: 'memory could not be measured on this PC, so no limit is being applied' };
  }
  /* Two ratios, each against its own kind, and the worse one decides: commit against the cap (when there is one), resident against what
     the PC can physically give the agents (resident + free). A big commit that is mostly paged out is not a tight PC, and a roomy cap
     does not help a PC that is out of memory. */
  const resident = facts.residentBytes ?? facts.usedBytes;
  const pcBudget = resident + facts.freeBytes;
  if (pcBudget <= 0 && (facts.jobCapBytes === null || facts.jobCapBytes <= 0)) {
    return { level: 'unknown', fraction: null, budgetBytes: null, usedBytes: facts.usedBytes, numbers: null, text: 'memory could not be measured on this PC, so no limit is being applied' };
  }
  const pcFraction = pcBudget > 0 ? resident / pcBudget : 0;
  const capFraction = facts.jobCapBytes !== null && facts.jobCapBytes > 0 ? facts.usedBytes / facts.jobCapBytes : 0;
  const capBinds = capFraction >= pcFraction && facts.jobCapBytes !== null && facts.jobCapBytes > 0;
  const fraction = capBinds ? capFraction : pcFraction;
  const budget = capBinds ? (facts.jobCapBytes as number) : pcBudget;
  const used = capBinds ? facts.usedBytes : resident;
  const nums = `${mb(used)} of ${mb(budget)} in use (${Math.round(fraction * 100)}%)`;
  const level: MemoryLevel = fraction >= t.refuseAt ? 'refuse' : fraction >= t.sleepAt ? 'sleep' : 'ok';
  const text =
    level === 'refuse'
      ? `agents are using too much memory to start another: ${nums}, the limit is ${Math.round(t.refuseAt * 100)}%. Sleep or end an agent, then try again.`
      : level === 'sleep'
        ? `agents are using a lot of memory: ${nums}; the least active idle one will sleep`
        : nums;
  return { level, fraction, budgetBytes: budget, usedBytes: used, numbers: nums, text };
}

export interface SeatMemoryFacts {
  id: string;
  /** Ms since the seat last did anything (output, input, or a delivered line). */
  idleMs: number;
  /** idle-rest's never-rest rules: working, waiting on the person, holding a draft or an ask, not live. */
  neverRest: boolean;
}

/** The seat to sleep: the least recently active of those that may rest, or null. Ties go to the lowest id so a retry is stable. */
export function pickToSleep(seats: SeatMemoryFacts[]): string | null {
  const ok = seats.filter((s) => !s.neverRest && sane(s.idleMs));
  ok.sort((a, b) => b.idleMs - a.idleMs || (a.id < b.id ? -1 : 1));
  return ok[0]?.id ?? null;
}
