/* SETTINGS → APPS + THE APP'S STATUS IN THE ROOM [ticket, ticket, ticket].
 *
 *   node test/settings-apps.probe.mjs
 *
 * What only a browser can prove (desktop 1280x800), against FAKE tool apps:
 *   - a panel frame hears {host:'app-status', actions:'enabled', settingsUrl}
 *     on its action port right after the port, and again when the app is
 *     HELD (its tool.json changed) / approved / unregistered;
 *   - a held app's panel keeps drawing; the rail title bar wears "Needs
 *     approval ›" (and "Not registered ›" once unregistered), linking to
 *     /settings.html#apps; an action on it answers error 'needs-approval' /
 *     'not-registered' and reaches nothing;
 *   - {panel:'open-settings'} on the port (a click) and the badge both open
 *     Settings → Apps: a new window at /settings.html#apps on a page of its
 *     own, and inside the CLI Manager shell the Settings TAB at #apps (a
 *     second ask focuses it, never a second frame);
 *   - the room line shows the one notice fact per change;
 *   - Settings → Apps lists every app with its chip and rooms, shows a held
 *     app's permission change, Approves it, Registers a candidate, and
 *     Unregisters through an INLINE confirm (Cancel sends nothing; no
 *     window.confirm), then Registers it again; the #apps deep link lands on
 *     the group; no sideways scroll at 390px.
 *
 * Linux only: verifyEndpoint reads /proc, so off Linux no fake tool runs.
 * A PROBE, not in `npm test`. OWN scratch engine on P(282), DEAD broker
 * P(283); the fake apps take ephemeral ports. Temp table + tools dir,
 * childEnv() scrubbed, fabric + NATS off. Screenshots: SHOTS=<dir> keeps
 * them (otherwise they go with the temp dir).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(282);
const DEAD_BROKER_PORT = P(283);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-settings-apps-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 9000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn().catch(() => undefined);
    if (v) { return v; }
    await sleep(250);
  }
  return v;
}
if (process.platform !== 'linux') {
  console.log(`  skip  everything (${process.platform}: verifyEndpoint refuses every tool endpoint off Linux)`);
  process.exit(0);
}

let cookieP = null;
async function call(path, opts = {}) {
  const headers = { cookie: await (cookieP ??= windowCookie(BASE, TOKEN)) };
  const init = { method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'), headers };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'settings-apps.probe.mjs');
}

/* The page every fake panel serves: it records every host answer on its
   port, and three buttons send on the port (pin, open-settings). No
   backslash anywhere in it. */
const VIEW = '<!doctype html><title>v</title><p id="what">view</p>' +
  '<button id="pin">pin</button> <button id="set">settings</button><script>' +
  'var port = null; var heard = []; document.body.dataset.heard = "[]";' +
  'function note(d) { heard.push(d); document.body.dataset.heard = JSON.stringify(heard); }' +
  'window.addEventListener("message", function (e) {' +
  '  if (e.source !== parent || !e.data) return;' +
  '  if (e.data.host === "port" && e.ports && e.ports[0] && !port) { port = e.ports[0]; port.onmessage = function (m) { note(m.data); }; }' +
  '});' +
  'document.getElementById("pin").onclick = function () { port && port.postMessage({ panel: "action", name: "pin", params: { id: 7 } }); };' +
  'document.getElementById("set").onclick = function () { port && port.postMessage({ panel: "open-settings" }); };' +
  '</script>';

const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const calls = [];
const VIEW = ${JSON.stringify(VIEW)};
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const srv = createServer((req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__calls') return json(res, 200, calls);
  if (req.method === 'GET' && u.split('?')[0].endsWith('/view')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(VIEW); }
  calls.push({ method: req.method, url: u });
  return json(res, 200, { ok: true });
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  mkdirSync('status', { recursive: true });
  writeFileSync('status/app.json', JSON.stringify({ pid: process.pid, port }));
  console.log('READY ' + port);
});
`;
const children = [];
function startApp(stubPath, root) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [stubPath], { cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(proc);
    let out = '';
    let done = false;
    const t = setTimeout(() => !done && reject(new Error(`fake app in ${root} did not start: ${out}`)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /READY ([0-9]+)/.exec(out);
      if (m && !done) { done = true; clearTimeout(t); resolve({ proc, port: Number(m[1]) }); }
    });
    proc.stderr.on('data', (d) => (out += d));
  });
}
const callsOf = (a) => fetch(`http://127.0.0.1:${a.port}/__calls`).then((r) => r.json());

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-settings-apps-'));
const SHOTS = process.env.SHOTS || tmpDir;
const dbPath = join(tmpDir, 'mapping.db');
const toolsDir = join(tmpDir, 'tools');
const tool = (slug, name, extra = {}) => ({
  contract: 'tool/draft-0', name, slug, version: '0.1.0', description: `${name}: a probe app.`, access: 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  verbs: [{ name: 'pin', class: 'mutate', panel: true, call: { http: 'POST /rooms/:roomId/items/:id/pin' } }],
  panels: [{ title: name, icon: 'tasks', view: 'GET /rooms/:roomId/view', scripts: true }],
  ...extra,
});
function writeTool(slug, t) {
  const root = join(toolsDir, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tool.json'), JSON.stringify(t, null, 2));
  return root;
}
const ROOTS = {
  acts: writeTool('acts', tool('acts', 'Acts')),
  other: writeTool('other', tool('other', 'Other')),
  cand: writeTool('cand', tool('cand', 'Candidate')),
};
const STUB = join(tmpDir, 'fake-app.mjs');
writeFileSync(STUB, STUB_SRC);
const acts = await startApp(STUB, ROOTS.acts);
await startApp(STUB, ROOTS.other);

let engine = null;
let browser = null;
let engineLog = '';
try {
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_TOOLS_DIR: toolsDir, HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'scratch'),
    }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  }
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  const R = (await call('/api/rooms', { json: { name: 'Apps Room' } })).body.id;
  for (const slug of ['acts', 'other']) {
    const r = await call(`/api/apps/${slug}/register`, { json: {} });
    if (r.status !== 200) { throw new Error(`register ${slug}: ${JSON.stringify(r)}`); }
  }
  const a = await call(`/api/rooms/${R}/apps`, { json: { slug: 'acts' } });
  if (a.status !== 200) { throw new Error(`add acts: ${JSON.stringify(a)}`); }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  const h = await page.waitForSelector('.cell iframe[title="Acts"]', { state: 'attached', timeout: 8000 }).catch(() => null);
  const fActs = await h?.contentFrame();
  await fActs?.waitForSelector('#what', { timeout: 8000 }).catch(() => {});
  ok(!!fActs, 'the Acts panel frame is drawn');
  const heard = () => fActs.evaluate(() => JSON.parse(document.body.dataset.heard || '[]'));
  const statuses = async () => (await heard()).filter((m) => m.host === 'app-status').map((m) => m.actions);
  const badge = () => page.evaluate(() => {
    const b = document.querySelector('.cell[data-tone] .cell-hw .cell-badge');
    const c = b?.closest('.cell');
    return b ? { shown: !b.hidden, text: b.textContent, href: b.getAttribute('href'), color: getComputedStyle(b).color, tone: c?.dataset.tone, frames: c?.querySelectorAll('iframe').length } : null;
  });
  const factsOf = async () => ((await call(`/api/rooms/${R}/line?limit=500`)).body?.entries ?? []).filter((e) => e.kind === 'fact').map((e) => e.body);

  /* ---- 1. app-status right after the port ---- */
  const first = await until(async () => (await heard()).length && (await heard()));
  ok(first?.[0]?.host === 'app-status' && first[0].actions === 'enabled' && first[0].settingsUrl === '/settings.html#apps',
    "the panel's FIRST port message is {host:'app-status', actions:'enabled', settingsUrl:'/settings.html#apps'}", first?.[0]);
  let b = await badge();
  ok(b && !b.shown, 'a registered app: no title-bar badge', b);

  /* ---- 2. held: the file changes; the next read holds it ---- */
  writeFileSync(join(ROOTS.acts, 'tool.json'), JSON.stringify(tool('acts', 'Acts', { description: 'Changed.', verbs: [
    { name: 'pin', class: 'mutate', panel: true, call: { http: 'POST /rooms/:roomId/items/:id/pin' } },
    { name: 'wipe', class: 'mutate', panel: true, call: { http: 'POST /rooms/:roomId/wipe' } },
  ] }), null, 2));
  await call('/api/apps');
  const heldSeen = await until(async () => (await statuses()).includes('held'));
  ok(heldSeen, "held: the panel hears {host:'app-status', actions:'held'} on the same port", await statuses());
  b = await until(async () => { const x = await badge(); return x?.shown && x; });
  const tok = await page.evaluate(() => { const t = document.createElement('span'); document.body.append(t); t.style.color = 'var(--amber)'; const c = getComputedStyle(t).color; t.remove(); return c; });
  ok(b && b.text === 'Needs approval ›' && b.href === '/settings.html#apps' && b.color === tok && b.frames === 1,
    'the rail title bar wears "Needs approval ›" (amber) -> /settings.html#apps, and the panel still draws', b);
  const toneKept = await page.evaluate(() => getComputedStyle(document.querySelector('.cell[data-tone] > .cell-hw .cell-h .tt')).color);
  ok(!!b?.tone && toneKept !== tok, 'the cell keeps its ticket tone (title ink is not the badge amber)', { tone: b?.tone, toneKept });
  await page.screenshot({ path: join(SHOTS, 'settings-apps-rail-badge.png'), clip: { x: 0, y: 0, width: 420, height: 400 } });
  let n0 = (await callsOf(acts)).length;
  await fActs.click('#pin');
  const res1 = await until(async () => (await heard()).find((m) => m.host === 'action-result'));
  ok(res1 && res1.ok === false && res1.error === 'needs-approval', "an action on the held app: {host:'action-result', ok:false, error:'needs-approval'}", res1);
  ok((await callsOf(acts)).length === n0, '...and nothing reached the app');
  const f1 = await factsOf();
  ok(f1.filter((x) => x === 'Acts is waiting for your approval · Settings → Apps').length === 1, 'the room line: ONE "Acts is waiting for your approval · Settings → Apps"', f1.slice(-4));
  const lineShown = await until(() => page.evaluate(() => [...document.querySelectorAll('body *')].some((e) => e.children.length === 0 && /Acts is waiting for your approval/.test(e.textContent))));
  ok(lineShown, '...shown on the room page');

  /* ---- 3. open Settings from the port (a click) and from the badge: a new window here ---- */
  let [pop] = await Promise.all([page.waitForEvent('popup', { timeout: 6000 }).catch(() => null), fActs.click('#set')]);
  ok(!!pop && /\/settings\.html#apps$/.test(pop.url()), "{panel:'open-settings'} on the port (a click) opens /settings.html#apps", pop?.url());
  await pop?.close().catch(() => {});
  [pop] = await Promise.all([page.waitForEvent('popup', { timeout: 6000 }).catch(() => null), page.click('.cell-badge:not([hidden])')]);
  ok(!!pop && /\/settings\.html#apps$/.test(pop.url()), 'the badge opens /settings.html#apps', pop?.url());
  await pop?.close().catch(() => {});
  /* no click: an open-settings sent from a timer 7 s later is ignored */
  await fActs.evaluate(() => setTimeout(() => document.getElementById('set').onclick(), 7000));
  const late = await page.waitForEvent('popup', { timeout: 9000 }).catch(() => null);
  ok(!late, 'without a click, open-settings is ignored', late?.url());
  await late?.close().catch(() => {});

  /* ---- 4. Settings → Apps ---- */
  const sp = await context.newPage();
  sp.on('pageerror', (e) => errors.push(`settings: ${e}`));
  sp.on('dialog', (d) => { errors.push(`settings dialog: ${d.message()}`); void d.dismiss(); });
  await sp.goto(`${BASE}/settings.html#apps`, { waitUntil: 'domcontentloaded' });
  await sp.waitForSelector('section[data-group="apps"][data-state="mounted"] .sa-app', { timeout: 9000 }).catch(() => {});
  await sleep(300);
  const readSettings = () => sp.evaluate(() => ({
    rows: Object.fromEntries([...document.querySelectorAll('#apps .sa-app')].map((r) => [r.dataset.slug, {
      state: r.dataset.state, chip: r.querySelector('.app-chip')?.textContent, rooms: r.querySelector('.sa-rooms')?.textContent,
      diff: [...r.querySelectorAll('.sa-dl li')].map((l) => l.textContent), btns: [...r.querySelectorAll('.sa-acts button')].map((x) => x.textContent),
      msg: r.querySelector('.pv-msg')?.textContent || '', confirm: r.querySelector('.sa-confirm .sa-q')?.textContent || '',
    }])),
    top: Math.round(document.getElementById('apps')?.getBoundingClientRect().top ?? -1),
    atEnd: Math.ceil(scrollY) >= document.documentElement.scrollHeight - innerHeight - 1,
    scrolled: scrollY > 0,
    title: document.querySelector('#apps h4')?.textContent,
  }));
  let S = await readSettings();
  ok(S.title === 'Apps' && S.top >= 0 && (S.top < 120 || (S.atEnd && S.scrolled)), 'Settings has an "Apps" group, and #apps lands on it (at the top, or as far as the page scrolls)', { title: S.title, top: S.top, atEnd: S.atEnd, scrolled: S.scrolled });
  ok(S.rows.acts?.chip === 'Needs approval' && S.rows.acts.rooms === 'In "Apps Room"' && S.rows.acts.btns.join() === 'Approve,Unregister',
    'a held app: "Needs approval", its room, Approve + Unregister', S.rows.acts);
  ok(S.rows.acts?.diff.includes("Its panel's buttons may now trigger \"wipe\"") && S.rows.acts.diff.some((x) => /New action "wipe"/.test(x)), '...with the permission change shown (the + sheet\'s old words)', S.rows.acts?.diff);
  ok(S.rows.other?.chip === 'Registered' && S.rows.other.rooms === 'Not in any room' && S.rows.other.btns.join() === 'Unregister', 'a registered app: "Registered", Unregister', S.rows.other);
  ok(S.rows.cand?.chip === 'Not registered' && S.rows.cand.btns.join() === 'Register', 'a candidate folder: "Not registered", Register', S.rows.cand);
  await sp.screenshot({ path: join(SHOTS, 'settings-apps-1280.png'), fullPage: true });

  await sp.click('#apps [data-act="approve-acts"]');
  await until(async () => (await readSettings()).rows.acts?.state === 'registered');
  S = await readSettings();
  ok(S.rows.acts?.chip === 'Registered' && /Approved/.test(S.rows.acts.msg), 'Approve: Registered, said on the row', S.rows.acts);
  ok(await until(async () => (await statuses()).at(-1) === 'enabled'), "the room's panel hears actions:'enabled' again", await statuses());
  ok(await until(async () => { const x = await badge(); return x && !x.shown; }), '...and the badge goes');
  ok((await factsOf()).includes('Acts was approved; its actions now work'), 'the room line: "Acts was approved; its actions now work"');

  await sp.click('#apps [data-act="register-cand"]');
  await until(async () => (await readSettings()).rows.cand?.state === 'registered');
  ok((await readSettings()).rows.cand?.chip === 'Registered', 'Register a candidate: Registered');

  /* unregister: an inline confirm; Cancel sends nothing */
  await sp.click('#apps [data-act="unregister-acts"]');
  S = await readSettings();
  ok(/^Unregister Acts\? Its actions stop in 1 room; it stays in their rails\./.test(S.rows.acts?.confirm) && S.rows.acts.btns.join() === 'Cancel,Unregister',
    'Unregister asks INLINE on the row (no window.confirm): Cancel / Unregister', S.rows.acts);
  await sp.click('#apps [data-act="cancel-acts"]');
  await sleep(300);
  ok((await call('/api/apps')).body.apps.find((x) => x.slug === 'acts')?.state === 'registered', 'Cancel: still registered, nothing sent');
  await sp.click('#apps [data-act="unregister-acts"]');
  await sp.click('#apps [data-act="confirm-acts"]');
  await until(async () => (await readSettings()).rows.acts?.state === 'unregistered-candidate');
  S = await readSettings();
  ok(S.rows.acts?.chip === 'Not registered' && S.rows.acts.btns.join() === 'Register again' && S.rows.acts.rooms === 'In "Apps Room"',
    'Unregister: "Not registered", still in its room, "Register again"', S.rows.acts);
  ok(await until(async () => (await statuses()).at(-1) === 'unregistered'), "the panel hears actions:'unregistered'", await statuses());
  b = await until(async () => { const x = await badge(); return x?.shown && x.text === 'Not registered ›' && x; });
  ok(!!b, 'the badge says "Not registered ›"', b);
  const before = (await heard()).filter((m) => m.host === 'action-result').length;
  n0 = (await callsOf(acts)).length;
  await fActs.click('#pin');
  const res2 = await until(async () => { const r = (await heard()).filter((m) => m.host === 'action-result'); return r.length > before && r.at(-1); });
  ok(res2 && res2.ok === false && res2.error === 'not-registered', "an action now: error 'not-registered'", res2);
  ok((await callsOf(acts)).length === n0, '...nothing reached the app');
  ok((await factsOf()).includes('Acts is not registered · Settings → Apps'), 'the room line: "Acts is not registered · Settings → Apps"');
  await sp.click('#apps [data-act="register-acts"]');
  await until(async () => (await readSettings()).rows.acts?.state === 'registered');
  ok((await readSettings()).rows.acts?.chip === 'Registered', 'Register again (file unchanged since its approval): Registered');
  ok(await until(async () => (await statuses()).at(-1) === 'enabled'), "the panel hears actions:'enabled'");

  /* phone width: no sideways scroll */
  await sp.setViewportSize({ width: 390, height: 800 });
  await sleep(300);
  const wide = await sp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(wide <= 0, 'Settings → Apps at 390px: no sideways scroll', wide);
  await sp.screenshot({ path: join(SHOTS, 'settings-apps-390.png'), fullPage: true });
  await sp.close();

  /* ---- 5. inside the CLI Manager shell: the Settings TAB at #apps ---- */
  await call('/api/apps/acts/unregister', { json: {} });
  await page.goto(`${BASE}/app/shell.html?kind=manager&debug=1&tabs=${encodeURIComponent(`/room.html?room=${R}`)}`, { waitUntil: 'domcontentloaded' });
  const roomFrame = await until(async () => page.frames().find((f) => /\/room\.html/.test(f.url())));
  await roomFrame?.waitForSelector('.cell-badge:not([hidden])', { timeout: 9000 }).catch(() => {});
  const frames = () => page.evaluate(() => [...document.querySelectorAll('#stage iframe')].map((f) => ({ src: f.getAttribute('src'), shown: f.style.display !== 'none' })));
  const n1 = (await frames()).length;
  await roomFrame?.click('.cell-badge:not([hidden])');
  const st = await until(async () => { const fr = await frames(); const s = fr.filter((f) => /\/settings\.html/.test(f.src)); return s.length && fr; });
  const sTabs = (st || []).filter((f) => /\/settings\.html/.test(f.src));
  ok(sTabs.length === 1 && sTabs[0].shown && /#apps$/.test(sTabs[0].src) && st.length === n1 + 1, 'in the shell, the badge opens Settings as a TAB at #apps', st);
  await page.evaluate(() => document.querySelector('.hwb-tab[data-tab]:not(.is-active)')?.click());
  await sleep(300);
  const pf = await roomFrame?.waitForSelector('.cell iframe[title="Acts"]', { state: 'attached', timeout: 8000 }).then((x) => x.contentFrame()).catch(() => null);
  await pf?.waitForSelector('#set', { timeout: 8000 }).catch(() => {});
  await pf?.click('#set');
  await sleep(800);
  const fr2 = await frames();
  const s2 = fr2.filter((f) => /\/settings\.html/.test(f.src));
  ok(s2.length === 1 && s2[0].shown && fr2.length === n1 + 1, "...and a panel's open-settings focuses that tab (never a second frame)", fr2);

  ok(errors.length === 0, 'no page errors, no dialogs', errors.slice(0, 3));
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
  if (engine) {
    engine.kill('SIGTERM');
    await sleep(400);
    try { engine.kill('SIGKILL'); } catch { /* gone */ }
  }
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nsettings-apps.probe: PASS' : `\nsettings-apps.probe: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
