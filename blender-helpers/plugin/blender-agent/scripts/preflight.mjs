#!/usr/bin/env node
/*
 * Readiness (tool-residents §4.1), three outcomes per check: up / down / unknown.
 *   blender  — the pinned app answers a version probe within 60 s
 *   library  — the asset-platform Library answers
 *   share    — the file share answers
 *   gpu      — free VRAM (only matters for device:"GPU" previews; CPU is the default)
 * Prints one JSON line; publishes status/widget.json.
 * Exit 0 ready / 1 something down / 2 could not tell.
 */
import { spawnSync } from 'node:child_process';
import { config, writeWidget } from './lib/common.mjs';

const cfg = config();

function blender() {
  const r = spawnSync(cfg.blender, ['--factory-startup', '-b', '--python-expr', 'import bpy;print("V",bpy.app.version_string)'],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.error?.code === 'ENOENT') return { state: 'down', reason: `not found: ${cfg.blender}` };
  if (r.error) return { state: 'unknown', reason: r.error.message };
  const m = /V (\S+)/.exec(r.stdout || '');
  return m ? { state: 'up', version: m[1] } : { state: 'down', reason: `exit ${r.status}` };
}

async function http(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok ? { state: 'up' } : { state: 'down', reason: `HTTP ${res.status}` };
  } catch (e) {
    return { state: 'unknown', reason: e.cause?.code || e.message };
  }
}

function gpu() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) return { state: 'unknown', reason: 'nvidia-smi failed' };
  const [used, total] = r.stdout.trim().split(',').map(Number);
  return { state: 'up', used_mb: used, free_mb: total - used };
}

const checks = {
  blender: blender(),
  library: await http(`${cfg.libraryUrl}/api/assets?limit=1`),
  share: await http(`${cfg.shareUrl}/health`),
  gpu: gpu(),
};
const required = ['blender', 'library', 'share'];
const states = required.map((k) => checks[k].state);
const code = states.includes('down') ? 1 : states.includes('unknown') ? 2 : 0;
const text = code === 0 ? `ready · blender ${checks.blender.version}`
  : `not ready: ${required.filter((k) => checks[k].state !== 'up').map((k) => `${k} ${checks[k].state}`).join(', ')}`;
writeWidget(code === 0 ? 'ok' : 'warn', text);
console.log(JSON.stringify({ ready: code === 0, code, checks }));
process.exit(code);
