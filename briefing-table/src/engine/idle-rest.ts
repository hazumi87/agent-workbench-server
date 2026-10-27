/**
 * ROOM IDLE REST (Owner 2026-10-04, item 6; KB design-notes-id
 * section 11): "Build it. Put it in global settings. Have a setting for leads."
 *
 * A seat that has been idle a long time is DEHYDRATED (the same end-for-cycle
 * the room's Disconnect uses: the conversation is kept, a Restore brings it
 * back), so resting projects stop costing residency. Everything here is PURE
 * (no db, no clock, no I/O): the sweep and the wake rules are decided from the
 * facts the caller hands in, so the policy is testable on its own. The wiring
 * (settings store, activity reads, the end verb) is src/server/rooms.ts.
 *
 * SETTINGS are SYSTEM-wide (not per person), all OFF by default so today's
 * behavior is unchanged:
 *   memberHours       dehydrate a non-lead seat after this long idle (null = never)
 *   leadHours         the same for a LEAD, but only once its whole room is idle:
 *                     the lead is the last to go (null = never)
 *   leadsWakeMembers  an active lead may wake a resting seat of its own room
 *   roomsWakeLeads    a message from another room wakes a resting lead
 *
 * NEVER RESTED: a seat that is not idle (streaming, background, waiting on the
 * user, a draft or an ask pending), a seat that is not live, or a non-persistent
 * seat. The caller reports those as `idleMs: null`.
 */

export interface IdleRestSettings {
  /** LEVEL 1 "Rest" [agent rest] (Owner 2026-10-07): park ANY idle resumable agent pane
   *  (seat or not, leads included) after restMinutes; any addressed message wakes it. */
  restEnabled: boolean;
  restMinutes: number;
  /* LEVEL 2 "Disconnect": the long level, unchanged. */
  memberHours: number | null;
  leadHours: number | null;
  leadsWakeMembers: boolean;
  roomsWakeLeads: boolean;
  /** Never rest a pane whose screen shows background work (a background shell, a
   *  sub-agent). OFF by default; see the design notes. */
  backgroundGuard: boolean;
}

export const IDLE_REST_DEFAULTS: Readonly<IdleRestSettings> = Object.freeze({
  restEnabled: false,
  restMinutes: 15,
  memberHours: null,
  leadHours: null,
  leadsWakeMembers: false,
  roomsWakeLeads: false,
  backgroundGuard: false,
});

/** The longest period accepted: a year. */
export const IDLE_REST_MAX_HOURS = 24 * 365;
const HOUR_MS = 3_600_000;

export class IdleRestError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

const HOURS_KEYS = ['memberHours', 'leadHours'] as const;
const FLAG_KEYS = ['restEnabled', 'leadsWakeMembers', 'roomsWakeLeads', 'backgroundGuard'] as const;
export const REST_MINUTES_MAX = 1440;

function validMinutes(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > REST_MINUTES_MAX) {
    throw new IdleRestError('restMinutes', `a whole number of minutes, 1 to ${REST_MINUTES_MAX}`);
  }
  return v;
}

function validHours(key: string, v: unknown): number | null {
  if (v === null) {
    return null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > IDLE_REST_MAX_HOURS) {
    throw new IdleRestError(key, `null (off) or a number of hours, 1 to ${IDLE_REST_MAX_HOURS}`);
  }
  return Math.round(v * 100) / 100;
}

/** A PATCH body, validated: only known keys, each checked. Throws IdleRestError. */
export function validIdleRestPatch(b: unknown): Partial<IdleRestSettings> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new IdleRestError('body', 'an object with restEnabled, restMinutes, memberHours, leadHours, leadsWakeMembers, roomsWakeLeads and/or backgroundGuard');
  }
  const o = b as Record<string, unknown>;
  const out: Partial<IdleRestSettings> = {};
  if (o.restMinutes !== undefined) {
    out.restMinutes = validMinutes(o.restMinutes);
  }
  for (const k of HOURS_KEYS) {
    if (o[k] !== undefined) {
      out[k] = validHours(k, o[k]);
    }
  }
  for (const k of FLAG_KEYS) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== 'boolean') {
        throw new IdleRestError(k, 'true or false');
      }
      out[k] = o[k] as boolean;
    }
  }
  const known = new Set<string>([...HOURS_KEYS, ...FLAG_KEYS, 'restMinutes']);
  const stray = Object.keys(o).find((k) => !known.has(k));
  if (stray) {
    throw new IdleRestError(stray, 'not an idle-rest setting');
  }
  if (!Object.keys(out).length) {
    throw new IdleRestError('body', 'carries no setting');
  }
  return out;
}

/** A stored value read back leniently: anything unreadable falls to the default. */
export function idleRestFrom(raw: unknown): IdleRestSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: IdleRestSettings = { ...IDLE_REST_DEFAULTS };
  for (const k of HOURS_KEYS) {
    try {
      out[k] = o[k] === undefined ? null : validHours(k, o[k]);
    } catch {
      out[k] = null;
    }
  }
  for (const k of FLAG_KEYS) {
    out[k] = o[k] === true;
  }
  try {
    out.restMinutes = o.restMinutes === undefined ? IDLE_REST_DEFAULTS.restMinutes : validMinutes(o.restMinutes);
  } catch {
    out.restMinutes = IDLE_REST_DEFAULTS.restMinutes;
  }
  return out;
}

/* ---------------------------------------------------- level 1: rest ---- */

/** What the sweep knows about one live pane [agent rest]. */
export interface RestFacts {
  /** The activity machine's state: only exactly 'idle' may rest ('background' is a
   *  pane with watchers / sub-agents / background jobs still moving its screen). */
  state: string | null;
  resumable: boolean;
  draft: boolean;
  /** Lines or envelopes waiting in the typer for this pane. */
  held: number;
  /** A question / a prompt only a human answers / a dialog inside a turn. */
  blocked: boolean;
  /** Last output, turn start or INPUT (a window typing keeps it awake), ms; null = never. */
  lastActiveAt: number | null;
  /** The `backgroundGuard` setting. Off (or absent) = background work is ignored. */
  backgroundGuard?: boolean;
  /** What the shadow screen shows: counts > 0 = work detected; zero counts = seen,
   *  nothing; null/absent = cannot tell (today's behaviour). */
  backgroundWork?: { shells: number; agents: number; other: boolean } | null;
  /** When that work was first seen in this run of it (ms), for the cap. */
  backgroundSince?: number | null;
}

/** A stuck footer must not pin a seat forever: past this the guard lets go. */
export const BACKGROUND_GUARD_CAP_MS = 6 * HOUR_MS;

/** The guard holds: detected work, guard on, and not yet past the cap. */
export function backgroundHolds(f: RestFacts, now: number): boolean {
  const b = f.backgroundWork;
  if (!f.backgroundGuard || !b || !(b.shells > 0 || b.agents > 0 || b.other)) {
    return false;
  }
  return f.backgroundSince == null || now - f.backgroundSince < BACKGROUND_GUARD_CAP_MS;
}

/** May this pane rest now (level 1)? `since` = engine boot, for a pane silent since boot. */
export function mayRest(f: RestFacts, minutes: number, now: number, since: number): boolean {
  if (f.state !== 'idle' || !f.resumable || f.draft || f.held > 0 || f.blocked) {
    return false;
  }
  if (backgroundHolds(f, now)) {
    return false;
  }
  return now - (f.lastActiveAt ?? since) >= minutes * 60_000;
}

export function restedFact(handle: string): string {
  return `@${handle} is resting (no cost); any message wakes it`;
}

/* ------------------------------------------------------------ the sweep ---- */

export interface RestSeat {
  id: string;
  handle: string;
  isLead: boolean;
  /** Live and restable now. False = nothing to rest. */
  live: boolean;
  /** How long it has been quiet (idle, no draft, no ask), or null when it is
   *  working, blocked on the user, or its idleness cannot be told. */
  idleMs: number | null;
}

export interface RestPick {
  seatId: string;
  handle: string;
  kind: 'member' | 'lead';
  idleMs: number;
  /** The limit that was met, in ms. */
  limitMs: number;
}

/**
 * Which seats of ONE room to rest now. `others` = live seats elsewhere that the
 * lead must outlast (a main room's workgroups): a lead goes only when EVERY
 * other live seat is itself idle for the lead's period, so the lead is the last
 * to go and its clock effectively starts when the rest of the room is idle.
 */
export function restPlan(seats: RestSeat[], s: IdleRestSettings, others: RestSeat[] = []): RestPick[] {
  const picks: RestPick[] = [];
  const memberMs = s.memberHours === null ? null : s.memberHours * HOUR_MS;
  const leadMs = s.leadHours === null ? null : s.leadHours * HOUR_MS;
  for (const seat of seats) {
    if (!seat.live || seat.idleMs === null) {
      continue;
    }
    if (!seat.isLead) {
      if (memberMs !== null && seat.idleMs >= memberMs) {
        picks.push({ seatId: seat.id, handle: seat.handle, kind: 'member', idleMs: seat.idleMs, limitMs: memberMs });
      }
      continue;
    }
    if (leadMs === null || seat.idleMs < leadMs) {
      continue;
    }
    const roomIdle = [...seats.filter((x) => x.id !== seat.id), ...others].every((x) => !x.live || (x.idleMs !== null && x.idleMs >= leadMs));
    if (roomIdle) {
      picks.push({ seatId: seat.id, handle: seat.handle, kind: 'lead', idleMs: seat.idleMs, limitMs: leadMs });
    }
  }
  return picks;
}

/** "24 h", "7 d": the room fact's and the log's wording. */
export function spanWords(ms: number): string {
  const h = Math.round(ms / HOUR_MS);
  return h >= 48 && h % 24 === 0 ? `${h / 24} d` : h >= 48 ? `${Math.round(h / 24)} d` : `${Math.max(h, 1)} h`;
}

export function restFact(handle: string, idleMs: number): string {
  return `@${handle} is resting (idle ${spanWords(idleMs)})`;
}

/* ------------------------------------------------------------ the wake ---- */

export interface WakeActor {
  /** null = the user. */
  seatId: string | null;
  roomId: string | null;
  /** The actor is the lead of its own room. */
  isLead: boolean;
}
export interface WakeTarget {
  roomId: string;
  isLead: boolean;
}

/**
 * May this actor's message (or `/wake`) bring a RESTING target back?
 *   a member: only its own room's active lead, with `leadsWakeMembers`;
 *   a lead:   only a seat of ANOTHER room, with `roomsWakeLeads`.
 * The user is never "woken for": the user has the Restore button and gets the
 * offline notice instead (the spec's wake chain is agents').
 */
export function mayWake(s: IdleRestSettings, actor: WakeActor, target: WakeTarget): boolean {
  if (actor.seatId === null) {
    return false;
  }
  if (!target.isLead) {
    return s.leadsWakeMembers && actor.isLead && actor.roomId === target.roomId;
  }
  return s.roomsWakeLeads && actor.roomId !== null && actor.roomId !== target.roomId;
}

/* ------------------------------------------------------- offline notices ---- */

export interface OfflineFacts {
  handle: string;
  isLead: boolean;
  /** The target's room lead, or null when the room has none. */
  leadHandle: string | null;
  leadLive: boolean;
}

/**
 * What the SENDER is told about a resting seat that this message did not wake.
 * Never typed anywhere: it rides the delivery report of the line.
 */
export function offlineNotice(f: OfflineFacts): string {
  if (f.isLead || f.leadHandle === null) {
    return `@${f.handle} is offline — ask the user to bring it back`;
  }
  if (f.leadLive) {
    return `@${f.handle} is offline — contact the room lead @${f.leadHandle}`;
  }
  return `@${f.handle} and the room lead @${f.leadHandle} are offline — contact your lead or the user`;
}
