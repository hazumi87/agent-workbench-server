/* ============================================================================
 * PROJECT CHANNEL ROUTES (the design notes).
 *
 *   GET    /api/projects/:slug/activity[?hours=N&wait_ms=M]   live + origin + locks
 *   POST   /api/projects/:slug/lock   {branch?, note?, ttl_sec? | ttl?, from?}
 *   DELETE /api/projects/:slug/lock   {from?}
 *   POST   /api/projects/:slug/shared-commit   {subject, sha?, branch?}
 *
 * Wired from server/index.ts BELOW the auth and forced-change gates, like the
 * rooms routes, and ALSO on the pane-token path (a hook running inside a pane
 * presents that pane's token). There is NO loopback exemption: this is not
 * the hook sink (trap 14 — only `isLocalHookDelivery` is exempt, and it must
 * not grow).
 *
 * THE HOLDER IS NEVER CALLER-SUPPLIED FREE TEXT (the rooms `from` rule,
 * rooms.ts authorFor). A pane token holds as its own pane. A bearer must name
 * `from: {paneid} | {session_id}` resolving to a LIVE row, or it is 403 field
 * 'from' — every agent holds the bearer, so "no from" cannot mean anybody.
 * No `from` on a HUMAN credential (a window cookie) = the person.
 *
 * shared-commit is PANE-TOKEN ONLY (never the bearer, never a human
 * credential): the whole point is "which pane just committed", and only the
 * pane's own token says that without trusting caller-supplied free text —
 * same reasoning as the lock holder rule, tightened because there is no
 * `from` escape hatch here. project-notify.ts (the push half — main-moved +
 * shared-commit notices, delivered over the channel, never typed) is wired
 * through notifyWiring() below.
 * ========================================================================== */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from './http-util.ts';
import { table } from '../table/endpoint.ts';
import { isSlug } from '../engine/agent-slug.ts';
import { engineNode, hostOfTarget, loadTargets, remoteFsAccess } from '../engine/launch.ts';
import * as paneTokens from '../engine/pane-tokens.ts';
import * as mirror from '../engine/project-mirror.ts';
import * as locks from '../engine/project-locks.ts';
import { branchOfDir, liveWithBranches, projectKeys, resolveRepo, type ActivityDeps, type ActivityRecipe } from '../engine/project-activity.ts';
import * as projectNotify from '../engine/project-notify.ts';
import type { Principal } from '../identity/auth.ts';
import { pictureOwner } from './picture-owner.ts';

export interface ProjectRouteDeps {
  log(line: string): void;
  /** A HUMAN credential (index.ts humanCredential). */
  human: boolean;
  principal: Principal | null;
  /** Set only on the pane-token path: the request IS this pane. */
  agent?: { paneid: string };
}

const HOURS_DEFAULT = 24;
const HOURS_MAX = 168;
const WAIT_MAX_MS = 15_000;
const SUBJECT_MAX = 300;
const SHA_MAX = 64;
const BRANCH_MAX = 200;
const ROUTE = /^\/api\/projects\/([^/]+)\/(activity|lock|shared-commit)$/;

function toRecipe(r: any): ActivityRecipe | null {
  return r ? { id: r.id, name: r.name, agent: r.agent ?? null, projectDir: r.projectDir ?? null, target: r.target } : null;
}

function activityDeps(): ActivityDeps {
  const targets = loadTargets();
  const target = (id: string) => targets.find((t) => t.id === id);
  return {
    sessions: () => table.list(),
    recipe: (id) => toRecipe(table.getRecipe(id)),
    nodeOf: (id) => hostOfTarget(id ? target(id) : undefined),
    isLocal: (id) => remoteFsAccess(target(id)).mode === 'local',
    openRooms: () => table.listRooms({ state: 'open' }),
    seats: (roomId) => table.listSeats(roomId),
    branchOf: branchOfDir,
  };
}

/** project-notify.ts's wiring, assembled from the same pieces as
 *  activityDeps() — the one place this composition happens. */
export function notifyWiring(log: (line: string) => void): projectNotify.Wiring {
  return {
    activity: activityDeps(),
    recipes: () => table.listRecipes().map((r) => toRecipe(r)!),
    send: projectNotify.liveSendDeps(log),
  };
}

class RouteError extends Error {
  status: number;
  field: string | null;
  constructor(status: number, message: string, field: string | null = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

/** Who is taking or releasing the lock (see the header). */
function holderFor(from: unknown, deps: ProjectRouteDeps): locks.LockHolder {
  if (deps.agent) {
    if (from !== undefined && from !== null && !paneTokens.isOwnPane(from, deps.agent.paneid)) {
      throw new RouteError(403, 'a pane token holds as its own pane; from names another', 'from');
    }
    const row = table.get(deps.agent.paneid);
    return { kind: 'pane', paneid: deps.agent.paneid, slug: row?.agent ?? null };
  }
  if (from === undefined || from === null) {
    if (!deps.human) {
      throw new RouteError(403, 'from: an agent must say which session holds the lock ({paneid} or {session_id})', 'from');
    }
    const who = pictureOwner(deps.principal);
    return { kind: 'user', key: who.key, name: who.name };
  }
  if (typeof from !== 'object' || Array.isArray(from)) {
    throw new RouteError(400, 'from is {paneid} or {session_id}', 'from');
  }
  const f = from as Record<string, unknown>;
  let rows: Array<{ paneid: string; agent: string | null; updated_at: number }> = [];
  if (typeof f.paneid === 'string' && f.paneid) {
    const row = table.get(f.paneid);
    rows = row && row.state === 'live' ? [row] : [];
  } else if (typeof f.session_id === 'string' && f.session_id) {
    rows = table.list().filter((r) => r.session_id === f.session_id && r.state === 'live');
  } else {
    throw new RouteError(400, 'from is {paneid} or {session_id}', 'from');
  }
  if (!rows.length) {
    throw new RouteError(403, 'from: no live session there', 'from');
  }
  const row = rows.sort((a, b) => b.updated_at - a.updated_at)[0];
  return { kind: 'pane', paneid: row.paneid, slug: row.agent ?? null };
}

async function activity(slug: string, url: string): Promise<Record<string, unknown>> {
  const q = new URL(url, 'http://x').searchParams;
  let hours = HOURS_DEFAULT;
  if (q.has('hours')) {
    const h = Number(q.get('hours'));
    if (!Number.isFinite(h) || h <= 0 || h > HOURS_MAX) {
      throw new RouteError(400, `hours is a number in (0, ${HOURS_MAX}]`, 'hours');
    }
    hours = h;
  }
  /* How long this request may wait for a due mirror refresh before serving
     what the mirror already holds (a hook with a 2 s budget passes a small
     one). Default 3 s, or 15 s for a first clone. */
  let waitMs: number | undefined;
  if (q.has('wait_ms')) {
    const w = Number(q.get('wait_ms'));
    if (!Number.isInteger(w) || w < 0 || w > WAIT_MAX_MS) {
      throw new RouteError(400, `wait_ms is an integer 0..${WAIT_MAX_MS}`, 'wait_ms');
    }
    waitMs = w;
  }
  const deps = activityDeps();
  const live = await liveWithBranches(slug, deps);
  const recipes = table.listRecipes().map((r) => toRecipe(r)!);
  const repo = await resolveRepo(slug, recipes, deps.isLocal);
  const origin =
    'origin' in repo
      ? await mirror.originReport(slug, repo.origin, waitMs === undefined ? { hours } : { hours, waitMs, cloneWaitMs: waitMs })
      : { status: 'unavailable', reason: repo.reason, hours, commits: [], branches: [] };
  return {
    ok: true,
    project: slug,
    node: engineNode(),
    generated_at: new Date().toISOString(),
    repo: 'origin' in repo ? repo : null,
    live,
    origin,
    locks: locks.list(slug),
  };
}

/** True when the route was a project route (answered either way). */
export async function handle(req: IncomingMessage, res: ServerResponse, route: string, deps: ProjectRouteDeps): Promise<boolean> {
  const m = ROUTE.exec(route);
  if (!m) {
    return false;
  }
  const method = req.method ?? 'GET';
  let slug = '';
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    /* falls through to the slug check */
  }
  try {
    if (!isSlug(slug)) {
      throw new RouteError(400, 'not a project slug', 'slug');
    }
    if (m[2] === 'activity') {
      if (method !== 'GET') {
        throw new RouteError(405, 'GET only');
      }
      sendJson(res, 200, await activity(slug, req.url ?? route));
      return true;
    }
    if (m[2] === 'shared-commit') {
      if (method !== 'POST') {
        throw new RouteError(405, 'POST only');
      }
      if (!deps.agent) {
        throw new RouteError(403, 'shared-commit is pane-token only (never the engine bearer)');
      }
      const row = table.get(deps.agent.paneid);
      if (!row || row.state !== 'live') {
        throw new RouteError(403, 'no live session for this pane token');
      }
      const recipe = row.recipe_id ? toRecipe(table.getRecipe(row.recipe_id)) : null;
      if (!projectKeys(row, recipe).has(slug)) {
        throw new RouteError(403, `pane ${deps.agent.paneid} is not a session of project "${slug}"`, 'slug');
      }
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new RouteError(400, 'the body is a JSON object', 'body');
      }
      const b = body as Record<string, unknown>;
      const subject = typeof b.subject === 'string' ? b.subject.trim().slice(0, SUBJECT_MAX) : '';
      if (!subject) {
        throw new RouteError(400, 'subject is required', 'subject');
      }
      const sha = typeof b.sha === 'string' ? b.sha.trim().slice(0, SHA_MAX) : '';
      const branch = typeof b.branch === 'string' ? b.branch.trim().slice(0, BRANCH_MAX) : '';
      const committer = deps.agent.paneid;
      /* Fire-and-forget: the hook's POST must stay fast (its own budget is
         ~2 s) whatever the fan-out to other live sessions costs. */
      void projectNotify
        .notifySharedCommit(slug, committer, { subject, sha, branch }, notifyWiring(deps.log))
        .then((r) => deps.log(`project ${slug}: shared-checkout commit by ${committer}${sha ? ` (${sha.slice(0, 8)})` : ''} — notified ${r.notified}`))
        .catch((e) => deps.log(`project ${slug}: shared-commit notify threw: ${(e as Error).message}`));
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method !== 'POST' && method !== 'DELETE') {
      throw new RouteError(405, 'POST or DELETE');
    }
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new RouteError(400, 'the body is a JSON object', 'body');
    }
    const holder = holderFor(body.from, deps);
    const who = locks.describeHolder(holder);
    if (method === 'POST') {
      let input;
      try {
        input = locks.parseLockBody(body);
      } catch (err) {
        if (err instanceof locks.LockInputError) {
          throw new RouteError(400, err.message, err.field);
        }
        throw err;
      }
      const r = locks.acquire(slug, holder, input);
      if (!r.ok) {
        const by = locks.describeHolder(r.lock.holder);
        deps.log(`project lock ${slug}: REFUSED ${who} (held by ${by})`);
        sendJson(res, 409, { ok: false, error: 'locked', message: `project ${slug} is locked by ${by}`, lock: r.lock });
        return true;
      }
      deps.log(`project lock ${slug}: ${r.renewed ? 'renewed' : 'taken'} by ${who} ttl=${r.lock.ttl_sec}s`);
      /* The granted TTL at the top level, and WHY when it is not what was
         asked for: clamped to the maximum, or the default because none came. */
      const ttl =
        input.clamped_from !== undefined
          ? { ttl_sec: input.ttl_sec, clamped_from: input.clamped_from, message: `ttl ${input.clamped_from} s clamped to the maximum ${locks.TTL_MAX_SEC} s` }
          : input.ttl_default
            ? { ttl_sec: input.ttl_sec, ttl_default: true, message: `no ttl_sec sent: the default ${locks.TTL_DEFAULT_SEC} s (max ${locks.TTL_MAX_SEC} s)` }
            : { ttl_sec: input.ttl_sec };
      sendJson(res, 200, { ok: true, renewed: r.renewed, ...ttl, lock: r.lock });
      return true;
    }
    const r = locks.release(slug, holder);
    if (!r.ok) {
      if (r.status === 404) {
        sendJson(res, 404, { ok: false, error: 'not_locked', message: `project ${slug} holds no lock` });
      } else {
        const by = locks.describeHolder(r.lock!.holder);
        deps.log(`project lock ${slug}: release REFUSED ${who} (held by ${by})`);
        sendJson(res, 403, { ok: false, error: 'not_holder', message: `only ${by} may release it`, lock: r.lock });
      }
      return true;
    }
    deps.log(`project lock ${slug}: released by ${who}`);
    sendJson(res, 200, { ok: true, released: r.lock });
  } catch (err) {
    const e = err as RouteError;
    const status = err instanceof RouteError ? e.status : ((err as { status?: number })?.status ?? 500);
    if (status >= 500) {
      deps.log(`project route ${method} ${route}: ${(err as Error)?.stack ?? String(err)}`);
    }
    sendJson(res, status, { ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) });
  }
  return true;
}

/** Start the mirror refresh timer and the project-notify main-watch sweep
 *  (index.ts, at listen). */
export function start(log: (line: string) => void): void {
  mirror.startTimer();
  projectNotify.start(notifyWiring(log));
}
