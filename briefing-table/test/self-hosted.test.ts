/**
 * self-hosted — the polarity bug (2026-09-17): a target's transcripts can sit
 * on THIS engine's own host even when the target is `kind:'ssh'`, and a
 * target can be `kind:'local'` and still be someone ELSE's host.
 *
 * THE BUG THIS GUARDS: `homebase-resident` (`kind:'ssh'`, sshAlias
 * 'homeserver-svc-ops', `broker:'homebase'`) was built for a VRPC-hosted
 * engine reaching the server over ssh. The engine has since moved onto the server
 * itself and the target was never re-pointed, so the old
 * `t.kind === 'ssh' ? (t.sshAlias ?? t.id) : undefined` ternary kept ssh-ing
 * the server's svc-ops account to itself — which it cannot do — and the
 * Resume picker came back empty. The mirror-image bug: the server's own "local"
 * target (kind:'local', broker:'vrpc' — broker-resident on the OTHER host)
 * was read as local disk, producing "no such directory on this PC: C:/tmp"
 * for a path that meant the VRPC.
 *
 * This file proves `isSelfHosted`/`remoteFsAccess` resolve both shapes
 * correctly, and that the real `listSessions`/`locateCurrentSessionId`
 * functions — driven by what `remoteFsAccess` hands them — read the local
 * fixture WITHOUT ever spawning ssh.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  if (cond) { pass++; } else { fail++; }
};
const eq = (actual: unknown, expected: unknown, label: string) =>
  ok(Object.is(actual, expected), label, `got ${JSON.stringify(actual)}`);

/* ---------------------------------------------------------------------------
 * PART 1 — isSelfHosted / remoteFsAccess, pure decision logic, both shapes of
 * targets.json this repo has actually run with (server-hosted and VRPC-hosted).
 * ------------------------------------------------------------------------- */
process.env.HARBOR_WB_NODE = 'homebase';
const launch = await import('../src/engine/launch.ts');
const { isSelfHosted, remoteFsAccess, engineNode } = launch;
type Target = import('../src/engine/launch.ts').Target;

eq(engineNode(), 'homebase', 'engineNode() reads HARBOR_WB_NODE');

console.log('\n[isSelfHosted: the server-hosted engine\'s own targets.json shapes]');
const nucResident: Target = {
  id: 'homebase-resident',
  label: 'server (resident)',
  kind: 'ssh',
  sshAlias: 'homeserver-svc-ops',
  broker: 'homebase',
};
ok(isSelfHosted(nucResident), 'THE BUG: kind ssh + broker naming this engine\'s own node IS self-hosted');

const foreignLocal: Target = { id: 'local', label: 'Local (VRPC)', kind: 'local', broker: 'vrpc' };
ok(!isSelfHosted(foreignLocal), 'kind local + a FOREIGN broker is NOT self-hosted — the mirror bug');

const plainLocal: Target = { id: 'local', label: 'Local (this PC)', kind: 'local', broker: 'local' };
ok(isSelfHosted(plainLocal), 'kind local + broker "local" (the loadTargets default) is self-hosted');

const plainLocalNoBroker: Target = { id: 'local', label: 'Local', kind: 'local' } as Target;
ok(isSelfHosted(plainLocalNoBroker), 'kind local with broker UNSET normalises the same as "local"');

for (const sshClientTarget of [
  { id: 'homebase-owner', label: 'owner', kind: 'ssh' as const, sshAlias: 'homebase-owner', broker: 'vrpc', sshClient: true },
  { id: 'laptop', label: 'laptop', kind: 'ssh' as const, sshAlias: 'laptop', broker: 'vrpc', sshClient: true },
]) {
  ok(!isSelfHosted(sshClientTarget), `${sshClientTarget.id}: ssh-client-in-a-foreign-broker stays remote`);
}

console.log('\n[isSelfHosted: the VRPC-hosted engine\'s (historic) shape still resolves right]');
process.env.HARBOR_WB_NODE = 'vrpc';
const vrpcLocal: Target = { id: 'local', label: 'Local (this PC)', kind: 'local', broker: 'local' };
ok(isSelfHosted(vrpcLocal), 'the VRPC\'s own "local" target is self-hosted there');
const nucViaSshFromVrpc: Target = { id: 'homebase', label: 'server', kind: 'ssh', sshAlias: 'homebase-alias', broker: 'local' };
ok(!isSelfHosted(nucViaSshFromVrpc), 'a plain ssh target (broker unset/local) is never self-hosted by kind alone');
process.env.HARBOR_WB_NODE = 'homebase'; // back to the server shape for the rest of this file

console.log('\n[isSelfHosted: t.node is the authoritative override]');
ok(isSelfHosted({ id: 'x', label: 'x', kind: 'ssh', sshAlias: 'a', broker: 'vrpc', node: 'homebase' } as Target),
  't.node pins self-hosted even when broker disagrees');
ok(!isSelfHosted({ id: 'x', label: 'x', kind: 'local', broker: 'local', node: 'vrpc' } as Target),
  't.node pins REMOTE even for a plain local target');

console.log('\n[remoteFsAccess: local / ssh / unreachable, the three outcomes]');
eq(remoteFsAccess(nucResident).mode, 'local', 'self-hosted ssh target resolves to local disk, no alias used');
const remoteSsh: Target = { id: 'r', label: 'r', kind: 'ssh', sshAlias: 'some-alias', broker: 'local' };
const remoteAccess = remoteFsAccess(remoteSsh);
eq(remoteAccess.mode, 'ssh', 'a genuinely remote ssh target keeps the ssh path');
ok(remoteAccess.mode === 'ssh' && remoteAccess.sshAlias === 'some-alias', 'and carries its alias through');
const unreachable = remoteFsAccess(foreignLocal);
eq(unreachable.mode, 'unreachable', 'foreign-broker local target with NO alias is unreachable, never local');
ok(
  unreachable.mode === 'unreachable' && /broker "vrpc"/.test(unreachable.reason) && /homebase/.test(unreachable.reason),
  'the reason names both the foreign broker and this engine\'s own node',
  unreachable.mode === 'unreachable' ? unreachable.reason : '',
);
const foreignLocalWithAlias: Target = { ...foreignLocal, sshAlias: 'vrpc-alias' };
const reachable = remoteFsAccess(foreignLocalWithAlias);
ok(
  reachable.mode === 'ssh' && reachable.sshAlias === 'vrpc-alias',
  'a foreign-broker local target WITH an alias configured is reachable over ssh',
);
eq(remoteFsAccess(undefined).mode, 'local', 'an unresolved target falls back to local, matching the historic default');

/* ---------------------------------------------------------------------------
 * PART 2 — the real listSessions/locateCurrentSessionId functions, driven by
 * what remoteFsAccess hands them, against a fixture transcript dir, with
 * child_process patched so an ssh spawn attempt FAILS the test rather than
 * silently hanging or reaching the network.
 * ------------------------------------------------------------------------- */
const root = mkdtempSync(join(tmpdir(), 'wb-selfhosted-'));
process.env.HARBOR_WB_CLAUDE_PROJECTS = root;
const claudeCode = await import('../src/engine/vendors/claude-code.ts');

const PROJECT = '/srv/code/homebase-project';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const dir = join(root, claudeCode.encodeProjectDir(PROJECT));
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, `${SESSION}.jsonl`),
  JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    lastPrompt: 'fixture prompt',
    customTitle: 'Self-hosted fixture',
  }),
);

// Patch the SAME underlying module object node's ESM loader reads live named
// exports from (proven: mutating via createRequire propagates; mutating a
// `import cp from 'node:child_process'` default binding does NOT).
const require = createRequire(import.meta.url);
const cp = require('child_process') as typeof import('node:child_process');
const originalExecFile = cp.execFile;
const originalSpawn = cp.spawn;
let sshSpawnAttempted = false;
// @ts-expect-error — test-only signature relaxation
cp.execFile = (...args: unknown[]) => {
  sshSpawnAttempted = true;
  throw new Error(`unexpected execFile spawn during self-hosted op: ${JSON.stringify(args[0])} ${JSON.stringify(args[1])}`);
};
// @ts-expect-error — test-only signature relaxation
cp.spawn = (...args: unknown[]) => {
  sshSpawnAttempted = true;
  throw new Error(`unexpected spawn during self-hosted op: ${JSON.stringify(args[0])} ${JSON.stringify(args[1])}`);
};

console.log('\n[listSessions: a self-hosted ssh-kind target reads local, no ssh spawn]');
try {
  const access = remoteFsAccess(nucResident);
  const rows = await claudeCode.listSessions({
    projectDir: PROJECT,
    sshAlias: access.mode === 'ssh' ? access.sshAlias : undefined,
    limit: 40,
  });
  eq(rows.length, 1, 'the fixture session was listed');
  eq(rows[0]?.sessionId, SESSION, 'with its id');
  eq(rows[0]?.title, 'Self-hosted fixture', 'and its title, straight off local disk');
  ok(!sshSpawnAttempted, 'no ssh spawn happened');
} catch (e) {
  ok(false, 'listSessions threw', (e as Error).message);
}

console.log('\n[locateCurrentSessionId: same target, same guarantee]');
sshSpawnAttempted = false;
try {
  const access = remoteFsAccess(nucResident);
  const located = await claudeCode.locateCurrentSessionId({
    banked: SESSION,
    projectDir: PROJECT,
    sshAlias: access.mode === 'ssh' ? access.sshAlias : undefined,
  });
  eq(located, SESSION, 'locates the fixture transcript locally');
  ok(!sshSpawnAttempted, 'no ssh spawn happened');
} catch (e) {
  ok(false, 'locateCurrentSessionId threw', (e as Error).message);
}

console.log('\n[a genuinely remote target still WOULD go through ssh — mechanism unchanged]');
// Not exercised end-to-end here (no reachable host in a unit test) — just
// confirm remoteFsAccess still hands listSessions a real alias for it, i.e.
// the ssh branch inside claude-code.ts is reachable and untouched.
{
  const access = remoteFsAccess(remoteSsh);
  ok(access.mode === 'ssh' && access.sshAlias === 'some-alias', 'a real remote target still resolves to ssh mode');
}

cp.execFile = originalExecFile;
cp.spawn = originalSpawn;

/* ---------------------------------------------------------------------------
 * PART 3 — the dir-check, composed exactly as server/index.ts's recipe-save
 * route composes it: remoteFsAccess -> checkProjectDir, or a direct
 * unreachable answer with no filesystem touch at all.
 * ------------------------------------------------------------------------- */
const { checkProjectDir } = await import('../src/engine/project-dir.ts');

console.log('\n[dir-check: self-hosted checks the local FS]');
const realDir = mkdtempSync(join(tmpdir(), 'wb-selfhosted-real-'));
{
  const access = remoteFsAccess(nucResident);
  eq(access.mode, 'local', 'self-hosted target resolves to local mode');
  const check = access.mode === 'unreachable'
    ? { exists: null as boolean | null, warning: access.reason }
    : await checkProjectDir(realDir, access.mode === 'ssh' ? { sshAlias: access.sshAlias } : {});
  eq(check.exists, true, 'the real local directory is found');
}

console.log('\n[dir-check: a foreign-broker local target returns exists:null with a reason, no local FS touch]');
{
  const access = remoteFsAccess(foreignLocal);
  eq(access.mode, 'unreachable', 'foreign-broker target with no alias is unreachable');
  const check = access.mode === 'unreachable'
    ? { exists: null as boolean | null, warning: access.reason }
    : await checkProjectDir('C:/tmp', access.mode === 'ssh' ? { sshAlias: access.sshAlias } : {});
  eq(check.exists, null, 'exists is null — "cannot tell", never a guessed true/false');
  ok(!!check.warning && /broker "vrpc"/.test(check.warning), 'the warning names the mismatch', check.warning);
}

rmSync(root, { recursive: true, force: true });
rmSync(realDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(40)}\nPASS ${pass}  FAIL ${fail}`);
if (fail) {
  process.exit(1);
}
console.log('all green');
