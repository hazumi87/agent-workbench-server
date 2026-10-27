/**
 * ROOM CHARACTER — the room's ART (the design system room-character v1.1, the design system 9a21656)
 * [rooms/character].
 *
 * Owner can't tell rooms apart. A room now wears art from the SAME library
 * recipes use, drawn behind its line exactly the way a terminal pane draws its
 * watermark, and on its tab. Owner, 2026-09-28: "use the art settings... the
 * only thing I want to override is the room's colour." So the room stores ONE
 * thing (an additive column on `rooms`):
 *
 *   art          a logo KEY, exactly the key a recipe's logo pref stores:
 *                `lib:<id>` for a library set, or a bare the design system preset name.
 *                A key, never the SVG: re-art a set on the Icons page and every
 *                room wearing it follows, the way panes do.
 *
 * It renders EXACTLY as an agent pane renders its art (final ruling, Owner via
 * the design system): one --wm-ink tint and the .wm-backlit glow, both from --wm-pc = the
 * room colour. There is no "use the art's colours" path.
 *
 * NO STYLE ON THE ROOM. line / washFrom / backlit / scale / opacity are the
 * ART's (logos.style, edited on the Icons page) and apply as stored; this
 * module hands the page that opaque style string, as the preset module and
 * the recipe logo pref do, and the page's assetStyle() is its only parser.
 *
 * This module is pure apart from reading the pinned preset file; it never
 * touches the table (the store imports the validators; the routes pass the
 * library in when they resolve a key).
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class RoomArtError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/** A library key or a preset name. SHAPE only: whether it EXISTS is the
 *  route's question (resolveArt), because presets live in a web file. */
export function validArtKey(v: unknown): string {
  if (typeof v !== 'string' || !(/^lib:[1-9][0-9]{0,11}$/.test(v) || /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(v))) {
    throw new RoomArtError('art', 'art must be a logo key (lib:<id> or a preset name) or null');
  }
  return v;
}

/* ---- resolving a key to what the page draws ---- */

const PRESETS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'vendor', 'aurora-logo-presets.js');
let presetCache: { mtime: number; map: Record<string, string> } | null = null;

/** the design system pinned presets (the Contract-A file, read-only), memoised on mtime. */
function pinnedPresets(): Record<string, string> {
  try {
    const mtime = statSync(PRESETS_FILE).mtimeMs;
    if (presetCache?.mtime === mtime) {
      return presetCache.map;
    }
    const m = /\{[\s\S]*\}/.exec(readFileSync(PRESETS_FILE, 'utf8'));
    const map = m ? (JSON.parse(m[0]) as Record<string, string>) : {};
    presetCache = { mtime, map };
    return map;
  } catch {
    return presetCache?.map ?? {};
  }
}

export interface ArtLibraryRow {
  id: number;
  name: string;
  svg: string;
  style?: string | null;
}

/** What the page needs to draw a room's art: the art AS AUTHORED (the page's
 *  renderLogo tints it, exactly as a pane does), its label,
 *  and the art's OWN treatment as the opaque string logos.style stores (null =
 *  the art has no opinion, so the page's defaults apply — always the case for
 *  an the design system preset). */
export interface ResolvedArt {
  key: string;
  name: string;
  svg: string;
  style: string | null;
  /** A hash of the SVG [perf/poll-traffic]: the page caches the art under
   *  key + hash, so a poll can carry the REFERENCE (artRef) and the SVG
   *  crosses the wire once per change (GET /api/art/:key?h=<hash>). */
  hash: string;
}

/** The first 16 hex of the SVG's sha1: a cache key, not a security property. */
export function artHash(svg: string): string {
  return createHash('sha1').update(svg).digest('hex').slice(0, 16);
}

/** `art` without its SVG: what a poll that opted in (`?art=ref`) carries. */
export function artRef(art: ResolvedArt | null): Omit<ResolvedArt, 'svg'> | null {
  if (!art) {
    return null;
  }
  const { svg: _svg, ...ref } = art;
  return ref;
}

/** The art a key names, or null when there is none (a deleted library set, an
 *  unknown preset). `listArt` is a thunk so the table is read only for lib keys. */
export function resolveArt(key: string | null | undefined, listArt: () => ArtLibraryRow[]): ResolvedArt | null {
  if (!key) {
    return null;
  }
  if (key.startsWith('lib:')) {
    const id = Number(key.slice(4));
    const row = listArt().find((l) => l.id === id);
    return row ? { key, name: row.name, svg: row.svg, style: row.style ?? null, hash: artHash(row.svg) } : null;
  }
  const svg = pinnedPresets()[key];
  return typeof svg === 'string' ? { key, name: key, svg, style: null, hash: artHash(svg) } : null;
}
