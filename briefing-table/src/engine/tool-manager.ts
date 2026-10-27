/* ============================================================================
 * THE TOOL MANAGER [tool-manager] (Owner [ref]/[ref]; the design notes): agents ask the ENGINE to start, stop or restart a
 * registered tool app, the engine starts the autostart ones after boot, and a monitor keeps the ones that should be up, up.
 *
 *   MANIFEST  = the pinned tool.json's `autostart` (a human approves a change, like every pinned field): what a REBOOT starts.
 *   INTENT    = `up`/`down` per tool, set by start/stop/restart, stamped with the kernel boot id. The same boot id means an
 *               engine restart (a tool someone stopped stays stopped); a different one means a reboot (the manifest wins).
 *   MONITOR   = every 30 s: intent up + the app is certainly down -> start it, with backoff, then `failed` (never a loop).
 *               `unknown` (could not tell) is never touched; a deliberate `stop` is never a crash.
 *
 * This amends the design notes §4.4 ("the engine never executes tool scripts"), at Owner's direction, with the
 * control that sentence was protecting: tool CODE is writable by the agents group (R-apps-code), so the engine runs ONLY a
 * lifecycle script whose digest a HUMAN pinned (POST /api/apps/:slug/pin-scripts). A changed or unpinned script is never run.
 * The scripts are the tool's own idempotent start.sh/stop.sh (they detach with setsid); the engine hands them nothing.
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { table, RoomError } from '../table/endpoint.ts';
import * as apps from './apps.ts';

let log: (line: string) => void = (line) => console.log(`[tool-manager] ${line}`);
export function setLog(fn: (line: string) => void): void {
  log = fn;
}

const SCRIPT_TIMEOUT_MS = 30_000;
const OUT_MAX = 2000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const FAILED_AFTER = 5;

/** The monitor's period, a GLOBAL engine setting (Owner [ref]): default 60 s, 15 s to 1 h. Read before every pass, so a change applies at once. */
export const MONITOR_DEFAULT_SEC = 60;
export const MONITOR_MIN_SEC = 15;
export const MONITOR_MAX_SEC = 3600;
export function monitorSettings(): { intervalSec: number } {
  const v = (table.getEngineSetting('toolMonitor') as { intervalSec?: unknown } | null | undefined)?.intervalSec;
  return { intervalSec: typeof v === 'number' && Number.isInteger(v) && v >= MONITOR_MIN_SEC && v <= MONITOR_MAX_SEC ? v : MONITOR_DEFAULT_SEC };
}
export function setMonitorSettings(body: Record<string, unknown>): { intervalSec: number } {
  const v = body.intervalSec;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < MONITOR_MIN_SEC || v > MONITOR_MAX_SEC) {
    throw new RoomError(400, `intervalSec is whole seconds from ${MONITOR_MIN_SEC} to ${MONITOR_MAX_SEC} (default ${MONITOR_DEFAULT_SEC})`, 'intervalSec');
  }
  table.setEngineSetting('toolMonitor', { intervalSec: v });
  log(`monitor period now ${v}s`);
  return { intervalSec: v };
}

/* ----------------------------------------------------------- injectables ---- */

export type RunResult = { code: number | null; out: string };
export type Runner = (script: string, cwd: string) => Promise<RunResult>;

const defaultRunner: Runner = (script, cwd) =>
  new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r: RunResult): void => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    /* a minimal environment: the engine's own bearer and tokens never reach a tool's script */
    const child = spawn(script, [], { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const add = (d: Buffer): void => {
      if (out.length < OUT_MAX) out += d.toString('utf8');
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ code: null, out: `${out.slice(0, OUT_MAX)}\n(timed out after ${SCRIPT_TIMEOUT_MS / 1000}s)` });
    }, SCRIPT_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ code: null, out: `could not run: ${e.message}` });
    });
    /* 'exit', not 'close': a detached app that kept a pipe open must not hold the answer */
    child.on('exit', (code) => {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code, out: out.slice(0, OUT_MAX).trim() });
    });
  });

let runner: Runner = defaultRunner;
export function setRunner(r: Runner | null): void {
  runner = r ?? defaultRunner;
}

function readBootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return 'unknown-boot'; // off Linux every start looks like one boot: intent always survives, autostart still applies at first tick
  }
}
let bootIdFn: () => string = readBootId;
export function setBootId(fn: (() => string) | null): void {
  bootIdFn = fn ?? readBootId;
}

/* --------------------------------------------------------------- scripts ---- */

type Script = { rel: string; path: string; sha: string };

/** One lifecycle script: a plain file (never a symlink) inside the tool root. */
function resolveScript(root: string, rel: unknown, what: string): { ok: true; script: Script } | { ok: false; why: string } {
  if (typeof rel !== 'string' || !rel.trim() || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    return { ok: false, why: `lifecycle.${what} is not a relative path inside the tool` };
  }
  const path = join(root, rel);
  try {
    if (!lstatSync(path).isFile()) {
      return { ok: false, why: `lifecycle.${what} (${rel}) is not a plain file` };
    }
    const inside = relative(realpathSync(root), realpathSync(path));
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return { ok: false, why: `lifecycle.${what} (${rel}) resolves outside the tool` };
    }
    return { ok: true, script: { rel, path, sha: createHash('sha256').update(readFileSync(path)).digest('hex') } };
  } catch {
    return { ok: false, why: `lifecycle.${what} (${rel}) cannot be read` };
  }
}

interface Lifecycle {
  entry: Script;
  stop: Script | null;
  digest: string;
}

function lifecycleOf(root: string, parsed: any): { ok: true; lc: Lifecycle } | { ok: false; why: string } {
  const e = resolveScript(root, parsed?.lifecycle?.entry, 'entry');
  if (!e.ok) {
    return e;
  }
  let stop: Script | null = null;
  if (parsed?.lifecycle?.stop !== undefined && parsed.lifecycle.stop !== null) {
    const s = resolveScript(root, parsed.lifecycle.stop, 'stop');
    if (!s.ok) {
      return s;
    }
    stop = s.script;
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ entry: [e.script.rel, e.script.sha], stop: stop ? [stop.rel, stop.sha] : null }))
    .digest('hex');
  return { ok: true, lc: { entry: e.script, stop, digest } };
}

/* ----------------------------------------------------------------- state ---- */

interface Mem {
  fails: number;
  nextAt: number;
  failed: boolean;
  last: { verb: string; by: string; at: number; code: number | null; out: string } | null;
  chain: Promise<unknown>;
}
const mem = new Map<string, Mem>();
function memOf(slug: string): Mem {
  let m = mem.get(slug);
  if (!m) {
    m = { fails: 0, nextAt: 0, failed: false, last: null, chain: Promise.resolve() };
    mem.set(slug, m);
  }
  return m;
}
/** one action at a time per tool: the monitor and a caller never run its scripts together */
function serial<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const m = memOf(slug);
  const run = m.chain.then(fn, fn);
  m.chain = run.catch(() => undefined);
  return run;
}

export type Intent = 'up' | 'down' | 'none';
export function effectiveIntent(slug: string, parsed: any): Intent {
  const row = table.getToolManage(slug);
  if (row?.intent && row.boot_id === bootIdFn()) {
    return row.intent;
  }
  return parsed?.autostart === true ? 'up' : 'none';
}

/* --------------------------------------------------------------- actions ---- */

export type Verb = 'start' | 'stop' | 'restart';
export interface ManageResult {
  ok: boolean;
  slug: string;
  verb: Verb;
  intent: Intent;
  detail: string;
  code?: number | null;
}

type Ready = { reg: { slug: string; root: string }; parsed: any; lc: Lifecycle };
/** the pinned file, its scripts, and the human's script pin: everything that must hold before ANY script runs */
function ready(slug: string): { ok: true; r: Ready } | { ok: false; status: number; reason: string; detail: string } {
  const pin = apps.pinnedTool(slug);
  if (!pin.ok) {
    return { ok: false, status: pin.reason === 'no-such-app' ? 404 : 409, reason: pin.reason, detail: pin.reason === 'no-such-app' ? 'no such app' : `the app is ${pin.reason}; a person must approve or register it first` };
  }
  const l = lifecycleOf(pin.reg.root, pin.parsed);
  if (!l.ok) {
    return { ok: false, status: 409, reason: 'no-lifecycle', detail: l.why };
  }
  const pinned = table.getToolManage(slug)?.scripts_sha ?? null;
  if (!pinned) {
    return { ok: false, status: 409, reason: 'scripts-unpinned', detail: 'a person has not pinned this tool\'s start/stop scripts yet (POST /api/apps/:slug/pin-scripts)' };
  }
  if (pinned !== l.lc.digest) {
    return { ok: false, status: 409, reason: 'scripts-changed', detail: 'the start/stop scripts changed since a person pinned them; nothing was run' };
  }
  return { ok: true, r: { reg: pin.reg, parsed: pin.parsed, lc: l.lc } };
}

async function runScript(slug: string, verb: string, by: string, s: Script, root: string): Promise<RunResult> {
  /* L7: hash the file again right before it runs, so a script swapped after the pin check is not the one executed */
  let now = '';
  try {
    now = createHash('sha256').update(readFileSync(s.path)).digest('hex');
  } catch {
    /* unreadable: treated as changed */
  }
  const res: RunResult = now === s.sha ? await runner(s.path, root) : { code: 126, out: 'the script changed after it was checked; nothing was run' };
  const m = memOf(slug);
  m.last = { verb, by, at: Date.now(), code: res.code, out: res.out };
  log(`${slug}: ${verb} by ${by}: exit ${res.code}${res.out ? ` — ${res.out.split('\n').slice(-1)[0]}` : ''}`);
  return res;
}

export async function manage(slug: string, verb: Verb, by: string, reason: string | null): Promise<ManageResult> {
  const g = ready(slug);
  if (!g.ok) {
    throw new RoomError(g.status, `${g.detail} (${g.reason})`, 'slug');
  }
  const { reg, lc } = g.r;
  if ((verb === 'stop' || verb === 'restart') && !lc.stop) {
    throw new RoomError(409, 'the tool declares no lifecycle.stop script, so it cannot be stopped or restarted from here (no-stop-script)', 'slug');
  }
  return serial(slug, async () => {
    const m = memOf(slug);
    log(`${slug}: ${verb} asked by ${by}${reason ? ` (${reason})` : ''}`);
    if (verb === 'stop') {
      table.setToolIntent(slug, 'down', bootIdFn(), by, reason); // intent first: the monitor must never fight a stop
      const r = await runScript(slug, 'stop', by, lc.stop!, reg.root);
      return { ok: r.code === 0, slug, verb, intent: 'down' as Intent, detail: r.out || `exit ${r.code}`, code: r.code };
    }
    table.setToolIntent(slug, 'up', bootIdFn(), by, reason);
    m.fails = 0;
    m.nextAt = 0;
    m.failed = false;
    if (verb === 'restart') {
      const s = await runScript(slug, 'stop', by, lc.stop!, reg.root);
      if (s.code !== 0) {
        return { ok: false, slug, verb, intent: 'up' as Intent, detail: `stop failed: ${s.out || `exit ${s.code}`}`, code: s.code };
      }
    }
    const r = await runScript(slug, 'start', by, lc.entry, reg.root);
    return { ok: r.code === 0, slug, verb, intent: 'up' as Intent, detail: r.out || `exit ${r.code}`, code: r.code };
  });
}

/** A PERSON pins the scripts the engine may run (the digest of entry + stop, with their paths). */
export function pinScripts(slug: string, by: string): { slug: string; digest: string; entry: string; stop: string | null } {
  const pin = apps.pinnedTool(slug);
  if (!pin.ok) {
    throw new RoomError(pin.reason === 'no-such-app' ? 404 : 409, pin.reason === 'no-such-app' ? 'no such app' : `the app is ${pin.reason}: approve or register it first`, 'slug');
  }
  const l = lifecycleOf(pin.reg.root, pin.parsed);
  if (!l.ok) {
    throw new RoomError(400, l.why, 'slug');
  }
  table.setToolScripts(slug, l.lc.digest, by);
  log(`${slug}: lifecycle scripts pinned by ${by} (${l.lc.entry.rel}${l.lc.stop ? `, ${l.lc.stop.rel}` : ''})`);
  return { slug, digest: l.lc.digest, entry: l.lc.entry.rel, stop: l.lc.stop?.rel ?? null };
}

export interface ManageStatus {
  slug: string;
  autostart: boolean;
  intent: Intent;
  scripts: 'pinned' | 'unpinned' | 'changed' | 'unavailable';
  state: string;
  failed: boolean;
  fails: number;
  last: Mem['last'];
}
export async function statusOf(slug: string): Promise<ManageStatus> {
  const pin = apps.pinnedTool(slug);
  if (!pin.ok) {
    throw new RoomError(pin.reason === 'no-such-app' ? 404 : 409, pin.reason === 'no-such-app' ? 'no such app' : `the app is ${pin.reason}`, 'slug');
  }
  const l = lifecycleOf(pin.reg.root, pin.parsed);
  const pinned = table.getToolManage(slug)?.scripts_sha ?? null;
  const m = memOf(slug);
  return {
    slug,
    autostart: pin.parsed?.autostart === true,
    intent: effectiveIntent(slug, pin.parsed),
    scripts: !l.ok ? 'unavailable' : !pinned ? 'unpinned' : pinned === l.lc.digest ? 'pinned' : 'changed',
    state: (await apps.getCatalogEntry(slug))?.status ?? 'unknown',
    failed: m.failed,
    fails: m.fails,
    last: m.last,
  };
}

/* --------------------------------------------------------------- monitor ---- */

let ticking = false;
/** One pass: every tool that should be up and is CERTAINLY down gets one start attempt (subject to backoff). */
export async function tick(now: number = Date.now()): Promise<void> {
  if (ticking) {
    return;
  }
  ticking = true;
  try {
    for (const reg of table.listToolRegistry()) {
      if (reg.unregistered_at || reg.held) {
        continue;
      }
      try {
        const g = ready(reg.slug);
        if (!g.ok || effectiveIntent(reg.slug, g.r.parsed) !== 'up') {
          continue;
        }
        const m = memOf(reg.slug);
        if (m.failed || now < m.nextAt) {
          continue;
        }
        if ((await apps.getCatalogEntry(reg.slug))?.status !== 'down') {
          continue; // running, or could not tell: never touch what we cannot tell is dead
        }
        await serial(reg.slug, async () => {
          const r = await runScript(reg.slug, 'start', 'tool-manager', g.r.lc.entry, reg.root);
          if (r.code === 0) {
            m.fails = 0;
            return;
          }
          m.fails++;
          m.nextAt = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (m.fails - 1), BACKOFF_MAX_MS);
          if (m.fails >= FAILED_AFTER) {
            m.failed = true;
            log(`${reg.slug}: FAILED — ${m.fails} starts in a row did not come up; not retrying until a person starts it`);
          }
        });
      } catch (e) {
        log(`${reg.slug}: monitor error: ${(e as Error)?.message ?? e}`);
      }
    }
  } finally {
    ticking = false;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
/** First pass after the engine has had `firstDelayMs` to be healthy, then one pass per the global period (re-read each time). */
export function startLoop(firstDelayMs = 15_000): void {
  if (running) {
    return;
  }
  running = true;
  const next = (ms: number): void => {
    timer = setTimeout(() => {
      tick()
        .catch((e) => log(`tick failed: ${(e as Error)?.message ?? e}`))
        .finally(() => running && next(monitorSettings().intervalSec * 1000));
    }, ms);
    timer.unref?.();
  };
  next(firstDelayMs);
}
export function stopLoop(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
export function resetForTest(): void {
  mem.clear();
  ticking = false;
}
