/**
 * PRE-LAUNCH VENDOR READINESS for the switch (the design notes §4). THREE OUTCOMES:
 *   confirmed logged in  -> ok
 *   confirmed logged out -> 'login-needed': a hard stop BEFORE the old assistant is ended (nothing has changed)
 *   could not tell       -> ok with a WARNING: the switch proceeds and the guarded post-launch screen detection
 *                           (prompt-block: Codex/Claude login and trust screens) is the safety net
 * File presence cannot establish login (Codex supports an OS credential store and a different CODEX_HOME), so this
 * runs the VENDOR'S OWN status command, bounded and read-only, in a LOGIN shell in the project folder, the way the
 * pane's own shell starts (so its PATH and profile are the pane's, not the engine's process PATH). `not-installed`
 * = the binary is absent from that shell. Quota is advisory and never decided here.
 *
 * UNVERIFIED AGAINST REAL INSTALLS (backlog, job 3): the status commands and their output shapes. `codex login
 * status` is Codex's documented subcommand; `claude auth status` is assumed. Any answer this module does not
 * recognise is "could not tell", never "logged in".
 */
import { spawn } from 'node:child_process';

export type Readiness =
  | { ok: true; warn?: string }
  | { ok: false; reason: 'login-needed' | 'not-installed' | 'unavailable'; message: string };

export const STATUS_COMMANDS: Record<string, { bin: string; args: string[]; label: string }> = {
  'codex-cli': { bin: 'codex', args: ['login', 'status'], label: 'Codex' },
  'claude-code': { bin: 'claude', args: ['auth', 'status'], label: 'Claude' },
};

export const PROBE_TIMEOUT_MS = 8_000;

/** Map a status command's exit and output to the three outcomes. Pure. */
export function readStatus(vendor: string, exit: number | null, out: string): Readiness {
  const label = STATUS_COMMANDS[vendor]?.label ?? vendor;
  if (exit === 127) {
    return { ok: false, reason: 'not-installed', message: `${label} is not installed for this account` };
  }
  const t = out.toLowerCase();
  if (/not logged in|logged out|login required|please (run )?\/?login|sign in to continue|no credentials/.test(t)) {
    return { ok: false, reason: 'login-needed', message: `${label} needs signing in before it can take over` };
  }
  if (exit === 0 && /logged in/.test(t)) {
    return { ok: true };
  }
  return { ok: true, warn: `could not confirm that ${label} is signed in; it will be checked as it starts` };
}

/** Run the status command for `vendor` in a login shell in `cwd`. Never throws. */
export function probeVendor(vendor: string, cwd: string | null, opts: { shell?: string; shellArgs?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Readiness> {
  const c = STATUS_COMMANDS[vendor];
  if (!c) {
    return Promise.resolve({ ok: true, warn: `no readiness check for ${vendor}` });
  }
  const script = `command -v ${c.bin} >/dev/null 2>&1 || exit 127; ${c.bin} ${c.args.join(' ')} 2>&1`;
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r: Readiness): void => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(opts.shell ?? 'bash', [...(opts.shellArgs ?? ['-lc']), script], { cwd: cwd ?? undefined, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      finish({ ok: true, warn: `could not run the ${c.label} check (${(e as Error).message}); it will be checked as it starts` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-(p.pid as number), 'SIGKILL'); // the whole group: an interactive shell's children too
      } catch {
        /* gone */
      }
      finish({ ok: true, warn: `the ${c.label} check did not answer in time; it will be checked as it starts` });
    }, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    p.stdout?.on('data', (d) => (out = (out + d).slice(-4000)));
    p.stderr?.on('data', (d) => (out = (out + d).slice(-4000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: true, warn: `could not run the ${c.label} check (${e.message}); it will be checked as it starts` });
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      finish(readStatus(vendor, code, out));
    });
  });
}
