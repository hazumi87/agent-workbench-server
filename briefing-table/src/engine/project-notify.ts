/* ============================================================================
 * PROJECT CHANNEL — "tell the other sessions" (the design notes).
 *
 * Owner, 2026-09-29: several live briefing-table sessions (different rooms, server
 * + VRPC) work on one repo; today a session only SEES another when it runs
 * git (the hooks print a brief) — nobody is TOLD when main moves or when a
 * commit lands on the SHARED checkout. This is the push half.
 *
 * TWO EVENTS, ONE NOTICE SHAPE:
 *   1. MAIN MOVED — sweepOnce(), on a timer, notices origin's default branch
 *      advance for a project with live sessions (the mirror already fetches;
 *      this reads the sha it holds and compares to the sha last seen).
 *   2. SHARED-CHECKOUT COMMIT — notifySharedCommit(), called from the
 *      POST /api/projects/:slug/shared-commit route (projects.ts), which a
 *      git post-commit hook hits when a commit lands in the shared canonical
 *      checkout (never a worktree — scripts/project-shared-commit.mjs decides
 *      that locally before it ever reaches here).
 *
 * DELIVERY IS THE CHANNEL PATH ONLY, never typed. Same mechanism as
 * room-fabric.ts's noticeOnReconnect: fabricCheckin.sendAs(null, {from, to,
 * kind:'notice', class:'info', body}), gated on channels.channelLive(paneid).
 * A recipient with no live channel (HARBOR_WB_CHANNELS off, or off for that
 * pane) is simply not reached — best effort, never a gate, same rule as every
 * other push in the design notes §2.3. We do not fall back to typing or to
 * the badge queue (fabric.ts pending/toViewers): those are a DIFFERENT
 * delivery, and mixing them here would put the notice on two ladders.
 *
 * DEDUPE + RATE: one notice per detected main-move (a sweep tick that finds
 * the sha unchanged sends nothing); one per shared-checkout commit sha (a
 * retried hook POST is a no-op, see markNotified); and a recipient is capped
 * at RATE_MAX sends per project per rolling hour — anything over the cap is
 * counted, not sent, and folded into the next notice that DOES go out as
 * "(+N more)".
 * ========================================================================== */

import { git, mirrorPath, originReport, parseSession } from './project-mirror.ts';
import { liveSessions, projectKeys, resolveRepo, type ActivityDeps, type ActivityRecipe } from './project-activity.ts';
import * as fabricCheckin from './fabric-checkin.ts';
import * as channels from './channels.ts';

/* ------------------------------------------------------------- delivery --- */

export interface SendDeps {
  /** The recipient's checked-in fabric work slug (fabric-checkin.identityOf),
   *  else `fallback` (its bare agent slug). Null when neither is known. */
  toSlug(paneid: string, fallback: string | null): string | null;
  /** Does this pane's fabric-mcp hold a live channel right now? */
  channelLive(paneid: string): Promise<boolean>;
  /** POST /send to the real fabric service, as the engine's own stamp
   *  (fabricCheckin.sendAs(null, envelope)). */
  send(envelope: Record<string, unknown>): Promise<{ ok: boolean; status: number; error?: string }>;
  log(line: string): void;
}

export interface Wiring {
  activity: ActivityDeps;
  recipes(): ActivityRecipe[];
  send: SendDeps;
}

/* ------------------------------------------------------------ rate gate --- */

const RATE_MAX = 6;
const RATE_WINDOW_MS = 60 * 60 * 1000;

interface RateState {
  windowStart: number;
  sent: number;
  suppressed: number;
}
const rate = new Map<string, RateState>();

/** `send: true` also clears and returns any count suppressed earlier in this
 *  window, to fold into the notice as "(+N more)". `send: false` records one
 *  more suppressed hit without sending. Own clock so a test can drive it. */
export function rateGate(key: string, now = Date.now()): { send: true; extra: number } | { send: false } {
  let st = rate.get(key);
  if (!st || now - st.windowStart >= RATE_WINDOW_MS) {
    // A new window carries the OLD one's suppressed count forward (into
    // `extra` on the next send below) rather than dropping it — the whole
    // point of the cap is that nothing suppressed is lost, only delayed.
    st = { windowStart: now, sent: 0, suppressed: st?.suppressed ?? 0 };
    rate.set(key, st);
  }
  if (st.sent < RATE_MAX) {
    const extra = st.suppressed;
    st.suppressed = 0;
    st.sent++;
    return { send: true, extra };
  }
  st.suppressed++;
  return { send: false };
}

/* ----------------------------------------------------- shared-commit dedupe --- */

const seenSharedCommits = new Set<string>();
const SEEN_MAX = 500;

export function alreadyNotified(slug: string, sha: string): boolean {
  return !!sha && seenSharedCommits.has(`${slug}:${sha}`);
}
export function markNotified(slug: string, sha: string): void {
  if (!sha) {
    return;
  }
  seenSharedCommits.add(`${slug}:${sha}`);
  if (seenSharedCommits.size > SEEN_MAX) {
    const first = seenSharedCommits.values().next().value;
    if (first !== undefined) {
      seenSharedCommits.delete(first);
    }
  }
}

/* -------------------------------------------------------------- pure bits --- */

const short = (sha: string): string => sha.slice(0, 7);

/** Every OTHER live session: excludes the exact pane when known, else the
 *  exact slug when THAT is known, else nothing (we could not tell who it
 *  was, so nobody is excluded — the the design notes rule: only
 *  exclude when the Session trailer actually names a pane or slug). */
export function recipientsExcluding<T extends { paneid: string; slug: string | null }>(
  live: T[],
  exclude: { paneid?: string | null; slug?: string | null },
): T[] {
  if (exclude.paneid) {
    return live.filter((s) => s.paneid !== exclude.paneid);
  }
  if (exclude.slug) {
    return live.filter((s) => s.slug !== exclude.slug);
  }
  return live;
}

/** paneid -> its seats ("@handle in room"), across every open room. */
export function seatsByPane(deps: Pick<ActivityDeps, 'openRooms' | 'seats'>): Map<string, Array<{ handle: string; room: string }>> {
  const out = new Map<string, Array<{ handle: string; room: string }>>();
  for (const room of deps.openRooms()) {
    for (const s of deps.seats(room.id)) {
      if (s.occupant_kind === 'pane' && s.occupant) {
        const list = out.get(s.occupant) ?? [];
        list.push({ handle: s.handle, room: room.name });
        out.set(s.occupant, list);
      }
    }
  }
  return out;
}

/** A pane (or, failing that, a slug) as a person reads it. */
export function whoOf(
  paneid: string | null,
  slug: string | null,
  seats: Map<string, Array<{ handle: string; room: string }>>,
): string {
  if (paneid) {
    const list = seats.get(paneid);
    if (list?.length) {
      return list.map((x) => `@${x.handle} (${x.room})`).join(', ');
    }
    return slug ? `@${slug}` : paneid;
  }
  return slug ? `@${slug}` : 'unknown';
}

/** The commit whose Session: trailer pane recurs most among `commits` (ties:
 *  first seen), else the commonest slug when no commit names a pane. Both
 *  null when neither trailer told us anything — "could not tell" (three
 *  outcomes, never two), and the caller must not exclude anyone on that. */
export function commonestPane(
  commits: Array<{ pane: string | null; slug: string | null }>,
): { paneid: string | null; slug: string | null } {
  const panes = new Map<string, number>();
  for (const c of commits) {
    if (c.pane) {
      panes.set(c.pane, (panes.get(c.pane) ?? 0) + 1);
    }
  }
  let bestPane: string | null = null;
  let bestPaneN = 0;
  for (const [p, n] of panes) {
    if (n > bestPaneN) {
      bestPane = p;
      bestPaneN = n;
    }
  }
  if (bestPane) {
    return { paneid: bestPane, slug: null };
  }
  const slugs = new Map<string, number>();
  for (const c of commits) {
    if (c.slug) {
      slugs.set(c.slug, (slugs.get(c.slug) ?? 0) + 1);
    }
  }
  let bestSlug: string | null = null;
  let bestSlugN = 0;
  for (const [s, n] of slugs) {
    if (n > bestSlugN) {
      bestSlug = s;
      bestSlugN = n;
    }
  }
  return { paneid: null, slug: bestSlug };
}

export function mainMovedBody(opts: {
  slug: string;
  fromSha: string;
  toSha: string;
  who: string;
  firstSubject: string;
  moreCommits: number;
  files: string[];
  filesTotal: number;
}): string {
  const files = opts.files.slice(0, 3);
  const extraFiles = opts.filesTotal - files.length;
  const filesPart = files.length ? `Files: ${files.join(', ')}${extraFiles > 0 ? ` (+${extraFiles})` : ''}. ` : '';
  const more = opts.moreCommits > 0 ? ` (+${opts.moreCommits} more)` : '';
  const subject = opts.firstSubject.replace(/\s+/g, ' ').trim();
  return (
    `${opts.slug} main moved ${short(opts.fromSha)} → ${short(opts.toSha)} by ${opts.who}: ` +
    `${subject}${more}. ${filesPart}Pull before you merge.`
  );
}

export function sharedCommitBody(who: string, branch: string, subject: string): string {
  return `${who} has an unpushed commit on the shared checkout's ${branch || 'main'}: ${subject.replace(/\s+/g, ' ').trim()}`;
}

/* ------------------------------------------------------------ send + gate --- */

async function sendNotice(send: SendDeps, paneid: string, opts: { from: string; to: string; body: string }): Promise<boolean> {
  try {
    const live = await send.channelLive(paneid);
    if (!live) {
      send.log(`project-notify ${paneid}: channel not live — notice not delivered`);
      return false;
    }
    const r = await send.send({ from: opts.from, to: opts.to, kind: 'notice', class: 'info', body: opts.body.slice(0, 4000) });
    send.log(`project-notify → ${opts.to} (${paneid}): ${r.ok ? 'sent' : `refused HTTP ${r.status} ${r.error ?? ''}`.trim()}`);
    return r.ok;
  } catch (e) {
    send.log(`project-notify ${paneid}: send failed: ${(e as Error).message}`);
    return false;
  }
}

/* -------------------------------------------------------- shared-checkout --- */

/**
 * A commit landed on the SHARED canonical checkout (not a worktree —
 * scripts/project-shared-commit.mjs already decided that). Tell every OTHER
 * live session of `slug`, excluding the committer's own pane. Idempotent per
 * (slug, sha): a retried hook POST notifies nobody twice.
 */
export async function notifySharedCommit(
  slug: string,
  committerPaneid: string,
  info: { subject: string; sha: string; branch: string },
  w: Wiring,
): Promise<{ notified: number }> {
  if (alreadyNotified(slug, info.sha)) {
    return { notified: 0 };
  }
  markNotified(slug, info.sha);
  const live = liveSessions(slug, w.activity);
  const recipients = recipientsExcluding(live, { paneid: committerPaneid });
  if (!recipients.length) {
    return { notified: 0 };
  }
  const seats = seatsByPane(w.activity);
  const committerRow = w.activity.sessions().find((r) => r.paneid === committerPaneid);
  const who = whoOf(committerPaneid, committerRow?.agent ?? null, seats);
  let notified = 0;
  for (const r of recipients) {
    const gate = rateGate(`${slug}:${r.paneid}`);
    if (!gate.send) {
      w.send.log(`project-notify ${slug}: rate-capped for ${r.paneid} (shared-commit)`);
      continue;
    }
    const extra = gate.extra > 0 ? ` (+${gate.extra} more)` : '';
    const to = w.send.toSlug(r.paneid, r.slug);
    if (!to) {
      continue;
    }
    if (await sendNotice(w.send, r.paneid, { from: `project-${slug}`, to, body: sharedCommitBody(who, info.branch, info.subject) + extra })) {
      notified++;
    }
  }
  return { notified };
}

/* ------------------------------------------------------------- main moved --- */

const US = String.fromCharCode(31);
const RS = String.fromCharCode(30);

interface RangeCommit {
  sha: string;
  author: string;
  subject: string;
  pane: string | null;
  slug: string | null;
}

/** Commits `from..to` in the mirror at `dir`, plus the distinct files they
 *  touched (capped to 3 + a count, same shape as the notice body). */
async function commitRange(dir: string, from: string, to: string): Promise<{ commits: RangeCommit[]; files: string[]; filesTotal: number }> {
  const fmt = `%x1e%H%x1f%an%x1f%s%x1f%(trailers:key=Session,valueonly,separator=%x2c)`;
  const r = await git(['-C', dir, 'log', `--format=${fmt}`, `${from}..${to}`, '--']);
  const commits: RangeCommit[] = [];
  if (r.ok) {
    for (const rec of r.stdout.split(RS)) {
      if (!rec.trim()) {
        continue;
      }
      // git appends a trailing newline after every --format record (there is
      // no per-record terminator to suppress it with); it lands on the LAST
      // %x1f field, so every field is trimmed rather than just that one.
      const [sha, author, subject, session] = rec.split(US).map((x) => (x ?? '').trim());
      if (!sha) {
        continue;
      }
      const parsed = parseSession(session);
      commits.push({ sha, author: author ?? '', subject: subject ?? '', pane: parsed.pane, slug: parsed.slug });
    }
  }
  const fr = await git(['-C', dir, 'log', '--cc', '--name-only', '--format=', `${from}..${to}`, '--']);
  const files = fr.ok ? [...new Set(fr.stdout.split('\n').map((x) => x.trim()).filter(Boolean))].sort() : [];
  return { commits, files, filesTotal: files.length };
}

/** origin's default branch advanced for `slug`: tell every OTHER live
 *  session, excluding the pusher when a moved commit's Session: trailer
 *  names its pane (or, failing that, its slug). */
async function notifyMainMoved(slug: string, fromSha: string, toSha: string, dir: string, w: Wiring): Promise<void> {
  const range = await commitRange(dir, fromSha, toSha);
  if (!range.commits.length) {
    w.send.log(`project-notify ${slug}: main moved ${short(fromSha)} → ${short(toSha)} but the range has no commits (force-push?) — no notice`);
    return;
  }
  const pusher = commonestPane(range.commits);
  const live = liveSessions(slug, w.activity);
  const recipients = recipientsExcluding(live, pusher);
  if (!recipients.length) {
    return;
  }
  const seats = seatsByPane(w.activity);
  const who = whoOf(pusher.paneid, pusher.slug, seats);
  let sent = 0;
  for (const r of recipients) {
    const gate = rateGate(`${slug}:${r.paneid}`);
    if (!gate.send) {
      w.send.log(`project-notify ${slug}: rate-capped for ${r.paneid} (main-moved)`);
      continue;
    }
    const to = w.send.toSlug(r.paneid, r.slug);
    if (!to) {
      continue;
    }
    const body = mainMovedBody({
      slug,
      fromSha,
      toSha,
      who,
      firstSubject: range.commits[0].subject,
      moreCommits: range.commits.length - 1 + gate.extra,
      files: range.files,
      filesTotal: range.filesTotal,
    });
    if (await sendNotice(w.send, r.paneid, { from: `project-${slug}`, to, body })) {
      sent++;
    }
  }
  w.send.log(
    `project-notify ${slug}: main moved ${short(fromSha)} → ${short(toSha)} (${range.commits.length} commit(s)) — notified ${sent}/${recipients.length}`,
  );
}

/* ---------------------------------------------------------------- sweep --- */

/** slug -> the default branch's tip sha the last time we looked. Undefined =
 *  never looked (prime only, no notice — an engine restart must not read
 *  "years of history" as one giant move). */
const mainSha = new Map<string, string>();

function liveProjectSlugs(activity: ActivityDeps): Set<string> {
  const out = new Set<string>();
  for (const row of activity.sessions()) {
    if (row.state !== 'live') {
      continue;
    }
    const recipe = row.recipe_id ? activity.recipe(row.recipe_id) : null;
    for (const k of projectKeys(row, recipe)) {
      out.add(k);
    }
  }
  return out;
}

const sweepWaitMs = (): number => Number(process.env.HARBOR_WB_PROJECT_NOTIFY_WAIT_MS) || 5_000;

async function checkProject(slug: string, url: string, w: Wiring): Promise<void> {
  /* Reuse originReport's own bounded-wait refresh (project-mirror.ts): it
     kicks a fetch if one is due (the 90 s single-flight window) and waits up
     to sweepWaitMs for it, serving what the mirror already holds otherwise —
     so ONE slow first clone cannot stall every OTHER project's turn in this
     sweep for longer than that bound. We only need `default_branch` from it;
     the exact tip sha is read fresh (never from the `hours`-windowed commit
     list, which can miss the tip if the window is narrow). */
  const report = await originReport(slug, url, { hours: 1, waitMs: sweepWaitMs(), cloneWaitMs: sweepWaitMs() * 3 });
  if (report.status === 'unavailable' || !report.default_branch) {
    return;
  }
  const dir = mirrorPath(slug);
  const r = await git(['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${report.default_branch}`]);
  const newSha = r.ok ? r.stdout.trim() : '';
  if (!newSha) {
    return;
  }
  const prev = mainSha.get(slug);
  mainSha.set(slug, newSha);
  if (prev === undefined || prev === newSha) {
    return;
  }
  await notifyMainMoved(slug, prev, newSha, dir, w);
}

/** One sweep: every project with a live session, checked once. Never throws —
 *  one project's failure is logged and does not stop the others. */
export async function sweepOnce(w: Wiring): Promise<void> {
  const recipes = w.recipes();
  for (const slug of liveProjectSlugs(w.activity)) {
    try {
      const repo = await resolveRepo(slug, recipes, w.activity.isLocal);
      if (!('origin' in repo)) {
        continue; // no local checkout with an origin: nothing to watch from here
      }
      await checkProject(slug, repo.origin, w);
    } catch (e) {
      w.send.log(`project-notify ${slug}: sweep failed: ${(e as Error).message}`);
    }
  }
}

const sweepMs = (): number => Number(process.env.HARBOR_WB_PROJECT_NOTIFY_MS) || 90_000;

let timer: ReturnType<typeof setInterval> | null = null;
let wiring: Wiring | null = null;

/** Start the main-watch timer (index.ts, at listen, beside projects.start()). */
export function start(w: Wiring): void {
  wiring = w;
  if (timer) {
    return;
  }
  timer = setInterval(() => {
    void sweepOnce(wiring!).catch((e) => wiring!.send.log(`project-notify sweep threw: ${(e as Error).message}`));
  }, sweepMs());
  timer.unref?.();
}

export function stop(): void {
  if (timer) {
    clearInterval(timer);
  }
  timer = null;
  wiring = null;
}

/** Tests only. */
export function reset(): void {
  mainSha.clear();
  rate.clear();
  seenSharedCommits.clear();
}

/** The real SendDeps: the CHANNEL path (fabric-checkin.sendAs, gated on
 *  channels.channelLive — the same pattern room-fabric.ts's
 *  noticeOnReconnect uses), sent as the engine's own stamp (paneid null). */
export function liveSendDeps(log: (line: string) => void): SendDeps {
  return {
    toSlug: (paneid, fallback) => fabricCheckin.identityOf(paneid)?.slug ?? fallback,
    channelLive: (paneid) => channels.channelLive(paneid),
    send: async (envelope) => {
      const r = await fabricCheckin.sendAs(null, envelope);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, error: (r.body as { error?: string } | undefined)?.error };
    },
    log,
  };
}
