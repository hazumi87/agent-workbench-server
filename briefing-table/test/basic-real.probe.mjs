/* THE BASIC SCREENS AGAINST THE REAL BASIC ENGINE [basic real]  node test/basic-real.probe.mjs
 * A scratch engine with HARBOR_WB_EDITION=basic (dead broker, temp table, never a live pane) and a fake `site` command (test/fixtures/fake-site.mjs) standing
 * in for the hosted install's. NOTHING is stubbed: /health, New site, the site bar's status, /help and the typed-command pass-through are the engine's own. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const FAKE_SITE = join(REPO_ROOT, 'test', 'fixtures', 'fake-site.mjs');
const PORT = P(435);
const DEAD = P(436);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-basic-real-token';
const SHOTS = process.env.SHOTS_DIR || '';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
await assertFree(PORT, 'basic-real.probe.mjs');
await assertFree(DEAD, 'basic-real.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-basicreal-'));
const sitesDir = join(tmpDir, 'sites');
mkdirSync(sitesDir);
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  /* the recipe New site clones: named "Builder" (HARBOR_WB_BUILDER_RECIPE's default) */
  await seed({ recipes: [{ id: 'rec-builder', name: 'Builder', projectDir: sitesDir, vendor: 'claude-code', agent: 'builder', color: '#0dab49' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode',
    HARBOR_WB_EDITION: 'basic', HARBOR_WB_SITES_DIR: sitesDir,
    HARBOR_WB_NEWSITE_CMD: `${process.execPath} ${FAKE_SITE} new {name}`, HARBOR_WB_SITE_STATUS_CMD: `${process.execPath} ${FAKE_SITE} status` }) });
  engine.stdout.on('data', (d) => (log += d)); engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, 'scratch engine up (edition basic)', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }
  const health = await (await fetch(`${BASE}/health`)).json();
  ok(health.edition === 'basic', '/health says edition "basic"', health.edition);
  const cookie = await windowCookie(BASE, TOKEN);
  const asPerson = async (path, method = 'GET', body) => {
    const init = { method, headers: { cookie } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await fetch(BASE + path, init);
    let b = null; try { b = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: b };
  };

  browser = await chromium.launch({ headless: true });
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);

  /* ---- 1. New site, through the Workbench, end to end ---- */
  await pg.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const card = await pg.evaluate(() => ({ t: document.querySelector('#roomNewCard .pt')?.textContent, rooms: document.querySelector('#roomsWrap .mgr-col-head')?.textContent }));
  ok(card.t === 'New site' && card.rooms === 'Sites', 'the Workbench says "Sites" and "New site" (the real /health made the page Basic)', card);
  await pg.click('#roomNewCard');
  await pg.fill('#roomNewName', "Sam's Bakery");
  const popup = ctx.waitForEvent('page', { timeout: 20000 }).then((p) => p).catch(() => null);
  const nav = pg.waitForURL(/\/room\.html\?room=/, { timeout: 20000 }).then(() => true).catch(() => false);
  await pg.click('#roomNewBtn');
  let room = null;
  const navigated = await Promise.race([nav, popup.then((p) => !!p)]);
  const pop = await Promise.race([popup, sleep(100).then(() => null)]);
  const roomPage = pop ?? pg;
  await roomPage.waitForURL(/\/room\.html\?room=/, { timeout: 20000 }).catch(() => {});
  room = new URL(roomPage.url()).searchParams.get('room');
  ok(navigated && !!room, 'New site made the site and landed in its room', roomPage.url());
  const created = await asPerson(`/api/rooms/${room}`);
  const siteDir = join(sitesDir, 'sam-s-bakery');
  ok(created.status === 200 && created.body?.room?.name && (created.body.seats ?? []).length === 1, 'the room has the one Builder seat (real engine)', { name: created.body?.room?.name, seats: (created.body?.seats ?? []).length });
  roomPage.on('pageerror', (e) => errs.push(`room: ${e}`));
  await sleep(3500);

  const mgr = await ctx.newPage();
  await mgr.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await mgr.waitForSelector('#roomList .room-card, #roomList [data-act="open-room"]', { timeout: 8000 }).catch(() => {});
  await sleep(1500);
  const W = await mgr.evaluate(() => ({ head: document.querySelector('#roomsWrap .mgr-col-head')?.textContent, open: document.querySelector('[data-act="open-room"]')?.textContent, sub: document.querySelector('#roomList .rc-sub')?.textContent, wg: !![...document.querySelectorAll('.rc-wgs')].find((e) => getComputedStyle(e).display !== 'none') }));
  ok(W.head === 'Sites' && W.open === 'Open' && W.sub === '1 agent' && !W.wg, 'Basic Workbench card: "Sites", "Open", "1 agent" (no seats, no lead, no workgroup chips)', W);
  if (SHOTS) { await mgr.screenshot({ path: join(SHOTS, 'real-workbench-sites.png') }); }
  await mgr.close();
  /* ---- 2. the Basic room: bar, seats layout, site bar ---- */
  const R = await roomPage.evaluate(() => ({ bar: document.getElementById('roomName')?.textContent.replace(/\s+/g, ' ').trim(), roomCell: !!document.querySelector('.cell[data-cell="room"]') && getComputedStyle(document.querySelector('.cell[data-cell="room"]')).display !== 'none', rowInSeats: !!document.querySelector('#roster .seat.is-room'), meta: document.querySelector('#roster .seat.is-room .seat-meta')?.textContent ?? null }));
  ok(/· 1 agent/.test(R.bar) && !/Main room/.test(R.bar) && !R.roomCell && R.rowInSeats, 'the room bar is the site\'s name · 1 agent; the old seats layout (no Room cell)', R);
  if (SHOTS) { await roomPage.screenshot({ path: join(SHOTS, 'real-room-private.png') }); }
  const bar0 = await roomPage.evaluate(() => { const b = document.getElementById('siteBar'); return b && !b.hidden ? { open: b.querySelector('.sb-open')?.getAttribute('href'), on: b.querySelector('.sb-switch')?.getAttribute('aria-checked'), off: b.querySelector('.sb-off')?.textContent, addr: !!b.querySelector('.sb-addr'), behind: !!b.querySelector('.sb-behind') } : null; });
  ok(!!bar0 && /preview\.example\/sam-s-bakery/.test(bar0.open ?? '') && bar0.on === 'false' && !bar0.addr && !bar0.behind, 'the site bar (the engine\'s real `site status`): Open preview, Public off', bar0);

  /* ---- 3. the switch sends /publish as a TYPED line, with the engine's marker ---- */
  await roomPage.click('#siteBar .sb-switch');
  await sleep(1500);
  const lines = await asPerson(`/api/rooms/${room}/line?limit=50`);
  const typed = (lines.body?.entries ?? []).find((e) => e.kind === 'chat' && /^\/publish\b/.test(e.body ?? ''));
  ok(!!typed, 'the switch wrote /publish into the room as the person\'s own line', (lines.body?.entries ?? []).map((e) => `${e.kind}:${String(e.body).slice(0, 40)}`).slice(-4));
  ok(await roomPage.evaluate(() => /asked .* to publish/.test(document.querySelector('#siteBar .sb-asked')?.textContent ?? '')) && (await roomPage.evaluate(() => document.querySelector('#siteBar .sb-switch').getAttribute('aria-checked'))) === 'false', 'the switch has not flipped (the agent asks first); it says it asked');
  /* the site becomes public and has unsaved changes (the fake command's state files) */
  writeFileSync(join(siteDir, '.published'), '');
  writeFileSync(join(siteDir, '.dirty'), '');
  await roomPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await roomPage.waitForFunction(() => document.querySelector('#siteBar .sb-switch')?.getAttribute('aria-checked') === 'true', null, { timeout: 8000 }).catch(() => {});
  const bar1 = await roomPage.evaluate(() => { const b = document.getElementById('siteBar'); return { on: b.querySelector('.sb-switch')?.getAttribute('aria-checked'), addr: b.querySelector('.sb-addr')?.getAttribute('href'), when: b.querySelector('.sb-when')?.textContent, behind: b.querySelector('.sb-behind-t')?.textContent, asked: !!b.querySelector('.sb-asked') }; });
  ok(bar1.on === 'true' && /sam-s-bakery\.example/.test(bar1.addr ?? '') && /^published .*(Oct|10)/.test(bar1.when ?? '') && /Changes not published yet/.test(bar1.behind ?? '') && !bar1.asked, 'public + unsaved: the address, the published time (read from the engine\'s ISO string), "Changes not published yet" + Publish now', bar1);
  if (SHOTS) { await roomPage.screenshot({ path: join(SHOTS, 'real-room-public-behind.png') }); }

  /* ---- 4. /help: the engine's registry ---- */
  await roomPage.fill('#input', '/help');
  await roomPage.click('#sendBtn');
  await roomPage.waitForSelector('#help:not([hidden]) .rm-verb', { timeout: 6000 }).catch(() => {});
  const H = await roomPage.evaluate(() => ({ heads: [...document.querySelectorAll('#help .rm-help-head')].map((h) => h.firstChild.textContent), room: [...document.querySelectorAll('#help .rm-verbs:not(.rm-verbs-agent) .rm-verb-usage')].map((x) => x.textContent), ask: [...document.querySelectorAll('#help .rm-verb-ask')].map((r) => r.dataset.cmd) }));
  ok(H.heads.join() === 'Room commands,Ask your agent' && H.room.some((x) => /\/help/.test(x)) && H.ask.includes('/publish') && H.ask.every((c) => c.startsWith('/')), '/help: the engine\'s Room commands, then Ask your agent (its registry, with /publish)', { heads: H.heads, room: H.room, ask: H.ask.slice(0, 6) });
  if (SHOTS) { await roomPage.screenshot({ path: join(SHOTS, 'real-help.png') }); }

  /* ---- 5. Settings and the engine's own refusals ---- */
  await roomPage.goto(`${BASE}/settings.html`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const S = await roomPage.evaluate(() => [...document.querySelectorAll('#nav a')].map((a) => a.dataset.nav));
  ok(!S.includes('voice') && !S.includes('agent-comms') && !S.includes('chatter') && S.includes('palette'), 'Settings: no Voice / Agent comms / chatter on the real Basic engine', S);
  const seatId = created.body.seats[0].id;
  const wd = await asPerson(`/api/rooms/${room}/seats/${seatId}/wake-deliver`, 'POST', { lineId: typed?.id ?? 1 });
  ok(wd.status === 409 || wd.status === 200, 'wake-deliver on a seat with no session: the engine answers (409 nothing to wake, or 200)', { status: wd.status, body: wd.body });
  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
  await ctx.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
