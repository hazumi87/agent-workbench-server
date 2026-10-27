/* Solo window (CLI Manager phase, 2026-07-07 rescope) — one CLI in one OS
 * window. Speaks the same closed contract vocabulary as workbench.js over the
 * shared transport; the pane head is the working titlebar. Theme edits made
 * here auto-save into the recipe (engine-side write-back). */
const BUILD = '2026-09-15-viewer-scroll';
console.log(`[solo] build ${BUILD}`);

import { enteringShell } from '/ipad-shell-gate.mjs'; // a touch tablet's agent page hands itself to the shell's tab strip (first, so nothing else starts) [ipad tabs]
import { Terminal } from '/vendor/xterm/xterm.mjs';
import { installScreenClamp, visibleWidth } from '/screen-clamp.mjs';
import { trackSoftKeyboard, touchInput } from '/soft-keyboard.mjs';
import { deviceLabel, startDeviceReport } from '/device-report.mjs'; // the label + the user-device presence report [user device presence]
import { isKeypadSeq } from '/keypad-keys.mjs'; // the room page's rail Keys block sends only these [ipad keys] // shared with the room page [web/solo-keybar-auto]
/* The SAME dual-ring renderer the CLI Manager uses. Importing it — rather than
   restyling a dot to look similar — is the point: HWB_CHROME_ALIAS is the one
   place the engine's activity vocabulary is translated, and a second copy is
   two copies. See the note above paintRing. */
import { hwbRing, hwbRingFromChrome, hwbRingLabel } from '/aurora/window-chrome/hwb-ring.js';
/* v21: the session bar is the bundle's (hwbRenderSessionBar), the brand mark
   comes from brand-marks v1, and the vendor -> brand join is ours (brand.mjs). */
import { hwbRenderSessionBar } from '/aurora/window-chrome/hwb-chrome.js';
/* the MCP indicator (window-chrome v27), looked up through the namespace so a
   pre-v27 pin is a no-op, never a module-link error (web/mcp-bar.mjs) */
import * as hwbChromeNS from '/aurora/window-chrome/hwb-chrome.js';
import { createMcpView } from '/mcp-bar.mjs';
import { openExternal } from '/open-external.mjs'; // links out (the host / the shell relay / a new window)
import { brandMarkPath } from '/aurora/brand-marks/aurora-brand-marks.js';
import { loadBrands, brandFor } from '/brand.mjs';
import {
  loadDeviceFont, saveDeviceFont, resolveFont, clampPx, FONT_DEFAULT,
} from './term-font.mjs';
import { FitAddon } from '/vendor/xterm/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/xterm/addon-web-links.mjs';
import { createTransport } from '/transport.mjs';
import { renderLogo, parseLogo, paintWatermarkVars, sanitizeSvg, wmFields } from '/logo-modal.mjs';
import { extractUrls } from '/link-sweep.mjs';
import { mountHeldBar } from '/held-bar.mjs';
import { createMic, attachMic, micFromPaneVoice, fetchMicState, toggleMic, MIC_EVENT } from '/voice-mic.mjs';
void enteringShell; // evaluated for its side effect: on a touch tablet it never settles, so this page does not start [ipad tabs]
// Preset table, for deriving a logo KEY from a stored SVG (see applyPrefs).
let logoPresets = null;
import('/vendor/aurora-logo-presets.js')
  .then((m) => {
    logoPresets = m.LOGO_PRESETS ?? null;
  })
  .catch(() => {});

const recipeId = new URLSearchParams(location.search).get('recipe');
// Per-launch model override (launch-new dropdown) — rides the URL so it reaches
// the engine at attach time; only applies when the attach SPAWNS a new session.
const modelOverride = new URLSearchParams(location.search).get('model');
// ...and the per-launch --effort override, the same way (the engine validates it).
const effortOverride = new URLSearchParams(location.search).get('effort');
/* The pane this window drives.
 *
 * A project's FIRST session keeps the historical id `recipe:<id>` — existing
 * rows, bookmarks and window-dedupe URLs all carry it, and changing it would
 * orphan them for no gain. Additional sessions in the same project arrive with
 * an explicit `?pane=`, which is how a project stops being capped at one:
 * the paneid is a handle now, not a description of which project it belongs to.
 * The engine records that association in a column (recipe_id). */
const paneid = new URLSearchParams(location.search).get('pane') || `recipe:${recipeId}`;

/* The status ring is built here, not in the markup: it rides INSIDE the v21
   session bar, whose innerHTML the bundle rebuilds on every render, so it is
   re-prepended after each one (paintBar). One element for the page's life. */
const ringEl = document.createElement('span');
ringEl.className = 'pane-ring';
ringEl.dataset.build = BUILD;
const els = {
  pane: document.getElementById('pane'),
  dot: ringEl,
  sbar: document.getElementById('sbar'),
  viewBadge: document.getElementById('viewBadge'),
  reload: document.getElementById('reloadBtn'),
  relaunch: document.getElementById('relaunchBtn'),
  logo: document.getElementById('paneLogo'),
  body: document.querySelector('.pane-body'),
  term: document.getElementById('term'),
  themeColor: document.querySelector('meta[name="theme-color"]'),
};

function fatal(message) {
  document.body.innerHTML = `<div style="padding:24px;font-family:var(--mono);color:var(--coral)">${message}</div>`;
  throw new Error(message);
}
if (!recipeId) {
  fatal('missing ?recipe=<id>');
}

/* ---- terminal (same design-token theming rules as workbench.js) ---- */
function auroraTheme(fgOverride, cursorOverride) {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return {
    background: 'rgba(0,0,0,0)', // element bg owns the surface (see solo.css)
    foreground: fgOverride || v('--text'),
    cursor: cursorOverride || v('--teal'),
    selectionBackground: v('--surface3'),
  };
}

const term = new Terminal({
  fontFamily:
    getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
  fontSize: 16,
  cursorBlink: true,
  /* xterm's default is 1000 LINES, which silently became the second ceiling
     once the engine's replay cap was raised — no point shipping 2MB the
     terminal will not keep. Lines, not bytes, so a repaint-heavy TUI cannot
     consume it the way it consumes the engine's byte budget. */
  scrollback: 5000,
  theme: auroraTheme(),
});
const fit = new FitAddon();
term.loadAddon(fit);
// URLs in agent output become links (Owner 2026-08-07): hover underlines,
// Ctrl+click (xterm's default, so plain clicks still move the cursor /
// select) opens in a browser window. Handler passed explicitly so the
// behavior is ours, not the addon default's window.open quirks.
term.loadAddon(
  new WebLinksAddon((ev, uri) => {
    openExternal(uri);
  }),
);
term.open(els.term);
/* THE CELL WIDTH IS MEASURED ONCE, AT OPEN — a late web font makes it wrong.
   --mono is "JetBrains Mono" with font-display: swap, so when the font has not
   arrived yet xterm measures the FALLBACK (8.8px vs 9.6px at 16px), fits ~9%
   too many columns, and every full-width line then runs one glyph past the
   text box and is clipped mid-letter (Owner 2026-09-25: "platfo|r", "agen|t" in
   some sessions only - the ones whose font lost the race). xterm has no public
   re-measure and does not watch document.fonts; changing fontFamily is what
   makes it measure again, so nudge it off and back once the face is in, then
   refit. Skipped when the font was already loaded at open (the common case). */
{
  const spec = `${term.options.fontSize}px ${term.options.fontFamily}`;
  if (document.fonts && !document.fonts.check(spec)) {
    document.fonts.load(spec).then(() => {
      const ff = term.options.fontFamily;
      term.options.fontFamily = `${ff}, monospace`;
      term.options.fontFamily = ff;
      fitAndSend();
    }).catch(() => { /* the fallback measure stands; nothing better to do */ });
  }
}
// Stale-window diagnosis without DevTools (Owner 2026-08-09): the BUILD rides
// the ring as data-build and the viewport beacon (the v21 bar has no status
// word to hover any more).

const transport = createTransport();

/* Declared HERE, above its first reader, so module-evaluation order is not
   load-bearing — the control-lease block further down only assigns it. */
let controlling = true;

function fitAndSend() {
  if (els.term.offsetWidth === 0 || els.term.offsetHeight === 0) {
    return;
  }
  try {
    fit.fit();
  } catch {
    return;
  }
  /* Only the CONTROLLER may resize: there is exactly ONE pty behind this pane
     and its geometry is shared by every viewer, so a paused viewer refitting
     would either be refused by the engine (pane.control-denied) or, worse,
     re-wrap the CLI under the person actually typing. A watcher's font change
     therefore restyles locally and leaves the pty's columns alone. */
  if (!controlling) {
    return;
  }
  /* FIT NOW, TELL THE PTY IN A MOMENT. A freshly opened tab reports geometry
     that is not yet true — twice in the diagnostics a new window came up at
     771x290 (landscape-shaped, cols 113) before settling to 398x542 portrait
     (cols 45) a second or two later. Sending both hands the CLI a width it
     never had, and claude redraws its whole UI on SIGWINCH: it repaints at 113
     columns and then has no reason to repaint again until you type, so the
     window sits there rendered for a screen you do not have. Local fitting
     stays immediate — only the announcement waits for the geometry to hold
     still. */
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    transport.send({ type: 'resize', paneid, cols: term.cols, rows: term.rows });
  }, 250);
}
let resizeTimer = null;
new ResizeObserver(fitAndSend).observe(els.term);

/* ---- font size: PER DEVICE, not per session (see web/term-font.mjs).
 * It used to be written back to the engine on every click, so a size chosen on
 * the laptop followed the session home to the VRPC. The device now owns its
 * size; the engine's pref only seeds a device that has no opinion yet. ---- */
let fontSize = FONT_DEFAULT;
let deviceOwnsFont = loadDeviceFont() !== null;
function applyFontSize(px, source) {
  const next = clampPx(px);
  fontSize = next;
  term.options.fontSize = next;
  fitAndSend(); // a font change alters cols/rows → refit (controller only)
  if (source === 'user') {
    saveDeviceFont(next);
    deviceOwnsFont = true; // from now on, engine prefs no longer move this pane
  }
}

/* Sibling tabs in one shell window are separate documents, each holding a
   load-time snapshot of the shared key. Without this, changing the size in one
   tab leaves the others stale until reload — one key showing two values. */
/* Apply this device's size immediately at boot, before any engine round trip:
   the terminal should never render at one size and then jump to another. */
{
  const stored = loadDeviceFont();
  if (stored) {
    applyFontSize(stored.px, 'boot');
  }
}

/* THE CONTROLS, both writing the same device key.
 *
 * Desktop: Ctrl+wheel, the gesture every terminal already has, so it needs no
 * discovery. Touch: A−/A+ on the LAST page of the keypad (buildTouchKeypad) —
 * not a floating widget over the terminal, which is chrome that makes a small
 * screen smaller for something you set once (Owner, 2026-09-20).
 *
 * Both write the SAME device key, because size belongs to the screen and not
 * to the session (term-font.mjs).
 */

/* Ctrl+wheel — the Terminal gesture. `passive: false` because we preventDefault
   to stop the browser's own page zoom taking the gesture instead; bound on the
   pane body so it works anywhere over the terminal, including the scrim. */
(els.body || document.body).addEventListener('wheel', (ev) => {
  if (!ev.ctrlKey) {
    return;
  }
  ev.preventDefault();
  applyFontSize(fontSize + (ev.deltaY < 0 ? 1 : -1), 'user');
}, { passive: false });

window.addEventListener('storage', (ev) => {
  if (ev.key !== 'wb-termfont') {
    return;
  }
  const rec = loadDeviceFont();
  if (rec && rec.px !== fontSize) {
    deviceOwnsFont = true;
    applyFontSize(rec.px, 'sync');
  }
});

/* ---- window-host embedding (slice b, contract KB design-notes-id §7/§7.5):
 * when this page runs INSIDE the shell's iframe, it emits its state in the
 * ENGINE'S NATIVE vocabulary ({hwbState, title, base, logo}) — the chrome's
 * bridge aliases it (2026-08-09 flip: content lane owns what states MEAN).
 * window.close() is a no-op in an iframe, so embedded close paths speak
 * {hwbCloseResult} instead. ---- */
/* A seat framed inside a ROOM page (room nav v3, `inroom=1`) is not a shell
 * tab: nothing above it draws a session bar, so it draws its own (MCP strip,
 * icons) exactly as a standalone window does. */
const embedded = window.parent !== window && !new URLSearchParams(location.search).has('inroom');
/* A ROOM'S OWN VIEW of a seat: framed in a room page (inroom) or a room member
   frame in the shell (roomframe). Its attach says so, and the engine never
   counts it as a window (the seat menu's Close window leaves it alone). */
const roomFrame = window.parent !== window
  && (new URLSearchParams(location.search).has('inroom') || new URLSearchParams(location.search).has('roomframe'));
if (embedded) {
  // The shell draws the tab (ring, title) AND the v21 session bar for this
  // page; drawing our own bar as well would be two bars. See paintBar().
  document.documentElement.classList.add('is-embedded');
}
let lastEmit = {};
function emitToShell(patch) {
  /* STATE FIRST, DELIVERY SECOND. What this window would tell the chrome does
     not depend on anyone listening — tracking it above the embed check keeps a
     standalone window (and the probe) able to see the payload, and stops the
     two modes drifting into different code paths. */
  const before = lastEmit.hwbState;
  lastEmit = { ...lastEmit, ...patch };
  window.__lastEmit = lastEmit;
  if (!embedded) {
    return;
  }
  window.parent.postMessage({ ...lastEmit }, '*');
  /* REPORT WHAT WE TOLD THE CHROME. Two of Owner's tabs vanished on 2026-09-04
     with both sessions still live, and nobody could answer "did the engine ask
     for that?": the shell's log only exists when DEBUG is on and the engine
     cannot see a postMessage. Only the state CHANGES — the shell is told the
     full object every time, but a log wants events. Fire-and-forget: a
     diagnostic must never be able to fail the page that sends it. */
  if (lastEmit.hwbState !== before) {
    try {
      void fetch('/api/diag/chrome', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paneid, detail: `-> shell hwbState=${lastEmit.hwbState}` }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* never throws into the emit path */
    }
  }
}
const NATIVE_STATE = {
  streaming: 'active-streaming',
  /* v21 `background` (output, no claude turn) — the bundle's AB·B state. */
  background: 'active-background',
  waiting: 'attention',
  /* v33 (ticket): blocked on a prompt you have SEEN, not answered — the
     still coral double ring, no demand flash. The shell maps it back through
     the bundle's own alias table. */
  'waiting-seen': 'attention-seen',
  idle: 'active-idle',
  disconnected: 'alert',
};
// FIRST WORD to the chrome, before any engine traffic: a tab must never sit
// stateless while we connect. Corrected the moment pane.ready lands.
emitToShell({ hwbState: 'alert', title: document.title || 'Session' });

/* TYPE IMMEDIATELY after a tab switch (Owner 2026-08-12). The shell focuses our
 * iframe's WINDOW on activate, but xterm's input is a hidden textarea inside
 * it — without this last hop the click lands on the tab and the first
 * keystrokes go nowhere. Never steal focus while a dialog is open (the ✕
 * choice and the links list own the keyboard when they are up). */
/* NO PROGRAMMATIC FOCUS ON A TOUCH SCREEN (Owner 2026-09-29, room-wide rule).
 * There a focus raises the soft keyboard — and with it the key bar — over
 * whatever the user was looking at. Only xterm's own tap-to-focus may do it
 * there; every place this page used to call term.focus() comes through here. */
const COARSE_POINTER = touchInput(); // a coarse pointer, or an iPad in desktop-class mode [ipad keypad]
function focusTerm() {
  if (!COARSE_POINTER) {
    term.focus();
  }
}
function focusTerminal() {
  const modalOpen = [...document.querySelectorAll('.close-modal')].some((m) => !m.hidden);
  if (modalOpen) {
    return;
  }
  try {
    focusTerm();
  } catch {
    /* terminal not ready yet — pane.ready focuses too */
  }
}
window.addEventListener('focus', focusTerminal);
// Belt for shells that reveal a hidden frame WITHOUT focusing it: the pane
// becoming visible is itself the signal.
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) {
    focusTerminal();
    noteAttention('visible');
  }
}).observe(els.pane);

/* ---- ATTENTION (Owner, 2026-09-04) -----------------------------------------
 * "i alt-tabbed to the window from another. it was still flashing. i clicked on
 * the window, still flashing. It was only after I went to the cli manager tab
 * and back that it stopped."
 *
 * The engine had no attention input at all — `waiting` ended only on output or
 * the Stop hook. Switching tabs away and back worked ONLY because the repaint
 * on reveal is output; it looked like attention detection and never was.
 *
 * PER PANE, NOT PER WINDOW. A window holds many tabs and only the one you land
 * on has been seen; clearing every tab's alert on window focus would silently
 * discard signals, which is worse than the bug. Inside the shell each tab is
 * its own iframe, so `document.hasFocus()` here is true only when focus is
 * genuinely inside THIS pane — the grain falls out of the embedding for free.
 *
 * ON THE TRANSITION, never on a poll: an ack is an event ("a human arrived"),
 * and repeating it every second would bury the log the same way keystrokes did.
 * The engine ignores an ack for a pane that is not demanding, so a spurious one
 * costs nothing — but it would still cost a log line. */
let engaged = false;
function noteAttention(how) {
  if (document.visibilityState === 'hidden') {
    return; // a hidden tab cannot have been seen, whatever else is true
  }
  if (engaged) {
    return;
  }
  engaged = true;
  transport.send({ type: 'attention.ack', paneid, how });
}
function dropAttention() {
  engaged = false;
}
/* The three gestures Owner named, plus the one the shell gives us. `focus` fires
 * on alt-tab INTO the window and on a click that lands inside the pane; the
 * pointer/key listeners cover a click that lands on chrome first; the observer
 * above covers a shell that reveals a hidden frame without focusing it. */
window.addEventListener('focus', () => noteAttention('focus'));
window.addEventListener('blur', dropAttention);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    dropAttention();
  } else {
    noteAttention('visible');
  }
});
document.addEventListener('pointerdown', () => noteAttention('pointer'), { capture: true });
document.addEventListener('keydown', () => noteAttention('key'), { capture: true });

/* ---- ONE status glyph, ONE vocabulary (Owner 2026-09-01) --------------------
 * The titlebar used to paint a hand-rolled dot while the CLI Manager painted
 * the design system dual ring, so the same session looked like two different things
 * depending on which surface you were on — cognitive load with nothing bought
 * for it (Owner's call: "while defensible, the difference is more cognitive load
 * on the user").
 *
 * The divergence was not cosmetic. The dot keyed its amber "needs you" pulse on
 * `data-activity="question"`, a token the engine STOPPED emitting when activity
 * was renamed to `waiting` to match the design system alias table (see
 * src/engine/activity.ts). The status WORD tracked the rename; the dot did not.
 * So a CLI blocked on Owner said "needs you" in text beside a plain green dot,
 * and had done since the rename. That is exactly the failure HWB_CHROME_ALIAS
 * exists to prevent — its own header says it ships as CODE "so the bridge
 * implements nothing and cannot drift from it" — and we had drifted by not
 * using it. Going through hwbRingFromChrome makes the class of bug impossible
 * rather than fixing this one instance of it.
 *
 * NO applyContext here: that rule exists to stop a LIST of rings becoming a
 * blinking wall, by letting only the highest-priority glyph animate. One window
 * is a single-session context, where every state animates as designed. */
let ringLifecycle = 'connecting';
let ringActivity = '';
let lastExit; // 'ok' | 'fail' once the process has exited — the ended ring's verdict
/* The brand join key, from pane.ready (`unknown` until then -> generic). */
let vendor = 'unknown';

function paintRing() {
  /* Same shape as the manager's ringSpecFor — lifecycle first, activity only
     while live, so a dead session can never render as busy. */
  const chrome = ringLifecycle === 'live' ? (ringActivity || 'idle') : 'ended';
  const spec = hwbRingFromChrome(chrome, { attached: transport.status === 'open', exit: lastExit });
  /* v21 treatment 16: the brand plate + mark, 28px — the same glyph the tab
     draws (hwb-chrome's one tab size). A plate carries no viewer dot, which is
     the v21 ruling ("no viewer/source dot anywhere"). */
  const b = brandFor(vendor);
  hwbRing(els.dot, spec, 28, { brand: b.brand, markPath: brandMarkPath(b.brand) });
  els.dot.title = hwbRingLabel(spec);
}

function setState(state) {
  ringLifecycle = state;
  if (state === 'live') {
    lastExit = undefined;
  }
  paintRing();
  els.relaunch.hidden = state === 'live';
}

/* Activity overlay on the lifecycle dot (vk [ref]): while live, the dot +
 * status word show what the CLI is DOING — streaming / needs you (question) /
 * live (idle). Transport loss paints disconnected locally (the engine can't
 * tell us it's gone). */
function setActivity(a) {
  ringActivity = a || '';
  paintRing();
  // Emit REGARDLESS of lifecycle state (fixed 2026-08-09, Owner saw `-`): a
  // window opened while the engine is still booting — the normal case right
  // after a PC restart — never reaches 'live', so a live-gated emit left the
  // tab stateless. `disconnected` in particular MUST reach the chrome.
  emitToShell({ hwbState: NATIVE_STATE[a] ?? 'active-idle' });
}

/* ---- paint prefs: name/title, accent (head + native titlebar tint), fg/bg,
 * ghosted logo. The engine stores; this window paints. ---- */
let currentLogo = null; // parsed {svg,scale,mono,opacity} or null — what the modal edits
let wmColor = null; // recipe colour, for the v21 --wm-pc pane var

/* THE SESSION, then the project — the same precedence the CLI Manager's rows
 * use (ticket), so one conversation reads identically wherever you meet it.
 * The tab used to carry the PROJECT name alone, which is the same string for
 * every session of that project and never moves: renaming the chat changed the
 * manager row and left the tab saying "Briefing Table" (Owner, 2026-09-13).
 * `sessionTitle` arrives on pane.ready and again on every pane.title push, so
 * it is kept beside the prefs rather than folded into them — one is the name
 * the user set on the PANE, the other is the name the CONVERSATION carries. */
let lastPrefs = null;
let sessionTitle = null;
function displayName() {
  return sessionTitle || lastPrefs?.friendlyName || 'Session';
}
/* Everywhere this window says what it IS — head strip, document title, shell
   tab — as ONE call, so a name arriving down either channel repaints all three.
   Separate from applyPrefs because a title push must not be gated on prefs
   having landed first. */
function paintName() {
  const name = displayName();
  // Informative title; the chrome truncates, we don't.
  emitToShell({ title: name });
  document.title = name;
  paintBar();
}

/* ---- THE SESSION BAR (the design system window-chrome v21) ---------------------------
 * ONE bar, drawn in ONE place. Its data is assembled here, always:
 *   - inside the window-host shell, it goes UP as {hwbBar} and the SHELL draws
 *     it under the tab row for whichever tab is selected (that is where the
 *     bundle's bar wash can be centred on the selected tab);
 *   - opened on its own (a plain browser tab), this page draws it into #sbar,
 *     with the status ring prepended because there is no tab to carry it.
 * The bar's icons emit hwb:messages / hwb:handoff / hwb:links; the shell
 * forwards those to this page as {hwbBarAction}, and both routes land on the
 * SAME existing modals (openFabric / openHandoff / openLinks).
 *
 * Counts: messages = pending fabric envelopes; handoff = fields handed over;
 * links = pending agent URL OFFERS (the thing the icon's tooltip names). The
 * links icon opens the link list (offers still show in their own bar). */
let handoffCount = 0;
let urlOfferCount = 0;
let fabricCount = 0;
/* The voice channel's mic (ticket): null = the engine has voice switched off,
   so the bar shows no mic at all; else {open, focused, held, undelivered} for
   THIS pane (counts). It rides barModel() like the other icons' counts, so the
   shell draws it from the model; standalone, ONE element for the page's life is
   re-attached after every render (the status-ring pattern), never recreated. */
let micState = null;
const micEl = createMic();
/* [concierge] the solo window head's icon (hidden when off, and in Basic) */
let cgBtn = null;
import('/concierge.mjs')
  .then((m) => {
    cgBtn = m.conciergeButton('sb-ib sb-cg');
    els.sbar.append(cgBtn);
  })
  .catch((e) => console.warn('concierge icon failed', e));

/** The project mark as SVG markup for the bar (and the shell's tab watermark).
 *  Prefer the pane's own rendered copy: fitViewBox has given it a viewBox,
 *  which a bare stored <svg> may lack and a 28px box needs. The copy drops the
 *  watermark's own classes so .wm rules cannot leak into the bar. */
function projectMarkSvg() {
  if (!currentLogo?.svg) {
    return '';
  }
  const shown = els.logo.querySelector('svg');
  if (shown && shown.hasAttribute('viewBox')) {
    const c = shown.cloneNode(true);
    c.removeAttribute('class');
    c.removeAttribute('style');
    return c.outerHTML;
  }
  return sanitizeSvg(currentLogo.svg);
}

/* NO AGENT CHAT HERE (Owner 2026-10-14): an agent outside a room is its CLI and nothing else; chat features need a room.
   The window keeps its titlebar, ring and activity. (The engine chat routes and agent-chat.mjs stay: the Concierge uses them.) */

function barModel() {
  const b = brandFor(vendor);
  return {
    project: {
      name: lastPrefs?.friendlyName || '',
      mark: projectMarkSvg(),
      color: lastPrefs?.color || null,
      /* window-chrome v32: the mark draws with the art's line style + glow,
         read exactly as the pane's own watermark reads it (wmFields). The
         shell uses it for the TAB's watermark too (tabs[].logoStyle). */
      markStyle: currentLogo?.svg ? (({ line, backlit }) => ({ line, backlit }))(wmFields(currentLogo)) : null,
    },
    /* The bar says project THEN session; when the conversation has no title of
       its own yet, the project name alone is the honest reading. */
    title: sessionTitle || '',
    vendor,
    brand: b.brand,
    brandColor: b.brandColor,
    messages: fabricCount,
    handoff: handoffCount,
    links: urlOfferCount,
    voice: micState,
    view: null,
  };
}

/* THE AGENT PAGE'S MENU [phone menu] (the design system handoff 1.O, Owner 2026-10-07): the same four-square button as the room page's header; its sheet
   is "Workbench" first (back to the Workbench), then the room THIS agent sits in (one tap to it). Built on the first tap so a page that never
   opens it pays nothing. Standalone only: framed in the shell or a room, the host has its own way. */
const placesMenu = window.parent === window
  ? (() => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sb-places';
      b.title = 'Menu';
      b.setAttribute('aria-label', 'Menu');
      b.setAttribute('aria-haspopup', 'dialog');
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>';
      b.addEventListener('click', () => {
        openMenu().catch((e) => {
          console.warn('menu failed', e);
          const body = document.getElementById('phSheetBody');
          body.textContent = `Could not load: ${String(e?.message ?? e)}`;
          document.getElementById('phScrim').hidden = false;
          document.getElementById('phSheet').hidden = false;
        });
      });
      return b;
    })()
  : null;
let menuWired = false;
function closeMenu() {
  document.getElementById('phScrim').hidden = true;
  document.getElementById('phSheet').hidden = true;
}
/** The room this pane is seated in ({id, name}), or null: the list the Workbench page itself reads. */
async function roomOfThisPane() {
  const list = await fetch('/api/rooms?art=ref').then((x) => (x.ok ? x.json() : null)).catch(() => null);
  for (const v of Array.isArray(list) ? list : []) {
    if ((v.seats ?? []).some((st) => (typeof st.occupant === 'object' ? st.occupant?.id : null) === paneid)) {
      return { id: v.room.id, name: v.room.name };
    }
  }
  return null;
}
async function openMenu() {
  const body = document.getElementById('phSheetBody');
  document.getElementById('phSheet').setAttribute('aria-label', 'Menu');
  if (!menuWired) {
    menuWired = true;
    document.getElementById('phScrim').addEventListener('click', closeMenu);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !document.getElementById('phSheet').hidden) {
        closeMenu();
      }
    });
  }
  const room = await roomOfThisPane();
  body.textContent = '';
  const wb = document.createElement('button');
  wb.type = 'button';
  wb.id = 'phWorkbench';
  wb.className = 'ph-wbrow';
  wb.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>';
  const wt = document.createElement('span');
  wt.className = 'wt';
  const wbT = document.createElement('b');
  wbT.textContent = 'Workbench';
  const wbS = document.createElement('small');
  wbS.textContent = 'all your rooms and sessions';
  wt.append(wbT, wbS);
  wb.append(wt); // it goes BACK: no drill-in chevron (the design system); the Room row below keeps its ›
  wb.addEventListener('click', () => window.location.assign('/manager.html'));
  body.append(wb);
  if (room) {
    const h = document.createElement('h3');
    h.textContent = 'Room';
    const r = document.createElement('button');
    r.type = 'button';
    r.id = 'phRoomRow';
    r.className = 'ph-roomrow';
    const rt = document.createElement('span');
    rt.className = 'wt';
    const rn = document.createElement('b');
    rn.textContent = room.name;
    const rs = document.createElement('small');
    rs.textContent = 'the room this agent sits in';
    rt.append(rn, rs);
    const rc = document.createElement('span');
    rc.className = 'pc';
    rc.textContent = '\u203a';
    r.append(rt, rc);
    r.addEventListener('click', () => window.location.assign(`/room.html?room=${encodeURIComponent(room.id)}`));
    body.append(h, r);
  }
  document.getElementById('phScrim').hidden = false; // nothing is focused: a phone keyboard / ring must not move on open
  document.getElementById('phSheet').hidden = false;
}

let barRaf = 0;
function paintBar() {
  /* Coalesced to one per frame: prefs, title, counts and the logo's viewBox
     fit (which lands a frame late) all call this. */
  if (barRaf) {
    return;
  }
  barRaf = requestAnimationFrame(() => {
    barRaf = 0;
    const m = barModel();
    if (embedded) {
      els.sbar.hidden = true;
      emitToShell({ hwbBar: m });
      return;
    }
    hwbRenderSessionBar(els.sbar, { ...m, brandMarkPath: brandMarkPath(m.brand) });
    els.sbar.prepend(els.dot);
    if (placesMenu) {
      els.sbar.prepend(placesMenu); // leftmost, re-attached after every render like the ring
    }
    attachMic(els.sbar, micEl, micState); // ours, re-attached after EVERY render (voice-mic.mjs)
    if (cgBtn) {
      els.sbar.append(cgBtn); // [concierge] ours too, re-attached after every render
    }
    els.sbar.hidden = false;
  });
}
function onBarAction(kind) {
  if (kind === 'messages') {
    openFabric();
  } else if (kind === 'handoff') {
    openHandoff();
  } else if (kind === 'links') {
    openLinks();
  } else if (kind === 'voice') {
    void onMicClick();
  }
}
async function onMicClick() {
  if (!micState) {
    return;
  }
  micState = (await toggleMic(paneid, micState)) ?? micState;
  paintBar();
}
async function refreshMic() {
  const s = await fetchMicState(paneid);
  /* Open/focused from the route; the held/undelivered counts belong to
     pane.voice, which may already have landed — keep them. */
  micState = s ? { ...s, held: micState?.held ?? 0, undelivered: micState?.undelivered ?? 0 } : null;
  paintBar();
}
els.sbar.addEventListener(MIC_EVENT, () => onBarAction('voice'));
['messages', 'handoff', 'links'].forEach((k) => {
  els.sbar.addEventListener(`hwb:${k}`, () => onBarAction(k));
});
loadBrands().then(() => {
  paintRing();
  paintBar();
});
function applyPrefs(prefs) {
  if (!prefs) {
    return;
  }
  lastPrefs = prefs;
  if (prefs.color) {
    }
  paintName();
  // Shell chrome facts (the title goes up in paintName above):
  // hwbBase = the ONE identity color (v2 model), hwbLogo = a preset KEY
  // (never SVG markup). Field names are the shell's: hwbBase/hwbLogo —
  // bare `base`/`logo` are ignored (found live 2026-08-09: tabs fell back
  // to auto-assigned identity colors).
  // Our stored logos are {svg,scale,mono,opacity} — SVG blobs, no key (the
  // modal predates the shell's key contract). The shell wants a preset KEY,
  // so DERIVE it by matching the stored svg against the pinned preset table;
  // an explicit `key` (future modal writes) wins. No match = send nothing and
  // let the shell assign — never send markup (Owner/window-host 2026-08-12:
  // every tab wore the same mark because we never sent a key at all).
  const logoKey = (() => {
    try {
      const parsed = prefs.logo ? JSON.parse(prefs.logo) : null;
      if (typeof parsed?.key === 'string') {
        return parsed.key;
      }
      if (typeof parsed?.svg !== 'string' || !logoPresets) {
        return undefined;
      }
      const norm = (v) => v.replace(/\s+/g, '');
      const want = norm(parsed.svg);
      return Object.keys(logoPresets).find((k) => norm(logoPresets[k]) === want);
    } catch {
      return undefined;
    }
  })();
  emitToShell({
    hwbBase: prefs.color || undefined,
    ...(logoKey ? { hwbLogo: logoKey } : {}),
  });
  if (prefs.color) {
    els.pane.style.setProperty('--pane-accent', prefs.color);
    els.themeColor.content = prefs.color; // Edge app-window titlebar tint
  }
  // ONE COLOR (v2, supersedes the M4 three-channel pin): --pane-base drives
  // the titlebar wash, terminal ground and watermark via oklch derivation in
  // CSS. Stored fg/bg are DORMANT — no longer read, columns kept.
  if (prefs.color) {
    els.pane.style.setProperty('--pane-base', prefs.color);
  }
  term.options.theme = auroraTheme(null, prefs.color || null);
  // bg goes on .pane-body (NOT .pane-term): the watermark layer sits between
  // the body bg and the transparent terminal rows, so bg + watermark + text
  // are all visible — the workbench's "bg hides watermark" trade doesn't apply
  // to a solo window where Owner wants both.
  // ground comes from CSS derivation now, not a stored bg
  try {
    term.refresh(0, term.rows - 1);
  } catch {
    /* first paint uses the theme */
  }
  currentLogo = parseLogo(prefs.logo);
  wmColor = prefs.color || null;
  renderLogo(els.logo, currentLogo, { pane: els.body }); // v21 .wm-pane / .wm / .wm-backlit (hwb-watermark.css)
  paintWatermarkVars(els.pane, currentLogo, wmColor); // --wm-pc / --wm-op
  paintBar(); // the mark / colour / project name live in the bar too
  /* SEED ONLY. pane.ready fires again on every reattach and pane.prefs echoes on
     every rename/recolor, so without this guard a reconnect would drag the
     laptop back to whatever the VRPC last chose. */
  if (!deviceOwnsFont) {
    const { px } = resolveFont(null, prefs.fontSize);
    applyFontSize(px, 'seed');
  }
}

/* ---- wire input + controls ---- */
term.onData((d) => {
  if (!controlling) {
    /* Only TYPING re-raises the prompt. Claude Code enables focus reporting
       (`?1004h`), so merely tapping the terminal makes xterm emit `ESC[I`, and
       a TUI with mouse tracking on would emit SGR mouse reports for the same
       tap — neither is a person asking to drive. */
    const isReport = d === '\x1b[I' || d === '\x1b[O' || /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(d);
    if (!isReport) {
      reraiseControlPrompt(); // surface the prompt instead of silently dropping
    }
    return;
  }
  /* TYPING INTO A SOCKET THAT IS NOT OPEN MUST SAY SO. The adapter queues it
     (which is right — a two-second blip should not lose a line), but queueing
     in silence is what made a five-minute stall indistinguishable from a
     working terminal: the keys vanished and then arrived all at once
     (Owner, 2026-09-21). So the pane admits it is holding them. */
  if (transport.status !== 'open') {
    queuedKeys += d.length;
    showQueued();
  }
  transport.send({ type: 'input', paneid, data: d });
});

/* A strip, not a modal: the session is fine and the keys are not lost, so this
   is news rather than an interruption — and it clears itself the moment the
   socket is back and the queue has gone out. */
let queuedKeys = 0;
function showQueued() {
  let el = document.getElementById('queuedKeys');
  if (!el) {
    el = document.createElement('div');
    el.id = 'queuedKeys';
    el.className = 'pane-queued';
    (els.body || document.body).appendChild(el);
  }
  el.hidden = false;
  el.textContent = `Reconnecting — ${queuedKeys} keystroke${queuedKeys === 1 ? '' : 's'} held, they will be sent`;
}
function clearQueued() {
  queuedKeys = 0;
  const el = document.getElementById('queuedKeys');
  if (el) {
    el.hidden = true;
  }
}

/* Terminal-feel keys (Windows Terminal conventions, Owner 2026-08-04):
 * - Ctrl+C COPIES when a selection exists (plain ^C interrupt otherwise);
 *   Ctrl+V pastes via the browser's NATIVE paste path (xterm handles the
 *   paste event with bracketed-paste, so multi-line pastes don't submit
 *   every line as its own prompt). Ctrl+Shift+C/V keep working natively.
 * - Ctrl+Enter / Shift+Enter insert a NEWLINE instead of submitting: the
 *   browser sends a bare \r for both, so we substitute ESC+CR (Meta+Enter),
 *   which claude's input treats as insert-line-break. */
term.attachCustomKeyEventHandler((ev) => {
  if (ev.type !== 'keydown') {
    return true;
  }
  const plainCtrl = ev.ctrlKey && !ev.shiftKey && !ev.altKey;
  if (plainCtrl && ev.code === 'KeyC' && term.hasSelection()) {
    navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
    return false;
  }
  if (plainCtrl && ev.code === 'KeyV') {
    // Return false ONLY: xterm must not emit ^V; the browser's paste event
    // fires and OUR capture handler below owns it. Do NOT also read the
    // clipboard here: two paths = double paste (Owner hit this 2026-08-05).
    return false;
  }
  if ((ev.ctrlKey || ev.shiftKey) && ev.key === 'Enter') {
    transport.send({ type: 'input', paneid, data: '\x1b\r' });
    return false;
  }
  return true;
});
/* ✕ = CLOSE THE WINDOW, LEAVE THE CLI RUNNING (Owner, 2026-09-12: "hitting x in
 * a session header doesnt ask whether to kill the cli in the broker or not.
 * just have it close the window and leave the cli in the broker").
 *
 * This used to open a two-way choice (End = kill, Hide = park). The dialog was
 * added in 2026-08-06 because ✕ was destructive and needed a confirm — but the
 * answer was Hide essentially every time, so the prompt taxed the common path
 * to guard a rare one. Removing the destructive option removes the need to ask
 * at all: there is nothing left to confirm.
 *
 * ENDING A SESSION IS STILL REACHABLE — the CLI Manager's live strip has "✕ End"
 * per session, which is the right home for it: you end a session you can SEE in
 * a list, not one you happen to have a window on. Deliberately NOT keeping a
 * hidden modifier (shift-click to kill) — an invisible destructive path is worse
 * than a visible one.
 *
 * `park` pins the session against the close-grace reaper so the broker keeps the
 * PTY; the manager's "Open window" reattaches it.
 */
function closeWindowKeepSession() {
  transport.send({ type: 'park', paneid });
  if (embedded) {
    /* ack-then-result, both immediately: the shell waits for an ack before its
       timeout and then for a verdict. There is no dialog to hold it open now,
       so it gets both in the same beat. */
    window.parent.postMessage({ hwbCloseAck: true }, '*');
    setTimeout(() => window.parent.postMessage({ hwbCloseResult: 'parked' }, '*'), 120);
  } else {
    // Give `park` a beat to leave the socket before the window dies.
    setTimeout(() => window.close(), 150);
  }
}
// Shell → page: the tab ✕ asks us. Same answer, no question. (v21: the tab ✕
// opens the bundle's close-or-end popover; its "close the view" lands here.)
// And the shell's session-bar icons, forwarded to the page that owns the data.
window.addEventListener('message', (ev) => {
  if (!embedded || ev.source !== window.parent || ev.origin !== location.origin) {
    return; // L7: only our own shell, same origin
  }
  if (ev.data?.hwbClose) {
    closeWindowKeepSession();
  } else if (typeof ev.data?.hwbBarAction === 'string') {
    onBarAction(ev.data.hwbBarAction);
  } else if (isKeypadSeq(ev.data?.hwbKeys) && ev.origin === location.origin) {
    /* THE ROOM'S RAIL KEYS BLOCK [ipad keys]: the keypad's keys, pressed outside this frame. Same rule as the
       keypad: a viewer does not type (it re-raises the control prompt instead). */
    if (controlling) {
      transport.send({ type: 'input', paneid, data: ev.data.hwbKeys });
    } else {
      reraiseControlPrompt();
    }
  }
});

els.relaunch.addEventListener('click', () => {
  term.reset();
  // `spawn:true` — a click is a human asking for a CLI, which a page load is not.
  transport.send({
    type: 'attach', paneid, recipe: recipeId, model: modelOverride ?? undefined, effort: effortOverride ?? undefined,
    label: CLIENT_LABEL, spawn: true, roomFrame: roomFrame || undefined,
  });
});
/* Name / colour / logo / text size moved to the CLI Manager's recipe form
   (v21 ruling). They still reach this window: the recipe save pushes
   pane.prefs (handled by applyPrefs), and the per-device text size arrives
   through the `storage` listener above when the form changes it. */
// Soft-reload: re-fetch the app UI (static assets are served no-cache, so this
// picks up code changes) while the resident PTY stays alive — the socket drops,
// the engine keeps the session for the solo grace window, and the reloaded page
// reattaches by paneid + replays the buffer. The agent chat is not disturbed.
els.reload.addEventListener('click', () => location.reload());
/* The same act, pushed from the engine (POST /api/reload-ui). Reloads the PAGE
   only — the pty is in the broker, so the socket reconnects and replays. */
transport.on('pane.reload-ui', () => location.reload());

/* CLOSE WINDOW, pushed from a room's seat menu (POST
 * /api/rooms/:id/seats/:seatId/close-window, Owner 2026-09-28). Not End, not
 * Disconnect: the session stays live (the engine parks it unless a room's own
 * framed view keeps it); this is only the view going, the same act as the ✕.
 *   - a shell tab: the ✕ path (ack + result 'parked'); the shell drops the tab
 *   - a standalone window: park, then window.close()
 * A room's own framed view (roomFrame) is never sent it, and ignores it.
 * Whatever cannot close itself (a browser tab the user opened: window.close()
 * is ignored) must not be left LOOKING live, and must not keep counting as a
 * window: it shows "window closed" with Reopen and lets go of its socket.
 * Reopen is a page load, which attaches as reclaim, never a spawn. */
let closedEl = null;
function showWindowClosed() {
  if (closedEl) {
    return;
  }
  pausedEl.hidden = true;
  closedEl = document.createElement('div');
  closedEl.className = 'pane-paused pane-closed';
  closedEl.innerHTML =
    '<div class="pane-paused-card">'
    + '<div class="pane-paused-who">Window closed</div>'
    + '<div class="pane-paused-sub">This window was closed from a room. '
    + 'The session keeps running. Reopen it here or from the room.</div>'
    + '<div class="pane-paused-actions">'
    + '<button class="btn btn-accent" data-act="reopen">Reopen</button>'
    + '</div>'
    + '</div>';
  closedEl.querySelector('[data-act="reopen"]').addEventListener('click', () => location.reload());
  (els.body || document.body).appendChild(closedEl);
  transport.close();
}
transport.on('pane.close-window', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  window.__closeWindowPushes = (window.__closeWindowPushes ?? 0) + 1;
  if (roomFrame) {
    return; // a room's framed view gets pane.frame-closed instead (engine)
  }
  closeWindowKeepSession();
  /* still here after the close had its chance: it could not close */
  setTimeout(showWindowClosed, embedded ? 2000 : 500);
});
/* A room's seat menu closed this seat's windows (Owner 2026-10-03): the engine
   tells every room-FRAME socket, not just windows. Hand it up to the room page
   framing us; it drops the frame and shows the room chat, never a blank
   column. A roomframe in the shell has a parent that ignores the message. */
transport.on('pane.frame-closed', (msg) => {
  if (msg.paneid === paneid && roomFrame) {
    window.parent.postMessage({ hwbFrameClosed: paneid }, '*');
  }
});
// Show it only when the engine reports the dev flag (config.json debugUi).
fetch('/health')
  .then((r) => r.json())
  .then((h) => {
    els.reload.hidden = !h.debugUi;
  })
  .catch(() => {});

/* ---- touch keypad: the keys a phone does not have -------------------------
 *
 * Owner, on his phone: a CLI was sitting on a Claude Code question — the kind
 * whose own footer reads "Enter to select · Tab/Arrow keys to navigate · Esc to
 * cancel" — and a soft keyboard offers none of those. The session was reachable
 * and completely un-answerable.
 *
 * So: a small pad, TOUCH SURFACES ONLY, that sends the escape sequences a
 * physical keyboard would. Esc and Tab ride along with the arrows and Enter
 * because that prompt names all five; leaving them out would fix the demo and
 * not the problem.
 *
 * Gated on `(pointer: coarse)` — "the primary pointing device is imprecise" —
 * rather than on user-agent sniffing or screen width. A desktop with a mouse
 * reports `fine` even with a touchscreen attached, and a phone in landscape is
 * still a phone. `?keys=1` / `?keys=0` overrides it either way, because a
 * heuristic that cannot be overridden is a trap.
 */
function buildTouchKeypad() {
  const override = new URLSearchParams(location.search).get('keys');
  const wanted = override === '1'
    || (override !== '0' && COARSE_POINTER);
  if (!wanted) {
    return;
  }
  const pad = document.createElement('div');
  pad.className = 'keypad';
  pad.innerHTML = `
    <button class="keypad-toggle" type="button" aria-expanded="false"
            aria-label="Show keys"></button>
    <div class="keypad-grid" hidden>
      <!-- ORDER IS PRIORITY, not layout: pages are cut from this list by how
           many MEASURE as fitting, so whatever is first is what page 1 shows.
           Up, down, Enter and ctrl-enter lead (Owner 2026-10-13: the
           most used), then paste: last of page 1 when five fit, else first of
           page 2. Esc, tab, left, right, backtick and text size follow. -->
      <div class="keypad-keys">
        <button type="button" data-seq="&#x1b;[A" aria-label="Up">↑</button>
        <button type="button" data-seq="&#x1b;[B" aria-label="Down">↓</button>
        <button type="button" data-seq="&#xd;" class="kp-enter" aria-label="Enter">⏎</button>
        <button type="button" data-seq="&#x1b;&#xd;" class="kp-wide"
                aria-label="Newline (ctrl+enter)">⏎+</button>
        <button type="button" class="kp-paste" aria-label="Paste">📋</button>
        <button type="button" data-seq="&#x1b;" class="kp-wide">esc</button>
        <button type="button" data-seq="&#x9;" class="kp-wide">tab</button>
        <button type="button" data-seq="&#x1b;[D" aria-label="Left">←</button>
        <button type="button" data-seq="&#x1b;[C" aria-label="Right">→</button>
        <button type="button" data-seq="&#x60;" aria-label="Backtick">\`</button>
        <button type="button" class="kp-font" data-font="-" aria-label="Smaller text">A−</button>
        <button type="button" class="kp-font" data-font="+" aria-label="Larger text">A+</button>
      </div>
      <button class="kp-nav" type="button" hidden aria-label="More keys">›</button>
    </div>`;
  (els.body || document.body).appendChild(pad);

  const grid = pad.querySelector('.keypad-grid');
  const toggle = pad.querySelector('.keypad-toggle');
  /* THE TOGGLE IS A CHEVRON (Owner, 2026-09-29, IMG_7673: the ⌨ emoji clipped
     and sat unevenly, and with the keyboard on screen "keyboard" says nothing).
     "‹" while the bar is shown — it points the way the bar collapses, and is
     never mistaken for the terminal's "›" prompt; "›" while it is hidden. An
     inline SVG stroked in currentColor, not a glyph: a font's chevron sits on
     the font's baseline and metrics, an SVG sits in the middle of its box. */
  const CHEVRON = { hide: '15 5 8 12 15 19', show: '9 5 16 12 9 19' };
  const paintToggle = (open) => {
    toggle.innerHTML = `<svg class="kp-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><polyline points="${open ? CHEVRON.hide : CHEVRON.show}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    toggle.dataset.dir = open ? 'hide' : 'show';
    toggle.setAttribute('aria-label', open ? 'Hide keys' : 'Show keys');
  };
  const setOpen = (open) => {
    grid.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    paintToggle(open);
    pad.classList.toggle('is-open', open);
    if (open) {
      layoutPages();
      requestAnimationFrame(layoutPages);
    }
  };
  paintToggle(false);

  /* THE BAR FOLLOWS THE SOFT KEYBOARD (Owner, 2026-09-29).
   *
   * These are the keys the soft keyboard lacks, so they are wanted exactly
   * while it is up: the bar opens BY ITSELF on every keyboard-up, sitting on
   * the keys (solo.css `html.kb-up .keypad.kp-auto`), and with the keyboard
   * down the whole pad — bar AND its toggle — is gone (display: none), giving the
   * reader every row. The toggle stays only as the way to collapse the bar for
   * space while typing, and that choice lasts until the keyboard goes down: the
   * next keyboard-up opens it again.
   *
   * `kp-auto` needs the shared tracker (web/soft-keyboard.mjs), which runs on
   * a coarse pointer. `?keys=1` on a desktop has no tracker, so it keeps the
   * old manual pad: the icon always there, the bar on a tap. */
  const auto = softKb.active;
  let collapsed = false; // the user's toggle tap, for THIS keyboard-up only
  let kbWasUp = false;
  const followKeyboard = (up) => {
    if (up && !kbWasUp && !collapsed) {
      setOpen(true);
    } else if (!up && kbWasUp) {
      collapsed = false;
      setOpen(false);
    }
    kbWasUp = up;
  };
  if (auto) {
    pad.classList.add('kp-auto');
    window.addEventListener('soft-kb', (e) => followKeyboard(e.detail?.up === true));
  }
  /* ON POINTERDOWN + preventDefault, like the keys and the page turner:
     tapping the icon must not take focus off the terminal, or collapsing the
     bar would also drop the keyboard it sits on. And the toggle happens HERE,
     not on click: WebKit fires no click after a cancelled touch pointerdown
     (measured, the keybar probe), so a click handler never ran on the phone.
     A click with detail 0 is keyboard activation (Enter/Space on a desktop
     `?keys=1` pad), which has no pointerdown. */
  const flip = () => {
    const open = grid.hidden;
    setOpen(open);
    if (auto) {
      collapsed = !open;
    }
  };
  toggle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    flip();
  });
  toggle.addEventListener('click', (ev) => {
    if (ev.detail === 0) {
      flip();
    }
  });

  /* The pad OVERLAYS the terminal rather than shortening it — see the
     `.keypad` rules in solo.css for why a 47px strip can float where the old
     3x3 block could not. No height to publish, and no refit on open: the
     terminal keeps every row it had. */

  /* PASTE — the other half of "reachable but unusable".
   *
   * Owner photographs his screen, uploads it to the agent-share, taps its "copy
   * url"… and then cannot get that url into the session, because a soft
   * keyboard has no Ctrl+V and xterm has nothing to catch. The clipboard was
   * full and the terminal was unreachable from it.
   *
   * `click`, NOT pointerdown-with-preventDefault like the keys: reading the
   * clipboard needs user activation, and iOS shows its own "Paste" confirmation
   * on the gesture. The keys suppress the default to keep the soft keyboard up;
   * paste does not need that, because it re-focuses the terminal itself.
   *
   * Routed through sendPastedText so it takes the SAME bracketed-paste path as
   * a desktop Ctrl+V — a pasted multi-line block must not submit itself line by
   * line here either. */
  async function pasteFromClipboard() {
    if (!controlling) {
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendPastedText(text);
      }
    } catch {
      /* Denied, unsupported, or an insecure context. Say so locally — this is a
         term.write, so it never reaches the pty. */
      term.write(
        '\r\n\x1b[2m[paste: the browser would not hand over the clipboard - '
        + 'long-press the terminal and use Paste instead]\x1b[0m\r\n',
      );
    }
  }

  /* PAGES, NOT A SCROLL — Owner's call, 2026-09-01: "a button bar nav that lets
   * us have multiple pages of buttons and move between the pages easily".
   *
   * Scrolling worked but asked the finger to do two different things on the
   * same strip, and the tap-vs-drag threshold that separates them is a
   * judgement call that will occasionally be wrong. Paging removes the
   * ambiguity instead of tuning it: every touch on a key is a key press, and
   * moving between pages is its own button.
   *
   * How many fit is MEASURED, not assumed — so a phone gets two pages, a tablet
   * one, and the nav button hides itself when everything already fits. */
  const keysEl = pad.querySelector('.keypad-keys');
  const navEl = pad.querySelector('.kp-nav');
  const allKeys = [...keysEl.children];
  let page = 0;
  /* The REAL page count, written by layoutPages() (which is the only thing that
     knows perPage). The nav handler used to re-derive it from the number of
     VISIBLE keys, but on the last page that is the remainder — 1 of 9 keys at
     perPage 4 gives pages=9, so page went to 3 and layoutPages() clamped it
     straight back to the last page. 3/3 never wrapped to 1/3. Never guess a
     value its owner already computed. */
  let pageCount = 1;

  function layoutPages() {
    if (grid.hidden) {
      return;
    }
    for (const k of allKeys) {
      k.hidden = false;
    }
    navEl.hidden = true;
    const avail = grid.clientWidth - 6;
    const widths = allKeys.map((k) => k.getBoundingClientRect().width + 3);
    const total = widths.reduce((a, w) => a + w, 0);
    let perPage = allKeys.length;
    if (total > avail) {
      // the nav button costs room too, so it is part of the budget
      const budget = avail - 33; // the nav button (30) plus its gap
      let used = 0;
      perPage = 0;
      for (const w of widths) {
        if (used + w > budget) {
          break;
        }
        used += w;
        perPage += 1;
      }
      perPage = Math.max(1, perPage);
      navEl.hidden = false;
    }
    const pages = Math.ceil(allKeys.length / perPage);
    pageCount = pages;
    page = Math.min(page, pages - 1);
    allKeys.forEach((k, i) => {
      k.hidden = Math.floor(i / perPage) !== page;
    });
    navEl.textContent = pages > 1 ? `${page + 1}/${pages}` : '›';
  }

  navEl.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); // keep focus, exactly like the keys
    page = (page + 1) % Math.max(1, pageCount);
    layoutPages();
  });

  for (const b of allKeys) {
    /* pointerdown + preventDefault, NOT click: a tap that lets the browser move
       focus dismisses the soft keyboard, so the next tap fights to get it back.
       With paging there is no drag to disambiguate — a touch on a key is
       always a key press. */
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (!controlling) {
        reraiseControlPrompt(); // a keypad key is typing; the engine would refuse anyway
        return;
      }
      if (b.classList.contains('kp-paste')) {
        pasteFromClipboard();
        return;
      }
      /* TEXT SIZE, LAST IN THE LIST ON PURPOSE (Owner, 2026-09-20: "we can take
         the widget off the phone screen or we can put it on a 3rd keyboard
         screen"). Order here is priority and pages are cut by what measures as
         fitting, so trailing keys land on the LAST page — reachable, and never
         displacing a key you reach for mid-sentence. It is also why this
         belongs here rather than floating over the terminal: a permanent
         widget makes a small screen smaller to solve a rare need. */
      if (b.dataset.font) {
        applyFontSize(fontSize + (b.dataset.font === '+' ? 1 : -1), 'user');
        return;
      }
      transport.send({ type: 'input', paneid, data: b.dataset.seq });
    });
  }
  new ResizeObserver(layoutPages).observe(grid);
  /* A second pass next frame: the first runs before the flex row has settled,
     and a page that keeps one key too many is exactly what that costs. */
  requestAnimationFrame(layoutPages);
  /* the tracker ran its first sync before this pad existed: a page that loads
     with the keyboard already up opens the bar now */
  if (auto) {
    followKeyboard(document.documentElement.classList.contains('kb-up'));
  }
}

/* ---- touch scrolling ------------------------------------------------------
 * xterm puts `.xterm-screen` and `.xterm-viewport` side by side, not nested:
 * the viewport is the scrollable one, but a finger lands on the SCREEN, whose
 * ancestors contain nothing scrollable. So the browser scrolls the page (which
 * cannot move) and the terminal sits there ignoring you — "i cant scroll the
 * screen with touch either" (Owner, 2026-09-01). A mouse wheel works because
 * xterm handles the wheel event itself; touch has no such path.
 *
 * So drive xterm's own scrollback directly, in whole ROWS, keeping the
 * remainder so a slow drag still accumulates instead of quantising to nothing.
 *
 * THE CONTROL PROMPT IS MODAL, AND SCROLLING DOES NOT GO THROUGH IT
 * (Owner, 2026-09-15). The viewer scrim (`.pane-paused`) is a sibling of #term
 * that covers the whole body, and since page loads attach as `reclaim`
 * (2026-09-07) a phone opened beside a desktop window IS a viewer — so every
 * finger landed on the scrim and nothing scrolled. The first fix listened on
 * the body so a drag scrolled THROUGH the prompt; Owner rejected that: "when a
 * prompt is up the user can inadvertently scroll through the prompt." So the
 * handler stays on #term, and the prompt itself is the fix — visible enough to
 * notice, and answerable with "Just watch" as well as "Take control".
 */
/* ---- the soft keyboard is not part of any viewport unit ---------------------
 * `100dvh` accounts for a mobile browser's URL bar but NOT for the keyboard:
 * iOS treats the keyboard as an overlay, so the page keeps its full height and
 * the bottom of the terminal — the prompt — ends up behind the keys. Only
 * visualViewport reports the area that is genuinely visible, so size the pane
 * from that and re-fit when it changes.
 */
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
  /* PINCH IS NO LONGER BLOCKED, and that is the lesson of this bug rather than
     an oversight. Blocking it (and `maximum-scale=1.0` alongside) is what let a
     layout 24% wider than Owner's screen survive for weeks: he could see there
     was more by pinching out, it snapped back, and the one gesture that both
     diagnosed the problem and worked around it was the one we had disabled. A
     deliberate two-finger pinch is now the user's business.

     Double-tap zoom stays blocked: it is not deliberate — it fires while you are
     tapping the terminal to type, and it leaves the page magnified with no
     obvious cause. CAPTURE phase, because xterm registers its own touch handlers
     and stops propagation, so a bubble-phase listener never runs over the one
     region a finger actually lands on. */
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300 && e.touches.length === 0) {
      e.preventDefault();
    }
    lastTouchEnd = now;
  }, { passive: false, capture: true });
}
installZoomBlockers();

/* ---- the way OUT of a zoom, not just the way in ----------------------------
 * Blocking every gesture that can zoom iOS is a losing game — Safari adds
 * paths (accessibility zoom, a focus scroll, a rotate mid-pinch) and honours
 * `user-scalable=no` only when it feels like it. The failure it leaves behind
 * is indistinguishable from a broken layout: the page is laid out correctly at
 * screen width and the phone shows a magnified CROP of it, so the titlebar and
 * the right-hand columns are simply not on screen and no amount of scrolling
 * brings them back (the page cannot scroll — html/body are overflow:hidden).
 * Owner hit exactly this: "if i pinch zoom out i can see there is more, but when
 * i let go it snaps back", on ONE session while another on the same phone was
 * fine — because zoom is per-tab state, not per-session anything.
 *
 * So: notice it, say so, and offer one tap that undoes it. Rewriting the
 * viewport meta is what actually resets the scale on iOS — it has to CHANGE to
 * retrigger, hence the two-step through a different maximum-scale. */
/* The layout viewport is not always the screen — see web/screen-clamp.mjs for
   the whole story. Installed EARLY so the first fit measures the clamped box. */
installScreenClamp(() => {
  /* A narrower app box means a narrower terminal: refit, and tell the pty.
     Deferred past module init — `fitAndSend` and the reporter are declared
     below this point and reading them here is a temporal-dead-zone throw. */
  setTimeout(() => {
    fitAndSend();
    reportViewportSoon('screen-clamp');
  }, 0);
});

function installZoomEscape() {
  const vv = window.visualViewport;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!vv || !meta || window.matchMedia?.('(pointer: coarse)')?.matches !== true) {
    return;
  }
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'zoom-escape';
  chip.textContent = '⤢ Fit to screen';
  chip.hidden = true;
  document.body.appendChild(chip);

  const BASE = meta.getAttribute('content');
  chip.addEventListener('click', () => {
    meta.setAttribute('content', `${BASE}, maximum-scale=0.99`);
    requestAnimationFrame(() => meta.setAttribute('content', BASE));
  });

  const sync = () => {
    const zoomed = vv.scale > 1.02;
    chip.hidden = !zoomed;
    if (zoomed) {
      /* A fixed element is positioned against the LAYOUT viewport, which is the
         thing currently off screen — so pin the chip to the VISUAL one or the
         escape hatch is itself unreachable. */
      chip.style.transform = `translate(${Math.round(vv.offsetLeft)}px, ${Math.round(vv.offsetTop)}px)`;
    }
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}
installZoomEscape();

/* ---- what this window actually measured (Owner 2026-09-01) ------------------
 * Two different tabs of the SAME page, on the same phone, at the same font:
 * one fits, one has its titlebar and terminal cut off at the right. That photo
 * has two possible causes and they need opposite fixes:
 *
 *   LAYOUT too wide  — the page really is wider than the screen (containment
 *                      failure); innerWidth stays 393 but scrollWidth exceeds it.
 *   VISUAL zoomed in — the layout is correct and the phone is showing a
 *                      magnified crop of it; visualViewport.scale > 1.
 *
 * Reasoning could not separate them and a WebKit harness reproduced neither,
 * so the window reports its own numbers instead of us guessing from a picture.
 * Fire-and-forget: a diagnostic that can break the page it measures is worse
 * than no diagnostic. */
function reportViewport(why) {
  try {
    const vv = window.visualViewport;
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) {
        return null;
      }
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) };
    };
    navigator.sendBeacon?.(
      '/api/diag/viewport',
      new Blob([JSON.stringify({
        why,
        build: BUILD,
        paneid,
        name: displayName(),
        inner: [window.innerWidth, window.innerHeight],
        outer: [window.outerWidth, window.outerHeight],
        screen: [window.screen?.width, window.screen?.height],
        overhang: window.innerWidth - Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0),
        appW: getComputedStyle(document.documentElement).getPropertyValue('--app-w').trim() || null,
        /* What the titlebar glyph is actually drawing (2026-09-15, "back to a
           single dot"): the ring's state/presence attributes, the resolved ring
           colour, the track's computed stroke, and whether hwb-ring.css is in
           the document at all. A missing --rc or an unloaded sheet is the
           difference between a dual ring and a lone dot, and neither is visible
           from the engine. */
        ring: (() => {
          try {
            const r = els.dot;
            const t = r?.querySelector('.rg-track');
            const rs = r ? getComputedStyle(r) : null;
            const ts = t ? getComputedStyle(t) : null;
            return {
              cls: r?.className || null, state: r?.dataset.state || null, presence: r?.dataset.presence || null,
              rc: rs?.getPropertyValue('--rc').trim() || null, vc: rs?.getPropertyValue('--vc').trim() || null,
              track: ts ? [ts.stroke, ts.strokeWidth, ts.opacity] : null, size: rs ? [rs.width, rs.height] : null,
              sheet: !![...document.styleSheets].find((s) => (s.href || '').includes('hwb-ring')),
              embedded: !!document.querySelector('.is-embedded'),
              lifecycle: ringLifecycle, activity: ringActivity, wsOpen: transport.status === 'open',
            };
          } catch (e) { return { err: String(e) }; }
        })(),
        vvh: getComputedStyle(document.documentElement).getPropertyValue('--vvh').trim() || null,
        kb: softKb.state(),
        keypad: (() => {
          const p = document.querySelector('.keypad');
          if (!p) { return null; }
          const r = p.getBoundingClientRect();
          return { auto: p.classList.contains('kp-auto'), open: p.classList.contains('is-open'), shown: r.height > 0, top: Math.round(r.top), bottom: Math.round(r.bottom) };
        })(),
        paneH: Math.round(document.querySelector('.pane').getBoundingClientRect().height),
        padBottom: (() => { const p = document.querySelector('.keypad'); return p ? Math.round(window.innerHeight - p.getBoundingClientRect().bottom) : null; })(),
        visible: visibleWidth(),
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
        bodyScrollW: document.body.scrollWidth,
        vv: vv ? { w: Math.round(vv.width), h: Math.round(vv.height), scale: vv.scale, offX: vv.offsetLeft, pageX: vv.pageLeft } : null,
        dpr: window.devicePixelRatio,
        mqNarrow: window.matchMedia?.('(max-width: 600px)')?.matches ?? null,
        mqCoarse: window.matchMedia?.('(pointer: coarse)')?.matches ?? null,
        paneMaxWidth: getComputedStyle(document.querySelector('.pane')).maxWidth,
        cols: term.cols,
        rows: term.rows,
        fontSize,
        pane: rect('.pane'),
        head: rect('.hwb-sbar'),
        actions: rect('.pane-float'),
        termBox: rect('.pane-term'),
        xterm: rect('.xterm'),
        ua: navigator.userAgent,
      })], { type: 'application/json' }),
    );
  } catch {
    /* never let measuring the window break the window */
  }
}
let reportTimer = null;
function reportViewportSoon(why) {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => reportViewport(why), 700);
}
setTimeout(() => reportViewport('load'), 1500);
window.addEventListener('resize', () => reportViewportSoon('resize'));
window.addEventListener('orientationchange', () => reportViewportSoon('orientation'));

/* THE SOFT KEYBOARD — the room's tracker, shared (web/soft-keyboard.mjs).
 * The old one here synced on visualViewport events alone, which iOS WebKit
 * fires mid-animation or not at all, and could not see a page that LOADS with
 * the keyboard up. The shared one bursts on every trigger and polls while a
 * text field (here xterm's .xterm-helper-textarea) has focus.
 *
 * It sets --vvh ONLY while the keyboard is up. With it down, vv.height still
 * counts the strip behind Edge's bottom bars as visible, and pinning the pane
 * to it put the keypad underneath them (Owner, keyboard-closed screenshot). CSS
 * falls back to 100svh, which excludes that strip by definition. --vv-top
 * follows an iOS pan (solo.css moves the pane down by it). html.kb-up is what
 * shows the key bar (buildTouchKeypad).
 *
 * Coarse pointer only, as before: a touch LAPTOP (fine pointer, touch points)
 * keeps the plain 100svh layout it always had. */
window.addEventListener('soft-kb', () => {
  fitAndSend();
  reportViewportSoon('visualviewport');
});
const softKb = trackSoftKeyboard({
  when: COARSE_POINTER,
  report: (why) => reportViewportSoon(why),
});

function enableTouchScroll() {
  const el = els.term;
  if (!el || !COARSE_POINTER) {
    return;
  }
  let lastY = null;
  let carry = 0;
  /* Diagnostic, one beacon per drag: what the finger hit, whether the scrim
   * was up, and how far xterm actually moved. The 2026-09-15 bug was invisible
   * from the engine side — a phone that scrolls nothing looks exactly like a
   * phone that was never touched. Same sink as the viewport reports. */
  let dragRows = 0;
  let hit = null;
  const report = () => {
    try {
      const chain = [];
      for (let e = hit; e && chain.length < 5; e = e.parentElement) {
        chain.push(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/).join('.')}` : ''));
      }
      const buf = term.buffer.active;
      navigator.sendBeacon?.('/api/diag/viewport', new Blob([JSON.stringify({
        why: 'touch-scroll', build: BUILD, paneid, name: displayName(),
        hit: chain.join(' < '), scrim: typeof pausedEl !== 'undefined' && !pausedEl.hidden,
        controlling, watching,
        rowsMoved: dragRows, baseY: buf.baseY, viewportY: buf.viewportY, rows: term.rows,
      })], { type: 'application/json' }));
    } catch { /* a diagnostic must never break the page it measures */ }
  };
  el.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) {
      lastY = null; // a pinch is not a scroll
      return;
    }
    lastY = ev.touches[0].clientY;
    carry = 0;
    dragRows = 0;
    hit = ev.target instanceof Element ? ev.target : null;
  }, { passive: true });
  el.addEventListener('touchmove', (ev) => {
    if (lastY === null || ev.touches.length !== 1) {
      return;
    }
    const y = ev.touches[0].clientY;
    const rowH = els.term.clientHeight / Math.max(1, term.rows);
    carry += lastY - y;
    lastY = y;
    const rows = Math.trunc(carry / rowH);
    if (rows !== 0) {
      carry -= rows * rowH;
      term.scrollLines(rows);
      dragRows += rows;
      // Only now: a drag we actually consumed must not ALSO bounce the page.
      ev.preventDefault();
    }
  }, { passive: false });
  const clear = () => {
    if (lastY !== null) {
      report();
    }
    lastY = null;
  };
  el.addEventListener('touchend', clear, { passive: true });
  el.addEventListener('touchcancel', clear, { passive: true });
}
enableTouchScroll();

buildTouchKeypad();

/* ---- control lease (one keyboard, many screens) ----/* ---- control lease (one keyboard, many screens) ----------------------------
 * Exactly one viewer drives a session; the others watch. This half is the UX:
 * the engine ENFORCES it (input from a non-controller is refused server-side),
 * so nothing here is a security boundary — it exists so a paused pane says why
 * it is not responding instead of looking like a terminal that eats keystrokes.
 */
const CLIENT_LABEL = deviceLabel();
startDeviceReport('solo'); // load, visible, ~60 s while visible (this page has no poll of its own)

const pausedEl = document.createElement('div');
pausedEl.className = 'pane-paused';
pausedEl.hidden = true;
pausedEl.innerHTML =
  '<div class="pane-paused-card">'
  + '<div class="pane-paused-who"></div>'
  + '<div class="pane-paused-sub">This session is being driven elsewhere. '
  + 'Taking control pauses it there.</div>'
  + '<div class="pane-paused-actions">'
  + '<button class="btn btn-accent" data-act="resume">Take control here</button>'
  + '<button class="btn" data-act="watch">Just watch</button>'
  + '</div>'
  + '</div>';
(els.body || document.body).appendChild(pausedEl);
/* The prompt is MODAL: nothing behind it scrolls or types until it is
 * answered. Two answers. "Take control" is the one that was always there.
 * "Just watch" (Owner, 2026-09-15) dismisses it for READING: the terminal is
 * visible and scrolls natively, the head shows a viewing badge that is the way
 * back to taking control, and the first keystroke re-raises the prompt because
 * typing is an unambiguous "I want to drive". A drag or a tap on the terminal
 * does not re-raise it — a reader taps to scroll and to select. */
let watching = false;
let lastControl = { holder: null, lastHolder: null };
pausedEl.querySelector('[data-act="resume"]').addEventListener('click', () => {
  transport.send({ type: 'takeControl', paneid, label: CLIENT_LABEL });
});
pausedEl.querySelector('[data-act="watch"]').addEventListener('click', () => {
  watching = true;
  renderControl(lastControl.holder, lastControl.lastHolder);
});
els.viewBadge?.addEventListener('click', () => {
  transport.send({ type: 'takeControl', paneid, label: CLIENT_LABEL });
});
/* Typing while watching brings the prompt back with its real context. */
function reraiseControlPrompt() {
  watching = false;
  renderControl(lastControl.holder, lastControl.lastHolder);
}

/* THREE different facts, which used to be told as two.
   "No one is driving" was baffling to read about a session you were using
   seconds ago (Owner, 2026-08-31) — because it was true of the engine's memory,
   not of the world. The engine now remembers who WAS driving across a restart,
   so the pane can say the honest thing instead of implying you never existed. */
function renderControl(holder, lastHolder) {
  lastControl = { holder: holder ?? null, lastHolder: lastHolder ?? null };
  if (controlling) {
    watching = false; // a new loss of control is a new prompt, never pre-dismissed
  }
  pausedEl.hidden = controlling || watching;
  if (els.viewBadge) {
    els.viewBadge.hidden = controlling || !watching;
    els.viewBadge.title = holder
      ? `${holder} has control — tap to take it here`
      : 'Viewing — tap to take control here';
  }
  if (!controlling) {
    const who = pausedEl.querySelector('.pane-paused-who');
    const sub = pausedEl.querySelector('.pane-paused-sub');
    if (holder) {
      who.textContent = `${holder} has control`;
      sub.textContent =
        'This session is being driven elsewhere. Taking control pauses it there.';
    } else if (lastHolder) {
      who.textContent = `${lastHolder} was driving this session`;
      sub.textContent =
        'The connection dropped — an engine restart, a sleep, or a network blip. '
        + 'The CLI kept running the whole time.';
    } else {
      who.textContent = 'Available — no one is driving this session';
      sub.textContent =
        'The last viewer disconnected without ending it. The CLI kept running.';
    }
  }
  if (controlling) {
    focusTerm();
  }
}

transport.on('pane.control', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  const had = controlling;
  controlling = msg.controlling === true;
  if (had && !controlling) {
    watching = false; // control was taken from us: that is a fresh prompt
  }
  renderControl(msg.holder, msg.lastHolder);
  /* GAINING CONTROL MUST RESIZE THE PTY, and this is why the right-hand side of
   * a session was missing on Owner's phone while the layout measured perfectly.
   *
   * There is ONE pty and its column count belongs to whoever holds the
   * keyboard. `fitAndSend` refuses to send a resize when not controlling —
   * correct, or a watcher would re-wrap the CLI under the person typing. But
   * the engine announces `pane.control` BEFORE `pane.ready`, so on attach the
   * client learns it is only a viewer, the one fitAndSend that follows is
   * suppressed, and NOTHING re-sends the size when control is later granted.
   *
   * So a phone taking over a session sized by a 1600px desktop window kept a
   * 200-column pty. A shell survives that (text just wraps) but a full-screen
   * TUI does not: Claude Code paints at ABSOLUTE columns, so everything it drew
   * past column 38 was simply never rendered — "not rendering the right side of
   * the screen", exactly as described, with no CSS involved.
   *
   * Only on the transition, so a repeated announce is not a resize storm. */
  if (!had && controlling) {
    fitAndSend();
  }
});
transport.on('pane.control-lost', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  controlling = false;
  watching = false;
  renderControl(msg.holder, null);
});
transport.on('pane.control-denied', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  // The engine refused a write we thought we were allowed to make — our view of
  // the lease was stale. Trust the engine and repaint.
  controlling = false;
  watching = false;
  renderControl(msg.holder, null);
});

/* ---- engine events ---- */
/* MCP-call indicator (Owner's feature; engine: pane.mcp). A standalone window
   draws its own session bar, so it drives the indicator on it; an embedded one
   hands the events to the shell, which owns the bar. Events are a STREAM, so
   they go straight to the parent, not through emitToShell's merged state. */
const mcpView = createMcpView(() => els.sbar, hwbChromeNS.hwbMcpIndicator);
transport.on('pane.mcp', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  if (embedded) {
    window.parent.postMessage({ hwbMcp: msg }, '*');
  } else {
    mcpView.event(msg);
  }
});

/* §3.6 held line: rendered by web/held-bar.mjs from pane.ready's `held` and
   every pane.held push (S0). Nothing else here knows about it. */
const heldBar = mountHeldBar(document.getElementById('heldBar'), paneid, {
  onDone: () => focusTerm(),
  canDeliver: () => controlling, // controller-only, like paste (nuc1 ruling)
  onTakeControl: () => reraiseControlPrompt(),
});
transport.on('pane.control', (msg) => {
  if (msg.paneid === paneid) {
    heldBar.refresh();
  }
});
transport.on('pane.held', (msg) => {
  if (msg.paneid === paneid) {
    heldBar.set(msg.held ?? null);
    /* framed in a ROOM page: tell it at once, so its seat row (held count,
       the unread badge) follows a delivery now, not on its next poll
       (Owner, room line [ref]). Same origin only; no content, just the nudge. */
    if (window.parent !== window && new URLSearchParams(location.search).has('inroom')) {
      window.parent.postMessage({ hwbSeatHeld: paneid }, location.origin);
    }
  }
});

transport.on('pane.ready', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  {
    /* pane.ready.mcp is AUTHORITATIVE (nuc1: in-flight state does not survive
       an engine restart), so every ready is a clean slate + the starts still
       in flight; an absent list means none, never "keep what you had". */
    const inflight = Array.isArray(msg.mcp) ? msg.mcp : [];
    if (embedded) {
      window.parent.postMessage({ hwbMcpReset: inflight }, '*');
    } else {
      mcpView.reset(inflight);
    }
  }
  if ('held' in msg) {
    heldBar.set(msg.held ?? null);
  }
  void refreshMic(); // the mic's first state, and again after any reconnect
  if (typeof msg.vendor === 'string' && msg.vendor) {
    vendor = msg.vendor;
  }
    setState('live');
  setActivity(msg.activity || 'idle');
  if (msg.title !== undefined) {
    sessionTitle = msg.title || null;
  }
  applyPrefs(msg.prefs);
  fitAndSend();
  if (msg.restored) {
    term.write('\x1b[2m[session restored — claude --resume, engine was restarted]\x1b[0m\r\n');
  }
  focusTerm();
});

/* Engine restart (crash or deploy) drops the socket; the transport reconnects
 * but the engine no longer knows this pane — re-send attach so the engine can
 * reattach-or-restore (a dehydrated claude session comes back via --resume).
 * Guarded so the FIRST open doesn't double-attach with the boot attach below. */
let hadOpen = false;
transport.onStatus((s) => {
  if (s !== 'open') {
    setActivity('disconnected');
    /* DO NOT KEEP ASSERTING A LEASE WE CANNOT SEE.
       The card used to hold whatever it last heard, so a socket that dropped
       mid-session left "Available — no one is driving" frozen on screen while
       the truth moved on without it — which is exactly the confusing thing Owner
       photographed. While the socket is down we know one thing only: we are not
       driving anything, because we are not connected to anything. */
    if (!pausedEl.hidden) {
      pausedEl.querySelector('.pane-paused-who').textContent = 'Reconnecting…';
      pausedEl.querySelector('.pane-paused-sub').textContent =
        'Lost the connection to the engine. The CLI keeps running; this window '
        + 'will say who is driving as soon as it is back.';
    }
    return;
  }
  /* `attached` in the ring spec is "is anyone there", and it is read from the
     socket — so a reconnect changes the glyph even when no engine event follows. */
  paintRing();
  clearQueued(); // the outbox has just gone out; nothing is being held any more
  if (!hadOpen) {
    hadOpen = true;
    return;
  }
  term.reset(); // engine-side replay (reattach) or restore output repaints it
  /* RECLAIM, never plain attach. A reconnect must not assume it still owns the
     keyboard: this socket may have been gone for two seconds (network blip —
     nobody took over, so we pick it straight back up) or for an hour (the
     laptop hibernated and the VRPC is now driving, so we come back as a viewer
     and offer). Sending a bare attach here meant a woken browser silently stole
     a live session out from under whoever was using it. */
  transport.send({
    type: 'attach', paneid, recipe: recipeId, model: modelOverride ?? undefined, effort: effortOverride ?? undefined,
    label: CLIENT_LABEL, intent: 'reclaim', roomFrame: roomFrame || undefined,
  });
});
/* Paste ownership (Owner 2026-08-09): ConPTY SWALLOWS claude's bracketed-paste
 * enable (probed live: no ESC[?2004h ever reaches the client), so xterm never
 * wraps pastes and every pasted line break submits as Enter. Claude DID turn
 * the mode on its side — only the notification to us was eaten — so we wrap
 * MULTI-LINE pastes in the ESC[200~/201~ markers ourselves and claude treats
 * the newlines as content, exactly like Windows Terminal. Single-line pastes
 * are sent plain (no behavioral change). Known degraded case, accepted:
 * multi-line pastes at a BARE PowerShell prompt show the markers as noise
 * (PSReadLine 2.0 has no bracketed paste); bash 5 (server panes) handles them
 * natively. Capture phase so xterm's own paste handler never runs (single
 * path — no doubling). */
function sendPastedText(raw) {
  if (!raw) {
    return;
  }
  const text = raw.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  const data = text.includes('\r') ? `\x1b[200~${text}\x1b[201~` : text;
  transport.send({ type: 'input', paneid, data });
  focusTerm();
}
els.term.addEventListener(
  'paste',
  (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    sendPastedText(ev.clipboardData?.getData('text') ?? '');
  },
  true,
);
// Drag-dropped text is ANOTHER route to raw newlines hitting the pty (browser
// default would insert it unwrapped) — same treatment as paste.
els.term.addEventListener('dragover', (ev) => ev.preventDefault(), true);
els.term.addEventListener(
  'drop',
  (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    sendPastedText(ev.dataTransfer?.getData('text') ?? '');
  },
  true,
);

/* Link sweep (Owner 2026-08-09): claude's renderer HARD-wraps long URLs (real
 * newline + indent in the byte stream), so click/copy get mangled halves in
 * every terminal. We hold the buffer — 🔗 reconstructs them. Soft wraps are
 * joined via xterm's line.isWrapped; hard wraps bridge in link-sweep.mjs. */
function bufferLogicalLines() {
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const ln = buf.getLine(i);
    if (!ln) {
      continue;
    }
    const t = ln.translateToString(true);
    if (ln.isWrapped && out.length > 0) {
      out[out.length - 1] += t;
    } else {
      out.push(t);
    }
  }
  return out;
}
/* ---- HANDOFF: copy fields without selecting terminal text ------------------
 * Owner, on a phone, 2026-09-04: "an agent just handed me a url, userid and
 * password. press and hold to select doesn't work all the time. dragging
 * selection does weird things when the cli moves inside the pty frame."
 *
 * The link sweep SCRAPES the buffer and can therefore only ever find URLs.
 * This is the other direction: the agent SAYS what it is handing over, as
 * labelled fields, and each gets its own button. Nothing is ever selected.
 *
 * CLIPBOARD ON iOS — two rules, both load-bearing:
 *   · it needs a SECURE CONTEXT. The phone reaches this over Tailscale Serve
 *     (https://…ts.net:8443 → :7420), so `navigator.clipboard` exists. Over
 *     plain http it does NOT, hence the execCommand fallback below rather than
 *     a promise that rejects into silence.
 *   · the write must happen INSIDE the user gesture. The value is already in
 *     memory when the button is built — never fetched on click — because an
 *     await before the write loses the activation and iOS refuses it.
 */
let handoffBundles = [];

function copyValue(text, btn) {
  const done = (ok) => {
    btn.textContent = ok ? '✓ Copied' : '✗ Copy failed';
    btn.classList.toggle('is-done', ok);
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('is-done');
    }, 1400);
  };
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(legacyCopy(text)));
      return;
    }
  } catch {
    /* fall through */
  }
  done(legacyCopy(text));
}

/* Insecure-context fallback. A textarea, not an input: an input collapses a
   multi-line value onto one line, and a password manager string can contain
   anything. Selected via setSelectionRange because iOS ignores .select() on a
   readonly field. */
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

const handoffModal = document.getElementById('handoffModal');

function renderHandoffBadge() {
  const n = handoffBundles.reduce((sum, b) => sum + b.items.length, 0);
  /* The same count the in-window badge shows, forwarded to the tab so a session
     you are not looking at can say it is carrying something for you. */
  emitToShell({ items: { count: n } });
  handoffCount = n;
  paintBar();
  if (n === 0) {
    handoffModal.hidden = true;
  }
}

function openHandoff() {
  const list = document.getElementById('handoffList');
  list.innerHTML = '';
  if (handoffBundles.length === 0) {
    // reachable now: the v21 bar's handoff icon is always present
    list.innerHTML = '<div class="dim">Nothing handed over in this session.</div>';
  }
  document.getElementById('handoffTitle').textContent =
    handoffBundles.length === 1 ? handoffBundles[0].title : 'Details from the agent';
  for (const bundle of handoffBundles) {
    for (const item of bundle.items) {
      const row = document.createElement('div');
      row.className = 'handoff-row';

      const label = document.createElement('div');
      label.className = 'handoff-label';
      label.textContent = item.label;
      row.appendChild(label);

      const val = document.createElement('div');
      val.className = 'handoff-value';
      /* A secret is masked until asked for, and copying does NOT require
         revealing it — the whole point is to move it without displaying it on a
         screen in a room. textContent, never innerHTML: this string came from
         outside and is rendered verbatim. */
      const masked = item.kind === 'secret';
      val.textContent = masked ? '••••••••' : item.value;
      val.dataset.masked = masked ? '1' : '0';
      row.appendChild(val);

      const acts = document.createElement('div');
      acts.className = 'handoff-acts';
      if (masked) {
        const reveal = document.createElement('button');
        reveal.className = 'pane-btn';
        reveal.textContent = 'Show';
        reveal.addEventListener('click', () => {
          const hidden = val.dataset.masked === '1';
          val.textContent = hidden ? item.value : '••••••••';
          val.dataset.masked = hidden ? '0' : '1';
          reveal.textContent = hidden ? 'Hide' : 'Show';
        });
        acts.appendChild(reveal);
      }
      if (item.kind === 'url') {
        const open = document.createElement('button');
        open.className = 'pane-btn';
        open.textContent = 'Open';
        open.addEventListener('click', () => openExternal(item.value));
        acts.appendChild(open);
      }
      const copy = document.createElement('button');
      copy.className = 'pane-btn handoff-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => copyValue(item.value, copy));
      acts.appendChild(copy);

      row.appendChild(acts);
      list.appendChild(row);
    }
  }
  handoffModal.hidden = false;
}

document.getElementById('handoffClose').addEventListener('click', () => {
  handoffModal.hidden = true;
  focusTerminal();
});
document.getElementById('handoffDismiss').addEventListener('click', () => {
  /* Only DISMISS clears. Copying must not: a password you copied once is one
     you may well need to paste twice, and losing it to a successful copy would
     be the worst possible moment to lose it. */
  transport.send({ type: 'handoff-dismiss', paneid });
  handoffModal.hidden = true;
  focusTerminal();
});
handoffModal.addEventListener('click', (ev) => {
  if (ev.target === handoffModal) {
    handoffModal.hidden = true;
    focusTerminal();
  }
});

/* ---- TAB NOTICES (the design system window-chrome v20 — `badge` + `items`) -------------
 * Two facts Owner needs while he is NOT looking at the CLI Manager, and which a
 * tab had nowhere to put: the tool's own status (an expired sudo credential
 * being the case that prompted it) and how many copyable fields are waiting.
 *
 * BOTH ARE NOTICES, NOT ASKS, and the design system bundle enforces that mechanically —
 * no motion, no coral, square rather than round. Nothing here may reintroduce
 * the demand treatment; `hwbState` remains the only thing that can flash.
 *
 * Published VERBATIM. `kind:'ok'` is forwarded as-is because the CHROME is what
 * decides it renders nothing (`.n-ok{display:none}`) — the engine still never
 * interprets a tool's line, and a client filtering it here would fork that
 * decision into two places. `expiresAt` likewise passes through unread: the
 * chrome's own clock renders the countdown, so a live "4h12m" costs no polling.
 */
transport.on('pane.widget', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  const w = msg.widget;
  emitToShell({
    badge: w && w.kind
      ? { kind: w.kind, text: w.text ?? '', expiresAt: w.expiresAt ?? null }
      : null,
  });
});

transport.on('pane.handoff', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  handoffBundles = Array.isArray(msg.bundles) ? msg.bundles : [];
  renderHandoffBadge();
  if (!handoffModal.hidden) {
    openHandoff(); // repaint an open modal in place rather than closing it
  }
});

/* ---- FABRIC INBOX (Stage 3, engine half) ------------------------------------
 *
 * Envelopes another agent addressed to THIS session's slug, delivered over the
 * pane socket as `fabric.message` carrying the whole pending list (same shape
 * as `pane.handoff`, so a reload re-arms the badge from the engine rather than
 * from anything this page remembered).
 *
 * MINIMAL ON PURPOSE. `attention` picks a colour and nothing else: no
 * animation, no repeat, no timer, no auto-open, and above all nothing that
 * touches the terminal. the design notes's rules are not implemented
 * here, and the one that would be easiest to violate by accident is "never
 * seize an input box that holds a draft" — so this never focuses, never types,
 * and never steals a keystroke. */
let fabricMessages = [];
const fabricModal = document.getElementById('fabricModal');

function renderFabricBadge() {
  /* v21: the count rides the session bar's messages icon (the bundle draws the
     number). The per-message `attention` is still shown inside the modal; the
     bar icon is the bundle's and is not recoloured here. */
  fabricCount = fabricMessages.length;
  paintBar();
  if (fabricCount === 0) {
    fabricModal.hidden = true;
  }
}

function openFabric() {
  const list = document.getElementById('fabricList');
  list.innerHTML = '';
  if (fabricMessages.length === 0) {
    // reachable now: the v21 bar's messages icon is always present
    list.innerHTML = '<div class="dim">No messages from other agents.</div>';
  }
  for (const m of fabricMessages) {
    const row = document.createElement('div');
    row.className = 'fabric-row';
    const head = document.createElement('div');
    head.className = 'fabric-head';
    const from = document.createElement('span');
    from.className = 'fabric-from';
    from.textContent = m.from;
    const tags = document.createElement('span');
    tags.className = 'fabric-tags';
    /* kind / class / attention, in the contract's own words — three orthogonal
       fields (what the message is FOR, what HAPPENED, how LOUDLY it reaches a
       human) and collapsing them into one word would lose the distinction the
       fabric exists to keep. */
    tags.textContent = `${m.kind} · ${m.class} · ${m.attention}`;
    head.append(from, tags);
    row.appendChild(head);
    if (m.body) {
      const body = document.createElement('div');
      body.className = 'fabric-body';
      body.textContent = m.body;
      row.appendChild(body);
    }
    if (m.ref) {
      const ref = document.createElement('div');
      ref.className = 'fabric-ref';
      ref.textContent = m.ref;
      row.appendChild(ref);
    }
    list.appendChild(row);
  }
  fabricModal.hidden = false;
}

document.getElementById('fabricClose').addEventListener('click', () => {
  fabricModal.hidden = true;
});
document.getElementById('fabricDismiss').addEventListener('click', () => {
  transport.send({ type: 'fabric-dismiss', paneid });
  fabricModal.hidden = true;
});
fabricModal.addEventListener('click', (ev) => {
  if (ev.target === fabricModal) {
    fabricModal.hidden = true;
  }
});

/* Another tab opened a channel (Crawl: one at a time), this pane's session
   ended, or a toggle landed — the engine says so and the mic repaints. */
transport.on('pane.voice', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  micState = micFromPaneVoice(msg); // the WHOLE state, every time
  paintBar();
});

transport.on('fabric.message', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  fabricMessages = Array.isArray(msg.messages) ? msg.messages : [];
  renderFabricBadge();
  if (!fabricModal.hidden) {
    openFabric(); // repaint an open modal in place rather than closing it
  }
});

const linksModal = document.getElementById('linksModal');
function openLinks() {
  const urls = extractUrls(bufferLogicalLines()).reverse(); // newest first
  const list = document.getElementById('linksList');
  list.innerHTML = '';
  if (urls.length === 0) {
    list.innerHTML = '<div class="dim">No URLs in this session yet.</div>';
  }
  for (const u of urls.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'links-row';
    row.innerHTML = `<span class="links-url"></span>
      <button class="pane-btn" data-act="open">Open</button>
      <button class="pane-btn" data-act="copy">Copy</button>`;
    row.querySelector('.links-url').textContent = u.length > 78 ? `${u.slice(0, 48)}…${u.slice(-27)}` : u;
    row.querySelector('.links-url').title = u;
    row.querySelector('[data-act="open"]').addEventListener('click', () => openExternal(u));
    row.querySelector('[data-act="copy"]').addEventListener('click', (ev) => {
      navigator.clipboard?.writeText(u);
      ev.target.textContent = 'Copied ✓';
      setTimeout(() => (ev.target.textContent = 'Copy'), 1200);
    });
    list.appendChild(row);
  }
  linksModal.hidden = false;
}
document.getElementById('linksCloseBtn').addEventListener('click', () => {
  linksModal.hidden = true;
  focusTerm();
});
linksModal.addEventListener('click', (ev) => {
  if (ev.target === linksModal) {
    linksModal.hidden = true;
    focusTerm();
  }
});

transport.on('pane.state', (msg) => {
  if (msg.paneid === paneid) {
    setActivity(msg.state);
  }
});
/* Agent-submitted URL offers: bar under the head — "the agent wants you to
 * open this". Engine list is authoritative; every change echoes the full
 * list. Multiple offers stack as rows. */
transport.on('pane.url-offer', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  const bar = document.getElementById('urlOffers');
  bar.innerHTML = '';
  bar.hidden = !msg.urls || msg.urls.length === 0;
  urlOfferCount = Array.isArray(msg.urls) ? msg.urls.length : 0;
  paintBar();
  if (bar.hidden) {
    return;
  }
  const head = document.createElement('div');
  head.className = 'url-offers-head';
  head.innerHTML = `<span>🔗 The agent submitted ${msg.urls.length === 1 ? 'a URL' : msg.urls.length + ' URLs'} — open?</span>
    <button class="pane-btn" data-act="dismiss-all">Dismiss all</button>`;
  head.querySelector('[data-act="dismiss-all"]').addEventListener('click', () =>
    transport.send({ type: 'url-offer-dismiss', paneid }),
  );
  bar.appendChild(head);
  for (const u of msg.urls) {
    const row = document.createElement('div');
    row.className = 'url-offer-row';
    row.innerHTML = `<span class="links-url"></span>
      <button class="pane-btn" data-act="open">Open</button>
      <button class="pane-btn" data-act="x" title="Dismiss this URL">✕</button>`;
    row.querySelector('.links-url').textContent = u.length > 90 ? `${u.slice(0, 58)}…${u.slice(-29)}` : u;
    row.querySelector('.links-url').title = u;
    row.querySelector('[data-act="open"]').addEventListener('click', () => {
      openExternal(u);
      transport.send({ type: 'url-offer-dismiss', paneid, url: u }); // opened = handled
    });
    row.querySelector('[data-act="x"]').addEventListener('click', () =>
      transport.send({ type: 'url-offer-dismiss', paneid, url: u }),
    );
    bar.appendChild(row);
  }
});
transport.on('pane.data', (msg) => {
  if (msg.paneid === paneid) {
    term.write(msg.data);
  }
});
transport.on('pane.exit', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  lastExit = msg.code === 0 ? 'ok' : 'fail';
  emitToShell({ hwbState: 'ended', exit: lastExit });
  /* The window STAYS OPEN on an exit, whatever caused it — dismiss is not kill,
     and a session ended from the manager still leaves you the ↻ to relaunch it
     in place. The old `endClicked` branch closed the window for a kill this
     window itself requested; ✕ no longer kills, so nothing sets it. */
  setState('killed');
  term.write(`\r\n\x1b[2m[process exited, code ${msg.code} — ↻ relaunches this session]\x1b[0m\r\n`);
});
transport.on('pane.prefs', (msg) => {
  if (msg.paneid === paneid) {
    applyPrefs(msg.prefs);
  }
});
/* The conversation was renamed (or Claude auto-titled it). Pushed by the engine
 * because this window never polls — without it the tab would keep the name it
 * was opened with for the life of the session. Repaints through applyPrefs so
 * the head, the document title and the shell tab stay one decision. */
transport.on('pane.title', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  sessionTitle = msg.title || null;
  paintName();
});
/* The engine refused to create a session here — see spawnPermits. Say so in
   the terminal (this window has no other surface for it) and surface the ↻
   button, which sends the explicit spawn. The state word follows the ROW, so a
   dehydrated pane still reads as restorable rather than dead. */
transport.on('pane.needs-launch', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  /* an ENDED pane: its in-flight MCP list (the engine sends mcp: []) is the
     truth, as on pane.ready. NOT on pane.exit: the engine sends the open
     calls' interrupted end frames just before it, and a reset would wipe them. */
  if (Array.isArray(msg.mcp)) {
    if (embedded) {
      window.parent.postMessage({ hwbMcpReset: msg.mcp }, '*');
    } else {
      mcpView.reset(msg.mcp);
    }
  }
  term.reset();
  term.write(`\r\n\x1b[33m[${msg.message}]\x1b[0m\r\n`);
  term.write('\x1b[2m Nothing was lost — this window just did not start a new one.\x1b[0m\r\n');
  term.write('\x1b[2m Use ↻ above to launch a fresh session in this project.\x1b[0m\r\n');
  setState('killed');
  els.relaunch.hidden = false;
});

transport.on('pane.error', (msg) => {
  if (msg.paneid !== paneid) {
    return;
  }
  term.write(`\r\n\x1b[31m[engine: ${msg.message}]\x1b[0m\r\n`);
  setState('killed');
});

/* ---- boot: paint from the recipe immediately (before the spawn round-trip),
 * then attach — reattach-or-spawn lives engine-side. ---- */
(async () => {
  try {
    const res = await fetch(`/api/recipes/${encodeURIComponent(recipeId)}`);
    if (res.ok) {
      const { recipe } = await res.json();
      applyPrefs({
        friendlyName: recipe.name,
        color: recipe.color,
        fg: recipe.fg,
        bg: recipe.bg,
        project: recipe.projectDir,
        fontSize: recipe.fontSize,
        logo: recipe.logo,
      });
    }
  } catch {
    /* engine will still answer the attach */
  }
  /* RECLAIM, NEVER SEIZE — and never CREATE (Owner, web, 2026-09-04).
   *
   * A page LOAD is not evidence that a human asked for anything. The browser
   * reloads a backgrounded tab on its own, and this attach used to say two
   * things it had no right to say: "give me the keyboard" (so a woken laptop
   * silently took control back from the device Owner had moved to) and, if the
   * session had since ended, "start one" (so the reload replaced a finished
   * conversation with an empty CLI and left it sitting in the manager).
   *
   * `intent:'reclaim'` takes the keyboard ONLY if nobody holds it — the same
   * rule the socket-reconnect path has used since 2026-08-19; the page-load
   * path simply never got it. And no `spawn` flag means the engine refuses to
   * create a session here, answering `pane.needs-launch` instead. */
  transport.send({
    type: 'attach', paneid, recipe: recipeId, model: modelOverride ?? undefined, effort: effortOverride ?? undefined,
    label: CLIENT_LABEL, intent: 'reclaim', roomFrame: roomFrame || undefined,
  });
})();
