/**
 * WORKERS — the engine port of the group-jobs plan (KB design-notes-id §4,
 * ticket). A worker is a short-lived, NON-interactive agent run:
 *
 *   claude -p --model X [--effort Y] --output-format json   (prompt on stdin)
 *   gemini -m X --approval-mode yolo --output-format json --prompt "<prompt>"
 *
 * The group-jobs TOOL asks for one over HTTP (the design notes); the engine runs
 * it, enforces the caps, and answers a parsed result. The tool never execs a
 * vendor CLI and neither does this module: a worker is a DESCRIPTOR spawned in
 * the vendor account's pty-broker (claude -> link `homebase`, svc-ops; gemini ->
 * link `gemini`, gem-ops), the same broker spawn path every pane uses.
 *
 * WHAT A WORKER IS NOT. It is not a session: no table row, no recipe, no seat,
 * no presence, no activity ring, no screen model. The manager, rooms and the
 * boot adopter only ever see what has a table row, so a worker is invisible to
 * all of them by construction; nothing is hidden with a flag. Its sid is
 * `wk-<hex>`, which is how a human reading a broker's list can tell. An engine
 * restart loses track of a running worker (state is in memory); the process
 * still dies on its own because `timeout` wraps it (the wall-clock cap does not
 * depend on the engine being alive).
 *
 * THE PROMPT NEVER TOUCHES A SHELL'S PARSER. It is written to a file in the
 * workers dir (mode 0640, group `agents`, which both svc-ops and gem-ops
 * are in), and the vendor CLI is launched by a CONSTANT bash script that takes
 * every value as a positional argument:
 *   claude:  exec "$@" < "$f"                          (stdin: no size limit)
 *   gemini:  exec "$@" --prompt "$(cat -- "$f")" < /dev/null
 * Nothing the caller sends is interpolated into script text. Gemini takes the
 * prompt as one argv string (`-p/--prompt` is its documented headless door), so
 * its prompt is capped under Linux's 128 KiB per-argument limit. The file is
 * deleted when the worker ends. bash is `-lic` for the same reason as every
 * broker-resident launch: the vendor binary is on the account's PATH only in an
 * interactive login shell (2026-07-07 discovery).
 *
 * CAPS ARE ENFORCED, NOT ALERTED: the dispatch kill switch refuses a launch;
 * per-day jobs per project and concurrent workers are counted here (in memory:
 * an engine restart resets the day's count, stated rather than hidden); wall
 * clock is `timeout` in the command plus an engine backstop; captured output is
 * bounded and the worker is killed when it goes over.
 */
import { chownSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CliDescriptor } from './cli-host.ts';
import { isRecipeEffort } from './effort.ts';
import { dataDir, instancePath } from './data-dir.ts';
import { autoApproveDefault } from './auto-approve.ts';

/* ------------------------------------------------------------ vocabulary -- */

export const WORKER_VENDORS = ['claude-code', 'gemini-cli'] as const;
export type WorkerVendor = (typeof WORKER_VENDORS)[number];

/** Which broker link runs each vendor — the link IS the account. */
export const VENDOR_LINK: Record<WorkerVendor, string> = { 'claude-code': 'homebase', 'gemini-cli': 'gemini' };

export type WorkerStatus = 'done' | 'capped' | 'failed' | 'could_not_tell';

export interface WorkerSpec {
  jobId: string;
  vendor: WorkerVendor;
  model: string;
  params: { effort?: string };
  cwd: string;
  prompt: string;
  budget: { maxSeconds: number; maxOutputBytes: number };
}

export interface WorkerUsage {
  inTokens?: number;
  outTokens?: number;
  seconds: number;
  costUsd?: number;
}

export interface WorkerResult {
  status: WorkerStatus;
  text: string;
  usage: WorkerUsage;
  stopReason: string;
  exitCode: number | null;
}

/* ------------------------------------------------------------ validation -- */

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // never starts with '-': it is an argv value
const JOB_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const LIMITS = Object.freeze({
  defaultSeconds: 600,
  maxSeconds: 3600,
  defaultOutputBytes: 256 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  maxPromptBytes: 1024 * 1024,
  /** Linux MAX_ARG_STRLEN is 131072; the gemini prompt rides one argv string. */
  maxGeminiPromptBytes: 120_000,
});

export class WorkerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
  body(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

const bad = (field: string, message: string) => new WorkerError(400, 'invalid', message, { field });

/** Validate a POST body into a spec. Throws WorkerError(400) naming the field. */
export function validateSpec(b: unknown): WorkerSpec {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw bad('body', 'the body is a JSON object');
  }
  const o = b as Record<string, any>;
  if (typeof o.jobId !== 'string' || !JOB_RE.test(o.jobId)) {
    throw bad('jobId', 'jobId is required: letters, digits and ._:- (max 128)');
  }
  if (!(WORKER_VENDORS as readonly string[]).includes(o.vendor)) {
    throw bad('vendor', `vendor must be one of ${WORKER_VENDORS.join(', ')}`);
  }
  const vendor = o.vendor as WorkerVendor;
  if (typeof o.model !== 'string' || !o.model) {
    throw bad('model', 'model is required and passed explicitly — a worker never runs on the CLI default');
  }
  if (!MODEL_RE.test(o.model)) {
    throw bad('model', 'model: letters, digits and ._- (max 64), not starting with -');
  }
  if (/fable/i.test(o.model)) {
    throw bad('model', 'Fable is attended-only (ticket) and never runs as an unattended worker');
  }
  const params = o.params ?? {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw bad('params', 'params is an object');
  }
  let effort: string | undefined;
  if (params.effort !== undefined && params.effort !== null) {
    if (vendor !== 'claude-code') {
      throw bad('params.effort', `${vendor} has no effort setting`);
    }
    if (!isRecipeEffort(params.effort)) {
      throw bad('params.effort', 'effort must be low, medium, high, xhigh or max');
    }
    if (params.effort === 'ultracode') {
      // ultracode orchestrates workflows of its own; a worker never starts workers (depth 1).
      throw bad('params.effort', 'ultracode starts sub-work; workers are depth 1');
    }
    effort = params.effort;
  }
  if (typeof o.cwd !== 'string' || !o.cwd.startsWith('/')) {
    throw bad('cwd', 'cwd is required: an absolute path on the server');
  }
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) {
    throw bad('prompt', 'prompt is required');
  }
  const promptBytes = Buffer.byteLength(o.prompt);
  const promptMax = vendor === 'gemini-cli' ? LIMITS.maxGeminiPromptBytes : LIMITS.maxPromptBytes;
  if (promptBytes > promptMax) {
    throw bad('prompt', `prompt is ${promptBytes} bytes; ${vendor} takes at most ${promptMax}`);
  }
  const budget = o.budget ?? {};
  const num = (v: unknown, dflt: number, max: number, field: string): number => {
    if (v === undefined || v === null) {
      return dflt;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw bad(field, `${field} is a positive number`);
    }
    return Math.min(Math.floor(v), max) || 1;
  };
  return {
    jobId: o.jobId,
    vendor,
    model: o.model,
    params: effort ? { effort } : {},
    cwd: o.cwd,
    prompt: o.prompt,
    budget: {
      maxSeconds: num(budget.maxSeconds, LIMITS.defaultSeconds, LIMITS.maxSeconds, 'budget.maxSeconds'),
      maxOutputBytes: num(budget.maxOutputBytes, LIMITS.defaultOutputBytes, LIMITS.maxOutputBytes, 'budget.maxOutputBytes'),
    },
  };
}

/* ------------------------------------------------------------ descriptor -- */

/** The constant scripts. `$1` is the prompt file; the rest of argv is the command. */
export const RUN_SCRIPT: Record<WorkerVendor, string> = {
  'claude-code': 'f=$1; shift; exec "$@" < "$f"',
  'gemini-cli': 'f=$1; shift; exec "$@" --prompt "$(cat -- "$f")" < /dev/null',
};
/** `timeout -k` grace: SIGTERM at maxSeconds, SIGKILL this much later. */
const KILL_AFTER_S = 10;

export function vendorArgv(spec: WorkerSpec, bin: string): string[] {
  if (spec.vendor === 'claude-code') {
    return [
      bin,
      '-p',
      '--model',
      spec.model,
      ...(spec.params.effort ? ['--effort', spec.params.effort] : []),
      '--output-format',
      'json',
      // No transcript in the project dir: a worker must never look like a
      // session the adoption sweep could claim (2026-09-18 hottest-transcript trap).
      '--no-session-persistence',
      // No MCP servers: a worker cannot message the fabric, so nothing it says
      // can trigger a dispatch (plan §4 origin:dispatched) or reach a room.
      '--strict-mcp-config',
    ];
  }
  /* a headless worker has no recipe: it auto-approves only when the engine's first-run default is ON */
  return [bin, '-m', spec.model, ...(autoApproveDefault() === 'on' ? ['--approval-mode', 'yolo'] : []), '--output-format', 'json'];
}

export function buildDescriptor(
  spec: WorkerSpec,
  workerId: string,
  promptFile: string,
  bins: Record<WorkerVendor, string>,
): CliDescriptor {
  return {
    binary: 'bash',
    args: [
      '-lic',
      RUN_SCRIPT[spec.vendor],
      'worker',
      promptFile,
      'timeout',
      '-k',
      String(KILL_AFTER_S),
      String(spec.budget.maxSeconds),
      ...vendorArgv(spec, bins[spec.vendor]),
    ],
    cwd: spec.cwd,
    env: {
      HARBOR_WB_WORKER: workerId,
      HARBOR_WB_JOB: spec.jobId,
      HARBOR_WB_VENDOR: spec.vendor,
      HARBOR_WB_ORIGIN: 'dispatched',
    },
  };
}

/* --------------------------------------------------------------- parsing -- */

/** Drop terminal control sequences (CSI, OSC, two-byte ESC) and carriage
 *  returns from pty output. A char loop, not a regex: no escapes in source. */
export function stripTerminal(s: string): string {
  const ESC = 27;
  const BEL = 7;
  const CR = 13;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === CR) {
      i++;
      continue;
    }
    if (c !== ESC) {
      out += s[i++];
      continue;
    }
    const n = s[i + 1];
    if (n === '[') {
      i += 2;
      while (i < s.length) {
        const k = s.charCodeAt(i++);
        if (k >= 0x40 && k <= 0x7e) {
          break;
        }
      }
    } else if (n === ']') {
      i += 2;
      while (i < s.length) {
        const k = s.charCodeAt(i);
        if (k === BEL) {
          i++;
          break;
        }
        if (k === ESC) {
          i += 2;
          break;
        }
        i++;
      }
    } else {
      i += 2;
    }
  }
  return out;
}

/** The result object a CLI printed: the LAST column-0 `{` that parses to the
 *  end of the output (trailing whitespace allowed). Claude prints one line;
 *  gemini pretty-prints, and its inner braces are indented, so only the outer
 *  object starts at column 0. Bounded attempts, newest first. */
export function extractJson(raw: string): Record<string, any> | null {
  const text = stripTerminal(raw).trimEnd();
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && (i === 0 || text.charCodeAt(i - 1) === 10)) {
      starts.push(i);
    }
  }
  for (let k = starts.length - 1, tries = 0; k >= 0 && tries < 50; k--, tries++) {
    const cand = text.slice(starts[k]);
    const end = cand.lastIndexOf('}');
    try {
      const v = JSON.parse(cand.slice(0, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return v;
      }
    } catch {
      /* next candidate */
    }
  }
  return null;
}

const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** claude -p --output-format json (verified on 2.1.285): {type:'result',
 *  subtype, is_error, result, stop_reason, terminal_reason, usage{input_tokens,
 *  cache_creation_input_tokens, cache_read_input_tokens, output_tokens},
 *  total_cost_usd, api_error_status}. */
export function parseClaude(j: Record<string, any>, seconds: number): Omit<WorkerResult, 'exitCode'> {
  const u = j.usage ?? {};
  const inTokens = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens]
    .map(n)
    .filter((x): x is number => x !== undefined);
  const usage: WorkerUsage = {
    ...(inTokens.length ? { inTokens: inTokens.reduce((a, b) => a + b, 0) } : {}),
    ...(n(u.output_tokens) !== undefined ? { outTokens: n(u.output_tokens) } : {}),
    seconds,
    ...(n(j.total_cost_usd) !== undefined ? { costUsd: n(j.total_cost_usd) } : {}),
  };
  const text = typeof j.result === 'string' ? j.result : '';
  if (j.is_error === false && (j.subtype === 'success' || j.subtype === undefined)) {
    return { status: 'done', text, usage, stopReason: String(j.stop_reason ?? j.terminal_reason ?? 'end_turn') };
  }
  if (j.api_error_status === 429) {
    return { status: 'failed', text, usage, stopReason: 'rate_limited' };
  }
  if (j.subtype === 'error_max_budget_usd' || j.subtype === 'error_max_turns') {
    return { status: 'capped', text, usage, stopReason: String(j.subtype) };
  }
  if (j.is_error === true || typeof j.subtype === 'string') {
    return { status: 'failed', text, usage, stopReason: String(j.subtype ?? j.terminal_reason ?? 'error') };
  }
  return { status: 'could_not_tell', text, usage, stopReason: 'unrecognised_result' };
}

/** Quota/billing EXHAUSTION (prepaid balance gone; plan update 2026-09-30) vs a
 *  per-minute RATE LIMIT. Google answers both as 429 RESOURCE_EXHAUSTED, so
 *  the message decides; per-minute wording wins because it is the specific one.
 *  UNVERIFIED against a real empty balance — the wording is Google's documented
 *  quota text; recorded fixtures replace the guess once one is seen. */
export function classifyGeminiError(err: { type?: unknown; message?: unknown; code?: unknown }): 'rate_limited' | 'credit_exhausted' | null {
  const msg = `${err.type ?? ''} ${err.message ?? ''}`;
  if (/per.?minute|perminute/i.test(msg)) {
    return 'rate_limited';
  }
  // Before the generic rate-limit words: Google's quota text links its
  // ".../rate-limits" doc page even when the cause is billing.
  if (/billing|credit|prepa(y|id)|balance|payment|depleted|insufficient.?funds|exceeded your current quota/i.test(msg)) {
    return 'credit_exhausted';
  }
  if (String(err.code) === '429' || /rate.?limit|too many requests|resource.?exhausted/i.test(msg)) {
    return 'rate_limited';
  }
  return null;
}

/** gemini --output-format json (upstream packages/core/src/output/types.ts):
 *  {session_id?, response?, stats?:{models:{[m]:{tokens:{prompt, candidates,
 *  thoughts, total, cached, tool}}}}, error?:{type, message, code?}}. */
export function parseGemini(j: Record<string, any>, seconds: number): Omit<WorkerResult, 'exitCode'> {
  let inT: number | undefined;
  let outT: number | undefined;
  const models = j.stats?.models;
  if (models && typeof models === 'object') {
    for (const m of Object.values(models) as any[]) {
      const t = m?.tokens ?? {};
      if (n(t.prompt) !== undefined) {
        inT = (inT ?? 0) + t.prompt;
      }
      const out = (n(t.candidates) ?? 0) + (n(t.thoughts) ?? 0);
      if (n(t.candidates) !== undefined || n(t.thoughts) !== undefined) {
        outT = (outT ?? 0) + out;
      }
    }
  }
  const usage: WorkerUsage = {
    ...(inT !== undefined ? { inTokens: inT } : {}),
    ...(outT !== undefined ? { outTokens: outT } : {}),
    seconds,
  };
  const text = typeof j.response === 'string' ? j.response : '';
  if (j.error && typeof j.error === 'object') {
    const kind = classifyGeminiError(j.error);
    if (kind === 'credit_exhausted') {
      return { status: 'capped', text, usage, stopReason: 'credit_exhausted' };
    }
    return { status: 'failed', text, usage, stopReason: kind ?? String(j.error.type ?? 'error') };
  }
  if (typeof j.response === 'string') {
    return { status: 'done', text, usage, stopReason: 'completed' };
  }
  return { status: 'could_not_tell', text, usage, stopReason: 'unrecognised_result' };
}

/** Everything the exit knows -> one result. Order: an engine-side cap first
 *  (it explains a broken JSON), then the CLI's own JSON, then the exit code. */
export function finalize(
  vendor: WorkerVendor,
  raw: string,
  info: { exitCode: number | null; seconds: number; truncated: boolean; maxOutputBytes: number; stopped?: boolean; lost?: boolean },
): WorkerResult {
  const j = extractJson(raw);
  const parsed = j ? (vendor === 'claude-code' ? parseClaude(j, info.seconds) : parseGemini(j, info.seconds)) : null;
  const cap = (s: string) => (Buffer.byteLength(s) > info.maxOutputBytes ? Buffer.from(s).subarray(0, info.maxOutputBytes).toString() : s);
  const fallbackText = cap(stripTerminal(raw).trim());
  const base = { exitCode: info.exitCode, usage: parsed?.usage ?? { seconds: info.seconds } };
  if (info.stopped) {
    return { ...base, status: 'failed', text: cap(parsed?.text ?? fallbackText), stopReason: 'stopped' };
  }
  if (info.lost) {
    return { ...base, status: 'could_not_tell', text: cap(parsed?.text ?? fallbackText), stopReason: 'lost' };
  }
  if (info.truncated) {
    return { ...base, status: 'capped', text: cap(parsed?.text ?? fallbackText), stopReason: 'output_cap' };
  }
  if (info.exitCode === 124 || info.exitCode === 137) {
    return { ...base, status: 'capped', text: cap(parsed?.text ?? fallbackText), stopReason: 'wall_clock' };
  }
  if (parsed) {
    return { ...parsed, text: cap(parsed.text), exitCode: info.exitCode };
  }
  if (info.exitCode === 0) {
    return { ...base, status: 'could_not_tell', text: fallbackText, stopReason: 'no_json' };
  }
  return { ...base, status: 'failed', text: fallbackText, stopReason: `exit:${info.exitCode ?? 'unknown'}` };
}

/* ----------------------------------------------------------- the manager -- */

/** The slice of a broker session a worker needs (a CliSession's pty). */
export interface WorkerProc {
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number }) => void): unknown;
  kill(): void;
}

export interface WorkerDeps {
  /** Spawn a descriptor in the named broker link. Rejects when the link is unknown or down. */
  spawn(link: string, sid: string, desc: CliDescriptor): Promise<WorkerProc>;
  killSwitchPath: string;
  dir: string;
  /** Group the prompt file is shared with (gem-ops must read it). */
  group: string;
  bins: Record<WorkerVendor, string>;
  jobsPerProjectPerDay: number;
  maxConcurrent: number;
  maxConcurrentGemini: number;
  /** Engine backstop beyond `timeout`: finalize as `lost` if no exit arrived. */
  backstopGraceMs: number;
  now(): number;
  log(msg: string): void;
}

interface WorkerRec {
  id: string;
  spec: WorkerSpec;
  state: 'running' | 'exited';
  startedAt: number;
  endedAt: number | null;
  out: string;
  outBytes: number;
  truncated: boolean;
  result: WorkerResult | null;
  proc: WorkerProc | null;
  promptFile: string;
  timer: NodeJS.Timeout | null;
}

const RETAIN_MS = 60 * 60 * 1000;
const RETAIN_MAX = 500;
const TAIL_BYTES = 2048;

function gidOf(group: string): number | null {
  try {
    for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
      const [name, , gid] = line.split(':');
      if (name === group) {
        return Number(gid);
      }
    }
  } catch {
    /* not a unix host */
  }
  return null;
}

export function createWorkers(deps: WorkerDeps) {
  const recs = new Map<string, WorkerRec>();
  /** `${project}|${utc day}` -> job ids that have launched a worker that day. */
  const jobsByDay = new Map<string, Set<string>>();

  function prune(): void {
    const cutoff = deps.now() - RETAIN_MS;
    for (const [id, r] of recs) {
      if (r.state === 'exited' && (r.endedAt ?? 0) < cutoff) {
        recs.delete(id);
      }
    }
    const done = [...recs.values()].filter((r) => r.state === 'exited');
    for (let i = 0; recs.size > RETAIN_MAX && i < done.length; i++) {
      recs.delete(done[i].id);
    }
    const today = new Date(deps.now()).toISOString().slice(0, 10);
    for (const k of jobsByDay.keys()) {
      if (!k.endsWith(`|${today}`)) {
        jobsByDay.delete(k);
      }
    }
  }

  /** The workers dir: ours, a real directory, group-shared, setgid. Refuses a
   *  path someone else planted (a shared /tmp is the default). */
  function ensureDir(vendor: WorkerVendor): void {
    let st;
    try {
      if (!existsSync(deps.dir)) {
        mkdirSync(deps.dir, { recursive: true, mode: 0o2750 });
      }
      st = lstatSync(deps.dir);
    } catch (err) {
      throw new WorkerError(503, 'workers-dir', `workers dir ${deps.dir}: ${(err as Error).message}`);
    }
    if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      throw new WorkerError(503, 'workers-dir', `workers dir ${deps.dir} is not a directory owned by this engine's account`);
    }
    const gid = gidOf(deps.group);
    try {
      if (gid !== null && st.gid !== gid) {
        chownSync(deps.dir, -1, gid);
        st = lstatSync(deps.dir);
      }
      chmodSync(deps.dir, 0o2750);
    } catch (err) {
      deps.log(`workers dir ${deps.dir}: could not share it with group '${deps.group}' (${(err as Error).message})`);
    }
    /* gemini runs as gem-ops and reads the prompt through the GROUP bit.
       Refuse up front rather than start a worker that cannot read its prompt. */
    if (vendor === 'gemini-cli' && process.platform !== 'win32' && (gid === null || st.gid !== gid)) {
      throw new WorkerError(503, 'workers-dir', `workers dir ${deps.dir} is not group '${deps.group}', so the gemini account could not read the prompt`);
    }
  }

  function view(r: WorkerRec, full = true) {
    const tail = stripTerminal(r.out.slice(-TAIL_BYTES * 2)).slice(-TAIL_BYTES);
    return {
      id: r.id,
      jobId: r.spec.jobId,
      vendor: r.spec.vendor,
      model: r.spec.model,
      params: r.spec.params,
      budget: r.spec.budget,
      state: r.state,
      startedAt: new Date(r.startedAt).toISOString(),
      endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : null,
      outputBytes: r.outBytes,
      truncated: r.truncated,
      ...(full ? { stdoutTail: tail } : {}),
      result: r.result,
    };
  }

  function end(r: WorkerRec, info: { exitCode: number | null; stopped?: boolean; lost?: boolean }): void {
    if (r.state === 'exited') {
      return;
    }
    r.state = 'exited';
    r.endedAt = deps.now();
    if (r.timer) {
      clearTimeout(r.timer);
      r.timer = null;
    }
    const seconds = Math.round((r.endedAt - r.startedAt) / 100) / 10;
    r.result = finalize(r.spec.vendor, r.out, {
      exitCode: info.exitCode,
      seconds,
      truncated: r.truncated,
      maxOutputBytes: r.spec.budget.maxOutputBytes,
      stopped: info.stopped,
      lost: info.lost,
    });
    r.proc = null;
    try {
      rmSync(r.promptFile, { force: true });
    } catch {
      /* a leftover prompt file is tidied by tmp cleaning; never fatal */
    }
    deps.log(`worker ${r.id} (${r.spec.vendor}/${r.spec.model}, job ${r.spec.jobId}) ${r.result.status}: ${r.result.stopReason} in ${seconds}s, ${r.outBytes}B`);
  }

  async function launch(body: unknown): Promise<ReturnType<typeof view>> {
    const spec = validateSpec(body);
    if (existsSync(deps.killSwitchPath)) {
      throw new WorkerError(503, 'dispatch-blocked', `the dispatch kill switch is set (${deps.killSwitchPath}); no worker launches until it is cleared`);
    }
    prune();
    const running = [...recs.values()].filter((r) => r.state === 'running');
    if (running.length >= deps.maxConcurrent) {
      throw new WorkerError(429, 'cap', `${running.length} workers are running; the cap is ${deps.maxConcurrent}`, {
        cap: 'concurrent',
        limit: deps.maxConcurrent,
        current: running.length,
      });
    }
    const gem = running.filter((r) => r.spec.vendor === 'gemini-cli').length;
    if (spec.vendor === 'gemini-cli' && gem >= deps.maxConcurrentGemini) {
      throw new WorkerError(429, 'cap', `gemini workers run ${deps.maxConcurrentGemini} at a time (rate-limited account)`, {
        cap: 'concurrent-gemini',
        limit: deps.maxConcurrentGemini,
        current: gem,
      });
    }
    const dayKey = `${spec.cwd}|${new Date(deps.now()).toISOString().slice(0, 10)}`;
    const jobs = jobsByDay.get(dayKey) ?? new Set<string>();
    if (!jobs.has(spec.jobId) && jobs.size >= deps.jobsPerProjectPerDay) {
      throw new WorkerError(429, 'cap', `${jobs.size} jobs already ran in ${spec.cwd} today (UTC); the cap is ${deps.jobsPerProjectPerDay}`, {
        cap: 'jobs-per-day',
        limit: deps.jobsPerProjectPerDay,
        current: jobs.size,
      });
    }
    ensureDir(spec.vendor);
    const id = `wk-${randomBytes(6).toString('hex')}`;
    const promptFile = join(deps.dir, `${id}.prompt`);
    writeFileSync(promptFile, spec.prompt, { mode: 0o640 });
    const r: WorkerRec = {
      id,
      spec,
      state: 'running',
      startedAt: deps.now(),
      endedAt: null,
      out: '',
      outBytes: 0,
      truncated: false,
      result: null,
      proc: null,
      promptFile,
      timer: null,
    };
    let proc: WorkerProc;
    try {
      proc = await deps.spawn(VENDOR_LINK[spec.vendor], id, buildDescriptor(spec, id, promptFile, deps.bins));
    } catch (err) {
      rmSync(promptFile, { force: true });
      throw new WorkerError(503, 'broker', `could not start the worker in broker '${VENDOR_LINK[spec.vendor]}': ${(err as Error).message}`);
    }
    jobs.add(spec.jobId);
    jobsByDay.set(dayKey, jobs);
    r.proc = proc;
    recs.set(id, r);
    proc.onData((d: string) => {
      if (r.state !== 'running' || r.truncated) {
        return;
      }
      const bytes = Buffer.byteLength(d);
      if (r.outBytes + bytes > spec.budget.maxOutputBytes) {
        const room = Math.max(0, spec.budget.maxOutputBytes - r.outBytes);
        r.out += Buffer.from(d).subarray(0, room).toString();
        r.outBytes += room;
        r.truncated = true;
        proc.kill(); // never unbounded: over the cap, the worker stops
        return;
      }
      r.out += d;
      r.outBytes += bytes;
    });
    proc.onExit((e) => end(r, { exitCode: e.exitCode }));
    r.timer = setTimeout(() => {
      proc.kill();
      end(r, { exitCode: null, lost: true });
    }, spec.budget.maxSeconds * 1000 + deps.backstopGraceMs);
    r.timer.unref?.();
    deps.log(`worker ${id} launched: job ${spec.jobId}, ${spec.vendor}/${spec.model}${spec.params.effort ? ` effort ${spec.params.effort}` : ''}, ${spec.budget.maxSeconds}s, ${spec.budget.maxOutputBytes}B, in ${spec.cwd}`);
    return view(r);
  }

  function status(id: string) {
    const r = recs.get(id);
    return r ? view(r) : null;
  }

  function stop(id: string) {
    const r = recs.get(id);
    if (!r) {
      return null;
    }
    if (r.state === 'running') {
      r.proc?.kill();
      end(r, { exitCode: null, stopped: true });
    }
    return view(r);
  }

  function list(jobId?: string) {
    prune();
    return [...recs.values()].filter((r) => !jobId || r.spec.jobId === jobId).map((r) => view(r, false));
  }

  return { launch, status, stop, list };
}

export type Workers = ReturnType<typeof createWorkers>;

/** Env-driven deps for the real engine. */
export function envConfig(env: NodeJS.ProcessEnv = process.env) {
  const int = (v: string | undefined, d: number) => (v && /^[0-9]+$/.test(v) ? Number(v) : d);
  return {
    killSwitchPath: env.HARBOR_WB_DISPATCH_BLOCKED || join(dataDir() ?? '/tmp/harbor-wb', 'state', 'dispatch-blocked'),
    dir: env.HARBOR_WB_WORKERS_DIR || (dataDir() ? instancePath('workers') : '/tmp/harbor-wb-workers'),
    group: env.HARBOR_WB_WORKERS_GROUP || 'agents',
    bins: {
      'claude-code': env.HARBOR_WB_WORKER_BIN_CLAUDE || 'claude',
      'gemini-cli': env.HARBOR_WB_WORKER_BIN_GEMINI || 'gemini',
    } as Record<WorkerVendor, string>,
    jobsPerProjectPerDay: int(env.HARBOR_WB_WORKER_JOBS_PER_DAY, 3),
    maxConcurrent: int(env.HARBOR_WB_WORKER_MAX_CONCURRENT, 3),
    maxConcurrentGemini: int(env.HARBOR_WB_WORKER_MAX_CONCURRENT_GEMINI, 1),
    backstopGraceMs: int(env.HARBOR_WB_WORKER_BACKSTOP_MS, 30_000),
  };
}
