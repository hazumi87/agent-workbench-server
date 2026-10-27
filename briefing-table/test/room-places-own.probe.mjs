/* THE PHONE WORKBENCH SHEET LEADS WITH THIS ROOM'S OWN WORKGROUPS [places own]  node test/room-places-own.probe.mjs
 * Scratch engine (dead broker, temp table) + the real room page at 390x844 (touch, mobile; Chromium and WebKit when installed).
 * Rooms: mains A, B, C; workgroup A1 under A, C1 under C; created so recency is B, A1, A, C1, C (B above A1).
 * In room A the Workbench chip's sheet has: a 'Workgroups of this room' heading whose first row is A1; a 'Rooms' section
 * listing B and C with C1 right after C and A1 NOT among them. In room B (no workgroups) there is no such heading. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7481;
const DEAD = 7482;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-places-own-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await assertFree(PORT, 'room-places-own.probe.mjs');
await assertFree(DEAD, 'room-places-own.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-places-own-'));
let engine = null; let browser = null; let log = '';
try {
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode' }) });
  engine.stdout.on('data', (d) => (log += d)); engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, 'scratch engine up', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }
  const create = async (name, parent_id) => {
    const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie: await windowCookie(BASE, TOKEN), 'content-type': 'application/json' }, body: JSON.stringify({ name, parent_id }) });
    const j = await r.json();
    if (!r.ok || !j.id) { throw new Error(`create ${name}: ${r.status} ${JSON.stringify(j)}`); }
    await sleep(1100); // last_active_at is per second at worst: keep the order strict
    return j.id;
  };
  const C = await create('Room C'); const C1 = await create('Group C1', C);
  const A = await create('Room A'); const A1 = await create('Group A1', A);
  const B = await create('Room B');
  const order = (await (await fetch(`${BASE}/api/rooms`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).map((v) => v.room.name);
  console.log(`  recency: ${order.join(' > ')}`);
  ok(order.indexOf('Room B') < order.indexOf('Group A1') && order.indexOf('Group A1') < order.indexOf('Room A'), 'recency puts B above A1 above A', order);
  const errs = [];
  const sheet = (pg) => pg.evaluate(() => {
    const body = document.querySelector('#phSheet .sheet-body') || document.querySelector('#phSheet');
    const out = [];
    for (const el of body.querySelectorAll('h3, ol')) {
      if (el.tagName === 'H3') { out.push({ h: el.textContent.trim(), rows: [] }); }
      else if (out.length) { out[out.length - 1].rows.push(...[...el.querySelectorAll('.pl-name')].map((n) => n.textContent.trim())); }
    }
    return out;
  });
  const openPlaces = async (ctx, room) => {
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    await pg.goto(`${BASE}/room.html?room=${room}&shell=0`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('#phLine', { state: 'attached' });
    await sleep(2000);
    if (await pg.evaluate(() => document.querySelector('#phStrip').hidden)) { await pg.tap('#phLine'); }
    await pg.waitForSelector('.ph-places', { state: 'attached' });
    await pg.tap('.ph-places');
    await pg.waitForSelector('#phSheet:not([hidden]) .pl-row', { state: 'attached' });
    await sleep(800);
    return pg;
  };
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
    try { browser = await type.launch({ headless: true }); } catch (e) { console.log(`  skip ${name}: not installed`); continue; }
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    let pg = await openPlaces(ctx, A);
    let s = await sheet(pg);
    console.log(`  ${name} room A sheet: ${JSON.stringify(s)}`);
    const own = s.find((x) => x.h === 'Workgroups of this room');
    ok(!!own, `${name}: room A: 'Workgroups of this room' heading exists`, s.map((x) => x.h));
    ok(own?.rows[0]?.includes('Group A1'), `${name}: its first row is A1`, own?.rows);
    const rooms = s.find((x) => x.h === 'Rooms');
    ok(!!rooms && rooms.rows.some((r) => r.includes('Room B')) && rooms.rows.some((r) => r.includes('Room C')), `${name}: 'Rooms' lists B and C`, rooms?.rows);
    const iC = rooms ? rooms.rows.findIndex((r) => r.includes('Room C')) : -1;
    ok(iC >= 0 && !!rooms.rows[iC + 1] && rooms.rows[iC + 1].includes('Group C1'), `${name}: C1 comes immediately after C`, rooms?.rows);
    ok(!!rooms && !rooms.rows.some((r) => r.includes('Group A1')), `${name}: A1 is NOT in 'Rooms'`, rooms?.rows);
    await pg.close();
    pg = await openPlaces(ctx, B);
    s = await sheet(pg);
    ok(!s.some((x) => x.h === 'Workgroups of this room'), `${name}: room B (no workgroups): no 'Workgroups of this room' heading`, s.map((x) => x.h));
    await ctx.close();
    await browser.close(); browser = null;
  }
  /* WebKit reports fetches cancelled by a page close as errors: not ours */
  const real = errs.filter((e) => !/access control checks|Load failed/.test(e));
  ok(real.length === 0, 'no page errors', real.slice(0, 2));
} catch (e) {
  failures += 1; console.log(` FAIL ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  engine?.kill('SIGKILL');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
