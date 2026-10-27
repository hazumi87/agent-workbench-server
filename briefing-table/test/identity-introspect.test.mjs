/**
 * `GET /identity/introspect` — token introspection for the message-fabric
 * (platform, Node, server :8204). The fabric validates a caller's bearer by
 * asking THIS route, so it never has to open identity.db itself.
 *
 * Two real engines, one after the other, because the route's whole point is
 * that it behaves differently by mode:
 *   - `legacy` (identity switched OFF) — only the shared bearer introspects.
 *   - `strict` (identity switched ON) — only a real principal introspects,
 *     and the forced-change gate must refuse a temp code exactly the way
 *     2026-09-15 closed the same hole on /account/*.
 *
 * SAFETY: its own ports, its own scratch dbs, all under the OS temp dir.
 * Never touches :7420, the real data/, or a broker — no broker is spawned,
 * nothing here opens a pty.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
/* Scratch ports — the port table is in test/_scratch.mjs. The DEAD broker
 * ports are told to each engine; nothing may listen there (no pty is opened),
 * so they are checked by assertFree like the engine ports. */
const PORT_LEGACY = P(6);
const PORT_STRICT = P(7);
const DEAD_BROKER_LEGACY = P(14);
const DEAD_BROKER_STRICT = P(15);
const LEGACY_TOKEN = 'legacy-token-do-not-ship';
const GOOD_PASSWORD = 'Zq4%wnb-Rd';

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

/** Cookies are the mechanism for the session case, so a tiny jar beats
 *  relying on fetch (node's fetch does not persist Set-Cookie). */
function jar() {
  const store = new Map();
  return {
    take(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (value === '' || /max-age=0/i.test(raw)) {
          store.delete(name);
        } else {
          store.set(name, value);
        }
      }
    },
    header() {
      return [...store].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

async function call(base, path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.cookie) {
    headers.cookie = opts.cookie;
  }
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
    opts.method = opts.method ?? 'POST';
  }
  const res = await fetch(base + path, { ...opts, headers, redirect: 'manual' });
  let body = null;
  let raw = '';
  try {
    raw = await res.text();
    body = raw ? JSON.parse(raw) : null;
  } catch {
    /* html or empty — most assertions read the status */
  }
  return { status: res.status, body, raw, res };
}

/** Run the admin CLI against a scratch identity db and hand back its stdout. */
function runCli(args, identityDb) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'identity.ts'), ...args], {
      cwd: REPO_ROOT,
      env: childEnv({ HARBOR_WB_IDENTITY_DB: identityDb }),
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => {
      out += d;
    });
    proc.stderr.on('data', (d) => {
      err += d;
    });
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

function bootEngine(env) {
  const engine = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env,
  });
  let log = '';
  engine.stdout.on('data', (d) => {
    log += d;
  });
  engine.stderr.on('data', (d) => {
    log += d;
  });
  return { engine, getLog: () => log };
}

async function waitHealthy(base) {
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      /* not up yet */
    }
  }
  return false;
}

async function runLegacyPhase(tmpRoot) {
  console.log('\n== phase 1: legacy mode (identity switched off) ==');
  const tmpDir = mkdtempSync(join(tmpRoot, 'legacy-'));
  const base = `http://${HOST}:${PORT_LEGACY}`;
  const { engine, getLog } = bootEngine(childEnv({
    HARBOR_WB_PORT: String(PORT_LEGACY),
    HARBOR_WB_HOST: HOST,
    HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
    HARBOR_WB_IDENTITY: 'legacy',
    HARBOR_WB_TOKEN: LEGACY_TOKEN,
    HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '',
        /* The fabric subscriber must never dial from a test: 8204 is the real
           server service's port and a test engine has no business on it. '' is the
           documented off switch, same posture as HARBOR_WB_NATS_URL above. */
        HARBOR_WB_FABRIC_URL: '',
    HARBOR_WB_BROKER_AUTOSTART: '0',
    HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_LEGACY),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
  }));
  try {
    ok(await waitHealthy(base), 'legacy engine comes up');

    const none = await call(base, '/identity/introspect');
    eq(none.status, 401, 'no credential: 401');
    eq(none.body?.ok, false, 'and ok:false');
    eq(none.body?.error, 'unauthenticated', 'named unauthenticated');

    const garbage = await call(base, '/identity/introspect', {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    eq(garbage.status, 401, 'a garbage bearer: 401');

    const good = await call(base, '/identity/introspect', {
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
    });
    eq(good.status, 200, 'the shared bearer introspects in legacy mode');
    eq(good.body?.ok, true, 'ok:true');
    eq(good.body?.mode, 'legacy', 'mode:legacy');
    eq(good.body?.principal?.user, 'legacy', "principal.user:'legacy'");
    eq(good.body?.principal?.kind, 'shared-bearer', "principal.kind:'shared-bearer'");
    eq(good.body?.principal?.since, null, 'since:null — a shared secret carries no creation time');
    eq(JSON.stringify(good.body?.principal?.projects), '["*"]', 'projects:["*"] — the fabric sender-binding field');
    ok(!good.raw.includes(LEGACY_TOKEN), 'the response never echoes the token itself');

    ok(!getLog().includes(LEGACY_TOKEN), 'the engine log never printed the token either');
  } finally {
    engine.kill();
    await sleep(300);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* WAL sidecars may linger on Windows; harmless in tmp */
    }
  }
}

async function runStrictPhase(tmpRoot) {
  console.log('\n== phase 2: strict mode (identity switched on) ==');
  const tmpDir = mkdtempSync(join(tmpRoot, 'strict-'));
  const identityDb = join(tmpDir, 'identity.db');
  const base = `http://${HOST}:${PORT_STRICT}`;

  const boot = await runCli(['bootstrap', '--username', 'probe'], identityDb);
  eq(boot.code, 0, 'bootstrap exits 0');
  const code = /password\s+([a-z2-9]{4}-[a-z2-9]{4})/.exec(boot.out)?.[1] ?? null;
  ok(!!code, `bootstrap prints one temp code (${code})`);

  const { engine, getLog } = bootEngine(childEnv({
    HARBOR_WB_PORT: String(PORT_STRICT),
    HARBOR_WB_HOST: HOST,
    HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
    HARBOR_WB_IDENTITY: 'strict',
    HARBOR_WB_IDENTITY_DB: identityDb,
    HARBOR_WB_TOKEN: LEGACY_TOKEN,
    HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '',
        /* The fabric subscriber must never dial from a test: 8204 is the real
           server service's port and a test engine has no business on it. '' is the
           documented off switch, same posture as HARBOR_WB_NATS_URL above. */
        HARBOR_WB_FABRIC_URL: '',
    HARBOR_WB_BROKER_AUTOSTART: '0',
    HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_STRICT),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
  }));
  try {
    ok(await waitHealthy(base), 'strict engine comes up');

    const none = await call(base, '/identity/introspect');
    eq(none.status, 401, 'no credential: 401');

    const garbage = await call(base, '/identity/introspect', {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    eq(garbage.status, 401, 'a garbage bearer: 401');

    const legacyBearer = await call(base, '/identity/introspect', {
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
    });
    eq(legacyBearer.status, 401, 'the shared bearer is DEAD in strict mode, same as every other route');

    console.log('\n-- a temp code must not introspect as settled (2026-09-15 hole, reopened here) --');
    const tempCookies = jar();
    const tempLogin = await call(base, '/login', { json: { username: 'probe', password: code } });
    eq(tempLogin.status, 200, 'the temp code signs in');
    tempCookies.take(tempLogin.res);
    eq(tempLogin.body?.mustChangePassword, true, 'and the response says a change is forced');

    const gated = await call(base, '/identity/introspect', { cookie: tempCookies.header() });
    eq(gated.status, 403, 'introspect refuses a principal under forced password change');
    eq(gated.body?.ok, false, 'ok:false');
    eq(gated.body?.error, 'password-change-required', "named 'password-change-required'");

    console.log('\n-- set a real password, then introspect a session --');
    const changed = await call(base, '/account/password', {
      cookie: tempCookies.header(),
      json: { current: code, next: GOOD_PASSWORD },
    });
    eq(changed.status, 200, 'the password change succeeds');
    const settled = jar();
    settled.take(changed.res);

    const before = Date.now();
    const sess = await call(base, '/identity/introspect', { cookie: settled.header() });
    eq(sess.status, 200, 'a settled session introspects 200');
    eq(sess.body?.ok, true, 'ok:true');
    eq(sess.body?.mode, 'strict', 'mode:strict');
    eq(sess.body?.principal?.user, 'probe', 'principal.user is the account, not the credential');
    eq(sess.body?.principal?.kind, 'session', "principal.kind:'session'");
    const since = sess.body?.principal?.since ? Date.parse(sess.body.principal.since) : NaN;
    const nowMs = Date.now();
    ok(Number.isFinite(since) && since <= nowMs + 1000 && since >= before - 5000 /* created_at rounding can land 1 ms after now (vrpc1, Windows) */, `since is a real, recent ISO timestamp (since=${sess.body?.principal?.since} before=${new Date(before).toISOString()} now=${new Date(nowMs).toISOString()})`);

    console.log('\n-- introspect an api_token bearer --');
    const minted = await call(base, '/account/token', {
      cookie: settled.header(),
      json: { label: 'fabric probe' },
    });
    eq(minted.status, 200, 'a token is minted');
    const tokenStr = minted.body?.token;
    ok(!!tokenStr, 'and shown once, in the mint response');

    const tok = await call(base, '/identity/introspect', {
      headers: { authorization: `Bearer ${tokenStr}` },
    });
    eq(tok.status, 200, 'the token introspects 200');
    eq(tok.body?.principal?.user, 'probe', 'as the user it belongs to');
    eq(tok.body?.principal?.kind, 'api_token', "principal.kind:'api_token'");
    eq(JSON.stringify(tok.body?.principal?.projects), '["*"]', 'api_token introspects projects:["*"]');
    ok(!tok.raw.includes(tokenStr), 'the response never echoes the token string');
    ok(!getLog().includes(tokenStr), 'nor does the engine log');

    const revoke = await call(base, `/account/token/${minted.body.id}/revoke`, {
      method: 'POST',
      cookie: settled.header(),
    });
    eq(revoke.status, 200, 'revoke the token');
    eq(
      (await call(base, '/identity/introspect', { headers: { authorization: `Bearer ${tokenStr}` } })).status,
      401,
      'the revoked token no longer introspects',
    );
  } finally {
    engine.kill();
    await sleep(300);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* WAL sidecars may linger on Windows; harmless in tmp */
    }
  }
}

async function run() {
  for (const p of [PORT_LEGACY, PORT_STRICT, DEAD_BROKER_LEGACY, DEAD_BROKER_STRICT]) {
    await assertFree(p, 'identity-introspect.test.mjs');
  }
  const tmpRoot = mkdtempSync(join(tmpdir(), 'wb-identity-introspect-'));
  try {
    await runLegacyPhase(tmpRoot);
    await runStrictPhase(tmpRoot);
  } catch (err) {
    failed++;
    failures.push(`EXCEPTION: ${err.message}`);
    console.log(`\n✗ EXCEPTION: ${err.stack}`);
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
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
