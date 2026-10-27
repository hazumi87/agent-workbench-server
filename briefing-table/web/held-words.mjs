/* The held REASON as words a person reads, at most two (the design system ruling, v4
 * sign-off): the engine's tokens (not-idle, no-claude, awaiting-idle …) never
 * reach the glass. One table for the room row and the solo held line, so the
 * two surfaces cannot drift. The bounded tools-startup hold explicitly names
 * what is awaited; human prompts continue to say "needs you". */
const WORDS = {
  draft: 'draft',
  busy: 'busy',
  'not-idle': 'busy',
  startup: 'startup question',
  'waiting-for-tools': 'waiting for tools',
  'needs-you': 'needs you',
  'no-claude': 'claude not running',
  restarting: 'restarting',
  settling: 'settling',
  'awaiting-idle': 'previous line',
  'one-queued': 'one queued',
  'not-live': 'not live',
  pending: 'queued',
};

/** @param {{reason: string, detail?: string}} h  occupant.held / pane.held */
export function heldWord(h) {
  if (h?.reason === 'no-claude' && h.detail === 'not-interactive') {
    return 'claude not interactive';
  }
  /* [ticket] the screen needs the human: say which prompt, "needs you (login)" */
  if (h?.reason === 'needs-you' && h.blocked) {
    return `needs you (${h.blocked})`;
  }
  return WORDS[h?.reason] ?? String(h?.reason ?? '').replace(/-/g, ' ');
}
