/**
 * TICKETS AND PERSONS, end to end against a REAL engine in identity mode `both` with a desktop AGENT registered (design review review of the person-check fix, 2026-10-26).
 * A launch ticket becomes an IDENTITY session only when it was minted FOR A PERSON (the requester was a signed-in session). A ticket minted for the shared bearer (anything on the
 * box that holds the token, including an agent that registered as the window agent) gets the legacy cookie, which is NOT a person. There is no "the one account" fallback.
 *   (a) launch by BEARER -> ticket -> redeem -> wb_auth cookie -> person-only route 403
 *   (b) launch by a signed-in PERSON -> ticket -> redeem -> homelab_session -> the same route 200
 *   (c) /api/open-manager (the tray, bearer) -> ticket -> redeem -> wb_auth -> 403
 * SAFETY: scratch port, scratch db and identity db in a temp dir, no broker, no window host.
 */
import { spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(562);
const DEAD_BROKER_PORT = P(563);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'ticket-person-test-token';
const WA_TOKEN = 'ticket-person-window-agent-credential';
const AGENT_BASE = 'http://agent.example.invalid:7420';
const PASSWORD = 'Vt7#mqz-Pk-long-enough';

let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);

function windowAgent() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/window-agent`, { headers: { authorization: `Bearer ${WA_TOKEN}` } });
  ws.on('error', () => {});
  const log = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    log.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(msg)) waiters.splice(i, 1)[0].resolve(msg);
    if (typeof msg.req === 'string' && String(msg.type).startsWith('window.')) ws.send(JSON.stringify({ type: 'window.result', req: msg.req, ok: true }));
  });
  return {
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next: (pred, timeoutMs = 5000) => new Promise((resolve, reject) => {
      const hit = log.filter(pred).at(-1);
      const t = setTimeout(() => reject(new Error('timeout waiting for a window.open')), timeoutMs);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      void hit;
    }),
    count: () => log.filter((m) => m.type === 'window.open').length,
    close: () => ws.close(),
  };
}

/** Redeem a ticketed url as a WebView would: GET it on the ENGINE (the agent's base is a stand-in host), do not follow, read the cookies. */
async function redeem(url) {
  const u = new URL(url);
  const res = await fetch(`${BASE}${u.pathname}${u.search}`, { redirect: 'manual' });
  return { status: res.status, cookies: cookiesOf(res) };
}

async function main() {
  await assertFree(PORT, 'ticket-person.test.mjs');
  await assertFree(DEAD_BROKER_PORT, 'ticket-person.test.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'wb-ticketperson-'));
  const idDb = join(tmp, 'identity.db');
  // a real account, seeded without the engine (the CLI only issues temp codes)
  const seed = join(tmp, 'seed.mts');
  writeFileSync(seed, `import { hashPassword } from '${REPO_ROOT}/src/identity/auth.ts'; import * as store from '${REPO_ROOT}/src/identity/store.ts'; store.createAccount({ username: 'owner', passwordHash: await hashPassword('${PASSWORD}'), mustChange: false, passwordExpiresAt: null, isAdmin: true });\n`);
  const seeded = spawnSync(process.execPath, ['--import', join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'), seed], { env: childEnv({ HARBOR_WB_IDENTITY: 'both', HARBOR_WB_IDENTITY_DB: idDb }), encoding: 'utf8' });
  if (seeded.status !== 0) throw new Error(`seeding the account failed: ${seeded.stderr}`);

  let log = '';
  const engine = spawn(process.execPath, ['--import', join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'src/server/index.ts'], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_WINDOW_AGENT_TOKEN: WA_TOKEN, HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: HOST, HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_IDENTITY: 'both', HARBOR_WB_IDENTITY_DB: idDb, HARBOR_WB_DESKTOP: 'agent', HARBOR_WB_AGENT_TIMEOUT_MS: '2000',
      HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'claude-projects'), HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_BROKERS: '{}', HARBOR_WB_NO_WINDOW: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine.stdout.on('data', (d) => (log += d));
  engine.stderr.on('data', (d) => (log += d));
  let agent = null;
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
      if (!up) await sleep(250);
    }
    if (!up) throw new Error(`engine did not come up\n${log}`);

    const bearer = { authorization: `Bearer ${TOKEN}` };
    const login = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) });
    const sess = cookiesOf(login).find((c) => c.startsWith('homelab_session='));
    ok(!!sess, 'the account signs in (a real identity session cookie)');
    const recipe = (await (await fetch(`${BASE}/api/recipes`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ticket Probe', target: 'local', runClaude: false }) })).json()).recipe;
    ok(!!recipe?.id, 'a probe recipe exists');

    agent = windowAgent();
    await agent.open();
    agent.send({ type: 'register', host: 'vrpc', agent: 'probe', capabilities: ['window'], version: '0.1.0', base: AGENT_BASE });
    await sleep(400);

    const personOnly = (cookie) => fetch(`${BASE}/api/concierge/signoffs`, { headers: { cookie } }).then((r) => r.status);

    console.log('\n[(a) a launch by the shared BEARER: the ticket is not a person]');
    let n0 = agent.count();
    const pA = agent.next((m) => m.type === 'window.open');
    const la = await fetch(`${BASE}/api/recipes/${recipe.id}/launch`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{}' });
    const openA = await pA;
    ok(la.status === 200 && openA.url.includes('ticket='), 'the bearer launch is handed to the agent with a ticket');
    const ra = await redeem(openA.url);
    ok(ra.status === 303 && ra.cookies.some((c) => c.startsWith('wb_auth=')) && !ra.cookies.some((c) => c.startsWith('homelab_session=')), 'redeemed: the LEGACY cookie, no identity session');
    ok((await personOnly(ra.cookies.join('; '))) === 403, '...and that window is NOT a person: a person-only route answers 403');

    console.log('\n[(b) a launch by a signed-in PERSON: the ticket is that person]');
    await sleep(300);
    const pB = agent.next((m) => m.type === 'window.open' && m.url !== openA.url);
    const lb = await fetch(`${BASE}/api/recipes/${recipe.id}/launch`, { method: 'POST', headers: { cookie: sess, 'content-type': 'application/json' }, body: '{}' });
    const openB = await pB;
    ok(lb.status === 200 && openB.url.includes('ticket='), 'the person launch is handed to the agent with a ticket');
    const rb = await redeem(openB.url);
    ok(rb.status === 303 && rb.cookies.some((c) => c.startsWith('homelab_session=')), 'redeemed: an IDENTITY session');
    ok((await personOnly(rb.cookies.join('; '))) === 200, '...which IS a person: the same route answers 200');
    const again = await redeem(openB.url);
    ok(!again.cookies.some((c) => c.startsWith('homelab_session=')) && !again.cookies.some((c) => c.startsWith('wb_auth=')), 'a ticket redeems ONCE: the second use grants nothing');

    console.log('\n[(c) the tray: /api/open-manager by the BEARER]');
    await sleep(300);
    const pC = agent.next((m) => m.type === 'window.open' && m.url !== openA.url && m.url !== openB.url);
    const lc = await fetch(`${BASE}/api/open-manager`, { headers: bearer });
    const openC = await pC;
    ok(lc.status === 200 && openC.url.includes('ticket='), 'the tray request is handed to the agent with a ticket');
    const rc = await redeem(openC.url);
    ok(rc.cookies.some((c) => c.startsWith('wb_auth=')) && !rc.cookies.some((c) => c.startsWith('homelab_session=')), 'redeemed: the LEGACY cookie, not a person');
    ok((await personOnly(rc.cookies.join('; '))) === 403, '...so approving things there needs one sign-in');
    console.log('\n[(d) a window that is ALREADY signed in keeps its sign-in]');
    await sleep(300);
    const pD = agent.next((m) => m.type === 'window.open' && ![openA.url, openB.url, openC.url].includes(m.url));
    await fetch(`${BASE}/api/open-manager`, { headers: bearer });
    const openD = await pD;
    const resD = await fetch(`${BASE}${new URL(openD.url).pathname}${new URL(openD.url).search}`, { redirect: 'manual', headers: { cookie: sess } });
    ok(resD.status === 303 && (resD.headers.getSetCookie?.() ?? []).length === 0, 'a bearer ticket redeemed WITH a valid identity session cookie sets no cookie: the sign-in stays (one per browser profile)');
    ok((await personOnly(sess)) === 200, '...and that cookie is still the person');
    const loginRaw = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('homelab_session=')) ?? '';
    ok(/Max-Age=2592000\b/.test(loginRaw), 'the sign-in cookie carries Max-Age (30 days): it survives a host restart', loginRaw.replace(/=[^;]+/, '=…'));
    ok(n0 >= 0, 'done');
  } finally {
    agent?.close();
    engine.kill('SIGTERM');
    await sleep(500);
    engine.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
