/* ============================================================================
 * ENGINE CHECKS IN PER PANE (contract §1.3, v0.4) — the engine asks the fabric
 * WHO each of its panes is, instead of declaring it.
 *
 * Until now the engine stamped `from` on a pane's outbound send with the row's
 * `agent` slug (F1, /api/fabric/send) — honest, because only the engine can
 * say which pane is which, but still a DECLARED identity, and the fabric could
 * only warn about it. With check-in the fabric HANDS BACK an instance and a
 * work slug; a send carrying `X-Fabric-Instance` is stamped by the fabric
 * itself. That is what lets platform turn on FABRIC_REQUIRE_CHECKIN without
 * stranding every pane in the installation.
 *
 * WHAT THE ENGINE DOES, per live pane with a non-empty agent slug:
 *   POST /checkin {project: <the pane's bare slug = registry node id>,
 *                  remembered_slug?, instance_hint?, vendor, node, name}
 *   status bound|minted  -> CHECKED-IN: keep {instance, slug} in memory, and
 *                           persist both on the row as the NEXT check-in's hint
 *   status conflict      -> the copied-memory rule (§1.3 R14a.3): check in
 *                           again WITHOUT remembered_slug and mint fresh. Never
 *                           merge, never ask.
 *   status unbound       -> bind the remembered slug (POST /bind); a 409 there
 *                           is the same conflict, same answer.
 *
 * THREE OUTCOMES, NEVER TWO (CLAUDE.md cross-cutting trap):
 *   checked-in       the fabric answered with an instance and a slug
 *   refused          the fabric answered NO (4xx: not a registry node, project
 *                    not allowed, a fabric with no /checkin at all) — retried
 *                    rarely; the answer is unlikely to change on its own
 *   could-not-tell   no answer (down, timeout, 5xx, a shape we do not know) —
 *                    retried with backoff
 * Neither failure ever reaches a spawn or a send: a pane with no instance
 * sends exactly as it did before check-in existed (stamped from, F1), and the
 * route logs that it did.
 *
 * KEEPALIVE. An instance idle for 15 min expires on the fabric. Any call
 * carrying `X-Fabric-Instance` touches it — but GET /whoami does NOT (measured
 * against fabric-service src/routes.js: it never reads the header through
 * callerInstance), so the keepalive is a RE-CHECK-IN with instance_hint +
 * remembered_slug: it touches the instance when it is alive, and reclaims the
 * same slug under a new instance when it is not. One verb, self-healing.
 *
 * IN MEMORY, with one exception: the {slug, instance} pair is written to the
 * session row as a HINT, so a restarted engine offers remembered_slug and the
 * pane reclaims its work slug instead of becoming a stranger (§1.3 rule c).
 * The row value is never read for routing.
 *
 * DEPENDENCIES ARE INJECTED (same rule as fabric.ts): this module does not know
 * about the table, the resident registry or the socket layer.
 * ========================================================================== */

import * as fabricSub from './fabric-subscriber.ts';

export type Outcome = 'checked-in' | 'refused' | 'could-not-tell';

export interface PaneInfo {
  paneid: string;
  /** Registry node id — the pane's bare agent slug. */
  project: string;
  vendor: string;
  node: string;
  name: string | null;
  /** What the row remembers from a previous check-in (a restart's hint). */
  remembered: { slug: string | null; instance: string | null };
}

export interface CheckinDeps {
  /** One live pane's check-in facts, or null (not live / no slug). */
  info(paneid: string): PaneInfo | null;
  /** Every live pane that should be checked in. */
  liveInfos(): PaneInfo[];
  /** Persist the hint on the row. */
  persist(paneid: string, slug: string | null, instance: string | null): void;
  /** The set of hosted slugs may have changed (the subscriber re-subscribes). */
  onChange(): void;
  log(line: string): void;
}

interface PaneState {
  paneid: string;
  project: string;
  outcome: Outcome | 'pending';
  instance: string | null;
  slug: string | null;
  /** The fabric's own word for the last answer (bound | minted | ...). */
  status: string | null;
  since: number | null;
  lastTouch: number | null;
  nextAttempt: number;
  failures: number;
  lastError: string | null;
  inflight: Promise<void> | null;
  /** Caps the pane's process declared (the engine relay's `hello`, e.g.
   *  ["channel"] for a VRPC channel pane). Sent on every check-in; the fabric
   *  accumulates them on the instance, so a keepalive cannot drop one. */
  caps: string[];
}

const num = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return process.env[name] && Number.isFinite(v) && v > 0 ? v : dflt;
};
const REQUEST_TIMEOUT_MS = num('HARBOR_WB_FABRIC_CHECKIN_TIMEOUT_MS', 4_000);
/** Well inside the fabric's 15 min instance TTL. */
const KEEPALIVE_MS = num('HARBOR_WB_FABRIC_KEEPALIVE_MS', 5 * 60_000);
/** Backstop: picks up a live pane no hook announced, and runs keepalives. */
const SWEEP_MS = num('HARBOR_WB_FABRIC_CHECKIN_SWEEP_MS', 60_000);
const RETRY_MIN_MS = num('HARBOR_WB_FABRIC_CHECKIN_RETRY_MS', 30_000);
const RETRY_MAX_MS = 5 * 60_000;
const REFUSED_RETRY_MS = num('HARBOR_WB_FABRIC_CHECKIN_REFUSED_MS', 10 * 60_000);

/** Kill switch: HARBOR_WB_FABRIC_CHECKIN=0 = today's F1 behaviour, no check-in. */
function checkinOn(): boolean {
  return process.env.HARBOR_WB_FABRIC_CHECKIN !== '0' && fabricSub.endpoint().enabled;
}

const states = new Map<string, PaneState>();
let deps: CheckinDeps | null = null;
let token = '';
let sweepTimer: ReturnType<typeof setInterval> | null = null;
const counters = { checkins: 0, keepalives: 0, conflicts: 0, refused: 0, couldNotTell: 0, sendsWithInstance: 0, sendsStamped: 0, reCheckinsOnSend: 0 };

function log(line: string): void {
  deps?.log(`fabric-checkin: ${line}`);
}

/* ---------------------------------------------------------------------------
 * ONE HTTP CALL to the fabric, bounded, never throwing past the caller that
 * asked. The body read is inside the timeout too — a fabric that sends headers
 * and then stalls is still a fabric that did not answer.
 * ------------------------------------------------------------------------- */
export interface FabricAnswer {
  status: number;
  body: any;
}

export async function request(
  method: string,
  path: string,
  body?: unknown,
  instance?: string | null,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<FabricAnswer> {
  const { url, enabled } = fabricSub.endpoint();
  if (!enabled) {
    throw new Error('fabric-disabled');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(instance ? { 'x-fabric-instance': instance } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ac.signal,
    });
    const j = await res.json().catch(() => null);
    return { status: res.status, body: j };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------------
 * CHECK-IN
 * ------------------------------------------------------------------------- */

function stateFor(info: PaneInfo): PaneState {
  let st = states.get(info.paneid);
  if (!st || st.project !== info.project) {
    /* A renamed slug is a different project: nothing about the old identity
       carries over, including the row's hint (it named the old project). */
    const carry = st ? { slug: null, instance: null } : info.remembered;
    st = {
      paneid: info.paneid,
      project: info.project,
      outcome: 'pending',
      instance: carry.instance,
      slug: carry.slug,
      status: null,
      since: null,
      lastTouch: null,
      nextAttempt: 0,
      failures: 0,
      lastError: null,
      inflight: null,
      caps: st?.caps ?? [],
    };
    states.set(info.paneid, st);
  }
  return st;
}

function fail(st: PaneState, outcome: 'refused' | 'could-not-tell', why: string, keepInstance: boolean): void {
  const changed = st.outcome !== outcome || st.lastError !== why;
  st.lastError = why;
  st.failures++;
  if (outcome === 'refused') {
    counters.refused++;
    st.outcome = 'refused';
    st.nextAttempt = Date.now() + REFUSED_RETRY_MS;
  } else {
    counters.couldNotTell++;
    st.nextAttempt = Date.now() + Math.min(RETRY_MIN_MS * 2 ** Math.min(st.failures - 1, 6), RETRY_MAX_MS);
    /* A keepalive that could not reach the fabric does not un-check the pane:
       the instance may well still be alive there, and the send path re-checks
       in on the fabric's own 409 if it is not. */
    if (!keepInstance) {
      st.outcome = 'could-not-tell';
    }
  }
  if (outcome === 'refused') {
    st.instance = null; // a refused pane holds no instance worth presenting
  }
  if (changed) {
    log(`${st.paneid} ${st.project}: ${outcome} — ${why}`);
  }
}

function succeed(st: PaneState, instance: string, slug: string, status: string): void {
  const changed = st.instance !== instance || st.slug !== slug || st.outcome !== 'checked-in';
  st.outcome = 'checked-in';
  st.instance = instance;
  st.slug = slug;
  st.status = status;
  st.lastTouch = Date.now();
  st.failures = 0;
  st.lastError = null;
  st.nextAttempt = 0;
  if (changed) {
    st.since = Date.now();
    log(`${st.paneid} ${st.project}: checked-in ${status} ${slug} (${instance})`);
    try {
      deps?.persist(st.paneid, slug, instance);
    } catch (e) {
      log(`persist failed for ${st.paneid}: ${(e as Error).message}`);
    }
    try {
      deps?.onChange();
    } catch {
      /* a subscriber nudge must never fail a check-in */
    }
  }
}

async function run(st: PaneState, info: PaneInfo, keepalive: boolean): Promise<void> {
  const post = (remembered: string | null, hint: string | null) =>
    request('POST', '/checkin', {
      project: info.project,
      /* paneid makes the pane's instance the one a pane-mode fabric-mcp JOINS
         (fabric 5cf83e3: the pane identity belongs to the engine). Sent on
         keepalives too — it re-asserts the pane. */
      paneid: info.paneid,
      vendor: info.vendor,
      node: info.node,
      ...(info.name ? { name: info.name } : {}),
      ...(st.caps.length ? { caps: st.caps } : {}),
      ...(remembered ? { remembered_slug: remembered } : {}),
      ...(hint ? { instance_hint: hint } : {}),
    });
  try {
    if (keepalive) {
      counters.keepalives++;
    } else {
      counters.checkins++;
    }
    let r = await post(st.slug, st.instance);
    for (let round = 0; round < 2; round++) {
      if (r.status >= 500) {
        fail(st, 'could-not-tell', `HTTP ${r.status}${r.body?.error ? ` ${r.body.error}` : ''}`, keepalive);
        return;
      }
      if (r.status >= 400) {
        fail(st, 'refused', `HTTP ${r.status} ${r.body?.error ?? ''}`.trim(), false);
        return;
      }
      const j = r.body ?? {};
      if ((j.status === 'bound' || j.status === 'minted') && typeof j.instance === 'string' && typeof j.slug === 'string') {
        succeed(st, j.instance, j.slug, j.status);
        return;
      }
      if (j.status === 'unbound' && typeof j.instance === 'string' && st.slug) {
        const b = await request('POST', '/bind', { instance: j.instance, slug: st.slug });
        if (b.status === 200 && b.body?.slug) {
          succeed(st, j.instance, b.body.slug, 'bound');
          return;
        }
        /* 409 held / wrong-project: same answer as a conflict (below). */
      } else if (j.status !== 'conflict' || typeof j.instance !== 'string') {
        fail(st, 'could-not-tell', `unexpected check-in answer ${JSON.stringify(j.status ?? null)}`, keepalive);
        return;
      }
      /* CONFLICT (or a lost bind): another LIVE instance holds the remembered
         slug. The copied-memory rule — the newcomer mints fresh, never merges.
         The instance just issued is offered as the hint so it is reused, not
         leaked for 15 minutes. */
      counters.conflicts++;
      log(`${st.paneid} ${st.project}: remembered ${st.slug} is held by ${j.holder?.instance ?? 'another instance'} — minting fresh`);
      st.slug = null;
      r = await post(null, typeof j.instance === 'string' ? j.instance : null);
    }
    fail(st, 'could-not-tell', 'conflict did not settle', keepalive);
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message;
    fail(st, 'could-not-tell', msg, keepalive);
  }
}

/**
 * Make sure a pane is checked in (spawn, adopt, reclaim — any presence hook
 * may call this; it de-dupes). Never throws; resolves when the attempt, if
 * any, is over.
 */
export function ensure(paneid: string): Promise<void> {
  if (!deps || !checkinOn()) {
    return Promise.resolve();
  }
  let info: PaneInfo | null;
  try {
    info = deps.info(paneid);
  } catch {
    return Promise.resolve();
  }
  if (!info) {
    return Promise.resolve();
  }
  const st = stateFor(info);
  if (st.inflight) {
    return st.inflight;
  }
  if (st.outcome === 'checked-in' || Date.now() < st.nextAttempt) {
    return Promise.resolve();
  }
  return start1(st, info, false);
}

/**
 * The engine relay (fabric-relay.ts): the pane's process said what it can do
 * (`hello {caps}`), so check the pane in AGAIN carrying those caps — the
 * fabric only reports a pane's channel live when its instance declared
 * `channel`. Idempotent; waits out an in-flight attempt first. Never throws.
 * Caps outlive the call (they ride every later keepalive) until the pane is
 * dropped.
 */
export async function declareCaps(paneid: string, caps: string[]): Promise<void> {
  if (!deps || !checkinOn()) {
    return;
  }
  let info: PaneInfo | null;
  try {
    info = deps.info(paneid);
  } catch {
    return;
  }
  if (!info) {
    return;
  }
  const st = stateFor(info);
  const clean = caps.filter((c) => typeof c === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(c));
  const merged = [...new Set([...st.caps, ...clean])].slice(0, 8);
  const grew = merged.length !== st.caps.length;
  st.caps = merged;
  if (st.inflight) {
    await st.inflight;
  }
  if (!grew && st.outcome === 'checked-in') {
    return; // the instance already carries every cap asked for
  }
  if (st.outcome !== 'checked-in') {
    st.nextAttempt = 0; // a relay asking is a reason to try now
  }
  await start1(st, info, st.outcome === 'checked-in');
}

function start1(st: PaneState, info: PaneInfo, keepalive: boolean): Promise<void> {
  st.inflight = run(st, info, keepalive).finally(() => {
    st.inflight = null;
  });
  return st.inflight;
}

/** The sweep: new panes, retries that are due, keepalives, and forgetting
 *  panes that are no longer live. */
function tick(): void {
  if (!deps || !checkinOn()) {
    return;
  }
  let live: PaneInfo[];
  try {
    live = deps.liveInfos();
  } catch {
    return;
  }
  const seen = new Set<string>();
  const now = Date.now();
  for (const info of live) {
    seen.add(info.paneid);
    const st = stateFor(info);
    if (st.inflight) {
      continue;
    }
    if (st.outcome === 'checked-in') {
      if (now - (st.lastTouch ?? 0) >= KEEPALIVE_MS && now >= st.nextAttempt) {
        void start1(st, info, true);
      }
    } else if (now >= st.nextAttempt) {
      void start1(st, info, false);
    }
  }
  for (const paneid of [...states.keys()]) {
    if (!seen.has(paneid)) {
      drop(paneid);
    }
  }
}

/** The pane ended: forget the instance (it expires on the fabric by itself).
 *  The row keeps its hint, so a relaunch of the same pane reclaims the slug. */
export function drop(paneid: string): void {
  if (states.delete(paneid)) {
    try {
      deps?.onChange();
    } catch {
      /* never fatal */
    }
  }
}

/* ---------------------------------------------------------------------------
 * READS for the rest of the engine
 * ------------------------------------------------------------------------- */

/** The pane's checked-in {instance, slug}, or null. */
export function identityOf(paneid: string | null | undefined): { instance: string; slug: string } | null {
  const st = paneid ? states.get(paneid) : undefined;
  return st && st.outcome === 'checked-in' && st.instance && st.slug ? { instance: st.instance, slug: st.slug } : null;
}

/** The pane's project (its bare slug, the registry node id) as last checked
 *  in, or null. The relay subscribes [work slug, project]. */
export function projectOf(paneid: string): string | null {
  return states.get(paneid)?.project ?? null;
}

/** Which pane holds a minted work slug (fabric.deliver resolves `to` by it). */
export function paneForSlug(slug: string): string | null {
  for (const st of states.values()) {
    if (st.outcome === 'checked-in' && st.slug === slug) {
      return st.paneid;
    }
  }
  return null;
}

/** Every minted slug this engine holds — added to the subscribe set, so a
 *  reply addressed to the work slug the fabric stamped reaches the pane. */
export function slugs(): string[] {
  return [...states.values()].filter((s) => s.outcome === 'checked-in' && s.slug).map((s) => s.slug as string);
}

/* ---------------------------------------------------------------------------
 * SEND AS A PANE — the one outbound send path (/api/fabric/send, room fan-out)
 * ------------------------------------------------------------------------- */

export interface SendResult extends FabricAnswer {
  via: 'instance' | 'stamped';
}

/**
 * POST /send on behalf of `paneid` (null = the engine's own stamp, e.g. a
 * user-authored room line). With a checked-in instance the header goes out and
 * the fabric stamps `from`; without one, `envelope.from` (the engine's stamp)
 * stands — today's F1 behaviour. Throws only on network error / timeout / a
 * disabled fabric, which the caller maps (502 / 503).
 *
 * A 409 instance-expired / not-bound means the fabric forgot us (idle past the
 * TTL, or restarted): re-check-in once and retry once.
 */
export async function sendAs(paneid: string | null, envelope: Record<string, unknown>): Promise<SendResult> {
  if (paneid && !identityOf(paneid)) {
    await ensure(paneid); // lazy: a pane no hook announced yet
  }
  let id = identityOf(paneid);
  let r = await request('POST', '/send', envelope, id?.instance ?? null, 5_000);
  if (id && r.status === 409 && ['instance-expired', 'not-bound', 'unknown-instance'].includes(r.body?.error)) {
    counters.reCheckinsOnSend++;
    const st = states.get(paneid as string);
    if (st) {
      st.outcome = 'could-not-tell';
      st.lastError = `send: ${r.body.error}`;
      st.nextAttempt = 0;
    }
    await ensure(paneid as string);
    id = identityOf(paneid);
    r = await request('POST', '/send', envelope, id?.instance ?? null, 5_000);
  }
  if (id) {
    counters.sendsWithInstance++;
    const st = states.get(paneid as string);
    if (st && r.status < 400) {
      st.lastTouch = Date.now(); // any call with the header touches the instance
    }
  } else {
    counters.sendsStamped++;
  }
  return { ...r, via: id ? 'instance' : 'stamped' };
}

/* ---------------------------------------------------------------------------
 * LIFECYCLE + DIAG
 * ------------------------------------------------------------------------- */

export function start(opts: { token: string; deps: CheckinDeps }): void {
  token = opts.token;
  deps = opts.deps;
  if (!fabricSub.endpoint().enabled) {
    return;
  }
  if (process.env.HARBOR_WB_FABRIC_CHECKIN === '0') {
    deps.log('fabric-checkin: off (HARBOR_WB_FABRIC_CHECKIN=0) — sends stay stamped-from (F1)');
    return;
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      try {
        tick();
      } catch (e) {
        log(`sweep threw: ${(e as Error).message}`); // a throw in a timer is engine-fatal
      }
    }, SWEEP_MS);
    sweepTimer.unref?.();
    setTimeout(() => {
      try {
        tick();
      } catch {
        /* same */
      }
    }, 0).unref?.();
  }
}

export function stop(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Per-pane state for GET /api/diag/fabric. Instance ids and slugs are not
 *  secrets (they are what the fabric prints in its own presence list). */
export function dump(): Record<string, unknown> {
  const panes: Record<string, unknown> = {};
  for (const st of states.values()) {
    panes[st.paneid] = {
      project: st.project,
      outcome: st.outcome,
      status: st.status,
      slug: st.slug,
      instance: st.instance,
      since: st.since ? new Date(st.since).toISOString() : null,
      lastTouch: st.lastTouch ? new Date(st.lastTouch).toISOString() : null,
      nextAttemptInMs: st.outcome === 'checked-in' ? null : Math.max(0, st.nextAttempt - Date.now()),
      lastError: st.lastError,
      ...(st.caps.length ? { caps: st.caps } : {}),
    };
  }
  return {
    enabled: checkinOn(),
    keepaliveMs: KEEPALIVE_MS,
    panes,
    counters: { ...counters },
  };
}

/** Tests only. */
export function reset(): void {
  states.clear();
  for (const k of Object.keys(counters) as (keyof typeof counters)[]) {
    counters[k] = 0;
  }
}
