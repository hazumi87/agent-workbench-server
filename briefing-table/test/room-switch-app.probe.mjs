/* THE RIGHT-HAND APP ACROSS A ROOM / WORKGROUP SWITCH [room switch]  node test/room-switch-app.probe.mjs   Owner 2026-10-08
 * The app open in the column is remembered by what it IS (app slug + view path) and opened again in the new room's own panel for it:
 *   'stay' (default) the same view; 'reopen' the app's home; a room without that app opens nothing; an old memory is ignored. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(431);
const DEAD = P(432);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-switch-app-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
await assertFree(PORT, 'room-switch-app.probe.mjs');
await assertFree(DEAD, 'room-switch-app.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-switchapp-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }, { id: 'rec-b', name: 'Other', projectDir: '/srv/x/other', vendor: 'claude-code', agent: 'other', color: '#1f5fbf' }] });
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
  const seeded = (await seed({ rooms: [{ name: 'Layers Main', seats: [{ handle: 'awake', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }, { handle: 'other', recipe_id: 'rec-b' }] }] })).rooms[0];
  const main = seeded.id;
  const { windowCookie } = await import('./_scratch.mjs');
  const cookie = await windowCookie(BASE, TOKEN);
  const call = async (path, method, json) => {
    const res = await fetch(BASE + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
    let b = null; try { b = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: b };
  };
  const wgr = await call(`/api/rooms/${main}/workgroups`, 'POST', { name: 'Switch Sub', alias: 'sub', move: [seeded.seats.other ?? Object.values(seeded.seats)[1]], lead: { move: seeded.seats.other ?? Object.values(seeded.seats)[1] } });
  const WG = wgr.body?.room?.id ?? wgr.body?.workgroup?.id ?? wgr.body?.id;
  ok(!!WG, 'a main room and a workgroup exist', wgr.status);
  browser = await chromium.launch({ headless: true });
  const F = (id, room) => `/api/rooms/${room}/panels/${id}/frame/t/tok-${id}/`;
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  /* both rooms carry the same app ("review", slug app_slug); WG2 (no app) is the third case, made below */
  const withApp = { main: true, wg: true };
  for (const [key, room] of [['main', main], ['wg', WG]]) {
    await ctx.route(new RegExp(`/api/rooms/${room}(\\?.*)?$`), async (route) => {
      const res = await route.fetch();
      const b = await res.json();
      b.panels = withApp[key] ? [{ id: 'p-rev', room_id: room, kind: 'view', title: 'Review', icon: 'tasks', order: 1, seat_handle: null, scripts: true, app_slug: 'review', url: 'http://127.0.0.1:9/never', frameUrl: F('p-rev', room) }] : [];
      await route.fulfill({ response: res, json: b });
    });
  }
  /* the app: a page with a button that asks the host to open a view (the app's own navigation) */
  await ctx.route(/\/panels\/p-rev\/frame\/t\/[^/]+\/.*/, async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><body style="margin:0"><button id="go" onclick="parent.postMessage({panel:'preview', view:{path:'item/7', title:'Review 7'}}, '*')">open</button><i id="where">${u.pathname}</i><script>parent.postMessage({panel:"height", px:120}, "*")</script></body>` });
  });
  await ctx.route(new RegExp('/assets$'), async (route) => { await route.fulfill({ json: { folder: '', shareUrl: '', assets: [] } }); });
  /* the stubs answer the GETs; the engine's own room.state PUSH would say "no panels" (its seeded room has none) and the page would drop them, so the
     probe's pages ignore that one message type (the real engine pushes the same panels the GET returns) */
  await ctx.addInitScript(() => {
    const Real = window.WebSocket;
    const drop = (e) => { try { return JSON.parse(e.data).type === 'room.state'; } catch { return false; } };
    window.WebSocket = class extends Real {
      constructor(...a) {
        super(...a);
        const add = this.addEventListener.bind(this);
        this.addEventListener = (t, f, o) => (t === 'message' ? add(t, (e) => { if (!drop(e)) { f(e); } }, o) : add(t, f, o));
        let h = null;
        Object.defineProperty(this, 'onmessage', { configurable: true, get: () => h, set: (f) => { h = f; add('message', (e) => { if (!drop(e) && f) { f(e); } }); } });
      }
    };
  });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);

  const column = () => pg.evaluate(() => { const pv = document.getElementById('preview'); const fr = pv && !pv.hidden ? pv.querySelector('iframe') : null; return { open: !!fr, src: fr?.getAttribute('src') ?? null }; });
  const openApp = async (room) => {
    await pg.goto(`${BASE}/room.html?room=${room}`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const f = pg.frames().find((x) => /\/panels\/p-rev\//.test(x.url()));
    await f.click('#go');
    await sleep(1200);
  };
  const switchTo = async (selectorText) => {
    await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded' }), pg.click(`#roomList .seat:has-text("${selectorText}")`)]);
    await sleep(3500);
  };
  const clearMode = () => pg.evaluate(() => { try { localStorage.removeItem('hwb.appBehavior.switch'); sessionStorage.removeItem('hwb.room.switchApp'); } catch { /* ignore */ } });

  /* 1. default 'stay': the same view (path item/7) opens in the other room's own app */
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await openApp(main);
  let c = await column();
  ok(c.open && /\/panels\/p-rev\/frame\/.*item\/7/.test(c.src ?? '') && c.src.includes(main), 'in the main room the app view (item/7) is open in the column', c);
  await switchTo('Switch Sub');
  c = await column();
  ok(pg.url().includes(`room=${WG}`) && c.open && /item\/7/.test(c.src ?? '') && (c.src ?? '').includes(WG), 'stay (default): after a switch to the workgroup the SAME view is open, served from the workgroup\'s own app', { url: pg.url(), c });
  /* 2. back again: it carries across the other way too */
  await switchTo('Room chat');
  c = await column();
  ok(pg.url().includes(`room=${main}`) && c.open && /item\/7/.test(c.src ?? ''), 'and back to the main room', c);
  /* 3. 'reopen': the app opens at its HOME for the new room */
  await pg.evaluate(() => localStorage.setItem('hwb.appBehavior.switch', 'reopen'));
  await switchTo('Switch Sub');
  c = await column();
  ok(c.open && !/item\/7/.test(c.src ?? '') && (c.src ?? '').includes(WG), 'reopen: the app opens at its home for the new room (not the old view)', c);
  /* 4. nothing open before the switch: nothing opens after it */
  await clearMode();
  await pg.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await switchTo('Switch Sub');
  c = await column();
  ok(!c.open, 'nothing was open: nothing opens after a switch', c);
  /* 5. a room WITHOUT the app: nothing opens, no errors */
  await openApp(main);
  withApp.wg = false;
  await switchTo('Switch Sub');
  c = await column();
  ok(!c.open, 'the new room has no such app: nothing opens', c);
  withApp.wg = true;
  /* 6. a stale memory (older than 20 s) is ignored */
  await pg.evaluate((from) => sessionStorage.setItem('hwb.room.switchApp', JSON.stringify({ slug: 'review', path: 'item/7', title: 'Review 7', from, mode: 'stay', at: Date.now() - 60000 })), main);
  await pg.goto(`${BASE}/room.html?room=${WG}`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  ok(!(await column()).open, 'an old memory is ignored', await column());
  /* 7. the setting: a new "App behavior" section in Global settings, default Stays as it is, saved per device */
  await clearMode();
  await pg.goto(`${BASE}/settings.html`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#app-behavior .pv-chip', { timeout: 8000 }).catch(() => {});
  const S0 = await pg.evaluate(() => ({ nav: [...document.querySelectorAll('#nav a')].map((a) => a.textContent.replace(/new$/, '')), chips: [...document.querySelectorAll('#app-behavior .pv-chip')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]) }));
  ok(S0.nav.includes('App behavior') && JSON.stringify(S0.chips) === '[["Stays as it is","true"],["Reopens for the new room","false"]]', 'Settings has an "App behavior" section; the default is "Stays as it is"', S0);
  await pg.click('#app-behavior .pv-chip >> nth=1');
  const S1 = await pg.evaluate(() => ({ v: localStorage.getItem('hwb.appBehavior.switch'), on: [...document.querySelectorAll('#app-behavior .pv-chip')].map((b) => b.getAttribute('aria-pressed')) }));
  ok(S1.v === 'reopen' && S1.on.join() === 'false,true', 'choosing "Reopens for the new room" is saved and shown', S1);
  await clearMode();
  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
  await ctx.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
