/**
 * Per-recipe CHECKBOX SETTINGS for a vendor's CLI (Owner 2026-10-09, room [ref]): the
 * handful of `-c key=value` switches that used to be typed into "Extra arguments" on every
 * Codex recipe, as named flags the manager shows as checkboxes. Stored as a JSON array of
 * flag ids in `recipes.vendorFlags`; the vendor turns the ids into arguments.
 *
 * The engine owns the id -> argument map (a typed id can never inject an argument, unlike a
 * free-text field); web/manager.html carries the labels, and test/vendor-flags.test.ts pins
 * the two lists together. No imports, no side effects.
 */
export interface VendorFlag {
  id: string;
  /** What the checkbox does, in the manager's words. */
  label: string;
  /** `-c`, `key=value` — repeated -c keys only, so a later recipe argument can still win. */
  args: readonly [string, string];
}

export const CODEX_FLAGS: readonly VendorFlag[] = [
  { id: 'network', label: 'Network access in the sandbox', args: ['-c', 'sandbox_workspace_write.network_access=true'] },
  { id: 'auto-review', label: 'Auto-review approvals', args: ['-c', 'approvals_reviewer="auto_review"'] },
];

const BY_VENDOR: Record<string, readonly VendorFlag[]> = { 'codex-cli': CODEX_FLAGS };

export type VendorFlagsResult = { ok: true; flags: string[] | null } | { ok: false; error: string };

/** Validate a client's value: an array of known flag ids (null / '' / [] = none). A vendor with
 *  no flags accepts only none; an unknown id is refused, never dropped. */
export function parseVendorFlags(v: unknown, vendor: string | null | undefined): VendorFlagsResult {
  if (v === undefined || v === null || v === '') {
    return { ok: true, flags: null };
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    return { ok: false, error: 'vendorFlags is a list of flag ids' };
  }
  const known = new Set((BY_VENDOR[vendor ?? ''] ?? []).map((f) => f.id));
  const bad = v.find((x) => !known.has(x));
  if (bad !== undefined) {
    return { ok: false, error: `unknown ${vendor ?? 'vendor'} flag "${bad}"` };
  }
  const out = [...new Set(v as string[])];
  return { ok: true, flags: out.length ? out : null };
}

/** Read the stored JSON back to a list. Anything malformed or unknown reads as none. */
export function readStoredVendorFlags(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  try {
    const l = JSON.parse(raw);
    return Array.isArray(l) && l.every((x) => typeof x === 'string') && l.length ? [...new Set<string>(l)] : null;
  } catch {
    return null;
  }
}

/** The `-c`, `key=value` pairs for a recipe's ticked ids, in catalog order (stable command
 *  lines). Ids the vendor does not know are skipped here; the API refuses them on write. */
export function flagArgsFor(vendor: string, ids: readonly string[] | null | undefined): string[] {
  const on = new Set(ids ?? []);
  return (BY_VENDOR[vendor] ?? []).filter((f) => on.has(f.id)).flatMap((f) => [...f.args]);
}
