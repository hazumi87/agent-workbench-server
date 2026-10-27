/**
 * agent-fs (unit) — the DECISION and the LOCATE, without an engine.
 *
 * The end-to-end half lives in `test/agent-fs.test.mjs` (a real engine, a stub
 * agent, the Resume picker). This file covers the two things an HTTP route
 * cannot reach:
 *
 *   1. `remoteFsAccess`'s fourth mode and, more importantly, its PRECEDENCE —
 *      ssh beats agent. That ordering is a decision, not a detail: an alias is
 *      configured and always available, an agent is a live socket that exists
 *      only while someone's desktop is running. Preferring the socket would
 *      have made every server target's Resume picker depend on whether a window
 *      happened to be open.
 *   2. `locateCurrentSessionId` over the agent transport. Locate only runs on a
 *      RESTORE, i.e. behind an attach and a broker spawn — unreachable from a
 *      test that must not spawn anything. Injecting the transport reaches it
 *      directly.
 *
 * NOTHING HERE TOUCHES THE FILESYSTEM OR THE NETWORK. `child_process` is
 * patched to THROW on any spawn attempt (the same guard, and the same
 * `createRequire` trick, self-hosted.test.ts uses — mutating an ESM default or
 * namespace binding does NOT reach another module's own named import), so a
 * regression that quietly fell back to ssh fails loudly instead of hanging.
 */
import { createRequire } from 'node:module';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  if (cond) { pass++; } else { fail++; }
};
const eq = (actual: unknown, expected: unknown, label: string) =>
  ok(Object.is(actual, expected), label, `got ${JSON.stringify(actual)}`);

/* NO SPAWNS. A fall-through to the ssh or local branch must fail, not hang. */
const require_ = createRequire(import.meta.url);
const cp = require_('child_process');
for (const fn of ['execFile', 'spawn', 'exec', 'execFileSync', 'spawnSync'] as const) {
  cp[fn] = () => {
    throw new Error(`child_process.${fn} must never be called on the agent path`);
  };
}

process.env.HARBOR_WB_NODE = 'homebase';
const agentFs = await import('../src/engine/agent-fs.ts');
const launch = await import('../src/engine/launch.ts');
const claudeCode = await import('../src/engine/vendors/claude-code.ts');
type Target = import('../src/engine/launch.ts').Target;

/* ---- a transport that records what it was asked ------------------------- */
interface Sent {
  host: string;
  msg: any;
  timeoutMs: number;
}
function stubTransport(
  hosts: Record<string, string[]>,
  reply: (msg: any) => any,
): { sent: Sent[] } {
  const sent: Sent[] = [];
  agentFs.setTransport({
    has: (host, capability) => (hosts[host] ?? []).includes(capability),
    request: (host, msg, timeoutMs) => {
      sent.push({ host, msg, timeoutMs });
      const r = reply(msg);
      return r instanceof Promise ? r : Promise.resolve(r);
    },
  });
  return { sent };
}

/* =========================================================================
 * PART 1 — remoteFsAccess: the fourth mode, and where it sits.
 * ======================================================================= */
console.log('\n[remoteFsAccess: the agent fills the gap, it does not take a lane]');

const vrpcResident: Target = { id: 'local', label: 'VRPC', kind: 'local', broker: 'vrpc' };
const nucResident: Target = {
  id: 'homebase-resident', label: 'server', kind: 'ssh', sshAlias: 'homeserver-svc-ops', broker: 'homebase',
};
const nucowner: Target = { id: 'homebase-owner', label: 'owner', kind: 'ssh', sshAlias: 'homeserver', broker: 'local' };
const aliasedForeign: Target = {
  id: 'laptop-local', label: 'laptop', kind: 'local', broker: 'laptop', sshAlias: 'laptop',
};

agentFs.setTransport(null);
eq(launch.remoteFsAccess(vrpcResident).mode, 'unreachable', 'no transport wired at all → unreachable (the pre-2026-09-18 answer)');

stubTransport({ vrpc: ['window', 'focus'] }, () => ({ ok: true }));
eq(launch.remoteFsAccess(vrpcResident).mode, 'unreachable', 'an agent WITHOUT "fs" is not a file reader');

stubTransport({ vrpc: ['window', 'fs'], laptop: ['fs'], homebase: ['fs'] }, () => ({ ok: true }));
const chosen = launch.remoteFsAccess(vrpcResident);
eq(chosen.mode, 'agent', 'THE FIX: a foreign-broker target with an fs-capable agent on its host');
eq((chosen as { host: string }).host, 'vrpc', 'and it names the HOST, derived from the broker');

eq(launch.remoteFsAccess(nucResident).mode, 'local', 'self-hosted still wins over everything — no round trip for our own disk');
const viaSsh = launch.remoteFsAccess(nucowner);
eq(viaSsh.mode, 'ssh', 'PRECEDENCE: a kind:ssh target keeps its alias even with an fs agent on that host');
eq(launch.remoteFsAccess(aliasedForeign).mode, 'ssh', 'and a foreign-broker target WITH an alias keeps it too — the agent never displaces a configured path');

console.log('\n[hostOfTarget: one copy of the rungs, four of them]');
eq(launch.hostOfTarget({ id: 'x', label: 'x', kind: 'local', broker: 'vrpc', node: 'pinned' }), 'pinned', 'rung 1: an explicit node pin wins');
eq(launch.hostOfTarget(vrpcResident), 'vrpc', 'rung 2: the broker names the host');
eq(launch.hostOfTarget(nucowner), 'homeserver', 'rung 3: an ssh alias\'s first segment');
eq(launch.hostOfTarget({ id: 'l', label: 'l', kind: 'local', broker: 'local' }), 'homebase', 'rung 4: this engine\'s own node');
eq(launch.hostOfTarget(undefined), 'homebase', 'and an unknown target is this engine');

console.log('\n[fsOptsFor: the one place a mode becomes vendor options]');
eq(JSON.stringify(launch.fsOptsFor({ mode: 'agent', host: 'vrpc' })), '{"agentHost":"vrpc"}', 'agent → agentHost');
eq(JSON.stringify(launch.fsOptsFor({ mode: 'ssh', sshAlias: 'a' })), '{"sshAlias":"a"}', 'ssh → sshAlias');
eq(JSON.stringify(launch.fsOptsFor({ mode: 'local' })), '{}', 'local → nothing (read our own disk)');
eq(JSON.stringify(launch.fsOptsFor({ mode: 'unreachable', reason: 'r' })), '{}',
  'unreachable → nothing, WHICH THE CALLER MUST CHECK FIRST — an unreachable target handed to a reader would read the wrong host\'s disk');

/* =========================================================================
 * PART 2 — locate over the agent transport.
 * ======================================================================= */
console.log('\n[locate: grep for the STRUCTURAL field, newest match wins]');
const BANKED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FORKED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DIR = 'C:\\code\\briefing-table';

{
  const { sent } = stubTransport({ vrpc: ['fs'] }, (msg) => {
    if (msg.type === 'fs.grep') {
      /* Both the banked transcript and the one it forked into carry the field. */
      return { ok: true, matches: [{ name: `${BANKED}.jsonl`, line: 'x' }, { name: `${FORKED}.jsonl`, line: 'x' }] };
    }
    return {
      ok: true,
      entries: [
        { name: `${BANKED}.jsonl`, size: 10, mtime: '2026-09-17T10:00:00.000Z' },
        { name: `${FORKED}.jsonl`, size: 10, mtime: '2026-09-18T10:00:00.000Z' },
        { name: 'unrelated.jsonl', size: 10, mtime: '2026-09-19T10:00:00.000Z' },
      ],
    };
  });
  const found = await claudeCode.locateCurrentSessionId({ banked: BANKED, projectDir: DIR, agentHost: 'vrpc' });
  eq(found, FORKED, 'the NEWEST transcript that links to the banked id — the lineage moved');
  const grepMsg = sent.find((s) => s.msg.type === 'fs.grep')!.msg;
  eq(grepMsg.pattern, `"sessionId":"${BANKED}"`, 'the needle is the structural JSON field, not the bare uuid');
  eq(grepMsg.root, 'claude-projects', 'on the one legal root');
  eq(grepMsg.dir, DIR, 'with the RAW project dir — the agent encodes it');
  eq(grepMsg.glob, '*.jsonl', 'over transcripts only');
  eq(grepMsg.maxMatches, 1, 'and asks for one line per file: we need the NAME, not the content');
  ok(sent.some((s) => s.msg.type === 'fs.list'), 'and a list, for the mtimes the grep cannot supply');
  ok(!sent.some((s) => s.msg.type === 'fs.read'), 'a locate never reads a transcript body');
}

{
  const { sent } = stubTransport({ vrpc: ['fs'] }, (msg) =>
    msg.type === 'fs.grep'
      ? { ok: true, matches: [{ name: `${BANKED}.jsonl`, line: 'x' }] }
      : { ok: true, entries: [] },
  );
  const found = await claudeCode.locateCurrentSessionId({ banked: BANKED, projectDir: DIR, agentHost: 'vrpc' });
  eq(found, BANKED, 'a grep hit with no mtime still answers — better than resuming a stale id');
  eq(sent.length, 2, 'both frames went out concurrently');
}

{
  stubTransport({ vrpc: ['fs'] }, (msg) => (msg.type === 'fs.grep' ? { ok: true, matches: [] } : { ok: true, entries: [] }));
  const found = await claudeCode.locateCurrentSessionId({ banked: BANKED, projectDir: DIR, agentHost: 'vrpc' });
  eq(found, null, 'nothing links → null, and the caller resumes the banked id rather than launching fresh');
}

{
  stubTransport({ vrpc: ['fs'] }, () => Promise.reject(new Error('agent-timeout')));
  const found = await claudeCode.locateCurrentSessionId({ banked: BANKED, projectDir: DIR, agentHost: 'vrpc' });
  eq(found, null, 'a silent desktop → null, NOT a throw: a restore must degrade, never fail');
}

/* =========================================================================
 * PART 3 — the dir check's three outcomes, at the source.
 * ======================================================================= */
console.log('\n[checkProjectDir: three outcomes, and the warning says what was checked]');
{
  stubTransport({ vrpc: ['fs'] }, () => ({ ok: true, entries: [{ name: 'a.jsonl', size: 1, mtime: '2026-09-18T00:00:00.000Z' }] }));
  const r = await agentFs.checkProjectDir('vrpc', DIR);
  eq(r.exists, true, 'transcripts present → TRUE');
  eq(r.warning, undefined, 'and nothing to say');
}
{
  stubTransport({ vrpc: ['fs'] }, () => ({ ok: false, error: 'ENOENT' }));
  const r = await agentFs.checkProjectDir('vrpc', DIR);
  eq(r.exists, false, 'ENOENT → FALSE');
  ok(/transcript dir/.test(r.warning ?? ''), 'and the warning says TRANSCRIPT dir — the agent cannot see the folder itself, and must not pretend to');
}
{
  stubTransport({ vrpc: ['fs'] }, () => ({ ok: true, entries: [] }));
  const r = await agentFs.checkProjectDir('vrpc', DIR);
  eq(r.exists, null, 'an EMPTY dir is UNKNOWN, not missing — a new project and a wrong path look identical from here');
}
{
  stubTransport({ vrpc: ['fs'] }, () => Promise.reject(new Error('agent-timeout')));
  const r = await agentFs.checkProjectDir('vrpc', DIR);
  eq(r.exists, null, 'a timeout is UNKNOWN — the cry-wolf rule (project-dir.ts) holds across the new transport');
  ok(/could not reach/.test(r.warning ?? ''), 'and says so');
}
{
  stubTransport({ vrpc: [] }, () => ({ ok: true, entries: [] }));
  const r = await agentFs.checkProjectDir('vrpc', DIR);
  eq(r.exists, null, 'no fs capability → UNKNOWN, never a verdict');
}

/* =========================================================================
 * PART 4 — read/list guards.
 * ======================================================================= */
console.log('\n[read: the budget is clamped, the offset is never negative]');
{
  const { sent } = stubTransport({ vrpc: ['fs'] }, () => ({ ok: true, data: 'x', size: 1, eof: true }));
  await agentFs.read('vrpc', DIR, 'a.jsonl', { limit: 99 * 1024 * 1024, offset: -5 });
  eq(sent[0].msg.limit, agentFs.READ_MAX_BYTES, 'a read over the 1 MiB ceiling is CLAMPED, not refused — the ceiling is protocol, the budget is taste');
  eq(sent[0].msg.offset, 0, 'and a negative offset floors at 0 (there is no negative-offset rule in the frame spec, on purpose)');
  await agentFs.read('vrpc', DIR, 'a.jsonl');
  eq(sent[1].msg.limit, agentFs.READ_DEFAULT_BYTES, 'the default is 64 KiB');
}
{
  stubTransport({}, () => ({ ok: true }));
  let threw = '';
  try {
    await agentFs.list('vrpc', DIR);
  } catch (e) {
    threw = (e as { code?: string }).code ?? '';
  }
  eq(threw, 'no-agent', 'asking a host with no fs agent REJECTS with a distinguishable code — it never silently answers empty');
}

agentFs.setTransport(null); // never leave a stub wired for the next test in this process

console.log('\n========================================');
console.log(`PASS ${pass}  FAIL ${fail}`);
if (fail > 0) {
  process.exit(1);
}
console.log('all green');
