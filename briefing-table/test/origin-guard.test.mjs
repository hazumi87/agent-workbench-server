/**
 * H5 ORIGIN / HOST GUARD: pure rules, then a HOSTED real engine (HARBOR_WB_HOSTED=1): a cross-origin mutation, a cross-origin WebSocket upgrade, a rebinding-style Host (421), a missing
 * Origin on a cookie mutation, text/plain and multipart on a JSON route, bearer calls without an Origin, and a GET that changes nothing.
 * SAFETY: scratch port + db in a temp dir, no broker, no window host.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { checkOrigin, allowedHosts, isUploadRoute, UPLOAD_ROUTES } = await import(pathToFileURL(join(REPO_ROOT, 'src/server/origin-guard.ts')).href).catch(async () => {
  // a plain node cannot import .ts: the pure half runs through tsx in the engine test below
  return {};
});
let passed = 0;
let failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}${d !== undefined ? ` (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (checkOrigin) {
  console.log('\n[pure rules]');
  const rq = (method, headers, url = '/api/x') => ({ method, headers, url });
  ok(checkOrigin(rq('GET', { origin: 'https://evil.example', host: 'a.test' })).ok, 'a GET is never refused here');
  const base = { host: 'app.test:8443' };
  ok(checkOrigin(rq('POST', { ...base, origin: 'https://app.test:8443' })).ok, 'same origin: allowed');
  ok(checkOrigin(rq('POST', { ...base, origin: 'https://evil.example' })).error === 'origin-not-allowed', 'another origin: 403 origin-not-allowed');
  ok(checkOrigin(rq('POST', { ...base, origin: 'null' })).error === 'origin-not-allowed', 'Origin: null is refused');
  ok(checkOrigin(rq('POST', { ...base, 'sec-fetch-site': 'cross-site' })).error === 'origin-not-allowed', 'no Origin but Sec-Fetch-Site cross-site: refused');
  ok(checkOrigin(rq('POST', { ...base, origin: 'https://app.test:8443', 'sec-fetch-site': 'cross-site' })).error === 'origin-not-allowed', 'a matching Origin with Sec-Fetch-Site cross-site: refused');
  const envS = { HARBOR_WB_ALLOWED_ORIGINS: 'http://127.0.0.1:10630' };
  ok(checkOrigin(rq('POST', { host: '127.0.0.1:10630', origin: 'http://127.0.0.1:10630' }), { env: envS }).ok, 'configured http origin: allowed');
  ok(checkOrigin(rq('POST', { host: '127.0.0.1:10630', origin: 'https://127.0.0.1:10630' }), { env: envS }).error === 'origin-not-allowed', 'same host, other scheme than configured: refused');
  ok(checkOrigin(rq('POST', { ...base, origin: 'http://app.test:8443', 'x-forwarded-proto': 'https' })).error === 'origin-not-allowed', 'Origin scheme differs from x-forwarded-proto: refused');
  ok(checkOrigin(rq('POST', { ...base, cookie: 'a=b' })).ok, 'NOT hosted: a cookie call without an Origin is allowed');
  /* the desktop app's own origin (app://workbench) as a client of a NON-hosted server engine: this broke realm-engine and term-grants-engine in the first pilot suite */
  const APP = 'app://workbench';
  ok(checkOrigin(rq('POST', { host: 'srv:8201', origin: APP, cookie: 'a=b', 'content-type': 'application/json' }, '/api/rooms')).error === 'origin-not-allowed', 'a foreign origin with a cookie and nothing naming it: refused');
  ok(checkOrigin(rq('POST', { host: 'srv:8201', origin: APP, cookie: 'a=b' }, '/api/rooms'), { extraOrigins: [APP] }).ok, 'the same origin named by the engine (the term-grants list) is allowed as a client');
  ok(checkOrigin(rq('POST', { host: 'srv:8201', origin: APP, authorization: 'Bearer t' }, '/api/rooms')).ok, 'NOT hosted: a bearer call is not a CSRF vector, whatever Origin it carries');
  ok(checkOrigin(rq('POST', { host: 'app.test', origin: 'https://evil.example', authorization: 'Bearer t' }, '/api/rooms'), { hosted: true, env: { HARBOR_WB_ALLOWED_HOSTS: 'app.test' } }).error === 'origin-not-allowed', 'HOSTED: a bearer call with a foreign Origin is still refused');
  for (const path of ['/auth/realm/exchange', '/api/terminal-grants', '/term']) {
    ok(checkOrigin(rq('POST', { host: 'srv:8201', origin: APP }, path)).ok, `${path} enforces its own Origin list: the generic rule lets it through`);
  }
  ok(checkOrigin(rq('POST', { host: 'srv:8201', origin: APP }, '/api/other')).error === 'origin-not-allowed', 'and no other route gets that pass');
  for (const path of ['/auth/realm/exchange', '/api/terminal-grants', '/term']) {
    ok(checkOrigin(rq('POST', { host: 'app.test', origin: APP, cookie: 'a=b' }, path), { hosted: true, env: { HARBOR_WB_ALLOWED_HOSTS: 'app.test' } }).error === 'origin-not-allowed', `HOSTED: ${path} with Origin app://workbench is refused by the generic guard (no app origin on a hosted engine)`);
  }
  ok(checkOrigin(rq('POST', { host: 'app.test', origin: APP, cookie: 'a=b' }, '/term'), { hosted: true, upgrade: true, env: { HARBOR_WB_ALLOWED_HOSTS: 'app.test' } }).error === 'origin-not-allowed', 'HOSTED: a /term upgrade from app://workbench is refused too');
  const env = { HARBOR_WB_ALLOWED_ORIGINS: 'https://app.example.com', HARBOR_WB_ALLOWED_HOSTS: 'app.example.com' };
  ok(checkOrigin(rq('POST', { host: 'proxy.internal', origin: 'https://app.example.com' }), { env }).ok, 'a listed origin is allowed even when the proxy rewrote Host');
  const h = (headers, extra = {}) => checkOrigin(rq('POST', headers), { hosted: true, env, boundPort: 7500, ...extra });
  ok(h({ host: 'evil.example', origin: 'https://evil.example', cookie: 'x=1', 'content-type': 'application/json' }).status === 421, 'HOSTED: a rebound Host (matching Origin) is refused 421 before anything');
  ok(h({ host: 'app.example.com', origin: 'https://app.example.com', cookie: 'x=1', 'content-type': 'application/json', 'content-length': '2' }).ok, 'HOSTED: the public host + its own origin + JSON: allowed');
  ok(h({ host: 'app.example.com', cookie: 'x=1', 'content-type': 'application/json' }).error === 'origin-required', 'HOSTED: a cookie mutation with no Origin: 403 origin-required');
  ok(h({ host: 'app.example.com', authorization: 'Bearer t', 'content-type': 'text/plain', 'content-length': '2' }).ok, 'HOSTED: a bearer call needs no Origin and no JSON type');
  ok(h({ host: 'app.example.com', origin: 'https://app.example.com', cookie: 'x=1', 'content-type': 'text/plain', 'content-length': '2' }).status === 415, 'HOSTED: text/plain on a JSON route: 415 json-required');
  ok(h({ host: 'app.example.com', origin: 'https://app.example.com', cookie: 'x=1', 'content-type': 'multipart/form-data; boundary=x', 'content-length': '9' }).status === 415, 'HOSTED: multipart on a route that is not an upload route: 415');
  ok(checkOrigin(rq('POST', { host: 'app.example.com', origin: 'https://app.example.com', cookie: 'x=1', 'content-type': 'multipart/form-data; boundary=x', 'content-length': '9' }, '/api/rooms/r1/assets'), { hosted: true, env, boundPort: 7500 }).ok, 'HOSTED: an upload route accepts multipart (with the Origin check kept)');
  ok(checkOrigin(rq('POST', { host: 'app.example.com', origin: 'https://evil.example', cookie: 'x=1', 'content-length': '9' }, '/api/rooms/r1/assets'), { hosted: true, env, boundPort: 7500 }).error === 'origin-not-allowed', '...and a cross-origin upload is still refused');
  ok(checkOrigin(rq('GET', { host: 'app.example.com', origin: 'https://evil.example', cookie: 'x=1', upgrade: 'websocket' }, '/pty'), { upgrade: true, hosted: true, env, boundPort: 7500 }).error === 'origin-not-allowed', 'a cross-origin WebSocket upgrade is refused');
  ok(allowedHosts({ HARBOR_WB_WEBAUTHN_ORIGIN: 'https://wb.example:8443' }, 7500).includes('wb.example:8443'), 'the WebAuthn origin contributes its host');
  ok(UPLOAD_ROUTES.length >= 3 && isUploadRoute('/api/rooms/r/files/notes/a.md') && !isUploadRoute('/api/recipes'), 'UPLOAD_ROUTES is the one list');
}

await assertFree(P(568), 'origin-guard.test.mjs');
await assertFree(P(569), 'origin-guard.test.mjs');
const PORT = P(568);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'origin-guard-test-token';
const tmp = mkdtempSync(join(tmpdir(), 'wb-origin-'));
let log = '';
const engine = spawn(process.execPath, ['--import', join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'src/server/index.ts'], {
  cwd: REPO_ROOT,
  env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_HOSTED: '1', HARBOR_WB_HOSTED_ALLOW_NONSTRICT: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(P(569)), HARBOR_WB_BROKERS: '{}', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'claude-projects'), HARBOR_WB_FILES_DIR: join(tmp, 'files'),
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
engine.stdout.on('data', (d) => (log += d));
engine.stderr.on('data', (d) => (log += d));
const raw = (opts, body) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, ...opts }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  r.on('error', () => resolve({ status: 0, body: '' }));
  if (body) r.write(body);
  r.end();
});
{
  /* HOSTED refuses to start when the room files root is unset or inside the engine data dir */
  const boot = (extra) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'src/server/index.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({ HARBOR_WB_PORT: String(P(582)), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmp, 'x.db'), HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_HOSTED: '1', HARBOR_WB_HOSTED_ALLOW_NONSTRICT: '1', HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(P(583)), HARBOR_WB_BROKERS: '{}', HARBOR_WB_NO_WINDOW: '1', ...extra }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: 'timeout', err }); }, 90000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, err }); });
  });
  await assertFree(P(582), 'origin-guard.test.mjs');
  await assertFree(P(583), 'origin-guard.test.mjs');
  const noDir = await boot({});
  ok(noDir.code === 78 && /HARBOR_WB_FILES_DIR/.test(noDir.err), 'hosted without HARBOR_WB_FILES_DIR: exits 78 with a loud error', noDir);
  const dd = join(tmp, 'data');
  const inDir = await boot({ HARBOR_WB_DATA_DIR: dd, HARBOR_WB_FILES_DIR: join(dd, 'files') });
  ok(inDir.code === 78 && /inside, or contains/.test(inDir.err), 'a files root inside the data dir: exits 78', inDir);
  const above = await boot({ HARBOR_WB_DATA_DIR: join(tmp, 'files', 'data'), HARBOR_WB_FILES_DIR: join(tmp, 'files') });
  ok(above.code === 78, 'a files root that contains the data dir: exits 78', above);
}
try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
    if (!up) await sleep(250);
  }
  if (!up) throw new Error(`engine did not come up\n${log}`);
  const cookie = await windowCookie(BASE, TOKEN);
  const origin = BASE;
  const json = { 'content-type': 'application/json' };
  console.log('\n[hosted engine, over HTTP]');
  const same = await raw({ method: 'POST', path: '/api/recipes', headers: { cookie, origin, ...json } }, '{}');
  ok(same.status === 400, 'same-origin cookie POST reaches the route (400 for the empty body, not a guard refusal)', same.status);
  const cross = await raw({ method: 'POST', path: '/api/recipes', headers: { cookie, origin: 'https://evil.example', ...json } }, '{}');
  ok(cross.status === 403 && /origin-not-allowed/.test(cross.body), 'a cross-origin mutation: 403 origin-not-allowed', cross.status);
  const noOrigin = await raw({ method: 'POST', path: '/api/recipes', headers: { cookie, ...json } }, '{}');
  ok(noOrigin.status === 403 && /origin-required/.test(noOrigin.body), 'HOSTED: a cookie mutation with no Origin: 403 origin-required', noOrigin.status);
  const plain = await raw({ method: 'POST', path: '/api/recipes', headers: { cookie, origin, 'content-type': 'text/plain' } }, '{"name":"x","target":"local"}');
  ok(plain.status === 415, 'text/plain on a JSON route: 415 (not parsed as JSON)', plain.status);
  const multi = await raw({ method: 'POST', path: '/api/recipes', headers: { cookie, origin, 'content-type': 'multipart/form-data; boundary=zz' } }, '--zz--');
  ok(multi.status === 415, 'multipart on a route that is not in UPLOAD_ROUTES: 415', multi.status);
  const bearer = await raw({ method: 'POST', path: '/api/recipes', headers: { authorization: `Bearer ${TOKEN}`, ...json } }, '{}');
  ok(bearer.status === 400, 'a bearer call with no Origin is not a browser: reaches the route (400)', bearer.status);
  const rebind = await raw({ method: 'GET', path: '/api/usage', headers: { host: 'evil.example', origin: 'http://evil.example', cookie } });
  ok(rebind.status === 421, 'a rebinding-style Host (Origin and Host match, not ours): 421 on a GET too', rebind.status);
  const rebindPost = await raw({ method: 'POST', path: '/api/recipes', headers: { host: 'evil.example', origin: 'http://evil.example', cookie, ...json } }, '{}');
  ok(rebindPost.status === 421, '...and on a POST', rebindPost.status);
  console.log('\n[the WebSocket upgrade]');
  const wsOpens = (headers, path = '/pty') => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers });
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
    ws.on('unexpected-response', () => resolve(false));
  });
  ok((await wsOpens({ cookie, origin: 'https://evil.example' })) === false, 'a cross-origin upgrade is refused');
  ok((await wsOpens({ cookie })) === false, 'HOSTED: a cookie upgrade with no Origin is refused');
  ok((await wsOpens({ cookie, origin })) === true, 'a same-origin upgrade opens');
  ok((await wsOpens({ cookie, origin: 'https://evil.example' }, '/term')) === false, '/term: a cross-origin upgrade is refused too (it branches before wsAuth)');
  ok((await wsOpens({ cookie, host: 'evil.example', origin: 'http://evil.example' }, '/term')) === false, '/term: a rebound Host is refused');
  console.log('\n[hosted: voice, headless workers and the fabric are off]');
  for (const [m, path] of [['GET', '/api/workers'], ['POST', '/api/fabric/inbound'], ['GET', '/api/voice/status']]) {
    const r = await fetch(`${BASE}${path}`, { method: m, headers: { cookie, origin, 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
    ok(r.status === 404, `${m} ${path}: 404 on a hosted engine`, r.status);
  }
  const root = await fetch(`${BASE}/`, { headers: { cookie }, redirect: 'manual' });
  ok(root.status === 302 && root.headers.get('location') === '/app/', 'hosted: / and /manager.html send a signed-in person to /app/', root.status);
  ok((await fetch(`${BASE}/account.html`, { redirect: 'manual' })).status !== 200 && (await fetch(`${BASE}/manager.html`, { redirect: 'manual' })).status !== 200, 'old pages need sign-in (not served unauthenticated)');
  console.log('\n[hosted pilot scope: only Claude can be a room seat]');
  {
    const jh = { cookie, origin, 'content-type': 'application/json' };
    const mkRecipe = async (name, vendor) => (await (await fetch(`${BASE}/api/recipes`, { method: 'POST', headers: jh, body: JSON.stringify({ name, target: 'local', vendor, ...(vendor === 'cli-manager' ? { initCmd: 'sh' } : {}) }) })).json());
    const room = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: jh, body: JSON.stringify({ name: 'Scope' }) })).json());
    const rid = room.room?.id ?? room.id;
    const gem = await mkRecipe('gem', 'gemini-cli');
    const cod = await mkRecipe('cod', 'codex-cli');
    const cla = await mkRecipe('cla', 'claude-code');
    const seat = (recipe) => fetch(`${BASE}/api/rooms/${rid}/seats`, { method: 'POST', headers: jh, body: JSON.stringify({ recipe_id: (recipe.recipe ?? recipe).id }) });
    const nf = await fetch(`${BASE}/api/recipes/${(cla.recipe ?? cla).id}/launch`, { method: 'POST', headers: jh, body: '{}' });
    const nfj = await nf.json().catch(() => ({}));
    ok(nf.status === 400 && nfj.error === 'This agent has no folder yet. Add it again with a folder.' && nfj.field === 'projectDir', 'hosted: launching a recipe with no folder is a 400 with the plain sentence', nfj);
    const g = await seat(gem);
    const gj = await g.json();
    ok(g.status === 400 && gj.code === 'seat-vendor-unsupported' && gj.error === "Gemini CLI can't join a room yet. Open it from Terminals instead.", 'a Gemini recipe cannot be a room seat: 400, a plain sentence, and the machine code beside it', gj);
    ok(!/seat-vendor-unsupported/.test(gj.error), '...and the sentence carries no code word');
    ok((await seat(cod)).status !== 400, 'a Codex recipe can (it reads its room-tool token through a helper)');
    ok((await seat(cla)).status !== 400, 'a Claude recipe can');
  }
  console.log('\n[L5 + M14 + L4 on a hosted engine]');
  const h0 = await fetch(`${BASE}/health`);
  ok(h0.status === 200 && JSON.stringify(await h0.json()) === '{"status":"ok"}', 'unauthenticated /health: {status:"ok"} and nothing else');
  ok(h0.headers.get('x-frame-options') === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(h0.headers.get('content-security-policy') ?? ''), 'M14: X-Frame-Options SAMEORIGIN and CSP frame-ancestors on a response');
  const h1 = await (await fetch(`${BASE}/health`, { headers: { cookie } })).json();
  ok(h1.status === 'ok' && 'edition' in h1, 'signed in: /health keeps its detail');
  ok((await fetch(`${BASE}/api/node`)).status === 401, 'unauthenticated /api/node: 401');
  ok((await fetch(`${BASE}/vendor/aurora-logo-presets.js`)).status === 401, 'unauthenticated logo presets file: 401');
  ok((await fetch(`${BASE}/vendor/aurora-logo-presets.js`, { headers: { cookie } })).status === 200, '...200 with a sign-in');
  const { safeNext } = await import(pathToFileURL(join(REPO_ROOT, 'src/server/auth.ts')).href);
  ok(safeNext('/room.html?room=1') === '/room.html?room=1' && safeNext('//evil.com') === '/' && safeNext('/\\evil.com') === '/' && safeNext('/a\\b') === '/' && safeNext('http://x') === '/', 'L4: safeNext keeps a local path and refuses //, a backslash and a URL');
  process.env.HARBOR_WB_HOSTED = '1';
  ok(safeNext(null) === '/app/' && safeNext('//evil.com') === '/app/' && safeNext('/room.html') === '/room.html', 'hosted: after sign-in the default landing is /app/ (a refused next lands there too)');
  delete process.env.HARBOR_WB_HOSTED;

  console.log('\n[a GET changes nothing]');
  const before = (await fetch(`${BASE}/api/recipes`, { headers: { cookie } })).status;
  const g1 = await raw({ method: 'GET', path: '/logout', headers: { cookie } });
  const after = (await fetch(`${BASE}/api/recipes`, { headers: { cookie } })).status;
  ok(before === 200 && after === 200, 'GET /logout does not sign anyone out (logout is POST only)', { g1: g1.status, before, after });
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
