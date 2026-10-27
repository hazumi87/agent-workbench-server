/**
 * The inbound envelope: what is accepted, what is refused, and what it says
 * when it refuses.
 *
 * The refusal MESSAGE is under test as much as the refusal, because the callers
 * of this route are other brands' adapters written against a draft contract by
 * people who cannot read our logs. A 400 that says "invalid envelope" is a 400
 * they have to guess about; a 400 that names the field is a bug report.
 *
 * Run with tsx.
 */
const fabric = await import('../src/engine/fabric.ts');

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed += 1;
    console.log(`  ✓ ${msg} (${String(actual)})`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

const GOOD = {
  id: 'env-0001',
  ts: '2026-09-17T09:00:00.000Z',
  from: 'platform',
  to: 'briefing-table-cli',
  kind: 'msg',
  class: 'coordination',
  attention: 'notice',
  thread: 't:cafebabe',
  body: 'the broker pin moved; re-read before you deploy',
  ack: 'none',
};

console.log('\n[a complete envelope passes and comes back normalised]');
const okRes = fabric.validate(GOOD);
eq(okRes.ok, true, 'the contract §2 shape is accepted');
if (okRes.ok) {
  eq(okRes.envelope.from, 'platform', 'from survives');
  eq(okRes.envelope.kind, 'msg', 'kind survives');
  eq(okRes.envelope.class, 'coordination', 'class survives');
  eq(okRes.envelope.attention, 'notice', 'attention survives');
  eq(okRes.envelope.ack, 'none', 'ack survives');
  eq('deadline' in okRes.envelope, false, 'absent optionals are ABSENT, not null');
  eq('consequence' in okRes.envelope, false, 'ditto consequence');
  eq('ref' in okRes.envelope, false, 'ditto ref');
}

console.log('\n[every required field, named when it is missing]');
for (const field of ['id', 'ts', 'from', 'to', 'thread'] as const) {
  const res = fabric.validate({ ...GOOD, [field]: undefined });
  eq(res.ok, false, `${field} missing is refused`);
  if (!res.ok) {
    eq(res.field, field, `...and the 400 NAMES ${field}`);
  }
}
for (const field of ['kind', 'class', 'attention', 'ack'] as const) {
  const res = fabric.validate({ ...GOOD, [field]: undefined });
  eq(res.ok, false, `${field} missing is refused`);
  if (!res.ok) {
    eq(res.field, field, `...and the 400 NAMES ${field}`);
  }
}

console.log('\n[enums are enums — a plausible-looking value is still wrong]');
for (const [field, bad] of [
  ['kind', 'message'],
  ['class', 'urgent'],
  ['attention', 'high'],
  ['ack', 'acked'],
] as const) {
  const res = fabric.validate({ ...GOOD, [field]: bad });
  eq(res.ok, false, `${field}="${bad}" is refused`);
  if (!res.ok) {
    eq(res.field, field, `...naming ${field}`);
    eq(res.error.includes('|'), true, '...and listing the legal values');
  }
}

console.log('\n[body OR ref — a message must carry one of them]');
const noBody = fabric.validate({ ...GOOD, body: undefined });
eq(noBody.ok, false, 'neither body nor ref is refused');
if (!noBody.ok) {
  eq(noBody.field, 'body', 'named as body (the one the sender almost always meant)');
  eq(noBody.error.includes('ref'), true, '...while pointing at ref for a pointer');
}
const refOnly = fabric.validate({ ...GOOD, body: undefined, ref: 'kb:design-notes-id' });
eq(refOnly.ok, true, 'ref alone is a complete envelope');

console.log('\n[the body cap enforces "never bulk bytes" (contract §2)]');
const huge = fabric.validate({ ...GOOD, body: 'x'.repeat(4001) });
eq(huge.ok, false, 'an oversized body is refused');
if (!huge.ok) {
  eq(huge.field, 'body', '...named, not silently truncated');
}
eq(fabric.validate({ ...GOOD, body: 'x'.repeat(4000) }).ok, true, 'exactly at the cap is fine');

console.log('\n[optional declared fields ride through]');
const withDecl = fabric.validate({
  ...GOOD,
  kind: 'ask',
  class: 'attention-needed',
  attention: 'ask',
  deadline: '2026-09-17T10:00:00.000Z',
  consequence: 'the deploy goes out with the old pin',
});
eq(withDecl.ok, true, 'consequence + deadline accepted');
if (withDecl.ok) {
  eq(withDecl.envelope.deadline, '2026-09-17T10:00:00.000Z', 'deadline carried');
  eq(withDecl.envelope.consequence, 'the deploy goes out with the old pin', 'consequence carried');
}

console.log('\n[the pending list: cap, dismiss, drop]');
fabric.reset();
eq(fabric.pendingFor('p1').length, 0, 'a pane starts empty');
const one = fabric.push('p1', (fabric.validate(GOOD) as { ok: true; envelope: any }).envelope);
eq(one.length, 1, 'push returns the new list');
eq(fabric.pendingFor('p1').length, 1, 'and it is pending');
for (let i = 0; i < 60; i += 1) {
  fabric.push('p1', (fabric.validate({ ...GOOD, id: `e${i}` }) as { ok: true; envelope: any }).envelope);
}
eq(fabric.pendingFor('p1').length, 50, 'capped at 50, oldest out');
eq(fabric.pendingFor('p1')[0].id, 'e10', 'the survivors are the NEWEST 50 (61 pushed)');
eq(fabric.dismiss('p1', 'e11').length, 49, 'dismiss by id removes exactly one');
eq(fabric.pendingFor('p1').some((e) => e.id === 'e11'), false, '...and it is the right one');
eq(fabric.dismiss('p1').length, 0, 'dismiss-all clears the pane');
fabric.push('p2', (fabric.validate(GOOD) as { ok: true; envelope: any }).envelope);
fabric.drop('p2');
eq(fabric.pendingFor('p2').length, 0, 'drop takes the messages with the session');
eq(fabric.pendingFor('p1').length, 0, '...and never touches another pane');

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
