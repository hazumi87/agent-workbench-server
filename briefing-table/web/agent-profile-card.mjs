/* An agent's stored MODEL & EFFORT card, and the manager's per-agent "..." menu
 * (Owner 2026-10-02, room line [ref]: "use the ... menu by each seat on a room
 * page, or agent on the CLI Manager page, and change their loading model and
 * effort, and have that be what is forced when they disconnect and reconnect").
 *
 * The profile is the agent's own (PATCH /api/sessions/:paneid/profile) and takes
 * effect on its NEXT launch or reconnect — a running claude is not changed — so
 * the card says so after a save. Shared by the room's seat menu
 * (room-seat-menu.mjs) and the CLI Manager (manager.js, manager-rooms.mjs); the
 * card's own look lives in agent-profile-card.css. */

import { cardModelsFor, effortsFor } from '/vendor-profile.mjs'; // the lists, per vendor (one place)
const KEEP = '~'; // a row with no profile yet: "leave it to the project's current default"

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

function select(id, label, options, value) {
  const wrap = el('label', 'apc-f');
  wrap.htmlFor = id;
  wrap.append(el('span', '', label));
  const s = el('select');
  s.id = id;
  for (const [v, t] of options) {
    const o = el('option', '', t);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  wrap.append(s);
  return { wrap, s };
}

/**
 * @param {{paneid: string, label: string, tone?: string|null,
 *          profile: {model: string|null, effort: string|null}|null,
 *          vendor?: string|null (picks the model/effort lists; absent = claude-code),
 *          onClosed?: (saved: boolean) => void}} o
 * profile null = the row has none yet (a legacy agent): both selects start on
 * "project default" and only what the person changes is sent.
 */
export function openProfileCard(o) {
  const MODELS = cardModelsFor(o.vendor);
  const EFFORTS = effortsFor(o.vendor);
  const none = o.profile == null;
  const first = none ? [[KEEP, "Project's current"]] : [];
  const models = [...first, ['', 'Default'], ...MODELS.map((m) => [m, m])];
  if (o.profile?.model && !MODELS.includes(o.profile.model)) {
    models.push([o.profile.model, o.profile.model]);
  }
  const efforts = [...first, ['', 'Default'], ...EFFORTS.map((e) => [e, e])];
  const scrim = el('div', 'apc-scrim');
  const card = el('div', 'apc-card kb-capped');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'apcH');
  card.tabIndex = -1;
  if (o.tone) {
    card.style.setProperty('--pc', o.tone);
  }
  const hd = el('div', 'hd');
  hd.id = 'apcH';
  hd.append('Model & effort for ', el('code', '', o.label));
  const bd = el('div', 'bd');
  const m = select('apcModel', 'Model', models, none ? KEEP : o.profile.model ?? '');
  const e = select('apcEffort', 'Effort', efforts, none ? KEEP : o.profile.effort ?? '');
  const note = el('div', 'apc-note', 'Kept with this agent. It applies the next time it reconnects; a session already running is not changed.');
  const msg = el('div', 'apc-msg');
  msg.setAttribute('role', 'status');
  /* a vendor with no effort vocabulary (gemini-cli) gets no effort select */
  bd.append(m.wrap, ...(EFFORTS.length ? [e.wrap] : []), note, msg);
  const ft = el('div', 'ft');
  const cancel = el('button', 'apc-btn', 'Close');
  cancel.type = 'button';
  const save = el('button', 'apc-btn apc-go', 'Save');
  save.type = 'button';
  ft.append(cancel, save);
  card.append(hd, bd, ft);
  scrim.append(card);
  document.body.append(scrim);
  let saved = false;
  let busy = false;
  const prev = document.activeElement;
  function close() {
    scrim.remove();
    if (prev?.isConnected) {
      prev.focus({ preventScroll: true });
    }
    o.onClosed?.(saved);
  }
  cancel.addEventListener('click', close);
  scrim.addEventListener('click', (ev) => {
    if (ev.target === scrim) {
      close();
    }
  });
  card.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }
  });
  save.addEventListener('click', async () => {
    if (busy) {
      return;
    }
    busy = true;
    save.disabled = true;
    msg.className = 'apc-msg';
    msg.textContent = 'Saving...';
    const body = {};
    if (m.s.value !== KEEP) {
      body.model = m.s.value;
    }
    if (EFFORTS.length && e.s.value !== KEEP) {
      body.effort = e.s.value;
    }
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(o.paneid)}/profile`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      saved = true;
      msg.className = 'apc-msg ok';
      msg.textContent = `Saved: ${j.profile?.model ?? 'default model'}, ${j.profile?.effort ?? 'default effort'}. Applies the next time it reconnects.`;
      cancel.textContent = 'Done';
    } catch (err) {
      msg.className = 'apc-msg bad';
      msg.textContent = `Not saved - ${err?.message ?? err}`;
    }
    busy = false;
    save.disabled = false;
  });
  card.focus({ preventScroll: true }); // never a text field on touch; selects are fine to tab to
  return { close };
}

/* ---- the CLI Manager's per-agent "..." menu: the room "..." menu's surface
 * (manager.css .rr-menu), one item for now. ---- */
const PHONE = '(max-width: 600px)';
let open = null;
const GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';

export function closeAgentMenu() {
  open?.();
}

/** @param {{anchor: HTMLElement, point?: {x:number,y:number}|null, paneid: string, label: string,
 *           tone?: string|null, profile: object|null, vendor?: string|null}} o */
export function openAgentMenu(o) {
  closeAgentMenu();
  const phone = matchMedia(PHONE).matches;
  const m = el('div', `rr-menu${phone ? ' is-sheet' : ''}`);
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', o.label);
  let scrim = null;
  const close = (refocus = true) => {
    m.remove();
    scrim?.remove();
    document.removeEventListener('pointerdown', away, true);
    o.anchor.setAttribute?.('aria-expanded', 'false');
    open = null;
    if (refocus && o.anchor.isConnected) {
      o.anchor.focus({ preventScroll: true });
    }
  };
  const away = (ev) => {
    if (!m.contains(ev.target)) {
      close(false);
    }
  };
  if (phone) {
    m.append(el('div', 'grab'), el('div', 'rr-mt', o.label));
  }
  const item = el('button', 'rr-mi');
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  item.dataset.a = 'prof';
  item.innerHTML = GLYPH;
  item.append('Model & effort...');
  item.addEventListener('click', () => {
    close(false);
    openProfileCard({ paneid: o.paneid, label: o.label, tone: o.tone, profile: o.profile, vendor: o.vendor });
  });
  m.append(item);
  m.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
    }
  });
  if (phone) {
    scrim = el('div', 'rr-scrim');
    document.body.append(scrim);
  }
  document.body.append(m);
  o.anchor.setAttribute?.('aria-expanded', 'true');
  if (!phone) {
    const r = o.anchor.getBoundingClientRect();
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    let x = o.point ? o.point.x : r.right - w;
    let y = o.point ? o.point.y : r.bottom + 4;
    x = Math.max(8, Math.min(x, innerWidth - w - 8));
    y = y + h > innerHeight - 8 ? Math.max(8, (o.point ? o.point.y : r.top) - h - 4) : y;
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
  }
  open = close;
  document.addEventListener('pointerdown', away, true);
  item.focus({ preventScroll: true });
}

/** The "..." button the manager draws beside an agent (live row, room kid). */
export function moreButton(cls, label, onOpen) {
  const b = el('button', cls);
  b.type = 'button';
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-label', label);
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onOpen(b);
  });
  return b;
}
