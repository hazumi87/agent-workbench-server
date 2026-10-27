/* Icon lab (2026-09-02) — derive a 20px-legible tab mark from watermark art.
 *
 * THE PROBLEM, measured before this existed: at 20 CSS px the traced library art
 * runs 70-82% "mush" (painted pixels stranded mid-alpha) while the design system
 * purpose-built presets run 30-51%. Detail below one device pixel does not
 * disappear, it becomes partial coverage — grey haze in the shape of a logo.
 *
 * THE FIX IS NOT AN OPTIMIZER. SVGO's contract is "do not change how this
 * renders", so it cannot drop a shape; it only reduces coordinate precision. The
 * lever is one stage earlier: destroy the detail in the RASTER, at a size near
 * the target, then re-trace what survived. The tracer then rebuilds a genuinely
 * simple silhouette instead of a squashed complex one.
 *
 * TWO MORPHOLOGIES, PULLING OPPOSITE WAYS — both are raced because both are
 * right for different art:
 *   dilate  thickens. Rescues thin outlines that would fall under one pixel and
 *           go grey. (`key` is 2 paths and STILL scored 82% mush — proof that
 *           stroke width, not path count, predicts failure.)
 *   erode   thins, removing speckle. Paired after a dilate it is a CLOSE, which
 *           merges neighbours into one silhouette.
 *
 * Everything here is single-colour by construction: these are ghosts and tab
 * marks, never illustrations. Colour is applied by the consumer via currentColor.
 */
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { optimize as svgoOptimize } from 'svgo';
import { traceInk } from './contour-trace.ts';

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  pixels: Buffer;
}

export interface Recipe {
  id: string;
  label: string;
  /** Raster size the simplification happens at. Small = more detail destroyed. */
  render: number;
  /** Morphology radius in pixels: >0 dilates (thickens), <0 erodes (thins). */
  dilate: number;
  /** Apply the inverse after `dilate` — turning a dilate into a CLOSE. */
  close: boolean;
  /** Discard traced patches of about this many pixels or fewer (the tracer
   *  counts outline points, so this is converted: see `traceBitmap`). This is
   *  the "make shapes too small disappear" lever, applied AFTER the raster
   *  stage has already removed most of what could not survive. */
  turdSize: number;
  /** Curve tolerance. Higher rounds corners harder, which reads as deliberate
   *  simplification rather than as blur. (It was potrace's `alphaMax`; it now
   *  sets the tracer's line and curve error margins.) */
  alphaMax: number;
}

/* The ladder. Deliberately spans "what an online converter does" through
 * "aggressively simplified", so the winner is chosen from a real range rather
 * than from one setting that happened to be tried first. */
export const LADDER: Recipe[] = [
  { id: 'trace-512', label: 'trace @512 (no simplification)', render: 512, dilate: 0, close: false, turdSize: 2, alphaMax: 1 },
  { id: 'trace-128', label: 'trace @128', render: 128, dilate: 0, close: false, turdSize: 2, alphaMax: 1 },
  { id: 'trace-96-d1', label: 'trace @96 · dilate 1 · turd 8', render: 96, dilate: 1, close: false, turdSize: 8, alphaMax: 1 },
  { id: 'trace-64-d1', label: 'trace @64 · dilate 1 · turd 4', render: 64, dilate: 1, close: false, turdSize: 4, alphaMax: 1 },
  { id: 'trace-64-c2', label: 'trace @64 · close 2 · turd 8', render: 64, dilate: 2, close: true, turdSize: 8, alphaMax: 1.2 },
  { id: 'trace-48-d2', label: 'trace @48 · dilate 2 · turd 4', render: 48, dilate: 2, close: false, turdSize: 4, alphaMax: 1.2 },
];

/**
 * Give a viewBox-less <svg> a coordinate system — the server-side counterpart of
 * logo-modal.mjs's fitViewBox.
 *
 * WHY THIS EXISTS (found 2026-09-03, and it had been silently poisoning
 * numbers): the browser path repairs a missing viewBox by mounting the element
 * and measuring getBBox(). There is no DOM here, so rasterizeSvg only ever
 * fixed the missing xmlns — which meant kiosk (bare <svg>: no viewBox, no
 * width, no height) rendered as a crop of a 500-unit drawing in a default box.
 * It scored 24-25% silhouette agreement against ITSELF-derived candidates at
 * every size, and quietly dragged down every average it appeared in. A metric
 * that is wrong for one input is a metric you cannot read for any input.
 *
 * USE resvg's OWN getBBox, never a hand-rolled scan of the path numbers. The
 * first attempt did scan them and was wrong in a way that looked plausible:
 * kiosk's paths are RELATIVE commands (`c1.25-.03,2.50…`), so those numbers
 * are DELTAS, and treating them as coordinates produced a box near the origin
 * while the art sits at x≈20..1217. Group transforms break the same scan for a
 * second, independent reason. resvg resolves both — measured against a known
 * rect it returns the exact box, and on kiosk it reports 20.4, 47.6,
 * 1197x1074, which is the real extent.
 *
 * INK EXTENT, not the declared width/height, even when those exist — because
 * that is what the browser half does (fitViewBox measures getBBox and then
 * drops width/height), and the two repairs must agree or the server's metrics
 * describe a different picture from the one on screen.
 */
export function ensureViewBox(svg: string): string {
  if (/<svg\b[^>]*\bviewBox\s*=/i.test(svg)) {
    return svg;
  }
  const withNs = /<svg\b[^>]*\bxmlns\s*=/i.test(svg)
    ? svg
    : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  try {
    const b = new Resvg(withNs).getBBox();
    if (b && b.width > 0 && b.height > 0) {
      return withNs.replace(/<svg\b/i, `<svg viewBox="${b.x} ${b.y} ${b.width} ${b.height}"`);
    }
  } catch {
    /* unparseable — fall through to the declared size */
  }
  const tag = /<svg\b[^>]*>/i.exec(withNs)?.[0] ?? '';
  const w = Number(/\bwidth\s*=\s*["']?([\d.]+)/i.exec(tag)?.[1]);
  const h = Number(/\bheight\s*=\s*["']?([\d.]+)/i.exec(tag)?.[1]);
  if (w > 0 && h > 0) {
    return withNs.replace(/<svg\b/i, `<svg viewBox="0 0 ${w} ${h}"`);
  }
  return withNs; // nothing measurable — leave it rather than invent a box
}

/** SVG → RGBA at a given width. The one place SVG becomes pixels. */
export async function rasterizeSvg(svg: string, size: number): Promise<Bitmap> {
  /* xmlns is REQUIRED for a standalone parse even though the DOM implies it —
     kiosk's bare <svg> renders in a pane and fails everywhere it is treated
     as a file (found by the icons-page probe, 2026-09-02). */
  const repaired = ensureViewBox(svg);
  const withNs = /<svg\b[^>]*\bxmlns\s*=/i.test(repaired)
    ? repaired
    : repaired.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const r = new Resvg(withNs, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  return pngToBitmap(Buffer.from(r.render().asPng()));
}

/** PNG/JPEG bytes → RGBA. */
export async function pngToBitmap(buf: Buffer): Promise<Bitmap> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: data };
}

/**
 * Reduce to a single-channel coverage map, 0..1 per pixel.
 *
 * Art arrives two ways and they need opposite readings: a transparent PNG/SVG
 * carries the mark in its ALPHA, while a flattened white-background export
 * carries it in DARKNESS with alpha uniformly 1. Reading only alpha turns the
 * second kind into a solid square — so coverage is alpha where alpha varies,
 * and inverted luminance where it does not.
 */
function coverage(bm: Bitmap): Float32Array {
  const n = bm.width * bm.height;
  const cov = new Float32Array(n);
  let minA = 255;
  let maxA = 0;
  for (let i = 0; i < n; i++) {
    const a = bm.pixels[i * 4 + 3];
    if (a < minA) {
      minA = a;
    }
    if (a > maxA) {
      maxA = a;
    }
  }
  const alphaCarries = maxA - minA > 8;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (alphaCarries) {
      cov[i] = bm.pixels[p + 3] / 255;
    } else {
      const lum = (bm.pixels[p] * 0.299 + bm.pixels[p + 1] * 0.587 + bm.pixels[p + 2] * 0.114) / 255;
      cov[i] = 1 - lum;
    }
  }
  return cov;
}

/** Box min/max filter — erode (min) and dilate (max) on a coverage map. */
function morph(cov: Float32Array, w: number, h: number, radius: number, dilateNotErode: boolean): Float32Array {
  if (radius <= 0) {
    return cov;
  }
  const out = new Float32Array(cov.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = dilateNotErode ? 0 : 1;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) {
          if (!dilateNotErode) {
            acc = 0; // outside is background: erosion at the border eats in
          }
          continue;
        }
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) {
            if (!dilateNotErode) {
              acc = 0;
            }
            continue;
          }
          const v = cov[yy * w + xx];
          acc = dilateNotErode ? Math.max(acc, v) : Math.min(acc, v);
        }
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Coverage map → the black-on-white opaque RGBA the tracer binarises. Thresholded
 * at 0.5 here: past this point the image IS the silhouette, and any remaining
 * anti-aliasing would only become tracer noise.
 */
function toTraceBitmap(cov: Float32Array, w: number, h: number): Bitmap {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < cov.length; i++) {
    const on = cov[i] >= 0.5;
    const v = on ? 0 : 255;
    px[i * 4] = v;
    px[i * 4 + 1] = v;
    px[i * 4 + 2] = v;
    px[i * 4 + 3] = 255;
  }
  return { width: w, height: h, pixels: px };
}

/** Downscale a coverage map with box averaging — the detail-destroying step. */
async function resizeBitmap(bm: Bitmap, size: number): Promise<Bitmap> {
  const buf = await sharp(bm.pixels, { raw: { width: bm.width, height: bm.height, channels: 4 } })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: buf.info.width, height: buf.info.height, pixels: buf.data };
}

/**
 * INK  — how much of the box the mark covers. Near 0 = vanishing, near 100 =
 *        collapsed to a blob.
 * MUSH — the share of painted pixels stranded mid-alpha. THIS is the grey-haze
 *        failure as a number: a crisp mark is mostly-on or mostly-off.
 * Mirrors web/icons.js exactly so the page and the server never disagree about
 * what a candidate scored.
 */
export function scoreBitmap(bm: Bitmap): { ink: number; mush: number } {
  const cov = coverage(bm);
  let painted = 0;
  let mid = 0;
  for (let i = 0; i < cov.length; i++) {
    const v = cov[i];
    if (v > 0.02) {
      painted++;
      if (v > 0.2 && v < 0.8) {
        mid++;
      }
    }
  }
  return {
    ink: Math.round((painted / cov.length) * 100),
    mush: painted ? Math.round((mid / painted) * 100) : 0,
  };
}

/** Score an SVG the way a tab strip will actually see it: rendered at 20px. */
export async function scoreSvgAt(svg: string, size: number): Promise<{ ink: number; mush: number }> {
  return scoreBitmap(await rasterizeSvg(svg, size));
}

/**
 * SVGO. NOT a simplifier — it cannot drop a shape, by design. It is here to
 * strip tracer precision (the real size win) and to normalise.
 *
 * VERSION NOTE (found live, 2026-09-02): `removeViewBox` was in preset-default
 * in SVGO v2/v3 and had to be disabled, because viewBox is load-bearing on both
 * our surfaces. In v4 it is NOT in the preset, and overriding it throws
 * "not part of preset-default". So it is simply absent here — but do not
 * "helpfully" add removeViewBox back in any form. `removeDimensions` IS opt-in
 * and wanted: it is exactly the width/height -> viewBox repair traced art needs.
 */
export function optimizeSvg(svg: string, floatPrecision = 2): string {
  const res = svgoOptimize(svg, {
    multipass: true,
    floatPrecision,
    plugins: [
      {
        name: 'preset-default',
        params: { overrides: { cleanupNumericValues: { floatPrecision } } },
      },
      'removeDimensions',
    ],
  });
  return res.data;
}

/**
 * Make any stored SVG safe for a consumer that will not repair it.
 *
 * The pane repairs art at render time (logo-modal.mjs); the SHELL does not — it
 * injects the markup straight into a 20px span in another process. So art
 * leaving here for the shell must already have a viewBox (or it renders as a
 * crop of a 500-unit drawing), an xmlns (or it is invalid the moment anything
 * treats it as a file), and inherited fills (or `fill="[ref]"` beats
 * currentColor and paints black on a dark titlebar). All three are true of the
 * legacy library art, which is exactly why the tabs looked wrong.
 */
export function normalizeForConsumers(svg: string): string {
  return optimizeSvg(monoize(ensureViewBox(svg)), 2);
}

/** Recolour a traced result to inherit from the consumer. */
function monoize(svg: string): string {
  return svg
    .replace(/(\s(?:fill|stroke))\s*=\s*"(?!none|currentColor|url\()[^"]*"/gi, '$1="currentColor"')
    .replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
    .replace(/(<svg\b[^>]*?)\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"(?=[^>]*\sxmlns=)/i, '$1');
}

/**
 * Trace a black-on-white bitmap into a single-colour SVG (contour-trace.ts: sub-pixel contours with rounded corners).
 *
 * This replaced `potrace` (GPL-2.0) in 2026-10. A packaged MIT tracer (@image-tracer-ts/core) was tried first and turned
 * rounded marks into faceted ones at 48-64 px (the design system review: a sun disc became an octagon), so the tracer is ours.
 * It is pure code on purpose, for the reason found live 2026-09-02: @neplex/vectorizer's napi binding cannot read a Buffer
 * on Node 24 ("Failed to get Buffer pointer and length"), so a native tracer has an ABI to mismatch. If VTracer is ever
 * revisited, that failure is the thing to re-test first.
 *
 * `turdSize` is a pixel area (patches that small are dropped). `alphaMax` still means "higher rounds corners harder": it
 * scales the blur that turns the pixel staircase into a slope and how far a corner curve may reach.
 */
function traceBitmap(bm: Bitmap, r: Pick<Recipe, 'turdSize' | 'alphaMax'>): string {
  const ink = new Uint8Array(bm.width * bm.height);
  for (let i = 0; i < ink.length; i++) {
    ink[i] = bm.pixels[i * 4] < 128 ? 1 : 0;
  }
  return traceInk(ink, bm.width, bm.height, { turd: r.turdSize, smooth: 0.9 * r.alphaMax, round: 2 * r.alphaMax });
}

export interface Candidate {
  id: string;
  label: string;
  svg: string;
  bytes: number;
  paths: number;
  /** Score at the size that actually matters. */
  at20: { ink: number; mush: number };
  at40: { ink: number; mush: number };
  /** 0-100. Silhouette agreement (IoU) with the master. See fidelityVs. */
  fidelity: number;
  /** 0-100. fidelity x crispness. The rankable number — see `race`. */
  score: number;
  ms: number;
}

/** Thresholded silhouette at a fixed size — the shape, with the small-size
 *  rendering problem deliberately taken out of the comparison. */
async function silhouette(svg: string, size = 64): Promise<Uint8Array> {
  const cov = coverage(await rasterizeSvg(svg, size));
  const out = new Uint8Array(cov.length);
  for (let i = 0; i < cov.length; i++) {
    out[i] = cov[i] >= 0.5 ? 1 : 0;
  }
  return out;
}

/**
 * FIDELITY — does this candidate still read as the SAME MARK?
 *
 * THIS EXISTS BECAUSE MUSH ALONE RANKS BACKWARDS. Mush measures only crispness,
 * so a solid featureless blob scores a perfect 0% and wins — which is precisely
 * what happened: the aggressive rung won every race while being the one shape
 * nobody could identify (Owner, looking at the harbor tugboat: "it looks awful
 * and has no detail"). Telling the reader to "watch ink for blobbing" was asking
 * them to correct a broken ranking by eye. So: intersection-over-union of the
 * two silhouettes, which collapses exactly when detail is lost or a shape is
 * inflated past recognition.
 *
 * Compared at 64px, not 20: the question here is "is this the same shape", and
 * asking it at a size where BOTH images are mush would answer nothing.
 */
function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) {
      union++;
      if (a[i] && b[i]) {
        inter++;
      }
    }
  }
  return union ? Math.round((inter / union) * 100) : 0;
}

/**
 * THE RANKABLE NUMBER: crisp AND faithful, in one figure.
 *
 * Neither half alone is rankable. Mush alone crowns a blob (it has no detail to
 * be mushy). Fidelity alone crowns the untouched original (it is identical to
 * itself). The product only goes up when a candidate is BOTH legible at size and
 * still the same mark — and it lets a good original win, which is correct: an
 * the design system preset at 30% mush should not be "improved" into something else.
 */
function combine(fidelity: number, mush: number): number {
  return Math.round((fidelity / 100) * (1 - mush / 100) * 100);
}

/** Run one rung of the ladder. */
export async function runRecipe(
  source: Bitmap,
  r: Recipe,
  masterMask?: Uint8Array,
): Promise<Candidate> {
  const t0 = Date.now();
  const small = await resizeBitmap(source, r.render);
  let cov = coverage(small);
  if (r.dilate > 0) {
    cov = morph(cov, small.width, small.height, r.dilate, true);
    if (r.close) {
      cov = morph(cov, small.width, small.height, r.dilate, false);
    }
  } else if (r.dilate < 0) {
    cov = morph(cov, small.width, small.height, -r.dilate, false);
  }
  const traceIn = toTraceBitmap(cov, small.width, small.height);
  const raw = traceBitmap(traceIn, r);
  const svg = optimizeSvg(monoize(raw), 2);
  const [at20, at40, mask] = await Promise.all([
    scoreSvgAt(svg, 20),
    scoreSvgAt(svg, 40),
    silhouette(svg),
  ]);
  const fidelity = masterMask ? iou(masterMask, mask) : 100;
  return {
    id: r.id,
    label: r.label,
    svg,
    bytes: svg.length,
    paths: (svg.match(/<path\b/gi) || []).length,
    at20,
    at40,
    fidelity,
    score: combine(fidelity, at20.mush),
    ms: Date.now() - t0,
  };
}

/* ============================================================================
 * THE CHOSEN PIPELINE (settled 2026-09-03 by 101 human verdicts — see CLAUDE.md)
 *
 * `trace-512`, then SVGO. No downscale, no dilate, no second asset.
 *
 * WHY NOT THE LIGHTER RUNG: trace-128 is half the size (6.5 KB vs 12.6 KB avg)
 * and was equally accepted AT 20px — but the same file is also the ghosted
 * watermark at ~80% of a pane, and measured against the original at 512 and
 * 1024px it holds only ~83% silhouette agreement where trace-512 holds ~97%.
 * The ratings judged the small end only. 6 KB is not worth a visibly simpler
 * mark at watermark size.
 *
 * WHY NOT SIMPLIFY AT ALL: every dilate/close rung was rejected 49 times out of
 * 52. Anti-aliased grey at 20px is how sub-pixel detail is carried, not haze —
 * crisping it away removes the information that made the mark readable.
 * ========================================================================== */
export const IMPORT_RECIPE: Recipe = {
  id: 'trace-512',
  label: 'trace @512',
  render: 512,
  dilate: 0,
  close: false,
  turdSize: 2,
  alphaMax: 1,
};

/**
 * Master raster -> the one clean SVG we store. Output always carries a viewBox,
 * an xmlns and currentColor fills — the three things every logo currently in the
 * library is missing at least one of.
 */
export async function importArtwork(source: Bitmap): Promise<{ svg: string; paths: number; bytes: number }> {
  const c = await runRecipe(source, IMPORT_RECIPE);
  return { svg: c.svg, paths: c.paths, bytes: c.bytes };
}

/**
 * The horse race. `source` is the master art as pixels; every rung plus two
 * CONTROLS — the untouched original and an SVGO-only pass — so "did any of this
 * help" is answerable from the same table rather than from memory.
 */
export async function race(
  source: Bitmap,
  originalSvg: string | null,
): Promise<Candidate[]> {
  const out: Candidate[] = [];

  /* The reference every candidate is judged against. When the source is an
     uploaded PNG with no control SVG there is nothing to be faithful TO, so
     fidelity is reported as 100 and score collapses to crispness alone — stated
     here rather than left to be inferred from a suspiciously perfect column. */
  const masterMask = originalSvg ? await silhouette(originalSvg) : undefined;

  if (originalSvg) {
    const t0 = Date.now();
    const [a20, a40] = await Promise.all([scoreSvgAt(originalSvg, 20), scoreSvgAt(originalSvg, 40)]);
    out.push({
      id: 'original',
      label: 'original (control)',
      svg: originalSvg,
      bytes: originalSvg.length,
      paths: (originalSvg.match(/<path\b/gi) || []).length,
      at20: a20,
      at40: a40,
      fidelity: 100, // it IS the reference
      score: combine(100, a20.mush),
      ms: Date.now() - t0,
    });
    const t1 = Date.now();
    const opt = optimizeSvg(originalSvg, 2);
    const [b20, b40, bMask] = await Promise.all([
      scoreSvgAt(opt, 20),
      scoreSvgAt(opt, 40),
      silhouette(opt),
    ]);
    const bFid = iou(masterMask!, bMask);
    out.push({
      id: 'svgo-only',
      label: 'SVGO only (control)',
      svg: opt,
      bytes: opt.length,
      paths: (opt.match(/<path\b/gi) || []).length,
      at20: b20,
      at40: b40,
      fidelity: bFid,
      score: combine(bFid, b20.mush),
      ms: Date.now() - t1,
    });
  }

  for (const r of LADDER) {
    try {
      out.push(await runRecipe(source, r, masterMask));
    } catch (e) {
      /* One bad rung must never sink the race — the other candidates are still
         the answer, and a missing tile is self-explanatory in the grid. */
      out.push({
        id: r.id,
        label: r.label + ' — FAILED: ' + (e as Error).message,
        svg: '',
        bytes: 0,
        paths: 0,
        at20: { ink: 0, mush: 0 },
        at40: { ink: 0, mush: 0 },
        fidelity: 0,
        score: 0,
        ms: 0,
      });
    }
  }
  return out;
}
