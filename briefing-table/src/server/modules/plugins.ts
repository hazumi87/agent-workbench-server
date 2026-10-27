/* PLUGIN INSTALL on the web (M6), switched OFF unless HARBOR_WB_PLUGINS=1 (every route here is then a 404). Person-only; the Origin guard has run. The pure parts are tool maintainers' (plugin-zip, plugin-check,
 * plugin-tree, plugin-files, plugin-tokens, consent, plugin-gate); this file is the disk, the settings and the routes (seam §5):
 *   POST   /api/modules/plugins                  a zip (multipart `file` or the raw body, at most 20 MB) -> the checks -> {checkId, plugin, files, permissions, wants, replaces?, warnings}
 *   POST   /api/modules/plugins/:checkId/install {consent:{permissions}}  one use: stage exactly the checked bytes, install, record the consent -> {plugin, modules}
 *   POST   /api/modules/plugins/:id/review       re-check a plugin already on disk (held after a change) -> like an upload
 *   DELETE /api/modules/plugins/:id              remove the folder, the consent record and the settings (its module-data store stays) -> {modules}
 * A plugin is served and enabled only while its consent record matches the files on disk (plugin-gate / consent.ts). */
import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readZip } from './plugin-zip.ts';
import { checkPlugin, treeHash, type PluginFile, type PluginOk } from './plugin-check.ts';
import { readTree } from './plugin-tree.ts';
import * as pfiles from './plugin-files.ts';
import { createTokens } from './plugin-tokens.ts';
import { allow, gateEntry, mayTurnOn, type GateModule } from './plugin-gate.ts';
import { recordOk, dialogText, type ConsentRecord } from './consent.ts';

export const MAX_UPLOAD = 20 * 1024 * 1024;
const STATE_KEY = 'plugins.state';
const SEQ_KEY = 'plugins.seq';

export const pluginsOn = (): boolean => process.env.HARBOR_WB_PLUGINS === '1';

interface PluginState {
  enabled: boolean;
  installSeq: number;
  consent: ConsentRecord | null;
}
export interface PluginScan {
  id: string;
  folder: string;
  root: string;
  man: Record<string, unknown>;
  hash: string | null;
  error: string | null;
  state: PluginState;
  gate: ReturnType<typeof gateEntry>;
  gm: GateModule;
}

export interface PluginDeps {
  root: string; // <data>/plugins
  getSetting: (key: string) => unknown;
  setSetting: (key: string, value: unknown) => void;
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The file part of a multipart/form-data body (the first part named `file`), or null. */
export function multipartFile(body: Buffer, contentType: string): Buffer | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!m) return null;
  const delim = Buffer.from('--' + (m[1] ?? m[2]));
  let i = body.indexOf(delim);
  while (i >= 0) {
    const start = i + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') return null; // the closing delimiter
    const headEnd = body.indexOf('\r\n\r\n', start);
    if (headEnd < 0) return null;
    const head = body.subarray(start, headEnd).toString('latin1');
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
    if (next < 0) return null;
    if (/name="file"/i.test(head)) return body.subarray(headEnd + 4, next);
    i = next + 2;
  }
  return null;
}

async function readLimited(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createPlugins(deps: PluginDeps) {
  const states = (): Record<string, PluginState> => {
    const v = deps.getSetting(STATE_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, PluginState>) : {};
  };
  const saveState = (id: string, st: PluginState | null): void => {
    const all = { ...states() };
    if (st) all[id] = st;
    else delete all[id];
    deps.setSetting(STATE_KEY, all);
  };
  const nextSeq = (): number => {
    const n = (typeof deps.getSetting(SEQ_KEY) === 'number' ? (deps.getSetting(SEQ_KEY) as number) : 0) + 1;
    deps.setSetting(SEQ_KEY, n);
    return n;
  };
  const tokens = createTokens<{ check: PluginOk; replacing: boolean }>();

  /** Every plugin folder on disk with its gate decision. The folder is re-hashed on EVERY scan: a change turns the plugin off until the person consents again. */
  function scan(): PluginScan[] {
    if (!pluginsOn()) return [];
    let names: string[] = [];
    try {
      names = readdirSync(deps.root).filter((n) => !n.startsWith('.'));
    } catch {
      return [];
    }
    const all = states();
    const out: PluginScan[] = [];
    for (const folder of names.sort()) {
      const root = join(deps.root, folder);
      const tree = readTree(root);
      let man: Record<string, unknown> = {};
      let error: string | null = null;
      let hash: string | null = null;
      if (!tree.ok) {
        error = `unreadable (${tree.reason})`;
      } else {
        hash = treeHash(tree.files);
        try {
          man = JSON.parse(tree.files.find((f) => f.path === 'module.json')?.data.toString('utf8') ?? '');
        } catch {
          error = 'module.json is not JSON';
        }
      }
      const id = typeof man.id === 'string' ? man.id : folder;
      if (!error && id !== folder) error = 'the plugin id must match its folder';
      const st = all[id] ?? { enabled: false, installSeq: 0, consent: null };
      const rec = st.consent && recordOk(st.consent) ? st.consent : null;
      const gm: GateModule = {
        id, source: 'user', name: typeof man.name === 'string' ? man.name : id, version: typeof man.version === 'string' ? man.version : '',
        permissions: Array.isArray(man.permissions) ? man.permissions : [], folderHash: hash, installSeq: st.installSeq, error,
      };
      const gate = gateEntry(gm, { enabled: st.enabled, consent: rec });
      out.push({ id, folder, root, man, hash, error, state: st, gate, gm });
    }
    return out;
  }

  /** Can this file of an enabled plugin be served? Only if its bytes are the ones the consent record pinned (P8). */
  function fileServable(p: PluginScan, rel: string, bytes: Buffer): boolean {
    const rec = p.state.consent;
    return p.gate.enabled && !!rec && recordOk(rec) && !!rec.files && rec.files[rel] === sha(bytes);
  }

  function answerFor(c: PluginOk, replacing: string | null) {
    const prior = replacing ? states()[replacing]?.consent : null;
    return {
      checkId: tokens.put({ check: c, replacing: !!replacing }),
      plugin: { id: c.id, name: c.name, version: c.version },
      files: c.files.map((f) => ({ path: f.path, sha256: sha(f.data), bytes: f.data.length })),
      permissions: c.grants,
      wants: c.wants,
      dialog: dialogText(c.name, c.grants),
      warnings: [] as string[],
      ...(replacing ? { replaces: { version: String(scan().find((s) => s.id === replacing)?.man.version ?? ''), permissions: prior && recordOk(prior) ? prior.grants : [] } } : {}),
    };
  }

  const installedMap = (): Map<string, string> => new Map(scan().filter((s) => s.hash).map((s) => [s.id, s.hash as string]));

  /** true = handled. */
  async function handle(req: IncomingMessage, route: string, ctx: { human: boolean; readBody: () => Promise<unknown>; send: (status: number, body: unknown) => void; modules: () => unknown }): Promise<boolean> {
    if (!route.startsWith('/api/modules/plugins')) return false;
    if (!pluginsOn()) return ctx.send(404, { error: 'plugin install is off on this server' }), true;
    if (!ctx.human) return ctx.send(403, { error: 'person_only', message: 'only the signed-in person installs a plugin' }), true;
    const method = req.method ?? 'GET';
    if (route === '/api/modules/plugins' && method === 'POST') {
      const raw = await readLimited(req, MAX_UPLOAD + 64 * 1024);
      if (!raw) return ctx.send(413, { error: `a plugin zip is at most ${MAX_UPLOAD} bytes`, max: MAX_UPLOAD }), true;
      const ct = String(req.headers['content-type'] ?? '');
      const zip = /multipart\/form-data/i.test(ct) ? multipartFile(raw, ct) : raw;
      if (!zip || !zip.length) return ctx.send(400, { error: 'send the zip as the multipart field "file" or as the raw body', field: 'file' }), true;
      if (zip.length > MAX_UPLOAD) return ctx.send(413, { error: `a plugin zip is at most ${MAX_UPLOAD} bytes`, max: MAX_UPLOAD }), true;
      const z = readZip(zip);
      if (!z.ok) return ctx.send(400, { error: 'that is not a zip this server will open', reason: z.reason, field: 'file' }), true;
      const c = checkPlugin(z.entries, { installed: installedMap() });
      if (!c.ok) return ctx.send(400, { error: 'that plugin did not pass the checks', reason: c.reason, detail: c.detail, field: 'file' }), true;
      const replacing = installedMap().has(c.id) ? c.id : null;
      return ctx.send(200, answerFor(c, replacing)), true;
    }
    const inst = /^\/api\/modules\/plugins\/([0-9a-f]{32})\/install$/.exec(route);
    if (inst && method === 'POST') {
      const b = (await ctx.readBody().catch(() => null)) as { consent?: { permissions?: unknown } } | null;
      const held = tokens.take(inst[1]);
      if (!held) return ctx.send(409, { error: 'that check has expired or was already used; upload the zip again', field: 'checkId' }), true;
      const c = held.check;
      const said = b?.consent?.permissions;
      if (!Array.isArray(said) || said.length !== c.grants.length || !c.grants.every((g) => said.includes(g))) {
        // the token was spent by the take; hand back a fresh one for the same checked bytes so the page can ask again without an upload
        return ctx.send(400, { error: 'the permissions you allowed are not the ones this plugin asks for', field: 'consent', asks: c.grants, checkId: tokens.put(held) }), true;
      }
      const staged = pfiles.stage(deps.root, c.files, c.hash);
      if (!staged.ok) return ctx.send(500, { error: 'could not write the plugin', reason: staged.reason }), true;
      const done = pfiles.install(deps.root, c.id, staged.dir, { expect: held.replacing ? c.id : null });
      if (!done.ok) return ctx.send(409, { error: 'could not put the plugin in place', reason: done.reason }), true;
      const man = JSON.parse((c.files.find((f) => f.path === 'module.json') as PluginFile).data.toString('utf8')) as Record<string, unknown>;
      const seq = nextSeq();
      const gm: GateModule = { id: c.id, source: 'user', name: c.name, version: c.version, permissions: Array.isArray(man.permissions) ? man.permissions : [], folderHash: c.hash, installSeq: seq, fileHashes: staged.fileHashes };
      const a = allow(gm, c.hash, new Date().toISOString());
      if (!a.ok) return ctx.send(500, { error: 'could not record the consent', reason: a.reason }), true;
      saveState(c.id, { enabled: true, installSeq: seq, consent: a.record });
      return ctx.send(200, { plugin: { id: c.id, name: c.name, version: c.version }, modules: ctx.modules() }), true;
    }
    const rev = /^\/api\/modules\/plugins\/([a-z][a-z0-9.-]{1,40})\/review$/.exec(route);
    if (rev && method === 'POST') {
      const p = scan().find((s) => s.id === rev[1]);
      if (!p || p.error) return ctx.send(404, { error: 'no such plugin, or its files cannot be read', field: 'id' }), true;
      const tree = readTree(p.root);
      if (!tree.ok) return ctx.send(409, { error: 'its files cannot be read', reason: tree.reason }), true;
      const c = checkPlugin(tree.files.map((f) => ({ path: f.path, dir: false as const, data: f.data })), { installed: installedMap(), expectId: p.id });
      if (!c.ok) return ctx.send(400, { error: 'that plugin no longer passes the checks', reason: c.reason, detail: c.detail }), true;
      return ctx.send(200, answerFor(c, p.id)), true;
    }
    const del = /^\/api\/modules\/plugins\/([a-z][a-z0-9.-]{1,40})$/.exec(route);
    if (del && method === 'DELETE') {
      const r = pfiles.remove(deps.root, del[1]);
      if (!r.ok) return ctx.send(404, { error: 'no such plugin', reason: r.reason, field: 'id' }), true;
      saveState(del[1], null);
      return ctx.send(200, { modules: ctx.modules() }), true;
    }
    return ctx.send(404, { error: 'not found' }), true;
  }

  return { scan, fileServable, handle, mayEnable: (p: PluginScan) => mayTurnOn(p.gm, { consent: p.state.consent }), setEnabled: (id: string, on: boolean) => { const cur = states()[id]; if (cur) saveState(id, { ...cur, enabled: on }); }, sweep: () => pfiles.sweep(deps.root) };
}

