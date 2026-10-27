/* USER DEVICE PRESENCE routes through a real scratch engine [room [ref]]: person credential writes, bearer refused to
 * write but allowed to read, bad bodies 400, unknown keys dropped, rate limit. Scratch ports only; env from childEnv(). */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(540);
const DEAD_BROKER_PORT = P(541);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'user-presence-routes-token';
let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok  ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const desc = (o = {}) => ({
  device: 'dev-test-phone1', instance: 'inst-test-0001', class: 'phone', surface: 'browser', page: 'room', browser: 'Safari', os: 'iOS',
  viewport: { w: 390, h: 844 }, standalone: false, visible: true, label: 'iPhone browser', ...o,
});
async function call(path, { method, json, cookie, bearer } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${TOKEN}`;
  const init = { method: method ?? (json !== undefined ? 'POST' : 'GET'), headers };
  if (json !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(json); }
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* none */ }
  return { status: res.status, body };
}

await assertFree(PORT, 'user-presence-routes.test.mjs');
await assertFree(DEAD_BROKER_PORT, 'user-presence-routes.test.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-userpresence-'));
let engine = null;
let log = '';
try {
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
      HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
    }),
  });
  engine.stdout.on('data', (d) => (log += d));
  engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { await sleep(250); up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false); }
  if (!up) throw new Error(`engine did not come up\n${log}`);

  const lg = await fetch(`${BASE}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}` });
  const cookie = (lg.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  ok(/wb_auth=/.test(cookie), 'a person (cookie) can sign in');

  console.log('\n[auth]');
  ok((await call('/api/presence/user')).status === 401, 'unauthenticated read: 401');
  ok((await call('/api/presence/device', { json: desc() })).status === 401, 'unauthenticated write: 401');
  const refused = await call('/api/presence/device', { json: desc(), bearer: true });
  ok(refused.status === 403 && refused.body?.error === 'person_only', 'a BEARER cannot write a device report (403 person_only)');
  const empty = await call('/api/presence/user', { bearer: true });
  ok(empty.status === 200 && empty.body.active.length === 0 && empty.body.primary === null, 'a bearer reads; nothing reported yet');

  console.log('\n[write by the person]');
  ok((await call('/api/presence/device', { json: desc(), cookie })).status === 200, 'person credential: 200');
  const r = await call('/api/presence/user', { bearer: true });
  ok(r.body.active.length === 1 && r.body.primary?.class === 'phone', 'the bearer read shows the phone as active + primary');
  ok(/phone \(iPhone, Safari\) in a room, active now/.test(r.body.summary), `summary: ${r.body.summary}`);
  ok((await call('/api/presence/user', { cookie })).body.active.length === 1, 'the person reads the same via cookie');
  const d = r.body.active[0];
  ok(['device', 'class', 'surface', 'page', 'browser', 'os', 'viewport', 'standalone', 'visible', 'label', 'since', 'lastSeen'].every((k) => k in d), 'row carries the documented fields');

  console.log('\n[bad bodies, unknown keys]');
  for (const [name, o] of [['class laptop', { class: 'laptop' }], ['no device', { device: undefined }], ['visible string', { visible: 'x' }], ['bad viewport', { viewport: { w: 'a', h: 1 } }]]) {
    ok((await call('/api/presence/device', { json: desc(o), cookie })).status === 400, `400: ${name}`);
  }
  ok((await call('/api/presence/device', { json: [1, 2], cookie })).status === 400, '400: array body');
  await call('/api/presence/device', { json: desc({ device: 'dev-test-other01', instance: 'inst-test-0002', class: 'desktop', userAgent: 'Mozilla/5.0 SECRET', ip: '9.9.9.9' }), cookie });
  const all = JSON.stringify((await call('/api/presence/user', { bearer: true })).body);
  ok(!/SECRET|9\.9\.9\.9|userAgent/.test(all), 'unknown keys (UA, ip) never reach the read');
  ok(all.includes('dev-test-other01'), 'a second device is listed');

  console.log('\n[hidden is not active]');
  await call('/api/presence/device', { json: desc({ device: 'dev-test-other01', instance: 'inst-test-0002', class: 'desktop', visible: false }), cookie });
  const h = (await call('/api/presence/user', { bearer: true })).body;
  ok(h.active.length === 1 && h.recent.some((x) => x.device === 'dev-test-other01'), 'the hidden desktop moved to recent');

  console.log('\n[rate limit]');
  let got429 = false;
  for (let i = 0; i < 30 && !got429; i++) got429 = (await call('/api/presence/device', { json: desc({ device: 'dev-test-flood01', instance: 'inst-test-0003' }), cookie })).status === 429;
  ok(got429, 'a flooding device gets 429');
  ok((await call('/api/presence/device', { json: desc(), cookie })).status === 200, 'another device is not limited');
  ok((await call('/api/presence/user', { method: 'DELETE', bearer: true })).status === 405, 'no other methods (405)');
} catch (e) {
  failed++;
  console.log(`  FAIL ${e.message}`);
} finally {
  if (engine) engine.kill('SIGKILL');
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
