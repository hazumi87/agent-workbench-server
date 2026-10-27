/**
 * THE TWO PRESETS AND THE SIBLING RECIPE (the design notes §1, §3 item 2).
 *
 * The person picks Claude or Codex, nothing else. Switching to the OTHER vendor launches a sibling recipe: the
 * same project folder, the same agent slug (the same colleague with a different brain), the source's art (`logo`
 * and `color`: colour follows a recipe's own logo key), `worktree: never`, the preset's model and effort. It is
 * created idempotently on the first switch with a deterministic id and never edits the source. Switching BACK
 * targets the ORIGINAL recipe with per-launch model/effort overrides, so there is never a third recipe. Recipe ids,
 * pane ids, vendor session ids and credentials stay separate; nothing here depends on the fabric.
 */
import type { Recipe } from '../../table/store.ts';

export type SwitchTo = 'claude' | 'codex';

export const PRESETS: Record<SwitchTo, { vendor: 'claude-code' | 'codex-cli'; model: string; effort: string; label: string; brand: string }> = {
  claude: { vendor: 'claude-code', model: 'sonnet', effort: 'medium', label: 'Claude: Sonnet, medium effort', brand: 'Claude' },
  codex: { vendor: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium', label: 'Codex: gpt-6.1-sol, medium effort', brand: 'Codex' },
};

export function presetOfVendor(vendor: string | null | undefined): SwitchTo | null {
  return vendor === 'claude-code' ? 'claude' : vendor === 'codex-cli' ? 'codex' : null;
}

const SUFFIX: Record<SwitchTo, string> = { claude: '--claude', codex: '--codex' };

/** The recipe the family started from: a sibling's id minus its suffix. */
export function baseIdOf(id: string): string {
  return id.replace(/--(claude|codex)$/, '');
}

/** The sibling's deterministic id (stays inside the pane-id alphabet). */
export function siblingId(sourceId: string, to: SwitchTo): string {
  return `${baseIdOf(sourceId)}${SUFFIX[to]}`;
}

export interface SwitchTarget {
  /** the recipe to launch */
  recipeId: string;
  /** set when that recipe must be created first (never edits an existing recipe) */
  create: Recipe | null;
  /** per-launch overrides (the original recipe keeps its own stored model/effort) */
  launch: { model: string; effort: string };
}

/**
 * Where a switch from `source` to `to` lands. `get` reads a recipe by id. Pure apart from `get`.
 * - the family's ORIGINAL recipe already runs the target vendor: launch it with the preset as overrides;
 * - else the sibling `<base>--<to>`: reuse it when it exists, else describe it for creation.
 */
export function switchTarget(source: Recipe, to: SwitchTo, get: (id: string) => Recipe | undefined): SwitchTarget {
  const p = PRESETS[to];
  const base = get(baseIdOf(source.id)) ?? source;
  if (base.vendor === p.vendor) {
    return { recipeId: base.id, create: null, launch: { model: p.model, effort: p.effort } };
  }
  const id = siblingId(base.id, to);
  const have = get(id);
  if (have) {
    return { recipeId: id, create: null, launch: { model: p.model, effort: p.effort } };
  }
  const name = `${base.name} (${p.brand})`;
  return {
    recipeId: id,
    create: {
      ...base,
      id,
      name: name.trim() === 'Builder' ? `${name} sibling` : name,
      vendor: p.vendor,
      runClaude: p.vendor === 'claude-code' ? 1 : 0,
      model: p.model,
      effort: p.effort,
      vendorArgs: null,
      vendorFlags: null,
      worktree: 'never',
      resume: 0,
      resumeName: null,
      initCmd: null,
      logo: base.logo,
      color: base.color,
      agent: base.agent,
      last_launched_at: null,
    } as Recipe,
    launch: { model: p.model, effort: p.effort },
  };
}
