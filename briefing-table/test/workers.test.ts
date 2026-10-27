/**
 * WORKERS unit suite (ticket, engine/workers.ts). Pure pieces + the manager
 * with an in-memory fake spawn: no broker, no engine, no vendor CLI.
 *
 * FIXTURES (test/fixtures/workers/):
 *  - claude-pty-success.txt RECORDED 2026-09-30 on the server: `claude -p --model
 *    haiku --effort low --output-format json --no-session-persistence
 *    --strict-mcp-config` under a pty (claude 2.1.285), prompt "Reply with
 *    exactly: pong". session_id/uuid zeroed. Raw pty bytes (CRLF, the trailing
 *    show-cursor sequence kept).
 *  - gemini-*.txt SYNTHETIC: upstream's JsonOutput shape (google-gemini/
 *    gemini-cli packages/core/src/output/types.ts + telemetry/uiTelemetry.ts),
 *    pretty-printed with CRLF as a pty delivers it. The quota wording is
 *    Google's documented text; a real empty prepaid balance has NOT been seen
 *    (gem-ops' home is not readable from svc-ops, by design). Replace
 *    with recorded output in the plan §5 recording pass.
 *
 * Run with tsx.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateSpec,
  buildDescriptor,
  RUN_SCRIPT,
  stripTerminal,
  extractJson,
  finalize,
  classifyGeminiError,
  createWorkers,
  WorkerError,
  type WorkerProc,
  type WorkerDeps,
} from '../src/engine/workers.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workers');
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  + ${msg}`);
  } else {
    failed += 1;
    console.log(`  X ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${msg}${a === b ? '' : ` (got ${a}, wanted ${b})`}`);
}
function refuses(fn: () => unknown, field: string, msg: string): void {
  try {
    fn();
    ok(false, `${msg} (no refusal)`);
  } catch (e) {
    ok(e instanceof WorkerError && e.status === 400 && e.extra.field === field, `${msg} (400 field ${(e as WorkerError).extra?.field})`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const base = {
  jobId: 'job-1',
  vendor: 'claude-code',
  model: 'sonnet',
  params: { effort: 'medium' },
  cwd: '/srv/code/briefing-table',
  prompt: 'review this',
  budget: { maxSeconds: 60, maxOutputBytes: 4096 },
};

console.log('[spec validation]');
{
  const s = validateSpec(base);
  eq([s.vendor, s.model, s.params, s.budget], ['claude-code', 'sonnet', { effort: 'medium' }, { maxSeconds: 60, maxOutputBytes: 4096 }], 'a claude spec validates with its effort');
  refuses(() => validateSpec({ ...base, model: undefined }), 'model', 'missing model is refused');
  refuses(() => validateSpec({ ...base, model: '' }), 'model', 'empty model is refused');
  refuses(() => validateSpec({ ...base, model: 'fable' }), 'model', "claude 'fable' is refused (attended-only)");
  refuses(() => validateSpec({ ...base, model: 'claude-Fable-5' }), 'model', 'a full Fable id is refused too');
  refuses(() => validateSpec({ ...base, model: '--dangerously-skip-permissions' }), 'model', 'a model that reads as a flag is refused');
  refuses(() => validateSpec({ ...base, vendor: 'ollama' }), 'vendor', 'unknown vendor is refused');
  refuses(() => validateSpec({ ...base, vendor: undefined }), 'vendor', 'missing vendor is refused');
  refuses(() => validateSpec({ ...base, params: { effort: 'turbo' } }), 'params.effort', 'unknown effort is refused');
  refuses(() => validateSpec({ ...base, params: { effort: 'ultracode' } }), 'params.effort', 'ultracode is refused (starts sub-work; depth 1)');
  refuses(() => validateSpec({ ...base, vendor: 'gemini-cli', model: 'gemini-2.5-pro' }), 'params.effort', 'gemini with an effort is refused');
  refuses(() => validateSpec({ ...base, cwd: 'relative/dir' }), 'cwd', 'a relative cwd is refused');
  refuses(() => validateSpec({ ...base, prompt: '  ' }), 'prompt', 'a blank prompt is refused');
  refuses(() => validateSpec({ ...base, jobId: '' }), 'jobId', 'a missing jobId is refused');
  refuses(() => validateSpec({ ...base, budget: { maxSeconds: -1 } }), 'budget.maxSeconds', 'a negative budget is refused');
  refuses(
    () => validateSpec({ ...base, vendor: 'gemini-cli', model: 'gemini-2.5-pro', params: {}, prompt: 'x'.repeat(130_000) }),
    'prompt',
    'a gemini prompt over the argv limit is refused',
  );
  const d = validateSpec({ ...base, params: {}, budget: undefined });
  eq(d.budget, { maxSeconds: 600, maxOutputBytes: 262144 }, 'budget defaults when absent (never unbounded)');
  eq(validateSpec({ ...base, budget: { maxSeconds: 99999, maxOutputBytes: 1e9 } }).budget, { maxSeconds: 3600, maxOutputBytes: 2097152 }, 'budget clamps to the ceilings');
  eq(d.params, {}, 'effort is optional for claude');
}

console.log('\n[descriptor: the prompt never reaches a shell parser]');
{
  const bins = { 'claude-code': 'claude', 'gemini-cli': 'gemini' } as const;
  const evil = 'x"; rm -rf ~; echo "$(id)` `';
  const c = buildDescriptor(validateSpec({ ...base, prompt: evil }), 'wk-1', '/w/wk-1.prompt', bins);
  eq(c.binary, 'bash', 'spawned through bash (login PATH)');
  eq(
    c.args,
    ['-lic', RUN_SCRIPT['claude-code'], 'worker', '/w/wk-1.prompt', 'timeout', '-k', '10', '60', 'claude', '-p', '--model', 'sonnet', '--effort', 'medium', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'],
    'claude argv: timeout-wrapped, explicit model + effort, json, no transcript, no MCP',
  );
  ok(!c.args!.some((a) => a.includes('rm -rf')), 'the prompt text is in no argv element (it is in the file)');
  eq(c.cwd, '/srv/code/briefing-table', 'cwd passes through');
  eq(c.env, { HARBOR_WB_WORKER: 'wk-1', HARBOR_WB_JOB: 'job-1', HARBOR_WB_VENDOR: 'claude-code', HARBOR_WB_ORIGIN: 'dispatched' }, 'env marks the process as a dispatched worker');
  const g = buildDescriptor(validateSpec({ ...base, vendor: 'gemini-cli', model: 'gemini-2.5-pro', params: {} }), 'wk-2', '/w/wk-2.prompt', bins);
  eq(
    g.args!.slice(4),
    ['timeout', '-k', '10', '60', 'gemini', '-m', 'gemini-2.5-pro', '--output-format', 'json'],
    'gemini argv: explicit model and json, NO yolo while the auto-approve default is off (the script appends --prompt from the file)',
  );
  {
    const aa = await import('../src/engine/auto-approve.ts');
    aa.setDefaultReader(() => 'on');
    const gy = buildDescriptor(validateSpec({ ...base, vendor: 'gemini-cli', model: 'gemini-2.5-pro', params: {} }), 'wk-2', '/w/wk-2.prompt', bins);
    eq(gy.args!.slice(4), ['timeout', '-k', '10', '60', 'gemini', '-m', 'gemini-2.5-pro', '--approval-mode', 'yolo', '--output-format', 'json'], 'with the person-chosen default ON the headless gemini gets yolo');
    aa.setDefaultReader(() => 'off');
  }
  ok(RUN_SCRIPT['gemini-cli'].includes('--prompt "$(cat -- "$f")"') && !RUN_SCRIPT['gemini-cli'].includes('$2'), 'gemini script reads the prompt from the file, quoted');
}

console.log('\n[parsing]');
{
  const raw = fixture('claude-pty-success.txt');
  ok(!stripTerminal(raw).includes(String.fromCharCode(27)) && !stripTerminal(raw).includes(String.fromCharCode(13)), 'terminal sequences and CRs are stripped');
  const r = finalize('claude-code', raw, { exitCode: 0, seconds: 3, truncated: false, maxOutputBytes: 65536 });
  eq([r.status, r.text, r.stopReason], ['done', 'pong', 'end_turn'], 'recorded claude run -> done, the result text');
  ok(r.usage.inTokens! > 0 && r.usage.outTokens! > 0 && r.usage.costUsd! > 0 && r.usage.seconds === 3, `claude usage parsed (${JSON.stringify(r.usage)})`);

  const g = finalize('gemini-cli', fixture('gemini-success.txt'), { exitCode: 0, seconds: 5, truncated: false, maxOutputBytes: 65536 });
  eq([g.status, g.text, g.usage], ['done', 'No findings: the plan is sound.', { inTokens: 1200, outTokens: 590, seconds: 5 }], 'gemini pretty JSON after a log line -> done, prompt + candidates+thoughts tokens');

  const credit = finalize('gemini-cli', fixture('gemini-credit-exhausted.txt'), { exitCode: 1, seconds: 1, truncated: false, maxOutputBytes: 65536 });
  eq([credit.status, credit.stopReason], ['capped', 'credit_exhausted'], 'gemini billing exhaustion -> capped / credit_exhausted');
  const rate = finalize('gemini-cli', fixture('gemini-rate-limited.txt'), { exitCode: 1, seconds: 1, truncated: false, maxOutputBytes: 65536 });
  eq([rate.status, rate.stopReason], ['failed', 'rate_limited'], 'gemini per-minute 429 -> failed / rate_limited (not credit)');
  eq(classifyGeminiError({ message: 'Your prepayment credits are depleted', code: 402 }), 'credit_exhausted', 'prepaid depletion wording -> credit_exhausted');
  eq(classifyGeminiError({ message: 'RESOURCE_EXHAUSTED', code: 429 }), 'rate_limited', 'a bare 429 -> rate_limited');
  eq(classifyGeminiError({ message: 'model not found', code: 404 }), null, 'an unrelated error is neither');

  const err = finalize('claude-code', '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"","usage":{"input_tokens":5,"output_tokens":0}}\r\n', { exitCode: 1, seconds: 1, truncated: false, maxOutputBytes: 100 });
  eq([err.status, err.stopReason], ['failed', 'error_during_execution'], 'claude is_error -> failed with its subtype');
  eq(finalize('claude-code', 'hello\r\n', { exitCode: 0, seconds: 1, truncated: false, maxOutputBytes: 100 }).status, 'could_not_tell', 'no JSON, exit 0 -> could_not_tell');
  const crash = finalize('claude-code', 'command not found\r\n', { exitCode: 127, seconds: 1, truncated: false, maxOutputBytes: 100 });
  eq([crash.status, crash.stopReason, crash.text], ['failed', 'exit:127', 'command not found'], 'no JSON, non-zero exit -> failed exit:N with the raw text');
  eq(finalize('claude-code', '', { exitCode: 124, seconds: 60, truncated: false, maxOutputBytes: 100 }).stopReason, 'wall_clock', 'timeout exit 124 -> capped wall_clock');
  const trunc = finalize('claude-code', '{"type":"result","is_err', { exitCode: 0, seconds: 1, truncated: true, maxOutputBytes: 100 });
  eq([trunc.status, trunc.stopReason], ['capped', 'output_cap'], 'truncated output -> capped output_cap');
  const long = finalize('claude-code', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'y'.repeat(500) }), { exitCode: 0, seconds: 1, truncated: false, maxOutputBytes: 100 });
  eq(long.text.length, 100, 'result text is capped at maxOutputBytes');
  eq(extractJson('noise {"a":1}\r\n{"b":2}\r\n'), { b: 2 }, 'the last column-0 object wins');
}

console.log('\n[manager: caps, kill switch, truncation, stop, backstop]');
class FakeProc implements WorkerProc {
  dataCbs: Array<(d: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  killed = 0;
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  kill() {
    this.killed++;
  }
  emit(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  exit(code: number) {
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
}
{
  const tmp = mkdtempSync(join(tmpdir(), 'wb-workers-unit-'));
  const kill = join(tmp, 'dispatch-blocked');
  const spawned: Array<{ link: string; sid: string; args: string[]; proc: FakeProc }> = [];
  let failSpawn = false;
  const deps: WorkerDeps = {
    spawn: async (link, sid, desc) => {
      if (failSpawn) throw new Error('broker down');
      const proc = new FakeProc();
      spawned.push({ link, sid, args: desc.args ?? [], proc });
      return proc;
    },
    killSwitchPath: kill,
    dir: join(tmp, 'workers'),
    group: ownGroup(),
    bins: { 'claude-code': 'claude', 'gemini-cli': 'gemini' },
    jobsPerProjectPerDay: 3,
    maxConcurrent: 3,
    maxConcurrentGemini: 1,
    backstopGraceMs: 0,
    now: () => Date.now(),
    log: () => {},
  };
  const W = createWorkers(deps);
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof WorkerError ? `${e.status}:${(e.extra.cap as string) ?? e.code}` : `threw:${(e as Error).message}`;
    }
  };

  writeFileSync(kill, '');
  eq(await code(W.launch(base)), '503:dispatch-blocked', 'the kill switch refuses a launch');
  eq(spawned.length, 0, 'nothing spawned while the kill switch is set');
  rmSync(kill);

  const w1 = await W.launch({ ...base, prompt: 'secret prompt one' });
  eq([spawned[0].link, spawned[0].sid, w1.state], ['homebase', w1.id, 'running'], 'claude runs in the homebase link, sid = worker id');
  const pf = spawned[0].args[3];
  eq(readFileSync(pf, 'utf8'), 'secret prompt one', 'the prompt is in the file, verbatim');
  if (process.platform !== 'win32') {
    eq((statSync(pf).mode & 0o777).toString(8), '640', 'prompt file is 0640');
    eq((statSync(deps.dir).mode & 0o7777).toString(8), '2750', 'workers dir is 2750 (setgid, group-read)');
  }

  spawned[0].proc.emit(fixture('claude-pty-success.txt'));
  spawned[0].proc.exit(0);
  const s1 = W.status(w1.id)!;
  eq([s1.state, s1.result?.status, s1.result?.text], ['exited', 'done', 'pong'], 'exit -> parsed result on status');
  ok(!existsSync(pf), 'the prompt file is deleted when the worker ends');

  const g1 = await W.launch({ ...base, jobId: 'job-1', vendor: 'gemini-cli', model: 'gemini-2.5-pro', params: {} });
  eq(spawned[1].link, 'gemini', 'gemini runs in the gemini link');
  eq(await code(W.launch({ ...base, vendor: 'gemini-cli', model: 'gemini-2.5-pro', params: {} })), '429:concurrent-gemini', 'a second concurrent gemini worker is refused');
  const c2 = await W.launch(base);
  const c3 = await W.launch(base);
  eq(await code(W.launch(base)), '429:concurrent', 'a fourth concurrent worker is refused (cap 3)');

  // output cap: over maxOutputBytes -> truncated, killed, capped
  spawned[2].proc.emit('z'.repeat(5000));
  ok(spawned[2].proc.killed >= 1, 'going over maxOutputBytes kills the worker');
  spawned[2].proc.emit('more');
  spawned[2].proc.exit(143);
  const t = W.status(c2.id)!;
  eq([t.truncated, t.outputBytes, t.result?.status, t.result?.stopReason], [true, 4096, 'capped', 'output_cap'], 'truncated at the cap with the flag; capped / output_cap');

  // stop
  const st = W.stop(c3.id)!;
  eq([st.state, st.result?.status, st.result?.stopReason, spawned[3].proc.killed], ['exited', 'failed', 'stopped', 1], 'DELETE kills and answers failed / stopped');
  spawned[3].proc.exit(0);
  eq(W.status(c3.id)!.result?.stopReason, 'stopped', 'a late exit does not overwrite the stop');
  eq(W.stop('wk-nope'), null, 'stop of an unknown id -> null (404)');

  spawned[1].proc.emit(fixture('gemini-credit-exhausted.txt'));
  spawned[1].proc.exit(1);
  eq(W.status(g1.id)!.result?.stopReason, 'credit_exhausted', 'gemini credit exhaustion reaches the status');

  // per-day jobs per project
  await W.launch({ ...base, jobId: 'job-2' });
  spawned[4].proc.exit(0);
  await W.launch({ ...base, jobId: 'job-3' });
  spawned[5].proc.exit(0);
  eq(await code(W.launch({ ...base, jobId: 'job-4' })), '429:jobs-per-day', 'a fourth job in one project on one day is refused');
  ok((await code(W.launch({ ...base, jobId: 'job-2' }))) === 'ok', 'another worker for an already-counted job is allowed');
  spawned[6].proc.exit(0);
  ok((await code(W.launch({ ...base, jobId: 'job-4', cwd: '/srv/code/auriga' }))) === 'ok', 'the cap is per project (another cwd is fine)');
  spawned[7].proc.exit(0);

  // list
  eq(W.list('job-1').map((w) => w.id).sort(), [w1.id, g1.id, c2.id, c3.id].sort(), 'list filters by jobId');
  ok(W.list().length === 8 && !('stdoutTail' in W.list()[0]), 'list without a jobId lists all (summary form)');

  // spawn failure: 503 broker, prompt file cleaned, not counted as running
  failSpawn = true;
  eq(await code(W.launch({ ...base, jobId: 'job-2' })), '503:broker', 'a broker that cannot spawn -> 503');
  failSpawn = false;
  const leftovers = readdirSafe(deps.dir).filter((f) => f.endsWith('.prompt'));
  eq(leftovers, [], 'no prompt file is left behind');

  // backstop: no exit ever arrives -> could_not_tell / lost
  const lost = await W.launch({ ...base, jobId: 'job-2', budget: { maxSeconds: 1, maxOutputBytes: 100 } });
  await sleep(1300);
  const l = W.status(lost.id)!;
  eq([l.state, l.result?.status, l.result?.stopReason], ['exited', 'could_not_tell', 'lost'], 'no exit by maxSeconds + grace -> could_not_tell / lost');
  ok(spawned[spawned.length - 1].proc.killed >= 1, 'the backstop also kills the pty');
  if (process.platform !== 'win32') {
    const W2 = createWorkers({ ...deps, dir: join(tmp, 'workers-unshared'), group: 'no-such-group-xyz' });
    eq(await code(W2.launch({ ...base, jobId: 'job-2', vendor: 'gemini-cli', model: 'gemini-2.5-pro', params: {} })), '503:workers-dir', 'a prompt dir gem-ops could not read refuses a gemini launch up front');
    ok((await code(W2.launch({ ...base, jobId: 'job-2' }))) === 'ok', 'the same dir still serves claude (same account)');
  }
  rmSync(tmp, { recursive: true, force: true });
}

/** This process's primary group name (the unit suite shares the dir with it). */
function ownGroup(): string {
  try {
    const gid = String(process.getgid?.());
    return readFileSync('/etc/group', 'utf8').split('\n').map((l) => l.split(':')).find((f) => f[2] === gid)?.[0] ?? 'none';
  } catch {
    return 'none';
  }
}

function readdirSafe(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
