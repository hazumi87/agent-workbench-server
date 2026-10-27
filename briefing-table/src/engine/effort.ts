/**
 * The `claude --effort <level>` vocabulary (2026-09-28). ONE copy, imported by
 * the store (recipe validation), the claude-code vendor (the command line) and
 * the server (per-launch overrides) — the room-vocab.ts pattern, so the table
 * layer and the engine cannot disagree about which words are real.
 *
 * Verified on claude 2.1.284: `--help` lists low, medium, high, xhigh, max;
 * `ultracode` is accepted too (xhigh reasoning plus automatic workflow
 * orchestration) and prints no warning. An unknown value only makes claude
 * print "Unknown --effort value ... ignoring it", so the engine refuses it at
 * the edge (400) rather than saving a setting that silently does nothing.
 *
 * No imports, no side effects: a unit test can ask this module a question
 * without opening a table.
 */
export const RECIPE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;
export type RecipeEffort = (typeof RECIPE_EFFORTS)[number];

export function isRecipeEffort(v: unknown): v is RecipeEffort {
  return typeof v === 'string' && (RECIPE_EFFORTS as readonly string[]).includes(v);
}

/**
 * PER-VENDOR EFFORT VOCABULARY (Owner 2026-10-03, Codex vendor). `RECIPE_EFFORTS`
 * above stays Claude's list and every existing caller of `isRecipeEffort` keeps
 * its meaning; a caller that knows the pane's vendor asks `isEffortFor` instead.
 *
 * Codex has no `--effort` flag: the level rides `-c model_reasoning_effort="<x>"`.
 * The list is the one Codex's own catalog accepts as of 0.160.0; the MODEL decides
 * which of them it really supports and Codex rejects the rest itself, so this is
 * a spelling guard (nothing odd reaches a command line), not a capability table.
 * A vendor with no entry has no effort concept (gemini-cli, ollama, shells).
 */
/* Owner 2026-10-05: low..max only. `codex debug models` (chat-ops): every listed model takes low..max;
   none and minimal are refused by the GPT-6 family; ultra is on some models only. Stored old values are
   mapped by store.normalizeCodexEfforts. */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const EFFORTS_BY_VENDOR: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'claude-code': RECIPE_EFFORTS,
  'codex-cli': CODEX_EFFORTS,
});

/** The efforts a vendor accepts (empty = the vendor has no effort setting). */
export function effortsFor(vendor: string | null | undefined): readonly string[] {
  return (vendor && EFFORTS_BY_VENDOR[vendor]) || [];
}

/** Is `v` a real effort FOR THIS VENDOR? An unknown vendor is treated as
 *  Claude (the historical default every caller assumed). */
export function isEffortFor(vendor: string | null | undefined, v: unknown): v is string {
  const list = vendor && vendor !== 'cli-manager' ? effortsFor(vendor) : RECIPE_EFFORTS;
  return typeof v === 'string' && list.includes(v);
}

const MODEL_RE = /^[A-Za-z0-9._-]{1,40}$/;

export function isModelName(v: unknown): v is string {
  return typeof v === 'string' && MODEL_RE.test(v);
}

/**
 * A recipe as ONE launch runs it: per-launch {model, effort} beat the recipe's
 * own for this spawn only (the saved recipe is never touched — the caller gets
 * a copy). An override that is absent, empty or malformed leaves the recipe's
 * value standing; it is never a way to CLEAR one. Pure, so the precedence is
 * unit-testable apart from the attach path that uses it.
 */
export function applyLaunchOverrides<R extends { model: string | null; effort?: string | null; vendor?: string | null }>(
  recipe: R,
  overrides: { model?: unknown; effort?: unknown } = {},
): R {
  const model = typeof overrides.model === 'string' && MODEL_RE.test(overrides.model) ? overrides.model : null;
  const effort = isEffortFor(recipe.vendor, overrides.effort) ? (overrides.effort as string) : null;
  if (!model && !effort) {
    return recipe;
  }
  return { ...recipe, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** An agent's stored profile as the table keeps it: null = never snapshotted
 *  (a legacy row), '' = snapshotted as "claude's own default". */
export interface StoredProfile {
  model: string | null;
  effort: string | null;
}

/**
 * WHICH {model, effort} a launch of this pane runs with (Owner 2026-10-02, room
 * line 3245: "once they are minted the model and effort travel with them").
 *
 * PRECEDENCE: a pane that already has a stored profile (and was not ended —
 * `killed` is a fresh start) relaunches on THAT, whatever the url / message
 * override or the recipe says now: a project-default change must not move an
 * existing agent, and a reconnect that sends no override must not reset it.
 * A pane with no profile yet (a new mint, or a legacy row) takes the per-launch
 * override over the recipe's current value, and `write` says to store that
 * snapshot on the row. Pure so the precedence is unit-testable.
 */
export function resolveLaunchProfile(
  row: { state?: string; profile_model?: string | null; profile_effort?: string | null } | undefined,
  recipe: { model: string | null; effort?: string | null; vendor?: string | null },
  overrides: { model?: unknown; effort?: unknown } = {},
): { model: string | null; effort: string | null; write: boolean } {
  const has = !!row && row.state !== 'killed' && row.profile_model != null && row.profile_effort != null;
  if (has) {
    return { model: row!.profile_model || null, effort: row!.profile_effort || null, write: false };
  }
  const eff = applyLaunchOverrides(recipe, overrides);
  return { model: eff.model ?? null, effort: eff.effort ?? null, write: true };
}
