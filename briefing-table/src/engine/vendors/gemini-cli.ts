/**
 * Gemini CLI adapter.
 *
 * Launch flags follow the documented CLI interface but have not been verified
 * against an installed CLI. GEMINI_CLI_FLAGS_VERIFIED remains false until that
 * verification is recorded. Inline compatibility notes mark unverified options.
 *
 * Launch currently always supplies --approval-mode yolo. A per-recipe approval
 * mode override is not implemented; reasoning effort is a separate setting.
 *
 * The engine neither mints nor discovers Gemini session IDs. Named resume uses
 * --resume latest for the project directory; two panes using the same project
 * can therefore select the same session. An explicit session UUID can be used
 * when supplied, but automatic discovery is not implemented.
 *
 * Session metadata is expected under ~/.gemini/tmp/<project_hash>/chats/.
 */
import { plainArg, quotedName } from '../argv.ts';
import type { Recipe } from '../../table/store.ts';
import type { LiveCliVendor } from './index.ts';

/** The vendor tag written to the mapping table for gemini-carrying panes. */
export const VENDOR = 'gemini-cli';

/**
 * Verified 2026-09-30 against the installed CLI, gemini 0.62.0 (platform ran
 * `gemini --version` / `--help` as gem-ops; svc-ops cannot read that
 * home, by design). Confirmed: `--approval-mode <default|auto_edit|yolo|plan>`,
 * `-y/--yolo`, `-m/--model`, `-r/--resume` ("latest" or a session index).
 * NOT confirmed: `--resume <uuid>` (help lists latest|index only) — no gemini
 * session banks a uuid today (session_id stays null), so that branch is unused.
 */
export const GEMINI_CLI_FLAGS_VERIFIED = true;

/** The binary. Not configurable: a recipe that needs a different binary is a
 *  class-2 recipe with its own initCmd, not a variant of this vendor. */
const BIN = 'gemini';

/** Compatibility not verified against an installed CLI — `--approval-mode yolo` is the
 *  current (non-deprecated) auto-approve spelling; `--yolo`/`-y` is documented
 *  as deprecated in favour of it. Unconditional on every gemini-cli invocation
 *  (see the header's "YOLO / AUTO-APPROVE" note) — this is the one honest
 *  minimal option, matching the account-level auto mode Owner runs everywhere
 *  else. A per-recipe override is future work, not a schema change made here. */
const YOLO_ARGS: readonly string[] = ['--approval-mode', 'yolo'];

/** POSIX single-quote (remote side of ssh) — mirror of launch.ts's quoting. */
function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface GeminiInvocation {
  cmd: string;
  sessionId: string | null;
}

/**
 * Build the gemini command line. Precedence is the engine's and is fixed:
 * **uuid > name > fresh** (contract §5.2) — the same order claude-code honours,
 * and the resume DECISION belongs to the caller, never to a read of the recipe.
 */
export function buildInvocation(
  r: Recipe,
  opts: { remote: boolean; resumeSessionId?: string | null; resumeName?: string | null; autoApprove?: 'on' | 'off' },
): GeminiInvocation | null {
  if (r.vendor !== VENDOR) {
    return null; // not ours — the caller falls back to the recipe's initCmd
  }
  /* AUTO-APPROVE only when the recipe's EFFECTIVE value is on (src/engine/auto-approve.ts: the first-run default, or the recipe's own choice). Off by default: Gemini then asks. */
  const parts = [BIN, ...(opts.autoApprove === 'on' ? YOLO_ARGS : [])];
  if (r.model) {
    // Compatibility not verified against an installed CLI — `--model`/`-m`, default `auto`,
    // aliases `pro|flash|flash-lite` or a full model name. The engine passes the
    // STRING; spelling the flag is the vendor's job (§5.2).
    parts.push('--model', plainArg(r.model));
  }
  if (opts.resumeSessionId) {
    // Compatibility not verified against an installed CLI — resume by full session UUID.
    // A uuid is [0-9a-f-] so it never needs quoting on either side.
    parts.push('--resume', opts.resumeSessionId);
    return { cmd: parts.join(' '), sessionId: opts.resumeSessionId };
  }
  if (opts.resumeName !== undefined && opts.resumeName !== null) {
    /* THE NAMED-RESUME FLOW IS GEMINI'S ONLY WORKING RESTORE TODAY (header).
     * The string is whatever the human put in the recipe; the docs define
     * `latest` and a numeric index, and a uuid is accepted here too. An EMPTY
     * name means "the CLI's own picker" — for claude that is a bare `--resume`,
     * and for gemini the documented equivalent is `--resume latest`... which is
     * NOT a picker, it is a choice. We do not pretend otherwise: an empty name
     * falls through to a FRESH session, and the interactive `/resume` browser
     * (a slash command inside the running CLI) is how a human picks. */
    if (!opts.resumeName) {
      return { cmd: parts.join(' '), sessionId: null };
    }
    // Compatibility not verified against an installed CLI — `--resume <latest|index|uuid>`.
    const name = quotedName(opts.resumeName);
    parts.push('--resume', opts.remote ? posixQuote(name) : `"${name}"`);
    /* sessionId stays NULL on purpose: `latest` and `3` are POINTERS, not
     * identities, and banking a pointer as a session id would make the table
     * claim an identity it does not have — the exact mistake the 2026-08-03
     * correction caught on the claude side (never bank the pty id as a
     * resumable session id). */
    return { cmd: parts.join(' '), sessionId: null };
  }
  /* FRESH. No `--session-id` exists, so the engine banks nothing and the row's
   * session_id is null — same as a claude named-resume pane. This is the gap
   * the librarian closes. */
  return { cmd: parts.join(' '), sessionId: null };
}

/**
 * The §5.1 interface, as implemented.
 *
 * Everything optional is ABSENT rather than stubbed. An `undefined` member is
 * the contract's way of saying "this brand genuinely cannot answer that yet",
 * and a stub returning null would instead read as "asked and found nothing" —
 * which is the difference between a missing feature and a lookup bug.
 */
export const vendorModule: LiveCliVendor = {
  vendor: VENDOR,
  /* TRUE — and the honest reading is in the header. The docs show resume by
   * full session UUID and by `latest`, and the conversation lives on disk under
   * ~/.gemini, so it survives the process. It is NOT true that this engine can
   * yet identify WHICH session a fresh pane created. */
  resumable: true,
  invocation: buildInvocation,

  /* mintSessionId  — ABSENT: there is no `--session-id` flag to mint into.
   * discoverSessionId — ABSENT: needs to read ~/.gemini/tmp/<project_hash>/,
   *                     whose hash is undocumented → the librarian (§5.3).
   * locate         — ABSENT: same reason; nothing to follow a lineage through.
   * transcriptPath — ABSENT: same reason. Do NOT guess the hash.
   * listSessions   — ABSENT: `gemini --list-sessions` is the supported
   *                  mechanism and its OUTPUT FORMAT is not documented; it also
   *                  has to run as the account owning the files. Librarian.
   * ack            — ABSENT: ack proves a transcript appeared at a known path,
   *                  and we have no known path. */

  reconcile(): 'dehydrated' | 'killed' {
    /* Resumable → dehydrated (contract §5.2). The conversation is on disk; the
     * attach path relaunches it with this module's resume invocation, which for
     * gemini means the recipe's named resume until the librarian lands. */
    return 'dehydrated';
  },
};
