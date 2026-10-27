/**
 * PANE TOKENS — an agent's own credential (the design notes §3, S1).
 *
 * The shared bearer names nobody: every agent on the box holds it, so every
 * agent can say it is any pane (O2) and read every room (O1). A pane token is
 * minted for ONE process of ONE pane and presented as `Authorization: Bearer`.
 * The engine resolves it to an `AgentPrincipal` BEFORE the global gate and
 * admits it ONLY on the §4.1 allow-list — it never becomes an
 * `identity.Principal`, never reaches `identity.allowed`, `humanCredential` or
 * `auth.authorized`, because in `both` mode any identity principal opens the
 * whole engine (/launch, /pty).
 *
 * Everything is behind HARBOR_WB_PANE_TOKENS=1. Off (the default) nothing is
 * minted and nothing is resolved: a token string presented anyway is just an
 * unknown bearer, and meets the normal gate.
 *
 * DELIVERY (§3.3) — never in `sessionEnv()` (it feeds the ssh `export` prefix,
 * which is argv), never on argv, never typed (the VRPC prelude is typed into
 * the pane and lands in replay and PowerShell history), never in an MCP config:
 *   file — the pty runs on THIS host: a 0600 file beside the channel configs,
 *          and only its PATH in the pane's env (HARBOR_WB_PANE_TOKEN_FILE).
 *   env  — the pty runs in another host's broker (the VRPC): the token rides
 *          the broker spawn env only (HARBOR_WB_PANE_TOKEN). R7 applies.
 *   none — an ssh pane: nothing until the walk plan's silent-stdin delivery.
 */
import { createHash, randomBytes } from 'node:crypto';
import { isLocalMode } from './local-mode.ts';
import { DEFAULT_PROFILE, isProfile } from './bt-profiles.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { table, type PaneTokenOrigin } from '../table/endpoint.ts';
import { configDir, ptyRunsHere, safePaneFile } from './channels.ts';
import type { Target } from './launch.ts';
import type { CliDescriptor } from './cli-host.ts';

/** ON in local mode and on a HOSTED engine (a hosted seat has no other way to read its room), OFF on the other servers, and the env var wins in BOTH directions: `=1` is on, `=0` is off, anything else (or unset) takes the default. So no
 *  supervisor has to remember to set it for a local engine, and the server behaves as it always did. */
export const enabled = (env: Record<string, string | undefined> = process.env): boolean => {
  if (env.HARBOR_WB_PANE_TOKENS === '1') return true;
  if (env.HARBOR_WB_PANE_TOKENS === '0') return false;
  return isLocalMode(env) || env.HARBOR_WB_HOSTED === '1';
};

/** §4.3: seat-binding verbs are the user's alone, for EVERY seat actor. Its own
 *  flag so it can ship before pane tokens; a pane-token actor gets the rule
 *  whatever this says (rooms.ts). */
export const seatBindHumanOnly = (): boolean => process.env.HARBOR_WB_SEAT_BIND === 'human';

export const TOKEN_ENV = 'HARBOR_WB_PANE_TOKEN';
export const TOKEN_FILE_ENV = 'HARBOR_WB_PANE_TOKEN_FILE';

export interface AgentPrincipal {
  kind: 'pane';
  paneid: string;
  generation: number;
  origin: PaneTokenOrigin;
  mintedAt: number;
  /** the bt tool profile this token was minted with (engine/bt-profiles.ts) */
  profile: string;
}

/** Why a presented pane token did not resolve. `token_invalid` = no such
 *  token at all; the server lets that meet the normal gate (it may be the
 *  shared bearer or an identity api token). */
export type Refusal = 'token_invalid' | 'token_revoked' | 'pane_not_live' | 'generation_mismatch' | 'origin_mismatch';

export type Resolution = { ok: true; principal: AgentPrincipal } | { ok: false; code: Refusal };

export type Delivery = 'file' | 'env' | 'none';

let log: (line: string) => void = () => {};
export function setLogger(fn: (line: string) => void): void {
  log = fn;
}

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/** How a pane on this target gets its token. Mirrors buildLaunch's branches:
 *  broker-resident and plain local panes are not ssh; everything else is. */
export function deliveryFor(t: Target): Delivery {
  const resident = t.broker !== 'local' && !t.sshClient;
  if (!resident && t.kind !== 'local') {
    return 'none';
  }
  /* BY ACCOUNT, NOT BY HOST: when the pane's broker runs as another OS account than the engine (hosted + R7) the engine's 0600 file would be unreadable to the agent, and a shared group would let one person's
     agents read another's tokens, so the token rides the broker spawn env only (readable by that uid and no other). HARBOR_WB_PANE_TOKEN_DELIVERY=env says so. */
  if ((process.env.HARBOR_WB_PANE_TOKEN_DELIVERY ?? '').trim().toLowerCase() === 'env') {
    return 'env';
  }
  return ptyRunsHere(t) ? 'file' : 'env';
}

/** A pane a room could seat (rooms.ts seatability): recipe-backed, and not a
 *  plain shell (a cli-manager pane with no slug). */
export function isSeatable(recipeId: string | null, vendor: string, slug: string | null): boolean {
  return !!recipeId && !(vendor === 'cli-manager' && !slug);
}

export function tokenFileFor(paneid: string): string {
  return join(configDir(), safePaneFile(paneid).replace(/[.]json$/, '.token'));
}

/**
 * Mint the token for (paneid, generation) and record its hash; every earlier
 * token of the pane is superseded in the same transaction. Returns the env
 * the pane's descriptor must carry plus the HASH of this one token (so a
 * failed spawn revokes exactly what it minted — `revokeMinted`), or null
 * (ssh, or the file could not be written — then nothing is left valid).
 */
export function mint(paneid: string, generation: number, delivery: Delivery, opts: { alsoEnv?: boolean; profile?: string } = {}): { env: Record<string, string>; hash: string } | null {
  if (delivery === 'none') {
    return null;
  }
  const token = randomBytes(32).toString('base64url');
  const hash = hashOf(token);
  /* ORIGIN = where the agent CALLS FROM, not how the token was delivered: a pane whose pty runs on this host calls over loopback with no X-Forwarded-For ('local'), even when its token rides the broker env
     because the broker is another OS account (HARBOR_WB_PANE_TOKEN_DELIVERY=env). Only a genuinely remote broker (env delivery by host) is 'remote'. */
  const envByAccount = (process.env.HARBOR_WB_PANE_TOKEN_DELIVERY ?? '').trim().toLowerCase() === 'env';
  const origin: PaneTokenOrigin = delivery === 'file' || envByAccount ? 'local' : 'remote';
  try {
    table.insertPaneToken({ hash, paneid, generation, origin, profile: isProfile(opts.profile) ? opts.profile : DEFAULT_PROFILE });
  } catch (e) {
    // Called from the spawn path inside a WS handler: a throw there is engine-fatal.
    log(`pane token for ${paneid} NOT minted (${(e as Error).message}); launching without one`);
    return null;
  }
  if (delivery === 'env') {
    log(`pane token minted ${paneid} gen ${generation} (remote: broker env)`);
    return { env: { [TOKEN_ENV]: token }, hash };
  }
  const file = tokenFileFor(paneid);
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    rmSync(file, { force: true }); // a fresh file, so the 0600 below applies
    writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    revokeMinted(paneid, hash, 'delivery-failed');
    log(`pane token for ${paneid} NOT delivered (${(e as Error).message}); launching without one`);
    return null;
  }
  log(`pane token minted ${paneid} gen ${generation} (local: ${file}${opts.alsoEnv ? ' + env for codex' : ''})`);
  /* D-E1-1: codex reads its bearer from an ENVIRONMENT variable only, so a local codex pane also carries the token in its env (an env dump would print it; it is
     pane-scoped and dies with the generation). Claude and Gemini never get this. */
  return { env: { [TOKEN_FILE_ENV]: file, ...(opts.alsoEnv ? { [TOKEN_ENV]: token } : {}) }, hash };
}

/**
 * A pane token for a LOGICAL pane: a connector-mode Codex seat (design review [ref]). Its row is a mapping-table session with no PTY, its generation IS the binding
 * generation, and the App service child lives in the HOST, so nothing is written to a file or put in this engine's own spawn env: the token is RETURNED, to be
 * passed to the host in `bind {bt}`, which puts it in the child's environment (D-E1-1: Codex reads its bearer from an env var, accepted on a single-user local
 * PC and NEVER on a shared host). So this returns null on a server. Same table, same hash-only storage, same resolve(): the row must be live and the generation
 * must match, and revoke(paneid, ...) ends it when the generation does. Every earlier token of the pane is superseded in the same transaction.
 */
export function mintHost(paneid: string, generation: number, profile: string = DEFAULT_PROFILE): { token: string; hash: string } | null {
  if (!isLocalMode(process.env)) {
    log(`host pane token for ${paneid} refused: a token in a child's env is local-mode only (D-E1-1)`);
    return null;
  }
  const token = randomBytes(32).toString('base64url');
  const hash = hashOf(token);
  try {
    table.insertPaneToken({ hash, paneid, generation, origin: 'local', profile: isProfile(profile) ? profile : DEFAULT_PROFILE });
  } catch (e) {
    log(`host pane token for ${paneid} NOT minted (${(e as Error).message})`);
    return null;
  }
  log(`pane token minted ${paneid} gen ${generation} (host: passed in bind)`);
  return { token, hash };
}

/** The descriptor with the delivery env layered on. A new object: the
 *  original env is the one buildLaunch may also have spliced into a command
 *  line, and that one must never see the token. */
export function withToken(desc: CliDescriptor, env: Record<string, string>): CliDescriptor {
  return { ...desc, env: { ...(desc.env ?? {}), ...env } };
}

function removeFile(paneid: string): void {
  const file = tokenFileFor(paneid);
  if (existsSync(file)) {
    rmSync(file, { force: true });
  }
}

/** Revoke every live token of the pane and delete its file. Never throws:
 *  it runs in exit handlers. */
export function revoke(paneid: string, why: string): void {
  try {
    if (table.revokePaneTokens(paneid, why) > 0) {
      log(`pane token revoked ${paneid} (${why})`);
    }
    removeFile(paneid);
  } catch (e) {
    log(`pane token revoke for ${paneid} failed: ${(e as Error).message}`);
  }
}

/**
 * Revoke ONE minted token (by its hash) and delete the pane's file only if it
 * still holds that token. The spawn-failure path (security review P2-2): two
 * concurrent spawns of one pane share the file path, and the winner's mint
 * supersedes the loser's — so a loser that revoked the whole pane would strip
 * the WINNER's live token and delete its file. Never throws.
 */
export function revokeMinted(paneid: string, hash: string, why: string): void {
  try {
    if (table.revokePaneToken(hash, why) > 0) {
      log(`pane token revoked ${paneid} (${why}, this spawn's token only)`);
    }
    const file = tokenFileFor(paneid);
    if (existsSync(file) && hashOf(readFileSync(file, 'utf8')) === hash) {
      rmSync(file, { force: true });
    }
  } catch (e) {
    log(`pane token revoke for ${paneid} failed: ${(e as Error).message}`);
  }
}

/** Boot: revoke tokens whose process is gone (store.reconcilePaneTokens). */
export function reconcile(): number {
  const panes = table.reconcilePaneTokens();
  for (const p of panes) {
    try {
      removeFile(p);
    } catch {
      /* a file we cannot remove is a dead credential already */
    }
  }
  return panes.length;
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
}

/**
 * §4.2: token -> hash -> pane_tokens (not revoked) -> row live -> generation
 * -> origin. Null when no bearer was presented at all.
 *
 * ORIGIN IS ADVISORY (§3.4, R8): a `local` token must arrive with no
 * x-forwarded-for, a `remote` one with it. Any loopback process can add or
 * omit the header; this catches misrouting, not an attacker.
 *
 * `checkOrigin: false` is for GET /identity/introspect ONLY (security review
 * P1-B): there the caller is the FABRIC, presenting the pane's token from
 * loopback with no x-forwarded-for, so a VRPC pane's `remote` token would
 * always fail. Revoked / live / generation still apply.
 */
export function resolve(req: IncomingMessage, opts: { checkOrigin?: boolean } = {}): Resolution | null {
  const bearer = bearerOf(req);
  if (!bearer) {
    return null;
  }
  let row: ReturnType<typeof table.paneTokenByHash>;
  let pane: ReturnType<typeof table.get>;
  try {
    row = table.paneTokenByHash(hashOf(bearer));
    pane = row ? table.get(row.paneid) : undefined;
  } catch (e) {
    /* Could not tell. Callers run inside request and upgrade handlers, where
       a throw is engine-fatal; a bearer we cannot check meets the normal gate,
       which refuses anything that is not the shared bearer. */
    log(`pane token lookup failed: ${(e as Error).message}`);
    return { ok: false, code: 'token_invalid' };
  }
  if (!row) {
    return { ok: false, code: 'token_invalid' };
  }
  if (row.revoked_at !== null) {
    return { ok: false, code: 'token_revoked' };
  }
  if (!pane || pane.state !== 'live') {
    return { ok: false, code: 'pane_not_live' };
  }
  if ((pane.generation ?? 0) !== row.generation) {
    return { ok: false, code: 'generation_mismatch' };
  }
  const forwarded = !!req.headers['x-forwarded-for'];
  if (opts.checkOrigin !== false && forwarded !== (row.origin === 'remote')) {
    return { ok: false, code: 'origin_mismatch' };
  }
  return {
    ok: true,
    principal: { kind: 'pane', paneid: row.paneid, generation: row.generation, origin: row.origin, mintedAt: row.minted_at, profile: row.profile ?? DEFAULT_PROFILE },
  };
}

/* ---- per-pane rates: room_post (§4.3) and asset upload (review P2-5) ------ */

export const ROOM_POST_PER_MIN = 20;
/** Asset uploads on a pane token: 10 in any rolling minute. An upload is a
 *  whole file written to agent-share, so the guard is tighter than a post. */
export const ASSET_POST_PER_MIN = 10;
const RATE_WINDOW_MS = 60_000;
type Rate = { ok: true } | { ok: false; retryAfter: number };
const posts = new Map<string, number[]>();
const assetPosts = new Map<string, number[]>();

function take(book: Map<string, number[]>, limit: number, paneid: string, now: number): Rate {
  const recent = (book.get(paneid) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= limit) {
    book.set(paneid, recent);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000)) };
  }
  recent.push(now);
  book.set(paneid, recent);
  return { ok: true };
}

/** Take one room post for this pane, or say when the next one is allowed. A
 *  loop guard, not a budget: 20 in any rolling minute. */
export function takeRoomPost(paneid: string, now = Date.now()): Rate {
  return take(posts, ROOM_POST_PER_MIN, paneid, now);
}

/** Take one asset upload for this pane: 10 in any rolling minute. */
export function takeAssetPost(paneid: string, now = Date.now()): Rate {
  return take(assetPosts, ASSET_POST_PER_MIN, paneid, now);
}

/** Tests only. */
export function resetRates(): void {
  posts.clear();
  assetPosts.clear();
}

/* ---- the pane-token path never takes the engine down (review P2-3) ------- */

/**
 * Run a pane-token handler; ANY throw becomes a 500 `{ok:false,error:
 * 'internal_error'}` instead of an unhandledRejection (the server has no
 * handler for one, so it would kill the engine and every live pane). The raw
 * error is LOGGED, never answered: it can name paths, rows or another pane.
 */
export async function guarded(res: ServerResponse, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log(`pane token ${what}: handler threw: ${(e as Error)?.stack ?? String(e)}`);
    try {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
    } catch {
      /* the socket is already gone */
    }
  }
}

/* ---- the fabric door (§4.1, the engine-proxy half of O6) ----------------- */

/**
 * Why a pane-token `POST /api/fabric/send` is refused, or null. `from` is
 * FORCED to the token's pane by the caller; a body `from` naming any other
 * pane is refused rather than silently overridden, so a confused agent learns
 * it. A `ref` shaped `room:*` or a room's pinned thread is refused: room lines
 * reach the fabric only as the engine's own copies (room-fabric.ts).
 */
export function fabricSendRefusal(
  b: Record<string, unknown>,
  isOwnPane: (from: unknown) => boolean,
  isRoomThread: (thread: string) => boolean,
): { error: string; field: string; message: string; status?: number } | null {
  if (b.from !== undefined && b.from !== null && !isOwnPane(b.from)) {
    return { error: 'from_mismatch', field: 'from', message: 'a pane token sends as its own pane; from names another' };
  }
  if (b.ref !== undefined && b.ref !== null && /^room:/i.test(String(b.ref).trim())) {
    return { error: 'room_ref_refused', field: 'ref', message: 'room lines are posted to the room, not sent on the fabric' };
  }
  /* A non-string thread is refused outright (review P2-1): a NUMBER passed
     straight past the room-thread check, and the fabric would stringify it. */
  if (b.thread !== undefined && b.thread !== null && typeof b.thread !== 'string') {
    return { error: 'thread_invalid', field: 'thread', message: 'thread is a string', status: 400 };
  }
  if (typeof b.thread === 'string' && isRoomThread(String(b.thread).trim())) {
    return { error: 'room_thread_refused', field: 'thread', message: "that is a room's thread; post to the room instead" };
  }
  return null;
}

/** Does a body `from` ({paneid} or {session_id}) name THIS pane? A
 *  session_id must resolve to live rows of this pane only. */
export function isOwnPane(from: unknown, paneid: string): boolean {
  if (!from || typeof from !== 'object' || Array.isArray(from)) {
    return false;
  }
  const f = from as Record<string, unknown>;
  if (typeof f.paneid === 'string' && f.paneid) {
    return f.paneid === paneid;
  }
  if (typeof f.session_id === 'string' && f.session_id) {
    const rows = table.list().filter((r) => r.session_id === f.session_id && r.state === 'live');
    return rows.length > 0 && rows.every((r) => r.paneid === paneid);
  }
  return false;
}
