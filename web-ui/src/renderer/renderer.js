import {createTerminalKeypad} from './web-terminal/keypad.mjs';
import {mountWorkroomsNotificationBanner} from './web-notifications/banner.mjs';
import {newLocalRecipeFolder} from './starter-agents.js';
import {createRecipeFolderPicker} from './recipe-folder-picker.js';
import {parityPatch,changeParityVendor} from './recipe-parity-model.js';
// Workbench renderer: the host for the grid of CLI panes, terminals, tear-out, the window menu,
// settings and theme. No terminal content is inspected here — xterm renders it, we only forward bytes.
//
// Model (the owner, 2026-10-14 / 2026-10-17):
//  - A window opens in the GRID (a split tree of panes, no cap on columns/rows). Tab mode still
//    exists in code but is hidden from the UI for now (module tabs come next: the design notes).
//  - Closing a pane HIDES the CLI (it keeps running, listed in the menu); only "End" in the menu
//    (or the shell exiting) ends it.
//  - The menu's "Window N" pin adds the CLI list as a pane of THIS window.
//  - Settings show one page at a time with a breadcrumb up to Global Settings.
//  - Each window/account keeps its own Concierge recipe and conversation (right-edge handle).

import { hwbRing, hwbRingFromChrome } from '../vendor/aurora/window-chrome/hwb-ring.js';
import * as m3 from './m3.js';
import { createCoach } from './coach.js';
import { renderTabs as m3RenderTabs, fillBar, dropIndex as hwbDropIndex, dropPreview as hwbDropPreview, clearDropPreview as hwbClearDropPreview, icon } from './m3-chrome.js';
import { brandMarkPath } from '../vendor/aurora/brand-marks/aurora-brand-marks.js';
import * as modules from './modules.js';
import { createConciergeSlots, mountConciergeSlots } from './concierge-slot.js';
import { captureTerminalFocus } from './terminal-focus.js';
import { createRouteOverlay, routeWord, untilWord } from './route-overlay.js';
import { createRail } from './rail.js';
import { edgeFlags } from './edge-flags.js';
import { createRoomsPage } from './rooms/page.js';
import { createSeatsSheet } from './rooms/seats-sheet.js';
import { createToolsSheet } from './rooms/tools-sheet.js';
import { createChatsSheet } from './rooms/chats-sheet.js';
import { linkTerminal } from './terminal-links.js';
import { createNeedsYou } from './rooms/needs-you.js';
import { createRoomColors, createRoomPainter } from './rooms/room-color.js';
import { openDialog } from './rooms/dialog.js';
import { confirmDelete } from './tool-delete-dialog.js';
import { createServersPage } from './servers/page.js';
import { createLocalServerPage } from './local-server/page.js';
import { createCodexPage } from './codex/page.js';
import { createScratchpadPage, createScratchpadSettings } from './scratchpad/page.js';
import { createAppsSettings } from './apps-settings.js';
import { refreshColorSwatches } from './color-swatches.js';
import { createAppTonePainter } from './app-tone-painter.js';
import * as pages from './settings-pages.js';
import { createFirstRunUI } from './first-run/ui.js';
import { withEngineHistory } from './first-run/history-api.js';
import { renderAccounts, snackbar as accountsSnackbar, holdSnackbar } from './accounts-page.js';
import { SWATCHES } from './srail.js';
import { renderYourPicture } from './user-picture-settings.js';
import { setUserPicturePalette, refreshUserPicturePalettes } from './user-picture.js';
import { renderStarterVisibilitySettings, openStarterVisibilitySettings } from './starter-visibility-settings.js';
import { withOwnPictureStatus } from './user-picture-bridge.js';
import { renderRequest, askable } from './request-page.js';
import { renderAccountServers, renderServerPage, groupServers } from './servers-page.js';
import * as keysUi from './keys-ui.js';
import { openMenu as roomsMenu, seatBrand } from './rooms/people.js';
import { recipeRows } from './recipe-rows.js';
import { openRecipeImport } from './recipe-import.js';
import { createWebRouter } from './web-shared/web-router.mjs';
import { createWebNav } from './web-shared/web-nav.mjs';
let webNav = null; // the web build's navigation (window.wb.web only); null on desktop
let webRouter = null; // the web build's router seams (window.wb.web.router); null on desktop
import { renderRecipe, renderRecipesList, normalizeFolder } from './recipe-page.js';

const $ = (id) => document.getElementById(id);
const root = $('win');
let localFirstUI = null, localFirstState = null;
function refreshLocalFirstState(state) {
  const previous = localFirstState;
  localFirstState = state;
  if (!state) return;
  $('gsFiles').hidden = $('gsChatHistory').hidden = false;
  const roomsChanged = JSON.stringify([previous?.rooms, previous?.servers, previous?.localRooms, previous?.fileStoreReady]) !== JSON.stringify([state.rooms, state.servers, state.localRooms, state.fileStoreReady]);
  if (roomsChanged) roomsPage?.refreshLocalState?.();
  if (JSON.stringify(previous?.servers) !== JSON.stringify(state.servers)) { serversPage?.paint(); if (settingsPage === 'servers' && !$('settingsPop').hidden) renderPage('servers'); }
  if (JSON.stringify(previous?.starterAgents) !== JSON.stringify(state.starterAgents) && settingsPage === 'recipes' && !$('settingsPop').hidden) renderPage('recipes');
  if (state.localRooms?.restartReason === 'memory' && state.localRooms.restartId !== previous?.localRooms?.restartId) localFirstUI?.notifyMemoryRestart();
}
const stripEl = root.querySelector('.hwb-tabs');
const stageEl = $('stage');
const gridEl = $('grid');
const BRAND = 'generic'; // the >_ mark
const MARK = brandMarkPath(BRAND);
const FONT = '"Roboto Mono", "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';
// the vendored mono is loaded up front, so a fingerprint or a terminal never draws in the fallback first
document.fonts.load("500 14px 'Roboto Mono'").catch(() => null);
const GEAR = icon('settings');
const PIN = icon('push_pin');

const tabs = new Map(); // sid -> { sid, title, name, hue, box, term, fit, ser }
let order = []; // visible sids, in tab order
let activeSid = null;
let myWid = 0;
let sessionList = [];
// step 3d: the brokers' lists (main polls them) → the rail's groups; what a group last showed, so a
// broker that is reconnecting keeps its rows dimmed and one that is down says so (the design's 3d page)
let brokerGroups = [];
const groupMemory = new Map(); // serverId -> { rows }
const dismissedEnded = new Set(); // "Ended · 3 min ago" rows cleared with ✕ (per window)
function agoWord(t) {
  const s = Math.max(0, Math.round((Date.now() - (Number(t) || 0)) / 1000));
  if (s < 60) {
    return 'just now';
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return m + ' min ago';
  }
  const h = Math.round(m / 60);
  return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
}
function groupViews() {
  const out = [];
  for (const g of brokerGroups) {
    const key = g.serverId;
    const title = `${g.serverName} · ${g.login}`;
    const mem = groupMemory.get(key) || { rows: [] };
    if (!g.ok) {
      if (!mem.rows.length) {
        continue; // nothing of ours was there: no group (never assumed)
      }
      if (g.state === 'reconnecting') {
        out.push({ key, title, count: '', line: 'Reconnecting…', dim: true, rows: mem.rows });
      } else {
        out.push({ key, title, count: '', line: 'Broker not running. CLIs that kept running there have stopped.', warn: true, rows: [] });
      }
      continue;
    }
    const rows = g.rows
      .filter((r) => r.openSid == null && !(!r.alive && dismissedEnded.has(key + '/' + r.bsid)))
      .map((r) => ({
        key: key + '/' + r.bsid,
        serverId: key,
        bsid: r.bsid,
        name: r.name || 'Terminal',
        hue: r.hue,
        recipeId: r.recipeId,
        folder: r.folder,
        line: r.alive ? [r.folder || '~', r.startedOn ? 'started on ' + r.startedOn : ''].filter(Boolean).join(' · ') : 'Ended · ' + agoWord(r.endedAt || r.createdAt),
        ended: !r.alive,
      }));
    groupMemory.set(key, { rows: rows.filter((r) => !r.ended) });
    if (!rows.length) {
      continue; // "No group when nothing of yours runs there that isn't open here"
    }
    out.push({
      key,
      title,
      count: g.cap ? `${g.live} of ${g.cap} running` : `${g.live} running`,
      atLimit: !!g.cap && g.live >= g.cap,
      line: g.draining ? 'Waiting to update · no new CLIs' : g.graceUntil ? 'Access removed · they run until ' + untilWord(g.graceUntil) : '',
      rows,
    });
  }
  return out;
}
function applyGroups() {
  if (rail) {
    rail.setGroups(signedIn() ? groupViews() : []);
  }
}
window.wb.on('broker:groups', ({ accountId, selectionVersion, groups, keptRunning }) => {
  if (!currentViewScope({ accountId, selectionVersion })) return;
  brokerGroups = Array.isArray(groups) ? groups : [];
  applyGroups();
  if (signedIn()) {
    recipesApply(); // a draining broker's recipe rows read "Waiting to update"
  }
  if (Array.isArray(keptRunning) && keptRunning.length) {
    // the first time only (main remembers): "Your CLIs on server kept running. They're in the rail."
    const list = keptRunning.length === 1 ? keptRunning[0] : keptRunning.slice(0, -1).join(', ') + ' and ' + keptRunning[keptRunning.length - 1];
    accountsSnackbar(`Your CLIs on ${list} kept running. They're in the rail.`);
  }
});
/** Open from a group row (3d): a pane here attached to the broker's session, never a new one. */
async function openBrokerSession(serverId, bsid, v) {
  await launch({ spec: { route: 'broker', serverId, bsid, attachOnly: true, name: v.name, folder: v.folder, recipeId: v.recipeId || undefined }, name: v.name, hue: v.hue == null ? undefined : v.hue, why: 'open' });
}
function showGroup(serverId) {
  if (rail && serverId) {
    rail.focusGroup(serverId);
  }
}
const DEFAULT_HUE = 215;
const SAMPLE_HUES = [190, 140, 215, 300, 25, 45, 245, 340]; // teal green blue magenta orange gold indigo pink
const dockEl = $('dock');
const conc = { open: false, w: 420, term: null, fit: null, ser: null, sid: null, box: null, starting: false, epoch: 0 };
let conciergeSlotView = null;
const conciergeSlots = createConciergeSlots({
  readBinding: () => ({ open: conc.open && conciergeLocalScope(), epoch: conc.epoch, accountEpoch, sid: conc.sid }),
  changed: () => { if (conciergeSlotView?.render()) conciergeFit(); },
});
const early = new Map(); // sid -> chunks that arrived before the tab existed
const routeStates = new Map(); // sid -> the route's last state from main (Reconnecting, Can't reach, ...)
let lastLaunch = null; // { sid, routeAtOpen }: what the route said when the last pane opened (self-test)
let dragState = null;
let rail = null; // the CLIs rail (rail.js), made once the DOM helpers below exist
let roomsPage = null; // W1: the Workrooms page (src/renderer/rooms/page.js)
setUserPicturePalette((node,profile)=>{
  const seed=/^#[0-9a-f]{6}$/i.test(profile?.color||'')?profile.color:roomsPage?.personColor?.();
  if(seed){m3.applyTo(node,seed,m3.get().style);node.dataset.identityPalette='true';}
});
let serversPage = null; // 3e: the Servers tab (src/renderer/servers/page.js)
let codexPage = null;
let codexAvailable = false;
let scratchpadPage = null;
let scratchpadSettings = null;
let appsSettings = null;
let roomsFlag = null;
// 0.12.2: the Console tab's state (its functions sit with the recipes' code below; closePops needs it early)
const cs = { el: $('console'), top: null, div: null, pane: null, msg: null, on: false, sid: null, serverId: null, name: '', login: '', host: '', frac: 0.55, ro: null };
cs.top = cs.el.querySelector('.cs-top');
cs.div = cs.el.querySelector('.cs-div');
cs.pane = cs.el.querySelector('.cs-pane');
cs.msg = cs.el.querySelector('.cs-msg');
let platform = 'win32'; // from init

let mode = 'panes'; // 'panes' | 'tabs' (tab mode is dormant: hidden from the UI since 0.6)
let listPinned = false; // the CLI list is a pane of this window (shown in pane mode)
const layout = { tree: null, dirty: false }; // split tree for pane mode
const paneEls = new Map(); // sid -> pane element (pane mode)
let listBodies = []; // list-pane body elements, refreshed on session changes

const dbg = (event, fields) => window.wb.dlog(event, fields);

// ---- zoom: Ctrl+wheel shrinks the terminal text (14px is the maximum); the title bars shrink
// at half that rate so they stay usable.
const FONT_MAX = 14;
const ZOOM_MIN = 0.45;
let zoom = 1;
try {
  zoom = Math.min(1, Math.max(ZOOM_MIN, Number(localStorage.getItem('wb.zoom')) || 1));
} catch (err) {
  // storage unavailable: stay at full size
}
const termFont = () => Math.max(6, Math.round(FONT_MAX * zoom));
const barScale = () => 1 - (1 - zoom) / 2;
// the ring glyph's box has no fill of its own: the plate (the visible icon) is 22/24 of it, so a 31 px box
// shows a 28 px plate with 6 px above and below in the 40 px header, matching the engine's header;
// the 33 px box of 0.12.4 showed a 30 px plate
const ringPx = () => Math.max(20, Math.round(30.5 * barScale()));

function applyZoom() {
  document.documentElement.style.setProperty('--bar-s', String(barScale()));
  for (const t of tabs.values()) {
    t.term.options.fontSize = termFont();
    t.fit.fit();
  }
  conciergeZoom();
  if (mode === 'panes') {
    refreshPaneChrome();
  }
  try {
    localStorage.setItem('wb.zoom', String(zoom));
  } catch (err) {
    // not persisted
  }
}

window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const next = Math.min(1, Math.max(ZOOM_MIN, Math.round((zoom + (e.deltaY > 0 ? -0.05 : 0.05)) * 100) / 100));
    if (next !== zoom) {
      zoom = next;
      applyZoom();
    }
  },
  { passive: false, capture: true }
);

// ---------------------------------------------------------------- theme

// Color is PER TAB/PANE. One input — the hue — and the design derives bar, tab, wash,
// terminal ground and watermark from the resulting --base in CSS.
function baseOf(h) {
  return m3.seedOfHue(h);
}

function themeFor(h) {
  return m3.termTheme(baseOf(h));
}

function displayName(t) {
  return t.name || niceTitle(t.title);
}

function sendMeta(t) {
  window.wb.setMeta(t.sid, t.name, t.hue);
}

// OSC titles from Windows shells are often a full exe path; show the program name.
function niceTitle(t) {
  const raw = String(t || '');
  if (!/^[A-Za-z]:[\\/]/.test(raw) || /\s/.test(raw.trim())) {
    return raw || 'Terminal';
  }
  const base = raw.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  const n = base.toLowerCase();
  if (n === 'powershell' || n === 'pwsh') {
    return 'PowerShell';
  }
  return n === 'cmd' ? 'Command Prompt' : base;
}

function stateOf(sid) {
  const s = sessionList.find((x) => x.sid === sid);
  if (s && s.needsYou === 'alarm') {
    return 'waiting'; // Needs you: the ring's attention look, on the pane as on the rail row
  }
  return s && s.flowing ? 'streaming' : 'idle';
}

// ---------------------------------------------------------------- chrome rendering

function renderSessionBar() {
  const t = tabs.get(activeSid);
  fillBar($('sbar'), {
    name: t ? displayName(t) : '',
    state: t ? stateOf(t.sid) : 'idle',
    ringSize: 28,
    brand: BRAND,
    markPath: MARK,
  });
  const gear = document.createElement('button');
  gear.className = 'sb-ib';
  gear.id = 'gear';
  gear.title = 'Theme & settings';
  gear.setAttribute('aria-label', 'Theme & settings');
  gear.innerHTML = GEAR;
  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('settingsPop').hidden;
    closePops();
    if (open) {
      openSettings('pane');
    }
  });
  $('sbar').appendChild(gear);
}

function renderChromeCommon() {
  const act = tabs.get(activeSid);
  const seed = baseOf(act ? act.hue : DEFAULT_HUE);
  if (mode === 'tabs') {
    // the active tab's colors drive the session bar and the terminal ground
    m3.applyTo($('sbar'), seed);
    m3.applyTo(stageEl, seed);
    stageEl.style.background = 'var(--term-bg)';
    renderSessionBar(); // pane mode: every pane carries its own title bar instead
  } else {
    stageEl.style.cssText = ''; // pane mode: panes carry their own colors
  }
  root.style.setProperty('--base', seed);
}

function renderTabsStrip() {
  m3RenderTabs(root, {
    tabs: order.map((sid) => ({
      id: String(sid),
      name: displayName(tabs.get(sid)),
      seed: baseOf(tabs.get(sid).hue),
      state: stateOf(sid),
      active: sid === activeSid,
      markPath: MARK,
    })),
    brand: BRAND,
    onSelect: (id) => activate(Number(id)),
  });
}

// structural = membership/mode/layout changed (rebuild panes); otherwise only chrome text/rings.
function refresh(structural) {
  if (mode === 'tabs') {
    renderTabsStrip();
  } else if (structural) {
    syncTree();
    renderGrid();
  } else {
    refreshPaneChrome();
  }
  renderChromeCommon();
  refreshListBodies();
  updateEmpty();
  if (rail) {
    rail.update(sessionList);
  }
}

function renderTabs() {
  refresh(false);
}

// The grid's empty state (the design, step 2): hidden CLIs still running, or no CLIs at all.
function updateEmpty() {
  const empty = tabs.size === 0 && !(mode === 'panes' && listPinned);
  $('empty').hidden = !empty;
  if (empty) {
    const any = sessionList.length > 0;
    $('emptyT').textContent = any ? 'No open CLI' : 'No CLIs open';
    $('emptyH').textContent = any ? 'Your hidden CLIs are still running. Open one from the list, or start a new one.' : 'Start a shell, or run one of your recipes.';
    $('emptyList').hidden = !any;
  }
}

// ---------------------------------------------------------------- mode + split tree

const leafCli = (sid) => ({ type: 'leaf', kind: 'cli', sid });
const leafList = () => ({ type: 'leaf', kind: 'list' });

// Right-nested chain with equal shares: fractions 1/n, 1/(n-1), ...
function chain(nodes, dir) {
  if (nodes.length === 1) {
    return nodes[0];
  }
  return { type: 'split', dir, frac: 1 / nodes.length, a: nodes[0], b: chain(nodes.slice(1), dir) };
}

// Near-square grid shaped to the stage's aspect (wide windows get more columns).
function autoArrange(sids) {
  const leaves = sids.map(leafCli);
  if (listPinned) {
    leaves.push(leafList());
  }
  const n = leaves.length;
  if (!n) {
    return null;
  }
  const r = stageEl.getBoundingClientRect();
  const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 1.6;
  const cols = Math.min(n, Math.max(1, Math.round(Math.sqrt(n * aspect * 0.85))));
  const rowsOf = [];
  for (let i = 0; i < n; i += cols) {
    rowsOf.push(chain(leaves.slice(i, i + cols), 'row'));
  }
  return chain(rowsOf, 'col');
}

function collectSids(node, out = []) {
  if (!node) {
    return out;
  }
  if (node.type === 'leaf') {
    if (node.kind === 'cli') {
      out.push(node.sid);
    }
    return out;
  }
  collectSids(node.a, out);
  collectSids(node.b, out);
  return out;
}

function hasList(node) {
  if (!node) {
    return false;
  }
  return node.type === 'leaf' ? node.kind === 'list' : hasList(node.a) || hasList(node.b);
}

// New panes land lower-right: split the last leaf, alternating the axis.
function addLeaf(node, leaf, parentDir) {
  if (!node) {
    return leaf;
  }
  if (node.type === 'leaf') {
    return { type: 'split', dir: parentDir === 'row' ? 'col' : 'row', frac: 0.5, a: node, b: leaf };
  }
  node.b = addLeaf(node.b, leaf, node.dir);
  return node;
}

// Keep a user-arranged tree: drop panes that are gone, add new ones, honour the list pin.
function reconcile(tree, sids) {
  const prune = (node) => {
    if (node.type === 'leaf') {
      if (node.kind === 'cli') {
        return sids.includes(node.sid) ? node : null;
      }
      return listPinned ? node : null;
    }
    const a = prune(node.a);
    const b = prune(node.b);
    if (!a && !b) {
      return null;
    }
    if (!a) {
      return b;
    }
    if (!b) {
      return a;
    }
    node.a = a;
    node.b = b;
    return node;
  };
  let t = prune(tree);
  const present = collectSids(t);
  for (const sid of sids) {
    if (!present.includes(sid)) {
      t = addLeaf(t, leafCli(sid), null);
    }
  }
  if (listPinned && !hasList(t)) {
    t = addLeaf(t, leafList(), null);
  }
  return t;
}

function syncTree() {
  const sids = order.slice();
  layout.tree = !layout.tree || !layout.dirty ? autoArrange(sids) : reconcile(layout.tree, sids);
}


function setMode(m) {
  if (m === mode) {
    return;
  }
  mode = m;
  window.wb.reportMode(m);
  closePops();
  if (m === 'tabs') {
    root.classList.add('is-tabbed');
    root.classList.remove('is-panes');
    gridEl.hidden = true;
    for (const t of tabs.values()) {
      if (t.host === 'workrooms') continue;
      stageEl.appendChild(t.box);
      t.box.classList.toggle('active', t.sid === activeSid);
      if (t.rx) {
        t.box.appendChild(t.rx.el);
      }
    }
    refresh(false);
    requestAnimationFrame(() => {
      fitAll();
      fitOverlayTabs();
    });
  } else {
    root.classList.remove('is-tabbed');
    root.classList.add('is-panes');
    gridEl.hidden = false;
    refresh(true);
  }
  dbg('mode', { mode, panes: tabs.size });
}

// ---------------------------------------------------------------- pane grid

const roPanes = new ResizeObserver((entries) => {
  for (const en of entries) {
    const sid = Number(en.target.dataset.sid);
    const t = tabs.get(sid);
    if (t && inlineTerminalCurrent(t)) {
      t.fit.fit();
      if (t.rx) {
        const small = isSmallBody(t);
        t.rx.resize(small);
        placeOverlay(t);
        syncStrip(t);
        const pane = paneEls.get(sid);
        if (pane) {
          pane.classList.toggle('is-small-body', small);
        }
      }
    }
  }
});

function fitAll() {
  for (const t of tabs.values()) {
    if (inlineTerminalCurrent(t)) t.fit.fit();
  }
}

function renderGrid() {
  const inlinePanes = [...paneEls].filter(([sid]) => tabs.get(sid)?.host === 'workrooms');
  roPanes.disconnect();
  paneEls.clear();
  for (const [sid, pane] of inlinePanes) { paneEls.set(sid, pane); roPanes.observe(pane.querySelector('.pane-body')); }
  listBodies = [];
  for (const t of tabs.values()) {
    if (t.host !== 'console' && t.host !== 'workrooms') {
      stageEl.appendChild(t.box); // park boxes before the old grid DOM is dropped
    }
  }
  gridEl.textContent = '';
  if (layout.tree) {
    gridEl.appendChild(buildNode(layout.tree));
  }
  for (const t of tabs.values()) {
    if (!t.box.parentElement || t.box.parentElement === stageEl) {
      t.box.classList.remove('active');
    }
  }
  refreshPaneChrome();
  refreshListBodies(); // a rebuilt list pane starts empty
  requestAnimationFrame(fitAll);
}

function buildNode(node) {
  if (node.type === 'leaf') {
    return node.kind === 'list' ? buildListPane() : buildCliPane(node.sid);
  }
  const el = document.createElement('div');
  el.className = 'split ' + node.dir;
  const a = document.createElement('div');
  a.className = 'cell';
  a.style.flexBasis = 'calc(' + node.frac * 100 + '% - 2px)';
  a.appendChild(buildNode(node.a));
  const d = document.createElement('div');
  d.className = 'divider ' + node.dir;
  const b = document.createElement('div');
  b.className = 'cell grow';
  b.appendChild(buildNode(node.b));
  el.append(a, d, b);
  d.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    d.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const horiz = node.dir === 'row';
    const move = (ev) => {
      const pos = horiz ? ev.clientX - rect.left : ev.clientY - rect.top;
      const size = horiz ? rect.width : rect.height;
      node.frac = Math.max(0.08, Math.min(0.92, pos / size));
      a.style.flexBasis = 'calc(' + node.frac * 100 + '% - 2px)';
      layout.dirty = true; // the user shaped this: keep it across tabs <-> panes
    };
    const up = () => {
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
      fitAll();
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
  });
  return el;
}

// ---- drag a pane by its title bar to move it within the grid.
// Drop on a pane's edge = split that pane and put the dragged one on that side; drop in the
// middle = swap the two. A light box follows the cursor; the landing area is outlined.

const leafKey = (l) => (l.kind === 'list' ? 'list' : l.sid);

function removeLeaf(node, key) {
  if (node.type === 'leaf') {
    return leafKey(node) === key ? null : node;
  }
  const a = removeLeaf(node.a, key);
  const b = removeLeaf(node.b, key);
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  node.a = a;
  node.b = b;
  return node;
}

function findLeaf(node, key) {
  if (node.type === 'leaf') {
    return leafKey(node) === key ? node : null;
  }
  return findLeaf(node.a, key) || findLeaf(node.b, key);
}

function insertBeside(node, targetKey, leaf, side) {
  if (node.type === 'leaf') {
    if (leafKey(node) !== targetKey) {
      return node;
    }
    const dir = side === 'left' || side === 'right' ? 'row' : 'col';
    const first = side === 'left' || side === 'top';
    return { type: 'split', dir, frac: 0.5, a: first ? leaf : node, b: first ? node : leaf };
  }
  node.a = insertBeside(node.a, targetKey, leaf, side);
  node.b = insertBeside(node.b, targetKey, leaf, side);
  return node;
}

function swapLeaves(node, k1, k2) {
  if (node.type === 'leaf') {
    const k = leafKey(node);
    if (k === k1) {
      return leafProto(k2);
    }
    if (k === k2) {
      return leafProto(k1);
    }
    return node;
  }
  node.a = swapLeaves(node.a, k1, k2);
  node.b = swapLeaves(node.b, k1, k2);
  return node;
}
const leafProto = (k) => (k === 'list' ? leafList() : leafCli(k));

// The outer edge of the grid: dropping there makes a new row/column that spans the whole grid
// (e.g. a full-height column on the left across several rows).
const EDGE_BAND = 40;
function rootEdgeZone(x, y) {
  const r = gridEl.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
    return null;
  }
  const d = { left: x - r.left, right: r.right - x, top: y - r.top, bottom: r.bottom - y };
  const side = Object.keys(d).reduce((m, k) => (d[k] < d[m] ? k : m), 'left');
  if (d[side] > EDGE_BAND) {
    return null;
  }
  const w = r.width / 4;
  const h = r.height / 4;
  const rect = {
    left: { left: r.left, top: r.top, width: w, height: r.height },
    right: { left: r.right - w, top: r.top, width: w, height: r.height },
    top: { left: r.left, top: r.top, width: r.width, height: h },
    bottom: { left: r.left, top: r.bottom - h, width: r.width, height: h },
  }[side];
  return { side, rect, root: true };
}

function insertAtRoot(tree, leaf, side) {
  const dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const first = side === 'left' || side === 'top';
  return { type: 'split', dir, frac: first ? 0.25 : 0.75, a: first ? leaf : tree, b: first ? tree : leaf };
}

function dropZone(pane, x, y, noSwap) {
  const r = pane.getBoundingClientRect();
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  if (!noSwap && fx > 0.28 && fx < 0.72 && fy > 0.28 && fy < 0.72) {
    return { side: 'swap', rect: r };
  }
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  const side = Object.keys(d).reduce((m, k) => (d[k] < d[m] ? k : m), 'left');
  const w = r.width / 2;
  const h = r.height / 2;
  const rect = {
    left: { left: r.left, top: r.top, width: w, height: r.height },
    right: { left: r.left + w, top: r.top, width: w, height: r.height },
    top: { left: r.left, top: r.top, width: r.width, height: h },
    bottom: { left: r.left, top: r.top + h, width: r.width, height: h },
  }[side];
  return { side, rect };
}

let paneDrag = null;

// A CLI dragged in from another window while this one is in pane mode: anywhere over the grid
// shows where it will land (the outlined half of the pane under the cursor).
function dropPlanAt(x, y) {
  const edge = rootEdgeZone(x, y);
  if (edge) {
    return { targetKey: null, zone: edge };
  }
  const over = document.elementFromPoint(x, y);
  const pane = over && over.closest('.pane');
  if (!pane || !gridEl.contains(pane)) {
    return null;
  }
  return {
    targetKey: pane.classList.contains('is-list') ? 'list' : Number(pane.dataset.sid),
    zone: dropZone(pane, x, y, true),
  };
}

function clearGridDrop() {
  for (const m of document.querySelectorAll('.pane-drop.incoming')) {
    m.remove();
  }
}

function previewGridDrop(x, y) {
  const plan = dropPlanAt(x, y);
  if (!plan) {
    clearGridDrop();
    return;
  }
  let m = document.querySelector('.pane-drop.incoming');
  if (!m) {
    m = document.createElement('div');
    m.className = 'pane-drop edge incoming';
    document.body.appendChild(m);
  }
  const r = plan.zone.rect;
  m.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
  m.dataset.label = 'Move to ' + windowLabel(myWid);
}

// Dragged out of the window: same hand-off as a tab tear-out — main opens a window under
// the cursor (or, for the only CLI, moves this window) and drag:move/end follow the cursor.
async function paneTearOut(sid) {
  const t = tabs.get(sid);
  const r = await window.wb.dragStart(sid, t.ser.serialize());
  if (r.ok && !r.solo) {
    removeTabLocal(sid);
  }
}

function endPaneDrag(commit) {
  const st = paneDrag;
  paneDrag = null;
  window.removeEventListener('pointermove', onPaneDragMove, true);
  window.removeEventListener('pointerup', onPaneDragUp, true);
  window.removeEventListener('keydown', onPaneDragKey, true);
  if (!st) {
    return;
  }
  st.ghost.remove();
  st.mark.remove();
  st.pane.classList.remove('is-dragging');
  document.body.classList.remove('pane-dragging');
  try {
    gridEl.releasePointerCapture(st.pid);
  } catch (err) {
    // capture may already be gone
  }
  if (st.torn) {
    st.torn.then(() => window.wb.dragEnd());
    return;
  }
  if (!commit || !st.active || !st.target) {
    return;
  }
  applyMove(st.key, st.target);
}

// Move a leaf of this window's grid to a drop target (an edge of the grid, or beside/over a pane).
function applyMove(key, target) {
  const { targetKey, zone } = { targetKey: target.key, zone: target.zone };
  if (zone.root) {
    const rest = removeLeaf(layout.tree, key);
    layout.tree = rest ? insertAtRoot(rest, leafProto(key), zone.side) : layout.tree;
  } else if (zone.side === 'swap') {
    layout.tree = swapLeaves(layout.tree, key, targetKey);
  } else {
    const moving = leafProto(key);
    const rest = removeLeaf(layout.tree, key);
    layout.tree = insertBeside(rest, targetKey, moving, zone.side);
  }
  layout.dirty = true;
  dbg('pane-move', { side: zone.side });
  renderGrid();
}

function onPaneDragMove(e) {
  const st = paneDrag;
  if (!st) {
    return;
  }
  if (!st.active) {
    if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 6) {
      return;
    }
    st.active = true;
    st.pane.classList.add('is-dragging');
    document.body.classList.add('pane-dragging');
    document.body.append(st.ghost, st.mark);
  }
  if (st.torn) {
    window.wb.dragMove();
    return;
  }
  const left = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
  if (typeof st.key === 'number' && (left || tabs.size === 1)) {
    st.ghost.remove();
    st.mark.remove();
    document.body.classList.remove('pane-dragging');
    st.torn = paneTearOut(st.key);
    return;
  }
  st.ghost.style.transform = 'translate(' + (e.clientX + 12) + 'px,' + (e.clientY + 12) + 'px)';
  st.target = null;
  st.mark.hidden = true;
  const edge = rootEdgeZone(e.clientX, e.clientY);
  const over = document.elementFromPoint(e.clientX, e.clientY);
  const pane = over && over.closest('.pane');
  if (edge) {
    st.target = { key: null, zone: edge };
    st.mark.hidden = false;
    st.mark.className = 'pane-drop edge';
    st.mark.style.cssText =
      'left:' + edge.rect.left + 'px;top:' + edge.rect.top + 'px;width:' + edge.rect.width + 'px;height:' + edge.rect.height + 'px';
    st.mark.dataset.label = 'Place here';
  } else if (pane && pane !== st.pane && gridEl.contains(pane)) {
    const zone = dropZone(pane, e.clientX, e.clientY);
    const targetKey = pane.classList.contains('is-list') ? 'list' : Number(pane.dataset.sid);
    st.target = { key: targetKey, zone };
    st.mark.hidden = false;
    st.mark.className = 'pane-drop ' + (zone.side === 'swap' ? 'swap' : 'edge');
    st.mark.style.cssText =
      'left:' + zone.rect.left + 'px;top:' + zone.rect.top + 'px;width:' + zone.rect.width + 'px;height:' + zone.rect.height + 'px';
    st.mark.dataset.label = dropLabel(zone, targetKey);
  }
}

// The words on a drop preview (the design, step 2): "Place here", or "Swap with api".
function dropLabel(zone, targetKey) {
  if (zone.side !== 'swap') {
    return 'Place here';
  }
  const t = tabs.get(targetKey);
  return 'Swap with ' + (t ? displayName(t) : 'CLIs');
}

function onPaneDragUp() {
  endPaneDrag(true);
}

function onPaneDragKey(e) {
  if (e.key === 'Escape' && paneDrag && !paneDrag.torn) {
    endPaneDrag(false);
  }
}

// keyboard modality for focus rings: a key press shows them, a pointer press hides them
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
    document.documentElement.classList.add('kbd');
  }
}, true);
window.addEventListener('pointerdown', () => document.documentElement.classList.remove('kbd'), true);
gridEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button, [data-act]')) {
    return;
  }
  const h = e.target.closest('.pane-h');
  const pane = h && h.closest('.pane');
  if (!pane || !gridEl.contains(pane)) {
    return;
  }
  const key = pane.classList.contains('is-list') ? 'list' : Number(pane.dataset.sid);
  const ghost = document.createElement('div');
  ghost.className = 'pane-ghost';
  ghost.style.setProperty('--base', pane.style.getPropertyValue('--base') || baseOf(DEFAULT_HUE));
  ghost.textContent = key === 'list' ? 'CLIs' : displayName(tabs.get(key));
  const mark = document.createElement('div');
  mark.className = 'pane-drop';
  mark.hidden = true;
  paneDrag = { key, pane, ghost, mark, pid: e.pointerId, x0: e.clientX, y0: e.clientY, active: false, target: null, torn: null };
  try {
    gridEl.setPointerCapture(e.pointerId); // keep events flowing when the cursor leaves the window
  } catch (err) {
    // no live pointer (synthetic events)
  }
  window.addEventListener('pointermove', onPaneDragMove, true);
  window.addEventListener('pointerup', onPaneDragUp, true);
  window.addEventListener('keydown', onPaneDragKey, true);
});

// Each pane's title bar is its own: status ring, name, activity chip and — on the selected
// pane — the settings gear. Rebuilt on every chrome refresh.
function paintPaneHeader(pane, t) {
  const h = pane.querySelector('.pane-h');
  const rw = routeWord(t.route);
  const brand = t.host === 'workrooms' ? t.inlineBrand : BRAND;
  fillBar(h, { name: displayName(t), state: stateOf(t.sid), ringSize: ringPx(), brand, markPath: t.host === 'workrooms' ? brandMarkPath(brand) : MARK, attached: !rw });
  if (rw) {
    // The route's status word: an error chip, or quiet text for Reconnecting (the design, step 1).
    const w = document.createElement('span');
    w.className = 'pane-rstate ' + rw.kind;
    w.textContent = rw.text;
    h.appendChild(w);
  }
  if ((acc.st?.accounts || []).length > 1 && t.route?.accountId) {
    const chip = document.createElement('span'); chip.className = 'account-chip'; chip.textContent = t.route.realmName || 'Account'; chip.title = t.route.accountLabel || ''; h.appendChild(chip);
  }
  const sl = sessionList.find((x) => x.sid === t.sid);
  if (sl && sl.keepsRunning && !rw) {
    // 3d: the Keeps running icon in the title bar, the word too when the pane is wide enough
    const k = document.createElement('span');
    k.className = 'pane-kr';
    k.innerHTML = icon('all_inclusive') + (pane.clientWidth > 520 ? '<span class="t">Keeps running</span>' : '');
    k.title = 'Stays on ' + sl.place + ' when you close the Workbench. Ends if ' + sl.place + ' or its broker restarts.';
    h.appendChild(k);
  }
  if (sl && sl.termOf) {
    // W3b (the design's W3 table): a seat's terminal leads back to its room
    const back = document.createElement('button');
    back.className = 'pane-back';
    back.type = 'button';
    back.innerHTML = icon('arrow_back');
    const phone = !!(window.wb && window.wb.web && window.matchMedia && window.matchMedia('(max-width: 599px)').matches); // a phone's terminal layer says "Back to the room" (the design s8)
    const where = phone ? 'the room' : sl.termOf.roomName || 'the room';
    back.appendChild(document.createTextNode('Back to ' + where));
    back.title = 'Back to ' + (sl.termOf.roomName || 'the room') + ' in Workrooms';
    back.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (t.host === 'workrooms') { closeInlineTerminal(t); return; }
      if (t.route?.accountId && t.route.accountId !== acc.st?.account?.id) await selectAccount(t.route.accountId);
      modules.setSurface('workrooms');
      if (roomsPage) {
        roomsPage.showRoom(sl.termOf.roomId);
      }
    });
    h.appendChild(back);
  }
  const gear = document.createElement('button');
  gear.className = 'sb-ib pane-gear';
  gear.dataset.act = 'settings';
  gear.title = 'Theme & settings';
  gear.setAttribute('aria-label', 'Theme & settings');
  gear.innerHTML = GEAR;
  const x = document.createElement('button');
  x.className = 'sb-ib px';
  x.dataset.act = 'hide';
  x.title = 'Hide · keeps running';
  x.setAttribute('aria-label', 'Hide · keeps running');
  x.innerHTML = icon('close');
  if (t.keypad) h.appendChild(t.keypad.toggle);
  h.append(gear, x);
  t.keypad?.refresh();
}

function buildCliPane(sid) {
  const t = tabs.get(sid);
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.dataset.sid = sid;
  const h = document.createElement('div');
  h.className = 'pane-h';
  const body = document.createElement('div');
  body.className = 'pane-body';
  body.dataset.sid = sid;
  body.appendChild(t.box);
  t.box.classList.add('active');
  if (t.rx) {
    body.appendChild(t.rx.el);
    syncStrip(t);
  }
  // W3b: after typing in a watched seat, the next Tab goes to the strip's [Take control]
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && t.rx && t.rx.takeTab && t.rx.takeTab()) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  pane.append(h, body);
  pane.addEventListener('pointerdown', () => {
    if (!inlineTerminalCurrent(t)) return;
    window.wb.seen(sid, 'pointer');
    if (activeSid !== sid) {
      activate(sid);
    }
  }, true);
  pane.addEventListener('click', (e) => {
    if (!inlineTerminalCurrent(t)) return;
    const b = e.target.closest('[data-act]');
    if (!b) {
      return;
    }
    e.stopPropagation();
    if (b.dataset.act === 'hide') {
      if (t.host === 'workrooms') {
        closeInlineTerminal(t);
      } else if (t.host === 'console') {
        closeConsoleTerminal(sid); // its ✕ closes (at a prompt at once; while something runs, it asks)
      } else {
        hideTab(sid);
      }
    } else if (b.dataset.act === 'settings') {
      if (activeSid !== sid) {
        activate(sid);
      }
      closePops();
      openSettings('pane');
    }
  });
  paneEls.set(sid, pane);
  roPanes.observe(body);
  return pane;
}

function buildListPane() {
  const pane = document.createElement('div');
  pane.className = 'pane is-list';
  m3.applyTo(pane, baseOf(DEFAULT_HUE));
  const h = document.createElement('div');
  h.className = 'pane-h';
  fillBar(h, { name: 'CLIs', state: 'idle', ringSize: ringPx(), brand: BRAND, markPath: MARK });
  const x = document.createElement('button');
  x.className = 'sb-ib px';
  x.title = 'Remove the list pane (the menu still lists everything)';
  x.innerHTML = icon('close');
  x.addEventListener('click', () => setPinned(false));
  h.appendChild(x);
  const body = document.createElement('div');
  body.className = 'pane-body listbody';
  pane.append(h, body);
  bindListClicks(body);
  listBodies.push(body);
  return pane;
}

function refreshPaneChrome() {
  for (const [sid, pane] of paneEls) {
    const t = tabs.get(sid);
    if (!t) {
      continue;
    }
    const base = baseOf(t.hue);
    m3.applyTo(pane, base);
    pane.style.setProperty('--base', base);
    pane.classList.toggle('is-active', sid === activeSid);
    paintPaneHeader(pane, t);
    t.term.options.theme = themeFor(t.hue);
  }
}

function refreshListBodies() {
  for (const b of listBodies) {
    renderSessionList(b, false);
  }
}

function setPinned(on) {
  if (on && !modules.hasPaneKind('list')) {
    return; // the Status Monitor module is off: there is no list pane to pin
  }
  listPinned = on;
  if (mode === 'panes') {
    refresh(true);
  }
  if (!$('flyout').hidden) {
    renderFlyout();
  }
}

// ---------------------------------------------------------------- tabs

function activate(sid, seatFocus) {
  if (!tabs.has(sid)) {
    return;
  }
  if (!inlineTerminalCurrent(tabs.get(sid))) return;
  activeSid = sid;
  window.wb.paneActive(sid);
  if (mode === 'tabs') {
    for (const t of tabs.values()) {
      t.box.classList.toggle('active', t.sid === sid);
    }
  }
  refresh(false);
  const t = tabs.get(sid);
  if (t.route?.route === 'term') t.seatAttachFocus ||= seatFocus || captureTerminalFocus(document);
  if (!$('settingsPop').hidden) {
    fillSettings();
  }
  requestAnimationFrame(() => {
    if (tabs.get(sid) !== t || (t.host === 'workrooms' && !t.inlineCurrent())) return;
    t.fit.fit();
    fitOverlayTabs();
    if (t.seatAttachFocus || t.route?.route === 'term') { focusSeatTerminal(t); return; }
    if (t.rx && t.rx.hasCard()) {
      // A route card over the active pane holds the focus (the design, step 1); Esc gives it back.
      if (!t.rx.el.contains(document.activeElement)) {
        t.rx.focusPrimary();
      }
    } else if ($('settingsPop').hidden || document.activeElement !== $('tabName')) {
      t.term.focus();
    }
  });
}

function removeTabLocal(sid) {
  const t = tabs.get(sid);
  if (!t) {
    return;
  }
  if (t.rx) {
    t.rx.dispose();
  }
  routeStates.delete(sid); // main re-sends it to whichever window adopts the session
  if (t.host === 'console') {
    consoleUnmount(sid);
  }
  if (t.host === 'workrooms') {
    const pane = paneEls.get(sid);
    if (pane) { roPanes.unobserve(pane.querySelector('.pane-body')); pane.remove(); }
    paneEls.delete(sid);
  }
  t.keypad?.dispose();
  t.term.dispose();
  t.box.remove();
  if (window.wb.web) { window.__wbWebTabs?.delete(sid); window.wb.web.events?.fire('terminal-closed', { sid }); }
  tabs.delete(sid);
  order = order.filter((x) => x !== sid);
  if (activeSid === sid) {
    activeSid = order.length ? order[order.length - 1] : null;
  }
  refresh(true);
  if (activeSid != null && t.host !== 'workrooms') {
    activate(activeSid);
  }
  if (t.host !== 'workrooms') maybeCloseEmpty();
}

// A window with nothing in it closes — unless it is the only window, which stays as a
// launch pad (main decides, it knows how many windows exist).
function maybeCloseEmpty() {
  if (tabs.size === 0 && !(mode === 'panes' && listPinned)) {
    window.wb.closeIfEmpty();
  }
}

// Closing a tab/pane HIDES the CLI: snapshot its screen to main and keep the shell running.
function hideTab(sid) {
  const t = tabs.get(sid);
  if (!t) {
    return;
  }
  if (t.host === 'workrooms') { closeInlineTerminal(t); return; }
  window.wb.hideSession(sid, t.ser.serialize());
  removeTabLocal(sid);
}

// "End" is the only thing that kills a CLI (plus the shell exiting on its own).
function endSession(sid) {
  window.wb.closeSession(sid);
  if (tabs.has(sid)) {
    removeTabLocal(sid);
  }
}

async function copySelection(t) {
  const sel = t.term.getSelection();
  if (sel) {
    try {
      await navigator.clipboard.writeText(sel);
    } catch (e) {
      console.warn('copy failed', e);
    }
  }
}

async function pasteInto(t) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      t.term.paste(text);
    }
  } catch (e) {
    console.warn('paste failed', e);
  }
}

// ---- new CLIs get an animal name and their own color (renameable in settings; later: project folder)
const ANIMALS = ['Otter', 'Falcon', 'Lynx', 'Heron', 'Badger', 'Marmot', 'Osprey', 'Ibex', 'Gecko', 'Walrus',
  'Puffin', 'Wombat', 'Jackal', 'Kestrel', 'Narwhal', 'Pangolin', 'Quokka', 'Raven', 'Stoat', 'Tapir',
  'Vole', 'Yak', 'Zebra', 'Bison', 'Cobra', 'Dingo', 'Egret', 'Ferret', 'Gibbon', 'Hedgehog'];

function pickAnimal() {
  const used = new Set([...tabs.values()].map((t) => t.name).concat(sessionList.map((x) => x.name)));
  const free = ANIMALS.filter((a) => !used.has(a));
  if (free.length) {
    return free[Math.floor(Math.random() * free.length)];
  }
  const a = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  let n = 2;
  while (used.has(a + ' ' + n)) {
    n++;
  }
  return a + ' ' + n;
}

// A hue far from every color already in use (random among the best candidates).
function pickHue() {
  const used = [...tabs.values()].map((t) => t.hue).concat(sessionList.map((x) => x.hue)).filter((h) => h != null);
  const dist = (a, b) => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360));
  const cands = [];
  for (let h = Math.floor(Math.random() * 15); h < 360; h += 15) {
    cands.push({ h, d: used.length ? Math.min(...used.map((u) => dist(h, u))) : 360 });
  }
  const best = Math.max(...cands.map((c) => c.d));
  const top = cands.filter((c) => c.d >= best - 8);
  return top[Math.floor(Math.random() * top.length)].h;
}

// An explicit launch (a click, a key, a menu item): ask main for a one-time permit, then open the CLI.
// The only way a new CLI starts after a window's first load (piece 6, rule 3).
async function launch(opts = {}) {
  if (opts.spec?.route === 'term') opts = { ...opts, seatFocus: captureTerminalFocus(document) };
  const scope = viewScope();
  const permit = await window.wb.permit();
  if (!currentViewScope(scope) || (opts.inlineCurrent && !opts.inlineCurrent())) return null;
  return addTab({ ...opts, permit, launchScope: scope });
}

// A room owns this viewer's container and request epoch. Disposing disconnects only
// the term viewer; the remote seat remains the room's running agent.
async function openSeatTerminalInline({ room, seat, handle, roomName, vendor, host, current, onClose }) {
  if (!host || !current?.()) return null;
  const sid = await launch({ spec: { route: 'term', room, seat, handle, roomName },
    name: '@' + handle, why: 'seat-terminal', host: 'workrooms', inlineHost: host,
    inlineCurrent: current, inlineVendor: vendor, onInlineClose: onClose });
  if (sid == null) return null;
  const t = tabs.get(sid);
  if (!t) return null;
  if (!current()) { t.inlineDispose(); return null; }
  return { sid, dispose: t.inlineDispose, fit: () => { if (inlineTerminalCurrent(t)) t.fit.fit(); } };
}
function inlineTerminalCurrent(t) {
  if (t.host !== 'workrooms') return true;
  if (tabs.get(t.sid) !== t) return false;
  if (t.inlineCurrent()) return true;
  t.inlineDispose(); return false;
}
function closeInlineTerminal(t) {
  const notify = t.inlineCurrent?.();
  t.inlineDispose?.();
  if (notify) t.onInlineClose?.();
}

// opts: {} for a brand-new session, or { sid, title, snapshot, name, hue, dropX } to adopt one.
async function addTab(opts = {}) {
  const seatFocus = opts.seatFocus || (opts.spec?.route === 'term' || routeStates.get(opts.sid)?.route === 'term' ? captureTerminalFocus(document) : null);
  // the web build's terminals are the engine's: their name and colour come back from the session handler (one name in every tab and after every reload), never a page-side random
  if (!opts.sid && opts.name === undefined && !window.wb.web) {
    opts = { ...opts, name: pickAnimal() };
  }
  if (!opts.sid && opts.hue == null && !window.wb.web) {
    opts = { ...opts, hue: pickHue() };
  }
  const t0 = performance.now();
  const box = document.createElement('div');
  box.className = 'term';
  stageEl.appendChild(box);
  if (mode === 'tabs') {
    for (const t of tabs.values()) {
      t.box.classList.remove('active');
    }
    box.classList.add('active');
  }

  const term = new window.Terminal({
    fontFamily: FONT,
    fontSize: termFont(),
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    minimumContrastRatio: 4.5,
    theme: themeFor(opts.hue == null ? DEFAULT_HUE : opts.hue),
  });
  const fit = new window.FitAddon.FitAddon();
  const ser = new window.SerializeAddon.SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(ser);
  term.open(box);
  if (window.wb.web) linkTerminal(term); // an http(s) address on the screen is a link (web, P04)
  fit.fit();
  const tOpen = performance.now();

  let sid = opts.sid;
  let title = opts.title || 'Terminal';
  if (sid) {
    if (opts.snapshot) {
      term.write(opts.snapshot);
    }
  } else {
    // opts.spec = { route, serverId }: a non-local route (dev flag only in step 1).
    const r = await window.wb.createSession(term.cols, term.rows, opts.spec, { permit: opts.permit, why: opts.why, scope: opts.launchScope });
    if (r.error) {
      term.dispose();
      box.remove();
      dbg('addTab-refused', {});
      // the web build says why on screen (the engine's own sentence, e.g. an agent with no folder), never nothing
      if (window.wb.web && typeof r.error === 'string') accountsSnackbar(r.error.slice(0, 200));
      return null;
    }
    sid = r.sid;
    if (opts.host === 'workrooms' && (!currentViewScope(opts.launchScope) || !opts.inlineCurrent?.())) {
      window.wb.closeSession(sid); term.dispose(); box.remove(); routeStates.delete(sid); early.delete(sid);
      return null;
    }
    title = r.title;
    if (window.wb.web) opts = { ...opts, ...(r.name ? { name: r.name } : {}), ...(r.hue != null ? { hue: r.hue } : {}) };
    if (r.route && !routeStates.has(sid)) {
      routeStates.set(sid, r.route);
    }
    lastLaunch = { sid, routeAtOpen: r.route ? r.route.state : null };
  }

  const tCreated = performance.now();
  const plan = mode === 'panes' && opts.dropX != null && opts.dropY != null ? dropPlanAt(opts.dropX, opts.dropY) : null;
  // Dropped onto this window's tab strip: land in the gap the caret was showing.
  const at = opts.dropX == null || mode !== 'tabs' ? order.length : Math.min(hwbDropIndex(root, opts.dropX), order.length);
  const tab = { sid, title, seatAttachFocus: seatFocus, name: opts.name || '', hue: opts.hue == null ? DEFAULT_HUE : opts.hue, box, term, fit, ser };
  tabs.set(sid, tab);
  if (window.wb.web) { window.__wbWebTabNames ||= () => [...tabs.values()].map((x) => ({ sid: x.sid, name: x.name, hue: x.hue })); (window.__wbWebTabs ||= new Map()).set(sid, box); window.wb.web.events?.fire('terminal-tab', { sid, box }); } // the web build: slices draw per-terminal UI (the watching strip)
  if (opts.host === 'workrooms') {
    tab.host = 'workrooms'; tab.inlineHost = opts.inlineHost; tab.inlineCurrent = opts.inlineCurrent;
    tab.onInlineClose = opts.onInlineClose; tab.inlineWatchPrompt = true;
    tab.inlineBrand = seatBrand({ vendor: opts.inlineVendor });
    let disposed = false;
    tab.inlineDispose = () => {
      if (disposed) return; disposed = true;
      window.wb.closeSession(sid);
      if (tabs.get(sid) === tab) removeTabLocal(sid);
    };
    opts.inlineHost.textContent = '';
    opts.inlineHost.appendChild(buildCliPane(sid));
  } else if (opts.host === 'console') {
    // 0.12.2: the Console tab's terminal pane lives under the console, never in the grid
    tab.host = 'console';
    consoleMount(sid, opts);
  } else {
    order.splice(at, 0, sid);
  }
  if (window.wb.web) {
    const keypadScope = viewScope();
    tab.keypad = createTerminalKeypad({ box, term,
      current: () => tabs.get(sid) === tab && currentViewScope(keypadScope) && inlineTerminalCurrent(tab),
      controlling: () => { const route = routeStates.get(sid); return route?.route === 'term' ? route.state === 'controlling' : window.wb.web.terminal?.state(sid) === 'typing'; },
      send: (data) => window.wb.input(sid, data), refit: () => fit.fit(),
    });
  }
  term.onData((d) => { if (inlineTerminalCurrent(tab)) window.wb.input(sid, d); });
  term.onResize(({ cols, rows }) => { if (inlineTerminalCurrent(tab)) window.wb.resize(sid, cols, rows); });
  term.onTitleChange((t) => {
    if (t) {
      tab.title = t;
      window.wb.setTitle(sid, t);
      renderTabs();
    }
  });
  box.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      copySelection(tab).then(() => term.clearSelection());
    } else {
      pasteInto(tab);
    }
  });

  if (!opts.sid) {
    sendMeta(tab);
  }
  const queued = early.get(sid);
  if (queued) {
    early.delete(sid);
    for (const d of queued) {
      term.write(d);
    }
  }
  activeSid = sid;
  refresh(true);
  if (plan && layout.tree) {
    const rest = removeLeaf(layout.tree, sid);
    if (rest && plan.zone.root) {
      layout.tree = insertAtRoot(rest, leafCli(sid), plan.zone.side);
      layout.dirty = true;
      renderGrid();
    } else if (rest && findLeaf(rest, plan.targetKey)) {
      layout.tree = insertBeside(rest, plan.targetKey, leafCli(sid), plan.zone.side);
      layout.dirty = true;
      renderGrid();
    }
  }
  activate(sid, seatFocus);
  applyRoute(sid);
  if (opts.sid) {
    window.wb.attached(sid, term.cols, term.rows);
  }
  dbg('addTab', {
    sid,
    adopt: !!opts.sid,
    termOpenMs: Math.round(tOpen - t0),
    sessionRoundTripMs: Math.round(tCreated - tOpen),
    finishMs: Math.round(performance.now() - tCreated),
    tabs: tabs.size,
    mode,
  });
  return sid;
}

// ---------------------------------------------------------------- route errors (piece 1)
// main sends the route's state; the pane draws it over the terminal (src/renderer/route-overlay.js).

const SMALL_W = 360;
const SMALL_H = 240;

function routeHost(t) {
  if (t.host === 'workrooms') return paneEls.get(t.sid)?.querySelector('.pane-body') || t.box;
  if (mode === 'tabs') {
    return t.box; // tab mode: the grid's panes are hidden, so the overlay rides inside the terminal box
  }
  const pane = paneEls.get(t.sid);
  return (pane && pane.querySelector('.pane-body')) || t.box;
}

function focusSeatTerminal(t) {
  if (!['viewing', 'controlling'].includes(t.route?.state) || t.route?.route !== 'term') return;
  const controlling = t.route.state === 'controlling';
  const intent = (controlling && t.seatControlFocus) || t.seatAttachFocus;
  if (!intent) return;
  t.seatAttachFocus = null;
  if (controlling) t.seatControlFocus = null;
  intent.focus(t.term, () => tabs.get(t.sid) === t && activeSid === t.sid && inlineTerminalCurrent(t));
}

// Tab mode has no pane ResizeObserver: the active tab's overlay is sized when it becomes visible.
function fitOverlayTabs() {
  const t = tabs.get(activeSid);
  if (mode === 'tabs' && t && t.rx) {
    t.rx.resize(isSmallBody(t));
    placeOverlay(t);
    syncStrip(t);
  }
}

function isSmallBody(t) {
  const b = routeHost(t).getBoundingClientRect();
  return b.width < SMALL_W || b.height < SMALL_H;
}

// The Concierge handle overlaps the top of the rightmost pane: keep the chip and banner clear of it.
function edgeInset(t) {
  const tab = $('dockTab');
  if (!tab) {
    return 0;
  }
  const h = routeHost(t).getBoundingClientRect();
  const d = tab.getBoundingClientRect();
  return d.width && h.right > d.left - 4 && h.top < d.bottom && h.top + 60 > d.top ? Math.round(h.right - d.left) : 0;
}

function placeOverlay(t) {
  t.rx.el.style.setProperty('--rx-edge', edgeInset(t) + 'px');
}

// 0.12.4: the Install pane's waiting strip sits above the terminal; its host carries the strip's
// height (one line, or two in a narrow pane) and the terminal starts under it (style.css --rx-strip).
function syncStrip(t) {
  const host = t.rx && t.rx.el.parentElement;
  if (!host) {
    return;
  }
  const chip = t.rx.el.classList.contains('is-strip') ? t.rx.el.querySelector('.rx-chip') : null;
  if (chip) {
    host.style.setProperty('--rx-strip', chip.offsetHeight + 'px');
  } else {
    host.style.removeProperty('--rx-strip');
  }
}

function ensureOverlay(t) {
  if (!t.rx) {
    t.rx = createRouteOverlay({
      onRetry: () => inlineTerminalCurrent(t) && window.wb.retrySession(t.sid),
      // 3e: the blocked recipe's card: a plain shell on the same server · login, or that server's Recipes
      onShell: (st) => st && st.serverId && launch({ spec: { route: 'broker', serverId: st.serverId }, why: 'policy-shell' }),
      onPolicy: (st) => {
        const r = st && acc.servers.find((x) => x.id === st.serverId);
        if (r && serversPage) {
          modules.setSurface('servers');
          void serversPage.openServer(r.serverId, 'Recipes');
        }
      },
      onClose: () => t.host === 'workrooms' ? closeInlineTerminal(t) : endSession(t.sid), // a hard stop's only way out: the pane goes (nothing ran there)
      onSignIn: () => openSettings('accounts'), // access expired: Settings › Accounts
      // a recipe's launch cards (3c): Edit recipe, Start in the home folder, How to install
      onEdit: (st) => st && st.recipeId && openSettings('recipe:' + st.recipeId),
      onHome: () => window.wb.retrySession(t.sid, { home: true }),
      // 0.12.4: on This machine, Install runs the vendor's own command in a visible pane (the click is the
      // approval); elsewhere, or without a command, the program's page with its install link
      onInstall: (st) => {
        if (!st || !st.programId) {
          return;
        }
        const prog = (sx.programs || []).find((x) => x.id === st.programId);
        if (st.route === 'local' && ((st.install && typeof st.install === 'string') || (prog && prog.install))) {
          launch({ spec: { route: 'local', install: st.programId, forRecipe: st.recipeId || null }, name: 'Install ' + ((prog && prog.label) || st.program || st.programId), why: 'install' });
          return;
        }
        openSettings('prog:' + st.programId);
      },
      // the Install pane's ends: Start recipe, Restart Workbench, Get Node.js
      onStartRecipe: (st) => {
        if (st && st.recipeId) {
          launchRecipe(st.recipeId);
          endSession(t.sid);
        }
      },
      onRestart: () => window.wb.appRestart(),
      onNode: () => window.wb.openExternal('https://nodejs.org/'),
      // Run again on a finished custom command: an explicit launch, so it mints a spawn permit
      onRunAgain: () => window.wb.permit().then((permit) => window.wb.retrySession(t.sid, { permit })),
      // step 4: Restore and Start a new one are explicit launches, each with a spawn permit
      onRestore: () => window.wb.permit().then((permit) => window.wb.retrySession(t.sid, { permit })),
      onFresh: () => window.wb.permit().then((permit) => window.wb.retrySession(t.sid, { permit, fresh: true })),
      onShow: (st) => (st && st.route === 'term' ? rail.open() : showGroup(st && st.serverId)), // 3d: "Show them" at the limit; W3b: the open terminals
      // W3b: Take control (a click; the room gets a line), Stop (back to watching), Wake a resting seat then open again
      // 5a: Done on a password-once pane: a plain shell on that server (now with the key), this pane goes
      onKeyShell: (st) => {
        if (st && st.serverId) {
          launch({ spec: { route: 'ssh', serverId: st.serverId }, why: 'key-shell' });
          endSession(t.sid);
        }
      },
      onTake: () => {
        t.seatControlFocus = captureTerminalFocus(document);
        if (t.host === 'workrooms') {
          if (!inlineTerminalCurrent(t)) return;
          t.inlineWatchPrompt = false; applyRoute(t.sid);
        }
        window.wb.termControl(t.sid, true);
      },
      onWatch: () => {
        if (t.host !== 'workrooms' || !inlineTerminalCurrent(t)) return;
        t.inlineWatchPrompt = false; applyRoute(t.sid); t.term.focus();
      },
      onStop: () => {
        if (!inlineTerminalCurrent(t)) return;
        window.wb.termControl(t.sid, false);
      },
      onWake: async (st) => {
        if (!inlineTerminalCurrent(t)) return;
        if (st && st.roomId && st.seatId) {
          await window.wb.rooms.seatStart(st.roomId, st.seatId, {});
          if (!inlineTerminalCurrent(t)) return;
          setTimeout(() => inlineTerminalCurrent(t) && window.wb.retrySession(t.sid), 800);
        }
      },
      onFocusTerminal: () => inlineTerminalCurrent(t) && t.term.focus(),
      program: () => (!t.route || t.route.route === 'local' ? niceTitle(t.title) : 'the shell'),
    });
  }
  const host = routeHost(t);
  if (t.rx.el.parentElement !== host) {
    host.appendChild(t.rx.el);
  }
  return t.rx;
}

function applyRoute(sid) {
  const t = tabs.get(sid);
  if (!t) {
    return;
  }
  const st = routeStates.get(sid) || null;
  const was = t.route;
  t.route = st;
  t.keypad?.refresh();
  if (!st && !t.rx) {
    return;
  }
  const small = isSmallBody(t);
  // 3e: a recipe the server's policy refused: do you manage that server ([Change policy])?
  const row3e = st && st.state === 'recipe-policy' ? acc.servers.find((r) => r.id === st.serverId) : null;
  const shown = row3e ? { ...st, manages: !!(row3e.recipes && row3e.recipes.manages) } : st;
  const seatReady = st?.route === 'term' && ['viewing', 'controlling'].includes(st.state);
  // Attached seat terminals own input focus; their watch card must not compete
  // with it or steal focus after the person has moved to another field.
  ensureOverlay(t).update(shown && t.host === 'workrooms' ? { ...shown, inlineWatchPrompt: t.inlineWatchPrompt } : shown, { active: sid === activeSid && !seatReady, smallPane: small });
  placeOverlay(t);
  syncStrip(t);
  if (seatReady) requestAnimationFrame(() => focusSeatTerminal(t));
  if ((was && was.state) !== (st && st.state)) {
    requestAnimationFrame(() => { if (tabs.get(sid) === t && inlineTerminalCurrent(t)) t.fit.fit(); }); // a strip above the terminal (install-wait) changes its height
  }
  const pane = paneEls.get(sid);
  if (pane && (routeWord(was) || {}).text !== (routeWord(st) || {}).text) {
    pane.classList.toggle('is-small-body', small);
    paintPaneHeader(pane, t);
  }
}

// ---------------------------------------------------------------- saved window state
// main writes this (Documents\Workbench\workbench-state.json) and hands it back on the next start.
// Only structure: tab names/colors, the pane arrangement, the Concierge tray. Never terminal content.

function stateSnapshot() {
  return {
    mode,
    listPinned,
    active: activeSid,
    dock: { open: conc.open, w: conc.w },
    surface: modules.currentSurface(),
    tabs: order.map((sid) => ({ sid, name: tabs.get(sid).name, hue: tabs.get(sid).hue })),
    tree: layout.dirty ? layout.tree : null,
  };
}

const remapTree = (node, map) => {
  if (!node) {
    return null;
  }
  if (node.type === 'leaf') {
    if (node.kind === 'list') {
      return node;
    }
    return map.has(node.sid) ? { ...node, sid: map.get(node.sid) } : null;
  }
  const a = remapTree(node.a, map);
  const b = remapTree(node.b, map);
  return a && b ? { ...node, a, b } : a || b;
};

// startup: the window's first load opening its saved CLIs (no permit needed, once); otherwise each
// CLI is an explicit launch.
async function restoreState(r, { startup = false } = {}) {
  const map = new Map();
  const open = (o) => (startup ? addTab({ ...o, why: 'restore' }) : launch(o));
  for (const t of r.tabs || []) {
    map.set(t.sid, await open({ name: t.name || '', hue: t.hue }));
  }
  if (!map.size) {
    await open({});
  }
  listPinned = !!r.listPinned;
  const tree = remapTree(r.tree, map);
  if (tree) {
    layout.tree = tree;
    layout.dirty = true;
  }
  if (map.has(r.active)) {
    activate(map.get(r.active));
  }
  if (r.dock && Number(r.dock.w) >= 260) {
    conc.w = Math.round(Number(r.dock.w));
  }
  if (r.dock && r.dock.open) {
    conciergeToggle(true);
  }
  if (typeof r.surface === 'string') {
    modules.setSurface(r.surface);
  }
}

let stateSent = '';
function pushState() {
  const j = JSON.stringify(stateSnapshot());
  if (j !== stateSent) {
    stateSent = j;
    window.wb.reportState(JSON.parse(j));
  }
}

// ---------------------------------------------------------------- tab strip pointer handling
// (stripEl persists across hwbRenderTabs re-renders; the chips inside it do not, so
//  pointer capture lives on the strip.)

// Capture phase: take the close click before the bundle's close-or-end popover does.
// ✕ HIDES the tab (the CLI keeps running and stays in the menu).
stripEl.addEventListener(
  'click',
  (e) => {
    const x = e.target.closest('.tclose');
    if (x) {
      e.stopPropagation();
      e.preventDefault();
      hideTab(Number(x.dataset.close));
    }
  },
  true
);

stripEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.tclose')) {
    return;
  }
  const el = e.target.closest('.hwb-tab[data-tab]');
  if (!el) {
    return;
  }
  const sid = Number(el.dataset.tab);
  if (sid !== activeSid) {
    activate(sid);
  }
  dragState = { sid, x: e.clientX, y: e.clientY, active: false, torn: null };
  stripEl.setPointerCapture(e.pointerId);
});

function reorderTo(clientX) {
  const els = [...stripEl.querySelectorAll('.hwb-tab[data-tab]')];
  const idx = order.indexOf(dragState.sid);
  for (let i = 0; i < els.length; i++) {
    if (i === idx) {
      continue;
    }
    const r = els[i].getBoundingClientRect();
    const crossed = i < idx ? clientX < r.left + r.width / 2 : clientX > r.left + r.width / 2;
    if (crossed) {
      order.splice(idx, 1);
      order.splice(i, 0, dragState.sid);
      renderTabs();
      return;
    }
  }
}

async function tearOut() {
  const t = tabs.get(dragState.sid);
  const snapshot = t.ser.serialize();
  const r = await window.wb.dragStart(dragState.sid, snapshot);
  if (r.ok && !r.solo) {
    removeTabLocal(dragState.sid);
  }
}

stripEl.addEventListener('pointermove', (e) => {
  if (!dragState) {
    return;
  }
  if (!dragState.active) {
    if (Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y) < 6) {
      return;
    }
    dragState.active = true;
  }
  if (dragState.torn) {
    window.wb.dragMove();
    return;
  }
  const barH = root.querySelector('.hwb-bar').getBoundingClientRect().bottom;
  const outside = e.clientY < -16 || e.clientY > barH + 28 || e.clientX < -12 || e.clientX > window.innerWidth + 12;
  if (outside || tabs.size === 1) {
    dragState.torn = tearOut();
    return;
  }
  reorderTo(e.clientX);
});

async function endDrag(e) {
  if (!dragState) {
    return;
  }
  const d = dragState;
  dragState = null;
  try {
    stripEl.releasePointerCapture(e.pointerId);
  } catch (err) {
    // capture may already be gone
  }
  if (d.torn) {
    await d.torn;
    window.wb.dragEnd();
  }
}
stripEl.addEventListener('pointerup', endDrag);
stripEl.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------- window menu (hamburger)

function closePops() {
  $('flyout').hidden = true;
  $('settingsPop').hidden = true;
  webRouter?.close();
  webNav?.render();
  appsSettings?.close();
  consoleSync();
}

// The CLI list: live CLIs grouped by window, then Hidden. Used by the menu and the list pane.
function renderSessionList(container, withPin) {
  container.textContent = '';
  const live = sessionList.filter((s) => s.wid != null);
  const hidden = sessionList.filter((s) => s.wid == null);
  const wids = [...new Set([...live.map((s) => s.wid), myWid])].sort((a, b) => a - b);
  if (!sessionList.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No CLIs yet';
    container.appendChild(e);
  }
  wids.forEach((wid, i) => {
    const g = document.createElement('div');
    g.className = 'grp';
    const label = document.createElement('span');
    label.textContent = 'Window ' + (i + 1) + (wid === myWid ? ' (this)' : '');
    g.appendChild(label);
    if (withPin && wid === myWid && modules.hasPaneKind('list')) {
      const pin = document.createElement('button');
      pin.className = 'pin' + (listPinned ? ' on' : '');
      pin.dataset.act = 'pin';
      pin.innerHTML = PIN;
      pin.title = listPinned ? 'Remove this list pane from the window' : 'Pin this list as a pane (pane mode)';
      g.appendChild(pin);
    }
    container.appendChild(g);
    for (const s of live.filter((x) => x.wid === wid)) {
      container.appendChild(sessionRow(s, false));
    }
  });
  if (hidden.length) {
    const g = document.createElement('div');
    g.className = 'grp';
    g.innerHTML = '<span>Hidden — still running</span>';
    container.appendChild(g);
    for (const s of hidden) {
      container.appendChild(sessionRow(s, true));
    }
  }
}

function sessionRow(s, isHidden) {
  const row = document.createElement('div');
  row.className = 'row lrow' + (isHidden ? ' is-hidden' : '');
  row.dataset.sid = s.sid;
  const rowSeed = baseOf(s.hue == null ? DEFAULT_HUE : s.hue);
  row.style.setProperty('--base', rowSeed);
  row.style.setProperty('--row-c', m3.palette(rowSeed).primary);
  const ring = document.createElement('span');
  hwbRing(ring, hwbRingFromChrome(s.flowing ? 'streaming' : 'idle', { attached: true }), 20, { brand: BRAND, markPath: MARK });
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name || niceTitle(s.title);
  const state = document.createElement('span');
  state.className = 'state';
  state.textContent = (isHidden ? 'hidden · ' : '') + (s.flowing ? 'flowing' : 'idle');
  const end = document.createElement('button');
  end.className = 'endx';
  end.dataset.act = 'end';
  end.title = 'End this CLI';
  end.innerHTML = icon('close');
  row.append(ring, name, state, end);
  return row;
}

// The hamburger menu: Global Settings straight from here and the window actions.
let accountMenuOpen = false;
function renderFlyout() {
  const fly = $('flyout');
  fly.textContent = '';
  const item = (act, ic, label) => {
    const mi = document.createElement('button');
    mi.type = 'button';
    mi.className = 'mi';
    mi.dataset.act = act;
    const left = document.createElement('span'); left.className = 'mi-l'; left.innerHTML = icon(ic);
    const text = document.createElement('span'); text.textContent = label; left.appendChild(text);
    mi.appendChild(left); fly.appendChild(mi); return mi;
  };
  if (acc.present && acc.st) {
    const a = acc.st.account, multiple = (acc.st.accounts || []).length > 1;
    const top = item(multiple ? 'account-menu' : 'accounts', a ? 'account_circle' : 'login', a ? a.label : 'Sign in…');
    if (a) {
      top.title = a.address;
      const email = document.createElement('small'); email.textContent = a.email || ''; top.querySelector('.mi-l > span:last-child').appendChild(email);
      if (multiple) { top.insertAdjacentHTML('beforeend', icon('expand_more')); top.setAttribute('aria-expanded', String(accountMenuOpen)); }
    }
    if (multiple && accountMenuOpen) {
      for (const card of acc.st.accounts) {
        const row = item('select-account', card.id === a.id ? 'check' : 'account_circle', card.label);
        row.dataset.account = card.id; row.title = card.address;
      }
      item('add-account', 'add', 'Add account…');
      item('accounts', 'manage_accounts', 'Manage accounts');
    }
  }
  item('settings', 'settings', 'Global Settings');
  item('gather', 'call_merge', 'Gather all windows here');
  // The CLI list left the menu: the rail is the one place (decision c, step 2).
}

function rowAction(row) {
  const sid = Number(row.dataset.sid);
  const s = sessionList.find((x) => x.sid === sid);
  if (!s) {
    return;
  }
  if (s.wid == null) {
    window.wb.openSession(sid); // hidden -> open it here
  } else if (s.wid === myWid) {
    activate(sid);
  } else {
    window.wb.focusSession(sid);
  }
}

function bindListClicks(el) {
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    const row = e.target.closest('.row');
    if (act && act.dataset.act === 'pin') {
      e.stopPropagation();
      setPinned(!listPinned);
      return;
    }
    if (act && act.dataset.act === 'end' && row) {
      e.stopPropagation();
      endSession(Number(row.dataset.sid));
      return;
    }
    if (row) {
      rowAction(row);
      if (el.closest('#flyout')) {
        closePops();
      }
    }
  });
}

$('burger').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('flyout').hidden;
  closePops();
  if (open) {
    accountMenuOpen = false;
    renderFlyout();
    $('flyout').hidden = false;
    consoleSync(); // the Console view steps aside under a menu (the owner )
  }
});

$('flyout').addEventListener('click', (e) => {
  const mi = e.target.closest('.mi');
  if (!mi) {
    return;
  }
  const act = mi.dataset.act;
  if (act === 'account-menu') {
    accountMenuOpen = !accountMenuOpen; renderFlyout();
  } else if (act === 'select-account') {
    closePops(); selectAccount(mi.dataset.account);
  } else if (act === 'add-account') {
    closePops(); accountsHandlers.add();
  } else if (act === 'settings') {
    closePops();
    openSettings('global');
  } else if (act === 'accounts') {
    closePops();
    if (acc.st && !acc.st.account && !acc.st.flow) {
      acc.ui.step = 'address';
      acc.ui.focus = 'address';
    }
    openSettings('accounts');
  } else if (act === 'gather') {
    window.wb.arrangeTabs();
    closePops();
  }
});
bindListClicks($('flyout'));

// ---------------------------------------------------------------- the rail (step 2)

// Dragging a rail row: into the grid ("Place here" / "Swap with api"), out of the window ("Open in a
// new window", this window's CLIs only). A hidden CLI or one from another window lands here.
let rowDrag = null;
let rowDragEndedAt = 0;

function startRowDrag(e, sid) {
  if (e.button !== 0 || rowDrag || paneDrag) {
    return;
  }
  rowDrag = { sid, x0: e.clientX, y0: e.clientY, active: false, target: null, out: false };
  window.addEventListener('pointermove', onRowDragMove, true);
  window.addEventListener('pointerup', onRowDragUp, true);
  window.addEventListener('keydown', onRowDragKey, true);
}

function endRowDrag() {
  const st = rowDrag;
  rowDrag = null;
  window.removeEventListener('pointermove', onRowDragMove, true);
  window.removeEventListener('pointerup', onRowDragUp, true);
  window.removeEventListener('keydown', onRowDragKey, true);
  if (st && st.active) {
    st.ghost.remove();
    st.mark.remove();
    rowDragEndedAt = Date.now();
  }
  return st;
}

function onRowDragMove(e) {
  const st = rowDrag;
  if (!st) {
    return;
  }
  const s = sessionList.find((x) => x.sid === st.sid);
  if (!s) {
    endRowDrag();
    return;
  }
  if (!st.active) {
    if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 6) {
      return;
    }
    st.active = true;
    st.ghost = document.createElement('div');
    st.ghost.className = 'pane-ghost';
    st.ghost.style.setProperty('--base', baseOf(s.hue == null ? DEFAULT_HUE : s.hue));
    st.mark = document.createElement('div');
    st.mark.className = 'pane-drop';
    st.mark.hidden = true;
    document.body.append(st.ghost, st.mark);
  }
  // The rail stays opaque; once the pointer is over the grid, a floating rail slides closed so the
  // drop targets under it are free (the design, step 2).
  if (!rail.isPinned() && rail.isOpen() && e.clientX > rail.el.getBoundingClientRect().right) {
    rail.close();
  }
  const name = s.name || niceTitle(s.title);
  st.out = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
  st.ghost.innerHTML = st.out && s.wid === myWid ? icon('open_in_new') : icon('drag_indicator');
  st.ghost.appendChild(document.createTextNode(st.out && s.wid === myWid ? 'Open in a new window' : name));
  st.ghost.style.transform = 'translate(' + (e.clientX + 12) + 'px,' + (e.clientY + 12) + 'px)';
  st.target = null;
  st.mark.hidden = true;
  if (st.out || mode !== 'panes') {
    return;
  }
  const here = s.wid === myWid;
  const edge = rootEdgeZone(e.clientX, e.clientY);
  const over = document.elementFromPoint(e.clientX, e.clientY);
  const pane = over && over.closest('.pane');
  let zone = null;
  let key = null;
  if (edge) {
    zone = edge;
  } else if (pane && gridEl.contains(pane) && !(here && Number(pane.dataset.sid) === st.sid)) {
    key = pane.classList.contains('is-list') ? 'list' : Number(pane.dataset.sid);
    zone = dropZone(pane, e.clientX, e.clientY, !here); // a swap only within this window
  }
  if (!zone) {
    return;
  }
  st.target = { key, zone, x: e.clientX, y: e.clientY };
  st.mark.hidden = false;
  st.mark.className = 'pane-drop ' + (zone.side === 'swap' ? 'swap' : 'edge');
  st.mark.style.cssText = 'left:' + zone.rect.left + 'px;top:' + zone.rect.top + 'px;width:' + zone.rect.width + 'px;height:' + zone.rect.height + 'px';
  st.mark.dataset.label = dropLabel(zone, key);
}

function onRowDragUp() {
  const st = endRowDrag();
  if (!st || !st.active) {
    return;
  }
  const s = sessionList.find((x) => x.sid === st.sid);
  if (!s) {
    return;
  }
  if (s.wid === myWid) {
    if (st.out) {
      paneTearOut(st.sid).then(() => window.wb.dragEnd());
    } else if (st.target && layout.tree) {
      applyMove(st.sid, st.target);
    }
  } else if (st.target) {
    // hidden, or in another window: it lands here where it was dropped
    window.wb.moveHere(st.sid, st.target.x, st.target.y);
  }
  if (!rail.isPinned()) {
    rail.close();
  }
}

function onRowDragKey(e) {
  if (e.key === 'Escape' && rowDrag) {
    e.stopPropagation();
    endRowDrag();
  }
}

function windowLabel(wid) {
  const wids = [...new Set([...sessionList.filter((x) => x.wid != null).map((x) => x.wid), myWid])].sort((a, b) => a - b);
  return 'Window ' + (wids.indexOf(wid) + 1);
}

function flashPane(sid) {
  const pane = paneEls.get(sid);
  if (pane) {
    pane.classList.remove('flash');
    void pane.offsetWidth;
    pane.classList.add('flash');
    setTimeout(() => pane.classList.remove('flash'), 700);
  }
}

// One function decides what a click on a CLI reaches (piece 5): here, another window, or hidden.
function reachSession(sid) {
  const s = sessionList.find((x) => x.sid === sid);
  if (!s) {
    return;
  }
  if (s.wid == null) {
    window.wb.openSession(sid);
  } else if (s.wid === myWid) {
    activate(sid);
    flashPane(sid);
  } else {
    window.wb.focusSession(sid);
  }
}

function setSessionMeta(sid, patch) {
  const t = tabs.get(sid);
  const s = sessionList.find((x) => x.sid === sid);
  const name = patch.name !== undefined ? patch.name : t ? t.name : s ? s.name : '';
  const hue = patch.hue !== undefined ? patch.hue : t ? t.hue : s ? s.hue : DEFAULT_HUE;
  if (t) {
    t.name = name;
    t.hue = hue;
    t.term.options.theme = themeFor(hue);
    refresh(false);
  }
  window.wb.setMeta(sid, name, hue);
}

// End… from the rail: "End this CLI?" with the focus on Cancel; End is the error-filled button. A CLI
// that keeps running on a broker (3d): "End this CLI on server?" · "It stops everywhere it's open."
function confirmEnd(sid) {
  const s = sessionList.find((x) => x.sid === sid);
  if (!s) {
    return;
  }
  const words = s.keepsRunning ? { title: `End this CLI on ${s.place}?`, body: "It stops everywhere it's open." } : { title: 'End this CLI?', body: (s.name || niceTitle(s.title)) + ': the shell and anything running in it will stop.' };
  endDialog(words, () => endSession(sid), sid);
}
/** End… on a group row (3d): the same words; the broker ends it (no pane here holds it). */
function confirmEndBroker(serverId, bsid, name) {
  const g = brokerGroups.find((x) => x.serverId === serverId);
  endDialog({ title: `End this CLI on ${g ? g.serverName : 'the server'}?`, body: "It stops everywhere it's open." }, () => window.wb.brokerEnd(serverId, bsid).catch(() => null), null);
}
function endDialog(words, onEnd, sid) {
  const back = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'end-dlg';
  const d = document.createElement('div');
  d.className = 'dlg';
  d.setAttribute('role', 'alertdialog');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-labelledby', 'endT');
  d.setAttribute('aria-describedby', 'endB');
  d.innerHTML = icon('cancel', 'ic') + '<h4 id="endT"></h4><p id="endB"></p><div class="a"><button class="cancel">Cancel</button><button class="danger">End</button></div>';
  d.querySelector('#endT').textContent = words.title;
  d.querySelector('#endB').textContent = words.body;
  wrap.appendChild(d);
  document.body.appendChild(wrap);
  consoleSync(); // and under a dialog
  const cancel = d.querySelector('.cancel');
  const end = d.querySelector('.danger');
  const close = (ended) => {
    wrap.remove();
    consoleSync();
    if (!ended && back && back.isConnected) {
      back.focus();
    } else if (ended && rail && rail.isOpen() && sid != null) {
      rail.focusRow(activeSid);
    }
  };
  cancel.classList.add('rx-ring');
  cancel.focus();
  cancel.addEventListener('click', () => close(false));
  end.addEventListener('click', () => {
    onEnd();
    close(true);
  });
  wrap.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      close(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const next = document.activeElement === cancel ? end : cancel;
      cancel.classList.remove('rx-ring');
      end.classList.remove('rx-ring');
      next.classList.add('rx-ring');
      next.focus();
    }
  });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap) {
      close(false);
    }
  });
}

rail = createRail({
  multipleAccounts: () => (acc.st?.accounts || []).length > 1,
  accountCard: (id) => (acc.st?.accounts || []).find((a) => a.id === id),
  host: $('main'),
  flagHost: $('main'),
  brand: BRAND,
  markPath: MARK,
  hues: SAMPLE_HUES,
  seedOf: (h) => baseOf(h == null ? DEFAULT_HUE : h),
  displayName: (s) => s.name || niceTitle(s.title),
  myWid: () => myWid,
  activeSid: () => activeSid,
  windowLabel,
  act: reachSession,
  showHide: (sid) => {
    const s = sessionList.find((x) => x.sid === sid);
    if (!s) {
      return;
    }
    if (s.wid == null) {
      window.wb.openSession(sid);
    } else if (s.wid === myWid) {
      hideTab(sid);
    } else {
      window.wb.hideRemote(sid);
    }
  },
  rename: (sid, name) => setSessionMeta(sid, { name }),
  color: (sid, hue) => setSessionMeta(sid, { hue }),
  end: confirmEnd,
  closeDone: (sid) => endSession(sid), // ✕ on a finished custom command's row: nothing runs, the pane goes
  // step 3c: the RECIPES area
  startRecipe: (id) => launchRecipe(id),
  explainRecipe: v => accountsSnackbar(v.blockedStartMessage),
  startAnother: (id) => launchRecipe(id),
  goTo: reachSession,
  newRecipe: () => openSettings('recipe:new'),
  editRecipe: (id) => openSettings('recipe:' + id),
  duplicateRecipe: async (id) => {
    const r = await window.wb.recipesDuplicate(id);
    if (r && !r.error) {
      openSettings('recipe:' + r.id); // "Duplicate makes 'site copy' and opens it in the form"
    }
  },
  deleteRecipe: (id) => confirmDeleteRecipe(id),
  fixRecipe: (id) => openSettings('recipe:' + id),
  turnOnProgram: (pid) => openSettings('prog:' + pid),
  // step 3d: the groups of CLIs that keep running on a broker (the design's 3d page)
  openBroker: (serverId, bsid, v) => openBrokerSession(serverId, bsid, v),
  endBroker: (serverId, bsid, name) => confirmEndBroker(serverId, bsid, name),
  dismissEnded: (serverId, bsid) => {
    dismissedEnded.add(serverId + '/' + bsid);
    applyGroups();
  },
  dragStart: startRowDrag,
  justDragged: () => Date.now() - rowDragEndedAt < 300,
  newCli: () => launch(),
  // step 4: a stopped row's Restore, the offer's Restore all / Choose… / Not now, Recently closed
  restore: (sid) => { const scope = viewScope(); return window.wb.permit().then((permit) => currentViewScope(scope) && window.wb.retrySession(sid, { permit })); },
  restoreOffer: (rows) => restoreRows(rows),
  chooseOffer: (o) => chooseToRestore(o),
  dismissOffer: () => window.wb.sessions.dismiss().then(applyOfferView),
  openRecent: () => openRecentlyClosed(),
  // 0.19.0: the IN THIS WINDOW + menu (the design's table): "Shell on this machine · PowerShell · ~", and
  // Custom command… opens step 3c's form (folder, command, Runs on) on Custom command
  shellLine: () => [shellWord(), '~'].filter(Boolean).join(' · '),
  customCommand: () => {
    loadSettingsData()
      .catch(() => {})
      .then(() => {
        if (rf && rf.forId === 'new' && !rf.dirty) {
          rf = null; // a fresh form, not an untouched one left on another program
        }
        showSettings('recipe:new');
        if (rf && rf.forId === 'new' && !rf.dirty) {
          rf.programId = 'custom';
          renderRecipeForm();
        }
      });
  },
  // 3b: a server · login row opens a shell there (ssh with the account's access); Test; Sign in again
  openServer: (id) => {
    const v = acc.servers.find((x) => x.id === id);
    launch({ spec: { route: v && !v.keysOnly ? 'broker' : 'ssh', serverId: id } });
  },
  testServer: (id) => window.wb.accounts.testServer(id).catch(() => null),
  signInAgain: () => openSettings('accounts'),
  serverPage: (serverId) => serversHandlers.openServerPage(serverId),
  // F7
  requestAccess: () => openRequest(),
  cancelRequest: (id) => window.wb.accounts.requestAct(id, 'cancel').catch(() => null),
  clearRequest: (id) => window.wb.accounts.requestAct(id, 'clear').catch(() => null),
  keyAction: (v) => keyAction(v), // 5a: Connect with a password / Make a new key
  why: (v) => accountsSnackbar(deniedText(v.title, v.note)),
  pinChanged: () => requestAnimationFrame(() => fitAll()),
  openChanged: () => consoleSync(),
  focusPane: () => {
    const t = tabs.get(activeSid);
    if (t) {
      t.term.focus();
    }
  },
});

// F1's one-time hint at the rail flag: see coach.js (docking the rail removes it without remembering it).
let agentWizardVisible = false;
const coachTip = createCoach({
  document,
  host: $('main'),
  canShow: () => !agentWizardVisible && !!rail && !rail.isPinned(),
  remember: () => window.wb.prefsSet({ hints: { railFlag: true } }),
  watchDocked: (fn) => new MutationObserver(() => {
    if (document.documentElement.classList.contains('rail-docked')) fn();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }),
});
const agentSetupVisibility = on => {
  agentWizardVisible = on === true;
  if (agentWizardVisible) coachTip.dismiss(false);
};
const showCoach = () => coachTip.show();
const dismissCoach = () => coachTip.dismiss(true);
rail.flag.addEventListener('click', dismissCoach);
window.addEventListener(
  'keydown',
  (e) => {
    if (coachTip.shown() && e.key === 'Escape') {
      dismissCoach(); // the key still reaches the terminal
    }
  },
  true
);

// F15: "Update ready" (a quiet chip beside the caption buttons) and, on click, "Restart to update?"
// naming how many CLIs on This machine end. No dialog until clicked.
let updateReady = null;
function showUpdateChip(u) {
  updateReady = u;
  $('updChip').hidden = !u;
  if (settingsPage === 'about' && !$('settingsPop').hidden) {
    renderAboutPage();
  }
}
window.wb.on('update:ready', showUpdateChip);
window.wb.on('update:progress', (p) => {
  about.progress = p;
  if (settingsPage === 'about' && !$('settingsPop').hidden) {
    renderAboutPage();
  }
});
window.wb.updateState().then((u) => u && u.ready && showUpdateChip(u.ready));
$('updChip').addEventListener('click', () => openUpdateDialog());
function openUpdateDialog() {
  if (!updateReady || document.querySelector('.upd-dlg')) {
    return;
  }
  const n = sessionList.length;
  const back = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'end-dlg upd-dlg';
  const d = document.createElement('div');
  d.className = 'dlg';
  d.setAttribute('role', 'alertdialog');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-labelledby', 'updT');
  // step 4 (the design's step4-restore, ruling ): only when a conversation here can come back
  const back4 = sessionList.some((x) => x.resumable && x.place === 'This machine') ? ' Claude conversations can be restored afterward.' : '';
  const ends = n === 0 ? '' : n === 1 ? '<p>Restarting ends the CLI on This machine.' + back4 + '</p>' : '<p>Restarting ends the ' + n + ' CLIs on This machine.' + back4 + '</p>';
  d.innerHTML = icon('upgrade', 'ic upd-ic') + '<h4 id="updT">Restart to update?</h4><p></p>' + ends + '<div class="a"><button class="cancel">Later</button><button class="primary">Restart now</button></div>';
  d.querySelector('p').textContent = 'Workbench ' + updateReady.version + ' is ready.';
  wrap.appendChild(d);
  document.body.appendChild(wrap);
  consoleSync(); // and under a dialog
  const later = d.querySelector('.cancel');
  const now = d.querySelector('.primary');
  const close = () => {
    wrap.remove();
    consoleSync();
    if (back && back.isConnected) {
      back.focus();
    }
  };
  // It ends CLIs, so the focus starts on Later, as End's starts on Cancel (the design, step 2).
  later.classList.add('rx-ring');
  later.focus();
  later.addEventListener('click', close);
  now.addEventListener('click', () => {
    window.wb.updateRestart();
    close();
  });
  wrap.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const next = document.activeElement === now ? later : now;
      now.classList.remove('rx-ring');
      later.classList.remove('rx-ring');
      next.classList.add('rx-ring');
      next.focus();
    }
  });
}

// Ctrl+Shift+L toggles the rail, caught before the terminal (Ctrl+L still clears the screen).
window.addEventListener(
  'keydown',
  (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      e.stopPropagation();
      dismissCoach();
      rail.toggle();
    }
  },
  true
);

// ---- settings panel: one page at a time, with a breadcrumb that climbs to Global Settings
// (Global Settings > Pane, > Concierge, > Modules, > Modules > <module>). Autosave; the pane page
// edits the ACTIVE pane. Module pages are rendered by the module host from each module's schema.
const PAGES = {
  global: { name: 'Global Settings', parent: null },
  pane: { name: 'Pane', parent: 'global' },
  concierge: { name: 'Concierge', parent: 'global' },
  accounts: { name: 'Accounts', parent: 'global' },
  scratchpad: { name: 'Scratchpad', parent: 'global' },
  apps: { name: 'Apps', parent: 'global' },
  files: { name: 'Files', parent: 'global' },
  'chat-history': { name: 'Chat history', parent: 'global' },
  servers: { name: 'Servers', parent: 'global' },
  request: { name: 'Request access', parent: 'servers' },
  machine: { name: 'This machine', parent: 'servers' },
  recipes: { name: 'Recipes', parent: null }, // step 3c: the breadcrumb's root for a recipe's form
  programs: { name: 'Programs', parent: 'global' },
  notifications: { name: 'Notifications', parent: 'global' },
  get message() { return window.wb?.web ? { name: 'Message box', parent: 'global' } : undefined; }, // the web build's one-switch page
  get modules() { return { name: window.wb?.web ? 'Tools' : 'Modules', parent: 'global' }; }, // the web build says Tools (the design s9)
  about: { name: 'About', parent: 'global' },
};
// Web only: the view generation, web Settings pages and the recipe launch seam. Mount scripts (web/mounts.json) register
// their pages on window.wb.web.router; the desktop has no window.wb.web, so nothing below exists there.
if (window.wb.web) {
  webRouter = createWebRouter({ document, wb: window.wb, pages: PAGES, settingsRoot: $('secAccounts').parentNode, win: $('win'),
    navRoot: document.querySelector('.sec.navs[data-page="global"]'), openSettings: (page) => openSettings(page),
    recipeIds: () => recipeList.map((r) => r.id), launch: (id) => launchRecipe(id),
    refreshRecipes: async () => { recipeList = (await window.wb.recipesList()) || []; recipesApply(); }, // a recipe created a moment ago (sign-in) is not in the cache yet
    onSignedOut: () => window.wb.web.storage?.clear() }); // the storage rule: nothing the app stored outlives a sign-out
  window.wb.web.router = webRouter.api;
}
// About's live state: the last check's result, a check in flight, a download's progress.
const about = { checking: false, last: null, progress: null, info: { available: false, auto: false, version: '' } };
let settingsPage = 'global';
// Web only: the four destinations (top tabs from 600 px, a labelled bottom bar under it), the account button with Sign out, the skip link,
// and the back arrow inside a room or a Settings sub-page. The module host still draws the three module tabs; this adds the rest.
if (window.wb.web) {
  const TAB_OF = { workrooms: 'workrooms', terminals: 'dashboard', scratchpad: 'scratchpad' };
  const DEST_OF = { workrooms: 'workrooms', dashboard: 'terminals', scratchpad: 'scratchpad' };
  const settingsTitle = (key) => (key === 'global' ? 'Settings' : (pageInfo(key) || {}).name || 'Settings');
  webNav = createWebNav({ document, root: document.documentElement, win: $('win'), bar: document.querySelector('.hwb-bar'),
    appsEl: document.querySelector('.hwb-apps'), main: $('main'), wb: window.wb, web: window.wb.web, brandPath: MARK,
    ops: {
      go: (id) => {
        if (id === 'settings') { if ($('settingsPop').hidden) openSettings('global'); else closePops(); webNav.render(); return; }
        closePops();
        if (id === 'workrooms' && modules.currentSurface() === 'workrooms') roomsPage?.showAll(); // the destination is the list, even from inside a room
        modules.setSurface(TAB_OF[id]);
        webNav.render();
      },
      active: () => ($('settingsPop').hidden ? DEST_OF[modules.currentSurface()] || null : 'settings'),
      settings: () => {
        const info = pageInfo(settingsPage) || { name: 'Settings', parent: null };
        return { open: !$('settingsPop').hidden, page: settingsPage, title: settingsTitle(settingsPage),
          parent: info.parent ? { page: info.parent, title: settingsTitle(info.parent) } : null };
      },
      backToRooms: () => roomsPage?.showAll(),
      focusSettings: () => $('settingsClose')?.focus(),
      inPanel: (el) => !!(el && el.closest && el.closest('#settingsPop')),
      settingsUp: () => openSettings((pageInfo(settingsPage) || {}).parent || 'global'),
    } });
}
let restoringStarterFiles = false;
async function restoreStarterFiles() {
  const api = window.wb.localSetup;
  if (restoringStarterFiles || !api?.restoreStarterFiles) return;
  const epoch = accountEpoch;
  restoringStarterFiles = true;
  renderPage('recipes');
  try {
    await api.restoreStarterFiles();
    const state = await api.getState();
    if (epoch === accountEpoch) refreshLocalFirstState(state);
  } catch {
    if (epoch === accountEpoch) accountsSnackbar("Couldn't restore the starter files. Check your files folder and try again.");
  } finally {
    restoringStarterFiles = false;
    if (epoch === accountEpoch && settingsPage === 'recipes' && !$('settingsPop').hidden) renderPage('recipes');
  }
}
// Programs, This machine and the small preferences, fetched from main when Settings needs them.
const sx = { programs: [], machine: null, prefs: { notify: { flash: true, toast: false }, hints: {}, shell: '', developer: false } };
// the shell a new CLI starts, in words ("PowerShell", "bash"): the + menu's hint for Shell on this machine
function shellWord() {
  const raw = String((sx.prefs && sx.prefs.shell) || (sx.machine && sx.machine.shell) || '').trim();
  const base = raw.split(/[\\/]/).pop().replace(/\.exe$/i, '').split(/\s+/)[0];
  return /^(pwsh|powershell)$/i.test(base) ? 'PowerShell' : /^cmd$/i.test(base) ? 'Command Prompt' : base;
}
window.wb
  .machineInfo()
  .then((m) => {
    sx.machine = sx.machine || m;
  })
  .catch(() => {});
// D1: the Concierge's choice is needed before Settings ever opens
window.wb
  .prefsGet()
  .then((p) => {
    acceptPrefs(p);
  })
  .catch(() => {});

function pageInfo(page) {
  if (PAGES[page]) {
    return PAGES[page];
  }
  if (typeof page === 'string' && page.startsWith('mod:')) {
    const m = modules.moduleList().find((x) => x.id === page.slice(4));
    return m ? { name: m.name, parent: 'modules' } : null;
  }
  if (typeof page === 'string' && page.startsWith('prog:')) {
    const p = sx.programs.find((x) => x.id === page.slice(5));
    return p ? { name: p.label, parent: 'programs' } : null;
  }
  if (typeof page === 'string' && page.startsWith('srv:')) {
    const s = groupServers(acc.servers).find((x) => x.id === page.slice(4));
    return s ? { name: s.name, parent: 'servers' } : null;
  }
  if (typeof page === 'string' && page.startsWith('recipe:')) {
    // Recipes › New recipe (editing: Recipes › site)
    if (page === 'recipe:new') {
      return { name: 'New recipe', parent: 'recipes' };
    }
    const r = recipeList.find((x) => x.id === page.slice(7));
    return r ? { name: r.name, parent: 'recipes' } : null;
  }
  return null;
}

async function loadSettingsData() {
  const [list, machine, prefs, upd] = await Promise.all([window.wb.programsList(), window.wb.machineInfo(), window.wb.prefsGet(), window.wb.updateState()]);
  sx.programs = list;
  sx.machine = machine;
  acceptPrefs(prefs);
  about.info = upd;
}

function renderAboutPage() {
  pages.renderAbout(
    $('secAbout'),
    { version: about.info.version, available: about.info.available, auto: about.info.auto, checking: about.checking, last: about.last, progress: about.progress, ready: updateReady },
    {
      check: async () => {
        about.checking = true;
        renderAboutPage();
        const r = await window.wb.updateCheck();
        about.checking = false;
        about.last = { ...r, at: Date.now() };
        if (settingsPage === 'about' && !$('settingsPop').hidden) {
          renderAboutPage();
        }
      },
      auto: async (on) => {
        about.info.auto = await window.wb.updateAuto(on);
        renderAboutPage();
      },
      restart: () => openUpdateDialog(),
      licenses: () => window.wb.openLicenses(),
    }
  );
  if (localFirstUI) {
    const local = document.createElement('div');
    $('secAbout').append(local); localFirstUI.about(local, { withTitle: false });
  }
}

const pageHandlers = {
  open: (id) => openSettings('prog:' + id),
  // 0.12.4: Install opens a pane on the Dashboard running the vendor's command; the click is the approval
  install: (id) => {
    const prog = (sx.programs || []).find((x) => x.id === id);
    closePops();
    if (modules.currentSurface() !== 'dashboard') {
      modules.setSurface('dashboard');
    }
    launch({ spec: { route: 'local', install: id }, name: 'Install ' + ((prog && prog.label) || id), why: 'install' });
  },
  toggle: async (id, on) => {
    sx.programs = await window.wb.programsSet({ id, enabled: on });
    openSettings(settingsPage);
  },
  set: async (id, patch) => {
    sx.programs = await window.wb.programsSet({ id, settings: patch });
    fillGlobal();
  },
  detect: async (id) => {
    sx.programs = await window.wb.programsDetect(id);
    if (settingsPage === 'prog:' + id && !$('settingsPop').hidden) {
      pages.renderProgram($('secProgram'), sx.programs.find((x) => x.id === id), { ...pageHandlers, detect: () => pageHandlers.detect(id) });
    }
  },
};

async function setPrefs(patch) {
  if (!acceptPrefs(await window.wb.prefsSet(patch))) return;
  if (!$('settingsPop').hidden && (settingsPage === 'notifications' || settingsPage === 'global' || settingsPage.startsWith('mod:'))) {
    openSettings(settingsPage);
  }
}

// ---- Accounts (step 3a). Present only when main loaded the Accounts module (init.accounts); with it
// absent nothing below shows and mode A is exactly as it was (the step-2 boundary).
const acc = { present: false, st: null, servers: [], ui: { step: null, address: null, error: null, busy: false, focus: null, name: null, nameError: null } };
function viewScope() { return { accountId: acc.st?.account?.id || null, selectionVersion: acc.st?.selectionVersion || 0 }; }
function currentViewScope(scope) { const now = viewScope(); return !!scope && scope.accountId === now.accountId && scope.selectionVersion === now.selectionVersion; }
function applyOfferView(v) { if (currentViewScope(v)) rail?.setOffer(v); }

let accountEpoch = 0;
async function accountsRefresh() {
  const epoch = accountEpoch;
  if (!acc.present) {
    return;
  }
  try {
    const state = await window.wb.accounts.state();
    if (epoch !== accountEpoch) return;
    const servers = state.account ? await window.wb.accounts.servers() : { rows: [] };
    if (epoch !== accountEpoch || (servers.accountId && servers.accountId !== state.account?.id)) return;
    acc.st = state; acc.servers = servers.rows || [];
  } catch (e) {
    acc.present = false; // the module's handlers are not there: behave as mode A
    acc.st = null;
    acc.servers = [];
  }
  accountsApply();
}

// ---- recipes (step 3c): the stored list from main, resolved into the rail's rows against the account's
// servers, the programs and the running CLIs; every change in any of those redraws the area
let recipeList = [], skippedLocalRecipes = [];
let recipeKnown = []; // the account's login ids with or without a grant (the request page's list)
function signedIn() {
  return !!(acc.present && acc.st && acc.st.account);
}
let recipeSynced = false; // one pull per sign-in; main pulls on a clock after that
async function recipesApply() {
  const epoch = accountEpoch;
  // 0.12.1 (): recipes in both modes, "CLIs and Recipes" always; the sync only with an account
  // (a recipe on This machine never syncs)
  if (!signedIn()) {
    recipeSynced = false;
  } else if (!recipeSynced) {
    recipeSynced = true;
    window.wb.recipesSync().catch(() => {});
  }
  // the programs as they are now (one is turned off → "<program> is off · Turn on" on its rows)
  const list = await window.wb.programsList();
  if (epoch !== accountEpoch) return;
  sx.programs = list;
  rail.setRecipes(recipeRows(recipeList, { servers: signedIn() ? acc.servers : [], programs: sx.programs, sessions: sessionList, known: signedIn() ? recipeKnown : [], draining: new Set(brokerGroups.filter((g) => g.ok && g.draining).map((g) => g.serverId)) }), unsavedView());
  applyGroups();
}
window.wb.on('programs:changed', (list) => {
  // 0.12.4: an Install pane ended or a check ran: the picker's rows and the Programs page follow
  if (Array.isArray(list)) {
    sx.programs = list;
    renderRecipeForm();
    if (typeof settingsPage === 'string' && (settingsPage === 'programs' || settingsPage.startsWith('prog:')) && !$('settingsPop').hidden) {
      showSettings(settingsPage);
    }
  }
});
window.wb.on('recipes:changed', (list) => {
  recipeList = list || [];
  recipesApply();
  if (settingsPage === 'recipes' && !$('settingsPop').hidden) {
    renderPage('recipes');
  }
});
// "Saved on this computer. It reaches your other computers when realm.example.com is back." (once per stretch)
window.wb.on('recipes:offline', ({ host }) => {
  accountsSnackbar(`Saved on this computer. It reaches your other computers when ${host} is back.`);
});
window.wb.on('recipes:local-sync-status', value => {
  skippedLocalRecipes = Array.isArray(value?.names) ? value.names : [];
  if (settingsPage === 'recipes' && !$('settingsPop').hidden) renderPage('recipes');
});
// Local engine recipe sync never borrows the selected account's credentials.
window.wb.on('recipes:local-sync-error', value => accountsSnackbar(value?.inUse
  ? 'A removed recipe still has a seat in a room. Remove that seat, then restart local rooms.'
  : "Couldn't update recipes in local rooms. Try again after restarting local rooms."));

/** Start a recipe: its program in its folder on its server · login, over the broker route (never ssh);
 *  the pane is titled with the recipe's name and takes its color (Auto: a fresh one). */
async function launchRecipe(id) {
  const rc = recipeList.find((r) => r.id === id);
  if (!rc) {
    return;
  }
  if (rc.loginId === 'local') {
    // 0.12.1: a plain local pane in the recipe's folder (its folder checked first, the cards if not)
    await launch({ spec: { route: 'local', recipeId: rc.id }, name: rc.name, hue: rc.color === 'auto' ? undefined : rc.color, why: 'recipe' });
    return;
  }
  const row = acc.servers.find((r) => r.loginId === rc.loginId && !r.request);
  if (!row) {
    openSettings('recipe:' + id);
    return;
  }
  if (row.state === 'broker-down' || row.state === 'identity') {
    // a recipe never falls back to plain ssh (ruled ): Enter on the row says why, with the page
    accountsSnackbar(`Can't start: ${row.serverName}'s broker for ${row.login} isn't running.`, { action: { label: 'Server page', fn: () => openSettings('srv:' + row.serverId) } });
    return;
  }
  await launch({ spec: { route: 'broker', serverId: row.id, recipeId: rc.id }, name: rc.name, hue: rc.color === 'auto' ? undefined : rc.color, why: 'recipe' });
}
/** "Delete the recipe site?" · "CLIs it started keep running. It's removed from every computer signed in
 *  to your account." [Cancel] [Delete] */
function confirmDeleteRecipe(id) {
  const rc = recipeList.find((r) => r.id === id);
  if (!rc) {
    return;
  }
  const back = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'end-dlg';
  const d = document.createElement('div');
  d.className = 'dlg';
  d.setAttribute('role', 'alertdialog');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-labelledby', 'rdT');
  d.setAttribute('aria-describedby', 'rdB');
  d.innerHTML = icon('delete', 'ic') + '<h4 id="rdT"></h4><p id="rdB">CLIs it started keep running. It\'s removed from every computer signed in to your account.</p><div class="a"><button class="cancel">Cancel</button><button class="danger">Delete</button></div>';
  d.querySelector('#rdT').textContent = `Delete the recipe ${rc.name}?`;
  wrap.appendChild(d);
  document.body.appendChild(wrap);
  consoleSync(); // and under a dialog
  const close = () => {
    wrap.remove();
    consoleSync();
    if (back && back.isConnected) {
      back.focus();
    }
  };
  d.querySelector('.cancel').addEventListener('click', close);
  d.querySelector('.danger').addEventListener('click', async () => {
    await window.wb.recipesDelete(id);
    close();
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  d.querySelector('.cancel').focus();
}

/** Everything outside the page that follows the account: the nav row, the menu label, the rail. */
function accountsApply() {
  codexPage?.accountChanged();
  const row = $('gsAccounts');
  row.hidden = !acc.present;
  const a = acc.present && acc.st && acc.st.account;
  $('gsAccountsV').textContent = a ? a.label : '';
  rail.setServers(a ? acc.servers : null);
  rail.update(sessionList);
  for (const pane of document.querySelectorAll('.pane[data-sid]')) { const t = tabs.get(Number(pane.dataset.sid)); if (t) paintPaneHeader(pane, t); }
  recipesApply();
  modules.renderTabs(); // 0.12.2: the Console pill follows the account (its admins only)
  if (!$('flyout').hidden) {
    renderFlyout();
  }
  if (!$('settingsPop').hidden && (settingsPage === 'accounts' || settingsPage === 'servers')) {
    renderPage(settingsPage);
  }
}

async function selectAccount(id) {
  const previous = acc.st?.account?.id;
  if (!id || id === previous) return;
  const r = await window.wb.accounts.select(id);
  if (r?.ok) {
    const a = r.state.account;
    accountsSnackbar(`Switched to ${a.label}. Open panes stay as they are.`, { action: { label: 'Undo', fn: () => selectAccount(previous) } });
  }
}
const accountsHandlers = {
  select: selectAccount,
  add: () => { acc.ui = { step: 'address', address: '', focus: 'address' }; openSettings('accounts'); },
  rerender: () => renderAccountsPage(),
  begin: async (address) => {
    document.querySelector('.ac-snack')?.remove(); // a new sign-in dismisses an earlier account notice (the design , fix 1)
    acc.ui.busy = true;
    acc.ui.error = null;
    renderAccountsPage();
    const r = await window.wb.accounts.begin(address).catch(() => ({ ok: false, error: '' }));
    acc.ui.busy = false;
    acc.ui.error = r.ok ? null : r.error;
    if (!r.ok) {
      acc.ui.focus = 'address';
    }
    renderAccountsPage();
  },
  reopen: () => window.wb.accounts.reopen(),
  cancel: () => window.wb.accounts.cancel(),
  name: (name) => window.wb.accounts.name(name),
  signout: (id) => window.wb.accounts.signout(id),
  // the account ended this computer's sign-in: sign in again to the same address
  signInAgain: (address) => {
    acc.ui.step = 'address';
    acc.ui.address = address;
    accountsHandlers.begin(address);
  },
  manage: (id) => window.wb.accounts.manage(id),
};

function renderAccountsPage() {
  if (acc.present && acc.st) {
    renderAccounts($('secAccounts'), acc.st, acc.ui, accountsHandlers);
  }
  renderYourColor($('secAccounts'));
  renderPictureSettings();
}

// Tasks seam S1: the engine a rail card was bound to. It moves on when the rooms service changes server,
// sign-in or person, or comes back up after being down (an engine restart), so late card updates are dropped.
let engineEpoch = 0;
let engineKey = null;
window.wb.on('rooms:status', (s) => {
  const key = s ? [s.server, s.signedIn, s.me && s.me.id, s.conn === 'live' || s.conn === 'polling'].join('|') : 'none';
  if (key !== engineKey) {
    if (engineKey !== null) {
      engineEpoch++;
      modules.epochsChanged(); // stale cards: re-send rooms.shown so modules draw them again
    }
    engineKey = key;
  }
});
window.wb.on('rooms:status', () => {
  if (!$('settingsPop').hidden && settingsPage === 'accounts') {
    renderYourColor($('secAccounts')); // signed in or out of Workrooms, or your color saved elsewhere
    queueMicrotask(() => renderPictureSettings()); // let the room page accept this status first
  }
});
function renderPictureSettings() {
  renderYourPicture($('secAccounts'), {
    status: () => withOwnPictureStatus(roomsPage ? roomsPage.state().status : null),
    save: patch => window.wb.rooms.me(patch),
    snackbar: accountsSnackbar,
  });
}
// 0.20.0 (A4; the design <commit> "Colors"): your own color, one of the twelve swatches, kept by the room service on
// /api/rooms/me (engine `color`). It tints your messages and your initials, and others see it too.
let yourColorBusy = false;
function renderYourColor(sec) {
  if (!sec) {
    return;
  }
  for (const old of sec.querySelectorAll('.ac-yourcolor')) {
    old.remove();
  }
  const rs = roomsPage ? roomsPage.state().status : null;
  const box = document.createElement('div');
  box.className = 'ac-yourcolor';
  const t = document.createElement('div');
  t.className = 'ac-title';
  t.textContent = 'Your color';
  box.appendChild(t);
  const help = document.createElement('div');
  help.className = 'ac-sub';
  box.appendChild(help);
  if (!rs || !rs.signedIn) {
    help.textContent = 'Sign in to Workrooms to choose your color.';
    sec.appendChild(box);
    return;
  }
  help.textContent = 'Tints your messages and your initials. Others see it too.';
  const cur = String((rs.me && rs.me.color) || roomsPage?.personColor?.() || '').toLowerCase();
  const row = document.createElement('div');
  row.className = 'wr-swatches';
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', 'Your color');
  for (const c of SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wr-sw' + (c.toLowerCase() === cur ? ' on' : '');
    b.style.background = c;
    b.dataset.color = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c.toLowerCase() === cur));
    b.setAttribute('aria-label', c);
    b.disabled = yourColorBusy;
    if (c.toLowerCase() === cur) {
      b.innerHTML = icon('check');
    }
    b.addEventListener('click', async () => {
      if (c.toLowerCase() === cur) {
        return;
      }
      yourColorBusy = true;
      renderYourColor(sec);
      const r = await window.wb.rooms.me({ color: c }).catch(() => null);
      yourColorBusy = false;
      if (!r || !r.ok) {
        accountsSnackbar("Couldn't save your color. Try again.");
      }
      renderYourColor(sec);
    });
    row.appendChild(b);
  }
  box.appendChild(row);
  // the design : the default is named; once another is picked, "Use the default" brings it back
  const foot = document.createElement('div');
  foot.className = 'ac-sub ac-yourcolor-foot';
  if (!rs.me?.color) {
    foot.textContent = 'Default';
  } else {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'slink';
    back.textContent = 'Use the default';
    back.disabled = yourColorBusy;
    back.addEventListener('click', async () => {
      yourColorBusy = true;
      renderYourColor(sec);
      const r = await window.wb.rooms.me({ color: null }).catch(() => null);
      yourColorBusy = false;
      if (!r || !r.ok) {
        accountsSnackbar("Couldn't save your color. Try again.");
      }
      renderYourColor(sec);
    });
    foot.appendChild(back);
  }
  box.appendChild(foot);
  sec.appendChild(box);
}

// ---- step 4 (4b, resume; the design's workbench-step4-restore): restoring stopped conversations. Each one is an
// explicit launch with its own permit: an open pane resumes in place; a row with no pane opens one in this
// window. The offer card counts "Restoring 2 of 3…" and leaves when they're back; failures are said once.
async function restoreRows(rows, scope = viewScope()) {
  if (!currentViewScope(scope)) return;
  const list = (rows || []).slice();
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    rail && rail.setRestoring({ done: i, of: list.length });
    const r = list[i];
    const permit = await window.wb.permit();
    if (!currentViewScope(scope)) return;
    if (r.openSid != null) {
      window.wb.retrySession(r.openSid, { permit });
      continue;
    }
    const spec = await window.wb.sessions.restoreSpec(r.key).catch(() => null);
    if (!currentViewScope(scope)) return;
    if (!spec) {
      failed += 1;
      continue;
    }
    const sid = await addTab({ spec: spec.spec, name: spec.name || r.name, hue: spec.hue, permit, why: 'restore' }).catch(() => null);
    if (!currentViewScope(scope)) return;
    if (!sid) {
      failed += 1;
    }
  }
  rail && rail.setRestoring(null);
  if (failed) {
    accountsSnackbar(list.length - failed + ' restored. ' + failed + " couldn't be.");
  }
  window.wb.sessions.offer().then(applyOfferView);
}
// "Choose conversations to restore", all ticked, [Restore N]; each row: where it ran and what it was about
function chooseToRestore(o) {
  const scope = viewScope();
  if (!o || !o.rows || !o.rows.length) {
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'end-dlg';
  wrap.dataset.accountDialog = 'history';
  const d = document.createElement('div');
  d.className = 'dlg rs-dlg';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  d.innerHTML = icon('history', 'ic') + '<h4>Choose conversations to restore</h4><div class="rs-list"></div><div class="a"><button class="cancel">Cancel</button><button class="go"></button></div>';
  const listEl = d.querySelector('.rs-list');
  const picked = new Set(o.rows.map((r) => r.key));
  const go = d.querySelector('.go');
  const paint = () => {
    go.textContent = 'Restore ' + picked.size;
    go.disabled = !picked.size;
  };
  for (const r of o.rows) {
    const row = document.createElement('label');
    row.className = 'rs-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', () => {
      if (cb.checked) {
        picked.add(r.key);
      } else {
        picked.delete(r.key);
      }
      paint();
    });
    const tx = document.createElement('span');
    tx.className = 'rs-tx';
    const b = document.createElement('b');
    b.textContent = r.name;
    const sm = document.createElement('small');
    const ago = Math.max(1, Math.round((Date.now() - (r.interruptedAt || Date.now())) / 60000));
    sm.textContent = [r.serverName, r.login, r.folder].filter(Boolean).join(' · ') + ' · stopped ' + (ago < 60 ? ago + ' min ago' : Math.round(ago / 60) + ' h ago');
    tx.append(b, sm);
    if (r.title && r.title !== r.name) {
      const t = document.createElement('i');
      t.textContent = r.title;
      tx.appendChild(t);
    }
    row.append(cb, tx);
    listEl.appendChild(row);
  }
  paint();
  wrap.appendChild(d);
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  d.querySelector('.cancel').addEventListener('click', close);
  go.addEventListener('click', () => {
    close();
    restoreRows(o.rows.filter((r) => picked.has(r.key)), scope);
  });
  go.focus();
}
// Recently closed: "Claude conversations from the last 7 days that aren't open. Shells aren't kept."
async function openRecentlyClosed() {
  const scope = viewScope();
  const v = await window.wb.sessions.offer().catch(() => null);
  if (!currentViewScope(scope) || !currentViewScope(v)) return;
  const rows = (v && v.recent) || [];
  const wrap = document.createElement('div');
  wrap.className = 'end-dlg';
  wrap.dataset.accountDialog = 'history';
  const d = document.createElement('div');
  d.className = 'dlg rs-dlg';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  d.innerHTML = icon('history', 'ic') + "<h4>Recently closed</h4><p>Claude conversations from the last 7 days that aren't open. Shells aren't kept.</p><div class=\"rs-list\"></div><div class=\"a\"><button class=\"cancel\">Close</button></div>";
  const listEl = d.querySelector('.rs-list');
  const paint = (list) => {
    listEl.textContent = '';
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'rs-empty';
      e.textContent = 'Nothing here.';
      listEl.appendChild(e);
    }
    for (const r of list) {
      const row = document.createElement('div');
      row.className = 'rs-row';
      const tx = document.createElement('span');
      tx.className = 'rs-tx';
      const b = document.createElement('b');
      b.textContent = r.name;
      const sm = document.createElement('small');
      sm.textContent = [r.serverName, r.login, r.folder].filter(Boolean).join(' · ') + ' · ' + new Date(r.interruptedAt || Date.now()).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      tx.append(b, sm);
      const rb = document.createElement('button');
      rb.className = 'rail-restore';
      rb.textContent = 'Restore';
      rb.addEventListener('click', () => {
        wrap.remove();
        restoreRows([r], scope);
      });
      const rm = document.createElement('button');
      rm.className = 'rail-ib';
      rm.title = 'Remove from the list';
      rm.setAttribute('aria-label', 'Remove ' + r.name + ' from the list');
      rm.innerHTML = icon('close');
      rm.addEventListener('click', async () => {
        if (!currentViewScope(scope)) return;
        const nv = await window.wb.sessions.remove(r.key).catch(() => null);
        if (!currentViewScope(scope) || !currentViewScope(nv)) return;
        applyOfferView(nv);
        paint((nv && nv.recent) || []);
      });
      row.append(tx, rb, rm);
      listEl.appendChild(row);
    }
  };
  paint(rows);
  wrap.appendChild(d);
  document.body.appendChild(wrap);
  d.querySelector('.cancel').addEventListener('click', () => wrap.remove());
  d.querySelector('.cancel').focus();
}
window.wb.on('sessions:offer', applyOfferView);
window.wb.sessions
  .offer()
  .then(applyOfferView)
  .catch(() => {});

// ---- F7, Request access (3b): a page in the settings sheet; the request outcomes as snackbars
const rq = { loading: false, loadFailed: false, servers: null, serverId: null, picked: new Set(), note: '', error: null, sending: false };
const accHost = () => (acc.st && acc.st.account ? acc.st.account.address : '');
const deniedText = (title, note) => `Your request for ${title} was denied.` + (note ? ` \u201c${note}\u201d` : '');

async function loadRequestable() {
  const epoch = accountEpoch;
  rq.loading = true;
  rq.loadFailed = false;
  renderRequestPage();
  const r = await window.wb.accounts.requestable().catch(() => ({ ok: false }));
  if (epoch !== accountEpoch) return;
  rq.loading = false;
  rq.loadFailed = !r.ok;
  rq.servers = r.ok ? r.servers : null;
  if (r.ok) {
    // every login the account has, granted or not: a recipe on one without a grant reads "No access"
    recipeKnown = r.servers.flatMap((sv) => (sv.logins || []).map((l) => l.id));
    recipesApply();
  }
  const list = askable(rq.servers);
  if (!list.some((s) => s.id === rq.serverId)) {
    rq.serverId = list.length ? list[0].id : null;
    rq.picked = new Set();
  }
  renderRequestPage();
}

function openRequest() {
  Object.assign(rq, { serverId: null, picked: new Set(), note: '', error: null, sending: false });
  openSettings('request');
  loadRequestable();
}

const requestHandlers = {
  pick: (id) => {
    rq.serverId = id;
    rq.picked = new Set();
    rq.error = null;
    renderRequestPage();
  },
  toggle: (loginId) => {
    if (rq.picked.has(loginId)) {
      rq.picked.delete(loginId);
    } else {
      rq.picked.add(loginId);
    }
    renderRequestPage();
  },
  note: (t) => {
    rq.note = t.slice(0, 200);
  },
  cancel: () => openSettings('servers'),
  reload: () => loadRequestable(),
  send: async (serverId) => {
    rq.sending = true;
    rq.error = null;
    renderRequestPage();
    const r = await window.wb.accounts.request(serverId, [...rq.picked], rq.note).catch(() => ({ ok: false }));
    rq.sending = false;
    if (r.ok) {
      // the sheet goes back to Servers with the pending row; the rail shows the same row
      openSettings('servers');
      accountsSnackbar('Request sent to the admin.');
      return;
    }
    rq.error = 'cant-send'; // under Send; the form keeps what was typed
    renderRequestPage();
  },
};

function renderRequestPage() {
  if (acc.present && settingsPage === 'request') {
    const focus = document.activeElement && document.activeElement.id;
    renderRequest($('secRequest'), rq, requestHandlers, accHost());
    if (focus === 'rqNote' && $('rqNote')) {
      const t = $('rqNote');
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
  }
}

// ---- Settings › Servers with an account, and a server's page (3b, the design s1/s2)
const svDet = { open: false, hostFp: null, server: null };
const realmName = () => (acc.st && acc.st.account ? acc.st.account.realmName : '');
const serversHandlers = {
  account: () => (acc.st && acc.st.account) || null,
  accountEpoch: () => acc.st?.selectionVersion || 0,
  moduleCall: (request) => window.wb.brokerModules(request),
  openServerPage: (id) => {
    Object.assign(svDet, { open: false, hostFp: null, server: id });
    openSettings('srv:' + id);
  },
  requestAccess: () => openRequest(),
  cancelRequest: (id) => window.wb.accounts.requestAct(id, 'cancel').catch(() => null),
  test: (id) => window.wb.accounts.testServer(id).catch(() => null),
  open: (r) => {
    closePops();
    launch({ spec: { route: r.keysOnly ? 'ssh' : 'broker', serverId: r.id } });
  },
  signInAgain: () => openSettings('accounts'),
  openDetails: () => {
    svDet.open = true;
    loadHostKey();
  },
  toggleDetails: () => {
    svDet.open = !svDet.open;
    if (svDet.open) {
      loadHostKey();
    } else {
      renderServerPageNow();
    }
  },
  forgetHostKey: async () => {
    const s = currentServer();
    const r = s && s.logins.find((x) => x.keysOnly);
    if (r) {
      await window.wb.forgetHostKey(r.id).catch(() => null);
      loadHostKey();
    }
  },
};
// ---- 5a, the keys fallback: this PC's key card, the reminder strip, the row's one action
const kx = { view: null, older: new Map() };
async function loadKeys() {
  kx.view = (await window.wb.keys.state().catch(() => null)) || null;
  if (kx.view && kx.view.ok === false) {
    kx.view = null;
  }
}
window.wb.on('keys:state', (v) => {
  kx.view = v || null;
  rerenderServers();
});
window.wb.on('keys:resume', (p) => {
  // rule 8: a refresh a restart cut short (the plan's words)
  if (p.state === 'now') {
    accountsSnackbar('Finishing the key refresh on ' + p.name + '…');
  } else if (p.state === 'done') {
    accountsSnackbar('Key refreshed on ' + p.name);
  } else if (p.state === 'kept-old') {
    accountsSnackbar("The new key didn't work on " + p.name + '. Nothing was removed. Your old key still works.');
  }
  void loadKeys().then(rerenderServers);
});
/** 5a: the key view as main has it now; one repaint when it changed (opening Servers or a server page). */
function syncKeys() {
  const was = JSON.stringify(kx.view);
  void loadKeys().then(() => {
    if (JSON.stringify(kx.view) !== was) {
      rerenderServers();
    }
  });
}
function rerenderServers() {
  if (!$('settingsPop').hidden && (settingsPage === 'servers' || settingsPage.startsWith('srv:'))) {
    renderPage(settingsPage);
  }
}
const keysDeps = {
  snackbar: (t) => accountsSnackbar(t),
  copy: (t) => window.wb.copyText(t),
  run: (id) => window.wb.keys.refresh(id),
  cancel: (id) => window.wb.keys.cancelRefresh(id),
  retireAgain: async (id, fp) => {
    const r = await window.wb.keys.retireAgain(id, fp || '');
    accountsSnackbar(r && r.ok ? 'Took the old key off.' : 'The old key is still there. Try again later.');
    return r;
  },
  removeEverywhere: () => window.wb.keys.removeEverywhere(),
  onProgress: (fn) => {
    keysProgress.add(fn);
    return () => keysProgress.delete(fn);
  },
};
const keysProgress = new Set();
window.wb.on('keys:progress', (p) => keysProgress.forEach((fn) => fn(p)));
/** The row's one action (rail and Settings): Connect with a password, or Make a new key. */
async function keyAction(v) {
  if (!v || !v.action) {
    return;
  }
  if (v.action.act === 'make-key') {
    await window.wb.keys.make().catch(() => null);
    await loadKeys();
    accountsSnackbar('Made a new key. Connect with a password once on each server it was on.');
    return;
  }
  const r = await window.wb.keys.connect(v.id).catch(() => null);
  if (!r || !r.ok) {
    accountsSnackbar("Couldn't start. Try again.");
    return;
  }
  if (r.kind === 'pane') {
    closePops();
    launch({ spec: { route: 'ssh', serverId: v.id, keyInstall: r.token }, name: r.name, why: 'key-connect' });
    return;
  }
  // a server that takes no password (the design k5): the line for an admin, then Check again
  for (;;) {
    const go = await keysUi.noPassword(r, keysDeps);
    if (go !== 'check') {
      return;
    }
    const c = await window.wb.keys.checkAdded(v.id).catch(() => null);
    if (c && c.ok) {
      accountsSnackbar(r.name + " now signs in with this PC's key.");
      await loadKeys();
      rerenderServers();
      return;
    }
  }
}
const keysHandlers = {
  refresh: async (row) => {
    await keysUi.refresh(row, keysDeps);
    await loadKeys();
    kx.older.delete(row.id);
    rerenderServers();
  },
  refreshFirst: (e) => {
    const row = (acc.servers || []).find((x) => x.id === e.serverId);
    if (row) {
      void keysHandlers.refresh(row);
    }
  },
  remindMenu: (anchor) => {
    const b = anchor.getBoundingClientRect();
    const cur = kx.view ? kx.view.remind.days : 90;
    roomsMenu(document.body, { x: b.left, y: b.bottom + 2 }, keysUi.REMIND_CHOICES.map((d) => ({ id: 'rd-' + d, label: d ? 'Every ' + d + ' days' : 'Never', checked: d === cur, fn: async () => {
      await window.wb.keys.remind(d);
      await loadKeys();
      rerenderServers();
    } })));
    const m = document.body.querySelector(':scope > .wr-pmenu');
    if (m) {
      m.style.zIndex = '95';
    }
  },
  removeEverywhere: async () => {
    await keysUi.removeEverywhere((kx.view && kx.view.ledger) || [], keysDeps);
    await loadKeys();
    rerenderServers();
  },
  forget: async (row, line) => {
    const r = await window.wb.keys.forget(row.id, line).catch(() => null);
    accountsSnackbar(r && r.ok ? 'Forgot the older key on ' + row.serverName + '.' : "Couldn't remove it. Try again.");
    kx.older.delete(row.id);
    rerenderServers();
  },
  snooze: async () => {
    await window.wb.keys.snooze();
    await loadKeys();
    rerenderServers();
  },
};
serversHandlers.keyAction = (r) => keyAction(r);
serversHandlers.keyReminder = () => keysUi.reminderStrip(kx.view, keysHandlers);
serversHandlers.keyCard = (r) => {
  if (!kx.view || !kx.view.ledger.some((e) => e.serverId === r.id)) {
    return null;
  }
  if (!kx.older.has(r.id)) {
    kx.older.set(r.id, []);
    void window.wb.keys.older(r.id).then((list) => {
      kx.older.set(r.id, Array.isArray(list) ? list : []);
      if (list && list.length) {
        rerenderServers();
      }
    });
  }
  return keysUi.keyCard(r, kx.view, kx.older.get(r.id), keysHandlers);
};
void loadKeys();

function currentServer() {
  return settingsPage.startsWith('srv:') ? groupServers(acc.servers).find((x) => x.id === settingsPage.slice(4)) || null : null;
}
async function loadHostKey() {
  const s = currentServer();
  const r = s && s.logins.find((x) => x.keysOnly);
  svDet.hostFp = r ? ((await window.wb.hostKey(r.id).catch(() => null)) || {}).fingerprint || null : null;
  renderServerPageNow();
}
function renderServerPageNow() {
  if (acc.present && settingsPage.startsWith('srv:') && !$('settingsPop').hidden) {
    renderServerPage($('secServer'), currentServer(), realmName(), serversHandlers, svDet);
  }
}

// workbench://servers (the approval mail's button): the rail opens on its servers
window.wb.on('app:show-servers', () => rail.open());

// What the account decided while the app was open (access.js news): one snackbar, in the window in use
window.wb.on('accounts:access-news', (n) => {
  if (!acc.present || !(document.hasFocus() || myWid === 1)) {
    return;
  }
  if (n.kind === 'approved') {
    accountsSnackbar(`You now have access to ${n.title}. It's in the rail.`, { action: { label: 'Open a shell', fn: () => launch({ spec: { route: n.keysOnly ? 'ssh' : 'broker', serverId: n.serverId } }) }, ms: 8000, close: false });
  } else if (n.kind === 'denied') {
    accountsSnackbar(deniedText(n.title, n.note));
  } else if (n.kind === 'removed') {
    // the design : a pane on that login already shows the card (its broker said "access removed");
    // with no such pane, one snackbar. The rail row has left.
    const carded = [...tabs.values()].some((t) => t.route && t.route.serverId === n.serverId && t.route.state === 'access-removed');
    if (!carded) {
      accountsSnackbar(`An admin removed your access to ${n.title}. CLIs you started there keep running, but you can't open them.`);
    }
  }
});

function renderPage(page) {
  void webRouter?.render(page); // a web page shows; any other page leaves the one that was showing
  if (page !== 'apps') appsSettings?.close();
  if(page==='global'){
    const owner=roomsPage,scope=viewScope(),version=owner?.starterVisibilityVersion?.()||0,host=$('starterVisibilitySettings');
    if(host)renderStarterVisibilitySettings(host,{available:!!window.wb.starterRooms&&scope.accountId===null&&owner?.starterVisibilityReady()===true,
      hidden:owner?.starterHidden()===true,setHidden:value=>owner?.setStarterHidden(value)===true,
      current:()=>owner===roomsPage&&currentViewScope(scope)&&owner?.starterVisibilityReady()===true&&(owner?.starterVisibilityVersion?.()||0)===version});
  }
  if (page === 'files' && localFirstUI) {
    localFirstUI.files($('secFiles'));
  } else if (page === 'chat-history' && localFirstUI) {
    localFirstUI.history($('secChatHistory'));
  } else if (page === 'accounts') {
    renderAccountsPage();
  } else if (page === 'apps') {
    if (!appsSettings) appsSettings = createAppsSettings({host:$('secApps'),api:window.wb.rooms,paintTone:(node,choice)=>m3.applyTo(node,choice.seed,m3.get().style)});
    void appsSettings.open();
  } else if (page === 'scratchpad') {
    if (!scratchpadSettings) scratchpadSettings = createScratchpadSettings({ host: $('secScratchpad'), api: window.wb.scratchpad,
      canChangeLocation: () => !scratchpadPage || scratchpadPage.canChangeLocation(),
      onChanged: event => scratchpadPage?.changed(event),
      onOpen: () => { closePops(); modules.setSurface('scratchpad'); } });
    void scratchpadSettings.refresh();
  } else if (page === 'request') {
    renderRequestPage();
  } else if (page.startsWith('srv:')) {
    syncKeys();
    renderServerPage($('secServer'), currentServer(), realmName(), serversHandlers, svDet);
  } else if (page === 'servers') {
    syncKeys();
    pages.renderServers($('secServers'), sx.machine, (p) => openSettings(p));
    localFirstUI?.connectedServers($('secServers'), localFirstState);
    if (acc.present && acc.st && acc.st.account) {
      renderAccountServers($('secServers'), acc.servers, realmName(), serversHandlers);
    }
    if (acc.present && acc.st && !acc.st.account) {
      // mode A gets its line now too (the design 3a (d))
      const line = document.createElement('div');
      line.className = 'pg-acline';
      line.append('Other servers come with an account. ');
      const b = document.createElement('button');
      b.className = 'ac-btn t';
      b.id = 'serversSignIn';
      b.textContent = 'Sign in';
      b.addEventListener('click', () => {
        acc.ui.step = 'address';
        acc.ui.focus = 'address';
        openSettings('accounts');
      });
      line.appendChild(b);
      $('secServers').appendChild(line);
    }
  } else if (page === 'machine') {
    pages.renderMachine($('secMachine'), sx.machine, sx.prefs, setPrefs);
  } else if (page === 'programs') {
    pages.renderPrograms($('secPrograms'), sx.programs, sx.machine, pageHandlers);
  } else if (page.startsWith('prog:')) {
    const id = page.slice(5);
    pages.renderProgram($('secProgram'), sx.programs.find((x) => x.id === id), pageHandlers);
  } else if (page === 'notifications') {
    pages.renderNotifications($('secNotify'), sx.prefs, setPrefs, platform);
  } else if (page === 'about') {
    renderAboutPage();
  } else if (page === 'recipes') {
    renderRecipesList($('secRecipes'), recipeRows(recipeList, { servers: acc.servers, programs: sx.programs, sessions: sessionList, known: recipeKnown }), { importRecipes: window.wb.web ? undefined : () => { const epoch=accountEpoch; void openRecipeImport($('secRecipes'),{api:window.wb.recipeImport,current:()=>epoch===accountEpoch,onCancel:()=>renderPage('recipes'),onResult:(text,details)=>accountsSnackbar(text,{action:{label:'Details',fn:details}})}); }, skippedRecipes: skippedLocalRecipes, starterAgents: localFirstState?.starterAgents, restoringStarters: restoringStarterFiles, restoreStarters: restoreStarterFiles, edit: (id) => openSettings('recipe:' + id), create: () => openSettings('recipe:new') });
  } else if (page.startsWith('recipe:')) {
    openRecipeForm(page === 'recipe:new' ? null : page.slice(7));
  }
}

// ---- the recipe form (F4): one record being edited, its folder check and its save
let rf = null; // { id, name, loginId, folder, folderTyped, programId, options, color, dirty, check, setup, saving, forId }
// Isolated FB32 slice: main validation/sync and visual gates must be admitted
// together before enabling this. No committed profile or preload enables it.
const RECIPE_PARITY_ENABLED = false;
let recipeFolderSequence=0;
function prepareRecipeFolderPicker() {
  const form=rf;if(!form)return;
  const previous=form.folderPicker?.state();
  if(previous?.token)form.folderSelection={path:previous.path,token:previous.token};
  form.folderPicker?.invalidate();form.folderPicker=null;form.folderPickerState=null;
  if(form.loginId!=='local')return;
  const generation=++recipeFolderSequence,epoch=accountEpoch;
  form.folderView=generation;form.folderChoiceVersion=0;form.folderFormId ||= 'rf-'+Date.now().toString(36)+'-'+generation;
  const current=()=>rf===form&&epoch===accountEpoch&&form.folderView===generation&&form.loginId==='local'&&settingsPage==='recipe:'+form.forId&&!$('settingsPop').hidden;
  const picker=createRecipeFolderPicker({api:window.wb,current,onState:state=>{
    if(!current())return;
    form.folderPickerState=state;
    if(state.token){
      form.folderSelection={path:state.path,token:state.token};
      if(state.choiceVersion>form.folderChoiceVersion){form.folderChoiceVersion=state.choiceVersion;form.folder=state.path;form.folderTyped=true;form.dirty=true;form.check={state:'found',folder:state.path,path:state.path};form.setup={state:'idle'};}
    }
    renderRecipeForm();
  }});
  form.folderPicker=picker;
  void picker.begin({formId:form.folderFormId,context:form.folderRole==='concierge'?'concierge':'general',recipeId:form.id||null,path:form.folder==='~'?'':form.folder,
    selectionToken:form.folderSelection?.path===form.folder?form.folderSelection.token:null});
}
function openRecipeForm(id, folderRole = 'agents', prepareOnly = false) {
  if (!rf || rf.forId !== (id || 'new')) {
    const r = id ? recipeList.find((x) => x.id === id) : null;
    const rows = acc.servers.filter((x) => !x.request && !x.keysOnly);
    // pre-filled with the login used last (the newest recipe's), else the only one there is
    const last = recipeList.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    rf = {
      forId: id || 'new',
      id: r ? r.id : null,
      name: r ? r.name : '',
      unavailableTarget: r?.unavailableTarget || null,
      loginId: r ? r.loginId : 'local', // 0.12.1 (): This machine is the default; servers are picked
      command: r ? r.command || '' : '',
      folder: r ? r.folder : newLocalRecipeFolder(localFirstState, folderRole),
      folderRole,
      folderTyped: !!(r && r.folder !== '~'),
      programId: r ? r.programId : '',
      options: r ? { ...r.options } : {},
      parityEnabled:RECIPE_PARITY_ENABLED,agent:r?.agent??'',fontSize:r?.fontSize??null,logo:r?.logo??null,
      worktree:r?.worktree??(r?.importWorktree==='auto'?'auto':'never'),
      color: r ? r.color : 'auto',
      dirty: false,
      check: { state: 'idle' },
      setup: { state: 'idle' },
      saving: false,
    };
    if (r && r.folder && r.folder !== '~') {
      recipeHandlers.checkFolder();
    }
    void last;
    void rows;
  }
  rf.parityView=(rf.parityView||0)+1;
  rf.saving=false;rf.logoBusy=false;
  // Settings prepares the entry-specific draft before its normal paint; detect programs only on that paint.
  if (prepareOnly) return;
  if(typeof window.wb.recipesFolderForm==='function'&&typeof window.wb.recipesPickFolder==='function')prepareRecipeFolderPicker();
  renderRecipeForm();
  // the local report for the Run list ("2.1.3" / "Not found on this computer"), taken once per program
  const todo = sx.programs.filter((p) => p.enabled && p.binary && !p.detected);
  if (todo.length) {
    Promise.all(todo.map((p) => window.wb.programsDetect(p.id).catch(() => null))).then(async () => {
      sx.programs = await window.wb.programsList();
      renderRecipeForm();
    });
  }
}
function renderRecipeForm() {
  if (!rf || !settingsPage.startsWith('recipe:')) {
    return;
  }
  const focus = document.activeElement && document.activeElement.id;
  const sel = focus && document.activeElement.tagName === 'INPUT' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  renderRecipe($('secRecipe'), { ...rf, saveAnyway: rf.check.state === 'missing' || rf.check.state === 'unknown' }, { servers: signedIn() ? acc.servers : [], programs: sx.programs, hues: SAMPLE_HUES, machine: sx.machine, signedIn: signedIn() }, recipeHandlers);
  if (focus && $(focus)) {
    $(focus).focus();
    if (sel && $(focus).setSelectionRange) {
      try {
        $(focus).setSelectionRange(sel[0], sel[1]);
      } catch (e) {
        // not a text control
      }
    }
  }
}
const recipeHandlers = {
  pickFolder: mode => rf?.folderPicker?.pick(mode),
  set: (field, value) => {
    if(field==='folder'&&rf?.loginId==='local')return;
    if (!rf) {
      return;
    }
    if(rf.saving)return;
    if(rf.parityEnabled===true&&field==='programId'){
      const changed=changeParityVendor(rf,value);rf.options=changed.draft.options;
      if(changed.effortReset)accountsSnackbar('Effort reset to vendor default.');
    }
    // Clear/replacement is a new logo intent; a superseded read owns no gate.
    if(field==='logo'){rf.logoRequest=(rf.logoRequest||0)+1;rf.logoBusy=false;}
    rf[field] = value;
    rf.dirty = true;
    if (field === 'command') {
      return; // typed, never re-drawn under the caret
    }
    if (field === 'folder') {
      rf.folderTyped = true;
      rf.check = { state: 'idle' }; // "until the field changes"
      rf.setup = { state: 'idle' };
      return; // typing never re-draws the form (the caret stays); the check runs on blur
    }
    if (field === 'loginId') {
      if (!rf.id && !rf.folderTyped) rf.folder = value === 'local' ? newLocalRecipeFolder(localFirstState, rf.folderRole) : '~';
      rf.check = { state: 'idle' };
      if(typeof window.wb.recipesFolderForm==='function'&&typeof window.wb.recipesPickFolder==='function')prepareRecipeFolderPicker();
      if (rf.folderTyped) {
        recipeHandlers.checkFolder();
      }
    }
    renderRecipeForm();
  },
  chooseLogo: () => {
    if(!rf?.parityEnabled||rf.saving)return;
    const form=rf,epoch=accountEpoch,viewGeneration=rf.parityView,request=(rf.logoRequest||0)+1,input=document.createElement('input');input.type='file';input.accept='image/png';form.logoRequest=request;
    // Invalidate the old read before opening another dialog. Cancel has no
    // change event, so it must not inherit that read's Save block.
    form.logoBusy=false;renderRecipeForm();
    input.addEventListener('change',async()=>{
      const current=()=>rf===form&&epoch===accountEpoch&&form.parityView===viewGeneration&&form.logoRequest===request&&settingsPage==='recipe:'+form.forId&&!$('settingsPop').hidden;
      if(!current()||input.files?.length!==1)return;
      const file=input.files[0];if(file.size>256*1024){accountsSnackbar('Choose a PNG logo up to 256 KB and 256 × 256 pixels.');return;}
      form.logoBusy=true;renderRecipeForm();
      try{
        const bytes=new Uint8Array(await file.arrayBuffer());if(!current())return;
        const header=[137,80,78,71,13,10,26,10],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        if(bytes.length<24||bytes.length>256*1024||!header.every((v,i)=>bytes[i]===v)||String.fromCharCode(...bytes.subarray(12,16))!=='IHDR'||view.getUint32(16)<1||view.getUint32(16)>256||view.getUint32(20)<1||view.getUint32(20)>256)throw Error('invalid-image');
        let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
        form.logo='data:image/png;base64,'+btoa(binary);form.dirty=true;renderRecipeForm();
      }catch{if(current())accountsSnackbar('Choose a PNG logo up to 256 KB and 256 × 256 pixels.');}
      finally{if(current()){form.logoBusy=false;renderRecipeForm();}}
    },{once:true});input.click();
  },
  checkFolder: async () => {
    if (!rf || !rf.loginId) {
      return;
    }
    const row = rf.loginId === 'local' ? { id: 'local' } : acc.servers.find((x) => x.loginId === rf.loginId && !x.request);
    const folder = rf.loginId==='local'?String(rf.folder||'~'):normalizeFolder(rf.folder); // "Normalized silently: trailing slash, spaces, a pasted your account@srv: prefix"
    rf.folder = folder === '~' && !rf.folderTyped ? '~' : folder;
    if (!row || folder === '~') {
      rf.check = { state: 'idle' };
      renderRecipeForm();
      return;
    }
    rf.check = { state: 'checking', folder };
    renderRecipeForm();
    const r = await window.wb.recipesCheckFolder(row.id, folder).catch(() => ({ ok: false, why: 'error' }));
    if (!rf || rf.check.state !== 'checking' || rf.check.folder !== folder) {
      return; // the field changed meanwhile
    }
    rf.check = r.ok ? { state: r.exists && r.dir ? 'found' : 'missing', folder, path: r.path } : { state: 'unknown', folder, why: r.why };
    renderRecipeForm();
  },
  // "Set up this folder for <program>": only when the person clicks it; "Setting up…", then Ready or
  // "Couldn't set up ~/site. [Details]" with the step's output under Details
  setup: async () => {
    if (!rf || rf.setup.state === 'running') {
      return;
    }
    const row = acc.servers.find((x) => x.loginId === rf.loginId && !x.request);
    if (!row || !rf.programId) {
      return;
    }
    rf.setup = { state: 'running' };
    renderRecipeForm();
    const r = await window.wb.recipesSetup(row.id, rf.folder, rf.programId).catch((e) => ({ ok: false, why: 'error', message: String(e.message || e) }));
    if (!rf || rf.setup.state !== 'running') {
      return;
    }
    rf.setup = r && r.ok ? { state: 'ready', output: r.output || '' } : { state: 'failed', why: (r && (r.message || r.why)) || '', output: (r && r.output) || '' };
    renderRecipeForm();
  },
  setupDetails: () => {
    if (rf) {
      rf.setup = { ...rf.setup, open: !rf.setup.open };
      renderRecipeForm();
    }
  },
  save: async () => {
    if (!rf || rf.saving) {
      return;
    }
    const local = rf.loginId === 'local';
    const form=rf,saveEpoch=accountEpoch,saveView=rf.parityView;
    if(form.logoBusy||form.folderPickerState?.busy)return;
    const parityFields=form.parityEnabled===true?parityPatch(form):{};
    if(parityFields.error){accountsSnackbar(parityFields.error);return;}
    const folderFields=local&&typeof window.wb.recipesFolderForm==='function'?rf.folderPicker?.saveFields():{};
    if(local&&!folderFields)return;
    // a login asked for from this form counts: the recipe saves now and starts once it's approved
    const row = local ? null : acc.servers.find((x) => x.loginId === rf.loginId);
    const program = rf.programId === 'custom' ? { id: 'custom', label: 'Custom command' } : sx.programs.find((p) => p.id === rf.programId);
    if ((!row && !local) || !program) {
      return;
    }
    rf.saving = true;
    renderRecipeForm();
    const r = await window.wb.recipesSave({
      ...folderFields,
      id: rf.id || undefined,
      name: rf.name,
      loginId: rf.loginId,
      serverId: local ? null : row.serverId,
      folder: rf.folder,
      programId: rf.programId,
      command: rf.command || '',
      options: rf.options,
      color: rf.color,
      where: local ? (globalThis.wb && globalThis.wb.web ? 'This server' : 'This machine') : `${row.serverName} · ${row.login}`,
      programLabel: program.label,
      ...parityFields,
    }).catch((e) => ({ error: String(e.message || e) }));
    if(rf!==form||accountEpoch!==saveEpoch||form.parityView!==saveView||settingsPage!=='recipe:'+form.forId||$('settingsPop').hidden)return;
    if (!r || r.error) {
      rf.saving = false;
      renderRecipeForm();
      accountsSnackbar(r && r.error ? r.error : "Couldn't save the recipe.");
      return;
    }
    rf = null;
    detour = null;
    closePops(); // the sheet closes
    accountsSnackbar("Saved. It's in the rail."+(form.parityEnabled===true&&typeof r.agent==='string'?' Agent slug: '+r.agent+'.':''), { action: { label: 'Start', fn: () => launchRecipe(r.id) } });
  },
  cancel: () => {
    if (rf && rf.dirty) {
      confirmDiscardRecipe();
      return;
    }
    rf = null;
    detour = null;
    closePops();
    recipesApply();
  },
  // the design's No dead ends (3c page, <commit>): a detour out of the form keeps what was typed and shows
  // "← Back to New recipe" at the top; Request access… comes back with the login asked for chosen
  requestAccess: () => detourTo('request'),
  openPrograms: () => detourTo('programs'),
  installHelp: (pid) => detourTo('prog:' + pid),
  install: (pid) => pageHandlers.install(pid), // 0.12.4: the picker's [Install] and the missing card's
  signIn: () => detourTo('accounts'),
  seedColor: (hue) => m3.palette(baseOf(hue)).primary,
};
let detour = null; // { from: 'recipe:new' | 'recipe:<id>', name }
function rfPage() {
  return 'recipe:' + (rf && rf.id ? rf.id : 'new');
}
function detourTo(page) {
  detour = rf ? { from: rfPage(), name: rf.id ? (recipeList.find((x) => x.id === rf.id) || {}).name || 'the recipe' : 'New recipe' } : null;
  if (page === 'request') {
    openRequest();
  } else {
    openSettings(page);
  }
}
/** Back from the request page to the form, with the login asked for already chosen. */
function returnFromRequest() {
  const picked = [...rq.picked][0];
  if (picked && rf) {
    rf.loginId = picked;
    rf.dirty = true;
    rf.check = { state: 'idle' };
  }
  const from = detour.from;
  openSettings(from);
}
/** "1 recipe not saved · Finish" under the rail's RECIPES header: a half-done recipe you closed is kept. */
function unsavedView() {
  return rf && rf.dirty && $('settingsPop').hidden ? { label: '1 recipe not saved', link: 'Finish', fn: () => openSettings(rfPage()) } : null;
}
/** Esc with changes: "Discard this recipe?" [Keep editing] [Discard] */
function confirmDiscardRecipe() {
  const back = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'end-dlg';
  const d = document.createElement('div');
  d.className = 'dlg';
  d.setAttribute('role', 'alertdialog');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-labelledby', 'rxT');
  d.innerHTML = icon('edit_off', 'ic') + '<h4 id="rxT">Discard this recipe?</h4><div class="a"><button class="cancel">Keep editing</button><button class="danger">Discard</button></div>';
  wrap.appendChild(d);
  document.body.appendChild(wrap);
  consoleSync(); // and under a dialog
  const close = () => {
    wrap.remove();
    consoleSync();
    if (back && back.isConnected) {
      back.focus();
    }
  };
  d.querySelector('.cancel').addEventListener('click', close);
  d.querySelector('.danger').addEventListener('click', () => {
    rf = null;
    detour = null;
    wrap.remove();
    consoleSync();
    closePops();
    recipesApply();
  });
  wrap.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      close();
    }
  });
  d.querySelector('.cancel').focus();
}

// ---- the Console tab (0.12.2, the lead , the design ; plan 3e, slice 1): the realm's
// console in a view main draws into .cs-top (a native view sits over the page, so it yields whenever a
// sheet, the flyout, a dialog or the floating rail is open); the terminal link from the console opens
// one SSH pane under it, split top/bottom at 55/45 with a 10 px grip, each part at least 160 px.
function consoleTabs() {
  const out = [];
  if (scratchpadPage) out.push({ id: 'scratchpad', mod: 'core', label: 'Scratchpad', icon: 'sticky_note_2', surface: 'scratchpad' });
  if (window.wb.web) return out; // web: one node per person, so no Codex, Servers or Console tab
  if (codexAvailable) out.push({ id: 'codex', mod: 'core', label: 'Codex', icon: 'chat', surface: 'codex' });
  // Local rooms and Add a server are available without an account (master spec B2.2).
  out.push({ id: 'servers', mod: 'core', label: 'Servers', icon: 'dns', surface: 'servers' });
  if (signedIn() && acc.st.account && acc.st.account.admin) {
    out.push({ id: 'console', mod: 'core', label: 'Console', icon: 'admin_panel_settings', surface: 'console' });
  }
  return out;
}
function consoleBounds() {
  const r = cs.top.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}
function overlayOpen() {
  return !$('settingsPop').hidden || !$('flyout').hidden || !!document.querySelector('.end-dlg') || !!(rail && rail.isOpen() && !rail.isPinned());
}
/** The view shows exactly when the Console tab is up and nothing of the page is over it. */
function consoleSync() {
  if (!cs.el) {
    return;
  }
  if (cs.on && !overlayOpen()) {
    window.wb.consoleOpen(consoleBounds(), m3.isDark() ? 'dark' : 'light').then((r) => {
      if (!r || !r.ok) {
        consoleMsg('Sign in to an account to open its console.');
      }
    });
  } else {
    window.wb.consoleHide();
  }
}
function consoleMsg(text, action) {
  cs.msg.textContent = '';
  if (!text) {
    cs.msg.hidden = true;
    return;
  }
  const line = document.createElement('span');
  line.textContent = text;
  cs.msg.appendChild(line);
  if (action) {
    const b = document.createElement('button');
    b.className = 'ac-btn tonal';
    b.textContent = action.label;
    b.addEventListener('click', action.fn);
    cs.msg.appendChild(b);
  }
  cs.msg.hidden = false;
}
function consoleSurface(on) {
  cs.on = on;
  cs.el.hidden = !on;
  if (on) {
    if (!cs.ro) {
      cs.ro = new ResizeObserver(() => {
        if (cs.on) {
          window.wb.consoleBounds(consoleBounds());
        }
      });
      cs.ro.observe(cs.top);
    }
    consoleSync();
    if (cs.sid != null && tabs.has(cs.sid)) {
      activate(cs.sid);
    }
  } else {
    window.wb.consoleHide();
    consoleHandoff(false); // the hand-off strip lasts until it's dismissed or the tab is left
  }
}
function consoleMount(sid, opts) {
  cs.sid = sid;
  cs.serverId = opts.spec ? opts.spec.serverId : null;
  cs.name = opts.consoleName || '';
  cs.login = opts.consoleLogin || '';
  cs.pane.textContent = '';
  cs.pane.appendChild(buildCliPane(sid));
  refreshPaneChrome(); // the new pane's title bar (name, ring, its ✕) is painted now, not at the next refresh
  cs.el.classList.add('split');
  cs.el.style.setProperty('--cs-top', Math.round(cs.frac * 100) + '%');
  cs.div.hidden = false;
  cs.pane.hidden = false;
  consoleSync();
}
function consoleUnmount(sid) {
  const p = paneEls.get(sid);
  if (p) {
    p.remove();
  }
  paneEls.delete(sid);
  if (cs.sid === sid) {
    cs.sid = null;
    cs.serverId = null;
    cs.el.classList.remove('split'); // the console returns to full height
    cs.div.hidden = true;
    cs.pane.hidden = true;
    consoleSync();
  }
}
/** The terminal link, confirmed by the realm: one terminal per tab; the same link focuses it, another
 *  login asks to replace it. */
async function openConsoleTerminal({ serverId, name, login }) {
  if (cs.sid != null && tabs.has(cs.sid)) {
    if (cs.serverId === serverId) {
      activate(cs.sid);
      return;
    }
    const ok = await askDialog({ icon: 'swap_horiz', title: `Replace the terminal to ${cs.name} as ${cs.login} with one as ${login}?`, body: '', cancel: 'Cancel', confirm: 'Replace' });
    if (!ok) {
      return;
    }
    endSession(cs.sid);
  }
  await launch({ spec: { route: 'ssh', serverId }, name: `${name} · ${login}`, host: 'console', consoleName: name, consoleLogin: login, why: 'console-terminal' });
  modules.setSurface('console');
}
/** ✕ on the terminal: at a prompt it closes at once; while something runs it asks. */
async function closeConsoleTerminal(sid) {
  const s = sessionList.find((x) => x.sid === sid);
  if (s && s.flowing) {
    const ok = await askDialog({ icon: 'cancel', title: `Close the terminal to ${cs.name}?`, body: "What's running there stops.", cancel: 'Cancel', confirm: 'Close', danger: true });
    if (!ok) {
      return;
    }
  }
  endSession(sid);
}
/** A small confirm in the end-dialog's shape, resolving true on the confirming button. */
function askDialog({ icon: ic, title, body, cancel, confirm, danger }) {
  return new Promise((resolve) => {
    const back = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'end-dlg';
    const d = document.createElement('div');
    d.className = 'dlg';
    d.setAttribute('role', 'alertdialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = icon(ic, 'ic') + '<h4></h4><p></p><div class="a"><button class="cancel"></button><button class="' + (danger ? 'danger' : 'primary') + '"></button></div>';
    d.querySelector('h4').textContent = title;
    d.querySelector('p').textContent = body || '';
    d.querySelector('p').hidden = !body;
    d.querySelector('.cancel').textContent = cancel;
    d.querySelector('.a button:last-child').textContent = confirm;
    wrap.appendChild(d);
    document.body.appendChild(wrap);
    consoleSync(); // and under a dialog
  consoleSync(); // and under a dialog
    consoleSync();
    const close = (v) => {
      wrap.remove();
      consoleSync();
    consoleSync();
      consoleSync();
      if (back && back.isConnected) {
        back.focus();
      }
      resolve(v);
    };
    d.querySelector('.cancel').addEventListener('click', () => close(false));
    d.querySelector('.a button:last-child').addEventListener('click', () => close(true));
    wrap.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        close(false);
      }
    });
    d.querySelector('.cancel').focus();
  });
}
// the split's grip: drag resizes, double-click resets to 55/45, each part keeps at least 160 px
cs.div.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const box = cs.el.getBoundingClientRect();
  const move = (ev) => {
    const h = box.height - 10;
    const min = Math.min(160, h / 2);
    const top = Math.max(min, Math.min(h - min, ev.clientY - box.top - 5));
    cs.frac = top / h;
    cs.el.style.setProperty('--cs-top', Math.round(cs.frac * 1000) / 10 + '%');
  };
  const up = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    fitAll();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
});
cs.div.addEventListener('dblclick', () => {
  cs.frac = 0.55;
  cs.el.style.setProperty('--cs-top', '55%');
  fitAll();
});
// 3d (): a passkey ceremony in the console went to the system browser: a strip over the console says so,
// until it's dismissed or the tab is left
function consoleHandoff(on) {
  const h = cs.el.querySelector('.cs-hand');
  h.textContent = '';
  h.hidden = !on;
  if (on) {
    h.insertAdjacentHTML('beforeend', icon('open_in_browser'));
    const tx = document.createElement('span');
    tx.className = 'tx';
    const b = document.createElement('b');
    b.textContent = 'Continue in your browser';
    tx.append(b, document.createTextNode(' Finish the passkey step there, then come back. This page updates when you do.')); // the design 
    const again = document.createElement('button');
    again.className = 'ac-btn text';
    again.textContent = 'Open it again';
    again.addEventListener('click', () => window.wb.consoleHandoffAgain());
    const x = document.createElement('button');
    x.className = 'x';
    x.title = 'Dismiss';
    x.setAttribute('aria-label', 'Dismiss');
    x.insertAdjacentHTML('beforeend', icon('close'));
    x.addEventListener('click', () => consoleHandoff(false));
    h.append(tx, again, x);
  }
  if (cs.on) {
    consoleSync(); // the view's slot moved under the strip
  }
}
window.wb.on('console:state', ({ state, host }) => {
  cs.host = host || cs.host;
  if (state === 'handoff') {
    consoleHandoff(true);
    return;
  }
  if (state === 'cant-load') {
    consoleMsg(`Can't reach ${cs.host}.`, { label: 'Try again', fn: () => window.wb.consoleReload() });
  } else {
    consoleMsg('');
  }
});
window.wb.on('console:terminal', (p) => openConsoleTerminal(p));
window.wb.on('console:terminal-refused', ({ server, login }) => {
  accountsSnackbar(`Can't open a terminal: ${server} · ${login} isn't on your account.`);
});

// Settings pages read Programs, This machine and the preferences from main first (a few ms).
function openSettings(page, recipeFolderRole = 'agents') {
  if (page === 'recipe:new' && window.wb.web?.agents) { window.wb.web.agents.open(); return; }
  loadSettingsData()
    .catch(() => {})
    .then(() => {
      if (page === 'recipe:new' && !rf?.dirty && !detour) {
        rf = null;
        openRecipeForm(null, recipeFolderRole, true);
      }
      showSettings(page);
    });
}

function showSettings(page) {
  settingsPage = pageInfo(page) ? page : 'global';
  if (settingsPage === 'pane' && !tabs.get(activeSid)) {
    settingsPage = 'global';
  }
  fillSettings();
  fillAppearance();
  fillConcierge();
  fillGlobal();
  const section = settingsPage.startsWith('mod:') ? 'module' : settingsPage.startsWith('prog:') ? 'program' : settingsPage.startsWith('srv:') ? 'server' : settingsPage.startsWith('recipe:') ? 'recipe' : settingsPage;
  // The recipe's native-folder registration requires a visible owning form.
  // Show it before its synchronous paint; retain that guard for late replies.
  if (section === 'recipe') $('settingsPop').hidden = false;
  renderPage(settingsPage);
  if (settingsPage === 'modules') {
    modules.renderModulesPage($('secModules'), window.wb.web?.files ? [] : [{ id: 'scratchpad', name: 'Scratchpad', icon: 'sticky_note_2',
      description: 'Notes and files. Choose where they are stored.', openSettings: () => openSettings('scratchpad') }]);
  } else if (section === 'message') {
    renderMessageSettings($('secMessage'));
  } else if (section === 'module') {
    modules.renderModuleSettings($('secModule'), settingsPage.slice(4));
  }
  renderCrumb();
  for (const sec of $('settingsPop').querySelectorAll('.sec[data-page]')) {
    sec.hidden = sec.dataset.page !== section;
  }
  $('settingsPop').hidden = false;
  consoleSync(); // and under the settings panel
  consoleSync();
  webNav?.render();
}

function renderCrumb() {
  const c = $('crumb');
  c.textContent = '';
  const chain = [];
  for (let key = pageInfo(settingsPage).parent; key; key = pageInfo(key).parent) {
    chain.unshift(key);
  }
  if (chain.length) {
    const path = document.createElement('div');
    path.className = 'path';
    for (const key of chain) {
      const up = document.createElement('button');
      up.className = 'up';
      up.textContent = pageInfo(key).name;
      up.title = 'Up to ' + pageInfo(key).name;
      up.addEventListener('click', () => openSettings(key));
      path.appendChild(up);
      path.insertAdjacentHTML('beforeend', icon('chevron_right'));
    }
    c.appendChild(path);
  }
  const cur = document.createElement('div');
  cur.className = 'cur';
  cur.textContent = pageInfo(settingsPage).name;
  c.appendChild(cur);
  if (detour && rf && !settingsPage.startsWith('recipe:')) {
    // the design's No dead ends: a bigger detour (Programs, Sign in) shows the way back, what was typed kept
    const back = document.createElement('button');
    back.className = 'crumb-back';
    back.type = 'button';
    back.innerHTML = icon('arrow_back');
    back.appendChild(document.createTextNode('Back to ' + detour.name));
    back.addEventListener('click', () => openSettings(detour.from));
    c.prepend(back);
  }
}

/** Settings > Message box (web): one switch for Enter, saved per person and the same in every window. */
function renderMessageSettings(sec) {
  sec.textContent = '';
  const pref = roomsPage?.enterPref;
  const on = !pref || pref.get() !== false;
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('div');
  label.className = 'lbl';
  label.textContent = 'Enter sends the message';
  const sw = document.createElement('button');
  sw.type = 'button'; sw.className = 'pg-sw' + (on ? ' on' : '');
  sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(on)); sw.setAttribute('aria-label', 'Enter sends the message');
  sw.dataset.wbTest = 'enter-sends-switch';
  sw.addEventListener('click', async () => {
    sw.disabled = true;
    if (pref) await pref.set(!(pref.get() !== false));
    renderMessageSettings(sec);
    fillGlobal();
  });
  row.append(label, sw);
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const help = document.createElement('div');
  help.className = 'hint'; help.dataset.wbTest = 'enter-sends-help';
  help.textContent = 'On: Enter sends and Shift+Enter starts a new line. Off: Enter starts a new line and Ctrl+Enter sends (⌘+Enter on a Mac).' + (touch ? ' On a phone, turn it off if you want the keyboard\'s Return key to start a new line.' : '');
  sec.append(row, help);
}
function fillGlobal() {
  const ms = modules.moduleList();
  $('gsModulesV').textContent = ms.filter((m) => m.effective).length + ' on';
  if ($('gsMessageV')) $('gsMessageV').textContent = roomsPage?.enterPref?.get() === false ? 'Enter starts a new line' : 'Enter sends';
  $('gsProgramsV').textContent = sx.programs.filter((p) => p.enabled).length + ' on';
  const n = sx.prefs?.notify || {};
  $('gsNotifyV').textContent = window.wb.web?.notifications ? window.wb.web.notifications.summary(n) : n.toast ? (n.flash ? 'Flash + notification' : 'Notification') : n.flash ? 'Flash' : 'Off';
  $('devmode').checked = !!sx.prefs?.developer;
}
$('gsModules').addEventListener('click', () => openSettings('modules'));
if (window.wb.web) { // the web build calls Modules "Tools" and lists it first in Settings (the design s9)
  const toolsRow = $('gsModules');
  toolsRow.querySelector('.nl').textContent = 'Tools';
  toolsRow.parentElement.prepend(toolsRow);
  // "Message box": the second row, after Tools; one switch, "Enter sends the message"
  const msgRow = document.createElement('button');
  msgRow.className = 'navrow'; msgRow.id = 'gsMessage';
  msgRow.innerHTML = '<span class="ms" aria-hidden="true">keyboard</span><span class="nl">Message box</span><span class="nv" id="gsMessageV"></span><span class="ms" aria-hidden="true">chevron_right</span>';
  toolsRow.after(msgRow);
  msgRow.addEventListener('click', () => openSettings('message'));
}
$('gsConcierge').addEventListener('click', () => openSettings('concierge'));
$('gsServers').addEventListener('click', () => openSettings('servers'));
$('gsAccounts').addEventListener('click', () => openSettings('accounts'));
$('gsScratchpad').addEventListener('click', () => openSettings('scratchpad'));
pages.configureAppsLink($('gsApps'), !!window.wb?.web, openSettings);
window.wb.on('rooms:status', status => appsSettings?.receive(status));
window.wb.on('accounts:changed', () => { appsSettings?.accountChanged(); if (settingsPage === 'apps' && !$('settingsPop').hidden) void appsSettings?.open(); });
$('gsFiles').addEventListener('click', () => openSettings('files'));
$('gsChatHistory').addEventListener('click', () => openSettings('chat-history'));
window.wb.on('scratchpad:changed', event => {
  scratchpadPage?.changed(event || {});
  if (event?.locationChanged) scratchpadSettings?.changed();
  else if (scratchpadSettings && !$('settingsPop').hidden && settingsPage === 'scratchpad') void scratchpadSettings.refresh();
});
window.wb.on('accounts:servers', (v) => {
  if (v?.accountId && v.accountId !== acc.st?.account?.id) return;
  if (!acc.present) {
    return;
  }
  acc.servers = (v && v.rows) || [];
  if (acc.st && acc.st.account) {
    rail.setServers(acc.servers);
    recipesApply();
  }
  // the pages that show the same list follow it
  if (!$('settingsPop').hidden && (settingsPage === 'servers' || settingsPage.startsWith('srv:'))) {
    renderPage(settingsPage);
  }
});
window.wb.on('accounts:changed', (st) => {
  if (!acc.present) {
    return;
  }
  const had = acc.st;
  acc.st = st;
  if (had?.account?.id !== st.account?.id || had?.selectionVersion !== st.selectionVersion) {
    accountEpoch++;
    modules.epochsChanged(); // Tasks seam S1: cards bound to the old account are stale; re-send rooms.shown
    conciergeToggle(false);
    conciergeDispose();
    paintReloadStrip({ state: 'idle' });
    document.querySelectorAll('[data-concierge-dialog], .cg-menu').forEach(d => d.remove());
    sx.prefs = null;
    window.wb.prefsGet().then(p => {
      if (acceptPrefs(p) && settingsPage === 'concierge' && !$('settingsPop').hidden) renderConciergeWhat();
    }).catch(() => {});
    scratchpadPage?.accountChanged();
    scratchpadSettings?.accountChanged();
    const epoch = accountEpoch;
    acc.servers = []; recipeKnown = []; recipeList = []; recipeSynced = false;
    brokerGroups = [];
    groupMemory.clear(); dismissedEnded.clear();
    rail?.setOffer({ offer: null, recent: [] }); rail?.setRestoring(null);
    document.querySelectorAll('[data-account-dialog=history]').forEach((d) => d.remove());
    serversPage?.paint();
    window.wb.sessions.offer().then(applyOfferView).catch(() => {});
    acc.ui.step = null;
    rq.servers = null; rq.picked = new Set(); rq.note = ''; rq.error = null;
    rf = null;
    accountsRefresh();
    window.wb.recipesList().then((list) => { if (epoch === accountEpoch) { recipeList = list || []; recipesApply(); } });
    if (!$('settingsPop').hidden && (settingsPage.startsWith('recipe:') || settingsPage === 'request' || settingsPage.startsWith('srv:'))) openSettings('accounts');
  }
  if (had && had.flow && !st.flow && !st.account) {
    acc.ui.step = 'address'; // a wait that ended goes back to the address step, address kept
  }
  if (!st.account && had && had.account) {
    acc.ui.step = null; // signed out: the card becomes "No account yet"
  }
  if (st.flow && st.flow.phase !== 'name') {
    acc.ui.name = null;
    acc.ui.nameError = null;
  }
  accountsApply();
});
window.wb.on('accounts:signed-in', ({ wid, text }) => {
  acc.ui = { step: null, address: null, error: null, busy: false, focus: null, name: null, nameError: null };
  if (wid === myWid) {
    // F13: the sheet closes, open panes stay where they were, one snackbar says so
    $('settingsPop').hidden = true;
    accountsSnackbar(text);
  }
});
window.wb.on('accounts:link', ({ address }) => {
  // a workbench://enroll link fills the address; focus on Continue; it never starts sign-in
  if (!acc.present) {
    return;
  }
  acc.ui.step = 'address';
  acc.ui.address = address;
  acc.ui.error = null;
  acc.ui.focus = 'continue';
  closePops();
  openSettings('accounts');
});
$('gsPrograms').addEventListener('click', () => openSettings('programs'));
$('gsNotify').addEventListener('click', () => openSettings('notifications'));
$('gsAbout').addEventListener('click', () => openSettings('about'));
function conciergeScopeCurrent(scope) {
  const now = window.wb.rooms.scope();
  return !!scope && scope.accountId === now.accountId && scope.selectionVersion === now.selectionVersion;
}
function acceptPrefs(p) {
  if (!p || p.error || !conciergeScopeCurrent(p.conciergeScope)) return false;
  sx.prefs = p;
  return true;
}
window.wb.on('prefs:changed', p => acceptPrefs(p));

// The module list changed (a toggle or setting here or in another window): refresh the page
// that shows it, unless the user is typing into it right now.
function settingsModulesChanged() {
  if ($('settingsPop').hidden) {
    return;
  }
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT' && $('settingsPop').contains(document.activeElement);
  if (!typing && (settingsPage === 'global' || settingsPage === 'modules' || settingsPage.startsWith('mod:'))) {
    openSettings(settingsPage);
  }
}

function fillConcierge() {
  $('concW').value = conc.w;
  $('concWV').textContent = conc.w + 'px';
  renderConciergeWhat();
}

// Concierge settings reuse the recipe picker. Each window/account chooses explicitly;
// changing a choice leaves its live session running until a deliberate restart.
// Step 4 (D2): "Remember its session" is live, on by default, for a recipe whose program can resume (Claude Code).
// D3 (PM ): "Reload when stuck", off by default, needs it; on, it shows the minutes (1 to 60, starts at 5).
function conciergeRecipe() {
  const id = sx.prefs && sx.prefs.conciergeRecipe;
  return id ? recipeList.find((r) => r.id === id) || null : null;
}
function conciergeViewGuard(scope = sx.prefs?.conciergeScope) {
  const epoch = accountEpoch;
  return () => epoch === accountEpoch && conciergeScopeCurrent(scope);
}
function renderConciergeWhat() {
  const current = conciergeViewGuard();
  const host = $('concWhat');
  if (!host) {
    return;
  }
  host.textContent = '';
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) {
      n.className = cls;
    }
    if (text != null) {
      n.textContent = text;
    }
    return n;
  };
  const rc = conciergeRecipe();
  const rows = recipeRows(recipeList, { servers: acc.servers, programs: sx.programs, sessions: sessionList, known: recipeKnown });
  const view = rc ? rows.find((r) => r.id === rc.id) : null;
  const card = mk('div', 'cg-what');
  card.appendChild(mk('div', 'cg-h', 'What it runs'));
  const line = mk('div', 'cg-row');
  const tx = mk('div', 'cg-tx');
  tx.appendChild(mk('b', null, rc ? rc.name : 'Choose a recipe'));
  tx.appendChild(mk('small', null, rc ? (view ? view.line || view.where : '') : 'Choose what Concierge runs in this window and account.'));
  line.appendChild(tx);
  const change = mk('button', 'tonal cg-change', 'Change…');
  change.type = 'button';
  change.setAttribute('aria-haspopup', 'menu');
  change.addEventListener('click', () => { if (current()) conciergePicker(change, rows); });
  line.appendChild(change);
  card.appendChild(line);
  card.appendChild(mk('div', 'hint', 'This choice belongs to this window and account. A running Concierge changes only when you restart it.'));
  host.appendChild(card);
  const sw = (label, help, o) => {
    const r = mk('div', 'cg-sw');
    r.dataset.cg = o.key;
    const t = mk('div', 'cg-tx');
    t.appendChild(mk('b', null, label));
    t.appendChild(mk('small', null, help));
    if (o.why) {
      const why = mk('small', 'cg-why');
      if (o.future) {
        why.append(mk('span', 'cg-future', 'FUTURE'), document.createTextNode(' ')); // the design : the FUTURE chip
      }
      why.append(document.createTextNode(o.why));
      t.appendChild(why);
    }
    const b = mk('button', 'pg-sw');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(!!o.on));
    b.classList.toggle('on', !!o.on); // the switch draws from .on, like the program page's
    b.setAttribute('aria-label', label);
    b.disabled = !o.onToggle;
    if (o.why) {
      b.title = o.why;
    }
    if (o.onToggle) {
      b.addEventListener('click', () => { if (current()) o.onToggle(b.getAttribute('aria-checked') !== 'true'); });
    }
    r.append(t, b);
    host.appendChild(r);
  };
  // the switch is real only when what it runs can resume: a shell has no conversation to reopen
  const resumable = !!(rc && ((sx.programs || []).find((p) => p.id === rc.programId) || {}).resumable);
  const remember = !sx.prefs || sx.prefs.conciergeRemember !== false;
  sw('Remember its session', 'Reopens the same conversation after a restart or a crash.', resumable
    ? { key: 'remember', on: remember, onToggle: async (on) => { if (acceptPrefs(await window.wb.prefsSet({ conciergeRemember: on }))) renderConciergeWhat(); } }
    : { key: 'remember', on: false, why: rc ? 'Only for a program that keeps conversations, like Claude Code.' : 'Choose a recipe whose program keeps conversations, like Claude Code.' });
  const p = sx.prefs || {};
  const canReload = resumable && remember;
  const reloadOn = canReload && p.conciergeReload === true;
  const mins = Number(p.conciergeReloadMin) || 5;
  sw('Reload when stuck', reloadOn
    ? 'If it is working but prints nothing for the time below, restart it and pick up its saved session. It only counts while it is working. If you are typing, it waits until you stop, and your text stays.'
    : 'If it is working but prints nothing for ' + mins + (mins === 1 ? ' minute' : ' minutes') + ', restart it and pick up its saved session.', canReload
    ? { key: 'reload', on: reloadOn, why: reloadOn && p.conciergeReloadPaused ? 'Paused after 3 tries. Turn it off and on to start again.' : null, onToggle: async (on) => { if (acceptPrefs(await window.wb.prefsSet({ conciergeReload: on }))) renderConciergeWhat(); } }
    : { key: 'reload', on: false, why: 'Turn on Remember its session first.' });
  if (reloadOn) {
    // "No output for [5] minutes" under the switch (the design's p2)
    const row = host.querySelector('.cg-sw[data-cg=reload] .cg-tx');
    const f = mk('div', 'sub2');
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '1';
    inp.max = '60';
    inp.step = '1';
    inp.value = String(mins);
    inp.className = 'cg-min';
    inp.setAttribute('aria-label', 'Minutes with no output');
    const unit = document.createTextNode(mins === 1 ? 'minute' : 'minutes'); // the design  (2)
    inp.addEventListener('change', async () => {
      if (!current()) return;
      const v = Math.min(60, Math.max(1, Math.round(Number(inp.value) || 5)));
      inp.value = String(v);
      unit.textContent = v === 1 ? 'minute' : 'minutes';
      acceptPrefs(await window.wb.prefsSet({ conciergeReloadMin: v }));
    });
    f.append(document.createTextNode('No output for'), inp, unit);
    row.appendChild(f);
  }
}
// ---- D3 (the design's workbench-concierge-settings, "While it reloads"): the strip at the top of the Concierge.
// Main decides (conciergeReload in main.js); this draws what it says.
let reloadDismiss = null;
let reloadCancelEnd = null;
function paintReloadStrip(m) {
  const current = conciergeViewGuard(m);
  const host = $('dockStrip');
  clearTimeout(reloadDismiss);
  clearTimeout(reloadCancelEnd);
  host.textContent = '';
  const st = m && m.state;
  if (!st || st === 'idle') {
    host.hidden = true;
    return;
  }
  const n = Number(m.minutes) || 5;
  const W = {
    typing: ['go', 'keyboard', 'Waiting for you to stop typing', "It reloads once you've stopped for a minute. Your text stays.", []],
    reloading: ['go', 'autorenew', 'Reloading the Concierge', 'No output for ' + n + (n === 1 ? ' minute' : ' minutes') + '. Restarting it and picking up its session.', [['Cancel', 'cancel']]],
    restarting: ['go', 'autorenew', 'Reloading the Concierge', 'No output for ' + n + (n === 1 ? ' minute' : ' minutes') + '. Restarting it and picking up its session.', []],
    reloaded: ['ok', 'check_circle', 'Concierge reloaded', m.resumed ? 'It picked up your last conversation.' : "It started a new conversation because the last one couldn't be picked up.", [['Dismiss', 'dismiss']]], // the design  (1)
    failed: ['bad', 'error', "The Concierge didn't come back", 'Try again, or check its recipe in Settings › Concierge.', [['Open settings', 'settings'], ['Try again', 'retry']]],
    paused: ['bad', 'error', "The Concierge didn't come back", 'Reload when stuck is paused after 3 tries.', [['Open settings', 'settings'], ['Try again', 'retry']]],
  }[st];
  if (!W) {
    host.hidden = true;
    return;
  }
  const bar = document.createElement('div');
  bar.className = 'cstrip ' + W[0];
  bar.dataset.st = st;
  bar.setAttribute('role', 'status');
  bar.innerHTML = icon(W[1]);
  const t = document.createElement('span');
  t.className = 't';
  const b = document.createElement('b');
  b.textContent = W[2];
  t.append(b, document.createTextNode(W[3]));
  bar.appendChild(t);
  const btns = document.createElement('span');
  btns.className = 'cbtns';
  bar.appendChild(btns);
  for (const [label, act] of W[4]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.dataset.act = act;
    if (act === 'retry') {
      btn.className = 'err';
    }
    btn.addEventListener('click', () => {
      if (!current()) return;
      if (act === 'settings') {
        openSettings('concierge');
      } else {
        window.wb.conciergeReload(act);
      }
    });
    btns.appendChild(btn);
  }
  host.appendChild(bar);
  if (st === 'reloading' || st === 'restarting') {
    const prog = document.createElement('div');
    prog.className = 'cprog';
    prog.appendChild(document.createElement('i'));
    host.appendChild(prog);
  }
  host.hidden = false;
  if (st === 'reloading') {
    // [Cancel] only for the first 5 s
    reloadCancelEnd = setTimeout(() => {
      const c = host.querySelector('[data-act=cancel]');
      if (c) {
        c.remove();
      }
    }, 5000);
  }
  if (st === 'reloaded') {
    reloadDismiss = setTimeout(() => { if (current()) window.wb.conciergeReload('dismiss'); }, 8000); // dismisses itself after 8 s
  }
  conciergeFit();
}
window.wb.on('concierge:reload', m => { if (conciergeScopeCurrent(m)) paintReloadStrip(m); });

function conciergePicker(anchor, rows) {
  const current = conciergeViewGuard();
  document.querySelectorAll('.cg-menu').forEach((n) => n.remove());
  const m = document.createElement('div');
  m.className = 'rail-menu nm-menu cg-menu';
  m.setAttribute('role', 'menu');
  const cur = (sx.prefs && sx.prefs.conciergeRecipe) || null;
  const item = (id, label, hint, ok) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rm-i nm-i' + (ok ? '' : ' cant');
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(id === cur));
    b.innerHTML = icon(id === cur ? 'radio_button_checked' : 'radio_button_unchecked');
    const l = document.createElement('span');
    l.className = 'nm-l';
    l.textContent = label;
    const h = document.createElement('span');
    h.className = 'nm-h';
    h.textContent = hint || '';
    b.append(l, h);
    b.dataset.cg = id || '';
    b.addEventListener('click', () => {
      m.remove();
      if (current() && id !== cur) {
        setConciergeRecipe(id, label);
      }
    });
    m.appendChild(b);
  };
  for (const v of rows) {
    item(v.id, v.name, v.canStart ? v.where : v.line || v.where, v.canStart);
  }
  const manage = document.createElement('button');
  manage.className = 'rm-i nm-i'; manage.textContent = rows.length ? 'Manage recipes…' : 'Create a recipe…';
  manage.addEventListener('click', () => { m.remove(); if (current()) openSettings(rows.length ? 'recipes' : 'recipe:new', 'concierge'); });
  m.appendChild(manage);
  document.body.appendChild(m);
  const b = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, Math.round(b.left))) + 'px';
  m.style.top = Math.round(Math.min(window.innerHeight - m.offsetHeight - 8, b.bottom + 4)) + 'px';
  const away = (e) => {
    if (!m.contains(e.target)) {
      m.remove();
      document.removeEventListener('pointerdown', away, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  const first = m.querySelector('button');
  if (first) {
    first.focus();
  }
}
async function setConciergeRecipe(id, label) {
  const epoch = conc.epoch, sid = conc.sid;
  if (!acceptPrefs(await window.wb.prefsSet({ conciergeRecipe: id || null })) || epoch !== conc.epoch) return;
  renderConciergeWhat();
  if (!sid) {
    if (conc.open) conciergePrompt('ready');
    return; // the visible Start Concierge button is explicit; settings never start a CLI
  }
  // "Restart the Concierge to use <name>?" [Not now] [Restart]
  const wrap = document.createElement('div');
  wrap.className = 'end-dlg';
  wrap.dataset.conciergeDialog = 'restart';
  const d = document.createElement('div');
  d.className = 'dlg';
  d.setAttribute('role', 'alertdialog');
  d.setAttribute('aria-modal', 'true');
  d.innerHTML = icon('restart_alt', 'ic') + '<h4></h4><p>It keeps running what it runs now until it restarts.</p><div class="a"><button class="cancel">Not now</button><button class="go">Restart</button></div>';
  d.querySelector('h4').textContent = 'Restart the Concierge to use ' + label + '?';
  wrap.appendChild(d);
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  d.querySelector('.cancel').addEventListener('click', close);
  d.querySelector('.go').addEventListener('click', () => {
    close();
    if (epoch === conc.epoch && sid === conc.sid) {
      window.wb.closeSession(sid); // its exit starts the chosen recipe only in the same account/window
    }
  });
  d.querySelector('.go').focus();
}
$('concW').addEventListener('input', (e) => {
  conc.w = Number(e.target.value);
  $('concWV').textContent = conc.w + 'px';
  dockEl.style.setProperty('--dock-w', conc.w + 'px');
});

function fillSettings() {
  const t = tabs.get(activeSid);
  if (!t) {
    return;
  }
  $('tabName').value = t.name;
  $('tabName').placeholder = niceTitle(t.title);
  $('hue').value = t.hue;
  const sw = $('swatches');
  if (!sw.children.length) {
    for (const h of SAMPLE_HUES) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.dataset.hue = h;
      b.style.setProperty('--sw', baseOf(h));
      b.title = 'Hue ' + h;
      sw.appendChild(b);
    }
  }
  for (const b of sw.children) {
    b.classList.toggle('on', Number(b.dataset.hue) === t.hue);
  }
}

function setTabHue(h) {
  const t = tabs.get(activeSid);
  if (!t) {
    return;
  }
  t.hue = h;
  t.term.options.theme = themeFor(h);
  renderTabs();
  fillSettings();
  sendMeta(t);
}

$('hue').addEventListener('input', (e) => setTabHue(Number(e.target.value)));
$('swatches').addEventListener('click', (e) => {
  const b = e.target.closest('.swatch');
  if (b) {
    setTabHue(Number(b.dataset.hue));
  }
});
$('tabName').addEventListener('input', (e) => {
  const t = tabs.get(activeSid);
  if (t) {
    t.name = e.target.value;
    renderTabs();
    sendMeta(t);
  }
});
$('tabName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.target.blur();
    const t = tabs.get(activeSid);
    if (t) {
      t.term.focus();
    }
  }
});
$('settingsClose').addEventListener('click', () => closePops());

// ---- appearance (global: every window, every pane)
const ap = {
  theme: $('apTheme'),
  color: $('apColor'),
  style: $('apStyle'),
  contrast: $('apContrast'),
  tint: $('apTint'),
};
function fillAppearance() {
  const a = m3.get();
  for (const b of ap.theme.children) {
    b.setAttribute('aria-pressed', String(b.dataset.v === a.theme));
  }
  for (const b of ap.contrast.children) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.v) === Number(a.contrast)));
  }
  ap.color.value = a.color.toLowerCase();
  ap.style.value = a.style;
  ap.tint.value = a.tint;
  $('apTintV').textContent = a.tint + '%';
}
if (!ap.style.options.length) {
  for (const n of m3.STYLES) {
    ap.style.add(new Option(n === 'TonalSpot' ? 'Tonal spot' : n === 'FruitSalad' ? 'Fruit salad' : n, n));
  }
}
ap.theme.addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (b) {
    m3.set({ theme: b.dataset.v });
  }
});
ap.contrast.addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (b) {
    m3.set({ contrast: Number(b.dataset.v) });
  }
});
ap.color.addEventListener('input', (e) => m3.set({ color: e.target.value.toUpperCase() }));
ap.style.addEventListener('change', (e) => m3.set({ style: e.target.value }));
ap.tint.addEventListener('input', (e) => m3.set({ tint: Number(e.target.value) }));

// Native frame follows the same global choice, including system mode.
const syncNativeTheme = () => window.wb.windowTheme(m3.get().theme);

// Any appearance change (here or in another window): recolor system chrome, panes, terminals.
m3.onChange(() => {
  m3.applySystem();
  refreshUserPicturePalettes();
  syncNativeTheme();
  for (const t of tabs.values()) {
    t.term.options.theme = themeFor(t.hue);
  }
  refresh(false);
  fillAppearance();
  modules.themeChanged(); // tool frames hear the new roles (the design notes §5)
  roomsPage?.themeChanged(); // S4 step 6: the Workrooms tool pages too
  window.wb.moduleTheme?.(modules.themeMessage().roles); // S3: and the module windows (main checks the roles again)
  appsSettings?.themeChanged();
  refreshColorSwatches();
  consoleSync(); // 0.12.5: the Console tab's page follows the app's theme (embed=1&theme=)
});
m3.applySystem();
window.wb.moduleTheme?.(modules.themeMessage().roles); // S3: module windows start with the current roles
syncNativeTheme();
fillAppearance();
$('dbg').addEventListener('change', (e) => window.wb.setDebug(e.target.checked));
$('devmode').addEventListener('change', (e) => setPrefs({ developer: e.target.checked }));
// the web pilot has no developer mode (lead's ruling on the design's walk, k): the Developer switch and its line are not
// on the web build's Settings at all; a developer mode, if ever wanted, comes after the pilot
if (window.wb.web) for (const e of [$('devmode').closest('label'), $('devmode').closest('label')?.nextElementSibling]) if (e) e.style.display = 'none';

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.pop') && !e.target.closest('#burger')) {
    $('flyout').hidden = true;
  }
});

// ---------------------------------------------------------------- window controls & keys

// the edge flags open as the pointer nears them (0.12.3, the design , 2–3)
const edges = edgeFlags([{ el: rail.flag, side: 'left' }, { el: $('dockTab'), side: 'right' }]);
// 0.19.0 (the owner ): the empty page's [New CLI] opens the same menu as IN THIS WINDOW +
$('emptyNew').addEventListener('click', () => (rail ? rail.openNewMenu($('emptyNew')) : launch()));
$('emptyList').addEventListener('click', () => rail && rail.toggle());

for (const b of root.querySelectorAll('.hwb-cap')) {
  b.addEventListener('click', () => {
    const k = b.dataset.cap;
    if (k === 'minimize') {
      window.wb.minimize();
    } else if (k === 'maximize') {
      window.wb.maximize();
    } else {
      window.wb.close();
    }
  });
}

document.addEventListener(
  'keydown',
  (e) => {
    const t = tabs.get(activeSid);
    if (e.key === 'Escape') {
      if (!$('settingsPop').hidden && settingsPage.startsWith('recipe:')) {
        // the design's No dead ends (<commit>): a half-done recipe you close is kept, the rail says
        // "1 recipe not saved · Finish"; Cancel is the explicit way to discard
        if (!(rf && rf.dirty)) {
          rf = null;
          detour = null;
        }
        closePops();
        recipesApply();
        return;
      }
      closePops();
    }
    if (!e.ctrlKey || !e.shiftKey) {
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 't') {
      launch();
    } else if (t && k === 'w') {
      hideTab(activeSid);
    } else if (t && k === 'c') {
      copySelection(t);
    } else if (t && k === 'v') {
      pasteInto(t);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  },
  true
);

new ResizeObserver(() => {
  if (mode === 'tabs') {
    const t = tabs.get(activeSid);
    if (t) {
      t.fit.fit();
    }
  } else {
    fitAll();
  }
}).observe(stageEl);

// ---------------------------------------------------------------- diagnostics

function showDebug(d) {
  $('dbg').checked = d.on;
  $('dbgpath').textContent = d.on ? d.path : '';
}

// Report any main-thread stall >50ms in this window (only reaches disk if debug is on).
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      dbg('longtask', { ms: Math.round(e.duration) });
    }
  }).observe({ entryTypes: ['longtask'] });
} catch (e) {
  // longtask not supported: skip
}

// Test/debug hook for the hidden self test. Exposes no terminal content API beyond xterm itself.
window.__wb = {
  servers: () => (serversPage ? serversPage.state() : null), // 3e's self-test
  serversRefresh: () => (serversPage ? serversPage.refresh() : null),
  serversOpen: (id, tab) => (serversPage ? serversPage.openServer(id, tab) : null),
  routeOf: (sid) => routeStates.get(sid) || null,
  edges: () => edges,
  activate, // the self-test brings a pane to the front (tab mode shots)
  closePops,
  tabs,
  activeSid: () => activeSid,
  removeTabLocal,
  addTab,
  order: () => order.slice(),
  mode: () => mode,
  setMode,
  setPinned,
  hideTab,
  layoutJson: () => JSON.stringify(layout.tree),
  layoutDirty: () => layout.dirty,
  sessionList: () => sessionList,
  brokerGroups: () => brokerGroups,
  groupViews,
  recipeForm: () => rf,
  console: () => ({ hand: cs.el.querySelector('.cs-hand').hidden ? null : cs.el.querySelector('.cs-hand').innerText.replace(/\s+/g, ' ').trim(), on: cs.on, sid: cs.sid, serverId: cs.serverId, name: cs.name, login: cs.login, split: cs.el.classList.contains('split'), frac: cs.frac, msg: cs.msg.hidden ? null : cs.msg.textContent, tabs: consoleTabs().length }),
  openConsoleTerminal,
  stateSnapshot,
  restoreState,
  conc: () => conc,
  modules: modules.moduleList,
  surface: modules.currentSurface,
  setSurface: modules.setSurface,
  surfaceKind: modules.surfaceKind, // W3b's self-test: which surface shows
  hasPaneKind: modules.hasPaneKind,
  moduleCall: modules.callFor,
  setModuleEnabled: (id, on) => window.wb.moduleSet({ id, enabled: !!on }),
  // P3 tools: the registry as the Try surface sees it
  tools: modules.toolList,
  toolCall: modules.callTool,
  themeChanged: modules.themeChanged,
  // step 1 (dev flag): open a pane on a route, and read what its overlay shows
  openRoute: (route, serverId) => launch({ spec: { route, serverId } }),
  launch,
  routeState: (sid) => routeStates.get(sid) || null,
  lastLaunch: () => lastLaunch,
  holdSnackbar,
  // review captures: hold a route state on a pane (the words are the real code's; only the state is forced)
  forceRoute: (sid, st) => {
    routeStates.set(sid, { ...(routeStates.get(sid) || {}), ...st });
    applyRoute(sid);
  },
  setAppearance: (patch) => m3.set(patch),
  railFocus: (sid) => rail.focusRow(sid),
  coach: () => coachTip.shown(),
  aboutStage: (patch) => {
    Object.assign(about, patch.about || {});
    if (patch.info) {
      Object.assign(about.info, patch.info);
    }
    renderAboutPage();
  },
  showCoach,
  rail: () => rail,
  rooms: () => roomsPage, // W1: the Workrooms page's hand
  openSettings: (p) => openSettings(p),
  renderFlyout,
  accounts: () => ({ present: acc.present, st: acc.st, ui: { ...acc.ui }, servers: acc.servers }),
  accountsUi: (patch) => {
    Object.assign(acc.ui, patch);
    renderAccountsPage();
  },
};

// ---------------------------------------------------------------- Concierge tray
// One shell for the whole app, docked at the right edge of whichever window opened it last: the
// handle opens a column spanning every row (the grid gives up its width), closing slides it back
// into the handle. Opening it in another window moves it there (scrollback comes along). It is not
// a tab or a pane: never listed, can't be dragged, ends with the app. Neutral white.

const CONC_SEED = '#9E9E9E';

// The header plate carries the same icon as the dock tab (#dockTab .concierge-icon), at the standard brand-mark size: 11 units of the
// plate's 24, so the status ring (r 7.2 units on a plate) clears it by 2 px or more on every side. Sized and centred from the path's own box.
const CONC_MARK_UNITS = 11;
function conciergeGlyph(ring) {
  const d = document.querySelector('#dockTab .concierge-icon path')?.getAttribute('d');
  const logo = ring?.querySelector('.rg-logo');
  if (!d || !logo) return;
  logo.setAttribute('d', d);
  const box = logo.getBBox(); // the path's own box in its viewBox units
  if (!box.width || !box.height) return;
  const scale = CONC_MARK_UNITS / Math.max(box.width, box.height);
  logo.parentNode.setAttribute('transform', 'translate(12 12) scale(' + +scale.toFixed(6) + ') translate(' + +(-(box.x + box.width / 2)).toFixed(3) + ' ' + +(-(box.y + box.height / 2)).toFixed(3) + ')');
}

function conciergePaint() {
  // The chrome (header band, .cg-what card, buttons, strip) reads the WINDOW's colour roles from :root, so it follows the app
  // scheme; the pane scopes no palette. Only the terminal body is neutral white (true greys, whatever the scheme does to a seed).
  const dark = m3.isDark();
  dockEl.style.setProperty('--term-bg', dark ? '#1b1b1b' : '#fcfcfc');
  const h = $('dockHead');
  const slotFocus = conciergeSlotView?.focusedId();
  conciergeSlotView?.dispose(); conciergeSlotView = null;
  fillBar(h, { name: 'Concierge', state: 'idle', ringSize: ringPx(), brand: BRAND, markPath: MARK });
  conciergeGlyph(h.querySelector('.pane-ring'));
  const plate = h.querySelector('.pane-ring');
  plate.title = 'Agent Concierge';
  plate.setAttribute('aria-label', 'Agent Concierge — ' + (plate.getAttribute('aria-label') || 'idle'));
  h.dataset.compact = String(conc.w <= 300);
  const gear = document.createElement('button');
  gear.className = 'sb-ib dock-gear';
  gear.title = 'Concierge settings';
  gear.setAttribute('aria-label', 'Concierge settings');
  gear.innerHTML = GEAR;
  gear.addEventListener('click', () => {
    closePops();
    openSettings('concierge');
  });
  const x = document.createElement('button');
  x.className = 'sb-ib px';
  x.title = 'Close Concierge (it keeps running)';
  x.innerHTML = icon('close');
  x.addEventListener('click', () => conciergeToggle(false));
  h.append(gear, x);
  if (conciergeLocalScope()) conciergeSlotView = mountConciergeSlots({ host: conciergeSlots, header: h, icon, before: gear, focusId: slotFocus, detailsBefore: $('dockBody') });
  if (conc.term) {
    conc.term.options.theme = conciergeTheme();
  }
}

function conciergeLocalScope() {
  if (conc.sid) return conc.route?.route === 'local' && conc.route?.serverId === 'local';
  const recipe = recipeList.find(r => r.id === sx.prefs?.conciergeRecipe);
  return !recipe || recipe.loginId === 'local';
}

function conciergeTheme() {
  return { ...m3.termTheme(CONC_SEED), background: m3.isDark() ? '#1b1b1b' : '#fcfcfc', cursorAccent: m3.isDark() ? '#1b1b1b' : '#fcfcfc', cursor: m3.isDark() ? '#e6e6e6' : '#1b1b1b', foreground: m3.isDark() ? '#e6e6e6' : '#1b1b1b' };
}

function conciergeZoom() {
  if (conc.term) {
    conc.term.options.fontSize = termFont();
    conc.fit.fit();
  }
}

function conciergeFit() {
  $('dockHead').dataset.compact = String(conc.w <= 300);
  if (conc.term && conc.open) {
    try {
      conc.fit.fit();
    } catch (err) {
      // not laid out yet
    }
  }
}

function conciergePrompt(reason) {
  conc.box?.remove();
  const box = document.createElement('div'); box.className = 'cg-what'; box.style.margin = '16px';
  const title = document.createElement('b');
  title.textContent = reason === 'ready' ? 'Your recipe is ready' : reason === 'settings-required' ? 'Set up Concierge' : 'Concierge could not start';
  const help = document.createElement('p'); help.className = 'hint';
  help.textContent = reason === 'settings-required' ? 'Choose a recipe for this window and account in Concierge settings.' : reason === 'ready' ? 'Start Concierge when you are ready.' : 'Check that its recipe and server are available, then try again.';
  const settings = document.createElement('button'); settings.className = 'tonal'; settings.textContent = 'Concierge settings';
  settings.addEventListener('click', () => openSettings('concierge'));
  box.append(title, help, settings);
  if (reason !== 'settings-required') {
    const start = document.createElement('button'); start.className = 'tonal'; start.textContent = reason === 'ready' ? 'Start Concierge' : 'Try again';
    start.addEventListener('click', () => conciergeStart()); box.appendChild(start);
  }
  $('dockBody').appendChild(box); conc.box = box;
  dockEl.classList.add('cg-prompting'); // a card, no terminal: the body takes the window surface (style.css)
}
async function conciergeStart(focus = captureTerminalFocus(document)) {
  if (conc.term || conc.starting) return;
  conc.starting = true;
  const epoch = conc.epoch;
  let scope = window.wb.rooms.scope();
  const current = () => epoch === conc.epoch && conciergeScopeCurrent(scope);
  try {
    if (scope.selectionVersion < 0) {
      const prefs = await window.wb.prefsGet();
      if (epoch !== conc.epoch) return;
      if (!acceptPrefs(prefs)) { conciergePrompt('unavailable'); return; }
      scope = prefs.conciergeScope;
    }
    // Main decides from this window's trusted recipe; no terminal or fallback shell before admission.
    const r = await window.wb.createConcierge(100, 30);
    if (!current()) return;
    if (!r || r.error || !r.sid) { conciergePrompt(r?.error || 'unavailable'); return; }
    conc.box?.remove();
    dockEl.classList.remove('cg-prompting'); // a terminal keeps its own background
    const box = document.createElement('div'); box.className = 'term'; $('dockBody').appendChild(box);
    const term = new window.Terminal({ fontFamily: FONT, fontSize: termFont(), cursorBlink: true, scrollback: 5000,
      allowProposedApi: true, minimumContrastRatio: 4.5, theme: conciergeTheme() });
    const fit = new window.FitAddon.FitAddon(), ser = new window.SerializeAddon.SerializeAddon();
    term.loadAddon(fit); term.loadAddon(ser); term.open(box); fit.fit();
    if (r.snapshot) term.write(r.snapshot);
    const sid = r.sid;
    conc.term = term; conc.fit = fit; conc.ser = ser; conc.box = box; conc.sid = sid; conc.route = r.route || null;
    conciergeSlots.refresh();
    conciergePaint();
    term.onData(d => { if (current() && conc.sid === sid) window.wb.input(sid, d); });
    term.onResize(({ cols, rows }) => { if (current() && conc.sid === sid) window.wb.resize(sid, cols, rows); });
    box.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).then(() => { if (current()) term.clearSelection(); });
      else navigator.clipboard.readText().then(txt => { if (txt && current() && conc.sid === sid) term.paste(txt); });
    });
    const q = early.get(sid);
    if (q) { early.delete(sid); q.forEach(d => term.write(d)); }
    if (r.held) window.wb.attached(sid, term.cols, term.rows);
    else window.wb.resize(sid, term.cols, term.rows);
    focus.focus(term, () => conc.open && current() && conc.sid === sid);
  } catch (_) {
    if (current()) conciergePrompt('unavailable');
  } finally {
    if (epoch === conc.epoch) conc.starting = false;
  }
}
function conciergeDispose() {
  conc.epoch++;
  if (conc.sid) early.delete(conc.sid);
  conc.term?.dispose(); conc.box?.remove();
  dockEl.classList.remove('cg-prompting');
  conc.term = conc.fit = conc.ser = conc.box = conc.sid = null;
  conc.route = null;
  conc.starting = false;
  conciergeSlots.invalidate();
}

function conciergeToggle(on) {
  if (window.wb.web && document.documentElement.dataset.wbConcierge !== 'ready') return;
  conc.open = on == null ? !conc.open : on;
  if (!conc.open) conciergeSlots.invalidate();
  dockEl.style.setProperty('--dock-w', conc.w + 'px');
  dockEl.classList.toggle('open', conc.open);
  $('dockTab').setAttribute('aria-expanded', String(conc.open));
  if (conc.open) {
    const focus = captureTerminalFocus(document), epoch = conc.epoch;
    conciergePaint();
    conciergeStart(focus).then(() => {
      if (!conc.open || epoch !== conc.epoch) return;
      conciergeFit();
      if (conc.term) focus.focus(conc.term, () => conc.open && epoch === conc.epoch);
    });
  }
  dbg('concierge', { open: conc.open, w: conc.w });
}

$('dockTab').addEventListener('click', () => conciergeToggle());
dockEl.addEventListener('transitionend', (e) => {
  if (e.target === dockEl) {
    conciergeFit();
  }
});
new ResizeObserver(conciergeFit).observe($('dockBody'));
m3.onChange(() => {
  if (conc.open) {
    conciergePaint();
  }
});

$('dockGrip').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const grip = $('dockGrip');
  grip.setPointerCapture(e.pointerId);
  dockEl.classList.add('dragging');
  const move = (ev) => {
    const right = $('main').getBoundingClientRect().right;
    conc.w = Math.round(Math.max(260, Math.min(ev.clientX < 0 ? 260 : right - ev.clientX, $('main').clientWidth * 0.7)));
    dockEl.style.setProperty('--dock-w', conc.w + 'px');
  };
  const up = () => {
    dockEl.classList.remove('dragging');
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    conciergeFit();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
});

// ---------------------------------------------------------------- main -> renderer

window.wb.on('debug', showDebug);

// A tab/window is being dragged over THIS window: light the band, show where it lands.
window.wb.on('drop:preview', ({ x, y }) => {
  if (mode === 'panes') {
    previewGridDrop(x, y);
  } else {
    hwbDropPreview(root, hwbDropIndex(root, x));
  }
});
window.wb.on('drop:clear', () => {
  hwbClearDropPreview(root);
  clearGridDrop();
});

window.wb.on('init', (info) => {
  platform = info.platform || platform;
  skippedLocalRecipes = Array.isArray(info.skippedLocalRecipes) ? info.skippedLocalRecipes : skippedLocalRecipes;
  showDebug(info.debug);
  myWid = info.wid;
  $('ver').textContent = info.version || '';
  $('slogpath').textContent = info.startupLog || '';
  sessionList = info.sessions;
  acc.present = !!info.accounts;
  accountsRefresh();
  window.wb.reportMode(mode); // grid-first: main treats the whole window as a drop target
  // W1: the Workrooms page (src/renderer/rooms) over the rooms client in main; the left flag is lent to
  // its rail while that tab shows (PM ), the pill gets a dot for something new addressed to you
  roomsFlag = { hidden: true, count: 0, dot: false, open: () => roomsPage.openRail(), toggle: () => roomsPage.toggleRail() };
  roomsPage = createRoomsPage({
    seatsSheet: window.wb.web ? createSeatsSheet : undefined,
    toolsSheet: window.wb.web ? createToolsSheet : undefined,
    chatsSheet: window.wb.web ? createChatsSheet : undefined,
    enterSetting: !!window.wb.web,
    // P01 (the design s12): the needs-you watcher: the Workrooms number, the tab title, a browser notification when they are on and allowed
    needsYou: window.wb.web ? (o) => createNeedsYou({ ...o,
      fire: (count) => { window.wb.web.events.fire('rooms-waiting', { count }); modules.setTabCount('workrooms', count); }, // the bottom bar and the top tab
      notify: (a) => window.wb.web.browserActions.notifyNeedsYou(a),
      notifyOn: () => sx.prefs?.notify?.toast === true && window.wb.web.browserActions.notificationStatus() === 'granted',
      openRoom: (familyId, roomId) => { modules.setSurface('workrooms'); roomsPage?.showRoom(roomId); },
    }) : undefined,
    notificationBanner: window.wb.web?.browserActions ? options => mountWorkroomsNotificationBanner({...options,getPrefs:()=>sx.prefs,setPrefs}) : undefined,
    host: $('roomsStage'),
    agentSetup: window.wb.agentSetup,
    roomTemplates: window.wb.roomTemplates,
    templateScope: viewScope,
    roomColors: {create:accountId=>createRoomColors({accountId}),...createRoomPainter(m3)},
    appTone: createAppTonePainter(m3),
    // Tasks seam S1: host-drawn tool cards in the Workrooms rail, and which room it shows
    toolCards: () => modules.toolCardsForRail(),
    pluginPages: () => modules.pluginSidePages(), // plugin side pages from the module host's catalog
    roomTools: (roomId) => modules.roomTools(roomId), // module buttons in the room's own toolbar (web: Widgets)
    openPluginPage: window.wb.web ? (id) => modules.openPluginPage(id) : undefined, // a consented plugin's page, bound to the room (web)
    openImageViewer: (items, index) => modules.openImageViewer(items, index), // the image markup viewer (bundled image-viewer module)
    openImageMarkup: (a) => modules.openImageMarkup(a), // pre-send mark-up: the message box's tray tile opens a draft picture editable (a builder's hook)
    activateToolCard: (id, cardId) => modules.activateToolCard(id, cardId), // revision 10: per card
    toolRequest: (b, o, m, r) => modules.toolRequest(b, o, m, r), // Tasks seam S4 step 5: a module page's request, admitted by the module host
    toolCancel: (o) => modules.toolCancel(o), // S4 step 5: that page's link ended; an open delete confirmation closes
    toolWindowOpen: (b) => modules.toolWindowOpen(b), // S3: the side page's pop-out, for its own binding
    themeVars: () => modules.themeMessage().roles, // S4 step 6: the colour roles a tool page gets (checked again by the page)
    onRoomShown: (p) => { modules.roomShown(p); window.wb.web?.events?.fire('room-shown', p); }, // web build: slices subscribe with window.wb.web.events.on('room-shown', fn); absent on the desktop
    agentSetupVisibility,
    platform,
    newRecipe: () => openSettings('recipe:new'),
    blockedRecipe: s => { const id=s.recipe_id||s.recipeId||s.recipe?.id; const rc=recipeList.find(r=>r.id===id||'app-local-'+r.id===id); return rc?.unavailableTarget ? `${rc.name} needs a server connection, which this version does not have, so it can't start.` : null; },
    localState: () => localFirstState,
    chooseRoomPlace: () => localFirstUI?.chooseRoom(),
    locationChip: room => localFirstUI?.locationChip(room, localFirstState),
    renderLocalStatus: (host, state) => localFirstUI?.localStatus(host, state),
    flagEl: rail.flag,
    flag: (f) => {
      Object.assign(roomsFlag, f);
      rail.repaintFlag();
    },
    pill: ({ dot, title }) => modules.setTabDot('workrooms', dot, title),
    openExternal: (url) => window.wb.openExternal(url),
    openAccounts: () => openSettings('accounts'), // A1: the fallback line's "Settings › Accounts"
    openScratchpadSettings: window.wb.web?.files ? undefined : () => openSettings('scratchpad'),
    openServerScratchpad: window.wb.web?.files ? tab => { scratchpadPage?.selectTab(tab); modules.setSurface('scratchpad'); } : undefined,
    openStarterSettings: () => {
      const owner=roomsPage,scope=viewScope(),operation=owner?.starterSettingsOperation?.();
      void openStarterVisibilitySettings({load:()=>loadSettingsData().catch(()=>{}),show:()=>showSettings('global'),host:()=>$('starterVisibilitySettings'),
        current:()=>operation?.()===true&&owner===roomsPage&&scope.accountId===null&&currentViewScope(scope)&&owner?.starterVisibilityReady()===true});
    },
    snackbar: (text, o) => accountsSnackbar(text, o),
    // W3b: "Open seats in Terminals" (Workrooms' setting, off by default) and the pane it opens in Terminals
    terminalsOn: () => {
      const m = modules.moduleList().find((x) => x.id === 'workrooms');
      return !!(m && m.settings && m.settings.terminals === true);
    },
    setTerminals: async (on) => {
      const m = modules.moduleList().find((x) => x.id === 'workrooms');
      const list=await window.wb.moduleSet({ id: 'workrooms', settings: { ...((m && m.settings) || {}), terminals: !!on } });
      await modules.applyCatalog(list); // use the acknowledged catalog, not IPC/event ordering
    },
    openSeatTerminalInline,
    openSeatTerminal: ({ room, seat, handle, roomName, controlOnOpen, current }) => {
      const options={ spec: { route: 'term', room, seat, handle, roomName, controlOnOpen: controlOnOpen === true }, name: '@' + handle, why: 'seat-terminal' };
      if(controlOnOpen===true){
        const owned=()=>{try{return typeof current==='function'&&current()===true;}catch{return false;}};
        if(!owned())return Promise.resolve(null);
        return Promise.resolve(launch({...options,inlineCurrent:owned})).then(sid=>{
          if(sid==null)return sid;
          if(!owned()){
            // Only the newly created viewer belongs to this abandoned operation.
            window.wb.closeSession(sid);if(tabs.has(sid))removeTabLocal(sid);
            return null;
          }
          modules.setSurface('dashboard');return sid;
        });
      }
      modules.setSurface('dashboard');
      return launch(options);
    },
  });
  roomsPage.enterPref?.subscribe(() => { fillGlobal(); if (!$('settingsPop').hidden && settingsPage === 'message') renderMessageSettings($('secMessage')); }); // another tab changed it
  // 3e: the Servers tab's page; its calls go through main, which signs them with this computer's key
  serversPage = createLocalServerPage({
    createRemote: createServersPage,
    canAddServer: () => typeof window.wb.serverConnection?.beginSignIn === 'function',
    addServer: accountsHandlers.add,
    host: $('serversStage'),
    localFirstState: () => localFirstState,
    renderLocalEmpty: host => localFirstUI?.servers(host),
    api: window.wb.servers,
    account: () => (acc.st && acc.st.account) || null,
    accountEpoch: () => acc.st?.selectionVersion || 0,
    moduleTargets: (serverId) => acc.servers.filter((r) => r.serverId === serverId && !r.request && !r.keysOnly),
    moduleCall: (request) => window.wb.brokerModules(request),
    signIn: () => window.wb.accounts.rescope(),
    signInState: () => (acc.st && acc.st.flow && (acc.st.flow.phase === 'waiting' || acc.st.flow.phase === 'finishing') ? 'waiting' : null),
    signInCancel: () => window.wb.accounts.cancel(),
    signInReopen: () => window.wb.accounts.reopen(),
    openSettingsServers: () => openSettings('servers'),
    snackbar: (text, o) => accountsSnackbar(text, o),
    // Install: a terminal to that server over a login you already reach (its broker, or keys only)
    // Install: a terminal to that server over a login you already reach (its broker, or keys only); it
    // types nothing (the design , the 0.12.2 ruling): the person signs in there and pastes the command
    terminalLogin: (serverId) => {
      const r = acc.servers.find((x) => x.serverId === serverId && !x.request && (x.keysOnly || x.keepsRunning));
      return r ? r.login : null;
    },
    openTerminal: (serverId, name) => {
      const r = acc.servers.find((x) => x.serverId === serverId && !x.request && (x.keysOnly || x.keepsRunning));
      if (r) {
        modules.setSurface('dashboard');
        void launch({ spec: { route: r.keysOnly ? 'ssh' : 'broker', serverId: r.id }, name: `${name} · ${r.login}`, why: 'install-broker' });
      }
    },
  });
  if (window.wb.localSetup && !localFirstUI) {
    const releaseGuard = window.wb.localSetup.registerNotesGuard?.(
      () => (!scratchpadPage || scratchpadPage.canChangeLocation()) && (!roomsPage || roomsPage.canChangeFiles()),
      locked => { for (const id of ['scratchpadStage','roomsStage']) { const stage=$(id); if(stage)stage.inert=locked; } });
    window.addEventListener('beforeunload',()=>releaseGuard?.(),{once:true});
    const api = withEngineHistory(window.wb.localSetup, window.wb.rooms);
    localFirstUI = createFirstRunUI({ api, onAddServer: () => openSettings('servers'),
      onCreateRoom: place => api.selectRoomPlace(place),
      notify: text => accountsSnackbar(text),
      onSetupComplete: async () => { $('firstRunStage').hidden = true; try { refreshLocalFirstState(await api.getState()); modules.setSurface(window.wb.agentSetup ? 'workrooms' : 'dashboard'); } catch { accountsSnackbar("Couldn't refresh local settings. Reopen Settings to try again."); } },
    });
    api.getState().then(state => {
      refreshLocalFirstState(state);
      if (state.setupRequired) { $('firstRunStage').hidden = false; localFirstUI.setup($('firstRunStage')); }
    }).catch(() => accountsSnackbar("Couldn't load your local settings."));
    const off = api.subscribe?.(refreshLocalFirstState);
    window.addEventListener('beforeunload', () => { off?.(); api.destroyHistory(); localFirstUI?.destroy(); }, { once: true });
  }
  codexPage = createCodexPage({ host: $('codexStage'), api: window.wb.codex,
    onAvailability: value => { codexAvailable = value; modules.renderTabs(); } });
  void codexPage.refresh();
  scratchpadPage = window.wb.web?.files?.createPage({ host: $('scratchpadStage') }) || createScratchpadPage({ host: $('scratchpadStage'), api: window.wb.scratchpad,
    onSettings: () => openSettings('scratchpad') });
  // Modules first (they own the top-bar tabs and the list pane), then the CLIs.
  modules.init(
    {
      conciergeSlots,
      // Tasks seam S1: rail cards repaint, and the owner epochs a card's binding is checked against
      toolCardsChanged: () => roomsPage?.toolCardsChanged(),
      // Tasks seam S2: a module page in the Workrooms side column
      openToolSide: (a) => !!roomsPage?.openToolSide(a.key, a.src, { title: a.title, onDispose: a.onDispose, binding: a.binding }),
      // a module's full page (the web): a tab in the Workrooms strip, the full-screen layer on a phone
      openToolPage: (a) => !!roomsPage?.openToolPage({ key: a.key, src: a.src, title: a.title, icon: a.icon, binding: a.binding, onDispose: a.onDispose }),
      closeToolPage: (key) => roomsPage?.closeToolPage(key),
      showToolPage: (key) => !!roomsPage?.showToolPage(key),
      confirmToolDelete: (spec, signal) => confirmDelete(openDialog, $('roomsStage') || document.body, spec, document, signal), // S4 step 5: a module page's delete, confirmed in the app's own dialog; the signal closes it
      toolEvent: (key, event, payload) => roomsPage?.toolEvent(key, event, payload), // S4 step 6: rooms.tasks for an open tool page
      closeToolSide: (key) => roomsPage?.closeToolSide(key),
      accountEpoch: () => accountEpoch,
      engineEpoch: () => engineEpoch,
      // 0.12.2: the Console tab, for the account's admins
      extraTabs: () => consoleTabs(),
      onSurface: (s) => {
        webNav?.render();
        codexPage?.setShown(s === 'codex');
        scratchpadPage?.setShown(s === 'scratchpad');
        consoleSurface(s === 'console');
        if (s === 'servers' && serversPage) {
          void serversPage.shown();
        }
        if (rail) {
          rail.setPinAllowed(s === 'dashboard'); // 0.12.5: the pin is a Terminals setting (the owner )
          const onRooms = modules.surfaceKind() === 'rooms';
          rail.setFlagOwner(onRooms ? roomsFlag : null);
          if (roomsPage) {
            roomsPage.setShown(onRooms);
          }
        }
        if (s === 'dashboard') {
          requestAnimationFrame(() => {
            fitAll();
            const t = tabs.get(activeSid);
            if (t) {
              t.term.focus();
            }
          });
        }
      },
      onPaneKinds: (kinds) => {
        rail.setEnabled(kinds.has('list')); // the Status Monitor is the rail's CLIs section
        if (listPinned && !kinds.has('list')) {
          setPinned(false);
        }
        if (!$('flyout').hidden) {
          renderFlyout();
        }
      },
      onModules: settingsModulesChanged,
      sessions: () => sessionList,
      prefs: () => sx.prefs,
      theme: () => ({ scheme: m3.isDark() ? 'dark' : 'light', contrast: Number(m3.get().contrast) || 0 }),
      openSettings: (p) => {
        closePops();
        openSettings(p);
      },
    },
    { userModulesDir: info.userModulesDir }
  );
  // First load: the saved CLIs, an adopted one, or one new CLI. A reload re-adopts this window's
  // CLIs and never starts one (main refuses a launch without a permit after the first load anyway).
  const first = () => (info.restore ? restoreState(info.restore, { startup: true }) : info.adopt ? addTab(info.adopt) : addTab({ why: 'startup' }));
  const readopt = async () => {
    for (const a of info.readopt || []) {
      await addTab(a);
    }
  };
  const started = modules.applyCatalog(info.modules).then(info.reload ? readopt : first);
  started.then(async () => {
    if (window.wb.web && !info.reload && !modules.surfaceWasChosen()) modules.setSurface('workrooms'); // the web build opens on Workrooms (the terminal is one tab away), not on a blank or busy Terminals tab (quality pass item 3)
    // step 3c: the recipes, once (every later change arrives as recipes:changed)
    recipeList = (await window.wb.recipesList().catch(() => [])) || [];
    recipesApply();
    window.wb.startupDone();
    if (info.firstRunHint && !info.reload) {
      showCoach();
    }
    pushState();
    setInterval(pushState, 1000);
  });
});

window.wb.on('modules:changed', (list) => { void modules.applyCatalog(list).then(() => roomsPage?.toolCardsChanged()); }); // the rail re-reads plugin pages

window.wb.on('session:data', ({ sid, data }) => {
  const t = tabs.get(sid);
  if (conc.term && sid === conc.sid) {
    conc.term.write(data);
  } else if (t) {
    t.term.write(data);
  } else {
    if (!early.has(sid)) {
      early.set(sid, []);
    }
    early.get(sid).push(data);
  }
});

window.wb.on('session:route', (st) => {
  routeStates.set(st.sid, st);
  if (st.sid === conc.sid) {
    const wasLocal = conciergeLocalScope(); conc.route = st;
    if (wasLocal !== conciergeLocalScope()) { conciergeSlots.invalidate(); conciergePaint(); }
  }
  applyRoute(st.sid);
});

// A broker link came back after missing output: the replay rebuilds the screen from scratch.
window.wb.on('session:gap', ({ sid, replay }) => {
  const t = tabs.get(sid);
  if (t) {
    t.term.reset();
    if (replay) {
      t.term.write(replay);
    }
  } else {
    early.set(sid, replay ? [replay] : []);
  }
});

window.wb.on('session:typing-paused', ({ sid }) => {
  const t = tabs.get(sid);
  if (t) {
    ensureOverlay(t).typingPaused();
  }
});

window.wb.on('session:exit', ({ sid }) => {
  if (sid === conc.sid) {
    // shell ended: the next open starts a fresh one
    conciergeDispose();
    if (conc.open) {
      conciergeStart();
    }
    return;
  }
  removeTabLocal(sid);
});

window.wb.on('session:adopt', (a) => addTab(a));

// Compatibility with an explicit view release: ownership is never transferred between windows.
window.wb.on('concierge:taken', ({ sid }) => {
  if (sid !== conc.sid) {
    return;
  }
  conciergeDispose();
  if (conc.open) {
    conciergeToggle(false);
  }
});

// Another window took one of this window's CLIs (dragged from its rail): drop the pane here.
window.wb.on('session:moved-away', ({ sid }) => {
  if (tabs.has(sid)) {
    removeTabLocal(sid);
  }
});

// Another window's rail hid a CLI shown here.
window.wb.on('session:hide-req', ({ sid }) => {
  if (tabs.has(sid)) {
    hideTab(sid);
  }
});

window.wb.on('sessions:update', (list) => {
  sessionList = list;
  if (signedIn()) {
    recipesApply(); // Open / "2 open" on the recipe rows follow the CLIs
  }
  applyGroups(); // a row opened here leaves its group
  // main holds each CLI's name and color; a rename from another window's rail lands here
  for (const s of list) {
    const t = tabs.get(s.sid);
    if (t && (t.name !== s.name || t.hue !== s.hue)) {
      t.name = s.name;
      t.hue = s.hue;
      t.term.options.theme = themeFor(s.hue);
    }
  }
  refresh(false);
  if (!$('flyout').hidden) {
    renderFlyout();
  }
});

window.wb.on('tab:activate', (sid) => activate(sid));
window.wb.on('win:max', () => {});
window.wb.on('snapshot:req', ({ reqId, sid }) => {
  const t = tabs.get(sid);
  const ser = t ? t.ser : sid === conc.sid ? conc.ser : null;
  window.wb.snapshotReply(reqId, ser ? ser.serialize() : null);
});
