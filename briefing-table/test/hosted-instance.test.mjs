/**
 * HOSTED WORKBENCH, layer 1 [hosted] (Owner 2026-10-07, KB design-notes-id).
 *
 *   - scripts/hosted-workbench.ts on a temp home: --dry-run writes nothing; a run
 *     creates the data dir, env files (mode 600), the broker token, targets.json, the
 *     account (its one-time code on STDOUT only: not on stderr, not in any file), two
 *     recipes and two rooms with leads; a second run changes nothing and says so;
 *   - HARBOR_WB_DATA_DIR isolation: an engine booted from that instance's env writes
 *     NOTHING inside the repo (every file's mtime and size snapshotted before and
 *     after, node_modules and .git aside) and everything lands in the data dir;
 *     /health reports the edition.
 *
 * SAFETY: scratch engine P(421), dead broker P(422); childEnv(); temp dirs removed.
 * Never :8201 / :7430.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(421);
const DEAD_BROKER_PORT = P(422);

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}`);
  }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every file under the repo (node_modules and .git aside): path -> "mtime size". */
function snapshot() {
  const out = new Map();
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (d === REPO_ROOT && (n === 'node_modules' || n === '.git')) continue;
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(p, `${st.mtimeMs} ${st.size}`);
    }
  };
  walk(REPO_ROOT);
  return out;
}
function diff(a, b) {
  const changed = [];
  for (const [p, v] of b) if (a.get(p) !== v) changed.push(p);
  for (const p of a.keys()) if (!b.has(p)) changed.push(`${p} (gone)`);
  return changed;
}
/** Every file under a dir, as relative paths. */
function tree(d, base = d, out = []) {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) tree(p, base, out);
    else out.push(p.slice(base.length + 1));
  }
  return out.sort();
}
const script = (args) =>
  spawnSync(process.execPath, [TSX_CLI, join('scripts', 'hosted-workbench.ts'), ...args], {
    cwd: REPO_ROOT,
    env: childEnv({ HARBOR_WB_DATA_DIR: null, HARBOR_WB_TABLE: null, HARBOR_WB_IDENTITY_DB: null }),
    encoding: 'utf8',
  });

for (const p of [PORT, DEAD_BROKER_PORT]) await assertFree(p, 'hosted-instance.test.mjs');
const home = mkdtempSync(join(tmpdir(), 'wb-hosted-home-'));
mkdirSync(join(home, 'dev', 'code', 'hello-world'), { recursive: true });
const dataDir = join(home, '.workbench');
const before = snapshot();
let engine = null;
let engineLog = '';

try {
  console.log('\n[the script: usage]');
  eq(script(['zahkutya']).status, 2, 'no --home / ports: usage, exit 2');
  eq(script(['zahkutya', '--home', home, '--port', '9301', '--broker-port', '9301']).status, 2, 'the two ports must differ');

  console.log('\n[the script: --dry-run writes nothing]');
  const dry = script(['zahkutya', '--home', home, '--port', String(PORT), '--broker-port', String(DEAD_BROKER_PORT), '--dry-run']);
  eq(dry.status, 0, 'exit 0');
  ok(dry.stdout.includes('would create') && dry.stdout.includes('nothing was written'), 'every step printed as "would create"');
  ok(!existsSync(dataDir), 'no data dir was made');

  console.log('\n[the script: a run creates everything]');
  const run = script(['zahkutya', '--home', home, '--port', String(PORT), '--broker-port', String(DEAD_BROKER_PORT)]);
  eq(run.status, 0, `exit 0${run.status ? `: ${run.stderr.slice(0, 400)}` : ''}`);
  const code = /password {2}(\S+)/.exec(run.stdout)?.[1] ?? '';
  ok(code.length >= 8, 'the one-time code is on stdout');
  ok(!run.stderr.includes(code), '...and not on stderr');
  ok(!existsSync(join(home, '.claude.json')), 'H3: no folder is pre-trusted by default (no ~/.claude.json written)');
  const files = tree(dataDir);
  eq(files, ['data/identity.db', 'data/mapping.db', 'pty-broker.env', 'secrets/broker.token', 'targets.json', 'workbench.env'], 'the instance files');
  ok(files.every((f) => !readFileSync(join(dataDir, f)).includes(code)), 'the code is in no file (only its hash)');
  for (const f of ['workbench.env', 'pty-broker.env', 'secrets/broker.token']) {
    eq(statSync(join(dataDir, f)).mode & 0o777, 0o600, `${f} is mode 600`);
  }
  const env = readFileSync(join(dataDir, 'workbench.env'), 'utf8');
  for (const line of [`HARBOR_WB_DATA_DIR=${dataDir}`, `HARBOR_WB_PORT=${PORT}`, 'HARBOR_WB_IDENTITY=strict', 'HARBOR_WB_EDITION=basic', 'HARBOR_WB_DESKTOP=none', 'HARBOR_WB_FABRIC_URL=off', `HARBOR_WB_BROKER_PORT=${DEAD_BROKER_PORT}`, `HARBOR_WB_BROKER_TOKEN_FILE=${join(dataDir, 'secrets', 'broker.token')}`]) {
    ok(env.includes(`${line}\n`), `workbench.env: ${line}`);
  }
  const token = readFileSync(join(dataDir, 'secrets', 'broker.token'), 'utf8').trim();
  ok(readFileSync(join(dataDir, 'pty-broker.env'), 'utf8').includes(`PTY_BROKER_TOKEN=${token}\n`) && token.length === 64, 'the broker env carries the same token');
  {
    const want = `PATH=${join(home, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`;
    ok(['workbench.env', 'pty-broker.env'].every((f) => readFileSync(join(dataDir, f), 'utf8').split(String.fromCharCode(10)).includes(want)), "both env files put the user's ~/.local/bin (Claude Code) first on PATH");
  }
  const db = new Database(join(dataDir, 'data', 'mapping.db'), { readonly: true });
  const recipes = db.prepare(`SELECT id, projectDir, vendor FROM recipes ORDER BY id`).all();
  eq(recipes, [
    { id: 'hosted-builder', projectDir: join(home, 'dev', 'code', 'hello-world'), vendor: 'claude-code' },
    { id: 'hosted-platform', projectDir: join(home, 'dev'), vendor: 'claude-code' },
  ], 'two recipes: Builder in hello-world, Platform in ~/dev');
  const rooms = db.prepare(`SELECT r.name, s.handle FROM rooms r JOIN room_seats s ON s.id = r.lead_seat ORDER BY r.name`).all();
  eq(rooms, [{ name: 'Hello World', handle: 'builder' }, { name: 'My Platform', handle: 'platform' }], 'two rooms, each led by its seat');
  db.close();
  const idb = new Database(join(dataDir, 'data', 'identity.db'), { readonly: true });
  eq(idb.prepare(`SELECT username, must_change_password AS m FROM user_account`).all(), [{ username: 'zahkutya', m: 1 }], 'the account, which must change its password');
  idb.close();

  console.log('\n[the script: a second run changes nothing]');
  const mt = new Map(files.map((f) => [f, statSync(join(dataDir, f)).mtimeMs]));
  const again = script(['zahkutya', '--home', home, '--port', String(PORT), '--broker-port', String(DEAD_BROKER_PORT)]);
  eq(again.status, 0, 'exit 0');
  ok(again.stdout.includes('nothing to do'), 'says so');
  ok(!/password {2}/.test(again.stdout), 'no new code');
  ok(['workbench.env', 'pty-broker.env', 'secrets/broker.token', 'targets.json'].every((f) => statSync(join(dataDir, f)).mtimeMs === mt.get(f)), 'no file rewritten');

  console.log('\n[HARBOR_WB_DATA_DIR: an engine from this instance writes nothing in the repo]');
  const envVars = Object.fromEntries(
    env.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({ ...envVars, HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_TOKEN: null, HARBOR_WB_TABLE: null, HARBOR_WB_IDENTITY_DB: null, HARBOR_WB_CHANNELS_DIR: null, HARBOR_WB_CONFIG: null, HARBOR_WB_TARGETS: null }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  let health = null;
  for (let i = 0; i < 120 && !health; i++) {
    await sleep(250);
    health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  ok(health, 'the engine came up on the instance port');
  eq(health?.edition, 'basic', '/health reports the edition');
  eq(Object.keys(health?.brokers ?? {}), ['local'], 'only the local broker link');
  const gate = await fetch(`http://127.0.0.1:${PORT}/api/table`);
  ok(gate.status === 401 || gate.status === 302 || gate.status === 303, `strict identity: no credential, no table (got ${gate.status})`);
  await sleep(1500);
  engine.kill('SIGKILL');
  engine = null;
  await sleep(300);
  ok(existsSync(join(dataDir, 'secrets', 'engine.token')), 'the engine bearer was minted in the data dir');
  const after = snapshot();
  eq(diff(before, after), [], 'the repo tree is byte-for-byte untouched (mtime and size of every file)');
} catch (e) {
  failed++;
  console.log(`  X threw: ${e?.stack ?? e}`);
} finally {
  if (engine) engine.kill('SIGKILL');
  await sleep(200);
  rmSync(home, { recursive: true, force: true });
}
if (failed) console.log('\nengine log (tail):\n' + engineLog.split('\n').slice(-30).join('\n'));
console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
