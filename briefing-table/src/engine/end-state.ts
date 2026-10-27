/**
 * How a finished session is FILED — the rule that decides whether it can come
 * back on its own.
 *
 * Extracted as a pure function because it is load-bearing and was wrong: every
 * exit was stamped `killed`, including sessions the engine itself reaped for
 * idleness. `killed` is refused by the attach path's auto-resume, so on
 * 2026-08-24 a 12h timer that fired when a laptop lid closed turned five live
 * agent conversations into brand-new empty ones. The transcripts were never
 * gone; the ROW said "ended" when the truth was "taken away".
 *
 * The distinction to preserve:
 *   · `user`   — the ✕, the End button. A deliberate ending. Stays `killed` and
 *                must NEVER auto-resume; coming back from the dead would be its
 *                own bug.
 *   · `reaped` — we took it while nobody was looking. Not a decision anyone
 *                made, so if the vendor can resume, file it restorable.
 *
 * Vendor-gated for the same reason boot-reconcile is: a bare shell or an ssh
 * pane has no conversation to resume, so `dehydrated` would be a lie that shows
 * a Restore button which cannot work.
 *
 * ONE SOURCE OF TRUTH (contract §1.1, the hazard recorded for vendor #2). The
 * gate used to ask the claude module directly, which made "claude is the only
 * resumable vendor" a fact stated in code rather than derived from the vendor
 * registry — and the boot-reconcile SQL stated the SAME fact a third time. Both
 * now ask `isResumableVendor`, which reads the modules' own `resumable` flag.
 */
import { isResumableVendor } from './vendors/index.ts';

/*   · `cycle`  — the room's Disconnect (assemble-room F1): ended so a new
 *                binary can take over, and brought back into the SAME
 *                conversation when the room reopens. Filed like `reaped`. */
export type EndReason = 'user' | 'reaped' | 'cycle' | undefined;

export function endStateFor(reason: EndReason, vendor: string | null | undefined): 'killed' | 'dehydrated' {
  if (reason !== 'reaped' && reason !== 'cycle') {
    return 'killed';
  }
  return isResumableVendor(vendor) ? 'dehydrated' : 'killed';
}
