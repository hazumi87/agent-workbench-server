/**
 * AGENT-FS — the window agent as the engine's file reader for ITS host.
 *
 * WHY THIS EXISTS (Owner, 2026-09-18). The "Briefing Table" recipe is
 * `target:'local'` with `projectDir: C:\projects\workbench`, and since the
 * cutover that target is BROKER-RESIDENT ON THE VRPC while the engine runs on
 * the server. Yesterday's polarity fix (`remoteFsAccess`, launch.ts) correctly
 * stopped the server checking its own disk for a Windows path — it answered
 * `unreachable`, which is honest and useless: the Resume picker read "no resume
 * history" for a project with months of transcripts sitting under winuser's
 * `%USERPROFILE%\.claude\projects\` on the VRPC. There is no ssh alias from the
 * server's `svc-ops` account into winuser's Windows account and there is not
 * going to be one.
 *
 * THE ONE THING ON THE VRPC THAT ALREADY TALKS TO THE ENGINE IS THE WINDOW
 * AGENT (contract §5b): cli-manager dials OUT to `WS /window-agent`, registers,
 * and executes what the engine asks. It runs as winuser, on the VRPC, with
 * exactly the account that owns those transcripts. So it is already the
 * librarian of §5.3 in everything but name — it just could not read a file.
 * This module is the three frames that let it, and nothing else.
 *
 * THE DIVISION OF LABOUR IS THE DESIGN: THE AGENT MOVES BYTES, THE ENGINE
 * PARSES THEM. Not a style preference — the transcript format is a VENDOR's
 * (§5.1), and the moment an agent knows what `customTitle` means, every brand's
 * on-disk format has to be taught to every desktop that might host it. The
 * agent knows exactly one format-shaped thing, `encodeProjectDir`, and it is
 * written out in the contract so it can be implemented from the spec rather
 * than from our source.
 *
 * WHAT IS DELIBERATELY ABSENT: there is no `fs.write`, and there must never be
 * one. The librarian rule (§5.3) is "loopback only, read-only, no write verbs —
 * a librarian that could write would be a second way to mutate a conversation".
 * The same rule holds here with more force, because this reader is reached over
 * a tailnet socket rather than a loopback one. `root` is a fixed enum of ONE
 * value for the same reason: the engine can name a project dir, never a path.
 *
 * TRANSPORT IS INJECTED, NOT IMPORTED. This module could reach into
 * `desktop-actions.ts` directly, but that module imports `server/auth.ts`,
 * which MINTS AND WRITES `secrets/engine.token` at module load — so a unit test
 * that imported `launch.ts` to ask one question about a target would have
 * created a credential file as a side effect. `desktop-actions.ts` registers
 * itself here at the bottom of its own file instead: self-wiring for the real
 * engine, injectable for a test, and no import cycle in either direction.
 */

/** The only root an agent will resolve. One value, on purpose — see the header. */
export const FS_ROOT = 'claude-projects' as const;

export interface FsEntry {
  name: string;
  size: number;
  /** ISO-8601, as the agent reported it. Parsed to ms by `mtimeMsOf`. */
  mtime: string;
}

export interface FsGrepMatch {
  name: string;
  line: string;
}

/** The engine half of a `/window-agent` socket, narrowed to what this needs.
 *  Implemented by `desktop-actions.ts`; faked by tests. */
export interface AgentFsTransport {
  /** Is there an agent registered for this host advertising this capability? */
  has(host: string, capability: string): boolean;
  /** Send one frame and resolve with the agent's reply frame (or reject). */
  request(host: string, msg: Record<string, unknown>, timeoutMs: number): Promise<any>;
}

let transport: AgentFsTransport | null = null;

/** Wire the live transport (desktop-actions does this for itself at boot), or
 *  `null` to unwire it — which is what a test does when it is finished, so a
 *  later test in the same process cannot inherit a stub. */
export function setTransport(t: AgentFsTransport | null): void {
  transport = t;
}

/** The capability an agent must advertise in its `register` frame before the
 *  engine will ask it to read anything. Absent = the engine behaves exactly as
 *  it did before this module existed. */
export const FS_CAPABILITY = 'fs';

/**
 * Is this host's desktop able to answer file questions RIGHT NOW?
 *
 * Deliberately a live check rather than a cached fact: an agent is a socket,
 * and one that dropped thirty seconds ago must not keep a target looking
 * reachable — `remoteFsAccess` calls this on every lookup and an absent agent
 * simply restores the previous (`unreachable`) answer.
 */
export function hasFsAgent(host: string | null | undefined): boolean {
  if (!host || !transport) {
    return false;
  }
  try {
    return transport.has(host, FS_CAPABILITY);
  } catch {
    return false;
  }
}

/** Per-request ceiling. Eight seconds is the frame spec's; past it the caller
 *  gets the UNKNOWN answer, never a false empty. */
export const FS_TIMEOUT_MS = Number(process.env.HARBOR_WB_AGENTFS_TIMEOUT_MS ?? 8_000);

/** `fs.read`'s default and hard ceiling, both from the frame spec. A read that
 *  asks for more than the max is CLAMPED rather than refused: the caller's
 *  budget is a performance choice and the ceiling is a protocol fact. */
export const READ_DEFAULT_BYTES = 65_536;
export const READ_MAX_BYTES = 1024 * 1024;

export class AgentFsError extends Error {
  constructor(
    message: string,
    /** The agent's own `error` string when it answered, else a transport word
     *  (`timeout`, `no-agent`). Callers branch on this, never on the message. */
    readonly code: string,
  ) {
    super(message);
    this.name = 'AgentFsError';
  }
}

async function ask(host: string, msg: Record<string, unknown>, timeoutMs?: number): Promise<any> {
  if (!transport) {
    throw new AgentFsError('no window-agent transport is wired', 'no-agent');
  }
  if (!transport.has(host, FS_CAPABILITY)) {
    throw new AgentFsError(`no fs-capable window agent for host "${host}"`, 'no-agent');
  }
  let reply: any;
  try {
    reply = await transport.request(host, msg, timeoutMs ?? FS_TIMEOUT_MS);
  } catch (e) {
    throw new AgentFsError((e as Error).message || 'agent request failed', 'timeout');
  }
  if (!reply || reply.ok !== true) {
    const code = typeof reply?.error === 'string' && reply.error ? reply.error : 'agent-error';
    throw new AgentFsError(`${msg.type} failed on ${host}: ${code}`, code);
  }
  return reply;
}

/**
 * `fs.list` — the *.jsonl transcripts the agent holds for this project dir.
 *
 * `dir` is the RAW project dir exactly as the recipe spells it. The agent does
 * the encoding into `~/.claude/projects/<encoded>`, so a Windows path stays a
 * Windows path on the wire and the engine never has to know whose home it is.
 */
export function list(
  host: string,
  dir: string,
  opts: { glob?: string; timeoutMs?: number } = {},
): Promise<FsEntry[]> {
  return ask(
    host,
    { type: 'fs.list', root: FS_ROOT, dir, glob: opts.glob ?? '*.jsonl' },
    opts.timeoutMs,
  ).then((r) => {
    const entries = Array.isArray(r.entries) ? r.entries : [];
    return entries
      .map((e: any) => ({
        name: String(e?.name ?? ''),
        size: Number(e?.size ?? 0) || 0,
        mtime: typeof e?.mtime === 'string' ? e.mtime : '',
      }))
      .filter((e: FsEntry) => e.name.length > 0);
  });
}

/** ISO → epoch ms, 0 for anything unparseable. A transcript with no usable
 *  mtime sorts last rather than throwing the whole listing away. */
export function mtimeMsOf(e: FsEntry): number {
  const t = Date.parse(e.mtime);
  return Number.isFinite(t) ? t : 0;
}

export interface FsReadResult {
  data: string;
  /** The file's full size as the agent sees it — NOT the length of `data`. */
  size: number;
  eof: boolean;
}

/**
 * `fs.read` — a byte slice of one transcript, as utf-8 text.
 *
 * THE TAIL IS FETCHED BY A COMPUTED OFFSET, NOT BY A NEGATIVE ONE. The ssh path
 * reads a transcript backwards with `tac`; there is no such verb here, and
 * inventing "offset may be negative" would have put a second rule into a spec
 * another agent is implementing against this week. `fs.list` already reports
 * `size`, so the engine computes `size - tail` itself and the agent stays a
 * plain ranged reader.
 */
export function read(
  host: string,
  dir: string,
  name: string,
  opts: { offset?: number; limit?: number; timeoutMs?: number } = {},
): Promise<FsReadResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? READ_DEFAULT_BYTES, READ_MAX_BYTES));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  return ask(
    host,
    { type: 'fs.read', root: FS_ROOT, dir, name, offset, limit },
    opts.timeoutMs,
  ).then((r) => ({
    data: typeof r.data === 'string' ? r.data : '',
    size: Number(r.size ?? 0) || 0,
    eof: r.eof === true,
  }));
}

/**
 * `fs.grep` — which transcripts contain a LITERAL substring.
 *
 * NOT A REGEX, and that is in the frame spec for a reason: the one caller is
 * the locate-refresh, whose needle is the STRUCTURAL `"sessionId":"<uuid>"`
 * field (vk [ref]). A regex on the wire would be a second parser to agree on
 * across four brands' agents, and an easy denial-of-service against a desktop
 * that is also drawing the user's windows.
 */
export function grep(
  host: string,
  dir: string,
  pattern: string,
  opts: { glob?: string; maxMatches?: number; timeoutMs?: number } = {},
): Promise<FsGrepMatch[]> {
  return ask(
    host,
    {
      type: 'fs.grep',
      root: FS_ROOT,
      dir,
      pattern,
      glob: opts.glob ?? '*.jsonl',
      maxMatches: opts.maxMatches ?? 3,
    },
    opts.timeoutMs,
  ).then((r) => {
    const matches = Array.isArray(r.matches) ? r.matches : [];
    return matches
      .map((m: any) => ({ name: String(m?.name ?? ''), line: String(m?.line ?? '') }))
      .filter((m: FsGrepMatch) => m.name.length > 0);
  });
}

export interface AgentDirCheck {
  /** null = could not find out. NEVER "missing" — the three-outcome rule
   *  (project-dir.ts) is the whole reason the dir check is trustworthy. */
  exists: boolean | null;
  warning?: string;
}

/**
 * Does this project dir look right, as far as the agent can see?
 *
 * WHAT IS ACTUALLY VERIFIED IS NOT THE PROJECT DIR — IT IS THE TRANSCRIPT DIR,
 * and that difference has to be in the warning text or the check lies. The
 * agent is nailed to `root:"claude-projects"` (no path outside it is ever
 * served, which is what makes handing a desktop a file reader safe at all), so
 * the question it can answer is "has claude ever run in a directory that
 * encodes to this string". That is a PROXY for the project dir existing — but
 * it is exactly the proxy that catches the failure this check was written for:
 * Kiosk's trailing slash (2026-09-13), where the path was real, the ENCODING
 * was one character off, and every transcript lookup silently read an empty
 * directory.
 *
 * So the outcomes are deliberately conservative:
 *   entries          -> true   (proof: claude's own files are under this key)
 *   ok, but empty    -> null   (a brand-new project and a wrong path are
 *                               indistinguishable from here; calling that
 *                               `false` is the cry-wolf the three-outcome rule
 *                               exists to prevent)
 *   ENOENT           -> false  (no transcript dir at all — say so, and say
 *                               what was checked)
 *   anything else    -> null
 */
export async function checkProjectDir(
  host: string,
  dir: string,
  opts: { timeoutMs?: number } = {},
): Promise<AgentDirCheck> {
  if (!dir) {
    return { exists: null };
  }
  try {
    const entries = await list(host, dir, { timeoutMs: opts.timeoutMs });
    if (entries.length > 0) {
      return { exists: true };
    }
    return {
      exists: null,
      warning: `${host} has no claude transcripts for ${dir} yet — the folder itself was not checked (a new project looks the same as a wrong path)`,
    };
  } catch (e) {
    const err = e as AgentFsError;
    if (/ENOENT|not found|no such/i.test(err.code)) {
      return {
        exists: false,
        warning: `no claude transcript dir on ${host} for ${dir} — claude has never run there (check the path)`,
      };
    }
    return { exists: null, warning: `could not reach the ${host} window agent to check ${dir}` };
  }
}
