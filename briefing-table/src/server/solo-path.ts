/**
 * The RELATIVE solo-window path for a session — the one form a browser can
 * resolve against its own origin (see the "TWO AUDIENCES" note in the launch
 * route). Extracted from POST /api/recipes/:id/launch (2026-09-25, roster
 * verbs [ticket]) so a room seat's `occupant.url` and the launch answer's
 * `path` are the same string by construction.
 *
 * A project's PRIMARY pane (`recipe:<id>`) carries no `&pane=` — its historical
 * form, which the window dedupe and existing bookmarks still match. Any other
 * pane is named explicitly. A per-launch model / effort override rides the
 * url (the window's attach sends it back), so a reconnect keeps it.
 */
export function soloPathFor(
  recipeId: string,
  paneid: string | null,
  model: string | null = null,
  effort: string | null = null,
): string {
  const pane = paneid && paneid !== `recipe:${recipeId}` ? paneid : null;
  return (
    `/solo.html?recipe=${encodeURIComponent(recipeId)}` +
    (pane ? `&pane=${encodeURIComponent(pane)}` : '') +
    (model ? `&model=${encodeURIComponent(model)}` : '') +
    (effort ? `&effort=${encodeURIComponent(effort)}` : '')
  );
}
