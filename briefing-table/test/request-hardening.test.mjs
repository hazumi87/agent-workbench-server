/**
 * A REQUEST THAT THROWS MUST NOT END THE ENGINE (triage 2.4): `GET /?ticket=%E0` carries a malformed percent-escape; decodeURIComponent threw a URIError inside the async request
 * handler, an unhandled rejection, and Node ended the whole process (every window and the table with it). The handler is now under one catch: a URIError is a 400, anything else a 500,
 * and the engine logs it and carries on. A logging unhandledRejection handler is the second line.
 * SAFETY: scratch port, scratch db in a temp dir, no broker, no window host.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(564);
const DEAD_BROKER_PORT = P(565);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'request-hardening-test-token';
let passed = 0;
let failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}${d !== undefined ? ` (${d})` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await assertFree(PORT, 'request-hardening.test.mjs');
await assertFree(DEAD_BROKER_PORT, 'request-hardening.test.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'wb-reqhard-'));
let log = '';
let exited = false;
const engine = spawn(process.execPath, ['--import', join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'src/server/index.ts'], {
  cwd: REPO_ROOT,
  env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_BROKERS: '{}', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'claude-projects'),
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
engine.stdout.on('data', (d) => (log += d));
engine.stderr.on('data', (d) => (log += d));
engine.on('exit', () => { exited = true; });
try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
    if (!up) await sleep(250);
  }
  if (!up) throw new Error(`engine did not come up\n${log}`);
  const alive = async () => (await fetch(`${BASE}/health`).then((r) => r.status, () => 0)) === 200 && !exited;
  const bearer = { authorization: `Bearer ${TOKEN}` };

  console.log('\n[a malformed percent-escape in a ticket]');
  const t = await fetch(`${BASE}/?ticket=%E0`, { redirect: 'manual' }).catch(() => null);
  ok(t?.status === 400, 'GET /?ticket=%E0 answers 400', t?.status);
  ok(await alive(), '...and the engine is still up');
  const t2 = await fetch(`${BASE}/solo.html?recipe=x&ticket=%`, { redirect: 'manual' }).catch(() => null);
  ok(t2?.status === 400, 'GET ...&ticket=% answers 400', t2?.status);
  ok(await alive(), '...and the engine is still up');

  console.log('\n[a malformed escape in an authenticated route path]');
  for (const path of ['/api/sessions/%E0/peek', '/api/recipes/%E0', '/api/workers/%E0']) {
    const r = await fetch(`${BASE}${path}`, { headers: bearer }).catch(() => null);
    ok(r !== null && r.status >= 400 && r.status < 500, `${path} answers a 4xx`, r?.status);
    ok(await alive(), '...and the engine is still up');
  }

  console.log('\n[a normal request still works afterwards]');
  const h = await fetch(`${BASE}/health`);
  ok(h.status === 200, '/health 200');
  const tb = await fetch(`${BASE}/api/table`, { headers: bearer });
  ok(tb.status === 200, '/api/table 200 with the bearer');
  ok(/threw \(400\)/.test(log), 'the engine logged the malformed request instead of dying');
} catch (e) {
  failed++;
  console.log(`  X  threw: ${e?.stack ?? e}`);
} finally {
  engine.kill('SIGKILL');
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
