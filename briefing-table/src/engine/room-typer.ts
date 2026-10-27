/* ============================================================================
 * ROOM TYPER — "agents hear the room", INTERIM (W3-interim, ticket).
 *
 * Owner's ruling, 2026-09-24: until a push mechanism (Claude Code channels /
 * hooks, W3 proper = T7) exists, a room line entry delivered to a seat whose
 * occupant is a live claude-code pane is ALSO TYPED into that pane's pty, as
 * one framed line plus Enter. This SUPERSEDES, for rooms only, the earlier
 * "a room: channel never types" rule (the design notes §3). The badge
 * delivery (fabric.deliverToPane) is unchanged and still happens first.
 *
 * WHY IT IS SAFE TO TYPE, i.e. the guards (ALL must hold, else the line waits
 * in a per-pane FIFO and is retried on the pane's next transition to idle):
 *   a. the pane is live, has a resident pty, and its vendor is claude-code
 *      (typing into a shell would RUN the text; other vendors are badge-only);
 *   b. activity state is `idle` — not streaming, not waiting (permission
 *      prompts and questions), and not busy (a turn or an in-turn dialog: an
 *      injected Enter would ANSWER a dialog, whose default is Yes);
 *   c. NO UNSENT DRAFT (the design notes rule 1: never seize an
 *      input box that holds a draft) — activity.ts's classifier, which ignores
 *      focus and mouse reports and only clears on a SUBMITTING Enter;
 *   d. SETTLED: at least SETTLE_MS since the pane's last content output, so we
 *      never race a repaint;
 *   e. ONE DELIVERY AT A TIME: after an inject, nothing more is typed until
 *      the pane has been idle again (the typed line starts a turn; its end is
 *      idle). A DELIVERY is not always one LINE (vk held-batch, Owner
 *      2026-09-29): "3 held messages ... one gets sent, agent replies, sees
 *      next one, replies ... we need to be more efficient about this." When a
 *      flush finds MORE THAN ONE queued line ready for the same room (or the
 *      same fabric queue) at once, they are typed as ONE combined message —
 *      one turn, not N — headered `[batch · N … while you were busy]` with
 *      each line marked `[k of N]`, oldest first (packBatch/composeBatch).
 *      Lines for a DIFFERENT room never share a delivery (batching stops at
 *      the first item whose roomId differs) and an oversize batch splits at
 *      LINE boundaries (never truncates one) into as few deliveries as fit
 *      under TYPE_TEXT_MAX. A single held line is unchanged: no header.
 *      A QUEUEING CLI (Codex, codexOneQueued on) batches across rooms and fabric,
 *      labels every item (thread · @sender · id · time · reply needed|fyi), puts
 *      the person's THREADS first without reordering inside a thread, holds
 *      until the turn its queued delivery waited behind COMPLETES, and types a
 *      control line (stop, the answer to its own ask) into the running turn with
 *      its steer key (codexSteerControl). Codex review 2026-10-07.
 *   f. PAST STARTUP (S0, startup-gate.ts): a freshly spawned or restored claude
 *      pane may be sitting on a startup prompt (folder trust, the dev-channels
 *      warning, the old-session dialog) or on a bare shell, all of which read
 *      as `idle`. Held (`startup`) until positive evidence — a turn hook, the
 *      REPL's composer after the last prompt, or a human typing in the pane.
 *   g. CLAUDE OWNS THE TERMINAL (S0 guard 9, F21): on the server a claude pane is
 *      `claude` typed into `bash -il`. If claude exited or was suspended, BASH
 *      owns the terminal, and a typed line runs there — `$(…)` and backticks
 *      in its body execute as svc-ops. Held (`no-claude`) unless an
 *      interactive claude carrying exactly this paneid owns the tty, read from
 *      /proc UNCACHED immediately before each write (the probe is handed in;
 *      proc-classifier.ts). Not overridable. Could not tell (not the server,
 *      EACCES) delivers as today.
 *   h. NOTHING ON SCREEN NEEDS THE HUMAN ([ticket], prompt-block.ts): a
 *      /login screen, a permission dialog or a question picker. Held
 *      (`needs-you`, with `held.blocked` naming which) until the screen stops
 *      showing it. deliver-held never waives it for claude: a typed line +
 *      Enter would ANSWER the prompt.
 *
 * THE `[room …]` PREFIX IS LOAD-BEARING, same as voice's `[voice · …]`: the
 * line always starts with `[`, so a body can never begin a `/` (slash command)
 * or `!` (shell escape) line in Claude Code, whatever a member wrote.
 *
 * IN MEMORY, COUNTS ONLY. The queue holds text (it must, to type it later),
 * but no log line and no diag field ever carries message content.
 * Kill switch: HARBOR_WB_ROOM_TYPE=0 (default on).
 * ========================================================================== */

import { engineWrite } from './pty-write.ts';
import * as sessions from './sessions.ts';
import * as connectorBridge from './connector-bridge.ts';
import * as activity from './activity.ts';
import * as btTools from './bt-tools.ts';
import { table } from '../table/endpoint.ts';
import * as reads from './room-reads.ts';
import * as roomBus from './room-bus.ts';
import * as startup from './startup-gate.ts';
import * as geminiGate from './gemini-gate.ts';
import * as promptBlock from './prompt-block.ts';
import type { ClaudeRead } from './proc-classifier.ts';
import { vendorFor, type TypingSpec } from './vendors/index.ts';
import { agentComms } from './agent-comms.ts';

export const TYPE_TEXT_MAX = 1500;
export const QUEUE_MAX = 20;
/* Vendors whose panes get room lines TYPED (ticket: gemini-cli joins
   claude-code — see claudeGuardFields/geminiGuardFields below for how each
   vendor answers blockReason's four guard fields; every other vendor stays
   badge-only, same as before). */
const TYPE_VENDORS = new Set(['claude-code', 'gemini-cli', 'codex-cli']);
/* If the idle that should follow an inject never comes (tiny turn, lost
   transition), stop waiting after this long — provided the pane is idle now. */
const AWAIT_IDLE_FALLBACK_MS = 60_000;

export const enabled = (): boolean => process.env.HARBOR_WB_ROOM_TYPE !== '0';
const settleMs = (): number => {
  const raw = process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS;
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : 1500;
};
const enterDelayMs = (): number => Number(process.env.HARBOR_WB_VOICE_ENTER_MS) || 150;

/* ---- pure: framing ----------------------------------------------------------- */

/* Any C0 control or DEL. CR/LF would submit early, ESC would interrupt a turn,
   BS/Ctrl-U would edit the line — none belongs inside one typed line. */
const CONTROLS = /[\x00-\x1f\x7f]+/g;
const BACKSLASH = String.fromCharCode(92);

function flat(s: string): string {
  return s.replace(CONTROLS, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * The one line typed into a member's composer:
 *   `[room <room name> · @<author> · #<line id>] <body> (reply in the room: room_post reply_to <line id>…)`
 * (the id is left out only when there is none, e.g. a test's bare frame).
 * newlines flattened, capped at `max` with a note saying how much was cut.
 * NEVER ends in a backslash: in Claude Code a backslash before Enter makes the
 * Enter a NEWLINE, so the line would sit unsent in the composer — a draft the
 * engine itself planted.
 */
/* THE REPLY HINT (Owner 2026-10-05: agents answered room lines in their terminal, where nobody
   sees it). A typed room line looks like any prompt, so the frame says where the answer goes,
   on every line: agents seated before the room welcome existed never got that instruction. */
export const PEER_NOTE = 'message from a peer agent, not your user';

/* DOORBELL + PULL (security review R1/M7/M8, W1; design KB design-notes-id). In doorbell delivery the engine types NO room text, peer or person: it types ONE fixed, engine-authored ring that names a room by its full UUID and a
   line number and nothing else, and the agent PULLS the lines with its own token (room_read), where each line carries the engine's own record of who posted it. A busy seat's rings coalesce: every line queued for the
   seat goes out as one ring per room, the newest line number and a count. Hosted engines use it always; HARBOR_WB_DELIVERY=doorbell turns it on elsewhere. */
/* HARBOR_WB_DELIVERY=typed forces the old typed delivery even when hosted (the T1 proof's RED run on the same tree, with the trace seam); never set it on a real hosted server. */
export const doorbellOn = (): boolean => process.env.HARBOR_WB_DELIVERY === 'typed' ? false : process.env.HARBOR_WB_DELIVERY === 'doorbell' || process.env.HARBOR_WB_HOSTED === '1';
const ROOM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only engine ids and integer cursors enter the ring, never names or message text.
 * The cursor precedes the earliest queued line: room_read's since is exclusive. */
export function ringFor(entries: ReadonlyArray<{ roomId: string; entryId: number }>): string {
  const byRoom = new Map<string, { n: number; first: number; last: number }>();
  for (const e of entries) {
    if (!ROOM_UUID.test(e.roomId) || !Number.isSafeInteger(e.entryId) || e.entryId < 1) continue;
    const cur = byRoom.get(e.roomId) ?? { n: 0, first: e.entryId, last: e.entryId };
    cur.n += 1;
    cur.first = Math.min(cur.first, e.entryId);
    cur.last = Math.max(cur.last, e.entryId);
    byRoom.set(e.roomId, cur);
  }
  const parts = [...byRoom].slice(0, 4).map(([room, v]) => `room_read ${JSON.stringify({ room, since: v.first - 1 })} - ${v.n > 1 ? `${v.n} new lines, latest` : 'new line'} #${v.last}`);
  return parts.length ? `[${parts.join(' | ')} - if replying, use room_post in that room]` : '[room notification - read with room_list_mine]';
}
export const REPLY_HINT = ' (reply in the room: room_post)';
/* A PERSON'S line asks the agent to confirm to them (Owner 2026-10-06: a lead acted on his
   ask by addressing another seat, and his "to me" view showed nothing, so it read as no
   reply). Only on lines the user wrote (author 'user', the same test channels.routeDecision
   uses), so agent-to-agent traffic does not grow by a word. */
export const USER_REPLY_HINT = ' (reply in the room: room_post; if you act on this through someone else, tell @user in a line of your own)';
/* LEAD RULES [chatter p2] (Owner 2026-10-06: a lead re-told him what a worker had just
   posted to him, and relayed each of his lines then confirmed "passed to ..."). On the
   person's lines typed to the room's LEAD only, after the reply hint; the same words
   ride the lead's welcome (seat-welcome.ts). The engine also holds the echo itself.
   For the lead it REPLACES USER_REPLY_HINT's "tell @user" clause, which asks for exactly
   the 'passed to' line this rule forbids. */
export const LEAD_RULES = "relay this once to whoever acts on it; no 'passed to' confirmation; don't re-tell the person what a worker already posted to them";
export const LEAD_HINT = ` (lead: ${LEAD_RULES})`;
/* [reply route] (Owner 2026-10-08: a Codex seat answered his line without @user or
   reply_to, so the answer went to the lead and never reached his "to me" view). The
   frame carries the line's id, and the hint names the reply's destination by it. The
   engine also inherits it (rooms.ts inheritedReply); the hint makes it explicit. */
function replyHint(author: string, lead: boolean, id: number): string {
  const base = author === 'user' ? (lead ? REPLY_HINT + LEAD_HINT : USER_REPLY_HINT) : REPLY_HINT;
  return id > 0 ? base.replace('room_post', `room_post reply_to ${id}`) : base;
}
export function frame(roomName: string, author: string, body: string, max = TYPE_TEXT_MAX, lead = false, id = 0): string {
  /* M7: a line from anyone but the person says it is a peer's, so it cannot read as the user's own instruction */
  const peer = author === 'user' ? '' : ` · ${PEER_NOTE}`;
  const head = `[room ${flat(roomName) || 'room'} · @${flat(author) || 'unknown'}${id > 0 ? ` · #${id}` : ''}${peer}] ${flat(body)}`;
  const hint = replyHint(author, lead, id);
  let line = head + hint;
  if (line.length > max) {
    // Cut the body, then the note, then the hint: the hint is always whole.
    const note = ` … [truncated, ${line.length} chars — read the room line]`;
    line = head.slice(0, Math.max(0, max - note.length - hint.length)).trimEnd() + note + hint;
  }
  if (line.endsWith(BACKSLASH)) {
    line += ' ';
  }
  return line;
}

/* ---- pure: the guard ----------------------------------------------------------- */

export type TypeBlock =
  | 'off'
  | 'not-live'
  | 'vendor'
  | 'no-claude'
  | 'connector-owned'
  | 'startup'
  | 'waiting-for-tools'
  | 'needs-you'
  | 'not-idle'
  | 'busy'
  | 'draft'
  | 'settling'
  | 'awaiting-idle'
  | 'one-queued';

export interface GuardInput {
  enabled: boolean;
  /** [connector] a Codex connector binding owns this pane: the connector is its ONLY writer. */
  connectorOwned?: boolean;
  /** Resident pty exists and is live. */
  live: boolean;
  vendor: string | null;
  /** Guard 9: does an interactive claude with exactly this paneid own the
   *  terminal? false holds; true and null (could not tell) deliver. */
  claude: boolean | null;
  /** startup-gate.isBlocked: no positive evidence yet that claude is past its
   *  startup prompts (or has even started). */
  startup: boolean;
  /** Hosted Codex has not enumerated tools and its bounded launch wait is live. */
  waitingForTools?: boolean;
  /** [ticket] prompt-block: the screen shows a prompt only a human answers
   *  (login / permission / question). A typed line + Enter would ANSWER it
   *  (a permission dialog's default is Yes), so it holds — `needs-you`. */
  blocked?: string | null;
  /** activity.get(paneid); null when the machine has never seen the pane. */
  state: string | null;
  /** activity.isBusy: a turn is running or an in-turn dialog is up. */
  busy: boolean;
  /** activity.draftState: 'draft' blocks; 'clean' / 'unobserved' do not. */
  draft: 'clean' | 'draft' | 'unobserved';
  now: number;
  lastOutputAt: number | undefined;
  settleMs: number;
  /** The previous inject has not yet been followed by an idle transition. */
  awaitingIdle: boolean;
  /** [one queued] a queueing CLI already holds one engine delivery in its own queue. */
  oneQueued?: boolean;
}

/** Why a queued line cannot be typed into this pane right now, or null. */
export function blockReason(g: GuardInput): TypeBlock | null {
  if (!g.enabled) return 'off';
  if (!g.live) return 'not-live';
  if (g.connectorOwned) return 'connector-owned';
  if (!g.vendor || !TYPE_VENDORS.has(g.vendor)) return 'vendor';
  if (g.claude === false) return 'no-claude';
  if (g.startup) return 'startup';
  if (g.waitingForTools) return 'waiting-for-tools';
  if (g.blocked) return 'needs-you';
  if (g.awaitingIdle) return 'awaiting-idle';
  if (g.oneQueued) return 'one-queued';
  /* `background` = a turn-aware pane with NO turn running whose screen is
     still moving (Claude Code redrawing its background-agents line after
     Stop). The REPL is at its input box, so it is as typeable as idle, and
     its redraws never settle, so the settle wait is skipped there (Owner
     2026-09-27: lines held "busy" for as long as a lead's sub-agents ran). */
  /* `streaming` (a reply running) is typeable too (Owner 2026-09-27: "we do
     that in cli today and agents adjust"): Claude Code queues a message typed
     mid-turn and reads it at its next step. A dialog inside the turn is still
     `busy`, a question is `waiting`, and a draft still holds. Per-brand rules
     come later; only claude-code is typed at all (TYPE_VENDORS). */
  if (g.state !== 'idle' && g.state !== 'background' && g.state !== 'streaming') return 'not-idle';
  if (g.busy) return 'busy';
  if (g.draft === 'draft') return 'draft';
  if (g.state === 'idle' && g.lastOutputAt !== undefined && g.now - g.lastOutputAt < g.settleMs) return 'settling';
  return null;
}

/* ---- pure: batching (held-batch, Owner 2026-09-29) -------------------------------- */

/** What a batched delivery's items are called in its header — matches the
 *  two shapes a pane's queue ever holds (room-typer.ts only ever queues one
 *  or the other under one roomId at a time: room lines, or `roomId==='fabric'`
 *  envelopes). Cosmetic only; never read back. */
function batchNoun(roomId: string): string {
  return roomId === MIXED ? 'message' : roomId === 'fabric' ? 'fabric message' : roomId === 'chat' ? 'chat message' : 'room line';
}

/** A queueing CLI's batch spans rooms and fabric: its header says "messages". */
const MIXED = 'mixed';

/** One delivery's text for `chunkTexts` (already-framed lines, oldest first),
 *  numbered `startIndex..startIndex+chunkTexts.length-1` of `total` — `total`
 *  is the WHOLE run this delivery is (part of), so a split batch's later
 *  chunk still says "of 3" rather than restarting at "of 2". Never called for
 *  a run of 1 (that stays today's bare `chunkTexts[0]`, no header) — the
 *  header always starts with `[`, same invariant as a single framed line, so
 *  nothing here can be mistaken for a `/` or `!` line by Claude Code. */
export function composeBatch(chunkTexts: string[], startIndex: number, total: number, roomId: string, labels?: readonly string[]): string {
  const header = `[batch · ${total} ${batchNoun(roomId)}s while you were busy]`;
  /* [labelled batch] a queueing CLI's items carry their own label inside the marker:
     `[k of N · <thread> · @<sender> · <id> · HH:MMZ · reply needed]` (labelOf). */
  const body = chunkTexts.map((t, i) => `[${startIndex + i} of ${total}${labels?.[i] ? ` · ${labels[i]}` : ''}] ${t}`).join('  ');
  return `${header} ${body}`;
}

/**
 * Partition one run of already-framed texts (same room, oldest first) into
 * AS FEW deliveries as fit under `max` once composed — greedy: keep adding to
 * the current delivery while it still fits, else close it and start the next.
 * That is optimal for an ORDER-PRESERVING contiguous split (never reorders,
 * never splits one line). A line that cannot fit even alone (composed with
 * its own header) still goes out alone rather than being truncated or
 * dropped — the caller's TYPE_TEXT_MAX cap on each individual line already
 * makes this rare (header overhead only, a handful of chars).
 */
export function packBatch(texts: string[], total: number, roomId: string, max: number = TYPE_TEXT_MAX, labels?: readonly string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let startIndex = 1;
  for (const t of texts) {
    const next = [...cur, t];
    const lab = labels ? labels.slice(startIndex - 1, startIndex - 1 + next.length) : undefined;
    if (cur.length === 0 || composeBatch(next, startIndex, total, roomId, lab).length <= max) {
      cur = next;
    } else {
      out.push(cur);
      startIndex += cur.length;
      cur = [t];
    }
  }
  if (cur.length) {
    out.push(cur);
  }
  return out;
}

/* ---- the per-pane queue ---------------------------------------------------------- */

/** What a queued item says about itself, set at ENQUEUE (never parsed back out
 *  of the framed text): the label of a queueing CLI's batch (labelOf), the
 *  per-thread order (orderQueued) and the steer path (`control`). All optional:
 *  an already-composed text (fabric-held, the welcome) carries none, and a row
 *  persisted by an older engine reads back without them. */
export interface ItemMeta {
  /** Sender: a room line's author handle, a fabric envelope's `from`. */
  from?: string;
  /** `line <n>` for a room line, `id:<envelope id>` for fabric (full, never shortened). */
  msgId?: string;
  /** Thread label, also the grouping key inside a run: `room <name>`, `t:<thread>`, `chat`. */
  thread?: string;
  /** When it was written (ms). */
  ts?: number;
  /** true = addressed to this recipient / a fabric ask; false = room-wide or a notice. */
  replyNeeded?: boolean;
  /** [steer] a stop from the person or a lead, or the answer to the pane's own open ask. */
  control?: boolean;
  /** [digest] addressed to THIS pane (named / lead default / a DM / chat) as opposed to
   *  room-wide (`@room`) or a group/all broadcast. Unset = no metadata: never digested. */
  addressed?: boolean;
  /** [digest] the first ~60 chars of the words (never the frame), and the room's name. */
  gist?: string;
  room?: string;
  /** [digest] a digest item: the queued items it stands for (read state on inject / drop). */
  covers?: Array<{ roomId: string; entryId: number }>;
  /** [drop note] the lines this queue threw away at its cap, per source: the note tells the
   *  pane what it never saw and where to read it, so an overflow is no longer silent. */
  dropped?: Array<{ roomId: string; room: string; first: number; n: number }>;
}
interface Item extends ItemMeta {
  roomId: string;
  entryId: number;
  text: string;
}

const hhmm = (ts: number): string => new Date(ts).toISOString().slice(11, 16) + 'Z';

/** One item's label inside a queueing CLI's batch marker (FIX 1, Codex review
 *  2026-10-07): thread · @sender · id · time · reply needed | fyi. Empty when
 *  the item carries no metadata (an already-composed text). */
export function labelOf(it: ItemMeta): string {
  const parts: string[] = [];
  if (it.thread) parts.push(flat(it.thread));
  if (it.from) parts.push(`@${flat(it.from)}`);
  if (it.msgId) parts.push(flat(it.msgId));
  if (typeof it.ts === 'number' && Number.isFinite(it.ts)) parts.push(hhmm(it.ts));
  if (it.replyNeeded === true) parts.push('reply needed');
  else if (it.replyNeeded === false) parts.push('fyi');
  return parts.join(' · ');
}

const isPersonItem = (it: Item): boolean => it.from === 'user' || fromPerson(it.text);

/**
 * A queueing CLI's delivery order (FIX 1): the person's words first, but a
 * THREAD is never reordered — an older instruction never lands after a newer
 * one from the same thread. So whole threads move: every thread holding one of
 * the person's items goes first (in order of first arrival), then the rest
 * (same), each thread's items in arrival order. Items with no thread group by
 * roomId alone. Pure and stable.
 */
export function orderQueued<T extends Item>(items: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = `${it.roomId}|${it.roomId === 'fabric' ? (it.thread ?? '') : ''}`;
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.some(isPersonItem)), ...all.filter((g) => !g.some(isPersonItem))].flat();
}

/** [steer] A stop: the first word, after any leading @mentions, is stop / halt /
 *  cancel / pause (case and trailing punctuation ignored). Conservative on
 *  purpose: "please stop" or "can you stop" is NOT one. */
const STOP_WORDS = new Set(['stop', 'halt', 'cancel', 'pause']);
export function isStopLine(body: string | null | undefined): boolean {
  const words = flat(body ?? '').split(' ');
  let i = 0;
  while (i < words.length && words[i].startsWith('@')) i++;
  return STOP_WORDS.has((words[i] ?? '').toLowerCase().replace(/[^a-z]+$/, ''));
}

/* [steer] OWN OPEN ASKS: a pane that sent a fabric `ask` (index.ts fabricSendAs, on a
   2xx) is waiting on its answer, so the first envelope back on that thread (or naming
   the ask's id as its thread) is a control line. One-shot, 2 h, at most 50 per pane,
   in memory only (a restart forgets them: the answer then queues like any message). */
const OWN_ASK_TTL_MS = 2 * 60 * 60_000;
const ownAsks = new Map<string, Array<{ keys: Set<string>; until: number }>>();
export function noteOwnAsk(paneid: string, keys: Array<string | null | undefined>, now: number = Date.now()): void {
  const ks = new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0));
  if (!ks.size) return;
  const list = (ownAsks.get(paneid) ?? []).filter((a) => a.until > now);
  list.push({ keys: ks, until: now + OWN_ASK_TTL_MS });
  ownAsks.set(paneid, list.slice(-50));
}
function answersOwnAsk(paneid: string, thread: string | undefined, now: number = Date.now()): boolean {
  const list = ownAsks.get(paneid);
  if (!list || !thread) return false;
  const i = list.findIndex((a) => a.until > now && a.keys.has(thread));
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/* ---- [digest] #5 BACKLOG DIGEST (Owner 2026-10-07, room interface/5772) --------------
   When more than agentComms().digestOver lines ADDRESSED to a pane wait at delivery time,
   the pane gets ONE digest (who / where / id / a gist, and where to read them in full)
   instead of the whole batch. The person's lines, control lines and anything without
   metadata (an already-composed text, an earlier digest) are NEVER digested: they still
   go out in full, the person's first. Room-wide and broadcast lines (addressed false)
   ride along as one "and M room-wide lines" tail. Every vendor the typer types into. */

const GIST_MAX = 60;
export const DIGEST_ROOM = 'digest';

/** The first ~60 characters of a message's words, flattened. */
export function gistOf(body: string | null | undefined): string {
  const f = flat(body ?? '');
  return f.length > GIST_MAX ? `${f.slice(0, GIST_MAX - 1).trimEnd()}…` : f;
}

export interface DigestPlan<T> {
  full: T[];
  digested: T[];
  fyi: T[];
}
/** Split a queue for a digest, or null when no digest is due (`over` 0 = off). */
export function planDigest<T extends Item>(items: readonly T[], over: number): DigestPlan<T> | null {
  if (!Number.isInteger(over) || over < 1) {
    return null;
  }
  const full: T[] = [];
  const digested: T[] = [];
  const fyi: T[] = [];
  for (const it of items) {
    if (it.control === true || isPersonItem(it) || it.addressed === undefined) full.push(it);
    else if (it.addressed) digested.push(it);
    else fyi.push(it);
  }
  return digested.length > over ? { full, digested, fyi } : null;
}

/**
 * The one digest line:
 *   [digest · N messages for you since HH:MMZ · K need a reply] (1) <thread> · @<sender> · <id> — <gist>  (2) …
 *   · and M room-wide lines · Read them in full: room_read(room: "<name>", since: <id>) · fabric_inbox ids: …
 * `since` is one BEFORE the first digested line (room_read's since is exclusive).
 * Fits `max`: items that do not fit are counted ("… and X more"), the pointers never cut.
 */
export function composeDigest(digested: readonly Item[], fyi: readonly Item[], max: number = TYPE_TEXT_MAX): string {
  const k = digested.filter((it) => it.replyNeeded === true).length;
  const tss = digested.map((it) => it.ts).filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  const head = `[digest · ${digested.length} message${digested.length === 1 ? '' : 's'} for you${tss.length ? ` since ${hhmm(Math.min(...tss))}` : ''} · ${k} need${k === 1 ? 's' : ''} a reply]`;
  const lines = digested.map((it, i) => {
    const who = [it.thread, it.from ? `@${it.from}` : '', it.msgId].filter(Boolean).map((x) => flat(String(x))).join(' · ');
    return `(${i + 1}) ${who} — ${it.gist ?? ''}`.trimEnd();
  });
  /* where to read them in full: per room, from the first line; fabric ids, full */
  const rooms = new Map<string, { name: string; first: number }>();
  const ids: string[] = [];
  for (const it of [...digested, ...fyi]) {
    if (it.roomId === 'fabric') {
      if (it.msgId?.startsWith('id:')) ids.push(it.msgId.slice(3));
    } else if (it.roomId !== 'chat' && it.entryId > 0) {
      const r = rooms.get(it.roomId);
      if (!r || it.entryId < r.first) rooms.set(it.roomId, { name: it.room ?? it.roomId, first: it.entryId });
    }
  }
  const ptr = [
    ...[...rooms.values()].map((r) => `room_read(room: "${flat(r.name)}", since: ${r.first - 1})`),
    ...(ids.length ? [`fabric_inbox ids: ${ids.map(flat).join(', ')}`] : []),
  ];
  const tail =
    (fyi.length ? ` · and ${fyi.length} room-wide line${fyi.length === 1 ? '' : 's'}` : '') + (ptr.length ? ` · Read them in full: ${ptr.join(' · ')}` : '');
  let body = '';
  let shown = 0;
  for (const l of lines) {
    const more = digested.length - shown - 1;
    const next = `${body}  ${l}`;
    const room = max - head.length - tail.length - (more > 0 ? ` … and ${more} more`.length : 0);
    if (next.length > room && shown > 0) break;
    body = next;
    shown++;
  }
  const rest = digested.length - shown;
  let line = `${head}${body}${rest > 0 ? ` … and ${rest} more` : ''}${tail}`;
  if (line.length > max) {
    line = `${line.slice(0, max - 1).trimEnd()}…`; // only a pathological pointer list gets here
  }
  return line.endsWith(BACKSLASH) ? `${line} ` : line;
}

/** The one note a pane gets in place of lines its queue dropped (cap overflow). */
export function composeDropNote(dropped: NonNullable<ItemMeta['dropped']>): string {
  const total = dropped.reduce((a, d) => a + d.n, 0);
  const ptr = dropped.map((d) => (d.roomId === 'chat' || d.roomId === 'fabric' ? d.room : `room_read(room: "${flat(d.room)}", since: ${d.first - 1})`));
  return `[queue overflow · ${total} earlier line${total === 1 ? ' was' : 's were'} dropped before you saw ${total === 1 ? 'it' : 'them'} · Read them: ${ptr.join(' · ')}]`;
}

/** Replace a due backlog in `items` with ONE digest item (after the full ones). */
function digestQueue(paneid: string, items: Item[]): Item[] | null {
  const plan = planDigest(items, agentComms().digestOver);
  if (!plan) {
    return null;
  }
  const text = composeDigest(plan.digested, plan.fyi);
  const digest: Item = {
    roomId: DIGEST_ROOM,
    entryId: 0,
    text,
    covers: [...plan.digested, ...plan.fyi].flatMap(coversOf),
  };
  log(`room-type: ${paneid} DIGEST of ${plan.digested.length} addressed + ${plan.fyi.length} room-wide line(s); ${plan.full.length} in full`);
  return [...orderQueued(plan.full), digest];
}

/** The queued entries an item stands for (a digest: everything it covers). */
function coversOf(it: Item): Array<{ roomId: string; entryId: number }> {
  return it.covers ?? [{ roomId: it.roomId, entryId: it.entryId }];
}
const isRoomEntry = (c: { roomId: string }): boolean => c.roomId !== 'fabric' && c.roomId !== 'chat' && c.roomId !== DIGEST_ROOM;

interface PaneQueue {
  items: Item[];
  awaitingIdle: boolean;
  injectedAt: number;
  /** Typing-spec vendors: hook-counted turns when the last line went in, and
   *  whether the one extra Enter has been spent on it. */
  turnsAtInject: number;
  enterRetried: boolean;
  lastResult: string | null;
  lastAt: number | null;
  injected: number;
  dropped: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the head of the queue started being held (null = nothing held). */
  heldSince: number | null;
  /** A queueing CLI: the previous delivery's submit key is not in yet until this time —
   *  typing again before it would paste onto the composer and merge the two lines. */
  typingUntil: number;
  /** [one queued] a queueing CLI: when the engine last left a delivery in its queue (0 = none
   *  outstanding), and the hook-counted COMPLETED turns then (activity.doneCount). Nothing more
   *  is typed until that one is taken: the turn it waited behind has finished. */
  queuedAt: number;
  queuedDone: number;
}
const queues = new Map<string, PaneQueue>();
const vendorLogged = new Set<string>();

let log: (line: string) => void = () => {};
export function setLog(fn: (line: string) => void): void {
  log = fn;
  reads.setLog(fn);
  startup.setLog(fn);
}

function q(paneid: string): PaneQueue {
  let p = queues.get(paneid);
  if (!p) {
    p = { items: [], awaitingIdle: false, injectedAt: 0, turnsAtInject: 0, enterRetried: false, lastResult: null, lastAt: null, injected: 0, dropped: 0, timer: null, heldSince: null, typingUntil: 0, queuedAt: 0, queuedDone: 0 };
    queues.set(paneid, p);
  }
  return p;
}

function vendorOf(paneid: string): string | null {
  return table.get(paneid)?.vendor || null;
}

/* PERSISTED QUEUE (night test 2026-10-06; store.ts typer_state). Written
   through on every change to a pane's items, read back when the pane is
   adopted after a restart (restorePane). Never fatal: a write that fails
   leaves the in-memory queue exactly as it was. */
function persist(paneid: string): void {
  try {
    const items = queues.get(paneid)?.items ?? [];
    table.setTyperItems(paneid, items.length ? JSON.stringify(items) : null);
  } catch (e) {
    log(`room-type: persist failed for ${paneid}: ${(e as Error).message}`);
  }
}
activity.onDraftFlag((paneid, dirty) => {
  try {
    table.setTyperDraft(paneid, dirty);
  } catch (e) {
    log(`room-type: draft flag persist failed for ${paneid}: ${(e as Error).message}`);
  }
});

/** A pane ADOPTED after an engine restart: put back what this engine held for
 *  it — the draft flag first (so nothing is typed onto a box that held text),
 *  then every untyped line, oldest first, through the normal guarded path.
 *  The broker kept the pty, so the box and the conversation are as they were. */
export function restorePane(paneid: string): number {
  let row: ReturnType<typeof table.getTyperState>;
  try {
    row = table.getTyperState(paneid);
  } catch {
    return 0;
  }
  if (!row) {
    return 0;
  }
  if (row.draft) {
    activity.markUnknownDraft(paneid);
  }
  let items: Item[] = [];
  try {
    const parsed = row.items ? JSON.parse(row.items) : [];
    items = Array.isArray(parsed)
      ? parsed.filter((it) => it && typeof it.roomId === 'string' && typeof it.entryId === 'number' && typeof it.text === 'string')
      : [];
  } catch {
    items = [];
  }
  if (queues.get(paneid)?.items.length) {
    return 0; // something already queued in this process: it was persisted with it
  }
  table.setTyperItems(paneid, null);
  if (items.length) {
    /* A freshly adopted pane reads `idle` whatever it is doing: the turn it
       was in when the engine died is invisible to this process. So the head
       waits like the line after an inject — for a real idle transition, or
       the AWAIT_IDLE_FALLBACK_MS fallback on a pane that really is idle (live
       test 2026-10-06: a restored line was typed into a Codex turn mid-sleep). */
    const p = q(paneid);
    p.awaitingIdle = true;
    p.injectedAt = Date.now();
    /* -1, not the current count: no line of OURS started the turn being
       waited out, so no new turn will follow it. The next idle transition (the
       Stop that ends that turn) releases the head even once hooks are proven —
       with the count, a strict pane waited forever (live test r13). */
    p.turnsAtInject = -1;
  }
  if (items.length) {
    /* All at once, then ONE flush, so the restored lines batch like any held run would. */
    const q2 = q(paneid);
    q2.items.push(...items);
    persist(paneid);
    try {
      flush(paneid);
    } catch (e) {
      log(`room-type: flush threw for ${paneid}: ${(e as Error).message}`);
    }
  }
  if (items.length || row.draft) {
    log(`room-type: ${paneid} restored after restart: ${items.length} untyped line(s)${row.draft ? ', box last seen holding a draft (held until it clears)' : ''}`);
  }
  return items.length;
}

/** Boot: forget persisted state for panes that are no longer live. */
export function sweepPersisted(isLive: (paneid: string) => boolean): void {
  try {
    for (const r of table.listTyperState()) {
      if (!isLive(r.paneid)) {
        table.dropTyperState(r.paneid);
      }
    }
  } catch (e) {
    log(`room-type: persisted sweep failed: ${(e as Error).message}`);
  }
}

/* Guard 9's /proc read, handed in by the server (proc-classifier.ts plus "does
   this pane's pty run on this host"), so this module imports no /proc code.
   `cached` = the classifier's 2 s cache (display); false = a fresh read. */
let claudeProbe: (paneid: string, cached: boolean) => ClaudeRead = () => null;
export function setClaudeProbe(fn: (paneid: string, cached: boolean) => ClaudeRead): void {
  claudeProbe = fn;
}

const asBool = (o: ClaudeRead): boolean | null => (o === null ? null : typeof o === 'object');

/* WHICH claude a FRESH read last named for a pane (review finding #2), and —
   review 2 P1-B — when a fresh read first found none since, and whether THIS
   module armed the startup gate at that moment. A startup gate is armed at an
   engine spawn and a turn hook disarms it for the pane's life, so a claude a
   human starts by hand (the no-claude 409 tells him to) would otherwise meet
   no gate, and the backlog guard 9 built would be typed into ITS dialog. */
interface OwnerState {
  key: string | null;
  noneAt: number | null;
  armedAtNone: boolean;
}
const owners = new Map<string, OwnerState>();
/* A /proc start time is good to ~20 ms, and a claude's FORK can precede the
   exec that makes it `claude` — so start times are compared with slack. */
const START_SLACK_MS = 2_000;
/* How far after a claude's start a keystroke must land to be about IT rather
   than the shell that launched it (`claude -c` + Enter at the bash prompt). */
const EVIDENCE_SLACK_MS = 250;
/** Arm the gate for a claude this engine did not watch start (P1-B (3)).
 *  UNSEEDED (review 3): the replay tail can only show the PREVIOUS claude's
 *  leftovers — its composer footer would read as evidence and clear the gate
 *  while the new claude is still loading. So the gate holds, as `unknown`,
 *  until the new claude's own output clears it, a matched turn hook, a human
 *  keystroke, or a deliver-held naming `unknown`: a false hold with a named
 *  escape is the safe side. */
function armUnwatched(paneid: string, pid: number): void {
  startup.arm(paneid, { channel: false, origin: 'owner' });
  log(`room-type: ${paneid} — claude pid ${pid} started unwatched; startup gate armed (held until it shows its composer, a turn, or a person)`);
}

/**
 * Guard 9's one uncached read, and the identity check that keeps the startup
 * gate honest about WHICH claude it has watched (review 2 P1-B):
 *   (1) no claude (or not the REPL): the first such read ARMS the gate when
 *       none is watching (or it is done), so the next claude's startup is
 *       scanned from its first byte;
 *   (2) an owner the gate was armed BEFORE (it has watched it start) — live,
 *       or done by a hook that came after that owner started: nothing
 *       re-arms; a live gate's evidence older than its start (a keystroke at
 *       bash) is set aside;
 *   older: an owner that started before claude went missing (`fg` of a
 *       suspended one, or a background load): the gate is kept and only the
 *       shell's keystrokes are set aside — its repaint clears it;
 *   (3) otherwise a claude this engine never watched start — a different key
 *       with no read in between, or a first-seen owner that started after the
 *       gate went done (or after an adopted pane was adopted): arm, unseeded.
 * The same process (pid AND starttime) is never re-armed. A first-seen owner
 * that started before those points is only recorded — guard 1's. An owner
 * that is its own session leader was exec'd by the root shell and carries the
 * shell's start time, so it is always (3) when its key is new (review 4).
 */
function freshClaude(paneid: string): true | 'none' | 'not-repl' | null {
  const o = claudeProbe(paneid, false);
  if (o === null) {
    return null;
  }
  const st = owners.get(paneid) ?? { key: null, noneAt: null, armedAtNone: false };
  const gate = startup.info(paneid);
  if (typeof o !== 'object') {
    const now = Date.now();
    st.noneAt ??= now;
    if (!gate || gate.done) {
      startup.arm(paneid, { channel: false, origin: 'owner' });
      st.armedAtNone = true;
      log(`room-type: ${paneid} — no claude owns the terminal; startup gate armed for the next one`);
    } else {
      /* NOTHING TYPED AT A SHELL IS EVIDENCE ABOUT THE NEXT CLAUDE (review 3):
         `sleep 2 && claude` clears the gate with its keystrokes, and a claude
         that then draws its composer onto an already-clear gate makes no
         blocked → clear edge for a retry to act on — the line sat `pending`
         for good. Set the evidence aside; the next claude's own composer is
         the edge. */
      startup.distrustBefore(paneid, now + 1);
    }
    owners.set(paneid, st);
    return o;
  }
  const key = `${o.pid}:${o.starttime}`;
  const t = o.startedAt ?? null;
  if (st.key === key) {
    if (st.armedAtNone) {
      startup.drop(paneid); // the same claude came back (fg): the gate armed for "the next one" is moot
    }
  } else if (o.leader && process.env.HARBOR_WB_HOSTED === '1' && gate?.origin === 'spawn') {
    /* HOSTED DIRECT SPAWN: claude is the pane's own process (no root shell before it), so being a session leader is its NORMAL shape and its start time is its own. The gate was
       armed at that spawn and has watched it from byte 0 (cleared by its composer or a hook): arming again, unseeded, would hold a claude that was already seen ready, with nothing
       left to redraw the composer that would clear it. Record it and leave the gate as it is. */
  } else if (o.leader) {
    /* EXEC'D by the pane's root shell (review 4): it carries the shell's pid
       and start time, so neither "watched since before it started", "older"
       nor "started before the engine last looked" can be judged from them —
       each would let a line into its trust or old-session dialog. Never
       watched: arm, unseeded. */
    armUnwatched(paneid, o.pid);
  } else if (gate && t !== null && gate.armedAt <= t + START_SLACK_MS && (!gate.done || (gate.doneAt ?? 0) >= t)) {
    /* (2) the gate has watched this claude from before its start. A gate that
       has since gone DONE still counts when the hook that disarmed it came
       after this claude started — it was this claude's own turn (review 3);
       only a gate that went done BEFORE it started never saw it. */
    if (!gate.done) {
      startup.distrustBefore(paneid, t + EVIDENCE_SLACK_MS);
    }
  } else if (st.noneAt !== null && t !== null && t < st.noneAt - START_SLACK_MS) {
    /* older: most likely a suspended claude coming back (`fg`) — but also a
       `claude -c &` still loading, or a new claude that a backward clock step
       makes look older. So the gate is KEPT (review 4; dropping it let a line
       reach a loading claude's first dialog): only the keystrokes typed while
       the shell owned the pane are set aside. A claude returning from Ctrl+Z
       repaints on SIGCONT and its composer clears the gate; anything else
       holds, named, until a hook, a keystroke or deliver-held. */
    startup.distrustHumanSince(paneid, st.noneAt);
  } else if (st.key === null && st.noneAt === null) {
    const since = gate ? (gate.done ? gate.doneAt : gate.armedAt) : (sessions.get(paneid)?.spawnedAt ?? null);
    if (t !== null && since !== null && t > since + START_SLACK_MS) {
      armUnwatched(paneid, o.pid); // (3), a first-seen owner started after the engine last watched
    }
  } else {
    armUnwatched(paneid, o.pid); // (3)
  }
  owners.set(paneid, { key, noneAt: null, armedAtNone: false });
  return true;
}

/**
 * Guard 9's fresh read FOR ANOTHER DOOR (S0 ride fix, guard 3): voice asks
 * the same question before every inject, and must run the same owner-change
 * arm — otherwise a claude a human starts by hand after the no-claude 409
 * (`claude -c`) meets no startup gate, and a spoken line plus Enter answers
 * its old-session dialog. 'repl' / 'none' / 'not-repl' / null (could not tell).
 */
export function claudeStateFresh(paneid: string): 'repl' | 'none' | 'not-repl' | null {
  const c = freshClaude(paneid);
  return c === true ? 'repl' : c;
}

/** claude-code's guard fields (unchanged: guard 9's /proc ownership check +
 *  the startup gate + activity's hook-driven state/dialog signals). Split out
 *  so blockReason's own logic never has to know a vendor exists — every
 *  vendor just answers these same four fields differently (ticket). */
function claudeGuardFields(paneid: string, claude: 'cached' | 'later'): Pick<GuardInput, 'claude' | 'startup' | 'state' | 'busy'> {
  return {
    claude: claude === 'cached' ? asBool(claudeProbe(paneid, true)) : null,
    startup: startup.isBlocked(paneid),
    state: activity.get(paneid),
    /* a dialog up inside the turn (permission prompt, question) — NOT the turn
       itself: a running reply is typeable (Owner 2026-09-27, see blockReason) */
    busy: activity.isDialogUp(paneid),
  };
}

/** gemini-cli's guard fields (ticket, B4): no /proc ownership concept for
 *  this vendor (its TUI paints an unmistakably different frame than a bare
 *  shell, so seeing it already proves it owns the tty — see gemini-gate.ts's
 *  header) and no turn hooks (activity's generic byte-rate state does not see
 *  it), so everything comes from gemini-gate's screen classification, mapped
 *  onto the SAME four fields claude uses so blockReason needs no vendor
 *  branch at all:
 *    not-ready -> startup=true   (held, same TypeBlock as claude's own gate)
 *    dialog    -> busy=true, state='idle' (an Enter would answer it, same
 *                 meaning as claude's in-turn dialog; state must pass the
 *                 idle/background/streaming check so blockReason's busy
 *                 branch is the one that actually fires)
 *    busy      -> state='gemini:busy' (not idle/background/streaming, so the
 *                 EXISTING not-idle branch holds it — unlike claude, a
 *                 generating gemini is never typeable: B4 guard b)
 *    idle      -> state='idle' */
function geminiGuardFields(paneid: string): Pick<GuardInput, 'claude' | 'startup' | 'state' | 'busy'> {
  const s = geminiGate.state(paneid);
  return {
    claude: true,
    startup: s === 'not-ready',
    busy: s === 'dialog',
    state: s === 'busy' ? 'gemini:busy' : 'idle',
  };
}

/** codex-cli's guard fields (Owner 2026-10-03, Codex vendor). Like gemini there is
 *  no /proc ownership read (`claude: true`) and no startup gate: its pre-answered
 *  dialogs never reach the screen (codex-cli.ts). Unlike claude it is typed ONLY
 *  when idle — not mid-turn (unobserved whether Codex's composer queues a line
 *  typed during a turn) — and the state is the one the engine's hooks drive
 *  (UserPromptSubmit / Stop / PermissionRequest, agent-hook.ts), so a pane
 *  whose hooks could not be written is held for as long as its bytes say it is
 *  busy, never typed over. A permission dialog (`waiting`) is `busy`, so an
 *  Enter can never answer it. `codex queue` is the better path (follow-up). */
function codexGuardFields(paneid: string, now: number): Pick<GuardInput, 'claude' | 'startup' | 'waitingForTools' | 'state' | 'busy'> {
  const s = activity.get(paneid);
  // A hosted Codex first paints an editable startup draft before MCP is ready.
  // Tab in that draft can be lost. Wait for this generation's authenticated
  // tool enumeration (at most thirty seconds), then the ordinary output-settle guard. Keep Tab: it
  // submits when ready and queues during a turn; Enter would steer that turn.
  // Adopted panes have already passed CLI startup; the in-memory plan exists
  // only for a launch owned by this engine process. Do not require them to
  // enumerate tools again after an engine restart.
  const hosted = process.env.HARBOR_WB_HOSTED === '1' && btTools.isPlanned(paneid);
  const at = btTools.listedAt(paneid, table.get(paneid)?.generation ?? -1);
  const waitingForTools = hosted && at === null && now < (btTools.startupDeadline(paneid) ?? 0);
  if (hosted && (waitingForTools || !(queues.get(paneid)?.injected))) {
    return { claude: true, startup: false, waitingForTools, state: 'idle', busy: activity.isDialogUp(paneid) || s === 'waiting' };
  }
  /* QUEUES WHILE BUSY (2026-10-06): a running turn no longer holds — the line goes into Codex's
     own queue (TYPING.submitKey Tab). Reported as 'streaming' so neither not-idle nor the idle
     settle wait applies. A dialog or permission prompt (`waiting`) still holds as busy. */
  if (typingOf(paneid)?.queuesWhileBusy) {
    return { claude: true, startup: false, state: 'streaming', busy: activity.isDialogUp(paneid) || s === 'waiting' };
  }
  return {
    claude: true,
    startup: false,
    state: s === 'idle' ? 'idle' : 'codex:busy',
    busy: activity.isDialogUp(paneid) || s === 'waiting',
  };
}

/** `claude`: 'cached' reads the probe's cache (heldFor, display); 'later'
 *  leaves it null for flush to read FRESH once every other guard holds —
 *  claude-code only; gemini-gate has no cache/staleness to refresh (below). */
function guardFor(paneid: string, p: PaneQueue, now: number, claude: 'cached' | 'later'): GuardInput {
  const resident = sessions.get(paneid);
  const vendor = vendorOf(paneid);
  return {
    enabled: enabled(),
    connectorOwned: connectorBridge.isOwned(paneid),
    live: sessions.isLive(resident),
    vendor,
    ...(vendor === 'gemini-cli'
      ? geminiGuardFields(paneid)
      : vendor === 'codex-cli'
        ? codexGuardFields(paneid, now)
        : claudeGuardFields(paneid, claude)),
    blocked: promptBlock.get(paneid)?.reason ?? null,
    draft: activity.draftState(paneid),
    now,
    lastOutputAt: vendor === 'codex-cli' && process.env.HARBOR_WB_HOSTED === '1' && !p.injected
      ? Math.max(activity.lastOutputAt(paneid) ?? 0, btTools.listedAt(paneid, table.get(paneid)?.generation ?? -1) ?? 0)
      : activity.lastOutputAt(paneid),
    settleMs: settleMs(),
    /* A pane with a typing spec whose hooks WORK has no timeout: a line whose
       turn never started is still SITTING in its composer, and typing again
       stacks. A pane that has never delivered a hook cannot prove a turn, so it
       keeps the old timeout (lead review 2026-10-05). */
    awaitingIdle: !typingOf(paneid)?.queuesWhileBusy && p.awaitingIdle && (strictSubmit(paneid) || now - p.injectedAt < AWAIT_IDLE_FALLBACK_MS),
    oneQueued: agentComms().codexOneQueued && oneQueued(paneid, p, now),
  };
}

/* [one queued] Owner 2026-10-06: the Codex operator's box filled with typed lines and it spent a
   turn on each ("Ack." after "Ack."). A queueing CLI holds AT MOST ONE engine delivery in its own
   queue; the rest wait here and go together as ONE batch once that one is taken.
   TAKEN = THE TURN IT WAITED BEHIND COMPLETED (Codex review 2026-10-07, KB design-notes-id):
   a pane whose hooks work releases on a Stop (or the activity watchdog's lost-Stop) counted
   AFTER the delivery (activity.doneCount), never on a turn STARTING — a prompt the person
   typed starts a turn while our line still sits in Codex's queue. A pane whose hooks never
   fired keeps the old fallbacks: the screen reads idle, or the hold runs out (a spinner that
   never lets it read idle would otherwise never get the rest). The Codex App service's
   `turn/completed` notification would be the same signal without hooks; not used (no App
   service integration). */
function queueHoldMs(): number {
  const v = Number(process.env.HARBOR_WB_QUEUE_HOLD_MS);
  return process.env.HARBOR_WB_QUEUE_HOLD_MS && Number.isFinite(v) && v >= 0 ? v : 5 * 60_000;
}
function oneQueued(paneid: string, p: PaneQueue, now: number): boolean {
  if (!p.queuedAt || !typingOf(paneid)?.queuesWhileBusy) {
    return false;
  }
  const taken = activity.hookSeen(paneid)
    ? activity.doneCount(paneid) > p.queuedDone
    : activity.get(paneid) === 'idle' || now - p.queuedAt >= queueHoldMs();
  if (taken) {
    p.queuedAt = 0;
    return false;
  }
  return true;
}

/** The person's own words go first: a room line by @user, or a line relaying them ("From Owner"). */
export function fromPerson(text: string): boolean {
  const head = text.startsWith('[room ') ? text.slice(0, text.indexOf(']') + 1) : '';
  return /· @user( · #\d+)?\]$/.test(head) || text.includes('From Owner');
}

/* OBSERVERS of the engine typing into a pane (the screen model's shadow log
   opens an inject window, the design notes §5). Told AFTER the text
   write; they cannot change what is typed or when, and a throw stays here. */
const typedTaps: Array<(paneid: string) => void> = [];
export function onTyped(fn: (paneid: string) => void): void {
  typedTaps.push(fn);
}

const PASTE_ON = String.fromCharCode(27) + '[200~';
const PASTE_OFF = String.fromCharCode(27) + '[201~';

/** The vendor's typing spec (codex), with env overrides for the beats; undefined = claude's way. */
function typingOf(paneid: string): TypingSpec | undefined {
  const t = vendorFor(vendorOf(paneid))?.typing;
  if (!t) return undefined;
  const ms = (name: string, d: number): number => {
    const v = Number(process.env[name]);
    return process.env[name] && Number.isFinite(v) && v >= 0 ? v : d;
  };
  return { ...t, enterDelayMs: ms('HARBOR_WB_TYPE_ENTER_MS', t.enterDelayMs), submitCheckMs: ms('HARBOR_WB_TYPE_SUBMIT_CHECK_MS', t.submitCheckMs) };
}

/** The strict "a turn must follow" rule applies only to a pane that has proven
 *  its hooks work (at least one hook since spawn); otherwise it would hold
 *  forever (other-builder: no hook ever delivered). */
function strictSubmit(paneid: string): boolean {
  const t = typingOf(paneid);
  /* A queueing CLI may hold the line until its turn ends: no turn is expected yet, and a
     second key would steer the running turn. No retry, no turn-counted wait. */
  return !!t && !t.queuesWhileBusy && activity.hookSeen(paneid);
}

/** [codex typer] Owner 2026-10-05: the line went in but no turn started, so it
 *  still sits in the composer. Press Enter once more (harmless on an empty
 *  composer), look again, then stop: the pane stays held, nothing stacks. */
function checkSubmitted(paneid: string, spec: TypingSpec): void {
  const p = queues.get(paneid);
  if (!p || !p.awaitingIdle || !strictSubmit(paneid) || activity.turnCount(paneid) > p.turnsAtInject) {
    return;
  }
  const resident = sessions.get(paneid);
  if (p.enterRetried || !resident || !sessions.isLive(resident)) {
    log(`room-type: ${paneid} line not submitted after a retry — held, nothing more typed until a turn starts`);
    return;
  }
  p.enterRetried = true;
  log(`room-type: ${paneid} no turn after Enter — pressing Enter once more`);
  try {
    engineWrite(paneid, resident.cli.pty, '\r', 'room-typer');
  } catch {
    /* pty gone */
  }
  setTimeout(() => checkSubmitted(paneid, spec), spec.submitCheckMs).unref?.();
}

function type(paneid: string, text: string, keyOverride?: string): void {
  const resident = sessions.get(paneid);
  if (!resident || !sessions.isLive(resident)) {
    throw new Error('no live resident');
  }
  /* The SAME write viewer input uses (index.ts `input` → resident.cli.pty.write),
     so the broker receives it like a keystroke. Deliberately NOT through
     activity.onInput: the engine's own writes must never make a pane look
     dirty or clean to the draft guard. Enter is its own write a beat later —
     one fast chunk ending in CR can be read by a TUI as a paste (voice.ts). */
  const spec = typingOf(paneid);
  engineWrite(paneid, resident.cli.pty, spec?.bracketedPaste ? PASTE_ON + text + PASTE_OFF : text, 'room-typer');
  for (const fn of typedTaps) {
    try {
      fn(paneid);
    } catch {
      /* an observer must never reach the typer */
    }
  }
  setTimeout(() => {
    try {
      engineWrite(paneid, resident.cli.pty, keyOverride ?? spec?.submitKey ?? '\r', 'room-typer');
    } catch {
      /* pty gone between the two writes */
    }
  }, spec ? spec.enterDelayMs : enterDelayMs() + Math.min(enterDelayMs() * 10, Math.floor((text.length * enterDelayMs()) / 300)));
  /* A LONG line into a composer that is still busy (a fresh session's first
     render) needs more than the base beat: Enter arriving inside the TUI's
     paste window becomes a newline and the line sits unsent (Owner 2026-10-01,
     the reload welcome). Scaled off the base beat: at the default 150 ms that is
     +0.5 ms per char, capped at +1.5 s. */
}

/** Try to type the head of this pane's queue. Returns what happened to it.
 *  Every attempt re-announces the hold (pane.held, deduped). */
function flush(paneid: string): string {
  const r = flushOnce(paneid);
  notifyHeld(paneid);
  return r;
}

/** [steer] Type ONE control item, alone, with the vendor's steer key (Codex: Enter = into the
 *  running turn). The one-queued bookkeeping is left as it was: a steer is not left in the
 *  CLI's queue, so whatever was queued before is still the one outstanding. */
function steerOne(paneid: string, p: PaneQueue, idx: number, spec: TypingSpec, now: number): string {
  const [it] = p.items.splice(idx, 1);
  try {
    type(paneid, it.text, spec.steerKey);
  } catch (e) {
    p.items.splice(idx, 0, it);
    persist(paneid);
    p.lastResult = 'inject-failed';
    p.lastAt = now;
    log(`room-type: steer FAILED ${paneid} room ${it.roomId} #${it.entryId}: ${(e as Error).message}`);
    return p.lastResult;
  }
  persist(paneid);
  p.typingUntil = now + spec.enterDelayMs + 150;
  p.injected += 1;
  p.heldSince = null;
  if (it.roomId !== 'fabric' && it.roomId !== 'chat') {
    reads.onInjected(it.roomId, it.entryId, paneid, now);
  }
  if (p.items.length) {
    setTimeout(() => {
      try {
        flush(paneid);
      } catch (e) {
        log(`room-type: flush threw for ${paneid}: ${(e as Error).message}`);
      }
    }, spec.enterDelayMs + 300).unref?.();
  }
  p.lastResult = 'injected';
  p.lastAt = now;
  log(`room-type: STEERED room ${it.roomId} #${it.entryId} → ${paneid} len=${it.text.length} (control line, into the running turn; queue ${p.items.length})`);
  return 'injected';
}

function flushOnce(paneid: string): string {
  const p = queues.get(paneid);
  if (!p || !p.items.length) {
    return 'empty';
  }
  const now = Date.now();
  if (now < p.typingUntil) {
    /* [codex type lock] 2026-10-06: a delivery's Tab is still pending. Look again once it is in;
       everything queued meanwhile goes as ONE batch then (a restore typed 20 lines 2 ms apart,
       and they merged into one queued input). */
    if (!p.timer) {
      p.timer = setTimeout(() => {
        p.timer = null;
        try {
          flush(paneid);
        } catch (e) {
          log(`room-type: flush threw for ${paneid}: ${(e as Error).message}`);
        }
      }, p.typingUntil - now + 50);
      p.timer.unref?.();
    }
    return 'held:typing';
  }
  const g = guardFor(paneid, p, now, 'later');
  /* [steer] FIX 2 (Codex review 2026-10-07): a control line (a stop from the person or a
     lead, the answer to the pane's own open ask) must reach the RUNNING turn. It skips the
     one-queued hold and the queue order and goes alone with the steer key; every other guard
     (draft, dialog, startup, the type lock above) still holds it. */
  const spec0 = typingOf(paneid);
  const ctl = !doorbellOn() && spec0?.queuesWhileBusy && spec0.steerKey && agentComms().codexSteerControl ? p.items.findIndex((it) => it.control) : -1;
  if (ctl >= 0) {
    g.oneQueued = false;
  }
  let reason = blockReason(g);
  /* Guard 9: the one uncached /proc read, immediately before the write —
     which may arm the startup gate for a claude it has not seen, or drop the
     one it armed when the same claude comes back. So it also runs when the
     only hold is a gate THIS module armed: otherwise that gate would block
     the very read that can lift it (a suspended claude's `fg`).
     CLAUDE-CODE ONLY: gemini-gate's state() is always fresh (no /proc cache
     to re-read), so guardFor's initial call above already reflects gemini's
     true state — re-running this claude-specific check against a gemini
     paneid would read `freshClaude` as "no claude here" and wrongly hold it
     `no-claude` forever (ticket). */
  if (vendorOf(paneid) === 'claude-code' && (!reason || (reason === 'startup' && startup.info(paneid)?.origin === 'owner'))) {
    const c = freshClaude(paneid);
    g.claude = c === null ? null : c === true;
    g.startup = startup.isBlocked(paneid);
    reason = blockReason(g);
  }
  /* THREE OUTCOMES, never two (design review, W1): in doorbell delivery a Claude pane whose owner the classifier cannot tell (null) holds the ring exactly like 'none' and 'not-repl': a keystroke is only ever sent
     to a terminal we positively know is Claude's interactive session. */
  if (!reason && doorbellOn() && vendorOf(paneid) === 'claude-code' && g.claude === null) {
    reason = 'no-claude';
  }
  /* Clock-bound holds get a timer. The callback re-reads every guard and the
     current launch deadline; replanning or a dialog cannot inherit permission
     from an old timer. */
  const wait =
    reason === 'waiting-for-tools'
      ? Math.max(0, (btTools.startupDeadline(paneid) ?? now) - now) + 25
      : reason === 'settling'
      ? g.settleMs - (now - (g.lastOutputAt ?? now)) + 25
      : reason === 'awaiting-idle'
        ? AWAIT_IDLE_FALLBACK_MS - (now - p.injectedAt) + 25
        : reason === 'one-queued' && !activity.hookSeen(paneid) // hooked panes release on the turn's Stop (onTurnDone)
          ? queueHoldMs() - (now - p.queuedAt) + 25
          : null;
  if (p.timer) {
    clearTimeout(p.timer); // the newest reason decides when to look again
    p.timer = null;
  }
  if (wait !== null) {
    p.timer = setTimeout(() => {
      p.timer = null;
      try {
        flush(paneid); // a throw in a timer is engine-fatal
      } catch (e) {
        log(`room-type: flush threw for ${paneid}: ${(e as Error).message}`);
      }
    }, Math.max(50, wait));
    p.timer.unref?.();
  }
  if (reason) {
    p.lastResult = `held:${reason}`;
    p.lastAt = now;
    p.heldSince ??= now;
    return p.lastResult;
  }
  if (ctl >= 0 && spec0?.steerKey) {
    return steerOne(paneid, p, ctl, spec0, now);
  }
  /* held-batch (Owner 2026-09-29): everything queued for the SAME room right
     now goes out as one delivery, never mixed with a different room's lines
     or with fabric envelopes (roomId 'fabric' is just another "room" here —
     the run stops the moment roomId changes). */
  /* [agent comms] codexOneQueued off: the pre-10-06 queue (no person-first reorder, no cross-room batch) */
  if (doorbellOn()) {
    const rooms = p.items.filter(isRoomEntry);
    if (rooms.length) {
      p.items = p.items.filter((it) => !isRoomEntry(it));
      const ring = ringFor(rooms);
      try {
        type(paneid, ring);
      } catch (e) {
        p.items.unshift(...rooms);
        persist(paneid);
        p.lastResult = 'inject-failed';
        p.lastAt = now;
        log(`room-type: ring FAILED ${paneid}: ${(e as Error).message}`);
        return p.lastResult;
      }
      persist(paneid);
      p.awaitingIdle = true;
      p.injectedAt = now;
      p.turnsAtInject = activity.turnCount(paneid);
      p.enterRetried = false;
      const dspec = typingOf(paneid);
      if (dspec?.queuesWhileBusy) {
        p.typingUntil = now + dspec.enterDelayMs + 150;
        p.queuedAt = activity.get(paneid) === 'idle' || !agentComms().codexOneQueued ? 0 : now;
        p.queuedDone = activity.doneCount(paneid);
      } else if (dspec) {
        setTimeout(() => checkSubmitted(paneid, dspec), dspec.enterDelayMs + dspec.submitCheckMs).unref?.();
      }
      p.injected += rooms.length;
      p.heldSince = null;
      for (const c of rooms.flatMap(coversOf)) {
        if (isRoomEntry(c)) reads.onInjected(c.roomId, c.entryId, paneid, now);
      }
      p.lastResult = 'injected';
      p.lastAt = now;
      log(`room-type: RANG ${paneid} for ${rooms.length} line(s) (${ring.length} chars, no text)`);
      return 'injected';
    }
  }
  /* [digest] #5: too many lines addressed to this pane waiting = one digest instead */
  const digested = digestQueue(paneid, p.items);
  if (digested) {
    p.items = digested;
    persist(paneid);
  }
  const queueing = !!typingOf(paneid)?.queuesWhileBusy && agentComms().codexOneQueued;
  if (queueing) {
    /* [one queued] the person's words first, as ONE batch — but whole THREADS move, so an
       older line of a thread is never typed after a newer one (orderQueued, FIX 1) */
    p.items = orderQueued(p.items);
  }
  const roomId = queueing && p.items.some((it) => it.roomId !== p.items[0].roomId) ? MIXED : p.items[0].roomId;
  let runLen = 0;
  while (runLen < p.items.length && (roomId === MIXED || p.items[runLen].roomId === roomId)) {
    runLen++;
  }
  let chunkLen: number;
  let text: string;
  if (runLen === 1) {
    chunkLen = 1;
    text = p.items[0].text;
  } else {
    const texts = p.items.slice(0, runLen).map((it) => it.text);
    /* [labelled batch] FIX 1: a queueing CLI's batch says, per item, who / which / where / when /
       whether it needs a reply — the items are interleaved threads it must tell apart */
    const labels = queueing ? p.items.slice(0, runLen).map(labelOf) : undefined;
    chunkLen = packBatch(texts, runLen, roomId, TYPE_TEXT_MAX, labels)[0].length;
    text = composeBatch(texts.slice(0, chunkLen), 1, runLen, roomId, labels?.slice(0, chunkLen));
  }
  const items = p.items.splice(0, chunkLen);
  try {
    type(paneid, text);
  } catch (e) {
    p.items.unshift(...items); // keep them; the next idle retries
    persist(paneid);
    p.lastResult = 'inject-failed';
    p.lastAt = now;
    log(`room-type: inject FAILED ${paneid} room ${roomId} (${items.length} line(s)): ${(e as Error).message}`);
    return p.lastResult;
  }
  persist(paneid);
  p.awaitingIdle = true;
  p.injectedAt = now;
  p.turnsAtInject = activity.turnCount(paneid);
  p.enterRetried = false;
  const spec = typingOf(paneid);
  if (spec?.queuesWhileBusy) {
    p.typingUntil = now + spec.enterDelayMs + 150;
    /* typed into a running turn = left in its queue: nothing more until it is taken */
    p.queuedAt = activity.get(paneid) === 'idle' || !agentComms().codexOneQueued ? 0 : now;
    p.queuedDone = activity.doneCount(paneid);
    /* A queueing CLI needs no idle between deliveries, and may never show one: the next run
       (another room's lines) goes as soon as this one's submit key is in. */
    if (p.items.length) {
      setTimeout(() => {
        try {
          flush(paneid);
        } catch (e) {
          log(`room-type: flush threw for ${paneid}: ${(e as Error).message}`);
        }
      }, spec.enterDelayMs + 300).unref?.();
    }
  } else if (spec) {
    setTimeout(() => checkSubmitted(paneid, spec), spec.enterDelayMs + spec.submitCheckMs).unref?.();
  }
  p.injected += items.length;
  p.heldSince = null; // the next line's wait starts when it is first held
  for (const c of items.flatMap(coversOf)) {
    if (isRoomEntry(c)) {
      reads.onInjected(c.roomId, c.entryId, paneid, now); // gate G item 2: the evidence window opens, for EVERY line in the batch (and every line a digest stands for)
    }
  }
  p.lastResult = 'injected';
  p.lastAt = now;
  if (items.length === 1) {
    log(`room-type: typed room ${items[0].roomId} #${items[0].entryId} → ${paneid} len=${items[0].text.length} (queue ${p.items.length})`);
  } else {
    log(
      `room-type: typed BATCH room ${roomId} ${items.length}/${runLen} line(s) [#${items.map((it) => it.entryId).join(',#')}] → ${paneid} bytes=${text.length} (queue ${p.items.length})`,
    );
  }
  return 'injected';
}

/** What holds this pane's typed queue, for the room UI ("2 messages held —
 *  draft in input") and the pane's own window (pane.held): the CURRENT block
 *  reason (or `pending` when nothing blocks and the next event will type it),
 *  since when the head has been held, and how many lines wait; on a `startup`
 *  hold, `prompt` names the prompt deliver-held would have to name (absent
 *  when none is current). Null when nothing waits. Reads guards only. */
export interface Held {
  reason: TypeBlock | 'pending';
  since: number | null;
  depth: number;
  prompt?: string;
  /** On a `no-claude` hold: a claude owns the pane's pty but is not its
   *  interactive session (a subcommand, print mode, redirected stdio). */
  detail?: 'not-interactive';
  /** [ticket] On a `needs-you` hold: what the pane is blocked on —
   *  `login` | `permission` | `question` (prompt-block.ts). */
  blocked?: string;
}
export function heldFor(paneid: string): Held | null {
  const p = queues.get(paneid);
  if (!p || !p.items.length) {
    return null;
  }
  const reason = blockReason(guardFor(paneid, p, Date.now(), 'cached')) ?? 'pending';
  const isGemini = vendorOf(paneid) === 'gemini-cli';
  /* gemini's dialog maps to TypeBlock 'busy' (see geminiGuardFields), not
     'startup' — its not-ready hold is the only one that lands on 'startup'.
     dialogKindOf answers null for the not-ready case, so this is exactly
     "name it when there is a dialog to name" for either reason. */
  const prompt = isGemini
    ? reason === 'startup' || reason === 'busy' || reason === 'needs-you'
      ? (geminiGate.dialogKindOf(paneid) ?? undefined)
      : undefined
    : reason === 'startup'
      ? startup.currentPrompt(paneid)?.kind
      : undefined;
  const notRepl = reason === 'no-claude' && claudeProbe(paneid, true) === 'not-repl';
  const blocked = reason === 'needs-you' ? promptBlock.get(paneid)?.reason : undefined;
  return {
    reason,
    since: p.heldSince,
    depth: p.items.length,
    ...(blocked ? { blocked } : {}),
    ...(prompt ? { prompt } : {}),
    ...(notRepl ? { detail: 'not-interactive' as const } : {}),
  };
}

/* pane.held (the solo window head, which knows only its paneid): the hold is
   re-announced at every point it can move — each flush attempt, an enqueue,
   an activity change, a startup clear or draft going clean — and the listener
   hears only a CHANGE (set, reason, depth, cleared → null). In memory. */
let heldListener: (paneid: string, held: Held | null) => void = () => {};
const lastHeld = new Map<string, string>();
export function setHeldListener(fn: (paneid: string, held: Held | null) => void): void {
  heldListener = fn;
}

/* Runs inside pty pumps, the hook sink, the activity callback and timers: a
   throw must never leave it. */
function notifyHeld(paneid: string): void {
  try {
    const h = heldFor(paneid);
    const key = JSON.stringify(h);
    if ((lastHeld.get(paneid) ?? 'null') === key) {
      return;
    }
    if (h) {
      lastHeld.set(paneid, key);
    } else {
      lastHeld.delete(paneid);
    }
    heldListener(paneid, h);
    announceRooms(paneid, h);
  } catch (e) {
    log(`room-type: pane.held notify threw for ${paneid}: ${(e as Error).message}`);
  }
}

/* room.held (room-bus, Owner 2026-09-28): the same change, to every room this
   pane holds a seat in, so the seat row's "N held · …" moves the moment the
   queue does — not on the page's next roster poll. Never throws. */
function announceRooms(paneid: string, h: Held | null): void {
  try {
    for (const { room, seat } of table.roomsForPane(paneid)) {
      roomBus.emit(room.id, { type: 'room.held', seatId: seat.id, handle: seat.handle, held: h ? { ...h } : null });
    }
  } catch (e) {
    log(`room-type: room.held announce threw for ${paneid}: ${(e as Error).message}`);
  }
}

/** Lines waiting in this pane's typed queue: room lines, and fabric envelopes
 *  (roomId `fabric`). Readiness `queued` (assemble-room §4.1); counts only. */
export function queued(paneid: string): { typed: number; fabric: number } {
  const items = queues.get(paneid)?.items ?? [];
  const fabric = items.filter((it) => it.roomId === 'fabric').length;
  return { typed: items.length - fabric, fabric };
}

export type HumanDeliver =
  | { ok: false; reason: 'no-claude'; detail?: 'not-interactive' }
  | { ok: false; reason: 'startup'; prompt: string; promptAt: number | null }
  | { ok: true; result: string; overrode: Array<'startup' | 'draft'>; prompt: string | null };

/**
 * POST /api/panes/:id/deliver-held (human-only — the route checked the
 * credential): a person at the window waives the holds that are theirs to
 * waive, then the head of the queue types now if every OTHER guard holds —
 * live, claude-code, idle, not busy, one-at-a-time; `settling` types by its
 * own timer a moment later. `result` is what flush reports ('injected' |
 * 'held:<reason>' | 'empty').
 *
 *   no-claude  NEVER waived (guard 9): refused first, on a FRESH read.
 *   startup    waived when no prompt is current (startup.currentPrompt);
 *              otherwise refused with {prompt, promptAt} until an `override`
 *              names that same kind (guard 4, §4.4 item 4).
 *   draft      waived: the human says the composer is clear (the original
 *              contract of this route).
 * A refusal changes nothing. `overrode` names every hold it waived.
 *
 * gemini-cli (ticket) dispatches to deliverHeldGemini below: it has no
 * process-ownership concept (so no `no-claude` refusal is possible for this
 * vendor) and no elaborate prompt-context tracking — only whether a dialog is
 * CURRENTLY on screen, mapped onto the same 'startup' shape so the route and
 * its UI need no vendor branch of their own.
 */
export function deliverHeld(paneid: string, override: string | null = null): HumanDeliver {
  if (vendorOf(paneid) === 'gemini-cli') {
    return deliverHeldGemini(paneid, override);
  }
  if (vendorOf(paneid) === 'codex-cli') {
    /* Nothing to waive but the draft guard: codex has no startup gate or
       ownership read (codexGuardFields), and a dialog/turn still holds. */
    const overrode: Array<'startup' | 'draft'> = activity.draftState(paneid) === 'draft' ? ['draft'] : [];
    activity.clearDraft(paneid);
    const p = queues.get(paneid);
    if (p) {
      p.awaitingIdle = false; // a human at the window: whatever sat unsubmitted is theirs to see
    }
    return { ok: true, result: flush(paneid), overrode, prompt: null };
  }
  const c = freshClaude(paneid);
  if (c === 'none' || c === 'not-repl') {
    return { ok: false, reason: 'no-claude', ...(c === 'not-repl' ? { detail: 'not-interactive' as const } : {}) };
  }
  const overrode: Array<'startup' | 'draft'> = [];
  let prompt: string | null = null;
  if (startup.isBlocked(paneid)) {
    const cur = startup.currentPrompt(paneid);
    if (cur && override !== cur.kind) {
      return { ok: false, reason: 'startup', prompt: cur.kind, promptAt: cur.at };
    }
    prompt = cur?.kind ?? null;
    startup.release(paneid);
    overrode.push('startup');
  }
  if (activity.draftState(paneid) === 'draft') {
    overrode.push('draft');
  }
  activity.clearDraft(paneid);
  return { ok: true, result: flush(paneid), overrode, prompt };
}

/** gemini-cli's half of deliverHeld: a currently-shown dialog refuses (named,
 *  like claude's startup prompt) unless the override names it; `not-ready`
 *  waives at once (same as claude's "no prompt seen since arm"), since a
 *  human at the window is exactly the positive evidence the screen cannot
 *  give on its own. geminiGate.release() is the mutation that actually lets
 *  the next flush() through — see its header. */
function deliverHeldGemini(paneid: string, override: string | null): HumanDeliver {
  const s = geminiGate.state(paneid);
  const kind = geminiGate.dialogKindOf(paneid);
  if (s === 'dialog' && override !== kind) {
    return { ok: false, reason: 'startup', prompt: kind ?? 'unknown', promptAt: null };
  }
  const overrode: Array<'startup' | 'draft'> = [];
  if (s === 'dialog' || s === 'not-ready') {
    geminiGate.release(paneid);
    promptBlock.sync(paneid); // its "needs you" reads this gate: the human's override lifts it too
    overrode.push('startup');
  }
  if (activity.draftState(paneid) === 'draft') {
    overrode.push('draft');
  }
  activity.clearDraft(paneid);
  return { ok: true, result: flush(paneid), overrode, prompt: s === 'dialog' ? (kind ?? 'unknown') : null };
}

export type EnqueueResult = 'injected' | 'queued' | 'off' | 'vendor';

/**
 * Queue one room line entry to be typed into `paneid`, and type it now if
 * every guard holds. The caller has already decided the pane is the seat's
 * live occupant and is not the author's own pane.
 */
export function enqueue(
  paneid: string,
  roomId: string,
  entryId: number,
  roomName: string,
  author: string,
  body: string,
  lead = false,
  meta: Pick<ItemMeta, 'ts' | 'replyNeeded' | 'control' | 'addressed'> = {},
): EnqueueResult {
  const { roomId: r, entryId: e, text, ...m } = itemFor(roomId, entryId, roomName, author, body, lead, meta);
  return enqueueLine(paneid, r, e, text, m);
}

/** The item `enqueue` would queue, composed but not queued (the assistant switch holds it in its journal). */
export function itemFor(
  roomId: string,
  entryId: number,
  roomName: string,
  author: string,
  body: string,
  lead = false,
  meta: Pick<ItemMeta, 'ts' | 'replyNeeded' | 'control' | 'addressed'> = {},
): DrainedItem {
  return {
    from: author,
    msgId: `line ${entryId}`,
    thread: `room ${flat(roomName) || 'room'}`,
    room: flat(roomName) || 'room',
    gist: gistOf(body),
    ...(meta.replyNeeded !== undefined ? { addressed: meta.replyNeeded } : {}), // a room line: addressed = not @room
    ...meta,
    roomId,
    entryId,
    text: frame(roomName, author, body, TYPE_TEXT_MAX, lead, entryId),
  };
}

/**
 * Fabric envelopes get the same typed path as room lines (Owner 2026-09-24:
 * "can it be built initially using the text injection into chat"), framed
 *   `[fabric · @<from> · <kind> · t:<thread> · id:<envelope id>] <body | ref>`
 * so a member can tell an installation message from a room line, knows which
 * thread to answer on, and holds the FULL envelope id so it can ack in one
 * step (platform's request, 2026-09-25) — never shortened, an ack by a prefix
 * is an ack of nothing. `t:` / `id:` are omitted when the envelope has none.
 * Own kill switch: HARBOR_WB_FABRIC_TYPE=0.
 */
export function enqueueFabric(
  paneid: string,
  env: { id?: string; from?: string; to?: string; kind?: string; thread?: string; body?: string; ref?: string; ts?: string },
): EnqueueResult {
  if (process.env.HARBOR_WB_FABRIC_TYPE === '0') {
    return 'off';
  }
  const ts = typeof env.ts === 'string' ? Date.parse(env.ts) : NaN;
  /* [steer] the person's own stop, or the answer to an ask this pane sent */
  const control = (env.from === 'user' && isStopLine(env.body)) || answersOwnAsk(paneid, env.thread);
  return enqueueLine(paneid, 'fabric', 0, frameFabric(env), {
    ...(env.from ? { from: env.from } : {}),
    ...(env.id ? { msgId: `id:${env.id}` } : {}),
    thread: env.thread ? `t:${env.thread}` : 'fabric',
    ...(Number.isFinite(ts) ? { ts } : {}),
    replyNeeded: env.kind === 'ask',
    /* a DM is addressed to this pane; a group or installation broadcast is not */
    addressed: !(typeof env.to === 'string' && (env.to.startsWith('@group:') || env.to === '@all')),
    gist: gistOf(env.body != null ? env.body : env.ref != null ? `ref ${env.ref}` : ''),
    ...(control ? { control } : {}),
  });
}

/**
 * One envelope's typed frame (enqueueFabric's shape), capped at `max` with a
 * note saying how much was cut. Pure: fabric-held.ts frames each envelope of
 * a held/restore batch with it, so a batched message reads exactly like a
 * single one.
 */
export function frameFabric(
  env: { id?: string; from?: string; kind?: string; thread?: string; body?: string; ref?: string },
  max: number = TYPE_TEXT_MAX,
): string {
  const tag = `fabric · @${flat(env.from ?? '') || 'unknown'} · ${flat(env.kind ?? '') || 'message'}${env.thread ? ` · t:${flat(env.thread)}` : ''}${env.id ? ` · id:${flat(env.id)}` : ''}`;
  const text = env.body != null ? env.body : env.ref != null ? `ref ${env.ref}` : '';
  let line = `[${tag}] ${flat(text)}`;
  if (line.length > max) {
    /* An AGENT reads this, not a person: the badge is a window's, the agent's
       way to the rest is its own inbox (night test 2026-10-06: the Codex
       operator was typed four 1500-char cuts it had no way to finish). */
    const note = ` … [truncated, ${line.length} chars — the full message is in fabric_inbox${env.id ? ` (id ${flat(env.id)})` : ''}]`;
    line = line.slice(0, Math.max(0, max - note.length)).trimEnd() + note;
  }
  if (line.endsWith(BACKSLASH)) {
    line += ' ';
  }
  return line;
}

/**
 * Queue an already-composed fabric text (a held/restore batch, fabric-held.ts)
 * exactly as enqueueFabric queues one envelope: same kill switch, same guards,
 * same `fabric` run. Control characters are flattened here too, and the line
 * never ends in a backslash (see frame()).
 */
export function enqueueFabricText(paneid: string, text: string): EnqueueResult {
  if (process.env.HARBOR_WB_FABRIC_TYPE === '0' || doorbellOn()) {
    return 'off'; // doorbell delivery types no engine prose either (welcome, guide notices): the guide and the role file carry it
  }
  let line = flat(text);
  if (line.endsWith(BACKSLASH)) {
    line += ' ';
  }
  return enqueueLine(paneid, 'fabric', 0, line);
}

/**
 * A person's direct-chat message (agent chat, Owner 2026-10-05): the SAME typed
 * path a room line takes — idle only, held on a draft, never over a prompt — as
 * its own run (roomId `chat`, no room read-state). Framed `[chat · @user] <text>`
 * so the line starts with `[` (never a `/` or `!` command, whatever was written).
 * The caller checks the length: a chat message is refused over TYPE_TEXT_MAX,
 * never cut. Kill switch: HARBOR_WB_ROOM_TYPE=0 (the typer's own).
 */
/** `via: 'voice'` marks a line the person SPOKE ([concierge] voice flag): the frame
 *  carries it, so it survives in the transcript, the only record the chat reads back. */
export function frameChat(text: string, via: 'voice' | null = null): string {
  let line = `[chat · @user${via === 'voice' ? ' · voice' : ''}] ${flat(text)}`;
  if (line.endsWith(BACKSLASH)) {
    line += ' ';
  }
  return line;
}
export function enqueueChat(paneid: string, text: string, via: 'voice' | null = null): EnqueueResult {
  return enqueueLine(paneid, 'chat', 0, frameChat(text, via), {
    from: 'user',
    thread: 'chat',
    ts: Date.now(),
    replyNeeded: true,
    addressed: true,
    gist: gistOf(text),
    ...(isStopLine(text) ? { control: true } : {}),
  });
}

/** Fold a dropped item into the pane's single drop note (created at the head). */
function noteDropped(p: { items: Item[] }, gone: Item): void {
  let note = p.items.find((it) => it.dropped);
  if (!note) {
    note = { roomId: DIGEST_ROOM, entryId: 0, text: '', covers: [], dropped: [] };
    p.items.unshift(note);
  }
  const list = note.dropped!;
  for (const c of coversOf(gone)) {
    if (c.roomId === DIGEST_ROOM) continue;
    const d = list.find((x) => x.roomId === c.roomId);
    if (d) {
      d.n++;
      d.first = Math.min(d.first, c.entryId || d.first);
    } else {
      list.push({ roomId: c.roomId, room: c.roomId === 'chat' ? 'your chat with the person' : c.roomId === 'fabric' ? 'fabric_inbox' : gone.room ?? c.roomId, first: c.entryId, n: 1 });
    }
  }
  note.text = composeDropNote(list);
}

function enqueueLine(paneid: string, roomId: string, entryId: number, text: string, meta: ItemMeta = {}): EnqueueResult {
  if (!enabled()) {
    return 'off';
  }
  const vendor = vendorOf(paneid);
  if (!vendor || !TYPE_VENDORS.has(vendor)) {
    if (!vendorLogged.has(paneid)) {
      vendorLogged.add(paneid);
      log(`room-type: ${paneid} is vendor '${vendor ?? 'unknown'}' — badge only, never typed`);
    }
    return 'vendor';
  }
  const p = q(paneid);
  p.items.push({ ...meta, roomId, entryId, text });
  while (p.items.filter((it) => !it.dropped).length > QUEUE_MAX) {
    const at = p.items.findIndex((it) => !it.dropped);
    if (at < 0) break;
    const gone = p.items.splice(at, 1)[0];
    p.dropped++;
    for (const c of coversOf(gone).filter(isRoomEntry)) {
      reads.onDropped(c.roomId, c.entryId, paneid, 'dropped');
    }
    noteDropped(p, gone);
    log(`room-type: queue full for ${paneid}, dropped oldest (room ${gone.roomId} #${gone.entryId}); dropped total ${p.dropped}`);
  }
  persist(paneid);
  /* Only the head may go now; anything behind it waits for the next idle. A
     control line [steer] is the exception: it may go past the queue, so it
     looks now (flush decides whether the steer path is on for this pane). */
  const wasHead = p.items.length === 1;
  const r = wasHead || meta.control ? flush(paneid) : 'queued';
  if (!wasHead) {
    notifyHeld(paneid); // the depth moved
  }
  return r === 'injected' ? 'injected' : 'queued';
}

/* ---- seat reload (ticket) -------------------------------------------------
 * A reload ENDS the old pane, which fires `onPaneEnded` and DROPS whatever is
 * still queued for it (every queue is keyed by paneid). The reload's caller
 * must lift the queue out BEFORE ending the old session, then hand it to the
 * fresh pane once it exists — the same already-composed text, re-run through
 * `enqueueLine`'s own guards (idle, startup, no-draft, claude-owns-terminal),
 * never re-framed: a line already carries its room/author header. */

/** An item as queued: already-composed text plus which room/entry it answers
 *  for (room-reads' drop/inject bookkeeping on the far side). */
export interface DrainedItem extends ItemMeta {
  roomId: string;
  entryId: number;
  text: string;
}

/** Lift a pane's queue out, before it ends, so `onPaneEnded` finds nothing to
 *  drop. Empty when there was nothing held. */
export function drainQueue(paneid: string): DrainedItem[] {
  const p = queues.get(paneid);
  if (!p || !p.items.length) {
    return [];
  }
  const items = p.items.map((it) => ({ ...it }));
  p.items.length = 0;
  persist(paneid);
  notifyHeld(paneid); // the depth just dropped to 0
  return items;
}

/** The other half of drainQueue: requeue already-composed lines on a
 *  DIFFERENT pane (the reload's fresh session) through the normal guarded
 *  path, oldest first. */
export function requeue(paneid: string, items: readonly DrainedItem[]): void {
  for (const { roomId, entryId, text, ...meta } of items) {
    enqueueLine(paneid, roomId, entryId, text, meta); // the label and steer facts travel with it
  }
}

/* ---- the assistant switch (the design notes §3 item 4) -------
 * The switch moves a seat's queued lines DURABLY: store.holdSwitchLines copies
 * them into its journal and clears this pane's typer_state in ONE transaction;
 * store.releaseSwitchLines writes them into the receiving pane's typer_state in
 * ONE transaction. These three keep the in-memory queue in step with that. */

/** A pane's queued items, NOT removed (the journal move removes them, durably). */
export function peekQueue(paneid: string): DrainedItem[] {
  return (queues.get(paneid)?.items ?? []).map((it) => ({ ...it }));
}

/** Forget a pane's in-memory queue once the switch journal holds its items. */
export function forgetQueue(paneid: string): void {
  const p = queues.get(paneid);
  if (p && p.items.length) {
    p.items.length = 0;
    persist(paneid);
    notifyHeld(paneid);
  }
}

/** Items the switch's release already wrote into this pane's persisted queue:
 *  added to the in-memory queue in ONE step, so the write-through never stores a
 *  partial list (one enqueue at a time would), then typed through the normal
 *  guards. Never trimmed to QUEUE_MAX: a held line is never dropped. */
export function adoptReleased(paneid: string, items: readonly DrainedItem[]): void {
  if (!items.length) {
    return;
  }
  const p = q(paneid);
  p.items.push(...items.map((it) => ({ ...it })));
  persist(paneid);
  try {
    flush(paneid);
  } catch (e) {
    log(`room-type: flush threw for ${paneid}: ${(e as Error).message}`);
  }
  notifyHeld(paneid);
}

/** The switch's ONE handover line, typed through the normal guards (startup, idle, no draft). */
export function enqueueHandover(paneid: string, text: string): EnqueueResult {
  if (doorbellOn()) {
    return 'off'; // a handover is another agent's words: never typed in doorbell delivery
  }
  let line = flat(text);
  if (line.endsWith(BACKSLASH)) {
    line += ' ';
  }
  // under the `chat` pseudo-room: no room read-state, like a person's direct chat line
  return enqueueLine(paneid, 'chat', 0, line, { from: 'engine', thread: 'switch', ts: Date.now(), replyNeeded: false });
}

/** Wire from the activity machine's onChange. Idle is the retry trigger. */
export function onActivity(paneid: string, state: string): void {
  /* Gate G item 2: a turn starting after an inject is the `seen` evidence.
     Same callback as the rings: a throw here must never reach them. */
  try {
    reads.onActivity(paneid, state, activity.isBusy(paneid));
  } catch (e) {
    log(`room-reads: onActivity threw for ${paneid}: ${(e as Error).message}`);
  }
  const p = queues.get(paneid);
  if (!p) {
    return;
  }
  if (state !== 'idle' && state !== 'background' && state !== 'streaming') {
    notifyHeld(paneid); // the reason may have moved (not-idle, busy)
    return;
  }
  /* A vendor with a typing spec clears only on a turn the hooks counted: the
     engine's own typed text makes the ring go streaming -> idle with NO turn
     behind it, which used to free the next line onto an unsubmitted one. */
  const sawTurn = !strictSubmit(paneid) || activity.turnCount(paneid) > p.turnsAtInject;
  if (state !== 'streaming' && sawTurn) {
    /* the previous line's turn is over; a turn STARTING is not that, or every
       queued line would be typed into one turn (still one line per turn) */
    p.awaitingIdle = false;
  }
  /* Runs inside the activity machine's onChange: a throw here must never
     break the rings or presence riding the same callback. */
  try {
    flush(paneid);
  } catch (e) {
    log(`room-type: flush threw for ${paneid}: ${(e as Error).message}`);
  }
}

export function onPaneEnded(paneid: string): void {
  const p = queues.get(paneid);
  if (p?.timer) {
    clearTimeout(p.timer);
  }
  if (p && p.items.length) {
    log(`room-type: ${paneid} ended with ${p.items.length} untyped line(s) — dropped (the room line still holds them)`);
    for (const c of p.items.flatMap(coversOf)) {
      reads.onDropped(c.roomId, c.entryId, paneid, 'pane-ended');
    }
  }
  reads.onPaneEnded(paneid);
  queues.delete(paneid);
  try {
    table.dropTyperState(paneid);
  } catch {
    /* never fatal */
  }
  vendorLogged.delete(paneid);
  if (lastHeld.delete(paneid)) {
    announceRooms(paneid, null); // its viewers were told pane.exit; its ROOMS were not
  }
  owners.delete(paneid);
  ownAsks.delete(paneid);
}
sessions.onRemove(onPaneEnded);

/**
 * Retry a held queue a SETTLE later, never synchronously. Two holds lift with
 * no activity transition behind them — the startup block (a REPL that drew its
 * composer is already idle) and a draft going clean in a pane that stays idle
 * (live, @the design system 2026-09-25: typing diag `lastAt` stuck for hours) — so each
 * needs its own trigger. Both fire from inside an input handler or the pty
 * pump, before the human's keystroke has even reached the pty, and a prompt
 * that keystroke answered may be about to draw its successor: waiting one
 * settle period lets the guards (startup, busy, settling) see what follows.
 */
function retrySoon(paneid: string): void {
  const p = queues.get(paneid);
  if (!p || !p.items.length) {
    return;
  }
  notifyHeld(paneid); // startup cleared / draft clean: the reason moved now
  if (p.timer) {
    clearTimeout(p.timer);
  }
  p.timer = setTimeout(() => {
    p.timer = null;
    try {
      flush(paneid); // a throw in a timer is engine-fatal
    } catch (e) {
      log(`room-type: flush threw for ${paneid}: ${(e as Error).message}`);
    }
  }, settleMs() + 25);
  p.timer.unref?.();
}
startup.onClear(retrySoon);
btTools.onListed(retrySoon);
/* S0 guard 5: `? for shortcuts` after a startup prompt = an empty input box
   (the draft parse may be `unknown` from the Esc/arrows that answered it). */
startup.onDraftReset((paneid) => activity.clearUncountedDraft(paneid));
activity.onDraftClean(retrySoon);
/* [one queued] FIX 3: a completed turn (Stop, or the watchdog's lost Stop) is what lets a
   queueing CLI's held run go — a settle later, so Codex's own queued input is submitted first. */
activity.onTurnDone((paneid) => {
  if (typingOf(paneid)?.queuesWhileBusy) {
    retrySoon(paneid);
  }
});
/* [ticket] a prompt drawn or answered moves the hold's reason: announce it
   (room seat, solo held line) and, when it cleared, retry a settle later. */
promptBlock.onChange((paneid) => retrySoon(paneid));

/** Counts only — never message content. */
export function diag(): Record<string, unknown> {
  const panes: Record<string, unknown> = {};
  for (const [paneid, p] of queues) {
    const held = heldFor(paneid);
    panes[paneid] = {
      depth: p.items.length,
      awaitingIdle: p.awaitingIdle,
      lastResult: p.lastResult,
      lastAt: p.lastAt,
      injected: p.injected,
      dropped: p.dropped,
      held,
      /* Guard 8: a startup hold carries what the gate last saw (the prompt's
         context, clearedBy, the CC version) so a false hold can be read.
         gemini-cli (ticket) has its own, much smaller gate. */
      ...(vendorOf(paneid) === 'gemini-cli'
        ? held?.reason === 'startup' || held?.reason === 'busy' || held?.reason === 'needs-you'
          ? { geminiGate: geminiGate.diag().panes[paneid] ?? null }
          : {}
        : held?.reason === 'startup'
          ? { startup: startup.diagFor(paneid) ?? null }
          : {}),
    };
  }
  return { enabled: enabled(), settleMs: settleMs(), queueMax: QUEUE_MAX, textMax: TYPE_TEXT_MAX, panes, startup: startup.diag(), geminiGate: geminiGate.diag() };
}

/** Tests only. */
export function reset(): void {
  for (const p of queues.values()) {
    if (p.timer) clearTimeout(p.timer);
  }
  queues.clear();
  vendorLogged.clear();
  lastHeld.clear();
  owners.clear();
  ownAsks.clear();
}
