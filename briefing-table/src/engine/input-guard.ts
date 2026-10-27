/**
 * A STUCK-KEY GUARD for the pty input path (Zack's phone, 2026-10-10: a "y" repeated without end and he had no Esc).
 *
 * A held key repeats at about 30 per second, so a window of WINDOW_MS that sees more than MAX_REPEATS copies of the SAME
 * tiny chunk is a runaway, not a person. Pasted text is one large chunk and never trips it. Once tripped, that pane
 * drops further copies of that chunk until it has been quiet for COOLDOWN_MS; any DIFFERENT input (an Esc, a Ctrl+C)
 * passes straight through, which is the whole point: the person can still stop the program. Pure: no timers, no I/O.
 */

export const WINDOW_MS = 1000;
export const MAX_REPEATS = 100;
export const COOLDOWN_MS = 2000;
export const TINY = 8; // chars; a longer chunk is a paste or a sequence, never a held key

interface PaneState {
  chunk: string;
  count: number;
  windowStart: number;
  lastAt: number;
  tripped: boolean;
}

export interface GuardVerdict {
  drop: boolean;
  /** True exactly once per trip, so the caller tells the person once and does not repeat itself. */
  notice: boolean;
}

export function createInputGuard() {
  const panes = new Map<string, PaneState>();
  return {
    check(paneid: string, data: string, now: number): GuardVerdict {
      let s = panes.get(paneid);
      if (data.length > TINY) {
        if (s) panes.delete(paneid);
        return { drop: false, notice: false };
      }
      if (s && s.tripped && data !== s.chunk) {
        /* a different key ends the runaway: it is a person */
        panes.delete(paneid);
        s = undefined;
      }
      if (!s || data !== s.chunk || now - s.lastAt > (s.tripped ? COOLDOWN_MS : WINDOW_MS)) {
        panes.set(paneid, { chunk: data, count: 1, windowStart: now, lastAt: now, tripped: false });
        return { drop: false, notice: false };
      }
      s.lastAt = now;
      if (s.tripped) {
        return { drop: true, notice: false };
      }
      if (now - s.windowStart > WINDOW_MS) {
        s.windowStart = now;
        s.count = 1;
        return { drop: false, notice: false };
      }
      s.count++;
      if (s.count > MAX_REPEATS) {
        s.tripped = true;
        return { drop: true, notice: true };
      }
      return { drop: false, notice: false };
    },
    forget(paneid: string): void {
      panes.delete(paneid);
    },
  };
}
