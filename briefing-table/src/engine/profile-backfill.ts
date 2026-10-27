/**
 * ONE-OFF profile backfill for the agents already seated in open rooms
 * (Owner 2026-10-03: "use the model and effort stored in the session log to
 * populate the current set of room agents. That can work as a one-off process").
 *
 * The profile columns (4b8dee6) are NULL on every session minted before they
 * existed, and a NULL row snapshots the RECIPE's current default at its first
 * relaunch — which would move an agent that had been running something else.
 * This reads what each such session LAST ANSWERED WITH from its transcript (the
 * same read the seat shows: `listSessions` -> `model` / `perTurnEffort`) and
 * stores it, so the first relaunch keeps what the agent is actually running.
 *
 * VALUES. Model: the family alias (opus / sonnet / haiku / fable), exactly the
 * short name the seats display and the model pickers offer; a model id with no
 * known family is stored as is when `isModelName` accepts it (claude --model
 * takes both). Effort: stored only when it is in the --effort vocabulary, else
 * '' (claude's own default) — a perTurnEffort we do not recognize must never
 * become a flag claude ignores with a warning.
 *
 * NEVER GUESS: no transcript, unreachable host, or no model in it -> the row is
 * left NULL (today's behavior) and ONE line says why. A row that gained a
 * profile meanwhile is never overwritten (`setIfUnset` is one conditional
 * UPDATE). Idempotent: a filled row is no longer a target, so a later boot
 * finds nothing and logs nothing. Pure over injected deps so a test can drive
 * it; the engine wires the real table and `listSessions`.
 */
import { isModelName, isRecipeEffort } from './effort.ts';

export interface BackfillTarget {
  paneid: string;
  recipe_id: string | null;
  session_id: string | null;
}

export interface BackfillDeps {
  targets: () => BackfillTarget[];
  /** The project's transcripts, or null when they cannot be read at all
   *  (unknown recipe, unreachable host), with the reason. */
  list: (recipeId: string) => Promise<{ rows: Array<{ sessionId: string; model: string | null; effort: string | null }> } | { error: string }>;
  setIfUnset: (paneid: string, p: { model: string; effort: string }) => boolean;
  log: (line: string) => void;
}

export function profileFromTranscript(r: { model: string | null; effort: string | null }): { model: string; effort: string } | null {
  if (!r.model) {
    return null;
  }
  const model = /(opus|sonnet|haiku|fable)/.exec(r.model)?.[1] ?? (isModelName(r.model) ? r.model : null);
  if (!model) {
    return null;
  }
  return { model, effort: isRecipeEffort(r.effort) ? r.effort : '' };
}

export async function backfillProfiles(deps: BackfillDeps): Promise<{ filled: number; skipped: number }> {
  const targets = deps.targets();
  let filled = 0;
  let skipped = 0;
  const byRecipe = new Map<string, Awaited<ReturnType<BackfillDeps['list']>>>();
  const skip = (t: BackfillTarget, why: string): void => {
    skipped++;
    deps.log(`profile backfill: skipped ${t.paneid}: ${why}`);
  };
  for (const t of targets) {
    try {
      if (!t.recipe_id || !t.session_id) {
        skip(t, 'no recipe or session id on the row');
        continue;
      }
      let got = byRecipe.get(t.recipe_id);
      if (!got) {
        got = await deps.list(t.recipe_id);
        byRecipe.set(t.recipe_id, got);
      }
      if ('error' in got) {
        skip(t, got.error);
        continue;
      }
      const row = got.rows.find((x) => x.sessionId === t.session_id);
      if (!row) {
        skip(t, 'transcript not found');
        continue;
      }
      const p = profileFromTranscript(row);
      if (!p) {
        skip(t, 'no model in the transcript');
        continue;
      }
      if (deps.setIfUnset(t.paneid, p)) {
        filled++;
        deps.log(`profile backfill: ${t.paneid} -> model ${p.model}, effort ${p.effort || '(default)'}`);
      } else {
        skip(t, 'profile was set meanwhile');
      }
    } catch (e) {
      skip(t, `error: ${(e as Error)?.message ?? e}`);
    }
  }
  if (targets.length) {
    deps.log(`profile backfill: ${filled} filled, ${skipped} skipped`);
  }
  return { filled, skipped };
}
