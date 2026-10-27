/* ============================================================================
 * PANE ACTIVITY (vk [ref], v1 2026-08-05) — per-pane activity STATE machine.
 *
 * Vendor-agnostic by design (Seam C1): this module only consumes neutral
 * SIGNALS — pty data volume, pane lifecycle, and explicit "blocked on user" /
 * "response finished" events. The claude-specific SOURCE of those two events
 * (the user-level Notification/Stop hooks POSTing to /api/claude-hook) lives
 * at the server edge; another vendor with its own signals feeds the same
 * inputs.
 *
 * States (v1 — watcher-wait deferred, no reliable signal yet):
 *   streaming     output flowing (data burst above a keystroke-echo floor)
 *   waiting       blocked on the user (hook signal; survives quiet periods)
 *                 — the renderer's contract word; see ActivityState below
 *   waiting-seen  blocked on a screen prompt the human has SEEN (acked) and
 *                 not yet answered — the design system window-chrome v33 [ticket]
 *   disconnected  pane's process is gone but the row is restorable — set by
 *                 the server for dehydrated rows, not tracked here
 *   idle          none of the above
 *
 * Heuristic floor: a single keystroke echo is a few bytes; claude repainting
 * its input box on keypress can be a few hundred. STREAM_MIN_BYTES only
 * gates ENTERING streaming from a burst; QUIET_MS decays it back. Tune via
 * env if real use misreads (both overridable for tests).
 * ========================================================================== */

/* `waiting`, NOT `question`. The name is not cosmetic: the renderer's alias
 * table (HWB_CHROME_ALIAS in the vendored hwb-ring.js) is the CONTRACT, and it
 * spells this state `waiting` — "blocked on the user, same fact, better name",
 * in the design system own words. Our invented `question` was absent from that table, so
 * hwbRingFromChrome fell through its unknown-key branch to `ended`: a pane
 * WAITING FOR OWNER rendered as FINISHED in the CLI Manager's ring (proven by
 * executing the vendored module, 2026-08-23). Emit the contract's word. */
/* `waiting-seen` (window-chrome v33, ticket): blocked on a prompt the human
 * has SEEN but not answered. Also the contract's own word — HWB_CHROME_ALIAS
 * maps it to the ring's `attention-seen` (still coral, nothing moves). Before
 * v33 an acked block rested at `idle`, so an unanswered questionnaire looked
 * exactly like a finished session on every ring. */
export type ActivityState = 'streaming' | 'background' | 'waiting' | 'waiting-seen' | 'idle' | 'disconnected';

const QUIET_MS = Number(process.env.HARBOR_WB_ACT_QUIET_MS) || 2000;
const STREAM_MIN_BYTES = Number(process.env.HARBOR_WB_ACT_MIN_BYTES) || 600;

/* ============================================================================
 * THREE-WAY ACTIVITY (the design system window-chrome v21, 2026-09-19).
 *
 * Bytes cannot tell "the model is working" from "a watcher is printing": both
 * are content on the pty. The turn hooks can. So a TURN-AWARE pane (one that
 * has ever sent UserPromptSubmit) is classified by the turn, not the bytes:
 *
 *   busy        (token `streaming`)  UserPromptSubmit .. Stop. Subsumes
 *                                    background: output during a turn is the
 *                                    turn's output.
 *   background  content output with NO turn running (monitors, background
 *               tasks). the design system hysteresis, required so one stray repaint does
 *               not flash the ring: ENTER after activity persists BG_PERSIST_MS
 *               or BG_BURSTS separate bursts land within BG_WINDOW_MS; LEAVE
 *               only after BG_QUIET_MS of quiet.
 *
 * A pane that has NEVER sent UserPromptSubmit (hooks not installed, gemini,
 * shells) keeps the pre-v21 byte rule EXACTLY. The flag is per pane and set
 * only by the hook, so turning hooks on is what opts a pane in - nothing else.
 *
 * BUSY WATCHDOG: a missed Stop (crash, hook 401, network) would latch busy
 * forever, which is the "ring lies for hours" failure again. No Stop AND no
 * content for TURN_WATCHDOG_MS drops the turn and falls back to bytes.
 * ========================================================================== */
const BG_PERSIST_MS = Number(process.env.HARBOR_WB_ACT_BG_PERSIST_MS) || 1500;
const BG_BURSTS = Number(process.env.HARBOR_WB_ACT_BG_BURSTS) || 2;
const BG_WINDOW_MS = Number(process.env.HARBOR_WB_ACT_BG_WINDOW_MS) || 3000;
const BG_QUIET_MS = Number(process.env.HARBOR_WB_ACT_BG_QUIET_MS) || 4000;
/** A gap longer than this between content chunks starts a NEW burst. */
const BG_GAP_MS = Number(process.env.HARBOR_WB_ACT_BG_GAP_MS) || 500;
/** Output within this long of a keystroke is the composer ECHOING it, not a
 *  background task. Without it, typing a prompt between turns (claude repaints
 *  ~2.3 KB per key, 2026-09-03) would read as `background` within 1.5s. Applies
 *  to background entry only - the pre-v21 streaming rule is untouched. */
const ECHO_MS = Number(process.env.HARBOR_WB_ACT_ECHO_MS) || 300;
const TURN_WATCHDOG_MS = Number(process.env.HARBOR_WB_ACT_TURN_WATCHDOG_MS) || 3 * 60 * 1000;

interface PaneActivity {
  state: ActivityState;
  lastDataTs: number;
  burstBytes: number; // CONTENT bytes accumulated since burstStart
  burstStart: number; // when the current window opened — see onData
  inOsc: boolean; // an OSC sequence was still open when the last chunk ended
  question: boolean; // hook says claude is blocked on the user
  /** A human has SEEN it. Silences the alarm while `question` stays true, so
   *  the ask is still listed without still shouting. Reset by a new ask. */
  acknowledged: boolean;
  /** Has ever sent UserPromptSubmit - opts the pane into the three-way rule. */
  turnAware: boolean;
  /** A claude turn is running (UserPromptSubmit seen, Stop not yet). */
  turn: boolean;
  /** A Notification (dialog) arrived WHILE a turn was running — see isBusy. */
  questionInTurn: boolean;
  turnStart: number;
  lastInputTs: number;
  /** Background hysteresis: start of the current burst run + recent burst starts. */
  bgRunStart: number;
  bgBursts: number[];
  /** The screen shows a prompt only a human answers (prompt-block.ts):
   *  login, permission or question. While set, output is the prompt's own
   *  repaint and never enters `streaming`/`background` [ticket]. */
  blocked: { reason: string; since: number } | null;
}

const panes = new Map<string, PaneActivity>();

let onChange: ((paneid: string, state: ActivityState) => void) | null = null;
export function setOnChange(cb: (paneid: string, state: ActivityState) => void): void {
  onChange = cb;
}

function ensure(paneid: string): PaneActivity {
  let p = panes.get(paneid);
  if (!p) {
    p = {
      state: 'idle', lastDataTs: 0, burstBytes: 0, burstStart: 0, inOsc: false, question: false, acknowledged: false,
      turnAware: false, turn: false, questionInTurn: false, turnStart: 0, lastInputTs: 0, bgRunStart: 0, bgBursts: [],
      blocked: null,
    };
    panes.set(paneid, p);
  }
  return p;
}

/* ============================================================================
 * TRANSITION LOG — because a snapshot cannot answer "what WAS it doing".
 *
 * Owner, 2026-09-03: "we need a way you can observe prior states and timestamps
 * ... that way as we are refining our ability to tell these things we have
 * reference points that the user can say 'it was doing this' and you don't need
 * to look at current state which doesn't represent 'was'."
 *
 * That is the exact failure mode of /api/diag/activity on its own: it answered
 * "streaming, right now" while the question being asked was "why was it
 * streaming ten minutes ago when nothing was happening". Every hypothesis was
 * equally consistent with the present tense.
 *
 * USER INPUT IS LOGGED TOO, and it is the point. The open question is whether
 * keystrokes are being counted as model output — claude repaints its whole
 * composer on each key, and the streaming floor is roughly one repaint. Only an
 * ordered record of `input` next to `state` can show that: input at T, streaming
 * at T+few-ms, with no model activity in between. Byte COUNTS only, never
 * content — this is a debugging log, not a keylogger.
 * ========================================================================== */
export interface ActivityEvent {
  ts: number;
  paneid: string;
  /** state | input | hook | lifecycle | chrome */
  kind: 'state' | 'input' | 'hook' | 'lifecycle' | 'chrome';
  from?: ActivityState;
  to?: ActivityState;
  /** Why — the evidence at the moment of the transition, never prose. */
  detail?: string;
  /** input only: bytes and keystrokes folded into this record (see record()). */
  bytes?: number;
  count?: number;
}

/* TWO BUDGETS, AND THE SPLIT IS THE WHOLE POINT (Owner, 2026-09-04).
 *
 * A single 800-entry log looked correct and was useless in the one moment it
 * was needed: an alert on Owner's pane cleared itself, he asked what cleared it,
 * and the answer had already been evicted. Measured at that moment — 788 of the
 * 800 events were single keystrokes and NOT ONE hook survived the three-hour
 * window. Typing is the highest-frequency event in the system and the least
 * interesting one; sharing a budget with it guarantees the rare event is always
 * the one thrown away. So input gets its own, smaller bucket and can never
 * evict a hook, a state change, or a chrome emit.
 *
 * Coalescing is the same fix a level down: a keystroke is one byte, and 23 of
 * them in two seconds are one fact ("the user typed"), not 23. Folding them
 * keeps the ORDER that makes the log worth having — input at T, streaming at
 * T+few-ms — while spending one slot instead of 23. */
const LOG_MAX = Number(process.env.HARBOR_WB_ACT_LOG_MAX) || 800;
const INPUT_LOG_MAX = Number(process.env.HARBOR_WB_ACT_INPUT_LOG_MAX) || 300;
const LOG_MAX_AGE_MS = Number(process.env.HARBOR_WB_ACT_LOG_AGE_MS) || 60 * 60 * 1000;
/** Keystrokes closer together than this fold into the preceding input record. */
const INPUT_COALESCE_MS = Number(process.env.HARBOR_WB_ACT_INPUT_FOLD_MS) || 2000;

const signalLog: ActivityEvent[] = [];
const inputLog: ActivityEvent[] = [];

function trim(buf: ActivityEvent[], max: number): void {
  const cutoff = Date.now() - LOG_MAX_AGE_MS;
  while (buf.length > max || (buf.length && buf[0].ts < cutoff)) {
    buf.shift();
  }
}

function record(e: ActivityEvent): void {
  if (e.kind !== 'input') {
    signalLog.push(e);
    trim(signalLog, LOG_MAX);
    return;
  }
  const last = inputLog[inputLog.length - 1];
  if (last && last.paneid === e.paneid && e.ts - last.ts <= INPUT_COALESCE_MS) {
    last.ts = e.ts; // the run's LATEST keystroke, so ordering against state holds
    last.bytes = (last.bytes ?? 0) + (e.bytes ?? 0);
    last.count = (last.count ?? 1) + 1;
    last.detail = `${last.bytes}B x${last.count}`;
    return;
  }
  inputLog.push(e);
  trim(inputLog, INPUT_LOG_MAX);
}

/** The transition log, newest last. `paneid` filters; `sinceMs` windows it.
 *  Merges the two buckets back into one ordered story — the split is a
 *  retention policy, not something a reader should have to know about. */
export function history(opts: { paneid?: string; sinceMs?: number } = {}): ActivityEvent[] {
  const from = opts.sinceMs ? Date.now() - opts.sinceMs : 0;
  return [...signalLog, ...inputLog]
    .filter((e) => e.ts >= from && (!opts.paneid || e.paneid === opts.paneid))
    .sort((a, b) => a.ts - b.ts);
}

/** What a window told the tab chrome about itself (see POST /api/diag/chrome).
 *  Reported by the client because only the client knows what it posted to the
 *  shell — and "did the engine ask for that tab to end?" was unanswerable from
 *  either side alone when two of Owner's tabs vanished on 2026-09-04. */
export function onChrome(paneid: string, detail: string): void {
  record({ ts: Date.now(), paneid, kind: 'chrome', detail });
}

function setState(paneid: string, p: PaneActivity, next: ActivityState, why = ''): void {
  if (p.state !== next) {
    record({
      ts: Date.now(),
      paneid,
      kind: 'state',
      from: p.state,
      to: next,
      detail: why || `burst=${p.burstBytes}`,
    });
    p.state = next;
    onChange?.(paneid, next);
  }
}

/** Where a pane settles when nothing is flowing: an unseen ask shouts, a
 *  seen block still says so (quietly), a running turn is busy, otherwise idle.
 *  One definition so ack, lifecycle, the sweep and the watchdog cannot disagree
 *  about it. */
function restState(p: PaneActivity): ActivityState {
  if ((p.question || p.blocked) && !p.acknowledged) {
    return 'waiting';
  }
  /* SEEN, NOT ANSWERED [ticket, window-chrome v33]. A blocked pane is not
     working, whatever the turn flag says: the turn is parked behind the
     prompt. Seen (acknowledged), it used to rest at `idle` — and every ring
     then drew an unanswered prompt as a finished session. Now it rests at
     `waiting-seen`: the alarm is silenced, the block is still visible.
     ONLY for a SCREEN block (prompt-block.ts), deliberately not for a
     hook-only `question`: the Notification hook also fires for claude's idle
     nag ("waiting for your input" after a finished turn), which is not a
     question anyone must answer, so a seen `question` keeps resting where it
     always did. The screen detector is the positive evidence a prompt is up. */
  if (p.blocked) {
    return 'waiting-seen';
  }
  return p.turn ? 'streaming' : 'idle';
}

/**
 * The user typed — which IS attention, as of 2026-09-04.
 *
 * This was deliberately inert while we measured ("making input clear `waiting`
 * ... changes the signal Owner reads all day. Measure first"). The log answered
 * it: typing into a pane that is blocked on you is the least ambiguous evidence
 * in the system that a human is present and looking at it. Nothing else the
 * engine can see comes close.
 *
 * It clears the ALARM only — see ack().
 *
 * Returns whether the input was TYPING (anything but focus and mouse reports)
 * — the startup block (startup-gate.ts) takes that as a human with eyes on the
 * pane. False for a byte count, which cannot be classified.
 */
export function onInput(paneid: string, data: string | number): boolean {
  /* The WS handler passes the input itself (ticket) so the draft guard can
     CLASSIFY it. Only the length is logged and only a classification is kept —
     the bytes go nowhere else. A number is still accepted (older callers). */
  const bytes = typeof data === 'string' ? data.length : data;
  record({ ts: Date.now(), paneid, kind: 'input', detail: `${bytes}B`, bytes, count: 1 });
  const p = panes.get(paneid);
  if (p) {
    p.lastInputTs = Date.now();
  }
  const typed = typeof data === 'string' ? classifyInput(paneid, data) : false;
  /* ONLY TYPING IS A HUMAN ARRIVING [ticket]. This used to ack on ANY input,
     and input is not only keys: the window's xterm ANSWERS the queries in the
     stream it renders (colour OSC 10/11/12/4, DA/DA2, CPR, DECRPM, XTVERSION),
     and those answers travel the same channel. On 2026-09-30 an engine restart
     replayed a blocked pane's buffer into its reattaching window, the window
     answered six colour queries, and `ack:input` cleared a questionnaire's
     alarm one second later with nobody at the keyboard. A byte COUNT cannot
     be classified, so it no longer acks either. Pointer-down and
     visible-and-focused still ack through `attention.ack`. */
  if (typed) {
    ack(paneid, 'input');
  }
  return typed;
}

/* ---- THE DRAFT GUARD (voice channel, ticket, the design notes §3c) ----
 *
 * "Is something sitting in this pane's input line that a human typed and has
 * not submitted?" The voice channel types a spoken prompt INTO the pty; if Owner
 * has half-typed something there, the injected Enter would submit his draft
 * with the speech glued on. Standing rule (the design notes): never
 * seize an input box that holds a draft.
 *
 * USER INPUT ONLY, by construction: this is fed from onInput, which only the WS
 * input handler calls. The engine's own pty writes (the launch-typed command,
 * the voice inject, a summon's first prompt) never pass through here, so they
 * cannot make a pane look dirty — or clean.
 *
 * A CLASSIFICATION AND A COUNT, NEVER CONTENT (the not-a-keylogger rule). Per
 * pane the guard keeps a character COUNT and a few parser bits, nothing else:
 *   len          net characters in the composer, as far as keys can say
 *   unknown      tracking was lost (see below): draft until a submit or a full
 *                clear, whatever `len` says
 *   inPaste      inside ESC[200~ ... ESC[201~ (a paste can span chunks)
 *   backslash    the char before the cursor is a typed backslash, so a
 *                following Enter inserts a newline instead of submitting
 *   bsSeen       a backslash was typed into the current content
 *   lastUnsure   the char before the cursor is not known (after a backspace or
 *                a cursor move) — it might be a backslash
 *   cursorMoved  the cursor may not be at the end of the content
 *   multiline    a newline is in the composer (Ctrl-U clears one line only)
 * State = draft when `unknown` or `len > 0`, else clean. No entry at all means
 * NOT OBSERVED — the caller decides what that means (a pane adopted after an
 * engine restart is UNKNOWN, which counts as a draft).
 *
 * NET CONTENT, NOT KEYSTROKE HISTORY (2026-09-25). It used to be: any byte that
 * was not a submitting Enter marked the pane dirty, so text typed and then
 * deleted with Backspace or Ctrl-U left it `draft` FOREVER — @the design system sat
 * `held:draft` for hours with two room lines behind an empty composer. Now:
 *   - a printable character (a surrogate pair is one) adds one; pasted text
 *     adds its length;
 *   - Backspace (DEL 0x7f, BS 0x08) removes one (never below zero — backspace
 *     on an empty composer does nothing);
 *   - Ctrl-U clears the line — a single-line composer only; with a newline in
 *     it only the current line goes, so tracking is lost;
 *   - Ctrl-C clears the input — but NOT during a turn, where it interrupts the
 *     model and what it does to typed-ahead text is unknown;
 *   - net zero ⇒ clean.
 * CURSOR AND NAVIGATION KEYS ADD NO CONTENT (live, @the design system 2026-09-25: an Enter
 * on an empty composer, then three arrow keys, re-dirtied it for hours):
 *   - ←/→/Home/End (CSI C/D/H/F, ESC[1~/4~/7~/8~, SS3 variants, Ctrl-A/Ctrl-E)
 *     and PgUp/PgDn/Insert (ESC[5~/6~/2~) never make a pane a draft. On an
 *     empty composer they change nothing at all. With content, ←/→/Home only
 *     note that the cursor may not be at the end (`cursorMoved`), which makes
 *     the NEXT Backspace, Ctrl-U or Delete uncountable (below); End/Ctrl-E on a
 *     one-line composer puts it back;
 *   - a mouse press is not typing and never dirties, but with content it may
 *     have placed the cursor, so it notes `cursorMoved` the same way;
 *   - ↑/↓ are the exception: on an empty composer they RECALL HISTORY into it,
 *     and the screen is not visible from here, so they stay `unknown`.
 * STILL AN APPROXIMATION, and every limit errs toward `draft` (the safe side):
 *   - Backspace / Ctrl-U / Delete / Ctrl-K after the cursor moved: `unknown`
 *     (Backspace at the start of the line deletes nothing; counting it would
 *     declare a full composer clean — then a typed line would be glued into
 *     the middle of the human's text and submitted with it);
 *   - Tab (completion), Ctrl-W (word kill, with content), Ctrl-R, Ctrl-Z and any
 *     other control or Alt/SS3 key: `unknown`;
 *   - a bare Esc: `unknown`. Esc Esc on an EMPTY composer opens Claude Code's
 *     rewind selector, where a typed line + Enter would pick a message;
 *   - Shift+Tab (ESC[Z) cycles the permission mode and never touches content;
 *   - F1-F12 on a claude-code pane add no content (probed 2026-10-11, see
 *     fnKey below); on any other vendor they stay `unknown`;
 *   - an Enter after a Backspace, when a backslash was typed into this content:
 *     the char before the cursor might be that backslash (then Enter is a
 *     newline), so it stays `unknown` rather than guessing "submitted";
 *   - IME composition, grapheme clusters, a mouse-click cursor move: counted as
 *     keys arrive; a cluster Backspace deletes whole leaves a count above zero.
 * `unknown` ends only with a submitting Enter or Ctrl-C (a full clear), or a
 * human's explicit "I have looked" (clearDraft — POST /api/panes/:id/deliver-held).
 *
 * The rules that have not changed, and the direction each errs in:
 *   - focus reports ESC[I / ESC[O and mouse reports (SGR ESC[<b;x;yM|m, and
 *     X10 ESC[M + 3 bytes) are NOT typing: a tap emits them (2026-09-15).
 *   - Only a SUBMITTING Enter clears by submitting: a bare CR that is not inside
 *     a bracketed paste, not preceded by ESC (Alt/Shift+Enter, and the phone
 *     keypad's ⏎+, which sends exactly ESC CR), and not preceded by a backslash.
 *     Counting any of those as a submit would clear in the UNSAFE direction.
 *   - A lone LF (Ctrl+J) inserts a newline: content.
 */
export type DraftState = 'clean' | 'draft';
interface DraftParse {
  len: number;
  unknown: boolean;
  inPaste: boolean;
  backslash: boolean;
  bsSeen: boolean;
  lastUnsure: boolean;
  cursorMoved: boolean;
  multiline: boolean;
}
const drafts = new Map<string, DraftParse>();

/* DRAFT → CLEAN is a retry trigger (FIX 4, live 2026-09-25): room-typer only
   re-evaluates a held queue on an activity transition to idle or on its own
   timers, so a pane that STAYED idle while its draft went clean never typed
   what it held (@the design system: typing diag `lastAt` stuck for hours). Listeners run
   inside the WS input handler, BEFORE the keystroke reaches the pty, so they
   must defer (room-typer's retrySoon does). A throw never escapes. */
const draftCleanListeners: Array<(paneid: string) => void> = [];
export function onDraftClean(fn: (paneid: string) => void): void {
  draftCleanListeners.push(fn);
}

/* DRAFT FLAG PERSISTENCE (night test 2026-10-06): the parse is in memory, so
   an engine restart forgot every draft and the next room line was typed onto
   it. Listeners hear every clean<->draft flip (room-typer writes it to the
   table); markUnknownDraft puts a remembered draft back on adoption. */
const draftFlagListeners: Array<(paneid: string, dirty: boolean) => void> = [];
export function onDraftFlag(fn: (paneid: string, dirty: boolean) => void): void {
  draftFlagListeners.push(fn);
}
function noteDraftFlag(paneid: string, before: DraftParse | undefined, after: DraftParse): void {
  const was = !!before && stateOf(before) === 'draft';
  const is = stateOf(after) === 'draft';
  if (was === is) {
    return;
  }
  for (const fn of draftFlagListeners) {
    try {
      fn(paneid, is);
    } catch {
      /* a listener's failure must never reach the input path */
    }
  }
}
/** A pane adopted after a restart whose box was last seen holding a draft:
 *  back to `draft`, as UNKNOWN (what it holds is not known), until a submit or
 *  a human's Deliver clears it — exactly as if the engine had never gone away. */
export function markUnknownDraft(paneid: string): void {
  drafts.set(paneid, { ...emptyParse(), unknown: true, lastUnsure: true });
}

const ESC = '\x1b';
const CR = '\r';
const LF = '\n';
const BACKSLASH = String.fromCharCode(92);
/* A CSI: ESC [ params(0x30-0x3f)* intermediates(0x20-0x2f)* final(0x40-0x7e). */
const CSI_AT = /^\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/;
/* A whole OSC (ESC ] … BEL or ST) or DCS (ESC P … ST) string at the start. */
const STRING_AT = /^\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\)/;

/** A TERMINAL'S OWN ANSWER to a query the program sent (S0 ride fix, guard
 *  6c): the window's xterm replies through the same input channel keys use,
 *  and Claude Code queries at startup (`ESC[>0q ESC[c`, 3-28 ms around the
 *  dev-channels dialog) — so an automatic DA1 reply `ESC[?1;2c` read as a
 *  human keystroke and cancelled the engine's accept. Never typing:
 *    CSI with a private marker ? > = (DA1/DA2/DA3 `?…c`, DECRPM `?…$y`,
 *    kitty-keyboard `?…u`) — no key xterm.js sends starts its parameters
 *    with one (SGR mouse `<` is handled above);
 *    CPR `row;col R`, DSR `n`, ANSI DECRPM `…$y`, XTWINOPS reports `…t`
 *    (no key ends in `t`) [ticket]. A modified F3 is also
 *    `1;<m>R`: counting it as no key errs only toward "clean" on a key that
 *    never edits the composer. */
function terminalReply(params: string, inter: string, final: string): boolean {
  const marker = params[0];
  if (marker === '?' || marker === '>' || marker === '=') {
    return true;
  }
  return (final === 'R' && /^\d+;\d+$/.test(params)) || final === 'n' || (inter === '$' && final === 'y') || final === 't';
}

/* A REPLY SPLIT ACROSS TWO INPUT MESSAGES [ticket]. The parse above needs a
 * whole sequence; handed `ESC]11;rgb:1f1f/` and then `2323/2a2a ESC\`, the
 * first half read as a bare Esc (a `draft`, and typing) and the second as
 * sixteen printable keys. So an INCOMPLETE sequence at the end of a chunk is
 * held and completed by the next chunk, and only the reassembled whole is
 * classified — a reply then parses as a reply, and a key (which xterm always
 * sends whole) parses as the key it is.
 *
 * Held only when it cannot be a complete key on its own: an OSC with at least
 * one digit after `ESC ]` (bare `ESC ]` is Alt+]), a DCS with a body (bare
 * `ESC P` is Alt+Shift+P), a CSI with at least one parameter byte and no final
 * (bare `ESC [` is Alt+[), or any of those ending on the ESC of a split ST.
 * A trailing ESC is held only when every byte before it in the message was a
 * reply (the Escape key is a message of its own); a message that IS a lone ESC
 * is the Escape key. So a split inside a reply's two-byte introducer, or right
 * after the first reply's ESC, still reads as a key — xterm emits each reply in
 * one piece, so that split is not one our window produces.
 *
 * Bounded both ways, so a stray fragment cannot swallow real typing: the rest
 * must arrive within SPLIT_MS (a split reply's halves arrive back to back),
 * and a held tail longer than SPLIT_MAX is not held. An expired fragment is
 * DROPPED, never classified: no key xterm sends is an unterminated sequence. */
const SPLIT_MS = Number(process.env.HARBOR_WB_ACT_SPLIT_MS) || 250;
const SPLIT_MAX = 512;
const PARTIAL_TAIL = /\x1b(?:\][0-9][\x20-\x7e]*\x1b?|P[\x20-\x7e]+\x1b?|\[[\x30-\x3f]+[\x20-\x2f]*)$/;
const heldTail = new Map<string, { text: string; at: number }>();
const CTRL_A = '\x01';
const CTRL_C = '\x03';
const CTRL_E = '\x05';
const CTRL_K = '\x0b';
const CTRL_U = '\x15';
const CTRL_W = '\x17';

/* FUNCTION KEYS (Owner 2026-10-11, room line [ref]). An F5 meant for the page
   reached @briefing-table's pty; "effect not known" made the composer
   `unknown`, and every line the person typed to that seat sat `held:draft`
   behind an empty box until a human pressed Deliver. Probed on a real claude
   (2.1.296, scratch pty): F1-F12 in both encodings and the Shift/Ctrl/Alt
   forms each drew ZERO bytes back and changed no row. So on a claude-code
   pane an F-key is typing (a human is there) and adds no content. Any other
   vendor is not probed and stays `unknown`. The vendor is handed in by the
   server; this module reads no table. */
let vendorOf: (paneid: string) => string | null = () => null;
export function setVendorResolver(fn: (paneid: string) => string | null): void {
  vendorOf = fn;
}
/** A CSI function key: `11~`-`15~`, `17~`-`21~`, `23~`, `24~` (F1-F12) with
 *  any modifier, and `1;<m>P|Q|S` (a modified F1, F2, F4; a modified F3 is
 *  `1;<m>R`, which reads as a CPR reply above). */
function fnKey(params: string, final: string): boolean {
  if (final === '~') {
    const n = Number(params.split(';')[0]);
    return (n >= 11 && n <= 15) || (n >= 17 && n <= 21) || n === 23 || n === 24;
  }
  return /^1;\d+$/.test(params) && (final === 'P' || final === 'Q' || final === 'S');
}

const emptyParse = (): DraftParse => ({
  len: 0, unknown: false, inPaste: false, backslash: false, bsSeen: false, lastUnsure: false, cursorMoved: false, multiline: false,
});
const stateOf = (d: DraftParse): DraftState => (d.unknown || d.len > 0 ? 'draft' : 'clean');

/** Updates the pane's draft classification; returns whether any of `data` was
 *  typing (focus and mouse reports are not). */
function classifyInput(paneid: string, data: string): boolean {
  const now = Date.now();
  const held = heldTail.get(paneid);
  if (held) {
    heldTail.delete(paneid);
    if (now - held.at <= SPLIT_MS) {
      data = held.text + data;
    }
  }
  const tail = PARTIAL_TAIL.exec(data);
  if (tail && tail[0].length <= SPLIT_MAX) {
    heldTail.set(paneid, { text: tail[0], at: now });
    data = data.slice(0, tail.index);
  }
  /* A lone ESC ending a chunk that holds MORE than it: the Escape key arrives
     as a message of its own, so an ESC after other input in one message is
     the first byte of the next reply — held below if all before it was replies,
     otherwise it is an Esc like any other. */
  const escTail = !tail && data.length > 1 && data.endsWith(ESC);
  if (escTail) {
    data = data.slice(0, -1);
  }
  const known = drafts.get(paneid);
  const d: DraftParse = known ? { ...known } : emptyParse();
  /* Only input that IS typing creates an entry. A focus report on an adopted
     (unobserved = unknown) pane must leave it unknown, not declare it clean. */
  let touched = false;
  const clear = (): void => {
    Object.assign(d, emptyParse());
  };
  const lose = (): void => {
    d.unknown = true;
    d.backslash = false;
    d.lastUnsure = true;
  };
  const newline = (): void => {
    d.len++;
    d.multiline = true;
    d.backslash = false;
    d.lastUnsure = false;
  };
  /** ←/→/Home/Ctrl-A (and a mouse press): no content; the cursor may now sit
   *  before the end. Nothing to move over on an empty composer. */
  const cursor = (): void => {
    if (d.len > 0 || d.unknown) {
      d.cursorMoved = true;
      d.backslash = false;
      d.lastUnsure = true;
    }
  };
  /** End/Ctrl-E: back at the end — of the whole content only on one line. */
  const toEnd = (): void => {
    if (d.multiline) {
      cursor();
    } else if (d.len > 0 || d.unknown) {
      d.cursorMoved = false;
      d.backslash = false;
      d.lastUnsure = true;
    }
  };
  /** Delete / Ctrl-K: nothing after a cursor known to be at the end. */
  const deleteForward = (): void => {
    if (d.cursorMoved || d.unknown) {
      lose();
    }
  };
  /** A navigation key, by its final byte (CSI or SS3). */
  const nav = (final: string): boolean => {
    if (final === 'A' || final === 'B') {
      lose(); // ↑/↓: history recall fills the composer, unseen
    } else if (final === 'C' || final === 'D' || final === 'H') {
      cursor();
    } else if (final === 'F') {
      toEnd();
    } else {
      return false;
    }
    return true;
  };
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === ESC) {
      const rest = data.slice(i);
      const str = STRING_AT.exec(rest);
      if (str) {
        i += str[0].length; // an OSC or DCS reply (colour, XTVERSION, DECRQSS): the terminal's, not typing
        continue;
      }
      const csi = CSI_AT.exec(rest);
      if (csi) {
        const params = csi[1];
        const final = csi[3];
        if (terminalReply(params, csi[2], final)) {
          i += csi[0].length; // a query reply (DA, CPR, DECRPM …): not typing
          continue;
        }
        if (params === '' && (final === 'I' || final === 'O')) {
          i += csi[0].length; // focus report: not typing
          continue;
        }
        if (params.startsWith('<') && (final === 'M' || final === 'm')) {
          if (final === 'M') {
            cursor(); // a press may have placed the cursor; never content, never typing
          }
          i += csi[0].length; // SGR mouse report: not typing
          continue;
        }
        if (params === '' && final === 'M') {
          cursor();
          i += csi[0].length + 3; // X10 mouse report: ESC [ M b x y
          continue;
        }
        touched = true;
        i += csi[0].length;
        const key = params.split(';')[0];
        if (params === '200' && final === '~') {
          d.inPaste = true;
          d.backslash = false;
        } else if (params === '201' && final === '~') {
          d.inPaste = false;
          d.lastUnsure = false; // the pasted text is what sits before the cursor
        } else if (params === '' && final === 'Z') {
          /* Shift+Tab: cycles the permission mode, never the composer. */
        } else if (nav(final)) {
          /* arrows / Home / End, with or without modifiers (ESC[1;5D) */
        } else if (final === '~' && (key === '1' || key === '7')) {
          cursor(); // Home
        } else if (final === '~' && (key === '4' || key === '8')) {
          toEnd(); // End
        } else if (final === '~' && (key === '2' || key === '5' || key === '6')) {
          /* Insert, PgUp, PgDn: no content */
        } else if (final === '~' && key === '3') {
          deleteForward();
        } else if (fnKey(params, final) && vendorOf(paneid) === 'claude-code') {
          /* F1-F12: claude-code ignores them (probed): no content */
        } else {
          lose(); // an F-key on an unprobed vendor, and anything else whose effect is not known
        }
        continue;
      }
      touched = true;
      if (rest[1] === CR) {
        newline(); // ESC CR = Alt/Shift+Enter or the keypad's ⏎+: never a submit
        i += 2;
      } else if (rest[1] === 'O' && rest.length > 2) {
        if (!nav(rest[2]) && !('PQRS'.includes(rest[2]) && vendorOf(paneid) === 'claude-code')) {
          lose(); // SS3 keypad, and F1-F4 on an unprobed vendor
        }
        i += 3;
      } else {
        lose(); // a bare Esc or Alt+key
        i += rest.length > 1 ? 2 : 1;
      }
      continue;
    }
    touched = true;
    if (d.inPaste) {
      if (ch === CR || ch === LF) {
        newline(); // a newline inside the pasted text
      } else {
        d.len++;
        d.backslash = false; // a pasted backslash is content, not an escape
        d.lastUnsure = false;
      }
      i++;
      continue;
    }
    if (ch === CR) {
      if (d.backslash) {
        newline(); // backslash-Enter: a newline in the composer
      } else if (d.lastUnsure && d.bsSeen) {
        d.unknown = true; // the char before the cursor may be that backslash
      } else {
        clear(); // submitted
      }
      i++;
      continue;
    }
    if (ch === LF) {
      newline(); // Ctrl+J
      i++;
      continue;
    }
    i++;
    if (ch === '\x7f' || ch === '\b') {
      if (d.unknown) {
        d.lastUnsure = true; // cannot count against an unknown line
      } else if (d.cursorMoved && d.len > 0) {
        lose(); // at the start of the line it deletes nothing — cannot count it
      } else if (d.len > 0) {
        d.len--;
        d.backslash = false;
        if (d.len === 0) {
          clear();
        } else {
          d.lastUnsure = true;
        }
      }
    } else if (ch === CTRL_U) {
      if (d.unknown || d.multiline || d.cursorMoved) {
        lose(); // only part of the content goes, and we cannot see which
      } else {
        clear();
      }
    } else if (ch === CTRL_C) {
      if (panes.get(paneid)?.turn) {
        lose(); // mid-turn it interrupts the model; its effect on the line is unknown
      } else {
        clear();
      }
    } else if (ch === CTRL_A) {
      cursor();
    } else if (ch === CTRL_E) {
      toEnd();
    } else if (ch === CTRL_K) {
      deleteForward();
    } else if (ch === CTRL_W) {
      if (d.len > 0 || d.unknown) {
        lose(); // how much a word kill took is not countable
      }
    } else if (ch < ' ') {
      lose(); // Tab (completion), Ctrl-R, Ctrl-Z, ...
    } else {
      const code = ch.charCodeAt(0);
      const next = i < data.length ? data.charCodeAt(i) : 0;
      if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        i++; // a surrogate pair is one character
      }
      d.len++;
      d.backslash = ch === BACKSLASH;
      if (d.backslash) {
        d.bsSeen = true;
      }
      d.lastUnsure = false;
    }
  }
  if (escTail) {
    if (touched) {
      lose(); // after typing it is an Esc (a bare Esc or Alt+key, as in the loop)
    } else {
      heldTail.set(paneid, { text: ESC, at: now }); // after replies: the next reply's first byte
    }
  }
  if (known && stateOf(known) === 'draft' && stateOf(d) === 'clean') {
    for (const fn of draftCleanListeners) {
      try {
        fn(paneid);
      } catch {
        /* a listener's failure must never reach the input path */
      }
    }
  }
  if (touched || known) {
    drafts.set(paneid, d);
    noteDraftFlag(paneid, known, d);
    /* lastGrowAt (the design notes §5): READ-ONLY bookkeeping for the
       screen model's shadow comparison. Nothing here reads it back. */
    if (d.len > (known?.len ?? 0)) {
      growAt.set(paneid, Date.now());
    } else if (d.len === 0 && !d.unknown) {
      growAt.delete(paneid);
    }
  }
  return touched;
}

/* When `len` last INCREASED (a printable key or a paste), unset once the line
   is back to an observed-empty one (a submit, Ctrl-C, Ctrl-U, Backspace to
   zero). Kept beside the parse, never inside it, so the guard's own state and
   every answer it gives are untouched: the only reader is the screen model's
   shadow log (vscreen.ts), which asks "has the input box repainted since the
   last content keystroke?". A timestamp, never content. */
const growAt = new Map<string, number>();

/** The draft guard as the screen model's shadow comparison needs it: the
 *  state, whether a `draft` is CERTAIN (a counted, cursor-at-end line) or
 *  UNCERTAIN (`unknown` or `cursorMoved` — the Esc / Tab / ↑ / Ctrl-R class P1
 *  would let a fresh screen lower), and two timestamps. Booleans and times
 *  only — never the count, never content. Read-only: no caller of this can
 *  change what draftState() answers. */
export interface DraftView {
  state: DraftState | 'unobserved';
  certain: boolean;
  uncertain: boolean;
  lastInputAt: number | null;
  lastGrowAt: number | null;
}
export function draftView(paneid: string): DraftView {
  const d = drafts.get(paneid);
  const state: DraftState | 'unobserved' = d ? stateOf(d) : 'unobserved';
  const uncertain = !!d && state === 'draft' && (d.unknown || d.cursorMoved);
  return {
    state,
    certain: !!d && state === 'draft' && d.len > 0 && !uncertain,
    uncertain,
    lastInputAt: panes.get(paneid)?.lastInputTs || null,
    lastGrowAt: growAt.get(paneid) ?? null,
  };
}

/** 'clean' | 'draft', or 'unobserved' when no user input has reached this pane
 *  through THIS engine process (the caller decides whether that is clean — a
 *  pane spawned here — or unknown — a pane adopted after a restart). */
export function draftState(paneid: string): DraftState | 'unobserved' {
  const d = drafts.get(paneid);
  return d ? stateOf(d) : 'unobserved';
}

/** Does this pane's input line hold something typed since the last submit? */
export function hasDraft(paneid: string): boolean {
  const d = drafts.get(paneid);
  return !!d && stateOf(d) === 'draft';
}

/** A HUMAN has looked at the composer and says it is clear (POST
 *  /api/panes/:id/deliver-held, cookie credential only). Resets the count and
 *  every unknown to a clean, observed line. Callers: that route, and the
 *  startup gate clearing on `? for shortcuts` after a startup prompt (S0
 *  guard 5 — the hint is drawn only over an empty input box). */
export function clearDraft(paneid: string): void {
  const before = drafts.get(paneid);
  drafts.set(paneid, emptyParse());
  noteDraftFlag(paneid, before, emptyParse());
  growAt.delete(paneid);
}

/** S0 guard 5's reset (startup-gate onDraftReset), narrowed (ride fix): only
 *  a parse with NOTHING COUNTED in it — the Esc / arrow `unknown` left by
 *  answering a startup prompt — is reset to clean. A counted draft is text a
 *  human typed; a `? for shortcuts` quoted in rendered history must never
 *  wipe it. Returns whether it reset. */
export function clearUncountedDraft(paneid: string): boolean {
  if ((drafts.get(paneid)?.len ?? 0) > 0) {
    return false;
  }
  clearDraft(paneid);
  return true;
}

/** BUSY = a claude turn is running, or a dialog came up DURING one (a
 *  permission prompt / AskUserQuestion menu). An Enter typed into either
 *  answers or interrupts something that is not a prompt — a dialog's default
 *  is Yes. `questionInTurn` survives the turn watchdog on purpose: the
 *  watchdog drops `turn` after minutes of silence, which is exactly what a
 *  dialog waiting on a human looks like. Question ALONE is not busy: the idle
 *  nag after Stop sets it too, and the hook sink cannot tell the two apart. */
export function isBusy(paneid: string): boolean {
  const p = panes.get(paneid);
  return !!p && (p.turn || p.questionInTurn);
}

/** A dialog came up inside a turn (permission prompt, question) and is still
 *  on screen. An injected Enter here would ANSWER it. */
export function isDialogUp(paneid: string): boolean {
  return !!panes.get(paneid)?.questionInTurn;
}

/**
 * ATTENTION: a human is engaged with this pane. Clears the alarm, never the ask.
 *
 * Owner, 2026-09-04, after alt-tabbing to a flashing window, clicking it, and
 * watching it keep flashing: "we'll want if the window got focus after not
 * having focus for it to clear the alert." The engine had no attention input at
 * all — `waiting` ended only on output or the Stop hook, and switching tabs
 * away and back only worked because the repaint IS output. That was never
 * attention detection; it was a coincidence that looked like one.
 *
 * TWO LEVELS, and the split is his rule (asks decay in loudness, never in
 * existence): seeing the tab stops it DEMANDING, but it does not answer the
 * question the CLI asked. So `question` stays true and the state leaves
 * `waiting`; only a Stop hook — the agent saying it is done — resolves it. If
 * a glance cleared the ask outright, the first look would destroy the only
 * record that something is still blocked.
 *
 * Grain is per-PANE, never per-window: a window holds many tabs and only the
 * one you land on has been seen. Clearing all of them on window focus would
 * silently discard signals, which is worse than the bug it fixes.
 */
export function ack(paneid: string, how: string): void {
  const p = panes.get(paneid);
  if (!p || !(p.question || p.blocked) || p.acknowledged) {
    /* ON THE TRANSITION, NEVER ON A REPEAT. An ack is the event "a human
       arrived"; a pane that is quiet has nothing to acknowledge, and one
       already seen has nothing new to say. Without the `acknowledged` half,
       `onInput` acked on EVERY keystroke and 5000 of them flooded the signal
       log — evicting the very Notification that explains the alert, which is
       precisely the failure the two-bucket split exists to prevent. Caught by
       the test, not by reading it. */
    return;
  }
  p.acknowledged = true;
  record({ ts: Date.now(), paneid, kind: 'hook', detail: `ack:${how} (alarm cleared, ask kept)` });
  setState(paneid, p, restState(p), `ack:${how}`);
}

/* CONTENT bytes in a chunk — everything except OSC sequences.
 *
 * OSC (ESC ] ... BEL, or ESC ] ... ESC backslash) is out-of-band terminal chrome:
 * window title, hyperlink wrappers, clipboard. It changes nothing a human
 * reads in the pane body, so counting it as "output flowing" is a category
 * error — and not a theoretical one. Claude Code BLINKS the terminal title
 * when it wants attention: ~29 bytes every ~300ms, emitted precisely because
 * the session is sitting idle waiting for a human. Measured live on Owner's
 * Kiosk pane, 2026-09-01. CSI/SGR are deliberately still counted; a TUI
 * repainting its body IS output.
 *
 * `inOsc` carries an unterminated sequence across a chunk boundary. A chunk
 * that ends on a lone ESC mis-counts the ~29 bytes of one title write, which
 * cannot reach a 600-byte floor on its own.
 */
function contentBytes(chunk: string, p: PaneActivity): number {
  if (!p.inOsc && chunk.indexOf('\x1b]') === -1) {
    return chunk.length; // fast path: the overwhelmingly common case
  }
  let count = 0;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (p.inOsc) {
      if (c === '\x07') {
        p.inOsc = false;
      } else if (c === '\x1b' && chunk[i + 1] === '\\') {
        p.inOsc = false;
        i++;
      }
      continue;
    }
    if (c === '\x1b' && chunk[i + 1] === ']') {
      p.inOsc = true;
      i++;
      continue;
    }
    count++;
  }
  return count;
}

/**
 * PTY emitted data for a live pane.
 *
 * THE WINDOW IS A RATE, NOT AN ODOMETER. This used to reset `burstBytes` only
 * when a gap longer than QUIET_MS appeared between chunks, which reads as a
 * burst detector and is not one: any trickle faster than one byte per two
 * seconds accumulates forever, crosses the floor eventually, and then holds
 * its own gap open so the decay sweep can never fire. Kiosk sat pinned at
 * `streaming` for hours on exactly that (145 → 261 → 377 → 522 → 638 → …,
 * `sinceDataMs` never once above 900). So the window now expires on its own
 * age: `STREAM_MIN_BYTES` of content within any QUIET_MS window, which is what
 * the comment always claimed.
 *
 * Only CONTENT advances `lastDataTs` — chrome-only traffic must be completely
 * invisible here, or it would keep re-arming the sweep's quiet test even while
 * failing to enter streaming.
 */
export function onData(paneid: string, chunk: string): void {
  const p = ensure(paneid);
  const bytes = contentBytes(chunk, p);
  if (bytes === 0) {
    return;
  }
  const now = Date.now();
  const prevDataTs = p.lastDataTs;
  if (now - p.lastDataTs > QUIET_MS || now - p.burstStart > QUIET_MS) {
    p.burstBytes = 0;
    p.burstStart = now;
  }
  p.lastDataTs = now;
  p.burstBytes += bytes;
  if (p.blocked) {
    /* [ticket] A prompt that needs the human (a repeating "/login" screen,
       a permission dialog's cursor blink) repaints on its own: that output is
       the prompt, not work. It must never lift the pane out of `waiting` (or,
       once seen, `waiting-seen`). */
    return;
  }
  if (p.turnAware && !p.turn) {
    onBackgroundData(paneid, p, now, prevDataTs);
    return;
  }
  if (p.burstBytes >= STREAM_MIN_BYTES) {
    /* OUTPUT NO LONGER CLEARS AN ASK (Owner, 2026-09-04: "an alert shouldn't
       just time out"). It used to: bytes flowing was read as "the response IS
       the answer". But a burst is not a witness — the alert could rise and fall
       with nobody ever seeing it, which is exactly what happened to him and
       exactly what he could not explain afterwards. An ask now ends because a
       human engaged (ack) or because the agent said it was done (Stop hook).
       The STATE still follows the output, so a pane that starts streaming stops
       showing the alarm; `question` outliving it is what keeps the ask listed. */
    setState(paneid, p, 'streaming', `data burst=${p.burstBytes}B/${now - p.burstStart}ms`);
  }
}

/* Turn-aware pane, no turn running: this output belongs to something other
 * than the model (a watcher, a background task). Never `streaming` - that word
 * now means "a turn is running". */
function onBackgroundData(paneid: string, p: PaneActivity, now: number, prevDataTs: number): void {
  if (p.lastInputTs && now - p.lastInputTs <= ECHO_MS) {
    return; // the composer echoing a keystroke - see ECHO_MS
  }
  if (!prevDataTs || now - prevDataTs > BG_GAP_MS || !p.bgRunStart) {
    p.bgRunStart = now;
    p.bgBursts.push(now);
  }
  p.bgBursts = p.bgBursts.filter((t) => now - t <= BG_WINDOW_MS);
  if (p.state === 'background') {
    return; // already in; lastDataTs (set by the caller) is what holds it there
  }
  if (p.question && !p.acknowledged) {
    /* An unseen ask outranks a watcher's chatter: background is the LEAST
       significant live state, and hiding "needs you" behind it would steal
       the one signal that matters (same zero-sum rule as the ring slot). */
    return;
  }
  const persisted = now - p.bgRunStart >= BG_PERSIST_MS;
  const bursts = p.bgBursts.length >= BG_BURSTS;
  if (persisted || bursts) {
    setState(paneid, p, 'background',
      `bg:enter ${persisted ? `persist=${now - p.bgRunStart}ms` : `bursts=${p.bgBursts.length}/${BG_WINDOW_MS}ms`}`);
  }
}

function resetBackground(p: PaneActivity): void {
  p.bgRunStart = 0;
  p.bgBursts = [];
}

/**
 * Hook: the user submitted a prompt - a TURN starts.
 *
 * Also opts the pane into the three-way rule for good (turnAware). A new prompt
 * is the user answering whatever was outstanding, so any ask is resolved here
 * the same way Stop resolves it.
 */
/* How many turns the hooks have started in this pane. A COUNTER, because a
   turn that starts while the ring already reads `streaming` (the engine's own
   typed text echoing) changes no state, so no onChange can announce it
   (room-typer's codex submit check, Owner 2026-10-05). */
const turnCounts = new Map<string, number>();
export function turnCount(paneid: string): number {
  return turnCounts.get(paneid) ?? 0;
}

/* How many turns have COMPLETED in this pane (Stop / Interrupt hook, or the busy
   watchdog dropping a turn whose Stop was lost). The mirror of turnCount, and
   the readiness signal for a queueing CLI (room-typer's one-queued hold, Codex
   review 2026-10-07: "ready" is the turn finishing, not the next one starting).
   Listeners hear each completion AFTER the counter moved. */
const doneCounts = new Map<string, number>();
export function doneCount(paneid: string): number {
  return doneCounts.get(paneid) ?? 0;
}
const turnDoneTaps: Array<(paneid: string) => void> = [];
export function onTurnDone(fn: (paneid: string) => void): void {
  turnDoneTaps.push(fn);
}
function noteTurnDone(paneid: string): void {
  doneCounts.set(paneid, doneCount(paneid) + 1);
}
function tellTurnDone(paneid: string): void {
  for (const fn of turnDoneTaps) {
    try {
      fn(paneid);
    } catch {
      /* a listener must never reach the hook sink or the sweep */
    }
  }
}

/* Panes that have delivered at least one agent hook since spawn. A pane whose
   hooks never fire (the other-builder, 2026-10-05) must not be held
   forever by a rule that waits on a hook (room-typer's codex submit check). */
const hookSeenPanes = new Set<string>();
export function noteHook(paneid: string): void {
  hookSeenPanes.add(paneid);
}
export function hookSeen(paneid: string): boolean {
  return hookSeenPanes.has(paneid);
}

export function onTurnStart(paneid: string): void {
  const p = ensure(paneid);
  turnCounts.set(paneid, turnCount(paneid) + 1);
  p.turnAware = true;
  p.turn = true;
  p.turnStart = Date.now();
  p.question = false;
  p.questionInTurn = false;
  p.acknowledged = false;
  resetBackground(p);
  record({ ts: Date.now(), paneid, kind: 'hook', detail: 'UserPromptSubmit (turn started)' });
  setState(paneid, p, 'streaming', 'hook:UserPromptSubmit');
}

/** Hook: claude needs the user (permission prompt / questionnaire / idle nag). */
export function onQuestion(paneid: string): void {
  const p = ensure(paneid);
  p.question = true;
  if (p.turn) {
    p.questionInTurn = true; // a dialog INSIDE a turn — busy, see isBusy
  }
  p.acknowledged = false; // a NEW ask re-arms the alarm, whatever was seen before
  record({ ts: Date.now(), paneid, kind: 'hook', detail: 'Notification (blocked on user)' });
  setState(paneid, p, 'waiting', 'hook:Notification');
}

/**
 * The screen shows (or stopped showing) a prompt only a human can answer —
 * prompt-block.ts's answer, pushed on every change [ticket, ticket].
 *
 * A NEW block re-arms the alarm (acknowledged = false), exactly like a new
 * ask; the same block redrawn is not new (prompt-block only calls on a
 * change), so a seen prompt stays quiet (`waiting-seen`) — asks decay in
 * loudness, never in existence (the design notes). Clearing it lets
 * the pane rest where it would have: an unseen question still waits, a running
 * turn streams, otherwise idle.
 */
export function setBlocked(paneid: string, b: { reason: string; since: number } | null): void {
  const p = b ? ensure(paneid) : panes.get(paneid); // a clear never re-creates a dropped pane
  if (!p) {
    return;
  }
  const was = p.blocked?.reason ?? null;
  if (was === (b?.reason ?? null)) {
    return;
  }
  p.blocked = b ? { reason: b.reason, since: b.since } : null;
  if (b) {
    p.acknowledged = false;
    resetBackground(p);
  }
  record({ ts: Date.now(), paneid, kind: 'hook', detail: b ? `blocked:${b.reason} (screen needs the human)` : `unblocked (was ${was})` });
  setState(paneid, p, restState(p), b ? `blocked:${b.reason}` : 'unblocked');
}

/** The prompt this pane is blocked on (prompt-block.ts), or null. */
export function blockedOf(paneid: string): { reason: string; since: number } | null {
  const b = panes.get(paneid)?.blocked;
  return b ? { reason: b.reason, since: b.since } : null;
}

/** Hook: claude finished responding — definitively back to idle. */
export function onResponseDone(paneid: string): void {
  const p = ensure(paneid);
  noteTurnDone(paneid); // before setState: an idle listener must already see the count
  p.question = false;
  p.acknowledged = false;
  p.burstBytes = 0;
  p.burstStart = 0;
  p.turn = false;
  p.questionInTurn = false;
  resetBackground(p);
  record({ ts: Date.now(), paneid, kind: 'hook', detail: 'Stop (response finished)' });
  setState(paneid, p, 'idle', 'hook:Stop');
  tellTurnDone(paneid);
}

/** Pane became live (spawn or reattach). */
export function onLive(paneid: string): void {
  const p = ensure(paneid);
  record({ ts: Date.now(), paneid, kind: 'lifecycle', detail: 'live (spawn/reattach)' });
  setState(paneid, p, restState(p), 'lifecycle:live');
}

/** Pane's process ended — stop tracking (killed rows show no dot; dehydrated
 *  rows are decorated `disconnected` by the server from table state). */
export function drop(paneid: string): void {
  hookSeenPanes.delete(paneid);
  turnCounts.delete(paneid);
  doneCounts.delete(paneid);
  record({ ts: Date.now(), paneid, kind: 'lifecycle', detail: 'process ended' });
  panes.delete(paneid);
  drafts.delete(paneid);
  growAt.delete(paneid);
  heldTail.delete(paneid);
}

/* Read-only view of the machine's internals, for /api/diag/activity.
 *
 * Added 2026-09-01 after a pane sat pinned at `streaming` while its pty was
 * emitting ~3 bytes/sec: every hypothesis about WHY was equally consistent
 * with the outside view, which is the signal to stop reasoning and read the
 * variables. `sinceDataMs` against QUIET_MS is the whole question — the sweep
 * decays exactly when that exceeds it. */
export function dump(): Array<{
  paneid: string;
  state: ActivityState;
  sinceDataMs: number;
  burstBytes: number;
  question: boolean;
  acknowledged: boolean;
  turnAware: boolean;
  turn: boolean;
  sinceTurnStartMs: number;
  blocked: { reason: string; since: number } | null;
}> {
  const now = Date.now();
  return [...panes].map(([paneid, p]) => ({
    paneid,
    state: p.state,
    sinceDataMs: p.lastDataTs ? now - p.lastDataTs : -1,
    burstBytes: p.burstBytes,
    question: p.question,
    acknowledged: p.acknowledged,
    turnAware: p.turnAware,
    turn: p.turn,
    sinceTurnStartMs: p.turn ? now - p.turnStart : -1,
    blocked: p.blocked ? { reason: p.blocked.reason, since: p.blocked.since } : null,
  }));
}

/** The tuning the sweep is actually running with (env-overridable). */
export function tuning(): Record<string, number> {
  return {
    quietMs: QUIET_MS,
    minBytes: STREAM_MIN_BYTES,
    bgPersistMs: BG_PERSIST_MS,
    bgBursts: BG_BURSTS,
    bgWindowMs: BG_WINDOW_MS,
    bgQuietMs: BG_QUIET_MS,
    bgGapMs: BG_GAP_MS,
    echoMs: ECHO_MS,
    turnWatchdogMs: TURN_WATCHDOG_MS,
  };
}

export function get(paneid: string): ActivityState | null {
  return panes.get(paneid)?.state ?? null;
}

/** [agent rest] the latest of: content output, a turn starting, input from a window.
 *  Undefined when none of them ever happened. */
export function lastActiveAt(paneid: string): number | undefined {
  const p = panes.get(paneid);
  const ts = p ? Math.max(p.lastDataTs || 0, p.turnStart || 0, p.lastInputTs || 0) : 0;
  return ts || undefined;
}

/** When this pane last emitted CONTENT (not chrome), or undefined if never.
 *  Session-adopt reads it as evidence: a pane that was silent while a
 *  transcript was being written cannot be the pane writing it. */
export function lastOutputAt(paneid: string): number | undefined {
  const ts = panes.get(paneid)?.lastDataTs;
  return ts ? ts : undefined;
}

/* Decay sweep: streaming quiets down → back to the alarm (if an ask is still
 * unanswered AND unseen) or idle.
 *
 * `!acknowledged` is load-bearing here now that output no longer clears an ask.
 * Without it a seen alert would be re-raised by this sweep the moment the model
 * stopped typing — the alarm would come back by itself, which is the same class
 * of unexplained change as the one that started all this. An ask that a human
 * has looked at stays listed and stays quiet until the agent resolves it. */
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [paneid, p] of panes) {
    if (p.turn && now - Math.max(p.turnStart, p.lastDataTs) >= TURN_WATCHDOG_MS) {
      /* BUSY WATCHDOG: no Stop and no output for the whole window - the Stop
         was lost. Drop the turn and let the byte rule classify from here. */
      p.turn = false;
      noteTurnDone(paneid); // a lost Stop still ended the turn: a queue waiting on it must not wait forever
      record({ ts: now, paneid, kind: 'hook', detail: `watchdog: no Stop/output for ${TURN_WATCHDOG_MS}ms, turn dropped` });
      setState(paneid, p, restState(p), 'watchdog');
      tellTurnDone(paneid);
    }
    if (p.state === 'streaming' && now - p.lastDataTs > QUIET_MS) {
      /* A running turn stays busy through quiet (the model thinking is still a
         turn); restState says so. An unseen ask still wins over it. */
      const next = restState(p);
      if (next !== 'streaming') {
        p.burstBytes = 0;
        p.burstStart = 0;
        setState(paneid, p, next);
      }
    }
    if (p.state === 'background' && now - p.lastDataTs >= BG_QUIET_MS) {
      resetBackground(p);
      setState(paneid, p, restState(p), `bg:leave quiet=${now - p.lastDataTs}ms`);
    }
  }
}, 500);
sweep.unref(); // never hold the process open
