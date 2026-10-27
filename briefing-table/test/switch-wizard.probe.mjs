/**
 * PROBE (not in npm test; needs Chromium): the Switch assistant wizard in a real browser at PHONE width, on a scratch
 * Basic instance with fake vendors. Seat menu -> "Switch assistant…" -> the current assistant is shown and disabled ->
 * pick Codex -> Switch -> plain-word progress -> "Codex is ready". Checks the 44px targets and no sideways scroll.
 *   npx tsx test/switch-wizard.probe.mjs
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
const { startScratchBasic } = await import('../scripts/basic-scratch-instance.ts');
const CHROME = process.env.CHROMIUM || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => existsSync(p));
let failed = 0;
let checks = 0;
const ok = (c, m) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inst = await startScratchBasic();
let browser = null;
try {
  const c = await inst.signIn();
  const project = join(inst.home, 'dev', 'code', 'hello-world');
  writeFileSync(join(inst.home, '.claude.json'), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
  const r = (await c.get('/api/rooms')).body.find((x) => x.room.name === 'Hello World');
  const seat = r.seats.find((s) => s.handle === 'builder');
  const st = (await c.post(`/api/rooms/${r.room.id}/seats/${seat.id}/start`, { target: 'tab', surface: 'browser' })).body;
  const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/pty`, { headers: { cookie: c.cookie } });
  await new Promise((res) => ws.once('open', res));
  ws.send(JSON.stringify({ type: 'attach', paneid: st.paneid, recipe: seat.recipe_id, cols: 80, rows: 24 }));
  await sleep(4000);
  ws.close();

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addCookies(c.cookie.split('; ').map((kv) => ({ name: kv.split('=')[0], value: kv.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })));
  const page = await ctx.newPage();
  await page.goto(`${inst.base}/room.html?room=${encodeURIComponent(r.room.id)}`);
  await page.waitForTimeout(2500);
  /* the phone layout keeps the agents in a sheet; open the menu for @builder wherever its row is drawn */
  const opened = await page.evaluate(() => {
    const more = [...document.querySelectorAll('.rsm-more')].find((b) => /@builder/.test(b.getAttribute('aria-label') ?? ''));
    if (!more) return false;
    more.click();
    return true;
  });
  if (!opened) {
    await page.locator('text=Agents').first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.evaluate(() => [...document.querySelectorAll('.rsm-more')].find((b) => /@builder/.test(b.getAttribute('aria-label') ?? ''))?.click());
  }
  await page.waitForTimeout(500);
  const item = page.locator('[role=menuitem]', { hasText: 'Switch assistant' }).first();
  ok(await item.count() > 0, 'the seat menu offers "Switch assistant…"');
  await item.click();
  await page.waitForSelector('.rsm-switch .rsm-swchoice', { timeout: 8000 });
  const now = await page.locator('.rsm-swnow').innerText();
  ok(/Now: Claude/.test(now) && /effort/.test(now), `the card shows what runs now (${now.replace(/\s+/g, ' ')})`);
  const claude = page.locator('.rsm-swchoice', { hasText: 'Claude' });
  ok(await claude.isDisabled() && /already using Claude/.test(await claude.innerText()), 'Claude is disabled: "You\'re already using Claude"');
  const codex = page.locator('.rsm-swchoice', { hasText: 'Codex' });
  const box = await codex.boundingBox();
  ok(box && box.height >= 44, `the choice is a 44px target (${box?.height})`);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at phone width');
  await codex.click();
  await page.locator('.rsm-switch .ft button', { hasText: 'Switch' }).click();
  ok(await page.locator('.rsm-switch .hd', { hasText: 'Switching' }).waitFor({ timeout: 8000 }).then(() => true, () => false), 'the card turns into progress');
  let words = '';
  for (let i = 0; i < 120 && !/Codex is ready/.test(words); i++) {
    await page.waitForTimeout(1000);
    words = await page.locator('.rsm-prog').innerText().catch(() => words);
  }
  ok(/Codex is ready/.test(words), `plain words to the end: "${words.split('\n')[0]}"`);
  ok(!/packet-saved|context-delivered|lead-committed|failed-before-transfer/.test(words), 'never a state name');
} finally {
  await browser?.close().catch(() => {});
  await inst.stop();
}
console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
