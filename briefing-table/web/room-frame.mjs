/* THE ROOM'S FRAME IS LOCKED TO THE GLASS [web/room-ios-lock].
 *
 * Owner (2026-09-28, iPhone, Edge-on-iOS = WebKit): the inner chat scrolled,
 * but the whole page ALSO scrolled and resized, and the room drew shrunk to
 * ~70% of the screen with black around it. The solo and manager pages had the
 * installation's phone protections for weeks (KB design-notes-id + its 2026-09-01
 * correction; the design notes); the room page had
 * none of them. This module is those same protections, for the room:
 *
 *   - screen-clamp.mjs: when iOS lays the page out wider than the glass
 *     (Display Zoom: innerWidth 398 against screen.width 320), `--app-w` pins
 *     the room's ROOT box (body, room.css) to the visible width
 *   - the zoom blockers: pinch and double-tap. CAPTURE phase, passive:false
 *     (a passive listener's preventDefault is silently ignored; a bubble-phase
 *     one never runs under a widget that stops propagation). A ONE-finger
 *     touchstart is never touched, so the line's own scroll is unaffected, and
 *     a quick second tap on a CONTROL is left alone (it carries touch-action:
 *     manipulation, so it cannot zoom, and cancelling it would eat its click)
 *   - `--vvh` ONLY while the soft keyboard is up (100svh otherwise — room.css),
 *     so the composer stays above the keys and never under Edge's bottom bars
 *   - the page itself never scrolls: html/body are overflow hidden (room.css)
 *     and any scroll iOS makes anyway (a focus reveal) is put back to 0
 *   - /api/diag/viewport: the room reports what it measured, so the next report
 *     from the phone carries numbers instead of a photo to reason from
 *
 * Pinch is blocked here although the correction says not to, and deliberately:
 * the correction's harm was maximum-scale + a layout wider than the glass, with
 * pinch the only way out. The viewport meta here has no maximum-scale, the
 * clamp keeps the layout on the glass, and Owner asked for the frame locked.
 */
import { installScreenClamp, visibleWidth } from '/screen-clamp.mjs';
import { trackSoftKeyboard, isTextField } from '/soft-keyboard.mjs'; // the keyboard tracker, shared with solo [web/solo-keybar-auto]

/* a second quick tap on one of these is a click, not a zoom (touch-action:
   manipulation already rules the zoom out on them in room.css) */
const CONTROL = 'button, a[href], input, textarea, select, label, summary, [role="button"], [role="option"], [contenteditable=""], [contenteditable="true"]';
function installZoomBlockers() {
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) {
      e.preventDefault(); // a second finger is a pinch
    }
  }, { passive: false, capture: true });
  let lastEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    const quick = now - lastEnd <= 300;
    lastEnd = now;
    if (quick && e.touches.length === 0 && !(e.target instanceof Element && e.target.closest(CONTROL))) {
      e.preventDefault(); // double-tap-to-zoom
    }
  }, { passive: false, capture: true });
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) { // iOS only; harmless elsewhere
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false, capture: true });
  }
}

/** Nothing scrolls the PAGE: the line and the panels are the scrollers. */
function lockPageScroll() {
  let queued = false;
  window.addEventListener('scroll', () => {
    if (queued || (window.scrollX === 0 && window.scrollY === 0)) {
      return;
    }
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      window.scrollTo(0, 0);
    });
  }, { passive: true });
}

/** The outermost boxes that reach past the layout viewport's right edge — the
 *  things that widen the page. A box that clips sideways contains its own
 *  children, so its subtree is never walked (cheap on a long line). */
export function wideBoxes(limit = 8) {
  const W = window.innerWidth;
  const out = [];
  const walk = (el) => {
    if (out.length >= limit) {
      return;
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'none') {
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width && r.right > W + 0.5 && cs.position !== 'fixed') {
      const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls} r=${Math.round(r.right)} w=${Math.round(r.width)}`);
      return;
    }
    if (cs.overflowX !== 'visible') {
      return;
    }
    for (const c of el.children) {
      walk(c);
    }
  };
  for (const c of document.body.children) {
    walk(c);
  }
  return out;
}

/**
 * @param {{build: string, roomId: string|null}} o
 */
export function installRoomFrame(o) {
  const root = document.documentElement;
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim() || null;
  const vv = window.visualViewport;

  /* the keyboard tracker's state, which the diag reports (installed below;
     until then, and on a desktop, its state is all nulls) */
  let keyboard = null;
  const kbState = () => (keyboard ?? trackSoftKeyboard({ when: false })).state();

  /* ---- what this page measured (the solo/manager habit) ---- */
  let pending = []; // every WHY in the debounce window, each with its state AT CALL TIME
  const report = (why) => {
    try {
      const rect = (sel) => {
        const e = document.querySelector(sel);
        if (!e) {
          return null;
        }
        const r = e.getBoundingClientRect();
        return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
      };
      const whys = pending.length ? pending : [{ why, atMs: Date.now(), state: kbState() }];
      pending = [];
      navigator.sendBeacon?.('/api/diag/viewport', new Blob([JSON.stringify({
        page: 'room',
        why: whys.map((w) => w.why).join(','),
        whys, // the state when each was RAISED; everything below is at SEND time
        build: o.build,
        room: o.roomId,
        ...kbState(),
        inner: [window.innerWidth, window.innerHeight],
        outer: [window.outerWidth, window.outerHeight],
        screen: [window.screen?.width, window.screen?.height],
        overhang: window.innerWidth - Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0),
        visible: visibleWidth(),
        appW: css('--app-w'),
        docScrollW: document.scrollingElement?.scrollWidth ?? null,
        docScrollH: document.scrollingElement?.scrollHeight ?? null,
        docClientW: root.clientWidth,
        bodyScrollW: document.body.scrollWidth,
        bodyW: Math.round(document.body.getBoundingClientRect().width),
        scroll: [window.scrollX, window.scrollY],
        scrollTops: { doc: document.scrollingElement?.scrollTop ?? null, body: document.body.scrollTop, main: document.getElementById('main')?.scrollTop ?? null },
        vvFull: vv ? { w: Math.round(vv.width), h: Math.round(vv.height), scale: vv.scale, offX: vv.offsetLeft, offY: vv.offsetTop } : null,
        dpr: window.devicePixelRatio,
        mqNarrow: window.matchMedia?.('(max-width: 600px)')?.matches ?? null,
        mqCoarse: window.matchMedia?.('(pointer: coarse)')?.matches ?? null,
        wide: wideBoxes(),
        hdr: rect('.ph-hdr'),
        strip: rect('#phStrip'),
        compose: rect('#compose'),
        line: rect('#lineScroll'),
        ua: navigator.userAgent,
      })], { type: 'application/json' }));
    } catch {
      /* a diagnostic must never be able to break the page it measures */
    }
  };
  let timer = null;
  const reportSoon = (why, state) => {
    try {
      pending.push({ why, atMs: Date.now(), state: state ?? kbState() });
      if (pending.length > 8) {
        pending.shift();
      }
    } catch {
      /* never */
    }
    clearTimeout(timer);
    timer = setTimeout(() => report(why), 700);
  };

  installScreenClamp((clampedTo) => {
    if (clampedTo !== null) {
      reportSoon('screen-clamp');
    }
  });
  installZoomBlockers();
  lockPageScroll();

  /* ---- the soft keyboard (Owner 2026-09-29, the input stuck BELOW the keys) --
   * The diag proved it: `keyboard-down, vvh null` while vv.height was 254 —
   * sync() ran on a transient mid-animation height and nothing ran again. On
   * iOS WebKit visualViewport's resize fires mid-animation or NOT AT ALL
   * (re-focusing a focused field, the predictive bar coming and going, focus
   * moving between inputs), and the layout viewport never resizes. So NO ONE
   * EVENT IS TRUSTED: every trigger re-syncs, then again every frame for the
   * animation (~800 ms) and once more at 1 s; and while a text field has
   * focus, a 1 s poll (POLL_MS) compares vv against what was applied (writing
   * only on a change). With the keyboard up the app is pinned to the VISIBLE viewport:
   * --vvh = its height, --vv-top = its offset (room.css moves body down by it),
   * so the composer's bottom is the keyboard's top even when iOS pans. And
   * iOS's own "scroll the focused field into view" shift — which scrolls even
   * overflow:hidden boxes — is put back to 0 without blurring the field. */
  if (vv) {
    /* Scroll offsets iOS may have put on boxes that are NOT scrollers (the
       page, and the clipped boxes around the header and the field). A real
       scroller (the line, a sheet body) keeps its position; the field's own
       scroll is its text. Never blurs, never moves focus. */
    const undoShift = () => {
      let undone = false;
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
        undone = true;
      }
      const boxes = new Set([document.scrollingElement, root, document.body, document.getElementById('main'), document.getElementById('roomLine')]);
      for (const start of [document.activeElement?.parentElement, document.querySelector('.ph-hdr')]) {
        for (let p = start; p && p !== root; p = p.parentElement) {
          const oy = getComputedStyle(p).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') {
            boxes.add(p);
          }
        }
      }
      for (const b of boxes) {
        if (b && (b.scrollTop !== 0 || b.scrollLeft !== 0)) {
          b.scrollTop = 0;
          b.scrollLeft = 0;
          undone = true;
        }
      }
      return undone;
    };
    keyboard = trackSoftKeyboard({
      /* the page fits its composer to what is left (room.js capComposer,
         [web/room-phone-7]) on this event */
      event: 'room-kb',
      report: reportSoon,
      afterSync: (up) => (up || isTextField(document.activeElement) ? undoShift() : false),
      pollDrift: (vvTop) => {
        const hdr = document.querySelector('.ph-hdr')?.getBoundingClientRect();
        return !!(hdr && hdr.height && hdr.top < (vvTop ?? 0) - 0.5) || window.scrollY !== 0;
      },
    });
  }

  /* THE SEAT FRAME CANNOT SEE THE KEYBOARD [room keybar]: the page shrinks the seat layer to the visible height, so inside
     the solo frame innerHeight == visualViewport.height and its own tracker never reads "up", and its key bar (shown only
     while the keyboard is up) stays hidden. Say so ({hwbKb:{up}}, the message web/shell.html sends its tab frames and
     web/soft-keyboard.mjs already follows) on every change and when a frame loads. */
  const tellSeatFrames = (only) => {
    const up = root.classList.contains('kb-up');
    for (const f of only ? [only] : document.querySelectorAll('#seatView iframe')) {
      try {
        f.contentWindow?.postMessage({ hwbKb: { up } }, location.origin);
      } catch {
        /* a frame that is not ours: nothing to tell */
      }
    }
  };
  window.addEventListener('room-kb', () => tellSeatFrames());
  document.getElementById('seatView')?.addEventListener('load', (ev) => (ev.target instanceof HTMLIFrameElement ? tellSeatFrames(ev.target) : undefined), true);

  setTimeout(() => report('load'), 1500);
  window.addEventListener('resize', () => reportSoon('resize'));
  window.addEventListener('orientationchange', () => reportSoon('orientation'));
  return { report };
}
