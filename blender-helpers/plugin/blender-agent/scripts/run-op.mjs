#!/usr/bin/env node
/*
 * Run a Model Studio operation (a recipe template) on a Library mesh from the CLI —
 * the same instantiation, Notes and contract publishing as the job server, without it.
 *
 *   node scripts/run-op.mjs <operation-id> <library-mesh-id> [--label TEXT] [--params params.json]
 *
 * Prints run-recipe's lines, then one JSON line {jobId, ok, library?, share?, error?}.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, WORK_DIR, readJson, writeJson } from './lib/common.mjs';
import { checkParams, download, instantiate, publishJob, template } from './lib/ops.mjs';

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [opId, meshId] = args.filter((a, i) => !a.startsWith('--') && !['--label', '--params'].includes(args[i - 1]));
const done = (o, code) => {
  console.log(JSON.stringify(o));
  process.exit(code);
};

try {
  const t = template(opId || '');
  if (!t) done({ ok: false, error: `no operation ${opId}` }, 2);
  if (!/^[0-9a-f-]{8,64}$/.test(meshId || '')) done({ ok: false, error: 'second argument must be a Library mesh id' }, 2);
  const params = checkParams(t, opt('--params') ? readJson(path.resolve(opt('--params')), {}) : {});
  const inp = await download(meshId);
  const id = `${t.id}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const name = String(inp.label || t.id).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'model';
  fs.mkdirSync(path.join(WORK_DIR, id), { recursive: true });
  const recipeFile = path.join(WORK_DIR, id, 'recipe.json');
  writeJson(recipeFile, instantiate(t, meshId, inp.path, name, params));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-recipe.mjs'), id, recipeFile], { stdio: 'inherit' });
  if (r.status !== 0) done({ jobId: id, ok: false, error: 'recipe failed (see the step lines above)' }, 1);
  const job = { id, inputs: { mesh: meshId }, params, label: opt('--label'), origin: null };
  const pub = await publishJob(job, t);
  if (pub.ok === false || !pub.library) done({ jobId: id, ok: false, error: pub.error || 'publish failed' }, 1);
  done({ jobId: id, ok: true, library: pub.library, share: pub.share }, 0);
} catch (e) {
  done({ ok: false, error: e.message }, 1);
}
