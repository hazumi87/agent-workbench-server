/* THE SEAT MENU'S CLOSE WINDOW (Owner 2026-09-28: "even within the room I can
 * close the user's window if I want").
 *
 *   node test/room-close-window.probe.mjs
 *
 * What only a browser can prove, on a REAL pty (a live scratch broker):
 *   - a live seat nobody is viewing: Close window DISABLED, "No window open"
 *   - the room page (context 1) framing a seat: the engine does not count it
 *     as a window (windows 0), but THIS page's own frame enables the item
 *     (Owner 2026-09-29 [perf/poll-traffic]; it used to be disabled)
 *   - two solo pages of that session (contexts 2 and 3): windows 2, and the
 *     item sits right after Open window, ENABLED, "keeps running"
 *   - clicking it: POST .../close-window; every solo page gets the push
 *     (pane.close-window, seen on its websocket). Solo page 2 closes itself;
 *     solo page 3 has window.close() stubbed to a no-op (a browser tab the user
 *     opened, which a script may not close) and so shows "Window closed" with
 *     Reopen and lets go of its socket
 *   - the room page KEEPS its view (its frame got no push); the session is
 *     live, not ended, and never armed for the reaper; the seat reads windows
 *     0 and the item is disabled again; the toast says "Closed @agent's
 *     window. The session keeps running."
 *   - Reopen reattaches the same session (windows 1 again)
 *   - OWN FRAME ONLY: that window gone, the room page's frame is the only view;
 *     Close window closes IT: the frame is removed, the room line comes back,
 *     the session is live and parked (attached false), never armed for the
 *     reaper
 * The parked-with-no-viewer case is room-close-window.test.mjs.
 *
 * A PROBE, not in `npm test`. OWN scratch engine P(198), LIVE scratch broker
 * P(199), temp table, childEnv() scrubbed, fabric + NATS off, no desktop.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, scratchShell, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(198);
const BROKER_PORT = P(199);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'probe-room-close-window-token';
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] });

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) { return v; }
    await sleep(step);
  }
}

let cookieP = null;
const userCookie = () => (cookieP ??= windowCookie(BASE, TOKEN));
async function call(path, opts = {}) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
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

/** Spawn a pane's pty through a bare socket, then let go (it parks). */
async function spawnPane(paneid, recipeId) {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
  ws.on('error', () => {});
  await new Promise((r) => ws.once('open', r));
  const ready = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 12000);
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.type === 'pane.ready' && m.paneid === paneid) { clearTimeout(t); resolve(true); }
      } catch { /* not json */ }
    });
  });
  ws.send(JSON.stringify({ type: 'attach', paneid, recipe: recipeId }));
  const got = await ready;
  ws.send(JSON.stringify({ type: 'park', paneid })); // no reaper while the probe runs
  await sleep(100);
  ws.close();
  return got;
}

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, BROKER_PORT]) {
  await assertFree(p, 'room-close-window.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-closewin-probe-'));
const dbPath = join(tmpDir, 'mapping.db');
const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
let broker = null;
let engine = null;
let browser = null;
let log = '';
const panes = [];
const up = async (url) => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) { return true; }
    await sleep(250);
  }
  return false;
};
const kill = async (proc) => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const gone = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([gone, sleep(3000)]);
  }
};

try {
  broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], {
    cwd: REPO_ROOT,
    env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
  });
  broker.stdout.on('data', (d) => (log += d));
  broker.stderr.on('data', (d) => (log += d));
  if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) { throw new Error(`broker did not come up\n${log}`); }
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: HOST,
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_DESKTOP: 'none',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_TARGETS: TARGETS,
    }),
  });
  engine.stdout.on('data', (d) => (log += d));
  engine.stderr.on('data', (d) => (log += d));
  const isUp = await up(`${BASE}/health`);
  ok(isUp, `scratch engine is serving on ${PORT}`);
  if (!isUp) { throw new Error(`engine did not come up\n${log.slice(-800)}`); }

  /* two real ptys (bash; cli-manager recipes launch nothing), both parked */
  const recipes = [];
  for (const [name, agent] of [['Probe Agent', 'probe-agent'], ['Probe Idle', 'probe-idle']]) {
    const recipe = (await call('/api/recipes', { json: { name, target: 'local', projectDir: tmpDir, vendor: 'cli-manager', agent } })).body?.recipe;
    recipes.push(recipe);
    panes.push(`recipe:${recipe?.id}`);
  }
  const [A, B] = panes;
  ok(await spawnPane(A, recipes[0].id), 'setup: pane A has a real pty');
  ok(await spawnPane(B, recipes[1].id), 'setup: pane B has a real pty');
  const room = (await call('/api/rooms', { json: { name: 'Close Window Probe' } })).body;
  const seatA = (await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipes[0].id, handle: 'agent', policy: 'persistent', occupant: A } })).body?.seat;
  const seatB = (await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipes[1].id, handle: 'idle', policy: 'persistent', occupant: B } })).body?.seat;
  ok(!!(seatA?.id && seatB?.id), 'setup: a room with @agent (pane A) and @idle (pane B)');
  const seatNow = async (id) => (await call(`/api/rooms/${room.id}`)).body?.seats?.find((s) => s.id === id);

  browser = await chromium.launch({ headless: true });
  const login = async (ctx) => {
    const cookie = await userCookie();
    const [name, value] = cookie.split(';')[0].split('=');
    await ctx.addCookies([{ name, value, url: BASE }]);
  };
  /* context 1: the room page */
  const roomCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await login(roomCtx);
  const page = await roomCtx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/room.html?room=${room.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .seat[data-handle="agent"]');

  /* contexts 2 and 3: two solo pages of @agent's session. Page 3 cannot close
     itself (window.close is a no-op, as for a tab the user opened). */
  const soloUrl = `${BASE}/solo.html?recipe=${encodeURIComponent(recipes[0].id)}&pane=${encodeURIComponent(A)}`;
  /* Page 2 is OPENED BY SCRIPT (window.open from a launcher page, as the
     manager's Open window does), which is what lets window.close() work. */
  const openSolo = async (stubClose) => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    await login(ctx);
    const got = { push: 0, closed: false, errors: [] };
    const watch = (p) => {
      p.on('pageerror', (e) => got.errors.push(String(e)));
      p.on('close', () => { got.closed = true; });
      p.on('websocket', (ws) => {
        ws.on('framereceived', (f) => {
          if (typeof f.payload === 'string' && f.payload.includes('"pane.close-window"')) { got.push += 1; }
        });
      });
    };
    if (stubClose) {
      const p = await ctx.newPage();
      watch(p);
      await p.addInitScript(() => {
        window.close = () => { window.__closeCalled = (window.__closeCalled ?? 0) + 1; };
      });
      await p.goto(soloUrl, { waitUntil: 'domcontentloaded' });
      return { p, got };
    }
    const launcher = await ctx.newPage();
    await launcher.goto(`${BASE}/health`);
    let popup = null;
    ctx.on('page', (p) => { if (p !== launcher && !popup) { popup = p; watch(p); } });
    await launcher.evaluate((u) => { window.open(u, '_blank'); }, soloUrl);
    await until(() => popup, 5000);
    await popup.waitForLoadState('domcontentloaded');
    return { p: popup, got };
  };
  const row = (h) => `#roster .seat[data-handle="${h}"]`;
  const menu = () => page.evaluate(() => {
    const m = document.querySelector('.rsm-menu');
    return m ? [...m.querySelectorAll('.rsm-mi')].map((b) => ({
      a: b.dataset.a, label: [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''),
      off: b.getAttribute('aria-disabled') === 'true', why: b.title || null, sub: b.querySelector('.rsm-sub')?.textContent ?? null,
    })) : null;
  });

  /* 1. a live seat nobody is viewing: disabled */
  await page.click(`${row('idle')} .seat-handle`, { button: 'right' });
  let m = await menu();
  const idleClose = m?.find((i) => i.a === 'closew');
  ok(idleClose && idleClose.off && idleClose.why === 'No window open', '@idle (live, parked): Close window DISABLED, "No window open"', idleClose);
  await page.keyboard.press('Escape');

  /* the room page VIEWS @agent (its own framed solo, inroom=1): not a window */
  await page.click(`${row('agent')} .seat-handle`);
  const framedIn = await until(() => page.evaluate(() => document.querySelectorAll('#seatView iframe').length === 1), 6000);
  ok(framedIn, 'selecting @agent frames its session in the room page');
  const frameOnly = await until(async () => {
    const o = (await seatNow(seatA.id))?.occupant;
    return o?.attached === true ? o : null;
  }, 8000);
  ok(frameOnly && frameOnly.windows === 0, 'only the room frame views it: attached, windows 0', frameOnly && { attached: frameOnly.attached, windows: frameOnly.windows });
  await sleep(2800); // one roster poll
  await page.click(`${row('agent')} .seat-handle`, { button: 'right' });
  m = await menu();
  ok(m && m[1]?.a === 'closew' && !m[1].off, '...and THIS page\'s own frame ENABLES its Close window (Owner 2026-09-29)', m?.[1]);
  await page.keyboard.press('Escape');

  const s2 = await openSolo(false);
  const s3 = await openSolo(true);
  ok(!!(await until(async () => (await seatNow(seatA.id))?.occupant?.windows === 2, 8000)), 'the two solo pages attach: @agent reads windows 2');
  await sleep(2800); // one roster poll

  /* 2. the seat with windows: enabled, right after Open window */
  await page.click(`${row('agent')} .seat-handle`, { button: 'right' });
  m = await menu();
  ok(m && m[0]?.a === 'open' && m[1]?.a === 'closew' && m[1]?.label === 'Close window', 'Close window sits right after Open window', m?.map((i) => i.label));
  ok(m && !m[1].off && m[1].sub === 'keeps running', '@agent (windows open): Close window ENABLED, "keeps running"', m?.[1]);

  let req = null;
  page.on('request', (r) => { if (r.url().endsWith(`/seats/${seatA.id}/close-window`)) { req = { method: r.method() }; } });
  await page.click('.rsm-mi[data-a="closew"]');
  await page.waitForSelector('.rm-toast', { timeout: 8000 }).catch(() => {});
  const toast = await page.evaluate(() => document.querySelector('.rm-toast .tx')?.textContent ?? null);
  ok(req?.method === 'POST', 'it POSTs .../seats/:id/close-window', req);
  ok(toast === "Closed @agent's window. The session keeps running.", 'a toast: "Closed @agent\'s window. The session keeps running."', toast);

  /* the solo pages */
  ok(!!(await until(() => s2.got.push > 0 || s2.got.closed, 5000)), `solo page 2 got the pane.close-window push (push frames ${s2.got.push}, closed ${s2.got.closed})`);
  ok(await until(() => s2.got.closed, 3000), 'solo page 2 (opened by script) CLOSED itself');
  ok(s3.got.push === 1, 'solo page 3 got the push once', s3.got.push);
  await sleep(800);
  const roomSide = await page.evaluate(() => ({
    frames: document.querySelectorAll('#seatView iframe').length,
    seatView: !document.getElementById('seatView').hidden,
    line: !document.getElementById('roomLine').hidden,
  }));
  ok(roomSide.frames === 1 && roomSide.seatView && !roomSide.line, 'the room page KEEPS its view of @agent', roomSide);
  const inFrame = page.frames().find((f) => /inroom=1/.test(f.url()));
  const frameState = inFrame ? await inFrame.evaluate(() => ({ pushes: window.__closeWindowPushes ?? 0, closedCard: !!document.querySelector('.pane-closed') })) : null;
  ok(frameState && frameState.pushes === 0 && !frameState.closedCard, '...its frame got no push and shows no "Window closed"', frameState);
  const s3state = await until(async () => {
    const v = await s3.p.evaluate(() => {
      const c = document.querySelector('.pane-closed');
      return c && !c.hidden ? {
        who: c.querySelector('.pane-paused-who')?.textContent, reopen: c.querySelector('[data-act="reopen"]')?.textContent,
        pushes: window.__closeWindowPushes ?? 0, closeCalled: window.__closeCalled ?? 0,
        paused: document.querySelector('.pane-paused:not(.pane-closed)')?.hidden ?? true,
        sub: c.querySelector('.pane-paused-sub')?.textContent,
        btn: (() => {
          const b = c.querySelector('[data-act="reopen"]');
          const cs = getComputedStyle(b);
          const t = document.createElement('span');
          document.body.append(t);
          t.style.color = 'var(--teal)';
          const teal = getComputedStyle(t).color;
          t.style.background = 'var(--ghost-fill)';
          const ghost = getComputedStyle(t).backgroundColor;
          t.remove();
          return { cls: b.className, border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, teal, ghost };
        })(),
        frame: (() => { const k = c.querySelector('.pane-paused-card'); const cs = getComputedStyle(k); return `${cs.borderTopWidth} ${cs.borderTopStyle}`; })(),
        pausedFrame: (() => { const k = document.querySelector('.pane-paused:not(.pane-closed) .pane-paused-card'); if (!k) { return null; } const cs = getComputedStyle(k); return `${cs.borderTopWidth} ${cs.borderTopStyle}`; })(),
      } : null;
    });
    return v;
  }, 4000);
  ok(s3state && s3state.who === 'Window closed' && s3state.reopen === 'Reopen', 'solo page 3 (cannot close itself): "Window closed" with Reopen', s3state);
  ok(s3state && s3state.closeCalled >= 1 && s3state.pushes === 1 && s3state.paused, '...after it TRIED window.close(); the control prompt is not shown over it', s3state);
  /* the design system r23 review: the copy, the teal-outline .btn (not the browser's
     grey filled button), the paused card's own frame */
  ok(s3state && s3state.sub === 'This window was closed from a room. The session keeps running. Reopen it here or from the room.', '...its copy: "The session keeps running. Reopen it here or from the room." (no "parked in the broker")', s3state?.sub);
  ok(s3state && /\bbtn\b/.test(s3state.btn.cls) && s3state.btn.border === `1px solid ${s3state.btn.teal}` && s3state.btn.radius === '8px' && s3state.btn.bg === s3state.btn.ghost,
    '...Reopen is the teal-outline .btn (1px teal border, 8px corners, the ghost fill, not the browser grey)', s3state?.btn);
  ok(s3state && s3state.frame === '2px solid' && (s3state.pausedFrame === null || s3state.pausedFrame === s3state.frame), '...on the paused card\'s frame (the 2px ring)', { frame: s3state?.frame, paused: s3state?.pausedFrame });

  /* the session: live (the room frame still views it), not ended */
  const after = await until(async () => {
    const s = await seatNow(seatA.id);
    return s?.occupant?.windows === 0 ? s : null;
  }, 5000);
  ok(after && after.status === 'live' && after.occupant.state === 'live' && after.occupant.attached === true,
    'the seat reads live, windows 0, still attached by the room frame', after && { status: after.status, occ: after.occupant });
  const tbl = (await call('/api/table')).body?.sessions ?? [];
  ok(tbl.find((s) => s.paneid === A)?.state === 'live', '/api/table: pane A still live (not Disconnect, not End)', tbl.find((s) => s.paneid === A)?.state);
  const armed = ((await call('/api/diag/activity')).body?.reaper?.armed ?? []).map((a) => a.paneid);
  ok(!armed.includes(A), '...and not armed for the close-grace reaper', armed);
  await sleep(2800); // one roster poll
  await page.click(`${row('agent')} .seat-handle`, { button: 'right' });
  m = await menu();
  ok(m && m[1] && !m[1].off, '...and its Close window stays enabled (this page\'s own frame still views it)', m?.[1]);
  await page.keyboard.press('Escape');

  /* Reopen: the same session comes back */
  await s3.p.click('.pane-closed [data-act="reopen"]');
  ok(!!(await until(async () => (await seatNow(seatA.id))?.occupant?.windows === 1, 8000)), 'Reopen reattaches the same session (@agent windows 1 again)');
  ok((await call('/api/table')).body?.sessions?.find((s) => s.paneid === A)?.state === 'live', '...still the same live pane');

  /* OWN FRAME ONLY: the window goes; this room page's frame is the only view */
  await s3.p.close();
  ok(!!(await until(async () => (await seatNow(seatA.id))?.occupant?.windows === 0, 8000)), 'solo page 3 closed: @agent windows 0 again (the room frame still views it)');
  await sleep(2800); // one roster poll
  await page.click(`${row('agent')} .seat-handle`, { button: 'right' });
  m = await menu();
  ok(m && m[1]?.a === 'closew' && !m[1].off, 'own frame only: Close window ENABLED', m?.[1]);
  await page.click('.rsm-mi[data-a="closew"]');
  const own = await until(async () => {
    const v = await page.evaluate(() => ({
      frames: document.querySelectorAll('#seatView iframe').length,
      seatView: !document.getElementById('seatView').hidden,
      line: !document.getElementById('roomLine').hidden,
      toast: document.querySelector('.rm-toast .tx')?.textContent ?? null,
    }));
    return v.frames === 0 ? v : null;
  }, 5000);
  ok(own && own.frames === 0 && !own.seatView && own.line, '...closing it drops the room page\'s frame and returns to the room line', own);
  ok(own && own.toast === "Closed @agent's window. The session keeps running.", '...with the same toast', own?.toast);
  const parked = await until(async () => {
    const s = await seatNow(seatA.id);
    return s?.occupant?.attached === false ? s : null;
  }, 5000);
  ok(parked && parked.status === 'parked' && parked.occupant.state === 'live', '...the session is live and PARKED (seat status parked, nothing views it)', parked && { status: parked.status, occ: parked.occupant });
  const armed2 = ((await call('/api/diag/activity')).body?.reaper?.armed ?? []).map((a) => a.paneid);
  ok(!armed2.includes(A), '...and never armed for the close-grace reaper', armed2);

  ok(errors.length === 0 && s3.got.errors.length === 0, 'no page errors', [...errors, ...s3.got.errors].slice(0, 3));
} catch (e) {
  failures += 1;
  console.log(` FAIL  threw: ${e?.stack ?? e}`);
  console.log(`--- log tail ---\n${log.slice(-2000)}`);
} finally {
  await browser?.close().catch(() => {});
  await kill(engine);
  await kill(broker);
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
