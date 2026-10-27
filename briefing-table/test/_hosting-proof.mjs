/** Shared scratch infrastructure for customer finding proofs. Never a production endpoint. */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { request as nativeRequest } from 'node:http';
import { P, assertFree, childEnv } from './_scratch.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Set before any product import: auth/targets/table must never consult the pane's
// real token, vendor state or instance. Each suite is a separate runner process.
export const unitDir = mkdtempSync(join(tmpdir(), 'wb-hosting-unit-proof-'));
Object.assign(process.env, {
  HARBOR_WB_TOKEN: 'scratch-proof-token-never-production', HARBOR_WB_DATA_DIR: unitDir,
  HARBOR_WB_TABLE: join(unitDir, 'table.db'), HARBOR_WB_IDENTITY_DB: join(unitDir, 'identity.db'),
  HARBOR_WB_FABRIC_URL: '', HARBOR_WB_NATS_URL: '', CLAUDE_CONFIG_DIR: join(unitDir, 'claude-config'),
  CODEX_HOME: join(unitDir, 'codex-home'), HARBOR_WB_CLAUDE_PROJECTS: join(unitDir, 'claude-projects'),
  HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'Proof', kind: 'local', shell: '/bin/sh' }] }),
});
export const recipe = over => ({ id: 'proof', name: 'Proof only', target: 'local', projectDir: '/scratch',
  vendor: 'gemini-cli', agent: null, model: null, effort: null, resume: 0, resumeName: null, initCmd: null,
  closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null, ...over });

export async function proof(id, run) {
  let passed = 0, failed = 0;
  const check = (condition, name) => {
    if (condition) { passed++; console.log(`PASS ${id}: ${name}`); }
    else { failed++; console.error(`FAIL ${id}: ${name}`); }
  };
  try { await run(check); }
  catch (error) { failed++; console.error(`FAIL ${id}: ${error.stack ?? error}`); }
  rmSync(unitDir, { recursive: true, force: true });
  console.log(`PASS ${passed} FAIL ${failed}`);
  if (failed) process.exitCode = 1;
}

export async function scratchEngine(slot = 2000, options = {}) {
  const port = P(slot), deadBroker = P(slot + 1);
  for (const p of [port, deadBroker]) {
    if (p >= 8000 && p <= 8999) throw new Error('Proof ports must avoid the live 8xxx band; use --offset 1200');
    await assertFree(p, 'hosting finding proof');
  }
  const dir = mkdtempSync(join(tmpdir(), 'wb-hosting-proof-'));
  for (const sub of ['data', 'files', 'config', 'claude-projects', 'codex-home', 'app']) mkdirSync(join(dir, sub));
  const appDir = join(dir, 'app');
  const { writeFileSync } = await import('node:fs');
  for (const name of ['index.html', 'settings.html', 'account.html']) writeFileSync(join(appDir, name), '<!doctype html><title>Header proof fixture</title><p>Inert app HTML fixture</p>');
  const vendorBin = join(dir, 'vendor-bin');
  if (options.codexSentinel) {
    mkdirSync(vendorBin);
    writeFileSync(join(vendorBin, 'codex'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  }
  const token = 'scratch-proof-token-never-production';
  const base = `http://127.0.0.1:${port}`;
  const env = childEnv({ HARBOR_WB_PORT: port, HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_HOSTED: '1',
    HARBOR_WB_MODE: '', HARBOR_WB_DATA_DIR: join(dir, 'data'), HARBOR_WB_FILES_DIR: join(dir, 'files'),
    HARBOR_WB_TABLE: join(dir, 'data', 'table.db'), HARBOR_WB_IDENTITY: 'strict', HARBOR_WB_TOKEN: token,
    HARBOR_WB_WEBAUTHN_ORIGIN: base,
    HARBOR_WB_APP_DIR: appDir,
    HARBOR_WB_TERM_GRANTS: '1',
    HARBOR_WB_IDENTITY_DB: join(dir, 'data', 'identity.db'), HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: deadBroker,
    HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'Proof', kind: 'local', shell: '/bin/sh' }] }),
    HARBOR_WB_CLAUDE_PROJECTS: join(dir, 'claude-projects'), CLAUDE_CONFIG_DIR: join(dir, 'config'), CODEX_HOME: join(dir, 'codex-home'),
    HARBOR_WB_MEMORY_CEILING_MB: '0', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_NATS_URL: '',
    WB_TEST_LOCAL_MODE: null,
    ...(options.codexSentinel ? { PATH: vendorBin + ':' + process.env.PATH } : {}),
  });
  // Provision only this private identity DB; exercise the real session login
  // below. Never turn on HOSTED_ALLOW_NONSTRICT to make a proof pass.
  const seed = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import {createAccount} from './src/identity/store.ts'; import {hashPassword} from './src/identity/auth.ts'; createAccount({username:'proof',passwordHash:await hashPassword('Proof-only-scratch!47'),mustChange:false,passwordExpiresAt:null,isAdmin:true});"],
    { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  if (seed.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error('Scratch identity provisioning failed'); }
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/server/index.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-16000); });
  let stopped = false;
  async function close() {
    if (stopped) return; stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(`Scratch engine exited: ${log}`);
      try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(500) }); await r.text(); ready = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Scratch engine did not start: ${log}`);
    // Real browser login. No derived-cookie fabrication and no live credentials.
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'proof', password: 'Proof-only-scratch!47' }) });
    const cookie = (login.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ');
    await login.text();
    if (!cookie) throw new Error('Scratch browser login did not issue a cookie');
    console.log('PROFILE HARBOR_WB_HOSTED=1 IDENTITY=strict LOOPBACK=true BROKER=disabled');
    async function request(path, { method = 'GET', value, raw, headers = {}, signedIn = true } = {}) {
      const requestHeaders = { ...(signedIn ? { cookie } : {}),
        ...(!['GET', 'HEAD'].includes(method) ? { origin: base } : {}),
        ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
      for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] == null) delete requestHeaders[key];
      if (requestHeaders.host) {
        // Fetch implementations can discard a caller's Host header. DNS
        // rebinding proof needs the exact bytes, without changing DNS or hosts.
        return await new Promise((resolve, reject) => {
          const payload = raw ?? (value === undefined ? undefined : JSON.stringify(value));
          const req = nativeRequest(base + path, { method, headers: { ...requestHeaders,
            ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }) } }, response => {
            let text = ''; response.setEncoding('utf8'); response.on('data', data => { text += data; });
            response.on('end', () => { let body; try { body = JSON.parse(text); } catch {}
              resolve({ status: response.statusCode, text, body }); });
            response.on('error', reject);
          });
          req.setTimeout(5000, () => req.destroy(new Error('Scratch Host-header proof timed out')));
          req.on('error', reject); req.end(payload);
        });
      }
      const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(5000),
        headers: requestHeaders,
        ...(value === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(value) }) });
      const text = await response.text(); let body; try { body = JSON.parse(text); } catch {}
      return { status: response.status, headers: response.headers, text, body };
    }
    return { base, cookie, dir, appDir, request, close };
  } catch (error) { await close(); throw error; }
}

export function upgradeStatus(base, cookie, origin, path = '/pty', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + path, { headers: { cookie, origin, ...extraHeaders }, handshakeTimeout: 3000 });
    let answered = false;
    ws.on('open', () => { answered = true; resolve(101); ws.close(); });
    ws.on('unexpected-response', (_request, response) => { answered = true; response.resume(); resolve(response.statusCode); });
    ws.on('error', error => { if (!answered) reject(error); });
  });
}
