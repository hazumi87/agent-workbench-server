#!/usr/bin/env node
// Scenario (scenario.com) client: Library images in → a hosted 3D model → the GLB back in the Library
// with its settings. The engine for a later Model Studio backend; today a CLI.
//
//   node scenario.mjs models [filter]                 3D models and their inputs (free)
//   node scenario.mjs jobs --since <ISO> [--until <ISO>]   every job in that window with its times and credits, as JSON (free)
//   node scenario.mjs run <modelId> --in frontImage=<libraryAssetId> [--in …] [--param k=v …]
//        [--label "…"] [--collection-note "…"]        DRY RUN: prints the credit cost, spends nothing
//   … --confirm-cost <N>                              the real run; refused unless N is the dry-run cost
//
// Credits are real money: a run never starts without --confirm-cost matching what Scenario quotes.
// The key file holds "id: …" and "secret: …" lines; it is read here and never printed.
import { readFile } from 'node:fs/promises';

const API = 'https://api.cloud.scenario.com/v1';
const LIB = (process.env.LIBRARY_URL || 'http://127.0.0.1:8260/asset-management/library').replace(/\/$/, '');
const KEY_FILE = process.env.SCENARIO_KEY_FILE || (process.env.HOME || '.') + '/.config/scenario/api-key';

let auth;
async function headers(extra = {}) {
  if (!auth) {
    const raw = await readFile(KEY_FILE, 'utf8');
    const val = (k) => (raw.match(new RegExp('^\\s*' + k + '\\s*:\\s*(\\S+)', 'mi')) || [])[1];
    if (!val('id') || !val('secret')) throw new Error('key file: id/secret lines not found');
    auth = 'Basic ' + Buffer.from(val('id') + ':' + val('secret')).toString('base64');
  }
  return { Authorization: auth, accept: 'application/json', ...extra };
}
async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: await headers(body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function projectId() {
  if (process.env.SCENARIO_PROJECT_ID) return process.env.SCENARIO_PROJECT_ID;
  const p = (await api('GET', '/projects')).projects || [];
  if (!p.length) throw new Error('no Scenario project visible to this key');
  return p[0].id;
}

// A Library asset → a Scenario asset id. Under 4 MB goes inline; larger uses the multipart flow.
async function uploadFromLibrary(libId, pid) {
  const row = (await (await fetch(`${LIB}/api/assets/${libId}`)).json());
  const meta = row.asset || row;
  if (!meta || !meta.id) throw new Error(`Library asset ${libId} not found`);
  const bytes = Buffer.from(await (await fetch(`${LIB}/api/assets/${libId}/file`)).arrayBuffer());
  const name = meta.filename || `${libId}.png`;
  if (bytes.length < 4 * 1024 * 1024) {
    const j = await api('POST', `/assets?projectId=${pid}`, { name, image: bytes.toString('base64') });
    return j.asset.id;
  }
  const contentType = /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png';
  const up = await api('POST', `/uploads?projectId=${pid}`, { fileName: name, contentType, kind: 'image', parts: 1, fileSize: bytes.length });
  const put = await fetch(up.upload.parts[0].url, { method: 'PUT', body: bytes });
  if (!put.ok) throw new Error(`part upload -> ${put.status}`);
  await api('POST', `/uploads/${up.upload.id}/action?projectId=${pid}`, { action: 'complete' });
  for (let i = 0; i < 60; i++) {
    const u = (await api('GET', `/uploads/${up.upload.id}?projectId=${pid}`)).upload;
    if (u.status === 'imported') return u.entityId;
    if (u.status === 'failed') throw new Error('Scenario upload failed');
    await sleep(2000);
  }
  throw new Error('Scenario upload timed out');
}

const pairs = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : [])).map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; });
const opt = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const cast = (v) => (v === 'true' ? true : v === 'false' ? false : v !== '' && !isNaN(v) ? Number(v) : v);

async function models(filter) {
  let tok = '';
  for (;;) {
    const j = await api('GET', '/models?privacy=public&pageSize=100' + (tok ? '&paginationToken=' + encodeURIComponent(tok) : ''));
    for (const m of j.models) {
      if (!(m.capabilities || []).some((c) => /3d/.test(c))) continue;
      if (filter && !new RegExp(filter, 'i').test(m.id + ' ' + m.name)) continue;
      console.log(`${m.id} | ${m.name} | ${(m.capabilities || []).join('+')}`);
    }
    tok = j.nextPaginationToken;
    if (!tok) return;
  }
}

// Jobs come newest first; stop at the first one older than --since. For a run's timeline (packages/timeline).
async function jobs(args) {
  const pid = await projectId(), since = Date.parse(opt(args, '--since') || ''), until = Date.parse(opt(args, '--until') || '') || Infinity;
  if (!since) throw new Error('--since <ISO time> is required');
  const out = [];
  for (let tok = ''; ;) {
    const j = await api('GET', `/jobs?projectId=${pid}&pageSize=50` + (tok ? '&paginationToken=' + encodeURIComponent(tok) : ''));
    for (const x of j.jobs || []) {
      const made = Date.parse(x.createdAt);
      if (made < since) { tok = ''; j.nextPaginationToken = ''; break; }
      if (made > until) continue;
      const began = (x.statusHistory || []).find((h) => h.status === 'in-progress');
      out.push({ jobId: x.jobId, model: x.metadata?.input?.modelId || x.metadata?.modelId || x.modelId || x.jobType, status: x.status, created: x.createdAt, started: began?.date || x.createdAt, ended: x.updatedAt, credits: x.billing?.cuCost ?? 0, by: /^apiu_/.test(x.authorId || '') ? 'api' : 'web', assets: (x.metadata?.assetIds || []).length });
    }
    tok = j.nextPaginationToken;
    if (!tok) break;
  }
  console.log(JSON.stringify(out.reverse()));
}

async function run(modelId, args) {
  const pid = await projectId();
  const ins = pairs(args, '--in'), params = Object.fromEntries(pairs(args, '--param').map(([k, v]) => [k, cast(v)]));
  const confirm = opt(args, '--confirm-cost'), label = opt(args, '--label') || modelId;
  if (!ins.length) throw new Error('at least one --in name=<libraryAssetId>');
  const body = { ...params };
  for (const [name, libId] of ins) body[name] = await uploadFromLibrary(libId, pid);   // uploads are free
  const quote = await api('POST', `/generate/custom/${modelId}?projectId=${pid}&dryRun=true`, body);
  const cost = quote.creativeUnitsCost;
  console.log(JSON.stringify({ dryRun: true, modelId, cost, params, inputs: Object.fromEntries(ins) }));
  if (confirm === undefined) return;
  if (cost === undefined || Number(confirm) !== Number(cost)) throw new Error(`--confirm-cost ${confirm} does not match the quoted cost ${cost}; not running`);

  const started = await api('POST', `/generate/custom/${modelId}?projectId=${pid}`, body);
  const jobId = started.job.jobId;
  console.log(JSON.stringify({ started: jobId, cost: started.creativeUnitsCost }));
  let job;
  for (let i = 0; i < 240; i++) {
    job = (await api('GET', `/jobs/${jobId}?projectId=${pid}`)).job;
    if (['success', 'failure', 'canceled'].includes(job.status)) break;
    await sleep(5000);
  }
  if (job.status !== 'success') throw new Error(`job ${jobId} ${job.status}: ${job.metadata?.error || ''}`);

  const out = [];
  for (const assetId of job.metadata.assetIds || []) {
    const a = (await api('GET', `/assets/${assetId}?projectId=${pid}`)).asset;
    // a 3D job returns the GLB plus OBJ/MTL exports and loose texture maps; the Library keeps the GLB only
    if (!/gltf-binary/.test(a.mimeType || '') && (job.metadata.assetIds || []).length > 1) continue;   // (the PBR maps are inside the GLB too)
    const file = Buffer.from(await (await fetch(a.originalFileUrl || a.url)).arrayBuffer());
    const ext = /gltf-binary|glb/.test(a.mimeType || '') || a.kind === '3d' ? 'glb' : (a.mimeType || '').split('/')[1] || 'bin';
    const fd = new FormData();
    fd.set('file', new Blob([file]), `${label.replace(/[^\w.-]+/g, '-')}.${ext}`);
    fd.set('label', label);
    fd.set('source', 'scenario');
    fd.set('parent_id', ins[0][1]);
    fd.set('derived_op', JSON.stringify({ tool: 'scenario', provider: 'scenario', id: modelId, params, inputs: Object.fromEntries(ins), job: jobId, credits: job.billing?.cuCost ?? cost }));
    fd.set('meta', JSON.stringify({ scenario: { assetId, jobId, mimeType: a.mimeType, kind: a.kind } }));
    const r = await fetch(`${LIB}/api/assets/upload`, { method: 'POST', body: fd });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Library upload -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    out.push({ scenarioAsset: assetId, libraryId: (j.asset || j).id, bytes: file.length, mimeType: a.mimeType });
  }
  console.log(JSON.stringify({ done: jobId, credits: job.billing?.cuCost, outputs: out }));
}

const [cmd, a1, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'models') await models(a1);
  else if (cmd === 'jobs') await jobs([a1, ...rest]);
  else if (cmd === 'run' && a1) await run(a1, rest);
  else { console.error('usage: scenario.mjs models [filter] | run <modelId> --in name=<libraryAssetId> … [--param k=v …] [--label …] [--confirm-cost N]'); process.exit(2); }
} catch (e) { console.error('ERROR', e.message); process.exit(1); }
