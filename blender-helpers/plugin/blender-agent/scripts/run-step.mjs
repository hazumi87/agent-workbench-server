#!/usr/bin/env node
/*
 * Run ONE Blender step headless, with the job's latest .blend as its input.
 *
 *   node scripts/run-step.mjs <job> <step> [params.json] [--from N] [--timeout S]
 *
 * - <job>: work/<job>/ holds the state. Each step writes NN-<step>.blend (if it
 *   saves), NN-<step>.args.json, NN-<step>.report.json, NN-<step>.log, and is
 *   appended to work/<job>/job.json. That list IS the recipe (replayable).
 * - params: a JSON FILE, never inline JSON (Windows quoting mangles it).
 * - --from N: take step N's .blend as input instead of the latest (branching).
 * - Hard timeout (params.timeout_s, --timeout, or config stepTimeoutS); on expiry
 *   the process TREE we started is killed by pid.
 * Prints one JSON line: {job, n, step, ok, exit, secs, output, summary, error}.
 * Exit 0 ok / 1 step failed / 2 could not run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  JOB_RE, STEP_RE, STEPS_DIR, WORK_DIR, ROOT,
  acquireLock, config, killTree, readJson, writeJson, writeWidget,
} from './lib/common.mjs';

function parseArgv(argv) {
  const out = { pos: [], from: null, timeout: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = Number(argv[++i]);
    else if (argv[i] === '--timeout') out.timeout = Number(argv[++i]);
    else out.pos.push(argv[i]);
  }
  return out;
}

function fail(code, error, extra = {}) {
  console.log(JSON.stringify({ ok: false, error, ...extra }));
  process.exit(code);
}

const argv = parseArgv(process.argv.slice(2));
const [job, step, paramsFile] = argv.pos;
if (!JOB_RE.test(job || '') || !STEP_RE.test(step || '')) fail(2, 'usage: run-step.mjs <job> <step> [params.json] [--from N] [--timeout S]');
const script = path.join(STEPS_DIR, `${step}.py`);
if (!fs.existsSync(script)) fail(2, `no such step: ${step}`);

let params = {};
if (paramsFile) {
  params = readJson(path.resolve(paramsFile));
  if (!params || typeof params !== 'object') fail(2, `params file is not a JSON object: ${paramsFile}`);
}

const cfg = config();
if (!fs.existsSync(cfg.blender)) fail(2, `blender not found: ${cfg.blender}`);

const jobDir = path.join(WORK_DIR, job);
const outDir = path.join(jobDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
const jobFile = path.join(jobDir, 'job.json');
const state = readJson(jobFile, { job, created: new Date().toISOString(), steps: [] });

// Input: step --from N's .blend, else the latest step that saved one.
let input = null;
if (argv.from !== null) {
  const src = state.steps.find((s) => s.n === argv.from);
  if (!src || !src.ok || !src.output) fail(2, `--from ${argv.from}: no successful step with a .blend`);
  input = src.output;
} else {
  input = [...state.steps].reverse().find((s) => s.ok && s.output)?.output ?? null;
}

const n = state.steps.length + 1;
const stem = `${String(n).padStart(2, '0')}-${step}`;
const files = {
  args: path.join(jobDir, `${stem}.args.json`),
  report: path.join(jobDir, `${stem}.report.json`),
  log: path.join(jobDir, `${stem}.log`),
  output: path.join(jobDir, `${stem}.blend`),
};
const timeoutS = Number(params.timeout_s || argv.timeout || cfg.stepTimeoutS || 900);

let release;
try {
  release = acquireLock(`${job}/${stem}`);
} catch (e) {
  fail(2, e.message);
}

writeJson(files.args, {
  job, n, step, tool_root: ROOT, library_url: cfg.libraryUrl, job_dir: jobDir, out_dir: outDir,
  input: input && path.join(jobDir, input), output: files.output, report: files.report, params,
});
fs.rmSync(files.report, { force: true });
writeWidget('ok', `running ${step} · ${job}`);

const blenderArgs = ['--factory-startup', '-b'];
if (input) blenderArgs.push(path.join(jobDir, input));
blenderArgs.push('--python-exit-code', '1', '--python', script, '--', files.args);

const started = Date.now();
const log = fs.openSync(files.log, 'w');
const child = spawn(cfg.blender, blenderArgs, {
  cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true, detached: process.platform !== 'win32',
});
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  killTree(child.pid);
}, timeoutS * 1000);

const exit = await new Promise((resolve) => {
  child.on('error', (e) => resolve({ code: null, error: e.message }));
  child.on('exit', (code) => resolve({ code }));
});
clearTimeout(timer);
fs.closeSync(log);

const report = readJson(files.report, null);
const saved = report?.saved === true && fs.existsSync(files.output);
const ok = !timedOut && exit.code === 0 && report !== null && report.ok !== false;
const error = timedOut ? `timed out after ${timeoutS}s (process tree killed)`
  : exit.error ? exit.error
  : exit.code !== 0 ? (report?.error ? `${report.error}` : `blender exited ${exit.code} (see ${path.basename(files.log)})`)
  : report === null ? 'step wrote no report'
  : report.ok === false ? report.error || 'step reported failure' : null;

const entry = {
  n, step, ok, exit: exit.code, secs: Math.round((Date.now() - started) / 100) / 10,
  params, input, output: ok && saved ? path.basename(files.output) : null,
  report: path.basename(files.report), at: new Date().toISOString(), ...(error && { error }),
};
state.steps.push(entry);
writeJson(jobFile, state);
release();
writeWidget(ok ? 'ok' : 'warn', ok ? `idle · last: ${step} ok (${job})` : `idle · last: ${step} FAILED (${job})`);

console.log(JSON.stringify({ job, n, step, ok, exit: exit.code, secs: entry.secs, output: entry.output, summary: report?.summary ?? null, error }));
process.exit(ok ? 0 : 1);
