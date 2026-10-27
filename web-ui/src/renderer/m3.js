// Material 3 (Expressive, 2025 spec) theme engine for Workbench.
// One base color -> a full light/dark role palette via Google's material-color-utilities
// (vendored, Apache-2.0). Global settings (theme, system color, style, contrast, pane tint)
// live in localStorage so every window agrees; each tab/pane adds its own base color.
// Independent of the design: this file and style.css are the whole visual language except the
// activity ring and brand marks.

import * as M from '../vendor/m3/mcu-0.4.0.js';

const DC = new M.MaterialDynamicColors();
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

const ROLES = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
  'error', 'onError', 'errorContainer', 'onErrorContainer',
  'surface', 'surfaceDim', 'surfaceBright', 'surfaceContainerLowest', 'surfaceContainerLow',
  'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest',
  'onSurface', 'onSurfaceVariant', 'outline', 'outlineVariant', 'inverseSurface', 'inverseOnSurface', 'inversePrimary',
  'scrim', 'shadow',
];

export const STYLES = ['Expressive', 'TonalSpot', 'Vibrant', 'Neutral', 'Fidelity', 'Rainbow', 'FruitSalad', 'Monochrome'];
// the web build follows the browser (a dark browser opens dark); the desktop app keeps its light default
export const DEFAULTS = { theme: window.wb && window.wb.web ? 'system' : 'light', color: '#428DF0', style: 'Expressive', contrast: 0, tint: 8 };

const KEY = 'wb.appearance';
let settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}'));
} catch (err) {
  // storage unavailable: defaults
}
if (!STYLES.includes(settings.style)) {
  settings.style = DEFAULTS.style;
}

const sysDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = [];

export const get = () => ({ ...settings });
export const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && sysDark.matches);
export const onChange = (fn) => listeners.push(fn);

export function set(patch, { persist = true } = {}) {
  Object.assign(settings, patch);
  if (persist) {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch (err) {
      // not persisted
    }
  }
  listeners.forEach((fn) => fn());
}

// Another window changed the appearance: follow it.
window.addEventListener('storage', (e) => {
  if (e.key === KEY && e.newValue) {
    try {
      Object.assign(settings, JSON.parse(e.newValue));
      listeners.forEach((fn) => fn());
    } catch (err) {
      // ignore a malformed value
    }
  }
});
sysDark.addEventListener('change', () => {
  if (settings.theme === 'system') {
    listeners.forEach((fn) => fn());
  }
});

// ---- palette

const cache = new Map();

// A gray system color (HCT chroma under GRAY_CHROMA) makes a Neutral window whatever the style, so the
// chrome follows the system color's own saturation; panes, tabs and terminals keep the chosen style
// (the owner , the design ; the kit's windowStyleFor in workbench-m3/m3-theme.js).
export const GRAY_CHROMA = 10;
export function windowStyleFor(seed, style = settings.style) {
  return M.Hct.fromInt(M.argbFromHex(seed)).chroma < GRAY_CHROMA ? 'Neutral' : style;
}

// hex -> { roleName: '#rrggbb' } for the current style (or the one given)/contrast/theme.
export function palette(seed, style = settings.style) {
  const key = [seed, style, settings.contrast, isDark()].join('|');
  let p = cache.get(key);
  if (!p) {
    const Scheme = M['Scheme' + style] || M.SchemeExpressive;
    const scheme = new Scheme(M.Hct.fromInt(M.argbFromHex(seed)), isDark(), Number(settings.contrast), '2025');
    p = {};
    for (const r of ROLES) {
      const dc = DC[r] && DC[r].call(DC);
      if (dc) {
        p[r] = M.hexFromArgb(dc.getArgb(scheme));
      }
    }
    // The 2025 spec's error container is a saturated red (#f56965 in light). the design  (5): the
    // error container is the standard pair, light and dark, which the 2021 spec gives (tone 90 / 30).
    const scheme21 = new Scheme(M.Hct.fromInt(M.argbFromHex(seed)), isDark(), Number(settings.contrast), '2021');
    for (const r of ['error', 'onError', 'errorContainer', 'onErrorContainer']) {
      const dc = DC[r] && DC[r].call(DC);
      if (dc) {
        p[r] = M.hexFromArgb(dc.getArgb(scheme21));
      }
    }
    cache.set(key, p);
    if (cache.size > 200) {
      cache.delete(cache.keys().next().value);
    }
  }
  return p;
}

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (a) => '#' + a.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// pct% of `a` over `b` (what CSS color-mix in srgb does).
export function blend(a, b, pct) {
  const x = rgb(a);
  const y = rgb(b);
  const t = pct / 100;
  return hex(x.map((v, i) => v * t + y[i] * (1 - t)));
}

// The colors a pane draws with: the palette plus the tinted surfaces (terminal ground, title bar).
export function paneColors(seed, style) {
  const p = palette(seed, style);
  const dark = isDark();
  const tint = Math.max(0, Math.min(20, Number(settings.tint) || 0));
  const ground = dark ? p.surface : p.surfaceContainerLowest;
  const barBase = dark ? p.surfaceContainer : p.surfaceContainerHigh;
  const headerShare = Math.min(tint * 2, dark ? 30 : 40);
  return {
    ...p,
    onSurfaceVariant: blend(p.onSurface, p.onSurfaceVariant, 20),
    termBg: blend(p.primary, ground, tint),
    barBg: blend(p.primary, barBase, headerShare),
    barEdge: blend(p.primary, p.outlineVariant, 30),
    headerFg: dark ? blend('#ffffff', p.onSurface, 50) : p.onSurface,
  };
}

// Write a color set onto an element as --md-sys-color-* custom properties.
export function applyTo(el, seed, style) {
  const c = paneColors(seed, style);
  for (const [k, v] of Object.entries(c)) {
    if (k === 'termBg' || k === 'barBg' || k === 'barEdge') {
      el.style.setProperty('--' + kebab(k), v);
    } else {
      el.style.setProperty('--md-sys-color-' + kebab(k), v);
    }
  }
  // The slider belongs to every seeded page, not only terminal panes.
  el.style.setProperty('--page-bg', c.termBg);
  el.style.setProperty('--page-header-bg', c.barBg);
  return c;
}

// xterm colors for a pane. The background is opaque (the real tinted ground) so xterm's
// minimumContrastRatio can keep every ANSI color readable on it.
// Adopted from the design <commit>; second-line text mix from <commit>.
const ANSI_LIGHT = {
  black: '#241e1f', red: '#a20e11', green: '#005e12', yellow: '#6b4a00', blue: '#004da3', magenta: '#881894', cyan: '#00595c', white: '#554e50',
  brightBlack: '#5b5354', brightRed: '#b0000e', brightGreen: '#006515', brightYellow: '#734f00', brightBlue: '#0053ae', brightMagenta: '#9600a7', brightCyan: '#006063', brightWhite: '#4c4546',
};
const ANSI_DARK = {
  black: '#1d1b20', red: '#f2b8b5', green: '#8bd8a0', yellow: '#e6c364', blue: '#a8c7fa', magenta: '#e0b0ff', cyan: '#7fd7df', white: '#cac4d0',
  brightBlack: '#938f99', brightRed: '#ffb4ab', brightGreen: '#a6f0b8', brightYellow: '#ffdf8c', brightBlue: '#c4d9ff', brightMagenta: '#f3d1ff', brightCyan: '#a4eff7', brightWhite: '#ffffff',
};

export function termTheme(seed) {
  const c = paneColors(seed);
  return {
    background: c.termBg,
    foreground: c.onSurface,
    cursor: c.primary,
    cursorAccent: c.termBg,
    selectionBackground: c.primary + '40',
    ...(isDark() ? ANSI_DARK : ANSI_LIGHT),
  };
}

// The system chrome (title bar, menus, panels): the global color on :root.
export function applySystem() {
  const root = document.documentElement;
  const chrome = applyTo(root, settings.color, windowStyleFor(settings.color));
  // A dialog/menu can live inside a seeded pane without inheriting its identity.
  for (const role of ROLES) root.style.setProperty('--window-color-' + kebab(role), chrome[role]);
  // the design : light stage margins use the window's tinted surface-container,
  // one step deeper than the rail. Dark keeps the neutral dim from .
  // Edge flags still use the window chrome, independently of adjacent panes.
  root.style.setProperty('--wb-stage-dim', isDark() ? palette(settings.color, 'Neutral').surfaceDim : chrome.surfaceContainer);
  root.style.setProperty('--wb-flag-bg', chrome.surfaceContainerHighest);
  root.style.setProperty('--wb-flag-edge', chrome.outlineVariant);
  root.style.setProperty('--wb-flag-fg', chrome.onSurfaceVariant);
  // W3b (the design .4): the app's standard card, for cards that sit calm over a tinted pane
  root.style.setProperty('--wb-card-bg', chrome.surfaceContainerHigh);
  root.style.setProperty('--wb-card-fg', chrome.onSurface);
  root.style.setProperty('--wb-card-fg2', chrome.onSurfaceVariant);
  root.style.setProperty('--wb-card-ic', chrome.surfaceContainerHighest);
  root.style.setProperty('--wb-card-primary-container', chrome.primaryContainer);
  root.style.setProperty('--wb-card-on-primary-container', chrome.onPrimaryContainer);
  root.style.setProperty('--wb-card-primary', chrome.primary);
  root.style.setProperty('--wb-card-on-primary', chrome.onPrimary);
  root.style.setProperty('--wb-card-secondary', chrome.secondary);
  root.classList.toggle('dark', isDark());
  root.dataset.mode = isDark() ? 'dark' : 'light';
  root.style.setProperty('--tint', settings.tint + '%');
  root.style.setProperty('color-scheme', isDark() ? 'dark' : 'light');
}

export function seedOfHue(h) {
  // hue slider/swatches -> a mid-chroma base color (HCT does the rest)
  const s = 0.78;
  const l = 0.56;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1))).toString(16).padStart(2, '0');
  };
  return ('#' + f(0) + f(8) + f(4)).toUpperCase();
}
