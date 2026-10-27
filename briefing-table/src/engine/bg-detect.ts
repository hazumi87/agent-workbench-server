/**
 * BACKGROUND-WORK DETECTION off the rendered Claude Code screen. PURE: rows in,
 * verdict out. Spec and the real lines quoted: the design notes.
 *
 * Three outcomes, never two:
 *   an object with a count > 0   detected
 *   an object with zero counts   not detected (the footer was seen and shows nothing)
 *   null                         cannot tell (no footer row on screen: a dialog,
 *                                a resize, a screen that is not Claude's)
 *
 * What Claude draws (cc 2.1.299, fixtures in test/fixtures/bg-screens/):
 *   footer pill        "  ⏵⏵ auto mode on · 1 shell"      (also "2 shells")
 *   turn summary       "✻ Cooked for 5s · done 7:44 PM · 1 shell still running"
 *   sub-agent status   "✻ Waiting for 1 background agent to finish"
 *   sub-agent tree     "  ◯ general-purpose  Run 75-second sleep   6s · ↓ 47.7k tokens"
 * NOT a signal: the "← 2 agents" tail of the footer, present at an idle prompt
 * (it is a constant of this account, not work) and "/tasks to see subagents",
 * which stays on the footer AFTER an agent finished.
 */

export interface BackgroundWork {
  shells: number;
  agents: number;
  /** Any other "<n> <kind> still running" Claude reports (monitor, task ...). */
  other: boolean;
  /** Short wording of what was matched; never screen text beyond the matched count. */
  evidence: string;
}

/** The mode/footer row: starts with a mode glyph, or is the "? for shortcuts" hint. */
const FOOTER = /^\s*(?:⏵|⏸|\? for shortcuts)/;
const SHELL_SEG = /^(\d+) shells?$/;
const SUMMARY = /^✻ .*?(\d+) ([a-z]+) still running\s*$/;
const WAITING = /^✻ Waiting for (\d+) background agents? to finish/;
const TREE = /^\s+◯ \S/;

function liveAbove(rows: readonly string[], i: number): boolean {
  for (let j = i + 1; j < rows.length; j++) {
    const r = rows[j].trim();
    if (r) {
      return r.startsWith('❯') || r.startsWith('───');
    }
  }
  return false;
}

export function backgroundWork(rows: readonly string[]): BackgroundWork | null {
  let footerAt = -1;
  let lastStar = -1;
  for (let i = 0; i < rows.length; i++) {
    if (FOOTER.test(rows[i])) {
      footerAt = i;
    }
    if (rows[i].startsWith('✻ ')) {
      lastStar = i;
    }
  }
  const ev: string[] = [];
  let shells = 0;
  let agents = 0;
  let other = false;
  if (footerAt >= 0) {
    for (const seg of rows[footerAt].split('·')) {
      const m = SHELL_SEG.exec(seg.trim());
      if (m) {
        shells = Math.max(shells, Number(m[1]));
        ev.push(`footer: ${m[0]}`);
      }
    }
  }
  /* The status line is only LIVE while it is the last thing above the input box.
   * A finished agent leaves "✻ Waiting for 1 background agent" on screen with its
   * result lines below it (agent2-after-1). */
  if (lastStar >= 0 && !liveAbove(rows, lastStar)) {
    lastStar = -1;
  }
  if (lastStar >= 0) {
    const s = SUMMARY.exec(rows[lastStar]);
    if (s && Number(s[1]) > 0) {
      if (/^shells?$/.test(s[2])) {
        shells = Math.max(shells, Number(s[1]));
      } else {
        other = true;
      }
      ev.push(`summary: ${s[1]} ${s[2]} still running`);
    }
    const w = WAITING.exec(rows[lastStar]);
    if (w && Number(w[1]) > 0) {
      agents = Number(w[1]);
      ev.push(`status: waiting for ${w[1]} background agent${w[1] === '1' ? '' : 's'}`);
    }
  }
  if (agents === 0 && footerAt >= 0) {
    const tree = rows.slice(footerAt + 1).filter((r) => TREE.test(r)).length;
    if (tree > 0) {
      agents = tree;
      ev.push(`tree: ${tree} agent row${tree === 1 ? '' : 's'}`);
    }
  }
  if (shells > 0 || agents > 0 || other) {
    return { shells, agents, other, evidence: ev.join('; ') };
  }
  return footerAt >= 0 ? { shells: 0, agents: 0, other: false, evidence: 'footer: none' } : null;
}

/** True only for a DETECTED verdict (counts above zero). null / none = false. */
export function isBusy(b: BackgroundWork | null | undefined): boolean {
  return !!b && (b.shells > 0 || b.agents > 0 || b.other);
}
