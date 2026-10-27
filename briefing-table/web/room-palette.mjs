/* ROOM PALETTE OVERRIDE [hub-v2] (Owner 2026-10-04/05, the design system b0f8099 sec 1.E).
 *
 * A room can follow the person's global palette (web/palette.mjs, the Global
 * color palette setting) or carry its own palette + Dark/Light (rooms.pal /
 * rooms.pal_mode). The override applies to THAT ROOM'S PAGE ONLY: it sets the
 * token map inline on this page's <html> exactly as the global one does, and it
 * is never `remember`ed (that cache is the global first-paint cache, read by
 * every other page). Reset to global puts the person's own palette back.
 *
 * A room's stored color is NEVER adapted to a palette (Owner 2026-10-05: the
 * watermark tint, --wm-pc, stays the color the room has).
 *
 * palette.mjs is imported lazily: a room with no override on a page that never
 * had one costs nothing. */

const CACHE_KEY = 'hwb.palette.v1';
let globalFromEngine = null; // GET /api/rooms/me .palette: {key, mode, custom?}
let applied = ''; // 'key|mode' while this page wears the room's own palette, else ''
let roomPref = null; // the room's own {key, mode} while it has one [app theme]

/** The engine's word on the person's global palette (the cache can lag a change made elsewhere). */
export function setGlobalPref(p) {
  globalFromEngine = p && typeof p === 'object' && typeof p.key === 'string' ? p : null;
}

/** The person's global palette: the engine's, else the first-paint cache's, else the design system dark. */
export function globalPref() {
  if (globalFromEngine) {
    return globalFromEngine;
  }
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && c.pref && typeof c.pref.key === 'string') {
      return c.pref;
    }
  } catch {
    /* no storage: the default */
  }
  return { key: 'aurora', mode: 'dark' };
}

/** The effective palette pref: the room's own override if set, else the person's global one [app theme, the design system [ref]]. */
export function effectivePref() {
  return roomPref || globalPref();
}

let chain = Promise.resolve();
/**
 * Make this page wear the room's palette (or the global one again). Idempotent;
 * serialised so two quick paints cannot interleave. Resolves when applied.
 */
export function paintRoomPalette(room) {
  const want = room && room.pal ? `${room.pal}|${room.pal_mode || 'dark'}` : '';
  roomPref = want ? { key: room.pal, mode: room.pal_mode === 'light' ? 'light' : 'dark' } : null;
  if (want === applied) {
    return chain;
  }
  chain = chain.then(async () => {
    try {
      const P = await import('/palette.mjs');
      if (want) {
        if (!P.PALETTES[room.pal] || P.PALETTES[room.pal].custom) {
          return; // an unknown key (a newer build wrote it): leave the page as it is
        }
        const mode = room.pal_mode === 'light' ? 'light' : 'dark';
        P.apply(document, P.tokens(room.pal, null, mode), mode);
      } else {
        P.applyPref(document, globalPref()); // Reset to global
      }
      applied = want;
      document.dispatchEvent(new CustomEvent('room-palette'));
    } catch {
      /* palette.mjs did not load: the page keeps what it has */
    }
  });
  return chain;
}

/**
 * The room color that belongs to the palette now in force on this page: its
 * "go" accent's hue at the identity register (L .62 dark, .56 light), so the
 * room's derived accent lands on the palette's own action color. A neutral
 * accent (Greyscale) gets a neutral room. Reads the page's own --teal, so it is
 * right for the room's override and the global palette alike; '#rrggbb'.
 */
export async function paletteRoomColor() {
  const P = await import('/palette.mjs');
  const { hexToOklch } = await import('/room-character.mjs'); // dynamic: room-character imports THIS module
  const teal = getComputedStyle(document.documentElement).getPropertyValue('--teal').trim() || '#2dd4bf';
  const o = hexToOklch(P.hex(teal));
  if (!o) {
    return null;
  }
  const L = document.documentElement.dataset.mode === 'light' ? 0.56 : 0.62;
  const c = o.c < 0.03 ? 0 : Math.min(0.16, Math.max(0.09, o.c * 1.15));
  return P.hex(`oklch(${L} ${c.toFixed(3)} ${o.h.toFixed(1)})`);
}
