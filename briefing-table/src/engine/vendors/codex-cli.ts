/**
 * codex-cli vendor mechanics — VENDOR #3 (contract §1.1 row 3, §5, Appendix A).
 * Built 2026-10-03 on Owner's go ("Codex vendor"), from LIVE-TESTED facts on
 * codex-cli 0.160.0 (Linux, account chat-ops; KB design-notes-id, Codex's
 * own answers KB design-notes-id / design-notes-id). No flag below is a
 * docs-only guess EXCEPT the one marked UNVERIFIED in "OVERRIDE RULE".
 *
 * WHAT IS DIFFERENT FROM claude-code, and it shapes the module:
 *
 *  - THE SESSION ID CANNOT BE CHOSEN AT LAUNCH (no `--session-id`). A fresh
 *    pane banks `session_id: null`; the id arrives in the FIRST HOOK (every
 *    Codex hook payload carries `session_id`) at `POST /api/agent-hook`, which
 *    banks it on the row (src/server/agent-hook.ts). From then on
 *    `codex resume <id>` keeps the same id. So this vendor is "DISCOVERED",
 *    not "minted" (§5.2) — and the discovery is by PUSH (the hook), never by
 *    scraping the rollout files: those live in the pane account's home
 *    (`~/.codex/sessions/...`, chat-ops), which the engine's account cannot
 *    read, and their format is Codex-internal. Hence `transcriptPath`,
 *    `listSessions`, `locate`, `discoverSessionId` and `ack` are ABSENT.
 *  - EVERY DIALOG IS PRE-ANSWERED BY FLAG, NEVER BY KEYSTROKE. The folder-trust
 *    dialog is pre-trusted per launch (`-c projects."<dir>".trust_level=...`,
 *    one exact path, Codex accepts no globs) and the "Hooks need review"
 *    dialog is bypassed with `--dangerously-bypass-hook-trust`. The bypass is
 *    only sound because THE ENGINE WRITES AND OWNS the hooks file it covers
 *    (src/engine/codex-hooks.ts) — it must never be added to a launch whose
 *    hooks file we did not vet.
 *  - THERE IS NO `--effort` FLAG: the level rides
 *    `-c model_reasoning_effort="<level>"`. The vocabulary lives in effort.ts
 *    (`CODEX_EFFORTS`); the MODEL decides which levels it really supports and
 *    Codex rejects the rest, so the engine guards spelling only.
 *  - `--no-alt-screen` keeps scrollback (and the engine's screen replay) sane.
 *
 * OVERRIDE RULE (alpha-platform, via the lead, 2026-10-03): the defaults are
 * `-c sandbox_mode="workspace-write"` and `-c approval_policy="on-request"`,
 * emitted as `-c` KEYS rather than `--sandbox` / `--ask-for-approval`, and the
 * recipe's `vendorArgs` are appended AFTER them. Codex applies `-c key=value`
 * overrides in command-line order, so a later `-c approval_policy="never"` or
 * `-c sandbox_workspace_write.network_access=true` or
 * `-c 'sandbox_workspace_write.writable_roots=["/tmp"]'` in vendorArgs WINS over
 * the default. A repeated single-value CLI FLAG (`--sandbox` twice) would be a
 * clap error instead, which is why the defaults are not flags. UNVERIFIED: the
 * "later -c wins" semantics are taken from Codex's config-override docs, not
 * observed (credits were exhausted when this was built — no Codex was launched).
 * Verify with `/status` in a pane whose vendorArgs flip a default.
 *
 * MESSAGES INTO A SESSION: `codex queue --thread <id> --message ...` is the
 * better delivery path than typing, but it must run AS the pane's account
 * (chat-ops) against that account's app-server daemon. NOT built here — see
 * the report; typed delivery (room-typer, guarded on idle) is the interim.
 *
 * FABRIC MCP FOR CODEX: BLOCKED on Owner's token decision (account token vs
 * per-pane tokens). Future messaging integration: when implemented, add `-c mcp_servers.fabric...`
 * (incl. `default_tools_approval_mode="approve"` and
 * `env_vars=["HARBOR_WB_SLUG","HARBOR_WB_PANEID","HARBOR_WB_VENDOR"]`) HERE,
 * beside the other `-c` keys. Nothing is configured for it now, on purpose.
 */
import type { Recipe } from '../../table/store.ts';
import { isEffortFor } from '../effort.ts';
import { flagArgsFor } from '../vendor-flags.ts';
import type { LiveCliVendor, TypingSpec, VendorTargetConfig } from './index.ts';

export const VENDOR = 'codex-cli';

const BIN = 'codex';

/** POSIX single-quote — mirror of launch.ts's quoting. */
function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote only when the shell would otherwise reinterpret it. */
function q(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : posixQuote(s);
}

/** A TOML basic-string value we can write without escaping logic: no quote,
 *  backslash or control character. Anything else is refused (never escaped
 *  wrongly) — the caller drops the optional `-c` and logs nothing it cannot say. */
function tomlSafe(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/["\\\u0000-\u001f\u007f]/.test(s);
}

/** `-c '<key>=<value>'` as one quoted argument pair. */
function cfg(key: string, tomlValue: string): string[] {
  return ['-c', posixQuote(`${key}=${tomlValue}`)];
}

/** A path-shaped launcher word: `~` must stay unquoted so the shell expands it. */
const LAUNCHER_RE = /^[A-Za-z0-9_@%+=:,./~-]+$/;

/** `<launcher> codex` from the target, or null when it names none. A launcher that is not a
 *  plain path THROWS: a config error must stop the launch, not degrade to bare codex. */
function targetLauncher(t: VendorTargetConfig | undefined): string | null {
  const l = t?.launcher?.trim();
  if (!l) {
    return null;
  }
  if (!LAUNCHER_RE.test(l)) {
    throw new Error(`targets.json codex.launcher is not a plain path: ${JSON.stringify(l)}`);
  }
  return `${l} ${BIN}`;
}

/** `<path>[ --flag]`: a plain path, optionally ONE long option. Anything else THROWS. */
const PRELAUNCH_RE = /^[A-Za-z0-9_@%+=:,./~-]+( --[a-z-]+)?$/;
function targetPreLaunch(t: VendorTargetConfig | undefined): { cmd: string } | null {
  const p = t?.preLaunch?.trim();
  if (!p) {
    return null;
  }
  if (!PRELAUNCH_RE.test(p)) {
    throw new Error(`targets.json codex.preLaunch is not a plain path with at most one --flag: ${JSON.stringify(p)}`);
  }
  return { cmd: p };
}

/** The target's shared defaults: repeated `-c key=value` pairs ONLY (the last one wins, so a
 *  recipe can override; a repeated single-value flag such as --model would not). Each value is
 *  quoted as cfg() does. Anything else THROWS. */
function targetArgs(t: VendorTargetConfig | undefined): string[] {
  const a = t?.args ?? [];
  const out: string[] = [];
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] !== '-c' || typeof a[i + 1] !== 'string' || !a[i + 1].includes('=')) {
      throw new Error(`targets.json codex.args must be "-c", "key=value" pairs (got ${JSON.stringify(a.slice(i, i + 2))})`);
    }
    out.push('-c', posixQuote(a[i + 1]));
  }
  return out;
}

export interface CodexInvocation {
  cmd: string;
  sessionId: string | null;
}

/**
 * The codex command line. Precedence is the engine's: **uuid > name > fresh**.
 * The resume forms are `codex resume <id|name> <same flags>`; the flags are the
 * same on every path so a resumed agent keeps its model, effort and sandbox.
 */
export function buildInvocation(
  r: Recipe,
  opts: { remote: boolean; resumeSessionId?: string | null; resumeName?: string | null; target?: VendorTargetConfig },
): CodexInvocation | null {
  if (r.vendor !== VENDOR) {
    return null; // not ours — the caller falls back to the recipe's initCmd
  }
  /* A LAUNCHER: a recipe whose initCmd ENDS in the codex binary (e.g. the
     operator's `cd <dir> && ~/.local/bin/codex-mcp-env.sh codex`, which loads
     its MCP environment) is used as the command prefix, so the flags land on
     that codex. Anything else in initCmd is ignored for this vendor, as before. */
  const launcher = (r.initCmd ?? '').trim();
  /* TARGET LAUNCHER [codex target] (ticket): a recipe made in the manager has no initCmd (the
     field is hidden for this vendor), so the wrapper that loads this account's MCP tokens rides
     the TARGET. The recipe's own launcher wins; otherwise the target's; never a silent bare
     `codex` when the target names one (a missing wrapper then fails visibly in the pane). */
  const parts: string[] = [/(^|[\s/])codex$/.test(launcher) ? launcher : targetLauncher(opts.target) ?? BIN];
  /* PRE-LAUNCH UPDATER [codex update] (ticket, Owner 2026-10-09): a target-named helper runs first,
     as this account. It prints NOTHING unless it fell back to a retained known-good executable, in
     which case it prints the PATH dir to prepend, and only that launch sees it (a one-command env
     prefix, so the interactive shell's own PATH is untouched). `&&`, not `;`: a helper that found NO
     runnable codex exits 1 and the launcher must not run. Connector-mode launches never come
     through this builder (they pin an exact executable), so they are never updated under. */
  const pre = targetPreLaunch(opts.target);
  if (pre) {
    parts[0] = `CODEX_SEL=$(${pre.cmd}) && PATH="\${CODEX_SEL:+$CODEX_SEL:}$PATH" ${parts[0]}`;
  }
  let sessionId: string | null = null;
  if (opts.resumeSessionId) {
    parts.push('resume', opts.resumeSessionId); // a uuid never needs quoting
    sessionId = opts.resumeSessionId;
  } else if (opts.resumeName) {
    const name = opts.resumeName.replace(/["']/g, '');
    parts.push('resume', opts.remote ? posixQuote(name) : `"${name}"`);
  }
  /* An EMPTY resume name (claude's "interactive picker") has no codex form that
     is not a choice: it falls through to a fresh session, like gemini-cli. */
  if (r.model) {
    parts.push('--model', q(r.model));
  }
  if (r.effort && isEffortFor(VENDOR, r.effort)) {
    parts.push(...cfg('model_reasoning_effort', `"${r.effort}"`));
  }
  /* HOSTED (security review H2): the engine writes no hooks into a user's repo there, so there is nothing it vouches for and the trust bypass is NOT passed; Codex asks for itself. */
  const hosted = process.env.HARBOR_WB_HOSTED === '1';
  parts.push('--no-alt-screen', ...(hosted ? [] : ['--dangerously-bypass-hook-trust']));
  // DEFAULTS FIRST, vendorArgs LAST: see "OVERRIDE RULE" in the header.
  parts.push(...cfg('sandbox_mode', '"workspace-write"'), ...cfg('approval_policy', '"on-request"'));
  if (r.projectDir && tomlSafe(r.projectDir) && !hosted) {
    parts.push(...cfg(`projects."${r.projectDir}".trust_level`, '"trusted"'));
  }
  /* THE IN-TUI "UPDATE AVAILABLE" MODAL IS OFF ON EVERY MANAGED LAUNCH, `--check` INCLUDED (Owner
     2026-10-09, [ref]: the check-only pilot launched Builder straight into Codex's update modal and
     it sat there; an agent cannot be allowed to wait on a prompt nobody is watching). Update status
     belongs in the helper's log, not in a modal. An UNMANAGED launch (no preLaunch) is unchanged. The
     recipe's own Extra arguments come later, so an explicit override still wins for that recipe. */
  if (pre) {
    parts.push(...cfg('check_for_update_on_startup', 'false'));
  }
  parts.push(...targetArgs(opts.target)); // target defaults, then the recipe's ticked boxes, then its own args (they win)
  const ticked = flagArgsFor(VENDOR, r.vendorFlags);
  for (let i = 0; i < ticked.length; i += 2) {
    parts.push('-c', posixQuote(ticked[i + 1]));
  }
  for (const a of r.vendorArgs ?? []) {
    parts.push(q(a));
  }
  return { cmd: parts.join(' '), sessionId };
}

/* HOW A ROOM LINE IS TYPED INTO CODEX [codex typer] Owner 2026-10-05. Codex's
   composer treats characters that arrive fast as a PASTE BURST, and an Enter
   inside (or just after) a burst is a NEWLINE, not a submit: the line stayed in
   the composer and every later line stacked under it. Its clock is when Codex
   READS the bytes, not when we write them, so a short delay is not enough on a
   1500-char line. Bracketed paste makes the text one atomic paste event, then a
   separate Enter after a pause submits. Codex has no UserPromptSubmit echo we
   can wait on, so a turn that has not started after submitCheckMs means the
   composer still holds the line (the typer retries Enter once, then holds). */
/* Tab, not Enter (Owner 2026-10-06; live on video-to-3d, rounds r20B/r20C): Tab submits at an
   idle prompt and, mid-turn, puts the line in Codex's own "Queued follow-up inputs", submitted
   the moment the turn ends. Enter mid-turn would STEER the running turn instead. So the typer
   delivers whenever the box is clear, without having to know whether Codex is idle — which it
   cannot reliably tell (Codex redraws at an idle prompt, and a hookless pane has no turn signal). */
/* STEER (Codex review 2026-10-07, KB design-notes-id): Enter while a turn runs sends the line
   INTO that turn; Tab queues it for the next. The repo's evidence is the r20B/r20C note above
   (Tab queued live; Enter-steers is stated there, from the same session) plus OpenAI's "steering
   and queuing" docs; no engine-typed steer has been observed live yet. Enter after a closed
   bracketed paste and a pause is a submit, not a newline ([codex typer] above). */
export const TYPING: TypingSpec = {
  bracketedPaste: true,
  enterDelayMs: 600,
  submitCheckMs: 3000,
  submitKey: '\t',
  queuesWhileBusy: true,
  steerKey: String.fromCharCode(13),
};

export const vendorModule: LiveCliVendor = {
  typing: TYPING,
  vendor: VENDOR,
  /* TRUE: the conversation is on disk under the pane account's ~/.codex and
     `codex resume <id>` keeps the same id (live-proven). The honest limit: a
     pane is only restorable once its first hook has banked the id. */
  resumable: true,
  invocation: buildInvocation,

  /* mintSessionId / discoverSessionId / locate / transcriptPath / listSessions /
   * ack — ABSENT on purpose (header): the id arrives by hook push, and the
   * rollout files are another account's, in a Codex-internal format. */

  reconcile(): 'dehydrated' | 'killed' {
    return 'dehydrated';
  },
};
