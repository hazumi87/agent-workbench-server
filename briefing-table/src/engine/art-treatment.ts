/**
 * A TREATMENT FIELD THE PANE DOES NOT CARRY IS INHERITED FROM THE ART.
 *
 * Owner, 2026-09-21: "i'm not seeing the treatment applied to the watermarks in
 * the cli windows." He had set engrave on `the design system`, hatch on `Kiosk` and
 * halftone on `briefing-table` — on the ART, which is where the Icons page
 * edits it — and every pane still painted a flat fill.
 *
 * The data said why, and said it cleanly: those recipes' logo prefs were
 * written before the v21 fields existed, so they carry `key, mono, opacity,
 * scale` and NOTHING ELSE. Inheritance happened only at PICK time, which is the
 * right rule for a value someone may have tuned — and it silently excluded
 * every pref that predates the field.
 *
 * **ABSENT IS NOT "CHOSEN NONE".** Because the key is genuinely missing from
 * the JSON we can tell those apart instead of guessing, which is the same
 * three-outcome discipline the directory check settled on. An explicit value
 * always wins: someone who set `line: 'none'` on a recipe keeps a flat fill
 * even when the art says hatch.
 *
 * SCALE AND OPACITY ARE NOT INHERITED, deliberately. the design system rule is that each
 * recipe keeps its own, and every one of these prefs already HAS them; the
 * art's values are defaults for a recipe picking it fresh, never a later
 * override.
 *
 * This lives in the ENGINE rather than in each page so the solo window, the
 * shell's tab marks and the manager cannot drift apart on what a pane looks
 * like — the drift that produced two different status glyphs in 2026-09-01.
 */

/** Only the treatment. Scale and opacity are the recipe's, by the design system rule. */
export const WM_TREATMENT_KEYS = ['line', 'washFrom', 'backlit'] as const;

/**
 * THE ART OWNS THE COLOR (Owner's ruling, 2026-09-21).
 *
 * "the problem with the color being stored with the recipe and not the icon is
 * that I have varied colors per recipe. it's making management more difficult."
 * Two recipes for one project — a VRPC checkout and its server twin — drifted to
 * different colors, and eleven others sat on the form's default because nobody
 * had ever deliberately picked one.
 *
 * ART WINS, and unlike the treatment fields this is NOT an inherit-if-absent:
 * every recipe already has a color, so "absent" does not exist and there is
 * nothing to infer from. Where the art states a color it IS the color, and the
 * recipe's own value is ignored on read — one place to change it, nothing to
 * reconcile, and the same shape the Project entity will take (the design notes
 * §2, where color is the project's and the art is its face).
 *
 * The stored recipe column is deliberately left alone rather than migrated: it
 * is what a rollback would read, and it is what the Project migration will pick
 * up. Ignoring a value is reversible; overwriting seventeen rows is not.
 */
export function artColor(
  logoRaw: string | null | undefined,
  listArt: () => ArtRow[],
): string | null {
  if (!logoRaw) {
    return null;
  }
  let pref: Record<string, unknown>;
  try {
    pref = JSON.parse(logoRaw);
  } catch {
    return null;
  }
  const key = typeof pref.key === 'string' ? pref.key : '';
  if (!key.startsWith('lib:')) {
    return null; // an the design system preset is shared installation-wide: it can carry no project's color
  }
  const id = Number(key.slice(4));
  if (!Number.isFinite(id)) {
    return null;
  }
  const art = listArt().find((l) => l.id === id);
  if (!art?.style) {
    return null;
  }
  try {
    const style = JSON.parse(art.style);
    return typeof style.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(style.color)
      ? style.color
      : null;
  } catch {
    return null;
  }
}

export interface ArtRow {
  id: number;
  /** The art's own treatment, as stored by the Icons page, or null. */
  style?: string | null;
}

/**
 * Fill the treatment fields a logo pref does not mention from the art it names.
 * Returns the pref unchanged — the SAME string — whenever there is nothing to
 * do, so a caller can hand this every pref on every read without churn.
 *
 * `listArt` is a thunk so the table is only touched when a pref actually names
 * a library set: most reads return before it is ever called.
 */
export function inheritArtTreatment(
  raw: string | null | undefined,
  listArt: () => ArtRow[],
): string | null {
  if (!raw) {
    return raw ?? null;
  }
  let pref: Record<string, unknown>;
  try {
    pref = JSON.parse(raw);
  } catch {
    return raw; // not our JSON — pass it through untouched
  }
  const key = typeof pref.key === 'string' ? pref.key : '';
  if (!key.startsWith('lib:')) {
    return raw; // an the design system preset or a pasted one-off carries no stored style
  }
  const missing = WM_TREATMENT_KEYS.filter((k) => !(k in pref));
  if (missing.length === 0) {
    return raw; // the pane has its own opinion on all three
  }
  const id = Number(key.slice(4));
  if (!Number.isFinite(id)) {
    return raw;
  }
  const art = listArt().find((l) => l.id === id);
  if (!art?.style) {
    return raw;
  }
  let style: Record<string, unknown>;
  try {
    style = JSON.parse(art.style);
  } catch {
    return raw;
  }
  let filled = 0;
  for (const k of missing) {
    if (style[k] !== undefined) {
      pref[k] = style[k];
      filled += 1;
    }
  }
  return filled ? JSON.stringify(pref) : raw;
}

/** The form's default, and therefore the one value that may mean "nobody
 *  chose" rather than "chose this". Only ever used as a TIE-BREAK. */
export const FORM_DEFAULT_COLOR = '#22b8a8';

/**
 * SEED AN ART'S COLOR FROM THE RECIPES ALREADY WEARING IT.
 *
 * Owner, 2026-09-21: "you need to populate the initial icons with the colors
 * that were locked in already. because they're all white and i'd have to
 * re-choose colors." Exactly right — art-wins shipped with no art stating a
 * color, so the Icons page would have opened on a neutral swatch and every
 * project's identity would have had to be picked again from memory.
 *
 * The colors are not lost, they are on the recipes. Measured before writing
 * this: all ten pieces of art in use had recipes that AGREE, so the common case
 * needs no judgement at all. The tie-breaks exist for the case that is one
 * rename away rather than because the data demanded them:
 *
 *   1. the most common color wins — N recipes voting is better evidence than
 *      any single row's timestamp;
 *   2. on a tie, a color that is NOT the form default wins, because the default
 *      is the one value that may mean "nobody ever chose" (eleven recipes sat
 *      on it);
 *   3. still tied → the most recently updated recipe, as the freshest intent.
 *
 * Returns null when there is nothing to go on, and the caller then leaves the
 * art alone: an art with no color simply lets each recipe keep its own, which
 * is exactly the behaviour before this existed.
 */
export function chooseArtColor(
  entries: { color?: string | null; updated_at?: number | null }[],
): string | null {
  const valid = entries.filter(
    (e): e is { color: string; updated_at?: number | null } =>
      typeof e.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(e.color),
  );
  if (valid.length === 0) {
    return null;
  }
  const tally = new Map<string, { n: number; newest: number }>();
  for (const e of valid) {
    const key = e.color.toLowerCase();
    const cur = tally.get(key) ?? { n: 0, newest: 0 };
    cur.n += 1;
    cur.newest = Math.max(cur.newest, Number(e.updated_at) || 0);
    tally.set(key, cur);
  }
  const ranked = [...tally.entries()].sort((a, z) => {
    if (z[1].n !== a[1].n) {
      return z[1].n - a[1].n;
    }
    const aDefault = a[0] === FORM_DEFAULT_COLOR;
    const zDefault = z[0] === FORM_DEFAULT_COLOR;
    if (aDefault !== zDefault) {
      return aDefault ? 1 : -1;
    }
    return z[1].newest - a[1].newest;
  });
  return ranked[0][0];
}
