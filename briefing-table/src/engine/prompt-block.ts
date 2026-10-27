/* ============================================================================
 * PROMPT BLOCK — "this session is stuck on something only a human can answer"
 * [ticket] [ticket].
 *
 * WHY (Owner 2026-09-29/30). (1) engine-seat sat for hours on Claude
 * Code's "please /login" screen; its seat read live/streaming because the
 * prompt's redraws counted as output, and room lines queued in silence.
 * (2) briefing-table's own session sat on a permission prompt (an Artifact
 * delete confirm) while Owner was away, and nothing in the room said so. Owner
 * watches ROOMS, not tabs.
 *
 * WHAT. Per pane, one answer: blocked on `login` | `permission` | `question`
 * | `limit`, or not blocked. activity.ts turns it into `waiting` (coral "needs you") and
 * refuses to let the prompt's own repaints read as `streaming`; room-typer
 * holds typed lines with reason `needs-you`; the room seat carries it.
 *
 * DETECTION ONLY. This module holds no pty handle and never writes to one:
 * it never answers, types into, or dismisses a prompt.
 *
 * WHICH SCREEN MODEL. The normalised output stream (every escape sequence a
 * space, whitespace collapsed) — the same text path startup-gate.ts and
 * gemini-gate.ts read. NOT vscreen.ts: that headless terminal is default-OFF
 * in production (HARBOR_WB_VSCREEN / config.json `vscreen.mode`, unset on the
 * server 2026-09-30), so a detector on it would detect nothing where it matters.
 * "Is it on screen NOW" is answered by POSITIVE CLEAR EVIDENCE, not by time:
 *
 *   permission / question / limit — Claude Code draws an in-turn dialog IN PLACE OF
 *     its composer and draws no composer footer after it (startup-gate.ts's
 *     guard-1 note, and re-verified 2026-09-30 on CC 2.1.285: a Bash approval
 *     answered with Enter was followed within ~450 normalised chars by
 *     `⏸ manual mode on · esc to interrupt`). So the dialog is current until a
 *     composer footer is drawn after it — or a UserPromptSubmit / Stop hook.
 *     The dialog's cursor blink keeps emitting a character or two for as long
 *     as it is up, which is exactly why NO distance/time rule clears these:
 *     one would clear a dialog left up for twenty minutes.
 *   login — the REPL keeps its composer while logged out: the error line
 *     (`⎿ Not logged in · Please run /login`) is followed by a normal
 *     composer, whose footer itself carries `Not logged in · Run /login`
 *     (captured, CC 2.1.285). So a footer is NOT evidence here. Login is
 *     current while its latest marker is within LOGIN_CURRENT_CHARS of the
 *     end of the stream (every composer redraw repaints the footer marker),
 *     and clears on `Login successful`, a Stop hook (a turn the API answered;
 *     an API failure ends the turn with StopFailure, not Stop), or a
 *     UserPromptSubmit (a new prompt; if still logged out its error re-marks).
 *
 * MARKERS — real product text, not guessed (docs: header of each regex).
 * Sources: the installed CC 2.1.285 binary (strings, read-only) AND live
 * captures from a scratch pty on 2026-09-30 (test/fixtures/prompt-block/):
 * a logged-out REPL (scratch CLAUDE_CONFIG_DIR, no credentials), the
 * `/login` method screen, a Bash permission dialog (open, and answered), and
 * an AskUserQuestion picker. Gemini reuses gemini-gate.ts's dialog kinds
 * (strings from @google/gemini-cli 0.62.0's bundle, see that header).
 *
 * THE HOOK SIGNAL. Claude's Notification hook arrives a few seconds after a
 * dialog draws: `permission_prompt` → permission, `auth_success` → clears
 * login, `idle_prompt` is not an ask (the sink already drops it), anything
 * else (elicitation, agent input) → question. A hook-raised ask clears on the
 * same evidence as a screen-raised one (a footer drawn after it, or a turn
 * hook), so a dialog whose text no marker knows is still seen.
 *
 * A KNOWN LIMIT, on the safe side: marker text QUOTED in a pane's output (an
 * agent reading this very file) reads as blocked until the evidence above
 * clears it — a composer footer for a dialog, LOGIN_CURRENT_CHARS of further
 * output for login. The error is toward "needs you", never toward typing a
 * room line into a real prompt.
 * ========================================================================== */

import * as sessions from './sessions.ts';
import * as activity from './activity.ts';
import * as geminiGate from './gemini-gate.ts';

export type BlockReason = 'login' | 'permission' | 'question' | 'limit';
export interface Blocked {
  reason: BlockReason;
  since: number;
}

const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const ESC_INCOMPLETE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;
function normalise(s: string): string {
  return s.replace(ESC_SEQ, ' ').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ');
}

/* LOGIN (CC 2.1.285). Captured: `Not logged in · Please run /login` (the
   error a prompt gets), `Not logged in · Run /login` (the composer footer
   while logged out), `Select login method:` (the /login screen). From the
   binary's own constants: `OAuth token revoked · Please run /login`,
   `Login expired · Please run /login` / `· Run /login to sign in again…`,
   `Session expired. Please run /login to sign in again.`, `API Error: 401 …
   · Please run /login`, `Invalid API key · Fix external API key`,
   `Authentication required · Sign in again to continue`. */
const LOGIN = /Please run \/login|Not logged in · Run \/login|Login expired · Run \/login|Select login method|Invalid API key · Fix external API key|Authentication required · Sign in again/g;
/* `Login successful. Press Enter to continue…` (the /login screen) and the
   `Claude Code login successful` notification text. */
const LOGIN_OK = /Login successful/g;
/* PERMISSION (CC 2.1.285). Captured: `Bash command … Do you want to
   proceed? ❯ 1. Yes 2. Yes, and always allow access to … 3. No Esc to
   cancel · Tab to amend`. From the binary: the file-action question
   `Do you want to ${verbPhrase} ${fileName}?` (make this edit to / create),
   `Do you want to allow Claude to fetch this content?`, `Do you want to allow
   this connection?`, the Skill ask `Use this skill?`, plan mode's `Would you
   like to proceed?`, and the Artifact confirms `Permanently delete <name>?`
   and `Allow Claude to change <name>?` (Owner's case 2). */
const PERMISSION = /Do you want to (?:proceed|make this edit to|create|allow)\b|Would you like to proceed\?|Use this skill\?|Permanently delete [^?]{1,160}\?|Allow Claude to change [^?]{0,160}\?/g;
/* QUESTION — the AskUserQuestion picker (CC 2.1.285). Captured: `☐ Color Do
   you prefer red or blue? ❯ 1. Red … 3. Type something. ─── 4. Chat about
   this Enter to select · ↑/↓ to navigate · Esc to cancel`. From the binary:
   the free-text row's placeholder `Type something` (`.` on single-select),
   `Chat about this`, and the multi-question review `Review your answers` /
   `Ready to submit your answers?`. */
const QUESTION = /Chat about this|\d+\. Type something|Review your answers|Ready to submit your answers\?/g;
/* LIMIT — the usage-limit menu [ticket follow-up] (Owner 2026-09-30: the
   weekly limit stopped several agents at once, the lead's own session among
   them, and none of them read "needs you"). After `You've hit your … limit ·
   resets …` Claude Code runs /rate-limit-options itself and draws `What do
   you want to do? ❯ 1. Stop and wait for limit to reset 2. Wait here, then
   continue automatically at <time> 3. Switch to usage credits Enter to
   confirm · Esc to cancel` IN PLACE OF the composer (screenshots
   rooms/briefing-table-workrooms-8e04befa/Pasted image 15-22 / 15-23). The
   option labels are from the installed CC 2.1.286 binary (strings,
   read-only): `Stop and wait for limit to reset`, `Wait here, then continue
   automatically at|shortly|when the limit resets`, `Don’t continue
   automatically`, `Add funds to continue with …`, `Ask your admin for more
   usage`. NOT the `You've hit your … limit` line itself: it is the turn's
   error, printed above the menu and left in scrollback after it closes.
   No Notification hook fires for this menu. */
const LIMIT = /Stop and wait for limit to reset|Wait here, then continue automatically|Don[’']t continue automatically|Add funds to continue with|Ask your admin for more usage/g;
/* THE COMPOSER'S FOOTER — startup-gate.ts's list plus `manual mode on`, the
   default-mode footer CC 2.1.285 draws (`⏸ manual mode on · ? for shortcuts`,
   captured; absent from 2.1.282/283). Drawn under the composer, never under
   a dialog. */
const FOOTER = /\? for shortcuts|(?:auto mode|accept edits|plan mode|bypass permissions|manual mode) on(?![a-z])/g;
/* CODEX STARTUP SCREENS [assistant switch item 6] — observed from Codex 0.162.1 by
   Owner's Codex seat (test/fixtures/codex-screens/, 2026-10-11). Matched on the
   normalised stream, so line wrapping, whitespace and the selection marker
   (`›` / `>`) do not matter. Never a lone "Sign in": the login screen is the
   full sentence or its Device Code option; the trust screen is its question.
   Codex's composer was not captured, so there is no positive "dialog answered"
   signal for it: a Codex screen is CURRENT while it is within
   LOGIN_CURRENT_CHARS of the newest output (a quiet dialog stays blocked
   however long it sits; once that much later output has drawn, it is gone).
   The error stays toward "needs you", never toward typing into the screen. */
const CODEX_TRUST = /Trust this folder\? Codex can read, edit, and run files here/g;
const CODEX_LOGIN = /Sign in with ChatGPT to use Codex|Sign in with Device Code/g;
/** Dialog text this close before a footer means the footer is in the
 *  dialog's own frame (startup-gate's VETO_CHARS, same reason). */
const VETO_CHARS = 160;
/** Normalised text kept across chunks: a marker can straddle two. */
const TAIL_CHARS = 400;
/** A login marker further back than this is no longer on screen. Every
 *  composer redraw of a logged-out REPL repaints its footer marker; a wide
 *  pane's composer (two rules + footer) is under ~800 characters. */
export const LOGIN_CURRENT_CHARS = 2000;

interface Pane {
  vendor: 'claude-code' | 'gemini-cli' | 'codex-cli';
  /** codex-cli: stream position just past the latest trust-screen marker (0 = none) */
  trustPos?: number;
  carry: string;
  tail: string;
  /** Normalised characters fed so far. */
  pos: number;
  /** Stream position just past the latest login marker (0 = none current). */
  loginPos: number;
  /** The dialog up now (permission / question), and where its text ended. */
  dialog: { reason: 'permission' | 'question' | 'limit'; pos: number } | null;
  /** What was last reported (so `since` survives redraws). */
  cur: Blocked | null;
}
const panes = new Map<string, Pane>();

const listeners: Array<(paneid: string, b: Blocked | null) => void> = [];
/** Called on every change of a pane's answer (set, reason, cleared). */
export function onChange(fn: (paneid: string, b: Blocked | null) => void): void {
  listeners.push(fn);
}

let log: (line: string) => void = () => {};
export function setLog(fn: (line: string) => void): void {
  log = fn;
}

function fresh(vendor: Pane['vendor']): Pane {
  return { vendor, carry: '', tail: '', pos: 0, loginPos: 0, dialog: null, cur: null };
}

/** A pane of a vendor this module knows was spawned or adopted. Other
 *  vendors are never armed (a shell has no prompt of this kind). */
export function arm(paneid: string, vendor: string): void {
  if (vendor !== 'claude-code' && vendor !== 'gemini-cli' && vendor !== 'codex-cli') {
    return;
  }
  const had = panes.get(paneid)?.cur ?? null;
  panes.set(paneid, fresh(vendor));
  if (had) {
    publish(paneid, null);
  }
}

/** How much of an ADOPTED pane's replay seed() reads: the last this-many
 *  NORMALISED characters (startup-gate's REPLAY_TAIL_CHARS, same reason — a
 *  raw byte slice loses a dialog behind its own cursor-blink animation). */
export const REPLAY_TAIL_CHARS = 8_000;

/** A pane adopted from a broker (engine boot, or a link's return) may have
 *  been sitting on a prompt for hours: arm it and read its replay's tail
 *  through the normal rules, so it says "needs you" before its next byte. */
export function seed(paneid: string, vendor: string, replay: string, now = Date.now()): void {
  arm(paneid, vendor);
  const g = panes.get(paneid);
  if (!g) {
    return;
  }
  if (g.vendor === 'claude-code' || g.vendor === 'codex-cli') {
    feed(g, normalise(replay).slice(-REPLAY_TAIL_CHARS));
  }
  sync(paneid, now);
}

/** The answer for a pane — null when not blocked (or not armed). */
export function get(paneid: string): Blocked | null {
  return panes.get(paneid)?.cur ?? null;
}

function evaluate(g: Pane): BlockReason | null {
  if (g.vendor === 'gemini-cli') {
    return null; // derived in sync() from gemini-gate
  }
  if (g.vendor === 'codex-cli') {
    const current = (at: number | undefined): boolean => !!at && g.pos - at <= LOGIN_CURRENT_CHARS;
    // whichever screen drew LAST is the one on screen (login follows trust on a fresh profile)
    if (current(g.trustPos) && (!current(g.loginPos) || (g.trustPos as number) > g.loginPos)) {
      return 'permission';
    }
    return current(g.loginPos) ? 'login' : null;
  }
  if (g.dialog) {
    return g.dialog.reason;
  }
  return g.loginPos > 0 && g.pos - g.loginPos <= LOGIN_CURRENT_CHARS ? 'login' : null;
}

function publish(paneid: string, b: Blocked | null): void {
  const g = panes.get(paneid);
  if (g) {
    g.cur = b;
  }
  log(`prompt-block: ${paneid} ${b ? `needs you (${b.reason})` : 'clear'}`);
  for (const fn of listeners) {
    try {
      fn(paneid, b); // runs in the pty pump / hook sink: a throw must not escape
    } catch (e) {
      log(`prompt-block: listener threw for ${paneid}: ${(e as Error).message}`);
    }
  }
}

/** Re-derive the pane's answer and announce a change. Gemini reads its gate
 *  live (call after anything that moves it, e.g. geminiGate.release). */
export function sync(paneid: string, now = Date.now()): void {
  const g = panes.get(paneid);
  if (!g) {
    return;
  }
  let reason: BlockReason | null;
  if (g.vendor === 'gemini-cli') {
    const k = geminiGate.dialogKindOf(paneid);
    reason = k === 'auth' ? 'login' : k === 'proceed' ? 'permission' : null;
  } else {
    reason = evaluate(g);
  }
  if ((g.cur?.reason ?? null) === reason) {
    return;
  }
  publish(paneid, reason ? { reason, since: now } : null);
}

/** Pty output for a pane. A no-op unless armed. For gemini-cli, call AFTER
 *  geminiGate.onPtyData so the gate has classified this chunk. */
export function onPtyData(paneid: string, chunk: string, now = Date.now()): void {
  const g = panes.get(paneid);
  if (!g) {
    return;
  }
  if (g.vendor === 'claude-code' || g.vendor === 'codex-cli') {
    feed(g, chunk);
  }
  sync(paneid, now);
}

function feed(g: Pane, chunk: string): void {
  let raw = g.carry + chunk;
  const m = ESC_INCOMPLETE.exec(raw);
  g.carry = m && m[0].length ? m[0] : '';
  if (g.carry) {
    raw = raw.slice(0, raw.length - g.carry.length);
  }
  let text = normalise(raw);
  if (g.tail.endsWith(' ') && text.startsWith(' ')) {
    text = text.slice(1);
  }
  if (!text) {
    return;
  }
  const before = g.pos;
  const buf = g.tail + text;
  const base = before - g.tail.length; // stream position of buf[0]
  g.pos = before + text.length;
  /* Every NEW match in this chunk, in stream order, so a dialog and the
     footer that replaced it in one chunk are ordered by where they sit. */
  type Ev = { end: number; kind: 'login' | 'ok' | 'permission' | 'question' | 'limit' | 'footer' | 'trust'; at: number };
  const evs: Ev[] = [];
  const scan = (re: RegExp, kind: Ev['kind']): void => {
    re.lastIndex = 0;
    for (let mm = re.exec(buf); mm; mm = re.exec(buf)) {
      const end = base + mm.index + mm[0].length;
      if (end > before) {
        evs.push({ end, kind, at: mm.index });
      }
    }
  };
  if (g.vendor === 'codex-cli') {
    scan(CODEX_TRUST, 'trust');
    scan(CODEX_LOGIN, 'login');
  } else {
    scan(LOGIN, 'login');
    scan(LOGIN_OK, 'ok');
    scan(PERMISSION, 'permission');
    scan(QUESTION, 'question');
    scan(LIMIT, 'limit');
    scan(FOOTER, 'footer');
  }
  evs.sort((a, b) => a.end - b.end);
  for (const ev of evs) {
    if (ev.kind === 'trust') {
      g.trustPos = ev.end;
    } else if (ev.kind === 'login') {
      g.loginPos = ev.end;
    } else if (ev.kind === 'ok') {
      g.loginPos = 0;
    } else if (ev.kind === 'permission' || ev.kind === 'question' || ev.kind === 'limit') {
      g.dialog = { reason: ev.kind, pos: ev.end };
    } else if (g.dialog && ev.end > g.dialog.pos) {
      const frame = buf.slice(Math.max(0, ev.at - VETO_CHARS), ev.at);
      PERMISSION.lastIndex = 0;
      QUESTION.lastIndex = 0;
      LIMIT.lastIndex = 0;
      if (!PERMISSION.test(frame) && !QUESTION.test(frame) && !LIMIT.test(frame)) {
        g.dialog = null; // the composer is back: the dialog was answered
      }
    }
  }
  g.tail = buf.slice(-TAIL_CHARS);
}

/**
 * A claude hook for this pane reached the sink. `notificationType` is the
 * Notification hook's `notification_type`. Creates an entry for a pane that
 * was never armed (a hook-only ask still counts; nothing feeds it, so only
 * a turn hook clears it).
 */
export function onHook(paneid: string, event: string, notificationType?: string, now = Date.now()): void {
  let g = panes.get(paneid);
  if (event === 'Notification') {
    if (notificationType === 'idle_prompt') {
      return; // the idle nag: the REPL is at its composer, nothing is asked
    }
    if (notificationType === 'auth_success') {
      if (g) {
        g.loginPos = 0;
        sync(paneid, now);
      }
      return;
    }
    if (!g) {
      g = fresh('claude-code');
      panes.set(paneid, g);
    }
    if (g.vendor === 'claude-code' && !g.dialog) {
      g.dialog = { reason: notificationType === 'permission_prompt' ? 'permission' : 'question', pos: g.pos + 0.5 };
    }
  } else if (event === 'UserPromptSubmit' || event === 'Stop') {
    if (!g) {
      return;
    }
    /* The limit menu is drawn BY a submit: Claude Code runs /rate-limit-options
       itself, and that submit's hook reaches the sink after the menu's text
       (the lead's pane, 2026-09-30 3:20 PM PT: UserPromptSubmit, then nothing).
       No prompt can be submitted while the menu is up, so the composer's
       footer, drawn when it closes, is the evidence; a Stop still clears. */
    if (!(event === 'UserPromptSubmit' && g.dialog?.reason === 'limit')) {
      g.dialog = null;
    }
    g.loginPos = 0;
  } else {
    return;
  }
  sync(paneid, now);
}

export function drop(paneid: string): void {
  const had = panes.get(paneid)?.cur ?? null;
  panes.delete(paneid);
  if (had) {
    publish(paneid, null);
  }
}
sessions.onRemove(drop);

/* The ring: activity turns a blocked pane into `waiting` and keeps the
   prompt's repaints from reading as `streaming`. */
onChange((paneid, b) => activity.setBlocked(paneid, b));

/** Kinds, positions and counts only — never screen text. */
export function diag(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [paneid, g] of panes) {
    out[paneid] = {
      vendor: g.vendor,
      blocked: g.cur,
      pos: g.pos,
      loginBack: g.loginPos ? g.pos - g.loginPos : null,
      dialog: g.dialog?.reason ?? null,
    };
  }
  return out;
}

/** Tests only. */
export function reset(): void {
  panes.clear();
}
