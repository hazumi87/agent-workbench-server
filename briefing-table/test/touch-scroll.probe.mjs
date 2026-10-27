/* THE CONTROL PROMPT IS MODAL; SCROLLING HAPPENS ONLY ONCE IT IS ANSWERED.
 *
 * 2026-09-15: Owner could not scroll on his iPhone. The touch-scroll handler
 * (2026-09-01) listens on #term, and the finger was landing on the viewer
 * prompt (`.pane-paused`, "this session is being driven elsewhere"), a sibling
 * that covers the pane body. The first fix let a drag scroll THROUGH the
 * prompt; Owner rejected that ("the user can inadvertently scroll through the
 * prompt"). So the prompt is the fix: unmistakable, and answerable two ways.
 * This probe drives:
 *   1. a phone-shaped WebKit page as a VIEWER (another page holds control):
 *      a drag over the prompt must NOT move the terminal
 *   2. "Just watch": prompt gone, viewing badge shown, a drag on the terminal
 *      DOES scroll; a keystroke re-raises the prompt
 *   3. "Take control here": prompt gone, badge gone, drag scrolls
 *   4. a desktop Chromium VIEWER: wheel over the prompt does not scroll;
 *      after "Just watch" it does (xterm's own wheel path)
 * Uses the OneColor Probe recipe (never Owner's live sessions — taking control
 * of one of those mid-read is exactly the bug's symptom). Not in `npm test` —
 * needs the live engine, like the other probes.
 *
 * Synthetic touch events go through the same listeners a finger does, but not
 * through iOS's own gesture arbitration — the phone's beacon
 * (`why:'touch-scroll'` on GET /api/diag/viewport) is the ground truth there. */
import { webkit, chromium } from 'playwright';
import { readFileSync } from 'node:fs';

/* PROBE_BASE / PROBE_TOKEN / PROBE_RECIPE point it at a SCRATCH engine
   (test/solo-keybar.probe.mjs does, with WITH_TOUCH_SCROLL=1); the defaults are
   the old live-engine form. PROBE_BROWSER=chromium runs the phone half on
   Chromium where WebKit cannot launch. */
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:7420';
const TOKEN = process.env.PROBE_TOKEN || readFileSync('secrets/engine.token', 'utf8').trim();
const RECIPE = process.env.PROBE_RECIPE || 'eeeeeeee-0000-4000-8000-0000000000e1';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) failures++; };
const hdr = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
}
const firstRows = (page) => page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].slice(0, 4).map((r) => r.textContent));
const promptUp = (page) => page.evaluate(() => { const p = document.querySelector('.pane-paused'); return p ? !p.hidden : null; });
const badgeUp = (page) => page.evaluate(() => { const b = document.getElementById('viewBadge'); return b ? !b.hidden : null; });
const moved = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
/* Drag from the middle of the pane body: whatever element is under the finger
   gets the events, exactly as a real touch would. */
async function drag(page, dy, steps) {
  const at = await page.evaluate(() => {
    const r = document.querySelector('.pane-body').getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height * 0.6;
    document.querySelectorAll('[data-probe-hit]').forEach((e) => e.removeAttribute('data-probe-hit'));
    const t = document.elementFromPoint(x, y); t.setAttribute('data-probe-hit', '');
    return { x, y, hit: t.tagName.toLowerCase() + '.' + t.className + (t.closest('.pane-paused') ? ' [in prompt]' : '') };
  });
  let y = at.y;
  const pt = (yy) => [{ clientX: at.x, clientY: yy, pageX: at.x, pageY: yy, identifier: 1 }];
  await page.dispatchEvent('[data-probe-hit]', 'touchstart', { touches: pt(y), changedTouches: pt(y), targetTouches: pt(y), bubbles: true, cancelable: true });
  for (let i = 0; i < steps; i++) {
    y += dy;
    await page.dispatchEvent('[data-probe-hit]', 'touchmove', { touches: pt(y), changedTouches: pt(y), targetTouches: pt(y), bubbles: true, cancelable: true });
  }
  await page.dispatchEvent('[data-probe-hit]', 'touchend', { touches: [], changedTouches: pt(y), targetTouches: [], bubbles: true, cancelable: true });
  await page.waitForTimeout(400);
  return at.hit;
}
async function wheel(page) {
  const box = await page.evaluate(() => { const r = document.querySelector('.pane-body').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(400);
}

// Make sure there is a live session with some history to scroll into.
const launched = await (await fetch(`${BASE}/api/recipes/${RECIPE}/launch`, { method: 'POST', headers: hdr, body: JSON.stringify({ target: 'tab', surface: 'browser' }) })).json();
const path = launched.path ?? `/solo.html?recipe=${RECIPE}`;

// --- the CONTROLLER: a desktop Chromium page that holds the keyboard ---------
const desk = await chromium.launch({ headless: true });
const deskCtx = await desk.newContext({ viewport: { width: 1000, height: 700 } });
const holder = await deskCtx.newPage();
await login(holder);
await holder.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
await holder.waitForTimeout(2500);
if (await promptUp(holder)) { await holder.click('.pane-paused [data-act=resume]'); await holder.waitForTimeout(1200); }
ok((await promptUp(holder)) === false, 'desktop page holds control (no prompt)');
await holder.keyboard.type(process.platform === 'win32'
  ? 'for ($i=0; $i -lt 200; $i++) { "probe line $i" }\n'
  : 'for i in $(seq 0 199); do echo "probe line $i"; done\n');
await holder.waitForTimeout(3000);

// --- the PHONE: WebKit, iPhone-shaped, arriving as a viewer -------------------
const wk = await (process.env.PROBE_BROWSER === 'chromium' ? chromium : webkit).launch({ headless: true });
const wkCtx = await wk.newContext({
  viewport: { width: 320, height: 522 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/152.0.4191.65 Version/26.0 Mobile/15E148 Safari/604.1',
});
const phone = await wkCtx.newPage();
await login(phone);
await phone.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
await phone.waitForTimeout(3000);
ok(await phone.evaluate(() => matchMedia('(pointer: coarse)').matches), 'phone reports a coarse pointer (touch scroll is enabled)');
ok((await promptUp(phone)) === true, 'phone arrived as a VIEWER (prompt up)');
const card = await phone.evaluate(() => { const c = document.querySelector('.pane-paused-card'); const r = c.getBoundingClientRect(); const v = document.querySelector('.pane-body').getBoundingClientRect(); return { inside: r.top >= v.top && r.bottom <= v.bottom && r.left >= v.left && r.right <= v.right, w: Math.round(r.width), buttons: [...c.querySelectorAll('button')].map((b) => [b.textContent.trim(), Math.round(b.getBoundingClientRect().height)]) }; });
ok(card.inside, `the prompt card is fully on screen (${card.w}px wide)`);
ok(card.buttons.length === 2 && card.buttons.every(([, h]) => h >= 44), `two answers at touch size (${JSON.stringify(card.buttons)})`);

let before = await firstRows(phone);
let hit = await drag(phone, +25, 8);
ok(hit.includes('[in prompt]'), `finger landed on the prompt (${hit})`);
ok(!moved(before, await firstRows(phone)), 'VIEWER: a drag over the prompt does NOT scroll the terminal');

await phone.click('.pane-paused [data-act=watch]');
await phone.waitForTimeout(400);
ok((await promptUp(phone)) === false, '"Just watch": prompt dismissed');
ok((await badgeUp(phone)) === true, '"Just watch": viewing badge shown');
before = await firstRows(phone);
hit = await drag(phone, +25, 8);
ok(hit.includes('xterm'), `finger now lands on the terminal (${hit})`);
ok(moved(before, await firstRows(phone)), 'WATCHING: a drag on the terminal scrolls it');

/* A tap on the terminal is how a reader focuses it (and how a scroll starts);
   it must NOT bring the prompt back. Typing must. */
await phone.click('.xterm-screen');
await phone.waitForTimeout(300);
ok((await promptUp(phone)) === false, 'a tap on the terminal while watching does NOT re-raise the prompt');
await phone.keyboard.type('x');
await phone.waitForTimeout(400);
ok((await promptUp(phone)) === true, 'a keystroke while watching re-raises the prompt');
ok((await badgeUp(phone)) === false, '...and hides the badge');

await phone.click('.pane-paused [data-act=resume]');
await phone.waitForTimeout(1500);
ok((await promptUp(phone)) === false, 'phone took control (prompt down)');
ok((await badgeUp(phone)) === false, 'controller shows no viewing badge');
before = await firstRows(phone);
await drag(phone, +25, 8);
ok(moved(before, await firstRows(phone)), 'CONTROLLER: a drag on the terminal scrolls it');

// --- the desktop page is now the VIEWER ---------------------------------------
await holder.waitForTimeout(800);
ok((await promptUp(holder)) === true, 'desktop page is now the viewer (prompt up)');
before = await firstRows(holder);
await wheel(holder);
ok(!moved(before, await firstRows(holder)), 'VIEWER: a wheel over the prompt does NOT scroll');
await holder.click('.pane-paused [data-act=watch]');
await holder.waitForTimeout(400);
before = await firstRows(holder);
await wheel(holder);
ok(moved(before, await firstRows(holder)), 'WATCHING: the wheel scrolls the terminal');

await wk.close();
await desk.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
