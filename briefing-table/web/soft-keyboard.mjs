/* THE SOFT KEYBOARD, TRACKED THE WAY iOS FORCES US TO [web/solo-keybar-auto].
 *
 * Factored out of web/room-frame.mjs (where it was built and proven against
 * Owner's iPhone, 2026-09-29: the room's input stuck BELOW the keys) so the solo
 * page's key bar can follow the same keyboard, from the same code, instead of a
 * second naive tracker.
 *
 * On iOS WebKit visualViewport's resize fires mid-animation or NOT AT ALL
 * (re-focusing a focused field, the predictive bar coming and going, focus
 * moving between inputs), the layout viewport never resizes, and a page can
 * LOAD with the keyboard already up (iOS restores focus + keys across a
 * refresh). So NO ONE EVENT IS TRUSTED: every trigger re-syncs, then again
 * every frame for the animation (~800 ms) and once more at 1 s; and while a
 * text field has focus, a 1 s poll compares vv against what was applied
 * (writing only on a change). Triggers: vv resize/scroll, focusin/focusout,
 * pageshow, visibilitychange, and a burst at install / +2 s / window load.
 *
 * What it writes (and only while the keyboard is up — 100svh is right
 * otherwise, the design notes 2026-09-01):
 *   --vvh     the visible viewport's height
 *   --vv-top  its offset (iOS pans the visual viewport inside the layout one)
 *   html.kb-up
 * and a window CustomEvent (`event`, default 'soft-kb', detail {up, vvh}) when
 * the height or the up/down state changes, so a page reacts without importing
 * anything from here but the installer.
 *
 * A pinch-zoom shrinks vv.height too; `vv.scale <= 1.01` keeps a zoom from
 * reading as a keyboard.
 */

export const KEYBOARD_PX = 80; // well clear of a URL-bar collapse, well under any soft keyboard
/* the steady check while a text field has focus. Owner's ruling (2026-09-29):
   the page may catch up within about a second of the keyboard settling; the
   event kicks and their frame bursts cover the fast path. */
export const POLL_MS = 1000;

/** A finger is the way in: a coarse primary pointer, OR an iPad in its desktop-class mode. That mode (the default
 *  on every iPad since iPadOS 13: a "Macintosh" user agent) can report a fine, hovering pointer even though the
 *  screen is a touchscreen and the keyboard is soft, so `(pointer: coarse)` alone misses it [ipad keypad]. The
 *  Mac signature + more than one touch point is the standard tell; a real Mac reports zero touch points. */
export function touchInput() {
  if (window.matchMedia?.('(pointer: coarse)')?.matches === true) {
    return true;
  }
  const mac = /Mac/.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent || '');
  return mac && (navigator.maxTouchPoints ?? 0) > 1;
}

/** Touch hardware, or a coarse pointer: the only place a soft keyboard exists. */
export function touchDevice() {
  return window.matchMedia?.('(pointer: coarse)')?.matches === true || (navigator.maxTouchPoints ?? 0) > 0;
}

/** A field the soft keyboard types into (xterm's hidden .xterm-helper-textarea is one). */
export function isTextField(el) {
  if (!(el instanceof Element)) {
    return false;
  }
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) {
    return true;
  }
  return el.tagName === 'INPUT' && !/^(button|checkbox|radio|file|submit|reset|range|color|image|hidden)$/.test(el.type);
}

/** What has focus, as words for a diag (never its content). */
export function focusedWord() {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) {
    return null;
  }
  return `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}`;
}

/**
 * @param {{
 *   when?: boolean,                 install the listeners (default: touchDevice())
 *   event?: string,                 the window event raised on a change (default 'soft-kb')
 *   report?: (why: string, state: object) => void, diag hook: keyboard-up/-down, shift-undone, poll-start/-stop
 *   afterSync?: (up: boolean) => boolean,  page-specific fix-ups after each sync; true = it undid an iOS shift
 *   pollDrift?: (vvTop: number|null) => boolean,  a page-specific reason for the poll to re-sync
 * }} [o]
 * @returns {{ active: boolean, state: () => object }}
 */
export function trackSoftKeyboard(o = {}) {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const report = (why) => {
    try {
      o.report?.(why, state()); // the state AT CALL TIME (hoisted below)
    } catch { /* a diagnostic never breaks the tracker */ }
  };
  const kb = { up: null, vvh: null, top: null, reason: null, at: null, poll: null, shifts: 0 };
  const state = () => ({
    focused: focusedWord(),
    kbUp: kb.up,
    vvh: kb.vvh,
    vvTop: kb.top,
    vv: vv ? { h: Math.round(vv.height), offY: Math.round(vv.offsetTop), scale: vv.scale } : null,
    lastSync: kb.reason,
    lastSyncAgoMs: kb.at === null ? null : Date.now() - kb.at,
    pollActive: kb.poll !== null,
    shiftsUndone: kb.shifts,
  });
  const active = !!vv && (o.when ?? touchDevice());
  if (!active) {
    return { active, state };
  }

  const setVar = (name, v) => {
    if (v === null) {
      root.style.removeProperty(name);
    } else {
      root.style.setProperty(name, `${v}px`);
    }
  };
  /* IN THE SHELL'S TAB STRIP ON A TOUCH TABLET [ipad tabs]: the shell (web/shell.html) tracks the keyboard and shrinks
     itself, so this page's frame is ALREADY the visible height and its own visualViewport cannot see a keyboard. The shell
     says so ({hwbKb:{up}}) and this page follows: up, with its own height as the glass and no pan. Unset (no such parent
     message, i.e. every other case) = the measurement below, unchanged. */
  let fromParent = null;
  if (window.parent !== window) {
    window.addEventListener('message', (ev) => {
      if (ev.source === window.parent && ev.origin === location.origin && ev.data && typeof ev.data.hwbKb === 'object' && ev.data.hwbKb) {
        fromParent = { up: ev.data.hwbKb.up === true };
        sync('parent');
      }
    });
  }
  const isUp = () => (fromParent ? fromParent.up : vv.scale <= 1.01 && window.innerHeight - vv.height > KEYBOARD_PX);
  const sync = (reason) => {
    const up = isUp();
    const nextH = up ? Math.round(fromParent ? window.innerHeight : vv.height) : null;
    const nextTop = up ? (fromParent ? 0 : Math.max(0, Math.round(vv.offsetTop))) : null;
    const moved = nextH !== kb.vvh || up !== root.classList.contains('kb-up');
    if (nextH !== kb.vvh) {
      setVar('--vvh', nextH);
      kb.vvh = nextH;
    }
    if (nextTop !== kb.top) {
      setVar('--vv-top', nextTop);
      kb.top = nextTop;
    }
    root.classList.toggle('kb-up', up);
    if (moved) {
      try {
        window.dispatchEvent(new CustomEvent(o.event || 'soft-kb', { detail: { up, vvh: nextH } }));
      } catch { /* never */ }
    }
    let shifted = false;
    try {
      shifted = o.afterSync?.(up) === true;
    } catch { /* a page fix-up never breaks the tracker */ }
    if (shifted) {
      kb.shifts += 1;
    }
    kb.reason = reason;
    kb.at = Date.now();
    if (up !== kb.up) {
      kb.up = up;
      report(up ? 'keyboard-up' : 'keyboard-down');
    } else if (shifted) {
      report('shift-undone');
    }
  };
  /* one trigger = now, every frame through the keyboard's animation, and
     once more when it has surely settled */
  let frameUntil = 0;
  let settle = null;
  const kick = (reason, frames = 800) => {
    sync(reason);
    const running = performance.now() < frameUntil;
    frameUntil = Math.max(frameUntil, performance.now() + frames);
    if (!running) {
      const step = () => {
        sync(`${reason}+frame`);
        if (performance.now() < frameUntil) {
          requestAnimationFrame(step);
        }
      };
      requestAnimationFrame(step);
    }
    clearTimeout(settle);
    settle = setTimeout(() => sync(`${reason}+1s`), 1000);
  };
  const startPoll = () => {
    if (kb.poll === null) {
      kb.poll = setInterval(() => {
        const h = Math.round(vv.height);
        const top = Math.max(0, Math.round(vv.offsetTop));
        const up = isUp();
        const drift = up ? h !== kb.vvh || top !== kb.top : kb.vvh !== null;
        let extra = false;
        try {
          extra = o.pollDrift?.(kb.top) === true;
        } catch { /* never */ }
        if (drift || up !== kb.up || extra) {
          sync('poll');
        }
      }, POLL_MS);
      report('poll-start');
    }
  };
  const stopPoll = () => {
    if (kb.poll !== null) {
      clearInterval(kb.poll);
      kb.poll = null;
      report('poll-stop');
    }
  };
  vv.addEventListener('resize', () => kick('vv-resize'));
  vv.addEventListener('scroll', () => kick('vv-scroll'));
  document.addEventListener('focusin', (e) => {
    if (isTextField(e.target)) {
      startPoll();
    }
    kick('focusin');
  }, true);
  document.addEventListener('focusout', () => {
    kick('focusout');
    /* focus may be moving to ANOTHER field: decide once it has landed */
    setTimeout(() => {
      if (!isTextField(document.activeElement)) {
        stopPoll();
      }
    }, 0);
  }, true);
  window.addEventListener('pageshow', (e) => {
    if (isTextField(document.activeElement)) {
      startPoll();
    }
    kick(e.persisted ? 'pageshow-bfcache' : 'pageshow');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      kick('visible');
    }
  });
  /* THE PAGE CAN LOAD WITH THE KEYBOARD ALREADY UP (Owner's phone, old room
     build: why=load, vv.h 277, vvh null — iOS restored focus and the keys
     across a refresh, and the one sync ran before the viewport settled). So
     the load gets its own burst: frames for ~1 s, a check at 1 s (the kick's)
     and at 2 s, again on the window's load event; and a field that already
     has focus starts the poll at once. */
  const atLoad = (reason) => {
    if (isTextField(document.activeElement)) {
      startPoll();
    }
    kick(reason, 1000);
  };
  atLoad('install');
  setTimeout(() => atLoad('install+2s'), 2000);
  if (document.readyState === 'complete') {
    atLoad('load');
  } else {
    window.addEventListener('load', () => atLoad('load'), { once: true });
  }
  return { active, state };
}
