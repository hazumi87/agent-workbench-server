/* ============================================================================
 * ENGINE AS FABRIC SUBSCRIBER (Stage 3, the other half) — the engine holds one
 * socket open to the message fabric for every agent whose session it hosts.
 *
 * WHY SUBSCRIBE RATHER THAN BE PUSHED AT. The fabric brief (§3, §7) left both
 * on the table and recommended this one: "the engine subscribes for every slug
 * it hosts, so the fabric never needs to know where a pane is." That is the
 * whole argument. A pushing fabric has to learn — and keep current — which
 * engine, on which host, behind which tunnel, is holding `kiosk-cli` right
 * now; a subscribing engine already knows, because it is the thing that spawned
 * the pty. Nothing has to be told when a window moves, a session is adopted
 * after a restart, or the engine itself relocates from the VRPC to the server.
 * R8 says the same thing from the session's side: watchers are the fabric's
 * job, not each session's — so the engine subscribes ONCE, on the agent's
 * behalf, and a session that reconnects gets what it missed from the mailbox.
 *
 * `POST /api/fabric/inbound` (the Stage-3 route) is NOT replaced. It stays as
 * the push fallback and as the door any agent with a curl can use. Both doors
 * open onto the SAME delivery function (`fabric.deliver`) — see its header for
 * why that is not optional.
 *
 * A FABRIC OUTAGE IS NOT AN ENGINE OUTAGE. Every path in here is wrapped: the
 * socket may refuse, the service may be absent for weeks (it is, today), an ack
 * may 500. None of that may reach a pty. Same posture as telemetry.ts, which is
 * the module this one is shaped after, and for the same reason: an optional
 * outbound connection that can take the engine down with it is not optional.
 *
 * Config:
 *   HARBOR_WB_FABRIC_URL   base URL of the fabric (default http://127.0.0.1:8204)
 *                          '' or 'off' disables it entirely — nothing dials.
 *                          On a VRPC-local engine (plan D12) it will be off:
 *                          the fabric is a server service and the server engine is
 *                          the one that subscribes.
 * Bearer: the engine's OWN token (auth.ts / HARBOR_WB_TOKEN_FILE). The fabric
 * validates it through `GET <engine>/identity/introspect` (contract §0/§2), and
 * in `legacy`/`both` mode introspect resolves the shared bearer — so the engine
 * presents the same credential it accepts. NO THIRD CREDENTIAL (brief §3).
 * ========================================================================== */

import { WebSocket } from 'ws';
import * as fabric from './fabric.ts';
import { networkServicesRefused } from './local-guard.ts';

const RAW_URL = process.env.HARBOR_WB_FABRIC_URL;
const URL_BASE = (RAW_URL === undefined ? 'http://127.0.0.1:8204' : RAW_URL)
  .trim()
  .replace(/\/+$/, '');
/* read at call time: a local engine never dials the fabric, whatever HARBOR_WB_FABRIC_URL says (E6, local-guard.ts) */
const isEnabled = (): boolean => !networkServicesRefused() && URL_BASE !== '' && URL_BASE.toLowerCase() !== 'off';

/** The fabric's base URL and whether it is on — ONE reading of
 *  HARBOR_WB_FABRIC_URL for every outbound caller (send proxy, check-in,
 *  room threads), so they cannot disagree about where the fabric is. */
export function endpoint(): { url: string; enabled: boolean } {
  return { url: isEnabled() ? URL_BASE : '', enabled: isEnabled() };
}

/** Reconnect backoff: 1s doubling to a 30s ceiling. The fabric is a small
 *  systemd unit on the same LAN — a longer ceiling would make a restart of it
 *  cost a minute of missed push for no benefit, and a shorter one would hammer
 *  a service that is legitimately absent (it is not installed yet, so this
 *  engine will spend its first weeks retrying into nothing). */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** How long after a nudge the subscribe set is recomputed. Attach, adopt, end
 *  and rename arrive in bursts (a manager reload attaches eight panes); one
 *  `subscribe` frame for the burst beats eight identical ones. */
const REFRESH_DEBOUNCE_MS = Number(process.env.HARBOR_WB_FABRIC_DEBOUNCE_MS ?? 250);
/** Backstop sweep. Every mutation that can change the hosted set is supposed to
 *  nudge; this is what stops "supposed to" being load-bearing. A missed nudge
 *  then costs at most this much staleness instead of costing a message. */
const REFRESH_SWEEP_MS = Number(process.env.HARBOR_WB_FABRIC_SWEEP_MS ?? 30_000);

/** Envelope ids already delivered, oldest first. THE FABRIC REPLAYS THE MAILBOX
 *  ON RECONNECT — that is the durability guarantee working, not a bug — so a
 *  message already on screen arrives again every time the socket flaps. Without
 *  this the badge would grow a duplicate per reconnect.
 *
 *  GLOBAL, not per-pane, and deliberately: the fabric mints `id` and it is
 *  unique across mailboxes, so one set answers "have I shown this?" for every
 *  pane at once. A per-pane set would let the same envelope through twice if its
 *  slug resolved to a different pane between replays — which is exactly what
 *  happens when a session is killed and relaunched. */
const SEEN_MAX = 1_000;
const seen = new Set<string>();

/** Per pane: envelope ids DELIVERED but not yet acked `seen`. Bounded by the
 *  same cap fabric.ts puts on a pane's pending list — a human arriving cannot
 *  owe more acks than there were messages to see. */
const SEEN_ACK_MAX = 50;
const awaitingSeenAck = new Map<string, string[]>();

type State = 'disabled' | 'connecting' | 'connected' | 'subscribed' | 'reconnecting' | 'stopped';

let state: State = isEnabled() ? 'stopped' : 'disabled';
let ws: WebSocket | null = null;
let token = '';
let liveSlugs: (() => string[]) | null = null;
let backoffMs = BACKOFF_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

/** What we last SENT in a `subscribe` frame, and what the fabric last CONFIRMED.
 *  Kept apart on purpose: "we asked for six slugs and it accepted five" is a
 *  different fact from "we are subscribed to five", and the diag has to be able
 *  to say which. */
let requested: string[] = [];
let subscribed: string[] = [];
let rejected: Array<{ slug: string; error: string }> = [];

const counters = {
  delivered: 0,
  duplicates: 0,
  ackDelivered: 0,
  ackSeen: 0,
  ackFailures: 0,
  reconnects: 0,
};
let lastMessageAt: string | null = null;
let lastError: string | null = null;

function log(msg: string): void {
  console.log(`[engine-fabric] ${msg}`);
}

/** ONE LINE PER STATE CHANGE, never per tick. A retry loop that logs every
 *  attempt against an absent service fills the journal with the news that
 *  nothing has changed. */
function setState(next: State, detail?: string): void {
  if (state === next && !detail) {
    return;
  }
  state = next;
  log(detail ? `${next} - ${detail}` : next);
}

function wsUrl(): string {
  return `${URL_BASE.replace(/^http/, 'ws')}/subscribe`;
}

function noteSeen(id: string): boolean {
  if (seen.has(id)) {
    return false;
  }
  seen.add(id);
  if (seen.size > SEEN_MAX) {
    // Set iteration is insertion-ordered, so the first key is the oldest.
    seen.delete(seen.values().next().value as string);
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * ACK — over HTTP, never on the socket. The protocol puts it there, and the
 * consequence is worth stating: an ack survives a socket that has just dropped.
 * ------------------------------------------------------------------------- */

/**
 * `POST /ack {id, level}`.
 *
 * A BACKWARDS ACK IS REFUSED WITH 409 AND MUST NEVER BE RETRIED — the ladder
 * only climbs, and a 409 is the fabric telling us it already holds a HIGHER
 * level for this envelope. Retrying would be arguing with a service that is
 * right. Everything else is counted and logged; we do not retry those either
 * (Crawl): the fabric's mailbox is the durable record, and an engine that
 * queues its own acks is the second half-durable store the two-plane split
 * exists to keep out.
 */
async function ack(id: string, level: 'delivered' | 'seen'): Promise<void> {
  if (!isEnabled()) {
    return;
  }
  try {
    const res = await fetch(`${URL_BASE}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, level }),
    });
    if (res.status === 409) {
      // Not an error: the fabric already holds a higher level. Say so once.
      log(`ack ${level} refused 409 (already further up the ladder) - not retried`);
      return;
    }
    if (!res.ok) {
      counters.ackFailures++;
      lastError = `ack ${level} -> HTTP ${res.status}`;
      log(lastError);
      return;
    }
    if (level === 'delivered') {
      counters.ackDelivered++;
    } else {
      counters.ackSeen++;
    }
  } catch (err) {
    counters.ackFailures++;
    lastError = `ack ${level}: ${(err as Error).message}`;
  }
}

/**
 * A human just arrived on this pane — typing, or the explicit attention signal.
 *
 * ON THE TRANSITION, NEVER PER KEYSTROKE, and the list IS the transition:
 * acking empties it, so the second keystroke has nothing to send. That is the
 * same shape activity.ts's `acknowledged` flag gives the attention ack, arrived
 * at from the other direction — and it is why this can sit on the hot input path
 * without a guard of its own.
 *
 * ROOM-LINE COPIES are never on the list (onEnvelope): their recipient is the
 * agent at a room seat, and a human at the pane is not evidence about it.
 *
 * `answered` and `resolved` are NOT sent from here and must not be: they are the
 * agent's or the human's explicit act ("I replied", "this is done"), and
 * inferring them from a glance is precisely the mistake the two-level attention
 * rule exists to prevent (asks decay in loudness, never in existence).
 * TODO (Walk): a reply typed into the pane and a dismiss-as-resolved are the two
 * honest sources; wire them to `answered` / `resolved` when the pane can say so.
 */
export function onPaneAttention(paneid: string): void {
  const ids = awaitingSeenAck.get(paneid);
  if (!ids?.length) {
    return;
  }
  awaitingSeenAck.delete(paneid);
  for (const id of ids) {
    void ack(id, 'seen');
  }
}

/** The session is over — nobody is going to see what it was owed. Mirrors
 *  fabric.drop() for the pending list. */
export function dropPane(paneid: string): void {
  awaitingSeenAck.delete(paneid);
}

/* ---------------------------------------------------------------------------
 * THE SUBSCRIBE SET — every slug with a LIVE row, any vendor.
 * ------------------------------------------------------------------------- */

function computeSlugs(): string[] {
  if (!liveSlugs) {
    return [];
  }
  try {
    return [...new Set(liveSlugs())].sort();
  } catch {
    return []; // a table read must never take the socket down
  }
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function sendSubscribe(force = false): void {
  const next = computeSlugs();
  if (!force && sameSet(next, requested)) {
    return; // DE-DUPED: nothing changed, so nothing goes on the wire.
  }
  requested = next;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return; // it will be sent on the next `ready`
  }
  try {
    ws.send(JSON.stringify({ type: 'subscribe', slugs: requested }));
  } catch (err) {
    lastError = `subscribe: ${(err as Error).message}`;
  }
}

/**
 * The hosted set may have changed (attach, adopt, end, rename). Debounced.
 *
 * Callers do not have to know whether it actually changed — `sendSubscribe`
 * compares — so every mutation site can nudge unconditionally and none of them
 * carries the rule.
 */
export function refresh(): void {
  if (!isEnabled() || !started || refreshTimer) {
    return;
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    sendSubscribe();
  }, REFRESH_DEBOUNCE_MS);
  refreshTimer.unref?.();
}

/**
 * `subscribed.rejected` as the wire actually sends it: `[{slug, error}]`
 * (contract §1, frozen 2026-09-17). Normalised rather than trusted with a bare
 * cast, so a malformed or older-shape entry becomes a NAMED, findable log line
 * (`slug (error)`) instead of `undefined (undefined)` — the previous bookkeeping
 * cast `m.rejected` straight to `typeof rejected` with no shape check, which is
 * exactly the kind of silent mismatch that produced an empty name in the log.
 */
function normalizeRejected(raw: unknown): Array<{ slug: string; error: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ slug: string; error: string }> = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ slug: item, error: 'rejected' });
    } else if (item && typeof item === 'object' && typeof (item as { slug?: unknown }).slug === 'string') {
      const o = item as { slug: string; error?: unknown };
      out.push({ slug: o.slug, error: typeof o.error === 'string' ? o.error : 'rejected' });
    }
    // anything else is not a slug we can even name — dropped rather than faked
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * THE SOCKET
 * ------------------------------------------------------------------------- */

function onEnvelope(raw: unknown): void {
  const v = fabric.validate(raw);
  if (!v.ok) {
    /* The fabric is the authority on the envelope and we still check it, because
       a malformed record should be a named log line here rather than an
       exception three functions further in. Not acked: we did not deliver it. */
    lastError = `envelope rejected: ${v.field} - ${v.error}`;
    log(lastError);
    return;
  }
  const env = v.envelope;
  lastMessageAt = new Date().toISOString();
  if (!noteSeen(env.id)) {
    counters.duplicates++;
    return; // a mailbox replay of something already on screen - and NOT re-acked
  }
  const result = fabric.deliver(env);
  if (!result.ok) {
    /* Addressed to a slug we asked for and no longer host — the row ended
       between the fabric's decision and ours. Left UNACKED on purpose: the
       mailbox is durable, and the next session for that slug gets it. The id is
       forgotten too, so that replay is a first delivery rather than a duplicate. */
    lastError = `undeliverable: ${result.error}`;
    log(lastError);
    seen.delete(env.id);
    return;
  }
  counters.delivered++;
  /* A ROOM LINE's copy is NEVER acked `seen` on a human's behalf. It is
     addressed to the AGENT at the seat, and room read state reads the ladder
     back as "the agent took it in" (room-reads.ts, the design notes
     §2.7). A human typing in that pane says nothing about the agent — observed
     live: two lines to @the design system read `seen` while their typed copies were still
     held behind that very draft, never delivered. The copy's `seen` comes
     from the agent itself (fabric_ack from its own instance) or not at all. */
  if (!fabric.isRoomCopy(env)) {
    const list = awaitingSeenAck.get(result.paneid) ?? [];
    list.push(env.id);
    while (list.length > SEEN_ACK_MAX) {
      list.shift();
    }
    awaitingSeenAck.set(result.paneid, list);
  }
  if (!result.ackDeferred) {
    void ack(env.id, 'delivered'); // with channels on, channels.ts acks once the path is known
  }
}

function onFrame(raw: unknown): void {
  const m = (raw ?? {}) as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      setState('connected');
      sendSubscribe(true); // the WHOLE hosted set, every time the socket is new
      break;
    case 'subscribed': {
      subscribed = Array.isArray(m.slugs) ? (m.slugs as string[]) : [];
      rejected = normalizeRejected(m.rejected);
      /* A REJECTED SLUG NEVER DROPS THE SOCKET (protocol, frozen 2026-09-17).
         It is one agent the fabric does not know about; every other pane on this
         engine keeps its delivery. Logged so the unknown slug is findable, which
         is the whole difference from a silent drop. */
      setState(
        'subscribed',
        `${subscribed.length} slug${subscribed.length === 1 ? '' : 's'}` +
          (rejected.length
            ? ` (${rejected.length} rejected: ${rejected.map((r) => `${r.slug} (${r.error})`).join(', ')})`
            : ''),
      );
      backoffMs = BACKOFF_MIN_MS; // a working subscription resets the ladder
      break;
    }
    case 'message':
      onEnvelope(m.envelope);
      break;
    default:
      break; // an unknown frame is the fabric being newer than us; ignore it
  }
}

function scheduleReconnect(why: string): void {
  if (!started || reconnectTimer) {
    return;
  }
  counters.reconnects++;
  setState('reconnecting', `${why}; retry in ${Math.round(backoffMs / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  reconnectTimer.unref?.();
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function connect(): void {
  if (!started || ws) {
    return;
  }
  setState('connecting', wsUrl());
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl(), { headers: { authorization: `Bearer ${token}` } });
  } catch (err) {
    lastError = (err as Error).message;
    scheduleReconnect(lastError);
    return;
  }
  ws = sock;
  sock.on('message', (data) => {
    try {
      onFrame(JSON.parse(data.toString()));
    } catch {
      /* not JSON — the fabric is the only writer on this socket, so this is a
         bug on its side and dropping the frame is the safe half of it. */
    }
  });
  sock.on('error', (err) => {
    lastError = err.message;
  });
  sock.on('close', (code) => {
    if (ws !== sock) {
      return;
    }
    ws = null;
    subscribed = [];
    rejected = [];
    requested = []; // force a FULL subscribe on the next `ready`
    scheduleReconnect(`socket closed (${code}${lastError ? `: ${lastError}` : ''})`);
  });
  /* ws answers the server's ping with a pong on its own — nothing to do here,
     and hand-rolling it is how you end up sending two pongs per ping. */
}

/**
 * Wire and connect. Safe to call when the fabric is off or absent: with
 * `HARBOR_WB_FABRIC_URL` set to '' or 'off' this logs one line and never opens a
 * socket, and with the service simply not installed it retries quietly behind
 * the backoff forever.
 */
export function start(opts: { token: string; liveSlugs: () => string[] }): void {
  token = opts.token;
  liveSlugs = opts.liveSlugs;
  if (!isEnabled()) {
    log(`disabled (HARBOR_WB_FABRIC_URL=${JSON.stringify(RAW_URL ?? '')}) - no subscriber`);
    return;
  }
  if (started) {
    return;
  }
  started = true;
  log(`subscriber -> ${URL_BASE}`);
  connect();
  sweepTimer = setInterval(() => sendSubscribe(), REFRESH_SWEEP_MS);
  sweepTimer.unref?.();
}

/** Tests only (and a clean shutdown): stop dialling and let go of the socket. */
export function stop(): void {
  started = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  const sock = ws;
  ws = null;
  try {
    sock?.close();
  } catch {
    /* already gone */
  }
  setState(isEnabled() ? 'stopped' : 'disabled');
}

/**
 * GET /api/diag/fabric — the same habit as /api/diag/presence and
 * /api/diag/activity: make the engine STATE what it is doing, because "the
 * fabric is down", "we never subscribed to that slug", "it was rejected" and
 * "we delivered it and the ack failed" look identical from outside and need four
 * different fixes.
 */
export function dump(): {
  url: string;
  enabled: boolean;
  state: State;
  subscribedSlugs: string[];
  requestedSlugs: string[];
  rejected: Array<{ slug: string; error: string }>;
  lastMessageAt: string | null;
  delivered: number;
  duplicates: number;
  acked: { delivered: number; seen: number; failures: number };
  awaitingSeenAck: number;
  reconnects: number;
  lastError: string | null;
} {
  return {
    url: isEnabled() ? URL_BASE : '',
    enabled: isEnabled(),
    state,
    subscribedSlugs: subscribed,
    requestedSlugs: requested,
    rejected,
    lastMessageAt,
    delivered: counters.delivered,
    duplicates: counters.duplicates,
    acked: {
      delivered: counters.ackDelivered,
      seen: counters.ackSeen,
      failures: counters.ackFailures,
    },
    awaitingSeenAck: [...awaitingSeenAck.values()].reduce((n, l) => n + l.length, 0),
    reconnects: counters.reconnects,
    lastError,
  };
}
