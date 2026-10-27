/* APP BEHAVIOR PREFERENCES [room switch] (Owner 2026-10-08): the one new Global-settings section, "App behavior".
 *
 * First setting: what the app in the room page's right-hand column does when you switch to another room or workgroup.
 *   'stay'    (default) the app stays exactly as it is: the page switches rooms IN PLACE and never touches it (scroll, state and all)
 *   'reopen'  the app is closed and the same app is opened again for the NEW room (a review of the room you left should not sit next to the new one)
 *
 * PER DEVICE (localStorage): this needs no engine key, and a phone and a desk can differ. If Owner wants it to follow him across devices it moves to
 * GET/PATCH /api/rooms/me beside enterSubmits (an engine change); readers go through getSwitchMode() so that move touches one file.
 * A missing or unreadable value is 'stay'. Every storage access is guarded (private windows throw). */

const KEY = 'hwb.appBehavior.switch';
export const SWITCH_MODES = ['stay', 'reopen'];
export const SWITCH_DEFAULT = 'stay';

export function parseSwitchMode(v) {
  return SWITCH_MODES.includes(v) ? v : SWITCH_DEFAULT;
}

export function getSwitchMode() {
  try {
    return parseSwitchMode(localStorage.getItem(KEY));
  } catch {
    return SWITCH_DEFAULT;
  }
}

export function setSwitchMode(v) {
  const mode = parseSwitchMode(v);
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* no storage: the choice lasts until the page closes only through the caller's own state */
  }
  return mode;
}
