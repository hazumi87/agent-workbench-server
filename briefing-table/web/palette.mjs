/* GLOBAL COLOR PALETTE generator (hub V2, Owner 2026-10-05). A port of the design system
 * styleguide/mockups/hub/hub-palette.js (the spec: PIN, never fork; re-sync by
 * diffing that file, do not hand-edit a lightness).
 *
 * A palette is a few parameters; every token is GENERATED in oklch with
 * lightness pinned per mode, so contrast is by construction. Function HUES
 * never change (coral = danger, amber = caution, lime = done, sky = info); a
 * palette only moves the ground, the identity tones (--id-*), the chroma and the
 * "go" accent (written to --teal). "the design system" in DARK is today's tokens.css with
 * NO overrides, so the default look is unchanged.
 *
 * CLEAN EXPORT (batch 3 / room-level overrides read this):
 *   PALETTES   { key: {name, sub, ...params} }, 20 palettes + `custom`
 *   MODES      ['dark', 'light']
 *   CUSTOM_KEYS the ten colors a custom palette carries
 *   tokens(key, custom, mode) -> { tokenName: cssValue } (no leading `--`);
 *                {} for the design system dark and for an unknown key
 *   apply(doc, map, mode?)   -> sets/clears the --tokens on <html> inline, plus
 *                data-mode, color-scheme and the theme-color meta
 *   applyPref(doc, pref)     -> apply(doc, tokens(pref.key, pref.custom, pref.mode), pref.mode)
 *   remember(doc, pref)      -> applyPref + write the first-paint cache (below); what
 *                the settings page and the boot reconcile call
 *   seed(key, cs, mode)      -> the ten custom colors for a palette (hex), `cs` a
 *                getComputedStyle of the page for the design system dark / unknown keys
 *   hex(css)                 -> '#rrggbb' of any CSS color
 *
 * NOT exported on purpose: the hub's adaptRoom / roomColor. A palette never
 * changes a room's stored color (HELD, Owner 2026-10-05: the watermark tint must
 * not move because of a palette).
 *
 * KNOWN LIMIT: it themes this origin's documents. A tool iframe on another
 * origin keeps its own look.
 */
const HUE = { sky: 232, amber: 82, coral: 29, lime: 128, magenta: 356, indigo: 272 };
const FC = { sky: .13, amber: .15, coral: .19, lime: .17, magenta: .21, indigo: .15 };
export const ID = ['cobalt', 'green', 'orchid', 'violet', 'orange'];
const ID_H = [258, 150, 322, 295, 55];
export const MODES = ['dark', 'light'];
const MODE = {
  dark: { ink: .155, s1: .19, s2: .215, s3: .245, b1: .28, b2: .33, text: .93, dim: .70, dim2: .56, f: .78, tab: .66 },
  light: { ink: .985, s1: .965, s2: .94, s3: .91, b1: .87, b2: .80, text: .25, dim: .47, dim2: .58, f: .52, tab: .60 },
};
/* EVERY palette has a dark AND a light version: the palette sets hues and
   strengths, the Dark/Light toggle sets the lightness. Fields: ground hue/chroma
   (light: optional own ground), function chroma, identity chroma, identity hues,
   go accent [h, c] or 'neutral'. */
export const PALETTES = {
  aurora: { name: 'Aurora', sub: 'today (dark = tokens.css)', today: true, gh: 250, gc: .012, fc: 1, ic: 1, go: [182, .12] },
  neutral: { name: 'Neutral', sub: 'plain gray ground', gh: 250, gc: .004, fc: .9, ic: .85, go: [182, .12] },
  greyscale: { name: 'Greyscale', sub: 'mono', gh: 250, gc: 0, fc: .38, ic: .12, go: 'neutral' },
  gold: { name: 'Monotone gold', sub: 'warm mono', gh: 75, gc: .02, fc: .5, ic: .55, idh: [62, 74, 86, 96, 50], go: [82, .12] },
  pastel: { name: 'Pastel', sub: 'soft', gh: 300, gc: .018, fc: .6, ic: .55, go: [182, .09] },
  caribbean: { name: 'Caribbean', sub: 'turquoise, sand, coral', gh: 205, gc: .03, light: { gh: 85, gc: .022 }, fc: 1, ic: 1.05, idh: [192, 152, 28, 330, 88], go: [186, .14] },
  reef: { name: 'Coral reef', sub: 'coral, aqua, sun', gh: 215, gc: .025, light: { gh: 40, gc: .015 }, fc: 1, ic: 1.05, idh: [175, 120, 20, 300, 95], go: [178, .14] },
  lagoon: { name: 'Lagoon', sub: 'green-blue shallows', gh: 190, gc: .028, light: { gh: 180, gc: .016 }, fc: .95, ic: .95, idh: [200, 160, 240, 285, 120], go: [172, .13] },
  sky: { name: 'Sky', sub: 'airy blue', gh: 235, gc: .02, light: { gh: 230, gc: .018 }, fc: .95, ic: .9, idh: [245, 180, 320, 280, 70], go: [225, .12] },
  ocean: { name: 'Ocean', sub: 'deep blue', gh: 225, gc: .035, light: { gh: 220, gc: .014 }, fc: .9, ic: .95, idh: [255, 190, 300, 280, 165], go: [195, .13] },
  glacier: { name: 'Glacier', sub: 'ice and slate', gh: 220, gc: .022, fc: .7, ic: .7, idh: [235, 195, 270, 255, 175], go: [205, .09] },
  sunset: { name: 'Sunset', sub: 'warm', gh: 25, gc: .02, light: { gh: 50, gc: .02 }, fc: .9, ic: 1, idh: [300, 345, 15, 270, 60], go: [350, .15] },
  fall: { name: 'Fall', sub: 'rust + olive', gh: 55, gc: .02, fc: .8, ic: .9, idh: [35, 125, 15, 300, 70], go: [130, .12] },
  spring: { name: 'Spring', sub: 'fresh', gh: 140, gc: .012, fc: .9, ic: .9, idh: [250, 145, 340, 300, 85], go: [150, .13] },
  summer: { name: 'Summer', sub: 'bright', gh: 210, gc: .012, fc: 1, ic: 1, idh: [230, 175, 350, 300, 60], go: [200, .13] },
  winter: { name: 'Winter', sub: 'cold', gh: 240, gc: .028, fc: .75, ic: .8, idh: [245, 205, 285, 265, 185], go: [215, .1] },
  forest: { name: 'Forest', sub: 'deep green', gh: 155, gc: .025, fc: .85, ic: .9, idh: [200, 145, 95, 175, 65], go: [140, .14] },
  midnight: { name: 'Midnight', sub: 'violet', gh: 285, gc: .04, light: { gh: 290, gc: .018 }, fc: .9, ic: 1, ink: .12, go: [295, .15] },
  rose: { name: 'Rosé', sub: 'blush', gh: 15, gc: .018, fc: .8, ic: .85, idh: [280, 150, 350, 315, 40], go: [355, .13] },
  contrast: { name: 'High contrast', sub: 'max legibility', gh: 0, gc: 0, fc: 1.1, ic: 1.1, hc: true, go: [182, .15] },
  custom: { name: 'Customize…', sub: 'your own colors', custom: true },
};
/* the ten colors a custom palette carries, in the order the pickers show them */
export const CUSTOM_KEYS = ['ink', 'surface', 'text', 'accent', 'neutral', ...ID];

const o = (L, C, h) => `oklch(${L.toFixed(3)} ${Math.max(0, C).toFixed(3)} ${h})`;

function gen(p0, mode) {
  const p = { ...p0, mode, ...(mode === 'light' && p0.light ? p0.light : {}) };
  const m = { ...MODE[mode] };
  if (p.ink && mode === 'dark') m.ink = p.ink;
  if (p.hc) Object.assign(m, mode === 'dark' ? { ink: .08, s1: .13, s2: .17, s3: .21, b1: .38, b2: .5, text: 1, dim: .86, dim2: .7, f: .82 } : { ink: 1, s1: .98, s2: .955, s3: .93, b1: .7, b2: .55, text: 0, dim: .32, dim2: .45, f: .45 });
  const g = (L) => o(L, p.gc, p.gh);
  const t = {
    ink: g(m.ink), surface: g(m.s1), surface2: g(m.s2), surface3: g(m.s3), border: g(m.b1), border2: g(m.b2),
    text: o(m.text, p.gc * .6, p.gh), dim: o(m.dim, p.gc, p.gh), dim2: o(m.dim2, p.gc, p.gh), nav: g(m.ink + (p.mode === 'dark' ? .015 : -.01)),
  };
  for (const [k, h] of Object.entries(HUE)) t[k] = o(k === 'coral' || k === 'amber' ? m.f - (p.mode === 'light' ? .02 : 0) : m.f, FC[k] * (k === 'coral' ? Math.max(p.fc, .7) : p.fc), h);
  const idh = p.idh || ID_H;
  ID.forEach((k, i) => { t['id-' + k] = o(m.tab, .16 * p.ic, idh[i]); });
  t.teal = p.go === 'neutral' ? o(p.mode === 'dark' ? .9 : .28, 0, 0) : o(p.mode === 'dark' ? .8 : .5, p.go[1], p.go[0]);
  t['cap-hover'] = p.mode === 'dark' ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.07)';
  t['ghost-fill'] = p.mode === 'dark' ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.03)';
  return t;
}

/* custom: a few user hexes; the rest derived from them */
function genCustom(c) {
  const t = {};
  const mix = (a, b, w) => `color-mix(in oklab, ${a} ${w}%, ${b})`;
  t.ink = c.ink; t.surface = c.surface; t.surface2 = mix(c.surface, c.text, 94); t.surface3 = mix(c.surface, c.text, 88);
  t.border = mix(c.surface, c.text, 82); t.border2 = mix(c.surface, c.text, 74); t.text = c.text; t.dim = mix(c.text, c.surface, 62); t.dim2 = c.neutral; t.nav = mix(c.ink, c.surface, 50);
  t.teal = c.accent; ID.forEach((k) => { t['id-' + k] = c[k]; });
  return t;
}

let cx = null;
/** Any CSS color -> '#rrggbb' (one pixel on a canvas; made on first use so
 *  importing this module costs nothing on a page that never needs a hex). */
export function hex(css) {
  if (!cx) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    cx = cv.getContext('2d', { willReadFrequently: true });
  }
  cx.clearRect(0, 0, 1, 1);
  cx.fillStyle = '#000';
  cx.fillStyle = css;
  cx.fillRect(0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** The custom set seeded from any palette (or today's tokens, read from a computed style). */
export function seed(key, cs, mode = 'dark') {
  const t = (key === 'aurora' && mode === 'dark') || !PALETTES[key] || PALETTES[key].custom ? null : gen(PALETTES[key], mode);
  const v = (n) => hex(t ? t[n] : cs.getPropertyValue('--' + n).trim());
  const s = { ink: v('ink'), surface: v('surface'), text: v('text'), accent: v('teal'), neutral: v('dim2') };
  ID.forEach((k) => { s[k] = v('id-' + k); });
  return s;
}

/** The token map for a palette + mode (names without the leading `--`). */
export function tokens(key, custom, mode = 'dark') {
  const p = PALETTES[key];
  if (!p || (p.today && mode === 'dark')) return {};
  if (p.custom) return custom ? genCustom(custom) : {};
  return gen(p, mode);
}

const ALL = ['ink', 'surface', 'surface2', 'surface3', 'border', 'border2', 'text', 'dim', 'dim2', 'nav', 'teal', 'sky', 'amber', 'coral', 'lime', 'magenta', 'indigo', 'cap-hover', 'ghost-fill', ...ID.map((k) => 'id-' + k)];
/** the design system dark's ground, for the theme-color meta when no override is set. */
const AURORA_INK = '#0C1014';

/** Light/dark of a token map: the stated mode, else the ink's brightness. */
function isLight(map, mode) {
  if (mode === 'light' || mode === 'dark') return mode === 'light';
  return !!(map && map.ink && hex(map.ink).slice(1).match(/../g).map((h) => parseInt(h, 16)).reduce((a, b) => a + b, 0) > 384);
}

/** Set (or, for an empty map, clear) the tokens on <html> inline, so they beat
 *  any stylesheet's :root, plus data-mode, color-scheme and the theme-color. */
export function apply(doc, map, mode) {
  const r = doc.documentElement;
  for (const k of ALL) r.style.removeProperty('--' + k);
  for (const [k, v] of Object.entries(map || {})) r.style.setProperty('--' + k, v);
  const light = isLight(map, mode);
  r.dataset.mode = light ? 'light' : 'dark';
  r.style.colorScheme = light ? 'light' : 'dark';
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) {
    if (!meta.dataset.base) meta.dataset.base = meta.getAttribute('content') || AURORA_INK;
    meta.setAttribute('content', map && map.ink ? hex(map.ink) : meta.dataset.base);
  }
}

/** Apply a stored pref {key, mode, custom?}; no pref = the design system dark. A custom
 *  palette's light/dark is read from its own background (the person picked the
 *  ink; a stated mode could contradict it). Returns the mode applied. */
export function applyPref(doc, pref) {
  const p = pref && PALETTES[pref.key] ? pref : { key: 'aurora', mode: 'dark' };
  const map = tokens(p.key, p.custom, MODES.includes(p.mode) ? p.mode : 'dark');
  const mode = PALETTES[p.key].custom && map.ink ? (isLight(map) ? 'light' : 'dark') : MODES.includes(p.mode) ? p.mode : 'dark';
  apply(doc, map, mode);
  try { doc.dispatchEvent(new CustomEvent('palette-change')); } catch (e) { /* no DOM: nothing to tell [app theme] */ }
  return mode;
}

/** localStorage key of the first-paint cache read by web/palette-boot.js:
 *  {pref, map, mode, theme, at}. The generated map is cached so the boot script
 *  (a classic script in <head>) never has to load this module to paint. */
export const CACHE_KEY = 'hwb.palette.v1';

/** applyPref, then cache it for the next page's first paint (and, through the
 *  `storage` event, for every other open page of this origin). */
export function remember(doc, pref) {
  const p = pref && PALETTES[pref.key] ? pref : { key: 'aurora', mode: 'dark' };
  const mode = applyPref(doc, p);
  const map = tokens(p.key, p.custom, MODES.includes(p.mode) ? p.mode : 'dark');
  try {
    /* the pref as the server holds it (so the boot's compare matches), the map and applied mode beside it */
    const clean = { key: p.key, mode: MODES.includes(p.mode) ? p.mode : 'dark', ...(p.custom ? { custom: p.custom } : {}) };
    localStorage.setItem(CACHE_KEY, JSON.stringify({ pref: clean, map, mode, theme: map.ink ? hex(map.ink) : null, at: Date.now() }));
  } catch (e) { /* private window / blocked storage: the page still renders */ }
}
