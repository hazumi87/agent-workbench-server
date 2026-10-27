/* ASSET PICKER [asset picker, Owner 2026-10-05]: a modal (a bottom sheet on a
 * phone) that shows images newest first, 9 at a time in a 3x3 grid, more on
 * scroll, and answers ONE pick or a cancel. Reusable by any host surface;
 * the room page opens it for an app's {panel:'pick'} (web/room-cells.mjs).
 *
 *   openAssetPicker({roomId, sources:['room','library'], title, onDone})
 *
 * onDone(items) is called ONCE: an array of one item, or null for a cancel
 * (the x, Esc, the backdrop, Cancel). Items:
 *   {source:'room', name, type}        a file in the room's assets
 *   {source:'library', library_id}     an image in the asset library
 * Room tab: GET /api/rooms/:id/assets (newest first, images only), thumbs from
 * the raw route (no thumbnail size exists, so the raw image, object-fit cover,
 * lazy). Library tab: the engine's proxy, GET /api/library/images?offset=N and
 * /api/library/thumb/:id (the library holds ~20,900 images, so it always pages).
 * Focus is trapped while open; no text field is ever focused (phone rule). */

const PAGE = 9;
const LABELS = { room: 'Room', library: 'Library' };
const X_PATH = 'M6 6l12 12M18 6 6 18';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

async function getJson(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error((j && typeof j.error === 'string' && j.error) || `answered ${r.status}`);
  }
  return j;
}

/** One tab's pager: `more()` loads the next 9 and says whether any are left. */
function roomSource(roomId) {
  let all = null;
  let shown = 0;
  return {
    async more() {
      if (all === null) {
        const j = await getJson(`/api/rooms/${encodeURIComponent(roomId)}/assets`);
        /* newest first, by the time the room recorded (or the file's mtime); the sort is stable */
        all = (j.assets ?? []).filter((a) => a.kind === 'image').sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
      }
      const page = all.slice(shown, shown + PAGE).map((a) => ({
        src: a.raw,
        label: a.name,
        item: { source: 'room', name: a.name, type: a.type },
      }));
      shown += page.length;
      return { page, done: shown >= all.length, empty: all.length === 0 };
    },
  };
}

function librarySource() {
  let offset = 0;
  return {
    async more() {
      const j = await getJson(`/api/library/images?offset=${offset}`);
      const page = j.assets.map((a) => ({
        src: `/api/library/thumb/${encodeURIComponent(a.id)}`,
        label: a.label || a.id,
        item: { source: 'library', library_id: a.id },
      }));
      offset += page.length;
      const total = Number.isFinite(j.total) ? j.total : null;
      return { page, done: page.length === 0 || (total !== null && offset >= total), empty: offset === 0 && page.length === 0 };
    },
  };
}

export function openAssetPicker({ roomId, sources, title, onDone }) {
  const opener = document.activeElement;
  const scrim = el('div', 'ap-scrim');
  const card = el('div', 'ap-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', title || 'Choose an image');
  card.tabIndex = -1;
  const grab = el('div', 'ap-grab');
  const head = el('div', 'ap-h');
  const t = el('span', 'ap-t', title || 'Choose an image');
  const x = el('button', 'ap-x');
  x.type = 'button';
  x.title = 'Cancel (Esc)';
  x.setAttribute('aria-label', 'Cancel');
  x.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${X_PATH}"/></svg>`;
  head.append(t, x);
  const tabs = el('div', 'ap-tabs');
  tabs.setAttribute('role', 'tablist');
  const body = el('div', 'ap-b');
  card.append(grab, head);
  if (sources.length > 1) {
    card.append(tabs);
  }
  card.append(body);
  scrim.append(card);

  let finished = false;
  const observers = [];
  function finish(items) {
    if (finished) {
      return;
    }
    finished = true;
    for (const o of observers) {
      o.disconnect();
    }
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', fit);
    scrim.remove();
    window.dispatchEvent(new Event('room:overlay-closed'));
    /* focus back to where it was; never on a touch screen (it can raise a keyboard) */
    if (!matchMedia('(pointer: coarse)').matches && opener?.isConnected && typeof opener.focus === 'function') {
      opener.focus({ preventScroll: true });
    }
    try {
      onDone(items);
    } catch {
      /* the opener is gone */
    }
  }

  /* the body shows exactly 3 rows (the 3x3 grid); the rest is below the fold, so
     the sentinel only meets the scroll when the person gets there */
  function fit() {
    const first = body.querySelector('.ap-pane:not([hidden]) .ap-thumb');
    if (first && first.offsetHeight > 0) {
      const cs = getComputedStyle(body);
      body.style.maxHeight = `${Math.round(parseFloat(cs.paddingTop) + first.offsetHeight * 3 + 16 + 10)}px`;
    }
  }
  window.addEventListener('resize', fit);

  const panes = new Map(); // source -> {tab, pane}
  function select(src) {
    for (const [s, p] of panes) {
      const on = s === src;
      p.pane.hidden = !on;
      p.tab.setAttribute('aria-selected', on ? 'true' : 'false');
      p.tab.tabIndex = on ? 0 : -1;
      if (on) {
        p.load();
      }
    }
  }

  for (const src of sources) {
    const tab = el('button', 'ap-tab', LABELS[src]);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    const pane = el('div', 'ap-pane');
    pane.hidden = true;
    const grid = el('div', 'ap-grid');
    const note = el('div', 'ap-note');
    note.hidden = true;
    const sentinel = el('div', 'ap-sentinel');
    pane.append(grid, note, sentinel);
    body.append(pane);
    if (sources.length > 1) {
      tabs.append(tab);
    }
    const source = src === 'room' ? roomSource(roomId) : librarySource();
    let busy = false;
    let done = false;
    let started = false;
    async function more() {
      if (busy || done || finished) {
        return;
      }
      busy = true;
      note.hidden = false;
      note.textContent = 'Loading...';
      try {
        const r = await source.more();
        if (finished) {
          return;
        }
        for (const p of r.page) {
          const b = el('button', 'ap-thumb');
          b.type = 'button';
          b.title = p.label;
          b.setAttribute('aria-label', p.label);
          const img = el('img');
          img.loading = 'lazy';
          img.decoding = 'async';
          img.alt = '';
          img.src = p.src;
          b.append(img);
          b.addEventListener('click', () => finish([p.item]));
          grid.append(b);
        }
        done = r.done;
        fit();
        note.hidden = !r.empty;
        note.textContent = r.empty ? (src === 'room' ? 'No images in this room yet.' : 'The library has no images.') : '';
      } catch (e) {
        /* shown here, never swallowed; Retry asks again */
        note.hidden = false;
        note.textContent = '';
        note.append(`Could not load: ${String(e?.message ?? e).slice(0, 200)} `);
        const retry = el('button', 'ap-retry', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', () => void more());
        note.append(retry);
      } finally {
        busy = false;
      }
    }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting) && started && !pane.hidden) {
        void more();
      }
    }, { root: body });
    io.observe(sentinel);
    observers.push(io);
    panes.set(src, {
      tab,
      pane,
      load() {
        if (!started) {
          started = true;
          void more();
        }
      },
    });
    tab.addEventListener('click', () => select(src));
  }

  function onKey(e) {
    if (finished) {
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    } else if (e.key === 'Tab') {
      const stops = [...card.querySelectorAll('button')].filter((n) => !n.closest('[hidden]') && n.tabIndex >= 0);
      if (!stops.length) {
        e.preventDefault();
        return;
      }
      const i = stops.indexOf(document.activeElement);
      e.preventDefault();
      stops[(i + (e.shiftKey ? stops.length - 1 : 1)) % stops.length].focus();
    }
  }
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', function trap(e) {
    if (finished) {
      document.removeEventListener('focusin', trap);
    } else if (!card.contains(e.target)) {
      x.focus({ preventScroll: true });
    }
  });
  x.addEventListener('click', () => finish(null));
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) {
      finish(null);
    }
  });

  document.body.append(scrim);
  select(sources[0]);
  x.focus({ preventScroll: true }); // the cancel button, never a text field
  return { close: () => finish(null) };
}
