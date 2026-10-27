/* ============================================================================
 * ROOM VOICE — engine half, E1b [ticket]. Contract: the design notes (§15
 * is authoritative over the prose).
 *
 * the voice service owns every utterance; this module owns the room's CLOCKS and RECORD:
 *   - room channels (`room:<id>`): open / close / the connections directory,
 *     ONE connection per device (a room or a pane channel; opening one closes
 *     the other for that device)
 *   - the persisted connection row (store: voice_connections), its muted /
 *     waiting flags and its idle clock (the sweep below)
 *   - the engine's own voice panel, exactly one while connected (store)
 *   - inbound room utterances: handle resolution, ONE voice line, delivery to
 *     the seat through the existing ladder with the voice frame, the ledger row
 *   - /said (answer / ignore), the context snapshot and the line search
 *   - telling the voice service the device's state (fire-and-forget)
 *
 * E1c [ticket]: seat replies (re / kind / lint + budget / routing to the voice service),
 * waiting set by a result or question and cleared by the voice service, the ledger's reply
 * columns, the engine's notices (no-ack, timeout) and the stats read.
 *
 * No utterance text is ever logged: counts, ids and lengths only.
 * ========================================================================== */

import { table, RoomError } from '../table/endpoint.ts';
import type { Room, RoomSeat, RoomLineEntry, VoiceConnection } from '../table/endpoint.ts';
import { checkPanelUrl } from './panel-url.ts';
import { projectBasename } from './agent-slug.ts';
import * as voice from './voice.ts';
import type { HttpAnswer, RoomUtterance } from './voice.ts';
import { combineVoice, type RoomVoiceSettings } from './room-voice-settings.ts';

/* ---- deps handed in from the server (no import of server/*) -------------- */
export interface RoomVoiceDeps {
  /** rooms.deliverToSeat: the ladder (channel > typed > badge). */
  deliver(room: Room, seat: RoomSeat, entry: RoomLineEntry, body: string): { paneid: string | null; delivered: boolean; queued: boolean; typed?: string };
  /** The roster as GET /api/rooms/:id derives it (status, occupant.activity). */
  seats(roomId: string): Promise<Record<string, any>[]>;
  /** The person the room serves, by name; null = unknown. */
  userName?(): string | null;
  /** v3.6: the user key whose voice globals apply when no request names a
   *  person (index.ts: voiceOwnerKey). Absent = the shared-token user. */
  ownerKey?(): string;
  log(line: string): void;
}
let deps: RoomVoiceDeps | null = null;
const log = (line: string): void => deps?.log(line);

/** The idle timeout's hook: the timeout notice (E1c) unless a test swaps it. */
type OnTimeout = (room: Room | undefined, device: string, muted?: boolean) => void;
let onTimeout: OnTimeout = (room, device, muted) => timeoutNotice(room, device, muted);
export function setOnTimeout(fn: OnTimeout): void {
  onTimeout = fn;
}

const OPEN_CAP_MS = 4 * 60 * 60 * 1000; // an open message holds the idle clock for 4 h at most (§4)
const SEARCH_MAX = 20;
const CONTROL = /[\x00-\x1f\x7f]/;
const ans = (status: number, body: Record<string, unknown>): HttpAnswer => ({ status, body });
const agoS = (ts: number, now = Date.now()): number => Math.max(0, Math.round((now - ts) / 1000));
const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max && !CONTROL.test(v) ? v.trim() : null;
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const channelOf = (roomId: string): string => `room:${roomId}`;

/* ---- the panel URL --------------------------------------------------------- */
export function panelUrlFor(roomId: string): string | null {
  /* Plain http on the VRPC's tailnet IP: the server cannot resolve *.ts.net
     (2026-09-28). The host goes into config.json panelHosts at deploy. */
  const base = (process.env.HARBOR_WB_VOICE_PANEL_BASE || '').replace(/\/+$/, '');
  const checked = checkPanelUrl(`${base}/rooms/${encodeURIComponent(roomId)}/view`);
  if (!checked.ok) {
    /* Not on the allow-list (config.json panelHosts): no panel. The host then
       draws its own Mute/Disconnect (§9.3), so connecting still works. */
    log(`room-voice: no voice panel for ${roomId}: ${checked.error}`);
    return null;
  }
  return checked.url;
}

/* ---- effective settings (§10.1, v3.6) ----------------------------------------- */
const ownerKey = (): string => deps?.ownerKey?.() ?? 'user';
/** The person a connection follows: who opened it; a row from before v3.6 = the owner. */
const connUser = (c: VoiceConnection): string => c.user_key ?? ownerKey();

/**
 * EFFECTIVE VOICE SETTINGS, the ONE place they are resolved. PRECEDENCE, per
 * key: built-in defaults < config.json `voiceDefaults` < what is stored, where
 * the person's globals (enabled, wordCap, idleDisconnect, idleMinutes, inputs,
 * openMic, idOnConnect, idInRoom) and the room's own four (enabled, character,
 * paraphrase, spokenName) never overlap except `enabled`, which is global AND
 * room: the person's switch is a MASTER switch. WHICH person: the voice
 * token's on the the voice service routes, the caller's on the human voice route, and the
 * one who OPENED the connection on the seat reply path and the idle sweep.
 */
export function effectiveVoice(room: Room, userKey: string): RoomVoiceSettings {
  return combineVoice(table.getUserVoice(userKey), room.voice);
}

/** Why voice is off for this person in this room: the global switch first. */
function offScope(room: Room, userKey: string): 'global' | 'room' | null {
  return !table.getUserVoice(userKey).enabled ? 'global' : room.voice.enabled === false ? 'room' : null;
}

/* ---- the room view's `voice` (§15) ----------------------------------------- */
export function viewOf(roomId: string): { connected: true; device: string; since: number; muted: boolean; waiting: boolean; idInRoom: boolean; openMic: boolean } | null {
  const c = table.voiceConnection(roomId);
  const room = c ? table.getRoom(roomId) : undefined;
  const v = c && room ? effectiveVoice(room, connUser(c)) : undefined;
  return c
    ? { connected: true, device: c.device, since: c.opened_at, muted: c.muted, waiting: c.waiting, idInRoom: v?.idInRoom ?? true, openMic: v?.openMic ?? true }
    : null;
}

function leadOf(room: Room): RoomSeat | undefined {
  return room.lead_seat ? table.listSeats(room.id).find((s) => s.id === room.lead_seat) : undefined;
}

/* ---- device state to the voice service (§9.3): fire-and-forget --------------------------- */
function sendState(device: string, roomId: string, conn: VoiceConnection | null, userKey = conn ? connUser(conn) : ownerKey()): void {
  const room = table.getRoom(roomId);
  const token = voice.readToken();
  if (!token) {
    log(`room-voice: device state for ${device} not sent: no voice-svc token`);
    return;
  }
  const body = {
    channelId: conn ? channelOf(roomId) : null,
    name: room?.name ?? roomId,
    muted: conn?.muted ?? false,
    waiting: conn?.waiting ?? false,
    settings: room ? effectiveVoice(room, userKey) : null,
  };
  void fetch(`${voice.voiceUrl()}/api/voice/devices/${encodeURIComponent(device)}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  })
    .then((res) => {
      if (!res.ok) {
        log(`room-voice: device state for ${device} answered ${res.status}`);
      }
    })
    .catch((e) => log(`room-voice: device state for ${device} failed: ${(e as Error)?.message ?? e}`));
}

/** Disconnect a room; tell the voice service unless the device is moving on (its next state
 *  supersedes this one). Returns the connection that ended, or null. */
function disconnect(roomId: string, reason: string, notify = true): VoiceConnection | null {
  const ended = table.disconnectVoice(roomId, reason).result;
  if (ended) {
    log(`room-voice: ${roomId} disconnected (${reason}) from ${ended.device}`);
    if (notify) {
      sendState(ended.device, roomId, null, connUser(ended));
    }
  }
  return ended;
}

/** A device moves on: every room it holds (except `keep`) disconnects. */
export function closeDevice(device: string, reason: string, keep: string | null = null): void {
  for (const c of table.listVoiceConnections()) {
    if (c.device === device && c.room_id !== keep) {
      disconnect(c.room_id, reason, false);
    }
  }
}

/* ---- the connections directory (§3) ---------------------------------------- */
/** `userKey`: the voice token's person. Their global switch off = no rooms. */
export function connections(userKey = ownerKey()): Record<string, unknown> {
  const out = table
    .listRooms({ state: 'open' })
    .filter((r) => !offScope(r, userKey))
    .map((r) => {
      const lead = leadOf(r);
      const c = table.voiceConnection(r.id);
      const aliases: string[] = [];
      const bare = r.name.toLowerCase().split(/\s+/).filter((w) => w && w !== 'room' && w !== 'the').join(' ');
      for (const a of [bare, lead?.handle, r.voice.spokenName?.toLowerCase()]) {
        if (a && !aliases.includes(a)) {
          aliases.push(a);
        }
      }
      return {
        channelId: channelOf(r.id),
        name: r.name,
        aliases,
        kind: 'room',
        state: 'open',
        lead: lead?.handle ?? null,
        seats: table.listSeats(r.id).length,
        connected: c ? { device: c.device, since: c.opened_at } : null,
        idOnConnect: effectiveVoice(r, userKey).idOnConnect, // the voice service enforces it; the engine only reports it
      };
    });
  return { provider: 'briefing-table', connections: out };
}

/* ---- open / close ------------------------------------------------------------ */
export function open(channelId: string, rawDevice: unknown, userKey = ownerKey()): HttpAnswer {
  const roomId = channelId.slice('room:'.length);
  const device = str(rawDevice);
  if (!device) {
    return ans(400, { error: 'device is required (non-empty string, <= 200 chars)', field: 'device' });
  }
  const room = roomId ? table.getRoom(roomId) : undefined;
  if (!room || room.state !== 'open') {
    return ans(404, { error: 'unknown-channel', field: 'channelId' });
  }
  const off = offScope(room, userKey);
  if (off) {
    return ans(409, { error: 'voice-disabled', scope: off });
  }
  /* ONE connection per device: its other room, and its pane channel. */
  closeDevice(device, 'moved', room.id);
  voice.closeForDevice(device);
  const held = table.voiceConnection(room.id);
  if (held && held.device !== device) {
    disconnect(room.id, `taken by ${device}`);
  }
  try {
    const conn = table.connectVoice(room.id, device, panelUrlFor(room.id), userKey).result;
    table.setVoiceConnection(room.id, { touch: true });
    log(`room-voice: ${room.id} connected on ${device}`);
    sendState(device, room.id, conn);
  } catch (e) {
    return roomFail(e);
  }
  return ans(200, { channelId, name: room.name, lead: leadOf(room)?.handle ?? null, voice: effectiveVoice(room, userKey) });
}

export function close(channelId: string, rawReason: unknown): HttpAnswer {
  const roomId = channelId.slice('room:'.length);
  if (!roomId || !table.getRoom(roomId)) {
    return ans(404, { error: 'unknown-channel', field: 'channelId' });
  }
  disconnect(roomId, str(rawReason, 60) ?? 'user');
  return ans(200, { ok: true });
}

function roomFail(e: unknown): HttpAnswer {
  if (e instanceof RoomError) {
    return ans(e.status, { error: e.message, field: e.field });
  }
  return ans(500, { error: (e as Error)?.message ?? String(e) });
}

/* ---- handle resolution (§5, Amendment 3) ------------------------------------- */
export type Resolved = 'exact' | 'alias' | 'fallback-lead';
export function resolveSeat(room: Room, heard: string): { seat: RoomSeat; resolved: Resolved; note?: string } | null {
  const seats = table.listSeats(room.id);
  const lead = seats.find((s) => s.id === room.lead_seat);
  const name = heard.trim().replace(/^@/, '');
  if (name.toLowerCase() === 'lead') {
    return lead ? { seat: lead, resolved: 'exact' } : null;
  }
  const exact = seats.find((s) => s.handle === name);
  if (exact) {
    return { seat: exact, resolved: 'exact' };
  }
  const key = norm(name);
  const hits = key
    ? seats.filter((s) => {
        const recipe = s.recipe_id ? table.getRecipe(s.recipe_id) : undefined;
        return [s.handle, s.project ? projectBasename(s.project) : null, recipe?.name].some((a) => a && norm(a) === key);
      })
    : [];
  if (hits.length === 1) {
    return { seat: hits[0], resolved: 'alias' };
  }
  return lead ? { seat: lead, resolved: 'fallback-lead', note: `the voice agent heard '${name}' and could not match a seat` } : null;
}

/* ---- inbound (§5, §15) -------------------------------------------------------- */
const RUNGS: Record<string, string> = { channel: 'channel', injected: 'typed', vendor: 'badge', off: 'badge' };

export function inbound(u: RoomUtterance): HttpAnswer {
  const room = table.getRoom(u.roomId);
  if (!room || room.state !== 'open') {
    return ans(404, { error: 'unknown-channel', field: 'channelId' });
  }
  const eff = effectiveVoice(room, u.userKey ?? ownerKey()); // the voice token's person
  if (!u.speakerVerified && eff.idInRoom !== false) {
    return ans(403, { error: 'speaker-not-allowed' });
  }
  const conn = table.voiceConnection(room.id);
  if (!conn || conn.device !== u.device) {
    return ans(409, { error: 'no-channel' });
  }
  const r = u.raw.route as Record<string, unknown> | undefined;
  const to = r && typeof r === 'object' && !Array.isArray(r) ? str(r.to) : null;
  if (!to) {
    return ans(400, { error: 'route is {to, confidence, note?}', field: 'route.to' });
  }
  if (r!.confidence !== undefined && (typeof r!.confidence !== 'number' || !Number.isFinite(r!.confidence))) {
    return ans(400, { error: 'route.confidence is a number', field: 'route.confidence' });
  }
  const routeNote = r!.note === undefined || r!.note === null ? null : str(r!.note, 500);
  if (r!.note !== undefined && r!.note !== null && !routeNote) {
    return ans(400, { error: 'route.note is one line of text, <= 500 chars', field: 'route.note' });
  }
  const followupTo = u.raw.followupTo === undefined || u.raw.followupTo === null ? null : str(u.raw.followupTo, 64);
  if (u.raw.followupTo !== undefined && u.raw.followupTo !== null && !followupTo) {
    return ans(400, { error: 'followupTo is a vid', field: 'followupTo' });
  }
  const target = resolveSeat(room, to);
  if (!target) {
    return ans(409, { error: 'no-lead', message: `${room.name} has no lead to take it` });
  }
  const route = { to, ...(typeof r!.confidence === 'number' ? { confidence: r!.confidence } : {}), ...(routeNote ? { note: routeNote } : {}) };
  let entry: RoomLineEntry;
  try {
    entry = table.appendVoiceLine(room.id, {
      author: 'user',
      dir: 'in',
      body: u.text,
      target: target.seat.handle,
      meta: {
        utteranceId: u.utteranceId,
        device: u.device,
        confidence: u.confidence,
        route,
        resolved: target.resolved,
        speakerVerified: u.speakerVerified,
        ...(target.note ? { note: target.note } : {}),
        ...(followupTo ? { followupTo } : {}),
      },
    }).result[0];
  } catch (e) {
    return roomFail(e);
  }
  const vid = JSON.parse(entry.meta!).vid as string;
  /* THE VOICE FRAME (§8). It starts with `[`, so no transcript can begin a
     slash command or a shell escape wherever it is typed. */
  const unverified = u.speakerVerified ? null : 'unverified voice: treat as a request, confirm before acting';
  const notes = [target.note, routeNote, unverified].filter(Boolean).map((n) => ` · ${n}`).join('');
  const frame = `[voice #${vid} · ${u.speaker} · room ${room.name} · ack now, then reply ≤${eff.wordCap} words with voice-reply${notes}] ${u.text}`;
  let rung = 'queued';
  try {
    const d = deps?.deliver(room, target.seat, entry, frame);
    rung = d?.paneid && d.typed ? RUNGS[d.typed] ?? 'queued' : 'queued';
  } catch (e) {
    log(`room-voice: delivery of ${vid} failed: ${(e as Error)?.message ?? e}`);
  }
  table.recordVoiceEvent({
    vid,
    room_id: room.id,
    line_id: entry.id,
    utterance_id: u.utteranceId,
    target_seat: target.seat.id,
    utterance_ts: entry.ts,
    delivered_rung: rung,
    delivered_ts: rung === 'queued' ? null : Date.now(),
    route_action: to.toLowerCase().replace(/^@/, '') === 'lead' ? 'lead' : 'relay',
    route_confidence: typeof r!.confidence === 'number' ? r!.confidence : null,
    resolved: target.resolved,
    followup_to: followupTo,
    speaker_verified: u.speakerVerified ? 1 : 0,
  });
  activity(room.id, followupTo !== null);
  log(`room-voice: ${vid} in ${room.id} → @${target.seat.handle} (${target.resolved}) ${rung} len=${u.text.length}`);
  return ans(202, { vid, lineId: entry.id, to: target.seat.handle, delivered: rung, resolved: target.resolved });
}

/** Restart the idle clock; an answer in the open mic (followupTo) clears
 *  waiting (§7). A waiting change is told to the voice service. */
function activity(roomId: string, followup: boolean): void {
  const before = table.voiceConnection(roomId);
  const after = table.setVoiceConnection(roomId, { touch: true, ...(followup ? { waiting: false } : {}) }).result;
  if (before && after && before.waiting !== after.waiting) {
    sendState(after.device, roomId, after);
  }
}

/** E1c's seam: a result/question sets waiting (§7). */
export function setWaiting(roomId: string, waiting: boolean): void {
  const before = table.voiceConnection(roomId);
  const after = table.setVoiceConnection(roomId, { waiting }).result;
  if (before && after && before.waiting !== after.waiting) {
    sendState(after.device, roomId, after);
  }
}

/** E1c's seam: a delivered reply restarts the idle clock (§4). */
export function touch(roomId: string): void {
  table.setVoiceConnection(roomId, { touch: true });
}

/* ---- /said (§5): answer or ignore -------------------------------------------- */
const saidSeen = new Map<string, HttpAnswer>();
export function said(roomId: string, raw: Record<string, unknown>): HttpAnswer {
  if (raw.action === 'say') {
    return say(roomId, raw);
  }
  for (const f of ['utteranceId', 'device', 'sid'] as const) {
    if (!str(raw[f])) {
      return ans(400, { error: `${f} is required (non-empty string, <= 200 chars)`, field: f });
    }
  }
  if (typeof raw.text !== 'string' || !raw.text.trim() || CONTROL.test(raw.text)) {
    return ans(400, { error: 'text is required (the raw transcript, one line)', field: 'text' });
  }
  const text = raw.text.trim();
  if (text.length > voice.INBOUND_TEXT_MAX) {
    return ans(413, { error: 'too_long', field: 'text', max: voice.INBOUND_TEXT_MAX });
  }
  if (raw.action !== 'answer' && raw.action !== 'ignore') {
    return ans(400, { error: 'action must be answer|ignore', field: 'action' });
  }
  const answer = raw.action === 'answer' ? str(raw.answer, voice.INBOUND_TEXT_MAX) : null;
  if (raw.action === 'answer' && !answer) {
    return ans(400, { error: 'answer is required for action answer (one line)', field: 'answer' });
  }
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) {
    return ans(400, { error: 'confidence is required (number)', field: 'confidence' });
  }
  const followupTo = raw.followupTo === undefined || raw.followupTo === null ? null : str(raw.followupTo, 64);
  if (raw.followupTo !== undefined && raw.followupTo !== null && !followupTo) {
    return ans(400, { error: 'followupTo is a vid', field: 'followupTo' });
  }
  const room = table.getRoom(roomId);
  if (!room || room.state !== 'open') {
    return ans(404, { error: 'no such room', field: 'id' });
  }
  const utteranceId = str(raw.utteranceId)!;
  const prior = saidSeen.get(utteranceId);
  if (prior) {
    return ans(prior.status, { ...prior.body, replayed: true });
  }
  const now = Date.now();
  /* /said never refuses a sid (the voice service already answered); it records whether it was one. */
  const speakerVerified = voice.allowedSids().includes(str(raw.sid)!);
  const base = { room_id: room.id, utterance_id: utteranceId, result_ts: now, route_confidence: raw.confidence, followup_to: followupTo, speaker_verified: speakerVerified ? 1 : 0 };
  let out: HttpAnswer;
  if (raw.action === 'ignore') {
    /* Logged for QA, never on the line: a bare "ok" there would be noise. */
    table.recordVoiceEvent({ ...base, vid: `ignore:${utteranceId}`, utterance_ts: now, route_action: 'ignore' });
    out = ans(200, { lineIds: [] });
  } else {
    try {
      const heard = table.appendVoiceLine(room.id, {
        author: 'user',
        dir: 'in',
        body: text,
        meta: { utteranceId, device: str(raw.device), confidence: raw.confidence, route: { action: 'answer' }, speakerVerified, ...(followupTo ? { followupTo } : {}) },
      }).result[0];
      const vid = JSON.parse(heard.meta!).vid as string;
      const said = table.appendVoiceLine(room.id, { author: 'voice', dir: 'out', body: answer!, meta: { kind: 'answer', re: [vid] } }).result[0];
      table.recordVoiceEvent({ ...base, vid, line_id: heard.id, utterance_ts: heard.ts, route_action: 'answer' });
      out = ans(200, { lineIds: [heard.id, said.id] });
    } catch (e) {
      return roomFail(e);
    }
  }
  saidSeen.set(utteranceId, out);
  while (saidSeen.size > 500) {
    saidSeen.delete(saidSeen.keys().next().value as string);
  }
  activity(room.id, followupTo !== null);
  return out;
}

/* ---- context + search (§6.2) -------------------------------------------------- */
const trim = (s: string | null, max: number): string | null => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s);

export async function context(roomId: string): Promise<HttpAnswer> {
  const room = table.getRoom(roomId);
  if (!room) {
    return ans(404, { error: 'no such room', field: 'id' });
  }
  const now = Date.now();
  const lastBy = table.lastLineBySeat(room.id);
  const roster = deps ? await deps.seats(room.id) : [];
  const handleOf = new Map(table.listSeats(room.id, { includeLeft: true }).map((s) => [s.id, s.handle]));
  const conn = viewOf(room.id);
  const voiceOut = table.listLine(room.id, { kind: 'voice', limit: 50 }).reverse().find((e) => {
    try {
      const m = JSON.parse(e.meta ?? '{}');
      return m.dir === 'out' && m.kind !== 'say' && m.kind !== 'notice'; // "say that again" replays a reply, never a confirmation
    } catch {
      return false;
    }
  });
  const name = deps?.userName?.() ?? null;
  return ans(200, {
    user: { name: name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Owner' },
    room: { name: room.name, mode: room.mode ?? null, lead: leadOf(room)?.handle ?? null },
    seats: roster.map((s) => ({
      handle: s.handle,
      lead: !!s.is_lead,
      state: s.status ?? null,
      activity: s.occupant?.activity ?? null,
      lastLineAgoS: lastBy[s.id] ? agoS(lastBy[s.id], now) : null,
    })),
    tools: table.listPanels(room.id).map((p) => ({ title: p.title, kind: p.kind, seat: p.seat_handle })),
    connection: conn ? { device: conn.device, since: conn.since, muted: conn.muted, waiting: conn.waiting } : null,
    recent: table.listLine(room.id, { limit: 15 }).map((e) => ({ id: e.id, kind: e.kind, author: e.author, target: e.target, body: trim(e.body, 300), agoS: agoS(e.ts, now) })),
    open: table.listVoiceEvents(room.id, { open: true }).map((v) => ({
      vid: v.vid,
      to: v.target_seat ? handleOf.get(v.target_seat) ?? null : null,
      agoS: agoS(v.utterance_ts, now),
      delivered: v.delivered_rung,
      ...(v.ack_ts ? { ackAgoS: agoS(v.ack_ts, now) } : {}),
    })),
    lastSpoken: voiceOut
      ? { vid: JSON.parse(voiceOut.meta!).vid ?? null, author: voiceOut.author, body: voiceOut.body, agoS: agoS(voiceOut.ts, now) }
      : null,
  });
}

export function lines(roomId: string, q: string | null, rawLimit: string | null): HttpAnswer {
  if (!table.getRoom(roomId)) {
    return ans(404, { error: 'no such room', field: 'id' });
  }
  const limit = rawLimit === null || rawLimit === '' ? 5 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX) {
    return ans(400, { error: `limit is 1-${SEARCH_MAX}`, field: 'limit' });
  }
  if (q !== null && q.length > 200) {
    return ans(400, { error: 'q is at most 200 characters', field: 'q' });
  }
  const now = Date.now();
  return ans(200, {
    lines: table.searchLine(roomId, (q ?? '').trim(), limit).map((e) => ({ id: e.id, kind: e.kind, author: e.author, body: e.body, agoS: agoS(e.ts, now) })),
  });
}

/* ---- mute / disconnect -------------------------------------------------------- */
export function setMuted(roomId: string, muted: unknown): HttpAnswer {
  if (typeof muted !== 'boolean') {
    return ans(400, { error: 'muted is true or false', field: 'muted' });
  }
  if (!table.getRoom(roomId)) {
    return ans(404, { error: 'no such room', field: 'id' });
  }
  const before = table.voiceConnection(roomId);
  if (!before) {
    return ans(409, { error: 'not-connected' });
  }
  const after = table.setVoiceConnection(roomId, { muted, touch: true }).result!;
  if (after.muted !== before.muted) {
    sendState(after.device, roomId, after);
  }
  return ans(200, { voice: viewOf(roomId) });
}

export function hangUp(roomId: string, reason: string): HttpAnswer {
  if (!table.getRoom(roomId)) {
    return ans(404, { error: 'no such room', field: 'id' });
  }
  return disconnect(roomId, reason) ? ans(200, { voice: null }) : ans(409, { error: 'not-connected' });
}

/** A live toggle: voice ID (v3.3) or the open mic (v3.4). v3.6: it WRITES
 *  the person's GLOBAL <key>, the one source of truth (Settings shows it),
 *  then tells the voice service like mute. Only while this room is connected. */
function setToggle(roomId: string, key: 'idInRoom' | 'openMic', on: boolean, userKey: string): HttpAnswer {
  const room = table.getRoom(roomId);
  if (!room) {
    return ans(404, { error: 'no such room', field: 'id' });
  }
  const conn = table.voiceConnection(roomId);
  if (!conn) {
    return ans(409, { error: 'not-connected' });
  }
  if (table.getUserVoice(userKey)[key] !== on) {
    try {
      table.setUserVoice(userKey, { [key]: on }); // pushes room.state
    } catch (e) {
      return roomFail(e);
    }
    globalsChanged();
  }
  return ans(200, { voice: viewOf(roomId) });
}

/** POST /api/voice/rooms/:id/verify — voice may TIGHTEN, never LOOSEN: anyone
 *  in earshot could say "turn off voice ID". */
export function verify(roomId: string, raw: Record<string, unknown>, userKey = ownerKey()): HttpAnswer {
  if (raw.on === false) {
    return ans(403, { error: 'voice-cannot-loosen' });
  }
  if (raw.on !== true) {
    return ans(400, { error: 'on must be true (voice may turn voice ID on, never off)', field: 'on' });
  }
  return setToggle(roomId, 'idInRoom', true, userKey);
}

/** POST /api/rooms/:id/voice — the human's panel buttons (§9.3). */
export function humanAction(roomId: string, action: unknown, userKey = ownerKey()): HttpAnswer {
  if (action === 'mute' || action === 'unmute') {
    return setMuted(roomId, action === 'mute');
  }
  if (action === 'id-on' || action === 'id-off') {
    return setToggle(roomId, 'idInRoom', action === 'id-on', userKey);
  }
  if (action === 'openmic-on' || action === 'openmic-off') {
    return setToggle(roomId, 'openMic', action === 'openmic-on', userKey); // no voice verb: human only
  }
  if (action === 'disconnect') {
    return hangUp(roomId, 'panel');
  }
  return ans(400, { error: 'action must be mute|unmute|id-on|id-off|openmic-on|openmic-off|disconnect', field: 'action' });
}

/** A settings PATCH touched `voice`: the voice service never caches room settings (§9.3). */
export function settingsChanged(roomId: string): void {
  const conn = table.voiceConnection(roomId);
  if (!conn) {
    return;
  }
  if (table.getRoom(roomId)?.voice.enabled === false) {
    disconnect(roomId, 'disabled');
    return;
  }
  sendState(conn.device, roomId, conn);
}

/** A person's voice GLOBALS changed (PATCH /api/rooms/me, a live toggle):
 *  every connected room hears its device state; a connection whose person
 *  now has voice off globally is closed like any disconnect. */
export function globalsChanged(): void {
  for (const c of table.listVoiceConnections()) {
    if (!table.getUserVoice(connUser(c)).enabled) {
      disconnect(c.room_id, 'voice off (global)');
    } else {
      sendState(c.device, c.room_id, c);
    }
  }
}

/* ---- TTS lint + budget (§7) ---------------------------------------------------- */
const SUMMARIZE_MAX = 2000; // the voice service's summarize tier takes at most this many chars (§11 V1)

/** Is this slash-joined token a filesystem path? Anything rooted (/x/y, ~/x,
 *  ./x, C:\x) is; a relative one needs 3+ segments or a file extension, so
 *  "and/or", "24/7" and "TCP/IP" stay words. All-digit segments are a date. */
function isPath(m: string): boolean {
  if (/^(?:[A-Za-z]:|~|\.{1,2})?[\\/]/.test(m)) {
    return true;
  }
  const segs = m.split(/[\\/]/).filter(Boolean);
  return !segs.every((x) => /^\d+$/.test(x)) && (segs.length >= 3 || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(m));
}

/** Strip what TTS cannot say (§7): fenced blocks, code spans, backticks, links
 *  (their words kept), URLs, paths, headings, quote and bullet markers,
 *  emphasis (its words kept) and runs of 3+ symbols; whitespace collapsed. */
export function lintForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/`/g, ' ')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi, ' ')
    .replace(/(?:\b[A-Za-z]:)?(?:~|\.{1,2})?[\\/]?[\w.@-]+(?:[\\/][\w.@-]+)+[\\/]?/g, (m) => (isPath(m) ? ' ' : m))
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+/gm, '')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g, '$1$2')
    .replace(/[^\p{L}\p{N}\s]{3,}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The spoken form and whether it is OVER CAP (§7): more words than the room's
 *  cap, or lint stripped more than 20% of the non-space characters (spaces
 *  are layout, not content, so collapsing them never counts), or longer than
 *  the voice service takes verbatim (it would 413). Over cap is never refused. */
export function budget(text: string, wordCap: number): { speak: string; overCap: boolean; words: number; cut: boolean } {
  let speak = lintForSpeech(text);
  const words = speak ? speak.split(' ').length : 0;
  const dense = (x: string): number => x.replace(/\s+/g, '').length;
  const overCap = words > wordCap || dense(speak) < dense(text) * 0.8 || speak.length > voice.REPLY_TEXT_MAX;
  let cut = false;
  if (speak.length > SUMMARIZE_MAX) {
    const head = speak.slice(0, SUMMARIZE_MAX + 1);
    const at = head.lastIndexOf(' ');
    speak = (at > 0 ? head.slice(0, at) : head.slice(0, SUMMARIZE_MAX)).trim();
    cut = true;
  }
  return { speak, overCap, words, cut };
}

/* ---- speaking through the voice service (§7, §15) -------------------------------------------- */
const REPLY_KINDS = ['ack', 'result', 'question', 'info'];
const VID_RE = /^v[0-9a-z]{1,12}$/;
const RE_MAX = 20;
const noAckMs = (): number => Number(process.env.HARBOR_WB_VOICE_NOACK_MS) || 120_000;

/** One deliver to the voice service, mapped to spoken / reason (§7). Never throws: a
 *  timeout is `not_confirmed`, never "played". */
async function speak(device: string, room: Room, fields: Record<string, unknown>): Promise<{ spoken: boolean; reason: string | null; played_ms?: number }> {
  const token = voice.readToken();
  if (!token) {
    return { spoken: false, reason: 'voice-token-missing' };
  }
  const { status, body } = await voice.postDeliver(token, {
    device,
    channelId: channelOf(room.id),
    character: room.voice.character,
    paraphrase: room.voice.paraphrase,
    ...fields,
  });
  if (status === 200 && body.delivered === true) {
    return { spoken: true, reason: null, ...(typeof body.played_ms === 'number' ? { played_ms: body.played_ms } : {}) };
  }
  const reason = typeof body.reason === 'string' ? body.reason : typeof body.error === 'string' ? body.error : `http_${status}`;
  return { spoken: false, reason };
}

/**
 * A seat's reply (POST /api/voice/reply, room form; §7). The hook voice.ts
 * calls with the resolved pane. null = this pane has no room to answer (no
 * seat, or no voice message for its seats): the pane channel takes it.
 *
 * Which room: the first `re` vid the ledger knows, else the room where this
 * pane's seat most recently received a voice message. ONE voice line, written
 * before the voice service is asked (its vid is the replyId) and announced with the outcome.
 */
export async function reply(paneid: string, text: string, b: Record<string, unknown>): Promise<HttpAnswer | null> {
  const kind = b.kind === undefined || b.kind === null ? 'info' : b.kind;
  if (typeof kind !== 'string' || !REPLY_KINDS.includes(kind)) {
    return ans(400, { error: 'kind is ack|result|question|info', field: 'kind' });
  }
  const re = b.re === undefined || b.re === null ? [] : b.re;
  if (!Array.isArray(re) || re.length > RE_MAX || !re.every((v) => typeof v === 'string' && VID_RE.test(v))) {
    return ans(400, { error: `re is a list of at most ${RE_MAX} vids`, field: 're' });
  }
  const vids = [...new Set(re as string[])];
  const held = table.roomsForPane(paneid);
  const named = vids.map((v) => table.getVoiceEvent(v)).find((e) => e && held.some((h) => h.room.id === e.room_id));
  const ev = named ?? table.lastVoiceEventForSeats(held.map((h) => h.seat.id));
  const at = ev ? held.find((h) => h.room.id === ev.room_id) : undefined;
  if (!at) {
    return null;
  }
  const { room, seat } = at;
  const conn = table.voiceConnection(room.id);
  const eff = effectiveVoice(room, conn ? connUser(conn) : ownerKey()); // who opened the connection
  const lint = budget(text, eff.wordCap);
  let reason: string | null = !conn ? 'not-connected' : conn.muted ? 'muted' : !lint.speak ? 'nothing-speakable' : null;
  const meta = { re: vids, kind, spoken: false, overCap: lint.overCap };
  const line = { author: { seatId: seat.id }, dir: 'out' as const, body: text };
  let entry: RoomLineEntry;
  try {
    entry = reason
      ? table.appendVoiceLine(room.id, { ...line, meta: { ...meta, reason } }).result[0]
      : table.startVoiceLine(room.id, { ...line, meta: { ...meta, reason: 'sending' } });
  } catch (e) {
    return roomFail(e);
  }
  const vid = JSON.parse(entry.meta!).vid as string;
  /* v3.4: the open mic governs the reopen for EVERY kind; only a result or a
     question leaves something waiting (§7). */
  const expectsReply = eff.openMic;
  const waits = kind === 'result' || kind === 'question';
  let spoken = false;
  let played: number | undefined;
  if (!reason) {
    if (lint.cut) {
      log(`room-voice: reply ${vid} cut to ${lint.speak.length} chars for the summarize tier`);
    }
    try {
      const out = await speak(conn!.device, room, {
        text: lint.speak,
        name: seat.handle,
        inReplyTo: vids[0] ?? null,
        replyId: vid,
        kind,
        expectsReply,
        ...(lint.overCap ? { overCap: 'summarize', maxWords: eff.wordCap } : {}),
      });
      ({ spoken, reason } = out);
      played = out.played_ms;
    } catch (e) {
      reason = 'error';
      log(`room-voice: reply ${vid} failed: ${(e as Error)?.message ?? e}`);
    } finally {
      table.finishVoiceLine(entry.id, { spoken, reason: reason ?? undefined });
    }
  }
  try {
    if (conn) {
      touch(room.id); // a reply is activity: the idle clock restarts (§4)
    }
    if (waits) {
      setWaiting(room.id, true); // spoken or not (§7); an open-mic answer or the voice service clears it
    }
    const known = vids.filter((v) => table.getVoiceEvent(v)?.room_id === room.id);
    table.markVoiceReply(room.id, seat.id, known, kind, { spoken, reason, overCap: lint.overCap, connected: !!conn });
  } catch (e) {
    log(`room-voice: reply ${vid} bookkeeping failed: ${(e as Error)?.message ?? e}`);
  }
  log(`room-voice: reply ${vid} ${kind} from @${seat.handle} in ${room.id} ${spoken ? 'spoken' : `chat-only (${reason})`}${lint.overCap ? ' over-cap' : ''} len=${text.length}`);
  return ans(200, {
    lineId: entry.id,
    spoken,
    ...(reason ? { reason } : {}),
    ...(lint.overCap ? { overCap: true } : {}),
    ...(played !== undefined ? { played_ms: played } : {}),
  });
}

/** POST /api/voice/rooms/:id/waiting {waiting:false} — the voice service said "what's
 *  waiting" / "say that again" (§7). Only the voice service clears; only a reply sets. */
export function clearWaiting(roomId: string, raw: Record<string, unknown>): HttpAnswer {
  if (raw.waiting !== false) {
    return ans(400, { error: 'waiting must be false (a result or question sets it)', field: 'waiting' });
  }
  if (!table.getRoom(roomId)) {
    return ans(404, { error: 'no such room', field: 'id' });
  }
  if (!table.voiceConnection(roomId)) {
    return ans(409, { error: 'not-connected' });
  }
  setWaiting(roomId, false);
  touch(roomId);
  return ans(200, { voice: viewOf(roomId) });
}

/** /said action "say" (Owner 2026-09-28: every voice-agent utterance lands in
 *  the chat): a line the voice agent SPOKE with no user utterance behind it,
 *  e.g. the connect / disconnect confirmation, mute, voice ID, a readback.
 *  One voice line, author voice; idempotent by utteranceId like the rest. */
function say(roomId: string, raw: Record<string, unknown>): HttpAnswer {
  const utteranceId = str(raw.utteranceId);
  if (!utteranceId) {
    return ans(400, { error: 'utteranceId is required (non-empty string, <= 200 chars)', field: 'utteranceId' });
  }
  const text = str(raw.answer, voice.INBOUND_TEXT_MAX);
  if (!text || CONTROL.test(text)) {
    return ans(400, { error: 'answer is required for action say (one line)', field: 'answer' });
  }
  const room = table.getRoom(roomId);
  if (!room || room.state !== 'open') {
    return ans(404, { error: 'no such room', field: 'id' });
  }
  const prior = saidSeen.get(utteranceId);
  if (prior) {
    return ans(prior.status, { ...prior.body, replayed: true });
  }
  let out: HttpAnswer;
  try {
    const line = table.appendVoiceLine(room.id, { author: 'voice', dir: 'out', body: text, meta: { kind: 'say' } }).result[0];
    out = ans(200, { lineIds: [line.id] });
  } catch (e) {
    return roomFail(e);
  }
  saidSeen.set(utteranceId, out);
  return out;
}

/* ---- the engine's notices (§4, §7): kind notice, ifIdle, never expectsReply --- */
async function notice(room: Room, device: string, text: string, replyId: string): Promise<string> {
  let outcome: string;
  try {
    const out = await speak(device, room, { text, name: 'voice', inReplyTo: null, replyId, kind: 'notice', ifIdle: true, expectsReply: false });
    outcome = out.spoken ? 'spoken' : out.reason ?? 'not-spoken';
  } catch {
    outcome = 'error';
  }
  /* Every voice-agent utterance lands in the chat (Owner 2026-09-28), spoken or not. */
  try {
    table.appendVoiceLine(room.id, { author: 'voice', dir: 'out', body: text, meta: { kind: 'notice', spoken: outcome === 'spoken', ...(outcome === 'spoken' ? {} : { reason: outcome }) } });
  } catch {
    /* the room may have been archived meanwhile: the ledger still has the outcome */
  }
  return outcome;
}

/** NO-ACK (§7): a message delivered in THIS connection with neither ack nor
 *  result after the deadline gets ONE notice. The claim is a column, so a
 *  restart or an overlapping sweep never sends it twice; while muted the row
 *  is marked `muted` and never spoken later (a stale "hasn't picked that up"
 *  is noise — waiting is the persistence). */
function noAckNotices(c: VoiceConnection, room: Room, now: number): void {
  for (const ev of table.voiceEventsDueNotice(room.id, c.opened_at, now - noAckMs())) {
    if (!table.markVoiceNotice(ev.vid, c.muted ? 'muted' : 'sending', true) || c.muted) {
      continue;
    }
    const handle = table.listSeats(room.id, { includeLeft: true }).find((s) => s.id === ev.target_seat)?.handle ?? 'the seat';
    void notice(room, c.device, `${handle} hasn't picked that up yet`, `noack:${ev.vid}`)
      .then((o) => {
        table.markVoiceNotice(ev.vid, o);
        log(`room-voice: no-ack notice for ${ev.vid} in ${room.id}: ${o}`);
      })
      .catch((e) => log(`room-voice: no-ack notice for ${ev.vid} not logged: ${(e as Error)?.message ?? e}`));
  }
}

/** TIMEOUT (§4): "voice timed out on <room>", logged as its own ledger row
 *  (closed at once, so it never holds an idle clock). */
function timeoutNotice(room: Room | undefined, device: string, muted = false): void {
  if (!room) {
    return;
  }
  const now = Date.now();
  const vid = `timeout:${room.id}:${now}`;
  table.recordVoiceEvent({ vid, room_id: room.id, utterance_ts: now, result_ts: now, route_action: 'timeout', notice_ts: now, notice_outcome: muted ? 'muted' : 'sending' });
  if (muted) {
    return;
  }
  void notice(room, device, `voice timed out on ${room.name}`, vid)
    .then((o) => {
      table.markVoiceNotice(vid, o);
      log(`room-voice: timeout notice for ${room.id}: ${o}`);
    })
    .catch((e) => log(`room-voice: timeout notice for ${room.id} not logged: ${(e as Error)?.message ?? e}`));
}

/* ---- stats (§10.3): a report source, no UI -------------------------------------- */
function pcts(xs: number[]): { p50: number | null; p90: number | null } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number | null => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null);
  return { p50: at(0.5), p90: at(0.9) };
}
const pct = (n: number, d: number): number | null => (d ? Math.round((1000 * n) / d) / 10 : null);

/** GET /api/rooms/:id/voice/stats?days= (1-90, default 7). Times are from the
 *  utterance; percentages are null when there is nothing to divide by. Text
 *  reply time: a chat line addressed to a seat → that seat's next line. */
export function stats(roomId: string, rawDays: string | null): HttpAnswer {
  const days = rawDays === null || rawDays === '' ? 7 : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return ans(400, { error: 'days is 1-90', field: 'days' });
  }
  const since = Date.now() - days * 86_400_000;
  const rows = table.listVoiceEvents(roomId).filter((r) => r.utterance_ts >= since);
  const msgs = rows.filter((r) => r.route_action === 'relay' || r.route_action === 'lead');
  const results = msgs.filter((r) => r.result_ts !== null);
  const text = table.textReplyTimes(roomId, since);
  return ans(200, {
    days,
    voice: {
      count: msgs.length,
      ackMs: pcts(msgs.filter((r) => r.ack_ts !== null).map((r) => r.ack_ts! - r.utterance_ts)),
      resultMs: pcts(results.map((r) => r.result_ts! - r.utterance_ts)),
      resultWhileDisconnectedPct: pct(results.filter((r) => r.connected_at_result === 0).length, results.length),
      overCapPct: pct(results.filter((r) => r.over_cap === 1).length, results.length),
      fallbackLeadPct: pct(msgs.filter((r) => r.resolved === 'fallback-lead').length, msgs.length),
      ignoreCount: rows.filter((r) => r.route_action === 'ignore').length,
    },
    text: { count: text.length, replyMs: pcts(text.filter((t) => t.reply_ts !== null).map((t) => t.reply_ts! - t.ts)) },
  });
}

/* ---- the idle clock (§4) ------------------------------------------------------ */
/** Close what has idled out. The clock does not run while a voice message
 *  in the room is OPEN (no result yet), for at most 4 h after it. */
export function sweep(now = Date.now()): void {
  for (const c of table.listVoiceConnections()) {
    try {
      const room = table.getRoom(c.room_id);
      if (!room || room.state !== 'open') {
        disconnect(c.room_id, 'archived');
        continue;
      }
      noAckNotices(c, room, now);
      const eff = effectiveVoice(room, connUser(c));
      if (eff.idleDisconnect === false || now - c.last_activity < eff.idleMinutes * 60_000) {
        continue;
      }
      if (table.listVoiceEvents(c.room_id, { open: true }).some((v) => now - v.utterance_ts < OPEN_CAP_MS)) {
        continue;
      }
      disconnect(c.room_id, 'timeout');
      onTimeout(room, c.device, c.muted);
    } catch (e) {
      log(`room-voice: sweep of ${c.room_id} failed: ${(e as Error)?.message ?? e}`);
    }
  }
}

/* ---- boot --------------------------------------------------------------------- */
let timer: ReturnType<typeof setInterval> | null = null;
/** Wire, reconcile the voice panels (exactly one per connected room, none
 *  elsewhere — also after restarts) and start the idle sweep. */
export function start(d: RoomVoiceDeps): void {
  deps = d;
  voice.setRoomInbound(inbound);
  voice.setRoomReply(reply);
  try {
    const m = table.migrateVoiceGlobals(ownerKey());
    if (m) {
      const seeded = m.seeded ? `seeded ${ownerKey()}'s voice globals from room ${m.seeded.room}: ${JSON.stringify(m.seeded.keys)}` : 'nothing seeded';
      log(`room-voice: v3.6 migration: ${seeded}; global keys stripped from ${m.stripped.length} room(s) ${m.stripped.join(', ')}`.trim());
    }
  } catch (e) {
    log(`room-voice: v3.6 migration failed: ${(e as Error)?.message ?? e}`);
  }
  for (const id of table.voiceRoomIds()) {
    try {
      table.reconcileVoicePanel(id, table.voiceConnection(id) ? panelUrlFor(id) : null);
    } catch (e) {
      log(`room-voice: panel reconcile of ${id} failed: ${(e as Error)?.message ?? e}`);
    }
  }
  if (!timer) {
    timer = setInterval(() => sweep(), Number(process.env.HARBOR_WB_VOICE_SWEEP_MS) || 30_000);
    timer.unref();
  }
}
