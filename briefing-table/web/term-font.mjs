/* Terminal font size — the storage contract.
 *
 * THE BUG THIS FIXES: font size used to be a per-SESSION value. Every A-/A+
 * click wrote `setPrefs {fontSize}` to the engine, which stored it on the pane
 * row AND mirrored it into the recipe — so a size chosen on the laptop followed
 * the session back to the VRPC and vice versa. Font size is a property of the
 * SCREEN you are looking at, not of the session you are looking at.
 *
 * THE MODEL: the device owns its size, the engine supplies the starting point.
 *   · a device that has expressed an opinion  -> localStorage wins, always
 *   · a device that has not                   -> the engine's pref seeds it
 * The engine's pref is NOT dead weight after this change; it is the seed
 * channel, still set from the manager's recipe form.
 *
 * PER-DEVICE, NOT PER-DEVICE-PER-PANE. One key. The premise of the change is
 * that size tracks the screen, so splitting it per pane would recreate the same
 * "retune it N times" chore one axis over. Storage is already origin-scoped, so
 * the VRPC's loopback origin and the laptop's https origin are separate stores
 * for free.
 *
 * NOT DERIVED FROM devicePixelRatio OR THE WINDOWS SCALING %. CSS px already
 * account for OS scaling — at 150% a 15px font renders 1.5x the physical pixels
 * and looks the same size — so scaling by DPR would double-apply it. (Browser
 * zoom, Ctrl +/-, is a separate knob that also scales CSS px; it is the user's
 * deliberate choice and we leave it alone.)
 */
export const KEY = 'wb-termfont';
export const FONT_MIN = 8;
export const FONT_MAX = 32;
export const FONT_DEFAULT = 16;

export function clampPx(px) {
  const n = Math.round(Number(px));
  if (!Number.isFinite(n)) {
    return FONT_DEFAULT;
  }
  return Math.max(FONT_MIN, Math.min(FONT_MAX, n));
}

/** This device's stored size, or null for "no opinion".
 *  Every access is guarded: a private window, cleared site data, or a browser
 *  configured to block storage THROWS on access rather than returning empty. */
export function loadDeviceFont() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return null;
    }
    const rec = JSON.parse(raw);
    if (!rec || typeof rec.px !== 'number' || !Number.isFinite(rec.px)) {
      return null;
    }
    return { v: 1, px: clampPx(rec.px) };
  } catch {
    return null; // storage unavailable = this device has no opinion, not an error
  }
}

export function saveDeviceFont(px) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, px: clampPx(px) }));
    return true;
  } catch {
    return false; // size still applies for this page; it just will not persist
  }
}

/**
 * Decide the size to render at.
 * `stored` is loadDeviceFont()'s result; `enginePx` is prefs.fontSize (may be
 * null/undefined). Returns {px, fromDevice} — `fromDevice` is what tells the
 * caller to IGNORE later engine prefs for this pane, which matters because
 * pane.ready fires again on every reattach and pane.prefs echoes on every
 * rename/recolor. Without that guard a reconnect would snap the laptop back to
 * the VRPC's value.
 */
export function resolveFont(stored, enginePx) {
  if (stored) {
    return { px: stored.px, fromDevice: true };
  }
  if (typeof enginePx === 'number' && Number.isFinite(enginePx)) {
    return { px: clampPx(enginePx), fromDevice: false };
  }
  return { px: FONT_DEFAULT, fromDevice: false };
}
