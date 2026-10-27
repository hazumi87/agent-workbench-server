/**
 * TERMINAL ATTACH GRANTS (W3b, room application [ref]/[ref]): the store and the
 * rules behind POST /api/terminal-grants and WS /term (src/server/term.ts).
 *
 * A grant is the second credential the Workbench needs to see one seat's
 * terminal: the person's cookie AND a grant minted under that cookie. Either
 * alone opens nothing. Pure on purpose (no engine imports, the clock and the
 * table reads are passed in), so the refusal rules are unit-testable.
 *
 * THE GRANT VALUE NEVER LEAVES THIS FILE except in the mint answer: the store
 * is keyed by its sha256, and nothing here logs it.
 */
import { createHash, randomBytes } from 'node:crypto';

export const GRANT_TTL_MS = 30_000;
export const MINTS_PER_MINUTE = 10;
export const SOCKETS_PER_PERSON = 4;
export const FIRST_FRAME_MS = 5_000;
export const FRAME_MAX_BYTES = 64 * 1024;
export const INPUT_FRAMES_PER_SECOND = 50;
/** HARBOR_WB_TERM_IDLE_MS may only SHORTEN the 30 min idle limit (1 s floor),
 *  so a dev run can watch the idle close happen; anything else is the default. */
const IDLE_ENV = Number(process.env.HARBOR_WB_TERM_IDLE_MS);
export const IDLE_MS = IDLE_ENV >= 1_000 && IDLE_ENV < 30 * 60_000 ? IDLE_ENV : 30 * 60_000;
/** How often an open socket checks its lifetime and sign-in: 30 s, or half a shortened idle limit. */
export const TICK_MS = Math.min(30_000, Math.floor(IDLE_MS / 2));
export const ABSOLUTE_MS = 8 * 60 * 60_000;

export type Intent = 'view' | 'control';

export interface Grant {
  personId: string;
  credentialId: string;
  paneid: string;
  intent: Intent;
  roomId: string;
  seatId: string;
  exp: number;
}

const hash = (grant: string): string => createHash('sha256').update(grant).digest('hex');

/** The in-memory grant store plus the per-person mint rate. An engine restart
 *  drops every grant, which is fine at 30 s. */
export function createGrantStore(now: () => number = Date.now) {
  const grants = new Map<string, Grant>();
  const mints = new Map<string, number[]>();
  return {
    /** Counts this attempt against the person's minute; false = over the limit. */
    allowMint(personId: string): boolean {
      const t = now();
      const recent = (mints.get(personId) ?? []).filter((at) => t - at < 60_000);
      const allowed = recent.length < MINTS_PER_MINUTE;
      if (allowed) {
        recent.push(t);
      }
      mints.set(personId, recent);
      return allowed;
    },
    mint(fields: Omit<Grant, 'exp'>): string {
      const t = now();
      for (const [k, g] of grants) {
        if (g.exp <= t) {
          grants.delete(k); // expired grants are swept here; nothing else holds them
        }
      }
      const grant = randomBytes(32).toString('base64url');
      grants.set(hash(grant), { ...fields, exp: t + GRANT_TTL_MS });
      return grant;
    },
    /** SINGLE USE AND ATOMIC [R2]: get and delete in one synchronous step, no
     *  await between, so two sockets presenting one grant cannot both win. The
     *  grant is gone whether or not the caller then accepts it. */
    redeem(grant: unknown): Grant | null {
      if (typeof grant !== 'string' || !grant) {
        return null;
      }
      const k = hash(grant);
      const g = grants.get(k);
      grants.delete(k);
      return g && g.exp > now() ? g : null;
    },
    size: (): number => grants.size,
  };
}

/** The table facts entitlement needs, injected. */
export interface Lookups {
  room(id: string): { id: string; state: string } | undefined;
  /** Current seats only (no `left_at`). */
  seats(roomId: string): Array<{ id: string; handle: string; occupant_kind: string; occupant: string | null }>;
  paneState(paneid: string): string | undefined;
}

export type Entitlement =
  | { ok: true; seatId: string; handle: string }
  | { ok: false; status: number; field: string; error: string; reason: string };

/**
 * §3, checked at mint AND again at redemption (and whenever the room changes
 * under an open socket):
 *   1. the room exists and is open; the seat is one of its current seats;
 *   2. the pane is that seat's current occupant, and it is `live`;
 *   3. the person can read the room. Every signed-in person can (rooms carry
 *      no per-person membership yet, §7.1), so 3 is the person credential the
 *      caller has already demanded; there is nothing further to check here.
 * `seat` may be the seat id or its handle.
 */
export function entitlement(q: { roomId: string; seat: string; paneid: string }, l: Lookups): Entitlement {
  const room = l.room(q.roomId);
  if (!room) {
    return { ok: false, status: 404, field: 'room', error: 'no such room', reason: 'no-room' };
  }
  if (room.state !== 'open') {
    return { ok: false, status: 403, field: 'paneid', error: 'the room is not open', reason: 'room-closed' };
  }
  const seat = l.seats(room.id).find((s) => s.id === q.seat || s.handle.toLowerCase() === q.seat.toLowerCase());
  if (!seat) {
    return { ok: false, status: 404, field: 'seat', error: 'no such seat in this room', reason: 'no-seat' };
  }
  const state = l.paneState(q.paneid);
  if (state === undefined) {
    return { ok: false, status: 404, field: 'paneid', error: 'no such pane', reason: 'no-pane' };
  }
  if (seat.occupant_kind !== 'pane' || seat.occupant !== q.paneid) {
    return { ok: false, status: 403, field: 'paneid', error: "the pane is not this seat's current occupant", reason: 'not-occupant' };
  }
  if (state !== 'live') {
    return { ok: false, status: 409, field: 'paneid', error: `the pane is not live (${state})`, reason: 'not-live' };
  }
  return { ok: true, seatId: seat.id, handle: seat.handle };
}

/** The allow-list [R1], exact origins. Default: the Workbench's fixed origin. */
export function allowedOrigins(env: string | undefined = process.env.HARBOR_WB_TERM_ORIGINS): string[] {
  const list = (env ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return list.length ? list : ['app://workbench'];
}

/** Required Origin [R1]: on the allow-list, or the engine's OWN origin (its
 *  own pages: the scheme the request arrived on plus the Host it was sent to).
 *  Missing is refused, never treated as same-origin. */
export function originAllowed(
  headers: { origin?: string; host?: string; 'x-forwarded-proto'?: string | string[] },
  allow: string[] = allowedOrigins(),
): boolean {
  const origin = headers.origin;
  if (!origin) {
    return false;
  }
  if (allow.includes(origin)) {
    return true;
  }
  const proto = String(headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  return !!headers.host && origin === `${proto}://${headers.host}`;
}

/** Why an open socket must close now, or null [R3]. */
export function lifetimeVerdict(s: { openedAt: number; lastActivity: number }, now: number): 'absolute' | 'idle' | null {
  if (now - s.openedAt >= ABSOLUTE_MS) {
    return 'absolute';
  }
  if (now - s.lastActivity >= IDLE_MS) {
    return 'idle';
  }
  return null;
}

/** Sliding one-second input counter; false = over the cap [R3]. */
export function createInputRate(now: () => number = Date.now) {
  const at: number[] = [];
  return (): boolean => {
    const t = now();
    while (at.length && t - at[0] >= 1000) {
      at.shift();
    }
    at.push(t);
    return at.length <= INPUT_FRAMES_PER_SECOND;
  };
}

/** The log's short room id. */
export const id8 = (id: string): string => id.slice(0, 8);
