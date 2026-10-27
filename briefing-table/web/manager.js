/* CLI Manager (2026-07-07 rescope) — list saved sessions (recipes), launch each
 * into its own Edge app-mode window, track which are live via the table
 * endpoint. Launching from the form auto-saves first. */
console.log('[mgr] build 2026-09-17-restore-hygiene'); // bump per change — a stale window shows an old tag

import { enteringShell } from '/ipad-shell-gate.mjs'; // a touch tablet's CLI Manager opens in the shell's tab strip as its hub tab (first, so nothing else starts) [ipad tabs]
import { openLogoModal, parseLogo, wmFields } from '/logo-modal.mjs';
/* window-chrome v32: a mark drawn as a WATERMARK takes the art's line style + glow */
import { hwbMarkClass } from '/aurora/window-chrome/hwb-chrome.js';
import { loadDeviceFont, saveDeviceFont, clampPx, FONT_DEFAULT } from '/term-font.mjs';
import { installScreenClamp } from '/screen-clamp.mjs';
import { isHidden, onVisibility } from '/page-visibility.mjs'; // [perf/poll-traffic] pause while not on screen
import { tickDeviceReport } from '/device-report.mjs'; // user device presence rides the poll below [user device presence]
import { openResumePicker as openSharedResumePicker } from '/resume-picker.mjs'; // one picker: the card's Resume + the + sheet
import { loadEdition, isBasic } from '/edition.mjs'; // writes <html data-edition>: Basic hides Assemble [basic]
import { openAddSheet } from '/room-add-sheet.mjs'; // Assemble = the room + sheet, NEW-room mode (the design system room-add-sheet-v1)
import { createRoomsView, roomOfPanes } from '/manager-rooms.mjs';
import { orderSeated, seatLabel } from '/workbench-order.mjs';
import { mountUsageMeter } from '/usage-meter.mjs'; // plan usage in the titlebar [usage meter]
import { createScreens } from '/manager-screens.mjs'; // home | Recipes | History, one page (the design system 1.K)
import { modelsFor, effortsFor } from '/vendor-profile.mjs';
import { openAgentMenu, moreButton } from '/agent-profile-card.mjs'; // per-agent "...": model & effort (Owner 2026-10-02)
/* The restore-offer + live-ordering RULES, as pure functions so they can be
   run by a test rather than only read (see web/restore-offer.mjs). */
import {
  needsYouBadge, pickInterrupted, sortLive, windowBadge, windowLabel,
} from '/restore-offer.mjs';
// the design system dual-ring status (v18 bundle, synced — never hand-edit): outer ring =
// session state, centre = viewer/presence. hwbRingFromChrome is THE alias
// table as code (three copied tables would be three tables — the design system).
import {
  hwbRing, hwbRingFromChrome, hwbRingLabel, hwbRingApplyContext, HWB_BRAND_PLATES,
} from '/aurora/window-chrome/hwb-ring.js';
/* v21 brand identity: marks from the design system brand-marks v1, the vendor -> brand
   join from our own table (GET /api/brands, web/brand.mjs). */
import { brandMarkPath } from '/aurora/brand-marks/aurora-brand-marks.js';
import { loadBrands, brandFor } from '/brand.mjs';
void loadEdition();
{ const um = document.getElementById('usageMeter'); if (um) mountUsageMeter(um, { isHidden, onVisibility }); } // [usage meter]
void enteringShell; // evaluated for its side effect: on a touch tablet it never settles, so this page does not start [ipad tabs]

/* ---- project MARKS on the rows ------------------------------------------
 * Owner, 2026-09-03: the marks let you bucket rows by project visually — spot
 * the table icon three times and you know that project has three live sessions,
 * without reading a single name. So the mark goes on ALL THREE row types, not
 * just the one in front of you: `.sess` (launcher), `.live-row`, `.recent-row`.
 * Adapting one and missing the others is the exact mistake the phone-layout
 * pass made.
 *
 * LAZY, and self-healing. The preset module is the composed superset (the design system
 * pinned set plus the whole user library) and is ~150 KB, which is nothing on
 * loopback and real latency on a phone over the tailnet. So it is NOT a static
 * import: rows render immediately without marks, and the 2.5s poll fills them
 * in on the next pass once the module lands. Nothing waits on artwork. */
let LOGO_MARKS = null;
let marksFetchedAt = 0;
let marksInFlight = false;
let sawUnknownKey = false;

/* SELF-HEALING. The superset was imported ONCE per page load, so any set added
   afterwards was unresolvable until the tab was reloaded — the mark simply did
   not render, which reads as "this icon won't update" (Owner, on example team
   after adding lib:29). A dynamic import() is served from the module registry
   on repeat, so refreshing needs a cache-busting query; the engine sends the
   route no-store, so the bust only defeats the module cache, not an HTTP one.

   DEMAND-DRIVEN: it refetches only when a row asks for a key we do not have,
   rate-limited so a genuinely deleted set cannot spin. Nothing polls artwork on
   a schedule. */
function refreshMarks(force = false) {
  if (marksInFlight || (!force && Date.now() - marksFetchedAt < 30_000)) {
    return;
  }
  marksInFlight = true;
  import(`/vendor/aurora-logo-presets.js?v=${Date.now()}`)
    .then((m) => {
      LOGO_MARKS = m.LOGO_PRESETS || {};
      sawUnknownKey = false;
    })
    .catch(() => {
      LOGO_MARKS = LOGO_MARKS || {}; // engine unreachable — rows carry no mark
    })
    .finally(() => {
      marksInFlight = false;
      marksFetchedAt = Date.now();
    });
}
refreshMarks(true);

/** Resolve a row's mark by KEY. Sources are tried in order, so a session's own
 *  logo wins over the project default it was seeded from. Markup is never read
 *  from the pref — only the key — because the key is what the tab strip uses
 *  too, and one resolution path means the manager and the tab cannot disagree. */
function markSvg(...sources) {
  if (!LOGO_MARKS) {
    return null;
  }
  for (const src of sources) {
    if (!src || !src.logo) {
      continue;
    }
    try {
      const o = JSON.parse(src.logo);
      if (o && typeof o.key === 'string') {
        if (LOGO_MARKS[o.key]) {
          return LOGO_MARKS[o.key];
        }
        /* A key we cannot resolve means our copy of the superset predates the
           set. Flag it; the render pass refetches once and the next poll paints
           it. */
        sawUnknownKey = true;
      }
    } catch {
      /* unparseable pref — no mark, never an exception into the render */
    }
  }
  return null;
}

/** Paint a mark slot, or collapse it. An empty slot must take NO space, or
 *  unmarked rows sit indented against marked ones and the column looks broken. */
function paintMark(el, ...sources) {
  if (!el) {
    return;
  }
  const svg = markSvg(...sources);
  el.className = svg ? 'row-mark' : 'row-mark is-empty';
  el.innerHTML = svg || '';
}

/* WATERMARK MARKS (window-chrome v32, Owner 2026-09-28: "now that art is used
   as a watermark, it gets the art's fill style and glow wherever it appears").
   The agent card's project mark and the live row's ghost are watermarks, so
   they take the art's {line, backlit} through the bundle's own hwbMarkClass,
   read from the same logo pref that supplied the mark (the engine has already
   inherited the art's treatment into it). The 18px row icons stay solid.
   [rooms/character] */
function markStyleFrom(...sources) {
  for (const src of sources) {
    if (!src || !src.logo) {
      continue;
    }
    try {
      const o = JSON.parse(src.logo);
      if (o && typeof o.key === 'string' && LOGO_MARKS && LOGO_MARKS[o.key]) {
        const w = wmFields(o);
        return { line: w.line, backlit: w.backlit };
      }
    } catch {
      /* unparseable pref: no style, never an exception into the render */
    }
  }
  return null;
}
function paintWatermarkMark(el, ...sources) {
  paintMark(el, ...sources);
  if (el && !el.classList.contains('is-empty')) {
    el.className += hwbMarkClass(markStyleFrom(...sources));
  }
}

/* One chip's countdown, rendered from the deadline the TOOL published. Falls
   back to leaving the tool's own text alone if anything is missing — the
   client embellishes, it never invents. */
function tickChip(chip) {
  const exp = Number(chip.dataset.expires);
  if (!exp) {
    return;
  }
  const left = exp - Math.floor(Date.now() / 1000);
  const prefix = chip.dataset.prefix || '';
  if (left <= 0) {
    chip.textContent = prefix.replace(/warm/i, 'EXPIRED') || 'EXPIRED';
    chip.className = 'live-widget k-cold';
    return;
  }
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  chip.textContent = `${prefix} ${h}h${String(m).padStart(2, '0')}m left`.trim();
}

/* One timer for every chip, and it fires when the DISPLAY can actually change.
 *
 * The chip shows minutes ("10h05m left"), so a 1s interval did 59 pointless
 * repaints a minute (Owner: "we don't need a per-second countdown visualized").
 * Rather than pick an arbitrary slower interval and be up to that far stale,
 * this schedules the next wake for the moment some chip's minute rolls over —
 * one repaint per change, and the value is never wrong for more than a beat.
 *
 * A newly created chip does not wait for this: renderCandidates paints it via
 * tickChip on creation. The 30s ceiling is only a floor-sweeper for chips that
 * appear between wakes. */
function scheduleChipTick() {
  const chips = [...document.querySelectorAll('.live-widget[data-expires]')];
  chips.forEach(tickChip);
  let delay = 30_000;
  for (const c of chips) {
    const left = Number(c.dataset.expires) - Math.floor(Date.now() / 1000);
    if (left > 0) {
      // seconds until this chip's minute figure changes
      delay = Math.min(delay, ((left % 60) || 60) * 1000);
    }
  }
  setTimeout(scheduleChipTick, Math.max(1000, delay));
}
scheduleChipTick();

/** Table row → ring spec. attached:true renders the neutral filled centre
 *  ("someone is there, device unknown") until the viewer registry (vk [ref])
 *  supplies {device, presence} — zero visual rework then. */
function ringSpecFor(row) {
  const chrome = !row
    ? 'ended'
    : row.state === 'live'
      ? row.activity || 'idle'
      : row.state === 'dehydrated'
        ? 'restorable'
        : 'ended';
  /* `exit` (ok|fail, /api/table) keeps a failed session's magenta trace on the
     dimmed ended ring. */
  return hwbRingFromChrome(chrome, { attached: !!row?.attached, exit: row?.exit });
}
/* v21: EVERY ring is drawn on its session's brand plate (treatment 16) — which
   is also what removes the viewer dot everywhere (a plate carries none). The
   brand mark inside the plate only from 20px up; below that the plate alone is
   the design system documented small pattern (U1). */
function paintRing(el, row, size, collector) {
  const spec = ringSpecFor(row);
  const b = brandFor(row?.vendor || 'unknown');
  hwbRing(el, spec, size, { brand: b.brand, markPath: size >= 20 ? brandMarkPath(b.brand) : undefined });
  el.title = `${hwbRingLabel(spec)} · ${b.label}`;
  if (b.brandColor) {
    el.style.setProperty('--brand-src', b.brandColor);
  } else {
    el.style.removeProperty('--brand-src');
  }
  collector?.push({ el, spec });
  return spec;
}

/* The C4 recipe card's corner mark: the brand PLATE + logo with NO ring —
   Owner's rule, a recipe shows no state (it can hold several sessions, so any
   one state on it would be a guess). hwbRing always draws the state rings, so
   this composes the bundle's own plate geometry (HWB_BRAND_PLATES) and the
   bundle's plate/logo classes, exactly as hwbRing does for its underlay; the
   colours are the bundle's (.ring --b-field/--b-edge/--b-ink from --brand-src). */
/* THE BRAND AS A WATERMARK, not a badge (ruling 5). The bare MARK silhouette —
 * never the plate, which is a foreground glyph with its own ground and reads as
 * a second status light when it is ghosted behind text. `currentColor` so the
 * card's own --b-ink (the brand hue, lifted for contrast) is the only colour
 * here; the opacity is the stylesheet's.
 */
/* ONE x DOWN THE COLUMN (ruling 3). The watermark must not follow the title's
 * length — staggered marks were the thing Owner objected to — so it is anchored
 * from the CARD'S RIGHT EDGE, just left of the action group while the buttons
 * share the title's line, and at a fixed inset once they wrap to their own.
 *
 * Measured, not guessed: the action group's width is whatever the brand, the
 * model select and the button labels come to at runtime, so the inset is read
 * off the WIDEST group in the list and applied to every card in it. Reading the
 * widest is what keeps them aligned; per-card measurement would reproduce the
 * stagger one variable over.
 */
/* The live rows' project watermark, same rule as the cards' brand one: anchored
 * from the RIGHT so every ghost sits on one line down the column, and the
 * distance is the WIDEST action group in the list — read at runtime, because
 * "Open window" is present on some rows and not others and the widget chip's
 * text comes from the tool. */
function layoutLiveWatermarks(list) {
  const rows = [...list.querySelectorAll('.live-row')];
  if (rows.length === 0) {
    return;
  }
  let widest = 0;
  for (const r of rows) {
    const acts = r.querySelector('.live-actions');
    if (acts) {
      widest = Math.max(widest, acts.getBoundingClientRect().width);
    }
  }
  rows.forEach((r) => r.style.setProperty('--acts-w', `${Math.round(widest)}px`));
}

function layoutBrandWatermarks(scope) {
  const cards = [...scope.querySelectorAll('.sess.c4')];
  if (cards.length === 0) {
    return;
  }
  /* Two rows means the buttons have their own line and there is nothing to sit
     left of; the stylesheet's fixed inset already covers that case. */
  const stacked = cards.some((c) => getComputedStyle(c).display === 'grid');
  if (stacked) {
    cards.forEach((c) => {
      c.style.removeProperty('--bwm-right');
      /* the project mark takes the TITLE BLOCK's box (name + meta), the whole
         mark at that height, so the controls row never crosses it (the design system,
         card-mark-2 review) */
      const m = c.querySelector('.sess-main');
      if (m) {
        c.style.setProperty('--mk-top', `${m.offsetTop}px`);
        c.style.setProperty('--mk-h', `${m.offsetHeight}px`);
      }
    });
    return;
  }
  cards.forEach((c) => {
    c.style.removeProperty('--mk-top');
    c.style.removeProperty('--mk-h');
  });
  let widest = 0;
  for (const c of cards) {
    const acts = c.querySelector('.sess-actions');
    if (acts) {
      widest = Math.max(widest, acts.getBoundingClientRect().width);
    }
  }
  const inset = Math.round(widest) + 30; // the breath Owner asked for past the buttons
  cards.forEach((c) => c.style.setProperty('--bwm-right', `${inset}px`));
}

/* THE LAYOUT FOLLOWS THE COLUMN. Both layouts above are measured, and a
   column that narrows into the two-row layout (a window resize, a side panel)
   re-renders nothing, so without this a wide inset stayed inline and pulled
   the brand watermark onto the project mark (the design system, card-mark-2 FAIL-1). */
if (typeof ResizeObserver === 'function') {
  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const col = document.getElementById('agentList')?.parentElement;
      if (col) {
        layoutBrandWatermarks(col);
      }
      const live = document.getElementById('liveList');
      if (live) {
        layoutLiveWatermarks(live);
      }
    });
  });
  queueMicrotask(() => {
    const col = document.getElementById('agentList')?.parentElement;
    if (col) {
      ro.observe(col);
    }
  });
}

function brandWatermark(vendor) {
  const b = brandFor(vendor || 'unknown');
  const el = document.createElement('span');
  el.className = 'sess-bwm';
  el.setAttribute('aria-hidden', 'true'); // decorative: the brand is already in the meta line
  if (b.brandColor) {
    el.style.setProperty('--brand-src', b.brandColor);
  }
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${brandMarkPath(b.brand)}"/></svg>`;
  return el;
}

function brandPlate(vendor, size) {
  const b = brandFor(vendor || 'unknown');
  const key = HWB_BRAND_PLATES[b.brand] ? b.brand : 'generic';
  const el = document.createElement('span');
  el.className = 'ring has-plate sess-brand';
  el.style.setProperty('--s', `${size}px`);
  if (b.brandColor) {
    el.style.setProperty('--brand-src', b.brandColor);
  }
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', b.label);
  el.title = b.label;
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${HWB_BRAND_PLATES[key]}`
    + `<g transform="translate(12 12) scale(.62) translate(-12 -12)">`
    + `<path class="rg-logo" fill-rule="evenodd" d="${brandMarkPath(b.brand)}"/></g></svg>`;
  return el;
}

/* Brands arrive once per page; until then everything is `generic`. Force one
   repaint when they land (the render signature would otherwise skip it). */
let brandsReady = false;
loadBrands().then(() => {
  brandsReady = true;
  if (typeof refresh === 'function') {
    refresh();
  }
});
/** Aggregate-context rule (the design system): a LIST of rings is an aggregate — exactly
 *  ONE lead glyph may animate per list, or 17 rings become the blinking wall.
 *  Called per list, not per page (the lead is scoped to its group). */
function applyRingContext(listEl, collected) {
  hwbRingApplyContext(
    listEl,
    collected.map((c) => c.el),
    collected.map((c) => c.spec),
  );
}

/* Launch-new model choices now come per vendor from vendor-profile.mjs (one
   place, Owner 2026-10-03); the settings panel (vk [ref]) would make them
   user-editable. */

const els = {
  agentList: document.getElementById('agentList'),
  otherList: document.getElementById('otherList'),
  formModal: document.getElementById('formModal'),
  form: document.getElementById('form'),
  formTitle: document.getElementById('formTitle'),
  fName: document.getElementById('fName'),
  fTarget: document.getElementById('fTarget'),
  fDir: document.getElementById('fDir'),
  fDirWarn: document.getElementById('fDirWarn'),
  fAgent: document.getElementById('fAgent'),
  fVendor: document.getElementById('fVendor'),
  claudeOpts: document.getElementById('claudeOpts'),
  fModel: document.getElementById('fModel'),
  fEffort: document.getElementById('fEffort'),
  fWorktree: document.getElementById('fWorktree'),
  fVendorArgs: document.getElementById('fVendorArgs'),
  fVendorArgsRow: document.getElementById('fVendorArgsRow'),
  fVendorFlagsRow: document.getElementById('fVendorFlagsRow'),
  fLegacyResume: document.getElementById('fLegacyResume'),
  fColor: document.getElementById('fColor'),
  fColorBtn: document.getElementById('fColorBtn'),
  fColorPop: document.getElementById('fColorPop'),
  fColorGrid: document.getElementById('fColorGrid'),
  fColorHex: document.getElementById('fColorHex'),
  fColorNative: document.getElementById('fColorNative'),
  fColorOwned: document.getElementById('fColorOwned'),
  fLogoBtn: document.getElementById('fLogoBtn'),
  fFont: document.getElementById('fFont'),
  fDevFontDec: document.getElementById('fDevFontDec'),
  fDevFontInc: document.getElementById('fDevFontInc'),
  fDevFontVal: document.getElementById('fDevFontVal'),
  saveBtn: document.getElementById('saveBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  debug: document.getElementById('debug'),
  restoreBanner: document.getElementById('restoreBanner'),
  restoreMsg: document.getElementById('restoreMsg'),
  restoreAllBtn: document.getElementById('restoreAllBtn'),
  restoreDismissBtn: document.getElementById('restoreDismissBtn'),
  recent: document.getElementById('recent'),
  recentList: document.getElementById('recentList'),
  fInitCmd: document.getElementById('fInitCmd'),
  initCmdRow: document.getElementById('initCmdRow'),
};

let targets = [];
let recipes = [];
let rowByPane = new Map(); // paneid -> full table row {state, interrupted, ...}
let editingId = null; // recipe id in the form, or null = new
let editingLogo = null; // parsed logo object being edited in the form (null = none)

/** Reflect whether a logo is set on the form's Logo button. */
function syncLogoBtn() {
  els.fLogoBtn.classList.toggle('has-logo', !!editingLogo);
  els.fLogoBtn.textContent = editingLogo ? '◨ Logo ✓' : '◨ Logo';
}

/* Is this manager a hub TAB inside a shell window, or its own window?
   (Per-window Manager, Owner 2026-08-18: every window carries its own hub tab,
   so `+` never yanks you to another window and a launch can land HERE.) */
const EMBEDDED = window.parent !== window;

/* The shell's status menu carries its own "Account" item when embedded
   (web/shell.html, 2026-09-28) — showing this header link too would duplicate
   it with no hamburger anywhere near it to explain the redundancy. Standalone
   (a plain browser, a phone) there is no status menu, so the header link is
   the only way in and stays. `.btn` sets no `display` of its own, so the
   `hidden` attribute's UA `display:none` applies with nothing to override. */
if (EMBEDDED) {
  const accountBtn = document.getElementById('accountBtn');
  if (accountBtn) { accountBtn.hidden = true; }
}

/* REMOTE = this manager is being viewed from another machine (laptop, iPad),
   which we know because a local client always reaches the engine over loopback
   and a remote one never can. It matters for PLACEMENT: asking the engine to
   "open a window" from here would pop a window on the VRPC's desktop, which the
   person holding the laptop cannot see. A remote launch opens a tab HERE. */
const REMOTE = !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);

/* Standalone in a remote browser (a phone, a laptop tab) a pick navigates THIS
   tab: the room page's own phone rail moves between rooms, so a new browser tab
   per pick only piles tabs up (Owner 2026-10-02, room line [ref]). Embedded (the
   shell's hub tab, hwbOpenTab) and local loopback (native windows) keep their
   own ways. */
const SAME_TAB = !EMBEDDED && REMOTE;
function openStandalone(url) {
  if (SAME_TAB) {
    window.location.assign(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/* Ask the shell to mount a session as a tab in THIS window. Only ever called
   after the engine has answered placement:'tab' — see api.launch. */
function placeTabHere(url, paneid) {
  window.parent.postMessage(
    { hwbOpenTab: { url: url, sessionId: paneid || null } },
    '*',
  );
}

/* ---- auxiliary pages open beside the manager, never over it ----------------
 * Icons, Account, and later Showcase. The manager is the page you cannot
 * comfortably back-button to (Owner, 2026-09-15), so a link out of it opens a
 * NEW TAB: a browser tab on the web (the anchor's own target=_blank does it),
 * a shell tab inside the native window (the same hwbOpenTab the hub uses to
 * mount a session — the shell adds the tab and keeps this one). Any anchor
 * carrying data-aux="<title>" gets this behaviour; nothing else changes. */
function openAux(url, title, external) {
  if (EMBEDDED && !external) {
    window.parent.postMessage({ hwbOpenTab: { url: url, title: title || null } }, '*');
    return;
  }
  if (EMBEDDED) {
    /* EXTERNAL = must run in the default browser, not in a WebView2 tab —
       Windows Hello refuses the passkey ceremony inside the embedded browser
       (Owner, 2026-09-15). Ask the host first (hwbOpenExternal); window.open is
       the fallback, which WebView2 raises as NewWindowRequested — the host
       decides where that lands.
       PAYLOAD IS A STRING, NOT AN OBJECT: the shell's relay
       (web/open-external.mjs relayExternal, landed 2026-09-28) only reads
       `d.hwbOpenExternal` when `typeof === 'string'` — `{url}` is silently
       dropped, so this message did nothing until this fix; the window.open
       fallback below is why nobody noticed. */
    window.parent.postMessage({ hwbOpenExternal: url }, '*');
  }
  window.open(url, '_blank', 'noopener');
}
/* WHERE the external pages live is per-host config, not something a relative
   href can know: inside the native window the manager is loaded from the
   loopback address, and that is exactly the address a passkey refuses (and,
   before cutover, the account store is on the server engine, not this one).
   `web/ui-config.json` (per checkout, gitignored, example committed) names the
   engine's public URL and, optionally, a different account page. Read once;
   absent = today's relative behaviour. (Owner, 2026-09-15: "the links in the
   header don't have the tailscale address".) */
fetch('/ui-config.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => {
    if (!cfg) {
      return;
    }
    for (const a of document.querySelectorAll('a[data-aux]')) {
      const href = a.getAttribute('href') || '';
      if (a.hasAttribute('data-external') && typeof cfg.accountUrl === 'string' && cfg.accountUrl) {
        a.setAttribute('href', cfg.accountUrl);
      } else if (typeof cfg.publicUrl === 'string' && cfg.publicUrl && href.startsWith('/')) {
        a.setAttribute('href', cfg.publicUrl.replace(/\/$/, '') + href);
      }
    }
  })
  .catch(() => { /* no config, relative links stand */ });
document.addEventListener('click', (ev) => {
  const a = ev.target instanceof Element ? ev.target.closest('a[data-aux]') : null;
  if (!a) {
    return;
  }
  ev.preventDefault();
  openAux(a.getAttribute('href'), a.dataset.aux || a.textContent.trim(), a.hasAttribute('data-external'));
});

/* Phone menu: four-squares button + sheet (manager-menu.mjs). A failed import
   must not take the manager down. */
import('/manager-find.mjs').then((m) => { m.initFind(); m.initMore(); }).catch((e) => console.warn('manager title bar failed', e));
import('/manager-menu.mjs').then((m) => m.initManagerMenu()).catch((e) => console.warn('manager menu failed', e));
/* [concierge] its icon in the find row, right of the search box. Unlike other surfaces it stays as a MUTED
   icon when the Concierge is off (Owner wants a presence here); Basic hides it by CSS. */
import('/concierge.mjs')
  .then((m) => document.getElementById('mgrFindRow')?.append(m.conciergeButton('mgr-cg', { always: true })))
  .catch((e) => console.warn('concierge icon failed', e));

/* ---- zoom blockers: KB design-notes-id ------------------------------------
 * "CSS alone does NOT stop pinch-zoom or double-tap-zoom on recent iOS Safari"
 * — the installation pattern, verbatim, and the reason Owner could pinch out to reveal
 * a layout wider than his screen and have it snap back clipped. The viewport
 * meta is layer one; these handlers are layer three, and the doc is explicit
 * that both are required.
 *
 * passive:false is load-bearing on touchstart/touchend — preventDefault is
 * SILENTLY IGNORED on a passive listener, which is exactly the kind of fix that
 * looks applied and does nothing.
 */
function installZoomBlockers() {
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) {
      e.preventDefault(); // a second finger is a pinch
    }
  }, { passive: false });

  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
      e.preventDefault(); // double-tap-to-zoom
    }
    lastTouchEnd = now;
  }, { passive: false });

  // iOS-only gesture events; no-ops elsewhere, harmless everywhere.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault());
  }
}
installZoomBlockers();

const api = {
  async targets() {
    return (await (await fetch('/api/targets')).json()).targets;
  },
  async recipes() {
    return (await (await fetch('/api/recipes')).json()).recipes;
  },
  async table() {
    const body = await (await fetch('/api/table')).json();
    // Broker health rides the table poll (additive field — absent on an older
    // engine, and the banner then simply never shows).
    const warn = document.getElementById('brokerWarn');
    if (warn) {
      warn.hidden = !(body.broker && body.broker.available === false);
    }
    return body.sessions;
  },
  async save(recipe) {
    const res = await fetch('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(recipe),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `save failed (${res.status})`);
    }
    /* The WHOLE body, not just the recipe: a save can succeed and still have
       something to tell you (the project folder is not there). Dropping it here
       is how that news went missing before it ever reached a screen. */
    return body;
  },
  async remove(id) {
    await fetch(`/api/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async launch(id, opts) {
    /* EMBEDDED = a hub tab inside a shell window, so this manager places
       sessions in ITS OWN window instead of spawning a new OS window. We ask
       with target:'tab'; the ENGINE decides. One-window-per-pty is not ours to
       adjudicate — if the session is already on screen the engine focuses that
       view and answers placement:'focused', and we add nothing. Standalone
       (a manager in its own window) keeps the old new-window behaviour. */
    const body = Object.assign({}, opts ?? {});
    if (EMBEDDED) {
      body.target = 'tab'; // a hub tab in a shell window → place beside me
      /* A shell in a PLAIN BROWSER has no host window to "focus". Without this the engine asked the VRPC's desktop whether the
         session was on screen THERE, found a stale native window, answered "focused", and nothing opened here and no error
         showed (Owner [ref], Local command bridge). Declaring the browser skips that check, as the REMOTE branch below does. */
      if (!(window.chrome && window.chrome.webview)) { body.surface = 'browser'; }
    } else if (REMOTE) {
      body.target = 'tab';
      body.surface = 'browser'; // → the engine hands back a path to open here
    }
    const res = await fetch(`/api/recipes/${encodeURIComponent(id)}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      /* A 409 from guard 7 carries the refusal text: show it in place. */
      const why = await res.json().catch(() => null);
      throw new Error(why?.error ? String(why.error) : `launch failed (${res.status})`);
    }
    const out = await res.json().catch(() => ({}));
    if (REMOTE && !EMBEDDED && out.placement === 'tab' && out.path) {
      /* Remote standalone: this tab goes there (openStandalone). */
      openStandalone(out.path);
      return out;
    }
    if (EMBEDDED && out.placement === 'tab' && (out.path || out.url)) {
      /* Prefer the RELATIVE path: it resolves against whatever origin this page
         was served from, so the same manager works on the VRPC and from a
         laptop or iPad. `url` is absolute-loopback (the window host's form) and
         would point at the CLIENT's own loopback if we sent it off-machine. */
      placeTabHere(out.path || out.url, out.paneid);
    }
    return out;
  },
};

function targetLabel(id) {
  return targets.find((t) => t.id === id)?.label ?? id;
}

/* IS THIS AN AGENT CARD? A recipe whose vendor has an engine module — a model,
   a resume, a session to come back to. `runClaude` answered this while claude
   was the only such vendor and is now too narrow: a gemini-cli recipe has
   runClaude=0 and is very much an agent. Declared next to its only consumers
   rather than beside the form's copy, because the form is asking a different
   question (which CONTROLS to show) that happens to have the same answer.
   codex-cli was missing (2026-10-07): a closed Codex session never reached
   Recently closed and a Codex recipe lost its Resume button. test/manager-
   vendors.test.mjs keeps this equal to agent-chat-core's list, so the next
   vendor cannot be forgotten here. */
const AGENT_VENDORS = ['claude-code', 'codex-cli', 'gemini-cli'];
function isAgentRecipe(r) {
  return AGENT_VENDORS.includes(r.vendor ?? (r.runClaude ? 'claude-code' : 'cli-manager'));
}

function claudeSummary(r) {
  if (!isAgentRecipe(r)) {
    return 'shell only';
  }
  const bits = [r.vendor === 'gemini-cli' ? 'gemini' : 'claude'];
  if (r.model) {
    bits.push(r.model);
  }
  if (r.resume) {
    bits.push(r.resumeName ? `resume "${r.resumeName}"` : 'resume (pick)');
  }
  return bits.join(' · ');
}

/** One card. Agents (a vendor with a module) get the model dropdown + Launch
 *  new + Resume; Other CLIs are launch-only (no session concept — Launch
 *  re-runs initCmd). */
function buildCard(r, ringCollector) {
  const row = rowByPane.get(`recipe:${r.id}`);
  const state = row?.state;
  const act = row?.activity || '';
  const live = state === 'live';
  const restorable = state === 'dehydrated';
  const isAgent = isAgentRecipe(r);
  const card = document.createElement('div');
  /* C4 (the design system v21, ruled): the BRAND is the card's colour (wash + seam), the
     PROJECT icon leads, the brand plate sits top-right — and NO ring and NO
     activity, even while it runs. State lives only in the live rows. */
  card.className = 'sess c4';
  card.style.setProperty('--sess-accent', r.color || 'var(--teal)');
  {
    const b = brandFor(r.vendor ?? (r.runClaude ? 'claude-code' : 'cli-manager'));
    if (b.brandColor) {
      card.style.setProperty('--brand-src', b.brandColor);
    }
  }
  const cardModels = modelsFor(r.vendor ?? (r.runClaude ? 'claude-code' : 'cli-manager'));
  const modelSel = isAgent && cardModels.length
    ? `<select class="sess-model" data-act="model" title="Model for a NEW session (this launch only)">
         <option value="">${r.model ? `default (${r.model})` : 'default'}</option>
         ${cardModels.map((m) => `<option value="${m}">${m}</option>`).join('')}
       </select>`
    : '';
  const primary = live ? 'Open window' : restorable ? 'Restore' : isAgent ? 'Launch new' : 'Launch';
  card.innerHTML = `
    <span class="sess-proj"><span data-mark></span></span>
    <div class="sess-main">
      <div class="sess-name"></div>
      <div class="sess-meta"></div>
    </div>
    <div class="sess-actions">
      ${modelSel}
      <button class="btn btn-accent" data-act="launch">${primary}</button>
      ${live || restorable ? '<button class="btn" data-act="new" title="Start ANOTHER session in this project, alongside the existing one">＋ New</button>' : ''}
      ${isAgent ? '<button class="btn" data-act="resume" title="Pick a past session of this project to resume">Resume</button>' : ''}
      <button class="btn" data-act="edit">Edit</button>
      <button class="btn btn-ghost" data-act="delete" title="Delete this saved session">✕</button>
    </div>`;
  /* 5 (ruled): the brand is a WATERMARK behind the title's right end, under the
     text — not a plate badge in the corner. Right-anchored so every card's mark
     sits at the same x down the column, which is what stops them staggering
     with title length. `--bwm-right` is set per list by layoutBrandWatermarks()
     once the real button widths are known. */
  card.appendChild(brandWatermark(r.vendor ?? (r.runClaude ? 'claude-code' : 'cli-manager')));
  /* RECIPE FIRST on a launcher card. This card IS the project, so the project's
     icon is the authority — passing the session row first meant changing a
     project's icon showed the OLD one indefinitely, because existing session
     rows keep the key they were seeded with and were winning the lookup. The
     live rows below do the opposite, and correctly: a live row IS a session, so
     a session's own icon wins there. */
  paintWatermarkMark(card.querySelector('[data-mark]'), r, row);
  card.querySelector('.sess-name').textContent = r.name;
  // Show only the LAST path segment — the project folder is the part that
  // matters (platform, harbor, homehub…) and full paths truncate it away.
  // The full path lives in the tooltip.
  const projFolder = r.projectDir ? r.projectDir.split(/[\\/]/).filter(Boolean).pop() : '(home)';
  /* Count every session in the project, not just the primary pane — a project
     is a bucket and the sessions are what is in it. */
  const mine = [...rowByPane.values()].filter((x) => x.recipe_id === r.id);
  const liveCount = mine.filter((x) => x.state === 'live').length;
  card.querySelector('.sess-meta').textContent =
    `${targetLabel(r.target)}  ·  ${projFolder}  ·  ${isAgent ? claudeSummary(r) : r.initCmd || 'shell only'}`
    + (liveCount > 1 ? `  ·  ${liveCount} live sessions` : '');
  card.querySelector('.sess-meta').title = r.projectDir || '(home)';
  card.querySelector('[data-act="launch"]').addEventListener('click', async () => {
    try {
      const model = isAgent ? card.querySelector('[data-act="model"]').value || undefined : undefined;
      // Model override only means something for a NEW session; live/restore
      // launches ignore it engine-side, which is the intended semantics.
      await api.launch(r.id, model ? { model } : undefined);
    } catch (err) {
      alert(err.message);
    }
  });
  /* THE DEAD END THIS FIXES: while a project was live or restorable, the primary
     button became "Open window" or "Restore" and there was NO request that meant
     "another session here" — Owner needed a second example project session and had to
     open a terminal. `fresh` mints a distinct pane in the same project. */
  card.querySelector('[data-act="new"]')?.addEventListener('click', async () => {
    try {
      const model = isAgent ? card.querySelector('[data-act="model"]').value || undefined : undefined;
      await api.launch(r.id, model ? { fresh: true, model } : { fresh: true });
    } catch (err) {
      alert(err.message);
    }
  });
  card.querySelector('[data-act="resume"]')?.addEventListener('click', () => openResumePicker(r));
  card.querySelector('[data-act="edit"]').addEventListener('click', () => openForm(r));
  card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    if (confirm(`Delete saved session "${r.name}"? (A live window keeps running.)`)) {
      await api.remove(r.id);
      await refresh();
    }
  });
  return card;
}

let lastRenderSig = '';
function render() {
  // Rebuild the DOM only when the DATA changed — the 2.5s poll otherwise
  // destroys open native widgets mid-interaction (the model dropdown's popup
  // vanished under the user's cursor). Also never rebuild while a card
  // control has focus.
  const sig = JSON.stringify([
    brandsReady,
    recipes,
    [...rowByPane].map(([k, v]) => [k, v.state, v.interrupted, v.session_id, v.updated_at, v.activity, v.attached, v.blocked?.reason ?? null]),
  ]);
  if (sig === lastRenderSig || document.activeElement?.closest?.('.sess')) {
    /* Even on a skipped render, act on a key we could not resolve last pass —
       otherwise a page whose data is unchanged never heals, which is precisely
       the "this icon won't update" case. */
    if (sawUnknownKey) {
      refreshMarks();
    }
    return;
  }
  lastRenderSig = sig;
  const agents = recipes.filter(isAgentRecipe);
  const others = recipes.filter((r) => !isAgentRecipe(r));
  els.agentList.innerHTML = '';
  els.otherList.innerHTML = '';
  if (agents.length === 0) {
    els.agentList.innerHTML = `<div class="mgr-empty">No saved agents yet.<br />
      <strong>＋ New session</strong> with "Start Claude" on defines one —
      name it, pick where/who, point it at a project folder.</div>`;
  } else {
    const agentRings = [];
    for (const r of agents) {
      els.agentList.appendChild(buildCard(r, agentRings));
    }
    applyRingContext(els.agentList, agentRings);
  }
  if (others.length === 0) {
    els.otherList.innerHTML = `<div class="mgr-empty">No other CLIs yet.<br />
      <strong>＋ New session</strong> with "Start Claude" off + an init command
      saves any shell you open often (e.g. a shell login).</div>`;
  } else {
    const otherRings = [];
    for (const r of others) {
      els.otherList.appendChild(buildCard(r, otherRings));
    }
    applyRingContext(els.otherList, otherRings);
  }
  /* ONE inset for the WHOLE COLUMN, not per list: Other CLIs and Agents stack in
     the same column, and aligning them separately puts two vertical lines of
     watermarks a few hundred pixels apart — the stagger Owner objected to, one
     level up. */
  layoutBrandWatermarks(els.otherList.parentElement || document);

  /* A mark whose key we could not resolve means our superset copy predates the
     set. Refetch once (rate-limited inside) — the next 2.5s poll paints it. */
  if (sawUnknownKey) {
    refreshMarks();
  }
  const live = [...rowByPane.values()].filter((s) => s.state === 'live').length;
  const restorable = recipes.filter((r) => rowByPane.get(`recipe:${r.id}`)?.state === 'dehydrated').length;
  els.debug.textContent =
    `${agents.length} agents · ${others.length} other CLIs · ${live} live` +
    (restorable ? ` · ${restorable} restorable` : '') +
    ` · M7`;
  renderRestoreOffer();
  renderLive();
  renderRecent();
  screens.setCounts({ recipes: recipes.length, history: historyCount, restorable });
  const leftEmpty = document.getElementById('leftEmpty');
  if (leftEmpty) {
    leftEmpty.hidden = !(
      document.getElementById('liveWrap').hidden && document.getElementById('recent').hidden
    );
  }
}

let historyCount = 0;
const screens = createScreens();

/* "+ New agent session" ENDS the live list (the design system 1.K): a dashed card that opens a picker of the recipes. Agents first
   (what you came for), shells after, and a way on to every recipe. Choosing one starts a session, never edits a recipe. */
const newSessionCard = document.createElement('button');
newSessionCard.type = 'button';
newSessionCard.id = 'newSessionCard';
newSessionCard.className = 'plus-card plus-row';
newSessionCard.innerHTML = '<span class="pi" aria-hidden="true">+</span><span class="pt">New agent session</span><small>pick a recipe</small>';
const sessionPicker = document.getElementById('sessionPicker');
function closeSessionPicker() {
  sessionPicker.hidden = true;
  newSessionCard.focus({ preventScroll: true });
}
function openSessionPicker() {
  const body = document.getElementById('sessionPickerBody');
  body.textContent = '';
  const pick = (label, list) => {
    if (!list.length) {
      return;
    }
    const h = document.createElement('div');
    h.className = 'sp-h';
    h.textContent = label;
    body.append(h);
    for (const r of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-pick';
      b.dataset.recipe = r.id;
      b.style.setProperty('--pc', r.color || 'var(--teal)');
      const nm = document.createElement('b');
      nm.textContent = r.name;
      const meta = document.createElement('span');
      meta.className = 'sp-meta';
      meta.textContent = isAgentRecipe(r) ? claudeSummary(r) : r.initCmd || 'shell only';
      b.append(nm, meta);
      b.addEventListener('click', async () => {
        const st = rowByPane.get(`recipe:${r.id}`)?.state;
        closeSessionPicker();
        try {
          await api.launch(r.id, st === 'live' || st === 'dehydrated' ? { fresh: true } : undefined); // a NEW session, alongside any that exists
        } catch (err) {
          alert(err.message);
        }
      });
      body.append(b);
    }
  };
  pick('Agents', recipes.filter(isAgentRecipe).slice(0, 8));
  pick('Shells', recipes.filter((r) => !isAgentRecipe(r)).slice(0, 4));
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'btn btn-ghost sp-all';
  all.dataset.screen = 'recipes';
  all.textContent = 'All recipes ›';
  all.addEventListener('click', () => { sessionPicker.hidden = true; });
  body.append(all);
  sessionPicker.hidden = false;
  if (!matchMedia('(pointer: coarse)').matches) {
    body.querySelector('.sp-pick')?.focus({ preventScroll: true });
  }
}
newSessionCard.addEventListener('click', openSessionPicker);
document.getElementById('sessionPickerScrim').addEventListener('click', closeSessionPicker);
document.getElementById('sessionPickerX').addEventListener('click', closeSessionPicker);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sessionPicker.hidden) {
    e.preventDefault();
    closeSessionPicker();
  }
});

/* ---- live strip (M9 stopgap): everything ALIVE right now — windowed or
 * parked in the pty-broker — so no running session is ever invisible. Recipe
 * rows get Open window; bare/ghost panes at least get seen + endable. ---- */
/* THE LIVE SESSIONS HEADING [live heading] (Owner 2026-10-08, the design system handoff 1.Q): the list shows the sessions that sit in NO room; the heading counts all of them
   and offers the rest. Show all is NOT remembered: every load opens on the strays. */
let liveShowAll = false;
function liveCountsText(total, outside) {
  const inside = total - outside;
  if (total === 0) {
    return '';
  }
  if (inside === 0) {
    return `${total} live \u00b7 all outside rooms`;
  }
  if (outside === 0) {
    return `${total} live \u00b7 all inside rooms`;
  }
  return `${total} live \u00b7 ${outside} outside ${outside === 1 ? 'room' : 'rooms'} \u00b7 ${inside} inside ${inside === 1 ? 'room' : 'rooms'}`;
}
function paintLiveHeading(total, outside) {
  const box = document.getElementById('liveCounts');
  const text = liveCountsText(total, outside);
  const inside = total - outside;
  box.hidden = !text;
  document.getElementById('liveCountsText').textContent = text;
  const link = document.getElementById('liveShowAll');
  link.hidden = inside === 0; // nothing inside a room: nothing more to show
  document.getElementById('liveSep2').hidden = link.hidden;
  link.textContent = liveShowAll ? 'Show only those outside rooms' : 'Show all';
  link.setAttribute('aria-pressed', String(liveShowAll));
}
document.getElementById('liveShowAll').addEventListener('click', () => {
  liveShowAll = !liveShowAll;
  renderLive();
});
function renderLive() {
  const wrap = document.getElementById('liveWrap');
  const list = document.getElementById('liveList');
  /* LIVE SESSIONS: the live sessions NOT seated in a room (Owner 2026-10-07, restoring the 2026-09-28 "Live tabs" rule: a
     seated session is shown on its room's card, so listing it here again was noise). */
  const roomOf = roomOfPanes(rooms);
  const everyLive = [...rowByPane.values()].filter((s) => s.state === 'live');
  const allLive = liveShowAll ? everyLive : everyLive.filter((s) => !roomOf.has(s.paneid));
  /* YOUR WORK FIRST, THE MACHINERY AFTER.
     A project session and a workbench-prototype pane are not the same kind of
     thing, and mixing them made a list of real sessions look like clutter —
     Owner could not tell which unnamed rows mattered. `kind` comes from the
     engine, which has always known; the manager just never asked. */
  /* UNATTACHED FIRST (Owner, 2026-09-17). A live session with no window is the
     only row here you might have forgotten about — every other one is already
     on somebody's screen. When a shell reload ate his tabs, platform and harbor
     were still running and still listed, and nothing in the list said so: the
     "parked" wording was computed and then spent on the TOOLTIP. Floating them
     is what puts them back in front of you. */
  /* Strays first, then (Show all) the seated ones: each group in the list's own order */
  const agentLive = (xs) => sortLive(xs.filter((s) => s.kind !== 'component'));
  /* Seated ones (Show all): by ROOT, then its own seats, then each GROUP, lead first then handle (web/workbench-order.mjs);
     a seat in a room the order cannot place (closed) keeps the list's own order, after. */
  const seatedRows = agentLive(allLive.filter((s) => roomOf.has(s.paneid)));
  const seated = orderSeated(seatedRows, rooms);
  const seatOf = new Map(seated.map((x) => [x.row.paneid, x.info]));
  const live = [...agentLive(allLive.filter((s) => !roomOf.has(s.paneid))), ...seated.map((x) => x.row), ...seatedRows.filter((s) => !seatOf.has(s.paneid))];
  paintLiveHeading(agentLive(everyLive).length, agentLive(everyLive).filter((s) => !roomOf.has(s.paneid)).length);
  const componentPanes = allLive.filter((s) => s.kind === 'component');
  wrap.hidden = false; // always: "+ New agent session" ends this list, and it is the way to start one
  list.innerHTML = '';
  const liveRings = [];
  for (const s of live) {
    /* Read the COLUMN, not the handle. Slicing the paneid leaves the `#<short>`
       suffix on an additional session, so `rec` came back null for it — which
       silently removed its "Open window" button and its name/colour fallbacks.
       A second session was visible in the strip but not openable from it. */
    const rec = recipes.find((r) => r.id === s.recipe_id) || null;
    const row = document.createElement('div');
    row.className = 'live-row';
    row.style.setProperty('--sess-accent', s.color || rec?.color || 'var(--teal)');
    row.innerHTML = `
      <span data-ring></span>
      <span class="live-wm"><span data-mark></span></span>
      <span class="live-name"></span>
      <span class="live-actions">
        <button class="btn" data-act="peek" title="See the session's recent output without opening a window">Peek</button>
        ${rec ? '<button class="btn btn-accent" data-act="open">Open window</button>' : ''}
        <button class="btn btn-ghost" data-act="end" title="End this session — kills the CLI in the broker">✕ End</button>
      </span>`;
    /* THE SESSION, then the project — in that order, because that is the order
       you need them in. Every row used to read the PROJECT name, so a project
       with several sessions showed the same label N times and "Open window" was
       a guess about which conversation you would land in. `title` is the name
       Claude itself carries (a /rename, else its auto-title, else the last
       thing said in it) — the same string the Resume picker shows, so a session
       reads identically in both places. */
    const projectName = rec?.name || s.friendlyName || null;
    const sessionName = s.title || null;
    row.querySelector('.live-name').textContent =
      sessionName || projectName || `(unnamed pane) ${s.paneid.slice(0, 8)}…`;

    /* WHERE it is being driven, not just whether something is attached.
       "window open" answers the wrong question when Owner is deciding whether to
       take a session over from the laptop — he needs to know WHICH machine has
       it. The engine resolves the controller to a tailnet device name; showing
       it is the difference between "something is open" and "the laptop has it".
       A live session with no controller is available, not busy. */
    const where = windowLabel(s);
    /* The PROJECT moves into the meta line once the name slot shows the
       session. A component pane has no project and no conversation — say what
       it actually is (local-shell / repo-shell / local-cmd) rather than leaving
       a blank-looking row that reads like a broken agent. */
    /* The tool's own status line, BESIDE the state (Owner: "show it by the
       active badge") — it is a fact about this session, so it belongs where you
       already look to see how the session is doing, not in a panel of its own.
       Text is rendered verbatim: the engine does not interpret it and neither
       do we. `kind` is the only thing we read, and only to colour it. */
    /* THE ONE FACT THE ROW WOULD NOT SAY OUT LOUD. Only for an unattached live
       session: a chip on every row is a chip nobody reads, and it is the
       ABSENCE of a window that is news. The ring already encodes attachment,
       but a hollow centre is a thing you have to know to read — two words are
       not. Same chip shape as the tool's status line so the row keeps one
       visual language (and inherits its phone-grid rule for free). */
    const badgeText = windowBadge(s);
    if (badgeText) {
      const nw = document.createElement('span');
      nw.className = 'live-widget live-nowin';
      nw.textContent = badgeText;
      nw.title = 'This session is running in the broker with nothing showing it — "Open window" brings it back';
      row.querySelector('.live-name').after(nw);
    }
    /* NEEDS YOU survives the ack [ticket]: once the pane has been seen the
       ring goes still (`waiting-seen`, window-chrome v33), but the prompt it
       is blocked on is still on screen and this chip says which one.
       Placed nearest the name, so it reads before the inventory chip. */
    const needs = needsYouBadge(s);
    if (needs) {
      const nc = document.createElement('span');
      nc.className = 'live-widget live-needs';
      nc.textContent = needs;
      nc.title = 'The session is waiting on a prompt only you can answer — "Open window" to answer it';
      row.querySelector('.live-name').after(nc);
    }

    /* THE ROOM it sits in (the design system 1.K). Since only unseated sessions are listed (above) this is the quiet "not in a room";
       the seated branch stays for a session that joins a room between polls. */
    {
      const rm = roomOf.get(s.paneid);
      const seat = seatOf.get(s.paneid) || null;
      const rc = document.createElement(rm ? 'button' : 'span');
      rc.className = `live-widget live-roomchip${rm ? '' : ' is-none'}${seat ? ' is-seat' : ''}`;
      if (rm) {
        rc.type = 'button';
        const label = seat ? seatLabel(seat) : rm.name; // "Root \u203a Group \u00b7 @handle" (a seat in a root: "Root \u00b7 @handle")
        rc.title = `Open ${seat ? seat.groupName || seat.rootName : rm.name}`;
        const col = (seat ? seat.room.color : null) || rm.color;
        rc.style.setProperty('--sc', typeof col === 'string' && /^#[0-9a-f]{6}$/i.test(col) ? col : '#5a6672');
        const pl = document.createElement('span');
        pl.className = 'sub-plate';
        rc.append(pl, label);
        rc.addEventListener('click', () => openRoom(seat ? seat.room : rm.room));
      } else {
        rc.textContent = 'not in a room';
      }
      row.querySelector('.live-actions').before(rc); // after the name's own chips, before the buttons
    }
    if (needs) {
      row.classList.add('is-needy'); // a coral tint on a session that is waiting on you (the design system 1.K)
    }
    const w = s.widget;
    if (w && w.text) {
      const chip = document.createElement('span');
      chip.className = 'live-widget k-' + (w.kind || 'warn');
      chip.textContent = w.text;
      chip.title = 'Published by the tool itself' + (w.ts ? ' at ' + new Date(w.ts * 1000).toLocaleTimeString() : '');
      /* LOCAL CLOCK (Owner, 2026-09-03). When the tool publishes a deadline, the
         browser counts down from it every second instead of waiting for the
         engine to re-read a file. A countdown is the one thing a client can
         compute perfectly on its own, so polling for it is pure waste — and
         waiting on a poll is what made the number visibly lag. The engine's
         own refresh then only has to catch STATE changes (a renew, an expiry,
         a tool quitting), which is why it dropped from 10s to 60s. */
      if (w.expiresAt) {
        chip.dataset.expires = String(w.expiresAt);
        chip.dataset.prefix = w.text.replace(/\s*\d+h\d*m?\s*left\s*$/i, '').trim();
        tickChip(chip);
      }
      row.querySelector('.live-name').after(chip);
    }
    /* `where` YIELDS to the widget chip. The left column is ~690px and all
       three (name, meta, chip) do not fit — squeezed, the meta ellipsised down
       to a single stray character, which is worse than showing nothing. It is
       the right thing to drop because the RING already encodes attachment (a
       hollow centre is "nobody is here"), so "parked — no window" is the one
       piece of this row that is genuinely duplicated elsewhere. */
    /* DETAIL LIVES IN THE TOOLTIP, NOT ON THE ROW (Owner, 2026-09-03).
     *
     * The grey meta line cost more than it paid: it competed for width with the
     * session name — the one thing you actually scan for — and truncated it to
     * make room for text you only need when you are deciding something. Mousing
     * over is a cheap, deliberate act; reading a cluttered list is not.
     *
     * So the row's tooltip carries everything the meta used to, plus the ids
     * that were previously hidden behind it, one fact per line. The name now
     * gets the whole row. */
    row.title = [
      sessionName ? `Session:  ${sessionName}` : null,
      projectName ? `Project:  ${projectName}` : null,
      `State:    ${where}`,
      needs ? `Needs:    ${needs.slice('needs you: '.length)}` : null,
      !s.recipe_id && s.vendor ? `Kind:     ${s.vendor}` : null,
      w && w.text ? `Tool:     ${w.text}` : null,
      s.session_id && /^[0-9a-f-]{36}$/i.test(s.session_id) ? `Claude:   ${s.session_id}` : null,
      `Pane:     ${s.paneid}`,
    ]
      .filter(Boolean)
      .join('\n');
    paintRing(row.querySelector('[data-ring]'), s, 40, liveRings); // R2 as ruled: 40px glyph on a 64px row
    paintWatermarkMark(row.querySelector('[data-mark]'), s, rec);
    row.querySelector('[data-act="peek"]').addEventListener('click', async () => {
      const modal = document.getElementById('peekModal');
      const body = document.getElementById('peekBody');
      document.getElementById('peekTitle').textContent =
        `Recent output — ${s.friendlyName || rec?.name || s.paneid}`;
      body.textContent = 'loading…';
      modal.hidden = false;
      try {
        const r = await (await fetch(`/api/sessions/${encodeURIComponent(s.paneid)}/peek`)).json();
        // Strip ANSI/OSC control sequences — the replay is raw terminal bytes.
        body.textContent =
          (r.tail || '')
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
            .replace(/\x1b[=>]/g, '')
            .replace(/\r(?!\n)/g, '\n') || '(no output yet)';
      } catch {
        body.textContent = '(peek failed — session may have just ended)';
      }
    });
    row.querySelector('[data-act="open"]')?.addEventListener('click', async () => {
      try {
        /* Name the PANE, not just the project. This row knows exactly which
           session it is; sending only the recipe made every row of a
           multi-session project open the project's first pane. */
        await api.launch(s.recipe_id, { pane: s.paneid });
      } catch (err) {
        alert(err.message);
      }
    });
    if (s.recipe_id && (s.vendor === 'claude-code' || s.vendor === 'codex-cli')) {
      const more = moreButton('btn btn-ghost live-more', `More for ${s.friendlyName || rec?.name || s.paneid}`, (b) =>
        openAgentMenu({ anchor: b, paneid: s.paneid, label: s.friendlyName || rec?.name || s.paneid, tone: s.color || rec?.color || null, profile: s.profile ?? null, vendor: s.vendor ?? rec?.vendor ?? null }));
      row.querySelector('.live-actions').append(more);
    }
    row.querySelector('[data-act="end"]').addEventListener('click', async () => {
      if (confirm(`End "${s.friendlyName || s.paneid}"? This kills the CLI running in the broker.`)) {
        await fetch(`/api/sessions/${encodeURIComponent(s.paneid)}/end`, { method: 'POST' });
        await pollLive();
      }
    });
    list.appendChild(row);
  }

  /* Component panes, collected under one honest heading with a bulk End.
     They are real PTYs so they must stay visible and endable — but they are
     the workbench prototype's panes, not anyone's work, and saying so is the
     whole point. One button clears the lot rather than N confirmations. */
  if (componentPanes.length > 0) {
    const grp = document.createElement('div');
    grp.className = 'live-group';
    grp.innerHTML = `
      <div class="live-group-head">
        <span class="live-group-title"></span>
        <button class="btn btn-ghost" data-act="end-components">✕ End all</button>
      </div>`;
    grp.querySelector('.live-group-title').textContent =
      `${componentPanes.length} workbench component pane${componentPanes.length === 1 ? '' : 's'}`
      + ' — from the prototype at /index.html, not a project';
    grp.querySelector('[data-act="end-components"]').addEventListener('click', async () => {
      if (!confirm(`End ${componentPanes.length} component pane(s)? They are bare shells; no project uses them.`)) {
        return;
      }
      for (const c of componentPanes) {
        await fetch(`/api/sessions/${encodeURIComponent(c.paneid)}/end`, { method: 'POST' });
      }
      await pollLive();
    });
    for (const c of componentPanes) {
      const r2 = document.createElement('div');
      r2.className = 'live-row live-row-dim';
      r2.innerHTML = '<span class="live-name"></span><span class="live-meta dim"></span>';
      r2.querySelector('.live-name').textContent = c.vendor || '(component)';
      r2.querySelector('.live-meta').textContent =
        (c.attached ? 'open' : 'no window') + `  ·  ${c.paneid.slice(0, 8)}…`;
      r2.title = c.paneid;
      grp.appendChild(r2);
    }
    list.appendChild(grp);
  }
  applyRingContext(list, liveRings);
  layoutLiveWatermarks(list);
  list.append(newSessionCard); // "+ New agent session" ends the live list
}

/* ---- resume picker: the RECORDED sessions of one project folder ----
   The picker itself is web/resume-picker.mjs (shared with the + sheet's START
   FROM A PROJECT row); a pick here relaunches through the picker door. */
function openResumePicker(r) {
  openSharedResumePicker({
    recipe: r,
    onPick: async (s) => {
      try {
        await api.launch(r.id, { resumeSessionId: s.sessionId });
      } catch (err) {
        alert(err.message);
      }
    },
  });
}

/* ---- "Recently closed" (Edge-style): the RECORDED side of the seam — table
 * session facts (last claude session per pane, resumable via banked uuid),
 * distinct from the SAVED recipes below. Resume on a ✕-ended row asks the
 * engine to rehydrate it explicitly (launch {resume:true}). ---- */
function fmtSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function ago(ts) {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** File-explorer-style time bucket for a timestamp (Owner 2026-08-04): batches
 *  of windows closed together stay recognizable as a batch. */
function bucketOf(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOfDay(now);
  if (d.getTime() >= today) return 'Today';
  if (d.getTime() >= today - 86400000) return 'Yesterday';
  const dow = (now.getDay() + 6) % 7; // Monday-start week
  const weekStart = today - dow * 86400000;
  if (d.getTime() >= weekStart) return 'This week';
  if (d.getTime() >= weekStart - 7 * 86400000) return 'Last week';
  return 'Earlier';
}
const BUCKET_ORDER = ['Today', 'Yesterday', 'This week', 'Last week', 'Earlier'];
const MAX_GROUPS = 3; // deeper history lives in each agent's Resume dialog

function renderRecent() {
  /* ONE ROW PER SESSION, NOT PER PROJECT (Owner, 2026-09-09: "it makes more
     sense to be one per session and use the session naming because that's how
     the user would resume the work").

     This iterated RECIPES and looked up `recipe:<id>` — the project's PRIMARY
     pane only — so every extra session of a project was invisible here. Live at
     the time of the fix: three closed HomeHub sessions and two Briefing Table
     ones simply absent from the history, with no sign anything was missing.
     The live strip had already been through exactly this (2026-09-02, "two live
     Briefing Table sessions, one reachable"); the closed list never got the
     same pass, which is the same half-done shape the phone work hit. */
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const rows = [...rowByPane.values()]
    .map((row) => ({ row, r: recipeById.get(row.recipe_id) ?? null }))
    /* RECOVERABLE, not "has a banked uuid" — those are different sets.
       A named-resume recipe (`claude --resume "<name>"`) never banks a uuid:
       the id is genuinely unknowable, and this repo forbids putting the pty id
       there because it would masquerade as resumable. Filtering on session_id
       therefore hid an entire class of agent from the history — Owner went
       looking for a reaped server session on 2026-08-24 and found the column
       empty, even though its Resume dialog listed it fine. Both mechanisms
       recover; only one has a uuid to show. `resume_name` is read from the ROW
       first: it became a session fact in the multi-session work, so a second
       session's recovery no longer depends on its project's default. */
    /* AGENT_VENDORS, not a claude literal: "recently closed, and recoverable"
       is a property of any vendor with a resume, and hardcoding one brand here
       would hide the next one from the history exactly the way the missing
       named-resume clause hid server sessions in 2026-08-24. */
    .filter(({ r, row }) =>
      AGENT_VENDORS.includes(row.vendor) && row.state !== 'live'
      && (row.session_id || row.resume_name || (r?.resume && r?.resumeName)))
    .sort((a, b) => b.row.updated_at - a.row.updated_at);
  els.recent.hidden = rows.length === 0;
  historyCount = rows.length;
  els.recentList.innerHTML = '';
  const groups = new Map(); // bucket -> entries, insertion follows BUCKET_ORDER
  for (const b of BUCKET_ORDER) {
    groups.set(b, []);
  }
  for (const e of rows) {
    groups.get(bucketOf(e.row.updated_at)).push(e);
  }
  let shown = 0;
  let first = true;
  for (const b of BUCKET_ORDER) {
    const entries = groups.get(b);
    if (entries.length === 0 || shown >= MAX_GROUPS) {
      continue;
    }
    shown++;
    const det = document.createElement('details');
    det.className = 'recent-group';
    det.open = first; // newest group expanded, the rest collapsible
    first = false;
    const sum = document.createElement('summary');
    sum.textContent = `${b} (${entries.length})`;
    det.appendChild(sum);
    const groupRings = [];
    for (const { r, row } of entries) {
      const el = document.createElement('div');
      el.className = 'recent-row';
      /* WHICH session this row is. Several rows can now share a project and a
         name, so the paneid is the only thing that tells them apart — for a
         probe, and for anyone reading the DOM to answer "is my second session
         actually listed". */
      el.dataset.pane = row.paneid;
      el.style.setProperty('--sess-accent', r?.color || 'var(--teal)');
      el.innerHTML = `
        <span data-ring></span>
        <span data-mark></span>
        <span class="r-name"></span>
        <span class="r-meta"></span>
        <button class="btn" data-act="resume">Resume</button>`;
      paintRing(el.querySelector('[data-ring]'), row, 14, groupRings);
      paintMark(el.querySelector('[data-mark]'), row, r ?? {});
      /* THE SESSION, then the project — the same precedence the live strip
         uses, so one conversation reads identically wherever you meet it.
         `title` is the name Claude itself carries (a /rename, else its
         auto-title, else the last thing said in it) and is the string the
         Resume picker shows too. You resume a CONVERSATION, not a project. */
      const projectName = r?.name || row.friendlyName || null;
      const sessionName = row.title || null;
      el.querySelector('.r-name').textContent =
        sessionName || projectName || `(unnamed) ${row.paneid.slice(-8)}`;

      /* Show WHAT WILL BE RESUMED. A uuid-banked row shows its id; a
         named-resume row shows the name, which is the thing that actually
         identifies its conversation — and is what the user recognises. */
      const resumeName = row.resume_name || r?.resumeName || null;
      const how = row.session_id ? `${row.session_id.slice(0, 8)}…` : `"${resumeName}"`;
      /* The project joins the meta line once the name slot shows the session —
         otherwise several sessions of one project are indistinguishable, which
         is the defect this rewrite exists to fix. Omitted when it would merely
         repeat the name. */
      const proj = projectName && projectName !== el.querySelector('.r-name').textContent
        ? `${projectName} · ` : '';
      el.querySelector('.r-meta').textContent =
        `${proj}${row.state === 'dehydrated' ? 'interrupted' : 'closed'} ${ago(row.updated_at)} · ${how}`;
      el.title = row.session_id || `resumes by name: ${resumeName}`;
      /* An orphan row (its recipe was deleted) can still be listed — it is real
         history — but there is no project to launch it from, so say so rather
         than offering a button that cannot work. */
      const resumeBtn = el.querySelector('[data-act="resume"]');
      if (!r) {
        resumeBtn.disabled = true;
        resumeBtn.title = 'the project this session belonged to no longer exists';
      } else {
        resumeBtn.addEventListener('click', async () => {
          try {
            await api.launch(r.id, { resume: true, pane: row.paneid });
          } catch (err) {
            alert(err.message);
          }
        });
      }
      det.appendChild(el);
    }
    applyRingContext(det, groupRings);
    els.recentList.appendChild(det);
  }
}

/* ---- Edge-style "restore interrupted sessions?" offer ----
 * A recipe pane counts as interrupted when the engine's boot reconcile stamped
 * it (it was OPEN when the engine died — ✕-ended panes never get the stamp)
 * and it hasn't come back on its own (a respawn clears the stamp engine-side).
 *
 * WHICH of those stamps may be OFFERED is a rule with four clauses and a real
 * failure behind each one — it lives in restore-offer.mjs, where a test can run
 * it. All this function does is ask. */
function interruptedRecipes() {
  return pickInterrupted(recipes, (r) => rowByPane.get(`recipe:${r.id}`)).map((h) => h.recipe);
}

function renderRestoreOffer() {
  const hits = pickInterrupted(recipes, (r) => rowByPane.get(`recipe:${r.id}`));
  els.restoreBanner.hidden = hits.length === 0;
  if (hits.length > 0) {
    const names = hits.map((h) => h.recipe.name).join(', ');
    /* SAY WHEN. An undated "your last session was interrupted" is what let a
       day-old offer pass for this morning's — the age is the one fact that
       tells you whether the banner is about something you just lost. */
    const when = ago(hits[0].at);
    els.restoreMsg.textContent =
      `Interrupted ${when} — restore ${hits.length} CLI session${hits.length > 1 ? 's' : ''}? (${names})`;
  }
}

els.restoreAllBtn.addEventListener('click', async () => {
  for (const r of interruptedRecipes()) {
    try {
      await api.launch(r.id); // claude panes auto-resume engine-side; shells relaunch
    } catch (err) {
      alert(`${r.name}: ${err.message}`);
    }
  }
  await pollLive();
});

els.restoreDismissBtn.addEventListener('click', async () => {
  await fetch('/api/interrupted/dismiss', { method: 'POST' });
  await pollLive();
});

/* ---- form ---- */
/* WHICH VENDORS THE ENGINE HAS A MODULE FOR — i.e. which ones take a model and
   a resume rather than an init command. Mirrors src/engine/vendors/index.ts;
   `ollama` is an accepted VALUE with no module yet (contract
   §1.1 step 2), so they launch as class-2 CLIs from their init command, exactly
   like a shell. When a module lands for one, add it here. */
const VENDORS_WITH_OPTS = ['claude-code', 'gemini-cli', 'codex-cli'];
function vendorHasOpts() {
  return VENDORS_WITH_OPTS.includes(els.fVendor.value);
}
/* Model / effort options for the CURRENT vendor (vendor-profile.mjs). Keeps the
   chosen value when the new vendor also offers it, else falls back to Default. */
function fillVendorLists() {
  const v = els.fVendor.value;
  for (const [sel, list] of [[els.fModel, modelsFor(v)], [els.fEffort, effortsFor(v)]]) {
    const keep = sel.value;
    sel.replaceChildren(new Option('Default', ''), ...list.map((x) => new Option(x, x)));
    sel.value = list.includes(keep) ? keep : '';
  }
}
function syncFormVisibility() {
  const opts = vendorHasOpts();
  els.claudeOpts.style.display = opts ? '' : 'none';
  /* EFFORT is offered only where the vendor has a vocabulary for it (claude
     `--effort`, codex `-c model_reasoning_effort`); extra CLI arguments only for
     codex-cli, whose sandbox / network / writable roots differ per agent. */
  els.fEffort.closest('.f-row').hidden = effortsFor(els.fVendor.value).length === 0;
  els.fVendorArgsRow.hidden = els.fVendor.value !== 'codex-cli';
  els.fVendorFlagsRow.hidden = els.fVendor.value !== 'codex-cli';
  paintLegacyResume();
  // Class-2 recipes get an init command instead of CLI options.
  els.initCmdRow.style.display = opts ? 'none' : '';
  /* wr §2.9: only a brand agent derives a slug from its folder; a bare shell
     left empty gets none (src/engine/agent-slug.ts isBrandVendor). Keyed on
     'cli-manager', not on `opts` — codex-cli and ollama have no module yet but
     ARE brand vendors and do derive. */
  els.fAgent.placeholder = els.fVendor.value === 'cli-manager'
    ? 'empty = none (a terminal has no slug unless you type one)'
    : 'empty = <project folder>';
}
els.fVendor.addEventListener('change', () => {
  fillVendorLists();
  syncFormVisibility();
});

/* LEGACY NAMED RESUME (the design system, 2026-09-28). The "[ ] Resume" checkbox is gone:
   resume is a per-LAUNCH choice now (the card's Resume, the + sheet's
   New | Resume). A recipe that still carries one (`resume` / `resumeName`)
   says so in the checkbox's old slot, dim, with a Clear that takes effect ON
   SAVE (resume false, resumeName '') - never instantly, so Cancel still
   means cancel. Nothing else here edits it. */
let legacyResume = null; // {resume, resumeName} of the recipe in the form, or null
let legacyCleared = false;
function paintLegacyResume() {
  const el = els.fLegacyResume;
  el.textContent = '';
  const show = !!legacyResume && !legacyCleared && vendorHasOpts();
  el.hidden = !show;
  if (!show) {
    return;
  }
  const name = legacyResume.resumeName;
  el.append(name ? `Launches by resuming "${name}"` : 'Launches by opening the resume picker', ` ${String.fromCharCode(183)} `);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'f-legacy-clear';
  clear.textContent = 'Clear';
  clear.title = 'Stop resuming this by name. Takes effect when you Save.';
  clear.addEventListener('click', () => {
    legacyCleared = true;
    paintLegacyResume();
  });
  el.append(clear);
}

function openForm(r) {
  editingId = r ? r.id : null;
  els.formTitle.textContent = r ? `Edit — ${r.name}` : 'New session';
  els.fName.value = r?.name ?? '';
  els.fTarget.innerHTML = targets
    .map((t) => `<option value="${t.id}">${t.label}</option>`)
    .join('');
  els.fTarget.value = r?.target ?? targets[0]?.id ?? 'local';
  els.fDir.value = r?.projectDir ?? '';
  showDirWarning(null);
  els.fAgent.value = r?.agent ?? '';
  /* OLD RECIPES KEEP WORKING. A row written before the vendor column carries
     only `runClaude`; the store hydrates `vendor` from it on read, so this
     never has to do the derivation twice — but the `?? (runClaude ? ...)` is
     kept for a response that predates the column entirely. */
  els.fVendor.value = r ? (r.vendor ?? (r.runClaude ? 'claude-code' : 'cli-manager')) : 'claude-code';
  fillVendorLists();
  /* a stored model outside the list (a full id such as claude-opus-5-5) is
     kept as its own option, so opening and saving the form never drops it */
  for (const o of els.fModel.querySelectorAll('option[data-custom]')) {
    o.remove();
  }
  const model = r?.model ?? '';
  if (model && ![...els.fModel.options].some((o) => o.value === model)) {
    const o = new Option(model, model);
    o.dataset.custom = '1';
    els.fModel.append(o);
  }
  els.fModel.value = model;
  els.fEffort.value = r?.effort ?? '';
  els.fWorktree.value = r?.worktree === 'never' ? 'never' : 'auto';
  for (const cb of els.fVendorFlagsRow.querySelectorAll('input[data-flag]')) {
    cb.checked = Array.isArray(r?.vendorFlags) && r.vendorFlags.includes(cb.dataset.flag);
  }
  els.fVendorArgs.value = Array.isArray(r?.vendorArgs) ? r.vendorArgs.join(String.fromCharCode(10)) : '';
  legacyResume = r && (r.resume || r.resumeName) ? { resume: !!r.resume, resumeName: r.resumeName || null } : null;
  legacyCleared = false;
  els.fInitCmd.value = r?.initCmd ?? '';
  /* ART WINS (Owner, 2026-09-21): where the recipe's artwork states a color, the
     form SHOWS it and stops offering to change it here — the Icons page is the
     one place, so a project's VRPC and server recipes cannot drift apart again.
     The picker stays live for a recipe whose art has no color, which is every
     one of them until someone sets one. */
  setFormColor(r?.color && /^#/.test(r.color) ? r.color : '#22b8a8');
  {
    /* The ENGINE says where the color came from (`colorFrom`), so this page
       does not re-derive the rule from the logo library — two copies of one
       decision is how surfaces drift apart. */
    const owned = r?.colorFrom === 'art';
    els.fColorBtn.disabled = owned;
    els.fColorBtn.title = owned
      ? `Color comes from this project's artwork — change it on the Icons page`
      : 'Session color — the titlebar, the ground and the watermark all derive from this one value';
    if (els.fColorOwned) {
      els.fColorOwned.hidden = !owned;
    }
    if (owned) {
      closeColorPop();
    }
  }
  // (watermark input removed with the logo-parity work — the pref channel is
  // dormant; do NOT reference els.fWm here, it no longer exists in the form.)
  els.fFont.value = r?.fontSize ?? '';
  els.fDevFontVal.textContent = String(loadDeviceFont()?.px ?? FONT_DEFAULT);
  editingLogo = parseLogo(r?.logo);
  syncLogoBtn();
  syncFormVisibility();
  els.formModal.hidden = false; // modal — in focus regardless of list length
  els.fName.focus();
}

function closeForm() {
  els.formModal.hidden = true;
  editingId = null;
}
// No backdrop-click close for the FORM modal (unlike the resume picker) —
// a stray click must not discard half-filled recipe edits. Cancel closes it.

/* The last folder warning the user was shown, so a second Save means "yes, I
   know" and goes through. Without it a legitimately-absent folder -- a repo
   about to be cloned, a server asleep -- would be a form you cannot close. */
let ackedDirWarning = null;
function showDirWarning(text) {
  els.fDirWarn.hidden = !text;
  els.fDirWarn.textContent = text || '';
  if (!text) {
    ackedDirWarning = null;
  }
}

async function saveForm() {
  const name = els.fName.value.trim();
  if (!name) {
    alert('A session needs a name.');
    return null;
  }
  // NEVER let a save failure fall out of the click handler as an unhandled
  // rejection: that is exactly how an oversized-logo save read as "the Save
  // button does nothing" (2026-09-02). A failed save must SAY so.
  let saved;
  try {
    saved = await api.save({
      id: editingId ?? undefined,
      name,
      target: els.fTarget.value,
      projectDir: els.fDir.value.trim() || null,
      /* THE SELECT IS THE FIELD (vendor #2 arrived, so the picker did too).
         `runClaude` is still sent for an older engine and means exactly what it
         says — "this runs claude" — which is now one vendor among several,
         never a proxy for "runs some CLI". */
      vendor: els.fVendor.value,
      runClaude: els.fVendor.value === 'claude-code',
      /* Empty means DERIVE, and the engine does the deriving — normalisation
         has exactly one right answer and there is nothing for the user to
         decide about it (the projectDir rule, 2026-09-13). */
      agent: els.fAgent.value.trim() || null,
      model: vendorHasOpts() ? els.fModel.value.trim() || null : null,
      effort: effortsFor(els.fVendor.value).length ? els.fEffort.value || null : null,
      worktree: els.fWorktree.value === 'never' ? 'never' : 'auto', // Owner 2026-10-05, worktree convention
      /* one argument per line (engine/vendor-args.ts); sent for codex-cli only,
         null clears it for any other vendor */
      vendorArgs: els.fVendor.value === 'codex-cli' ? els.fVendorArgs.value : null,
      vendorFlags: els.fVendor.value === 'codex-cli' ? [...els.fVendorFlagsRow.querySelectorAll('input[data-flag]:checked')].map((cb) => cb.dataset.flag) : null,
      /* No control edits these any more: what the recipe had is kept, unless
         the legacy line's Clear was pressed (then both go, on this Save). */
      resume: !!legacyResume && !legacyCleared && legacyResume.resume,
      resumeName: legacyResume && !legacyCleared ? legacyResume.resumeName : '',
      initCmd: !vendorHasOpts() ? els.fInitCmd.value.trim() || null : null,
      color: els.fColor.value,
      fontSize: els.fFont.value.trim() ? Number(els.fFont.value) : null,
      logo: editingLogo ? JSON.stringify(editingLogo) : null,
    });
  } catch (err) {
    alert(`Could not save this session.\n\n${err.message}`);
    return null;
  }
  await refresh();
  /* SAVED EITHER WAY -- this only decides whether the form stays open. The
     engine already normalised the path (a trailing slash is fixed silently,
     there is nothing to ask), so anything reaching here needs a human: the
     folder is not on that machine, or the machine could not be reached. Show it
     beside the field, and let a second Save mean "I know". */
  if (saved.warning && saved.warning !== ackedDirWarning) {
    showDirWarning(`${saved.warning} — saved anyway. Save again to keep it.`);
    ackedDirWarning = saved.warning;
    els.fDir.focus();
    return null;
  }
  showDirWarning(null);
  /* Repaint the field with what was actually STORED, so an auto-fixed path is
     visible rather than something the form quietly disagrees with. */
  els.fDir.value = saved.recipe?.projectDir ?? '';
  /* Repaint the slug with what was STORED too, so a derived or normalised one
     is visible rather than leaving the field looking empty when it is not. */
  els.fAgent.value = saved.recipe?.agent ?? '';
  return saved.recipe;
}

document.getElementById('newBtn')?.addEventListener('click', () => openForm(null));
/* ---- SESSION COLOUR --------------------------------------------------------
 *
 * WHY THIS IS NOT JUST `<input type="color">` ANY MORE. It was, sitting
 * invisible (opacity 0) over a 26px swatch that painted a static grey glyph.
 * Two failures followed from that, and Owner hit both on 2026-09-21 ("i've lost
 * the ability to control the color of my windows ... they're locked on color"):
 *
 *   1. NO FEEDBACK. The form never showed a recipe's colour, so a recipe left
 *      at the teal default and one deliberately set to teal looked identical,
 *      and a change you did make showed nothing back.
 *   2. NO CONTROL IN THE NATIVE WINDOW. A bare colour input depends on the HOST
 *      opening an OS colour dialog. The browser does; the embedded CLI-Manager
 *      window does not, so clicking simply did nothing — which is exactly what
 *      "locked" feels like, with no error to explain it.
 *
 * So: the swatch PAINTS the current colour, and clicking opens a palette that
 * needs nothing from the host. The native input stays behind "Custom…" because
 * where a host does provide a picker it is still the best way to pick a shade
 * we did not think of.
 *
 * The palette is the tints the Icons page previews marks under, plus the
 * neutral — the same vocabulary, so a colour chosen here is one already known
 * to read correctly against the chrome.
 */
const FORM_TINTS = [
  '#e9edf1', '#428DF0', '#0dab49', '#9d4c01', '#22b8a8', '#0317b0', '#ba0d0d',
  '#ba08b4', '#982abc', '#155693', '#b86e22', '#0511ad',
];

function setFormColor(hex) {
  const v = /^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex : '#22b8a8';
  els.fColor.value = v;
  if (els.fColorBtn) {
    /* The swatch IS the colour — the whole point. A thin ring keeps a dark
       value visible against the form's own dark ground. */
    els.fColorBtn.style.background = v;
    els.fColorBtn.title = `Session color ${v} — the titlebar, the ground and the watermark all derive from it`;
  }
  if (els.fColorHex) {
    els.fColorHex.value = v;
  }
  if (els.fColorGrid) {
    els.fColorGrid.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-on', (b.dataset.hex || '').toLowerCase() === v.toLowerCase());
    });
  }
}

function buildColorPicker() {
  if (!els.fColorGrid) {
    return;
  }
  for (const hex of FORM_TINTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'f-colorchip';
    b.dataset.hex = hex;
    b.style.background = hex;
    b.title = hex;
    b.setAttribute('aria-label', `Set color ${hex}`);
    b.addEventListener('click', () => {
      setFormColor(hex);
      closeColorPop();
    });
    els.fColorGrid.appendChild(b);
  }
  const closeOnAway = (ev) => {
    /* The palette is a SIBLING of the swatch now (it is an inline row, not an
       overlay), so "outside" has to name both — miss that and a pointerdown on
       a chip closes the palette before its own click can land. */
    if (!els.fColorPop.hidden && !ev.target.closest('#fColorWrap') && !ev.target.closest('#fColorPop')) {
      closeColorPop();
    }
  };
  document.addEventListener('pointerdown', closeOnAway);

  els.fColorBtn.addEventListener('click', () => {
    const open = els.fColorPop.hidden;
    els.fColorPop.hidden = !open;
    els.fColorBtn.setAttribute('aria-expanded', String(open));
  });
  /* A hex typed by hand is applied only when it is COMPLETE — reacting to every
     keystroke would repaint the swatch through "#2", "#22", "#22b" and read as
     the control fighting the typist. */
  els.fColorHex.addEventListener('input', () => {
    const v = els.fColorHex.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      setFormColor(v);
    }
  });
  els.fColorNative.addEventListener('click', () => {
    els.fColor.click(); // a no-op in a host with no colour dialog, which is why it is not the only path
  });
  els.fColor.addEventListener('input', () => setFormColor(els.fColor.value));
}

function closeColorPop() {
  if (els.fColorPop) {
    els.fColorPop.hidden = true;
    els.fColorBtn?.setAttribute('aria-expanded', 'false');
  }
}

buildColorPicker();
setFormColor('#22b8a8');

els.fLogoBtn.addEventListener('click', () =>
  openLogoModal({
    current: editingLogo,
    /* The v21 watermark paints in the PROJECT hue and nothing else, so the
       preview is only honest in this recipe's colour — read live from the
       field, because the colour and the logo are often picked in one sitting. */
    color: els.fColor.value,
    onSave: (logo) => {
      editingLogo = logo;
      syncLogoBtn();
    },
  }),
);
/* Text size on THIS device (moved from the session bar). Writes the same
   localStorage key the session windows read; each open window picks it up via
   its `storage` listener, so this needs no engine round trip and no Save. */
function stepDeviceFont(delta) {
  const px = clampPx((loadDeviceFont()?.px ?? FONT_DEFAULT) + delta);
  saveDeviceFont(px);
  els.fDevFontVal.textContent = String(px);
}
els.fDevFontDec.addEventListener('click', () => stepDeviceFont(-1));
els.fDevFontInc.addEventListener('click', () => stepDeviceFont(1));
els.cancelBtn.addEventListener('click', closeForm);
/* ESCAPE IS THE EMERGENCY EXIT, and it is deliberately the LAST word.
 *
 * Owner, 2026-09-21, after a stray </div> put Save and Cancel outside the form's
 * scroll box: "the modal didn't have ESC key cancel. We should put that in as
 * an emergency backup so that we don't lock the modal if UI isn't visible."
 *
 * That is the right rule and it is not about this bug: a dialog whose only exit
 * is a button can always be trapped by a layout that hides the button — a long
 * warning, a narrow window, a field added next month. A keyboard route cannot
 * be pushed off-screen.
 *
 * Innermost first, so one press does the least surprising thing: an open colour
 * palette closes before the form does, and a form is never discarded while the
 * user was only dismissing something inside it. The FORM still does not close
 * on a backdrop click — a stray click must not discard half-filled edits — but
 * Escape is deliberate, not stray.
 */
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') {
    return;
  }
  if (els.fColorPop && !els.fColorPop.hidden) {
    closeColorPop();
    return;
  }
  const peek = document.getElementById('peekModal');
  if (peek && !peek.hidden) {
    peek.hidden = true;
    return;
  }
  if (els.formModal && !els.formModal.hidden) {
    closeForm();
  }
});

els.saveBtn.addEventListener('click', async () => {
  if (await saveForm()) {
    closeForm();
  }
});

/* ---- rooms (workrooms): list, open, create --------------------------------
 * The engine's GET /api/rooms verbatim: [{room, seats[]}], every seat's status
 * derived by the engine (workrooms-build §2.1). This list joins nothing. A room
 * opens as a TAB in this window when the manager is embedded (the shell marks
 * a /room.html tab as a workroom and draws its plate), else a browser tab. The
 * sessionId `room:<id>` is what makes a second Open focus the existing tab —
 * room.html announces the same id once it loads. */
let rooms = [];

function roomUrl(id, opts) {
  return `/room.html?room=${encodeURIComponent(id)}${opts?.settings ? '&settings=1' : ''}`; /* settings=1: land with Room settings open */
}

/* Opening a room never wakes its agents (Owner 2026-10-02, room line [ref]: the
   old `&reconnect=1` flag is gone); the room page's own "Reconnect agents"
   button does that. */
function openRoom(room, opts) {
  const url = roomUrl(room.id, opts);
  if (EMBEDDED) {
    window.parent.postMessage(
      { hwbOpenTab: { url: url, title: room.name, sessionId: `room:${room.id}` } },
      '*',
    );
    return;
  }
  openStandalone(url);
}

/* ---- Assemble room (the design notes §3.1) --------------------------
 * In a shell frame the modal pre-checks THIS window's session tabs, which only
 * the shell knows: ask with hwbTabsRequest, the shell answers hwbTabs
 * {paneids, active}. Standalone (phone, web) nothing is pre-checked. The
 * shell's status-menu entry arrives here as hwbAssemble {paneids, active}. */
function askShellTabs() {
  if (!EMBEDDED) {
    return Promise.resolve({ paneids: [], active: null });
  }
  return new Promise((resolve) => {
    const done = (v) => { window.removeEventListener('message', on); clearTimeout(t); resolve(v); };
    const on = (ev) => {
      if (ev.source === window.parent && ev.data?.hwbTabs) {
        const d = ev.data.hwbTabs;
        done({ paneids: Array.isArray(d.paneids) ? d.paneids : [], active: d.active || null });
      }
    };
    const t = setTimeout(() => done({ paneids: [], active: null }), 800); // an older shell never answers
    window.addEventListener('message', on);
    window.parent.postMessage({ hwbTabsRequest: true }, '*');
  });
}

function assemble(tabs) {
  openAddSheet({
    windowTabs: tabs.paneids,
    activePaneid: tabs.active,
    onSeated: (ans) => {
      void pollRooms();
      if (ans?.room?.id) {
        openRoom(ans.room);
      }
    },
  }).catch((e) => {
    const err = document.getElementById('roomErr');
    err.textContent = `Could not open Assemble room: ${e?.message ?? e}`;
    err.hidden = false;
    roomNewSheet.hidden = false; // the error is in the sheet: bring it back
  });
}

document.getElementById('assembleBtn').addEventListener('click', async () => {
  roomNewSheet.hidden = true; // the Assemble sheet takes over
  assemble(await askShellTabs());
});
window.addEventListener('message', (ev) => {
  if (ev.source === window.parent && ev.data?.hwbAssemble) {
    const d = ev.data.hwbAssemble;
    assemble({ paneids: Array.isArray(d.paneids) ? d.paneids : [], active: d.active || null });
  }
});

function roomMeta(room, seats) {
  const lead = seats.find((s) => s.id === room.lead_seat);
  const n = seats.length;
  const parts = [`${n} seat${n === 1 ? '' : 's'}`, lead ? `lead @${lead.handle}` : 'no lead'];
  if (room.state !== 'open') {
    parts.unshift(room.state);
  }
  return parts.join(' · ');
}

/* The Rooms section (web/manager-rooms.mjs): rooms as groups of their agents,
   hide / unhide, the Show hidden toggle. The manager only hands it the data. */
/* "+ New room" ENDS the rooms grid (the design system 1.K): a dashed card that opens the New-room sheet (a centred dialog on a PC, a
   bottom sheet on a phone) with its two paths on top: an empty room, or Assemble from agents. */
const roomNewCard = document.createElement('button');
roomNewCard.type = 'button';
roomNewCard.id = 'roomNewCard';
roomNewCard.className = 'plus-card';
roomNewCard.innerHTML = '<span class="pi" aria-hidden="true">+</span><span class="pt">New room</span><small>name it, choose agents</small>';
const roomNewSheet = document.getElementById('roomNewSheet');
/* BASIC: the New-room card and sheet become NEW SITE (Owner 2026-10-08, lead [ref]): one question, the name; POST /api/projects/new-site makes the
   folder, the maintainer and the room, and the person lands in that room. The Assemble path is gone with it (web/edition.css). */
void loadEdition().then((e) => {
  if (e !== 'basic') {
    return;
  }
  document.querySelector('#roomsWrap .mgr-col-head').textContent = 'Sites'; // Basic: Sites, Open, 1 agent (the design system)
  renderRooms(); // the cards drawn before /health answered say Room-words
  roomNewCard.querySelector('.pt').textContent = 'New site';
  roomNewCard.querySelector('small').textContent = 'just give it a name';
  document.querySelector('#roomNewSheet .rn-panel').setAttribute('aria-label', 'New site');
  document.querySelector('#roomNewSheet .rn-head span').textContent = 'New site';
  document.querySelector('#roomNewSheet .rn-paths').hidden = true;
  const input = document.getElementById('roomNewName');
  input.placeholder = 'Site name';
  input.setAttribute('aria-label', 'Site name');
  document.getElementById('roomNewBtn').textContent = 'Create site'; // not "New site" again: the title already says it
  /* a label over the field and one dim line under it (the design system, Basic design pass) */
  const form = document.getElementById('roomNewForm');
  if (!form.querySelector('.rn-lbl')) {
    const lbl = document.createElement('label');
    lbl.className = 'rn-lbl';
    lbl.htmlFor = 'roomNewName';
    lbl.textContent = 'Name';
    const hint = document.createElement('p');
    hint.className = 'rn-hint';
    hint.textContent = 'Your agent starts on it right away.';
    form.prepend(lbl);
    form.append(hint);
  }
});
function closeRoomNew() {
  roomNewSheet.hidden = true;
  roomNewCard.focus({ preventScroll: true });
}
function openRoomNew() {
  document.getElementById('roomErr').hidden = true;
  roomNewSheet.hidden = false;
  if (!matchMedia('(pointer: coarse)').matches) {
    document.getElementById('roomNewName').focus({ preventScroll: true }); // a touch screen never raises the keyboard on its own
  }
}
roomNewCard.addEventListener('click', openRoomNew);
document.getElementById('roomNewScrim').addEventListener('click', closeRoomNew);
document.getElementById('roomNewX').addEventListener('click', closeRoomNew);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !roomNewSheet.hidden) {
    e.preventDefault();
    closeRoomNew();
  }
});
const roomsView = createRoomsView({
  list: document.getElementById('roomList'),
  tail: roomNewCard,
  toggle: document.getElementById('roomsShowHidden'),
  openRoom: (room, _actions, opts) => openRoom(room, opts),
  openPane: async (recipeId, paneid) => {
    try {
      await api.launch(recipeId, { pane: paneid });
    } catch (err) {
      alert(err.message);
    }
  },
  colorOf: (recipeId) => recipes.find((r) => r.id === recipeId)?.color || null,
});
let seatedSig = '';
function renderRooms() {
  roomsView.render(rooms);
  /* a session that joins or leaves a room, or a room that is renamed, changes the chip on its live row */
  const sig = [...roomOfPanes(rooms)].map(([k, r]) => `${k}=${r.id}:${r.name}:${r.color ?? ''}`).sort().join(',');
  if (sig !== seatedSig) {
    seatedSig = sig;
    renderLive();
  }
}

async function pollRooms() {
  try {
    /* ?art=ref [perf/poll-traffic]: the manager never draws a room's art, so
       its poll leaves the SVG out (most of each room view) */
    const res = await fetch('/api/rooms?art=ref');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
    rooms = Array.isArray(body) ? body.filter((v) => v && v.room) : [];
  } catch {
    /* keep the last list: a blip must not blank the section */
    return;
  }
  renderRooms();
}

document.getElementById('roomNewForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = document.getElementById('roomNewName');
  const err = document.getElementById('roomErr');
  const name = input.value.trim();
  err.hidden = true;
  if (!name) {
    input.focus();
    return;
  }
  const btn = document.getElementById('roomNewBtn');
  btn.disabled = true;
  const label = btn.textContent;
  if (isBasic()) {
    btn.textContent = 'Making your site…'; // it makes a folder and starts an agent: seconds, not a blink
  }
  try {
    const res = await fetch(isBasic() ? '/api/projects/new-site' : '/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    if (!res.ok) {
      throw new Error(body?.error || `create failed (HTTP ${res.status})`);
    }
    /* POST answers the room itself; tolerate a {room} wrapper too */
    const room = body?.room?.id ? body.room : body;
    input.value = '';
    roomNewSheet.hidden = true;
    await pollRooms();
    if (room?.id) {
      openRoom(room);
    }
  } catch (e) {
    err.textContent = `Could not create the ${isBasic() ? 'site' : 'room'}: ${e.message}`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* ---- data refresh: recipes on demand, live state on a light poll ---- */
async function refresh() {
  [targets, recipes] = await Promise.all([api.targets(), api.recipes()]);
  await pollLive();
}

let lastPollAt = 0;
async function pollLive() {
  lastPollAt = Date.now();
  void pollRooms();
  try {
    const rows = await api.table();
    rowByPane = new Map(rows.map((s) => [s.paneid, s]));
  } catch {
    rowByPane = new Map();
  }
  render();
}

document.getElementById('peekCloseBtn').addEventListener('click', () => {
  document.getElementById('peekModal').hidden = true;
});
document.getElementById('peekModal').addEventListener('click', (ev) => {
  if (ev.target === document.getElementById('peekModal')) {
    document.getElementById('peekModal').hidden = true;
  }
});

/* Hub duties (window-host contract §7): embedded in the shell, the manager
 * declares the well-known hub id, which makes it the window's pinned hub chip.
 * The id is no longer an installation-wide singleton key — every window has its own
 * manager tab (Owner, 2026-08-18) — but the host still uses it to find A hub
 * when something asks for one. */
if (EMBEDDED) {
  window.parent.postMessage(
    { sessionId: 'cli-manager', hwbState: 'active-idle', title: 'Workbench' },
    '*',
  );
}

/* THE POLL PAUSES WHILE NOBODY CAN SEE IT [perf/poll-traffic]. In the shell
 * every window has its own manager tab, usually in the background, and a
 * display:none iframe still reads visibilityState 'visible', so this tick
 * pulled /api/table every 2.5 s from every window forever. isHidden() is the
 * shell's word (a hidden tab) or the browser's (a minimised window), see
 * web/page-visibility.mjs. */
let lastWake = Date.now();
refresh();
/* Hidden is slow, not silent: the rows' state still feeds the shell, so a
 * hidden tab refreshes via the same pollLive at most every HIDDEN_POLL_MS
 * (up to that old), a fraction of the visible traffic. Offline: no fetch. */
const HIDDEN_POLL_MS = 15000;
let lastHiddenPoll = 0;
setInterval(() => {
  tickDeviceReport('manager'); // user device presence rides this poll [user device presence]
  if (!isHidden()) {
    void pollLive();
  } else if (navigator.onLine !== false && Date.now() - lastHiddenPoll >= HIDDEN_POLL_MS) {
    lastHiddenPoll = Date.now();
    void pollLive().catch(() => {});
  }
}, 2500);
/* WAKE: shown, focused or restored. Background windows get their timers
 * THROTTLED by the browser (~1/min), so a manager left behind another window
 * showed stale status until touched (Owner, 2026-08-09): refresh the instant
 * it is visible or focused. ONE refresh per wake — it re-pulls the recipe
 * list (a theme/logo/name edited from a session window writes back to its
 * recipe) and then polls once — and at most one per 5 s: focus, pageshow and
 * visibilitychange used to fire pollLive AND refresh() each, ~1.6 MB per
 * alt-tab on Owner's table [perf/poll-traffic]. */
const WAKE_MIN_MS = 5000;
function wake() {
  if (isHidden() || Date.now() - lastWake < WAKE_MIN_MS) {
    return;
  }
  lastWake = Date.now();
  void refresh();
}
/* SHOWN (the shell brought this tab up, or the window came back): poll once
   now, whatever the throttle says — unless a wake or a tick just did. */
onVisibility((visible) => {
  if (!visible) {
    return;
  }
  if (Date.now() - lastWake >= WAKE_MIN_MS) {
    wake();
  } else if (Date.now() - lastPollAt > 1500) {
    void pollLive();
  }
});
window.addEventListener('focus', wake);
window.addEventListener('pageshow', wake);


/* Lay the manager out in the width the glass has — see web/screen-clamp.mjs. */
installScreenClamp();
