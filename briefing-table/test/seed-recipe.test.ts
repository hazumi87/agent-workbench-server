/** THE FIRST-RUN SEED RECIPE, pure rules (src/engine/seed-recipe.ts): one default recipe at the first start, never again. */
import { SEED_RECIPE_ID, seedFirstRecipe, seedRecipe, seedRecipeName, type SeedRecipe } from '../src/engine/seed-recipe.ts';

let passed = 0;
let failed = 0;
function ok(c: boolean, m: string): void {
  if (c) {
    passed++;
    console.log(`  ok ${m}`);
  } else {
    failed++;
    console.log(`  FAIL ${m}`);
  }
}
function world(opts: { marker?: boolean; recipes?: number; platform?: string; failUpsert?: boolean } = {}) {
  const w = { marker: opts.marker ?? false, recipes: [] as SeedRecipe[], existing: opts.recipes ?? 0, markerWrites: 0, order: [] as string[] };
  const deps = {
    platform: opts.platform ?? 'win32',
    markerExists: () => w.marker,
    writeMarker: () => {
      w.marker = true;
      w.markerWrites++;
      w.order.push('marker');
    },
    recipeCount: () => w.existing + w.recipes.length,
    upsert: (r: SeedRecipe) => {
      if (opts.failUpsert) throw new Error('disk full');
      w.recipes.push(r);
      w.order.push('recipe');
    },
  };
  return { w, deps };
}

ok(seedRecipeName('win32') === 'PowerShell' && seedRecipeName('linux') === 'Shell' && seedRecipeName('darwin') === 'Shell', 'the seed is "PowerShell" on Windows and "Shell" elsewhere');
{
  const r = seedRecipe('win32');
  ok(r.id === SEED_RECIPE_ID && r.target === 'local' && r.vendor === 'cli-manager' && r.agent === null && r.projectDir === null, 'it is a plain shell recipe (not claude) on the local target (This machine), with a fixed id and no slug');
  ok(r.initCmd === null && r.resume === 0, '...that runs no command at launch');
}
{
  const { w, deps } = world();
  ok(seedFirstRecipe(deps) === 'seeded' && w.recipes.length === 1 && w.marker, 'first start with no recipes: one recipe and the marker');
  ok(w.order.join() === 'recipe,marker', 'the recipe is written BEFORE the marker (a crash between them cannot lose the seed)');
  ok(seedFirstRecipe(deps) === 'marker' && w.recipes.length === 1, 'the next start does nothing');
}
{
  const { w, deps } = world();
  seedFirstRecipe(deps);
  w.recipes.length = 0; // the person deletes it
  ok(seedFirstRecipe(deps) === 'marker' && w.recipes.length === 0, 'a deleted seed is NEVER recreated');
}
{
  const { w, deps } = world({ recipes: 2 });
  ok(seedFirstRecipe(deps) === 'has-recipes' && w.recipes.length === 0 && w.marker, 'a first start that already has recipes adds none, and marks itself done');
}
{
  const { w, deps } = world({ failUpsert: true });
  let threw = false;
  try {
    seedFirstRecipe(deps);
  } catch {
    threw = true;
  }
  ok(threw && !w.marker, 'if writing the recipe fails there is no marker, so the next start tries again');
}
{
  const { w, deps } = world({ platform: 'linux' });
  seedFirstRecipe(deps);
  ok(w.recipes[0].name === 'Shell', 'on Linux the name is "Shell"');
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
