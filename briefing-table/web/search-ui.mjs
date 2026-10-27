/* SEARCH: the one panel for a room's line and an agent's conversation [search ui] Owner 2026-10-06 (via @briefing-table [ref]);
 * spec = the design system BUILD-HANDOFF §1.K (hub/search.js), engine = GET /api/rooms/:id/search and GET /api/sessions/:paneid/chat/search.
 *
 *   PC     a popover under the button, 460px wide, max-height min(72vh, 660px). Field row: icon, input, "Esc". Count line.
 *   PHONE  a full-screen sheet: a 44px "‹" back, the input (42px, 16px: no iOS zoom), "Clear", full-width result rows.
 *   RESULT line 1: author (mono, in the seat's ink), the time (mono, dim), the place at the right; then ~2 lines of snippet with
 *          EVERY query word in <strong> (the engine sends PARTS, {t, hit?}: built with textContent, never innerHTML).
 *   Debounce 120 ms; a stale answer is dropped. Up/Down move, Enter opens, Esc closes; on a PC a click outside closes.
 *   Empty before typing: a hint + the last searches as chips. No match: "No matches for “q”" + "Try fewer or different words."
 *   No programmatic focus on a TOUCH screen (the room-wide rule: a focus raises the keyboard): a PC focuses the field.
 *
 * o: { anchor, title, placeholder, hint, recentKey, fetch(q, signal) -> {results, more?}, onPick(result), phone? }
 *    a result: { key, author, ink?, time (ms), place?, parts: [{t, hit?}] }
 * Returns { close, isOpen }. One panel at a time (opening another closes the first). */

import { lineWhen } from '/time-format.mjs';
import { stripMarks } from '/markdown-plain.mjs';

let current = null;

const PHONE = '(max-width: 600px)';
const DEBOUNCE_MS = 120;

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

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(path) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  s.append(p);
  return s;
}
export const MAGNIFIER = 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4';

export const whenWords = lineWhen; // the room line's clock, with the date for another day (web/time-format.mjs)

function recent(key) {
  try {
    const a = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}
function remember(key, q) {
  try {
    const a = [q, ...recent(key).filter((x) => x !== q)].slice(0, 5);
    localStorage.setItem(key, JSON.stringify(a));
  } catch {
    /* no storage: the chips just do not persist */
  }
}

/** The snippet parts as nodes: plain text, and <strong> for a hit. Nothing is ever parsed as HTML. */
export function snippetNodes(parts) {
  const frag = document.createDocumentFragment();
  for (const p of Array.isArray(parts) ? parts : []) {
    if (p && typeof p.t === 'string') {
      if (p.hit) {
        frag.append(el('strong', '', p.t));
      } else {
        frag.append(document.createTextNode(stripMarks(p.t, { trim: false }))); // a snippet is plain text: the marks go [line markdown]
      }
    }
  }
  return frag;
}

export function openSearch(o) {
  current?.close(false);
  const phone = o.phone ?? matchMedia(PHONE).matches;
  const touch = matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches;
  const recentKey = o.recentKey ?? 'hwb.search.recent';
  const root = el('div', `sr ${phone ? 'sr-sheet' : 'sr-pop'}`);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', o.title ?? 'Search');

  const bar = el('div', 'sr-bar');
  if (phone) {
    const back = el('button', 'sr-back', '‹');
    back.type = 'button';
    back.setAttribute('aria-label', 'Close search');
    back.addEventListener('click', () => close(true));
    bar.append(back);
  } else {
    const ic = el('span', 'sr-ic');
    ic.append(icon(MAGNIFIER));
    bar.append(ic);
  }
  const input = el('input', 'sr-input');
  input.type = 'search';
  input.placeholder = o.placeholder ?? 'Search…';
  input.setAttribute('aria-label', o.title ?? 'Search');
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.enterKeyHint = 'search';
  bar.append(input);
  if (phone) {
    const clear = el('button', 'sr-clear', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      input.value = '';
      run();
      if (!touch) {
        input.focus();
      }
    });
    bar.append(clear);
  } else {
    bar.append(el('kbd', 'sr-esc', 'Esc'));
  }
  const count = el('div', 'sr-count');
  count.setAttribute('role', 'status');
  count.hidden = true;
  const list = el('div', 'sr-list');
  list.setAttribute('role', 'listbox');
  root.append(bar, count, list);

  let timer = 0;
  let seq = 0;
  let abort = null;
  let rows = [];
  let sel = -1;
  let closed = false;

  function setSel(i) {
    sel = rows.length ? (i + rows.length) % rows.length : -1;
    rows.forEach((r, k) => r.el.setAttribute('aria-selected', String(k === sel)));
    rows[sel]?.el.scrollIntoView({ block: 'nearest' });
  }
  function pick(r) {
    remember(recentKey, input.value.trim());
    close(false);
    o.onPick(r.result);
  }
  function paintHint() {
    rows = [];
    sel = -1;
    count.hidden = true;
    list.replaceChildren();
    const box = el('div', 'sr-empty');
    box.append(el('p', 'sr-hint', o.hint ?? 'Search the whole history…'));
    const chips = recent(recentKey);
    if (chips.length) {
      const row = el('div', 'sr-chips');
      for (const c of chips) {
        const b = el('button', 'sr-chip', c);
        b.type = 'button';
        b.addEventListener('click', () => {
          input.value = c;
          run();
          if (!touch) {
            input.focus();
          }
        });
        row.append(b);
      }
      box.append(row);
    }
    list.append(box);
  }
  function paintNone(q) {
    rows = [];
    sel = -1;
    count.hidden = true;
    const box = el('div', 'sr-empty');
    box.append(el('p', 'sr-none', `No matches for “${q}”`), el('p', 'sr-hint', 'Try fewer or different words.'));
    list.replaceChildren(box);
  }
  function paintError(msg) {
    rows = [];
    sel = -1;
    count.hidden = true;
    const box = el('div', 'sr-empty');
    box.append(el('p', 'sr-none', `Search failed: ${msg}`));
    list.replaceChildren(box);
  }
  function paintResults(res, q) {
    const items = res.results ?? [];
    if (!items.length) {
      paintNone(q);
      if (res.more) {
        list.firstChild?.append(el('p', 'sr-hint', 'Older history was not searched.'));
      }
      return;
    }
    count.hidden = false;
    count.textContent = `${items.length} match${items.length === 1 ? '' : 'es'} · newest first${res.more ? ' · older history not searched' : ''}`;
    const frag = document.createDocumentFragment();
    rows = items.map((result) => {
      const b = el('button', 'sr-row');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', 'false');
      const top = el('div', 'sr-top');
      const au = el('span', 'sr-au', result.author ?? '');
      if (result.ink) {
        au.style.setProperty('--pc', result.ink);
        au.classList.add('has-ink');
      }
      top.append(au, el('span', 'sr-ts', whenWords(result.time)));
      if (result.place) {
        top.append(el('span', 'sr-pl', result.place));
      }
      const sn = el('div', 'sr-sn');
      sn.append(snippetNodes(result.parts));
      b.append(top, sn);
      b.addEventListener('click', () => pick({ result }));
      frag.append(b);
      return { el: b, result };
    });
    list.replaceChildren(frag);
    setSel(0);
  }

  async function run() {
    clearTimeout(timer);
    const q = input.value.trim();
    abort?.abort();
    const mine = ++seq;
    if (q.length < 2) {
      paintHint();
      return;
    }
    abort = new AbortController();
    try {
      const res = await o.fetch(q, abort.signal);
      if (mine === seq && !closed) {
        paintResults(res, q);
      }
    } catch (e) {
      if (mine === seq && !closed && e?.name !== 'AbortError') {
        paintError(e?.message ?? String(e));
      }
    }
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(sel + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && rows[sel]) {
      e.preventDefault();
      pick(rows[sel]);
    }
  });
  const away = (e) => {
    if (!phone && !root.contains(e.target) && !(o.anchor && o.anchor.contains(e.target))) {
      close(false);
    }
  };

  function close(refocus) {
    if (closed) {
      return;
    }
    closed = true;
    clearTimeout(timer);
    abort?.abort();
    document.removeEventListener('pointerdown', away, true);
    window.removeEventListener('blur', onBlur);
    root.remove();
    o.anchor?.setAttribute('aria-expanded', 'false');
    if (current?.root === root) {
      current = null;
    }
    if (refocus && o.anchor?.isConnected && !touch) {
      o.anchor.focus({ preventScroll: true });
    }
    o.closed?.();
  }
  const onBlur = () => {}; // a framed page taking focus does not close a search

  document.body.append(root);
  if (!phone) {
    const r = o.anchor?.getBoundingClientRect();
    const w = Math.min(460, innerWidth - 16);
    root.style.width = `${w}px`;
    const x = r ? Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) : 8;
    root.style.left = `${x}px`;
    root.style.top = `${r ? r.bottom + 6 : 56}px`;
    document.addEventListener('pointerdown', away, true);
  }
  o.anchor?.setAttribute('aria-expanded', 'true');
  paintHint();
  if (!touch) {
    input.focus();
  }
  window.addEventListener('blur', onBlur);
  current = { close, root };
  return { close: () => close(true), isOpen: () => !closed };
}

export const searchIsOpen = () => !!current;
