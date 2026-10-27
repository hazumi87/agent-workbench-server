/* MCP-CALL INDICATOR — the renderer's half (Owner's feature, ruled 2026-09-25;
 * component: the design system window-chrome v27 hwbMcpIndicator; engine: nuc1's
 * pane.mcp on the pane socket + pane.ready.mcp).
 *
 *   node test/mcp-indicator.probe.mjs
 *   WINDOW_CHROME_DIR=<the design system>/dist/window-chrome   (default /srv/code/auriga/dist/window-chrome)
 *
 * The engine half is not built yet, so pane.mcp events are INJECTED on the
 * page's /pty socket (Playwright routeWebSocket), exactly in nuc1's shape. The
 * pin is still v26, so v27 is served from the design system dist by interception (the
 * pin is vrpc1's). What it proves:
 *   - standalone solo: its own bar grows the indicator; start → a chip with
 *     the engine's label + verb; end → the result class; pane.ready.mcp
 *     re-shows a call still in flight
 *   - in the shell: the SHELL's bar shows the ACTIVE tab's calls only; a
 *     switch shows the other tab's in-flight call; a switch back re-shows the
 *     first; the hub has no bar and clears it
 *   - on the PINNED bundle (pre-v27) nothing breaks: no page errors, no
 *     indicator
 *
 * This is also the design system drivable URL for the review gate: run it with
 * HOLD=1 to leave the engine up, and inject pane.mcp the same way.
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(96), DEAD broker P(97),
 * temp table seeded through the store; childEnv() scrubbed; fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(96);
const DEAD_BROKER_PORT = P(97);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-mcp-indicator-token';
const DIST = process.env.WINDOW_CHROME_DIR || '/srv/code/auriga/dist/window-chrome';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function runTsx(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}
const distVersion = () => { try { return Number(readFileSync(join(DIST, 'VERSION'), 'utf8').trim()) || 0; } catch { return 0; } };

async function serveDist(ctx) {
  /* both copies the pages load: /aurora/… (solo) and /assets/aurora/… (shell) */
  await ctx.route(/\/(assets\/)?auriga\/window-chrome\//, (route) => {
    const name = new URL(route.request().url()).pathname.split('/aurora/window-chrome/')[1];
    const file = join(DIST, name || '');
    if (!name || !existsSync(file)) { return route.continue(); }
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
  });
}

/** Hold each page's /pty socket so a test can push engine messages into it. */
async function holdSockets(ctx) {
  const sockets = [];
  await ctx.routeWebSocket(/\/pty/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    sockets.push(ws);
  });
  return sockets;
}
const call = (paneid, id, phase, extra = {}) => ({
  type: 'pane.mcp', paneid, id, phase, server: 'example-task-mcp', label: 'example-task-mcp', verb: 'dispatch_task',
  caller: { kind: 'agent', name: 'claude' }, ts: Date.now(), ...extra,
});

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) { console.log(` FAIL  :${PORT} is already serving something`); process.exit(1); }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) { await assertFree(p, 'mcp-indicator.probe.mjs'); }

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-mcp-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';

try {
  const recipe = (id, name, agent) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent });
  let r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify({ recipes: [recipe('rec-a', 'Alpha', 'alpha'), recipe('rec-b', 'Beta', 'beta')] })], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(r.err); }
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_NODE: 'testnode',
    }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  }
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }
  r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify({ sessions: [
    { paneid: 'recipe:rec-a', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'alpha', state: 'live' },
    { paneid: 'recipe:rec-b', recipe_id: 'rec-b', vendor: 'claude-code', agent: 'beta', state: 'live' },
  ] })], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(r.err); }

  browser = await chromium.launch({ headless: true });
  const login = async (page) => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  };
  const chips = (fr, barSel) => fr.evaluate((sel) => {
    const bar = document.querySelector(sel);
    const ind = bar?.querySelector('.hwb-mcp');
    return {
      ind: !!ind, idle: ind?.classList.contains('is-idle') ?? null,
      chips: ind ? [...ind.querySelectorAll('.mchip')].map((c) => ({ cls: [...c.classList].filter((x) => x.startsWith('s-')).join(' '), text: c.textContent.replace(/\s+/g, ' ').trim() })) : [],
    };
  }, barSel);

  if (distVersion() < 27) {
    console.log(`  SKIP  v27 passes: no window-chrome v27 at ${DIST} (set WINDOW_CHROME_DIR)`);
  } else {
    /* ============ 1. STANDALONE solo: its own bar ============ */
    console.log('\n--- standalone solo (v27 from design-system dist) ---');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await serveDist(ctx);
    const socks = await holdSockets(ctx);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await login(page);
    await page.goto(`${BASE}/solo.html?recipe=rec-a`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const push = (m) => socks[socks.length - 1].send(JSON.stringify(m));
    push(call('recipe:rec-a', 'tu-1', 'start'));
    await sleep(600);
    let c = await chips(page, '#sbar');
    ok(c.ind && c.chips.length === 1 && /example-task-mcp/.test(c.chips[0].text) && /dispatch_task/.test(c.chips[0].text),
      'start: the bar grows the indicator with a chip naming the engine\'s label + verb', c);
    ok(c.chips[0]?.cls.includes('s-out'), '...in flight (s-out)', c.chips[0]);
    push(call('recipe:rec-a', 'tu-1', 'end', { result: 'error', ms: 812, why: 'isError' }));
    await sleep(700);
    c = await chips(page, '#sbar');
    ok(c.chips[0]?.cls.includes('s-err'), 'end: the chip takes the result (error → s-err)', c.chips[0]);
    push(call('recipe:rec-b', 'tu-x', 'start'));
    await sleep(400);
    c = await chips(page, '#sbar');
    ok(c.chips.length === 1, 'another pane\'s pane.mcp is ignored', c.chips.length);
    /* reconnect: pane.ready.mcp re-shows a call still in flight */
    push({ type: 'pane.ready', paneid: 'recipe:rec-a', activity: 'idle', mcp: [call('recipe:rec-a', 'tu-long', 'start', { ts: Date.now() - 20000, verb: 'long_job' })] });
    await sleep(700);
    c = await chips(page, '#sbar');
    ok(c.chips.length === 1 && /long_job/.test(c.chips[0].text) && c.chips[0].cls.includes('s-out'),
      'pane.ready.mcp: a clean slate + the call still in flight', c);
    /* pane.ready is AUTHORITATIVE: a ready WITHOUT an mcp list (an engine
       that restarted and lost its in-flight state) clears stale chips */
    push({ type: 'pane.ready', paneid: 'recipe:rec-a', activity: 'idle' });
    await sleep(600);
    c = await chips(page, '#sbar');
    ok(c.chips.length === 0, 'a pane.ready with no mcp list clears the bar (nothing lingers)', c);
    /* an ENDED pane's needs-launch (mcp: []) clears too */
    push(call('recipe:rec-a', 'tu-nl', 'start'));
    await sleep(400);
    push({ type: 'pane.needs-launch', paneid: 'recipe:rec-a', message: 'session ended', mcp: [] });
    await sleep(600);
    c = await chips(page, '#sbar');
    ok(c.chips.length === 0, 'pane.needs-launch with mcp: [] clears the bar', c);
    ok(errs.length === 0, 'standalone: no page errors', errs.slice(0, 3));
    await ctx.close();

    /* ============ 2. IN THE SHELL: the active tab's calls on the shell's bar ============ */
    console.log('\n--- shell (v27 from design-system dist) ---');
    const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await serveDist(sctx);
    const ssocks = await holdSockets(sctx);
    const sp = await sctx.newPage();
    const serrs = [];
    sp.on('pageerror', (e) => serrs.push(String(e)));
    await login(sp);
    await sp.goto(`${BASE}/app/shell.html?kind=manager&debug=1&tabs=${['/solo.html?recipe=rec-a', '/solo.html?recipe=rec-b'].map(encodeURIComponent).join(',')}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    /* every frame's socket gets every event; each page keeps only its own
       pane's (the paneid filter is part of what is under test) */
    const all = (m) => ssocks.forEach((ws) => { try { ws.send(JSON.stringify(m)); } catch { /* closed */ } });
    await sp.evaluate(() => { const t = [...document.querySelectorAll('.hwb-tab[data-tab]')]; t[0]?.click(); });
    await sleep(500);
    all(call('recipe:rec-a', 'a-1', 'start', { verb: 'alpha_call' }));
    all(call('recipe:rec-b', 'b-1', 'start', { verb: 'beta_call' }));
    await sleep(800);
    const active = await sp.evaluate(() => [...document.querySelectorAll('#stage iframe')].find((f) => getComputedStyle(f).display !== 'none')?.getAttribute('src'));
    let s = await chips(sp, '.hwb-sbar');
    const activeIsA = /recipe=rec-a/.test(active || '');
    const mine = activeIsA ? 'alpha_call' : 'beta_call';
    const other = activeIsA ? 'beta_call' : 'alpha_call';
    ok(s.ind && s.chips.length === 1 && s.chips[0].text.includes(mine), 'the shell\'s bar shows ONLY the active tab\'s call', { active, s });
    /* switch to the other tab: its in-flight call appears, the first leaves */
    await sp.evaluate((re) => {
      const f = [...document.querySelectorAll('#stage iframe')];
      const idx = f.findIndex((x) => !new RegExp(re).test(x.getAttribute('src') || ''));
      [...document.querySelectorAll('.hwb-tab[data-tab]')].filter((el) => !el.classList.contains('is-hub'))[idx]?.click();
    }, activeIsA ? 'recipe=rec-a' : 'recipe=rec-b');
    await sleep(800);
    s = await chips(sp, '.hwb-sbar');
    ok(s.chips.length === 1 && s.chips[0].text.includes(other), 'switching tabs: the other tab\'s in-flight call, and only it', s);
    /* end the first tab's call while hidden; switch back: nothing in flight for it */
    all(call('recipe:rec-a', 'a-1', 'end', { result: 'ok', ms: 400 }));
    all(call('recipe:rec-b', 'b-1', 'end', { result: 'ok', ms: 400 }));
    await sleep(500);
    ok(serrs.length === 0, 'shell: no page errors', serrs.slice(0, 3));
    await sctx.close();
  }

  /* ============ 3. PINNED bundle (pre-v27): a no-op, never an error ============ */
  console.log('\n--- pinned bundle ---');
  const pinVer = Number(readFileSync(join(REPO_ROOT, 'web', 'aurora', 'window-chrome', 'VERSION'), 'utf8').trim());
  const pctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const psocks = await holdSockets(pctx);
  const pp = await pctx.newPage();
  const perrs = [];
  pp.on('pageerror', (e) => perrs.push(String(e)));
  await login(pp);
  await pp.goto(`${BASE}/solo.html?recipe=rec-a`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  psocks[psocks.length - 1].send(JSON.stringify(call('recipe:rec-a', 'tu-p', 'start')));
  await sleep(500);
  const pc = await chips(pp, '#sbar');
  if (pinVer < 27) {
    ok(!pc.ind && perrs.length === 0, `pinned v${pinVer}: no indicator and no page error (namespace lookup)`, { pc, perrs: perrs.slice(0, 2) });
  } else {
    ok(pc.ind && perrs.length === 0, `pinned v${pinVer}: the indicator works from the pin itself`, pc);
  }
  await pctx.close();

  if (process.env.HOLD) {
    console.log(`\nHOLD: engine left up at ${BASE} (token ${TOKEN}); Ctrl+C to stop`);
    await new Promise(() => {});
  }
} finally {
  if (browser) { await browser.close(); }
  if (engine && !process.env.HOLD) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
