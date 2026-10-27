/**
 * claude-code vendor mechanics (ticket) — the FIRST non-trivial vendor
 * (blueprint decision 3): the #2 half of the #1/#2 split (Seam C1). Everything
 * claude-SPECIFIC lives here — session-id minting, --resume/--session-id arg
 * building, transcript location, the ACK handshake. The generic cli-host stays
 * vendor-blind; launch.ts calls in here when a recipe asks for claude.
 *
 * The session-id model (decided 2026-08-01, account decision A — Owner's
 * logged-in subscription account everywhere):
 *
 * - FRESH launch (no user-resume on the recipe): WE mint the uuid and pass
 *   `--session-id <uuid>`, so the engine knows the session id without ever
 *   scraping output or racing the transcript dir. Works identically for local
 *   and ssh launches.
 * - CRASH RESTORE: `claude --resume <uuid>`. Claude keeps the SAME session id
 *   on a plain resume (--fork-session exists precisely to opt OUT of that), so
 *   one minted uuid stays valid across any number of crash→restore cycles.
 * - NAMED resume (Owner's /rename → `--resume "<name>"` flow): untouched. The
 *   session id stays unknown (NULL in the table); crash restore of such a pane
 *   just re-runs the recipe's own named resume, which is already a restore.
 *
 * The transcript is the durable half of a claude session: it survives the
 * engine, the PTY, and the machine rebooting. That's WHY a claude pane
 * dehydrates instead of dying with its engine (store.reconcileStaleLive).
 */
import { plainArg, quotedName } from '../argv.ts';
import { randomUUID } from 'node:crypto';
import { execFile, spawn as spawnProc } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Recipe } from '../../table/store.ts';
import { isRecipeEffort } from '../effort.ts';
import { sshBinary } from '../platform.ts';
import * as agentFs from '../agent-fs.ts';
import type { LiveCliVendor } from './index.ts';

/** The vendor tag written to the mapping table for claude-carrying panes. */
export const VENDOR = 'claude-code';

/** Only claude-code sessions survive an engine death: the conversation lives in
 *  the transcript, not the process. Every other vendor's stale `live` is a lie
 *  that reconciles to `killed`. */
export function isResumable(vendor: string): boolean {
  return vendor === VENDOR;
}

export function mintSessionId(): string {
  return randomUUID();
}

/** POSIX single-quote (remote side of ssh) — mirror of launch.ts's quoting. */
function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ClaudeInvocation {
  /** The full command line to run (or type into) the shell. */
  cmd: string;
  /** The session id the engine can bank on, or null (named-resume flow —
   *  claude picks the session; the id is unknowable without a locate). */
  sessionId: string | null;
}

/**
 * Build the claude command a recipe asks for. `resumeSessionId` (a dehydrated
 * pane's stored uuid) takes precedence over everything else on the recipe —
 * a restore must reopen THAT conversation, not start the recipe fresh.
 * Returns null when the recipe doesn't run claude at all.
 */
/**
 * How this session invokes claude.
 *
 * THE RESUME DECISION IS THE CALLER'S, NOT THIS FUNCTION'S. It used to read
 * `r.resume`/`r.resumeName` off the recipe itself, which was fine while a
 * project could only ever have one session — and became a live bug the moment
 * it could have two: `＋ New` on a named-resume project spawned a SECOND
 * `claude --resume "<same name>"`, i.e. two processes appending to one
 * transcript. Resume config is a SESSION fact; the recipe only supplies the
 * default for a project's first session, and resolving that is the caller's
 * job (see resolveResume in the server).
 *
 * Precedence, and the order is the rule: uuid > name > fresh.
 */
export function buildInvocation(
  r: Recipe,
  opts: { remote: boolean; resumeSessionId?: string | null; resumeName?: string | null },
): ClaudeInvocation | null {
  if (!r.runClaude) {
    return null;
  }
  const parts = ['claude'];
  if (r.model) {
    parts.push('--model', plainArg(r.model));
  }
  /* EFFORT rides beside --model on EVERY path — fresh, crash restore, named
     resume — for the same reason the model does: a resumed conversation is
     still this project's agent and should think the way it was told to. Only
     a known level is ever passed (the store and the launch route refuse the
     rest), and it is re-checked here so no caller can put arbitrary text on a
     command line typed into a shell. Null = Default = no flag. */
  if (r.effort && isRecipeEffort(r.effort)) {
    parts.push('--effort', r.effort);
  }
  if (opts.resumeSessionId) {
    // Crash restore: reopen the exact conversation. Plain --resume keeps the
    // same session id, so the table row stays valid for the NEXT crash too.
    parts.push('--resume', opts.resumeSessionId);
    return { cmd: parts.join(' '), sessionId: opts.resumeSessionId };
  }
  if (opts.resumeName !== undefined && opts.resumeName !== null) {
    // Owner's named-resume flow — claude resolves the name; id unknown to us.
    // An EMPTY name means the interactive picker (the recipe's `resume` with no
    // `resumeName`), which is why the check is on null/undefined, not falsiness.
    if (opts.resumeName) {
      const name = quotedName(opts.resumeName);
      parts.push('--resume', opts.remote ? posixQuote(name) : `"${name}"`);
    } else {
      parts.push('--resume'); // interactive picker
    }
    return { cmd: parts.join(' '), sessionId: null };
  }
  // Fresh session: mint the id ourselves so no locate/scrape is ever needed.
  const sessionId = mintSessionId();
  parts.push('--session-id', sessionId);
  return { cmd: parts.join(' '), sessionId };
}

/**
 * Claude's transcript-dir name for a project cwd: every non-alphanumeric
 * character becomes '-', case preserved (verified against ~/.claude/projects:
 * `C:\projects\workbench` → `C--code-briefing-table`).
 *
 * A TRAILING SEPARATOR IS STRIPPED FIRST, and that is load-bearing rather than
 * tidy. Claude encodes the process CWD, which never carries one; a recipe's
 * projectDir is typed by a human, and `/srv/code/kiosk/` encodes to
 * `-srv-code-kiosk-` — a directory that does not exist. Found live
 * 2026-09-13: that pane had run for days with no name in the manager, because
 * every transcript lookup for it was pointed one character off. The cost is not
 * only cosmetic — `transcriptPath` and `locateCurrentSessionId` encode through
 * here too, so a restore was reading the same empty path. Root (`/`) is left
 * alone: it has no name to lose.
 */
export function encodeProjectDir(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, '') || cwd;
  return trimmed.replace(/[^A-Za-z0-9]/g, '-');
}

/** Root of claude's per-project transcript dirs. Env-overridable so tests can
 *  point it at a fixture tree (never at the real ~/.claude). */
function projectsRoot(): string {
  return (
    process.env.HARBOR_WB_CLAUDE_PROJECTS ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.claude', 'projects')
  );
}

/** Local transcript path for a session (the durable artifact --resume reads). */
export function transcriptPath(cwd: string, sessionId: string): string {
  return join(projectsRoot(), encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Locate-refresh (vk [ref]): resolve the CURRENT incarnation of a session
 * lineage before a restore. On CC 2.1.220 a plain `--resume <uuid>` appends to
 * the SAME transcript (verified 2026-08-03, local + server both 2.1.220), so this
 * normally returns the banked uuid unchanged — it exists as insurance against
 * the drift the relay team documented (KB design-notes-id): older/future CC
 * versions forking on resume, or any mechanism that copies history into a new
 * file. Match rule is the STRUCTURAL `"sessionId":"<banked>"` JSON field, NOT
 * a plain substring — transcripts of OTHER sessions in the same project dir
 * can quote a uuid in conversation text (observed live: a test agent
 * quoting relay lineage), and a content match must never steal the restore.
 *
 * Returns the newest transcript uuid structurally linked to `banked` (which is
 * `banked` itself in the common case — a file always contains its own id), or
 * null when nothing links — caller falls back to the banked id and lets the
 * failure be visible in the pane.
 */
export function locateCurrentSessionId(opts: {
  banked: string;
  projectDir: string;
  /** ssh alias — locate runs on the remote host's transcript dir. */
  sshAlias?: string;
  /** service registry node slug whose WINDOW AGENT holds the transcripts — the
   *  path for a host we can reach a desktop on but not an ssh account (see
   *  agent-fs.ts). Mutually exclusive with sshAlias in practice; checked
   *  first, because a caller only ever sets one (see `fsOptsFor`). */
  agentHost?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const needle = `"sessionId":"${opts.banked}"`;
  const encDir = encodeProjectDir(opts.projectDir);

  if (opts.agentHost) {
    /* AGENT LOCATE (2026-09-18). Same question, asked of the desktop that owns
       the files: which transcripts contain the structural `"sessionId":"<id>"`
       field, and which of those is newest. `fs.grep` answers the first and
       `fs.list` the second, and they are asked CONCURRENTLY because neither
       depends on the other — one round trip of latency, not two.

       The needle is handed over as a LITERAL substring (the frame is
       `fs.grep`, not `fs.regex`), which is the same match rule the local and
       ssh paths use, so a transcript that merely QUOTES the uuid in
       conversation still cannot steal the restore: it is the `"sessionId":`
       prefix that makes the match structural, not the matcher. */
    const host = opts.agentHost;
    return Promise.all([
      agentFs.grep(host, opts.projectDir, needle, { maxMatches: 1, timeoutMs: opts.timeoutMs }),
      agentFs.list(host, opts.projectDir, { timeoutMs: opts.timeoutMs }),
    ])
      .then(([matches, entries]) => {
        if (matches.length === 0) {
          return null;
        }
        const hit = new Set(matches.map((m) => m.name));
        const newest = entries
          .filter((e) => hit.has(e.name))
          .sort((a, b) => agentFs.mtimeMsOf(b) - agentFs.mtimeMsOf(a))[0];
        /* A name grep found but list did not is still an answer — the file is
           there, we just have no mtime for it. Falling back to the grep's own
           first name beats returning null and resuming a stale banked id. */
        const name = newest?.name ?? matches[0].name;
        return name.endsWith('.jsonl') ? basename(name, '.jsonl') : null;
      })
      .catch(() => null); // unreachable desktop / timeout — caller falls back
  }

  if (opts.sshAlias) {
    // One-shot remote locate: newest *.jsonl whose CONTENT structurally
    // references the banked id. grep -l over the project dir, newest first.
    const remoteCmd = `cd ~/.claude/projects/${encDir} 2>/dev/null && grep -l '${needle}' *.jsonl 2>/dev/null | xargs -r ls -t | head -1`;
    return new Promise((resolve) => {
      const child = execFile(
        sshBinary(),
        [opts.sshAlias!, remoteCmd],
        { timeout: opts.timeoutMs ?? 10_000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            return resolve(null); // unreachable host / timeout — caller falls back
          }
          const f = stdout.trim().split('\n')[0]?.trim();
          resolve(f?.endsWith('.jsonl') ? basename(f, '.jsonl') : null);
        },
      );
      child.on('error', () => resolve(null));
    });
  }

  // Local: newest-first scan, capped — transcripts can be MBs but a restore is
  // rare and the common case hits the banked file immediately.
  try {
    const dir = join(projectsRoot(), encDir);
    const candidates = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 25);
    for (const { f } of candidates) {
      try {
        if (readFileSync(join(dir, f), 'utf8').includes(needle)) {
          return Promise.resolve(basename(f, '.jsonl'));
        }
      } catch {
        /* unreadable candidate — skip */
      }
    }
  } catch {
    /* project dir missing — fall through */
  }
  return Promise.resolve(null);
}

/**
 * ACK handshake (Crawl form): poll for the transcript file appearing — proof
 * claude actually started under OUR session id (vs "not recognized" dying in
 * the shell). LOCAL panes only; an ssh pane's transcript lives on the remote
 * host (remote ACK is a later convenience, like remote-spawn). Resolves true
 * on ack, false on timeout — callers log, they don't gate on it.
 */
export function ackTranscript(
  cwd: string,
  sessionId: string,
  timeoutMs = 180_000,
  pollMs = 2_000,
): Promise<boolean> {
  const path = transcriptPath(cwd, sessionId);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (existsSync(path)) {
        return resolve(true);
      }
      if (Date.now() >= deadline) {
        return resolve(false);
      }
      setTimeout(tick, pollMs).unref?.();
    };
    tick();
  });
}

/* ============================================================================
 * SESSION LISTING (manager v2 resume picker, 2026-08-04) — enumerate a project
 * dir's INTERACTIVE claude sessions with human labels, local or over ssh.
 *
 * Labels come from the transcript itself (verified against CC 2.1.220 files):
 *   `custom-title` = the user's /rename name (wins)
 *   `ai-title`     = the auto-generated title
 *   `last-prompt`  = most recent user prompt (context subtitle)
 * Headless/dispatched sessions are excluded EXACTLY, not heuristically: their
 * user lines carry `"entrypoint":"sdk-cli"` (same filter the native /resume
 * dialog applies), so server dirs shared with dispatched agents stay clean.
 * ========================================================================== */

export interface SessionListing {
  sessionId: string;
  title: string | null; // custom-title > ai-title; null = untitled
  lastPrompt: string | null;
  /** First slash command in the transcript (e.g. "/exit") — label fallback for
   *  sessions with NO prose prompts (claude never writes a last-prompt line
   *  for slash commands, so native /resume shows the command; vk [ref]). */
  firstCommand: string | null;
  mtimeMs: number;
  sizeBytes: number; // transcript size — a proxy for how much history is in there
  branch: string | null; // last `gitBranch` recorded in the transcript (native picker parity)
  /** The model the session LAST answered with (`"model":"claude-…"` on an
   *  assistant message) and its last `perTurnEffort`, so an in-CLI /model or
   *  /effort switch shows (Owner 2026-09-30, ticket). null = not seen yet. */
  model: string | null;
  effort: string | null;
}

/** Last occurrence of a `"key":"value"` JSON string field in raw jsonl text,
 *  unescaped. Content-safe enough for Crawl: keys like customTitle only occur
 *  as real fields in the line types that carry them. */
function lastJsonString(content: string, key: string): string | null {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(content))) {
    last = m[1];
  }
  if (last === null) {
    return null;
  }
  try {
    return JSON.parse(`"${last}"`);
  } catch {
    return last;
  }
}

const HEADLESS_MARKER = '"entrypoint":"sdk-cli"';

/** Last `"model":"claude-…"` in raw jsonl: an assistant message's own
 *  model. Tool arguments name models bare ("sonnet"), so the claude- prefix
 *  is what keeps this to the session's answering model. */
function lastModel(content: string): string | null {
  const re = /"model":"(claude-[^"]{1,80})"/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(content))) {
    last = m[1];
  }
  return last;
}

/** First `<command-name>/foo</command-name>` in raw transcript text. Slash
 *  commands ride user AND system local_command lines in this wrapper (CC
 *  2.1.222, verified 2026-08-05). A conversation QUOTING the tag can also
 *  match — acceptable: the UI only shows this when title AND lastPrompt are
 *  both null, i.e. the session has no prose that could quote anything. */
function firstCommandName(content: string): string | null {
  const m = /<command-name>([^<]{1,80})<\/command-name>/.exec(content);
  return m ? m[1].trim() : null;
}

/* ---- the AGENT path (2026-09-18) ------------------------------------------
 *
 * The local path reads whole files off local disk and the ssh path runs a
 * shell script that does the extracting remotely. Neither is available to a
 * desktop we can only reach over a WebSocket, so the agent path does the third
 * thing: fetch the BYTES THAT CARRY THE ANSWER and parse them here with the
 * same helpers the local path uses. The agent never learns what `customTitle`
 * is (see agent-fs.ts's header — that is the whole division of labour).
 *
 * TWO SLICES, NOT THE WHOLE FILE. A transcript is routinely megabytes and this
 * runs on the 20s title clock:
 *   HEAD — the headless (`sdk-cli`) marker and the first `<command-name>`, both
 *          of which are by definition near the start.
 *   TAIL — `customTitle` / `aiTitle` / `lastPrompt` / `gitBranch`, which the
 *          ssh path reaches with `tac` and we reach with a computed offset.
 * A file that fits inside HEAD+TAIL is fetched in ONE read instead of two.
 *
 * THE CACHE IS KEYED ON (mtime, size) AND THAT IS WHY IT IS SAFE. A transcript
 * that has not been written to cannot have a different title, and every write
 * moves both numbers — so the key is self-invalidating and there is no TTL to
 * get wrong. Without it, a project of 15 sessions re-fetched ~1.4 MB over the
 * tailnet every 20 seconds forever, to re-derive titles that had not moved.
 * With it, only the session actually being typed in is ever re-read.
 */
const AGENT_HEAD_BYTES = Number(process.env.HARBOR_WB_AGENTFS_HEAD_BYTES ?? 32_768);
const AGENT_TAIL_BYTES = Number(process.env.HARBOR_WB_AGENTFS_TAIL_BYTES ?? 65_536);
/** `null` = we read this file and it is HEADLESS — cached too, so a dispatched
 *  agent's transcripts are not re-fetched on every sweep just to be skipped. */
const agentParseCache = new Map<string, SessionListing | null>();
const AGENT_CACHE_MAX = 400;

function cachePut(key: string, value: SessionListing | null): void {
  /* Plain insertion-order eviction, not an LRU. The access pattern is a
     newest-first sweep of one project at a time; a real LRU would buy nothing
     and would need every read to mutate the map. */
  if (agentParseCache.size >= AGENT_CACHE_MAX) {
    const oldest = agentParseCache.keys().next().value;
    if (oldest !== undefined) {
      agentParseCache.delete(oldest);
    }
  }
  agentParseCache.set(key, value);
}

async function listSessionsViaAgent(opts: {
  agentHost: string;
  projectDir: string;
  limit: number;
  timeoutMs?: number;
}): Promise<SessionListing[]> {
  const { agentHost: host, projectDir, limit } = opts;
  let entries: agentFs.FsEntry[];
  try {
    entries = await agentFs.list(host, projectDir, { timeoutMs: opts.timeoutMs });
  } catch {
    /* Unreachable desktop, no transcript dir, timeout. `[]` matches what the
       local and ssh paths answer for the same conditions — the UNKNOWN-vs-empty
       distinction lives in the dir CHECK (agentFs.checkProjectDir), which is
       where a user can act on it. */
    return [];
  }
  const ordered = entries
    .filter((e) => e.name.endsWith('.jsonl'))
    .sort((a, b) => agentFs.mtimeMsOf(b) - agentFs.mtimeMsOf(a))
    .slice(0, limit * 2);

  const rows: SessionListing[] = [];
  for (const e of ordered) {
    if (rows.length >= limit) {
      break;
    }
    const mtimeMs = agentFs.mtimeMsOf(e);
    const key = `${host}|${projectDir}|${e.name}|${mtimeMs}|${e.size}`;
    const cached = agentParseCache.get(key);
    if (cached !== undefined) {
      if (cached) {
        rows.push(cached);
      }
      continue;
    }
    let head = '';
    let tail = '';
    try {
      if (e.size <= AGENT_HEAD_BYTES + AGENT_TAIL_BYTES) {
        head = (await agentFs.read(host, projectDir, e.name, {
          offset: 0,
          limit: AGENT_HEAD_BYTES + AGENT_TAIL_BYTES,
          timeoutMs: opts.timeoutMs,
        })).data;
        tail = head;
      } else {
        const [h, t] = await Promise.all([
          agentFs.read(host, projectDir, e.name, {
            offset: 0,
            limit: AGENT_HEAD_BYTES,
            timeoutMs: opts.timeoutMs,
          }),
          agentFs.read(host, projectDir, e.name, {
            offset: Math.max(0, e.size - AGENT_TAIL_BYTES),
            limit: AGENT_TAIL_BYTES,
            timeoutMs: opts.timeoutMs,
          }),
        ]);
        head = h.data;
        tail = t.data;
      }
    } catch {
      /* One unreadable transcript must not empty the picker. Skip it WITHOUT
         caching the skip — the next sweep should try again, because the reason
         was transport, not content. */
      continue;
    }
    if (head.includes(HEADLESS_MARKER)) {
      cachePut(key, null); // dispatched/headless — native /resume hides these too
      continue;
    }
    const row: SessionListing = {
      sessionId: basename(e.name, '.jsonl'),
      title: lastJsonString(tail, 'customTitle') ?? lastJsonString(tail, 'aiTitle'),
      lastPrompt: lastJsonString(tail, 'lastPrompt'),
      firstCommand: firstCommandName(head),
      mtimeMs,
      sizeBytes: e.size,
      branch: lastJsonString(tail, 'gitBranch'),
      model: lastModel(tail),
      effort: lastJsonString(tail, 'perTurnEffort'),
    };
    cachePut(key, row);
    rows.push(row);
  }
  return rows;
}

export function listSessions(opts: {
  projectDir: string;
  sshAlias?: string;
  /** service registry node slug whose WINDOW AGENT holds the transcripts. */
  agentHost?: string;
  limit?: number;
  timeoutMs?: number;
}): Promise<SessionListing[]> {
  const limit = opts.limit ?? 15;
  const encDir = encodeProjectDir(opts.projectDir);

  if (opts.agentHost) {
    return listSessionsViaAgent({
      agentHost: opts.agentHost,
      projectDir: opts.projectDir,
      limit,
      timeoutMs: opts.timeoutMs,
    });
  }

  if (opts.sshAlias) {
    // One ssh round-trip; script on stdin (no quoting fight with the argv).
    // \x1f (unit separator) delimits fields — titles can contain anything else.
    const script = [
      `cd ~/.claude/projects/${encDir} 2>/dev/null || exit 0`,
      `for f in $(ls -t *.jsonl 2>/dev/null | head -${limit * 2}); do`,
      `  grep -q '${HEADLESS_MARKER}' "$f" && continue`,
      `  ct=$(tac "$f" | grep -oE -m1 '"customTitle":"(\\\\.|[^"\\\\])*"' | head -1)`,
      `  at=$(tac "$f" | grep -oE -m1 '"aiTitle":"(\\\\.|[^"\\\\])*"' | head -1)`,
      `  lp=$(tac "$f" | grep -oE -m1 '"lastPrompt":"(\\\\.|[^"\\\\])*"' | head -1)`,
      `  br=$(tac "$f" | grep -oE -m1 '"gitBranch":"(\\\\.|[^"\\\\])*"' | head -1)`,
      `  fc=$(grep -oE -m1 '<command-name>[^<]{1,80}' "$f" | head -1)`,
      `  md=$(tac "$f" | grep -oE -m1 '"model":"claude-[^"]{1,80}"' | head -1)`,
      `  ef=$(tac "$f" | grep -oE -m1 '"perTurnEffort":"[a-z]{1,20}"' | head -1)`,
      `  mt=$(stat -c %Y "$f" 2>/dev/null || echo 0)`,
      `  sz=$(stat -c %s "$f" 2>/dev/null || echo 0)`,
      `  printf '%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\n' "\${f%.jsonl}" "$mt" "$sz" "$ct" "$at" "$lp" "$br" "$fc" "$md" "$ef"`,
      `done`,
    ].join('\n');
    return new Promise((resolve) => {
      const child = spawnProc(sshBinary(), [opts.sshAlias!, 'bash -s'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let out = '';
      const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 12_000);
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => {
        clearTimeout(timer);
        resolve([]);
      });
      child.on('close', () => {
        clearTimeout(timer);
        const rows: SessionListing[] = [];
        for (const line of out.split('\n')) {
          const [id, mt, sz, ct, at, lp, br, fc, md, ef] = line.split('\x1f');
          if (!id || !/^[0-9a-f-]{36}$/.test(id.trim())) {
            continue;
          }
          const title =
            (ct && lastJsonString(ct, 'customTitle')) ||
            (at && lastJsonString(at, 'aiTitle')) ||
            null;
          rows.push({
            sessionId: id.trim(),
            title,
            lastPrompt: (lp && lastJsonString(lp, 'lastPrompt')) || null,
            firstCommand: (fc && fc.replace('<command-name>', '').trim()) || null,
            mtimeMs: Number(mt) * 1000 || 0,
            sizeBytes: Number(sz) || 0,
            branch: (br && lastJsonString(br, 'gitBranch')) || null,
            model: (md && lastModel(md)) || null,
            effort: (ef && lastJsonString(ef, 'perTurnEffort')) || null,
          });
        }
        resolve(rows.slice(0, limit));
      });
      child.stdin.write(script);
      child.stdin.end();
    });
  }

  // Local: the same two-slice read as the agent path, off local disk.
  return listSessionsLocal(join(projectsRoot(), encDir), limit);
}

/* ---- the LOCAL path: never block the event loop (2026-09-30) --------------
 *
 * OWNER: "every maybe 30 seconds the input stops for a good 3 seconds". It was
 * this function. It ran on the title clock (20s poll + 20s TTL = every 40s)
 * and readFileSync'd the WHOLE of each recent transcript: 686 MB in this
 * project's dir. Measured: /health took 4.9s every 40s and every keystroke
 * through the engine waited behind it. Now: async reads of a HEAD and a TAIL
 * slice (the agent path's split, above), a (mtime, size) cache so only the
 * session being written to is re-read, and, only when the tail holds no
 * title, an async BACKWARD scan in 1 MB chunks (each read yields), so a
 * long-ago /rename is still found without one big blocking read. */
const LOCAL_SCAN_CHUNK = 1 << 20;
const LOCAL_OVERLAP = 4096;

async function readSlice(fh: FileHandle, offset: number, length: number): Promise<string> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead).toString('utf8');
}

async function titleScanBack(fh: FileHandle, size: number, from: number): Promise<string | null> {
  return scanBack(fh, size, from, (c) => lastJsonString(c, 'customTitle') ?? lastJsonString(c, 'aiTitle'));
}

async function scanBack(fh: FileHandle, size: number, from: number, pick: (chunk: string) => string | null): Promise<string | null> {
  let end = from;
  while (end > 0) {
    const start = Math.max(0, end - LOCAL_SCAN_CHUNK);
    const chunk = await readSlice(fh, start, Math.min(size, end + LOCAL_OVERLAP) - start);
    const t = pick(chunk);
    if (t !== null) {
      return t;
    }
    end = start;
  }
  return null;
}

async function listSessionsLocal(dir: string, limit: number): Promise<SessionListing[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const stats: Array<{ f: string; mtimeMs: number; size: number }> = [];
  for (const f of names) {
    try {
      const st = await stat(join(dir, f));
      stats.push({ f, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* raced with a delete */
    }
  }
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const rows: SessionListing[] = [];
  for (const { f, mtimeMs, size } of stats.slice(0, limit * 2)) {
    if (rows.length >= limit) {
      break;
    }
    const key = `local|${dir}|${f}|${mtimeMs}|${size}`;
    const cached = agentParseCache.get(key);
    if (cached !== undefined) {
      if (cached) {
        rows.push(cached);
      }
      continue;
    }
    let fh: FileHandle | null = null;
    try {
      fh = await open(join(dir, f), 'r');
      const whole = size <= AGENT_HEAD_BYTES + AGENT_TAIL_BYTES;
      const head = await readSlice(fh, 0, whole ? size : AGENT_HEAD_BYTES);
      const tailFrom = whole ? 0 : size - AGENT_TAIL_BYTES;
      const tail = whole ? head : await readSlice(fh, tailFrom, AGENT_TAIL_BYTES);
      if (head.includes(HEADLESS_MARKER)) {
        cachePut(key, null); // dispatched/headless — native /resume hides these too
        continue;
      }
      let title = lastJsonString(tail, 'customTitle') ?? lastJsonString(tail, 'aiTitle');
      if (title === null && !whole) {
        title = await titleScanBack(fh, size, tailFrom);
      }
      let model = lastModel(tail);
      if (model === null && !whole) {
        model = await scanBack(fh, size, tailFrom, lastModel);
      }
      const row: SessionListing = {
        sessionId: basename(f, '.jsonl'),
        title,
        lastPrompt: lastJsonString(tail, 'lastPrompt'),
        firstCommand: firstCommandName(head),
        mtimeMs,
        sizeBytes: size,
        branch: lastJsonString(tail, 'gitBranch'),
        model: model ?? null,
        effort: lastJsonString(tail, 'perTurnEffort'),
      };
      cachePut(key, row);
      rows.push(row);
    } catch {
      continue; // unreadable now: not cached, the next sweep retries
    } finally {
      await fh?.close().catch(() => {});
    }
  }
  return rows;
}

/* ============================================================================
 * THE §5.1 INTERFACE, AS IMPLEMENTED (contract v0.3).
 *
 * Nothing above this line changed when the interface landed: this is a thin
 * ADAPTER that names the module's existing exports as the type's members, so
 * the reference conformer keeps being the functions that were already proven
 * in production rather than a rewrite of them. The mapping the contract §5.1
 * already published, made real:
 *
 *   VENDOR                 -> vendor            isResumable           -> resumable
 *   buildInvocation        -> invocation        mintSessionId         -> mintSessionId
 *   locateCurrentSessionId -> locate            transcriptPath        -> transcriptPath
 *   listSessions           -> listSessions      ackTranscript         -> ack
 *   end-state.ts:31        -> reconcile
 *
 * `discoverSessionId` is genuinely ABSENT and that is the point of the field:
 * claude MINTS (`--session-id <uuid>`), so there is never a race to resolve.
 * ========================================================================== */
export const vendorModule: LiveCliVendor = {
  vendor: VENDOR,
  resumable: true,
  invocation: buildInvocation,
  mintSessionId,
  locate: locateCurrentSessionId,
  transcriptPath,
  listSessions,
  ack: ackTranscript,
  reconcile(): 'dehydrated' | 'killed' {
    // The conversation lives in the transcript, which survives the engine.
    return 'dehydrated';
  },
};
