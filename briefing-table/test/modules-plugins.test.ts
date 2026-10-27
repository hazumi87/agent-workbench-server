/**
 * PLUGIN INSTALL (M6) against a REAL engine with HARBOR_WB_PLUGINS=1: upload + checks, consent, install, the sandboxed pages served only while the bytes are the pinned ones, tamper, review, delete,
 * person-only, and the refusals (reserved id, a program in the zip). SAFETY: scratch port and data dir in a temp folder, no broker.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './fixtures/make-zip.ts';
// @ts-expect-error plain JS helper
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(580);
const DEAD = P(581);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'modules-plugins-test-token';
let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string, d?: unknown): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}${d !== undefined ? ` (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

await assertFree(PORT, 'modules-plugins.test.ts');
await assertFree(DEAD, 'modules-plugins.test.ts');
const tmp = mkdtempSync(join(tmpdir(), 'wb-plugins-'));
const appDir = join(tmp, 'app');
const dataDir = join(tmp, 'data');
let log = '';
const engine = spawn(process.execPath, ['--import', join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'src/server/index.ts'], {
  cwd: REPO_ROOT,
  env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(dataDir, 'mapping.db'), HARBOR_WB_DATA_DIR: dataDir, HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD), HARBOR_WB_BROKERS: '{}', HARBOR_WB_NO_WINDOW_HOST: '1',
    HARBOR_WB_APP_DIR: appDir, HARBOR_WB_PLUGINS: '1', HARBOR_WB_TASKS: '1',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
engine.stdout.on('data', (d: Buffer) => (log += d));
engine.stderr.on('data', (d: Buffer) => (log += d));

const manifest = (over: Record<string, unknown> = {}): string => JSON.stringify({ entry: 'ui/page.html', id: 'plug-one', name: 'Plug One', version: '1.0.0', class: 'tool', provides: ['plug.card'], contexts: ['workroom'], actions: 'actions.json', permissions: ['rooms.tasks.read'], ...over });
const actions = JSON.stringify({ actions: [{ name: 'render', title: 'Make a card', provides: 'plug.card', input: { text: { type: 'string', title: 'Text', maxLength: 200 } }, output: { kind: 'text' }, contexts: ['workroom'] }] });
const zipOf = (over: Record<string, unknown> = {}, extra: Array<{ name: string; data: string | Buffer }> = []): Buffer =>
  makeZip([{ name: 'plug-one/module.json', data: manifest(over) }, { name: 'plug-one/actions.json', data: actions }, { name: 'plug-one/ui/page.html', data: '<!doctype html><script src="page.js"></script>' }, { name: 'plug-one/ui/page.js', data: 'export {}' }, ...extra]);

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
    if (!up) await sleep(250);
  }
  if (!up) throw new Error(`engine did not come up\n${log}`);
  const cookie: string = await windowCookie(BASE, TOKEN);
  const bearer = { authorization: `Bearer ${TOKEN}` };
  const send = async (path: string, o: { method?: string; json?: unknown; raw?: Buffer; headers?: Record<string, string>; as?: 'person' | 'bearer' } = {}): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = { ...(o.as === 'bearer' ? bearer : { cookie }), ...(o.headers ?? {}) };
    let body: BodyInit | undefined;
    if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
    if (o.raw) body = o.raw;
    const r = await fetch(`${BASE}${path}`, { method: o.method ?? 'GET', headers, body });
    let b: any = null;
    try { b = await r.json(); } catch { /* none */ }
    return { status: r.status, body: b };
  };
  const multipart = (zip: Buffer): { raw: Buffer; headers: Record<string, string> } => {
    const bd = '----wbtest1234';
    const raw = Buffer.concat([Buffer.from(`--${bd}\r\ncontent-disposition: form-data; name="file"; filename="p.zip"\r\ncontent-type: application/zip\r\n\r\n`), zip, Buffer.from(`\r\n--${bd}--\r\n`)]);
    return { raw, headers: { 'content-type': `multipart/form-data; boundary=${bd}` } };
  };
  const upload = (zip: Buffer, as: 'person' | 'bearer' = 'person') => send('/api/modules/plugins', { method: 'POST', as, ...multipart(zip) });
  const page = (path: string) => fetch(`${BASE}${path}`, { headers: { cookie } });

  console.log('\n[upload and checks]');
  ok((await upload(zipOf(), 'bearer')).status === 403, 'an agent cannot upload: 403');
  const bad1 = await upload(zipOf({ id: 'usage' }));
  ok(bad1.status === 400 && bad1.body?.reason === 'reserved-id', 'a bundled id is refused (reserved-id)', bad1.body);
  const bad2 = await upload(zipOf({}, [{ name: 'plug-one/ui/run.exe', data: 'MZ' }]));
  ok(bad2.status === 400 && bad2.body?.reason === 'program', 'a program in the zip is refused', bad2.body);
  const bad3 = await send('/api/modules/plugins', { method: 'POST', raw: Buffer.from('not a zip at all') });
  ok(bad3.status === 400, 'not a zip: 400', bad3.body);
  const chk = await upload(zipOf());
  ok(chk.status === 200 && /^[0-9a-f]{32}$/.test(chk.body?.checkId) && chk.body.plugin.id === 'plug-one' && chk.body.permissions.join() === 'rooms.tasks.read' && chk.body.files.some((f: any) => f.path === 'ui/page.html' && /^[0-9a-f]{64}$/.test(f.sha256)), 'a good zip: checkId, plugin, permissions, per-file hashes', chk.body);

  console.log('\n[consent and install]');
  const wrong = await send(`/api/modules/plugins/${chk.body.checkId}/install`, { method: 'POST', json: { consent: { permissions: [] } } });
  ok(wrong.status === 400 && wrong.body?.field === 'consent' && /^[0-9a-f]{32}$/.test(wrong.body?.checkId), 'the wrong permissions: 400, and a fresh check id comes back', wrong.body);
  ok((await send(`/api/modules/plugins/${chk.body.checkId}/install`, { method: 'POST', json: { consent: { permissions: ['rooms.tasks.read'] } } })).status === 409, 'the spent check id is refused (409)');
  ok((await send(`/api/modules/plugins/${wrong.body.checkId}/install`, { method: 'POST', json: { consent: { permissions: ['rooms.tasks.read'] } }, as: 'bearer' })).status === 403, 'an agent cannot install: 403');
  const again = await upload(zipOf());
  const inst = await send(`/api/modules/plugins/${again.body.checkId}/install`, { method: 'POST', json: { consent: { permissions: ['rooms.tasks.read'] } } });
  const mine = (inst.body?.modules ?? []).find((m: any) => m.id === 'plug-one');
  ok(inst.status === 200 && inst.body.plugin.id === 'plug-one' && mine?.enabled === true && mine.source === 'plugin' && mine.consent?.state === 'ok', 'install: the plugin is on, source plugin, consent ok', inst.body);
  ok(existsSync(join(dataDir, 'plugins', 'plug-one', 'module.json')), 'it is on disk under <data>/plugins/<id>/');
  ok(mine?.entry === 'ui/page.html', 'the catalog row carries `entry` (a plain ui page that the consent pinned)', mine);

  console.log('\n[M1: its pages, only while the bytes are the pinned ones]');
  const ui = await page('/app/plugins/plug-one/ui/page.html');
  const csp = ui.headers.get('content-security-policy') ?? '';
  ok(ui.status === 200 && /^sandbox allow-scripts;/.test(csp) && /connect-src 'none'/.test(csp) && ui.headers.get('x-content-type-options') === 'nosniff', 'served with the sandbox CSP', csp);
  ok((await page('/app/plugins/plug-one/ui/page.js')).status === 200, 'its script too');
  ok((await page('/app/plugins/plug-one/module.json')).status === 404 && (await page('/app/plugins/plug-one/actions.json')).status === 404, 'only ui/ pages: module.json and actions.json are never served');
  ok((await page('/app/modules/plug-one/ui/page.html')).status === 404, 'a plugin id under /app/modules: 404');
  ok((await fetch(`${BASE}/app/plugins/plug-one/ui/page.js`, { headers: { origin: 'null' } })).status === 200, 'with no cookie and Origin: null the pinned page script is served (a sandboxed frame carries no cookie)');
  writeFileSync(join(dataDir, 'plugins', 'plug-one', 'ui', 'page.js'), 'export const evil = 1');
  ok((await page('/app/plugins/plug-one/ui/page.js')).status === 404 && (await page('/app/plugins/plug-one/ui/page.html')).status === 404, 'P8: a file changed on disk after consent is not served, and neither is the rest (the plugin is held)');
  ok((await fetch(`${BASE}/app/plugins/plug-one/ui/page.js`)).status === 404, '...also without a cookie');
  const held = ((await send('/api/modules')).body.modules as any[]).find((m) => m.id === 'plug-one');
  ok(held?.enabled === false && held.consent?.state === 'held', 'the catalog shows it off and held', held);
  ok((await send('/api/modules/plug-one/enabled', { method: 'PUT', json: { enabled: true } })).status === 409, 'it cannot be switched back on without consent: 409');

  console.log('\n[review and allow again]');
  // put the pinned bytes back, then review + install over the same id
  writeFileSync(join(dataDir, 'plugins', 'plug-one', 'ui', 'page.js'), 'export {}');
  const rv = await send('/api/modules/plugins/plug-one/review', { method: 'POST', json: {} });
  ok(rv.status === 200 && rv.body.replaces?.version === '1.0.0' && /^[0-9a-f]{32}$/.test(rv.body.checkId), 'review answers like an upload and says what it replaces', rv.body);
  const re = await send(`/api/modules/plugins/${rv.body.checkId}/install`, { method: 'POST', json: { consent: { permissions: ['rooms.tasks.read'] } } });
  ok(re.status === 200 && (re.body.modules as any[]).find((m) => m.id === 'plug-one')?.enabled === true, 'allowed again: on', re.body);
  ok((await page('/app/plugins/plug-one/ui/page.js')).status === 200, '...and served again');

  console.log('\n[module storage survives delete; delete is person-only]');
  const stor = await send('/api/modules/plug-one/storage/k', { method: 'PUT', json: { value: 'v' } });
  ok(stor.status === 403, 'no storage permission was granted: 403', stor.body);
  ok((await send('/api/modules/plugins/plug-one', { method: 'DELETE', as: 'bearer' })).status === 403, 'an agent cannot delete: 403');
  const del = await send('/api/modules/plugins/plug-one', { method: 'DELETE' });
  ok(del.status === 200 && !(del.body.modules as any[]).some((m) => m.id === 'plug-one'), 'delete: gone from the catalog', del.body);
  ok(!existsSync(join(dataDir, 'plugins', 'plug-one')) && (await page('/app/plugins/plug-one/ui/page.html')).status === 404, '...from disk, and its pages 404');
  ok(readFileSync(join(dataDir, 'mapping.db')).length > 0, 'the table is intact');
} catch (e) {
  failed++;
  console.log(`  X  threw: ${(e as Error)?.stack ?? e}`);
} finally {
  engine.kill('SIGKILL');
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
