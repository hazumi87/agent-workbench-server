/* ============================================================================
 * VOICE CHANNEL ROUTES (ticket, P2) — the design notes §2.
 *
 * Wired from server/index.ts by ONE line; all logic is here and in
 * engine/voice.ts. The helpers it needs are handed in (the identity-routes
 * pattern), so this module never reaches back into the request handler.
 *
 * AUTH: every route here sits BELOW the engine's normal gate (cookie or
 * bearer). `/api/voice/inbound` is deliberately NOT loopback-exempt — it TYPES
 * INTO A SHELL, so it is the most dangerous content-delivery route this engine
 * has; the 2026-09-02 rule (do not grow the hook sink's exemption) binds
 * harder here than for /api/fabric/inbound.
 *
 * ROOM VOICE (the design notes, E1b [ticket]): `room:` channels and the
 * /api/voice/connections|rooms/* routes go to engine/room-voice.ts and answer
 * ONLY the voice actor (the voice service's named token): 403 {error:"voice-actor-only"}
 * for anything else. /api/voice/characters is the human's. Pane channels
 * and held/undelivered are unchanged. /api/voice/reply (E1c) takes the room
 * form too (engine/room-voice.ts reply) and refuses the voice actor.
 *
 * FLAG OFF (HARBOR_WB_VOICE unset): every /api/voice/* route answers 404, so a
 * window's mic probe reads "no voice here" and hides. /api/diag/voice still
 * answers, reporting `enabled:false` — a diag that 404s cannot say why.
 * ========================================================================== */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as voice from '../engine/voice.ts';
import * as roomVoice from '../engine/room-voice.ts';

export interface VoiceRouteDeps {
  readBody(req: IncomingMessage): Promise<any>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  log(line: string): void;
  /** Send one event to every viewer of a pane; returns the viewer count. */
  toPane(paneid: string, msg: Record<string, unknown>): number;
  /** Guard 9 for voice: is claude the pane's interactive session? (voice.ts) */
  claudeState?(paneid: string): 'repl' | 'none' | 'not-repl' | null;
  /** S0 guard 3: the pane's startup block (voice.ts). */
  startupHold?(paneid: string): { prompt: string | null } | null;
  /** The request is the voice service's named token (identity.isVoiceActor). Every ROOM
   *  voice route requires it, FAIL-CLOSED: the shared bearer, another token
   *  and a legacy-mode request are all 403 (room-voice §6.3). */
  voiceActor?: boolean;
  /** A person's credential (index.ts humanCredential): /api/voice/characters. */
  human?: boolean;
  /** room-voice v3.6: the user key behind the credential (the voice token is
   *  a named token of Owner's account), whose voice globals the room routes use. */
  userKey?: string;
}

let wired = false;

/* decodeURIComponent THROWS on a malformed escape, and a throw in a request
   handler is engine-fatal (2026-07-07) — a bad id is just an unknown id. */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Handle a voice route. Returns true when the request was answered. */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  deps: VoiceRouteDeps,
): Promise<boolean> {
  if (route !== '/api/diag/voice' && !route.startsWith('/api/voice/')) {
    return false;
  }
  if (!wired) {
    voice.setDeps({ toPane: deps.toPane, log: deps.log, claudeState: deps.claudeState, startupHold: deps.startupHold });
    wired = true;
  }
  const { sendJson } = deps;

  if (route === '/api/diag/voice' && req.method === 'GET') {
    sendJson(res, 200, voice.diag());
    return true;
  }
  if (!voice.enabled()) {
    sendJson(res, 404, { error: 'voice channel is off (HARBOR_WB_VOICE)' });
    return true;
  }

  /* Body parse failures ANSWER (413 over the engine's cap, 400 bad JSON). */
  const body = async (): Promise<Record<string, unknown> | null> => {
    try {
      return (await deps.readBody(req)) ?? {};
    } catch (err) {
      sendJson(res, (err as { status?: number })?.status ?? 400, { error: (err as Error).message });
      return null;
    }
  };
  const idOf = (b: Record<string, unknown>): string | null =>
    typeof b.channelId === 'string' && b.channelId ? b.channelId : null;
  const isRoom = (id: unknown): boolean => typeof id === 'string' && id.startsWith('room:');
  /** Fail-closed: false (and answered) unless the caller is the voice actor. */
  const voiceActorOnly = (): boolean => {
    if (!deps.voiceActor) {
      sendJson(res, 403, { error: 'voice-actor-only' });
      return false;
    }
    return true;
  };

  if (route === '/api/voice/connections' && req.method === 'GET') {
    if (voiceActorOnly()) {
      sendJson(res, 200, roomVoice.connections(deps.userKey));
    }
    return true;
  }

  /* CONVERSATION TEST PAGE (web/voice-test.html, Owner 2026-10-14, room line [ref]):
     the page's speech in and its short "ok"/prompt out, proxied to the voice service with the
     engine->the voice service bearer. A person's page only; nothing here reaches an agent. */
  if ((route === '/api/voice/test/stt' || route === '/api/voice/test/tts' || route === '/api/voice/test/concierge' || route === '/api/voice/test/assess' || route === '/api/voice/test/brain') && req.method === 'POST') {
    if (!deps.human) {
      sendJson(res, 403, { error: 'the conversation test page needs a person: send it from a window (cookie), not a bearer', field: 'credential' });
      return true;
    }
    try {
      const out = route === '/api/voice/test/stt' ? await testStt(req) : route === '/api/voice/test/tts' ? await testTts(req) : route === '/api/voice/test/brain' ? await testBrain(req) : await testConcierge(req, route === '/api/voice/test/assess' ? 'assess' : 'concierge-turn');
      if (out.audio) {
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': out.audio.length,
          'cache-control': 'no-store',
          ...(out.spoken !== undefined ? { 'x-spoken-text': encodeURIComponent(out.spoken) } : {}),
        });
        res.end(out.audio);
      } else {
        sendJson(res, out.status, out.body);
      }
    } catch (err) {
      sendJson(res, 502, { error: `voice-svc unreachable: ${(err as Error).message}` });
    }
    return true;
  }

  if (route === '/api/voice/characters' && req.method === 'GET') {
    if (!deps.human) {
      sendJson(res, 403, { error: 'the character catalogue needs a person: send it from a window (cookie), not a bearer', field: 'credential' });
      return true;
    }
    const out = await characters();
    sendJson(res, out.status, out.body);
    return true;
  }

  const roomM = /^\/api\/voice\/rooms\/([^/]+)\/(said|context|lines|mute|disconnect|waiting|verify)$/.exec(route);
  if (roomM) {
    if (!voiceActorOnly()) {
      return true;
    }
    const roomId = safeDecode(roomM[1]);
    const verb = roomM[2];
    try {
      if (req.method === 'GET' && verb === 'context') {
        const out = await roomVoice.context(roomId);
        sendJson(res, out.status, out.body);
        return true;
      }
      if (req.method === 'GET' && verb === 'lines') {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        const out = roomVoice.lines(roomId, q.get('q'), q.get('limit'));
        sendJson(res, out.status, out.body);
        return true;
      }
      if (req.method === 'POST' && verb !== 'context' && verb !== 'lines') {
        const b = await body();
        if (!b) {
          return true;
        }
        const out =
          verb === 'said'
            ? roomVoice.said(roomId, b)
            : verb === 'mute'
              ? roomVoice.setMuted(roomId, b.muted)
              : verb === 'waiting'
                ? roomVoice.clearWaiting(roomId, b)
                : verb === 'verify'
                  ? roomVoice.verify(roomId, b, deps.userKey)
                  : roomVoice.hangUp(roomId, 'user');
        sendJson(res, out.status, out.body);
        return true;
      }
    } catch (err) {
      /* Never let a throw escape a handler — engine-fatal (2026-07-07). */
      sendJson(res, 500, { error: 'internal', message: (err as Error).message });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }

  if (route === '/api/voice/channels' && req.method === 'GET') {
    sendJson(res, 200, voice.list());
    return true;
  }

  if (
    req.method === 'POST' &&
    (route === '/api/voice/channels/open' || route === '/api/voice/channels/close' || route === '/api/voice/focus')
  ) {
    const b = await body();
    if (!b) {
      return true;
    }
    const id = idOf(b);
    if (!id) {
      sendJson(res, 400, { error: 'channelId is required', field: 'channelId' });
      return true;
    }
    if (isRoom(id) && route !== '/api/voice/focus') {
      if (voiceActorOnly()) {
        const r = route === '/api/voice/channels/open' ? roomVoice.open(id, b.device, deps.userKey) : roomVoice.close(id, b.reason);
        sendJson(res, r.status, r.body);
      }
      return true;
    }
    if (route === '/api/voice/channels/open' && typeof b.device === 'string' && b.device) {
      roomVoice.closeDevice(b.device, 'moved'); // one connection per device (room-voice §3)
    }
    const out =
      route === '/api/voice/channels/open'
        ? voice.open(id)
        : route === '/api/voice/channels/close'
          ? voice.close(id)
          : voice.setFocus(id);
    if (out.ok) {
      sendJson(res, 200, voice.list());
    } else {
      sendJson(res, voice.statusOf(out.error), { error: out.error, field: out.field });
    }
    return true;
  }

  /* RELEASE a held utterance: {action:"send"|"dismiss"}. HTTP, not WS — the
     WS vocabulary gains nothing (lead decision, 2026-09-22). */
  const heldM = /^\/api\/voice\/held\/([^/]+)$/.exec(route);
  if (heldM && req.method === 'POST') {
    const b = await body();
    if (!b) {
      return true;
    }
    const out = voice.release(safeDecode(heldM[1]), b.action);
    sendJson(res, out.status, out.body);
    return true;
  }
  const undM = /^\/api\/voice\/undelivered\/([^/]+)$/.exec(route);
  if (undM && req.method === 'POST') {
    const b = await body();
    if (!b) {
      return true;
    }
    const out = voice.dismissUndelivered(safeDecode(undM[1]), b.action);
    sendJson(res, out.status, out.body);
    return true;
  }

  if (route === '/api/voice/inbound' && req.method === 'POST') {
    const b = await body();
    if (!b) {
      return true;
    }
    if (isRoom(b.channelId) && !voiceActorOnly()) {
      return true;
    }
    const out = voice.inbound(b, deps.userKey);
    sendJson(res, out.status, out.body);
    return true;
  }

  if (route === '/api/voice/reply' && req.method === 'POST') {
    /* A SEAT's words (room-voice §7): the voice actor holds no seat and must
       never author as one, so its token is refused here. */
    if (deps.voiceActor) {
      sendJson(res, 403, { error: 'seat-only', message: 'the voice credential cannot send a seat reply' });
      return true;
    }
    const b = await body();
    if (!b) {
      return true;
    }
    try {
      const out = await voice.reply(b);
      sendJson(res, out.status, out.body);
    } catch (err) {
      /* Never let a throw escape a handler — engine-fatal (2026-07-07). */
      sendJson(res, 500, { delivered: false, error: 'internal', message: (err as Error).message });
    }
    return true;
  }

  sendJson(res, 404, { error: 'no such voice route' });
  return true;
}

/* The character catalogue (room-voice §10.1): the voice service's, normalised to
   {characters:[{id, name, description?}]}. Three outcomes: the list, or 502
   with the reason (unreachable / non-2xx / no token) — never an empty list
   standing in for "could not ask". */
async function characters(): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = voice.readToken();
  if (!token) {
    return { status: 502, body: { error: 'voice-token-missing' } };
  }
  try {
    const res = await fetch(`${voice.voiceUrl()}/api/voice/characters`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { status: 502, body: { error: `voice-svc answered ${res.status}` } };
    }
    const raw = (await res.json().catch(() => null)) as unknown;
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { characters?: unknown })?.characters) ? (raw as { characters: unknown[] }).characters : null;
    if (!list) {
      return { status: 502, body: { error: 'voice-svc answered no character list' } };
    }
    const out: Array<{ id: string; name: string; description?: string }> = [];
    for (const c of list) {
      const o = (typeof c === 'string' ? { id: c, name: c } : c) as Record<string, unknown> | null;
      const id = typeof o?.id === 'string' ? o.id : typeof o?.name === 'string' ? o.name : null;
      if (id) {
        out.push({ id, name: typeof o!.name === 'string' ? o!.name : id, ...(typeof o!.description === 'string' ? { description: o!.description } : {}) });
      }
    }
    return { status: 200, body: { characters: out } };
  } catch (err) {
    return { status: 502, body: { error: `voice-svc unreachable: ${(err as Error).message}` } };
  }
}

/* ---- conversation test page proxies ----------------------------------------- */
const TEST_AUDIO_MAX = 4 * 1024 * 1024; // ~2 min of 16 kHz mono WAV; a segment is seconds
const TEST_TTS_TEXT_MAX = 300;
const TEST_HINT_MAX = 80;
const TEST_DRAFT_MAX = 8000; // a dictated spec, a paragraph at a time
const TEST_UTTERANCE_MAX = 1000;

type TestOut = { status: number; body: Record<string, unknown>; audio?: undefined } | { status: 200; body?: undefined; audio: Buffer; spoken?: string };
const TEST_PARAPHRASE = new Set(['off', 'low', 'med', 'high']);

/** The request body, capped: over the cap ANSWERS 413 with both numbers. */
function readCapped(req: IncomingMessage, max: number): Promise<Buffer | { over: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (d: Buffer) => {
      total += d.length;
      if (total <= max) {
        chunks.push(d);
      }
    });
    req.on('end', () => resolve(total > max ? { over: total } : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** POST /api/voice/test/stt: raw audio body (audio/wav or anything the voice service decodes)
 *  -> the voice service POST /api/voice/stt (multipart `audio`) -> its JSON, passed through. */
async function testStt(req: IncomingMessage): Promise<TestOut> {
  const body = await readCapped(req, TEST_AUDIO_MAX);
  if (!Buffer.isBuffer(body)) {
    return { status: 413, body: { error: 'audio too large', max: TEST_AUDIO_MAX, got: body.over } };
  }
  if (body.length === 0) {
    return { status: 400, body: { error: 'send the audio as the request body', field: 'body' } };
  }
  const token = voice.readToken();
  if (!token) {
    return { status: 502, body: { error: 'voice-token-missing' } };
  }
  const type = String(req.headers['content-type'] || 'audio/wav').split(';')[0];
  const form = new FormData();
  form.append('audio', new Blob([body], { type }), 'segment.wav');
  /* ?hint=<word> (the Concierge's display name, the design notes rule 3):
     a recogniser hint, forwarded as the form field `hint`; the voice service ignores it until it uses it */
  const hint = new URL(req.url ?? '/', 'http://engine').searchParams.get('hint')?.trim().slice(0, TEST_HINT_MAX);
  if (hint) {
    form.append('hint', hint);
  }
  const res = await fetch(`${voice.voiceUrl()}/api/voice/stt`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    return { status: 502, body: { error: `voice-svc stt answered ${res.status}`, ...(json ?? {}) } };
  }
  return { status: 200, body: json };
}

/** POST /api/voice/test/tts {text, character?, paraphrase?}: -> the voice service POST /api/voice/tts -> a WAV, with
 *  X-Spoken-Text (URI-encoded) = what was actually said (the text itself when not reworded). */
async function testTts(req: IncomingMessage): Promise<TestOut> {
  const raw = await readCapped(req, 16 * 1024);
  if (!Buffer.isBuffer(raw)) {
    return { status: 413, body: { error: 'body too large' } };
  }
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: 'body must be JSON {text, character?}', field: 'body' } };
  }
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text || text.length > TEST_TTS_TEXT_MAX) {
    return { status: 400, body: { error: `text is required, at most ${TEST_TTS_TEXT_MAX} characters`, field: 'text' } };
  }
  const character = typeof b.character === 'string' && b.character ? b.character.slice(0, 80) : undefined;
  /* Owner [ref]: the page's prompts can be reworded so they don't repeat; the voice service does the rewording. */
  if (b.paraphrase !== undefined && !(typeof b.paraphrase === 'string' && TEST_PARAPHRASE.has(b.paraphrase))) {
    return { status: 400, body: { error: 'paraphrase is off|low|med|high', field: 'paraphrase' } };
  }
  const paraphrase = (b.paraphrase as string | undefined) ?? 'off';
  const token = voice.readToken();
  if (!token) {
    return { status: 502, body: { error: 'voice-token-missing' } };
  }
  const res = await fetch(`${voice.voiceUrl()}/api/voice/tts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(character ? { character } : {}), ...(paraphrase !== 'off' ? { paraphrase } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    return { status: 502, body: { error: `voice-svc tts answered ${res.status}` } };
  }
  const header = res.headers.get('x-spoken-text');
  let spoken = text;
  if (header) {
    try {
      spoken = decodeURIComponent(header);
    } catch {
      spoken = header;
    }
  }
  return { status: 200, audio: Buffer.from(await res.arrayBuffer()), spoken };
}

/** POST /api/voice/test/brain {mode, note, history, utterance, name}: one turn of a
 *  MODED conversation (Owner [ref]: conversation / note dictation / asking), decided
 *  by Sonnet in scripts/voice-sandbox.mjs, a worker with no tools and no MCP that can
 *  only answer in text. -> {intent, mode, note, say, why, would, task, via, model_ms}.
 *  The page holds the state; nothing here or there acts on the answer. */
const BRAIN_MODES = ['conversation', 'note', 'asking'];
const BRAIN_HISTORY_MAX = 40;
async function testBrain(req: IncomingMessage): Promise<TestOut> {
  const raw = await readCapped(req, 64 * 1024);
  if (!Buffer.isBuffer(raw)) {
    return { status: 413, body: { error: 'body too large', max: 64 * 1024, got: raw.over } };
  }
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: 'body must be JSON {mode, note, history, utterance, name}', field: 'body' } };
  }
  const mode = typeof b.mode === 'string' ? b.mode : 'conversation';
  const note = typeof b.note === 'string' ? b.note : '';
  const utterance = typeof b.utterance === 'string' ? b.utterance.trim() : '';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!BRAIN_MODES.includes(mode)) {
    return { status: 400, body: { error: `mode is one of ${BRAIN_MODES.join(', ')}`, field: 'mode' } };
  }
  if (note.length > TEST_DRAFT_MAX) {
    return { status: 400, body: { error: `note is at most ${TEST_DRAFT_MAX} characters`, field: 'note' } };
  }
  if (!utterance || utterance.length > TEST_UTTERANCE_MAX) {
    return { status: 400, body: { error: `utterance is required, at most ${TEST_UTTERANCE_MAX} characters`, field: 'utterance' } };
  }
  if (!name || name.length > TEST_HINT_MAX) {
    return { status: 400, body: { error: 'name is required', field: 'name' } };
  }
  const hist = Array.isArray(b.history) ? b.history : [];
  const history = hist.slice(-BRAIN_HISTORY_MAX).map((h) => {
    const e = (h ?? {}) as Record<string, unknown>;
    return { who: e.who === 'olivia' ? 'olivia' : 'user', text: typeof e.text === 'string' ? e.text.slice(0, TEST_UTTERANCE_MAX) : '' };
  }).filter((h) => h.text);
  const url = process.env.HARBOR_WB_VOICE_SANDBOX_URL || 'http://127.0.0.1:8103';
  let res: Response;
  try {
    res = await fetch(`${url}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, note, history, utterance, name }),
      signal: AbortSignal.timeout(50_000),
    });
  } catch (e) {
    return { status: 502, body: { error: `the Sonnet sandbox is not reachable (${url}): ${(e as Error)?.message ?? e}` } };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    return { status: 502, body: { error: `the Sonnet sandbox answered ${res.status}`, ...(json ?? {}) } };
  }
  return { status: 200, body: json };
}

/** POST /api/voice/test/concierge {draft, utterance, name, handle}: the Concierge's
 *  name as a CUE (Owner [ref]/[ref], the design notes roadmap) ->
 *  the voice service POST /api/voice/concierge-turn -> {addressed, kind: edit|question|content,
 *  text?, draft?, reply?, changes?}, passed through. the voice service proposes; the page applies.
 *  POST /api/voice/test/assess takes the same body -> the voice service POST /api/voice/assess ->
 *  {intent: delegate|act|dictate, why, would, target, via}: her READ of what the user
 *  wants after each pause (Owner [ref]), display only. */
async function testConcierge(req: IncomingMessage, voicesvcRoute: 'concierge-turn' | 'assess'): Promise<TestOut> {
  const raw = await readCapped(req, 64 * 1024);
  if (!Buffer.isBuffer(raw)) {
    return { status: 413, body: { error: 'body too large', max: 64 * 1024, got: raw.over } };
  }
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: 'body must be JSON {draft, utterance, name, handle}', field: 'body' } };
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const draft = typeof b.draft === 'string' ? b.draft : '';
  const utterance = str(b.utterance);
  const name = str(b.name);
  const handle = str(b.handle).replace(/^@/, '');
  if (draft.length > TEST_DRAFT_MAX) {
    return { status: 400, body: { error: `draft is at most ${TEST_DRAFT_MAX} characters`, field: 'draft' } };
  }
  if (!utterance || utterance.length > TEST_UTTERANCE_MAX) {
    return { status: 400, body: { error: `utterance is required, at most ${TEST_UTTERANCE_MAX} characters`, field: 'utterance' } };
  }
  if (!name || name.length > TEST_HINT_MAX || !handle || handle.length > 32) {
    return { status: 400, body: { error: 'name and handle are required', field: name ? 'handle' : 'name' } };
  }
  const token = voice.readToken();
  if (!token) {
    return { status: 502, body: { error: 'voice-token-missing' } };
  }
  const res = await fetch(`${voice.voiceUrl()}/api/voice/${voicesvcRoute}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ draft, utterance, name, handle }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    return { status: 502, body: { error: `voice-svc ${voicesvcRoute} answered ${res.status}`, ...(json ?? {}) } };
  }
  return { status: 200, body: json };
}
