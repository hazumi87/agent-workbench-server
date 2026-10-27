/**
 * Per-recipe EXTRA COMMAND-LINE ARGUMENTS for a vendor's CLI (Owner 2026-10-03,
 * Codex vendor). Codex needs per-recipe writable roots, network access and an
 * approval policy, and those differ by agent, so the smallest honest mechanism
 * is one list of raw arguments appended to the vendor's invocation. `initCmd`
 * could not serve: it is only typed for a vendor WITHOUT a module (class 2), and
 * a vendor that is launched by its invocation ignores it.
 *
 * Stored as a JSON array in `recipes.vendorArgs`; the API and the manager form
 * speak either an array or ONE ARGUMENT PER LINE (so a value with spaces or
 * quotes needs no shell escaping from the human — the vendor quotes it).
 *
 * No imports, no side effects: a test can ask this module a question without
 * opening a table.
 */
export const VENDOR_ARGS_MAX = 40;
export const VENDOR_ARG_MAX_LEN = 500;

// Any C0 control or DEL. A newline would split a typed command line; ESC could
// do worse. Strings only, never a shell fragment.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type VendorArgsResult = { ok: true; args: string[] | null } | { ok: false; error: string };

/** Validate a client's value: an array of strings, a string (one arg per line),
 *  or null/''/undefined (= none). Empty lines are dropped. */
export function parseVendorArgs(v: unknown): VendorArgsResult {
  if (v === undefined || v === null || v === '') {
    return { ok: true, args: null };
  }
  let list: unknown[];
  if (typeof v === 'string') {
    list = v.split(/\r?\n/);
  } else if (Array.isArray(v)) {
    list = v;
  } else {
    return { ok: false, error: 'vendorArgs is a list of strings (one argument each)' };
  }
  const out: string[] = [];
  for (const a of list) {
    if (typeof a !== 'string') {
      return { ok: false, error: 'vendorArgs entries are strings' };
    }
    if (typeof v === 'string' && !a.trim()) {
      continue; // blank line in the form
    }
    if (!a) {
      return { ok: false, error: 'vendorArgs entries are not empty' };
    }
    if (CONTROL_RE.test(a)) {
      return { ok: false, error: 'vendorArgs entries are one line each (no newlines or control characters)' };
    }
    if (a.length > VENDOR_ARG_MAX_LEN) {
      return { ok: false, error: `a vendorArgs entry is at most ${VENDOR_ARG_MAX_LEN} characters` };
    }
    out.push(a);
  }
  if (out.length > VENDOR_ARGS_MAX) {
    return { ok: false, error: `vendorArgs holds at most ${VENDOR_ARGS_MAX} entries` };
  }
  return { ok: true, args: out.length ? out : null };
}

/** Read the stored JSON back to a list. Anything malformed reads as none. */
export function readStoredVendorArgs(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  try {
    const r = parseVendorArgs(JSON.parse(raw));
    return r.ok ? r.args : null;
  } catch {
    return null;
  }
}
