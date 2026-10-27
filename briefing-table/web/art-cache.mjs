/* ROOM ART BY REFERENCE [perf/poll-traffic].
 *
 * A room view's `art_render` used to carry the art's whole SVG on every 2.5 s
 * poll (~5 KB per room, most of each view). A poll now asks `?art=ref` and gets
 * {key, name, style, hash}; this module puts the SVG back from a per-page cache
 * keyed by key + hash, fetching GET /api/art/:key?h=<hash> once per new pair
 * (that URL is immutable, so a reload is served from the browser's cache).
 *
 * hydrateArt(room) fills `room.art_render.svg` IN PLACE and resolves the room,
 * so every reader (roomLogo, characterMark, the places sheet) sees exactly the
 * shape it saw before. A view that still carries the SVG (the room.state push,
 * a PATCH answer) is remembered, never refetched. A fetch that fails leaves the
 * art out for this pass (the room draws without it) and the next poll retries.
 */
const cache = new Map(); // `${key}#${hash}` -> svg
const inflight = new Map(); // same key -> Promise<string|null>

const idOf = (a) => `${a.key}#${a.hash || ''}`;

/** Keep an SVG a view already carries. */
export function rememberArt(room) {
  const a = room && room.art_render;
  if (a && typeof a.svg === 'string' && a.svg && a.key && a.hash) {
    cache.set(idOf(a), a.svg);
  }
}

function fetchArt(a) {
  const id = idOf(a);
  let p = inflight.get(id);
  if (!p) {
    p = fetch(`/api/art/${encodeURIComponent(a.key)}${a.hash ? `?h=${encodeURIComponent(a.hash)}` : ''}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const svg = body && typeof body.svg === 'string' ? body.svg : null;
        if (svg) {
          cache.set(id, svg);
        }
        return svg;
      })
      .catch(() => null)
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

/** Fill `room.art_render.svg` from the cache (fetching once when new). */
export async function hydrateArt(room) {
  const a = room && room.art_render;
  if (!a || !a.key) {
    return room;
  }
  if (typeof a.svg === 'string') {
    rememberArt(room);
    return room;
  }
  const svg = cache.get(idOf(a)) ?? (await fetchArt(a));
  if (svg) {
    a.svg = svg;
  }
  return room;
}
