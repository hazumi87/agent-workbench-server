/**
 * BRAND IDENTITY (contract §9) — the lookup table the engine serves so a brand
 * can be made legible, and the rules that keep it legible.
 *
 * OWNERSHIP, stated because it is the whole reason this file is thin: the
 * ENGINE decides that `vendor` is the join key, that there is one designed hue
 * and one mark KEY, and that it is served. The design system defines every pixel — ring,
 * background, tab mark, how a brand field reads behind a state ring, what
 * twenty sessions of four brands look like in one list. Nothing here describes
 * a shape, a motion or a size.
 *
 * TWO COLOUR FIELDS serve different purposes:
 *
 *   · `brandColor` is the LITERAL vendor colour — the one on their website. It
 *     is for large surfaces and About screens, where a brand should look like
 *     itself.
 *   · `brandHue` is a DESIGNED integer 0-359 and is the GLYPH input. It is
 *     assigned, not sampled, because Codex's and Ollama's real marks are
 *     ACHROMATIC: derive a field from their true colours and both collapse to
 *     the same grey, which destroys the one thing the mark is for — telling
 *     twelve panes apart at a glance.
 *
 * The separation rules below exist for the same reason. They are enforced at
 * boot rather than left to review because the failure is not a crash: two
 * brands 12 degrees apart simply look the same, forever, and nobody files that.
 *
 * NO `brandMarkDark`, by design: a mark is a `currentColor` silhouette, so it
 * inverts for free. Assets come from the vendored `web/aurora/brand-marks/`
 * (96×96 viewBox, currentColor, 72×72 safe area) — the same pin-never-fork line
 * as tokens.css.
 *
 * BRAND NEVER OVERRIDES PROJECT. A pane's identity accent is the PROJECT's;
 * brand is the second axis, and where they contend for a pixel, project wins.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPE_VENDORS } from '../table/endpoint.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRANDS_FILE = join(REPO_ROOT, 'web', 'brands.json');

export interface BrandIdentity {
  /** The enum value (§1.1) — the join key, and the only one. */
  vendor: string;
  /** What a human reads. Never parsed. */
  label: string;
  /** The DESIGNED hue, 0-359. Absent = achromatic ("unbranded"). */
  brandHue?: number;
  /** The literal vendor colour. Large/About surfaces only, never the glyph. */
  brandColor: string;
  /** A mark KEY in the design system vocabulary, resolved against the shared asset set. */
  brandMark: string;
  /** ISO date the brand was added. Ordering, not policy. */
  since?: string;
}

/** The fallback every unknown or class-2 vendor resolves to. MANDATORY. */
export const GENERIC_VENDOR = 'generic';

/** Mark keys are the design system vocabulary (`claude`, `gemini`, `codex`, `ollama`,
 *  `generic`), not ours — do NOT invent a `brand-*` namespace. */
const MARK_KEY = /^[a-z0-9-]{1,24}$/;

/** Minimum separation between two chromatic brands, in degrees of hue. */
const MIN_HUE_SEPARATION = 40;

/** How many chromatic brands the scheme can seat before hues must collide. */
const MAX_CHROMATIC = 7;

/** Shortest distance between two hues ON THE CIRCLE. 350 and 30 are 40 apart,
 *  not 320 — the naive subtraction is what would let a wrap-around collision
 *  through, and it would look exactly like a correctly-spaced pair in a table. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Every way this table can be wrong, as a list of sentences.
 *
 * PURE and returning problems rather than throwing, for two reasons: it is the
 * whole test surface for the rules, and a bad data file must not be able to
 * take the engine down at boot. The engine LOGS these loudly and serves the
 * table anyway — a brand rendering wrong is a cosmetic fault, and refusing to
 * start over one would trade it for an outage.
 */
export function validateBrands(brands: BrandIdentity[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const b of brands) {
    if (!b || typeof b.vendor !== 'string' || !b.vendor) {
      problems.push('a brand entry has no vendor');
      continue;
    }
    if (seen.has(b.vendor)) {
      problems.push(`duplicate brand entry for vendor "${b.vendor}"`);
    }
    seen.add(b.vendor);
    if (typeof b.label !== 'string' || !b.label) {
      problems.push(`brand "${b.vendor}" has no label`);
    }
    if (typeof b.brandColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.brandColor)) {
      problems.push(`brand "${b.vendor}" brandColor must be #rrggbb (got ${String(b.brandColor)})`);
    }
    if (typeof b.brandMark !== 'string' || !MARK_KEY.test(b.brandMark)) {
      problems.push(
        `brand "${b.vendor}" brandMark must be a built-in mark key [a-z0-9-]{1,24} (got ${String(b.brandMark)})`,
      );
    } else if (b.brandMark.startsWith('brand-')) {
      /* THE VOCABULARY IS the design system (`claude`, `gemini`, `codex`, `ollama`,
         `generic`). `brand-claude` was this engine's first guess at a naming
         scheme and the design system said no: a key resolves against THEIR asset set, so a
         prefix we invented resolves to nothing and renders as a hole. Caught
         here rather than left to review because a missing mark looks like a
         loading state, not a typo. */
      problems.push(
        `brand "${b.vendor}" brandMark "${b.brandMark}" uses an invented brand-* prefix — use a built-in mark key`,
      );
    }
    if (b.brandHue !== undefined && (!Number.isInteger(b.brandHue) || b.brandHue < 0 || b.brandHue > 359)) {
      problems.push(`brand "${b.vendor}" brandHue must be an integer 0-359 (got ${String(b.brandHue)})`);
    }
  }

  if (!seen.has(GENERIC_VENDOR)) {
    problems.push(
      `no "${GENERIC_VENDOR}" entry — it is what an unknown vendor resolves to, and a renderer must never be left with nothing to draw`,
    );
  }

  /* `generic` is the SENTINEL, not a brand: it is excluded from the separation
     rules because being unbranded is exactly its job. */
  const real = brands.filter((b) => b.vendor !== GENERIC_VENDOR);
  const chromatic = real.filter((b) => Number.isInteger(b.brandHue));
  const achromatic = real.filter((b) => !Number.isInteger(b.brandHue));

  if (achromatic.length > 1) {
    problems.push(
      `at most ONE achromatic brand (no brandHue) is distinguishable; found ${achromatic.length}: ${achromatic
        .map((b) => b.vendor)
        .join(', ')}`,
    );
  }
  if (chromatic.length > MAX_CHROMATIC) {
    problems.push(
      `at most ${MAX_CHROMATIC} chromatic brands fit at ${MIN_HUE_SEPARATION}° separation; found ${chromatic.length}`,
    );
  }
  for (let i = 0; i < chromatic.length; i += 1) {
    for (let j = i + 1; j < chromatic.length; j += 1) {
      const d = hueDistance(chromatic[i].brandHue!, chromatic[j].brandHue!);
      if (d < MIN_HUE_SEPARATION) {
        problems.push(
          `brands "${chromatic[i].vendor}" (${chromatic[i].brandHue}°) and "${chromatic[j].vendor}" (${chromatic[j].brandHue}°) are only ${d}° apart — minimum is ${MIN_HUE_SEPARATION}°`,
        );
      }
    }
  }

  /* EVERY ENUM VENDOR NEEDS AN ENTRY. `vendor` is the join key, so a session
     whose brand is missing here is a session a surface cannot draw. */
  for (const v of RECIPE_VENDORS) {
    if (!seen.has(v)) {
      problems.push(`vendor "${v}" is in the recipe enum but has no brand entry`);
    }
  }

  return problems;
}

let cache: BrandIdentity[] | null = null;

/**
 * The table, read once and cached hard (§9: "it changes when a brand is added,
 * which is roughly never"). Keys starting `_` are comments and are dropped.
 */
export function loadBrands(): BrandIdentity[] {
  if (cache) {
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(BRANDS_FILE, 'utf8')) as { brands?: unknown };
    cache = Array.isArray(raw.brands) ? (raw.brands as BrandIdentity[]) : [];
  } catch {
    /* A missing or broken file must not be a dead route: `generic` alone is a
       renderable answer, and the boot log says what happened. */
    cache = [{ vendor: GENERIC_VENDOR, label: 'Unbranded', brandColor: '#8a8f98', brandMark: 'generic' }];
  }
  return cache;
}

/** Boot check. Returns the problems so the caller can log them in its own
 *  format; an empty array is the normal answer. */
export function checkBrandsAtStartup(): string[] {
  return validateBrands(loadBrands());
}
