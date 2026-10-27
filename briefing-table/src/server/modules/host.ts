/* THE WEB MODULE HOST, engine side (web-first pilot; seam: SEAM-web-module-host.md). Bundled modules live in the app dir (<app>/modules/<id>/module.json, shipped with the app); a plugin is OFF unless
 * HARBOR_WB_PLUGINS=1 and is not served by this file yet (M6). This file is the catalog (M2), module storage (M3) and the sandboxed UI files (M1); task admission (M4) is admission.ts.
 *   GET  /api/modules                         the catalog
 *   PUT  /api/modules/:id/enabled {enabled}   a person turns a module on or off
 *   GET|PUT|DELETE /api/modules/:id/storage[/:name]   per-module key/value (needs the `storage` permission; a value is at most 256 KB)
 *   GET  /app/modules/<id>/ui/*               the module's pages: sandbox CSP, nosniff, no-store; realpath inside ui/
 * Anything under /app/plugins/ is a 404 here (a plugin's files are served only after M6's consent record matches). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkToolManifest, storageNameOk, type ToolPart } from './manifest.ts';
import { inside, parseUiPath } from './ui-paths.ts';
import { build, DELETE } from './verbs.ts';
import { createApprovals } from './approval.ts';
import type { PluginScan } from './plugins.ts';
import { createBudget } from './budget.ts';

export const STORAGE_VALUE_MAX = 256 * 1024;
export const STORAGE_TOTAL_MAX = 2 * 1024 * 1024;
const MODULE_ID = /^[a-z][a-z0-9-]{0,40}$/;

/** The CSP of every M1 file: it wins over the /app policy. `sandbox allow-scripts` keeps the page opaque-origin even when opened top-level; `connect-src 'none'` leaves it only its message port. */
export const UI_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  class: string;
  source: 'bundled' | 'plugin';
  root: string;
  /** a plugin's scan (its consent gate); null for a bundled module */
  plugin: PluginScan | null;
  permissions: string[];
  tool: ToolPart | null;
  error: string | null;
}

export interface HostDeps {
  appRoot: string;
  getSetting: (key: string) => unknown;
  setSetting: (key: string, value: unknown) => void;
  /** M4: run one admitted call through the engine's OWN routes with the person's credentials; the answer is the route's. */
  /** plugins (M6): the scan of <data>/plugins with each one's consent gate, the per-file pin check, and the enable switch; absent = no plugins */
  plugins?: {
    scan: () => PluginScan[];
    fileServable: (p: PluginScan, rel: string, bytes: Buffer) => boolean;
    mayEnable: (p: PluginScan) => boolean;
    setEnabled: (id: string, on: boolean) => void;
  };
  dispatch?: (call: { method: string; path: string; body: Record<string, unknown> | null }, cookie: string) => Promise<{ status: number; text: string }>;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Scan <app>/modules/*; a module that fails its checks stays in the list with the reason and is never served or enabled. */
export function scanBundled(appRoot: string): CatalogEntry[] {
  const dir = join(appRoot, 'modules');
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const n of names.sort()) {
    if (!MODULE_ID.test(n)) continue;
    const root = join(dir, n);
    try {
      if (!statSync(root).isDirectory()) continue;
      const man = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8')) as Record<string, unknown>;
      const id = typeof man.id === 'string' ? man.id : '';
      let error: string | null = null;
      if (id !== n) error = 'the module id must match its folder name';
      else if (seen.has(id.toLowerCase())) error = 'a module with this id (ignoring case) is already listed';
      let tool: ToolPart | null = null;
      if (!error && man.class === 'tool') {
        const c = checkToolManifest(man);
        if (c.ok) tool = c.tool;
        else error = c.reason;
      }
      seen.add(id.toLowerCase());
      out.push({
        id: n,
        name: str(man.name, 80) || n,
        version: str(man.version, 40),
        class: str(man.class, 20),
        source: 'bundled',
        plugin: null,
        root,
        permissions: Array.isArray(man.permissions) ? man.permissions.filter((p): p is string => typeof p === 'string').slice(0, 32) : [],
        tool,
        error,
      });
    } catch (e) {
      out.push({ id: n, name: n, version: '', class: '', source: 'bundled', plugin: null, root, permissions: [], tool: null, error: `module.json: ${(e as Error).message}`.slice(0, 200) });
    }
  }
  return out;
}

const DISABLED_KEY = 'modules.disabled';
const EPOCH = Math.floor(Date.now() / 1000); // the approval scope's engine epoch: a token never outlives a restart
const storeKey = (id: string): string => `modules.storage.${id}`;

export function createHost(deps: HostDeps) {
  const disabled = (): string[] => {
    const v = deps.getSetting(DISABLED_KEY);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  const pluginEntry = (p: PluginScan): CatalogEntry => {
    const tool = !p.error && p.man.class === 'tool' ? checkToolManifest(p.man) : null;
    return {
      id: p.id, name: p.gm.name ?? p.id, version: p.gm.version ?? '', class: typeof p.man.class === 'string' ? p.man.class : '', source: 'plugin', plugin: p, root: p.root,
      permissions: Array.isArray(p.man.permissions) ? p.man.permissions.filter((x): x is string => typeof x === 'string') : [],
      tool: tool && tool.ok ? tool.tool : null, error: p.error ?? (tool && !tool.ok ? tool.reason : null),
    };
  };
  const catalog = (): CatalogEntry[] => {
    const bundled = scanBundled(deps.appRoot);
    const taken = new Set(bundled.map((b) => b.id.toLowerCase()));
    // a plugin never takes a bundled module's id (case-folded); the check refuses it at install, this keeps a hand-placed folder from shadowing one
    return [...bundled, ...(deps.plugins?.scan() ?? []).filter((p) => !taken.has(p.id.toLowerCase())).map(pluginEntry)];
  };
  const find = (id: string): CatalogEntry | undefined => catalog().find((e) => e.id === id);
  const isOn = (e: CatalogEntry): boolean => !e.error && (e.plugin ? e.plugin.gate.enabled : !disabled().includes(e.id));
  const usable = (e: CatalogEntry | undefined): e is CatalogEntry => !!e && isOn(e);
  const view = (e: CatalogEntry) => ({
    id: e.id, name: e.name, version: e.version, class: e.class, source: e.source, permissions: e.permissions,
    contexts: e.tool?.contexts ?? [], role: e.tool?.role ?? null, enabled: isOn(e), error: e.error,
    ...(e.plugin ? { consent: e.plugin.gate.consent, ...pluginEntryOf(e.plugin) } : {}),
  });
  const approvals = createApprovals();
  const budget = createBudget();
  const readStore = (id: string): Record<string, string> => {
    const v = deps.getSetting(storeKey(id));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  };

  /** M1. true = handled (a 404 included). */
  function serveUi(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (pathname === '/app/plugins' || pathname.startsWith('/app/plugins/')) {
      /* a plugin's pages only, only while its consent record matches, and each file only if its bytes are the pinned ones (P8); its main script or anything else is never served (P9) */
      if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
      const pp = parseUiPath('plugins', pathname);
      const pe = pp ? find(pp.id) : undefined;
      if (!pp || !pe || pe.source !== 'plugin' || !pe.plugin || !usable(pe)) return notFound(res);
      try {
        const uiRoot = realpathSync(join(pe.root, 'ui'));
        const file = realpathSync(join(pe.root, pp.rel));
        if (!inside(uiRoot, file) || !statSync(file).isFile()) return notFound(res);
        const body = readFileSync(file);
        if (!deps.plugins?.fileServable(pe.plugin, pp.rel, body)) return notFound(res);
        res.writeHead(200, { 'content-type': pp.type, 'content-length': String(body.length), 'content-security-policy': UI_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'access-control-allow-origin': 'null', vary: 'Origin' });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        return notFound(res);
      }
      return true;
    }
    if (!pathname.startsWith('/app/modules/')) return false;
    const rest = pathname.slice('/app/modules/'.length);
    if (!rest.includes('/ui/') && !rest.endsWith('/ui')) return false; // the module's main script and assets are the normal /app mount's
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    const p = parseUiPath('modules', pathname);
    const e = p ? find(p.id) : undefined;
    if (!p || !usable(e) || e.source !== 'bundled') return notFound(res);
    try {
      const uiRoot = realpathSync(join(e.root, 'ui'));
      const file = realpathSync(join(e.root, p.rel));
      if (!inside(uiRoot, file) || !statSync(file).isFile()) return notFound(res);
      const body = readFileSync(file);
      res.writeHead(200, {
        'content-type': p.type,
        'content-length': String(body.length),
        'content-security-policy': UI_CSP,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'access-control-allow-origin': 'null',
        vary: 'Origin',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      return notFound(res);
    }
    return true;
  }

  /** M2 + M3. true = handled. `human` = a signed-in person (not an agent); `readBody` parses the JSON body. */
  async function handleApi(req: IncomingMessage, _res: ServerResponse, route: string, ctx: { human: boolean; readBody: () => Promise<unknown>; send: (status: number, body: unknown) => void }): Promise<boolean> {
    if (route === '/api/modules' && req.method === 'GET') {
      ctx.send(200, { modules: catalog().map(view), plugins: { enabled: process.env.HARBOR_WB_PLUGINS === '1' } });
      return true;
    }
    const tm = /^\/api\/modules\/([a-z][a-z0-9-]{0,40})\/rooms\/([A-Za-z0-9_-]{1,80})\/tasks(\/approve)?$/.exec(route);
    if (tm) {
      await admit(req, ctx, tm[1], tm[2], !!tm[3]);
      return true;
    }
    const m = /^\/api\/modules\/([a-z][a-z0-9-]{0,40})\/(enabled|storage)(?:\/([^/]+))?$/.exec(route);
    if (!m) return false;
    const [, id, what, nameRaw] = m;
    const e = find(id);
    if (!e) {
      ctx.send(404, { error: 'no such module', field: 'id' });
      return true;
    }
    if (what === 'enabled') {
      if (req.method !== 'PUT') return ctx.send(405, { error: 'method not allowed' }), true;
      if (!ctx.human) return ctx.send(403, { error: 'person_only', message: 'only the signed-in person turns a module on or off' }), true;
      const b = (await ctx.readBody().catch(() => null)) as Record<string, unknown> | null;
      if (!b || typeof b.enabled !== 'boolean') return ctx.send(400, { error: 'enabled (boolean) is required', field: 'enabled' }), true;
      if (b.enabled && e.error) return ctx.send(409, { error: `this module cannot be enabled: ${e.error}`, field: 'id' }), true;
      if (e.plugin) {
        if (b.enabled && !deps.plugins?.mayEnable(e.plugin)) return ctx.send(409, { error: 'this plugin is held until you allow it again (its files or permissions changed)', field: 'id' }), true;
        deps.plugins?.setEnabled(id, b.enabled);
        return ctx.send(200, view(find(id) ?? e)), true;
      }
      const rest = disabled().filter((x) => x !== id);
      deps.setSetting(DISABLED_KEY, b.enabled ? rest : [...rest, id]);
      ctx.send(200, view(e));
      return true;
    }
    // storage
    if (!usable(e)) return ctx.send(404, { error: 'that module is off or in error', field: 'id' }), true;
    if (!e.permissions.includes('storage')) return ctx.send(403, { error: 'the module does not hold the storage permission', field: 'id' }), true;
    const store = readStore(id);
    if (!nameRaw) {
      if (req.method !== 'GET') return ctx.send(405, { error: 'method not allowed' }), true;
      ctx.send(200, { names: Object.keys(store).sort() });
      return true;
    }
    let name: string;
    try {
      name = decodeURIComponent(nameRaw);
    } catch {
      return ctx.send(400, { error: 'bad name', field: 'name' }), true;
    }
    if (!storageNameOk(name)) return ctx.send(400, { error: 'a plain name: letters, digits, dot, dash, underscore', field: 'name' }), true;
    if (req.method === 'GET') {
      if (!Object.prototype.hasOwnProperty.call(store, name)) return ctx.send(404, { error: 'no such key', field: 'name' }), true;
      ctx.send(200, { name, value: store[name] });
      return true;
    }
    if (!ctx.human) return ctx.send(403, { error: 'person_only', message: 'module storage is written on the person\'s behalf' }), true;
    if (req.method === 'DELETE') {
      const { [name]: _gone, ...left } = store;
      deps.setSetting(storeKey(id), left);
      ctx.send(200, { removed: name });
      return true;
    }
    if (req.method !== 'PUT') return ctx.send(405, { error: 'method not allowed' }), true;
    const b = (await ctx.readBody().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b.value !== 'string') return ctx.send(400, { error: 'value (string) is required', field: 'value' }), true;
    const size = Buffer.byteLength(b.value);
    if (size > STORAGE_VALUE_MAX) return ctx.send(413, { error: `a value is at most ${STORAGE_VALUE_MAX} bytes; this one is ${size}`, max: STORAGE_VALUE_MAX, got: size }), true;
    const next = { ...store, [name]: b.value };
    const total = Object.values(next).reduce((n, v) => n + Buffer.byteLength(v), 0);
    if (total > STORAGE_TOTAL_MAX) return ctx.send(413, { error: `a module's storage is at most ${STORAGE_TOTAL_MAX} bytes; this would be ${total}`, max: STORAGE_TOTAL_MAX, got: total }), true;
    deps.setSetting(storeKey(id), next);
    ctx.send(200, { name, bytes: size });
    return true;
  }


  /** M4: the engine admits a module page's Tasks call. Order: person, module, class/context, grant, verb input, approval (purge), budget; then the native route runs. */
  async function admit(req: IncomingMessage, ctx: { human: boolean; readBody: () => Promise<unknown>; send: (status: number, body: unknown) => void }, id: string, room: string, approveStep: boolean): Promise<void> {
    if (req.method !== 'POST') return ctx.send(405, { error: 'method not allowed' });
    if (!ctx.human) return ctx.send(403, { error: 'person_only', message: 'a module page acts for the signed-in person' });
    const e = find(id);
    if (!usable(e)) return ctx.send(404, { error: 'no such module, or it is off or in error', field: 'id' });
    if (e.class !== 'tool' || !e.tool || !e.tool.contexts.some((c) => c === 'workroom' || c === '*')) return ctx.send(403, { error: 'this module is not a tool for workrooms', field: 'id' });
    const b = (await ctx.readBody().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') return ctx.send(400, { error: 'a JSON body is required', field: 'body' });
    const built = build(b.verb, room, b.input ?? {});
    if (!built.ok) return ctx.send(400, { error: built.error, field: built.field });
    if (!e.permissions.includes(built.grant)) return ctx.send(403, { error: `the module does not hold ${built.grant}`, field: 'verb' });
    const scope = { window: 0, module: id, gen: 0, accountId: null, selectionVersion: 0, engineEpoch: EPOCH, room, verb: String(b.verb), taskId: built.taskId ?? 0 };
    if (approveStep) {
      if (built.grant !== DELETE) return ctx.send(400, { error: 'only a delete needs an approval', field: 'verb' });
      const token = approvals.mint(scope);
      return token ? ctx.send(200, { approval: token, expiresInMs: 60000 }) : ctx.send(400, { error: 'could not mint an approval', field: 'verb' });
    }
    if (built.needsApproval && !approvals.take(b.approval, scope)) return ctx.send(403, { error: 'approval-required', message: 'a delete needs a fresh approval for this exact task', field: 'approval' });
    if (!deps.dispatch) return ctx.send(501, { error: 'not available' });
    const size = Buffer.byteLength(JSON.stringify(b.input ?? {}));
    const ticket = budget.take({ module: id, frame: String(req.headers['x-module-frame'] ?? '0').slice(0, 64), bytes: size });
    if (!ticket.ok) return ctx.send(429, { error: 'slow down', kind: 'slow' });
    try {
      const r = await deps.dispatch({ method: built.method, path: built.path, body: built.body }, String(req.headers.cookie ?? ''));
      if (!budget.replyOk(Buffer.byteLength(r.text))) return ctx.send(502, { error: 'the reply is too large for a module page', field: 'verb' });
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(r.text);
      } catch {
        parsed = { raw: r.text.slice(0, 200) };
      }
      ctx.send(r.status, parsed);
    } finally {
      ticket.done();
    }
  }

  /** a module page request: /app/modules/<id>/ui/... or anything under /app/plugins/ */
  const isUiPath = (pathname: string): boolean => pathname === '/app/plugins' || pathname.startsWith('/app/plugins/') || (pathname.startsWith('/app/modules/') && (pathname.includes('/ui/') || pathname.endsWith('/ui')));
  return { catalog, find, usable, view, serveUi, handleApi, isUiPath };
}

function notFound(res: ServerResponse): true {
  res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end('Not found');
  return true;
}

/** A plugin's page for "Open <plugin>": the manifest's `entry` only when it is a plain ui/<name>.html AND that exact file is among the bytes the person's consent pinned. */
function pluginEntryOf(p: PluginScan): { entry?: string } {
  const entry = p.man.entry;
  const files = p.state.consent && typeof p.state.consent === 'object' ? (p.state.consent as { files?: Record<string, string> }).files : undefined;
  return typeof entry === 'string' && /^ui\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.html$/.test(entry) && files && Object.prototype.hasOwnProperty.call(files, entry) ? { entry } : {};
}
