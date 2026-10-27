/* THE STARTER SEED (row 7; the design notes). ONE transaction builds a template: its recipes (create-or-conflict),
 * the main room, its workgroups, STARTABLE seats (a recipe, no pane) and the brief, and writes the marker row in the SAME transaction. All of
 * it commits or none of it, so there is no partial state to resume: a repeat, or a lost reply, finds the marker and answers `already` with
 * the same ids. Nothing is started. The marker is never removed by a delete or archive, so a retry or a newer version never recreates
 * what the person removed. The room lead is the first seat added (addSeat makes the first persistent seat the lead). */
import { join } from 'node:path';
import { table } from '../table/endpoint.ts';
import { STARTER_RECIPES, STARTER_TEMPLATES, type StarterRecipeKey } from './starter-templates.ts';

export type SeedCode = 'unknown_template' | 'invalid' | 'recipe_conflict';
export class SeedError extends Error {
  readonly code: SeedCode;
  constructor(code: SeedCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface SeedResult {
  status: 'created' | 'already';
  template: string;
  version: number;
  room_id: string;
  groups: Record<string, string>;
  seats: Record<string, string>;
}

const ACTOR = { actor: 'user' } as const;

/** Whole-template seed. `env` supplies HARBOR_WB_FILES_DIR (the person's folder; the starter recipes work in its agents/<role> folders). */
export function seedStarter(templateKey: unknown, version: unknown, env: Record<string, string | undefined> = process.env): SeedResult {
  const tpl = typeof templateKey === 'string' ? STARTER_TEMPLATES[templateKey] : undefined;
  if (!tpl) {
    throw new SeedError('unknown_template', `there is no starter template ${JSON.stringify(templateKey)}`);
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SeedError('invalid', 'version is a whole number of 1 or more');
  }
  const done = table.getStarterSeed(tpl.key);
  if (done) {
    return { status: 'already', template: tpl.key, version: done.version, room_id: done.room_id, groups: done.ids.groups, seats: done.ids.seats };
  }
  const files = env.HARBOR_WB_FILES_DIR?.trim();
  const out = table.roomBatch((tx): SeedResult => {
    /* a second window that lost the race sees the marker here, inside the transaction */
    const again = table.getStarterSeed(tpl.key);
    if (again) {
      return { status: 'already', template: tpl.key, version: again.version, room_id: again.room_id, groups: again.ids.groups, seats: again.ids.seats };
    }
    /* RECIPES: absent -> create and mark ours; ours -> reuse as is (the person may have edited it); anything else is the person's, and the
       whole seed refuses, writing nothing. Ownership is the marker row, never the name. */
    const keys = new Set<StarterRecipeKey>();
    for (const s of [...tpl.seats, ...tpl.groups.flatMap((g) => g.seats)]) {
      keys.add(s.recipe);
    }
    for (const key of keys) {
      const existing = table.getRecipe(key);
      if (existing && !table.starterRecipeOwned(key)) {
        throw new SeedError('recipe_conflict', `a recipe of yours already uses the id "${key}", which a starter template needs; rename or remove it and try again`);
      }
      if (!existing) {
        table.upsertRecipe({
          id: key,
          name: STARTER_RECIPES[key].name,
          target: 'local',
          projectDir: files ? join(files, 'agents', STARTER_RECIPES[key].role) : null,
          vendor: 'claude-code',
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
        } as never);
        table.markStarterRecipe(key);
      }
    }
    const seats: Record<string, string> = {};
    const groups: Record<string, string> = {};
    const main = tx.createRoom({ name: tpl.roomName }, ACTOR).result;
    tx.setRoomBrief(main.id, tpl.brief, ACTOR);
    for (const s of tpl.seats) {
      seats[s.handle] = tx.addSeat(main.id, { recipe_id: s.recipe, handle: s.handle }, ACTOR).result.id;
    }
    for (const g of tpl.groups) {
      const room = tx.createRoom({ name: g.name, parent_id: main.id, alias: g.alias }, ACTOR).result;
      groups[g.alias] = room.id;
      for (const s of g.seats) {
        seats[s.handle] = tx.addSeat(room.id, { recipe_id: s.recipe, handle: s.handle }, ACTOR).result.id;
      }
    }
    table.recordStarterSeed(tpl.key, version, main.id, { groups, seats });
    return { status: 'created', template: tpl.key, version, room_id: main.id, groups, seats };
  });
  return out.value;
}

