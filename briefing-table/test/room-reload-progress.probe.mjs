/* THE SEAT RELOAD CARD SHOWS PROGRESS AND RESOLVES ITSELF [reload progress]  node test/room-reload-progress.probe.mjs   Owner 2026-10-06
 * (phone: after Reload the card just sat there with no way to close it; the reload had gone through). The real room page at 390
 * against a scratch engine (dead broker, temp table, never a live pane). The POST .../reload is HELD in the browser (the answer
 * never comes), and the room's own facts / seats are changed straight in the temp db, as a real reload would.
 *   progress: "Reloading @handle…", a 44px X and Close (the Reload button is gone), the request sent exactly once;
 *   closing (X, Close, tap outside) never cancels it; STILL WAITING after the window; the card closes ITSELF with a toast when
 *   (a) the "re-added" fact appears, (b) the seat's occupant changes; a LATE HTTP answer after a close still toasts. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(406);
const DEAD = P(407);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-reload-progress-token';
const SHOTS = process.env.IPAD_SHOTS || tmpdir();
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
await assertFree(PORT, 'room-reload-progress.probe.mjs');
await assertFree(DEAD, 'room-reload-progress.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-reload-progress-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode' }) });
  engine.stdout.on('data', (d) => (log += d)); engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, 'scratch engine up', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }
  const R = (await seed({ sessions: [{ paneid: 'recipe:rec-a', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'awake', state: 'live' }],
    rooms: [{ name: 'Reloading', seats: [{ handle: 'awake', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }] }] })).rooms[0].id;
  const { default: Database } = await import('better-sqlite3');
  const dbDo = (fn) => { const db = new Database(dbPath); try { return fn(db); } finally { db.close(); } };
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => { window.HWB_RELOAD_STILL_MS = 3000; });
  const errs = [];
  const loginPg = await ctx.newPage();
  await loginPg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await loginPg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([loginPg.waitForNavigation().catch(() => {}), loginPg.click('form button:visible')]);
  await loginPg.close();
  const posts = [];
  const held = [];
  /* open the room, hold the reload POST, open the card and press Reload */
  const pressReload = async () => {
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.route('**/seats/*/reload', async (route) => {
      if (route.request().method() === 'POST') { posts.push(route.request().url()); held.push(route); return; }
      await route.continue();
    });
    await pg.goto(`${BASE}/room.html?room=${R}&shell=0`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('.ph-hdr', { state: 'attached' });
    await sleep(1200);
    await pg.tap('#phAgents');
    await pg.waitForSelector('#phSheet:not([hidden]) .seat[data-handle="awake"] .rsm-more');
    await pg.tap('#phSheet .seat[data-handle="awake"] .rsm-more');
    await pg.waitForSelector('.rsm-menu');
    await pg.locator('.rsm-mi', { hasText: 'Reload from project defaults' }).tap();
    await pg.waitForSelector('.rsm-card .ft button[data-a="reload"]:not([disabled])', { timeout: 10000 });
    await pg.locator('.rsm-card .ft button[data-a="reload"]').tap();
    await pg.waitForSelector('.rsm-prog', { timeout: 4000 });
    return pg;
  };
  const cardGone = (pg, ms = 9000) => pg.waitForSelector('.rsm-dscrim', { state: 'detached', timeout: ms }).then(() => true).catch(() => false);
  const toast = (pg, ms = 4000) => pg.waitForFunction(() => [...document.querySelectorAll('.rm-toast .tx')].some((t) => /Reloaded @awake/.test(t.textContent)), null, { timeout: ms }).then(() => true).catch(() => false);

  /* ---- progress, Close, and "closing never cancels" + a late HTTP answer ---- */
  let pg = await pressReload();
  const st = await pg.evaluate(() => ({
    head: document.querySelector('.rsm-card .hd').textContent.replace(/\s+/g, ' ').trim(),
    reload: !!document.querySelector('.rsm-card .ft button[data-a="reload"]'),
    x: (() => { const b = document.querySelector('.rsm-xclose'); const r = b?.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null; })(),
    close: document.querySelector('.rsm-card .ft button')?.textContent,
    closeOff: document.querySelector('.rsm-card .ft button')?.disabled,
  }));
  ok(/^Reloading @awake/.test(st.head) && !st.reload && st.x && st.x.w >= 44 && st.x.h >= 44 && st.close === 'Close' && st.closeOff === false, 'progress: "Reloading @awake…", the X is 44px, Close is enabled, the Reload button is gone', st);
  ok(posts.length === 1, 'progress: the request was sent exactly once', posts.length);
  await pg.screenshot({ path: join(SHOTS, 'reload-progress.png') });
  await pg.tap('.rsm-xclose');
  ok(await cardGone(pg, 3000), 'the X closes the card');
  ok(posts.length === 1 && held.length === 1, 'closing never cancels: still ONE request, still held', posts.length);
  await held[0].fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, rooms: [{ roomId: R, result: 'reloaded' }], welcome: 'sent' }) });
  ok(await toast(pg), 'a LATE HTTP answer after the card was closed still toasts "Reloaded @awake"');
  await pg.close();

  /* ---- still waiting, then closable (tap outside) ---- */
  pg = await pressReload();
  await sleep(4500);
  const still = await pg.evaluate(() => document.querySelector('.rsm-prog')?.textContent ?? '');
  ok(/^Still waiting: the seat may have reloaded/.test(still), 'after the wait window with nothing: "Still waiting: the seat may have reloaded…"', still);
  await pg.mouse.click(8, 8); // tap outside the card (the scrim)
  ok(await cardGone(pg, 3000), 'tap outside closes it (still closable)');
  await pg.close();

  /* ---- (a) the "re-added" fact resolves it ---- */
  pg = await pressReload();
  dbDo((db) => db.prepare('INSERT INTO room_line (room_id, ts, kind, author, author_seat, target, target_seat, thread, body, ref, meta) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL)')
    .run(R, Date.now(), 'fact', 'room', '@awake re-added from project defaults (opus high); previous session x (restorable)'));
  ok(await cardGone(pg, 9000), '(a) the "re-added" fact closes the card by itself');
  ok(await toast(pg), '(a) ...with a "Reloaded @awake" toast');
  await pg.close();

  /* ---- (b) the seat's occupant changing resolves it ---- */
  pg = await pressReload();
  await seed({ sessions: [{ paneid: 'recipe:rec-a-new', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'awake', state: 'live' }] }); // the NEW session a real reload launches
  dbDo((db) => db.prepare(`UPDATE room_seats SET occupant='recipe:rec-a-new' WHERE room_id=? AND handle='awake'`).run(R));
  ok(await cardGone(pg, 9000), '(b) the seat\'s occupant changing closes the card by itself');
  ok(await toast(pg), '(b) ...with a "Reloaded @awake" toast');
  await pg.close();
  ok(errs.length === 0, 'no page errors', errs.slice(0, 2));
} catch (e) {
  failures += 1; console.log(` FAIL ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  engine?.kill('SIGKILL');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM on Windows */ }
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
