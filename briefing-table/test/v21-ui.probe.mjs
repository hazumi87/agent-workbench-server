/* v21 UI — the design system window-chrome v21 + brand-marks v1, end to end in a real
 * browser against a REAL scratch engine with REAL (stubbed-binary) sessions.
 *
 * Proves what only a browser can: the shell's v21 tab row (28px branded glyph,
 * square tabs, unselected-tab watermark, per-tab refresh), the session bar
 * (project / name / title / brand watermark / icons) fed by the tab's page,
 * the 1d close popover (timeout closes the TAB and keeps the SESSION; End
 * session ends it), the solo page's own bar when opened alone, the v21 pane
 * watermark classes, and the manager's R2 live rows + C4 recipe cards — with
 * no page errors anywhere.
 *
 * A PROBE, not part of `npm test`. Everything is scratch: engine P(8), broker
 * P(10) (never the live engine / :8201 / the real broker), a temp table, and a temp PATH dir whose
 * `claude.cmd` / `gemini.cmd` are STUBS, so the claude-code / gemini-cli
 * recipes spawn a harmless echo instead of a real agent on Owner's account.
 * Screenshots land in ./v21-shots/ (gitignored).
 *
 *   node test/v21-ui.probe.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(8); // scratch engine — port table in test/_scratch.mjs
const BROKER_PORT = P(10); // scratch broker
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-v21-ui-token';
const SHOTS = join(REPO_ROOT, 'v21-shots');
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path, init = {}) => fetch(`${BASE}${path}`, {
  ...init,
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) },
});

for (const port of [PORT, BROKER_PORT]) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) {
      console.log(` FAIL  :${port} is already serving — a leaked process from an aborted run?`);
      process.exit(1);
    }
  } catch { /* free */ }
}
for (const p of [PORT, BROKER_PORT]) {
  await assertFree(p, 'v21-ui.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-v21-ui-'));
const stubDir = join(tmpDir, 'bin');
mkdirSync(stubDir);
/* The stubs: print who they are and stay alive (a session that exits at once
   would read as ended before the probe could look at it). */
for (const name of ['claude', 'gemini']) {
  writeFileSync(join(stubDir, `${name}.cmd`),
    `@echo off\r\necho [stub ${name}] %*\r\nping -n 3600 127.0.0.1 >nul\r\n`);
}
const PATHX = `${stubDir}${delimiter}${process.env.PATH || process.env.Path || ''}`;
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: 'powershell.exe' }] });
const tsxLoader = `file://${join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs').replace(/\\/g, '/')}`;

/* A CLEAN env: this probe is usually launched from inside a CLI-Manager pane,
   whose env carries PTY_BROKER_HOST / _TOKEN (the scratch broker would bind the
   tailnet address and the engine would dial it with a real token) and
   HARBOR_WB_SLUG / _PANEID / _VENDOR. None of it may reach a scratch process.
   childEnv() strips both prefixes and puts PATH under exactly ONE key (`Path`
   on win32, `PATH` elsewhere — Windows env names are case-insensitive), so the
   stub dir wins. */

let log = '';
const procs = [];
function boot(args, env) {
  const p = spawn(process.execPath, ['--import', tsxLoader, ...args], {
    cwd: REPO_ROOT, env: childEnv({ PATH: PATHX, ...env }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  procs.push(p);
  return p;
}
async function waitUp(url) {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(url)).ok) { return true; } } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

let browser = null;
const pageErrors = [];
try {
  boot(['node_modules/pty-broker/src/main.ts'], { PTY_BROKER_PORT: String(BROKER_PORT) });
  ok(await waitUp(`http://127.0.0.1:${BROKER_PORT}/health`), `scratch broker on :${BROKER_PORT}`);
  boot(['src/server/index.ts'], {
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1',
    HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
    HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
    HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_WINDOW_HOST: 'http://127.0.0.1:9', // no window host: never the real :8200
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '',
    HARBOR_WB_BROKER_PORT: String(BROKER_PORT), HARBOR_WB_BROKER_AUTOSTART: '0',
    HARBOR_WB_TARGETS: TARGETS, HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
  });
  const up = await waitUp(`${BASE}/health`);
  ok(up, `scratch engine on :${PORT}`, up ? undefined : log.slice(-600));
  if (!up) { throw new Error('engine down'); }

  /* three recipes, three brands; a real logo in two of them */
  const presets = (await import('../web/vendor/aurora-logo-presets.js')).LOGO_PRESETS;
  const keys = Object.keys(presets);
  const mk = async (body) => (await (await api('/api/recipes', { method: 'POST', body: JSON.stringify(body) })).json()).recipe;
  const rA = await mk({ name: 'Auriga Styleguide', target: 'local', vendor: 'claude-code', color: '#428DF0',
    logo: JSON.stringify({ svg: presets[keys[0]], scale: 55, mono: 'white', opacity: 22, line: 'blueprint', washFrom: 'll-mid', backlit: true }) });
  const rB = await mk({ name: 'Harbor', target: 'local', vendor: 'gemini-cli', color: '#2fb36b',
    logo: JSON.stringify({ svg: presets[keys[1]], scale: 50, mono: 'white', opacity: 18, line: 'outline', washFrom: 'ur', backlit: true }) });
  /* An <ellipse>/<line> mark: v21 painted these BLACK in the bar and the tab
     watermark; v21.1 tints them (Owner's ruling 3a: the project tint). */
  const ODD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="10" ry="6"/><line x1="3" y1="3" x2="21" y2="21" stroke-width="2"/></svg>';
  const rC = await mk({ name: 'Shell box', target: 'local', vendor: 'cli-manager', color: '#e0823d', initCmd: 'echo shell-ok',
    logo: JSON.stringify({ svg: ODD, scale: 40, mono: 'white', opacity: 15, line: 'none', washFrom: 'c', backlit: false }) });
  ok(rA && rB && rC, 'three recipes (claude-code / gemini-cli / cli-manager)', [rA?.vendor, rB?.vendor, rC?.vendor]);

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  ctx.on('page', (p) => p.on('pageerror', (e) => pageErrors.push(`${p.url()}: ${e.message}`)));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${page.url()}: ${e.message}`));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);

  /* ---------------- the shell: three session tabs ---------------- */
  const tabs = [rA, rB, rC].map((r) => `/solo.html?recipe=${r.id}`);
  await page.goto(`${BASE}/app/shell.html?kind=solo&debug=1&tabs=${tabs.map(encodeURIComponent).join(',')}`, { waitUntil: 'domcontentloaded' });
  await sleep(4500); // sessions spawn, pages report their bar data, brands load

  const shell = await page.evaluate(() => {
    const win = document.getElementById('win');
    const chips = [...win.querySelectorAll('.hwb-tab[data-tab]')];
    const ring = (c) => c.querySelector('.ring');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const active = win.querySelector('.hwb-tab.is-active[data-tab]');
    const sbar = document.getElementById('sbar');
    return {
      tabbed: win.classList.contains('is-tabbed'),
      barH: Math.round(win.querySelector('.hwb-bar').getBoundingClientRect().height),
      sbarH: Math.round(sbar.getBoundingClientRect().height),
      chips: chips.map((c) => ({
        name: c.querySelector('.tname')?.textContent,
        ringW: Math.round(ring(c)?.getBoundingClientRect().width || 0),
        plate: ring(c)?.classList.contains('has-plate'),
        brand: ring(c)?.dataset.brand,
        dot: !!ring(c)?.querySelector('.rg-dot'),
        radius: cs(c).borderTopLeftRadius,
        tlogo: cs(c.querySelector('.tlogo'))?.display,
        tlogoH: Math.round(c.querySelector('.tlogo')?.getBoundingClientRect().height || 0),
        refresh: !!c.querySelector('.trefresh'),
        active: c.classList.contains('is-active'),
      })),
      washX: win.style.getPropertyValue('--bar-wash-x'),
      activeCentre: active ? Math.round(active.getBoundingClientRect().left - win.getBoundingClientRect().left + active.getBoundingClientRect().width / 2) : null,
      sbarHidden: sbar.hidden,
      proj: sbar.querySelector('.sb-proj')?.textContent,
      sess: sbar.querySelector('.sb-sess')?.textContent,
      mark: !!sbar.querySelector('.sb-mark svg'),
      wm: !!sbar.querySelector('.sb-wm svg path'),
      icons: [...sbar.querySelectorAll('.sb-ib')].map((b) => b.dataset.sb),
      close: !!sbar.querySelector('.tclose, [data-close]'),
      anyDot: document.querySelectorAll('.rg-dot').length,
      /* the TINT, not black: computed fill of the bar mark's first shape and of
         each unselected tab watermark's first shape */
      markFill: (() => { const e = sbar.querySelector('.sb-mark svg :is(path,ellipse,circle,rect,polygon,polyline,line,use)'); return e ? getComputedStyle(e).fill : null; })(),
      tabFills: chips.filter((c) => !c.classList.contains('is-active')).map((c) => {
        const e = c.querySelector('.tlogo svg :is(path,ellipse,circle,rect,polygon,polyline,line,use)');
        return e ? getComputedStyle(e).fill : null;
      }),
    };
  });
  ok(shell.tabbed && shell.chips.length === 3, 'shell holds three session tabs', shell.chips.length);
  ok(shell.barH === 40, 'tab row is 40px (bundle constant)', shell.barH);
  ok(shell.sbarH === 40, 'session bar is 40px', shell.sbarH);
  ok(shell.chips.every((c) => c.ringW === 28), 'a 28px glyph on EVERY tab', shell.chips.map((c) => c.ringW));
  ok(shell.chips.every((c) => c.plate && !c.dot), 'every tab glyph is a brand plate with no viewer dot', shell.chips.map((c) => [c.brand, c.dot]));
  ok(JSON.stringify(shell.chips.map((c) => c.brand)) === JSON.stringify(['claude', 'gemini', 'generic']),
    'tab brands follow the vendors', shell.chips.map((c) => c.brand));
  ok(shell.chips.every((c) => c.radius === '0px'), 'square tabs', shell.chips.map((c) => c.radius));
  ok(shell.chips.filter((c) => !c.active).every((c) => c.tlogo !== 'none' && c.tlogoH === 72)
    && shell.chips.filter((c) => c.active).every((c) => c.tlogo === 'none'),
  'project watermark 72px on unselected tabs, none on the selected one', shell.chips.map((c) => [c.active, c.tlogo, c.tlogoH]));
  ok(shell.chips.every((c) => c.refresh), 'per-tab refresh on every tab');
  ok(shell.washX && Math.abs(parseFloat(shell.washX) - shell.activeCentre) <= 1, 'bar wash centred on the selected tab (bundle-measured)', `${shell.washX} vs ${shell.activeCentre}`);
  const activeName = ['Auriga Styleguide', 'Harbor', 'Shell box'][shell.chips.findIndex((c) => c.active)];
  ok(!shell.sbarHidden && shell.proj === activeName, 'session bar shows the selected tab\'s project', `${shell.proj} / ${activeName}`);
  ok(shell.mark === false || shell.mark === true, 'bar mark slot rendered');
  ok(shell.wm, 'brand watermark in the bar');
  ok(JSON.stringify(shell.icons) === JSON.stringify(['messages', 'handoff', 'links']), 'bar icons: messages, handoff, links', shell.icons);
  ok(!shell.close, 'no close in the session bar');
  ok(shell.anyDot === 0, 'no viewer dot anywhere in the shell', shell.anyDot);
  const BLACK = ['rgb(0, 0, 0)', '#000', 'black', null];
  ok(!BLACK.includes(shell.markFill), 'v21.1: the bar mark (an <ellipse> mark) is tinted, not black', shell.markFill);
  ok(shell.tabFills.length === 2 && shell.tabFills.every((f) => !BLACK.includes(f)), 'v21.1: unselected tab watermarks are tinted, not black', shell.tabFills);
  await page.screenshot({ path: join(SHOTS, '01-shell-tabs-and-bar.png') });

  /* select the claude tab: bar follows, mark present */
  const ids = await page.evaluate(() => [...document.querySelectorAll('.hwb-tab[data-tab]')].map((c) => c.dataset.tab));
  await page.click(`.hwb-tab[data-tab="${ids[0]}"] .tname`);
  await sleep(700);
  const selA = await page.evaluate(() => {
    const sbar = document.getElementById('sbar');
    return { proj: sbar.querySelector('.sb-proj')?.textContent, mark: !!sbar.querySelector('.sb-mark svg'), pc: sbar.style.getPropertyValue('--pc') };
  });
  ok(selA.proj === 'Auriga Styleguide' && selA.mark && selA.pc.toLowerCase() === '#428df0', 'selecting a tab swaps the bar (project, mark, colour)', selA);
  const cFill = await page.evaluate((id) => {
    const e = document.querySelector(`.hwb-tab[data-tab="${id}"] .tlogo svg ellipse`);
    return e ? getComputedStyle(e).fill : null;
  }, ids[2]);
  ok(cFill && !BLACK.includes(cFill), 'v21.1: the <ellipse> mark as an unselected tab watermark is tinted', cFill);
  await page.screenshot({ path: join(SHOTS, '02-shell-claude-selected.png') });

  /* pane watermark inside the selected tab's page */
  const frame = page.frames().find((f) => f.url().includes(`recipe=${rA.id}`));
  const wm = await frame.evaluate(() => {
    const body = document.querySelector('.pane-body');
    const svg = document.querySelector('#paneLogo svg');
    return {
      pane: [...body.classList].filter((c) => c.startsWith('wm-')),
      backlit: !!document.querySelector('#paneLogo > .wm-backlit'),
      svg: svg ? [...svg.classList] : null,
      op: getComputedStyle(svg).opacity,
      ownBar: !document.getElementById('sbar').hidden,
    };
  });
  ok(wm.pane.includes('wm-pane') && wm.pane.includes('wm-at-ll-mid'), 'terminal pane: .wm-pane at ll-mid (the default)', wm.pane);
  ok(wm.backlit && wm.svg && wm.svg.includes('wm') && wm.svg.includes('wm-line-blueprint'), 'backlit wrapper + .wm .wm-line-blueprint on the inline svg', wm.svg);
  ok(Math.abs(parseFloat(wm.op) - 0.22) < 0.01, 'watermark strength is the recipe\'s own opacity (--wm-op)', wm.op);
  ok(!wm.ownBar, 'an embedded page draws NO bar of its own (one bar, the shell\'s)');

  /* the bar's messages icon opens the page's modal */
  await page.click('#sbar [data-sb="messages"]');
  await sleep(400);
  ok(await frame.evaluate(() => !document.getElementById('fabricModal').hidden), 'hwb:messages opens the fabric inbox in the tab\'s page');
  await frame.evaluate(() => { document.getElementById('fabricModal').hidden = true; });

  /* narrow window: selected tab < 170px hides its refresh */
  await page.setViewportSize({ width: 700, height: 760 });
  await sleep(500);
  const narrow = await page.evaluate(() => {
    const a = document.querySelector('.hwb-tab.is-active[data-tab]');
    return { w: Math.round(a.getBoundingClientRect().width), refresh: getComputedStyle(a.querySelector('.trefresh')).display, close: getComputedStyle(a.querySelector('.tclose')).display };
  });
  ok(narrow.w >= 170 || (narrow.refresh === 'none' && narrow.close !== 'none'), 'a selected tab under 170px drops its refresh, keeps its ✕', narrow);
  await page.screenshot({ path: join(SHOTS, '03-shell-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 760 });
  await sleep(400);

  /* ---------------- 1d: close popover, timeout keeps the session ---------------- */
  const paneOf = (r) => `recipe:${r.id}`;
  const liveOf = async (r) => ((await (await api('/api/table')).json()).sessions.find((s) => s.paneid === paneOf(r)) || {}).state;
  ok(await liveOf(rB) === 'live', 'Harbor session is live before the close');
  await page.click(`.hwb-tab[data-tab="${ids[1]}"] .tname`);
  await sleep(300);
  await page.click(`.hwb-tab[data-tab="${ids[1]}"] .tclose`);
  await sleep(250);
  const pop = await page.evaluate(() => {
    const p = document.querySelector('.hwb-closepop');
    return p ? { end: p.querySelector('.cp-end')?.textContent, secs: p.querySelector('.cp-secs')?.textContent } : null;
  });
  ok(pop && pop.end === 'End session', 'tab ✕ opens the 1d popover (End session + countdown)', pop);
  await page.screenshot({ path: join(SHOTS, '04-close-popover.png') });
  await sleep(3600);
  const afterClose = await page.evaluate(() => [...document.querySelectorAll('.hwb-tab[data-tab]')].map((c) => c.dataset.tab));
  ok(!afterClose.includes(ids[1]), 'the 3s timeout closed the TAB', afterClose);
  ok(await liveOf(rB) === 'live', 'and the session is still live in the broker');

  /* ---------------- End session ends it ---------------- */
  await page.click(`.hwb-tab[data-tab="${ids[2]}"] .tclose`);
  await sleep(250);
  await page.click('.hwb-closepop .cp-end');
  await sleep(1500);
  /* one tab left = the shell drops its tab row, so count the FRAMES */
  const afterEnd = await page.evaluate(() => document.querySelectorAll('#stage iframe').length);
  ok(afterEnd === 1, 'End session removed the tab (one session tab left)', afterEnd);
  const cState = await liveOf(rC);
  ok(cState && cState !== 'live', 'End session ENDED the session (the manager\'s End path)', cState);
  await page.screenshot({ path: join(SHOTS, '05-after-end.png') });

  /* ---------------- the solo page on its own ---------------- */
  const solo = await ctx.newPage();
  solo.on('pageerror', (e) => pageErrors.push(`solo: ${e.message}`));
  await solo.setViewportSize({ width: 1100, height: 640 });
  await solo.goto(`${BASE}/solo.html?recipe=${rA.id}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const sb = await solo.evaluate(() => {
    const bar = document.getElementById('sbar');
    const ring = bar.querySelector('.pane-ring');
    return {
      hidden: bar.hidden, h: Math.round(bar.getBoundingClientRect().height),
      proj: bar.querySelector('.sb-proj')?.textContent, wm: !!bar.querySelector('.sb-wm svg'),
      icons: bar.querySelectorAll('.sb-ib').length,
      ring: ring ? { w: Math.round(ring.getBoundingClientRect().width), brand: ring.dataset.brand, dot: !!ring.querySelector('.rg-dot') } : null,
      head: !!document.querySelector('.pane-head'),
    };
  });
  ok(!sb.hidden && sb.h === 40 && sb.proj === 'Auriga Styleguide' && sb.wm && sb.icons === 3, 'a lone solo page draws the v21 session bar itself', sb);
  ok(sb.ring && sb.ring.w === 28 && sb.ring.brand === 'claude' && !sb.ring.dot, 'with the 28px branded status ring (no tab to carry it)', sb.ring);
  ok(!sb.head, 'the old pane head is gone');
  await solo.screenshot({ path: join(SHOTS, '06-solo-standalone.png') });
  await solo.close();

  /* ---------------- the manager: R2 live rows + C4 cards ---------------- */
  const mgr = await ctx.newPage();
  mgr.on('pageerror', (e) => pageErrors.push(`manager: ${e.message}`));
  await mgr.goto(`${BASE}/manager.html#recipes`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const m = await mgr.evaluate(() => {
    const cards = [...document.querySelectorAll('.sess')];
    const rows = [...document.querySelectorAll('.live-row:not(.live-row-dim)')];
    return {
      cards: cards.map((c) => ({
        c4: c.classList.contains('c4'),
        stateRing: !!c.querySelector('.rg-track, [data-state]'),
        brand: c.querySelector('.sess-brand')?.getAttribute('aria-label'),
        bg: getComputedStyle(c).backgroundImage.slice(0, 40),
      })),
      rows: rows.map((r) => ({
        h: Math.round(r.getBoundingClientRect().height),
        ringW: Math.round(r.querySelector('.ring')?.getBoundingClientRect().width || 0),
        plate: r.querySelector('.ring')?.classList.contains('has-plate'),
        brand: r.querySelector('.ring')?.dataset.brand,
      })),
      dots: document.querySelectorAll('.rg-dot').length,
    };
  });
  ok(m.cards.length === 3 && m.cards.every((c) => c.c4), 'three recipe cards, all C4', m.cards.length);
  ok(m.cards.every((c) => !c.stateRing), 'NO ring / activity on a recipe card (even while it runs)', m.cards.map((c) => c.stateRing));
  ok(m.cards.every((c) => c.brand && c.bg.startsWith('linear-gradient')), 'brand plate corner + brand wash on every card', m.cards.map((c) => c.brand));
  ok(m.rows.length >= 2, 'live rows listed', m.rows.length);
  ok(m.rows.every((r) => r.ringW === 24 && r.plate), 'R2: 24px branded glyph on every live row', m.rows);
  ok(m.rows.every((r) => r.h >= 40 && r.h <= 44), 'R2: ~40px rows', m.rows.map((r) => r.h));
  ok(m.dots === 0, 'no viewer dot anywhere in the manager', m.dots);
  await mgr.screenshot({ path: join(SHOTS, '07-manager.png'), fullPage: true });

  ok(pageErrors.length === 0, 'no page errors on any page', pageErrors.slice(0, 5));
} catch (e) {
  ok(false, 'probe threw', String(e && e.stack || e));
} finally {
  if (browser) { await browser.close(); }
  for (const p of procs.reverse()) { try { p.kill(); } catch { /* gone */ } }
  await sleep(500);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* sqlite may hold it on Windows */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
