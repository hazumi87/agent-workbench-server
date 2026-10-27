/**
 * Held and restored mail (ticket): which envelopes get a preamble, what the
 * preamble says, and that a burst becomes ONE typed line under ONE preamble,
 * oldest first. Also the `delivery` field through fabric.validate, and
 * fabric.deliver wiring the batcher (no engine, no pty: the batcher's sink is
 * swapped for a recorder).
 *
 * Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'wb-fabric-held-'));
process.env.HARBOR_WB_TABLE = join(tmp, 'mapping.db'); // channels.ts imports the table: never the repo's
process.env.HARBOR_WB_FABRIC_BATCH_MS = '60';
delete process.env.HARBOR_WB_CHANNELS;

const held = await import('../src/engine/fabric-held.ts');
const fabric = await import('../src/engine/fabric.ts');

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string, got?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
  }
}
const eq = (a: unknown, b: unknown, msg: string): void => ok(JSON.stringify(a) === JSON.stringify(b), msg, a);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const env = (id: string, ts: string, extra: Record<string, unknown> = {}) => ({
  id,
  ts,
  from: 'alpha-platform',
  to: 'platform',
  kind: 'msg' as const,
  class: 'coordination' as const,
  attention: 'notice' as const,
  thread: `t-${id}`,
  body: `body of ${id}`,
  ack: 'none' as const,
  ...extra,
});

const LIVE_AT = Date.parse('2026-09-30T12:00:00.000Z');

console.log('\n[validate: delivery survives; an unknown value is dropped, never a 400]');
{
  const v = fabric.validate(env('a', '2026-09-30T10:00:00Z', { delivery: 'hold' }));
  eq(v.ok && v.envelope.delivery, 'hold', 'delivery:hold survives validate');
  const r = fabric.validate(env('b', '2026-09-30T10:00:00Z', { delivery: 'restore' }));
  eq(r.ok && r.envelope.delivery, 'restore', 'delivery:restore survives validate');
  const u = fabric.validate(env('c', '2026-09-30T10:00:00Z', { delivery: 'someday' }));
  eq([u.ok, u.ok && 'delivery' in u.envelope], [true, false], 'an unknown delivery is accepted and dropped');
  const n = fabric.validate(env('d', '2026-09-30T10:00:00Z'));
  eq(n.ok && 'delivery' in n.envelope, false, 'absent stays ABSENT');
}

console.log('\n[effectiveDelivery: the field, else sent-before-live, else nothing]');
eq(held.effectiveDelivery({ ts: '2026-09-30T13:00:00Z', delivery: 'hold' }, LIVE_AT), { delivery: 'hold', inferred: false }, 'the fabric\'s hold wins even when sent after live');
eq(held.effectiveDelivery({ ts: '2026-09-30T10:00:00Z', delivery: 'restore' }, LIVE_AT), { delivery: 'restore', inferred: false }, 'a restore keeps the restore note though its ts is before the restore');
eq(held.effectiveDelivery({ ts: '2026-09-30T10:00:00Z' }, LIVE_AT), { delivery: 'hold', inferred: true }, 'no field, sent BEFORE the pane went live: hold (inferred)');
eq(held.effectiveDelivery({ ts: '2026-09-30T12:00:00.001Z' }, LIVE_AT), null, 'no field, sent after the pane went live: plain, as today');
eq(held.effectiveDelivery({ ts: '2026-09-30T10:00:00Z' }, null), null, 'unknown live time: plain (cannot tell is not a hold)');
eq(held.effectiveDelivery({ ts: 'not a time' }, LIVE_AT), null, 'unparseable ts: plain');

console.log('\n[composeHeld: the wording, one preamble, oldest first]');
{
  const one = held.composeHeld('hold', [env('h1', '2026-09-30T10:00:00Z') as never]);
  eq(one.length, 1, 'one envelope: one line');
  ok(
    one[0].startsWith('You were offline. This message was left for you by alpha-platform at 2026-09-30T10:00:00.000Z. Check back with the sender before carrying it out. [fabric · @alpha-platform · msg · t:t-h1 · id:h1] body of h1'),
    'single hold: Owner\'s sentence (ISO ts), then the envelope framed exactly as a plain one',
    one[0],
  );
  const r1 = held.composeHeld('restore', [env('r1', '2026-09-30T11:00:00Z') as never]);
  ok(
    r1[0].startsWith(held.RESTORE_PREAMBLE + ' [from alpha-platform at 2026-09-30T11:00:00.000Z] [fabric · @alpha-platform'),
    'single restore: the restore note, then from/ts, then the frame',
    r1[0],
  );
  ok(held.RESTORE_PREAMBLE.startsWith('You were disconnected, and reconnected for an incoming message. Note, any background tasks'), 'restore wording is Owner\'s');
  const many = held.composeHeld('hold', [
    env('late', '2026-09-30T10:30:00Z', { from: 'b' }) as never,
    env('early', '2026-09-30T09:00:00Z', { from: 'a' }) as never,
  ]);
  eq(many.length, 1, 'two held: ONE line');
  eq((many[0].match(/You were offline/g) ?? []).length, 1, '...under ONE preamble');
  ok(many[0].indexOf('id:early') < many[0].indexOf('id:late'), 'oldest first, whatever the arrival order');
  ok(/\[1 of 2 · from a at 2026-09-30T09:00:00\.000Z\] \[fabric · @a/.test(many[0]) && /\[2 of 2 · from b at 2026-09-30T10:30:00\.000Z\]/.test(many[0]), 'each item carries its from and ts');
  const big = held.composeHeld(
    'hold',
    Array.from({ length: 5 }, (_, i) => env(`big${i}`, `2026-09-30T0${i}:00:00Z`, { body: 'x'.repeat(900) }) as never),
  );
  ok(big.length > 1, `five 900-char bodies split into ${big.length} lines`);
  ok(big.every((l) => l.length <= 1500), 'every line fits TYPE_TEXT_MAX');
  eq(big.filter((l) => l.includes('You were offline')).length, 1, 'only the first line carries the preamble');
  ok(big.slice(1).every((l, k) => l.startsWith(`[continued, part ${k + 2} of ${big.length}]`)), 'the rest say which part they are');
}

console.log('\n[the batcher: a burst is one line; hold and restore never share a preamble]');
{
  const typed: Array<{ paneid: string; text: string }> = [];
  held.setSink((paneid, text) => {
    typed.push({ paneid, text });
    return 'queued';
  });
  held.add('p1', 'hold', env('m2', '2026-09-30T10:05:00Z') as never);
  held.add('p1', 'hold', env('m1', '2026-09-30T10:00:00Z') as never);
  held.add('p1', 'restore', env('r', '2026-09-30T10:10:00Z') as never);
  held.add('p2', 'hold', env('other', '2026-09-30T10:00:00Z') as never);
  await sleep(20);
  eq(typed.length, 0, 'nothing is typed while the burst is still arriving');
  await sleep(150);
  eq(typed.length, 3, 'three lines: p1 hold, p1 restore, p2 hold');
  const p1hold = typed.find((t) => t.paneid === 'p1' && t.text.includes('You were offline'));
  ok(!!p1hold && p1hold.text.indexOf('id:m1') < p1hold.text.indexOf('id:m2'), 'p1\'s two held envelopes: one line, oldest first');
  ok(typed.some((t) => t.paneid === 'p1' && t.text.startsWith('You were disconnected') && t.text.includes('id:r') && !t.text.includes('You were offline')), 'p1\'s restore is its own line under the restore note');
  held.add('p3', 'hold', env('gone', '2026-09-30T10:00:00Z') as never);
  held.drop('p3');
  await sleep(150);
  ok(!typed.some((t) => t.paneid === 'p3'), 'a pane that ended drops its gathering batch');
  held.setSink(null);
  held.reset();
}

console.log('\n[fabric.deliver: plain mail unchanged; held mail batched; the log names the delivery]');
{
  const lines: string[] = [];
  const typed: string[] = [];
  held.setSink((_p, text) => {
    typed.push(text);
    return 'queued';
  });
  process.env.HARBOR_WB_ROOM_TYPE = '0'; // the plain path's typer is off here: only the batcher's sink records
  fabric.setDeliveryDeps({
    livePaneFor: (slug) => (slug === 'platform' ? 'recipe:plat' : null),
    toViewers: () => 0,
    startedAt: () => LIVE_AT,
    log: (l) => lines.push(l),
  });
  const a = fabric.deliver(env('old1', '2026-09-30T09:00:00Z') as never);
  const b = fabric.deliver(env('old2', '2026-09-30T08:00:00Z') as never);
  const c = fabric.deliver(env('new', '2026-09-30T12:30:00Z') as never);
  const d = fabric.deliver(env('rest', '2026-09-30T11:59:00Z', { delivery: 'restore' }) as never);
  eq([a.ok, b.ok, c.ok, d.ok], [true, true, true, true], 'all four delivered to the badge');
  ok(lines.filter((l) => / delivery=hold\(inferred\)$/.test(l)).length === 2, 'the two pre-live envelopes log delivery=hold(inferred)', lines);
  ok(lines.some((l) => l.includes('typed=off') && !l.includes('delivery=')), 'the post-live envelope logs no delivery (plain, today\'s path)', lines);
  ok(lines.some((l) => / delivery=restore$/.test(l)), 'the restore envelope logs delivery=restore');
  ok(lines.every((l) => !l.includes('body of')), 'no log line carries a body');
  await sleep(200);
  eq(typed.length, 2, 'two typed lines: one hold batch, one restore');
  const h = typed.find((t) => t.startsWith('You were offline')) ?? '';
  ok(h.indexOf('id:old2') > 0 && h.indexOf('id:old2') < h.indexOf('id:old1') && !h.includes('id:new'), 'the hold batch holds old2 then old1, never the live one', h);
  const replay = fabric.deliver(env('seen-before', '2026-09-30T09:00:00Z', { ack: 'delivered' }) as never);
  eq(replay.ok, true, 'a replay of an already-delivered envelope still reaches the badge');
  await sleep(200);
  eq(typed.length, 2, '...and is never re-typed, preamble or not');
  held.setSink(null);
  held.reset();
  fabric.setDeliveryDeps(null);
}

{
  console.log('\n[a cut message tells the AGENT where the rest is] night test 2026-10-06');
  const typer = await import('../src/engine/room-typer.ts');
  const cut = typer.frameFabric({ id: 'env-123', from: 'alpha-platform', kind: 'ask', body: 'q'.repeat(3000) });
  ok(cut.length <= typer.TYPE_TEXT_MAX, 'capped at the typed max', cut.length);
  ok(/full message is in fabric_inbox \(id env-123\)\]$/.test(cut), 'the note names fabric_inbox and the id', cut.slice(-80));
  ok(!/badge/.test(cut), 'and no longer points an agent at a badge it cannot see', cut.slice(-80));
}

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows: EPERM */ }
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
