/* THE RAIL KEYS BLOCK ON A TOUCH TABLET [ipad keys]  node test/room-ipad-keys.probe.mjs   Owner 2026-10-05
 * The real room page against a scratch engine (dead broker, temp table, never a live pane).
 *   iPad 1366x1024 + 1024x1366 (touch): a Keys cell under Seats (9 keys, 44px), disabled with "Select an agent's CLI"
 *   until a seat's CLI is open in the right column, then each key reaches that seat's solo frame as {hwbKeys: <seq>};
 *   disabled again on the room chat; the wide columns stay.   390 phone, 1280 mouse, and a 1366x1024 tablet without
 *   touch: no Keys block. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(394);
const DEAD = P(395);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-ipad-keys-token';
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
await assertFree(PORT, 'room-ipad-keys.probe.mjs');
await assertFree(DEAD, 'room-ipad-keys.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-ipad-keys-'));
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
  /* seeded AFTER boot: the boot reconcile turns a stale `live` row into `dehydrated` (a pane with no process behind it) */
  const R = (await seed({ sessions: [{ paneid: 'recipe:rec-a', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'awake', state: 'live' }],
    rooms: [{ name: 'Tablet', seats: [{ handle: 'awake', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }] }] })).rooms[0].id;
  browser = await chromium.launch({ headless: true });
  const CASES = [
    { name: 'iPad landscape 1366x1024', w: 1366, h: 1024, touch: true, keys: true },
    { name: 'iPad portrait 1024x1366', w: 1024, h: 1366, touch: true, keys: true },
    { name: 'phone 390', w: 390, h: 780, touch: true, keys: false },
    { name: 'desktop 1280 (mouse)', w: 1280, h: 860, touch: false, keys: false },
    { name: 'tablet 1366x1024 with a trackpad (fine pointer)', w: 1366, h: 1024, touch: false, keys: false },
  ];
  for (const c of CASES) {
    const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, hasTouch: c.touch, isMobile: c.touch });
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    await pg.goto(`${BASE}/room.html?room=${R}&shell=0`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('#roster .seat, .ph-hdr', { state: 'attached' });
    await sleep(900);
    const label = c.name;
    const keys = await pg.evaluate(() => {
      const k = document.getElementById('twKeys');
      const seats = document.querySelector('.cell[data-cell="seats"]');
      const bs = [...document.querySelectorAll('#twKeysGrid button')];
      return { shown: getComputedStyle(k).display !== 'none', below: Math.round(k.getBoundingClientRect().top - seats.getBoundingClientRect().bottom), n: bs.length, off: bs.every((b) => b.disabled), note: document.getElementById('twKeysNote').textContent, minH: bs.length ? Math.min(...bs.map((b) => Math.round(b.getBoundingClientRect().height))) : 0, roster: Math.round(document.querySelector('.rm-roster').getBoundingClientRect().width), tw: document.documentElement.classList.contains('touch-wide') };
    });
    if (!c.keys) {
      ok(!keys.shown && !keys.tw, `${label}: no touch-wide, no rail Keys block`, keys);
    } else {
      ok(keys.tw && keys.shown && keys.below >= -1 && keys.n === 9 && keys.minH >= 44, `${label}: the Keys cell is under Seats, 9 keys, 44px`, keys);
      const lay = await pg.evaluate(() => [...document.querySelectorAll('#twKeysGrid button')].map((b) => { const r = b.getBoundingClientRect(); return [b.getAttribute('aria-label').split(' ')[0], Math.round(r.left), Math.round(r.top)]; }));
      const rows = [...new Set(lay.map((l) => l[2]))].sort((a, b) => a - b);
      const grid = rows.map((t) => lay.filter((l) => l[2] === t).sort((a, b) => a[1] - b[1]).map((l) => l[0]).join(' '));
      ok(JSON.stringify(grid) === JSON.stringify(['Escape Up Tab', 'Left Down Right', 'Backtick Newline Enter']), `${label}: laid out as a numeric keypad (3 columns)`, grid);
      ok(keys.roster > 150, `${label}: the wide columns stay (rail ${keys.roster}px)`);
      ok(keys.off && keys.note === "Select an agent's CLI", `${label}: disabled with "Select an agent's CLI" until a CLI is open`, keys);
      await pg.click('#roster .seat[data-seat-id]');
      await pg.waitForSelector('#seatView iframe:not([hidden])', { state: 'attached' });
      await sleep(600);
      ok(await pg.evaluate(() => [...document.querySelectorAll('#twKeysGrid button')].every((b) => !b.disabled) && document.getElementById('twKeysNote').textContent === ''), `${label}: with a seat's CLI open the keys are enabled`);
      const fr = pg.frames().find((f) => f !== pg.mainFrame() && /solo/.test(f.url()));
      await fr.evaluate(() => { window.__got = []; addEventListener('message', (e) => window.__got.push(e.data?.hwbKeys)); });
      for (const aria of ['Escape', 'Tab', 'Up', 'Enter']) { await pg.locator(`#twKeysGrid button[aria-label="${aria}"]`).tap(); }
      await sleep(200);
      const got = await fr.evaluate(() => window.__got);
      ok(JSON.stringify(got) === JSON.stringify(['\x1b', '\t', '\x1b[A', '\r']), `${label}: each key reaches the open seat's frame as hwbKeys`, got);
      ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no sideways scroll`);
      await pg.screenshot({ path: join(SHOTS, `ipad-${c.w}-keys.png`) });
      await pg.click('#roomList .seat.is-room');
      await sleep(300);
      ok(await pg.evaluate(() => [...document.querySelectorAll('#twKeysGrid button')].every((b) => b.disabled)), `${label}: back on the room chat the keys are disabled again`);
    }
    ok(errs.length === 0, `${label}: no page errors`, errs.slice(0, 2));
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
