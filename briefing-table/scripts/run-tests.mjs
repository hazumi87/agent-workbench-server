/**
 * `npm test`: find every test/*.test.mjs and test/*.test.ts, run them one at a
 * time, and refuse to call a run green unless every suite SAID so.
 * room interface T0 [ticket].
 *
 *   node scripts/run-tests.mjs                     every suite
 *   node scripts/run-tests.mjs --offset 100        every suite, ports P(n)+100
 *   node scripts/run-tests.mjs agent-fs window-agent   just those
 *
 * A suite name matches `<name>.test.mjs` / `<name>.test.ts`, or the full file
 * name. A name that matches nothing is an error, never an empty green run.
 *
 * WHY IT FAILS ON A MISSING SUMMARY. On 2026-09-20 a suite launched from a
 * CLI-Manager pane bound its scratch broker to the inherited tailnet address,
 * bailed, and exited 0 having run nothing, so the old `a && b && c` chain went
 * green. Exit code alone is not evidence. A suite passes only when it exits 0
 * AND prints `PASS n FAIL 0` with n > 0. (broker-available.test.ts prints
 * `n passed, m failed` instead; that form is accepted too.)
 *
 * WIN32_ONLY suites spawn powershell.exe and cannot pass anywhere else. Off
 * win32 they are printed as SKIPPED, one line each, and counted in the table:
 * never silently dropped, never counted as a pass.
 *
 * Every suite runs with childEnv() (test/_scratch.mjs): no PTY_BROKER_* or
 * HARBOR_WB_* reaches it, whatever pane this was launched from.
 */
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../test/_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(REPO_ROOT, 'test');
/* The tsx CLI is what `npx tsx` resolves to (node_modules/.bin/tsx). Running
 * it with this node directly avoids spawning a .cmd shim on win32, which needs
 * shell:true. */
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WIN32_ONLY = ['engine.test.mjs', 'fabric-inbound.test.mjs', 'fabric-subscriber.test.mjs'];
/* LINUX_ONLY: suites that read a real or fake /proc and skip themselves elsewhere (a
   zero-assertion suite would otherwise count as failed). Same rule as WIN32_ONLY. */
const LINUX_ONLY = ['assemble-reconnect.test.ts', 'voice-sandbox.test.mjs', 'fabric-restore.test.mjs', 'room-apps.test.mjs', 'room-apps-settings.test.mjs', 'room-panel-actions.test.mjs', 'room-panel-posts.test.mjs', 'seat-reload.test.mjs', 'workers-engine.test.mjs', 'hosted-instance.test.mjs', 'switch-acceptance.test.ts']; // voice-sandbox: its stub `claude` is a shebang script [Owner [ref]]; switch-acceptance: a scratch Basic instance with a compiled fake claude and a POSIX hook runner (job 3); hosted-instance: the hosted instance is a Linux/systemd deploy; its path-separator and mode-600 checks are correct there and false on Windows; room-apps, room-panel-actions, room-panel-posts: verifyEndpoint refuses off Linux by design [rooms/apps-sec]; workers-engine: workers run bash + timeout in a Linux broker [ticket]; fabric-restore: its stub `claude` is POSIX sh and kills its parent shell [ticket]; seat-reload: its stub `claude` is POSIX too [ticket]
/* A hung suite must not hang the run. Generous: the slowest suite (engine
 * on the VRPC) takes a few minutes. */
const SUITE_TIMEOUT_MS = 15 * 60 * 1000;

function usage(msg) {
  console.error(`run-tests: ${msg}`);
  console.error('usage: node scripts/run-tests.mjs [--offset N] [suite ...]');
  process.exit(2);
}

// ---- args ----
let offset = null;
const wanted = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--offset' || a.startsWith('--offset=')) {
    const v = a === '--offset' ? argv[++i] : a.slice('--offset='.length);
    if (v === undefined || !/^[0-9]+$/.test(v)) {
      usage(`--offset needs a non-negative integer (got ${JSON.stringify(v)})`);
    }
    offset = Number(v);
  } else if (a.startsWith('-')) {
    usage(`unknown option ${a}`);
  } else {
    wanted.push(a);
  }
}

// ---- discover ----
const all = readdirSync(TEST_DIR)
  .filter((f) => /^[^.].*\.test\.(mjs|ts)$/.test(f))
  .sort();
let suites = all;
if (wanted.length) {
  const unknown = wanted.filter((w) => !all.some((f) => f === w || f === `${w}.test.mjs` || f === `${w}.test.ts`));
  if (unknown.length) {
    usage(`no suite matches: ${unknown.join(', ')}`);
  }
  suites = all.filter((f) => wanted.some((w) => f === w || f === `${w}.test.mjs` || f === `${w}.test.ts`));
}

const env = childEnv(offset === null ? {} : { WB_TEST_PORT_OFFSET: String(offset) });
const effectiveOffset = env.WB_TEST_PORT_OFFSET || '0';

/** Last summary line the suite printed, or null. */
function parseSummary(out) {
  let hit = null;
  for (const m of out.matchAll(/^\s*PASS\s+(\d+)\s+FAIL\s+(\d+)\s*$/gm)) {
    hit = { pass: Number(m[1]), fail: Number(m[2]) };
  }
  if (!hit) {
    for (const m of out.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed\s*$/gm)) {
      hit = { pass: Number(m[1]), fail: Number(m[2]) };
    }
  }
  return hit;
}

function runSuite(file) {
  const args = file.endsWith('.ts') ? [TSX_CLI, join('test', file)] : [join('test', file)];
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, SUITE_TIMEOUT_MS);
    proc.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    proc.stderr.on('data', (d) => {
      out += d;
      process.stderr.write(d);
    });
    proc.on('error', (err) => {
      out += `\nspawn error: ${err.message}\n`;
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, out, ms: Date.now() - started });
    });
  });
}

// ---- run ----
console.log(`run-tests: ${suites.length} suite(s), port offset ${effectiveOffset}, platform ${process.platform}`);
const rows = [];
for (const file of suites) {
  if (LINUX_ONLY.includes(file) && process.platform !== 'linux') {
    console.log(`\n=== ${file}: SKIPPED (linux-only) — reads /proc; verify on the server`);
    rows.push({ file, verdict: 'SKIPPED (linux-only)', pass: null, fail: null, ms: 0, ok: true });
    continue;
  }
  if (WIN32_ONLY.includes(file) && process.platform !== 'win32') {
    console.log(`\n=== ${file}: SKIPPED (win32-only) — spawns powershell.exe; verify on the VRPC`);
    rows.push({ file, verdict: 'SKIPPED (win32-only)', pass: null, fail: null, ms: 0, ok: true });
    continue;
  }
  console.log(`\n=== ${file}`);
  const r = await runSuite(file);
  const s = parseSummary(r.out);
  let verdict;
  if (r.timedOut) {
    verdict = `TIMEOUT after ${SUITE_TIMEOUT_MS / 1000}s (killed; its children may still hold ports)`;
  } else if (!s) {
    verdict = `NO SUMMARY (exit ${r.code ?? r.signal}) — the suite never said PASS n FAIL m`;
  } else if (s.fail > 0) {
    verdict = `FAIL ${s.fail}`;
  } else if (r.code !== 0) {
    verdict = `EXIT ${r.code ?? r.signal}`;
  } else if (s.pass === 0) {
    verdict = 'PASS 0 — no assertions ran';
  } else {
    verdict = 'ok';
  }
  rows.push({ file, verdict, pass: s?.pass ?? null, fail: s?.fail ?? null, ms: r.ms, ok: verdict === 'ok' });
}

// ---- table ----
const w = Math.max(...rows.map((r) => r.file.length), 5);
const num = (n) => (n === null ? '-' : String(n)).padStart(5);
console.log(`\n${'suite'.padEnd(w)}  ${'pass'.padStart(5)}  ${'fail'.padStart(5)}  ${'secs'.padStart(5)}  verdict`);
console.log(`${'-'.repeat(w)}  -----  -----  -----  -------`);
for (const r of rows) {
  console.log(`${r.file.padEnd(w)}  ${num(r.pass)}  ${num(r.fail)}  ${(r.ms / 1000).toFixed(1).padStart(5)}  ${r.verdict}`);
}
const ran = rows.filter((r) => !r.verdict.startsWith('SKIPPED'));
const skipped = rows.length - ran.length;
const bad = rows.filter((r) => !r.ok);
const totalPass = ran.reduce((a, r) => a + (r.pass ?? 0), 0);
const totalFail = ran.reduce((a, r) => a + (r.fail ?? 0), 0);
console.log(
  `\nTOTAL  suites ${rows.length} (ran ${ran.length}, skipped ${skipped}, failed ${bad.length})  ` +
    `PASS ${totalPass}  FAIL ${totalFail}  offset ${effectiveOffset}`,
);
if (bad.length) {
  console.log(`FAILED: ${bad.map((r) => `${r.file} [${r.verdict}]`).join(', ')}`);
}
process.exit(bad.length ? 1 : 0);
