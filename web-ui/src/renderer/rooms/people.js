// Workrooms (W3, people): the seats in the room's rail and everything a person does to a room and its seats.
// the design's step-5 page, #w3 (<commit>, <commit>) and her rulings (, ); the PM's .
//  - a seat row: its avatar, handle, "lead", model · effort · state, chips "needs you" (error) and "2 held" (amber),
//    ⋯ on hover or right-click;
//  - the seat menu, in this order: Open in Terminals (off until W3b: "Coming in a later build") · Start or Wake ·
//    Rename… · How it runs ▸ · Make lead · Remove… (error-colored, below a divider; off on the lead);
//  - Add a seat, How it runs, Rename, Make lead and Remove (the last two ask first);
//  - the room's ⋯: Rename… · Brief ▸ (Show, Edit, Clear) · Mode ▸ (Autonomous, Off) · Notes · Archive… / Dissolve
//    workgroup… (both ask first);
//  - New room (All rooms) and New workgroup (the + beside ROOM).
// Everything goes through window.wb.rooms; the page repaints from the room views main broadcasts after each change.
import { icon } from '../m3-chrome.js';
import * as m3 from '../m3.js';
import { createColorSwatches } from '../color-swatches.js';
import { el, seatColor, colorOf } from './line.js';
import { SWATCHES } from '../srail.js';
import { openDialog, textField, HANDLE_RE } from './dialog.js';
import { hwbRing, hwbRingFromChrome, hwbRingAggregate } from '../../vendor/aurora/window-chrome/hwb-ring.js';
import { brandMarkPath } from '../../vendor/aurora/brand-marks/aurora-brand-marks.js';

// 0.22.1: the engine's model and effort lists per vendor (briefing-table web/vendor-profile.mjs: cardModels, efforts)
const WEB = () => !!(globalThis.wb && globalThis.wb.web); // the web build's words say "server" where the desktop's say "computer"
const VENDOR_LISTS = {
  'claude-code': { models: ['opus', 'sonnet', 'fable'], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] },
  'codex-cli': { models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gemini-cli': { models: ['pro', 'flash', 'flash-lite'], efforts: [] },
};

const recipeDescription = (rc, platform) => rc.target === 'local' && rc.vendor === 'cli-manager' && !rc.initCmd && !rc.command
  ? (WEB() ? 'Starts your shell on this server.' : platform === 'win32' ? 'Starts PowerShell on this computer.' : 'Starts your shell on this computer.')
  : rc.folder || rc.project || '';

export const WORDS = {
  terminalsOff: 'Coming in a later build',
  wakeFirst: 'Wake it first',
  needsYou: 'needs you',
  held: (n) => n + ' held',
  notLive: 'not live',
  addTitle: (room) => 'Add a seat to ' + room,
  handleHint: 'Leave empty to name it after the recipe. Others reach it with @handle.',
  handleTaken: 'That handle is in use here.',
  handleBad: 'Use letters, numbers, - and _.',
  howTitle: (h) => 'How should ' + h + ' run?',
  policies: [
    ['persistent', 'Keeps running', 'Stays up between messages'],
    ['fresh', 'Starts fresh', "A new conversation each time it's woken"],
    ['dispatched', 'Starts when asked', 'Only runs when a message needs it'],
    ['pool', 'A pool', 'Shared out'],
  ],
  renameTitle: 'Rename this seat',
  leadTitle: (h, room) => 'Make ' + h + ' the lead of ' + room + '?',
  leadText: 'The lead keeps the room moving and gets the brief.',
  removeTitle: (h, room) => 'Remove ' + h + ' from ' + room + '?',
  removeText: 'It leaves the room and stops. Its lines stay.',
  removeLead: 'Make another seat lead first', // briefing-table's words
  newRoom: 'New room',
  newRoomHandleHint: 'Letters, numbers, - and _.', // the design 
  whoSits: 'Who sits in it',
  newGroupTitle: (room) => 'New workgroup in ' + room,
  moveIn: 'Move seats in',
  startRecipes: 'Start recipes',
  archiveTitle: (room) => 'Archive ' + room + '?',
  archiveText: 'It leaves All rooms. You can reopen it from Hidden rooms.',
  dissolveTitle: (room) => 'Dissolve workgroup ' + room + '?',
  dissolveText: 'Its seats move back to the main room. The lines stay.',
  renameRoom: 'Rename this room',
  modes: [
    ['autonomous', 'Autonomous', 'The lead keeps the room moving between your messages.'],
    ['off', 'Off', 'Seats only answer when addressed.'],
  ],
  clearBriefTitle: 'Clear the brief?',
  clearBriefText: 'The lead goes without it.',
  noRecipes: 'No recipes on this server yet.',
};

/** What a seat is doing, in the rail's words: working, parked, busy, resting, starting, not started. */
/** P01 (the design s12): a live seat whose agent waits for the person (needs-you.js seatNeedsYou's test, inline: tests load this file as
 *  bare source). */
function seatNeedsYou(s) {
  const o = s && s.status === 'live' ? s.occupant : null;
  return !!o && (o.state == null || o.state === 'live') && (!!o.blocked || o.activity === 'waiting' || o.activity === 'waiting-seen');
}
export function seatState(s) {
  const o = s.occupant || null;
  switch (s.status) {
    case 'live':
      if (seatNeedsYou(s)) {
        return WORDS.needsYou;
      }
      if ((o && o.held && o.held.depth) || (s.waiting && s.waiting.count)) {
        return 'busy';
      }
      // the engine's activity words, in the rail's: streaming is "working" (and its ring turns)
      return o?.activity === 'streaming' ? 'working' : o?.activity || 'idle';
    case 'parked':
      return 'parked';
    case 'starting':
      return 'starting';
    case 'dehydrated':
    case 'ended':
      return 'resting';
    default:
      return 'not started';
  }
}
export const isResting = (s) => s.status === 'dehydrated' || s.status === 'ended';
export const neverRan = (s) => s.status === 'never-started' || s.status === 'empty' || (!s.occupant && (s.actions || []).includes('start') && !isResting(s));
export const heldCount = (s) => Math.max((s.occupant && s.occupant.held && s.occupant.held.depth) || 0, (s.waiting && s.waiting.count) || 0);

// Lifecycle wins over stale activity, as in briefing-table's seatChrome. A
// dehydrated/ended process can never keep a working or attention ring.
export function seatChrome(s) {
  if (s.status === 'never-started' || s.status === 'empty') return null;
  if (s.status === 'starting') return 'background';
  if (s.status === 'dehydrated') return 'restorable';
  if (s.status === 'ended') return 'ended';
  const o = s.occupant;
  if (!o) return 'ended';
  if (o.state === 'dehydrated') return 'restorable';
  if (o.state && o.state !== 'live') return 'ended';
  if (o.blocked) return 'waiting';
  return o.activity || 'idle';
}
export function seatBrand(s) {
  const vendor = s.vendor || s.occupant?.vendor;
  const brands = { 'claude-code': 'claude', claude: 'claude', 'codex-cli': 'codex', codex: 'codex', 'gemini-cli': 'gemini', gemini: 'gemini' };
  return typeof vendor === 'string' && Object.hasOwn(brands, vendor) ? brands[vendor] : 'generic';
}
export function seatGlyph(s, lead, size = 36) {
  const glyph = el('span', 'sr-ic wr-seatglyph'), chrome = seatChrome(s), brand = seatBrand(s);
  hwbRing(glyph, chrome === null ? null : hwbRingFromChrome(chrome, { attached: !!s.occupant?.attached, exit: s.occupant?.exit }), size,
    { brand, markPath: brandMarkPath(brand), primary: lead, label: s.handle });
  glyph.style.setProperty('--ps', size + 'px');
  glyph.dataset.brand = brand;
  // Bundled identity colors from briefing-table/web/brands.json. The ring
  // stylesheet derives the plate and ink for the current theme.
  glyph.style.setProperty('--brand-src', ({ claude: '#d97757', codex: '#10a37f', gemini: '#4285f4' })[brand] || '#8a8f98');
  return glyph;
}
export function roomSpec(seats) {
  return hwbRingAggregate((seats || []).filter(s => !s.left_at).map(s => {
    const chrome = seatChrome(s);
    return chrome === null ? null : hwbRingFromChrome(chrome, { attached: !!s.occupant?.attached, exit: s.occupant?.exit });
  }));
}
export function roomGlyph(seats, size = 36, disconnected = false) {
  const glyph = el('span', 'wr-roomglyph');
  hwbRing(glyph, disconnected ? hwbRingFromChrome('restorable') : roomSpec(seats), size, { workroom: true, label: 'Room status' });
  return glyph;
}

/** A menu at a point or under an anchor, with one level of submenus (an item's `sub`). Esc, the outside and a pick close it. */
export function openMenu(host, at, items) {
  closeMenus(host);
  const r = host.getBoundingClientRect();
  const build = (list, x, y, level) => {
    const m = el('div', 'wr-menu wr-pmenu');
    m.setAttribute('role', 'menu');
    m.dataset.level = String(level);
    for (const it of list) {
      if (it.divider) {
        m.appendChild(el('div', 'wr-menud'));
        continue;
      }
      if (it.head) {
        // C9: the line menu names the line: the author (in the seat's color), the time and "Line #id"
        const h = el('div', 'wr-menuhead');
        const b = el('b', null, it.head.who);
        if (it.head.color) {
          b.style.color = it.head.color;
        }
        h.append(b, el('span', null, it.head.sub));
        m.appendChild(h);
        continue;
      }
      const b = el('button', 'wr-menui' + (it.error ? ' err' : '') + (it.sub ? ' sub' : '') + (it.checked ? ' checked' : ''));
      b.type = 'button';
      b.setAttribute('role', it.checked != null ? 'menuitemradio' : 'menuitem');
      if (it.checked != null) {
        b.setAttribute('aria-checked', String(!!it.checked));
      }
      b.dataset.item = it.id || it.label;
      b.innerHTML = it.icon ? icon(it.icon) : icon('check', it.checked ? '' : 'wr-mhide'); // a radio row keeps its check's room
      b.appendChild(el('span', 'wr-menut', it.label));
      if (it.hint) {
        b.appendChild(el('span', 'wr-menuhint', it.hint)); // the seat ⋮'s quiet hint at the right (the design 8800ba1)
      }
      if (it.sub) {
        b.insertAdjacentHTML('beforeend', icon('arrow_right', 'wr-menuar'));
        b.setAttribute('aria-haspopup', 'menu');
      }
      if (it.disabled) {
        b.setAttribute('aria-disabled', 'true');
        b.classList.add('off');
      }
      if (it.tip) {
        b.title = it.tip;
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.disabled) {
          return;
        }
        if (it.sub) {
          [...host.querySelectorAll('.wr-pmenu')].filter((x) => Number(x.dataset.level) > level).forEach((x) => x.remove());
          const br = b.getBoundingClientRect();
          const sm = build(it.sub, br.right - r.left + 2, br.top - r.top - 4, level + 1);
          const first = sm.querySelector('.wr-menui:not(.off)');
          if (first) {
            first.focus();
          }
          return;
        }
        closeMenus(host);
        it.fn && it.fn();
      });
      m.appendChild(b);
    }
    if (list.some((it) => it.hint)) {
      m.classList.add('hints');
    }
    m.addEventListener('keydown', (e) => {
      const btns = [...m.querySelectorAll('.wr-menui:not(.off)')]; // a disabled row is announced, never landed on
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length].focus();
        e.preventDefault();
      } else if (e.key === 'ArrowRight' && document.activeElement && document.activeElement.classList.contains('sub')) {
        document.activeElement.click();
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' && level > 0) {
        m.remove();
        e.preventDefault();
      } else if (e.key === 'Escape') {
        closeMenus(host);
        e.preventDefault();
        e.stopPropagation();
      }
    });
    host.appendChild(m);
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    m.style.left = Math.round(Math.max(4, Math.min(x, r.width - w - 4))) + 'px';
    m.style.top = Math.round(Math.max(4, Math.min(y, r.height - h - 4))) + 'px';
    return m;
  };
  const first = build(items, at.x - r.left, at.y - r.top, 0);
  const f = first.querySelector('.wr-menui:not(.off)');
  if (f) {
    f.focus();
  }
  const away = (e) => {
    if (!e.target.closest || !e.target.closest('.wr-pmenu')) {
      closeMenus(host);
    }
  };
  setTimeout(() => {
    if (host._menuAway === away) {
      document.addEventListener('pointerdown', away, true);
    }
  }, 0);
  host.dataset.menuAway = '1';
  host._menuAway = away;
  return first;
}
export function closeMenus(host) {
  host.querySelectorAll('.wr-pmenu').forEach((m) => m.remove());
  if (host._menuAway) {
    document.removeEventListener('pointerdown', host._menuAway, true);
    host._menuAway = null;
  }
}

/** An M3 outlined field that opens a menu (the design : not the browser's select): label, the chosen
 *  option's name, the drop arrow. → { el, value(), set(v), options(list) }; onChange(value) after a pick. */
export function selectField(host, { label, name, onChange }) {
  const wrap = el('div', 'wr-dlgfw');
  const f = el('div', 'wr-field wr-selectf');
  const b = el('button', 'wr-selb');
  b.type = 'button';
  b.name = name || label.toLowerCase();
  b.setAttribute('aria-haspopup', 'menu');
  const val = el('span', 'wr-selv');
  b.appendChild(val);
  b.insertAdjacentHTML('beforeend', icon('arrow_drop_down', 'wr-seldd'));
  const l = el('label', null, label);
  f.append(b, l);
  wrap.appendChild(f);
  let opts = [];
  let value = '';
  const paint = () => {
    const o = opts.find((x) => x.value === value);
    val.textContent = o ? o.label : '';
    f.classList.toggle('filled', !!o);
  };
  b.addEventListener('click', () => {
    const r = b.getBoundingClientRect();
    const m = openMenu(host, { x: r.left, y: r.bottom + 2 }, opts.map((o) => ({ id: o.value, label: o.label + (o.sub ? ' · ' + o.sub : ''), checked: o.value === value, fn: () => {
      value = o.value;
      paint();
      b.focus();
      if (onChange) {
        onChange(value);
      }
    } })));
    if (m) {
      m.style.minWidth = Math.round(r.width) + 'px';
      m.classList.add('wr-selmenu');
    }
  });
  return {
    el: wrap,
    button: b,
    value: () => value,
    set(v) {
      value = v;
      paint();
    },
    options(list) {
      opts = list;
      paint();
    },
  };
}

// the engine refuses a non-Claude seat with seat-vendor-unsupported: say it in words, never the code
const VENDOR_NAMES = { 'codex-cli': 'Codex', 'gemini-cli': 'Gemini', ollama: 'Ollama', 'cli-manager': 'Shell' };
const cantJoin = (name) => (name || 'That program') + " can't join a room yet. Open it from Terminals instead.";
const vendorRefused = (r) => !!(r && r.ok === false && /seat-vendor-unsupported/.test(String(r.message || '')));
// the engine's refusal of an agent that has no folder (a hosted engine never starts one in a directory nobody chose): said as it is, never a generic error
export const NO_FOLDER = 'This agent has no folder yet. Add it again with a folder.';
const reason = (r) => (r && r.ok === false ? (vendorRefused(r) ? cantJoin() : r.message || "Couldn't do that.") : null);

/**
 * createPeople(deps): { host (the .wr root, for dialogs and menus), roomName(id), view(id), seatIndex(handle),
 *   snackbar(text), openRoom(familyId, roomId), afterDissolve(parentId), openSide(kind) }
 */
export function createPeople(deps) {
  // Dialogs, menus and cached recipe rows belong to the selection that made them.
  // Replace the whole scope on a switch so a retained callback never adopts B.
  let scope = null;
  const resetAccount = () => {
    if (scope) {
      scope.resetAccount();
      scope = null;
    }
  };
  const api = { resetAccount };
  for (const name of ['seatRow', 'seatMenu', 'seatItems', 'colorRoom', 'addSeat', 'howItRuns', 'renameSeat', 'makeLead', 'removeSeat', 'roomMenu', 'renameRoom', 'chooseRoomPlace', 'newRoom', 'newWorkgroup', 'archive', 'dissolve', 'clearBrief', 'recipes', 'start', 'startWhy']) {
    api[name] = (...args) => {
      if (!scope || !scope.current()) {
        resetAccount();
        scope = createPeopleScope(deps, window.wb.rooms.bind());
      }
      return scope[name](...args);
    };
  }
  return api;
}

function createPeopleScope(deps, request) {
  // the pilot's seat rule (Claude Code and Codex join a room) is the web build's wb.web.seat facade (web/handlers/seat-rule.js); without it (the desktop, the extracted-source tests) nothing is filtered
  const seat = (globalThis.wb && globalThis.wb.web && globalThis.wb.web.seat) || { seatRecipes: (l) => l, refusal: () => null, applies: () => false, WORDS: {} };
  const seatRecipes = (l) => seat.seatRecipes(l), seatRefusal = (rc) => seat.refusal(rc), seatRuleApplies = () => seat.applies(), SEAT_WORDS = seat.WORDS;
  const R = () => request;
  let alive = true;
  const current = () => alive && request.current();
  const dialogs = new Set();
  const guardItems = items => items.map(it => ({ ...it,
    ...(it.fn ? { fn: (...args) => current() ? it.fn(...args) : undefined } : {}),
    ...(it.sub ? { sub: guardItems(it.sub) } : {}),
  }));
  const dialog = options => {
    const dlg = openDialog(host, { ...options,
      actions: (options.actions || []).map(a => ({ ...a, ...(a.fn ? { fn: async () => {
        if (!current()) return false;
        const result = await a.fn();
        return current() ? result : false;
      } } : {}) })),
      onClose() { dialogs.delete(dlg); options.onClose?.(); },
    });
    dialogs.add(dlg);
    return dlg;
  };
  const host = deps.host;
  let lastFull = []; // the last recipe read, before the seat rule: a stale pick is refused by name
  const openAgentFromRoom = () => { const a = globalThis.wb && globalThis.wb.web && globalThis.wb.web.agents; if (a && a.open) a.open({ forRoom: true }); else deps.newRecipe?.(); };
  async function recipes() {
    if (!current()) return [];
    const r = await R().recipes();
    if (!current()) return [];
    const list = r && r.ok && r.value && Array.isArray(r.value.recipes) ? r.value.recipes : [];
    lastFull = list;
    return seatRecipes(list); // Claude Code and Codex can join a room in the pilot: Gemini, Ollama and Shell recipes are terminals, never offered as a seat
  }
  const fail = (r) => {
    if (!current()) return true;
    const why = reason(r);
    if (why) {
      deps.snackbar(why);
      return true;
    }
    return false;
  };

  // ---- a seat row in the rail
  function seatRow(roomId, v, s, index) {
    const selected = deps.selectedSeat?.(roomId) === s.id;
    const r = el('div', 'wr-seat sr-r' + (selected ? ' sel' : ''));
    r.dataset.seat = s.id;
    r.dataset.handle = s.handle;
    r.tabIndex = 0;
    r.setAttribute('aria-label', 'Open @' + s.handle + "'s terminal");
    r.style.setProperty('--c', colorOf(s.handle) || seatColor(index)); // C2: the recipe's color
    const o = s.occupant || null;
    const blocked = blockedStart(s);
    const state = blocked ? 'needs a server' : seatState(s);
    const lead = s.is_lead || (v.room && s.id === v.room.lead_seat);
    r.appendChild(seatGlyph(s, lead));
    const tx = el('span', 'tx wr-rtx');
    const nm = el('span', 'n1 wr-rn');
    nm.appendChild(el('span', 'wr-seatname', s.handle));
    if (lead) {
      nm.appendChild(el('span', 'sr-lead wr-lead', 'lead'));
    }
    tx.appendChild(nm);
    // Keep the state visible even when a long model/effort description truncates.
    const n2 = el('span', 'n2 wr-rs');
    const held = heldCount(s);
    if (seatChrome(s) === 'waiting' || seatNeedsYou(s)) {
      const needs = el('span', 'sr-chip err wr-needs'); // words and an icon, never color alone (the design s12)
      const mark = el('span', 'ms', 'priority_high');
      mark.setAttribute('aria-hidden', 'true');
      needs.append(mark, el('span', 'wr-needstx', WORDS.needsYou));
      n2.appendChild(needs);
    } else if (held) {
      n2.appendChild(el('span', 'sr-chip warn wr-heldchip', WORDS.held(held)));
    } else {
      const chip = el('span', 'sr-chip wr-statechip', state); chip.dataset.state = state;
      n2.appendChild(chip);
    }
    n2.appendChild(document.createTextNode([o?.model || s.model, o?.effort || s.effort].filter(Boolean).join(' · ')));
    tx.appendChild(n2);
    r.appendChild(tx);
    r.title = '@' + s.handle + (o?.worktree ? '\n' + o.worktree : ''); // full identity even when the name truncates
    const actions = Array.isArray(s.actions) ? s.actions : [];
    const go = actions.includes('rehydrate') ? 'rehydrate' : actions.includes('start') ? 'start' : null;
    if (go) {
      const restore = el('button', 'wr-seatrestore', go === 'rehydrate' ? 'Restore' : 'Start');
      restore.type = 'button'; restore.setAttribute('aria-label', restore.textContent + ' @' + s.handle);
      if (blocked) {
        restore.title = 'Needs a server connection, which this version does not have.';
        restore.setAttribute('aria-label', restore.title); restore.setAttribute('aria-disabled', 'true');
      }
      restore.addEventListener('click', async e => {
        e.stopPropagation(); if (!current() || restore.disabled) return;
        if (blocked) { await start(roomId, s); return; }
        restore.disabled = true;
        try { await start(roomId, s); }
        catch { if (current()) deps.snackbar("Couldn't start @" + s.handle + '. Try again.'); }
        finally { if (current()) restore.disabled = false; }
      });
      r.appendChild(restore);
    }
    const acts = el('span', 'acts');
    const more = el('button', 'wr-ib wr-seatmore');
    more.type = 'button';
    more.title = 'More for ' + s.handle;
    more.setAttribute('aria-label', 'More for ' + s.handle);
    more.setAttribute('aria-haspopup', 'menu');
    more.innerHTML = icon('more_vert');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = more.getBoundingClientRect();
      seatMenu(roomId, v, s, { x: b.left, y: b.bottom + 2 });
    });
    acts.appendChild(more);
    r.appendChild(acts);
    r.addEventListener('click', e => {
      if (!current() || e.target?.closest?.('button')) return;
      deps.selectSeat?.(roomId, v, s);
    });
    r.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      seatMenu(roomId, v, s, { x: e.clientX, y: e.clientY });
    });
    r.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === r) {
        e.preventDefault(); if (current()) deps.selectSeat?.(roomId, v, s); return;
      }
      if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        e.preventDefault();
        const b = r.getBoundingClientRect();
        seatMenu(roomId, v, s, { x: b.left + 40, y: b.bottom });
      }
    });
    return r;
  }

  // The seat ⋮ (0.19.0, PM ; the design <commit> "The seat ⋮ menu"): briefing-table's list in its order
  // (web/room-seat-menu.mjs items()), one shape for every seat. A row that can't act here is grey with
  // its hint and says why on hover; the arrows skip it. Open window is the app's Open in Terminals (W3b).
  function seatItems(roomId, v, s) {
    const o = s.occupant || null;
    const live = !!o && (o.state ? o.state === 'live' : s.status === 'live' || s.status === 'parked'); // the engine's occupant.state
    const shell = deps.isLocal?.() && (o?.vendor || s.vendor) === 'cli-manager' && !(o?.agent || s.agent);
    const lead = !!(s.is_lead || (v.room && s.id === v.room.lead_seat));
    const acts = Array.isArray(s.actions) ? s.actions : [];
    const go = acts.includes('rehydrate') ? 'rehydrate' : acts.includes('start') ? 'start' : null;
    const goLabel = go === 'start' || (!go && !live && !(o && o.state === 'dehydrated') && s.status !== 'starting') ? 'Start' : 'Restore';
    const shown = !!o && ((Number(o.windows) || 0) > 0 || (Number(o.frames) || 0) > 0 || !!(deps.paneOpen && deps.paneOpen(roomId, s)));
    const targets = deps.familyRooms ? deps.familyRooms(roomId).filter((x) => x.id !== roomId) : [];
    // the web build has no seat windows: a Close window with nothing to close is left out, never shown disabled (P02)
    const webNoWindow = !!(globalThis.wb && globalThis.wb.web) && (!live || !shown);
    return guardItems([
      // W3b: always on; a resting seat opens as its card with [Wake]
      { id: 'terminals', label: 'Open window', hint: 'in Terminals', icon: 'open_in_new', fn: () => deps.openTerminal(roomId, v, s) },
      ...(webNoWindow ? [] : [{ id: 'closew', label: 'Close window', icon: 'close', disabled: !live || !shown, tip: live ? 'No window is open' : 'No live session', fn: () => closeWindow(roomId, s) }]),
      { id: 'go', label: goLabel, icon: goLabel === 'Start' ? 'play_arrow' : 'restore', disabled: !go, tip: s.status === 'starting' ? 'Already starting' : 'Not disconnected', fn: () => start(roomId, s) },
      ...(shell ? [{ id: 'stop', label: 'Stop', icon: 'stop', error: true, disabled: !live, tip: 'Ends the shell and anything running in it', fn: () => stopShell(roomId, s) }] : [{ id: 'disconnect', label: 'Disconnect', hint: 'restorable', icon: 'power_settings_new', disabled: !live, tip: 'Only a live session can be disconnected', fn: () => disconnect(roomId, s) }]),
      { id: 'reload', label: 'Reload from project defaults…', hint: 'new model/effort', icon: 'refresh', disabled: !live || !s.recipe_id, tip: !s.recipe_id ? 'No project to reload from' : 'Only a live session can be reloaded', fn: () => reload(roomId, v, s) },
      // 0.22.1 (PM ; the design: hint "next reconnect"): the seat's stored model and effort, applied at its next launch
      { id: 'profile', label: 'Model & effort…', hint: 'next reconnect', icon: 'tune', disabled: !o, tip: 'Start the seat first', fn: () => profile(roomId, v, s) },
      { divider: true },
      { id: 'move', label: 'Move to workgroup…', hint: 'same name, same session', icon: 'drive_file_move', disabled: !targets.length, tip: 'No other room in this family', fn: () => move(roomId, v, s, targets) },
      { id: 'rename', label: 'Rename @' + s.handle + '…', icon: 'edit', fn: () => renameSeat(roomId, v, s) },
      { id: 'lead', label: 'Make lead', icon: 'star', disabled: lead, tip: 'Already the lead', fn: () => makeLead(roomId, v, s) },
      { divider: true },
      { id: 'remove', label: 'Remove from room…', icon: 'person_remove', error: true, disabled: lead, hint: lead ? WORDS.removeLead : '', tip: WORDS.removeLead, fn: () => removeSeat(roomId, v, s) },
    ]);
  }
  function seatMenu(roomId, v, s, at) {
    if (!current()) return null;
    return openMenu(host, at, seatItems(roomId, v, s));
  }

  async function closeWindow(roomId, s) {
    fail(await R().seatCloseWindow(roomId, s.id));
  }
  function stopShell(roomId, s) {
    const paneid = s.occupant?.id;
    const dlg = dialog({
      title: 'End this CLI?', text: '@' + s.handle + ': the shell and anything running in it will stop.', focus: 'Cancel',
      actions: [{ label: 'Cancel' }, { label: 'End', kind: 'error', fn: async () => {
        const result = await R().seatEnd(roomId, s.id, paneid);
        if (!current()) return false;
        if (reason(result)) { dlg.error(reason(result)); return false; }
        deps.seatEnded?.(roomId, s.id);return true;
      } }],
    });
    return dlg;
  }
  async function disconnect(roomId, s) {
    fail(await R().seatDisconnect(roomId, s.id));
  }

  // Reload from project defaults… asks first: what it would do (GET …/reload), and a mid-turn seat only
  // with "Reload anyway" ticked (briefing-table's card)
  function reload(roomId, v, s) {
    const body = el('div', 'wr-dlgform');
    const list = el('ul', 'wr-reload');
    list.appendChild(el('li', null, 'Loading what Reload would do…'));
    body.appendChild(list);
    let force = null;
    const dlg = dialog({
      title: 'Reload @' + s.handle + ' from its project?',
      text: 'The conversation restarts with the project\'s model and effort.',
      body,
      actions: [
        { label: 'Cancel' },
        { label: 'Reload', kind: 'filled', primary: true, disabled: true, fn: async () => !fail(await R().seatReload(roomId, s.id, { force: !!(force && force.checked) })) },
      ],
    });
    R()
      .seatReloadPreview(roomId, s.id)
      .then((res) => {
        if (!current()) return;
        list.textContent = '';
        const p = res && res.ok ? res.value : null;
        if (!p) {
          dlg.error((res && res.message) || "Couldn't load what Reload would do.");
          return;
        }
        const r = p.recipe;
        list.appendChild(el('li', null, r ? 'Starts a fresh session of "' + r.name + '" (' + (r.model || 'default model') + ', ' + (r.effort || 'default effort') + ').' : 'No project is bound to this seat.'));
        if (p.priorSlug) {
          list.appendChild(el('li', null, 'The previous session stays restorable after the reload.'));
        }
        if (Array.isArray(p.otherRooms) && p.otherRooms.length) {
          list.appendChild(el('li', null, 'Also seated in ' + p.otherRooms.map((x) => x.roomName + ' (@' + x.handle + ')').join(', ') + ': reloaded there too.'));
        }
        if (p.busy) {
          const lab = el('label', 'wr-check');
          force = el('input');
          force.type = 'checkbox';
          lab.append(force, document.createTextNode('Reload anyway'));
          body.append(el('div', 'wr-dlgwarn', '@' + s.handle + ' is mid-turn right now.'), lab);
          force.addEventListener('change', () => dlg.enable('Reload', force.checked));
          return;
        }
        dlg.enable('Reload', !!r);
      });
    return dlg;
  }

  // Model & effort… (0.22.1; PATCH …/seats/:sid/profile, briefing-table <commit>): in the engine card's words
  // (web/agent-profile-card.mjs). The lists follow the seat's vendor (web/vendor-profile.mjs); "Default" leaves it
  // to the CLI. It opens on the seat's stored profile; a session already running is not changed.
  function profile(roomId, v, s) {
    const o = s.occupant || {};
    const vendor = String(o.vendor || s.vendor || 'claude-code');
    const lists = VENDOR_LISTS[vendor === 'claude' ? 'claude-code' : vendor] || { models: [], efforts: [] };
    const cur = o.profile || {};
    const body = el('div', 'wr-dlgform');
    let dlg = null;
    // the design : the app's M3 outlined field (label on the border, 52 px, the ▾ icon) opening the app's menu
    // (40 px rows, the current value checked), as the Concierge's "What it runs" picker; never a native select
    const select = (label, values, value) => {
      const f = el('button', 'wr-ofield');
      f.type = 'button';
      f.setAttribute('aria-haspopup', 'menu');
      f.setAttribute('aria-label', label);
      f.dataset.field = label.toLowerCase();
      const shown = el('span', 'wr-ofv');
      f.append(el('span', 'wr-ofl', label), shown);
      f.insertAdjacentHTML('beforeend', icon('arrow_drop_down'));
      const opts = [['', 'Default'], ...values.map((x) => [x, x])];
      if (value && !values.includes(value)) {
        opts.push([value, value]); // a stored value the list no longer has stays visible
      }
      const set = (v) => {
        f.dataset.value = v;
        shown.textContent = (opts.find((o) => o[0] === v) || [v, v])[1];
      };
      set(value || '');
      f.addEventListener('click', () => {
        if (!current()) return;
        const r = f.getBoundingClientRect();
        openMenu(host, { x: r.left, y: r.bottom + 2 }, opts.map(([v, t]) => ({ // window coordinates, as the seat ⋮
          id: 'pf-' + (v || 'default'),
          label: t,
          checked: v === f.dataset.value,
          fn: () => {
            set(v);
            dlg && dlg.enable('Save', true);
            f.focus();
          },
        })));
      });
      Object.defineProperty(f, 'picked', { get: () => f.dataset.value });
      body.appendChild(f);
      return f;
    };
    const model = select('Model', lists.models, cur.model || '');
    const effort = lists.efforts.length ? select('Effort', lists.efforts, cur.effort || '') : null;
    const note = el('div', 'wr-dlgnote', 'Kept with this agent. It applies the next time it reconnects; a session already running is not changed.');
    body.appendChild(note);
    dlg = dialog({
      title: 'Model & effort for @' + s.handle,
      body,
      actions: [
        { label: 'Close' },
        {
          label: 'Save',
          kind: 'filled',
          primary: true,
          fn: async () => {
            const res = await R().seatProfile(roomId, s.id, { model: model.picked, ...(effort ? { effort: effort.picked } : {}) });
            if (!current()) return false;
            const why = reason(res);
            if (why) {
              dlg.error(why);
              return false;
            }
            const p = (res.value && res.value.profile) || {};
            note.textContent = 'Saved: ' + (p.model || 'default model') + ', ' + (p.effort || 'default effort') + '. Applies the next time it reconnects.';
            dlg.enable('Save', false); // a new pick turns it back on
            return false; // stays open with the saved line; Close closes
          },
        },
      ],
    });
    return dlg;
  }

  // Move to workgroup… (POST …/seats/:sid/move): the family's other rooms; the seat keeps its handle and session
  function move(roomId, v, s, targets) {
    const body = el('div', 'wr-dlgform wr-radios');
    body.setAttribute('role', 'radiogroup');
    let to = null;
    let dlg = null;
    for (const t of targets) {
      const row = el('label', 'wr-radio');
      const i = el('input');
      i.type = 'radio';
      i.name = 'wr-moveto';
      i.value = t.id;
      i.addEventListener('change', () => {
        to = t.id;
        dlg && dlg.enable('Move', true);
      });
      const tx = el('span', 'wr-radiot');
      tx.appendChild(el('span', 'wr-radion', t.name));
      tx.appendChild(el('span', 'wr-radios2', t.main ? 'the main room' : 'workgroup'));
      row.append(i, tx);
      body.appendChild(row);
    }
    dlg = dialog({
      title: 'Move @' + s.handle + ' to…',
      text: 'Same name, same session. Its lines stay where they were written.',
      body,
      actions: [
        { label: 'Cancel' },
        { label: 'Move', kind: 'filled', primary: true, disabled: true, fn: async () => !!to && !fail(await R().seatMove(roomId, s.id, to)) },
      ],
    });
    return dlg;
  }

  function blockedStart(s) {
    return deps.blockedStart?.(s) || (s.recipe?.unavailableTarget ? `${s.recipe.name || s.handle} needs a server connection, which this version does not have, so it can't start.` : null);
  }
  let lastStartWhy = null;
  /** Why the last Start was refused, when the engine said it in words the person should read as they are (null otherwise). */
  const startWhy = () => lastStartWhy;
  async function start(roomId, s) {
    lastStartWhy = null;
    const blocked = blockedStart(s);
    if (blocked) { deps.snackbar(blocked); return false; }
    const r = await R().seatStart(roomId, s.id, {});
    if (reason(r) && String(reason(r)).includes(NO_FOLDER)) { lastStartWhy = NO_FOLDER; if (current()) { deps.snackbar(NO_FOLDER); } return false; }
    if (fail(r)) return false;
    // the web build on a hosted engine: Start binds the seat to a pane and answers placement "browser" (a page must attach it, with spawn, and stay attached for its doorbell)
    const sessions = globalThis.wb && globalThis.wb.web && globalThis.wb.web.sessions;
    let spawnedHere = false;
    const started = r && r.value;
    if (sessions && sessions.spawnSeat && started && started.placement === 'browser' && typeof started.paneid === 'string') {
      const rid = s.recipe_id || (s.recipe && s.recipe.id);
      const spawned = await sessions.spawnSeat(started.paneid, rid).catch(() => ({ error: 'failed' }));
      if (spawned && typeof spawned.error === 'string' && spawned.error.includes(NO_FOLDER)) { lastStartWhy = NO_FOLDER; deps.snackbar(NO_FOLDER); return false; }
      if (!spawned || spawned.error) { deps.snackbar("Couldn't start " + (s.handle ? '@' + s.handle : 'the seat') + ' on the server. Try Start again.'); return false; }
      // the pane is spawned; the seat's own terminal (a real xterm that reports the screen) is the viewer that keeps its doorbell working: open it below,
      // and let go of the headless attach that did the spawning
      sessions.release?.(spawned.sid);
      spawnedHere = true;
    } else if (!deps.isLocal?.()) return true;
    // Start may return the seat snapshot from before its engine-owned spawn.
    // Refresh after success; never retry Start to discover the live occupant.
    let refreshed = await R().room(roomId);
    if (fail(refreshed)) return false;
    let view = refreshed?.value, seat = view?.seats?.find(x => x.id === s.id && !x.left_at);
    // a hosted engine spawns the pane when this page attaches, so the seat is "starting" for a moment: read the room again until it is live (a few seconds at most)
    for (let i = 0; spawnedHere && i < 10 && !(seat && ['live', 'parked'].includes(seat.status)); i++) {
      await new Promise((r) => setTimeout(r, 700));
      if (!current()) return false;
      refreshed = await R().room(roomId);
      if (fail(refreshed)) return false;
      view = refreshed?.value; seat = view?.seats?.find(x => x.id === s.id && !x.left_at);
    }
    if (view && seat?.id === s.id && ['live', 'parked'].includes(seat.status)) {
      await deps.selectSeat?.(roomId, view, seat);
    }
    return true;
  }

  function handleCheck(input, taken) {
    const h = input.value.trim().replace(/^@/, '');
    if (!h) {
      return { ok: true, value: '' };
    }
    if (!HANDLE_RE.test(h)) {
      return { ok: false, why: WORDS.handleBad };
    }
    if (taken && taken.has(h.toLowerCase())) {
      return { ok: false, why: WORDS.handleTaken };
    }
    return { ok: true, value: h };
  }
  const takenIn = (v, except) => new Set(((v && v.seats) || []).filter((x) => !x.left_at && x !== except).map((x) => String(x.handle).toLowerCase()));
  const httpWhy = (r, fallback, rc) => (r && r.ok === false ? (vendorRefused(r) ? cantJoin(rc && (VENDOR_NAMES[rc.vendor] || rc.name)) : r.message && /in use|taken/i.test(r.message) ? WORDS.handleTaken : r.message || fallback) : null);

  // ---- Add a seat
  async function addSeat(roomId) {
    const v = deps.view(roomId);
    const body = el('div', 'wr-dlgform');
    const seg = el('div', 'wr-seg');
    seg.setAttribute('role', 'radiogroup');
    let kind = 'recipe';
    const segBtn = (k, label) => {
      const b = el('button', 'wr-segb' + (k === kind ? ' on' : ''), label);
      b.type = 'button';
      b.dataset.kind = k;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(k === kind));
      b.addEventListener('click', () => {
        kind = k;
        for (const x of seg.children) {
          x.classList.toggle('on', x.dataset.kind === k);
          x.setAttribute('aria-checked', String(x.dataset.kind === k));
        }
        recipeWrap.hidden = k !== 'recipe';
        if (addAgent) addAgent.hidden = k !== 'recipe';
        projWrap.hidden = k !== 'project';
        sync();
      });
      return b;
    };
    seg.append(segBtn('recipe', 'Recipe'), segBtn('project', 'Project'));
    const pickRecipe = selectField(host, { label: 'Recipe', name: 'recipe', onChange: () => sync() });
    const recipeWrap = pickRecipe.el;
    recipeWrap.id = 'wr-addseat-recipe';
    const proj = textField({ label: 'Project', name: 'project', maxLength: 80 });
    const projWrap = proj.el;
    projWrap.hidden = true;
    const handle = textField({ label: 'Handle', name: 'handle', hint: WORDS.handleHint, maxLength: 40 });
    // the web build: a person with no recipe for the agent they want makes one here (the same Add an agent dialog the rail's + opens)
    const addAgent = (deps.newRecipe && globalThis.wb && globalThis.wb.web && globalThis.wb.web.agents) ? el('button', 'wr-dlgbtn tonal', 'Add an agent') : null;
    if (addAgent) { addAgent.type = 'button'; addAgent.dataset.wbTest = 'add-an-agent'; addAgent.addEventListener('click', () => { if (!current()) return; dlg.close(); openAgentFromRoom(); }); }
    body.append(seg, recipeWrap, ...(addAgent ? [addAgent] : []), projWrap, handle.el);
    const dlg = dialog({
      title: WORDS.addTitle(deps.roomName(roomId)),
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Add',
          kind: 'filled',
          primary: true,
          disabled: true,
          fn: async () => {
            const hc = handleCheck(handle.input, takenIn(v));
            if (!hc.ok) {
              dlg.error(hc.why);
              return false;
            }
            if (kind === 'recipe') {
              const no = seatRefusal(lastFull.find((rc) => rc.id === pickRecipe.value()));
              if (no) { dlg.error(no); return false; }
            }
            const a = kind === 'recipe' ? { recipe_id: pickRecipe.value() } : { project: proj.input.value.trim() };
            if (hc.value) {
              a.handle = hc.value;
            }
            const r = await R().seatAdd(roomId, a);
            if (!current()) return false;
            const why = httpWhy(r, "Couldn't add the seat.", lastFull.find((rc) => rc.id === a.recipe_id));
            if (why) {
              dlg.error(why);
              return false;
            }
            return true;
          },
        },
      ],
    });
    const sync = () => {
      const ok = kind === 'recipe' ? !!pickRecipe.value() : !!proj.input.value.trim();
      dlg.enable('Add', ok);
      const hc = handleCheck(handle.input, takenIn(v));
      dlg.error(hc.ok ? '' : hc.why);
    };
    proj.input.addEventListener('input', sync);
    handle.input.addEventListener('input', sync);
    const list = await recipes();
    if (!current()) return dlg;
    pickRecipe.options(list.map((rc) => ({ value: rc.id, label: rc.name, sub: recipeDescription(rc, deps.platform) })));
    if (seatRuleApplies()) {
      // the one rule, always under the list; with no Claude recipe the list says so and the Add an agent button is the way on
      const note = el('p', 'wr-dlgx wr-seatrule', SEAT_WORDS.rule); note.dataset.wbTest = 'seat-rule';
      recipeWrap.appendChild(note);
      if (!list.length) { const none = el('p', 'wr-dlgx wr-seatnone', SEAT_WORDS.noClaude); none.dataset.wbTest = 'seat-none'; recipeWrap.insertBefore(none, note); }
    } else if (!list.length) {
      dlg.error(WORDS.noRecipes);
    }
    return dlg;
  }

  // ---- How it runs
  function howItRuns(roomId, v, s, preset) {
    const body = el('div', 'wr-dlgform wr-radios');
    body.setAttribute('role', 'radiogroup');
    let pick = preset || s.policy || 'persistent';
    let size = Math.max(1, Math.min(8, Number(s.pool_size) || 3));
    const stepVal = el('span', 'wr-stepv', String(size));
    const stepper = el('span', 'wr-step');
    const dec = el('button', 'wr-ib', '');
    dec.type = 'button';
    dec.innerHTML = icon('remove');
    dec.setAttribute('aria-label', 'Fewer');
    const inc = el('button', 'wr-ib', '');
    inc.type = 'button';
    inc.innerHTML = icon('add');
    inc.setAttribute('aria-label', 'More');
    const paintStep = () => {
      stepVal.textContent = String(size);
      dec.disabled = size <= 1;
      inc.disabled = size >= 8;
    };
    dec.addEventListener('click', () => {
      size = Math.max(1, size - 1);
      paintStep();
    });
    inc.addEventListener('click', () => {
      size = Math.min(8, size + 1);
      paintStep();
    });
    paintStep();
    for (const [k, label, sub] of WORDS.policies) {
      const row = el('label', 'wr-radio');
      const i = el('input');
      i.type = 'radio';
      i.name = 'wr-policy';
      i.value = k;
      i.checked = k === pick;
      i.addEventListener('change', () => {
        pick = k;
        stepper.hidden = pick !== 'pool';
      });
      const tx = el('span', 'wr-radiot');
      tx.appendChild(el('span', 'wr-radion', label));
      if (k === 'pool') {
        const line = el('span', 'wr-radios2');
        line.append(document.createTextNode('Up to '), stepper, document.createTextNode(' at once, shared out'));
        stepper.append(dec, stepVal, inc);
        tx.appendChild(line);
      } else {
        tx.appendChild(el('span', 'wr-radios2', sub));
      }
      row.append(i, tx);
      body.appendChild(row);
    }
    stepper.hidden = pick !== 'pool';
    return dialog({
      title: WORDS.howTitle(s.handle),
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save',
          kind: 'filled',
          primary: true,
          fn: async () => {
            const a = { policy: pick };
            if (pick === 'pool') {
              a.pool_size = size;
            }
            const r = await R().seatPatch(roomId, s.id, a);
            return !fail(r);
          },
        },
      ],
    });
  }

  // ---- Rename (a seat)
  function renameSeat(roomId, v, s) {
    const f = textField({ label: 'Handle', name: 'handle', value: s.handle, maxLength: 40 });
    const dlg = dialog({
      title: WORDS.renameTitle,
      body: f.el,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Rename',
          kind: 'filled',
          primary: true,
          fn: async () => {
            const hc = handleCheck(f.input, takenIn(v, s));
            if (!hc.ok || !hc.value) {
              dlg.error(hc.why || WORDS.handleBad);
              return false;
            }
            if (hc.value === s.handle) {
              return true;
            }
            const r = await R().seatPatch(roomId, s.id, { handle: hc.value });
            if (!current()) return false;
            const why = httpWhy(r, "Couldn't rename the seat.");
            if (why) {
              dlg.error(why);
              return false;
            }
            return true;
          },
        },
      ],
    });
    f.input.addEventListener('input', () => {
      const hc = handleCheck(f.input, takenIn(v, s));
      dlg.error(hc.ok ? '' : hc.why);
      dlg.enable('Rename', hc.ok && !!hc.value);
    });
    requestAnimationFrame(() => f.input.select());
    return dlg;
  }

  // ---- Make lead, Remove (both ask first)
  function makeLead(roomId, v, s) {
    return dialog({
      title: WORDS.leadTitle(s.handle, deps.roomName(roomId)),
      text: WORDS.leadText,
      actions: [
        { label: 'Cancel' },
        { label: 'Make lead', kind: 'filled', primary: true, fn: async () => !fail(await R().patch(roomId, { lead_seat: s.id })) },
      ],
    });
  }
  function removeSeat(roomId, v, s) {
    return dialog({
      title: WORDS.removeTitle(s.handle, deps.roomName(roomId)),
      text: WORDS.removeText,
      actions: [
        { label: 'Cancel' },
        { label: 'Remove', kind: 'error', primary: true, fn: async () => !fail(await R().seatRemove(roomId, s.id)) },
      ],
    });
  }

  // ---- the room's ⋯
  function roomMenu(roomId, at) {
    if (!current()) return null;
    const v = deps.view(roomId);
    if (!v || !v.room) {
      return null;
    }
    const isGroup = !!v.room.parent_id;
    const mode = v.room.mode === 'autonomous' ? 'autonomous' : 'off';
    const items = [
      { id: 'rename-room', label: 'Rename…', icon: 'edit', fn: () => renameRoom(roomId) },
      ...(deps.setConnected ? [{ id: 'room-connection',
        label: deps.disconnected(roomId) ? 'Reconnect room' : 'Disconnect room',
        icon: deps.disconnected(roomId) ? 'undo' : 'power_settings_new',
        tip: deps.disconnected(roomId) ? 'Opens the live connection again.' : 'Closes the live connection. The room stays in the list.',
        fn: () => deps.setConnected(roomId, deps.disconnected(roomId)),
      }] : []),
      ...(!isGroup&&!deps.disconnected?.(roomId)&&deps.canSaveTemplate?.(roomId)===true?[{id:'save-template',label:'Save as template…',icon:'save',fn:()=>{if(current()&&deps.canSaveTemplate?.(roomId)===true)deps.saveTemplate?.(roomId);}}]:[]),
      {
        id: 'brief',
        label: 'Brief',
        icon: 'info',
        sub: [
          { id: 'brief-show', label: 'Show', icon: 'visibility', fn: () => deps.openSide('brief', 'show') },
          { id: 'brief-edit', label: 'Edit', icon: 'edit', fn: () => deps.openSide('brief', 'edit') },
          { id: 'brief-clear', label: 'Clear', icon: 'backspace', disabled: !v.room.brief, fn: () => clearBrief(roomId) },
        ],
      },
      ...(deps.phoneMenuRows ? deps.phoneMenuRows() : []),
      { id: 'mode', label: 'Mode', icon: 'autoplay', sub: WORDS.modes.map(([k, label]) => ({ id: 'mode-' + k, label, checked: mode === k, tip: WORDS.modes.find((m) => m[0] === k)[2], fn: () => setMode(roomId, k) })) },
      { id: 'notes', label: 'Notes', icon: 'sticky_note_2', fn: () => deps.openSide('notes') },
      { id: 'color', label: 'Color…', icon: 'palette', fn: () => colorRoom(roomId) },
      ...(isGroup ? [] : [{ id: 'new-group', label: 'New workgroup…', icon: 'add', fn: () => newWorkgroup(roomId) }]),
      ...(isGroup || !deps.hideRoom ? [] : [{ id: 'hide', label: 'Hide for me', icon: 'visibility_off', fn: () => deps.hideRoom(roomId) }]),
      { divider: true },
      isGroup ? { id: 'dissolve', label: 'Dissolve workgroup…', icon: 'call_split', error: true, fn: () => dissolve(roomId) } : { id: 'archive', label: 'Archive…', icon: 'archive', error: true, fn: () => archive(roomId) },
    ];
    return openMenu(host, at, guardItems(deps.disconnected?.(roomId) ? items.slice(0, 2) : items));
  }
  // Color… (the design's "Colors"): the room's color, one of the twelve swatches; it tints the plate, the rail's
  // band and (C1) the page
  function colorRoom(roomId) {
    const v = deps.view(roomId);
    const cur = String((v && v.room && v.room.color) || '').toLowerCase();
    let dlg = null;
    const picker = createColorSwatches({
      choices: SWATCHES.map(color => ({value:color.toLowerCase(),label:color,seed:color})),
      value:cur,label:'Room color',current,
      paint:(face,choice)=>m3.applyTo(face,choice.seed,m3.get().style),
      choose:async color => {
        if (!current()) return false;
        if (fail(await R().settings(roomId, {color}))) return false;
        if (!current()) return false;
        dlg?.close(); return true;
      },
    });
    dlg = dialog({title:'Color for '+deps.roomName(roomId),body:picker.el,actions:[{label:'Cancel'}],onClose:()=>picker.dispose()});
    return dlg;
  }
  function renameRoom(roomId) {
    const v = deps.view(roomId);
    const f = textField({ label: 'Name', name: 'name', value: v.room.name, maxLength: 80 });
    const dlg = dialog({
      title: WORDS.renameRoom,
      body: f.el,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Rename',
          kind: 'filled',
          primary: true,
          fn: async () => {
            const name = f.input.value.trim();
            if (!name) {
              dlg.error('Say what the room is called.');
              return false;
            }
            return name === v.room.name || !fail(await R().patch(roomId, { name }));
          },
        },
      ],
    });
    f.input.addEventListener('input', () => dlg.enable('Rename', !!f.input.value.trim()));
    requestAnimationFrame(() => f.input.select());
    return dlg;
  }
  async function setMode(roomId, mode) {
    fail(await R().patch(roomId, { mode }));
  }
  function clearBrief(roomId) {
    return dialog({
      title: WORDS.clearBriefTitle,
      text: WORDS.clearBriefText,
      actions: [
        { label: 'Cancel' },
        { label: 'Clear', kind: 'error', primary: true, fn: async () => !fail(await R().patch(roomId, { brief: '' })) },
      ],
    });
  }
  function archive(roomId) {
    return dialog({
      title: WORDS.archiveTitle(deps.roomName(roomId)),
      text: WORDS.archiveText,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Archive',
          kind: 'error',
          primary: true,
          fn: async () => {
            if (fail(await R().state(roomId, 'archive'))) {
              return false;
            }
            if (deps.afterArchive) {
              deps.afterArchive(roomId); // it leaves All rooms: its tab closes
            }
            return true;
          },
        },
      ],
    });
  }
  function dissolve(roomId) {
    const v = deps.view(roomId);
    return dialog({
      title: WORDS.dissolveTitle(deps.roomName(roomId)),
      text: WORDS.dissolveText,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Dissolve',
          kind: 'error',
          primary: true,
          fn: async () => {
            const r = await R().state(roomId, 'dissolve');
            if (fail(r)) {
              return false;
            }
            deps.afterDissolve(v.room.parent_id);
            return true;
          },
        },
      ],
    });
  }

  // ---- a checklist (recipes, seats) for the two "new" forms
  function checklist(items, { leadTag } = {}) {
    const box = el('div', 'wr-checks');
    const order = []; // the order things were checked: the first is the lead
    const paint = () => {
      for (const row of box.children) {
        const tag = row.querySelector('.wr-leadtag');
        if (tag) {
          tag.hidden = !leadTag || order[0] !== row.dataset.id;
        }
      }
    };
    for (const it of items) {
      const row = el('label', 'wr-check');
      row.dataset.id = it.id;
      const c = el('input');
      c.type = 'checkbox';
      c.value = it.id;
      c.addEventListener('change', () => {
        const i = order.indexOf(it.id);
        if (c.checked && i < 0) {
          order.push(it.id);
        } else if (!c.checked && i >= 0) {
          order.splice(i, 1);
        }
        paint();
        box.dispatchEvent(new Event('change'));
      });
      const tx = el('span', 'wr-checkt');
      const nm = el('span', 'wr-checkn', it.label);
      if (leadTag) {
        const t = el('span', 'wr-lead wr-leadtag', 'Lead'); // beside the name
        t.hidden = true;
        nm.appendChild(t);
      }
      tx.appendChild(nm);
      if (it.sub) {
        tx.appendChild(el('span', 'wr-checks2', it.sub));
      }
      row.append(c, tx);
      box.appendChild(row);
    }
    return { el: box, picked: () => order.slice() };
  }

  // 0.24.0 exposes only the local destination; it never remembers or dispatches
  // a server choice. Keep the server cards visible so the boundary is explicit.
  async function chooseRoomPlace(state) {
    if (deps.canCreateRoom && !deps.canCreateRoom()) return null;
    return new Promise(resolve => {
      const body = el('div', 'wr-dlgform');
      for (const place of [{ id: 'local', name: WEB() ? 'This server' : 'This computer' }, ...state.servers]) {
        const local = place.id === 'local';
        const row = el('label', 'lf-place');
        const input = el('input'); input.type = 'radio'; input.name = 'room-place';
        input.value = place.id; input.checked = local; input.disabled = !local;
        const words = el('span'); words.append(el('strong', null, place.name),
          el('span', 'lf-secondary', local ? (WEB() ? 'Runs on this server.' : 'Stays on this computer. Works offline.') : 'Not available in this version.'));
        if (!local) { row.style.opacity = '0.5'; row.setAttribute('aria-disabled', 'true'); }
        row.append(input, words); body.appendChild(row);
      }
      dialog({ title: 'Where should this room live?', body,
        actions: [{ label: 'Cancel', fn: () => { resolve(null); return true; } },
          { label: 'Continue', kind: 'filled', primary: true, fn: () => {
            if (deps.canCreateRoom && !deps.canCreateRoom()) { resolve(null); return true; }
            resolve('local'); return true;
          } }],
        onClose: () => resolve(null),
      });
    });
  }

  // ---- New room (All rooms): a name, a handle, who sits in it; the first one picked is the lead
  async function newRoom() {
    if (deps.canCreateRoom && !deps.canCreateRoom()) return;
    const body = el('div', 'wr-dlgform');
    const name = textField({ label: 'Name', name: 'name', maxLength: 80 });
    const alias = textField({ label: 'Handle (optional)', name: 'alias', hint: WORDS.newRoomHandleHint, maxLength: 40 });
    body.append(name.el, alias.el, el('div', 'wr-dlgsub', WORDS.whoSits));
    const holder = el('div', 'wr-checkhold', 'Loading recipes…');
    body.appendChild(holder);
    let checks = null;
    const dlg = dialog({
      title: WORDS.newRoom,
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create room',
          kind: 'filled',
          primary: true,
          disabled: true,
          fn: async () => {
            if (deps.canCreateRoom && !deps.canCreateRoom()) return false;
            const n = name.input.value.trim();
            const hc = handleCheck(alias.input, null);
            if (!hc.ok) {
              dlg.error(hc.why);
              return false;
            }
            const picked = checks ? checks.picked() : [];
            const r = await R().create({ name: n, ...(hc.value ? { alias: hc.value } : {}) });
            if (!current()) return false;
            if (!r || !r.ok || !r.value || !r.value.id) {
              dlg.error((r && r.message) || "Couldn't make the room.");
              return false;
            }
            const id = r.value.id;
            let leadId = null;
            for (const rid of picked) {
              const a = await R().seatAdd(id, { recipe_id: rid });
              if (!current()) return false;
              if (a && a.ok && a.value && a.value.seat && !leadId) {
                leadId = a.value.seat.id;
              }
            }
            if (leadId) {
              await R().patch(id, { lead_seat: leadId });
              if (!current()) return false;
            }
            deps.openRoom(id, id); // "Opens the room in a new tab"
            return true;
          },
        },
      ],
    });
    const sync = () => dlg.enable('Create room', !!name.input.value.trim());
    name.input.addEventListener('input', sync);
    alias.input.addEventListener('input', () => {
      const hc = handleCheck(alias.input, null);
      dlg.error(hc.ok ? '' : hc.why);
    });
    const list = await recipes();
    if (!current()) return dlg;
    holder.textContent = '';
    if (!list.length) {
      holder.appendChild(el('div', 'wr-dlgsub wr-recipes-empty-title', seatRuleApplies() ? SEAT_WORDS.noClaude : 'No recipes yet'));
      holder.appendChild(el('p', 'wr-dlgx wr-recipes-empty-body', 'A recipe starts a program in a folder with one click. Make one to give this room a seat. You can also create the room now and add seats later.'));
      const make = el('button', 'wr-dlgbtn tonal', seatRuleApplies() ? 'Add an agent' : 'New recipe');
      make.type = 'button';
      make.addEventListener('click', () => {
        if (!current()) return;
        dlg.close(); openAgentFromRoom();
      });
      holder.appendChild(make);
    } else {
      checks = checklist(list.map((rc) => ({ id: rc.id, label: rc.name, sub: recipeDescription(rc, deps.platform) })), { leadTag: true });
      checks.el.addEventListener('change', sync);
      holder.appendChild(checks.el);
    }
    if (seatRuleApplies()) { const note = el('p', 'wr-dlgx wr-seatrule', SEAT_WORDS.rule); note.dataset.wbTest = 'seat-rule'; holder.appendChild(note); }
    sync();
    return dlg;
  }

  // ---- New workgroup (a main room's +): a name, a handle, seats moved in, recipes started
  async function newWorkgroup(roomId) {
    const v = deps.view(roomId);
    const body = el('div', 'wr-dlgform');
    const name = textField({ label: 'Name', name: 'name', maxLength: 80 });
    const alias = textField({ label: 'Handle (optional)', name: 'alias', maxLength: 40 });
    body.append(name.el, alias.el);
    const seats = ((v && v.seats) || []).filter((x) => !x.left_at);
    let move = null;
    if (seats.length) {
      body.appendChild(el('div', 'wr-dlgsub', WORDS.moveIn));
      move = checklist(seats.map((x) => ({ id: x.id, label: '@' + x.handle, sub: seatState(x) })));
      body.appendChild(move.el);
    }
    body.appendChild(el('div', 'wr-dlgsub', WORDS.startRecipes));
    const holder = el('div', 'wr-checkhold', 'Loading recipes…');
    body.appendChild(holder);
    let start = null;
    const dlg = dialog({
      title: WORDS.newGroupTitle(deps.roomName(roomId)),
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create',
          kind: 'filled',
          primary: true,
          disabled: true,
          fn: async () => {
            const hc = handleCheck(alias.input, null);
            if (!hc.ok) {
              dlg.error(hc.why);
              return false;
            }
            const a = { name: name.input.value.trim(), ...(hc.value ? { alias: hc.value } : {}), move: move ? move.picked() : [], start: (start ? start.picked() : []).map((recipe_id) => ({ recipe_id })) };
            const r = await R().workgroup(roomId, a);
            if (!current()) return false;
            if (!r || !r.ok) {
              dlg.error((r && r.message) || "Couldn't make the workgroup.");
              return false;
            }
            const gid = r.value && r.value.room ? r.value.room.id : null;
            if (gid) {
              deps.openRoom(v.room.id, gid);
            }
            return true;
          },
        },
      ],
    });
    name.input.addEventListener('input', () => dlg.enable('Create', !!name.input.value.trim()));
    const list = await recipes();
    if (!current()) return dlg;
    holder.textContent = '';
    if (!list.length) {
      holder.textContent = WORDS.noRecipes;
    } else {
      start = checklist(list.map((rc) => ({ id: rc.id, label: rc.name, sub: recipeDescription(rc, deps.platform) })));
      holder.appendChild(start.el);
    }
    return dlg;
  }

  function resetAccount() {
    alive = false;
    for (const dlg of dialogs) dlg.close();
    dialogs.clear();
    closeMenus(host);
  }
  return { current, resetAccount, seatRow, seatMenu, seatItems, colorRoom, addSeat, howItRuns, renameSeat, makeLead, removeSeat, roomMenu, renameRoom, chooseRoomPlace, newRoom, newWorkgroup, archive, dissolve, clearBrief, recipes, start, startWhy };
}
