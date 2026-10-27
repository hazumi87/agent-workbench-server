/**
 * Pre-trust a hosted BASIC user's own project folders in their `~/.claude.json` (Owner 2026-10-10, room interface [ref]).
 *
 * This is a DELIBERATE, SCOPED override of decision D5 ("never write hasTrustDialogAccepted", the design notes):
 * it applies ONLY to the folders the Basic provisioning script creates for that user, never to the server or any advanced
 * user. Reason: the trust prompt defaults to "No, exit" and a phone user cannot reach the keys to answer it, so the first
 * launch strands them.
 *
 * Pure: takes the file's current text (or null), returns the new text. It MERGES: every other key and every other project
 * entry survives untouched; unparseable input is REFUSED (the caller leaves the file alone and says so), never rewritten.
 */

export type TrustResult = { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

export function withTrusted(current: string | null, dirs: string[]): TrustResult {
  let doc: Record<string, unknown> = {};
  if (current !== null && current.trim() !== '') {
    try {
      const parsed = JSON.parse(current);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'not a JSON object' };
      }
      doc = parsed as Record<string, unknown>;
    } catch (e) {
      return { ok: false, reason: `not valid JSON (${(e as Error).message})` };
    }
  }
  const rawProjects = doc.projects;
  if (rawProjects !== undefined && (rawProjects === null || typeof rawProjects !== 'object' || Array.isArray(rawProjects))) {
    return { ok: false, reason: '"projects" is not an object' };
  }
  const projects = { ...((rawProjects as Record<string, unknown>) ?? {}) };
  let changed = false;
  for (const dir of dirs) {
    const had = projects[dir];
    if (had !== undefined && (had === null || typeof had !== 'object' || Array.isArray(had))) {
      return { ok: false, reason: `projects[${dir}] is not an object` };
    }
    const entry = { ...((had as Record<string, unknown>) ?? {}) };
    if (entry.hasTrustDialogAccepted !== true) {
      entry.hasTrustDialogAccepted = true;
      changed = true;
    }
    projects[dir] = entry;
  }
  return { ok: true, text: JSON.stringify({ ...doc, projects }, null, 2) + '\n', changed };
}
