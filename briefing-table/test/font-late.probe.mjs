/**
 * A LATE TERMINAL FONT MUST NOT CLIP THE LAST COLUMN (Owner 2026-09-25, solo page
 * in real Edge: "platfo|r", "agen|t" cut mid-letter in some sessions only).
 *
 * xterm measures its cell width ONCE, at open. --mono is "JetBrains Mono" with
 * font-display: swap, so a window whose font lost the race measured the
 * fallback (8.8px vs 9.6px at 16px), fitted ~9% too many columns (112 instead
 * of 103 at 1020px), and every full-width line ran ~10px past the text box.
 * solo.js now re-measures when the face arrives. This probe delays the font
 * download and asserts a full-width line still fits.
 *
 * WHY HEADLESS EDGE IS ENOUGH HERE: Playwright launches headless browsers with
 * --hide-scrollbars, which is what makes them report overlay scrollbars. Drop
 * that one default arg and headless Edge paints CLASSIC 15px bars, like the
 * desktop — asserted below, so the probe says so if that ever stops being
 * true. No visible window opens on Owner's desktop.
 *
 * Scratch engine on P(90) + real scratch broker on P(91) (a shell has to print
 * a full-width line), temp table, childEnv(). Not in `npm test`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, scratchShell } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(90);
const BROKER_PORT = P(91);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-font-late';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'wb-font-late-'));
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] });
const tsx = `file://${join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')}`;

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}
const api = (path, init = {}) =>
  fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } });

let log = '';
const procs = [];
function boot(args, env) {
  const p = spawn(process.execPath, ['--import', tsx, ...args], { cwd: REPO_ROOT, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  procs.push(p);
}
async function waitUp(url) {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(url)).ok) { return true; } } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

/** Open the solo page with the font held back `delayMs`, print a line longer
 *  than the terminal, and measure its first full row against the text box. */
async function run(browser, recipeId, delayMs) {
  const ctx = await browser.newContext({ viewport: { width: 1020, height: 940 } });
  if (delayMs) {
    await ctx.route('**/jetbrainsmono.woff2', async (route) => { await sleep(delayMs); await route.continue(); });
  }
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
    f.submit();
  }, TOKEN);
  await page.waitForURL((u) => !new URL(u).pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {});
  await page.goto(`${BASE}/solo.html?recipe=${recipeId}`, { waitUntil: 'domcontentloaded' });
  await sleep(delayMs + 4000); // the font lands, the shell is up
  await page.click('#term .xterm-screen');
  await sleep(500);
  await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('0123456789'*40)" : "printf '0123456789%.0s' $(seq 40); echo", { delay: 5 });
  await page.keyboard.press('Enter');
  await sleep(1500);
  const m = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;width:200px;height:50px;overflow-y:scroll';
    probe.innerHTML = '<div style="height:200px"></div>';
    document.body.appendChild(probe);
    const nativeBar = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    const rows = [...document.querySelectorAll('#term .xterm-rows > div')];
    const r = rows.find((x) => /^0123456789012/.test(x.textContent || ''));
    const sc = document.querySelector('#term .xterm-screen').getBoundingClientRect();
    if (!r) {
      return { nativeBar, found: false };
    }
    const range = document.createRange();
    range.selectNodeContents(r);
    const right = Math.max(...[...range.getClientRects()].map((q) => q.right));
    return { nativeBar, found: true, chars: (r.textContent || '').trimEnd().length, overflowPx: Math.round(right - sc.right) };
  });
  await ctx.close();
  return m;
}

let browser = null;
try {
  await assertFree(PORT, 'font-late.probe.mjs');
  await assertFree(BROKER_PORT, 'font-late.probe.mjs');
  boot(['node_modules/pty-broker/src/main.ts'], { PTY_BROKER_PORT: String(BROKER_PORT) });
  ok(await waitUp(`http://127.0.0.1:${BROKER_PORT}/health`), `scratch broker on :${BROKER_PORT}`);
  boot(['src/server/index.ts'], {
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1',
    HARBOR_WB_TABLE: join(tmp, 'mapping.db'),
    HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_TOKEN_FILE: join(tmp, 'engine.token'),
    HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_WINDOW_HOST: 'http://127.0.0.1:9',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '',
    HARBOR_WB_BROKER_PORT: String(BROKER_PORT), HARBOR_WB_BROKER_AUTOSTART: '0',
    HARBOR_WB_TARGETS: TARGETS, HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'claude-projects'),
  });
  const up = await waitUp(`${BASE}/health`);
  ok(up, `scratch engine on :${PORT}`, up ? undefined : log.slice(-600));
  if (!up) {
    throw new Error('engine down');
  }
  const recipe = (await (await api('/api/recipes', {
    method: 'POST',
    body: JSON.stringify({ name: 'Font Late Probe', target: 'local', vendor: 'cli-manager', projectDir: tmp }),
  })).json()).recipe;

  /* channel msedge where it exists (the desktop's engine); bundled Chromium elsewhere */
  const launch = { headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] };
  browser = await chromium.launch({ ...launch, channel: 'msedge' }).catch(() => chromium.launch(launch));
  console.log(`  (browser ${browser.version()})`);

  console.log('\n[font on time]');
  const a = await run(browser, recipe.id, 0);
  ok(a.nativeBar > 0, `classic scrollbars are on in this browser (${a.nativeBar}px) - the desktop condition`, a);
  ok(a.found, 'a full-width row was printed', a);
  ok(a.found && a.overflowPx <= 1, `the full row stays inside the text box (overflow ${a.overflowPx}px)`, a);

  console.log('\n[font 4 s late - the race Owner hit]');
  const b = await run(browser, recipe.id, 4000);
  ok(b.found, 'a full-width row was printed', b);
  ok(b.found && b.overflowPx <= 1, `THE FIX: the full row stays inside the text box (overflow ${b.overflowPx}px)`, b);
  ok(b.found && a.found && b.chars === a.chars, `the late-font window fits the SAME column count (${b.chars} vs ${a.chars})`, { a: a.chars, b: b.chars });
} catch (e) {
  failed += 1;
  console.log(`\n✗ EXCEPTION: ${e && e.stack ? e.stack : e}`);
  console.log(`--- engine/broker log tail ---\n${log.slice(-900)}`);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  for (const p of procs) {
    p.kill('SIGKILL');
  }
  await sleep(300);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* the engine's table may still be held open on Windows */
  }
}

console.log(`\n${'='.repeat(40)}\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
