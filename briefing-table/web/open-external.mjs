/* OPEN AN EXTERNAL URL (Owner 2026-09-28): ONE door for every link that leaves
 * the engine's pages — a room line's URL, a solo terminal's link, a handoff or
 * url-offer "Open". Engine pages (solo windows) are NOT external and never
 * come through here.
 *
 * WHERE THE PAGE IS decides the route (the cli-manager host contract):
 *   - the TOP document inside the native host (WebView2): post
 *     {cmd:'openExternal', url} and the toolkit opens the system default
 *     browser. The host listens on the top-level document ONLY (no iframe
 *     wiring, NewWindowRequested unhandled), so a frame never posts it.
 *   - a FRAME (a tab in the shell, a seat's solo page in a room): hand the url
 *     up with {hwbOpenExternal: url}. The parent relays it only from a frame it
 *     created itself (relayExternal), so a panel app nested anywhere cannot
 *     borrow the route.
 *   - anything else (a plain browser, a phone): a new window, no opener.
 *
 * Only http(s) ever leaves: anything else is refused here AND at every relay.
 */

/** The url when it is an absolute http(s) URL, else null. */
export function externalHref(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Open `url` outside the engine's pages. Returns false when it was refused. */
export function openExternal(url) {
  const href = externalHref(url);
  if (!href) {
    return false;
  }
  const wv = window.chrome?.webview;
  if (wv && typeof wv.postMessage === 'function' && window.top === window) {
    wv.postMessage({ cmd: 'openExternal', url: href }); // the toolkit: the system browser
    return true;
  }
  if (window.parent !== window) {
    window.parent.postMessage({ hwbOpenExternal: href }, '*'); // the shell / the room relays it
    return true;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Relay {hwbOpenExternal} from this page's OWN frames. `isOwnFrame(source)`
 * answers whether the message came from a frame this page created; nothing
 * else is relayed (a deeper frame's message reaches only its own parent).
 */
export function relayExternal(isOwnFrame) {
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || typeof d.hwbOpenExternal !== 'string') {
      return;
    }
    if (!isOwnFrame(ev.source)) {
      return;
    }
    openExternal(d.hwbOpenExternal); // re-checked there: http(s) only
  });
}
