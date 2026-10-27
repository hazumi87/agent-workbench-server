/* LINKS IN ROOM LINES + THE REPLY PREFILL (Owner 2026-09-28), the page's half.
 *
 *   node test/room-links.probe.mjs
 *
 * What only a browser can prove (desktop 1280x800, then phone 390x844):
 *   - http(s) URLs in a line body are <a> with the right href; trailing
 *     punctuation and an unmatched ) stay outside; a URL over 80 characters
 *     shows 79 + an ellipsis with the full URL in the title; @mentions still
 *     tone and never inside a URL; built from text (no markup from the body);
 *   - a click opens through openExternal and does NOT start a reply or open
 *     the line menu: window.open(url, '_blank', 'noopener,noreferrer') in a
 *     plain browser; {cmd:'openExternal', url} to window.chrome.webview on a
 *     top-level page in the native host;
 *   - inside the shell: a tab hands the link up {hwbOpenExternal} and the
 *     shell posts it to the host (or opens it without one); a frame the shell
 *     did not make is ignored, and so is a non-http(s) url;
 *   - the reply prefill: a seat's line -> "@handle " with the caret after it;
 *     your own line / a fact / a voice line -> nothing; an existing leading
 *     @address is kept; text without one gets the prefix in front; a cancel
 *     (x or Esc) removes an UNEDITED prefill only; the draft holds the text.
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(210), DEAD broker P(211),
 * temp table seeded through the store: never Owner's data, childEnv() scrubbed,
 * fabric + NATS off.
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
const PORT = P(210);
const DEAD_BROKER_PORT = P(211);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-links-token';
const ELLIPSIS = String.fromCharCode(0x2026);

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
  const headers = roomUserWrite(path, method, opts.json) || opts.user ? { cookie: await userCookie() } : { authorization: `Bearer ${TOKEN}` };
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
  await assertFree(p, 'room-links.probe.mjs');
}

/* Every frame: window.open is recorded, never opens. `wv=1` in the TOP page's
   query stands the native host's WebView2 up on the top document only (the
   host listens there and nowhere else). */
const INIT = () => {
  window.__opened = [];
  window.__posted = [];
  window.open = (...a) => { window.__opened.push(a); return null; };
  if (window.top === window && new URLSearchParams(location.search).get('wv') === '1') {
    window.chrome = window.chrome || {};
    /* the shell's own host bridge (hwb-host.js) posts its window verbs here
       too: the probe reads only {cmd:'openExternal'} */
    window.chrome.webview = {
      postMessage: (m) => { if (m && m.cmd === 'openExternal') { window.__posted.push(JSON.parse(JSON.stringify(m))); } },
      addEventListener() {},
      removeEventListener() {},
    };
  }
};

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-links-'));
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
  const recipe = (id, name, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: [recipe('rec-lead', 'Leader', 'leader', '#1f5fbf'), recipe('rec-buddy', 'Buddy', 'buddy', '#ba08b4')] });
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
      HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'scratch'),
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

  const LEAD = 'recipe:rec-lead';
  const BUDDY = 'recipe:rec-buddy';
  const live = (paneid, rid, agent) => ({ paneid, recipe_id: rid, vendor: 'claude-code', agent, state: 'live' });
  const post = await seed({
    sessions: [live(LEAD, 'rec-lead', 'leader'), live(BUDDY, 'rec-buddy', 'buddy')],
    rooms: [{ name: 'Links Probe', seats: [{ handle: 'leader', recipe_id: 'rec-lead', occupant: LEAD }, { handle: 'buddy', recipe_id: 'rec-buddy', occupant: BUDDY }] }],
  });
  const R = post.rooms[0].id;
  const BUDDY_SEAT = post.rooms[0].seats.buddy;
  const LINE = `/api/rooms/${R}/line`;

  const LONG = `https://example.com/deep/${'a'.repeat(120)}?q=1`;
  const WIKI = 'https://en.wikipedia.org/wiki/Foo_(bar)';
  const TEXT = `see https://example.com/a. and (docs ${WIKI}) or (https://x.io/p), also "https://q.io/y"! then ${LONG}; <b>not markup</b> https://medium.com/@someone/post @leader`;
  const links = (await call(LINE, { json: { text: TEXT, from: { paneid: BUDDY } } })).body.entries[0];
  const leadLine = (await call(LINE, { json: { text: 'lead says hi', from: { paneid: LEAD } } })).body.entries[0];
  const buddyLine = (await call(LINE, { json: { text: 'buddy plain line', from: { paneid: BUDDY } } })).body.entries[0];
  const mine = (await call(LINE, { json: { text: 'my own line https://mine.io/x' } })).body.entries[0];
  const facts = (await call(`${LINE}?kind=fact&limit=5`)).body.entries;
  ok(links && leadLine && buddyLine && mine && facts.length > 0, 'setup: the lines are posted and the room has a fact', facts.length);
  const fact = facts[facts.length - 1];
  /* a voice line from @buddy, shown to the page only (the room voice path is
     its own probe): appended to the page's first read of the line */
  const VOICE_ID = mine.id + 50000;
  const voiceEntry = { id: VOICE_ID, room_id: R, ts: new Date().toISOString(), kind: 'voice', author: 'buddy', author_seat: BUDDY_SEAT, target: null, target_seat: null, body: 'spoken by buddy', meta: JSON.stringify({ dir: 'out', kind: 'result', spoken: true }) };

  browser = await chromium.launch({ headless: true });
  const WANT_HREFS = ['https://example.com/a', WIKI, 'https://x.io/p', 'https://q.io/y', LONG, 'https://medium.com/@someone/post'];

  for (const vp of [{ name: 'desktop', width: 1280, height: 800, touch: false }, { name: 'phone', width: 390, height: 844, touch: true }]) {
    console.log(`--- ${vp.name} ${vp.width}x${vp.height}`);
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
    await context.addInitScript(INIT);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      const f = document.querySelector('form');
      (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
    }, TOKEN);
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
    await call(`/api/rooms/${R}/draft`, { method: 'PUT', json: { text: '', reply_to: null }, user: true });
    const ROOM = `${BASE}/room.html?room=${R}`;
    const li = (id) => `#line li[data-id="${id}"]`;
    const openRoom = async (q = '') => {
      await page.goto(ROOM + q, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`${li(mine.id)} .entry-body`);
      await sleep(400);
    };
    const activate = async (sel) => {
      if (vp.touch) { await page.tap(sel); } else { await page.click(sel); }
    };
    await openRoom();

    /* ---- 1. the links ---- */
    const got = await page.evaluate((s) => {
      const body = document.querySelector(s + ' .entry-body');
      const as = [...body.querySelectorAll('a.rl-link')];
      return {
        hrefs: as.map((a) => a.getAttribute('href')), texts: as.map((a) => a.textContent), titles: as.map((a) => a.title),
        targets: as.map((a) => `${a.target}|${a.rel}`),
        after: as.map((a) => a.nextSibling?.nodeType === 3 ? a.nextSibling.textContent.slice(0, 2) : a.nextSibling?.className ?? null),
        mentions: [...body.querySelectorAll('.mention')].map((m) => [m.textContent, !!m.closest('a')]),
        bold: body.querySelectorAll('b').length, raw: body.textContent.includes('<b>not markup</b>'),
        color: as[0] ? getComputedStyle(as[0]).color : null, deco: as[0] ? getComputedStyle(as[0]).textDecorationLine : null,
      };
    }, li(links.id));
    ok(JSON.stringify(got.hrefs) === JSON.stringify(WANT_HREFS), 'every http(s) URL is an <a> with its href', got.hrefs);
    ok(JSON.stringify(got.after.slice(0, 5)) === JSON.stringify(['. ', ') ', '),', '"!', '; ']), 'trailing . ) ), "! ; stay OUTSIDE the link (a matched paren stays in)', got.after);
    ok(got.texts[4].length === 80 && got.texts[4].endsWith(ELLIPSIS) && got.texts[4].startsWith(LONG.slice(0, 79)) && got.titles[4] === LONG, 'a long URL shows 79 + an ellipsis, the full URL in the title', [got.texts[4].length, got.titles[4] === LONG]);
    ok(got.texts[0] === 'https://example.com/a' && got.titles[0] === 'https://example.com/a', 'a short URL shows whole', got.texts[0]);
    ok(got.targets.every((t) => t === '_blank|noopener noreferrer'), '...each a new-window link, no opener', got.targets);
    ok(JSON.stringify(got.mentions) === JSON.stringify([['@leader', false]]), '@mentions still tone, never inside a URL', got.mentions);
    ok(got.bold === 0 && got.raw, 'the body is text: markup in it stays text', { bold: got.bold, raw: got.raw });
    ok(got.color && got.deco === 'none', 'the link is in the accent, no underline at rest', [got.color, got.deco]);
    const mineHref = await page.evaluate((s) => document.querySelector(s + ' .entry-body a.rl-link')?.getAttribute('href') ?? null, li(mine.id));
    ok(mineHref === 'https://mine.io/x', 'your own line links too', mineHref);
    if (!vp.touch) {
      await page.hover(`${li(links.id)} a.rl-link >> nth=0`);
      const hov = await page.evaluate((s) => getComputedStyle(document.querySelector(s + ' a.rl-link')).textDecorationLine, li(links.id));
      ok(hov === 'underline', 'hover underlines it', hov);
      await page.evaluate((s) => document.querySelector(s + ' a.rl-link').focus(), li(links.id));
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const foc = await page.evaluate(() => {
        const a = document.activeElement;
        const cs = getComputedStyle(a);
        return { link: a.classList.contains('rl-link'), outline: `${cs.outlineStyle} ${cs.outlineWidth}`, deco: cs.textDecorationLine };
      });
      ok(foc.link && foc.outline === 'solid 2px' && foc.deco === 'underline', 'keyboard focus: a visible ring + the underline', foc);
      await page.mouse.move(5, 5);
    }

    /* ---- 2. a click opens it, and nothing else ---- */
    await activate(`${li(links.id)} a.rl-link >> nth=0`);
    await sleep(300);
    let st = await page.evaluate(() => ({ opened: window.__opened, posted: window.__posted, chip: !!document.querySelector('#attTray > .rp-chip'), menu: !!document.querySelector('.rsm-menu'), input: document.querySelector('#input').value, url: location.href }));
    ok(JSON.stringify(st.opened) === JSON.stringify([['https://example.com/a', '_blank', 'noopener,noreferrer']]), 'plain browser: window.open(url, _blank, noopener,noreferrer)', st.opened);
    ok(!st.chip && !st.menu && st.input === '' && st.url.startsWith(ROOM), '...and no reply, no menu, no navigation', st);

    await openRoom('&wv=1');
    await activate(`${li(links.id)} a.rl-link >> nth=1`);
    await sleep(300);
    st = await page.evaluate(() => ({ opened: window.__opened, posted: window.__posted, chip: !!document.querySelector('#attTray > .rp-chip') }));
    ok(JSON.stringify(st.posted) === JSON.stringify([{ cmd: 'openExternal', url: WIKI }]) && st.opened.length === 0 && !st.chip, 'native host, top-level page: {cmd:openExternal, url} to the WebView, no window.open', st);
    const refused = await page.evaluate(async () => {
      const m = await import('/open-external.mjs');
      const r = [m.openExternal('javascript:alert(1)'), m.openExternal('file:///etc/passwd'), m.openExternal('not a url')];
      return { r, posted: window.__posted.length, opened: window.__opened.length };
    });
    ok(JSON.stringify(refused) === JSON.stringify({ r: [false, false, false], posted: 1, opened: 0 }), 'openExternal refuses anything but http(s)', refused);

    /* ---- 3. inside the shell ---- */
    const shellUrl = (wv) => `${BASE}/app/shell.html?kind=manager&debug=1${wv ? '&wv=1' : ''}&tabs=${encodeURIComponent(`/room.html?room=${R}`)}`;
    const roomFrame = async () => {
      for (let i = 0; i < 60; i += 1) {
        const f = page.frames().find((x) => x.url().includes('/room.html'));
        if (f && await f.$(`${li(links.id)} a.rl-link`).catch(() => null)) { return f; }
        await sleep(200);
      }
      return null;
    };
    await page.goto(shellUrl(true), { waitUntil: 'domcontentloaded' });
    let rf = await roomFrame();
    ok(!!rf, 'setup: the room page loads as a shell tab');
    if (rf) {
      await (vp.touch ? rf.tap(`${li(links.id)} a.rl-link >> nth=2`) : rf.click(`${li(links.id)} a.rl-link >> nth=2`));
      await sleep(400);
      const top = await page.evaluate(() => ({ posted: window.__posted, opened: window.__opened }));
      const inner = await rf.evaluate(() => ({ opened: window.__opened, posted: window.__posted, chip: !!document.querySelector('#attTray > .rp-chip') }));
      ok(JSON.stringify(top.posted) === JSON.stringify([{ cmd: 'openExternal', url: 'https://x.io/p' }]) && top.opened.length === 0, 'a shell tab: the SHELL posts {cmd:openExternal} to the host', top);
      ok(inner.opened.length === 0 && inner.posted.length === 0 && !inner.chip, '...the tab itself opens nothing and starts no reply', inner);
      /* a frame the shell did not make: nested in the tab, and one bolted onto
         the shell. The post must be made by the frame's OWN script (a message's
         source is the caller's window), hence an inline script in srcdoc. */
      const bolt = (script) => new Promise((res) => {
        const f = document.createElement('iframe');
        f.srcdoc = `<p>frame</p><script>${script}</` + 'script>';
        f.onload = () => res();
        document.body.append(f);
      });
      const listen = () => {
        window.__seen = [];
        window.addEventListener('message', (e) => { if (e.data && e.data.hwbOpenExternal) { window.__seen.push(e.data.hwbOpenExternal); } });
      };
      await rf.evaluate(listen);
      await page.evaluate(listen);
      await rf.evaluate(bolt, "parent.postMessage({ hwbOpenExternal: 'https://evil.example/a' }, '*'); top.postMessage({ hwbOpenExternal: 'https://evil.example/b' }, '*');");
      await page.evaluate(bolt, "parent.postMessage({ hwbOpenExternal: 'https://evil.example/c' }, '*');");
      await rf.evaluate(() => window.parent.postMessage({ hwbOpenExternal: 'javascript:alert(1)' }, '*'));
      await sleep(400);
      const after = await page.evaluate(() => ({ posted: window.__posted.length, opened: window.__opened.length, urls: window.__posted.map((m) => m.url) }));
      const innerAfter = await rf.evaluate(() => ({ posted: window.__posted.length, opened: window.__opened.length, seen: window.__seen }));
      const topSeen = await page.evaluate(() => window.__seen);
      ok(innerAfter.seen.includes('https://evil.example/a') && topSeen.includes('https://evil.example/b') && topSeen.includes('https://evil.example/c') && topSeen.includes('javascript:alert(1)'),
        'control: the stray frames\' messages DID arrive', { inner: innerAfter.seen, top: topSeen });
      ok(after.posted === 1 && after.opened === 0 && innerAfter.opened === 0, 'a frame the shell did not make is ignored (nested in a tab, or stray); a non-http url is too', { after, innerAfter });
    }
    await page.goto(shellUrl(false), { waitUntil: 'domcontentloaded' });
    rf = await roomFrame();
    if (rf) {
      await (vp.touch ? rf.tap(`${li(links.id)} a.rl-link >> nth=3`) : rf.click(`${li(links.id)} a.rl-link >> nth=3`));
      await sleep(400);
      const top = await page.evaluate(() => ({ posted: window.__posted, opened: window.__opened }));
      ok(JSON.stringify(top.opened) === JSON.stringify([['https://q.io/y', '_blank', 'noopener,noreferrer']]), 'a shell tab in a plain browser: the shell opens a new window', top);
    }

    /* ---- 4. the reply prefill ---- */
    const firstRead = (u) => u.pathname === `/api/rooms/${R}/line` && u.searchParams.has('limit') && !u.searchParams.has('before') && !u.searchParams.has('after');
    await page.route(firstRead, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.entries = [...(body.entries ?? []), voiceEntry];
      await route.fulfill({ response: res, json: body });
    });
    await openRoom();
    await page.unroute(firstRead);
    const composer = () => page.evaluate(() => {
      const i = document.querySelector('#input');
      return { v: i.value, caret: i.selectionStart, end: i.selectionEnd, focus: document.activeElement === i, chip: document.querySelector('#attTray > .rp-chip')?.dataset.id ?? null };
    });
    const setComposer = (v) => page.evaluate((x) => {
      const i = document.querySelector('#input');
      i.value = x;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
    const reply = async (id) => {
      await page.evaluate((s) => document.querySelector(s).focus(), li(id));
      await page.keyboard.press('r');
      await sleep(120);
    };
    const cancelX = async () => { await activate('#attTray > .rp-chip .rp-x'); await sleep(120); };
    const cancelEsc = async () => { await page.focus('#input'); await page.keyboard.press('Escape'); await sleep(120); };

    await setComposer('');
    await reply(buddyLine.id);
    let c = await composer();
    ok(c.v === '@buddy ' && c.caret === 7 && c.end === 7 && c.focus && c.chip === String(buddyLine.id), 'reply to a seat\'s line: "@buddy " with the caret after it', c);
    await sleep(900);
    const draft = (await call(`/api/rooms/${R}/draft`, { user: true })).body;
    ok(draft?.text === '@buddy ' && draft?.reply_to === buddyLine.id, '...the draft holds it with the target', draft && { text: draft.text, reply_to: draft.reply_to });
    await cancelX();
    c = await composer();
    ok(c.v === '' && c.chip === null, 'x on an untouched prefill takes it back', c);

    await setComposer('hello there');
    await reply(buddyLine.id);
    c = await composer();
    ok(c.v === '@buddy hello there' && c.caret === 7, 'text without a leading @: the prefix goes in front, caret after it', c);
    await cancelEsc();
    c = await composer();
    ok(c.v === 'hello there' && c.chip === null, 'Esc on it untouched: back to the text', c);

    await setComposer('');
    await reply(buddyLine.id);
    await page.keyboard.type('ok');
    c = await composer();
    ok(c.v === '@buddy ok', 'typing lands after the prefix', c.v);
    await cancelEsc();
    c = await composer();
    ok(c.v === '@buddy ok' && c.chip === null, 'an EDITED prefill stays when the reply is cancelled', c);

    await setComposer('@leader take this');
    await reply(buddyLine.id);
    c = await composer();
    ok(c.v === '@leader take this' && c.chip === String(buddyLine.id), 'a composer that already leads with an @address is left alone', c);
    await cancelEsc();
    c = await composer();
    ok(c.v === '@leader take this', '...and a cancel leaves it too', c.v);

    await setComposer('');
    await reply(buddyLine.id);
    await reply(leadLine.id);
    c = await composer();
    ok(c.v === '@leader ' && c.caret === 8 && c.chip === String(leadLine.id), 'a new reply over an untouched prefill replaces it', c);
    await cancelEsc();

    for (const [what, id] of [['your own line', mine.id], ['a fact', fact.id], ['a voice line', VOICE_ID]]) {
      await setComposer('');
      await reply(id);
      c = await composer();
      ok(c.v === '' && c.chip === String(id), `reply to ${what}: no prefill`, c);
      await cancelEsc();
    }
    await setComposer('');
    await sleep(900);

    ok(errors.length === 0, 'no page errors', errors);
    await context.close();
  }
} catch (e) {
  ok(false, 'probe crashed', String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  if (engine) {
    engine.kill('SIGTERM');
    await sleep(400);
    try { engine.kill('SIGKILL'); } catch { /* gone */ }
  }
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nroom-links.probe: PASS' : `\nroom-links.probe: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
