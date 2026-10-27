/* THE ROOM BRIEF FLYOUT [room brief] Owner 2026-10-05: "an info button on the icon
 * for the room ... a flyout with a message from the lead that includes the type of
 * stuff that goes in the base room and the workrooms. Written in markdown,
 * formatted by our markdown reader."
 *
 * The text is the engine's rooms.brief (GET /api/rooms/:id -> room.brief, by, at),
 * rendered with the room's ONE markdown renderer (room-doc-view.mjs: marked +
 * DOMPurify, links open in a new tab) — never a second one. PC: a popover under
 * the button; phone (<=600px): a bottom sheet. The person may Edit (PATCH
 * /api/rooms/:id {brief}); the lead sets it with /brief. Touch devices never get a
 * programmatic focus (installation rule); inputs are 16px. */
import { loadLibs, renderMarkdown } from '/room-doc-view.mjs';

const MAX = 8000; // the engine's ROOM_BRIEF_MAX

/** Open the flyout. c: {anchor, room:{id,name}, headId|null, api, phone, touch, canSet, done(), closed()} */
export function openBrief(c) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) {
      n.className = cls;
    }
    if (text !== undefined) {
      n.textContent = text;
    }
    return n;
  };
  const scrim = el('div', c.phone ? 'rbf-scrim is-sheet' : 'rbf-scrim');
  const box = el('div', c.phone ? 'rbf is-sheet' : 'rbf');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', `Brief for ${c.room.name}`);
  box.tabIndex = -1;
  scrim.append(box);
  document.body.append(scrim);
  let open = true;
  let showing = { id: c.room.id, name: c.room.name };
  let lastRect = null;
  let tick = 0; // a late fetch for a view we left must not paint over the new one

  const close = () => {
    if (!open) {
      return;
    }
    open = false;
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    c.closed?.();
  };
  const place = () => {
    if (c.phone) {
      return;
    }
    if (c.anchor?.isConnected) {
      lastRect = c.anchor.getBoundingClientRect(); // a repaint of the rail may replace the button: keep the last place
    }
    const a = lastRect;
    const w = Math.min(360, window.innerWidth - 16);
    box.style.width = `${w}px`;
    const left = Math.max(8, Math.min((a?.left ?? 8) - 4, window.innerWidth - w - 8));
    const top = a ? a.bottom + 6 : 48;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
  };
  const when = (ms) => {
    try {
      return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  async function show(target) {
    const my = ++tick;
    showing = target;
    box.textContent = '';
    box.append(el('div', 'rbf-load', 'Loading…'));
    let room = null;
    let err = null;
    try {
      const r = await c.api(`/api/rooms/${encodeURIComponent(target.id)}`);
      room = r.ok ? r.body?.room : null;
      err = r.ok ? null : (r.body?.error ?? `HTTP ${r.status}`);
    } catch (e) {
      err = e?.message ?? String(e);
    }
    if (my !== tick || !open) {
      return;
    }
    box.textContent = '';
    const hd = el('div', 'rbf-hd');
    hd.append(el('span', 'rbf-t', `Brief · ${room?.name ?? target.name}`));
    const x = el('button', 'rbf-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    hd.append(x);
    const body = el('div', 'rbf-body');
    const ft = el('div', 'rbf-ft');
    box.append(hd, body, ft);
    if (err || !room) {
      body.append(el('div', 'rbf-err', err ?? 'could not load'));
      place();
      return;
    }
    if (room.brief) {
      const md = el('div', 'rbf-md dv dv-md');
      body.append(md);
      try {
        md.append(renderMarkdown(await loadLibs(), room.brief, location.href)); // the room's one markdown renderer
      } catch {
        md.classList.add('plain'); // the libraries did not load: the text still reads
        md.textContent = room.brief;
      }
      if (my !== tick || !open) {
        return;
      }
      body.append(el('div', 'rbf-by', `by ${room.brief_by === 'user' ? 'you' : `@${room.brief_by ?? '?'}`} · ${when(room.brief_at)}`));
    } else {
      body.append(el('div', 'rbf-none', c.canSet ? 'No brief yet. Write what goes in this room and in each workgroup, or ask the lead: /brief <markdown>.' : 'No brief yet.'));
    }
    if (c.headId && target.id !== c.headId) {
      const up = el('button', 'rbf-link', 'Main room brief');
      up.type = 'button';
      up.addEventListener('click', () => void show({ id: c.headId, name: 'Main room' }));
      ft.append(up);
    } else if (c.headId && c.room.id !== c.headId) {
      const back = el('button', 'rbf-link', 'This workgroup’s brief');
      back.type = 'button';
      back.addEventListener('click', () => void show({ id: c.room.id, name: c.room.name }));
      ft.append(back);
    }
    if (c.canSet) {
      const ed = el('button', 'rbf-link rbf-edit', 'Edit');
      ed.type = 'button';
      ed.addEventListener('click', () => edit(room));
      ft.append(ed);
    }
    place();
  }

  function edit(room) {
    box.textContent = '';
    const hd = el('div', 'rbf-hd');
    hd.append(el('span', 'rbf-t', `Edit brief · ${room.name}`));
    const body = el('div', 'rbf-body');
    const ta = el('textarea', 'rbf-ta');
    ta.value = room.brief ?? '';
    ta.rows = 9;
    ta.maxLength = MAX;
    ta.setAttribute('aria-label', 'Room brief, markdown');
    ta.placeholder = '- **Workgroup (@alias):** what goes here\n- **Here (root):** what goes in the main room';
    ta.style.fontSize = '16px'; // phone inputs are 16px: no focus zoom
    const err = el('div', 'rbf-err');
    err.hidden = true;
    body.append(ta, err);
    const ft = el('div', 'rbf-ft');
    const no = el('button', 'rbf-btn', 'Cancel');
    no.type = 'button';
    const yes = el('button', 'rbf-btn go', 'Save');
    yes.type = 'button';
    ft.append(no, yes);
    box.append(hd, body, ft);
    let busy = false;
    no.addEventListener('click', () => void show(showing));
    yes.addEventListener('click', async () => {
      if (busy) {
        return;
      }
      busy = true;
      yes.disabled = true;
      err.hidden = true;
      try {
        const text = ta.value.trim();
        const r = await c.api(`/api/rooms/${encodeURIComponent(room.id)}`, { method: 'PATCH', json: { brief: text || null } });
        if (!r.ok) {
          err.hidden = false;
          err.textContent = r.body?.error ?? `HTTP ${r.status}`;
          return;
        }
        await c.done?.();
        await show(showing);
      } catch (e) {
        err.hidden = false;
        err.textContent = e?.message ?? String(e);
      } finally {
        busy = false;
        yes.disabled = false;
      }
    });
    place();
    if (!c.touch) {
      ta.focus();
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) {
      close();
    }
  });
  place();
  void show(showing);
  if (!c.touch) {
    box.focus({ preventScroll: true });
  }
  return { close };
}

/** The (i) button: a small inline info mark. `onOpen(button)` runs on click (and never selects the row around it). */
export function briefButton(label, onOpen) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rbf-i';
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-haspopup', 'dialog');
  b.title = label;
  b.textContent = 'ⓘ';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    onOpen(b);
  });
  b.addEventListener('keydown', (e) => e.stopPropagation()); // Enter / Space act on the button, not the row
  return b;
}
