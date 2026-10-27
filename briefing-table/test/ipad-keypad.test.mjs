/* THE CLI KEYPAD ON AN iPAD [ipad keypad] Owner 2026-10-05.  node test/ipad-keypad.test.mjs
 * Source slices (solo.js gates the keypad / soft-keyboard tracker / touch scroll on touchInput(), never a width) and a
 * mock (a static page importing the real soft-keyboard.mjs, faked navigator): touchInput() answers true for a coarse
 * iPad AND for an iPad in desktop-class mode (a fine, hovering pointer + the Mac signature + touch points), and false
 * for a real Mac and a Windows touch laptop. The keypad's behaviour at iPad sizes is test/solo-keybar.probe.mjs
 * (SIZES now include 1366x1024 and 1024x1366). */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const solo = readFileSync(join(WEB, 'solo.js'), 'utf8');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
ok(/import \{ trackSoftKeyboard, touchInput \} from '\/soft-keyboard\.mjs'/.test(solo), 'solo.js uses the shared touchInput()');
ok(/const COARSE_POINTER = touchInput\(\);/.test(solo), 'the one touch flag is touchInput()');
ok(/override !== '0' && COARSE_POINTER\)/.test(solo) && /when: COARSE_POINTER,/.test(solo) && /if \(!el \|\| !COARSE_POINTER\) \{/.test(solo), 'the keypad, the keyboard tracker and touch scroll all follow it; ?keys=0/1 still overrides');
ok(!/max-width/.test(solo.slice(solo.indexOf('function buildTouchKeypad'), solo.indexOf('function buildTouchKeypad') + 400)), 'no width in the keypad gate');

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript' };
const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname;
  if (u === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>'); return; }
  const f = join(WEB, u);
  if (!f.startsWith(WEB) || !existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', MIME[extname(f)] ?? 'text/plain'); res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;
const br = await chromium.launch();
const CASES = [
  ['iPad, coarse pointer', { hasTouch: true, isMobile: true, viewport: { width: 1366, height: 1024 } }, null, true],
  ['iPad, desktop-class mode (fine pointer, Macintosh UA, 5 touch points)', { viewport: { width: 1366, height: 1024 } }, { platform: 'MacIntel', points: 5 }, true],
  ['a real Mac (fine pointer, no touch)', { viewport: { width: 1366, height: 1024 } }, { platform: 'MacIntel', points: 0 }, false],
  ['a Windows touch laptop (fine pointer, 10 touch points)', { viewport: { width: 1366, height: 1024 } }, { platform: 'Win32', points: 10 }, false],
];
for (const [name, opts, fake, want] of CASES) {
  const ctx = await br.newContext(opts);
  if (fake) {
    await ctx.addInitScript((f) => {
      Object.defineProperty(navigator, 'platform', { get: () => f.platform });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => f.points });
    }, fake);
  }
  const pg = await ctx.newPage();
  await pg.goto(base);
  const got = await pg.evaluate(async () => (await import('/soft-keyboard.mjs')).touchInput());
  ok(got === want, `touchInput(): ${name} -> ${want}`);
  await ctx.close();
}
await br.close(); srv.close();
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
