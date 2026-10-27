/* THE ROOM / TEAM ACTIVITY ROLLUP (row 8b, the design system chip): one answer per room or team, so no surface guesses. Pure: the caller hands in one signal per LIVE seat.
 *   needs-you   a seat cannot go on until the person acts: a prompt only a human answers (blocked: login | permission | question), a Notification-style `waiting` (also
 *               after it was seen: asks decay in loudness, never in existence), a first-run CLI prompt that is named or `unmatched`, or held lines waiting on the person's
 *               Deliver (reason `draft`).
 *   working     a seat is streaming.   background   a seat has background work.   idle   a live seat doing none of that (a bare `shell` and every "cannot tell yet"
 *               reading are idle, never needs-you).
 * The room's state is the LOUDEST seat (needs-you > working > background > idle), the same ranking as the room tab; `none` when no seat is live. Counts ride along so a
 * label can say "2 of 11 seats busy". A pending Concierge sign-off (concierge-signoff.ts) with a target in the room counts as needs-you too (`signoffs`); an unanswered `@user APPROVAL:` line is still not derived here. */
export type SeatSignal = 'needs-you' | 'working' | 'background' | 'idle';
export type RollupState = SeatSignal | 'none';
export interface Rollup {
  state: RollupState;
  live: number;
  needs_you: number;
  /** pending Concierge sign-offs with a target in this room: a card that cannot go on without the person (already counted in needs_you) */
  signoffs: number;
  working: number;
  background: number;
  idle: number;
}

export function rollupOf(signals: ReadonlyArray<SeatSignal | null>, pendingSignoffs = 0): Rollup {
  const r: Rollup = { state: 'none', live: 0, needs_you: 0, signoffs: pendingSignoffs, working: 0, background: 0, idle: 0 };
  r.needs_you += pendingSignoffs;
  for (const s of signals) {
    if (!s) continue;
    r.live += 1;
    if (s === 'needs-you') r.needs_you += 1;
    else if (s === 'working') r.working += 1;
    else if (s === 'background') r.background += 1;
    else r.idle += 1;
  }
  r.state = r.needs_you > 0 ? 'needs-you' : r.live === 0 ? 'none' : r.working > 0 ? 'working' : r.background > 0 ? 'background' : 'idle';
  return r;
}

const NAMED_PROMPTS = ['theme', 'login', 'apiKey', 'security', 'trust', 'mcp'];

/** One live seat's signal from what the engine already knows about its pane. */
export function seatSignalOf(p: {
  activity: string | null;
  blocked: boolean;
  heldReason: string | null;
  cliPrompt: string | null | undefined;
  cliPromptReason: string | null | undefined;
}): SeatSignal {
  if (p.blocked || p.heldReason === 'draft' || p.activity === 'waiting' || p.activity === 'waiting-seen') return 'needs-you';
  if (p.cliPrompt && (NAMED_PROMPTS.includes(p.cliPrompt) || (p.cliPrompt === 'unknown' && p.cliPromptReason === 'unmatched'))) return 'needs-you';
  if (p.activity === 'streaming') return 'working';
  if (p.activity === 'background') return 'background';
  return 'idle';
}
