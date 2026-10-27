/* ROOM CHARACTER — art + wash + accent from one room colour (the design system
 * room-character v1.1, the design system 9a21656) [rooms/character].
 *
 *   node test/room-character.probe.mjs
 *
 * Proves, at 1280 and 390, with COMPUTED colours read back through a 1x1
 * canvas (getComputedStyle answers oklch()/color() strings in Chromium):
 *   - UNSET colour, no art = today's look exactly: Send / + / focus are teal
 *     and every sampled colour is byte-identical before and after a
 *     set-then-clear round trip; no wash, no art
 *   - a SET colour: Send (edge + glyph), the seats +, the composer +, the
 *     composer's focus ring take --room-accent (L .80 from the room colour);
 *     --teal is never re-declared; coral and the seat status rings do not move
 *   - the coral / amber GUARD: a red or amber room caps the accent chroma at
 *     .06 (--rm-cmax); a magenta one does not
 *   - ART, the existing watermark method: the line column is a .wm-pane with
 *     the ART's washFrom, --wm-pc = the room colour (the one override); the
 *     mark is centred, its width = the art's scale, its opacity = the art's,
 *     its line style = the art's; it does not scroll with the feed and sits
 *     under it; an unstyled preset takes the defaults (80% / 10% / ll-mid /
 *     backlit)
 *   - FINAL RULING: the art renders EXACTLY as an agent pane does. Reference:
 *     the same art + colour painted by solo.js's own path (renderLogo +
 *     paintWatermarkVars into a pane) gives the same computed tint, glow,
 *     line style, scale and opacity. No "use the art's colours".
 *   - the title bar is window-chrome v32's .hwb-barwash (--pc = the room
 *     colour), fanned out from the room tab by the shell ({chrome:'bar-wash'});
 *     its 72px mark takes the art's line style + glow (hwbMarkClass)
 *   - v32 logoStyle on EVERY tab: the room tab, the level-2 room row and
 *     member tabs, a top-level agent tab (and its session-bar mark), and the
 *     CLI Manager's card watermark
 *   - the settings column: the Art group (a live preview drawn the same way,
 *     Choose art… = the recipe form's picker, Remove, "From the
 *     art: …"); each saves and persists
 *   - the CLI Manager: the room tab gets base = the room colour and logo =
 *     the room art; inside the room (?rooms=2) the F1 room row wears the same
 *   - phone: the header wash + mark, the art behind the line, + / Send in the
 *     accent at 44px, header glyphs neutral, the filter dot in the accent
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(204), DEAD broker P(205).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(204);
const DEAD_BROKER_PORT = P(205);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-character-token';
const SHOTS = process.env.ROOMCHAR_SHOTS || tmpdir();

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 2) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

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

/* In-page helpers: resolve an expression the way the page would (a probe div
   under <body>, so the room's custom properties apply), and read any computed
   colour string back as RGBA through a 1x1 canvas. */
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
  window.__cs = (sel, prop) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    return el ? window.__rgb(getComputedStyle(el)[prop]) : null;
  };
  window.__exp = (expr) => window.__rgb(window.__res(expr));
};

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-character.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-character-'));
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
const PICK = '#ba08b4'; // magenta: hue ~330, far from coral and amber
const RED = '#ba0d0d'; // hue ~27: next to coral
const AMBER = '#c9a227'; // hue ~95: within 20deg of amber (84)
const ART_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#ff0000" d="M10 10h80v80H10z"/></svg>';
const ART_STYLE = { line: 'hatch', washFrom: 'ur', backlit: true, scale: 60, opacity: 22 };
const ACCENT = (hex, cmax = '.14') => `oklch(from ${hex} .80 clamp(.05, calc(c * .75), ${cmax}) h)`;
/* the lead recipe wears a preset with its own treatment (engrave, no glow) */
const PRESETS = JSON.parse(/\{[\s\S]*\}/.exec(readFileSync(join(REPO_ROOT, 'web', 'vendor', 'aurora-logo-presets.js'), 'utf8'))[0]);
const LEAD_LOGO = JSON.stringify({ key: 'harbor', svg: PRESETS.harbor, scale: 70, opacity: 12, mono: 'white', line: 'engrave', washFrom: 'll', backlit: false });

try {
  await seed({ recipes: [
    { id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: LEAD_COLOR, logo: LEAD_LOGO },
    { id: 'rec-b', name: 'Bravo', projectDir: '/srv/x/bravo', vendor: 'claude-code', agent: 'bravo', color: '#1f5fbf' },
  ],
  /* a dehydrated occupant: @bravo wears a real status ring (restorable, amber) */
  sessions: [{ paneid: 'recipe:rec-b', recipe_id: 'rec-b', vendor: 'claude-code', agent: 'bravo', state: 'dehydrated' }] });
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

  const post = await seed({ rooms: [{ name: 'Character', seats: [{ handle: 'awake', recipe_id: 'rec-a' }, { handle: 'bravo', recipe_id: 'rec-b', occupant: 'recipe:rec-b' }] }] });
  const R = post.rooms[0].id;
  const bearer = (path, init = {}) => fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const roomNow = async () => (await (await bearer(`/api/rooms/${R}`)).json()).room;

  /* the art: a library set with its OWN treatment (the Icons page's job) */
  const made = await (await bearer('/api/logos', { method: 'POST', body: JSON.stringify({ name: 'Probe Art', svg: ART_SVG }) })).json();
  const LIB = `lib:${made?.logo?.id}`;
  const styled = await bearer(`/api/logos/${made?.logo?.id}`, { method: 'PATCH', body: JSON.stringify({ style: ART_STYLE }) });
  ok(!!made?.logo?.id && styled.status === 200, 'a library set with its own style (hatch · ur · backlit · 60% · 22%)', LIB);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(HELPERS);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const patch = async (body) => {
    const r = await fetch(`${BASE}/api/rooms/${R}/settings`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  /* enough lines that the feed scrolls */
  for (let i = 0; i < 40; i += 1) {
    await fetch(`${BASE}/api/rooms/${R}/line`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: `line ${i} — the backdrop must stay put while this scrolls` }) });
  }
  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .seat');
  await sleep(1500);

  /* ---- a snapshot of everything the colour rule touches ---- */
  const snap = (p) => p.evaluate(() => {
    const ta = document.getElementById('input');
    ta.focus();
    const focus = window.__cs(ta, 'outlineColor');
    ta.blur();
    /* the SEATS' status rings (not the room row's folder, which is the room's identity) */
    /* what is PAINTED: an element at opacity 0 or under display:none (the
       ring's sweep / halo, a never-started seat's hidden ring group) draws
       nothing whatever its stroke says */
    const painted = (e) => {
      for (let n = e; n && n !== document.body; n = n.parentElement) {
        const c = getComputedStyle(n);
        if (c.display === 'none' || c.opacity === '0' || c.visibility === 'hidden') { return false; }
      }
      return true;
    };
    const ring = [...document.querySelectorAll('#roster .seat:not(.is-room) .seat-glyph *')].slice(0, 40)
      .map((e) => { const c = getComputedStyle(e); return !painted(e) ? 'unpainted' : [`${e.tagName}.${e.getAttribute('class') || ''}`, c.stroke, c.fill, c.color, c.borderColor].join('|'); }).join(';');
    /* a ring state that relies on INHERITANCE for --rc (hwb-ring.css owns
       it; a never-started seat's ring group is hidden, so force it visible
       for the read): its stroke must never be the room colour */
    const g = document.querySelector('#roster .seat:not(.is-room) .ring.is-plate-only .rg-scale');
    let inherited = null;
    if (g) {
      g.style.display = 'inline';
      const t = g.querySelector('.rg-track');
      inherited = { stroke: getComputedStyle(t).stroke, rcOnBody: getComputedStyle(document.body).getPropertyValue('--rc').trim() };
      g.style.removeProperty('display');
    }
    const line = document.getElementById('roomLine');
    return {
      inherited,
      send: window.__cs('.rm-send', 'borderTopColor'), sendInk: window.__cs('.rm-send', 'color'),
      plus: window.__cs('#addBtn', 'color'), attach: window.__cs('.rm-attach', 'color'), focus,
      teal: window.__exp('var(--teal)'), coral: window.__exp('var(--coral)'), amber: window.__exp('var(--amber)'),
      tealVar: getComputedStyle(document.body).getPropertyValue('--teal').trim(),
      accentVar: getComputedStyle(document.body).getPropertyValue('--room-accent').trim(),
      cmax: getComputedStyle(document.body).getPropertyValue('--rm-cmax').trim(),
      ring, lineBg: getComputedStyle(line).backgroundImage, wmPane: line.classList.contains('wm-pane'),
      art: (() => { const a = line.querySelector(':scope > .rc-art'); return a ? { shown: getComputedStyle(a).display !== 'none', svg: !!a.querySelector('svg') } : null; })(),
      hmark: !!document.querySelector('.rm-top .rc-hmark:not([hidden]) svg'),
      bubble: (() => { const b = document.querySelector('.entry.by-user .entry-bubble'); return b ? window.__cs(b, 'backgroundColor') : null; })(),
    };
  });

  console.log('\n[unset colour, no art: today\'s look exactly]');
  const base0 = await snap(page);
  ok(near(base0.send, base0.teal) && near(base0.sendInk, base0.teal) && near(base0.plus, base0.teal), 'Send (edge + glyph) and the seats + are teal', { send: base0.send, teal: base0.teal });
  ok(base0.focus && near(base0.focus.slice(0, 3), base0.teal.slice(0, 3)), 'the composer focus ring is teal', base0.focus);
  ok(base0.accentVar === '' && !base0.wmPane && base0.lineBg === 'none' && (!base0.art || !base0.art.shown) && !base0.hmark, 'no --room-accent, no wash, no art, no header mark', base0);
  await page.screenshot({ path: join(SHOTS, 'room-character-unset.png') });

  console.log('\n[a SET room colour drives the accent; status never moves]');
  let r = await patch({ color: PICK });
  ok(r.status === 200 && r.body?.room?.color === PICK, 'PATCH color (a person): 200', r.status);
  await sleep(1500);
  const set1 = await snap(page);
  const acc = await page.evaluate((e) => window.__exp(e), ACCENT(PICK));
  ok(near(set1.send, acc) && near(set1.sendInk, acc), 'Send (edge + glyph) = --room-accent (L .80 from the room colour)', { send: set1.send, acc });
  ok(near(set1.plus, acc) && near(set1.attach, acc), 'the seats + and the composer + = the accent', { plus: set1.plus, attach: set1.attach });
  ok(set1.focus && near(set1.focus.slice(0, 3), acc.slice(0, 3)) && Math.abs(set1.focus[3] - 179) <= 2, 'the composer FOCUS RING = the accent at 70%', set1.focus);
  ok(set1.tealVar === base0.tealVar && near(set1.teal, base0.teal), '--teal is never re-declared', set1.tealVar);
  ok(near(set1.coral, base0.coral) && near(set1.amber, base0.amber), 'coral and amber do not move', { coral: set1.coral });
  const rd = (a, b) => { const x = a.split(';'); const y = b.split(';'); const i = x.findIndex((v, k) => v !== y[k]); return i < 0 ? null : { i, was: x[i], now: y[i] }; };
  ok(set1.ring === base0.ring && /rg-track\|(rgb|oklch|color)\(/.test(set1.ring), 'the seat status rings (a restorable ring among them) are byte-identical', rd(base0.ring, set1.ring) ?? set1.ring.split(';').filter((x) => /rg-track/.test(x)));
  ok(set1.cmax === '', 'magenta: no chroma guard', set1.cmax);
  ok(base0.inherited && set1.inherited && base0.inherited.stroke === set1.inherited.stroke && set1.inherited.rcOnBody === ''
    && !/186, 8, 180|13, 171, 73/.test(set1.inherited.stroke),
  'a ring state that INHERITS --rc (the never-started ring, forced visible) never takes the room colour; body sets no --rc', { was: base0.inherited, now: set1.inherited });
  ok(set1.wmPane && !set1.hmark, 'a colour with no art: the line takes the room wash (.wm-pane), no mark', set1.lineBg.slice(0, 60));
  /* [rooms/bubble-defaults] desktop bubbles are also fixed at 25% transparent
     (--bb-clear default, room-bubbles.css) on top of the 7% accent tint */
  const bubbleExp = await page.evaluate(() => window.__exp('color-mix(in srgb, color-mix(in srgb, var(--room-accent) 7%, var(--surface3, var(--surface2))) 75%, transparent)'));
  ok(set1.bubble && near(set1.bubble, bubbleExp) && !near(set1.bubble, base0.bubble ?? [0]), 'your own bubble takes the 7% accent tint, at the fixed 25% transparency', { got: set1.bubble, exp: bubbleExp });

  console.log('\n[the coral / amber guard]');
  for (const [hex, what] of [[RED, 'a red room (hue ~27, coral 29)'], [AMBER, 'an amber room (within 20deg of 84)']]) {
    await patch({ color: hex });
    await sleep(1200);
    const s = await snap(page);
    const guarded = await page.evaluate((e) => window.__exp(e), ACCENT(hex, '.06'));
    const unguarded = await page.evaluate((e) => window.__exp(e), ACCENT(hex, '.14'));
    ok(s.cmax === '0.06' && near(s.send, guarded) && !near(s.send, unguarded, 4), `${what}: --rm-cmax .06, Send = the capped accent (a tinted neutral, not an alarm)`, { cmax: s.cmax, send: s.send, guarded, unguarded });
  }

  console.log('\n[unset again = today exactly]');
  await patch({ color: null });
  await sleep(1200);
  const back0 = await snap(page);
  const same = ['send', 'sendInk', 'plus', 'attach', 'focus', 'bubble'].every((k) => JSON.stringify(back0[k]) === JSON.stringify(base0[k]));
  ok(same && back0.accentVar === '' && back0.cmax === '' && !back0.wmPane && back0.lineBg === 'none', 'every sampled colour is identical to the unset baseline; no accent, guard or wash', back0);

  console.log('\n[ART: the existing watermark method; the room colour is the one override]');
  r = await patch({ color: PICK, art: LIB });
  ok(r.status === 200 && r.body?.room?.art === LIB && r.body?.room?.art_render?.name === 'Probe Art', 'PATCH art = the library key: 200, art_render comes back', r.body?.room?.art);
  await sleep(1500);
  const artState = () => page.evaluate(() => {
    const line = document.getElementById('roomLine');
    const host = line.querySelector(':scope > .rc-art');
    const svg = host?.querySelector('svg');
    const lr = line.getBoundingClientRect();
    const ar = host.getBoundingClientRect();
    const path = svg?.querySelector('path');
    return {
      cls: [...line.classList].join(' '), wmPc: line.style.getPropertyValue('--wm-pc'), wmOp: line.style.getPropertyValue('--wm-op'),
      inScroll: !!host.closest('#lineScroll'), z: getComputedStyle(host).zIndex, iso: getComputedStyle(line).isolation,
      scrollZ: getComputedStyle(document.getElementById('lineScroll')).zIndex,
      cx: ar.left + ar.width / 2 - (lr.left + lr.width / 2), cy: ar.top + ar.height / 2 - (lr.top + lr.height / 2),
      wPct: ar.width / lr.width, rect: [ar.left, ar.top, ar.width, ar.height].map(Math.round),
      svgCls: svg ? [...svg.classList].join(' ') : null, backlit: !!host.querySelector('.wm-backlit'),
      op: svg ? getComputedStyle(svg).opacity : null, ink: svg ? window.__cs(svg, 'color') : null,
      fill: path ? window.__cs(path, 'fill') : null,
      glow: host.querySelector('.wm-backlit') ? getComputedStyle(host.querySelector('.wm-backlit')).filter : null,
      hmark: (() => { const m = document.querySelector('.rm-top .rc-hmark:not([hidden]) > span'); if (!m) { return null; } const b = m.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), op: getComputedStyle(m).opacity, svg: !!m.querySelector('svg') }; })(),
      pe: getComputedStyle(host).pointerEvents,
    };
  });
  let a = await artState();
  ok(/\bwm-pane\b/.test(a.cls) && /\bwm-at-ur\b/.test(a.cls), "the line is a .wm-pane, the wash from the ART's washFrom (ur)", a.cls);
  ok(a.wmPc === PICK, '--wm-pc = the ROOM colour (the one override)', a.wmPc);
  ok(Math.abs(a.cx) <= 2 && Math.abs(a.cy) <= 2, 'the mark is CENTRED in the line column', { dx: a.cx, dy: a.cy });
  ok(Math.abs(a.wPct - 0.60) < 0.01, "its width = the art's scale (60% of the column)", a.wPct.toFixed(3));
  ok(a.op === '0.22' && a.wmOp === '0.22', "its opacity = the art's (22%)", a.op);
  ok(a.svgCls.split(' ').includes('wm') && a.svgCls.split(' ').includes('wm-line-hatch') && a.backlit, "the art's line style (hatch) and its glow (backlit)", a.svgCls);
  const inkExp = await page.evaluate((h) => window.__exp(`oklch(from ${h} .820 clamp(0, calc(c * .60), .110) h)`), PICK);
  ok(near(a.ink, inkExp) && near(a.fill, inkExp), 'the mark is the single --wm-ink tint from the room colour (L .82): the authored red is overridden', { ink: a.ink, fill: a.fill });
  /* THE REFERENCE: the agent pane's own rendering (solo.js ~657: renderLogo
     into the pane's logo host + paintWatermarkVars) for the same art and the
     same colour, beside the room's; computed values must match */
  const ref = await page.evaluate(async ({ id, colour }) => {
    const lm = await import('/logo-modal.mjs');
    const asset = (await (await fetch('/api/logos')).json()).logos.find((l) => l.id === id);
    const st = lm.assetStyle(asset);
    const logo = { svg: asset.svg, scale: st.scale, opacity: st.opacity, mono: 'white', line: st.line, washFrom: st.washFrom, backlit: st.backlit };
    const pane = document.createElement('div');
    pane.style.cssText = 'position:fixed;left:0;top:0;width:' + document.getElementById('roomLine').getBoundingClientRect().width + 'px;height:400px;visibility:hidden';
    const host = document.createElement('div');
    host.className = 'pane-logo';
    host.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)';
    pane.append(host);
    document.body.append(pane);
    lm.renderLogo(host, logo, { pane });
    lm.paintWatermarkVars(pane, logo, colour);
    await new Promise((r) => requestAnimationFrame(r));
    const svg = host.querySelector('svg');
    const out = {
      ink: window.__cs(svg, 'color'), fill: window.__cs(svg.querySelector('path'), 'fill'), op: getComputedStyle(svg).opacity,
      svgCls: [...svg.classList].join(' '), paneCls: [...pane.classList].join(' '),
      glow: host.querySelector('.wm-backlit') ? getComputedStyle(host.querySelector('.wm-backlit')).filter : null,
      wash: getComputedStyle(pane).backgroundImage, wPct: host.getBoundingClientRect().width / pane.getBoundingClientRect().width,
    };
    pane.remove();
    return out;
  }, { id: Number(LIB.slice(4)), colour: PICK });
  const roomWash = await page.evaluate(() => getComputedStyle(document.getElementById('roomLine')).backgroundImage);
  ok(near(a.ink, ref.ink) && near(a.fill, ref.fill) && a.op === ref.op, 'REFERENCE (the agent pane path, same art + colour): the same computed tint and opacity', { room: [a.ink, a.op], pane: [ref.ink, ref.op] });
  ok(a.glow && a.glow === ref.glow, '...the same glow (.wm-backlit from --wm-glow)', { room: a.glow, pane: ref.glow });
  ok(a.svgCls === ref.svgCls && a.cls.replace('rm-line ', '') === ref.paneCls && Math.abs(a.wPct - ref.wPct) < 0.01, '...the same line style, washFrom and scale', { room: [a.svgCls, a.cls], pane: [ref.svgCls, ref.paneCls] });
  ok(roomWash === ref.wash, '...and the same wash', roomWash.slice(0, 80));
  ok(!a.inScroll && a.z === '-1' && a.iso === 'isolate' && a.pe === 'none', 'a backdrop: outside the scroller, under the feed and composer, no pointer events', { z: a.z, iso: a.iso });
  const scrolled = await page.evaluate(() => { const s = document.getElementById('lineScroll'); const top = s.scrollTop; s.scrollTop = 0; const r0 = document.querySelector('#roomLine > .rc-art').getBoundingClientRect(); s.scrollTop = s.scrollHeight; const r1 = document.querySelector('#roomLine > .rc-art').getBoundingClientRect(); return { scrollable: s.scrollHeight > s.clientHeight + 50, moved: Math.abs(r0.top - r1.top), top }; });
  ok(scrolled.scrollable && scrolled.moved === 0, 'the feed scrolls; the art does not move', scrolled);
  ok(a.hmark && a.hmark.w === 72 && a.hmark.h === 72 && a.hmark.op === '0.14' && a.hmark.svg, 'the header carries the 72px mark at 14%', a.hmark);
  const hdr = await page.evaluate(() => {
    const h = document.querySelector('.rm-top');
    const m = h.querySelector('.rc-hmark > span');
    return { cls: [...h.classList].join(' '), pc: getComputedStyle(h).getPropertyValue('--pc').trim(), bg: getComputedStyle(h).backgroundImage,
      x: h.style.getPropertyValue('--bar-wash-x'), markCls: m ? [...m.classList].join(' ') : null,
      mid: window.__exp('var(--sb-mid)'), midOf: null };
  });
  const midExp = await page.evaluate((h) => window.__exp(`oklch(from ${h} .320 clamp(0, calc(c * .40), .070) h)`), PICK);
  ok(/\bhwb-barwash\b/.test(hdr.cls) && hdr.pc === PICK && /linear-gradient\(oklch\(0\.32 /.test(hdr.bg) && !/oklch\(0\.27/.test(hdr.bg), 'the title bar is v32 .hwb-barwash from --pc = the room colour (the old left-to-right gradient is gone)', { cls: hdr.cls, pc: hdr.pc, bg: hdr.bg });
  ok(hdr.x === '', 'standalone: no --bar-wash-x (the bundle default, 105px)', hdr.x);
  ok(hdr.markCls === 'mark wm-line-hatch wm-backlit', "the header mark takes the ART's line style + glow (hwbMarkClass)", hdr.markCls);
  const sbMid = await page.evaluate(() => window.__rgb(getComputedStyle(document.querySelector('.rm-top')).getPropertyValue('--sb-mid')));
  ok(near(sbMid, midExp), '...its wash tone is the bar\'s own (--sb-mid from the room colour)', { sbMid, midExp });
  await page.screenshot({ path: join(SHOTS, 'room-character-mono.png') });

  r = await patch({ art: 'speech' });
  await sleep(1500);
  a = await artState();
  ok(/\bwm-at-ll-mid\b/.test(a.cls) && Math.abs(a.wPct - 0.80) < 0.01 && a.op === '0.1' && a.backlit, 'an unstyled PRESET takes the defaults: ll-mid, 80%, 10%, backlit', { cls: a.cls, w: a.wPct, op: a.op, backlit: a.backlit });

  console.log('\n[the settings column: the Art group]');
  await patch({ art: LIB });
  await sleep(1200);
  await page.click('#gearBtn');
  await sleep(500);
  const grp = () => page.evaluate(() => {
    const g = document.querySelector('.rc-grp');
    if (!g) { return null; }
    const prev = g.querySelector('.rc-prev');
    const pr = prev.getBoundingClientRect();
    return {
      title: g.querySelector('h4')?.textContent, prevW: Math.round(pr.width), prevH: Math.round(pr.height),
      prevPane: prev.classList.contains('wm-pane'), prevAt: [...prev.classList].find((c) => c.startsWith('wm-at-')) ?? null,
      prevSvg: !!prev.querySelector('.rc-art svg'), prevPc: prev.style.getPropertyValue('--wm-pc'),
      choose: g.querySelector('.pv-btn.pri')?.textContent, remove: !g.querySelectorAll('.pv-btn')[1]?.hidden,
      sw: !!g.querySelector('.pv-switch, [role=switch]'),
      from: g.querySelector('.rc-from')?.textContent, name: g.querySelector('.rc-artname')?.textContent,
      style: !!g.querySelector('select, .origin, [data-at]'),
    };
  });
  let gs = await grp();
  ok(gs && gs.title === 'Room art' && gs.prevW === 72 && gs.prevH === 72, 'the Art group: a 72px preview', gs);
  ok(gs.prevPane && gs.prevAt === 'wm-at-ur' && gs.prevSvg && gs.prevPc === PICK, '...drawn by the same method (wm-pane, the art\'s washFrom, the room colour)', gs);
  ok(gs.choose === 'Choose art…' && gs.remove && gs.name === 'Probe Art', '...Choose art…, Remove and the art\'s name', gs);
  ok(!gs.sw, 'no "Use the art\'s colours" switch (final ruling)', gs.sw);
  ok(/^From the art: hatch · wash from ur · backlit · 60% · 22%\. Edit it on the Art page\.$/.test(gs.from ?? ''), 'a dim line names the art\'s own style', gs.from);
  ok(!gs.style, 'NO style controls in the room (v1.1: style belongs to the art)');
  await page.click('.rc-grp .pv-btn.pri');
  await page.waitForSelector('.lm-modal.open', { timeout: 5000 });
  ok(true, 'Choose art… opens the recipe form\'s art picker (the shared logo modal)');
  await page.waitForFunction(() => [...document.querySelectorAll('.lm-preset option')].some((o) => o.value === 'library'));
  await page.selectOption('.lm-preset', 'library');
  await page.click('.lm-modal .lm-btn.save');
  await sleep(1000);
  ok((await roomNow()).art === 'library', 'picking a preset + Save persists art = its key', (await roomNow()).art);
  gs = await grp();
  ok(gs.name === 'library' && gs.prevAt === 'wm-at-ll-mid', '...and the preview repaints (the preset\'s defaults)', gs);
  await page.screenshot({ path: join(SHOTS, 'room-character-settings.png') });
  await page.click('.rc-grp .pv-btn:not(.pri)');
  await sleep(900);
  ok((await roomNow()).art === null && (await artState()).svgCls === null, 'Remove clears the art (persisted), the line keeps only the wash');
  await patch({ art: LIB });
  await sleep(1000);

  console.log('\n[the CLI Manager: the room tab]');
  const shell = await context.newPage();
  shell.on('pageerror', (e) => errors.push(`shell: ${e}`));
  const shellUrl = (flag) => `${BASE}/app/shell.html?kind=manager&debug=1${flag ? '&rooms=2' : ''}&tabs=${encodeURIComponent('/manager.html')},${encodeURIComponent(`/room.html?room=${R}`)}`;
  await shell.goto(shellUrl(false), { waitUntil: 'domcontentloaded' });
  await sleep(5000);
  const tab = await shell.evaluate(() => {
    const t = [...document.querySelectorAll('.hwb-tab[data-tab]')].find((x) => /Character/.test(x.textContent));
    if (!t) { return null; }
    const lg = t.querySelector('.tlogo');
    return { base: t.style.getPropertyValue('--base'), logo: !!lg?.querySelector('svg'), path: lg?.querySelector('path')?.getAttribute('d') ?? null,
      folder: !!t.querySelector('.ring'), active: t.classList.contains('is-active'), id: t.dataset.tab };
  });
  ok(tab && tab.base === PICK, 'the room tab: base = the room colour', tab);
  ok(tab && tab.logo && tab.path === 'M10 10h80v80H10z', '...logo = the room ART (its unselected-tab watermark)', tab);
  const tcls = await shell.evaluate((id) => [...document.querySelector(`.hwb-tab[data-tab="${id}"] .tlogo`).classList].join(' '), tab.id);
  ok(tcls === 'tlogo wm-line-hatch wm-backlit', "...drawn with the art's own style (v32 logoStyle: hatch + glow)", tcls);
  /* the title bar inside the shell fans out from the room tab */
  await shell.click(`.hwb-tab[data-tab="${tab.id}"]`);
  await sleep(1500);
  const wash = await shell.evaluate((id) => {
    const t = document.querySelector(`.hwb-tab[data-tab="${id}"]`).getBoundingClientRect();
    const w = document.getElementById('win').getBoundingClientRect();
    const fr = [...document.querySelectorAll('#stage iframe')].find((f) => /room\.html/.test(f.src));
    const h = fr.contentDocument.querySelector('.rm-top');
    return { x: h.style.getPropertyValue('--bar-wash-x'), core: h.style.getPropertyValue('--bar-wash-core'),
      want: [Math.round(t.left - w.left + t.width / 2 - (fr.getBoundingClientRect().left - w.left)), Math.round(t.width / 2)] };
  }, tab.id);
  ok(wash.x === `${wash.want[0]}px` && wash.core === `${wash.want[1]}px`, "the shell posts the room tab's centre + half-width: the header's wash fans out from its tab", wash);
  /* clear what was posted, resize: the shell must post again */
  await shell.evaluate(() => { const fr = [...document.querySelectorAll('#stage iframe')].find((f) => /room\.html/.test(f.src)); const h = fr.contentDocument.querySelector('.rm-top'); h.style.removeProperty('--bar-wash-x'); h.style.removeProperty('--bar-wash-core'); });
  await shell.setViewportSize({ width: 1000, height: 800 });
  await sleep(800);
  const wash2 = await shell.evaluate(() => { const fr = [...document.querySelectorAll('#stage iframe')].find((f) => /room\.html/.test(f.src)); return fr.contentDocument.querySelector('.rm-top').style.getPropertyValue('--bar-wash-core'); });
  ok(wash2 !== '', '...and again on resize', { before: wash.core, after: wash2 });
  await shell.setViewportSize({ width: 1280, height: 860 });
  await shell.close();

  /* an AGENT tab: a session page reports its bar (project mark + the art's
     style); the tab watermark and the session bar's mark both take it */
  const shell3 = await context.newPage();
  shell3.on('pageerror', (e) => errors.push(`shell3: ${e}`));
  await shell3.goto(`${BASE}/app/shell.html?kind=manager&debug=1&tabs=${encodeURIComponent('/manager.html')},${encodeURIComponent('/mock-session.html?probe=agent')},${encodeURIComponent(`/room.html?room=${R}`)}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const agentFrame = shell3.frames().find((f) => /mock-session\.html\?probe=agent/.test(f.url()));
  await agentFrame.evaluate((svg) => parent.postMessage({ hwbBar: { project: { name: 'Agent', mark: svg, color: '#1f5fbf', markStyle: { line: 'outline', backlit: true } }, title: 'agent', brand: 'generic' } }, '*'), PRESETS.library);
  await sleep(800);
  const agent = await shell3.evaluate(() => {
    const t = [...document.querySelectorAll('.hwb-tab[data-tab]')].find((x) => x.querySelector('.tlogo svg') && !/Character/.test(x.textContent));
    return t ? { id: t.dataset.tab, cls: [...t.querySelector('.tlogo').classList].join(' ') } : null;
  });
  ok(agent && agent.cls === 'tlogo wm-line-outline wm-backlit', 'an AGENT tab: logoStyle from its page\'s bar (outline + glow)', agent);
  await shell3.click(`.hwb-tab[data-tab="${agent?.id}"]`);
  await sleep(800);
  const sb = await shell3.evaluate(() => { const m = document.querySelector('.hwb-sbar .sb-mark'); return m ? [...m.classList].join(' ') : null; });
  ok(sb === 'sb-mark wm-line-outline wm-backlit', '...and the session bar\'s mark (project.markStyle)', sb);
  await shell3.close();
  const shell2 = await context.newPage();
  shell2.on('pageerror', (e) => errors.push(`shell2: ${e}`));
  await shell2.goto(shellUrl(true), { waitUntil: 'domcontentloaded' });
  await sleep(5000);
  const rid = await shell2.evaluate(() => [...document.querySelectorAll('.hwb-tab[data-tab]')].find((x) => /Character/.test(x.textContent))?.dataset.tab);
  await shell2.click(`.hwb-tab[data-tab="${rid}"]`);
  await sleep(1500);
  const row = await shell2.evaluate(() => {
    const t = document.querySelector('.hwb-tab.is-room');
    if (!t) { return null; }
    return { dressed: t.classList.contains('rc-dressed'), base: t.style.getPropertyValue('--base'), folder: !!t.querySelector('.hwb-fglyph'),
      logo: !!t.querySelector('.tlogo svg'), active: t.classList.contains('is-active'), bg: window.__cs(t, 'backgroundColor') };
  });
  const washOn = await shell2.evaluate((h) => window.__exp(`oklch(from ${h} .28 clamp(0, calc(c * .35), .060) h)`), PICK);
  ok(row && row.dressed && row.base === PICK && row.folder, 'level 2: the F1 room row takes base = the room colour; the folder glyph stays', row);
  ok(row && row.active && near(row.bg, washOn), '...its ground is the room colour\'s tab wash (active)', { bg: row?.bg, washOn });
  ok(row && row.logo, '...and carries the room art as its (unselected-tab) watermark', row);
  const l2 = await shell2.evaluate(() => ({
    room: [...document.querySelector('.hwb-tab.is-room .tlogo').classList].join(' '),
    members: [...document.querySelectorAll('.hwb-tab[data-tab^="m:"]')].map((t) => [t.textContent.trim().slice(0, 12), t.querySelector('.tlogo') ? [...t.querySelector('.tlogo').classList].join(' ') : null]),
  }));
  ok(l2.room === 'tlogo wm-line-hatch wm-backlit', "...in the art's style (hatch + glow)", l2.room);
  ok(l2.members.some(([n, c]) => /awake/.test(n) && c === 'tlogo wm-line-engrave'), "member (agent) tabs: logoStyle from their recipe's art (engrave, no glow)", l2.members);
  await shell2.close();

  const mgr = await context.newPage();
  mgr.on('pageerror', (e) => errors.push(`manager: ${e}`));
  await mgr.goto(`${BASE}/manager.html#recipes`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const card = await mgr.evaluate(() => {
    const c = [...document.querySelectorAll('.sess.c4')].find((x) => /Awake/.test(x.querySelector('.sess-name')?.textContent ?? ''));
    const m = c?.querySelector('.sess-proj .row-mark');
    return m ? { cls: [...m.classList].join(' '), svg: !!m.querySelector('svg'), glow: getComputedStyle(c).getPropertyValue('--wm-glow').trim() !== '' } : null;
  });
  ok(card && card.svg && card.cls === 'row-mark wm-line-engrave' && card.glow, "the CLI Manager's card watermark takes the art's style (v32 hwbMarkClass)", card);
  await mgr.close();

  ok(errors.length === 0, 'no page errors (desktop)', errors.slice(0, 3));

  console.log('\n[phone 390]');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
  await phone.addInitScript(HELPERS);
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const ph = await pp.evaluate(() => {
    const hdr = document.querySelector('.ph-hdr');
    const mk = hdr.querySelector('.rc-hmark:not([hidden]) > span');
    const line = document.getElementById('roomLine');
    const host = line.querySelector(':scope > .rc-art');
    const lr = line.getBoundingClientRect();
    const ar = host.getBoundingClientRect();
    const box = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    return {
      hdrBg: getComputedStyle(hdr).backgroundImage, mark: mk ? [Math.round(mk.getBoundingClientRect().width), getComputedStyle(mk).opacity] : null,
      pane: line.classList.contains('wm-pane'), art: !!host.querySelector('svg'), cx: Math.round(ar.left + ar.width / 2 - (lr.left + lr.width / 2)),
      send: window.__cs('.rm-send', 'borderTopColor'), attach: window.__cs('.rm-attach', 'color'), sendBox: box('.rm-send'), attBox: box('.rm-attach'),
      glyphs: [...document.querySelectorAll('.ph-hdr .ph-ib')].map((b) => window.__rgb(getComputedStyle(b).color)), dim: window.__exp('var(--dim)'),
      dot: window.__cs('#phFilterDot', 'backgroundColor'), acc: window.__exp('var(--room-accent)'),
      sw: document.documentElement.scrollWidth,
    };
  });
  ok(/linear-gradient/.test(ph.hdrBg) && ph.mark && ph.mark[0] === 72 && ph.mark[1] === '0.14', 'phone: the header takes the wash + the 72px mark', ph);
  ok(ph.pane && ph.art && Math.abs(ph.cx) <= 2, 'phone: the art sits centred behind the line', ph.cx);
  ok(near(ph.send, ph.acc) && near(ph.attach, ph.acc) && ph.sendBox.join() === '44,44' && ph.attBox.join() === '44,44', 'phone: + and Send in the accent at 44px', { send: ph.send, box: ph.sendBox });
  ok(ph.glyphs.length >= 3 && ph.glyphs.every((g) => near(g, ph.dim)), 'phone: the header buttons stay neutral glyphs', ph.glyphs.length);
  ok(near(ph.dot, ph.acc), 'phone: the filter dot is in the accent', ph.dot);
  ok(ph.sw <= 390, 'phone: no sideways scroll', ph.sw);
  await pp.screenshot({ path: join(SHOTS, 'room-character-phone.png') });
  ok(perr.length === 0, 'no page errors (phone)', perr.slice(0, 3));
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
