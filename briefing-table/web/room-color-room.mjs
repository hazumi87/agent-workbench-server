/* ROOM COLOR... on a room row [workgroup design] Owner 2026-10-05: "We need a way
 * to update the room color mark." A small swatch picker (the room settings'
 * sample colors, plus Custom) that PATCHes /api/rooms/:id/settings {color}, the
 * same route Room settings' Room color rows use. Same scrim / card / buttons as
 * Rename. Touch devices never get a programmatic focus (installation rule). */

/** Open the dialog. c: {room:{id,name,color}, swatches[], api, touch, done(), closed()} */
export function openRoomColor(c) {
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
  let pick = typeof r.color === 'string' ? r.color.toLowerCase() : null;
  const scrim = el('div', 'rsm-dscrim');
  const card = el('div', 'rsm-card kb-capped');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'rsmRcH');
  const hd = el('div', 'hd', 'Color for ');
  hd.id = 'rsmRcH';
  hd.append(el('code', '', r.name));
  const bd = el('div', 'bd');
  const sws = el('div', 'rsm-csws');
  sws.setAttribute('role', 'group');
  sws.setAttribute('aria-label', 'Room color');
  const custom = el('input', 'rsm-ccustom');
  custom.type = 'color';
  custom.setAttribute('aria-label', 'Custom color');
  custom.value = pick || c.swatches[0];
  const paint = () => {
    for (const b of sws.children) {
      b.setAttribute('aria-pressed', String(b.dataset.c === pick));
    }
    custom.dataset.set = String(pick !== null && !c.swatches.includes(pick));
  };
  for (const hex of c.swatches) {
    const b = el('button', 'rsm-csw');
    b.type = 'button';
    b.dataset.c = hex;
    b.style.setProperty('--c', hex);
    b.title = hex;
    b.setAttribute('aria-label', `Room color ${hex}`);
    b.addEventListener('click', () => {
      pick = hex;
      paint();
    });
    sws.append(b);
  }
  custom.addEventListener('input', () => {
    pick = custom.value.toLowerCase();
    paint();
  });
  const crow = el('div', 'rsm-crow');
  crow.append(el('span', '', 'Custom'), custom);
  const err = el('div', 'rsm-derr');
  err.hidden = true;
  bd.append(sws, crow, err);
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
  paint();
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
    if (busy) {
      return;
    }
    if (!pick || pick === (r.color || '').toLowerCase()) {
      close();
      return;
    }
    busy = true;
    yes.disabled = true;
    err.hidden = true;
    try {
      const res = await c.api(`/api/rooms/${encodeURIComponent(r.id)}/settings`, { method: 'PATCH', json: { color: pick } });
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
    sws.querySelector('[aria-pressed="true"]')?.focus();
  }
  return { close };
}
