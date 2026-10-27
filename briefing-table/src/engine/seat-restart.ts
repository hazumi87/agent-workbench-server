/**
 * LEAD RESTART OF A SEAT (Owner [ref], [ref]; design [ref]): when seats are killed (the server's memory kill took every
 * Codex seat at once) the room lead can bring them back, without the person starting each one. PURE: no db, no clock, no
 * I/O. The caller hands in the facts (who asks, the seat's state, when it was last restarted, how much memory is free) and
 * gets a yes or a refusal with words. The wiring (the command, the launch, the queue) is src/server/rooms.ts.
 *
 * The rules, each one a sentence a person can read in a refusal:
 *   - the person may always; the room LEAD may restart a member of its own room while `leadsRestartMembers` is on (the
 *     default; the person can turn it off); a plain member never; only the person restarts the lead;
 *   - only a seat that is NOT live: a live seat is working, restarting it would destroy that (a forced restart is a later
 *     step);
 *   - the lead is held to one restart per seat per 10 minutes (the person is not: they act on purpose);
 *   - not while the machine is short of memory: a start is itself a memory cost, and the server was killed for it twice.
 * A Claude seat with a banked conversation comes back WITH it (resume); anything else starts fresh.
 */

export interface SeatRestartSettings {
  /** the room lead may restart a member of its own room */
  leadsRestartMembers: boolean;
}

export const SEAT_RESTART_DEFAULTS: Readonly<SeatRestartSettings> = Object.freeze({ leadsRestartMembers: true });

export class SeatRestartError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

/** A PATCH body, validated: only the known key, a boolean. */
export function validSeatRestartPatch(b: unknown): Partial<SeatRestartSettings> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new SeatRestartError('body', 'an object with leadsRestartMembers');
  }
  const o = b as Record<string, unknown>;
  const stray = Object.keys(o).find((k) => k !== 'leadsRestartMembers');
  if (stray) {
    throw new SeatRestartError(stray, 'not a seat-restart setting');
  }
  if (typeof o.leadsRestartMembers !== 'boolean') {
    throw new SeatRestartError('leadsRestartMembers', 'true or false');
  }
  return { leadsRestartMembers: o.leadsRestartMembers };
}

/** A stored value read back leniently: ON unless it was explicitly turned off. */
export function seatRestartFrom(raw: unknown): SeatRestartSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { leadsRestartMembers: o.leadsRestartMembers !== false };
}

/** one restart per seat per this long (the lead; the person is exempt) */
export const RESTART_MIN_GAP_MS = 10 * 60_000;
/** `/seat restart all` starts one seat, then waits this long before the next, so a restart cannot cause its own spike */
export const RESTART_ALL_GAP_MS = 60_000;
/** the most restarts a room's lead may cause in an hour */
export const RESTART_HOURLY_CAP = 10;
/** below this much available memory, or above this much swap in use, nothing is started */
export const MEM_MIN_AVAILABLE_MB = 4096;
export const SWAP_MAX_USED_FRACTION = 0.8;

export interface MemInfo {
  availableMb: number;
  swapTotalMb: number;
  swapFreeMb: number;
}

/** /proc/meminfo, parsed. Null when it has no MemAvailable (not Linux): the guard then does not apply. */
export function parseMeminfo(text: string): MemInfo | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const avail = kb('MemAvailable');
  if (avail === null) {
    return null;
  }
  return { availableMb: Math.floor(avail / 1024), swapTotalMb: Math.floor((kb('SwapTotal') ?? 0) / 1024), swapFreeMb: Math.floor((kb('SwapFree') ?? 0) / 1024) };
}

/** The refusal for a machine short of memory, with the numbers, or null when there is room. */
export function memoryGuard(m: MemInfo | null): string | null {
  if (!m) {
    return null;
  }
  if (m.availableMb < MEM_MIN_AVAILABLE_MB) {
    return `the machine is short of memory (${m.availableMb} MB available, ${MEM_MIN_AVAILABLE_MB} MB needed to start a seat)`;
  }
  if (m.swapTotalMb > 0) {
    const used = (m.swapTotalMb - m.swapFreeMb) / m.swapTotalMb;
    if (used > SWAP_MAX_USED_FRACTION) {
      return `the machine is swapping heavily (${Math.round(used * 100)}% of swap in use, the limit is ${Math.round(SWAP_MAX_USED_FRACTION * 100)}%)`;
    }
  }
  return null;
}

export type SeatPaneState = 'live' | 'dehydrated' | 'killed' | 'none' | 'other';

export interface RestartFacts {
  /** the person (a window credential) */
  byUser: boolean;
  /** the asking seat is the lead of the target's room */
  byLeadOfRoom: boolean;
  /** the target is that room's lead */
  targetIsLead: boolean;
  targetHandle: string;
  targetState: SeatPaneState;
  /** a switch is moving this seat's assistant */
  switching: boolean;
  lastRestartAt: number | null;
  /** the seat has never been started: no pane and no former occupant. A first start is not a restart, so the per-seat gap does not
   *  apply to it (the memory guard is its limit). Omitted = false. */
  firstStart?: boolean;
  /** Local mode: the memory budget's refusal text (or null = room). When defined it REPLACES the /proc/meminfo guard, which does nothing on Windows. */
  memoryRefusal?: string | null;
  now: number;
  settings: SeatRestartSettings;
  mem: MemInfo | null;
}

export interface LeadAuthorityInput {
  actorSeatId: string;
  targetSeatId: string;
  targetRoomId: string;
  /** every room of the target's family: the main room (parent_id null) and its workgroups */
  family: { id: string; parent_id: string | null; lead_seat: string | null }[];
}

/**
 * WHO LEADS WHAT, from the ROOM-LEAD POINTER (`rooms.lead_seat`), never from where a seat sits (a lead may sit in a team, [ref]).
 *   byLead:       the asker leads the target's room, or leads the MAIN room of the target's family (it may restart any seat there,
 *                 workgroups included). A workgroup lead reaches its own group only.
 *   targetIsLead: the target leads its room AND the asker may not restart it. The main-room lead may restart a workgroup's lead (it
 *                 starts its team); nobody under the person restarts the main-room lead, and one group lead does not restart another.
 */
export function leadAuthority(i: LeadAuthorityInput): { byLead: boolean; targetIsLead: boolean } {
  const room = i.family.find((r) => r.id === i.targetRoomId);
  const main = i.family.find((r) => r.parent_id === null);
  const leadsMain = !!main && main.lead_seat === i.actorSeatId;
  const byLead = !!room && (room.lead_seat === i.actorSeatId || leadsMain);
  const targetLeads = !!room && room.lead_seat === i.targetSeatId;
  const mayRestartLead = leadsMain && !!room && room.parent_id !== null && i.actorSeatId !== i.targetSeatId;
  return { byLead, targetIsLead: targetLeads && !mayRestartLead };
}

export type RestartDecision = { ok: true } | { ok: false; error: string };

export function decideRestart(f: RestartFacts): RestartDecision {
  const no = (error: string): RestartDecision => ({ ok: false, error });
  if (!f.byUser) {
    if (!f.byLeadOfRoom) {
      return no('restarting a seat is the user\'s; the room lead may restart members of its own room (the main room\'s lead, any seat of its family)');
    }
    if (!f.settings.leadsRestartMembers) {
      return no('"Leads can restart members" is off; ask the user');
    }
    if (f.targetIsLead) {
      return no('only the user restarts the room lead');
    }
  }
  if (f.switching) {
    return no(`@${f.targetHandle}'s assistant is being switched; it starts again on its own when the switch ends`);
  }
  if (f.targetState === 'live') {
    return no(`@${f.targetHandle} is live; end it first (a restart would throw away what it is doing)`);
  }
  if (f.targetState === 'other') {
    return no(`@${f.targetHandle} is not in a state that can be restarted`);
  }
  if (!f.byUser && !f.firstStart && f.lastRestartAt !== null && f.now - f.lastRestartAt < RESTART_MIN_GAP_MS) {
    const wait = Math.ceil((RESTART_MIN_GAP_MS - (f.now - f.lastRestartAt)) / 60_000);
    return no(`@${f.targetHandle} was restarted ${Math.floor((f.now - f.lastRestartAt) / 60_000)} min ago; one restart per seat per ${RESTART_MIN_GAP_MS / 60_000} min (try in ${wait} min)`);
  }
  const mem = f.memoryRefusal !== undefined ? f.memoryRefusal : memoryGuard(f.mem);
  if (mem) {
    return no(mem);
  }
  return { ok: true };
}

/** How a seat comes back: a Claude seat with a banked conversation resumes it; everything else starts fresh. */
export function restartMode(vendor: string | null, sessionId: string | null): { resumeSessionId: string } | { fresh: true } {
  if (vendor === 'claude-code' && sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) {
    return { resumeSessionId: sessionId };
  }
  return { fresh: true };
}

/** The room fact for a restart. */
export function restartedFact(handle: string, by: string, mode: 'resume' | 'fresh'): string {
  return `@${handle} is restarting (asked by ${by}; ${mode === 'resume' ? 'resuming its conversation' : 'a fresh start, it has no memory of before'})`;
}
