/**
 * Session TITLES — what a session is, as opposed to which project it lives in.
 *
 * THE PROBLEM THIS SOLVES (Owner, 2026-08-24): the manager listed every session
 * by its PROJECT name. He had shortened a project to "HomeHub" precisely to
 * leave room for the session name, and still saw only "HomeHub" on every row —
 * so "Open window" was a guess about which conversation he would land in.
 *
 * The name he wants already exists and is already authoritative: Claude writes
 * `customTitle` (from /rename) or `aiTitle` into the transcript, and the Resume
 * picker has been showing it all along. The engine simply never surfaced it
 * anywhere else.
 *
 * WHY A CACHE. Resolving a title means reading transcripts — a local directory
 * scan, or one ssh round trip for a server project. The manager polls /api/table
 * every 2.5s, so doing that per request would put an ssh call on a 2.5s loop.
 * So: serve whatever is known IMMEDIATELY and refresh in the BACKGROUND. A
 * title that is a few seconds stale is worth infinitely more than a manager
 * that stalls, and titles change rarely (a /rename is a deliberate act).
 *
 * This is the first piece of the index described in the design notes
 * §4-E. It is deliberately in-memory for now: titles are derived data, so losing
 * them on restart costs one refresh, not information.
 */
import * as claudeCode from './vendors/claude-code.ts';

interface Entry {
  /** sessionId -> display title (already falling back through the picker's rules). */
  byId: Map<string, string>;
  /** The raw listing. Kept because session-id ADOPTION needs mtimes, and this
   *  module already paid for the ssh round trip that produced them — fetching
   *  them twice would put a second remote call on the same loop. */
  rows: claudeCode.SessionListing[];
  fetchedAt: number;
  inFlight: boolean;
}

const cache = new Map<string, Entry>(); // key: recipe id
const TTL_MS = Number(process.env.HARBOR_WB_TITLE_TTL_MS ?? 20_000);

/** Told which project's titles just CHANGED, so the engine can push rather
 *  than wait for someone to poll. Mirrors widget-status/activity. */
let onChange: ((recipeId: string) => void) | null = null;
export function setOnChange(fn: (recipeId: string) => void): void {
  onChange = fn;
}

function entry(recipeId: string): Entry {
  let e = cache.get(recipeId);
  if (!e) {
    e = { byId: new Map(), rows: [], fetchedAt: 0, inFlight: false };
    cache.set(recipeId, e);
  }
  return e;
}

/** The title we know for a session RIGHT NOW, without doing any I/O. */
export function known(recipeId: string | null | undefined, sessionId: string | null | undefined): string | null {
  if (!recipeId || !sessionId) {
    return null;
  }
  return cache.get(recipeId)?.byId.get(sessionId) ?? worktreeEntries(recipeId).map((e) => e.byId.get(sessionId)).find(Boolean) ?? null;
}

/* A SEAT IN A GIT WORKTREE writes its transcripts under the WORKTREE's own project folder, which the
   recipe-keyed listing never contains, so its title and model/effort were missing from the seats window
   (Owner 2026-10-10, [ref]). Those listings live under a SEPARATE cache key, `<recipe>@wt:<name>`, and are
   consulted ONLY by session id (a uuid, unique across folders). They are deliberately NOT merged into
   rows(): session-id ADOPTION and /clear verdicts read rows() and skip worktree panes precisely because
   another folder's files must not be read as this project's. */
export const worktreeKey = (recipeId: string, name: string): string => `${recipeId}@wt:${name}`;
function worktreeEntries(recipeId: string): Entry[] {
  const prefix = `${recipeId}@wt:`;
  return [...cache].filter(([k]) => k.startsWith(prefix)).map(([, e]) => e);
}

/**
 * Refresh a project's titles if they are stale — fire-and-forget, never awaited
 * by a request handler. Concurrent calls collapse onto the one in flight.
 */
export function refresh(
  recipeId: string,
  opts: { projectDir: string; sshAlias?: string; agentHost?: string },
): void {
  const notifyId = recipeId.includes('@wt:') ? recipeId.slice(0, recipeId.indexOf('@wt:')) : recipeId; // listeners know recipes, not cache keys
  const e = entry(recipeId);
  if (e.inFlight || Date.now() - e.fetchedAt < TTL_MS) {
    return;
  }
  e.inFlight = true;
  void claudeCode
    .listSessions({
      projectDir: opts.projectDir,
      sshAlias: opts.sshAlias,
      agentHost: opts.agentHost,
      limit: 40,
    })
    .then((rows) => {
      const next = new Map<string, string>();
      for (const r of rows) {
        /* Same fallback the Resume picker shows, so a session reads the same in
           both places: an explicit title, else the last thing said in it, else
           the command it opened with. A session with none of those is genuinely
           untitled and should say so rather than borrow its project's name. */
        const label =
          r.title
          || (r.lastPrompt ? r.lastPrompt.slice(0, 60) : null)
          || r.firstCommand
          || null;
        if (label) {
          next.set(r.sessionId, label);
        }
      }
      const changed =
        next.size !== e.byId.size || [...next].some(([k, v]) => e.byId.get(k) !== v);
      e.byId = next;
      e.rows = rows;
      e.fetchedAt = Date.now();
      if (changed) {
        try {
          onChange?.(notifyId);
        } catch {
          /* a listener must never break the refresh that fed it */
        }
      }
    })
    .catch(() => {
      /* Unreachable host, deleted project dir, ssh timeout — a missing title is
         a cosmetic gap, never a reason to fail the request that triggered it.
         Back off by stamping the attempt so we do not retry on every poll. */
      e.fetchedAt = Date.now();
    })
    .finally(() => {
      e.inFlight = false;
    });
}

/** The transcripts we last saw for a project, newest-first, or []. No I/O. */
export function rows(recipeId: string | null | undefined): claudeCode.SessionListing[] {
  return (recipeId && cache.get(recipeId)?.rows) || [];
}

/** The model + effort a session last answered with, from the same cached
 *  listing (refreshed on the title clock for LIVE sessions). No I/O. Short
 *  names: claude-sonnet-5 → sonnet (ticket). */
export function modelOf(
  recipeId: string | null | undefined,
  sessionId: string | null | undefined,
): { model: string | null; effort: string | null } | null {
  if (!recipeId || !sessionId) {
    return null;
  }
  const r = rows(recipeId).find((x) => x.sessionId === sessionId) ?? worktreeEntries(recipeId).flatMap((e) => e.rows).find((x) => x.sessionId === sessionId);
  if (!r || (!r.model && !r.effort)) {
    return null;
  }
  const fam = r.model ? /(opus|sonnet|haiku|fable)/.exec(r.model)?.[1] ?? r.model : null;
  return { model: fam, effort: r.effort };
}

/** Drop a project's titles (its recipe was deleted or its dir changed). */
export function forget(recipeId: string): void {
  cache.delete(recipeId);
  for (const k of [...cache.keys()]) {
    if (k.startsWith(`${recipeId}@wt:`)) {
      cache.delete(k);
    }
  }
}

/**
 * Keep LIVE sessions' titles warm on the ENGINE's clock.
 *
 * THE BUG THIS FIXES (Owner, 2026-09-13): "the names of the chats aren't
 * updating again". The only caller of `refresh` was the /api/table handler, and
 * it was gated on the row having NO title yet — so the first fetch after boot
 * won, and the name froze there forever. Rows sat for days reading `/login` and
 * `/agent messaging`: the LAST PROMPT of a session that had since been renamed, and
 * whose /rename was already sitting in the transcript.
 *
 * A title is not static data. A live session is renamed (deliberately, by the
 * user), auto-titled by Claude once it has something to go on, and carries a
 * moving last-prompt fallback until then. So "fetch it once because we do not
 * know it" is the wrong shape: the right one is the same clock widget-status
 * already runs on, over the same set — LIVE sessions only, so a dead project
 * never costs an ssh round trip.
 *
 * The on-demand path in /api/table stays: it fills in a DEHYDRATED row's name,
 * which this sweep deliberately does not poll (nobody is typing in a session
 * that is not running, so its title cannot move under us).
 */
export function startAutoRefresh(
  supply: () => Array<{
    recipeId: string;
    projectDir: string;
    sshAlias?: string;
    /** See launch.ts `fsOptsFor` — the window-agent transport for a host with
     *  no ssh alias (2026-09-18). Additive: a supply that never sets it
     *  behaves exactly as before. */
    agentHost?: string;
  }>,
  everyMs = Number(process.env.HARBOR_WB_TITLE_POLL_MS ?? 20_000),
): NodeJS.Timeout {
  const t = setInterval(() => {
    try {
      for (const { recipeId, projectDir, sshAlias, agentHost } of supply()) {
        refresh(recipeId, { projectDir, sshAlias, agentHost }); // TTL still gates the I/O
      }
    } catch {
      /* a bad supply must never kill the engine's timer */
    }
  }, everyMs);
  t.unref?.();
  return t;
}
