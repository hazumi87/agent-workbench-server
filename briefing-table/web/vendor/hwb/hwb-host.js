/* ============================================================================
   hwb-host.js — the HOST BRIDGE for the design system v2 window chrome.

   ── LIBRARY VERSION ────────────────────────────────────────────────────────
   hwb-bridge v1.0 (2026-08-18). This file + hwb-host.css are a PINNED LIBRARY
   DROP for vendoring consumers (first: briefing-table, P3 shell migration).
   The pin is the ui-toolkit git commit that last touched this header;
   vendored copies must record version + commit and stay byte-identical —
   this file's absolute /assets/aurora/window-chrome/ import (grep hwb-chrome)
   is contract: serve the chrome bundle at that path on your origin. Bridge
   changes during P3 are announced on the briefing-table relay channel FIRST.

   ── PROVENANCE ─────────────────────────────────────────────────────────────
   The chrome is SYNCED from the design system published dist/window-chrome bundle
   (assets/aurora/window-chrome/) and must never be edited here. The pin —
   bundle VERSION + manifest sha — lives in assets/aurora/DESIGN-VERSION and
   is written only by tools/sync-design.ps1. Spec: cli-window-chrome-v2.md
   (being re-issued against the shipped CSS; the CSS is authoritative on
   numbers until then).

   Host-specific CSS lives in hwb-host.css. Host-specific JS lives HERE. If a
   change belongs to neither, it belongs upstream in the relay, not in this
   repo.

   ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
   The v2 component covers visuals, tabs, the priority-MAX aggregate and the
   layout invariants. It knows NOTHING about our WebView2 host. This module is
   the whole of that contact surface, and it keeps the SHIPPED message envelope
   byte-for-byte (src/MainWindow.xaml.cs · src/DockController.cs ·
   src/MaxButtonOverlay.cs) — the host was not changed for v2.

   page → host    window.chrome.webview.postMessage({cmd: …})
     {cmd:'hwb:rects', dpr, cells:{minimize:{x,y,w,h},maximize:{…},close:{…}}}
        Caption-cell rects in CSS px (the host multiplies by dpr) — this is
        what parks the HTMAXBUTTON overlay over the maximize cell.
        Re-sent on: load · resize · dpr change · hwb:windowState · hwb:dpi ·
        AFTER EVERY TAB RENDER (v2 tabs live in tier 1, so the number of tabs
        moves the caption cluster's neighbours and can move the bar height).
     {cmd:'hwb:minWidth', px:330}
     {cmd:'hwb:barHeight', px:<measured bar height>}   re-sent when it changes
                                                       (32 solo → 36 tabbed)
     {cmd:'hwb:flash'}                     one FlashWindowEx
     {cmd:'minimize'|'maximize'|'close'}   caption verbs
     {cmd:'getBounds'} · {cmd:'setBounds', x,y,w,h}
     {cmd:'tabstrip:rect', x,y,w,h,dpr}    the DOCK TARGET. v2 moved this
        INSIDE tier 1 — it is now the .hwb-tabs lane, not a row of its own.
        Only sent while the strip is actually laid out (.is-tabbed).
     {cmd:'tab:tearoff', url,title,w:1000,h:700,dpr}
        Page removes the tab locally FIRST, then this; {cmd:'close'} follows if
        it was the last tab.
     {cmd:'tabs:state', badge, tabs:[{url,title,state,sessionId,base,logoKey}]}
        NOTE the two v2 fields: `base` (the tab's identity hex or var()) and
        `logoKey` (a LOGO_PRESETS key, or null). The logo SVG STRING is never
        sent to the host — the key alone crosses the boundary.
     {cmd:'openExternal', url}
     {cmd:'hub:summon'}                    NEW. The `+` control must bring the
        ONE CLI Manager to the front (spec §5) — never create a session, never
        spawn a second Manager. Sent only when this window holds no hub tab of
        its own. The host finds the window whose tabs:state carries
        sessionId "cli-manager", un-minimises and activates it, and answers
        {event:'hub:absent'} when no Manager is open anywhere.

   host → page    e.data = {event: …}
     {event:'hwb:active', active}          → hwbSetFocused()
     {event:'hwb:windowState', state, inset} → hwbSetWindowState()
     {event:'hwb:capHover', cap} · {event:'hwb:capPress', cap, pressed}
        → .is-hover / .is-pressed on that caption cell. The host sends 'max';
        'max'/'maximize' are equivalent. Only maximize matters in practice —
        the overlay HWND eats that cell's mouse so CSS :hover cannot fire.
     {event:'hwb:dpi', dpr}                → re-send rects
     {event:'tab:adopt', url,title,state,sessionId,base,logoKey}
     {event:'tab:focus', match}            match = sessionId or url
     {event:'dock:dragging', active}       NEW. A window drag is in flight
        somewhere in the installation. A window holding ≤1 tab materialises its tab
        row so it can be a drop target, then re-reports tabstrip:rect; on
        `false` it reverts if it only materialised for the drag.
     {event:'hub:absent'}                  the host could not find a CLI Manager
        to summon. Logged; opening one is engine/adoption work.
   ============================================================================ */

'use strict';

import { hwbSetFocused, hwbSetWindowState, hwbCaptionRects } from '/assets/aurora/window-chrome/hwb-chrome.js';

/** the design system floor for a usable tier 1: 154px reserve + caption cluster + a
 *  readable title. Sent once so the host clamps MinWidth. */
export const HWB_MIN_WIDTH_PX = 330;

/** Tear-off threshold: a press that travels this far AND leaves the strip. */
const TEAROFF_SLOP_PX = 8;

/**
 * Wire a .hwb root to the WebView2 host.
 *
 * @param {HTMLElement} root  the .hwb element
 * @param {Object}  opts
 * @param {Function} opts.log            (line) => void — the page's log instrument
 * @param {boolean}  opts.logSends       also log outbound messages (default false)
 * @param {Function} opts.onAdopt        ({url,title,state,sessionId,base,logoKey}) => void
 * @param {Function} opts.onFocusTab     (match) => void
 * @param {Function} opts.onDockDragging (active) => void
 * @returns {Object} the bridge
 */
export function hwbHostInit(root, opts) {
  opts = opts || {};
  const host = (window.chrome && window.chrome.webview) ? window.chrome.webview : null;
  const logFn = (typeof opts.log === 'function') ? opts.log : function () {};

  function dpr() {
    return window.devicePixelRatio || 1;
  }

  function send(msg) {
    if (opts.logSends) {
      logFn('send: ' + JSON.stringify(msg));
    }
    if (host) {
      host.postMessage(msg);
    } else if (!opts.logSends) {
      logFn('no host (plain browser): ' + JSON.stringify(msg));
    }
  }

  /* ---- rect reporting ---------------------------------------------------
     hwbCaptionRects() owns the cumulative-boundary rounding (never
     (rounded total)/3 — that opens a 1px dead seam at 125%/175%). We ship its
     cssPx rects and let the host do the dpr multiply, which is the shipped
     envelope. */
  function rectOf(d) {
    return { x: d.x, y: d.y, w: d.width, h: d.height };
  }

  function reportRects() {
    let r;
    try {
      r = hwbCaptionRects(root, dpr());
    } catch (err) {
      logFn('hwb:rects skipped — ' + err.message);
      return;
    }
    send({
      cmd: 'hwb:rects',
      dpr: dpr(),
      cells: {
        minimize: rectOf(r.cssPx.minimize),
        maximize: rectOf(r.cssPx.maximize),
        close: rectOf(r.cssPx.close),
      },
    });
  }

  /* The bar is 32px solo and 36px tabbed (hwb-chrome.css --hwb-bar-h), so this
     changes whenever the window materialises or drops its tab row. Measured,
     not assumed. */
  let lastBarH = null;
  function reportBarHeight() {
    const bar = root.querySelector('.hwb-bar');
    if (!bar) {
      return;
    }
    const h = Math.round(bar.getBoundingClientRect().height);
    if (!h || h === lastBarH) {
      return;
    }
    lastBarH = h;
    send({ cmd: 'hwb:barHeight', px: h });
  }

  /* The dock target. .hwb-tabs is display:none unless the root is .is-tabbed,
     so a zero rect means "not a drop target right now" and we stay silent
     rather than declaring a degenerate zone. */
  function reportStripRect() {
    const el = root.querySelector('.hwb-tabs');
    if (!el) {
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      return;
    }
    send({ cmd: 'tabstrip:rect', x: r.x, y: r.y, w: r.width, h: r.height, dpr: dpr() });
  }

  /* One rAF-coalesced refresh for all three geometry reports — they share every
     trigger (load, resize, dpr, window state, tab render). */
  let queued = false;
  function refresh() {
    if (queued) {
      return;
    }
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      reportRects();
      reportBarHeight();
      reportStripRect();
    });
  }

  /* devicePixelRatio has no change event; a resolution media query re-armed on
     every fire is the standard trick. Mixed-DPI monitors make this mandatory
     here, not optional. */
  function watchDpr() {
    matchMedia('(resolution: ' + dpr() + 'dppx)').addEventListener('change', function () {
      logFn('dpr changed: ' + dpr());
      refresh();
      watchDpr();
    }, { once: true });
  }

  /* ---- caption cells ---------------------------------------------------- */
  const caps = root.querySelector('.hwb-caps');
  function cap(name) {
    return caps ? caps.querySelector('[data-cap="' + name + '"]') : null;
  }
  ['minimize', 'maximize', 'close'].forEach(function (name) {
    const btn = cap(name);
    if (btn) {
      /* minimize/close are ordinary DOM clicks. The maximize click only fires
         in a plain browser — under the host the HTMAXBUTTON overlay intercepts
         it and toggles maximize itself. */
      btn.addEventListener('click', function () {
        /* The caption CLOSE must not shortcut the tab close handshake: on a
           SOLO session window there is no visible tab-strip ×, so this X is the
           only close the user sees, and sending {cmd:'close'} would destroy the
           window (and kill the pty) without ever running hwbClose → the
           End/Park/Cancel dialog. A consumer with tabs supplies onCaptionClose
           to route through its per-tab handshake (which itself asks the host to
           close the window once the last tab resolves). Found live against a
           real pty, 2026-08-09. */
        if (name === 'close' && typeof opts.onCaptionClose === 'function') {
          opts.onCaptionClose();
          return;
        }
        send({ cmd: name });
      });
    }
  });

  function normCap(c) {
    if (c === 'max') { return 'maximize'; }
    if (c === 'min') { return 'minimize'; }
    return c || null;
  }

  function paintCap(which, cls, on) {
    if (!caps) {
      return;
    }
    const target = normCap(which);
    caps.querySelectorAll('.hwb-cap').forEach(function (el) {
      if (target === null) {
        el.classList.remove('is-hover', 'is-pressed');
      } else {
        el.classList.toggle(cls, on && el.dataset.cap === target);
      }
    });
  }

  /* ---- host → page ------------------------------------------------------ */
  function onHostMessage(m) {
    logFn('host: ' + JSON.stringify(m));      /* log EVERYTHING, known or not */
    if (!m || typeof m !== 'object' || typeof m.event !== 'string') {
      return;
    }
    switch (m.event) {
      case 'hwb:active':
        hwbSetFocused(root, !!m.active);
        document.body.dataset.windowActive = m.active ? 'true' : 'false';
        break;
      case 'hwb:windowState':
        /* inset is HOST-reported (0 on this host — not the mockup's 8px) */
        hwbSetWindowState(root, m.state, (m.inset | 0));
        refresh();
        break;
      case 'hwb:capHover':
        paintCap(m.cap, 'is-hover', true);
        break;
      case 'hwb:capPress':
        paintCap(m.cap, 'is-pressed', !!m.pressed);
        break;
      case 'hwb:dpi':
        refresh();
        break;
      case 'tab:adopt':
        if (typeof m.url === 'string' && m.url && typeof opts.onAdopt === 'function') {
          opts.onAdopt({
            url: m.url,
            title: (typeof m.title === 'string' && m.title) ? m.title : null,
            state: (typeof m.state === 'string' && m.state) ? m.state : null,
            sessionId: (typeof m.sessionId === 'string' && m.sessionId) ? m.sessionId : null,
            base: (typeof m.base === 'string' && m.base) ? m.base : null,
            logoKey: (typeof m.logoKey === 'string' && m.logoKey) ? m.logoKey : null,
          });
        }
        break;
      case 'tab:focus':
        if (typeof m.match === 'string' && m.match && typeof opts.onFocusTab === 'function') {
          opts.onFocusTab(m.match);
        }
        break;
      case 'dock:dragging':
        if (typeof opts.onDockDragging === 'function') {
          opts.onDockDragging(!!m.active);
        }
        break;
      case 'hub:absent':
        /* hub:summon found no CLI Manager anywhere in the installation. Per the owner's
           2026-08-09 ask (briefing-table relay): the window that asked OPENS
           one, as its own first tab. The consumer supplies onHubAbsent to do
           that (the shell adds manager.html as the pinned hub tab); a consumer
           without it just logs, which was the old behaviour. */
        logFn('hub:absent — no CLI Manager open anywhere');
        if (typeof opts.onHubAbsent === 'function') {
          opts.onHubAbsent();
        }
        break;
      default:
        break;   /* moved/resized/bounds/media/stateChanged — logged above */
    }
  }

  if (host) {
    host.addEventListener('message', function (e) { onHostMessage(e.data); });
  }
  window.addEventListener('resize', refresh);
  if (document.readyState === 'complete') {
    refresh();
  } else {
    window.addEventListener('load', refresh);
  }
  watchDpr();
  send({ cmd: 'hwb:minWidth', px: HWB_MIN_WIDTH_PX });

  /* ---- the tear-off gesture --------------------------------------------
     Host-only behaviour (a plain browser has no windows to tear into), so it
     lives with the bridge rather than in the page's tab model. Pointer capture
     goes on the STRIP, not on the chip: hwbRenderTabs() replaces the strip's
     innerHTML on every reorder, which would destroy a captured chip mid-drag.

     Chips are app-region:no-drag (hwb-host.css §3), so the press lands in the
     page and the OS does not start a caption drag underneath us. */
  function attachTabDrag(handlers) {
    handlers = handlers || {};
    const strip = root.querySelector('.hwb-tabs');
    if (!strip) {
      return;
    }
    let drag = null;

    strip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) {
        return;
      }
      const chip = e.target.closest('.hwb-tab[data-tab]');
      /* EVERY CONTROL INSIDE A CHIP MUST BE EXEMPT, not just the ones that
         existed when this was written. Capturing the pointer on the strip means
         the mouseup lands on the STRIP, so the browser never generates a click
         on the button that was pressed — the control is simply dead, with no
         error and nothing in any log. v21 added the per-tab ⟳ and it was not in
         this list, which is exactly how it failed: the owner, 2026-09-21, "refresh
         button by tabs is failing. no longer refreshes. i have to hit F5" — the
         ✕ beside it worked, because ✕ was exempt.
         Matching BUTTONS generally, rather than naming each class, so the next
         control added to a chip cannot inherit this bug. */
      if (!chip || e.target.closest('button') || e.target.closest('.hwb-newtab')) {
        return;
      }
      if (typeof handlers.onPress === 'function') {
        handlers.onPress(chip.dataset.tab);
      }
      drag = { id: chip.dataset.tab, sx: e.clientX, sy: e.clientY, moved: false, pointerId: e.pointerId };
      try {
        strip.setPointerCapture(e.pointerId);
      } catch (err) {
        /* capture unsupported → in-strip reorder still works */
      }
    });

    strip.addEventListener('pointermove', function (e) {
      if (!drag) {
        return;
      }
      if (!drag.moved) {
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if ((dx * dx + dy * dy) > (TEAROFF_SLOP_PX * TEAROFF_SLOP_PX)) {
          drag.moved = true;
        }
      }
      if (!drag.moved) {
        return;
      }
      const r = strip.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right
        && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) {
        const id = drag.id;
        endDrag();
        tearOff(id);
        return;
      }
      if (typeof handlers.onReorder === 'function') {
        handlers.onReorder(drag.id, e.clientX);
      }
    });

    strip.addEventListener('pointerup', endDrag);
    strip.addEventListener('pointercancel', endDrag);

    function endDrag() {
      if (!drag) {
        return;
      }
      try {
        strip.releasePointerCapture(drag.pointerId);
      } catch (err) {
        /* already released */
      }
      drag = null;
    }

    /* Contract order, enforced here so no caller can get it wrong: the page
       removes the tab LOCALLY FIRST and hands it back, then tab:tearoff, then
       {cmd:'close'} if that was the last tab. */
    function tearOff(id) {
      if (typeof handlers.onTearOff !== 'function') {
        return;
      }
      const t = handlers.onTearOff(id);
      if (!t || !t.url) {
        return;
      }
      send({ cmd: 'tab:tearoff', url: t.url, title: t.title || null, w: 1000, h: 700, dpr: dpr() });
      if (t.last) {
        send({ cmd: 'close' });
      }
    }
  }

  return {
    send: send,
    refresh: refresh,
    reportRects: reportRects,
    reportStripRect: reportStripRect,
    attachTabDrag: attachTabDrag,

    /* The tab mirror the host uses for dock-merge, the control API and (later)
       persistence. `logo` SVG strings never cross — logoKey only. */
    sendTabsState: function (badge, tabs) {
      send({
        cmd: 'tabs:state',
        badge: (typeof badge === 'number' && isFinite(badge)) ? badge : null,
        tabs: (tabs || []).map(function (t) {
          return {
            url: t.url,
            title: t.title,
            state: t.state,
            sessionId: t.sessionId || null,
            base: t.base || null,
            logoKey: t.logoKey || null,
          };
        }),
      });
    },

    flash: function () { send({ cmd: 'hwb:flash' }); },
    close: function () { send({ cmd: 'close' }); },
    getBounds: function () { send({ cmd: 'getBounds' }); },
    setBounds: function (x, y, w, h) { send({ cmd: 'setBounds', x: x, y: y, w: w, h: h }); },
    openExternal: function (url) { send({ cmd: 'openExternal', url: url }); },

    /* Spec §5: the `+` brings the ONE CLI Manager to the front. Callers must
       activate a local hub tab first and only fall through to here. */
    hubSummon: function () {
      logFn('hub:summon — no hub tab in this window; asking the host to front the CLI Manager');
      send({ cmd: 'hub:summon' });
    },

    /* ---- review loop (dev only) -------------------------------------------
       the design system cannot run anything on this rig, so `?dump=1` measures what a
       screenshot cannot prove — the DERIVED colours per tab — and sends them to
       the host, which writes them to debug.log for publishing back. This is the
       mechanical half of the review loop; screenshots are the visual half. */
    dumpDerived: function () {
      const q = sel => Array.from(document.querySelectorAll(sel));
      const read = (el, props) => {
        const cs = getComputedStyle(el);
        const out = {};
        props.forEach(p => { out[p] = cs.getPropertyValue(p).trim(); });
        return out;
      };
      const derived = ['--base', '--d-barwash', '--d-barwash-i', '--d-title', '--d-seam', '--d-termbg', '--d-ghost'];
      // fonts: computed family on the title + tab names, and whether each of
      // the design system three faces actually LOADED — every symptom of a missing
      // webfont is silent (names fall back with no error), so measure it
      const famOf = sel => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).fontFamily : null;
      };
      const payload = {
        cmd: 'debug:derived',
        dpr: window.devicePixelRatio,
        tabbed: root.classList.contains('is-tabbed'),
        fonts: {
          titletext: famOf('.hwb-titletext'),
          tname: famOf('.tname'),
          /* check() alone is misleading: a face lazy-loads only when some
             element uses it, so an unused-but-available face reads false.
             loadable = the round-trip actually completed (see dumpDerived). */
          loaded: {
            inter: document.fonts.check('12px "Inter"'),
            spaceGrotesk: document.fonts.check('12px "Space Grotesk"'),
            jetbrainsMono: document.fonts.check('12px "JetBrains Mono"'),
          },
        },
        root: read(root, derived),
        rootBg: getComputedStyle(root.querySelector('.hwb-bar')).backgroundColor,
        tabs: q('.hwb-tab').map(el => ({
          name: (el.querySelector('.tname') || {}).textContent || '(hub)',
          active: el.classList.contains('is-active'),
          hub: el.classList.contains('is-hub'),
          vars: read(el, derived),
          bg: getComputedStyle(el).backgroundColor,
        })),
      };
      const faces = ['12px "Inter"', '12px "Space Grotesk"', '12px "JetBrains Mono"'];
      Promise.all(faces.map(f => document.fonts.load(f).then(a => a.length > 0).catch(() => false)))
        .then(([i, sg, jm]) => {
          payload.fonts.loadable = { inter: i, spaceGrotesk: sg, jetbrainsMono: jm };
          send(payload);
          logFn('debug:derived sent (' + payload.tabs.length + ' tabs, dpr ' + payload.dpr + ')');
        });
      return payload;
    },
  };
}
