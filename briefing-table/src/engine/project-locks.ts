/**
 * PROJECT LOCKS — one advisory lock per project (the design notes).
 *
 * The MERGE-LOCK that went to one room only (Owner's test, 2026-09-28) becomes
 * an engine fact every session of the project can see: activity lists it and
 * the pre-push hook prints it. ADVISORY: nothing here gates a commit or a push
 * (the design notes §2.2 — "nothing here gates a commit; claims are
 * advisory"). In memory, with a TTL, so a lock whose holder died simply
 * lapses; an engine restart drops every lock, which is the right failure for
 * an advisory claim (a stale lock that outlives its reason is worse than none).
 */

export const TTL_MAX_SEC = 900;
export const TTL_DEFAULT_SEC = 300;
const BRANCH_MAX = 200;
const NOTE_MAX = 280;

export type LockHolder =
  | { kind: 'pane'; paneid: string; slug: string | null }
  | { kind: 'user'; key: string; name: string | null };

export interface ProjectLock {
  project: string;
  holder: LockHolder;
  branch: string | null;
  note: string | null;
  ttl_sec: number;
  since: string;
  expires_at: string;
}

interface Held {
  lock: ProjectLock;
  expires: number;
}

const locks = new Map<string, Held>();

export function sameHolder(a: LockHolder, b: LockHolder): boolean {
  if (a.kind === 'pane' && b.kind === 'pane') {
    return a.paneid === b.paneid;
  }
  if (a.kind === 'user' && b.kind === 'user') {
    return a.key === b.key;
  }
  return false;
}

/** "who" for a message: the pane (and its slug) or the person. */
export function describeHolder(h: LockHolder): string {
  if (h.kind === 'pane') {
    return h.slug ? `${h.slug} (${h.paneid})` : h.paneid;
  }
  return h.name ? `user ${h.name}` : 'the user';
}

export class LockInputError extends Error {
  field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}

export interface LockInput {
  branch: string | null;
  note: string | null;
  ttl_sec: number;
  /** Set when the caller asked for more than TTL_MAX_SEC: what they asked for. */
  clamped_from?: number;
  /** True when the caller sent no TTL, so TTL_DEFAULT_SEC applies. */
  ttl_default?: boolean;
}

/** Validate the POST body's fields. Throws LockInputError naming the field.
 *  The TTL is `ttl_sec` or `ttl` (ttl_sec wins when both are sent); over the
 *  maximum it is CLAMPED and `clamped_from` says so, never silently shortened
 *  (vrpc1 asked for 600 as `ttl` and got the default with no word why). */
export function parseLockBody(b: Record<string, unknown>): LockInput {
  const field = b.ttl_sec !== undefined && b.ttl_sec !== null ? 'ttl_sec' : b.ttl !== undefined && b.ttl !== null ? 'ttl' : null;
  let ttl = TTL_DEFAULT_SEC;
  let clamped: number | undefined;
  if (field) {
    const v = b[field];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new LockInputError(`${field} is a whole number of seconds, 1..${TTL_MAX_SEC} (more is clamped to ${TTL_MAX_SEC})`, field);
    }
    if (v > TTL_MAX_SEC) {
      clamped = v;
      ttl = TTL_MAX_SEC;
    } else {
      ttl = v;
    }
  }
  const str = (v: unknown, field: string, max: number): string | null => {
    if (v === undefined || v === null || v === '') {
      return null;
    }
    if (typeof v !== 'string' || v.length > max) {
      throw new LockInputError(`${field} is a string of at most ${max} characters`, field);
    }
    return v.trim() || null;
  };
  return {
    branch: str(b.branch, 'branch', BRANCH_MAX),
    note: str(b.note, 'note', NOTE_MAX),
    ttl_sec: ttl,
    ...(clamped !== undefined ? { clamped_from: clamped } : {}),
    ...(field ? {} : { ttl_default: true }),
  };
}

function sweep(now: number): void {
  for (const [project, h] of locks) {
    if (h.expires <= now) {
      locks.delete(project);
    }
  }
}

export type AcquireResult =
  | { ok: true; lock: ProjectLock; renewed: boolean }
  | { ok: false; status: 409; lock: ProjectLock };

/** Take or renew the project's lock. A second holder gets 409 naming the
 *  current one; the same holder renews (new branch/note/ttl, new expiry). */
export function acquire(
  project: string,
  holder: LockHolder,
  input: { branch: string | null; note: string | null; ttl_sec: number },
  now = Date.now(),
): AcquireResult {
  sweep(now);
  const cur = locks.get(project);
  if (cur && !sameHolder(cur.lock.holder, holder)) {
    return { ok: false, status: 409, lock: cur.lock };
  }
  const expires = now + input.ttl_sec * 1000;
  const lock: ProjectLock = {
    project,
    holder,
    branch: input.branch,
    note: input.note,
    ttl_sec: input.ttl_sec,
    since: cur ? cur.lock.since : new Date(now).toISOString(),
    expires_at: new Date(expires).toISOString(),
  };
  locks.set(project, { lock, expires });
  return { ok: true, lock, renewed: !!cur };
}

export type ReleaseResult = { ok: true; lock: ProjectLock } | { ok: false; status: 403 | 404; lock: ProjectLock | null };

/** Only the holder may release. */
export function release(project: string, holder: LockHolder, now = Date.now()): ReleaseResult {
  sweep(now);
  const cur = locks.get(project);
  if (!cur) {
    return { ok: false, status: 404, lock: null };
  }
  if (!sameHolder(cur.lock.holder, holder)) {
    return { ok: false, status: 403, lock: cur.lock };
  }
  locks.delete(project);
  return { ok: true, lock: cur.lock };
}

/** The project's active locks (zero or one today; a list so the shape can grow). */
export function list(project: string, now = Date.now()): ProjectLock[] {
  sweep(now);
  const cur = locks.get(project);
  return cur ? [cur.lock] : [];
}

export function reset(): void {
  locks.clear();
}
