// Colour helpers for element tints. Colours are [r,g,b] in 0..1.

export function parseColor(c) {
  if (Array.isArray(c)) return c.map(v => (v > 1 ? v / 255 : v));
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim());
  if (!m) throw new Error(`bad colour ${JSON.stringify(c)} (use #rrggbb)`);
  let h = m[1];
  if (h.length === 3) h = [...h].map(x => x + x).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}

export function hsv(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60;
  const i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

export const lum = ([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b;

function clip(c) {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  if (n < 0) c = c.map(v => l + ((v - l) * l) / (l - n));
  if (x > 1) c = c.map(v => l + ((v - l) * (1 - l)) / (x - l));
  return c;
}

// W3C "color" blend: the hue and saturation of `c`, the lightness `l` of the source.
export function setLum(c, l) {
  const d = l - lum(c);
  return clip(c.map(v => v + d));
}
