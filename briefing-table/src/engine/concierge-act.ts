/* CONCIERGE ACT (the design notes section 2): run ONE approved verb on the FROZEN targets of a consumed sign-off, through the same guards as the window
 * buttons, and leave an audit fact in every room it touched. The sign-off is consumed FIRST (concierge-signoff.consume), so a failed action stays consumed. A target that has gone
 * or moved since the request is SKIPPED with a note, never substituted. Built verbs are listed in BUILT; any other approved verb is refused 501 BEFORE it is consumed.
 * Everything that touches a room, a pane or the typer is injected (ActDeps), so the rules are testable without an engine. */
import * as signoff from './concierge-signoff.ts';
import type { Target } from './concierge-signoff.ts';

export interface ActSeat {
  id: string;
  room_id: string;
  handle: string;
  left_at: number | null;
  /** the running terminal this seat is, when it is one */
  paneid: string | null;
}
export interface ActDeps {
  seat(seatId: string): ActSeat | undefined;
  held(paneid: string): { depth: number } | null;
  /** true when the input box holds text nobody sent: a person's approval never waives this */
  hasDraft(paneid: string): boolean;
  deliverHeld(paneid: string): { ok: true; result: string } | { ok: false; reason: string; prompt?: string };
  /** the seat's terminal state (live | dehydrated | killed | ...), null when it has none */
  paneState(paneid: string): string | null;
  /** the seat's own Start (the window button's path); rejects with the guard's reason */
  start(seatId: string): Promise<{ paneid?: string }>;
  /** the seat's own Reload (the window button's path); rejects with the guard's reason */
  reload(seatId: string): Promise<unknown>;
  fact(roomId: string, body: string, meta: Record<string, unknown>): void;
  log(line: string): void;
}
export interface ActResult {
  target: string;
  status: 'done' | 'skipped' | 'failed';
  note?: string;
}

type Outcome = { status: ActResult['status']; note?: string; fact?: string };
type Handler = (seat: ActSeat, args: Record<string, unknown>, deps: ActDeps) => Outcome | Promise<Outcome>;

const deliverHeld: Handler = (seat, _args, deps) => {
  if (!seat.paneid) {
    return { status: 'skipped', note: 'not a running terminal' };
  }
  const held = deps.held(seat.paneid);
  if (!held || held.depth === 0) {
    return { status: 'skipped', note: 'nothing is held for it' };
  }
  if (deps.hasDraft(seat.paneid)) {
    return { status: 'skipped', note: 'its input box has typed text that was never sent; only a person at the window may send over it' };
  }
  const d = deps.deliverHeld(seat.paneid);
  if (!d.ok) {
    return { status: 'skipped', note: d.reason === 'startup' ? `its window may be showing a prompt (${d.prompt})` : d.reason === 'no-claude' ? 'claude is not running in its terminal' : d.reason };
  }
  return { status: 'done', note: d.result, fact: `delivered ${held.depth} held line${held.depth === 1 ? '' : 's'} to @${seat.handle}` };
};


/** start: a seat with no running terminal and no session to bring back. restore: a seat whose session rested (dehydrated). Both are the seat's own Start, whose guards (memory, archived
 *  room, missing program, switch in progress) stay the window's; a refusal there is a skipped note, never a bypass. */
const startVerb = (want: 'start' | 'restore'): Handler => async (seat, _args, deps) => {
  const state = seat.paneid ? deps.paneState(seat.paneid) : null;
  if (state === 'live') {
    return { status: 'skipped', note: 'already running' };
  }
  if (want === 'restore' && state !== 'dehydrated') {
    return { status: 'skipped', note: 'it has no resting session to restore' };
  }
  if (want === 'start' && state === 'dehydrated') {
    return { status: 'skipped', note: 'it has a resting session; that is a restore' };
  }
  try {
    await deps.start(seat.id);
  } catch (e) {
    return { status: 'skipped', note: (e as Error).message };
  }
  return { status: 'done', fact: `${want === 'start' ? 'started' : 'restored'} @${seat.handle}` };
};

/** reload: the seat's own Reload, never forced (a seat mid-turn is skipped with the window's own words). */
const reloadVerb: Handler = async (seat, _args, deps) => {
  const state = seat.paneid ? deps.paneState(seat.paneid) : null;
  if (state !== 'live') {
    return { status: 'skipped', note: 'it has no live session to reload' };
  }
  try {
    await deps.reload(seat.id);
  } catch (e) {
    return { status: 'skipped', note: (e as Error).message };
  }
  return { status: 'done', fact: `reloaded @${seat.handle}` };
};

/** Verbs with a handler. The rest of signoff.VERBS follow, one commit each. */
export const BUILT: Readonly<Record<string, Handler>> = Object.freeze({ 'deliver-held': deliverHeld, reload: reloadVerb, start: startVerb('start'), restore: startVerb('restore') });

export async function act(signoffId: string, verb: string, deps: ActDeps, now: number = Date.now()): Promise<{ ok: true; results: ActResult[] }> {
  const handler = Object.prototype.hasOwnProperty.call(BUILT, verb) ? BUILT[verb] : undefined;
  if (!handler) {
    throw new signoff.SignoffError(501, 'verb_not_built', `${verb} is not built yet; nothing was consumed`);
  }
  const s = signoff.consume(signoffId, verb, now); // consume FIRST: from here a failure stays consumed
  const results: ActResult[] = [];
  const facts = new Map<string, string[]>();
  for (const t of s.targets as Target[]) {
    let r: ActResult;
    try {
      const seat = deps.seat(t.seat_id);
      if (!seat || seat.left_at !== null || seat.room_id !== t.room_id) {
        r = { target: t.handle, status: 'skipped', note: 'it has left or moved since the request' };
      } else {
        const h = await handler(seat, s.args, deps);
        r = { target: t.handle, status: h.status, ...(h.note ? { note: h.note } : {}) };
        if (h.status === 'done' && h.fact) {
          facts.set(t.room_id, [...(facts.get(t.room_id) ?? []), h.fact]);
        }
      }
    } catch (e) {
      r = { target: t.handle, status: 'failed', note: (e as Error).message };
    }
    results.push(r);
  }
  for (const [roomId, lines] of facts) {
    try {
      deps.fact(roomId, `Concierge (for the person, sign-off ${s.id}): ${lines.join('; ')}`, { concierge: { signoff: s.id, verb } });
    } catch (e) {
      deps.log(`concierge act ${s.id}: audit fact for ${roomId} failed: ${(e as Error).message}`);
    }
  }
  signoff.recordResult(s.id, { ok: true, results });
  deps.log(`concierge act ${s.id} ${verb}: ${results.map((r) => `${r.target}=${r.status}`).join(' ')}`);
  return { ok: true, results };
}
