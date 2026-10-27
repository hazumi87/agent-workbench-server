/**
 * PROJECT CHANNEL — the engine-owned bare mirror of a project's origin
 * (the design notes, the design notes §2.2).
 *
 * GIT IS THE RECORD. The engine keeps no history of its own: it reads what
 * ORIGIN says, through a bare `git clone --mirror` it owns under
 * data/mirrors/<slug>.git. Never a working checkout — a checkout belongs to
 * whoever is working in it, and a `fetch` there moves their remote-tracking
 * refs under them. The mirror is created once and then `git fetch --prune`ed
 * at most every FETCH_MIN_MS, lazily on a request and on a timer for the
 * mirrors somebody asked about recently.
 *
 * Everything here is bounded: every git call has a timeout, a clone or fetch
 * is single-flight per slug, and a request waits for a refresh only for a
 * short budget before serving what the mirror already holds (marked stale).
 */
import { gitPath, GIT_NOT_INSTALLED } from './git-resolver.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSlug } from './agent-slug.ts';
import { instancePath } from './data-dir.ts';


/** At most one fetch per mirror per this window (the agreed 90 s). */
export const FETCH_MIN_MS = 90_000;
/** A mirror nobody asked about for this long is not refreshed by the timer. */
const TIMER_INTEREST_MS = 30 * 60_000;
const CLONE_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 5_000;

export const COMMITS_MAX = 50;
export const FILES_PER_COMMIT_MAX = 30;
export const BRANCHES_MAX = 20;
export const FILES_PER_BRANCH_MAX = 50;

/* Field / record separators for git's own format strings (%x1f / %x1e).
   Built with fromCharCode: a backslash escape in source is the heredoc/Write
   trap .claude/CLAUDE.md warns about. */
const US = String.fromCharCode(31);
const RS = String.fromCharCode(30);

export function mirrorsDir(): string {
  if (process.env.HARBOR_WB_MIRRORS) {
    return process.env.HARBOR_WB_MIRRORS;
  }
  const table = process.env.HARBOR_WB_TABLE ?? instancePath('data', 'mapping.db');
  return join(dirname(table), 'mirrors');
}

export function mirrorPath(slug: string): string {
  if (!isSlug(slug)) {
    throw new Error(`not a project slug: ${JSON.stringify(slug)}`);
  }
  return join(mirrorsDir(), `${slug}.git`);
}

/** A git environment that can never prompt: a hook-less, terminal-less
 *  engine must fail fast rather than hang on a passphrase. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.GIT_SSH_COMMAND) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10';
  }
  return env;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  error: string | null;
}

/** Run git with a timeout. Never throws. */
export function git(args: string[], timeoutMs = READ_TIMEOUT_MS): Promise<GitResult> {
  const bin = gitPath();
  if (!bin) {
    return Promise.resolve({ ok: false, stdout: '', error: GIT_NOT_INSTALLED });
  }
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env: gitEnv(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const lines = String(stderr || err.message).trim().split('\n').map((l) => l.trim()).filter(Boolean);
        const why = (err as NodeJS.ErrnoException & { killed?: boolean }).killed
          ? `timed out after ${timeoutMs} ms`
          : lines.find((l) => l.startsWith('fatal:')) ?? lines[0] ?? 'git failed';
        resolve({ ok: false, stdout: String(stdout ?? ''), error: why });
        return;
      }
      resolve({ ok: true, stdout: String(stdout), error: null });
    });
  });
}

/* ----------------------------------------------------------- state ---- */

interface MirrorState {
  url: string;
  fetchedAt: number | null; // last SUCCESSFUL clone/fetch
  attemptedAt: number | null;
  lastError: string | null;
  inflight: Promise<void> | null;
  wantedAt: number; // last time a request asked about this mirror
}
const mirrors = new Map<string, MirrorState>();

let now: () => number = () => Date.now();
/** Tests only: a controllable clock for the 90 s window. */
export function setClock(fn: () => number): void {
  now = fn;
}
export function reset(): void {
  mirrors.clear();
  now = () => Date.now();
}

function stateFor(slug: string, url: string): MirrorState {
  let s = mirrors.get(slug);
  if (!s) {
    s = { url, fetchedAt: null, attemptedAt: null, lastError: null, inflight: null, wantedAt: 0 };
    mirrors.set(slug, s);
  }
  s.url = url;
  return s;
}

async function cloneOrFetch(slug: string, s: MirrorState): Promise<void> {
  const dest = mirrorPath(slug);
  s.attemptedAt = now();
  if (!existsSync(dest)) {
    mkdirSync(mirrorsDir(), { recursive: true });
    /* Clone into a temp name and rename: a half-finished clone must never be
       read as a mirror (it has no refs, so every read would say "no commits"). */
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    const r = await git(['clone', '--mirror', '--quiet', s.url, tmp], CLONE_TIMEOUT_MS);
    if (!r.ok) {
      rmSync(tmp, { recursive: true, force: true });
      s.lastError = `clone failed: ${r.error}`;
      return;
    }
    try {
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      s.lastError = `clone rename failed: ${(err as Error).message}`;
      return;
    }
  } else {
    /* The origin URL can change under us (a repo moved); follow it. */
    await git(['-C', dest, 'remote', 'set-url', 'origin', s.url]);
    const r = await git(['-C', dest, 'fetch', '--prune', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
    if (!r.ok) {
      s.lastError = `fetch failed: ${r.error}`;
      return;
    }
  }
  s.fetchedAt = now();
  s.lastError = null;
}

/** Start (or join) a refresh if one is due. Resolves when it finishes. */
export function refresh(slug: string, url: string, opts: { force?: boolean } = {}): Promise<void> {
  const s = stateFor(slug, url);
  if (s.inflight) {
    return s.inflight;
  }
  const last = s.attemptedAt;
  if (!opts.force && last !== null && now() - last < FETCH_MIN_MS && existsSync(mirrorPath(slug))) {
    return Promise.resolve();
  }
  s.inflight = cloneOrFetch(slug, s)
    .catch((err) => {
      s.lastError = (err as Error).message;
    })
    .finally(() => {
      s.inflight = null;
    });
  return s.inflight;
}

/** Wait for `p` at most `ms`. True when it finished in time. */
function within(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/* ----------------------------------------------------------- reads ---- */

export interface OriginCommit {
  sha: string;
  author: string;
  subject: string;
  /** The `Session:` trailer (the design notes), or null. */
  session: string | null;
  /** The pane named in that trailer (`pane=<paneid>`), or null: the unit a
   *  reader compares, since the trailer's slug is the PROJECT's. */
  pane: string | null;
  time: string;
  files: string[];
  files_total: number;
}
export interface OriginBranch {
  name: string;
  sha: string;
  author: string;
  time: string;
  /** Files the branch's OWN commits touched (`git log --cc --name-only
   *  main..branch`), capped. A branch already contained in main is not listed. */
  files: string[];
  files_total: number;
}
export interface OriginReport {
  /** ok = fetched within the window; stale = serving an older fetch (the
   *  refresh failed or is still running); unavailable = no mirror to read. */
  status: 'ok' | 'stale' | 'unavailable';
  reason: string | null;
  url: string;
  default_branch: string | null;
  fetched_at: string | null;
  hours: number;
  commits: OriginCommit[];
  branches: OriginBranch[];
}

async function defaultBranch(dir: string): Promise<string | null> {
  const r = await git(['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
  const name = r.ok ? r.stdout.trim() : '';
  if (name) {
    const exists = await git(['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    if (exists.ok) {
      return name;
    }
  }
  for (const guess of ['main', 'master']) {
    const r2 = await git(['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${guess}`]);
    if (r2.ok) {
      return guess;
    }
  }
  return null;
}

function cap(list: string[], max: number): { files: string[]; files_total: number } {
  return { files: list.slice(0, max), files_total: list.length };
}

/** The parts of a `Session:` trailer value: `<slug> pane=<paneid>`, either
 *  part optional (prepare-commit-msg). A value with no `pane=` has no pane. */
export function parseSession(value: string | null | undefined): { slug: string | null; pane: string | null } {
  let slug: string | null = null;
  let pane: string | null = null;
  for (const tok of String(value ?? '').split(/[ ,]+/)) {
    if (tok.startsWith('pane=') && tok.length > 5) {
      pane = pane ?? tok.slice(5);
    } else if (!slug && isSlug(tok)) {
      slug = tok;
    }
  }
  return { slug, pane };
}

async function readCommits(dir: string, branch: string, sinceSec: number): Promise<OriginCommit[]> {
  const fmt = `%x1e%H%x1f%an%x1f%cI%x1f%s%x1f%(trailers:key=Session,valueonly,separator=%x2c)`;
  const r = await git([
    '-C', dir, 'log', `--since=@${sinceSec}`, `--max-count=${COMMITS_MAX}`,
    `--format=${fmt}`, '--name-only', `refs/heads/${branch}`, '--',
  ]);
  if (!r.ok) {
    return [];
  }
  const out: OriginCommit[] = [];
  for (const rec of r.stdout.split(RS)) {
    if (!rec.trim()) {
      continue;
    }
    const nl = rec.indexOf('\n');
    const head = nl === -1 ? rec : rec.slice(0, nl);
    const rest = nl === -1 ? '' : rec.slice(nl + 1);
    const [sha, author, time, subject, session] = head.split(US);
    const files = rest.split('\n').map((x) => x.trim()).filter(Boolean);
    out.push({
      sha,
      author: author ?? '',
      subject: subject ?? '',
      session: session && session.trim() ? session.trim() : null,
      pane: parseSession(session).pane,
      time: time ?? '',
      ...cap(files, FILES_PER_COMMIT_MAX),
    });
  }
  return out;
}

async function readBranches(dir: string, main: string, sinceSec: number): Promise<OriginBranch[]> {
  /* for-each-ref spells a hex byte `%1f` (git log spells it `%x1f`). */
  const r = await git([
    '-C', dir, 'for-each-ref', '--sort=-committerdate',
    '--format=%(refname:short)%1f%(objectname)%1f%(authorname)%1f%(committerdate:unix)', 'refs/heads',
  ]);
  if (!r.ok) {
    return [];
  }
  const out: OriginBranch[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [name, sha, author, unix] = line.split(US);
    const t = Number(unix);
    if (!name || name === main || !Number.isFinite(t) || t < sinceSec) {
      continue;
    }
    /* A branch whose tip main already contains has nothing of its own. */
    const contained = await git(['-C', dir, 'merge-base', '--is-ancestor', `refs/heads/${name}`, `refs/heads/${main}`]);
    if (contained.ok) {
      continue;
    }
    if (out.length >= BRANCHES_MAX) {
      break;
    }
    /* The files the branch's OWN commits touched, not `git diff main...branch`:
       the three-dot diff picks ONE merge base, and a branch whose tip is a merge
       of two commits main already has (deploy/r17, vrpc1 2026-09-28) has two,
       so it reported a file that came in from main's side. `--cc` lists a
       merge's file only when the merge result differs from EVERY parent (a
       conflict resolution), so a clean merge of main's own commits adds none. */
    const d = await git(['-C', dir, 'log', '--cc', '--name-only', '--format=', `refs/heads/${main}..refs/heads/${name}`, '--']);
    const files = d.ok ? [...new Set(d.stdout.split('\n').map((x) => x.trim()).filter(Boolean))].sort() : [];
    out.push({ name, sha, author: author ?? '', time: new Date(t * 1000).toISOString(), ...cap(files, FILES_PER_BRANCH_MAX) });
  }
  return out;
}

/**
 * What origin says about a project in the last `hours`: refresh the mirror if
 * due (waiting at most `waitMs`, or `cloneWaitMs` for a first clone), then
 * read it. Never throws; a failure is a status + reason.
 */
export async function originReport(
  slug: string,
  url: string,
  opts: { hours: number; waitMs?: number; cloneWaitMs?: number },
): Promise<OriginReport> {
  const dir = mirrorPath(slug);
  const s = stateFor(slug, url);
  s.wantedAt = now();
  const hadMirror = existsSync(dir);
  const p = refresh(slug, url);
  await within(p, hadMirror ? (opts.waitMs ?? 3_000) : (opts.cloneWaitMs ?? 15_000));
  const base: OriginReport = {
    status: 'unavailable',
    reason: null,
    url,
    default_branch: null,
    fetched_at: s.fetchedAt ? new Date(s.fetchedAt).toISOString() : null,
    hours: opts.hours,
    commits: [],
    branches: [],
  };
  if (!existsSync(dir)) {
    return { ...base, reason: s.lastError ?? (s.inflight ? 'first clone still running' : 'no mirror yet') };
  }
  const main = await defaultBranch(dir);
  if (!main) {
    return { ...base, reason: 'the mirror has no default branch' };
  }
  const sinceSec = Math.floor(now() / 1000) - Math.round(opts.hours * 3600);
  const [commits, branches] = [await readCommits(dir, main, sinceSec), await readBranches(dir, main, sinceSec)];
  const fresh = s.fetchedAt !== null && now() - s.fetchedAt < 2 * FETCH_MIN_MS && !s.lastError;
  return {
    ...base,
    status: fresh ? 'ok' : 'stale',
    reason: fresh ? null : (s.lastError ?? (s.inflight ? 'refresh still running' : 'not refreshed recently')),
    default_branch: main,
    commits,
    branches,
  };
}

/* ----------------------------------------------------------- timer ---- */

let timer: NodeJS.Timeout | null = null;

/** Refresh, every FETCH_MIN_MS, the mirrors someone asked about in the last
 *  half hour. Unref'd: it never holds the process open. */
export function startTimer(): void {
  if (timer) {
    return;
  }
  timer = setInterval(() => {
    for (const [slug, s] of mirrors) {
      if (now() - s.wantedAt < TIMER_INTEREST_MS) {
        void refresh(slug, s.url);
      }
    }
  }, FETCH_MIN_MS);
  timer.unref();
}

export function dump(): Array<{ slug: string; url: string; fetched_at: string | null; error: string | null; inflight: boolean }> {
  return [...mirrors].map(([slug, s]) => ({
    slug,
    url: s.url,
    fetched_at: s.fetchedAt ? new Date(s.fetchedAt).toISOString() : null,
    error: s.lastError,
    inflight: !!s.inflight,
  }));
}
