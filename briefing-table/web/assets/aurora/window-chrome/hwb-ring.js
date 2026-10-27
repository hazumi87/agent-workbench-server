/* ===========================================================================
   hwb-ring.js — DUAL-RING SESSION STATUS renderer
   Part of the window-chrome bundle. Pairs with hwb-ring.css.

   Design record: the design record.
   Engine model:  the design record (the host app).

   The engine sends:
       { session: 'active-streaming',
         viewer:  { device: 'laptop', presence: 'active' } | null }

   hwbRingSpec() turns that into the DOM contract, ENFORCING the rules rather
   than trusting upstream. hwbRing() paints it. hwbRingApplyContext() applies
   the motion context rule to a group.

   Everything here is additive to the window-chrome API. A consumer that never
   imports this file is unaffected.
   =========================================================================== */

const SVG = 'http://www.w3.org/2000/svg';
const R = 9;                                   // ring radius, viewBox units

export const HWB_RING_STATES = [
  'active-idle', 'active-background', 'active-streaming', 'attention', 'attention-seen', 'alert', 'restorable', 'ended'
];

export const HWB_DEVICES = ['vrpc', 'laptop', 'phone', 'console'];

/* Priority for aggregate glyphs. LOWER IS LOUDER.

   NOTE THE TOP TWO — this deviates from the engine brief, deliberately, and the
   deviation is the owner's decision (the design record §2). `alert` is a transport
   or host fault: frequently transient, very often self-healing. `attention` is
   a hard block only a human can clear, and it never resolves itself. With alert
   on top, the loudest slot in the UI spends its time showing conditions that fix
   themselves and the user learns to discount it — the one failure an escalation
   system cannot survive. */
export const HWB_RING_RANK = {
  attention: 0, alert: 1, 'attention-seen': 2, 'active-streaming': 3, 'active-background': 4,
  'active-idle': 5, restorable: 6, ended: 7
};
/* v33: attention-seen = blocked on a human who has SEEN it but not answered.
   Still a block (it never clears itself), so it outranks all work; but the human
   already knows, so an UNSEEN block and a transport fault both outrank it. */
/* v21: active-background (AB·B, ruled 2026-09-19) ranks between streaming and
   idle — background work outranks a quiet session for the lead glyph, but
   never outranks the agent itself working. */

/* Presence modulates priority WITHIN an equal state: "needs a human and nobody
   is there" outranks "needs a human and someone is looking at it". Kept from
   the engine brief — it is the sharpest idea in the model. */
export const HWB_PRESENCE_RANK = { parked: 0, away: 1, active: 2 };

/* These two states have no live PTY, so they can have no viewer, ever. */
const VIEWERLESS = new Set(['restorable', 'ended']);

/* ===========================================================================
   v21 — THE BRAND PLATE (treatment 16) AND THE WORKROOM PLATE (WR1-B)

   The viewer dot is gone from every ring (ruled 2026-09-18): the glyph is
   STATE (the ring) + BRAND (the plate and logo). A plate is drawn only when a
   brand or `workroom` is passed; without one the glyph is the v20 ring, so
   existing consumers are unaffected.
   =========================================================================== */
export const HWB_BRAND_PLATES = {
  codex:   '<polygon class="rg-plate" points="12,1 21.5,6.5 21.5,17.5 12,23 2.5,17.5 2.5,6.5"/>',
  claude:  '<circle class="rg-plate" cx="12" cy="12" r="11"/>',
  gemini:  '<rect class="rg-plate" x="1" y="1" width="22" height="22" rx="5"/>',
  generic: '<rect class="rg-plate" x="1" y="1" width="22" height="22" rx="5"/>',
};
export const HWB_WR_FOLDER = 'M.6 5.2A1.8 1.8 0 0 1 2.4 3.4H9.3l2.3 2.5h10A1.8 1.8 0 0 1 23.4 7.7v12.6a1.8 1.8 0 0 1-1.8 1.8H2.4A1.8 1.8 0 0 1 .6 20.3Z';
export const HWB_WR_EAR    = 'M.6 5.9V5.2A1.8 1.8 0 0 1 2.4 3.4H9.3l2.3 2.5Z';

/* ===========================================================================
   THE ALIAS TABLE — chrome vocabulary -> engine vocabulary.

   Three vocabularies grew independently: the desktop host's shipped chrome,
   the host app's brief (which the ring implements), and the host app's
   production /api/table. The engine's wins — it has an architecture document
   behind it — and this map is shipped as CODE rather than prose so the bridge
   implements nothing and cannot drift from it.

   Five rows are mechanical renames. One is a design call, below.
   =========================================================================== */
export const HWB_CHROME_ALIAS = {
  streaming:    'active-streaming',
  busy:         'active-streaming', // v21: the engine's three-way signal
  background:   'active-background',
  idle:         'active-idle',
  waiting:      'attention',      // "blocked on the user" — same fact, better name
  'waiting-seen': 'attention-seen', // v33: blocked on the user, who has seen it (acked, unanswered)
  disconnected: 'alert',
  ended:        'ended',
  restorable:   'restorable',     // v26: same word in both vocabularies
  watching:     'active-idle',    // <- the design call; see below
};

/* `watching` — the one with no obvious image, so here is the reasoning rather
   than just the row.

   A watcher is armed: something MAY happen, nothing is happening now. That sits
   between idle and streaming, and the temptation is a seventh engine state.

   It should not be one. The ring answers "what is the state of this session and
   what can I do about it" — and for watcher-wait the answer is: nothing, it is
   alive, something may happen. That IS active-idle. "A watcher is armed" is
   INFORMATIONAL, not actionable, and the design system's rule is that color encodes
   function. Mapping it to active-streaming would be worse: the streaming ring
   says output is flowing, which would be a lie, and a lying status glyph costs
   more than a missing nuance.

   So the engine vocabulary stays at SIX and the distinction moves down a layer.
   The chrome does not have to lose the affordance it shipped: keep the pip
   spinner as a MODIFIER on the chrome layer (`data-watch="armed"`), which
   decorates without claiming a state. The ring never shows it, because a
   manager list summarising twenty sessions has no use for it.

   `restorable` has NO chrome analogue and must be added rather than aliased —
   it is genuinely new information (dehydrated, one click back). */

/* Chrome states carry an exit verdict; the engine's `ended` does not encode it.
   An ended session that FAILED is history you may want to look at, so the ring
   keeps a trace of it — quiet, but not identical to a clean exit. */
export const HWB_EXIT = ['ok', 'fail'];

/* ---------------------------------------------------------------------------
   hwbRingSpec(payload) -> { state, viewer, presence }

   The enforcement layer. Do not skip it and set attributes by hand: a center
   dot on an ended session asserts something that cannot be true, and the
   engine is not the right place to be trusted about that.
   --------------------------------------------------------------------------- */
export function hwbRingSpec(payload = {}) {
  const state = HWB_RING_STATES.includes(payload.session) ? payload.session : 'ended';
  const v = payload.viewer;

  // viewer:null IS parked — parked is a property of having no viewer, which is
  // why the engine's two presence values map to three here.
  if (!v) return { state, viewer: null, presence: 'parked' };

  const device = HWB_DEVICES.includes(v.device) ? v.device : null;
  const presence = v.presence === 'away' ? 'away' : 'active';
  return hwbRingNormalise({ state, viewer: device, presence });
}

/* ---------------------------------------------------------------------------
   hwbRingFromChrome(chromeState, opts) -> spec

   The bridge entry point. Call this instead of implementing HWB_CHROME_ALIAS —
   an alias table copied into two codebases is two alias tables.

     hwbRingFromChrome('waiting', { attached: true })
       -> { state:'attention', viewer:null, presence:'active' }

   `attached` is the host app's production boolean: it says SOMEONE is there
   without saying which device. That renders a neutral filled center — honest,
   and it gains device hue with no visual rework when a viewer registry lands.
   Pass `viewer` instead once you have one.
   --------------------------------------------------------------------------- */
export function hwbRingFromChrome(chromeState, opts = {}) {
  const state = HWB_CHROME_ALIAS[chromeState]
    || (HWB_RING_STATES.includes(chromeState) ? chromeState : 'ended');
  const spec = opts.viewer
    ? hwbRingSpec({ session: state, viewer: opts.viewer })
    : hwbRingNormalise({ state, viewer: null, presence: opts.attached ? 'active' : 'parked' });
  if (state === 'ended' && opts.exit === 'fail') spec.exit = 'fail';
  return spec;
}

/* ---------------------------------------------------------------------------
   hwbRingNormalise(spec) — the viewer-less rule, applied on EVERY path.

   v16 ran this inside hwbRingSpec() only, so a caller passing a ready-made
   spec straight to hwbRing() bypassed it and could render an ended session
   with a live viewer — an assertion that cannot be true. That path is not
   hypothetical: it is exactly the entry point a consumer uses to render
   "someone is attached, device not known yet" before a viewer registry ships.
   Enforcement that a legitimate caller routes around is not enforcement.
   --------------------------------------------------------------------------- */
export function hwbRingNormalise(spec = {}) {
  const state = HWB_RING_STATES.includes(spec.state) ? spec.state : 'ended';
  const exit = spec.exit === 'fail' && state === 'ended' ? 'fail' : undefined;
  if (VIEWERLESS.has(state)) return { state, viewer: null, presence: 'parked', exit };
  const presence = ['active', 'away', 'parked'].includes(spec.presence) ? spec.presence : 'parked';
  // a device with nobody home is not a device — parked has no viewer, ever
  const viewer = presence === 'parked' ? null
               : (HWB_DEVICES.includes(spec.viewer) ? spec.viewer : null);
  return { state, viewer, presence };
}

/* ---------------------------------------------------------------------------
   hwbRing(el, spec, size) — paint or update one glyph.
   Idempotent: safe to call on every state change; the SVG is built once.
   --------------------------------------------------------------------------- */
export function hwbRing(el, spec = {}, size, opts = {}) {
  if (!el) return el;
  el.classList.add('ring');

  /* the plate is part of the SVG's structure, so rebuild when it changes */
  const plateKey = opts.workroom ? 'workroom' : (opts.brand ? `brand:${opts.brand}` : '');
  if (el.firstElementChild && el.dataset.plate !== plateKey) el.textContent = '';
  if (!el.firstElementChild) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    let under = '', dy = 0;
    if (opts.workroom) {
      /* WR1-B: manila folder, darker ear, body darkening toward the bottom; the
         ring is centered on the folder body (dy 2) over a dark keyline */
      under = `<path class="rg-wbody" d="${HWB_WR_FOLDER}"/><path class="rg-wear" d="${HWB_WR_EAR}"/>`;
      dy = 2;
    } else if (opts.brand) {
      const key = HWB_BRAND_PLATES[opts.brand] ? opts.brand : 'generic';
      const path = opts.markPath || '';
      under = HWB_BRAND_PLATES[key] +
        (path ? `<g transform="translate(12 12) scale(.46) translate(-12 -12)"><path class="rg-logo" fill-rule="evenodd" d="${path}"/></g>` : '');
    }
    svg.innerHTML = under;
    const g = document.createElementNS(SVG, 'g');
    if (plateKey) g.setAttribute('class', 'rg-scale');
    if (dy) g.setAttribute('transform', `translate(0 ${dy})`);
    const circles = plateKey ? [['rg-keyline', R], ['rg-halo', R], ['rg-track', R], ['rg-sweep', R]]
                             : [['rg-halo', R], ['rg-track', R], ['rg-sweep', R], ['rg-dot', 3.4]];
    for (const [cls, r] of circles) {
      if (cls === 'rg-keyline' && !opts.workroom) continue;
      const c = document.createElementNS(SVG, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', 12); c.setAttribute('cy', 12); c.setAttribute('r', r);
      g.appendChild(c);
    }
    svg.appendChild(g);
    el.appendChild(svg);
    el.dataset.plate = plateKey;
  }
  el.classList.toggle('has-plate', !!plateKey);
  el.classList.toggle('is-workroom', !!opts.workroom);
  /* B5 — the primary (lead) agent: the brand plate's outline in old gold. Only a
     BRAND plate carries it; a workroom or bare ring has no plate edge to mark. */
  el.classList.toggle('is-primary', !!opts.primary && !!opts.brand && !opts.workroom);
  if (opts.brand) el.dataset.brand = opts.brand; else delete el.dataset.brand;

  /* PLATE-ONLY (v25) — a seat that has never started: identity without lifecycle.
     Ruled by the room-app team (the room-app plan §4.4, amended 2026-09-25): the brand plate in the
     ended dimming, NO ring ("a ring is lifecycle, and there is no lifecycle yet").
     Asked for with spec null or {state:'none'}; only meaningful with a brand plate.
     B5 still applies: the gold edge is the plate's stroke, which stays full strength. */
  const plateOnly = !!opts.brand && !opts.workroom && (spec === null || spec?.state === 'none');
  el.classList.toggle('is-plate-only', plateOnly);
  if (plateOnly) {
    el.dataset.state = 'none';
    delete el.dataset.presence; delete el.dataset.exit; delete el.dataset.viewer;
    if (size != null) el.style.setProperty('--s', typeof size === 'number' ? `${size}px` : size);
    if (!el.hasAttribute('role')) el.setAttribute('role', 'img');
    el.setAttribute('aria-label', (opts.label ? opts.label + ' — ' : '') + 'not started');
    return el;
  }

  const s = hwbRingNormalise(spec && spec.state ? spec : hwbRingSpec(spec || {}));
  el.dataset.state = s.state;
  el.dataset.presence = s.presence || 'parked';
  if (s.exit === 'fail' && s.state === 'ended') el.dataset.exit = 'fail';
  else delete el.dataset.exit;
  if (s.viewer && !plateKey) el.dataset.viewer = s.viewer; else delete el.dataset.viewer;
  if (size != null) el.style.setProperty('--s', typeof size === 'number' ? `${size}px` : size);

  if (!el.hasAttribute('role')) el.setAttribute('role', 'img');
  el.setAttribute('aria-label', (opts.label ? opts.label + ' — ' : '') + hwbRingLabel(s));
  return el;
}

/* ---------------------------------------------------------------------------
   hwbRingLabel(spec) — the text equivalent. Color, shape and motion all carry
   this glyph; none of the three reaches a screen reader.
   --------------------------------------------------------------------------- */
export function hwbRingLabel(spec = {}) {
  const S = {
    'active-idle': 'idle', 'active-background': 'background work', 'active-streaming': 'working', attention: 'needs attention', 'attention-seen': 'needs you, seen',
    alert: 'connection lost', restorable: 'restorable', ended: 'ended'
  };
  const base = (spec.state === 'ended' && spec.exit === 'fail') ? 'ended with an error'
             : (S[spec.state] || spec.state || 'unknown');
  if (spec.presence === 'parked') {
    return VIEWERLESS.has(spec.state) ? base : `${base}, nobody watching`;
  }
  const who = spec.viewer || 'a device';
  return spec.presence === 'away' ? `${base}, claimed by ${who} (away)` : `${base}, ${who} watching`;
}

/* ---------------------------------------------------------------------------
   hwbRingLead(specs) -> index of the §7 winner, or -1.

   Sorts over the PAIR (state, presence), not over state alone. An engine that
   sorts on state and then filters by presence produces the wrong lead glyph.
   --------------------------------------------------------------------------- */
export function hwbRingLead(specs = []) {
  let best = -1, bestKey = null;
  specs.forEach((s, i) => {
    if (!s) return;
    const key = [HWB_RING_RANK[s.state] ?? 99, HWB_PRESENCE_RANK[s.presence] ?? 99];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      bestKey = key; best = i;
    }
  });
  return best;
}

/* ---------------------------------------------------------------------------
   hwbRingAggregate(specs) -> spec for ONE glyph standing for many.

   An aggregate glyph shows presence, NEVER device: a chip standing for five
   sessions across three devices cannot name one device without lying. Usefully
   this also makes an aggregate visually distinguishable from a single-session
   glyph — a neutral core means "more than one thing behind this".
   --------------------------------------------------------------------------- */
export function hwbRingAggregate(specs = []) {
  const live = specs.filter(Boolean);
  if (!live.length) return { state: 'ended', viewer: null, presence: 'parked' };

  const lead = live[hwbRingLead(live)];
  // filled if ANY member has an active viewer; hollow if any is merely claimed;
  // absent only when every member is parked.
  const presence = live.some(s => s.presence === 'active') ? 'active'
                 : live.some(s => s.presence === 'away')   ? 'away'
                 : 'parked';
  return hwbRingNormalise({ state: lead.state, viewer: null, presence });
}

/* ---------------------------------------------------------------------------
   hwbRingApplyContext(container, glyphs, specs)

   The motion context rule. In an aggregate context only the highest-priority
   glyph animates — which is what makes alert's motion safe to keep, since the
   blinking wall is caused by glyph COUNT and not by any one state animating.
   Sets .ctx-aggregate on the container and .is-lead on EXACTLY ONE child.
   --------------------------------------------------------------------------- */
export function hwbRingApplyContext(container, glyphs = [], specs = []) {
  if (!container) return -1;
  container.classList.add('ctx-aggregate');
  const lead = hwbRingLead(specs);
  glyphs.forEach((g, i) => g && g.classList.toggle('is-lead', i === lead));
  return lead;
}

/* Single-session context: every state animates as designed. */
export function hwbRingClearContext(container, glyphs = []) {
  if (container) container.classList.remove('ctx-aggregate');
  glyphs.forEach(g => g && g.classList.remove('is-lead'));
}
