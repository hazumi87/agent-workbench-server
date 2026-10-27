/* The request budgets for module pages (ported from workbench-app src/module-budget.js; the design notes revision 7 C3). Per frame: 8 in
 * flight and 16 KiB a request. Per module: 20 requests a second (burst 40) and 256 KiB a second. Per app: 60 a second (burst 120) and 1 MiB a
 * second. Token buckets that refill continuously; nothing is taken unless every budget has room, and over any of them the answer is `slow`.
 * Replies are capped at 256 KiB. Pure: no http, no timers (the clock is passed in). test/modules-budget-approval.test.ts. */

export interface Limits {
  readonly inflightPerFrame: number; readonly requestBytes: number;
  readonly moduleRate: number; readonly moduleBurst: number; readonly moduleBytesPerSec: number;
  readonly appRate: number; readonly appBurst: number; readonly appBytesPerSec: number;
  readonly replyBytes: number;
}

export const LIMITS: Limits = Object.freeze({
  inflightPerFrame: 8, requestBytes: 16 * 1024,
  moduleRate: 20, moduleBurst: 40, moduleBytesPerSec: 256 * 1024,
  appRate: 60, appBurst: 120, appBytesPerSec: 1024 * 1024,
  replyBytes: 256 * 1024,
});

interface Bucket { has(n: number): boolean; take(n: number): void }

function bucket(rate: number, capacity: number, now: () => number): Bucket {
  let level = capacity;
  let at = now();
  const fill = (): void => {
    const t = now();
    level = Math.min(capacity, level + ((t - at) / 1000) * rate);
    at = t;
  };
  return {
    has(n) { fill(); return level >= n; },
    take(n) { level -= n; },
  };
}

export interface BudgetOptions { now?: () => number; limits?: Limits }
export interface BudgetTicket { ok: true; done(): void }
export interface BudgetSlow { ok: false; kind: 'slow' }
export interface Budget {
  /** {module, frame, bytes} (untrusted: anything but a finite non-negative byte count reads as too big) → a ticket, or {ok:false, kind:'slow'}. */
  take(req: { module: unknown; frame: unknown; bytes: unknown }): BudgetTicket | BudgetSlow;
  replyOk(bytes: unknown): boolean;
}

export function createBudget({ now = () => Date.now(), limits = LIMITS }: BudgetOptions = {}): Budget {
  const inflight = new Map<string, number>(); // frame -> count
  const mods = new Map<string, { count: Bucket; bytes: Bucket }>(); // module -> buckets
  const app = { count: bucket(limits.appRate, limits.appBurst, now), bytes: bucket(limits.appBytesPerSec, limits.appBytesPerSec, now) };
  const mod = (id: string): { count: Bucket; bytes: Bucket } => {
    let m = mods.get(id);
    if (!m) {
      m = { count: bucket(limits.moduleRate, limits.moduleBurst, now), bytes: bucket(limits.moduleBytesPerSec, limits.moduleBytesPerSec, now) };
      mods.set(id, m);
    }
    return m;
  };
  return {
    take({ module, frame, bytes }) {
      const n = typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : Infinity;
      const m = mod(String(module));
      const f = String(frame);
      const busy = inflight.get(f) || 0;
      if (n > limits.requestBytes || busy >= limits.inflightPerFrame ||
          !m.count.has(1) || !app.count.has(1) || !m.bytes.has(n) || !app.bytes.has(n)) {
        return { ok: false, kind: 'slow' };
      }
      m.count.take(1); app.count.take(1); m.bytes.take(n); app.bytes.take(n);
      inflight.set(f, busy + 1);
      let open = true;
      return {
        ok: true,
        done() {
          if (!open) return;
          open = false;
          const left = (inflight.get(f) || 1) - 1;
          if (left > 0) inflight.set(f, left); else inflight.delete(f);
        },
      };
    },
    replyOk: (bytes) => typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 && bytes <= limits.replyBytes,
  };
}
