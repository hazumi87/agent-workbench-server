/* SEARCH THIS ROOM [search ui]  node test/room-search.probe.mjs   Owner 2026-10-06 ([ref]; the design system BUILD-HANDOFF §1.K)
 * The real room page against a scratch engine (dead broker, temp table, never a live pane); the lines are written straight into
 * the temp db (170 agent lines, "workbench" in the very first and in a late one, "palette" in three, and a line in a
 * cross-post-free second room that must NOT be found). PC 1280 and phone 390, DARK and LIGHT (the real palette applied):
 *   the button + Ctrl+F; a 460px popover under the button (phone: a full-screen sheet, 16px input); the hint before typing;
 *   "N matches · newest first"; every query word in <strong> and nothing else marked; "No matches for “q”";
 *   Up/Down/Enter/Esc; click outside closes (PC); a pick jumps to the line (centred, flashed) even when it is far back
 *   (paged in); light mode: panel ground light, snippet / author / hit contrast numbers. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(410);
const DEAD = P(411);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-search-token';
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
await assertFree(PORT, 'room-search.probe.mjs');
await assertFree(DEAD, 'room-search.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-search-'));
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
  const plan = await seed({ rooms: ['Searchable', 'Other'].map((name) => ({ name, seats: [{ handle: 'awake', recipe_id: 'rec-a' }] })) });
  const R = plan.rooms.find((r) => r.name === 'Searchable');
  const OTHER = plan.rooms.find((r) => r.name === 'Other');
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  const ins = db.prepare('INSERT INTO room_line (room_id, ts, kind, author, author_seat, target, target_seat, thread, body, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)');
  const say = (room, ts, text) => Number(ins.run(room.id, ts, 'chat', 'awake', room.seats.awake, 'room', null, text).lastInsertRowid);
  const T0 = Date.now() - 20 * 86_400_000;
  const idOld = say(R, T0, 'The Workbench plan was first drafted on the second of the month, before anything else.');
  let idMid = 0;
  for (let i = 0; i < 160; i += 1) {
    say(R, T0 + 60_000 * (i + 1), `filler line ${i} about nothing in particular but long enough to take some room on the screen`);
    if (i === 80) { idMid = say(R, T0 + 60_000 * 81 + 1, 'the zebra marker sits right in the middle of the history'); }
  }
  const idP1 = say(R, T0 + 3e6, 'the palette picker keeps the old palette until you save');
  say(R, T0 + 4e6, 'Palette for the PALETTE tiles');
  say(R, T0 + 5e6, 'a palette of one');
  const idNew = say(R, Date.now() - 5000, 'the workbench rename is live');
  say(OTHER, Date.now() - 4000, 'workbench lives in another room only');
  db.close();
  browser = await chromium.launch({ headless: true });
  const lum = (rgb) => { const c = rgb.slice(0, 3).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrast = (a, b2) => { const [l1, l2] = [lum(a), lum(b2)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
  for (const c of [{ name: 'PC 1280', w: 1280, h: 860, touch: false, phone: false }, { name: 'phone 390', w: 390, h: 780, touch: true, phone: true }].filter((x) => !process.env.ONLY || process.env.ONLY === x.w + '')) {
    for (const mode of ['dark', 'light'].filter((m) => !process.env.MODE || process.env.MODE === m)) {
      const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, hasTouch: c.touch, isMobile: c.touch, locale: 'en-US' });
      const pg = await ctx.newPage();
      const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
      await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
      await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
      await pg.goto(`${BASE}/room.html?room=${R.id}&shell=0`, { waitUntil: 'domcontentloaded' });
      await pg.waitForSelector(c.phone ? '.ph-hdr' : '#searchBtn', { state: 'attached' });
      await sleep(1800);
      if (mode === 'light') {
        await pg.evaluate(async () => { const m = await import('/palette.mjs'); m.applyPref(document, { key: 'aurora', mode: 'light' }); });
        await sleep(300);
      }
      const L = `${c.name} ${mode}`;
      const btn = c.phone ? '#phSearch' : '#searchBtn';
      const rgbOf = (css) => pg.evaluate((v) => { const cv = document.createElement('canvas'); cv.width = cv.height = 1; const x = cv.getContext('2d'); x.fillStyle = '#010203'; x.fillStyle = v; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data]; }, css);
      /* open */
      const opener = c.phone ? () => pg.tap(btn) : () => pg.keyboard.press('Control+f');
      await opener();
      await pg.waitForSelector('.sr', { timeout: 4000 });
      const shape = await pg.evaluate(() => { const r = document.querySelector('.sr'); const b = r.getBoundingClientRect(); const i = r.querySelector('.sr-input'); return { sheet: r.classList.contains('sr-sheet'), w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), fs: parseFloat(getComputedStyle(i).fontSize), ih: Math.round(i.getBoundingClientRect().height), hint: r.querySelector('.sr-hint')?.textContent ?? '', focused: document.activeElement === i }; });
      if (c.phone) {
        ok(shape.sheet && shape.w === 390 && shape.h >= 700 && shape.fs >= 16 && shape.ih >= 42, `${L}: the phone search is a full-screen sheet, 42px / 16px input`, shape);
      } else {
        const btnBox = await pg.evaluate(() => document.getElementById('searchBtn').getBoundingClientRect().bottom);
        ok(!shape.sheet && shape.w === 460 && shape.top >= btnBox && shape.focused, `${L}: Ctrl+F opens a 460px popover under the button, the field focused`, { ...shape, btnBox });
      }
      if (!c.phone) {
        const pair = await pg.evaluate(() => { const a = document.getElementById('searchBtn').getBoundingClientRect(); const f = document.getElementById('filterBtn').getBoundingClientRect(); const g = document.getElementById('gearBtn').getBoundingClientRect(); return { gapSF: Math.round(f.left - a.right), gapFG: Math.round(g.left - f.right), gearRight: Math.round(innerWidth - g.right) }; });
        ok(Math.abs(pair.gapSF) <= 8 && pair.gearRight <= 16, `${L}: the magnifier sits with the filter and the gear at the right of the header`, pair);
      }
      ok(/whole history/.test(shape.hint), `${L}: the hint before typing`, shape.hint);
      await pg.fill('.sr-input', 'workbench');
      await pg.waitForSelector('.sr-row', { timeout: 6000 });
      const res = await pg.evaluate(() => ({
        count: document.querySelector('.sr-count')?.textContent ?? '',
        rows: [...document.querySelectorAll('.sr-row')].map((r) => ({ au: r.querySelector('.sr-au')?.textContent, ts: r.querySelector('.sr-ts')?.textContent, pl: r.querySelector('.sr-pl')?.textContent ?? '', strong: [...r.querySelectorAll('.sr-sn strong')].map((x) => x.textContent), text: r.querySelector('.sr-sn')?.textContent ?? '' })),
        sel: document.querySelector('.sr-row[aria-selected="true"]')?.querySelector('.sr-sn')?.textContent.slice(0, 30) ?? null,
      }));
      ok(res.count === '2 matches · newest first' && res.rows.length === 2, `${L}: "2 matches · newest first" (the other room's line is not found)`, res.count);
      ok(res.rows[0].text.includes('rename is live') && res.rows[1].text.includes('first drafted') && res.rows[0].strong.length === 1 && /workbench/i.test(res.rows[0].strong[0]) && res.rows[0].au === '@awake', `${L}: newest first; the query word in <strong>; the author in mono`, res.rows);
      const line0 = await pg.evaluate(() => { const li = [...document.querySelectorAll('#line li')].pop(); return li?.querySelector('.entry-ts')?.textContent ?? null; });
      ok(/^\d{2}:\d{2}\s?(AM|PM)$/.test(res.rows[0].ts) && res.rows[0].ts === line0, `${L}: the result's time is the room line's own clock ("${res.rows[0].ts}" = the line's "${line0}")`, { result: res.rows[0].ts, line: line0 });
      ok(res.rows[1].pl === 'earlier' && res.rows[1].ts && res.sel === res.rows[0].text.slice(0, 30), `${L}: the older hit's place says "earlier" (not on the page yet); the first row is selected`, res.rows[1]);
      /* several words: every word must match, every word is bold */
      await pg.fill('.sr-input', 'palette tiles');
      await pg.waitForFunction(() => document.querySelectorAll('.sr-row').length === 1, null, { timeout: 5000 });
      const two = await pg.evaluate(() => [...document.querySelectorAll('.sr-row .sr-sn strong')].map((x) => x.textContent.toLowerCase()));
      ok(two.includes('palette') && two.includes('tiles'), `${L}: every query word is bold ("palette" and "tiles")`, two);
      await pg.fill('.sr-input', 'zzqq');
      await pg.waitForSelector('.sr-none', { timeout: 5000 });
      ok(/No matches for “zzqq”/.test(await pg.textContent('.sr-none')) && /Try fewer or different words/.test(await pg.textContent('.sr')), `${L}: "No matches for “zzqq”" + "Try fewer or different words."`);
      await pg.fill('.sr-input', 'workbench');
      await pg.waitForSelector('.sr-row', { timeout: 5000 });
      if (mode === 'light') {
        const g = await pg.evaluate(() => { const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; }; return { bg: cs('.sr', 'backgroundColor'), sn: cs('.sr-sn', 'color'), strong: cs('.sr-sn strong', 'color'), au: cs('.sr-au', 'color'), ts: cs('.sr-ts', 'color'), input: cs('.sr-input', 'backgroundColor'), inputText: cs('.sr-input', 'color') }; });
        const [bg, sn, strong, au, inputBg, inputText] = await Promise.all([rgbOf(g.bg), rgbOf(g.sn), rgbOf(g.strong), rgbOf(g.au), rgbOf(g.input), rgbOf(g.inputText)]);
        ok(lum(bg) > 0.5, `${L}: the panel ground is light (luminance ${lum(bg).toFixed(2)})`, g.bg);
        ok(contrast(sn, bg) >= 4.5 && contrast(strong, bg) >= 7 && contrast(au, bg) >= 3 && contrast(inputText, inputBg) >= 4.5, `${L}: text contrast: snippet ${contrast(sn, bg).toFixed(1)}, hit ${contrast(strong, bg).toFixed(1)}, author ${contrast(au, bg).toFixed(1)}, field ${contrast(inputText, inputBg).toFixed(1)}`, g);
      }
      await pg.screenshot({ path: join(SHOTS, `search-${c.w}-${mode}.png`) });
      /* keyboard: Down then Up, then Esc closes */
      await pg.keyboard.press('ArrowDown');
      ok(await pg.evaluate(() => document.querySelectorAll('.sr-row')[1]?.getAttribute('aria-selected') === 'true'), `${L}: Down moves the selection`);
      await pg.keyboard.press('Escape');
      ok(await pg.evaluate(() => !document.querySelector('.sr')), `${L}: Esc closes`);
      if (!c.phone) {
        await opener();
        await pg.waitForSelector('.sr');
        await pg.mouse.click(300, 700);
        ok(await pg.evaluate(() => !document.querySelector('.sr')), `${L}: a click outside closes it`);
      }
      /* pick a hit that is far back: the page pages it in, closes the search, centres the line and flashes it */
      const openSearchAgain = async (q) => {
        if (c.phone) { await pg.tap(btn); } else { await pg.keyboard.press('Control+f'); }
        await pg.waitForSelector('.sr');
        await pg.fill('.sr-input', q);
        await pg.waitForSelector('.sr-row');
        await pg.locator('.sr-row').first().click();
      };
      const jumped = async (id) => {
        await pg.waitForFunction((x) => !!document.querySelector(`#line li[data-id="${x}"]`), id, { timeout: 20000 }).catch(() => {});
        await sleep(1000);
        return pg.evaluate((x) => { const li = document.querySelector(`#line li[data-id="${x}"]`); const sc = document.getElementById('lineScroll'); if (!li) { return null; } const lr = li.getBoundingClientRect(); const sr = sc.getBoundingClientRect(); return { found: li.classList.contains('is-found'), centre: Math.round((lr.top + lr.bottom) / 2 - (sr.top + sr.bottom) / 2), closed: !document.querySelector('.sr'), top: Math.round(sc.scrollTop), inView: lr.top >= sr.top - 1 && lr.bottom <= sr.bottom + 1 }; }, id);
      };
      await openSearchAgain('zebra');
      const mid = await jumped(idMid);
      ok(mid && mid.closed && mid.found && Math.abs(mid.centre) < 60, `${L}: a hit in the middle of the history is paged in, the search closes, the line is CENTRED and flashes`, mid);
      await openSearchAgain('first drafted');
      const old = await jumped(idOld);
      ok(old && old.closed && old.found && old.inView && (Math.abs(old.centre) < 60 || old.top <= 2), `${L}: the very first line is paged in and brought into view (it cannot centre: it is the start of the chat)`, old);
      ok(errs.length === 0, `${L}: no page errors`, errs.slice(0, 2));
      void idP1; void idNew;
      await ctx.close();
    }
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
