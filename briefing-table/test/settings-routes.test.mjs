/**
 * SETTINGS ROUTES for the web UI, against a REAL engine: auto-approve (default + per-recipe tri-state + the launch effect), per-folder trust, the rooted folder picker.
 * SAFETY: scratch port and db in a temp dir, no broker, no window host.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(566);
const DEAD_BROKER_PORT = P(567);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'settings-routes-test-token';
let passed = 0;
let failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}${d !== undefined ? ` (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await assertFree(PORT, 'settings-routes.test.mjs');
await assertFree(DEAD_BROKER_PORT, 'settings-routes.test.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'wb-settings-'));
const root = join(tmp, 'root');
mkdirSync(join(root, 'alpha', 'inner'), { recursive: true });
mkdirSync(join(root, 'beta'), { recursive: true });
mkdirSync(join(root, '.hidden'), { recursive: true });
writeFileSync(join(root, 'a-file.txt'), 'x');
const outside = join(tmp, 'outside');
mkdirSync(outside, { recursive: true });
symlinkSync(outside, join(root, 'escape'));
symlinkSync(join(root, 'beta'), join(root, 'inside-link'));
const appDir = join(tmp, 'app');
mkdirSync(join(appDir, 'assets'), { recursive: true });
writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title>');
writeFileSync(join(appDir, 'assets', 'a.js'), 'export {}');
const PINNED_CSP = "default-src 'self'; connect-src 'self'; frame-ancestors 'self'";
symlinkSync(join(tmp, 'outside'), join(appDir, 'leak'));
writeFileSync(join(outside, 'secret.txt'), 's');
let log = '';
const engine = spawn(process.execPath, ['--import', join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'src/server/index.ts'], {
  cwd: REPO_ROOT,
  env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_BROKERS: '{}', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'claude-projects'), HARBOR_WB_FS_ROOT: root, HARBOR_WB_APP_DIR: appDir,
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

  console.log('\n[auto-approve default: off until a person chooses, disclosure recorded by the engine]');
  let g = await call('/api/settings/auto-approve');
  ok(g.status === 200 && g.body.default === 'off' && g.body.autoApproveDisclosedAt === null && Array.isArray(g.body.recipes), 'GET: default off, no disclosure yet', g.body);
  ok((await call('/api/settings/auto-approve', { method: 'PUT', json: { default: 'on', disclosed: true }, as: 'bearer' })).status === 403, 'an agent (bearer) cannot change it: 403');
  ok((await call('/api/settings/auto-approve', { method: 'PUT', json: { default: 'maybe' } })).status === 400, 'an unknown value: 400');
  const noDisc = await call('/api/settings/auto-approve', { method: 'PUT', json: { default: 'on' } });
  ok(noDisc.status === 400 && noDisc.body.error === 'disclosure-required', 'ON without the disclosure: 400 disclosure-required', noDisc.body);
  const offAck = await call('/api/settings/auto-approve', { method: 'PUT', json: { default: 'off', disclosed: true } });
  ok(offAck.status === 200 && typeof offAck.body.autoApproveDisclosedAt === 'number' && offAck.body.default === 'off', 'choosing OFF with the disclosure shown records the time (engine clock)', offAck.body);
  const at = offAck.body.autoApproveDisclosedAt;

  console.log('\n[a recipe: follow | on | off, validated by the engine]');
  const mk = (extra) => call('/api/recipes', { method: 'POST', json: { name: 'AA Probe', target: 'local', vendor: 'gemini-cli', ...extra } });
  const bad = await mk({ autoApprove: 'always' });
  ok(bad.status === 400 && bad.body.field === 'autoApprove', 'an unknown autoApprove: 400 field autoApprove', bad.body);
  const r1 = await mk({});
  ok(r1.status === 200 || r1.status === 201, 'create without the field', r1.status);
  const id = r1.body.recipe?.id ?? r1.body.id;
  let list = (await call('/api/recipes')).body.recipes;
  let me = list.find((r) => r.id === id);
  ok(me?.autoApprove === 'follow' && me?.autoApproveEffective === 'off' && me?.autoApproveSource === 'default', 'a new recipe is follow, effective off (the default is off)', me && { a: me.autoApprove, e: me.autoApproveEffective });
  ok((await call('/api/recipes', { method: 'POST', json: { id, name: 'AA Probe', target: 'local', vendor: 'gemini-cli', autoApprove: 'on' }, as: 'bearer' })).status === 403, 'an agent cannot turn a recipe ON: 403');
  const on = await call('/api/recipes', { method: 'POST', json: { id, name: 'AA Probe', target: 'local', vendor: 'gemini-cli', autoApprove: 'on' } });
  ok(on.status === 200 || on.status === 201, 'a person turns it ON (disclosure already recorded at first run)', on.status);
  me = (await call('/api/recipes')).body.recipes.find((r) => r.id === id);
  ok(me.autoApprove === 'on' && me.autoApproveEffective === 'on' && me.autoApproveSource === 'recipe', 'recipe ON: effective on, source recipe');
  const keep = await call('/api/recipes', { method: 'POST', json: { id, name: 'AA Probe renamed', target: 'local', vendor: 'gemini-cli' } });
  me = (await call('/api/recipes')).body.recipes.find((r) => r.id === id);
  ok(me.autoApprove === 'on', 'a save that omits the field keeps the stored value (an older client does not reset it)', keep.status);
  await call('/api/recipes', { method: 'POST', json: { id, name: 'AA Probe', target: 'local', vendor: 'gemini-cli', autoApprove: 'follow' } });
  const dOn = await call('/api/settings/auto-approve', { method: 'PUT', json: { default: 'on' } });
  ok(dOn.status === 200 && dOn.body.default === 'on' && dOn.body.autoApproveDisclosedAt === at, 'default ON (disclosure already recorded; the original time is kept)', dOn.body);
  me = dOn.body.recipes.find((r) => r.id === id);
  ok(me.setting === 'follow' && me.effective === 'on' && me.source === 'default', 'follow now resolves to the default: on');
  await call('/api/recipes', { method: 'POST', json: { id, name: 'AA Probe', target: 'local', vendor: 'gemini-cli', autoApprove: 'off' } });
  me = (await call('/api/settings/auto-approve')).body.recipes.find((r) => r.id === id);
  ok(me.setting === 'off' && me.effective === 'off', 'recipe OFF wins over default ON');

  console.log('\n[per-folder trust: a person-only opt-in list, default empty]');
  const trustDir = join(root, 'alpha');
  ok((await call('/api/settings/folder-trust')).body.folders.length === 0, 'GET: empty by default');
  ok((await call('/api/settings/folder-trust', { method: 'PUT', json: { path: trustDir, trusted: true }, as: 'bearer' })).status === 403, 'an agent cannot trust a folder: 403');
  ok((await call('/api/settings/folder-trust', { method: 'PUT', json: { path: join(root, 'nope'), trusted: true } })).status === 400, 'a folder that does not exist: 400');
  ok((await call('/api/settings/folder-trust', { method: 'PUT', json: { path: 'relative', trusted: true } })).status === 400, 'a relative path: 400');
  const t1 = await call('/api/settings/folder-trust', { method: 'PUT', json: { path: trustDir, trusted: true } });
  ok(t1.status === 200 && t1.body.folders.length === 1 && t1.body.folders[0].path === realpathSync(trustDir) && typeof t1.body.folders[0].trustedAt === 'number', 'a person trusts a folder; the answer is the list', t1.body);
  const t2 = await call('/api/settings/folder-trust', { method: 'PUT', json: { path: trustDir, trusted: false } });
  ok(t2.status === 200 && t2.body.folders.length === 0, 'and removes it');

  console.log('\n[M6: a logo goes through the allow-list sanitizer before it is stored]');
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" onload="alert(1)"><script>alert(2)</script><path d="M0 0L4 4" fill="#123456"/></svg>';
  const lg = await call('/api/logos', { method: 'POST', json: { name: 'dirty', svg: dirty } });
  ok(lg.status === 200 && !/onload|script|alert/.test(lg.body.logo.svg) && /<path d="M0 0L4 4"/.test(lg.body.logo.svg), 'POST /api/logos stores the cleaned markup, not the script', lg.body?.logo?.svg);
  const rej = await call('/api/logos', { method: 'POST', json: { name: 'bad', svg: '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>' } });
  ok(rej.status === 400 && rej.body.code === 'svg-rejected', 'a DOCTYPE/ENTITY file: 400 svg-rejected', rej.body);
  const rl = await call('/api/recipes', { method: 'POST', json: { name: 'Logo Probe', target: 'local', logo: JSON.stringify({ svg: dirty, scale: 50, mono: 'white', opacity: 20 }) } });
  const rid = rl.body.recipe?.id ?? rl.body.id;
  const got = (await call('/api/recipes')).body.recipes.find((r) => r.id === rid);
  ok(rl.status < 300 && !/onload|script|alert/.test(got?.logo ?? ''), 'a recipe logo JSON is cleaned the same way', rl.status);
  const rl2 = await call('/api/recipes', { method: 'POST', json: { name: 'Logo Probe 2', target: 'local', logo: JSON.stringify({ svg: 'not an svg' }) } });
  ok(rl2.status === 400 && rl2.body.code === 'svg-rejected', 'a recipe logo that is not an SVG: 400 svg-rejected', rl2.body);

  console.log('\n[the rooted folder picker]');
  const d0 = await call('/api/fs/dirs');
  ok(d0.status === 200 && d0.body.parent === null && d0.body.path === realpathSync(root), 'no path: the root, parent null', d0.body);
  const names = d0.body.entries.map((e) => e.name);
  ok(names.join() === 'alpha,beta,inside-link', 'directories only, hidden skipped, a symlink out of the root not offered, one inside it is', names);
  ok((await call('/api/fs/dirs?hidden=1')).body.entries.some((e) => e.name === '.hidden'), 'hidden=1 shows dot folders');
  const d1 = await call(`/api/fs/dirs?path=${encodeURIComponent(join(root, 'alpha'))}`);
  ok(d1.status === 200 && d1.body.parent === realpathSync(root) && d1.body.entries.map((e) => e.name).join() === 'inner', 'a child: its parent and entries');
  ok((await call(`/api/fs/dirs?path=${encodeURIComponent(join(root, 'escape'))}`)).status === 403, 'a symlink that leaves the root: 403 outside-root');
  ok((await call(`/api/fs/dirs?path=${encodeURIComponent(join(root, 'alpha', '..', '..'))}`)).status === 403, '.. out of the root: 403');
  ok((await call('/api/fs/dirs?path=/etc')).status === 403, 'an absolute path elsewhere: 403');
  ok((await call(`/api/fs/dirs?path=${encodeURIComponent(join(root, 'missing'))}`)).status === 404, 'a missing folder: 404');
  console.log('\n[POST /api/fs/dirs: New folder]');
  const mkDir = (path, name, as) => call('/api/fs/dirs', { method: 'POST', json: { path, name }, as });
  const m1 = await mkDir(join(root, 'alpha'), 'fresh');
  ok(m1.status === 200 && m1.body.path === join(realpathSync(root), 'alpha', 'fresh') && statSync(m1.body.path).isDirectory(), 'a person creates a folder; the answer is {path}', m1.body);
  ok((await mkDir(join(root, 'alpha'), 'fresh')).status === 409, 'it exists: 409, never overwrites');
  ok((await mkDir(join(root, 'alpha'), 'x', 'bearer')).status === 403, 'an agent: 403');
  for (const bad of ['..', 'a/b', 'a\\b', 'a\0b', '', ' pad', 'x..y']) ok((await mkDir(join(root, 'alpha'), bad)).status === 400, `name ${JSON.stringify(bad)}: 400`);
  ok((await mkDir(join(root, 'escape'), 'x')).status === 403, 'parent is a symlink out of the root: 403');
  ok((await mkDir('/etc', 'x')).status === 403, 'parent outside the root: 403');
  ok((await mkDir(join(root, 'missing'), 'x')).status === 400, 'parent missing: 400');
  console.log('\n[/app: the built web app, behind sign-in, with its own CSP]');
  const ap = (path, headers = { cookie }) => fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
  const a0 = await ap('/app/');
  ok(a0.status === 200 && /default-src 'self'/.test(a0.headers.get('content-security-policy') ?? '') && /connect-src 'self';/.test(a0.headers.get('content-security-policy') ?? '') && /<title>app/.test(await a0.text()), '/app/ serves index.html with the app CSP');
  writeFileSync(join(appDir, 'csp.json'), JSON.stringify({ header: PINNED_CSP }));
  ok((await ap('/app/')).headers.get('content-security-policy') === PINNED_CSP, 'a csp.json shipped with the app is the EXACT header');
  const refuse = async (header, what) => {
    writeFileSync(join(appDir, 'csp.json'), JSON.stringify({ header }));
    const got = (await ap('/app/')).headers.get('content-security-policy') ?? '';
    ok(got !== header && /connect-src 'self';/.test(got) && /frame-ancestors 'self'/.test(got), `a shipped header is refused (default used): ${what}`, got);
  };
  await refuse("default-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'self'", 'scheme-only ws:/wss: in connect-src');
  await refuse("default-src 'self'; script-src 'self'; connect-src 'self'", 'no frame-ancestors');
  await refuse("default-src 'self'; script-src *; connect-src 'self'; frame-ancestors 'self'", 'wildcard script-src');
  await refuse("default-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors *", 'frame-ancestors *');
  await refuse("default-src 'self'; script-src 'self' https://evil.example; connect-src 'self'; frame-ancestors 'self'", 'a host in script-src');
  await refuse("default-src 'self'; script-src 'self' *.evil.example; connect-src 'self'; frame-ancestors 'self'", 'a wildcard host in script-src');
  await refuse("default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'", "'unsafe-inline' in script-src");
  await refuse("default-src 'self'; script-src 'self'; connect-src 'self' https://x.example; frame-ancestors 'self'", 'a host in connect-src');
  const CLIENT_CSP = "default-src 'self'; script-src 'self'; frame-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";
  writeFileSync(join(appDir, 'csp.json'), JSON.stringify({ header: CLIENT_CSP }));
  const scoped = (await ap('/app/')).headers.get('content-security-policy') ?? '';
  ok(scoped === CLIENT_CSP.replace("script-src 'self'", `script-src ${BASE}/app/`), "M5: script-src 'self' is scoped to <origin>/app/, the rest of the shipped header is untouched", scoped);
  writeFileSync(join(appDir, 'csp.json'), JSON.stringify({ header: PINNED_CSP }));
  const a1 = await ap('/app/assets/a.js');
  ok(a1.status === 200 && /javascript/.test(a1.headers.get('content-type') ?? '') && a1.headers.get('x-content-type-options') === 'nosniff', 'an asset: right type, nosniff');
  ok((await (await ap('/app/some/client/route')).text()).includes('<title>app'), 'an extensionless path falls back to index.html');
  ok((await ap('/app/missing.js')).status === 404, 'a missing file is a real 404, not index.html');
  ok((await ap('/app/leak/secret.txt')).status === 404, 'a symlink out of the app dir is not served');
  ok((await ap('/app/..%2f..%2fetc/passwd')).status === 404, 'dot-dot is not served');
  ok((await ap('/app/', {})).status !== 200, 'not signed in: no app');
  console.log('\n[first-run setup, agent install status, sign-in recipes]');
  const s0 = await call('/api/settings/setup');
  ok(s0.status === 200 && s0.body.completedAt === null && s0.body.defaultFolder === null, 'setup starts empty', s0.body);
  ok((await call('/api/settings/setup', { as: 'bearer' })).status === 403 && (await call('/api/settings/setup', { method: 'PUT', json: { complete: true }, as: 'bearer' })).status === 403, 'agents: 403 on both verbs');
  ok((await call('/api/settings/setup', { method: 'PUT', json: { defaultFolder: 'relative' } })).status === 400, 'a relative folder: 400');
  ok((await call('/api/settings/setup', { method: 'PUT', json: { defaultFolder: '/etc' } })).status === 403, 'a folder outside the root: 403');
  ok((await call('/api/settings/setup', { method: 'PUT', json: { defaultFolder: join(root, 'missing') } })).status === 400, 'a missing folder: 400');
  const s1 = await call('/api/settings/setup', { method: 'PUT', json: { defaultFolder: join(root, 'alpha') } });
  ok(s1.status === 200 && s1.body.defaultFolder === realpathSync(join(root, 'alpha')) && s1.body.completedAt === null, 'a valid default folder is kept; not completed yet', s1.body);
  const t0 = Date.now();
  const s2 = await call('/api/settings/setup', { method: 'PUT', json: { complete: true, completedAt: 5 } });
  ok(s2.status === 200 && s2.body.completedAt >= t0 && s2.body.defaultFolder === s1.body.defaultFolder, 'complete:true is stamped by the engine clock (a client time is ignored)', s2.body);
  const s3 = await call('/api/settings/setup', { method: 'PUT', json: { complete: true } });
  ok(s3.body.completedAt === s2.body.completedAt, 'and stamped once');
  const ag = await call('/api/agents/status');
  ok(ag.status === 200 && ag.body.vendors.map((v) => v.id).join() === 'claude-code,codex-cli,gemini-cli' && ag.body.vendors.every((v) => typeof v.installed === 'boolean' && !('path' in v)), 'agents/status: installed true|false per vendor, no paths', ag.body);
  const si = await call('/api/agents/codex-cli/sign-in', { method: 'POST', json: {} });
  const rcp = (await call('/api/recipes')).body.recipes.find((r) => r.id === 'signin-codex-cli');
  ok(si.status === 200 && si.body.recipeId === 'signin-codex-cli' && rcp?.initCmd === 'codex login' && rcp.vendor === 'cli-manager', 'sign-in: an ordinary recipe whose command is the engine\'s own fixed argv', { si: si.body, initCmd: rcp?.initCmd });
  ok((await call('/api/agents/codex-cli/sign-in', { method: 'POST', json: { initCmd: 'rm -rf /' } })).body?.command === 'codex login' && (await call('/api/recipes')).body.recipes.find((r) => r.id === 'signin-codex-cli').initCmd === 'codex login', 'a request cannot change the command');
  ok((await call('/api/agents/nope/sign-in', { method: 'POST', json: {} })).status === 404 && (await call('/api/agents/codex-cli/sign-in', { method: 'POST', json: {}, as: 'bearer' })).status === 403, 'unknown vendor 404, agent 403');

  ok((await call('/api/panes/recipe%3Ax%231/sign-in-link', { as: 'bearer' })).status === 403, 'the sign-in link: an agent credential gets 403');
  ok((await call('/api/panes/recipe%3Ax%231/sign-in-link')).status === 404, '...and the person gets 404 when no pane shows one');
  ok((await call('/api/settings/auto-approve')).body.recipes.every((r) => typeof r.name === 'string' && r.name.length > 0), 'auto-approve rows carry the recipe NAME');
  console.log('\n[GET /api/sessions]');
  const ss = await call('/api/sessions');
  ok(ss.status === 200 && Array.isArray(ss.body.sessions), 'answers {sessions:[...]} to a signed-in caller', ss.body);
  ok((await fetch(`${BASE}/api/sessions`)).status === 401, 'unauthenticated: 401');
  const un = await fetch(`${BASE}/api/fs/dirs`);
  ok(un.status === 401, 'unauthenticated: 401', un.status);
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
