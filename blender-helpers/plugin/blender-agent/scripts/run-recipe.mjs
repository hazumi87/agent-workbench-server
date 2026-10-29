#!/usr/bin/env node
/*
 * Run a recipe: a JSON list of steps, each through run-step.mjs, stopping at
 * the first failure. A job's job.json can be replayed as a recipe.
 *
 *   node scripts/run-recipe.mjs <job> <recipe.json> [--start K] [--from N]
 *
 * --start K resumes at the recipe's K-th step (1-based) on the job's latest .blend.
 * --from N  feeds that first step job step N's .blend instead (branch, e.g. to
 *           re-run the animation tail without re-rigging).
 * recipe.json: {"steps": [{"step": "import_mesh", "params": {...}}, ...]}
 * Prints one JSON line per step (run-step's), then {"job", "ok", "ran"}.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson } from './lib/common.mjs';

const [job, recipeFile, ...flags] = process.argv.slice(2);
const opt = (name) => (flags.includes(name) ? Number(flags[flags.indexOf(name) + 1]) : null);
const start = opt('--start') ?? 1;
const from = opt('--from');
const recipe = readJson(path.resolve(recipeFile || ''));
if (!job || !recipe || !Array.isArray(recipe.steps)) {
  console.log(JSON.stringify({ ok: false, error: 'usage: run-recipe.mjs <job> <recipe.json>' }));
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-agent-'));
let ran = 0;
let ok = true;
for (const { step, params = {} } of recipe.steps.slice(start - 1)) {
  const pf = path.join(tmp, `${ran}.json`);
  fs.writeFileSync(pf, JSON.stringify(params));
  const branch = ran === 0 && from !== null ? ['--from', String(from)] : [];
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-step.mjs'), job, step, pf, ...branch], { encoding: 'utf8' });
  process.stdout.write(r.stdout);
  ran++;
  if (r.status !== 0) {
    ok = false;
    break;
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ job, ok, ran, from: start, of: recipe.steps.length }));
process.exit(ok ? 0 : 1);
