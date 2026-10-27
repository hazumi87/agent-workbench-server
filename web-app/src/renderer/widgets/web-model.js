// Widgets in the web build (the owner : inside the window only, with the same abilities; the design notes W1,
// W2, W4, W5 carried over, W3 dropped: a browser page cannot put a panel outside its own window). The in-window
// layer's model, pure: no DOM, no storage of its own. One widget per (module, node), only for a bundled, enabled
// widget module holding ui.widget, only node 'local'; at most MAX_OPEN at once. A new widget starts centred, after
// that at its stored four-zone anchor (geometry.js); a drag, arrow keys, a shape change and a layer resize keep it
// reachable; anchor and shape persist per (module, node) through `store` (the page keeps them per browser). A module
// that stops being listed, or comes back as a new generation, closes. The two widget verbs and nothing else:
// `usage` (GET /api/usage, answered as the bounded projection the desktop main made) and `shape` (a declared size).
// test/widget-web-model.test.mjs.
//
// deps: catalog() → the page's module list · store {read() → object|null, write(object)} ·
//       request(method, path) → Promise<{status, json}> (same-origin; throws when the engine does not answer)

import { centred, clamp, anchorOf, place, keyMove, readAnchor } from './geometry.js';
import { widgetRows, keyOf } from './list.js';

export const MAX_OPEN = 8;
const MAX_PLACES = 32;
const NODES = { local: 'This PC' };
const PLACE_KEY = /^[a-z0-9][a-z0-9_-]{0,40}\|local$/;
const SHAPES = ['wide', 'tall'];
const PAGE = /^ui\/[a-z0-9][a-z0-9_-]{0,40}\.html$/;

// the usage projection (from the desktop's src/widget-verbs.js projectUsage, unchanged in what it lets through)
const SERVICES = new Set(['claude', 'chatgpt']);
const STATES = new Set(['ok', 'stale', 'error', 'auth_required']);
const HW_STATES = new Set(['ok', 'stale', 'absent']);
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ()-]{0,39}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_WINDOWS = 8;
const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);
const count = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const time = (v) => (typeof v === 'string' && v.length <= 40 && TIME.test(v) ? v : null);

export function projectUsage(snap) {
  const s = isPlain(snap) ? snap : {};
  const services = [];
  for (const v of Array.isArray(s.services) ? s.services : []) {
    if (!isPlain(v) || !SERVICES.has(v.service) || services.some((x) => x.service === v.service)) continue;
    const windows = [];
    for (const w of Array.isArray(v.windows) ? v.windows : []) {
      if (windows.length >= MAX_WINDOWS) break;
      if (!isPlain(w) || typeof w.label !== 'string' || !LABEL.test(w.label)) continue;
      windows.push({ label: w.label, usedPct: pct(w.usedPct), resetsAt: time(w.resetsAt) });
    }
    services.push({ service: v.service, state: STATES.has(v.state) ? v.state : 'error', ageMin: count(v.ageMin, 1e6), capturedAt: time(v.capturedAt), windows });
  }
  const h = isPlain(s.hardware) ? s.hardware : {};
  const hardware = {
    state: HW_STATES.has(h.state) ? h.state : 'absent',
    cpuPct: pct(h.cpuPct), memPct: pct(h.memPct), gpuPct: pct(h.gpuPct),
    gpuMhz: count(h.gpuMhz, 1e5), gpuMaxMhz: count(h.gpuMaxMhz, 1e5), ageSec: count(h.ageSec, 1e8),
  };
  return { services, hardware };
}

const refused = (status, error, field) => ({ ok: false, kind: 'refused', status, error, field: field || null });
const REVOKED = Object.freeze({ ok: false, kind: 'revoked' });
const TRANSPORT = Object.freeze({ ok: false, kind: 'transport' });

/** The module's declared sizes, or null when its widget manifest is not one we draw. */
function sizesOf(m) {
  const w = m && m.widget;
  if (!isPlain(w) || w.realm !== 'app' || typeof w.page !== 'string' || !PAGE.test(w.page) || !isPlain(w.sizes)) return null;
  const out = {};
  for (const s of SHAPES) {
    const p = w.sizes[s];
    if (Array.isArray(p) && p.length === 2 && p.every((n) => Number.isInteger(n) && n > 0 && n <= 4096)) out[s] = { w: p[0], h: p[1] };
  }
  return Object.keys(out).length ? out : null;
}

export function createWidgetModel(deps) {
  const open = new Map(); // key → widget
  let layer = { w: 0, h: 0 };
  let places = readPlaces(deps.store.read());

  function readPlaces(v) {
    const out = new Map();
    const p = isPlain(v) && v.v === 1 && isPlain(v.places) ? v.places : {};
    for (const [k, e] of Object.entries(p)) {
      if (out.size >= MAX_PLACES) break;
      if (!PLACE_KEY.test(k) || !isPlain(e)) continue;
      out.set(k, { anchor: readAnchor(e.anchor), shape: SHAPES.includes(e.shape) ? e.shape : null });
    }
    return out;
  }
  function save(w) {
    places.delete(w.key); // newest last; the oldest go first past the cap
    places.set(w.key, { anchor: anchorOf(w.pos, layer, w.size), shape: w.shape });
    while (places.size > MAX_PLACES) places.delete(places.keys().next().value);
    const out = {};
    for (const [k, e] of places) out[k] = { anchor: e.anchor, shape: e.shape };
    try { deps.store.write({ v: 1, places: out }); } catch { /* a full or blocked store: the layout just isn't kept */ }
  }

  const listed = (m) => !!m && m.class === 'widget' && m.source === 'bundled' && m.enabled === true && !m.error &&
    Array.isArray(m.permissions) && m.permissions.includes('ui.widget') && !!sizesOf(m);
  const entry = (id) => deps.catalog().find((m) => m.id === id) || null;
  const current = (w) => open.get(w.key) === w && listed(entry(w.moduleId)) && (entry(w.moduleId).gen ?? 0) === w.gen;

  function pageOf(w) {
    return w.basePage + '?surface=widget&node=' + w.node + '&shape=' + w.shape;
  }

  function setShape(key, shape) {
    const w = open.get(key);
    if (!w || !SHAPES.includes(shape) || !w.sizes[shape]) return null;
    w.shape = shape;
    w.size = w.sizes[shape];
    w.pos = clamp(w.pos, layer, w.size);
    w.page = pageOf(w);
    save(w);
    return w;
  }

  return Object.freeze({
    rows: (nodes) => widgetRows(deps.catalog(), nodes, [...open.keys()]),
    openKeys: () => [...open.keys()],
    widget: (key) => open.get(key) || null,

    open(a) {
      if (!a || typeof a.moduleId !== 'string' || a.node !== 'local') return refused(400, 'Only this PC has widgets for now.', 'node');
      const m = entry(a.moduleId);
      if (!listed(m)) return refused(403, 'Not a widget this app can show.', 'module');
      const key = keyOf(m.id, a.node);
      if (open.has(key)) return { ok: true, widget: open.get(key) };
      if (open.size >= MAX_OPEN) return refused(429, MAX_OPEN + ' widgets are open. Close one to open another.', 'cap');
      const sizes = sizesOf(m);
      const stored = places.get(key);
      const shape = stored && stored.shape && sizes[stored.shape] ? stored.shape : SHAPES.find((s) => sizes[s]);
      const size = sizes[shape];
      const w = {
        key, moduleId: m.id, node: a.node, gen: m.gen ?? 0, sizes, shape, size,
        title: String(m.name || m.id).slice(0, 60) + ' · ' + NODES[a.node],
        basePage: m.widget.page,
        pos: stored && stored.anchor ? place(stored.anchor, layer, size) : centred(layer, size),
      };
      w.page = pageOf(w);
      open.set(key, w);
      return { ok: true, widget: w };
    },

    close(key) {
      return open.delete(key);
    },
    closeAll() {
      const keys = [...open.keys()];
      open.clear();
      return keys;
    },

    /** After the catalog changed: close what is no longer listed or is a new generation. → the closed keys. */
    sync() {
      const gone = [];
      for (const w of [...open.values()]) if (!current(w)) { open.delete(w.key); gone.push(w.key); }
      return gone;
    },

    moveTo(key, pos) {
      const w = open.get(key);
      if (!w) return null;
      w.pos = clamp(pos, layer, w.size);
      save(w);
      return w.pos;
    },
    key(key, name, shift) {
      const w = open.get(key);
      if (!w) return null;
      const pos = keyMove(w.pos, name, !!shift, layer, w.size);
      if (!pos) return null;
      w.pos = pos;
      save(w);
      return pos;
    },
    setShape,

    /** The layer's new size: every open widget keeps its anchored edge distances, clamped. → the open widgets. */
    resize(next) {
      const was = layer;
      layer = { w: Math.max(0, Math.round(next.w)), h: Math.max(0, Math.round(next.h)) };
      for (const w of open.values()) w.pos = was.w && was.h ? place(anchorOf(w.pos, was, w.size), layer, w.size) : clamp(w.pos, layer, w.size);
      return [...open.values()];
    },

    /** A request from a widget's frame (its key from the host's own record, never from the frame). */
    async call(key, verb, input) {
      const w = open.get(key);
      if (!w || !current(w)) return REVOKED;
      if (verb === 'usage') {
        if (!isPlain(input) || Object.keys(input).length) return refused(400, 'usage takes no input.', 'input');
        let r;
        try {
          r = await deps.request('GET', '/api/usage');
        } catch {
          return current(w) ? TRANSPORT : REVOKED;
        }
        if (!current(w)) return REVOKED; // closed while the engine answered: the late reply is dropped
        if (!r || r.status !== 200) return TRANSPORT;
        return { ok: true, body: projectUsage(r.json) };
      }
      if (verb === 'shape') {
        if (!isPlain(input) || Object.keys(input).join(',') !== 'shape' || !SHAPES.includes(input.shape) || !w.sizes[input.shape]) {
          return refused(400, 'A shape is one of the sizes this widget declares.', 'input');
        }
        setShape(key, input.shape);
        return { ok: true, body: { shape: input.shape } };
      }
      return refused(403, 'Not a widget verb.', 'verb');
    },
  });
}
