/* THE HELD NOTICE UNDER THE PERSON'S OWN MESSAGE [held notice] (Owner 2026-10-11,
 * room lines [ref] / [ref]).
 *
 *   node test/room-held-notice.probe.mjs
 *
 * What only a browser can prove, on a real held line (a scratch engine, a LIVE
 * scratch broker and a stub `claude`, room-deliver.test.mjs's rig):
 *   - a message held for a draft shows the quiet "held @x" first, and the LOUD
 *     notice only once it has waited 5 s: a bright ground with dark text
 *     (computed colours), its sentence, and a Deliver button
 *   - Deliver sends it (`/deliver @x`): the line is typed, the notice goes, and
 *     what the person had in the composer is untouched
 *   - with real typed text in the seat's box, Deliver first asks "Send anyway?"
 *     in the confirm strip; Confirm sends it
 *   - at phone width the notice stays inside the screen and the button meets
 *     the 40px touch floor
 *
 * A PROBE, not in `npm test`. OWN scratch engine P(535), LIVE scratch broker
 * P(536); temp table, childEnv() scrubbed, fabric + NATS off. Never
 * :7420/:7430/:8200/:8201/:8204. The temp dir is removed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

if (process.platform !== 'linux') {
  console.log('room-held-notice.probe: Linux only (POSIX stub claude) - skipped');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(535);
const BROKER_PORT = P(536);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'room-held-notice-probe-token';
const LF = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const F13 = `${ESC}[25~`; // "effect unknown": an UNKNOWN draft
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: '/bin/bash' }] });

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg, got) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  X ${msg}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`);
  }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

let cookie = '';
async function call(path, { json, as = 'bearer' } = {}) {
  const headers = as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method: json === undefined ? 'GET' : 'POST', headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function client() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const log = [];
  const waiters = [];
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    log.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) waiters.splice(i, 1)[0].resolve(msg);
    }
  });
  return {
    open: () => new Promise((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
    }),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    wait: (pred, timeoutMs = 12000) =>
      new Promise((resolve) => {
        const hit = log.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => resolve(null), timeoutMs);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
    close: () => ws.close(),
  };
}

async function run() {
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'room-held-notice.probe.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-held-notice-'));
  const binDir = join(tmpDir, 'bin');
  const typed = join(tmpDir, 'typed');
  mkdirSync(binDir);
  mkdirSync(typed);
  const safe = 'tr -c "A-Za-z0-9" "_"';
  const stubPath = join(binDir, 'claude');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      'echo ROOM-HELD-NOTICE-STUB-CLAUDE',
      `pid=$(printf '%s' "${'${HARBOR_WB_PANEID:-unknown}'}" | ${safe})`,
      `tf="${typed}/$pid"`,
      'echo "Claude Code v9.9.9"',
      'echo "? for shortcuts"',
      'while IFS= read -r line; do',
      `  printf '%s${LF}' "$line" >> "$tf"`,
      `  printf '%0900d${LF}' 0`,
      '  echo "? for shortcuts"',
      'done',
      '',
    ].join(LF),
  );
  chmodSync(stubPath, 0o755);
  const brokerEnv = childEnv({ PATH: `${binDir}${delimiter}${process.env.PATH || ''}`, PTY_BROKER_PORT: String(BROKER_PORT) });
  const pre = spawnSync('/bin/bash', ['-ic', 'command -v claude'], { env: brokerEnv, encoding: 'utf8', cwd: tmpDir });
  if (String(pre.stdout || '').trim().split(LF).pop() !== stubPath) {
    console.log('X PREFLIGHT: the pane shell does not resolve claude to the stub. Refusing to run.');
    process.exit(2);
  }
  const typedLines = (paneid) => {
    const f = join(typed, paneid.replace(/[^A-Za-z0-9]/g, '_'));
    return existsSync(f) ? readFileSync(f, 'utf8').split(LF).filter(Boolean) : [];
  };
  const wasTyped = (paneid, needle, ms = 10000) => until(() => typedLines(paneid).some((l) => l.includes(needle)), ms);

  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  let browser = null;
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true;
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
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], { cwd: REPO_ROOT, env: brokerEnv });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) throw new Error(`broker did not come up${LF}${log}`);
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
        HARBOR_WB_SEAT_WELCOME: '0',
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
        HARBOR_WB_ROOM_TYPE_SETTLE_MS: '150',
        HARBOR_WB_PROC_ROOT: join(tmpDir, 'noproc'),
      }),
    });
    engine.stdout.on('data', (d) => (log += d));
    engine.stderr.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) throw new Error(`engine did not come up${LF}${log}`);
    cookie = await windowCookie(BASE, TOKEN);

    /* one claude-code pane, the sole seat (@agent) of a room */
    const id = 'rec-held-notice';
    let r = await call('/api/recipes', { json: { id, name: 'Held Notice', target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent: 'held-notice' } });
    ok(r.status === 200, 'recipe created', r.body);
    const paneid = `recipe:${id}`;
    const c = client();
    ok(await c.open(), '/pty opens');
    c.send({ type: 'attach', paneid, recipe: id });
    ok(!!(await c.wait((m) => m.type === 'pane.ready' && m.paneid === paneid)), 'the pane spawns a real pty');
    const room = (await call('/api/rooms', { json: { name: 'Held Notice Probe' }, as: 'person' })).body;
    r = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: id, handle: 'agent', policy: 'persistent', occupant: paneid }, as: 'person' });
    eq(r.status, 200, 'seat @agent bound');
    await sleep(1200); // the startup hold clears
    const say = (text) => call(`/api/rooms/${room.id}/line`, { json: { text }, as: 'person' });

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      const f = document.querySelector('form');
      (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
    }, TOKEN);
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
    await page.goto(`${BASE}/room.html?room=${room.id}`, { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    /* WB_SHOT_DIR=<dir>: also save what the plate looks like, for a human eye */
    const shot = async (pg, name) => {
      if (process.env.WB_SHOT_DIR) {
        await pg.screenshot({ path: join(process.env.WB_SHOT_DIR, `held-notice-${name}.png`) });
      }
    };
    const noticeOf = (pg, needle) =>
      pg.evaluate((n) => {
        const li = [...document.querySelectorAll('#line li[data-id]')].find((x) => x.textContent.includes(n));
        const g = li?.querySelector(':scope > .rm-notice');
        const quiet = li?.querySelector(':scope > .entry-reads')?.textContent ?? null;
        if (!g) {
          return { li: !!li, quiet };
        }
        const cs = getComputedStyle(g);
        const b = g.querySelector('button.rm-notice-act');
        const br = b.getBoundingClientRect();
        const gr = g.getBoundingClientRect();
        return {
          li: true,
          quiet,
          text: g.querySelector('.rm-notice-text')?.textContent ?? '',
          bold: g.querySelector('.rm-notice-text b')?.textContent ?? '',
          bg: cs.backgroundColor,
          fg: cs.color,
          aboveReads: g.nextElementSibling?.classList.contains('entry-reads') ?? false,
          button: b.textContent,
          disabled: b.disabled,
          buttonH: Math.round(br.height),
          buttonInside: br.right <= gr.right + 0.5 && br.left >= gr.left - 0.5,
          right: Math.round(gr.right),
          vw: window.innerWidth,
        };
      }, needle);

    console.log(`${LF}[an UNKNOWN draft: quiet first, loud after 5 s, Deliver sends it]`);
    c.send({ type: 'input', paneid, data: F13 });
    await sleep(300);
    r = await say('@agent probe line one');
    eq(r.status, 200, 'the person posts a line; the seat holds it for a draft');
    await sleep(2000);
    let n = await noticeOf(page, 'probe line one');
    ok(n.li && !n.text, 'under 5 s: no loud notice yet', n);
    ok(String(n.quiet ?? '').includes('held'), 'the quiet "held" read line is there', n);
    ok(await until(async () => !!(await noticeOf(page, 'probe line one')).text, 9000), 'after 5 s: the loud notice is under the message');
    n = await noticeOf(page, 'probe line one');
    eq(n.text, '@agent has not received this. Its input box may hold unsent text.', "its sentence (Auriga's copy)");
    eq(n.bold, '@agent has not received this.', 'who has not received it is in bold');
    eq(n.bg, 'rgb(251, 191, 36)', 'a BRIGHT plate (computed: --notice-bg)');
    eq(n.fg, 'rgb(12, 16, 20)', 'DARK text on it (computed: --notice-ink)');
    ok(n.aboveReads, 'the plate sits under the bubble, above the read line', n);
    ok(!String(n.quiet ?? '').includes('held'), 'the quiet "held @agent" is dropped while the plate says it', n);
    eq(n.button, 'Deliver', 'one button: Deliver');
    ok(n.buttonH >= 32 && n.buttonInside, 'the button is inside the plate', n);
    await shot(page, 'desktop-held');
    await page.fill('#input', 'what I was typing');
    await page.click('.rm-notice-act');
    ok(await wasTyped(paneid, 'probe line one'), 'Deliver typed the held line into the pane', typedLines(paneid));
    ok(await until(async () => !(await noticeOf(page, 'probe line one')).text, 6000), 'the notice is gone once it is delivered');
    eq(await page.inputValue('#input'), 'what I was typing', 'the composer text is untouched');
    ok(await until(() => page.evaluate(() => [...document.querySelectorAll('#line li')].some((x) => x.textContent.includes("the user said @agent's input box is empty"))), 5000), 'the room records whose word it was');

    console.log(`${LF}[a COUNTED draft: Deliver asks "Send anyway?" first]`);
    c.send({ type: 'input', paneid, data: 'half a thought' });
    await sleep(300);
    r = await say('@agent probe line two');
    ok(await until(async () => !!(await noticeOf(page, 'probe line two')).text, 12000), 'the loud notice appears for this one too');
    await page.fill('#input', 'still typing this'); // (the probe's own post above cleared the draft, as any post by the person does)
    await sleep(1500); // let the page save it as the room draft: the case that used to lose it
    const confirmOpen = () => page.evaluate(() => !document.getElementById('reply').hidden && document.getElementById('reply').classList.contains('is-confirm'));
    await page.click('.rm-notice-act');
    ok(await until(confirmOpen, 5000), 'the confirm strip opens');
    ok((await page.textContent('#reply')).includes('Send anyway?'), 'it asks "Send anyway?"', await page.textContent('#reply'));
    n = await noticeOf(page, 'probe line two');
    ok(n.disabled && n.button === 'Sending…', 'the plate stays, its button disabled ("Sending…")', n);
    await page.click('#reply .rm-cancel');
    ok(await until(async () => !(await noticeOf(page, 'probe line two')).disabled, 3000), 'Cancel re-enables Deliver');
    eq((await noticeOf(page, 'probe line two')).button, 'Deliver', 'and it reads Deliver again');
    await sleep(500);
    ok(!typedLines(paneid).some((l) => l.includes('probe line two')), 'nothing was typed (cancelled)');
    await page.click('.rm-notice-act');
    ok(await until(confirmOpen, 5000), 'pressed again: the confirm strip opens again');
    await page.click('#reply .rm-confirm');
    ok(await wasTyped(paneid, 'probe line two'), 'Confirm typed it', typedLines(paneid));
    ok(await until(async () => !(await noticeOf(page, 'probe line two')).text, 6000), 'and the notice is gone');
    await sleep(1500); // a draft push would have landed by now
    eq(await page.inputValue('#input'), 'still typing this', 'the composer text is untouched after the confirm too');

    console.log(`${LF}[phone width: inside the screen, 40px touch floor]`);
    c.send({ type: 'input', paneid, data: F13 });
    await sleep(300);
    r = await say('@agent probe line three');
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await phone.addCookies(cookie.split('; ').map((kv) => ({ name: kv.split('=')[0], value: kv.slice(kv.indexOf('=') + 1), url: BASE })));
    const pp = await phone.newPage();
    await pp.goto(`${BASE}/room.html?room=${room.id}`, { waitUntil: 'domcontentloaded' });
    ok(await until(async () => !!(await noticeOf(pp, 'probe line three')).text, 12000), 'the loud notice shows on the phone layout');
    n = await noticeOf(pp, 'probe line three');
    await shot(pp, 'phone-held');
    ok(n.buttonH >= 40, 'the button meets the 40px touch floor', n);
    ok(n.right <= n.vw && n.buttonInside, 'the notice and its button stay inside the screen', n);
    eq(errors, [], 'no page errors');
    c.close();
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  X threw: ${e?.stack ?? e}`);
    console.log(`--- log tail ---${LF}${log.slice(-3000)}`);
  } finally {
    await browser?.close().catch(() => {});
    await kill(engine);
    await kill(broker);
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`${LF}PASS ${passed} FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join(LF));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
