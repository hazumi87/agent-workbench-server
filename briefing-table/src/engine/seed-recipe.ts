/* THE FIRST-RUN SEED RECIPE [lead order 16238]: a local-only person must be able to make a room and seat a pane with no setup. At the local
 * engine's very first start it creates ONE recipe, "PowerShell" on Windows (Run: Shell, powershell, runs on this machine) or "Shell" with the
 * login shell elsewhere. A marker file in the engine data folder is written after it, so a recipe the person deletes (or edits and later
 * deletes) is NEVER recreated. Local mode only. Pure, with injected storage, so it is testable without an engine.
 *
 * ORDER MATTERS: the recipe is written first and the marker second. A crash between them leaves a recipe and no marker, and the next start
 * finds a recipe, writes the marker and adds nothing; the other order could lose the seed for good. */

export const SEED_RECIPE_ID = 'seed-shell';
export const SEED_MARKER_NAME = 'seed-recipe.done';

export function seedRecipeName(platform: string): string {
  return platform === 'win32' ? 'PowerShell' : 'Shell';
}

export interface SeedRecipe {
  id: string;
  name: string;
  target: string;
  projectDir: null;
  vendor: 'cli-manager';
  agent: null;
  model: null;
  resume: number;
  resumeName: null;
  initCmd: null;
  closeOnCleanExit: number;
  statusPath: null;
  color: null;
  fg: null;
  bg: null;
  watermark: null;
  fontSize: null;
  logo: null;
}

/** The recipe itself. `target: 'local'` is the only target a local engine has (This machine); which shell it runs is the target's, see loadTargets. */
export function seedRecipe(platform: string): SeedRecipe {
  return {
    id: SEED_RECIPE_ID,
    name: seedRecipeName(platform),
    target: 'local',
    projectDir: null,
    vendor: 'cli-manager',
    agent: null,
    model: null,
    resume: 0,
    resumeName: null,
    initCmd: null,
    closeOnCleanExit: 0,
    statusPath: null,
    color: null,
    fg: null,
    bg: null,
    watermark: null,
    fontSize: null,
    logo: null,
  };
}

export interface SeedDeps {
  platform: string;
  markerExists: () => boolean;
  writeMarker: () => void;
  recipeCount: () => number;
  upsert: (r: SeedRecipe) => void;
}

export type SeedOutcome = 'seeded' | 'marker' | 'has-recipes';

export function seedFirstRecipe(d: SeedDeps): SeedOutcome {
  if (d.markerExists()) {
    return 'marker'; // seeded (or decided against) once already: never again, whatever the person has done since
  }
  if (d.recipeCount() > 0) {
    d.writeMarker(); // the person (or an earlier build) already has recipes: add nothing, and never come back to this
    return 'has-recipes';
  }
  d.upsert(seedRecipe(d.platform));
  d.writeMarker();
  return 'seeded';
}
