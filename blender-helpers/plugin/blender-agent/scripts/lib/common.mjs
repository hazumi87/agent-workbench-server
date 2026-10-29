/*
 * Shared bits for every blender-agent script: paths, config, the
 * single-instance lock, the WidgetStatus line, and killing a process tree.
 * Zero dependencies (node >= 20). Windows first (the GPU host); POSIX works for tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATUS_DIR = path.join(ROOT, 'status');
export const WORK_DIR = path.join(ROOT, 'work');
export const STEPS_DIR = path.join(ROOT, 'scripts', 'steps');
const LOCK = path.join(STATUS_DIR, '.lock');
const WIDGET = path.join(STATUS_DIR, 'widget.json');

/* config.local.json overrides config.example.json; env BLENDER_AGENT_BLENDER overrides the binary. */
export function config() {
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    } catch {
      return {};
    }
  };
  const cfg = { ...read('config.example.json'), ...read('config.local.json') };
  if (process.env.BLENDER_AGENT_BLENDER) cfg.blender = process.env.BLENDER_AGENT_BLENDER;
  cfg.blender = path.resolve(ROOT, cfg.blender);
  return cfg;
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/* One step at a time: the GPU and the .blend state are exclusive. A lock whose pid is gone is stale. */
export function acquireLock(what) {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() }), { flag: 'wx' });
      return () => fs.rmSync(LOCK, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try {
        held = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      } catch {
        /* unreadable lock: treat as stale */
      }
      if (held && alive(held.pid)) throw new Error(`busy: ${held.what} (pid ${held.pid}, since ${held.at})`);
      fs.rmSync(LOCK, { force: true });
    }
  }
  throw new Error('could not take status/.lock');
}

/* WidgetStatus (the workroom app widget-status module): kind ok|warn|cold, text <= 120, ts in epoch seconds. */
export function writeWidget(kind, text) {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  const line = { kind, text: String(text).slice(0, 120), ts: Math.floor(Date.now() / 1000), expiresAt: null };
  fs.writeFileSync(WIDGET + '.tmp', JSON.stringify(line));
  fs.renameSync(WIDGET + '.tmp', WIDGET);
}

/* Kill the whole tree we started, by pid. Never by image name: the user may have his own Blender open. */
export function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

export const JOB_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const STEP_RE = /^[a-z][a-z0-9_]{0,40}$/;

/* The recipe that actually produced the outputs: walk back from the last saved
   .blend through each step's input, then add the non-saving steps (render_front,
   face_landmarks, export, validate, preview) that ran on a chain .blend between
   the step that made it and the step that consumed it (or after the last one).
   Superseded branches (--from) drop out. */
export function lineage(steps) {
  const ok = steps.filter((s) => s.ok);
  const last = [...ok].reverse().find((s) => s.output);
  if (!last) return [];
  const chain = [];
  for (let cur = last; cur; cur = cur.input ? ok.find((s) => s.output === cur.input) : null) chain.unshift(cur);
  const window = new Map(chain.map((c, i) => [c.output, [c.n, chain[i + 1] ? chain[i + 1].n : Infinity]]));
  const side = ok.filter((s) => !s.output && window.has(s.input) && s.n > window.get(s.input)[0] && s.n < window.get(s.input)[1]);
  // a side step re-run on the same .blend (e.g. export after a fix) supersedes the earlier run
  const latest = new Map(side.map((s) => [`${s.input}|${s.step}`, s]));
  return [...chain, ...latest.values()].sort((a, b) => a.n - b.n);
}
