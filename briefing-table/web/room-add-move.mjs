/* THE MOVE TAB of the Seats cell's + sheet [rail split] (Owner 2026-10-05,
 * the design system [ref]): pick an agent from ELSEWHERE in the family and move it HERE.
 * Same name, same session. Uses the existing seat-move route, which is keyed
 * on the SOURCE room: POST /api/rooms/<from>/seats/<seat>/move {to_room: here}.
 * The engine decides every refusal (a room's lead cannot move: "hand the lead
 * over first"); it is shown inline beside the rows, never as a toast.
 *
 * The family's seat lists are read when the tab is first drawn (GET
 * /api/rooms/<id> per source room, in parallel); a failed read says so on its
 * own group and never blanks the others.
 */
import { moveSources } from '/room-workgroups.mjs';

const MIDDOT = String.fromCharCode(183);
const MDASH = String.fromCharCode(8212);
const ELL = String.fromCharCode(8230);

export function createMoveTab(c) {
  const m = { loaded: false, loading: false, groups: [], picked: null, busy: false, error: '' };

  async function load() {
    if (m.loading) { return; }
    m.loading = true;
    const srcs = moveSources(c.room(), c.family());
    m.groups = await Promise.all(srcs.map(async (s) => {
      try {
        const r = await c.call(`/api/rooms/${encodeURIComponent(s.id)}`);
        if (!r.ok) { return { ...s, seats: [], err: r.body?.error ?? `HTTP ${r.status}` }; }
        return { ...s, seats: Array.isArray(r.body?.seats) ? r.body.seats : [], lead: r.body?.room?.lead_seat ?? null, err: '' };
      } catch (e) {
        return { ...s, seats: [], err: e?.message ?? String(e) };
      }
    }));
    m.loaded = true;
    m.loading = false;
    c.render();
  }

  const isLead = (g, s) => s.is_lead || (g.lead && g.lead === s.id);
  const metaOf = (s) => {
    const st = s.occupant?.state === 'live' ? 'live' : s.occupant?.state === 'dehydrated' ? 'restorable' : s.status || 'idle';
    return `${st}${s.project ? ` ${MIDDOT} ${s.project}` : ''}`;
  };
  const count = () => m.groups.reduce((a, g) => a + g.seats.filter((s) => !isLead(g, s)).length, 0);

  function body(box) {
    if (!m.loaded) {
      void load();
      box.append(c.mk('div', 'ras-empty', `loading${ELL}`));
      return;
    }
    const here = c.room();
    box.append(c.mk('div', 'rwg-note', `Same name, same session. Pick an agent from elsewhere in the family and it moves into ${here?.name ?? 'this room'}.`));
    if (!m.groups.length) {
      box.append(c.mk('div', 'ras-empty', 'No other room in this family.'));
    }
    for (const g of m.groups) {
      box.append(c.secHead(g.name, g.seats.length));
      if (g.err) { box.append(c.mk('div', 'ras-err ras-inset', `could not read ${g.name} ${MDASH} ${g.err}`)); }
      if (!g.err && !g.seats.length) { box.append(c.mk('div', 'ras-empty', `${g.name} has no seats.`)); }
      for (const s of g.seats) {
        const lead = isLead(g, s);
        const on = m.picked?.seat === s.id;
        const pick = () => {
          if (lead || m.busy) { return; }
          m.picked = on ? null : { from: g.id, seat: s.id, handle: s.handle };
          m.error = '';
          c.render();
        };
        const row = c.checkRow(`rwg-pick${lead ? ' is-refused' : ''}`, on, `@${s.handle} from ${g.name}`, pick);
        row.setAttribute('role', 'radio'); // one agent at a time
        row.setAttribute('aria-disabled', String(lead));
        row.dataset.move = s.id;
        row.dataset.fid = `mv-${s.id}`;
        row.append(c.glyph({ vendor: s.vendor ?? s.occupant?.vendor, state: s.occupant?.state, activity: s.occupant?.activity, attached: !!s.occupant?.attached }, false));
        const nm = c.mk('div', 'nm');
        nm.append(c.mk('div', 'a', `@${s.handle}`));
        nm.append(c.mk('div', 'b', lead ? 'lead: hand the lead over first' : metaOf(s)));
        row.append(nm);
        box.append(row);
      }
    }
  }

  function footer(ft, close) {
    if (m.error) {
      const e = c.mk('div', 'ras-err', m.error);
      e.setAttribute('role', 'status');
      ft.append(e);
    }
    const why = c.mk('span', 'ras-why', m.picked ? '' : 'pick an agent');
    const cancel = c.button('ras-btn', 'Cancel', 'mv-cancel');
    cancel.addEventListener('click', close);
    const go = c.button('ras-btn pri ras-go', m.picked ? `Move @${m.picked.handle} here` : 'Move here', 'mv-go');
    go.disabled = !m.picked || m.busy;
    go.addEventListener('click', async () => {
      const p = m.picked;
      if (!p || m.busy) { return; }
      m.busy = true;
      m.error = '';
      c.render();
      let r;
      try {
        r = await c.call(`/api/rooms/${encodeURIComponent(p.from)}/seats/${encodeURIComponent(p.seat)}/move`, { to_room: c.room().id });
      } catch (e) {
        r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
      }
      m.busy = false;
      if (!r.ok) {
        m.error = `Not moved ${MDASH} ${r.body?.error ?? `HTTP ${r.status}`}`;
        c.render();
        return;
      }
      m.picked = null;
      m.loaded = false; // the lists changed: read them again
      m.loading = false;
      try { await c.applied(r.body); } catch { /* the next poll draws it */ }
      c.toast(`Moved @${p.handle} to ${c.room().name}.`);
      c.render();
    });
    ft.append(why, cancel, go);
  }

  return { body, footer, count };
}
