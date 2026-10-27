// Terminals on a phone (the design s13, option A, the owner ): under 600 px the rail's list and its "+" are not shown, so the Terminals tab is a page with the same
// three things the rail has, in the seat list's pattern: a filled "New shell"; "In this window · n" (a row opens the terminal as a full-screen layer with ONE arrow,
// "Back to Terminals"; ⋮ "More for {name}" opens a sheet with "Stop"); "Recipes · n" (a 48 px Start each; the engine's own refusal sentence verbatim under the row and
// in the snackbar); "Custom command…" last. The rail keeps feeding this page the same lists; nothing here changes 600 px and wider (CSS shows it under 600 only).
import { icon } from '../m3-chrome.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export const PHONE_WORDS = Object.freeze({
  title: 'Terminals',
  newShell: 'New shell',
  here: (n) => 'In this window · ' + n,
  recipes: (n) => 'Recipes · ' + n,
  where: 'This server',
  running: 'running',
  start: 'Start',
  custom: 'Custom command…',
  none: 'No terminals yet. Start one with New shell.',
  noneHosted: 'No terminals yet. Start one from Recipes.', // an engine that opens no bare shell has no New shell
  noRecipes: 'No recipes on this server yet. Ask whoever runs this server to add one.',
  back: 'Back to Terminals',
  stop: 'Stop',
});

/**
 * deps: host (#stage), me() -> this window's id, activeSid(), act(sid), end(sid), newCli() -> promise (null on refusal), startRecipe(id) -> promise,
 *       goTo(sid), customCommand(), mark(recipeRow) -> element, fire(count) (the bottom bar's badge), snackbar(text),
 *       bareShell() -> false when the engine opens no bare shell (hosted): then there is no "New shell" and the words change
 */
export function createTerminalsPhone(deps) {
  const html = document.documentElement;
  let list = [], recipes = null, mode = 'list', sheet = null, errors = new Map(), starting = null, wantMore = null, shellBusy = false, lastOpenSid = null, focusAfter = null; // wantMore: the count to beat before the new terminal opens as the layer
  html.dataset.tphone = mode;

  const root = el('section', 'tp');
  root.id = 'termPhone';
  root.setAttribute('aria-label', PHONE_WORDS.title);
  const back = el('button', 'tp-back');
  back.id = 'termBack';
  back.type = 'button';
  back.innerHTML = icon('arrow_back');
  back.appendChild(el('span', 'tp-backt', PHONE_WORDS.back));
  back.addEventListener('click', () => { setMode('list'); focusBest(lastOpenSid, 0); });
  deps.host.append(root, back);

  const rows = () => list.filter((s) => s.wid === deps.me());
  const canShell = () => !deps.bareShell || deps.bareShell() !== false;
  /** Focus lands on the row you came from, the row at its place when it is gone, else the first control (never the page start). */
  function focusBest(sid, idx) {
    const rs = [...root.querySelectorAll('.tp-row[data-sid] .tp-open')];
    const target = (sid != null && root.querySelector('.tp-row[data-sid="' + sid + '"] .tp-open')) || rs[Math.min(idx, rs.length - 1)] || root.querySelector('.tp-new') || root.querySelector('.tp-start') || root.querySelector('.tp-custom') || root.querySelector('.tp-h');
    if (target) target.focus({ preventScroll: false });
  }

  function setMode(next) {
    mode = next;
    html.dataset.tphone = mode;
    if (mode === 'list') paint();
    else requestAnimationFrame(() => { // the layer's one terminal takes the whole screen: let it refit, and open on its arrow
      window.dispatchEvent(new Event('resize'));
      let tries = 0; // the layer's header can be drawn a frame or two after the mode flips: look for its arrow until it is there
      const toArrow = () => { if (mode !== 'term') return; const arrow = document.querySelector('#grid .pane.is-active .pane-back'); if (arrow && arrow.getClientRects().length) arrow.focus(); else if (++tries < 30) requestAnimationFrame(toArrow); };
      requestAnimationFrame(toArrow);
    });
    deps.fire && deps.fire(rows().length);
  }

  function closeSheet(restore = true) {
    if (!sheet) return;
    const from = sheet.from;
    sheet.el.remove(); sheet = null;
    document.removeEventListener('keydown', onSheetKey, true);
    if (restore && from && from.isConnected) from.focus();
  }
  function onSheetKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } }

  function openMore(s, from) {
    focusAfter = null;
    closeSheet(false);
    const scrim = el('div', 'tp-scrim');
    scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSheet(); });
    const box = el('div', 'tp-sheet');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'More for ' + s.name);
    const head = el('div', 'tp-sheethead');
    head.appendChild(el('div', 'tp-sheettitle', s.name || PHONE_WORDS.title));
    const x = el('button', 'tp-ib');
    x.type = 'button'; x.title = 'Close'; x.setAttribute('aria-label', 'Close'); x.innerHTML = icon('close');
    x.addEventListener('click', () => closeSheet());
    head.appendChild(x);
    const stop = el('button', 'tp-sheetrow err');
    stop.type = 'button'; stop.dataset.act = 'stop';
    stop.innerHTML = icon('stop');
    stop.appendChild(el('span', null, PHONE_WORDS.stop));
    stop.addEventListener('click', () => {
      const idx = rows().findIndex((x) => x.sid === s.sid);
      focusAfter = { sid: s.sid, idx: Math.max(0, idx) };
      closeSheet(false);
      if (from && from.isConnected) from.focus(); // the confirmation gives focus back here if it is cancelled
      deps.end(s.sid);
    });
    box.append(head, stop);
    scrim.appendChild(box);
    deps.host.appendChild(scrim);
    sheet = { el: scrim, from };
    document.addEventListener('keydown', onSheetKey, true);
    stop.focus();
  }

  /** A started terminal joins the list a moment after the start answers: open it as the layer once it is there. */
  function openWhenThere(before) {
    if (rows().length > before) { wantMore = null; setMode('term'); return; }
    wantMore = before;
    paint();
  }

  function openTerminal(sid) {
    lastOpenSid = sid;
    focusAfter = null;
    deps.act(sid);
    setMode('term');
  }

  async function startRecipe(v) {
    if (starting !== null) return; // one start at a time
    errors.delete(v.id);
    starting = v.id;
    const before = rows().length;
    paint();
    let ok = true;
    try {
      if (v.open > 0 && !v.canStart && v.goSid != null) deps.goTo(v.goSid);
      else await deps.startRecipe(v.id);
    } catch { ok = false; }
    starting = null;
    // a refusal arrives as a "wb:launch-refused" event with the engine's sentence (see onRefused); otherwise the terminal is there now
    if (ok && !errors.has(v.id)) openWhenThere(before); else paint();
  }

  function onRefused(e) {
    const text = e && e.detail && e.detail.text;
    if (!text || !starting) return;
    errors.set(starting, String(text).slice(0, 240));
    paint();
  }
  document.addEventListener('wb:launch-refused', onRefused);

  function termRow(s) {
    const r = el('div', 'tp-row');
    r.dataset.sid = String(s.sid);
    const open = el('button', 'tp-open');
    open.type = 'button';
    open.setAttribute('aria-label', 'Open ' + (s.name || 'terminal'));
    const tile = el('span', 'tp-tile'); tile.innerHTML = icon('terminal');
    const tx = el('span', 'tp-tx');
    tx.appendChild(el('span', 'tp-nm', s.name || 'Shell'));
    tx.appendChild(el('span', 'tp-st', PHONE_WORDS.where + ' · ' + PHONE_WORDS.running));
    open.append(tile, tx);
    open.addEventListener('click', () => openTerminal(s.sid));
    const more = el('button', 'tp-ib tp-more');
    more.type = 'button'; more.title = 'More for ' + (s.name || 'terminal'); more.setAttribute('aria-label', 'More for ' + (s.name || 'terminal'));
    more.innerHTML = icon('more_vert');
    more.addEventListener('click', () => openMore(s, more));
    r.append(open, more);
    return r;
  }

  function recipeRow(v) {
    const r = el('div', 'tp-row tp-rcp');
    r.dataset.recipe = v.id;
    const main = el('div', 'tp-rmain');
    const tile = el('span', 'tp-tile');
    const mk = deps.mark ? deps.mark(v) : null;
    if (mk) tile.appendChild(mk); else tile.innerHTML = icon('terminal');
    const tx = el('span', 'tp-tx');
    tx.appendChild(el('span', 'tp-nm', v.name));
    tx.appendChild(el('span', 'tp-st', PHONE_WORDS.where));
    const b = el('button', 'tp-start');
    b.type = 'button';
    b.dataset.act = 'start';
    b.setAttribute('aria-label', PHONE_WORDS.start + ' ' + v.name);
    b.textContent = starting === v.id ? '…' : PHONE_WORDS.start;
    b.disabled = starting === v.id;
    b.addEventListener('click', () => void startRecipe(v));
    main.append(tile, tx, b);
    r.appendChild(main);
    const why = errors.get(v.id);
    if (why) { const e = el('div', 'tp-err', why); e.setAttribute('role', 'alert'); r.appendChild(e); }
    return r;
  }

  // the page is rebuilt only when what it shows changed: every list broadcast used to rebuild it, and a tap that straddled a rebuild landed on a node that was already gone
  let lastSig = '';
  function paint() {
    if (mode === 'term' && !rows().length) mode = 'list', html.dataset.tphone = mode;
    const sig = JSON.stringify([mode, rows().map((s) => [s.sid, s.name]), recipes && recipes.map((v) => [v.id, v.name, v.open, v.canStart, v.goSid]), [...errors], starting, !!sheet, shellBusy, canShell()]);
    if (sig === lastSig && root.firstChild) return;
    lastSig = sig;
    root.textContent = '';
    const heading = el('h2', 'tp-h', PHONE_WORDS.title);
    heading.tabIndex = -1;
    root.appendChild(heading);
    const nb = el('button', 'tp-new');
    nb.type = 'button'; nb.dataset.act = 'new-shell';
    nb.disabled = shellBusy;
    nb.innerHTML = icon('add');
    nb.appendChild(el('span', null, PHONE_WORDS.newShell));
    nb.addEventListener('click', async () => {
      if (shellBusy) return; // a second tap while the first shell is being made starts nothing (the page may have been rebuilt under the finger: the guard is not on the node)
      shellBusy = true;
      paint(); // the busy state shows on the (possibly rebuilt) button
      const before = rows().length;
      let made = null;
      try { made = await deps.newCli(); } catch { made = null; }
      shellBusy = false;
      paint();
      if (made !== null && made !== false) openWhenThere(before);
    });
    if (canShell()) root.appendChild(nb);
    const mine = rows();
    if (mine.length) {
      root.appendChild(el('h3', 'tp-sh', PHONE_WORDS.here(mine.length)));
      for (const s of mine) root.appendChild(termRow(s));
    } else {
      root.appendChild(el('p', 'tp-none', canShell() ? PHONE_WORDS.none : recipes && recipes.length ? PHONE_WORDS.noneHosted : PHONE_WORDS.noRecipes));
    }
    if (recipes && recipes.length) {
      root.appendChild(el('h3', 'tp-sh', PHONE_WORDS.recipes(recipes.length)));
      for (const v of recipes) root.appendChild(recipeRow(v));
    }
    const cc = el('button', 'tp-custom');
    cc.type = 'button'; cc.dataset.act = 'custom';
    cc.textContent = PHONE_WORDS.custom;
    cc.addEventListener('click', () => deps.customCommand());
    root.appendChild(cc);
  }

  return {
    update(next) {
      list = next || [];
      if (wantMore !== null && rows().length > wantMore) { wantMore = null; setMode('term'); } else paint();
      if (focusAfter) { const f = focusAfter; if (!rows().some((s) => s.sid === f.sid)) { focusAfter = null; if (mode === 'list') focusBest(null, f.idx); } }
      deps.fire && deps.fire(rows().length);
    },
    setRecipes(next) { recipes = Array.isArray(next) ? next : null; paint(); },
    /** The engine's capabilities changed (no bare shell on a hosted engine): draw the page again. */
    capsChanged() { paint(); },
    /** The Terminals tab is (not) the surface on screen. */
    setSurface(on) { html.dataset.termSurface = on ? '1' : ''; if (on) setMode(mode === 'term' && rows().length ? 'term' : 'list'); else closeSheet(false); },
    mode: () => mode,
    destroy() { document.removeEventListener('wb:launch-refused', onRefused); closeSheet(false); root.remove(); back.remove(); },
  };
}
