/* APP THEME [app theme] the design system [ref], Owner 2026-10-05. The room's EFFECTIVE
 * theme, told to every app panel on its MessagePort so an app (Asset Studio)
 * follows Dark/Light AND the palette:
 *   {host:'theme', mode:'dark'|'light', tokens:{...}, room?:'#hex'}
 * tokens = web/palette.mjs tokens() for the effective palette (the room's own
 * override if set, else the person's global pref), keys WITHOUT the "--"; the design system
 * dark is {} (still sent, so an app can reset). room = the room's color, omitted
 * when it has none. Pure: the caller hands in tokens() and the state. */

const MODES = ['dark', 'light'];

/** The message. `tokensFn` is palette.mjs tokens; `pref` {key, mode, custom?}; `domMode` the page's applied
 *  mode (the only honest mode of a custom palette, whose light/dark is read from its ink). */
export function themeMessage(tokensFn, pref, domMode, color) {
  const p = pref && typeof pref.key === 'string' ? pref : { key: 'aurora', mode: 'dark' };
  const want = MODES.includes(p.mode) ? p.mode : 'dark';
  const tokens = tokensFn(p.key, p.custom, want) || {};
  const mode = p.custom && MODES.includes(domMode) ? domMode : want;
  return { host: 'theme', mode, tokens, ...(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? { room: color } : {}) };
}

/** `?mode=light` as a first-paint hint on a frame URL (dark is the default: unchanged). */
export function withMode(url, mode) {
  if (mode !== 'light') {
    return url;
  }
  const abs = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const u = new URL(url, 'http://x.invalid');
  u.searchParams.set('mode', 'light');
  return abs ? u.href : u.pathname + u.search + u.hash;
}
