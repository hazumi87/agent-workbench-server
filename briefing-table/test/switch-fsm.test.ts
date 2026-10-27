/**
 * The Basic "Switch assistant" runner and journal (ticket): crash-safe at EVERY step, one operation per room, no
 * model needed, the lead moves exactly once and only by compare-and-set, nothing mints twice, nothing reverts after the
 * transfer. Scratch table; every effect is a fake.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HARBOR_WB_TABLE = join(mkdtempSync(join(tmpdir(), 'wb-switch-')), 'm.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';

const { table } = await import('../src/table/endpoint.ts');
const { runSwitch, contextLine, deliveryIdentity } = await import('../src/engine/switch/fsm.ts');
type SwitchDeps = import('../src/engine/switch/fsm.ts').SwitchDeps;

let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

const ok = (c: unknown, m: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);

let n = 0;
const newOp = (room = `room-${++n}`) =>
  table.createSwitch({
    op_id: `op-${++n}`, room_id: room, instance_id: 'inst', account_id: 'user', project_id: 'proj',
    from_recipe_id: 'r-claude', from_paneid: 'recipe:r-claude#aaaa', from_seat_id: 'seat-1', from_vendor: 'claude-code',
    to_recipe_id: 'r-codex', to_vendor: 'codex-cli', to_model: 'gpt-6.1-sol', to_effort: 'medium', note: 'carry on', expected_lead_seat: 'seat-1',
  });

interface Fake { deps: SwitchDeps; calls: string[]; lead: { seat: string }; held: string[]; crashAt: Set<string>; targets: Map<string, { paneid: string; sessionId: string }>; delivered: string[]; failAt: Record<string, { reason: string; message: string }>; accepted: { v: 'accepted' | 'waiting' } }
function fake(): Fake {
  const f: Fake = { calls: [], lead: { seat: 'seat-1' }, held: ['held-1', 'held-2'], crashAt: new Set(), targets: new Map(), delivered: [], failAt: {}, accepted: { v: 'accepted' }, deps: null as unknown as SwitchDeps };
  const step = async <T>(name: string, body: () => T | Promise<T>): Promise<T> => {
    f.calls.push(name);
    if (f.crashAt.delete(name)) throw new Error(`crash at ${name}`);
    return body();
  };
  const fail = (name: string) => f.failAt[name] ? ({ ok: false, ...f.failAt[name] } as const) : null;
  f.deps = {
    log: () => {},
    preflight: (op) => step('preflight', () => fail('preflight') ?? { ok: true as const }),
    savePacket: (op) => step('savePacket', () => ({ path: `/p/handover-${op.op_id}.md`, sha256: 'a'.repeat(64) })),
    fence: (op) => step('fence', () => fail('fence') ?? { ok: true as const, fromPaneid: op.from_paneid }),
    restoreOld: (op) => step('restoreOld', () => undefined),
    findTarget: (op) => step('findTarget', () => f.targets.get(op.op_id) ?? null),
    startTarget: (op) => step('startTarget', () => {
      const bad = fail('startTarget');
      if (bad) return bad;
      const t = { paneid: `recipe:r-codex#${op.op_id}`, sessionId: `sess-${op.op_id}` };
      f.targets.set(op.op_id, t); // launched: a replay must FIND it
      return { ok: true as const, ...t };
    }),
    bankSessionId: (op) => step('bankSessionId', () => fail('bankSessionId') ?? { ok: true as const, bindingRevision: 7 }),
    deliverContext: (op) => step('deliverContext', () => {
      const bad = fail('deliverContext');
      if (bad) return bad;
      f.delivered.push(`${op.delivery_id}|${op.client_message_id}|${op.delivery_sha256}`);
      return { ok: true as const };
    }),
    contextAccepted: (op) => step('contextAccepted', () => f.accepted.v),
    transferLead: (op) => step('transferLead', () => {
      const bad = fail('transferLead');
      if (bad) return bad;
      if (f.lead.seat !== op.expected_lead_seat) return { ok: false as const, reason: 'lead-changed', message: 'the lead changed during the switch' };
      f.lead.seat = 'seat-NEW';
      return { ok: true as const };
    }),
    releaseHeld: (op) => step('releaseHeld', () => { if (f.failAt.releaseHeld) throw new Error('release failed'); f.calls.push(`released:${f.held.join(',')}`); }),
  };
  return f;
}

console.log('happy path');
{
  const f = fake();
  const op = newOp().row;
  const r = await runSwitch(op.op_id, f.deps);
  eq([r.row.state, r.waiting], ['done', false], 'runs to done');
  eq(f.calls.filter((c) => !c.startsWith('released')), ['preflight', 'savePacket', 'fence', 'findTarget', 'startTarget', 'bankSessionId', 'deliverContext', 'contextAccepted', 'transferLead', 'releaseHeld'], 'steps run in the contract order');
  eq(f.lead.seat, 'seat-NEW', 'the lead moved exactly once');
  eq([r.row.target_session_id, r.row.binding_revision, r.row.packet_sha256?.length], [`sess-${op.op_id}`, 7, 64], 'target session id, binding revision and packet digest are journaled');
  const ident = deliveryIdentity({ op_id: op.op_id, packet_sha256: 'a'.repeat(64), target_session_id: `sess-${op.op_id}` }, contextLine({ op_id: op.op_id, packet_path: `/p/handover-${op.op_id}.md`, packet_sha256: 'a'.repeat(64) }));
  eq(f.delivered[0], `${ident.deliveryId}|${ident.clientMessageId}|${ident.deliverySha256}`, 'the delivery identity is stable and derived from the operation, packet and target session');
  ok(/handover-/.test(contextLine({ op_id: 'x', packet_path: '/p/f.md', packet_sha256: 'b'.repeat(64) })) === false && /\/p\/f\.md/.test(contextLine({ op_id: 'x', packet_path: '/p/f.md', packet_sha256: 'b'.repeat(64) })), 'the delivered line names the packet FILE and digest, not the packet');
}

console.log('one operation per room; a duplicate joins');
{
  const a = newOp('room-dup');
  const b = table.createSwitch({ ...a.row, op_id: 'op-other' } as any);
  eq([a.joined, b.joined, b.row.op_id], [false, true, a.row.op_id], 'a second request for the same room joins the first');
  await runSwitch(a.row.op_id, fake().deps);
  const c = table.createSwitch({ ...a.row, op_id: 'op-after', state: undefined } as any);
  eq(c.joined, false, 'after it is finished, a new operation can start');
}

console.log('crash at EVERY step, then resume: still one target, one lead move, same delivery identity');
// savePacket is not in this list on purpose: an error from it is a HANDLED failure (failed-before-transfer, old restored),
// never a crash to resume, so a project with no folder cannot leave an operation stuck at `intent` (asserted below).
for (const stepName of ['preflight', 'fence', 'findTarget', 'startTarget', 'bankSessionId', 'deliverContext', 'contextAccepted', 'transferLead', 'releaseHeld']) {
  const f = fake();
  const op = newOp().row;
  f.crashAt.add(stepName);
  let crashed = false;
  try { await runSwitch(op.op_id, f.deps); } catch { crashed = true; }
  const r = await runSwitch(op.op_id, f.deps);
  ok((crashed || stepName === 'releaseHeld') && r.row.state === 'done', `crash at ${stepName}: resumes to done${stepName === 'releaseHeld' ? ' (handled as a retryable wait, not an exception)' : ''}`);
  eq(f.targets.size, 1, `  ${stepName}: the target was launched exactly once`);
  eq(f.lead.seat, 'seat-NEW', `  ${stepName}: the lead moved exactly once`);
  ok(new Set(f.delivered).size <= 1, `  ${stepName}: every delivery attempt carried the SAME identity`);
}

{
  const f = fake();
  f.crashAt.add('savePacket');
  const r = await runSwitch(newOp().row.op_id, f.deps);
  ok(r.row.state === 'failed-before-transfer' && /packet-failed/.test(r.row.error ?? ''), 'a savePacket error is a handled failure: failed-before-transfer (packet-failed)');
  ok(f.calls.includes('restoreOld') && f.lead.seat === 'seat-1' && f.targets.size === 0, '  savePacket: old restored, lead untouched, nothing launched');
}

console.log('failure BEFORE the transfer restores the old assistant and leaves the lead alone');
for (const stepName of ['preflight', 'fence', 'startTarget', 'bankSessionId', 'deliverContext', 'transferLead']) {
  const f = fake();
  f.failAt[stepName] = { reason: 'boom', message: `${stepName} failed` };
  const op = newOp().row;
  const r = await runSwitch(op.op_id, f.deps);
  ok(r.row.state === 'failed-before-transfer' && /boom/.test(r.row.error ?? ''), `${stepName} fails: failed-before-transfer with the reason kept`);
  ok(f.calls.includes('restoreOld') && f.lead.seat === 'seat-1', `  ${stepName}: the old assistant is restored and the lead is untouched`);
  ok(!f.calls.includes('releaseHeld'), `  ${stepName}: held input was not released onto a half-switched room`);
}
{
  const f = fake();
  f.lead.seat = 'seat-someone-else'; // the lead changed while we worked
  const r = await runSwitch(newOp().row.op_id, f.deps);
  ok(r.row.state === 'failed-before-transfer' && /lead-changed/.test(r.row.error ?? '') && f.lead.seat === 'seat-someone-else', 'a lead that changed under us is NEVER overwritten (compare-and-set)');
}

console.log('failure AFTER the transfer never reverts and never mints another');
{
  const f = fake();
  f.failAt.releaseHeld = { reason: 'x', message: 'x' };
  const op = newOp().row;
  const r = await runSwitch(op.op_id, f.deps);
  eq([r.row.state, r.waiting], ['lead-committed', true], 'a release failure after the transfer is RETRYABLE: it stays lead-committed and waits');
  ok(!f.calls.includes('restoreOld') && f.lead.seat === 'seat-NEW', 'the old assistant is NOT restored and the lead stays with the target');
  delete f.failAt.releaseHeld;
  const again = await runSwitch(op.op_id, f.deps);
  eq(again.row.state, 'done', 'a retry releases the held input and finishes');
  eq(f.targets.size, 1, '  with no second target');
  const g = fake();
  g.failAt.releaseHeld = { reason: 'x', message: 'x' };
  const op2 = newOp().row;
  await runSwitch(op2.op_id, g.deps);
  const gave = await runSwitch(op2.op_id, g.deps, { giveUp: true });
  ok(gave.row.state === 'failed-after-transfer' && !g.calls.includes('restoreOld') && g.lead.seat === 'seat-NEW', 'giving up is failed-after-transfer: still no revert, the target keeps the lead');
}

console.log('unaccepted context waits; the person may continue on the saved packet');
{
  const f = fake();
  f.accepted.v = 'waiting';
  const op = newOp().row;
  const r1 = await runSwitch(op.op_id, f.deps);
  eq([r1.row.state, r1.waiting], ['context-delivered', true], 'no history evidence: it WAITS, it does not pretend');
  ok(!f.calls.includes('transferLead'), 'the lead has not moved while context is unconfirmed');
  const r2 = await runSwitch(op.op_id, f.deps, { acceptUncertainContext: true });
  eq(r2.row.state, 'done', '"continue anyway" proceeds on the saved packet');
  f.accepted.v = 'accepted';
}
{
  const f = fake();
  f.accepted.v = 'waiting';
  const op = newOp().row;
  await runSwitch(op.op_id, f.deps);
  f.accepted.v = 'accepted';
  const r = await runSwitch(op.op_id, f.deps);
  eq(r.row.state, 'done', 'a later poll that finds the evidence completes it with no second delivery');
  eq(f.delivered.length, 1, '  and the context was delivered exactly once');
}

console.log('cancel is allowed only while reversible');
{
  const f = fake();
  f.accepted.v = 'waiting';
  const op = newOp().row;
  await runSwitch(op.op_id, f.deps);
  const r = await runSwitch(op.op_id, f.deps, { cancel: true });
  ok(r.row.state === 'cancelled' && f.calls.includes('restoreOld') && f.lead.seat === 'seat-1', 'cancel before the transfer restores the old assistant');
  const g = fake();
  const done = newOp().row;
  await runSwitch(done.op_id, g.deps);
  const again = await runSwitch(done.op_id, g.deps, { cancel: true });
  eq(again.row.state, 'done', 'a finished operation cannot be cancelled');
}

console.log('journal: compare-and-set');
{
  const op = newOp().row;
  const first = table.advanceSwitch(op.op_id, op.revision, 'packet-saved', { packet_path: '/x', packet_sha256: 'c'.repeat(64) });
  ok(first && first.revision === op.revision + 1, 'advance bumps the revision');
  eq(table.advanceSwitch(op.op_id, op.revision, 'fenced'), null, 'a stale revision loses the race and changes nothing');
  eq(table.getSwitch(op.op_id)?.state, 'packet-saved', 'and the journal still says what was committed');
  table.advanceSwitch(op.op_id, first!.revision, 'cancelled');
  eq(table.advanceSwitch(op.op_id, first!.revision + 1, 'intent'), null, 'a terminal operation cannot be moved again');
  ok(table.listActiveSwitches().every((s) => !['done', 'cancelled'].includes(s.state)), 'the boot sweep list holds only operations still running');
}

console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
