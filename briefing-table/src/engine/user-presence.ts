/* ============================================================================
 * USER DEVICE PRESENCE [Owner room [ref]]: where is the person coming from?
 *
 * Pages report a coarse descriptor (web/device-report.mjs); agents read one
 * answer (GET /api/presence/user). This module is the pure half: validation,
 * the in-memory store, the active/recent/primary/summary logic. No http, no db.
 *
 * WHAT IS KEPT: per (person, device, instance) the last descriptor + timestamps,
 * in memory only (a restart forgets it; the next page report re-creates it).
 * A device is one browser profile (localStorage id); an INSTANCE is one page
 * load, because a shell holds several tabs under one device and a hidden tab's
 * report must not cancel the visible tab's.
 *   active  last report < 3 min ago AND some instance visible
 *   recent  last report < 30 min ago (not active)
 *   gone    older: dropped from the live list, kept in `history` for 24 h
 * `laptop` is deliberately not a class: a web page cannot tell a laptop from a
 * desktop, and a wrong confident answer is worse than the coarser true one.
 * PRIVACY: no IP, no user-agent string; unknown keys are dropped at the door.
 * ========================================================================== */

export const ACTIVE_MS = 3 * 60_000;
export const RECENT_MS = 30 * 60_000;
export const HISTORY_MS = 24 * 3_600_000;
export const RATE_PER_MIN = 20; // per device id: load + visibility flaps + the 60 s tick fit well inside
const MAX_INSTANCES = 8; // per device
const MAX_DEVICES = 24; // per person
const MAX_HISTORY = 100; // per person

export const CLASSES = ['phone', 'tablet', 'desktop'] as const; // 'laptop' is not reliably knowable from a page
export const SURFACES = ['browser', 'shell-tab', 'native-window'] as const;
export const PAGES = ['room', 'workbench', 'manager', 'solo'] as const;
export const BROWSERS = ['Safari', 'Chrome', 'Edge', 'Firefox', 'Other'] as const;
export const OSES = ['iOS', 'Android', 'macOS', 'Windows', 'Linux', 'Other'] as const;

export interface Descriptor {
  device: string;
  instance: string;
  class: (typeof CLASSES)[number];
  surface: (typeof SURFACES)[number];
  page: (typeof PAGES)[number];
  browser: (typeof BROWSERS)[number];
  os: (typeof OSES)[number];
  viewport: { w: number; h: number };
  standalone: boolean;
  visible: boolean;
  label: string;
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const dim = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 20000 ? Math.round(v) : null);

export function validateDescriptor(b: unknown): { ok: true; value: Descriptor } | { ok: false; error: string } {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'the body is a JSON object' };
  const o = b as Record<string, unknown>;
  if (typeof o.device !== 'string' || !ID.test(o.device)) return { ok: false, error: 'device: 8-64 chars of A-Z a-z 0-9 _ -' };
  if (typeof o.instance !== 'string' || !ID.test(o.instance)) return { ok: false, error: 'instance: 8-64 chars of A-Z a-z 0-9 _ -' };
  const cls = oneOf(CLASSES, o.class);
  if (!cls) return { ok: false, error: `class: one of ${CLASSES.join(', ')}` };
  const surface = oneOf(SURFACES, o.surface);
  if (!surface) return { ok: false, error: `surface: one of ${SURFACES.join(', ')}` };
  const page = oneOf(PAGES, o.page);
  if (!page) return { ok: false, error: `page: one of ${PAGES.join(', ')}` };
  const browser = oneOf(BROWSERS, o.browser);
  if (!browser) return { ok: false, error: `browser: one of ${BROWSERS.join(', ')}` };
  const os = oneOf(OSES, o.os);
  if (!os) return { ok: false, error: `os: one of ${OSES.join(', ')}` };
  const vp = o.viewport as Record<string, unknown> | undefined;
  const w = dim(vp?.w);
  const h = dim(vp?.h);
  if (w === null || h === null) return { ok: false, error: 'viewport: {w,h} numbers 0-20000' };
  if (typeof o.visible !== 'boolean') return { ok: false, error: 'visible: true or false' };
  if (o.standalone !== undefined && typeof o.standalone !== 'boolean') return { ok: false, error: 'standalone: true or false' };
  if (o.label !== undefined && typeof o.label !== 'string') return { ok: false, error: 'label: a string' };
  /* a label is display text: printable, one line, capped (it is shown to agents, so no control characters) */
  const label = typeof o.label === 'string' ? o.label.replace(/[^\x20-\x7e -￿]/g, '').slice(0, 60).trim() : '';
  return {
    ok: true,
    value: { device: o.device, instance: o.instance, class: cls, surface, page, browser, os, viewport: { w, h }, standalone: o.standalone === true, visible: o.visible, label },
  };
}

interface Inst {
  d: Descriptor;
  firstAt: number;
  lastAt: number;
}
interface Hist {
  device: string;
  class: Descriptor['class'];
  browser: string;
  os: string;
  label: string;
  lastSeen: number;
}
const people = new Map<string, { devices: Map<string, Map<string, Inst>>; history: Map<string, Hist> }>();
const rates = new Map<string, number[]>();

export function reset(): void {
  people.clear();
  rates.clear();
}

/** One more report from this device? False once it passes RATE_PER_MIN in a minute. */
export function takeReport(device: string, now = Date.now()): boolean {
  const q = (rates.get(device) ?? []).filter((t) => now - t < 60_000);
  if (q.length >= RATE_PER_MIN) {
    rates.set(device, q);
    return false;
  }
  q.push(now);
  rates.set(device, q);
  if (rates.size > 500) {
    for (const [k, v] of rates) if (!v.some((t) => now - t < 60_000)) rates.delete(k);
  }
  return true;
}

export function record(person: string, d: Descriptor, now = Date.now()): void {
  let p = people.get(person);
  if (!p) people.set(person, (p = { devices: new Map(), history: new Map() }));
  let insts = p.devices.get(d.device);
  if (!insts) {
    if (p.devices.size >= MAX_DEVICES) {
      const oldest = [...p.devices.entries()].sort((a, b) => lastOf(a[1]) - lastOf(b[1]))[0];
      if (oldest) p.devices.delete(oldest[0]);
    }
    p.devices.set(d.device, (insts = new Map()));
  }
  const prev = insts.get(d.instance);
  insts.set(d.instance, { d, firstAt: prev?.firstAt ?? now, lastAt: now });
  if (insts.size > MAX_INSTANCES) {
    const oldest = [...insts.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
    if (oldest) insts.delete(oldest[0]);
  }
  p.history.set(d.device, { device: d.device, class: d.class, browser: d.browser, os: d.os, label: d.label, lastSeen: now });
  if (p.history.size > MAX_HISTORY) {
    const oldest = [...p.history.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest) p.history.delete(oldest[0]);
  }
}
const lastOf = (m: Map<string, Inst>): number => Math.max(0, ...[...m.values()].map((i) => i.lastAt));

export interface DeviceView {
  device: string;
  class: Descriptor['class'];
  surface: Descriptor['surface'];
  page: Descriptor['page'];
  browser: string;
  os: string;
  viewport: { w: number; h: number };
  standalone: boolean;
  visible: boolean;
  label: string;
  since: string;
  lastSeen: string;
}
export interface UserPresence {
  person: string | null;
  active: DeviceView[];
  recent: DeviceView[];
  primary: DeviceView | null;
  summary: string;
  asOf: string;
}

/** Fold one device's instances to ONE row: the freshest VISIBLE-and-fresh instance speaks for it, else the freshest. */
function foldDevice(insts: Map<string, Inst>, now: number): { view: DeviceView; active: boolean; lastAt: number } | null {
  const all = [...insts.values()];
  if (!all.length) return null;
  const lastAt = Math.max(...all.map((i) => i.lastAt));
  const live = all.filter((i) => i.d.visible && now - i.lastAt < ACTIVE_MS).sort((a, b) => b.lastAt - a.lastAt);
  const rep = live[0] ?? all.sort((a, b) => b.lastAt - a.lastAt)[0];
  const active = live.length > 0;
  const d = rep.d;
  return {
    active,
    lastAt,
    view: {
      device: d.device, class: d.class, surface: d.surface, page: d.page, browser: d.browser, os: d.os, viewport: d.viewport,
      standalone: d.standalone, visible: active, label: d.label,
      since: new Date(Math.min(...all.map((i) => i.firstAt))).toISOString(),
      lastSeen: new Date(lastAt).toISOString(),
    },
  };
}

const PAGE_WORD: Record<string, string> = { room: 'a room', workbench: 'the Workbench', manager: 'the CLI Manager', solo: 'an agent window' };
const CLASS_WORD: Record<string, string> = { phone: 'a phone', tablet: 'a tablet', desktop: 'a desktop' };

function hardware(v: DeviceView): string {
  const m = /^(iPhone|iPad|Mac|Android|Windows)\b/.exec(v.label);
  return m ? m[1] : v.os;
}
const mins = (ms: number): string => (ms < 90_000 ? 'under a minute' : `${Math.round(ms / 60_000)} min`);

export function summarize(person: string | null, active: DeviceView[], recent: DeviceView[], primary: DeviceView | null, now: number): string {
  const who = person || 'The user';
  const desc = (v: DeviceView): string => `${CLASS_WORD[v.class]} (${hardware(v)}, ${v.browser})`;
  if (!primary) {
    const r = recent[0];
    return r ? `${who} has no visible page; last seen on ${desc(r)} ${mins(now - Date.parse(r.lastSeen))} ago.` : `${who} has no device reporting.`;
  }
  let s = `${who} is on ${desc(primary)} in ${PAGE_WORD[primary.page]}, active now`;
  const others = [...active.filter((a) => a !== primary), ...recent].slice(0, 2);
  if (others.length) {
    s += `; also ${others.map((o) => `${desc(o)} ${active.includes(o) ? 'visible' : `idle ${mins(now - Date.parse(o.lastSeen))}`}`).join(', ')}`;
  }
  return s;
}

/** The one answer an agent reads. `name` is the person's display name (null: "The user"). */
export function query(person: string, name: string | null, now = Date.now()): UserPresence {
  const p = people.get(person);
  const active: Array<{ v: DeviceView; at: number }> = [];
  const recent: Array<{ v: DeviceView; at: number }> = [];
  if (p) {
    for (const [id, insts] of p.devices) {
      const f = foldDevice(insts, now);
      if (!f) continue;
      if (now - f.lastAt >= RECENT_MS) {
        if (now - f.lastAt >= HISTORY_MS) p.devices.delete(id); // past `recent`: off the live list (history keeps it for 24 h)
        continue;
      }
      (f.active ? active : recent).push({ v: f.view, at: f.lastAt });
    }
    for (const [id, h] of p.history) if (now - h.lastSeen >= HISTORY_MS) p.history.delete(id);
  }
  const byFresh = (a: { at: number }, b: { at: number }) => b.at - a.at;
  const A = active.sort(byFresh).map((x) => x.v);
  const R = recent.sort(byFresh).map((x) => x.v);
  const primary = A[0] ?? null;
  return { person: name, active: A, recent: R, primary, summary: summarize(name, A, R, primary, now), asOf: new Date(now).toISOString() };
}

/** Devices seen in the last 24 h, including those past `recent` (what the live list drops). */
export function history(person: string, now = Date.now()): Hist[] {
  const p = people.get(person);
  if (!p) return [];
  return [...p.history.values()].filter((h) => now - h.lastSeen < HISTORY_MS).sort((a, b) => b.lastSeen - a.lastSeen);
}
