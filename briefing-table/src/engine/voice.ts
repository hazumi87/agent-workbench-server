/* ============================================================================
 * THE VOICE CHANNEL — engine half (ticket, P2). Contract: the design notes.
 *
 * the voice service owns "what did he mean"; this module owns "which process gets it":
 *   - the channel SET and which one is FOCUSED (in memory, never the table)
 *   - typing a framed utterance INTO the pane's pty, behind ONE guard
 *     (2026-09-24, Owner: hands-free — drafts and running turns no longer hold):
 *       BUSY  — a dialog is up inside a turn (activity.isDialogUp); an Enter
 *               typed then answers the dialog, whose default is Yes
 *     A guarded utterance is HELD, visible on the pane, until the human
 *     releases it (POST /api/voice/held/:utteranceId) — never auto-injected.
 *   - the RETURN ADDRESS per channel (the device that sent the last utterance)
 *   - carrying the agent's short reply back to the voice service's /api/voice/deliver
 *
 * IN MEMORY BY DESIGN: channels, holds, undelivered replies and the
 * idempotency set survive a window reload, NOT an engine restart. No utterance
 * or reply TEXT is ever logged or put in the diag — counts and lengths only.
 * Held/undelivered text does travel to the PANE's own viewers in pane.voice:
 * it is the user's own words and the agent's own reply, shown where they were
 * meant to land.
 *
 * THE `[voice · …]` PREFIX IS LOAD-BEARING: an injected line always starts
 * with `[`, so an utterance can never begin a `/` (slash command) or `!`
 * (shell escape) line in Claude Code, whatever was said.
 *
 * Crawl: only `vendor === 'claude-code'` panes are voice targets (typing into a
 * cli-manager shell would RUN the text as a command), and one channel at a
 * time — opening a second MOVES it. The state is still a SET plus a FOCUS so
 * Walk's several-channels-one-focused needs no reshaping. `room:<id>` channels
 * are engine/room-voice.ts's (the design notes): the routes send them there,
 * and inbound hands a validated room utterance to the hook it registers.
 *
 * Flag: HARBOR_WB_VOICE=1. Off, every route answers 404 and pane.voice is
 * never sent (paneVoice() returns null).
 * ========================================================================== */

import { engineWrite } from './pty-write.ts';
import * as connectorBridge from './connector-bridge.ts';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as sessions from './sessions.ts';
import * as activity from './activity.ts';
import * as titles from './session-titles.ts';
import { projectBasename } from './agent-slug.ts';
import { table } from '../table/endpoint.ts';
import { instancePath } from './data-dir.ts';


export function enabled(): boolean {
  return process.env.HARBOR_WB_VOICE === '1' && process.env.HARBOR_WB_HOSTED !== '1'; // off in the hosted pilot
}

/** Speakers allowed to type into a shell by voice (contract §3a, floor 1). */
export function allowedSids(): string[] {
  return (process.env.HARBOR_WB_VOICE_SIDS ?? 'ef01f7ee2166')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const voiceUrl = (): string => (process.env.HARBOR_WB_VOICE_URL || '').replace(/\/+$/, '');
const tokenFile = (): string => {
  const f = process.env.HARBOR_WB_VOICE_TOKEN_FILE || '';
  return isAbsolute(f) ? f : instancePath(f);
};
const deliverTimeoutMs = (): number => Number(process.env.HARBOR_WB_VOICE_TIMEOUT_MS) || 45_000;
const enterDelayMs = (): number => Number(process.env.HARBOR_WB_VOICE_ENTER_MS) || 150;

export const INBOUND_TEXT_MAX = 2000;
export const REPLY_TEXT_MAX = 500; // mirrors the voice service's own cap; it answers 413 over it
const PER_PANE_MAX = 20; // held / undelivered, each

/* Voice targets in Crawl. */
const VOICE_VENDORS = new Set(['claude-code']);

/* ---- deps handed in from the server (no import of server/index.ts) ------- */
export interface VoiceDeps {
  /** Send one event to every viewer of a pane; returns the viewer count. */
  toPane(paneid: string, msg: Record<string, unknown>): number;
  log(line: string): void;
  /** GUARD 9 FOR VOICE (assemble-room review finding #3): is an interactive
   *  claude this pane's session? A FRESH /proc read (index.ts), asked
   *  immediately before every inject. 'none' (bash has the pty) or
   *  'not-repl' (a claude has it, but not as its REPL): the utterance is
   *  refused, never typed (`;`, `&`, `|` or `>` in a transcript would run in
   *  the shell). null = could not tell (not the server): deliver as today. */
  claudeState?(paneid: string): 'repl' | 'none' | 'not-repl' | null;
  /** S0 GUARD 3 (assemble-room §4.4 item 3): the pane's startup block, or
   *  null when it is not held. A spoken line would ANSWER a startup dialog
   *  (the old-session default compacts), so the utterance is refused. The
   *  restart hold does not exist yet (S2): startup only. */
  startupHold?(paneid: string): { prompt: string | null } | null;
}

/** The no-claude 409 body (inbound and release), or null when claude is the
 *  pane's REPL or the probe could not tell. */
function noClaude(paneid: string, who: { channelId: string | null; name: string; vendor: string }): Record<string, unknown> | null {
  const st = deps.claudeState?.(paneid) ?? null;
  if (st !== 'none' && st !== 'not-repl') {
    return null;
  }
  return st === 'not-repl'
    ? { delivered: false, error: 'no-claude', detail: 'not-interactive', message: `a claude is running in ${who.name} but not as its interactive session`, ...who }
    : { delivered: false, error: 'no-claude', message: `claude isn't running in ${who.name}`, ...who };
}
/** The startup 409 body (guard 3), or null when the pane is past startup. */
function startupRefusal(paneid: string, who: { channelId: string | null; name: string; vendor: string }): Record<string, unknown> | null {
  const hold = deps.startupHold?.(paneid) ?? null;
  if (!hold) {
    return null;
  }
  return {
    delivered: false,
    error: 'startup',
    message: `a startup prompt is up in ${who.name}: look at the window`,
    ...(hold.prompt ? { prompt: hold.prompt } : {}),
    ...who,
  };
}
let deps: VoiceDeps = { toPane: () => 0, log: () => {} };
export function setDeps(d: VoiceDeps): void {
  deps = d;
}

/* ---- state ---------------------------------------------------------------- */
interface ReturnAddress {
  device: string;
  utteranceId: string;
  sid: string;
  speaker: string;
}
interface Channel {
  channelId: string;
  paneid: string;
  openedAt: number;
  ret: ReturnAddress | null;
}
export type HoldReason = 'draft' | 'busy';
interface Held {
  utteranceId: string;
  text: string;
  ts: string;
  reason: HoldReason;
  speaker: string;
  device: string;
  confidence: number;
  match: string;
}
interface Undelivered {
  replyId: string;
  text: string;
  ts: string;
  error: string;
}
const channels = new Map<string, Channel>();
let focus: string | null = null;
const held = new Map<string, Held[]>(); // paneid → held utterances
const undelivered = new Map<string, Undelivered[]>(); // paneid → replies the voice service did not play

const counts = {
  inboundDelivered: 0,
  inboundHeldDraft: 0,
  inboundHeldBusy: 0,
  inboundRefused: 0,
  inboundReplayed: 0,
  released: 0,
  dismissed: 0,
  repliesDelivered: 0,
  repliesFailed: 0,
};
/* The P4 miss-log source: routing facts, confidence/match, the voice service timing — never
   the words. */
interface VoiceEvent {
  ts: number;
  kind: string;
  channelId?: string;
  result: string;
  len?: number;
  confidence?: number;
  match?: string;
  timing?: Record<string, number>;
  replayed?: boolean;
}
const events: VoiceEvent[] = [];
function record(e: Omit<VoiceEvent, 'ts'>): void {
  events.push({ ts: Date.now(), ...e });
  while (events.length > 20) {
    events.shift();
  }
}

/* Idempotency on utteranceId: a retry returns the ORIGINAL answer and is never
   injected twice. Bounded; Map iteration order is insertion order. */
const IDEM_MAX = 500;
const seen = new Map<string, { status: number; body: Record<string, unknown> }>();
function remember(id: string, status: number, body: Record<string, unknown>): void {
  seen.set(id, { status, body });
  while (seen.size > IDEM_MAX) {
    seen.delete(seen.keys().next().value as string);
  }
}

type Parsed = { kind: 'pane'; paneid: string } | { kind: 'room'; id: string } | null;
function parseChannel(channelId: unknown): Parsed {
  if (typeof channelId !== 'string') {
    return null;
  }
  if (channelId.startsWith('pane:') && channelId.length > 5) {
    return { kind: 'pane', paneid: channelId.slice(5) };
  }
  if (channelId.startsWith('room:') && channelId.length > 5) {
    return { kind: 'room', id: channelId.slice(5) };
  }
  return null;
}
const channelOf = (paneid: string): string => `pane:${paneid}`;

/* ROOM UTTERANCES (the design notes §5): inbound validates (control chars,
   413, utteranceId idempotency) exactly as for a pane — the speaker allowlist
   is the room's (its idInRoom setting), so it rides as speakerVerified —
   then hands a `room:` channel to the hook engine/room-voice.ts registers.
   A hook, not an import, so this module never learns about rooms. */
export interface RoomUtterance {
  roomId: string;
  text: string;
  device: string;
  speaker: string;
  sid: string;
  /** sid is in allowedSids(); the room refuses an unverified one unless its
   *  idInRoom is false. */
  speakerVerified: boolean;
  utteranceId: string;
  confidence: number;
  match: string;
  raw: Record<string, unknown>;
  /** The user key behind the caller's credential (room-voice v3.6): whose
   *  voice globals apply. Absent = the owner. */
  userKey?: string;
}
let roomInbound: ((u: RoomUtterance) => HttpAnswer) | null = null;
export function setRoomInbound(fn: (u: RoomUtterance) => HttpAnswer): void {
  roomInbound = fn;
}

/** ONE connection per device (room-voice §3): a room opened on `device`
 *  closes the pane channels that device speaks into — and one nobody has
 *  spoken into yet, which in Crawl (one channel, one Dot) is the same one. */
export function closeForDevice(device: string): void {
  for (const c of [...channels.values()]) {
    if (!c.ret || c.ret.device === device) {
      closeInternal(c.channelId, 'moved');
    }
  }
}

/** A pane can hold a channel only while it has a live resident. */
function paneIsLive(paneid: string): boolean {
  return sessions.isLive(sessions.get(paneid)) && table.get(paneid)?.state === 'live';
}

/** Drop channels whose pane went away without us hearing (belt and braces
 *  beside the sessions.onRemove observer). */
function prune(): void {
  for (const c of [...channels.values()]) {
    if (!paneIsLive(c.paneid)) {
      closeInternal(c.channelId, 'pane-gone');
    }
  }
}

/* ---- naming: the SAME display name the manager row shows ----------------- */
export function nameFor(paneid: string): string {
  const row = table.get(paneid) as any;
  if (!row) {
    return paneid;
  }
  /* ticket precedence: the SESSION's title, then the project's friendlyName. */
  return titles.known(row.recipe_id, row.session_id) || row.friendlyName || paneid;
}

function aliasesFor(paneid: string): string[] {
  const row = table.get(paneid) as any;
  const rec = row?.recipe_id ? (table.getRecipe(row.recipe_id) as any) : null;
  const raw = [rec?.name, rec?.projectDir ? projectBasename(rec.projectDir) : null, row?.agent];
  const out: string[] = [];
  for (const a of raw) {
    const v = typeof a === 'string' ? a.trim().toLowerCase() : '';
    if (v && !out.includes(v)) {
      out.push(v);
    }
  }
  return out;
}

const vendorFor = (paneid: string): string => (table.get(paneid) as any)?.vendor || 'unknown';

function describe(c: Channel) {
  return {
    channelId: c.channelId,
    name: nameFor(c.paneid),
    aliases: aliasesFor(c.paneid),
    slug: (table.get(c.paneid) as any)?.agent ?? null,
    vendor: vendorFor(c.paneid),
    state: 'live' as const,
    openedAt: new Date(c.openedAt).toISOString(),
  };
}

export function list() {
  prune();
  return { focus, channels: [...channels.values()].map(describe) };
}

/* ---- pane.voice: facts only, the WHOLE state, on every change + attach ---- */
/** The pane.voice event for one pane, or null when voice is switched off —
 *  the attach path sends whatever this returns, so off means never sent. */
export function paneVoice(paneid: string): Record<string, unknown> | null {
  if (!enabled()) {
    return null;
  }
  const cid = channelOf(paneid);
  return {
    type: 'pane.voice',
    paneid,
    channelId: cid,
    open: channels.has(cid),
    focused: focus === cid,
    held: (held.get(paneid) ?? []).map((h) => ({ utteranceId: h.utteranceId, text: h.text, ts: h.ts, reason: h.reason })),
    undelivered: (undelivered.get(paneid) ?? []).map((u) => ({ replyId: u.replyId, text: u.text, ts: u.ts, error: u.error })),
  };
}

function announce(paneid: string): void {
  const msg = paneVoice(paneid);
  if (msg) {
    deps.toPane(paneid, msg);
  }
}

/* ---- open / close / focus -------------------------------------------------- */
function closeInternal(channelId: string, why: string): void {
  const c = channels.get(channelId);
  if (!c) {
    return;
  }
  channels.delete(channelId);
  if (focus === channelId) {
    focus = channels.keys().next().value ?? null;
  }
  record({ kind: 'close', channelId, result: why });
  deps.log(`voice: channel closed ${channelId} (${why})`);
  announce(c.paneid);
  if (focus) {
    const f = channels.get(focus);
    if (f) {
      announce(f.paneid);
    }
  }
}

/** The result shape T4's `/voice on` consumes: {ok} or {error, field}. */
export type VoiceOp = { ok: true } | { ok: false; error: string; field: string };
const opErr = (error: string, field = 'channelId'): VoiceOp => ({ ok: false, error, field });

/** HTTP status for a VoiceOp error — one table, so a route cannot drift. */
export function statusOf(error: string): number {
  switch (error) {
    case 'unknown-channel':
      return 404;
    case 'not-open':
      return 409;
    case 'not-yet':
      return 501;
    default:
      return 400; // bad-channel-id, not-a-voice-target, missing field
  }
}

/** Open a channel (and FOCUS it). Crawl: an open channel elsewhere MOVES here —
 *  the old one closes and both panes hear pane.voice. */
export function open(channelId: string): VoiceOp {
  const p = parseChannel(channelId);
  if (!p) {
    return opErr('bad-channel-id');
  }
  if (p.kind === 'room') {
    return opErr('not-yet'); // workrooms: a room channel is a room-line entry, never typed
  }
  if (!paneIsLive(p.paneid)) {
    return opErr('unknown-channel');
  }
  if (!VOICE_VENDORS.has(vendorFor(p.paneid))) {
    return opErr('not-a-voice-target');
  }
  for (const other of [...channels.keys()]) {
    if (other !== channelId) {
      closeInternal(other, 'moved');
    }
  }
  if (!channels.has(channelId)) {
    channels.set(channelId, { channelId, paneid: p.paneid, openedAt: Date.now(), ret: null });
    record({ kind: 'open', channelId, result: 'opened' });
    deps.log(`voice: channel opened ${channelId}`);
  }
  focus = channelId;
  announce(p.paneid);
  return { ok: true };
}

export function close(channelId: string): VoiceOp {
  const p = parseChannel(channelId);
  if (!p) {
    return opErr('bad-channel-id');
  }
  if (p.kind === 'room') {
    return opErr('not-yet');
  }
  if (!channels.has(channelId)) {
    return opErr('unknown-channel');
  }
  closeInternal(channelId, 'closed');
  return { ok: true };
}

export function setFocus(channelId: string): VoiceOp {
  const p = parseChannel(channelId);
  if (!p) {
    return opErr('bad-channel-id');
  }
  if (p.kind === 'room') {
    return opErr('not-yet');
  }
  if (!paneIsLive(p.paneid)) {
    return opErr('unknown-channel');
  }
  if (!channels.has(channelId)) {
    return opErr('not-open');
  }
  const prev = focus;
  focus = channelId;
  if (prev && prev !== channelId) {
    const pp = channels.get(prev);
    if (pp) {
      announce(pp.paneid);
    }
  }
  announce(p.paneid);
  return { ok: true };
}

/** The pane's process ended: its channel, holds and undelivered replies go
 *  with it (the session is over; the post-it had nowhere left to stick). */
export function onPaneEnded(paneid: string): void {
  held.delete(paneid);
  undelivered.delete(paneid);
  injected.delete(paneid);
  closeInternal(channelOf(paneid), 'pane-ended');
}
sessions.onRemove(onPaneEnded);

/* ---- the guards ------------------------------------------------------------ */
/** Why an utterance cannot be typed into this pane right now, or null.
 *
 *  Owner, 2026-09-24, after two live utterances were held as drafts: speech is
 *  hands-free, so nothing waits on a click. A half-typed draft does NOT hold
 *  (the utterance is appended to it and submitted), and a running turn does NOT
 *  hold (Claude Code queues input typed mid-turn). The ONE hold left is a
 *  dialog on screen: the injected Enter would answer a permission prompt on
 *  his behalf, which is not something a voice turn may do silently. */
function guard(paneid: string): HoldReason | null {
  return activity.isDialogUp(paneid) ? 'busy' : null;
}

/** Type a framed utterance into the pane. Throws if the pty is gone. */
/* WHAT THE ENGINE ACTUALLY WROTE, per pane: pty.write calls that returned and
   their UTF-8 byte count — never the content. Added because on a Windows
   (ConPTY) pane the route said delivered:true and the codeword never showed in
   the output; this is the engine's half of the answer, independent of any
   echo a TUI may or may not produce. */
const injected = new Map<string, { count: number; bytes: number; enters: number }>();
function noteWrite(paneid: string, data: string, isEnter: boolean): void {
  const n = injected.get(paneid) ?? { count: 0, bytes: 0, enters: 0 };
  n.bytes += Buffer.byteLength(data, 'utf8');
  if (isEnter) {
    n.enters++;
  } else {
    n.count++;
  }
  injected.set(paneid, n);
}

/* OBSERVERS of an inject (the screen model's shadow log, the design notes
   §5), told after the text write. Cannot change the inject; a throw stays here. */
const injectTaps: Array<(paneid: string) => void> = [];
export function onInjected(fn: (paneid: string) => void): void {
  injectTaps.push(fn);
}

function inject(paneid: string, speaker: string, device: string, text: string): void {
  const resident = sessions.get(paneid);
  if (!resident || !sessions.isLive(resident)) {
    throw new Error('no live resident');
  }
  if (connectorBridge.isOwned(paneid)) {
    throw new Error('connector-owned: raw terminal input is refused'); // [connector] one writer
  }
  const framed = `[voice · ${speaker} · ${device} · reply with voice-reply] ${text}`;
  engineWrite(paneid, resident.cli.pty, framed, 'voice');
  noteWrite(paneid, framed, false);
  for (const fn of injectTaps) {
    try {
      fn(paneid);
    } catch {
      /* an observer must never reach the inject */
    }
  }
  /* ENTER AS ITS OWN WRITE, a beat later. UNVERIFIED (P2 gate item i): a TUI
     can read one fast chunk ending in CR as a PASTE, where the CR is a newline
     rather than a submit. The gate settles it by the UserPromptSubmit hook. */
  setTimeout(() => {
    try {
      engineWrite(paneid, resident.cli.pty, '\r', 'voice');
      noteWrite(paneid, '\r', true);
    } catch {
      /* pty gone between the two writes */
    }
  }, enterDelayMs());
}

/* ---- inbound: the voice service → the pane --------------------------------------------- */
const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null;
/* Any C0 control character or DEL. ESC would interrupt a turn, CR/LF would
   submit, BS/Ctrl-U would edit the line — none has a place in a transcript. */
const CONTROL = /[\x00-\x1f\x7f]/;

export interface HttpAnswer {
  status: number;
  body: Record<string, unknown>;
}

export function inbound(raw: unknown, userKey?: string): HttpAnswer {
  const b = (raw ?? {}) as Record<string, unknown>;
  const bad = (field: string, error: string): HttpAnswer => {
    counts.inboundRefused++;
    record({ kind: 'inbound', result: `400:${field}` });
    return { status: 400, body: { error, field } };
  };
  if (typeof b.text !== 'string' || !b.text.trim()) {
    return bad('text', 'text is required (the raw transcript, one line)');
  }
  if (CONTROL.test(b.text)) {
    return bad('text', 'text must not contain control characters (C0 or DEL) — one plain line');
  }
  for (const f of ['device', 'speaker', 'sid', 'utteranceId'] as const) {
    if (!str(b[f])) {
      return bad(f, `${f} is required (non-empty string, <= 200 chars)`);
    }
    if (CONTROL.test(b[f] as string)) {
      return bad(f, `${f} must not contain control characters`);
    }
  }
  if (typeof b.confidence !== 'number' || !Number.isFinite(b.confidence)) {
    return bad('confidence', 'confidence is required (number)');
  }
  if (b.match !== 'full' && b.match !== 'sticky') {
    return bad('match', 'match must be full|sticky');
  }
  if (b.channelId !== undefined && b.channelId !== null && !str(b.channelId)) {
    return bad('channelId', 'channelId, when present, must be a non-empty string');
  }
  const text = b.text.trim();
  const confidence = b.confidence;
  const match = b.match;
  if (text.length > INBOUND_TEXT_MAX) {
    counts.inboundRefused++;
    record({ kind: 'inbound', result: '413', len: text.length, confidence, match });
    return { status: 413, body: { error: 'too_long', field: 'text', max: INBOUND_TEXT_MAX } };
  }
  const sid = str(b.sid)!;
  const room = parseChannel(str(b.channelId));
  const speakerVerified = allowedSids().includes(sid);
  /* A ROOM applies the allowlist itself: its idInRoom setting may waive it
     (room-voice §10.1). A pane channel always refuses. */
  if (!speakerVerified && room?.kind !== 'room') {
    counts.inboundRefused++;
    record({ kind: 'inbound', result: '403', confidence, match });
    return { status: 403, body: { error: 'speaker-not-allowed' } };
  }
  const utteranceId = str(b.utteranceId)!;
  const prior = seen.get(utteranceId);
  if (prior) {
    counts.inboundReplayed++;
    record({ kind: 'inbound', result: 'replayed', confidence, match });
    return { status: prior.status, body: { ...prior.body, replayed: true } };
  }

  if (room?.kind === 'room') {
    const out = roomInbound
      ? roomInbound({ roomId: room.id, text, device: str(b.device)!, speaker: str(b.speaker)!, sid, speakerVerified, utteranceId, confidence, match, raw: b, userKey })
      : { status: 501, body: { error: 'not-yet', field: 'channelId' } };
    record({ kind: 'inbound', channelId: str(b.channelId)!, result: String(out.status), len: text.length, confidence, match });
    if (out.body.error === 'speaker-not-allowed') {
      counts.inboundRefused++;
    }
    if (out.status === 202) {
      remember(utteranceId, 202, out.body);
    }
    return out;
  }
  prune();
  const channelId = str(b.channelId) ?? focus;
  if (!channelId) {
    counts.inboundRefused++;
    record({ kind: 'inbound', result: '409:no-channel', confidence, match });
    return { status: 409, body: { error: 'no-channel' } };
  }
  const ch = channels.get(channelId);
  if (!ch) {
    counts.inboundRefused++;
    record({ kind: 'inbound', channelId, result: '404', confidence, match });
    return { status: 404, body: { error: 'unknown-channel', field: 'channelId' } };
  }
  const device = str(b.device)!;
  const speaker = str(b.speaker)!;
  /* THE RETURN ADDRESS is recorded even when the utterance is held: the reply
     to a held prompt still belongs to the device he spoke into. */
  ch.ret = { device, utteranceId, sid, speaker };
  const who = { channelId, name: nameFor(ch.paneid), vendor: vendorFor(ch.paneid) };

  const reason = guard(ch.paneid);
  if (reason) {
    const list = held.get(ch.paneid) ?? [];
    list.push({ utteranceId, text, ts: new Date().toISOString(), reason, speaker, device, confidence, match });
    while (list.length > PER_PANE_MAX) {
      list.shift();
    }
    held.set(ch.paneid, list);
    if (reason === 'busy') {
      counts.inboundHeldBusy++;
    } else {
      counts.inboundHeldDraft++;
    }
    record({ kind: 'inbound', channelId, result: `held:${reason}`, len: text.length, confidence, match });
    deps.log(`voice: inbound HELD (${reason}) ${utteranceId} → ${channelId} len=${text.length} conf=${confidence} match=${match}`);
    announce(ch.paneid);
    const body = { delivered: false, held: reason, ...who };
    remember(utteranceId, 202, body);
    return { status: 202, body };
  }

  const refused = noClaude(ch.paneid, who) ?? startupRefusal(ch.paneid, who);
  if (refused) {
    // Refused, not held: speech is hands-free, nobody would release it. Not
    // remembered, so a retry once claude is running (or past its startup
    // prompts, guard 3) delivers.
    counts.inboundRefused++;
    record({ kind: 'inbound', channelId, result: `409:${refused.error}`, confidence, match });
    deps.log(`voice: inbound REFUSED ${utteranceId} → ${channelId}: ${refused.message}`);
    return { status: 409, body: refused };
  }
  try {
    inject(ch.paneid, speaker, device, text);
  } catch (err) {
    counts.inboundRefused++;
    record({ kind: 'inbound', channelId, result: 'inject-failed', confidence, match });
    deps.log(`voice: inject FAILED ${utteranceId} → ${channelId}: ${(err as Error).message}`);
    return { status: 503, body: { error: 'inject-failed', ...who } };
  }
  counts.inboundDelivered++;
  record({ kind: 'inbound', channelId, result: 'delivered', len: text.length, confidence, match });
  deps.log(`voice: inbound DELIVERED ${utteranceId} → ${channelId} len=${text.length} conf=${confidence} match=${match}`);
  const body = { delivered: true, ...who };
  remember(utteranceId, 202, body);
  return { status: 202, body };
}

/* ---- release: the human acts on a held utterance ------------------------- */
/** `send` skips the DRAFT check (the human has seen the draft and chose to
 *  send) but still honours BUSY — a dialog's Enter is never ours to press.
 *  `dismiss` drops it. */
export function release(utteranceId: string, action: unknown): HttpAnswer {
  if (action !== 'send' && action !== 'dismiss') {
    return { status: 400, body: { error: 'action must be send|dismiss', field: 'action' } };
  }
  let paneid: string | null = null;
  let item: Held | undefined;
  for (const [p, list] of held) {
    item = list.find((h) => h.utteranceId === utteranceId);
    if (item) {
      paneid = p;
      break;
    }
  }
  if (!paneid || !item) {
    return { status: 404, body: { error: 'unknown-utterance', field: 'utteranceId' } };
  }
  const drop = () => {
    const rest = (held.get(paneid!) ?? []).filter((h) => h.utteranceId !== utteranceId);
    if (rest.length) {
      held.set(paneid!, rest);
    } else {
      held.delete(paneid!);
    }
  };
  const who = { channelId: channelOf(paneid), name: nameFor(paneid), vendor: vendorFor(paneid) };
  if (action === 'dismiss') {
    drop();
    counts.dismissed++;
    record({ kind: 'release', channelId: who.channelId, result: 'dismissed' });
    announce(paneid);
    return { status: 200, body: { ok: true, dismissed: true, ...who } };
  }
  if (guard(paneid) === 'busy') {
    record({ kind: 'release', channelId: who.channelId, result: 'busy' });
    return { status: 409, body: { delivered: false, error: 'busy', ...who } };
  }
  const refusedRelease = noClaude(paneid, who) ?? startupRefusal(paneid, who);
  if (refusedRelease) {
    record({ kind: 'release', channelId: who.channelId, result: String(refusedRelease.error) });
    return { status: 409, body: refusedRelease };
  }
  try {
    inject(paneid, item.speaker, item.device, item.text);
  } catch {
    return { status: 409, body: { delivered: false, error: 'pane-gone', ...who } };
  }
  drop();
  counts.released++;
  record({ kind: 'release', channelId: who.channelId, result: 'sent', len: item.text.length });
  deps.log(`voice: held ${who.channelId} released by the user len=${item.text.length}`);
  announce(paneid);
  return { status: 200, body: { delivered: true, ...who } };
}

/** Drop an undelivered reply from the pane (the human has read it). */
export function dismissUndelivered(replyId: string, action: unknown): HttpAnswer {
  if (action !== 'dismiss') {
    return { status: 400, body: { error: 'action must be dismiss', field: 'action' } };
  }
  for (const [p, list] of undelivered) {
    if (list.some((u) => u.replyId === replyId)) {
      const rest = list.filter((u) => u.replyId !== replyId);
      if (rest.length) {
        undelivered.set(p, rest);
      } else {
        undelivered.delete(p);
      }
      announce(p);
      return { status: 200, body: { ok: true, dismissed: true } };
    }
  }
  return { status: 404, body: { error: 'unknown-reply', field: 'replyId' } };
}

/* ---- reply: the agent → the voice service → the Dot ------------------------------------ */
export function readToken(): string | null {
  try {
    /* Per call, so a rotation needs no restart; CR stripped as well as spaces
       (a CRLF in a token file cost a day on 2026-09-17). */
    const t = readFileSync(tokenFile(), 'utf8').replace(/[\r\n]/g, '').trim();
    return t || null;
  } catch {
    return null;
  }
}

function numbersOnly(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object') {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n)) {
      out[k] = n;
    }
  }
  return out;
}

/** POST {the voice service}/api/voice/deliver with the engine→the voice service bearer and the client
 *  timeout (45 s). NEVER throws: a timeout is `not_confirmed` (504) — never
 *  "played" (contract §2.3) — and an unreachable the voice service is `unreachable` (502).
 *  Shared by pane replies and room replies / notices (room-voice §7). */
export async function postDeliver(token: string, payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deliverTimeoutMs());
  try {
    const res = await fetch(`${voiceUrl()}/api/voice/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const body = (await res.json().catch(() => null)) as unknown;
    return {
      status: res.status,
      body: typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : { delivered: false, error: `http_${res.status}` },
    };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return { status: aborted ? 504 : 502, body: { delivered: false, error: aborted ? 'not_confirmed' : 'unreachable' } };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the replying pane: paneid ($HARBOR_WB_PANEID, R11) if given, else
 *  the session id ($CLAUDE_CODE_SESSION_ID — contract §5.5, like
 *  /api/handoff). Flat, or nested under `from` (room-voice §7). */
function replyPane(b: Record<string, unknown>): { paneid: string } | { status: number; body: Record<string, unknown>; result: string } {
  const who = b.from && typeof b.from === 'object' && !Array.isArray(b.from) ? (b.from as Record<string, unknown>) : b;
  if (typeof who.paneid === 'string' && who.paneid) {
    return table.get(who.paneid) ? { paneid: who.paneid } : { status: 404, body: { error: 'unknown-pane', field: 'paneid' }, result: '404:paneid' };
  }
  if (typeof who.session_id === 'string' && who.session_id) {
    const row = (table.list() as any[]).find((r) => r.session_id === who.session_id && r.state === 'live');
    return row?.paneid
      ? { paneid: row.paneid }
      : { status: 404, body: { error: 'unknown-session', field: 'session_id' }, result: '404:session_id' };
  }
  return { status: 400, body: { error: 'paneid or session_id is required', field: 'paneid' }, result: '400:paneid' };
}

/* ROOM REPLIES (the design notes §7): a reply from a pane that holds a seat
   in a room with a voice message for it goes to engine/room-voice.ts (the hook
   it registers). null = no room: the pane channel below, unchanged. */
let roomReply: ((paneid: string, text: string, b: Record<string, unknown>) => Promise<HttpAnswer | null>) | null = null;
export function setRoomReply(fn: (paneid: string, text: string, b: Record<string, unknown>) => Promise<HttpAnswer | null>): void {
  roomReply = fn;
}

/** SYNCHRONOUS: the agent's call waits for the voice service's truthful answer (up to 45s),
 *  so the skill sees delivered/413/offline itself. */
export async function reply(raw: unknown): Promise<HttpAnswer> {
  const b = (raw ?? {}) as Record<string, unknown>;
  const fail = (status: number, body: Record<string, unknown>, result: string): HttpAnswer => {
    record({ kind: 'reply', result });
    return { status, body };
  };
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) {
    return fail(400, { error: 'text is required', field: 'text' }, '400:text');
  }
  if (roomReply) {
    const who = replyPane(b);
    const out = 'paneid' in who ? await roomReply(who.paneid, text, b) : null;
    if (out) {
      record({ kind: 'reply', channelId: 'room', result: out.status === 200 ? (out.body.spoken ? 'spoken' : `chat:${String(out.body.reason)}`) : String(out.status), len: text.length });
      return out;
    }
  }
  if (text.length > REPLY_TEXT_MAX) {
    return fail(
      413,
      { delivered: false, error: 'too_long', field: 'text', max: REPLY_TEXT_MAX, length: text.length },
      '413',
    );
  }
  if (b.expectsReply !== undefined && typeof b.expectsReply !== 'boolean') {
    return fail(400, { error: 'expectsReply must be a boolean', field: 'expectsReply' }, '400:expectsReply');
  }
  const who = replyPane(b);
  if (!('paneid' in who)) {
    return fail(who.status, who.body, who.result);
  }
  const paneid = who.paneid;
  prune();
  const channelId = channelOf(paneid);
  const ch = channels.get(channelId);
  if (!ch) {
    return fail(409, { delivered: false, error: 'no-channel', channelId }, '409:no-channel');
  }
  if (!ch.ret) {
    return fail(409, { delivered: false, error: 'no-return-address', channelId }, '409:no-return-address');
  }
  const token = readToken();
  if (!token) {
    return fail(
      503,
      {
        delivered: false,
        error: 'voice-token-missing',
        message: `no bearer for voice-svc at ${tokenFile()} (set HARBOR_WB_VOICE_TOKEN_FILE or place the file)`,
      },
      '503:token',
    );
  }
  const replyId = typeof b.replyId === 'string' && b.replyId.trim() ? b.replyId.trim().slice(0, 120) : `bt-${randomUUID()}`;
  const payload = {
    device: ch.ret.device,
    text,
    channelId,
    name: nameFor(paneid),
    inReplyTo: ch.ret.utteranceId,
    replyId,
    sid: ch.ret.sid,
    expectsReply: b.expectsReply === true,
    paraphrase: 'off',
    vendor: vendorFor(paneid),
  };
  const { status, body } = await postDeliver(token, payload);
  const delivered = body.delivered === true;
  if (delivered) {
    counts.repliesDelivered++;
  } else {
    counts.repliesFailed++;
    const list = undelivered.get(paneid) ?? [];
    list.push({ replyId, text, ts: new Date().toISOString(), error: String(body.error ?? `http_${status}`) });
    while (list.length > PER_PANE_MAX) {
      list.shift();
    }
    undelivered.set(paneid, list);
    announce(paneid);
  }
  record({
    kind: 'reply',
    channelId,
    result: delivered ? 'delivered' : `failed:${String(body.error ?? status)}`,
    len: text.length,
    timing: numbersOnly(body.timing),
    replayed: typeof body.replayed === 'boolean' ? body.replayed : undefined,
  });
  deps.log(`voice: reply ${channelId} → ${ch.ret.device} len=${text.length} ${delivered ? 'delivered' : `NOT delivered (${String(body.error)})`}`);
  return { status, body: { ...body, replyId, channelId } };
}

/* ---- diag ------------------------------------------------------------------ */
export function diag() {
  return {
    enabled: enabled(),
    focus,
    channels: [...channels.values()].map((c) => ({
      channelId: c.channelId,
      paneid: c.paneid,
      openedAt: new Date(c.openedAt).toISOString(),
      live: paneIsLive(c.paneid),
      returnAddress: c.ret ? { device: c.ret.device, utteranceId: c.ret.utteranceId, sid: c.ret.sid } : null,
      draft: activity.draftState(c.paneid),
      adopted: !!sessions.get(c.paneid)?.adopted,
      busy: activity.isBusy(c.paneid),
    })),
    holds: [...held.entries()].flatMap(([paneid, list]) =>
      list.map((h) => ({
        utteranceId: h.utteranceId,
        paneid,
        reason: h.reason,
        ts: h.ts,
        len: h.text.length,
        confidence: h.confidence,
        match: h.match,
      })),
    ),
    undelivered: [...undelivered.entries()].flatMap(([paneid, list]) =>
      list.map((u) => ({ replyId: u.replyId, paneid, error: u.error, ts: u.ts, len: u.text.length })),
    ),
    allowedSids: allowedSids(),
    voiceUrl: voiceUrl(),
    tokenPresent: readToken() !== null,
    counts: { ...counts },
    /* per pane: framed writes, Enter writes, total UTF-8 bytes. No content. */
    injected: Object.fromEntries(injected),
    events: [...events],
  };
}
