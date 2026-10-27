/* The `tool` and `widget` classes' manifest checks (ported from workbench-app src/module-manifest.js; the design notes §1-§3,
 * addendum A draft 2; P3; the design notes revision 1 R1.1). Pure: no fs. The module scanner calls checkToolManifest on a module.json whose class is "tool" and checkActions on the actions.json it
 * points at; checkWidgetManifest does the same for a module.json whose class is "widget" (no actions, no main). A manifest that fails is skipped
 * with the reason, which Modules shows. test/modules-manifest.test.ts and test/modules-widget-manifest.test.ts run these over the fixtures in
 * test/fixtures/modules. */

export const TOOL_CONTEXTS = ['dashboard', 'tab', 'message-attachment', 'workroom', 'agent', 'concierge', '*'] as const;
export const TOOL_ROLES = ['tasks', 'viewer'] as const;
export const EXT_POINTS = ['toolbar', 'overlay', 'on-send'] as const;
export const OUTPUT_KINDS = ['text', 'image/svg+xml'] as const; // P3: inline strings only
const INPUT_TYPES = ['string', 'boolean', 'number'] as const;
const PROVIDES_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const ACCEPTS = /^(text|link|[a-z]+\/([a-z0-9.+-]+|\*))$/;
const ACTION_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export const MAX_TIMEOUT_MS = 120000;
export const DEFAULT_TIMEOUT_MS = 10000;

/** The relpath rule ui.registerTab applies to entry: inside the module, no .., no leading /, no scheme. */
export function relpathOk(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 1 && s.length <= 120 && /^[A-Za-z0-9._/-]+$/.test(s) && !s.startsWith('/') && !/^[a-z]+:/.test(s) && !s.includes('..');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const uniq = (arr: readonly unknown[]): boolean => new Set(arr).size === arr.length;
const list = (arr: readonly string[]): string => arr.join(', ');
const inList = (arr: readonly string[], v: unknown): v is string => typeof v === 'string' && arr.includes(v);

export interface ToolPart {
  provides: string[];
  role: string | null;
  accepts: string[];
  contexts: string[];
  actions: string;
  style: string | null;
  extends: { tool: string; points: string[] } | null;
  exposes: string[];
}
export interface Failed { ok: false; reason: string }

/** { ok: true, tool: {...} } or { ok: false, reason } for the tool part of a module.json. */
export function checkToolManifest(man: unknown): { ok: true; tool: ToolPart } | Failed {
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
  if (man.role !== undefined && !inList(TOOL_ROLES, man.role)) {
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
    if (!inList(TOOL_CONTEXTS, x)) {
      return { ok: false, reason: 'context ' + JSON.stringify(x) + ' is not one of ' + list(TOOL_CONTEXTS) };
    }
  }
  if (!relpathOk(man.actions)) {
    return { ok: false, reason: 'actions must be a path to actions.json inside the module (no .., no leading /, no scheme)' };
  }
  if (man.style !== undefined && !relpathOk(man.style)) {
    return { ok: false, reason: 'style must be a path inside the module (no .., no leading /, no scheme)' };
  }
  let ext: ToolPart['extends'] = null;
  if (man.extends !== undefined) {
    const e = man.extends;
    if (!isObj(e) || typeof e.tool !== 'string' || !Array.isArray(e.points) || e.points.length < 1 || e.points.some((x) => !inList(EXT_POINTS, x)) || Object.keys(e).some((k) => k !== 'tool' && k !== 'points')) {
      return { ok: false, reason: 'extends must be { tool, points } with points from ' + list(EXT_POINTS) };
    }
    ext = { tool: e.tool, points: e.points.slice() };
  }
  if (man.exposes !== undefined && (!Array.isArray(man.exposes) || man.exposes.some((x) => !inList(EXT_POINTS, x)))) {
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
      extends: ext,
      exposes: Array.isArray(man.exposes) ? man.exposes.slice() : [],
    },
  };
}

/** One input field in the settings-schema dialect PLAN-modules already has. */
function fieldOk(def: unknown): boolean {
  if (!isObj(def) || !inList(INPUT_TYPES, def.type)) {
    return false;
  }
  if (def.title !== undefined && typeof def.title !== 'string') return false;
  if (def.maxLength !== undefined && !(typeof def.maxLength === 'number' && Number.isInteger(def.maxLength) && def.maxLength > 0)) return false;
  if (def.enum !== undefined && (!Array.isArray(def.enum) || !def.enum.length)) return false;
  for (const k of ['min', 'max', 'step']) {
    if (def[k] !== undefined && typeof def[k] !== 'number') return false;
  }
  return true;
}

export interface ActionOut {
  name: string;
  title: string;
  provides: string;
  input: Obj;
  output: { kind: string };
  contexts: string[];
  timeoutMs: number;
}

/** { ok: true, actions: [...] } or { ok: false, reason } for actions.json against its manifest's tool part. */
export function checkActions(doc: unknown, tool: ToolPart): { ok: true; actions: ActionOut[] } | Failed {
  if (!isObj(doc) || !Array.isArray(doc.actions) || doc.actions.length < 1 || doc.actions.length > 32) {
    return { ok: false, reason: 'actions.json must hold { actions: [ 1 to 32 actions ] }' };
  }
  const out: ActionOut[] = [];
  const names = new Set<string>();
  const manCtx: string[] = tool.contexts.includes('*') ? TOOL_CONTEXTS.filter((x) => x !== '*' && x !== 'agent' && x !== 'concierge') : tool.contexts;
  for (const a of doc.actions as unknown[]) {
    if (!isObj(a) || typeof a.name !== 'string' || !ACTION_NAME.test(a.name)) {
      return { ok: false, reason: 'an action needs a name like render (a-z, digits, dashes, at most 31)' };
    }
    if (names.has(a.name)) {
      return { ok: false, reason: 'action ' + a.name + ' is listed twice' };
    }
    names.add(a.name);
    const provides = a.provides === undefined ? tool.provides[0] : a.provides;
    if (!inList(tool.provides, provides)) {
      return { ok: false, reason: 'action ' + a.name + ' provides ' + JSON.stringify(provides) + ', which the manifest does not list' };
    }
    const input = a.input === undefined ? {} : a.input;
    if (!isObj(input) || Object.keys(input).length > 16 || Object.entries(input).some(([k, d]) => !/^[a-z][a-zA-Z0-9]{0,30}$/.test(k) || !fieldOk(d))) {
      return { ok: false, reason: 'action ' + a.name + ': input must be fields of type string, boolean or number (the settings dialect)' };
    }
    if (!isObj(a.output) || !inList(OUTPUT_KINDS, a.output.kind)) {
      return { ok: false, reason: 'action ' + a.name + ': output.kind must be ' + list(OUTPUT_KINDS) + ' in this phase (inline strings)' };
    }
    let contexts = manCtx;
    if (a.contexts !== undefined) {
      if (!Array.isArray(a.contexts) || !a.contexts.length || !uniq(a.contexts) || a.contexts.some((x) => !inList(TOOL_CONTEXTS, x))) {
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
      if (typeof a.timeoutMs !== 'number' || !Number.isInteger(a.timeoutMs) || a.timeoutMs < 1 || a.timeoutMs > MAX_TIMEOUT_MS) {
        return { ok: false, reason: 'action ' + a.name + ': timeoutMs must be 1 to ' + MAX_TIMEOUT_MS };
      }
      timeoutMs = a.timeoutMs;
    }
    out.push({ name: a.name, title: typeof a.title === 'string' ? a.title.slice(0, 60) : a.name, provides, input, output: { kind: a.output.kind }, contexts, timeoutMs });
  }
  return { ok: true, actions: out };
}

/** A storage key or file name: inside the module's own folder, never a path. */
export function storageNameOk(s: unknown): boolean {
  return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s) && !s.includes('..');
}

// The `widget` class (the design notes revision 1 R1.1): a screen widget of the app, no actions and no main.
const WIDGET_KEYS = 'page,realm,sizes,transparent';
export const WIDGET_SHAPES = ['wide', 'tall'] as const;
export type WidgetShape = (typeof WIDGET_SHAPES)[number];
const WIDGET_PAGE = /^ui\/[a-z0-9][a-z0-9_-]{0,40}\.html$/; // module-window.js's PAGE
const sizeOk = (s: unknown): boolean => Array.isArray(s) && s.length === 2 && Number.isInteger(s[0]) && Number.isInteger(s[1]) && s[0] >= 160 && s[0] <= 960 && s[1] >= 96 && s[1] <= 640;

export interface WidgetPart {
  realm: 'app';
  sizes: Partial<Record<WidgetShape, [number, number]>>;
  page: string;
  transparent: false;
}

/** { ok: true, widget: {realm, sizes, page, transparent} } or { ok: false, reason } for a module.json whose class is "widget". */
export function checkWidgetManifest(man: unknown): { ok: true; widget: WidgetPart } | Failed {
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
  const sz: Obj = isObj(w.sizes) ? w.sizes : {};
  const keys = Object.keys(sz);
  if (!keys.length || keys.some((k) => !(WIDGET_SHAPES as readonly string[]).includes(k)) || keys.some((k) => !sizeOk(sz[k]))) {
    return { ok: false, reason: 'widget.sizes is wide and/or tall, each [width 160-960, height 96-640] in whole pixels' };
  }
  if (typeof w.page !== 'string' || !WIDGET_PAGE.test(w.page) || w.page.includes('..')) return { ok: false, reason: 'widget.page is ui/<name>.html' };
  const sizes: WidgetPart['sizes'] = {};
  for (const k of WIDGET_SHAPES) if (keys.includes(k)) { const v = sz[k] as number[]; sizes[k] = [v[0], v[1]]; }
  return { ok: true, widget: { realm: 'app', sizes, page: w.page, transparent: false } };
}
