import { parseColor, hsv, lum, setLum } from './color.mjs';

/**
 * Tint a raw RGBA buffer in place (non-premultiplied, 4 channels, 8 bit).
 *   desaturate  0..1   mix toward the grey of the pixel (1 = fully grey)
 *   color       "#rrggbb"  recolour: the element's lightness stays, the hue/saturation become the colour's
 *   hue         0..360 (+ sat 0..1, default 0.6)  the same, with the colour made from a hue
 *   brightness  multiplier on the lightness (default 1; 0.5 darker, 1.5 lighter)
 *   contrast    multiplier around mid grey (default 1)
 * Order: desaturate, contrast, brightness, recolour. Alpha is never touched.
 */
export function tintRaw(buf, tint) {
  if (!tint) return buf;
  const desat = tint.desaturate ?? 0, bright = tint.brightness ?? 1, contrast = tint.contrast ?? 1;
  let col = null;
  if (tint.color != null) col = parseColor(tint.color);
  else if (tint.hue != null) col = hsv(tint.hue, tint.sat ?? 0.6, 1);
  if (!desat && bright === 1 && contrast === 1 && !col) return buf;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] === 0) continue;
    let px = [buf[i] / 255, buf[i + 1] / 255, buf[i + 2] / 255];
    if (desat) {
      const g = lum(px);
      px = px.map(v => v + (g - v) * desat);
    }
    if (contrast !== 1) px = px.map(v => (v - 0.5) * contrast + 0.5);
    if (bright !== 1) px = px.map(v => v * bright);
    if (col) px = setLum(col, Math.min(1, Math.max(0, lum(px))));
    buf[i] = Math.round(Math.min(1, Math.max(0, px[0])) * 255);
    buf[i + 1] = Math.round(Math.min(1, Math.max(0, px[1])) * 255);
    buf[i + 2] = Math.round(Math.min(1, Math.max(0, px[2])) * 255);
  }
  return buf;
}
