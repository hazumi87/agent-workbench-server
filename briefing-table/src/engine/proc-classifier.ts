/* ============================================================================
 * /proc CLASSIFIER (the design notes §4.1, findings F2 F13 F21) [ticket].
 *
 * Which processes on THIS host belong to a pane's conversation, and does its
 * claude actually own its terminal? Synchronous, Linux only, OWN UID ONLY, and
 * the proc root is injectable (HARBOR_WB_PROC_ROOT, or the `root` argument) so
 * tests run against a fixture directory, never against real processes.
 *
 * HOW IT READS: `comm` first, for every own-uid pid; `cmdline`, `environ` and
 * `stat` only for candidates (comm `claude`, or — to find background and
 * leftover processes — the tree the question needs).
 *
 * TWO MATCHES, BOTH NARROW ON PURPOSE:
 *   - a conversation id matches only as an argv FLAG PAIR (`--resume <id>`,
 *     `-r <id>`, `--session-id <id>`). A prompt that quotes an id is not one.
 *   - `HARBOR_WB_PANEID` matches EXACTLY: `recipe:X` never matches `recipe:X#s`
 *     (F13 — the live orphan carries one, the live nuc1 claude the other).
 *
 * THREE OUTCOMES. `null` = could not tell: not Linux, or the proc root itself
 * is unreadable — a WHOLE-SCAN failure, and only that. The CALLER decides
 * whether a pane runs on this host at all (the target's broker); a pane that
 * does not is also "could not tell", and must never be read as "no claude"
 * off an empty scan.
 *
 * ONE PROCESS NEVER MAKES THE WHOLE SCAN UNKNOWN (review findings #7/#8,
 * 2026-09-25). A per-process file that cannot be read is "not this pane":
 * own-uid processes that are non-dumpable (sshd session children, `systemd
 * --user`, file-capability binaries such as ping) and every ZOMBIE have a
 * root-owned `environ` (EACCES). A zombie `claude` used to turn guard 9 into
 * "could not tell" — deliver — for every pane on the host; now a zombie is
 * not a claude at all (state Z/X is dropped), and an unreadable claude simply
 * cannot be shown to be this pane's, so the pane holds (the safe direction).
 *
 * Read-only: it never signals, never kills (Q8).
 * ========================================================================== */

import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

const defaultRoot = (): string => process.env.HARBOR_WB_PROC_ROOT || '/proc';

interface Stat {
  state: string;
  ppid: number;
  pgrp: number;
  /** Session id (the session leader's pid). */
  sid: number;
  /** Controlling terminal (tty_nr); 0 = none. */
  tty: number;
  tpgid: number;
  starttime: number;
}

/** The proc root itself cannot be read: the whole answer is "could not tell". */
class CannotTell extends Error {}

/** A per-process file, or null: gone mid-scan (ENOENT/ESRCH) or unreadable
 *  (EACCES — non-dumpable, or a zombie). Either way it names no pane. */
function read(path: string): string | null {
  try {
    return readFileSync(path, 'latin1');
  } catch {
    return null;
  }
}

const DEAD = new Set(['Z', 'X', 'x']);

/** `/proc/<pid>/stat`: `pid (comm) state ppid pgrp session tty tpgid … starttime`
 *  — comm may hold spaces and parentheses, so fields count from the LAST `)`. */
export function parseStat(text: string): Stat | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const f = text.slice(close + 2).trim().split(/\s+/);
  if (f.length < 20) return null;
  return {
    state: f[0],
    ppid: Number(f[1]),
    pgrp: Number(f[2]),
    sid: Number(f[3]),
    tty: Number(f[4]),
    tpgid: Number(f[5]),
    starttime: Number(f[19]),
  };
}

/** Does argv name `id` as a flag pair (never a quoted id inside a prompt)? */
export function namesId(argv: string[], ids: string[]): boolean {
  for (let i = 1; i < argv.length - 1; i++) {
    if ((argv[i] === '--resume' || argv[i] === '-r' || argv[i] === '--session-id') && ids.includes(argv[i + 1])) {
      return true;
    }
  }
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The argv names a conversation UUID (a flag pair) that is none of `ids`:
 *  that claude runs ANOTHER conversation (S0 ride fix, guard 7 (iii)). */
export function namesOtherId(argv: string[], ids: string[]): boolean {
  for (let i = 1; i < argv.length - 1; i++) {
    if ((argv[i] === '--resume' || argv[i] === '-r' || argv[i] === '--session-id') && UUID.test(argv[i + 1]) && !ids.includes(argv[i + 1])) {
      return true;
    }
  }
  return false;
}

/* Flags that mean "not the REPL" outright, compared by the name before any
   `=`. claude's OWN predicate (CC 2.1.283, `_hn` in the shipped binary):
     _hn(n){let e=Xx("-p",n)||Xx("--print",n),t=Xx("--init-only",n),
       r=yYn(o=>o.startsWith("--sdk-url"),n)!==-1;
       return e||t||r||!process.stdout.isTTY}
   — print mode, --init-only, any --sdk-url*, or a stdout that is not a TTY
   (ownerMap checks fd 1). Plus help and version, which print and exit, and
   --bg / --background, which start a background session and return at once
   (review 3). Re-read _hn on a CC version change. */
const NOT_REPL = new Set(['-p', '--print', '--init-only', '-h', '--help', '-v', '-V', '--version', '--bg', '--background']);
const notRepl = (word: string): boolean => {
  const name = word.includes('=') ? word.slice(0, word.indexOf('=')) : word;
  return NOT_REPL.has(name) || name.startsWith('--sdk-url');
};
/* The same, as letters inside a single-dash cluster (`-cp` is -c -p). */
const NOT_REPL_SHORT = new Set(['p', 'h', 'v', 'V']);
/* THE VALUE-TAKING FLAGS, verbatim from claude's own argv scanner (CC
   2.1.283: the sets `i` and `a` beside `function r1t` in the shipped
   binary), not from --help, which omits hidden and aliased ones (review 3).
   REQUIRED: the next word is the value, always — r1t takes it even when it
   starts with `-`, as commander does for `<value>`. OPTIONAL (`[value]`): the
   next word only when it is not a flag (claude's o1t: longer than 1 char and
   starting with `-`) — which is how the picker's bare `--resume` followed by
   `--mcp-config` stays two flags, and how `claude -d update` is the REPL with
   debug filter "update". A VARIADIC (`<tools...>`, claude's EGr) is given ONE
   value here where claude takes every following word: a second value reads
   as a bare word and holds — the safe direction. Re-extract on a CC version
   change. */
const REQUIRED_VALUE = new Set([
  '--prefill', '--prefill-b64', '--deep-link-repo', '--deep-link-last-fetch',
  '--deep-link-cwd-b64', '--handle-uri', '--settings', '--managed-settings', '--setting-sources',
  '--client-data-url', '--watch-artifact', '--watch-artifact-no-autoreact', '--team-name',
  '--agent-id', '--agent-name', '--agent-color', '--parent-session-id', '--agent-type', '--model',
  '--agent', '--routine', '--effort', '--permission-mode', '--inherit-permission-mode',
  '--proactivity', '--debug-file', '--system-prompt', '--system-prompt-file',
  '--append-system-prompt', '--append-system-prompt-file', '--system-prompt-snapshot',
  '--append-subagent-system-prompt', '--append-subagent-system-prompt-file',
  '--plan-mode-instructions', '--permission-prompt-tool', '--permission-prompts', '--json-schema',
  '--fallback-model', '--advisor', '--agents', '--name', '-n', '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools', '--tools', '--add-dir', '--mcp-config', '--betas',
  '--file', '--channels', '--dangerously-load-development-channels', '--plugin-dir',
  '--plugin-dir-no-mcp', '--plugin-url', '--remote-control-session-name-prefix', '--sdk-url',
  '--exec', '-m', '--thinking', '--thinking-display', '--max-thinking-tokens', '--max-turns',
  '--max-budget-usd', '--task-budget', '--autocompact', '--rewind-files', '--resume-session-at',
  '--resume-drops-turn', '--workload', '--output-format', '--input-format', '--teammate-mode',
  '--messaging-socket-path', '--session-id', '--environment', '--pool', '--ref', '--on-branch',
  '--correlation-id', '--forward-home-settings',
]);
const OPTIONAL_VALUE = new Set([
  '-d', '--debug', '-r', '--resume', '--from-pr', '-w', '--worktree', '--teleport', '--cloud',
  '--remote', '--project', '--remote-control', '--rc', '--prompt-suggestions',
]);
/* The short letters among them, for single-dash clusters (`-cr <id>`). */
const REQUIRED_SHORTS = new Set(['m', 'n']);
const OPTIONAL_SHORTS = new Set(['d', 'r', 'w']);
/** claude's o1t: is this word a flag (so never an optional value)? */
const isFlag = (w: string): boolean => w.length > 1 && w.startsWith('-');

/**
 * Is this argv the interactive REPL? FAIL CLOSED (guard 9's P0 review,
 * 2026-09-25): only when every word after argv[0] is a flag, or the value of a
 * flag known to take one. A bare word is a subcommand (`claude update`, `mcp
 * list`, `doctor`, `install` — which never read stdin, so a typed line waits
 * in the tty for bash) or a typed prompt; either way, not the REPL. -p,
 * --print, -h, --help, -v, --version are not the REPL either.
 */
export function interactive(argv: string[]): boolean {
  if (!argv.length) {
    return false;
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (notRepl(a)) {
      return false;
    }
    if (!a.startsWith('-') || a === '-') {
      return false; // a subcommand, a prompt, or stdin
    }
    let value: 'required' | 'optional' | null = REQUIRED_VALUE.has(a) ? 'required' : OPTIONAL_VALUE.has(a) ? 'optional' : null;
    if (!a.startsWith('--') && a.length > 2) {
      /* A CLUSTER, split the way commander splits it (review 2 P1-A: `-cp`
         is -c -p, print mode). A letter that takes a value swallows the rest
         of the word as that value, so `-r<id>` is one flag with its value. */
      value = null;
      for (let j = 1; j < a.length; j++) {
        if (NOT_REPL_SHORT.has(a[j])) {
          return false;
        }
        const kind = REQUIRED_SHORTS.has(a[j]) ? 'required' : OPTIONAL_SHORTS.has(a[j]) ? 'optional' : null;
        if (kind) {
          value = j === a.length - 1 ? kind : null;
          break;
        }
      }
    }
    if (i + 1 < argv.length && (value === 'required' || (value === 'optional' && !isFlag(argv[i + 1])))) {
      i++; // its value
    }
  }
  return true;
}

/** /dev/pts/N for a pseudo-terminal's tty_nr (stat field 7: the kernel's
 *  new_encode_dev of major 136-143), or null for anything else. Equal to the
 *  path whose rdev IS that tty_nr, computed rather than stat'ed so a fixture
 *  proc root can stand in for /dev. */
export function ptsPath(ttyNr: number): string | null {
  const major = (ttyNr >> 8) & 0xfff;
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
  return major >= 136 && major <= 143 ? `/dev/pts/${(major - 136) * 256 + minor}` : null;
}

/** One read of the proc root: lazy per-pid files, own uid only. */
class Snap {
  private readonly uid = process.getuid?.() ?? -1;
  private list: number[] | null = null;
  private readonly cache = new Map<string, unknown>();

  constructor(readonly root: string) {}

  pids(): number[] {
    if (!this.list) {
      let names: string[];
      try {
        names = readdirSync(this.root);
      } catch {
        throw new CannotTell(this.root);
      }
      this.list = names
        .filter((n) => /^\d+$/.test(n))
        .map(Number)
        .filter((pid) => {
          try {
            return statSync(join(this.root, String(pid))).uid === this.uid;
          } catch {
            return false;
          }
        });
    }
    return this.list;
  }

  private memo<T>(key: string, fn: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key) as T;
  }

  comm(pid: number): string | null {
    return this.memo(`c${pid}`, () => read(join(this.root, String(pid), 'comm'))?.trim() ?? null);
  }

  stat(pid: number): Stat | null {
    return this.memo(`s${pid}`, () => {
      const t = read(join(this.root, String(pid), 'stat'));
      return t === null ? null : parseStat(t);
    });
  }

  argv(pid: number): string[] {
    return this.memo(`a${pid}`, () => (read(join(this.root, String(pid), 'cmdline')) ?? '').split('\0').filter((a, i, all) => a !== '' || i < all.length - 1));
  }

  paneOf(pid: number): string | null {
    return this.memo(`e${pid}`, () => {
      const env = read(join(this.root, String(pid), 'environ'));
      const hit = env?.split('\0').find((kv) => kv.startsWith('HARBOR_WB_PANEID='));
      return hit ? hit.slice('HARBOR_WB_PANEID='.length) : null;
    });
  }

  /** Is `pid` a (strict) descendant of `ancestor`? Walks ppid, bounded. */
  descends(pid: number, ancestor: number): boolean {
    let p = pid;
    for (let hops = 0; hops < 64; hops++) {
      const s = this.stat(p);
      if (!s || s.ppid <= 1) return false;
      if (s.ppid === ancestor) return true;
      p = s.ppid;
    }
    return false;
  }

  /** Is this fd of `pid` the terminal `ttyNr`? An fd that cannot be read is
   *  not (the hold direction). */
  fdOn(pid: number, fd: number, ttyNr: number): boolean {
    const want = ptsPath(ttyNr);
    if (want === null) return false;
    try {
      return readlinkSync(join(this.root, String(pid), 'fd', String(fd))) === want;
    } catch {
      return false;
    }
  }

  /** Boot time (ms since the epoch) from `/proc/uptime`, whose seconds carry
   *  centiseconds — /proc/stat's btime is whole seconds, too coarse to order
   *  a claude's start against a keystroke. null when unreadable. */
  bootMs(): number | null {
    return this.memo('boot', () => {
      const up = Number.parseFloat(read(join(this.root, 'uptime')) ?? '');
      return Number.isFinite(up) ? Date.now() - up * 1000 : null;
    });
  }

  /** `btime` from /proc/stat (whole seconds since the epoch): what `ps` uses
   *  for `lstart`, so a refusal's start time matches what a person checks
   *  with `ps -o lstart= -p N` (guard 7). null when unreadable. */
  btime(): number | null {
    return this.memo('btime', () => {
      const m = /^btime (\d+)$/m.exec(read(join(this.root, 'stat')) ?? '');
      return m ? Number(m[1]) : null;
    });
  }

  /** A process that has exited (zombie) or is gone is not running anything. */
  alive(pid: number): boolean {
    const st = this.stat(pid)?.state;
    return st !== undefined && !DEAD.has(st);
  }

  claudes(): number[] {
    return this.pids().filter((pid) => this.comm(pid) === 'claude' && this.alive(pid));
  }

  /**
   * THE PANE'S OWN TERMINAL, per paneid (review findings #1/#9): the tty of its
   * ROOT SHELL — a session leader with a controlling tty that carries exactly
   * this paneid while its PARENT does not (the pty-broker's child: node-pty
   * setsid()s it onto the pane's pty; the broker carries no paneid). A claude
   * on any other terminal — `script -qc claude`, a tmux/screen window, a probe
   * pty — shares the paneid by inheritance but is not in the pane, and its
   * session leader's parent (script, the tmux server) carries the paneid, so it
   * is never a root. Derived from /proc alone: an adopted pane's shell pid is
   * unknown to the engine. A set, because the answer must be ONE tty.
   */
  paneTtys(): Map<string, Set<number>> {
    return this.memo('roots', () => {
      const out = new Map<string, Set<number>>();
      for (const pid of this.pids()) {
        const s = this.stat(pid);
        if (!s || s.sid !== pid || s.tty === 0 || !this.alive(pid)) continue;
        const pane = this.paneOf(pid);
        if (pane === null || this.paneOf(s.ppid) === pane) continue;
        const set = out.get(pane) ?? new Set<number>();
        set.add(s.tty);
        out.set(pane, set);
      }
      return out;
    });
  }

  /** Guard 9: not stopped, and the terminal's foreground group is its own
   *  process group or one descended from it (claude running a foreground child). */
  owns(pid: number): boolean {
    const s = this.stat(pid);
    if (!s || s.state === 'T' || s.state === 't' || s.tpgid <= 0) return false;
    if (s.tpgid === s.pgrp) return true;
    return this.pids().some((q) => this.stat(q)?.pgrp === s.tpgid && (q === pid || this.descends(q, pid)));
  }
}

function guarded<T>(fn: (snap: Snap) => T, root?: string): T | null {
  if (process.platform !== 'linux') return null;
  try {
    return fn(new Snap(root ?? defaultRoot()));
  } catch (e) {
    if (e instanceof CannotTell) return null;
    throw e;
  }
}

/* ------------------------------------------------------------ guard 9 ---- */

/** Does this pid own its terminal (not `T`; tpgid = its pgrp, or a group
 *  descended from it)? Null = could not tell. */
export function ownsTerminal(pid: number, root?: string): boolean | null {
  return guarded((snap) => snap.owns(pid), root);
}

/** WHICH claude owns a pane's terminal: a process identity (pid + starttime,
 *  stat field 22), so a caller can tell a hand-restarted claude from the one
 *  it saw before (review finding #2). */
export interface ClaudeOwner {
  pid: number;
  starttime: number;
  /** Wall-clock start (ms): boot time (now - /proc/uptime) + starttime at
   *  USER_HZ 100, good to ~20 ms; null when /proc/uptime cannot be read. */
  startedAt: number | null;
  /** The claude is its own session leader (sid === pid): it was EXEC'd by
   *  the pane's root shell (`exec claude …`), so its pid, starttime and
   *  startedAt are the SHELL's and say nothing about when this claude
   *  started (review 4). The engine never launches this shape: it types
   *  `claude` into `bash -il`, so claude is bash's child. */
  leader: boolean;
}

/** A fresh answer about a pane: the owning REPL; `'none'` (no claude owns the
 *  pane's pty); `'not-repl'` (a claude owns it but is not its interactive
 *  session — a subcommand, print mode, redirected stdio: review 2 P2, so a
 *  hold can say so instead of "claude is not running"); null = could not tell. */
export type ClaudeRead = ClaudeOwner | 'none' | 'not-repl' | null;

/* A pane is claude-owned only by an interactive claude ON THE PANE'S OWN
   terminal (paneTtys) that owns it. No root shell, or roots on several ttys:
   the pane's terminal cannot be named, so nothing owns it — none, hold.
   A claude that owns the pane's pty but is not its REPL (argv or stdio) is
   'not-repl' — still a hold, named. Several owners (not expected): the
   oldest, so the answer is stable. */
function ownerMap(snap: Snap): Map<string, ClaudeOwner | 'not-repl'> {
  const out = new Map<string, ClaudeOwner | 'not-repl'>();
  const ttys = snap.paneTtys();
  for (const pid of snap.claudes()) {
    const pane = snap.paneOf(pid);
    if (pane === null) continue;
    const set = ttys.get(pane);
    const s = snap.stat(pid);
    if (!s || !set || set.size !== 1 || !set.has(s.tty) || !snap.owns(pid)) continue;
    /* THE REPL READS AND WRITES THE TERMINAL (review 2 P1-A). Print mode also
       starts with no -p when stdin or stdout is redirected (`cat p | claude
       --model opus | tee out`, `claude -c < f > out`): it never reads the tty,
       so a typed line would wait for bash. Both stdin and stdout must be the
       pane's own pty; an fd that cannot be read holds. */
    if (!interactive(snap.argv(pid)) || !snap.fdOn(pid, 0, s.tty) || !snap.fdOn(pid, 1, s.tty)) {
      out.set(pane, out.get(pane) ?? 'not-repl');
      continue;
    }
    const prev = out.get(pane);
    if (!prev || prev === 'not-repl' || s.starttime < prev.starttime) {
      const boot = snap.bootMs();
      out.set(pane, {
        pid,
        starttime: s.starttime,
        startedAt: boot === null ? null : Math.round(boot + s.starttime * 10),
        leader: s.sid === pid,
      });
    }
  }
  return out;
}

const CACHE_MS = 2_000;
let cached: { at: number; root: string; map: Map<string, ClaudeOwner | 'not-repl'> | null } | null = null;

/**
 * WHICH interactive claude carrying exactly this paneid owns THE PANE'S
 * terminal? Its identity / 'none' / 'not-repl' / null (could not tell: not
 * Linux, or no proc root). `cached: true` serves readiness and the
 * roster from one scan per 2 s; guard 9 reads `cached: false` immediately
 * before each typed write.
 */
export function claudeOwner(paneid: string, opts: { cached: boolean; root?: string }): ClaudeRead {
  const root = opts.root ?? defaultRoot();
  const now = Date.now();
  if (!opts.cached || !cached || cached.root !== root || now - cached.at >= CACHE_MS) {
    const map = guarded(ownerMap, root);
    cached = { at: now, root, map };
  }
  return cached.map === null ? null : (cached.map.get(paneid) ?? 'none');
}

/** Is this read an owning REPL? */
export const isOwner = (o: ClaudeRead): o is ClaudeOwner => typeof o === 'object' && o !== null;

/** claudeOwner as true / false / null. */
export function claudeOwnsTerminal(paneid: string, opts: { cached: boolean; root?: string }): boolean | null {
  const o = claudeOwner(paneid, opts);
  return o === null ? null : isOwner(o);
}

/* --------------------------------------------------------- classifier ---- */

export interface ProcEntry {
  pid: number;
  comm: string;
  state: string;
}
/** A claude that collides (or is suspended): its identity, and — for guard 7's
 *  just-ended wait and refusal text — when it started, as wall-clock ms
 *  (boot + starttime, ~20 ms) and exactly as `ps -o lstart=` prints it. */
export type ProcHit = ProcEntry & {
  starttime: number;
  paneid: string | null;
  startedAt: number | null;
  lstart: string | null;
  /** `ended` phase: WHY it collides — `id` it names one of the ids as a flag
   *  pair (or is the recorded pid); `pane` it carries this paneid and names no
   *  conversation uuid; `pane-other` it carries this paneid but names ANOTHER
   *  conversation uuid (an orphan on a different conversation: guard 7 never
   *  refuses on it, only waits for one still exiting). */
  match?: 'id' | 'pane' | 'pane-other';
};
export interface Classification {
  /** The pane's own live claude (before End; empty after). */
  claude: Array<{ pid: number; state: string; ownsTerminal: boolean }>;
  collisions: ProcHit[];
  /** Before End: a claude that would be a collision but is stopped (`T`). */
  suspended: ProcHit[];
  background: ProcEntry[];
  leftovers: ProcEntry[];
}

export interface ClassifyQuery {
  paneid: string;
  /** Conversation ids to look for as argv flag pairs (banked, and located). */
  ids: string[];
  /** `live` = before End; `ended` = after End and at every restore. */
  phase: 'live' | 'ended';
  /** After End: the claude this pane last ran, as pid + starttime. */
  recorded?: { pid: number; starttime: number } | null;
}

/** §4.1's classification of this pane's processes. Null = could not tell. */
export function classify(q: ClassifyQuery, root?: string): Classification | null {
  return guarded((snap) => {
    const ids = q.ids.filter((x) => typeof x === 'string' && x !== '');
    const entry = (pid: number): ProcHit => {
      const s = snap.stat(pid);
      const boot = snap.bootMs();
      const btime = snap.btime();
      return {
        pid,
        comm: snap.comm(pid) ?? '',
        state: s?.state ?? '?',
        starttime: s?.starttime ?? 0,
        paneid: snap.paneOf(pid),
        startedAt: s && boot !== null ? Math.round(boot + s.starttime * 10) : null,
        lstart: s && btime !== null ? lstartOf(btime + Math.floor(s.starttime / 100)) : null,
      };
    };
    const out: Classification = { claude: [], collisions: [], suspended: [], background: [], leftovers: [] };
    const claudes = snap.claudes();

    if (q.phase === 'live') {
      const mine = claudes.filter((pid) => snap.paneOf(pid) === q.paneid);
      const roots = mine.filter((pid) => interactive(snap.argv(pid)) && !mine.some((o) => o !== pid && snap.descends(pid, o)));
      const running = roots.filter((pid) => {
        const st = snap.stat(pid)?.state;
        return st !== 'T' && st !== 't';
      });
      const live =
        running.find((pid) => snap.owns(pid)) ??
        running.sort((a, b) => (snap.stat(b)?.starttime ?? 0) - (snap.stat(a)?.starttime ?? 0))[0] ??
        null;
      if (live !== null) {
        out.claude.push({ pid: live, state: snap.stat(live)?.state ?? '?', ownsTerminal: snap.owns(live) });
        for (const pid of snap.pids()) {
          if (pid !== live && snap.descends(pid, live)) {
            // comm and stat only: nothing here needs (or may fail on) an environ
            out.background.push({ pid, comm: snap.comm(pid) ?? '', state: snap.stat(pid)?.state ?? '?' });
          }
        }
      }
      for (const pid of claudes) {
        if (pid === live || (live !== null && snap.descends(pid, live))) continue;
        if (snap.paneOf(pid) !== q.paneid && !namesId(snap.argv(pid), ids)) continue;
        const e = entry(pid);
        (e.state === 'T' || e.state === 't' ? out.suspended : out.collisions).push(e);
      }
      return out;
    }

    const hit = new Map<number, 'id' | 'pane' | 'pane-other'>();
    const rec = q.recorded;
    if (rec && snap.alive(rec.pid) && snap.stat(rec.pid)?.starttime === rec.starttime) {
      hit.set(rec.pid, 'id');
    }
    for (const pid of claudes) {
      const argv = snap.argv(pid);
      if (namesId(argv, ids)) {
        hit.set(pid, 'id');
      } else if (!hit.has(pid) && snap.paneOf(pid) === q.paneid && interactive(argv)) {
        hit.set(pid, namesOtherId(argv, ids) ? 'pane-other' : 'pane');
      }
    }
    for (const [pid, match] of hit) {
      out.collisions.push({ ...entry(pid), match });
    }
    for (const pid of snap.pids()) {
      if (!hit.has(pid) && snap.paneOf(pid) === q.paneid) {
        const e = entry(pid);
        out.leftovers.push({ pid, comm: e.comm, state: e.state });
      }
    }
    return out;
  }, root);
}

const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** `TZ=UTC ps -o lstart=` for a start at `sec` (epoch seconds): ctime's 24
 *  chars, day of month space-padded (`Thu Sep  5 14:03:12 2026`) — procps
 *  prints `%24.24s` of ctime(). ALWAYS UTC (S0 ride fix): the engine runs
 *  with no TZ while every agent shell has TZ=America/Los_Angeles, so a
 *  local-time value never matched the `ps` check the refusal prescribes; the
 *  refusal names `TZ=UTC` so it matches in any shell. */
export function lstartOf(sec: number): string {
  const d = new Date(sec * 1000);
  return `${WDAY[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** Tests only. */
export function resetCache(): void {
  cached = null;
}
