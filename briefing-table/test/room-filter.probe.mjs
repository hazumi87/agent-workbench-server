/* THE LINE FILTER AS ONE BUTTON (the design system room-filter-v1, Owner 2026-09-28).
 *
 *   node test/room-filter.probe.mjs
 *
 * What only a browser can prove:
 *   - the desktop filter STRIP is gone and the line starts under the room bar
 *   - the filter button sits immediately LEFT of the gear, a ghost icon button
 *     named "Filter the chat" (aria-haspopup=menu)
 *   - the menu: under the button, right-aligned, 268px, the manager-menu
 *     surface; SHOW IN THE CHAT (menuitemradio: Everyone · To me · Between
 *     agents · each @handle in its project ink), KINDS (menuitemcheckbox),
 *     the room default in words + Reset (disabled on the default)
 *   - live changes with the menu open; the LAST kind cannot be turned off;
 *     Reset restores the default and keeps the menu open; Esc / click-away /
 *     the button close it and return the focus; ↓ / Enter open it on the
 *     current seat choice; the arrows move; Space toggles
 *   - the teal dot (and the button's name) exactly while the feed differs from
 *     the ROOM default, including a default that is not "everything"; the
 *     phone's #phFilterDot follows the same rule
 *   - one Esc closes the menu, not the settings column under it
 *   - phone (390px): the bar button is not shown; #phFilter's sheet carries
 *     the same three sections; kinds toggle with the sheet up; no sideways
 *     scroll
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(160), DEAD broker P(161),
 * temp table seeded through the store (test/rooms-routes.seed.ts): never Owner's
 * data, childEnv() scrubbed, fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(160);
const DEAD_BROKER_PORT = P(161);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-filter-token';
const KINDS = ['chat', 'fact', 'delivery', 'attachment', 'command', 'voice'];

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (st) => st && { open: st.open, exp: st.exp, focus: st.focus, dot: st.dot, phDot: st.phDot, label: st.label, reset: st.reset?.off,
  who: st.radios?.find((r) => r.on)?.t, kinds: st.checks?.filter((c) => c.on).map((c) => c.k).join(), w: st.w, right: st.right, btnRight: st.btnRight, top: st.top };

let cookieP = null;
const userCookie = () => (cookieP ??= windowCookie(BASE, TOKEN));

async function call(path, opts = {}) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  const headers = roomUserWrite(path, method, opts.json) ? { cookie: await userCookie() } : { authorization: `Bearer ${TOKEN}` };
  const init = { method, headers };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

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
  await assertFree(p, 'room-filter.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-filter-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  const recipe = (id, name, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: [recipe('rec-lead', 'Leader', 'leader', '#ba08b4'), recipe('rec-bee', 'Bee', 'bee', '#0dab49'), recipe('rec-cee', 'Cee', 'cee', '#0317b0')] });

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

  const LEAD = 'recipe:rec-lead';
  const BEE = 'recipe:rec-bee';
  const live = (paneid, rid, agent) => ({ paneid, recipe_id: rid, vendor: 'claude-code', agent, state: 'live' });
  const post = await seed({
    sessions: [live(LEAD, 'rec-lead', 'leader'), live(BEE, 'rec-bee', 'bee')],
    rooms: [{
      name: 'Filter Probe',
      seats: [
        { handle: 'leader', recipe_id: 'rec-lead', occupant: LEAD },
        { handle: 'bee', recipe_id: 'rec-bee', occupant: BEE },
        { handle: 'cee', recipe_id: 'rec-cee' },
      ],
    }],
  });
  const R = post.rooms[0].id;
  const u1 = await call(`/api/rooms/${R}/line`, { json: { text: 'hello room from me' } });
  const l1 = await call(`/api/rooms/${R}/line`, { json: { text: 'lead to you', from: { paneid: LEAD } } });
  const a1 = await call(`/api/rooms/${R}/line`, { json: { text: '@bee agents only', from: { paneid: LEAD } } });
  ok([u1, l1, a1].every((r) => r.status === 200), 'setup: a line from you, the lead to you, the lead to @bee', [u1, l1, a1].map((r) => r.status));
  const facts = ((await call(`/api/rooms/${R}/line?kind=fact`)).body?.entries ?? []).length;
  ok(facts > 0, 'setup: the room has fact lines (seats added)', facts);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#line .entry');
  await sleep(1500);

  const shown = (pg = page) => pg.evaluate(() => [...document.querySelectorAll('#line > .entry')].filter((li) => getComputedStyle(li).display !== 'none')
    .map((li) => ({ kind: li.dataset.kind, body: li.querySelector('.entry-body')?.textContent ?? '' })));
  const menuState = () => page.evaluate(() => {
    const m = document.getElementById('filterMenu');
    const b = document.getElementById('filterBtn');
    const r = m.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const cs = getComputedStyle(m);
    return {
      open: !m.hidden && cs.display !== 'none', role: m.getAttribute('role'), exp: b.getAttribute('aria-expanded'),
      w: Math.round(r.width), right: Math.round(r.right), top: Math.round(r.top), btnRight: Math.round(br.right), btnBottom: Math.round(br.bottom),
      bg: cs.backgroundColor, border: `${cs.borderTopWidth} ${cs.borderTopColor}`, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow !== 'none', overflowY: cs.overflowY,
      heads: [...m.querySelectorAll('.rf-mh')].map((h) => h.textContent),
      radios: [...m.querySelectorAll('[role=menuitemradio]')].map((x) => ({ t: x.textContent.replace('✓', ''), on: x.getAttribute('aria-checked') === 'true', who: x.dataset.who })),
      checks: [...m.querySelectorAll('[role=menuitemcheckbox]')].map((x) => ({ k: x.dataset.kind, on: x.getAttribute('aria-checked') === 'true' })),
      reset: { role: m.querySelector('.rf-reset')?.getAttribute('role'), off: m.querySelector('.rf-reset')?.getAttribute('aria-disabled') === 'true' },
      resetVis: (() => { const x = m.querySelector('.rf-reset')?.getBoundingClientRect(); return x ? { top: Math.round(x.top), bottom: Math.round(x.bottom), menuBottom: Math.round(r.bottom) } : null; })(),
      note: m.querySelector('.rf-note')?.textContent,
      focus: document.activeElement?.dataset?.who ?? document.activeElement?.dataset?.kind ?? document.activeElement?.id ?? document.activeElement?.className,
      dot: getComputedStyle(b.querySelector('.rf-dot')).display !== 'none', label: b.getAttribute('aria-label'), title: b.title,
      phDot: !document.getElementById('phFilterDot').hidden,
    };
  });

  /* 1. the strip is gone; the line starts under the bar */
  const layout = await page.evaluate(() => {
    const top = document.querySelector('.rm-top').getBoundingClientRect();
    const line = document.getElementById('roomLine');
    const scroll = document.getElementById('lineScroll').getBoundingClientRect();
    const f = document.getElementById('filterBtn');
    const g = document.getElementById('gearBtn');
    const fr = f.getBoundingClientRect();
    const gr = g.getBoundingClientRect();
    const fcs = getComputedStyle(f);
    return {
      strip: !!document.querySelector('.rm-filters, #filters, #kindFilters, #seatFilter, #feedReset'),
      firstChild: line.firstElementChild?.id, gap: Math.round(scroll.top - top.bottom),
      next: f.nextElementSibling?.id, fr: [Math.round(fr.left), Math.round(fr.right), Math.round(fr.width), Math.round(fr.height)], gl: Math.round(gr.left), sameRow: Math.abs((fr.top + fr.bottom) - (gr.top + gr.bottom)) < 2,
      label: f.getAttribute('aria-label'), title: f.title, pop: f.getAttribute('aria-haspopup'), exp: f.getAttribute('aria-expanded'),
      path: f.querySelector('path')?.getAttribute('d'), bg: fcs.backgroundColor, bw: fcs.borderTopColor,
    };
  });
  ok(!layout.strip, 'the kind / seat filter strip is gone from the page', layout.strip);
  ok(layout.firstChild === 'lineScroll' && layout.gap <= 1, '...the line starts right under the room bar', layout);
  ok(layout.next === 'gearBtn' && layout.fr[1] <= layout.gl && layout.gl - layout.fr[1] <= 8 && layout.sameRow, 'the filter button sits immediately left of the gear, on its row', layout);
  ok(layout.fr[2] === 36 && layout.fr[3] === 36 && layout.bg === 'rgba(0, 0, 0, 0)', '...a ghost icon button the gear\'s size', layout);
  ok(layout.label === 'Filter the chat' && layout.title === 'Filter the chat' && layout.pop === 'menu' && layout.exp === 'false', '...named "Filter the chat", aria-haspopup=menu, collapsed', layout);
  ok(layout.path === 'M4 6h16M7 12h10M10 18h4', '...the phone\'s three-line glyph', layout.path);
  let st = await menuState();
  ok(!st.open && !st.dot, 'closed at rest; no dot on the room default', brief(st));

  /* 2. open by click: the menu */
  const all0 = await shown();
  await page.click('#filterBtn');
  await sleep(150);
  st = await menuState();
  ok(st.open && st.role === 'menu' && st.exp === 'true', 'a click opens the menu (role=menu, aria-expanded=true)', brief(st));
  ok(st.w === 268 && Math.abs(st.right - st.btnRight) <= 1 && st.top >= st.btnBottom, '...268px, under the button, right-aligned to it', brief(st));
  ok(st.radius === '8px' && st.shadow && /1px/.test(st.border) && st.overflowY === 'auto', '...the menu surface: radius 8, 1px edge, a shadow, scrolls inside', brief(st));
  const surface3 = await page.evaluate(() => { const d = document.createElement('div'); d.style.background = 'var(--surface3)'; document.body.append(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; });
  ok(st.bg === surface3, '...on --surface3', [st.bg, surface3]);
  ok(st.heads.join('|') === 'Show in the chat|Kinds', '...two section heads: SHOW IN THE CHAT, KINDS', st.heads);
  ok(st.radios.map((r) => r.t).join('|') === 'Everyone|To me|Between agents|Voice agent|@leader|@bee|@cee', '...menuitemradio: Everyone · To me · Between agents · Voice agent · each @handle (lead first)', st.radios.map((r) => r.t));
  ok(st.radios[0].on && st.radios.filter((r) => r.on).length === 1, '...Everyone is the current choice', st.radios);
  ok(st.checks.map((c) => c.k).join() === KINDS.join() && st.checks.every((c) => c.on), '...menuitemcheckbox, one per kind, all on', st.checks);
  ok(st.reset.role === 'menuitem' && st.reset.off, '...Reset is there and disabled on the default', st.reset);
  ok(st.resetVis && st.resetVis.bottom <= st.resetVis.menuBottom, '...Reset is visible without scrolling the menu (sticky footer, Auriga 6acbf37)', st.resetVis);
  ok(st.note === 'Room default: everyone · all kinds.Set it in ⚙ Room settings.', '...the footer names the room default and where to set it', st.note);
  ok(st.focus === '', '...the focus lands on the current seat choice (Everyone)', st.focus);
  const looks = await page.evaluate(() => {
    const m = document.getElementById('filterMenu');
    const on = m.querySelector('[role=menuitemradio][aria-checked="true"]');
    const h = m.querySelector('[data-who] .rf-h');
    const probe = (css) => { const d = document.createElement('div'); d.style.color = css; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; };
    const rc = document.body.style.getPropertyValue('--room-c') || getComputedStyle(document.body).getPropertyValue('--room-c');
    const box = m.querySelector('[role=menuitemcheckbox] .rf-box');
    return {
      onBg: getComputedStyle(on).backgroundColor, tint: (() => { const d = document.createElement('div'); d.style.background = 'var(--rc-tint)'; document.body.append(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; })(),
      ck: getComputedStyle(on.querySelector('.rf-ck')).visibility,
      hFont: getComputedStyle(h).fontFamily, hColor: getComputedStyle(h).color, ink: probe('oklch(from #ba08b4 .82 clamp(.02, calc(c * .6), .13) h)'), rc,
      boxBg: getComputedStyle(box).backgroundColor, sky: probe('var(--sky)'),
    };
  });
  ok(looks.onBg === looks.tint && looks.ck === 'visible', '...the choice wears the room-tone lift + ✓', looks);
  ok(/mono/i.test(looks.hFont) && looks.hColor === looks.ink, '...a seat\'s @handle in its project ink (derived, mono)', looks);
  ok(looks.boxBg === looks.sky, '...a kind that is on has a sky checkbox', looks);

  /* 3. keyboard inside: ↓ moves, Space picks; live, the menu stays open */
  await page.keyboard.press('ArrowDown');
  st = await menuState();
  ok(st.focus === 'me', '↓ moves to "To me"', st.focus);
  await page.keyboard.press('Space');
  await sleep(200);
  st = await menuState();
  let v = await shown();
  ok(st.open && st.radios.find((r) => r.who === 'me').on, 'Space picks it; the menu stays open', st.radios);
  ok(v.some((e) => e.body === 'lead to you') && !v.some((e) => e.body === '@bee agents only') && v.length < all0.length, '...the line filters live behind the menu', v.map((e) => e.body));
  ok(st.dot && st.label === 'Filter the chat · showing: to me · 6 of 6 kinds' && st.title === st.label, '...the teal dot appears and the button names the view', brief(st));
  ok(!st.reset.off, '...Reset is enabled off the default', st.reset);
  ok(st.phDot, '...and the phone\'s dot follows the same rule', st.phDot);

  /* 4. a kind: click toggles, live; the menu stays open */
  await page.click('#filterMenu [data-kind="fact"]');
  await sleep(150);
  await page.click('#filterMenu [data-who=""]');
  await sleep(150);
  st = await menuState();
  v = await shown();
  ok(st.open && !st.checks.find((c) => c.k === 'fact').on && !v.some((e) => e.kind === 'fact') && v.some((e) => e.kind === 'chat'), 'unchecking "fact" hides the facts, live, menu open', { checks: st.checks, kinds: [...new Set(v.map((e) => e.kind))] });
  ok(st.dot && st.label === 'Filter the chat · showing: everyone · 5 of 6 kinds', '..."everyone" with a kind off is still not the default: dot + name', st.label);
  ok(st.focus === '', '...the focus stays on the item just used', st.focus);

  await page.screenshot({ path: join(tmpdir(), 'room-filter-menu.png') });
  /* 5. the last kind on cannot be turned off */
  for (const k of ['delivery', 'attachment', 'command', 'voice']) {
    await page.click(`#filterMenu [data-kind="${k}"]`);
  }
  await page.click('#filterMenu [data-kind="chat"]');
  await sleep(150);
  st = await menuState();
  v = await shown();
  ok(st.checks.filter((c) => c.on).map((c) => c.k).join() === 'chat' && v.length > 0 && v.every((e) => e.kind === 'chat'), 'unchecking the LAST kind is refused: chat stays on and the line is not blank', { checks: st.checks, n: v.length });
  ok(st.label === 'Filter the chat · showing: everyone · 1 of 6 kinds', '...1 of 6 kinds', st.label);

  /* 6. Reset: back to the default, the menu stays open, focus to the choice */
  await page.click('#filterMenu .rf-reset');
  await sleep(150);
  st = await menuState();
  v = await shown();
  ok(st.open && st.checks.every((c) => c.on) && st.radios[0].on && st.reset.off, 'Reset restores the room default; the menu stays open; Reset disables', brief(st));
  ok(!st.dot && st.label === 'Filter the chat' && v.length === all0.length, '...the dot goes, the name is plain, the whole line shows', { dot: st.dot, label: st.label, n: v.length });
  ok(st.focus === '', '...the focus moves to the current seat choice', st.focus);

  /* 7. closing: Esc, the button, a click away; opening by ↓ / Enter */
  await page.keyboard.press('Escape');
  await sleep(100);
  st = await menuState();
  ok(!st.open && st.exp === 'false' && st.focus === 'filterBtn', 'Esc closes it and the focus returns to the button', brief(st));
  await page.keyboard.press('ArrowDown');
  await sleep(100);
  st = await menuState();
  ok(st.open && st.focus === '', '↓ on the button opens it on the current seat choice', brief(st));
  await page.keyboard.press('End');
  st = await menuState();
  ok(st.focus === 'voice', 'End goes to the last enabled item (Reset is disabled, so skipped)', st.focus);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await sleep(100);
  st = await menuState();
  ok(st.open && st.focus === '', 'Enter on the button opens it too', brief(st));
  await page.click('#filterBtn');
  await sleep(100);
  st = await menuState();
  ok(!st.open && st.focus === 'filterBtn', 'the button again closes it (focus stays on the button)', brief(st));
  await page.click('#filterBtn');
  await sleep(100);
  await page.mouse.click(900, 500); // the line
  await sleep(100);
  st = await menuState();
  ok(!st.open, 'a click away closes it', brief(st));

  /* 8. one Esc closes only the menu, not the settings column under it */
  await page.click('#gearBtn');
  await sleep(300);
  await page.click('#filterBtn');
  await sleep(150);
  await page.keyboard.press('Escape');
  await sleep(150);
  const pvOpen = await page.evaluate(() => !document.getElementById('preview').hidden);
  st = await menuState();
  ok(!st.open && pvOpen, 'Esc closes the filter menu and leaves Room settings open', { menu: st.open, pvOpen });
  await page.keyboard.press('Escape');
  await sleep(150);
  ok(await page.evaluate(() => document.getElementById('preview').hidden), '...the next Esc closes the settings');

  /* 9. a room default that is NOT everything: the dot follows the DEFAULT */
  const saved = await call(`/api/rooms/${R}/settings`, { method: 'PATCH', json: { feed_default: { kinds: ['chat', 'fact'], who: 'me' } } });
  ok(saved.status === 200, 'setup: the room default is "to me · chat, fact" (human cookie)', saved.status);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#line .entry', { state: 'attached' });
  await sleep(1500);
  st = await menuState();
  ok(!st.dot && !st.phDot && st.label === 'Filter the chat', 'the page opens on that default: no dot (desktop or phone)', brief(st));
  await page.click('#filterBtn');
  await sleep(150);
  st = await menuState();
  ok(st.radios.find((r) => r.who === 'me').on && st.checks.filter((c) => c.on).map((c) => c.k).join() === 'chat,fact' && st.reset.off, '...the menu shows it; Reset disabled', brief(st));
  ok(st.note === 'Room default: to me · chat, fact.Set it in ⚙ Room settings.', '...and the footer says it in words', st.note);
  await page.click('#filterMenu [data-who=""]');
  await sleep(150);
  st = await menuState();
  ok(st.dot && st.phDot && st.label === 'Filter the chat · showing: everyone · 2 of 6 kinds', 'Everyone is now OFF the default: the dot shows', brief(st));
  await page.click('#filterMenu .rf-reset');
  await sleep(150);
  st = await menuState();
  ok(!st.dot && st.radios.find((r) => r.who === 'me').on, 'Reset returns to that default (to me), not to everything', st.radios);
  await page.keyboard.press('Escape');
  ok(errors.length === 0, 'no page errors (desktop)', errors.slice(0, 3));

  /* 10. phone */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phone.addCookies((await context.cookies()));
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('#line .entry', { state: 'attached' });
  await sleep(1500);
  const pbtn = await pp.evaluate(() => getComputedStyle(document.getElementById('filterBtn')).display);
  ok(pbtn === 'none', 'phone: the bar\'s filter button is not shown (the header\'s #phFilter is the control)', pbtn);
  await pp.tap('#phFilter');
  await sleep(300);
  const sheet = () => pp.evaluate(() => {
    const sh = document.getElementById('phSheet');
    return {
      open: !sh.hidden, heads: [...sh.querySelectorAll('h3')].map((h) => h.textContent),
      who: [...sh.querySelectorAll('.ph-frow')].map((b) => b.textContent),
      kinds: [...sh.querySelectorAll('.rf-srow')].map((b) => ({ k: b.dataset.kind, on: b.getAttribute('aria-checked') === 'true', h: Math.round(b.getBoundingClientRect().height), role: b.getAttribute('role') })),
      note: sh.querySelector('.rf-sfoot .rf-note')?.textContent, reset: sh.querySelector('.rf-sfoot .rf-reset') ? sh.querySelector('.rf-sfoot .rf-reset').disabled : null,
      dot: !document.getElementById('phFilterDot').hidden, sw: document.documentElement.scrollWidth, iw: innerWidth,
    };
  });
  let ps = await sheet();
  ok(ps.open && ps.heads.join('|') === 'Show in the chat|Kinds', 'phone: the filter sheet has SHOW IN THE CHAT and KINDS', ps.heads);
  ok(ps.who.slice(0, 3).join() === 'Everyone,To me,Between agents', '...the seat choices as before', ps.who);
  ok(ps.kinds.map((k) => k.k).join() === KINDS.join() && ps.kinds.every((k) => k.h >= 48 && k.role === 'checkbox'), '...a 48px checkbox row per kind', ps.kinds);
  ok(ps.kinds.filter((k) => k.on).map((k) => k.k).join() === 'chat,fact', '...showing the room default\'s kinds', ps.kinds);
  ok(ps.note === 'Room default: to me · chat, fact.Set it in ⚙ Room settings.' && ps.reset === true, '...the default in words + Reset (disabled on the default)', ps);
  await pp.tap('#phSheet .rf-srow[data-kind="delivery"]');
  await sleep(300);
  ps = await sheet();
  ok(ps.open && ps.kinds.find((k) => k.k === 'delivery').on && ps.dot && ps.reset === false, 'phone: a kind toggles with the sheet up; the dot shows; Reset enables', ps);
  await pp.tap('#phSheet .rf-srow[data-kind="chat"]');
  await pp.tap('#phSheet .rf-srow[data-kind="fact"]');
  await sleep(200);
  await pp.tap('#phSheet .rf-srow[data-kind="delivery"]');
  await sleep(300);
  ps = await sheet();
  ok(ps.kinds.filter((k) => k.on).map((k) => k.k).join() === 'delivery', 'phone: the last kind on is refused here too', ps.kinds);
  await pp.screenshot({ path: join(tmpdir(), 'room-filter-phone.png') });
  ok(ps.sw <= ps.iw, 'phone: no sideways scroll with the sheet up', ps);
  await pp.tap('#phSheet .rf-sfoot .rf-reset');
  await sleep(300);
  ps = await sheet();
  ok(ps.open && !ps.dot && ps.reset === true && ps.kinds.filter((k) => k.on).map((k) => k.k).join() === 'chat,fact', 'phone: Reset restores the default and the sheet stays up', ps);
  await pp.tap('#phScrim', { position: { x: 195, y: 20 } });
  await sleep(300);
  const psw = await pp.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  ok(psw[0] <= psw[1], 'phone: no sideways scroll at 390', psw);
  ok(perr.length === 0, 'no page errors (phone)', perr.slice(0, 3));
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  engine?.kill('SIGKILL');
  await sleep(300);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
