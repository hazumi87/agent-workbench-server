/**
 * THE USAGE METER (ticket, Owner 2026-10-09 [ref]/[ref]): how much of the Claude and Codex plans
 * is used, read from the agent-usage probes' NATS readings and shown in the Workbench titlebar.
 *
 * Contract: the-owner/agent-usage the design notes. Subjects:
 *   telemetry.app.agent-usage.<claude|chatgpt>.reading        the reading
 *   telemetry.service.agent-usage-<claude|chatgpt>.health     {up, status, ts}
 *
 * THE BUS HAS NO AUTH AND NO RETENTION, so every message is validated and reduced to a known shape
 * (anything else is dropped and COUNTED); a late start sees nothing until the probe's next publish
 * (it republishes every ~5 min with the ORIGINAL capturedAt). State is in memory only.
 *
 * NEVER PRESENT AN OLD NUMBER AS CURRENT: age is judged from capturedAt, never from when WE received
 * it; past STALE_MS the view says so and carries its age; a non-ok reading carries no windows, and the
 * probe's lastGood is exposed only for a tooltip, with its own timestamp.
 *
 * Percent only: the CLI reports no token counts. Credits matter only when the plan is used up.
 */
import * as telemetry from './telemetry.ts';

export const SERVICES = ['claude', 'chatgpt'] as const;
export type Service = (typeof SERVICES)[number];
export const LABELS: Record<Service, string> = { claude: 'Claude', chatgpt: 'Codex' };
const STATUSES = ['ok', 'stale', 'auth_required', 'error', 'unknown'] as const;
/** Usage refreshes about every 10 min; past this the numbers are shown dimmed with their age. */
export const STALE_MS = 25 * 60_000;
const MAX_BODY = 8192;

export interface Window {
  label: string;
  usedPct: number | null;
  resetsAt: string | null;
}
export interface Allowance {
  state: 'available' | 'exhausted';
  usingCredits: boolean | null;
  blocked: boolean | null;
  summary: string | null;
}
export interface Reading {
  service: Service;
  status: (typeof STATUSES)[number];
  capturedAt: string;
  windows: Window[];
  allowance: Allowance | null;
  lastGood: { capturedAt: string; windows: Window[] } | null;
}

const stored = new Map<Service, { reading: Reading; receivedAt: number }>();
const heartbeats = new Map<Service, { up: boolean; status: string; ts: string; receivedAt: number }>();
const counters = { accepted: 0, dropped: 0 };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const short = (v: unknown, max = 80): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

function cleanWindows(v: unknown): Window[] | null {
  if (!Array.isArray(v) || v.length > 12) {
    return null;
  }
  const out: Window[] = [];
  for (const w of v) {
    if (!isObj(w) || typeof w.label !== 'string' || !w.label) {
      return null;
    }
    const pct = w.usedPct;
    if (pct !== null && pct !== undefined && !(typeof pct === 'number' && pct >= 0 && pct <= 100)) {
      return null;
    }
    out.push({ label: w.label.slice(0, 60), usedPct: typeof pct === 'number' ? pct : null, resetsAt: isIso(w.resetsAt) ? w.resetsAt : null });
  }
  return out;
}

/** Validate one reading body. Null = refuse (drop). Pure. */
export function parseReading(service: Service, body: string): Reading | null {
  if (body.length > MAX_BODY) {
    return null;
  }
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObj(j) || (j.service !== undefined && j.service !== service)) {
    return null;
  }
  if (typeof j.status !== 'string' || !(STATUSES as readonly string[]).includes(j.status) || !isIso(j.capturedAt)) {
    return null;
  }
  const windows = j.windows === undefined ? [] : cleanWindows(j.windows);
  if (windows === null) {
    return null;
  }
  let allowance: Allowance | null = null;
  if (isObj(j.allowance)) {
    const a = j.allowance;
    if (a.state === 'available' || a.state === 'exhausted') {
      allowance = {
        state: a.state,
        usingCredits: typeof a.usingCredits === 'boolean' ? a.usingCredits : null,
        blocked: typeof a.blocked === 'boolean' ? a.blocked : null,
        summary: short(a.summary, 160),
      };
    }
  }
  let lastGood: Reading['lastGood'] = null;
  if (isObj(j.lastGood) && isIso(j.lastGood.capturedAt)) {
    const lw = cleanWindows(j.lastGood.windows);
    lastGood = lw ? { capturedAt: j.lastGood.capturedAt, windows: lw } : null;
  }
  return { service, status: j.status as Reading['status'], capturedAt: j.capturedAt, windows: j.status === 'ok' ? windows : [], allowance, lastGood };
}

const READING_RE = /^telemetry\.app\.agent-usage\.(claude|chatgpt)\.reading$/;
const HEALTH_RE = /^telemetry\.service\.agent-usage-(claude|chatgpt)\.health$/;

/** One NATS message. Anything unrecognised or invalid is dropped and counted. */
export function ingest(subject: string, body: string, now: number = Date.now()): void {
  const r = READING_RE.exec(subject);
  if (r) {
    const reading = parseReading(r[1] as Service, body);
    if (!reading) {
      counters.dropped++;
      return;
    }
    const cur = stored.get(reading.service);
    // an older capture (a replay) never replaces a newer one
    if (!cur || Date.parse(reading.capturedAt) >= Date.parse(cur.reading.capturedAt)) {
      stored.set(reading.service, { reading, receivedAt: now });
    }
    counters.accepted++;
    return;
  }
  const hm = HW_RE.exec(subject);
  if (hm) {
    if (ingestHardware(hm[1], body, now)) {
      counters.accepted++;
    } else {
      counters.dropped++;
    }
    return;
  }
  const h = HEALTH_RE.exec(subject);
  if (h) {
    try {
      const j = JSON.parse(body.slice(0, MAX_BODY));
      if (isObj(j) && typeof j.up === 'boolean') {
        heartbeats.set(h[1] as Service, { up: j.up, status: short(j.status, 40) ?? '', ts: isIso(j.ts) ? j.ts : new Date(now).toISOString(), receivedAt: now });
        counters.accepted++;
        return;
      }
    } catch {
      /* fall through */
    }
  }
  counters.dropped++;
}

/* ---- server hardware (telemetry.hardware.*, published every second by hardware-telemetry-publisher) ---- */
export const HW_STALE_MS = 30_000;
const hw = new Map<string, { v: Record<string, unknown>; at: number }>();
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const HW_RE = /^telemetry\.hardware\.(cpu|memory|temperature|gpu)$/;

function ingestHardware(kind: string, body: string, now: number): boolean {
  if (body.length > MAX_BODY) {
    return false;
  }
  try {
    const j = JSON.parse(body);
    if (!isObj(j)) {
      return false;
    }
    hw.set(kind, { v: j, at: now });
    return true;
  } catch {
    return false;
  }
}

export interface HardwareView {
  state: 'ok' | 'stale' | 'absent';
  ageSec: number | null;
  cpuPct: number | null;
  load1: number | null;
  memPct: number | null;
  memUsedGb: number | null;
  memTotalGb: number | null;
  tempC: number | null;
  /** the integrated GPU reports FREQUENCY only (utilisation is unavailable on this kernel) */
  gpuMhz: number | null;
  gpuMaxMhz: number | null;
}

export function hardwareView(now: number = Date.now()): HardwareView {
  const get = (k: string) => hw.get(k);
  const newest = Math.max(0, ...[...hw.values()].map((e) => e.at));
  const cpu = get('cpu')?.v;
  const mem = get('memory')?.v;
  const temp = get('temperature')?.v;
  const gpu = get('gpu')?.v;
  return {
    state: hw.size === 0 ? 'absent' : now - newest > HW_STALE_MS ? 'stale' : 'ok',
    ageSec: hw.size === 0 ? null : Math.floor((now - newest) / 1000),
    cpuPct: num(cpu?.usage_pct),
    load1: num(cpu?.load_1m),
    memPct: num(mem?.used_pct),
    memUsedGb: num(mem?.used_gb),
    memTotalGb: num(mem?.total_gb),
    tempC: num(temp?.cpu_c),
    gpuMhz: num(gpu?.freq_actual_mhz),
    gpuMaxMhz: num(gpu?.freq_max_mhz),
  };
}

export type ViewState = 'ok' | 'stale' | 'auth_required' | 'error' | 'absent';
export interface ServiceView {
  service: Service;
  label: string;
  state: ViewState;
  /** minutes since capturedAt; null when never seen */
  ageMin: number | null;
  capturedAt: string | null;
  /** 5-hour / weekly percent USED; null = unknown (never zero by default) */
  fiveHour: number | null;
  /** does the reading HAVE a 5-hour window at all? (Codex reports only a weekly one: no "5h -") */
  hasFiveHour: boolean;
  weekly: number | null;
  /** only when the plan is used up: using | unknown | blocked */
  credits: 'using' | 'unknown' | 'blocked' | null;
  /** tooltip detail: reset times and any other windows */
  windows: Window[];
  /** a non-ok reading's last good numbers, WITH their own timestamp (tooltip only) */
  lastGood: { capturedAt: string; windows: Window[] } | null;
  probeUp: boolean | null;
}

const isFiveHour = (l: string) => /5[- ]?hour|session/i.test(l);
const isWeeklyAll = (l: string) => /^weekly$/i.test(l.trim());

export function viewOf(service: Service, now: number = Date.now()): ServiceView {
  const base: ServiceView = {
    service, label: LABELS[service], state: 'absent', ageMin: null, capturedAt: null, fiveHour: null, hasFiveHour: false, weekly: null,
    credits: null, windows: [], lastGood: null, probeUp: heartbeats.get(service)?.up ?? null,
  };
  const cur = stored.get(service);
  if (!cur) {
    return base;
  }
  const { reading } = cur;
  const age = Math.max(0, now - Date.parse(reading.capturedAt));
  const view: ServiceView = { ...base, capturedAt: reading.capturedAt, ageMin: Math.floor(age / 60_000), lastGood: reading.lastGood };
  if (reading.status === 'auth_required') {
    return { ...view, state: 'auth_required' };
  }
  if (reading.status !== 'ok') {
    return { ...view, state: 'error' };
  }
  view.windows = reading.windows;
  const five = reading.windows.find((w) => isFiveHour(w.label));
  view.hasFiveHour = !!five;
  view.fiveHour = five?.usedPct ?? null;
  view.weekly = reading.windows.find((w) => isWeeklyAll(w.label))?.usedPct ?? null;
  const a = reading.allowance;
  if (a?.state === 'exhausted') {
    view.credits = a.blocked === true ? 'blocked' : a.usingCredits === true ? 'using' : 'unknown';
  }
  view.state = age > STALE_MS ? 'stale' : 'ok';
  return view;
}

export function snapshot(now: number = Date.now()): { services: ServiceView[]; hardware: HardwareView; counters: typeof counters; nats: boolean } {
  return { services: SERVICES.map((s) => viewOf(s, now)), hardware: hardwareView(now), counters: { ...counters }, nats: telemetry.enabled() };
}

let started = false;
/** Subscribe once. A no-op (and silent) when NATS is off. */
export function start(): void {
  if (started) {
    return;
  }
  started = true;
  telemetry.subscribe('telemetry.app.agent-usage.*.reading', (subject, body) => ingest(subject, body));
  telemetry.subscribe('telemetry.service.agent-usage-*.health', (subject, body) => ingest(subject, body));
  for (const k of ['cpu', 'memory', 'temperature', 'gpu']) {
    telemetry.subscribe(`telemetry.hardware.${k}`, (subject, body) => ingest(subject, body)); // 1 Hz each: cheap, and only these four
  }
}

/** Test seam: forget everything. */
export function reset(): void {
  stored.clear();
  heartbeats.clear();
  hw.clear();
  counters.accepted = 0;
  counters.dropped = 0;
}
