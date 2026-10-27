/* ROOM ART MODEL [hub-v2] (Owner 2026-10-05, the design system b0f8099 sec 1.F).
 *
 * A room can wear a seamless TILE behind its line instead of its watermark.
 *   - The ART is the background at full; Art level = its opacity (10-100).
 *   - The room-color WASH sits IN FRONT of it, with a CSS mix-blend-mode (the
 *     chosen blend); Wash strength = the wash layer's opacity (0-100). The wash
 *     is the line wash's Spot | Edge falloff (room-wash.mjs), not a flat color.
 *   - Tile size: 256 CSS px on a PC, 192 on a phone, times Tile zoom (50-200%).
 *   - SEAMS: a 512 file scaled in CSS at 125% / 150% shows a hairline at every
 *     joint, because the browser clamps at each tile's edge. So the tile is
 *     pre-rendered ONCE at the device-pixel size N = round(css * dpr) from a 3x3
 *     copy, the centre N x N is kept, and it is shown at 1:1 (background-size =
 *     N / dpr). Cached by src|N; re-rendered when the dpr or the zoom changes.
 *   - With a tile chosen, the tile REPLACES the room art (.rc-tiled hides
 *     .rc-art in room-hub.css). With none, nothing here touches the page.
 *
 * The 20 files are alpha-platform's (tiles/v2), copied verbatim into
 * web/assets/tiles/; never regenerated here. The set is in the FILE NAME
 * (tint = greyscale, takes the room color; hue = one hue, shifted to the
 * room's; colour = full color) and decides only the DEFAULTS: how a tile is
 * applied is the person's choice.
 */

/** id = file name without -512.webp. group / name are for the picker. */
const T = (id, group, name, density) => ({ id, group, name, density, set: id.split('-').pop(), src: `/assets/tiles/${id}-512.webp` });
export const TILES = [
  T('animals-koi-busy-tint', 'Animals', 'Koi', 'busy'),
  T('animals-swallows-quiet-hue', 'Animals', 'Swallows', 'quiet'),
  T('animals-tessellated-fish-busy-colour', 'Animals', 'Tessellated fish', 'busy'),
  T('biomes-blue-waves-busy-hue', 'Biomes', 'Blue waves', 'busy'),
  T('biomes-clover-busy-hue', 'Biomes', 'Clover', 'busy'),
  T('biomes-dunes-quiet-hue', 'Biomes', 'Dunes', 'quiet'),
  T('biomes-forest-leaves-quiet-tint', 'Biomes', 'Forest leaves', 'quiet'),
  T('biomes-jungle-busy-colour', 'Biomes', 'Jungle', 'busy'),
  T('biomes-night-blossoms-quiet-hue', 'Biomes', 'Night blossoms', 'quiet'),
  T('biomes-waves-quiet-tint', 'Biomes', 'Waves', 'quiet'),
  T('geometric-deco-hex-busy-colour', 'Geometric', 'Deco hex', 'busy'),
  T('geometric-iso-cubes-quiet-tint', 'Geometric', 'Iso cubes', 'quiet'),
  T('geometric-terrazzo-busy-tint', 'Geometric', 'Terrazzo', 'busy'),
  T('geometric-topo-lines-quiet-tint', 'Geometric', 'Topo lines', 'quiet'),
  T('moods-calm-clouds-quiet-tint', 'Moods', 'Calm clouds', 'quiet'),
  T('moods-happy-doodles-busy-colour', 'Moods', 'Happy doodles', 'busy'),
  T('objects-desk-objects-busy-tint', 'Objects', 'Desk objects', 'busy'),
  T('objects-retro-gadgets-busy-colour', 'Objects', 'Retro gadgets', 'busy'),
  T('road-signs-road-signs-busy-tint', 'Road signs', 'Road signs', 'busy'),
  T('textures-linen-quiet-tint', 'Textures', 'Linen', 'quiet'),
];
export const tileById = (id) => TILES.find((t) => t.id === id) || null;

/** The hub's group labels (the picker groups by SET). */
export const SET_LABELS = {
  tint: 'Tint: greyscale, takes the room color',
  hue: "Hue: one hue, shifted to the room's",
  colour: 'Colour: full color, offers art colors',
};
/** The wash blends, in the hub's order: [css value, label]. 'none' hides the wash (the art's own colors). */
export const BLENDS = [
  ['none', 'None (art as is)'], ['color', 'Color'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['luminosity', 'Luminosity'],
  ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['soft-light', 'Soft light'], ['hard-light', 'Hard light'],
  ['normal', 'Normal (solid tint)'],
];
/** Defaults by file set (the design system sec 1.F). */
const DEF = { tint: ['color', 60], hue: ['hue', 55], colour: ['none', 30] };

/** A fresh choice for a tile: its set's blend + strength, level 100, zoom 100. */
export function defaultTile(id) {
  const t = tileById(id);
  const [blend, strength] = DEF[t ? t.set : 'tint'];
  return { id, blend, level: 100, strength, zoom: 100 };
}

/** Tile edge in CSS px: 256 on a PC, 192 on a phone, times zoom. */
export function tileCss(zoom = 100, phone = matchMedia('(max-width: 600px)').matches) {
  return Math.round(((phone ? 192 : 256) * zoom) / 100);
}

const cache = new Map();
/** The seamless device-pixel tile: Promise<{url, css}> (null when the file will not load). */
export function renderTile(src, cssSize) {
  const dpr = window.devicePixelRatio || 1;
  const N = Math.max(8, Math.round(cssSize * dpr));
  const key = `${src}|${N}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  const pr = new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      try {
        const big = document.createElement('canvas');
        big.width = N * 3;
        big.height = N * 3;
        const bx = big.getContext('2d');
        bx.imageSmoothingQuality = 'high';
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            bx.drawImage(img, i * N, j * N, N, N); // the filter wraps across the joins
          }
        }
        const c = document.createElement('canvas');
        c.width = N;
        c.height = N;
        c.getContext('2d').drawImage(big, N, N, N, N, 0, 0, N, N); // the centre copy: its edges were filtered against its neighbours
        res({ url: c.toDataURL('image/png'), css: N / dpr });
      } catch {
        res(null);
      }
    };
    img.onerror = () => res(null);
    img.src = src;
  });
  cache.set(key, pr);
  return pr;
}

/* ---- the art's own colors (Art color row): k-means in RGB ---- */
const colorCache = new Map();
/** The tile's dominant chromatic colors, biggest first, at most 4: k-means (k=6, 8
 *  rounds) on a 48px copy, keeping clusters with saturation >= .12 that sit >= 48
 *  apart. Tint tiles have none of their own (greyscale). Callback form kept off:
 *  Promise<string[]> of '#rrggbb'. */
export function extractColors(id) {
  if (colorCache.has(id)) {
    return colorCache.get(id);
  }
  const t = tileById(id);
  const pr = new Promise((res) => {
    if (!t) {
      res([]);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 48;
        c.height = 48;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 48, 48);
        const d = x.getImageData(0, 0, 48, 48).data;
        const px = [];
        for (let i = 0; i < d.length; i += 4) {
          px.push([d[i], d[i + 1], d[i + 2]]);
        }
        let cen = Array.from({ length: 6 }, (_, k) => px[Math.floor(((k + 0.5) * px.length) / 6)].slice());
        let lab = [];
        for (let r = 0; r < 8; r++) {
          const sum = cen.map(() => [0, 0, 0, 0]);
          lab = px.map((p) => {
            let b = 0;
            let bd = 1e9;
            cen.forEach((q, k) => {
              const dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
              if (dd < bd) {
                bd = dd;
                b = k;
              }
            });
            sum[b][0] += p[0];
            sum[b][1] += p[1];
            sum[b][2] += p[2];
            sum[b][3]++;
            return b;
          });
          cen = cen.map((q, k) => (sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : q));
        }
        const cnt = cen.map((_, k) => lab.filter((l) => l === k).length);
        const hex = (q) => `#${q.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
        const sat = (q) => (Math.max(...q) - Math.min(...q)) / 255;
        const out = [];
        cen.map((q, k) => [q, cnt[k]]).sort((a, b) => b[1] - a[1]).forEach(([q]) => {
          if (sat(q) < 0.12) {
            return;
          }
          if (out.some((o) => Math.hypot(o[0] - q[0], o[1] - q[1], o[2] - q[2]) < 48)) {
            return;
          }
          out.push(q);
        });
        res(out.slice(0, 4).map(hex));
      } catch {
        res([]);
      }
    };
    img.onerror = () => res([]);
    img.src = t.src;
  });
  colorCache.set(id, pr);
  return pr;
}

/* ---- painting the line ---- */

let lastLine = null;
let lastTile = null;
let rafId = 0;
let lastKey = '';

function layer(line, cls) {
  let el = line.querySelector(`:scope > .${cls}`);
  if (!el) {
    el = document.createElement('div');
    el.className = cls;
    el.setAttribute('aria-hidden', 'true');
    line.append(el); // appended, never prepended: a room with no tile has exactly today's DOM
  }
  return el;
}

/**
 * Paint (or take off) the tile on the room's line. `tile` = room.art_tile
 * ({id, blend, level, strength, zoom}) or null = the room art as today.
 * Idempotent; called on every room view / push / save, on resize and on a
 * wash or mode change.
 */
export function paintTile(line, tile) {
  lastLine = line;
  lastTile = tile;
  if (!line) {
    return;
  }
  const t = tile && tileById(tile.id);
  if (!t) {
    line.classList.remove('rc-tiled');
    line.querySelectorAll(':scope > .rc-tile, :scope > .rc-tilewash').forEach((n) => n.remove());
    lastKey = '';
    return;
  }
  line.classList.add('rc-tiled');
  const art = layer(line, 'rc-tile');
  const wash = layer(line, 'rc-tilewash'); // after the art: later in DOM = in front at the same z-index
  art.style.opacity = String(tile.level / 100);
  const none = tile.blend === 'none';
  wash.style.display = none ? 'none' : '';
  wash.style.mixBlendMode = none ? 'normal' : tile.blend;
  wash.style.opacity = String(tile.strength / 100);
  const css = tileCss(tile.zoom);
  const key = `${t.src}|${css}|${window.devicePixelRatio || 1}`;
  if (key !== lastKey || !art.style.backgroundImage) {
    lastKey = key;
    void renderTile(t.src, css).then((r) => {
      if (r && lastKey === key) {
        art.style.backgroundImage = `url("${r.url}")`;
        art.style.backgroundSize = `${r.css}px ${r.css}px`;
      }
    });
  }
}

/* A dpr change (browser zoom, moving between screens) or a PC/phone width flip
   re-renders at the new device pixels. */
addEventListener('resize', () => {
  if (rafId || !lastLine || !lastTile) {
    return;
  }
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    paintTile(lastLine, lastTile);
  });
});
