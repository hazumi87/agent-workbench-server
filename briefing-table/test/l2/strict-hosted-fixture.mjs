// Independent ticket storage run: assigned offset2000; same strict hosted fixture.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
export class ProofInfrastructureError extends Error {
  constructor(message) { super(message); this.name = 'ProofInfrastructureError'; this.code = 'PROOF_INFRASTRUCTURE'; }
}

async function ready(proc, base, timeoutMs) {
  // Hosted/server mode has no desktop supervisor ready-line. Health is only a
  // transport precondition; the fresh random bootstrap password below proves
  // this is our own identity database before any browser assertion runs.
  proc.stdout.resume();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new ProofInfrastructureError('scratch-engine-exited-before-ready');
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch { /* owned child still starting */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new ProofInfrastructureError('scratch-engine-readiness-timeout');
}

export async function startProofEngine({ engineRoot, appDir, timeoutMs = 30000, setupComplete = false, secondaryPerson = false }) {
  if (process.env.WB_TEST_PORT_OFFSET !== '2000') throw new ProofInfrastructureError('proof-offset-must-be-2000');
  const { P, assertFree } = await import(pathToFileURL(join(engineRoot, 'test/_scratch.mjs')).href);
  await assertFree(P(590), 'web-proof engine'); await assertFree(P(591), 'web-proof disabled broker');
  const directory = await mkdtemp(join(tmpdir(), 'wb-proof-engine-'));
  await mkdir(join(directory, 'home'));
  const token = randomBytes(32).toString('hex');
  // Tiny allowlist: no inherited vendor credentials, SSH sockets, fabric settings,
  // real HOME, CLI histories, agent state, or a real broker connection.
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: join(directory, 'home'),
    XDG_CONFIG_HOME: join(directory, 'home/config'), XDG_CACHE_HOME: join(directory, 'home/cache'),
    HARBOR_WB_MODE: 'server', HARBOR_WB_TOKEN: token, HARBOR_WB_PORT: String(P(590)), HARBOR_WB_HOST: '127.0.0.1',
    HARBOR_WB_HOSTED: '1', HARBOR_WB_IDENTITY: 'strict', HARBOR_WB_IDENTITY_DB: join(directory, 'identity.db'),
    HARBOR_WB_DATA_DIR: join(directory, 'data'), HARBOR_WB_FILES_DIR: join(directory, 'files'), HARBOR_WB_FS_ROOT: join(directory, 'home'),
    HARBOR_WB_APP_DIR: appDir, HARBOR_WB_EXIT_ON_STDIN_CLOSE: '1', HARBOR_WB_MEMORY_CEILING_MB: '0', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(P(591)), HARBOR_WB_BROKERS: '{}',
    HARBOR_WB_FABRIC_URL: '', HARBOR_WB_NATS_URL: '', HARBOR_WB_SEAT_WELCOME: '0',
    HARBOR_WB_CLAUDE_PROJECTS: join(directory, 'no-projects'), HARBOR_WB_PROC_ROOT: join(directory, 'no-proc'), HARBOR_WB_NODE: 'proof-scratch' };
  const loader = join(engineRoot, 'node_modules/tsx/dist/loader.mjs');
  let initialPassword, password;
  try {
    const boot = await promisify(execFile)(process.execPath, ['--import', loader, 'scripts/identity.ts', 'bootstrap', '--username', 'proof'], { cwd: engineRoot, env, timeout: 15000, maxBuffer: 65536 });
    initialPassword = /password\s+([a-z2-9]{4}-[a-z2-9]{4})/.exec(boot.stdout)?.[1];
    const source = await readFile(join(engineRoot, 'test/identity-engine.test.mjs'), 'utf8');
    password = /const GOOD_PASSWORD = '([^']+)';/.exec(source)?.[1];
    if (!initialPassword || !password) throw new Error('fixture bootstrap failed');
    if (secondaryPerson) {
      const setup = `import * as store from ${JSON.stringify(pathToFileURL(join(engineRoot, 'src/identity/store.ts')).href)};
        import { hashPassword } from ${JSON.stringify(pathToFileURL(join(engineRoot, 'src/identity/auth.ts')).href)};
        store.createAccount({ username: 'other-proof', passwordHash: await hashPassword(process.env.WB_FIXTURE_PASSWORD), mustChange: false, isAdmin: false });`;
      await promisify(execFile)(process.execPath, ['--import', loader, '--input-type=module', '-e', setup], {
        cwd: engineRoot, env: { ...env, WB_FIXTURE_PASSWORD: password }, timeout: 15000, maxBuffer: 65536 });
    }
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new ProofInfrastructureError('strict-person-bootstrap-failed');
  }
  const proc = spawn(process.execPath, ['--max-old-space-size=4096', '--import', loader, 'src/server/index.ts'], { cwd: engineRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.resume(); proc.on('error', () => {}); proc.stdin.on('error', () => {});
  let closing;
  const stop = () => closing ??= Promise.resolve().then(async () => {
    if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, 'exit');
      const term = setTimeout(() => proc.kill('SIGTERM'), 1000);
      const kill = setTimeout(() => proc.kill('SIGKILL'), 4000);
      try { proc.stdin.end(); await exited; } finally { clearTimeout(term); clearTimeout(kill); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  try {
    const base = `http://127.0.0.1:${P(590)}`;
    await ready(proc, base, timeoutMs);
    // Fixture provisioning prepares the synthetic person's password. Browser
    // acceptance below still signs in through the real page in a fresh context.
    let cookie = '';
    const accountPost = async (path, body) => {
      const response = await fetch(base + path, { method: 'POST', redirect: 'manual',
        headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      for (const raw of response.headers.getSetCookie()) if (raw.startsWith('homelab_session=')) cookie = raw.split(';')[0];
      return response;
    };
    if ((await accountPost('/login', { username: 'proof', password: initialPassword })).status !== 200 ||
        (await accountPost('/account/password', { current: initialPassword, next: password })).status !== 200) {
      throw new ProofInfrastructureError('strict-person-password-preparation-failed');
    }
    if (setupComplete) {
      const completed = await fetch(base + '/api/settings/setup', { method: 'PUT',
        headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ complete: true }) });
      if (completed.status !== 200) throw new ProofInfrastructureError('existing-person-setup-preparation-failed');
    }
    return { base, username: 'proof', password, ...(secondaryPerson ? { secondaryUsername: 'other-proof' } : {}), stop, mode: 'strict-hosted-scratch-no-broker', directory };
  } catch (error) { await stop(); throw error; }
}

