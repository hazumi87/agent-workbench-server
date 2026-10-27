/* The module UI path rules (ported from workbench-app src/module-ui-paths.js; the design notes revision 7, item 6 and C5). Pure: no fs,
 * no http. In the app a wbmod: URL carried the module; in the engine the request PATH does: /app/<modules|plugins>/<id>/ui/<rest>. parseUiPath
 * turns that path into {id, rel, type} only when every check passes: the prefix, a module id segment, and a rest under ui/ with no dot, empty,
 * encoded-separator, backslash, stream, 8.3, trailing dot or space, or Windows device-name segment, and one of five extensions. Which prefix may
 * serve which module (a bundled id under plugins/, say) is the ROUTE's decision, not this file's. The route then takes realpath and serves the
 * file only when inside() holds. test/modules-ui-paths.test.ts. */

const ID = /^[a-z][a-z0-9-]{0,40}$/;
export const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const BAD_ENCODED = /%(2e|2f|5c|25|00)/i;

export type UiPrefix = 'modules' | 'plugins';
export interface UiPath { id: string; rel: string; type: string }

function badSegment(seg: string): boolean {
  return (
    seg === '' || seg === '.' || seg === '..' ||
    /[\\:\0]/.test(seg) || // backslash, alternate data streams, NUL
    /~\d/.test(seg) || // 8.3 short names
    /[. ]$/.test(seg) || // Windows drops a trailing dot or space
    DEVICE.test(seg)
  );
}

/** /app/<prefix>/<id>/ui/<path> → {id, rel: 'ui/<path>', type}, or null. `pathname` is the request path as received (still percent-encoded), without its query. */
export function parseUiPath(prefix: UiPrefix, pathname: string): UiPath | null {
  if (prefix !== 'modules' && prefix !== 'plugins') return null;
  if (typeof pathname !== 'string' || pathname.length > 2048) return null;
  if (/[?#]/.test(pathname)) return null; // a pathname has no query or fragment; the route strips them before it asks
  const head = '/app/' + prefix + '/';
  if (!pathname.startsWith(head)) return null;
  const rest = pathname.slice(head.length);
  const slash = rest.indexOf('/');
  const id = slash < 0 ? rest : rest.slice(0, slash);
  if (!ID.test(id)) return null; // also refuses user:pass@, :port, upper case and any encoded id
  const raw = slash < 0 ? '' : rest.slice(slash + 1);
  if (!raw.startsWith('ui/') || BAD_ENCODED.test(raw) || raw.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // a malformed escape
  }
  const segs = decoded.split('/');
  if (segs.length < 2 || segs.some(badSegment)) return null;
  const last = segs[segs.length - 1];
  const dot = last.lastIndexOf('.');
  const ext = dot > 0 ? last.slice(dot) : '';
  if (!Object.prototype.hasOwnProperty.call(TYPES, ext)) return null; // exact and lower case
  return { id, rel: segs.join('/'), type: TYPES[ext] };
}

/** Is the file's realpath inside the ui folder's realpath? Case-insensitive on Windows; never the folder itself. */
export function inside(rootReal: string, fileReal: string, platform: string = process.platform): boolean {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const norm = (s: string): string => (win ? s.replace(/\//g, '\\').toLowerCase() : s);
  let root = norm(String(rootReal));
  if (!root.endsWith(sep)) root += sep;
  const file = norm(String(fileReal));
  return file.length > root.length && file.startsWith(root);
}

/** The id the route matches on: lower-cased, as a standard-scheme host was in the app. */
export const foldId = (id: string): string => String(id).toLowerCase();

/** Catalog ids that equal an earlier one case-folded: refused at registration. */
export function caseCollisions(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const f = foldId(id);
    if (seen.has(f)) out.push(id);
    else seen.add(f);
  }
  return out;
}
