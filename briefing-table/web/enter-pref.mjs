/* USE ENTER TO SEND, live everywhere [enter pref] Owner 2026-10-05.
 *
 * One shared module so the room page, the agent chat (solo windows and shell
 * iframes) and Settings > You all agree WITHOUT a reload:
 *   - saveEnterSubmits(v): PATCH /api/rooms/me {enterSubmits}, then tell every
 *     other window (localStorage + BroadcastChannel) and every local subscriber;
 *   - onEnterSubmits(cb): cb(bool) when the value changes here, in another
 *     window (broadcast / storage event), or on another device (a refetch of
 *     GET /api/rooms/me on visible and focus, debounced);
 *   - attachSendMenu(button, opts): right-click, long-press or the ContextMenu
 *     key on Send opens a one-row menu "Use Enter to send" that saves globally.
 * Every browser API here is guarded: a missing BroadcastChannel/localStorage
 * degrades to the refetch, never to a throw. */

const KEY = 'hwb.enterSubmits';
const CHANNEL = 'hwb-prefs';
const LONG_MS = 500;
const MOVE_PX = 10;
const REFETCH_MS = 250;

const subs = new Set();
let last = null;
let chan = null;
let wired = false;
let timer = 0;

/** Tell this page's subscribers (deduped on the value). */
function emit(v) {
  if (typeof v !== 'boolean' || v === last) {
    return;
  }
  last = v;
  for (const cb of [...subs]) {
    try {
      cb(v);
    } catch (e) {
      console.warn('enter-pref: subscriber threw', e);
    }
  }
}

/** Tell the OTHER windows (this page already knows). */
function announce(v) {
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* storage blocked: the broadcast and the refetch still work */
  }
  try {
    chan?.postMessage({ enterSubmits: v });
  } catch {
    /* closed channel */
  }
}

async function refetch() {
  try {
    const res = await fetch('/api/rooms/me', { cache: 'no-store' });
    if (res.ok) {
      const m = await res.json();
      const v = m?.enterSubmits ?? m?.enter_submits;
      if (typeof v === 'boolean') {
        emit(v);
      }
    }
  } catch {
    /* offline: the value we have stands */
  }
}

function refetchSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => void refetch(), REFETCH_MS);
}

function wire() {
  if (wired) {
    return;
  }
  wired = true;
  try {
    chan = new BroadcastChannel(CHANNEL);
    chan.onmessage = (ev) => emit(ev?.data?.enterSubmits);
  } catch {
    chan = null;
  }
  addEventListener('storage', (ev) => {
    if (ev.key === KEY) {
      emit(ev.newValue === 'true' ? true : ev.newValue === 'false' ? false : null);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refetchSoon();
    }
  });
  addEventListener('focus', refetchSoon);
}

/** Subscribe; returns the unsubscribe. */
export function onEnterSubmits(cb) {
  wire();
  subs.add(cb);
  return () => subs.delete(cb);
}

/** The last value this page learned (null = not yet known). */
export const currentEnterSubmits = () => last;

/** Save globally and propagate. `patch(obj)` lets a caller that already owns a
 *  PATCH (Settings' save, which also updates its `me`) be the transport. */
export async function saveEnterSubmits(value, patch) {
  const v = !!value;
  if (patch) {
    await patch({ enterSubmits: v });
  } else {
    const res = await fetch('/api/rooms/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enterSubmits: v }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
  }
  wire();
  announce(v);
  emit(v);
  return v;
}

/** Right-click / long-press / ContextMenu key on `button` opens the menu.
 *  opts.get(): the current bool; opts.note(text, kind): confirmation or error. */
export function attachSendMenu(button, opts) {
  let menu = null;
  let press = null;

  const close = () => {
    if (!menu) {
      return;
    }
    menu.remove();
    menu = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onOutside = (ev) => {
    if (menu && !menu.contains(ev.target)) {
      close();
    }
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      button.focus?.();
    }
  };

  const open = () => {
    close();
    const cur = opts.get() !== false;
    const m = document.createElement('div');
    m.className = 'rsm-menu enter-menu';
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Send options');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rsm-mi';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', String(cur));
    const box = document.createElement('span');
    box.className = 'enter-box';
    box.textContent = cur ? String.fromCharCode(10003) : '';
    row.append(box, 'Use Enter to send');
    row.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const next = !(opts.get() !== false);
      close();
      try {
        await saveEnterSubmits(next);
        opts.note(next ? 'Enter sends' : 'Enter adds a new line (Send to send)', 'info');
      } catch (e) {
        opts.note(`Not saved: ${e?.message ?? e}`, 'error');
      }
    });
    m.append(row);
    document.body.append(m);
    const r = button.getBoundingClientRect();
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    m.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    m.style.top = `${Math.max(8, r.top - h - 6)}px`;
    menu = m;
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    row.focus();
  };

  /* Listen on the parent and hit-test the rect: a DISABLED button (agent chat's
     empty Send) swallows its own mouse events in some engines. */
  const host = button.parentElement ?? document;
  const over = (ev) => {
    const r = button.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
  };
  host.addEventListener('contextmenu', (ev) => {
    if (over(ev)) {
      ev.preventDefault();
      open();
    }
  });
  button.addEventListener('keydown', (ev) => {
    if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault();
      open();
    }
  });
  host.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' || !over(ev)) {
      return;
    }
    press = { x: ev.clientX, y: ev.clientY, t: setTimeout(() => { press = null; open(); }, LONG_MS) };
  });
  const cancel = () => {
    if (press) {
      clearTimeout(press.t);
      press = null;
    }
  };
  host.addEventListener('pointermove', (ev) => {
    if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > MOVE_PX) {
      cancel();
    }
  });
  host.addEventListener('pointerup', cancel);
  host.addEventListener('pointercancel', cancel);
  return { close, isOpen: () => !!menu };
}

/**
 * THE KEY RULE, one copy for the room and the agent chat (Owner 2026-10-05: "ctrl-enter and
 * shift-enter should do a newline. And Enter would depend on the global setting").
 * Returns 'send' | 'newline' (we insert it: Ctrl/Cmd+Enter, which a textarea does not do) |
 * 'native' (let the textarea add its own new line) | null (not Enter, or an IME composition).
 * A phone's Enter is always a new line (2026-09-27): only the Send button sends there.
 */
export function enterAction(ev, enterSubmits, phone = false) {
  if (ev.key !== 'Enter' || ev.isComposing) {
    return null;
  }
  if (ev.ctrlKey || ev.metaKey) {
    return 'newline';
  }
  if (ev.shiftKey || ev.altKey || phone || enterSubmits === false) {
    return 'native';
  }
  return 'send';
}
