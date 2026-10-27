/* CONCIERGE SIGN-OFFS (the design notes; design review [ref]): the person's one-shot approval of ONE Concierge act.
 *  - ONLY A PERSON ANSWERS (the route checks the credential; this module records who).
 *  - The ENGINE writes the card words from verb + frozen targets, and QUOTES any arg that changes the effect verbatim, labelled as the Concierge's; an arg not on the card is not an input.
 *  - Targets are expanded and FROZEN at request time; `consume` hands the act that frozen list, never the requester's.
 *  - Single use: `consume` moves approved -> consumed in ONE statement before anything runs; a failed action stays consumed.
 *  - At most MAX_PENDING pending; an allowed-switch turned OFF cancels pending/approved records of its verbs; the off switch cancels all.
 * The clock is injectable (`now`) so expiry is testable. */
import { createHash, randomBytes } from 'node:crypto';
import { table } from '../table/endpoint.ts';
import type { SignoffRow } from '../table/store.ts';
import type { Action } from './concierge.ts';

export const TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING = 5;
export const RETAIN_MS = 30 * 24 * 3600 * 1000;
export const INJECT_MAX = 2000;
export const TARGETS_MAX = 20;

export class SignoffError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** The verbs, the allowed-action switch that gates each, the words, and whether they take an arg. */
export const VERBS: Readonly<Record<string, { action: Action; words: string; arg?: 'text' }>> = Object.freeze({
  'deliver-held': { action: 'message', words: 'Deliver the held drafts of' },
  reload: { action: 'compactReload', words: 'Reload' },
  compact: { action: 'compactReload', words: 'Compact' },
  inject: { action: 'inject', words: 'Type into', arg: 'text' },
  start: { action: 'startRestore', words: 'Start' },
  restore: { action: 'startRestore', words: 'Restore' },
  'pull-in': { action: 'dispatch', words: 'Pull in' },
});

export interface Target {
  room_id: string;
  seat_id: string;
  handle: string;
}
export interface Signoff {
  id: string;
  created_at: number;
  expires_at: number;
  state: SignoffRow['state'];
  verb: string;
  targets: Target[];
  args: Record<string, unknown>;
  text: string;
  answered_at: number | null;
  answered_by: string | null;
  via: string | null;
  consumed_at: number | null;
  result: unknown;
}

const view = (r: SignoffRow): Signoff => ({
  id: r.id,
  created_at: r.created_at,
  expires_at: r.expires_at,
  state: r.state,
  verb: r.verb,
  targets: JSON.parse(r.targets),
  args: JSON.parse(r.args),
  text: r.text,
  answered_at: r.answered_at,
  answered_by: r.answered_by,
  via: r.via,
  consumed_at: r.consumed_at,
  result: r.result ? JSON.parse(r.result) : null,
});

const hashOf = (verb: string, targets: Target[], args: Record<string, unknown>): string =>
  createHash('sha256').update(JSON.stringify([verb, targets.map((t) => t.seat_id), args])).digest('hex');

/** Groups expand HERE, server-side: `{room, handle}` is one seat; `{room, all:true}` is every seat still in the room. A target that does not exist is a 400, never skipped. */
function expand(raw: unknown): Target[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > TARGETS_MAX) {
    throw new SignoffError(400, 'bad_targets', `targets is a list of 1 to ${TARGETS_MAX} {room, handle} or {room, all:true}`);
  }
  const out: Target[] = [];
  for (const t of raw as Array<Record<string, unknown>>) {
    const room = t && typeof t.room === 'string' ? table.getRoom(t.room) : undefined;
    if (!room) {
      throw new SignoffError(400, 'bad_targets', 'each target names a room that exists');
    }
    const seats = t.all === true ? table.listSeats(room.id) : typeof t.handle === 'string' ? [table.seatByHandle(room.id, t.handle.replace(/^@/, ''))].filter((x): x is NonNullable<typeof x> => !!x) : [];
    if (!seats.length) {
      throw new SignoffError(400, 'bad_targets', `no such seat in ${room.id}`);
    }
    for (const s of seats) {
      if (!out.some((o) => o.seat_id === s.id)) {
        out.push({ room_id: room.id, seat_id: s.id, handle: s.handle });
      }
    }
  }
  if (out.length > TARGETS_MAX) {
    throw new SignoffError(400, 'bad_targets', `a sign-off covers at most ${TARGETS_MAX} seats`);
  }
  return out;
}

function checkArgs(verb: string, raw: unknown): Record<string, unknown> {
  const spec = VERBS[verb];
  const a = raw === undefined || raw === null ? {} : raw;
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    throw new SignoffError(400, 'bad_args', 'args is an object');
  }
  const keys = Object.keys(a);
  if (!spec.arg) {
    if (keys.length) {
      throw new SignoffError(400, 'bad_args', `${verb} takes no args`);
    }
    return {};
  }
  const text = (a as Record<string, unknown>).text;
  if (keys.length !== 1 || typeof text !== 'string' || !text.trim() || text.length > INJECT_MAX) {
    throw new SignoffError(400, 'bad_args', `${verb} takes exactly {text}, 1 to ${INJECT_MAX} characters`);
  }
  return { text };
}

/** THE CARD, written by the engine. The only requester-supplied words on it are the quoted arg, labelled as the Concierge's. */
export function cardText(verb: string, targets: Target[], args: Record<string, unknown>): string {
  const base = `${VERBS[verb].words} ${targets.length} seat${targets.length === 1 ? '' : 's'}: ${targets.map((t) => `@${t.handle}`).join(' ')}`;
  return typeof args.text === 'string' ? `${base}\nText from the Concierge: ${JSON.stringify(args.text)}` : base;
}

export function expireDue(now: number): void {
  table.signoffExpire(now);
}

/** The Concierge pane asks. The allowed-action switch for the verb must be ON. */
export function request(body: Record<string, unknown>, allowed: Record<Action, boolean>, now: number = Date.now()): Signoff {
  const verb = typeof body.verb === 'string' ? body.verb : '';
  if (!Object.prototype.hasOwnProperty.call(VERBS, verb)) {
    throw new SignoffError(400, 'bad_verb', `verb is one of ${Object.keys(VERBS).join(', ')}`);
  }
  if (!allowed[VERBS[verb].action]) {
    throw new SignoffError(403, 'action_off', `the person has not allowed the Concierge to ${verb}`);
  }
  const args = checkArgs(verb, body.args);
  const targets = expand(body.targets);
  expireDue(now);
  if (table.signoffPendingCount() >= MAX_PENDING) {
    throw new SignoffError(429, 'too_many_pending', `${MAX_PENDING} sign-offs are already waiting on the person`);
  }
  const id = randomBytes(6).toString('hex');
  table.signoffInsert({ id, created_at: now, expires_at: now + TTL_MS, verb, targets: JSON.stringify(targets), args: JSON.stringify(args), args_hash: hashOf(verb, targets, args), text: cardText(verb, targets, args) });
  return view(table.signoffGet(id)!);
}

export function get(id: string, now: number = Date.now()): Signoff | undefined {
  expireDue(now);
  const r = table.signoffGet(id);
  return r ? view(r) : undefined;
}

export function list(state: 'pending' | 'all', limit: number, now: number = Date.now()): Signoff[] {
  expireDue(now);
  return table.signoffList(state === 'pending' ? 'pending' : null, Math.min(100, Math.max(1, Math.floor(limit) || 50))).map(view);
}

/** A PERSON answers (the route has already refused every other credential). `voice` is accepted only when the caller says the voice host proved it. */
export function answer(id: string, answerKind: unknown, by: string, via: unknown, voiceProven: boolean, now: number = Date.now()): Signoff {
  if (answerKind !== 'approve' && answerKind !== 'cancel') {
    throw new SignoffError(400, 'bad_answer', "answer is 'approve' or 'cancel'");
  }
  const v = via === undefined || via === null ? 'tap' : via;
  if (v !== 'tap' && v !== 'voice') {
    throw new SignoffError(400, 'bad_via', "via is 'tap' or 'voice'");
  }
  if (v === 'voice' && !voiceProven) {
    throw new SignoffError(403, 'voice_not_proven', 'via voice is recorded only from the app host');
  }
  expireDue(now);
  const row = table.signoffGet(id);
  if (!row) {
    throw new SignoffError(404, 'no_such_signoff', 'no such sign-off');
  }
  const moved = table.signoffMove(id, ['pending'], answerKind === 'approve' ? 'approved' : 'cancelled', { answered_at: now, answered_by: by, via: v }, now);
  if (!moved) {
    throw new SignoffError(409, 'not_pending', `this sign-off is ${table.signoffGet(id)!.state}`, { state: table.signoffGet(id)!.state });
  }
  return view(table.signoffGet(id)!);
}

/** The act takes the approval: approved + unexpired + the verb it was approved for, moved to `consumed` in one statement BEFORE anything runs. Returns the record, whose
 *  FROZEN targets and args are the only ones the act may use. */
export function consume(id: string, verb: string, now: number = Date.now()): Signoff {
  expireDue(now);
  const row = table.signoffGet(id);
  if (!row) {
    throw new SignoffError(404, 'no_such_signoff', 'no such sign-off');
  }
  if (row.verb !== verb) {
    throw new SignoffError(409, 'wrong_verb', `this sign-off approves ${row.verb}, not ${verb}`);
  }
  if (!table.signoffMove(id, ['approved'], 'consumed', { consumed_at: now }, now)) {
    throw new SignoffError(409, 'not_approved', `this sign-off is ${row.state}${row.state === 'consumed' ? ' (single use)' : ''}`, { state: row.state });
  }
  return view(table.signoffGet(id)!);
}

/** The act records what happened; the record stays consumed whatever it says. */
export function recordResult(id: string, result: unknown): void {
  table.signoffMove(id, ['consumed'], 'consumed', { result: JSON.stringify(result) });
}

/** After a settings change: the off switch cancels everything; a switch turned off cancels its verbs. */
export function cancelForSettings(enabled: boolean, allowed: Record<Action, boolean>): number {
  if (!enabled) {
    return table.signoffCancel(null);
  }
  const off = Object.entries(VERBS).filter(([, v]) => !allowed[v.action]).map(([k]) => k);
  return table.signoffCancel(off);
}

export function prune(now: number = Date.now()): number {
  return table.signoffPrune(now - RETAIN_MS);
}

/** How many PENDING sign-offs have a target in each room (a sign-off with two targets in one room counts once there). */
export function pendingByRoom(now: number = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  for (const sg of list('pending', 100, now)) {
    for (const rid of new Set(sg.targets.map((t) => t.room_id))) {
      out.set(rid, (out.get(rid) ?? 0) + 1);
    }
  }
  return out;
}
