/* ROOM SETTINGS: Art, Palette and Room color [hub-v2] (Owner 2026-10-05, the design system b0f8099
 * sec 1.E/F/G; the spec is the hub's room-settings focus, hub/v2.js L484-520).
 *
 *   Art      a radio: Tiled artwork (tile, preview, Wash blend, Art level,
 *            Wash strength, Tile zoom) OR Room art (today's watermark group,
 *            wrapped UNCHANGED: HELD, Owner 2026-10-05), then the Line wash
 *            Spot | Edge range, which works with either art.
 *   Palette  this room's own palette + Dark/Light, or "Follows global".
 *   Color    rows: Art color (the tile's dominant colors) · Palette color ·
 *            Lead's color (= unset, today's inherited color) · Sample colors ·
 *            Custom. The tab/ink/wash/tint/edge chips stay.
 *
 * Every change saves at once through `save(patch, msg)` (room.js saveSettings),
 * the same immediate-save the swatches always used, and the page repaints from
 * the reply. A slider repaints the line LIVE on `input` and saves on `change`.
 */
import { PALETTES } from '/palette.mjs';
import { BLENDS, SET_LABELS, TILES, defaultTile, extractColors, tileById } from '/room-tile.mjs';
import { mountWashSlider, mountSpotPad } from '/room-wash.mjs';
import { mountGlassSlider } from '/room-glass.mjs';
import { globalPref, paletteRoomColor } from '/room-palette.mjs';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}
const msgBox = () => {
  const m = h('p', 'pv-msg');
  m.setAttribute('role', 'status');
  return m;
};

/** The room-look palettes a room may carry (every named one; a custom set is the person's). */
const NAMED = Object.entries(PALETTES).filter(([, p]) => !p.custom);

/**
 * @param {object} o
 *   getRoom()          state.room
 *   save(patch, msg)   room.js saveSettings -> Promise<boolean>
 *   live(tile)         repaint the line from a tile choice, unsaved (a slider mid-drag)
 *   roomArtEl          today's watermark group (room-character artSettingsGroup().el), moved in unchanged
 *   leadColor()        the lead seat's project color or null
 *   neutral            the neutral room color (no lead)
 *   leadName()         '@handle' of the lead or ''
 *   swatches, tones    the sample colors and the tone chips' names
 * @returns {{art: HTMLElement, palette: HTMLElement, color: HTMLElement, repaint: () => void}}
 */
export function roomLookGroups(o) {
  /* ================= ART ================= */
  const art = h('div', 'pv-grp rs-artgrp');
  art.append(h('h4', '', 'Art'));
  const radio = h('div', 'rs-radio');
  const optTile = h('div', 'rs-opt');
  const optRoom = h('div', 'rs-opt');
  const rTile = h('input');
  rTile.type = 'radio';
  rTile.name = 'rsart';
  const rRoom = h('input');
  rRoom.type = 'radio';
  rRoom.name = 'rsart';
  const lt = h('label');
  lt.append(rTile, ' Tiled artwork');
  const lr = h('label');
  lr.append(rRoom, ' Room art (the watermark)');
  /* the tile body */
  const bt = h('div', 'rs-body');
  const sel = h('select', 'pv-sel');
  sel.setAttribute('aria-label', 'Tile');
  sel.style.marginTop = '0';
  for (const set of ['tint', 'hue', 'colour']) {
    const g = h('optgroup');
    g.label = SET_LABELS[set];
    for (const t of TILES.filter((x) => x.set === set)) {
      const op = h('option', '', `${t.group} · ${t.name} · ${t.density}`);
      op.value = t.id;
      g.append(op);
    }
    sel.append(g);
  }
  const prev = h('div', 'rs-prev');
  prev.setAttribute('aria-label', 'Tile preview');
  const row = (label, ctl, out) => {
    const r = h('div', 'rs-row');
    r.append(h('span', '', label), ctl);
    if (out) {
      r.append(out);
    }
    return r;
  };
  const blend = h('select', 'pv-sel');
  blend.setAttribute('aria-label', 'Wash blend');
  for (const [k, n] of BLENDS) {
    const op = h('option', '', n);
    op.value = k;
    blend.append(op);
  }
  const range = (min, max, step, label) => {
    const i = h('input');
    i.type = 'range';
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.setAttribute('aria-label', label);
    return i;
  };
  const level = range(10, 100, 5, 'Art level');
  const strength = range(0, 100, 1, 'Wash strength');
  const zoom = range(50, 200, 10, 'Tile zoom');
  const oLevel = h('output');
  const oStrength = h('output');
  const oZoom = h('output');
  const note = h('p', 'pv-note', "The art is the background; the room-color wash sits in front of it with this blend, and Wash strength is the wash's strength. None = the art's own colors.");
  note.style.marginTop = '4px';
  const tmsg = msgBox();
  bt.append(sel, prev, row('Wash blend', blend), row('Art level', level, oLevel), note, row('Wash strength', strength, oStrength), row('Tile zoom', zoom, oZoom), tmsg);
  optTile.append(lt, bt);
  /* the room art body: today's group, wrapped (its own h4 is hidden by room-hub.css) */
  const br = h('div', 'rs-body');
  br.append(o.roomArtEl);
  optRoom.append(lr, br);
  radio.append(optTile, optRoom);
  const pick1 = h('p', 'pv-note', "Pick one: a repeating tile behind the chat, or the room's own art as today. Colour and hue tiles offer their colors as room colors below.");
  const washLabel = h('div', 'rs-row', 'Line wash · Spot | Edge');
  washLabel.style.marginTop = '12px';
  const washHost = h('div');
  const washNote = h('p', 'pv-note', 'The spot (lower left) and the edge it falls off to. Pull them apart for more contrast, together for an even wash; drag between them to make it all lighter or darker; double-click to reset. Works with either art.');
  washNote.style.marginTop = '2px';
  /* SPOT POSITION PAD [hub-v2 sec 1.I]: above Spot | Edge, for either art */
  const padHost = h('div');
  const padMsg = msgBox();
  /* BUBBLE GLASS [bubble glass] (Owner 2026-10-05): below Spot | Edge, one magnitude for PC and phone */
  const glassHost = h('div');
  const glassMsg = msgBox();
  art.append(radio, pick1, padHost, padMsg, washLabel, washHost, washNote, glassHost, glassMsg);
  const spot = mountSpotPad(padHost, (a) => o.save({ wash_at: a }, padMsg));
  const wash = mountWashSlider(washHost);
  const glass = mountGlassSlider(glassHost, () => o.getRoom()?.bubble_glass ?? null, (g) => o.save({ bubble_glass: g }, glassMsg));

  const curTile = () => o.getRoom()?.art_tile || null;
  const draft = () => {
    const c = curTile();
    return c ? { ...c } : defaultTile(sel.value || TILES[0].id);
  };
  const fromControls = () => ({
    id: sel.value, blend: blend.value, level: +level.value, strength: +strength.value, zoom: +zoom.value,
  });
  async function saveTile(tile, extra) {
    await o.save({ art_tile: tile, ...(extra || {}) }, tmsg);
    paint();
  }
  /* Picking a tile resets the blend + strength to its set's defaults (level and zoom are the
     person's), and a colour or hue tile offers its first art color as the room color. */
  async function pickTile(id) {
    const c = curTile();
    const d = defaultTile(id);
    const tile = c ? { ...d, level: c.level, zoom: c.zoom } : d;
    const t = tileById(id);
    let extra;
    if (t && t.set !== 'tint') {
      const cols = await extractColors(id);
      if (cols[0]) {
        extra = { color: cols[0] };
      }
    }
    await saveTile(tile, extra);
  }
  rTile.addEventListener('change', () => void pickTile(sel.value || TILES[0].id).catch((e) => fail(tmsg, e)));
  rRoom.addEventListener('change', () => void saveTile(null).catch((e) => fail(tmsg, e)));
  sel.addEventListener('change', () => void pickTile(sel.value).catch((e) => fail(tmsg, e)));
  blend.addEventListener('change', () => void saveTile({ ...draft(), blend: blend.value }).catch((e) => fail(tmsg, e)));
  for (const [inp, out, suffix] of [[level, oLevel, '%'], [strength, oStrength, '%'], [zoom, oZoom, '%']]) {
    inp.addEventListener('input', () => {
      out.textContent = `${inp.value}${suffix}`;
      if (curTile()) {
        o.live(fromControls()); // mid-drag: the line follows, nothing saved yet
      }
    });
    inp.addEventListener('change', () => void saveTile(fromControls()).catch((e) => fail(tmsg, e)));
  }

  /* ================= PALETTE ================= */
  const palette = h('div', 'pv-grp');
  palette.append(h('h4', '', 'Palette'));
  const prow = h('div', 'rs-pal');
  const psel = h('select', 'pv-sel');
  psel.setAttribute('aria-label', "This room's palette");
  const seg = h('span', 'rs-seg');
  const bDark = h('button', '', 'Dark');
  const bLight = h('button', '', 'Light');
  bDark.type = 'button';
  bLight.type = 'button';
  bDark.dataset.m = 'dark';
  bLight.dataset.m = 'light';
  seg.append(bDark, bLight);
  prow.append(psel, seg);
  const pnote = h('p', 'pv-note');
  const pnoteTxt = h('span');
  const reset = h('a', 'rs-reset', 'Reset to global');
  reset.href = '#';
  pnote.append(pnoteTxt, ' ', reset);
  const pmsg = msgBox();
  palette.append(prow, pnote, pmsg);
  psel.addEventListener('change', () => {
    const r = o.getRoom();
    void o.save(psel.value ? { pal: psel.value, pal_mode: r?.pal_mode || 'dark' } : { pal: null }, pmsg).then(paint).catch((e) => fail(pmsg, e));
  });
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (b && !b.disabled) {
      void o.save({ pal_mode: b.dataset.m }, pmsg).then(paint).catch((er) => fail(pmsg, er));
    }
  });
  reset.addEventListener('click', (e) => {
    e.preventDefault();
    void o.save({ pal: null }, pmsg).then(paint).catch((er) => fail(pmsg, er));
  });

  /* ================= ROOM COLOR ================= */
  const color = h('div', 'pv-grp');
  color.append(h('h4', '', 'Room color'));
  const rows = h('div', 'rc-rows');
  const cmsg = msgBox();
  const pickColor = (c) => void o.save({ color: c }, cmsg).then(paint).catch((e) => fail(cmsg, e));
  const sw = (c, title) => {
    const b = h('button', 'sw');
    b.type = 'button';
    b.style.setProperty('--c', c);
    b.title = title || c;
    b.setAttribute('aria-label', `Room color ${c}`);
    b.dataset.c = c;
    b.addEventListener('click', () => pickColor(c));
    return b;
  };
  const mkRow = (label) => {
    const r = h('div', 'rrow');
    r.append(h('span', 'rl', label));
    rows.append(r);
    return r;
  };
  const rArt = mkRow('Art color');
  const artSws = h('span', 'sws');
  const artHx = h('span', 'hx');
  rArt.append(artSws, artHx);
  const rPal = mkRow('Palette color');
  const palHost = h('span', 'sws');
  const palHx = h('span', 'hx');
  rPal.append(palHost, palHx);
  const rLead = mkRow("Lead's color");
  const leadHost = h('span', 'sws');
  const leadHx = h('span', 'hx');
  rLead.append(leadHost, leadHx);
  const rSample = mkRow('Sample colors');
  const sampleWrap = h('div', 'pv-sw');
  for (const c of o.swatches) {
    const b = h('button', 'pv-swatch');
    b.type = 'button';
    b.dataset.c = c;
    b.style.setProperty('--c', c);
    b.title = c;
    b.setAttribute('aria-label', `Room color ${c}`);
    b.addEventListener('click', () => pickColor(c));
    sampleWrap.append(b);
  }
  rSample.append(sampleWrap);
  const rCustom = mkRow('Custom color');
  const custom = h('button', 'pv-btn', 'Custom…');
  custom.type = 'button';
  const input = h('input');
  input.type = 'color';
  input.className = 'rm-sr';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  custom.addEventListener('click', () => {
    input.value = o.getRoom()?.color || '#1f8fa6';
    input.click();
  });
  input.addEventListener('change', () => pickColor(input.value.toLowerCase()));
  rCustom.append(custom, input);
  const chips = h('div', 'pv-pal');
  for (const t of o.tones) {
    chips.append(h('div', `pv-tone t-${t}`, t));
  }
  color.append(rows, chips,
    h('p', 'pv-note', "A set color is the room's accent too (Send, +, links, focus); danger and status keep their colors. Lead's color = unset: the lead seat's project color and today's teal."),
    cmsg);

  /* The Lead's color row: pressed while the room has no color of its own. */
  const leadC = o.leadColor() || o.neutral;
  const leadSw = h('button', 'sw');
  leadSw.type = 'button';
  leadSw.style.setProperty('--c', leadC);
  leadSw.title = "The lead seat's project color";
  leadSw.setAttribute('aria-label', "Lead's color");
  leadSw.addEventListener('click', () => pickColor(null));
  leadHost.append(leadSw);
  const palSw = h('button', 'sw');
  palSw.type = 'button';
  palSw.setAttribute('aria-label', 'Palette color');
  palHost.append(palSw);
  let palHex = null;
  palSw.addEventListener('click', () => {
    if (palHex) {
      pickColor(palHex);
    }
  });

  let seq = 0;
  function paint() {
    const r = o.getRoom() || {};
    const t = r.art_tile ? tileById(r.art_tile.id) : null;
    const isTile = !!t;
    for (const [opt, on] of [[optTile, isTile], [optRoom, !isTile]]) {
      opt.classList.toggle('on', on);
    }
    rTile.checked = isTile;
    rRoom.checked = !isTile;
    const cur = t || TILES[0];
    sel.value = cur.id;
    prev.style.backgroundImage = `url("${cur.src}")`;
    const tile = isTile ? r.art_tile : defaultTile(cur.id);
    blend.value = tile.blend;
    level.value = String(tile.level);
    strength.value = String(tile.strength);
    zoom.value = String(tile.zoom);
    oLevel.textContent = `${tile.level}%`;
    oStrength.textContent = `${tile.strength}%`;
    oZoom.textContent = `${tile.zoom}%`;
    /* palette */
    const g = globalPref();
    const gname = PALETTES[g.key]?.name || 'Aurora';
    psel.replaceChildren();
    const f = h('option', '', `Follows global (${gname} · ${g.mode === 'light' ? 'light' : 'dark'})`);
    f.value = '';
    psel.append(f);
    for (const [k, p] of NAMED) {
      const op = h('option', '', p.name);
      op.value = k;
      psel.append(op);
    }
    psel.value = r.pal || '';
    for (const b of [bDark, bLight]) {
      b.disabled = !r.pal;
      b.setAttribute('aria-pressed', String(!!r.pal && b.dataset.m === (r.pal_mode || 'dark')));
    }
    seg.style.opacity = r.pal ? '1' : '.45';
    reset.hidden = !r.pal;
    pnoteTxt.textContent = r.pal ? 'This room has its own palette.' : 'This room uses your global palette and its Dark/Light setting.';
    /* color rows */
    for (const b of sampleWrap.children) {
      b.setAttribute('aria-pressed', String(b.dataset.c === r.color));
    }
    leadSw.setAttribute('aria-pressed', String(!r.color));
    leadHx.textContent = o.leadColor() ? `${o.leadColor()} · ${o.leadName() || 'the lead'}'s project color` : 'no lead seat: neutral';
    const n = ++seq;
    void paletteRoomColor().then((hx) => {
      if (n !== seq || !hx) {
        return;
      }
      palHex = hx;
      palSw.style.setProperty('--c', hx);
      palSw.setAttribute('aria-pressed', String(r.color === hx));
      const nm = r.pal ? PALETTES[r.pal]?.name : gname;
      palHx.textContent = `${hx} · from ${nm}`;
      palSw.title = `The ${nm} palette's own room color, set now`;
    });
    artSws.replaceChildren();
    if (!isTile) {
      artHx.textContent = 'pick a tiled artwork above';
    } else if (t.set === 'tint') {
      artHx.textContent = 'tint art takes the room color; none of its own';
    } else {
      void extractColors(t.id).then((cols) => {
        if (n !== seq) {
          return;
        }
        artSws.replaceChildren(...cols.map((c) => {
          const b = sw(c, `${c} · from the art`);
          b.setAttribute('aria-pressed', String(c === r.color));
          return b;
        }));
        artHx.textContent = cols.length ? `${cols.length} from the art` : 'no strong colors in this art';
      });
    }
    wash.paint();
    spot.paint();
    glass.paint();
  }
  paint();
  return { art, palette, color, repaint: paint };
}

function fail(msg, e) {
  msg.textContent = `Not saved: ${e?.message ?? e}`;
  msg.dataset.kind = 'error';
}
