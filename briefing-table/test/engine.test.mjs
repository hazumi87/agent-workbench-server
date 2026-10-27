/**
 * Engine integration test harness (Milestone 4).
 *
 * Boots a REAL engine on a scratch port with a scratch SQLite db, exercises the
 * full renderer↔engine seam over WS (the contract vocabulary), asserts, tears
 * down, and exits non-zero on any failure. This replaces the ad-hoc smoke
 * scripts that were hand-run per change.
 *
 * SAFETY: never touches the live engine (:7420) or the real data/mapping.db —
 * it spawns its own process with HARBOR_WB_PORT + HARBOR_WB_TABLE overrides and
 * a temp db it deletes on exit. Run: `npm test`.
 *
 * No test framework (Crawl: minimal deps) — a tiny assert + a runner is enough.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* Scratch ports: P(n) from test/_scratch.mjs (the port table lives there; P()
   refuses the live engine, the real broker, :8200, :8201 and :8204). */
const PORT = P(1); // scratch engine
const FAKE_HOST_PORT = P(2); // stand-in window host — tests NEVER touch the real :8200
const BROKER_PORT = P(10); // scratch broker — never the real one
const REMOTE_BROKER_PORT = P(11); // second scratch broker playing "homebase" (vk [ref] routing)
const REMOTE_TOKEN = 'test-remote-token-123';
// Routing config: a "remote" broker link with the right token + one with a
// WRONG token (auth-gate test), and targets that place PTYs on them. shell
// override = powershell.exe because the scratch "remote" broker runs on this
// Windows host (real remote brokers are Linux/bash).
const TEST_BROKERS = JSON.stringify({
  testhost: { url: `ws://127.0.0.1:${REMOTE_BROKER_PORT}`, token: REMOTE_TOKEN },
  badauth: { url: `ws://127.0.0.1:${REMOTE_BROKER_PORT}`, token: 'wrong-token' },
});
const TEST_TARGETS = JSON.stringify({
  targets: [
    { id: 'local', label: 'Local', kind: 'local', shell: 'powershell.exe' },
    { id: 'testhost-res', label: 'TestHost resident', kind: 'ssh', sshAlias: 'unused-alias', broker: 'testhost', shell: 'powershell.exe' },
    { id: 'badauth-res', label: 'BadAuth resident', kind: 'ssh', sshAlias: 'unused-alias2', broker: 'badauth', shell: 'powershell.exe' },
  ],
});
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/pty`;
/* The engine requires a token (Phase B). Tests present the MACHINE half —
   `Authorization: Bearer` — which is also a standing check that the gate is
   wired: drop the header and every request in this file 401s. */
const TEST_TOKEN = 'test-token-do-not-ship';
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (String(input).startsWith(BASE) && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${TEST_TOKEN}`);
  }
  return realFetch(input, { ...init, headers });
};

// ---- tiny test runner ----
let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path) {
  const res = await fetch(BASE + path);
  return res.json();
}

/** A minimal multiplexed client: send commands, await events by type. */
function client() {
  const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  ws.on('error', () => {}); // engine may be killed mid-test (M6 crash sim)
  const waiters = []; // {pred, resolve}
  const log = [];
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    log.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  });
  return {
    open: () => new Promise((r) => ws.once('open', r)),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    // resolve on the first message matching pred (checks backlog first)
    await: (pred, timeoutMs = 4000) =>
      new Promise((resolve, reject) => {
        const hit = log.find(pred);
        if (hit) {
          return resolve(hit);
        }
        const t = setTimeout(() => reject(new Error('timeout waiting for event')), timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      }),
    close: () => ws.close(),
    log,
  };
}

async function run() {
  // Fail fast if the scratch port is already taken — otherwise we'd silently
  // test whatever stale/orphan engine is squatting there and report bogus
  // PASS/FAIL (this actually bit us: an orphan from a crashed run answered the
  // health check with leftover prefs). A clean port is a precondition.
  try {
    const stale = await fetch(BASE + '/health').then((r) => r.json()).catch(() => null);
    if (stale) {
      console.log(
        `\n✗ port ${PORT} is already serving an engine (stale/orphan). ` +
          `Kill it before running tests:\n` +
          `  netstat -ano | grep :${PORT}   then   taskkill /F /PID <pid>\n`,
      );
      process.exit(2);
    }
  } catch {
    /* connection refused = port free = good */
  }
  /* Every port this suite names must be free on 127.0.0.1 — a leaked broker
     on BROKER_PORT would otherwise be adopted, not refused. */
  for (const p of [PORT, FAKE_HOST_PORT, BROKER_PORT, REMOTE_BROKER_PORT]) {
    await assertFree(p, 'engine.test.mjs');
  }

  /* FAKE WINDOW HOST — stands in for ui-toolkit's :8200 control API so
     the one-window-per-pty guard can be tested without a real host (and without
     ever touching the real one). `fakeWindows` is the inventory the engine
     reads; tests rewrite it to pose a session in each shape it can wear. */
  let fakeWindows = [];
  let fakeFocused = null;
  const fakeHost = createServer((req, res) => {
    const [path] = (req.url ?? '').split('?');
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (path === '/windows' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fakeWindows));
      return;
    }
    const focus = path.match(/^\/windows\/([^/]+)\/focus$/);
    if (focus && req.method === 'POST') {
      fakeFocused = focus[1];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"fake"}');
  });
  await new Promise((r) => fakeHost.listen(FAKE_HOST_PORT, '127.0.0.1', r));

  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-test-'));
  const dbPath = join(tmpDir, 'mapping.db');

  // Boot a scratch engine against dbPath. Extracted to a helper because the M6
  // crash-restore tests kill the engine and boot a SECOND one on the same db.
  // Run via `node --import tsx` against the local tsx ESM loader — spawns the
  // real `node` binary (no .cmd shim, so no shell:true and no DEP0190 warning),
  // while tsx transpiles the TS entry on the fly exactly like `npm start`.
  function bootEngine() {
    const tsxLoader = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const proc = spawn(
      process.execPath,
      ['--import', `file://${tsxLoader.replace(/\\/g, '/')}`, 'src/server/index.ts'],
      {
        cwd: REPO_ROOT,
        env: childEnv({
          HARBOR_WB_PORT: String(PORT),
          HARBOR_WB_HOST: HOST,
          HARBOR_WB_TABLE: dbPath,
          HARBOR_WB_SOLO_GRACE_MS: '800', // short close→kill grace so the test can observe it
          HARBOR_WB_DEBUG_UI: '1', // deterministic debugUi for the /health assertion
          // Point the claude-code vendor's transcript root at a fixture tree so
          // the locate-refresh tests never read (or depend on) the real ~/.claude.
          HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
          HARBOR_WB_TOKEN: TEST_TOKEN, // auth gate (Phase B) — tests use the bearer half
          // PINNED, not inherited: this suite asserts the SHARED-SECRET gate, so an
          // ambient HARBOR_WB_IDENTITY=strict in the shell would 401 every request
          // in this file and look like an engine fault. Identity has its own suite.
          HARBOR_WB_IDENTITY: 'legacy',
          HARBOR_WB_NO_WINDOW: '1', // launch route must not pop Edge windows in tests
          // Placement tests consult a FAKE window host, never the real :8200.
          HARBOR_WB_WINDOW_HOST: `http://127.0.0.1:${FAKE_HOST_PORT}`,
          HARBOR_WB_NATS_URL: '', // telemetry off — tests never touch the network
          /* The fabric subscriber must never dial from a test: 8204 is the real
          server service's port and a test engine has no business on it. '' is the
          documented off switch, same posture as HARBOR_WB_NATS_URL above. */
          HARBOR_WB_FABRIC_URL: '',
          HARBOR_WB_ACT_QUIET_MS: '400', // fast streaming→idle decay for activity tests
          HARBOR_WB_BROKER_PORT: String(BROKER_PORT), // scratch broker, never the real one
          HARBOR_WB_BROKER_AUTOSTART: '0', // tests must never touch the real scheduled task
          HARBOR_WB_BROKERS: TEST_BROKERS, // remote links (vk [ref] routing tests)
          HARBOR_WB_TARGETS: TEST_TARGETS, // targets incl. broker-resident flavors
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    proc.stdout.on('data', (d) => (engineLog += d));
    proc.stderr.on('data', (d) => (engineLog += d));
    return proc;
  }

  async function waitUp() {
    for (let i = 0; i < 40; i++) {
      try {
        const h = await fetchJson('/health');
        if (h.status === 'ok') {
          return true;
        }
      } catch {
        /* not yet */
      }
      await sleep(250);
    }
    return false;
  }

  // Scratch PTY-broker (vk [ref] Phase 2): the engine's spawns all live here
  // now. Booted BEFORE the engine (autostart is disabled in tests). The M6
  // crash tests kill BOTH processes — the full-host-death path --resume covers;
  // an engine-only death is the new adoption test. Booted from the PACKAGE
  // (node_modules/pty-broker, git-pinned) since the 2026-08-08 repo split —
  // engine tests always run against the exact pinned broker.
  function bootBroker(port = BROKER_PORT, extraEnv = {}) {
    const tsxLoader = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const proc = spawn(
      process.execPath,
      ['--import', `file://${tsxLoader.replace(/\\/g, '/')}`, 'node_modules/pty-broker/src/main.ts'],
      {
        cwd: REPO_ROOT,
        env: childEnv({ PTY_BROKER_PORT: String(port), ...extraEnv }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    proc.stdout.on('data', (d) => (engineLog += d));
    proc.stderr.on('data', (d) => (engineLog += d));
    return proc;
  }
  async function waitBrokerUp(port = BROKER_PORT) {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) {
          return true;
        }
      } catch {
        /* not yet */
      }
      await sleep(250);
    }
    return false;
  }

  let engineLog = '';
  console.log(`booting scratch brokers :${BROKER_PORT} (local) + :${REMOTE_BROKER_PORT} ("homebase", token) + engine :${PORT} (db ${dbPath})`);
  let broker = bootBroker();
  let remoteBroker = bootBroker(REMOTE_BROKER_PORT, { PTY_BROKER_TOKEN: REMOTE_TOKEN });
  if (!(await waitBrokerUp()) || !(await waitBrokerUp(REMOTE_BROKER_PORT))) {
    console.log(`broker(s) did not come up.\n${engineLog}`);
    process.exit(1);
  }
  let engine = bootEngine();

  try {
    if (!(await waitUp())) {
      throw new Error(`engine did not come up.\n--- engine log ---\n${engineLog}`);
    }

    console.log('\n[health + discovery]');
    const health = await fetchJson('/health');
    eq(health.status, 'ok', 'health ok');
    eq(health.milestone, 8, 'milestone 8 (broker)');
    eq(health.broker, true, 'health reports broker available');
    eq(health.debugUi, true, 'health exposes debugUi (HARBOR_WB_DEBUG_UI=1)');
    ok(Array.isArray(health.components) && health.components.includes('local-shell'), 'local-shell discovered');

    console.log('\n[attach → pane.ready → input/output]');
    const c = client();
    await c.open();
    const paneid = 'test-pane-1';
    c.send({ type: 'attach', paneid, component: 'local-shell' });
    const ready = await c.await((m) => m.type === 'pane.ready' && m.paneid === paneid);
    eq(ready.state, 'live', 'pane.ready state live');
    ok(ready.prefs && ready.prefs.friendlyName === null, 'fresh pane has null prefs');
    ok(typeof ready.vendor === 'string' && ready.vendor.length > 0, 'pane.ready carries the brand join key (vendor, never missing)', ready.vendor);
    c.send({ type: 'input', paneid, data: 'echo WB_TEST_OK\r' });
    await c.await((m) => m.type === 'pane.data' && m.paneid === paneid && m.data.includes('WB_TEST_OK'));
    ok(true, 'input echoed back as pane.data');

    console.log('\n[prefs: rename + setPrefs partial write]');
    c.send({ type: 'rename', paneid, friendlyName: 'Harbor Test' });
    const p1 = await c.await((m) => m.type === 'pane.prefs' && m.prefs.friendlyName === 'Harbor Test');
    ok(p1.prefs.color === null, 'rename did not set color');
    c.send({ type: 'setPrefs', paneid, color: '#781ee6', fg: '#ff0a0a', bg: '#6f112d' });
    const p2 = await c.await((m) => m.type === 'pane.prefs' && m.prefs.color === '#781ee6');
    eq(p2.prefs.fg, '#ff0a0a', 'fg set');
    eq(p2.prefs.bg, '#6f112d', 'bg set');
    eq(p2.prefs.friendlyName, 'Harbor Test', 'setPrefs preserved friendlyName (COALESCE)');

    console.log('\n[address: name → paneid, case-insensitive]');
    c.send({ type: 'address', name: 'harbor test', id: 'a1' });
    const addr = await c.await((m) => m.type === 'result' && m.command === 'address');
    eq(addr.paneid, paneid, 'address resolved name to paneid');

    console.log('\n[table endpoint reflects prefs]');
    const tbl = await fetchJson('/api/table');
    const row = tbl.sessions.find((s) => s.paneid === paneid);
    ok(row, 'pane row present in table');
    eq(row.friendlyName, 'Harbor Test', 'table friendlyName');
    eq(row.color, '#781ee6', 'table color');
    eq(row.fg, '#ff0a0a', 'table fg');
    eq(row.bg, '#6f112d', 'table bg');

    console.log('\n[reattach: new socket → replay + prefs in pane.ready]');
    c.close();
    await sleep(200);
    const c2 = client();
    await c2.open();
    c2.send({ type: 'attach', paneid, component: 'local-shell' });
    const re = await c2.await((m) => m.type === 'pane.ready' && m.paneid === paneid);
    eq(re.reattached, true, 'reattached true (resident survived socket drop)');
    eq(re.prefs.color, '#781ee6', 'prefs replayed on reattach');
    eq(re.vendor, ready.vendor, 'vendor rides the reattach pane.ready too');
    await c2.await((m) => m.type === 'pane.data' && m.data.includes('WB_TEST_OK'));
    ok(true, 'replay buffer rebuilt the screen');
    await c2.await((m) => m.type === 'pane.reattached' && m.paneid === paneid);
    ok(true, 'pane.reattached event fired');

    console.log('\n[kill → pane.exit + table killed]');
    c2.send({ type: 'kill', paneid });
    const exit = await c2.await((m) => m.type === 'pane.exit' && m.paneid === paneid);
    ok(typeof exit.code === 'number', 'pane.exit carried an exit code');
    await sleep(200);
    const tbl2 = await fetchJson('/api/table');
    const row2 = tbl2.sessions.find((s) => s.paneid === paneid);
    eq(row2.state, 'killed', 'table state → killed after kill');
    eq(row2.color, '#781ee6', 'prefs survive a kill (identity outlives the process)');
    c2.close();

    /* ================= CLI Manager (M5): recipes + solo lifecycle ================= */

    console.log('\n[recipes: CRUD over HTTP]');
    const LOGO1 = JSON.stringify({
      svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      scale: 60,
      mono: 'black',
      opacity: 20,
    });
    const created = await (
      await fetch(BASE + '/api/recipes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Recipe',
          target: 'local',
          projectDir: REPO_ROOT,
          runClaude: false, // shell-only: the test must not depend on a claude install
          color: '#3355ff',
          watermark: 'TEST',
          fontSize: 16,
          logo: LOGO1,
        }),
      })
    ).json();
    ok(created.recipe && created.recipe.id, 'recipe created with an id');
    eq(created.recipe.runClaude, 0, 'runClaude stored as 0');
    const rid = created.recipe.id;
    const listed = await fetchJson('/api/recipes');
    ok(listed.recipes.some((r) => r.id === rid), 'recipe appears in list');
    const targetsRes = await fetchJson('/api/targets');
    ok(Array.isArray(targetsRes.targets) && targetsRes.targets.some((t) => t.id === 'local'), 'targets include local');

    console.log('\n[recipe attach: spawn carries the recipe theme]');
    const c3 = client();
    await c3.open();
    const rpane = `recipe:${rid}`;
    c3.send({ type: 'attach', paneid: rpane, recipe: rid });
    const rready = await c3.await((m) => m.type === 'pane.ready' && m.paneid === rpane, 8000);
    eq(rready.state, 'live', 'recipe pane live');
    eq(rready.prefs.friendlyName, 'Test Recipe', 'recipe name → pane prefs');
    ok(typeof rready.vendor === 'string' && rready.vendor.length > 0, 'recipe pane.ready carries vendor', rready.vendor);
    eq(rready.prefs.color, '#3355ff', 'recipe color → pane prefs');
    eq(rready.prefs.watermark, 'TEST', 'recipe watermark → pane prefs');
    eq(rready.prefs.fontSize, 16, 'recipe fontSize → pane prefs');
    eq(rready.prefs.logo, LOGO1, 'recipe logo → pane prefs');
    c3.send({ type: 'input', paneid: rpane, data: 'echo WB_RECIPE_OK\r' });
    await c3.await((m) => m.type === 'pane.data' && m.paneid === rpane && m.data.includes('WB_RECIPE_OK'), 8000);
    ok(true, 'recipe pane shell echoes input');
    const tblR = await fetchJson('/api/table');
    const rowR = tblR.sessions.find((s) => s.paneid === rpane);
    eq(rowR.vendor, 'cli-manager', 'table vendor = cli-manager');
    eq(rowR.server, 'local', 'table server = local');

    console.log('\n[solo theme write-back: rename on the window updates the recipe]');
    c3.send({ type: 'setPrefs', paneid: rpane, color: '#aa1144' });
    await c3.await((m) => m.type === 'pane.prefs' && m.paneid === rpane && m.prefs.color === '#aa1144');
    c3.send({ type: 'rename', paneid: rpane, friendlyName: 'Renamed Recipe' });
    await c3.await((m) => m.type === 'pane.prefs' && m.paneid === rpane && m.prefs.friendlyName === 'Renamed Recipe');
    c3.send({ type: 'setPrefs', paneid: rpane, fontSize: 18 });
    const pFont = await c3.await((m) => m.type === 'pane.prefs' && m.paneid === rpane && m.prefs.fontSize === 18);
    eq(pFont.prefs.color, '#aa1144', 'fontSize setPrefs preserved color (COALESCE)');
    const LOGO2 = JSON.stringify({
      svg: '<svg viewBox="0 0 4 4"><circle cx="2" cy="2" r="2"/></svg>',
      scale: 50,
      mono: 'white',
      opacity: 15,
    });
    c3.send({ type: 'setPrefs', paneid: rpane, logo: LOGO2 });
    await c3.await((m) => m.type === 'pane.prefs' && m.paneid === rpane && m.prefs.logo === LOGO2);
    const after = await fetchJson(`/api/recipes/${rid}`);
    eq(after.recipe.color, '#aa1144', 'recipe color auto-saved from the window');
    eq(after.recipe.name, 'Renamed Recipe', 'recipe name auto-saved from the window');
    eq(after.recipe.fontSize, 18, 'recipe fontSize auto-saved from the window');
    eq(after.recipe.logo, LOGO2, 'recipe logo auto-saved from the window');
    // '' is the clear sentinel (COALESCE skips null, so removal needs an explicit '')
    c3.send({ type: 'setPrefs', paneid: rpane, logo: '' });
    const pClear = await c3.await((m) => m.type === 'pane.prefs' && m.paneid === rpane && m.prefs.logo === '');
    eq(pClear.prefs.logo, '', 'logo cleared via empty-string sentinel');
    eq(pClear.prefs.color, '#aa1144', 'logo clear preserved color (COALESCE)');

    console.log('\n[svg logo library: create, Windows-style name dedup, list]');
    const mkLogo = (name) =>
      fetch(BASE + '/api/logos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, svg: '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>' }),
      }).then((r) => r.json());
    const l1 = await mkLogo('Home Hub');
    eq(l1.logo.name, 'Home Hub', 'first logo keeps its name');
    const l2 = await mkLogo('Home Hub');
    eq(l2.logo.name, 'Home Hub (2)', 'duplicate name → " (2)"');
    const l3 = await mkLogo('home hub'); // case-insensitive collision
    eq(l3.logo.name, 'home hub (3)', 'case-insensitive duplicate → " (3)"');
    const logos = (await fetchJson('/api/logos')).logos;
    ok(logos.length >= 3 && logos.every((l) => l.svg.includes('<svg')), 'library lists saved logos');
    const badLogo = await fetch(BASE + '/api/logos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no svg' }),
    });
    eq(badLogo.status, 400, 'logo POST without svg → 400');
    await fetch(`${BASE}/api/logos/${l2.logo.id}`, { method: 'DELETE' });
    const afterDel = (await fetchJson('/api/logos')).logos;
    ok(!afterDel.some((l) => l.id === l2.logo.id), 'deleted logo gone from library');

    console.log(String.fromCharCode(10) + '[logo style: the treatment stored on the ART, validated on the way in]');
    const patchLogo = (id, body) =>
      fetch(`${BASE}/api/logos/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const styled = await patchLogo(l1.logo.id, {
      style: { line: 'engrave', washFrom: 'ur', backlit: false, scale: 55, opacity: 30 },
    });
    eq(styled.status, 200, 'style PATCH accepted');
    eq(
      JSON.parse(styled.body.logo.style).line,
      'engrave',
      'the treatment is stored on the SET (line, wash and backlit belong to the art)',
    );
    const served = (await fetchJson('/api/logos')).logos.find((l) => l.id === l1.logo.id);
    eq(JSON.parse(served.style).scale, 55, 'and it is served back with the library');
    /* An unknown value must fall back rather than be stored: `wm-line-neon`
       would mint a class nobody styles, and the field reaches a pane through
       inheritance, so a bad write outlives the page that made it. */
    const junk = await patchLogo(l1.logo.id, {
      style: { line: 'neon', washFrom: 'nowhere', backlit: 'yes', scale: 9000, opacity: -5, evil: 1 },
    });
    const j = JSON.parse(junk.body.logo.style);
    eq(j.line, 'none', 'an unknown line falls back to none');
    eq(j.washFrom, 'll-mid', 'an unknown wash origin falls back to ll-mid');
    eq(j.backlit, true, 'a non-boolean backlit falls back to on');
    eq(j.scale, 100, 'an out-of-range scale is clamped, not stored');
    /* Out of range CLAMPS (both ends), rather than falling back to the
       default: -5 means "as faint as possible", and answering that with 10%
       would be the engine overriding an intent it could honour. Only a value
       that is not a number at all has no intent to honour. */
    eq(j.opacity, 1, 'an out-of-range opacity is clamped to the floor');
    eq(
      JSON.parse((await patchLogo(l1.logo.id, { style: { opacity: 'plaid' } })).body.logo.style).opacity,
      10,
      'a non-numeric opacity falls back to the default',
    );
    ok(!('evil' in j), 'unknown keys are dropped — this is not a general blob');
    /* NULL is distinct from a stored default: it means "this art has no
       opinion", which is what lets the UI defaults stay the one fallback. */
    /* THE MARK BLOCK — the art's second surface. Presentation only, and an
       unparseable tint must fall back rather than reach a tab. */
    const marked = await patchLogo(l1.logo.id, {
      style: { line: 'none', mark: { opacity: 55, tint: '#3a4a5a' } },
    });
    const mk = JSON.parse(marked.body.logo.style).mark;
    eq(mk.opacity, 55, 'the tab mark keeps its own opacity');
    eq(mk.tint, '#3a4a5a', '...and its own tint');
    const mk2 = JSON.parse((await patchLogo(l1.logo.id, {
      style: { mark: { opacity: 5, tint: 'chartreuse' } },
    })).body.logo.style).mark;
    eq(mk2.opacity, 10, 'an out-of-range mark opacity clamps to the floor');
    eq(mk2.tint, 'auto', 'a tint that is not #rrggbb falls back to the project colour');
    const mk3 = JSON.parse((await patchLogo(l1.logo.id, { style: { line: 'none' } })).body.logo.style).mark;
    eq(mk3.opacity, 100, 'a style with no mark block reads as the untouched default');
    eq(mk3.tint, 'auto', '...tinted by the project colour, exactly as before');

    const cleared = await patchLogo(l1.logo.id, { style: null });
    eq(cleared.body.logo.style, null, 'style: null clears it back to no-opinion');
    const nothing = await patchLogo(l1.logo.id, {});
    eq(nothing.status, 400, 'a PATCH with nothing to do is still refused');
    /* Existing art predates the column and must read as no-opinion, never as a
       default someone chose. */
    eq(
      (await fetchJson('/api/logos')).logos.find((l) => l.id === l3.logo.id).style,
      null,
      'a set that was never styled reads null',
    );

    console.log('\n[dropped window DETACHES, never kills - close-kill retired]');
    c3.close();
    await sleep(2000); // grace is 800ms in this run; well past it
    const tblK = await fetchJson('/api/table');
    eq(tblK.sessions.find((s) => s.paneid === rpane).state, 'live', 'recipe session SURVIVES a dropped window (close-kill retired 2026-08-09)');

    console.log('\n[reload survives: reattach within the grace window]');
    const c4 = client();
    await c4.open();
    c4.send({ type: 'attach', paneid: rpane, recipe: rid });
    await c4.await((m) => m.type === 'pane.ready' && m.paneid === rpane, 8000);
    c4.close(); // "reload": drop...
    const c5 = client();
    await c5.open();
    c5.send({ type: 'attach', paneid: rpane, recipe: rid }); // ...and reattach fast
    const re5 = await c5.await((m) => m.type === 'pane.ready' && m.paneid === rpane, 8000);
    eq(re5.reattached, true, 'fast reattach (reload) kept the session alive');
    c5.send({ type: 'kill', paneid: rpane });
    await c5.await((m) => m.type === 'pane.exit' && m.paneid === rpane);
    c5.close();

    /* ===== R11: the engine TELLS a session who it is ===== */
    console.log('\n[HARBOR_WB_SLUG / PANEID / VENDOR reach the spawned CLI]');
    /* Owner, 2026-09-17: "how does an agent know if they are platform-2,
       platform-3 or platform-32? they don't. they only have their context."
       Identity is ASSIGNED and HANDED BACK, never counted — so the engine, which
       is the only thing that knows, says so in the one channel every CLI, hook
       and skill can read without inferring it from a cwd or a window title.
       Asserted by ECHOING IT OUT OF A REAL PTY: the variables have to survive
       the engine, the broker's clean logon env and the shell, and a unit test on
       the descriptor would prove none of that. */
    const envRec = (
      await (
        await fetch(BASE + '/api/recipes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Env Identity Test',
            target: 'local',
            projectDir: REPO_ROOT,
            vendor: 'cli-manager',
            agent: 'env-identity-cli',
          }),
        })
      ).json()
    ).recipe;
    eq(envRec.agent, 'env-identity-cli', 'the recipe carries the slug');
    const envPane = 'recipe:' + envRec.id;
    const cEnv = client();
    await cEnv.open();
    cEnv.send({ type: 'attach', paneid: envPane, recipe: envRec.id });
    await cEnv.await((m) => m.type === 'pane.ready' && m.paneid === envPane, 8000);
    cEnv.send({
      type: 'input',
      paneid: envPane,
      data: 'echo "WBENV=$env:HARBOR_WB_SLUG|$env:HARBOR_WB_PANEID|$env:HARBOR_WB_VENDOR"' + '\r',
    });
    const envOut = await cEnv.await(
      (m) => m.type === 'pane.data' && m.paneid === envPane && m.data.includes('WBENV=env-identity-cli'),
      10000,
    );
    ok(envOut.data.includes('env-identity-cli'), 'HARBOR_WB_SLUG is in the pty env');
    ok(envOut.data.includes(envPane), 'HARBOR_WB_PANEID is the pane the process is in');
    ok(envOut.data.includes('cli-manager'), 'HARBOR_WB_VENDOR is the brand');
    cEnv.close();
    /* END the session, do not merely drop the socket: a closed viewer leaves the
       pty RESIDENT in the broker (that is the whole feature), and a stray live
       session changes the count the adoption phase asserts on later. Tests that
       spawn must clean up their processes, not just their rows. */
    await fetch(BASE + '/api/sessions/' + encodeURIComponent(envPane) + '/end', { method: 'POST' });
    await fetch(BASE + '/api/recipes/' + envRec.id, { method: 'DELETE' });

    /* ===== vendor enum: REFUSED, never coerced (contract v0.3 finding #1) ===== */
    console.log('\n[an unknown vendor is a 400, not a silent claude-code]');
    const badVendor = await fetch(BASE + '/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      /* "gemini" is the ALMOST-RIGHT spelling, which is the whole point: until
         2026-09-17 this saved as claude-code and spawned CLAUDE at you, and the
         recipe looked saved the entire time. */
      body: JSON.stringify({ name: 'Bad Vendor', target: 'local', vendor: 'gemini' }),
    });
    eq(badVendor.status, 400, 'unknown vendor is refused');
    const badBody = await badVendor.json();
    eq(badBody.field, 'vendor', '400 NAMES THE FIELD, so the sender does not have to guess');
    ok(Array.isArray(badBody.allowed) && badBody.allowed.includes('gemini-cli'),
      'and lists what IS allowed, including the spelling they meant');
    const beforeCount = (await fetchJson('/api/recipes')).recipes.length;
    ok(!(await fetchJson('/api/recipes')).recipes.some((r) => r.name === 'Bad Vendor'),
      'the refused recipe was NOT written');

    for (const v of ['claude-code', 'cli-manager', 'gemini-cli', 'codex-cli', 'ollama']) {
      const res = await fetch(BASE + '/api/recipes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Vendor ' + v, target: 'local', vendor: v }),
      });
      const body = await res.json();
      eq(body.recipe?.vendor, v, 'vendor "' + v + '" round-trips through the store unchanged');
      /* runClaude is DERIVED and means exactly "this runs claude" — it is not a
         proxy for "runs some CLI", which is what it had drifted into. */
      eq(body.recipe?.runClaude, v === 'claude-code' ? 1 : 0, '  ...and runClaude mirrors it for ' + v);
      await fetch(BASE + '/api/recipes/' + body.recipe.id, { method: 'DELETE' });
    }
    eq((await fetchJson('/api/recipes')).recipes.length, beforeCount,
      'the five probe recipes cleaned up after themselves');

    /* ===== brand identity (contract §9) ===== */
    console.log('\n[GET /api/brands: one identity mark per vendor]');
    const brandRes = await fetch(BASE + '/api/brands');
    eq(brandRes.status, 200, '/api/brands serves');
    const { brands } = await brandRes.json();
    ok(Array.isArray(brands) && brands.length > 0, 'a non-empty table');
    for (const v of ['claude-code', 'cli-manager', 'gemini-cli', 'codex-cli', 'ollama']) {
      ok(brands.some((b) => b.vendor === v), 'every enum vendor has an entry: ' + v);
    }
    ok(brands.some((b) => b.vendor === 'generic'), 'the mandatory generic fallback is present');
    const claudeBrand = brands.find((b) => b.vendor === 'claude-code');
    eq(claudeBrand.brandHue, 39, 'brandHue is the DESIGNED glyph input');
    ok(/^#[0-9a-f]{6}$/i.test(claudeBrand.brandColor), 'brandColor is the literal vendor colour');
    eq(claudeBrand.brandMark, 'claude', 'brandMark is an design-system mark KEY, not an SVG and not a brand-* name');
    ok(brands.every((b) => b.brandMarkDark === undefined),
      'no brandMarkDark — a currentColor mark inverts for free');
    /* The whole point of the table: a surface holding a SESSION can already join
       to its brand, because every row carries vendor. No new field travels. */
    const tblB = await fetchJson('/api/table');
    ok(tblB.sessions.every((r) => typeof r.vendor === 'string' && r.vendor),
      'every /api/table row carries a vendor to join on — never missing, never blank');
    const noAuthBrands = await realFetch(BASE + '/api/brands');
    eq(noAuthBrands.status, 401, 'and it is behind the bearer gate like /api/table');

    console.log('\n[recipe delete]');
    await fetch(`${BASE}/api/recipes/${rid}`, { method: 'DELETE' });
    const listed2 = await fetchJson('/api/recipes');
    ok(!listed2.recipes.some((r) => r.id === rid), 'recipe gone after delete');

    /* ==== Phase 2 (vk [ref]): engine death costs NOTHING — broker adoption ==== */
    console.log('\n[broker adoption: engine-only death → session survives with replay]');
    const mkRecipeA = (body) =>
      fetch(BASE + '/api/recipes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    const adRec = (await mkRecipeA({ name: 'Adoption Test', target: 'local', projectDir: tmpDir, runClaude: false })).recipe;
    const adPane = `recipe:${adRec.id}`;
    const cAd = client();
    await cAd.open();
    cAd.send({ type: 'attach', paneid: adPane, recipe: adRec.id });
    await cAd.await((m) => m.type === 'pane.ready' && m.paneid === adPane, 8000);
    cAd.send({ type: 'input', paneid: adPane, data: "echo ADOPTION_CODEWORD_852\r" });
    await cAd.await((m) => m.type === 'pane.data' && m.paneid === adPane && m.data.includes('ADOPTION_CODEWORD_852'), 8000);
    engine.kill(); // engine dies; the BROKER (and the shell in it) does not
    await sleep(700);
    engine = bootEngine();
    ok(await waitUp(), 'engine came back beside the still-running broker');
    ok(engineLog.includes('adopted 1 live session'), 'boot log reports the adoption');
    const adRow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === adPane);
    eq(adRow.state, 'live', 'row stayed LIVE across the engine restart (not dehydrated/killed)');
    ok(adRow.interrupted !== 1, 'adopted pane not stamped interrupted (nothing was lost)');
    const cAd2 = client();
    await cAd2.open();
    cAd2.send({ type: 'attach', paneid: adPane, recipe: adRec.id });
    const adReady = await cAd2.await((m) => m.type === 'pane.ready' && m.paneid === adPane, 8000);
    eq(adReady.reattached, true, 'window reattached to the SAME living session');
    const adReplay = await cAd2.await((m) => m.type === 'pane.data' && m.paneid === adPane, 8000);
    ok(adReplay.data.includes('ADOPTION_CODEWORD_852'), 'replay carried pre-restart output through the broker');
    cAd2.send({ type: 'input', paneid: adPane, data: "echo STILL_ALIVE_963\r" });
    await cAd2.await((m) => m.type === 'pane.data' && m.paneid === adPane && m.data.includes('STILL_ALIVE_963'), 8000);
    ok(true, 'session fully interactive after adoption');
    cAd2.send({ type: 'kill', paneid: adPane });
    await cAd2.await((m) => m.type === 'pane.exit' && m.paneid === adPane, 8000);
    cAd2.close();
    cAd.close();
    await fetch(`${BASE}/api/recipes/${adRec.id}`, { method: 'DELETE' });

    /* ============ M6 (ticket): claude-code vendor — crash restore ============ */
    // Assertions here are TABLE FACTS and contract events only — the injected
    // `claude ...` command line is typed into the shell but never awaited, so
    // the tests hold whether or not a claude binary exists on the test host.

    console.log('\n[M6: claude recipe mints a session uuid into the table]');
    const mkRecipe = (body) =>
      fetch(BASE + '/api/recipes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    const claudeRec = (await mkRecipe({ name: 'Claude Crash Test', target: 'local', projectDir: tmpDir, runClaude: true })).recipe;
    const namedRec = (await mkRecipe({ name: 'Named Resume Test', target: 'local', projectDir: tmpDir, runClaude: true, resume: true, resumeName: 'my-session' })).recipe;
    const shellRec = (await mkRecipe({ name: 'Shell Crash Test', target: 'local', projectDir: tmpDir, runClaude: false })).recipe;
    const cpane = `recipe:${claudeRec.id}`;
    const npane = `recipe:${namedRec.id}`;
    const spane = `recipe:${shellRec.id}`;

    const c6 = client();
    await c6.open();
    c6.send({ type: 'attach', paneid: cpane, recipe: claudeRec.id });
    const cready = await c6.await((m) => m.type === 'pane.ready' && m.paneid === cpane, 8000);
    eq(cready.restored, false, 'fresh claude pane is not "restored"');
    c6.send({ type: 'attach', paneid: npane, recipe: namedRec.id });
    await c6.await((m) => m.type === 'pane.ready' && m.paneid === npane, 8000);
    c6.send({ type: 'attach', paneid: spane, recipe: shellRec.id });
    await c6.await((m) => m.type === 'pane.ready' && m.paneid === spane, 8000);
    await sleep(600); // let the visible `claude ...` injection get typed

    const tblC = await fetchJson('/api/table');
    const rowC = tblC.sessions.find((s) => s.paneid === cpane);
    const rowN = tblC.sessions.find((s) => s.paneid === npane);
    const rowS = tblC.sessions.find((s) => s.paneid === spane);
    eq(rowC.vendor, 'claude-code', 'claude recipe → vendor claude-code');
    ok(UUID_RE.test(rowC.session_id ?? ''), `session_id is a minted uuid (got ${rowC.session_id})`);
    eq(rowN.vendor, 'claude-code', 'named-resume recipe → vendor claude-code');
    eq(rowN.session_id, null, 'named-resume session id is unknowable → null');
    eq(rowS.vendor, 'cli-manager', 'shell-only recipe → vendor cli-manager');
    const mintedId = rowC.session_id;

    console.log('\n[M6: HOST death (engine+broker) → claude dehydrated, shell killed]');
    // Since Phase 2 an engine-only death is survivable (adoption above) — the
    // --resume path now covers the FULL-host death: broker dies too.
    engine.kill(); // simulated crash: no socket-close handlers, no cleanup
    broker.kill(); // ...and the broker with it (harbor reboot / logoff / OS crash)
    await sleep(700);
    broker = bootBroker();
    ok(await waitBrokerUp(), 'fresh broker came up (its sessions died with it)');
    engine = bootEngine();
    ok(await waitUp(), 'engine #2 came up on the same db');
    ok(engineLog.includes('dehydrated (resumable vendor, restorable)'), 'boot log reports the reconcile');
    const tblD = await fetchJson('/api/table');
    eq(tblD.sessions.find((s) => s.paneid === cpane).state, 'dehydrated', 'claude pane → dehydrated');
    eq(tblD.sessions.find((s) => s.paneid === cpane).session_id, mintedId, 'dehydrated row kept the uuid');
    eq(tblD.sessions.find((s) => s.paneid === npane).state, 'dehydrated', 'named-resume pane → dehydrated too');
    eq(tblD.sessions.find((s) => s.paneid === spane).state, 'killed', 'shell pane → killed (not resumable)');

    console.log('\n[M6: reattach restores by stored uuid]');
    const c7 = client();
    await c7.open();
    c7.send({ type: 'attach', paneid: cpane, recipe: claudeRec.id });
    const restored = await c7.await((m) => m.type === 'pane.ready' && m.paneid === cpane, 8000);
    eq(restored.restored, true, 'pane.ready flags the crash restore');
    await sleep(300);
    const tblR2 = await fetchJson('/api/table');
    const rowR2 = tblR2.sessions.find((s) => s.paneid === cpane);
    eq(rowR2.state, 'live', 'restored pane live again');
    eq(rowR2.session_id, mintedId, 'restore kept the SAME uuid (plain --resume does not fork)');
    // named-resume pane: no stored id, so a reattach is a plain fresh launch
    // that re-runs the recipe's own `--resume "<name>"` — restored flag false.
    c7.send({ type: 'attach', paneid: npane, recipe: namedRec.id });
    const nready2 = await c7.await((m) => m.type === 'pane.ready' && m.paneid === npane, 8000);
    eq(nready2.restored, false, 'named-resume reattach is not an id-restore');
    c7.send({ type: 'kill', paneid: cpane });
    await c7.await((m) => m.type === 'pane.exit' && m.paneid === cpane, 8000);
    c7.send({ type: 'kill', paneid: npane });
    await c7.await((m) => m.type === 'pane.exit' && m.paneid === npane, 8000);
    c7.close();
    for (const rec of [claudeRec, namedRec, shellRec]) {
      await fetch(`${BASE}/api/recipes/${rec.id}`, { method: 'DELETE' });
    }

    /* ========= vk [ref]: locate-refresh — restore follows the lineage ========= */
    // A dehydrated pane's banked uuid may be a stale incarnation. The restore
    // must follow the STRUCTURAL "sessionId" link to the newest transcript in
    // the lineage — and must NOT be stolen by a newer transcript that merely
    // mentions the uuid as text (quote contamination).

    console.log('\n[locate-refresh: structural lineage wins, contamination ignored]');
    const projDir = join(tmpDir, 'proj-locate');
    mkdirSync(projDir, { recursive: true });
    const locRec = (await mkRecipe({ name: 'Locate Test', target: 'local', projectDir: projDir, runClaude: true })).recipe;
    const lpane = `recipe:${locRec.id}`;
    const c8 = client();
    await c8.open();
    c8.send({ type: 'attach', paneid: lpane, recipe: locRec.id });
    await c8.await((m) => m.type === 'pane.ready' && m.paneid === lpane, 8000);
    await sleep(300);
    const banked = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === lpane).session_id;
    ok(UUID_RE.test(banked ?? ''), `locate-test pane banked a uuid (${banked})`);
    c8.close();

    engine.kill(); // crash again (host death: broker too) → dehydrated
    broker.kill();
    await sleep(700);
    broker = bootBroker();
    ok(await waitBrokerUp(), 'fresh broker for the locate-refresh segment');

    // Build the fixture lineage while the engine is down: banked file (oldest),
    // a NEWER descendant structurally referencing the banked id, and the NEWEST
    // file mentioning the uuid only as plain text (a conversation quoting it).
    const descendant = '11111111-2222-4333-8444-555555555555';
    const encDir = join(tmpDir, 'claude-projects', projDir.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(encDir, { recursive: true });
    writeFileSync(join(encDir, `${banked}.jsonl`), `{"sessionId":"${banked}","type":"user"}\n`);
    await sleep(30);
    writeFileSync(join(encDir, `${descendant}.jsonl`), `{"sessionId":"${banked}","type":"user"}\n{"sessionId":"${descendant}","type":"user"}\n`);
    await sleep(30);
    writeFileSync(join(encDir, `99999999-8888-4777-8666-555555555544.jsonl`), `{"sessionId":"99999999-8888-4777-8666-555555555544","content":"we discussed uuid ${banked} in chat"}\n`);

    engine = bootEngine();
    ok(await waitUp(), 'engine #3 came up');
    const tbl3 = await fetchJson('/api/table');
    eq(tbl3.sessions.find((s) => s.paneid === lpane).state, 'dehydrated', 'locate-test pane dehydrated');
    // interrupted stamp (Edge-style restore offer): only panes OPEN at the
    // crash get it — the ✕-ended panes from the previous segment must not.
    eq(tbl3.sessions.find((s) => s.paneid === lpane).interrupted, 1, 'crash-open pane stamped interrupted');
    ok(tbl3.sessions.find((s) => s.paneid === cpane).interrupted !== 1, 'x-ended pane NOT stamped interrupted');
    const c9 = client();
    await c9.open();
    c9.send({ type: 'attach', paneid: lpane, recipe: locRec.id });
    const lready = await c9.await((m) => m.type === 'pane.ready' && m.paneid === lpane, 8000);
    eq(lready.restored, true, 'locate-test restore flagged');
    await sleep(300);
    const lrow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === lpane);
    eq(lrow.session_id, descendant, 'restore followed the lineage to the descendant (not banked, not contamination)');
    ok(engineLog.includes(`lineage moved ${banked}`), 'engine logged the lineage move');
    eq(lrow.interrupted, 0, 'respawn consumed the interrupted stamp');
    const dis = await (await fetch(BASE + '/api/interrupted/dismiss', { method: 'POST' })).json();
    ok(dis.ok === true && typeof dis.cleared === 'number', 'dismiss endpoint clears stamps');
    c9.send({ type: 'kill', paneid: lpane });
    await c9.await((m) => m.type === 'pane.exit' && m.paneid === lpane, 8000);
    console.log('\n[every pane says WHAT KIND of thing it is]');
    /* Owner could not tell whether an unnamed pane was "originating on web,
       subagents from agents, subprocesses from agents". The engine has always
       known and never said, so every row looked alike. Note what is NOT here:
       a subagent can never be a row at all — it runs inside a claude process
       and holds no PTY. */
    const kindRec = (await mkRecipe({
      name: 'Kind Test', target: 'local', projectDir: tmpDir, runClaude: false,
    })).recipe;
    const kpane = `recipe:${kindRec.id}`;
    const kc = client();
    await kc.open();
    kc.send({ type: 'attach', paneid: kpane, recipe: kindRec.id, label: 'kind' });
    await kc.await((m) => m.type === 'pane.ready' && m.paneid === kpane, 8000);

    const kcomp = client();
    await kcomp.open();
    const compPane = `comp-${Date.now()}`;
    kcomp.send({ type: 'attach', paneid: compPane, component: 'local-shell' });
    await kcomp.await((m) => m.type === 'pane.ready' && m.paneid === compPane, 8000);
    await sleep(400);

    const kinds = (await fetchJson('/api/table')).sessions;
    eq(kinds.find((x) => x.paneid === kpane).kind, 'project',
      'a recipe-backed session is a PROJECT pane');
    eq(kinds.find((x) => x.paneid === compPane).kind, 'component',
      'a workbench component pane says so, instead of looking like an unnamed session');

    kc.send({ type: 'kill', paneid: kpane });
    await kc.await((m) => m.type === 'pane.exit' && m.paneid === kpane, 8000);
    kcomp.send({ type: 'kill', paneid: compPane });
    await kcomp.await((m) => m.type === 'pane.exit' && m.paneid === compPane, 8000);
    kc.close(); kcomp.close();
    await fetch(`${BASE}/api/recipes/${kindRec.id}`, { method: 'DELETE' });


    console.log('\n[a session records WHICH PROJECT it belongs to, as data]');
    /* The association used to exist only as a substring of the primary key
       (`recipe:<id>`), which is exactly what caps a project at ONE session: the
       paneid IS the key, so a second session has nowhere to live. Reading a
       column asks the right question and returns the same answer today. */
    const projRec = (await mkRecipe({
      name: 'Project Link Test', target: 'local', projectDir: tmpDir, runClaude: false,
    })).recipe;
    const ppane = `recipe:${projRec.id}`;
    const pc = client();
    await pc.open();
    pc.send({ type: 'attach', paneid: ppane, recipe: projRec.id, label: 'proj-test' });
    await pc.await((m) => m.type === 'pane.ready' && m.paneid === ppane, 8000);
    await sleep(300);
    const linkRow = (await fetchJson('/api/table')).sessions.find((x) => x.paneid === ppane);
    eq(linkRow.recipe_id, projRec.id, 'a spawned session records its project id');
    ok(linkRow.paneid.includes(projRec.id),
      'the paneid still carries it too — this step is additive, nothing moved yet');
    pc.send({ type: 'kill', paneid: ppane });
    await pc.await((m) => m.type === 'pane.exit' && m.paneid === ppane, 8000);
    pc.close();
    /* The link must SURVIVE the session ending — history is per project, and a
       row whose process is gone still belongs somewhere. */
    await sleep(300);
    const linkDead = (await fetchJson('/api/table')).sessions.find((x) => x.paneid === ppane);
    eq(linkDead.recipe_id, projRec.id, 'and keeps it after the session ends');
    console.log('\n[project identity reaches every session, and PERSISTS]');
    /* The write-back only closed half the loop: it updated the RECIPE, so the
       next launch carried the new identity while every already-open sibling kept
       the old one. Invisible with one session per project; the first thing you
       notice with two. And a push alone is not enough — pane.ready serves the
       pane ROW, so an unpersisted push silently reverts on the next reattach. */
    const idRec = (await mkRecipe({
      name: 'Identity Fanout', target: 'local', projectDir: tmpDir, runClaude: false,
    })).recipe;
    const idA = `recipe:${idRec.id}`;
    const ia = client();
    await ia.open();
    ia.send({ type: 'attach', paneid: idA, recipe: idRec.id, label: 'A' });
    await ia.await((m) => m.type === 'pane.ready' && m.paneid === idA, 8000);

    const idFresh = await (
      await fetch(`${BASE}/api/recipes/${idRec.id}/launch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fresh: true }),
      })
    ).json();
    const ib = client();
    await ib.open();
    ib.send({ type: 'attach', paneid: idFresh.paneid, recipe: idRec.id, label: 'B' });
    await ib.await((m) => m.type === 'pane.ready' && m.paneid === idFresh.paneid, 8000);

    // Recolour from session A; session B must hear about it.
    ia.send({ type: 'setPrefs', paneid: idA, color: '#ff8800' });
    const fanout = await ib.await(
      (m) => m.type === 'pane.prefs' && m.paneid === idFresh.paneid, 5000);
    eq(fanout.prefs.color, '#ff8800', 'the sibling session is TOLD about the new colour');

    // ...and it must SURVIVE a reattach, which reads the row rather than the push.
    ib.close();
    await sleep(300);
    const ib2 = client();
    await ib2.open();
    ib2.send({ type: 'attach', paneid: idFresh.paneid, recipe: idRec.id, label: 'B-again' });
    const reready = await ib2.await(
      (m) => m.type === 'pane.ready' && m.paneid === idFresh.paneid, 8000);
    eq(reready.prefs.color, '#ff8800',
      'and it PERSISTED — a push without a write would revert here');

    // The project itself carries it, so the next launch does too.
    const idRecAfter = (await (await fetch(`${BASE}/api/recipes/${idRec.id}`)).json()).recipe;
    eq(idRecAfter.color, '#ff8800', 'and the PROJECT carries it for the next launch');

    ia.send({ type: 'kill', paneid: idA });
    await ia.await((m) => m.type === 'pane.exit' && m.paneid === idA, 8000);
    ib2.send({ type: 'kill', paneid: idFresh.paneid });
    await ib2.await((m) => m.type === 'pane.exit' && m.paneid === idFresh.paneid, 8000);
    ia.close(); ib2.close();
    await fetch(`${BASE}/api/recipes/${idRec.id}`, { method: 'DELETE' });

    await fetch(`${BASE}/api/recipes/${projRec.id}`, { method: 'DELETE' });
    console.log('\n[a SECOND session never re-resumes the project named conversation]');
    /* THE FORK HAZARD, closed. buildInvocation used to read r.resume/r.resumeName
       straight off the RECIPE, which was harmless while a project could only
       have one session — and became a correctness bug the moment it could have
       two: `+ New` on a named-resume project spawned a SECOND
       `claude --resume "<same name>"`, i.e. two processes appending to ONE
       transcript. Resume config is a SESSION fact now; the recipe only supplies
       the default for a project's PRIMARY pane. */
    const nrRec = (await mkRecipe({
      name: 'Named Fork Guard', target: 'local', projectDir: projDir, runClaude: true,
      resume: true, resumeName: 'the-one-conversation',
    })).recipe;
    const nrPrimary = `recipe:${nrRec.id}`;

    const nc = client();
    await nc.open();
    nc.send({ type: 'attach', paneid: nrPrimary, recipe: nrRec.id, label: 'primary' });
    await nc.await((m) => m.type === 'pane.ready' && m.paneid === nrPrimary, 8000);
    await sleep(300);
    const nrRow = (await fetchJson('/api/table')).sessions.find((x) => x.paneid === nrPrimary);
    eq(nrRow.resume_name, 'the-one-conversation',
      'the PRIMARY pane inherits the project resume name and REMEMBERS it');
    eq(nrRow.session_id, null, 'named resume still banks no uuid — the id is unknowable');

    const nrFresh = await (
      await fetch(`${BASE}/api/recipes/${nrRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fresh: true }),
      })
    ).json();
    const nc2 = client();
    await nc2.open();
    nc2.send({ type: 'attach', paneid: nrFresh.paneid, recipe: nrRec.id, label: 'second' });
    await nc2.await((m) => m.type === 'pane.ready' && m.paneid === nrFresh.paneid, 8000);
    await sleep(400);
    const nrRow2 = (await fetchJson('/api/table')).sessions.find((x) => x.paneid === nrFresh.paneid);
    eq(nrRow2.resume_name, null,
      'the SECOND session does NOT inherit the name — it is new work, not a copy');
    ok(!!nrRow2.session_id,
      `and it mints its own uuid instead (got ${nrRow2.session_id})`);
    ok(nrRow2.session_id !== nrRow.session_id, 'the two sessions are genuinely distinct');

    nc.send({ type: 'kill', paneid: nrPrimary });
    await nc.await((m) => m.type === 'pane.exit' && m.paneid === nrPrimary, 8000);
    nc2.send({ type: 'kill', paneid: nrFresh.paneid });
    await nc2.await((m) => m.type === 'pane.exit' && m.paneid === nrFresh.paneid, 8000);

    /* And a session the user ENDED must not come back by name either — the
       state gate now applies to the name branch, not just the uuid branch. */
    await sleep(300);
    const nc3 = client();
    await nc3.open();
    /* `spawn:true` = the deliberate relaunch this test is about. A page LOAD
       never sets it, which is what stops a woken browser re-creating an ended
       pane as an empty session (see spawnPermits). */
    nc3.send({ type: 'attach', paneid: nrPrimary, recipe: nrRec.id, label: 'after-end', spawn: true });
    await nc3.await((m) => m.type === 'pane.ready' && m.paneid === nrPrimary, 8000);
    await sleep(300);
    const nrAfter = (await fetchJson('/api/table')).sessions.find((x) => x.paneid === nrPrimary);
    ok(!!nrAfter.session_id,
      'a KILLED named-resume pane relaunches FRESH, it does not silently re-resume');
    nc3.send({ type: 'kill', paneid: nrPrimary });
    await nc3.await((m) => m.type === 'pane.exit' && m.paneid === nrPrimary, 8000);
    nc.close(); nc2.close(); nc3.close();
    await fetch(`${BASE}/api/recipes/${nrRec.id}`, { method: 'DELETE' });


    /* ---- a RELOAD must not resurrect an ended session (Owner, web, 2026-09-04)
       "when I return to the pane on the laptop ... it loads a new session in
       the same project which opens with no history. so then I'm left with an
       empty session in the cli manager." A page load sends exactly the attach a
       deliberate launch does, so the engine has to be told which is which. */
    /* ---- the tool's own status reaches its WINDOW, not just the manager
       (the design system window-chrome v20 `badge`). Owner could be working in a session
       whose sudo credential had expired with nothing on screen saying so. */
    console.log('\n[a tool status is pushed to the pane, not only to /api/table]');
    const wsDir = mkdtempSync(join(tmpdir(), 'wb-widget-'));
    const wsFile = join(wsDir, 'status.json');
    writeFileSync(wsFile, JSON.stringify({
      kind: 'warn', text: 'sudo warm - 12m left', ts: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 720,
    }), 'utf8');
    const wRec = (await mkRecipe({
      name: 'Widget Status Test', target: 'local', runClaude: 0, statusPath: wsFile,
    })).recipe;
    const wPane = `recipe:${wRec.id}`;
    const wc = client();
    await wc.open();
    wc.send({ type: 'attach', paneid: wPane, recipe: wRec.id, label: 'widget', spawn: true });
    await wc.await((m) => m.type === 'pane.ready' && m.paneid === wPane, 8000);
    /* The value, not merely the event: a cold cache legitimately has nothing to
       say yet, and the fact under test is that the line ARRIVES unprompted. */
    const pushed = await wc.await(
      (m) => m.type === 'pane.widget' && m.paneid === wPane && m.widget, 12000);
    eq(pushed.widget?.kind, 'warn', 'the pane is told the tool kind');
    eq(pushed.widget?.text, 'sudo warm - 12m left', 'and the tool text, verbatim');
    ok(Number.isFinite(pushed.widget?.expiresAt),
      `and expiresAt, passed through unread for the chrome's own clock (${pushed.widget?.expiresAt})`);
    /* The engine must NOT filter kind:'ok' — the chrome decides that
       (.n-ok{display:none}), and filtering here would fork the decision. */
    wc.send({ type: 'kill', paneid: wPane });
    await wc.await((m) => m.type === 'pane.exit' && m.paneid === wPane, 8000);
    wc.close();
    await fetch(`${BASE}/api/recipes/${wRec.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    console.log('\n[a reload does not re-create a session that ended]');
    const rlRec = (await mkRecipe({ name: 'Reload Guard', target: 'local', runClaude: 0 })).recipe;
    const rlPane = `recipe:${rlRec.id}`;
    const rl1 = client();
    await rl1.open();
    rl1.send({ type: 'attach', paneid: rlPane, recipe: rlRec.id, label: 'first', spawn: true });
    await rl1.await((m) => m.type === 'pane.ready' && m.paneid === rlPane, 8000);
    rl1.send({ type: 'kill', paneid: rlPane });
    await rl1.await((m) => m.type === 'pane.exit' && m.paneid === rlPane, 8000);
    rl1.close();
    await sleep(300);

    const rl2 = client(); // the woken tab: a bare attach, exactly as a reload sends
    await rl2.open();
    rl2.send({ type: 'attach', paneid: rlPane, recipe: rlRec.id, label: 'woken-tab' });
    const refusal = await rl2.await(
      (m) => m.type === 'pane.needs-launch' && m.paneid === rlPane, 8000);
    eq(refusal.state, 'killed', 'the reload is told WHY, and the row keeps its state');
    await sleep(300);
    const rlRow = (await fetchJson('/api/table')).sessions.find((x) => x.paneid === rlPane);
    eq(rlRow.state, 'killed', 'and no empty session was created in its place');
    rl2.close();

    const rl3 = client(); // the window's own Relaunch button is a human asking
    await rl3.open();
    rl3.send({ type: 'attach', paneid: rlPane, recipe: rlRec.id, label: 'relaunch', spawn: true });
    await rl3.await((m) => m.type === 'pane.ready' && m.paneid === rlPane, 8000);
    ok(true, 'an explicit relaunch is still allowed');
    rl3.send({ type: 'kill', paneid: rlPane });
    await rl3.await((m) => m.type === 'pane.exit' && m.paneid === rlPane, 8000);
    rl3.close();
    await fetch(`${BASE}/api/recipes/${rlRec.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });


    console.log('\n[a project can hold more than one session]');
    /* THE DEAD END: while a project was live or restorable the manager offered
       only "Open window" / "Restore", and no request meant "another session
       here" — Owner needed a second Home Hub session and opened a terminal
       instead. `fresh:true` mints a DISTINCT pane in the SAME project. */
    const multiRec = (await mkRecipe({
      name: 'Multi Session Test', target: 'local', projectDir: tmpDir, runClaude: false,
    })).recipe;
    const firstPane = `recipe:${multiRec.id}`;

    const mc = client();
    await mc.open();
    mc.send({ type: 'attach', paneid: firstPane, recipe: multiRec.id, label: 'first' });
    await mc.await((m) => m.type === 'pane.ready' && m.paneid === firstPane, 8000);

    const freshRes = await (
      await fetch(`${BASE}/api/recipes/${multiRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fresh: true }),
      })
    ).json();
    ok(freshRes.paneid !== firstPane,
      `a fresh launch mints a DIFFERENT pane (got ${freshRes.paneid})`);
    ok(freshRes.paneid.startsWith(`recipe:${multiRec.id}#`),
      'and the handle still says which project it belongs to');
    ok(freshRes.path.includes('pane='),
      'the solo url carries the explicit pane so the window drives the right one');

    const mc2 = client();
    await mc2.open();
    mc2.send({ type: 'attach', paneid: freshRes.paneid, recipe: multiRec.id, label: 'second' });
    await mc2.await((m) => m.type === 'pane.ready' && m.paneid === freshRes.paneid, 8000);
    await sleep(400);
    const mineNow = (await fetchJson('/api/table')).sessions
      .filter((x) => x.recipe_id === multiRec.id && x.state === 'live');
    eq(mineNow.length, 2, 'the project now holds TWO live sessions');

    const bothRes = await (
      await fetch(`${BASE}/api/recipes/${multiRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fresh: true, resume: true }),
      })
    ).json();
    eq(bothRes.paneid, firstPane,
      'fresh+resume is NOT fresh — it targets the primary pane, not a new one');

    /* Owner, 2026-09-02: "i have two briefing-table project sessions open in cli
       manager, but i can't access them both." The live strip sent only the
       recipe id, so BOTH rows resolved to the project's primary pane and "Open
       window" opened the same conversation whichever row he clicked. Naming the
       pane is what tells them apart. */
    const openSecond = await (
      await fetch(`${BASE}/api/recipes/${multiRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: freshRes.paneid }),
      })
    ).json();
    eq(openSecond.paneid, freshRes.paneid, 'naming a pane opens THAT session');
    ok(openSecond.path.includes(encodeURIComponent(freshRes.paneid)),
      'and its solo url drives that pane, not the project default');

    const openFirst = await (
      await fetch(`${BASE}/api/recipes/${multiRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: firstPane }),
      })
    ).json();
    eq(openFirst.paneid, firstPane, 'the primary stays reachable alongside it');

    const bogusRes = await (
      await fetch(`${BASE}/api/recipes/${multiRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: `recipe:${multiRec.id}#deadbeef` }),
      })
    ).json();
    eq(bogusRes.paneid, firstPane,
      'a pane handle with no row falls back to the primary — never invented');

    mc.send({ type: 'kill', paneid: firstPane });
    await mc.await((m) => m.type === 'pane.exit' && m.paneid === firstPane, 8000);
    mc2.send({ type: 'kill', paneid: freshRes.paneid });
    await mc2.await((m) => m.type === 'pane.exit' && m.paneid === freshRes.paneid, 8000);
    mc.close(); mc2.close();
    await fetch(`${BASE}/api/recipes/${multiRec.id}`, { method: 'DELETE' });

    console.log('\n[auth: reaching the engine is not being allowed to drive it]');
    /* This engine spawns shells on two machines. These assertions are the
       standing proof that the gate is actually wired — a regression that
       disables it would otherwise pass every other test in this file. */
    const noAuth = await realFetch(`${BASE}/api/table`);
    eq(noAuth.status, 401, 'API without a token is refused');
    const openHealth = await realFetch(`${BASE}/health`);
    eq(openHealth.status, 200, '/health stays public (harbor polls it, carries no secrets)');

    const wrongTok = await realFetch(`${BASE}/api/table`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    eq(wrongTok.status, 401, 'a WRONG bearer token is refused');

    // The WS upgrade is the one that matters most — it is the pty channel.
    const rawWs = new WebSocket(WS_URL);
    const wsOutcome = await new Promise((resolve) => {
      rawWs.on('open', () => resolve('opened'));
      rawWs.on('error', () => resolve('refused'));
    });
    eq(wsOutcome, 'refused', 'unauthenticated WS upgrade is refused (no socket, no pane)');

    // Browser half: POST the token, get a cookie, and the cookie then works.
    const badLogin = await realFetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'wrong' }).toString(),
      redirect: 'manual',
    });
    ok(!badLogin.headers.get('set-cookie'), 'a failed login sets NO cookie');

    const goodLogin = await realFetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TEST_TOKEN }).toString(),
      redirect: 'manual',
    });
    const setCookie = goodLogin.headers.get('set-cookie') || '';
    ok(/wb_auth=/.test(setCookie), 'a good login sets the auth cookie');
    ok(/HttpOnly/i.test(setCookie), 'cookie is HttpOnly (script cannot read it)');
    ok(!setCookie.includes(TEST_TOKEN), 'cookie carries a DERIVED value, never the raw token');

    /* One-time tickets authenticate a window the ENGINE itself opened (the host's
       WebView2 has no cookie on first run). A FORGED one must be worthless —
       this is the assertion that keeps the ticket from becoming a bypass. */
    const forged = await realFetch(`${BASE}/api/table?ticket=not-a-real-ticket`, {
      redirect: 'manual',
    });
    ok(!forged.headers.get('set-cookie'), 'a forged ticket sets NO cookie');
    /* A present-but-invalid ticket is STRIPPED and bounced (303) rather than
       left in the address, because the window host republishes tab URLs on an
       unauthenticated endpoint. The bounce must not grant anything: following
       it still hits the gate. */
    eq(forged.status, 303, 'a stale/forged ticket is stripped and bounced');
    const bounced = forged.headers.get('location') || '';
    ok(!bounced.includes('ticket'), `the bounce carries no ticket (got ${bounced})`);
    const followed = await realFetch(`${BASE}${bounced}`, { redirect: 'manual' });
    ok(followed.status === 401 || followed.status === 302,
      `following a forged ticket still hits the gate (got ${followed.status})`);

    /* The strip must not corrupt the rest of the query — it is string surgery,
       not a URL round trip, precisely so a nested encoded url survives. */
    const nested = encodeURIComponent('http://127.0.0.1:7420/solo.html?recipe=a!b(c)d*e');
    const kept = await realFetch(`${BASE}/shell.html?tabs=${nested}&ticket=bogus`, {
      redirect: 'manual',
    });
    eq(kept.headers.get('location'), `/shell.html?tabs=${nested}`,
      'stripping the ticket leaves every other byte untouched');

    const cookieOnly = setCookie.split(';')[0];
    const viaCookie = await realFetch(`${BASE}/api/table`, { headers: { cookie: cookieOnly } });
    eq(viaCookie.status, 200, 'the cookie authorizes subsequent requests');

    console.log('\n[control lease: one keyboard, many screens]');
    /* THE RULE (Owner, 2026-08-19): exactly one machine drives a session at a
       time. Before the lease a second attach did `existing.socket = ws` and the
       displaced viewer was NEVER told — screen frozen, keystrokes still landing
       in the pty. These tests exist so that cannot come back. */
    const leaseRec = (await mkRecipe({
      name: 'Lease Test', target: 'local', projectDir: tmpDir, runClaude: false,
    })).recipe;
    const lpaneC = `recipe:${leaseRec.id}`;

    const vrpc = client();
    await vrpc.open();
    vrpc.send({ type: 'attach', paneid: lpaneC, recipe: leaseRec.id, label: 'VRPC window' });
    await vrpc.await((m) => m.type === 'pane.ready' && m.paneid === lpaneC, 8000);
    const firstCtl = await vrpc.await((m) => m.type === 'pane.control' && m.paneid === lpaneC, 4000);
    ok(firstCtl.controlling === true, 'first viewer holds control');

    // A VIEW-ONLY attach must not steal the keyboard.
    const ipad = client();
    await ipad.open();
    ipad.send({ type: 'attach', paneid: lpaneC, recipe: leaseRec.id, intent: 'view', label: 'iPad' });
    await ipad.await((m) => m.type === 'pane.ready' && m.paneid === lpaneC, 8000);
    const watch = await ipad.await((m) => m.type === 'pane.control' && m.paneid === lpaneC, 4000);
    ok(watch.controlling === false, 'view-only attach does NOT take control');
    ok(/^VRPC window · /.test(watch.holder),
      `view-only viewer is told who holds it (got "${watch.holder}")`);

    // ...but it DOES receive output — that is the point of a read-only viewer.
    vrpc.send({ type: 'input', paneid: lpaneC, data: 'echo lease-probe\r' });
    await ipad.await(
      (m) => m.type === 'pane.data' && m.paneid === lpaneC && /lease-probe/.test(m.data), 8000);
    ok(true, 'read-only viewer still receives pty output');

    // A view-only viewer that tries to type is REFUSED BY THE ENGINE.
    ipad.send({ type: 'input', paneid: lpaneC, data: 'echo forbidden-ipad\r' });
    const denied = await ipad.await((m) => m.type === 'pane.control-denied' && m.paneid === lpaneC, 4000);
    eq(denied.command, 'input', 'engine refuses input from a non-controller');
    ok(/^VRPC window · /.test(denied.holder), `refusal names the holder (got "${denied.holder}")`);

    // Taking control pauses the previous holder — explicitly, not silently.
    ipad.send({ type: 'takeControl', paneid: lpaneC, label: 'laptop' });
    const lost = await vrpc.await((m) => m.type === 'pane.control-lost' && m.paneid === lpaneC, 4000);
    ok(/^laptop · /.test(lost.holder), `displaced holder is TOLD who took over (got "${lost.holder}")`);
    const nowCtl = await ipad.await(
      (m) => m.type === 'pane.control' && m.paneid === lpaneC && m.controlling === true, 4000);
    ok(nowCtl.controlling === true, 'the asker now holds control');

    // And the displaced one can no longer write, even though its socket is fine.
    vrpc.send({ type: 'input', paneid: lpaneC, data: 'echo forbidden-vrpc\r' });
    const denied2 = await vrpc.await((m) => m.type === 'pane.control-denied' && m.paneid === lpaneC, 4000);
    ok(/^laptop · /.test(denied2.holder),
      `the paused machine is refused and told who has it (got "${denied2.holder}")`);
    /* The engine appends WHERE the socket came from, because a client can only
       describe itself: two machines on the same OS both say "Windows browser",
       so the self-description alone never answers "which machine has it". */
    ok(/ · /.test(denied2.holder), 'holder label carries the engine-resolved device');

    // Neither refused keystroke may have reached the pty.
    const peeked = await fetchJson(`/api/sessions/${encodeURIComponent(lpaneC)}/peek`);
    const seen = JSON.stringify(peeked);
    ok(!/forbidden-ipad/.test(seen), 'refused view-only input never reached the pty');
    ok(!/forbidden-vrpc/.test(seen), 'refused paused-holder input never reached the pty');

    /* RECLAIM — what a RECONNECT must send. It resolves against the CURRENT
       holder, because the client cannot know whether anyone took over while it
       was away. A bare attach here (the old behaviour) is how a browser waking
       from hibernation silently stole a live session. */
    const away = client();
    await away.open();
    away.send({ type: 'attach', paneid: lpaneC, recipe: leaseRec.id, intent: 'reclaim', label: 'woken laptop' });
    await away.await((m) => m.type === 'pane.ready' && m.paneid === lpaneC, 8000);
    const reclaimBusy = await away.await(
      (m) => m.type === 'pane.control' && m.paneid === lpaneC, 4000);
    eq(reclaimBusy.controlling, false,
      'reclaim does NOT take control while someone else holds it');
    ok(/^laptop · /.test(reclaimBusy.holder), 'and it is told who actually has it');
    away.send({ type: 'input', paneid: lpaneC, data: 'echo forbidden-reclaim\r' });
    await away.await((m) => m.type === 'pane.control-denied' && m.paneid === lpaneC, 4000);
    ok(true, 'a reclaiming viewer still cannot write while another holds control');
    away.close();

    // Control is RELEASED on disconnect, never silently inherited.
    ipad.close();
    await sleep(400);
    const released = await fetchJson('/api/table');
    const leaseRow = released.sessions.find((x) => x.paneid === lpaneC);
    eq(leaseRow.controller, null, 'controller leaving releases control (no silent inheritance)');

    /* ...and NOW the lease is free, so reclaim resolves against WHO WAS DRIVING.
       Free-because-nobody-is-there and free-because-the-engine-restarted look
       identical in memory, and treating them alike handed Owner's live session
       to whichever client reconnected first (2026-08-31). */
    const stranger = client();
    await stranger.open();
    stranger.send({ type: 'attach', paneid: lpaneC, recipe: leaseRec.id, intent: 'reclaim', label: 'some other machine' });
    await stranger.await((m) => m.type === 'pane.ready' && m.paneid === lpaneC, 8000);
    const denied3 = await stranger.await(
      (m) => m.type === 'pane.control' && m.paneid === lpaneC, 4000);
    eq(denied3.controlling, false,
      'a DIFFERENT machine does not win a free lease by reconnecting first');
    ok(/^laptop · /.test(denied3.lastHolder),
      `and it is told who WAS driving (got ${denied3.lastHolder})`);
    stranger.close();
    await sleep(300);

    /* The machine that WAS driving gets it straight back, with no click — the
       network-blip case must stay frictionless. */
    const back = client();
    await back.open();
    back.send({ type: 'attach', paneid: lpaneC, recipe: leaseRec.id, intent: 'reclaim', label: 'laptop' });
    await back.await((m) => m.type === 'pane.ready' && m.paneid === lpaneC, 8000);
    const regained = await back.await(
      (m) => m.type === 'pane.control' && m.paneid === lpaneC, 4000);
    eq(regained.controlling, true, 'the machine that WAS driving reclaims it with no friction');
    back.close();
    await sleep(300);
    ok(leaseRow.attached === true, 'the remaining viewer still counts as attached');

    vrpc.send({ type: 'kill', paneid: lpaneC });
    await vrpc.await((m) => m.type === 'pane.control-denied' || m.type === 'pane.exit', 4000);
    vrpc.close();
    await fetch(`${BASE}/api/recipes/${leaseRec.id}`, { method: 'DELETE' });

    console.log('\n[placement: the per-window Manager asks, the ENGINE decides]');
    /* ONE WINDOW PER PTY is enforced in the engine, not by there being a single
       Manager (Owner, 2026-08-18). A Manager embedded in a shell window posts
       target:'tab' to ask for local placement; the reply must always carry an
       explicit `placement` so the caller never has to guess — and a caller that
       does not ask still gets a window, unchanged. */
    const tabPlace = await (
      await fetch(`${BASE}/api/recipes/${locRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'tab' }),
      })
    ).json();
    ok(tabPlace.ok === true, 'target:tab launch accepted');
    eq(tabPlace.placement, 'tab', 'nothing on screen -> engine grants local tab placement');
    ok(typeof tabPlace.url === 'string' && tabPlace.url.includes('solo.html'), 'tab placement carries the url to mount');
    const winPlace = await (
      await fetch(`${BASE}/api/recipes/${locRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json();
    eq(winPlace.placement, 'window', 'a caller that does not ask for a tab still gets a window');

    /* THE RULE, in every shape a session can wear on screen. A miss here reads
       as "not showing" and hands out a SECOND view of one pty — which is how
       the bare-url shape slipped through live on 2026-08-19 (a window opened
       directly on the session url, no tabs, url===soloUrl). */
    const probeUrl = tabPlace.url;
    const shapes = [
      ['a TAB inside a shell window', [{ id: 'wA', url: 'http://x/shell.html', tabs: [{ url: probeUrl }] }], 'wA'],
      ['wrapped by a shell (?tabs=<encoded>)', [{ id: 'wB', url: `http://x/shell.html?tabs=${encodeURIComponent(probeUrl)}`, tabs: [] }], 'wB'],
      ['the window OWN url, verbatim', [{ id: 'wC', url: probeUrl, tabs: [] }], 'wC'],
    ];
    for (const [label, inventory, expectId] of shapes) {
      fakeWindows = inventory;
      fakeFocused = null;
      const r = await (
        await fetch(`${BASE}/api/recipes/${locRec.id}/launch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'tab' }),
        })
      ).json();
      eq(r.placement, 'focused', `already showing as ${label} → no second view`);
      eq(fakeFocused, expectId, `focused the window actually holding it (${label})`);
    }
    /* A BROWSER surface is not in the window host's inventory and never can be,
       so a session showing on the VRPC must NOT block a remote viewer from
       opening its own view. The control lease governs the conflict, not
       placement — this is the "pause the VRPC when I pick up the laptop" case. */
    fakeWindows = [{ id: 'wD', url: probeUrl, tabs: [] }];
    const browserPlace = await (
      await fetch(`${BASE}/api/recipes/${locRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'tab', surface: 'browser' }),
      })
    ).json();
    eq(browserPlace.placement, 'tab', 'a browser surface places locally even while a VRPC window shows it');
    ok(browserPlace.path?.startsWith('/solo.html'),
      `browser placement carries a RELATIVE path (got ${browserPlace.path})`);
    ok(!browserPlace.path?.includes('127.0.0.1'),
      'the relative path has no loopback host — it resolves against the CLIENT origin');
    /* TWO SESSIONS OF ONE PROJECT MUST NOT BE DEDUPED INTO EACH OTHER.
       The second session's url CONTAINS the first's verbatim
       (`?recipe=X` vs `?recipe=X&pane=…`), so substring matching focused the
       WRONG conversation — right project, wrong session. The match is on the
       derived PANE now, not on url text. */
    const sessA = probeUrl;                                   // primary pane
    const paneB = `recipe:${locRec.id}#deadbeef`;
    const sessB = `${probeUrl}&pane=${encodeURIComponent(paneB)}`;

    fakeWindows = [{ id: 'wB', url: sessB, tabs: [] }];       // only B is on screen
    const askA = await (
      await fetch(`${BASE}/api/recipes/${locRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'tab' }),
      })
    ).json();
    eq(askA.placement, 'tab',
      'the PRIMARY session is not deduped into a DIFFERENT session of the same project');

    fakeWindows = [{ id: 'wA', url: sessA, tabs: [] }];       // only A is on screen
    fakeFocused = null;
    const askA2 = await (
      await fetch(`${BASE}/api/recipes/${locRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'tab' }),
      })
    ).json();
    eq(askA2.placement, 'focused', 'but the SAME session still focuses its own window');
    eq(fakeFocused, 'wA', 'and focuses the right one');

    /* A shell WRAPPER carrying the second session must also resolve to B, not A. */
    fakeWindows = [{ id: 'wW', url: `http://x/app/shell.html?tabs=${encodeURIComponent(sessB)}`, tabs: [] }];
    const askA3 = await (
      await fetch(`${BASE}/api/recipes/${locRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'tab' }),
      })
    ).json();
    eq(askA3.placement, 'tab',
      'a wrapped second session does not swallow the primary either');

    fakeWindows = [];

    console.log('\n[recently closed: explicit resume of a ✕-ended session]');
    await sleep(300);
    eq((await fetchJson('/api/table')).sessions.find((s) => s.paneid === lpane).state, 'killed', 'pane killed after ✕');
    const relaunch = await (
      await fetch(`${BASE}/api/recipes/${locRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resume: true }),
      })
    ).json();
    ok(relaunch.ok === true, 'resume-launch accepted');
    eq((await fetchJson('/api/table')).sessions.find((s) => s.paneid === lpane).state, 'dehydrated', 'killed row rehydrated to dehydrated by explicit resume');
    c9.close();
    const c10 = client(); // fresh client — c9's backlog holds stale lpane events
    await c10.open();
    c10.send({ type: 'attach', paneid: lpane, recipe: locRec.id });
    const rcready = await c10.await((m) => m.type === 'pane.ready' && m.paneid === lpane, 8000);
    eq(rcready.restored, true, 'attach after resume-launch restores by uuid');
    await sleep(300);
    eq((await fetchJson('/api/table')).sessions.find((s) => s.paneid === lpane).session_id, descendant, 'resume kept the located uuid');
    c10.send({ type: 'kill', paneid: lpane });
    await c10.await((m) => m.type === 'pane.exit' && m.paneid === lpane, 8000);
    c10.close();
    await fetch(`${BASE}/api/recipes/${locRec.id}`, { method: 'DELETE' });

    /* ============ M7: manager v2 engine surface ============ */

    console.log('\n[sessions endpoint: titles extracted, headless excluded]');
    const pickDir = join(tmpDir, 'proj-picker');
    mkdirSync(pickDir, { recursive: true });
    const pickEnc = join(tmpDir, 'claude-projects', pickDir.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(pickEnc, { recursive: true });
    const sOld = 'aaaaaaaa-1111-4111-8111-111111111111';
    const sNew = 'bbbbbbbb-2222-4222-8222-222222222222';
    const sHeadless = 'cccccccc-3333-4333-8333-333333333333';
    // Slash-command-only session (written first = oldest): no titles, no
    // last-prompt — the firstCommand fallback labels it "/exit" like native
    // /resume ([ref]).
    const sCmd = 'dddddddd-4444-4444-8444-444444444444';
    writeFileSync(join(pickEnc, `${sCmd}.jsonl`),
      `{"type":"system","subtype":"local_command","content":"<command-name>/exit</command-name>\\n<command-message>exit</command-message>","sessionId":"${sCmd}"}\n`);
    await sleep(30);
    writeFileSync(join(pickEnc, `${sOld}.jsonl`),
      `{"type":"ai-title","aiTitle":"Auto Title Old","sessionId":"${sOld}"}\n{"type":"last-prompt","lastPrompt":"old prompt","sessionId":"${sOld}"}\n`);
    await sleep(30);
    writeFileSync(join(pickEnc, `${sNew}.jsonl`),
      `{"type":"ai-title","aiTitle":"Auto Title New","sessionId":"${sNew}"}\n{"type":"custom-title","customTitle":"My Renamed Session","sessionId":"${sNew}"}\n{"type":"user","gitBranch":"wt/feature-branch","sessionId":"${sNew}"}\n{"type":"last-prompt","lastPrompt":"newest prompt","sessionId":"${sNew}"}\n`);
    await sleep(30);
    writeFileSync(join(pickEnc, `${sHeadless}.jsonl`),
      `{"type":"user","message":{},"entrypoint":"sdk-cli","sessionId":"${sHeadless}"}\n`);
    const pickRec = (await mkRecipe({ name: 'Picker Test', target: 'local', projectDir: pickDir, runClaude: true })).recipe;
    const sess = (await fetchJson(`/api/recipes/${pickRec.id}/sessions`)).sessions;
    eq(sess.length, 3, 'headless (sdk-cli) session excluded');
    const cmdSess = sess.find((s) => s.sessionId === sCmd);
    eq(cmdSess.title, null, 'command-only session has no title');
    eq(cmdSess.lastPrompt, null, 'slash commands write no last-prompt line');
    eq(cmdSess.firstCommand, '/exit', 'firstCommand fallback extracted (#1478)');
    eq(sess.find((s) => s.sessionId === sNew).firstCommand, null, 'no command → firstCommand null');
    eq(sess[0].sessionId, sNew, 'newest session first');
    eq(sess[0].title, 'My Renamed Session', 'custom-title (/rename) wins over ai-title');
    eq(sess[0].lastPrompt, 'newest prompt', 'last-prompt extracted');
    eq(sess[0].branch, 'wt/feature-branch', 'gitBranch extracted');
    ok(sess[0].sizeBytes > 0, 'transcript size reported');
    eq(sess[1].title, 'Auto Title Old', 'ai-title fallback when no custom-title');

    console.log('\n[picker resume: launch {resumeSessionId} stamps the row]');
    const pl = await (
      await fetch(`${BASE}/api/recipes/${pickRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resumeSessionId: sOld }),
      })
    ).json();
    ok(pl.ok === true, 'picker launch accepted');
    const prow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === `recipe:${pickRec.id}`);
    eq(prow.state, 'dehydrated', 'picker resume stamped dehydrated');
    eq(prow.session_id, sOld, 'picker resume banked the CHOSEN uuid');
    const c11 = client();
    await c11.open();
    c11.send({ type: 'attach', paneid: `recipe:${pickRec.id}`, recipe: pickRec.id });
    const pready = await c11.await((m) => m.type === 'pane.ready' && m.paneid === `recipe:${pickRec.id}`, 8000);
    eq(pready.restored, true, 'picker-stamped pane restores on attach');
    c11.send({ type: 'kill', paneid: `recipe:${pickRec.id}` });
    await c11.await((m) => m.type === 'pane.exit' && m.paneid === `recipe:${pickRec.id}`, 8000);
    c11.close();

    console.log('\n[picker resume never writes over a LIVE pane (2026-09-18)]');
    /* The 2026-09-02 fix reached "Open window" and "Resume" on the live strip
       and the recent list; the picker kept resolving to the project's PRIMARY
       pane — and with that pane live, it wrote the picked uuid and `dehydrated`
       over the live row, then focused that window. Owner: "it grabs the active
       one". Bring the primary up live, then pick a DIFFERENT transcript. */
    const launchPick = (body) =>
      fetch(`${BASE}/api/recipes/${pickRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    ok((await launchPick({})).ok === true, 'plain launch grants the primary its permit');
    const cLivePick = client();
    await cLivePick.open();
    cLivePick.send({ type: 'attach', paneid: `recipe:${pickRec.id}`, recipe: pickRec.id });
    await cLivePick.await((m) => m.type === 'pane.ready' && m.paneid === `recipe:${pickRec.id}`, 8000);
    const liveRow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === `recipe:${pickRec.id}`);
    eq(liveRow.state, 'live', 'primary pane is live before the pick');
    const liveSid = liveRow.session_id;
    const panesBefore = (await fetchJson('/api/table')).sessions.filter((s) => s.recipe_id === pickRec.id).length;
    const pl2 = await launchPick({ resumeSessionId: sNew });
    ok(pl2.ok === true, 'picker launch against a live primary accepted');
    ok(pl2.paneid !== `recipe:${pickRec.id}`, 'picker resume did NOT target the live primary');
    ok(pl2.paneid.startsWith(`recipe:${pickRec.id}#`), 'picker resume minted a pane in the same project');
    ok(pl2.path.includes(`pane=${encodeURIComponent(pl2.paneid)}`), 'launch url names the minted pane');
    const afterPick = (await fetchJson('/api/table')).sessions;
    const stillLive = afterPick.find((s) => s.paneid === `recipe:${pickRec.id}`);
    eq(stillLive.state, 'live', 'primary row untouched: still live');
    eq(stillLive.session_id, liveSid, 'primary row untouched: same session id');
    const minted = afterPick.find((s) => s.paneid === pl2.paneid);
    eq(minted.state, 'dehydrated', 'minted pane stamped dehydrated');
    eq(minted.session_id, sNew, 'minted pane banks the picked uuid');
    /* One transcript, one pane: picking it again reuses the pane it already
       has rather than minting a third (`--resume` twice on one file). */
    const pl3 = await launchPick({ resumeSessionId: sNew });
    eq(pl3.paneid, pl2.paneid, 'second pick of one transcript reuses its pane');
    const panesAfter = (await fetchJson('/api/table')).sessions.filter((s) => s.recipe_id === pickRec.id).length;
    eq(panesAfter, panesBefore + 1, 'exactly one pane minted across two picks');
    /* Picking the LIVE session's own uuid opens that pane and writes nothing. */
    const pl4 = await launchPick({ resumeSessionId: liveSid });
    eq(pl4.paneid, `recipe:${pickRec.id}`, 'picking the live session resolves to its own pane');
    const liveAgain = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === `recipe:${pickRec.id}`);
    eq(liveAgain.state, 'live', 'picking the live session leaves it live');
    eq(liveAgain.session_id, liveSid, 'picking the live session leaves its id alone');
    cLivePick.send({ type: 'kill', paneid: `recipe:${pickRec.id}` });
    await cLivePick.await((m) => m.type === 'pane.exit' && m.paneid === `recipe:${pickRec.id}`, 8000);
    cLivePick.close();
    await fetch(`${BASE}/api/recipes/${pickRec.id}`, { method: 'DELETE' });

    console.log('\n[model override: launch body → solo URL; attach types --model]');
    const modRec = (await mkRecipe({ name: 'Model Override Test', target: 'local', projectDir: tmpDir, runClaude: true })).recipe;
    const ml = await (
      await fetch(`${BASE}/api/recipes/${modRec.id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fable' }),
      })
    ).json();
    ok(ml.url.includes('model=fable'), 'solo URL carries the model override');
    const c12 = client();
    await c12.open();
    c12.send({ type: 'attach', paneid: `recipe:${modRec.id}`, recipe: modRec.id, model: 'fable' });
    await c12.await((m) => m.type === 'pane.ready' && m.paneid === `recipe:${modRec.id}`, 8000);
    // The injected command is typed VISIBLY into the shell — read it back from
    // the ACCUMULATED pane.data (ConPTY chunks the echo arbitrarily, so no
    // single frame is guaranteed to contain the whole string).
    let modelSeen = false;
    for (let i = 0; i < 40 && !modelSeen; i++) {
      // strip ANSI (PSReadLine colorizes typed input with escape sequences
      // interleaved mid-word) and all whitespace before matching
      const joined = c12.log
        .filter((m) => m.type === 'pane.data' && m.paneid === `recipe:${modRec.id}`)
        .map((m) => m.data)
        .join('')
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\s+/g, '');
      modelSeen = joined.includes('--modelfable');
      if (!modelSeen) {
        await sleep(250);
      }
    }
    ok(modelSeen, 'attach with model override typed `--model fable` into the shell');
    c12.send({ type: 'kill', paneid: `recipe:${modRec.id}` });
    await c12.await((m) => m.type === 'pane.exit' && m.paneid === `recipe:${modRec.id}`, 8000);
    c12.close();
    await fetch(`${BASE}/api/recipes/${modRec.id}`, { method: 'DELETE' });

    console.log('\n[Other CLI: initCmd typed into the shell]');
    const otherRec = (await mkRecipe({ name: 'Other CLI Test', target: 'local', projectDir: tmpDir, runClaude: false, initCmd: 'echo WB_INITCMD_OK' })).recipe;
    eq(otherRec.initCmd, 'echo WB_INITCMD_OK', 'initCmd stored on the recipe');
    const c13 = client();
    await c13.open();
    c13.send({ type: 'attach', paneid: `recipe:${otherRec.id}`, recipe: otherRec.id });
    await c13.await((m) => m.type === 'pane.ready' && m.paneid === `recipe:${otherRec.id}`, 8000);
    await c13.await((m) => m.type === 'pane.data' && m.paneid === `recipe:${otherRec.id}` && m.data.includes('WB_INITCMD_OK'), 8000);
    ok(true, 'initCmd executed in the pane');
    const orow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === `recipe:${otherRec.id}`);
    eq(orow.vendor, 'cli-manager', 'Other-CLI pane stays vendor cli-manager (not resumable)');
    c13.send({ type: 'kill', paneid: `recipe:${otherRec.id}` });
    await c13.await((m) => m.type === 'pane.exit' && m.paneid === `recipe:${otherRec.id}`, 8000);
    c13.close();

    console.log('\n[park (hide verb): window closes, session survives the close grace]');
    const pkRec = (await mkRecipe({ name: 'Park Test', target: 'local', projectDir: tmpDir, runClaude: false })).recipe;
    const pkPane = `recipe:${pkRec.id}`;
    const cPk = client();
    await cPk.open();
    cPk.send({ type: 'attach', paneid: pkPane, recipe: pkRec.id });
    await cPk.await((m) => m.type === 'pane.ready' && m.paneid === pkPane, 8000);
    cPk.send({ type: 'park', paneid: pkPane });
    await sleep(150);
    cPk.close(); // window gone
    await sleep(1600); // well past the test grace
    const pkRow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === pkPane);
    eq(pkRow.state, 'live', 'parked session survived the close grace (still live)');
    const cPk2 = client();
    await cPk2.open();
    cPk2.send({ type: 'attach', paneid: pkPane, recipe: pkRec.id });
    const pkReady = await cPk2.await((m) => m.type === 'pane.ready' && m.paneid === pkPane, 8000);
    eq(pkReady.reattached, true, '"Open window" reattaches the parked session');
    // CLOSE-KILL RETIRED (2026-08-09): a plain close DETACHES, never kills —
    // the window-host incident proved a vanished viewer is not consent. Only
    // an explicit End kills.
    cPk2.close();
    await sleep(1600);
    eq(
      (await fetchJson('/api/table')).sessions.find((s) => s.paneid === pkPane).state,
      'live',
      'plain close no longer kills — session survives a vanished window',
    );
    const cPk3 = client();
    await cPk3.open();
    cPk3.send({ type: 'attach', paneid: pkPane, recipe: pkRec.id });
    await cPk3.await((m) => m.type === 'pane.ready' && m.paneid === pkPane, 8000);
    cPk3.send({ type: 'kill', paneid: pkPane });
    await cPk3.await((m) => m.type === 'pane.exit' && m.paneid === pkPane, 8000);
    eq(
      (await fetchJson('/api/table')).sessions.find((s) => s.paneid === pkPane).state,
      'killed',
      'explicit End still kills (the only path that destroys a session)',
    );
    cPk3.close();
    await fetch(`${BASE}/api/recipes/${pkRec.id}`, { method: 'DELETE' });

    console.log('\n[activity states (ticket): streaming → idle decay, hooks → question/idle]');
    const actRec = (await mkRecipe({ name: 'Activity Test', target: 'local', projectDir: tmpDir, runClaude: false })).recipe;
    const actPane = `recipe:${actRec.id}`;
    const c14 = client();
    await c14.open();
    c14.send({ type: 'attach', paneid: actPane, recipe: actRec.id });
    const aready = await c14.await((m) => m.type === 'pane.ready' && m.paneid === actPane, 8000);
    eq(aready.activity, 'idle', 'pane.ready carries activity (idle at spawn)');
    // Burst well past STREAM_MIN_BYTES so streaming fires even if the shell
    // banner alone didn't; then the 400ms test decay lands it back on idle.
    c14.send({ type: 'input', paneid: actPane, data: "1..40 | ForEach-Object { 'WB_ACT_' + ('x' * 40) }\r" });
    await c14.await((m) => m.type === 'pane.state' && m.paneid === actPane && m.state === 'streaming', 8000);
    ok(true, 'output burst → pane.state streaming');
    await c14.await((m) => m.type === 'pane.state' && m.paneid === actPane && m.state === 'idle', 8000);
    ok(true, 'quiet → streaming decays to idle');
    const arow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === actPane);
    const hk = await (
      await fetch(`${BASE}/api/claude-hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: arow.session_id, hook_event_name: 'Notification' }),
      })
    ).json();
    eq(hk.matched, actPane, 'hook sink matched session_id → paneid');
    await c14.await((m) => m.type === 'pane.state' && m.paneid === actPane && m.state === 'waiting', 8000);
    ok(true, 'Notification hook → question state');
    eq(
      (await fetchJson('/api/table')).sessions.find((s) => s.paneid === actPane).activity,
      'waiting',
      '/api/table decorated with activity',
    );
    await fetch(`${BASE}/api/claude-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: arow.session_id, hook_event_name: 'Stop' }),
    });
    // c14.await scans backlog (the earlier idle event would satisfy it) — poll
    // the decorated table instead for the post-Stop transition.
    let backIdle = false;
    for (let i = 0; i < 20 && !backIdle; i++) {
      backIdle = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === actPane)?.activity === 'idle';
      if (!backIdle) {
        await sleep(150);
      }
    }
    ok(backIdle, 'Stop hook → back to idle');
    /* v21 TURN SIGNAL: UserPromptSubmit starts a turn (busy = the `streaming`
       token) with no bytes at all; Stop ends it. Polled from the decorated
       table for the same backlog reason as above. */
    const pollActivity = async (want) => {
      for (let i = 0; i < 20; i++) {
        if ((await fetchJson('/api/table')).sessions.find((s) => s.paneid === actPane)?.activity === want) {
          return true;
        }
        await sleep(150);
      }
      return false;
    };
    const hkTurn = await (
      await fetch(`${BASE}/api/claude-hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: arow.session_id, hook_event_name: 'UserPromptSubmit' }),
      })
    ).json();
    eq(hkTurn.matched, actPane, 'UserPromptSubmit hook matched session_id → paneid');
    ok(await pollActivity('streaming'), 'UserPromptSubmit hook → streaming (a turn is running)');
    await fetch(`${BASE}/api/claude-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: arow.session_id, hook_event_name: 'Stop' }),
    });
    ok(await pollActivity('idle'), 'Stop hook ends the turn → idle');
    /* v21: formatting moved off the session bar into the recipe form, so a
       recipe SAVE has to reach the project's open windows (pane.prefs push)
       and persist to the pane row (or a reattach would revert it). */
    await fetch(`${BASE}/api/recipes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: actRec.id, name: 'Activity Renamed', target: 'local', projectDir: tmpDir,
        runClaude: false, color: '#123456', fontSize: 19,
      }),
    });
    const recipePush = await c14.await(
      (m) => m.type === 'pane.prefs' && m.paneid === actPane && m.prefs?.friendlyName === 'Activity Renamed', 8000);
    eq(recipePush.prefs.color, '#123456', 'recipe save pushes pane.prefs to the open window (name + colour)');
    eq(recipePush.prefs.fontSize, 19, '...and the text-size seed');
    eq(
      (await fetchJson('/api/table')).sessions.find((s) => s.paneid === actPane).friendlyName,
      'Activity Renamed',
      'and persists it to the pane row (a reattach will not revert it)',
    );
    const hkMiss = await (
      await fetch(`${BASE}/api/claude-hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'ffffffff-0000-4000-8000-000000000000', hook_event_name: 'Notification' }),
      })
    ).json();
    eq(hkMiss.matched, null, 'unknown session_id → 200 noop (hand-launched CLIs are fine)');

    /* THE DOORBELL (Owner 2026-09-02). The hook is a curl line in a global
       settings file shared by every project and host, so it has no credential
       to present — and every call had been 401ing silently since auth landed,
       swallowed by the hook's own `|| true`. The "come get me" light had never
       once worked. Loopback AND no forwarding header is what separates "a
       process on this machine" from "the tailnet", which behind Tailscale Serve
       also arrives on 127.0.0.1. */
    const hookNoAuth = await realFetch(`${BASE}/api/claude-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: arow.session_id, hook_event_name: 'Notification' }),
    });
    eq(hookNoAuth.status, 200, 'the hook is delivered from loopback with no credential');
    eq((await hookNoAuth.json()).matched, actPane, 'and still resolves to its pane');

    const fwded = await realFetch(`${BASE}/api/claude-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.9' },
      body: JSON.stringify({ session_id: arow.session_id, hook_event_name: 'Notification' }),
    });
    eq(fwded.status, 401, 'a PROXIED call is not local, however loopback its socket looks');

    const stillShut = await realFetch(`${BASE}/api/table`);
    eq(stillShut.status, 401, 'the exemption is ONE endpoint, not a loopback backdoor');

    const hookGet = await realFetch(`${BASE}/api/claude-hook`);
    eq(hookGet.status, 401, 'and POST only — a GET on the same path is still gated');
    c14.send({ type: 'kill', paneid: actPane });
    await c14.await((m) => m.type === 'pane.exit' && m.paneid === actPane, 8000);
    c14.close();
    eq(
      (await fetchJson('/api/table')).sessions.find((s) => s.paneid === actPane).exit,
      undefined,
      'a user kill carries NO exit verdict (its code is our signal, not the program\'s)',
    );

    console.log('\n[ended verdict (v21): exit = ok|fail when the process ended on its own]');
    for (const [code, want] of [[0, 'ok'], [3, 'fail']]) {
      const xRec = (await mkRecipe({ name: `Exit ${code}`, target: 'local', projectDir: tmpDir, runClaude: false })).recipe;
      const xPane = `recipe:${xRec.id}`;
      const cX = client();
      await cX.open();
      cX.send({ type: 'attach', paneid: xPane, recipe: xRec.id });
      await cX.await((m) => m.type === 'pane.ready' && m.paneid === xPane, 8000);
      cX.send({ type: 'input', paneid: xPane, data: `exit ${code}\r` });
      const ex = await cX.await((m) => m.type === 'pane.exit' && m.paneid === xPane, 15000);
      const xRow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === xPane);
      eq(xRow.exit, want, `shell exited ${ex.code} on its own -> exit=${want}`);
      cX.close();
      await fetch(`${BASE}/api/recipes/${xRec.id}`, { method: 'DELETE' });
    }
    await fetch(`${BASE}/api/recipes/${actRec.id}`, { method: 'DELETE' });
    await fetch(`${BASE}/api/recipes/${otherRec.id}`, { method: 'DELETE' });

    console.log('\n[url offers: agent submits, window is asked, dismiss round-trips]');
    const uRec = (await mkRecipe({ name: 'Url Offer Test', target: 'local', projectDir: tmpDir, runClaude: false })).recipe;
    const uPane = `recipe:${uRec.id}`;
    const cU = client();
    await cU.open();
    cU.send({ type: 'attach', paneid: uPane, recipe: uRec.id });
    await cU.await((m) => m.type === 'pane.ready' && m.paneid === uPane, 8000);
    const uRow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === uPane);
    const post = (body) =>
      fetch(`${BASE}/api/url-offer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const bad = await fetch(`${BASE}/api/url-offer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'notaurl', session_id: uRow.session_id }) });
    eq(bad.status, 400, 'non-http url rejected');
    const miss = await post({ url: 'https://example.com/x', session_id: 'nope-unknown' });
    eq(miss.matched, null, 'unknown session noop (agent never sees an error)');
    const ok1 = await post({ url: 'https://example.com/oauth?code=1', session_id: uRow.session_id });
    eq(ok1.matched, uPane, 'offer matched the pane by session_id');
    const ev1 = await cU.await((m) => m.type === 'pane.url-offer' && m.paneid === uPane, 8000);
    eq(ev1.urls.length, 1, 'window received the offer');
    await post({ url: 'https://example.com/second', session_id: uRow.session_id });
    await cU.await((m) => m.type === 'pane.url-offer' && m.urls?.length === 2, 8000);
    ok(true, 'multiple offers stack');
    cU.send({ type: 'url-offer-dismiss', paneid: uPane, url: 'https://example.com/oauth?code=1' });
    // predicate names the SURVIVOR — the backlog-scanning await would otherwise
    // match the earlier one-element event
    const ev3 = await cU.await(
      (m) => m.type === 'pane.url-offer' && m.urls?.length === 1 && m.urls[0] === 'https://example.com/second',
      8000,
    );
    eq(ev3.urls[0], 'https://example.com/second', 'single dismiss removed only its url');
    cU.send({ type: 'url-offer-dismiss', paneid: uPane });
    await cU.await((m) => m.type === 'pane.url-offer' && m.urls?.length === 0, 8000);
    ok(true, 'dismiss-all clears the bar');
    cU.send({ type: 'kill', paneid: uPane });
    await cU.await((m) => m.type === 'pane.exit' && m.paneid === uPane, 8000);
    cU.close();
    await fetch(`${BASE}/api/recipes/${uRec.id}`, { method: 'DELETE' });

    /* ====== vk [ref]: broker-fleet routing (remote spawn, auth, adoption) ====== */
    console.log('\n[routing: broker-resident target spawns on the REMOTE broker]');
    const rRec = (await mkRecipe({ name: 'Remote Resident', target: 'testhost-res', projectDir: tmpDir, runClaude: false })).recipe;
    const rPane = `recipe:${rRec.id}`;
    const cR = client();
    await cR.open();
    cR.send({ type: 'attach', paneid: rPane, recipe: rRec.id });
    await cR.await((m) => m.type === 'pane.ready' && m.paneid === rPane, 10000);
    const rbHealth = await (await fetch(`http://127.0.0.1:${REMOTE_BROKER_PORT}/health`)).json();
    ok(rbHealth.live >= 1, `PTY landed in the remote broker (live=${rbHealth.live})`);
    cR.send({ type: 'input', paneid: rPane, data: "echo REMOTE_RES_CODEWORD_77\r" });
    await cR.await((m) => m.type === 'pane.data' && m.paneid === rPane && m.data.includes('REMOTE_RES_CODEWORD_77'), 8000);
    ok(true, 'remote-broker session interactive through the engine');
    const rRow = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === rPane);
    eq(rRow.server, 'unused-alias', 'server column carries the alias (transcript ops)');

    console.log('\n[routing: wrong token → loud unauthorized, never silent]');
    const bRec = (await mkRecipe({ name: 'Bad Auth', target: 'badauth-res', projectDir: tmpDir, runClaude: false })).recipe;
    const bPane = `recipe:${bRec.id}`;
    cR.send({ type: 'attach', paneid: bPane, recipe: bRec.id });
    const bErr = await cR.await((m) => m.type === 'pane.error' && m.paneid === bPane, 15000);
    ok(/unauthorized|4401/i.test(bErr.message), `bad token surfaced loudly (got: ${bErr.message.slice(0, 80)})`);

    console.log('\n[routing: engine death → adoption across the REMOTE link]');
    engine.kill(); // both brokers stay up
    await sleep(700);
    engine = bootEngine();
    ok(await waitUp(), 'engine back beside both brokers');
    const rRow2 = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === rPane);
    eq(rRow2.state, 'live', 'remote-broker row stayed LIVE across engine restart');
    const cR2 = client();
    await cR2.open();
    cR2.send({ type: 'attach', paneid: rPane, recipe: rRec.id });
    const rReady2 = await cR2.await((m) => m.type === 'pane.ready' && m.paneid === rPane, 10000);
    eq(rReady2.reattached, true, 'reattached to the remote-held session');
    const rReplay = await cR2.await((m) => m.type === 'pane.data' && m.paneid === rPane, 8000);
    ok(rReplay.data.includes('REMOTE_RES_CODEWORD_77'), 'replay crossed the remote link');
    cR2.send({ type: 'kill', paneid: rPane });
    await cR2.await((m) => m.type === 'pane.exit' && m.paneid === rPane, 8000);

    console.log('\n[routing: UNREACHABLE remote broker → rows preserved, not reconciled]');
    const r2Rec = (await mkRecipe({ name: 'Remote Resident 2', target: 'testhost-res', projectDir: tmpDir, runClaude: false })).recipe;
    const r2Pane = `recipe:${r2Rec.id}`;
    cR2.send({ type: 'attach', paneid: r2Pane, recipe: r2Rec.id });
    await cR2.await((m) => m.type === 'pane.ready' && m.paneid === r2Pane, 10000);
    engine.kill();
    remoteBroker.kill(); // the "network outage / host down" case
    await sleep(700);
    engine = bootEngine();
    ok(await waitUp(), 'engine back with the remote broker DOWN');
    ok(engineLog.includes(`unreachable`), 'boot log reports the unreachable remote');
    const r2Row = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === r2Pane);
    eq(r2Row.state, 'live', 'row on the unreachable broker PRESERVED (unreachable ≠ dead)');
    eq(r2Row.activity, 'disconnected', 'decorated disconnected while its host is away');
    ok(r2Row.interrupted !== 1, 'not stamped interrupted (nothing is known to be lost)');
    cR.close();
    cR2.close();
    await fetch(`${BASE}/api/recipes/${rRec.id}`, { method: 'DELETE' });
    await fetch(`${BASE}/api/recipes/${bRec.id}`, { method: 'DELETE' });
    await fetch(`${BASE}/api/recipes/${r2Rec.id}`, { method: 'DELETE' });
  } catch (err) {
    failed++;
    failures.push(`EXCEPTION: ${err.message}`);
    console.log(`\n✗ EXCEPTION: ${err.message}`);
    console.log(`--- engine/broker log tail ---\n${engineLog.slice(-2500)}`);
  } finally {
    engine.kill();
    broker.kill();
    remoteBroker.kill();
    fakeHost.close();
    await sleep(300);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* db file may linger if engine hasn't released it; harmless in tmp */
    }
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`PASS ${passed}  FAIL ${failed}`);
  if (failed > 0) {
    console.log('failures:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  }
  console.log('all green');
  process.exit(0);
}

run();
