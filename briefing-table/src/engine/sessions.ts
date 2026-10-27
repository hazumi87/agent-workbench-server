/**
 * Resident-session registry (Milestone 3) — "a resident CLI must survive its
 * viewer" (decision 7), within a single engine run.
 *
 * A pane's PTY is owned here, keyed by paneid, INDEPENDENT of any socket. A
 * browser reload drops the socket but NOT the process: the session stays
 * resident, buffering output, until a new socket for the same paneid reattaches
 * (replaying the buffer) or a reap timer fires. Only an explicit kill or the
 * process exiting ends it.
 *
 * This is the local-PTY, same-engine-run version of rehydration — the same
 * reattach-by-key shape the dispatcher (#1) will generalize across engine
 * restarts and resumable vendors. Cross-restart survival is deferred (Walk): a
 * local PTY dies with its engine, so that case needs the dehydrate/resume model.
 */
import { readFileSync } from 'node:fs';
import type { WebSocket } from 'ws';
import type { IDisposable } from 'node-pty';
import type { CliSession } from './cli-host.ts';
import { instancePath } from './data-dir.ts';


/** Optional runtime config at the repo root, e.g. {"reapMs": 43200000}. Edited
 *  in place (no rebuild); the deterministic alternative to env vars, which the
 *  scheduled task doesn't reliably inherit. See config.example.json. */
function configReapMs(): number | undefined {
  try {
    const cfg = JSON.parse(readFileSync(instancePath('config.json'), 'utf8'));
    return typeof cfg.reapMs === 'number' ? cfg.reapMs : undefined;
  } catch {
    return undefined;
  }
}

/* REPLAY CAP (raised 256KB -> 2MB, Owner 2026-09-10: "i can't scroll back
 * through to my previous reply to refresh on what exactly I typed").
 *
 * The cap is in BYTES and a full-screen TUI spends them on REPAINTS, not
 * content — one keystroke in Claude Code emits ~2295 bytes (2026-09-03). So
 * 256KB of an active claude pane measured as only 510 newlines of reachable
 * history, which is the ceiling Owner hit on every session at once.
 *
 * More bytes also buys better LAYOUT, not just more lines, and that is the
 * less obvious half: a TUI periodically repaints its whole screen, so a longer
 * buffer is far likelier to CONTAIN one — and everything after a full repaint
 * reconstructs correctly. A short buffer usually starts mid-screen, where the
 * stream is nothing but absolute cursor moves into a screen the fresh terminal
 * never saw. That is the real cause of "the formatting is all over the place",
 * and raising this only mitigates it — see docs/ for the headless-terminal fix. */
const MAX_BUFFER_BYTES = Number(process.env.HARBOR_WB_REPLAY_BYTES) || 2 * 1024 * 1024;

/**
 * The TIME lever (Owner, 2026-06-09). A detached session (no viewer) is reaped
 * after this many ms.
 *
 * DEFAULT IS NOW 0 (NEVER REAP) — config.json, 2026-08-24. Read this before
 * raising it again, because the premise this lever was built on is false:
 *
 *   VIEWER ABSENCE IS NOT EVIDENCE OF ABANDONMENT.
 *
 * The installation tested exactly this and wrote it down (KB `design-notes-id`,
 * "Phase 0 connection state test results", 2026-05-06):
 *   · iOS — ANY foreground loss (home screen, another app, screen lock, tab
 *     close) drops the WebSocket immediately. Backgrounding a browser IS the
 *     normal state of a phone, so "no viewer" happens constantly to a session
 *     nobody has abandoned.
 *   · PC — tab close is the only reliable disconnect; screen lock does nothing.
 *   · Its verdict, verbatim: "idle_seconds is NOT a reliable 'user is gone'
 *     signal".
 *
 * The PTY-broker exists precisely so viewers are DISPOSABLE — a session
 * outliving its window is the feature, not a leak to collect. On 2026-08-24 a
 * 12h timer, armed when a laptop lid closed, killed five live agent sessions
 * overnight; the one that survived did so only because it happened to be
 * PARKED. Same idleness, opposite fate, decided by which verb last touched it.
 *
 * If a resource ceiling is ever genuinely needed, key it on something that
 * actually means abandonment — not on whether a socket is currently attached.
 *
 * `HARBOR_WB_REAP_MS=0` (or negative) = NEVER reap. The roadmap
 * (the design notes) replaces this global knob with a per-session
 * policy — (origin, connection, vendor) → (timeout, end-verb: dehydrate|kill).
 * scheduleReap is where that policy will be consulted; note that its end-verb
 * for anything resumable should be DEHYDRATE, which is now what the reap path
 * records (see `endReason` below).
 */
const REAP_MS = configReapMs() ?? Number(process.env.HARBOR_WB_REAP_MS ?? 60 * 60 * 1000);

/** The configured reap timeout in ms (<= 0 means never reap / pinned). */
export function reapMs(): number {
  return REAP_MS;
}

export interface ReapHold {
  reason: string;
  since: number;
  lastAt: number;
  clearedAt: number | null;
  deferrals: number;
  lastLogged?: string;
}

export interface Resident {
  paneid: string;
  cli: CliSession;
  /** THE CONTROLLER — the one viewer allowed to write to the pty (input,
   *  resize, kill). null = nobody holds control right now; the session keeps
   *  running and viewers keep watching. See `viewers` for the difference. */
  socket: WebSocket | null;
  /** EVERY attached viewer, controller included. Output broadcasts to all of
   *  them; only `socket` may write back. This is what makes "one keyboard, many
   *  screens" true: before the control lease, a second attach silently replaced
   *  `socket` and the displaced viewer kept typing into the pty with a frozen
   *  screen — two keyboards, one session (found 2026-08-19). */
  viewers: Set<WebSocket>;
  /** Human label of whoever holds control, for the "paused — <who> has it"
   *  message on the viewers that do not. */
  controllerLabel: string | null;
  buffer: string[];
  bufferBytes: number;
  reapTimer: ReturnType<typeof setTimeout> | null;
  /** The armed reap (scheduleReap), or undefined. Kept beside the timer so a
   *  guard-deferred reap can re-arm with the same window and callback. */
  reapArm?: { ms: number; onReap: (r: Resident) => void; armedAt: number; dueAt: number };
  /** What the reap guard last said (W5): why the reap is being held, since
   *  when, when it was last seen holding, and when it cleared. */
  reapHold?: ReapHold;
  onData: IDisposable;
  onExit: IDisposable;
  /** Per-session reap override (ms). Solo/recipe windows use a SHORT grace
   *  (close = kill, but a reload's drop-and-reattach survives). This is the
   *  first per-class value the reap-policy roadmap (the design notes,
   *  ticket) anticipated; unset = the global REAP_MS. */
  reapOverrideMs?: number;
  /** WHY this session is ending, set just before we kill it.
   *
   *  It decides whether the row is recorded `killed` or `dehydrated`, and those
   *  mean different things: `killed` is "the user ended it" (the ✕, the End
   *  button) and must never auto-resume; `reaped` is "we took it away while
   *  nobody was looking", which is not a decision the user made and should come
   *  back on its own. Without this, onExit stamps everything `killed` and a
   *  reaped conversation can never be auto-restored. */
  endReason?: 'user' | 'reaped' | 'cycle';
  /** When the session was registered — the bad-spawn heuristic (vk [ref])
   *  reads it: on Linux a missing binary forks fine and dies in the child
   *  (exit≠0, no output, no `error` event), unlike Windows' synchronous throw. */
  spawnedAt: number;
  /** Registered by broker ADOPTION (no socket: an engine restart or a returning
   *  host), not spawned by this engine process. Input typed before the adopt
   *  was never seen here, so the voice draft guard reads such a pane's input
   *  line as UNKNOWN (= a draft) until the user submits something. */
  adopted: boolean;
}

const residents = new Map<string, Resident>();

/** Every resident, for the few callers that act on all of them at once
 *  (a UI-reload push, a shutdown sweep). Iteration only — never mutate. */
export function entries(): Array<[string, Resident]> {
  return [...residents.entries()];
}

export function get(paneid: string): Resident | undefined {
  return residents.get(paneid);
}

export function isLive(r: Resident | undefined): r is Resident {
  return !!r && r.cli.state === 'live';
}

const NOOP: IDisposable = { dispose() {} };

/* ---- REMOVE OBSERVER (voice channel, ticket) ------------------------------
 *
 * Called when a resident leaves the registry (its process ended). The voice
 * channel closes a dead pane's channel here, without a line in onExit.
 * Observers run in try/catch: teardown must never fail because someone was
 * watching it. */
type RemoveTap = (paneid: string) => void;
const removeTaps: RemoveTap[] = [];

/** Observe a resident leaving the registry (its process ended). */
export function onRemove(cb: RemoveTap): void {
  removeTaps.push(cb);
}

/**
 * Register a freshly spawned session. The caller wires `onData`/`onExit` onto
 * the returned resident afterward (they need to close over this object), and
 * `remove()` disposes them.
 */
export function add(paneid: string, cli: CliSession, socket: WebSocket): Resident {
  const r: Resident = {
    paneid,
    cli,
    socket,
    viewers: new Set(socket ? [socket] : []),
    controllerLabel: null,
    buffer: [],
    bufferBytes: 0,
    reapTimer: null,
    onData: NOOP,
    onExit: NOOP,
    spawnedAt: Date.now(),
    adopted: socket === null, // the adopt path passes no socket; a spawn always has one
  };
  residents.set(paneid, r);
  return r;
}

/** Append pty output to the replay buffer, trimming from the front past the cap. */
export function pushOutput(r: Resident, data: string): void {
  r.buffer.push(data);
  r.bufferBytes += data.length;
  while (r.bufferBytes > MAX_BUFFER_BYTES && r.buffer.length > 1) {
    r.bufferBytes -= r.buffer.shift()!.length;
  }
}

export function replay(r: Resident): string {
  const raw = r.buffer.join('');
  /* NEVER OPEN ON AN ORPHANED SEQUENCE TAIL. Trimming drops whole pty chunks,
     and a chunk boundary is arbitrary — it can fall in the middle of an escape
     sequence, leaving the replay starting with that sequence's tail (`7;29H`),
     which a terminal prints as literal garbage before it recovers. ESC always
     begins a sequence, so the first ESC is the earliest provably safe start.
     Costs at most a few bytes and only when the cut landed badly. */
  const esc = raw.indexOf('');
  return esc <= 0 ? raw : raw.slice(esc);
}

export function remove(paneid: string): void {
  const r = residents.get(paneid);
  if (r?.reapTimer) {
    clearTimeout(r.reapTimer);
  }
  r?.onData.dispose();
  r?.onExit.dispose();
  residents.delete(paneid);
  if (r) {
    for (const t of removeTaps) {
      try {
        t(paneid);
      } catch {
        /* an observer must never break teardown */
      }
    }
  }
}

/* ---- REAP GUARD (W5, Owner 2026-09-24) -------------------------------------
 *
 * A pane is NOT reaped while something says it is still wanted (a persistent
 * seat in an open room; streaming or waiting — src/engine/reap-guard.ts).
 * The guard is INJECTED (setReapGuard, wired in index.ts) so this module never
 * imports rooms or activity.
 *
 * "When the condition clears the normal reap schedule applies FROM THAT
 * MOMENT": a sweep samples the guard every GUARD_POLL_MS while a reap is
 * armed, and the reap fires no earlier than one full reap window after the
 * guard was LAST seen holding (granularity: one poll). reapMs semantics are
 * otherwise unchanged; <= 0 still means never, and nothing is armed then.
 * A guard that THROWS holds the reap ('guard-error'): could-not-tell is not
 * "abandoned", and reaping is the irreversible side. */
type ReapGuard = (paneid: string) => string | null;
let reapGuard: ReapGuard = () => null;
let reapLog: (line: string) => void = () => {};
const GUARD_POLL_MS = Number(process.env.HARBOR_WB_REAP_GUARD_POLL_MS) || 15_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Install the reap guard (reason string = hold, null = reap as normal). */
export function setReapGuard(fn: ReapGuard, log?: (line: string) => void): void {
  reapGuard = fn;
  if (log) {
    reapLog = log;
  }
}

function guardReason(paneid: string): string | null {
  try {
    return reapGuard(paneid);
  } catch {
    return 'guard-error';
  }
}

/** Sample the guard into `r.reapHold`; returns the reason, or null. */
function observeGuard(r: Resident, now: number): string | null {
  const reason = guardReason(r.paneid);
  const h = r.reapHold;
  if (reason) {
    if (!h || h.clearedAt !== null) {
      r.reapHold = { reason, since: now, lastAt: now, clearedAt: null, deferrals: h?.deferrals ?? 0 };
    } else {
      h.reason = reason;
      h.lastAt = now;
    }
  } else if (h && h.clearedAt === null) {
    h.clearedAt = now;
    const ms = r.reapArm?.ms ?? 0;
    reapLog(`reap guard cleared paneid=${r.paneid} (was ${h.reason}, held ${Math.round((now - h.since) / 1000)}s, ${h.deferrals} deferral(s)) — reap in ${ms}ms`);
  }
  return reason;
}

function ensureSweep(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    const now = Date.now();
    let armed = 0;
    for (const r of residents.values()) {
      if (r.reapArm && r.reapTimer) {
        armed++;
        observeGuard(r, now);
      }
    }
    if (armed === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, GUARD_POLL_MS);
  sweepTimer.unref?.();
}

function armReap(r: Resident, delay: number): void {
  r.reapTimer = setTimeout(() => fireReap(r), delay);
  if (r.reapArm) {
    r.reapArm.dueAt = Date.now() + delay;
  }
  ensureSweep();
}

function fireReap(r: Resident): void {
  r.reapTimer = null;
  const arm = r.reapArm;
  if (!arm) {
    return;
  }
  // Reap on NO VIEWERS, not on "no controller". A pane being watched
  // read-only (an iPad following a long run) is not abandoned, and a
  // controller stepping away must not start a countdown under it.
  if (r.viewers.size !== 0) {
    r.reapArm = undefined;
    r.reapHold = undefined;
    return;
  }
  const now = Date.now();
  const reason = observeGuard(r, now);
  if (reason) {
    const h = r.reapHold!;
    h.deferrals++;
    if (h.deferrals === 1 || h.lastLogged !== reason) {
      reapLog(`reap deferred paneid=${r.paneid} reason=${reason} (deferral ${h.deferrals})`);
      h.lastLogged = reason;
    }
    armReap(r, arm.ms);
    return;
  }
  const wait = r.reapHold ? r.reapHold.lastAt + arm.ms - now : 0;
  if (wait > 0) {
    armReap(r, wait); // cleared less than a full reap window ago
    return;
  }
  r.reapArm = undefined;
  r.reapHold = undefined;
  arm.onReap(r);
}

export function cancelReap(r: Resident): void {
  if (r.reapTimer) {
    clearTimeout(r.reapTimer);
    r.reapTimer = null;
  }
  r.reapArm = undefined;
  r.reapHold = undefined;
}

/** Arm the reaper for a now-detached session; `onReap` runs if nobody
 *  reattaches and the reap guard does not hold it. */
export function scheduleReap(r: Resident, onReap: (r: Resident) => void): void {
  cancelReap(r);
  const ms = r.reapOverrideMs ?? REAP_MS;
  if (ms <= 0) {
    return; // pinned: this session is never viewer-reaped (warm-session stopgap)
  }
  const now = Date.now();
  r.reapArm = { ms, onReap, armedAt: now, dueAt: now + ms };
  observeGuard(r, now); // a hold already true at detach counts from now
  armReap(r, ms);
}

/** Every armed reap, for the diag: when it is due and what holds it. */
export function reapState(): {
  guardPollMs: number;
  armed: Array<{ paneid: string; reapMs: number; armedAt: number; dueAt: number; held: string | null; hold: ReapHold | null }>;
} {
  const armed = [];
  for (const r of residents.values()) {
    if (r.reapArm) {
      const h = r.reapHold ?? null;
      armed.push({
        paneid: r.paneid,
        reapMs: r.reapArm.ms,
        armedAt: r.reapArm.armedAt,
        dueAt: r.reapArm.dueAt,
        held: h && h.clearedAt === null ? h.reason : null,
        hold: h ? { ...h } : null,
      });
    }
  }
  return { guardPollMs: GUARD_POLL_MS, armed };
}
