/* BUBBLES — the fixed desktop look (25% / 5px), and the author wash
 * [rooms/bubbles], fixed [rooms/bubble-defaults] (Owner 2026-09-28).
 *
 *   node test/room-bubbles.probe.mjs
 *
 * Proves, with COMPUTED colours read back through a 1x1 canvas and PAINTED
 * pixels read back from screenshots (getComputedStyle answers oklch()/color()
 * strings in Chromium):
 *   DESKTOP (1280)
 *   - the ⚙ column has NO Display group (no sliders) — Owner's tuned values are
 *     THE look, fixed in CSS, no per-person prefs read at boot
 *   - with no prefs set, the computed bubble BACKGROUND alpha is 25% transparent
 *     (base alpha ~0.75/255) and backdrop-filter is blur(5px), at once
 *   - text colour, the author's @name, and the border stay alpha 255; the
 *     bubble's own text carries no filter (blur never touches its own content)
 *   - writing bubbleTransparency/bubbleBlur straight at the engine (the fields
 *     still exist there) changes nothing on the page after a reload — the
 *     page no longer reads or writes them
 *   - body[data-bubble-see-through] is NOT set at the fixed 25% (the >= 40%
 *     lift CSS stays in the sheet, unreached, for a future global setting)
 *   - the WASH: a radial-gradient on agent and user bubbles, from the avatar
 *     side (agents left, you right; the painted corner nearest the glyph is
 *     the most tinted), in the author's lifted tone; none on facts
 *   - CONTRAST: the body text against the LIGHTEST painted pixel of the bubble
 *     (the wash's peak, text hidden) is >= 4.5:1 at the fixed 25%
 *   - scroll timing with ~200 lines at the fixed 5px blur (logged, against the
 *     same scroll with blur forced to 0 by direct CSS override)
 *   PHONE (390): no Display group; bubbles 50% clear, no blur, the see-through lift, behind html.phone-glass (opaque without it); contrast at art 10% / 40%; regardless of
 *   what the engine holds for this person; the wash is there, not on facts
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(214), DEAD broker P(215).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(214);
const DEAD_BROKER_PORT = P(215);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-bubbles-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

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

const HELPERS = () => {
  window.__res = (expr) => {
    const d = document.createElement('div');
    d.style.color = expr;
    document.body.append(d);
    const v = getComputedStyle(d).color;
    d.remove();
    return v;
  };
  window.__rgb = (v) => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 1, 1);
    x.fillStyle = '#010203';
    x.fillStyle = v;
    if (x.fillStyle === '#010203' && !/^[ref]$/i.test(v)) { return null; }
    x.fillRect(0, 0, 1, 1);
    return [...x.getImageData(0, 0, 1, 1).data];
  };
  window.__exp = (expr) => window.__rgb(window.__res(expr));
  /* one bubble's computed story */
  window.__bub = (sel) => {
    const b = document.querySelector(sel);
    if (!b) { return null; }
    const cs = getComputedStyle(b);
    const li = b.closest('.entry');
    return {
      bg: window.__rgb(cs.backgroundColor),
      img: cs.backgroundImage,
      bdf: cs.backdropFilter,
      wbdf: cs.webkitBackdropFilter,
      border: window.__rgb(cs.borderTopColor),
      text: window.__rgb(getComputedStyle(b.querySelector('.entry-body')).color),
      author: li.classList.contains('by-agent') ? window.__rgb(getComputedStyle(b.querySelector('.entry-author')).color) : null,
      bodyFilter: getComputedStyle(b.querySelector('.entry-body')).filter,
    };
  };
};

/* WCAG relative luminance / contrast, from 0-255 sRGB */
const lum = ([r, g, b]) => {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** The painted pixels of one bubble (device scale 1), `inset` px in from its
 *  box (1 = inside the border). `in(x, y)` says whether a pixel is inside the
 *  bubble's ROUNDED shape: a corner pixel outside the curve is whatever is
 *  behind the bubble (a neighbour's glyph), never the bubble's own paint. */
async function pixels(page, sel, { inset = 1, hideText = false } = {}) {
  if (hideText) {
    await page.addStyleTag({ content: '.entry-bubble > * { visibility: hidden !important; }' });
  }
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const rad = Math.max(...['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight'].map((k) => parseFloat(cs[`border${k}Radius`]) || 0));
    return { x: r.left, y: r.top, width: r.width, height: r.height, rad };
  }, sel);
  const clip = { x: Math.round(box.x + inset), y: Math.round(box.y + inset), width: Math.round(box.width - 2 * inset), height: Math.round(box.height - 2 * inset) };
  const png = PNG.sync.read(await page.screenshot({ clip }));
  if (hideText) {
    await page.evaluate(() => [...document.querySelectorAll('style')].filter((s) => s.textContent.includes('visibility: hidden !important')).forEach((s) => s.remove()));
  }
  const at = (x, y) => { const i = (y * png.width + x) * 4; return [png.data[i], png.data[i + 1], png.data[i + 2]]; };
  const r = Math.max(0, box.rad - inset) + 1.5; // + a pixel of antialiased edge
  const inShape = (x, y) => {
    const cx = x < r ? r : x > png.width - 1 - r ? png.width - 1 - r : x;
    const cy = y < r ? r : y > png.height - 1 - r ? png.height - 1 - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= (r - 1.5) ** 2 || (cx === x || cy === y);
  };
  return { png, at, w: png.width, h: png.height, in: inShape };
}
function lightest(px) {
  let best = [0, 0, 0];
  let where = null;
  for (let y = 0; y < px.h; y += 1) {
    for (let x = 0; x < px.w; x += 1) {
      if (!px.in(x, y)) { continue; }
      const p = px.at(x, y);
      if (lum(p) > lum(best)) { best = p; where = [x, y]; }
    }
  }
  if (process.env.BUBBLES_DEBUG) { console.log('lightest at', where, 'of', px.w, px.h, best); }
  return best;
}
const meanOf = (px, x0, y0, x1, y1) => {
  let s = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) { const p = px.at(x, y); s = s.map((v, i) => v + p[i]); n += 1; }
  }
  return s.map((v) => v / n);
};
const diffOf = (a, b) => {
  let d = 0;
  const locs = [];
  for (let i = 0; i < a.png.data.length; i += 4) {
    if (!a.in((i / 4) % a.w, Math.floor(i / 4 / a.w))) { continue; }
    const v = Math.max(Math.abs(a.png.data[i] - b.png.data[i]), Math.abs(a.png.data[i + 1] - b.png.data[i + 1]), Math.abs(a.png.data[i + 2] - b.png.data[i + 2]));
    if (v > 2) { locs.push([(i / 4) % a.w, Math.floor(i / 4 / a.w), v]); }
    d = Math.max(d, v);
  }
  if (process.env.BUBBLES_DEBUG) { console.log('diff', a.w, a.h, locs.length, locs.slice(0, 12)); }
  return d;
};

/** THE META LINE + THE @NAME [rooms/bubbles-meta]: each secondary text in the
 *  last agent and user entries (time, "→ @x", the kind, the @name, the read
 *  line "seen / not yet / can't tell" under the bubble), against the LIGHTEST
 *  pixel painted inside that text's own box with every line's text hidden. */
async function metaContrast(page, withBody = false) {
  const items = await page.evaluate((body) => {
    const out = [];
    const tag = (el, name) => {
      if (!el || !el.getClientRects().length || getComputedStyle(el).display === 'none') { return; }
      const id = `m${out.length}`;
      el.dataset.probeMeta = id;
      out.push({ id, name, color: window.__rgb(getComputedStyle(el).color) });
    };
    for (const side of ['agent', 'user']) {
      const li = [...document.querySelectorAll(`#line > .entry.by-${side}`)].pop();
      tag(li.querySelector('.entry-ts'), `${side} time`);
      tag(li.querySelector('.entry-target'), `${side} target`);
      tag(li.querySelector('.entry-kind'), `${side} kind`);
      if (body) { tag(li.querySelector('.entry-body'), `${side} message text`); }
    }
    /* the @name shows on the FIRST line of a group only */
    const named = [...document.querySelectorAll('#line > .entry.by-agent:not(.same)')].pop();
    tag(named?.querySelector('.entry-author'), 'agent @name');
    for (const side of ['agent', 'user']) {
      const li = [...document.querySelectorAll(`#line > .entry.by-${side}`)].filter((x) => x.querySelector(':scope > .entry-reads')).pop();
      for (const rd of li?.querySelectorAll(':scope > .entry-reads .rd') ?? []) { tag(rd, `${side} reads "${rd.textContent.split(' ')[0]}${rd.dataset.state === 'unknown' ? ' tell' : ''}"`); }
    }
    return out;
  }, withBody);
  await page.addStyleTag({ content: '.entry-bubble > *, .entry-reads { visibility: hidden !important; }' });
  await page.mouse.move(5, 5);
  const res = {};
  for (const it of items) {
    const box = await page.evaluate((id) => { const r = document.querySelector(`[data-probe-meta="${id}"]`).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }, it.id);
    const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.max(1, Math.ceil(box.width)), height: Math.max(1, Math.ceil(box.height)) };
    const png = PNG.sync.read(await page.screenshot({ clip }));
    let best = [0, 0, 0];
    for (let i = 0; i < png.data.length; i += 4) {
      const p = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (lum(p) > lum(best)) { best = p; }
    }
    res[it.name] = { ratio: +contrast(it.color, best).toFixed(2), text: it.color.slice(0, 3), peak: best };
  }
  await page.evaluate(() => [...document.querySelectorAll('style')].filter((s) => s.textContent.includes('.entry-reads { visibility: hidden !important')).forEach((s) => s.remove()));
  return res;
}
const printMeta = (label, m) => {
  console.log(`       ${label}:`);
  for (const [k, v] of Object.entries(m)) { console.log(`         ${k.padEnd(26)} ${v.ratio.toFixed(2)}:1  text ${JSON.stringify(v.text)} on ${JSON.stringify(v.peak)}`); }
};
const isMeta = (k) => !k.includes('@name');

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-bubbles.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-bubbles-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

const LEAD_COLOR = '#0dab49';
const BEE_COLOR = '#1f5fbf';
/* stripes: what shows through a see-through bubble has edges a blur must soften */
const STRIPES = Array.from({ length: 25 }, (_, i) => `<rect x="${i * 4}" y="0" width="2" height="100"/>`).join('');
const ART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${STRIPES}</svg>`;

try {
  const recipe = (id, name, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: [recipe('rec-lead', 'Lead', 'leadp', LEAD_COLOR), recipe('rec-b', 'Bee', 'bee', BEE_COLOR)] });
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

  const L1 = 'recipe:rec-lead';
  const B1 = 'recipe:rec-b';
  const post = await seed({
    sessions: [
      { paneid: L1, recipe_id: 'rec-lead', vendor: 'claude-code', agent: 'leadp', state: 'live' },
      { paneid: B1, recipe_id: 'rec-b', vendor: 'claude-code', agent: 'bee', state: 'live' },
    ],
    rooms: [{ name: 'Bubbles', seats: [{ handle: 'leadp', recipe_id: 'rec-lead', occupant: L1 }, { handle: 'bee', recipe_id: 'rec-b', occupant: B1 }, { handle: 'sea', recipe_id: 'rec-b' }] }],
  });
  const R = post.rooms[0].id;
  const bearer = (path, init = {}) => fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(HELPERS);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const asUser = (path, init = {}) => fetch(BASE + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers || {}) } });

  /* the room's art: stripes behind the line (room character), so a see-through bubble has something to show */
  const made = await (await bearer('/api/logos', { method: 'POST', body: JSON.stringify({ name: 'Stripes', svg: ART_SVG }) })).json();
  await bearer(`/api/logos/${made?.logo?.id}`, { method: 'PATCH', body: JSON.stringify({ style: { scale: 100, opacity: 40 } }) });
  const art = await asUser(`/api/rooms/${R}/settings`, { method: 'PATCH', body: JSON.stringify({ art: `lib:${made?.logo?.id}` }) });
  ok(art.status === 200, 'setup: the room wears striped art', art.status);

  /* ~200 lines: agents (bearer + from) and you (cookie), the last few long enough to cross the art */
  const LONG = 'The deploy graph is pinned; every coloured accent bar is out and the marks sit behind the names where they belong now.';
  for (let i = 0; i < 196; i += 1) {
    const text = `line ${i}: ${LONG}`;
    const r = i % 3 === 2
      ? await asUser(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text }) })
      : await bearer(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text, from: { paneid: i % 3 === 0 ? L1 : B1 } }) });
    if (r.status !== 200) { ok(false, `setup: line ${i}`, r.status); break; }
  }
  await bearer(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text: `AGENT-LAST ${LONG}`, from: { paneid: L1 } }) });
  /* [rooms/line-halo] a line to a seat with no pane: a delivery fact on your side + "can't tell" */
  await asUser(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text: '@sea are you there?' }) });
  await asUser(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text: `USER-LAST ${LONG}` }) });
  /* a FACT among the newest lines: the room is renamed */
  const ren = await asUser(`/api/rooms/${R}`, { method: 'PATCH', body: JSON.stringify({ name: 'Bubbles Two' }) });
  ok(ren.status === 200, 'setup: a rename writes a fact into the line', ren.status);

  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .seat');
  await sleep(3000); // a poll: the recipes' colours are current

  /* the last agent / user bubbles, found by text */
  await page.evaluate(() => {
    for (const li of document.querySelectorAll('#line > .entry')) {
      const t = li.querySelector('.entry-body')?.textContent ?? '';
      if (t.startsWith('AGENT-LAST')) { li.querySelector('.entry-bubble').id = 'probeAgent'; }
      if (t.startsWith('USER-LAST')) { li.querySelector('.entry-bubble').id = 'probeUser'; }
    }
  });
  const A = '#probeAgent';
  const U = '#probeUser';

  console.log('\n[desktop: the fixed look, 25% / 5px, no prefs set; the wash from the avatar side]');
  const a0 = await page.evaluate((s) => window.__bub(s), A);
  const u0 = await page.evaluate((s) => window.__bub(s), U);
  ok(a0 && u0, 'an agent bubble and your bubble are on the page');
  ok(near(a0.bg[3], 191) && near(u0.bg[3], 191), 'both bubble backgrounds are ~25% transparent (alpha ~191) with no prefs set', { a: a0.bg, u: u0.bg });
  ok(a0.bdf === 'blur(5px)' && u0.bdf === 'blur(5px)', 'backdrop-filter is blur(5px), fixed, no prefs set', { a: a0.bdf, u: u0.bdf });
  ok(a0.bodyFilter === 'none' && u0.bodyFilter === 'none', "...but the bubble's own text carries no filter", { a: a0.bodyFilter, u: u0.bodyFilter });
  ok(/radial-gradient\((ellipse )?at (left top|0% 0%)/.test(a0.img), "the agent bubble's wash starts at its avatar's side (left top)", a0.img);
  ok(/radial-gradient\((ellipse )?at (right top|100% 0%)/.test(u0.img), 'your bubble\'s wash starts at your picture\'s side (right top)', u0.img);
  ok(/transparent 70%/.test(a0.img) || /rgba\(0, 0, 0, 0\) 70%/.test(a0.img), '...fading out by 70%', a0.img);
  const facts = await page.evaluate(() => [...document.querySelectorAll('#line > .entry.by-room')].map((li) => ({
    bubble: !!li.querySelector('.entry-bubble'), img: getComputedStyle(li).backgroundImage, bodyImg: getComputedStyle(li.querySelector('.entry-body')).backgroundImage,
  })));
  ok(facts.length > 0 && facts.every((f) => !f.bubble && f.img === 'none' && f.bodyImg === 'none'), `facts get no bubble and no wash (${facts.length} facts)`, facts.slice(0, 2));
  /* the painted wash: the corner nearest the glyph is the most tinted */
  const ap = await pixels(page, A, { hideText: true });
  const up0 = await pixels(page, U, { hideText: true });
  const lumAt = (px, x0) => lum(meanOf(px, x0, 2, x0 + 16, 12));
  ok(lumAt(ap, 4) > lumAt(ap, ap.w - 20), 'painted: the agent bubble is lighter at its left (avatar) corner than its right', { left: lumAt(ap, 4).toFixed(4), right: lumAt(ap, ap.w - 20).toFixed(4) });
  ok(lumAt(up0, up0.w - 20) > lumAt(up0, 4), 'painted: your bubble is lighter at its right (picture) corner than its left', { right: lumAt(up0, up0.w - 20).toFixed(4), left: lumAt(up0, 4).toFixed(4) });
  /* the tone: the author's LIFTED ink (L .82), never the raw colour */
  const toneA = await page.evaluate((c) => window.__exp(`oklch(from ${c} .82 clamp(.02, calc(c * .6), .13) h)`), LEAD_COLOR);
  const peakA = meanOf(ap, 0, 0, 6, 4);
  const hueSide = (p) => p[1] - Math.max(p[0], p[2]); // green over the rest: the lead's hue
  ok(hueSide(peakA) > 0, "the agent wash leans to the author's hue (green lead)", { peak: peakA.map(Math.round), tone: toneA });

  console.log('\n[contrast at the fixed 25%: body text vs the lightest painted pixel of the bubble]');
  const c0 = { a: contrast(a0.text, lightest(ap)), u: contrast(u0.text, lightest(up0)), aAuthor: contrast(a0.author, lightest(ap)) };
  ok(c0.a >= 4.5 && c0.u >= 4.5, `agent ${c0.a.toFixed(2)}:1, yours ${c0.u.toFixed(2)}:1 (>= 4.5)`, { text: a0.text, peak: lightest(ap) });
  console.log(`       (the agent's @name: ${c0.aAuthor.toFixed(2)}:1)`);
  const meta0 = await metaContrast(page);
  printMeta('the meta line + @name at the fixed 25%', meta0);
  ok(Object.keys(meta0).filter(isMeta).length >= 3 && Object.values(meta0).some((v, i) => Object.keys(meta0)[i].includes('reads')), 'measured: time, reads and the @name', Object.keys(meta0));

  console.log('\n[no Display group in the ⚙ settings column]');
  await page.click('#gearBtn');
  await sleep(200);
  const noGroup = await page.evaluate(() => ({
    display: !!document.querySelector('.rb-display'),
    anySlider: !!document.querySelector('input[type="range"][id^="rb-"]'),
  }));
  ok(!noGroup.display && !noGroup.anySlider, 'no .rb-display group and no rb-* range input in the settings column', noGroup);

  /* [rooms/bubbles-meta] the >= 40% see-through lift is NOT reached at the
     fixed 25% — the CSS rule stays in room-bubbles.css, unset, for a future
     global setting that could raise --bubble-alpha past 40% again */
  const tsNow = () => page.evaluate(() => ({
    flag: document.body.hasAttribute('data-bubble-see-through'),
    ts: window.__rgb(getComputedStyle([...document.querySelectorAll('#line > .entry.by-agent .entry-ts')].pop()).color),
    dim2: window.__exp('var(--dim2)'),
  }));
  const at25 = await tsNow();
  ok(!at25.flag && at25.ts.join() === at25.dim2.join(), 'at the fixed 25%: no lift, no data-bubble-see-through, the time is still --dim2', at25);

  console.log('\n[blur: fixed 5px by default, never on the bubble\'s own text]');
  /* isolate the claim with a direct CSS override on the same custom properties
     a future global setting would write. .rp-line (every entry) carries a .9s
     background-color/border-color transition (room-reply.css) unrelated to
     this feature, so it is suspended for the length of this isolated check —
     the old per-slider code did the same with body[data-rb-tuning]. */
  await page.addStyleTag({ content: '.entry-bubble, .entry-bubble * { transition: none !important; }' });
  await page.evaluate(() => document.body.style.setProperty('--bubble-alpha', '0%')); // fully opaque
  await page.mouse.move(5, 5); // no hover pill over the bubble
  const opaque5 = await pixels(page, A);
  await page.evaluate(() => document.body.style.setProperty('--bubble-blur', '0px'));
  const opaque0 = await pixels(page, A);
  const same = diffOf(opaque5, opaque0);
  ok(same <= 2, "an opaque bubble paints the same pixels at blur 0 as at the fixed blur 5px: its own text is not blurred", `max channel diff ${same}`);
  await page.evaluate(() => { document.body.style.removeProperty('--bubble-blur'); document.body.style.removeProperty('--bubble-alpha'); });
  const restored = await page.evaluate((s) => window.__bub(s), A);
  ok(near(restored.bg[3], 191) && restored.bdf === 'blur(5px)', 'back to the fixed 25% / blur(5px) once the override is removed', restored);

  /* see-through demonstration (same override mechanism): at a higher
     transparency the blur changes what shows through the striped art */
  await page.evaluate(() => document.body.style.setProperty('--bubble-alpha', '60%'));
  await page.mouse.move(5, 5);
  const clear5 = await pixels(page, A, { hideText: true });
  await page.evaluate(() => document.body.style.setProperty('--bubble-blur', '0px'));
  const clear0 = await pixels(page, A, { hideText: true });
  const d = diffOf(clear0, clear5);
  ok(d > 4, 'see-through at 60% (override): blur 5px changes what shows through (the striped art)', `max channel diff ${d}`);
  await page.evaluate(() => { document.body.style.removeProperty('--bubble-blur'); document.body.style.removeProperty('--bubble-alpha'); });
  await page.evaluate(() => [...document.querySelectorAll('style')].filter((s) => s.textContent.includes('.entry-bubble, .entry-bubble * { transition: none')).forEach((s) => s.remove()));
  await sleep(100);

  /* ---- [rooms/line-halo] TEXT ON THE LINE'S OWN BACKDROP (facts, deliveries,
     the read line): the chrome's halo, 0 0 3px / 0 0 6px of the pane's ground
     (--wm-term), measured over the stripes at 40%. Local contrast: the text
     colour against the LIGHTEST ground pixel under or right beside a glyph
     (the glyph mask, dilated 1px), the ground painted with the text made
     transparent (a text-shadow keeps its own colour, so the halo stays). ---- */
  console.log('\n[line halo: text on the line backdrop, art 40%]');
  const haloRatios = async (withHalo) => {
    const items = await page.evaluate(() => {
      const out = [];
      const tag = (el, name) => {
        if (!el || !el.getClientRects().length) { return; }
        el.dataset.probeHalo = String(out.length);
        out.push({ id: String(out.length), name, color: window.__rgb(getComputedStyle(el).color), shadow: getComputedStyle(el).textShadow });
      };
      tag([...document.querySelectorAll('#line > .entry.by-room:not([data-side]) .entry-body')].pop(), 'fact');
      tag([...document.querySelectorAll('#line > .entry.by-room[data-side] .entry-body')].pop(), 'delivery');
      for (const st of ['seen', 'delivered', 'held', 'not-live', 'badge', 'unknown']) { // [web/room-phone-7] the read line's states
        tag([...document.querySelectorAll(`#line .entry-reads .rd-${st}`)].pop(), `reads ${st}`);
      }
      return out;
    });
    const off = withHalo ? null : await page.addStyleTag({ content: '#roomLine * { text-shadow: none !important; }' });
    await page.mouse.move(5, 5);
    const res = {};
    for (const it of items) {
      const sel = `[data-probe-halo="${it.id}"]`;
      await page.evaluate((q) => document.querySelector(q).scrollIntoView({ block: 'center' }), sel);
      await sleep(60);
      const b = await page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel);
      const clip = { x: Math.floor(b.x) - 2, y: Math.floor(b.y) - 2, width: Math.ceil(b.w) + 4, height: Math.ceil(b.h) + 4 };
      const T = PNG.sync.read(await page.screenshot({ clip }));
      await page.evaluate((q) => document.querySelector(q).style.setProperty('color', 'transparent', 'important'), sel);
      const G = PNG.sync.read(await page.screenshot({ clip }));
      await page.evaluate((q) => document.querySelector(q).style.removeProperty('color'), sel);
      const W = T.width;
      const H = T.height;
      const glyph = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i += 1) {
        const d = Math.max(...[0, 1, 2].map((c) => Math.abs(T.data[i * 4 + c] - G.data[i * 4 + c])));
        glyph[i] = d > 24 ? 1 : 0;
      }
      let best = [0, 0, 0];
      let boxBest = [0, 0, 0];
      const localLums = [];
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const i = y * W + x;
          const p = [G.data[i * 4], G.data[i * 4 + 1], G.data[i * 4 + 2]];
          if (lum(p) > lum(boxBest)) { boxBest = p; }
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy += 1) {
            for (let dx = -1; dx <= 1 && !near; dx += 1) {
              const xx = x + dx;
              const yy = y + dy;
              near = xx >= 0 && yy >= 0 && xx < W && yy < H && glyph[yy * W + xx] === 1;
            }
          }
          if (near) { localLums.push(lum(p)); }
          if (near && lum(p) > lum(best)) { best = p; }
        }
      }
      localLums.sort((a1, b1) => a1 - b1);
      const medL = localLums[Math.floor(localLums.length / 2)] ?? 0;
      const tl = lum(it.color);
      res[it.name] = { median: +((Math.max(tl, medL) + 0.05) / (Math.min(tl, medL) + 0.05)).toFixed(2), local: +contrast(it.color, best).toFixed(2), box: +contrast(it.color, boxBest).toFixed(2), text: it.color.slice(0, 3), ground: best, shadow: it.shadow };
    }
    if (off) { await page.evaluate(() => [...document.querySelectorAll('style')].filter((x) => x.textContent.includes('text-shadow: none !important')).forEach((x) => x.remove())); }
    return res;
  };
  const noHalo = await haloRatios(false);
  const halo = await haloRatios(true);
  console.log('       (worst = the lightest ground pixel at a glyph; median = the median one there)');
  for (const k of Object.keys(halo)) {
    console.log(`       ${k.padEnd(16)} worst ${noHalo[k].local.toFixed(2)} -> ${halo[k].local.toFixed(2)}:1   median ${noHalo[k].median.toFixed(2)} -> ${halo[k].median.toFixed(2)}:1   (ground ${JSON.stringify(halo[k].ground)})`);
  }
  ok(['fact', 'delivery', 'reads seen', 'reads not-live'].every((k) => halo[k]) && (halo['reads held'] || halo['reads delivered']), 'measured: a fact, a delivery, and the read line (seen, held or delivered, not live)', Object.keys(halo));
  ok(Object.values(halo).every((v) => /3px/.test(v.shadow) && /6px/.test(v.shadow)), 'each wears the chrome halo (0 0 3px + 0 0 6px)', Object.fromEntries(Object.entries(halo).map(([k, v]) => [k, v.shadow])));
  const haloTerm = await page.evaluate(() => {
    const d = document.createElement('div');
    d.style.color = 'var(--wm-term)';
    document.getElementById('roomLine').append(d);
    const v = getComputedStyle(d).color;
    d.remove();
    return v;
  });
  ok(Object.values(halo).every((v) => v.shadow.split(haloTerm).length === 3), "...in the pane's own ground (--wm-term), both layers", haloTerm);
  /* the design system ruling is the halo and nothing else: over the 40% stripes it
     LIFTS the text but does not reach 3:1 (logged above). Asserted: it
     helps there, and at the DEFAULT art opacity (10%) everything is >= 3:1. */
  for (const [k, v] of Object.entries(halo)) {
    ok(v.local > noHalo[k].local + 0.2, `halo lifts ${k} at 40% art: ${noHalo[k].local.toFixed(2)} -> ${v.local.toFixed(2)}:1 (worst pixel)`);
  }
  await page.evaluate(() => document.getElementById('roomLine').style.setProperty('--wm-op', '0.1'));
  const halo10 = await haloRatios(true);
  await page.evaluate(() => document.getElementById('roomLine').style.removeProperty('--wm-op'));
  for (const [k, v] of Object.entries(halo10)) {
    ok(v.local >= 3, `art 10% (the default) with the halo: ${k} ${v.local.toFixed(2)}:1 (>= 3)`);
  }
  const bub = await page.evaluate(() => getComputedStyle(document.querySelector('#line > .entry.by-agent .entry-body')).textShadow);
  ok(bub === 'none', 'text inside a bubble wears no halo', bub);

  console.log('\n[the engine\'s bubbleTransparency/bubbleBlur are ignored by the page]');
  /* the fields still exist at the engine (src/table/store.ts, untouched): write
     them straight at the API, the way the old sliders used to, and confirm the
     page's look does not move — it no longer reads or writes them */
  const patched = await asUser('/api/rooms/me', { method: 'PATCH', body: JSON.stringify({ bubbleTransparency: 60, bubbleBlur: 16 }) });
  ok(patched.status === 200, 'setup: PATCH bubbleTransparency=60, bubbleBlur=16 straight at the engine', patched.status);
  const me = await (await asUser('/api/rooms/me')).json();
  ok(me.bubbleTransparency === 60 && me.bubbleBlur === 16, 'the engine holds 60 / 16 for this person', { t: me.bubbleTransparency, b: me.bubbleBlur });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .seat');
  await sleep(1500);
  const reloaded = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#line > .entry.by-agent .entry-bubble')].pop();
    b.id = 'probeAgent';
    return { bub: window.__bub('#probeAgent'), alpha: document.body.style.getPropertyValue('--bubble-alpha'), blur: document.body.style.getPropertyValue('--bubble-blur') };
  });
  ok(near(reloaded.bub.bg[3], 191) && reloaded.bub.bdf === 'blur(5px)', "after a reload, with 60 / 16 sitting at the engine: still the fixed 25% / blur(5px) — the page never fetched them", { bg: reloaded.bub.bg, bdf: reloaded.bub.bdf });
  ok(reloaded.alpha === '' && reloaded.blur === '', 'no inline --bubble-alpha / --bubble-blur on <body> at all (the CSS default alone is doing it)', reloaded);
  await page.click('#gearBtn');
  await sleep(200);
  const stillNoGroup = await page.evaluate(() => !!document.querySelector('.rb-display'));
  ok(!stillNoGroup, 'still no Display group after the reload', stillNoGroup);

  console.log('\n[scroll timing, ~200 lines]');
  for (let i = 0; i < 4; i += 1) {
    const n = await page.evaluate(() => document.querySelectorAll('#line > .entry').length);
    if (n >= 200) { break; }
    await page.evaluate(() => document.getElementById('lineScroll').scrollTo(0, 0));
    await sleep(200);
    const older = await page.$('#olderBtn:not([hidden])');
    if (older) { await older.click(); await sleep(800); }
  }
  const nLines = await page.evaluate(() => document.querySelectorAll('#line > .entry').length);
  ok(nLines >= 200, `${nLines} lines on the page`);
  const scrollRun = () => page.evaluate(() => new Promise((resolve) => {
    const sc = document.getElementById('lineScroll');
    const max = sc.scrollHeight - sc.clientHeight;
    sc.scrollTop = max;
    const dts = [];
    let t0 = null;
    let last = null;
    const DUR = 2500;
    const step = (t) => {
      if (t0 === null) { t0 = t; last = t; }
      else { dts.push(t - last); last = t; }
      const p = Math.min(1, (t - t0) / DUR);
      sc.scrollTop = max * (1 - p);
      if (p < 1) { requestAnimationFrame(step); } else { resolve(dts); }
    };
    requestAnimationFrame(step);
  }));
  const stats = (dts) => {
    const s = [...dts].sort((a, b) => a - b);
    const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
    return { frames: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), over33: s.filter((x) => x > 33.4).length };
  };
  const withBlur = stats(await scrollRun());
  await page.evaluate(() => document.body.style.setProperty('--bubble-blur', '0px'));
  const noBlur = stats(await scrollRun());
  console.log(`       25% + blur 5px (default):  ${JSON.stringify(withBlur)}`);
  console.log(`       25% + no blur (override):  ${JSON.stringify(noBlur)}`);
  ok(withBlur.frames > 20, 'the blurred scroll ran (headless software raster: timings are indicative, logged above)');
  await page.evaluate(() => document.body.style.removeProperty('--bubble-blur'));

  console.log('\n[phone 390: no Display group, the phone glass (html.phone-glass), the wash kept]');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addCookies(await context.cookies());
  await phone.addInitScript(HELPERS);
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(`phone: ${e}`));
  await pp.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('#line .entry');
  await sleep(2500);
  const ph = await pp.evaluate(() => {
    const a = [...document.querySelectorAll('#line > .entry.by-agent .entry-bubble')].pop();
    const u = [...document.querySelectorAll('#line > .entry.by-user .entry-bubble')].pop();
    a.id = 'pa';
    u.id = 'pu';
    return { a: window.__bub('#pa'), u: window.__bub('#pu'), vars: document.body.style.getPropertyValue('--bubble-alpha') };
  });
  /* the engine still holds 60 / 16 for this person (set above) and no script
     reads it any more, on either surface */
  ok(ph.vars === '', 'no inline --bubble-alpha on <body> on the phone either', ph.vars);
  /* PHONE GLASS [web/room-phone-7b]: 50% clear, NO backdrop blur, behind
     html.phone-glass (on by default); past 40%, the see-through lift */
  ok(Math.abs(ph.a.bg[3] - 128) <= 2 && Math.abs(ph.u.bg[3] - 128) <= 2, 'phone bubbles: 50% clear (html.phone-glass, on by default)', { a: ph.a.bg, u: ph.u.bg });
  ok((ph.a.bdf === 'none' || !ph.a.bdf) && (ph.u.bdf === 'none' || !ph.u.bdf) && (!ph.a.wbdf || ph.a.wbdf === 'none'), '...and NO backdrop blur on the phone', { a: [ph.a.bdf, ph.a.wbdf], u: [ph.u.bdf, ph.u.wbdf] });
  const lift = await pp.evaluate(() => {
    const ts = window.__rgb(getComputedStyle(document.querySelector('#pa .entry-ts')).color);
    const want = window.__exp('color-mix(in srgb, var(--dim) 50%, var(--text))');
    const n = [...document.querySelectorAll('#line > .entry.by-agent:not(.same) .entry-author')].pop();
    return { ts, want, author: n ? getComputedStyle(n).color : null };
  });
  ok(lift.ts.join() === lift.want.join() && /^oklch\(0\.92 /.test(lift.author || ''), '...with the see-through lift (the time halfway to --text, the @name at L .92)', lift);
  /* contrast on the phone: the default 10% art and the 40% stripes */
  console.log('\n[phone 390 contrast at 50% clear: text vs the lightest painted pixel of its own box]');
  const phoneC = {};
  for (const op of ['0.1', null]) {
    if (op) { await pp.evaluate((v) => document.getElementById('roomLine').style.setProperty('--wm-op', v), op); }
    await sleep(200);
    const m = await metaContrast(pp, true);
    phoneC[op ? '10%' : '40%'] = m;
    printMeta(`art ${op ? '10% (the default)' : '40% stripes'}`, m);
    if (op) { await pp.evaluate(() => document.getElementById('roomLine').style.removeProperty('--wm-op')); }
  }
  for (const [art, m] of Object.entries(phoneC)) {
    const body = Object.entries(m).filter(([k]) => k.includes('message text'));
    ok(body.length === 2 && body.every(([, v]) => v.ratio >= 4.5), `phone, art ${art}: message text >= 4.5:1 (${body.map(([k, v]) => `${k} ${v.ratio}`).join(', ')})`, body);
  }
  const meta10 = Object.entries(phoneC['10%']).filter(([k]) => !k.includes('message text'));
  ok(meta10.length > 0 && meta10.every(([, v]) => v.ratio >= 3), `phone, art 10% (the default): every meta item and the @name >= 3:1 (${meta10.map(([k, v]) => `${k} ${v.ratio}`).join(', ')})`, meta10);
  await pp.evaluate(() => document.documentElement.classList.remove('phone-glass'));
  await sleep(1300); // room-reply.css eases a bubble's background over .9s
  const off = await pp.evaluate(() => ({ a: window.__bub('#pa'), u: window.__bub('#pu') }));
  const phTs = await pp.evaluate(() => ({ ts: window.__rgb(getComputedStyle(document.querySelector('#pa .entry-ts')).color), dim2: window.__exp('var(--dim2)') }));
  ok(off.a.bg[3] === 255 && off.u.bg[3] === 255 && off.a.bdf === 'none' && off.u.bdf === 'none' && phTs.ts.join() === phTs.dim2.join(), 'without html.phone-glass: opaque, unblurred, and the meta line back to --dim2 (no lift)', { a: [off.a.bg, off.a.bdf], u: [off.u.bg, off.u.bdf], phTs });
  await pp.evaluate(() => document.documentElement.classList.add('phone-glass'));
  ok(/at (left top|0% 0%)/.test(ph.a.img) && /at (right top|100% 0%)/.test(ph.u.img), 'the wash is on the phone too (agent left, you right)', { a: ph.a.img.slice(0, 60), u: ph.u.img.slice(0, 60) });
  const phFacts = await pp.evaluate(() => [...document.querySelectorAll('#line > .entry.by-room')].map((li) => !li.querySelector('.entry-bubble') && getComputedStyle(li).backgroundImage === 'none'));
  ok(phFacts.length > 0 && phFacts.every(Boolean), `no wash on facts (${phFacts.length})`);
  await pp.click('#phGear');
  await sleep(500);
  const phUi = await pp.evaluate(() => ({ group: !!document.querySelector('.rb-display') }));
  ok(!phUi.group, 'the phone\'s settings show no Display group', phUi);
  await phone.close();

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  if (engine) { engine.kill('SIGKILL'); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* the engine may still hold the db */ }
}
console.log(`\n${failures ? `FAIL ${failures}` : 'PASS'}`);
process.exit(failures ? 1 : 0);
