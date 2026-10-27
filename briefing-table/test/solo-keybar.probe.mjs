/* THE SOLO KEY BAR FOLLOWS THE SOFT KEYBOARD [web/solo-keybar-auto].
 *
 *   node test/solo-keybar.probe.mjs                      (WebKit; see BROWSER)
 *   PROBE_BROWSER=chromium node test/solo-keybar.probe.mjs
 *   SHOTS_DIR=<dir> node test/solo-keybar.probe.mjs      (the bar shown / hidden per size)
 *   WITH_TOUCH_SCROLL=1 node test/solo-keybar.probe.mjs  (then runs
 *     test/touch-scroll.probe.mjs against this probe's scratch engine;
 *     KEYBAR=0 skips the key bar checks and runs only that)
 *
 * Owner (2026-09-29): on a CLI tab on the phone the key bar (the keys a soft
 * keyboard lacks) shows BY ITSELF while the keyboard is up, sitting on the
 * keys; with the keyboard down there is no bar and no toggle; the toggle (a
 * chevron: "‹" hides, "›" shows), shown
 * only while the keyboard is up, collapses the bar until the keyboard goes
 * down. Keyboard detection is the room's (web/soft-keyboard.mjs).
 *
 * Proves, at 320x522 and 390x844 (isMobile + hasTouch, a visualViewport the
 * probe can shrink — no harness can raise a real soft keyboard):
 *   - keyboard down: no bar, no icon; and nothing focused the terminal on load
 *     (no programmatic focus on a coarse pointer)
 *   - keyboard up WITH NO EVENT, after every burst has run out: only the
 *     focused-field poll can see it; the bar opens within 1.2 s, its bottom on
 *     the visible viewport's bottom, the pane = the visible height, the
 *     terminal shorter than with the keyboard down and above the keys
 *   - a keyboard-height change with an event, and an iOS pan (offsetTop) with
 *     none: the bar follows
 *   - the keys send the right sequences (real taps through every page), and a
 *     tap on a key or the icon never takes focus off the terminal
 *   - collapse: the icon hides the bar and stays; a height change keeps it
 *     collapsed; keyboard down hides everything; the next keyboard-up opens
 *     the bar again
 *   - keyboard down with no event (focused): the poll hides it
 *   - a page LOADED with the keyboard already up (focus restored, height
 *     settling 400 ms later, no event): the bar is up within 1.2 s
 *
 * A PROBE, not in `npm test`. OWN scratch engine P(244) + LIVE scratch broker
 * P(245) (a local shell pane — never one of Owner's), temp table, scrubbed env.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv, scratchShell } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(244);
const BROKER_PORT = P(245);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-solo-keybar-token';
const SIZES = [[320, 522], [390, 844], [1366, 1024], [1024, 1366]]; // + the iPad, landscape and portrait: the bar follows the INPUT, not the width [ipad keypad]
const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

let failures = 0;
let passes = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined && !cond ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (cond) { passes += 1; } else { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* In-page, before any page script: the screen the phone reports, a
   visualViewport whose height/offset the probe changes with or without an
   event (room-ios.probe's harness), and a record of every `input` frame the
   page sends to the engine. */
const INIT = ([sw, sh, loadKb]) => {
  Object.defineProperty(window.screen, 'width', { get: () => sw });
  Object.defineProperty(window.screen, 'height', { get: () => sh });
  const real = window.visualViewport;
  const fake = new EventTarget();
  let kb = 0;
  let top = 0;
  /* LOADED WITH THE KEYBOARD UP: the terminal's field has focus as soon as it
     exists, the keys are still animating, and they settle 400 ms later — with
     no visualViewport event at any point */
  if (loadKb) {
    kb = Math.round(loadKb / 2);
    const grab = () => {
      const ta = document.querySelector('.xterm-helper-textarea');
      if (!ta) { setTimeout(grab, 15); return; }
      ta.focus();
      setTimeout(() => { kb = loadKb; window.__settledAt = performance.now(); }, 400);
    };
    document.addEventListener('DOMContentLoaded', grab);
  }
  Object.defineProperties(fake, {
    width: { get: () => (real ? real.width : window.innerWidth) },
    height: { get: () => (real ? real.height : window.innerHeight) - kb },
    scale: { get: () => (real ? real.scale : 1) },
    offsetTop: { get: () => (real ? real.offsetTop : 0) + top },
    offsetLeft: { get: () => (real ? real.offsetLeft : 0) },
    pageTop: { get: () => (real ? real.pageTop : 0) },
    pageLeft: { get: () => (real ? real.pageLeft : 0) },
  });
  real?.addEventListener('resize', () => fake.dispatchEvent(new Event('resize')));
  Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
  window.__vvSet = (o) => {
    if (typeof o.kb === 'number') { kb = o.kb; }
    if (typeof o.top === 'number') { top = o.top; }
    if (o.fire) { fake.dispatchEvent(new Event(o.fire)); }
  };
  window.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    try {
      const m = JSON.parse(d);
      if (m && m.type === 'input') { window.__sent.push(m.data); }
    } catch { /* not ours */ }
    return send.call(this, d);
  };
  window.__bar = () => {
    const v = window.visualViewport;
    const p = document.querySelector('.keypad');
    const g = p?.querySelector('.keypad-grid');
    const t = p?.querySelector('.keypad-toggle');
    const pr = p?.getBoundingClientRect();
    const tr = t?.getBoundingClientRect();
    const term = document.querySelector('.pane-term').getBoundingClientRect();
    const pane = document.querySelector('.pane').getBoundingClientRect();
    const r = (x) => (x === undefined ? null : Math.round(x));
    return {
      exists: !!p,
      auto: !!p?.classList.contains('kp-auto'),
      display: p ? getComputedStyle(p).display : null,
      open: !!p && !g.hidden && p.classList.contains('is-open'),
      padTop: r(pr?.top), padBottom: r(pr?.bottom), padLeft: r(pr?.left), padRight: r(pr?.right),
      toggleW: r(tr?.width), toggleBottom: r(tr?.bottom),
      vvTop: r(v.offsetTop), vvH: r(v.height), vvBottom: r(v.offsetTop + v.height),
      termBottom: r(term.bottom), termH: r(term.height),
      paneTop: r(pane.top), paneH: r(pane.height),
      kbUp: document.documentElement.classList.contains('kb-up'),
      vvhVar: document.documentElement.style.getPropertyValue('--vvh'),
      focused: document.activeElement?.className || document.activeElement?.tagName || null,
      innerW: window.innerWidth,
    };
  };
  /* bar up, open, on the keys; the pane is the visible viewport */
  window.__aligned = () => {
    const b = window.__bar();
    return b.display !== 'none' && b.open && Math.abs(b.padBottom - b.vvBottom) <= 4
      && Math.abs(b.paneH - b.vvH) <= 1 && Math.abs(b.paneTop - b.vvTop) <= 1 && b.termBottom <= b.vvBottom + 1;
  };
  window.__gone = () => window.__bar().display === 'none';
  /* the toggle: an SVG chevron (not a glyph), which way it points, its
     labels, and whether the drawing fits inside the button (IMG_7673) */
  window.__toggle = () => {
    const t = document.querySelector('.keypad .keypad-toggle');
    const svg = t?.querySelector(':scope > svg');
    const line = svg?.querySelector('polyline, path');
    const tr = t?.getBoundingClientRect();
    const sr = svg?.getBoundingClientRect();
    const pts = (line?.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
    /* the vertex x against the ends' x: a vertex LEFT of the ends is "‹" */
    const dir = pts.length === 6 ? (pts[2] < pts[0] && pts[2] < pts[4] ? 'left' : pts[2] > pts[0] && pts[2] > pts[4] ? 'right' : 'flat') : null;
    const cs = line ? getComputedStyle(line) : null;
    return {
      svg: !!svg,
      text: (t?.textContent || '').trim(),
      dir,
      stroke: cs?.stroke || null, strokeW: cs?.strokeWidth || null, cap: cs?.strokeLinecap || null,
      color: t ? getComputedStyle(t).color : null,
      label: t?.getAttribute('aria-label') || null,
      expanded: t?.getAttribute('aria-expanded') || null,
      inside: !!(tr && sr && sr.width > 0 && sr.left >= tr.left && sr.right <= tr.right && sr.top >= tr.top && sr.bottom <= tr.bottom),
      centred: !!(tr && sr) && Math.abs((sr.left + sr.right) / 2 - (tr.left + tr.right) / 2) <= 1 && Math.abs((sr.top + sr.bottom) / 2 - (tr.top + tr.bottom) / 2) <= 1,
      noOverflow: !!t && t.scrollWidth <= t.clientWidth && t.scrollHeight <= t.clientHeight,
      box: tr ? [Math.round(tr.width), Math.round(tr.height)] : null,
      key: (() => { const k = document.querySelector('.keypad-keys button:not([hidden])'); if (!k) { return null; } const r = k.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    };
  };
  window.__until = (name, limit) => new Promise((res) => {
    const t0 = performance.now();
    const tick = () => {
      if (window[name]()) { res(Math.round(performance.now() - t0)); return; }
      if (performance.now() - t0 > limit) { res(-1); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
};

const procs = [];
let log = '';
function boot(args, env) {
  const p = spawn(process.execPath, ['--import', loaderArg, ...args], { cwd: REPO_ROOT, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  procs.push(p);
  return p;
}
async function waitUp(url) {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(url)).ok) { return true; } } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, BROKER_PORT]) {
  await assertFree(p, 'solo-keybar.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-solo-keybar-'));
let browser = null;
let browserName = process.env.PROBE_BROWSER === 'chromium' ? 'chromium' : 'webkit';
const pageErrors = [];
try {
  boot(['node_modules/pty-broker/src/main.ts'], { PTY_BROKER_PORT: String(BROKER_PORT) });
  ok(await waitUp(`http://127.0.0.1:${BROKER_PORT}/health`), `scratch broker on :${BROKER_PORT}`);
  boot([join('src', 'server', 'index.ts')], {
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1',
    HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
    HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
    HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_WINDOW_HOST: 'http://127.0.0.1:9',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '',
    HARBOR_WB_BROKER_PORT: String(BROKER_PORT), HARBOR_WB_BROKER_AUTOSTART: '0',
    HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] }),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
  });
  const up = await waitUp(`${BASE}/health`);
  ok(up, `scratch engine on :${PORT}`, up ? undefined : log.slice(-600));
  if (!up) { throw new Error('engine down'); }
  const api = (path, init = {}) => fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } });
  /* the OneColor Probe pattern: a throwaway shell recipe on the scratch engine */
  const recipe = (await (await api('/api/recipes', {
    method: 'POST', body: JSON.stringify({ name: 'OneColor Probe', target: 'local', vendor: 'cli-manager', projectDir: tmpDir }),
  })).json()).recipe;
  ok(!!recipe?.id, 'setup: a scratch shell recipe');

  try {
    browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true });
  } catch (e) {
    console.log(`\n  *** WEBKIT COULD NOT LAUNCH ON THIS HOST — running on CHROMIUM instead ***\n  ${String(e.message || e).split('\n')[0]}\n`);
    browserName = 'chromium';
    browser = await chromium.launch({ headless: true });
  }
  console.log(`[browser: ${browserName}]`);
  const login = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const lp = await login.newPage();
  await lp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await lp.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([lp.waitForNavigation().catch(() => {}), lp.click('form button:visible')]);
  const storage = await login.storageState();
  await login.close();
  const SOLO = `${BASE}/solo.html?recipe=${recipe.id}&shell=0`; // &shell=0: a touch tablet would otherwise open it in the shell's tab strip [ipad tabs]

  const openPhone = async (w, h, loadKb = 0) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, storageState: storage });
    await ctx.addInitScript(INIT, [w, h, loadKb]);
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => pageErrors.push(`${w}: ${e.message}`));
    await pg.goto(SOLO, { waitUntil: 'domcontentloaded' });
    return { ctx, pg };
  };

  for (const [w, h] of process.env.KEYBAR === '0' ? [] : SIZES) { // KEYBAR=0: only the touch-scroll ride-along (a baseline run)
    console.log(`\n[${w}x${h}]`);
    const KB = Math.round(h * 0.52); // 268 at 522, a phone-sized keyboard at 844
    const { ctx, pg } = await openPhone(w, h);
    await sleep(2200); // the attach, the first fit, the install bursts
    const bar = () => pg.evaluate(() => window.__bar());
    const until = (name, limit = 1200) => pg.evaluate(([n, l]) => window.__until(n, l), [name, limit]);

    /* 1. keyboard down */
    const b0 = await bar();
    ok(b0.exists && b0.auto, `${w}: the pad is built, in auto mode (coarse pointer)`, b0);
    ok(b0.display === 'none' && !b0.toggleW, `${w}: keyboard down: no bar and no icon`, b0);
    ok(!/xterm-helper-textarea/.test(b0.focused || ''), `${w}: nothing focused the terminal on load (no programmatic focus on touch)`, b0);
    ok(await pg.evaluate(() => { const p = document.querySelector('.pane-paused'); return !p || p.hidden; }), `${w}: this page holds control (no prompt)`);

    /* 2. the field gets focus (xterm's tap); the keys arrive LATE with no
          event, after every burst has run out: only the poll can see them */
    await pg.focus('.xterm-helper-textarea');
    await sleep(1300);
    ok(await pg.evaluate(() => window.__gone()), `${w}: focus alone (no keyboard yet) shows nothing`, await bar());
    await pg.evaluate((k) => window.__vvSet({ kb: k }), KB);
    let ms = await until('__aligned');
    const b1 = await bar();
    const t1 = await pg.evaluate(() => window.__toggle());
    if (process.env.SHOTS_DIR) { await pg.screenshot({ path: join(process.env.SHOTS_DIR, `keybar-${w}-shown.png`) }); }
    ok(t1.svg && t1.text === '' && t1.dir === 'left' && t1.label === 'Hide keys' && t1.expanded === 'true',
      `${w}: bar shown: the toggle is an SVG "‹" (no glyph), "Hide keys", aria-expanded true`, t1);
    ok(t1.stroke === t1.color && parseFloat(t1.strokeW) === 2 && t1.cap === 'round', `${w}: stroked in currentColor, 2px, round caps`, t1);
    ok(t1.inside && t1.centred && t1.noOverflow && t1.box[0] === 40 && t1.box[1] === 40,
      `${w}: the chevron sits centred inside a 40x40 button (like the keys${t1.key ? ` ${t1.key.join('x')}` : ''}), nothing clipped`, t1);
    ok(ms >= 0 && ms <= 1200, `${w}: keyboard up with NO event: the bar opens on the keys in ${ms} ms (<= 1200, the poll)`, b1);
    ok(Math.abs(b1.padBottom - b1.vvBottom) <= 4, `${w}: bar bottom ${b1.padBottom} sits at the visible bottom ${b1.vvBottom}`, b1);
    ok(b1.termH < b0.termH && b1.termBottom <= b1.vvBottom + 1 && b1.paneH === b1.vvH,
      `${w}: the terminal shrinks with the keyboard (${b0.termH} -> ${b1.termH}px, pane ${b1.paneH} = visible ${b1.vvH})`, { b0, b1 });
    ok(b1.padLeft >= 0 && b1.padRight <= b1.innerW, `${w}: the bar is across the glass (${b1.padLeft}..${b1.padRight} of ${b1.innerW})`, b1);

    /* 3. the predictive bar comes and goes (an event), then an iOS pan (none) */
    await pg.evaluate((k) => window.__vvSet({ kb: k, fire: 'resize' }), KB + 44);
    ms = await until('__aligned', 300);
    ok(ms >= 0, `${w}: a height change with an event: follows in ${ms} ms`, await bar());
    await sleep(1300);
    await pg.evaluate(() => window.__vvSet({ top: 40 }));
    ms = await until('__aligned');
    const b3 = await bar();
    ok(ms >= 0 && ms <= 1200 && b3.paneTop === 40, `${w}: an iOS pan to offsetTop 40 (no event): the pane and bar follow in ${ms} ms (bar bottom ${b3.padBottom} = ${b3.vvBottom})`, b3);
    await pg.evaluate((k) => window.__vvSet({ top: 0, kb: k, fire: 'scroll' }), KB);
    await until('__aligned', 300);

    /* 4. the keys send what a keyboard would — real taps, page by page */
    await pg.evaluate(() => { window.__sent.length = 0; });
    const want = await pg.evaluate(() => [...document.querySelectorAll('.keypad-keys button[data-seq]')].map((b) => b.dataset.seq));
    const pages = await pg.evaluate(() => { const m = /^(\d+)\/(\d+)$/.exec(document.querySelector('.kp-nav')?.textContent?.trim() || ''); return m ? Number(m[2]) : 1; });
    const tapped = [];
    for (let i = 0; i < pages; i += 1) {
      const vis = await pg.evaluate(() => [...document.querySelectorAll('.keypad-keys button')].map((b, j) => [j, !b.hidden && !!b.dataset.seq]).filter(([, v]) => v).map(([j]) => j));
      for (const j of vis) {
        await pg.tap(`.keypad-keys button:nth-child(${j + 1})`);
        tapped.push(j);
        await sleep(60);
      }
      if (pages > 1) { await pg.tap('.keypad .kp-nav'); await sleep(150); }
    }
    await sleep(200);
    const sent = await pg.evaluate(() => window.__sent.slice());
    ok(tapped.length === want.length && JSON.stringify(sent) === JSON.stringify(want),
      `${w}: ${tapped.length} keys over ${pages} page(s) sent exactly their sequences (esc, tab, enter, ctrl+enter, backtick, arrows)`, { sent, want });
    ok(/xterm-helper-textarea/.test((await bar()).focused || ''), `${w}: the terminal kept focus through the taps (the keyboard stays up)`, await bar());

    /* 5. collapse, and it lasts only until the keyboard goes down */
    await pg.tap('.keypad .keypad-toggle');
    await sleep(250);
    const c1 = await bar();
    ok(!c1.open && c1.display !== 'none' && c1.toggleW > 0 && c1.toggleBottom <= c1.vvBottom + 1, `${w}: the toggle collapses the bar and stays, above the keys`, c1);
    ok(/xterm-helper-textarea/.test(c1.focused || ''), `${w}: ...without taking focus off the terminal`, c1);
    const t2 = await pg.evaluate(() => window.__toggle());
    if (process.env.SHOTS_DIR) { await pg.screenshot({ path: join(process.env.SHOTS_DIR, `keybar-${w}-hidden.png`) }); }
    ok(t2.svg && t2.text === '' && t2.dir === 'right' && t2.label === 'Show keys' && t2.expanded === 'false' && t2.inside && t2.centred && t2.noOverflow,
      `${w}: bar hidden: the toggle is an SVG "›", "Show keys", aria-expanded false, centred and unclipped`, t2);
    await pg.evaluate((k) => window.__vvSet({ kb: k, fire: 'resize' }), KB + 44);
    await sleep(400);
    ok(!(await bar()).open, `${w}: a height change keeps it collapsed`, await bar());
    await pg.evaluate(() => window.__vvSet({ kb: 0, fire: 'resize' }));
    ms = await until('__gone', 400);
    ok(ms >= 0, `${w}: keyboard down: bar and icon gone (${ms} ms)`, await bar());
    await sleep(300);
    await pg.evaluate((k) => window.__vvSet({ kb: k, fire: 'resize' }), KB);
    ms = await until('__aligned', 400);
    ok(ms >= 0, `${w}: the next keyboard-up opens the bar again (${ms} ms)`, await bar());

    /* 6. keyboard down with NO event while still focused: the poll hides it */
    await sleep(1300);
    await pg.evaluate(() => window.__vvSet({ kb: 0 }));
    ms = await until('__gone');
    ok(ms >= 0 && ms <= 1200, `${w}: keyboard down with no event: hidden in ${ms} ms (the poll)`, await bar());
    const bDown = await bar();
    ok(bDown.vvhVar === '' && Math.abs(bDown.paneH - h) <= 1, `${w}: --vvh cleared, the pane is full height again (${bDown.paneH})`, bDown);
    await ctx.close();

    /* 7. a page LOADED with the keyboard already up */
    const { ctx: c2, pg: p2 } = await openPhone(w, h, KB);
    const r = await p2.evaluate(() => new Promise((res) => {
      const wait = () => {
        if (window.__settledAt === undefined) { setTimeout(wait, 20); return; }
        const t0 = window.__settledAt;
        const tick = () => {
          if (window.__aligned()) { res({ ms: Math.round(performance.now() - t0) }); return; }
          if (performance.now() - t0 > 1200) { res({ ms: -1 }); return; }
          requestAnimationFrame(tick);
        };
        tick();
      };
      wait();
    }));
    ok(r.ms >= 0 && r.ms <= 1200, `${w}: loaded with the keys up (focus restored, height settling 400 ms later, no event): the bar is up ${r.ms} ms after they settle`, await p2.evaluate(() => window.__bar()));
    await c2.close();
  }

  ok(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3));

  /* the existing viewer-scrim / touch-scroll probe, against THIS scratch
     engine and a shell pane on it (never the live engine) */
  if (process.env.WITH_TOUCH_SCROLL === '1') {
    console.log('\n[touch-scroll.probe.mjs against this scratch engine]');
    /* its OWN pane: the key taps above left the first shell inside an open
       backtick, which would swallow the history it types */
    const fresh = (await (await api('/api/recipes', {
      method: 'POST', body: JSON.stringify({ name: 'OneColor Probe (scroll)', target: 'local', vendor: 'cli-manager', projectDir: tmpDir }),
    })).json()).recipe;
    const code = await new Promise((res) => {
      const p = spawn(process.execPath, [join('test', 'touch-scroll.probe.mjs')], {
        cwd: REPO_ROOT, stdio: 'inherit',
        env: { ...process.env, PROBE_BASE: BASE, PROBE_TOKEN: TOKEN, PROBE_RECIPE: fresh.id },
      });
      p.on('exit', res);
    });
    ok(code === 0, `touch-scroll.probe.mjs exited ${code}`);
  }
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`, log.slice(-400));
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  await sleep(300);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* the engine may still hold the db */ }
}
console.log(`\n${failures ? `FAIL ${failures}` : 'PASS'} (${passes} ok) [${browserName}]`);
process.exit(failures ? 1 : 0);
