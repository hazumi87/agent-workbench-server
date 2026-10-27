/* ROOM SETTINGS -> "Workgroups" (main room only) [wg settings] Owner 2026-10-05: a second way
 * into what the row's ⋯ Rename… / Color… already do. One line per workgroup: the name (edited
 * inline, PATCH /api/rooms/<wg id> {name}; the alias is shown and never sent, so an address cannot
 * move) and a color swatch that opens the Color… picker (room-color-room.mjs; it PATCHes
 * /api/rooms/<wg id>/settings {color}). Data = the room view's family.workgroups. The engine
 * decides every refusal and its words show inline beside the line. */
import { openRoomColor } from '/room-color-room.mjs';

const NAME_MAX = 80;

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

/** c: {list:()=>[{id,name,alias,color,state}], api, swatches[], touch, refresh()} -> {el, paint()} ; el is null-safe to append */
export function workgroupsGroup(c) {
  const g = mk('div', 'pv-grp pv-wgs');
  g.append(mk('h4', '', 'Workgroups'));
  const rows = mk('div', 'pv-wg-rows');
  g.append(rows);
  let editing = null; // id of a line whose name field is focused/dirty: the repaint leaves it alone

  function line(w) {
    const li = mk('div', 'pv-wg-row');
    li.dataset.id = w.id;
    const sw = mk('button', 'pv-wg-sw');
    sw.type = 'button';
    sw.style.setProperty('--c', w.color || 'transparent');
    sw.dataset.set = String(!!w.color);
    sw.title = `Color for ${w.name}`;
    sw.setAttribute('aria-label', `Color for ${w.name}`);
    sw.addEventListener('click', () => {
      openRoomColor({ room: w, swatches: c.swatches, api: c.api, touch: c.touch, done: () => c.refresh(), closed: () => sw.isConnected && sw.focus({ preventScroll: true }) });
    });
    const input = mk('input', 'pv-wg-name');
    input.type = 'text';
    input.value = w.name;
    input.maxLength = NAME_MAX;
    input.style.fontSize = '16px'; // phone inputs are 16px: no focus zoom
    input.setAttribute('aria-label', `Name of ${w.name}`);
    const al = mk('span', 'pv-wg-alias', w.alias ? `@${w.alias}` : '');
    al.title = 'The alias is its address and never changes';
    const msg = mk('p', 'pv-msg pv-wg-msg');
    msg.setAttribute('role', 'status');
    let busy = false;
    const save = async () => {
      const v = input.value.trim();
      if (busy || !v || v === w.name) {
        input.value = busy ? input.value : (v ? input.value : w.name);
        editing = null;
        return;
      }
      busy = true;
      msg.textContent = 'Saving…';
      msg.dataset.kind = '';
      try {
        const r = await c.api(`/api/rooms/${encodeURIComponent(w.id)}`, { method: 'PATCH', json: { name: v } });
        if (!r.ok) {
          msg.textContent = `Not saved: ${r.body?.error ?? `HTTP ${r.status}`}`;
          msg.dataset.kind = 'error';
          return;
        }
        msg.textContent = 'Saved';
        editing = null;
        await c.refresh();
      } catch (e) {
        msg.textContent = `Not saved: ${e?.message ?? e}`;
        msg.dataset.kind = 'error';
      } finally {
        busy = false;
      }
    };
    input.addEventListener('focus', () => { editing = w.id; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void save();
      } else if (e.key === 'Escape') {
        input.value = w.name;
        msg.textContent = '';
        input.blur();
      }
    });
    input.addEventListener('blur', () => void save());
    li.append(sw, input, al, msg);
    return li;
  }

  function paint() {
    if (editing && rows.contains(document.activeElement)) {
      return; // a name being typed is never torn out by a poll
    }
    rows.textContent = '';
    const list = c.list();
    for (const w of list) {
      rows.append(line(w));
    }
    g.hidden = !list.length;
  }
  paint();
  return { el: g, paint };
}
