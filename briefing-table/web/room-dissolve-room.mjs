/* DISSOLVE A WORKGROUP (Owner [ref]): "a group dissolve that is NON-DESTRUCTIVE to
 * the seats". POST /api/rooms/:id/dissolve (person cookie): every seat, the lead
 * included, returns to the main room; the empty group is closed, never deleted.
 * The dialog lists who moves BEFORE asking (read from the room, not guessed), says
 * what is kept, and shows the engine's own refusal inline. Same scrim / card /
 * buttons as the rename dialog; the card opts in to the keyboard cap (kb-capped).
 * Touch devices never get a programmatic focus (installation rule). */

/** The sentence the card shows: '@a, @b and @c (lead) return to <Parent>.' */
export function dissolveSummary(seats, leadId, parentName) {
  const names = seats.map((s) => `@${s.handle}${s.id === leadId ? ' (lead)' : ''}`);
  const list = names.length === 0 ? 'No seats' : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length > 1 ? 'return' : 'returns'} to ${parentName}. The group's history is kept. Nothing is deleted.`;
}

/** Open the dialog. c: {room:{id,name}, parentName, api, touch, done(result), closed(), defer?()} */
export function openDissolveRoom(c) {
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
  card.setAttribute('aria-labelledby', 'rsmDsH');
  card.setAttribute('aria-describedby', 'rsmDsB');
  const hd = el('div', 'hd', 'Dissolve ');
  hd.id = 'rsmDsH';
  hd.append(el('code', '', r.name), el('span', '', '?'));
  const bd = el('div', 'bd');
  bd.id = 'rsmDsB';
  const msg = el('div', 'rsm-dmsg', 'Reading the group…');
  bd.append(msg);
  const err = el('div', 'rsm-derr');
  err.hidden = true;
  bd.append(err);
  const ft = el('div', 'ft');
  const no = el('button', 'rsm-btn', 'Cancel');
  no.type = 'button';
  no.dataset.a = 'cancel';
  const yes = el('button', 'rsm-btn', 'Dissolve');
  yes.type = 'button';
  yes.dataset.a = 'dissolve';
  yes.disabled = true; // until the seat list has been read
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
  void (async () => {
    try {
      const res = await c.api(`/api/rooms/${encodeURIComponent(r.id)}`);
      if (!open) {
        return;
      }
      if (!res.ok) {
        msg.textContent = '';
        err.hidden = false;
        err.textContent = res.body?.error ?? `HTTP ${res.status}`;
        return;
      }
      const seats = (res.body?.seats ?? []).filter((s) => !s.left_at);
      msg.textContent = dissolveSummary(seats, res.body?.room?.lead_seat ?? null, c.parentName ?? 'the main room');
      yes.disabled = false;
      if (!c.touch) {
        yes.focus({ preventScroll: true });
      }
    } catch (e) {
      msg.textContent = '';
      err.hidden = false;
      err.textContent = e?.message ?? String(e);
    }
  })();
  const go = async () => {
    if (busy || yes.disabled) {
      return;
    }
    busy = true;
    yes.disabled = true;
    err.hidden = true;
    if (c.defer) {
      close(); // the page leaves for the family root and performs it there (Owner [ref])
      c.defer();
      busy = false;
      return;
    }
    try {
      const res = await c.api(`/api/rooms/${encodeURIComponent(r.id)}/dissolve`, { method: 'POST', json: {} });
      if (!res.ok) {
        err.hidden = false;
        err.textContent = res.body?.error ?? `HTTP ${res.status}`;
        yes.disabled = false;
        return;
      }
      close();
      await c.done?.(res.body);
    } catch (e) {
      err.hidden = false;
      err.textContent = e?.message ?? String(e);
      yes.disabled = false;
    } finally {
      busy = false;
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
  yes.addEventListener('click', () => void go());
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) {
      close();
    }
  });
  return { close };
}
