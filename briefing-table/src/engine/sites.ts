/**
 * [basic] SITES: the engine half of New site and the room's Preview/Public bar
 * (blueprint design-notes-id "Sharing a site"; platform's remote-ops `site`).
 *
 * THE ENGINE NEVER BUILDS A SITE ITSELF. It runs the hosted install's commands:
 *   HARBOR_WB_NEWSITE_CMD      default `site new {name}`   (cwd = the sites dir)
 *   HARBOR_WB_SITE_STATUS_CMD  default `site status`       (cwd = the project dir)
 *   HARBOR_WB_SITES_DIR        default ~/dev/code
 * A command is a template split on whitespace FIRST and then filled, so a
 * placeholder ({name} {slug} {id} {dir}) is always ONE argument whatever it
 * holds, and nothing runs through a shell. remote-ops `site new` mints its own slug
 * and id into <dir>/.site.json; when that file is there it is the authority.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

/** Same rule as remote-ops `site` slugify, so the folder the command makes is the one we expect. */
export function slugify(name: string): string {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 40) || 'site';
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** A public id: 14 base32 chars (~70 bits), the remote-ops shape. */
export function newSiteId(len = 14): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return s;
}

export const sitesDir = (): string => process.env.HARBOR_WB_SITES_DIR || join(homedir(), 'dev', 'code');
const newSiteCmd = (): string => process.env.HARBOR_WB_NEWSITE_CMD || 'site new {name}';
const statusCmd = (): string => process.env.HARBOR_WB_SITE_STATUS_CMD || 'site status';
const CMD_TIMEOUT_MS = (): number => Number(process.env.HARBOR_WB_SITE_CMD_TIMEOUT_MS) || 60_000;

/** The template as argv: split on whitespace, then each `{key}` filled (never re-split). */
export function argvOf(template: string, vars: Record<string, string>): string[] {
  return template
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.replace(/\{(name|slug|id|dir)\}/g, (_, k: string) => vars[k] ?? ''));
}

export interface CmdResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}
export function runCmd(argv: string[], cwd: string): Promise<CmdResult> {
  return new Promise((resolve) => {
    if (!argv.length) {
      resolve({ ok: false, code: null, stdout: '', stderr: 'no command configured' });
      return;
    }
    execFile(argv[0], argv.slice(1), { cwd, timeout: CMD_TIMEOUT_MS(), maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code?: unknown }).code as number) : null) : 0;
      resolve({ ok: !err, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? err.message : '') });
    });
  });
}

export function runNewSite(vars: { name: string; slug: string; id: string }): Promise<CmdResult> {
  const dir = sitesDir();
  return runCmd(argvOf(newSiteCmd(), { ...vars, dir: join(dir, vars.slug) }), dir);
}

/** <dir>/.site.json, or null. */
export function readSiteJson(dir: string): Record<string, any> | null {
  try {
    const p = join(dir, '.site.json');
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

export interface SiteStatus {
  slug: string | null;
  id: string | null;
  name?: string | null;
  previewUrl: string | null;
  publicUrl: string | null;
  published: boolean | null;
  lastPublishedAt: string | null;
  changedSinceSave: boolean | null;
  error?: string;
}
export const NO_SITE: SiteStatus = { slug: null, id: null, previewUrl: null, publicUrl: null, published: null, lastPublishedAt: null, changedSinceSave: null };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * `site status` output -> the bar's fields. JSON when the command prints JSON
 * (any of previewUrl|preview, publicUrl|public_url|public_link, published|public,
 * lastPublishedAt|published_at, changedSinceSave|unsaved|dirty), else the remote-ops
 * text form:
 *   preview (private, tailnet only): <url>
 *   PUBLIC: yes, since <ts>   |   PUBLIC: no (...)
 *   public link: <url>
 *   unsaved changes: yes      (absent = none)
 * `meta` (.site.json) fills slug / id / published / published_at the output lacks.
 */
export function parseStatus(stdout: string, meta: Record<string, any> | null): Omit<SiteStatus, 'error'> {
  const out: Omit<SiteStatus, 'error'> = {
    slug: str(meta?.slug),
    id: str(meta?.id),
    name: str(meta?.name),
    previewUrl: null,
    publicUrl: null,
    published: typeof meta?.public === 'boolean' ? meta.public : null,
    lastPublishedAt: meta?.public ? str(meta?.published_at) : null,
    changedSinceSave: null,
  };
  const t = (stdout ?? '').trim();
  let j: any = null;
  if (t.startsWith('{')) {
    try {
      j = JSON.parse(t);
    } catch {
      j = null;
    }
  }
  if (j && typeof j === 'object') {
    out.slug = str(j.slug) ?? out.slug;
    out.id = str(j.id) ?? out.id;
    out.name = str(j.name) ?? out.name;
    out.previewUrl = str(j.previewUrl) ?? str(j.preview_url) ?? str(j.preview);
    const pub = j.published ?? (typeof j.public === 'boolean' ? j.public : undefined);
    if (typeof pub === 'boolean') out.published = pub;
    out.publicUrl = out.published === false ? null : (str(j.publicUrl) ?? str(j.public_url) ?? str(j.public_link) ?? (typeof j.public === 'string' ? j.public : null));
    out.lastPublishedAt = str(j.lastPublishedAt) ?? str(j.published_at) ?? out.lastPublishedAt;
    const dirty = j.changedSinceSave ?? j.unsaved ?? j.dirty;
    if (typeof dirty === 'boolean') out.changedSinceSave = dirty;
    return out;
  }
  if (!t) return out;
  const prev = /^preview[^:]*:\s*(\S+)/im.exec(t);
  if (prev) out.previewUrl = prev[1];
  const yes = /^PUBLIC:\s*yes(?:,\s*since\s+(\S+))?/m.exec(t);
  if (yes) {
    out.published = true;
    if (yes[1] && yes[1] !== 'None') out.lastPublishedAt = yes[1];
  } else if (/^PUBLIC:\s*no/m.test(t)) {
    out.published = false;
    out.lastPublishedAt = null;
  }
  const link = /^public link:\s*(\S+)/im.exec(t);
  out.publicUrl = out.published === false ? null : link ? link[1] : null;
  out.changedSinceSave = /^unsaved changes:\s*yes/im.test(t);
  return out;
}

/** Run the status command in `dir` and read the bar's fields (never throws). */
export async function siteStatus(dir: string, vars: { slug: string; id: string; name: string }): Promise<SiteStatus> {
  const meta = readSiteJson(dir);
  if (!existsSync(dir)) {
    return { ...parseStatus('', meta), slug: vars.slug, id: vars.id, error: 'the project folder is missing' };
  }
  const r = await runCmd(argvOf(statusCmd(), { ...vars, dir }), dir);
  const s = parseStatus(r.ok ? r.stdout : '', meta);
  return {
    ...s,
    slug: s.slug ?? vars.slug,
    id: s.id ?? vars.id,
    ...(r.ok ? {} : { error: `the status command failed: ${(r.stderr || 'no output').trim().slice(-300)}` }),
  };
}
