/* shell-update.mjs — does this window's CHROME match what the engine is
 * serving?
 *
 * WHY THIS EXISTS. A shell window loads its chrome exactly once and never
 * re-fetches it: `/api/reload-ui` reloads the PANES inside the frame, not the
 * frame around them, and the host has no reload verb. So a window opened
 * before a chrome change keeps painting the old chrome indefinitely, with no
 * error anywhere — which on 2026-09-20 cost an hour chasing a status glyph
 * that "showed nothing" while the engine, the manager and the page were all
 * correct and a freshly-loaded shell painted it perfectly. The window was
 * simply running the previous build.
 *
 * WHY IT DETECTS RATHER THAN BEING PUSHED. The engine cannot reach a shell: a
 * shell holds no socket of its own, only its tabs do. A push would therefore
 * have to travel engine -> pane -> postMessage -> shell, which makes every
 * pane a courier for a window-level concern. Asking "is my chrome current?" is
 * the same question answered locally, with no new engine surface and no new
 * seam.
 *
 * WHY IT OFFERS RATHER THAN RELOADING. A shell reload re-attaches every pane,
 * and a re-attached pane rebuilds from the ENGINE'S replay buffer — so window
 * scrollback beyond that buffer is lost (2026-09-10). That is a real cost and
 * not ours to spend silently while someone is reading. The tab set survives
 * (sessionStorage), so the reload itself is safe; it is the scrollback that
 * argues for one deliberate click.
 *
 * THE STAMP is the engine's own asset version — `?v=<newest mtime under web/>`
 * — rewritten into every HTML src/href at serve time. One stamp for the whole
 * set, so any chrome change moves it. We read ours out of the document we were
 * served, and compare against a fresh fetch of the same page.
 */

const STAMP_RE = /[?&]v=(\d+)/;

/** The stamp THIS document was served with, or null if unstamped (a dev build
 *  serving files unrewritten — in which case there is nothing to compare and
 *  the watcher stays quiet rather than crying wolf every poll). */
export function ownStamp(doc = document) {
  for (const el of doc.querySelectorAll('script[src], link[href]')) {
    const m = STAMP_RE.exec(el.getAttribute('src') || el.getAttribute('href') || '');
    if (m) {
      return m[1];
    }
  }
  return null;
}

/** The stamp the engine is serving RIGHT NOW for this page. Null on any
 *  failure — a watcher that cannot reach the engine must say nothing, not
 *  claim staleness (the engine being down is not a new build). */
export async function servedStamp(url) {
  /* Resolved INSIDE, not as a default parameter: a default would evaluate
     `location` in any caller that omits the argument, which throws outside a
     browser and made this untestable. */
  const target = url ?? (typeof location !== 'undefined' ? location.pathname : '/');
  try {
    const r = await fetch(target, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) {
      return null;
    }
    const m = STAMP_RE.exec(await r.text());
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Watch for a newer chrome build. Calls `onStale(served, own)` ONCE, the first
 * time the served stamp differs from ours.
 *
 * Checks on a slow clock and whenever the window regains focus — the moment a
 * person is about to look at it, which is exactly when a stale glyph misleads.
 * Fires once and stops: this is a durable marker, not a nag (the attention
 * rule — prominence and lifetime, never fire rate).
 */
export function watchForUpdate({ onStale, everyMs = 5 * 60 * 1000, doc = document } = {}) {
  const mine = ownStamp(doc);
  if (!mine) {
    return () => {};
  }
  let done = false;
  let timer = null;

  const check = async () => {
    if (done) {
      return;
    }
    const served = await servedStamp();
    /* Only a DIFFERENT stamp counts, not a bigger one: the engine can be rolled
       back, and a window running art nobody is serving any more is just as
       stale as one running an older build. */
    if (served && served !== mine) {
      done = true;
      stop();
      onStale(served, mine);
    }
  };

  const onFocus = () => { void check(); };
  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
    window.removeEventListener('focus', onFocus);
  };

  timer = setInterval(check, everyMs);
  window.addEventListener('focus', onFocus);
  return stop;
}
