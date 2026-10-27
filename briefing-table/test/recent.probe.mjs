/* Recently Closed lists one row per SESSION, named by the session.
 * Real Edge, live :7420. Not in `npm test` — needs the engine. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:7420';
const TOKEN = readFileSync('secrets/engine.token', 'utf8').trim();
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) failures++; };

// what the engine actually holds, so the assertions are against truth not a guess
const table = await (await fetch(`${BASE}/api/table`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
const rows = (table.sessions ?? table).filter(
  (r) => r.vendor === 'claude-code' && r.state !== 'live' && (r.session_id || r.resume_name));
const suffixed = rows.filter((r) => r.paneid.includes('#'));
console.log(`engine holds ${rows.length} recoverable closed sessions, ${suffixed.length} of them extra sessions of a project`);

const browser = await chromium.launch({ channel: 'msedge', headless: false });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
await page.goto(`${BASE}/login`);
await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelectorAll('.recent-group').forEach((d) => { d.open = true; }));
await page.waitForTimeout(300);

const listed = await page.evaluate(() => [...document.querySelectorAll('.recent-row')].map((el) => ({
  pane: el.dataset.pane,
  name: el.querySelector('.r-name').textContent.trim(),
  meta: el.querySelector('.r-meta').textContent.trim(),
})));
console.log(`manager lists ${listed.length}:`);
for (const l of listed.slice(0, 8)) { console.log(`   "${l.name}"  |  ${l.meta}`); }

/* The defect: one row per PROJECT meant a project's extra sessions never
   appeared at all, and nothing on screen said any were missing. */
/* THE ACTUAL REGRESSION GUARD. The old code looked up `recipe:<id>` — a
   project's PRIMARY pane — so every extra session was invisible with nothing on
   screen saying so. Assert on paneids, because a count can be satisfied by the
   wrong rows. Only sessions inside the shown date buckets can appear, so this
   compares against what is REACHABLE, not against everything the engine holds. */
const shownPanes = new Set(listed.map((l) => l.pane));
const oldest = listed.length ? Math.min(...listed.map((l) => {
  const m = (rows.find((r) => r.paneid === l.pane) || {}).updated_at;
  return m ?? Infinity;
})) : 0;
const reachableSuffixed = suffixed.filter((r) => r.updated_at >= oldest);
ok(reachableSuffixed.length === 0 || reachableSuffixed.every((r) => shownPanes.has(r.paneid)),
  `every extra session of a project inside the shown range is listed (${reachableSuffixed.length} checked)`);
ok(listed.every((l) => l.pane),
  'every row identifies WHICH session it is');

const titled = (table.sessions ?? table).filter((r) => r.title && r.state !== 'live' && r.vendor === 'claude-code');
if (titled.length) {
  const want = titled[0].title;
  ok(listed.some((l) => l.name === want),
    `a session with a title is named by it, not by its project ("${want}")`);
} else {
  console.log('  skip  no closed session carries a title right now');
}

// a project with several closed sessions must not render N identical rows
const byName = listed.reduce((m, l) => m.set(l.name, (m.get(l.name) ?? 0) + 1), new Map());
const dupes = [...byName].filter(([n, c]) => c > 1 && !n.startsWith('(unnamed'));
ok(dupes.length === 0 || dupes.every(([n]) => listed.filter((l) => l.name === n).every((l, i, a) => a[0].meta !== l.meta || i === 0)),
  `duplicate names are distinguishable by their meta line${dupes.length ? ' (' + dupes.map(([n, c]) => `${n} x${c}`).join(', ') + ')' : ''}`);

await page.screenshot({ path: 'test/recent.png', clip: { x: 0, y: 0, width: 660, height: 1000 } });
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
