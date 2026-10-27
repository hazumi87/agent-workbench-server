/* ASSEMBLE ROOM, S1 against the REAL S0 engine (the design notes §3 +
 * §4.1/§4.2 as implemented on engine/assemble-s0).
 *
 *   node test/assemble-engine.probe.mjs
 *
 * assemble-modal.probe.mjs proves the modal's design against stubbed shapes;
 * this one proves the WIRING against the engine itself: no route is stubbed.
 *   - readiness lists the seeded sessions; ineligible ones carry the engine's
 *     own reason (incl. session-open-elsewhere naming its partner via openIn)
 *   - the dry-run's handles are the engine's
 *   - Seat creates a real room with the checked panes seated and the lead set
 *   - Room › Add member on that room: a typed handle that is taken is refused
 *     by the REAL engine (409 handle-taken), the button relabels
 *     "Seat 1 · skip 1", and the retry (same key) seats the rest
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(86), DEAD broker P(87),
 * temp table seeded through the store; childEnv() scrubbed; fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(86);
const DEAD_BROKER_PORT = P(87);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-assemble-engine-token';
const hdr = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  if (stale.ok) { console.log(` FAIL  :${PORT} is already serving something`); process.exit(1); }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) { await assertFree(p, 'assemble-engine.probe.mjs'); }

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-assemble-engine-'));
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
  const recipe = (id, name, agent) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent });
  await seed({ recipes: [recipe('rec-ann', 'Ann', 'ann'), recipe('rec-bob', 'Bob', 'bob'), recipe('rec-cy', 'Cy', 'cy'), recipe('rec-dup', 'Dup', 'dup')] });
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_NODE: 'testnode',
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
  const flags = (await (await fetch(`${BASE}/health`)).json()).flags;
  ok(flags && 'seatRestorable' in flags, 'this engine is S0 (/health carries flags)', flags);

  await seed({
    sessions: [
      { paneid: 'recipe:rec-ann', recipe_id: 'rec-ann', vendor: 'claude-code', agent: 'ann', state: 'live' },
      { paneid: 'recipe:rec-bob', recipe_id: 'rec-bob', vendor: 'claude-code', agent: 'bob', state: 'live' },
      { paneid: 'recipe:rec-cy', recipe_id: 'rec-cy', vendor: 'claude-code', agent: 'cy', state: 'live' },
      /* session-open-elsewhere is a DEHYDRATED candidate's reason (nuc1
         ruling, spec §4.3): a restorable row whose conversation a LIVE twin
         already holds. The live twin itself stays seatable. */
      { paneid: 'recipe:rec-dup', recipe_id: 'rec-dup', vendor: 'claude-code', agent: 'dup', session_id: 'sess-shared', state: 'dehydrated' },
      { paneid: 'recipe:rec-dup#twin', recipe_id: 'rec-dup', vendor: 'claude-code', agent: 'dup', session_id: 'sess-shared', state: 'live' },
    ],
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);

  /* the engine's own readiness, for comparison */
  const rd = (await (await fetch(`${BASE}/api/sessions/readiness`, { headers: hdr })).json()).panes;
  const elig = rd.filter((p) => p.seat?.eligible).map((p) => p.paneid).sort();
  console.log(`    readiness: eligible=${JSON.stringify(elig)} ineligible=${JSON.stringify(rd.filter((p) => !p.seat?.eligible).map((p) => [p.paneid, p.seat?.reason, p.seat?.openIn]))}`);

  await page.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await page.click('#roomNewCard'); // Assemble is the New-room sheet's second path
  await page.click('#assembleBtn');
  await page.waitForSelector('.ras-pane', { timeout: 6000 });
  const listed = (await page.$$eval('.ras-pane', (rs) => rs.map((r) => r.dataset.paneid))).sort();
  ok(JSON.stringify(listed) === JSON.stringify(elig), 'the modal lists exactly the engine\'s eligible panes', { listed, elig });
  const dupRow = rd.find((p) => p.seat?.reason === 'session-open-elsewhere');
  if (dupRow) {
    await page.click('.ras-cant > button');
    const lis = await page.$$eval('.ras-cant li', (ls) => ls.map((l) => [l.dataset.paneid, l.textContent]));
    const other = rd.find((p) => p.paneid === dupRow.seat.openIn);
    const want = `same conversation is open in ${other?.title || other?.project || dupRow.seat.openIn}`;
    ok(lis.some(([id, t]) => id === dupRow.paneid && t.endsWith(want)), 'session-open-elsewhere names its partner (seat.openIn)', lis);
  } else {
    ok(false, 'the dehydrated row whose conversation a live twin holds reads session-open-elsewhere', rd.map((p) => [p.paneid, p.state, p.seat]));
  }

  /* Seat Ann + Bob into a NEW room, for real */
  await page.click('.ras-pane[data-paneid="recipe:rec-ann"] .nm');
  await page.click('.ras-pane[data-paneid="recipe:rec-bob"] .nm');
  await sleep(1000);
  const hs = await page.$$eval('.ras-pane[aria-checked="true"] .ras-hdl', (is) => is.map((i) => i.textContent.replace(/^@/, '')));
  ok(hs.length === 2 && hs.every(Boolean), 'the engine\'s dry-run fills both handles (room still unnamed)', hs);
  await page.fill('.ras-room .ras-name input', 'Engine Room');
  await sleep(900);
  const [popup] = await Promise.all([page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null), page.click('.ras-go')]);
  ok(!!popup && /\/room\.html\?room=/.test(popup.url()), 'Seat creates the room and opens it', popup?.url());
  const RID = popup ? new URL(popup.url()).searchParams.get('room') : null;
  if (popup) { await popup.close(); }
  const room = RID ? (await (await fetch(`${BASE}/api/rooms/${RID}`, { headers: hdr })).json()) : null;
  const seated = (room?.seats || []).map((s) => s.occupant?.id).sort();
  ok(JSON.stringify(seated) === JSON.stringify(['recipe:rec-ann', 'recipe:rec-bob']), 'the engine seated exactly the checked panes', seated);
  const leadSeat = room?.seats?.find((s) => s.id === room.room.lead_seat);
  ok(!!leadSeat && ['recipe:rec-ann', 'recipe:rec-bob'].includes(leadSeat.occupant?.id), '...and set a lead from them', leadSeat?.handle);

  /* Room › Add member: a taken handle is refused by the REAL engine */
  await page.goto(`${BASE}/room.html?room=${RID}`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await page.click('#addBtn');
  await page.waitForSelector('.ras-pane', { timeout: 6000 });
  const takenHandle = room.seats[0].handle;
  await page.click('.ras-pane[data-paneid="recipe:rec-cy"] .nm');
  const dupElig = await page.$('.ras-pane[data-paneid="recipe:rec-dup"]') ? 'recipe:rec-dup' : (await page.$('.ras-pane[data-paneid="recipe:rec-dup#twin"]') ? 'recipe:rec-dup#twin' : null);
  ok(!!dupElig, 'setup: a second candidate for the skip test', dupElig);
  await page.click(`.ras-pane[data-paneid="${dupElig}"] .nm`);
  await sleep(1000);
  await page.click('.ras-pane[data-paneid="recipe:rec-cy"] .ras-hdl');
  await page.fill('.ras-pane[data-paneid="recipe:rec-cy"] .ras-fld input', takenHandle);
  await sleep(1200);
  const dryMeta = await page.$eval('.ras-pane[data-paneid="recipe:rec-cy"] .nm .c', (m) => m.textContent).catch(() => '');
  ok(/taken/.test(dryMeta), `the dry-run already marks @${takenHandle} "taken" on the row`, dryMeta);
  await page.click('.ras-go');
  await sleep(1500);
  const label = await page.textContent('.ras-go');
  const also = await page.textContent('.ras-also');
  ok(label === 'Add 1' && /skips 1/.test(also), 'a REAL 409 (handle-taken) relabels "Add 1", also: skips 1', { label, also });
  await page.click('.ras-go');
  await sleep(1500);
  ok(!(await page.$('.ras-scrim')), 'the retry seats the rest and closes the sheet');
  const room2 = (await (await fetch(`${BASE}/api/rooms/${RID}`, { headers: hdr })).json());
  const s2 = room2.seats.map((s) => s.occupant?.id).sort();
  ok(s2.includes(dupElig) && !s2.includes('recipe:rec-cy'), 'the engine seated the other pane, not the refused one', s2);
  const lead2 = room2.seats.find((s) => s.id === room2.room.lead_seat)?.id;
  ok(lead2 === room.room.lead_seat, 'Add member kept the existing lead', { before: room.room.lead_seat, after: lead2 });

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
