/* AUTO COLOR FOR A WORKGROUP [workgroup design] Owner 2026-10-05: "Both UI and
 * application carried the same color. I didn't choose one. I assumed it would
 * auto-pick one for each room." Pure: no db, no clock.
 *
 * The pick is from the room settings' sample swatches (web/room.js SWATCHES, the
 * same list), the first whose hue is at least HUE_MIN degrees (oklch) from every
 * color already in the family; when every swatch is too close, the one with the
 * largest distance to its nearest neighbor. */

export const ROOM_SWATCHES = ['#1f8fa6', '#0dab49', '#1f5fbf', '#ba08b4', '#d9622b', '#c9a227', '#5b6bd6', '#b83b5e'] as const;
export const HUE_MIN = 30;

const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** The oklch hue of #rrggbb in degrees 0-360 (grays have no real hue; any value is fine, 0 here). */
export function oklchHue(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = lin(((n >> 16) & 255) / 255);
  const g = lin(((n >> 8) & 255) / 255);
  const b = lin((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(bb, a) * 180) / Math.PI;
  return (h + 360) % 360;
}

/** Distance on the hue circle, 0-180. */
export function hueDistance(a: string, b: string): number {
  const d = Math.abs(oklchHue(a) - oklchHue(b));
  return d > 180 ? 360 - d : d;
}

/** The swatch to give a new workgroup, given the colors already in its family (nulls ignored). */
export function pickRoomColor(used: Array<string | null | undefined>): string {
  const taken = used.filter((c): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));
  if (!taken.length) {
    return ROOM_SWATCHES[0];
  }
  let best: string = ROOM_SWATCHES[0];
  let bestGap = -1;
  for (const sw of ROOM_SWATCHES) {
    const gap = Math.min(...taken.map((t) => hueDistance(sw, t)));
    if (gap >= HUE_MIN) {
      return sw;
    }
    if (gap > bestGap) {
      bestGap = gap;
      best = sw;
    }
  }
  return best;
}
