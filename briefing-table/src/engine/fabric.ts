/* ============================================================================
 * INBOUND ENVELOPE (Stage 3, engine half) — the engine's three ad-hoc sinks
 * collapse to ONE route.
 *
 * The engine has grown a sink per signal: /api/claude-hook (attention),
 * /api/url-offer (a link), /api/handoff (labelled values). Each is a different
 * shape, a different correlation trick and a different failure mode, and two of
 * them silently 401'd for weeks at a time because nothing shared a contract.
 * Stage 3's answer is one envelope (contract §2) on one route.
 *
 * WHAT THIS IS NOT. It is not the fabric. The fabric is a durable, addressed,
 * acknowledged service on the server with a mailbox per agent (plan §1b / E2), and
 * it does not exist yet. This is the engine's INBOX: the fabric (or any agent,
 * today) hands the engine an envelope addressed to a slug, and the engine's job
 * is to put it in front of the human sitting in that agent's window. Nothing
 * here is durable — see the queue rules below — because durability belongs to
 * the service that has it, and a second half-durable store is how two systems
 * end up disagreeing about what was delivered.
 *
 * ATTENTION IS READ, NEVER ASSIGNED (contract §2, E11). The sender declares
 * `class`, `consequence` and `deadline`; the ROUTER assigns `attention`. This
 * engine is not the router, so it takes the field as given and uses it for
 * exactly one thing: how loud the badge looks. It never escalates, never
 * repeats, never seizes an input box, and never deletes a message for being old
 * — the ladder rules in the design notes are NOT implemented here,
 * and the point of listing them is that nothing here may violate them.
 * ========================================================================== */

import { normalizeSlug } from './agent-slug.ts';
import * as roomTyper from './room-typer.ts';
import * as channels from './channels.ts';
import * as held from './fabric-held.ts';

export const KINDS = ['msg', 'ask', 'result', 'notice', 'effect', 'state'] as const;
export const CLASSES = [
  'info',
  'task-complete',
  'attention-needed',
  'outage',
  'maintenance-window',
  'kill-switch',
  'coordination',
] as const;
export const ATTENTIONS = ['ambient', 'notice', 'ask', 'interrupt'] as const;
export const ACKS = ['none', 'delivered', 'seen', 'answered', 'resolved', 'demoted'] as const;
/** How the fabric got this envelope to a session that was NOT live (ticket,
 *  Owner 2026-09-30): the sender chose to leave it (`hold`) or to bring the
 *  agent back for it (`restore`). Absent = sent to a live session. */
export const DELIVERIES = ['hold', 'restore'] as const;

/** A ROOM LINE's fabric copy (F4, room-fabric.ts: ref `room:<id>/line:<n>`).
 *  The room door already delivered and typed the line; the copy exists for the
 *  durable record and for the ack ladder room read state reads back — so only
 *  the RECIPIENT AGENT may move it to `seen` (fabric-subscriber.ts). */
export function isRoomCopy(env: { ref?: string | null }): boolean {
  return typeof env.ref === 'string' && env.ref.startsWith('room:');
}

/** An envelope whose ack is already past `none` has been delivered before. */
export function isReplayed(env: { ack?: string | null }): boolean {
  return typeof env.ack === 'string' && env.ack !== '' && env.ack !== 'none';
}

export interface Envelope {
  id: string;
  ts: string;
  from: string;
  to: string;
  kind: (typeof KINDS)[number];
  class: (typeof CLASSES)[number];
  attention: (typeof ATTENTIONS)[number];
  thread: string;
  body?: string;
  ref?: string;
  deadline?: string;
  consequence?: string;
  ack: (typeof ACKS)[number];
  /** Present only on an envelope the fabric held or restored for (DELIVERIES). */
  delivery?: (typeof DELIVERIES)[number];
  /** R5: on whose authority the receiver may act. Only `user` changes anything
   *  here: it passes a quiet recipient [chatter]. */
  authorised_by?: 'user' | 'pair' | 'none';
}

export type Validation =
  | { ok: true; envelope: Envelope }
  | { ok: false; field: string; error: string };

/** Short identifiers. Long enough for a uuid plus a prefix, short enough that a
 *  badge and a log line stay readable. */
const ID_MAX = 120;
/** `body` is SHORT TEXT OR A POINTER, never bulk bytes (contract §2). The cap
 *  enforces the contract rather than describing it: anything bigger is a KB doc
 *  or an agent-share URL, and `ref` is the field for saying so. */
const BODY_MAX = 4000;

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') {
    return null;
  }
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

/**
 * Check one inbound envelope. On failure it names THE FIELD, because a 400 that
 * says "invalid envelope" is a 400 the sender has to guess about — and the
 * senders here are other agents' adapters, written against a draft contract by
 * people who cannot read our logs.
 */
export function validate(raw: unknown): Validation {
  const b = (raw ?? {}) as Record<string, unknown>;
  const bad = (field: string, error: string): Validation => ({ ok: false, field, error });

  for (const f of ['id', 'ts', 'from', 'to', 'thread'] as const) {
    if (!str(b[f], ID_MAX)) {
      return bad(f, f + ' is required (non-empty string, <= ' + ID_MAX + ' chars)');
    }
  }
  if (!KINDS.includes(b.kind as never)) {
    return bad('kind', 'kind must be one of ' + KINDS.join('|'));
  }
  if (!CLASSES.includes(b.class as never)) {
    return bad('class', 'class must be one of ' + CLASSES.join('|'));
  }
  if (!ATTENTIONS.includes(b.attention as never)) {
    return bad(
      'attention',
      'attention must be one of ' + ATTENTIONS.join('|') + ' (assigned by the router, not the sender)',
    );
  }
  if (!ACKS.includes(b.ack as never)) {
    return bad('ack', 'ack must be one of ' + ACKS.join('|'));
  }
  const body = str(b.body, BODY_MAX);
  const ref = str(b.ref, ID_MAX * 8);
  if (!body && !ref) {
    /* ONE FIELD NAMED, not "one of these two" — the sender almost always meant
       body, and `ref` is the escape hatch for something too big to carry. */
    return bad('body', 'body or ref is required (body <= ' + BODY_MAX + ' chars; use ref for a pointer)');
  }
  const deadline = str(b.deadline, ID_MAX);
  const consequence = str(b.consequence, BODY_MAX);
  /* `delivery` is the FABRIC's fact, not the sender's, so an unknown value is
     dropped rather than refused: refusing would lose the message over a field
     that only chooses a preamble, and a newer fabric may know more values. */
  const delivery = DELIVERIES.includes(b.delivery as never) ? (b.delivery as Envelope['delivery']) : undefined;
  /* Same rule as `delivery`: the fabric's field, an unknown value dropped. */
  const authorisedBy = ['user', 'pair', 'none'].includes(b.authorised_by as string) ? (b.authorised_by as Envelope['authorised_by']) : undefined;
  return {
    ok: true,
    envelope: {
      id: str(b.id, ID_MAX)!,
      ts: str(b.ts, ID_MAX)!,
      from: str(b.from, ID_MAX)!,
      to: str(b.to, ID_MAX)!,
      kind: b.kind as Envelope['kind'],
      class: b.class as Envelope['class'],
      attention: b.attention as Envelope['attention'],
      thread: str(b.thread, ID_MAX)!,
      ...(body ? { body } : {}),
      ...(ref ? { ref } : {}),
      ...(deadline ? { deadline } : {}),
      ...(consequence ? { consequence } : {}),
      ack: b.ack as Envelope['ack'],
      ...(delivery ? { delivery } : {}),
      ...(authorisedBy ? { authorised_by: authorisedBy } : {}),
    },
  };
}

/* ---------------------------------------------------------------------------
 * PENDING MESSAGES — in memory, per pane, and every one of those words is a
 * rule lifted from /api/handoff.
 *
 * Never the table: an envelope can carry anything an agent chose to say, and a
 * store that survives the process is a store somebody will eventually put a
 * credential in. Never logged beyond COUNTS, same reason. Dropped on exit,
 * because the engine is not the fabric and a message it loses is one the fabric
 * still holds.
 * ------------------------------------------------------------------------- */
const QUEUE_MAX = 50;
const QUEUE_TTL_MS = Number(process.env.HARBOR_WB_FABRIC_TTL_MS ?? 60 * 60 * 1000);

interface Pending {
  envelope: Envelope;
  at: number;
}
const pending = new Map<string, Pending[]>();

/** What is still live for a pane, oldest first. Drops anything past the TTL. */
export function pendingFor(paneid: string): Envelope[] {
  const list = (pending.get(paneid) ?? []).filter((p) => Date.now() - p.at < QUEUE_TTL_MS);
  if (list.length) {
    pending.set(paneid, list);
  } else {
    pending.delete(paneid);
  }
  return list.map((p) => p.envelope);
}

/** Add one envelope to a pane's list, capped oldest-out. Returns the new list. */
export function push(paneid: string, envelope: Envelope): Envelope[] {
  const list = (pending.get(paneid) ?? []).filter((p) => Date.now() - p.at < QUEUE_TTL_MS);
  list.push({ envelope, at: Date.now() });
  while (list.length > QUEUE_MAX) {
    list.shift();
  }
  pending.set(paneid, list);
  return list.map((p) => p.envelope);
}

/** Remove one envelope by id (or all of them, with no id). Returns what is left. */
export function dismiss(paneid: string, id?: string): Envelope[] {
  if (!id) {
    pending.delete(paneid);
    return [];
  }
  const list = (pending.get(paneid) ?? []).filter((p) => p.envelope.id !== id);
  if (list.length) {
    pending.set(paneid, list);
  } else {
    pending.delete(paneid);
  }
  return list.map((p) => p.envelope);
}

/** The session ended — its messages go with it (same rule as handoff secrets). */
export function drop(paneid: string): void {
  pending.delete(paneid);
  held.drop(paneid); // ...and any held/restore batch still gathering
}

/** Tests only. */
export function reset(): void {
  pending.clear();
}

/* ---------------------------------------------------------------------------
 * DELIVERY — ONE PATH, TWO DOORS.
 *
 * An envelope reaches this engine two ways now: the fabric PUSHES it at
 * `POST /api/fabric/inbound` (the original Stage-3 route, kept as the fallback
 * and as what the tests drive), or the engine PULLS it off the fabric's
 * `/subscribe` socket (fabric-subscriber.ts, the normal path once the service
 * is installed). Both must resolve the slug the same way, queue the same way,
 * flush the same way and log the same way — so neither of them owns that
 * knowledge. It lives here and they both call it.
 *
 * The alternative — the subscriber re-implementing what the route already does
 * — is how the engine ended up with three ad-hoc sinks in the first place, and
 * the header of this file is the record of what that cost.
 *
 * DEPENDENCIES ARE INJECTED, not imported: this module must not know about the
 * mapping table, the resident registry or the websocket layer. Wired once in
 * src/server/index.ts.
 * ------------------------------------------------------------------------- */

export interface DeliveryDeps {
  /** The paneid of the LIVE session a slug means, or null. A minted work slug names one pane; a bare slug
   *  shared by several live panes resolves to the recipe's primary pane when there is exactly one, else
   *  to null and `ambiguousFor` says so (src/engine/slug-route.ts). */
  livePaneFor(slug: string): string | null;
  /** The minted slugs (or paneids) of the live panes a bare slug is AMBIGUOUS between, or null. Checked
   *  before `livePaneFor`: the delivery is refused, naming them, instead of picking one silently. */
  ambiguousFor?(slug: string): string[] | null;
  /** Push the whole pending list to every viewer of a pane. Returns how many
   *  viewers got it — 0 means the message is queued, not delivered. */
  toViewers(paneid: string, messages: Envelope[]): number;
  /** When the pane's CURRENT process went live (the row's `started_at`), or
   *  null when unknown. An envelope older than this was sent while the agent
   *  was not live and is typed under the hold preamble (fabric-held.ts). */
  startedAt?(paneid: string): number | null;
  /** CHATTER [chatter]: the quiet slug covering this recipient, or null. */
  quietFor?(to: string, paneid: string): string | null;
  /** CHATTER: record one routed DM or one quiet refusal (slugs and ids only). */
  noteChatter?(kind: 'fabric_dm' | 'quiet_refused', paneid: string, slug: string, env: Envelope): void;
  log(line: string): void;
}

export type DeliveryResult =
  | {
      ok: true;
      paneid: string;
      delivered: boolean;
      queued: boolean;
      pending: number;
      /** HARBOR_WB_CHANNELS on: channels.ts acks `delivered` once the path is
       *  known (typed now, or the channel's transcript enqueue); the caller
       *  must not ack it again. */
      ackDeferred?: boolean;
    }
  | { ok: false; error: string };

let deps: DeliveryDeps | null = null;

export function setDeliveryDeps(d: DeliveryDeps | null): void {
  deps = d;
}

/**
 * Put one validated envelope in front of the human sitting in that agent's
 * window, or say why it could not be.
 *
 * `to` is normalised then matched against a LIVE session. `@group:` / `@all` /
 * `user` are the FABRIC's to route and are refused here saying so — a 404 that
 * names the reason is how the adapter author finds out this half is not the
 * router. Both failure shapes are a 404 to an HTTP caller: "we know who you
 * mean and nobody is there" and "we have never heard of them" are the same
 * answer to a sender, and a silent 200 is exactly how offer-url went unnoticed
 * for weeks (2026-09-04).
 */
export function deliver(env: Envelope): DeliveryResult {
  if (!deps) {
    return { ok: false, error: 'delivery is not wired' };
  }
  const to = normalizeSlug(env.to);
  if (!to) {
    return {
      ok: false,
      error:
        'to must be an agent slug; @group / @all / user are routed by the fabric service, not the engine',
    };
  }
  const amb = deps.ambiguousFor?.(to);
  if (amb && amb.length > 1) {
    return { ok: false, error: `ambiguous: '${to}' is the address of ${amb.length} live sessions; send to one of: ${amb.join(', ')}` };
  }
  const paneid = deps.livePaneFor(to);
  if (!paneid) {
    return { ok: false, error: `no live session for agent '${to}'` };
  }
  /* F4: a ROOM LINE's fabric copy (ref `room:<id>/line:<n>`, room-fabric.ts).
     The room door (rooms.ts deliverToSeat) already put that line in front of
     the seat's pane AND typed it; typing or badging the copy again would say
     everything twice. It is still a delivery — the subscriber acks it, so the
     fabric's ack ladder (which room read state reads back) climbs. */
  if (isRoomCopy(env)) {
    deps.log(`fabric → ${to} (${paneid}): room copy ${env.ref} from ${env.from} — already delivered by the room door; not typed, not re-badged`);
    return { ok: true, paneid, delivered: true, queued: false, pending: pendingFor(paneid).length };
  }
  const list = push(paneid, env);
  const viewers = deps.toViewers(paneid, list);
  /* HELD / RESTORED MAIL (ticket): the fabric's `delivery`, or an envelope
     sent before this pane's current process went live, is typed under a
     preamble, batched with its siblings (fabric-held.ts). Never fatal. */
  let late: ReturnType<typeof held.effectiveDelivery> = null;
  try {
    late = held.effectiveDelivery(env, deps.startedAt?.(paneid) ?? null);
  } catch {
    late = null;
  }
  /* W3-interim: the AGENT hears it too, typed like a room line when the pane
     is idle with no draft (room-typer.ts guards). Never fatal to delivery. */
  let typed = 'n/a';
  /* QUIET [chatter]: the person holds this agent. The send door (index.ts
     fabricSendAs) already refuses an engine pane's DM to it; this catches one
     that reached the fabric another way. It stays on the badge for the person
     and is not typed. The person's own word, or one sent on their authority,
     still passes. */
  let quiet: string | null = null;
  try {
    quiet = isReplayed(env) || env.from === 'user' ? null : (deps.quietFor?.(to, paneid) ?? null);
    /* NEVER RE-TYPE A REPLAY. After an engine restart the in-memory de-dupe is
       empty and the fabric replays everything not yet `seen` (its durability
       guarantee) — an envelope already acked `delivered` or higher was typed
       before, so it goes to the badge only (live duplicate PONG, 2026-09-25). */
    if (isReplayed(env)) {
      typed = 'replay';
    } else if (quiet) {
      typed = 'quiet';
      deps.noteChatter?.('quiet_refused', paneid, quiet, env);
    } else {
      /* Channel-first when HARBOR_WB_CHANNELS=1 (channels.ts); off = this exact call. */
      typed = channels.routeFabric(paneid, env, () =>
        late
          ? held.add(paneid, late.delivery, env)
          : roomTyper.enqueueFabric(paneid, env as unknown as Record<string, string>),
      );
      /* A turn the agent will spend: typed or queued to type, or handed to its channel. */
      if (typed !== 'off' && typed !== 'vendor') {
        deps.noteChatter?.('fabric_dm', paneid, to, env);
      }
    }
  } catch (e) {
    typed = 'error';
    deps.log(`fabric type failed for ${paneid}: ${(e as Error).message}`);
  }
  /* COUNTS, NEVER CONTENT — the /api/handoff rule, and an envelope body is no
     more ours to log than a password is. `kind`/`class`/`from` are the routing
     facts and are exactly what a pulse would carry (§6). */
  deps.log(
    `fabric → ${to} (${paneid}): ${env.kind}/${env.class} from ${env.from} ` +
      `[${env.attention}] ${viewers > 0 ? 'delivered' : 'queued'} (pending ${list.length}) typed=${typed}` +
      (late ? ` delivery=${late.delivery}${late.inferred ? '(inferred)' : ''}` : ''),
  );
  return {
    ok: true,
    paneid,
    delivered: viewers > 0,
    /* QUEUED means NOBODY HAS SEEN IT YET. The pending list holds every message
       either way (so a reload re-arms the badge), so reporting "queued" for a
       delivered message would make the field say nothing. */
    queued: viewers === 0,
    pending: list.length,
    ...(channels.enabled() && !quiet ? { ackDeferred: true } : {}),
  };
}

/**
 * Put one envelope in front of the human in ONE PANE, named by paneid — the
 * workroom door (the design notes §2.5) [ticket].
 *
 * NO SLUG RESOLUTION, on purpose. A room seat knows its occupant by PANEID, and
 * two seats can hold two panes that share one agent slug (two sessions of one
 * project). `deliver()` resolves `to` through `livePaneFor(slug)`, which takes
 * the most recently touched live pane — so a room message routed through it
 * would land in the wrong window whenever that happens. The caller (the rooms
 * route) has already decided which pane; this only queues and flushes.
 *
 * The caller is also responsible for having checked the pane is LIVE: this
 * never spawns and never looks at the table. Same queue, same flush, same
 * counts-never-content log as `deliver()`.
 */
export function deliverToPane(paneid: string, env: Envelope): DeliveryResult {
  if (!deps) {
    return { ok: false, error: 'delivery is not wired' };
  }
  const list = push(paneid, env);
  const viewers = deps.toViewers(paneid, list);
  deps.log(
    `room → @${env.to} (${paneid}): ${env.kind}/${env.class} from ${env.from} ` +
      `${viewers > 0 ? 'delivered' : 'queued'} (pending ${list.length})`,
  );
  return { ok: true, paneid, delivered: viewers > 0, queued: viewers === 0, pending: list.length };
}
