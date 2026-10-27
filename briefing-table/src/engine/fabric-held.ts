/* ============================================================================
 * HELD AND RESTORED MAIL — the preamble an agent reads before a message that
 * waited for it (ticket, Owner 2026-09-30, KB design-notes-id part 4).
 *
 * WHY. A message to a disconnected agent is never silently held and handed
 * over later as if it were fresh: it could be a stale task the sender already
 * routed elsewhere. So when one DOES arrive late, the agent is told so, in
 * words, before it reads the message:
 *   hold     "You were offline. This message was left for you by <from> at
 *            <ts>. Check back with the sender before carrying it out."
 *   restore  "You were disconnected, and reconnected for an incoming message.
 *            Note, any background tasks … were ended when disconnected. Your
 *            incoming message is as follows."
 *
 * WHICH ENVELOPES (effectiveDelivery). The fabric stamps `delivery:'hold'|
 * 'restore'` (fabric-service 3fccbc3). Mail stored BEFORE that change, or on
 * any path that bypasses the 409, carries no field — so an envelope whose `ts`
 * is EARLIER than the moment the recipient's current process went live is a
 * hold too (Owner, 2026-09-30). "Went live" is the row's `started_at`: stamped
 * by the spawn/restore upsert and NOT by broker adoption, so an engine restart
 * never re-wraps mail sent while the pane was running all along. Unknown
 * (null started_at, unparseable ts) is NOT a hold: the envelope behaves as it
 * always has (three outcomes, never two).
 *
 * ONE PREAMBLE PER BATCH. The mailbox replay on subscribe delivers a burst of
 * frames; a short debounce collects them per (pane, kind) and they are typed
 * as ONE line, oldest first, each with its sender and time. A hold batch and a
 * restore batch never share a preamble — they say different things.
 *
 * THE TYPED PATH ONLY. On a channel pane (HARBOR_WB_CHANNELS=1) the envelope
 * reaches claude through fabric-mcp, which renders it itself; the preamble
 * there is fabric-mcp's to add from the same `delivery` field
 * (the design notes §2). This module is the
 * `typeIt` behind channels.routeFabric, so a channel miss that falls back to
 * typing still gets the preamble.
 *
 * COUNTS, NEVER CONTENT, in logs (the /api/handoff rule).
 * ========================================================================== */

import * as roomTyper from './room-typer.ts';
import type { Envelope } from './fabric.ts';

export type Delivery = 'hold' | 'restore';

/** The field when the fabric set it; otherwise `hold` when the envelope was
 *  sent before the recipient's current process went live; otherwise null. */
export function effectiveDelivery(
  env: Pick<Envelope, 'ts' | 'delivery'>,
  startedAt: number | null | undefined,
): { delivery: Delivery; inferred: boolean } | null {
  if (env.delivery === 'hold' || env.delivery === 'restore') {
    return { delivery: env.delivery, inferred: false };
  }
  const sent = Date.parse(env.ts);
  if (typeof startedAt === 'number' && Number.isFinite(startedAt) && Number.isFinite(sent) && sent < startedAt) {
    return { delivery: 'hold', inferred: true };
  }
  return null;
}

/** An envelope's time as ISO-8601 (UTC), or the raw string when unparseable. */
export function isoTs(ts: string): string {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toISOString() : ts;
}

export const RESTORE_PREAMBLE =
  'You were disconnected, and reconnected for an incoming message. Note, any background tasks you may have had running in your session were ended when disconnected. Your incoming message is as follows.';

/** The hold preamble for ONE envelope (Owner's wording, verbatim). */
export function holdPreamble(from: string, ts: string): string {
  return `You were offline. This message was left for you by ${from} at ${isoTs(ts)}. Check back with the sender before carrying it out.`;
}

function preambleFor(delivery: Delivery, envs: Envelope[]): string {
  if (delivery === 'restore') {
    return envs.length === 1
      ? RESTORE_PREAMBLE
      : `You were disconnected, and reconnected for incoming messages. Note, any background tasks you may have had running in your session were ended when disconnected. Your ${envs.length} incoming messages are as follows, oldest first.`;
  }
  return envs.length === 1
    ? holdPreamble(envs[0].from, envs[0].ts)
    : `You were offline. These ${envs.length} messages were left for you, oldest first, each marked with who left it and when. Check back with each sender before carrying one out.`;
}

/** Oldest first by `ts`; arrival order breaks ties and orders unparseable ones. */
export function oldestFirst(envs: Envelope[]): Envelope[] {
  return envs
    .map((e, i) => ({ e, i, t: Date.parse(e.ts) }))
    .sort((a, b) => (Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? a.t - b.t : a.i - b.i))
    .map((x) => x.e);
}

/**
 * The typed line(s) for one batch: ONE preamble, then every envelope oldest
 * first, each framed exactly as a single fabric message is (room-typer
 * frameFabric) and — in a batch of more than one, or on a restore — tagged with
 * its sender and time. More than `max` chars splits into several lines; only
 * the first carries the preamble, the rest say which part they are.
 */
export function composeHeld(delivery: Delivery, input: Envelope[], max: number = roomTyper.TYPE_TEXT_MAX): string[] {
  const envs = oldestFirst(input);
  if (!envs.length) {
    return [];
  }
  const pre = preambleFor(delivery, envs);
  const n = envs.length;
  /* One item may never crowd out the preamble: each frame is capped so the
     first line always fits preamble + one item. */
  const itemMax = Math.max(200, max - pre.length - 60);
  const items = envs.map((e, i) => {
    const mark = n > 1 ? `[${i + 1} of ${n} · from ${e.from} at ${isoTs(e.ts)}] ` : delivery === 'restore' ? `[from ${e.from} at ${isoTs(e.ts)}] ` : '';
    return mark + roomTyper.frameFabric(e, itemMax - mark.length);
  });
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = pre.length;
  for (const it of items) {
    if (cur.length && len + 2 + it.length > max) {
      chunks.push(cur);
      cur = [];
      len = 40; // room for a continuation header
    }
    cur.push(it);
    len += 2 + it.length;
  }
  chunks.push(cur);
  return chunks.map((c, k) =>
    k === 0 ? `${pre} ${c.join('  ')}` : `[continued, part ${k + 1} of ${chunks.length}] ${c.join('  ')}`,
  );
}

/* ---------------------------------------------------------------------------
 * THE BATCHER — per (pane, delivery), a short debounce so a mailbox replay's
 * burst becomes one line. Bounded both ways: every add restarts the quiet
 * window, and MAX_WAIT_MS caps how long the first envelope can wait.
 * ------------------------------------------------------------------------- */

const quietMs = (): number => {
  const v = Number(process.env.HARBOR_WB_FABRIC_BATCH_MS);
  return Number.isFinite(v) && v >= 0 && process.env.HARBOR_WB_FABRIC_BATCH_MS !== '' ? v : 400;
};
const MAX_WAIT_MS = 3_000;

type Sink = (paneid: string, text: string) => string;
let sink: Sink = (paneid, text) => roomTyper.enqueueFabricText(paneid, text);
let log: (line: string) => void = () => {};

interface Batch {
  envs: Envelope[];
  firstAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const batches = new Map<string, Batch>();

function key(paneid: string, delivery: Delivery): string {
  return `${delivery}|${paneid}`;
}

function flush(paneid: string, delivery: Delivery): void {
  const k = key(paneid, delivery);
  const b = batches.get(k);
  batches.delete(k);
  if (!b?.envs.length) {
    return;
  }
  if (b.timer) {
    clearTimeout(b.timer);
  }
  const lines = composeHeld(delivery, b.envs);
  const results: string[] = [];
  for (const line of lines) {
    try {
      results.push(sink(paneid, line));
    } catch (e) {
      results.push('error');
      log(`fabric-held: type failed for ${paneid}: ${(e as Error).message}`);
    }
  }
  log(`fabric-held → ${paneid}: ${delivery} batch of ${b.envs.length} envelope(s) as ${lines.length} line(s): ${results.join(',')}`);
}

/**
 * Hold one envelope for its pane's batch. Returns `queued` (room-typer's word
 * for "will be typed") so channels.pathOfTyped files it as the typed path.
 */
export function add(paneid: string, delivery: Delivery, env: Envelope): 'queued' {
  const k = key(paneid, delivery);
  let b = batches.get(k);
  if (!b) {
    b = { envs: [], firstAt: Date.now(), timer: null };
    batches.set(k, b);
  }
  b.envs.push(env);
  if (b.timer) {
    clearTimeout(b.timer);
  }
  const wait = Math.max(0, Math.min(quietMs(), b.firstAt + MAX_WAIT_MS - Date.now()));
  b.timer = setTimeout(() => {
    try {
      flush(paneid, delivery);
    } catch (e) {
      log(`fabric-held: flush threw for ${paneid}: ${(e as Error).message}`); // a throw in a timer is engine-fatal
    }
  }, wait);
  b.timer.unref?.();
  return 'queued';
}

/** The pane ended: its unsent batches go with it (fabric.drop's rule). */
export function drop(paneid: string): void {
  for (const d of ['hold', 'restore'] as const) {
    const b = batches.get(key(paneid, d));
    if (b?.timer) {
      clearTimeout(b.timer);
    }
    batches.delete(key(paneid, d));
  }
}

export function setLog(fn: (line: string) => void): void {
  log = fn;
}

/** Tests only: where a composed line goes (default room-typer). */
export function setSink(fn: Sink | null): void {
  sink = fn ?? ((paneid, text) => roomTyper.enqueueFabricText(paneid, text));
}

/** Tests only. */
export function reset(): void {
  for (const b of batches.values()) {
    if (b.timer) {
      clearTimeout(b.timer);
    }
  }
  batches.clear();
}
