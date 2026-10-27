/* THE ROOM PAGE ON AN IPHONE: the frame is locked to the glass [web/room-ios-lock].
 *
 *   node test/room-ios.probe.mjs                      (WebKit; see BROWSER below)
 *   PROBE_BROWSER=chromium node test/room-ios.probe.mjs
 *   SHOTS_DIR=<dir> node test/room-ios.probe.mjs      (a screenshot per width)
 *
 * Owner (2026-09-28, iPhone, Edge-on-iOS = WebKit): the room's OUTER frame moved
 * - the inner chat scrolled, but the whole page scrolled and resized too, and
 * the room drew shrunk to ~70% of the screen with black around it: the layout
 * was WIDER than the viewport, so iOS zoomed out to fit it.
 *
 * Proves, at 320 / 375 / 390 / 430 (WebKit, isMobile + hasTouch, window.screen
 * faked to the viewport as the other phone probes do), on a room with seven
 * seats and long handles, a long room name, long unbroken words, links, tool
 * link rows, sent attachments, image-link thumbnails (one very wide image, and a
 * six-image set), a draft tray and the room art:
 *   - the document never overflows sideways (scrollingElement.scrollWidth <=
 *     innerWidth) on the line, with the Agents sheet up, with an agent layer
 *     open and with the settings (preview) layer open; the offenders are
 *     NAMED when it does
 *   - html/body do not scroll: nothing to scroll (scrollHeight <= innerHeight),
 *     and a wheel over the header or the line and a scrollTo leave them at 0
 *   - #lineScroll DOES scroll
 *   - the zoom blockers: a quick second tap's touchend is cancelled (double-tap
 *     zoom), a two-finger touchstart and gesturestart are cancelled (pinch), a
 *     one-finger touchstart is NOT (the line's own scroll), and the scale stays 1
 *   - the soft keyboard (a visualViewport shrink, faked): --vvh is set, body
 *     fits the visible height and the composer stays above the keys; keyboard
 *     down clears --vvh again
 *   - the page reports to /api/diag/viewport (page: 'room', numbers included)
 *   - DISPLAY ZOOM (innerWidth 398 against screen.width 320, the 2026-09-01
 *     phone): screen-clamp pins the root box to 320 and nothing draws past it
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(232), DEAD broker P(233).
 *
 * BROWSER: WebKit by default (the engine iOS runs). If WebKit cannot launch on
 * this host (the server lacks its system libraries) the probe says so LOUDLY and
 * runs on Chromium; the verdict line names the browser that actually ran.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { PNG } from 'pngjs';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(232);
const DEAD_BROKER_PORT = P(233);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-ios-token';
const SHOTS = process.env.SHOTS_DIR || '';
const WIDTHS = [[320, 568], [375, 667], [390, 844], [430, 932]];

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

/* In-page, before any page script: the screen the phone reports, and a
   visualViewport whose height the probe can shrink (the soft keyboard; no
   harness can raise a real one). Scale and offsets stay the real ones. */
const INIT = ([sw, sh, loadKb]) => {
  Object.defineProperty(window.screen, 'width', { get: () => sw });
  Object.defineProperty(window.screen, 'height', { get: () => sh });
  const real = window.visualViewport;
  const fake = new EventTarget();
  let kb = 0;
  let top = 0;
  /* LOADED WITH THE KEYBOARD UP (iOS restores focus + keys across a refresh):
     the field has focus at DOMContentLoaded, the keys are still animating
     (an intermediate height), and they settle 400 ms later — with no
     visualViewport event at any point */
  if (loadKb) {
    kb = Math.round(loadKb / 2);
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('input')?.focus();
      setTimeout(() => { kb = loadKb; window.__settledAt = performance.now(); }, 400);
    });
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
  window.__kb = (px) => { kb = px; fake.dispatchEvent(new Event('resize')); };
  /* the iOS sequences: change the visual viewport WITH or WITHOUT an event */
  window.__vvSet = (o) => {
    if (typeof o.kb === 'number') { kb = o.kb; }
    if (typeof o.top === 'number') { top = o.top; }
    if (o.fire) { fake.dispatchEvent(new Event(o.fire)); }
  };
  /* the room sits in the visible viewport: body = [offsetTop, offsetTop +
     height] with the composer at its bottom (keyboard up), or the full page
     with no --vvh (keyboard down) */
  window.__fits = () => {
    const v = window.visualViewport;
    const b = document.body.getBoundingClientRect();
    const c = document.getElementById('compose').getBoundingClientRect();
    if (window.innerHeight - v.height > 80) {
      return Math.abs(b.height - v.height) <= 1 && Math.abs(b.top - v.offsetTop) <= 1 && Math.abs(c.bottom - (v.offsetTop + v.height)) <= 2;
    }
    return document.documentElement.style.getPropertyValue('--vvh') === '' && Math.abs(b.height - window.innerHeight) <= 1 && Math.abs(b.top) <= 1;
  };
  /* ms until __fits() holds (checked every frame), or -1 past the limit */
  window.__until = (limit) => new Promise((res) => {
    const t0 = performance.now();
    const tick = () => {
      if (window.__fits()) { res(Math.round(performance.now() - t0)); return; }
      if (performance.now() - t0 > limit) { res(-1); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
  window.__geom = () => {
    const v = window.visualViewport;
    const b = document.body.getBoundingClientRect();
    const c = document.getElementById('compose').getBoundingClientRect();
    const hd = document.querySelector('.ph-hdr').getBoundingClientRect();
    return { vvH: v.height, vvTop: v.offsetTop, vvh: document.documentElement.style.getPropertyValue('--vvh'), vvTopVar: document.documentElement.style.getPropertyValue('--vv-top'), bodyTop: Math.round(b.top), bodyH: Math.round(b.height), composeBottom: Math.round(c.bottom), hdrTop: Math.round(hd.top), focused: document.activeElement?.id || document.activeElement?.tagName };
  };
  /* what the LAST listener saw: a bubble listener on window runs after the
     page's own capture/bubble handlers, so defaultPrevented is their verdict */
  window.__seen = [];
  for (const t of ['touchstart', 'touchend', 'gesturestart']) {
    window.addEventListener(t, (e) => window.__seen.push([t, e.touches ? e.touches.length : null, e.defaultPrevented]));
  }
  /* The OFFENDERS: the outermost elements whose box reaches past the layout
     viewport's right edge, skipping anything inside a box that clips sideways
     (a scroller or overflow:hidden). This names what widened the page. */
  window.__offenders = () => {
    const W = window.innerWidth;
    const out = [];
    const clipped = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== 'visible') { return true; }
      }
      return false;
    };
    const walk = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') { return; }
      const r = el.getBoundingClientRect();
      if (r.width && r.right > W + 0.5 && !clipped(el) && cs.position !== 'fixed') {
        out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
        return;
      }
      for (const c of el.children) { walk(c); }
    };
    walk(document.body);
    return out.slice(0, 12);
  };
  window.__frame = () => {
    const se = document.scrollingElement;
    return {
      inner: [window.innerWidth, window.innerHeight],
      scrollW: se.scrollWidth,
      scrollH: se.scrollHeight,
      bodyScrollW: document.body.scrollWidth,
      top: se.scrollTop,
      left: se.scrollLeft,
      bodyTop: document.body.scrollTop,
      bodyLeft: document.body.scrollLeft,
      winY: window.scrollY,
      winX: window.scrollX,
    };
  };
};

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-ios.probe.mjs');
}
if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); }

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-ios-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let browserName = process.env.PROBE_BROWSER === 'chromium' ? 'chromium' : 'webkit';
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

/* seven seats, several with long handles (the strip in Owner's screenshot) */
const AGENTS = [
  ['leadp', '#0dab49'],
  ['homehub', '#b5651d'],
  ['harbor', '#1f5fbf'],
  ['voice-svc-interaction-bridge', '#8a2be2'],
  ['briefing-table-engine-workbench', '#0317b0'],
  ['image-studio-design-reviewer', '#ba0d0d'],
  ['auriga', '#0a8f8f'],
];
const LONG_ROOM = 'Voice Interaction and the Image Studio design review workroom';
const STRIPES = Array.from({ length: 25 }, (_, i) => `<rect x="${i * 4}" y="0" width="2" height="100"/>`).join('');
const ART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${STRIPES}</svg>`;

try {
  const recipe = (agent, color) => ({ id: `rec-${agent}`, name: agent, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: AGENTS.map(([a, c]) => recipe(a, c)) });
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_NODE: 'testnode',
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

  const pane = (a) => `recipe:rec-${a}`;
  const post = await seed({
    sessions: AGENTS.slice(0, 5).map(([a]) => ({ paneid: pane(a), recipe_id: `rec-${a}`, vendor: 'claude-code', agent: a, state: 'live' })),
    rooms: [{ name: LONG_ROOM, seats: AGENTS.map(([a], i) => ({ handle: a, recipe_id: `rec-${a}`, occupant: i < 5 ? pane(a) : null })) }],
  });
  const R = post.rooms[0].id;
  const bearer = (path, init = {}) => fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });

  try {
    browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true });
  } catch (e) {
    console.log(`\n  *** WEBKIT COULD NOT LAUNCH ON THIS HOST — running on CHROMIUM instead ***\n  ${String(e.message || e).split('\n')[0]}\n`);
    browserName = 'chromium';
    browser = await chromium.launch({ headless: true });
  }
  console.log(`[browser: ${browserName}]`);
  const login = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const lp = await login.newPage();
  await lp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await lp.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([lp.waitForNavigation().catch(() => {}), lp.click('form button:visible')]);
  const storage = await login.storageState();
  const cookie = (await login.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const asUser = (path, init = {}) => fetch(BASE + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers || {}) } });

  const made = await (await bearer('/api/logos', { method: 'POST', body: JSON.stringify({ name: 'Stripes', svg: ART_SVG }) })).json();
  const art = await asUser(`/api/rooms/${R}/settings`, { method: 'PATCH', body: JSON.stringify({ art: `lib:${made?.logo?.id}` }) });
  ok(art.status === 200, 'setup: the room wears art', art.status);

  /* the line: long words, links, facts, and lines the page is told carry
     tool links / attachments (injected into the GET below: the engine only
     stores links for a registered app, and a sent file needs an upload) */
  const URL_LONG = 'https://host.example.ts.net:8443/api/rooms/5f2c9a/assets/raw/a-very-long-file-name-without-any-spaces-at-all-to-break-on.png?download=1&v=20260928';
  const PATH_LONG = '/srv/code/briefing-table/web/room-tool-links.mjs:::supercalifragilisticexpialidociousandthensomemoretokenwithoutbreaks';
  const texts = [];
  for (let i = 0; i < 44; i += 1) {
    const img = (n) => `${BASE}/probe-img/a-very-wide-screenshot-of-the-room-${i}-${n}.png`;
    texts.push(i % 7 === 0 ? `see ${URL_LONG}` : i % 7 === 1 ? `path ${PATH_LONG}` : i % 7 === 2 ? `LINKS-${i}: six to review` : i % 7 === 3 ? `ATTACH-${i}: the files`
      : i % 7 === 4 ? `the wide one ${img(0)}` : i % 7 === 5 ? `six of them ${[1, 2, 3, 4, 5, 6].map(img).join(' ')}` : `line ${i}: @voice-svc-interaction-bridge and @briefing-table-engine-workbench — the deploy graph is pinned and the marks sit behind the names.`);
  }
  for (const [i, text] of texts.entries()) {
    const by = AGENTS[i % 5][0];
    const r = i % 4 === 3
      ? await asUser(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text }) })
      : await bearer(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text, from: { paneid: pane(by) } }) });
    if (r.status !== 200) { ok(false, `setup: line ${i}`, r.status); break; }
    if (i === 30) {
      await asUser(`/api/rooms/${R}`, { method: 'PATCH', body: JSON.stringify({ name: `${LONG_ROOM} (renamed)` }) });
    }
  }
  const LINKS = [1, 2, 3, 4, 5, 6].map((n) => ({ tool: 'image-studio', ref: `review/${n}`, label: `#${n} the extremely long review item label that goes on and on ${n}`, view_path: `review/${n}`, panel_id: 'p-none' }));
  const ATTS = [
    { name: 'screenshot-of-the-whole-room-page-on-an-iphone-display-zoom.png', type: 'image/png', size: 123456 },
    { name: 'a-second-image.png', type: 'image/png', size: 2345 },
    { name: 'the-design-review-notes-for-the-room-page-with-a-long-name.pdf', type: 'application/pdf', size: 98765 },
    { name: 'build.log', type: 'text/plain', size: 44 },
  ];
  const inject = (body) => {
    for (const e of body?.entries ?? []) {
      if (/^LINKS-\d+:/.test(e.text ?? e.body ?? '')) {
        e.meta = { ...(typeof e.meta === 'object' && e.meta ? e.meta : {}), links: LINKS };
      }
      if (/^ATTACH-\d+:/.test(e.text ?? e.body ?? '')) {
        e.kind = 'attachment';
        e.meta = { ...(typeof e.meta === 'object' && e.meta ? e.meta : {}), attachments: ATTS };
      }
    }
    return body;
  };

  /* the image-link thumbnails (web/room-image-links.mjs): the engine's own
     origin is a trusted host; the bytes are one very WIDE png (1600x120) */
  const wide = new PNG({ width: 1600, height: 120 });
  for (let k = 0; k < wide.data.length; k += 4) { wide.data[k] = 40; wide.data[k + 1] = 140; wide.data[k + 2] = 200; wide.data[k + 3] = 255; }
  const WIDE_PNG = PNG.sync.write(wide);
  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  const allErrors = [];
  const openPhone = async (w, h, sw, sh, loadKb = 0, settle = 2800) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, storageState: storage });
    await ctx.addInitScript(INIT, [sw, sh, loadKb]);
    await ctx.route(/\/api\/rooms\/[^/]+\/line\?/, async (route) => {
      if (route.request().method() !== 'GET') { return route.continue(); }
      const res = await route.fetch();
      let body = null;
      try { body = await res.json(); } catch { return route.fulfill({ response: res }); }
      return route.fulfill({ response: res, json: inject(body) });
    });
    await ctx.route(/\/probe-img\//, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: WIDE_PNG }));
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => allErrors.push(`${w}: ${e}`));
    await pg.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('#line .entry');
    await sleep(settle); // a poll, the art, the strip
    return { ctx, pg };
  };
  const noOverflow = async (pg, where, w) => {
    const f = await pg.evaluate(() => window.__frame());
    const off = f.scrollW > f.inner[0] ? await pg.evaluate(() => window.__offenders()) : [];
    ok(f.scrollW <= f.inner[0] && f.bodyScrollW <= f.inner[0], `${w}: ${where}: no sideways overflow (scrollWidth ${f.scrollW} / body ${f.bodyScrollW} <= ${f.inner[0]})`, off.length ? off : undefined);
    return f;
  };

  for (const [w, h] of WIDTHS) {
    console.log(`\n[${w}x${h}]`);
    const { ctx, pg } = await openPhone(w, h, w, h);

    /* a draft tray with long file names, through the real upload */
    await pg.setInputFiles('#attFile', [
      { name: 'an-attachment-with-a-remarkably-long-file-name-for-the-tray.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') },
      { name: 'notes-for-the-reviewers-without-spaces-in-the-name.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    ]).catch((e) => ok(false, `${w}: setup: attach files`, String(e)));
    /* every thumbnail LOADED before measuring (they are lazy; a loaded wide
       image is the case that could widen a bubble) */
    await pg.evaluate(() => document.querySelectorAll('#line img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; }));
    await sleep(1200);
    const counts = await pg.evaluate(() => ({
      rows: document.querySelectorAll('#line .tl-row').length,
      att: document.querySelectorAll('#line .entry-att:not(.ril-set)').length,
      thumbs: [...document.querySelectorAll('#line .ril-thumb img')].filter((i) => i.complete && i.naturalWidth > 0).length,
      tray: document.querySelectorAll('#attTray > *').length,
      art: !!document.querySelector('.rc-art'),
      links: document.querySelectorAll('#line .entry-body a').length,
    }));
    ok(counts.rows > 0 && counts.thumbs > 0 && counts.att > 0 && counts.tray >= 2 && counts.links > 0, `${w}: the room is dense: ${counts.rows} tool-link rows, ${counts.att} sent sets, ${counts.thumbs} image-link thumbnails loaded, ${counts.tray} in the tray, ${counts.links} links, art ${counts.art}`, counts);

    /* 1. no sideways overflow, on home */
    await noOverflow(pg, 'the line', w);

    /* 2. html/body do not scroll */
    const f0 = await pg.evaluate(() => window.__frame());
    ok(f0.scrollH <= f0.inner[1], `${w}: nothing to scroll at the page level (scrollHeight ${f0.scrollH} <= ${f0.inner[1]})`);
    const hdr = await pg.evaluate(() => { const r = document.querySelector('.ph-hdr').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    const lineBox = await pg.evaluate(() => { const r = document.getElementById('lineScroll').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    const scBefore = await pg.evaluate(() => document.getElementById('lineScroll').scrollTop);
    let wheeled = true;
    try {
      await pg.mouse.move(hdr[0], hdr[1]);
      await pg.mouse.wheel(0, 400);
      await pg.mouse.wheel(300, 0);
      await pg.mouse.move(lineBox[0], lineBox[1]);
      await pg.mouse.wheel(0, -600);
      await sleep(400);
    } catch (e) {
      wheeled = false;
      console.log(`       (wheel not available here: ${String(e.message || e).split('\n')[0]})`);
    }
    await pg.evaluate(() => { window.scrollTo(300, 500); document.body.scrollTop = 500; document.body.scrollLeft = 300; });
    await sleep(150);
    const f1 = await pg.evaluate(() => window.__frame());
    ok(f1.top === 0 && f1.left === 0 && f1.bodyTop === 0 && f1.bodyLeft === 0 && f1.winY === 0 && f1.winX === 0, `${w}: html/body stay at 0 after wheels and a scrollTo`, f1);
    const ls = await pg.evaluate(() => { const s = document.getElementById('lineScroll'); return { sh: s.scrollHeight, ch: s.clientHeight, st: s.scrollTop, oy: getComputedStyle(s).overflowY }; });
    ok(ls.sh > ls.ch && ls.oy === 'auto' && (!wheeled || ls.st !== scBefore), `${w}: #lineScroll scrolls (${ls.ch} of ${ls.sh}; the wheel ${wheeled ? `moved it ${scBefore} -> ${ls.st}` : 'is not available here'})`, ls);
    const moved = await pg.evaluate(() => { const s = document.getElementById('lineScroll'); const a = s.scrollTop; s.scrollTop = a - 500; const b = s.scrollTop; s.scrollTop = s.scrollHeight; return [a, b]; });
    ok(moved[1] !== moved[0], `${w}: #lineScroll is a live scroller (${moved[0]} -> ${moved[1]})`);
    const cssLock = await pg.evaluate(() => {
      const h = getComputedStyle(document.documentElement);
      const b = getComputedStyle(document.body);
      /* some WebKit builds do not expose overscroll-behavior on the computed
         style; then the declared rule is what can be checked */
      const declared = [...document.styleSheets].some((sh) => { try { return [...sh.cssRules].some((r) => /^html,\s*body$/.test(r.selectorText ?? '') && r.style.getPropertyValue('overscroll-behavior') === 'none'); } catch { return false; } });
      return { hO: h.overflow, bO: b.overflow, hOB: h.overscrollBehaviorY, bOB: b.overscrollBehaviorY, declared, supported: CSS.supports('overscroll-behavior', 'none'), ta: h.touchAction };
    });
    /* Playwright's Windows WebKit build does not implement overscroll-behavior
       at all (CSS.supports says no, and the parser drops it); iOS 16+ does.
       There the property cannot be checked, and the verdict says so. */
    const obNone = !cssLock.supported ? true : cssLock.hOB === undefined || cssLock.hOB === '' ? cssLock.declared : cssLock.hOB === 'none' && cssLock.bOB === 'none';
    if (!cssLock.supported) { console.log(`       (${w}: this engine does not implement overscroll-behavior; not checkable here)`); }
    ok(cssLock.hO === 'hidden' && cssLock.bO === 'hidden' && obNone && cssLock.ta === 'pan-x pan-y', `${w}: html + body are overflow hidden, overscroll none, touch-action pan-x pan-y`, cssLock);

    /* 3. the zoom blockers (capture phase, passive:false) */
    await pg.evaluate(() => { window.__seen = []; });
    /* a point on the LINE that is not a control (text, a bubble's ground) */
    const bub = await pg.evaluate(() => {
      const sc = document.getElementById('lineScroll').getBoundingClientRect();
      for (let y = sc.top + 20; y < sc.bottom - 10; y += 12) {
        for (let x = sc.left + 10; x < sc.right - 10; x += 16) {
          const el = document.elementFromPoint(x, y);
          if (el && el.closest('#lineScroll') && !el.closest('button, a, input, textarea, select, label, [role="button"], img')) { return [x, y]; }
        }
      }
      return null;
    });
    ok(bub !== null, `${w}: found a non-control point on the line to double-tap`, bub);
    if (bub) {
      await pg.touchscreen.tap(bub[0], bub[1]);
      await sleep(60);
      await pg.touchscreen.tap(bub[0], bub[1]);
      await sleep(300);
    }
    const seen = await pg.evaluate(() => window.__seen);
    const ends = seen.filter((s) => s[0] === 'touchend');
    const starts1 = seen.filter((s) => s[0] === 'touchstart' && s[1] === 1);
    ok(ends.length >= 2 && ends[ends.length - 1][2] === true, `${w}: a double tap on the line: the second touchend is cancelled (no double-tap zoom)`, seen);
    ok(starts1.length >= 1 && starts1.every((s) => s[2] === false), `${w}: a one-finger touchstart is never cancelled (the line's scroll is untouched)`, starts1);
    const pinch = await pg.evaluate(() => {
      const out = {};
      const target = document.getElementById('lineScroll');
      /* WebKit has no Touch constructor: a plain cancelable event carrying two
         touches is what the handler reads (e.touches.length) */
      const ev = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'touches', { value: [{ identifier: 1 }, { identifier: 2 }] });
      target.dispatchEvent(ev);
      out.twoFinger = ev.defaultPrevented;
      const g = new Event('gesturestart', { bubbles: true, cancelable: true });
      target.dispatchEvent(g);
      out.gesture = g.defaultPrevented;
      out.scale = window.visualViewport.scale;
      return out;
    });
    ok(pinch.twoFinger === true && pinch.gesture === true && pinch.scale === 1, `${w}: pinch is blocked (two-finger touchstart ${pinch.twoFinger}, gesturestart ${pinch.gesture}), scale ${pinch.scale}`);

    /* 4. the soft keyboard */
    const KB = Math.round(h * 0.42);
    await pg.evaluate((k) => { document.getElementById('input').focus(); window.__kb(k); }, KB);
    await sleep(250);
    const kb = await pg.evaluate(() => {
      const c = document.getElementById('compose').getBoundingClientRect();
      const b = document.body.getBoundingClientRect();
      return { vvh: document.documentElement.style.getPropertyValue('--vvh'), vv: window.visualViewport.height, bodyH: Math.round(b.height), composeBottom: Math.round(c.bottom), composeTop: Math.round(c.top), winY: window.scrollY };
    });
    ok(kb.vvh === `${kb.vv}px` && Math.abs(kb.bodyH - kb.vv) <= 1 && kb.composeBottom <= kb.vv + 1 && kb.composeTop > 60, `${w}: keyboard up (${KB}px): --vvh ${kb.vvh}, body ${kb.bodyH}, the composer sits above the keys (${kb.composeTop}-${kb.composeBottom} of ${kb.vv})`, kb);
    await noOverflow(pg, 'keyboard up', w);
    await pg.evaluate(() => { window.__kb(0); document.getElementById('input').blur(); });
    await sleep(200);
    const kb0 = await pg.evaluate(() => ({ vvh: document.documentElement.style.getPropertyValue('--vvh'), bodyH: Math.round(document.body.getBoundingClientRect().height) }));
    ok(kb0.vvh === '' && Math.abs(kb0.bodyH - h) <= 1, `${w}: keyboard down: --vvh cleared, body back to ${kb0.bodyH}`, kb0);
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, `room-ios-${w}.png`) }); }

    /* 5. the layers and the sheet */
    await pg.tap('#phAgents');
    await sleep(500);
    await noOverflow(pg, 'the Agents sheet', w);
    await pg.evaluate(() => document.getElementById('phScrim').click());
    await sleep(400);
    await pg.tap('#phAgents');
    await pg.tap('#phSheetBody li.seat[data-seat-id]:not([data-seat-id^="app:"]):not(.is-room):not(.is-sub)'); // an agent, from the menu
    await sleep(900);
    await noOverflow(pg, 'an agent layer', w);
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, `room-ios-${w}-layer.png`) }); }
    await pg.tap('#lyBack');
    await sleep(500);
    await pg.tap('#phGear');
    await sleep(700);
    await noOverflow(pg, 'the settings layer', w);
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, `room-ios-${w}-settings.png`) }); }

    /* 6. the diag beacon reached the engine */
    await sleep(1800);
    const diag = await (await bearer('/api/diag/viewport')).json();
    const mine = (diag.reports ?? []).filter((r) => r.page === 'room' && Array.isArray(r.inner) && r.inner[0] === w);
    const last = mine[mine.length - 1];
    ok(mine.length > 0 && last.room === R && Array.isArray(last.screen) && typeof last.docScrollW === 'number' && Array.isArray(last.wide), `${w}: the room reported its viewport to /api/diag/viewport (${mine.map((r) => r.why).join(', ')})`, last ? { why: last.why, screen: last.screen, docScrollW: last.docScrollW, wide: last.wide } : diag.reports?.slice(-1));
    await ctx.close();
  }

  /* THE iOS KEYBOARD SEQUENCES [web/room-ios-keyboard] (Owner 2026-09-29,
     320x522: the input stuck BELOW the keys; the diag showed sync() last ran
     on a transient height and nothing ran again). Each sequence changes the
     visual viewport the way iOS does, often with NO event, and the room must
     converge on its own within 1.2 s (Owner: about a second is fine). */
  console.log('\n[iOS keyboard sequences at 320x522]');
  {
    const { ctx, pg } = await openPhone(320, 522, 320, 522);
    const conv = (limit = 1200) => pg.evaluate((l) => window.__until(l), limit);
    const geom = () => pg.evaluate(() => window.__geom());
    const diagSince = async (t0) => ((await (await bearer('/api/diag/viewport')).json()).reports ?? []).filter((r) => r.page === 'room' && r.at >= t0 && r.inner?.[0] === 320);
    const t0 = Date.now();
    await pg.focus('#input');

    /* 1a. a resize fired MID-ANIMATION only; the final height lands 300 ms
       later with no event (inside the frame window) */
    await pg.evaluate(() => window.__vvSet({ kb: 90, fire: 'resize' }));
    await sleep(300);
    await pg.evaluate(() => window.__vvSet({ kb: 268 }));
    let ms = await conv();
    ok(ms >= 0, `mid-animation resize, final height with no event: converges in ${ms} ms`, await geom());

    /* 1b. ... and when the final height lands AFTER every kick has run out
       (1.3 s later), only the focused-field poll can see it */
    await pg.evaluate(() => window.__vvSet({ kb: 110, fire: 'resize' }));
    await sleep(1300);
    ok(await pg.evaluate(() => window.__fits()), 'setup: the intermediate height was applied', await geom());
    await pg.evaluate(() => window.__vvSet({ kb: 268 }));
    ms = await conv();
    ok(ms >= 0 && ms <= 1200, `no final event at all, after the frame window: the 1 s poll converges in ${ms} ms (<= 1200)`, await geom());

    /* 2. the predictive bar comes and goes: height changes, no event */
    await sleep(1200);
    await pg.evaluate(() => window.__vvSet({ kb: 312 }));
    ms = await conv();
    ok(ms >= 0 && ms <= 1200, `a keyboard-height change with no event (predictive bar): converges in ${ms} ms`, await geom());

    /* 3. iOS pans the visual viewport (offsetTop 57), with no event, then with a scroll event */
    await sleep(1200);
    await pg.evaluate(() => window.__vvSet({ top: 57 }));
    ms = await conv();
    const g3 = await geom();
    ok(ms >= 0 && ms <= 1200 && g3.bodyTop === 57 && g3.composeBottom === Math.round(57 + g3.vvH), `a pan to offsetTop 57 (no event): the room follows in ${ms} ms, composer bottom ${g3.composeBottom} = 57 + ${g3.vvH}`, g3);
    await pg.evaluate(() => window.__vvSet({ top: 20, fire: 'scroll' }));
    ms = await conv(300);
    ok(ms >= 0, `a pan back to 20 WITH a scroll event: follows in ${ms} ms`, await geom());
    await pg.evaluate(() => window.__vvSet({ top: 0, fire: 'scroll' }));
    await conv(300);

    /* 4. iOS's "scroll the focused field into view" shift: a clipped box
       (#main, overflow hidden) scrolled by 57 while the field has focus */
    await pg.evaluate(() => {
      const sp = document.createElement('div');
      sp.id = 'probeSpacer';
      sp.style.cssText = 'height:2000px;flex:none';
      document.getElementById('main').append(sp);
      document.getElementById('main').scrollTop = 57;
    });
    const shifted = await geom();
    await sleep(600);
    const unshifted = await geom();
    const mainTop = await pg.evaluate(() => document.getElementById('main').scrollTop);
    ok(shifted.hdrTop < 0 && mainTop === 0 && unshifted.hdrTop >= 0 && unshifted.focused === 'input', `iOS's body shift is undone without blurring the field (header ${shifted.hdrTop} -> ${unshifted.hdrTop}, #main scrollTop ${mainTop}, focus stays on #${unshifted.focused})`, { shifted, unshifted });
    await pg.evaluate(() => document.getElementById('probeSpacer').remove());

    /* 5. blur with the keyboard's resize never arriving; then RE-FOCUS with
       no resize either */
    await pg.evaluate(() => { window.__vvSet({ kb: 0 }); document.getElementById('input').blur(); });
    ms = await conv();
    ok(ms >= 0, `blur, keyboard down with no event: --vvh clears in ${ms} ms`, await geom());
    await sleep(1300);
    await pg.focus('#input');
    await sleep(120);
    await pg.evaluate(() => window.__vvSet({ kb: 268 }));
    ms = await conv();
    ok(ms >= 0 && ms <= 1200, `re-focus with no resize event: converges in ${ms} ms`, await geom());

    /* 6. the poll stops on blur (the diag says so), and the new diag fields */
    await pg.evaluate(() => { window.__vvSet({ kb: 0 }); document.getElementById('input').blur(); });
    await conv();
    await sleep(1800);
    const reps = await diagSince(t0);
    const up = reps.find((r) => r.kbUp === true && r.pollActive === true && r.focused === 'textarea#input' && typeof r.vvTop === 'number');
    const last = reps[reps.length - 1];
    const stopped = reps.some((r) => (r.whys ?? []).some((w) => w.why === 'poll-stop'));
    ok(!!up && Array.isArray(up.whys) && up.whys.every((w) => w.state && 'pollActive' in w.state) && typeof up.lastSync === 'string',
      'diag: a keyboard-up report carries focused, vvTop, lastSync, pollActive and each WHY with its state at call time', up ? { why: up.why, focused: up.focused, vvh: up.vvh, vvTop: up.vvTop, lastSync: up.lastSync, pollActive: up.pollActive } : reps.map((r) => r.why));
    ok(stopped && last && last.pollActive === false && last.kbUp === false && last.focused === null, `diag: the poll stops on blur (last report: ${last?.why}, pollActive ${last?.pollActive})`);

    /* 7. bfcache: the viewport changed while the page was away (no field
       focused, so no poll): pageshow(persisted) re-syncs; so does visibility */
    await pg.evaluate(() => window.__vvSet({ kb: 200 }));
    await sleep(1300);
    const stale = await pg.evaluate(() => window.__fits());
    await pg.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    ms = await conv(1000);
    ok(!stale && ms >= 0, `pageshow (bfcache) re-syncs a viewport that changed silently (stale before: ${!stale}; converges in ${ms} ms)`, await geom());
    await pg.evaluate(() => window.__vvSet({ kb: 0 }));
    await sleep(1300);
    await pg.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    ms = await conv(1000);
    ok(ms >= 0, `visibilitychange re-syncs too (keyboard gone silently: cleared in ${ms} ms)`, await geom());
    await ctx.close();
  }

  /* LOADED WITH THE KEYBOARD ALREADY UP, no viewport event ever */
  console.log('\n[a page load with the keyboard already up at 320x522]');
  {
    const tLoad = Date.now();
    const { ctx, pg } = await openPhone(320, 522, 320, 522, 268, 0);
    const r = await pg.evaluate(() => new Promise((res) => {
      const t = () => {
        if (window.__settledAt !== undefined) {
          const t0 = window.__settledAt;
          const tick = () => {
            if (window.__fits()) { res({ ms: Math.round(performance.now() - t0) }); return; }
            if (performance.now() - t0 > 1200) { res({ ms: -1 }); return; }
            requestAnimationFrame(tick);
          };
          tick();
        } else {
          setTimeout(t, 20);
        }
      };
      t();
    }));
    const g = await pg.evaluate(() => window.__geom());
    ok(r.ms >= 0 && r.ms <= 1200 && g.focused === 'input' && g.vvh === '254px', `loaded with the keys up (focus restored, height settling 400 ms later, no event): converges ${r.ms} ms after they settle, --vvh ${g.vvh}`, g);
    await sleep(2200);
    const reps = ((await (await bearer('/api/diag/viewport')).json()).reports ?? []).filter((x) => x.page === 'room' && x.at >= tLoad && x.inner?.[0] === 320);
    const load = reps.find((x) => /(^|,)load(,|$)/.test(x.why));
    ok(!!load && load.kbUp === true && load.pollActive === true && load.vvh === 254 && load.focused === 'textarea#input', `diag: the load report sees the keyboard up, the poll running, --vvh 254 (${load?.why})`, load ? { kbUp: load.kbUp, pollActive: load.pollActive, vvh: load.vvh, focused: load.focused, lastSync: load.lastSync } : reps.map((x) => x.why));
    await ctx.close();
  }

  /* DISPLAY ZOOM: a layout viewport wider than the glass */
  console.log('\n[display zoom: innerWidth 398, screen 320x693]');
  {
    const { ctx, pg } = await openPhone(398, 862, 320, 693);
    const z = await pg.evaluate(() => {
      const b = document.body.getBoundingClientRect();
      const reach = Math.max(...[...document.querySelectorAll('.ph-hdr, .ph-strip, #compose, #lineScroll, .ph-hdr .ph-ib')].map((e) => e.getBoundingClientRect().right));
      return { appW: document.documentElement.style.getPropertyValue('--app-w'), clamped: document.documentElement.classList.contains('is-screen-clamped'), bodyW: Math.round(b.width), reach: Math.round(reach) };
    });
    ok(z.appW === '320px' && z.clamped && z.bodyW === 320 && z.reach <= 320, `display zoom: the room's root box is pinned to the glass (--app-w ${z.appW}, body ${z.bodyW}, rightmost control ${z.reach})`, z);
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, 'room-ios-zoom-398.png') }); }
    await ctx.close();
  }

  ok(allErrors.length === 0, 'no page errors', allErrors.slice(0, 3));
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  if (engine) { engine.kill('SIGKILL'); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* the engine may still hold the db */ }
}
console.log(`\n${failures ? `FAIL ${failures}` : 'PASS'} [${browserName}]`);
process.exit(failures ? 1 : 0);
