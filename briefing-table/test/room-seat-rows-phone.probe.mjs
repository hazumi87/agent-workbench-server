/* PHONE SEAT ROWS (Owner [ref]): similar handles stay readable.
 *
 *   node test/room-seat-rows-phone.probe.mjs
 *
 * Seats @alpha-platform (lead, restorable), @alpha-platform2, @alpha-blender
 * at 390x844 and 320x640 (touch, mobile; Chromium + WebKit when installed).
 * Asserts on computed rects / rendered text: the whole handle shows (wrapped,
 * never ellipsised) at 390, the Restore button is a 44x44 icon with the aria
 * name "Restore @name", the lead badge sits BELOW the name, the ⋯ is 44px,
 * nothing scrolls sideways, tap targets stay >=44; at 320 the MIDDLE cut
 * happens only when a handle needs more than two lines. Desktop (1440) keeps
 * the word button. A PROBE, not in `npm test`. Own scratch engine on P(300),
 * DEAD broker P(301), temp table, childEnv() scrubbed, fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(300);
const DEAD_BROKER_PORT = P(301);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-seat-rows-phone-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runTsx(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

await assertFree(PORT, 'room-seat-rows-phone.probe.mjs');
await assertFree(DEAD_BROKER_PORT, 'room-seat-rows-phone.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-seat-rows-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
const browsers = [];
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  const LONG = 'alpha-renderfarm-blender-extended-2';
  const NAMES = ['alpha-platform', 'alpha-platform2', 'alpha-blender'];
  const ALL = [...NAMES, LONG];
  const recipe = (n) => ({ id: `rec-${n}`, name: n, projectDir: `/srv/x/${n}`, vendor: 'claude-code', agent: n, color: '#1f5fbf' });
  await seed({
    recipes: ALL.map(recipe),
    sessions: [
      { paneid: 'recipe:rec-alpha-platform', recipe_id: 'rec-alpha-platform', vendor: 'claude-code', agent: 'alpha-platform', state: 'dehydrated' },
      { paneid: 'recipe:rec-alpha-blender', recipe_id: 'rec-alpha-blender', vendor: 'claude-code', agent: 'alpha-blender', state: 'dehydrated' },
      { paneid: `recipe:rec-${LONG}`, recipe_id: `rec-${LONG}`, vendor: 'claude-code', agent: LONG, state: 'dehydrated' },
      { paneid: 'recipe:rec-alpha-platform2', recipe_id: 'rec-alpha-platform2', vendor: 'claude-code', agent: 'alpha-platform2', state: 'live' },
    ],
  });
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_NODE: 'testnode',
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
  const post = await seed({
    rooms: [{
      name: 'Seat Rows Probe',
      seats: ALL.map((n) => ({ handle: n, recipe_id: `rec-${n}`, occupant: `recipe:rec-${n}` })),
    }],
  });
  const R = post.rooms[0].id;

  /* the page: measure every seat row in the roster */
  const measure = (pg, root) => pg.evaluate((root) => {
    const out = {};
    for (const li of document.querySelectorAll(`${root} .seat[data-handle]`)) {
      const q = (s) => li.querySelector(s);
      const r = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
      const h = q('.seat-handle'); const act = q('.seat-act'); const more = q('.rsm-more'); const lead = q('.seat-lead'); const meta = q('.seat-meta');
      const lh = parseFloat(getComputedStyle(h).lineHeight);
      out[li.dataset.handle] = {
        text: h.textContent, full: h.dataset.full, lines: Math.round(h.getBoundingClientRect().height / lh),
        clipped: h.scrollWidth > h.clientWidth + 1, ell: getComputedStyle(h).textOverflow,
        handle: r(h), act: r(act), actAria: act?.getAttribute('aria-label') ?? null, actText: act?.textContent ?? null, actIconShown: act ? (() => { const i = act.querySelector('.seat-act-i'); return !!i && getComputedStyle(i).display !== 'none'; })() : null,
        more: r(more), lead: r(lead), meta: r(meta), metaClipped: meta ? meta.scrollWidth > meta.clientWidth + 1 : null, metaText: meta?.textContent ?? '',
        row: r(li), rowOverflow: li.scrollWidth > li.clientWidth + 1,
      };
    }
    out.docOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    return out;
  }, root);

  const login = async (ctx) => {
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    return pg;
  };

  for (const [bname, type] of [['chromium', chromium], ['webkit', webkit]]) {
    let browser;
    try { browser = await type.launch({ headless: true }); } catch (e) { console.log(`  skip  ${bname} not installed (${String(e).slice(0, 60)})`); continue; }
    browsers.push(browser);
    for (const [w, hgt] of [[1440, 900], [390, 844], [320, 640]]) {
      const phone = w < 600;
      const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: phone, isMobile: phone && bname === 'chromium' });
      const pg = await login(ctx);
      await pg.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
      const root = phone ? '#phSheet' : '#roster';
      await pg.waitForSelector('#roster .seat[data-handle]', { state: 'attached' });
      if (phone) {
        /* the Agents sheet is the phone's seat list */
        await pg.tap('#phAgents');
        await pg.waitForSelector('#phSheet:not([hidden]) .seat[data-handle]');
      }
      await sleep(900);
      const tag = `${bname} ${w}px`;
      const m = await measure(pg, root);
      const seats = NAMES.map((n) => m[n]);
      ok(seats.every(Boolean), `${tag}: all three seat rows render`, Object.keys(m));
      if (!seats.every(Boolean)) { await ctx.close(); continue; }
      if (!phone) {
        ok(seats[0].actText === 'Restore' && seats[0].actIconShown === false && seats[0].act.w > 44, `${tag}: desktop keeps the Restore WORD button, icon hidden`, { t: seats[0].actText, w: seats[0].act.w });
        ok(seats[0].lead.y < seats[0].handle.b && seats[0].lead.x > seats[0].handle.x, `${tag}: desktop lead badge still beside the name`, { lead: seats[0].lead, handle: seats[0].handle });
        await ctx.close(); continue;
      }
      ok(!m.docOverflow, `${tag}: nothing scrolls sideways`);
      console.log(`  info  ${tag}: handle widths ${NAMES.map((n) => `${n}=${Math.round(m[n].handle.w)}px`).join(' ')}`);
      const L = m[LONG];
      if (L) {
        ok(L.lines <= 2 && L.row.r <= w + 0.5, `${tag} long name: at most two lines, inside the row`, { lines: L.lines, text: L.text });
        {
          ok(L.text === L.full || (/^@.+…\S+$/.test(L.text) && L.text.startsWith(L.full.slice(0, 4)) && L.text.endsWith(L.full.slice(-3))), `${tag} long name: whole, or (a 45-char handle) cut in the MIDDLE only`, L.text);
        }
      }
      for (const [i, n] of NAMES.entries()) {
        const s = seats[i];
        ok(s.row.r <= w + 0.5 && !s.rowOverflow, `${tag} @${n}: row inside the viewport, no overflow`, { r: s.row.r });
        ok(s.ell !== 'ellipsis' || !s.clipped, `${tag} @${n}: the name is never ellipsised`, { ell: s.ell, clipped: s.clipped });
        ok(s.more && s.more.w >= 44 && s.more.h >= 44, `${tag} @${n}: the ⋯ is >=44px`, s.more && [s.more.w, s.more.h]);
        ok(s.row.h >= 56, `${tag} @${n}: row tap target kept (>=56 tall)`, s.row.h);
        if (w === 390) {
          ok(s.text === `@${n}` && s.text === s.full && !s.clipped, `${tag} @${n}: the whole handle is shown untruncated`, { text: s.text, lines: s.lines });
        } else {
          const cut = s.text !== s.full;
          const need = s.lines;
          ok(need <= 2, `${tag} @${n}: at most two lines`, { text: s.text, lines: need });
          if (cut) {
            ok(/^@.+…\S+$/.test(s.text) && s.text.endsWith(s.full.slice(-3)) && s.text.startsWith(s.full.slice(0, 3)), `${tag} @${n}: cut in the MIDDLE (both ends kept)`, s.text);
          } else {
            console.log(`  info  ${tag} @${n}: fits whole in <=2 lines (${s.lines})`);
          }
        }
      }
      if (w === 320) {
        /* the middle-cut rule must fire for something only if something is too long; assert the SHORTEST name is never cut */
        ok(seats[0].text === seats[0].full, `${tag}: the short name is not cut`, seats[0].text);
      }
      const a = seats[0];
      ok(a.act && a.act.w === 44 && a.act.h === 44, `${tag}: Restore is a 44x44 button`, a.act && [a.act.w, a.act.h]);
      ok(a.actAria === 'Restore @alpha-platform' && a.actIconShown === true, `${tag}: Restore has aria-label "Restore @alpha-platform" and shows its icon`, { aria: a.actAria, icon: a.actIconShown });
      ok(a.lead && a.lead.y >= a.handle.b - 1, `${tag}: the lead badge is BELOW the name`, { leadY: a.lead && a.lead.y, nameB: a.handle.b });
      ok(a.act && a.more && a.act.r <= a.more.x + 1, `${tag}: Restore and ⋯ do not overlap`, { actR: a.act.r, moreX: a.more.x });
      ok(!a.metaClipped, `${tag}: the status line wraps, not clipped`, a.metaText);
      /* a long status line wraps within the row */
      await pg.evaluate(() => { const m = document.querySelector('#phSheet .seat[data-handle="alpha-platform2"] .seat-meta'); m.append(' · a very long held text that must wrap onto more lines instead of truncating with an ellipsis'); });
      const after = (await measure(pg, root))['alpha-platform2'];
      ok(!after.metaClipped && after.meta.h > seats[1].meta.h && !after.rowOverflow, `${tag}: a long status wraps (taller, not clipped)`, { before: seats[1].meta.h, after: after.meta.h });
      /* tap still acts: the Restore tap reaches the start verb */
      let hit = false;
      await pg.route('**/seats/*/start', async (route) => { hit = true; await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"entries":[]}' }); });
      await pg.tap('#phSheet .seat[data-handle="alpha-platform"] .seat-act').catch(() => {});
      await sleep(400);
      ok(hit, `${tag}: tapping the icon calls the start verb`);
      await ctx.close();
    }
  }
} catch (e) {
  failures += 1;
  console.log(' FAIL  probe threw:', e?.stack ?? e);
} finally {
  for (const b of browsers) { await b.close().catch(() => {}); }
  engine?.kill('SIGKILL');
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
