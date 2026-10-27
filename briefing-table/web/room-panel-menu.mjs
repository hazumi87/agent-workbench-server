/* THE PANEL CELL MENU (the design system room-add-sheet-v1 §4: "Managing a panel already
 * in the room: on the panel"). A panel is managed where it is, never from a
 * second list in the + sheet.
 *
 * It is the SEAT MENU component exactly (web/room-seat-menu.mjs: the same
 * host, surface, keyboard and toast): a title row "Tasks · Room Tasks", then,
 * in a fixed order, disabled not hidden:
 *   Rename panel… (inline in the header: Enter saves, Esc cancels, the reason
 *   in coral) · Move up · Move down (Alt+Up / Alt+Down on a focused header;
 *   disabled at the ends, with the reason) · Collapse · — · Remove from room
 *   (coral, NO confirm: an Undo toast, the same verb as the Apps tab's Remove).
 * Opened by the header's ⋯ (hover / focus; always on touch, 44px), a
 * right-click, Shift+F10 / the Menu key, and a long press.
 *
 * The ENGINE writes every fact: PATCH .../panels/:id {title|order}, DELETE
 * .../panels/:id; a panel that belongs to an APP (app_slug) is removed with
 * the app, DELETE .../apps/:slug, and its Undo is POST .../apps {slug}. A
 * plain panel's Undo registers it again from what the room view showed.
 *
 * This module owns no room state; room.js hands it hooks:
 *   roomId, api(path, opts), panels() -> the room's panels in order,
 *   collapsed(id) / setCollapsed(id, v) (desktop cells), applied(body)
 *   (fold a route's answer in: entries + a re-GET), redraw() (the phone
 *   sheet's rows), appName(slug) -> the app's name or null.
 */
import { createMenuHost, wireMenuOpeners, menuToast, svg } from '/room-seat-menu.mjs';

const UP = String.fromCharCode(8593);
const DOWN = String.fromCharCode(8595);
const ELL = String.fromCharCode(8230);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

export function createPanelMenu(o) {
  const host = createMenuHost();
  let renaming = null; // panel id
  let handing = false;
  let busy = false; // a move / remove in flight: a second one waits for the redraw

  const holding = () => !!(host.isOpen() || renaming || handing);
  const panelOf = (id) => o.panels().find((p) => p.id === id) || null;
  const base = () => `/api/rooms/${encodeURIComponent(o.roomId)}`;

  async function call(path, opts) {
    try {
      return await o.api(path, opts);
    } catch (e) {
      return { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
    }
  }

  function release(back, refocus) {
    if (refocus && back?.row?.isConnected) {
      back.row.focus({ preventScroll: true });
    }
    if (!holding()) {
      o.redraw?.();
    }
  }

  function items(p, where) {
    const list = o.panels();
    const i = list.findIndex((x) => x.id === p.id);
    const folded = where === 'cell' && o.collapsed(p.id);
    return [
      { a: 'ren', label: `Rename panel${ELL}`, icon: 'ren' },
      { a: 'up', label: 'Move up', icon: 'up', k: `Alt+${UP}`, off: i <= 0, why: 'Already first' },
      { a: 'down', label: 'Move down', icon: 'down', k: `Alt+${DOWN}`, off: i < 0 || i >= list.length - 1, why: 'Already last' },
      where === 'cell'
        ? { a: 'fold', label: folded ? 'Expand' : 'Collapse', icon: folded ? 'unfold' : 'fold' }
        : { a: 'fold', label: 'Collapse', icon: 'fold', off: true, why: 'On a phone an app opens on its own screen; there is nothing to fold' },
      'sep',
      p.kind === 'voice'
        ? { a: 'rem', label: 'Remove from room', icon: 'rem', cls: 'danger', off: true, why: "Voice's panel is the room's own: it goes when voice is switched off in Room settings" }
        : { a: 'rem', label: 'Remove from room', icon: 'rem', cls: 'danger' },
    ];
  }

  function openMenu(id, row, point, more, where) {
    host.close(false);
    const p = panelOf(id);
    if (!p) {
      return;
    }
    const app = p.app_slug ? o.appName?.(p.app_slug) || p.app_slug : null;
    host.open({
      row,
      more,
      point,
      label: p.title,
      title: p.title,
      sub: app || (p.seat_handle ? `via @${p.seat_handle}` : 'room panel'), // the design system: never the bare "panel"
      data: { panel: id },
      items: items(p, where),
      choose: (it, back) => choose(it, id, back, where),
      closed: (back, refocus) => release(back, refocus),
    });
  }

  function choose(it, id, back, where) {
    if (it.a === 'ren') {
      handing = true;
      host.close(false);
      const p = panelOf(id);
      if (p && back?.row?.isConnected) {
        renaming = id;
        mountRename(back.row, p, where);
      }
      handing = false;
      if (!holding()) {
        o.redraw?.();
      }
      return;
    }
    host.close(it.a === 'up' || it.a === 'down' || it.a === 'fold');
    if (it.a === 'up' || it.a === 'down') {
      void move(id, it.a === 'up' ? -1 : 1, back?.row);
    } else if (it.a === 'fold') {
      o.setCollapsed(id, !o.collapsed(id));
    } else if (it.a === 'rem') {
      void remove(id);
    }
  }

  /* ---- Move: the new order, as whole numbers, PATCHed where it changed ---- */

  async function move(id, dir, row) {
    if (busy) {
      return;
    }
    const list = o.panels();
    const i = list.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) {
      return;
    }
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    busy = true;
    let failed = null;
    for (const [n, p] of next.entries()) {
      if (p.order === n) {
        continue;
      }
      const r = await call(`${base()}/panels/${encodeURIComponent(p.id)}`, { method: 'PATCH', json: { order: n } });
      if (!r.ok) {
        failed = r.body?.error ?? `HTTP ${r.status}`;
        break;
      }
    }
    try {
      await o.applied(null);
    } catch {
      /* the next poll draws it */
    }
    busy = false;
    if (failed) {
      o.error(`${panelOf(id)?.title ?? 'The panel'} not moved — ${failed}`);
    }
    /* the cell was moved in the list: keep the keyboard on its header */
    const again = o.headerOf?.(id) ?? row;
    if (again?.isConnected) {
      again.focus({ preventScroll: true });
    }
  }

  /* ---- Remove: no confirm, an Undo toast ---- */

  async function remove(id) {
    const p = panelOf(id);
    if (!p || busy) {
      return;
    }
    busy = true;
    const r = p.app_slug
      ? await call(`${base()}/apps/${encodeURIComponent(p.app_slug)}`, { method: 'DELETE', json: {} })
      : await call(`${base()}/panels/${encodeURIComponent(p.id)}`, { method: 'DELETE', json: {} });
    busy = false;
    if (!r.ok) {
      o.error(`${p.title} not removed — ${r.body?.error ?? `HTTP ${r.status}`}`);
      return;
    }
    try {
      await o.applied(r.body);
    } catch {
      /* the next poll draws it */
    }
    const what = p.app_slug ? o.appName?.(p.app_slug) || p.title : p.title;
    menuToast(`Removed ${what}`, 'Undo', async () => {
      const u = p.app_slug
        ? await call(`${base()}/apps`, { json: { slug: p.app_slug } })
        : await call(`${base()}/panels`, {
          json: { kind: p.kind, title: p.title, url: p.url, seat_id: p.seat_id ?? undefined, icon: p.icon ?? undefined, order: p.order, scripts: p.scripts === true, uploads: p.uploads === true },
        });
      if (!u.ok) {
        o.error(`${what} not put back — ${u.body?.error ?? u.body?.reason ?? `HTTP ${u.status}`}`);
        return;
      }
      await o.applied(u.body).catch(() => {});
    });
  }

  /* ---- Rename: inline in the header (the seat-rename pattern) ---- */

  function mountRename(row, p, where) {
    if (row.querySelector('.rpm-ren')) {
      return;
    }
    const lab = el('label', 'rsm-ren rpm-ren');
    const inp = el('input');
    inp.value = p.title;
    inp.maxLength = 80;
    inp.spellcheck = false;
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('aria-label', `New name for the ${p.title} panel`);
    lab.append(inp);
    const line = el('div', 'rpm-renhint', 'Enter saves · Esc cancels');
    line.id = `rpm-ren-${p.id}`;
    inp.setAttribute('aria-describedby', line.id);
    /* the cell: the field stands in for the header button (a field inside a
       button is not a field); the phone row: for its name */
    const head = where === 'cell' ? row : row.querySelector('.seat-handle');
    const holder = where === 'cell' ? row.parentElement : row;
    if (!head || !holder) {
      renaming = null;
      return;
    }
    head.hidden = true;
    head.after(lab);
    holder.classList.add('rpm-renaming');
    if (where === 'cell') {
      holder.after(line);
    } else {
      row.append(line);
    }
    let saving = false;
    let done = false;
    const end = (refocus) => {
      if (done) {
        return;
      }
      done = true;
      lab.remove();
      line.remove();
      head.hidden = false;
      holder.classList.remove('rpm-renaming');
      renaming = null;
      release({ row }, refocus);
    };
    lab.addEventListener('click', (e) => e.stopPropagation());
    lab.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('input', () => {
      lab.classList.remove('bad');
      line.className = 'rpm-renhint';
      line.textContent = 'Enter saves · Esc cancels';
    });
    inp.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        end(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const v = inp.value.trim();
        if (v === p.title) {
          end(true);
          return;
        }
        saving = true;
        const r = await call(`${base()}/panels/${encodeURIComponent(p.id)}`, { method: 'PATCH', json: { title: v } });
        saving = false;
        if (!r.ok) {
          lab.classList.add('bad');
          line.className = 'rpm-renerr';
          line.textContent = r.body?.error ?? `HTTP ${r.status}`;
          inp.focus();
          return;
        }
        end(true);
        try {
          await o.applied(r.body);
        } catch {
          /* the next poll draws it */
        }
      }
    });
    inp.addEventListener('blur', () => {
      setTimeout(() => {
        if (!saving && !done && document.activeElement !== inp) {
          end(false);
        }
      }, 0);
    });
    inp.focus({ preventScroll: true });
    inp.select();
  }

  /* ---- wiring ---- */

  /** A desktop CELL: `hw` is its header wrapper, `head` the header button. */
  function decorateCell(hw, head, id) {
    const more = el('button', 'rpm-more');
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.innerHTML = svg('more');
    const label = () => more.setAttribute('aria-label', `More for ${panelOf(id)?.title ?? 'this panel'}`);
    label();
    more.addEventListener('focus', label);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      label();
      openMenu(id, head, null, more, 'cell');
    });
    hw.append(more);
    wireMenuOpeners(hw, (point) => openMenu(id, head, point, null, 'cell'), (e) => e.target === head);
    head.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        void move(id, e.key === 'ArrowUp' ? -1 : 1, head);
      }
    });
    if (renaming === id) {
      const p = panelOf(id);
      if (p) {
        mountRename(head, p, 'cell');
      }
    }
  }

  /** A PHONE sheet row (the Apps section): the same menu, on the row. */
  function decorateRow(li, id) {
    li.classList.add('has-more');
    const more = el('button', 'rsm-more');
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', `More for ${panelOf(id)?.title ?? 'this panel'}`);
    more.innerHTML = svg('more');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(id, li, null, more, 'row');
    });
    li.append(more);
    wireMenuOpeners(li, (point) => openMenu(id, li, point, null, 'row'));
    li.addEventListener('keydown', (e) => {
      if (e.target === li && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        void move(id, e.key === 'ArrowUp' ? -1 : 1, li);
      }
    });
  }

  return { decorateCell, decorateRow, holding, openMenu, close: () => host.close(false) };
}
