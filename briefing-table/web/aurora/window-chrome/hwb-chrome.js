/* ============================================================================
   AURORA — Window chrome, behavior  (v2 · 2026-08-07)
   Companion: hwb-chrome.css · cli-window-chrome-v2.md

   Almost everything is CSS. This file is only the parts CSS cannot do:
   the priority-MAX aggregate, the rail following the active tab, and the exact
   tab DOM so you do not have to re-derive the markup.

   ONE dependency as of v20: hwb-ring.js, because the tab's state glyph IS the
   ring now (see CHANGELOG v20 D). Both ship in the same bundle, so this costs
   a consumer nothing; it is noted because the previous line here said there
   were none. No build step. Import or paste.
   ============================================================================ */
export { hwbMcpIndicator } from './hwb-mcp.js';
import { hwbRing, hwbRingFromChrome, hwbRingLabel, hwbRingApplyContext, HWB_WR_FOLDER, HWB_WR_EAR } from './hwb-ring.js';

/** Urgency order. The aggregate a container shows is the priority-MAX of what
 *  it holds — NOT the state of whatever happens to be in front. */
export const HWB_RANK = ['waiting', 'disconnected', 'waiting-seen', 'streaming', 'background', 'watching', 'idle', 'restorable', 'ended'];
/* v26: `restorable` (a dehydrated session that can be brought back) joins the chrome
   vocabulary. The ring always had it (amber dashed inner ring, rank 5 of 6); only
   the chrome's own list lacked it, so consumers folded it into `ended`, which is a
   lie: nothing ended, and "restorable" is the one thing you can DO about it. Ranks
   between idle and ended, exactly as HWB_RING_RANK does. */
/* v21: `background` (AB·B) sits between streaming and watching; the engine's
   `busy` is streaming under another name and is normalized on the way in. */
const hwbNormState = st => (st === 'busy' ? 'streaming' : st);

export const HWB_STATES = new Set(HWB_RANK);

/* ============================================================================
   TAB NOTICES — the second signal on a tab, and why it is not a third
   component.

   A tab already says WHAT THE SESSION IS DOING (the state glyph). A notice says
   WHAT THE SESSION IS CARRYING. Two things needed to reach a user who is looking
   at some other tab:

     A · a tool publishing a status about itself — the command bridge's sudo
         credential, {kind, text, short, expiresAt}
     B · copyable fields an agent has handed over — {count}

   THEY ARE ONE COMPONENT. Not because they are the same fact, but because the
   surface is 96–240px and it has room for one more slot, not two — and because
   both answer the same question ("is this session carrying something I should
   know about?"), which is the test for whether two things are one component.
   They share a rail; when both are present the rail resolves it by rank, which
   is the resolution rule this file already uses twice (hwbAggregate, and the
   ring's lead).

   NEITHER IS AN ASK. See hwb-chrome.css for the three mechanical guarantees
   (no motion, no coral, square-not-round). Nothing in this file may set
   .st-waiting, toggle .is-lead, or add a class to a tab on account of a notice.

   NEITHER IS CLEARED BY BEING SEEN. There is no hwbNoteAcknowledge() and there
   must never be one. A tool's status clears when the tool renews it; an item
   count clears when the items are taken.
   ============================================================================ */

/** Notice rank. cold > warn > items: a thing that is broken outranks a thing
 *  that is merely waiting to be picked up. The lead renders in full, the rest
 *  collapse to dots. */
export const HWB_NOTE_RANK = { cold: 3, warn: 2, items: 1 };

/** The kinds the engine may publish. 'ok' is accepted and deliberately renders
 *  NOTHING — see the .n-ok rule in the CSS. */
export const HWB_NOTE_KINDS = ['ok', 'warn', 'cold'];

/* ---------------------------------------------------------------------------
   hwbNoteCountdown(expiresAt, now) -> '4h12m' | '37m' | '<1m' | 'EXPIRED' | null

   The client ticks its own clock. `expiresAt` is an epoch-ms number the engine
   passes through UNREAD, so a live countdown costs zero polling: one timestamp
   published once, re-read locally until it changes.

   Returns null when there is nothing to count down — that is not an error, it
   is the ordinary case for a status with no deadline.
   --------------------------------------------------------------------------- */
export function hwbNoteCountdown(expiresAt, now = Date.now()) {
  if (expiresAt == null || !Number.isFinite(expiresAt)) return null;
  const ms = expiresAt - now;
  if (ms <= 0) return 'EXPIRED';
  const mins = Math.floor(ms / 60000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
  if (mins >= 1) return `${mins}m`;
  return '<1m';
}

/* ---------------------------------------------------------------------------
   hwbTabNotices(tab, now) -> [{cls, rank, text, title}]  (rank-sorted, ≤2)

   The whole notice model in one pure function. Test it directly; the renderer
   below only paints what this returns.
   --------------------------------------------------------------------------- */
export function hwbTabNotices(t = {}, now = Date.now()) {
  const out = [];
  const b = t.badge;

  if (b && b.kind && b.kind !== 'ok') {
    const count = hwbNoteCountdown(b.expiresAt, now);
    /* ESCALATION IS ARITHMETIC, NOT INVENTION. A 'warn' whose own expiresAt has
       passed is cold — that conclusion comes from the number the tool published,
       not from the client deciding something about the tool. Leaving an amber
       badge reading "0m" on a dead credential is the exact failure the owner asked us
       to fix. An engine that does not want this either publishes kind:'cold'
       itself or publishes expiresAt:null. */
    const kind = (count === 'EXPIRED' || b.kind === 'cold') ? 'cold' : 'warn';
    /* `short` is the tab-sized token; `text` is the sentence, and the sentence
       goes to the tooltip where it fits. A countdown outranks both — it is the
       only one of the three that is true at the moment you read it. */
    const short = (typeof b.short === 'string' && b.short.length <= 8) ? b.short : null;
    out.push({
      cls: kind === 'cold' ? 'n-cold' : 'n-warn',
      rank: HWB_NOTE_RANK[kind],
      text: count || short || '',
      title: b.text || (kind === 'cold' ? 'expired' : 'expiring'),
    });
  }

  const n = t.items && Number(t.items.count);
  if (Number.isFinite(n) && n > 0) {
    out.push({
      cls: 'n-items', rank: HWB_NOTE_RANK.items,
      text: n > 99 ? '99+' : String(n),
      title: `${n} item${n === 1 ? '' : 's'} waiting to be copied`,
    });
  }

  return out.sort((a, b2) => b2.rank - a.rank);
}

/** The rail's markup. The LEAD keeps its text; anything behind it collapses,
 *  because two full pills beside a name is the mess this component was asked
 *  not to become. Width tiers in CSS may collapse the lead as well. */
export function hwbNotesHTML(t = {}, now = Date.now()) {
  const notes = hwbTabNotices(t, now);
  if (!notes.length) return '';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = notes.map((n, i) => {
    const dot = (i > 0 || !n.text) ? ' is-dot' : '';
    return `<span class="hwb-note ${n.cls}${dot}" title="${esc(n.title)}" role="status"
      aria-label="${esc(n.title)}"><span class="nt">${esc(n.text)}</span></span>`;
  }).join('');
  return `<span class="hwb-notes">${html}</span>`;
}

/* ---------------------------------------------------------------------------
   hwbNoticeClock(root, tabs, opts) -> stop()

   Re-renders notice TEXT ONLY, in place, on a timer. It never touches state
   classes, never re-runs hwbRenderTabs, and never moves focus — a tab you are
   about to click must not be rebuilt under the pointer. 30s is the coarsest
   tick that still lands 'EXPIRED' promptly; the value it prints changes at most
   once a minute.
   --------------------------------------------------------------------------- */
export function hwbNoticeClock(root, tabs, { intervalMs = 30000 } = {}) {
  const tick = () => {
    const now = Date.now();
    for (const t of tabs) {
      const el = root.querySelector(`.hwb-tab[data-tab="${CSS.escape(String(t.id))}"] .hwb-notes`);
      if (!el) continue;
      const next = hwbNotesHTML(t, now);
      const inner = next ? next.replace(/^<span class="hwb-notes">|<\/span>$/g, '') : '';
      if (el.innerHTML !== inner) el.innerHTML = inner;
    }
  };
  tick();
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}

/** The user's color. Everything else derives from it in CSS — do not compute
 *  bar/title/seam/terminal colors yourself. Persist the hex; recompute nothing. */
export function hwbSetBase(root, hex) {
  root.style.setProperty('--base', hex);
}

/** The engine's one call. `data-state` alone drives motion, so a host that sets
 *  only this still gets correct behavior — fail-visible, not fail-silent. */
export function hwbSetState(root, state) {
  state = hwbNormState(state);
  if (!HWB_STATES.has(state)) throw new Error(`unknown hwb state: ${state}`);
  root.dataset.state = state;
  HWB_RANK.forEach(s => root.classList.remove('st-' + s));
  root.classList.add('st-' + state);
  const pip = root.querySelector(':scope > .hwb-bar > .hwb-act > .hwb-pip');
  if (pip) pip.className = 'hwb-pip st-' + state;
}

/** ok|fail — only meaningful with state 'ended'; drives the verdict seam. */
export function hwbSetExit(root, verdict) { root.dataset.exit = verdict; }

/** Amplitude only. If tool-wide election is not implemented yet, self-elect:
 *  two windows both pulsing is designed behavior, not a bug. */
export function hwbSetLead(root, isLead) { root.classList.toggle('is-lead', !!isLead); }

/** Focus. MUST NOT stop animations — unfocused is exactly when the user needs
 *  to know where to look. The CSS only dims the identity channel. */
export function hwbSetFocused(root, focused) { root.classList.toggle('is-unfocused', !focused); }

export function hwbSetWindowState(root, state, inset = 0) {
  root.dataset.windowState = state;
  root.style.setProperty('--hwb-max-inset', (state === 'maximized' ? inset : 0) + 'px');
}

/** priority-MAX across a set of states. Used for a tabbed window's tier 1 and
 *  for the Manager's aggregate. */
export function hwbAggregate(states) {
  return HWB_RANK.find(r => states.includes(r)) || 'idle';
}

/* ---------------------------------------------------------------- tabs ---- */
/**
 * Render the tab row. THIS IS THE LAYOUT — copy it rather than rebuilding it.
 *
 * @param {HTMLElement} root  the .hwb element
 * @param {Object}   opts
 * @param {Array}    opts.tabs   [{ id, name, base, state, logo, active }]
 *                               `logo` is an SVG string from LOGO_PRESETS
 *                               (web/vendor/aurora-logo-presets.js).
 * @param {string}   opts.hubMark  SVG for the Manager chip (no project logo —
 *                               it is not a session)
 * @param {number}   opts.liveCount  sessions the Manager holds (NOT blocked count)
 * @param {Function} opts.onClose  (id) => void
 * @param {Function} opts.onSelect (id) => void
 * @param {Function} opts.onNew    () => void   — MUST bring the single CLI
 *                               Manager to the front. It does not create a
 *                               session and must never spawn a second Manager.
 * @param {Object}   [opts.room] LEVEL 2 — inside a workroom (v24; ruled row
 *                               workroom-nav-v2: ‹ back · folder chat · lead · agents · A2).
 *                               { name, chat: {id, active}, onBack(), onAdd() }
 *                               With `room`: the hub chip becomes the ‹ back control,
 *                               the F1 folder-chat tab (manila, no ring) leads the
 *                               row and selects through onSelect(chat.id), and the
 *                               `+` becomes A2 (add an agent). tabs[] are the members,
 *                               in the caller's order — put the lead first and mark it
 *                               `primary: true` (B5). Each member keeps its OWN state
 *                               (A4): no aggregate is drawn at this level.
 *                               Without `room` the output is unchanged.
 */
export function hwbRenderTabs(root, opts) {
  /* tabs[]: { id, name, base, state, logo, logoStyle? ({line, backlit}, v32), active, attached?,
              mode?: 'light'|'dark'   // v34: the room's own Dark/Light override; omit = follow the shell (html[data-mode])
     opts.hubName?: string                 // v35: the home tab's name, default 'Workbench'
              badge?: {kind,text,short?,expiresAt?},   // A — tool-published status
              items?: {count} }                        // B — copyable fields waiting
     opts:   { glyph?: 'ring'|'pip' } */
  const { tabs, hubMark, liveCount, onClose, onSelect, onNew } = opts;
  /* v35: the home tab's name (owner ruling 2026-10-06: the CLI Manager is now the Workbench); a consumer can still pass its own */
  const hubName = opts.hubName || 'Workbench';
  const room = opts.room || null;
  const strip = root.querySelector('.hwb-tabs');
  if (!strip) throw new Error('.hwb-tabs not found — is the root .is-tabbed?');

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const hub = room ? `<button class="hwb-roomback" title="${HWB_TIPS.roomBack}" aria-label="${HWB_TIPS.roomBack}"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button><span class="hwb-roomdiv" aria-hidden="true"></span>`
    : `<div class="hwb-tab is-hub" title="${esc(hubName)} — ${liveCount} live session${liveCount === 1 ? '' : 's'}">
      <span class="tlogo">${hubMark}</span>
      <span class="tname">${esc(hubName)}</span>
      <span class="tcount">${liveCount}</span>
    </div>`;

  /* THE STATE GLYPH IS THE RING (v20, ruling D). `glyph:'pip'` restores the old
     8x2 bar / dot / hollow square for a consumer that needs a beat to migrate;
     it is deprecated and will not gain features. The ring is viewer-less on a
     tab on purpose — a tab is the window YOU are looking at, so "who is
     watching" is not a question it has to answer, and hwbRingNormalise enforces
     that rather than trusting the caller. */
  const useRing = (opts.glyph ?? 'ring') !== 'pip';
  /* v25: state 'none' = a never-started seat — plate only, no ring (see hwbRing) */
  const unstarted = tabs.map(t => t.state === 'none' && !!t.brand && t.kind !== 'workroom');
  tabs.forEach(t => { t.state = hwbNormState(t.state); });
  const specs = tabs.map(t => hwbRingFromChrome(t.state, { attached: t.attached !== false, exit: t.exit }));

  const chips = tabs.map((t, i) => {
    const tip = `${t.name} — ${unstarted[i] ? 'not started' : hwbRingLabel(specs[i]).split(',')[0]}`;
    const glyph = useRing ? '<span class="ring"></span>'
                          : `<span class="hwb-pip st-${t.state}"></span>`;
    /* v21: the brand's designed hue reaches the plate through --brand-src; the
       project mark is the tab WATERMARK (.tlogo, unselected tabs only). */
    const brandStyle = t.brandColor ? `;--brand-src:${esc(t.brandColor)}` : '';
    return `
    <div class="hwb-tab${t.active ? ' is-active' : ''} st-${t.state}"
         style="--base:${esc(t.base)}${brandStyle}" data-tab="${esc(t.id)}"${t.mode === 'light' || t.mode === 'dark' ? ` data-mode="${t.mode}"` : ''} title="${esc(tip)}">
      ${glyph}
      <span class="tname">${esc(t.name)}</span>
      ${hwbNotesHTML(t)}
      <button class="trefresh" data-refresh="${esc(t.id)}" title="${HWB_TIPS.refresh}" aria-label="${HWB_TIPS.refresh}"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/></svg></button>
      <button class="tclose" data-close="${esc(t.id)}" title="${HWB_TIPS.close}" aria-label="${HWB_TIPS.close}"><svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8"/></svg></button>
      <span class="tlogo${hwbMarkClass(t.logoStyle)}" aria-hidden="true">${t.logo || ''}</span>
    </div>`;
  }).join('');

  /* F1 — the folder-chat tab: the room itself, manila, a folder with NO ring (it is
     not an agent and has no state of its own at this level). */
  const chat = room ? (() => {
    const c = room.chat || {}, nm = c.name || room.name || 'Room';
    return `
    <div class="hwb-tab is-room${c.active ? ' is-active' : ''}" data-tab="${esc(c.id ?? 'room')}" title="${esc(nm)} — ${HWB_TIPS.roomChat}">
      <span class="hwb-fglyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path class="fb" d="${HWB_WR_FOLDER}"/><path class="fe" d="${HWB_WR_EAR}"/></svg></span>
      <span class="tname">${esc(nm)}</span>
    </div>`; })() : '';

  const plus = room
    ? `<button class="hwb-newtab hwb-roomadd" title="${HWB_TIPS.roomAdd}" aria-label="${HWB_TIPS.roomAdd}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg></button>`
    : `<button class="hwb-newtab" title="Bring the ${esc(hubName)} to the front" aria-label="New session">+</button>`;

  /* OVERFLOW. Tabs stop shrinking at min-width:96px, so past a certain
     count they overflow and `overflow:hidden` simply ate them — a tab you cannot
     reach is a session you cannot get back to.

     The hub and the `+` are pinned OUTSIDE the scroller because they are
     controls, not content: "manager" and "new" must stay hittable no matter how
     far the strip is scrolled. Only the session chips scroll.

     The chevrons are absolutely positioned OVER the scroller's ends rather than
     laid out beside it, so they consume no flex width — which is what keeps the
     154px drag reserve and the caption geometry untouched by overflow. */
  const chev = d => `<button class="hwb-chev at-${d}" data-scroll="${d}" tabindex="-1"
      aria-label="Scroll tabs ${d === 'start' ? 'left' : 'right'}"><svg viewBox="0 0 10 10">
      <path d="${d === 'start' ? 'M6.5 1.5L3 5l3.5 3.5' : 'M3.5 1.5L7 5l-3.5 3.5'}"/></svg></button>`;

  strip.innerHTML = hub
    + `<div class="hwb-scrollwrap">${chev('start')}<div class="hwb-scroll">${chat}${chips}</div>${chev('end')}</div>`
    + plus;

  /* Paint the glyphs and apply the AGGREGATE MOTION RULE. The tab strip is an
     aggregate surface exactly like the manager list, so it takes the rule the
     ring already ships: exactly one glyph animates. Before this, five waiting
     tabs demand-flashed five times over — and a demand that is permanently on
     the screen somewhere is a demand nobody reads. .is-lead lands on the ring
     AND on its tab, so the tab's own background animation obeys the same rule
     (see the .ctx-aggregate selector in the CSS). */
  if (useRing) {
    const chipEls = [...strip.querySelectorAll('.hwb-tab[data-tab]:not(.is-room)')];
    const glyphs = chipEls.map((el, i) => {
      const t = tabs[i];
      /* a workroom glyph ONLY for a workroom row; with no workroom rows nothing
         workroom-specific renders (workroom data is not built yet) */
      const o = t.kind === 'workroom' ? { workroom: true }
              : t.brand ? { brand: t.brand, markPath: t.markPath || opts.brandMarkPath?.(t.brand), primary: !!t.primary } : {};
      return hwbRing(el.querySelector('.ring'), unstarted[i] ? null : specs[i], 28, o);
    });
    const lead = hwbRingApplyContext(strip, glyphs, specs);
    chipEls.forEach((el, i) => el.classList.toggle('is-lead', i === lead));
  }

  // the rail carries the ACTIVE tab's accent
  const active = tabs.find(t => t.active) || tabs[0];
  if (active) root.style.setProperty('--rail-base', active.base);

  // tier 1 shows the AGGREGATE, never the active tab's state
  hwbSetState(root, hwbAggregate(tabs.map(t => t.state)));

  // the count chip is BLOCKED tabs, scoped to this window; only shown at N>1.
  // Do not confuse it with the hub's live-session count above.
  const blocked = tabs.filter(t => t.state === 'waiting' || t.state === 'waiting-seen').length; // v33: seen is still blocked
  // D3 FIX: .hwb-agg must sit in the BAR, not inside .hwb-title — the title is
  // display:none while tabbed, which hid the number exactly when it mattered.
  const agg = root.querySelector('.hwb-bar > .hwb-agg') || root.querySelector('.hwb-agg');
  if (agg) agg.textContent = blocked > 1 ? blocked + ' blocked' : '';

  /* 1d: the tab's ✕ opens the close-or-end popover; the popover calls back */
  strip.querySelectorAll('.tclose').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation();
      hwbClosePopover(root, b, b.dataset.close, { onClose, onEndSession: opts.onEndSession }); }));
  strip.querySelectorAll('.trefresh').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation();
      opts.onRefresh?.(b.dataset.refresh);
      root.dispatchEvent(new CustomEvent('hwb:refresh', { bubbles: true, detail: { id: b.dataset.refresh } })); }));
  strip.querySelectorAll('.hwb-tab[data-tab]').forEach(el =>
    el.addEventListener('click', () => onSelect?.(el.dataset.tab)));
  if (room) {
    strip.querySelector('.hwb-roomback')?.addEventListener('click', () => room.onBack?.());
    strip.querySelector('.hwb-roomadd')?.addEventListener('click', () => room.onAdd?.());
  } else {
    strip.querySelector('.hwb-newtab')?.addEventListener('click', () => onNew?.());
  }

  const scroller = strip.querySelector('.hwb-scroll');
  if (scroller) {
    strip.querySelectorAll('.hwb-chev').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      // 80%, not 100% — a full-width jump loses the reader's place. One tab
      // stays visible across the step so the strip reads as continuous.
      const step = scroller.clientWidth * 0.8;
      scroller.scrollBy({ left: b.dataset.scroll === 'start' ? -step : step, behavior: 'smooth' });
    }));
    scroller.addEventListener('scroll', () => hwbUpdateOverflow(root), { passive: true });
    /* The component observes its OWN width rather than asking the host to call
       hwbUpdateOverflow on resize. A widening window removes overflow without
       firing a scroll event, so the host-obligation version left a chevron lit
       with nowhere to go — and a control that lies is worse than no control.
       Upkeep a consumer can forget is not upkeep. (Caught by the harness at a
       620px viewport before this shipped.) */
    if (typeof ResizeObserver !== 'undefined') {
      root._hwbRO?.disconnect();
      root._hwbRO = new ResizeObserver(() => hwbUpdateOverflow(root));
      root._hwbRO.observe(scroller);
    }
    // selecting a tab you cannot see is possible (hub, keyboard, host); bring it back
    scroller.querySelector('.hwb-tab.is-active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    hwbUpdateOverflow(root);
    scroller.addEventListener('scroll', () => hwbPositionBarWash(root), { passive: true });
  }
  hwbPositionBarWash(root);
  if (typeof ResizeObserver !== 'undefined') {
    root._hwbWashRO?.disconnect();
    root._hwbWashRO = new ResizeObserver(() => hwbPositionBarWash(root));
    root._hwbWashRO.observe(root);
  }
}

/* ============================================================================
   v21 — tooltips, the bar wash, the session bar, the 1d close popover.
   ============================================================================ */

/** Every icon names what it does, and what it does NOT do where that matters
 *  (ruled 2026-09-19). Wording for the bar icons is the host app's. */
export const HWB_TIPS = {
  refresh:  "Refresh this view (doesn't restart the agent)",
  close:    'Close tab — the session keeps running (3s to end it instead)',
  messages: 'Messages from other agents',
  handoff:  'Values the agent handed you — copy them here',
  links:    'Links the agent offered you to open',
  newWorkroom: 'New workroom — an empty room; add agents inside it',
  roomBack:  'Back to all tabs — the room keeps running',
  roomChat:  'the room: chat with the whole workroom',
  roomAdd:   'Add an agent to this workroom',
};

/** P3 — the new-workroom control (ruled 2026-09-19, workroom-nav-v1): an
 *  OUTLINED folder with a + in the body, in the ink color. Deliberately not the
 *  manila WR1-B plate and no ring, so it reads as a button, never as a workroom.
 *  Size and color come from the consumer's context (currentColor, 1em box). */
export const HWB_NEW_WORKROOM_SVG =
  '<svg class="hwb-ico-newroom" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M2.5 6.5A1.5 1.5 0 0 1 4 5h5l2 2.2h9A1.5 1.5 0 0 1 21.5 8.7v9.8A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5Z"/>' +
  '<path d="M12 10.5v6M9 13.5h6"/></svg>';

/** The P3 glyph as a ready button, carrying the ruled tooltip. */
export function hwbNewWorkroomButton(label = '') {
  return `<button type="button" class="hwb-newroom" title="${HWB_TIPS.newWorkroom}" aria-label="${HWB_TIPS.newWorkroom}">${HWB_NEW_WORKROOM_SVG}${label ? `<span>${label}</span>` : ''}</button>`;
}

/** Keep the session bar's wash centered on the SELECTED tab. Measured against
 *  the window with getBoundingClientRect — offsetLeft is relative to the
 *  offsetParent (the page), which is exactly the bug that broke the v7 mockup. */
export function hwbPositionBarWash(root) {
  const on = root.querySelector('.hwb-tab.is-active:not(.is-hub)');
  if (!on) return null;
  const t = on.getBoundingClientRect(), w = root.getBoundingClientRect();
  const x = t.left - w.left + t.width / 2, core = t.width / 2;
  root.style.setProperty('--bar-wash-x', `${x}px`);
  root.style.setProperty('--bar-wash-core', `${core}px`);
  return { x, core };
}

const SB_ICONS = {
  /* messages: two speech bubbles — words from someone else */
  messages: '<path d="M4 5h11a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 15 14H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 12.5v-6A1.5 1.5 0 0 1 4 5Z"/><path d="M19 9h1a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 20 18h-1v3l-3.5-3H11"/>',
  /* handoff: a tray with an arrow coming down into it — "something handed to you" */
  handoff:  '<path d="M12 3v10"/><path d="M8 9.5l4 4 4-4"/><path d="M3.5 14.5v4A1.5 1.5 0 0 0 5 20h14a1.5 1.5 0 0 0 1.5-1.5v-4"/><path d="M3.5 14.5h5l1 2h5l1-2h5"/>',
  /* links: open in a new window — a URL to go to */
  links:    '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
};

/**
 * Render the session bar (.hwb-sbar) for the ACTIVE session.
 * @param {HTMLElement} bar  the .hwb-sbar element (inside .hwb)
 * @param {Object} s  { project: {name, mark (svg), color, markStyle: {line, backlit} (v32)}, title,
 *                      brand, brandColor, brandMarkPath,
 *                      messages (unread count), handoff (count), links (count) }
 * Emits hwb:messages / hwb:handoff / hwb:links on the bar (bubbling).
 */
/* v32 (owner ruling 2026-09-28): art used as a WATERMARK draws with the art's own style, the way the
   pane watermark does. `style` is the art library's {line, backlit} (the same blob the recipe
   logo carries); classes come from hwb-watermark.css (imported by hwb-chrome.css). */
const HWB_MARK_LINES = new Set(['outline', 'blueprint', 'hatch', 'engrave', 'halftone']);
export function hwbMarkClass(style) {
  const s = style || {};
  return (HWB_MARK_LINES.has(s.line) ? ` wm-line-${s.line}` : '') + (s.backlit ? ' wm-backlit' : '');
}

export function hwbRenderSessionBar(bar, s = {}) {
  if (!bar) return bar;
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const p = s.project || {};
  if (p.color) bar.style.setProperty('--pc', p.color); else bar.style.removeProperty('--pc');
  if (s.brandColor) bar.style.setProperty('--brand-src', s.brandColor); else bar.style.removeProperty('--brand-src');
  /* v34: the bar takes the SELECTED tab's mode (its room's override), so the S10 join holds; omit = the shell's */
  if (s.mode === 'light' || s.mode === 'dark') bar.dataset.mode = s.mode; else delete bar.dataset.mode;
  const icon = (k, n) => `<button class="sb-ib${n ? '' : ' is-empty'}" data-sb="${k}" title="${HWB_TIPS[k]}" aria-label="${HWB_TIPS[k]}${n ? ` (${n})` : ''}"><svg viewBox="0 0 24 24">${SB_ICONS[k]}</svg>${k === 'messages' && n ? `<span class="sb-cnt">${n}</span>` : ''}</button>`;
  const mcp = bar.querySelector(':scope > .hwb-mcp');   // v27: the MCP indicator survives a re-render
  bar.innerHTML = `
    <span class="sb-mark${hwbMarkClass(p.markStyle)}" aria-hidden="true">${p.mark || ''}</span>
    <span class="sb-title"><span class="sb-proj">${esc(p.name)}</span><span class="sb-sess">${esc(s.title)}</span></span>
    <span class="sb-sp"></span>
    <span class="sb-wm" aria-hidden="true">${s.brandMarkPath ? `<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="${s.brandMarkPath}"/></svg>` : ''}</span>
    ${icon('messages', s.messages)}${icon('handoff', s.handoff)}${icon('links', s.links)}`;
  if (mcp) bar.querySelector(':scope > .sb-sp').replaceWith(mcp);
  bar.querySelectorAll('.sb-ib').forEach(b => b.addEventListener('click', () =>
    bar.dispatchEvent(new CustomEvent(`hwb:${b.dataset.sb}`, { bubbles: true }))));
  return bar;
}

/**
 * 1d — the close-or-end popover. Opens directly under the tab's ✕.
 *   timeout (3s) / Escape / click elsewhere → onClose(id, reason) + hwb:close-view
 *   End session                             → onEndSession(id) + hwb:end-session
 * The bundle never ends a session on its own. End session never takes focus.
 */
export function hwbClosePopover(root, anchor, id, { onClose, onEndSession, ms = 3000 } = {}) {
  /* re-activating the SAME ✕ (a second click, or Enter on the focused button)
     leaves the open popover alone; a different tab's ✕ counts as a click
     elsewhere for the first one */
  const open = document.querySelector('.hwb-closepop');
  if (open && open._hwbId === id) return open;
  open?._hwbDismiss?.();
  const pop = document.createElement('div');
  pop.className = 'hwb-closepop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Close tab');
  pop.style.setProperty('--hwb-cp-t', `${ms}ms`);
  pop.innerHTML = `<button class="cp-end" tabindex="-1">End session</button>
    <div class="cp-msg"><span><b>Closing tab</b> — session keeps running</span><span class="cp-secs">${Math.round(ms / 1000)}</span></div>
    <div class="cp-hint">Esc or click away: close the tab now</div><div class="cp-meter"></div>`;
  document.body.appendChild(pop);
  const a = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(4, a.right - pop.offsetWidth + 4)}px`;
  pop.style.top = `${a.bottom + 7}px`;

  let done = false, n = Math.round(ms / 1000);
  const tick = setInterval(() => { n -= 1; const el = pop.querySelector('.cp-secs'); if (el) el.textContent = Math.max(n, 0); }, 1000);
  const finish = (kind, reason) => {
    if (done) return; done = true;
    clearTimeout(timer); clearInterval(tick);
    removeEventListener('keydown', onKey, true); removeEventListener('pointerdown', onAway, true);
    pop.remove();
    if (kind === 'end') {
      onEndSession?.(id);
      root.dispatchEvent(new CustomEvent('hwb:end-session', { bubbles: true, detail: { id } }));
    } else {
      onClose?.(id, reason);
      root.dispatchEvent(new CustomEvent('hwb:close-view', { bubbles: true, detail: { id, reason } }));
    }
  };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); finish('close', 'escape'); } };
  const onAway = e => { if (!pop.contains(e.target)) finish('close', 'away'); };
  const timer = setTimeout(() => finish('close', 'timeout'), ms);
  pop.querySelector('.cp-end').addEventListener('click', e => { e.stopPropagation(); finish('end'); });
  /* listen at once: the opening click's pointerdown has already fired, and a
     fast Escape straight after the click must still close (v21.1) */
  addEventListener('keydown', onKey, true); addEventListener('pointerdown', onAway, true);
  pop._hwbDismiss = () => finish('close', 'away');
  pop._hwbId = id;
  return pop;
}

/* ---------------------------------------------------------------------------
   hwbUpdateOverflow(root) — show a chevron only where there is somewhere to go.
   Called on render and on scroll; the HOST must also call it on resize, since
   a widening window can make the overflow disappear without any scroll event.
   --------------------------------------------------------------------------- */
export function hwbUpdateOverflow(root) {
  const wrap = root.querySelector('.hwb-scrollwrap');
  const sc = root.querySelector('.hwb-scroll');
  if (!wrap || !sc) return { start: false, end: false };
  // 1px slack: fractional scroll widths at fractional DPI otherwise leave a
  // chevron permanently lit at a hard end, which reads as a broken control.
  const start = sc.scrollLeft > 1;
  const end = sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1;
  wrap.classList.toggle('can-start', start);
  wrap.classList.toggle('can-end', end);
  return { start, end };
}

/* ------------------------------------------------------- host <-> page ---- */
/** Rects for WM_NCHITTEST. Round the cluster origin ONCE then derive the
 *  boundaries cumulatively — never (rounded total)/3, which opens a 1px dead
 *  seam at 125% and 175%. */
export function hwbCaptionRects(root, dpr = window.devicePixelRatio || 1) {
  const q = k => root.querySelector(`.hwb-caps [data-cap="${k}"]`).getBoundingClientRect();
  const cluster = root.querySelector('[data-region="caption-cluster"]').getBoundingClientRect();
  const x0 = Math.round(cluster.x * dpr);
  const b = [x0, Math.round(x0 + 46 * dpr), Math.round(x0 + 92 * dpr), Math.round(x0 + 138 * dpr)];
  return {
    cssPx: { minimize: q('minimize'), maximize: q('maximize'), close: q('close') },
    physicalBoundaries: b,
    top: Math.round(cluster.y * dpr),
    height: Math.round(cluster.height * dpr)
  };
}

/** The invariant to assert in CI. The v1 equality (=== W-138) is RETIRED now
 *  that tabs live in tier 1; this is its replacement. */
export function hwbAssertInvariants(root) {
  const bar = root.querySelector('.hwb-bar').getBoundingClientRect();
  const max = root.querySelector('.hwb-caps [data-cap="maximize"]').getBoundingClientRect();
  const dead = root.querySelector('.hwb-dead').getBoundingClientRect();
  const errs = [];
  if (Math.round(max.x - bar.x) !== Math.round(bar.width) - 92)
    errs.push(`maxRect.x must be W-92, got ${Math.round(max.x - bar.x)} of W=${Math.round(bar.width)}`);
  // D5 FIX: the 154px reserve is a TABBED rule; a solo window falls back to
  // min-width:60px and was failing an assert while behaving exactly as specced.
  if (root.classList.contains('is-tabbed') && Math.round(dead.width) < 154)
    errs.push(`drag reserve must be >=154 while tabbed, got ${Math.round(dead.width)}`);
  return errs;
}
