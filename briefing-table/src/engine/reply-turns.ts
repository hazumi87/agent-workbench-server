/* ============================================================================
 * REPLY TURNS AND THREADS (the design notes, agreed with Owner
 * 2026-10-10). A PURE state machine: no table, no clock, no pane. rooms.ts
 * feeds it lines and posts and applies the effects it returns (a room fact
 * plus a typed turn line). Injectable clock + liveness + token mint, so every
 * rule is unit-testable (test/reply-turns.test.ts).
 *
 * THE MODEL, in one paragraph. A line belongs to ONE thread (id = the line that
 * opened it). Any line in a thread that REFERENCES seats gives each one a PLACE
 * in that thread's queue, in reference order (a reference is delivery, never an
 * obligation; the room's lead has no priority here). ONE seat posts at a time
 * per thread: the FLOOR, which goes to the first CLAIMED place with no BLOCKING
 * place ahead of it. An unclaimed place blocks for WINDOW_MS after the line that
 * made it, then LAPSES silently (a seat with nothing to say is normal). A claim
 * keeps a place; a post is an implicit claim; a pass withdraws. A floor-holder
 * has TURN_MS to post or pass, else it is SKIPPED with a room fact; one whose
 * pane stops being live is skipped at once. The person is never held. Nothing
 * cancels a place except its answer, a pass, a lapse, a skip.
 *
 * THREAD RULES (which thread a line joins), in order:
 *   1. its reply (reply_to, or the reply the reply-inherit rule gave it): the
 *      parent's thread, however old (the caller passes parentThread);
 *   2. a PERSON's line with no reply that references seats: the newest thread
 *      of the room with places pending whose members include EVERY referenced
 *      seat ("a follow-up typed before anyone answered");
 *   3. a SEAT's line with no reply: the newest thread where that seat holds a
 *      place (its answer to what it was asked; the spec's "hold only when the
 *      post replies to the source line or has no reply and the seat still has a
 *      pending turn" safe default, kept) - but not when it names a seat that
 *      thread has never involved: that is a new conversation and opens its own
 *      thread, so a seat waiting in A is never held by A's floor for it;
 *   4. otherwise it OPENS a new thread (its own id).
 * An @room line opens a thread with NO FLOOR: its replies go to the asker, not
 * to each other, and are never held.
 *
 * IN MEMORY ONLY (spec §Persistence): a restart drops every queue and seats
 * answer as today. Never log a grant. Bounded: MAX_PENDING threads with places
 * per room (oldest dropped), IDLE_DROP_MS for threads with none, MAX_LINES lines
 * remembered per thread.
 * ========================================================================== */

import { randomBytes } from 'node:crypto';
import { excerptOf } from './room-reply.ts';

export type TurnsMode = 'off' | 'enforce';

/** `enforce` only when asked, and never in Basic (one assistant per room). */
export function mode(): TurnsMode {
  if (process.env.HARBOR_WB_EDITION === 'basic') {
    return 'off';
  }
  return process.env.HARBOR_WB_REPLY_TURNS === 'enforce' ? 'enforce' : 'off';
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
/** How long an unclaimed place blocks the places behind it (backlog: a global setting). */
export const windowMs = (): number => num(process.env.HARBOR_WB_TURN_WINDOW_MS, 30_000);
/** How long a floor-holder has to post or pass (backlog: a global setting). */
export const turnMs = (): number => num(process.env.HARBOR_WB_TURN_MS, 300_000);
/** How long a floor-holder may be SILENT (no pane output, no ack) before it is skipped as unresponsive. Any
 *  output resets it, so a seat that is working is never cut off; a frozen one is released in minutes, not turnMs. */
export const ackMs = (): number => num(process.env.HARBOR_WB_TURN_ACK_MS, 120_000);

/** READ BEFORE ANSWER (the [ref]/[ref] double answer, 2026-10-25): off with HARBOR_WB_TURN_READ_GATE=0. */
export const readGate = (): boolean => process.env.HARBOR_WB_TURN_READ_GATE !== '0';

export const MAX_PENDING = 50;
export const MAX_LINES = 60;
export const DELTA_MAX = 10;
export const IDLE_DROP_MS = 6 * 60 * 60 * 1000;

export interface TurnsCtx {
  now: number;
  /** is this seat's occupant a live pane */
  isLive(seatId: string): boolean;
  /** the seat's @handle (for facts and "behind") */
  handle(seatId: string): string;
  /** why the seat's pane cannot answer right now ('limit' = the usage-limit menu is up), else null. Optional:
   *  without it nothing is skipped for being blocked. */
  blockedReason?(seatId: string): string | null;
  /** when the seat's pane last produced output (ms), null if unknown. Optional: without it the ack window is off. */
  lastActive?(seatId: string): number | null;
  /** this room's own turn time (ms) when the user set one (`/set turn <minutes>`), else null = the default. */
  turnMsFor?(roomId: string): number | null;
}

interface Place {
  seat: string;
  sources: number[];
  createdAt: number;
  claimed: boolean;
  floorSince: number | null;
  grant: string | null;
  acked: boolean;
  /** the newest other-author line id this seat has been handed (a turn line's delta) */
  shown?: number;
  /** the OTHER SEATS' lines handed with the grant (never the person's): what a holder that has not acknowledged may not have read */
  handed?: ThreadLine[];
  /** this seat was refused a post here ("wait for your turn line"): its next post follows the turn line by protocol */
  waited?: boolean;
}

export interface ThreadLine {
  id: number;
  /** 'user' or a seat id */
  author: string;
  /** what a reader sees: @handle or @user's name */
  who: string;
  excerpt: string;
}

interface Thread {
  id: number;
  roomId: string;
  floor: boolean;
  places: Place[];
  lines: ThreadLine[];
  /** seats referenced by, or authoring, any line of the thread */
  members: Set<string>;
  /** the last seat that answered (for "after @y") */
  lastAnswer: string | null;
  /** a floor was handed in this thread, and whether its queue has since emptied
   *  and been announced (the `closed` effect, once per emptying) */
  opened?: boolean;
  closed?: boolean;
  touched: number;
}

export interface FloorEffect {
  type: 'floor';
  roomId: string;
  thread: number;
  seat: string;
  sources: number[];
  after: string | null;
  grant: string;
  delta: ThreadLine[];
  more: number;
}
export type SkipWhy = 'timeout' | 'offline' | 'limit' | 'unresponsive' | 'user';
export interface SkipEffect {
  type: 'skip';
  roomId: string;
  thread: number;
  seat: string;
  sources: number[];
  why: SkipWhy;
}
/** The thread's queue emptied after a floor was handed: nobody is waiting on
 *  it any more (toolkit [ref]). A fact for clients; no seat, no delivery. */
export interface ClosedEffect {
  type: 'closed';
  roomId: string;
  thread: number;
}
export type TurnEffect = FloorEffect | SkipEffect | ClosedEffect;

export interface LineIn {
  id: number;
  roomId: string;
  /** 'user' or the author seat id */
  author: string;
  /** what readers call the author (@handle or the person's name) */
  who: string;
  body: string;
  /** seat ids the line references, in order (never the backticked ones) */
  references: string[];
  toRoom: boolean;
}

export type PostDecision =
  | { held: false; effects: TurnEffect[] }
  | { held: true; thread: number; behind: string | null; stale?: true; answered?: ThreadLine[]; effects: TurnEffect[] };

export type ClaimResult =
  | { ok: true; thread: number; state: 'floor' | 'queued'; behind?: string; grant?: string; effects: TurnEffect[] }
  | { ok: true; thread: number; passed: boolean; effects: TurnEffect[] }
  | { ok: true; thread: number; acknowledged: true; effects: TurnEffect[] }
  | { ok: false; error: 'wrong_grant'; message: string; effects: TurnEffect[] };

export interface MyTurn {
  thread: number;
  lines: number[];
  state: 'floor' | 'queued';
  behind?: string;
  grant?: string;
}

const defaultMint = (): string => randomBytes(12).toString('base64url');

export class ReplyTurns {
  private threads = new Map<number, Thread>();
  constructor(private mint: () => string = defaultMint) {}

  /* ---------------------------------------------------------- threads ---- */

  /** Which existing thread a line joins, or null when it opens a new one
   *  (rules 1-4 above). Pure: nothing changes. */
  threadFor(line: { roomId: string; author: string; parentThread: number | null; references: string[]; toRoom: boolean }): number | null {
    if (line.parentThread !== null) {
      return line.parentThread;
    }
    if (line.toRoom) {
      return null;
    }
    let best: Thread | null = null;
    for (const t of this.threads.values()) {
      if (t.roomId !== line.roomId && line.author === 'user') {
        continue;
      }
      const fits =
        line.author === 'user'
          ? t.floor && t.places.length > 0 && line.references.length > 0 && line.references.every((s) => t.members.has(s))
          : /* A SEAT'S line with no reply joins the thread where it still owes a turn - unless it names a seat that thread has never
               involved: that is a NEW conversation (a lead sending work to another agent), and it must not wait behind a floor in a
               thread it merely owes an answer to (Owner [ref]). A line naming only members of the thread, or nobody, stays in it. */
            t.places.some((p) => p.seat === line.author) && line.references.every((s) => t.members.has(s));
      if (fits && (!best || t.touched > best.touched || (t.touched === best.touched && t.id > best.id))) {
        best = t;
      }
    }
    return best ? best.id : null;
  }

  private ensure(id: number, roomId: string, floor: boolean, now: number): Thread {
    let t = this.threads.get(id);
    if (!t) {
      t = { id, roomId, floor, places: [], lines: [], members: new Set(), lastAnswer: null, touched: now };
      this.threads.set(id, t);
    }
    return t;
  }

  /* ----------------------------------------------------- the person's line ---- */

  /** A line WRITTEN in a thread (the person's, or a seat's post that was allowed).
   *  `thread` is what threadFor answered (null = this line opens one). A seat's
   *  post resolves its own place there. Returns the floor effects. */
  onLine(line: LineIn, thread: number | null, ctx: TurnsCtx): TurnEffect[] {
    const isNew = thread === null;
    const t = this.ensure(thread ?? line.id, line.roomId, isNew ? !line.toRoom : true, ctx.now);
    t.touched = ctx.now;
    t.lines.push({ id: line.id, author: line.author, who: line.who, excerpt: excerptOf(line.body) });
    if (t.lines.length > MAX_LINES) {
      t.lines.splice(0, t.lines.length - MAX_LINES);
    }
    if (line.author !== 'user') {
      t.members.add(line.author);
      const i = t.places.findIndex((p) => p.seat === line.author);
      if (i >= 0) {
        t.places.splice(i, 1);
      }
      t.lastAnswer = line.author;
    }
    for (const s of line.references) {
      t.members.add(s);
    }
    if (t.floor) {
      for (const s of [...new Set(line.references)]) {
        if (s === line.author) {
          continue;
        }
        const have = t.places.find((p) => p.seat === s);
        if (have) {
          if (!have.sources.includes(line.id)) {
            have.sources.push(line.id);
          }
          if (!have.claimed) {
            have.createdAt = Math.max(have.createdAt, ctx.now); // a fresh line restarts its window
          }
        } else {
          t.places.push({ seat: s, sources: [line.id], createdAt: ctx.now, claimed: false, floorSince: null, grant: null, acked: false });
        }
      }
    }
    const out = this.settle(t, ctx);
    this.cap(line.roomId);
    return out;
  }

  /* --------------------------------------------------------- a seat's post ---- */

  /** May `seat` post into `thread` NOW? A held post records its implicit claim
   *  (the seat keeps or gets a place); nothing is written by the caller. An
   *  allowed post is followed by onLine() once it is written. */
  decidePost(seat: string, thread: number | null, ctx: TurnsCtx): PostDecision {
    if (thread === null) {
      return { held: false, effects: [] };
    }
    const t = this.threads.get(thread);
    if (!t || !t.floor) {
      return { held: false, effects: [] };
    }
    const effects = this.settle(t, ctx);
    const holder = t.places.find((p) => p.floorSince !== null);
    if (holder && holder.seat === seat) {
      /* READ BEFORE ANSWER: the floor was handed with other seats' lines, the seat has not acknowledged the grant, and it was
         never told to wait (a seat refused earlier posts only after its turn line, by protocol). It may be answering from the
         line it was typed together with the others: hold the post ONCE, show the lines, and let the retry through. A claim
         with the grant, a first answer (nothing handed) and the person's lines never hold. */
      if (readGate() && !holder.acked && !holder.waited && holder.handed?.length) {
        holder.acked = true;
        return { held: true, thread, behind: null, answered: holder.handed.slice(0, DELTA_MAX), effects };
      }
      return { held: false, effects };
    }
    let mine = t.places.find((p) => p.seat === seat);
    const had = !!mine;
    if (!mine) {
      mine = { seat, sources: [thread], createdAt: ctx.now, claimed: true, floorSince: null, grant: null, acked: false };
      t.places.push(mine);
    }
    mine.claimed = true;
    if (holder) {
      mine.waited = true;
      return { held: true, thread, behind: ctx.handle(holder.seat), effects };
    }
    if (had && this.newerUnshown(t, mine)) {
      // READ BEFORE POST: another author wrote in this thread since the line this seat is answering and the seat was
      // never handed it (the seats were typed the line together, so nobody waited). Its turn line, with that delta,
      // is what it gets; the post is not written and the seat does not retry.
      const handed = this.settle(t, ctx);
      mine.waited = true;
      return { held: true, thread, behind: this.behindOf(t, seat, ctx), stale: true, effects: [...effects, ...handed] };
    }
    const more = this.settle(t, ctx);
    const got = t.places.find((p) => p.floorSince !== null);
    if (got && got.seat === seat) {
      // its own post is the answer: no turn line to it
      return { held: false, effects: [...effects, ...more.filter((e) => !(e.type === 'floor' && e.seat === seat))] };
    }
    mine.waited = true;
    return { held: true, thread, behind: this.behindOf(t, seat, ctx), effects: [...effects, ...more] };
  }

  /* ----------------------------------------------------------- the claim route ---- */

  claim(seat: string, roomId: string, thread: number, opts: { grant?: string | null; pass?: boolean }, ctx: TurnsCtx): ClaimResult {
    const t = this.ensure(thread, roomId, true, ctx.now);
    if (opts.pass) {
      const i = t.places.findIndex((p) => p.seat === seat);
      if (i >= 0) {
        t.places.splice(i, 1);
      }
      return { ok: true, thread, passed: i >= 0, effects: this.settle(t, ctx) };
    }
    const effects = this.settle(t, ctx);
    if (opts.grant) {
      const p = t.places.find((x) => x.seat === seat && x.floorSince !== null);
      if (!p || p.grant !== opts.grant || p.acked) {
        return { ok: false, error: 'wrong_grant', message: 'that grant is not your current turn in this thread', effects };
      }
      p.acked = true;
      return { ok: true, thread, acknowledged: true, effects };
    }
    if (!t.floor) {
      return { ok: true, thread, state: 'floor', effects };
    }
    let mine = t.places.find((p) => p.seat === seat);
    if (!mine) {
      mine = { seat, sources: [thread], createdAt: ctx.now, claimed: true, floorSince: null, grant: null, acked: false };
      t.places.push(mine);
    }
    mine.claimed = true;
    t.touched = ctx.now;
    const more = this.settle(t, ctx);
    if (mine.floorSince !== null) {
      // the floor arrived in answer to this request: the caller hands the grant back, no turn line
      return { ok: true, thread, state: 'floor', grant: mine.grant ?? undefined, effects: [...effects, ...more.filter((e) => !(e.type === 'floor' && e.seat === seat))] };
    }
    const behind = this.behindOf(t, seat, ctx);
    return { ok: true, thread, state: 'queued', ...(behind ? { behind } : {}), effects: [...effects, ...more] };
  }

  /* -------------------------------------------------------------- the sweep ---- */

  /** Time passes: lapses, skips, floors. Also forgets idle threads. */
  sweep(ctx: TurnsCtx): TurnEffect[] {
    const out: TurnEffect[] = [];
    for (const t of [...this.threads.values()]) {
      out.push(...this.settle(t, ctx));
      if (!t.places.length && ctx.now - t.touched > IDLE_DROP_MS) {
        this.threads.delete(t.id);
      }
    }
    return out;
  }

  /* ----------------------------------------------- the person's floor commands ---- */

  /** `/floor skip @seat`: take every place `seat` holds in this room (the floor it holds, or a queued turn) and
   *  let the next claimed seat have the floor. Returns what was skipped and the effects. */
  skipSeat(roomId: string, seat: string, ctx: TurnsCtx): { skipped: number; effects: TurnEffect[] } {
    return this.release(roomId, (p) => p.seat === seat, ctx);
  }

  /** `/floor take`: end every turn currently held in this room, so the person's next words are not queued
   *  behind a seat that may be stuck; the queue then moves on as after any skip. */
  takeFloor(roomId: string, ctx: TurnsCtx): { skipped: number; effects: TurnEffect[] } {
    return this.release(roomId, (p) => p.floorSince !== null, ctx);
  }

  private release(roomId: string, pick: (p: Place) => boolean, ctx: TurnsCtx): { skipped: number; effects: TurnEffect[] } {
    const effects: TurnEffect[] = [];
    let skipped = 0;
    for (const t of this.threads.values()) {
      if (t.roomId !== roomId || !t.floor) {
        continue;
      }
      for (const p of t.places.filter(pick)) {
        t.places.splice(t.places.indexOf(p), 1);
        skipped++;
        effects.push({ type: 'skip', roomId, thread: t.id, seat: p.seat, sources: [...p.sources], why: 'user' });
      }
      effects.push(...this.settle(t, ctx));
    }
    return { skipped, effects };
  }

  myTurns(seat: string, ctx: TurnsCtx): MyTurn[] {
    const out: MyTurn[] = [];
    for (const t of this.threads.values()) {
      const p = t.places.find((x) => x.seat === seat);
      if (!p || !t.floor) {
        continue;
      }
      if (p.floorSince !== null) {
        out.push({ thread: t.id, lines: [...p.sources], state: 'floor', ...(p.grant ? { grant: p.grant } : {}) });
      } else {
        const behind = this.behindOf(t, seat, ctx);
        out.push({ thread: t.id, lines: [...p.sources], state: 'queued', ...(behind ? { behind } : {}) });
      }
    }
    return out.sort((a, b) => a.thread - b.thread);
  }

  /** The thread a line id belongs to, as far as memory knows (tests, diag). */
  lineThread(id: number): number | null {
    for (const t of this.threads.values()) {
      if (t.id === id || t.lines.some((l) => l.id === id)) {
        return t.id;
      }
    }
    return null;
  }

  diag(): { threads: number; pending: number; places: number } {
    let pending = 0;
    let places = 0;
    for (const t of this.threads.values()) {
      places += t.places.length;
      if (t.places.length) {
        pending++;
      }
    }
    return { threads: this.threads.size, pending, places };
  }

  reset(): void {
    this.threads.clear();
  }

  /* ------------------------------------------------------------ internals ---- */

  /** Bring one thread up to date: skip a holder that timed out or went
   *  offline, then hand the floor to the first claimed place nothing blocks. */
  private settle(t: Thread, ctx: TurnsCtx): TurnEffect[] {
    const out: TurnEffect[] = [];
    if (!t.floor) {
      return out;
    }
    const holder = t.places.find((p) => p.floorSince !== null);
    if (holder) {
      const why = this.whySkip(holder, t.roomId, ctx);
      if (!why) {
        return out;
      }
      t.places.splice(t.places.indexOf(holder), 1);
      out.push({ type: 'skip', roomId: t.roomId, thread: t.id, seat: holder.seat, sources: [...holder.sources], why });
    }
    for (let i = 0; i < t.places.length; ) {
      const p = t.places[i];
      if (!ctx.isLive(p.seat)) {
        t.places.splice(i, 1); // never blocks; lapses at once, silently
        continue;
      }
      if (p.claimed && ctx.blockedReason?.(p.seat) === 'limit') {
        // a rate-limited seat cannot answer: do not hand it the floor and make everyone wait for the clock
        t.places.splice(i, 1);
        out.push({ type: 'skip', roomId: t.roomId, thread: t.id, seat: p.seat, sources: [...p.sources], why: 'limit' });
        continue;
      }
      if (p.claimed) {
        p.floorSince = ctx.now;
        p.grant = this.mint();
        p.acked = false;
        t.opened = true;
        t.closed = false;
        out.push(this.floorEffect(t, p));
        break;
      }
      if (ctx.now - p.createdAt < windowMs()) {
        break; // an earlier-referenced seat that may still claim
      }
      t.places.splice(i, 1); // lapsed, silently
    }
    /* CLOSED (toolkit [ref]): the queue emptied after a floor was handed, by an
       answer, a pass, a skip or a lapse. Once per emptying: a later floor in the
       same thread reopens it and its next emptying closes it again. */
    if (t.opened && !t.closed && !t.places.length) {
      t.closed = true;
      out.push({ type: 'closed', roomId: t.roomId, thread: t.id });
    }
    return out;
  }

  /** Why the floor-holder loses the floor now, or null. Order: its pane is gone; it is stuck on the usage-limit
   *  menu (immediate); the turn clock ran out; or it has been silent past the ack window without acking. */
  private whySkip(holder: Place, roomId: string, ctx: TurnsCtx): SkipWhy | null {
    if (!ctx.isLive(holder.seat)) {
      return 'offline';
    }
    if (ctx.blockedReason?.(holder.seat) === 'limit') {
      return 'limit';
    }
    const since = holder.floorSince as number;
    if (ctx.now - since >= (ctx.turnMsFor?.(roomId) ?? turnMs())) {
      return 'timeout';
    }
    if (!holder.acked && ctx.lastActive) {
      const last = Math.max(since, ctx.lastActive(holder.seat) ?? 0);
      if (ctx.now - last >= ackMs()) {
        return 'unresponsive';
      }
    }
    return null;
  }

  /** Another SEAT's lines newer than the ones a place answers, not yet handed to its seat. The person's newer lines
   *  never stop a post (spec: a post after a newer line still goes through; the person is never the one waited on). */
  private newerUnshown(t: Thread, p: Place): boolean {
    const first = p.sources.length ? Math.min(...p.sources) : t.id;
    return t.lines.some((l) => l.id > first && !p.sources.includes(l.id) && l.author !== p.seat && l.author !== 'user' && l.id > (p.shown ?? 0));
  }

  private floorEffect(t: Thread, p: Place): FloorEffect {
    const first = p.sources.length ? Math.min(...p.sources) : t.id;
    const newer = t.lines.filter((l) => l.id > first && !p.sources.includes(l.id) && l.author !== p.seat);
    p.shown = Math.max(p.shown ?? 0, ...newer.map((l) => l.id)); // the delta (and the count of the rest) is handed with the turn line
    p.handed = newer.filter((l) => l.author !== 'user');
    return {
      type: 'floor',
      roomId: t.roomId,
      thread: t.id,
      seat: p.seat,
      sources: [...p.sources],
      after: t.lastAnswer && t.lastAnswer !== p.seat ? t.lastAnswer : null,
      grant: p.grant as string,
      delta: newer.slice(0, DELTA_MAX),
      more: Math.max(0, newer.length - DELTA_MAX),
    };
  }

  private behindOf(t: Thread, seat: string, ctx: TurnsCtx): string | null {
    const holder = t.places.find((p) => p.floorSince !== null);
    if (holder && holder.seat !== seat) {
      return ctx.handle(holder.seat);
    }
    const ahead = t.places.slice(0, t.places.findIndex((p) => p.seat === seat));
    return ahead.length ? ctx.handle(ahead[0].seat) : null;
  }

  /** At most MAX_PENDING threads with places per room: the oldest go. */
  private cap(roomId: string): void {
    const pending = [...this.threads.values()].filter((t) => t.roomId === roomId && t.places.length).sort((a, b) => a.touched - b.touched || a.id - b.id);
    for (const t of pending.slice(0, Math.max(0, pending.length - MAX_PENDING))) {
      this.threads.delete(t.id);
    }
  }
}

/** The thread a stored line belongs to: its `meta.thread`; else, for a room FACT that announces a turn
 *  (`meta.turn.thread`), the thread the fact is about; else its own id (it opened one, or it was written
 *  with turns off and opens one the moment someone replies). A seat that replies to "@x has the floor on
 *  #N" is answering thread N, not opening a thread named after the fact (the floor-fact reply bug, which
 *  left the holder's place open until the turn clock skipped it as "did not answer in time"). */
export function threadOfMeta(meta: string | null | undefined, id: number): number {
  try {
    const m = meta ? (JSON.parse(meta) as Record<string, unknown>) : null;
    if (typeof m?.thread === 'number' && Number.isInteger(m.thread)) {
      return m.thread;
    }
    const turn = m?.turn as Record<string, unknown> | undefined;
    if (typeof turn?.thread === 'number' && Number.isInteger(turn.thread)) {
      return turn.thread;
    }
    return id;
  } catch {
    return id;
  }
}

/* -------------------------------------------------------------- the words ---- */

const list = (ids: number[]): string => ids.map((i) => `#${i}`).join(', ');

/** The room fact for an effect (author `room`; never carries the grant). */
export function factText(e: TurnEffect, handle: (seat: string) => string): string {
  if (e.type === 'closed') {
    return `the floor on #${e.thread} is closed`;
  }
  if (e.type === 'floor') {
    return `@${handle(e.seat)} has the floor on ${list(e.sources)}${e.after ? ` (after @${handle(e.after)})` : ''}`;
  }
  if (e.why === 'offline') {
    return `@${handle(e.seat)} went offline before answering ${list(e.sources)}`;
  }
  if (e.why === 'limit') {
    return `@${handle(e.seat)} is stopped on a usage limit, so its turn on ${list(e.sources)} was skipped`;
  }
  if (e.why === 'unresponsive') {
    return `@${handle(e.seat)} was silent for ${Math.round(ackMs() / 60_000 * 10) / 10} min after getting the floor on ${list(e.sources)}, so its turn was skipped`;
  }
  if (e.why === 'user') {
    return `@${handle(e.seat)} was skipped by the user on ${list(e.sources)}`;
  }
  return `@${handle(e.seat)} did not answer in time on ${list(e.sources)}`;
}

/** The turn line typed to the floor-holder: grant, thread, sources, the delta,
 *  where to read the rest, and how to pass. One line (the typer flattens). */
/** The refusal a floor-holder gets ONCE when it posts without having read the lines handed with its turn. */
export function answeredText(lines: ThreadLine[]): string {
  const shown = lines.map((l) => `#${l.id} ${l.who}: "${l.excerpt}"`).join(' | ');
  const first = Math.min(...lines.map((l) => l.id));
  return `someone already answered in this thread: ${shown}. Read ${lines.length === 1 ? 'it' : 'them'} (room_read since=${first - 1}), then post again with only what is new, or room_claim with pass if you have nothing to add. Your turn is still yours; this check fires once.`;
}

export function turnLineText(e: FloorEffect): string {
  const first = e.sources.length ? Math.min(...e.sources) : e.thread;
  const parts = [`Your turn in thread #${e.thread}: you are answering ${list(e.sources)}.`];
  if (e.delta.length) {
    const lines = e.delta.map((l) => `#${l.id} ${l.who}: "${l.excerpt}"`).join(' | ');
    parts.push(`Newer in this thread since ${list([first])}: ${lines}${e.more ? ` | ... ${e.more} more` : ''}.`);
  } else {
    parts.push('Nothing newer in this thread.');
  }
  parts.push(`Read the full text first: room_read since=${first - 1} (the whole thread starts at #${e.thread}).`);
  const seatLines = e.delta.filter((l) => l.author !== 'user');
  if (seatLines.length) {
    const last = seatLines[seatLines.length - 1];
    parts.push(`${last.who} already answered (#${last.id}). Reply to #${last.id}, add only what is new and do not restate it; if you agree and have nothing to add, room_claim with pass.`);
  } else {
    parts.push('Reply to the line you are answering; if you have nothing to add, room_claim with pass.');
  }
  parts.push(`grant: ${e.grant}`);
  return parts.join(' ');
}

/** The engine's one instance. */
export const turns = new ReplyTurns();
