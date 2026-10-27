/* DISSOLVE GROUP, END TO END THROUGH THE UI  node test/room-dissolve-ui.probe.mjs
 * Scratch engine (dead broker, temp table). Per browser (Chromium, WebKit when installed) and viewport (desktop 1280x800,
 * phone 390x844 touch+mobile) a FRESH family is seeded and the workgroups are made through the real API:
 *   root 'Base' (lead + extra seat) > 'Alpha' (1 seat) and 'Beta' (lead + 2 seats), every seat on a live pane.
 *   - the row menu of Beta has 'Dissolve group...'; Base's own row menu and a plain seat's menu do not
 *   - the dialog names Beta's seats, marks the lead, says they return to Base (the ROOT, not Alpha), 'Nothing is deleted';
 *     Cancel changes nothing
 *   - the Dissolve button is disabled until the seat read lands (the GET is held)
 *   - confirm: all seats in Base, same ids/handles, Base's lead unchanged, Beta archived, facts in both rooms, Alpha untouched,
 *     a toast, and the page navigates from Beta to Base
 *   - a second dissolve is refused by the engine (409) and the dialog shows its message inline
 *   - phone: the menu is the bottom sheet with its Cancel row; dialog buttons >= 44px, card inside the screen
 * A PROBE, not in `npm test`. Own scratch engine at P(71)/P(72) (use WB_TEST_PORT_OFFSET), temp table. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(71);
const DEAD = P(72);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-dissolve-ui-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('exit', (code) => resolve({ code, out, err }));
});

await assertFree(PORT, 'room-dissolve-ui.probe.mjs');
await assertFree(DEAD, 'room-dissolve-ui.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-dissolve-ui-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let engineLog = '';
const browsers = [];
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};
let cookie = '';
const api = async (path, method = 'GET', body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
let famN = 0;
/** A fresh family through the real API. */
async function family() {
  famN += 1;
  const n = famN;
  const hs = ['lead', 'extra', 'a1', 'b1', 'b2', 'b3', 'g1'].map((h) => `${h}${n}`);
  const rid = (h) => `rec-${h}`;
  await seed({ recipes: hs.map((h) => ({ id: rid(h), name: h, projectDir: `/srv/x/${h}`, vendor: 'claude-code', agent: h, color: '#1f5fbf' })) });
  const post = await seed({
    sessions: hs.map((h) => ({ paneid: `recipe:${rid(h)}`, recipe_id: rid(h), vendor: 'claude-code', agent: h, state: 'live' })),
    rooms: [{ name: 'Base', seats: hs.map((h) => ({ handle: h, recipe_id: rid(h), occupant: `recipe:${rid(h)}` })) }],
  });
  const R = post.rooms[0].id;
  const S = post.rooms[0].seats;
  const mk = async (name, ids, leadId) => {
    const r = await api(`/api/rooms/${R}/workgroups`, 'POST', { name, move: ids, lead: { move: leadId } });
    if (r.status !== 200) { throw new Error(`workgroup ${name}: ${r.status} ${JSON.stringify(r.body)}`); }
    return r.body.room?.id ?? r.body.workgroup?.id ?? r.body.id;
  };
  const A = await mk('Alpha', [S[hs[2]]], S[hs[2]]);
  const B = await mk('Beta', [S[hs[3]], S[hs[4]], S[hs[5]]], S[hs[3]]);
  const G = await mk('Gamma', [S[hs[6]]], S[hs[6]]);
  return { R, A, B, G, S, hs, n };
}

try {
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode' }) });
  engine.stdout.on('data', (d) => (engineLog += d)); engine.stderr.on('data', (d) => (engineLog += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, `scratch engine up on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('no engine'); }
  cookie = await windowCookie(BASE, TOKEN);
  const cookies = cookie.split('; ').map((c) => { const [name, ...v] = c.split('='); return { name, value: v.join('='), url: BASE }; });

  const roomState = async (id) => { const r = await api(`/api/rooms/${id}`); return r.body; };
  const live = (s) => (s.seats ?? []).filter((x) => !x.left_at);

  /** Find the row's ⋯ for a room by name (rail on a desktop, the Rooms section of a sheet on a phone). */
  let scope = '';
  const rowFor = (pg, name) => pg.locator(`${scope} li[data-nav-room]:has(.seat-handle:text-is("${name}")) .rsm-more`).first();
  const menuItems = (pg) => pg.evaluate(() => [...document.querySelectorAll('.rsm-menu .rsm-mi')].map((e) => e.textContent.trim()));
  const menuInfo = (pg) => pg.evaluate(() => {
    const m = document.querySelector('.rsm-menu'); if (!m) { return null; }
    const c = m.querySelector('.rsm-cancel');
    return { sheet: m.classList.contains('is-sheet'), cancel: !!c, cancelH: c ? Math.round(c.getBoundingClientRect().height) : 0 };
  });
  const closeMenu = async (pg, phone) => {
    if (!(await pg.$('.rsm-menu'))) { return; }
    if (phone) { await pg.tap('.rsm-cancel').catch(() => {}); } else { await pg.keyboard.press('Escape'); }
    await sleep(300);
  };
  const openTree = async (pg, phone) => {
    scope = phone ? '#phSheet' : '#roomList';
    if (phone) {
      /* the Rooms section of a sheet: try the Agents sheet, then the Workbench (places) sheet */
      for (const sel of ['#phAgents', '.ph-places']) {
        if ((await pg.locator('#phSheet:not([hidden]) li[data-nav-room]').count()) > 0) { return; }
        if (await pg.evaluate(() => document.querySelector('#phStrip')?.hidden)) { await pg.tap('#phLine').catch(() => {}); await sleep(300); }
        if (await pg.$(sel)) { await pg.tap(sel).catch(() => {}); await sleep(700); }
        if ((await pg.locator('#phSheet:not([hidden]) li[data-nav-room]').count()) > 0) { return; }
      }
      throw new Error('could not find the room tree in any phone sheet');
    }
    await pg.waitForSelector('#roomList li[data-nav-room]', { state: 'attached' });
  };
  const clickMore = async (pg, name, phone) => {
    const more = rowFor(pg, name);
    if (phone) { await more.tap(); } else { await more.hover().catch(() => {}); await more.click(); }
    await sleep(350);
  };
  const dialog = (pg) => pg.evaluate(() => {
    const d = document.querySelector('.rsm-dscrim .rsm-card'); if (!d) { return null; }
    const r = d.getBoundingClientRect();
    const btns = [...d.querySelectorAll('.rsm-btn')].map((b) => ({ a: b.dataset.a, h: Math.round(b.getBoundingClientRect().height), disabled: b.disabled }));
    return { head: d.querySelector('.hd')?.textContent, msg: d.querySelector('.rsm-dmsg')?.textContent, err: d.querySelector('.rsm-derr')?.hidden ? '' : d.querySelector('.rsm-derr')?.textContent,
      btns, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, vh: innerHeight };
  });

  for (const [bname, type] of [['chromium', chromium], ['webkit', webkit]]) {
    let br;
    try { br = await type.launch({ headless: true }); } catch (e) { console.log(`  --    ${bname} not installed (${String(e).slice(0, 60)})`); continue; }
    browsers.push(br);
    for (const phone of [false, true]) {
      const tag = `${bname} ${phone ? 'phone 390x844' : 'desktop 1280x800'}`;
      console.log(`\n[${tag}]`);
      const F = await family();
      const { R, A, B, G, S, hs } = F;
      const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
      await ctx.addCookies(cookies);
      const pg = await ctx.newPage();
      const perr = [];
      pg.on('pageerror', (e) => { if (!/access control checks|Load failed/.test(String(e))) { perr.push(String(e)); } });
      const go = async (id) => { await pg.goto(`${BASE}/room.html?room=${id}&shell=0`, { waitUntil: 'domcontentloaded' }); await sleep(2200); };
      const t = (s) => `${tag}: ${s}`;

      /* ---- (1) the menus ---- */
      await go(R);
      await openTree(pg, phone);
      ok((await rowFor(pg, 'Beta').count()) === 1 && (await rowFor(pg, 'Alpha').count()) === 1, t('Alpha and Beta rows each carry a ⋯'));
      await clickMore(pg, 'Beta', phone);
      let items = await menuItems(pg); let info = await menuInfo(pg);
      ok(items.some((x) => x.startsWith('Dissolve group')), t('Beta menu has "Dissolve group…"'), items);
      if (phone) { ok(info?.sheet && info.cancel && info.cancelH >= 44, t('...as the bottom sheet with a Cancel row (>= 44px)'), info); } else { ok(info && !info.sheet, t('...as a popover on desktop'), info); }
      await closeMenu(pg, phone);
      ok((await pg.locator(`${scope} li[data-nav-room].is-room .rsm-more`).count()) === 0, t('on the main room itself its own row has no ⋯ at all (so no Dissolve)'));
      /* inside a workgroup the main room's head row has a menu: Rename only */
      await go(A);
      await openTree(pg, phone);
      const headMore = pg.locator(`${scope} li[data-nav-room].is-room .rsm-more`).first();
      await headMore[phone ? 'tap' : 'click']();
      await sleep(350);
      items = await menuItems(pg);
      ok(items.length > 0 && !items.some((x) => /Dissolve/.test(x)), t('the main room row menu (seen from Alpha) has NO Dissolve'), items);
      await closeMenu(pg, phone);
      await go(R);
      await openTree(pg, phone);
      /* a plain seat: Agents sheet row on a phone, the roster row on a desktop */
      if (phone) {
        await pg.evaluate(() => { document.getElementById('phSheet').hidden = true; }).catch(() => {});
        await go(R);
        await pg.tap('#phAgents').catch(() => {}); await sleep(700);
      }
      const seatMore = phone ? `#phSheet .seat[data-handle="${hs[1]}"] .rsm-more` : `#roster .seat[data-handle="${hs[1]}"]`;
      if (phone) { await pg.tap(seatMore); } else { await pg.click(`${seatMore} .seat-handle`, { button: 'right' }); }
      await sleep(350);
      items = await menuItems(pg);
      ok(items.length > 0 && !items.some((x) => /Dissolve/.test(x)), t('a plain seat menu has NO Dissolve'), items);
      await closeMenu(pg, phone);

      /* ---- (2) the dialog, then Cancel: opened from ALPHA's page, so a wrong parent would read Alpha ---- */
      await go(A);
      await openTree(pg, phone);
      /* (5) hold the seat read so the button's initial state is observable */
      let release;
      const gate = new Promise((r) => { release = r; });
      await pg.route(new RegExp(`/api/rooms/${B}$`), async (route) => { if (route.request().method() === 'GET') { await gate; } await route.continue(); });
      await clickMore(pg, 'Beta', phone);
      await pg.locator('.rsm-menu .rsm-mi', { hasText: 'Dissolve group' }).first()[phone ? 'tap' : 'click']();
      await sleep(400);
      let d = await dialog(pg);
      ok(!!d && /Beta/.test(d.head ?? ''), t('the dialog opens, titled with Beta'), d?.head);
      const dis = d?.btns.find((b) => b.a === 'dissolve');
      ok(dis?.disabled === true, t('Dissolve is DISABLED while the seat list is loading'), d?.btns);
      ok(/Reading/.test(d?.msg ?? ''), t('...and says it is reading'), d?.msg);
      release();
      await pg.waitForFunction(() => { const b = document.querySelector('.rsm-dscrim [data-a=dissolve]'); return b && !b.disabled; }, null, { timeout: 8000 }).catch(() => {});
      await pg.unroute(new RegExp(`/api/rooms/${B}$`));
      d = await dialog(pg);
      ok(d?.btns.find((b) => b.a === 'dissolve')?.disabled === false, t('Dissolve enables once the seats load'), d?.btns);
      const msg = d?.msg ?? '';
      ok(hs.slice(3, 6).every((h) => msg.includes(`@${h}`)), t('the dialog lists all three Beta seats'), msg);
      ok(new RegExp(`@${hs[3]} \\(lead\\)`).test(msg) && (msg.match(/\(lead\)/g) ?? []).length === 1, t('...the lead marked, once'), msg);
      ok(/return to Base\./.test(msg) && !/Alpha\b/.test(msg), t('...they return to Base (the ROOT), not Alpha'), msg);
      ok(/Nothing is deleted/.test(msg), t('...and "Nothing is deleted"'), msg);
      if (phone) {
        ok(d.btns.every((b) => b.h >= 44), t('dialog buttons are >= 44px'), d.btns);
        ok(d.left >= 0 && d.right <= d.vw && d.top >= 0 && d.bottom <= d.vh, t('the card sits inside the screen'), { l: d.left, r: d.right, t: d.top, b: d.bottom, vw: d.vw, vh: d.vh });
      }
      await pg.locator('.rsm-dscrim [data-a=cancel]')[phone ? 'tap' : 'click']();
      await sleep(400);
      ok((await dialog(pg)) === null, t('Cancel closes the dialog'));
      let bs = await roomState(B);
      ok(bs.room.state === 'open' && live(bs).length === 3, t('...and nothing changed: Beta still open with its 3 seats'), { state: bs.room.state, seats: live(bs).length });

      /* ---- (3) confirm, from inside Beta so the page has to navigate ---- */
      const before = Object.fromEntries(live(await roomState(R)).map((s) => [s.id, s.handle]));
      console.log(`  --    Base seats before: ${Object.values(before).join(',')}`);
      const rootLeadBefore = (await roomState(R)).room.lead_seat;
      const alphaBefore = JSON.stringify(live(await roomState(A)).map((s) => [s.id, s.handle]));
      await go(B);
      await openTree(pg, phone);
      await clickMore(pg, 'Beta', phone);
      await pg.locator('.rsm-menu .rsm-mi', { hasText: 'Dissolve group' }).first()[phone ? 'tap' : 'click']();
      await pg.waitForFunction(() => { const b = document.querySelector('.rsm-dscrim [data-a=dissolve]'); return b && !b.disabled; }, null, { timeout: 8000 });
      await pg.locator('.rsm-dscrim [data-a=dissolve]')[phone ? 'tap' : 'click']();
      await pg.waitForURL((u) => u.toString().includes(`room=${R}`), { timeout: 8000 }).catch(() => {});
      ok(pg.url().includes(`room=${R}`) && !pg.url().includes(`room=${B}`), t('the page navigated from Beta to Base'), pg.url());
      await sleep(1200);
      const rs = await roomState(R); bs = await roomState(B); const as = await roomState(A);
      const now = Object.fromEntries(live(rs).map((s) => [s.id, s.handle]));
      const want = { ...before, ...Object.fromEntries(hs.slice(3, 6).map((h) => [S[h], h])) };
      ok(JSON.stringify(Object.entries(now).sort()) === JSON.stringify(Object.entries(want).sort()), t('Base now holds every Beta seat (same ids and handles) plus its own'), { now: Object.values(now), want: Object.values(want) });
      ok(rs.room.lead_seat === rootLeadBefore && rootLeadBefore === S[hs[0]], t("Base's own lead is unchanged"), rs.room.lead_seat);
      ok(!live(rs).filter((s) => s.id === S[hs[3]]).some((s) => s.is_lead), t('the dissolved lead arrives as an ordinary seat'));
      ok(bs.room.state === 'archived' && live(bs).length === 0, t('Beta is archived with no active seats'), { state: bs.room.state, seats: live(bs).length });
      ok(JSON.stringify(live(as).map((s) => [s.id, s.handle])) === alphaBefore && as.room.state === 'open', t('Alpha is untouched by dissolving Beta'));
      const lines = async (id) => (await api(`/api/rooms/${id}/line?limit=300`)).body;
      const text = (b) => JSON.stringify(b ?? '');
      ok(/dissolved/.test(text(await lines(R))), t('a fact exists in Base'));
      ok(/dissolved into Base/.test(text(await lines(B))), t('a fact exists in Beta'));
      /* the toast now lands on the ROOT page, where the dissolve ran (Owner [ref]) */
      const bt = await pg.waitForFunction(() => document.querySelector('.rm-toast')?.textContent || null, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => null);
      ok(/Beta dissolved: 3 seats returned to Base\. History kept\./.test(bt ?? ''), t('the confirmation toast is visible on Base after the hop'), bt);
      ok((await pg.evaluate(() => sessionStorage.getItem('hwb.room.dissolve.pending'))) === null, t('the pending key is consumed'));
      await pg.reload({ waitUntil: 'domcontentloaded' }); await sleep(1500);
      ok(!(await pg.evaluate(() => /dissolved/.test(document.querySelector('.rm-toast')?.textContent ?? ''))), t('a reload of Base does not re-run it (no second toast)'));
      /* a STALE key (> 60 s) does nothing and is removed */
      await pg.evaluate(([g, r]) => sessionStorage.setItem('hwb.room.dissolve.pending', JSON.stringify({ groupId: g, rootId: r, name: 'Gamma', rootName: 'Base', at: Date.now() - 61_000 })), [G, R]);
      await pg.reload({ waitUntil: 'domcontentloaded' }); await sleep(1800);
      ok((await roomState(G)).room.state === 'open' && (await pg.evaluate(() => sessionStorage.getItem('hwb.room.dissolve.pending'))) === null, t('a stale key (61 s) dissolves nothing and is removed'));
      /* a key naming ANOTHER root is left alone and does nothing */
      await pg.evaluate(([g]) => sessionStorage.setItem('hwb.room.dissolve.pending', JSON.stringify({ groupId: g, rootId: 'some-other-root', name: 'Gamma', rootName: 'X', at: Date.now() })), [G]);
      await pg.reload({ waitUntil: 'domcontentloaded' }); await sleep(1800);
      ok((await roomState(G)).room.state === 'open', t('a key for a different root does nothing'));
      await pg.evaluate(() => sessionStorage.removeItem('hwb.room.dissolve.pending'));
      /* an engine refusal on the hop: error toast, no dialog, key gone, and a reload does not repeat it */
      await pg.evaluate(([g, r]) => sessionStorage.setItem('hwb.room.dissolve.pending', JSON.stringify({ groupId: g, rootId: r, name: 'Beta', rootName: 'Base', at: Date.now() })), [B, R]);
      await pg.reload({ waitUntil: 'domcontentloaded' });
      const et = await pg.waitForFunction(() => document.querySelector('.rm-toast.err')?.textContent || null, null, { timeout: 6000 }).then((h) => h.jsonValue()).catch(() => null);
      ok(/Could not dissolve Beta: .*archived/.test(et ?? '') && (await dialog(pg)) === null, t('a refused dissolve on the hop is an error toast, dialog not reopened'), et);
      ok((await pg.evaluate(() => sessionStorage.getItem('hwb.room.dissolve.pending'))) === null, t('...and the key is gone'));
      await pg.reload({ waitUntil: 'domcontentloaded' }); await sleep(1500);
      ok((await pg.$('.rm-toast.err')) === null, t('...a second load shows nothing'));
      /* the toast, from a page that does not navigate: dissolve Alpha from Base */
      await go(R);
      await openTree(pg, phone);
      await clickMore(pg, 'Alpha', phone);
      await pg.locator('.rsm-menu .rsm-mi', { hasText: 'Dissolve group' }).first()[phone ? 'tap' : 'click']();
      await pg.waitForFunction(() => { const b = document.querySelector('.rsm-dscrim [data-a=dissolve]'); return b && !b.disabled; }, null, { timeout: 8000 });
      ok(/returns to Base\./.test((await dialog(pg))?.msg ?? ''), t('opened from the main room itself, the dialog still names Base'), (await dialog(pg))?.msg);
      await pg.locator('.rsm-dscrim [data-a=dissolve]')[phone ? 'tap' : 'click']();
      await sleep(900);
      const tt = await pg.evaluate(() => document.querySelector('.rm-toast')?.textContent ?? null);
      ok(/Alpha dissolved: 1 seat returned to Base\. History kept\./.test(tt ?? ''), t('from the root rail the direct path still works: toast, no navigation'), tt);
      ok(pg.url().includes(`room=${R}`) && (await roomState(A)).room.state === 'archived', t('...Alpha archived through the UI'));

      /* ---- (6) refusal inline: page still on stale Beta menu -> a second dissolve ---- */
      await go(R);
      await openTree(pg, phone);
      /* Beta is archived so its row left the tree; make the engine refuse by dissolving Alpha's own nested case: open the dialog on
         Alpha, dissolve Alpha via the API behind the dialog's back, then press Dissolve -> the engine answers 409 */
      await clickMore(pg, 'Gamma', phone);
      await pg.locator('.rsm-menu .rsm-mi', { hasText: 'Dissolve group' }).first()[phone ? 'tap' : 'click']();
      await pg.waitForFunction(() => { const b = document.querySelector('.rsm-dscrim [data-a=dissolve]'); return b && !b.disabled; }, null, { timeout: 8000 });
      const pre = await api(`/api/rooms/${G}/dissolve`, 'POST', {});
      ok(pre.status === 200, t('(Gamma dissolved behind the open dialog)'), pre.status);
      await pg.locator('.rsm-dscrim [data-a=dissolve]')[phone ? 'tap' : 'click']();
      await sleep(900);
      d = await dialog(pg);
      ok(!!d && d.err.length > 0 && /archived|closed|open/i.test(d.err), t('the second dissolve is refused and the dialog shows the engine message inline'), d?.err);
      ok(!!d && d.btns.find((b) => b.a === 'dissolve')?.disabled === false, t('...and the button is usable again'));
      await pg.locator('.rsm-dscrim [data-a=cancel]')[phone ? 'tap' : 'click']();
      ok(perr.length === 0, t('no page errors'), perr.slice(0, 3));
      await ctx.close();
    }
  }
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  for (const b of browsers) { await b.close().catch(() => {}); }
  engine?.kill('SIGKILL');
  await sleep(300);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\nFAIL ${failures}` : '\nPASS');
process.exit(failures ? 1 : 0);
