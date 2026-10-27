/**
 * WHEN A SEAT GETS A WORKTREE, and what happens to it when the seat goes
 * (Owner 2026-10-05, worktree convention, KB design-notes-id §12). The git
 * mechanics are engine/worktrees.ts; this file is the decision and the glue to
 * the table. Called by the room routes (src/server/rooms.ts).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { table } from '../table/endpoint.ts';
import type { Recipe, RoomSeat } from '../table/endpoint.ts';
import { normalizeSlug } from './agent-slug.ts';
import { loadTargets, isSelfHosted } from './launch.ts';
import {
  CODE_VENDORS,
  ensureFolderWorktree,
  ensureWorktree,
  projectNameOf,
  removeWorktree,
  worktreePath,
  type RemoveResult,
} from './worktrees.ts';

export interface SeatWorktree {
  path: string;
  branch: string;
  project: string;
  name: string;
}

const same = (a: string, b: string): boolean => resolve(a) === resolve(b);

/**
 * Seats that run as ANOTHER account (chat-ops, gem-ops) get one too
 * (lead 2026-10-05): the engine creates it group-shared, and the seat's launch
 * env carries git's safe.directory (launch.gitSafeEnv).
 *
 * Decide, and (when yes) create or reuse, the worktree for a seat that is being
 * started FRESH. Null = no worktree (the reason is logged unless it is simply
 * "this seat is not a candidate"). Never throws.
 */
export async function prepareSeatWorktree(
  recipe: Recipe,
  seat: Pick<RoomSeat, 'handle' | 'occupant_kind' | 'occupant'>,
  log: (m: string) => void,
  code?: { dir: string; family: string } | null,
): Promise<SeatWorktree | null> {
  if (code && recipe.worktree !== 'never' && CODE_VENDORS.includes(recipe.vendor)) {
    /* The room has a code folder: EVERY code seat (the lead too) works in its own worktree of it. */
    const t = loadTargets().find((x) => x.id === recipe.target);
    if (!t || !isSelfHosted(t) || t.sshClient) {
      return null;
    }
    const f = await ensureFolderWorktree({ codeDir: code.dir, name: `${code.family}/${seat.handle}` });
    if (!f.ok) {
      log(`worktree not created for @${seat.handle}: ${f.reason}`);
      return null;
    }
    log(`worktree for @${seat.handle}: ${f.path} (${f.branch})${f.created ? ' created' : ' reused'}`);
    return { path: f.path, branch: f.branch, project: f.project, name: f.name };
  }
  if (recipe.worktree === 'never' || !CODE_VENDORS.includes(recipe.vendor) || !recipe.projectDir) {
    return null; // not a candidate: operators, shells, design-only seats
  }
  const target = loadTargets().find((t) => t.id === recipe.target);
  if (!target || !isSelfHosted(target) || target.sshClient) {
    log(`worktree not created for @${seat.handle}: target ${recipe.target} is not on this engine's host`);
    return null;
  }
  const project = projectNameOf(recipe.projectDir);
  if (!project) {
    log(`worktree not created for @${seat.handle}: no usable project name`);
    return null;
  }
  /* A seat that already has its worktree (a restart after it ended) REUSES it
     whatever else is running; otherwise only the SECOND instance of a project
     gets one: another live or dehydrated session of the same projectDir. */
  const own = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const existing = existsSync(worktreePath(project, seat.handle));
  if (!existing) {
    const others = table.list().some((row) => {
      if ((row.state !== 'live' && row.state !== 'dehydrated') || row.paneid === own || !row.recipe_id) {
        return false;
      }
      const r = table.getRecipe(row.recipe_id);
      return !!r?.projectDir && same(r.projectDir, recipe.projectDir as string);
    });
    if (!others) {
      return null;
    }
  }
  const r = await ensureWorktree({ projectDir: recipe.projectDir, name: seat.handle });
  if (!r.ok) {
    log(`worktree not created for @${seat.handle}: ${r.reason}`);
    return null;
  }
  log(`worktree for @${seat.handle}: ${r.path} (${r.branch})${r.created ? ' created' : ' reused'}`);
  return { path: r.path, branch: r.branch, project: r.project, name: r.name };
}

/** What the seat row shows: the worktree its occupant runs in, if any. */
export function worktreeOfOccupant(paneid: string | null): { path: string; branch: string } | null {
  const w = paneid ? table.getSessionWorktree(paneid) : undefined;
  return w ? { path: worktreePath(w.project, w.name), branch: w.branch } : null;
}

/**
 * A seat was removed (or its workgroup archived): try to remove ITS worktree.
 * Returns one sentence for the room, or null when the seat had none.
 */
export async function releaseSeatWorktree(
  seat: Pick<RoomSeat, 'handle' | 'recipe_id'>,
  log: (m: string) => void,
): Promise<string | null> {
  const recipe = seat.recipe_id ? table.getRecipe(seat.recipe_id) : undefined;
  const project = projectNameOf(recipe?.projectDir);
  if (!project) {
    return null;
  }
  const r: RemoveResult = await removeWorktree({ project, name: seat.handle });
  if (r.status === 'absent') {
    return null;
  }
  if (r.status === 'removed') {
    table.dropSessionWorktrees(project, seat.handle);
    log(`worktree of @${seat.handle} removed: ${r.path}`);
    return `@${seat.handle}'s worktree ${r.branch} was removed (clean, fully pushed)`;
  }
  log(`worktree of @${seat.handle} ${r.reason}: ${r.path}`);
  return `@${seat.handle}'s worktree ${r.path} (${r.branch}) ${r.reason}`;
}

/** The room family's slug for worktree names: the main room's name plus a piece of its id, so two rooms on one folder never share a worktree. */
export function familySlug(mainRoomId: string): string {
  const name = normalizeSlug(table.getRoom(mainRoomId)?.name ?? '') ?? 'room';
  return `${name.slice(0, 40).replace(/-+$/, '') || 'room'}-${mainRoomId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
}

/** The person's Clean up of a seat's worktree: removed only when clean (its branch and commits stay in the repo); otherwise kept, with the reason. */
export async function cleanSeatWorktree(
  seat: Pick<RoomSeat, 'occupant_kind' | 'occupant'>,
  live: boolean,
): Promise<{ status: 'removed' | 'kept' | 'none'; path?: string; branch?: string; reason?: string }> {
  const w = seat.occupant_kind === 'pane' && seat.occupant ? table.getSessionWorktree(seat.occupant) : undefined;
  if (!w) {
    return { status: 'none' };
  }
  const path = worktreePath(w.project, w.name);
  if (live) {
    return { status: 'kept', path, branch: w.branch, reason: 'kept: its agent is running; end it first' };
  }
  const r = await removeWorktree({ project: w.project, name: w.name, explicit: true });
  if (r.status === 'absent') {
    return { status: 'none' };
  }
  if (r.status === 'removed') {
    table.dropSessionWorktrees(w.project, w.name);
    return { status: 'removed', path: r.path, branch: r.branch };
  }
  return { status: 'kept', path: r.path, branch: r.branch, reason: r.reason };
}
