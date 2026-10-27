/* SCRATCHPAD NOTE EDIT ON THE PHONE: create a note through the Scratchpad's "+ New note",
 * close its editor, open the note from the list, tap Edit: the editor must open
 * (visible, focused-or-ready textarea with the note's text, ON TOP of the full-page
 * Scratchpad layer) and the Edit button must stay enabled. 390x844, touch, mobile.
 *   node test/room-scratchpad-edit-phone.probe.mjs [shotsdir]
 * A PROBE, not in `npm test`. Own scratch engine P(344), dead broker P(345), scrubbed env.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(344);
const DEAD_BROKER_PORT = P(345);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'probe-pad-edit-phone-token';
const SHOTS = process.argv[2] ?? join(REPO_ROOT, 'tmp-pad-edit-shots');
mkdirSync(SHOTS, { recursive: true });

let passes = 0;
let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (cond) { passes += 1; } else { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('unhandledRejection', (e) => ok(false, `unhandled: ${e?.stack ?? e}`));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) { return true; } } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}
function runTsx(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

/* the agent-share stand-in: upload (a send publishes the attachment here) + raw */
const shareFs = new Map();
let uploads = 0; // a note is never uploaded: this share is DOWN (every upload answers 500)
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'POST' && u.pathname === '/api/upload') {
    uploads++;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'share is down' }));
    return;
  }
  if (req.method === 'POST' && u.pathname === '/api/upload-never') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const dir = u.searchParams.get('dir') ?? '';
      if (!shareFs.has(dir)) { shareFs.set(dir, []); }
      const body = Buffer.concat(chunks);
      const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
      const headEnd = body.indexOf('\r\n\r\n');
      const name = /filename="([^"]*)"/.exec(body.subarray(0, headEnd).toString('utf8'))?.[1];
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      shareFs.get(dir).push({ name, bytes: body.subarray(headEnd + 4, end) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: [`${dir}/${name}`] }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => stub.listen(0, HOST, r));
const SHARE = `http://${HOST}:${stub.address().port}`;

for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-scratchpad-edit-phone.probe.mjs');
}
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-pad-edit-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let panel = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  await seed({
    recipes: [{ id: 'rec-lead', name: 'Lead', projectDir: '/srv/x/leadp', vendor: 'cli-manager', agent: 'leadp', color: '#0dab49' }],
    sessions: [{ paneid: 'recipe:rec-lead', recipe_id: 'rec-lead', vendor: 'cli-manager', agent: 'leadp', state: 'live' }],
  });
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: HOST,
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_CONFIG: join(tmpDir, 'config.json'),
      HARBOR_WB_AGENT_SHARE_URL: SHARE,
      HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'room-scratch'),
    }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  const up = await until(async () => (await fetch(`${BASE}/health`)).ok, 30000);
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  const cookie = await windowCookie(BASE, TOKEN);
  const api = async (path, { json, method, bearer } = {}) => {
    const m = method ?? (json !== undefined ? 'POST' : 'GET');
    const headers = bearer ? { authorization: `Bearer ${TOKEN}` } : { cookie };
    const init = { method: m, headers };
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await fetch(BASE + path, init);
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
  };
  /* the room + its seat come from the store seed (a seat needs a live broker
     session, which a dead-broker scratch engine cannot start); every note call
     below goes through the engine's own API */
  const seeded = await seed({ rooms: [{ name: 'Pad Edit', seats: [{ handle: 'leadp', recipe_id: 'rec-lead', occupant: 'recipe:rec-lead' }] }] });
  const R = seeded.rooms[0].id;
  ok(!!R, 'a room with one seat');
  const N = `/api/rooms/${R}/notes`;
  const listed = async () => (await api(N, { bearer: true })).body?.notes ?? [];
  const scratch = async () => (await api(`/api/rooms/${R}/scratch`)).body?.files ?? [];
  const rawOf = async (f) => (await fetch(BASE + f.raw, { headers: { cookie } })).text();

  browser = await chromium.launch({ headless: true });
  const login = async (ctx) => {
    await ctx.addCookies([{ name: 'wb_auth', value: cookie.split('wb_auth=')[1].split(';')[0], url: BASE }]);
  };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  await login(ctx);
  const page = await ctx.newPage();
  const errors = []; // (the Assets panel frame 405s: its app is not running here)
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/panels/')) { errors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); } });
  const roomUrl = `${BASE}/room.html?room=${R}`;
  const shot = (p, name) => p.screenshot({ path: join(SHOTS, `e2e-${name}.png`) });
  const open = async (p = page) => {
    await p.goto(roomUrl, { waitUntil: 'domcontentloaded' });
    await until(() => p.evaluate(() => document.getElementById('roomName').textContent !== 'Workroom'));
    await sleep(500); // the notes probe + the tray restore
  };
  const tiles = (p = page) => p.$$eval('#attTray .att-tile', (els) => els.map((e) => ({ cls: e.className, label: e.getAttribute('aria-label'), n: e.querySelector('.att-fn .n')?.textContent, s: e.querySelector('.att-fn .s')?.textContent, sr: e.querySelector('.att-sr')?.textContent, vis: [...e.childNodes].filter((c) => c.className !== 'att-sr' && c.className !== 'att-x').map((c) => c.textContent).join('') })));
  const menuPick = async (p, a) => {
    await p.click('#attBtn');
    await p.waitForSelector('.rsm-menu');
    await p.click(`.rsm-mi[data-a="${a}"]`);
  };
  await open();

  
  await open();
  const BODY = 'Pickled quince: boil with sugar and cloves.';
  await page.tap('#phAgents');
  await sleep(400);
  await page.tap('.ph-padrow[data-kind="notes"]');
  await page.waitForSelector('#preview .sp-add');
  await page.tap('#preview .sp-add');
  await page.waitForSelector('.nt-ta');
  await page.fill('.nt-ta', BODY);
  await sleep(1500); // autosave
  await page.tap('.nt-x');
  await until(async () => (await page.$('.nt-card')) === null);
  await until(async () => (await page.$$('#preview .sp-note')).length > 0);
  ok((await page.$$('#preview .sp-note')).length >= 1, 'the new note is listed in the Scratchpad');
  await page.tap('#preview .sp-note >> nth=0');
  await page.waitForSelector('#preview .sp-act');
  const edit = page.locator('#preview .sp-act', { hasText: 'Edit' });
  const state = () => edit.evaluate((b) => ({ disabled: b.disabled, aria: b.getAttribute('aria-disabled'), op: getComputedStyle(b).opacity, bg: getComputedStyle(b).backgroundColor }));
  const before = await state();
  ok(!before.disabled && before.aria === null, 'Edit is enabled before the tap', before);
  await edit.tap();
  const opened = await until(() => page.evaluate(() => { const t = document.querySelector('.nt-ta'); if (!t) { return false; } const r = t.getBoundingClientRect(); const cx = r.left + r.width / 2; const cy = r.top + Math.min(20, r.height / 2); const top = document.elementFromPoint(cx, cy); return r.width > 100 && r.height > 50 && (top === t || t.contains(top)); }), 4000);
  const info = await page.evaluate(() => { const t = document.querySelector('.nt-ta'); return t ? { value: t.value, card: document.querySelector('.nt-card')?.className } : null; });
  await shot(page, 'after-edit-tap');
  ok(opened, 'tapping Edit opens the editor ON TOP (the textarea is visible and hit-testable)', info);
  ok(info?.value === BODY, "the editor holds the note's text", info);
  const after = await state();
  ok(!after.disabled && after.aria === null, 'Edit is still enabled after the tap', after);
  ok(errors.length === 0, 'no page errors / failed responses', errors.slice(0, 4));
} catch (e) {
  ok(false, `probe aborted: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  if (engine && engine.exitCode === null) {
    const gone = new Promise((r) => engine.once('exit', r));
    engine.kill('SIGTERM');
    await Promise.race([gone, sleep(3000)]);
    if (engine.exitCode === null) { engine.kill('SIGKILL'); }
  }
  if (panel && panel.exitCode === null) {
    panel.kill('SIGTERM');
    await sleep(500);
    if (panel.exitCode === null) { panel.kill('SIGKILL'); }
  }
  stub.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(`\nPASS ${passes} FAIL ${failures}  (screenshots: ${SHOTS})`);
process.exit(failures ? 1 : 0);
