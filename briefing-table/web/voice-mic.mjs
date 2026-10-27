/* ============================================================================
 * THE TITLEBAR MIC (voice channel, ticket P2 — the design notes §1).
 *
 * the design system session bar (hwbRenderSessionBar, VENDORED — never edited) draws
 * exactly three icons. The mic is ours, inserted AFTER each render to the LEFT
 * of the messages icon, the same post-process pattern the shell uses for the
 * hub chip. It reuses the bundle's `.sb-ib` class so it inherits the bar's
 * sizing, hover and dim-when-empty treatment; only the "open" colour is ours.
 *
 * A click dispatches a bubbling `hwb:voice` on the bar — exactly the shape of
 * the bundle's own `hwb:messages` — so the standalone solo bar and the
 * shell-drawn bar route it the same way (the shell forwards it to the tab's
 * page as {hwbBarAction:'voice'}; the PAGE owns the pane and makes the call).
 *
 * Shown only when the engine reports the feature on: GET /api/voice/channels
 * answering 404 means HARBOR_WB_VOICE is off, and the mic is simply absent.
 * ========================================================================== */

export const MIC_EVENT = 'hwb:voice';

const MIC_PATHS =
  '<rect x="9" y="3" width="6" height="11" rx="3"/>' +
  '<path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/>';

/** The label a state reads as — the tooltip and the accessible name. */
export function micLabel(state) {
  const waiting = pendingOf(state);
  const tail = waiting ? ` — ${waiting} waiting on this pane` : '';
  if (!state || !state.open) {
    return `Voice channel off — click to open${tail}`;
  }
  return (state.focused ? 'Voice channel open — click to close' : 'Voice channel open (not focused) — click to close') + tail;
}

/** Held utterances + undelivered replies: what the count on the mic shows. */
export function pendingOf(state) {
  return state ? (Number(state.held) || 0) + (Number(state.undelivered) || 0) : 0;
}

/**
 * Create the mic ONCE for the page's life (the status-ring pattern): the bar's
 * innerHTML is rebuilt by every hwbRenderSessionBar, so the element is
 * RE-ATTACHED after each render by attachMic, never recreated — its listener
 * survives, and it cannot vanish on the next title or count change.
 * The click dispatches a bubbling `hwb:voice` from the button itself, so it
 * reaches whichever bar currently holds it.
 */
export function createMic() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.sb = 'voice';
  /* NO-DRAG, stated on the element: a control inside a caption drag region has
     its click eaten by the OS (the .hwb-newtab / .hwb-act lesson). */
  btn.style.setProperty('app-region', 'no-drag');
  btn.style.setProperty('-webkit-app-region', 'no-drag');
  btn.innerHTML = `<svg viewBox="0 0 24 24">${MIC_PATHS}</svg><span class="sb-cnt" hidden></span>`;
  btn.addEventListener('click', () => btn.dispatchEvent(new CustomEvent(MIC_EVENT, { bubbles: true })));
  return btn;
}

/**
 * Re-attach the mic to a freshly rendered bar and paint its state.
 * @param {HTMLElement} bar  the `.hwb-sbar`, AFTER hwbRenderSessionBar
 * @param {HTMLElement} btn  the one element from createMic()
 * @param {{open, focused, held, undelivered}|null} state  null = voice off → no mic
 */
export function attachMic(bar, btn, state) {
  if (!bar || !btn) {
    return;
  }
  if (!state) {
    btn.remove();
    return;
  }
  btn.className = 'sb-ib sb-mic' + (state.open ? ' is-on' : ' is-empty');
  btn.dataset.state = state.open ? (state.focused ? 'focused' : 'open') : 'off';
  btn.setAttribute('aria-pressed', state.open ? 'true' : 'false');
  btn.title = micLabel(state);
  btn.setAttribute('aria-label', micLabel(state));
  btn.style.color = state.open ? 'var(--coral, #ff7a6b)' : '';
  btn.style.opacity = state.open && !state.focused ? '.6' : '';
  const cnt = btn.querySelector('.sb-cnt');
  const n = pendingOf(state);
  cnt.hidden = n === 0;
  cnt.textContent = n ? String(n) : '';
  const anchor = bar.querySelector('[data-sb="messages"]');
  if (anchor) {
    bar.insertBefore(btn, anchor);
  } else {
    bar.appendChild(btn);
  }
}

/** The mic state carried by a pane.voice event (facts → what the bar needs). */
export function micFromPaneVoice(msg) {
  return {
    open: !!msg.open,
    focused: !!msg.focused,
    held: Array.isArray(msg.held) ? msg.held.length : 0,
    undelivered: Array.isArray(msg.undelivered) ? msg.undelivered.length : 0,
  };
}

const channelOf = (paneid) => `pane:${paneid}`;

/** This pane's channel state, or null when the engine has voice switched off
 *  (404) or cannot be asked. */
export async function fetchMicState(paneid) {
  try {
    const res = await fetch('/api/voice/channels', { cache: 'no-store' });
    if (!res.ok) {
      return null;
    }
    const body = await res.json();
    const cid = channelOf(paneid);
    const open = Array.isArray(body.channels) && body.channels.some((c) => c.channelId === cid);
    return { open, focused: open && body.focus === cid, held: 0, undelivered: 0 };
  } catch {
    return null;
  }
}

/** Open or close this pane's channel. Returns the new state, or null. */
export async function toggleMic(paneid, state) {
  const cid = channelOf(paneid);
  const route = state && state.open ? '/api/voice/channels/close' : '/api/voice/channels/open';
  try {
    const res = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: cid }),
    });
    if (!res.ok) {
      return fetchMicState(paneid);
    }
    const body = await res.json();
    const open = Array.isArray(body.channels) && body.channels.some((c) => c.channelId === cid);
    return { ...state, open, focused: open && body.focus === cid };
  } catch {
    return null;
  }
}
