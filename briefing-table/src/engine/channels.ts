/* ============================================================================
 * CHANNELS — claude panes hear the fabric through Claude Code's channel
 * mechanism instead of through typed text. Behind HARBOR_WB_CHANNELS (default
 * '0' = the engine behaves exactly as it did before this file existed).
 *
 * Four pieces, each small, all here so the files other work is changing
 * (fabric.ts, fabric-subscriber.ts, rooms.ts) carry one routing hook each:
 *
 *  1. LAUNCH. A claude-code pane whose pty runs ON THIS HOST gets a per-pane
 *     MCP config (data/mcp/<pane>.json, 0600) naming platform's fabric-mcp in
 *     channel mode, and `--mcp-config <file> --dangerously-load-development-
 *     channels server:fabric` on its command line — on a fresh launch AND on
 *     every resume/restore, because buildLaunch is the one place a claude line
 *     is built. ssh panes are skipped: the fabric listens on the server's
 *     loopback only. VRPC-broker panes (1b below) get the channel through the
 *     engine relay (fabric-relay.ts) instead.
 *
 *  2. DIALOG ACCEPT. Claude Code shows "WARNING: Loading development channels"
 *     on EVERY launch and resume with that flag, before the MCP spawns, with
 *     option 1 ("I am using this for local development") preselected. The
 *     engine watches the pane's output and writes ONE "\r" once the dialog
 *     text has been seen. Never a blind Enter: the TRUST dialog that can come
 *     first defaults to "No, exit", and an Enter sent before the dialog has
 *     rendered is swallowed. The text does not arrive literally — the TUI
 *     positions each word with a cursor move (`WARNING:\x1b[12GLoading\x1b[20G
 *     development…`, probe r1/r6, CC 2.1.282) — so matching runs on a
 *     normalised stream where every escape sequence counts as whitespace.
 *     HARDENED (S0 guard 6, assemble-room §4.4): arms only on the title AND
 *     its option line in one frame; the old-session dialog (which follows it,
 *     F5) and a human keystroke cancel a pending write (`human-answered`); the
 *     write waits for 400 ms with no new characters in the startup gate's
 *     stream and only while the gate's latest prompt is still dev-channels.
 *
 *  3. ROUTING (Owner's ladder: channel > typed > badge+mailbox > room @mention).
 *     Before an AGENT's words are typed into a pane, ask the fabric whether
 *     that pane's MCP holds a live channel (`GET /presence?paneid=`, cached
 *     5 s, 1 s timeout, any error = no). A HUMAN's room line is always typed:
 *     a channel arrival mid-turn is demoted to "untrusted, do not act", and
 *     the user's words must stay user-role. Room lines keep being typed until
 *     the F4 fan-out sends them as envelopes (`roomLinesViaFabric()`).
 *
 *  4. RECEIPT. The fabric-mcp pump no longer acks `delivered` on emit (emit is
 *     not receipt — fabric-mcp c0c5066). For a channel pane the engine tails
 *     the pane's transcript for claude's own record of queueing the message
 *     (`{"type":"queue-operation","operation":"enqueue","content":"<channel …
 *     id=\"<envelope id>\" …>"}`), then acks `delivered`. Nothing within
 *     ~10 s → the envelope is typed after all (`typed-fallback`).
 *
 * COUNTS ONLY in logs and diag, never message content (the /api/handoff rule).
 * ========================================================================== */

import { engineWrite } from './pty-write.ts';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import * as sessions from './sessions.ts';
import { channelArgs, engineNode, type Target } from './launch.ts';
import { table } from '../table/endpoint.ts';
import * as claudeCode from './vendors/claude-code.ts';
import * as fabricRelay from './fabric-relay.ts';
import { worktreePath } from './worktrees.ts';
import { instancePath } from './data-dir.ts';
import { enginePort, networkServicesRefused } from './local-guard.ts';


/* a local engine never carries the fabric channel, whatever HARBOR_WB_CHANNELS says (E6, local-guard.ts) */
export const enabled = (): boolean => !networkServicesRefused() && process.env.HARBOR_WB_CHANNELS === '1';

/** Flipped by the F4 fan-out (rooms on fabric threads): until room lines reach
 *  a pane as envelopes, the channel cannot carry them and they must be typed. */
export function roomLinesViaFabric(): boolean {
  /* F4 (rooms on fabric threads) fans every room line out as an envelope with
     ref room:<id>/line:<n>; a channel pane receives it through fabric-mcp, so
     the typed copy is skipped for AGENT-authored lines. The human's lines are
     always typed (skipRoomTyping). Off when F4 is off. */
  return process.env.HARBOR_WB_ROOM_FABRIC !== '0';
}

export const MCP_SERVER = (): string =>
  process.env.HARBOR_WB_FABRIC_MCP || '';

function fabricBase(): string {
  if (networkServicesRefused()) return '';
  const raw = process.env.HARBOR_WB_FABRIC_URL;
  const base = (raw === undefined ? 'http://127.0.0.1:8204' : raw).trim().replace(/\/+$/, '');
  return base.toLowerCase() === 'off' ? '' : base;
}

export function configDir(): string {
  if (process.env.HARBOR_WB_CHANNELS_DIR) {
    return process.env.HARBOR_WB_CHANNELS_DIR;
  }
  const tablePath = process.env.HARBOR_WB_TABLE ?? instancePath('data', 'mapping.db');
  return join(dirname(tablePath), 'mcp');
}

let log: (line: string) => void = (l) => console.log(`[engine-channels] ${l}`);
let token = '';

export function init(opts: { token: string; log?: (line: string) => void }): void {
  token = opts.token;
  if (opts.log) {
    log = opts.log;
  }
  if (enabled()) {
    log(`channels ON (fabric ${fabricBase() || 'off'}, mcp ${MCP_SERVER()})`);
  }
}

/* ============================================================== 1. launch == */

/** Does this target's pty run on the host this engine runs on? Only then can
 *  the pane's MCP reach the fabric on loopback. Broker-resident on our own
 *  broker, or a plain local target on the local broker. An ssh CLIENT (either
 *  kind) is never here: the claude it starts is on the far side. */
export function ptyRunsHere(t: Target): boolean {
  if (t.sshClient) {
    return false;
  }
  if (t.broker === 'local') {
    return t.kind === 'local';
  }
  return t.broker === engineNode();
}

/** Characters a path may carry and still be typed into a shell unquoted. */
const SHELL_SAFE = /^[A-Za-z0-9_./-]+$/;

export function safePaneFile(paneid: string): string {
  const base = paneid.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  const h = createHash('sha1').update(paneid).digest('hex').slice(0, 8);
  return `${base}-${h}.json`;
}

export { channelArgs };

export interface McpConfig {
  mcpServers: { fabric: { command: string; args: string[]; env: Record<string, string> } };
}

export type LaunchPlan =
  | { on: true; configPath: string; config: McpConfig }
  | { on: false; reason: string };

/** Pure: should this spawn carry the channel, and with what config. */
export function planLaunch(p: {
  enabled: boolean;
  vendor: string;
  runsHere: boolean;
  mcpExists: boolean;
  mcpServer: string;
  dir: string;
  paneid: string;
  slug: string | null;
  enginePort: number;
  fabricUrl?: string;
}): LaunchPlan {
  if (!p.enabled) return { on: false, reason: 'off' };
  if (p.vendor !== 'claude-code') return { on: false, reason: 'vendor' };
  if (!p.runsHere) return { on: false, reason: 'not-local' };
  if (!p.mcpExists) return { on: false, reason: 'mcp-missing' };
  /* posix.join: this is a path on the host that runs the pty (server-local only,
     ptyRunsHere) and it is spliced into a POSIX shell line — node's platform
     join() would backslash it on win32 (vrpc1 Windows run 2026-09-25). */
  const configPath = posix.join(p.dir, safePaneFile(p.paneid));
  if (!SHELL_SAFE.test(configPath)) return { on: false, reason: 'unsafe-path' };
  const env: Record<string, string> = {
    // FABRIC_CHANNEL travels ONLY with the launch flag: a pump running without
    // it would push notifications claude silently drops.
    FABRIC_CHANNEL: '1',
    // The MCP receives envelopes DIRECTLY (the engine subscriber never sees
    // them), so it must ack on emit; safe because it rides only with the flag
    // and claude enqueues within ms (platform, relay 2026-09-25 13:28Z).
    FABRIC_CHANNEL_ACK: 'emit',
    HARBOR_WB_PANEID: p.paneid,
    HARBOR_WB_ENGINE_URL: `http://127.0.0.1:${p.enginePort}`,
  };
  if (p.slug) env.HARBOR_WB_SLUG = p.slug;
  if (p.fabricUrl) env.HARBOR_WB_FABRIC_URL = p.fabricUrl;
  return {
    on: true,
    configPath,
    config: { mcpServers: { fabric: { command: 'node', args: [p.mcpServer], env } } },
  };
}

/* ------------------------------------------------ 1b. VRPC relayed launch --
 *
 * A claude pane resident in the VRPC broker (target `local`: kind local,
 * broker 'vrpc', shell powershell.exe) cannot reach the server fabric, so its
 * fabric-mcp runs in RELAY mode (fabric-service 4da0a3e) and dials this
 * engine's `WS /api/fabric/relay` (fabric-relay.ts) over Serve.
 *
 * THE CONFIG FILE MUST EXIST ON THE VRPC and the engine cannot write files
 * there. Inline JSON (`--mcp-config '<json>'`) was the first plan and is
 * MEASURED BROKEN: the VRPC's `claude` is npm's claude.ps1 shim under Windows
 * PowerShell 5.1, which re-passes `$args` to claude.exe with legacy native
 * quoting — every embedded `"` is stripped and the arg splits at the space in
 * "Program Files", both with raw JSON and with MSVCRT-escaped `\"` (probe
 * through the shim's exact `& <exe> $args` shape, 2026-09-25). So the typed
 * line carries a PRELUDE that writes the file on the VRPC from BASE64 (an
 * alphabet with nothing to quote), and claude gets the file through a
 * PowerShell variable whose value has no spaces or quotes:
 *
 *   $hwbMcp = Join-Path $env:TEMP '<pane>.json'; [IO.File]::WriteAllText(
 *     $hwbMcp, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(
 *     '<b64>'))); claude … --mcp-config $hwbMcp --dangerously-load-…
 *
 * The file holds no secret (the bearer stays in FABRIC_TOKEN_FILE). Every
 * Windows value is env-overridable; the defaults are what platform staged.
 * ------------------------------------------------------------------------- */

const WIN = String.fromCharCode(92); // a backslash, never typed into source
const winPath = (...parts: string[]): string => parts.join(WIN);

export function vrpcDefaults(): {
  broker: string;
  nodeExe: string;
  mcpServer: string;
  relayUrl: string;
  engineUrl: string;
  tokenFile: string;
  dir: string;
} {
  const e = process.env;
  return {
    broker: e.HARBOR_WB_VRPC_BROKER || 'vrpc',
    nodeExe: e.HARBOR_WB_VRPC_NODE_EXE || winPath('C:', 'Program Files', 'nodejs', 'node.exe'),
    mcpServer: e.HARBOR_WB_VRPC_FABRIC_MCP || winPath('F:', 'code', 'fabric-service', 'mcp', 'server.js'),
    relayUrl: e.HARBOR_WB_VRPC_RELAY_URL || '',
    engineUrl: e.HARBOR_WB_VRPC_ENGINE_URL || '',
    /* The file the VRPC's hooks and skills already read for the server engine
       bearer (CLAUDE.md 2026-09-17: `secrets/homebase-engine.token` in the VRPC
       checkout, gitignored). */
    tokenFile: e.HARBOR_WB_VRPC_TOKEN_FILE || winPath('F:', 'code', 'briefing-table', 'secrets', 'homebase-engine.token'),
    /* '' = the pane user's %TEMP% on the VRPC. */
    dir: e.HARBOR_WB_VRPC_MCP_DIR || '',
  };
}

/** PowerShell single-quoted literal: nothing inside is special but `'`. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The PowerShell variable the prelude leaves the config path in. */
export const VRPC_CONFIG_VAR = '$hwbMcp';

/** Is this a VRPC-broker-resident pane (the relayed case)? */
export function isVrpcRelayTarget(t: Target): boolean {
  return !t.sshClient && t.kind === 'local' && t.broker === vrpcDefaults().broker && !ptyRunsHere(t);
}

export type VrpcPlan =
  | { on: true; configRef: string; prelude: string; config: McpConfig }
  | { on: false; reason: string };

/** Pure: the relayed launch for a VRPC pane — config + the typed prelude. */
export function planVrpcLaunch(p: {
  enabled: boolean;
  vendor: string;
  shell: string | undefined;
  paneid: string;
  slug: string | null;
  v: ReturnType<typeof vrpcDefaults>;
}): VrpcPlan {
  if (!p.enabled) return { on: false, reason: 'off' };
  if (p.vendor !== 'claude-code') return { on: false, reason: 'vendor' };
  /* The prelude is PowerShell syntax: any other shell would run garbage. */
  if (!/(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(p.shell ?? '')) return { on: false, reason: 'shell' };
  const env: Record<string, string> = {
    FABRIC_CHANNEL: '1',
    // Relay mode acks on emit: the engine cannot read a VRPC transcript, so
    // the relayed `delivered` frame IS the receipt (channels.routeFabric).
    FABRIC_CHANNEL_ACK: 'emit',
    FABRIC_RELAY_URL: p.v.relayUrl,
    HARBOR_WB_ENGINE_URL: p.v.engineUrl,
    FABRIC_TOKEN_FILE: p.v.tokenFile,
    HARBOR_WB_PANEID: p.paneid,
  };
  if (p.slug) env.HARBOR_WB_SLUG = p.slug;
  const config: McpConfig = { mcpServers: { fabric: { command: p.v.nodeExe, args: [p.v.mcpServer], env } } };
  const b64 = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const dirExpr = p.v.dir ? psQuote(p.v.dir) : '$env:TEMP';
  const prelude =
    `${VRPC_CONFIG_VAR} = Join-Path ${dirExpr} ${psQuote(`hwb-mcp-${safePaneFile(p.paneid)}`)}; ` +
    `[IO.File]::WriteAllText(${VRPC_CONFIG_VAR}, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
  return { on: true, configRef: VRPC_CONFIG_VAR, prelude, config };
}

/** What buildLaunch needs for a relayed pane: the config reference for the
 *  flags, and the prelude typed before the claude line. */
export interface ChannelLaunch {
  configRef: string;
  prelude: string;
}

const skipLogged = new Set<string>();

function logSkip(paneid: string, reason: string, target: Target): void {
  if (reason === 'off' || reason === 'vendor') return;
  const key = `${paneid}:${reason}`;
  if (!skipLogged.has(key)) {
    skipLogged.add(key);
    log(`launch ${paneid}: no channel (${reason}${reason === 'mcp-missing' ? ` ${MCP_SERVER()}` : ''}; target ${target.id})`);
  }
}

/**
 * Impure half, called by the spawn path right before buildLaunch: decides,
 * writes the config (0600) and starts the dialog watcher. Returns the config
 * path to hand buildLaunch (server-local), a ChannelLaunch (VRPC, relayed), or
 * null (today's launch, unchanged). Never throws: a channel that cannot be
 * set up is a pane launched the old way.
 */
/* The inputs a spawn would plan with, assembled ONCE for both callers: the
   spawn path (prepareLaunch, which then writes the config and arms the
   watcher) and readiness's `channel.possible` (channelPossible, which must
   never do either — the design notes §4.1). */
type SpawnFacts = { vendor: string; target: Target; paneid: string; slug: string | null };

function vrpcPlanFor(o: SpawnFacts): VrpcPlan {
  return planVrpcLaunch({ enabled: enabled(), vendor: o.vendor, shell: o.target.shell, paneid: o.paneid, slug: o.slug, v: vrpcDefaults() });
}

function localPlanFor(o: SpawnFacts): LaunchPlan {
  return planLaunch({
    enabled: enabled(),
    vendor: o.vendor,
    runsHere: ptyRunsHere(o.target),
    mcpExists: existsSync(MCP_SERVER()),
    mcpServer: MCP_SERVER(),
    dir: configDir(),
    paneid: o.paneid,
    slug: o.slug,
    enginePort: enginePort(),
    fabricUrl: process.env.HARBOR_WB_FABRIC_URL && !networkServicesRefused() ? fabricBase() : undefined,
  });
}

/** Would a (re)spawn of this pane carry the channel? PURE planning only — no
 *  config written, no watcher armed. `reason` is the coordination's (`off`,
 *  `vendor`, `not-local`, `mcp-missing`, `unsafe-path`, `shell`). */
export function channelPossible(o: SpawnFacts): { possible: boolean; reason: string | null } {
  const plan = isVrpcRelayTarget(o.target) ? vrpcPlanFor(o) : localPlanFor(o);
  return plan.on ? { possible: true, reason: null } : { possible: false, reason: plan.reason };
}

export function prepareLaunch(o: SpawnFacts): string | ChannelLaunch | null {
  if (isVrpcRelayTarget(o.target)) {
    try {
      const plan = vrpcPlanFor(o);
      if (!plan.on) {
        logSkip(o.paneid, plan.reason, o.target);
        return null;
      }
      startWatch(o.paneid);
      log(`launch ${o.paneid}: channel on (VRPC relay, config written by the typed prelude)`);
      return { configRef: plan.configRef, prelude: plan.prelude };
    } catch (e) {
      log(`launch ${o.paneid}: VRPC channel setup failed, launching without: ${(e as Error).message}`);
      return null;
    }
  }
  try {
    const plan = localPlanFor(o);
    if (!plan.on) {
      logSkip(o.paneid, plan.reason, o.target);
      return null;
    }
    mkdirSync(dirname(plan.configPath), { recursive: true, mode: 0o700 });
    writeFileSync(plan.configPath, JSON.stringify(plan.config, null, 2) + '\n', { mode: 0o600 });
    startWatch(o.paneid);
    log(`launch ${o.paneid}: channel on (${plan.configPath})`);
    return plan.configPath;
  } catch (e) {
    log(`launch ${o.paneid}: channel setup failed, launching without: ${(e as Error).message}`);
    return null;
  }
}

/* ======================================================= 2. dialog accept == */

/** Every escape sequence becomes whitespace (the TUI spaces words with cursor
 *  moves); a trailing INCOMPLETE sequence is carried to the next chunk. */
const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const ESC_INCOMPLETE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;

export function normalise(s: string): string {
  return s.replace(ESC_SEQ, ' ').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ');
}

export const DIALOG_TEXT = 'Loading development channels';
/** GUARD 6a (assemble-room §4.4): the dialog's option line. The title alone
 *  never arms — it must be in the same frame as this line (within FRAME_CHARS
 *  normalised characters after the title), which the title quoted in a
 *  replayed conversation or an error message is not. */
export const OPTION_TEXT = 'I am using this for local development';
const FRAME_CHARS = 800;
/** The workspace-trust dialog. Its default is "No, exit": an Enter there ends
 *  the session, so its appearance DISARMS a pending accept. */
const TRUST_TEXT = /Quick safety check|trust this folder|Accessing workspace/;
/** GUARD 6b: the old-session dialog (default "Resume from summary" COMPACTS).
 *  It follows dev-channels (F5), so seeing it after arming means the dialog
 *  was answered without us: the pending write is cancelled for good. */
const OLD_SESSION_TEXT = /Resume from summary|Resume full session/;

/** `human-answered` (guard 6c): a human keystroke (or the next dialog, 6b)
 *  arrived while the accept was pending — the engine never writes. */
export type DialogState = 'not-seen' | 'armed' | 'accepted' | 'timeout' | 'human-answered';

/** GUARD 6d: what the startup gate's normalised stream says right now — its
 *  position counter (OSC title blinks do not advance it) and its latest prompt
 *  kind. Null = no gate to ask: the watcher settles on its own clock. */
export type GateView = { pos: number; kind: string | null } | null;

export class DialogWatcher {
  state: DialogState = 'not-seen';
  private carry = '';
  private seen = '';
  private afterArm = '';
  private armedAt = 0;
  private windowStart: number;
  /** Guard 6d: the gate position last seen and when it last moved. */
  private gatePos = -1;
  private quietSince = 0;
  /** A trust dialog is up: a HUMAN is answering it and may take any time, so
   *  the window cannot expire until the channel dialog appears (or the pane
   *  ends). Live VRPC probe 2026-09-25: the watcher timed out behind it. */
  private trustPending = false;

  constructor(
    now: number,
    private readonly windowMs = 60_000,
    private readonly settleMs = 400,
  ) {
    this.windowStart = now;
  }

  /** Feed pty output. Returns 'write' at most once: the dialog (title AND its
   *  option line, 6a) has been seen, then the stream has been QUIET for
   *  SETTLE_MS (6d) with no trust or old-session dialog in between (an Enter
   *  sent while the dialog is still rendering is swallowed — probe fact). The
   *  engine's timer calls tick() so a dialog followed by silence still fires. */
  feed(chunk: string, now: number, gate: GateView = null): 'write' | null {
    if (this.state !== 'not-seen' && this.state !== 'armed') {
      return null;
    }
    let raw = this.carry + chunk;
    const m = ESC_INCOMPLETE.exec(raw);
    this.carry = m && m[0].length ? m[0] : '';
    if (this.carry) {
      raw = raw.slice(0, raw.length - this.carry.length);
    }
    const text = normalise(raw);
    if (this.state === 'not-seen') {
      this.seen = (this.seen + text).replace(/\s+/g, ' ');
      if (TRUST_TEXT.test(this.seen) && !this.seen.includes(DIALOG_TEXT)) {
        // A human is answering the trust dialog; the channel dialog comes after.
        this.trustPending = true;
        this.windowStart = now;
        this.seen = this.seen.slice(-200);
        return null;
      }
      const at = frameEnd(this.seen);
      if (at < 0) {
        this.seen = this.seen.slice(-(FRAME_CHARS + DIALOG_TEXT.length + OPTION_TEXT.length));
        return this.tick(now, gate);
      }
      this.state = 'armed';
      this.trustPending = false;
      this.armedAt = now;
      this.gatePos = gate ? gate.pos : -1;
      this.quietSince = now;
      this.afterArm = this.seen.slice(at);
      this.seen = '';
    } else {
      this.afterArm = (this.afterArm + text).slice(-2000);
    }
    if (OLD_SESSION_TEXT.test(this.afterArm)) {
      this.state = 'human-answered'; // 6b: the dialog moved on without our Enter
      this.afterArm = '';
      return null;
    }
    if (TRUST_TEXT.test(this.afterArm)) {
      this.trustPending = true;
      this.state = 'not-seen';
      this.afterArm = '';
      this.windowStart = now;
      return null;
    }
    return this.tick(now, gate);
  }

  /** GUARD 6c: a human typed into the pane. While an accept is pending, the
   *  human is answering the dialog themselves: never write on top of it. */
  humanInput(): void {
    if (this.state === 'armed') {
      this.state = 'human-answered';
    }
  }

  /** Clock-driven transitions: settle after arming, window expiry. With a gate
   *  view (6d) the settle counts from the gate's LAST NEW CHARACTER, and the
   *  write waits while the gate's latest prompt is anything but dev-channels. */
  tick(now: number, gate: GateView = null): 'write' | null {
    if (this.state === 'armed') {
      if (gate && gate.pos !== this.gatePos) {
        this.gatePos = gate.pos;
        this.quietSince = now;
      }
      const quietFrom = gate ? Math.max(this.armedAt, this.quietSince) : this.armedAt;
      if (now - quietFrom >= this.settleMs && (!gate || gate.kind === 'dev-channels')) {
        this.state = 'accepted';
        return 'write';
      }
      /* Armed but never quiet on dev-channels for a whole window: something
         else is showing. Stop watching and never write (the composer rule then
         admits evidence, 6e — a missed accept must not hold lines forever). */
      if (now - this.armedAt >= this.windowMs) {
        this.state = 'timeout';
      }
      return null;
    }
    if (this.state === 'not-seen' && !this.trustPending && now - this.windowStart >= this.windowMs) {
      this.state = 'timeout';
    }
    return null;
  }
}

/** 6a: the end of the first option line that has the dialog title within
 *  FRAME_CHARS before it (the same frame), or -1. */
function frameEnd(seen: string): number {
  for (let i = seen.indexOf(OPTION_TEXT); i >= 0; i = seen.indexOf(OPTION_TEXT, i + 1)) {
    const title = seen.lastIndexOf(DIALOG_TEXT, i);
    if (title >= 0 && i - title <= FRAME_CHARS) {
      return i + OPTION_TEXT.length;
    }
  }
  return -1;
}

interface Watch {
  w: DialogWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
}
const watches = new Map<string, Watch>();
/** Last dialog outcome per pane, for diag (survives the watcher). */
const dialogOutcome = new Map<string, { state: DialogState; at: number }>();

const windowMs = (): number => Number(process.env.HARBOR_WB_CHANNEL_DIALOG_MS) || 60_000;

/* Guard 6d: the startup gate's view of the pane's stream, handed in by the
   server (startup-gate.streamOf) — no import, as with setStartupProbe. */
let gateProbe: (paneid: string) => GateView = () => null;
export function setGateProbe(fn: (paneid: string) => GateView): void {
  gateProbe = fn;
}

function gateView(paneid: string): GateView {
  try {
    return gateProbe(paneid);
  } catch {
    return null;
  }
}

/** The dev-channels dialog outcome of this pane's latest channel launch
 *  (`accepted` once the one Enter went out), or null if none was armed. Read by
 *  the startup block (startup-gate.ts): a channel launch is not past startup
 *  until this dialog is. */
export function dialogStateOf(paneid: string): DialogState | null {
  return dialogOutcome.get(paneid)?.state ?? null;
}

function startWatch(paneid: string): void {
  stopWatch(paneid);
  const now = Date.now();
  const w: Watch = { w: new DialogWatcher(now, windowMs()), timer: null, startedAt: now };
  watches.set(paneid, w);
  dialogOutcome.set(paneid, { state: 'not-seen', at: now });
  schedule(paneid, w, windowMs() + 50);
}

function stopWatch(paneid: string): void {
  const w = watches.get(paneid);
  if (w?.timer) clearTimeout(w.timer);
  watches.delete(paneid);
}

function schedule(paneid: string, w: Watch, ms: number): void {
  if (w.timer) clearTimeout(w.timer);
  w.timer = setTimeout(() => {
    w.timer = null;
    try {
      settle(paneid, w, w.w.tick(Date.now(), gateView(paneid)));
    } catch (e) {
      log(`dialog tick threw for ${paneid}: ${(e as Error).message}`);
    }
  }, Math.max(20, ms));
  w.timer.unref?.();
}

function settle(paneid: string, w: Watch, r: 'write' | null): void {
  if (r === 'write') {
    writeAccept(paneid);
  }
  dialogOutcome.set(paneid, { state: w.w.state === 'armed' ? 'not-seen' : w.w.state, at: Date.now() });
  if (w.w.state === 'accepted' || w.w.state === 'timeout' || w.w.state === 'human-answered') {
    if (w.w.state === 'timeout') {
      log(`dialog ${paneid}: not accepted within ${windowMs()} ms — nothing written`);
    } else if (w.w.state === 'human-answered') {
      log(`dialog ${paneid}: answered in the window before the engine's Enter — nothing written`);
    }
    stopWatch(paneid);
  } else if (w.w.state === 'armed') {
    schedule(paneid, w, 100); // 6d: re-read the gate's position until it goes quiet
  } else {
    schedule(paneid, w, windowMs() - (Date.now() - w.startedAt) + 50);
  }
}

function writeAccept(paneid: string): void {
  const r = sessions.get(paneid);
  if (!r || !sessions.isLive(r)) {
    log(`dialog ${paneid}: seen but no live pty — nothing written`);
    return;
  }
  // The same write viewer input and room-typer use (a keystroke to the broker).
  engineWrite(paneid, r.cli.pty, '\r', 'dialog');
  log(`dialog ${paneid}: "${DIALOG_TEXT}" seen — accepted (one Enter)`);
}

/** Wire from the pty onData pump. Cheap when no watcher is armed. */
export function onPtyData(paneid: string, data: string): void {
  const w = watches.get(paneid);
  if (!w) return;
  try {
    const r = w.w.feed(data, Date.now(), gateView(paneid));
    settle(paneid, w, r);
  } catch (e) {
    log(`dialog feed threw for ${paneid}: ${(e as Error).message}`);
  }
}

/** GUARD 6c: a human TYPED into the pane (the caller has excluded focus and
 *  mouse reports). Cancels a pending accept. Cheap when no watcher is armed. */
export function onHumanInput(paneid: string): void {
  const w = watches.get(paneid);
  if (!w || w.w.state !== 'armed') return;
  try {
    w.w.humanInput();
    settle(paneid, w, null);
  } catch (e) {
    log(`dialog human input threw for ${paneid}: ${(e as Error).message}`);
  }
}

/* ============================================================== 3. routing == */

export type Path = 'typed' | 'channel' | 'badge' | 'typed-fallback';

/** Pure: does this line go through the channel instead of being typed?
 *  EXACTLY ONE DELIVERY PATH PER LINE (S0 ride fix, guard 10). The pane's own
 *  fabric-mcp pump pushes every envelope for its slug whenever its socket is
 *  open — it never asks the engine — so a channel-live pane gets the line
 *  through the channel whatever the engine decides. Typing a copy as well
 *  (the first cut of guard 10 did, for a startup-blocked pane) made claude
 *  receive each line twice. So startup does NOT change the route; guard 10
 *  lives in routeFabric instead: the confirm window (and so the typed
 *  fallback) starts only once the pane is past startup. A channel landing
 *  during the old-session dialog (F24) can only be held where the push
 *  happens — fabric-mcp — not here. */
export function routeDecision(p: {
  enabled: boolean;
  channel: boolean;
  author: string;
  kind: 'room' | 'fabric';
  roomViaFabric: boolean;
}): 'channel' | 'typed' {
  if (!p.enabled || !p.channel) return 'typed';
  if (p.kind === 'room') {
    // The human's words stay user-role: a channel arrival mid-turn is demoted.
    if (p.author === 'user') return 'typed';
    return p.roomViaFabric ? 'channel' : 'typed';
  }
  return 'channel';
}

/* Guard 10: is this pane still held by the startup block? Handed in by the
   server (startup-gate.isBlocked), the way startup-gate's dialog probe is —
   no import, so channels.ts and startup-gate.ts never import each other.
   Read by routeFabric only: a channel envelope's confirm window waits for it. */
let startupProbe: (paneid: string) => boolean = () => false;
export function setStartupProbe(fn: (paneid: string) => boolean): void {
  startupProbe = fn;
}

function startupBlocked(paneid: string): boolean {
  try {
    return startupProbe(paneid);
  } catch {
    return false; // could not tell: confirm as today
  }
}

const PRESENCE_TTL_MS = 5_000;
/* `known` = the fabric ANSWERED (2xx). channelLive's boolean still collapses
   "could not tell" into false (its callers route on it and must not wait);
   `channelState` below keeps the third outcome for a surface that shows it. */
const presenceCache = new Map<string, { at: number; channel: boolean; known: boolean }>();

/** `GET /presence?paneid=` → channel:boolean. Any failure is `false`. */
export async function channelLive(paneid: string): Promise<boolean> {
  const hit = presenceCache.get(paneid);
  if (hit && Date.now() - hit.at < PRESENCE_TTL_MS) return hit.channel;
  const base = fabricBase();
  let channel = false;
  let known = false;
  if (base) {
    try {
      const res = await fetch(`${base}/presence?paneid=${encodeURIComponent(paneid)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) {
        const j = (await res.json()) as { channel?: unknown };
        channel = j.channel === true;
        known = true;
      }
    } catch {
      channel = false;
      known = false;
    }
  }
  presenceCache.set(paneid, { at: Date.now(), channel, known });
  return channel;
}

/**
 * THREE OUTCOMES for a surface (a room seat's `occupant.channel`, roster
 * verbs 2026-09-25): true = the pane's MCP holds a live channel, false = the
 * fabric answered and it does not, null = could not tell (channels off, no
 * fabric configured, fabric unreachable or not answering 2xx, or not asked
 * yet). NEVER blocks: answers from the cache and, when stale or missing,
 * starts the same refresh `cachedChannel` does — the next read has it.
 */
export function channelState(paneid: string): boolean | null {
  if (!enabled() || !fabricBase()) return null;
  const hit = presenceCache.get(paneid);
  if (!hit || Date.now() - hit.at >= PRESENCE_TTL_MS) {
    void channelLive(paneid).catch(() => {});
  }
  return hit && hit.known ? hit.channel : null;
}

/** The last known answer without asking (rooms route is synchronous). */
export function cachedChannel(paneid: string): boolean {
  const hit = presenceCache.get(paneid);
  if (!hit || Date.now() - hit.at >= PRESENCE_TTL_MS) {
    void channelLive(paneid).catch(() => {});
    return hit?.channel ?? false;
  }
  return hit.channel;
}

/** Room hook: true = do NOT type this room line (the channel carries it). */
export function skipRoomTyping(paneid: string, author: string): boolean {
  if (!enabled()) return false;
  return (
    routeDecision({
      enabled: true,
      channel: cachedChannel(paneid),
      author,
      kind: 'room',
      roomViaFabric: roomLinesViaFabric(),
    }) ===
    'channel'
  );
}

const counts: Record<'room' | 'fabric', Record<Path, number>> = {
  room: { typed: 0, channel: 0, badge: 0, 'typed-fallback': 0 },
  fabric: { typed: 0, channel: 0, badge: 0, 'typed-fallback': 0 },
};
const acks = { delivered: 0, conflict: 0, failed: 0 };

export function notePath(kind: 'room' | 'fabric', path: Path): void {
  counts[kind][path]++;
}

/** A typed-copy result as a delivery path. */
export function pathOfTyped(typed: string): Path {
  return typed === 'injected' || typed === 'queued' ? 'typed' : typed === 'channel' ? 'channel' : 'badge';
}

async function ackDelivered(id: string): Promise<void> {
  const base = fabricBase();
  if (!base) return;
  try {
    const res = await fetch(`${base}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, level: 'delivered' }),
      signal: AbortSignal.timeout(3_000),
    });
    if (res.status === 409) acks.conflict++; // already further up the ladder: benign
    else if (res.ok) acks.delivered++;
    else {
      acks.failed++;
      log(`ack delivered ${id} → HTTP ${res.status}`);
    }
  } catch (e) {
    acks.failed++;
    log(`ack delivered ${id}: ${(e as Error).message}`);
  }
}

/**
 * Fabric hook (fabric.deliver). OFF → `typeIt()` synchronously, exactly as
 * before. ON → ask presence; channel down → type; channel up → wait for the
 * transcript enqueue, ack `delivered`, or fall back to typing. With channels
 * ON the engine's `delivered` ack for an envelope is issued HERE (the
 * subscriber defers to it), once the path is known.
 */
export function routeFabric(paneid: string, env: { id: string; from?: string }, typeIt: () => string): string {
  if (!enabled()) {
    return typeIt();
  }
  const transcript = transcriptFor(paneid);
  const startAt = transcript ? sizeOf(transcript) : 0;
  inFlight.set(paneid, (inFlight.get(paneid) ?? 0) + 1);
  /* Down ONCE, at hand-off — the moment typeIt() has put the envelope in
     room-typer's queue (where readiness counts it) or typed it, or claude has
     been seen enqueuing it — not after the ack (review finding #10: a held
     envelope counted twice, a typed one kept counting). `finally` covers a
     throw before the hand-off; the flag stops it counting down twice. */
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const n = (inFlight.get(paneid) ?? 1) - 1;
    if (n > 0) inFlight.set(paneid, n);
    else inFlight.delete(paneid);
  };
  void (async () => {
    try {
      const channel = await channelLive(paneid);
      const route = routeDecision({
        enabled: true,
        channel,
        author: env.from ?? '',
        kind: 'fabric',
        roomViaFabric: roomLinesViaFabric(),
      });
      if (route === 'typed') {
        const t = typeIt();
        release();
        notePath('fabric', pathOfTyped(t));
        await ackDelivered(env.id);
        return;
      }
      /* GUARD 10: a pane still in startup cannot show the enqueue yet (claude
         is on a dialog), so a confirm window running now would time out and
         TYPE a copy the pump has already queued. Wait for the gate first; the
         transcript is then read from the size at routing time, so an enqueue
         written meanwhile is still found (a relayed pane's ack is listened for
         WHILE waiting: the relay remembers acks for a minute only). A pane
         that ends drops its gate. */
      let relayAcked = false;
      if (startupBlocked(paneid)) {
        log(`fabric ${paneid}: channel live but the pane is in startup - confirm window waits for it`);
        while (startupBlocked(paneid)) {
          if (fabricRelay.hasRelay(paneid)) {
            if (await fabricRelay.waitAck(env.id, STARTUP_POLL_MS)) {
              relayAcked = true;
              break;
            }
          } else {
            await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
          }
        }
      }
      /* A RELAYED pane (VRPC, fabric-relay.ts) has its transcript on another
         host's disk; its MCP acks `delivered` on emit through the relay, and
         that frame is the receipt. Without this every relayed message would
         time out here and be typed as well. */
      const got = relayAcked
        ? true
        : fabricRelay.hasRelay(paneid)
        ? await fabricRelay.waitAck(env.id, confirmMs())
        : transcript
          ? await waitForEnqueue(transcript, startAt, env.id, confirmMs())
          : false;
      if (got) {
        notePath('fabric', 'channel');
        log(`fabric ${paneid}: channel enqueue confirmed`);
      } else {
        const t = typeIt();
        notePath('fabric', 'typed-fallback');
        log(`fabric ${paneid}: no channel enqueue within ${confirmMs()} ms${transcript ? '' : ' (no transcript known)'} — typed-fallback (${t})`);
      }
      release();
      await ackDelivered(env.id);
    } catch (e) {
      log(`fabric route threw for ${paneid}: ${(e as Error).message}`);
    } finally {
      release();
    }
  })();
  return 'channel-check';
}

/* Envelopes routeFabric has accepted for a pane and not yet handed off —
   typed, queued in room-typer, or seen enqueued by claude (readiness
   `queued.fabric`, assemble-room §4.1): up at entry, down at hand-off, so a
   route still deciding counts as queued and nothing is counted twice. */
const inFlight = new Map<string, number>();

/** routeFabric calls still deciding for this pane. */
export function inFlightFor(paneid: string): number {
  return inFlight.get(paneid) ?? 0;
}

const confirmMs = (): number => Number(process.env.HARBOR_WB_CHANNEL_CONFIRM_MS) || 10_000;
const STARTUP_POLL_MS = 250;

/* ============================================================== 4. receipt == */

/**
 * Pure: finds claude's `queue-operation / enqueue` record of one envelope in a
 * transcript byte stream. Lines may be split across reads; other ids, other
 * operations, and an id merely QUOTED in a message body never match — the id
 * must be an attribute of the opening `<channel …>` tag.
 */
export class EnqueueMatcher {
  private partial = '';
  constructor(private readonly id: string) {}

  feed(chunk: string): boolean {
    const text = this.partial + chunk;
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (this.matches(line)) return true;
    }
    return false;
  }

  matches(line: string): boolean {
    if (!line.includes('queue-operation')) return false;
    let j: { type?: unknown; operation?: unknown; content?: unknown };
    try {
      j = JSON.parse(line);
    } catch {
      return false;
    }
    if (j.type !== 'queue-operation' || j.operation !== 'enqueue' || typeof j.content !== 'string') return false;
    const tag = /^\s*<channel\b[^>]*>/.exec(j.content);
    return !!tag && tag[0].includes(` id="${this.id}"`);
  }
}

/* A SEAT WORKTREE pane runs claude in the worktree, so its transcript is under
   the WORKTREE's encoded dir, not the project's (night test 2026-10-06: every
   fabric message to ap-dev / ap-studio was confirmed by nothing and typed a
   second time 10 s later, after the agent had already answered the channel copy). */
export function transcriptFor(paneid: string): string | null {
  const row = table.get(paneid);
  if (!row || !row.session_id || !row.project) return null;
  const wt = table.getSessionWorktree(paneid);
  return claudeCode.transcriptPath(wt ? worktreePath(wt.project, wt.name) : row.project, row.session_id);
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** How far back to look from the size seen at routing time: the MCP can queue
 *  the message before the engine's presence check returns. Ids are unique, so
 *  rescanning a little history is harmless. */
const LOOKBACK = 64 * 1024;

export async function waitForEnqueue(path: string, sizeAtRoute: number, id: string, timeoutMs: number): Promise<boolean> {
  const m = new EnqueueMatcher(id);
  let pos = Math.max(0, sizeAtRoute - LOOKBACK);
  let first = pos > 0; // a lookback start lands mid-line: drop that fragment
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const size = sizeOf(path);
    if (size > pos) {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(size - pos);
        readSync(fd, buf, 0, buf.length, pos);
        pos = size;
        let s = buf.toString('utf8');
        if (first) {
          const nl = s.indexOf('\n');
          s = nl < 0 ? '' : s.slice(nl + 1);
          first = nl < 0;
        }
        if (m.feed(s)) return true;
      } finally {
        closeSync(fd);
      }
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ================================================================= diag ===== */

export function onPaneEnded(paneid: string): void {
  stopWatch(paneid);
  presenceCache.delete(paneid);
}
sessions.onRemove(onPaneEnded);

/** Counts only. */
export function diag(): Record<string, unknown> {
  const dialog: Record<string, unknown> = {};
  for (const [paneid, d] of dialogOutcome) dialog[paneid] = { channelDialog: d.state, at: d.at };
  const presence: Record<string, unknown> = {};
  for (const [paneid, p] of presenceCache) presence[paneid] = { channel: p.channel, ageMs: Date.now() - p.at };
  return {
    enabled: enabled(),
    roomLinesViaFabric: roomLinesViaFabric(),
    mcpServer: MCP_SERVER(),
    mcpPresent: existsSync(MCP_SERVER()),
    configDir: configDir(),
    paths: counts,
    acks,
    dialog,
    presence,
  };
}

/** Tests only. */
export function reset(): void {
  for (const w of watches.values()) if (w.timer) clearTimeout(w.timer);
  watches.clear();
  dialogOutcome.clear();
  presenceCache.clear();
  skipLogged.clear();
  inFlight.clear();
  for (const k of ['room', 'fabric'] as const) for (const p of Object.keys(counts[k]) as Path[]) counts[k][p] = 0;
  acks.delivered = acks.conflict = acks.failed = 0;
}

/** Tests only: seed the presence cache. */
export function _setPresence(paneid: string, channel: boolean): void {
  presenceCache.set(paneid, { at: Date.now(), channel, known: true });
}
