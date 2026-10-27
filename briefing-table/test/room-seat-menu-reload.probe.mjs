/* THE SEAT MENU'S "Reload from project defaults…" (ticket, Owner 2026-10-01).
 *
 *   node test/room-seat-menu-reload.probe.mjs
 *
 * What only a browser can prove:
 *   - the dialog previews the REAL recipe defaults (model/effort) and the
 *     prior work slug via the real GET .../reload route (a DEAD broker still
 *     answers it honestly — the preview is read-only and needs no pty);
 *   - when the pane also seats another OPEN room, the dialog lists it
 *     ("Also seated in: …");
 *   - a mid-turn preview shows the refusal + a "reload anyway" checkbox that
 *     gates the Reload button;
 *   - Cancel closes the dialog and calls nothing;
 *   - a successful POST (stubbed — a dead broker cannot really end/launch a
 *     pty) closes the dialog and shows a toast naming every reloaded room.
 *
 * A PROBE, not in `npm test`. Own scratch engine + DEAD broker, a temp table
 * seeded through the store (test/rooms-routes.seed.ts): never Owner's data.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(319);
const DEAD_BROKER_PORT = P(320);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-seat-menu-reload-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookieP = null;
const userCookie = () => (cookieP ??= windowCookie(BASE, TOKEN));
async function call(path, opts = {}) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  const headers = roomUserWrite(path, method, opts.json) ? { cookie: await userCookie() } : { authorization: `Bearer ${TOKEN}` };
  const init = { method, headers };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
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

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-seat-menu-reload.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-seat-reload-menu-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) throw new Error(`seed failed: ${r.err}`);
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  await seed({
    recipes: [{ id: 'rec-rl', name: 'Reloadable', projectDir: `${tmpDir}/rl`, vendor: 'claude-code', agent: 'reloadable', model: 'opus', effort: 'high' }],
  });

  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_NODE: 'testnode',
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
  if (!up) throw new Error('engine never came up');

  const PANE = 'recipe:rec-rl';
  const live = (paneid, rid, agent) => ({ paneid, recipe_id: rid, vendor: 'claude-code', agent, state: 'live' });
  const post = await seed({
    sessions: [live(PANE, 'rec-rl', 'reloadable')],
    rooms: [
      { name: 'Reload Probe Room', seats: [{ handle: 'agent', recipe_id: 'rec-rl', occupant: PANE }] },
      { name: 'Reload Probe Second Room', seats: [{ handle: 'buddy', recipe_id: 'rec-rl', occupant: PANE }] },
    ],
  });
  const R = post.rooms[0].id;
  const R2 = post.rooms[1].id;
  const SEAT = post.rooms[0].seats.agent;

  /* THE REAL ROUTE on this engine: the preview is read-only and answers
   * honestly even with a dead broker. */
  const realPreview = await call(`/api/rooms/${R}/seats/${SEAT}/reload`);
  ok(realPreview.status === 200 && realPreview.body?.recipe?.name === 'Reloadable' && realPreview.body?.recipe?.model === 'opus' && realPreview.body?.recipe?.effort === 'high',
    'engine: GET .../reload previews the real recipe defaults', realPreview.body);
  ok(Array.isArray(realPreview.body?.otherRooms) && realPreview.body.otherRooms.length === 1 && realPreview.body.otherRooms[0].roomName === 'Reload Probe Second Room' && realPreview.body.otherRooms[0].handle === 'buddy',
    'engine: the preview lists the OTHER open room the same pane seats', realPreview.body?.otherRooms);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .seat[data-handle="agent"]');
  await sleep(800);

  const row = '#roster .seat[data-handle="agent"]';
  const dialogText = () => page.evaluate(() => {
    const c = document.querySelector('.rsm-card');
    if (!c) return null;
    return {
      title: c.querySelector('.hd')?.textContent,
      items: [...c.querySelectorAll('.bd li')].map((l) => l.textContent),
      yesDisabled: c.querySelector('.ft button[data-a="reload"]')?.disabled,
      /* two checkboxes can appear ("open a tab…" is unconditional) — the
         force one is the only one that says "reload anyway" */
      hasForce: [...c.querySelectorAll('.rsm-check')].some((l) => /reload anyway/.test(l.textContent ?? '')),
    };
  });

  /* 1. open the menu, click Reload */
  await page.click(`${row} .seat-handle`, { button: 'right' });
  const reloadItem = await page.evaluate(() => {
    const b = document.querySelector('.rsm-mi[data-a="reload"]');
    return b ? { label: [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''), off: b.getAttribute('aria-disabled') === 'true' } : null;
  });
  ok(reloadItem && reloadItem.label === 'Reload from project defaults…' && !reloadItem.off, 'the menu offers "Reload from project defaults…", enabled on a live seat', reloadItem);
  await page.click('.rsm-mi[data-a="reload"]');
  await sleep(500); // the preview fetch

  let d = await dialogText();
  ok(d && d.title === 'Reload @agent from project defaults?', 'the dialog title names the seat', d?.title);
  ok(d && d.items.some((t) => /Reloadable/.test(t) && /opus/.test(t) && /high/.test(t)), 'it quotes the REAL recipe name + model + effort', d?.items);
  ok(d && d.items.some((t) => /Also seated in: Reload Probe Second Room \(@buddy\)/.test(t)), 'it lists the OTHER room (multi-room check)', d?.items);
  ok(d && !d.hasForce && d.yesDisabled === false, 'not mid-turn: no force checkbox, Reload is enabled', d);

  /* 2. Cancel closes it and calls nothing destructive */
  let posted = false;
  await page.route('**/seats/**/reload', async (r2) => {
    if (r2.request().method() === 'POST') posted = true;
    await r2.continue();
  });
  await page.keyboard.press('Escape');
  await sleep(200);
  ok(!(await page.$('.rsm-card')), 'Esc/Cancel closes the dialog');
  ok(!posted, '...and POSTs nothing', posted);

  /* 3. a mid-turn preview: the force checkbox gates the Reload button */
  await page.unroute('**/seats/**/reload');
  await page.route(`**/api/rooms/${R}/seats/${SEAT}/reload`, async (r2) => {
    if (r2.request().method() !== 'GET') return r2.continue();
    await r2.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ seat: SEAT, handle: 'agent', paneid: PANE, live: true, busy: true, priorSlug: 'reloadable-abc123', recipe: { id: 'rec-rl', name: 'Reloadable', model: 'opus', effort: 'high' }, otherRooms: [] }),
    });
  });
  await page.click(`${row} .seat-handle`, { button: 'right' });
  await page.click('.rsm-mi[data-a="reload"]');
  await sleep(400);
  d = await dialogText();
  ok(d && d.hasForce && d.yesDisabled === true, 'mid-turn: the "reload anyway" checkbox appears and Reload starts disabled', d);
  await page.check('.rsm-check input');
  d = await dialogText();
  ok(d && d.yesDisabled === false, '...ticking it enables Reload', d);
  await page.keyboard.press('Escape');
  await sleep(200);

  /* 4. a stubbed success: the dialog closes and a toast names the rooms */
  await page.route(`**/api/rooms/${R}/seats/${SEAT}/reload`, async (r2) => {
    if (r2.request().method() === 'GET') {
      return r2.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seat: SEAT, handle: 'agent', paneid: PANE, live: true, busy: false, priorSlug: 'reloadable-abc123', recipe: { id: 'rec-rl', name: 'Reloadable', model: 'opus', effort: 'high' }, otherRooms: [] }) });
    }
    return r2.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, newPaneid: 'recipe:rec-rl#deadbeef', oldPaneid: PANE, recipe: { id: 'rec-rl', name: 'Reloadable' }, rooms: [{ roomId: R, roomName: 'Reload Probe Room', oldSeatId: SEAT, handle: 'agent', lead: true, newSeatId: 'new-seat-1', result: 'reloaded' }], welcome: 'sent' }),
    });
  });
  await page.click(`${row} .seat-handle`, { button: 'right' });
  await page.click('.rsm-mi[data-a="reload"]');
  await sleep(400);
  await page.click('.ft button[data-a="reload"]');
  await sleep(400);
  ok(!(await page.$('.rsm-card')), 'a successful reload closes the dialog');
  const toast = await page.evaluate(() => document.querySelector('.rm-toast')?.textContent ?? null);
  ok(!!toast && /@agent reloaded from project defaults/.test(toast), 'a toast confirms the reload', toast);

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  engine?.kill('SIGKILL');
  await sleep(300);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
