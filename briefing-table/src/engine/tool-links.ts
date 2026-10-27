/* ============================================================================
 * LINE LINKS INTO A TOOL VIEW [rooms/tool-links] (Owner via alpha-platform,
 * 2026-09-28): a room line carries links that open an APP's own view (Image
 * Studio's review item) in the room's preview column, instead of a table of
 * HTML in chat. This module is the PURE half — no table, no fs, no auth — so
 * a unit test can import it without minting anything (apps.ts imports
 * server/auth.ts, which writes the engine token at module load).
 *
 * THE CONTRACT (agreed with alpha-platform):
 *
 *   tool.json   "links": {"review/:n": {"label": "Review item",
 *                                       "view": "GET /rooms/:roomId/review/:n"}}
 *     - PATTERN: '/'-separated segments, each a literal ([a-z0-9-]{1,64}) or
 *       a :param (a letter, then letters/digits/_ ; unique; never :roomId).
 *       A param VALUE matches [a-z0-9-]{1,64}. At most LINK_PATTERNS_MAX.
 *     - LABEL: plain text, 1..80, no control characters.
 *     - VIEW: the panels[].view rules — starts with 'GET /', a path on the
 *       app's own endpoint — and may use :roomId and the pattern's params
 *       (any other :name is a problem). It must resolve UNDER the directory
 *       of one of the app's declared panel views, because the room page can
 *       only reach an app THROUGH its panel's frame proxy, and the proxy maps
 *       a tail relative to the registered url's directory (panel-proxy.ts
 *       upstreamFor). A view outside every panel's directory could never be
 *       opened, so it is refused at registration, not discovered at click.
 *     - Malformed links are tool.json PROBLEMS (candidates list them,
 *       registration / approve refuse). They are part of the pinned file, so
 *       a change holds the app like any other edit.
 *
 *   POST .../line  "links": [{tool, ref, label?}]  (<= LINKS_MAX)
 *     stored as meta.links = [{tool, ref, label, view_path, panel_id}]:
 *       view_path  the sub-path RELATIVE to the app panel's frame URL — the
 *                  exact `path` the preview column's {panel:'preview',
 *                  view:{path}} takes (web/room-cells.mjs cleanPath/viewUrl);
 *                  it passes cleanPath (relative, no '..', no scheme).
 *       panel_id   the app's panel in this room whose frame reaches it, or
 *                  null when the app has no panel here yet (it was added
 *                  while down; the page resolves one by app slug later).
 *
 *   Delivered to agents: one compact trailing line (withLinks), after the
 *   reply prefix and the body:  [links: image-studio review/2 "#2 her shoes"]
 * ========================================================================== */

export const LINKS_MAX = 8;
export const LINK_LABEL_MAX = 80;
export const LINK_PATTERNS_MAX = 16;
const REF_MAX = 200;
const VIEW_MAX = 300;
/** What the web's cleanPath accepts, and so the longest a view_path may be. */
export const VIEW_PATH_MAX = 200;

const SEGMENT = /^[a-z0-9-]{1,64}$/;
const PARAM = /^:([A-Za-z][A-Za-z0-9_]{0,31})$/;
const TOKEN = /:([A-Za-z][A-Za-z0-9_]*)/g;
const CONTROL = /[\u0000-\u001f\u007f]/;
const BACKSLASH = String.fromCharCode(92);

type Seg = { lit: string } | { param: string };

export interface LinkSpec {
  pattern: string;
  label: string;
  /** the declared view, 'GET /…' */
  view: string;
  segs: Seg[];
}

/** One stored link (meta.links[i]). */
export interface StoredLink {
  tool: string;
  ref: string;
  label: string;
  view_path: string;
  panel_id: string | null;
}

/** A plain one-line label, or null. */
export function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') {
    return null;
  }
  const t = v.trim();
  return t.length > 0 && t.length <= LINK_LABEL_MAX && !CONTROL.test(t) ? t : null;
}

/** web/room-cells.mjs cleanPath, the same rules: relative, no scheme, no
 *  leading '/', no backslash, no '..' segment (plain or percent-encoded),
 *  at most 200 characters. null = refused. */
export function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length > VIEW_PATH_MAX || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.includes(BACKSLASH)) {
    return null;
  }
  const segs = p.split(/[?#]/)[0].split('/');
  if (segs.some((s) => s === '..' || s.toLowerCase() === '%2e%2e' || s === '.%2e' || s === '%2e.')) {
    return null;
  }
  return p;
}

function parsePattern(pattern: string): { segs: Seg[] } | { problem: string } {
  if (pattern.length === 0 || pattern.length > 128) {
    return { problem: 'must be 1..128 characters' };
  }
  const parts = pattern.split('/');
  if (parts.length > 8) {
    return { problem: 'has more than 8 segments' };
  }
  const segs: Seg[] = [];
  const names = new Set<string>();
  for (const part of parts) {
    const m = PARAM.exec(part);
    if (m) {
      if (m[1] === 'roomId') {
        return { problem: ':roomId is the room, not a link parameter' };
      }
      if (names.has(m[1])) {
        return { problem: `repeats :${m[1]}` };
      }
      names.add(m[1]);
      segs.push({ param: m[1] });
    } else if (SEGMENT.test(part)) {
      segs.push({ lit: part });
    } else {
      return { problem: `segment ${JSON.stringify(part)} is neither a literal (a-z, 0-9, -) nor a :param` };
    }
  }
  return { segs };
}

/** The declared view's path with values filled in. Unknown :names stay. */
function fill(viewPath: string, values: Record<string, string>): string {
  return viewPath.replace(TOKEN, (m, name: string) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m));
}

/** A panel view's path for one room — EXACTLY panelSpecsFor's substitution
 *  (apps.ts), so the directory computed here is the stored panel url's. */
export function panelPath(view: string, roomId: string): string {
  return view.slice(4).split(':roomId').join(encodeURIComponent(roomId));
}

/** The directory the frame proxy maps a tail under (panel-proxy upstreamFor:
 *  new URL('./', registered)). */
export function dirOf(path: string): string {
  const bare = path.split(/[?#]/)[0];
  return bare.slice(0, bare.lastIndexOf('/') + 1);
}

/** Declared panel views that are well-formed (the toolProblems rule). */
export function panelViewsOf(parsed: any): string[] {
  const panels = Array.isArray(parsed?.panels) ? parsed.panels : [];
  return panels
    .map((p: any) => (typeof p?.view === 'string' ? p.view : ''))
    .filter((v: string) => v.startsWith('GET /') && v.includes(':roomId'));
}

/** The link's full path, and which panel view's directory it sits under with
 *  the sub-path relative to it. null = under none (or the result would not
 *  pass cleanPath). */
export function resolveView(
  spec: LinkSpec,
  roomId: string,
  values: Record<string, string>,
  panelViews: string[],
): { path: string; view_path: string; panelView: string } | null {
  const path = fill(spec.view.slice(4), { ...values, roomId: encodeURIComponent(roomId) });
  const bare = path.split(/[?#]/)[0];
  for (const pv of panelViews) {
    const dir = dirOf(panelPath(pv, roomId));
    if (dir && bare.startsWith(dir) && path.length > dir.length) {
      const sub = cleanPath(path.slice(dir.length));
      if (sub !== null && sub !== '') {
        return { path, view_path: sub, panelView: pv };
      }
    }
  }
  return null;
}

/** The reserved key in tool.json `links` that is not a pattern: the app's
 *  BATCH endpoint, "@meta": "GET /rooms/:roomId/links". The host calls it
 *  through the panel frame proxy with ?refs=r1,r2 (<= LINKS_MAX) and gets
 *  {items:[{ref, label?, state?, thumb?, stale?, note?}]} (phase 2, the list
 *  rows). Same path rules as a view; only :roomId may appear. */
export const META_KEY = '@meta';
/** A room id no real one resembles (they are uuids), for validating a view
 *  path without a room. */
const SAMPLE_ROOM = 'zq9sample9room';

/** The shared view-path rules (a link's view, the @meta endpoint). */
function viewPathProblem(view: string): string | null {
  if (!view.startsWith('GET /') || view.length > VIEW_MAX) {
    return `${JSON.stringify(view)} must start with "GET /" (at most ${VIEW_MAX} characters)`;
  }
  const path = view.slice(4);
  if (path.includes(BACKSLASH) || path.includes('#') || /\s/.test(path) || path.startsWith('//')) {
    return "the path may not contain a backslash, '#', whitespace or start with '//'";
  }
  if (path.split(/[?]/)[0].split('/').some((s) => s === '..' || s === '.' || s.toLowerCase().includes('%2e'))) {
    return "the path may not contain a '.' or '..' segment";
  }
  return null;
}

/** "@meta" validated: its sub-path relative to a panel view's folder (the
 *  frame-relative path the page fetches), or a problem. */
function metaPath(raw: unknown, panelViews: string[]): { path: string } | { problem: string } {
  const view = typeof raw === 'string' ? raw : '';
  const bad = viewPathProblem(view);
  if (bad) {
    return { problem: bad };
  }
  const unknown = [...view.slice(4).matchAll(TOKEN)].map((m) => m[1]).filter((n) => n !== 'roomId');
  if (unknown.length) {
    return { problem: `names :${unknown[0]}; only :roomId may appear` };
  }
  const got = resolveView({ pattern: META_KEY, label: META_KEY, view, segs: [] }, SAMPLE_ROOM, {}, panelViews);
  if (!got || got.view_path.includes(SAMPLE_ROOM)) {
    return { problem: "must be a sub-path of one of the app's panel views' folders, with :roomId (if any) inside that folder" };
  }
  return { path: got.view_path };
}

/** tool.json `links`, validated: the good specs and a problem per bad entry.
 *  Absent = none (no problem). */
export function parseLinks(raw: unknown, panelViews: string[]): { specs: LinkSpec[]; problems: string[]; meta: string | null } {
  const specs: LinkSpec[] = [];
  const problems: string[] = [];
  let meta: string | null = null;
  if (raw === undefined) {
    return { specs, problems, meta };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { specs, problems: ['links must be an object: {"<pattern>": {label, view}}'], meta };
  }
  const all = Object.entries(raw as Record<string, unknown>);
  const metaRaw = all.find(([k]) => k === META_KEY)?.[1];
  if (metaRaw !== undefined) {
    const m = metaPath(metaRaw, panelViews);
    if ('problem' in m) {
      problems.push(`links "${META_KEY}": ${m.problem}`);
    } else {
      meta = m.path;
    }
  }
  const entries = all.filter(([k]) => k !== META_KEY);
  if (entries.length > LINK_PATTERNS_MAX) {
    problems.push(`links declares ${entries.length} patterns; at most ${LINK_PATTERNS_MAX}`);
  }
  for (const [pattern, v] of entries.slice(0, LINK_PATTERNS_MAX)) {
    const where = `link ${JSON.stringify(pattern)}`;
    const pp = parsePattern(pattern);
    if ('problem' in pp) {
      problems.push(`${where}: the pattern ${pp.problem}`);
      continue;
    }
    const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    const label = cleanLabel(o?.label);
    if (label === null) {
      problems.push(`${where}: label must be plain text, 1..${LINK_LABEL_MAX} characters`);
      continue;
    }
    const view = typeof o?.view === 'string' ? o.view : '';
    const bad = viewPathProblem(view);
    if (bad) {
      problems.push(`${where}: view ${bad}`);
      continue;
    }
    const path = view.slice(4);
    const params = new Set(pp.segs.flatMap((s) => ('param' in s ? [s.param] : [])));
    const unknown = [...path.matchAll(TOKEN)].map((m) => m[1]).filter((n) => n !== 'roomId' && !params.has(n));
    if (unknown.length) {
      problems.push(`${where}: view names :${unknown[0]}, which is not :roomId or one of the pattern's params`);
      continue;
    }
    const spec: LinkSpec = { pattern, label, view, segs: pp.segs };
    const sample: Record<string, string> = {};
    for (const n of params) {
      sample[n] = 'x';
    }
    if (!resolveView(spec, SAMPLE_ROOM, sample, panelViews)) {
      problems.push(`${where}: view must be a sub-path of one of the app's panel views' folders (the room reaches it through that panel's frame)`);
      continue;
    }
    specs.push(spec);
  }
  return { specs, problems, meta };
}

/** The first declared pattern `ref` matches, with its params resolved. */
export function matchRef(specs: LinkSpec[], ref: unknown): { spec: LinkSpec; values: Record<string, string> } | null {
  if (typeof ref !== 'string' || !ref || ref.length > REF_MAX) {
    return null;
  }
  const parts = ref.split('/');
  outer: for (const spec of specs) {
    if (spec.segs.length !== parts.length) {
      continue;
    }
    const values: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const s = spec.segs[i];
      if ('lit' in s) {
        if (s.lit !== parts[i]) {
          continue outer;
        }
      } else if (SEGMENT.test(parts[i])) {
        values[s.param] = parts[i];
      } else {
        continue outer;
      }
    }
    return { spec, values };
  }
  return null;
}

/** A stored meta.links, when it is one (the delivery and the page read it). */
export function linksOf(meta: Record<string, unknown> | null | undefined): StoredLink[] {
  const a = meta?.links;
  if (!Array.isArray(a)) {
    return [];
  }
  return a.filter(
    (l): l is StoredLink => !!l && typeof l === 'object' && typeof l.tool === 'string' && typeof l.ref === 'string' && typeof l.label === 'string',
  );
}

/** The compact line agents get: [links: image-studio review/2 "#2 her shoes", …].
 *  A double quote inside a label becomes a single one so the quotes still
 *  bound it. */
export function linksLine(links: StoredLink[]): string {
  const q = String.fromCharCode(34);
  return `[links: ${links.map((l) => `${l.tool} ${l.ref} ${q}${l.label.split(q).join("'")}${q}`).join(', ')}]`;
}

/** THE ONE PLACE a delivered body gets its links: a trailing line, after the
 *  words (and so after any reply prefix). No links = the body unchanged. */
export function withLinks(body: string, links: StoredLink[]): string {
  if (!links.length) {
    return body;
  }
  return body ? `${body}\n${linksLine(links)}` : linksLine(links);
}
