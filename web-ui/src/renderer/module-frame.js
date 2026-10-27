// The module frame link (the design notes revision 7, item 2 and C1; web: the design notes §2-3),
// renderer side. It makes the module's frame (sandbox="allow-scripts", empty allow, no referrer), declares the exact
// URL BEFORE setting src (desktop: main allows that one navigation once; web: the page's own guard), and only then
// sets src itself. The port goes to the frame only after the frame asks for it with {wbHello: <this load's wbl>}
// from that frame's own contentWindow, before any second load: a page the frame navigated to never learns the
// nonce, so it never picks up the bridge. Any second load (the page navigated or reloaded
// itself) closes the port and posts nothing; so do a revocation and close(). It returns at once with the frame
// (the side column mounts it straight away); `ready` settles true once src is set, false if the declaration was
// refused, the call failed, or the link ended first. No imports: loaded by tests and by the renderer alike.

/** {wbHello: nonce}: a plain object with exactly one own data property of exactly that string. */
function isHello(m, nonce) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const proto = Object.getPrototypeOf(m);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(m);
  if (keys.length !== 1 || keys[0] !== 'wbHello') return false;
  const d = Object.getOwnPropertyDescriptor(m, 'wbHello');
  return !!d && Object.prototype.hasOwnProperty.call(d, 'value') && d.value === nonce;
}

const WEB_UI = /^\/app\/(?:modules|plugins)\/[a-z][a-z0-9-]{0,40}\/ui\//;

/** Is this a module page the frame link must carry? Desktop: a wbmod: URL. Web: a same-origin
 *  /app/modules/<id>/ui/ or /app/plugins/<id>/ui/ page (the design notes §2). */
export function isModuleFrameSrc(src, origin = globalThis.location?.origin) {
  if (typeof src !== 'string') return false;
  if (src.startsWith('wbmod:')) return true;
  if (!origin) return false;
  try {
    const u = new URL(src, origin);
    return u.origin === origin && WEB_UI.test(u.pathname);
  } catch {
    return false;
  }
}

/** A module's ui page URL: the engine's prefix when the catalog gives one (web), else wbmod: (desktop). */
export function moduleUiUrl(m, page, origin = globalThis.location?.origin) {
  if (typeof m.url === 'string' && origin) {
    let u = null;
    try { u = new URL(m.url, origin); } catch { u = null; }
    const p = u && u.origin === origin && !u.search && !u.hash && !/\/\.\.?(?:\/|$)/.test(m.url) ? /^\/app\/(?:modules|plugins)\/([a-z][a-z0-9-]{0,40})\/$/.exec(u.pathname) : null;
    if (p && p[1] === m.id) return new URL(u.pathname + page, origin); // its own folder only, no dot segments
  }
  return new URL('wbmod://' + m.id + '/' + page);
}

export function createFrameLink({ doc, win = globalThis.window, src, owner, title = 'Tool', declare, onMessage = () => {}, onClose = () => {}, onConnect = () => {} }) {
  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('allow', '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = title;
  let port = null;
  let loads = 0;
  let ended = false;
  let srcSet = false; // a frame inserted before src fires a load for about:blank: not ours, not counted
  // This load's own URL: a fresh random parameter, so main's one-time allowance names this load only
  // (an undeclared frame with the same page URL cannot use it).
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const url = src + (src.includes('?') ? '&' : '?') + 'wbl=' + nonce;

  function end(why) {
    if (ended) return;
    ended = true;
    win?.removeEventListener?.('message', onHello);
    if (port) {
      // tell the frame first, so every call it already sent settles as revoked (a builder's step 4 review)
      try { port.postMessage({ wbBridge: 'revoked' }); } catch { /* already closed */ }
      try { port.close(); } catch { /* already closed */ }
      port = null;
    }
    try { onClose(why); } catch { /* the owner's own error */ }
  }

  let target = null; // the frame's window as recorded at src time; only it may ask, only it gets the port
  function connect() {
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = (e) => {
      if (!ended) {
        try { onMessage(e.data); } catch { /* the owner's own error */ }
      }
    };
    target.postMessage({ wbBridge: 1 }, '*', [ch.port2]); // '*': the frame's origin is opaque
    try { onConnect(); } catch { /* the owner's own error */ } // S4 step 6: the host may post its events now
  }

  // The frame's hello (its script runs during parsing, so this may come before the load event).
  function onHello(e) {
    if (ended || port || !srcSet || !target || !e || e.source !== target || loads > 1) return;
    if (!isHello(e.data, nonce)) return;
    connect();
  }
  win?.addEventListener?.('message', onHello);

  frame.addEventListener('load', () => {
    if (ended || !srcSet) return;
    loads += 1;
    if (loads > 1) end('navigated'); // the frame navigated or reloaded itself: its new document gets nothing
  });

  const ready = (async () => {
    let ok = false;
    try {
      ok = (await declare(url, owner)) === true;
    } catch {
      ok = false;
    }
    if (ended) return false; // closed while main was answering: never load
    if (!ok) {
      end('refused');
      return false;
    }
    target = frame.contentWindow;
    if (!target) {
      end('no-window');
      return false;
    }
    srcSet = true;
    frame.src = url;
    return true;
  })();

  return {
    frame,
    ready,
    closed: () => ended,
    /** A reply or host event to the frame; false once the link has ended. */
    post(msg) {
      if (ended || !port) return false;
      port.postMessage(msg);
      return true;
    },
    /** Main revoked this owner (a navigation it denied, a disabled module). */
    revoke: () => end('revoked'),
    close: () => end('closed'),
  };
}
