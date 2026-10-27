/* ============================================================================
 * GEMINI GATE — screen-based readiness/busy/dialog detection for gemini-cli
 * panes (ticket, B4: typed room delivery to Gemini seats).
 *
 * room-typer's guards were hardcoded to claude-code: guard 9 (does an
 * interactive claude own the tty, via /proc) and the startup gate (does the
 * screen show a REPL past its trust/dev-channels/old-session prompts, via
 * text matched on the pty stream). Gemini has neither /proc ownership nor a
 * hook signal (no Notification/Stop), so EVERYTHING for this vendor comes
 * from its own screen text — this module is the gemini-cli half of the split
 * room-typer.ts now dispatches on (claudeGuardFields / geminiGuardFields).
 *
 * WHY NO /proc CHECK IS NEEDED FOR THIS VENDOR (unlike guard 9): claude types
 * into `bash -il`, so the SAME-LOOKING bare shell prompt sits under both "no
 * claude yet" and "claude exited" — the screen alone cannot tell them apart,
 * hence /proc. Gemini's TUI paints an unmistakably different frame (a title
 * bar, a footer, a boxed composer) than a bare shell, so seeing that frame
 * already proves gemini owns the terminal; there is nothing a process check
 * would add. If bash reclaims the tty (gemini exited), the frame simply stops
 * being redrawn and the gate is never armed for a NEW gemini until the next
 * spawn calls arm() again — same "reset on every spawn" shape as claude's gate.
 *
 * REAL MARKERS, not guessed. Captured read-only (GET /api/sessions/:id/peek,
 * never attached, never typed into) from Owner's live gem-ops pane
 * (recipe:257b8543…, target homebase-gem-ops, YOLO mode) and cross-checked
 * against the strings actually compiled into the installed CLI
 * (`@google/gemini-cli@0.62.0`, `bundle/interactiveCli-*.js` — npm-packed to a
 * scratch dir for grep, nothing committed, nothing run):
 *
 *   composer  "Type your message or @path/to/file" (placeholder) and
 *             "? for shortcuts" (footer) — present on EVERY drawn frame,
 *             busy or idle alike, so PRESENCE alone cannot distinguish them
 *             (see `busy` below). Their first sighting proves the TUI is up
 *             past startup — sticky for the pane's life, same as claude's
 *             hook-disarms-forever startup gate.
 *   busy      "(esc to cancel, <N>s)" beside a braille spinner and a verb
 *             ("Thinking..."), drawn ONLY while generating; the very next
 *             redraw after a turn ends drops it (and separately blinks the
 *             OSC 0 window title to "◇  Ready (<project>)" — both observed
 *             landing in the same redraw in the captured samples). Only the
 *             text is matched; the title write is not needed once this is.
 *   dialog    tool/shell approval — "Do you want to proceed?", "Allow
 *             execution of" (interactiveCli-R4EMLFLM.js) — or the auth
 *             screen — "How would you like to authenticate for this
 *             project?", "Sign in with Google", "Waiting for
 *             authentication… (Press Esc or Ctrl+C to cancel)" (same file).
 *             Not captured live (Owner's pane is YOLO + already authenticated,
 *             and this module must never attach/type to provoke one) — these
 *             come from the shipped bundle's own compiled strings, so they
 *             are real product text, just not screen-verified end to end.
 *
 * SAME-CHUNK RULE (why `busy` beats `composer` as idle evidence, not just
 * "more recent"): gemini repaints its WHOLE status block — spinner/thinking
 * line (when busy) + rule + YOLO row + the boxed composer + footer — in one
 * burst per redraw (captured samples: each redraw opens with a run of
 * `ESC[2K ESC[1A` clearing every line it is about to redraw). So a busy
 * frame's "(esc to cancel" text and its "? for shortcuts" footer arrive in
 * the SAME pty chunk. Idle evidence therefore only counts when the composer
 * markers are seen WITHOUT the busy marker in that same chunk — never by
 * comparing stream positions of two markers that always land together in
 * exactly the situation that matters. Sticky per-chunk classification (busy
 * wins the chunk it appears in), then LATEST CHUNK WINS overall — the same
 * "latest evidence" shape startup-gate.ts uses (promptPos vs evidencePos),
 * simplified here because gemini has no veto/human/hook layering to track.
 *
 * `normalise`/the incomplete-escape carry are copied verbatim from
 * startup-gate.ts rather than imported — same reason that file gives for not
 * importing channels.ts's copy: this module must not pull in the claude-only
 * stack just to strip ANSI from a stream.
 * ========================================================================== */

import * as sessions from './sessions.ts';

const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const ESC_INCOMPLETE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;
function normalise(s: string): string {
  return s.replace(ESC_SEQ, ' ').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ');
}

/** Real strings, verbatim (see header). */
const BUSY_RE = /\(esc to cancel,\s*\d+s\)/;
const COMPOSER_RE = /Type your message or @path\/to\/file|\? for shortcuts/;
const DIALOG_RE = /Do you want to proceed\?|Allow execution of|How would you like to authenticate|Sign in with Google|Waiting for authentication/;
const AUTH_TEXT = /authenticate|Sign in with Google|Waiting for authentication/;

export type DialogKind = 'proceed' | 'auth';
export type GeminiState = 'not-ready' | 'dialog' | 'busy' | 'idle';

interface Gate {
  carry: string;
  pastStartup: boolean;
  /** Which of the three markers this pane's LATEST classified chunk showed —
   *  null before the first chunk since arm(). */
  last: 'dialog' | 'busy' | 'idle' | null;
  dialogKind: DialogKind | null;
}
const gates = new Map<string, Gate>();

let log: (line: string) => void = () => {};
export function setLog(fn: (line: string) => void): void {
  log = fn;
}

/** A gemini-cli pane was just spawned or adopted — reset its gate. Called
 *  from index.ts's spawn/adopt sites, mirroring startupGate.arm/adopt. */
export function arm(paneid: string): void {
  gates.set(paneid, { carry: '', pastStartup: false, last: null, dialogKind: null });
}

/** Pty output for a pane. A no-op unless arm() was called for it (the same
 *  "always call, no-op unless armed" idiom as startupGate.onPtyData). */
export function onPtyData(paneid: string, chunk: string): void {
  const g = gates.get(paneid);
  if (!g) {
    return;
  }
  let raw = g.carry + chunk;
  const m = ESC_INCOMPLETE.exec(raw);
  g.carry = m && m[0].length ? m[0] : '';
  if (g.carry) {
    raw = raw.slice(0, raw.length - g.carry.length);
  }
  const text = normalise(raw);
  if (!text) {
    return;
  }
  const dm = DIALOG_RE.exec(text);
  const busy = BUSY_RE.test(text);
  const composer = COMPOSER_RE.test(text);
  const was = g.last;
  if (dm) {
    g.last = 'dialog';
    g.dialogKind = AUTH_TEXT.test(dm[0]) ? 'auth' : 'proceed';
    g.pastStartup = true;
  } else if (busy) {
    g.last = 'busy';
    g.pastStartup = true;
  } else if (composer) {
    // idle evidence only when the SAME chunk carries no busy marker (see header)
    g.last = 'idle';
    g.pastStartup = true;
  }
  // a chunk with none of the three markers changes nothing (mid-scroll partial redraw)
  if (g.last !== was) {
    log(`gemini-gate: ${paneid} ${was ?? 'unarmed'} -> ${g.last}${g.last === 'dialog' ? ` (${g.dialogKind})` : ''}`);
  }
}

/** The room-typer guard's whole question: not-ready (held, past-startup not
 *  yet evidenced) | dialog (an Enter would answer it) | busy (generating —
 *  never typeable for this vendor, unlike claude's streaming) | idle. */
export function state(paneid: string): GeminiState {
  const g = gates.get(paneid);
  if (!g) {
    return 'not-ready';
  }
  if (g.last === 'dialog') {
    return 'dialog';
  }
  if (!g.pastStartup) {
    return 'not-ready';
  }
  return g.last === 'busy' ? 'busy' : 'idle';
}

/** Which dialog is up, for the held projection's detail — null unless state()
 *  is currently 'dialog'. */
export function dialogKindOf(paneid: string): DialogKind | null {
  const g = gates.get(paneid);
  return g && g.last === 'dialog' ? g.dialogKind : null;
}

/** A person at the window said "deliver anyway" (room-typer's deliver-held
 *  override) — same meaning as startup-gate's release(): cleared as of now,
 *  until a NEW dialog or busy marker draws after this point re-blocks it. */
export function release(paneid: string): void {
  const g = gates.get(paneid);
  if (!g) {
    return;
  }
  g.last = 'idle';
  g.pastStartup = true;
  g.dialogKind = null;
}

export function drop(paneid: string): void {
  gates.delete(paneid);
}
sessions.onRemove(drop);

/** Counts only — never screen text. */
export function diag(): { panes: Record<string, unknown> } {
  const panes: Record<string, unknown> = {};
  for (const [paneid, g] of gates) {
    panes[paneid] = { pastStartup: g.pastStartup, last: g.last, dialogKind: g.dialogKind };
  }
  return { panes };
}

/** Tests only. */
export function reset(): void {
  gates.clear();
}
