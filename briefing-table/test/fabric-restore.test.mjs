/**
 * POST /api/fabric/restore + held-mail preambles, through a real scratch
 * engine, a real scratch broker and a STUB `claude` (ticket).
 *
 * The stub is first on the broker's PATH and picks its behaviour from a mode
 * file named by the `--resume <id>` it was launched with:
 *   ok          banner + `? for shortcuts` (the startup gate clears), then
 *               appends every typed line to typed/<id>
 *   notfound    claude's own words, `No conversation found with session ID:
 *               <id>` (CC 2.1.286 binary), then exits — the shell stays
 *   exit        kills its parent shell: the pty ends
 *   permission  a permission dialog (prompt-block: needs you)
 *   trust       the folder-trust startup prompt (needs you)
 *   hang        prints nothing
 *   slow        waits 2 s, then as ok
 * A TEST MUST NEVER LAUNCH THE REAL CLAUDE: a PREFLIGHT resolves `claude` in
 * the pane's own shell with the broker's env and aborts unless it is the stub,
 * and the stub prints a sentinel the suite waits for.
 *
 * Covers: auth (no credential 401; the restore-scoped token works on this
 * route only, and not at all once its file is gone; the bearer works), no
 * session, not resumable (vendor, and a user-ended row), success (no window:
 * the pane is left parked), already live, session-not-found (the pane goes
 * back to dehydrated), exited, needs-you (permission; trust) with the pane
 * left alive, timeout, the 3-per-hour cap, a concurrent call joining the
 * in-flight one; then held mail: a pre-existing mailbox of two old envelopes
 * (no `delivery` field) replayed on subscribe after the restore arrives as ONE
 * typed line under ONE hold preamble, oldest first; an envelope sent after the
 * pane is live arrives plain; an engine restart with ADOPTION does not wrap.
 *
 * SAFETY: scratch engine P(304), LIVE scratch broker P(305), stub fabric
 * P(306); temp table, childEnv(), NATS off, a fake (empty) /proc root; never
 * :7420/:7430/:8200/:8201/:8204. The temp dir is removed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

if (process.platform !== 'linux') {
  console.log('fabric-restore.test: Linux only (POSIX stub claude) - skipped');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(304);
const BROKER_PORT = P(305);
const FAB_PORT = P(306);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'fabric-restore-test-token';
const RESTORE_TOKEN = 'fabric-restore-scoped-token';
const SENTINEL = 'FABRIC-RESTORE-STUB-CLAUDE';
const LF = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: '/bin/bash' }] });

let passed = 0;
let failed = 0;
function ok(cond, msg, got) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
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

async function call(path, { json, auth = 'bearer', method } = {}) {
  const headers = {};
  if (auth === 'bearer') headers.authorization = `Bearer ${TOKEN}`;
  if (auth === 'restore') headers.authorization = `Bearer ${RESTORE_TOKEN}`;
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const restore = (slug, auth = 'bearer', extra = {}) => call('/api/fabric/restore', { json: { slug, ...extra }, auth });
const rowOf = async (paneid) => ((await call('/api/table')).body?.sessions ?? []).find((s) => s.paneid === paneid);

/* ---- the stub fabric: /ack, and WS /subscribe replaying a mailbox ---------- */
function stubFabric() {
  const mailbox = []; // {env, acked}
  const acks = [];
  const subscribes = [];
  let sock = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/ack') {
        try {
          const b = JSON.parse(body);
          acks.push(b);
          const m = mailbox.find((x) => x.env.id === b.id);
          if (m) m.acked = true;
        } catch {
          /* ignore */
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"stub fabric"}');
    });
  });
  const wss = new WebSocketServer({ server, path: '/subscribe' });
  wss.on('connection', (ws) => {
    sock = ws;
    ws.send(JSON.stringify({ type: 'ready' }));
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.type !== 'subscribe') return;
      const slugs = Array.isArray(m.slugs) ? m.slugs : [];
      subscribes.push({ at: Date.now(), slugs });
      ws.send(JSON.stringify({ type: 'subscribed', slugs, rejected: [] }));
      for (const x of mailbox) {
        if (!x.acked && slugs.includes(x.env.to)) ws.send(JSON.stringify({ type: 'message', envelope: x.env }));
      }
    });
  });
  return {
    server,
    mailbox,
    acks,
    subscribes,
    push: (env) => sock?.send(JSON.stringify({ type: 'message', envelope: env })),
    close: () => new Promise((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => r());
    }),
  };
}

const envelope = (id, to, from, ts, extra = {}) => ({
  id, ts, from, to, kind: 'msg', class: 'coordination', attention: 'notice', thread: `t-${id}`, body: `body ${id}`, ack: 'none', ...extra,
});

async function run() {
  for (const p of [PORT, BROKER_PORT, FAB_PORT]) {
    await assertFree(p, 'fabric-restore.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-fabric-restore-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const binDir = join(tmpDir, 'bin');
  const modes = join(tmpDir, 'modes');
  const typed = join(tmpDir, 'typed');
  const noProc = join(tmpDir, 'noproc'); // absent: guard 9 / guard 7 "could not tell" (deliver, proceed)
  const tokenFile = join(tmpDir, 'restore.token');
  for (const d of [binDir, modes, typed]) mkdirSync(d);
  writeFileSync(tokenFile, `  ${RESTORE_TOKEN}${LF}`, { mode: 0o600 }); // spaces + newline: must be trimmed
  const stubPath = join(binDir, 'claude');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      `echo ${SENTINEL}`,
      'sid=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--resume" ]; then sid="$a"; fi',
      '  prev="$a"',
      'done',
      `mode=$(cat "${modes}/$sid" 2>/dev/null)`,
      'case "$mode" in',
      '  notfound) echo "No conversation found with session ID: $sid"; exit 1 ;;',
      '  exit) kill -9 $PPID; exit 1 ;;',
      '  hang) exec sleep 600 ;;',
      '  permission) echo "Claude Code v9.9.9"; echo "Bash command"; echo "Do you want to proceed?"; exec sleep 600 ;;',
      '  trust) echo "Quick safety check: Is this a project you created or one you trust?"; echo "Yes, I trust this folder"; exec sleep 600 ;;',
      '  slow) sleep 2 ;;',
      'esac',
      'echo "Claude Code v9.9.9"',
      'echo "? for shortcuts"',
      'while IFS= read -r line; do',
      `  printf '%s${BS}n' "$line" >> "${typed}/$sid"`,
      `  printf '%0900d${BS}n' 0`,
      '  echo "? for shortcuts"',
      'done',
      '',
    ].join(LF),
  );
  chmodSync(stubPath, 0o755);
  const brokerEnv = childEnv({ PATH: `${binDir}${delimiter}${process.env.PATH || ''}`, PTY_BROKER_PORT: String(BROKER_PORT) });

  /* PREFLIGHT: which `claude` would the pane's shell run? */
  const probe = spawnSync('/bin/bash', ['-ic', 'command -v claude'], { env: brokerEnv, encoding: 'utf8', cwd: tmpDir });
  const resolved = String(probe.stdout || '').trim().split(LF).pop();
  if (resolved !== stubPath) {
    console.log(`X PREFLIGHT: the pane's shell resolves claude to ${JSON.stringify(resolved)}, not the stub ${stubPath}. Refusing to run.`);
    process.exit(2);
  }
  ok(true, `preflight: the pane's shell resolves claude to the stub`);

  const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const CASES = {
    okay: { n: 1, mode: 'ok' },
    nofind: { n: 2, mode: 'notfound' },
    exiter: { n: 3, mode: 'exit' },
    permy: { n: 4, mode: 'permission' },
    trusty: { n: 5, mode: 'trust' },
    hangs: { n: 6, mode: 'hang' },
    capped: { n: 7, mode: 'notfound' },
    slowpoke: { n: 8, mode: 'slow' },
    mailbox: { n: 9, mode: 'ok' },
  };
  const recipes = [];
  const sessions = [];
  /* A BANKED ID HAS A TRANSCRIPT, as it does in real use (the engine only banks an id it launched, and claude writes the
     file): without one the restore starts FRESH since 2026-10-13 (src/engine/restore-fresh.ts), which is its own case below. */
  const projDir = join(tmpDir, 'claude-projects', tmpDir.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projDir, { recursive: true });
  for (const [slug, c] of Object.entries(CASES)) {
    writeFileSync(join(projDir, `${sid(c.n)}.jsonl`), `{"type":"user","sessionId":"${sid(c.n)}"}${LF}`);
    writeFileSync(join(modes, sid(c.n)), c.mode);
    recipes.push({ id: `rec-${slug}`, name: `R ${slug}`, projectDir: tmpDir, vendor: 'claude-code', agent: slug });
    sessions.push({ paneid: `recipe:rec-${slug}`, recipe_id: `rec-${slug}`, vendor: 'claude-code', agent: slug, session_id: sid(c.n), state: 'dehydrated' });
  }
  recipes.push({ id: 'rec-fresh', name: 'R fresh', projectDir: tmpDir, vendor: 'claude-code', agent: 'fresh' });
  sessions.push({ paneid: 'recipe:rec-fresh', recipe_id: 'rec-fresh', vendor: 'claude-code', agent: 'fresh', session_id: sid(10), state: 'dehydrated' });
  recipes.push({ id: 'rec-shelly', name: 'R shelly', projectDir: tmpDir, vendor: 'cli-manager', agent: 'shelly' });
  sessions.push({ paneid: 'recipe:rec-shelly', recipe_id: 'rec-shelly', vendor: 'cli-manager', agent: 'shelly', state: 'dehydrated' });
  recipes.push({ id: 'rec-ended', name: 'R ended', projectDir: tmpDir, vendor: 'claude-code', agent: 'ended' });
  sessions.push({ paneid: 'recipe:rec-ended', recipe_id: 'rec-ended', vendor: 'claude-code', agent: 'ended', session_id: sid(99), state: 'killed' });
  const seeded = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify({ recipes, sessions })], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (seeded.code !== 0) throw new Error(`seed failed: ${seeded.err}`);

  const fab = stubFabric();
  await new Promise((r) => fab.server.listen(FAB_PORT, HOST, r));
  /* A pre-existing mailbox for `mailbox`: two envelopes left hours ago, from
     BEFORE the fabric stamped `delivery` (no field). Listed newest first. */
  const now = Date.now();
  fab.mailbox.push({ env: envelope('mb-late', 'mailbox', 'asset-lead', new Date(now - 30 * 60e3).toISOString()), acked: false });
  fab.mailbox.push({ env: envelope('mb-early', 'mailbox', 'asset-lead', new Date(now - 90 * 60e3).toISOString()), acked: false });

  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let engineLog = '';
  let broker = null;
  let engine = null;
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const bootEngine = () => {
    engineLog = '';
    const e = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
        HARBOR_WB_PROC_ROOT: noProc,
        HARBOR_WB_FABRIC_URL: `http://${HOST}:${FAB_PORT}`,
        HARBOR_WB_FABRIC_RESTORE_TOKEN_FILE: tokenFile,
        HARBOR_WB_FABRIC_RESTORE_WAIT_MS: '6000',
        HARBOR_WB_FABRIC_BATCH_MS: '400',
        HARBOR_WB_ROOM_TYPE_SETTLE_MS: '200',
      }),
    });
    e.stdout.on('data', (d) => ((log += d), (engineLog += d)));
    e.stderr.on('data', (d) => ((log += d), (engineLog += d)));
    return e;
  };
  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], { cwd: REPO_ROOT, env: brokerEnv });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) throw new Error(`broker did not come up\n${log}`);
    engine = bootEngine();
    if (!(await up(`${BASE}/health`))) throw new Error(`engine did not come up\n${log}`);

    console.log('\n[auth: the bearer, or the restore-scoped token on THIS route only]');
    let r = await restore('nobody', 'none');
    eq(r.status, 401, 'no credential: 401');
    r = await restore('nobody', 'restore');
    eq([r.status, r.body], [200, { ok: false, reason: 'no-session' }], 'the restore token reaches the route');
    r = await call('/api/table', { auth: 'restore' });
    eq(r.status, 401, 'the restore token on GET /api/table: 401');
    r = await call('/api/fabric/inbound', { auth: 'restore', json: envelope('x', 'okay', 'a', new Date().toISOString()) });
    eq(r.status, 401, 'the restore token on POST /api/fabric/inbound: 401');
    ok(/restore token REFUSED on GET \/api\/table/.test(log), 'the refusal is logged');
    r = await restore('nobody');
    eq([r.status, r.body?.reason], [200, 'no-session'], 'the engine bearer reaches the route too');
    r = await call('/api/fabric/restore', { json: {} });
    eq([r.status, r.body?.field], [400, 'slug'], 'no slug: 400 naming the field');
    renameSync(tokenFile, `${tokenFile}.away`);
    r = await restore('nobody', 'restore');
    eq(r.status, 401, 'the token file missing: the restore token is not accepted (401)');
    renameSync(`${tokenFile}.away`, tokenFile);
    r = await restore('nobody', 'restore');
    eq(r.status, 200, 'the file back: accepted again, no restart');

    console.log('\n[refusals before any spawn]');
    r = await restore('shelly');
    eq([r.body?.ok, r.body?.reason], [false, 'not-resumable'], 'a cli-manager session: not-resumable');
    r = await restore('ended');
    eq([r.body?.ok, r.body?.reason, r.body?.detail], [false, 'not-resumable', 'state killed'], 'a user-ended claude session: not-resumable (never auto-resumes)');

    console.log('\n[success: restored with no window, left parked]');
    r = await restore('okay', 'bearer', { envelope_id: 'env-okay-1' });
    eq(r.body, { ok: true, paneid: 'recipe:rec-okay' }, 'ok with the paneid');
    ok(/fabric restore okay \(envelope env-okay-1\): ok recipe:rec-okay in \d+ms/.test(log), 'one log line names the slug, the envelope id and the outcome');
    let row = await rowOf('recipe:rec-okay');
    eq([row?.state, row?.windows], ['live', 0], 'the row is live with no window (parked)');
    ok(!/launch: "R okay" → window/.test(log), 'no window was placed');
    r = await restore('okay');
    eq(r.body, { ok: true, paneid: 'recipe:rec-okay', already: true }, 'again: already live');

    console.log('\n[a banked id whose transcript was never written: starts fresh, not "No conversation found"]');
    r = await restore('fresh');
    eq([r.body?.ok, r.body?.paneid], [true, 'recipe:rec-fresh'], 'fresh: restored ok');
    ok(/no transcript was ever written for 00000000-0000-4000-8000-000000000010 .*starting fresh/.test(log), 'the log says so');
    ok(!/spawn \S+ for recipe "rec-fresh".*\(RESTORED\)/.test(log), 'and the launch is not a --resume');

    console.log('\n[session-not-found: claude\'s own words; the pane goes back to dehydrated]');
    r = await restore('nofind');
    eq([r.body?.ok, r.body?.reason, r.body?.paneid], [false, 'session-not-found', 'recipe:rec-nofind'], 'session-not-found');
    row = await until(async () => {
      const x = await rowOf('recipe:rec-nofind');
      return x?.state === 'dehydrated' ? x : null;
    }, 6000);
    eq(row?.state, 'dehydrated', 'the bare shell is ended back to dehydrated');

    console.log('\n[exited]');
    r = await restore('exiter');
    eq([r.body?.ok, r.body?.reason], [false, 'exited'], 'the pty ended: exited');
    ok(/^exit code /.test(r.body?.detail ?? ''), `...with the exit code as detail (${r.body?.detail})`);

    console.log('\n[needs-you: left alive for the human]');
    r = await restore('permy');
    eq([r.body?.ok, r.body?.reason, r.body?.detail], [false, 'needs-you', 'permission'], 'a permission dialog: needs-you (permission)');
    eq((await rowOf('recipe:rec-permy'))?.state, 'live', 'the pane is left alive');
    r = await restore('trusty');
    eq([r.body?.ok, r.body?.reason, r.body?.detail], [false, 'needs-you', 'trust'], 'the trust prompt: needs-you (trust)');
    eq((await rowOf('recipe:rec-trusty'))?.state, 'live', 'the pane is left alive');

    console.log('\n[timeout]');
    const t0 = Date.now();
    r = await restore('hangs');
    eq([r.body?.ok, r.body?.reason], [false, 'timeout'], 'nothing in the wait window: timeout');
    ok(Date.now() - t0 >= 5500, `...after the configured wait (${Date.now() - t0}ms)`);

    console.log('\n[the cap: 3 per slug per rolling hour]');
    for (let i = 1; i <= 3; i++) {
      r = await restore('capped');
      eq(r.body?.reason, 'session-not-found', `restore ${i} runs (session-not-found)`);
      await until(async () => (await rowOf('recipe:rec-capped'))?.state === 'dehydrated', 6000);
    }
    r = await restore('capped');
    eq([r.body?.ok, r.body?.reason], [false, 'restore-cap'], 'the 4th in the hour: restore-cap');

    console.log('\n[one restore per slug: a concurrent call joins]');
    const [a, b] = await Promise.all([restore('slowpoke'), restore('slowpoke')]);
    eq([a.body, b.body], [{ ok: true, paneid: 'recipe:rec-slowpoke' }, { ok: true, paneid: 'recipe:rec-slowpoke' }], 'both answer ok with the same pane');
    ok(/fabric restore slowpoke: joined the in-flight restore: ok recipe:rec-slowpoke/.test(log), 'the second joined the first');
    eq((log.match(/spawn \S+ for recipe "rec-slowpoke"/g) ?? []).length, 1, 'exactly one spawn');

    console.log('\n[held mail: an old mailbox replayed after the restore is ONE line under ONE preamble]');
    r = await restore('mailbox');
    eq(r.body, { ok: true, paneid: 'recipe:rec-mailbox' }, 'mailbox restored');
    const typedFile = join(typed, sid(9));
    const lines = () => (existsSync(typedFile) ? readFileSync(typedFile, 'utf8').split(LF).filter(Boolean) : []);
    await until(() => lines().length >= 1, 15000);
    const first = lines()[0] ?? '';
    ok(first.startsWith('You were offline. These 2 messages were left for you, oldest first'), 'the hold preamble opens the line', first.slice(0, 120));
    eq((first.match(/You were offline/g) ?? []).length, 1, 'ONE preamble for both');
    ok(first.indexOf('id:mb-early') > 0 && first.indexOf('id:mb-early') < first.indexOf('id:mb-late'), 'oldest first');
    ok(/\[1 of 2 · from asset-lead at \d{4}-\d\d-\d\dT[\d:.]+Z\]/.test(first), 'each item carries its from and ISO ts');
    ok(/delivery=hold\(inferred\)/.test(log), 'the engine log names the inferred hold');
    eq(fab.acks.filter((x) => x.id.startsWith('mb-') && x.level === 'delivered').length, 2, 'both acked delivered');

    console.log('\n[an envelope sent after the pane is live arrives plain]');
    fab.push(envelope('mb-now', 'mailbox', 'live-sender', new Date().toISOString()));
    await until(() => lines().length >= 2, 20000);
    const second = lines()[1] ?? '';
    ok(second.startsWith('[fabric · @live-sender · msg · t:t-mb-now · id:mb-now] body mb-now'), 'typed exactly as today, no preamble', second);

    console.log('\n[a delivery:\'restore\' envelope keeps the restore note]');
    const slowFile = join(typed, sid(8));
    fab.push(envelope('rs-1', 'slowpoke', 'restorer', new Date(Date.now() - 60e3).toISOString(), { delivery: 'restore' }));
    await until(() => existsSync(slowFile) && readFileSync(slowFile, 'utf8').trim(), 15000);
    const rl = existsSync(slowFile) ? readFileSync(slowFile, 'utf8').split(LF)[0] : '';
    ok(rl.startsWith('You were disconnected, and reconnected for an incoming message. Note, any background tasks you may have had running in your session were ended when disconnected. Your incoming message is as follows. [from restorer at '), 'the restore note, then from/ts', rl.slice(0, 200));
    ok(!rl.includes('You were offline'), 'never the hold preamble (its ts is before the restore too)');

    console.log('\n[an engine restart with adoption does not wrap in-flight mail]');
    const firstEngine = engine;
    const gone = new Promise((res) => firstEngine.once('exit', res));
    firstEngine.kill('SIGKILL');
    await gone;
    const beforeRestart = new Date().toISOString(); // sent while the engine was down, the pane live all along
    await sleep(300);
    const subsBefore = fab.subscribes.length;
    engine = bootEngine();
    if (!(await up(`${BASE}/health`))) throw new Error(`engine 2 did not come up\n${engineLog}`);
    ok(await until(() => /adopted \d+ live session/.test(engineLog), 10000), 'the second engine adopted the broker\'s panes');
    ok(await until(() => fab.subscribes.slice(subsBefore).some((s) => s.slugs.includes('mailbox')), 10000), 'and re-subscribed mailbox');
    fab.push(envelope('mb-restart', 'mailbox', 'restart-sender', beforeRestart));
    const line = await until(() => engineLog.split(LF).find((l) => l.includes('from restart-sender')), 8000);
    ok(!!line && !line.includes('delivery='), 'delivered with NO delivery tag: adoption is not "went live"', line);
    r = await restore('mailbox');
    eq(r.body?.already, true, 'mailbox still reads already live after the restart');
  } finally {
    const kill = async (proc) => {
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        const g = new Promise((res) => proc.once('exit', res));
        proc.kill('SIGTERM');
        await Promise.race([g, sleep(3000)]);
      }
    };
    await kill(engine);
    await kill(broker);
    await fab.close().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
    if (failed) console.log(`\n---- log tail ----\n${log.slice(-6000)}`);
  }
}

run()
  .catch((e) => {
    failed++;
    console.log(`X suite error: ${e.stack ?? e}`);
  })
  .finally(() => {
    console.log(`\nPASS ${passed} FAIL ${failed}`);
    process.exit(failed ? 1 : 0);
  });
