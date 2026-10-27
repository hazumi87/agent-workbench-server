/**
 * IS A FRESHLY LAUNCHED PANE PAST STARTUP? (the seat reload / "re-add from defaults" drive, ticket)
 *
 * The startup gate is CLAUDE CODE's REPL machine (it reads Claude's footer and prompts). A Codex or Gemini
 * pane is never armed in it, so `info(paneid)` is null forever and the old test (`gate armed AND not blocked`)
 * made EVERY non-Claude reload time out after 60 s, which skipped the whole welcome step: the lead was never
 * asked to welcome the returning seat and held lines were never re-queued (Builder, 4 of 4 reloads on
 * 2026-10-09, Owner [ref]).
 *
 * Non-Claude panes use the evidence they DO have: the pty is live, the activity machine says idle (it starts
 * idle and goes streaming while Codex paints), and the screen has been quiet for SETTLE_MS. A human-only prompt
 * (login, trust) is answered separately by `needsYou`, which still runs first. Pure.
 */
export const SETTLE_MS = 2000;

export interface ReadyFacts {
  vendor: string | null | undefined;
  /** startupGate.info(paneid) !== null */
  gateArmed: boolean;
  /** startupGate.isBlocked(paneid) */
  gateBlocked: boolean;
  live: boolean;
  /** activity.get(paneid) */
  state: string | null | undefined;
  /** activity.lastOutputAt(paneid) */
  lastOutputAt: number | undefined;
  /** activity.isDialogUp(paneid): an in-turn dialog (permission / question) is on screen */
  dialogUp?: boolean;
  now: number;
}

export function startupReady(f: ReadyFacts): boolean {
  if (!f.vendor || f.vendor === 'claude-code') {
    return f.gateArmed && !f.gateBlocked;
  }
  return f.live && !f.dialogUp && f.state === 'idle' && f.lastOutputAt !== undefined && f.now - f.lastOutputAt >= SETTLE_MS;
}

/** HEURISTIC LIMITS, stated so nobody trusts this more than it deserves: a quiet screen is not proof of a
 *  composer. A login / trust / approval modal is quiet too. Two things stand between that and a false
 *  "ready": the drive checks `needsYou` (startup prompts a human must answer, and the prompt-block probe)
 *  BEFORE this test on every poll, and `dialogUp` / state 'waiting' veto it here. What is NOT covered is a modal
 *  neither of those recognises; the cost is a welcome typed over it, which the typer's own guards still hold. */

/** After a drive that did NOT get the pane ready, should the lines drained from the old pane go onto the NEW
 *  one? Yes when the pane is alive but not ready (timeout, a prompt waiting on a human): the typer holds them
 *  until it can type. No when it never spawned or already exited: there is no pane to hold them. */
export function requeueAfterFailedDrive(reason: string): boolean {
  return reason === 'timeout' || reason === 'needs-you';
}
