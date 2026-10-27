/**
 * THE CONCIERGE SEND SEAM (src/engine/concierge-send.ts; the design notes, rulings coordination [ref] + design review [ref]): a spoken
 * utterance is typed into the Concierge like the person typed it, NEVER over a draft, and a held one is NOT sent and NOT queued. Validation
 * (400/413 with the contract's exact bodies), idempotency by utteranceId (a retry of a TYPED utterance types nothing twice; a retry of a HELD
 * one is tried again), the 409 codes, and the speaker/device/confidence/scope fields. The typer is a fake with the real shapes.
 */
import { sendToConcierge, SendCache, voiceTextMax, type SendDeps } from '../src/engine/concierge-send.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}

type Held = { reason: string; depth: number };
interface FakeTyper {
  queue: { roomId: string; entryId: number; text: string }[];
  /** what the next enqueueChat answers: 'injected' types now; 'draft' / 'busy' etc. queue and hold */
  mode: 'injected' | string;
  typed: string[];
}
function fake(mode: FakeTyper['mode'], pre: string[] = []): { t: FakeTyper; deps: SendDeps } {
  const t: FakeTyper = { queue: pre.map((text) => ({ roomId: 'chat', entryId: 0, text })), mode, typed: [] };
  const deps: SendDeps = {
    pane: () => 'recipe:concierge',
    paneLive: () => true,
    typer: {
      frameChat: (text: string, via: 'voice' | null) => `[chat · @user${via === 'voice' ? ' · voice' : ''}] ${text}`,
      enqueueChat: (_p, text, via) => {
        const framed = `[chat · @user${via === 'voice' ? ' · voice' : ''}] ${text}`;
        if (t.mode === 'injected' && t.queue.length === 0) {
          t.typed.push(framed);
          return 'injected';
        }
        if (t.mode === 'off') return 'off';
        if (t.mode === 'vendor') return 'vendor';
        t.queue.push({ roomId: 'chat', entryId: 0, text: framed });
        return 'queued';
      },
      heldFor: (): Held | null => (t.queue.length ? { reason: t.mode === 'injected' ? 'one-queued' : t.mode, depth: t.queue.length } : null),
      drainQueue: () => {
        const q = t.queue;
        t.queue = [];
        return q;
      },
      requeue: (_p, items) => {
        t.queue.push(...items);
      },
    },
    log: () => {},
  };
  return { t, deps };
}
const body = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ text: 'turn on the kitchen lights', utteranceId: 'agent-voice-1730000000000-ab12', ...o });
const run = (deps: SendDeps, b: unknown, cache = new SendCache()) => sendToConcierge(b, deps, cache);

console.log('\n[validation: the contract\'s exact bodies]');
{
  const { deps } = fake('injected');
  const bad = (b: unknown) => run(deps, b);
  let r = bad(null);
  ok(r.status === 400 && r.body.error === 'bad-field' && r.body.field === 'body', 'a body that is not an object: 400 bad-field');
  r = bad(body({ utteranceId: undefined }));
  ok(r.status === 400 && r.body.error === 'bad-field' && r.body.field === 'utteranceId', 'a missing utteranceId: 400 bad-field');
  for (const id of ['', 'x'.repeat(81), 'has space', 'semi;colon', 'ünï']) {
    ok(run(deps, body({ utteranceId: id })).body.field === 'utteranceId', `a malformed utteranceId is refused: ${JSON.stringify(id.slice(0, 12))}`);
  }
  ok(run(deps, body({ utteranceId: 'agent-voice-1730000000000-ab12' })).status === 200, 'the voice team\'s own format (`agent-voice-<ms>-<hex4>`) is accepted');
  ok(run(deps, body({ utteranceId: 'A_b.c:d-1' })).status === 200, 'the wider charset is accepted');
  r = bad(body({ text: 5 }));
  ok(r.status === 400 && r.body.field === 'text', 'text that is not text: 400');
  r = bad(body({ text: '   ' }));
  ok(r.status === 400 && r.body.field === 'text', 'text that is empty after trimming: 400');
  for (const ch of ['\u0000', '\u0007', '\n', '\t', '\r', '\u007f', '\u001b']) {
    r = bad(body({ text: `hello${ch}world`, utteranceId: `c-${ch.charCodeAt(0)}` }));
    if (!(r.status === 400 && r.body.error === 'control-character' && r.body.field === 'text')) ok(false, `control character ${ch.charCodeAt(0)} is refused (got ${r.status})`);
  }
  ok(run(deps, body({ text: 'a\u0001b', utteranceId: 'cc-1' })).body.error === 'control-character', 'a control character: 400 control-character, field text');
  const max = voiceTextMax();
  ok(max > 1000 && max < 2000, `the engine can type at most ${max} characters of speech (the typer\'s line limit less the chat frame), NOT the contract\'s 2000`);
  r = bad(body({ text: 'x'.repeat(max + 1), utteranceId: 'big-1' }));
  ok(r.status === 413 && r.body.error === 'too-long' && r.body.limit === max && r.body.length === max + 1, '413 too-long, with the limit and the length');
  ok(bad(body({ text: 'x'.repeat(max), utteranceId: 'big-2' })).status === 200, 'exactly the limit is fine');
  ok(run(deps, body({ utteranceId: 'f-1', speaker: 'x'.repeat(81) })).body.field === 'speaker' && run(deps, body({ utteranceId: 'f-2', device: 5 })).body.field === 'device' && run(deps, body({ utteranceId: 'f-3', scope: 'x'.repeat(81) })).body.field === 'scope', 'speaker, device and scope are short text');
  ok(run(deps, body({ utteranceId: 'f-4', confidence: 1.5 })).body.field === 'confidence' && run(deps, body({ utteranceId: 'f-5', confidence: 'high' })).body.field === 'confidence', 'confidence is a number 0..1');
  ok(run(deps, body({ utteranceId: 'f-6', confidence: 0.82, speaker: 'owner', device: 'headset', scope: 'Local' })).status === 200, 'and the optional fields are accepted when valid');
}

console.log('\n[typed: it goes in as the person\'s voice]');
{
  const { t, deps } = fake('injected');
  const r = run(deps, body());
  ok(r.status === 200 && r.body.status === 'ok' && r.body.delivered === true, '200 {status:ok, delivered:true}');
  ok(t.typed.length === 1 && t.typed[0] === '[chat · @user · voice] turn on the kitchen lights', 'typed as the chat line with the voice marker (it survives in the transcript)');
  ok(t.queue.length === 0, 'nothing left in the queue');
}

console.log('\n[idempotency: a retry of a TYPED utterance types nothing again]');
{
  const { t, deps } = fake('injected');
  const cache = new SendCache();
  const first = run(deps, body(), cache);
  const again = run(deps, body(), cache);
  ok(JSON.stringify(first) === JSON.stringify(again), 'the same utteranceId gets the first answer back, exactly');
  ok(t.typed.length === 1, 'and was typed ONCE');
  const other = run(deps, body({ utteranceId: 'agent-voice-1730000000001-cd34' }), cache);
  ok(other.status === 200 && t.typed.length === 2, 'a different id is a different utterance');
  ok(run(deps, body({ text: 'a different sentence' }), cache).body.delivered === true && t.typed.length === 2, 'the same id with different text is still the same utterance (the id is the key)');
}

console.log('\n[held: NOT sent, NOT queued, and a retry is tried again (rulings [ref], [ref])]');
for (const [reason, held, retry] of [['draft', 'draft', 3000], ['busy', 'busy', 1500], ['not-idle', 'busy', 1500], ['settling', 'busy', 1500], ['awaiting-idle', 'busy', 1500], ['needs-you', 'busy', 1500], ['one-queued', 'busy', 1500]] as const) {
  const { t, deps } = fake(reason);
  const r = run(deps, body({ utteranceId: `h-${reason}` }));
  ok(r.status === 200 && r.body.status === 'held' && r.body.held === held && r.body.delivered === false && r.body.retryAfterMs === retry, `${reason}: 200 {held:${held}, delivered:false, retryAfterMs:${retry}}`);
  ok(t.queue.length === 0 && t.typed.length === 0, `${reason}: nothing typed and nothing left in the queue`);
}
{
  const { t, deps } = fake('draft', ['[room] an older line that was already waiting']);
  const r = run(deps, body({ utteranceId: 'h-keep' }));
  ok(r.body.held === 'draft' && t.queue.length === 1 && t.queue[0].text === '[room] an older line that was already waiting', 'a held utterance removes ONLY itself: lines that were already waiting stay, in order');
}
{
  const { t, deps } = fake('draft');
  const cache = new SendCache();
  run(deps, body({ utteranceId: 'retry-1' }), cache);
  t.mode = 'injected';
  const second = run(deps, body({ utteranceId: 'retry-1' }), cache);
  ok(second.body.status === 'ok' && second.body.delivered === true && t.typed.length === 1, 'the same id retried after a hold is tried AGAIN, and goes in once the draft is gone (the voice side retries once)');
  const third = run(deps, body({ utteranceId: 'retry-1' }), cache);
  ok(third.body.status === 'ok' && t.typed.length === 1, '...and a third try is the cached answer: typed once');
}

console.log('\n[409: no-channel, no-claude, startup]');
{
  let r = run({ ...fake('injected').deps, pane: () => null }, body());
  ok(r.status === 409 && r.body.error === 'no-channel' && typeof r.body.message === 'string', 'no Concierge pane (off, or none chosen): 409 no-channel with a message');
  r = run({ ...fake('injected').deps, paneLive: () => false }, body());
  ok(r.status === 409 && r.body.error === 'no-channel', 'the pane is not live: 409 no-channel');
  r = run(fake('vendor').deps, body());
  ok(r.status === 409 && r.body.error === 'no-claude', 'a CLI that cannot be typed into: 409 no-claude');
  r = run(fake('off').deps, body());
  ok(r.status === 409 && r.body.error === 'no-channel', 'typing switched off on this engine: 409 no-channel');
  for (const reason of ['no-claude', 'connector-owned']) {
    const f = fake(reason);
    r = run(f.deps, body({ utteranceId: `nc-${reason}` }));
    ok(r.status === 409 && r.body.error === 'no-claude' && f.t.queue.length === 0, `${reason}: 409 no-claude, nothing left queued`);
  }
  const s = fake('startup');
  r = run(s.deps, body({ utteranceId: 'su-1' }));
  ok(r.status === 409 && r.body.error === 'startup' && s.t.queue.length === 0, 'the Claude has not cleared its startup (a first-run prompt included): 409 startup, nothing queued');
  const nl = fake('not-live');
  ok(run(nl.deps, body({ utteranceId: 'nl-1' })).body.error === 'no-channel', 'the typer says not-live: 409 no-channel');
  ok(run(fake('startup').deps, body({ utteranceId: 'su-2' }), new SendCache()).status === 409, 'a 409 is never cached (the state may change)');
}

console.log('\n[the cache is bounded]');
{
  const { deps } = fake('injected');
  const cache = new SendCache(3, 1000);
  for (let i = 0; i < 5; i++) run(deps, body({ utteranceId: `b-${i}` }), cache);
  ok(cache.size() <= 3, 'at most N answers are kept');
}
{
  const f = fake('injected');
  const cache = new SendCache(256, 1000);
  sendToConcierge(body({ utteranceId: 'ttl-a' }), f.deps, cache, 1000);
  sendToConcierge(body({ utteranceId: 'ttl-a' }), f.deps, cache, 1500);
  ok(f.t.typed.length === 1, 'within the window a retry is cached');
  sendToConcierge(body({ utteranceId: 'ttl-a' }), f.deps, cache, 2500);
  ok(f.t.typed.length === 2, 'after the window the id is forgotten (an engine restart forgets it too, and the note says so)');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
