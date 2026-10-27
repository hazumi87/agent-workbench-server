/**
 * cli-host — generic CLI/PTY mechanics (Milestone 1).
 *
 * This is the TRIVIAL implementation of the component lifecycle (Contract B):
 * spawn a PTY from a vendor-agnostic descriptor, stream it, resize it, kill it.
 * No resume / handshake / locate-transcript — a bare local shell needs none of
 * those (blueprint: "a bare SSH shell implements a TRIVIAL version").
 *
 * SEAM (Contract B / decision 3 / Seam C1): the spawn path takes a DESCRIPTOR,
 * never a hardcoded "claude" or "powershell". When claude-code lands, its
 * vendor-specific mechanics (resume via --resume, the ACK handshake, locating
 * the .jsonl transcript for the session id) live in its OWN component module and
 * wrap/extend this host — they do NOT get bolted into this generic path. Keeping
 * that line drawn here is what makes vendor #2 a new module, not an untangle.
 */
import { spawn, type IPty } from 'node-pty';

/** A vendor-agnostic spawn descriptor (Contract B). */
export interface CliDescriptor {
  binary: string;
  args?: string[];
  cwd?: string | null;
  /** Env OVERRIDES layered on the spawning environment (R11: the engine tells a
   *  session who it is — HARBOR_WB_SLUG / HARBOR_WB_PANEID / HARBOR_WB_VENDOR).
   *  Still vendor-agnostic: the descriptor carries strings and knows nothing
   *  about what they mean. The pty-broker's spawn command already accepts the
   *  same field, so a broker-held session gets them the same way. */
  env?: Record<string, string>;
  // account, handshakeRules: part of the descriptor shape but unused by the
  // trivial shell. claude-code populates them. Left off the type until needed.
}

/** First-class session state. dehydrated|corrupted arrive with the table (M2+). */
export type SessionState = 'live' | 'killed';

export interface CliSession {
  readonly id: string;
  readonly pty: IPty;
  state: SessionState;
}

let seq = 0;

/**
 * The env a descriptor spawns with: this process's env, minus what must never
 * be INHERITED, with `desc.env` layered on top.
 *
 * - CLAUDE_CODE_CHILD_SESSION: if the ENGINE itself was launched from inside a
 *   Claude Code session (dev/test runs), a claude spawned here would inherit
 *   the marker, decide it's a child session, and DISABLE transcript saving
 *   ("Transcript saving is off"), which silently breaks crash restore. The
 *   panes this engine hosts are first-class user sessions, never children.
 * - HARBOR_WB_PANE_TOKEN / HARBOR_WB_PANE_TOKEN_FILE (review P2-6): an engine
 *   started from inside a pane would hand THAT pane's credential to every
 *   pane that gets no token of its own. A pane's token only ever arrives in
 *   `desc.env` (pane-tokens.ts). Names written out, not imported: this host
 *   stays generic and pane-tokens imports from here.
 */
export function spawnEnv(desc: CliDescriptor, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited = { ...base } as Record<string, string>;
  delete inherited.HARBOR_WB_PANE_TOKEN;
  delete inherited.HARBOR_WB_PANE_TOKEN_FILE;
  /* The broker's bearer is never meant for a pane in ANY mode, so it goes whether or not local mode is recognised here (fail closed). */
  delete inherited.HARBOR_WB_BROKER_TOKEN;
  delete inherited.HARBOR_WB_BROKER_TOKEN_FILE;
  delete inherited.PTY_BROKER_TOKEN;
  /* LOCAL MODE: the engine's own per-launch token is the whole credential for the engine's API; an agent shell must never inherit it.
     (service mode keeps its token in a file, not in the environment, so nothing changes there.) Names are not enough - a variable added
     later, or a launcher that copies the token into another name, would slip through - so any variable whose VALUE is one of the secrets
     goes too. */
  delete inherited.HARBOR_WB_WINDOW_AGENT_TOKEN; // the window-agent credential is no pane's either (any mode)
  delete inherited.HARBOR_WB_WINDOW_AGENT_TOKEN_FILE;
  /* HOSTED (security review H6) scrubs the same way: no engine secret reaches an agent's environment, by name or by value. */
  if ((base.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local' || base.HARBOR_WB_HOSTED === '1') {
    const secrets = [base.HARBOR_WB_TOKEN, base.HARBOR_WB_BROKER_TOKEN, base.PTY_BROKER_TOKEN].filter((v): v is string => typeof v === 'string' && v.length >= 8);
    delete inherited.HARBOR_WB_TOKEN;
    delete inherited.HARBOR_WB_TOKEN_FILE;
    for (const [k, v] of Object.entries(inherited)) {
      if (secrets.includes(v)) {
        delete inherited[k];
      }
    }
  }
  const env = { ...inherited, ...(desc.env ?? {}) };
  delete env.CLAUDE_CODE_CHILD_SESSION;
  return env;
}

/** Spawn a PTY from a descriptor. Caller wires pty.onData / onExit to a transport. */
export function spawnCli(
  desc: CliDescriptor,
  size: { cols: number; rows: number },
): CliSession {
  const env = spawnEnv(desc); // spawn-env hygiene: see spawnEnv
  const pty = spawn(desc.binary, desc.args ?? [], {
    name: 'xterm-color',
    cols: size.cols,
    rows: size.rows,
    cwd: desc.cwd ?? process.env.USERPROFILE ?? process.cwd(),
    env,
  });

  const session: CliSession = { id: `cli-${++seq}`, pty, state: 'live' };
  pty.onExit(() => {
    session.state = 'killed';
  });
  return session;
}

/** Terminal teardown (the `kill` verb). The id is gone; a real table would burn it. */
export function killCli(session: CliSession): void {
  if (session.state === 'live') {
    session.state = 'killed';
    try {
      session.pty.kill();
    } catch {
      /* already gone */
    }
  }
}
