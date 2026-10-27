/* RENAME A ROOM / WORKGROUP [rename workgroup] Owner 2026-10-05: "rename a
 * subroom's visible name, versus the alias. Keep the alias the same."
 * PATCH /api/rooms/:id {name} (person cookie). The body carries the NAME ONLY:
 * the alias is shown read-only and is never sent, so a rename cannot move an
 * address. The engine posts the room's fact line and decides every refusal;
 * its words are shown inline. Same scrim / card / buttons as the seat menu's
 * Remove card. Touch devices never get a programmatic focus (installation rule). */

const NAME_MAX = 80;

/** Open the dialog. c: {room:{id,name,alias}, api, touch, done(), closed()} */
export function openRenameRoom(c) {
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
  const r = c.room;
  const scrim = el('div', 'rsm-dscrim');
  const card = el('div', 'rsm-card kb-capped');
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'rsmRrH');
  card.setAttribute('aria-describedby', 'rsmRrB');
  const hd = el('div', 'hd', 'Rename ');
  hd.id = 'rsmRrH';
  hd.append(el('code', '', r.name));
  const bd = el('div', 'bd');
  bd.id = 'rsmRrB';
  const input = el('input', 'rsm-wtext');
  input.type = 'text';
  input.value = r.name;
  input.maxLength = NAME_MAX;
  input.setAttribute('aria-label', 'Room name');
  input.style.fontSize = '16px'; // phone inputs are 16px: no focus zoom
  bd.append(input);
  if (r.alias) {
    bd.append(el('div', 'rsm-renhint', `@${r.alias} stays the same`));
  }
  const err = el('div', 'rsm-derr');
  err.hidden = true;
  bd.append(err);
  const ft = el('div', 'ft');
  const no = el('button', 'rsm-btn', 'Cancel');
  no.type = 'button';
  no.dataset.a = 'cancel';
  const yes = el('button', 'rsm-btn', 'Save');
  yes.type = 'button';
  yes.dataset.a = 'save';
  ft.append(no, yes);
  card.append(hd, bd, ft);
  scrim.append(card);
  document.body.append(scrim);
  let open = true;
  let busy = false;
  const close = () => {
    if (!open) {
      return;
    }
    open = false;
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    c.closed?.();
  };
  const save = async () => {
    const name = input.value.trim();
    if (busy) {
      return;
    }
    if (!name) {
      err.hidden = false;
      err.textContent = 'A room needs a name.';
      return;
    }
    if (name === r.name) {
      close();
      return;
    }
    busy = true;
    yes.disabled = true;
    err.hidden = true;
    try {
      const res = await c.api(`/api/rooms/${encodeURIComponent(r.id)}`, { method: 'PATCH', json: { name } });
      if (!res.ok) {
        err.hidden = false;
        err.textContent = res.body?.error ?? `HTTP ${res.status}`;
        return;
      }
      close();
      await c.done?.();
    } catch (e) {
      err.hidden = false;
      err.textContent = e?.message ?? String(e);
    } finally {
      busy = false;
      yes.disabled = false;
    }
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && e.target === input) {
      e.preventDefault();
      void save();
    }
  }
  document.addEventListener('keydown', onKey, true);
  no.addEventListener('click', close);
  yes.addEventListener('click', () => void save());
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) {
      close();
    }
  });
  if (!c.touch) {
    input.focus();
    input.select();
  }
  return { close };
}
