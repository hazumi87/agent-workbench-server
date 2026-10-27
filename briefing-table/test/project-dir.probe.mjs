/* REGRESSION: a project folder that is not there must SAY so, and a trailing
 * slash must be fixed without asking.
 *
 * A PROBE, not part of `npm test`: needs the live engine on :7420 and REAL Edge
 * (same convention as manager-width.probe.mjs). It drives the actual form
 * because the half that cannot be checked from the engine side is the
 * acknowledge flow — the engine returns the same warning every time, and it is
 * the PAGE that decides a second Save means "I know". Asserting that from a
 * curl would be asserting nothing.
 *
 * Why this exists: Kiosk's recipe said `/srv/code/kiosk/`, that one
 * character encoded to a transcript dir which does not exist, and the failure
 * was completely silent — the listing returned zero rows and the pane simply
 * had no name for days (2026-09-13).
 *
 * It creates recipes named `__probe_dir_*` and deletes them on the way out,
 * including if an assertion fails — a test must not leave rows in Owner's
 * manager.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.WB_BASE || 'http://127.0.0.1:7420';
const TOKEN = readFileSync('secrets/engine.token', 'utf8').trim();
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

/** A folder that certainly is not there, and one that certainly is. */
const MISSING = 'C:\\code\\__probe_no_such_folder';
const REAL_WITH_SLASH = 'C:\\code\\briefing-table\\';
const REAL_CLEAN = 'C:\\code\\briefing-table';

let failures = 0;
const ok = (c, m, detail) => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!c) {
    failures++;
  }
};

const made = new Set();
async function cleanup() {
  for (const name of made) {
    const res = await fetch(`${BASE}/api/recipes`, { headers: AUTH });
    const { recipes } = await res.json();
    for (const r of recipes.filter((x) => x.name === name)) {
      await fetch(`${BASE}/api/recipes/${encodeURIComponent(r.id)}`, {
        method: 'DELETE',
        headers: AUTH,
      });
    }
  }
}

const browser = await chromium.launch({ channel: 'msedge', headless: false });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
  await page.goto(`${BASE}/login`);
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

  /** Open the new-session form and fill the two fields this probe cares about. */
  async function fillForm(name, dir) {
    made.add(name);
    await page.evaluate(() => { location.hash = '#recipes'; }); // the recipe editor's button lives on the Recipes screen
    await page.click('#newBtn');
    await page.waitForSelector('#fName', { state: 'visible' });
    await page.fill('#fName', name);
    await page.fill('#fDir', dir);
  }
  const warnText = () =>
    page.evaluate(() => {
      const el = document.getElementById('fDirWarn');
      return el && !el.hidden ? el.textContent.trim() : null;
    });
  const formOpen = () =>
    page.evaluate(() => {
      const el = document.getElementById('fName');
      return !!(el && el.offsetParent !== null);
    });

  console.log('\n[a missing folder is flagged, and the form stays open]');
  await fillForm('__probe_dir_missing', MISSING);
  await page.click('#saveBtn');
  await page.waitForTimeout(1200);
  const w1 = await warnText();
  ok(!!w1 && /no such directory/i.test(w1), 'the warning names the problem', JSON.stringify(w1));
  ok(await formOpen(), 'the form stayed open so the path can be fixed');

  console.log('\n[but it SAVED — a warning is not a refusal]');
  const saved = await (await fetch(`${BASE}/api/recipes`, { headers: AUTH })).json();
  ok(
    saved.recipes.some((r) => r.name === '__probe_dir_missing'),
    'the recipe exists despite the warning',
  );

  console.log('\n[a second Save means "I know"]');
  await page.click('#saveBtn');
  await page.waitForTimeout(1200);
  ok(!(await formOpen()), 'the form closed on the second Save');

  console.log('\n[a trailing slash is fixed silently — no warning at all]');
  await fillForm('__probe_dir_slash', REAL_WITH_SLASH);
  await page.click('#saveBtn');
  await page.waitForTimeout(1200);
  ok(!(await formOpen()), 'a real folder closes the form first time');
  const after = await (await fetch(`${BASE}/api/recipes`, { headers: AUTH })).json();
  const row = after.recipes.find((r) => r.name === '__probe_dir_slash');
  ok(
    row?.projectDir === REAL_CLEAN,
    'the stored path lost its trailing separator',
    JSON.stringify(row?.projectDir),
  );
} finally {
  await cleanup();
  await browser.close();
}

console.log(`\n${'='.repeat(40)}`);
console.log(failures ? `FAIL ${failures}` : 'all green');
process.exit(failures ? 1 : 0);
