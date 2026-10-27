/* ============================================================================
 * STARTUP BLOCK (S0 — the design notes §4.4, finding F12) [ticket].
 *
 * No typed delivery (room lines, fabric envelopes) into a claude pane until
 * there is POSITIVE evidence that claude is running and past its startup
 * prompts. This module only DETECTS and ANSWERS "blocked?"; room-typer.ts asks.
 *
 * THE HAZARD. A freshly spawned or restored claude pane can sit on a startup
 * prompt — folder trust ("Quick safety check … ❯ No, exit"), the dev-channels
 * warning, the old-session dialog (its DEFAULT, "Resume from summary", compacts
 * the conversation), "Resume this conversation?" — or on a bare shell before
 * claude has even started. The activity machine cannot see any of that: no hook
 * fires before the REPL (F10), so the ring reads `idle`, every room-typer guard
 * passes, and a typed line plus Enter ANSWERS the prompt with its default (or,
 * in the bare shell, RUNS the line).
 *
 * ARMED on every claude-code spawn — fresh launch and restore alike (a fresh
 * launch in a new folder meets the trust prompt too). ALSO on adoption after
 * an engine restart or a broker link's return (guard 1, `adopt()`), seeded
 * from the replay tail: it may block and name, and clears only when the tail
 * ends on a REPL footer drawn after the last prompt text (adopt()).
 * ALSO armed by room-typer (origin `owner`) when the claude owning a pane goes
 * away or changes (assemble-room review 2 P1-B): a claude a human starts by
 * hand gets its startup watched too. An `owner` gate that is blocked with no
 * prompt named reports the prompt as `unknown` to deliver-held.
 *
 * CLEARED ONLY BY POSITIVE EVIDENCE, strongest first:
 *   hook      UserPromptSubmit or Stop from this pane's session since the spawn:
 *             the REPL is running turns, startup is over. DISARMS the gate for
 *             the life of the pane (no further watching). Notification is NOT
 *             evidence, on purpose: it means "needs you", and it is the one hook
 *             whose timing relative to a pre-REPL dialog is not established — if
 *             it ever fired while a dialog was up, clearing on it would be the
 *             unsafe direction.
 *   composer  the REPL's idle footer `? for shortcuts` (CC 2.1.282: the prompt
 *             footer's shortcuts hint, verified in the shipped binary) AFTER the
 *             last startup-prompt text, with NO prompt text within VETO_CHARS
 *             before it (same frame: a session picker draws `… or enter to open
 *             · ? for shortcuts` on one row), and — for a channel launch — only
 *             once the dev-channels warning is behind it: the DialogWatcher
 *             accepted it, a human answered it, or the watcher timed out
 *             (guard 6e). It is
 *             a HEURISTIC and it errs one way only: if the footer is not drawn (a
 *             future CC may reword it) nothing clears here and lines wait for a
 *             hook or a human — visible in the diag as `held:startup`, never
 *             silent. GUARD 8 (§4.4, F20): the permission-MODE footer counts
 *             too — `auto mode on` / `accept edits on` / `plan mode on`, the
 *             three literals in the CC 2.1.283 binary, with a word boundary so
 *             `plan mode only` never matches — because server svc-ops runs
 *             `defaultMode: "auto"`, which never draws `? for shortcuts`. Same
 *             160-char veto. Re-grep the binary on a CC version change.
 *   human     a human TYPED into the pane (focus and mouse reports are not
 *             typing) AND at least KEY_FOLLOW_CHARS of prompt-free output
 *             followed the key within KEY_FOLLOW_MS (guard 2b): a key that
 *             draws nothing, or lands on a dialog that just redraws, proves
 *             nothing. GUARD 2a: once a prompt only a human answers has been
 *             seen (trust, old-session, resume-conversation, api-key,
 *             mcp-server, picker), a composer counts only if a human key came
 *             after that prompt.
 *   deliver-held  a person at the window said "nothing is showing"
 *             (POST /api/panes/:id/deliver-held, §4.4 item 4): only when no
 *             prompt is current (currentPrompt), or with an override that
 *             names the prompt that is.
 * Startup-prompt text seen AFTER the latest evidence re-blocks — the human
 * answered trust, then the dev-channels warning drew. Ordering is by position
 * in the normalised output stream, not by clock, so a prompt and a composer in
 * one chunk are ordered by where they sit, never tied by a shared timestamp.
 *
 * Output is normalised exactly as channels.ts's DialogWatcher does it (every
 * escape sequence → a space, an incomplete trailing sequence carried to the
 * next chunk). The two expressions are repeated here rather than imported so
 * room-typer does not pull the whole channel stack into its import graph.
 *
 * NEVER WRITES to a pty. The one prompt the engine answers is still the
 * dev-channels warning, in channels.ts. The diag carries kinds and times, plus
 * (guard 8) `lastPromptContext` — the 160 normalised characters ending at the
 * latest prompt text — and the CC version the pane's banner showed, IN MEMORY
 * ONLY, so a wrong `held:startup` can be read off the screen that caused it.
 * ========================================================================== */

import * as sessions from './sessions.ts';

const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const ESC_INCOMPLETE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;

function normalise(s: string): string {
  return s.replace(ESC_SEQ, ' ').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ');
}

/** Startup-prompt text, by kind. Substring matches on the normalised stream:
 *  detection here only ever BLOCKS, so a false positive (the text quoted in a
 *  replayed conversation) costs a wait, never a keystroke. */
const PROMPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['trust', /Quick safety check|trust this folder|Accessing workspace/],
  ['dev-channels', /Loading development channels|I am using this for local development/],
  ['old-session', /Resume from summary|Resume full session/],
  ['resume-conversation', /Resume this conversation|Start a new conversation/],
  ['mcp-server', /New MCP server/],
  ['api-key', /Do you want to use this API key/],
  ['picker', /or enter to (?:open|start)|ctrl\+x to delete/],
  ['menu', /Enter to confirm|Esc to cancel|Enter to select/],
];
const PROMPTS_G = PROMPTS.map(([kind, re]) => [kind, new RegExp(re.source, 'g')] as const);
/* `bypass permissions on` is the mode footer of a pane launched with
   --dangerously-skip-permissions (vrpc1, 2026-09-27: held after every restart;
   the label and ' on' are joined at runtime, so grep the binary for the label).
   The auto-updater's notices take the footer's place while they show (CC
   2.1.282/283, re-grepped from the binary 2026-09-27): an idle REPL after an
   update read "Checking for updates" or "Update installed · Restart to apply"
   and was held after every engine restart. `claude update` in a bare shell
   prints "Checking for updates to <channel> version...", hence the lookahead. */
const COMPOSER = /\? for shortcuts|(?:auto mode|accept edits|plan mode|bypass permissions) on(?![a-z])|Checking for updates(?!\s+(?:to|for)\b)|Update installed\s*·\s*Restart to apply|Auto-updating…/g;
/** The version the REPL's banner draws (`Claude Code v2.1.283`), for the diag. */
const CC_VERSION = /Claude Code ?v ?(\d+\.\d+\.\d+)/;
/** A composer footer with prompt text this close before it is part of that
 *  prompt's frame, not the REPL's idle composer. */
export const VETO_CHARS = 160;
/** Normalised text kept across chunks: a match or a veto window can straddle. */
const TAIL_CHARS = 400;
/** Guard 4: prompt text this close to the end of the stream is still CURRENT
 *  (on screen, as far as the text path can tell). */
export const CURRENT_CHARS = 400;
/** Guard 5: `? for shortcuts` this close to the end of the stream is the live
 *  footer under the input box (anything further back was quoted text). */
export const SHORTCUTS_LIVE_CHARS = 200;

/** GUARD 2 (§4.4 item 2): prompts only a HUMAN answers. Once one has been
 *  seen since arm, a composer counts only if a human keystroke came after it
 *  — a footer can be repainted under a dialog that is still showing. */
const HUMAN_ANSWER = new Set(['trust', 'old-session', 'resume-conversation', 'api-key', 'mcp-server', 'picker']);
/** GUARD 2b: a keystroke is evidence only once this many normalised,
 *  prompt-free characters have followed it, within KEY_FOLLOW_MS — a key that
 *  draws nothing (or redraws the dialog it landed on) proves nothing. */
export const KEY_FOLLOW_CHARS = 200;
export const KEY_FOLLOW_MS = 10_000;

/** GUARD 1: how much of an adopted pane's replay the gate reads — the last
 *  REPLAY_TAIL_CHARS NORMALISED characters of the whole replay (never a raw
 *  byte slice: cursor-only animation, like the focused tool-bullet blink of
 *  an unresolved permission dialog, costs 76 raw bytes per 2 characters and
 *  pushed the dialog out of a 64 KB window in ~9 minutes) — and how close to
 *  the end its REPL footer must sit for the replay to clear the gate. */
export const REPLAY_TAIL_CHARS = 8_000;
export const REPLAY_CLEAR_CHARS = 1_500;

/** `deliver-held`: a person at the window released it (§4.4 item 4).
 *  `replay`: an adopted pane's replay tail held no prompt text in its last
 *  REPLAY_CLEAR_CHARS normalised characters (guard 1). */
export type StartupEvidence = 'hook' | 'composer' | 'human' | 'deliver-held' | 'replay';
/** Who armed a gate: the engine's spawn, room-typer on an owner change, or
 *  boot/recovery adoption of a broker-held pane (guard 1). */
export type GateOrigin = 'spawn' | 'owner' | 'adopt';

interface Gate {
  armedAt: number;
  channel: boolean;
  /** Who armed it (GateOrigin). */
  origin: GateOrigin;
  carry: string;
  tail: string;
  /** Normalised characters fed so far. */
  pos: number;
  /** Stream position just past the latest prompt text (0 = none seen). */
  promptPos: number;
  promptKind: string | null;
  promptAt: number | null;
  /** The VETO_CHARS normalised characters ending at the latest prompt text. */
  promptContext: string | null;
  /** Adoption held with nothing named: the last normalised characters of the
   *  replay, so a false hold can be read (in memory only, like promptContext). */
  adoptTail: string | null;
  /** The CC version the banner showed (null = not seen). */
  ccVersion: string | null;
  /** Stream position of the latest evidence (-1 = none). */
  evidencePos: number;
  evidence: StartupEvidence | null;
  evidenceAt: number | null;
  /** A hook disarmed it: never blocks again, stops watching. */
  done: boolean;
  /** Guard 2a: stream position just past the latest human-answer prompt (0 = none). */
  humanPromptPos: number;
  /** Guard 2a: stream position of the latest human keystroke (-1 = none), and its time. */
  humanKeyPos: number;
  humanKeyAt: number | null;
  /** Guard 2b: a keystroke waiting for KEY_FOLLOW_CHARS of prompt-free output. */
  pendingKey: { pos: number; at: number } | null;
  /** Guard 5: the latest composer evidence was `? for shortcuts` (drawn only
   *  over an EMPTY input box), not a mode footer (drawn whatever it holds). */
  shortcuts: boolean;
  /** Guard 1: feeding an adopted pane's replay — composers are not evidence. */
  replaying: boolean;
  /** Guard 1: stream position just past the latest REPL footer seen in the
   *  replay outside a prompt's own frame (-1 = none). */
  replayComposerPos: number;
}

const gates = new Map<string, Gate>();

const clearListeners: Array<(paneid: string) => void> = [];
/** Called on every blocked → clear edge (room-typer retries the pane's queue). */
export function onClear(fn: (paneid: string) => void): void {
  clearListeners.push(fn);
}

const draftResetListeners: Array<(paneid: string) => void> = [];
/** GUARD 5 (§4.4 item 5): called when the gate clears on the LIVE `? for
 *  shortcuts` footer (within SHORTCUTS_LIVE_CHARS of the stream's end — not a
 *  quote in rendered history) after a detected prompt. The listener resets
 *  only a parse with nothing counted (activity.clearUncountedDraft). The hint
 *  is drawn only over an EMPTY input box,
 *  so the draft parse may be reset to clean (Esc and arrows used to answer the
 *  prompt left it `unknown`). Never on a mode footer: that is drawn whether or
 *  not the box holds text. Runs BEFORE the onClear listeners. */
export function onDraftReset(fn: (paneid: string) => void): void {
  draftResetListeners.push(fn);
}

function fire(fns: Array<(paneid: string) => void>, paneid: string, what: string): void {
  for (const fn of fns) {
    try {
      fn(paneid); // runs inside the pty pump / hook sink: a throw must not escape
    } catch (e) {
      log(`startup: ${what} listener threw for ${paneid}: ${(e as Error).message}`);
    }
  }
}

let dialogProbe: (paneid: string) => string | null = () => null;
/** Wired by the server to channels.dialogStateOf (dependency handed in, not imported). */
export function setDialogProbe(fn: (paneid: string) => string | null): void {
  dialogProbe = fn;
}

/* GUARD 6e (§4.4): the dev-channels dialog states that let a channel launch's
   composer count — accepted by the engine, answered by a human, or a watcher
   that timed out (a missed auto-accept must not hold lines forever; the
   footer's own 160-char veto still applies). */
const DIALOG_PAST = ['accepted', 'human-answered', 'timeout'];

let log: (line: string) => void = () => {};
export function setLog(fn: (line: string) => void): void {
  log = fn;
}

function blockedGate(g: Gate): boolean {
  return !g.done && g.evidencePos <= g.promptPos;
}

/** Run `mutate`, then fire onClear on a blocked → clear edge. */
function transition(paneid: string, g: Gate, mutate: () => void): void {
  const was = blockedGate(g);
  mutate();
  if (was && !blockedGate(g)) {
    log(`startup: ${paneid} cleared by ${g.done ? 'hook' : g.evidence}`);
    if (!g.done && g.evidence === 'composer' && g.shortcuts && g.promptKind !== null) {
      fire(draftResetListeners, paneid, 'onDraftReset');
    }
    fire(clearListeners, paneid, 'onClear');
  } else if (!was && blockedGate(g)) {
    log(`startup: ${paneid} blocked again — ${g.promptKind} prompt after the last evidence`);
  }
}

/** A claude-code pane was just spawned (fresh or restore). `channel` = this
 *  launch carries the dev-channels flag (its dialog must be accepted first). */
export function arm(paneid: string, opts: { channel: boolean; origin?: GateOrigin }, now = Date.now()): void {
  gates.set(paneid, {
    armedAt: now,
    channel: opts.channel,
    origin: opts.origin ?? 'spawn',
    carry: '',
    tail: '',
    pos: 0,
    promptPos: 0,
    promptKind: null,
    promptAt: null,
    promptContext: null,
    adoptTail: null,
    ccVersion: null,
    evidencePos: -1,
    evidence: null,
    evidenceAt: null,
    done: false,
    humanPromptPos: 0,
    humanKeyPos: -1,
    humanKeyAt: null,
    pendingKey: null,
    shortcuts: false,
    replaying: false,
    replayComposerPos: -1,
  });
}

/**
 * GUARD 1 (§4.4 item 1): a claude-code pane ADOPTED from a broker (engine
 * boot, or the recovery sweep when a link comes back) was running before this
 * engine was watching it, and may be sitting on a trust or old-session dialog
 * a deploy restart left up — or on an IN-TURN dialog (a permission prompt,
 * AskUserQuestion) that has been up for minutes. Arm it (`channel:false` —
 * the DialogWatcher is not re-armed, so a dev-channels dialog up at the
 * restart waits for a human) and read the last REPLAY_TAIL_CHARS normalised
 * characters of the broker's replay through the normal rules.
 *
 * The replay may BLOCK and NAME a prompt. It CLEARS the gate only when its
 * tail ENDS ON A REPL SCREEN (S0 ride fix, 2026-09-26): the latest REPL
 * footer (`? for shortcuts` or a mode footer, outside a prompt's 160-char
 * frame) comes AFTER the latest prompt text and within the last
 * REPLAY_CLEAR_CHARS characters — every end-of-turn frame redraws it, and an
 * in-turn dialog replaces the composer and draws no footer after itself, so a
 * dialog left up for any length of time stays held however much animation
 * followed it. Guard 2a still applies to the replay, which carries no
 * keystrokes: a human-answer prompt within the last REPLAY_CLEAR_CHARS holds
 * whatever footer follows it. A tail with no footer at all (a bare shell, an
 * unrecognised footer, an empty replay) holds with no prompt named, so one
 * deliver-held releases it — as does the pane's next turn hook.
 * The replay's footer is never composer EVIDENCE for the live rules (review
 * 3): it only decides this adoption. Everything after it is live output.
 */
export function adopt(paneid: string, replay: string, now = Date.now()): void {
  arm(paneid, { channel: false, origin: 'adopt' }, now);
  const g = gates.get(paneid)!;
  let tail = normalise(replay);
  if (tail.length > REPLAY_TAIL_CHARS) {
    tail = tail.slice(-REPLAY_TAIL_CHARS);
  }
  g.replaying = true;
  try {
    feed(paneid, g, tail, now);
  } finally {
    g.replaying = false;
  }
  const footer = g.replayComposerPos;
  const endsOnRepl = footer > g.promptPos && g.pos - footer <= REPLAY_CLEAR_CHARS;
  const humanPromptNear = g.humanPromptPos > 0 && g.pos - g.humanPromptPos < REPLAY_CLEAR_CHARS;
  if (endsOnRepl && !humanPromptNear) {
    g.evidencePos = g.pos + 0.5; // as of everything replayed
    g.evidence = 'replay';
    g.evidenceAt = now;
    log(`startup: ${paneid} adopted - clear (its replay ends on the REPL footer)`);
  } else if (g.promptKind) {
    log(`startup: ${paneid} adopted - held: ${g.promptKind} prompt text ${g.pos - g.promptPos} chars from the end of its replay${endsOnRepl ? ' (a human-answer prompt, no keystroke in a replay)' : ', no REPL footer after it'}`);
  } else {
    g.adoptTail = tail.slice(-VETO_CHARS);
    log(`startup: ${paneid} adopted - held: its replay does not end on a REPL footer (nothing named: one deliver-held releases it)`);
  }
}

/** Is typed delivery into this pane held by the startup block? */
export function isBlocked(paneid: string): boolean {
  const g = gates.get(paneid);
  return !!g && blockedGate(g);
}

/** Pty output for a pane. Cheap when the pane is not armed. */
export function onPtyData(paneid: string, chunk: string, now = Date.now()): void {
  const g = gates.get(paneid);
  if (!g || g.done) {
    return;
  }
  transition(paneid, g, () => feed(paneid, g, chunk, now));
}

function feed(paneid: string, g: Gate, chunk: string, now: number): void {
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
  for (const [kind, re] of PROMPTS_G) {
    re.lastIndex = 0;
    for (let mm = re.exec(buf); mm; mm = re.exec(buf)) {
      const end = base + mm.index + mm[0].length;
      if (end > before && end > g.promptPos) {
        /* A generic menu footer in the SAME frame as a named prompt (trust's
           "Enter to confirm") keeps the name: `deliver-held` and the diag
           must say "trust", not "menu" (§4.4 items 4, 8). */
        const sameFrame = kind === 'menu' && g.promptKind !== null && g.promptKind !== 'menu' && end - mm[0].length - g.promptPos <= VETO_CHARS;
        g.promptPos = end;
        if (HUMAN_ANSWER.has(kind)) {
          g.humanPromptPos = Math.max(g.humanPromptPos, end);
        }
        if (!sameFrame) {
          g.promptKind = kind;
          g.promptAt = now;
        }
        g.promptContext = buf.slice(Math.max(0, end - base - VETO_CHARS), end - base);
      }
    }
  }
  COMPOSER.lastIndex = 0;
  for (let mm = COMPOSER.exec(buf); mm; mm = COMPOSER.exec(buf)) {
    const end = base + mm.index + mm[0].length;
    if (end <= before || end <= g.evidencePos) {
      continue; // already counted in an earlier chunk
    }
    const frame = buf.slice(Math.max(0, mm.index - VETO_CHARS), mm.index);
    if (PROMPTS.some(([, re]) => re.test(frame))) {
      continue; // part of a prompt's own frame (a picker footer), not the REPL
    }
    if (g.replaying) {
      g.replayComposerPos = end; // guard 1 decides with it; never evidence (review 3)
      continue;
    }
    if (g.channel && !DIALOG_PAST.includes(dialogProbe(paneid) ?? '')) {
      continue; // a channel launch must have got past the dev-channels warning
    }
    if (g.humanPromptPos > 0 && g.humanKeyPos < g.humanPromptPos) {
      continue; // guard 2a: a human-answer prompt was up and no human key has answered it
    }
    g.evidencePos = end;
    g.evidence = 'composer';
    g.evidenceAt = now;
    /* Guard 5 resets the draft only on the LIVE footer — the hint at the end
       of the stream as this chunk ends, not one quoted in rendered history
       (ride fix): SHORTCUTS_LIVE_CHARS. */
    g.shortcuts = mm[0] === '? for shortcuts' && g.pos - end <= SHORTCUTS_LIVE_CHARS;
  }
  /* Guard 2b: a pending keystroke becomes evidence once KEY_FOLLOW_CHARS of
     prompt-free output have followed it within KEY_FOLLOW_MS. Prompt text
     after it cancels it; so does newer evidence (a composer), which already
     says more. Its time is the KEY's — distrustBefore/distrustHumanSince
     judge the keystroke, not the output that confirmed it. */
  const k = g.pendingKey;
  if (k) {
    if (now - k.at > KEY_FOLLOW_MS || g.promptPos > k.pos || g.evidencePos > k.pos) {
      g.pendingKey = null;
    } else if (g.pos - k.pos >= KEY_FOLLOW_CHARS) {
      g.pendingKey = null;
      g.evidencePos = g.pos;
      g.evidence = 'human';
      g.evidenceAt = k.at;
    }
  }
  g.ccVersion = CC_VERSION.exec(buf)?.[1] ?? g.ccVersion;
  g.tail = buf.slice(-TAIL_CHARS);
}

/** A claude hook for this pane reached the sink (hook_event_name). */
export function onHook(paneid: string, event: string, now = Date.now()): void {
  const g = gates.get(paneid);
  if (!g || g.done || (event !== 'UserPromptSubmit' && event !== 'Stop')) {
    return;
  }
  transition(paneid, g, () => {
    g.done = true;
    g.evidence = 'hook';
    g.evidenceAt = now;
  });
}

/** A human TYPED into the pane (the caller has already excluded focus and
 *  mouse reports). GUARD 2: not evidence by itself any more — (a) it lets a
 *  composer drawn after it count past a human-answer prompt, and (b) it
 *  becomes evidence once KEY_FOLLOW_CHARS of prompt-free output follow it
 *  within KEY_FOLLOW_MS (a key that draws nothing proves nothing). A prompt
 *  drawn after the evidence blocks again, as ever. */
export function onHumanInput(paneid: string, now = Date.now()): void {
  const g = gates.get(paneid);
  if (!g || g.done) {
    return;
  }
  g.humanKeyPos = g.pos + 0.5;
  g.humanKeyAt = now;
  g.pendingKey = { pos: g.pos, at: now };
}

/**
 * GUARD 4 (§4.4 item 4): the prompt a person must name before `deliver-held`
 * may release this pane, or null when none is current — no prompt seen since
 * arm; the latest is dev-channels and its dialog is `accepted` or
 * `human-answered`; or the latest prompt text is more than CURRENT_CHARS
 * behind the end of the stream. Null for an unarmed, clear or hook-disarmed
 * pane. On a channel launch whose dialog is not yet accepted or answered,
 * `dev-channels` is due even before its text draws.
 *
 * `timeout` IS CURRENT (review findings #4/#11, a deliberate departure from
 * the spec's wording): the watcher times out only when it never saw its
 * dialog, and then stops for good, so dev-channels text seen AFTER a timeout
 * is a dialog nobody has answered. One tap must not answer it; a false
 * detection still has its escape, one override naming `dev-channels`.
 */
export function currentPrompt(paneid: string): { kind: string; at: number | null } | null {
  const g = gates.get(paneid);
  if (!g || !blockedGate(g)) {
    return null;
  }
  const channelAnswered = ['accepted', 'human-answered'].includes(dialogProbe(paneid) ?? '');
  if (g.promptKind) {
    const answered = g.promptKind === 'dev-channels' && channelAnswered;
    if (!answered && g.pos - g.promptPos <= CURRENT_CHARS) {
      return { kind: g.promptKind, at: g.promptAt };
    }
  }
  /* A CHANNEL launch always meets the dev-channels dialog (F8): until the
     watcher accepted it (or a human answered it) it is due, even before its
     text has drawn — a line released into the gap would land on it as it
     mounts (review 2 P2, f3). One override naming it still releases. */
  if (g.channel && !channelAnswered) {
    return { kind: 'dev-channels', at: g.promptAt ?? g.armedAt };
  }
  /* A gate room-typer armed for a claude it did not see start (review 2
     P1-B): nothing named is not "nothing showing" — the new claude's first
     screen may predate the arm. One override naming `unknown` releases it. */
  return g.origin === 'owner' && !g.promptKind ? { kind: 'unknown', at: g.armedAt } : null;
}

/** GUARD 6d: the DialogWatcher's view of this pane's normalised stream — its
 *  position counter (escape sequences, OSC title blinks included, are
 *  whitespace and a run of whitespace counts once) and the latest prompt
 *  kind. Null when the pane is not armed or a hook has disarmed it. */
export function streamOf(paneid: string): { pos: number; kind: string | null } | null {
  const g = gates.get(paneid);
  return g && !g.done ? { pos: g.pos, kind: g.promptKind } : null;
}

/** What room-typer needs to decide whether this gate has watched a claude
 *  start (review 2 P1-B): when it was armed, by whom, and when a turn hook
 *  disarmed it (null while not done). Null when the pane is not armed. */
export function info(paneid: string): { armedAt: number; origin: GateOrigin; done: boolean; doneAt: number | null } | null {
  const g = gates.get(paneid);
  return g ? { armedAt: g.armedAt, origin: g.origin, done: g.done, doneAt: g.done ? g.evidenceAt : null } : null;
}

/** Evidence taken BEFORE `t` (a claude's start) was about the shell, not that
 *  claude — a keystroke typing `claude -c` at the bash prompt: forget it, so
 *  only what the claude itself draws (or a later key, or a hook) clears. */
export function distrustBefore(paneid: string, t: number): void {
  const g = gates.get(paneid);
  if (!g || g.done) {
    return;
  }
  forgetKeys(g, (at) => at < t);
  if (g.evidenceAt !== null && g.evidenceAt < t) {
    setAside(paneid, g);
  }
}

/** Guard 2: keystrokes set aside stop counting in every form — pending
 *  (2b) and as the answer to a human-answer prompt (2a). */
function forgetKeys(g: Gate, when: (at: number) => boolean): void {
  if (g.pendingKey && when(g.pendingKey.at)) {
    g.pendingKey = null;
  }
  if (g.humanKeyAt !== null && when(g.humanKeyAt)) {
    g.humanKeyPos = -1;
    g.humanKeyAt = null;
  }
}

/** A KEYSTROKE taken at or after `since` (while the shell owned the pane: the
 *  `fg` or `exec claude -c` that brought a claude back) is not evidence about
 *  that claude: forget it. Composer evidence is kept — a claude returning from
 *  Ctrl+Z repaints on SIGCONT, and that repaint is the proof (review 4). */
export function distrustHumanSince(paneid: string, since: number): void {
  const g = gates.get(paneid);
  if (!g || g.done) {
    return;
  }
  forgetKeys(g, (at) => at >= since);
  if (g.evidence === 'human' && g.evidenceAt !== null && g.evidenceAt >= since) {
    setAside(paneid, g);
  }
}

function setAside(paneid: string, g: Gate): void {
  const was = blockedGate(g);
  g.evidencePos = -1;
  g.evidence = null;
  g.evidenceAt = null;
  if (!was) {
    log(`startup: ${paneid} blocked again — its evidence was about the shell, not the claude now running (set aside)`);
  }
}

/** A person's `deliver-held` released the block: evidence as of everything
 *  output so far, exactly like a keystroke — a prompt drawn after it re-blocks. */
export function release(paneid: string, now = Date.now()): void {
  const g = gates.get(paneid);
  if (!g || g.done) {
    return;
  }
  transition(paneid, g, () => {
    g.evidencePos = g.pos + 0.5;
    g.evidence = 'deliver-held';
    g.evidenceAt = now;
  });
}

export function drop(paneid: string): void {
  gates.delete(paneid);
}
sessions.onRemove(drop);

/** One armed pane: kinds and times, the CC version, and — ONLY while the gate
 *  is blocked (a held:startup pane) — the latest prompt's context (guard 8,
 *  in memory only; review finding #5: a cleared pane's screen text is not
 *  served). Undefined when the pane is not armed. */
export function diagFor(paneid: string): Record<string, unknown> | undefined {
  const g = gates.get(paneid);
  if (!g) {
    return undefined;
  }
  return {
    blocked: blockedGate(g),
    armedAt: g.armedAt,
    channel: g.channel,
    prompt: g.promptKind,
    promptAt: g.promptAt,
    lastPromptContext: blockedGate(g) && g.promptKind ? { kind: g.promptKind, text: g.promptContext } : null,
    clearedBy: g.done ? 'hook' : blockedGate(g) ? null : g.evidence,
    adoptTail: blockedGate(g) ? g.adoptTail : null,
    evidenceAt: g.evidenceAt,
    ccVersion: g.ccVersion,
  };
}

/** Per armed pane: diagFor. */
export function diag(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const paneid of gates.keys()) {
    out[paneid] = diagFor(paneid);
  }
  return out;
}

/** Tests only. */
export function reset(): void {
  gates.clear();
}
