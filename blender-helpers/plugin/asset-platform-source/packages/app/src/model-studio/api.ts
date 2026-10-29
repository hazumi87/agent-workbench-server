// Model Studio: the Library app's side of the core API (packages/tools/model-studio/server.js)
// and one small jobs store. The store lives at module level so jobs keep being watched while the
// user is back in the Library, and are still there when the app is reopened.
//
// The core has no server-side queue: POST /api/run answers 409 {availability:'waiting-gpu'} for a
// GPU op. "Queue" therefore keeps the request here and re-posts it every QUEUE_RETRY_MS until the
// core accepts it (202), refuses it for real, or the user cancels. It never starts a service.
import { useSyncExternalStore } from 'react';
import type { Asset } from '../types';

export const CORE = '/asset-management/tools/model-studio/api';
export const LIB = '/asset-management/library';
const POLL_MS = 2000;
const QUEUE_RETRY_MS = 15000;
const RECENT_MS = 60 * 60 * 1000;

// ── Shapes (server.js flatten() / proxyJob / GET /api/jobs) ─────────────────────────────────
export interface InputDecl { kind?: string; category?: string; name?: string; required?: boolean; arity?: string }
export interface Schema { type?: string; title?: string; description?: string; default?: unknown; enum?: unknown[]; minimum?: number; maximum?: number;
  multipleOf?: number; minLength?: number; maxLength?: number; pattern?: string; format?: string; items?: Schema; maxItems?: number;
  properties?: Record<string, Schema>; required?: string[] }
export type Availability = 'ready' | 'waiting-gpu' | 'offline';
export interface Op { provider: string; op?: string; id: string; label: string; inputs: InputDecl[]; outputs: unknown[]; params: Schema | null;
  est: unknown; gpu_need_mb: number; license: unknown; availability: Availability; params_unrenderable?: boolean; params_problem?: string }
export interface JobLive { jobId?: string; state?: string; phase?: string | null; pct?: number | null; error?: string | null;
  result?: { assetIds?: string[] } | null; log_tail?: string | null; created?: number; updated?: number }
export interface RunReq { provider: string; id: string; inputs: Record<string, string | string[]>; params: Record<string, unknown> }
export interface HistEntry extends RunReq { jobId: string; at: string; live: JobLive | null; live_error?: string }

/** The core answered 404 / didn't answer: the gateway hasn't loaded it (or it's down). */
export class CoreDown extends Error { constructor() { super("Model Studio isn't running yet"); } }

async function core(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  let r: Response;
  try { r = await fetch(`${CORE}${path}`, init); } catch { throw new CoreDown(); }
  const body = await r.json().catch(() => null);
  if (r.status === 404 && !body?.error) throw new CoreDown();   // the gateway's own 404: the tool isn't mounted
  if (!body) throw r.status >= 500 ? new CoreDown() : new Error(`Model Studio answered ${r.status}`);
  return { status: r.status, body };
}

export async function fetchOps(category: string): Promise<Op[]> {
  const { status, body } = await core(`/ops?category=${encodeURIComponent(category)}`);
  if (status >= 400 || !body.ok) throw new Error(String(body.error || `ops → ${status}`));
  return body.ops as Op[];
}

// ── Formatting ──────────────────────────────────────────────────────────────────────────────
export function estSeconds(est: unknown): number | null {
  if (typeof est === 'number') return est;
  if (est && typeof est === 'object' && typeof (est as { seconds?: unknown }).seconds === 'number') return (est as { seconds: number }).seconds;
  return null;
}
export function fmtEst(est: unknown): string | null {
  const s = estSeconds(est);
  if (s == null) return typeof est === 'string' ? est : null;
  return s < 90 ? `~${Math.max(1, Math.round(s))} s` : `~${Math.round(s / 60)} min`;
}
export const gpuGb = (mb: number) => `${Math.max(1, Math.round(mb / 1024))} GB GPU`;
export const isEvalOnly = (lic: unknown) =>
  lic === 'evaluation_only' || (!!lic && typeof lic === 'object' && (lic as { outputs?: unknown }).outputs === 'evaluation_only');
/** 'mesh-studio' → 'Mesh Studio' (the offline hint names the program to start in Harbor). */
export const providerName = (p: string) => p.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
export const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const fmtAge = (ms: number) => { const m = Math.round(ms / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 60 * 36 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
export const nameOf = (a: Pick<Asset, 'id' | 'label' | 'filename'>) => a.label || a.filename || a.id.slice(0, 8);
const ORDER: Record<Availability, number> = { ready: 0, 'waiting-gpu': 1, offline: 2 };
export const sortOps = (ops: Op[]) => [...ops].sort((a, b) => (ORDER[a.availability] ?? 3) - (ORDER[b.availability] ?? 3));
export const opKey = (o: { provider: string; id: string }) => `${o.provider}:${o.id}`;

// ── Library lookups (names for job cards, result assets) — cached for the page's life ───────
const assetCache = new Map<string, Promise<Asset | null>>();
export function getAsset(id: string): Promise<Asset | null> {
  if (!assetCache.has(id)) {
    assetCache.set(id, fetch(`${LIB}/api/assets/${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return assetCache.get(id)!;
}

// ── The jobs store ──────────────────────────────────────────────────────────────────────────
// A tracked job is one started in this page (or found live in the core's log). `local` marks a
// request that was never accepted: 'waiting-gpu' (re-posted until it is), or the reason it failed.
export interface Tracked extends RunReq {
  key: string; jobId: string | null; at: number; job: JobLive | null;
  local?: 'waiting-gpu' | 'cancelled' | 'failed'; error?: string; logOpen?: boolean;
}
export type JobState = 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'unknown';
export function stateOf(t: { local?: string; job: JobLive | null }): JobState {
  if (t.local === 'waiting-gpu') return 'waiting';
  if (t.local === 'cancelled') return 'cancelled';
  if (t.local === 'failed') return 'failed';
  const s = t.job?.state;
  if (s === 'queued') return /gpu/i.test(t.job?.phase || '') ? 'waiting' : 'queued';
  if (s === 'running') return 'running';
  if (s === 'done') return 'done';
  if (s === 'error' || s === 'failed') return 'failed';
  if (s === 'cancelled') return 'cancelled';
  return 'unknown';
}
export const isActive = (s: JobState) => s === 'waiting' || s === 'queued' || s === 'running';

interface Store { core: 'unknown' | 'up' | 'down'; tracked: Tracked[]; history: HistEntry[]; labels: Record<string, string>; names: Record<string, string> }
let S: Store = { core: 'unknown', tracked: [], history: [], labels: {}, names: {} };
const subs = new Set<() => void>();
const set = (patch: Partial<Store>) => { S = { ...S, ...patch }; subs.forEach(f => f()); guardUnload(); };
// A GPU-waiting request lives only in this page: leaving it drops the request, so ask first.
const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
let guarded = false;
function guardUnload() {
  const held = S.tracked.some(t => t.local === 'waiting-gpu');
  if (held === guarded) return;
  guarded = held;
  if (held) window.addEventListener('beforeunload', onUnload); else window.removeEventListener('beforeunload', onUnload);
}
const patchTracked = (key: string, p: Partial<Tracked>) => set({ tracked: S.tracked.map(t => (t.key === key ? { ...t, ...p } : t)) });

export function useJobs(): Store {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => S);
}
export const noteLabels = (ops: Op[]) => set({ labels: { ...S.labels, ...Object.fromEntries(ops.map(o => [opKey(o), o.label])) } });
export const setCoreState = (core: Store['core']) => { if (S.core !== core) set({ core }); };

const asked = new Set<string>();
/** "op · source" for a card or history row; source names resolve in the background. */
export function jobTitle(r: RunReq): { op: string; source: string } {
  const first = Object.values(r.inputs || {}).flat()[0];
  if (first && !(first in S.names) && !asked.has(first)) {
    asked.add(first);
    getAsset(first).then(a => { if (a) set({ names: { ...S.names, [first]: nameOf(a) } }); });
  }
  return { op: S.labels[opKey(r)] || r.id, source: first ? S.names[first] ?? first.slice(0, 8) : '' };
}

let seq = 0;
/** POST /api/run. Resolves when the core accepted it or it was queued for the GPU; throws the core's reason otherwise. */
export async function startRun(req: RunReq, key = `l${++seq}`): Promise<'started' | 'queued'> {
  const { status, body } = await core('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  setCoreState('up');
  const known = S.tracked.find(t => t.key === key);
  if (status === 202 && typeof body.jobId === 'string') {
    const t: Tracked = { ...req, key, jobId: body.jobId, at: known?.at ?? Date.now(), job: { state: 'queued', phase: 'starting', pct: 0 }, local: undefined, error: undefined };
    set({ tracked: known ? S.tracked.map(x => (x.key === key ? t : x)) : [t, ...S.tracked] });
    schedule();
    return 'started';
  }
  if (status === 409 && body.availability === 'waiting-gpu') {
    if (!known) lastRetry = Date.now();
    if (known) patchTracked(key, { local: 'waiting-gpu', error: undefined });
    else set({ tracked: [{ ...req, key, jobId: null, at: Date.now(), job: null, local: 'waiting-gpu' }, ...S.tracked] });
    schedule();
    return 'queued';
  }
  throw new Error(String(body.error || `Run → ${status}`));
}

export async function cancelJob(t: Tracked) {
  if (!t.jobId) { patchTracked(t.key, { local: 'cancelled' }); return; }
  try {
    const { body } = await core(`/jobs/${encodeURIComponent(t.jobId)}/cancel`, { method: 'POST' });
    if (body.job) patchTracked(t.key, { job: { ...t.job, ...(body.job as JobLive) } });
  } catch { /* the next poll shows the real state */ }
  poll();
}

/** Retry = the same request again, as a new card. */
export function retryJob(r: RunReq) {
  return startRun({ provider: r.provider, id: r.id, inputs: r.inputs, params: r.params }).catch(e => {
    set({ tracked: [{ ...r, key: `l${++seq}`, jobId: null, at: Date.now(), job: null, local: 'failed', error: e.message }, ...S.tracked] });
  });
}
export const toggleLog = (key: string) => patchTracked(key, { logOpen: !S.tracked.find(t => t.key === key)?.logOpen });

export async function loadHistory() {
  try {
    const { status, body } = await core('/jobs?limit=20');
    if (status >= 400 || !body.ok) return;
    setCoreState('up');
    const history = body.jobs as HistEntry[];
    // A job the core still runs, or one that ended in the last hour (started earlier, or from a
    // room), becomes a card — Show result / Retry live there; older ones stay history rows.
    const mine = new Set(S.tracked.map(t => t.jobId));
    const recent = (h: HistEntry) => !!h.live && (isActive(stateOf({ job: h.live }))
      || Date.now() - (h.live.updated ? h.live.updated * 1000 : Date.parse(h.at)) < RECENT_MS);
    const live = history.filter(h => !mine.has(h.jobId) && recent(h))
      .map(h => ({ provider: h.provider, id: h.id, inputs: h.inputs, params: h.params, key: `h:${h.jobId}`, jobId: h.jobId, at: Date.parse(h.at) || Date.now(), job: h.live }));
    set({ history, tracked: [...S.tracked, ...live].sort((a, b) => b.at - a.at) });
    if (live.some(t => isActive(stateOf(t)))) schedule();
  } catch (e) { if (e instanceof CoreDown) setCoreState('down'); }
}

// One timer for everything live: accepted jobs are polled every 2 s; GPU-queued requests re-post every 15 s.
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRetry = 0;
function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; poll(); }, POLL_MS);
}
async function poll() {
  const live = S.tracked.filter(t => t.jobId && isActive(stateOf(t)));
  let finished = false;
  await Promise.all(live.map(async t => {
    try {
      const { status, body } = await core(`/jobs/${encodeURIComponent(t.jobId!)}`);
      if (status === 404) { patchTracked(t.key, { local: 'failed', error: 'The backend no longer knows this job (restarted?)' }); return; }
      if (body.job) {
        const job = body.job as JobLive;
        patchTracked(t.key, { job });
        if (!isActive(stateOf({ job }))) finished = true;
      }
    } catch { /* transient: keep the last state */ }
  }));
  if (Date.now() - lastRetry >= QUEUE_RETRY_MS) {
    lastRetry = Date.now();
    for (const t of S.tracked.filter(x => x.local === 'waiting-gpu')) {
      await startRun(t, t.key).catch(e => patchTracked(t.key, { local: 'failed', error: e.message }));
    }
  }
  if (finished) loadHistory();
  if (S.tracked.some(t => isActive(stateOf(t)))) schedule();
}
