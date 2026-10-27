/**
 * PROJECT DIR — normalise it silently, verify it out loud.
 *
 * WHY THIS EXISTS (Owner, 2026-09-13). Kiosk's recipe said
 * `/srv/code/kiosk/`. Claude's transcript dir is named after the process
 * CWD, which never carries a trailing separator, so that one character encoded
 * to `-srv-code-kiosk-` — a directory that does not exist — and every
 * transcript lookup for that pane read an empty path IN SILENCE. It showed up
 * as a session with no name for days, and the same encoding backs
 * `transcriptPath` and `locateCurrentSessionId`, so its restore was broken too.
 *
 * TWO JOBS, DELIBERATELY SEPARATE, because they have different rights:
 *
 *   normalise — a pure string fix for the mistakes that have exactly one
 *     correct answer (a trailing slash, stray whitespace, doubled separators).
 *     Applied on every write, no questions asked: there is nothing for a user
 *     to decide and nothing to gain by asking.
 *
 *   verify — "does this directory actually exist on that machine". This one is
 *     ADVISORY ONLY and must never refuse a save. A path can be legitimately
 *     absent: a project you are about to clone, a host that is asleep, a server
 *     off the tailnet. Refusing would turn a warning into an outage, and the
 *     failure this guards against is silence — so the fix is to SAY SO, not to
 *     take the decision away.
 *
 * The split matters more than either half: auto-fixing what is unambiguous is
 * what stops the warning channel filling with noise nobody reads.
 */
import { existsSync, statSync } from 'node:fs';
import { spawn as spawnProc } from 'node:child_process';
import { sshBinary } from './platform.ts';
import * as agentFs from './agent-fs.ts';

/**
 * The one true spelling of a project dir. Strips trailing separators, collapses
 * a doubled one, and trims whitespace — everything with a single right answer.
 *
 * ROOT AND A WINDOWS DRIVE ROOT ARE LEFT ALONE: `/` and `C:\` are the only
 * paths whose trailing separator IS the path, so stripping it would turn a real
 * location into an empty string or a bare drive letter.
 *
 * Deliberately NOT a resolve(): it never touches the filesystem, never expands
 * `~` or a relative path, and never changes which machine a path refers to. A
 * remote dir is normalised on the VRPC and must mean the same thing on the server.
 */
export function normalizeProjectDir(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) {
    return trimmed;
  }
  // Collapse runs of separators, but never the leading pair of a UNC path
  // (\\host\share), where the doubling is the syntax.
  const unc = /^[\\/]{2}/.test(trimmed);
  let out = trimmed.replace(/[\\/]{2,}/g, (m, at: number) => (unc && at === 0 ? m : m[0]));
  // `/`, `C:\`, `C:/` — the separator is the path.
  if (/^[\\/]$/.test(out) || /^[A-Za-z]:[\\/]$/.test(out)) {
    return out;
  }
  out = out.replace(/[\\/]+$/, '');
  return out || trimmed;
}

export interface DirCheck {
  /** null = we could not find out (host unreachable, timed out). NOT "missing". */
  exists: boolean | null;
  /** Populated only when `exists` is false or null — what to show the user. */
  warning?: string;
}

/**
 * Does this directory exist on the machine that would run the session?
 *
 * THREE OUTCOMES, NOT TWO. "I could not reach the host" is not "the directory
 * is missing", and collapsing them would cry wolf every time the server is asleep
 * — which is the fastest way to teach someone to ignore the warning that
 * matters. Unknown says so.
 */
export async function checkProjectDir(
  dir: string,
  opts: { sshAlias?: string; agentHost?: string; timeoutMs?: number } = {},
): Promise<DirCheck> {
  if (!dir) {
    return { exists: null };
  }
  if (opts.agentHost) {
    /* WINDOW-AGENT TRANSPORT (2026-09-18). A host we can reach a desktop on but
       not an ssh account. THE WARNING TEXT DIFFERS ON PURPOSE and the reason is
       in agentFs.checkProjectDir: the agent is nailed to claude's transcript
       root, so what it can verify is "claude has run in a dir that encodes to
       this" — the Kiosk proxy, not the folder. Saying that out loud is what
       keeps this check worth reading. */
    return agentFs.checkProjectDir(opts.agentHost, dir, { timeoutMs: opts.timeoutMs });
  }
  if (!opts.sshAlias) {
    try {
      if (!existsSync(dir)) {
        return { exists: false, warning: `no such directory on this PC: ${dir}` };
      }
      if (!statSync(dir).isDirectory()) {
        return { exists: false, warning: `not a directory: ${dir}` };
      }
      return { exists: true };
    } catch {
      return { exists: null };
    }
  }
  const alias = opts.sshAlias;
  /* `test -d` over the alias — the same door the transcript listing uses, so a
     pass here means the listing can genuinely reach the path, not merely that
     the string looks right. Exit code carries the answer; stdout is a marker so
     an ssh failure (which also exits non-zero) cannot read as "missing". */
  return new Promise<DirCheck>((resolve) => {
    const child = spawnProc(sshBinary(), [alias, 'bash -s'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    let settled = false;
    const done = (r: DirCheck) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      done({ exists: null, warning: `could not reach ${alias} to check ${dir}` });
    }, opts.timeoutMs ?? 8_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      done({ exists: null, warning: `could not reach ${alias} to check ${dir}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const answer = out.trim();
      if (answer === 'yes') {
        done({ exists: true });
      } else if (answer === 'no') {
        done({ exists: false, warning: `no such directory on ${alias}: ${dir}` });
      } else {
        done({ exists: null, warning: `could not reach ${alias} to check ${dir}` });
      }
    });
    child.stdin.write(`[ -d ${posixQuote(dir)} ] && echo yes || echo no\n`);
    child.stdin.end();
  });
}

/** POSIX single-quote, for the remote side of the ssh. */
function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
