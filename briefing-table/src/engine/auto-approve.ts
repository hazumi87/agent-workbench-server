/* AUTO-APPROVE (the "YOLO" choice), one place. Owner 2026-10-26 ([ref]): the first-run setup sets the DEFAULT, off unless chosen and disclosed; every recipe carries its own
 * tri-state `follow | on | off` (new recipes `follow`); the engine resolves the effective value at launch. Pure: no database, no I/O, so the rule is testable and nothing else
 * reads the raw fields.
 *
 * WHAT IT DRIVES: only a vendor's own APPROVAL MODE (today Gemini's `--approval-mode yolo`). It does NOT drive Codex's hook-trust bypass or Claude's folder trust (H2 and H3 have
 * their own fixes), and it adds no flag for a vendor that has no such mode. */

export const AUTO_APPROVE_SETTINGS = ['follow', 'on', 'off'] as const;
export type AutoApproveSetting = (typeof AUTO_APPROVE_SETTINGS)[number];
export type AutoApproveDefault = 'on' | 'off';

export function isAutoApproveSetting(v: unknown): v is AutoApproveSetting {
  return typeof v === 'string' && (AUTO_APPROVE_SETTINGS as readonly string[]).includes(v);
}

/** What a stored/loose value reads as: a missing or unknown value is `follow` (the safe reading: it takes the default, which is off until chosen). */
export function readSetting(v: unknown): AutoApproveSetting {
  return isAutoApproveSetting(v) ? v : 'follow';
}

/** The default as stored (engine setting `autoApprove`): `{default, disclosedAt, by}`. Anything unreadable is "off". */
export interface AutoApproveState {
  default: AutoApproveDefault;
  disclosedAt: number | null;
  by: string | null;
}
export function readState(raw: unknown): AutoApproveState {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    default: o.default === 'on' ? 'on' : 'off',
    disclosedAt: typeof o.disclosedAt === 'number' ? o.disclosedAt : null,
    by: typeof o.by === 'string' ? o.by : null,
  };
}

/** THE resolver: `on`/`off` on the recipe wins; `follow` takes the default. An unknown value is treated as off (never a silent on). */
export function effectiveAutoApprove(setting: unknown, def: AutoApproveDefault): AutoApproveDefault {
  if (setting === 'on') return 'on';
  if (setting === 'off') return 'off';
  if (setting === 'follow' || setting === undefined || setting === null || setting === '') return def;
  return 'off';
}

/** Where the effective value came from, for Settings ("why is this on?"). */
export function autoApproveSource(setting: unknown): 'recipe' | 'default' {
  return setting === 'on' || setting === 'off' ? 'recipe' : 'default';
}

/** The engine's current default, read through a hook the server sets at boot (this module stays free of the database). Off until something is wired and chosen. */
let readDefault: () => AutoApproveDefault = () => 'off';
export function setDefaultReader(fn: () => AutoApproveDefault): void {
  readDefault = fn;
}
export function autoApproveDefault(): AutoApproveDefault {
  try {
    return readDefault() === 'on' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}
/** What a launch of THIS recipe runs with. */
export function effectiveFor(recipe: { autoApprove?: unknown } | null | undefined): AutoApproveDefault {
  return effectiveAutoApprove(recipe?.autoApprove, autoApproveDefault());
}
