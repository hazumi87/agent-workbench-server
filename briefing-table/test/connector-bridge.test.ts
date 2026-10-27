/**
 * Codex connector, ENGINE half (ticket/2031/2032): binding / handoff / outbox / dedup tables,
 * the one-writer guards and the canonical submission ids. Scratch table; nothing connects to a
 * connector (the path is disabled). Run with tsx.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HARBOR_WB_TABLE = join(mkdtempSync(join(tmpdir(), 'wb-connector-')), 'm.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
delete process.env.HARBOR_WB_CONNECTOR;

const { table } = await import('../src/table/endpoint.ts');
const bridge = await import('../src/engine/connector-bridge.ts');
const typer = await import('../src/engine/room-typer.ts');
const hook = await import('../src/engine/agent-hook.ts');

let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

function ok(c: unknown, m: string): void {
  checks++;
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failed++;
}
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`}`);
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const PANE = 'recipe:r1#aaaa1111';
table.upsert({ paneid: PANE, server: 'local', vendor: 'codex-cli', agent: 'a', session_id: null, state: 'live', interrupted: 0 } as any);

console.log('flag off, no rows: everything inert');
eq(bridge.enabled(), false, 'disabled by default');
eq(bridge.isOwned(PANE), false, 'a pane with no binding is not owned');
eq(bridge.offerSubmission({ paneid: PANE, submissionId: 'x', text: 'hi' }), { status: 'not-owned' }, 'an offer for an unowned pane is not-owned');
eq(bridge.restorable(PANE), null, 'restorable is "no opinion" for an unowned pane');

console.log('binding + persist-before-acknowledge');
const b0 = table.createConnectorBinding('rt-1', PANE);
eq([b0.incarnation, b0.state, b0.thread_id], [1, 'creation-pending', null], 'a new binding: incarnation 1, no thread');
eq(table.createConnectorBinding('rt-1', PANE).revision, 0, 'creating again is idempotent');
ok(bridge.isOwned(PANE), 'a pane with a binding row is owned (flag or not)');
const snap = { runtimeInstanceId: 'rt-1', generation: 1, revision: 1, threadId: 'thr-AAAA', codexSessionId: 'tree-1' };
const c1 = bridge.commitSnapshot(snap);
eq([c1.thread_id, c1.state, c1.codex_session_id], ['thr-AAAA', 'bound', 'tree-1'], 'commit stores the thread and the session-tree id apart');
eq(table.get(PANE)?.session_id, 'thr-AAAA', 'sessions.session_id carries the THREAD id');
eq(bridge.commitSnapshot(snap).revision, 1, 'replaying the same commit is a no-op');
ok(throws(() => bridge.commitSnapshot({ ...snap, threadId: 'thr-OTHER', revision: 2 })), 'a different thread for a bound runtime is refused');
ok(throws(() => bridge.commitSnapshot({ ...snap, generation: 9 })), 'a wrong incarnation is refused');
eq(table.get(PANE)?.session_id, 'thr-AAAA', 'and nothing was written by the refusals');
eq(bridge.restorable(PANE), false, 'not restorable until history is materialized');
table.markConnectorMaterialized('rt-1', 'thr-AAAA');
eq(bridge.restorable(PANE), true, 'restorable once the connector reported history');

console.log('hook / adoption id banking is refused on a connector-owned pane');
table.adoptSessionId(PANE, 'tree-1');
eq(table.get(PANE)?.session_id, 'thr-AAAA', 'adoptSessionId never moves the connector thread');
const banked: string[] = [];
hook.handleAgentHook(
  { vendor: 'codex-cli', paneid: PANE },
  { session_id: '11111111-2222-3333-4444-555555555555', hook_event_name: 'SessionStart' },
  { get: (p: string) => table.get(p) as any, adoptSessionId: (p: string, s: string) => { banked.push(s); table.adoptSessionId(p, s); }, activity: {} as any, log: () => {} } as any,
);
eq(table.get(PANE)?.session_id, 'thr-AAAA', 'a Codex hook cannot overwrite the connector thread');

console.log('typer guard');
const g: any = { enabled: true, live: true, vendor: 'codex-cli', claude: null, startup: false, state: 'idle', busy: false, draft: 'clean', now: 1, lastOutputAt: 0, settleMs: 0 };
eq(typer.blockReason({ ...g, connectorOwned: true }), 'connector-owned', 'room-typer holds a connector-owned pane');
ok(typer.blockReason({ ...g, connectorOwned: false }) !== 'connector-owned', 'and only that');

console.log('canonical submissions + dedup');
const sid = bridge.roomSubmissionId('room-1', 42, 'seat-1');
eq(sid, 'room:room-1:line:42:seat:seat-1', 'room line id is (room, line, seat)');
eq(bridge.fabricSubmissionId('env-9'), 'fabric:env-9', 'fabric id');
eq(bridge.offerSubmission({ paneid: PANE, submissionId: sid, text: 'do it', source: { l: 42 } }).status, 'new', 'first offer is new');
eq(bridge.offerSubmission({ paneid: PANE, submissionId: sid, text: 'do it', source: { l: 42 } }).status, 'duplicate', 'the same line again is a duplicate');
eq(bridge.offerSubmission({ paneid: PANE, submissionId: sid, text: 'do IT', source: { l: 42 } }).status, 'conflict', 'same id, different content: refused');

console.log('outbox journal: revisioned compare-and-set');
const j = bridge.journalFor<{ revision: number; n: number }>('rt-1');
eq(await j.read(), undefined, 'no row yet');
await j.write({ revision: 1, n: 1 }, undefined);
eq((await j.read())?.n, 1, 'first write lands');
let stale = false;
try { await j.write({ revision: 2, n: 2 }, undefined); } catch { stale = true; }
ok(stale, 'a second "first write" is refused');
await j.write({ revision: 2, n: 2 }, 1);
let stale2 = false;
try { await j.write({ revision: 3, n: 3 }, 1); } catch { stale2 = true; }
ok(stale2 && (await j.read())?.n === 2, 'a stale previous revision is refused and writes nothing');

console.log('lease');
let live = true;
const lease = bridge.leaseFor('rt-1', () => live)!;
eq([lease.generation, lease.threadId, lease.isCurrent()], [1, 'thr-AAAA', true], 'a bound runtime leases its incarnation');
live = false;
ok(!lease.isCurrent(), 'a dead pane revokes the lease');
live = true;
ok(bridge.leaseFor('missing', () => true) === null, 'no binding, no lease');

console.log('incarnation handoff');
const NEWPANE = 'recipe:r1#bbbb2222';
table.upsert({ paneid: NEWPANE, server: 'local', vendor: 'codex-cli', agent: 'a', session_id: null, state: 'live', interrupted: 0 } as any);
const h = bridge.beginHandoff('rt-1', NEWPANE);
eq([h.incarnation, h.handoff, h.paneid, h.thread_id], [2, 'pending-connector', NEWPANE, 'thr-AAAA'], 'N -> N+1 in one step, thread kept, intent durable');
ok(!lease.isCurrent(), 'the old lease is fenced at once');
eq(bridge.beginHandoff('rt-1', NEWPANE).incarnation, 2, 'replaying the intent does not bump again');
eq((await j.read())?.n, 2, 'the outbox row survives the handoff');
eq(bridge.offerSubmission({ paneid: NEWPANE, submissionId: sid, text: 'do it', source: { l: 42 } }).status, 'duplicate', 'dedup spans incarnations (scoped to the runtime)');
ok(bridge.leaseFor('rt-1', () => true)!.isCurrent() === false, 'a pending handoff holds the new lease too');
eq(bridge.acknowledgeHandoff('rt-1', 2)?.handoff, null, 'acknowledging clears the intent');
ok(bridge.leaseFor('rt-1', () => true)!.isCurrent(), 'and the new incarnation leases');
ok(throws(() => table.handoffConnectorBinding({ runtimeId: 'rt-1', fromIncarnation: 1, toIncarnation: 2, paneid: NEWPANE })), 'a stale (from, to) is refused');
ok(throws(() => table.handoffConnectorBinding({ runtimeId: 'rt-1', fromIncarnation: 2, toIncarnation: 4, paneid: NEWPANE })), 'skipping an incarnation is refused');
eq(bridge.isOwned(PANE), false, 'the old pane is no longer associated');
eq(bridge.isOwned(NEWPANE), true, 'the new one is');

console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
