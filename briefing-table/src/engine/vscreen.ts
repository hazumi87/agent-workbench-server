/* ============================================================================
 * PTY SCREEN MODEL — P0, SHADOW ONLY (the design notes, rev 2 + the
 * P0 re-score fixes) [ticket].
 *
 * WHAT IT IS. One in-memory terminal (@xterm/headless, the same xterm 6.0.0
 * commit the browser runs) per claude-code pane, fed the pty's OWN output from
 * bindResident — spawned and adopted panes alike, whether or not a window is
 * attached. From that screen it answers one question at settle points: is
 * there unsent text in the input box? `clean | draft | unknown`, where every
 * doubt is `unknown`.
 *
 * WHAT P0 DOES WITH THE ANSWER: NOTHING. Shadow mode builds, classifies and
 * LOGS — it never feeds a consumer. room-typer, voice, the fabric fallback, the
 * startup gate, the channels DialogWatcher and the draft guard read exactly
 * what they read before; nothing here writes into them. The only outputs are
 * the text-free diag (`GET /api/diag/vscreen`), a bounded text-free
 * disagreement log, text-free log lines, and the persisted pty SIZE.
 *
 * INVARIANTS (spec §2) — the ones this file enforces itself:
 *   - THE HEADLESS TERMINAL NEVER WRITES TO THE PTY. Its onData / onBinary are
 *     never bound, and this module holds no pty handle at all. xterm answers
 *     DA / DSR / CPR / focus queries through onData; wired to a pty those
 *     answers would be TYPED into the input box. (test: vscreen.test.ts)
 *   - A CLASSIFICATION, NEVER CONTENT. Diag, log entries and log lines carry
 *     states, closed evidence codes, counts of readings and timings. Never a
 *     character of the screen, never an input-box length. xterm's own logger
 *     is set to `off` so it cannot print a parsed sequence either.
 *   - The virtual screen has the PTY's size, never a viewer's (resize mirrors
 *     only what the engine actually sent to the broker).
 *   - EVERY ENTRY POINT IS FAIL-SAFE. create, seed, feed, resize, gap,
 *     dispose, onInput, noteInject, reading, diag: each catches, sends the
 *     pane `off` (reads unknown) and logs once. xterm parses on its own timer,
 *     where a throw would be an uncaughtException, so the parse itself runs
 *     behind a guard too (guardParse). Nothing here can reach the pty pump,
 *     the boot adoption loop or the WS handler.
 *
 * FLAG. HARBOR_WB_VSCREEN (env, wins) or config.json `vscreen.mode`, re-read
 * when config.json's mtime changes (checked at most once a second, lazily), so
 * the kill switch needs no engine restart and costs no window its scrollback.
 * `off` | `shadow`; anything else is `off`. DEFAULT `off` — shadow is free of
 * pty and consumer effects but not of cost (CPU to parse, ~0.2-0.5 MB per
 * pane, one size write per second per resizing pane, log lines), so it is
 * switched on deliberately. In `off` the module keeps a few fields per pane
 * in memory (size, link, vendor) so it can be switched on live; it creates no
 * terminal, parses nothing, writes nothing to the table and logs nothing.
 *
 * NOT IN P0 (fenced): the redraw nudge (§3.4 — natural recovery is measured
 * first), any `authority`, the `pane.draft` debug badge, P2 prompts/dialogs,
 * P3 serialize. See the spec's "P0 as built" notes.
 * ========================================================================== */

import { readFileSync, statSync } from 'node:fs';
/* THE IMPORT SHAPE IS LOAD-BEARING. `import { Terminal } from '@xterm/headless'`
   passes tsc and THROWS AT BOOT under tsx/node: the package's `main` is a
   CommonJS bundle whose named exports node cannot detect. Default-import the
   module object and destructure. (test: vscreen.test.ts boots this file.) */
import xh from '@xterm/headless';
import * as sessions from './sessions.ts';
import * as activity from './activity.ts';
import { instancePath } from './data-dir.ts';
import { backgroundWork, type BackgroundWork } from './bg-detect.ts';
import { matchCliPrompt, extractSignInLink, looksLikeShellPrompt, type CliPromptName } from './cli-prompt.ts';
import { isLocalMode } from './local-mode.ts';

const { Terminal } = xh;
type Term = InstanceType<typeof Terminal>;
type Params = (number | number[])[];


/* ---- vocabulary (closed: the privacy test asserts membership) ------------ */

export type Mode = 'off' | 'shadow';
export type Tri = 'clean' | 'draft' | 'unknown';
export type Surface = 'composer' | 'dialog' | 'unknown';
export type SyncState = 'synced' | 'seeded' | 'sizeless' | 'off';
export type HostKind = 'pty' | 'conpty';
type BufName = 'normal' | 'alternate';

export const EVIDENCE = [
  'cc.composer.blank',
  'cc.composer.dim',
  'cc.composer.nonDim',
  'cc.composer.inverse',
  'cc.anchor.missing',
  'cc.cursor.hidden',
  'cc.altscreen',
  'cc.veto.pointer',
  'cc.veto.footer',
  'cc.veto.cursor',
  'sync.seeded',
  'sync.sizeless',
  'sync.off',
  'resize.provisional',
  'generic',
] as const;
export type Evidence = (typeof EVIDENCE)[number];

export const LOG_KINDS = [
  'screen-draft/input-clean',
  'screen-clean/input-draft',
  'screen-unknown',
  'engine-inject',
  'typed-into-draft',
  'gap',
  'resize-demote',
  'sync',
  'sizeless',
  'off',
] as const;
export type LogKind = (typeof LOG_KINDS)[number];
type CompareKind = 'agree' | 'screen-draft/input-clean' | 'screen-clean/input-draft' | 'screen-unknown' | 'engine-inject';
type OffCause = 'parse-error' | 'handler-error' | 'budget-lag' | 'budget-rss' | 'internal-error';

export interface ScreenReading {
  composer: Tri;
  surface: Surface;
  sync: SyncState;
  evidence: Evidence;
  /** Internal. Every consumer boundary turns a pending reading into `unknown`. */
  pending: boolean;
  at: number;
  parsedAt: number;
  boxChangedAt: number;
  /** Background work drawn on the screen (bg-detect.ts): counts, none, or null =
   *  cannot tell (gated, unsynced, no footer). Consumers treat null as today. */
  background: BackgroundWork | null;
}

/* ---- tuning ---------------------------------------------------------------- */

const SCROLLBACK = 200;
/** The classifier sees at most this many viewport rows around the cursor. */
const VIEW_ROWS = 60;
const SETTLE_AFTER_PARSE_MS = 120;
const PROVISIONAL_QUIET_MS = 1000;
const LAG_MAX_MS = 2000;
const PANE_BUDGET_BYTES = 2 * 1024 * 1024;
const BREAKER_BYTES = 3 * PANE_BUDGET_BYTES;
const LOG_MAX_PER_KIND = 200;
const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SIZE_WRITE_MIN_MS = 1000;
const MODE_CHECK_MS = 1000;
const INJECT_SLACK_MS = 200;
const MAX_BOX_ROWS = 30;
const DEFAULT_MODE: Mode = 'off';
/* Read here rather than imported so this module never pulls the room stack. */
/* The SCREEN model waits longer than the typer before it trusts a reading (Owner 2026-10-06:
   "settling means it's not ready, so it could wait 3 seconds"): its own env, default 3 s,
   so the room typer's 1.5 s settle is unchanged. Slower to trust, never faster. */
const settleMs = (): number => {
  const raw = process.env.HARBOR_WB_VSCREEN_SETTLE_MS;
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : 3000;
};
const enterDelayMs = (): number => Number(process.env.HARBOR_WB_VOICE_ENTER_MS) || 150;
const echoMs = (): number => activity.tuning().echoMs;

/* ---- deps handed in by the server (no import of index.ts or the table) ---- */

export interface VscreenDeps {
  log(line: string): void;
  /** Is this broker link's socket open right now (a resize sent now arrives)? */
  linkOpen(link: string): boolean;
  /** The engine's own replay buffer for a pane (re-seed after a size appears). */
  replayOf(paneid: string): string | null;
  /** Persist the mirrored pty size; null cols/rows = sizeless. */
  saveSize(paneid: string, cols: number | null, rows: number | null, at: number): void;
  /** The persisted size and when the pane's current process started. */
  loadSize(paneid: string): { cols: number | null; rows: number | null; sizeAt: number | null; startedAt: number | null } | null;
}
let deps: VscreenDeps = {
  log: () => {},
  linkOpen: () => false,
  replayOf: () => null,
  saveSize: () => {},
  loadSize: () => null,
};
export function setDeps(d: Partial<VscreenDeps>): void {
  deps = { ...deps, ...d };
}
function say(line: string): void {
  try {
    deps.log(line);
  } catch {
    /* a logger must never break the screen model */
  }
}

/* ---- the screen view + the claude-code signature ---------------------------- */

export const DIM = 1;
export const INVERSE = 2;
export const BOLD = 4;
export interface ViewRow {
  chars: string[];
  attrs: Uint8Array;
}
/** What a signature may look at: a bounded window of the VIEWPORT (never
 *  scrollback), per cell its characters and dim/inverse/bold, the cursor. */
export interface ScreenView {
  cols: number;
  rows: number;
  buffer: BufName;
  cursorX: number;
  /** Relative to lines[0]. */
  cursorY: number;
  cursorVisible: boolean;
  lines: ViewRow[];
}
export interface Classified {
  composer: Tri;
  surface: Surface;
  evidence: Evidence;
  /** The input box's structure was found (anchor row between two rules). */
  anchored: boolean;
  /** In-memory hash of the box rows' rendered cells; never emitted. */
  boxHash: number | null;
}
export interface ScreenSignature {
  vendor: string;
  hostKind: HostKind;
  /** false = not verified on this host kind: shadow data only; P1 must treat
   *  an unverified signature as `generic`. */
  verified: boolean;
  verifiedOn: string;
  classify(v: ScreenView): Classified;
}

/* By code point, not as literals: an NBSP in source is invisible, and it is
   the one character the whole anchor rule turns on. */
const NBSP = String.fromCharCode(0xa0);
const POINTER = String.fromCharCode(0x276f); // ❯
const RULE_CH = String.fromCharCode(0x2500); // ─
const blank = (ch: string): boolean => ch === '' || ch === ' ' || ch === NBSP;
const rowText = (r: ViewRow): string => r.chars.map((c) => c || ' ').join('');
function isRule(r: ViewRow): boolean {
  if (r.chars[0] !== RULE_CH || r.chars[1] !== RULE_CH) {
    return false;
  }
  let n = 0;
  for (const c of r.chars) {
    if (c === RULE_CH) {
      n++;
    }
  }
  return n >= Math.max(10, r.chars.length >> 1);
}
function boxHashOf(v: ScreenView, from: number, to: number): number {
  let h = 0x811c9dc5;
  for (let y = from; y < to; y++) {
    const r = v.lines[y];
    for (let x = 0; x < r.chars.length; x++) {
      const s = r.chars[x];
      for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      }
      h = Math.imul(h ^ (r.attrs[x] + 0x100), 0x01000193);
    }
    h = Math.imul(h ^ 0x0a, 0x01000193);
  }
  return h >>> 0;
}

/**
 * claude-code, captured on 2.1.282 (probe runs r1-r7, server pty, 140x50,
 * default renderer, native cursor on). Measured frame: the input box is
 * `❯` U+00A0 at column 0 between two full-width `─` rules, text from column 2;
 * the placeholder is dim; a past transcript row is `❯` + a PLAIN space at
 * column 0; a dialog pointer is `❯` at column 1 (`❯ No, exit`, `❯ 1. Yes`) or
 * 2 (`❯ 1. I am using this…`) with a plain space after it.
 * Order (spec §4.1), first match wins: alternate screen · dialog veto ·
 * anchor · box reading. Every doubt is `unknown`.
 */
export function classifyClaude(v: ScreenView): Classified {
  const unknown = (evidence: Evidence, surface: Surface = 'unknown', anchored = false, boxHash: number | null = null): Classified => ({
    composer: 'unknown',
    surface,
    evidence,
    anchored,
    boxHash,
  });
  if (v.buffer === 'alternate') {
    return unknown('cc.altscreen');
  }
  /* DIALOG VETO — structural positions only, anywhere in the viewport window. */
  let pointer = false;
  let footer = false;
  for (const r of v.lines) {
    let x = 0;
    while (x < r.chars.length && blank(r.chars[x])) {
      x++;
    }
    if (x >= r.chars.length) {
      continue;
    }
    if (r.chars[x] === POINTER && x >= 1 && x <= 3) {
      const next = r.chars[x + 1] ?? '';
      if ((x <= 2 && next !== NBSP) || /^ \d+\./.test(rowText(r).slice(x + 1))) {
        pointer = true;
      }
    }
    const t = rowText(r).trim();
    if (t.startsWith('Enter to confirm') || t.startsWith('Esc to cancel')) {
      footer = true;
    }
  }
  if (pointer) {
    return unknown('cc.veto.pointer', 'dialog');
  }
  if (footer) {
    return unknown('cc.veto.footer', 'dialog');
  }
  /* ANCHOR — exactly one `❯`/`!` + NBSP row, a rule above, a rule below. */
  let a = -1;
  let anchors = 0;
  for (let y = 0; y < v.lines.length; y++) {
    const c = v.lines[y].chars;
    if ((c[0] === POINTER || c[0] === '!') && c[1] === NBSP) {
      a = y;
      anchors++;
    }
  }
  if (anchors !== 1 || a === 0 || !isRule(v.lines[a - 1])) {
    return unknown('cc.anchor.missing');
  }
  let b = -1;
  for (let y = a + 1; y < Math.min(v.lines.length, a + 1 + MAX_BOX_ROWS); y++) {
    if (isRule(v.lines[y])) {
      b = y;
      break;
    }
  }
  if (b < 0) {
    return unknown('cc.anchor.missing');
  }
  const hash = boxHashOf(v, a, b);
  if (!v.cursorVisible) {
    return unknown('cc.cursor.hidden', 'unknown', true, hash);
  }
  if (v.cursorY < a || v.cursorY >= b) {
    return unknown('cc.veto.cursor', 'unknown', true, hash);
  }
  /* THE BOX — every row between the rules, from column 2. */
  let dim = 0;
  let nonDim = 0;
  let inverse = 0;
  let fakeCursor = false;
  for (let y = a; y < b; y++) {
    const r = v.lines[y];
    for (let x = 2; x < r.chars.length; x++) {
      if (blank(r.chars[x])) {
        continue;
      }
      const at = r.attrs[x];
      if (at & INVERSE) {
        if (y === a && x === 2) {
          fakeCursor = true;
        } else {
          inverse++;
        }
      } else if (at & DIM) {
        dim++;
      } else {
        nonDim++;
      }
    }
  }
  const out = (composer: Tri, evidence: Evidence): Classified => ({ composer, surface: 'composer', evidence, anchored: true, boxHash: hash });
  if (nonDim > 0) {
    return out('draft', 'cc.composer.nonDim'); // includes the paste / image pills
  }
  if (inverse > 0 || (fakeCursor && dim === 0)) {
    return unknown('cc.composer.inverse', 'unknown', true, hash);
  }
  /* INFERRED (spec §4.1): one inverse cell at column 2 followed by dim text is
     the native-cursor-off placeholder's fake caret — clean. */
  return dim > 0 ? out('clean', 'cc.composer.dim') : out('clean', 'cc.composer.blank');
}

const GENERIC: Classified = { composer: 'unknown', surface: 'unknown', evidence: 'generic', anchored: false, boxHash: null };

export const SIGNATURES: ReadonlyArray<ScreenSignature> = [
  {
    vendor: 'claude-code',
    hostKind: 'pty',
    verified: true,
    verifiedOn: 'claude-code 2.1.282, server pty, default renderer, native cursor on (tengu_native_cursor), DECSTBM off, probe r1-r7',
    classify: classifyClaude,
  },
  {
    /* The pty signature, run on ConPTY IN SHADOW ONLY: whether dim and NBSP
       survive ConPTY is exactly what the VRPC shadow window and the ConPTY
       capture (a P0 exit gate) must show. Never authoritative until then. */
    vendor: 'claude-code',
    hostKind: 'conpty',
    verified: false,
    verifiedOn: 'UNVERIFIED on ConPTY: the pty signature, shadow data only until the VRPC capture passes (spec §7)',
    classify: classifyClaude,
  },
];
function signatureFor(vendor: string, hostKind: HostKind): ScreenSignature | null {
  return SIGNATURES.find((s) => s.vendor === vendor && s.hostKind === hostKind) ?? null;
}

/* ---- combining with the input guard: a PURE function, computed in shadow ---- */

export type InputState = 'clean' | 'draft' | 'unobserved';
export interface CombineIn {
  screen: { composer: Tri; sync: SyncState; pending: boolean; provisional: boolean; parsedAt: number; boxChangedAt: number };
  input: { state: InputState; certain: boolean; uncertain: boolean };
  lastInputAt: number | null;
  lastGrowAt: number | null;
  now: number;
  echoMs: number;
  settleMs: number;
  authority: ReadonlyArray<'draft' | 'draft-certain'>;
}
export interface Combined {
  result: InputState;
  source: 'screen' | 'input' | 'none';
  /** The spec §5 table row that decided it. */
  row: 1 | 2 | 3 | 4 | 5 | 6;
  fresh: boolean;
  echoSettled: boolean;
  boxMoved: boolean;
}
/**
 * The spec §5 table, first match wins. P0 NEVER applies the result: it is
 * computed for the shadow log only ("what would P1 have done"), with
 * authority ['draft'] — row 4 needs 'draft-certain' and is recorded as
 * `inputCertain` + `boxMoved` on the entry instead.
 */
export function combineDraft(c: CombineIn): Combined {
  const s = c.screen;
  const since = c.lastInputAt === null ? Infinity : c.now - c.lastInputAt;
  const echoSettled = c.lastInputAt === null || (since >= c.echoMs && (s.parsedAt > c.lastInputAt || since >= c.settleMs));
  const fresh = !s.pending && s.sync === 'synced' && !s.provisional && echoSettled;
  const boxMoved = c.lastGrowAt === null || s.boxChangedAt > c.lastGrowAt;
  const base = { fresh, echoSettled, boxMoved };
  const draftAuth = c.authority.includes('draft');
  if (draftAuth && fresh && s.composer === 'draft') {
    return { ...base, result: 'draft', source: 'screen', row: 1 };
  }
  if (draftAuth && fresh && s.composer === 'clean') {
    if (c.input.state !== 'draft') {
      return { ...base, result: 'clean', source: 'screen', row: 2 };
    }
    if (boxMoved && c.input.uncertain) {
      return { ...base, result: 'clean', source: 'screen', row: 3 };
    }
    if (boxMoved && c.input.certain && c.authority.includes('draft-certain')) {
      return { ...base, result: 'clean', source: 'screen', row: 4 };
    }
  }
  if (c.input.state !== 'unobserved') {
    return { ...base, result: c.input.state, source: 'input', row: 5 };
  }
  return { ...base, result: 'unobserved', source: 'none', row: 6 };
}

/* ---- per-pane record -------------------------------------------------------- */

type Timer = ReturnType<typeof setTimeout>;
const IDLE_SHAPE = { phase: 'idle' as 'idle' | 'k' | 'b', count: 0 };
interface Rec {
  paneid: string;
  link: string;
  hostKind: HostKind;
  vendor: string;
  sig: ScreenSignature | null;
  /** The pty size as last mirrored (what was SENT, spec §3.2). */
  cols: number;
  rows: number;
  sizeKnown: boolean;
  term: Term | null;
  /** Bumped on every new terminal: a stale callback from an old one no-ops. */
  gen: number;
  off: OffCause | null;
  /** A guard caught a throw mid-parse; the next entry point turns it into `off`. */
  fault: OffCause | null;
  bufSync: Record<BufName, 'synced' | 'seeded'>;
  /** > 0 while bytes being parsed are a SEED or pre-gap bytes: markers in them
   *  never promote (only a redraw in live bytes after the seed does). */
  quarantine: number;
  /** ESC[2J or ?1049h seen: a full redraw IF an absolute CUP comes next,
   *  before any print or relative move. */
  arm: { buf: BufName; kind: 'ed2' | 'alt1049' } | null;
  /** claude's reset shape: ESC[H, (ESC[2K ESC[1B) x rows, ESC[H. */
  shape: { phase: 'idle' | 'k' | 'b'; count: number };
  cursorVisible: boolean;
  provisional: boolean;
  provisionalSince: number;
  provMeta: { heightUp: boolean; hadAnchor: boolean } | null;
  provTimer: Timer | null;
  demoteCheck: { hadAnchor: boolean } | null;
  lastWriteAt: number;
  lastParsedAt: number;
  pendingWrites: number;
  pendingBytes: number;
  /** Enqueue times of LIVE writes still unparsed (the lag breaker). */
  pendingTimes: number[];
  settleTimer: Timer | null;
  inputTimers: Timer[];
  classified: Classified | null;
  bg: BackgroundWork | null;
  /** A first-run prompt named on the last settled screen (cli-prompt.ts), or null. */
  cp: CliPromptName | null;
  /** The last settled screen ends at a bare shell prompt (cli-prompt.ts looksLikeShellPrompt). */
  shell: boolean;
  /** The one-time sign-in URL drawn by the login prompt. MEMORY ONLY: never in diag, a log line, an event or a table row (signInLinkOf is the one reader). */
  signInLink: string | null;
  /** The REPL's composer has been on screen at least once since this record was created (= this launch). */
  clearedOnce: boolean;
  createdAt: number;
  classifiedAt: number;
  boxHash: number | null;
  boxChangedAt: number;
  seededAt: number | null;
  syncedAt: number | null;
  syncCause: string | null;
  recoveryMs: number | null;
  injectUntil: number;
  lastKey: string | null;
  save: { lastAt: number; timer: Timer | null };
  counts: {
    readings: number;
    byEvidence: Record<string, number>;
    evals: Record<string, number>;
    idleSynced: number;
    anchored: number;
    markers: Record<string, number>;
  };
}

const recs = new Map<string, Rec>();

/* ---- mode (env > config.json, re-read on mtime) ------------------------------ */

let configPath = instancePath('config.json');
let cfgMtime = -1;
let cfgMode: Mode | null = null;
let modeSource: 'env' | 'config' | 'default' = 'default';
let modeCheckedAt = 0;

function readMode(): Mode {
  const env = process.env.HARBOR_WB_VSCREEN;
  if (env) {
    modeSource = 'env';
    return env === 'shadow' ? 'shadow' : 'off';
  }
  let mtime = -1;
  try {
    mtime = statSync(configPath).mtimeMs;
  } catch {
    cfgMtime = -1;
    cfgMode = null;
  }
  if (mtime >= 0 && mtime !== cfgMtime) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      const m = cfg?.vscreen?.mode;
      cfgMode = m === 'shadow' || m === 'off' ? m : null;
      cfgMtime = mtime;
    } catch {
      /* mid-edit or unreadable: keep what we had, look again next second */
    }
  }
  modeSource = cfgMode ? 'config' : 'default';
  /* LOCAL MODE turns the screen model on by default: the CLI-prompt detector (cliPromptOf) needs the drawn screen, and shadow mode changes no
     consumer's behaviour. Measured cost ~1.4 MB per pane. The env var and config.json still win, in both directions. */
  return cfgMode ?? (isLocalMode(process.env) ? 'shadow' : DEFAULT_MODE);
}
let mode: Mode = readMode();

function checkMode(force = false): void {
  const now = Date.now();
  if (!force && now - modeCheckedAt < MODE_CHECK_MS) {
    return;
  }
  modeCheckedAt = now;
  const next = readMode();
  if (next === mode) {
    return;
  }
  const prev = mode;
  mode = next;
  say(`vscreen: mode ${prev} -> ${next} (${modeSource})`);
  for (const rec of recs.values()) {
    try {
      if (next === 'off') {
        clearSave(rec); // off writes nothing, not even a trailing edge already due
        stop(rec);
      } else if (rec.sizeKnown && !rec.off) {
        persistSize(rec);
        if (rec.sig) {
          instantiate(rec);
          reseed(rec, deps.replayOf(rec.paneid) ?? '');
        }
      }
    } catch {
      goOff(rec, 'internal-error');
    }
  }
}

/** The mode now (re-read if due). */
export function currentMode(): Mode {
  checkMode();
  return mode;
}

/* ---- log (bounded PER KIND: 200 entries or 24h each; never text) -------------- */

type Val = string | number | boolean | null;
export interface LogEntry {
  paneid: string;
  kind: LogKind;
  at: number;
  hostKind: HostKind;
  [k: string]: Val;
}
const logs = new Map<LogKind, LogEntry[]>();
function push(rec: Rec, kind: LogKind, fields: Record<string, Val>): void {
  const now = Date.now();
  const arr = logs.get(kind) ?? [];
  arr.push({ ...fields, paneid: rec.paneid, kind, at: now, hostKind: rec.hostKind });
  while (arr.length && now - arr[0].at > LOG_MAX_AGE_MS) {
    arr.shift();
  }
  if (arr.length > LOG_MAX_PER_KIND) {
    arr.splice(0, arr.length - LOG_MAX_PER_KIND);
  }
  logs.set(kind, arr);
}

/* Totals survive a pane's removal: the P0->P1 exit counts are per window of
   days, not per pane lifetime. */
const totals = {
  evals: {} as Record<string, number>,
  unknownByEvidence: {} as Record<string, number>,
  idleSynced: 0,
  anchored: 0,
  idleByEvidence: {} as Record<string, number>,
  off: {} as Record<string, number>,
  markers: {} as Record<string, number>,
  typedIntoDraft: 0,
};
const bump = (o: Record<string, number>, k: string): void => {
  o[k] = (o[k] ?? 0) + 1;
};

/* ---- lifecycle ------------------------------------------------------------------ */

function newRec(paneid: string, o: CreateOpts, cols: number, rows: number, sizeKnown: boolean): Rec {
  return {
    paneid,
    link: o.link,
    hostKind: o.hostKind,
    vendor: o.vendor,
    sig: signatureFor(o.vendor, o.hostKind),
    cols,
    rows,
    sizeKnown,
    term: null,
    gen: 0,
    off: null,
    fault: null,
    bufSync: { normal: 'seeded', alternate: 'seeded' },
    quarantine: 0,
    arm: null,
    shape: { ...IDLE_SHAPE },
    cursorVisible: true,
    provisional: false,
    provisionalSince: 0,
    provMeta: null,
    provTimer: null,
    demoteCheck: null,
    lastWriteAt: 0,
    lastParsedAt: 0,
    pendingWrites: 0,
    pendingBytes: 0,
    pendingTimes: [],
    settleTimer: null,
    inputTimers: [],
    classified: null,
    bg: null,
    cp: null,
    shell: false,
    signInLink: null,
    clearedOnce: false,
    createdAt: Date.now(),
    classifiedAt: 0,
    boxHash: null,
    boxChangedAt: 0,
    seededAt: null,
    syncedAt: null,
    syncCause: null,
    recoveryMs: null,
    injectUntil: 0,
    lastKey: null,
    save: { lastAt: 0, timer: null },
    counts: { readings: 0, byEvidence: {}, evals: {}, idleSynced: 0, anchored: 0, markers: {} },
  };
}

function clearTimers(rec: Rec): void {
  for (const t of [rec.settleTimer, rec.provTimer, ...rec.inputTimers]) {
    if (t) {
      clearTimeout(t);
    }
  }
  rec.settleTimer = null;
  rec.provTimer = null;
  rec.inputTimers = [];
}

/** Drop the terminal (mode off, off, sizeless); the record's meta stays. */
function stop(rec: Rec): void {
  clearTimers(rec);
  const t = rec.term;
  rec.term = null;
  rec.gen++;
  rec.pendingWrites = 0;
  rec.pendingBytes = 0;
  rec.pendingTimes = [];
  rec.quarantine = 0;
  rec.provisional = false;
  rec.provMeta = null;
  rec.demoteCheck = null;
  rec.classified = null;
  rec.bg = null;
  if (t) {
    /* Deferred: this can run inside the terminal's own write loop. */
    setImmediate(() => {
      try {
        t.dispose();
      } catch {
        /* already gone */
      }
    });
  }
}

function goOff(rec: Rec, cause: OffCause): void {
  if (rec.off) {
    return;
  }
  rec.off = cause;
  bump(totals.off, cause);
  stop(rec);
  push(rec, 'off', { cause });
  say(`vscreen: ${rec.paneid} off (${cause}) — reads unknown for the rest of this process`);
}

/** Catch-all for an entry point: the pane goes off, nothing propagates. */
function fail(paneid: string, where: string): void {
  try {
    const rec = recs.get(paneid);
    if (rec) {
      goOff(rec, 'internal-error');
    } else {
      say(`vscreen: ${where} failed for ${paneid} (no record)`);
    }
  } catch {
    /* never */
  }
}

let parseGuard: boolean | null = null;
/* THE PARSE RUNS ON XTERM'S TIMER, where a throw is an uncaughtException that
   takes the engine down. xterm 6.0.0's WriteBuffer calls `_action` (the input
   handler's parse) with no try/catch. Wrap it — private API, feature-detected,
   and exact-pinned: if the shape ever changes the guard is skipped and the
   diag says `parseGuard: false`. Once the pane is off or the terminal is
   replaced, remaining queued chunks drain without being parsed. */
function guardParse(rec: Rec, term: Term, gen: number): void {
  const wb = (term as unknown as { _core?: { _writeBuffer?: { _action?: unknown } } })._core?._writeBuffer;
  if (!wb || typeof wb._action !== 'function') {
    if (parseGuard !== false) {
      parseGuard = false;
      say('vscreen: parse guard NOT installed (xterm internals changed) — a parser throw would not be contained');
    }
    return;
  }
  const inner = wb._action as (d: string, p?: boolean) => unknown;
  wb._action = (d: string, p?: boolean): unknown => {
    if (rec.off || rec.gen !== gen) {
      return undefined;
    }
    try {
      return inner(d, p);
    } catch {
      rec.fault ??= 'parse-error';
      return undefined;
    }
  };
  parseGuard = true;
}

function instantiate(rec: Rec): void {
  stop(rec);
  const term = new Terminal({
    cols: rec.cols,
    rows: rec.rows,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
    logLevel: 'off', // xterm's own logger must never print a parsed sequence
  });
  const gen = ++rec.gen;
  wire(rec, term, gen);
  guardParse(rec, term, gen);
  rec.term = term;
  rec.cursorVisible = true;
  rec.arm = null;
  rec.shape = { ...IDLE_SHAPE };
  rec.fault = null;
}

/** A write callback: stale generations no-op, a throw becomes a fault. */
function cb(rec: Rec, gen: number, fn: () => void): () => void {
  return () => {
    if (rec.gen !== gen) {
      return;
    }
    try {
      fn();
    } catch {
      rec.fault ??= 'internal-error';
    }
  };
}

function demote(rec: Rec): void {
  rec.bufSync = { normal: 'seeded', alternate: 'seeded' };
  rec.seededAt = Date.now();
  rec.syncedAt = null;
  rec.syncCause = null;
  rec.recoveryMs = null;
  rec.arm = null;
  rec.shape = { ...IDLE_SHAPE };
  rec.provisional = false;
  rec.provMeta = null;
}

function endQuarantine(rec: Rec): void {
  rec.quarantine = Math.max(0, rec.quarantine - 1);
  if (rec.quarantine === 0) {
    rec.arm = null;
    rec.shape = { ...IDLE_SHAPE };
  }
}

/** Reset the terminal IN STREAM ORDER (after whatever is queued) and write a
 *  seed from its first ESC (as sessions.replay does). The pane is `seeded`. */
function reseed(rec: Rec, bytes: string): void {
  const term = rec.term;
  if (!term) {
    return;
  }
  const gen = rec.gen;
  rec.quarantine++;
  demote(rec);
  const esc = bytes.indexOf('\x1b');
  const from = esc <= 0 ? bytes : bytes.slice(esc);
  term.write(
    '',
    cb(rec, gen, () => {
      term.reset();
      rec.cursorVisible = true;
    }),
  );
  rec.pendingWrites++;
  rec.pendingBytes += from.length;
  term.write(
    from,
    cb(rec, gen, () => {
      rec.pendingWrites--;
      rec.pendingBytes -= from.length;
      endQuarantine(rec);
      afterParse(rec);
    }),
  );
}

export interface CreateOpts {
  origin: 'spawn' | 'adopt';
  /** The broker link the session runs on. */
  link: string;
  /** From that link's host platform (win32 = conpty), never from the target. */
  hostKind: HostKind;
  vendor: string;
  cols?: number;
  rows?: number;
}
const validSize = (c: unknown, r: unknown): c is number =>
  typeof c === 'number' && typeof r === 'number' && Number.isInteger(c) && Number.isInteger(r) && c >= 1 && r >= 1 && c <= 2000 && r <= 1000;

/**
 * A pane now exists. Spawn: the pty is fresh at a known size (80x24 today), so
 * the screen is `synced` from byte 0 and that size is persisted at once — the
 * paneid may be a reused one whose row still holds a size from an earlier
 * process. Adopt: the persisted size if it was stamped at or after the row's
 * `started_at`, else `sizeless`; the pane starts `seeded` (seed() follows).
 */
export function create(paneid: string, o: CreateOpts): void {
  try {
    checkMode();
    const old = recs.get(paneid);
    if (old) {
      clearSave(old);
      stop(old);
    }
    let cols = o.cols ?? 80;
    let rows = o.rows ?? 24;
    let sizeKnown = true;
    if (o.origin === 'adopt') {
      const s = deps.loadSize(paneid);
      if (s && validSize(s.cols, s.rows) && s.sizeAt !== null && s.startedAt !== null && s.sizeAt >= s.startedAt) {
        cols = s.cols as number;
        rows = s.rows as number;
      } else {
        sizeKnown = false;
      }
    }
    const rec = newRec(paneid, o, cols, rows, sizeKnown);
    recs.set(paneid, rec);
    if (o.origin === 'spawn') {
      rec.bufSync = { normal: 'synced', alternate: 'synced' };
      rec.syncedAt = Date.now();
      rec.syncCause = 'spawn';
    } else {
      rec.seededAt = Date.now();
    }
    if (mode !== 'shadow') {
      return;
    }
    if (o.origin === 'spawn') {
      persistSize(rec);
    }
    if (rec.sig && rec.sizeKnown) {
      instantiate(rec);
    }
  } catch {
    fail(paneid, 'create');
  }
}

/** Adopt / gap only: reset, then write the tail from its first ESC. */
export function seed(paneid: string, bytes: string): void {
  try {
    const rec = recs.get(paneid);
    if (!rec || !rec.term || rec.off) {
      return;
    }
    reseed(rec, bytes);
  } catch {
    fail(paneid, 'seed');
  }
}

/** Estimated terminal memory: 12 bytes per buffer cell (xterm's 3 x uint32)
 *  over screen + scrollback, plus queued output (UTF-16). Measured heap is
 *  well under this (see the PR notes), so it errs high. */
const estFor = (cols: number, rows: number, pendingBytes: number): number => (rows + SCROLLBACK) * cols * 12 + pendingBytes * 2;
const estBytes = (rec: Rec): number => (rec.term ? estFor(rec.cols, rec.rows, rec.pendingBytes) : 0);

function afterParse(rec: Rec): void {
  rec.lastParsedAt = Date.now();
  if (rec.fault) {
    const f = rec.fault;
    rec.fault = null;
    goOff(rec, f);
    return;
  }
  if (rec.provisional) {
    armProvisional(rec);
  }
  if (rec.settleTimer) {
    clearTimeout(rec.settleTimer);
  }
  rec.settleTimer = setTimeout(() => {
    rec.settleTimer = null;
    try {
      settle(rec);
    } catch {
      goOff(rec, 'internal-error');
    }
  }, SETTLE_AFTER_PARSE_MS);
  rec.settleTimer.unref?.();
}

/** Pty output. Never throws; never awaited; enqueue only (xterm parses on its
 *  own timer, in <= 12ms slices), so viewers are never delayed. */
export function feed(paneid: string, data: string): void {
  try {
    const rec = recs.get(paneid);
    if (!rec) {
      return;
    }
    checkMode();
    const term = rec.term;
    if (!term || rec.off) {
      return;
    }
    if (rec.fault) {
      goOff(rec, rec.fault);
      return;
    }
    const now = Date.now();
    if (rec.quarantine === 0 && rec.pendingTimes.length && now - rec.pendingTimes[0] > LAG_MAX_MS) {
      goOff(rec, 'budget-lag');
      return;
    }
    if (estBytes(rec) + data.length * 2 > BREAKER_BYTES) {
      goOff(rec, 'budget-rss');
      return;
    }
    const gen = rec.gen;
    const len = data.length;
    rec.pendingWrites++;
    rec.pendingBytes += len;
    rec.pendingTimes.push(now);
    rec.lastWriteAt = now;
    term.write(
      data,
      cb(rec, gen, () => {
        rec.pendingWrites--;
        rec.pendingBytes -= len;
        rec.pendingTimes.shift();
        afterParse(rec);
      }),
    );
  } catch {
    fail(paneid, 'feed');
  }
}

function persistSize(rec: Rec): void {
  if (mode !== 'shadow' || rec.save.timer) {
    return; // a trailing write is due; it writes the size current THEN
  }
  const wait = SIZE_WRITE_MIN_MS - (Date.now() - rec.save.lastAt);
  if (wait <= 0) {
    writeSize(rec);
    return;
  }
  rec.save.timer = setTimeout(() => {
    rec.save.timer = null;
    try {
      writeSize(rec);
    } catch {
      /* a failed write leaves the older size; the next resize retries */
    }
  }, wait);
  rec.save.timer.unref?.();
}
function writeSize(rec: Rec): void {
  const at = Date.now();
  rec.save.lastAt = at;
  deps.saveSize(rec.paneid, rec.sizeKnown ? rec.cols : null, rec.sizeKnown ? rec.rows : null, at);
}
function clearSave(rec: Rec): void {
  if (rec.save.timer) {
    clearTimeout(rec.save.timer);
    rec.save.timer = null;
  }
}

function armProvisional(rec: Rec): void {
  if (rec.provTimer) {
    clearTimeout(rec.provTimer);
  }
  rec.provTimer = setTimeout(() => {
    rec.provTimer = null;
    try {
      if (!rec.provisional || !rec.term) {
        return;
      }
      const quietFor = Date.now() - Math.max(rec.lastParsedAt, rec.provisionalSince);
      if (rec.pendingWrites > 0 || quietFor < PROVISIONAL_QUIET_MS - 10) {
        armProvisional(rec);
        return;
      }
      /* 1s of quiet with no redraw marker. After a HEIGHT INCREASE claude
         draws a plain diff, not a reset — so the first settled reading must
         still find the anchor the pre-resize one had, or the pane demotes. */
      rec.provisional = false;
      if (rec.provMeta?.heightUp) {
        rec.demoteCheck = { hadAnchor: rec.provMeta.hadAnchor };
      }
      rec.provMeta = null;
      settle(rec);
    } catch {
      goOff(rec, 'internal-error');
    }
  }, PROVISIONAL_QUIET_MS);
  rec.provTimer.unref?.();
}

/**
 * The engine SENT a resize to this pane's pty (index.ts, after pty.resize).
 * Mirrored only if the pane's broker link socket was open — sendCmd drops a
 * command silently otherwise, and resize is never acknowledged — so a resize
 * issued while the link is down leaves the pane `sizeless`. Applied in STREAM
 * ORDER (a zero-length write's callback), so bytes queued before it parse at
 * the old size; bytes still in flight at the old size are what the
 * provisional window (1s of quiet or a redraw marker) is for.
 */
export function resize(paneid: string, cols: number, rows: number): void {
  try {
    const rec = recs.get(paneid);
    if (!rec || !validSize(cols, rows)) {
      return;
    }
    checkMode();
    if (!deps.linkOpen(rec.link)) {
      if (rec.sizeKnown) {
        rec.sizeKnown = false;
        stop(rec);
        if (mode === 'shadow') {
          push(rec, 'sizeless', { cause: 'resize-while-link-closed' });
          persistSize(rec);
        }
      }
      return;
    }
    const wasKnown = rec.sizeKnown;
    const oldCols = rec.cols;
    const oldRows = rec.rows;
    rec.cols = cols;
    rec.rows = rows;
    rec.sizeKnown = true;
    if (mode !== 'shadow' || rec.off) {
      return;
    }
    if (wasKnown && cols === oldCols && rows === oldRows) {
      return; // no SIGWINCH at the pty, nothing to mirror or persist
    }
    persistSize(rec);
    if (!rec.sig) {
      return;
    }
    if (estFor(cols, rows, rec.pendingBytes) > BREAKER_BYTES) {
      goOff(rec, 'budget-rss');
      return;
    }
    if (!wasKnown || !rec.term) {
      /* SIZELESS RECOVERY: the first trustworthy size. Reset at it and re-seed
         from the engine's replay buffer; `seeded` until a redraw. */
      instantiate(rec);
      reseed(rec, deps.replayOf(paneid) ?? '');
      return;
    }
    const term = rec.term;
    const gen = rec.gen;
    const hadAnchor = rec.classified?.anchored ?? false;
    const heightUp = rows > oldRows;
    term.write(
      '',
      cb(rec, gen, () => {
        term.resize(cols, rows);
        rec.arm = null;
        rec.shape = { ...IDLE_SHAPE };
        rec.provisional = true;
        rec.provisionalSince = Date.now();
        rec.provMeta = { heightUp, hadAnchor };
        armProvisional(rec);
      }),
    );
  } catch {
    fail(paneid, 'resize');
  }
}

/**
 * A broker link's stream had a gap. `close`: every pane on it is `seeded` at
 * once (bytes emitted during the outage never reach us); markers in bytes
 * already queued from before the gap do not count. `open`: reset and re-seed
 * each re-attached pane from the broker's replay tail; still `seeded`.
 */
export function gap(link: string, phase: 'close' | 'open', replayBySid?: Record<string, string>): void {
  for (const rec of recs.values()) {
    try {
      if (rec.link !== link) {
        continue;
      }
      if (phase === 'close') {
        if (rec.term && !rec.off) {
          const gen = rec.gen;
          rec.quarantine++;
          demote(rec);
          rec.term.write('', cb(rec, gen, () => endQuarantine(rec)));
          push(rec, 'gap', { phase });
        }
      } else {
        const replay = replayBySid?.[rec.paneid];
        if (replay !== undefined && rec.term && !rec.off) {
          reseed(rec, replay);
          push(rec, 'gap', { phase });
        }
      }
    } catch {
      goOff(rec, 'internal-error');
    }
  }
}

/** The pane's process ended (sessions.onRemove). */
export function dispose(paneid: string): void {
  try {
    const rec = recs.get(paneid);
    if (!rec) {
      return;
    }
    clearSave(rec);
    stop(rec);
    recs.delete(paneid);
  } catch {
    recs.delete(paneid);
  }
}
sessions.onRemove(dispose);

/* ---- the redraw state machine: PARSE ORDER, via registered handlers ---------- */

const RELATIVE_FINALS = ['A', 'C', 'D', 'E', 'F', 'G', 'a', 'd', 'e', '`'];
function num(ps: Params, i: number, dflt: number): number {
  const v = ps[i];
  const n = typeof v === 'number' ? v : Array.isArray(v) ? v[0] : undefined;
  return n === undefined || n < 0 ? dflt : n;
}
const isHome = (ps: Params): boolean => ps.length <= 2 && ps.every((_, i) => num(ps, i, 0) <= 1);

function viewportBlank(term: Term): boolean {
  const b = term.buffer.active;
  for (let y = 0; y < term.rows; y++) {
    if ((b.getLine(b.baseY + y)?.translateToString(true) ?? '').trim() !== '') {
      return false;
    }
  }
  return true;
}

function marker(rec: Rec, buf: BufName, cause: string): void {
  bump(rec.counts.markers, cause);
  bump(totals.markers, cause);
  if (rec.provisional) {
    rec.provisional = false;
    rec.provMeta = null;
    if (rec.provTimer) {
      clearTimeout(rec.provTimer);
      rec.provTimer = null;
    }
  }
  if (rec.bufSync[buf] === 'synced') {
    return;
  }
  rec.bufSync[buf] = 'synced';
  const now = Date.now();
  if (buf === 'normal') {
    rec.syncedAt = now;
    rec.syncCause = cause;
    rec.recoveryMs = rec.seededAt === null ? null : now - rec.seededAt;
  }
  push(rec, 'sync', { buffer: buf, to: 'synced', cause, ms: rec.seededAt === null ? null : now - rec.seededAt });
}

function wire(rec: Rec, term: Term, gen: number): void {
  const p = term.parser;
  const on =
    (fn: (ps: Params) => void) =>
    (ps: Params): boolean => {
      if (rec.gen === gen) {
        try {
          fn(ps);
        } catch {
          rec.fault ??= 'handler-error';
        }
      }
      return false; // never consume: xterm still runs its own handling
    };
  p.registerCsiHandler({ final: 'H' }, on((ps) => onCup(rec, term, ps)));
  p.registerCsiHandler({ final: 'f' }, on((ps) => onCup(rec, term, ps)));
  p.registerCsiHandler({ final: 'J' }, on((ps) => onEd(rec, term, ps)));
  p.registerCsiHandler({ final: 'K' }, on((ps) => onEl(rec, term, ps)));
  p.registerCsiHandler({ final: 'B' }, on((ps) => onCud(rec, term, ps)));
  for (const final of RELATIVE_FINALS) {
    p.registerCsiHandler({ final }, on(() => onRelative(rec)));
  }
  p.registerCsiHandler({ prefix: '?', final: 'h' }, on((ps) => onMode(rec, ps, true)));
  p.registerCsiHandler({ prefix: '?', final: 'l' }, on((ps) => onMode(rec, ps, false)));
  p.registerEscHandler({ final: 'c' }, () => {
    on(() => onRis(rec))([]);
    return false;
  });
}

/* Handlers run BEFORE xterm's own handling of the same sequence, so the cursor
   they read is where it was when the sequence arrived. */
function onCup(rec: Rec, term: Term, ps: Params): void {
  const live = rec.quarantine === 0;
  const buf = term.buffer.active.type;
  const arm = rec.arm;
  rec.arm = null;
  if (arm && live && arm.buf === buf && viewportBlank(term)) {
    marker(rec, buf, arm.kind === 'ed2' ? 'ed2+cup' : '1049h+cup');
  }
  if (!isHome(ps)) {
    rec.shape = { ...IDLE_SHAPE };
    return;
  }
  if (rec.shape.phase === 'k' && rec.shape.count > 0 && rec.shape.count === term.rows) {
    if (live) {
      marker(rec, buf, 'cc.reset');
    }
    rec.shape = { ...IDLE_SHAPE };
    return;
  }
  rec.shape = { phase: 'k', count: 0 }; // an opening ESC[H
}
function onEd(rec: Rec, term: Term, ps: Params): void {
  rec.shape = { ...IDLE_SHAPE };
  /* ESC[2J only. ESC[3J erases SCROLLBACK and is not a marker (rev-2
     re-score); ESC[J / ESC[1J erase part of the screen and change nothing. */
  if (num(ps, 0, 0) === 2 && rec.quarantine === 0) {
    rec.arm = { buf: term.buffer.active.type, kind: 'ed2' };
  }
}
function onEl(rec: Rec, term: Term, ps: Params): void {
  const s = rec.shape;
  const b = term.buffer.active;
  if (s.phase !== 'k' || num(ps, 0, 0) !== 2 || b.cursorX !== 0 || b.cursorY !== Math.min(s.count, term.rows - 1)) {
    rec.shape = { ...IDLE_SHAPE };
    return;
  }
  rec.shape = { phase: 'b', count: s.count };
}
function onCud(rec: Rec, term: Term, ps: Params): void {
  rec.arm = null; // a relative move
  const s = rec.shape;
  const b = term.buffer.active;
  if (s.phase !== 'b' || num(ps, 0, 0) > 1 || b.cursorX !== 0 || b.cursorY !== Math.min(s.count, term.rows - 1)) {
    rec.shape = { ...IDLE_SHAPE };
    return;
  }
  rec.shape = { phase: 'k', count: s.count + 1 };
}
function onRelative(rec: Rec): void {
  rec.arm = null;
  rec.shape = { ...IDLE_SHAPE };
}
function onMode(rec: Rec, ps: Params, set: boolean): void {
  for (let i = 0; i < ps.length; i++) {
    const m = num(ps, i, -1);
    if (m === 25) {
      rec.cursorVisible = set;
    } else if (m === 1049 || m === 1047 || m === 47) {
      rec.arm = null;
      rec.shape = { ...IDLE_SHAPE };
      if (set) {
        /* Entering the alternate buffer: its content is unknown until a
           ?1049h (which clears it) is followed by an absolute CUP. Leaving it
           needs nothing: sync is tracked PER BUFFER, so a normal buffer that
           was never synced is still `seeded` when it comes back. */
        rec.bufSync.alternate = 'seeded';
        if (m === 1049 && rec.quarantine === 0) {
          rec.arm = { buf: 'alternate', kind: 'alt1049' };
        }
      }
    }
  }
}
function onRis(rec: Rec): void {
  rec.cursorVisible = true;
  rec.arm = null;
  rec.shape = { ...IDLE_SHAPE };
  if (rec.quarantine === 0) {
    marker(rec, 'alternate', 'ris');
    marker(rec, 'normal', 'ris');
  }
}

/* ---- settle-point readings -------------------------------------------------- */

function viewOf(rec: Rec, term: Term): ScreenView {
  const b = term.buffer.active;
  const rows = term.rows;
  const cols = term.cols;
  const n = Math.min(rows, VIEW_ROWS);
  let start = rows - n;
  if (b.cursorY < start) {
    start = Math.max(0, Math.min(rows - n, b.cursorY - (n >> 1)));
  }
  const cell = b.getNullCell();
  const lines: ViewRow[] = [];
  for (let y = start; y < start + n; y++) {
    const line = b.getLine(b.baseY + y);
    const chars: string[] = new Array(cols).fill('');
    const attrs = new Uint8Array(cols);
    if (line) {
      for (let x = 0; x < cols; x++) {
        const c = line.getCell(x, cell);
        if (!c) {
          continue;
        }
        chars[x] = c.getChars();
        attrs[x] = (c.isDim() ? DIM : 0) | (c.isInverse() ? INVERSE : 0) | (c.isBold() ? BOLD : 0);
      }
    }
    lines.push({ chars, attrs });
  }
  return { cols, rows: n, buffer: b.type, cursorX: b.cursorX, cursorY: b.cursorY - start, cursorVisible: rec.cursorVisible, lines };
}

function paneSync(rec: Rec): SyncState {
  if (rec.off || mode !== 'shadow') {
    return 'off';
  }
  if (!rec.sizeKnown) {
    return 'sizeless';
  }
  if (!rec.term) {
    return 'off';
  }
  return rec.bufSync[rec.term.buffer.active.type];
}

function isPending(rec: Rec): boolean {
  return rec.pendingWrites > 0 || rec.settleTimer !== null;
}

/** Gate the last classification by the pane's CURRENT sync state. */
function currentReading(rec: Rec): ScreenReading {
  const sync = paneSync(rec);
  const cls = rec.sig ? rec.classified : GENERIC;
  const base = { sync, pending: isPending(rec), at: rec.classifiedAt, parsedAt: rec.lastParsedAt, boxChangedAt: rec.boxChangedAt };
  const gated = (evidence: Evidence): ScreenReading => ({ ...base, composer: 'unknown', surface: 'unknown', evidence, background: null });
  if (!rec.sig) {
    return gated('generic');
  }
  if (sync === 'off') {
    return gated('sync.off');
  }
  if (sync === 'sizeless') {
    return gated('sync.sizeless');
  }
  if (sync === 'seeded') {
    return gated('sync.seeded');
  }
  if (rec.provisional) {
    return gated('resize.provisional');
  }
  if (!cls) {
    return gated('sync.seeded'); // nothing classified yet since the terminal began
  }
  return { ...base, composer: cls.composer, surface: cls.surface, evidence: cls.evidence, background: rec.bg };
}

function settle(rec: Rec): void {
  const term = rec.term;
  if (!term || rec.off || !rec.sig) {
    return;
  }
  if (rec.pendingWrites > 0) {
    return; // a later parse reschedules
  }
  if (rec.settleTimer) {
    clearTimeout(rec.settleTimer);
    rec.settleTimer = null;
  }
  const now = Date.now();
  const view = viewOf(rec, term);
  const cls = rec.sig.classify(view);
  rec.classified = cls;
  rec.classifiedAt = now;
  const rowsText = view.lines.map((l) => l.chars.join('').trimEnd());
  rec.bg = backgroundWork(rowsText);
  rec.cp = matchCliPrompt(rowsText);
  rec.shell = rec.cp === null && looksLikeShellPrompt(rowsText);
  rec.signInLink = rec.cp === 'login' ? extractSignInLink(rowsText, view.cols) : null;
  if (cls.surface === 'composer') {
    rec.clearedOnce = true;
  }
  if (cls.boxHash !== null && cls.boxHash !== rec.boxHash) {
    rec.boxHash = cls.boxHash;
    rec.boxChangedAt = now;
  }
  if (rec.demoteCheck) {
    const dc = rec.demoteCheck;
    rec.demoteCheck = null;
    if (dc.hadAnchor && !cls.anchored && paneSync(rec) === 'synced') {
      demote(rec);
      push(rec, 'resize-demote', { evidence: cls.evidence });
    }
  }
  const r = currentReading(rec);
  rec.counts.readings++;
  bump(rec.counts.byEvidence, r.evidence);
  /* The anchor-rate exit metric (spec §7): settled, synced, idle claude panes. */
  if (r.sync === 'synced' && !rec.provisional && activity.get(rec.paneid) === 'idle') {
    rec.counts.idleSynced++;
    totals.idleSynced++;
    bump(totals.idleByEvidence, cls.evidence);
    if (cls.anchored) {
      rec.counts.anchored++;
      totals.anchored++;
    }
  }
  evaluate(rec, now, 'settle');
}

/* ---- the shadow comparison ----------------------------------------------------- */

function combineFor(rec: Rec, now: number): { r: ScreenReading; dv: activity.DraftView; c: Combined } {
  const r = currentReading(rec);
  const dv = activity.draftView(rec.paneid);
  const c = combineDraft({
    screen: { composer: r.composer, sync: r.sync, pending: r.pending, provisional: rec.provisional, parsedAt: r.parsedAt, boxChangedAt: r.boxChangedAt },
    input: { state: dv.state, certain: dv.certain, uncertain: dv.uncertain },
    lastInputAt: dv.lastInputAt,
    lastGrowAt: dv.lastGrowAt,
    now,
    echoMs: echoMs(),
    settleMs: settleMs(),
    authority: ['draft'],
  });
  return { r, dv, c };
}

/**
 * Compare the screen with the input guard and LOG it — nothing else. Edge-
 * triggered per pane (an entry when the comparison changes), counted always.
 * Transient states (writes pending, echo not settled) are not evaluated.
 */
function evaluate(rec: Rec, now: number, trigger: string): void {
  if (mode !== 'shadow' || !rec.sig || !rec.term || rec.off) {
    return;
  }
  const { r, dv, c } = combineFor(rec, now);
  if (r.pending || !c.echoSettled) {
    return;
  }
  let kind: CompareKind;
  if (now < rec.injectUntil) {
    kind = 'engine-inject';
  } else if (!c.fresh || r.composer === 'unknown') {
    kind = 'screen-unknown';
  } else if (r.composer === 'draft' && dv.state !== 'draft') {
    kind = 'screen-draft/input-clean';
  } else if (r.composer === 'clean' && dv.state === 'draft') {
    kind = 'screen-clean/input-draft';
  } else {
    kind = 'agree';
  }
  bump(rec.counts.evals, kind);
  bump(totals.evals, kind);
  if (kind === 'screen-unknown') {
    bump(totals.unknownByEvidence, r.evidence);
  }
  const key = [kind, r.composer, dv.state, dv.certain, r.evidence, r.sync].join('|');
  if (key === rec.lastKey) {
    return;
  }
  rec.lastKey = key;
  if (kind === 'agree') {
    return;
  }
  push(rec, kind, {
    trigger,
    screen: r.composer,
    input: dv.state,
    inputCertain: dv.certain,
    inputUncertain: dv.uncertain,
    evidence: r.evidence,
    sync: r.sync,
    fresh: c.fresh,
    boxMoved: c.boxMoved,
    row: c.row,
    p1: c.result,
    readingAgeMs: now - r.at,
    msSinceInput: dv.lastInputAt === null ? null : now - dv.lastInputAt,
  });
}

/** A human's input reached the pty (index.ts, after activity.onInput). Only
 *  schedules re-evaluations at +ECHO_MS and +settleMs: a keystroke followed by
 *  silence must still get a comparison. */
export function onInput(paneid: string): void {
  try {
    const rec = recs.get(paneid);
    if (!rec || !rec.term || !rec.sig || rec.off) {
      return;
    }
    for (const t of rec.inputTimers) {
      clearTimeout(t);
    }
    rec.inputTimers = [echoMs() + 5, settleMs() + 5].map((ms) => {
      const t = setTimeout(() => {
        try {
          evaluate(rec, Date.now(), 'input-timer');
        } catch {
          goOff(rec, 'internal-error');
        }
      }, ms);
      t.unref?.();
      return t;
    });
  } catch {
    fail(paneid, 'onInput');
  }
}

/**
 * The ENGINE typed into this pane (room-typer or voice, told after the text
 * write). If a fresh screen showed a draft, that is exactly what P1 would
 * have held: one text-free log line and a `typed-into-draft` entry. Then an
 * inject window (text write -> Enter + ECHO_MS) so the engine's own echo is
 * tagged `engine-inject`, never counted as a disagreement.
 */
export function noteInject(paneid: string, source: string): void {
  try {
    const rec = recs.get(paneid);
    if (!rec || mode !== 'shadow' || !rec.sig || !rec.term || rec.off) {
      return;
    }
    const now = Date.now();
    const { r, dv, c } = combineFor(rec, now);
    if (c.fresh && r.composer === 'draft') {
      totals.typedIntoDraft++;
      push(rec, 'typed-into-draft', {
        source,
        evidence: r.evidence,
        sync: r.sync,
        input: dv.state,
        inputCertain: dv.certain,
        readingAgeMs: now - r.at,
      });
      say(`vscreen: ${paneid} ${source} typed a line while the screen showed a draft (P1 would have held it) — evidence=${r.evidence} input=${dv.state}`);
    }
    rec.injectUntil = now + enterDelayMs() + echoMs() + INJECT_SLACK_MS;
  } catch {
    fail(paneid, 'noteInject');
  }
}

/* ---- read surface (P1 consumers; P0: diag only) ------------------------------- */

/** The pane's reading, or null when it has no record. `pending` readings must
 *  be read as `unknown` by any consumer. */
export function reading(paneid: string): ScreenReading | null {
  try {
    const rec = recs.get(paneid);
    return rec ? currentReading(rec) : null;
  } catch {
    return null;
  }
}

/* ---- the CLI prompt (the design notes) -------------------------- */

export type CliPromptReason = 'starting' | 'no-screen' | 'not-synced' | 'unmatched';
export interface CliPromptReading {
  /** a known first-run prompt, 'unknown' (see `reason`), or null = startup has cleared this launch. */
  prompt: CliPromptName | 'unknown' | 'shell' | null;
  /** null for a name and for null. 'unknown' always carries one: starting/no-screen/not-synced mean "cannot tell yet" (NOT a claim that a
   *  prompt is up); only 'unmatched' says a dialog we do not know has held the screen past the deadline. */
  reason: CliPromptReason | null;
}
/** Seconds a launch may sit at a bare shell prompt before it is called a shell (the typed vendor line may be about to run). */
const shellPromptMs = (): number => {
  const v = Number(process.env.HARBOR_WB_SHELL_PROMPT_S);
  return (Number.isFinite(v) && v >= 0 && process.env.HARBOR_WB_SHELL_PROMPT_S !== undefined && process.env.HARBOR_WB_SHELL_PROMPT_S !== '' ? v : 8) * 1000;
};

/** The sign-in URL the pane's login prompt is showing right now, or null. The caller must treat it as a credential-adjacent secret: return it
 *  only over an authenticated route, never log it, never put it in a room line or a table row. */
export function signInLinkOf(paneid: string): string | null {
  try {
    const rec = recs.get(paneid);
    return rec && rec.cp === 'login' ? rec.signInLink : null;
  } catch {
    return null;
  }
}

/** Seconds a launch may show an unrecognised screen before it is reported as an unmatched prompt. */
const promptUnknownMs = (): number => {
  const v = Number(process.env.HARBOR_WB_PROMPT_UNKNOWN_S);
  return (Number.isFinite(v) && v >= 0 && process.env.HARBOR_WB_PROMPT_UNKNOWN_S !== undefined && process.env.HARBOR_WB_PROMPT_UNKNOWN_S !== '' ? v : 20) * 1000;
};

/** What the pane's screen says about a first-run prompt, or null when the pane has no record at all (the caller says 'no-screen'). Three
 *  outcomes, never two: a name, "startup has cleared" (null), and "cannot tell" ('unknown' with a reason). */
export function cliPromptOf(paneid: string, now = Date.now()): CliPromptReading | null {
  try {
    const rec = recs.get(paneid);
    if (!rec) {
      return null;
    }
    const r = currentReading(rec);
    if (r.evidence === 'generic' || r.evidence === 'sync.off' || r.evidence === 'sync.sizeless') {
      return { prompt: 'unknown', reason: 'no-screen' };
    }
    if (r.evidence === 'sync.seeded' || r.evidence === 'resize.provisional') {
      return { prompt: 'unknown', reason: 'not-synced' };
    }
    if (r.surface === 'composer') {
      return { prompt: null, reason: null };
    }
    if (rec.cp) {
      return { prompt: rec.cp, reason: null };
    }
    if (rec.clearedOnce) {
      return { prompt: null, reason: null }; // startup is past: an ordinary dialog now is a permission prompt, not a first-run one
    }
    const age = now - rec.createdAt;
    /* A BARE SHELL: the seat's terminal is a plain shell and the typed vendor line did not leave an agent running. Not "unknown", not an agent waiting. It is claimed only
       after a short grace (the typed line may be about to run), well before the 20 s unknown deadline. */
    if (rec.shell && age >= shellPromptMs()) {
      return { prompt: 'shell', reason: null };
    }
    return { prompt: 'unknown', reason: age < promptUnknownMs() || rec.shell ? 'starting' : 'unmatched' };
  } catch {
    return null;
  }
}

/** States, codes, counts and timings per pane, plus the bounded log. NEVER
 *  text. `GET /api/diag/vscreen[?paneid=]`. */
export function diag(paneid?: string): Record<string, unknown> {
  try {
    checkMode();
    const now = Date.now();
    const panes: Record<string, unknown> = {};
    let est = 0;
    let terminals = 0;
    for (const [id, rec] of recs) {
      est += estBytes(rec);
      if (rec.term) {
        terminals++;
      }
      if (paneid && id !== paneid) {
        continue;
      }
      const r = currentReading(rec);
      panes[id] = {
        vendor: rec.vendor,
        hostKind: rec.hostKind,
        link: rec.link,
        signature: rec.sig ? { verified: rec.sig.verified } : null,
        cols: rec.cols,
        rows: rec.rows,
        sizeKnown: rec.sizeKnown,
        sync: paneSync(rec),
        buffers: { ...rec.bufSync },
        active: rec.term?.buffer.active.type ?? null,
        provisional: rec.provisional,
        off: rec.off,
        reading: { composer: r.composer, surface: r.surface, evidence: r.evidence, pending: r.pending, at: r.at, parsedAt: r.parsedAt, boxChangedAt: r.boxChangedAt },
        seededAt: rec.seededAt,
        syncedAt: rec.syncedAt,
        syncCause: rec.syncCause,
        recoveryMs: rec.recoveryMs,
        seededForMs: paneSync(rec) === 'seeded' && rec.seededAt !== null ? now - rec.seededAt : null,
        lastWriteAt: rec.lastWriteAt,
        lastParsedAt: rec.lastParsedAt,
        lagMs: rec.pendingTimes.length ? now - rec.pendingTimes[0] : 0,
        pendingWrites: rec.pendingWrites,
        pendingBytes: rec.pendingBytes,
        estBytes: estBytes(rec),
        counts: rec.counts,
      };
    }
    const log: Record<string, LogEntry[]> = {};
    for (const [kind, arr] of logs) {
      while (arr.length && now - arr[0].at > LOG_MAX_AGE_MS) {
        arr.shift();
      }
      log[kind] = paneid ? arr.filter((e) => e.paneid === paneid) : arr.slice();
    }
    return {
      mode,
      modeSource,
      parseGuard,
      signatures: SIGNATURES.map((s) => ({ vendor: s.vendor, hostKind: s.hostKind, verified: s.verified, verifiedOn: s.verifiedOn })),
      tuning: {
        scrollback: SCROLLBACK,
        viewRows: VIEW_ROWS,
        settleAfterParseMs: SETTLE_AFTER_PARSE_MS,
        provisionalQuietMs: PROVISIONAL_QUIET_MS,
        lagMaxMs: LAG_MAX_MS,
        echoMs: echoMs(),
        settleMs: settleMs(),
        logMaxPerKind: LOG_MAX_PER_KIND,
        logMaxAgeMs: LOG_MAX_AGE_MS,
      },
      budget: {
        panes: recs.size,
        terminals,
        estBytes: est,
        perPaneBudgetBytes: PANE_BUDGET_BYTES,
        breakerBytes: BREAKER_BYTES,
        processRssBytes: process.memoryUsage().rss,
      },
      totals: {
        ...totals,
        anchorRate: totals.idleSynced ? totals.anchored / totals.idleSynced : null,
      },
      panes,
      log,
    };
  } catch {
    return { error: 'vscreen diag failed' };
  }
}

/* ---- tests only ------------------------------------------------------------------- */

/** Wait until everything queued for the pane is parsed, then settle NOW. */
export function _settle(paneid: string): Promise<void> {
  return new Promise((resolve) => {
    const rec = recs.get(paneid);
    const term = rec?.term;
    if (!rec || !term) {
      resolve();
      return;
    }
    const gen = rec.gen;
    term.write('', () => {
      setImmediate(() => {
        try {
          if (rec.gen === gen && rec.pendingWrites === 0) {
            settle(rec);
          }
        } finally {
          resolve();
        }
      });
    });
  });
}
export function _terminal(paneid: string): Term | null {
  return recs.get(paneid)?.term ?? null;
}
export function _setConfigPath(p: string): void {
  configPath = p;
  cfgMtime = -1;
  cfgMode = null;
}
export function _refreshMode(): Mode {
  checkMode(true);
  return mode;
}
export function _reset(): void {
  for (const id of [...recs.keys()]) {
    dispose(id);
  }
  logs.clear();
  totals.evals = {};
  totals.unknownByEvidence = {};
  totals.idleSynced = 0;
  totals.anchored = 0;
  totals.idleByEvidence = {};
  totals.off = {};
  totals.markers = {};
  totals.typedIntoDraft = 0;
}
