/* THE CONCIERGE SEND SEAM (the design notes; rulings coordination [ref] + design review [ref]; voice contract v0.6.1).
 *
 * A spoken utterance is typed into the Concierge pane as the person's chat line, marked `voice` so the marker survives in the transcript (the
 * agent chat's only record). It is NEVER typed over a draft, and a HELD utterance is NOT sent and NOT queued: the answer is
 * `200 {status:'held', held:'draft'|'busy', delivered:false, retryAfterMs}` and the voice side says "one moment" or retries once. (Not 202: that
 * would mean "accepted for later", which is the queue we decided against; a spoken line that lands minutes late is worse than a refusal.)
 *
 * The typer's chat door QUEUES by default. So the line is offered to it, and if it did not go in at once it is taken back out again, leaving
 * every line that was already waiting where it was. Everything here is pure over the injected typer, so it is tested without an engine.
 *
 * IDEMPOTENCY by `utteranceId`: a retry of a line that was TYPED gets the first answer and types nothing again. A retry of a HELD one is tried
 * AGAIN (that is what the retry is for), and a 409 is never cached. The cache is in memory and bounded; an engine restart forgets it. */

export interface TyperPort {
  frameChat(text: string, via: 'voice' | null): string;
  enqueueChat(paneid: string, text: string, via: 'voice' | null): 'injected' | 'queued' | 'off' | 'vendor';
  heldFor(paneid: string): { reason: string; depth: number } | null;
  drainQueue(paneid: string): { roomId: string; entryId: number; text: string }[];
  requeue(paneid: string, items: { roomId: string; entryId: number; text: string }[]): void;
}
export interface SendDeps {
  /** the Concierge pane (the active recipe's primary pane), or null: off / none chosen */
  pane(): string | null;
  paneLive(paneid: string): boolean;
  typer: TyperPort;
  /** the typer's line limit (room-typer TYPE_TEXT_MAX); defaults to 1500 */
  typeMax?: number;
  log(line: string): void;
}
export interface SendAnswer {
  status: number;
  body: Record<string, any>;
}

const TYPE_MAX_DEFAULT = 1500;
const FRAME_MARGIN = 32; // agent-chat.ts keeps this much room under the typer's limit
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SHORT_MAX = 80;
export const RETRY_DRAFT_MS = 3000;
export const RETRY_BUSY_MS = 1500;

/** The most speech the engine can type in one utterance: the typer's line limit less the margin and the chat frame (`[chat · @user · voice] `).
 *  NOT the 2000 the contract first named; the voice side is told the real number in the 413. */
export function voiceTextMax(typeMax = TYPE_MAX_DEFAULT): number {
  return typeMax - FRAME_MARGIN - '[chat · @user · voice] '.length;
}

export class SendCache {
  private m = new Map<string, { at: number; answer: SendAnswer }>();
  constructor(
    private readonly max = 256,
    private readonly ttlMs = 10 * 60_000,
  ) {}
  get(id: string, now: number): SendAnswer | undefined {
    const e = this.m.get(id);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) {
      this.m.delete(id);
      return undefined;
    }
    return e.answer;
  }
  put(id: string, answer: SendAnswer, now: number): void {
    this.m.delete(id);
    this.m.set(id, { at: now, answer });
    while (this.m.size > this.max) {
      this.m.delete(this.m.keys().next().value as string);
    }
  }
  size(): number {
    return this.m.size;
  }
}

const bad = (field: string, message?: string): SendAnswer => ({ status: 400, body: { error: 'bad-field', field, ...(message ? { message } : {}) } });
const short = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= SHORT_MAX;

export function sendToConcierge(raw: unknown, deps: SendDeps, cache: SendCache, now = Date.now()): SendAnswer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('body');
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.utteranceId !== 'string' || !ID_RE.test(b.utteranceId)) {
    return bad('utteranceId');
  }
  const id = b.utteranceId;
  if (typeof b.text !== 'string' || !b.text.trim()) {
    return bad('text');
  }
  if (CONTROL_RE.test(b.text)) {
    return { status: 400, body: { error: 'control-character', field: 'text' } };
  }
  const text = b.text.trim();
  const limit = voiceTextMax(deps.typeMax);
  if (text.length > limit) {
    return { status: 413, body: { error: 'too-long', limit, length: text.length } };
  }
  for (const k of ['speaker', 'device', 'scope'] as const) {
    if (b[k] !== undefined && b[k] !== null && !short(b[k])) {
      return bad(k);
    }
  }
  if (b.confidence !== undefined && b.confidence !== null && (typeof b.confidence !== 'number' || !Number.isFinite(b.confidence) || b.confidence < 0 || b.confidence > 1)) {
    return bad('confidence');
  }

  const cached = cache.get(id, now);
  if (cached) {
    return cached;
  }
  const pane = deps.pane();
  if (!pane || !deps.paneLive(pane)) {
    return { status: 409, body: { error: 'no-channel', message: 'the Concierge is not running; turn it on and start it first' } };
  }
  const t = deps.typer;
  const framed = t.frameChat(text, 'voice');
  const r = t.enqueueChat(pane, text, 'voice');
  if (r === 'off') {
    return { status: 409, body: { error: 'no-channel', message: 'typing into sessions is switched off on this engine' } };
  }
  if (r === 'vendor') {
    return { status: 409, body: { error: 'no-claude', message: 'the Concierge is not a CLI that can be typed into' } };
  }
  if (r === 'injected') {
    const answer: SendAnswer = { status: 200, body: { status: 'ok', delivered: true } };
    cache.put(id, answer, now);
    deps.log(`concierge send ${pane}: typed (${text.length} chars)`);
    return answer;
  }
  /* QUEUED = it did not go in. Read WHY while our line is still in the queue (heldFor reads the head), then take our line back out and put the
     others back in their order. */
  const held = t.heldFor(pane);
  const items = t.drainQueue(pane);
  const at = items.map((i) => i.text).lastIndexOf(framed);
  if (at >= 0) {
    items.splice(at, 1);
  }
  t.requeue(pane, items);
  const reason = held?.reason ?? 'busy';
  deps.log(`concierge send ${pane}: not sent, ${reason}`);
  if (reason === 'startup') {
    return { status: 409, body: { error: 'startup', message: 'the Concierge is still starting up (or waiting at a first-run prompt)' } };
  }
  if (reason === 'no-claude' || reason === 'connector-owned' || reason === 'vendor') {
    return { status: 409, body: { error: 'no-claude', message: 'the Concierge pane is not an interactive Claude session' } };
  }
  if (reason === 'not-live' || reason === 'off') {
    return { status: 409, body: { error: 'no-channel', message: 'the Concierge is not running' } };
  }
  if (reason === 'draft') {
    return { status: 200, body: { status: 'held', held: 'draft', delivered: false, retryAfterMs: RETRY_DRAFT_MS } };
  }
  return { status: 200, body: { status: 'held', held: 'busy', delivered: false, retryAfterMs: RETRY_BUSY_MS } };
}
