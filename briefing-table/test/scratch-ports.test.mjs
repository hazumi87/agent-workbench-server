/**
 * test/_scratch.mjs: P(), the forbidden-port refusal, assertFree, childEnv.
 * room interface T0 [ticket]. Binds only ephemeral ports (listen 0) and ports it
 * has just proven free; never a live port.
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { P, assertFree, childEnv, portOffset, PORT_TABLE, FORBIDDEN_PORTS, PATH_KEY, scratchShell } from './_scratch.mjs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}
function throwsMatching(fn, re, msg) {
  try {
    fn();
    ok(false, `${msg} (did not throw)`);
  } catch (err) {
    ok(re.test(err.message), `${msg} (${err.message.slice(0, 90)})`);
  }
}
async function rejectsMatching(p, re, msg) {
  try {
    await p;
    ok(false, `${msg} (resolved)`);
  } catch (err) {
    ok(re.test(err.message), `${msg} (${err.message.slice(0, 90)})`);
  }
}
/** Run fn with WB_TEST_PORT_OFFSET set to v (undefined = unset), then restore
 *  it exactly — `process.env.X = undefined` would store the string. */
function withOffset(v, fn) {
  const saved = process.env.WB_TEST_PORT_OFFSET;
  if (v === undefined) {
    delete process.env.WB_TEST_PORT_OFFSET;
  } else {
    process.env.WB_TEST_PORT_OFFSET = String(v);
  }
  try {
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env.WB_TEST_PORT_OFFSET;
    } else {
      process.env.WB_TEST_PORT_OFFSET = saved;
    }
  }
}
const listenOn = (port) =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen({ port, host: '127.0.0.1' }, () => resolve(srv));
  });
const close = (srv) => new Promise((r) => srv.close(r));

console.log('\n[P(n)]');
withOffset(undefined, () => {
  eq(portOffset(), 0, 'no WB_TEST_PORT_OFFSET means offset 0');
  eq(P(1), 7431, 'P(1) at offset 0 is the engine.test port it always was');
  eq(P(12), 7442, 'P(12) at offset 0 is 7442');
  eq(P(17), 7447, 'P(17) at offset 0 is 7447');
});
withOffset('', () => eq(P(3), 7433, 'an EMPTY offset is offset 0'));
withOffset(100, () => {
  eq(P(1), 7531, 'offset 100 moves P(1) to 7531');
  eq(P(16), 7546, 'offset 100 moves P(16) to 7546');
});
withOffset(0, () => {
  for (const n of Object.keys(PORT_TABLE).map(Number)) {
    ok(!FORBIDDEN_PORTS.includes(P(n)), `P(${n}) = ${P(n)} is a legal scratch port at offset 0`);
  }
});
withOffset(100, () => {
  const all = Object.keys(PORT_TABLE).map(Number).map((n) => P(n));
  ok(all.every((p) => !FORBIDDEN_PORTS.includes(p)), 'every table slot is legal at offset 100 too');
});

console.log('\n[the forbidden ports]');
withOffset(0, () => {
  throwsMatching(() => P(0), /:7430.*LIVE/, 'P(0) at offset 0 would be the REAL broker: refused');
  throwsMatching(() => P(-10), /:7420.*LIVE/, 'P(-10) would be the live engine: refused');
});
withOffset(770, () => {
  throwsMatching(() => P(0), /:8200/, 'an offset that lands on :8200 (window host): refused');
  throwsMatching(() => P(1), /:8201/, 'an offset that lands on :8201 (server engine): refused');
  throwsMatching(() => P(4), /:8204/, 'an offset that lands on :8204 (fabric): refused');
  eq(P(2), 8202, 'a neighbouring port at the same offset is fine');
});
withOffset(0, () => {
  throwsMatching(() => P(1.5), /integer slot/, 'a fractional slot: refused');
  throwsMatching(() => P('1'), /integer slot/, 'a string slot: refused');
  throwsMatching(() => P(60000), /outside 1024-65535/, 'a slot past 65535: refused');
});
withOffset(-1, () => throwsMatching(() => P(1), /non-negative integer/, 'a negative offset: refused'));
withOffset('abc', () => throwsMatching(() => P(1), /non-negative integer/, 'a non-numeric offset: refused'));
withOffset('2.5', () => throwsMatching(() => P(1), /non-negative integer/, 'a fractional offset: refused'));

console.log('\n[assertFree]');
{
  const probe = await listenOn(0);
  const freePort = probe.address().port;
  await close(probe);
  eq(await assertFree(freePort, 'scratch-ports.test'), freePort, 'a free port resolves with itself');
  // assertFree released it: something else can bind it straight after.
  const again = await listenOn(freePort);
  ok(true, 'and it released the port (a second bind succeeded)');

  await rejectsMatching(assertFree(freePort, 'scratch-ports.test'), new RegExp(`:${freePort} is busy`), 'a held port is refused');
  await rejectsMatching(assertFree(freePort, 'my-suite.test'), /my-suite\.test needs it/, 'the refusal names the suite that asked');
  /* Choose the offset that maps the held port onto slot 3, so the message
     must name that slot's owners from the table. */
  const off = freePort - 7430 - 3;
  await withOffset(off, () =>
    rejectsMatching(assertFree(freePort, 'x'), /P\(3\) belongs to: identity-engine\.test/, 'and names the suite(s) the table says own that slot'),
  );
  await close(again);
}

console.log('\n[childEnv]');
{
  const saved = { ...process.env };
  process.env.PTY_BROKER_HOST = '100.64.0.1';
  process.env.PTY_BROKER_TOKEN = 'real-token';
  process.env.HARBOR_WB_SLUG = 'some-agent';
  process.env.HARBOR_WB_PANEID = 'recipe:x';
  process.env.Harbor_Wb_Mixed = 'mixed-case';
  process.env.KEEP_ME = 'kept';
  if (process.platform !== 'win32') {
    process.env.Path = '/a/stray/second/path/key'; // a distinct variable off win32
  }
  const parentPath = process.env.PATH;
  try {
    const e = childEnv();
    /* Exempt: the two pinned-off URLs, and PTY_BROKER_ALLOW_NO_AUTH, the one non-secret flag childEnv adds on purpose so a loopback scratch broker may start without a token (the broker refuses otherwise, H7). */
    ok(!Object.keys(e).some((k) => /^(PTY_BROKER_|HARBOR_WB_)/i.test(k) && !/^HARBOR_WB_(FABRIC|NATS)_URL$/.test(k) && k !== 'PTY_BROKER_ALLOW_NO_AUTH'), 'no PTY_BROKER_* / HARBOR_WB_* key survives (bar the two pinned off and the scratch-broker no-auth flag)');
    eq(e.PTY_BROKER_ALLOW_NO_AUTH, '1', 'the scratch-broker no-auth flag is set, and it is the only PTY_BROKER_* key');
    eq(e.HARBOR_WB_FABRIC_URL, '', 'fabric is pinned off');
    eq(e.HARBOR_WB_NATS_URL, '', 'NATS is pinned off');
    eq(e.KEEP_ME, 'kept', 'unrelated keys are copied');
    const pathKeys = Object.keys(e).filter((k) => /^path$/i.test(k));
    eq(pathKeys.length, 1, 'exactly one path key');
    eq(pathKeys[0], PATH_KEY, `and it is ${PATH_KEY} on ${process.platform}`);
    eq(e[PATH_KEY], parentPath, 'carrying the parent PATH');

    const x = childEnv({ HARBOR_WB_PORT: 7431, HARBOR_WB_FABRIC_URL: 'http://127.0.0.1:1', PTY_BROKER_TOKEN: 't' });
    eq(x.HARBOR_WB_PORT, '7431', 'a HARBOR_WB_* key passed in extra is kept, stringified');
    eq(x.HARBOR_WB_FABRIC_URL, 'http://127.0.0.1:1', 'extra overrides the fabric pin');
    eq(x.PTY_BROKER_TOKEN, 't', 'a PTY_BROKER_* key passed in extra is kept');
    eq(x.HARBOR_WB_SLUG, undefined, 'but the ambient ones are still gone');

    const p = childEnv({ path: '/stub/bin' });
    eq(Object.keys(p).filter((k) => /^path$/i.test(k)).join(','), PATH_KEY, 'a path in extra (any case) still lands under one key');
    eq(p[PATH_KEY], '/stub/bin', 'and replaces the path');

    const u = childEnv({ KEEP_ME: undefined, OTHER: null });
    ok(!('KEEP_ME' in u), 'an undefined extra REMOVES the key (never the string "undefined")');
    ok(!('OTHER' in u), 'a null extra is not written');

    /* The real thing: what a spawned child actually sees. */
    const seen = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], {
        env: childEnv({ WB_TEST_PORT_OFFSET: '100' }),
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('error', reject);
      c.on('close', () => resolve(JSON.parse(out)));
    });
    ok(!seen.some((k) => /^PTY_BROKER_/i.test(k) && k !== 'PTY_BROKER_ALLOW_NO_AUTH'), 'a spawned child sees no PTY_BROKER_* key (bar the scratch-broker no-auth flag)');
    ok(
      seen.filter((k) => /^HARBOR_WB_/i.test(k)).sort().join(',') === 'HARBOR_WB_FABRIC_URL,HARBOR_WB_NATS_URL',
      `a spawned child sees only the two pinned HARBOR_WB_* keys (${seen.filter((k) => /^HARBOR_WB_/i.test(k)).join(',')})`,
    );
    eq(seen.filter((k) => /^path$/i.test(k)).length, 1, 'a spawned child sees exactly one PATH key');
    ok(seen.includes('WB_TEST_PORT_OFFSET'), 'and the offset it was handed');
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, saved);
  }
}

console.log('\n[scratchShell]');
{
  const shell = scratchShell();
  ok(typeof shell === 'string' && shell.length > 0, `scratchShell() returns a non-empty string (got ${JSON.stringify(shell)})`);
  eq(shell, process.platform === 'win32' ? 'powershell.exe' : '/bin/bash', `scratchShell() matches the current platform (${process.platform})`);
}

console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
