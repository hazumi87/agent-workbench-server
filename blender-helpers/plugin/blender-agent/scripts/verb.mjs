#!/usr/bin/env node
/*
 * Run one verb with its settings inline — no upload, no quoting traps.
 *
 *   node scripts/verb.mjs <job> <verb> [--b64 <base64 of the settings JSON>] [--file <settings.json>] [--from N] [--timeout S]
 *
 * The settings travel as base64 (letters, digits, + / = only), so no shell quoting can break them.
 * On the server:  S=$(printf '%s' '{"body":"1eee…","region":"trunk"}' | base64 -w0)
 *              then  node scripts/verb.mjs my-job kit2_body --b64 $S
 * --file is an absolute path to a JSON file already on this machine.  No settings = {}.
 *
 * <verb> is any step in scripts/steps (run via run-step.mjs; same result line, plus `settings` echoed back), or one of:
 *   fetch  {ids:[library mesh ids]}                       put the meshes in downloads/library/ (the import_mesh input)
 *   post   {pictures:[{from (also lightmaps/<f>.bin|.u8|.exr|.json), as} | {frame:{camera,mode,step?}, as}], keep?:true}   copy pictures from work/<job>/out/ (or a frame of the watch, saved as PNG) to the room's top-level assets
 *                                                         under a fixed name (keep:true = refuse to overwrite an existing name)
 *   bake_progress {n?}                                    read-only view of a lightmap_bake step (running or done): requested bulbs, EXRs done, latest file, elapsed, seconds per bulb, whether bin/mask/manifest/checkpoint exist; no Blender, no lock
 *   publish {glb, label, dry_run?}                        publish work/<job>/out/<glb> to the Library with this label
 *                                                         (writes the label file itself; dry_run = check and show, publish nothing)
 *   journal {last?:40, verbs?:[..], failed_only?:true, from_n?:N, full?:true}   the job's own record, read-only: every step that ran (ok or failed) with its settings, seconds, time, the checkpoint it saved or branched from, and the error of a failed one
 *   watch  {enabled?, engine?, samples?, tex?, res?, model_every?}   the live-capture settings of this job (see scripts/watch.mjs)
 * After every verb that SAVES a checkpoint, a live capture (frames + light model for the Model Studio panel) is started in the
 * background unless the job has it switched off (`watch` {"enabled":false}) or BLENDER_AGENT_WATCH=0. It never delays or fails the
 * verb; the result only gains a short `watch` field.
 * Prints one JSON line. Exit 0 = ok, 1 = the verb failed, 2 = could not run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JOB_RE, STEP_RE, WORK_DIR, ROOT, config, readJson } from './lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = { b64: null, file: null, from: null, timeout: null };
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--b64' || a === '--file' || a === '--from' || a === '--timeout') flags[a.slice(2)] = args[++i];
  else pos.push(a);
}
const [job, verb] = pos;
const out = (o, code = 0) => { console.log(JSON.stringify(o)); process.exit(code); };
if (!JOB_RE.test(job || '') || !STEP_RE.test(verb || '')) {
  out({ ok: false, error: 'usage: verb.mjs <job> <verb> [--b64 <base64 json>] [--file settings.json] [--from N] [--timeout S]' }, 2);
}

let settings = {};
try {
  if (flags.b64 !== null) settings = JSON.parse(Buffer.from(flags.b64, 'base64').toString('utf8'));
  else if (flags.file) settings = readJson(path.resolve(flags.file));
} catch (e) {
  out({ ok: false, error: `settings are not valid JSON: ${e.message}` }, 2);
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) out({ ok: false, error: 'settings must be a JSON object' }, 2);


/* rig_clip takes a Library id (the Mixamo packs live in the Library) or a path: fetch an id here and pass the file path and the clip's name to the step */
if (verb === 'rig_clip' && settings.clip && (typeof settings.clip === 'object' || /^[0-9a-f-]{36}$/i.test(settings.clip))) {
  try {
    const { resolveInput } = await import('./lib/ops.mjs');
    const d = await resolveInput(settings.clip);
    settings = { ...settings, clip: d.path, name: settings.name || (d.label ? path.basename(String(d.label), path.extname(String(d.label))) : undefined) };
  } catch (e) {
    out({ ok: false, error: `could not fetch the clip ${JSON.stringify(settings.clip)}: ${e.message}` }, 2);
  }
}

/* ---- live capture hook (see scripts/watch.mjs) ---- */
const fmt = (x, d = 1) => (typeof x === 'number' ? x.toFixed(d) : String(x));
function noteFor(v, st, sm) {
  try {
    switch (v) {
      case 'import_mesh': return `imported the reference (${sm?.tris ?? '?'} triangles)`;
      case 'kit2_body': return `fitted the body to the reference (${st.region || 'all'}: scale ${fmt(sm?.scale, 3)}, error ${fmt(sm?.icp_median_error_mm)} mm)`;
      case 'kit2_part': {
        const sides = Object.values(sm?.sides || {});
        const k = sides[0]?.fit_scale?.[0];
        return `placed ${st.name}${st.pair ? ' (pair)' : ''} (${sm?.scale_mode === 'uniform' ? `uniform ×${fmt(k, 2)}, ` : ''}fit error ${sides.map((x) => fmt(x.fit_error_mm)).join('/')} mm)`;
      }
      case 'kit2_transform': {
        const bits = [];
        if (st.scale !== undefined) bits.push(Array.isArray(st.scale) ? `scaled ${st.scale.join('×')}` : `scaled ×${st.scale}`);
        if (st.rotate_deg) bits.push(`rotated ${st.rotate_deg.join('/')}°`);
        if (st.move_mm) bits.push(`moved ${st.move_mm.join('/')} mm`);
        return `${st.name}: ${bits.join(', ') || 'transformed'}`;
      }
      case 'kit2_bodyedit':
        return st.mode === 'remove' ? `removed ${sm?.faces_removed ?? '?'} buried body faces under ${st.part}`
          : `relieved the body under ${st.part} (visible ${fmt(sm?.show_through_before_pct)}% → ${fmt(sm?.show_through_after_pct)}%)`;
      case 'kit2_tweak': return `tweaked: ${(st.ops || []).map((o) => o.op + (o.name ? ` ${o.name}` : '')).join(', ')}`;
      case 'kit2_restore': return `restored ${(st.objects || []).join(', ')} from an earlier checkpoint`;
      case 'kit2_seat': return `seated ${(sm && sm.parts && Object.keys(sm.parts).join(', ')) || 'the part'} on ${sm?.host ?? 'its host'}${sm?.dry_run ? ' (dry run)' : ''}`;
      case 'rig_prepare': return `prepared the character mesh (${sm?.tris_before ?? '?'} -> ${sm?.tris_after ?? '?'} triangles, ${sm?.pieces ?? '?'} piece(s))`;
      case 'rig_biped': return `rigged the body (${sm?.bones ?? '?'} bones, ${sm?.weights?.unweighted ?? '?'} unweighted vertices)`;
      case 'rig_joint': return `moved ${st.joint} by ${(st.move_mm || []).join('/')} mm and bound again`;
      case 'rig_clip': return `applied the clip ${sm?.clip ?? ''} (${sm?.frames?.[1] - sm?.frames?.[0] + 1 || '?'} frames)`;
      default: return v;
    }
  } catch { return v; }
}

/* what a step acted on: the scene's own object name (the node name in latest.glb), a joint name for rig_joint, the clip name for rig_clip; none when there is no single subject */
function focusFor(v, st, sm) {
  try {
    let nodes = [];
    switch (v) {
      case 'kit2_part': nodes = st.pair ? [`${st.name}_L`, `${st.name}_R`] : [st.name]; break;
      case 'kit2_transform': nodes = [st.name]; break;
      case 'kit2_seat': nodes = st.parts || [st.part]; break;
      case 'kit2_bodyedit': case 'kit2_showthrough': nodes = [st.part]; break;
      case 'kit2_tweak': nodes = [...new Set((st.ops || []).map((o) => o.name).filter(Boolean))]; break;
      case 'kit2_restore': nodes = st.objects || []; break;
      case 'kit2_body': case 'rig_biped': case 'rig_prepare': nodes = ['body']; break;
      case 'rig_joint': nodes = [st.joint]; break;
      case 'rig_clip': nodes = [sm?.clip]; break;
      default: return {};
    }
    nodes = nodes.filter((x) => typeof x === 'string' && x);
    if (!nodes.length) return {};
    return { focus: nodes.length === 1 ? nodes[0] : (v === 'kit2_part' && st.pair ? st.name : undefined), focus_nodes: nodes };
  } catch { return {}; }
}

const effectiveCameras = (jobName) => {
  const base = readJson(path.join(HERE, 'lib', 'camera-sets', 'default.json')).shots
    .map((c) => ({ id: c.id, label: c.label, position: c.position, target: c.target, fov: c.fov }));
  const saved = (readJson(path.join(WORK_DIR, jobName, 'cameras.json'), { cameras: [] }) || { cameras: [] }).cameras;
  const byId = new Map(base.map((c) => [c.id, c]));
  for (const c of saved) byId.set(c.id, c); // a saved camera with a default's id replaces it, keeping its place
  return [...byId.values()];
};

function startWatch(jobName, verbName, st, res) {
  try {
    if (!res.ok || process.env.BLENDER_AGENT_WATCH === '0') return null;
    const isCam = verbName === 'kit2_camera';
    const isView = verbName === 'kit2_view';
    const isReview = verbName === 'kit2_review' || verbName === 'rig_motion';
    if (!res.output && !isCam && !isView && !isReview) return null;
    const wf = readJson(path.join(WORK_DIR, jobName, 'watch.json'), {}) || {};
    if (wf.enabled === false) return null;
    const wdir = path.join(WORK_DIR, jobName, 'watch');
    fs.mkdirSync(wdir, { recursive: true });
    if (isView || isReview) { // what the operator rendered is filed into the watch at the latest step: every picture in `looks`; the last close-up is also the `agent` camera
      const steps = (readJson(path.join(WORK_DIR, jobName, 'job.json'), { steps: [] }) || { steps: [] }).steps;
      const last = [...steps].reverse().find((x) => x.ok && x.output);
      const outDir = path.join(WORK_DIR, jobName, 'out');
      const sheet = st.sheet?.name ? `${st.sheet.name}.png` : null;
      const pics = (res.summary?.rendered || []).filter((f) => f.endsWith('.png') && !f.endsWith('-wide.png'));
      if (!last || !pics.length) return null;
      const looks = pics.map((f) => {
        const wide = path.join(outDir, f.replace(/\.png$/, '-wide.png'));
        return { src: path.join(outDir, f), wide: fs.existsSync(wide) ? wide : null, label: f.replace(/\.png$/, ''), maxw: verbName === 'rig_motion' ? 2400 : isReview || f === sheet ? 1024 : 768 };
      });
      const close = isView ? looks.filter((l) => l.src !== path.join(outDir, sheet || '')).slice(-1) : [];
      const vTask = { job: jobName, n: last.n, verb: last.step, at: new Date().toISOString(), note: '', mode: 'agent', looks, agent: close.map((l) => l.src), agent_wide: close.filter((l) => l.wide).map((l) => l.wide), cameras: [], all_cameras: effectiveCameras(jobName) };
      const vtf = path.join(wdir, `${last.n}-agent-${Date.now()}-task.json`);
      fs.writeFileSync(vtf, JSON.stringify(vTask));
      spawn(process.execPath, [path.join(HERE, 'watch.mjs'), vtf], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return 'queued';
    }
    if (isCam) { // re-capture the latest checkpoint for the camera that was just saved (or refresh the list after a delete)
      const steps = (readJson(path.join(WORK_DIR, jobName, 'job.json'), { steps: [] }) || { steps: [] }).steps;
      const last = [...steps].reverse().find((x) => x.ok && x.output);
      if (!last) return null;
      const all = effectiveCameras(jobName);
      const one = all.filter((c) => c.id === st.id);
      const camTask = { job: jobName, n: last.n, verb: last.step, at: new Date().toISOString(), note: '', mode: 'camera', blend: path.join(WORK_DIR, jobName, last.output),
        cameras: st.delete ? [] : one, all_cameras: all, agent: [], engine: wf.engine || 'workbench', samples: wf.samples || 12, tex: wf.tex || 1024, res: wf.res || 768, model: true, modes: wf.modes, wire_alpha: wf.wire_alpha };
      const ctf = path.join(wdir, `${last.n}-camera-${Date.now()}-task.json`);
      fs.writeFileSync(ctf, JSON.stringify(camTask));
      spawn(process.execPath, [path.join(HERE, 'watch.mjs'), ctf], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return 'queued';
    }
    const sf = path.join(wdir, 'state.json');
    const last = (readJson(sf, {}) || {}).lastMs || 0;
    const outDir = path.join(WORK_DIR, jobName, 'out');
    const agent = [];
    const wide = [];
    fs.writeFileSync(sf, JSON.stringify({ lastMs: Date.now() }));
    const k = Number(wf.model_every || 1);
    const task = {
      job: jobName, n: res.n, verb: verbName, at: new Date().toISOString(), note: noteFor(verbName, st, res.summary), ...focusFor(verbName, st, res.summary),
      blend: path.join(WORK_DIR, jobName, res.output), cameras: effectiveCameras(jobName), all_cameras: effectiveCameras(jobName), agent, agent_wide: wide, modes: wf.modes, wire_alpha: wf.wire_alpha,
      reference: verbName === 'import_mesh' || !fs.existsSync(path.join(config().shareRoot || path.join(ROOT, 'share'), path.posix.dirname(String(config().shareDir).replace(/\\/g, '/')), 'model-studio-live', jobName, 'model', 'reference.glb')),
      engine: wf.engine || 'workbench', samples: wf.samples || 12, tex: wf.tex || 1024, res: wf.res || 768, model: res.n % k === 0,
    };
    const tf = path.join(wdir, `${res.n}-task.json`);
    fs.writeFileSync(tf, JSON.stringify(task));
    const child = spawn(process.execPath, [path.join(HERE, 'watch.mjs'), tf], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    const strips = verbName === 'rig_clip' ? (res.summary?.rendered || []).filter((f) => f.endsWith('.png')) : [];
    if (strips.length) { // the strip of frames across the applied clip is filed as a look of this step (once the step's own capture is in the manifest)
      const lk = strips.map((f) => ({ src: path.join(outDir, f), wide: null, label: f.replace(/\.png$/, ''), maxw: 2400 }));
      const stf = path.join(wdir, `${res.n}-strip-${Date.now()}-task.json`);
      fs.writeFileSync(stf, JSON.stringify({ job: jobName, n: res.n, verb: verbName, at: new Date().toISOString(), note: '', mode: 'agent', looks: lk, agent: [], agent_wide: [], cameras: [], all_cameras: effectiveCameras(jobName) }));
      spawn(process.execPath, [path.join(HERE, 'watch.mjs'), stf], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    return 'queued';
  } catch { return null; }
}

if (verb === 'watch') {
  const wf = path.join(WORK_DIR, job, 'watch.json');
  const cur = readJson(wf, {}) || {};
  const allowed = ['enabled', 'engine', 'samples', 'tex', 'res', 'model_every', 'modes', 'wire_alpha'];
  for (const k of Object.keys(settings)) if (allowed.includes(k)) cur[k] = settings[k];
  fs.mkdirSync(path.dirname(wf), { recursive: true });
  fs.writeFileSync(wf, JSON.stringify(cur));
  out({ ok: true, verb, job, watch: { enabled: cur.enabled !== false, ...cur }, settings });
}

if (verb === 'kit2_look') {
  // the captured frames of a step, as share refs the operator can open — no rendering. Waits (up to 25 s) for the capture of the latest step.
  const cfg = config();
  const roomRel = path.posix.dirname(String(cfg.shareDir).replace(/\\/g, '/'));
  const mf = path.join(cfg.shareRoot || path.join(ROOT, 'share'), roomRel, 'model-studio-live', job, 'manifest.json');
  const LETTER = { a: 'color', b: 'wire', c: 'refwire' };
  const GUIDE = {
    plain: 'the assets in colour, reference hidden: what the finished piece looks like',
    color: 'A: reference solid grey, assets in colour: where parts sit, what pokes out or sinks in',
    wire: 'B: reference see-through, assets as bright wireframe: fit of each part to the surface under it',
    refwire: 'C: reference as a wire grid, assets solid grey: where the reference sticks out beyond the parts',
  };
  const steps = (readJson(path.join(WORK_DIR, job, 'job.json'), { steps: [] }) || { steps: [] }).steps;
  const lastSaved = [...steps].reverse().find((x) => x.ok && x.output)?.n;
  const want = settings.step ?? lastSaved;
  let m = null;
  for (let i = 0; i < 26; i++) {
    m = readJson(mf, null);
    if (m && (want === undefined || m.steps.some((x) => x.n === want)) ) break;
    if (settings.step !== undefined || i === 25) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (!m) out({ ok: false, verb, error: 'no live captures for this job yet (is the watch on? it starts after the first saving verb)' }, 1);
  const st = m.steps.find((x) => x.n === want) || m.steps[m.steps.length - 1];
  const modeIds = (settings.modes || ['plain']).map((x) => LETTER[String(x).toLowerCase()] || String(x).toLowerCase());
  const bad = modeIds.filter((x) => !GUIDE[x]);
  if (bad.length) out({ ok: false, verb, error: `unknown mode ${bad.join(', ')}: use plain, color (A), wire (B), refwire (C)` }, 2);
  const camIds = settings.cameras || ['front', 'back'];
  const frames = [];
  for (const c of camIds) for (const md of modeIds) {
    const p = st?.frames?.[c]?.[md];
    if (p) frames.push({ camera: c, mode: md, ref: `${roomRel}/model-studio-live/${job}/${p}` });
  }
  const missing = camIds.flatMap((c) => modeIds.filter((md) => !st?.frames?.[c]?.[md]).map((md) => `${c}/${md}`));
  out({ ok: true, verb, job, step: st?.n, latest_step: m.steps[m.steps.length - 1]?.n, pending: want !== undefined && st?.n !== want, note: st?.note, opening: !!st?.opening,
    frames, looks: (settings.looks_last === undefined ? (st?.looks || []) : (Number(settings.looks_last) <= 0 ? [] : (st?.looks || []).slice(-Number(settings.looks_last)))).map((l) => ({ label: l.label, at: l.at, ref: `${roomRel}/model-studio-live/${job}/${l.file}`, wide_ref: l.wide ? `${roomRel}/model-studio-live/${job}/${l.wide}` : null })), missing, cameras_available: m.cameras.map((c) => c.id), modes: Object.fromEntries(modeIds.map((x) => [x, GUIDE[x]])), settings });
}

if (verb === 'journal') {
  /* the job's own record: every step that ran (ok or failed), in order, with its settings, time and the checkpoint it saved or branched from. Read-only. */
  const dir = path.join(WORK_DIR, job);
  const st = readJson(path.join(dir, 'job.json'), null);
  if (!st) out({ ok: false, verb, error: `no job ${job}` }, 2);
  let steps = st.steps || [];
  const nOf = (f) => { const m = /^(\d+)-/.exec(String(f || '')); return m ? parseInt(m[1], 10) : null; };
  let prevSaved = null;
  const rows = steps.map((s) => {
    const base = nOf(s.input);
    const r = { n: s.n, verb: s.step, ok: !!s.ok, secs: s.secs, at: s.at, from_checkpoint: base, branched: base != null && prevSaved != null && base !== prevSaved, saved: s.output || null };
    if (s.ok && s.output) prevSaved = s.n;
    const txt = JSON.stringify(s.params ?? null);
    r.settings = settings.full ? s.params : (txt.length > 200 ? txt.slice(0, 200) + '…' : s.params);
    if (!s.ok) {
      const rep = s.report ? readJson(path.join(dir, s.report), null) : null;
      r.error = rep?.error || s.error || `exit ${s.exit}`;
    }
    return r;
  });
  let sel = rows;
  if (settings.verbs) sel = sel.filter((r) => settings.verbs.includes(r.verb));
  if (settings.failed_only) sel = sel.filter((r) => !r.ok);
  if (settings.from_n != null) sel = sel.filter((r) => r.n >= settings.from_n);
  const last = settings.last ?? 40;
  const byVerb = {};
  for (const r of rows) { byVerb[r.verb] = byVerb[r.verb] || { ran: 0, failed: 0 }; byVerb[r.verb].ran++; if (!r.ok) byVerb[r.verb].failed++; }
  out({ ok: true, verb, job, steps_total: rows.length, failed_total: rows.filter((r) => !r.ok).length, branches: rows.filter((r) => r.branched).length, by_verb: byVerb, showing: Math.min(last, sel.length), steps: sel.slice(-last), settings });
}

if (verb === 'bake_progress') {
  /* read-only view of a running (or finished) lightmap_bake step: no Blender, no lock, nothing is touched. The bake writes one EXR per bulb as each finishes, in the order of its `bulbs` list. */
  const dir = path.join(WORK_DIR, job);
  if (!fs.existsSync(dir)) out({ ok: false, verb, error: `no job ${job}` }, 2);
  const files = fs.readdirSync(dir);
  const nOfF = (f) => { const m = /^(\d+)-lightmap_bake\.args\.json$/.exec(f); return m ? parseInt(m[1], 10) : null; };
  const steps = files.map(nOfF).filter((x) => x !== null).sort((a, b) => a - b);
  const n = settings.n != null ? Number(settings.n) : steps.filter((x) => !files.some((f) => f.startsWith(String(x).padStart(2, '0') + '-lightmap_bake.report.json'))).pop() ?? steps[steps.length - 1];
  if (n == null) out({ ok: false, verb, job, error: 'no lightmap_bake step in this job' }, 2);
  const pre = String(n).padStart(2, '0') + '-lightmap_bake';
  const argsF = path.join(dir, pre + '.args.json');
  const args = readJson(argsF, null);
  if (!args) out({ ok: false, verb, job, error: `no ${pre}.args.json` }, 2);
  const prm = args.params || {};
  const name = prm.name || 'lightmaps';
  const lmDir = path.join(dir, 'out', 'lightmaps');
  const bulbs = Array.isArray(prm.bulbs) ? prm.bulbs : [];
  const ids = bulbs.filter((b) => !/[*?]/.test(b)).map((b) => String(b).replace(/^bulb_/, '').replace(/\.light$/, ''));
  const exact = ids.length === bulbs.length;
  const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };
  const startMs = (stat(argsF) || {}).mtimeMs || null;
  const exr = (fs.existsSync(lmDir) ? fs.readdirSync(lmDir) : []).filter((f) => f.startsWith(name + '-') && f.endsWith('.exr')).map((f) => ({ f, st: stat(path.join(lmDir, f)) })).filter((x) => x.st && (!startMs || x.st.mtimeMs >= startMs - 1000)).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  const now = Date.now();
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const secs = exr.length > 1 ? (exr[exr.length - 1].st.mtimeMs - exr[0].st.mtimeMs) / 1000 / (exr.length - 1) : null;
  const done = exact ? ids.filter((i) => exr.some((x) => x.f === `${name}-${i}.exr`)).length : exr.length;
  const log = stat(path.join(dir, pre + '.log'));
  const rep = stat(path.join(dir, pre + '.report.json'));
  const final = { bin: !!stat(path.join(lmDir, name + '.lightmaps.bin')), mask: !!stat(path.join(lmDir, name + '.mask.u8')), manifest: !!stat(path.join(lmDir, name + '.lightmaps.json')),
    probes: !!stat(path.join(lmDir, name + '.probes.json')), report_json: !!rep, checkpoint_blend: files.some((f) => f.startsWith(pre) && f.endsWith('.blend')) };
  out({ ok: true, verb, job, step: n, name, running: !rep, bulbs_requested: exact ? bulbs.length : null, bulbs_requested_patterns: exact ? undefined : bulbs, exr_done: done, exr_files_found: exr.length,
    remaining_bulbs: exact ? ids.filter((i) => !exr.some((x) => x.f === `${name}-${i}.exr`)).length : null, first_bulb: exact ? ids[0] : undefined, last_bulb: exact ? ids[ids.length - 1] : undefined,
    latest_exr: exr.length ? { file: exr[exr.length - 1].f, at: iso(exr[exr.length - 1].st.mtimeMs), seconds_ago: Math.round((now - exr[exr.length - 1].st.mtimeMs) / 1000) } : null,
    step_started_at: iso(startMs), elapsed_s: startMs ? Math.round(((rep ? rep.mtimeMs : now) - startMs) / 1000) : null, seconds_per_bulb_measured: secs !== null ? Math.round(secs * 10) / 10 : null,
    samples: prm.samples ?? null, atlas_px: prm.atlas_px ?? null, device: 'CPU (lightmap_bake sets Cycles to CPU; the log does not print it)', log_bytes: log ? log.size : null, log_last_write: iso(log && log.mtimeMs), final_files: final, now: iso(now),
    note: 'the bake loop is only part of the step: packing, mask, probes, pictures and the manifest come after the last EXR; no end time is estimated here' });
}

if (verb === 'fetch') {
  const { download } = await import('./lib/ops.mjs');
  const files = [];
  try {
    for (const x of settings.ids || []) { const id = typeof x === 'object' ? x.library_id : x; files.push({ id, ...(await download(id)) }); }
  } catch (e) {
    out({ ok: false, verb, error: e.message, files }, 1);
  }
  out({ ok: true, verb, files, settings });
}

if (verb === 'post') {
  const cfg = config();
  const outDir = path.join(WORK_DIR, job, 'out');
  let roomDir = path.join(cfg.shareRoot || path.join(ROOT, 'share'), path.dirname(cfg.shareDir)); // the room's top-level assets
  if (settings.to != null) {
    // `to`: a folder of the share instead of the default room folder: one of the folders listed in config `postRooms` (e.g. rooms/<room>[/sub/...]); "{job}" stands for this job's name; created if missing
    const rel = String(settings.to).replace(/\\/g, '/').replace(/\{job\}/g, job).replace(/\/+$/, '');
    const ROOMS = Array.isArray(cfg.postRooms) && cfg.postRooms.length ? cfg.postRooms : [String(cfg.shareDir || 'rooms/default').replace(/\\/g, '/').split('/').slice(0, 2).join('/')];
    const ok = ROOMS.some((r) => rel === r || rel.startsWith(r + '/')) && rel.split('/').every((seg) => /^[A-Za-z0-9._-]+$/.test(seg) && seg !== '.' && seg !== '..');
    if (!ok) out({ ok: false, verb, error: `bad destination: ${settings.to} (must be ${ROOMS.join(' or ')}, optionally followed by folders of letters, digits, . _ -)` }, 2);
    roomDir = path.join(cfg.shareRoot || path.join(ROOT, 'share'), rel);
  }
  const done = [];
  for (const pic of settings.pictures || []) {
    const { from, as } = pic;
    if (pic.frame) {
      // a frame of the watch (model-studio-live/<job>/frames/<camera>/<mode>/<step>.jpg) saved as a PNG under a fixed name
      const fr = pic.frame;
      const MODE = { a: 'color', b: 'wire', c: 'refwire', color: 'color', colour: 'color', wire: 'wire', refwire: 'refwire', plain: 'plain' };
      const mode = MODE[String(fr.mode || 'plain').toLowerCase()];
      if (!mode || !/^[a-z0-9-]+$/.test(fr.camera || '') || !/^[A-Za-z0-9._-]+\.png$/.test(as || '')) out({ ok: false, verb, error: `bad frame picture: ${JSON.stringify(fr)} -> ${as}`, done }, 2);
      const fdir = path.join(roomDir, 'model-studio-live', job, 'frames', fr.camera, mode);
      let step = fr.step;
      if (step == null) {
        const ns = fs.existsSync(fdir) ? fs.readdirSync(fdir).map((f) => parseInt(f, 10)).filter(Number.isFinite) : [];
        step = ns.length ? Math.max(...ns) : null;
      }
      const fsrc = path.join(fdir, `${step}.jpg`);
      const fdst = path.join(roomDir, as);
      if (step == null || !fs.existsSync(fsrc)) out({ ok: false, verb, error: `no watch frame ${fr.camera}/${mode} at step ${step ?? 'latest'}`, done }, 1);
      if (settings.keep && fs.existsSync(fdst)) out({ ok: false, verb, error: `refused: ${as} already exists and keep is set`, done }, 1);
      fs.mkdirSync(roomDir, { recursive: true });
      const cv = spawnSync('python', ['-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2],"PNG")', fsrc, fdst], { encoding: 'utf8' });
      if (cv.status !== 0) out({ ok: false, verb, error: `could not convert the frame to PNG: ${String(cv.stderr).slice(-200)}`, done }, 1);
      done.push({ frame: { camera: fr.camera, mode, step }, as, bytes: fs.statSync(fdst).size });
      continue;
    }
    const NAME = /^[A-Za-z0-9._-]+\.(png|json|txt|csv|glb|blend|bin|u8|exr)$/;
    const FROM = /^((lightmaps|lightmap-fixture)\/)?[A-Za-z0-9._-]+\.(png|json|txt|csv|glb|blend|bin|u8|exr)$/; // a source may sit in out/lightmaps/ or out/lightmap-fixture/
    const jobDir = path.join(WORK_DIR, job);
    let fromName = from;
    if (pic.checkpoint != null) {
      // a saved checkpoint of this job (work/<job>/NN-<verb>.blend), copied as a .blend
      const nn = String(pic.checkpoint).padStart(2, '0');
      const hit = fs.existsSync(jobDir) ? fs.readdirSync(jobDir).find((f) => f.startsWith(`${nn}-`) && f.endsWith('.blend')) : null;
      if (!hit) out({ ok: false, verb, error: `no checkpoint ${pic.checkpoint} (a NN-<verb>.blend) in work/${job}`, done }, 1);
      fromName = hit;
    }
    if (pic.report != null) {
      // the full report of a step of this job (work/<job>/NN-<verb>.report.json), copied as a .json
      const nn = String(pic.report).padStart(2, '0');
      const hit = fs.existsSync(jobDir) ? fs.readdirSync(jobDir).find((f) => f.startsWith(`${nn}-`) && f.endsWith('.report.json')) : null;
      if (!hit) out({ ok: false, verb, error: `no report for step ${pic.report} (a NN-<verb>.report.json) in work/${job}`, done }, 1);
      fromName = hit;
    }
    if (!FROM.test(fromName || '') || !NAME.test(as || '') || path.extname(fromName) !== path.extname(as)) out({ ok: false, verb, error: `bad file name (a .png .json .txt .csv .glb .blend .bin .u8 or .exr, same extension both sides; the source may be lightmaps/<file> or lightmap-fixture/<file>): ${fromName} -> ${as}`, done }, 2);
    const fromJob = pic.checkpoint != null || pic.report != null;
    const src = path.join(fromJob ? jobDir : outDir, fromName);
    const dst = path.join(roomDir, as);
    if (!fs.existsSync(src)) out({ ok: false, verb, error: `no such file in work/${job}${fromJob ? '' : '/out'}: ${fromName}`, done }, 1);
    if (settings.keep && fs.existsSync(dst)) out({ ok: false, verb, error: `refused: ${as} already exists and keep is set`, done }, 1);
    fs.mkdirSync(roomDir, { recursive: true });
    fs.copyFileSync(src, dst);
    done.push({ from: fromName, as, bytes: fs.statSync(dst).size });
  }
  out({ ok: true, verb, room_dir: roomDir, posted: done, settings });
}

if (verb === 'publish' && settings.source_to != null) {
  // attach a Blender source (.blend written by source_slim, or any .blend in out/) to an ALREADY published GLB: no second GLB is made
  const label = settings.label;
  const file = settings.source_file;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(settings.source_to))) out({ ok: false, verb, error: 'source_to must be the Library id of the published GLB' }, 2);
  if (!/^[A-Za-z0-9._-]+\.blend$/.test(file || '')) out({ ok: false, verb, error: `source_file must be a plain .blend file name in work/${job}/out: ${file}` }, 2);
  if (typeof label !== 'string' || !/^[\x20-\x7E]{3,120}$/.test(label)) out({ ok: false, verb, error: 'label must be 3 to 120 printable ASCII characters' }, 2);
  const src = path.join(WORK_DIR, job, 'out', file);
  if (!fs.existsSync(src)) out({ ok: false, verb, error: `no such file in work/${job}/out: ${file}` }, 1);
  if (settings.dry_run) out({ ok: true, verb, dry_run: true, would_publish_source: { file: src, bytes: fs.statSync(src).size, of: settings.source_to, label }, settings });
  const pdir = path.join(WORK_DIR, job, 'params');
  fs.mkdirSync(pdir, { recursive: true });
  const sl = path.join(pdir, `${Date.now()}-source-label.txt`);
  fs.writeFileSync(sl, label);
  const r2 = spawnSync(process.execPath, [path.join(HERE, 'publish.mjs'), 'source', src, sl, String(settings.source_to), job, String(settings.source_checkpoint ?? 0)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...(settings.room ? { PUBLISH_ROOM: JSON.stringify(settings.room) } : {}) } });
  const l2 = (r2.stdout || '').trim().split('\n').filter(Boolean);
  let s2;
  try { s2 = JSON.parse(l2[l2.length - 1]); } catch { s2 = { ok: false, error: `could not read the result: ${(r2.stdout || '').slice(-300)} ${(r2.stderr || '').slice(-300)}` }; }
  out({ verb, ...s2, file, bytes: fs.statSync(src).size, settings }, r2.status === 0 && s2.ok !== false ? 0 : 1);
}

if (verb === 'publish') {
  const glb = settings.glb;
  const label = settings.label;
  if (!/^[A-Za-z0-9._-]+\.glb$/.test(glb || '') || /\.meshopt\.glb$/.test(glb)) out({ ok: false, verb, error: `glb must be a plain file name ending in .glb (not .meshopt.glb): ${glb}` }, 2);
  if (typeof label !== 'string' || !/^[\x20-\x7E]{3,120}$/.test(label)) out({ ok: false, verb, error: 'label must be 3 to 120 printable ASCII characters' }, 2);
  const src = path.join(WORK_DIR, job, 'out', glb);
  if (!fs.existsSync(src)) out({ ok: false, verb, error: `no such file in work/${job}/out: ${glb}` }, 1);
  const pdir = path.join(WORK_DIR, job, 'params');
  fs.mkdirSync(pdir, { recursive: true });
  const labelFile = path.join(pdir, `${Date.now()}-label.txt`);
  fs.writeFileSync(labelFile, label);
  const argv = [path.join(HERE, 'publish.mjs'), 'input', src, 'blender-studio', labelFile];
  if (settings.dry_run) {
    const nn = settings.source_checkpoint != null ? String(settings.source_checkpoint).padStart(2, '0') : null;
    const hit = nn ? fs.readdirSync(path.join(WORK_DIR, job)).find((f) => f.startsWith(`${nn}-`) && f.endsWith('.blend')) : null;
    out({ ok: true, verb, dry_run: true, would_publish: { file: src, bytes: fs.statSync(src).size, label }, ...(nn ? { would_publish_source: hit ? { file: hit, bytes: fs.statSync(path.join(WORK_DIR, job, hit)).size } : { error: `no checkpoint ${settings.source_checkpoint}` } } : {}), label_file: labelFile, settings });
  }
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...(settings.room ? { PUBLISH_ROOM: JSON.stringify(settings.room) } : {}) } });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  let res;
  try { res = JSON.parse(lines[lines.length - 1]); } catch { res = { ok: false, error: `could not read the result: ${(r.stdout || '').slice(-300)} ${(r.stderr || '').slice(-300)}` }; }
  if (r.status === 0 && res.ok !== false && settings.source_checkpoint != null) {
    // the editable source: the job's checkpoint .blend, registered as its own Library asset and noted on the GLB
    const nn = String(settings.source_checkpoint).padStart(2, '0');
    const hit = fs.readdirSync(path.join(WORK_DIR, job)).find((f) => f.startsWith(`${nn}-`) && f.endsWith('.blend'));
    if (!hit) out({ verb, label, ...res, source_error: `no checkpoint ${settings.source_checkpoint} (a NN-<verb>.blend) in work/${job}`, settings }, 1);
    const sl = path.join(pdir, `${Date.now()}-source-label.txt`);
    fs.writeFileSync(sl, `${label} (Blender source, checkpoint ${settings.source_checkpoint})`.slice(0, 120));
    const r2 = spawnSync(process.execPath, [path.join(HERE, 'publish.mjs'), 'source', path.join(WORK_DIR, job, hit), sl, String(res.id), job, String(settings.source_checkpoint)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...(settings.room ? { PUBLISH_ROOM: JSON.stringify(settings.room) } : {}) } });
    const l2 = (r2.stdout || '').trim().split('\n').filter(Boolean);
    let s2;
    try { s2 = JSON.parse(l2[l2.length - 1]); } catch { s2 = { ok: false, error: `could not read the result: ${(r2.stdout || '').slice(-300)} ${(r2.stderr || '').slice(-300)}` }; }
    res.source = { ...s2, file: hit, bytes: fs.statSync(path.join(WORK_DIR, job, hit)).size };
  }
  out({ verb, label, ...res, settings }, r.status === 0 && res.ok !== false ? 0 : 1);
}

if (!fs.existsSync(path.join(HERE, 'steps', `${verb}.py`))) out({ ok: false, error: `no such verb: ${verb}` }, 2);
const pdir = path.join(WORK_DIR, job, 'params');
fs.mkdirSync(pdir, { recursive: true });
const pfile = path.join(pdir, `${Date.now()}-${verb}.json`);
fs.writeFileSync(pfile, JSON.stringify(settings));
const cmd = [path.join(HERE, 'run-step.mjs'), job, verb, pfile];
if (flags.from !== null) cmd.push('--from', String(flags.from));
if (flags.timeout !== null) cmd.push('--timeout', String(flags.timeout));
const r = spawnSync(process.execPath, cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
let res;
try { res = JSON.parse(lines[lines.length - 1]); } catch { res = { ok: false, error: `could not read the result: ${(r.stdout || '').slice(-300)} ${(r.stderr || '').slice(-300)}` }; }
res.settings = settings;
const w = startWatch(job, verb, settings, res);
if (w) res.watch = w;
out(res, r.status === 0 ? 0 : r.status === 1 ? 1 : 2);