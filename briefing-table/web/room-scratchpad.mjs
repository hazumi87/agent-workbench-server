/* THE SCRATCHPAD'S LEFT-BAR CELL [scratchpad] (the design system BUILD-HANDOFF 1.C, V2.1; Owner 2026-10-07: "the bar is Seats, Tasks, Scratchpad").
 *
 * ONE cell where the Assets cell was. It holds NO thumbnails and no frame, only two signal lines:
 *   "Assets  ● 3 new of 43 ›"   "Notes  ● 1 new of 6 ›"        (40px rows; the count in mono; "N new" in teal with a 7px dot;
 *                                                                no dot and no "N new" colour when N is 0)
 * and the cell header's count is the two "new" numbers added ("4 new"). A line opens that list in the PREVIEW column (owner
 * 'scratchpad', key = the list); the open line is tinted; the same line again closes it.
 *
 * The room's Assets PANEL (an engine panel: an app in an iframe) stays registered and loaded, because uploads and the notes seam
 * ride on it; only its rail cell is hidden here (hideAssetsPanel). The cell shows from the first count: a room with no assets and
 * no notes still has a Scratchpad (that is where + Add / + New note live).
 *
 * COUNTS. M (the total) and N (new) come from the engine. Until the engine's seen-state lands N is 0 and the lines say "0 new of M"
 * in grey (no dot); M for assets is the listing, for notes the engine's visible list (it carries no total yet: `summary=1` is coming).
 * setCounts() is the one place a better source plugs in. */

const POLL_MS = 15000;
const NOTE_KINDS = ['assets', 'notes'];

/** An engine panel that is the room's Assets app (its cell is replaced by the Scratchpad). */
export function isAssetsPanel(p) {
  /* by NAME, never by icon: other uploads apps ("Files") wear the assets icon and stay in the rail */
  return !!p && (p.app_slug === 'room-assets' || (typeof p.title === 'string' && /^assets$/i.test(p.title.trim())));
}

export function lineText(n, m) {
  return m === 0 ? 'none yet' : `${n} new of ${m}`; // an empty one says so, in the dim ink, not "0 new of 0" (the design system)
}

/** The engine's counts ({assets: {new, total} | null, notes: {new, total}}; assets is null when agent-share cannot be read) in this module's
 *  shape. null stays null: the line says "Assets" with NO number, never "0 new" (a count we could not take is not zero). */
export function fromEngineCounts(c) {
  const one = (x) => (x && Number.isFinite(x.total) ? { n: Number.isFinite(x.new) ? x.new : 0, m: x.total } : null);
  const out = {};
  if (c && typeof c === 'object') {
    if ('assets' in c) {
      out.assets = one(c.assets);
    }
    if ('notes' in c) {
      out.notes = one(c.notes);
    }
  }
  return out;
}

/**
 * @param {{ roomId: string, cell: HTMLElement, list: HTMLElement, preview: object, api: (path: string) => Promise<{ok: boolean, body: any}>,
 *           cellTone?: (p: object) => string, openList?: (kind: string) => void, visible?: () => boolean,
 *           view?: { isOpen: () => boolean, refresh: () => Promise<void> }, onChange?: () => void }} o
 */
export function mountScratchpad(o) {
  const cell = o.cell;
  const head = cell.querySelector('#padHead');
  const count = cell.querySelector('#padCount');
  const lines = { assets: cell.querySelector('#padAssets'), notes: cell.querySelector('#padNotes') };
  const nums = { assets: cell.querySelector('#padAssetsN'), notes: cell.querySelector('#padNotesN') };
  const counts = { assets: { n: 0, m: null }, notes: { n: 0, m: null } };
  const FOLD = `wb.room.pad.${o.roomId}`;
  let timer = 0;

  const folded = () => {
    try { return localStorage.getItem(FOLD) === '1'; } catch { return false; }
  };
  const setFolded = (v) => {
    cell.classList.toggle('collapsed', v);
    head.setAttribute('aria-expanded', String(!v));
    try { localStorage.setItem(FOLD, v ? '1' : '0'); } catch { /* no storage: this page only */ }
  };
  setFolded(folded());
  head.addEventListener('click', () => setFolded(!cell.classList.contains('collapsed')));
  if (o.cellTone) {
    cell.dataset.tone = o.cellTone({ title: 'Assets', icon: 'assets', id: 'assets' });
  }

  function paint() {
    let totalNew = 0;
    for (const k of NOTE_KINDS) {
      const c = counts[k];
      const ln = lines[k];
      const has = c.m !== null;
      totalNew += c.n;
      ln.dataset.new = c.n > 0 ? '1' : '0';
      nums[k].textContent = has ? lineText(c.n, c.m) : '';
      ln.setAttribute('aria-label', has ? `${k === 'assets' ? 'Assets' : 'Notes'}, ${c.m === 0 ? 'none yet' : `${c.n} new of ${c.m}`}` : (k === 'assets' ? 'Assets' : 'Notes'));
    }
    count.textContent = totalNew > 0 ? `${totalNew} new` : '';
    count.classList.toggle('is-new', totalNew > 0);
    cell.hidden = false;
    previewChanged();
    o.onChange?.();
  }

  /** The two "new" numbers added: the cell header, and the phone's agents-button dot. */
  const newTotal = () => counts.assets.n + counts.notes.n;

  /** The one place a better count source plugs in (the engine's seen-state): {assets: {n, m}, notes: {n, m}}, either key optional. */
  function setCounts(next) {
    for (const k of NOTE_KINDS) {
      if (!next || !(k in next)) {
        continue;
      }
      const v = next[k];
      if (v === null) {
        counts[k] = { n: 0, m: null }; // could not be taken: no number, no "0 new"
      } else if (v && Number.isFinite(v.m)) {
        counts[k] = { n: Number.isFinite(v.n) ? Math.max(0, v.n) : 0, m: Math.max(0, v.m) };
      }
    }
    paint();
  }

  let engineCounts = true; // GET .../scratchpad/counts exists; once it answers 404 this engine has no seen-state: fall back to the listings
  async function refresh() {
    if (engineCounts) {
      try {
        const r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/scratchpad/counts`);
        if (r?.ok && r.body && 'notes' in r.body) {
          setCounts(fromEngineCounts(r.body));
          return;
        }
        if (r && (r.status === 404 || r.status === 405)) {
          engineCounts = false;
        }
      } catch { /* the listings below answer */ }
    }
    const out = {};
    try {
      const a = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/assets`);
      if (a?.ok && Array.isArray(a.body?.assets)) {
        out.assets = { n: counts.assets.n, m: a.body.assets.length };
      }
    } catch { /* keep the last count: a blip must not blank the line */ }
    try {
      const n = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/notes`);
      if (n?.ok && Array.isArray(n.body?.notes)) {
        out.notes = { n: counts.notes.n, m: Number.isFinite(n.body.total) ? n.body.total : n.body.notes.length };
      }
    } catch { /* same */ }
    setCounts(out);
  }

  /** The open line is tinted (no accent bar): follows what the preview column holds. */
  function previewChanged() {
    const cur = o.preview?.current?.();
    for (const k of NOTE_KINDS) {
      lines[k].classList.toggle('open', !!cur && cur.owner === 'scratchpad' && cur.key === k);
    }
  }

  for (const k of NOTE_KINDS) {
    lines[k].addEventListener('click', () => {
      const cur = o.preview?.current?.();
      if (cur && cur.owner === 'scratchpad' && cur.key === k) {
        o.preview.close();
        return;
      }
      o.openList?.(k);
    });
  }

  /** The room's Assets panel cell is not drawn: the Scratchpad is where its files live now. The panel itself stays loaded. */
  function hideAssetsPanel(panels) {
    for (const p of panels || []) {
      const el = o.list.querySelector(`[data-cell="${CSS.escape(p.id)}"]`);
      if (el) {
        el.classList.toggle('pad-replaced', isAssetsPanel(p));
      }
    }
  }

  function retone() {
    if (o.cellTone) {
      cell.dataset.tone = o.cellTone({ title: 'Assets', icon: 'assets', id: 'assets' });
    }
  }

  void refresh();
  timer = setInterval(() => {
    if (!document.hidden && (o.visible ? o.visible() : true)) {
      void refresh();
      if (o.view?.isOpen()) {
        void o.view.refresh(); // an open list stays current
      }
    }
  }, POLL_MS);

  return { refresh, setCounts, previewChanged, hideAssetsPanel, retone, newTotal, counts: () => counts, el: cell, destroy: () => clearInterval(timer) };
}
