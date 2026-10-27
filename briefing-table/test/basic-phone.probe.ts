/**
 * PHONE DAY ONE ON BASIC [ticket]  npx tsx test/basic-phone.probe.ts   (SHOTS_DIR=… for screenshots)
 * A scratch Basic instance driven by an iPhone-emulated WebKit (390x844, touch): the sign-in page with the one-time password, the
 * forced password change, the rooms list, a room, starting the seat, the keypad. Like basic-first-run, `ok` fails the probe and
 * `gap` is a thing a first-time user needs that today's page may not give. NOT in npm test (needs WebKit and the scratch instance).
 */
import { readFileSync } from 'node:fs';
import { chromium, webkit, devices } from 'playwright';
const { startScratchBasic, SCRATCH_PASSWORD } = await import('../scripts/basic-scratch-instance.ts');

let failed = 0;
const gaps: string[] = [];
const ok = (c: unknown, m: string, d?: unknown) => { console.log(`  ${c ? 'ok' : 'FAIL'} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) failed++; };
const gap = (c: unknown, m: string) => { if (c) console.log(`  ok ${m}`); else { gaps.push(m); console.log(`  GAP ${m}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS_DIR || '';

const inst = await startScratchBasic();
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
  /* WebKit is the honest engine for an iPhone, but it needs system libraries this box lacks (and installing them needs sudo);
     fall back to Chromium with the same phone viewport, touch and user agent. EMULATED: layout and input handling only. It
     does NOT reproduce the iOS soft keyboard, Display Zoom or Safari chrome, so those stay real-phone checks. */
  let engine = 'webkit';
  try { browser = await webkit.launch(); } catch { engine = 'chromium (webkit libs missing)'; browser = await chromium.launch(); }
  console.log('engine:', engine);
  const { defaultBrowserType: _d, ...phone } = devices['iPhone 13'];
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  const shot = async (n: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${n}.png` }); };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('sign-in page on a phone');
  await page.goto(`${inst.base}/login`);
  await sleep(800);
  await shot('01-login');
  const vis = await page.evaluate(() => ({
    user: !!document.querySelector('#row-user:not([hidden]) input'), pass: !!document.querySelector('#row-pass:not([hidden]) input'),
    token: !!document.querySelector('#row-token:not([hidden]) input'), w: innerWidth, sw: screen.width, sx: document.documentElement.scrollWidth,
  }));
  ok(vis.user && vis.pass, 'the username and password fields are shown', vis);
  ok(vis.sx <= vis.w, 'no sideways scroll on the sign-in page', { scrollWidth: vis.sx, innerWidth: vis.w });
  await page.fill('#username', inst.user);
  await page.fill('#password', inst.tempPassword);
  await page.click('button[type=submit]');
  await sleep(1500);
  await shot('02-after-login');
  console.log('  landed on', page.url());
  ok(!/\/login/.test(page.url()), 'the one-time password signs in');
  console.log('  page text:', (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300));
  console.log('forced password change on a phone');
  await page.fill('#current', inst.tempPassword);
  await page.fill('#next', SCRATCH_PASSWORD);
  const sx2 = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  ok(sx2, 'no sideways scroll on the account page');
  await page.click('#save');
  await sleep(1500);
  await shot('03-after-change');
  const c = await inst.signIn().catch(() => null);
  console.log('  url after save:', page.url());
  ok(!/change=1/.test(page.url()) || (await page.evaluate(() => !document.querySelector('#forced:not([hidden])'))), 'after the change the forced-change banner is gone');

  console.log('the rooms list on a phone');
  await page.goto(`${inst.base}/manager.html`);
  await sleep(2000);
  await shot('04-manager');
  console.log('  url:', page.url());
  console.log('  text:', (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400));
  const wide = await page.evaluate(() => ({ sx: document.documentElement.scrollWidth, w: innerWidth }));
  ok(wide.sx <= wide.w, 'no sideways scroll on the manager', wide);

  console.log('open a room on a phone');
  const roomId = await page.evaluate(async () => (await (await fetch('/api/rooms')).json()).find((r: any) => r.room.name === 'Hello World').room.id);
  await page.goto(`${inst.base}/room.html?room=${roomId}`);
  await sleep(3000);
  await shot('05-room');
  console.log('  url:', page.url());
  const room = await page.evaluate(() => ({
    sx: document.documentElement.scrollWidth, w: innerWidth,
    buttons: [...document.querySelectorAll('button, [role=button], a.btn')].map((b) => (b as HTMLElement).innerText.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 40),
    keypad: !!document.querySelector('.kp, .keypad, [class*=keypad], [data-keypad]'),
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500),
  }));
  console.log('  room buttons:', JSON.stringify(room.buttons));
  console.log('  room text:', room.text);
  ok(room.sx <= room.w, 'no sideways scroll in the room', { sx: room.sx, w: room.w });
  gap(/start|wake|open|launch/i.test(room.buttons.join(' | ') + room.text), 'the room offers a visible way to start the assistant');

  console.log('start the assistant from the phone');
  const visibleStart = await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /^start$/i.test((b as HTMLElement).innerText.trim()) && (b as HTMLElement).offsetParent !== null && b.getBoundingClientRect().width > 0));
  console.log('  Start visible on the room page before opening anything:', visibleStart);
  gap(visibleStart, 'the room page shows a Start button without opening a menu (a first-timer sees only "1 agent")');
  await page.touchscreen.tap(99, 46); // the people icon in the room header (phone layout)
  await sleep(800);
  await shot('06-seats-menu');
  console.log('  buttons after tap:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => (b as HTMLElement).offsetParent !== null).map((b) => (b as HTMLElement).innerText.trim().replace(/\\s+/g, ' ')).filter(Boolean).slice(0, 30))));
  const startBtn = page.getByRole('button', { name: /^start$/i }).first();
  const startShown = await startBtn.isVisible().catch(() => false);
  ok(startShown, 'Start is reachable through the Seats menu');
  if (startShown) {
    await startBtn.tap().catch(() => startBtn.click());
    await sleep(6000);
    await shot('07-after-start');
    const after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 700));
    console.log('  after Start:', after);
    const frames = page.frames();
    console.log('  frames:', frames.map((f) => f.url().replace(inst.base, '')).join(' | '));
    const term = frames.find((f) => /solo\.html/.test(f.url())) ?? page;
    const keys = await term.evaluate(() => [...document.querySelectorAll('button, [role=button]')].filter((b) => b.getBoundingClientRect().width > 0 && (b as HTMLElement).offsetParent !== null).map((b) => ((b as HTMLElement).getAttribute('aria-label') || (b as HTMLElement).innerText || (b as HTMLElement).title || '').trim().replace(/\s+/g, ' ')).filter(Boolean));
    console.log('  visible controls in the terminal view:', JSON.stringify(keys));
    gap(keys.some((k) => /enter|esc|up|down/i.test(k)), 'the terminal view shows the special keys (Enter, arrows, Esc) a first-run dialog needs');
    gap(keys.some((k) => /key/i.test(k)), 'the terminal view has a visible way to bring up the keys');
    // answer the trust dialog the way a phone can: tap the terminal, type 1, press Enter
    await page.touchscreen.tap(195, 450);
    await sleep(500);
    await page.keyboard.type('1');
    await sleep(700);
    await page.keyboard.press('Enter');
    await sleep(2500);
    await shot('08-after-answer');
    const log = (await import('node:fs')).readFileSync(`${inst.home}/.fake-vendors/claude-input.log`, 'utf8');
    console.log('  raw input that reached the assistant:', JSON.stringify(log.trim().split('\n')));
    ok(/1/.test(log), 'a "1" typed from the phone reaches the assistant');
    console.log('a runaway repeated key (a phone key stuck down)');
    const countY = () => (readFileSync(`${inst.home}/.fake-vendors/claude-input.log`, 'utf8').split('\n').filter((l) => l === '"y').length);
    const before = countY();
    await page.touchscreen.tap(195, 450);
    await page.keyboard.type('y'.repeat(600), { delay: 0 });
    await sleep(2500);
    const reached = countY() - before;
    console.log(`  600 fast "y" keys typed; ${reached} reached the assistant`);
    gap(reached <= 300, 'a runaway flood of one key is cut off before it all reaches the assistant (stuck-key guard)');
    await page.keyboard.type('z');
    await sleep(800);
    ok(readFileSync(`${inst.home}/.fake-vendors/claude-input.log`, 'utf8').split('\n').includes('"z'), 'a different key still gets through after the flood');
    gap(/stuck|repeat|held down|too fast/i.test(await page.evaluate(() => document.body.innerText) + (await term.evaluate(() => document.body.innerText))), 'the person is told on screen that a key was cut off');
    gap(/trust|folder|safety|answer|waiting/i.test(after), 'after Start the page itself says what the assistant is waiting for (trust the folder)');
  }
  if (errors.length) console.log('  page errors:', errors);
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error).stack}`);
} finally {
  await browser?.close().catch(() => {});
  await inst.stop();
}
if (gaps.length) { console.log(`\nOPEN GAPS (${gaps.length}):`); gaps.forEach((g, i) => console.log(`  ${i + 1}. ${g}`)); }
console.log(`\n${failed ? 'FAILURES' : 'done'}`);
process.exit(failed ? 1 : 0);
