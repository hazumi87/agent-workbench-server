/**
 * launch — recipe → spawn-spec mechanics (CLI Manager phase, 2026-07-07 rescope).
 *
 * A RECIPE is a saved launch: name + target (where/who) + project folder +
 * claude options + theme. This module turns a recipe into a concrete spawn:
 * the engine ALWAYS spawns the PTY locally on the VRPC (Owner's model, CLAUDE.md
 * Discoveries 2026-06-10 — "server panes need NO remote-spawn"); a remote target
 * is just a local `ssh -t <alias> ...` whose identity rides the ssh alias.
 *
 * Targets (the where/who list) live in targets.json at the repo root — ssh
 * aliases only, no credentials (keys live in ~/.ssh, Harbor-config rule). The
 * file is user-editable without a code change (dev-tools pattern).
 *
 * SEAM NOTE (Contract B / ticket, generalised 2026-09-17): the spawn stays on
 * the generic cli-host descriptor path, but the COMMAND LINE is built by the
 * session's VENDOR MODULE, looked up by `vendorFor(vendor)` (contract §5.1) —
 * session-id minting, resume-by-id crash restore and the named-resume flow all
 * live THERE, per brand. This module only decides local-vs-ssh plumbing (shell,
 * quoting, injection), which is a fact about the HOST and never about the brand
 * (the v0.3 correction: a vendor supplies a command line, not a descriptor).
 * `vendorFor` returning undefined is the normal answer for a class-2 recipe —
 * bare shells, and today `codex-cli`/`ollama` — and means "use initCmd".
 *
 * WINDOW OPENING MOVED OUT (Phase 2, 2026-09-15). Everything that acted on an
 * OS desktop -- the :8200 control API, focus-if-showing, the protocol kick, the
 * Edge fallback, shell wrapping and ticketing -- now lives behind the
 * `DesktopActions` interface in ./desktop-actions.ts, because a server-hosted
 * engine cannot reach the machine a window opens on. Spawn mechanics stayed
 * here; they were never the same concern.
 */
import { DirectSpawnError, directArgv } from './argv.ts';
import { isLocalMode } from './local-mode.ts';
import { enginePort } from './local-guard.ts';
import { readFileSync } from 'node:fs';
import type { CliDescriptor } from './cli-host.ts';
import type { Recipe } from '../table/store.ts';
import { vendorFor } from './vendors/index.ts';
import { effectiveFor } from './auto-approve.ts';
import { sshBinary } from './platform.ts';
import { brokerPlatform } from './broker-client.ts';
import { hasFsAgent } from './agent-fs.ts';
import { instancePath } from './data-dir.ts';
import { isBasic } from './agent-commands.ts';

/** BASIC: when the assistant quits (trust prompt "No, exit", a crash, /exit) the shell ends too, so the seat reads
 *  not-live and offers Start. Otherwise a Basic user is dropped into a bare shell where a typed word runs as a
 *  command (Zack typed `yes` and bash ran /usr/bin/yes for 8.5 hours, 2026-10-10). Full edition keeps its shell. */
export function basicEndsWithAssistant(cmd: string | undefined): string | undefined {
  return cmd !== undefined && isBasic() ? `${cmd}; exit` : cmd;
}


export interface Target {
  id: string;
  label: string;
  kind: 'local' | 'ssh';
  sshAlias?: string; // required for kind=ssh — the ~/.ssh/config alias (carries user+key)
  shell?: string; // local shell binary, default powershell.exe
  /** Broker-RESIDENT target (vk [ref]): name of the broker host that hosts
   *  this target's process — the PTY spawns IN that broker (claude runs
   *  directly there; the tailnet is only a viewing pipe). `'local'` means
   *  "the broker on this engine's own host" (the VRPC broker today), which is
   *  also what an unset `broker` normalises to at load time (see
   *  `loadTargets`) — every target names its broker explicitly once loaded.
   *  The sshAlias is KEPT for transcript ops (resume picker, locate-refresh)
   *  even on a broker-resident target. */
  broker: string;
  /** ssh-kind target whose ssh CLIENT should run in a REMOTE broker (Phase 5,
   *  2026-09-16): with the engine on the server, the VRPC's ssh aliases and keys
   *  still live on the VRPC, so "server · owner via ssh" spawns `ssh.exe -t alias`
   *  INSIDE the VRPC broker — not a shell resident in that broker (which is what
   *  `broker` alone means, see homebase-resident). Binary is chosen by that broker's
   *  platform (config.json brokers.<name>.platform). */
  sshClient?: boolean;
  /** service registry NODE SLUG this target's work happens on (contract §1) —
   *  the host the agent's cwd is on, which for an ssh target is the FAR end,
   *  not this engine's host. Optional: when absent the engine derives it (see
   *  `nodeOfTarget` in the server), and setting it here is how a registry slug
   *  that does not match a hostname gets pinned without a code change. */
  node?: string;
  /** The OS account the seat runs as (`chat-ops`). Optional pin; absent, it
   *  is read off the ssh alias / target id when one ends in `<name>-ops`
   *  (`accountOfTarget`). */
  account?: string;
  /** [codex target] Codex-only settings for this target: `launcher` is a wrapper the codex
   *  binary runs through (it loads this account's MCP tokens, then execs `codex`), `args`
   *  shared `-c key=value` defaults. Other vendors on the target never see it. */
  codex?: { launcher?: string; args?: string[]; preLaunch?: string };
}

/** Read targets.json (repo root). Falls back to a bare local target so the
 *  manager still works if the file is missing/broken. Normalises `broker` to
 *  `'local'` for any target that doesn't name one (today: `kind:'local'` and
 *  plain `kind:'ssh'` targets both run on the local broker — an ssh CLIENT
 *  spawned there, not a remote broker) so every downstream reader can trust
 *  the field is always present instead of re-deriving the default. */
export function loadTargets(): Target[] {
  try {
    // Env override (JSON, same shape as targets.json) — test harness + probes.
    const envRaw = process.env.HARBOR_WB_TARGETS;
    const raw = envRaw
      ? JSON.parse(envRaw)
      : JSON.parse(readFileSync(instancePath('targets.json'), 'utf8'));
    if (Array.isArray(raw.targets) && raw.targets.length > 0) {
      return (raw.targets as Array<Omit<Target, 'broker'> & { broker?: string }>).map((t) => ({
        ...t,
        broker: t.broker ?? 'local',
      }));
    }
  } catch {
    /* fall through to default */
  }
  /* The bare local target runs the PC's shell: PowerShell on Windows (the default binary), the person's login shell elsewhere. */
  return [{ id: 'local', label: 'Local (this PC)', kind: 'local', broker: 'local', ...(process.platform === 'win32' ? {} : { shell: process.env.SHELL || '/bin/sh' }) }];
}

/** Single source for the engine's own service registry node id (Stage 2
 *  presence, contract §1). `HARBOR_WB_NODE` defaults to `'homebase'` because that is
 *  where the engine lives post-cutover (the migration plan) — a
 *  VRPC-hosted engine sets the env var. server/index.ts's `ENGINE_NODE` reads
 *  this too; it must never re-declare its own `|| 'homebase'` default. */
export function engineNode(): string {
  return process.env.HARBOR_WB_NODE || 'homebase';
}

/**
 * SELF-HOSTED (2026-09-17 polarity fix): is a target's DATA — its transcripts,
 * its project dir — sitting on the host THIS ENGINE PROCESS is running on
 * right now?
 *
 * THE BUG THIS FIXES: `homebase-resident` (`kind:'ssh'`, `sshAlias:
 * 'homeserver-svc-ops'`, `broker:'homebase'`) was built for an engine hosted on
 * the VRPC, reaching the server over ssh. The engine has since moved onto the server
 * itself and the target was never re-pointed — so every transcript lookup for
 * it still shelled out to `ssh homeserver-svc-ops`: the server's svc-ops
 * account trying to ssh to ITSELF, which it cannot do. The Resume picker came
 * back empty and the dir-check logged "could not reach homeserver-svc-ops"
 * for a directory that was sitting right there on local disk.
 *
 * Three rungs, cheapest/most-authoritative first — deliberately the SAME
 * precedence `nodeOfTarget` (server/index.ts) already uses for the same reason:
 *   1. `t.node` — pinned by hand in targets.json. Authoritative.
 *   2. `t.broker` naming a host (not the `'local'` sentinel) — a broker-
 *      resident target's data lives wherever that broker's process runs, which
 *      for THIS engine's own broker name is exactly here.
 *   3. `kind:'local'` with no broker override — the plain "this PC" target.
 * A `kind:'ssh'` target with no node/broker pin is NEVER self-hosted by rung 3:
 * its whole reason for existing is that its data is at the FAR end of the
 * alias, and rungs 1/2 are the only ways to override that.
 */
/**
 * WHICH HOST does this target's work — and therefore its transcripts and its
 * project dir — live on? The service registry node slug.
 *
 * THE SAME FOUR RUNGS `nodeOfTarget` HAS ALWAYS USED, and now the only copy of
 * them. They were written twice (server/index.ts for presence, and rungs 1-2
 * again inside `isSelfHosted`) — which is exactly the shape of the
 * `HARBOR_WB_NODE` double-default that the 2026-09-17 polarity fix collapsed
 * into `engineNode()`. Two independent copies of a host-derivation rule is how
 * a polarity bug hides for weeks.
 *
 *   1. `t.node` — pinned by hand in targets.json. Authoritative, and the only
 *      rung that can name a registry slug a hostname would not produce.
 *   2. `t.broker` naming a host — a broker-resident target's process runs
 *      wherever that broker does.
 *   3. an ssh alias's FIRST SEGMENT (`homeserver-svc-ops` -> `homeserver`)
 *      — an assumption about our own naming, and precisely why rung 1 exists.
 *   4. this engine's own node.
 */
export function hostOfTarget(t: Target | undefined): string {
  if (!t) {
    return engineNode();
  }
  if (t.node) {
    return t.node;
  }
  if (t.broker && t.broker !== 'local') {
    return t.broker;
  }
  if (t.kind === 'ssh') {
    return (t.sshAlias ?? t.id).split('-')[0] || engineNode();
  }
  return engineNode();
}

export function isSelfHosted(t: Target): boolean {
  const node = engineNode();
  if (t.node) {
    return t.node === node;
  }
  if (t.broker && t.broker !== 'local') {
    return t.broker === node;
  }
  return t.kind === 'local';
}

/**
 * How session-listing / transcript-locate / the project-dir existence check
 * should reach a target's filesystem.
 *
 *   `local`       — self-hosted (see isSelfHosted): read THIS engine's own
 *                    disk directly, no ssh.
 *   `ssh`         — genuinely remote: any non-self-hosted `kind:'ssh'` target
 *                    (the historic behaviour, unchanged), or a foreign-broker
 *                    `kind:'local'` target that has an alias pinned for
 *                    exactly this purpose.
 *   `agent`       — a foreign-broker target whose HOST has a window agent
 *                    connected that advertises the `fs` capability. The agent
 *                    already runs as the account owning that host's
 *                    transcripts, so it reads them for us over the socket it
 *                    dialled (see agent-fs.ts, contract §5b).
 *   `unreachable` — a foreign-broker target with neither an alias nor an
 *                    fs-capable agent. NEVER falls back to checking this
 *                    engine's own filesystem — that is the other half of the
 *                    polarity bug ("no such directory on this PC: C:/tmp" was
 *                    the server checking a Windows path that meant the VRPC).
 *
 * PRECEDENCE: local > ssh > agent > unreachable, and `ssh` BEATING `agent` is
 * deliberate. An alias is a configured, always-available, stateless path that
 * works whether or not anyone is at the desk; an agent is a live socket that
 * exists only while a desktop is running. Preferring the socket would have made
 * every server target's Resume picker depend on whether a window happened to be
 * open. The agent fills the gap where there is no alias — it does not compete
 * for the ones there already are.
 */
export type RemoteFsAccess =
  | { mode: 'local' }
  | { mode: 'ssh'; sshAlias: string }
  | { mode: 'agent'; host: string }
  | { mode: 'unreachable'; reason: string };

export function remoteFsAccess(t: Target | undefined): RemoteFsAccess {
  /* A LOCAL READ RUNS AS THE ENGINE'S ACCOUNT, NOT THE TARGET'S (2026-09-20).
     `sshClient` targets ssh INTO this host as a DIFFERENT user (homebase-owner ->
     owner), and their `node` pin makes them self-hosted, which is right: the
     process and its files are here. World-readable paths (a tool's statusPath)
     are then read directly, which is the sudo-countdown fix. Per-USER roots are
     NOT: svc-ops cannot read owner's transcripts, and the failure mode to
     watch is reading the ENGINE user's root and answering confidently about the
     wrong account. Today no recipe on such a target sets projectDir/runClaude,
     so no transcript call site reaches this; when one appears, the target needs
     an account of its own rather than a per-call-site patch. */
  if (!t || isSelfHosted(t)) {
    return { mode: 'local' };
  }
  if (t.kind === 'ssh') {
    return { mode: 'ssh', sshAlias: t.sshAlias ?? t.id };
  }
  if (t.sshAlias) {
    return { mode: 'ssh', sshAlias: t.sshAlias };
  }
  /* THE GAP THIS CLOSES (Owner, 2026-09-18): `local` on a server-hosted engine is
     broker-resident on the VRPC, and there is no ssh alias from svc-ops into
     winuser's Windows account. Every transcript read for the "Briefing Table"
     recipe answered `unreachable` — correct, and useless. */
  const host = hostOfTarget(t);
  if (hasFsAgent(host)) {
    return { mode: 'agent', host };
  }
  return {
    mode: 'unreachable',
    reason: `target "${t.id}" runs on broker "${t.broker ?? 'local'}", not this engine (${engineNode()}), and has neither an sshAlias nor an fs-capable window agent on "${host}" to reach it`,
  };
}

/**
 * The transcript-reader options a vendor call takes, from an access decision.
 *
 * ONE PLACE, because the alternative is the ternary this replaces — `access.mode
 * === 'ssh' ? access.sshAlias : undefined` — repeated at six call sites, each of
 * which would have had to learn about `agent` independently. That is how
 * `widgetStatus` still holds the pre-polarity-fix version of the same ternary.
 * `unreachable` must be handled by the CALLER (it is the one outcome that has
 * to be reported rather than silently degraded), so this returns an empty
 * object for it — which every reader treats as "read local disk" and would be
 * the original bug. Callers check `mode === 'unreachable'` first; that is not
 * optional.
 */
export function fsOptsFor(access: RemoteFsAccess): { sshAlias?: string; agentHost?: string } {
  if (access.mode === 'ssh') {
    return { sshAlias: access.sshAlias };
  }
  if (access.mode === 'agent') {
    return { agentHost: access.host };
  }
  return {};
}

/** The two claude flags that load the fabric channel from a per-pane MCP
 *  config (probe facts, CC 2.1.282: both are required). */
export function channelArgs(configPath: string): string {
  /* --allowedTools mcp__fabric: a channel pane's first fabric_send otherwise
     stops on a permission prompt nobody is watching (live channel test
     2026-09-25, thread chlive01). service-level rule = the fabric tools only. */
  return `--mcp-config ${configPath} --dangerously-load-development-channels server:fabric --allowedTools mcp__fabric`;
}

/** POSIX single-quote (for the remote side of ssh). */
function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface LaunchSpec {
  descriptor: CliDescriptor;
  /** A command line to type into the PTY after spawn (visible to the user —
   *  debug transparency). Used for LOCAL launches; ssh carries its command. */
  inject?: string;
  /** What goes in the table's `server` column. */
  server: string;
  /** What goes in the table's `vendor` column: claude-code when the recipe
   *  runs claude (the resumable vendor), cli-manager for a bare shell. */
  vendor: string;
  /** The claude session id the engine can bank on (minted `--session-id` on a
   *  fresh launch, the stored id on a restore), or null: bare shell / the
   *  named-resume flow, where claude picks the session and we can't know it. */
  claudeSessionId: string | null;
  /** WHICH broker holds the PTY (vk [ref]): 'local' (VRPC) unless the target
   *  names a remote broker host. The engine routes spawn/attach through the
   *  matching broker link. */
  brokerHost: string;
}

/**
 * WHO AM I, AS ENVIRONMENT (R11, the design notes §8).
 *
 * Owner, 2026-09-17: "how does an agent know if they are platform-2, platform-3
 * or platform-32? they don't. they only have their context." Identity is
 * ASSIGNED and HANDED BACK — never self-declared, never counted. The engine is
 * the thing that knows a pane's slug and its pane id, so it says so, in the one
 * channel every CLI, hook, skill and tool can read without inference.
 *
 * Three variables, deliberately:
 *   HARBOR_WB_SLUG   — the STABLE logical identity. Today the recipe's slug,
 *                      i.e. the PROJECT id (contract §1's degenerate case);
 *                      the per-colleague work slug once check-in ships. The
 *                      only key anything outside this engine may address a
 *                      session by; a transcript uuid is an incarnation and
 *                      rotates, the slug does not.
 *   HARBOR_WB_PANEID — WHICH incarnation, i.e. which pane/window this process
 *                      is in. What an engine API call needs to name itself.
 *   HARBOR_WB_VENDOR — the brand, so a shared hook can branch without sniffing
 *                      for a binary.
 *
 * VENDOR-NEUTRAL BY CONSTRUCTION — nothing here asks what brand is running, and
 * that is the point: the day a second brand's hooks want to announce
 * themselves, they already can.
 *
 * A null/empty value is OMITTED rather than exported empty: `${HARBOR_WB_SLUG}`
 * expanding to the empty string reads as "I have no identity", which is a
 * different claim from "nobody told me", and only the second one is true.
 */
export function sessionEnv(id: {
  paneid?: string | null;
  slug?: string | null;
  vendor?: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (id.slug) {
    env.HARBOR_WB_SLUG = id.slug;
  }
  if (id.paneid) {
    env.HARBOR_WB_PANEID = id.paneid;
  }
  if (id.vendor) {
    env.HARBOR_WB_VENDOR = id.vendor;
  }
  return env;
}

/**
 * GIT'S "DUBIOUS OWNERSHIP" GUARD for a seat that works in a worktree (Owner
 * 2026-10-05, worktree convention, KB design-notes-id section 12). The engine
 * (svc-ops) creates every worktree and base clone, so a seat running as
 * another account (chat-ops, gem-ops) reads a tree it does not own, and
 * git refuses it. `safe.directory` for exactly the worktree and its `_base` is
 * handed to the seat through git's own env config (GIT_CONFIG_COUNT/KEY_n/
 * VALUE_n), which needs no file edit in the seat's home. An existing
 * GIT_CONFIG_COUNT is APPENDED to, never overwritten: the new pairs take the
 * next indices.
 */
export function gitSafeEnv(
  worktreePath: string,
  basePath: string,
  existing: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const n = Number.parseInt(existing.GIT_CONFIG_COUNT ?? '', 10);
  const at = Number.isInteger(n) && n >= 0 ? n : 0;
  return {
    GIT_CONFIG_COUNT: String(at + 2),
    [`GIT_CONFIG_KEY_${at}`]: 'safe.directory',
    [`GIT_CONFIG_VALUE_${at}`]: worktreePath,
    [`GIT_CONFIG_KEY_${at + 1}`]: 'safe.directory',
    [`GIT_CONFIG_VALUE_${at + 1}`]: basePath,
  };
}

/** The account a target runs as, or null when it cannot be known (never
 *  guessed): the `account` pin, else a `<name>-ops` tail on the ssh alias, else
 *  on the target id. `svc-ops`, `chat-ops`, `gem-ops` all read this
 *  way; `homeserver-service` and `local` name no account. */
export function accountOfTarget(t: Target): string | null {
  if (t.account && /^[a-z0-9][a-z0-9_-]*$/.test(t.account)) {
    return t.account;
  }
  for (const s of [t.sshAlias, t.id]) {
    const m = s ? /(?:^|-)([a-z0-9]+-ops)$/.exec(s) : null;
    if (m) {
      return m[1];
    }
  }
  return null;
}

const GIT_BRAND: Record<string, string> = { 'codex-cli': 'Codex', 'gemini-cli': 'Gemini' };

/**
 * COMMIT IDENTITY for a non-Claude code seat [vendor git identity] Owner
 * 2026-10-05 (option a): its commits carry "<account> (<Brand>)" and
 * "<account>@homeserver.local", so git history says which seat wrote it.
 * Claude seats are unchanged, and an account that cannot be known adds nothing.
 */
export function vendorGitEnv(vendor: string, t: Target): Record<string, string> {
  const brand = GIT_BRAND[vendor];
  const account = brand ? accountOfTarget(t) : null;
  if (!brand || !account) {
    return {};
  }
  const name = `${account} (${brand})`;
  const email = 'noreply@example.com';
  return { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email };
}

/**
 * The same identity as a POSIX `export` prefix, for the REMOTE half of an ssh
 * launch.
 *
 * WHY NOT `ssh -o SendEnv`: it is refused unless the REMOTE sshd lists the
 * variable in `AcceptEnv`, which is root-owned config on every host we would
 * ever want this on. A launch feature that needs a sudo edit on the far side is
 * a launch feature that silently does nothing — exactly the 401'ing-hook shape
 * this repo has been caught by twice.
 *
 * So it rides the COMMAND LINE, which is precisely how the claude session id
 * already reaches the remote side (`claude --session-id <uuid>` is embedded in
 * the same remote command string). One mechanism, already proven through ssh
 * quoting. `export` rather than a `VAR=x cmd` prefix because the variables must
 * survive into BOTH the `$SHELL -lic '<cli>'` child and the `exec $SHELL -l`
 * that outlives it — a prefix would only reach the first.
 */
function remoteEnvPrefix(env: Record<string, string>): string {
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${posixQuote(v)}`);
  return pairs.length ? `export ${pairs.join(' ')}; ` : '';
}

/** Turn a recipe + target into a concrete local spawn. `resumeSessionId` (a
 *  dehydrated pane's stored uuid) makes this a CRASH RESTORE: the claude
 *  invocation becomes `--resume <uuid>` regardless of the recipe's own flags. */
function enginePaneUrl(): Record<string, string> {
  const set = (process.env.HARBOR_WB_PANE_ENGINE_URL ?? '').trim().replace(/\/+$/, '');
  const port = enginePort();
  return set ? { HARBOR_WB_ENGINE_URL: set } : port > 0 ? { HARBOR_WB_ENGINE_URL: `http://127.0.0.1:${port}` } : {};
}

export function buildLaunch(
  r: Recipe,
  t: Target,
  resumeSessionId?: string | null,
  resumeName?: string | null,
  /** Identity the spawned process is told about itself (R11). Optional so every
   *  existing caller and test keeps compiling; absent simply means the pane id
   *  is not exported, never that a wrong one is. */
  opts?: {
    paneid?: string | null;
    /** HARBOR_WB_CHANNELS (channels.ts): the per-pane MCP config the caller
     *  wrote. Adds the channel flags to a claude-code line on this host; the
     *  ssh branch never carries them (the fabric is loopback-only). */
    channelConfig?: string | { configRef: string; prelude: string } | null;
    /** This session runs in its own git worktree (seat-worktree.ts): its
     *  safe.directory env rides the descriptor (see gitSafeEnv). */
    worktree?: { path: string; base: string } | null;
    /** E1 (bt-launch.ts): extra command-line pieces for THIS vendor's line (the bt tools, the role file), appended after the channel flags on every path
     *  buildLaunch builds a claude/codex line (fresh, resume, restore). Absent = nothing added. */
    extraArgs?: string | null;
  },
): LaunchSpec {
  /* The recipe's OWN column is the authority (Stage 2); `runClaude` is only the
     legacy mirror, consulted when a row predates the column. */
  const vendor = r.vendor || (r.runClaude ? 'claude-code' : 'cli-manager');
  const mod = vendorFor(vendor);
  /* WHO THIS SESSION IS, handed to the process itself (R11, fabric brief §8).
     Vendor-neutral on purpose: it is the ENGINE that knows a pane's identity,
     and every brand's hooks/skills/tools should be able to read it without
     inferring it from a cwd or a window title. */
  const vendorCfg = vendor === 'codex-cli' ? t.codex : undefined; // [codex target]
  const env = sessionEnv({ paneid: opts?.paneid, slug: r.agent, vendor });
  if (opts?.worktree) {
    Object.assign(env, gitSafeEnv(opts.worktree.path, opts.worktree.base));
  }
  Object.assign(env, vendorGitEnv(vendor, t)); // [vendor git identity] Owner 2026-10-05
  /* Channel flags ride the SAME line on fresh launch and on every resume path,
     because this is the only place a claude line is built. */
  const cc = opts?.channelConfig;
  /* A string = a config file on this host (server-local). An object = a VRPC
     relayed pane (channels.planVrpcLaunch): a PowerShell prelude writes the
     file on the VRPC and leaves its path in a variable the flags name. */
  const withChannel = <T extends { cmd: string } | null>(inv0: T): T => {
    const inv =
      inv0 && cc && vendor === 'claude-code'
        ? typeof cc === 'string'
          ? ({ ...inv0, cmd: `${inv0.cmd} ${channelArgs(cc)}` } as T)
          : ({ ...inv0, cmd: `${cc.prelude}; ${inv0.cmd} ${channelArgs(cc.configRef)}` } as T)
        : inv0;
    const extra = opts?.extraArgs;
    /* extra that does not start with a flag is the CONTINUATION of the --allowedTools value channelArgs just opened (bt's tools, merged into the channel config): join it with a comma so the
       list stays one word. A space would make every tool after the first a bare word, and the engine's own argv classifier reads a bare word as "not the REPL". */
    const joiner = extra && !extra.startsWith('-') && vendor === 'claude-code' && cc ? ',' : ' ';
    return inv && extra && (vendor === 'claude-code' || vendor === 'codex-cli') ? ({ ...inv, cmd: `${inv.cmd}${joiner}${extra}` } as T) : inv;
  };
  if (process.env.HARBOR_WB_HOSTED === '1') {
    /* HOSTED (M8): the CLI is spawned DIRECTLY as binary + argv, absolute path resolved now; no typed line, no shell before it, no shell after it (the pane ends when the CLI does). A recipe with no
       CLI to run (a bare shell) and an ssh hop are refused instead of falling back to a shell. */
    if (t.kind === 'ssh') throw new DirectSpawnError('ssh-refused', 'a hosted engine does not open ssh sessions');
    if (!(r.projectDir ?? '').trim()) throw new DirectSpawnError('no-folder', 'This agent has no folder yet. Add it again with a folder.');
    const inv = withChannel(mod?.invocation(r, { remote: false, resumeSessionId, resumeName, target: vendorCfg, autoApprove: effectiveFor(r) }) ?? null);
    const line = inv?.cmd ?? (mod ? null : r.initCmd || null);
    if (!line) throw new DirectSpawnError('no-cli', 'this recipe has no CLI to run, and the hosted engine does not open a bare shell');
    const { binary, args } = directArgv(line);
    return {
      /* the pane learns the engine's base URL: HARBOR_WB_PANE_ENGINE_URL when the agent side reaches it another way (a split setup), else the bound loopback port */
      descriptor: { binary, args, cwd: r.projectDir || null, env: { ...env, ...enginePaneUrl() } },
      server: t.sshAlias ?? t.id,
      vendor,
      claudeSessionId: inv?.sessionId ?? null,
      brokerHost: t.broker,
    };
  }
  if (t.broker !== 'local' && !t.sshClient) {
    // BROKER-RESIDENT (vk [ref]): the PTY spawns IN the remote host's broker —
    // claude runs directly on that host (no ssh in the session's lifeline; a
    // network drop only detaches the view). Mirrors the LOCAL pattern: spawn
    // the host's interactive login shell in the project dir, then TYPE the
    // claude/init command (visible — debug transparency; the interactive login
    // shell resolves PATH, the same reason ssh needed `-lic`).
    const inv = withChannel(mod?.invocation(r, { remote: false, resumeSessionId, resumeName, target: vendorCfg, autoApprove: effectiveFor(r) }) ?? null);
    return {
      descriptor: {
        // `shell` override serves tests (a Windows scratch "remote" broker);
        // real remote brokers are Linux: bash as an interactive login shell.
        binary: t.shell ?? 'bash',
        args: t.shell ? [] : ['-il'],
        cwd: r.projectDir || null,
        env,
      },
      inject: basicEndsWithAssistant(inv?.cmd) ?? (r.initCmd || undefined),
      server: t.sshAlias ?? t.id, // keeps transcript ops (picker/locate) on the alias
      vendor,
      claudeSessionId: inv?.sessionId ?? null,
      brokerHost: t.broker,
    };
  }
  if (t.kind === 'local') {
    const inv = withChannel(mod?.invocation(r, { remote: false, resumeSessionId, resumeName, target: vendorCfg, autoApprove: effectiveFor(r) }) ?? null);
    // Other-CLI recipes: initCmd is typed into the shell exactly like the
    // claude command would be (visible — debug transparency; any password
    // prompt it triggers happens interactively in the pane).
    /* LOCAL MODE: the pane learns the engine's address, so a guide never hard-codes a port (the bound one; 0 before it has bound is no address).
       Only here: a pane in another machine's broker (above) or over ssh (below) would get a loopback address of the WRONG host. */
    const port = isLocalMode(process.env) ? enginePort() : 0;
    return {
      descriptor: {
        binary: t.shell ?? 'powershell.exe',
        args: [],
        cwd: r.projectDir || null,
        env: port > 0 ? { ...env, HARBOR_WB_ENGINE_URL: `http://127.0.0.1:${port}` } : env,
      },
      inject: basicEndsWithAssistant(inv?.cmd) ?? (r.initCmd || undefined),
      server: 'local',
      vendor,
      claudeSessionId: inv?.sessionId ?? null,
      brokerHost: t.broker, // normalised to 'local' at load time
    };
  }
  // ssh: run the cd + claude as the remote command, then drop into a login
  // shell so the window stays useful after claude exits (and when runClaude
  // is off the recipe is exactly "a shell cd'd to the project folder").
  const cd = r.projectDir ? `cd ${posixQuote(r.projectDir)} && ` : '';
  const inv = mod?.invocation(r, { remote: true, resumeSessionId, resumeName, target: vendorCfg, autoApprove: effectiveFor(r) }) ?? null;
  /* `mod` rather than `r.runClaude`: a vendor-backed recipe whose module
     declined to build a line has nothing to run, and a class-2 recipe runs its
     own initCmd. Identical behaviour for the two vendors that existed before
     the registry, and correct for the ones after it. */
  const claude = inv?.cmd ?? (mod ? null : r.initCmd || null);
  // claude lives on a PATH set up by the user's INTERACTIVE login shell (on the
  // server it's ~/.npm-global/bin, added in ~/.bashrc behind its non-interactive
  // guard). ssh's remote command runs in a NON-login, NON-interactive shell that
  // never loads that PATH, so a bare `claude …` here dies "command not found"
  // (that's why the model never auto-ran). Route it through an INTERACTIVE login
  // shell (`-lic`) so PATH resolves; then exec an interactive login shell so the
  // window stays useful after claude exits.
  const runClaude = claude ? `$SHELL -lic ${posixQuote(claude)}; ` : '';
  /* AFTER-EXIT SHELL — unconditional by default, conditional when the recipe
   * asks (closeOnCleanExit).
   *
   * Unconditionally exec'ing a login shell makes "I quit" and "it crashed"
   * look identical: both leave a live shell in a live pane. For the command bridge
   * that was actively misleading — press `q`, the bridge is gone, the manager
   * still reports the session live. With the flag on, a CLEAN exit (0) ends the
   * pty so the engine's onExit marks the row killed, while a FAULT still lands
   * you in a shell, which is the entire reason the after-exit shell exists.
   *
   * Guarded on there BEING a command: with no command, `$?` is just the `cd`,
   * so a bare shell recipe would close itself instantly. */
  const afterExit =
    r.closeOnCleanExit && claude
      ? 'rc=$?; [ "$rc" -eq 0 ] || exec $SHELL -l'
      : 'exec $SHELL -l';
  /* Identity FIRST, so it is set before the cd, before the CLI and before the
     after-exit shell — every one of which is something a human or a hook may
     ask "who am I" from. */
  const remoteCmd = `${remoteEnvPrefix(env)}${cd}${runClaude}${afterExit}`;
  return {
    descriptor: {
      // sshBinary(): node-pty on Windows does NOT append `.exe` or do a PATH
      // search the way child_process does — a bare `ssh` throws "File not
      // found" there (2026-07-07 Discovery). The ssh CLIENT always spawns on
      // whichever host the engine itself runs on, so this names THAT host's
      // binary, not the remote's.
      binary: t.broker === 'local' || !t.sshClient
        ? sshBinary()
        : (brokerPlatform(t.broker) === 'win32' ? 'ssh.exe' : 'ssh'),
      args: ['-t', t.sshAlias ?? t.id, remoteCmd],
      cwd: null,
      /* The ssh CLIENT's own env. The CLI itself gets these from the `export`
         in remoteCmd above — this is for anything that runs in the pane on
         THIS side of the hop (and so that "every spawned pty carries the
         identity" has no exceptions to remember). */
      env,
    },
    server: t.sshAlias ?? t.id,
    vendor,
    claudeSessionId: inv?.sessionId ?? null,
    brokerHost: t.broker, // normalised to 'local' — the ssh CLIENT is a local PTY, the lifeline is local
  };
}
