/* ===========================================================================
   hwb-drag.js — DRAG-TIME AFFORDANCES
   Pairs with hwb-drag.css. Additive; a host that never imports it is unaffected.

   The host owns the DRAG (pointer capture, hit-testing, the actual window
   move). This owns what the drag LOOKS LIKE, so two hosts cannot draw two
   different answers to the same gesture.

   Deliberately NOT here: pointer handling, drop commitment, window creation.
   Those are host concerns and every host does them differently. What must not
   differ is where the caret sits and what the carried thing looks like.
   =========================================================================== */

/* ---------------------------------------------------------------------------
   hwbDropIndex(root, clientX) -> insert index

   Which gap the pointer is nearest. Computed from tab MIDPOINTS, not edges:
   edges make the target flip only when you fully cross a tab, which feels
   sticky and lands one slot from where the user aimed. Midpoints mean the
   caret is always showing the nearer of the two gaps, which is the one a
   person means.
   --------------------------------------------------------------------------- */
export function hwbDropIndex(root, clientX) {
  const tabs = [...root.querySelectorAll('.hwb-scroll .hwb-tab')];
  if (!tabs.length) return 0;
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return tabs.length;
}

/* ---------------------------------------------------------------------------
   hwbDropPreview(root, index) — light the band and place the caret.
   Pass null (or omit) to clear. Idempotent; safe to call every pointermove.
   --------------------------------------------------------------------------- */
export function hwbDropPreview(root, index) {
  if (index == null || index < 0) return hwbClearDropPreview(root);
  root.classList.add('is-droptarget');

  const wrap = root.querySelector('.hwb-scrollwrap');
  if (!wrap) return root;                       // untabbed: the wash IS the message

  let caret = wrap.querySelector('.hwb-dropcaret');
  if (!caret) {
    caret = document.createElement('div');
    caret.className = 'hwb-dropcaret';
    wrap.appendChild(caret);
    /* The caret's position is a PIXEL derived from a layout, so it is stale the
       moment the layout changes — and both things that change it happen during
       a normal drag: the window can be resized, and the strip AUTOSCROLLS when
       you drag toward its edge. A caret left at a stale offset points at the
       wrong gap while looking perfectly confident, which is worse than not
       drawing one.

       So the INDEX is the stored truth and the pixel is re-derived from it.
       Third time this bundle has learned the same lesson (host-owned chevron
       state, host-owned enforcement, now this): anything a consumer would have
       to remember to refresh, refresh here instead. */
    const refresh = () => {
      const i = Number(root.dataset.dropIndex);
      if (root.classList.contains('is-droptarget') && Number.isFinite(i)) hwbDropPreview(root, i);
    };
    root.querySelector('.hwb-scroll')?.addEventListener('scroll', refresh, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      caret._ro = new ResizeObserver(refresh);
      caret._ro.observe(wrap);
    }
  }
  root.dataset.dropIndex = String(index);

  const tabs = [...root.querySelectorAll('.hwb-scroll .hwb-tab')];
  const wrapBox = wrap.getBoundingClientRect();
  let x;
  if (!tabs.length) {
    x = 0;
  } else if (index >= tabs.length) {
    const r = tabs[tabs.length - 1].getBoundingClientRect();
    x = r.right - wrapBox.left;
  } else {
    x = tabs[index].getBoundingClientRect().left - wrapBox.left;
  }
  // clamp INSIDE the wrap: an insert at either end of a scrolled strip would
  // otherwise draw the caret outside its own container and get clipped, which
  // reads as "no valid drop here" at exactly the moment there is one.
  x = Math.max(0, Math.min(x, wrapBox.width - 2));
  caret.style.setProperty('--caret-x', `${Math.round(x)}px`);
  return root;
}

export function hwbClearDropPreview(root) {
  root.classList.remove('is-droptarget');
  const caret = root.querySelector('.hwb-dropcaret');
  caret?._ro?.disconnect();
  caret?.remove();
  delete root.dataset.dropIndex;
  return root;
}

/* ---------------------------------------------------------------------------
   hwbTearGhost({ name, base, logo }) -> detached element

   What the user is carrying. The host appends it, positions it with transform
   at the cursor, and removes it on drop.

   It is a miniature WINDOW, not a floating tab chip, because a window is what
   dropping it in open space produces — the ghost should predict the outcome,
   not describe the gesture.

   Its colors derive from the TORN TAB's base, not the source window's: the
   thing being carried is the session, and it keeps its identity across the
   frame it lands in. That is the same reason a tab chip carries its own base
   rather than the container's.
   --------------------------------------------------------------------------- */
export function hwbTearGhost({ name = '', base = 'var(--dim2)', logo = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'hwb-ghost';
  el.style.setProperty('--base', base);
  el.setAttribute('aria-hidden', 'true');       // it mirrors a live window; never announce it twice
  const esc = s => String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  el.innerHTML =
    `<div class="gbar"><span class="glogo">${logo}</span>` +
    `<span class="gname">${esc(name)}</span></div>` +
    `<div class="gbody"><span class="gmark">${logo}</span></div>`;
  return el;
}

/* ---------------------------------------------------------------------------
   hwbMoveGhost(el, clientX, clientY) — follow the cursor.

   The grab point sits slightly INSIDE the ghost's top-left rather than centered
   on it: a ghost centered under the pointer hides the drop caret it is supposed
   to be aimed at, which is the one thing the user is reading.
   --------------------------------------------------------------------------- */
export function hwbMoveGhost(el, clientX, clientY) {
  if (!el) return el;
  el.style.transform = `translate(${Math.round(clientX - 22)}px,${Math.round(clientY - 13)}px)`;
  return el;
}
