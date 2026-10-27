/* THE PROJECT MARK BEHIND THE CARD TITLE (the design system round-3 §4, Owner
 * 2026-09-27): on the CLI Manager's agent cards the project mark is no longer
 * a 34px leading icon but the same mark behind the title, anchored left at
 * -10px, vertically centred, 120px, 12%, in the project's ink tone, with the
 * title haloed; the brand watermark stays right-anchored, never overlapping.
 *
 *   node test/manager-card-mark.probe.mjs
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(48), DEAD broker P(49).
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
const PORT = P(48);
const DEAD_BROKER_PORT = P(49);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-card-mark-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookieP = null;
const userCookie = () => (cookieP ??= windowCookie(BASE, TOKEN));

async function call(path, opts = {}) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  /* a room write as the USER takes a person's credential: the window cookie,
     no bearer (rooms.ts authorFor, [ticket]); everything else is the agent */
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
  await assertFree(p, 'manager-card-mark.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-card-mark-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], {
    HARBOR_WB_TABLE: dbPath,
    HARBOR_WB_IDENTITY: 'legacy',
  });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  const recipe = (id, name, agent) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent });
  const DEH = 'recipe:rec-deh';
  await seed({
    recipes: [
      { ...recipe('rec-mark', 'Marked Project', 'marked'), color: '#0317b0', logo: JSON.stringify({ key: 'audio-editor' }) },
      recipe('rec-plain', 'Plain Project', 'plain'),
    ],
  });

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

  const LIVE = 'recipe:rec-live';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1900, height: 900 } }); // wide: the one-row card
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/manager.html#recipes`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const read = () => page.evaluate(() => [...document.querySelectorAll('.sess.c4')].map((card) => {
    const cr = card.getBoundingClientRect();
    const m = card.querySelector('.sess-proj');
    const mr = m.getBoundingClientRect();
    const cs = getComputedStyle(m);
    const bw = card.querySelector('.sess-bwm')?.getBoundingClientRect();
    const name = card.querySelector('.sess-name');
    return {
      name: name.textContent, display: cs.display, pos: cs.position, opacity: cs.opacity,
      w: Math.round(mr.width), h: Math.round(mr.height), left: Math.round(mr.left - cr.left),
      midOff: Math.round((mr.top + mr.height / 2) - (cr.top + cr.height / 2)),
      cardH: Math.round(cr.height), overflow: getComputedStyle(card).overflow,
      hasSvg: !!m.querySelector('svg'), color: cs.color, accent: getComputedStyle(card).getPropertyValue('--sess-accent').trim(),
      halo: getComputedStyle(name).textShadow, nameLeft: Math.round(name.getBoundingClientRect().left - cr.left),
      bwLeft: bw ? Math.round(bw.left - cr.left) : null, markRight: Math.round(mr.right - cr.left),
      bw: bw ? { l: Math.round(bw.left - cr.left), r: Math.round(bw.right - cr.left), t: Math.round(bw.top - cr.top), b: Math.round(bw.bottom - cr.top) } : null,
      mk: { l: Math.round(mr.left - cr.left), r: Math.round(mr.right - cr.left), t: Math.round(mr.top - cr.top), b: Math.round(mr.bottom - cr.top) },
      actsTop: Math.round(card.querySelector('.sess-actions').getBoundingClientRect().top - cr.top),
      titleMid: (() => { const a = name.getBoundingClientRect(); const b = card.querySelector('.sess-meta').getBoundingClientRect(); return Math.round((a.top + b.bottom) / 2 - cr.top); })(),
      markMid: Math.round(mr.top + mr.height / 2 - cr.top),
    };
  }));
  const cards = await read();
  const mk = cards.find((c) => c.name === 'Marked Project');
  const pl = cards.find((c) => c.name === 'Plain Project');
  const shot = (name) => page.locator('.sess.c4', { hasText: 'Marked Project' }).screenshot({ path: join(tmpdir(), name) });
  const gap1 = (a, b) => Math.max(b.l - a.r, a.l - b.r, b.t - a.b, a.t - b.b);
  /* B (the default, Owner 2026-09-28): the whole mark at the card's height */
  ok(mk && mk.hasSvg && mk.pos === 'absolute' && mk.w === mk.h && Math.abs(mk.h - (mk.cardH - 2)) <= 1 && Math.abs(mk.left - (mk.w + 1)) <= 1,
    'single-row (B, default): the WHOLE mark, as tall as the card, moved in by its own width (Owner b + c)', mk);
  ok(mk && Number(mk.opacity) > 0.11 && Number(mk.opacity) < 0.13 && /oklch/.test(mk.color) && mk.halo !== 'none', '...12%, project ink, the title haloed', mk);
  ok(mk && mk.bw && gap1(mk.mk, mk.bw) >= 12, '...the brand watermark stays right, >=12px clear of the mark', { mk: mk?.mk, bw: mk?.bw });
  ok(pl && pl.display === 'none', 'a project with no mark draws none', pl?.display);
  await shot('card-mark-B-single.png');
  /* A, one class away (.mark-crop): the 120px crop, centred, moved in */
  await page.evaluate(() => document.getElementById('agentList').classList.add('mark-crop'));
  await sleep(200);
  const a1 = (await read()).find((c) => c.name === 'Marked Project');
  ok(a1 && a1.w === 120 && a1.h === 120 && Math.abs(a1.left - 121) <= 1 && Math.abs(a1.midOff) <= 1, 'single-row (A, .mark-crop): the 120px crop, centred, moved in', a1);
  await shot('card-mark-A-single.png');
  /* two rows (with .mark-crop still on: the two-row rule must win either way) */
  await page.setViewportSize({ width: 1100, height: 900 });
  await sleep(600);
  const n = (await read()).find((c) => c.name === 'Marked Project');
  ok(n && n.w === n.h && n.h >= 30 && n.h < n.cardH - 20 && Math.abs(n.left - (n.w + 1)) <= 1 && n.nameLeft < 40, 'two-row: the WHOLE mark at the title block\'s height, moved in by its width (Owner a, auriga fix)', n);
  ok(n && n.mk.b <= n.actsTop, '...its bottom is at or above the controls row: nothing crosses it', { markBottom: n?.mk.b, actsTop: n?.actsTop });
  const gap = (a, b) => Math.max(b.l - a.r, a.l - b.r, b.t - a.b, a.t - b.b);
  ok(n && n.bw && gap(n.mk, n.bw) >= 12, '...and the brand watermark, right-anchored again after the resize, is >=12px clear of it', { mk: n?.mk, bw: n?.bw });
  await shot('card-mark-two-row.png');
  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
