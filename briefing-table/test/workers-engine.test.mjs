/**
 * WORKERS through a real scratch engine + scratch pty-broker (ticket): the
 * HTTP engine port, the broker spawn path, the constant run script, `timeout`,
 * and the result parse, end to end. The vendor CLIs are FAKES (node scripts in
 * a temp bin dir, named by HARBOR_WB_WORKER_BIN_*): no real claude or gemini
 * runs here. Both broker links (`homebase`, `gemini`) point at the one scratch
 * broker, which runs as this account — the account split is the real brokers'
 * job and is not what this suite proves.
 *
 *   - bearer required (401 without), Fable 400, kill switch 503;
 *   - claude: explicit --model/--effort/json/--no-session-persistence/
 *     --strict-mcp-config, the prompt on stdin byte-for-byte (shell
 *     metacharacters inert), env HARBOR_WB_ORIGIN=dispatched;
 *   - gemini: -m/--approval-mode yolo/--output-format json, the prompt as ONE
 *     --prompt argument byte-for-byte; a billing error -> capped credit_exhausted;
 *   - wall clock: `timeout` ends a hung worker -> capped wall_clock;
 *   - output cap -> truncated + capped output_cap; DELETE -> failed stopped;
 *   - a worker is not a session: /api/table never lists it;
 *   - the stub (test/fixtures/workers-stub.mjs) answers the same shapes.
 * SAFETY: engine P(272), broker P(273), temp table + dirs, childEnv(),
 * fabric + NATS off; never :7420/:7430/:8200/:8201/:8204.
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, scratchShell } from './_scratch.mjs';
import { startWorkersStub } from './fixtures/workers-stub.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(272);
const BROKER_PORT = P(273);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'workers-engine-test-token';

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  X ${msg}`);
  }
}
const eq = (a, b, msg) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  ok(x === y, x === y ? msg : `${msg} (got ${x}, want ${y})`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method, json, auth = true, base = BASE, token = TOKEN } = {}) {
  const headers = auth ? { authorization: `Bearer ${token}` } : {};
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function finished(id, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call(`/api/workers/${id}`);
    if (r.body?.worker?.state === 'exited' || Date.now() > end) return r.body?.worker ?? null;
    await sleep(150);
  }
}

/* The fakes. #!<this node> so no PATH lookup is involved. */
const FAKE_CLAUDE = `#!${process.execPath}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  if (stdin.includes('SLEEP')) { setTimeout(() => {}, 120000); return; }
  if (stdin.includes('FLOOD')) { process.stdout.write('x'.repeat(200000)); return; }
  const echo = { args: process.argv.slice(2), stdin, origin: process.env.HARBOR_WB_ORIGIN, worker: process.env.HARBOR_WB_WORKER, cwd: process.cwd() };
  process.stdout.write('some startup noise' + String.fromCharCode(10));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: JSON.stringify(echo), usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.002 }) + String.fromCharCode(10));
});
`;
const FAKE_GEMINI = `#!${process.execPath}
const a = process.argv.slice(2);
const prompt = a[a.indexOf('--prompt') + 1];
if (prompt.includes('CREDIT')) {
  process.stdout.write(JSON.stringify({ error: { type: 'Error', message: 'You exceeded your current quota, please check your plan and billing details.', code: 429 } }, null, 2) + String.fromCharCode(10));
  process.exit(1);
}
const out = { response: JSON.stringify({ args: a.slice(0, a.indexOf('--prompt')), prompt }), stats: { models: { m: { tokens: { prompt: 11, candidates: 3, thoughts: 2 } } } } };
process.stdout.write(JSON.stringify(out, null, 2) + String.fromCharCode(10));
`;

function ownGroup() {
  const gid = String(process.getgid());
  return readFileSync('/etc/group', 'utf8').split(String.fromCharCode(10)).map((l) => l.split(':')).find((f) => f[2] === gid)?.[0] ?? 'none';
}

async function run() {
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'workers-engine.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-workers-engine-'));
  const binDir = join(tmpDir, 'bin');
  const workDir = join(tmpDir, 'workers');
  const killSwitch = join(tmpDir, 'dispatch-blocked');
  const project = join(tmpDir, 'project');
  const canary = join(tmpDir, 'injected');
  for (const d of [binDir, project]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(binDir, 'fake-claude'), FAKE_CLAUDE);
  writeFileSync(join(binDir, 'fake-gemini'), FAKE_GEMINI);
  chmodSync(join(binDir, 'fake-claude'), 0o755);
  chmodSync(join(binDir, 'fake-gemini'), 0o755);
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  let stub = null;
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.ok || r.status === 401).catch(() => false)) return true;
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
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) throw new Error(`broker did not come up\n${log}`);
    const brokerUrl = `ws://${HOST}:${BROKER_PORT}`;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_BROKERS: JSON.stringify({ homebase: { url: brokerUrl }, gemini: { url: brokerUrl } }),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] }),
        HARBOR_WB_WORKERS_DIR: workDir,
        // The group this process can chown to (a login session may predate the
        // `agents` membership the real engine has); the gemini check needs it.
        HARBOR_WB_WORKERS_GROUP: ownGroup(),
        HARBOR_WB_DISPATCH_BLOCKED: killSwitch,
        HARBOR_WB_WORKER_BIN_CLAUDE: join(binDir, 'fake-claude'),
        HARBOR_WB_WORKER_BIN_GEMINI: join(binDir, 'fake-gemini'),
        HARBOR_WB_WORKER_JOBS_PER_DAY: '50',
        HARBOR_WB_WORKER_MAX_CONCURRENT: '5',
      }),
    });
    engine.stdout.on('data', (d) => (log += d));
    engine.stderr.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) throw new Error(`engine did not come up\n${log}`);

    console.log('\n[auth, validation, kill switch]');
    const spec = { jobId: 'j1', vendor: 'claude-code', model: 'sonnet', params: { effort: 'high' }, cwd: project, prompt: 'hello', budget: { maxSeconds: 20, maxOutputBytes: 65536 } };
    eq((await call('/api/workers', { json: spec, auth: false })).status, 401, 'no bearer -> 401 (not loopback-exempt)');
    const fable = await call('/api/workers', { json: { ...spec, model: 'fable' } });
    eq([fable.status, fable.body?.field], [400, 'model'], 'Fable -> 400 field model');
    const noModel = await call('/api/workers', { json: { ...spec, model: undefined } });
    eq([noModel.status, noModel.body?.field], [400, 'model'], 'missing model -> 400');
    writeFileSync(killSwitch, '');
    const blocked = await call('/api/workers', { json: spec });
    eq([blocked.status, blocked.body?.error], [503, 'dispatch-blocked'], 'kill switch present -> 503 dispatch-blocked');
    rmSync(killSwitch);

    console.log('\n[claude worker: argv, stdin prompt, env]');
    const tricky = `review "this" $(touch ${canary}) \`touch ${canary}\`; rm -rf nothing'\n\tline two ✓`;
    const c = await call('/api/workers', { json: { ...spec, prompt: tricky } });
    eq(c.status, 201, `POST -> 201 ${c.status === 201 ? '' : JSON.stringify(c.body)}`);
    ok(/^wk-[0-9a-f]{12}$/.test(c.body?.workerId ?? ''), `a worker id (${c.body?.workerId})`);
    const cw = await finished(c.body?.workerId);
    eq([cw?.state, cw?.result?.status, cw?.result?.stopReason], ['exited', 'done', 'end_turn'], 'claude worker -> done');
    const echo = JSON.parse(cw?.result?.text || '{}');
    eq(echo.args, ['-p', '--model', 'sonnet', '--effort', 'high', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'], 'claude got the explicit flags, nothing else');
    eq(echo.stdin, tricky, 'the prompt arrived on stdin byte-for-byte');
    ok(!existsSync(canary), 'no shell metacharacter in the prompt executed');
    eq([echo.origin, echo.worker, echo.cwd], ['dispatched', c.body?.workerId, project], 'env marks it dispatched + names the worker; cwd is the spec cwd');
    eq(cw?.result?.usage?.inTokens, 15, 'usage parsed (input + cache read)');

    console.log('\n[gemini worker: argv prompt, credit exhaustion]');
    const g = await call('/api/workers', { json: { ...spec, vendor: 'gemini-cli', model: 'gemini-2.5-pro', params: {}, prompt: tricky } });
    const gw = await finished(g.body?.workerId);
    eq([gw?.result?.status, gw?.result?.usage?.inTokens, gw?.result?.usage?.outTokens], ['done', 11, 5], 'gemini worker -> done with tokens');
    const gecho = JSON.parse(gw?.result?.text || '{}');
    eq(gecho.args, ['-m', 'gemini-2.5-pro', '--output-format', 'json'], 'gemini got the explicit flags (no yolo: the auto-approve default is off until a person chooses)');
    eq(gecho.prompt, tricky.replace(/\n+$/, ''), 'the prompt arrived as one --prompt argument, intact');
    ok(!existsSync(canary), 'still nothing injected');
    const gc = await call('/api/workers', { json: { ...spec, vendor: 'gemini-cli', model: 'gemini-2.5-pro', params: {}, prompt: 'CREDIT' } });
    const gcw = await finished(gc.body?.workerId);
    eq([gcw?.result?.status, gcw?.result?.stopReason], ['capped', 'credit_exhausted'], 'billing exhaustion -> capped / credit_exhausted');

    console.log('\n[caps: wall clock, output, stop]');
    const t0 = Date.now();
    const h = await call('/api/workers', { json: { ...spec, jobId: 'j2', prompt: 'SLEEP', budget: { maxSeconds: 2, maxOutputBytes: 1000 } } });
    const hw = await finished(h.body?.workerId, 20000);
    eq([hw?.result?.status, hw?.result?.stopReason, hw?.result?.exitCode], ['capped', 'wall_clock', 124], 'a hung worker is ended by timeout -> capped wall_clock');
    ok(Date.now() - t0 < 10000, `ended near maxSeconds (${Date.now() - t0}ms)`);
    const f = await call('/api/workers', { json: { ...spec, jobId: 'j2', prompt: 'FLOOD', budget: { maxSeconds: 20, maxOutputBytes: 1000 } } });
    const fw = await finished(f.body?.workerId);
    eq([fw?.truncated, fw?.outputBytes, fw?.result?.status, fw?.result?.stopReason], [true, 1000, 'capped', 'output_cap'], 'output over the cap -> truncated at 1000 bytes, capped');
    const s = await call('/api/workers', { json: { ...spec, jobId: 'j3', prompt: 'SLEEP' } });
    await sleep(500);
    const del = await call(`/api/workers/${s.body?.workerId}`, { method: 'DELETE' });
    eq([del.status, del.body?.worker?.result?.status, del.body?.worker?.result?.stopReason], [200, 'failed', 'stopped'], 'DELETE -> failed / stopped');
    eq((await call('/api/workers/wk-000000000000')).status, 404, 'unknown worker -> 404');

    console.log('\n[a worker is not a session]');
    const list = await call('/api/workers?jobId=j2');
    eq(list.body?.workers?.map((w) => w.jobId), ['j2', 'j2'], 'GET ?jobId= lists that job only');
    const table = await call('/api/table');
    const rows = table.body?.sessions ?? table.body?.rows ?? [];
    ok(table.status === 200 && !JSON.stringify(rows).includes('wk-'), 'no worker appears in /api/table (the manager)');
    await sleep(300);
    eq(readdirSync(workDir).filter((x) => x.endsWith('.prompt')), [], 'every prompt file was removed at exit');

    console.log('\n[the stub answers the same shapes]');
    stub = await startWorkersStub({ port: 0, token: 'stub' });
    const sf = await call('/api/workers', { json: { ...spec, model: 'fable' }, base: stub.url, token: 'stub' });
    eq([sf.status, sf.body?.error, sf.body?.field], [fable.status, fable.body?.error, fable.body?.field], 'stub refuses Fable like the engine');
    const sc = await call('/api/workers', { json: spec, base: stub.url, token: 'stub' });
    const sv = (await call(`/api/workers/${sc.body?.workerId}`, { base: stub.url, token: 'stub' })).body?.worker;
    eq(Object.keys(sv ?? {}).sort(), Object.keys(cw ?? {}).sort(), 'stub worker view has the engine view keys');
    eq(Object.keys(sv?.result ?? {}).sort(), Object.keys(cw?.result ?? {}).sort(), 'stub result has the engine result keys');
    const sx = await call('/api/workers', { json: { ...spec, prompt: 'x [stub:credit_exhausted]' }, base: stub.url, token: 'stub' });
    eq(sx.body?.worker?.result?.stopReason, 'credit_exhausted', 'stub canned outcome by prompt marker');
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  X threw: ${e?.stack ?? e}`);
    console.log(`--- log tail ---\n${log.slice(-2500)}`);
  } finally {
    await stub?.close();
    await kill(engine);
    await kill(broker);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
