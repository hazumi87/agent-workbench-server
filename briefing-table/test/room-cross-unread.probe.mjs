/* THE CROSS-FAMILY UNREAD ALERT [cross unread]  node test/room-cross-unread.probe.mjs   Owner 2026-10-06
 * The real room page against a scratch engine (dead broker, temp table, never a live pane); agent lines are written straight
 * into the temp db. Three separate main rooms (three families): Alpha is on screen, Beta and Gamma are elsewhere.
 *   PHONE 390: one room has a new line -> "1 new"; Beta gets 2 more -> "3 new in 2 rooms"; View opens a MENU of the waiting rooms with
 *     their badges (newest first; one room waiting goes straight there) [notice menu]; the X hides the strip until a NEWER line arrives, then it returns ("4 new in 2 rooms"); a line
 *     in the room on screen never counts; the first look raised nothing.
 *   PC 1280: a toast "New in <names>" (newest first), View opens the same menu (a popover).
 *   GET /api/rooms/me/unread answers every open room. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(402);
const DEAD = P(403);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-cross-unread-token';
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
await assertFree(PORT, 'room-cross-unread.probe.mjs');
await assertFree(DEAD, 'room-cross-unread.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-cross-unread-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }, { id: 'rec-b', name: 'Bravo', projectDir: '/srv/x/bravo', vendor: 'claude-code', agent: 'bravo', color: '#1f5fbf' }] });
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
  const plan = await seed({ rooms: ['Alpha', 'Beta', 'Gamma'].map((name) => ({ name, seats: [{ handle: 'awake', recipe_id: 'rec-a' }, { handle: 'bravo', recipe_id: 'rec-b' }] })) });
  const rooms = Object.fromEntries(plan.rooms.map((r) => [r.name, r]));
  const { default: Database } = await import('better-sqlite3');
  const say = (room, text) => {
    const db = new Database(dbPath);
    const info = db.prepare('INSERT INTO room_line (room_id, ts, kind, author, author_seat, target, target_seat, thread, body, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)')
      .run(room.id, Date.now(), 'chat', 'awake', room.seats.awake, 'bravo', room.seats.bravo, text);
    db.close();
    return Number(info.lastInsertRowid);
  };
  browser = await chromium.launch({ headless: true });
  const login = async (ctx) => {
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    return pg;
  };
  const strip = (pg) => pg.evaluate(() => { const n = document.querySelector('.wg-notice'); return n ? { text: n.querySelector('.tx').textContent, view: !!n.querySelector('.vw'), x: !!n.querySelector('.x') } : null; });
  const waitFor = async (fn, ms = 9000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) { return v; } if (Date.now() - t0 > ms) { return null; } await sleep(300); } };
  const settle = () => sleep(3200); // a poll is 2.5 s

  /* ---------------- PHONE ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
    const pg = await login(ctx);
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    const cookie = (await ctx.cookies()).map((x) => `${x.name}=${x.value}`).join('; ');
    const api = await fetch(`${BASE}/api/rooms/me/unread`, { headers: { cookie } });
    const body = await api.json();
    ok(api.status === 200 && Array.isArray(body.rooms) && body.rooms.length === 3 && body.rooms.every((r) => ['roomId', 'name', 'familyHeadId', 'unread', 'newestId', 'color'].every((k) => k in r)), 'GET /api/rooms/me/unread: every open room, with the documented fields', body.rooms?.length);
    await pg.goto(`${BASE}/room.html?room=${rooms.Alpha.id}&shell=0`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('.ph-hdr', { state: 'attached' });
    await settle();
    ok((await strip(pg)) === null, 'phone: the first look raised nothing (no strip)');
    say(rooms.Alpha, 'a line in the room on screen');
    await settle();
    ok((await strip(pg)) === null, 'phone: a line in the room ON SCREEN never counts');
    const g1 = say(rooms.Gamma, 'gamma one');
    const s1 = await waitFor(() => strip(pg));
    ok(s1?.text === '1 new' && s1.view && s1.x, 'phone: one room with one new line -> "1 new" (count only, View, X)', s1);
    say(rooms.Beta, 'beta one');
    const b2 = say(rooms.Beta, 'beta two');
    const s2 = await waitFor(async () => { const s = await strip(pg); return s?.text === '3 new in 2 rooms' ? s : null; });
    ok(!!s2, 'phone: two rooms, in another family each -> "3 new in 2 rooms"', await strip(pg));
    await pg.screenshot({ path: join(SHOTS, 'cross-unread-390.png') });
    await pg.tap('.wg-notice .vw');
    await pg.waitForSelector('.rsm-menu.is-sheet .rsm-mi', { timeout: 4000 }).catch(() => {});
    const menu = await pg.evaluate(() => { const m = document.querySelector('.rsm-menu'); return m ? { sheet: m.classList.contains('is-sheet'), title: m.querySelector('.rsm-mt')?.textContent ?? '', rows: [...m.querySelectorAll('.rsm-mi')].map((b) => ({ name: b.textContent.replace(b.querySelector('.rsm-sub')?.textContent ?? '', '').trim(), badge: b.querySelector('.rsm-sub')?.textContent ?? '', plate: !!b.querySelector('.sub-plate'), h: Math.round(b.getBoundingClientRect().height) })) } : null; });
    ok(menu?.sheet && /3 new in 2 rooms/.test(menu.title) && menu.rows.length === 2 && menu.rows[0].name === 'Beta' && menu.rows[0].badge === '2' && menu.rows[1].name === 'Gamma' && menu.rows[1].badge === '1' && menu.rows.every((r) => r.plate && r.h >= 44), 'phone: View opens a menu that folds up from the notice: Beta (2) then Gamma (1), newest first, each with its plate and badge', menu);
    await pg.screenshot({ path: join(SHOTS, 'cross-unread-menu-390.png') });
    await pg.tap('.rsm-scrim', { position: { x: 10, y: 10 } });
    await sleep(300);
    ok((await pg.evaluate(() => !document.querySelector('.rsm-menu'))) && pg.url().includes(`room=${rooms.Alpha.id}`), 'phone: tapping outside closes the menu and goes nowhere');
    const geo = await pg.evaluate(() => { const n = document.querySelector('.wg-notice'); const r = n.getBoundingClientRect(); const vw = n.querySelector('.vw').getBoundingClientRect(); const x = n.querySelector('.x').getBoundingClientRect(); const tx = n.querySelector('.tx').getBoundingClientRect(); return { w: Math.round(r.width), vw: Math.round(vw.width), xw: Math.round(x.width), tx: Math.round(tx.width), sw: document.documentElement.scrollWidth, iw: innerWidth }; });
    ok(geo.vw <= 90 && geo.xw === 32 && geo.tx > geo.w * 0.5 && geo.sw <= geo.iw, 'phone: View sized to its content, the X a 32px target, the text takes the rest, no sideways scroll', geo);
    await pg.click('.wg-notice .x');
    await sleep(300);
    ok((await strip(pg)) === null, 'phone: the X hides the strip');
    await settle();
    ok((await strip(pg)) === null, '...and it stays hidden while nothing newer arrives');
    const g2 = say(rooms.Gamma, 'gamma two (newer than the dismissal)');
    const s3 = await waitFor(async () => { const s = await strip(pg); return s?.text === '4 new in 2 rooms' ? s : null; });
    ok(!!s3, 'phone: a NEWER line brings it back ("4 new in 2 rooms")', await strip(pg));
    await pg.tap('.wg-notice .vw');
    await pg.waitForSelector('.rsm-menu .rsm-mi', { timeout: 4000 });
    ok((await pg.evaluate(() => document.querySelector('.rsm-menu .rsm-mi')?.textContent ?? '')).startsWith('Gamma'), 'phone: the newest room (Gamma, now holding the newest line) is first in the menu');
    await pg.tap('.rsm-menu .rsm-mi');
    await pg.waitForURL(new RegExp(`room=${rooms.Gamma.id}`), { timeout: 8000 }).catch(() => {});
    ok(pg.url().includes(`room=${rooms.Gamma.id}`), 'phone: choosing a room opens it (Gamma, across families)', pg.url());
    ok(errs.length === 0, 'phone: no page errors', errs.slice(0, 2));
    void g1; void b2; void g2;
    await ctx.close();
  }

  /* ---------------- PC ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const pg = await login(ctx);
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/room.html?room=${rooms.Alpha.id}&shell=0`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('#roster', { state: 'attached' });
    await settle();
    ok((await pg.evaluate(() => document.querySelectorAll('.rm-toast').length)) === 0 && (await strip(pg)) === null, 'PC: the first look raised nothing, and there is no phone strip');
    say(rooms.Beta, 'pc beta');
    await sleep(600);
    say(rooms.Gamma, 'pc gamma (newest)');
    const toast = await waitFor(() => pg.evaluate(() => { const t = document.querySelector('.rm-toast .tx'); return t ? { text: t.textContent, act: document.querySelector('.rm-toast .act')?.textContent ?? null } : null; }));
    ok(toast && /^New in /.test(toast.text) && toast.text.includes('Beta') && toast.text.includes('Gamma') && toast.act === 'View', 'PC: the toast "New in <names>" with View', toast);
    ok(toast && toast.text.indexOf('Gamma') < toast.text.indexOf('Beta') || (toast && !toast.text.includes('Beta')), 'PC: newest room first', toast?.text);
    await pg.screenshot({ path: join(SHOTS, 'cross-unread-1280.png') });
    await pg.click('.rm-toast .act');
    await pg.waitForSelector('.rsm-menu .rsm-mi', { timeout: 4000 });
    const pcm = await pg.evaluate(() => { const m = document.querySelector('.rsm-menu'); return { sheet: m.classList.contains('is-sheet'), rows: [...m.querySelectorAll('.rsm-mi')].map((b) => [b.textContent.replace(b.querySelector('.rsm-sub')?.textContent ?? '', '').trim(), b.querySelector('.rsm-sub')?.textContent]) }; });
    ok(!pcm.sheet && JSON.stringify(pcm.rows.map((r) => r[0])) === JSON.stringify(['Gamma', 'Beta']) && pcm.rows.every((r) => /^\d+$/.test(r[1]) && Number(r[1]) >= 1), 'PC: View opens the same menu as a popover, newest first, with badges', pcm);
    await pg.screenshot({ path: join(SHOTS, 'cross-unread-menu-1280.png') });
    await pg.click('.rsm-menu .rsm-mi');
    await pg.waitForURL(new RegExp(`room=${rooms.Gamma.id}`), { timeout: 8000 }).catch(() => {});
    ok(pg.url().includes(`room=${rooms.Gamma.id}`), 'PC: choosing a room opens it', pg.url());
    ok(errs.length === 0, 'PC: no page errors', errs.slice(0, 2));
    await ctx.close();
  }

  /* ---------------- ONE room waiting, on a PHONE: View shows the row first (Owner 2026-10-08) ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
    const pg = await login(ctx);
    const ck = (await ctx.cookies()).map((x) => `${x.name}=${x.value}`).join('; ');
    const topId = (() => { const db = new Database(dbPath); try { return db.prepare('SELECT MAX(id) AS m FROM room_line').get().m; } finally { db.close(); } })();
    for (const room of [rooms.Beta, rooms.Gamma]) { // everything read up to now, so exactly one room is waiting after the next line
      await fetch(`${BASE}/api/rooms/${room.id}/seen`, { method: 'PUT', headers: { cookie: ck, 'content-type': 'application/json' }, body: JSON.stringify({ last_seen_line_id: topId }) });
    }
    await pg.goto(`${BASE}/room.html?room=${rooms.Alpha.id}&shell=0`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('.ph-hdr', { state: 'attached' });
    await settle();
    say(rooms.Beta, 'only beta, once more');
    const one = await waitFor(async () => { const s = await strip(pg); return s && /^\d+ new$/.test(s.text) ? s : null; });
    ok(!!one, 'one room waiting: the strip reads "N new" (count only)', await strip(pg));
    await pg.tap('.wg-notice .vw');
    await pg.waitForSelector('.rsm-menu .rsm-mi', { timeout: 6000 }).catch(() => {});
    const m1 = await pg.evaluate(() => ({ rows: [...document.querySelectorAll('.rsm-menu .rsm-mi')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()), url: location.search }));
    ok(m1.rows.length === 1 && /Beta/.test(m1.rows[0]) && !m1.url.includes(rooms.Beta.id), 'phone, one room waiting: View shows the one row first (a tap there is the way in), it does not jump', m1);
    await pg.tap('.rsm-menu .rsm-mi');
    await pg.waitForURL(new RegExp(`room=${rooms.Beta.id}`), { timeout: 8000 }).catch(() => {});
    ok(pg.url().includes(`room=${rooms.Beta.id}`), 'phone: tapping that row goes to the room', pg.url());
    await ctx.close();
  }
} catch (e) {
  failures += 1; console.log(` FAIL ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  engine?.kill('SIGKILL');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM on Windows */ }
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
