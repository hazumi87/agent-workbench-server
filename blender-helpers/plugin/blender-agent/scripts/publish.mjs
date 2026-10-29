#!/usr/bin/env node
/*
 * Hand results over: the file share (people and agents see it there) and the
 * asset-platform Library (ids + lineage).
 *
 *   node scripts/publish.mjs input <file> <source> <label-file>
 *       register an INPUT (e.g. a stock mesh) in the Library; prints {id}
 *   node scripts/publish.mjs job <job> <parent-id>
 *       publish work/<job>/out: the GLB (parent = the input mesh id), then the
 *       FBX and preview sheet (parent = the GLB). derived_op carries the job's
 *       steps (the replayable recipe). work/<job>/notes.md, if present, becomes
 *       the GLB's Notes (ranking + what's left to polish). Prints {share, library}.
 *
 * Labels come from a FILE (room text is data, never a shell argument).
 * URLs and room identity come from config (libraryUrl, shareUrl, room).
 */
import fs from 'node:fs';
import path from 'node:path';
import { WORK_DIR, config, lineage, readJson } from './lib/common.mjs';

const cfg = config();
const [mode, ...rest] = process.argv.slice(2);

/* Flags a parent carries that every derivative must keep (e.g. a Hunyuan mesh is
   evaluation-only by licence, so everything built on it is too). */
async function inherited(parentId) {
  const res = await fetch(`${cfg.libraryUrl}/api/assets/${encodeURIComponent(parentId)}`);
  if (!res.ok) throw new Error(`parent ${parentId}: library ${res.status}`);
  const a = await res.json();
  const meta = typeof a.meta === 'string' ? JSON.parse(a.meta || '{}') : a.meta || {};
  return meta.evaluation_only ? { evaluation_only: true } : {};
}

function origin() {
  // the room that asked for the work: PUBLISH_ROOM (JSON {id, name}) set by the publish verb's `room` setting, else the tool's configured room
  let r = cfg.room;
  try { if (process.env.PUBLISH_ROOM) r = { ...r, ...JSON.parse(process.env.PUBLISH_ROOM) }; } catch { /* keep the configured room */ }
  return { kind: 'room', app: 'blender-studio', room_id: r?.id, room_name: r?.name, agent: cfg.agent };
}

/* The Library DB can be briefly write-locked ("database is locked"); a retry is safe. */
async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/database is locked/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

async function setNotes(id, notes) {
  return withRetry(async () => {
    const res = await fetch(`${cfg.libraryUrl}/api/assets/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meta: { notes: notes.slice(0, 4000) } }),
    });
    if (!res.ok) throw new Error(`notes ${res.status}: ${(await res.text()).slice(0, 200)}`);
  });
}

async function library(file, fields) {
  return withRetry(() => libraryOnce(file, fields));
}

async function libraryOnce(file, fields) {
  const form = new FormData();
  form.append('file', await fs.openAsBlob(file), path.basename(file));
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const res = await fetch(`${cfg.libraryUrl}/api/assets/upload`, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`library ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  return json.asset ?? json;
}

async function share(file, dir) {
  const form = new FormData();
  form.append('file', await fs.openAsBlob(file), path.basename(file));
  const res = await fetch(`${cfg.shareUrl}/api/upload?dir=${encodeURIComponent(dir)}&mkdir=1`, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`share ${res.status}: ${text.slice(0, 300)}`);
  const saved = JSON.parse(text).saved?.[0];
  return saved ? `${cfg.shareUrl}/raw/${saved}` : null;
}

try {
  if (mode === 'input') {
    const [file, source, labelFile] = rest;
    const label = fs.readFileSync(labelFile, 'utf8').trim();
    const a = await library(path.resolve(file), { label, source, meta: { origin: origin() } });
    console.log(JSON.stringify({ id: a.id, category: a.category, filename: a.filename }));
  } else if (mode === 'job') {
    // optional 3rd arg: a JSON file with contract fields for derived_op
    // ({op, provider, id, version, params, inputs}) and meta.origin (Model Studio, (Model Studio backend contract, see the package docs)
    const [job, parentId, extraFile] = rest;
    const extra = extraFile ? readJson(extraFile, {}) : {};
    const jobDir = path.join(WORK_DIR, job);
    const state = readJson(path.join(jobDir, 'job.json'));
    if (!state) throw new Error(`no job ${job}`);
    const out = path.join(jobDir, 'out');
    const pick = (ext) => fs.readdirSync(out).filter((f) => f.endsWith(ext)).map((f) => path.join(out, f));
    const [glb] = pick('.glb').filter((f) => !f.endsWith('.meshopt.glb'));
    if (!glb) throw new Error('no .glb in out/');
    const steps = lineage(state.steps).map(({ n, step, params }) => ({ n, step, params }));
    const derived = { tool: 'blender-studio', engine: 'blender-4.5.4', job, steps, inputs: { mesh: parentId }, ...(extra.derived_op || {}) };
    const meta = { origin: { ...origin(), ...(extra.origin || {}) }, ...(await inherited(parentId)) };
    const dir = `${cfg.shareDir}/${job}`;
    const shared = [];
    for (const f of [glb, ...pick('.meshopt.glb'), ...pick('.fbx'), ...pick('preview.png')]) shared.push(await share(f, dir));
    const base = extra.label ? `${extra.label} · ${job}` : job;
    const g = await library(glb, { label: `${base} (rigged + idle)`, source: 'blender-studio', parent_id: parentId,
      derived_op: derived, meta });
    const lib = { glb: g.id };
    for (const f of pick('.meshopt.glb')) lib.meshopt = (await library(f, { label: `${base} (three.js, meshopt)`, source: 'blender-studio', parent_id: g.id, derived_op: { ...derived, format: 'glb+EXT_meshopt_compression' }, meta })).id;
    for (const f of pick('.fbx')) lib.fbx = (await library(f, { label: `${base} FBX (Unity)`, source: 'blender-studio', parent_id: g.id, derived_op: { ...derived, format: 'fbx' }, meta })).id;
    for (const f of pick('preview.png')) lib.preview = (await library(f, { label: `${base} preview`, source: 'blender-studio', parent_id: g.id, derived_op: { tool: 'blender-studio', op: 'preview', job }, meta })).id;
    // quality notes for the user, next to the model: work/<job>/notes.md if the resident wrote one
    const notesFile = path.join(jobDir, 'notes.md');
    if (fs.existsSync(notesFile)) await setNotes(g.id, fs.readFileSync(notesFile, 'utf8').trim());
    console.log(JSON.stringify({ share: shared, library: lib, notes: fs.existsSync(notesFile),
      ...(meta.evaluation_only && { evaluation_only: true }) }));
  } else if (mode === 'source') {
    // register a job checkpoint (.blend) as the editable SOURCE of an already-published GLB, and note it on the GLB
    const [file, labelFile, glbId, job, n] = rest;
    const label = fs.readFileSync(labelFile, 'utf8').trim();
    const state = readJson(path.join(WORK_DIR, job, 'job.json'));
    const steps = state ? lineage(state.steps).map(({ n: nn, step, params }) => ({ n: nn, step, params })) : [];
    const meta = { origin: origin(), source_of: glbId, job, checkpoint: Number(n), ...(await inherited(glbId)) };
    const a = await library(path.resolve(file), { label, source: 'blender-studio', derived_op: { tool: 'blender-studio', engine: 'blender-4.5.4', job, steps, format: 'blend', role: 'editable source of ' + glbId }, meta });
    const g = await (await fetch(`${cfg.libraryUrl}/api/assets/${encodeURIComponent(glbId)}`)).json();
    const gm = typeof g.meta === 'string' ? JSON.parse(g.meta || '{}') : g.meta || {};
    const note = `Editable Blender source: Library asset ${a.id} (${path.basename(file)}, job ${job}, checkpoint ${n}).`;
    await setNotes(glbId, [gm.notes, note].filter(Boolean).join('\n'));
    console.log(JSON.stringify({ id: a.id, category: a.category, filename: a.filename, source_of: glbId }));
  } else if (mode === 'meshopt') {
    // add the three.js (meshopt) file of an already-published job as a child of its GLB
    const [job, glbId] = rest;
    const jobDir = path.join(WORK_DIR, job);
    const state = readJson(path.join(jobDir, 'job.json'));
    const out = path.join(jobDir, 'out');
    const file = fs.readdirSync(out).find((f) => f.endsWith('.meshopt.glb'));
    if (!state || !file) throw new Error(`no job ${job} or no .meshopt.glb in its out/`);
    const steps = lineage(state.steps).map(({ n, step, params }) => ({ n, step, params }));
    const meta = { origin: origin(), ...(await inherited(glbId)) };
    const a = await library(path.join(out, file), { label: `${job} (three.js, meshopt)`, source: 'blender-studio', parent_id: glbId,
      derived_op: { tool: 'blender-studio', engine: 'blender-4.5.4', job, steps, format: 'glb+EXT_meshopt_compression' }, meta });
    const shared = await share(path.join(out, file), `${cfg.shareDir}/${job}`);
    console.log(JSON.stringify({ meshopt: a.id, share: shared }));
  } else {
    throw new Error('usage: publish.mjs input <file> <source> <label-file> | source <file> <label-file> <glb-id> <job> <n> | job <job> <parent-id> | meshopt <job> <glb-id>');
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
}
