#!/usr/bin/env node
/*
 * watch.mjs <task.json> — capture one saved checkpoint for the live panel. Started detached by verb.mjs; never throws.
 *
 * Renders the watch frames and the light preview model (scripts/steps/watch_capture.py, a separate headless Blender run on the
 * checkpoint), then updates the manifest. Everything goes to the room share:
 *   rooms/<room>/model-studio-live/index.json                        {"jobs":[{job, updated, steps}]}  newest first
 *   rooms/<room>/model-studio-live/<job>/manifest.json               {job, updated, latest, cameras, steps, model}
 *   rooms/<room>/model-studio-live/<job>/frames/<camera>/<n>.jpg     and  model/latest.glb
 * Camera poses are in the exported model's own space: glTF is Y-up, the Blender scene is Z-up, so [x, y, z] becomes [x, z, -y]
 * (position and target, metres); fov is the vertical field of view in degrees; frames are square. The same cameras are camera
 * nodes in model/latest.glb, named by camera id.
 * Manifests are written to a temporary file and renamed, so a reader never sees a half-written one.
 * Captures of one job run one at a time (a lock file); a failure is logged to work/<job>/watch/log.jsonl and nothing else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, WORK_DIR, config, readJson } from './lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

function lock(dir) {
  const f = path.join(dir, '.lock');
  for (let i = 0; i < 1200; i++) { // up to 20 minutes
    try {
      fs.writeFileSync(f, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(f, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(f).mtimeMs > 15 * 60 * 1000) fs.rmSync(f, { force: true }); } catch { /* gone */ }
      sleep(1000);
    }
  }
  throw new Error('could not get the capture lock');
}

const g = (p) => [p[0], p[2], -p[1]].map((x) => Math.round(x * 10000) / 10000); // Blender (Z up) -> glTF (Y up)
const manifestCameras = (cams) => [...cams.map((c) => ({ id: c.id, label: c.label || c.id, position: g(c.position), target: g(c.target), fov: c.fov })),
  { id: 'agent', label: "Agent's view" }, { id: 'agent-wide', label: "Agent's view, zoomed out" }];
const MODES = [
  { id: 'plain', label: 'Plain', short: 'Plain' },
  { id: 'color', label: 'Colour on grey reference', short: 'A' },
  { id: 'wire', label: 'Wireframe on see-through reference', short: 'B' },
  { id: 'refwire', label: 'Grey on reference wireframe', short: 'C' },
];
// a frame given as a plain string (one per camera) is the plain view
const modeFrames = (frames) => Object.fromEntries(Object.entries(frames || {}).map(([k, v]) => [k, typeof v === 'string' ? { plain: v } : v]));

const taskFile = process.argv[2];
let task = null;
const t0 = Date.now();
try {
  task = readJson(path.resolve(taskFile));
  const cfg = config();
  const wdir = path.join(WORK_DIR, task.job, 'watch');
  fs.mkdirSync(wdir, { recursive: true });
  const liveRoot = path.join(cfg.shareRoot || path.join(ROOT, 'share'), path.dirname(cfg.shareDir), 'model-studio-live');
  const jobLive = path.join(liveRoot, task.job);
  fs.mkdirSync(jobLive, { recursive: true });
  if (task.mode === 'agent') { // the step this picture belongs to must be in the manifest first (its own capture may still be running)
    for (let i = 0; i < 60; i++) { const mm = readJson(path.join(jobLive, 'manifest.json'), null); if (mm?.steps?.some((x) => x.n === task.n)) break; sleep(1000); }
  }
  const release = lock(wdir);
  try {
    const argsFile = path.join(wdir, `${task.n}-capture.args.json`);
    const report = path.join(wdir, `${task.n}-capture.report.json`);
    fs.rmSync(report, { force: true });
    fs.writeFileSync(argsFile, JSON.stringify({
      job: task.job, n: task.n, step: 'watch_capture', tool_root: ROOT, job_dir: path.join(WORK_DIR, task.job),
      out_dir: wdir, input: task.blend, output: null, report,
      params: { live_dir: jobLive, cache_dir: path.join(wdir, 'cache'), n: task.n, cameras: task.cameras, glb_cameras: task.all_cameras, engine: task.engine, samples: task.samples,
        tex: task.tex, res: task.res, model: task.model, agent: task.agent, agent_wide: task.agent_wide, looks: task.looks, reference: task.reference, agent_only: task.mode === 'agent', modes: task.modes, wire_alpha: task.wire_alpha },
    }));
    const refreshOnly = false;
    const blender = path.resolve(ROOT, cfg.blender);
    const log = fs.openSync(path.join(wdir, `${task.n}-capture.log`), 'w');
    const r = refreshOnly ? { status: 0 } : spawnSync(blender, ['--factory-startup', '-b', ...(task.mode === 'agent' ? [] : [task.blend]), '--python-exit-code', '1', '--python', path.join(HERE, 'steps', 'watch_capture.py'), '--', argsFile],
      { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true, timeout: 5 * 60 * 1000 });
    fs.closeSync(log);
    const rep = refreshOnly ? { summary: { frames: {}, timing_s: {}, errors: [] } } : readJson(report, null);
    if (r.status !== 0 || !rep || rep.ok === false) throw new Error(`capture failed: ${rep?.error || `blender exit ${r.status}`}`);
    const s = rep.summary;
    // manifest
    const mf = path.join(jobLive, 'manifest.json');
    const m = readJson(mf, { job: task.job, updated: null, latest: 0, cameras: [], steps: [], model: null });
    m.cameras = manifestCameras(task.all_cameras || task.cameras);
    for (const dc of s.derived_cameras || []) { const mc = m.cameras.find((x) => x.id === dc.id); if (mc) Object.assign(mc, { position: g(dc.position), target: g(dc.target), fov: dc.fov }); }
    m.modes = MODES.map((x) => (x.id === 'wire' ? { ...x, alpha: task.wire_alpha ?? 0.5 } : x));
    for (const st of m.steps) st.frames = modeFrames(st.frames);
    const old = m.steps.find((x) => x.n === task.n);
    if (task.mode === 'agent' && !old) {
      // the step it belongs to is not in the manifest (yet): nothing to join
    } else if ((task.mode === 'camera' || task.mode === 'agent') && old) {
      if (s.looks?.length) old.looks = [...(old.looks || []), ...s.looks.map((l) => ({ ...l, at: task.at }))];
      old.frames = { ...old.frames, ...modeFrames(s.frames) }; // a new camera's frame, or the operator's own view, joins the step it belongs to
    } else {
      m.steps = m.steps.filter((x) => x.n !== task.n);
      m.steps.push({ n: task.n, verb: task.verb, at: task.at, note: task.note, ...(task.focus ? { focus: task.focus } : {}), ...(task.focus_nodes?.length > 1 ? { focus_nodes: task.focus_nodes } : {}), ...(s.opening ? { opening: true } : {}), frames: modeFrames(s.frames) });
    }
    m.steps.sort((a, b) => a.n - b.n);
    if (!m.steps.length) throw new Error('no step to attach to');
    m.latest = m.steps[m.steps.length - 1].n;
    if (s.reference) m.reference = { file: 'model/reference.glb', solid: 'ref', grid: 'ref-grid' };
    if ((s.model_bytes || (task.mode === 'camera' && m.model)) && (!m.model || task.n >= m.model.step)) m.model = { file: 'model/latest.glb', step: task.n };
    m.updated = new Date().toISOString();
    atomicWrite(mf, m); // last, and atomic
    const ix = path.join(liveRoot, 'index.json');
    const idx = readJson(ix, { jobs: [] });
    idx.jobs = idx.jobs.filter((j) => j.job !== task.job);
    idx.jobs.push({ job: task.job, updated: m.updated, steps: m.steps.length });
    idx.jobs.sort((a, b) => (a.updated < b.updated ? 1 : -1));
    atomicWrite(ix, idx);
    fs.appendFileSync(path.join(wdir, 'log.jsonl'), JSON.stringify({ n: task.n, ok: true, wall_s: (Date.now() - t0) / 1000, timing_s: s.timing_s, engine: s.engine, frames: Object.values(s.frames).reduce((a, f) => a + Object.keys(f).length, 0), wire_prep_s: s.wire_prep_s, model_bytes: s.model_bytes || 0, pose_check: s.pose_check, errors: s.errors, textures: s.textures }) + '\n');
  } finally {
    release();
  }
} catch (e) {
  try {
    const wdir = path.join(WORK_DIR, task?.job || '_unknown', 'watch');
    fs.mkdirSync(wdir, { recursive: true });
    fs.appendFileSync(path.join(wdir, 'log.jsonl'), JSON.stringify({ n: task?.n, ok: false, wall_s: (Date.now() - t0) / 1000, error: String(e.message || e) }) + '\n');
  } catch { /* nothing more to do */ }
}
process.exit(0);