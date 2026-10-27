/* GLOBAL SETTINGS PAGE + ITS MOUNT CONTRACT [web/settings-page] (Owner 2026-09-28).
 *
 *   node test/settings-page.probe.mjs
 *
 * Proves:
 *   - /settings.html loads with a person's cookie; title "Settings"
 *   - the You group (module /you-settings.mjs, moved here from each room's ⚙
 *     column 2026-09-30) is a MOUNTED group like any other, EDITABLE here:
 *     it shows the person's @name and picture, uploads a new picture (Choose
 *     image…, the hidden file input) and saves an @name, both round-tripping
 *     through the real PATCH /api/rooms/me
 *   - the Voice group (module /voice-global-settings.mjs, landed 2026-09-28)
 *     mounts for real, with its "Save voice" control
 *   - a 404'd module (network-level fault injection in a SEPARATE context —
 *     never a fake group spliced into settings.mjs's own GROUPS) still
 *     degrades to "Not available yet", and the page still works
 *   - a mount that THROWS, or a module with no such export, degrades the same
 *     way and never breaks the You group
 *   - a STUB module (served by a route intercept) is mounted with {me, save};
 *     save() sends a PATCH /api/rooms/me, merges the answer into the SAME `me`
 *     and resolves with it; a 4xx rejects with the server's message + status
 *   - the mount's returned {update(me)}: called on the OTHER groups after a
 *     save (never on the saver), and on every group after the page refetches
 *     on focus / visibilitychange (coalesced to one call); a mount that returns
 *     nothing is fine
 *   - no sideways scroll at 1280 or at 390 (phone)
 *   - the shell's status menu has "Settings", which opens the page as a shell
 *     tab (and a second pick focuses it, never a second frame)
 *   - a bearer reads /api/rooms/me but cannot PATCH it (403): the page must be
 *     the person's
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(224), DEAD broker P(225).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(224);
const DEAD_BROKER_PORT = P(225);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-settings-page-token';
/* a 1x1 PNG: a picture the engine accepts */
const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the stub modules, by mode */
const STUBS = {
  good: `export async function mountVoiceGlobals(el, { me, save }) {
    const mk = (tag, id, text) => { const e = document.createElement(tag); e.id = id; e.textContent = text; return e; };
    const good = mk('button', 'stubSave', 'Save 35');
    const bad = mk('button', 'stubBad', 'Save 999');
    const out = mk('p', 'stubOut', 'mounted as @' + me.handle);
    good.className = bad.className = 'pv-btn';
    out.className = 'pv-msg';
    good.onclick = async () => {
      const r = await save({ bubbleTransparency: 35 });
      out.textContent = JSON.stringify({ same: r === me, bt: r.bubbleTransparency, meBt: me.bubbleTransparency, handle: r.handle });
    };
    bad.onclick = async () => {
      try { await save({ bubbleTransparency: 999 }); out.textContent = 'no-throw'; }
      catch (e) { out.textContent = 'error ' + e.status + ': ' + e.message; out.dataset.kind = 'error'; }
    };
    const name = mk('button', 'stubName', 'Save @name');
    name.className = 'pv-btn';
    name.onclick = async () => { await save({ handle: 'renamedperson' }); out.textContent = 'renamed'; };
    const upd = mk('p', 'stubUpd', '');
    upd.dataset.n = '0';
    el.append(good, bad, name, out, upd);
    return { update(m) { upd.dataset.n = String(Number(upd.dataset.n) + 1); upd.textContent = JSON.stringify({ same: m === me, handle: m.handle, bt: m.bubbleTransparency }); } };
  }`,
  plain: `export function mountVoiceGlobals(el) { el.append('plain group, no handle'); }`,
  throws: `export function mountVoiceGlobals(el) { el.append('half-drawn'); throw new Error('boom'); }`,
  noexport: 'export const somethingElse = 1;',
};
let stubMode = null; // null = no intercept: the real engine 404s

const readPage = (p) => p.evaluate(() => {
  const grp = (id) => document.querySelector(`section.pv-grp[data-group="${id}"]`);
  const you = grp('you');
  const voice = grp('voice');
  return {
    title: document.title,
    groups: [...document.querySelectorAll('section.pv-grp')].map((g) => g.dataset.group),
    youTitle: you?.querySelector('h4')?.textContent ?? null,
    youState: you?.dataset.state ?? null,
    handle: you?.querySelector('#meHandle')?.value ?? null,
    youImg: you?.querySelector('.you.big img')?.getAttribute('src')?.slice(0, 22) ?? null,
    youRemoveHidden: [...(you?.querySelectorAll('.pv-picacts .pv-btn') ?? [])].find((b) => /Remove/.test(b.textContent))?.hidden ?? null,
    voiceTitle: voice?.querySelector('h4')?.textContent ?? null,
    voiceState: voice?.dataset.state ?? null,
    voiceText: voice?.querySelector('.st-body')?.textContent.trim() ?? null,
    voiceHasSave: !!voice?.querySelector('#vgsSave'),
    status: document.getElementById('status')?.textContent ?? null,
    back: !document.getElementById('backLink')?.hidden,
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  };
});

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'settings-page.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-settings-page-'));
let engine = null;
let browser = null;
let engineLog = '';

try {
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
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

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.route('**/voice-global-settings.mjs*', (route) => {
    if (!stubMode) { return route.continue(); }
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: STUBS[stubMode] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const patches = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/rooms/me') && r.method() !== 'GET') { patches.push({ method: r.method(), body: r.postData() }); } });

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const asUser = (path, init = {}) => fetch(BASE + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers || {}) } });
  const bearer = (path, init = {}) => fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });

  const setup = await asUser('/api/rooms/me', { method: 'PATCH', body: JSON.stringify({ handle: 'probeperson', picture: PIC, bubbleTransparency: 0 }) });
  ok(setup.status === 200, 'setup: the person has an @name and a picture', setup.status);
  const bGet = await bearer('/api/rooms/me');
  const bPatch = await bearer('/api/rooms/me', { method: 'PATCH', body: JSON.stringify({ bubbleTransparency: 5 }) });
  ok(bGet.status === 200 && bPatch.status === 403, 'a bearer reads /api/rooms/me but gets 403 on PATCH (the page must be the person\'s)', [bGet.status, bPatch.status]);

  /* ---- 1. the page, the REAL Voice module (web/voice-global-settings.mjs,
     landed on main 2026-09-28 — GROUPS[1] in web/settings.mjs points at it
     unconditionally now, so `stubMode = null` reaches it, not a 404). ---- */
  const real = await fetch(`${BASE}/voice-global-settings.mjs`, { headers: { cookie } });
  ok(real.status === 200, 'the real voice module is served now', real.status);
  await page.goto(`${BASE}/settings.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('section[data-group="you"][data-state="mounted"]', { timeout: 8000 }).catch(() => {});
  await page.waitForSelector('section[data-group="voice"][data-state="mounted"]', { timeout: 8000 }).catch(() => {});
  let s = await readPage(page);
  ok(s.title === 'Settings', 'the page title is "Settings"', s.title);
  ok(s.groups.join(',') === 'you,voice,apps', 'groups: You, then Voice, then Apps [ticket]', s.groups);
  ok(s.youTitle === 'You' && s.youState === 'mounted' && s.handle === 'probeperson', 'the You group shows the @name (as the editable #meHandle input\'s value)', [s.youTitle, s.youState, s.handle]);
  ok(s.youImg === PIC.slice(0, 22), 'the You group shows the picture preview', s.youImg);
  ok(s.voiceTitle === 'Voice' && s.voiceState === 'mounted', 'the real Voice module mounts', [s.voiceTitle, s.voiceState]);
  ok(s.voiceHasSave, '...with its "Save voice" control', s.voiceHasSave);
  ok(s.status === '', 'no page-level error', s.status);
  ok(s.back, 'standalone in a browser: the "← Manager" link is there');
  ok(s.sw <= s.cw, 'no sideways scroll at 1280', [s.sw, s.cw]);
  const png = await page.screenshot({ path: join(tmpDir, 'settings-1280.png') });
  ok(png.length > 0, 'screenshot taken');

  /* ---- 1a. the You group is EDITABLE here (Owner 2026-09-30): a real picture
     upload (the hidden file input behind "Choose image…") and a real @name
     save, both round-tripping through PATCH /api/rooms/me on the real engine.
     This is the coverage that used to live in each room's gear panel. */
  const you2 = () => page.evaluate(() => {
    const grp = document.querySelector('section.pv-grp[data-group="you"]');
    return {
      bigImg: !!grp?.querySelector('.pv-picbig .you img'),
      removeHidden: [...(grp?.querySelectorAll('.pv-picacts .pv-btn') ?? [])].find((b) => /Remove/.test(b.textContent))?.hidden ?? null,
      picMsg: grp?.querySelector('.pv-msg')?.textContent ?? null,
    };
  });
  const png2 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#c33';
    x.fillRect(0, 0, 300, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  const pngPath = join(tmpDir, 'you-upload.png');
  writeFileSync(pngPath, Buffer.from(png2, 'base64'));
  await page.setInputFiles('section[data-group="you"] .pv-picacts input[type=file]', pngPath);
  await sleep(1200);
  let yk = await you2();
  ok(yk.bigImg && yk.removeHidden === false && yk.picMsg === 'Saved', 'Settings → You: a picked image uploads, saves, and shows Remove', yk);
  const uploaded = await (await asUser('/api/rooms/me')).json();
  ok(typeof uploaded?.picture === 'string' && /^data:image\/(webp|png|jpeg);base64,/.test(uploaded.picture), 'the engine holds the uploaded picture as a data: URL', uploaded?.picture?.slice(0, 24));
  await page.fill('#meHandle', 'probeuploaded');
  await page.click('section[data-group="you"] .pv-handle .pv-btn.pri');
  await sleep(600);
  s = await readPage(page);
  ok(s.handle === 'probeuploaded', 'Settings → You: saving an @name here round-trips too', s.handle);
  const afterHandle = await (await asUser('/api/rooms/me')).json();
  ok(afterHandle.handle === 'probeuploaded', '...and the engine holds it');
  /* put both back so the rest of the probe (which assumes "probeperson" + PIC) is unaffected */
  const restore = await asUser('/api/rooms/me', { method: 'PATCH', body: JSON.stringify({ handle: 'probeperson', picture: PIC }) });
  ok(restore.status === 200, 'restore: back to probeperson + the original picture for the rest of the probe', restore.status);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('section[data-group="you"][data-state="mounted"]', { timeout: 8000 }).catch(() => {});

  /* ---- 1b. THE MISSING PATH, still proven. This is network-level fault
     injection (a route intercept, in a SEPARATE context so the main `page`
     above keeps hitting the real module) — never a fake group added to
     settings.mjs's own GROUPS list, which stays exactly what ships. */
  const missCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await missCtx.addCookies(await context.cookies());
  await missCtx.route('**/voice-global-settings.mjs*', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
  const missPage = await missCtx.newPage();
  await missPage.goto(`${BASE}/settings.html`, { waitUntil: 'domcontentloaded' });
  await missPage.waitForSelector('section[data-group="voice"][data-state="missing"]', { timeout: 8000 }).catch(() => {});
  const missS = await readPage(missPage);
  ok(missS.voiceState === 'missing' && missS.voiceText === 'Not available yet', 'a 404\'d module still degrades to "Not available yet"', [missS.voiceState, missS.voiceText]);
  ok(missS.handle === 'probeperson', '...and the You group is untouched', missS.handle);
  await missCtx.close();

  /* ---- 2. a mount that throws / a module with no such export ---- */
  for (const mode of ['throws', 'noexport']) {
    stubMode = mode;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const want = mode === 'throws' ? 'failed' : 'missing';
    await page.waitForSelector(`section[data-group="voice"][data-state="${want}"]`, { timeout: 8000 }).catch(() => {});
    s = await readPage(page);
    ok(s.voiceState === want && s.voiceText === 'Not available yet', `a module that ${mode === 'throws' ? 'throws in mount' : 'lacks the export'} shows "Not available yet" (no half-drawn body)`, [s.voiceState, s.voiceText]);
    ok(s.handle === 'probeperson', '...and the You group is untouched', s.handle);
  }

  /* ---- 3. a stub module mounted, save() round-trips ---- */
  stubMode = 'good';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('section[data-group="voice"][data-state="mounted"]', { timeout: 8000 }).catch(() => {});
  s = await readPage(page);
  ok(s.voiceState === 'mounted', 'the stub module is mounted into the Voice group', s.voiceState);
  ok((await page.textContent('#stubOut')) === 'mounted as @probeperson', '...with `me` = GET /api/rooms/me', await page.textContent('#stubOut'));
  patches.length = 0;
  await page.click('#stubSave');
  await page.waitForFunction(() => document.getElementById('stubOut').textContent.startsWith('{'), null, { timeout: 5000 }).catch(() => {});
  const res = JSON.parse((await page.textContent('#stubOut')) || '{}');
  ok(patches.length === 1 && patches[0].method === 'PATCH' && JSON.parse(patches[0].body).bubbleTransparency === 35, 'save() sends ONE PATCH /api/rooms/me with the patch as its body', patches);
  ok(res.same === true && res.bt === 35 && res.meBt === 35 && res.handle === 'probeperson', 'save() merges the answer into the same `me` and resolves with it', res);
  const after = await (await asUser('/api/rooms/me')).json();
  ok(after.bubbleTransparency === 35, 'the PATCH reached the person\'s prefs (GET /api/rooms/me)', after.bubbleTransparency);
  await page.click('#stubBad');
  await page.waitForFunction(() => document.getElementById('stubOut').textContent.startsWith('error') || document.getElementById('stubOut').textContent === 'no-throw', null, { timeout: 5000 }).catch(() => {});
  const badText = await page.textContent('#stubOut');
  ok(/^error 400: bubbleTransparency is a whole number from 0 to \d+$/.test(badText), 'a 4xx rejects with the server\'s message and .status', badText);
  const still = await (await asUser('/api/rooms/me')).json();
  ok(still.bubbleTransparency === 35, '...and nothing was written', still.bubbleTransparency);

  /* ---- 3b. update(me): the OTHER groups repaint; the saver does not ---- */
  const updN = () => page.evaluate(() => Number(document.getElementById('stubUpd').dataset.n));
  ok((await updN()) === 0, 'the saving group is not sent update() for its own saves', await updN());
  await page.click('#stubName');
  await page.waitForFunction(() => document.getElementById('stubOut').textContent === 'renamed', null, { timeout: 5000 }).catch(() => {});
  s = await readPage(page);
  ok(s.handle === 'renamedperson', 'after the stub saved an @name, the You group repainted (update on the others)', s.handle);
  ok((await updN()) === 0, '...and the stub itself was still not updated', await updN());
  /* changed ELSEWHERE (another window), then the page comes back into view */
  await asUser('/api/rooms/me', { method: 'PATCH', body: JSON.stringify({ handle: 'externalperson', bubbleTransparency: 40 }) });
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.getElementById('stubUpd').dataset.n !== '0', null, { timeout: 5000 }).catch(() => {});
  await sleep(300);
  const upd = JSON.parse((await page.textContent('#stubUpd')) || '{}');
  ok((await updN()) === 1, 'focus + visibilitychange refetch ONCE and call update(me) once', await updN());
  ok(upd.same === true && upd.handle === 'externalperson' && upd.bt === 40, '...with the refetched values, in the same `me`', upd);
  s = await readPage(page);
  ok(s.handle === 'externalperson', '...and the You group repainted too', s.handle);

  /* a mount that returns nothing is fine, and so is a refetch with it mounted */
  stubMode = 'plain';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('section[data-group="voice"][data-state="mounted"]', { timeout: 8000 }).catch(() => {});
  s = await readPage(page);
  ok(s.voiceState === 'mounted' && s.voiceText === 'plain group, no handle', 'a mount that returns nothing is mounted', [s.voiceState, s.voiceText]);
  await asUser('/api/rooms/me', { method: 'PATCH', body: JSON.stringify({ handle: 'probeperson' }) });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => document.getElementById('meHandle').value === 'probeperson', null, { timeout: 5000 }).catch(() => {});
  s = await readPage(page);
  ok(s.handle === 'probeperson', '...and a refetch still repaints You around it', s.handle);

  /* ---- 4. phone (390) ---- */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addCookies(await context.cookies());
  await phone.route('**/voice-global-settings.mjs*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: STUBS.good }));
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(`phone: ${e}`));
  await pp.goto(`${BASE}/settings.html`, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('section[data-group="voice"][data-state="mounted"]', { timeout: 8000 }).catch(() => {});
  const ps = await readPage(pp);
  ok(ps.handle === 'probeperson' && ps.voiceState === 'mounted', 'phone: the page loads, You + the mounted group', [ps.handle, ps.voiceState]);
  ok(ps.sw <= ps.cw && ps.cw === 390, 'phone: no sideways scroll at 390', [ps.sw, ps.cw]);
  const wide = await pp.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).map((e) => e.tagName + '.' + e.className).slice(0, 5));
  ok(wide.length === 0, 'phone: nothing reaches past the right edge', wide);
  await pp.screenshot({ path: join(tmpDir, 'settings-390.png'), fullPage: true });
  await phone.close();

  /* ---- 5. the shell's status menu opens Settings as a tab ---- */
  stubMode = null;
  await page.goto(`${BASE}/app/shell.html?kind=manager&debug=1&tabs=${encodeURIComponent('/mock-session.html?probe=a')}`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const frames = () => page.evaluate(() => [...document.querySelectorAll('#stage iframe')].map((f) => ({ src: f.getAttribute('src'), shown: f.style.display !== 'none' })));
  const before = await frames();
  await page.click('.hwb-act');
  await sleep(200);
  const items = await page.$$eval('.hwb-actmenu .hwb-actmenu-item', (els) => els.map((e) => e.textContent));
  ok(items.includes('Settings'), 'the status menu offers "Settings"', items);
  await page.click('.hwb-actmenu .hwb-actmenu-item[data-act="settings"]');
  await sleep(1500);
  let fr = await frames();
  const st = fr.filter((f) => /\/settings\.html$/.test(new URL(f.src, BASE).pathname));
  ok(fr.length === before.length + 1 && st.length === 1 && st[0].shown, 'Settings opens as a NEW shell tab, shown', fr);
  const chip = await page.evaluate(() => [...document.querySelectorAll('.hwb-tab[data-tab] .tname')].map((e) => e.textContent));
  ok(chip.includes('Settings'), '...titled "Settings" on the strip', chip);
  const sf = page.frames().find((f) => /\/settings\.html/.test(f.url()));
  await sf?.waitForSelector('section[data-group="voice"][data-state]:not([data-state="loading"])', { timeout: 8000 }).catch(() => {});
  const inTab = sf ? await readPage(sf) : null;
  ok(inTab?.handle === 'probeperson' && inTab?.voiceState === 'mounted', '...and it is the page, signed in (You + Voice, the real module mounted)', inTab && [inTab.handle, inTab.voiceState]);
  ok(inTab && !inTab.back, '...without the "← Manager" link inside the shell', inTab?.back);
  /* back to the other tab, then Settings again: focused, not framed twice */
  await page.evaluate(() => document.querySelector('.hwb-tab[data-tab]:not(.is-active)')?.click());
  await sleep(300);
  await page.click('.hwb-act');
  await sleep(200);
  await page.click('.hwb-actmenu .hwb-actmenu-item[data-act="settings"]');
  await sleep(500);
  fr = await frames();
  const st2 = fr.filter((f) => /\/settings\.html$/.test(new URL(f.src, BASE).pathname));
  ok(fr.length === before.length + 1 && st2.length === 1 && st2[0].shown, 'a second pick focuses the open Settings tab (no second frame)', fr);

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
