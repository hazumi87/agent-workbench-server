/* BACKGROUND GUARD SWITCH [Owner 2026-10-14, room [ref]]: Settings > Agents rest > "Keep working seats awake".
 *   node test/background-guard-toggle.probe.mjs
 * Proves, in Chromium and WebKit, desktop (1280x860) and phone (390x844 touch): the switch exists and shows the
 * server value; flipping it PATCHes {backgroundGuard:boolean}; a reload shows the saved state; an engine refusal
 * is shown inline and the switch reverts; the control is >= 44px tall on the phone.
 * A PROBE, not in `npm test`. Own scratch engine on P(230), DEAD broker P(231). */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(230);
const DEAD = P(231);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-bg-guard-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await assertFree(PORT, 'background-guard-toggle.probe.mjs');
await assertFree(DEAD, 'background-guard-toggle.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-bgguard-'));
let engine = null;
const browsers = [];
let log = '';
try {
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
      HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode',
    }),
  });
  engine.stdout.on('data', (d) => (log += d));
  engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* */ } }
  ok(up, 'scratch engine up', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }

  const login = async (ctx) => {
    const p = await ctx.newPage();
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([p.waitForNavigation().catch(() => {}), p.click('form button:visible')]);
    return p;
  };
  const getGuard = async (ctx) => (await (await ctx.request.get(`${BASE}/api/rooms/idle-rest`)).json()).backgroundGuard;

  for (const [bname, bt] of [['chromium', chromium], ['webkit', webkit]]) {
    let br;
    try { br = await bt.launch({ headless: true }); } catch (e) { console.log(`  skip  ${bname}: ${String(e).split('\n')[0]}`); continue; }
    browsers.push(br);
    for (const [form, opts] of [['desktop', { viewport: { width: 1280, height: 860 } }], ['phone', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: bname === 'chromium' }]]) {
      const tag = `${bname}/${form}`;
      const ctx = await br.newContext(opts);
      const page = await login(ctx);
      const patches = [];
      page.on('request', (r) => { if (r.url().endsWith('/api/rooms/idle-rest') && r.method() === 'PATCH') { patches.push(JSON.parse(r.postData() ?? '{}')); } });
      const open = async () => {
        await page.goto(`${BASE}/settings.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#irs-guard', { timeout: 8000 }).catch(() => {});
      };
      await open();
      const sw = page.locator('#irs-guard');
      ok(await sw.count() === 1, `${tag}: the switch exists`);
      if (await sw.count() !== 1) { continue; }
      ok(await page.locator('label.irs-guard', { hasText: 'Keep working seats awake' }).count() === 1, `${tag}: labelled "Keep working seats awake"`);
      ok((await page.locator('label.irs-guard').innerText()).includes('never put to sleep (capped at 6 hours)'), `${tag}: help text is under it`);
      const startOn = await sw.isChecked();
      if (form === 'phone') {
        const h = (await page.locator('label.irs-guard').boundingBox()).height;
        ok(h >= 44, `${tag}: the control is >= 44px tall`, h);
      }
      const wide = await page.evaluate(() => { const cw = document.documentElement.clientWidth; return [...document.querySelectorAll('.irs, .irs *')].filter((e) => e.getBoundingClientRect().right > cw + 1).slice(0, 4).map((e) => `${e.tagName}.${e.className}#${e.id}`); });
      ok(wide.length === 0, `${tag}: the group fits the screen`, wide);
      const want = !startOn;
      patches.length = 0;
      await page.locator('label.irs-guard').click();
      await page.waitForFunction((w) => document.querySelector('#irs-guard-msg')?.textContent === 'Saved' && document.querySelector('#irs-guard').checked === w, want, { timeout: 5000 }).catch(() => {});
      ok(patches.length === 1 && Object.keys(patches[0]).join() === 'backgroundGuard' && patches[0].backgroundGuard === want, `${tag}: toggling PATCHes {backgroundGuard:${want}}`, patches);
      ok(await getGuard(ctx) === want, `${tag}: the engine holds the new value`);
      await open();
      ok(await page.locator('#irs-guard').isChecked() === want, `${tag}: a reload shows the saved state`);
      /* refusal */
      await page.route('**/api/rooms/idle-rest', (route) => (route.request().method() === 'PATCH'
        ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'the idle-rest settings need a person' }) })
        : route.continue()));
      await page.locator('label.irs-guard').click();
      await page.waitForFunction(() => /Not saved/.test(document.querySelector('#irs-guard-msg')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
      const msg = await page.locator('#irs-guard-msg').innerText();
      ok(/Not saved: the idle-rest settings need a person/.test(msg), `${tag}: the engine's refusal is shown inline`, msg);
      ok(await page.locator('#irs-guard').isChecked() === want, `${tag}: the switch reverted`);
      /* put it back so the next run starts the same */
      await ctx.request.patch(`${BASE}/api/rooms/idle-rest`, { data: { backgroundGuard: startOn } });
      await ctx.close();
    }
  }
} catch (e) {
  ok(false, `probe error: ${e?.message ?? e}`);
} finally {
  for (const b of browsers) { await b.close().catch(() => {}); }
  if (engine) { engine.kill('SIGKILL'); }
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(failures ? `\nFAIL ${failures}` : '\nPASS');
process.exit(failures ? 1 : 0);
