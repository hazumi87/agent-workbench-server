/* BRAND JOIN — vendor -> the brand data the design system v21 chrome takes.
 *
 * The engine OWNS the brand table (GET /api/brands, web/brands.json); the design system
 * owns every pixel made from it. This module is the one place a surface turns a
 * session's `vendor` into the three things the bundle asks for:
 *
 *   brand       a brand-marks KEY (claude | codex | gemini | generic …) — the
 *               bundle resolves an unknown key to `generic` itself
 *   brandColor  the DESIGNED hue as a colour: `oklch(.65 .13 <brandHue>)`, the
 *               same --brand-src the design system own mockups and hwb-example.html use.
 *               The bundle only reads its hue (oklch(from … h)), so L/C here are
 *               a carrier, not a design choice. NEVER the literal vendor colour
 *               (`brandColor` in brands.json): Codex and Ollama are achromatic
 *               there and would collapse to one grey. A brand with no brandHue
 *               gets no colour at all and renders on the neutral --dim plate.
 *   label       the vendor's display name (tooltips)
 *
 * Pure and import-free so node can test it; callers pair `brand` with
 * brandMarkPath() from web/aurora/brand-marks/aurora-brand-marks.js.
 *
 * `vendor` is never guessed (CLAUDE.md 2026-09-17): a row with nothing recorded
 * reports the literal "unknown", which — like any vendor with no entry —
 * resolves to the table's mandatory `generic` entry.
 */

export function brandColorFromHue(hue) {
  const h = Number(hue);
  if (!Number.isFinite(h)) {
    return undefined;
  }
  return `oklch(.65 .13 ${Math.round(((h % 360) + 360) % 360)})`;
}

/** list: the `brands` array from /api/brands (or null before it loads). */
export function resolveBrand(list, vendor) {
  const arr = Array.isArray(list) ? list : [];
  const hit = arr.find((b) => b && b.vendor === vendor)
    || arr.find((b) => b && b.vendor === 'generic')
    || null;
  return {
    vendor: vendor || 'unknown',
    brand: (hit && typeof hit.brandMark === 'string' && hit.brandMark) || 'generic',
    brandColor: hit ? brandColorFromHue(hit.brandHue) : undefined,
    label: (hit && hit.label) || 'Unbranded',
  };
}

/* ---- the table, fetched once per page -------------------------------------
   A lookup table that changes when a brand is added (roughly never), so one
   fetch per page load is the whole cache. Until it lands every vendor resolves
   to `generic`; callers re-render when the promise settles. */
let cached = null;
let pending = null;

export function loadBrands() {
  if (cached) {
    return Promise.resolve(cached);
  }
  if (!pending) {
    pending = fetch('/api/brands')
      .then((r) => (r.ok ? r.json() : { brands: [] }))
      .then((j) => {
        cached = Array.isArray(j.brands) ? j.brands : [];
        return cached;
      })
      .catch(() => {
        pending = null; // let a later caller retry; resolve to generic meanwhile
        return [];
      });
  }
  return pending;
}

export function brandFor(vendor) {
  return resolveBrand(cached, vendor);
}
