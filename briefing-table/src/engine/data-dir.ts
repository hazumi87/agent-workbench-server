/**
 * THE INSTANCE ROOT [hosted] (Owner 2026-10-07, KB design-notes-id): one shared,
 * read-only copy of the engine code, and one INSTANCE per hosted user. Every
 * per-instance file the engine reads or writes (data/mapping.db, data/identity.db,
 * secrets/*, config.json, targets.json, the channel / mirror / scratch dirs that
 * hang off the table's folder, workers, tools, worktrees) resolves under
 * HARBOR_WB_DATA_DIR when it is set, keeping the same relative layout.
 *
 * Unset = exactly today's paths (the repo root), so the server does not change.
 * A specific override (HARBOR_WB_TABLE, HARBOR_WB_IDENTITY_DB, HARBOR_WB_TOKEN_FILE,
 * HARBOR_WB_CONFIG, ...) still wins over both. Code assets (web/, web/brands.json,
 * the vendored presets, src/components) stay in the repo.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The instance's own data dir, or null when this engine runs from its checkout. */
export function dataDir(): string | null {
  return process.env.HARBOR_WB_DATA_DIR || null;
}

/** A per-instance path: under HARBOR_WB_DATA_DIR when set, else under the repo root. */
export function instancePath(...parts: string[]): string {
  return join(dataDir() ?? REPO_ROOT, ...parts);
}
