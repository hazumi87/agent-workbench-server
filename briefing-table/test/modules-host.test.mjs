/**
 * THE WEB MODULE HOST (M1 sandboxed UI files, M2 catalog + enable switch, M3 storage), against a REAL engine.
 * SAFETY: scratch port and db in a temp dir, no broker, no window host.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(578);
const DEAD_BROKER_PORT = P(579);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'modules-host-test-token';
let passed = 0;
let failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}${d !== undefined ? ` (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await assertFree(PORT, 'modules-host.test.mjs');
await assertFree(DEAD_BROKER_PORT, 'modules-host.test.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'wb-modules-'));
const appDir = join(tmp, 'app');
const mod = (id, extra = {}) => {
  mkdirSync(join(appDir, 'modules', id, 'ui'), { recursive: true });
  writeFileSync(join(appDir, 'modules', id, 'module.json'), JSON.stringify({ id, name: `Mod ${id}`, version: '1.0.0', class: 'tool', provides: [`${id}.card`], contexts: ['workroom'], actions: 'actions.json', permissions: ['storage'], ...extra }));
};
mod('demo', { permissions: ['storage', 'rooms.tasks.read', 'rooms.tasks.write', 'rooms.tasks.delete'] });
mod('nostore', { permissions: [] });
mod('broken', { provides: 'nope' });
writeFileSync(join(appDir, 'modules', 'demo', 'ui', 'page.html'), '<!doctype html><script src="page.js"></script>');
writeFileSync(join(appDir, 'modules', 'demo', 'ui', 'page.js'), 'export {}');
writeFileSync(join(appDir, 'modules', 'demo', 'ui', 'tool.exe'), 'x');
writeFileSync(join(appDir, 'modules', 'demo', 'index.js'), 'export const main = 1');
const outside = join(tmp, 'outside');
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.html'), 'secret');
symlinkSync(join(outside, 'secret.html'), join(appDir, 'modules', 'demo', 'ui', 'leak.html'));
mkdirSync(join(appDir, 'plugins', 'plug', 'ui'), { recursive: true });
writeFileSync(join(appDir, 'plugins', 'plug', 'ui', 'p.html'), 'plugin page');
let log = '';
const engine = spawn(process.execPath, ['--import', join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'src/server/index.ts'], {
  cwd: REPO_ROOT,
  env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_BROKERS: '{}', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'claude-projects'),HARBOR_WB_APP_DIR: appDir, HARBOR_WB_TASKS: '1',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
engine.stdout.on('data', (d) => (log += d));
engine.stderr.on('data', (d) => (log += d));
try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
    if (!up) await sleep(250);
  }
  if (!up) throw new Error(`engine did not come up\n${log}`);
  const cookie = await windowCookie(BASE, TOKEN);
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const call = async (path, { method = 'GET', json, as = 'person' } = {}) => {
    const headers = as === 'person' ? { cookie } : bearer;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${BASE}${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    let body = null;
    try { body = await r.json(); } catch { /* none */ }
    return { status: r.status, body };
  };
  const page = (path, headers = { cookie }) => fetch(`${BASE}${path}`, { headers, redirect: 'manual' });

  console.log('\n[M2: the catalog]');
  const cat = await call('/api/modules');
  const byId = Object.fromEntries((cat.body?.modules ?? []).map((m) => [m.id, m]));
  ok(cat.status === 200 && byId.demo?.enabled === true && byId.demo.contexts[0] === 'workroom' && byId.demo.source === 'bundled', 'bundled modules are listed and on', cat.body);
  ok(byId.broken?.enabled === false && /provides/.test(byId.broken.error ?? ''), 'a module that fails its checks is listed with the reason, off', byId.broken);
  ok(cat.body.plugins.enabled === false, 'plugins are off by default');
  ok((await fetch(`${BASE}/api/modules`)).status === 401, 'unauthenticated: 401');
  ok((await call('/api/modules/demo/enabled', { method: 'PUT', json: { enabled: false }, as: 'bearer' })).status === 403, 'an agent cannot switch a module: 403');
  ok((await call('/api/modules/broken/enabled', { method: 'PUT', json: { enabled: true } })).status === 409, 'a module in error cannot be turned on: 409');
  ok((await call('/api/modules/nope/enabled', { method: 'PUT', json: { enabled: true } })).status === 404, 'unknown module: 404');

  ok((await call('/api/modules/plugins', { method: 'POST', json: {} })).status === 404 && (await call('/api/modules/plugins/plug/review', { method: 'POST', json: {} })).status === 404 && (await call('/api/modules/plugins/plug', { method: 'DELETE' })).status === 404, 'P6: with HARBOR_WB_PLUGINS unset every plugin route is 404');
  console.log('\n[M1: the sandboxed pages]');
  const ui = await page('/app/modules/demo/ui/page.html');
  const csp = ui.headers.get('content-security-policy') ?? '';
  ok(ui.status === 200 && /^sandbox allow-scripts;/.test(csp) && /connect-src 'none'/.test(csp) && ui.headers.get('x-content-type-options') === 'nosniff' && ui.headers.get('cache-control') === 'no-store' && /text\/html/.test(ui.headers.get('content-type') ?? ''), 'a ui page: sandbox CSP, connect-src none, nosniff, no-store', csp);
  ok((await page('/app/modules/demo/ui/page.js')).status === 200, 'its script is served');
  for (const [what, path] of [['an extension off the list', '/app/modules/demo/ui/tool.exe'], ['a symlink out of ui/', '/app/modules/demo/ui/leak.html'], ['dot-dot', '/app/modules/demo/ui/..%2f..%2fmodule.json'], ['an encoded slash', '/app/modules/demo/ui/a%2fb.html'], ['a backslash', '/app/modules/demo/ui/a%5cb.html'], ['a missing file', '/app/modules/demo/ui/none.html'], ['an unknown module', '/app/modules/ghost/ui/page.html'], ['a module in error', '/app/modules/broken/ui/page.html'], ['a plugin path', '/app/plugins/plug/ui/p.html'], ['a plugin main script', '/app/plugins/plug/index.js']]) {
    ok((await page(path)).status === 404, `404: ${what}`);
  }
  const nocookie = await page('/app/modules/demo/ui/page.js', { origin: 'null' });
  ok(nocookie.status === 200 && nocookie.headers.get('access-control-allow-origin') === 'null' && /Origin/i.test(nocookie.headers.get('vary') ?? '') && /^sandbox/.test(nocookie.headers.get('content-security-policy') ?? ''), 'a sandboxed page fetches its script with NO cookie and Origin: null: 200 with ACAO null, Vary: Origin, sandbox CSP kept');
  ok((await page('/app/modules/demo/ui/page.html', {})).status === 200, '...pages too (nothing secret lives under ui/)');
  ok((await page('/app/modules/demo/index.js', {})).status !== 200 && (await page('/app/', {})).status !== 200 && (await page('/api/modules', {})).status === 401, 'but everything else under /app and /api still needs the sign-in');
  ok((await page('/app/modules/broken/ui/page.html', {})).status === 404 && (await page('/app/modules/demo/ui/tool.exe', {})).status === 404 && (await page('/app/plugins/plug/ui/p.html', {})).status === 404, 'unsigned requests keep every other check (module in error, extension, plugin switch)');
  ok((await page('/app/modules/demo/index.js')).status !== 404, "the module's main script is the normal /app mount's (not a ui page)");
  ok((await call('/api/modules/demo/enabled', { method: 'PUT', json: { enabled: false } })).body?.enabled === false, 'a person turns a module off');
  ok((await page('/app/modules/demo/ui/page.html')).status === 404, '...and its pages stop being served');
  ok((await call('/api/modules/demo/enabled', { method: 'PUT', json: { enabled: true } })).body?.enabled === true, 'and on again');

  console.log('\n[M3: storage]');
  const st = (name, o) => call(`/api/modules/demo/storage${name ? `/${name}` : ''}`, o);
  ok((await st('k1', { method: 'PUT', json: { value: 'hello' } })).status === 200, 'a person writes a key');
  ok((await st('k1')).body?.value === 'hello' && (await st()).body?.names?.join() === 'k1', 'reads it back and lists the names');
  ok((await st('k1', { method: 'PUT', json: { value: 'x' }, as: 'bearer' })).status === 403, 'an agent cannot write: 403');
  ok((await st('bad%2Fname', { method: 'PUT', json: { value: 'x' } })).status === 400 && (await st('a..b', { method: 'PUT', json: { value: 'x' } })).status === 400, 'a name with a slash or dots: 400');
  ok((await st('big', { method: 'PUT', json: { value: 'x'.repeat(256 * 1024 + 1) } })).status === 413, 'a value over 256 KB: 413');
  ok((await call('/api/modules/nostore/storage/k', { method: 'PUT', json: { value: 'x' } })).status === 403, 'no storage permission: 403');
  ok((await st('k1', { method: 'DELETE' })).status === 200 && (await st('k1')).status === 404, 'delete removes it');
  for (let i = 0; i < 9; i++) await st(`fill${i}`, { method: 'PUT', json: { value: 'y'.repeat(250 * 1024) } });
  ok((await st('over', { method: 'PUT', json: { value: 'y'.repeat(250 * 1024) } })).status === 413, "the module's total is capped (2 MB): 413");

  console.log('\n[M4: the engine admits a module page\'s Tasks call]');
  const room = await call('/api/rooms', { method: 'POST', json: { name: 'Admission' } });
  const rid = room.body?.room?.id ?? room.body?.id;
  ok(room.status < 300 && rid, 'a room to work in', room);
  const adm = (mod, json, o = {}) => call(`/api/modules/${mod}/rooms/${rid}/tasks`, { method: 'POST', json, ...o });
  const added = await adm('demo', { verb: 'add', input: { title: 'from a module' } });
  ok(added.status === 200 || added.status === 201, 'a granted write goes through the native route', added);
  const listed = await adm('demo', { verb: 'list', input: {} });
  ok(listed.status === 200 && JSON.stringify(listed.body).includes('from a module'), 'a granted read sees it', listed.body);
  ok((await adm('demo', { verb: 'list', input: {} }, { as: 'bearer' })).status === 403, 'an agent: 403');
  ok((await adm('ghost', { verb: 'list', input: {} })).status === 404, 'unknown module: 404');
  ok((await adm('broken', { verb: 'list', input: {} })).status === 404, 'a module in error: 404');
  ok((await adm('nostore', { verb: 'list', input: {} })).status === 403, 'no rooms.tasks.read in the manifest: 403');
  ok((await adm('demo', { verb: 'nope', input: {} })).status === 400, 'a verb not in the table: 400');
  ok((await adm('demo', { verb: 'add', input: { title: 'x', author: 'someone' } })).status === 400, 'an author key in the input: 400');
  ok((await adm('demo', { verb: 'add', input: { title: 'x', room: 'other' } })).status === 400, 'a room key in the input: 400');
  const tid = (added.body?.task?.id ?? added.body?.id ?? 1);
  const noAp = await adm('demo', { verb: 'purge', input: { tid } });
  ok(noAp.status === 403 && noAp.body?.error === 'approval-required', 'purge without an approval: 403', noAp.body);
  const ap = await call(`/api/modules/demo/rooms/${rid}/tasks/approve`, { method: 'POST', json: { verb: 'purge', input: { tid } } });
  ok(ap.status === 200 && typeof ap.body?.approval === 'string', 'a person mints a one-use approval', ap.body);
  ok((await adm('demo', { verb: 'purge', input: { tid: tid + 1 }, approval: ap.body.approval })).status === 403, 'the approval is bound to its task: another task is refused (and the token is burned)');
  ok((await adm('demo', { verb: 'purge', input: { tid }, approval: ap.body.approval })).status === 403, 'a used or burned approval is refused');
  const ap2 = await call(`/api/modules/demo/rooms/${rid}/tasks/approve`, { method: 'POST', json: { verb: 'purge', input: { tid } } });
  const purged = await adm('demo', { verb: 'purge', input: { tid }, approval: ap2.body.approval });
  ok(purged.status < 300, 'with a fresh matching approval the delete runs', purged);
  ok((await call(`/api/modules/demo/rooms/${rid}/tasks/approve`, { method: 'POST', json: { verb: 'list', input: {} } })).status === 400, 'approve is for deletes only: 400');
  const flood = await Promise.all(Array.from({ length: 60 }, () => adm('demo', { verb: 'list', input: {} })));
  ok(flood.some((r) => r.status === 429), 'a flood runs into the per-module budget: 429');
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
