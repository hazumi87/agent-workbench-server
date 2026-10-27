/* ============================================================================
 * BROKER PROTOCOL — the seam between a consuming engine and the PTY-broker.
 * The ENGINE (briefing-table) OWNS this spec; the broker satisfies it
 * (deployment contract posture: owner defines, external satisfies). Consumers
 * import these types from the pty-broker package (git-pinned npm dep) —
 * changing this file is a protocol change: bump PROTOCOL_VERSION, keep the
 * engine backward-compatible first, and obtain maintainer approval.
 *
 * Vocabulary mirrors the engine's internal PTY needs 1:1 on purpose: the
 * broker adds NO concepts of its own. `sid` is the broker session key — the
 * engine uses its paneid, tests use scratch ids.
 * ========================================================================== */

/** Bumped ONLY on breaking protocol change; served in /health, checked by the
 *  engine at connect (mismatch = loud failure, never weird behavior). */
export const PROTOCOL_VERSION = 1;

/** application → broker commands. */
export type BrokerCommand =
  | {
      type: 'spawn';
      sid: string;
      binary: string;
      args?: string[];
      cwd?: string;
      /** Env OVERRIDES layered on the broker's own (clean, login-shell) env. */
      env?: Record<string, string>;
      cols: number;
      rows: number;
    }
  | { type: 'attach'; sid: string }
  | { type: 'detach'; sid: string }
  | { type: 'input'; sid: string; data: string }
  | { type: 'resize'; sid: string; cols: number; rows: number }
  | { type: 'kill'; sid: string }
  | { type: 'list' };

/** Broker → client events. */
export type BrokerEvent =
  | { type: 'spawned'; sid: string; pid: number }
  | {
      type: 'attached';
      sid: string;
      /** Buffered output since spawn (capped) — replay to rebuild the screen. */
      replay: string;
      alive: boolean;
      exitCode?: number;
    }
  | { type: 'data'; sid: string; data: string }
  | { type: 'exit'; sid: string; code: number }
  | {
      type: 'list';
      sessions: Array<{
        sid: string;
        pid: number;
        alive: boolean;
        exitCode: number | null;
        createdAt: number;
        attached: boolean;
      }>;
    }
  | { type: 'error'; sid?: string; message: string };

export const BROKER_DEFAULT_PORT = 7430;
/** Replay buffer cap per session — same 256 KB the engine's M3 resident uses. */
export const REPLAY_CAP = 256 * 1024;
/** How long a session's tombstone (exit code + buffer) outlives the process. */
export const TOMBSTONE_MS = 10 * 60 * 1000;
