/**
 * THE VENDOR SEAM, AS A TYPE (contract §5.1) — and the registry that routes to it.
 *
 * Until now `src/engine/vendors/claude-code.ts` WAS the interface: its exported
 * function names were the contract, and every caller imported the module by
 * name. That works for exactly one vendor. The contract (v0.3 §5.1) wrote the
 * module's surface out as a type so a second brand has something to IMPLEMENT
 * rather than a module to imitate; this file is that type, verbatim, plus the
 * lookup that replaces `import * as claudeCode` at the call sites that were
 * really asking "what does THIS session's brand do here".
 *
 * WHAT A VENDOR DOES *NOT* OWN, and this is the v0.3 correction that matters:
 * the spawn DESCRIPTOR is the engine's (`launch.ts`). Local shell vs
 * `ssh -t <alias>` vs a broker-resident spawn, POSIX quoting, the `-lic`
 * wrapper and the Windows `ssh.exe` rule are facts about the HOST, not about
 * the brand. A vendor supplies a COMMAND LINE and nothing about how a shell is
 * reached. Keeping that line is what let phases 1-5 move every session onto
 * brokers without touching a vendor module.
 *
 * TWO THIRDS OF THE INTERFACE IS OPTIONAL. A brand that cannot bring a dead
 * conversation back is taxonomy class 2 (`the design notes`) and needs
 * NO module at all — `vendorFor()` returning `undefined` is a supported answer
 * and means "launch it as a generic CLI from the recipe's initCmd". Only
 * RESUMABILITY buys the rest of this file.
 */
import type { Recipe } from '../../table/store.ts';
import * as claudeCode from './claude-code.ts';
import * as geminiCli from './gemini-cli.ts';
import * as codexCli from './codex-cli.ts';

/** What `listSessions` answers with — the manager's resume picker and every
 *  session TITLE are built from this shape. Contract §5.1, verbatim. */
export interface SessionListing {
  sessionId: string;
  title: string | null; // explicit rename > auto title
  lastPrompt: string | null; // context subtitle
  firstCommand: string | null; // label fallback for sessions with no prose
  mtimeMs: number;
  sizeBytes: number; // a proxy for how much history is in there
  branch: string | null; // last git branch recorded, if the format has one
}

/** Per-brand typing behavior for room-typer (Owner 2026-10-05). */
export interface TypingSpec {
  /** Wrap the text in ESC[200~ ... ESC[201~ so the TUI takes it as ONE paste
   *  (no burst heuristics, newlines stay newlines). */
  bracketedPaste: boolean;
  /** Pause between the text and Enter, ms (env-overridable by the typer). */
  enterDelayMs: number;
  /** After Enter, wait this long for a turn to start; none = the composer
   *  still holds the line: press Enter once more, then hold (never stack). */
  submitCheckMs: number;
  /** The key that submits the composer (default Enter). Codex: Tab, which
   *  submits at an idle prompt and QUEUES the line while a turn runs. */
  submitKey?: string;
  /** The CLI keeps a line typed mid-turn and submits it when the turn ends
   *  (live-proven for Codex 2026-10-06, video-to-3d r20), so the typer need
   *  not wait for idle — only for a draft, a dialog or startup. */
  queuesWhileBusy?: boolean;
  /** A queueing CLI's key that submits INTO the running turn (steer) instead of
   *  queueing for the next one. Codex: Enter. Used only for control lines (a
   *  stop, the answer to the pane's own ask; room-typer isControl), behind the
   *  agentComms switch codexSteerControl. Absent = no steer path. */
  steerKey?: string;
}

/** Everything brand-specific about running a CLI in a pane. The engine owns
 *  the spawn descriptor, the pty, the table, the rings and the window; a
 *  vendor owns invocation, resume, identity-on-disk and attention. */
/** [codex target] What a target (targets.json) says about ONE vendor on it: a wrapper the
 *  vendor's binary runs through (`launcher`, e.g. an env-loading script) and shared default
 *  arguments (`args`). Only the vendor named by the target's key sees it. */
export interface VendorTargetConfig {
  launcher?: string;
  args?: string[];
  /** [codex update] A pre-launch helper (path, optionally one `--flag`) run before the vendor's
   *  binary, as the seat's account: it may print a PATH dir to prepend (a retained known-good
   *  executable). Used for Codex's update-on-launch (ticket). */
  preLaunch?: string;
}

export interface LiveCliVendor {
  /** The value written to `sessions.vendor` and `recipes.vendor`. See §1.1. */
  readonly vendor: string;

  /** Can a dead session come back WITH ITS CONVERSATION? If false, every
   *  member below marked optional is genuinely absent and you are class 2. */
  readonly resumable: boolean;

  /** REQUIRED. The command line this session runs, and the session id the
   *  engine may bank. Returns null when this recipe does not run your CLI. */
  invocation(
    recipe: Recipe,
    opts: { remote: boolean; resumeSessionId?: string | null; resumeName?: string | null; target?: VendorTargetConfig; autoApprove?: 'on' | 'off' },
  ): { cmd: string; sessionId: string | null } | null;

  /** Optional (resumable only). Mint an id the engine passes IN at launch. */
  mintSessionId?(): string;

  /** Optional (resumable only). Discover the id of the session that just
   *  started, when your CLI will not accept one. Answered by the librarian. */
  discoverSessionId?(opts: {
    projectDir: string;
    sshAlias?: string;
    agentHost?: string;
    sinceMs?: number;
  }): Promise<string | null>;

  /** Optional (resumable only). Follow a banked id to its CURRENT incarnation
   *  before a restore. Answered by the librarian (§5.3). */
  locate?(opts: {
    banked: string;
    projectDir: string;
    sshAlias?: string;
    /** WINDOW-AGENT transport (2026-09-18, contract §5b `fs.*`): the host whose
     *  desktop agent reads the transcripts, for a host the engine can reach a
     *  desktop on but not an ssh account. Set by `fsOptsFor`, never beside
     *  `sshAlias`. A vendor that cannot use it ignores it — it is additive. */
    agentHost?: string;
    timeoutMs?: number;
  }): Promise<string | null>;

  /** Optional. Where this session's history lives, for titles and adoption. */
  transcriptPath?(projectDir: string, sessionId: string): string;

  /** Optional. Past sessions for a project dir, with human labels — this is
   *  what fills the manager's resume picker and every session TITLE. */
  listSessions?(opts: {
    projectDir: string;
    sshAlias?: string;
    /** See `locate`'s `agentHost`. */
    agentHost?: string;
    limit?: number;
    timeoutMs?: number;
  }): Promise<SessionListing[]>;

  /** Optional. Proof the launch actually landed (vs dying in the shell). */
  ack?(
    projectDir: string,
    sessionId: string,
    timeoutMs?: number,
    pollMs?: number,
  ): Promise<boolean>;

  /** Optional. How the room typer writes a line into THIS brand's composer
   *  (absent = claude's way: raw text, then Enter a beat later). */
  readonly typing?: TypingSpec;

  /** REQUIRED. What a stale `live` row becomes when the engine restarts
   *  without this session. `resumable` decides it; see §5.2. */
  reconcile(): 'dehydrated' | 'killed';
}

/* THE REGISTRY.
 *
 * Keyed by the enum value, because that is what a recipe row and a session row
 * both carry. A vendor value with no entry here is NOT an error — it is class
 * 2, and the engine launches it from the recipe's initCmd like any other
 * shell. `ollama` is exactly that today: an accepted value with
 * no module yet (contract §1.1 step 2: "if it cannot resume, it needs no
 * vendor module at all — the value buys only a label"). */
const REGISTRY: Record<string, LiveCliVendor> = {
  [claudeCode.vendorModule.vendor]: claudeCode.vendorModule,
  [geminiCli.vendorModule.vendor]: geminiCli.vendorModule,
  [codexCli.vendorModule.vendor]: codexCli.vendorModule,
};

/** The brand module for a vendor value, or undefined = "generic CLI, class 2". */
export function vendorFor(vendor: string | null | undefined): LiveCliVendor | undefined {
  return vendor ? REGISTRY[vendor] : undefined;
}

/** Every vendor value that has a module. Not the same as the recipe ENUM —
 *  the enum is wider on purpose (a label with no module is legal). */
export function vendorsWithModules(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * ONE SOURCE OF TRUTH FOR "CAN THIS COME BACK" (contract §1.1, the hazard
 * recorded for whoever adds vendor #2).
 *
 * The rule used to exist TWICE: `claudeCode.isResumable` in end-state.ts and,
 * independently, as the literal `vendor='claude-code'` in the boot-reconcile
 * SQL (`store.reconcileStaleLive`). Two copies of a rule whose failure mode is
 * a silently-lost conversation. Both now derive from the modules' own
 * `resumable` flag, which is where the contract puts the answer.
 */
export function isResumableVendor(vendor: string | null | undefined): boolean {
  return vendorFor(vendor)?.resumable === true;
}

/** The vendor values whose stale `live` rows reconcile to `dehydrated`. Used
 *  by the boot sweep to build its SQL, so the list can never drift from the
 *  modules. Sorted for a stable SQL string (readable logs, stable tests). */
export function resumableVendors(): string[] {
  return Object.values(REGISTRY)
    .filter((v) => v.resumable)
    .map((v) => v.vendor)
    .sort();
}
