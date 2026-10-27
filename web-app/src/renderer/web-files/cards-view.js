// Adapted from the team scratch-cards handoff <commit>; browser files integration.
// The Scratchpad cards view (the design notes C2; the design's workbench-scratchpad-cards-v1, frames A, C,
// D, J, K and L). Placement-free: it draws into the host it is handed, from pages the caller loads (main's index
// adapter through the bridge later, a fixture now); where the page lives is the owner's Q1. One list grouped by age,
// Compact (the default) or Detailed, the choice remembered through the caller's prefs; switching changes only the
// layout and reads nothing. Copy reference copies the engine's string verbatim and is disabled when the item isn't
// in the engine. Opening a card clears its New cue. A page that comes back after a newer read or a destroy is
// dropped. Every string is text, never markup. test/scratch-cards-view.test.mjs.

import { ageText, authorText, cardLine, copyable, groupItems, isNew, readView, sizeText, typeLabel, whenOf, VIEWS } from './cards-model.js';

const LABELS = { compact: 'Compact', detailed: 'Detailed' };
const EMPTY = ['No notes or files yet.', 'Notes and files that you or your agents add appear here, newest first.'];
const ICONS = { note: 'sticky_note_2', asset: 'draft' };

/**
 * deps: host · load({cursor}) → {ok, items, cursor} | {ok:false} · prefs {get, set} · seen {version(id), mark(item)}
 *  me (the person's handle) · now() · copy(text) · snackbar(text) · open(item) (optional) · document (optional)
 *  current() (optional; scope revocation is permanent) · hideUnavailableCopy (raw files)
 *  actions(item, root, {current, actionsHost}) appends owner controls; actionsHost is the Detailed action cell.
 */
export function createScratchCards(deps) {
  const doc = deps.document || globalThis.document;
  const host = deps.host;
  let view = readView(deps.prefs?.get?.());
  let items = [];
  let cursor = null;
  let failed = false;
  let loaded = false;
  let busy = false;
  let token = 0;
  let destroyed = false,revoked=false,renderToken=0;
  const active=()=>{if(destroyed||revoked)return false;try{if(!deps.current||deps.current()===true)return true;}catch{}revoked=true;return false;};
  const scope=()=>{const read=token,render=renderToken;return()=>active()&&read===token&&render===renderToken;};
  const bindAction=(node,event,fn)=>{const current=scope();node.addEventListener(event,e=>{if(current())fn(e);});};
  function ownerActions(item,root,actionsHost=root){
    if(typeof deps.actions!=='function')return;
    const current=scope();
    // Capture also fences host-owned controls retained after their card/row was
    // replaced. Owners may use the third argument around their own awaits.
    for(const event of ['click','keydown','submit'])root.addEventListener(event,e=>{if(!current()){e.preventDefault();e.stopImmediatePropagation?.();e.stopPropagation?.();}},true);
    deps.actions(item,root,{current,actionsHost});
  }

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const icon = (name) => { const s = el('span', 'ms sc-icon', name); s.setAttribute('aria-hidden', 'true'); return s; };
  const fresh = (it) => isNew(it, deps.me, (id) => deps.seen?.version?.(id) ?? null);
  const accessible = (it) => [it.name || 'Untitled', typeLabel(it), sizeText(it.size), authorText(it.author, deps.me), ageText(whenOf(it), deps.now())].filter(Boolean).join(', ');

  function choose(v, focus) {
    if (!VIEWS.includes(v) || !active()) return;
    if (v !== view) {
      view = v;
      deps.prefs?.set?.(v);
      paint();
    }
    if (focus) segments()[VIEWS.indexOf(v)]?.focus();
  }
  let segs = [];
  const segments = () => segs;

  function toggle() {
    const g = el('div', 'sc-toggle');
    g.setAttribute('role', 'radiogroup');
    g.setAttribute('aria-label', 'View');
    segs = VIEWS.map((v) => {
      const b = el('button', 'sc-seg' + (v === view ? ' is-on' : ''));
      b.setAttribute('type', 'button');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(v === view));
      b.tabIndex = v === view ? 0 : -1;
      if (v === view) b.appendChild(icon('check'));
      b.appendChild(el('span', 'sc-seg-label', LABELS[v]));
      bindAction(b,'click', () => choose(v, false));
      bindAction(b,'keydown', (e) => {
        const i = VIEWS.indexOf(v);
        const to = { ArrowLeft: i - 1, ArrowUp: i - 1, ArrowRight: i + 1, ArrowDown: i + 1, Home: 0, End: VIEWS.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        choose(VIEWS[(to + VIEWS.length) % VIEWS.length], true);
      });
      g.appendChild(b);
      return b;
    });
    return g;
  }

  function copyButton(it, label) {
    const b = el('button', 'sc-copy');
    b.setAttribute('type', 'button');
    b.setAttribute('aria-label', 'Copy reference');
    const ok = copyable(it);
    b.disabled = !ok;
    b.title = ok ? 'Copy reference' : 'Not in the room yet';
    if (label) b.appendChild(el('span', 'sc-copy-label', label));
    else b.appendChild(icon('content_copy'));
    const current=scope();
    b.addEventListener('click', async () => {
      if (!current()||busy||!copyable(it)) return;
      const ref = it.ref;
      try{
        const result=await deps.copy(ref);
        if(current())deps.snackbar?.(result===false||result?.ok===false?"Couldn't copy reference.":'Reference copied · '+ref);
      }catch{if(current())deps.snackbar?.("Couldn't copy reference.");}
    });
    return b;
  }

  function openItem(it) {
    if (!active()||busy) return;
    if (fresh(it)) deps.seen?.mark?.(it);
    deps.open?.(it);
    paint();
  }

  function newPill() { return el('span', 'sc-new', 'New'); }

  function tile(it) {
    const t = el('div', 'sc-tile' + (fresh(it) ? ' is-new' : ''));
    t.setAttribute('role', 'listitem');
    t.setAttribute('data-kind', it.kind);
    const open = el('button', 'sc-open');
    open.setAttribute('type', 'button');
    const name = accessible(it);
    open.setAttribute('aria-label', name);
    open.title = name;
    open.appendChild(icon(ICONS[it.kind] || ICONS.asset));
    open.appendChild(el('span', 'sc-name', it.name || 'Untitled'));
    if (fresh(it)) open.appendChild(newPill());
    open.appendChild(el('span', 'sc-meta', [typeLabel(it), sizeText(it.size), ageText(whenOf(it), deps.now())].filter(Boolean).join(' · ')));
    bindAction(open,'click', () => openItem(it));
    t.append(open);
    if(!deps.hideUnavailableCopy||copyable(it))t.append(copyButton(it));
    ownerActions(it,t);
    return t;
  }

  function row(it) {
    const r = el('div', 'sc-tr' + (fresh(it) ? ' is-new' : ''));
    r.setAttribute('role', 'row');
    const nameCell = el('div', 'sc-td sc-td-name');
    nameCell.setAttribute('role', 'cell');
    const open = el('button', 'sc-open');
    open.setAttribute('type', 'button');
    open.appendChild(icon(ICONS[it.kind] || ICONS.asset));
    open.appendChild(el('span', 'sc-name', it.name || 'Untitled'));
    if (fresh(it)) open.appendChild(newPill());
    if (it.kind === 'note' && cardLine(it)) open.title = cardLine(it);
    bindAction(open,'click', () => openItem(it));
    nameCell.appendChild(open);
    const cell = (text) => { const c = el('div', 'sc-td', text); c.setAttribute('role', 'cell'); return c; };
    const act = el('div', 'sc-td sc-td-act');
    act.setAttribute('role', 'cell');
    if(!deps.hideUnavailableCopy||copyable(it))act.appendChild(copyButton(it, 'Copy ref'));
    r.append(nameCell, cell(typeLabel(it)), cell(sizeText(it.size)), cell(authorText(it.author, deps.me, { row: true })), cell(ageText(whenOf(it), deps.now(), { short: true })), act);
    ownerActions(it,r,act);
    return r;
  }

  function body() {
    if (failed) {
      const box = el('div', 'sc-error');
      box.setAttribute('role', 'alert');
      const retry = el('button', 'sc-retry', 'Try again');
      retry.setAttribute('type', 'button');
      bindAction(retry,'click', () => { void refresh(); });
      box.append(el('p', 'sc-error-text', "Couldn't load the Scratchpad."), retry);
      return [box];
    }
    if (!loaded) return [];
    if (!items.length) {
      const box = el('div', 'sc-empty');
      box.append(el('p', 'sc-empty-title', EMPTY[0]), el('p', 'sc-empty-text', EMPTY[1]));
      return [box];
    }
    const out = [];
    if (view === 'detailed') {
      const table = el('div', 'sc-table');
      table.setAttribute('role', 'table');
      table.setAttribute('aria-label', 'Notes and files');
      const head = el('div', 'sc-th');
      head.setAttribute('role', 'row');
      for (const h of ['Name', 'Type', 'Size', 'Author', 'Modified', '']) { const c = el('div', 'sc-thc', h); c.setAttribute('role', 'columnheader'); head.appendChild(c); }
      table.appendChild(head);
      for (const g of groupItems(items, deps.now())) {
        const sec = el('div', 'sc-group');
        sec.setAttribute('role', 'rowgroup');
        sec.appendChild(el('div', 'sc-gh', g.label));
        for (const it of g.items) sec.appendChild(row(it));
        table.appendChild(sec);
      }
      out.push(table);
    } else {
      for (const g of groupItems(items, deps.now())) {
        const sec = el('section', 'sc-group');
        sec.appendChild(el('h3', 'sc-gh', g.label));
        const list = el('div', 'sc-tiles');
        list.setAttribute('role', 'list');
        for (const it of g.items) list.appendChild(tile(it));
        sec.appendChild(list);
        out.push(sec);
      }
    }
    if (cursor !== null) {
      const more = el('button', 'sc-more', 'Show more');
      more.setAttribute('type', 'button');
      more.disabled = busy;
      bindAction(more,'click', () => { void loadMore(); });
      out.push(more);
    }
    return out;
  }

  function paint() {
    if (!active()) return;
    ++renderToken;
    const head = el('div', 'sc-head');
    head.appendChild(toggle());
    const main = el('div', 'sc-body');
    main.append(...body());
    const root = el('div', 'sc-cards sc-' + view);
    root.setAttribute('aria-busy',String(busy));
    root.append(head, main);
    host.replaceChildren(root);
  }

  async function read(from) {
    const mine = ++token;
    busy = true;
    paint();
    let r;
    try { r = await deps.load({ cursor: from }); } catch { r = { ok: false }; }
    if (!active() || mine !== token) return false; // a newer read or a destroy owns the view now
    busy = false;
    if (!r || r.ok !== true || !Array.isArray(r.items)) {
      failed = true;
    } else {
      failed = false;
      loaded = true;
      items = from === null ? r.items.slice() : items.concat(r.items);
      cursor = typeof r.cursor === 'string' && r.cursor ? r.cursor : null;
    }
    paint();
    return true;
  }

  async function refresh() {
    if (!active()) return;
    cursor = null;
    await read(null);
  }
  async function loadMore() {
    if (!active() || busy || cursor === null) return;
    await read(cursor);
  }

  paint();
  return Object.freeze({
    refresh,
    view: () => view,
    setView: (v) => choose(v, false),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      token++;
      host.replaceChildren();
    },
  });
}
