/**
 * /clear DETECTION — which live panes had their conversation cleared in the CLI.
 * Owner 2026-10-03.
 *
 * WHAT HAPPENS (verified in a real transcript, CC 2.1.x): `/clear` in claude
 * starts a NEW conversation — a new transcript file with a new uuid — in the
 * SAME process. The new file opens with the `<command-name>/clear</command-name>`
 * record and carries no back-link to the old one. The row keeps banking the
 * OLD uuid, so a disconnect then reconnect (`--resume <old>`) brings back the
 * conversation from BEFORE the /clear.
 *
 * WHAT THE EXISTING SWEEP DOES ABOUT IT (session-adopt.ts): only a LATE,
 * heuristic repair. It moves the banked id only after the old file has been
 * cold for 15 minutes AND the new one leads it by 15 minutes, and it never
 * guesses between candidates. Until then — and whenever a second writer in the
 * same project dir makes it ambiguous — a reconnect resumes the old conversation.
 * So the warning is needed even though adoption exists; adoption clears it
 * (store.adoptSessionId) when it does move the id.
 *
 * WHY THIS SIGNAL, from the three on the table:
 *  - (a) the SessionStart hook with source "clear": the installed hooks do not
 *    post SessionStart to /api/claude-hook (it only runs relay + project-brief;
 *    ~/.claude/settings.json is shared config), and a hook payload names a
 *    session id, never a pane, so an unmatched new id could not be tied to one
 *    pane anyway. Needs a settings change; see the report.
 *  - (c) "/clear\r" in the input stream: inference from keystrokes (the slash
 *    menu, Tab completion, history recall, paste all defeat it) and it means
 *    holding typed content. Rejected.
 *  - (b) THIS ONE: a transcript that STRUCTURALLY begins with /clear
 *    (`firstCommand === '/clear'`, already parsed for every listing), that no
 *    pane claims, newer than the pane's banked file, whose last write coincides
 *    with the pane's own last output (the same positive evidence adoption uses,
 *    because a /clear and the turns after it repaint the pty and write the
 *    file together). Exactly one candidate, and no other pane wanting it — never
 *    a guess: a miss is no badge, not a wrong one.
 * Pure: reads only what session-titles already fetched.
 */
import * as titles from './session-titles.ts';
import * as activity from './activity.ts';
import type * as claudeCode from './vendors/claude-code.ts';

const ACTIVE_MS = Number(process.env.HARBOR_WB_ADOPT_ACTIVE_MS ?? 90_000);

export interface ClearedFinding {
  paneid: string;
  to: string;
}

interface PaneLike {
  paneid: string;
  recipe_id: string | null;
  session_id: string | null;
  state: string;
  vendor: string;
  cleared_at?: number | null;
  cleared_to?: string | null;
}

export function planCleared(
  rows: PaneLike[],
  lookup: (recipeId: string) => claudeCode.SessionListing[] = titles.rows,
  lastOutput: (paneid: string) => number | undefined = activity.lastOutputAt,
): ClearedFinding[] {
  const live = rows.filter((r) => r.state === 'live' && r.recipe_id && r.vendor === 'claude-code');
  const claimed = new Map<string, Set<string>>(); // recipe -> session ids some pane banks (live or dehydrated)
  for (const r of rows) {
    if (r.recipe_id && r.session_id && (r.state === 'live' || r.state === 'dehydrated')) {
      const set = claimed.get(r.recipe_id) ?? new Set<string>();
      set.add(r.session_id);
      claimed.set(r.recipe_id, set);
    }
  }
  const wanted = new Map<string, ClearedFinding[]>(); // recipe|uuid -> panes that concluded it
  for (const pane of live) {
    if (pane.cleared_at || !pane.session_id) {
      continue; // already flagged, or nothing banked to compare against
    }
    const listings = lookup(pane.recipe_id!);
    const bankedMtime = listings.find((l) => l.sessionId === pane.session_id)?.mtimeMs;
    if (bankedMtime === undefined) {
      continue; // cannot see the banked file: cannot say the new one is newer
    }
    const spoke = lastOutput(pane.paneid);
    if (spoke === undefined) {
      continue;
    }
    const cands = listings.filter(
      (l) =>
        l.firstCommand === '/clear' &&
        l.sessionId !== pane.session_id &&
        l.sessionId !== pane.cleared_to && // the one the person already dismissed
        !claimed.get(pane.recipe_id!)?.has(l.sessionId) &&
        l.mtimeMs >= bankedMtime &&
        Math.abs(l.mtimeMs - spoke) <= ACTIVE_MS,
    );
    if (cands.length !== 1) {
      continue;
    }
    const key = `${pane.recipe_id}|${cands[0].sessionId}`;
    const list = wanted.get(key) ?? [];
    list.push({ paneid: pane.paneid, to: cands[0].sessionId });
    wanted.set(key, list);
  }
  const out: ClearedFinding[] = [];
  for (const claimants of wanted.values()) {
    if (claimants.length === 1) {
      out.push(claimants[0]);
    }
  }
  return out;
}
