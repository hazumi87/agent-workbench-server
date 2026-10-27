/**
 * SESSION-ID ADOPTION — re-point a live pane at the transcript it is actually in.
 *
 * THE BUG THIS FIXES. The engine banks a session id at launch or restore. An
 * in-pane `/resume` switches the running claude to a DIFFERENT transcript
 * without telling anyone, so the row keeps pointing at the abandoned one.
 * Owner's case, live for a day: a pane reading "/config" — the five-line session
 * he opened, typed one slash command into, and resumed away from — while the
 * window actually held a 74 MB conversation titled "HOMEHUB Latency (Fable)".
 *
 * WHY THE OBVIOUS ROUTES DO NOT WORK, all checked:
 *   - PROCESS ARGV lies too: it still reads `--session-id bc4dfdfd…` because
 *     /resume swapped transcripts inside the SAME process.
 *   - `locateCurrentSessionId` is LINEAGE-based — it follows transcripts that
 *     structurally reference the banked id. An in-pane /resume is a JUMP to an
 *     unrelated conversation and leaves no back-link (verified: the 74 MB file
 *     contains the banked id zero times).
 *   - The claude HOOKS would be authoritative, but the server has no hook
 *     installed and it would need a relaunch to bind a paneid.
 *   - No open fd on the transcript; claude appends and closes.
 *
 * THE RULE. A live pane whose banked transcript has gone COLD adopts the
 * hottest transcript in its project dir that no OTHER live pane is banked on —
 * and only when exactly one such candidate exists.
 *
 * Claim-exclusion is what makes it safe with several sessions per project. An
 * earlier draft gated on "only when one live pane owns the project", which
 * would have refused in exactly the case that needed it: HomeHub had two live
 * panes, one healthy and one stale. Excluding per TRANSCRIPT rather than
 * counting panes lets each pane claim a distinct file.
 *
 * It never guesses. Two plausible candidates, or none hot, means do nothing and
 * leave the visibly-wrong title — a wrong title is cosmetic, but adopting the
 * wrong transcript would point a RESTORE at someone else's conversation.
 */
import * as titles from './session-titles.ts';
import * as activity from './activity.ts';
import type * as claudeCode from './vendors/claude-code.ts';

/** Banked transcript quiet at least this long before it is even considered. */
const COLD_MS = Number(process.env.HARBOR_WB_ADOPT_COLD_MS ?? 15 * 60_000);
/** A candidate must have been written this recently to be "the live one". */
const HOT_MS = Number(process.env.HARBOR_WB_ADOPT_HOT_MS ?? 30 * 60_000);
/**
 * How much NEWER the candidate must be than the banked file.
 *
 * Age alone is not evidence. A session you have not typed in for twenty minutes
 * is IDLE, not abandoned, and treating it as stale made a perfectly healthy
 * pane go hunting — in the first test run two panes both qualified and both
 * tried to adopt the SAME transcript. The real signal is relative: something
 * else in this project is being written substantially more recently than the
 * file we think this pane is in.
 */
const LEAD_MS = Number(process.env.HARBOR_WB_ADOPT_LEAD_MS ?? 15 * 60_000);
/**
 * POSITIVE EVIDENCE, not just a hotter file (2026-09-18). The pane must have
 * been EMITTING OUTPUT when the candidate transcript was last written — its
 * last content byte and the file's mtime within this window of each other.
 * Claude streams a response to the pty and appends it to the transcript at
 * the same moment, so a pane that is in that file coincides with it; a pane
 * that sat silent for two hours while the file kept growing was never in it.
 *
 * The case that forced this: a transcript being written by a claude OUTSIDE
 * the manager — Owner's terminal session, in the same project dir as a parked
 * pane. It is the hottest file in the folder, no pane claims it, and it never
 * goes cold, so the old rule handed it to the parked pane every sweep and a
 * later Resume of that transcript then "grabbed the active one". Age alone
 * cannot tell a pane that moved from a folder that has other writers.
 *
 * The proper binding is the claude hook carrying `HARBOR_WB_PANEID` (R11 put
 * it in every pane's env); until that lands this is the evidence we have.
 */
const ACTIVE_MS = Number(process.env.HARBOR_WB_ADOPT_ACTIVE_MS ?? 90_000);

export interface AdoptCandidate {
  paneid: string;
  from: string | null;
  to: string;
  title: string | null;
}

interface PaneLike {
  paneid: string;
  recipe_id: string | null;
  session_id: string | null;
  state: string;
  vendor: string;
}

/**
 * Decide, without doing any I/O — it reads only what session-titles already
 * fetched. Returns the adoptions to make; the caller applies them, so this
 * stays testable and has no opinion about the table.
 */
export function planAdoptions(
  rows: PaneLike[],
  now = Date.now(),
  /* The listing lookup is INJECTED rather than imported as a singleton. ES
     module exports are read-only, so a test cannot stub the import — and
     needing to stub it was the signal that this function should not be reaching
     for a module-level cache in the first place. Defaults to the real one. */
  lookup: (recipeId: string) => claudeCode.SessionListing[] = titles.rows,
  /* When the pane last emitted content — injected for the same reason as the
     listing. Defaults to the activity machine's own record. */
  lastOutput: (paneid: string) => number | undefined = activity.lastOutputAt,
): AdoptCandidate[] {
  const out: AdoptCandidate[] = [];
  const live = rows.filter((r) => r.state === 'live' && r.recipe_id && r.vendor === 'claude-code');

  /* Every transcript some OTHER live pane is already sitting in. Claimed files
     are off the table however hot they are — a hot transcript with an owner is
     evidence of a HEALTHY pane, not of a candidate. */
  const byRecipe = new Map<string, PaneLike[]>();
  for (const r of live) {
    const list = byRecipe.get(r.recipe_id!) ?? [];
    list.push(r);
    byRecipe.set(r.recipe_id!, list);
  }
  /* A DEHYDRATED pane's transcript is claimed too (2026-09-18). It is the
     table's word for "this conversation comes back on its own pane", so
     handing that file to a second, live pane gives one transcript two panes —
     and a Resume of it then has two answers. Killed rows are history and a
     live pane may legitimately /resume into one of those. */
  const claimedByRecipe = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (r.recipe_id && r.session_id && (r.state === 'live' || r.state === 'dehydrated')) {
      const m = claimedByRecipe.get(r.recipe_id) ?? new Map<string, string>();
      m.set(r.session_id, r.paneid);
      claimedByRecipe.set(r.recipe_id, m);
    }
  }

  for (const [recipeId, panes] of byRecipe) {
    const listings = lookup(recipeId);
    if (!listings.length) {
      continue; // nothing fetched yet — next poll
    }
    const mtimeOf = new Map(listings.map((l) => [l.sessionId, l.mtimeMs]));
    /* Two panes must never be handed the SAME transcript. Collect first, then
       award only the uncontested ones — see the filter after this loop. */
    const wanted = new Map<string, AdoptCandidate[]>();

    for (const pane of panes) {
      const banked = pane.session_id;
      /* A banked id that is not a transcript uuid at all (a named-resume pane
         banks null; a broker id is `bk:…`) is not a lineage we can reason
         about — leave those entirely alone. */
      if (banked && !/^[0-9a-f-]{36}$/i.test(banked)) {
        continue;
      }
      const bankedMtime = banked ? mtimeOf.get(banked) : undefined;
      if (bankedMtime !== undefined && now - bankedMtime <= COLD_MS) {
        continue; // recently written — the pane is in the file we think it is
      }

      const claimedBy = claimedByRecipe.get(recipeId) ?? new Map<string, string>();
      const claimed = (sid: string) => {
        const owner = claimedBy.get(sid);
        return owner !== undefined && owner !== pane.paneid;
      };
      /* The pane's own last content byte. No record at all (adopted at boot
         and silent since) is no evidence, and no evidence means no move. */
      const spoke = lastOutput(pane.paneid);
      const candidates = listings.filter(
        (l) =>
          l.sessionId !== banked &&
          !claimed(l.sessionId) &&
          now - l.mtimeMs <= HOT_MS &&
          /* Substantially newer than ours. A banked file we cannot see at all
             has no age to compare, so it fails open — an absent transcript is
             the strongest possible evidence the pane moved. */
          (bankedMtime === undefined || l.mtimeMs - bankedMtime > LEAD_MS) &&
          /* ...and this pane was TALKING when that file was last written. */
          spoke !== undefined &&
          Math.abs(l.mtimeMs - spoke) <= ACTIVE_MS,
      );
      if (candidates.length !== 1) {
        continue; // ambiguous, or nothing convincingly newer — never guess
      }
      const pick = candidates[0];
      const list = wanted.get(pick.sessionId) ?? [];
      list.push({
        paneid: pane.paneid,
        from: banked,
        to: pick.sessionId,
        title: pick.title || pick.lastPrompt || pick.firstCommand || null,
      });
      wanted.set(pick.sessionId, list);
    }

    /* CONTESTED TRANSCRIPTS GO TO NOBODY. If two panes both concluded they are
       in the same file, at most one can be right and nothing here can say
       which — so neither moves. Awarding it to whichever was iterated first
       would be a coin flip pointed at someone's restore. */
    for (const [, claimants] of wanted) {
      if (claimants.length === 1) {
        out.push(claimants[0]);
      }
    }
  }
  return out;
}
