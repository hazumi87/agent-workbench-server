/* SETTINGS ROUTES for the web UI (web-first pilot, route shapes agreed with application 2026-10-26):
 *   GET|PUT /api/settings/auto-approve   the first-run default + every recipe's effective value (src/engine/auto-approve.ts)
 *   GET|PUT /api/settings/folder-trust   the per-folder opt-in list for Claude's folder trust (security review H3)
 *   GET     /api/fs/dirs                 directories only, rooted, no symlink escape (the server-side folder picker)
 *   POST    /api/fs/dirs {path,name}     new folder inside the rooted tree (person only; 409 if it exists)
 * Reads: any authenticated caller. Writes: a PERSON only (a session/device cookie, never a bearer or a pane token). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Principal } from '../identity/auth.ts';
import { readBody, sendJson } from './http-util.ts';
import { pictureOwner } from './picture-owner.ts';
import { table } from '../table/endpoint.ts';
import { autoApproveSource, effectiveAutoApprove, readSetting, readState, type AutoApproveState } from '../engine/auto-approve.ts';

export interface SettingsDeps {
  human: boolean;
  principal: Principal | null;
}

export const AUTO_APPROVE_KEY = 'autoApprove';
export const FOLDER_TRUST_KEY = 'folderTrust';

const personOnly = (res: ServerResponse): void => {
  sendJson(res, 403, { error: 'person_only', message: 'only the signed-in person changes this setting; an agent cannot' });
};

export function autoApproveState(): AutoApproveState {
  return readState(table.getEngineSetting(AUTO_APPROVE_KEY));
}

/** The GET answer: the default and, per recipe, what it says and what it resolves to. */
export function autoApproveView(): Record<string, unknown> {
  const st = autoApproveState();
  return {
    default: st.default,
    autoApproveDisclosedAt: st.disclosedAt,
    recipes: (table.listRecipes() as Array<{ id: string; name?: string; vendor?: string; autoApprove?: unknown }>).map((r) => ({
      id: r.id,
      name: r.name ?? r.id, // the row is named by the recipe's NAME, never its id
      vendor: r.vendor ?? null,
      setting: readSetting(r.autoApprove),
      effective: effectiveAutoApprove(r.autoApprove, st.default),
      source: autoApproveSource(r.autoApprove),
    })),
  };
}

export interface TrustedFolder {
  path: string;
  trustedAt: number;
  by: string | null;
}
export function trustedFolders(): TrustedFolder[] {
  const raw = table.getEngineSetting(FOLDER_TRUST_KEY);
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { folders?: unknown }).folders) ? (raw as { folders: unknown[] }).folders : [];
  return list
    .filter((f): f is TrustedFolder => !!f && typeof (f as TrustedFolder).path === 'string')
    .map((f) => ({ path: f.path, trustedAt: Number(f.trustedAt) || 0, by: typeof f.by === 'string' ? f.by : null }));
}
/** Is this folder (or a folder it lives under) in the person's trust list? */
/** The key a folder is trusted under: its real path when it exists (a symlinked path must not dodge or fake the list), else the resolved path. */
export function trustKey(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}
export function isFolderTrusted(dir: string | null | undefined): boolean {
  if (!dir) return false;
  const d = trustKey(dir);
  return trustedFolders().some((f) => d === f.path || d.startsWith(f.path + sep));
}

/** The folder picker's root: HARBOR_WB_FS_ROOT, else the engine user's home. */
export function fsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.HARBOR_WB_FS_ROOT ?? '').trim();
  return realpathSync(v || homedir());
}
function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function listDirs(pathIn: string, hidden: boolean, env: NodeJS.ProcessEnv = process.env): { status: number; body: Record<string, unknown> } {
  let root: string;
  try {
    root = fsRoot(env);
  } catch {
    return { status: 500, body: { error: 'fs-root-unavailable' } };
  }
  let target: string;
  try {
    target = realpathSync(pathIn ? (isAbsolute(pathIn) ? pathIn : join(root, pathIn)) : root);
  } catch (e) {
    return { status: 404, body: { error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'unreadable' : 'not-found' } };
  }
  if (!within(root, target)) {
    return { status: 403, body: { error: 'outside-root' } };
  }
  let names: import('node:fs').Dirent[];
  try {
    names = readdirSync(target, { withFileTypes: true });
  } catch {
    return { status: 403, body: { error: 'unreadable' } };
  }
  const entries: Array<{ name: string; path: string }> = [];
  for (const d of names) {
    if (!hidden && d.name.startsWith('.')) continue;
    const full = join(target, d.name);
    try {
      const real = realpathSync(full); // a symlink to a directory counts only if it stays inside the root
      if (!within(root, real) || !statSync(real).isDirectory()) continue;
      entries.push({ name: d.name, path: real });
    } catch {
      /* unreadable or dangling: not offered */
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { status: 200, body: { path: target, parent: target === root ? null : dirname(target), entries: entries.slice(0, 500) } };
}

/** New folder inside the rooted tree: same root and realpath rules as listDirs; never overwrites (409). */
export function createDir(pathIn: string, name: string, env: NodeJS.ProcessEnv = process.env): { status: number; body: Record<string, unknown> } {
  if (!name || name.length > 255 || name === '.' || name === '..' || /[\\/\0]/.test(name) || name.includes('..') || name !== name.trim()) {
    return { status: 400, body: { error: 'invalid folder name', field: 'name' } };
  }
  let root: string;
  try {
    root = fsRoot(env);
  } catch {
    return { status: 500, body: { error: 'fs-root-unavailable' } };
  }
  let parent: string;
  try {
    parent = realpathSync(pathIn ? (isAbsolute(pathIn) ? pathIn : join(root, pathIn)) : root);
    if (!statSync(parent).isDirectory()) throw new Error('not a directory');
  } catch {
    return { status: 400, body: { error: 'parent folder not found', field: 'path' } };
  }
  if (!within(root, parent)) return { status: 403, body: { error: 'outside-root' } };
  const full = join(parent, name);
  try {
    mkdirSync(full, { mode: 0o750 }); // EEXIST for a file, a folder or a symlink alike: never overwrites
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return { status: 409, body: { error: 'already exists', field: 'name' } };
    return { status: code === 'EACCES' ? 403 : 400, body: { error: 'could not create the folder' } };
  }
  return { status: 200, body: { path: full } };
}

export async function handle(req: IncomingMessage, res: ServerResponse, route: string, deps: SettingsDeps): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (route === '/api/settings/auto-approve') {
    if (method === 'GET') {
      sendJson(res, 200, autoApproveView());
      return true;
    }
    if (method !== 'PUT') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (!deps.human) {
      personOnly(res);
      return true;
    }
    const b = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
    if (!b || (b.default !== 'on' && b.default !== 'off')) {
      sendJson(res, 400, { error: 'default is "on" or "off"', field: 'default' });
      return true;
    }
    const st = autoApproveState();
    const disclosedAt = st.disclosedAt ?? (b.disclosed === true ? Date.now() : null);
    if (b.default === 'on' && disclosedAt === null) {
      sendJson(res, 400, { error: 'disclosure-required', field: 'disclosed', message: 'turning auto-approve on needs the disclosure to be shown and acknowledged (disclosed: true)' });
      return true;
    }
    table.setEngineSetting(AUTO_APPROVE_KEY, { default: b.default, disclosedAt, by: pictureOwner(deps.principal).name ?? null });
    sendJson(res, 200, autoApproveView());
    return true;
  }
  if (route === '/api/settings/folder-trust') {
    if (method === 'GET') {
      sendJson(res, 200, { folders: trustedFolders() });
      return true;
    }
    if (method !== 'PUT') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (!deps.human) {
      personOnly(res);
      return true;
    }
    const b = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b.path !== 'string' || !b.path || !isAbsolute(b.path) || typeof b.trusted !== 'boolean') {
      sendJson(res, 400, { error: 'path (absolute) and trusted (boolean) are required', field: 'path' });
      return true;
    }
    let real: string;
    try {
      real = realpathSync(b.path);
      if (!statSync(real).isDirectory()) throw new Error('not a directory');
    } catch {
      sendJson(res, 400, { error: 'that folder does not exist', field: 'path' });
      return true;
    }
    const rest = trustedFolders().filter((f) => f.path !== real);
    const folders = b.trusted ? [...rest, { path: real, trustedAt: Date.now(), by: pictureOwner(deps.principal).name ?? null }] : rest;
    table.setEngineSetting(FOLDER_TRUST_KEY, { folders });
    sendJson(res, 200, { folders });
    return true;
  }
  if (route === '/api/fs/dirs' && method === 'POST') {
    if (!deps.human) {
      personOnly(res);
      return true;
    }
    const b = (await readBody(req).catch(() => null)) as Record<string, unknown> | null;
    const r = createDir(typeof b?.path === 'string' ? b.path : '', typeof b?.name === 'string' ? b.name : '');
    sendJson(res, r.status, r.body);
    return true;
  }
  if (route === '/api/fs/dirs' && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://engine.local').searchParams;
    const r = listDirs(q.get('path') ?? '', q.get('hidden') === '1');
    sendJson(res, r.status, r.body);
    return true;
  }
  return false;
}
