/**
 * WHICH PANE A FABRIC ADDRESS MEANS (the bare-slug rule, Owner's night order, coordination [ref] item 2; the
 * ambiguity reported in application [ref]).
 *
 * A MINTED work slug (check-in, contract 1.3) names exactly one pane and is asked first. A BARE slug is the recipe's
 * `agent` slug, which two live panes of one recipe share (a lead and a second pane, seats of one recipe), and used to
 * go to whichever was updated last, silently. Now:
 *   1. one live pane holds the bare slug                    -> it;
 *   2. several, and exactly one is the recipe's PRIMARY pane -> the primary (`recipe:<id>`, no `#`);
 *   3. several, no single primary                           -> AMBIGUOUS: refused, naming each pane's minted
 *      slug (its paneid when it has not checked in) so the sender can address one.
 * Pure: no table, no fabric, no clock. src/server/index.ts feeds it the rows.
 */
export interface SlugRow {
  paneid: string;
  recipe_id: string | null;
  agent: string | null;
  state: string;
}
export type SlugRoute = { pane: string } | { ambiguous: string[] } | null;

const isPrimary = (r: SlugRow): boolean => !!r.recipe_id && r.paneid === `recipe:${r.recipe_id}`;

export function routeSlug(slug: string, o: { exact: string | null; rows: SlugRow[]; mintedOf(paneid: string): string | null }): SlugRoute {
  if (o.exact) {
    return { pane: o.exact };
  }
  const live = o.rows.filter((r) => r.agent === slug && r.state === 'live');
  if (live.length === 0) {
    return null;
  }
  if (live.length === 1) {
    return { pane: live[0].paneid };
  }
  const primary = live.filter(isPrimary);
  if (primary.length === 1) {
    return { pane: primary[0].paneid };
  }
  return { ambiguous: live.map((r) => o.mintedOf(r.paneid) ?? r.paneid) };
}
