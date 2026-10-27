/* ============================================================================
 * SPAWN GUARD (S0 guard 7 — the design notes §4.4 item 7) [ticket].
 *
 * Two claudes must never write one conversation: the live orphan (N1), the
 * double resume (F11), or a picker pane and a seat Restore on one id. The
 * engine's only spawn path (index.ts handleAttach) gains a few lines; the
 * logic lives here, with every dependency handed in so it is unit-testable
 * without a table, a broker or a /proc.
 *
 * MUTEX (`serialize`): one attach per paneid at a time. A second attach for a
 * pane whose spawn is in flight awaits it and then runs from the top, re-
 * reading the row — so it REATTACHES to what the first one spawned instead of
 * spawning a second claude (F11: two concurrent attaches → exactly one spawn).
 *
 * POSITIVE CHECKS (`check`), on every RESTORE (a banked/located uuid, or a
 * named resume), after the vendor's locate and synchronously up to the spawn.
 * Ids are uuids only: a resume NAME is per project and may repeat across
 * projects, so matching it would refuse healthy panes — a named restore gets
 * (iii)'s exact-paneid rule and the mutex, nothing id-based.
 *   (i)   another LIVE row, in a different pane, banks this conversation;
 *   (ii)  another pane is resuming it right now (`markResuming`, set just
 *         before the broker spawn, cleared on failure or 10 s later);
 *   (iii) the /proc classifier (proc-classifier.ts, `ended` phase) finds a
 *         claude naming the banked or located id as a flag pair, or an
 *         interactive claude carrying exactly this paneid that names no OTHER
 *         conversation uuid (`pane-other` never refuses: a stopped orphan on
 *         its own conversation must not block this one) — only when the pty
 *         runs on this host (the caller says so).
 * JUST-ENDED WAIT: when the only collider (the one blocking claude, or a
 * `pane-other` one when nothing blocks) is a claude in state S or R that
 * started before this pane's last End, and that End was under 20 s ago, the
 * previous claude is still on its way out (an ordinary End → Resume): wait up
 * to 10 s (the pane is told why), then re-check once.
 *
 * COULD NOT TELL = PROCEED AS TODAY: a classifier that answers null (not
 * Linux, no proc root), a pane whose pty is not on this host, a check that
 * throws. The guard only ever refuses on positive evidence.
 *
 * ROLLBACK LEVER: runtimeFlag('collisionGuard') = 'warn' logs what it would
 * have refused and proceeds, with no wait (Owner's call only). The mutex stays
 * in both modes: it is not a judgement, it only orders two attaches.
 *
 * Read-only toward processes: it never signals or kills anything (Q8). The
 * refusal text tells a person how to, for an orphan, and why to check first.
 * ========================================================================== */

import type { Classification, ClassifyQuery, ProcHit } from './proc-classifier.ts';

/** How long an id stays "being resumed" after its spawn started. */
export const RESUMING_MS = 10_000;
/** A collider that started before an End this recent may still be exiting. */
export const JUST_ENDED_MS = 20_000;
/** How long the just-ended wait holds the pane (and the mutex). */
export const WAIT_MS = 10_000;
/** Refusal (1): End this recent → "is still stopping". */
export const STOPPING_MS = 60_000;
const POLL_MS = 250;

export interface GuardDeps {
  /** The table's LIVE rows (paneid, the banked uuid). */
  liveRows(): Array<{ paneid: string; session_id: string | null }>;
  /** proc-classifier.classify. Null = could not tell. */
  classify(q: ClassifyQuery): Classification | null;
  /** How a refusal names a pane: `@slug`, or its name. */
  labelOf(paneid: string): string;
  /** runtimeFlag('collisionGuard'): 'enforce' (the default) or 'warn'. */
  mode(): string;
  log(line: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface CheckInput {
  paneid: string;
  /** Conversation ids this restore resumes: the banked and the located uuid
   *  (empty for a named resume). */
  ids: string[];
  /** The pane's pty runs on THIS host, so /proc can see its processes. */
  local: boolean;
}

export type Refusal = {
  ok: false;
  /** Whose pid (§4.4 item 7): 1 this pane's previous claude, 2 another live
   *  pane, 3 an orphan. */
  owner: 1 | 2 | 3;
  pid: number | null;
  /** Owner 2: the pane running this conversation. */
  openIn: string | null;
  lstart: string | null;
  message: string;
};
export type Verdict = { ok: true } | Refusal;

/* ------------------------------------------------------------ mutex ---- */

const inFlight = new Map<string, Promise<void>>();

/** Run `fn` with no other `serialize` for this paneid running. A caller that
 *  finds one in flight awaits it, then re-checks (another waiter may have
 *  gone first), so attaches run one at a time, in arrival order. */
export async function serialize<T>(paneid: string, fn: () => Promise<T>): Promise<T> {
  for (let busy = inFlight.get(paneid); busy; busy = inFlight.get(paneid)) {
    await busy;
  }
  let done!: () => void;
  inFlight.set(paneid, new Promise<void>((r) => (done = r)));
  try {
    return await fn();
  } finally {
    inFlight.delete(paneid);
    done();
  }
}

/* ------------------------------------------------ resuming + ended ---- */

const resuming = new Map<string, { paneid: string; until: number }>();
const endedAt = new Map<string, number>();

/** Just before the broker spawn: these ids are being resumed by `paneid`.
 *  Returns the clear to call when the spawn FAILS; otherwise they expire. */
export function markResuming(paneid: string, keys: string[], now = Date.now()): () => void {
  const mine = keys.filter(Boolean);
  for (const k of mine) {
    resuming.set(k, { paneid, until: now + RESUMING_MS });
  }
  return () => {
    for (const k of mine) {
      if (resuming.get(k)?.paneid === paneid) {
        resuming.delete(k);
      }
    }
  };
}

/** The pane's pty ended (its claude's End): the just-ended wait and refusal
 *  (1) are measured from here. */
export function noteEnded(paneid: string, at = Date.now()): void {
  endedAt.set(paneid, at);
}

/* ------------------------------------------------------------ check ---- */

type Eval = Verdict | { ok: 'wait'; pid: number };

function evaluate(inp: CheckInput, deps: GuardDeps, now: number, mayWait: boolean): Eval {
  const ids = inp.ids.filter(Boolean);
  const label = (p: string) => safeLabel(deps, p);
  const other = (openIn: string, pid: number | null = null, lstart: string | null = null): Refusal => ({
    ok: false,
    owner: 2,
    pid,
    openIn,
    lstart,
    message: `Pane ${label(openIn)} is running this conversation: End it first.`,
  });
  // (i) another live row banks it.
  const live = deps.liveRows();
  const holder = live.find((r) => r.paneid !== inp.paneid && r.session_id !== null && ids.includes(r.session_id));
  if (holder) {
    return other(holder.paneid);
  }
  // (ii) another pane is resuming it right now. This pane's own entry is not
  // a collider: its attaches are serialized, and /proc sees its last claude.
  for (const k of ids) {
    const r = resuming.get(k);
    if (r && r.until <= now) {
      resuming.delete(k);
    } else if (r && r.paneid !== inp.paneid) {
      return other(r.paneid);
    }
  }
  // (iii) the classifier — only where it can see the pane's processes.
  if (!inp.local) {
    return { ok: true };
  }
  const c = deps.classify({ paneid: inp.paneid, ids, phase: 'ended', recorded: null });
  if (c === null || c.collisions.length === 0) {
    return { ok: true }; // could not tell, or nothing collides
  }
  const ended = endedAt.get(inp.paneid) ?? null;
  /* S0 ride fix: a claude that carries this paneid but names ANOTHER
     conversation uuid (`pane-other`, e.g. the stopped N1 orphan on its own
     conversation) never refuses a restore — collisions are about the
     conversation, not the pane. One still EXITING after this pane's End may
     still be flushing, so the just-ended wait below waits for it. */
  const blocking = c.collisions.filter((h) => h.match !== 'pane-other');
  const exiting = (h: ProcHit): boolean =>
    (h.state === 'S' || h.state === 'R') &&
    ended !== null &&
    now - ended < JUST_ENDED_MS &&
    h.startedAt !== null &&
    h.startedAt < ended;
  const waitOn = c.collisions.filter(exiting);
  if (mayWait && waitOn.length === 1 && blocking.every((h) => h === waitOn[0])) {
    return { ok: 'wait', pid: waitOn[0].pid };
  }
  if (blocking.length === 0) {
    return { ok: true };
  }
  const liveIds = new Set(live.map((r) => r.paneid));
  const byOther = blocking.find((h) => h.paneid !== null && h.paneid !== inp.paneid && liveIds.has(h.paneid));
  if (byOther) {
    return other(byOther.paneid!, byOther.pid, byOther.lstart);
  }
  const hit: ProcHit = blocking.find((h) => h.match !== 'pane') ?? blocking[0];
  const stopped = hit.state === 'T' || hit.state === 't';
  /* Refusal (1) only for what plausibly IS this pane's previous claude on its
     way out: this paneid, started before the End, not stopped (a stopped
     process never exits on its own — "try again" would be wrong advice). */
  if (
    ended !== null &&
    now - ended < STOPPING_MS &&
    hit.paneid === inp.paneid &&
    !stopped &&
    hit.startedAt !== null &&
    hit.startedAt < ended
  ) {
    return {
      ok: false,
      owner: 1,
      pid: hit.pid,
      openIn: null,
      lstart: hit.lstart,
      message: `${label(inp.paneid)}'s previous claude (pid ${hit.pid}) is still stopping: try again in a few seconds.`,
    };
  }
  const started = hit.lstart ? `, started ${hit.lstart} UTC` : '';
  const verify = hit.lstart
    ? `check that \`TZ=UTC ps -o lstart= -p ${hit.pid}\` shows ${hit.lstart}`
    : `check with \`ps -o lstart= -p ${hit.pid}\` that it is the one you mean`;
  /* `pane`: the only evidence is the paneid — say so, never claim it runs
     THIS conversation. */
  const what =
    hit.match === 'pane'
      ? `Another claude from this pane (pid ${hit.pid}${started}${stopped ? ', stopped' : ''}) is still running and may be writing this conversation.`
      : `Another claude (pid ${hit.pid}${started}${stopped ? ', stopped' : ''}) is still running this conversation.`;
  return {
    ok: false,
    owner: 3,
    pid: hit.pid,
    openIn: null,
    lstart: hit.lstart,
    message:
      `${what} Nothing is lost by waiting. ` +
      `To stop it, ${verify}, then \`kill -CONT ${hit.pid}; kill ${hit.pid}\` (a stopped process ignores a plain kill until it is continued).`,
  };
}

/**
 * (i)-(iii) EARLY, for the launch door (§4.4 item 7: "launchRecipe runs (i)
 * and (iii) early, only so the manager shows the refusal in place"), before
 * any row is stamped. Synchronous and WITHOUT the just-ended wait: a claude
 * still exiting is the attach's to wait for, so it never refuses here. Null
 * = proceed (nothing collides, could not tell, a throw, or `warn` mode — the
 * attach logs that).
 */
export function early(inp: CheckInput, deps: GuardDeps): Refusal | null {
  try {
    if (deps.mode() === 'warn') {
      return null;
    }
    const v = evaluate(inp, deps, (deps.now ?? Date.now)(), true);
    if (v.ok === false) {
      deps.log(`spawn-guard: ${inp.paneid} - REFUSED at launch (owner ${v.owner}${v.pid !== null ? `, pid ${v.pid}` : ''}${v.openIn ? `, open in ${v.openIn}` : ''})`);
      return v;
    }
    return null;
  } catch (e) {
    deps.log(`spawn-guard: ${inp.paneid} - early check threw, proceeding: ${(e as Error).message}`);
    return null;
  }
}

function safeLabel(deps: GuardDeps, paneid: string): string {
  try {
    return deps.labelOf(paneid) || paneid;
  } catch {
    return paneid;
  }
}

/**
 * The positive checks for one restore. `onWait` is told the pid when the
 * just-ended wait starts (the pane shows "waiting for the previous claude to
 * stop (pid N)"). Never throws: a check that fails is could-not-tell →
 * proceed, logged.
 */
export async function check(inp: CheckInput, deps: GuardDeps, onWait?: (pid: number) => void): Promise<Verdict> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    const warn = deps.mode() === 'warn';
    let v = evaluate(inp, deps, now(), !warn);
    if (v.ok === 'wait') {
      const pid = v.pid;
      deps.log(`spawn-guard: ${inp.paneid} — waiting up to ${WAIT_MS} ms for the previous claude (pid ${pid}) to stop`);
      try {
        onWait?.(pid);
      } catch {
        /* a viewer that cannot be told must not stop the wait */
      }
      const deadline = now() + WAIT_MS;
      while (now() < deadline) {
        await sleep(POLL_MS);
        const c = inp.local ? deps.classify({ paneid: inp.paneid, ids: inp.ids.filter(Boolean), phase: 'ended', recorded: null }) : null;
        if (c === null || !c.collisions.some((h) => h.pid === pid)) {
          break;
        }
      }
      v = evaluate(inp, deps, now(), false); // re-check once, no second wait
    }
    if (v.ok === true || v.ok === 'wait') {
      return { ok: true };
    }
    if (warn) {
      deps.log(`spawn-guard: ${inp.paneid} — WOULD REFUSE (collisionGuard warn, proceeding): ${v.message}`);
      return { ok: true };
    }
    deps.log(`spawn-guard: ${inp.paneid} — REFUSED (owner ${v.owner}${v.pid !== null ? `, pid ${v.pid}` : ''}${v.openIn ? `, open in ${v.openIn}` : ''})`);
    return v;
  } catch (e) {
    deps.log(`spawn-guard: ${inp.paneid} — check threw, proceeding as today: ${(e as Error).message}`);
    return { ok: true };
  }
}

/** Tests only. */
export function reset(): void {
  inFlight.clear();
  resuming.clear();
  endedAt.clear();
}
