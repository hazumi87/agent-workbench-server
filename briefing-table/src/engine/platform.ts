/**
 * runtime helpers (Phase 1, the migration plan §4) — the one
 * place that knows which host the engine is running on, so launch.ts /
 * vendors/claude-code.ts / project-dir.ts don't each re-derive it.
 *
 * GOAL: the engine can run unchanged on Linux later; TODAY (Windows VRPC) its
 * behaviour must stay identical. Nothing here changes what happens on Windows.
 */
export const isWindows = process.platform === 'win32';

/**
 * ssh binary name to spawn for THIS host.
 *
 * 2026-07-07 Discovery (CLAUDE.md): node-pty on Windows does NOT append `.exe`
 * or do a PATH search the way child_process does — a bare `ssh` throws
 * "File not found" even though `where ssh` resolves it. `ssh.exe` works.
 * Elsewhere (Linux/macOS) a bare `ssh` resolves via PATH normally, so the
 * `.exe` suffix is Windows-only.
 */
export function sshBinary(): string {
  return isWindows ? 'ssh.exe' : 'ssh';
}
