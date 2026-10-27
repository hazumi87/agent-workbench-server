/**
 * THE ENGINE PACKAGE BUILD (scripts/build-engine-package.mjs): build into a temp folder, then start the BUILT entry with plain Node
 * (no tsx) in local mode and hit it. Proves what the app will actually run: dist/ compiled for plain Node with the broker protocol
 * vendored, web/ beside it, and nothing in the output that still imports TypeScript.
 *
 * SAFETY: a temp folder; node_modules is a symlink to this checkout's; no broker; the engine binds port 0.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, P } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`  ok ${m}`);
  } else {
    failed++;
    console.log(`  FAIL ${m}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (port, path, token) =>
  new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.end();
  });

const tmp = mkdtempSync(join(tmpdir(), 'wb-pkg-'));
const out = join(tmp, 'pkg');
let proc = null;
try {
  const b = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'build-engine-package.mjs'), '--out', out], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 170000 });
  ok(b.status === 0, `the build succeeds (${(b.stdout + b.stderr).trim().split('\n').pop()?.slice(0, 100)})`);
  const manifest = JSON.parse(readFileSync(join(out, 'BUILD-MANIFEST.json'), 'utf8'));
  ok(manifest.entry === 'dist/server/index.js' && manifest.nodeTarget === '22.23.1', 'the manifest names the entry and the pinned Node');
  ok(manifest.vendored.length === 1 && /^[a-f0-9]{64}$/.test(manifest.vendored[0].sourceSha256) && /^[a-f0-9]{64}$/.test(manifest.vendored[0].outputSha256), 'the vendored protocol file is recorded with both hashes');
  ok(Object.keys(manifest.files).length > 100 && Object.values(manifest.files).every((h) => /^[a-f0-9]{64}$/.test(h)), 'every dist file has a SHA-256');
  ok(JSON.stringify(manifest.nativeModulesNeeded) === JSON.stringify(['better-sqlite3', 'node-pty']), 'the manifest lists the native modules local mode needs');
  ok(existsSync(join(out, 'web', 'room.html')) && existsSync(join(out, 'dist', 'vendor', 'pty-broker-protocol.js')), 'web/ sits beside dist/ and the vendored file is in place');
  const brokerClient = readFileSync(join(out, 'dist', 'engine', 'broker-client.js'), 'utf8');
  ok(!brokerClient.includes('pty-broker/src/protocol.ts') && brokerClient.includes('../vendor/pty-broker-protocol.js'), 'the broker client imports the vendored JS, not the TypeScript source');
  ok(!existsSync(join(out, 'node_modules')) && !existsSync(join(out, 'dist', 'server', 'index.ts')), 'the build ships no node_modules and no .ts entry (natives are the next step)');

  ok(existsSync(join(out, 'broker', 'main.js')) && existsSync(join(out, 'broker', 'protocol.js')) && manifest.broker?.entry === 'broker/main.js', 'the pty broker is compiled into broker/ and the manifest names its entry, env and readiness');
  ok(Object.keys(manifest.files).filter((f) => f.startsWith('broker/')).length === 3 && manifest.broker.files['broker/main.js'].sourceSha256.length === 64, 'its files are hash-recorded (source and output)');
  ok(!readFileSync(join(out, 'broker', 'main.js'), 'utf8').includes("./protocol.ts"), 'and it imports its protocol as JavaScript');

  symlinkSync(join(REPO_ROOT, 'node_modules'), join(out, 'node_modules'), 'dir');
  /* the broker, run from the package on plain Node: up, /health open, port as told */
  const brokerPort = P(554);
  const brokerProc = spawn(process.execPath, ['broker/main.js'], { cwd: out, env: childEnv({ PTY_BROKER_PORT: String(brokerPort), PTY_BROKER_TOKEN: 'broker-test-token' }) });
  let bout = '';
  brokerProc.stdout.on('data', (d) => (bout += d));
  brokerProc.stderr.on('data', (d) => (bout += d));
  let brokerUp = false;
  for (let t = 0; t < 20000 && !brokerUp; t += 200) {
    await sleep(200);
    brokerUp = await fetch(`http://127.0.0.1:${brokerPort}/health`).then((r) => r.ok).catch(() => false);
  }
  ok(brokerUp && /pty-broker up on/.test(bout), 'the BUILT broker starts on plain Node and answers /health');
  brokerProc.kill('SIGKILL');
  const dataDir = join(tmp, 'data');
  proc = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: out,
    env: childEnv({ HARBOR_WB_MODE: 'local', HARBOR_WB_TOKEN: 'pkg-test-token', HARBOR_WB_DATA_DIR: dataDir, HARBOR_WB_FILES_DIR: join(tmp, 'files'), HARBOR_WB_MEMORY_CEILING_MB: '0', HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(P(552)), HARBOR_WB_NODE: 'testnode' }),
  });
  let so = '';
  let se = '';
  proc.stdout.on('data', (d) => (so += d));
  proc.stderr.on('data', (d) => (se += d));
  let port = 0;
  for (let t = 0; t < 40000 && !port; t += 200) {
    await sleep(200);
    try {
      port = JSON.parse(so.split('\n')[0]).port;
    } catch {
      /* not yet */
    }
  }
  ok(port > 0, `the BUILT engine started on plain Node and printed its ready line (${port})`);
  ok(await get(port, '/health') === 200, '/health answers');
  ok(await get(port, '/api/table') === 401, 'an API route without the token: 401');
  ok(await get(port, '/api/table', 'pkg-test-token') === 200, '...with the token: 200');
  ok(await get(port, '/room.html', 'pkg-test-token') === 200, 'the web page is served from web/ beside dist/');
  ok(!/Cannot find|ERR_|ENOENT/.test(se), `no missing-file or module errors on stderr${/Cannot find|ERR_|ENOENT/.test(se) ? `: ${se.slice(0, 200)}` : ''}`);
  ok(readdirSync(dataDir).length > 0 && !existsSync(join(out, 'data')), 'its state went to the data folder, nothing was written into the package');
} catch (e) {
  failed++;
  console.log(`  FAIL harness: ${e?.stack ?? e}`);
} finally {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL');
  }
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
