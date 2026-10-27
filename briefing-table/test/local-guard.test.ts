/**
 * E6 + E2. The local-mode guard is read at CALL time (a mode set after import still refuses NATS, the fabric and channels), and
 * enginePort() returns the port the engine actually bound, never the start-up 0.
 */
import { boundPort, enginePort, networkServicesRefused, setBoundPort } from '../src/engine/local-guard.ts';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
}

ok(networkServicesRefused({ HARBOR_WB_MODE: ' Local ' }) && !networkServicesRefused({}) && !networkServicesRefused({ HARBOR_WB_MODE: 'server' }), 'refused only in local mode, case- and space-insensitive');

/* server mode, everything on: the guard changes nothing. The URLs are read when the modules load, so set them first. */
process.env.HARBOR_WB_NATS_URL = 'nats://example.invalid:4222';
process.env.HARBOR_WB_FABRIC_URL = 'http://127.0.0.1:8204';
process.env.HARBOR_WB_CHANNELS = '1';
delete process.env.HARBOR_WB_MODE;
const telemetry = await import('../src/engine/telemetry.ts');
const fabricSub = await import('../src/engine/fabric-subscriber.ts');
const channels = await import('../src/engine/channels.ts');
const { ensureHooksFile } = await import('../src/engine/codex-hooks.ts');
ok(telemetry.enabled(), 'server mode: telemetry follows its URL');
ok(fabricSub.endpoint().enabled && fabricSub.endpoint().url === 'http://127.0.0.1:8204', 'server mode: the fabric endpoint follows its URL');
ok(channels.enabled(), 'server mode: channels follow their switch');

/* the same process flips to local mode AFTER import, with every service env still set */
process.env.HARBOR_WB_MODE = 'local';
ok(!telemetry.enabled(), 'local: telemetry is off whatever HARBOR_WB_NATS_URL says');
let sent = 0;
telemetry.setPublisher(() => sent++);
telemetry.publishJson('x.y', { a: 1 });
telemetry.setPublisher(null);
ok(sent === 0, 'local: publishJson sends nothing, even through the test seam');
ok(!fabricSub.endpoint().enabled && fabricSub.endpoint().url === '', 'local: the fabric endpoint reports off with no URL');
ok(!channels.enabled(), 'local: channels are off whatever HARBOR_WB_CHANNELS says');
delete process.env.HARBOR_WB_MODE;

/* E2 */
setBoundPort(null);
process.env.HARBOR_WB_PORT = '0';
ok(boundPort() === null && enginePort({ HARBOR_WB_PORT: '7420' }) === 7420 && enginePort({}) === 7420, 'server mode before listen: the configured port, default 7420');
ok(enginePort({ HARBOR_WB_MODE: 'local', HARBOR_WB_PORT: '0' }) === 0, 'local before listen: 0, never a guess at 7420 (the real server)');
setBoundPort(51234);
ok(boundPort() === 51234 && enginePort({ HARBOR_WB_MODE: 'local', HARBOR_WB_PORT: '0' }) === 51234, 'after listen: the bound port, whatever the setting said');
setBoundPort(0);
ok(boundPort() === null, 'a non-port clears it');
setBoundPort(51234);

const { mkdtempSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir = mkdtempSync(join(tmpdir(), 'localguard-'));
const r = ensureHooksFile(dir, enginePort({ HARBOR_WB_MODE: 'local', HARBOR_WB_PORT: '0' }));
const text = r.path ? readFileSync(r.path, 'utf8') : '';
ok(/:51234\b/.test(text) && !/:0\//.test(text), 'the Codex hooks file carries the bound port');

console.log('\n[a pane learns the engine\'s address: only a local-mode pane that runs on THIS machine, and only the real bound port]');
{
  const { buildLaunch } = await import('../src/engine/launch.ts');
  const rec = { id: 'r', name: 'R', target: 't', projectDir: '/x', vendor: 'cli-manager', agent: 'thing', runClaude: 0, model: null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null, created_at: 0, updated_at: 0, last_launched_at: null } as never;
  const here = { id: 't', label: 'T', kind: 'local', broker: 'local', shell: '/bin/bash' } as never;
  const remote = { id: 'v', label: 'V', kind: 'local', broker: 'vrpc', shell: 'powershell.exe' } as never;
  const envOf = (t: never): Record<string, string> => (buildLaunch(rec, t, null, null, { paneid: 'recipe:r' }).descriptor.env ?? {}) as Record<string, string>;
  setBoundPort(51777);
  process.env.HARBOR_WB_MODE = 'local';
  ok(envOf(here).HARBOR_WB_ENGINE_URL === 'http://127.0.0.1:51777', 'local mode, local pane: HARBOR_WB_ENGINE_URL is the engine\'s real bound port (never 0, never 7420)');
  ok(envOf(here).HARBOR_WB_PANEID === 'recipe:r' && envOf(here).HARBOR_WB_SLUG === 'thing', 'and the identity variables are unchanged');
  ok(envOf(remote).HARBOR_WB_ENGINE_URL === undefined, 'a pane that runs in ANOTHER machine\'s broker gets none (127.0.0.1 would be the wrong host)');
  delete process.env.HARBOR_WB_MODE;
  ok(envOf(here).HARBOR_WB_ENGINE_URL === undefined, 'server mode: none (the server\'s panes are unchanged)');
  setBoundPort(null);
  process.env.HARBOR_WB_MODE = 'local';
  ok(envOf(here).HARBOR_WB_ENGINE_URL === undefined, 'before the engine has bound a port: none, not a URL with port 0');
  delete process.env.HARBOR_WB_MODE;
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
