/**
 * PROBE (not in npm test: needs a browser). The Concierge icon in the Workbench's
 * find row (right of the search field, 44x44), Chromium and WebKit, 1280x800 and
 * 390x844 touch; tap opens the same fly-out; off = muted icon, not hidden. Was: the icon appears when the Concierge is
 * on, opens the fly-out over the agent chat, the reply shows live wb: chips and
 * a dead link as text, the spoken line shows the voice mark, and on a phone the
 * sheet is a full-width bottom sheet with no sideways scroll. Screenshots land
 * in the directory named by PROBE_OUT (default: a temp dir, printed).
 *
 *   node test/concierge-icon-workbench.probe.mjs
 *   CHROMIUM=/path/to/chrome node test/concierge-icon-workbench.probe.mjs
 *
 * A fake transcript is written for the Concierge pane under a temp
 * HARBOR_WB_CLAUDE_PROJECTS, and the engine reads it through a local target
 * (HARBOR_WB_TARGETS), so nothing real is touched.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HOST = '127.0.0.1';
const PORT = P(560);
const DEAD = P(561);
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'concierge-icon-wb-probe';
const CHROME = process.env.CHROMIUM || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => existsSync(p));

let passed = 0;
let failed = 0;
const ok = (c, m) => {
  (c ? passed++ : failed++);
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) =>
  new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => resolve({ code, out, err }));
  });

async function run() {
  const { chromium } = await import('playwright');
  for (const p of [PORT, DEAD]) await assertFree(p, 'concierge-icon-workbench.probe.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'wb-cg-probe-'));
  const out = process.env.PROBE_OUT || tmp;
  const db = join(tmp, 'mapping.db');
  const projects = join(tmp, 'claude-projects');
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: db, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) throw new Error(r.err);
  };
  await seed({ recipes: [{ id: 'rec-cg', name: 'Concierge', projectDir: '/srv/x/concierge', vendor: 'claude-code', agent: 'concierge' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  const engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: HOST, HARBOR_WB_TABLE: db, HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
      HARBOR_WB_CLAUDE_PROJECTS: projects, HARBOR_WB_NODE: 'testnode', HARBOR_WB_PANE_TOKENS: '1',
      HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'local', kind: 'local', shell: 'bash' }] }),
    }),
  });
  engine.stdout.on('data', (d) => (log += d));
  engine.stderr.on('data', (d) => (log += d));
  let browser = null;
  try {
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      if (await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)) break;
    }
    await seed({ sessions: [{ paneid: 'recipe:rec-cg', recipe_id: 'rec-cg', vendor: 'claude-code', agent: 'concierge', session_id: 'cg-session-0001', state: 'live' }] });
    const cookieRes = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}`, redirect: 'manual' });
    const cookie = (cookieRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const H = { cookie, 'content-type': 'application/json' };
    const room = await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Alpha' }) })).json();
    await fetch(`${BASE}/api/concierge`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: true, primary: 'rec-cg' }) });
    const dir = join(projects, '-srv-x-concierge');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const mid = String.fromCharCode(0xb7);
    const lines = [
      { type: 'user', message: { role: 'user', content: `[chat ${mid} @user ${mid} voice] where is the Alpha room?` }, timestamp: new Date(now - 60000).toISOString(), uuid: 'u1' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Alpha is here: wb:room/${room.id} and the Workbench is wb:manager. The old room wb:room/nope is gone.` }] }, timestamp: new Date(now - 30000).toISOString(), uuid: 'a1' },
    ];
    writeFileSync(join(dir, 'cg-session-0001.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');


    const engines = [['chromium', chromium]];
    try { const { webkit } = await import('playwright'); engines.push(['webkit', webkit]); } catch {}
    for (const [bname, bt] of engines) {
      try {
        browser = await bt.launch(bname === 'chromium' && CHROME ? { executablePath: CHROME } : {});
      } catch (e) {
        console.log(`  skip ${bname}: ${String(e.message).split('\n')[0]}`);
        continue;
      }
      for (const state of ['on', 'off']) {
        await fetch(`${BASE}/api/concierge`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: state === 'on' }) });
        for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }]) {
          const tag = `${bname}/${state}/${vp.name}`;
          console.log(`\n[${tag}]`);
          const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.name === 'phone' && bname === 'chromium', hasTouch: vp.name === 'phone' });
          await ctx.addCookies(cookie.split('; ').map((c) => ({ name: c.split('=')[0], value: c.split('=').slice(1).join('='), domain: HOST, path: '/' })));
          const page = await ctx.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(`${BASE}/manager.html`);
          await sleep(1200);
          const r = await page.evaluate(() => {
            const rc = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, vis: !e.hidden && getComputedStyle(e).display !== 'none' }; };
            const btn = document.querySelector('#mgrFindRow .cg-btn');
            return { find: rc(document.getElementById('mgrFind')), btn: rc(btn), label: btn?.getAttribute('aria-label'), title: btn?.title, muted: !!btn?.classList.contains('cg-muted'), opacity: btn ? getComputedStyle(btn).opacity : null, scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
          });
          ok(r.btn && r.btn.vis, 'the icon is in the find row and visible');
          if (!r.btn || !r.btn.vis) { await ctx.close(); continue; }
          ok(r.btn.x >= r.find.x + r.find.w - 1, `icon is RIGHT of the field (icon x ${Math.round(r.btn.x)} >= field end ${Math.round(r.find.x + r.find.w)})`);
          ok(Math.abs(r.btn.y + r.btn.h / 2 - (r.find.y + r.find.h / 2)) <= 2, 'same row (centres aligned)');
          ok(Math.round(r.btn.w) === 44 && Math.round(r.btn.h) === 44, `44x44 (${r.btn.w}x${r.btn.h})`);
          ok(r.label === 'Concierge' || (state === 'on' && /^Concierge/.test(r.label)), `aria-label "${r.label}"`);
          if (vp.name === 'phone') ok(r.find.w >= 200, `phone: field still >= 200px (${Math.round(r.find.w)})`);
          ok(r.scrollW <= r.innerW, 'no sideways scroll');
          if (state === 'on') {
            ok(!r.muted && Number(r.opacity) === 1, 'enabled: full-strength icon');
            await page.locator('#mgrFindRow .cg-btn').tap?.().catch(() => {}) ;
            if (!(await page.locator('.cg-sheet').count())) await page.locator('#mgrFindRow .cg-btn').click();
            await page.locator('.cg-sheet').waitFor({ timeout: 5000 });
            const sb = await page.locator('.cg-sheet').boundingBox();
            ok(sb && sb.x >= -1 && sb.x + sb.width <= vp.width + 1 && sb.height > 100, 'tap opens the concierge fly-out inside the viewport');
            ok((await page.locator('.cg-sheet[aria-label="Concierge"]').count()) === 1, 'it is the shared concierge.mjs sheet');
          } else {
            ok(r.muted && Number(r.opacity) < 0.7, `off: muted icon (opacity ${r.opacity})`);
            ok(r.title === 'Concierge is off. Turn it on in Settings.', `off: title says so ("${r.title}")`);
            await page.locator('#mgrFindRow .cg-btn').click();
            await page.locator('.cg-sheet').waitFor({ timeout: 5000 });
            await page.locator('.cg-empty').waitFor({ timeout: 5000 });
            ok(/off\. Turn it on in Settings/.test(await page.locator('.cg-empty').innerText()), 'off: tap shows the "Concierge is off. Turn it on in Settings" message');
          }
          await page.screenshot({ path: join(out, `wb-icon-${tag.replace(/\//g, '-')}.png`) });
          ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
          await ctx.close();
        }
      }
      await browser.close();
      browser = null;
    }
    console.log(`\nscreenshots: ${out}`);
  } finally {
    if (browser) await browser.close();
    engine.kill('SIGKILL');
    await sleep(200);
    if (!process.env.PROBE_OUT) {
      /* keep the screenshots when nobody named a folder: print where they are */
    } else {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

run()
  .catch((e) => {
    failed++;
    console.log(`  FAIL run aborted: ${e?.stack ?? e}`);
  })
  .finally(() => {
    console.log(`PASS ${passed} FAIL ${failed}`);
    process.exit(failed ? 1 : 0);
  });
