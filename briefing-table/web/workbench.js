/* Workbench engine — multi-pane shell over the multiplexed transport (Milestone 4).
 *
 * M1 was one component → one pane on a per-pane socket. M4 reshapes to the closed
 * renderer↔engine contract (the design notes):
 *   - ONE multiplexed socket; every message carries a `paneid`. The engine can now
 *     initiate events (the carrier for `pane.requested`, later).
 *   - ALL discovered components render as panes (not just components[0]).
 *   - Per-pane PRESENTATION prefs (friendlyName / color / watermark) — the
 *     at-a-glance identity. Engine stores+serves; this renderer PAINTS them.
 *
 * This plain-HTML renderer is the ENGINE-SIDE proof of the seam. It speaks the
 * exact contract vocabulary, so the design system React bundle (mountWorkbench) drops in
 * later without an engine change. Build stamp so a cached load is obvious. */
console.log('[wb] build 2026-06-10-m4');

import { Terminal } from '/vendor/xterm/xterm.mjs';
import { FitAddon } from '/vendor/xterm/addon-fit.mjs';
import { startDeviceReport } from '/device-report.mjs'; // user device presence [user device presence]
startDeviceReport('workbench');

const stage = document.getElementById('wbStage');
const canvas = document.getElementById('wbCanvas');
const debug = document.getElementById('wbDebug');
const maxBtn = document.getElementById('wbMax');

/** paneid -> pane object. Many panes now, keyed by their stable id (decision 5). */
const panes = new Map();
let componentCount = null;

/** Stable per-pane key (decision 5), persisted so a reload reuses the same row. */
function paneIdFor(componentId) {
  const key = `wb-paneid-${componentId}`;
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `pane-${componentId}-${Date.now()}`;
    localStorage.setItem(key, id);
  }
  return id;
}

/* ============================================================================
 * Transport adapter — the {send, on} the contract pins. ONE socket, paneid in
 * every body, engine-owned reconnect/replay. Names are EXACTLY the §1/§2
 * vocabulary; the adapter adds no contract surface of its own.
 * ========================================================================== */
function createTransport() {
  let ws = null;
  let status = 'connecting';
  const handlers = new Map(); // type -> Set<fn>
  const statusFns = new Set();
  const outbox = []; // commands queued while the socket is down

  function emitStatus(s) {
    status = s;
    for (const fn of statusFns) {
      fn(s);
    }
  }

  function connect() {
    /* Scheme MUST follow the page: a page served over https cannot open a ws://
       socket — the browser blocks it as mixed content (found live behind
       Tailscale Serve, 2026-08-19). location.host already carries the port. */
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pty`);
    ws.onopen = () => {
      emitStatus('open');
      while (outbox.length) {
        ws.send(JSON.stringify(outbox.shift()));
      }
    };
    ws.onclose = () => {
      emitStatus('closed');
      setTimeout(connect, 1000); // engine owns reconnect (mirrors M3 resilience)
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const set = handlers.get(msg.type);
      if (set) {
        for (const fn of set) {
          fn(msg);
        }
      }
    };
  }

  connect();

  return {
    send(command) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(command));
      } else {
        outbox.push(command); // flushed on reconnect
      }
    },
    on(type, handler) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      handlers.get(type).add(handler);
      return () => handlers.get(type)?.delete(handler);
    },
    onStatus(fn) {
      statusFns.add(fn);
      fn(status);
    },
    get status() {
      return status;
    },
  };
}

const transport = createTransport();

/* ---- context (modal / dock / full) switching — unchanged ---- */
let originMode = 'modal';

function setMode(mode) {
  stage.dataset.mode = mode;
  maxBtn.textContent = mode === 'full' ? '🗗' : '⛶';
  maxBtn.title = mode === 'full' ? 'Restore' : 'Maximize to full screen';
  if (mode !== 'off') {
    for (const p of panes.values()) {
      requestAnimationFrame(() => fitAndSend(p));
    }
  }
  renderDebug();
}

function open(mode) {
  originMode = mode;
  setMode(mode);
}
function toggleMax() {
  setMode(stage.dataset.mode === 'full' ? originMode : 'full');
}

document.getElementById('entryModal').addEventListener('click', () => open('modal'));
document.getElementById('entryDock').addEventListener('click', () => open('dock'));
maxBtn.addEventListener('click', toggleMax);
for (const el of document.querySelectorAll('[data-close]')) {
  el.addEventListener('click', () => setMode('off')); // dismiss ≠ kill (decision 7)
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (stage.dataset.mode === 'modal' || stage.dataset.mode === 'full')) {
    setMode('off');
  }
});

/* ---- terminal theme from the pinned the design system tokens, with per-pane fg/bg overrides.
   fg/bg are USER-CHOSEN (the design system has explicit foreground/background pickers); the
   user owns contrast — we do NOT auto-adjust. ANSI palette (colored agent output:
   red errors, green success) is left untouched, so deliberate colors survive. ---- */
function auroraTheme(fgOverride, bgOverride, cursorOverride) {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return {
    background: bgOverride || v('--ink'),
    foreground: fgOverride || v('--text'),
    // cursor follows the pane's IDENTITY accent so it reads as the same window;
    // falls back to --teal (the CLI function color) when no accent is set.
    cursor: cursorOverride || v('--teal'),
    selectionBackground: v('--surface3'),
  };
}

function fitAndSend(p) {
  const el = p.termEl;
  if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) {
    return; // hidden — can't measure; re-fit when shown
  }
  try {
    p.fit.fit();
  } catch {
    return;
  }
  transport.send({ type: 'resize', paneid: p.paneid, cols: p.term.cols, rows: p.term.rows });
}

function setPaneState(p, state) {
  p.dotEl.dataset.state = state;
  p.stateEl.textContent = state === 'live' ? 'live' : 'ended';
  p.killEl.disabled = state !== 'live';
}

/* ---- presentation prefs: ENGINE stores, THIS renderer paints ---- */
function applyPrefs(p, prefs) {
  if (!prefs) {
    return;
  }
  p.prefs = prefs;
  // friendlyName: title-bar label (the at-a-glance handle). Falls back to component title.
  p.nameEl.textContent = prefs.friendlyName || p.component.title;
  if (p.nameInput) {
    p.nameInput.value = prefs.friendlyName || '';
  }
  // color: IDENTITY accent only — title-bar tint + stripe. Tells panes apart;
  // independent of the terminal fg/bg the user picks for readability.
  if (prefs.color) {
    p.root.style.setProperty('--pane-accent', prefs.color);
    if (p.swatch) {
      p.swatch.value = /^#/.test(prefs.color) ? prefs.color : '#000000';
    }
  }
  // fg/bg: USER-CHOSEN terminal foreground + background (design-system pickers).
  // Let XTERM own the background via theme.background — it fills the rows
  // edge-to-edge natively, so there's no "border" gap (the earlier transparency
  // trick left the main area black on an already-live terminal because xterm had
  // already painted and didn't pick up the CSS override). The watermark layer
  // sits behind the (now transparent-where-empty) rows; when a solid bg is set it
  // wins over the watermark, which is the acceptable trade (bg > watermark).
  // CRITICAL: reassign options.theme to a NEW object — xterm only repaints when
  // the theme reference changes; mutating in place is ignored on a live term.
  // xterm's DOM renderer only paints background on CELLS THAT EXIST — the empty
  // area below the cursor has no rows, so theme.background does NOT fill the whole
  // viewport (that was the "black main area" symptom). So we paint the bg on the
  // .pane-term ELEMENT (fills the entire box) and keep xterm's own theme bg
  // transparent (viewport CSS) so the rows let the element bg show behind them.
  // fg still rides theme.foreground. New theme object so xterm repaints fg.
  // xterm's color parser rejects the string 'transparent' and falls back to
  // OPAQUE BLACK (the "black center" symptom). Use an explicit transparent rgba,
  // which it accepts — then the row bg is genuinely see-through and the bg we
  // paint on .pane-term shows through the whole surface.
  p.term.options.theme = auroraTheme(prefs.fg || null, 'rgba(0,0,0,0)', prefs.color || null);
  p.termEl.style.background = prefs.bg || ''; // fills the whole terminal box
  p.bodyEl.style.background = prefs.bg || '';
  try {
    p.term.refresh(0, p.term.rows - 1); // repaint glyphs with the new fg
  } catch {
    /* term not open yet — first paint will use the theme */
  }
  if (p.fgSwatch) {
    p.fgSwatch.value = prefs.fg && /^#/.test(prefs.fg) ? prefs.fg : '#e6e6e6';
  }
  if (p.bgSwatch) {
    p.bgSwatch.value = prefs.bg && /^#/.test(prefs.bg) ? prefs.bg : '#06090c';
  }
  // watermark: faint label behind the terminal surface (renderer chrome, NOT pty).
  p.watermarkEl.textContent = prefs.watermark || '';
  p.watermarkEl.style.display = prefs.watermark ? '' : 'none';
  if (p.wmInput) {
    p.wmInput.value = prefs.watermark || '';
  }
}

/** Build one pane for a discovered component and attach it over the shared socket. */
function mountPane(component) {
  const paneid = paneIdFor(component.id);
  const root = document.createElement('div');
  root.className = `pane fn-${component.fn}`;
  root.dataset.paneid = paneid;
  root.innerHTML = `
    <div class="pane-head">
      <span class="pane-dot" data-state="connecting"></span>
      <span class="pane-fn-dot"></span>
      <span class="pane-name"></span>
      <span class="pane-state">connecting…</span>
      <div class="pane-prefs">
        <input class="pane-name-input" type="text" placeholder="name…" title="Friendly name (rename)" />
        <label class="pane-swatch" title="Identity accent color">▍<input class="pane-color" type="color" value="#000000" /></label>
        <label class="pane-swatch" title="Text (foreground) color">A<input class="pane-fg" type="color" value="#e6e6e6" /></label>
        <label class="pane-swatch" title="Background color">▢<input class="pane-bg" type="color" value="#06090c" /></label>
        <input class="pane-wm" type="text" placeholder="watermark…" title="Watermark label" />
      </div>
      <button class="pane-kill" title="Kill the process" disabled>✕</button>
    </div>
    <div class="pane-body">
      <div class="pane-watermark" style="display:none"></div>
      <div class="pane-term"></div>
    </div>`;
  canvas.appendChild(root);

  const term = new Terminal({
    fontFamily:
      getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: auroraTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const termEl = root.querySelector('.pane-term');
  term.open(termEl);

  const p = {
    paneid,
    component,
    term,
    fit,
    root,
    termEl,
    prefs: null,
    dotEl: root.querySelector('.pane-dot'),
    nameEl: root.querySelector('.pane-name'),
    stateEl: root.querySelector('.pane-state'),
    killEl: root.querySelector('.pane-kill'),
    bodyEl: root.querySelector('.pane-body'),
    watermarkEl: root.querySelector('.pane-watermark'),
    nameInput: root.querySelector('.pane-name-input'),
    swatch: root.querySelector('.pane-color'),
    fgSwatch: root.querySelector('.pane-fg'),
    bgSwatch: root.querySelector('.pane-bg'),
    wmInput: root.querySelector('.pane-wm'),
  };
  panes.set(paneid, p);
  p.nameEl.textContent = component.title;

  // input → engine (per-pane, paneid in the body).
  term.onData((d) => transport.send({ type: 'input', paneid, data: d }));
  p.killEl.addEventListener('click', () => transport.send({ type: 'kill', paneid }));

  // pref controls → engine commands (this is the STAND-IN for the design system picker;
  // it emits the exact contract commands `rename` / `setPrefs`).
  p.nameInput.addEventListener('change', () =>
    transport.send({ type: 'rename', paneid, friendlyName: p.nameInput.value || null }),
  );
  p.swatch.addEventListener('change', () =>
    transport.send({ type: 'setPrefs', paneid, color: p.swatch.value }),
  );
  p.fgSwatch.addEventListener('change', () =>
    transport.send({ type: 'setPrefs', paneid, fg: p.fgSwatch.value }),
  );
  p.bgSwatch.addEventListener('change', () =>
    transport.send({ type: 'setPrefs', paneid, bg: p.bgSwatch.value }),
  );
  p.wmInput.addEventListener('change', () =>
    transport.send({ type: 'setPrefs', paneid, watermark: p.wmInput.value || null }),
  );

  new ResizeObserver(() => fitAndSend(p)).observe(termEl);

  // attach: ask the engine to give us this pane (reattach-or-spawn lives engine-side).
  transport.send({ type: 'attach', paneid, component: component.id });
}

/* ---- route engine→renderer events by paneid to the right pane ---- */
transport.on('pane.ready', (msg) => {
  const p = panes.get(msg.paneid);
  if (!p) {
    return;
  }
  setPaneState(p, 'live');
  applyPrefs(p, msg.prefs);
  fitAndSend(p);
});
transport.on('pane.data', (msg) => {
  panes.get(msg.paneid)?.term.write(msg.data);
});
transport.on('pane.exit', (msg) => {
  const p = panes.get(msg.paneid);
  if (!p) {
    return;
  }
  setPaneState(p, 'killed');
  p.term.write(`\r\n\x1b[2m[process exited, code ${msg.code}]\x1b[0m\r\n`);
});
transport.on('pane.prefs', (msg) => {
  const p = panes.get(msg.paneid);
  if (p) {
    applyPrefs(p, msg.prefs);
  }
});
transport.on('pane.error', (msg) => {
  const p = panes.get(msg.paneid);
  if (!p) {
    return;
  }
  p.term.write(`\r\n\x1b[31m[engine: ${msg.message}]\x1b[0m\r\n`);
  setPaneState(p, 'killed');
});

function mountEmpty() {
  canvas.classList.add('is-empty');
  canvas.innerHTML = `
    <div class="wb-empty">
      <div class="wb-empty-glyph">▣</div>
      <p class="wb-empty-head">No components installed</p>
      <p class="wb-empty-sub dim">
        Core booted with <code>src/components/</code> empty — the
        zero-component-boot guarantee. A pane appears here when the first
        component registers in.
      </p>
    </div>`;
}

async function loadComponents() {
  let components = [];
  try {
    const res = await fetch('/api/components');
    const data = await res.json();
    components = Array.isArray(data.components) ? data.components : [];
    componentCount = components.length;
  } catch {
    componentCount = -1;
  }
  if (components.length > 0) {
    canvas.classList.remove('is-empty');
    canvas.innerHTML = '';
    for (const c of components) {
      mountPane(c); // M4: every discovered component → its own pane
    }
  } else {
    mountEmpty();
  }
  renderDebug();
}

function renderDebug() {
  const comp =
    componentCount === null ? '…' : componentCount === -1 ? 'unreachable' : String(componentCount);
  const live = [...panes.values()].filter((p) => p.stateEl.textContent === 'live').length;
  debug.textContent = `mode: ${stage.dataset.mode}  ·  components: ${comp}  ·  panes: ${panes.size} (${live} live)  ·  ${transport.status}  ·  M4`;
}

transport.onStatus(renderDebug);
loadComponents();
renderDebug();
