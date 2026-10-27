/* E1 LAUNCH INJECTION: how a pane on THIS host gets the bt room tools (the design notes sections 3-4). Pure planning plus the two files it writes:
 *   <pane>.bt.json   the MCP config Claude loads (--mcp-config). NO token in it: a headersHelper prints the Authorization header from the pane's token FILE.
 *   <pane>.role.md   ONE append file: the person's role file first, then the engine's seat context (--append-system-prompt-file).
 * Codex -c keys name the URL and either the token ENV VAR (local mode or explicit seat-account env delivery) or a private file-reading headers helper.
 * Every file is 0600 and is removed with the pane (removeFiles). The token itself is minted by pane-tokens.ts; this file only ever names where it is. */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, safePaneFile } from './channels.ts';
import { TOKEN_ENV } from './pane-tokens.ts';
import { isLocalMode } from './local-mode.ts';
import { TOOL_NAMES } from '../server/bt-mcp.ts';

const ROLE_MAX = 64 * 1024;

export type BtPlan =
  | { on: true; vendor: 'claude-code' | 'codex-cli'; paneid: string; port: number; tokenFile: string; dir: string; envToo: boolean; tokenInEnv: boolean }
  | { on: false; reason: string };

/** Pure: should this spawn carry the bt tools, and for which vendor. */
export function planBt(p: {
  enabled: boolean;
  vendor: string;
  runsHere: boolean;
  port: number;
  paneid: string;
  tokenFile: string;
  /** the pane's token rides its ENV only (HARBOR_WB_PANE_TOKEN_DELIVERY=env: the pane's account is not the engine's), so nothing the pane must read may sit in the engine's config dir */
  tokenInEnv?: boolean;
  dir?: string;
  role?: string | null;
}): BtPlan {
  if (!p.enabled) return { on: false, reason: 'off' };
  if (p.vendor !== 'claude-code' && p.vendor !== 'codex-cli') return { on: false, reason: 'vendor-unsupported' };
  if (!p.runsHere) return { on: false, reason: 'not-local' };
  if (!(p.port > 0)) return { on: false, reason: 'no-port' };
  /* Default server delivery keeps the bearer in its private file. Explicit tokenInEnv delivery is the separately approved seat-account boundary: use only the broker spawn env, never argv or a config file. */
  const local = isLocalMode(process.env);
  return { on: true, vendor: p.vendor, paneid: p.paneid, port: p.port, tokenFile: p.tokenFile, dir: p.dir ?? configDir(), envToo: p.vendor === 'codex-cli' && local, tokenInEnv: !!p.tokenInEnv };
}

const fileFor = (dir: string, paneid: string, ext: string): string => join(dir, safePaneFile(paneid).replace(/[.]json$/, ext));
export const btConfigPath = (paneid: string, dir = configDir()): string => fileFor(dir, paneid, '.bt.json');
export const codexHelperPath = (paneid: string, dir = configDir()): string => fileFor(dir, paneid, '.bt-headers.sh');
export const rolePathFor = (paneid: string, dir = configDir()): string => fileFor(dir, paneid, '.role.md');

/** A path as one word for the shell the pane's line is typed into (PowerShell on Windows, a POSIX shell elsewhere). */
function q(s: string): string {
  return process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** POSIX single-quote, on EVERY platform: the headersHelper runs in the shell Claude uses for helper commands (Git Bash on Windows), not in the PowerShell the
 *  launch line is typed into. `q()` above is for the typed line only. */
function posixQ(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Same, for a pane whose token is in its ENV only: the helper reads $HARBOR_WB_PANE_TOKEN (inherited from the CLI that runs it), never a file. */
function headersHelperEnv(): string {
  /* no single quote anywhere in it: it rides a single-quoted argv word, and the hosted direct-argv splitter refuses the '\'' escape */
  return `printf "{\\"Authorization\\":\\"Bearer %s\\"}" "$${TOKEN_ENV}"`;
}

/** The command a client runs to learn the Authorization header: print it as JSON, reading the token from its FILE at call time. */
function headersHelper(tokenFile: string): string {
  const f = tokenFile.split(String.fromCharCode(92)).join('/'); // Git Bash and POSIX shells both accept forward slashes
  return `printf '{"Authorization":"Bearer %s"}' "$(cat ${posixQ(f)})"`;
}

function writePrivate(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  rmSync(file, { force: true });
  writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
}

export interface BtWritten {
  configPath: string;
  /** the flags for a claude line ('' for codex) */
  claudeArgs: string;
  /** the flags for a codex line ('' for claude) */
  codexArgs: string;
}

/** Write what the plan needs (the claude config; nothing for codex) and return the command-line pieces. */
export function writeBtConfig(plan: Extract<BtPlan, { on: true }>, opts: { mergeInto?: string } = {}): BtWritten {
  const url = `http://127.0.0.1:${plan.port}/mcp`;
  const configPath = btConfigPath(plan.paneid, plan.dir);
  if (plan.vendor === 'codex-cli') {
    const c = (k: string, v: string): string => `-c ${q(`mcp_servers.bt.${k}=${JSON.stringify(v)}`)}`;
    /* approval is PER TOOL over the pinned tool list (D-E1-4; includes room_post), never the blanket default_tools_approval_mode */
    const perTool = TOOL_NAMES.map((n) => c(`tools.${n}.approval_mode`, 'approve'));
    let auth: string;
    /* a token-in-env pane already has the token in its env (that is its delivery), and a helper script in the engine config dir would be unreadable to its account */
    if (plan.envToo || plan.tokenInEnv) auth = c('bearer_token_env_var', TOKEN_ENV);
    else {
      const helper = codexHelperPath(plan.paneid, plan.dir);
      writePrivate(helper, `#!/bin/sh\n${headersHelper(plan.tokenFile)}\n`);
      chmodSync(helper, 0o700);
      auth = c('http_headers_helper', helper);
    }
    return { configPath, claudeArgs: '', codexArgs: [c('url', url), auth, ...perTool].join(' ') };
  }
  const server = { type: 'http', url, headersHelper: plan.tokenInEnv ? headersHelperEnv() : headersHelper(plan.tokenFile) };
  /* ONE comma-joined value, never a space-separated list: `--allowedTools a b c` makes b and c bare words to the engine's own argv classifier (proc-classifier interactive():
     a bare word = a subcommand or a typed prompt), so claudeOwner() says "not-repl" and every ring is held for ever (the 2026-10-27 real-seat run). Claude accepts a comma-separated list. */
  const allowed = TOOL_NAMES.map((n) => `mcp__bt__${n}`).join(',');
  if (opts.mergeInto && plan.tokenInEnv) {
    /* the merge writes into a file the engine owns: a token-in-env pane's account could not read it. Hosted channels are OFF so this is unreachable today; refuse so a future channel switch cannot quietly bring the file back */
    throw new Error('bt config: a token-in-env pane cannot merge into a channel config file');
  }
  if (opts.mergeInto) {
    /* A pane that already carries the fabric channel config gets bt INSIDE that one file, and its tools are appended to the `--allowedTools` value the channel flags
       already opened (channelArgs ends with it): ONE --mcp-config and ONE --allowedTools on the line, never a repeated flag whose merge behaviour is unverified.
       launch.ts joins this continuation to that value with a comma (it never starts with a dash), so the list stays ONE word. */
    const cfg = JSON.parse(readFileSync(opts.mergeInto, 'utf8'));
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), bt: server };
    writeFileSync(opts.mergeInto, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    chmodSync(opts.mergeInto, 0o600); // the mode argument only applies on create
    return { configPath: opts.mergeInto, claudeArgs: allowed, codexArgs: '' };
  }
  if (plan.tokenInEnv) {
    /* The config holds NO secret (a url and a helper command), so it rides the argv inline: no file for the engine to leave in an account the pane cannot read. */
    return { configPath, claudeArgs: `--mcp-config ${q(JSON.stringify({ mcpServers: { bt: server } }))} --allowedTools ${allowed}`, codexArgs: '' };
  }
  writePrivate(configPath, JSON.stringify({ mcpServers: { bt: server } }, null, 2));
  return { configPath, claudeArgs: `--mcp-config ${q(configPath)} --allowedTools ${allowed}`, codexArgs: '' };
}

/** ONE append file per pane: the person's role (their agent folder's CLAUDE.md) FIRST, then the engine's seat context. Null when there is nothing to say.
 *  A missing or unreadable role file is just the seat context; an oversize one is cut (never copied whole). Never throws. */
export function writeRoleFile(paneid: string, o: { roleSource: string | null; seatContext: string; dir?: string }): string | null {
  let role = '';
  if (o.roleSource) {
    try {
      role = readFileSync(o.roleSource, 'utf8').slice(0, ROLE_MAX).trim();
    } catch {
      role = '';
    }
  }
  const text = [role, o.seatContext.trim()].filter(Boolean).join('\n\n');
  if (!text) return null;
  const file = rolePathFor(paneid, o.dir);
  try {
    writePrivate(file, `${text}\n`);
    return file;
  } catch {
    return null;
  }
}

/** INTERIM (the per-seat role key is not built yet, [ref]): the role file is the recipe's projectDir/CLAUDE.md, and only when that folder is one of the person's AGENT
 *  folders (`.../agents/<role>`) AND the seat runs somewhere else (a worktree), where Claude would not load it itself. A recipe whose projectDir is a code repo is
 *  skipped: its CLAUDE.md is the repo's, which Claude already loads from the worktree. */
export function roleSourceFor(projectDir: string | null | undefined, inWorktree: boolean): string | null {
  if (!projectDir || !inWorktree) return null;
  const parts = projectDir.split(/[/\\]/).filter(Boolean);
  if (parts.length < 2 || parts[parts.length - 2] !== 'agents') return null;
  return join(projectDir, 'CLAUDE.md');
}

export function claudeRoleArgs(roleFile: string): string {
  return `--append-system-prompt-file ${q(roleFile)}`;
}

/** The pane ended: its files go with it. Never throws. */
export function removeFiles(paneid: string, dir = configDir()): void {
  for (const f of [btConfigPath(paneid, dir), rolePathFor(paneid, dir), codexHelperPath(paneid, dir)]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* a file we cannot remove holds no secret */
    }
  }
}
