/* ROOM CHARACTER (the design system room-character v1.1, the design system 9a21656 / 558005d, and
 * Owner's final art ruling 2026-09-28) [rooms/character]
 *
 * Owner can't tell rooms apart. A room gets ART from the same library recipes
 * use, a WASH, and its own ACCENT, all from the one room colour:
 *
 *   - THE LINE COLUMN IS DRAWN LIKE A TERMINAL PANE, with the existing helpers
 *     exactly as solo.js draws its watermark: renderLogo(host, logo, {pane})
 *     + paintWatermarkVars(pane, logo, colour). The art's OWN stored settings
 *     (line, washFrom, backlit, scale, opacity) apply as-is and the mark is
 *     centred. Owner, 2026-09-28: "the only thing I want to override is the
 *     room's colour" — so --wm-pc is the room colour, never the art's. FINAL
 *     RULING: the art renders EXACTLY as an agent pane does — one --wm-ink
 *     tint and the .wm-backlit glow (--wm-glow), both from --wm-pc. No
 *     room-specific rendering and no "use the art's colours" path.
 *   - The header takes a 72px mark behind the name (the v30 session-bar rule),
 *     drawn with the art's line style + glow (window-chrome v32 hwbMarkClass),
 *     over the bundle's .hwb-barwash — the agent tab/bar wash, which the shell
 *     fans out from the room tab ({chrome:'bar-wash', x, core}, below).
 *   - The accent (room-character.css): --room-accent exists only while the
 *     room colour is SET. CSS cannot branch on hue, so the coral/amber guard
 *     lives here: a room hue within 20 degrees of coral (~29) or amber (~84)
 *     caps the accent chroma at .06 (--rm-cmax), so a red room's Send reads as
 *     a tinted neutral, not an alarm.
 *   - An UNSET colour with no art is today's page exactly: no wash, no mark,
 *     no accent.
 *
 * The page's settings column gets an Art group (artSettingsGroup): a 72px
 * preview drawn by the same method, Choose art... (the recipe form's picker,
 * openLogoModal — reused, not forked), Remove, and a dim line naming the art's
 * own style. No style controls: style
 * belongs to the art (the Icons page).
 */
import { renderLogo, paintWatermarkVars, assetStyle, wmFields, sanitizeSvg, openLogoModal } from '/logo-modal.mjs';
/* window-chrome v32: art drawn as a MARK takes the art's line style + glow */
import { hwbMarkClass } from '/aurora/window-chrome/hwb-chrome.js';
/* [hub-v2] the tile that replaces the room art, this room's palette override, and the
   line wash's Spot | Edge (the ONLY writer of --wm-wash / --wm-term). With none of
   them set the paint path below is today's, untouched. */
import { paintTile } from '/room-tile.mjs';
import { paintRoomPalette } from '/room-palette.mjs';
import { applyWash, setSpotAt } from '/room-wash.mjs';
import { applyGlass } from '/room-glass.mjs';

/* ---- colour: hex -> OKLCH hue, and the coral / amber guard ---- */

const CORAL_HUE = 29;
const AMBER_HUE = 84;
const GUARD_DEG = 20;
export const GUARDED_CMAX = 0.06;

function lin(u) {
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}

/** #rrggbb -> {l, c, h} in OKLCH (h in degrees, 0..360). */
export function hexToOklch(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) {
    return null;
  }
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => lin(parseInt(x, 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: (h + 360) % 360 };
}

const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** The accent chroma cap for a room colour: GUARDED_CMAX near coral or amber,
 *  else null (the CSS default .14 stands). A near-grey has no meaningful hue
 *  and no chroma to cap, so it is never guarded. */
export function accentCap(hex) {
  const o = hexToOklch(hex);
  if (!o || o.c < 0.02) {
    return null;
  }
  return hueDist(o.h, CORAL_HUE) < GUARD_DEG || hueDist(o.h, AMBER_HUE) < GUARD_DEG ? GUARDED_CMAX : null;
}

/* ---- the art ---- */

/** The logo object renderLogo draws for this room: the art as authored plus
 *  the ART's own settings (assetStyle defaults a preset / an unstyled set to
 *  LOGO_DEFAULTS). Null when the room has no (resolvable) art. */
export function roomLogo(room) {
  const a = room && room.art_render;
  if (!a || typeof a.svg !== 'string' || !a.svg) {
    return null;
  }
  const st = assetStyle({ style: a.style });
  return {
    key: a.key, svg: a.svg, scale: st.scale, opacity: st.opacity, mono: 'white',
    line: st.line, washFrom: st.washFrom, backlit: st.backlit,
  };
}

/** Draw `logo` into `host` over the pane `pane` EXACTLY as solo.js draws a
 *  pane's watermark (renderLogo + paintWatermarkVars) — the only renderer,
 *  with the room colour as --wm-pc. `logo` null = the wash alone (a set
 *  colour, no art). */
export function drawArt(host, pane, logo, colour) {
  renderLogo(host, logo, { pane });
  paintWatermarkVars(pane, logo, colour);
}

/** Take the pane look off again (an unset colour with no art = today). */
function clearArt(host, pane) {
  [...pane.classList].filter((c) => c === 'wm-pane' || c.startsWith('wm-at-')).forEach((c) => pane.classList.remove(c));
  pane.style.removeProperty('--wm-pc');
  pane.style.removeProperty('--wm-op');
  host.innerHTML = '';
  host.style.display = 'none';
}

/* Our layers are APPENDED (never prepended) and made only when needed, so a
   room with no character has exactly today's DOM; they are absolutely placed
   and sit under the content by z-index, so DOM order does not paint them. */
function ensureChild(parent, cls, create = true) {
  let el = parent.querySelector(`:scope > .${cls}`);
  if (!el && create) {
    el = document.createElement('div');
    el.className = cls;
    el.setAttribute('aria-hidden', 'true');
    parent.append(el);
  }
  return el;
}

/** The art's {line, backlit} — the style blob v32's marks take. */
export function markStyle(logo) {
  if (!logo) {
    return null;
  }
  const w = wmFields(logo);
  return { line: w.line, backlit: w.backlit };
}

/** The 72px header mark: a 14% ghost in the bar ink, with the art's line
 *  style + glow (hwbMarkClass, the same classes the tabs and the bar use). */
function paintHeaderMark(header, logo) {
  if (!header) {
    return;
  }
  const clip = ensureChild(header, 'rc-hmark', !!logo);
  if (!clip) {
    return;
  }
  clip.hidden = !logo;
  clip.innerHTML = logo ? `<span class="mark${hwbMarkClass(markStyle(logo))}">${sanitizeSvg(logo.svg)}</span>` : '';
}

/* THE BAR WASH, positioned by the shell. Inside the CLI Manager the room
   page's header fans out from the room TAB, exactly like the session bar under
   an agent tab: the shell measures hwbPositionBarWash on activate / render /
   resize and posts {chrome:'bar-wash', x, core} (in this frame's coordinates).
   Standalone nothing is posted and the bundle's 105px default stands. */
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (ev.source !== window.parent || ev.source === window || !d || d.chrome !== 'bar-wash') {
    return;
  }
  const x = Number(d.x);
  const core = Number(d.core);
  for (const h of document.querySelectorAll('.rm-top.hwb-barwash, .ph-hdr.hwb-barwash')) {
    if (Number.isFinite(x) && Number.isFinite(core) && core > 0) {
      h.style.setProperty('--bar-wash-x', `${Math.round(x)}px`);
      h.style.setProperty('--bar-wash-core', `${Math.round(core)}px`);
    } else {
      h.style.removeProperty('--bar-wash-x');
      h.style.removeProperty('--bar-wash-core');
    }
  }
});

/**
 * Paint the room's character from its view. `colour` is the effective room
 * colour (the room's own, else the lead's, else neutral: room.js's --room-c).
 * Idempotent; called on every room view / push / save.
 */
export function paintRoomCharacter(room, colour) {
  const body = document.body;
  const set = !!(room && room.color);
  const cap = set ? accentCap(room.color) : null;
  if (cap) {
    body.style.setProperty('--rm-cmax', String(cap));
  } else {
    body.style.removeProperty('--rm-cmax');
  }
  const logo = roomLogo(room);
  body.dataset.roomArt = logo ? 'on' : 'none';
  const line = document.getElementById('roomLine');
  if (line) {
    const host = ensureChild(line, 'rc-art', set || !!logo);
    if (host && (set || logo)) {
      drawArt(host, line, logo, colour);
    } else if (host) {
      clearArt(host, line);
    }
  }
  paintHeaderMark(document.querySelector('.rm-top'), logo);
  paintHeaderMark(document.querySelector('.ph-hdr'), logo);
  /* [hub-v2] */
  if (line) {
    paintTile(line, (room && room.art_tile) || null);
  }
  setSpotAt(room && room.wash_at); // null = no --wm-at written, the art's own origin
  applyWash();
  applyGlass(room && room.bubble_glass); // [bubble glass] null writes nothing: the stylesheet's defaults
  void paintRoomPalette(room); // the 'room-palette' event re-applies the wash for the mode it brought
  /* the settings column's preview follows every repaint (a new colour, a push) */
  if (openGroup && openGroup.el.isConnected) {
    openGroup.repaint();
  }
}

document.addEventListener('room-palette', applyWash);

/** The Art group currently built into the settings column, if any. */
let openGroup = null;

/** The room tab's identity override: the room's art is the tab's mark (the
 *  unselected-tab watermark), keyed like a recipe's. Null = no art (the tab
 *  keeps the lead's mark, today's rule). */
export function characterMark(room) {
  const logo = roomLogo(room);
  return logo ? { logoKey: logo.key || null, mark: sanitizeSvg(logo.svg), markStyle: markStyle(logo) } : null;
}

/* ---- the settings column's Art group ---- */

const LINE_WORD = { none: 'solid', outline: 'outline', blueprint: 'blueprint', hatch: 'hatch', engrave: 'engrave', halftone: 'halftone' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

/**
 * The Art group: Art (a 72px live preview + Choose art... + Remove) ->
 * "From the art: ...".  Each change SAVES at once through
 * `save(patch, msg)` (room.js saveSettings — the same immediate-save the colour
 * swatches use), and the page behind repaints from the reply.
 *   getRoom()   the current room view (state.room)
 *   getColour() the effective room colour (--room-c)
 */
export function artSettingsGroup({ getRoom, getColour, save }) {
  const g = el('div', 'pv-grp rc-grp');
  g.append(el('h4', '', 'Room art'));
  const row = el('div', 'rc-artrow');
  const prev = el('div', 'rc-prev');
  prev.setAttribute('aria-label', 'Art preview');
  const prevArt = el('div', 'rc-art');
  const none = el('span', 'rc-prev-none', 'no art');
  prev.append(prevArt, none);
  const btns = el('div', 'rc-artbtns');
  const choose = el('button', 'pv-btn pri', 'Choose art…');
  choose.type = 'button';
  const remove = el('button', 'pv-btn', 'Remove');
  remove.type = 'button';
  const name = el('span', 'rc-artname');
  btns.append(choose, remove, name);
  row.append(prev, btns);

  const from = el('p', 'rc-from');
  const msg = el('p', 'pv-msg');
  msg.setAttribute('role', 'status');
  g.append(row, from, msg);

  const paint = () => {
    const room = getRoom() || {};
    const logo = roomLogo(room);
    if (logo) {
      drawArt(prevArt, prev, logo, getColour());
    } else if (room.color) {
      drawArt(prevArt, prev, null, getColour());
    } else {
      clearArt(prevArt, prev);
    }
    none.hidden = !!logo;
    remove.hidden = !room.art;
    name.textContent = logo ? (room.art_render.name || room.art) : room.art ? `${room.art} (not in the library)` : '';
    from.textContent = '';
    if (logo) {
      const w = wmFields(logo);
      from.append(
        `From the art: ${LINE_WORD[w.line] || w.line} · wash from ${w.washFrom}${w.backlit ? ' · backlit' : ''} · ${logo.scale}% · ${logo.opacity}%. `,
      );
      const a = el('a', '', 'Edit it on the Art page.');
      a.href = '/art.html';
      a.target = '_blank';
      a.rel = 'noopener';
      from.append(a);
    } else {
      from.append('No art: the line takes the room color as its wash.');
    }
  };

  choose.addEventListener('click', () => {
    const room = getRoom() || {};
    const logo = roomLogo(room);
    openLogoModal({
      current: logo,
      color: getColour(),
      onSave: async (picked) => {
        try {
          if (!picked) {
            await save({ art: null }, msg);
          } else if (!picked.key) {
            /* a pasted one-off has no key, and a room stores only a key */
            msg.textContent = 'Pick art from the presets or the library (or save the pasted SVG to the library first).';
            msg.dataset.kind = 'error';
          } else {
            await save({ art: picked.key }, msg);
          }
        } catch (e) {
          msg.textContent = `Not saved: ${e?.message ?? e}`;
          msg.dataset.kind = 'error';
        }
        paint();
      },
    });
  });
  remove.addEventListener('click', async () => {
    try {
      await save({ art: null }, msg);
    } catch (e) {
      msg.textContent = `Not saved: ${e?.message ?? e}`;
      msg.dataset.kind = 'error';
    }
    paint();
  });
  paint();
  openGroup = { el: g, repaint: paint };
  return openGroup;
}
