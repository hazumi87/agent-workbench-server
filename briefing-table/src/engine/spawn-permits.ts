/* SPAWN PERMITS — a reload must never resurrect a dead session (Owner, web,
 * 2026-09-04).
 *
 * "if I go away from my laptop, and pick up a session elsewhere, when I return
 * to the pane on the laptop I think the browser does a wake-up refresh ... it
 * loads a new session in the same project which opens with no history. so then
 * I'm left with an empty session in the cli manager."
 *
 * `handleAttach` reattaches when a live session exists and otherwise SPAWNS —
 * "first viewer for this pane (or the prior session ended)". Those two are
 * indistinguishable from the engine's side: a woken tab's reload sends exactly
 * the attach a deliberate launch does. So the tab silently re-created the pane
 * as an empty CLI and the real conversation was replaced by nothing.
 *
 * The launch endpoint is the only place that knows a HUMAN asked for a session,
 * so it mints a short-lived permit and the attach consumes it. Anything that
 * arrives without one may reattach or restore, never create. In memory on
 * purpose: it must not survive an engine restart, and it must not be
 * forgeable from the page — a query parameter would ride through the very
 * reload we are defending against.
 *
 * Scoped to `recipe:` panes: component panes belong to the workbench prototype,
 * which has no launch endpoint and is not what broke.
 *
 * MOVED here from server/index.ts (2026-09-25, roster verbs [ticket]) so a
 * room seat can ask "is a start pending for this pane?" (`pending`) — the
 * seat's `starting` status — without a second copy of the rule. The launch
 * path (`launchRecipe` in index.ts) is still the ONLY caller of `grant`. */
const SPAWN_PERMIT_MS = Number(process.env.HARBOR_WB_SPAWN_PERMIT_MS ?? 120_000);
const permits = new Map<string, number>();

export function grant(paneid: string): void {
  permits.set(paneid, Date.now() + SPAWN_PERMIT_MS);
}

/** Consumes the permit. Returns false when this attach must not create a CLI. */
export function take(paneid: string): boolean {
  if (!paneid.startsWith('recipe:')) {
    return true; // components: unchanged
  }
  const until = permits.get(paneid);
  permits.delete(paneid);
  if (until === undefined) {
    return false;
  }
  return until > Date.now();
}

/** Read-only: a launch minted a permit for this pane and it has not expired.
 *  Never consumes. (An attach to a pane with NO row spawns without consuming
 *  it, so this stays true for a moment after a first spawn — callers ask it
 *  only about panes that have no session row yet.) */
export function pending(paneid: string): boolean {
  const until = permits.get(paneid);
  return until !== undefined && until > Date.now();
}
