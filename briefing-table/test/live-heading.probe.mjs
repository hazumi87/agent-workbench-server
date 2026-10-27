/* THE LIVE SESSIONS HEADING [live heading]  node test/live-heading.probe.mjs   Owner 2026-10-08 ([ref]), the design system handoff 1.Q
 * "LIVE SESSIONS · 12 live · 3 outside rooms · 9 inside rooms · Show all". The list opens on the sessions outside every room; Show all lists every
 * live one (a seated one names its room) and the link then reads "Show only those outside rooms"; nothing outside: "9 live · all inside rooms";
 * nothing is remembered across a load. /api/table and /api/rooms are STUBBED (a scratch engine has no live agents). */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(433);
const DEAD = P(434);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-live-heading-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS_DIR || '';
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
await assertFree(PORT, 'live-heading.probe.mjs');
await assertFree(DEAD, 'live-heading.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-liveh-'));
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
  browser = await chromium.launch({ headless: true });
  const errs = [];
  const mkSessions = (n, tag) => Array.from({ length: n }, (_, i) => ({ paneid: `${tag}-${i}`, state: 'live', kind: 'session', vendor: 'claude-code', recipe_id: null, friendlyName: `${tag} agent ${i + 1}`, title: `${tag} agent ${i + 1}`, activity: 'idle', attached: true, color: null }));
  const mkRoom = (id, name, paneIds) => ({ room: { id, name, state: 'open', parent_id: null, color: '#3b82f6', alias: null, lead_seat: null }, seats: paneIds.map((pid, i) => ({ id: `${id}-s${i}`, handle: `${name.toLowerCase()}${i}`, left_at: null, occupant: { id: pid, state: 'live', activity: 'idle', attached: true } })), unread: 0 });
  const scenario = async (name, { w, h, outside, inside, roomsWith }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 600, isMobile: w < 600 });
    const sessions = [...mkSessions(outside, 'out'), ...mkSessions(inside, 'in')];
    await ctx.route(/\/api\/table$/, async (route) => { const res = await route.fetch(); const b = await res.json(); await route.fulfill({ response: res, json: { ...b, sessions } }); });
    await ctx.route(/\/api\/rooms(\?[^/]*)?$/, async (route) => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      const ids = sessions.filter((s) => s.paneid.startsWith('in-')).map((s) => s.paneid);
      const half = Math.ceil(ids.length / 2);
      await route.fulfill({ json: roomsWith ? [mkRoom('r-alpha', 'Alpha', ids.slice(0, half)), mkRoom('r-beta', 'Beta', ids.slice(half))] : [] });
    });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`${name}: ${e}`));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    await pg.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    return { ctx, pg };
  };
  const head = (pg) => pg.evaluate(() => ({ title: document.querySelector('#liveWrap .mgr-col-head')?.textContent, counts: document.getElementById('liveCountsText')?.textContent, shown: !document.getElementById('liveCounts').hidden, link: document.getElementById('liveShowAll').hidden ? null : document.getElementById('liveShowAll').textContent, rows: document.querySelectorAll('#liveList .live-row').length, chips: [...document.querySelectorAll('#liveList .live-row .live-roomchip')].map((c) => c.textContent), cards: document.querySelectorAll('#liveList .plus-card').length }));

  /* 1. the demo's case: 12 live, 3 outside, 9 inside (PC) */
  let { ctx, pg } = await scenario('pc-mixed', { w: 1400, h: 900, outside: 3, inside: 9, roomsWith: true });
  let H = await head(pg);
  ok(H.title === 'Live sessions' && H.counts === '12 live · 3 outside rooms · 9 inside rooms' && H.link === 'Show all', 'PC: the heading counts every live session, then offers "Show all"', H);
  ok(H.rows === 3 && H.chips.every((c) => c === 'not in a room'), '...and the list opens on the three strays', H);
  const style = await pg.evaluate(() => { const t = document.getElementById('liveCountsText'); const l = document.getElementById('liveShowAll'); return { mono: getComputedStyle(t).fontFamily, tc: getComputedStyle(t).color, lc: getComputedStyle(l).color, dim: getComputedStyle(document.querySelector('#liveWrap .mgr-col-head')).color }; });
  ok(/mono|Mono|Consolas|Menlo|monospace/i.test(style.mono) && style.lc !== style.tc, 'the counts are the dim mono, the link is its own (sky) colour', style);
  if (SHOTS) { await pg.screenshot({ path: join(SHOTS, 'live-heading-pc-strays.png') }); }
  await pg.click('#liveShowAll');
  await sleep(500);
  H = await head(pg);
  ok(H.rows === 12 && H.link === 'Show only those outside rooms' && H.counts === '12 live · 3 outside rooms · 9 inside rooms', 'Show all: twelve rows, the counts stay, the link now reads "Show only those outside rooms"', H);
  ok(H.chips.filter((c) => /^(Alpha|Beta) \u00b7 @/.test(c)).length === 9 && H.chips.filter((c) => c === 'not in a room').length === 3, '...a seated session names its room and its @handle (Root \u00b7 @handle)', H.chips);
  if (SHOTS) { await pg.screenshot({ path: join(SHOTS, 'live-heading-pc-all.png') }); }
  await pg.click('#liveShowAll');
  await sleep(400);
  ok((await head(pg)).rows === 3, '"Show only those outside rooms" goes back to the three');
  await pg.click('#liveShowAll');
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3000);
  ok((await head(pg)).rows === 3, 'Show all is NOT remembered: a reload opens on the strays');
  await ctx.close();

  /* 2. nothing outside a room: "9 live · all inside rooms · Show all" */
  ({ ctx, pg } = await scenario('pc-allin', { w: 1400, h: 900, outside: 0, inside: 9, roomsWith: true }));
  H = await head(pg);
  ok(H.counts === '9 live · all inside rooms' && H.link === 'Show all' && H.rows === 0 && H.cards === 1, 'nothing outside a room: "9 live · all inside rooms · Show all", and the list is just the + New agent session card', H);
  if (SHOTS) { await pg.screenshot({ path: join(SHOTS, 'live-heading-pc-allin.png') }); }
  await pg.click('#liveShowAll');
  await sleep(400);
  ok((await head(pg)).rows === 9, '...Show all lists the nine', await head(pg));
  await ctx.close();

  /* 3. nothing inside a room: counts, no link (nothing more to show) */
  ({ ctx, pg } = await scenario('pc-allout', { w: 1400, h: 900, outside: 2, inside: 0, roomsWith: false }));
  H = await head(pg);
  ok(H.counts === '2 live · all outside rooms' && H.link === null && H.rows === 2, 'nothing inside a room: "2 live · all outside rooms", no Show all', H);
  await ctx.close();
  /* 4. none live: no counts at all */
  ({ ctx, pg } = await scenario('pc-none', { w: 1400, h: 900, outside: 0, inside: 0, roomsWith: false }));
  H = await head(pg);
  ok(!H.shown && H.rows === 0, 'none live: no counts, no link', H);
  await ctx.close();
  /* 5. a phone: the counts wrap under the title; Show all is a 44px target */
  ({ ctx, pg } = await scenario('phone', { w: 390, h: 780, outside: 3, inside: 9, roomsWith: true }));
  const P1 = await pg.evaluate(() => { const t = document.querySelector('#liveWrap .mgr-col-head').getBoundingClientRect(); const c = document.getElementById('liveCounts').getBoundingClientRect(); const l = document.getElementById('liveShowAll').getBoundingClientRect(); return { titleBottom: Math.round(t.bottom), countsTop: Math.round(c.top), linkH: Math.round(l.height), sw: document.scrollingElement.scrollWidth, iw: innerWidth }; });
  ok(P1.countsTop >= P1.titleBottom - 1 && P1.linkH >= 44 && P1.sw <= P1.iw, 'phone: the counts wrap under the title, Show all is a 44px target, no sideways scroll', P1);
  if (SHOTS) { await pg.screenshot({ path: join(SHOTS, 'live-heading-phone.png'), fullPage: false }); }
  await ctx.close();
  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
