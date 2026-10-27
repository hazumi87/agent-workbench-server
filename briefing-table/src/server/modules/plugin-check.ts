/* Plugin install, the check (ported from workbench-app src/plugin-check.js; the design notes step 2, the design notes M6): is this
 * zip a plugin we may install? Pure. Takes the zip reader's entries (plugin-zip.ts). module.json sits at the zip's root or in one top folder; it gets the
 * same checks the module scan applies (id, class, paths, the tool, widget and actions manifests), never a built-in or reserved id, never core:true, never a
 * `main` script (a plugin's UI runs in a sandboxed frame; only bundled modules run code in the app page); a plugin carries no programs (by name or by the
 * first bytes); every file the manifest names is present. The answer is the install dialog's summary and the tree hash the consent record pins (the
 * engine computes the same hash over the installed folder at each scan). test/modules-plugin-check.test.ts. */
import { createHash } from 'node:crypto';
import { checkToolManifest, checkActions, checkWidgetManifest, relpathOk } from './manifest.ts';
import { cleanName, type ZipEntry } from './plugin-zip.ts';
import { gatedGrants, wantsText } from './consent.ts';

/** The module classes the app's scan accepts (workbench-app src/main.js MODULE_CLASSES). */
export const MODULE_CLASSES: ReadonlySet<string> = new Set(['cli-manager', 'status-monitor', 'concierge', 'workrooms', 'tool', 'widget']);
/** The bundled module ids a plugin may never take (the app's reservedPluginIds(): every bundled module in workbench-app modules/, plus tasks). */
export const BUNDLED_MODULE_IDS: ReadonlySet<string> = new Set(['cli-manager', 'hello-tool', 'status-monitor', 'tasks', 'usage', 'workrooms']);

// a plugin's id becomes its folder name and its /app/plugins/<id>/ prefix: the one module id rule [a-z][a-z0-9-]{0,40},
// no dots (engine maintainer and builder-two, service [ref]: ui-paths, the page's frame guard and moduleUiUrl use the same
// rule), no Windows device name (builder-three-2 [ref])
const ID = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_MANIFEST = 64 * 1024;
const PROGRAM_EXT = /\.(exe|dll|node|so|dylib|bat|cmd|ps1|psm1|psd1|vbs|vbe|js[e]|wsf|wsh|msi|msix|msp|com|scr|cpl|hta|inf|reg|lnk|url|gadget|sh|bash|zsh|command|py|pyw|pyc|pyz|rb|pl|php|lua|applescript|scpt|jar|app|pkg|deb|rpm|apk|appimage|run)$/i;
// PE, ELF, Mach-O 64 and 32 in both byte orders, fat 32 and 64, and a script's shebang
const MAGIC = [Buffer.from('MZ'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), Buffer.from([0xce, 0xfa, 0xed, 0xfe]), Buffer.from([0xfe, 0xed, 0xfa, 0xce]), Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.from([0xca, 0xfe, 0xba, 0xbf]), Buffer.from([0xbe, 0xba, 0xfe, 0xca]), Buffer.from([0xbf, 0xba, 0xfe, 0xca]), Buffer.from('#!')];

export type CheckReason = 'no-manifest' | 'layout' | 'bad-manifest' | 'reserved-id' | 'core' | 'different-plugin' | 'missing-file' | 'program';
export interface CheckFail { ok: false; reason: CheckReason; detail?: string }
export interface PluginFile { path: string; data: Buffer }
export interface PluginOk {
  ok: true;
  id: string;
  name: string;
  version: string;
  description: string;
  class: string;
  grants: string[];
  wants: string | null;
  replaces: string | null;
  files: PluginFile[];
  hash: string;
  bytes: number;
}
export interface CheckOptions {
  classes?: ReadonlySet<string>;
  reservedIds?: ReadonlySet<string>;
  installed?: ReadonlyMap<string, string>;
  /** "Update from zip…" on that row: a zip that is another plugin is refused */
  expectId?: string | null;
}

const fail = (reason: CheckReason, detail?: unknown): CheckFail => (detail ? { ok: false, reason, detail: String(detail).slice(0, 300) } : { ok: false, reason });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const byPathOrder = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** sha256 over the files sorted by path, each as (path length, path, data length, data). */
export function treeHash(files: ReadonlyArray<PluginFile>): string {
  const h = createHash('sha256');
  const len = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
  for (const f of [...files].sort(byPathOrder)) {
    const p = Buffer.from(f.path, 'utf8');
    h.update(len(p.length)); h.update(p); h.update(len(f.data.length)); h.update(f.data);
  }
  return h.digest('hex');
}

/** The plugin's own files relative to its root, or a refusal. */
function rootOf(entries: readonly ZipEntry[]): { prefix: string; files: PluginFile[] } | CheckFail {
  const files = entries.filter((e): e is Extract<ZipEntry, { dir: false }> => !e.dir);
  if (files.some((e) => e.path === 'module.json')) return { prefix: '', files };
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  if (tops.size !== 1) return files.some((e) => e.path.endsWith('/module.json')) ? fail('layout') : fail('no-manifest');
  const top = [...tops][0] + '/';
  if (!files.some((e) => e.path === top + 'module.json')) return fail('no-manifest');
  return { prefix: top, files };
}

/**
 * checkPlugin(entries, {classes, reservedIds, installed, expectId?}) → {ok:true, id, name, version, description, class,
 * grants, wants, replaces, files:[{path, data}], hash, bytes} or {ok:false, reason, detail?}.
 * reasons: no-manifest, layout, bad-manifest, reserved-id, core, different-plugin, missing-file, program.
 * classes and reservedIds default to the app's (MODULE_CLASSES, BUNDLED_MODULE_IDS).
 */
export function checkPlugin(
  entries: readonly ZipEntry[] | null | undefined,
  { classes = MODULE_CLASSES, reservedIds = BUNDLED_MODULE_IDS, installed = new Map(), expectId = null }: CheckOptions = {},
): PluginOk | CheckFail {
  if (!Array.isArray(entries) || !entries.length) return fail('no-manifest');
  const root = rootOf(entries);
  if ('ok' in root) return root;
  const files = root.files.map((e) => ({ path: e.path.slice(root.prefix.length), data: e.data })).sort(byPathOrder);
  const byPath = new Map(files.map((f) => [f.path, f]));

  const raw = byPath.get('module.json')!.data;
  if (raw.length > MAX_MANIFEST) return fail('bad-manifest', 'module.json is over 64 KB');
  let man: unknown;
  try { man = JSON.parse(raw.toString('utf8')); } catch { return fail('bad-manifest', 'module.json is not JSON'); }
  if (!isObj(man) || typeof man.id !== 'string' || man.id.length < 2 || man.id.length > 41 || !ID.test(man.id) || !cleanName(man.id)) return fail('bad-manifest', 'the id must be a lower case letter, then letters, digits and dashes (no dots), and not a Windows device name');
  if (!classes || typeof man.class !== 'string' || !classes.has(man.class)) return fail('bad-manifest', 'unknown class ' + JSON.stringify(man.class));
  if (reservedIds.has(man.id)) return fail('reserved-id');
  if (man.core === true) return fail('core');
  if (expectId !== null && man.id !== expectId) return fail('different-plugin', man.id);

  for (const f of files) {
    if (PROGRAM_EXT.test(f.path) || MAGIC.some((m) => f.data.length >= m.length && f.data.subarray(0, m.length).equals(m))) return fail('program', f.path);
  }
  // M6: a plugin never has a main script (the app's check only validated the path of one)
  if (man.main !== undefined) return fail('bad-manifest', 'a plugin has no main script');

  const named: string[] = [];
  for (const key of ['entry', 'settings']) {
    const v = man[key];
    if (v === undefined) continue;
    if (!relpathOk(v)) return fail('bad-manifest', key + ' must be a path inside the plugin');
    named.push(v);
  }
  if (man.class === 'tool') {
    const t = checkToolManifest(man);
    if (!t.ok) return fail('bad-manifest', t.reason);
    const adoc = byPath.get(t.tool.actions);
    if (!adoc) return fail('missing-file', t.tool.actions);
    let doc: unknown;
    try { doc = JSON.parse(adoc.data.toString('utf8')); } catch { return fail('bad-manifest', t.tool.actions + ' is not JSON'); }
    const ac = checkActions(doc, t.tool);
    if (!ac.ok) return fail('bad-manifest', ac.reason);
    if (t.tool.style) named.push(t.tool.style);
  }
  if (man.class === 'widget') {
    const w = checkWidgetManifest(man);
    if (!w.ok) return fail('bad-manifest', w.reason);
    named.push(w.widget.page);
  }
  for (const p of named) if (!byPath.has(p)) return fail('missing-file', p);

  const grants = gatedGrants(man);
  return {
    ok: true,
    id: man.id,
    name: String(man.name || man.id).slice(0, 60),
    version: String(man.version || '0').slice(0, 30),
    description: String(man.description || '').slice(0, 300),
    class: man.class,
    grants,
    wants: grants.length ? wantsText(grants) : null,
    replaces: installed.has(man.id) ? String(installed.get(man.id)) : null,
    files,
    hash: treeHash(files),
    bytes: files.reduce((n, f) => n + f.data.length, 0),
  };
}
