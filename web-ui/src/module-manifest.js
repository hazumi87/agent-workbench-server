'use strict';
// The `tool` class's manifest checks (the design notes §1-§3, addendum A draft 2; P3).
// Pure: no Electron, no fs. main's scanModules calls checkToolManifest on a module.json whose class
// is "tool" and checkActions on the actions.json it points at; a manifest that fails is skipped
// with the reason, which Modules shows. test/module-manifest.test.mjs runs these over fixtures.

const TOOL_CONTEXTS = ['dashboard', 'tab', 'message-attachment', 'workroom', 'agent', 'concierge', '*'];
const TOOL_ROLES = ['tasks', 'viewer'];
const EXT_POINTS = ['toolbar', 'overlay', 'on-send'];
const OUTPUT_KINDS = ['text', 'image/svg+xml']; // P3: inline strings only
const INPUT_TYPES = ['string', 'boolean', 'number'];
const PROVIDES_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const ACCEPTS = /^(text|link|[a-z]+\/([a-z0-9.+-]+|\*))$/;
const ACTION_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 10000;

/** The relpath rule ui.registerTab applies to entry: inside the module, no .., no leading /, no scheme. */
function relpathOk(s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= 120 && /^[A-Za-z0-9._/-]+$/.test(s) && !s.startsWith('/') && !/^[a-z]+:/.test(s) && !s.includes('..');
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const uniq = (arr) => new Set(arr).size === arr.length;
const list = (arr) => arr.join(', ');

/** { ok: true, tool: {...} } or { ok: false, reason } for the tool part of a module.json. */
function checkToolManifest(man) {
  if (!isObj(man) || man.class !== 'tool') {
    return { ok: false, reason: 'class must be "tool"' };
  }
  const p = man.provides;
  if (!Array.isArray(p) || p.length < 1 || p.length > 8) {
    return { ok: false, reason: 'provides is required: a list of 1 to 8 registry ids, like ["hello.card"]' };
  }
  for (const id of p) {
    if (typeof id !== 'string' || id.length > 60 || !PROVIDES_ID.test(id)) {
      return { ok: false, reason: 'provides has a bad id ' + JSON.stringify(id) + ': two or more dotted parts, like hello.card' };
    }
  }
  if (!uniq(p)) {
    return { ok: false, reason: 'provides lists an id twice' };
  }
  if (man.role !== undefined && !TOOL_ROLES.includes(man.role)) {
    return { ok: false, reason: 'role ' + JSON.stringify(man.role) + ' is not one of ' + list(TOOL_ROLES) + ' (a new role is a plan change)' };
  }
  if (man.accepts !== undefined) {
    const a = man.accepts;
    if (!Array.isArray(a) || a.length > 16 || !uniq(a) || a.some((x) => typeof x !== 'string' || !ACCEPTS.test(x))) {
      return { ok: false, reason: 'accepts must list MIME types or families (image/*), or text / link, at most 16, each once' };
    }
  }
  const c = man.contexts;
  if (!Array.isArray(c) || c.length < 1 || !uniq(c)) {
    return { ok: false, reason: 'contexts is required: where the tool may appear, from ' + list(TOOL_CONTEXTS) };
  }
  for (const x of c) {
    if (!TOOL_CONTEXTS.includes(x)) {
      return { ok: false, reason: 'context ' + JSON.stringify(x) + ' is not one of ' + list(TOOL_CONTEXTS) };
    }
  }
  if (!relpathOk(man.actions)) {
    return { ok: false, reason: 'actions must be a path to actions.json inside the module (no .., no leading /, no scheme)' };
  }
  if (man.style !== undefined && !relpathOk(man.style)) {
    return { ok: false, reason: 'style must be a path inside the module (no .., no leading /, no scheme)' };
  }
  if (man.extends !== undefined) {
    const e = man.extends;
    if (!isObj(e) || typeof e.tool !== 'string' || !Array.isArray(e.points) || e.points.length < 1 || e.points.some((x) => !EXT_POINTS.includes(x)) || Object.keys(e).some((k) => k !== 'tool' && k !== 'points')) {
      return { ok: false, reason: 'extends must be { tool, points } with points from ' + list(EXT_POINTS) };
    }
  }
  if (man.exposes !== undefined && (!Array.isArray(man.exposes) || man.exposes.some((x) => !EXT_POINTS.includes(x)))) {
    return { ok: false, reason: 'exposes must list extension points from ' + list(EXT_POINTS) };
  }
  if (man.service !== undefined) {
    return { ok: false, reason: 'service is reserved: a server-backed tool waits for a later phase (service.json)' };
  }
  return {
    ok: true,
    tool: {
      provides: p.slice(),
      role: typeof man.role === 'string' ? man.role : null,
      accepts: Array.isArray(man.accepts) ? man.accepts.slice() : [],
      contexts: c.slice(),
      actions: man.actions,
      style: typeof man.style === 'string' ? man.style : null,
      extends: man.extends ? { tool: man.extends.tool, points: man.extends.points.slice() } : null,
      exposes: Array.isArray(man.exposes) ? man.exposes.slice() : [],
    },
  };
}

/** One input field in the settings-schema dialect the design notes already has. */
function fieldOk(def) {
  if (!isObj(def) || !INPUT_TYPES.includes(def.type)) {
    return false;
  }
  if (def.title !== undefined && typeof def.title !== 'string') return false;
  if (def.maxLength !== undefined && !(Number.isInteger(def.maxLength) && def.maxLength > 0)) return false;
  if (def.enum !== undefined && (!Array.isArray(def.enum) || !def.enum.length)) return false;
  for (const k of ['min', 'max', 'step']) {
    if (def[k] !== undefined && typeof def[k] !== 'number') return false;
  }
  return true;
}

/** { ok: true, actions: [...] } or { ok: false, reason } for actions.json against its manifest's tool part. */
function checkActions(doc, tool) {
  if (!isObj(doc) || !Array.isArray(doc.actions) || doc.actions.length < 1 || doc.actions.length > 32) {
    return { ok: false, reason: 'actions.json must hold { actions: [ 1 to 32 actions ] }' };
  }
  const out = [];
  const names = new Set();
  const manCtx = tool.contexts.includes('*') ? TOOL_CONTEXTS.filter((x) => x !== '*' && x !== 'agent' && x !== 'concierge') : tool.contexts;
  for (const a of doc.actions) {
    if (!isObj(a) || typeof a.name !== 'string' || !ACTION_NAME.test(a.name)) {
      return { ok: false, reason: 'an action needs a name like render (a-z, digits, dashes, at most 31)' };
    }
    if (names.has(a.name)) {
      return { ok: false, reason: 'action ' + a.name + ' is listed twice' };
    }
    names.add(a.name);
    const provides = a.provides === undefined ? tool.provides[0] : a.provides;
    if (!tool.provides.includes(provides)) {
      return { ok: false, reason: 'action ' + a.name + ' provides ' + JSON.stringify(provides) + ', which the manifest does not list' };
    }
    const input = a.input === undefined ? {} : a.input;
    if (!isObj(input) || Object.keys(input).length > 16 || Object.entries(input).some(([k, d]) => !/^[a-z][a-zA-Z0-9]{0,30}$/.test(k) || !fieldOk(d))) {
      return { ok: false, reason: 'action ' + a.name + ': input must be fields of type string, boolean or number (the settings dialect)' };
    }
    if (!isObj(a.output) || !OUTPUT_KINDS.includes(a.output.kind)) {
      return { ok: false, reason: 'action ' + a.name + ': output.kind must be ' + list(OUTPUT_KINDS) + ' in this phase (inline strings)' };
    }
    let contexts = manCtx;
    if (a.contexts !== undefined) {
      if (!Array.isArray(a.contexts) || !a.contexts.length || !uniq(a.contexts) || a.contexts.some((x) => !TOOL_CONTEXTS.includes(x))) {
        return { ok: false, reason: 'action ' + a.name + ': contexts must come from ' + list(TOOL_CONTEXTS) };
      }
      if (a.contexts.some((x) => !manCtx.includes(x))) {
        // against the expanded list: "*" never implies "agent" (§1.1), so an action can't claim it that way
        return { ok: false, reason: 'action ' + a.name + ': its contexts must be a subset of the manifest\'s (' + list(tool.contexts) + ')' };
      }
      contexts = a.contexts.slice();
    }
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (a.timeoutMs !== undefined) {
      if (!Number.isInteger(a.timeoutMs) || a.timeoutMs < 1 || a.timeoutMs > MAX_TIMEOUT_MS) {
        return { ok: false, reason: 'action ' + a.name + ': timeoutMs must be 1 to ' + MAX_TIMEOUT_MS };
      }
      timeoutMs = a.timeoutMs;
    }
    out.push({ name: a.name, title: typeof a.title === 'string' ? a.title.slice(0, 60) : a.name, provides, input, output: { kind: a.output.kind }, contexts, timeoutMs });
  }
  return { ok: true, actions: out };
}

/** A storage key or file name: inside the module's own folder, never a path. */
function storageNameOk(s) {
  return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s) && !s.includes('..');
}

// The `widget` class (the design notes revision 1 R1.1): a screen widget of the app, no actions and no main.
const WIDGET_KEYS = 'page,realm,sizes,transparent';
const WIDGET_SHAPES = ['wide', 'tall'];
const WIDGET_PAGE = /^ui\/[a-z0-9][a-z0-9_-]{0,40}\.html$/; // module-window.js's PAGE
const sizeOk = (s) => Array.isArray(s) && s.length === 2 && Number.isInteger(s[0]) && Number.isInteger(s[1]) && s[0] >= 160 && s[0] <= 960 && s[1] >= 96 && s[1] <= 640;

/** { ok: true, widget: {realm, sizes, page, transparent} } or { ok: false, reason } for a module.json whose class is "widget". */
function checkWidgetManifest(man) {
  if (!isObj(man) || man.class !== 'widget') return { ok: false, reason: 'class must be "widget"' };
  if (man.contexts !== undefined && !(Array.isArray(man.contexts) && man.contexts.length === 1 && man.contexts[0] === 'app')) {
    return { ok: false, reason: 'a widget\'s contexts are ["app"]' };
  }
  if (man.actions !== undefined) return { ok: false, reason: 'a widget has no actions' };
  if (man.main !== undefined) return { ok: false, reason: 'a widget has no main script' };
  if (!Array.isArray(man.permissions) || man.permissions.length !== 1 || man.permissions[0] !== 'ui.widget') {
    return { ok: false, reason: 'a widget\'s permissions are ["ui.widget"]' };
  }
  const w = man.widget;
  if (!isObj(w) || Object.keys(w).sort().join(',') !== WIDGET_KEYS) return { ok: false, reason: 'widget is {realm, sizes, page, transparent}' };
  if (w.realm !== 'app') return { ok: false, reason: 'widget.realm must be "app"' };
  if (w.transparent !== false) return { ok: false, reason: 'widget.transparent must be false' };
  const keys = isObj(w.sizes) ? Object.keys(w.sizes) : [];
  if (!keys.length || keys.some((k) => !WIDGET_SHAPES.includes(k)) || keys.some((k) => !sizeOk(w.sizes[k]))) {
    return { ok: false, reason: 'widget.sizes is wide and/or tall, each [width 160-960, height 96-640] in whole pixels' };
  }
  if (typeof w.page !== 'string' || !WIDGET_PAGE.test(w.page) || w.page.includes('..')) return { ok: false, reason: 'widget.page is ui/<name>.html' };
  const sizes = {};
  for (const k of WIDGET_SHAPES) if (keys.includes(k)) sizes[k] = [w.sizes[k][0], w.sizes[k][1]];
  return { ok: true, widget: { realm: 'app', sizes, page: w.page, transparent: false } };
}

module.exports = { checkWidgetManifest, checkToolManifest,checkActions, relpathOk, storageNameOk, TOOL_CONTEXTS, TOOL_ROLES, EXT_POINTS, OUTPUT_KINDS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
