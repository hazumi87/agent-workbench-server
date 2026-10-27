/* platform.test — Phase 1 host-agnosticism (the migration plan).
 *
 * Two things this guards:
 *  - `sshBinary()`/`isWindows` pick the right ssh binary per platform. The
 *    2026-07-07 Discovery (CLAUDE.md) is that node-pty on Windows needs the
 *    explicit `.exe` — a bare `ssh` throws "File not found" there even though
 *    `where ssh` resolves it. Elsewhere a bare `ssh` is correct.
 *  - `loadTargets()` normalises every target's `broker` field to `'local'`
 *    when the target doesn't name one, so callers (`buildLaunch`) can branch
 *    on `t.broker !== 'local'` instead of re-deriving the default.
 *
 * `platform.ts`'s `isWindows` is computed ONCE at module load from
 * `process.platform`, so exercising both branches needs a FRESH module
 * instance per platform — a cache-busting query string forces that without
 * changing the production module's shape (a plain frozen const, not a getter).
 */
let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  cond ? pass++ : fail++;
};

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
const realPlatform = process.platform;

async function freshPlatformModule() {
  return import(`../src/engine/platform.ts?probe=${Math.random()}`);
}

console.log('\n[sshBinary() / isWindows per platform]');
setPlatform('win32');
const win = await freshPlatformModule();
ok(win.isWindows === true, 'isWindows true on win32');
ok(win.sshBinary() === 'ssh.exe', 'sshBinary() is ssh.exe on win32', win.sshBinary());

setPlatform('linux');
const linux = await freshPlatformModule();
ok(linux.isWindows === false, 'isWindows false on linux');
ok(linux.sshBinary() === 'ssh', 'sshBinary() is bare ssh on linux', linux.sshBinary());

setPlatform('darwin');
const mac = await freshPlatformModule();
ok(mac.isWindows === false, 'isWindows false on darwin');
ok(mac.sshBinary() === 'ssh', 'sshBinary() is bare ssh on darwin', mac.sshBinary());

setPlatform(realPlatform); // restore before touching anything else in the process

console.log('\n[loadTargets(): every target names its broker explicitly]');
const { loadTargets } = await import('../src/engine/launch.ts');

process.env.HARBOR_WB_TARGETS = JSON.stringify({
  targets: [
    { id: 'local', label: 'Local', kind: 'local', shell: 'powershell.exe' },
    { id: 'plain-ssh', label: 'Plain ssh', kind: 'ssh', sshAlias: 'somealias' },
    { id: 'resident', label: 'Resident', kind: 'ssh', sshAlias: 'somealias2', broker: 'homebase' },
  ],
});
const targets = loadTargets();
const byId = (id: string) => targets.find((t) => t.id === id);

ok(byId('local')?.broker === 'local', "kind:'local' with no broker normalises to 'local'", byId('local')?.broker);
ok(
  byId('plain-ssh')?.broker === 'local',
  "kind:'ssh' with no broker normalises to 'local' (an ssh CLIENT on the local broker, not a remote broker)",
  byId('plain-ssh')?.broker,
);
ok(
  byId('resident')?.broker === 'homebase',
  'an EXPLICIT broker is preserved, never overwritten',
  byId('resident')?.broker,
);

delete process.env.HARBOR_WB_TARGETS;

/* Phase 5 (2026-09-16): an ssh-kind target whose ssh CLIENT runs in a REMOTE
   broker — the VRPC broker seen from the server engine. The descriptor binary
   follows THAT broker's platform, not the engine's. */
process.env.HARBOR_WB_BROKERS = JSON.stringify({
  vrpc: { url: 'ws://127.0.0.1:1', platform: 'win32' },
  other: { url: 'ws://127.0.0.1:2' },
});
const { buildLaunch } = await import('../src/engine/launch.ts');
const recipe = { id: 'r', name: 'r', projectDir: '/opt/x', runClaude: false, initCmd: null } as never;
const viaVrpc = buildLaunch(recipe, { id: 'homebase-owner', label: 'x', kind: 'ssh', sshAlias: 'homeserver', broker: 'vrpc', sshClient: true }, null, null);
ok(viaVrpc.descriptor.binary === 'ssh.exe', "sshClient target in a win32 broker spawns 'ssh.exe' there", viaVrpc.descriptor.binary);
ok(viaVrpc.descriptor.args[1] === 'homeserver', 'the ssh alias is passed to the client', viaVrpc.descriptor.args[1]);
ok(viaVrpc.brokerHost === 'vrpc', 'the pty lives in the named broker', viaVrpc.brokerHost);
const viaOther = buildLaunch(recipe, { id: 'x2', label: 'x', kind: 'ssh', sshAlias: 'a', broker: 'other', sshClient: true }, null, null);
ok(viaOther.descriptor.binary === 'ssh', "sshClient target in a linux broker spawns 'ssh'", viaOther.descriptor.binary);
const resident = buildLaunch(recipe, { id: 'res', label: 'x', kind: 'ssh', sshAlias: 'a', broker: 'other' }, null, null);
ok(resident.descriptor.binary === 'bash', 'without sshClient a remote broker target is still RESIDENT (bash -il)', resident.descriptor.binary);
delete process.env.HARBOR_WB_BROKERS;

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${pass}  FAIL ${fail}`);
console.log(fail ? 'FAILURES' : 'all green');
process.exit(fail ? 1 : 0);
