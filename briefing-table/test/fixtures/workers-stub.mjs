/**
 * STUB ENGINE PORT for the group-jobs tool's tests (plan KB design-notes-id
 * §2/§4, ticket). Same routes, same request validation, same response shapes
 * as the real engine (src/engine/workers.ts, the design notes), with canned
 * results and no processes. Self-contained on purpose (node built-ins only):
 * the tool repo copies this file and builds against it.
 *
 *   import { startWorkersStub } from './workers-stub.mjs';
 *   const stub = await startWorkersStub({ port: 0, token: 't' });
 *   // stub.url, stub.close(), stub.workers (the in-memory records)
 *
 *   node workers-stub.mjs --port 7999 --token t     (standalone)
 *
 * CANNED OUTCOMES. A worker finishes after `delayMs` (default 0: the first GET
 * already sees it exited). The outcome is picked by a marker in the prompt,
 * else `done`:
 *   [stub:done] [stub:failed] [stub:capped] [stub:credit_exhausted]
 *   [stub:rate_limited] [stub:wall_clock] [stub:could_not_tell] [stub:hang]
 * `hang` never finishes until DELETE (answers status failed / stopped).
 * `kill-switch: true` makes every launch answer 503 dispatch-blocked; caps are
 * `maxConcurrent` (default 3) and `jobsPerProjectPerDay` (default 3).
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const VENDORS = ['claude-code', 'gemini-cli'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JOB_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const OUTCOMES = {
  done: { status: 'done', stopReason: 'end_turn', text: 'stub result' },
  failed: { status: 'failed', stopReason: 'exit:1', text: '' },
  capped: { status: 'capped', stopReason: 'output_cap', text: 'stub partial' },
  credit_exhausted: { status: 'capped', stopReason: 'credit_exhausted', text: '' },
  rate_limited: { status: 'failed', stopReason: 'rate_limited', text: '' },
  wall_clock: { status: 'capped', stopReason: 'wall_clock', text: '' },
  could_not_tell: { status: 'could_not_tell', stopReason: 'no_json', text: 'stub raw output' },
};

function invalid(field, message) {
  return { status: 400, body: { error: 'invalid', message, field } };
}

function validate(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return invalid('body', 'the body is a JSON object');
  if (typeof o.jobId !== 'string' || !JOB_RE.test(o.jobId)) return invalid('jobId', 'jobId is required');
  if (!VENDORS.includes(o.vendor)) return invalid('vendor', `vendor must be one of ${VENDORS.join(', ')}`);
  if (typeof o.model !== 'string' || !o.model) return invalid('model', 'model is required and passed explicitly');
  if (!MODEL_RE.test(o.model)) return invalid('model', 'model: letters, digits and ._-');
  if (/fable/i.test(o.model)) return invalid('model', 'Fable is attended-only (ticket)');
  const effort = o.params?.effort;
  if (effort !== undefined && effort !== null) {
    if (o.vendor !== 'claude-code') return invalid('params.effort', `${o.vendor} has no effort setting`);
    if (!EFFORTS.includes(effort)) return invalid('params.effort', 'effort must be low, medium, high, xhigh or max');
  }
  if (typeof o.cwd !== 'string' || !o.cwd.startsWith('/')) return invalid('cwd', 'cwd is required: an absolute path');
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) return invalid('prompt', 'prompt is required');
  return null;
}

export async function startWorkersStub(opts = {}) {
  const { port = 0, host = '127.0.0.1', token = 'stub-token', delayMs = 0 } = opts;
  const maxConcurrent = opts.maxConcurrent ?? 3;
  const jobsPerProjectPerDay = opts.jobsPerProjectPerDay ?? 3;
  const workers = new Map();
  const jobsByProject = new Map();
  const state = { killSwitch: !!opts.killSwitch };

  const view = (w, full = true) => {
    const exited = w.outcome !== 'hang' && !w.stopped && Date.now() - w.started >= delayMs;
    const result = w.stopped
      ? { status: 'failed', text: '', usage: { seconds: 0 }, stopReason: 'stopped', exitCode: null }
      : exited
        ? { ...OUTCOMES[w.outcome], usage: { inTokens: 100, outTokens: 20, seconds: 1 }, exitCode: 0 }
        : null;
    return {
      id: w.id,
      jobId: w.spec.jobId,
      vendor: w.spec.vendor,
      model: w.spec.model,
      params: w.spec.params ?? {},
      budget: { maxSeconds: w.spec.budget?.maxSeconds ?? 600, maxOutputBytes: w.spec.budget?.maxOutputBytes ?? 262144 },
      state: result ? 'exited' : 'running',
      startedAt: new Date(w.started).toISOString(),
      endedAt: result ? new Date(w.ended ?? w.started + delayMs).toISOString() : null,
      outputBytes: 0,
      truncated: false,
      ...(full ? { stdoutTail: '' } : {}),
      result,
    };
  };

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://stub');
    const route = url.pathname;
    if (route !== '/api/workers' && !route.startsWith('/api/workers/')) return send(res, 404, { error: 'not-found' });
    const id = route.startsWith('/api/workers/') ? decodeURIComponent(route.slice(13)) : null;
    if (!id && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      let b;
      try {
        b = raw ? JSON.parse(raw) : {};
      } catch {
        return send(res, 400, { error: 'invalid JSON' });
      }
      const bad = validate(b);
      if (bad) return send(res, bad.status, bad.body);
      if (state.killSwitch) return send(res, 503, { error: 'dispatch-blocked', message: 'the dispatch kill switch is set' });
      const running = [...workers.values()].filter((w) => view(w).state === 'running').length;
      if (running >= maxConcurrent) {
        return send(res, 429, { error: 'cap', message: 'too many running', cap: 'concurrent', limit: maxConcurrent, current: running });
      }
      const jobs = jobsByProject.get(b.cwd) ?? new Set();
      if (!jobs.has(b.jobId) && jobs.size >= jobsPerProjectPerDay) {
        return send(res, 429, { error: 'cap', message: 'jobs per day', cap: 'jobs-per-day', limit: jobsPerProjectPerDay, current: jobs.size });
      }
      jobs.add(b.jobId);
      jobsByProject.set(b.cwd, jobs);
      const marker = /\[stub:([a-z_]+)\]/.exec(b.prompt)?.[1];
      const outcome = marker === 'hang' || OUTCOMES[marker] ? marker : 'done';
      const w = { id: `wk-${randomBytes(6).toString('hex')}`, spec: b, started: Date.now(), outcome, stopped: false, ended: null };
      workers.set(w.id, w);
      const v = view(w);
      return send(res, 201, { workerId: v.id, worker: v });
    }
    if (!id && req.method === 'GET') {
      const jobId = url.searchParams.get('jobId');
      return send(res, 200, { workers: [...workers.values()].filter((w) => !jobId || w.spec.jobId === jobId).map((w) => view(w, false)) });
    }
    const w = id ? workers.get(id) : null;
    if (id && req.method === 'GET') return w ? send(res, 200, { worker: view(w) }) : send(res, 404, { error: 'not-found' });
    if (id && req.method === 'DELETE') {
      if (!w) return send(res, 404, { error: 'not-found' });
      if (view(w).state === 'running') {
        w.stopped = true;
        w.ended = Date.now();
      }
      return send(res, 200, { worker: view(w) });
    }
    return send(res, 405, { error: 'method-not-allowed' });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    workers,
    setKillSwitch: (v) => {
      state.killSwitch = !!v;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const stub = await startWorkersStub({ port: Number(arg('--port', 0)), token: arg('--token', 'stub-token') });
  console.log(`workers stub on ${stub.url}`);
}
