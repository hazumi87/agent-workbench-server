/* IS THIS PAGE ON SCREEN? [perf/poll-traffic]
 *
 * A page that polls should not poll while nobody can see it. Standalone, the
 * browser says so (document.visibilityState: a minimised or background
 * window). Inside the CLI-Manager shell it does NOT: an inactive tab is a
 * `display:none` iframe, and a document in a hidden iframe still reads
 * `visible`. So the shell tells each tab frame when it is shown or hidden
 * (postMessage {hwbVisibility: 'visible'|'hidden'}), and a page is hidden when
 * EITHER says so. A page with no shell above it uses the browser's word alone.
 *
 *   isHidden()            now
 *   onVisibility(cb)      cb(visible) on every hidden <-> visible transition
 */
let shellHidden = false;
let last = null;
const subs = new Set();

export function isHidden() {
  return document.visibilityState === 'hidden' || shellHidden;
}

function changed() {
  const now = isHidden();
  if (now === last) {
    return;
  }
  last = now;
  for (const cb of subs) {
    try {
      cb(!now);
    } catch {
      /* one subscriber must not stop the rest */
    }
  }
}

export function onVisibility(cb) {
  subs.add(cb);
  if (last === null) {
    last = isHidden();
  }
  return () => subs.delete(cb);
}

if (window.parent !== window) {
  window.addEventListener('message', (ev) => {
    if (ev.source !== window.parent || !ev.data || typeof ev.data !== 'object') {
      return;
    }
    const v = ev.data.hwbVisibility;
    if (v === 'visible' || v === 'hidden') {
      shellHidden = v === 'hidden';
      changed();
    }
  });
}
document.addEventListener('visibilitychange', changed);
