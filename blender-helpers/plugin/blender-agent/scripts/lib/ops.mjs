/*
 * Model Studio operations shared by the job server (scripts/job-server.mjs) and the
 * CLI (scripts/run-op.mjs): recipe templates, param checks, instantiation, input
 * download, Notes, and publishing with the contract's derived_op (Model Studio backend contract, see the package docs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, WORK_DIR, config, readJson, writeJson } from './common.mjs';

export const VERSION = '2026.09.29';
const cfg = config();
const RECIPES = path.join(ROOT, 'recipes');
const DL = path.join(ROOT, 'downloads', 'library');
export const err = (status, message) => Object.assign(new Error(message), { status });

export function templates() {
  return fs.readdirSync(RECIPES).filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(RECIPES, f))).filter((r) => r && r.template);
}

export const template = (id) => templates().find((t) => t.id === id);

/* recipe params (with "bind") -> JSON Schema profile v1 (one level of scalars / enums) */
export function schemaOf(t) {
  const properties = {};
  for (const [k, { bind, ...s }] of Object.entries(t.params || {})) properties[k] = s;
  return { type: 'object', properties, additionalProperties: false };
}

export function checkParams(t, given) {
  const out = {};
  for (const [k, v] of Object.entries(given || {})) {
    const s = (t.params || {})[k];
    if (!s) throw err(400, `unknown param ${k}`);
    const ok = (s.type === 'integer' && Number.isInteger(v)) || (s.type === 'number' && typeof v === 'number')
      || (s.type === 'boolean' && typeof v === 'boolean') || (s.type === 'string' && typeof v === 'string');
    if (!ok) throw err(400, `param ${k} must be ${s.type}`);
    if (s.enum && !s.enum.includes(v)) throw err(400, `param ${k} must be one of ${s.enum.join(', ')}`);
    if (s.minimum !== undefined && v < s.minimum) throw err(400, `param ${k} must be >= ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) throw err(400, `param ${k} must be <= ${s.maximum}`);
    out[k] = v;
  }
  return out;
}

/* A template filled in: {input}, {input_path}, {name}; declared params bound onto their steps. */
export function instantiate(t, input, inputPath, name, params) {
  const fill = (v) => (typeof v === 'string' ? v.replace('{input_path}', inputPath).replace('{input}', input).replace('{name}', name)
    : Array.isArray(v) ? v.map(fill)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
  const steps = t.steps.map((s) => ({ step: s.step, params: fill(s.params || {}) }));
  for (const [k, v] of Object.entries(params)) {
    for (const [step, key] of t.params[k].bind || []) steps.filter((s) => s.step === step).forEach((s) => { s.params[key] = v; });
  }
  return { about: t.about, from_template: t.id, input_library_id: input, params, steps };
}

export async function download(id) {
  const res = await fetch(`${cfg.libraryUrl}/api/assets/${id}`);
  if (!res.ok) throw err(400, `library asset ${id}: HTTP ${res.status}`);
  const rec = await res.json();
  const ext = path.extname(rec.filename || '.glb').toLowerCase() || '.glb';
  const dst = path.join(DL, `${id}${ext}`);
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(DL, { recursive: true });
    const f = await fetch(`${cfg.libraryUrl}/api/assets/${id}/file`);
    if (!f.ok) throw err(502, `download ${id}: HTTP ${f.status}`);
    fs.writeFileSync(dst, Buffer.from(await f.arrayBuffer()));
  }
  return { path: path.relative(ROOT, dst).split(path.sep).join('/'), label: rec.label };
}

/* An input is a path (tool-root-relative or absolute), a Library id (an id-shaped string), or {library_id} / {path}.
   Returns { path, form, label? }: a Library file of any category is downloaded once into downloads/library/<id><ext>.
   The Python side (scripts/steps/_lib.py resolve) takes the same forms. */
const ID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export async function resolveInput(x) {
  if (x && typeof x === 'object') {
    if (x.library_id) return { ...(await download(String(x.library_id))), form: 'library_id' };
    if (x.path) return { path: String(x.path), form: 'path' };
    throw err(400, `give {"library_id": id} or {"path": p}, not ${JSON.stringify(x).slice(0, 80)}`);
  }
  if (typeof x === 'string' && ID_RE.test(x)) return { ...(await download(x)), form: 'library_id' };
  return { path: String(x), form: 'path' };
}

/* Notes for the Library record, from the job's own step reports: what ran, with what,
   how well each view registered, the validation verdict, the three.js file size. */
export function writeNotes(job, t) {
  const dir = path.join(WORK_DIR, job.id);
  const st = readJson(path.join(dir, 'job.json'), { steps: [] });
  const rep = (step) => {
    const s = [...st.steps].reverse().find((x) => x.step === step && x.ok);
    return s ? readJson(path.join(dir, s.report), {}).summary || {} : null;
  };
  const lines = [`${job.label ? `${job.label} — ` : ''}Model Studio · Blender · ${t.title} (op ${t.op}, id ${t.id}) on Library ${job.inputs.mesh}.`,
    `Params: ${JSON.stringify(job.params)}. Steps: ${st.steps.filter((x) => x.ok).map((x) => x.step).join(' > ')}.`];
  const pb = rep('project_bake');
  if (pb?.views) {
    lines.push('Texture registration per view (body-core IoU / full / arms):');
    for (const [v, r] of Object.entries(pb.views)) {
      lines.push(`- ${v}: ${r.core} / ${r.full}${r.arm_pos !== undefined ? ` / ${r.arm_pos}, ${r.arm_neg}` : ''}${r.used ? '' : ' (DROPPED)'}${r.arm_masked_pct ? ` · arms masked ${r.arm_masked_pct}%` : ''}`);
    }
    lines.push(`Seen by a view: ${pb.seen_pct}% of texels (rest filled from neighbours). Maps: ${(pb.maps || []).join(', ') || 'colour only'}.`);
  }
  const va = rep('validate');
  if (va) lines.push(`Validation: ${JSON.stringify(va)}.`);
  const mo = rep('meshopt');
  if (mo) for (const [f, r] of Object.entries(mo)) lines.push(`three.js file ${f}: ${(r.bytes / 1e6).toFixed(2)} MB, ${r.bones} bones, clips ${(r.animations || []).map((a) => a.name).join(', ')}.`);
  fs.writeFileSync(path.join(dir, 'notes.md'), lines.join('\n'));
}

export function publishJob(job, t) {
  writeNotes(job, t);
  const extra = {
    derived_op: { op: t.op, provider: 'blender', id: t.id, version: VERSION, params: job.params, inputs: job.inputs },
    ...(job.origin && { origin: job.origin }),
    ...(job.label && { label: job.label }),
  };
  const f = path.join(WORK_DIR, job.id, 'publish-extra.json');
  writeJson(f, extra);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'publish.mjs'), 'job', job.id, job.inputs.mesh, f],
      { cwd: ROOT, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', () => {
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        resolve({ ok: false, error: `publish: ${out.slice(-200)}` });
      }
    });
  });
}

