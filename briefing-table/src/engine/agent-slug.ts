/* ============================================================================
 * AGENT SLUG (Stage 2 / E1) — the one identity key that survives everything.
 *
 * Contract §1 (v0.4): the layers are project / work slug / instance, and ROLE
 * was dropped from the record — the agent's context IS the role. What this
 * module derives is the PROJECT id (the degenerate case: correct while a
 * project has one colleague). Lowercase,
 * hyphens. Everything a RUNTIME hands you — a Claude transcript uuid, a
 * paneid, a dispatch task_id — is an INCARNATION and rotates (proven: 7 uuids
 * in one session's lineage, KB design-notes-id). The slug does not. It is
 * therefore the only thing that may be used as a key; incarnations are lineage.
 *
 * This module is deliberately pure string work: no db, no filesystem, no
 * network, no guess about which HOST a slug lives on. That is the registry's
 * job (`registry_resolve_dispatch_target`) and it must never be re-derived
 * here from a path that happens to look familiar.
 * ========================================================================== */

/** Longest slug we will store. A NATS subject token and a UI label both have
 *  to live with it; 64 is far past `<project>-<hash>` and far short of "someone
 *  pasted a sentence". */
const MAX = 64;

/**
 * Normalise anything a human typed into a legal slug, or null if nothing is
 * left. Lowercase; every run of non-[a-z0-9] becomes a single hyphen; leading
 * and trailing hyphens are stripped.
 *
 * THE OUTPUT ALPHABET IS LOAD-BEARING, not cosmetic: the slug is interpolated
 * into the NATS subject `agent.<slug>.state`, where `.`, `*` and `>` are
 * SUBJECT SYNTAX. A slug carrying one of those would publish to a subject
 * nobody asked for, or silently fail. Reducing to [a-z0-9-] makes that
 * unreachable by construction rather than by a check somewhere downstream.
 */
export function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/g, ''); // a slice can land mid-hyphen-run
  return slug || null;
}

/** True for a string that is ALREADY a legal slug (no coercion). */
export function isSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
}

/**
 * The basename of a project directory, for BOTH separator conventions.
 *
 * `node:path.basename` is platform-specific — on Linux it returns the whole of
 * `C:\projects\briefing-table` — and this engine reads paths written for the other
 * OS every day (a server-hosted engine holding VRPC recipes, and vice versa). So
 * split on either separator, explicitly.
 *
 * Trailing separators are dropped first: `normalizeProjectDir` already removes
 * them on write, but a slug may be derived from a value that never went through
 * it, and `/srv/code/kiosk/` yielding an EMPTY basename is precisely the
 * class of one-character bug that cost Kiosk its name for days (2026-09-13).
 */
export function projectBasename(dir: string): string | null {
  /* NO BACKSLASH APPEARS IN THIS FUNCTION'S SOURCE, and that is deliberate.
     The first version used a character class holding an escaped backslash; a
     shell heredoc ate one level of escaping on the way in and shipped a regex
     that matched only `/`, so every Windows path returned itself and the code
     around it read perfectly. Same family as the control characters that got
     into the asset-version regexes (2026-09-01) — a regex that silently never
     matches. `String.fromCharCode(92)` cannot be mangled by any layer between
     an editor and the file, and half this function's input is Windows paths. */
  const BACKSLASH = String.fromCharCode(92);
  const unified = dir.split(BACKSLASH).join('/');
  let end = unified.length;
  while (end > 0 && unified[end - 1] === '/') {
    end -= 1; // trailing separators: `/srv/code/kiosk/` is not nameless
  }
  const cut = unified.lastIndexOf('/', end - 1);
  return unified.slice(cut + 1, end) || null;
}

/**
 * The vendors that run a BRAND AGENT — the only recipes that carry an identity
 * by default (wr §2.9, identity hygiene). Every recipe vendor except
 * `cli-manager`, which is the generic-shell class (the design notes):
 * a bare terminal is not a member of anything, and none is the honest answer.
 *
 * Stated as an explicit list, not as "everything but cli-manager", so a vendor
 * nobody has classified yet (the script-widget class, a typo that got past a
 * validator) defaults to NO identity rather than to a made-up one. The list is
 * kept equal to `RECIPE_VENDORS` minus `cli-manager` by
 * test/agent-slug-derive.test.ts — this module is pure and does not import the
 * store to find out.
 */
export const BRAND_VENDORS: readonly string[] = Object.freeze(['claude-code', 'gemini-cli', 'codex-cli', 'ollama']);

/** Does a recipe of this vendor run a brand agent? Unknown or missing = no. */
export function isBrandVendor(vendor: unknown): boolean {
  return typeof vendor === 'string' && BRAND_VENDORS.includes(vendor);
}

/**
 * The project id a folder yields: the bare, normalised `basename(projectDir)`
 * — the registry node id, NO role suffix. SUPERSEDES the earlier `<basename>-cli`
 * default (2026-09-17): measured against the live fabric, service registry's
 * node ids are the bare project names (`briefing-table`, `kiosk`, `the design system`,
 * `homehub`) and the installation's relay slugs already match them — `<project>-cli`
 * was a role suffix the registry never asked for and the fabric rejects at
 * subscribe and at send. A hyphenated slug is still legal for a human to TYPE
 * (multiple agents on one project do need to disambiguate), it is simply not
 * what a folder derives to.
 *
 * FALLBACK ORDER: projectDir, then the recipe's display name, then null. A
 * recipe with neither is not identifiable and gets no slug rather than a made-up
 * one — an agent with a wrong stable identity is worse than one with none,
 * because everything downstream treats the slug as true.
 *
 * Vendor-blind string work: whether the recipe SHOULD carry this is
 * `deriveSlug`'s question, not this one's.
 */
export function projectSlug(opts: { projectDir?: string | null; name?: string | null }): string | null {
  const base = opts.projectDir ? projectBasename(opts.projectDir) : null;
  return normalizeSlug(base) ?? normalizeSlug(opts.name ?? null);
}

/**
 * THE FINGERPRINT: is `slug` what the machine derives from this FOLDER?
 *
 * "Typed" is not stored — there is no column saying a human chose a slug, and
 * adding one would be a migration for a distinction the data already carries.
 * A slug the engine derived from a folder is, by construction, exactly
 * `normalizeSlug(basename(projectDir))` (or its pre-2026-09-17 `<that>-cli`
 * form, which an older boot backfill wrote). Anything else was typed, or
 * derived from the recipe NAME — and a name-derived slug is kept on purpose:
 * `Local command bridge` is the named escape hatch for a tool that is not a brand
 * but does need addressing (wr §2.9).
 *
 * THE LIMIT, accepted: a human who types exactly the folder's basename for a
 * terminal is indistinguishable from the derivation, and is treated as it.
 * Same trade `backfillRecipeAgents` makes for the old `-cli` form, in the
 * opposite direction.
 */
export function isFolderDerived(slug: string | null | undefined, projectDir: string | null | undefined): boolean {
  if (!slug || !projectDir) {
    return false;
  }
  const bare = normalizeSlug(projectBasename(projectDir));
  return !!bare && (slug === bare || slug === normalizeSlug(`${bare}-cli`));
}

/**
 * The slug a recipe gets when the user left the field empty.
 *
 * A BRAND vendor derives its project id (`projectSlug`). Anything else — a bare
 * shell — gets NONE (wr §2.9): a terminal at `/srv/code` used to derive
 * `code`, a project id that names no registry node, and two unrelated terminals
 * on different hosts then both claimed it. `vendor` is REQUIRED in the type on
 * purpose: a caller that forgets it gets no identity, never a derived one.
 */
export function deriveSlug(opts: {
  projectDir?: string | null;
  name?: string | null;
  vendor: string | null | undefined;
}): string | null {
  return isBrandVendor(opts.vendor) ? projectSlug(opts) : null;
}

/**
 * What the user typed, if it is usable; otherwise the derived default.
 * One call site on the write path, so "empty means derive" is stated once.
 *
 * For a non-brand vendor a typed value that carries the FOLDER FINGERPRINT is
 * read as the old derivation coming back (the manager form re-sends the stored
 * slug on every save, so switching a recipe from claude-code to a terminal
 * would otherwise carry the derived id across) and is dropped. Without this the
 * save would keep what the next boot's `reconcileTerminalSlugs` clears — a
 * value that silently flips on restart. Dropped at save, it is visible at once.
 */
export function resolveSlug(
  typed: unknown,
  opts: { projectDir?: string | null; name?: string | null; vendor: string | null | undefined },
): string | null {
  const t = normalizeSlug(typed);
  if (t && (isBrandVendor(opts.vendor) || !isFolderDerived(t, opts.projectDir))) {
    return t;
  }
  return deriveSlug(opts);
}

/**
 * THE BOOT SWEEP for identity hygiene (wr §2.9): every non-brand recipe whose
 * stored slug carries the folder fingerprint loses it. Pure — the caller hands
 * in the recipes and the setter, so this module stays free of the db (the
 * `backfillRecipeAgents` posture, and the store is not this track's file).
 *
 * Name-derived and typed slugs are untouched (see `isFolderDerived`), brand
 * recipes are untouched, and a second run finds nothing: an agent of null has
 * no fingerprint. Returns what it cleared so the caller can log each one.
 *
 * Why a sweep and not only the new derivation: the boot backfill refills an
 * EMPTY slug and never clears a set one, so the terminals that already derived
 * `code` / `tmp` would keep them forever. "No identity" had to become something
 * the boot can reach.
 */
export function reconcileTerminalSlugs(
  recipes: ReadonlyArray<{ id: string; name: string; vendor?: string | null; projectDir?: string | null; agent?: string | null }>,
  setAgent: (id: string, agent: null) => void,
): Array<{ id: string; name: string; cleared: string }> {
  const done: Array<{ id: string; name: string; cleared: string }> = [];
  for (const r of recipes) {
    if (isBrandVendor(r.vendor) || !r.agent || !isFolderDerived(r.agent, r.projectDir)) {
      continue;
    }
    setAgent(r.id, null);
    done.push({ id: r.id, name: r.name, cleared: r.agent });
  }
  return done;
}
