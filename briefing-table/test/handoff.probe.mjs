/* HANDOFF end-to-end against the live engine, in REAL Edge.
 *   1. an agent POSTs labelled fields for its own session
 *   2. the window's badge appears with the right count
 *   3. the modal renders each field, masks the secret, and reveals on demand
 *   4. Copy puts the real value on the clipboard (the point of the feature)
 *   5. a reload does not lose them; Dismiss does
 * Not in `npm test` — needs the live engine, like the other probes. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:7420';
const TOKEN = readFileSync('secrets/engine.token', 'utf8').trim();
const RECIPE = process.env.PROBE_RECIPE || 'eeeeeeee-0000-4000-8000-0000000000e1';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) failures++; };

const browser = await chromium.launch({ channel: 'msedge', headless: false });
const ctx = await browser.newContext({
  viewport: { width: 420, height: 780 },          // phone-shaped: this is a phone fix
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
/* Launch through the API, as a user does. A bare page load on an ENDED pane is
   now refused (spawn permits) — which this probe discovered the hard way, and
   is exactly the behaviour the reload fix exists for. `surface:'browser'` asks
   for the url back instead of an OS window. */
const launched = await (await fetch(`${BASE}/api/recipes/${RECIPE}/launch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ target: 'tab', surface: 'browser' }),
})).json();
await page.goto(`${BASE}${launched.path ?? `/solo.html?recipe=${RECIPE}`}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// the pane's session uuid is how an agent addresses its own window
const table = await (await fetch(`${BASE}/api/table`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
const row = (table.sessions ?? table).find((r) => r.paneid === `recipe:${RECIPE}`);
ok(!!row?.session_id, `found the pane's session id (${row?.session_id?.slice(0, 8)}…)`);

const SECRET = 'p@ss-w0rd-Ω-77';
const post = await (await fetch(`${BASE}/api/handoff`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    session_id: row.session_id,
    title: 'Grafana login',
    items: [
      { label: 'Dashboard', value: 'https://example.com/d/abc?x=1&y=2', kind: 'url' },
      { label: 'User', value: 'owner.admin', kind: 'text' },
      { label: 'Password', value: SECRET, kind: 'secret' },
    ],
  }),
})).json();
ok(post.matched === `recipe:${RECIPE}`, `the agent reached its OWN window (${post.matched})`);
await page.waitForTimeout(700);

/* v21: the badge is the session bar's handoff icon (the bundle's): lit when
   something is waiting (no .is-empty), its count in the aria-label. */
const HANDOFF = '#sbar [data-sb="handoff"]';
const lit = () => page.evaluate((sel) => { const b = document.querySelector(sel); return !!b && !b.classList.contains('is-empty'); }, HANDOFF);
ok(await lit(), 'the session bar handoff icon lit up');
const aria = await page.getAttribute(HANDOFF, 'aria-label');
ok(/\(3\)$/.test(aria || ''), `icon counts the fields (${aria})`);

await page.click(HANDOFF);
await page.waitForTimeout(300);
const rows = await page.$$('.handoff-row');
ok(rows.length === 3, `modal renders one row per field (${rows.length})`);
const shown = await page.textContent('.handoff-row:nth-child(3) .handoff-value');
ok(!shown.includes('p@ss'), `the secret is masked until asked for (shows "${shown}")`);

await page.click('.handoff-row:nth-child(3) .handoff-acts button');   // Show
await page.waitForTimeout(200);
ok((await page.textContent('.handoff-row:nth-child(3) .handoff-value')) === SECRET, 'reveal shows the real value');

// Copy — the whole point. Read the clipboard back rather than trusting the label.
await page.click('.handoff-row:nth-child(3) .handoff-copy');
await page.waitForTimeout(400);
const clip = await page.evaluate(() => navigator.clipboard.readText());
ok(clip === SECRET, `Copy put the real value on the clipboard (${clip === SECRET ? 'match' : `got "${clip}"`})`);
ok(await page.isVisible('.handoff-copy.is-done'), 'and the button says so');

/* Row actions match the modal's OWN buttons (Dismiss/Close) rather than an
   absolute touch floor — Owner's call, 2026-09-04. Asserting consistency instead
   of a number means the check still means something if that size ever changes. */
const sizes = await page.evaluate(() => {
  const h = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height);
  return { row: h('.handoff-acts .pane-btn'), modal: h('#handoffClose') };
});
ok(sizes.row === sizes.modal,
  `row actions are sized like Dismiss/Close (${sizes.row}px vs ${sizes.modal}px)`);

/* The tab chrome's half (the design system window-chrome v20): the count must reach the
   SHELL, not just the in-window badge — a session you are not looking at is the
   whole point. Read from the page's own last emit rather than trusting that the
   call was made. */
const emitted = await page.evaluate(() => window.__lastEmit ?? null);
ok(emitted?.items?.count === 3,
  `the item count is forwarded to the tab chrome (${JSON.stringify(emitted?.items)})`);

await page.screenshot({ path: 'test/handoff.png' });

// survives a reload — a phone reloads tabs on its own
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
ok(await lit(), 'the fields survive a page reload');

// dismiss clears
await page.click(HANDOFF);
await page.waitForTimeout(300);
await page.click('#handoffDismiss');
await page.waitForTimeout(600);
ok(!(await lit()), 'Dismiss clears the badge');

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
