/* THE CAUSES FEED (local mode): what the app's visible cause.log copies, as FIXED CODES only. A bounded in-memory ring of seat starts (and their refusals)
 * and seat exits; GET /api/local/causes?since=<n> reads it. Nothing here is text, a command line or a path: an unknown kind or code is dropped, a vendor is kept
 * only when it is a known vendor, a handle only when it is a slug. Memory only: an engine restart empties it, which the reader is told (gap). */
import { isSlug } from './agent-slug.ts';

export const CAUSES_MAX = 200;
export type CauseKind = 'seat-start' | 'seat-exit';
const START_CODES = ['started', 'vendor-missing', 'memory', 'no-project', 'refused'] as const;
const EXIT_CODES = ['ended-by-person', 'reaped', 'restart-cycle', 'exited', 'crashed'] as const;
const VENDORS = ['claude-code', 'codex-cli', 'gemini-cli'];

export interface CauseIn {
  kind: CauseKind;
  code: (typeof START_CODES)[number] | (typeof EXIT_CODES)[number];
  vendor?: string;
  handle?: string;
  room?: string;
  exit_code?: number | null;
}
export interface Cause extends CauseIn {
  n: number;
  ts: number;
}

let ring: Cause[] = [];
let counter = 0;

export function _reset(): void {
  ring = [];
  counter = 0;
}

const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function record(ev: CauseIn): void {
  const codes: readonly string[] = ev?.kind === 'seat-start' ? START_CODES : ev?.kind === 'seat-exit' ? EXIT_CODES : [];
  if (!codes.includes(ev.code)) {
    return;
  }
  const out: Cause = { n: ++counter, ts: Date.now(), kind: ev.kind, code: ev.code };
  if (typeof ev.vendor === 'string' && VENDORS.includes(ev.vendor)) out.vendor = ev.vendor;
  if (typeof ev.handle === 'string' && isSlug(ev.handle)) out.handle = ev.handle;
  if (typeof ev.room === 'string' && ROOM_ID.test(ev.room)) out.room = ev.room;
  if (ev.kind === 'seat-exit' && typeof ev.exit_code === 'number' && Number.isInteger(ev.exit_code)) out.exit_code = ev.exit_code;
  ring.push(out);
  if (ring.length > CAUSES_MAX) {
    ring = ring.slice(ring.length - CAUSES_MAX);
  }
}

/** Events newer than `since`. gap: events were lost (the ring overflowed past `since`) or `since` is ahead of this engine (it restarted). */
export function read(since: number): { next: number; gap: boolean; dropped: number; events: Cause[] } {
  const s = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
  const oldest = ring.length ? ring[0].n : counter + 1;
  const ahead = s > counter;
  const lost = !ahead && s > 0 && s < oldest - 1;
  /* dropped: how many events after `since` the ring no longer holds (0 for a restart: the numbers started over, nothing countable was lost) */
  const dropped = lost ? oldest - 1 - s : 0;
  return { next: counter, gap: ahead || lost, dropped, events: ahead || lost ? ring.slice() : ring.filter((e) => e.n > s) };
}

/** endReason (the engine's own word) and the exit code -> the fixed exit code. */
export function exitCodeOf(endReason: string | undefined | null, exitCode: number | null | undefined): (typeof EXIT_CODES)[number] {
  if (endReason === 'user') return 'ended-by-person';
  if (endReason === 'reaped') return 'reaped';
  if (endReason === 'cycle') return 'restart-cycle';
  return exitCode === 0 ? 'exited' : 'crashed';
}

/** A start refusal (a FieldError's code / field) -> the fixed start code. */
export function startRefusalCode(e: { code?: unknown; field?: unknown }): (typeof START_CODES)[number] {
  if (e.code === 'vendor-missing') return 'vendor-missing';
  if (e.field === 'memory') return 'memory';
  if (e.field === 'recipe_id') return 'no-project';
  return 'refused';
}
