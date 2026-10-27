/* ROOM AUTHORSHIP v2 — who wrote a line, with no bars (the design system
 * room-authorship-v2, Owner 2026-09-27).
 *
 *   node test/room-authorship.probe.mjs
 *
 * Proves, on the real engine (a scratch one) in a real Chromium:
 *   - YOUR lines sit on the RIGHT, agents' on the LEFT (bounding boxes); the
 *     room's facts are centred; a delivery sits under its message, on its side
 *   - a group's FIRST line carries the glyph beside it (top-aligned) and the
 *     @name; a continuation carries neither, and its tail corner tightens
 *   - the @name is the project colour's DERIVED tone (L .82), in the line AND
 *     the seats column; an agent bubble wears the derived wash (L .25) with an
 *     edge at L .34; your bubble is the neutral raised ground. Colours are
 *     compared by PAINTING to a canvas, never by parsing a computed string
 *   - no element on the room page has a coloured border-left / border-top
 *     wider than 1px (desktop, settings open, phone, phone sheet)
 *   - your picture: the monogram when none is set; edited in global Settings
 *     now (Owner 2026-09-30, not the room's ⚙ column any more -- a picked
 *     image there saves on the window's cookie, comes back SQUARE and
 *     <=256px; Remove returns the monogram; a bearer-only write is 403); a
 *     picture set there shows beside your lines here, after a reload; the
 *     room's own gear panel shows only a "Settings ›" link, no editor
 *   - phone at 390px: sides hold, the filter rows are lifted (.hwb-lift, the
 *     room tint), the sheet has no top line, no sideways scroll
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(114), DEAD broker P(115).
 * Screenshots land in AUTHORSHIP_SHOTS or the OS temp dir.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(114);
const DEAD_BROKER_PORT = P(115);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-authorship-token';
const SHOTS = process.env.AUTHORSHIP_SHOTS || tmpdir();
const LEAD_COLOR = '#0317b0'; // a deep blue: raw, it is unreadable on the surface
const BEE_COLOR = '#0dab49';

let failures = 0;
let passes = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (cond) { passes += 1; } else { failures += 1; }
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

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-authorship.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-authorship-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};
const call = async (path, init = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
};

/* In the page: paint a CSS colour (anything a div's `color` accepts, after
   computed-value resolution) to a 1x1 canvas and read the pixel back. */
const COLOR_KIT = () => {
  window.__px = (css) => {
    const d = document.createElement('div');
    d.style.color = css;
    document.body.append(d);
    const resolved = getComputedStyle(d).color;
    d.remove();
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const x = c.getContext('2d');
    x.fillStyle = resolved;
    x.fillRect(0, 0, 1, 1);
    return [...x.getImageData(0, 0, 1, 1).data];
  };
  window.__same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  /* every RENDERED element with a coloured left/top border wider than 1px */
  window.__bars = () => [...document.querySelectorAll('*')].flatMap((el) => {
    const cs = getComputedStyle(el);
    if (!el.getClientRects().length || cs.visibility === 'hidden') { return []; }
    return ['Left', 'Top'].filter((s) => parseFloat(cs[`border${s}Width`]) > 1 && cs[`border${s}Style`] !== 'none'
      && window.__px(cs[`border${s}Color`])[3] > 0)
      .map((s) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')} border-${s.toLowerCase()} ${cs[`border${s}Width`]} ${cs[`border${s}Color`]}`);
  });
};

try {
  const recipe = (id, name, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: [recipe('rec-lead', 'Lead', 'leadp', LEAD_COLOR), recipe('rec-b', 'Bee', 'bee', BEE_COLOR), recipe('rec-c', 'Sea', 'sea', null)] });
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
    rooms: [{ name: 'Authorship', seats: [{ handle: 'leadp', recipe_id: 'rec-lead', occupant: L1 }, { handle: 'bee', recipe_id: 'rec-b', occupant: B1 }, { handle: 'sea', recipe_id: 'rec-c' }] }],
  });
  const R = post.rooms[0].id;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(COLOR_KIT);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  /* the conversation: you → @room (a delivery "not live (@sea)" under it), the
     lead twice in a row (a group), bee once, then you again */
  await page.fill('#input', '@room first pass on the phone room, please read.');
  await page.click('#sendBtn');
  await sleep(700);
  for (const [text, pane] of [['Reading. Can you take the marks?', L1], ['Owner wants every coloured accent bar out.', L1], ['@leadp pinned the deploy graph.', B1]]) {
    const r = await call(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text, from: { paneid: pane } }) });
    ok(r.status === 200, `setup: a seat posts "${text.slice(0, 20)}…"`, r.status);
    await sleep(250);
  }
  await page.fill('#input', 'Thanks. Ship it.');
  await page.click('#sendBtn');
  await sleep(3000); // a poll: the roster (and the recipes' colours) are current

  const geo = () => page.evaluate(() => {
    const ol = document.getElementById('line').getBoundingClientRect();
    return [...document.querySelectorAll('#line > .entry')].filter((li) => getComputedStyle(li).display !== 'none').map((li) => {
      const r = li.getBoundingClientRect();
      const g = li.querySelector(':scope > .entry-glyph');
      const b = li.querySelector(':scope > .entry-bubble');
      const gr = g?.getBoundingClientRect();
      const br = b?.getBoundingClientRect();
      const author = li.querySelector('.entry-author');
      return {
        body: li.querySelector('.entry-body')?.textContent ?? '', cls: li.className, side: li.dataset.side || '',
        left: Math.round(r.left - ol.left), right: Math.round(ol.right - r.right), mid: Math.round((r.left + r.right) / 2 - (ol.left + ol.right) / 2),
        glyphVis: g ? getComputedStyle(g).visibility : null, glyphImg: !!g?.querySelector('img'), glyphText: g?.textContent ?? null, glyphPerson: !!g?.querySelector('svg.you-person'), glyphRing: !!g?.querySelector('.ring'),
        beside: gr && br ? { gR: Math.round(gr.right), gL: Math.round(gr.left), bL: Math.round(br.left), bR: Math.round(br.right), dTop: Math.round(Math.abs(gr.top - br.top)) } : null,
        name: author && getComputedStyle(author).display !== 'none' && !author.classList.contains('rm-sr') ? author.textContent : null,
        tl: b ? getComputedStyle(b).borderTopLeftRadius : null, tr: b ? getComputedStyle(b).borderTopRightRadius : null,
      };
    });
  });
  let g = await geo();
  const by = (s) => g.find((e) => e.body.startsWith(s));
  const me1 = by('@room first pass');
  const me2 = by('Thanks.');
  const a1 = by('Reading.');
  const a2 = by('Owner wants');
  const b1 = by('@leadp pinned');
  const dl = g.find((e) => /not live/.test(e.body) && e.side);
  const fact = g.find((e) => /was created/.test(e.body));
  ok(me1 && me2 && me1.right <= 2 && me2.right <= 2 && me1.left > 100, 'your lines sit on the RIGHT', { me1, me2 });
  ok(a1 && b1 && a1.left <= 2 && b1.left <= 2 && a1.right > 100, "agents' lines sit on the LEFT", { a1: a1 && [a1.left, a1.right], b1: b1 && [b1.left, b1.right] });
  ok(!!fact && Math.abs(fact.mid) <= 2 && fact.glyphVis === null, "the room's facts are centred, with no glyph", fact);
  ok(!!dl && dl.side === 'user' && dl.right >= 30 && dl.right <= 40, 'a delivery sits under YOUR message, on your side', dl);
  ok(a1?.glyphVis === 'visible' && a1.glyphRing && a1.name === '@leadp', "a group's first line: the seat glyph (plate + ring) and the @name", a1);
  ok(a1?.beside && a1.beside.gR <= a1.beside.bL && a1.beside.dTop <= 1, '...the glyph sits BESIDE the bubble, top-aligned', a1?.beside);
  ok(a2?.cls.includes('same') && a2.glyphVis === 'hidden' && a2.name === null, 'a continuation: no glyph, no name', a2);
  ok(a2?.tl === '4px' && a1?.tl === '12px', '...and its tail corner tightens', { first: a1?.tl, next: a2?.tl });
  ok(b1?.glyphVis === 'visible' && !b1.cls.includes(' same'), 'another author starts a new group', b1);
  ok(me1?.beside && me1.beside.gL >= me1.beside.bR && me1.beside.dTop <= 1, 'your glyph sits beside your bubble, on the right', me1?.beside);
  ok(me1?.glyphVis === 'visible' && !me1.glyphImg && me1.glyphText === '' && me1.glyphPerson, 'no picture and no account name (legacy): a person icon in the square, never "Y" from "you" (auriga FIX-1)', me1);
  ok(me1?.name === null, 'your name is not repeated on your own lines', me1?.name);

  /* colours, painted */
  const tones = await page.evaluate(({ lead }) => {
    const li = [...document.querySelectorAll('#line .entry.by-agent')].find((x) => x.dataset.author === 'leadp');
    const b = li.querySelector('.entry-bubble');
    const me = document.querySelector('#line .entry.by-user .entry-bubble');
    const seatName = document.querySelector('#roster .seat[data-handle="leadp"] .seat-handle');
    const cs = getComputedStyle(b);
    return {
      name: window.__px(getComputedStyle(li.querySelector('.entry-author')).color),
      seatName: window.__px(getComputedStyle(seatName).color),
      ink: window.__px(`oklch(from ${lead} .82 clamp(.02, calc(c * .6), .13) h)`),
      raw: window.__px(lead),
      /* [rooms/bubble-defaults] desktop bubbles are fixed at 25% transparent
         (--bb-clear default, room-bubbles.css): the bubble BACKGROUND (not
         its border) is 75% of the derived tone, color-mixed with transparent */
      wash: window.__px(cs.backgroundColor), washWant: window.__px(`color-mix(in srgb, oklch(from ${lead} .25 clamp(0, calc(c * .35), .045) h) 75%, transparent)`),
      edge: window.__px(cs.borderTopColor), edgeWant: window.__px(`oklch(from ${lead} .34 clamp(0, calc(c * .4), .06) h)`), edgeW: cs.borderTopWidth,
      mine: window.__px(getComputedStyle(me).backgroundColor), surface3: window.__px('color-mix(in srgb, var(--surface3) 75%, transparent)'),
      mineEdge: window.__px(getComputedStyle(me).borderTopColor), border2: window.__px('var(--border2)'),
    };
  }, { lead: LEAD_COLOR });
  ok(tones.name.every((v, i) => Math.abs(v - tones.ink[i]) <= 2) && !tones.name.every((v, i) => Math.abs(v - tones.raw[i]) <= 2),
    'the @name in the line is the DERIVED tone (L .82), not the raw project colour — painted', { name: tones.name, ink: tones.ink, raw: tones.raw });
  ok(tones.seatName.every((v, i) => Math.abs(v - tones.ink[i]) <= 2), '...and the seats column uses the same tone', tones.seatName);
  ok(tones.wash.every((v, i) => Math.abs(v - tones.washWant[i]) <= 2) && tones.edge.every((v, i) => Math.abs(v - tones.edgeWant[i]) <= 2) && tones.edgeW === '1px',
    'the agent bubble wears the derived wash (L .25) and a 1px edge (L .34) — painted', tones);
  ok(tones.mine.every((v, i) => Math.abs(v - tones.surface3[i]) <= 2) && tones.mineEdge.every((v, i) => Math.abs(v - tones.border2[i]) <= 2),
    'your bubble is the neutral raised ground (--surface3 + --border2)', { mine: tones.mine, mineEdge: tones.mineEdge });

  let bars = await page.evaluate(() => window.__bars());
  ok(bars.length === 0, 'desktop: no coloured border-left / border-top wider than 1px anywhere', bars);
  await page.screenshot({ path: join(SHOTS, 'room-authorship-desktop.png') });

  /* your picture: edited in global Settings now (Owner 2026-09-30), not the
     room -- see web/you-settings.mjs, mounted by web/settings.mjs. The room's
     own gear panel is checked first (link, no editor), then the editing
     itself happens on a separate /settings.html page (same browser context,
     so the same cookie), and finally the ROOM is reloaded to prove the new
     picture reaches the line glyphs (the room page has no live sync with a
     picture changed elsewhere -- a reload is how it picks it up). */
  const bearerWrite = await call('/api/rooms/me', { method: 'PATCH', body: JSON.stringify({ picture: null }) });
  ok(bearerWrite.status === 403, 'a bearer-only write of the picture: 403', bearerWrite.status);
  await page.click('#gearBtn');
  await sleep(400);
  const youDoor = () => page.evaluate(() => ({
    noPicField: !document.querySelector('.pv-set .pv-picacts'),
    noHandleField: !document.getElementById('meHandle'),
    link: document.querySelector('.pv-set a[href="/settings.html#you"]')?.textContent ?? null,
  }));
  const yd = await youDoor();
  ok(yd.noPicField && yd.noHandleField && yd.link, 'room settings: no picture editor, just a "Settings ›" link', yd);
  bars = await page.evaluate(() => window.__bars());
  ok(bars.length === 0, 'settings open: still no coloured bar', bars);
  await page.click('#gearBtn');
  await sleep(300);

  const settingsPage = await context.newPage();
  await settingsPage.goto(`${BASE}/settings.html`, { waitUntil: 'domcontentloaded' });
  await settingsPage.waitForSelector('section[data-group="you"][data-state="mounted"]', { timeout: 8000 }).catch(() => {});
  const card = () => settingsPage.evaluate(() => {
    const grp = document.querySelector('section.pv-grp[data-group="you"]');
    const big = grp?.querySelector('.pv-picbig .you');
    return { big: !!big, bigImg: !!big?.querySelector('img'), bigText: big?.textContent, bigPerson: !!big?.querySelector('svg.you-person'), remove: [...(grp?.querySelectorAll('.pv-picacts .pv-btn') ?? [])].find((b) => /Remove/.test(b.textContent))?.hidden, msg: grp?.querySelector('.pv-msg')?.textContent };
  });
  let k = await card();
  ok(k.big && !k.bigImg && k.bigText === '' && k.bigPerson && k.remove === true, 'Settings → You: the picture card shows the monogram and no Remove while none is set', k);
  /* a 300x200 (not square) PNG, made by the browser */
  const png = await settingsPage.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#c33';
    x.fillRect(0, 0, 300, 200);
    x.fillStyle = '#3c3';
    x.fillRect(100, 0, 100, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  const pngPath = join(tmpDir, 'me.png');
  writeFileSync(pngPath, Buffer.from(png, 'base64'));
  await settingsPage.setInputFiles('section[data-group="you"] .pv-picacts input[type=file]', pngPath);
  await sleep(1200);
  k = await card();
  ok(k.msg === 'Saved' && k.bigImg && k.remove === false, 'a picked image saves on the window cookie; Remove appears', k);
  const stored = (await call('/api/rooms/me')).body?.picture;
  ok(typeof stored === 'string' && /^data:image\/(webp|png|jpeg);base64,/.test(stored), 'the engine holds it as a data: URL', stored?.slice(0, 30));
  const dims = await settingsPage.evaluate(async (src) => { const i = new Image(); i.src = src; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, stored);
  ok(dims[0] === dims[1] && dims[0] <= 256, 'cropped to a SQUARE, at most 256px', dims);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  g = await geo();
  ok(g.filter((e) => e.cls.includes('by-user')).every((e) => e.glyphImg), 'after a reload, your lines wear the picture set in Settings', g.filter((e) => e.cls.includes('by-user')).map((e) => e.glyphImg));
  const imgSrc = await page.evaluate(() => document.querySelector('#line .entry.by-user .entry-glyph img')?.getAttribute('src')?.slice(0, 11));
  ok(imgSrc === 'data:image/', '...as an <img> from a data: URL', imgSrc);

  await settingsPage.click('section[data-group="you"] .pv-picacts .pv-btn.pv-txt');
  await sleep(800);
  k = await card();
  ok(!k.bigImg && k.remove === true, 'Remove: back to the monogram, in Settings', k);
  ok((await call('/api/rooms/me')).body?.picture === null, '...and the engine holds none');
  await settingsPage.close();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  g = await geo();
  ok(g.filter((e) => e.cls.includes('by-user')).every((e) => !e.glyphImg && e.glyphText === '' && e.glyphPerson), '...and after a reload, back to the monogram in the line too', g.filter((e) => e.cls.includes('by-user')).map((e) => [e.glyphImg, e.glyphText]));

  /* phone */
  const ctxP = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState(), hasTouch: true, isMobile: true });
  await ctxP.addInitScript(COLOR_KIT);
  const pp = await ctxP.newPage();
  pp.on('pageerror', (e) => errors.push(`phone: ${e}`));
  await pp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const ph = await pp.evaluate(() => {
    const ol = document.getElementById('line').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#line > .entry')].filter((li) => getComputedStyle(li).display !== 'none');
    const side = (cls) => rows.filter((li) => li.classList.contains(cls)).map((li) => { const r = li.getBoundingClientRect(); return [Math.round(r.left - ol.left), Math.round(ol.right - r.right)]; });
    return { sw: document.documentElement.scrollWidth, iw: innerWidth, user: side('by-user'), agent: side('by-agent') };
  });
  ok(ph.sw <= ph.iw, 'phone 390: no sideways scroll', ph);
  ok(ph.user.length > 0 && ph.user.every(([, r]) => r <= 2) && ph.agent.every(([l]) => l <= 2), 'phone: you right, agents left', ph);
  bars = await pp.evaluate(() => window.__bars());
  ok(bars.length === 0, 'phone: no coloured bar', bars);
  await pp.screenshot({ path: join(SHOTS, 'room-authorship-phone.png') });
  await pp.click('#phFilter');
  await sleep(400);
  await pp.click('#phSheet .ph-frow[data-who="me"]');
  await sleep(400);
  await pp.click('#phFilter');
  await sleep(400);
  const sheet = await pp.evaluate(() => {
    const sh = document.getElementById('phSheet');
    const cs = getComputedStyle(sh);
    const on = sh.querySelector('.ph-frow[aria-pressed="true"]');
    const ocs = getComputedStyle(on);
    const rc = document.body.style.getPropertyValue('--room-c');
    return {
      lift: [...sh.querySelectorAll('.ph-frow')].every((b) => b.classList.contains('hwb-lift')), who: on?.dataset.who,
      bt: cs.borderTopWidth, ground: window.__px(cs.backgroundColor), surface3: window.__px('var(--surface3)'), grab: !!sh.querySelector('.grab'),
      onBg: window.__px(ocs.backgroundColor), tint: window.__px(`oklch(from ${rc} .30 clamp(0, calc(c * .45), .06) h)`),
      onEdge: window.__px(ocs.borderLeftColor), edge: window.__px(`oklch(from ${rc} .45 clamp(0, calc(c * .55), .08) h)`), onBl: ocs.borderLeftWidth,
      check: getComputedStyle(on, '::after').content,
    };
  });
  ok(sheet.lift && sheet.who === 'me', 'phone filter rows are .hwb-lift', sheet);
  ok(sheet.onBl === '1px' && sheet.onBg.every((v, i) => Math.abs(v - sheet.tint[i]) <= 2) && sheet.onEdge.every((v, i) => Math.abs(v - sheet.edge[i]) <= 2),
    '...the pressed row is LIFTED in the room tint + its 1px edge, no bar — painted', { bg: sheet.onBg, tint: sheet.tint, edge: sheet.onEdge });
  ok(sheet.check.includes('✓'), '...with a ✓', sheet.check);
  ok(sheet.bt === '0px' && sheet.grab && sheet.ground.every((v, i) => Math.abs(v - sheet.surface3[i]) <= 2), 'the sheet: no top line, a grab handle, the lighter ground', sheet);
  bars = await pp.evaluate(() => window.__bars());
  ok(bars.length === 0, 'phone sheet open: no coloured bar', bars);
  await pp.screenshot({ path: join(SHOTS, 'room-authorship-phone-sheet.png') });
  await ctxP.close();

  ok(errors.length === 0, 'no page errors', errors);
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  if (engine) {
    engine.kill('SIGKILL');
    await sleep(200);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  if (failures) {
    console.log(`\nengine log (tail):\n${engineLog.split('\n').slice(-30).join('\n')}`);
  }
  console.log(`\nPASS ${passes}  FAIL ${failures}`);
  process.exit(failures ? 1 : 0);
}
