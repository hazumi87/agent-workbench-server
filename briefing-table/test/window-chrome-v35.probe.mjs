/* WINDOW-CHROME v35 [chrome v35]  node test/window-chrome-v35.probe.mjs   Owner 2026-10-06 (via the lead)
 * The real shell against a scratch engine (dead broker, temp table, never a live pane):
 *   the hub tab reads "Workbench" (hubName defaults to it), and loading the bundle beside a page no longer repositions that page's own
 *   `.ghost` (v35 scopes it to `.hwb .ghost`): the account page's Sign out button stays where the page put it. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(414);
const DEAD = P(415);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-window-chrome-v35-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
/* a visualViewport whose height the probe can shrink (the soft keyboard) */
const INIT = () => {
  const real = window.visualViewport;
  const fake = new EventTarget();
  let kb = 0;
  Object.defineProperties(fake, {
    width: { get: () => (real ? real.width : window.innerWidth) },
    height: { get: () => (real ? real.height : window.innerHeight) - kb },
    scale: { get: () => (real ? real.scale : 1) },
    offsetTop: { get: () => (real ? real.offsetTop : 0) },
    offsetLeft: { get: () => (real ? real.offsetLeft : 0) },
    pageTop: { get: () => (real ? real.pageTop : 0) },
    pageLeft: { get: () => (real ? real.pageLeft : 0) },
  });
  real?.addEventListener('resize', () => fake.dispatchEvent(new Event('resize')));
  Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
  window.__kb = (px) => { kb = px; fake.dispatchEvent(new Event('resize')); };
};
await assertFree(PORT, 'window-chrome-v35.probe.mjs');
await assertFree(DEAD, 'window-chrome-v35.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-chrome-v35-'));
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
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);

  /* the shell's hub tab */
  await pg.goto(`${BASE}/shell.html`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const hub = await pg.evaluate(() => {
    const h = document.querySelector('.hwb-tab.is-hub');
    return h ? { text: h.textContent.trim().replace(/\s+/g, ' '), title: h.getAttribute('title') || h.querySelector('[title]')?.getAttribute('title') || '' } : null;
  });
  ok(hub && /Workbench/.test(hub.text) && !/CLI Manager/.test(hub.text), 'the hub tab reads "Workbench" (v35 hubName default)', hub);
  const ver = await pg.evaluate(async () => (await (await fetch('/aurora/window-chrome/VERSION')).text()).trim());
  const ver2 = await pg.evaluate(async () => (await (await fetch('/assets/aurora/window-chrome/VERSION')).text()).trim());
  ok(ver === '35' && ver2 === '35', 'both vendored copies are v35', { ver, ver2 });

  /* the account page's Sign out, with the bundle loaded beside it */
  await pg.goto(`${BASE}/account.html`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const before = await pg.evaluate(() => { const b = document.getElementById('signout'); return b ? getComputedStyle(b).position : null; });
  await pg.evaluate(() => new Promise((res) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/aurora/window-chrome/hwb-chrome.css'; l.onload = res; l.onerror = res; document.head.append(l); }));
  await sleep(300);
  const after = await pg.evaluate(() => { const b = document.getElementById('signout'); const r = b?.getBoundingClientRect(); return b ? { pos: getComputedStyle(b).position, w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0, right: getComputedStyle(b).right } : null; });
  ok(before === after?.pos && after.pos !== 'absolute' && after.vis, 'the account page\'s Sign out button keeps its own position with the bundle loaded (.ghost is scoped now)', { before, after });
  /* a control that can fail: the SAME page with v34's bundle (from git) loaded instead is hijacked, so the check above means something */
  const v34 = (await import('node:child_process')).execFileSync('git', ['show', 'HEAD:web/aurora/window-chrome/hwb-chrome.css'], { cwd: REPO_ROOT, maxBuffer: 1 << 24 }).toString();
  await pg.goto(`${BASE}/account.html`, { waitUntil: 'domcontentloaded' });
  await sleep(1000);
  const hijacked = await pg.evaluate((css) => { const st = document.createElement('style'); st.textContent = css; document.head.append(st); const b = document.getElementById('signout'); return b ? getComputedStyle(b).position : null; }, v34);
  ok(hijacked === 'absolute', 'control: with v34 loaded the same button IS repositioned (position: absolute), so the v35 check can fail', hijacked);
  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
  await ctx.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
