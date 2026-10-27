/* THE TAB STRIP ON A TOUCH TABLET [ipad tabs] Owner 2026-10-05: "render the tabs into the page" on an iPad.
 *
 * The tab strip of open rooms and agent windows is the SHELL's (web/shell.html + shell-tabs.mjs: a tab per page, each page an
 * iframe, the design system window-chrome tabs). A native window gets it from the window host; a browser tab on an iPad opened a
 * room or an agent page BARE, with no way to move between them. So on a touch tablet (html.touch-wide's test: a coarse
 * pointer, or an iPad in desktop-class mode, wider than a phone) a room / agent page opened at the top level hands itself
 * to the shell: /shell.html?tabs=<this page>. Same tab code, no second tab system. A phone (<= 600px) keeps its places
 * sheet; `?shell=0` opts out.
 *
 * DESKTOP BROWSER [desktop shell] (Owner 2026-10-14, "did we lose the tabbed in browser view?"): a mouse desktop enters the
 * shell the same way. Desktop = a fine primary pointer (a touch laptop with a mouse is desktop), a physical screen that is
 * not a phone's, and a viewport wider than a phone. NOT wrapped: a standalone app window (Edge --app, installed app:
 * display-mode other than browser), a page in a frame, `?shell=0`, or localStorage hwb.shell.desktop = '0' (the persistent
 * opt-out; '1' / `?shell=1` forces the wrap; a webdriver (Playwright) is bare unless forced; shell.html's status menu is not needed, set it in the console or via the probe helper). The native window host
 * loads pages as frames of /app/shell.html, so it never reaches this gate at the top level.
 *
 * Imported FIRST by room.js and solo.js: when it redirects, its top-level await never settles, so the importing page never
 * starts (no second attach, no duplicate sockets) while the navigation happens. A page already in a frame (the shell's own
 * tabs, the room's seat view) never redirects.
 */
import { isTouchWide, phoneSized, touchWanted } from '/touch-ui.mjs';

export const DESKTOP_OPT_OUT_KEY = 'hwb.shell.desktop'; // localStorage '0' = a desktop browser keeps its pages bare

export function shellUrlFor(pathname, search) {
  /* the CLI Manager IS the shell's hub tab: the shell adds it itself, so it goes in with no ?tabs= (a second one would be a
     duplicate "CLI Manager" tab) */
  if (pathname === '/manager.html' || pathname === '/') {
    return '/shell.html'; // '/' is the Manager too (the engine serves it at the root)
  }
  return `/shell.html?tabs=${encodeURIComponent(pathname + search)}`;
}

export function shouldEnterShell() {
  if (window.parent !== window) {
    return false;
  }
  try {
    if (new URLSearchParams(location.search).get('shell') === '0') {
      return false;
    }
  } catch {
    return false;
  }
  return isTouchWide() || isDesktopBrowser();
}

/** A mouse desktop in a plain browser tab: the shell's tab strip is wanted, unless the person turned it off.
 *  AUTOMATION (navigator.webdriver: Playwright, Selenium) is NOT wrapped by default: ~90 probes open room.html / solo.html /
 *  manager.html on a 1280x800 mouse viewport and expect the bare page. `?shell=1` or localStorage hwb.shell.desktop = '1'
 *  forces the wrap (probes of the shell itself); a real person is never a webdriver, so nothing changes for Owner. */
export function isDesktopBrowser() {
  let forced = false;
  try {
    forced = new URLSearchParams(location.search).get('shell') === '1' || localStorage.getItem(DESKTOP_OPT_OUT_KEY) === '1';
  } catch {
    /* no location / storage blocked */
  }
  try {
    if (!forced && localStorage.getItem(DESKTOP_OPT_OUT_KEY) === '0') {
      return false;
    }
  } catch {
    /* storage blocked: no opt-out to read */
  }
  try {
    if (!forced && navigator.webdriver === true) {
      return false;
    }
    const mm = (q) => window.matchMedia?.(q)?.matches === true;
    if (touchWanted() || phoneSized() || !mm('(min-width: 601px)')) {
      return false; // a finger, a phone screen, or a phone-width window: not a desktop
    }
    return !(mm('(display-mode: standalone)') || mm('(display-mode: minimal-ui)') || mm('(display-mode: fullscreen)') || mm('(display-mode: window-controls-overlay)'));
  } catch {
    return false;
  }
}

export const enteringShell = shouldEnterShell();
if (enteringShell) {
  location.replace(shellUrlFor(location.pathname, location.search));
  await new Promise(() => {}); // the page does not start: it is being replaced
}
