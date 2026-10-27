/* ============================================================================
 * WORKROOM ROUTES (the design notes §2, wr §2.5-2.7) [ticket].
 *
 * Every /api/rooms* route and GET /api/diag/rooms. Wired from server/index.ts
 * by ONE line, placed AFTER the auth gate and the forced-password-change gate
 * (§2.4, trap 12) — never where identityRoutes.handle() sits. Bearer (or
 * cookie / identity principal) authenticated like every route below the gate,
 * and there is NO loopback exemption: the line delivers content into the
 * user's window, the same reason /api/fabric/inbound is not exempt (trap 14).
 *
 * THE LINE IS PARSED HERE, IN THE ENGINE. POST .../line takes the user's (or a
 * member's) RAW text; `room-commands.parse` decides what it is, and the SAME
 * table verb the HTTP routes call does it. So the typed door and the HTTP door
 * write identical facts by construction (§1.5 "one action path").
 *
 * THE ENGINE NEVER ACCEPTS A CALLER-SUPPLIED AUTHOR (§2.2). No `from` = the
 * user, on a HUMAN credential only (window cookie, no bearer); a bearer with
 * no `from` is 403 field 'from'. `from:{paneid}` / `from:{session_id}` resolves to a LIVE row and then
 * to the seat that row holds in THIS room; anything else is 403 field 'from'
 * and is never downgraded to 'user' — the field approvals cite.
 *
 * DELIVERY IS BY PANEID, NEVER BY SLUG (§2.5). A seat names its occupant by
 * paneid; `fabric.deliver` resolves a slug to "the most recently touched live
 * pane", which misroutes as soon as two seats hold two sessions of one
 * project. `deliverToSeat` hands the paneid straight to `fabric.deliverToPane`.
 * Delivery never spawns: a seat whose occupant is not live gets a `delivery`
 * entry on the line saying so, and the message waits nowhere else.
 * ========================================================================== */

import { terms as searchTerms, snippet as searchSnippet } from '../engine/search-snippet.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname as pathDirname, join as pathJoin } from 'node:path';
import { readBody, sendJson, sendJsonCached, errStatus } from './http-util.ts';
import { basicRoomCommands } from './room-commands.ts';
import { agentCommands, isBasic, typedMarker } from '../engine/agent-commands.ts';
import { parse, leadOnlyAddresses, droppedAddresses, leadingAddress, addressOf, withoutCode, convertUserAlias, chatAddress, namesAnyone, namedInPassing, ROOM_COMMANDS, NOT_IN_BUILD, type ParseResult, type ParseFamily, type SeatRef, type RoomVerb } from './room-commands.ts';
import { table, RoomError, Rollback, LINE_BODY_MAX, LINE_KINDS, normalizeHandle } from '../table/endpoint.ts';
import type { RoomNote, Room, RoomSeat, RoomLineEntry, RoomActor, LineInput, SessionRow, RoomPanel, SeatPolicy } from '../table/endpoint.ts';
import type { Recipe } from '../table/store.ts';
import * as causes from '../engine/causes.ts';
import * as btTools from '../engine/bt-tools.ts';
import * as roomTemplate from '../engine/room-template.ts';
import { rollupOf, seatSignalOf, type Rollup } from '../engine/room-rollup.ts';
import { worktreePath, CODE_VENDORS } from '../engine/worktrees.ts';
import * as fabric from '../engine/fabric.ts';
import * as roomTyper from '../engine/room-typer.ts';
import * as roomBus from '../engine/room-bus.ts';
import * as seatWelcome from '../engine/seat-welcome.ts';
import * as roomGuide from './room-guide.ts';
import * as channels from '../engine/channels.ts';
import * as roomReads from '../engine/room-reads.ts';
import * as roomFabric from '../engine/room-fabric.ts';
import * as roomVoice from '../engine/room-voice.ts';
import * as activity from '../engine/activity.ts';
import * as fabricCheckin from '../engine/fabric-checkin.ts';
import * as chatter from '../engine/chatter.ts';
import { agentComms } from '../engine/agent-comms.ts';
import { driveToReady } from './seat-reload-drive.ts';
import { replyRef, replyOf, withReply, type ReplyRef } from '../engine/room-reply.ts';
import * as connectorBridge from '../engine/connector-bridge.ts';
import { requeueAfterFailedDrive } from '../engine/pane-ready.ts';
import { LINKS_MAX, cleanLabel, linksOf, withLinks, type StoredLink } from '../engine/tool-links.ts';
import { normalizeSlug, projectBasename } from '../engine/agent-slug.ts';
import { prepareSeatWorktree, releaseSeatWorktree, worktreeOfOccupant, familySlug, cleanSeatWorktree } from '../engine/seat-worktree.ts';
import * as spawnPermits from '../engine/spawn-permits.ts';
import { soloPathFor } from './solo-path.ts';
import { isEffortFor, effortsFor, isModelName, resolveLaunchProfile } from '../engine/effort.ts';
import { runtimeFlag } from '../engine/runtime-flags.ts';
import { isResumableVendor } from '../engine/vendors/index.ts';
import { frameUrlFor, proxyFrame, parseFramePath, checkFrameToken, tokenRefused } from './panel-proxy.ts';
import * as share from '../engine/agent-share.ts';
import { Readable } from 'node:stream';
import type { Principal } from '../identity/auth.ts';
import * as identityAuth from '../identity/auth.ts';
import * as identityStore from '../identity/store.ts';
import * as paneTokens from '../engine/pane-tokens.ts';
import { pictureOwner, personOf } from './picture-owner.ts';
import { isToMe, toMeFlags, isHiddenFact } from '../../web/to-me.mjs'; // the To-me rule: ONE module, read by the page too
import { mentionsIn, factIsToMe } from '../../web/fact-mentions.mjs';
import * as scratch from '../engine/room-scratch.ts';
import * as conciergeSignoff from '../engine/concierge-signoff.ts';
import * as scratchIndex from '../engine/scratch-index.ts';
import * as refsMod from '../engine/refs.ts';
import * as notesIndex from '../engine/notes-index.ts';
import { agentBody, assetsPanelUrl, isAssetsPanel, sentNoteRawPath, type SentAttachment } from '../engine/room-attach.ts';
import * as apps from '../engine/apps.ts';
import * as toolManager from '../engine/tool-manager.ts';
import { isBusy as isBusyBackground, type BackgroundWork } from '../engine/bg-detect.ts';
import * as vscreen from '../engine/vscreen.ts';
import { idleRestFrom, validIdleRestPatch, restPlan, restFact, spanWords, mayWake, mayRest, restedFact, offlineNotice, IdleRestError, type IdleRestSettings, type RestSeat, type WakeActor } from '../engine/idle-rest.ts';
import { resolveArt, artRef, validArtKey, RoomArtError, type ResolvedArt } from '../engine/room-art.ts';
import * as replyTurns from '../engine/reply-turns.ts';
import * as memoryBudget from '../engine/memory-budget.ts';
import { cliPromptWords, PromptAnnouncer, shellFactText } from '../engine/cli-prompt.ts';
import { handleTasks, agentMayCall, type TasksCtx } from './tasks-routes.ts';
import { checkCodeFolder, setCodeFolder, codeFolderView, makeProject } from '../engine/code-folder.ts';
import { MemorySource, parseReport } from '../engine/memory-source.ts';
import { isLocalMode } from '../engine/local-mode.ts';
import * as seatRestart from '../engine/seat-restart.ts';
import { filesRoot, parseShareAddress, setStoredBase, shareSource, shareBase as shareBaseNow } from '../engine/agent-share.ts';
import * as conciergeEngine from '../engine/concierge.ts';
import * as switchHost from '../engine/switch/host.ts';
import { PRESETS, presetOfVendor, switchTarget, type SwitchTo } from '../engine/switch/sibling.ts';
import type { Readiness } from '../engine/switch/vendor-ready.ts';
import type { HeldItem, SwitchRow } from '../table/store.ts';
import { engineNode, loadTargets, isSelfHosted } from '../engine/launch.ts';
import { trustFolder, claudeJsonPath, realTrustIo } from '../engine/folder-trust.ts';
import { isFolderTrusted } from './settings-routes.ts';
import { dispositionFor, safeServeType } from './safe-serve.ts';
import { programFor, resolveProgram, vendorDisplayName } from '../engine/vendor-binary.ts';

export interface RoomRouteDeps {
  /** index.ts's projectRow bound to one request's context — the SAME per-row
   *  decoration /api/table serves, so a seat and the manager cannot disagree
   *  about a session (§2.1). Built once per request. */
  projector(): Promise<(row: any) => any>;
  log(line: string): void;
  /** This request carries a HUMAN credential (index.ts humanCredential: a
   *  browser cookie and no Authorization header). Assemble's `from` rule and
   *  its dehydrated-occupant rule read it (assemble-room §4.2, F18). */
  human?: boolean;
  /** index.ts's launchRecipe — POST /api/recipes/:id/launch as a function, so
   *  a seat start IS a recipe launch, never a copy. `onPane` binds the seat
   *  after the pane is decided and before anything is placed; a throw there
   *  aborts the launch. Absent in a caller that cannot launch (then start is
   *  a 500 naming it). */
  launch?(
    recipeId: string,
    body: Record<string, unknown>,
    onPane: (paneid: string) => void,
  ): Promise<{ ok: true; paneid: string; url: string; path: string; placement: string }>;
  /** End one live pane with EndReason 'cycle' (room Disconnect, [ticket]) and
   *  wait for its exit to be filed. `orphan`: a claude still carrying the
   *  paneid / conversation after the exit (NEVER killed), 'none', null = could
   *  not tell, undefined = not checked (the pty runs on another host). */
  endForCycle?(paneid: string): Promise<{ ended: boolean; state: string | null; orphan?: { pid: number; state: string } | 'none' | null }>;
  /** Close every window showing one live pane and KEEP the session (the seat
   *  menu's Close window, Owner 2026-09-28): park it (pinned against the
   *  close-grace reaper, exactly like a tab's close), push pane.close-window to
   *  every attached socket, and ask a native window agent holding it to close.
   *  `browser` = sockets told; `native` = an agent window held it and closed. */
  closeWindow?(paneid: string): Promise<{ browser: number; native: boolean }>;
  /** Set only on the PANE-TOKEN path (handleAgent): the request is this
   *  pane, proven by its own token (briefing-table-mcp §4.1). Never a human. */
  agent?: { paneid: string };
  /** Seat reload (ticket), mirroring fabric-restore.ts's own deps: ws://…/pty
   *  on this engine plus the bearer its gate accepts, so the reload's own
   *  headless launch (no window requested) can attach itself as the viewer
   *  and drive the fresh pane to startup-ready. Absent in a caller that never
   *  reloads a seat (then the route is a 500 naming it). */
  socketUrl?(): string;
  socketToken?(): string;
  /** A prompt only a human answers, by kind, or null (fabric-restore's). */
  needsYou?(paneid: string): string | null;
  /** Past startup: the startup gate is armed for this pane and not blocking. */
  ready?(paneid: string): boolean;
  /** [assistant switch] CONFIRMED stop: true = provably not running (ended, and the broker that held it
   *  answers); false = running; null = could not tell (its host is unreachable). */
  paneStopped?(paneid: string): boolean | null;
  /** [assistant switch] the target vendor's login state, probed in the target pane's own environment. */
  vendorReady?(vendor: string, recipeId: string): Promise<Readiness>;
  /** [assistant switch] the pane's pty (and its transcripts) is on this engine's host. */
  localPane?(paneid: string): boolean;
  /** LOCAL MODE: no desktop window exists to be the viewer that spawns a started seat's pane, and /term is reattach-only, so
   *  the engine spawns the pane itself when a seat is started (through `openSelf`, in-process). Absent = the window spawns it. */
  engineSpawnsOnStart?: boolean;
  /** [assistant switch] an in-process viewer socket for the headless drive (server/self-viewer.ts). */
  openSelf?(): { on(event: string, fn: (...args: any[]) => void): unknown; send(data: string): void; close(): void };
}

/* ---------------------------------------------------------------- state ---- */

const CONFIRM_TTL_MS = 60_000;
/** A held echo's resend window: a turn, not a dialog [chatter p2]. */
const ECHO_CONFIRM_TTL_MS = 10 * 60_000;
const REFUSED_MAX = 50;
const REF_MAX = 1000;

interface PendingConfirm {
  /** 'echo' = a lead's held echo line [chatter p2]; absent = a destructive room command. */
  kind?: 'echo';
  roomId: string;
  /** The text as sent (trimmed): a token confirms THAT command, nothing else. */
  text: string;
  actorKey: string;
  expires: number;
}
/* ENGINE-HELD, in memory, identical on every surface (§2.2): the token is the
   only thing a follow-up needs, so a phone, a page and voice confirm the same
   way. Lost with the process — an unconfirmed destructive command did not
   happen, so there is nothing to recover. */
const confirms = new Map<string, PendingConfirm>();

interface RefusedRecord {
  ts: number;
  roomId: string;
  input: string;
  suggestion: string | null;
}
const refusedCommands: RefusedRecord[] = [];

/* The WS layer (T5) owns room subscriptions; it tells the diag how many
   sockets are subscribed. Until it is wired the honest answer is 0. */
let subscriberCount: () => number = () => 0;
export function setSubscriberCount(fn: () => number): void {
  subscriberCount = fn;
}

function sweepConfirms(): void {
  const now = Date.now();
  for (const [token, c] of confirms) {
    if (c.expires <= now) {
      confirms.delete(token);
    }
  }
}

function noteRefused(roomId: string, input: string, suggestion: string | null): void {
  refusedCommands.push({ ts: Date.now(), roomId, input, suggestion });
  while (refusedCommands.length > REFUSED_MAX) {
    refusedCommands.shift();
  }
}

/** Tests only. */
export function reset(): void {
  confirms.clear();
  refusedCommands.length = 0;
  assembled.clear();
}

/* --------------------------------------------------------------- helpers ---- */

class FieldError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly field: string,
    /** machine-readable extras that ride the answer beside `error` and `field` (a refusal's `code`, ...) */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The status for a failed file-store call: 503 when no store is set up (nothing was tried), 502 when it could not be reached. */
const shareStatus = (e: unknown): number => (e instanceof share.ShareNotConfigured ? 503 : 502);
const PROGRAM_WORDS: Record<string, string> = { 'gemini-cli': 'Gemini CLI', ollama: 'Ollama', 'cli-manager': 'Shell' };
/** A failed file-store call as an answer. A hosted engine with no store says one plain sentence (and the machine code beside it); the person never reads an operator sentence or a variable name. */
export const shareFieldError = (e: unknown): FieldError =>
  e instanceof share.ShareNotConfigured && process.env.HARBOR_WB_HOSTED === '1'
    ? new FieldError(503, "File storage isn't set up on this server yet, so files can't be shared here. Ask whoever runs it.", 'agent-share', { code: 'file-store-missing' })
    : new FieldError(shareStatus(e), `could not reach agent-share: ${(e as Error).message}`, 'agent-share');

/** Run a call that builds a store address; "not set up" answers 503 with its own message instead of an uncaught throw. */
function fileStore<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof share.ShareNotConfigured) {
      throw new FieldError(503, e.message, 'file-store');
    }
    throw e;
  }
}

/* decodeURIComponent THROWS on a malformed escape, and a throw in a request
   handler is engine-fatal (2026-07-07) — a bad id is just an unknown id. */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/* The request body, as a JSON OBJECT, or a 4xx naming field 'body'. readBody
   rejects bad JSON (400) and an oversized body (413) with no field, and it
   happily resolves `null`, a number or an array — each of which used to reach
   a property read and come back as a TypeError dressed as a 400. */
async function readObject(req: IncomingMessage): Promise<Record<string, any>> {
  let b: unknown;
  try {
    b = await readBody(req);
  } catch (e) {
    throw new FieldError(errStatus(e), (e as Error)?.message ?? 'unreadable body', 'body');
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new FieldError(400, 'the body is a JSON object', 'body');
  }
  return b as Record<string, any>;
}

/* A panel action's request came from the room page [ticket]: a JSON body (a
   cross-origin page cannot send one without a preflight nobody answers) and
   no foreign Origin. A present Origin must equal THIS request's own origin —
   scheme, host AND port (URL-normalised, so a default port is the same as
   none). Own origin = the scheme from x-forwarded-proto (Tailscale Serve's
   hop is plain http; the same rule auth.isSecureRequest applies to the
   cookie's Secure flag) + the Host header (Serve preserves the browser's; the
   passkey code reads it the same way). `null` (a sandboxed frame) is refused;
   an absent Origin is a non-browser client, which the cookie rule
   (requireHuman) still gates. */
function sameOriginJson(req: IncomingMessage): boolean {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
    return false;
  }
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  const host = String(req.headers.host ?? '').trim();
  if (!host) {
    return false;
  }
  try {
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' ? 'https' : 'http'; // = auth.isSecureRequest (not imported: auth.ts mints a token at load)
    const own = new URL(`${proto}://${host}`).origin;
    return new URL(origin).origin === own;
  } catch {
    return false; // includes the literal "null"
  }
}

/** Log-safe params: a flat object of short scalars (the route validates them). */
function isPlainParams(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'number' || (typeof x === 'string' && x.length <= 64));
}

/* `expected_sha256` on app register/approve [rooms/apps-sec P2]: optional (the
   UI sends the hash it showed); present, it must be a sha256 hex string. */
function expectedSha(b: Record<string, any>): string | undefined {
  const v = b.expected_sha256;
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) {
    throw new FieldError(400, 'expected_sha256 is a lowercase hex sha256', 'expected_sha256');
  }
  return v;
}

/* A refusal on the pane-token door, as DATA (briefing-table-mcp §2.1):
   {ok:false, error:<code>, message, field?, rooms?} — the same body the MCP
   door will answer, so an agent sees one vocabulary on both. */
class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
  body(): Record<string, unknown> {
    return { ok: false, error: this.code, message: this.message, ...this.extra };
  }
}

function fail(res: ServerResponse, e: unknown): void {
  if (e instanceof AgentError) {
    sendJson(res, e.status, e.body());
    return;
  }
  if (e instanceof FieldError) {
    sendJson(res, e.status, { error: e.message, field: e.field, ...e.extra });
    return;
  }
  if (e instanceof RoomError) {
    sendJson(res, e.status, { error: e.message, field: e.field });
    return;
  }
  /* Anything else is OUR defect, not a bad request: a 400 would tell the
     caller to fix a request that was fine, and a 400 must name a field. */
  sendJson(res, 500, { error: (e as Error)?.message ?? String(e) });
}

function requireRoom(id: string): Room {
  const room = table.getRoom(id);
  if (!room) {
    throw new FieldError(404, 'no such room', 'id');
  }
  return room;
}

function actorKey(actor: RoomActor): string {
  return actor === 'user' ? 'user' : `seat:${actor.seatId}`;
}

function isLive(paneid: string | null | undefined): boolean {
  return !!paneid && table.get(paneid)?.state === 'live';
}

/** A pane named as an occupant must be a LIVE session: binding is all Phase 1
 *  does (no spawn-to-fill, §0.1 Q1), and binding a dead pane is a lie. */
function requireLivePane(paneid: unknown, field = 'occupant'): string {
  if (typeof paneid !== 'string' || !paneid.trim()) {
    throw new FieldError(400, 'an occupant is a paneid', field);
  }
  if (!isLive(paneid)) {
    throw new FieldError(400, `no live session in pane ${paneid}`, field);
  }
  return paneid;
}

/* --------------------------------------------------------- derived seat ---- */

export type SeatStatus = 'live' | 'parked' | 'starting' | 'dehydrated' | 'ended' | 'never-started' | 'empty';

/** What a surface may OFFER on a seat (roster verbs, 2026-09-25). Derived by
 *  the engine so no surface re-implements the policy table (workrooms-build.md
 *  §2.9 has the table). */
export type SeatAction = 'open' | 'rehydrate' | 'start';

/** The paneid names a session of THIS recipe the launch route can address
 *  (its primary `recipe:<id>` or a `recipe:<id>#…` handle). */
function paneOfRecipe(paneid: string | null, recipeId: string | null): boolean {
  return !!paneid && !!recipeId && (paneid === `recipe:${recipeId}` || paneid.startsWith(`recipe:${recipeId}#`));
}

/** The seat actions table (workrooms-build.md §2.9). `recipeId` is the recipe
 *  the seat would launch; `urlable` = an open-able occupant (a url exists). */
function seatActions(
  room: Room | undefined,
  seat: RoomSeat,
  status: SeatStatus,
  row: { state: string; recipe_id: string | null } | undefined,
  urlable: boolean,
): SeatAction[] {
  if (status === 'live' || status === 'parked' || status === 'starting') {
    return urlable ? ['open'] : [];
  }
  if (room && room.state !== 'open') {
    return []; // archive is stasis (wr §2.7b): nothing starts in a box
  }
  if (seat.policy === 'dispatched' || seat.policy === 'pool') {
    return []; // dispatch-to-fill is build item 4 — not built
  }
  if (!seat.recipe_id || !table.getRecipe(seat.recipe_id)) {
    return [];
  }
  if (
    status === 'dehydrated' &&
    seat.policy === 'persistent' &&
    row?.state === 'dehydrated' &&
    paneOfRecipe(seat.occupant, seat.recipe_id)
  ) {
    return ['rehydrate'];
  }
  return ['start'];
}

/**
 * A seat as a GET shows it: the stored row plus DERIVED, never-stored fields
 * (§2.1). `occupant` becomes the occupant's live state object (or null); its
 * id rides inside it as `occupant.id`, because the stored column and the
 * derived object share the name the spec gives both.
 *
 * `task` and `pool` occupants have no state in Phase 1 (no track holds
 * dispatch-task state, §6), so they read like an unfilled seat.
 *
 * ROSTER VERBS (2026-09-25): `actions` (what may be offered), `occupant.url`
 * (the launch route's own solo path) and `occupant.started_at`, plus
 * `occupant.channel` (true / false / null = could not tell) for a live pane —
 * ANY live row, `parked` included: a channel works with no window attached.
 * `starting` = a start is pending: the seat is bound to a pane whose launch
 * minted a spawn permit that no viewer has used yet (no session row, or a
 * dehydrated one not yet restored). The pty only spawns when a viewer
 * attaches, so this is the honest word for that window.
 */
function deriveSeat(seat: RoomSeat, project: (row: any) => any, room?: Room): Record<string, unknown> {
  let status: SeatStatus;
  let occupant: Record<string, unknown> | null = null;
  let vendor: string | null = null;
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const row = paneid ? table.get(paneid) : undefined;
  const pending = !!paneid && (!row || row.state === 'dehydrated') && spawnPermits.pending(paneid);
  const recipeId = row?.recipe_id ?? seat.recipe_id ?? null;
  const url = paneid && recipeId && paneOfRecipe(paneid, recipeId) ? soloPathFor(recipeId, paneid) : null;
  if (row) {
    const p = project(row);
    vendor = p.vendor || 'unknown';
    status =
      row.state === 'live'
        ? p.attached
          ? 'live'
          : 'parked'
        : row.state === 'dehydrated'
          ? pending
            ? 'starting'
            : 'dehydrated'
          : 'ended';
    const live = row.state === 'live';
    /* Typed room lines / fabric envelopes WAITING for this pane (room-typer):
       {reason: 'draft'|'busy'|'startup'|…, since, depth}, so the room can say
       "2 messages held — draft in input" and offer deliver-held. Absent when
       nothing waits. */
    const held = live ? roomTyper.heldFor(row.paneid) : null;
    occupant = {
      id: seat.occupant,
      state: row.state,
      activity: p.activity ?? null,
      attached: !!p.attached,
      /* real windows / tabs only: a room page's own framed view is not one */
      windows: typeof p.windows === 'number' ? p.windows : 0,
      /* room pages' framed views of it (Close window counts them, Owner 2026-10-03) */
      frames: typeof p.frames === 'number' ? p.frames : 0,
      vendor,
      started_at: row.started_at ?? null,
      ...(p.exit !== undefined ? { exit: p.exit } : {}),
      ...(p.title ? { title: p.title } : {}),
      ...(p.model ? { model: p.model } : {}), // [ticket]
      ...(p.effort ? { effort: p.effort } : {}),
      /* the seat's own git worktree {path, branch}, when it runs in one */
      ...(worktreeOfOccupant(row.paneid) ? { worktree: worktreeOfOccupant(row.paneid) } : {}),
      cleared_at: p.cleared_at ?? row.cleared_at ?? null, // /clear'ed in its CLI (Owner 2026-10-03)
      profile: p.profile ?? null, // the stored {model, effort} its next launch runs on
      ...((live || pending) && url ? { url } : {}),
      ...(live ? { channel: channels.channelState(row.paneid) } : {}),
      ...(held ? { held } : {}),
      /* [ticket/1886] NEEDS YOU: the pane's screen shows a prompt only a human
         answers — {reason: login|permission|question, since} (prompt-block).
         Owner watches rooms, not tabs: the seat says so, with why. */
      ...(live && p.blocked ? { blocked: p.blocked } : {}),
      /* A FIRST-RUN CLI PROMPT (the design notes): the drawn prompt, and `waiting_at` = the words only when the screen
         claims one (a name, or an unrecognised dialog held past the deadline). "Cannot tell yet" carries no words and is never "idle". */
      /* E1 ROOM TOOLS: does this pane have the bt tools? room | none | unknown (+ why when it is none or was not planned). Three outcomes, never two. */
      ...(live ? (() => { const t = btTools.state(row.paneid); return { tools: t.tools, ...(t.reason ? { tools_reason: t.reason } : {}) }; })() : {}),
      ...(live && p.cliPrompt !== undefined
        ? { cli_prompt: p.cliPrompt, cli_prompt_reason: p.cliPromptReason ?? null, ...(cliPromptWords(p.cliPrompt, p.cliPromptReason ?? null) ? { waiting_at: cliPromptWords(p.cliPrompt, p.cliPromptReason ?? null) } : {}) }
        : {}),
    };
  } else if (paneid && pending) {
    status = 'starting'; // bound by a start; no viewer has attached yet
  } else if (seat.occupant_kind === 'pane') {
    status = 'ended'; // a pane the table no longer knows: it ran, and it is gone
  } else {
    status = table.listSeatHistory(seat.id).length ? 'empty' : 'never-started';
  }
  if (!vendor) {
    const recipe = seat.recipe_id ? table.getRecipe(seat.recipe_id) : undefined;
    vendor = recipe?.vendor || 'unknown';
  }
  if (!row && status === 'starting') {
    occupant = { id: paneid, state: null, activity: null, attached: false, windows: 0, frames: 0, vendor, started_at: null, ...(url ? { url } : {}) };
  }
  const actions = seatActions(room ?? table.getRoom(seat.room_id), seat, status, row, !!url);
  /* THE SEAT BADGE (Owner 2026-09-28): the room lines to this seat that are
     REALLY waiting — held/queued by the typer, or typed in with the turn not
     started. Lines handed to its fabric channel awaiting evidence are not
     (room-reads waitingFor). `ids` lets the page drop one the moment a
     room.read push moves it, before the next GET. */
  const waitIds = roomReads.waitingFor(seat.room_id, seat.id);
  return { ...seat, status, occupant, vendor, actions, waiting: { count: waitIds.length, ids: waitIds } };
}

type RoomVoiceView = ReturnType<typeof roomVoice.viewOf>;

/** A room's place in its family (Owner 2026-10-04): a workgroup names its main
 *  room (`parent`); a main room lists its workgroups. Names and aliases are all
 *  an agent needs to ADDRESS across the family (`@alias`, `@handle`). */
export interface FamilyView {
  parent: { id: string; name: string; alias: string | null; lead: string | null; color: string | null; has_brief?: boolean; unread?: number } | null;
  /** The family's workgroups (the head room's children, so a workgroup sees its
   *  SIBLINGS too), oldest first. */
  workgroups: Array<{ id: string; name: string; alias: string | null; state: string; lead: string | null; color: string | null; seats: number; has_brief?: boolean; unread?: number; rollup: Rollup }>;
}
/** One live seat's activity signal, straight from the engine's own readings (the same ones the seat row carries); null for a seat with no live pane. */
function seatSignalOfPane(seat: RoomSeat): ReturnType<typeof seatSignalOf> | null {
  const paneid = seat.occupant_kind === 'pane' && seat.occupant ? String(seat.occupant) : null;
  if (!paneid || table.get(paneid)?.state !== 'live') return null;
  const c = vscreen.cliPromptOf(paneid);
  return seatSignalOf({
    activity: activity.get(paneid),
    blocked: !!activity.blockedOf(paneid),
    heldReason: roomTyper.heldFor(paneid)?.reason ?? null,
    cliPrompt: c?.prompt,
    cliPromptReason: c?.reason ?? null,
  });
}
/** The room's (or team's) activity rollup: its loudest live seat and the counts. */
export function rollupForRoom(roomId: string): Rollup {
  return rollupOf(table.listSeats(roomId).map(seatSignalOfPane), conciergeSignoff.pendingByRoom().get(roomId) ?? 0);
}
function leadHandleOf(r: Room): string | null {
  return r.lead_seat ? (table.getSeat(r.lead_seat)?.handle ?? null) : null;
}
function familyView(room: Room): FamilyView {
  const parent = room.parent_id ? table.getRoom(room.parent_id) : undefined;
  return {
    parent: parent ? { id: parent.id, name: parent.name, alias: parent.alias, lead: leadHandleOf(parent), color: parent.color, has_brief: !!parent.brief } : null,
    workgroups: table.listWorkgroups(room.parent_id ?? room.id).map((w) => ({
      id: w.id,
      name: w.name,
      alias: w.alias,
      state: w.state,
      lead: leadHandleOf(w),
      color: w.color,
      seats: table.listSeats(w.id).length,
      rollup: rollupForRoom(w.id),
      has_brief: !!w.brief,
    })),
  };
}

/** One person's unread counts on a room view: the room's own, its parent's and
 *  each workgroup's (the badge, Owner 2026-10-04). */
function withUnread<T extends { family: FamilyView }>(v: T, roomId: string, c: { unread: Record<string, number>; toMe: Record<string, number> }): T & { unread: number; unread_to_me: number } {
  const both = (id: string) => ({ unread: c.unread[id] ?? 0, unread_to_me: c.toMe[id] ?? 0 });
  return {
    ...v,
    ...both(roomId),
    family: {
      parent: v.family.parent ? { ...v.family.parent, ...both(v.family.parent.id) } : null,
      workgroups: v.family.workgroups.map((w) => ({ ...w, ...both(w.id) })),
    },
  };
}

function roomView(
  room: Room,
  project: (row: any) => any,
  userKey = pictureOwner(null).key,
): { room: Room; inherited: string[]; seats: Record<string, unknown>[]; rollup: Rollup; actions: RoomCycleAction[]; panels: PanelView[]; voice: RoomVoiceView; voiceGlobal: { enabled: boolean }; family: FamilyView } {
  const view = agentRoomView(room, project);
  // The live voice connection (room-voice §15), a sibling of panels; room.voice is the SETTINGS.
  // voiceGlobal (v3.6): the viewing person's master switch (a push names nobody: /me's key).
  return { ...view, panels: view.panels.map(panelView), voice: roomVoice.viewOf(room.id), voiceGlobal: { enabled: table.getUserVoice(userKey).enabled } };
}

/** The PANE-TOKEN view (review P2-4): the stored panel rows with NO frameUrl.
 *  Building one MINTS a frame token, a credential that opens the panel's
 *  proxied app, and panels are not an agent's until S4. */
function agentRoomView(
  room: Room,
  project: (row: any) => any,
): { room: Room; inherited: string[]; seats: Record<string, unknown>[]; rollup: Rollup; actions: RoomCycleAction[]; panels: RoomPanel[]; family: FamilyView } {
  const seats = table.listSeats(room.id).map((s) => deriveSeat(s, project, room));
  // Panels (tool-residents §2.6) [ticket], in order: the cells below the seats.
  return { ...designView(room), seats, rollup: rollupForRoom(room.id), actions: roomActions(room, seats), panels: table.listPanels(room.id), family: familyView(room) };
}

/** ROOM CHARACTER [rooms/character]: the room as every surface sees it — the
 *  stored art KEY plus `art_render`, what the page needs to draw it (the art
 *  as authored, its name, the art's own opaque style), or null when the
 *  room has no art or the key names nothing any more (a deleted set). Built
 *  here, not stored, so re-arting a set on the Icons page reaches every room
 *  wearing it — the way a pane's mark follows its key. */
export type RoomWithArt = Room & { art_render: ResolvedArt | null };
function withArt(room: Room): RoomWithArt {
  return { ...room, art_render: resolveArt(room.art, () => table.listLogos()) };
}

/* A WORKGROUP WEARS ITS MAIN ROOM'S DESIGN [workgroup design] Owner 2026-10-05:
   "The workroom should use the parent room's overrides for the room art, etc."
   Each design field that is null on the workgroup takes the main room's value, so
   an override is per field and the workgroup's own non-null value wins. `pal`
   carries `pal_mode` with it (a mode means nothing without its palette).
   NOT inherited: color (the workgroup's identity), name, alias, brief. Resolved
   HERE, once, for every view of a room (detail, list, push, settings answer), so
   the page paints from `room` with no logic of its own. */
const DESIGN_FIELDS = ['art', 'art_tile', 'wash_at', 'bubble_glass', 'pal'] as const;
export function effectiveDesign(room: Room): { room: Room; inherited: string[] } {
  const main = room.parent_id ? table.getRoom(room.parent_id) : undefined;
  if (!main) {
    return { room, inherited: [] };
  }
  const eff: Room = { ...room };
  const inherited: string[] = [];
  /* FOLLOW THE ROOM [wg follow] Owner 2026-10-07 ("set the room and make sure I can have my
     workgroups follow"): every design field is the main room's, set or not; the workgroup's own
     saved values stay stored, unused, until the switch is turned off. Color stays its own. */
  for (const k of DESIGN_FIELDS) {
    if (room.design_follow) {
      (eff as unknown as Record<string, unknown>)[k] = main[k];
      if (k === 'pal') {
        eff.pal_mode = main.pal_mode;
      }
      if (main[k] !== null) {
        inherited.push(k);
        if (k === 'pal') {
          inherited.push('pal_mode');
        }
      }
      continue;
    }
    if (room[k] === null && main[k] !== null) {
      (eff as unknown as Record<string, unknown>)[k] = main[k];
      inherited.push(k);
      if (k === 'pal') {
        eff.pal_mode = main.pal_mode;
        inherited.push('pal_mode');
      }
    }
  }
  /* DEFAULT FEED (Owner 2026-10-05: "the default view should cascade to workgroups"): a workgroup
     with no feed of its own follows the main room's, unless that one names a seat (a seat of the
     main room is not a seat here), in which case the workgroup keeps its own default. */
  const mf = main.feed_default as { who?: string } | null;
  if (room.feed_default === null && mf && ['', 'me', 'agents'].includes(mf.who ?? '')) {
    eff.feed_default = main.feed_default;
    inherited.push('feed_default');
  }
  return { room: eff, inherited };
}
/** `room` as a view (art rendered) plus what it inherited. */
function designView(room: Room): { room: RoomWithArt; inherited: string[] } {
  const e = effectiveDesign(room);
  return { room: withArt(e.room), inherited: e.inherited };
}

/** `?art=ref` on GET /api/rooms and GET /api/rooms/:id [perf/poll-traffic]:
 *  art_render carries {key, name, style, hash} and NOT the SVG, which the page
 *  fetches once per key + hash (GET /api/art/:key?h=<hash>). Opt-in, so every
 *  other reader (the room.state push, the pane-token door, a PATCH answer,
 *  anything external) keeps the SVG exactly as before. The polls opt in: the
 *  art is most of each room view and it changes only on an edit. */
/* A room view's idle_ms is derived from the clock on every read (no page draws
   it; last_active_at is in the same view), so it is left out of the ETag:
   otherwise no room poll could ever be a 304. */
const ROOM_CACHE = { volatile: ['idle_ms'] } as const;
function wantsArtRef(req: IncomingMessage): boolean {
  return new URL(req.url ?? '/', 'http://x').searchParams.get('art') === 'ref';
}
function withArtRef<T extends Record<string, unknown>>(view: T): T {
  const room = view.room as RoomWithArt;
  return { ...view, room: { ...room, art_render: artRef(room.art_render) } } as T;
}

/** A panel as every surface sees it: the stored row plus `frameUrl`, the
 *  engine-proxied path the room page must iframe (NEVER `url`, which resolves
 *  on the viewer's machine and is mixed content over https). */
/** A panel the room may act on: its own, or an app panel on its family head
 *  (a workgroup shows the head's apps) [family apps]. */
function panelInFamily(p: RoomPanel, room: Room): boolean {
  return p.room_id === room.id || (p.app_slug !== null && p.room_id === table.familyHeadId(room.id));
}

export type PanelView = RoomPanel & { frameUrl: string; app_held?: { since: number }; app_status?: apps.AppActions; host_caps?: string[] };
function panelView(p: RoomPanel): PanelView {
  /* an app whose tool.json changed is HELD until a human approves it, or a
     human UNREGISTERED it [ticket]: its view still draws, its ACTIONS are
     blocked. `app_status` is what the room page hands the panel on its action
     port ({host:'app-status'}) and what the rail badge reads [ticket]; this
     projection is the carrier, re-read on every room.state. */
  const reg = p.app_slug ? table.getToolRegistry(p.app_slug) : undefined;
  return {
    ...p,
    frameUrl: frameUrlFor(p.room_id, p.id),
    ...(reg?.held ? { app_held: { since: reg.pinned_at ?? reg.registered_at } } : {}),
    ...(p.app_slug ? { app_status: apps.appActions(reg) } : {}),
    /* host features its panel may ask for (tool.json host_capabilities, the
       PINNED copy) [asset picker]; the room page enforces them on the port */
    ...(p.app_slug && apps.pinnedHostCapabilities(reg).length ? { host_caps: apps.pinnedHostCapabilities(reg) } : {}),
  };
}

/* ---------------------------------------------------- disconnect / reconnect ---- */

export type RoomCycleAction = 'disconnect' | 'reconnect';

/** What a surface may offer on the ROOM (the ✕ / opening it): disconnect while
 *  any seat holds a live pane of a resumable vendor; reconnect while any seat's
 *  occupant is dehydrated. Derived from the seats a GET already shows. */
function roomActions(room: Room, seats: Record<string, unknown>[]): RoomCycleAction[] {
  const out: RoomCycleAction[] = [];
  const occ = (s: Record<string, unknown>) => (s.occupant_kind === 'pane' && typeof s.occupant === 'object' && s.occupant) || null;
  if (seats.some((s) => {
    const o = occ(s) as Record<string, unknown> | null;
    return o?.state === 'live' && isResumableVendor(String(o.vendor ?? ''));
  })) {
    out.push('disconnect');
  }
  if (room.state === 'open' && seats.some((s) => (occ(s) as Record<string, unknown> | null)?.state === 'dehydrated')) {
    out.push('reconnect');
  }
  return out;
}

/** Human credential only (like deliver-held): a person decides a room's
 *  agents leave the broker; an agent's bearer never can. */
function requireHuman(deps: RoomRouteDeps, what: string): void {
  if (!deps.human) {
    throw new FieldError(403, `${what} needs a person: send it from a window (cookie), not a bearer`, 'credential');
  }
}

/**
 * PATCH /api/rooms/:id/seats/:sid/profile {model?, effort?} (toolkit [ref] (2), the
 * Workbench seat menu's "Model & effort…"). The room-scoped form of
 * PATCH /api/sessions/:paneid/profile: the same stored {model, effort}, set for the
 * pane THIS seat holds, so a room client never names a pane. A person only (a bearer
 * is 403) and only for a seat of this room; a seat with no pane has no session to set
 * a profile on (409). Takes effect at the NEXT launch / reconnect: a running claude is
 * not changed, so the seat need not be live. '' or null clears to the CLI's default; an
 * absent key keeps its value. The body is these two keys and nothing else.
 */
async function setSeatProfile(room: Room, seat: RoomSeat, b: Record<string, unknown>, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  requireHuman(deps, "an agent's model and effort");
  for (const k of Object.keys(b)) {
    if (k !== 'model' && k !== 'effort') {
      throw new FieldError(400, 'the body is {model, effort} and nothing else', k);
    }
  }
  if (b.model === undefined && b.effort === undefined) {
    throw new FieldError(400, 'send model and/or effort', 'model');
  }
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const row = paneid ? table.get(paneid) : undefined;
  if (!paneid || !row) {
    throw new FieldError(409, 'this seat has no session to set a profile on', 'seat');
  }
  for (const k of ['model', 'effort'] as const) {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '' && !(k === 'model' ? isModelName(b[k]) : isEffortFor(row.vendor, b[k]))) {
      throw k === 'model'
        ? new FieldError(400, 'model is a model name (letters, digits, . _ -)', 'model')
        : new FieldError(400, `effort is one of ${effortsFor(row.vendor).join(', ')}`, 'effort');
    }
  }
  const recipe = row.recipe_id ? table.getRecipe(row.recipe_id) : undefined;
  const cur = table.profileOf(row) ?? { model: recipe?.model ?? null, effort: recipe?.effort ?? null };
  const pick = (v: unknown, keep: string | null): string | null => (v === undefined ? keep : v === null || v === '' ? null : String(v));
  table.setProfile(paneid, { model: pick(b.model, cur.model), effort: pick(b.effort, cur.effort) });
  const profile = table.profileOf(table.get(paneid));
  deps.log(`profile ${paneid} (seat @${seat.handle}, room ${room.id.slice(0, 8)}): model=${profile?.model ?? 'default'} effort=${profile?.effort ?? 'default'} (applies on its next launch)`);
  return { ok: true, seat: seat.id, handle: seat.handle, profile, effortAllowed: effortsFor(row.vendor) };
}

/**
 * POST /api/rooms/:id/disconnect (assemble-room F1/F2, [ticket]). Ends every
 * seat's LIVE resumable pane with EndReason 'cycle' (filed dehydrated, so the
 * room's reconnect brings each back into the same conversation on the new
 * binary). Everything else — shells, dead rows, the room, seats, line and
 * history — is untouched and reported. Seats end SEQUENTIALLY so each orphan
 * check reads one settled exit.
 */
async function disconnectRoom(room: Room, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  requireHuman(deps, 'disconnecting a room');
  if (!deps.endForCycle) {
    throw new Error('room disconnect: no ender wired');
  }
  const seats: Record<string, unknown>[] = [];
  let ended = 0;
  for (const seat of table.listSeats(room.id)) {
    const r = await disconnectOne(room, seat, deps);
    if (r.result === 'disconnected') {
      ended++;
      markUserDisconnect(seat);
    }
    seats.push(r);
  }
  let entries: RoomLineEntry[] = [];
  if (room.state === 'open' && ended > 0) {
    entries = table.appendLine(room.id, { kind: 'fact', body: `agents disconnected by the user (${ended})` } as any, { actor: 'user' }).result;
  }
  deps.log(`room ${room.id}: disconnect by the user: ${ended} ended (cycle)`);
  return { ok: true, ended, seats, entries };
}

/** One seat's part of a disconnect: end its LIVE resumable pane with
 *  EndReason 'cycle' (filed dehydrated, so a Restore brings the same
 *  conversation back). Anything else is reported untouched. */
async function disconnectOne(room: Room, seat: RoomSeat, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  const base = { seat: seat.id, handle: seat.handle };
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const row = paneid ? table.get(paneid) : undefined;
  if (!paneid || !row) {
    return { ...base, result: 'untouched', reason: 'no-pane' };
  }
  if (row.state !== 'live') {
    return { ...base, paneid, result: 'untouched', reason: `not-live:${row.state}` };
  }
  if (!isResumableVendor(row.vendor)) {
    return { ...base, paneid, result: 'untouched', reason: 'not-resumable' };
  }
  try {
    const r = await deps.endForCycle!(paneid);
    if (r.orphan && typeof r.orphan === 'object') {
      deps.log(`room ${room.id}: @${seat.handle} left an orphan claude pid ${r.orphan.pid} (state ${r.orphan.state}) — NOT killed`);
    }
    return {
      ...base,
      paneid,
      result: r.ended ? 'disconnected' : 'failed',
      state: r.state,
      ...(r.orphan !== undefined ? { orphan: r.orphan } : {}),
    };
  } catch (err) {
    return { ...base, paneid, result: 'failed', error: (err as Error).message };
  }
}

/**
 * POST /api/rooms/:id/seats/:seatId/disconnect (Owner 2026-09-28: disconnect
 * one agent while the others keep working). Human-only, like the room's. The
 * seat, its handle and its conversation stay; its Restore brings it back.
 */
async function disconnectSeat(room: Room, seat: RoomSeat, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  requireHuman(deps, 'disconnecting a seat');
  if (switchHoldOf(seat)) {
    throw new FieldError(409, `@${seat.handle}'s assistant is being switched — cancel the switch instead`, 'seat');
  }
  if (!deps.endForCycle) {
    throw new Error('seat disconnect: no ender wired');
  }
  const r = await disconnectOne(room, seat, deps);
  let entries: RoomLineEntry[] = [];
  if (r.result === 'disconnected') {
    markUserDisconnect(seat);
  }
  if (r.result === 'disconnected' && room.state === 'open') {
    entries = table.appendLine(room.id, { kind: 'fact', body: `@${seat.handle} disconnected by the user` } as any, { actor: 'user' }).result;
  }
  if (r.result === 'untouched') {
    throw new FieldError(409, `@${seat.handle} has nothing to disconnect (${String(r.reason)})`, 'seat');
  }
  deps.log(`room ${room.id}: @${seat.handle} disconnect by the user: ${String(r.result)}`);
  return { ok: r.result === 'disconnected', ...r, entries };
}

/**
 * POST /api/rooms/:id/seats/:seatId/close-window (Owner 2026-09-28: "even
 * within the room I can close the user's window if I want"). Human-only. Not
 * Disconnect and not End: the session keeps running, PARKED in the broker, and
 * every window / tab showing it goes (the same promise a tab's close makes).
 * A room page's own framed view of the seat is not a window: it stays.
 * 404 when the seat has no live occupant: there is no window to close.
 */
async function closeSeatWindow(room: Room, seat: RoomSeat, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  requireHuman(deps, 'closing a seat window');
  if (!deps.closeWindow) {
    throw new Error('seat close-window: no closer wired');
  }
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const row = paneid ? table.get(paneid) : undefined;
  if (!paneid || !row || row.state !== 'live') {
    throw new FieldError(404, `@${seat.handle} has no live session, so no window to close`, 'seat');
  }
  const closed = await deps.closeWindow(paneid);
  deps.log(`room ${room.id}: @${seat.handle} close-window by the user: ${closed.browser} socket(s) told, native ${closed.native}`);
  return { ok: true, seat: seat.id, handle: seat.handle, paneid, closed };
}

/* ---------------------------------------------------------- seat reload ---- */
/*
 * POST /api/rooms/:id/seats/:seatId/reload (ticket, Owner 2026-10-01 ruling).
 * Move a seat's agent onto a FRESH session launched from its recipe's CURRENT
 * defaults (model/effort) — Owner's way to move an agent onto a new model. The
 * STANDARD path is REMOVE + RE-ADD through the room's own existing verbs (the
 * seat menu's Remove, the "+" add/bind path's own table.addSeat) — never a
 * rebind-in-place — so the new seat is created by whatever current code the
 * "+" button runs, with nothing stale carried over. Per room the old pane
 * holds a seat in (the multi-room case):
 *   1. record handle / lead / policy / pool_size (the clicked seat's recipe
 *      drives the one fresh launch — every room binds the SAME new pane)
 *   2. end the old session (EndReason 'cycle' -> dehydrated, resumable) and
 *      close its windows
 *   3. remove the old seat (table.removeSeat; a lead seat's lead is cleared
 *      in the SAME step — allowLeadRemoval — and restored once the new seat
 *      exists, so "no lead" never survives past this one call)
 *   4. launch ONE fresh pane from the recipe (deps.launch, `fresh:true`)
 *   5. add a NEW seat per room (table.addSeat) with the SAME handle/policy,
 *      bound to the fresh pane
 *   6. hand the lead back (table.updateRoom lead_seat) where it was held
 *   7. once the fresh pane is past startup (seat-reload-drive.ts): move the
 *      room-typer held queue onto it, deliver a welcome to each new seat,
 *      write a room fact
 * ROLLBACK (Owner's rule): a failure in step 4 — the only step that is ONE
 * operation shared by every held room — re-adds each removed seat on the OLD
 * (dehydrated, still restorable) pane and restores its lead. A per-room
 * failure in steps 3/5/6 is reported for THAT room only; the others proceed
 * ("the multi-room special path does the same remove + re-add in every room
 * the old pane held a seat in, with a welcome in each").
 * KNOWN LOSS, accepted and reported: app requester evidence (ticket) is
 * keyed on the seat id, so the new seat starts with none.
 * Fabric mail already sent to the old slug bouncing is OUT OF SCOPE here
 * (fabric-side; noted in the report, not fixed by this route).
 */

/** One reload per pane at a time (Owner's rule). Old paneid -> in flight. */
const reloadingPanes = new Set<string>();

interface ReloadSnapshot {
  room: Room;
  oldSeat: RoomSeat;
  handle: string;
  policy: SeatPolicy;
  poolSize: number | null;
  wasLead: boolean;
}
interface ReloadRoomResult {
  roomId: string;
  roomName: string;
  oldSeatId: string;
  handle: string;
  lead: boolean;
  newSeatId?: string;
  result: 'reloaded' | 'added-lead-not-restored' | 'remove-failed' | 'add-failed' | 'rolled-back' | 'rollback-failed';
  error?: string;
}

/** GET .../reload: the seat menu's confirm dialog data. Read-only (no
 *  requireHuman — it changes nothing), any credential that reads the room. */
function reloadPreview(room: Room, seat: RoomSeat): Record<string, unknown> {
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const row = paneid ? table.get(paneid) : undefined;
  const recipe = seat.recipe_id ? table.getRecipe(seat.recipe_id) : undefined;
  const otherRooms = paneid
    ? table
        .roomsForPane(paneid)
        .filter((h) => h.room.id !== room.id && h.room.state === 'open')
        .map((h) => ({ roomId: h.room.id, roomName: h.room.name, seatId: h.seat.id, handle: h.seat.handle }))
    : [];
  return {
    seat: seat.id,
    handle: seat.handle,
    paneid,
    live: isLive(paneid),
    busy: !!paneid && (activity.isBusy(paneid) || activity.get(paneid) === 'streaming'),
    priorSlug: paneid ? (fabricCheckin.identityOf(paneid)?.slug ?? row?.agent ?? null) : null,
    recipe: recipe ? { id: recipe.id, name: recipe.name, model: recipe.model ?? null, effort: recipe.effort ?? null } : null,
    otherRooms,
    /* Owner 2026-10-03: what the Welcome
       choice needs — whether the lead can send it, and the text "Send this as me"
       is prefilled with. */
    welcome: {
      lead: (() => {
        const l = welcomeLeadOf(room, seat.id);
        return l ? { handle: l.handle } : null;
      })(),
      text: recipe ? welcomeTextFor(room, seat, recipe, (paneid ? (fabricCheckin.identityOf(paneid)?.slug ?? row?.agent ?? null) : null) ?? paneid ?? 'its previous session') : '',
    },
  };
}

/** "opus high", "opus default effort", "default model default effort" — never
 *  empty parens; what the welcome and the room fact both quote. */
function modelEffortWords(recipe: { model: string | null; effort?: string | null }): string {
  return `${recipe.model ?? 'default model'} ${recipe.effort ?? 'default effort'}`;
}

/** The welcome a reloaded seat is greeted with (what the "Send this as me" box
 *  is prefilled with). Owner 2026-10-03:
 *  the engine never posts it as him on its own; he picks who sends it. */
function welcomeTextFor(room: Room, seat: RoomSeat, recipe: { name: string; model: string | null; effort?: string | null }, priorRef: string): string {
  const roomName = room.name;
  const handle = seat.handle;
  return (
    `You are @${handle} in ${roomName}, reloaded in a fresh session from the ${recipe.name} defaults` +
    ` (${modelEffortWords(recipe)}). Your previous session was ${priorRef}.` +
    ` Before working, read the room guide, the brief (/brief) and the lines addressed to you.` +
    ` Your previous session's summary went to the lead: ask the lead for your queue and the summary's line id.` +
    ` The handbook topics summaries and safe-handoff describe the procedure. ` +
    /* room welcome, Owner 2026-10-05: where to answer rides the same line, so a reload gets ONE */
    seatWelcome.welcomeAppendix(room, seat)
  );
}

/** The room's lead as a welcome-sender: a live pane in a seat that is not the
 *  one being reloaded. Null = "Lead sends it" is not on offer. */
function welcomeLeadOf(room: Room, reloadedSeatId: string): RoomSeat | null {
  const leadSeat = table.getRoom(room.id)?.lead_seat; // fresh: a reload moves the lead
  if (!leadSeat || leadSeat === reloadedSeatId) return null;
  const lead = table.getSeat(leadSeat);
  return lead && lead.occupant_kind === 'pane' && isLive(lead.occupant) ? lead : null;
}

async function reloadSeat(room: Room, seat: RoomSeat, b: Record<string, any>, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  requireHuman(deps, 'reloading a seat');
  if (!deps.launch || !deps.endForCycle || !deps.closeWindow || !deps.socketUrl || !deps.socketToken || !deps.ready || !deps.needsYou) {
    throw new Error('seat reload: not fully wired');
  }
  if (b.force !== undefined && b.force !== null && typeof b.force !== 'boolean') {
    throw new FieldError(400, 'force is a boolean', 'force');
  }
  if (b.openTab !== undefined && b.openTab !== null && typeof b.openTab !== 'boolean') {
    throw new FieldError(400, 'openTab is a boolean', 'openTab');
  }
  const force = b.force === true;
  const openTab = b.openTab === true;
  /* ANSWER EARLY (Owner 2026-10-06: a phone dropped the request and the card hung; the reload
     itself went through). By default the route answers as soon as the seats are swapped onto
     the new pane; the startup drive, welcome and room fact finish in the background. `wait:
     true` keeps the old answer-at-the-end shape (tests, scripts). */
  if (b.wait !== undefined && b.wait !== null && typeof b.wait !== 'boolean') {
    throw new FieldError(400, 'wait is a boolean', 'wait');
  }
  const waitAll = b.wait === true;
  /* WELCOME (Owner 2026-10-03): the engine
     never speaks as the user on its own. lead = the engine asks the room's lead
     (a fabric notice) to welcome the seat as itself; me = the user's own typed or
     approved text, posted as him; none = nothing. Absent = lead when one can send
     it, else none. */
  const wb = b.welcome;
  if (wb !== undefined && wb !== null && (typeof wb !== 'object' || !['lead', 'me', 'none'].includes((wb as any).mode))) {
    throw new FieldError(400, 'welcome.mode is lead, me or none', 'welcome');
  }
  const welcomeMode: 'lead' | 'me' | 'none' | undefined = wb ? (wb as any).mode : undefined;
  const welcomeText = wb && typeof (wb as any).text === 'string' ? String((wb as any).text).trim() : '';
  if (welcomeMode === 'me' && wb && (wb as any).text !== undefined && typeof (wb as any).text !== 'string') {
    throw new FieldError(400, 'welcome.text is a string', 'welcome');
  }

  const oldPaneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  if (!oldPaneid) {
    throw new FieldError(409, `@${seat.handle} has no occupant to reload`, 'seat');
  }
  if (reloadingPanes.has(oldPaneid)) {
    throw new FieldError(409, `@${seat.handle} is already being reloaded`, 'seat');
  }
  if (table.roomsForPane(oldPaneid).some((h) => table.activeSwitchForRoom(h.room.id))) {
    throw new FieldError(409, `a switch is in progress in @${seat.handle}'s room — wait for it to finish`, 'seat');
  }
  const oldRow = table.get(oldPaneid);
  if (!oldRow || oldRow.state !== 'live') {
    throw new FieldError(409, `@${seat.handle} has no live session to reload`, 'seat');
  }
  if (seat.policy === 'dispatched' || seat.policy === 'pool') {
    throw new FieldError(409, `a ${seat.policy} seat is filled by dispatch, not a session to reload`, 'policy');
  }
  if (!isResumableVendor(oldRow.vendor)) {
    throw new FieldError(409, `@${seat.handle}'s vendor (${oldRow.vendor || 'unknown'}) is not resumable, so it cannot be reloaded`, 'seat');
  }
  const recipe = seat.recipe_id ? table.getRecipe(seat.recipe_id) : undefined;
  if (!recipe) {
    throw new FieldError(409, `@${seat.handle} has no project to reload from`, 'recipe_id');
  }
  const busy = activity.isBusy(oldPaneid) || activity.get(oldPaneid) === 'streaming';
  if (busy && !force) {
    throw new FieldError(409, `@${seat.handle} is mid-turn — tick "reload anyway" to interrupt it`, 'force');
  }

  reloadingPanes.add(oldPaneid);
  let handedOff = false;
  try {
    const holds = table.roomsForPane(oldPaneid).filter((h) => h.room.state === 'open');
    if (!holds.length) {
      throw new FieldError(409, `@${seat.handle}'s seat is not in an open room`, 'seat');
    }
    const snaps: ReloadSnapshot[] = holds.map((h) => ({
      room: h.room,
      oldSeat: h.seat,
      handle: h.seat.handle,
      policy: h.seat.policy,
      poolSize: h.seat.pool_size,
      wasLead: h.seat.is_lead,
    }));
    const priorSlug = fabricCheckin.identityOf(oldPaneid)?.slug ?? oldRow.agent ?? null;
    const held = roomTyper.drainQueue(oldPaneid);

    deps.log(`room ${room.id}: @${seat.handle} reload: ending ${oldPaneid} (cycle) across ${snaps.length} room(s)`);
    try {
      await deps.closeWindow(oldPaneid);
    } catch (e) {
      deps.log(`room ${room.id}: @${seat.handle} reload: close-window failed (continuing): ${(e as Error).message}`);
    }
    const ended = await deps.endForCycle(oldPaneid);
    if (!ended.ended) {
      roomTyper.requeue(oldPaneid, held); // nothing else changed: the queue goes back where it was
      throw new FieldError(409, `@${seat.handle}'s session did not end (state ${ended.state ?? 'unknown'}) — nothing was reloaded`, 'seat');
    }
    deps.log(`room ${room.id}: @${seat.handle} reload: ${oldPaneid} ended, filed ${ended.state}`);

    const results: ReloadRoomResult[] = [];
    const removed: ReloadSnapshot[] = [];
    for (const s of snaps) {
      try {
        table.removeSeat(s.room.id, s.oldSeat.id, { actor: 'user', allowLeadRemoval: s.wasLead });
        removed.push(s);
      } catch (e) {
        results.push({ roomId: s.room.id, roomName: s.room.name, oldSeatId: s.oldSeat.id, handle: s.handle, lead: s.wasLead, result: 'remove-failed', error: (e as Error).message });
        deps.log(`room ${s.room.id}: @${s.handle} reload: remove failed: ${(e as Error).message}`);
      }
    }
    if (!removed.length) {
      roomTyper.requeue(oldPaneid, held); // the old seat(s) are still there, unchanged
      deps.log(`room ${room.id}: @${seat.handle} reload: every room's seat-remove failed — nothing to launch for`);
      return { ok: false, reason: 'remove-failed', oldPaneid, recipe: { id: recipe.id, name: recipe.name }, rooms: results };
    }

    let newPaneid: string | null = null;
    let launchErr: string | null = null;
    try {
      const launchBody: Record<string, unknown> = openTab ? { fresh: true, target: 'tab' } : { fresh: true, target: 'tab', surface: 'browser' };
      const r = await deps.launch(recipe.id, launchBody, () => {});
      newPaneid = r.paneid;
    } catch (e) {
      launchErr = (e as Error).message;
    }

    if (!newPaneid) {
      deps.log(`room ${room.id}: @${seat.handle} reload: launch failed (${launchErr}) — rolling back ${removed.length} room(s) onto ${oldPaneid}`);
      for (const s of removed) {
        try {
          const back = table.addSeat(
            s.room.id,
            { handle: s.handle, policy: s.policy, pool_size: s.poolSize, recipe_id: recipe.id, occupant: oldPaneid, autoLead: false },
            { actor: 'user' },
          );
          if (s.wasLead) {
            table.updateRoom(s.room.id, { lead_seat: back.result.id }, { actor: 'user' });
          }
          results.push({ roomId: s.room.id, roomName: s.room.name, oldSeatId: s.oldSeat.id, handle: s.handle, lead: s.wasLead, newSeatId: back.result.id, result: 'rolled-back' });
        } catch (e) {
          results.push({ roomId: s.room.id, roomName: s.room.name, oldSeatId: s.oldSeat.id, handle: s.handle, lead: s.wasLead, result: 'rollback-failed', error: (e as Error).message });
          deps.log(`room ${s.room.id}: @${s.handle} reload: ROLLBACK FAILED: ${(e as Error).message} — @${s.handle} may be missing from the room${s.wasLead ? ' and the room may have no lead' : ''}`);
        }
      }
      roomTyper.requeue(oldPaneid, held); // the pane the queue belongs to is still oldPaneid
      return { ok: false, reason: 'launch-failed', detail: launchErr, oldPaneid, recipe: { id: recipe.id, name: recipe.name }, rooms: results };
    }
    deps.log(`room ${room.id}: @${seat.handle} reload: launched ${newPaneid} from "${recipe.name}"`);

    const newSeats: Array<{ room: Room; seat: RoomSeat }> = [];
    for (const s of removed) {
      try {
        const added = table.addSeat(
          s.room.id,
          { handle: s.handle, policy: s.policy, pool_size: s.poolSize, recipe_id: recipe.id, occupant: newPaneid, autoLead: false },
          { actor: 'user' },
        );
        let leadOk = true;
        if (s.wasLead) {
          try {
            table.updateRoom(s.room.id, { lead_seat: added.result.id }, { actor: 'user' });
          } catch (e) {
            leadOk = false;
            deps.log(`room ${s.room.id}: @${s.handle} reload: could not restore the lead onto the new seat: ${(e as Error).message}`);
          }
        }
        newSeats.push({ room: s.room, seat: added.result });
        results.push({
          roomId: s.room.id,
          roomName: s.room.name,
          oldSeatId: s.oldSeat.id,
          handle: s.handle,
          lead: s.wasLead,
          newSeatId: added.result.id,
          result: s.wasLead && !leadOk ? 'added-lead-not-restored' : 'reloaded',
        });
      } catch (e) {
        results.push({ roomId: s.room.id, roomName: s.room.name, oldSeatId: s.oldSeat.id, handle: s.handle, lead: s.wasLead, result: 'add-failed', error: (e as Error).message });
        deps.log(`room ${s.room.id}: @${s.handle} reload: re-add onto the new pane failed: ${(e as Error).message} (the old session stays ended; this room has no @${s.handle} until re-seated by hand)`);
      }
    }

    const launched: string = newPaneid;
    const finish = async (): Promise<string> => {
    const newPaneid = launched;
    deps.log(`room ${room.id}: @${seat.handle} reload: waiting for ${newPaneid} to pass startup`);
    let drive: Awaited<ReturnType<typeof driveToReady>>;
    try {
      drive = await driveToReady(newPaneid, recipe.id, {
        socketUrl: deps.socketUrl!,
        socketToken: deps.socketToken!,
        needsYou: deps.needsYou!,
        ready: deps.ready!,
        log: deps.log,
      });
    } catch (e) {
      drive = { ok: false, reason: 'spawn-failed', detail: (e as Error).message };
    }
    let welcome: string;
    if (drive.ok) {
      /* DELIVER THE WELCOME THE QUIET WAY: a fresh session's fabric channel comes up a
         few seconds after its REPL does, and a welcome sent before that is TYPED into
         a composer still painting its first frame, where the Enter can be read as part
         of a paste and the line sits unsent. Wait (bounded) for the channel; typing
         stays the fallback. */
      const waitMs = Number(process.env.HARBOR_WB_RELOAD_CHANNEL_WAIT_MS ?? 25_000);
      for (let waited = 0; channels.enabled() && waited < waitMs && channels.channelState(newPaneid) !== true; waited += 500) {
        await new Promise((r) => setTimeout(r, 500));
      }
      roomTyper.requeue(newPaneid, held);
      const sentTo: string[] = [];
      for (const { room: r, seat: ns } of newSeats) {
        const lead = welcomeLeadOf(r, ns.id);
        const mode = welcomeMode ?? (lead ? 'lead' : 'none');
        /* room welcome [Owner 2026-10-05]: 'me' sends the combined line below; any other
           choice still owes the seat where-to-answer, delivered quietly on its own. */
        if (mode !== 'me') seatWelcome.welcomeSeat(r, ns, deps.log);
        if (mode === 'none') continue;
        const defaultText = welcomeTextFor(r, ns, recipe, priorSlug ?? oldPaneid);
        try {
          if (mode === 'me') {
            /* the user explicitly typed or approved this text: posting it as him is right.
               An edit applies to the room the reload was run from; others get the default. */
            const text = r.id === room.id && welcomeText ? welcomeText : defaultText;
            sendWords(r, { kind: 'chat', body: text, target: ns.handle }, [ns], 'user', deps, { carried: false, envBody: text, named: [ns.id] });
            seatWelcome.markWelcomed(r, ns);
            sentTo.push(`${ns.handle}:me`);
          } else if (lead) {
            const res = await roomFabric.noticeSeat(
              r,
              lead,
              String(lead.occupant),
              `@${ns.handle} was just reloaded from the ${recipe.name} defaults and is waiting in ${r.name}. Please welcome @${ns.handle} in the room as yourself:` +
                ` tell it what to pick up, and to read its previous session summary (tags_contain="session:${priorSlug ?? oldPaneid}") first.`,
            );
            sentTo.push(`${ns.handle}:lead-${res}`);
          }
        } catch (e) {
          deps.log(`room ${r.id}: @${ns.handle} reload: welcome (${mode}) failed: ${(e as Error).message}`);
        }
      }
      welcome = welcomeMode === 'none' ? 'none' : sentTo.length ? 'sent' : 'none';
      deps.log(`room ${room.id}: @${seat.handle} reload: welcome delivered to ${newSeats.length} seat(s); ${held.length} held line(s) moved`);
    } else {
      welcome = drive.reason;
      /* THE HELD LINES MUST NOT BE LOST WITH THE WELCOME: they were drained from the old pane above. A pane that is
         alive but not ready (timeout / waiting on a human) takes them back onto its typer queue, which holds them
         until it can type; only a pane that never spawned or already exited has nowhere to put them. */
      const kept = requeueAfterFailedDrive(drive.reason);
      if (kept) {
        roomTyper.requeue(newPaneid, held);
      }
      deps.log(
        `room ${room.id}: @${seat.handle} reload: ${newPaneid} did not reach startup-ready (${drive.reason}${drive.detail ? `: ${drive.detail}` : ''})` +
          ` — welcome not sent; ${held.length} held line(s) ${kept ? 're-queued on the new pane (delivered when it is ready)' : 'NOT delivered (no live pane to hold them)'}`,
      );
    }

    for (const { room: r, seat: ns } of newSeats) {
      try {
        table.appendLine(
          r.id,
          { kind: 'fact', body: `@${ns.handle} re-added from project defaults (${modelEffortWords(recipe)}); previous session ${priorSlug ?? oldPaneid} (restorable)` } as any,
          { actor: 'user' },
        );
      } catch (e) {
        deps.log(`room ${r.id}: @${ns.handle} reload: room fact write failed: ${(e as Error).message}`);
      }
    }
    return welcome;
    };

    const base = {
      ok: true,
      newPaneid,
      oldPaneid,
      recipe: { id: recipe.id, name: recipe.name },
      rooms: results,
      knownLoss: 'app requester evidence (ticket) is keyed on the seat id and does not carry over to the new seat',
    };
    if (waitAll) {
      return { ...base, welcome: await finish() };
    }
    handedOff = true;
    void finish()
      .catch((e) => deps.log(`room ${room.id}: @${seat.handle} reload: background finish threw: ${(e as Error)?.stack ?? e}`))
      .finally(() => reloadingPanes.delete(oldPaneid));
    return { ...base, welcome: 'pending', pending: true };
  } finally {
    if (!handedOff) reloadingPanes.delete(oldPaneid);
  }
}

/**
 * POST /api/rooms/:id/reconnect. Every seat whose occupant row is dehydrated
 * and whose seat action is 'rehydrate' is restored through startSeat — the
 * SAME path a seat's Restore takes (launchRecipe; the attach runs --resume).
 * SEQUENTIAL on purpose: concurrent spawns into one project are the
 * double-resume hazard (assemble-room F11), and each launch is quick.
 * Optional body {target, surface} is passed to each start as-is.
 */
async function reconnectRoom(room: Room, b: Record<string, any>, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  requireHuman(deps, 'reconnecting a room');
  const project = await deps.projector();
  const seats: Record<string, unknown>[] = [];
  let restoring = 0;
  for (const seat of table.listSeats(room.id)) {
    const base = { seat: seat.id, handle: seat.handle };
    const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
    const row = paneid ? table.get(paneid) : undefined;
    if (row?.state === 'live') {
      seats.push({ ...base, paneid, result: 'already-live' });
      continue;
    }
    if (!row || row.state !== 'dehydrated') {
      seats.push({ ...base, ...(paneid ? { paneid } : {}), result: 'not-restorable', reason: row ? `state:${row.state}` : 'no-pane' });
      continue;
    }
    const derived = deriveSeat(seat, project, room) as { actions?: SeatAction[] };
    if (!derived.actions?.includes('rehydrate')) {
      const reason = room.state !== 'open' ? 'room-archived' : seat.policy !== 'persistent' ? `policy:${seat.policy}` : 'no-rehydrate';
      seats.push({ ...base, paneid, result: 'not-restorable', reason });
      continue;
    }
    try {
      const body: Record<string, unknown> = {};
      if (b.target !== undefined) body.target = b.target;
      if (b.surface !== undefined) body.surface = b.surface;
      const r = await startSeat(room, seat, body, deps);
      restoring++;
      if (r.paneid) {
        void roomFabric.noticeOnReconnect(room, seat, String(r.paneid)); // Owner 2026-09-27: every returning seat takes one turn
      }
      seats.push({ ...base, paneid: r.paneid, result: 'restoring', url: r.url, placement: r.placement });
    } catch (err) {
      const e = err as { message: string; status?: number };
      seats.push({ ...base, paneid, result: 'not-restorable', reason: e.message });
    }
  }
  deps.log(`room ${room.id}: reconnect by the user: ${restoring} restoring`);
  return { ok: true, restoring, seats };
}

/** The `room.state` push body (§2.3, T5): the SAME view GET /api/rooms/:id
 *  serves, so a pushed seat and a fetched seat cannot disagree. Null when the
 *  room does not exist. */
export function roomSnapshot(
  roomId: string,
  project: (row: any) => any,
): { room: Room; inherited: string[]; seats: Record<string, unknown>[]; panels: PanelView[]; voice: RoomVoiceView; family: FamilyView } | null {
  const room = table.getRoom(roomId);
  return room ? roomView(room, project) : null;
}

/* ---------------------------------------------------------- author: from ---- */

/** The live session row a `from` names, or a 400/403 naming the field. */
function fromRow(from: unknown): { paneid: string }[] {
  if (!from || typeof from !== 'object' || Array.isArray(from)) {
    throw new FieldError(400, 'from is {paneid} or {session_id}', 'from');
  }
  const f = from as Record<string, unknown>;
  if (typeof f.paneid === 'string' && f.paneid) {
    const row = table.get(f.paneid);
    if (!row || row.state !== 'live') {
      throw new FieldError(403, 'from: no live session in that pane', 'from');
    }
    return [row];
  }
  if (typeof f.session_id === 'string' && f.session_id) {
    // Correlated as /api/handoff does: the claude session id against the table.
    const rows = table.list().filter((r) => r.session_id === f.session_id && r.state === 'live');
    if (!rows.length) {
      throw new FieldError(403, 'from: no live session with that session_id', 'from');
    }
    return rows;
  }
  throw new FieldError(400, 'from is {paneid} or {session_id}', 'from');
}

/** The refusal for "no `from`, and no person behind the request". */
const NO_SEAT_NAMED = 'from: an agent must say which seat it speaks for';

/**
 * Who is posting to THIS room. A `from` resolves to the seat its live pane
 * occupies here, or it is 403 — NEVER downgraded to 'user' (§2.2). No `from`
 * = the user, but ONLY on a HUMAN credential (a window cookie, no bearer):
 * every agent on the box holds the shared bearer, so "no `from`" alone let
 * any of them speak — and run room commands — as the user (the §0.1 Q5 hole,
 * closed as assemble already closed it). A bearer without `from` is 403
 * field 'from'.
 */
function authorFor(roomId: string, from: unknown, deps: RoomRouteDeps): RoomActor {
  if (from === undefined || from === null) {
    if (!deps.human) {
      throw new FieldError(403, NO_SEAT_NAMED, 'from');
    }
    return 'user';
  }
  const panes = new Set(fromRow(from).map((r) => r.paneid));
  const seats = table.listSeats(roomId).filter((s) => s.occupant_kind === 'pane' && s.occupant && panes.has(s.occupant));
  if (seats.length !== 1) {
    throw new FieldError(403, 'from: that pane holds no seat in this room', 'from');
  }
  return { seatId: seats[0].id };
}

/* COMMAND AUTHORITY (§2.2; W4, Owner 2026-09-24). A room verb from a SEAT is
   allowed only when that seat is the room's CURRENT lead and the verb is one
   the lead holds: handing the lead over, and inviting — `/add` and `/replace`,
   both BIND-ONLY (summon stays out, §0.1 Q1). Everything else (rename, policy,
   mode, remove, archive, reopen) stays the user's: "only the user closes a
   room" (wr §2.4a), and a non-lead member holds no membership verb at all.
   ONE rule for both doors, so the typed door and the HTTP door cannot
   disagree about who may do what. */
const LEAD_VERBS: ReadonlySet<RoomVerb> = new Set<RoomVerb>(['set-lead', 'add', 'replace', 'brief', 'seat-restart', 'seat-restart-all', 'seat-restart-stop']);
const NOT_YOURS = 'room commands come from the user (the lead may hand the lead over, /add, /replace, /brief and /seat restart)';

/* SEAT BINDING IS THE USER'S (briefing-table-mcp §4.3, S1). Binding a live
   pane into a seat, or starting one, makes the engine TYPE into that pane from
   then on — so no seat actor may do it, whatever the credential: a pane token,
   the bearer + `from` (fabric-mcp's pre-allowed room_post included), or the
   typed line. An engine rule on the ACTOR, so it needs neither D1 nor S5.
   Covers /add and /replace that bind a pane, an occupant PATCH that binds,
   POST seats with a recipe_id or occupant, seats/:id/start, and assemble from
   a lead. `/set lead` and emptying a seat are unchanged. Behind
   HARBOR_WB_SEAT_BIND=human for the old doors; always on for a pane token. */
const HUMAN_ONLY = 'human_only: only the user binds a pane to a seat or starts one (send it from a window)';

function seatBindHumanOnly(actor: RoomActor, deps: RoomRouteDeps): boolean {
  return actor !== 'user' && (!!deps.agent || paneTokens.seatBindHumanOnly());
}

function requireSeatBinder(actor: RoomActor, deps: RoomRouteDeps): void {
  if (seatBindHumanOnly(actor, deps)) {
    throw new FieldError(403, HUMAN_ONLY, 'from');
  }
}

/** Null when `actor` may run every verb in `verbs` here, else the refusal. */
function authorityRefusal(room: Room, actor: RoomActor, verbs: RoomVerb[]): string | null {
  if (actor === 'user') {
    return null;
  }
  const lead = room.lead_seat === actor.seatId;
  return verbs.every((v) => lead && LEAD_VERBS.has(v)) ? null : NOT_YOURS;
}

/** The HTTP door's author: `from` resolves exactly as on the line (403 field
 *  'from' when it holds no seat here — never downgraded); no `from` = the user
 *  on a human credential only (authorFor). A seat actor must then hold the
 *  authority for every verb the request would run, or it is 403 field 'from'. */
function httpActor(room: Room, from: unknown, verbs: RoomVerb[], deps: RoomRouteDeps): RoomActor {
  const actor = authorFor(room.id, from, deps);
  const refusal = authorityRefusal(room, actor, verbs);
  if (refusal) {
    throw new FieldError(403, refusal, 'from');
  }
  if (actor !== 'user') {
    // The HTTP door writes no command entry, so name the acting seat here.
    deps.log(`room ${room.id}: ${verbs.join('+') || 'patch'} via HTTP by @${table.getSeat(actor.seatId)?.handle ?? '?'} (${actor.seatId})`);
  }
  return actor;
}

/** `from` on POST /api/rooms: a new room has no seats, so the pane's ONE active
 *  seat in any open room becomes created_by (§2.1). */
function creatorFor(from: unknown, deps: RoomRouteDeps): RoomActor {
  if (from === undefined || from === null) {
    if (!deps.human) {
      throw new FieldError(403, NO_SEAT_NAMED, 'from');
    }
    return 'user';
  }
  const held = fromRow(from).flatMap((r) => table.roomsForPane(r.paneid)).filter((h) => h.room.state === 'open');
  if (held.length !== 1) {
    throw new FieldError(
      403,
      held.length ? 'from: that pane holds seats in several rooms — no one seat to record' : 'from: that pane holds no seat in any open room',
      'from',
    );
  }
  return { seatId: held[0].seat.id };
}

/**
 * Who may register / change a room PANEL [ticket]. A panel puts a URL in front
 * of Owner in his own window, so — unlike the line — "no `from`" is NOT enough
 * to act as the user: it takes a HUMAN credential (a window cookie, no bearer).
 * An agent acts only as its seat (`from`), and the store then limits it to the
 * panels hanging off that seat.
 */
function panelActor(room: Room, from: unknown, deps: RoomRouteDeps, what: string): RoomActor {
  if (from === undefined || from === null) {
    requireHuman(deps, `${what} without \`from\``);
    return 'user';
  }
  const actor = authorFor(room.id, from, deps);
  if (actor !== 'user') {
    deps.log(`room ${room.id}: ${what} by @${table.getSeat(actor.seatId)?.handle ?? '?'} (${actor.seatId})`);
  }
  return actor;
}

/* ---------------------------------------------------------- room assets ---- */
/*
 * ROOM ASSETS (room thin app #2, ticket; the design notes §2.7). The
 * bytes live on agent-share (engine/agent-share.ts) in ONE folder per room,
 * `rooms/<slug(name)>-<first 8 of id>`, derived once and stored on the room.
 *
 *   GET  .../assets/folder      {folder, shareUrl}
 *   GET  .../assets             {folder, shareUrl, assets:[…newest first]}
 *   POST .../assets             raw bytes; x-filename (percent-encoded UTF-8);
 *                               content-type; ?from_paneid= | ?from_session_id=
 *   GET  .../assets/raw/<name>  the bytes, for the HOST (lightbox, thumbnail)
 *
 * WHO MAY ADD: a human credential (a window cookie — an agent's bearer alone
 * is 403, the panel rule), or a member of THIS room via `from` (agents add
 * files too). Reading is any credential that reads the room.
 *
 * THE RAW ROUTE IS NOT FOR PANELS, on purpose. A panel's frame token grants
 * GET/HEAD on that ONE panel's frame and nothing else (panel-proxy.ts), and
 * widening it to a second route would be a second place that token has to be
 * checked. An asset APP served as a panel already has a door for bytes: its
 * relative `raw/<name>` goes through the frame proxy to the app, and the app
 * (on the server or the tailnet, where http is not mixed content) fetches the
 * share itself. So this route needs only the normal credential.
 *
 * SAFETY OF THE BYTES. Anything a member uploads is served from the engine's
 * own origin, so the raw route always adds `CSP: sandbox` (an uploaded HTML or
 * SVG opened top-level runs in an opaque origin, never as the room page) and
 * `nosniff`.
 */
export const ASSET_MAX = 25 * 1024 * 1024;

/** The raw request body, capped. Over the cap ANSWERS 413 with both numbers
 *  (drained first so the answer is delivered; cut off only past 10x). */
export function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    const chunks: Buffer[] = [];
    let total = 0;
    let over = Number.isFinite(declared) && declared > ASSET_MAX;
    req.on('data', (d: Buffer) => {
      total += d.length;
      if (total > ASSET_MAX) {
        over = true;
        chunks.length = 0;
        if (total > 10 * ASSET_MAX) {
          req.destroy();
        }
        return;
      }
      if (!over) {
        chunks.push(d);
      }
    });
    req.on('end', () => {
      if (over) {
        const size = Math.max(total, Number.isFinite(declared) ? declared : 0);
        reject(new FieldError(413, `the file is ${size} bytes (max ${ASSET_MAX})`, 'body'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function assetRawPath(roomId: string, name: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/assets/raw/${encodeURIComponent(name)}`;
}

/* ---- SCRATCHPAD SEEN-STATE [scratch seen] (Owner 2026-10-07, UI 5857/5866; the hub
   handoff's Scratchpad: "Assets ● 3 new of 43", "Notes ● 1 new of 6", opening an item
   marks it seen). PER PERSON (pictureOwner key, the room badges' key), a person's
   window only: a bearer gets no `seen` and no counts.
     new = not marked seen by this person AND created after their (person, room)
           baseline (set the first time their counts or lists are read, so an old
           room starts at 0 new). Their own uploads and notes are marked seen at once.
   The assets total is agent-share's listing (what the Assets list shows); notes are
   every non-archived note. ---- */
type ScratchCounts = { assets: { new: number; total: number } | null; notes: { new: number; total: number } };

/** The room's assets as the list shows them (agent-share + the engine's records). */
async function assetItems(room: Room): Promise<{ folder: string; assets: Array<Record<string, any>> }> {
  const folder = table.roomAssetFolder(room.id);
  let files: share.ShareEntry[];
  try {
    files = await share.list(folder);
  } catch (e) {
    // Could not tell: never an empty list, which would read as "no assets".
    throw new FieldError(shareStatus(e), `could not read agent-share: ${(e as Error).message}`, 'agent-share');
  }
  const recs = new Map(table.listAssetRecords(room.id).map((r) => [r.path, r]));
  const assets = files.map((f) => {
    const rec = recs.get(f.path);
    return {
      name: f.name,
      path: f.path,
      url: share.refUrl(f.path),
      raw: assetRawPath(room.id, f.name),
      kind: f.kind,
      size: rec?.size ?? f.size,
      type: rec?.type ?? share.typeOf(f.name),
      addedAt: rec?.added_at ?? Math.round(f.mtime * 1000),
      addedBy: rec?.added_by_handle ?? null,
      /* "Came from" [scratch seen]: the line that brought it in; null for older ones */
      lineId: rec?.line_id ?? null,
    };
  });
  const names = new Set(assets.filter(f => String(f.type).startsWith('image/')).map(f => f.name));
  return { folder, assets: assets.filter(f => !f.name.endsWith('.annotations.svg') || !names.has(f.name.slice(0, -'.annotations.svg'.length))) };
}

/** isNew(id, createdAt) for one person, room and kind. */
function newTest(person: string, roomId: string, kind: 'asset' | 'note'): (id: string, createdAt: number) => boolean {
  const base = table.scratchBaseline(person, roomId);
  const seen = table.scratchSeen(person, roomId, kind);
  return (id, createdAt) => createdAt > base && !seen.has(id);
}

/** This person's counts. Assets null when agent-share cannot be read (never a false 0). */
async function scratchCounts(room: Room, person: string): Promise<ScratchCounts> {
  const noteNew = newTest(person, room.id, 'note');
  const notes = table.scratchNoteItems(room.id);
  let assets: ScratchCounts['assets'] = null;
  try {
    const list = (await assetItems(room)).assets;
    const assetNew = newTest(person, room.id, 'asset');
    assets = { new: list.filter((a) => assetNew(a.path, a.addedAt)).length, total: list.length };
  } catch {
    assets = null;
  }
  return { assets, notes: { new: notes.filter((n) => noteNew(n.id, n.created_at)).length, total: notes.length } };
}

/** Something was added: every window of the room re-reads its own counts. */
function scratchChanged(roomId: string): void {
  roomBus.emit(roomId, { type: 'room.scratchpad', person: null });
}

/** The helpers the Tasks routes need from this file (a cycle if tasks-routes imported them). */
function tasksCtx(deps: RoomRouteDeps): TasksCtx {
  return {
    sendJson,
    readObject,
    err: (status, message, field) => new FieldError(status, message, field),
    seatState: (seat) => seatPaneState(seat),
    askLead: (room, actor, text) => {
      postLineAs(room, actor, text, { leadOnly: true }, deps);
    },
    rateLimited: (message, retryAfter) => new AgentError(429, 'rate_limited', message, { retry_after: retryAfter }),
    takeWrite: (paneid) => paneTokens.takeRoomPost(paneid),
  };
}

/** The index's view of the file store: agent-share's listing per folder (null when it cannot be read: could-not-tell). */
function shareFileIo(): scratchIndex.FileIo {
  return {
    sizes: async (folder) => {
      try {
        return new Map((await share.list(folder)).filter((f) => f.size !== null).map((f) => [f.path, f.size as number]));
      } catch {
        return null;
      }
    },
    locator: (path) => share.refUrl(path),
  };
}

async function handleScratchpad(
  req: IncomingMessage,
  res: ServerResponse,
  room: Room,
  sub: string[],
  principal: Principal | null,
  deps: RoomRouteDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (sub.length === 2 && sub[1] === 'index' && method === 'GET') {
    requireHuman(deps, 'the Scratchpad index');
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const scope = q.get('scope') ?? 'room';
    if (scope !== 'room' && scope !== 'family') {
      throw new FieldError(400, "scope is 'room' or 'family'", 'scope');
    }
    try {
      sendJson(res, 200, await scratchIndex.indexPage(room.id, { scope, limit: q.get('limit') ? Number(q.get('limit')) : undefined, cursor: q.get('cursor') }, shareFileIo()));
    } catch (e) {
      if (e instanceof scratchIndex.IndexError) {
        throw new FieldError(400, e.message, e.field);
      }
      throw e;
    }
    return true;
  }
  if (sub.length === 2 && sub[1] === 'resolve' && method === 'GET') {
    requireHuman(deps, 'resolving a Scratchpad ref');
    const ref = new URL(req.url ?? '/', 'http://x').searchParams.get('ref') ?? '';
    const r = await refsMod.refState(ref, new Set(table.familyRoomIds(room.id)), shareFileIo());
    sendJson(res, r.state === 'found' ? 200 : r.state === 'refused' ? 403 : r.state === 'unknown' ? 503 : 404, r);
    return true;
  }
  if (sub.length === 2 && sub[1] === 'counts' && method === 'GET') {
    requireHuman(deps, 'your Scratchpad counts');
    sendJson(res, 200, await scratchCounts(room, pictureOwner(principal).key));
    return true;
  }
  if (sub.length === 2 && sub[1] === 'seen' && method === 'POST') {
    if (!deps.human) {
      await drain(req);
    }
    requireHuman(deps, 'marking Scratchpad items seen');
    const b = await readObject(req);
    if (b.kind !== 'asset' && b.kind !== 'note') {
      throw new FieldError(400, "kind is 'asset' or 'note'", 'kind');
    }
    const ids = b.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 1000)) {
      throw new FieldError(400, 'ids is a list of 1 to 500 item ids (an asset path or a note id)', 'ids');
    }
    const person = pictureOwner(principal).key;
    const marked = table.markScratchSeen(person, room.id, b.kind, ids as string[]);
    const counts = await scratchCounts(room, person);
    if (marked) {
      roomBus.emit(room.id, { type: 'room.scratchpad', person, counts });
    }
    sendJson(res, 200, { ok: true, marked, counts });
    return true;
  }
  return false;
}

/** A bare asset file name, or a 400. */
function bareName(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes(String.fromCharCode(92))) {
    throw new FieldError(400, 'an asset is named by its bare file name', 'name');
  }
  return name;
}

/* THUMBNAILS [scratch seen] (UI 5870): GET .../assets/thumb/<name>?w=<px>, images only,
   webp, cached on disk beside the table (the instance's data dir). The width is clamped
   to 64..512 and rounded UP to a step, so a page cannot fill the cache with sizes. The
   cache key carries the share's length and last-modified, so a replaced file gets a new
   thumbnail. A non-image answers 404 {icon: <kind>}: the page shows an icon. */
export const THUMB_STEPS = [64, 128, 192, 256, 384, 512];
export function thumbWidth(raw: string | null): number {
  const n = Number(raw);
  const w = Number.isFinite(n) && n > 0 ? Math.min(512, Math.max(64, n)) : 256;
  return THUMB_STEPS.find((x) => x >= w) ?? 512;
}
const THUMB_SOURCE_MAX = 50 * 1024 * 1024;
async function assetThumb(req: IncomingMessage, res: ServerResponse, room: Room, rawName: string): Promise<void> {
  const name = bareName(rawName);
  const type = share.typeOf(name);
  if (!type.startsWith('image/')) {
    sendJson(res, 404, { error: 'not an image: no thumbnail', field: 'name', icon: share.kindOf(name) });
    return;
  }
  const w = thumbWidth(new URL(req.url ?? '/', 'http://x').searchParams.get('w'));
  const ref = `${table.roomAssetFolder(room.id)}/${name}`;
  let head: Response;
  try {
    head = await share.fetchRaw(ref, 'HEAD');
  } catch (e) {
    throw shareFieldError(e);
  }
  if (head.status === 404) {
    throw new FieldError(404, 'no such asset in this room', 'name');
  }
  const key = createHash('sha1').update(`${ref}|${head.headers.get('content-length') ?? ''}|${head.headers.get('last-modified') ?? ''}|${w}`).digest('hex');
  const file = pathJoin(pathDirname(table.path()), 'thumbs', key.slice(0, 2), `${key}.webp`);
  let out: Buffer;
  if (existsSync(file)) {
    out = readFileSync(file);
  } else {
    let up: Response;
    try {
      up = await share.fetchRaw(ref, 'GET');
    } catch (e) {
      throw shareFieldError(e);
    }
    if (!up.ok) {
      throw new FieldError(up.status === 404 ? 404 : 502, up.status === 404 ? 'no such asset in this room' : `agent-share answered ${up.status}`, 'name');
    }
    const src = Buffer.from(await up.arrayBuffer());
    if (src.length > THUMB_SOURCE_MAX) {
      sendJson(res, 413, { error: `the image is over ${THUMB_SOURCE_MAX} bytes: no thumbnail`, field: 'name', icon: 'image' });
      return;
    }
    /* NO ENCODER (sharp is not shipped in the local release) is its own answer, 501: a client may remember "this engine makes no thumbnails"
       and use the full image. One file sharp cannot read stays 415, for that file only. */
    let sharp: typeof import('sharp').default | null = null;
    if (process.env.HARBOR_WB_NO_IMAGE_ENCODER !== '1') {
      try {
        sharp = (await import('sharp')).default;
      } catch {
        sharp = null;
      }
    }
    if (!sharp) {
      sendJson(res, 501, { error: 'this engine makes no thumbnails (no image encoder): use the full image', field: 'name', icon: 'image' });
      return;
    }
    try {
      out = await sharp(src, { limitInputPixels: 100_000_000 }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    } catch (e) {
      sendJson(res, 415, { error: `could not read the image: ${(e as Error).message}`, field: 'name', icon: 'image' });
      return;
    }
    try {
      mkdirSync(pathDirname(file), { recursive: true });
      writeFileSync(file, out);
    } catch {
      /* no cache this time: the thumbnail is still answered */
    }
  }
  res.writeHead(200, { 'content-type': 'image/webp', 'content-length': String(out.length), 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' });
  res.end(out);
}

/** The asset must be in THIS room (a HEAD on its share ref), or a 404. */
async function requireAssetHere(room: Room, name: string): Promise<string> {
  const ref = `${table.roomAssetFolder(room.id)}/${bareName(name)}`;
  let head: Response;
  try {
    head = await share.fetchRaw(ref, 'HEAD');
  } catch (e) {
    throw shareFieldError(e);
  }
  if (head.status === 404) {
    throw new FieldError(404, 'no such asset in this room', 'name');
  }
  return ref;
}

/* RENAME / MOVE / REMOVE [scratch seen] (UI 5870), a person's window only. agent-share
   has no rename and no delete (only POST /api/move): a RENAME copies the bytes under the
   new name and moves the old file aside, a REMOVE moves it into share.REMOVED_DIR
   (recoverable by hand). The record and everyone's seen marks follow the file. */
async function patchAsset(room: Room, name: string, b: Record<string, unknown>, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  if (room.state !== 'open') {
    throw new FieldError(409, 'the room is archived — /reopen it first', 'state');
  }
  const ref = await requireAssetHere(room, name);
  if (typeof b.room === 'string' && b.room !== room.id) {
    const dest = table.getRoom(b.room);
    if (!dest || !table.familyRoomIds(room.id).includes(dest.id)) {
      throw new FieldError(400, 'room is another room of this family (a workgroup or its main room)', 'room');
    }
    if (dest.state !== 'open') {
      throw new FieldError(409, `"${dest.name}" is archived`, 'room');
    }
    const mv = await share.move(ref, table.roomAssetFolder(dest.id));
    if (!mv.ok) {
      throw new FieldError(mv.status, mv.error, 'agent-share');
    }
    const stored = mv.path.slice(mv.path.lastIndexOf('/') + 1);
    table.moveAssetRecord(ref, { path: mv.path, room_id: dest.id, name: stored });
    deps.log(`room ${room.id}: asset ${ref} moved to ${dest.id} as ${mv.path}`);
    scratchChanged(room.id);
    scratchChanged(dest.id);
    return { ok: true, op: 'move', from: ref, path: mv.path, room: dest.id, name: stored };
  }
  if (b.name !== undefined) {
    const next = share.sanitizeName(b.name);
    if (!next) {
      throw new FieldError(400, 'name is a file name (a basename)', 'name');
    }
    if (next === name) {
      return { ok: true, op: 'rename', from: ref, path: ref, name };
    }
    const got = await share.fetchRaw(ref, 'GET').catch((e) => {
      throw shareFieldError(e);
    });
    if (!got.ok) {
      throw new FieldError(502, `agent-share answered ${got.status}`, 'agent-share');
    }
    const bytes = Buffer.from(await got.arrayBuffer());
    const folder = table.roomAssetFolder(room.id);
    const up = await share.upload(folder, next, share.typeOf(next), bytes);
    if (!up.ok) {
      throw new FieldError(up.status, up.error, up.field);
    }
    const aside = await share.move(ref, share.REMOVED_DIR);
    const stored = up.path.slice(up.path.lastIndexOf('/') + 1);
    table.moveAssetRecord(ref, { path: up.path, room_id: room.id, name: stored });
    deps.log(`room ${room.id}: asset ${ref} renamed to ${up.path}${aside.ok ? '' : ` (the old file could not be moved aside: ${aside.error})`}`);
    scratchChanged(room.id);
    return { ok: true, op: 'rename', from: ref, path: up.path, name: stored, ...(aside.ok ? {} : { warning: `the old file is still there: ${aside.error}` }) };
  }
  throw new FieldError(400, 'send {name} to rename or {room} to move', 'body');
}

async function removeAsset(room: Room, name: string, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  const ref = await requireAssetHere(room, name);
  const mv = await share.move(ref, share.REMOVED_DIR);
  if (!mv.ok) {
    throw new FieldError(mv.status, mv.error, 'agent-share');
  }
  table.removeAssetRecord(ref);
  deps.log(`room ${room.id}: asset ${ref} removed (moved to ${mv.path})`);
  scratchChanged(room.id);
  return { ok: true, op: 'remove', from: ref, kept: mv.path };
}

async function handleAssets(
  req: IncomingMessage,
  res: ServerResponse,
  room: Room,
  sub: string[],
  deps: RoomRouteDeps,
  principal: Principal | null = null,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (sub.length === 2 && sub[1] === 'folder' && method === 'GET') {
    const folder = table.roomAssetFolder(room.id);
    sendJson(res, 200, { folder, shareUrl: fileStore(() => share.folderUrl(folder)) });
    return true;
  }
  if (sub.length === 1 && method === 'GET') {
    const { folder, assets } = await assetItems(room);
    /* [scratch seen] a person's window gets `seen` per item; a bearer does not */
    if (deps.human) {
      const isNew = newTest(pictureOwner(principal).key, room.id, 'asset');
      for (const a of assets) {
        a.seen = !isNew(a.path, a.addedAt);
      }
    }
    sendJson(res, 200, { folder, shareUrl: share.folderUrl(folder), assets });
    return true;
  }
  if (sub.length === 1 && method === 'POST') {
    if (room.state !== 'open') {
      throw new FieldError(409, 'the room is archived — /reopen it first', 'state');
    }
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const from = q.get('from_paneid')
      ? { paneid: q.get('from_paneid') }
      : q.get('from_session_id')
        ? { session_id: q.get('from_session_id') }
        : undefined;
    const actor = deps.agent ? agentSeatActor(room, from, deps.agent.paneid) : panelActor(room, from, deps, 'asset upload');
    const rawName = req.headers['x-filename'];
    const name = share.sanitizeName(typeof rawName === 'string' ? safeDecode(rawName) : null);
    if (!name) {
      throw new FieldError(400, 'x-filename names the file (a basename, percent-encoded UTF-8)', 'x-filename');
    }
    /* A pane token's uploads are rate-limited per pane (review P2-5), taken
       BEFORE the body is read: the body is the expensive part. */
    if (deps.agent) {
      const rate = paneTokens.takeAssetPost(deps.agent.paneid);
      if (!rate.ok) {
        throw new AgentError(429, 'rate_limited', `at most ${paneTokens.ASSET_POST_PER_MIN} asset uploads a minute`, { retry_after: rate.retryAfter });
      }
    }
    const bytes = await readRaw(req);
    if (!bytes.length) {
      throw new FieldError(400, 'the body is the file and it is empty', 'body');
    }
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ct) && ct !== 'application/octet-stream' ? ct : share.typeOf(name);
    const folder = table.roomAssetFolder(room.id);
    const up = await share.upload(folder, name, type, bytes);
    if (!up.ok) {
      deps.log(`room ${room.id}: asset upload to ${folder} failed: ${up.error}`);
      throw new FieldError(up.status, up.error, up.field);
    }
    const stored = up.path.slice(up.path.lastIndexOf('/') + 1);
    const url = share.refUrl(up.path);
    /* x-batch: the CLIENT mints one value per drop or paste and sends it on each file of it; 1..64 of [A-Za-z0-9_-] is stored, anything else is ignored (no
       header = the file is its own batch). The engine cannot know a drop spans several POSTs, and a guessed time window is exactly what this avoids. */
    const rawBatch = req.headers['x-batch'];
    const batchId = typeof rawBatch === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rawBatch) ? rawBatch : null;
    const out = table.recordAsset(room.id, { path: up.path, name: stored, size: bytes.length, type, url, batchId }, { actor });
    deps.log(`room ${room.id}: asset ${up.path} (${bytes.length} B) added by ${out.result.added_by_handle}`);
    if (deps.human && actor === 'user') {
      table.markScratchSeen(pictureOwner(principal).key, room.id, 'asset', [up.path]); // your own upload is never new to you
    }
    scratchChanged(room.id);
    sendJson(res, 200, {
      name: stored,
      path: up.path,
      url,
      raw: assetRawPath(room.id, stored),
      size: bytes.length,
      type,
      addedBy: out.result.added_by_handle,
      at: out.result.added_at,
      assetId: out.result.asset_id,
      batchId: out.result.batch_id,
      entries: out.entries,
    });
    return true;
  }
  if (sub.length === 3 && sub[1] === 'thumb' && method === 'GET') {
    await assetThumb(req, res, room, sub[2]);
    return true;
  }
  if (sub.length === 3 && sub[1] === 'item' && (method === 'PATCH' || method === 'DELETE')) {
    if (!deps.human) {
      await drain(req);
    }
    requireHuman(deps, method === 'DELETE' ? 'removing an asset' : 'renaming or moving an asset');
    sendJson(res, 200, method === 'DELETE' ? await removeAsset(room, sub[2], deps) : await patchAsset(room, sub[2], await readObject(req), deps));
    return true;
  }
  if (sub.length === 3 && sub[1] === 'raw' && (method === 'GET' || method === 'HEAD')) {
    const name = sub[2];
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes(String.fromCharCode(92))) {
      throw new FieldError(400, 'an asset is named by its bare file name', 'name');
    }
    const ref = `${table.roomAssetFolder(room.id)}/${name}`;
    let up: Response;
    try {
      up = await share.fetchRaw(ref, method);
    } catch (e) {
      throw shareFieldError(e);
    }
    if (up.status === 404) {
      throw new FieldError(404, 'no such asset in this room', 'name');
    }
    if (!up.ok) {
      throw new FieldError(502, `agent-share answered ${up.status}`, 'agent-share');
    }
    const served = safeServeType(up.headers.get('content-type') ?? share.typeOf(name)); // M5
    const headers: Record<string, string> = {
      'content-type': served.type,
      ...(served.attachment ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}),
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'referrer-policy': 'no-referrer',
    };
    const len = up.headers.get('content-length');
    if (len) {
      headers['content-length'] = len;
    }
    /* The share's own disposition carries the RAW name (latin-1 at best), and
       a non-ASCII byte in a header makes writeHead throw — so keep only its
       inline/attachment choice and name the file ourselves (RFC 5987). */
    const disp = dispositionFor(served, up.headers.get('content-disposition')); // M5: a forced attachment is never overwritten by the share's choice
    headers['content-disposition'] = `${disp}; filename*=UTF-8''${encodeURIComponent(name)}`;
    res.writeHead(200, headers);
    if (method === 'HEAD' || !up.body) {
      res.end();
      return true;
    }
    const body = Readable.fromWeb(up.body as any);
    body.on('error', () => res.destroy());
    res.on('close', () => body.destroy());
    body.pipe(res);
    return true;
  }
  return false;
}

/* ------------------------------------------------ composer attachments ---- */
/*
 * ROOM COMPOSER ATTACHMENTS [ticket] (the design system room-attach-v1). A person's
 * unsent attachments live in THEIR scratchpad for THIS room — per person per
 * room, like the text draft (keyed the same way, pictureOwner) — on the server
 * (engine/room-scratch.ts), never on agent-share, until the message is SENT:
 *
 *   GET    .../scratch          {files:[…in the order added], max:{bytes,count}, assetsPanel}
 *   POST   .../scratch          raw bytes; x-filename (percent-encoded UTF-8); content-type;
 *                               x-upload-key (a ✕ in flight); x-upload-pos (tray order)
 *   GET    .../scratch/<id>     the bytes (the tray's thumbnail after a reload)
 *   PUT    .../scratch/order    {ids:[…]} the new tray order (drag to reorder)
 *   DELETE .../scratch/<id>     remove it (the tile's ✕)
 *   DELETE .../scratch?key=<k>  remove an upload by the key the page sent
 *                               (x-upload-key): a ✕ while it was in flight
 *   POST   .../line  {text, attachments:[id…]}   SEND: move, then the line
 *
 * PRIVATE UNTIL SENT: every one of these takes a person's window credential
 * (requireHuman) — an agent's bearer or pane token can neither list nor read
 * them — and a file is found only within (person, room), so another person's
 * id is simply not there (404). Caps are the room assets' (25 MB a file) plus
 * a count per message; over either ANSWERS 413 with both numbers.
 *
 * THE SEND is all-or-nothing from the person's view: the text is parsed
 * first (a refusal moves nothing), then each file moves to the room's assets
 * (the POST .../assets path's agent-share folder) and only when ALL moved is
 * the line written. A file that moved before a later one failed keeps its ref
 * (moved_path), so the retry does not upload it twice.
 */
type ScratchRow = ReturnType<typeof table.listRoomScratch>[number];

function scratchView(roomId: string, f: ScratchRow): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    type: f.type,
    size: f.size,
    addedAt: f.created_at,
    key: f.upload_key,
    raw: `/api/rooms/${encodeURIComponent(roomId)}/scratch/${f.id}`,
    etag: (() => { const bytes = scratch.read(f.id); return bytes ? scratch.etag(bytes) : null; })(),
    ...(f.companion_of ? { companionOf: f.companion_of } : {}),
  };
}

/** Consume a body we are refusing before reading it, so the refusal is
 *  delivered rather than the socket cut (the over-cap rule). */
function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on('end', () => resolve());
    req.on('error', () => resolve());
    req.resume();
  });
}

/* A tile REMOVED WHILE ITS UPLOAD WAS IN FLIGHT must never come back. The
   page names each upload with a random x-upload-key; DELETE .../scratch?key=
   deletes that upload's row if it landed, and otherwise leaves a TOMBSTONE so
   an upload still on the wire is discarded when it arrives. In memory: a
   tombstone only has to outlive one request. */
const UPLOAD_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const TOMBSTONE_MS = 10 * 60 * 1000;
const TOMBSTONES_MAX = 5000;
const tombstones = new Map<string, number>(); // `${person} ${room} ${key}` -> expiry
function tombKey(person: string, roomId: string, key: string): string {
  return `${person} ${roomId} ${key}`;
}
function tombstoned(person: string, roomId: string, key: string | null): boolean {
  if (!key) {
    return false;
  }
  const exp = tombstones.get(tombKey(person, roomId, key));
  return exp !== undefined && exp > Date.now();
}
function tombstone(person: string, roomId: string, key: string): void {
  const now = Date.now();
  for (const [k, exp] of tombstones) {
    if (exp <= now || tombstones.size >= TOMBSTONES_MAX) {
      tombstones.delete(k);
    } else {
      break; // insertion order = expiry order
    }
  }
  tombstones.set(tombKey(person, roomId, key), now + TOMBSTONE_MS);
}

function hasAssetsPanel(roomId: string): boolean {
  return table.listPanels(roomId).some((p) => isAssetsPanel(p, roomId));
}

/** Put bytes into a person's draft attachments for a room: the file, then its
 *  row (removing the file again if the row is refused). The ONE path a
 *  composer attachment takes, whether uploaded or made from a note. */
function addDraftFile(
  key: string,
  roomId: string,
  f: { name: string; type: string; bytes: Buffer; uploadKey?: string | null; pos?: number | null; companionOf?: string | null },
  max: number,
): ScratchRow {
  const id = scratch.newId();
  scratch.write(id, f.bytes);
  try {
    return table.addRoomScratch({ id, userKey: key, roomId, name: f.name, type: f.type, size: f.bytes.length, uploadKey: f.uploadKey ?? null, pos: f.pos ?? null, companionOf: f.companionOf ?? null }, max);
  } catch (e) {
    scratch.remove(id);
    throw e;
  }
}

/* ------------------------------------------------------------ room notes ---- */
/*
 * ROOM NOTES [ticket]: text documents kept in a ROOM (per room, not per
 * person; created_by is only recorded). Reads (list, search, get) answer any
 * authenticated caller, so an agent can query a note the user referenced; every
 * write, attach and move-draft takes a person's window credential. Text is
 * never logged: counts and ids only.
 *
 *   POST .../notes {text?}                 create
 *   GET  .../notes                         the visible list (D8)
 *   GET  .../notes?q=                      full-text search, archived included
 *   GET  .../notes/<id>                    {id, text, ...}
 *   PUT  .../notes/<id> {text}             autosave (marks dirty; never indexes)
 *   POST .../notes/<id>/close | attach     index now; attach also drafts the file; closing an empty note removes it ({note:null, removed:true})
 *   POST .../notes/<id>/pin {pinned} | /archive {archived}
 *   POST .../notes/move-draft              the caller's draft -> a new note, verified
 *   GET  .../notes/sent/<id>               {id, title, words, createdAt, text}: a note a message carried (any caller)
 *   GET  .../notes/sent/<id>/raw           the same text as text/plain (the page's preview and agents' curl)
 *
 * A note creation or draft move also gives the room an Assets panel when it
 * has none ({assetsPanel:{added}} in the answer); that never fails the note.
 */
const NOTE_ID = /^[a-f0-9]{12}$/;

function noteRow(n: RoomNote): Record<string, unknown> {
  return { id: n.id, createdAt: n.created_at, updatedAt: n.updated_at, pinned: !!n.pinned, archived: !!n.archived, keywords: JSON.parse(n.keywords) as string[] };
}
/** [scratch seen] The first lines of a note, plain (up to 3 non-empty lines, 240 chars). */
export function noteExcerptHead(text: string): string {
  const lines = text.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean).slice(0, 3);
  const flat = lines.join(String.fromCharCode(10));
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}
/** A note's author as the room line names people: their @name. */
function noteAuthor(createdBy: string | null): string | null {
  if (!createdBy) return null;
  return userHandleOf(personOf(createdBy));
}
function noteFull(n: RoomNote): Record<string, unknown> {
  return { ...noteRow(n), text: n.text };
}

/** About 160 characters of the text around the first query word (plain text). */
function noteExcerpt(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    at = low.indexOf(t);
    if (at >= 0) {
      break;
    }
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 60);
  return (start > 0 ? '…' : '') + flat.slice(start, start + 160) + (start + 160 < flat.length ? '…' : '');
}

/** What a tile or an agent line says about a note's text. */
function noteMeta(text: string): { title: string; words: number } {
  return { title: text.replace(/\s+/g, ' ').trim().slice(0, 40), words: text.split(/\s+/).filter(Boolean).length };
}

/** The note as a composer attachment (D5): a snapshot of the text now. IDEMPOTENT
 *  per (person, room draft, note): when the draft already holds this note's
 *  file, its content is REPLACED (same attachment, new snapshot) rather than a
 *  second one added, so an edit made through the chip reaches the message.
 *  `title` and `words` are what the chip shows (people never see the hash name). */
function attachNote(key: string, room: Room, n: RoomNote): Record<string, unknown> {
  const bytes = Buffer.from(n.text, 'utf8');
  if (!bytes.length) {
    throw new FieldError(400, 'the note is empty; there is nothing to attach', 'text');
  }
  const name = `note-${n.id}.txt`;
  const had = table.listRoomScratch(key, room.id).find((f) => f.name === name);
  let row: ScratchRow;
  if (had) {
    scratch.write(had.id, bytes);
    table.setRoomScratchSize(had.id, bytes.length);
    row = { ...had, size: bytes.length };
  } else {
    row = addDraftFile(key, room.id, { name, type: 'text/plain', bytes }, scratch.maxCount());
  }
  const { title, words } = noteMeta(n.text);
  table.setRoomScratchNote(row.id, JSON.stringify({ id: n.id, title, words }));
  return { file: scratchView(room.id, row), name, type: row.type, bytes_length: bytes.length, title, words, replaced: !!had };
}

async function handleNotes(
  req: IncomingMessage,
  res: ServerResponse,
  room: Room,
  sub: string[],
  principal: Principal | null,
  deps: RoomRouteDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const read = method === 'GET' && (sub.length <= 2 || sub[1] === 'sent');
  if (!read && !deps.human) {
    await drain(req);
  }
  if (!read) {
    requireHuman(deps, 'a note');
  }
  const key = pictureOwner(principal).key;
  if (sub[1] === 'sent' && sub.length >= 3 && method === 'GET') {
    const s = NOTE_ID.test(sub[2]) ? table.getSentNote(room.id, sub[2]) : undefined;
    if (!s || (sub.length === 4 && sub[3] !== 'raw') || sub.length > 4) {
      throw new FieldError(404, 'no such sent note in this room', 'note');
    }
    if (sub.length === 3) {
      sendJson(res, 200, { id: s.id, title: s.title, words: s.words, createdAt: s.created_at, text: s.text });
      return true;
    }
    const body = Buffer.from(s.text, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
    return true;
  }
  const found = (id: string): RoomNote => {
    const n = NOTE_ID.test(id) ? table.getRoomNote(room.id, id) : undefined;
    if (!n) {
      throw new FieldError(404, 'no such note in this room', 'note');
    }
    return n;
  };
  if (sub.length === 1) {
    if (method === 'POST') {
      const b = await readObject(req);
      const made = table.createRoomNote(room.id, key, b.text ?? '');
      const n = (made.text.trim() ? notesIndex.indexNote(made.id) : undefined) ?? made; // keywords on save
      table.markScratchSeen(key, room.id, 'note', [n.id]); // [scratch seen] your own note
      scratchChanged(room.id);
      deps.log(`room ${room.id}: note ${n.id} created`);
      sendJson(res, 200, { note: noteFull(n), assetsPanel: panelForNote(room, deps) });
      return true;
    }
    if (method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q');
      if (q !== null) {
        const hits = table.searchRoomNotes(room.id, q).map((n) => ({
          id: n.id, updatedAt: n.updated_at, pinned: !!n.pinned, archived: !!n.archived,
          keywords: JSON.parse(n.keywords) as string[], excerpt: noteExcerpt(n.text, q),
        }));
        sendJson(res, 200, { notes: hits });
        return true;
      }
      /* summary=1 [scratch seen] (UI 5870): + excerpt, author, total; default shape unchanged */
      const summary = new URL(req.url ?? '/', 'http://x').searchParams.get('summary') === '1';
      const visible = table.listRoomNotesVisible(room.id);
      const rows = visible.map((n) => (summary ? { ...noteRow(n), excerpt: noteExcerptHead(n.text), author: noteAuthor(n.created_by ?? null) } : noteRow(n)));
      if (deps.human) {
        const isNew = newTest(key, room.id, 'note'); // [scratch seen]
        for (const r of rows) {
          r.seen = !isNew(String(r.id), Number(r.createdAt));
        }
      }
      sendJson(res, 200, summary ? { notes: rows, total: table.scratchNoteItems(room.id).length } : { notes: rows });
      return true;
    }
    return false;
  }
  if (sub[1] === 'move-draft' && sub.length === 2 && method === 'POST') {
    /* D6: note first, read it back, compare exactly, and only then clear the
       draft and attach. Any failure leaves the draft untouched and says which. */
    await drain(req);
    const draft = table.getRoomDraft(key, room.id);
    if (!draft.text) {
      throw new FieldError(400, 'your draft is empty; there is nothing to move', 'draft');
    }
    let note: RoomNote;
    try {
      note = table.createRoomNote(room.id, key, draft.text);
      table.markScratchSeen(key, room.id, 'note', [note.id]); // [scratch seen] your own note
      scratchChanged(room.id);
    } catch (e) {
      throw stepFailed('create-note', 'saving the note', e);
    }
    const back = table.getRoomNote(room.id, note.id);
    if (!back || back.text !== draft.text) {
      throw new FieldError(500, 'step read-back failed: the saved note does not match your draft; your draft is untouched', 'read-back');
    }
    let attachment: Record<string, unknown>;
    try {
      attachment = attachNote(key, room, table.indexRoomNote(note.id, notesIndex.ranker) ?? back);
    } catch (e) {
      throw stepFailed('attach', 'attaching the note', e);
    }
    try {
      table.setRoomDraft(key, room.id, '', null);
    } catch (e) {
      throw stepFailed('clear-draft', 'clearing your draft', e);
    }
    deps.log(`room ${room.id}: note ${note.id} made from the draft (${draft.text.length} chars)`);
    sendJson(res, 200, { note: noteFull(table.getRoomNote(room.id, note.id)!), attachment, assetsPanel: panelForNote(room, deps) });
    return true;
  }
  const n = found(sub[1]);
  if (sub.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, noteFull(n));
      return true;
    }
    if (method === 'PUT') {
      const b = await readObject(req);
      const out = table.setRoomNoteText(room.id, n.id, b.text);
      /* keywords on EVERY save [scratch seen] (UI 5870), not only on close */
      const idx = notesIndex.indexNote(n.id);
      sendJson(res, 200, { id: n.id, updatedAt: out!.updated_at, keywords: idx ? (JSON.parse(idx.keywords) as string[]) : [] });
      return true;
    }
    return false;
  }
  if (sub.length === 3 && method === 'POST') {
    if (sub[2] === 'close' || sub[2] === 'attach') {
      await drain(req);
      if (sub[2] === 'close') {
        const closed = notesIndex.closeNote(n.id);
        sendJson(res, 200, closed ? { note: noteFull(closed) } : { note: null, removed: true });
        return true;
      }
      const idx = notesIndex.indexNote(n.id) ?? n;
      sendJson(res, 200, { note: noteFull(idx), attachment: attachNote(key, room, idx) });
      return true;
    }
    if (sub[2] === 'pin' || sub[2] === 'archive') {
      const b = await readObject(req);
      const field = sub[2] === 'pin' ? 'pinned' : 'archived';
      if (typeof b[field] !== 'boolean') {
        throw new FieldError(400, `${field} is true or false`, field);
      }
      sendJson(res, 200, { note: noteFull(table.setRoomNoteFlag(room.id, n.id, field, b[field])!) });
      return true;
    }
  }
  return false;
}

/** A person making a note gets the room's Assets panel now, not at the first
 *  send. Never throws: the note is made either way. */
function panelForNote(room: Room, deps: RoomRouteDeps): { added: boolean } {
  try {
    return { added: ensureAssetsPanel(room, deps, 'Assets panel (first note)').added };
  } catch (e) {
    deps.log(`room ${room.id}: Assets panel not added: ${(e as Error).message}`);
    return { added: false };
  }
}

/** A move-draft step that failed: the answer names the step; the draft is as it was (clear-draft: the note is saved). */
function stepFailed(step: string, doing: string, e: unknown): FieldError {
  const status = e instanceof FieldError || e instanceof RoomError ? (e as { status: number }).status : 500;
  const why = (e as Error)?.message ?? 'unknown error';
  const kept = step === 'clear-draft' ? 'the note is saved and attached; your draft was not cleared' : 'your draft is untouched';
  return new FieldError(status, `step ${step} failed while ${doing}: ${why}; ${kept}`, step);
}

const COMPANION_MAX = 256 * 1024;
function companionText(bytes: Buffer): boolean {
  if (!bytes.length || bytes.length > COMPANION_MAX) return false;
  try { return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return false; }
}
async function readCompanionBody(req: IncomingMessage): Promise<Buffer> {
  try {
    const bytes = await readRaw(req);
    if (!companionText(bytes)) throw new FieldError(400, 'companion-invalid', 'body');
    return bytes;
  } catch (error) {
    if (error instanceof FieldError && error.status === 413) throw new FieldError(400, 'companion-invalid', 'body');
    throw error;
  }
}
function removeDraftFile(key: string, roomId: string, file: ScratchRow): void {
  for (const child of table.listRoomScratch(key, roomId).filter(f => f.companion_of === file.id)) {
    table.deleteRoomScratch(child.id); scratch.remove(child.id);
  }
  table.deleteRoomScratch(file.id); scratch.remove(file.id);
}

async function handleScratch(
  req: IncomingMessage,
  res: ServerResponse,
  room: Room,
  sub: string[],
  principal: Principal | null,
  deps: RoomRouteDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (!deps.human) {
    await drain(req);
    if (method === 'PUT' && sub.length === 2 && sub[1] !== 'order') { sendJson(res, 403, { error: 'person_only' }); return true; }
  }
  requireHuman(deps, 'your attachments');
  const key = pictureOwner(principal).key;
  if (sub.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      files: table.listRoomScratch(key, room.id).map((f) => scratchView(room.id, f)),
      max: { bytes: ASSET_MAX, count: scratch.maxCount() },
      assetsPanel: hasAssetsPanel(room.id),
      count: table.countRoomScratch(key, room.id),
    });
    return true;
  }
  if (sub.length === 2 && sub[1] === 'order' && method === 'PUT') {
    /* DRAG TO REORDER (Owner 2026-10-04, room): {ids:[…]} is the tray's new order; what is sent (and
       numbered for the agents) follows listRoomScratch, so this is the whole change. Idempotent. */
    const b = await readObject(req);
    if (!Array.isArray(b.ids) || b.ids.length > scratch.maxCount() * 2 || b.ids.some((i: unknown) => typeof i !== 'string')) {
      throw new FieldError(400, 'ids is the tray order: an array of file ids', 'ids');
    }
    sendJson(res, 200, { order: table.setRoomScratchOrder(key, room.id, b.ids as string[]) });
    return true;
  }
  if (sub.length === 1 && method === 'DELETE') {
    /* the ✕ on a tile whose upload was still in flight: by its upload key */
    const k = new URL(req.url ?? '/', 'http://x').searchParams.get('key');
    if (!k || !UPLOAD_KEY.test(k)) {
      throw new FieldError(400, 'key is the upload key the page sent (x-upload-key)', 'key');
    }
    tombstone(key, room.id, k);
    const f = table.getRoomScratchByUploadKey(key, room.id, k);
    if (f) {
      removeDraftFile(key, room.id, f);
    }
    sendJson(res, 200, { removed: f?.id ?? null, count: table.countRoomScratch(key, room.id) });
    return true;
  }
  if (sub.length === 1 && method === 'POST') {
    if (room.state !== 'open') {
      await drain(req);
      throw new FieldError(409, 'the room is archived — /reopen it first', 'state');
    }
    const rawKey = req.headers['x-upload-key'];
    const uploadKey = typeof rawKey === 'string' && UPLOAD_KEY.test(rawKey) ? rawKey : null;
    /* the tray position (x-upload-pos): several uploads run at once and land in
       completion order, which is not the order the person picked them in */
    const rawPos = Number(req.headers['x-upload-pos']);
    const pos = Number.isFinite(rawPos) && rawPos > 0 ? rawPos : null;
    if (tombstoned(key, room.id, uploadKey)) {
      await drain(req);
      throw new FieldError(409, 'that file was removed while it uploaded', 'x-upload-key');
    }
    const rawName = req.headers['x-filename'];
    const name = share.sanitizeName(typeof rawName === 'string' ? safeDecode(rawName) : null);
    if (!name) {
      await drain(req);
      throw new FieldError(400, 'x-filename names the file (a basename, percent-encoded UTF-8)', 'x-filename');
    }
    const max = scratch.maxCount();
    const n = table.countRoomScratch(key, room.id);
    const rawCompanion = req.headers['x-companion-of'];
    const companionOf = typeof rawCompanion === 'string' ? rawCompanion : null;
    if (companionOf !== null) {
      const parent = table.getRoomScratch(key, room.id, companionOf);
      if (!parent || parent.companion_of || !parent.type.startsWith('image/') || parent.moved_path || name !== `${parent.name}.annotations.svg`) {
        await drain(req); throw new FieldError(400, 'companion-invalid', 'companionOf');
      }
      if (table.listRoomScratch(key, room.id).some(f => f.companion_of === parent.id)) { await drain(req); throw new FieldError(409, 'companion-exists', 'companionOf'); }
    }
    if (!companionOf && n >= max) {
      await drain(req);
      throw new FieldError(413, `the draft holds ${n} files; the limit is ${max} per message`, 'count');
    }
    const bytes = companionOf ? await readCompanionBody(req) : await readRaw(req);
    if (!bytes.length) {
      throw new FieldError(400, 'the body is the file and it is empty', 'body');
    }
    if (tombstoned(key, room.id, uploadKey)) {
      throw new FieldError(409, 'that file was removed while it uploaded', 'x-upload-key'); // removed mid-body
    }
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ct) && ct !== 'application/octet-stream' ? ct : share.typeOf(name);
    if (companionOf && (type !== 'image/svg+xml' || !companionText(bytes))) throw new FieldError(400, 'companion-invalid', 'body');
    const row = addDraftFile(key, room.id, { name, type, bytes, uploadKey, pos, companionOf }, max);
    deps.log(`room ${room.id}: attachment drafted (${bytes.length} B)`); // never the name or the bytes
    sendJson(res, 200, { file: scratchView(room.id, row), count: table.countRoomScratch(key, room.id) });
    return true;
  }
  if (sub.length === 2) {
    const f = table.getRoomScratch(key, room.id, sub[1]);
    if (!f) {
      throw new FieldError(404, method === 'PUT' ? 'not-found' : 'no such file in your draft', 'file');
    }
    if (method === 'DELETE') {
      removeDraftFile(key, room.id, f);
      sendJson(res, 200, { removed: f.id, count: table.countRoomScratch(key, room.id) });
      return true;
    }
    if (method === 'PUT') {
      if (room.state !== 'open') { await drain(req); throw new FieldError(409, 'room-archived', 'state'); }
      if (!f.companion_of) { await drain(req); throw new FieldError(404, 'not-found', 'file'); }
      const tag = req.headers['if-match'];
      if (typeof tag !== 'string' || !/^"[a-f0-9]{64}"$/.test(tag)) { await drain(req); throw new FieldError(428, 'precondition-required', 'file'); }
      const before = scratch.read(f.id);
      if (f.moved_path || !before || scratch.etag(before) !== tag) { await drain(req); throw new FieldError(412, 'changed', 'file'); }
      const bytes = await readCompanionBody(req);
      const fresh = table.getRoomScratch(key, room.id, f.id);
      const parent = fresh?.companion_of ? table.getRoomScratch(key, room.id, fresh.companion_of) : null;
      if (!fresh || !parent || fresh.moved_path || parent.moved_path) throw new FieldError(412, 'changed', 'file');
      if (!scratch.replace(f.id, bytes, tag, () => table.setRoomScratchSize(f.id, bytes.length))) throw new FieldError(412, 'changed', 'file');
      sendJson(res, 200, { file: scratchView(room.id, { ...fresh, size: bytes.length }) });
      return true;
    }
    if (method === 'GET' || method === 'HEAD') {
      const bytes = scratch.read(f.id);
      if (!bytes) {
        table.deleteRoomScratch(f.id); // its file is gone: the row would only lie
        throw new FieldError(404, 'no such file in your draft', 'file');
      }
      const served = safeServeType(f.type); // M5
      res.writeHead(200, {
        'content-type': served.type,
        'content-length': String(bytes.length),
        etag: scratch.etag(bytes),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
        'referrer-policy': 'no-referrer',
        'content-disposition': `${served.attachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      });
      res.end(method === 'HEAD' ? undefined : bytes);
      return true;
    }
  }
  return false;
}

/** The room's Assets panel, registered on the sender's behalf when the first
 *  attachment lands in a room that has none — through panelActor with no
 *  `from`, i.e. the same human-credential rule POST .../panels applies. A
 *  failure is reported, never a reason to roll the send back (the design system). */
function ensureAssetsPanel(room: Room, deps: RoomRouteDeps, why = 'Assets panel (first attachment)'): { id: string; added: boolean } | { added: false; error: string } {
  const have = table.listPanels(room.id).find((p) => isAssetsPanel(p, room.id)); // any seat's, or the user's
  if (have) {
    return { id: have.id, added: false };
  }
  try {
    const actor = panelActor(room, undefined, deps, why);
    const out = table.addPanel(
      room.id,
      { title: 'Assets', url: assetsPanelUrl(room.id), icon: 'assets', scripts: true, uploads: true },
      { actor },
    );
    deps.log(`room ${room.id}: Assets panel added (${why}, ${out.result.id})`);
    return { id: out.result.id, added: true };
  } catch (e) {
    deps.log(`room ${room.id}: Assets panel not added: ${(e as Error).message}`);
    return { added: false, error: (e as Error).message };
  }
}

/** A scratch row made from a note: the line's attachment says so (kind + title + words). */
function noteFields(f: ScratchRow): Pick<SentAttachment, 'kind' | 'title' | 'words'> {
  try {
    const n = f.note ? (JSON.parse(f.note) as { title?: unknown; words?: unknown }) : null;
    return n ? { kind: 'note', title: String(n.title ?? ''), words: Number(n.words) || 0 } : {};
  } catch {
    return {};
  }
}

/** POST .../line with `attachments` (a person's send). */
async function postAttachmentLine(
  room: Room,
  b: Record<string, unknown>,
  principal: Principal | null,
  deps: RoomRouteDeps,
): Promise<LineResponse & { agentText?: string; assetsPanel?: ReturnType<typeof ensureAssetsPanel> }> {
  requireHuman(deps, 'attachments');
  if ((b.from !== undefined && b.from !== null) || (b.tool !== undefined && b.tool !== null)) {
    throw new FieldError(400, "attachments are a person's: send them from your window, with no from", 'from');
  }
  const ids = b.attachments;
  if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string')) {
    throw new FieldError(400, 'attachments is a list of file ids from your draft', 'attachments');
  }
  const uniq = [...new Set(ids as string[])];
  const max = scratch.maxCount();
  if (uniq.length > max) {
    throw new FieldError(413, `the message carries ${uniq.length} files; the limit is ${max} per message`, 'attachments');
  }
  if (b.text !== undefined && b.text !== null && typeof b.text !== 'string') {
    throw new FieldError(400, 'text is a string', 'text');
  }
  const raw = typeof b.text === 'string' ? b.text : '';
  if (raw.length > LINE_BODY_MAX) {
    throw new FieldError(400, `text is over ${LINE_BODY_MAX} characters`, 'text');
  }
  if (room.state !== 'open') {
    throw new FieldError(409, 'the room is archived — /reopen it first', 'state');
  }
  const text = raw.trim();
  const original = replyEntry(room, replyToField(b)); // a reply: 400 before anything moves
  const links = lineLinks(room, b.links); // links too: 400 before anything moves
  const who = pictureOwner(principal);
  const rows = uniq.map((id) => table.getRoomScratch(who.key, room.id, id));
  if (rows.some((r) => !r)) {
    throw new FieldError(409, 'a file is no longer in your draft — reload the room', 'attachments');
  }
  const primaryFiles = rows as ScratchRow[];
  if (primaryFiles.some(f => f.companion_of)) throw new FieldError(400, 'companion-not-an-attachment', 'attachments');
  const companions = table.listRoomScratch(who.key, room.id).filter(f => f.companion_of && uniq.includes(f.companion_of));
  const files = [...primaryFiles, ...companions];

  /* 1. WHERE it goes, decided before anything moves: a refusal moves nothing
     and keeps the draft. Chat only — a /command carries no files. */
  const userHandle = userHandleOf(who);
  const ctx = parseContext(room);
  const seats = ctx.all;
  let to: string | string[] | 'room';
  let parsed: ParseResult | null = null;
  const addrText = original && !text.startsWith('/') ? leadOnlyAddresses(text) : text; // a reply is addressed by its leading @ list only
  const toSeat = replySeat(room, original, addrText, 'user'); // an un-addressed reply goes to the author seat
  if (toSeat) {
    to = [toSeat.id];
  } else if (text) {
    const p = parse(addrText, ctx.seats, { userHandle, family: ctx.family, unaddressedToLead: agentComms().unaddressedToLead });
    parsed = p;
    if (p.type === 'refused') {
      return refusal(room.id, text, p.error, p.suggestion);
    }
    if (p.type !== 'chat') {
      return refusal(room.id, text, 'attachments go with a message, not a command', 'send the command on its own, then the files');
    }
    to = p.to;
  } else if (room.lead_seat) {
    to = room.lead_seat; // attachments only: un-addressed, so the lead
  } else {
    return refusal(room.id, '', 'no lead yet — un-addressed files go to the lead', '@handle a seat in the text, or /set lead @<handle>');
  }

  /* 2. MOVE each file into the room's assets (agent-share). */
  const folder = table.roomAssetFolder(room.id);
  const moved = new Map<string, SentAttachment>();
  for (const f of primaryFiles) {
    if (noteFields(f).kind === 'note') {
      continue; // a note stays in the database: below, after every upload has worked
    }
    let path = f.moved_path;
    if (!path) {
      const bytes = scratch.read(f.id);
      if (!bytes) {
        table.deleteRoomScratch(f.id);
        throw new FieldError(409, `${f.name} is no longer in your draft (its file is gone) — attach it again; nothing was sent`, 'attachments');
      }
      const up = await share.upload(folder, f.name, f.type, bytes);
      if (!up.ok) {
        deps.log(`room ${room.id}: attachment move to ${folder} failed: ${up.error}`);
        throw new FieldError(up.status, `${up.error} — nothing was sent; your files are still in the draft`, 'attachments');
      }
      path = up.path;
      table.setRoomScratchMoved(f.id, path);
    }
    const stored = path.slice(path.lastIndexOf('/') + 1);
    moved.set(f.id, { name: stored, path, url: fileStore(() => share.refUrl(path)), raw: assetRawPath(room.id, stored), type: f.type, size: f.size });
  }
  // A bound companion follows the FINAL stored picture name, not the upload name.
  // It is recorded for the folded Scratchpad index, never a message tile.
  for (const f of companions) {
    const picture = moved.get(f.companion_of!);
    if (!picture?.path) throw new FieldError(409, 'changed', 'attachments');
    const name = `${picture.name}.annotations.svg`;
    let path = f.moved_path;
    if (!path) {
      const bytes = scratch.read(f.id);
      if (!bytes) throw new FieldError(409, 'changed', 'attachments');
      const up = await share.upload(folder, name, 'image/svg+xml', bytes);
      if (!up.ok) throw new FieldError(up.status, 'companion-move-failed', 'attachments');
      path = up.path;
      table.setRoomScratchMoved(f.id, path);
    }
    if (path.slice(path.lastIndexOf('/') + 1) !== name) throw new FieldError(409, 'changed', 'attachments');
    moved.set(f.id, { name, path, url: fileStore(() => share.refUrl(path!)), raw: assetRawPath(room.id, name), type: 'image/svg+xml', size: f.size });
  }
  /* A note is a snapshot row (immutable, read by id), never a file in the
     room's assets: sending one needs no agent-share. Made after the uploads so
     a failed upload leaves none behind; dropped again if the line is refused. */
  const snaps: string[] = [];
  const dropSnaps = (): void => {
    for (const id of snaps) {
      try {
        table.removeSentNote(id);
      } catch {
        /* a leftover snapshot is unreachable (no entry names it) */
      }
    }
  };
  let sent: SentAttachment[];
  try {
    sent = primaryFiles.map((f) => {
      const have = moved.get(f.id);
      if (have) {
        return companions.some((c) => c.companion_of === f.id) ? ({ ...have, annotations: true } as typeof have) : have; // a picture sent with marks says so (the page draws the pencil)
      }
      const bytes = scratch.read(f.id);
      if (!bytes) {
        table.deleteRoomScratch(f.id);
        throw new FieldError(409, `${f.name} is no longer in your draft (its file is gone) — attach it again; nothing was sent`, 'attachments');
      }
      const text = bytes.toString('utf8');
      const m = noteMeta(text);
      const src = /^note-([a-f0-9]{12})\.txt$/.exec(f.name);
      const snap = table.createSentNote(room.id, { noteId: src ? src[1] : null, text, title: m.title, words: m.words, createdBy: who.key });
      snaps.push(snap.id);
      return { kind: 'note', title: m.title, words: m.words, sent_id: snap.id, name: `note-${snap.id}.txt`, type: 'text/plain', size: bytes.length, raw: sentNoteRawPath(room.id, snap.id) };
    });
  } catch (e) {
    dropSnaps();
    throw e;
  }

  /* 3. THE LINE: the person's words (maybe none) + the files in meta, kind
     `attachment` (the line's existing filter kind); agents get the words plus
     one reference line per file. */
  const envBody = agentBody(text, sent, room.id);
  const lead = leadingAddress(text);
  const addr = userAddressed(addrText, parsed, seats, userHandle, toSeat);
  const words: LineInput = {
    kind: 'attachment',
    body: text || null,
    target: addr.target,
    ...(addr.toUser ? { toUser: addr.toUser } : {}),
    ...(addr.noLead ? { noLead: true } : {}),
    meta: {
      attachments: sent,
      ...(original ? { reply: replyRefFor(original, userHandle) } : {}),
      ...(links.length ? { links } : {}),
      ...addr.meta,
    },
  };
  const named = parsed ? namedOf(toSeat, to, parsed) : toSeat ? [toSeat.id] : to === 'room' ? [] : Array.isArray(to) ? to : lead !== null ? [to] : [];
  let out: LineResponse;
  try {
    out = sendWords(room, words, recipientsOf(room.id, to, 'user'), 'user', deps, { carried: false, envBody, named, fabricBody: envBody });
  } catch (e) {
    dropSnaps();
    if (e instanceof RoomError && e.field === 'target') {
      return refusal(room.id, text, e.message, null);
    }
    throw e;
  }
  const entryId = out.entries[0]?.id;
  for (const id of snaps) {
    try {
      if (entryId !== undefined) {
        table.setSentNoteEntry(id, entryId);
      }
    } catch {
      /* the link back to the line is a convenience; the note is already readable */
    }
  }

  /* 4. Sent: record the assets (quietly — the message is their record on the
     line), empty the scratchpad and the text draft, and give a room with no
     Assets panel one. */
  for (const s of [...moved.values()].filter((x) => x.path && x.url)) {
    try {
      table.recordAsset(room.id, { path: s.path!, name: s.name, size: s.size, type: s.type, url: s.url! }, { actor: 'user' }, true, entryId ?? null);
      table.markScratchSeen(who.key, room.id, 'asset', [s.path!]); // [scratch seen] your own attachment
    } catch (e) {
      deps.log(`room ${room.id}: asset record for an attachment failed: ${(e as Error).message}`);
    }
  }
  if (sent.some((x) => x.path && x.url)) {
    scratchChanged(room.id);
  }
  for (const f of files) {
    table.deleteRoomScratch(f.id);
    scratch.remove(f.id);
  }
  table.setRoomDraft(who.key, room.id, '', null); // the text AND the reply target
  /* Only a message that put a file in the room's assets can add the panel: a
     notes-only send put nothing there, and the panel already came with the
     first note (a room without one then had it removed or failed to add it). */
  return { ...out, agentText: envBody, ...(sent.some((x) => x.path) ? { assetsPanel: ensureAssetsPanel(room, deps) } : {}) };
}

/* -------------------------------------------------------------- delivery ---- */

export interface DeliveryOutcome {
  seat: string;
  handle: string;
  paneid: string | null;
  delivered: boolean;
  queued: boolean;
  /** W3-interim: what happened to the TYPED copy (room-typer.ts). Absent when
   *  the occupant was not live. 'self' = the author's own pane, never typed. */
  typed?: roomTyper.EnqueueResult | 'self' | 'channel';
  /** How the member's AGENT got it (channels.ts ladder): typed into the pane,
   *  pushed through its fabric channel, or badge only. Absent when not live or
   *  the author's own pane. */
  path?: channels.Path;
}

/** Who a chat or carried command reaches: the named seats, the lead, or every
 *  active seat for @room — never the author's own seat. A named seat may sit in
 *  ANOTHER room of the family (workgroups, Owner 2026-10-04): it is delivered to
 *  exactly like a local one; only where the line APPEARS differs (sendWords). */
function recipientsOf(roomId: string, to: string | string[] | 'room', actor: RoomActor): RoomSeat[] {
  const seats = table.listSeats(roomId);
  const ids = to === 'room' ? seats.map((s) => s.id) : Array.isArray(to) ? to : [to];
  const self = actor === 'user' ? null : actor.seatId;
  const local = seats.filter((s) => ids.includes(s.id) && s.id !== self);
  const away = ids.filter((id) => !seats.some((s) => s.id === id));
  if (!away.length) {
    return local;
  }
  const others = table.familyContext(roomId).seats.filter((s) => away.includes(s.id) && s.id !== self);
  return [...local, ...others];
}

/** The seats a typed line is parsed against: THIS room's, the family's other
 *  seats (a handle there is a direct address), and the family routing facts the
 *  parser needs for `@lead` / `@<alias>` (room-commands.ts resolve). */
function parseContext(room: Room): { seats: RoomSeat[]; all: RoomSeat[]; family: ParseFamily } {
  const seats = table.listSeats(room.id);
  const fam = table.familyContext(room.id);
  return {
    seats,
    all: [...seats, ...fam.seats],
    family: {
      inWorkgroup: fam.inWorkgroup,
      headLead: fam.headLead,
      seats: fam.seats,
      aliases: fam.aliases.map((a) => ({ alias: a.alias, roomName: a.roomName, lead: a.lead })),
    },
  };
}

/**
 * Put one line entry in front of the human at a seat's occupant (§2.5):
 * handle -> active seat -> occupant PANEID -> fabric.deliverToPane. Never via
 * recipe.agent, seat.slug or project. The caller has already checked the
 * occupant is live; this never spawns.
 */
export function deliverToSeat(room: Room, seat: RoomSeat, entry: RoomLineEntry, body: string): DeliveryOutcome {
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  /* [assistant switch] a seat being switched takes NOTHING directly: the line joins the switch's durable
     journal (by its stable id) and reaches whichever assistant ends up holding the seat, in order. */
  const sw = switchHoldOf(seat);
  if (sw) {
    const authorSeat = entry.author_seat ? table.getSeat(entry.author_seat) : undefined;
    if (!(authorSeat?.occupant_kind === 'pane' && authorSeat.occupant === paneid)) {
      const fromLead = !!entry.author_seat && entry.author_seat === room.lead_seat;
      const item = roomTyper.itemFor(room.id, entry.id, room.name, entry.author, body, agentComms().leadRules && room.lead_seat === seat.id, {
        ts: entry.ts,
        replyNeeded: entry.target !== 'room',
        ...((entry.author === 'user' || fromLead) && roomTyper.isStopLine(entry.body) ? { control: true } : {}),
      });
      try {
        table.appendSwitchLine(sw.op_id, item as unknown as HeldItem);
      } catch (e) {
        appLog(`room ${room.id}: @${seat.handle}: holding line #${entry.id} for the switch failed: ${(e as Error).message}`);
      }
    }
    roomReads.open(room.id, entry.id, seat.id, seat.handle, null, { state: 'unknown', why: 'switching' });
    return { seat: seat.id, handle: seat.handle, paneid, delivered: false, queued: true, typed: 'queued' };
  }
  /* Gate G item 2: every recipient gets a read record (never the author's own
     pane). Opened BEFORE the typer runs, so a synchronous inject finds it. */
  if (!paneid || !isLive(paneid)) {
    roomReads.open(room.id, entry.id, seat.id, seat.handle, null, afterWake.has(seat.id) ? { state: 'waking', why: 'waking' } : { state: 'unknown', why: 'not-live' });
    return { seat: seat.id, handle: seat.handle, paneid, delivered: false, queued: false };
  }
  /* [connector] A connector-owned seat gets neither the envelope nor the typed copy here: the
     line becomes ONE canonical submission (room line + seat, content-hashed) for the connector,
     and a duplicate or conflicting reuse of that id is refused, never re-sent. The connector
     path is DISABLED, so today this only records the offer and badges the read record. */
  if (connectorBridge.isOwned(paneid)) {
    const offer = connectorBridge.offerSubmission({ paneid, submissionId: connectorBridge.roomSubmissionId(room.id, entry.id, seat.id), text: body, source: { room: room.id, line: entry.id, author: entry.author } });
    roomReads.open(room.id, entry.id, seat.id, seat.handle, paneid, { state: 'unknown', why: offer.status === 'conflict' ? 'connector-conflict' : 'connector-held' });
    return { seat: seat.id, handle: seat.handle, paneid, delivered: false, queued: false };
  }
  const out = fabric.deliverToPane(paneid, {
    id: `room:${room.id}:${entry.id}:${seat.id}`,
    ts: new Date(entry.ts).toISOString(),
    from: `room:${room.id}/${entry.author}`,
    to: seat.handle,
    kind: 'msg',
    class: 'coordination',
    attention: 'notice',
    // ENVELOPE ONLY — never written to room_line.thread or rooms.thread (§1.4).
    thread: `room:${room.id}`,
    body,
    ack: 'none',
  });
  /* W3-interim (Owner, 2026-09-24): ALSO type it into the member's composer so
     the AGENT hears the room, behind room-typer's guards (idle, no draft,
     settled, claude-code only). Supersedes, for rooms only, "a room channel
     never types". Never into the author's own pane. */
  const authorSeat = entry.author_seat ? table.listSeats(room.id).find((s) => s.id === entry.author_seat) : undefined;
  let typed: roomTyper.EnqueueResult | 'self' | 'channel' = 'self';
  if (!(authorSeat?.occupant_kind === 'pane' && authorSeat.occupant === paneid)) {
    /* HARBOR_WB_CHANNELS: an AGENT's line to a pane with a live channel is not
       typed once room lines travel as envelopes (channels.roomLinesViaFabric);
       a human's line is always typed. Decided BEFORE the read record opens:
       a channel line is recorded `why: 'channel'` so the seat badge never
       counts it as waiting (room-reads waitingFor, Owner 2026-09-28). */
    const viaChannel = channels.skipRoomTyping(paneid, entry.author);
    roomReads.open(room.id, entry.id, seat.id, seat.handle, paneid, viaChannel ? { state: 'not-yet', why: 'channel' } : undefined);
    /* [labelled batch] + [steer] facts a queueing CLI's typer needs, from the entry itself:
       a line to `@room` is room-wide (fyi); any other line reached this seat because it was
       addressed to it (named, or the lead by default). A control line = the person or the
       room's lead, first word stop/halt/cancel/pause (room-typer isStopLine). */
    const fromLead = !!entry.author_seat && entry.author_seat === room.lead_seat;
    const typedMeta = {
      ts: entry.ts,
      replyNeeded: entry.target !== 'room',
      ...((entry.author === 'user' || fromLead) && roomTyper.isStopLine(entry.body) ? { control: true } : {}),
    };
    typed = viaChannel
      ? 'channel'
      : roomTyper.enqueue(paneid, room.id, entry.id, room.name, entry.author, body, agentComms().leadRules && table.getRoom(seat.room_id)?.lead_seat === seat.id, typedMeta);
  }
  const path = typed === 'self' || !channels.enabled() ? undefined : channels.pathOfTyped(typed);
  if (path) {
    channels.notePath('room', path);
  }
  if (typed === 'off' || typed === 'vendor') {
    // Badge-only or typing switched off: nothing we can observe says the AGENT took it in.
    roomReads.cannotTell(room.id, entry.id, seat.id, typed === 'vendor' ? 'badge-only' : 'typing-off');
  }
  return out.ok
    ? { seat: seat.id, handle: seat.handle, paneid, delivered: out.delivered, queued: out.queued, typed, ...(path ? { path } : {}) }
    : { seat: seat.id, handle: seat.handle, paneid, delivered: false, queued: false, typed, ...(path ? { path } : {}) };
}

/** The Concierge's relay to a seat that took nothing because it is RESTING (concierge.md P2, Owner [ref]):
 *  exactly what the PERSON's own line to it does (sendWords -> notLiveBody -> restingNote with the user as
 *  actor): wake it (level-1 rest, or personWakes), keep the line in afterWake so it is delivered when the
 *  seat is up, or say it was not woken (disconnected by the person under the 'auto' scope). Null when the
 *  seat took the line or is not resting. */
export function wakeForRelay(room: Room, seat: RoomSeat, entry: RoomLineEntry, body: string, d: DeliveryOutcome): { note: string; waking: boolean } | null {
  if (d.delivered || d.queued || !isResting(seat)) {
    return null;
  }
  const note = restingNote(seat, 'user', { log: appLog } as RoomRouteDeps);
  const waking = afterWake.has(seat.id);
  if (waking) {
    afterWake.get(seat.id)!.push({ room, entry, body });
  }
  return { note, waking };
}

const NOT_LIVE = 'not delivered — occupant not live';

/* ------------------------------------------------------- the command door ---- */

export interface LineResponse {
  status: 'applied' | 'delivered' | 'posted' | 'confirm' | 'refused';
  entries: RoomLineEntry[];
  confirm?: { token: string; prompt: string };
  refused?: { error: string; suggestion?: string };
  client?: { action: 'help' | 'brief'; data: unknown; agent?: unknown };
  /** Additive: where each addressed message went (paneid, not slug). */
  deliveries?: DeliveryOutcome[];
  /** A word to the sender about its own line, in the same answer (the fabric also carries it to a live seat): today, that the line
   *  reached no one because it named nobody [no-addressee nudge]. */
  notice?: string;
}

function refusal(roomId: string, text: string, error: string, suggestion: string | null): LineResponse {
  noteRefused(roomId, text, suggestion);
  return { status: 'refused', entries: [], refused: suggestion ? { error, suggestion } : { error } };
}

/** The recipes a typed `/add <project>` names: by id, by project-folder
 *  basename, by name, or by slug. */
function recipesFor(project: string): string[] {
  const want = normalizeSlug(project);
  return table
    .listRecipes()
    .filter(
      (r) =>
        r.id === project ||
        (want !== null &&
          ((r.projectDir && normalizeSlug(projectBasename(r.projectDir) ?? '') === want) ||
            normalizeSlug(r.name) === want ||
            r.agent === want)),
    )
    .map((r) => r.id);
}

/** Execute one parsed ROOM command through the same table verb the HTTP door
 *  uses. Throws RoomError/FieldError on a refusal. */
function execRoom(room: Room, p: Extract<ParseResult, { type: 'room' }>, text: string, actor: RoomActor): RoomLineEntry[] {
  const opts = { actor, commandText: text };
  const seatId = (p.target as SeatRef | null)?.seatId as string;
  switch (p.verb) {
    case 'set-lead':
      return table.updateRoom(room.id, { lead_seat: seatId }, opts).entries;
    case 'set-policy':
      return table.updateSeat(
        room.id,
        seatId,
        { policy: p.args.policy as string, ...(p.args.pool_size !== undefined ? { pool_size: p.args.pool_size as number } : {}) },
        opts,
      ).entries;
    case 'rename-room':
      return table.updateRoom(room.id, { name: p.args.name as string }, opts).entries;
    case 'rename-seat':
      return table.updateSeat(room.id, seatId, { handle: p.args.handle as string }, opts).entries;
    case 'mode':
      return table.updateRoom(room.id, { mode: (p.args.mode as string | null) ?? null }, opts).entries;
    case 'brief': // [room brief] Owner 2026-10-05: set or clear (show is answered before this)
      return table.setRoomBrief(room.id, p.args.clear === true ? null : (p.args.text as string), opts).entries;
    case 'reopen':
      return table.reopenRoom(room.id, opts).entries;
    case 'archive':
      return table.archiveRoom(room.id, opts).entries;
    case 'dissolve':
      return table.dissolveWorkgroup(room.id, opts).entries;
    case 'remove':
      return table.removeSeat(room.id, seatId, opts).entries;
    case 'add': {
      /* BIND-ONLY until summon lands (§0.1 Q1): bind the project's ONE live
         pane if there is exactly one, otherwise the seat starts empty
         (`never-started`). Never spawns. */
      const project = p.args.project as string;
      const recipes = recipesFor(project);
      const live = table.list().filter((r) => r.state === 'live' && r.recipe_id && recipes.includes(r.recipe_id));
      const added = table.addSeat(
        room.id,
        {
          project,
          recipe_id: recipes.length === 1 ? recipes[0] : null,
          handle: (p.args.handle as string | undefined) ?? null,
          occupant: live.length === 1 ? live[0].paneid : null,
        },
        opts,
      );
      seatWelcome.welcomeSeat(room, added.result); // room welcome, Owner 2026-10-05
      return added.entries;
    }
    case 'replace': {
      /* BIND-ONLY: retire the occupant to history and bind the named LIVE pane,
         or leave the seat empty. Not confirmed — nothing is lost (§3). */
      const seat = table.getSeat(seatId)!;
      if (p.args.paneid === undefined && seat.occupant_kind === 'none') {
        throw new FieldError(409, `@${seat.handle} is already empty`, 'seat');
      }
      const occupant = p.args.paneid === undefined ? null : requireLivePane(p.args.paneid, 'paneid');
      const bound = table.setOccupant(room.id, seatId, occupant, { ...opts, reason: 'replaced' });
      seatWelcome.welcomeSeat(room, bound.result); // room welcome, Owner 2026-10-05
      return bound.entries;
    }
    default:
      throw new FieldError(400, `${p.verb} is not executable`, 'text');
  }
}

function confirmPrompt(room: Room, p: Extract<ParseResult, { type: 'room' }>): string {
  if (p.verb === 'remove') {
    const h = (p.target as SeatRef).handle;
    return `Remove @${h} from "${room.name}"? The seat is given up; its former occupant is kept in history.`;
  }
  if (p.verb === 'dissolve') {
    const seats = table.listSeats(room.id);
    const parent = room.parent_id ? table.getRoom(room.parent_id) : undefined;
    const names = seats.map((s) => `@${s.handle}${s.id === room.lead_seat ? ' (lead)' : ''}`).join(', ') || 'no seats';
    return `Dissolve "${room.name}"? ${names} return to ${parent?.name ?? 'the main room'}. The group's history is kept. Nothing is deleted.`;
  }
  return `Archive "${room.name}"? It can be reopened with /reopen.`;
}

/* ---------------------------------------------------------------- reply ---- */
/* REPLY TO A LINE (the design system room-reply-v1, Owner 2026-09-28; engine/room-reply.ts).
 * `reply_to` on POST .../line (every door: the window, the bearer + from, the
 * pane token) names an entry of THIS room; anything else is 400 reply_to. The
 * entry written carries meta.reply (the quote captured now) and every agent
 * copy starts with the reply prefix (sendWords -> withReply).
 *
 * ROUTING (decided 2026-09-28): an UN-ADDRESSED reply to a line a SEAT wrote
 * goes to THAT seat, instead of the lead — "Replying to @author" means "to
 * @author", and a copy to the lead as well would be a surprise the chip never
 * showed. An explicit leading @address wins (the author is not added: the
 * person chose). A reply to your own line, a fact, the voice agent, a seat
 * that has left, or your own seat's line (an agent answering itself) follows
 * normal routing — and the chip says where that is. */

/** `reply_to` as sent: absent/null = none; anything but a positive integer is 400. */
function replyToField(body: Record<string, unknown>): number | null {
  const v = body.reply_to;
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new FieldError(400, 'reply_to is the id of an entry on this room line', 'reply_to');
  }
  return v;
}

/** The entry `reply_to` names — only an entry of THIS room (400 otherwise). */
function replyEntry(room: Room, id: number | null): RoomLineEntry | null {
  if (id === null) {
    return null;
  }
  const e = table.getLineEntry(id);
  /* an entry of THIS room: written here, or cross-posted INTO it */
  if (!e || (e.room_id !== room.id && table.xpostView(e, room.id)?.direction !== 'in')) {
    throw new FieldError(400, `reply_to: #${id} is not an entry of this room`, 'reply_to');
  }
  return e;
}

/** The quote of the entry being answered, captured now. */
function replyRefFor(e: RoomLineEntry, userHandle: string): ReplyRef {
  return replyRef(e, { userHandle, seatHandle: (id) => table.getSeat(id)?.handle ?? null });
}

/** The seat an un-addressed reply goes to instead of the lead, or null for
 *  normal routing (the rule above). */
function replySeat(room: Room, original: RoomLineEntry | null, text: string, actor: RoomActor): RoomSeat | null {
  if (!original?.author_seat || leadingAddress(text) !== null || text.startsWith('/')) {
    return null;
  }
  /* [address only] a reply that names someone mid-text goes to who it names */
  const ctx = parseContext(room);
  if (namesAnyone(text, ctx.seats, { family: ctx.family, userHandle: userHandleOf(pictureOwner(null)) })) {
    return null;
  }
  const seat = [...table.listSeats(room.id), ...table.familyContext(room.id).seats].find((s) => s.id === original.author_seat);
  if (!seat || (actor !== 'user' && actor.seatId === seat.id)) {
    return null;
  }
  return seat;
}

/* REPLY INHERITS [reply route] (Owner 2026-10-08): a Codex seat answered his line with
   room_post but no @user and no reply_to, so it went to the lead by default and never
   reached his "to me" view. An AGENT's chat line that names nobody (no seat, no @user,
   not @room) and sets no reply_to answers the person's newest line to that seat that
   it has not answered yet: it gets reply_to that line and goes to the person, not the
   lead. "Not answered" = the seat has written no line in the room since (a reply to it
   is such a line). Within REPLY_INHERIT_WINDOW_MS; Agent comms `replyInherits` off =
   today's routing. */
export const REPLY_INHERIT_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The person's line an un-addressed agent line answers, or null for normal routing. */
function inheritedReply(room: Room, actor: RoomActor, text: string, explicit: RoomLineEntry | null, parsed: ParseResult, userHandle: string): RoomLineEntry | null {
  if (actor === 'user' || !agentComms().replyInherits || parsed.type !== 'chat' || parsed.to === 'room') {
    return null;
  }
  if (text.startsWith('/') || leadingAddress(text) !== null) {
    return null;
  }
  const ctx = parseContext(room);
  if (namesAnyone(text, ctx.seats, { family: ctx.family, userHandle })) {
    return null;
  }
  /* an explicit reply_to the PERSON's line, naming nobody, goes to the person too (not the lead) */
  if (explicit) {
    return explicit.author === 'user' ? explicit : null;
  }
  const seat = table.getSeat(actor.seatId);
  if (!seat) {
    return null;
  }
  /* delivered to this seat: its stored target (the first seat named, or the lead by
     default), @room, a cross-post that reached its handle, or a read record opened when
     it was handed over (every named seat; in memory, so lost on restart) */
  for (const e of table.userLinesSinceSeat(room.id, seat.id, Date.now() - REPLY_INHERIT_WINDOW_MS)) {
    const xhandles = e.xhandles ? (JSON.parse(e.xhandles) as string[]) : [];
    if (e.target_seat === seat.id || e.target === 'room' || xhandles.includes(seat.handle) || roomReads.deliveredTo(e.room_id, e.id, seat.id)) {
      return e;
    }
  }
  return null;
}

/** A line POST's own fields, validated (400 naming the field). */
function lineInput(body: Record<string, unknown>): { text: string; ref: string | null; confirm: string | null; replyTo: number | null } {
  const raw = body.text;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new FieldError(400, 'text is required', 'text');
  }
  if (raw.length > LINE_BODY_MAX) {
    throw new FieldError(400, `text is over ${LINE_BODY_MAX} characters`, 'text');
  }
  if (body.ref !== undefined && body.ref !== null && (typeof body.ref !== 'string' || body.ref.length > REF_MAX)) {
    throw new FieldError(400, `ref is an attachment id (<= ${REF_MAX} chars)`, 'ref');
  }
  if (body.confirm !== undefined && body.confirm !== null && typeof body.confirm !== 'string') {
    throw new FieldError(400, 'confirm is the token a previous answer gave', 'confirm');
  }
  return {
    text: raw.trim(),
    ref: typeof body.ref === 'string' ? body.ref : null,
    confirm: typeof body.confirm === 'string' ? body.confirm : null,
    replyTo: replyToField(body),
  };
}

/* LINE LINKS INTO A TOOL VIEW [rooms/tool-links] (engine/tool-links.ts,
 * apps.resolveLink). `links: [{tool, ref, label?}]` on POST .../line — THE
 * ONE helper every post path runs (the window, bearer + from, a tool line,
 * the pane token, an attachment send), before anything is written or moved:
 * <= LINKS_MAX; the tool registered, a member of THIS room, not held; `ref`
 * matching one of its declared patterns; `label` plain text <= 80 (absent =
 * the pattern's label). Anything else is 400 field 'links[i]' (or 'links'
 * for the list itself). Stored in meta.links as apps.resolveLink answers it.
 *
 * AVAILABILITY IS THE PAGE'S (decided 2026-09-28): the stored link never
 * changes; whether it can open NOW (the app left the room, moved to another,
 * is held, not running, has no panel here) is derived by the page from the
 * room's panels + GET /api/apps, the same data the + sheet reads — a
 * per-line state computed on read would go stale in the page's list the
 * moment an app moved, since nothing re-pushes old lines. */
function lineLinks(room: Room, raw: unknown): StoredLink[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new FieldError(400, 'links is a list of {tool, ref, label?}', 'links');
  }
  if (raw.length > LINKS_MAX) {
    throw new FieldError(400, `a line carries at most ${LINKS_MAX} links (got ${raw.length})`, 'links');
  }
  return raw.map((l, i) => {
    const field = `links[${i}]`;
    if (!l || typeof l !== 'object' || Array.isArray(l)) {
      throw new FieldError(400, `${field} is {tool, ref, label?}`, field);
    }
    const { tool, ref, label } = l as Record<string, unknown>;
    if (typeof tool !== 'string' || tool.length > 64 || !TOOL_SLUG.test(tool)) {
      throw new FieldError(400, `${field}: tool is an app's slug (a-z, 0-9, -)`, field);
    }
    if (typeof ref !== 'string' || !ref) {
      throw new FieldError(400, `${field}: ref is required (e.g. "review/2")`, field);
    }
    let lab: string | null = null;
    if (label !== undefined && label !== null) {
      lab = cleanLabel(label);
      if (lab === null) {
        throw new FieldError(400, `${field}: label is plain text, 1..80 characters, one line`, field);
      }
    }
    try {
      return apps.resolveLink(room.id, tool, ref, lab);
    } catch (e) {
      if (e instanceof apps.LinkError) {
        throw new FieldError(400, `${field}: ${e.message}`, field);
      }
      throw e;
    }
  });
}

/**
 * TO THE USER (Owner 2026-09-28): how a chat / attachment line is stored as
 * addressed — the ONE helper every post path (the person's window, the bearer
 * + `from`, the pane token, fabric-mcp's room_post, attachments) writes by,
 * for every author. `@user` and the user's @name both address the user
 * (room-commands isUserAddress); `user` is normalised to the handle. A line
 * addressed to the user carries `meta.to_user: true` so the page never infers
 * it; one led ONLY by the user is stored target = the handle, no seat (never
 * the lead default). The user is not a seat, so nothing is typed anywhere for
 * that part: seats named alongside still get it (the parser's `to`).
 * `toSeat` (an un-addressed reply to a seat's line) keeps its seat target.
 */
function userAddressed(
  text: string,
  parsed: ParseResult | null,
  seats: RoomSeat[],
  userHandle: string,
  toSeat: RoomSeat | null,
): { target: string | null; toUser: string | null; meta: { to_user?: true }; noLead?: true } {
  const p = parsed && parsed.type === 'chat' ? parsed : {};
  const a = chatAddress(text, p, seats, userHandle);
  const meta = a.toUserMeta ? { to_user: true as const } : {};
  if (toSeat) {
    return { target: toSeat.handle, toUser: null, meta };
  }
  /* [address only] no leading address and not the lead default: the line named
     someone mid-text (stored as addressed to the first seat it names) or nobody
     at all with unaddressedToLead off (stored with no seat: never the lead). */
  const pc = parsed && parsed.type === 'chat' ? parsed : null;
  if (a.target === null && !a.toUser && pc && !pc.leadDefault && pc.to !== 'room') {
    const ids = Array.isArray(pc.to) ? pc.to : [pc.to];
    const first = ids.length ? seats.find((s) => s.id === ids[0]) : undefined;
    return first ? { target: first.handle, toUser: null, meta } : { target: null, toUser: null, meta, noLead: true };
  }
  return { target: a.target, toUser: a.toUser, meta };
}

/** The seats a sent line is delivered to as @-NAMED (the fabric copy's 'ask'): every
 *  recipient, except the lead it reached only by default [address only]. */
function namedOf(toSeat: RoomSeat | null, to: string | string[] | 'room', parsed: ParseResult | null): string[] {
  if (toSeat) {
    return [toSeat.id];
  }
  if (to === 'room' || (parsed?.type === 'chat' && parsed.leadDefault)) {
    return [];
  }
  return Array.isArray(to) ? to : [to];
}

/**
 * POST /api/rooms/:id/line. `text` is verbatim; the engine parses it.
 */
function postLine(room: Room, body: Record<string, unknown>, deps: RoomRouteDeps, userHandle?: string): LineResponse {
  const input = lineInput(body);
  let actor: RoomActor;
  try {
    actor = authorFor(room.id, body.from, deps);
  } catch (e) {
    const away = e instanceof FieldError && e.status === 403 ? familyToolAuthor(room, body) : null;
    if (!away) {
      const esc = e instanceof FieldError && e.status === 403 && body.tool == null ? familyEscalateAuthor(room, body) : null;
      if (!esc) {
        throw e;
      }
      return postEscalated(room, esc, input, body, deps, userHandle);
    }
    room = away.room;
    actor = away.actor;
  }
  const tool = toolInput(room.id, body.tool, actor);
  const links = lineLinks(room, body.links);
  if (tool) {
    if (input.replyTo !== null) {
      throw new FieldError(400, 'a tool line reports an action; it does not reply to a line', 'reply_to');
    }
    return postToolLine(room, actor as { seatId: string }, input.text, tool, input.ref, deps, links);
  }
  return postLineAs(room, actor, input.text, { ref: input.ref, confirm: input.confirm, userHandle, replyTo: input.replyTo, links }, deps);
}

/** A person's @name: the one they set in Room settings, else their account
 *  name normalised (GET /api/rooms/me `handle`). */
export function userHandleOf(who: { key: string; name: string | null }): string {
  return table.getUserHandle(who.key) ?? table.defaultUserHandle(who.name);
}

/* TOOL LINES (Owner 2026-09-28): a line a TOOL posts about an action, addressed
 * to whoever INITIATED that action — never to the room at large. `tool: {slug,
 * for}` on POST .../line: `for` is "user" (a direct user action: the line is
 * the user's, "to me") or a seat handle in this room (the agent that asked).
 * The tool posts through its resident's seat (`from`) as today; the engine
 * cannot know who initiated — the tool does, and says so here.
 *   - never parsed: no /command, no @address — the text is verbatim chat;
 *   - `for` another seat: addressed to it and delivered to its pane, prefixed
 *     `[<slug>]` so the agent knows which tool is reporting;
 *   - `for` the resident's own seat or "user": addressed to the author's own
 *     seat, so nobody's pane is typed into (recipientsOf skips the author);
 *   - meta `{tool, for}`, `for` = "user" or the seat id: the line's filters
 *     read it ("to me" shows a tool line only when for = "user"). */
/** Every active seat of the room's FAMILY (this room first). Handles are unique
 *  across a family, so a named seat resolves wherever it sits; a seat of
 *  another family is never in this list [family app routing] Owner 2026-10-05. */
function familySeats(roomId: string): RoomSeat[] {
  return [...table.listSeats(roomId), ...table.familyContext(roomId).seats];
}

/** An APP's bound pane may post a tool line into ANY room of its family, even
 *  where it holds no seat: its author seat is the one it holds elsewhere in
 *  the family, and the line is written in THAT room (an agent's line is one
 *  row in its own seat's room), reaching the `for` seat's room by the family
 *  cross-post. Kept: the slug is a registered app of this family. Null when it
 *  does not apply (the normal author rule then speaks). [family app routing]
 *  Owner 2026-10-05. */
function familyToolAuthor(room: Room, body: Record<string, unknown>): { room: Room; actor: { seatId: string } } | null {
  const t = body.tool;
  const slug = t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>).slug : null;
  if (typeof slug !== 'string' || !TOOL_SLUG.test(slug) || !body.from || !table.getToolRegistry(slug) || !table.listRoomApps(room.id).some((a) => a.slug === slug)) {
    return null;
  }
  const panes = new Set(fromRow(body.from).map((r) => r.paneid));
  const seats = table.familyContext(room.id).seats.filter((s) => s.occupant_kind === 'pane' && s.occupant && panes.has(s.occupant));
  const home = seats.length === 1 ? table.getRoom(seats[0].room_id) : undefined;
  return home ? { room: home, actor: { seatId: seats[0].id } } : null;
}
/* [family escalate, MCP door] Night test 2026-10-06: the fabric MCP's room_post
 * uses the bearer + `from` door, which never reached escalateLine (pane-token
 * door only), so a workgroup member answering a main-room line got 403 "that
 * pane holds no seat in this room" and its answer was lost. Same rule as
 * escalateLine: the pane's ONE seat in this room's family authors the line in
 * its own room; it goes to the named room's lead unless it leads with an
 * @address. */
function familyEscalateAuthor(room: Room, body: Record<string, unknown>): { home: Room; seatId: string } | null {
  if (!body.from || room.state !== 'open') {
    return null;
  }
  let panes: Set<string>;
  try {
    panes = new Set(fromRow(body.from).map((r) => r.paneid));
  } catch {
    return null;
  }
  const seats = table.familyContext(room.id).seats.filter((s) => s.occupant_kind === 'pane' && s.occupant && panes.has(s.occupant));
  const home = seats.length === 1 ? table.getRoom(seats[0].room_id) : undefined;
  return home && home.state === 'open' ? { home, seatId: seats[0].id } : null;
}

function postEscalated(
  named: Room,
  esc: { home: Room; seatId: string },
  input: ReturnType<typeof lineInput>,
  body: Record<string, unknown>,
  deps: RoomRouteDeps,
  userHandle?: string,
): LineResponse {
  const links = lineLinks(esc.home, body.links);
  /* reply_to names an entry of the room it was READ in; valid in the home room
     only if it was cross-posted there. Otherwise the answer goes to that
     entry's author instead (what the reply meant), and the quote is dropped. */
  let replyTo = input.replyTo;
  let to: RoomSeat | undefined;
  if (replyTo !== null) {
    try {
      replyEntry(esc.home, replyTo);
    } catch {
      const orig = table.getLineEntry(replyTo);
      to = orig?.author_seat ? familySeats(esc.home.id).find((s) => s.id === orig.author_seat) : undefined;
      replyTo = null;
    }
  }
  if (!to) {
    to = named.lead_seat ? table.getSeat(named.lead_seat) : undefined;
  }
  if (!to && leadingAddress(input.text) === null) {
    throw new FieldError(409, `"${named.name}" has no lead to address: start the line with @<handle> of a seat there`, 'text');
  }
  return postLineAs(esc.home, { seatId: esc.seatId }, input.text, {
    ref: input.ref, confirm: input.confirm, userHandle, replyTo, links,
    ...(to && to.id !== esc.seatId ? { escalateTo: to } : {}),
  }, deps);
}
const TOOL_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
interface ToolLine {
  slug: string;
  forSeat: RoomSeat | null; // null = the user
}
function toolInput(roomId: string, raw: unknown, actor: RoomActor): ToolLine | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FieldError(400, 'tool is {slug, for}', 'tool');
  }
  if (actor === 'user') {
    throw new FieldError(400, "a tool line is posted from its resident's seat (from)", 'tool');
  }
  const { slug, for: who } = raw as Record<string, unknown>;
  if (typeof slug !== 'string' || slug.length > 64 || !TOOL_SLUG.test(slug)) {
    throw new FieldError(400, 'tool.slug is the tool\'s slug (a-z, 0-9, -)', 'tool.slug');
  }
  if (who === 'user') {
    return { slug, forSeat: null };
  }
  const handle = typeof who === 'string' ? normalizeSlug(who.replace(/^@/, '')) ?? '' : '';
  const seat = handle ? familySeats(roomId).find((s) => s.handle === handle) : undefined;
  if (!seat) {
    throw new FieldError(400, 'tool.for is "user" or the handle of a seat in this room or its family — who initiated the action', 'tool.for');
  }
  return { slug, forSeat: seat };
}

function postToolLine(
  room: Room,
  actor: { seatId: string },
  text: string,
  tool: ToolLine,
  ref: string | null,
  deps: RoomRouteDeps,
  links: StoredLink[] = [],
): LineResponse {
  const to = tool.forSeat ?? table.getSeat(actor.seatId)!;
  const words: LineInput = {
    kind: 'chat',
    body: text,
    target: to.handle,
    meta: { tool: tool.slug, for: tool.forSeat ? tool.forSeat.id : 'user', ...(links.length ? { links } : {}) },
    ...(ref !== null ? { ref } : {}),
  };
  const recipients = recipientsOf(room.id, [to.id], actor);
  return sendWords(room, words, recipients, actor, deps, { carried: false, envBody: `[${tool.slug}] ${text}`, named: [] });
}

/*
 * A PANEL ACTION'S LINE [ticket] (Owner 2026-09-30: "the user clicked, entered
 * the info and hit submit — that is the consent; they shouldn't have to hit
 * send"). A verb declared `postsToRoom` in the PINNED tool.json whose call
 * succeeded may answer `roomLine: {text, links?, to?, data?}`; it is posted
 * HERE, in THIS room only, as THE PERSON who clicked (actor 'user', the author
 * a human line has), meta {via_app, via_app_name, action, app_data?}. The
 * route reaches this only on the click-gated, window-cookie action path, so
 * no bearer or pane token ever posts through it.
 *   - never parsed: the app's text cannot be a /command or pick recipients
 *     (the person consented to a submit, not to where the app sends it). It
 *     goes where an un-addressed human line goes: THE LEAD. A room with no
 *     lead: the line is still written (the person's record), addressed to the
 *     person, typed nowhere.
 *   - TO THE REQUESTER [ticket]: only when the pinned setting is
 *     `{"to": "requester"}`, `roomLine.to` (ONE seat handle or seat id) may
 *     address the line to the agent that asked for the work — accepted only
 *     for a LIVE member seat of THIS room that this app posted a tool line
 *     FOR in this room within REQUESTER_EVIDENCE_DAYS (requesterSeat). Then
 *     it is addressed to that seat, delivered to it alone (not typed to the
 *     lead), exactly like a person's @-addressed line. Anything else falls
 *     back to the un-addressed line, with a warning naming why.
 *   - DATA [ticket]: only when the pinned setting says `"data": true`,
 *     `roomLine.data` (a JSON object <= apps.ROOM_LINE_DATA_MAX bytes) is kept
 *     in meta.app_data — the room page never draws it — and every agent copy
 *     carries it after the text (apps.appDataBlock). A bad one: a warning, the
 *     line posts without it.
 *   - an agent gets `[via <App>] <text>` on BOTH the typed and the fabric
 *     channel copy: never a leading `/`.
 *   - links: `path` is a ref into this app's own declared `links`, resolved
 *     by resolveLink exactly as a tool line's.
 *   - any problem is a WARNING, never a failure: the action already ran
 *     upstream. A bad text or link posts nothing; a bad `to` or `data` only
 *     drops that part. Several warnings are joined with "; ".
 */
export const REQUESTER_EVIDENCE_DAYS = 14;
const REQUESTER_EVIDENCE_MS = REQUESTER_EVIDENCE_DAYS * 24 * 60 * 60 * 1000;

/**
 * `roomLine.to` -> the requesting seat, or why not [ticket]. The app knows
 * who asked for the work (the §4.4 tool-line rule: the tool, not the engine,
 * knows who initiated); the engine only lets it name a seat it has ALREADY
 * reported work to — so a panel line can never pick an arbitrary member.
 * `now` is a parameter so a test can move the clock.
 */
export function requesterSeat(
  room: Room,
  slug: string,
  raw: unknown,
  now: number = Date.now(),
): { seat: RoomSeat } | { why: string } {
  if (Array.isArray(raw)) {
    return { why: 'is ONE seat (a handle or a seat id), not a list' };
  }
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 80) {
    return { why: 'is a seat handle or a seat id' };
  }
  const want = raw.trim();
  const handle = normalizeSlug(want.replace(/^@/, '')) ?? '';
  /* the FAMILY's seats: the requester may sit in a sibling workgroup [family app routing] Owner 2026-10-05 */
  const seat = familySeats(room.id).find((s) => s.id === want || (!!handle && s.handle === handle));
  if (!seat) {
    return { why: `names no seat in this room or its family (${JSON.stringify(want.slice(0, 40))})` };
  }
  if (seat.occupant_kind !== 'pane' || !isLive(seat.occupant)) {
    return { why: `@${seat.handle} is not live` };
  }
  const last = table.familyRoomIds(room.id).reduce<number | null>((m, id) => {
    const t = table.lastToolLineFor(id, slug, seat.id);
    return t !== null && (m === null || t > m) ? t : m;
  }, null);
  if (last === null || now - last > REQUESTER_EVIDENCE_MS) {
    return { why: `@${seat.handle} has not asked this app for work here: no tool line from ${slug} for it in this room family in the last ${REQUESTER_EVIDENCE_DAYS} days` };
  }
  return { seat };
}

export function postPanelLine(
  room: Room,
  slug: string,
  post: { appName: string; verb: string; roomLine: unknown; to: 'lead' | 'requester'; data: boolean },
  userHandle: string,
  deps: RoomRouteDeps,
): { entries?: RoomLineEntry[]; warning?: string } {
  const line = apps.roomLineOf(post.roomLine);
  if (!line) {
    return {};
  }
  if (!line.ok) {
    return { warning: line.warning };
  }
  const links: StoredLink[] = [];
  for (const [i, l] of line.links.entries()) {
    const label = l.label === null ? null : cleanLabel(l.label);
    if (l.label !== null && label === null) {
      return { warning: `roomLine.links[${i}]: label is plain text, 1..80 characters, one line: nothing was posted` };
    }
    try {
      links.push(apps.resolveLink(room.id, slug, l.ref, label));
    } catch (e) {
      if (e instanceof apps.LinkError) {
        return { warning: `roomLine.links[${i}]: ${e.message}: nothing was posted` };
      }
      throw e;
    }
  }
  const raw = post.roomLine as Record<string, unknown>; // roomLineOf said it is a plain object
  const warnings: string[] = [];
  let requester: RoomSeat | null = null;
  if (raw.to !== undefined && raw.to !== null) {
    if (post.to !== 'requester') {
      warnings.push(`roomLine.to is ignored: this action's postsToRoom does not say "to": "requester", so the line went un-addressed`);
    } else {
      const r = requesterSeat(room, slug, raw.to);
      if ('seat' in r) {
        requester = r.seat;
      } else {
        warnings.push(`roomLine.to ${r.why}: the line went un-addressed`);
      }
    }
  }
  let appData: Record<string, unknown> | null = null;
  if (raw.data !== undefined && raw.data !== null) {
    if (!post.data) {
      warnings.push(`roomLine.data is ignored: this action's postsToRoom does not say "data": true`);
    } else {
      const d = apps.roomLineDataOf(raw.data);
      if (d.ok) {
        appData = d.data;
      } else {
        warnings.push(d.warning);
      }
    }
  }
  const lead = room.lead_seat ? table.listSeats(room.id).find((s) => s.id === room.lead_seat) ?? null : null;
  const alone = !requester && !lead; // nobody to tell: the person's own record
  const words: LineInput = {
    kind: 'chat',
    body: line.text,
    ...(requester ? { target: requester.handle } : alone ? { toUser: userHandle } : {}),
    meta: {
      via_app: slug,
      via_app_name: post.appName,
      action: post.verb,
      ...(links.length ? { links } : {}),
      ...(appData ? { app_data: appData } : {}),
      ...(alone ? { to_user: true } : {}),
    },
  };
  const agentBody = `[via ${post.appName}] ${line.text}`;
  const warning = (extra?: string) => [...warnings, ...(extra ? [extra] : [])].join('; ') || undefined;
  try {
    /* the line is written IN THE ROOM WHERE THE REQUESTER SITS, so its delivery,
       read state and badges work there [family app routing] Owner 2026-10-05 */
    const dest = requester && requester.room_id !== room.id ? table.getRoom(requester.room_id) ?? room : room;
    const out = sendWords(dest, words, requester ? [requester] : lead ? [lead] : [], 'user', deps, {
      carried: false,
      envBody: agentBody,
      fabricBody: agentBody,
      named: requester ? [requester.id] : [],
      ...(appData ? { trailer: apps.appDataBlock(post.appName, appData) } : {}),
    });
    const w = warning();
    return { entries: out.entries, ...(w ? { warning: w } : {}) };
  } catch (e) {
    if (e instanceof RoomError) {
      return { warning: warning(`the line could not be posted (${e.message})`) };
    }
    throw e;
  }
}

/**
 * Post `text` to the room AS `actor` (briefing-table-mcp §4.2): the line
 * handler with the author already decided. The HTTP door decides it from
 * `from` (authorFor); the pane-token door and `bt` from the token, so nothing
 * here can ever read a caller-supplied author.
 */
/** How many person accounts exist (identity modes only; legacy has the one shared person). */
function personAccountCount(): number {
  try {
    return identityAuth.enabled() ? identityStore.countAccounts() : 1;
  } catch {
    return 1;
  }
}

export function postLineAs(
  room: Room,
  actor: RoomActor,
  text: string,
  opts: { ref?: string | null; confirm?: string | null; userHandle?: string; replyTo?: number | null; links?: StoredLink[]; escalateTo?: RoomSeat; leadOnly?: boolean },
  deps: RoomRouteDeps,
): LineResponse {
  const ctx = parseContext(room);
  /* `seats` = this room's seats PLUS the family's (a handle in a workgroup is a
     direct address from anywhere in the family); the parser is handed this
     room's own seats and the family separately. */
  const seats = ctx.all;
  /* THE USER's @name (the person the window or bearer resolves to; the
     single admin for a door with no principal): "@owner ..." is to the user. */
  const userHandle = opts.userHandle ?? userHandleOf(pictureOwner(null));
  /* THE PERSON'S REAL NAME ON AN AGENT'S LINE (Owner [ref], toolkit [ref]): "@user" in the
     saved text becomes "@<their handle>", outside code and quotes, so a copied line does not
     conflate two people. Agents' and apps' lines only; skipped when another person account
     exists (then "@user" is ambiguous); a person with no handle set (`user`) is a no-op. Old
     lines keep "@user". The address itself is unchanged: both forms address the person. */
  if (actor !== 'user' && personAccountCount() <= 1) {
    text = convertUserAlias(text, userHandle);
  }
  const explicit = replyEntry(room, opts.replyTo ?? null); // 400 before anything else happens
  /* A REPLY IS ADDRESSED BY ITS LEADING @ LIST ONLY (Owner [ref]): the @ names after it are text, not recipients. Addressing reads
     this copy; the saved and shown text is `text`. A new line (no reply_to) is addressed as before, by every @ in it. */
  /* `leadOnly` gives a NEW line the same rule a reply has: only the leading @ list addresses (the Tasks ask-lead uses it, so a name in the asker's text reaches nobody) */
  const addrText = (explicit || opts.leadOnly) && !text.startsWith('/') ? leadOnlyAddresses(text) : text;
  const parsed = parse(addrText, ctx.seats, { userHandle, family: ctx.family, unaddressedToLead: agentComms().unaddressedToLead, basic: isBasic() && actor === 'user' });
  let p = parsed;
  /* an un-addressed reply to a seat's line goes to that seat (the rule above)
     — also in a room with no lead yet, where un-addressed chat is refused */
  /* ESCALATION [family escalate] Owner 2026-10-05: a pane that named another room
     of its family with no @address leading goes to THAT room's lead */
  const toSeat = replySeat(room, explicit, addrText, actor) ?? (opts.escalateTo && leadingAddress(text) === null && !text.startsWith('/') ? opts.escalateTo : null);
  if (toSeat && (p.type === 'chat' || p.type === 'refused')) {
    p = { type: 'chat', to: [toSeat.id] } as ParseResult;
  }
  /* [reply route] an agent's line that names nobody answers the person's open line to it */
  const inherited = toSeat ? null : inheritedReply(room, actor, text, explicit, parsed, userHandle);
  if (inherited) {
    p = { type: 'chat', to: [], toUser: true } as ParseResult;
  }
  /* A REPLY TO THE ROOM'S OWN LINE [reply routing] (Owner [ref], lead [ref]): a turn fact, a delivery note. It has no
     seat to answer, and used to fall to the lead by default and to the person as "names nobody". With no @ at all it
     reaches nobody new: it is written in the room. A reply that names someone still goes to who it names. */
  const toRoomLine = actor !== 'user' && !toSeat && !inherited && explicit?.author === 'room' && parsed.type === 'chat' && parsed.leadDefault === true; // an AGENT's reply; the person's un-addressed line still goes to the lead
  if (toRoomLine) {
    p = { type: 'chat', to: [] } as ParseResult;
  }
  const original = explicit ?? inherited;

  if (p.type === 'refused') {
    return refusal(room.id, text, p.error, p.suggestion);
  }

  const links = opts.links ?? [];
  if (p.type === 'typed') {
    /* [basic] a typed /command for the agent: written verbatim as the user's line,
       delivered with the typed marker (agent-commands.ts) — never refused, never run */
    const recipients = recipientsOf(room.id, p.to, actor);
    const target = seats.find((s) => s.id === p.to[0])?.handle ?? null;
    const meta = { ...(links.length ? { links } : {}), typed_command: p.word };
    return sendWords(room, { kind: 'chat', body: text, target, meta }, recipients, actor, deps, {
      carried: false,
      envBody: `${text} ${typedMarker(p.word)}`,
      named: p.to,
    });
  }
  if (p.type === 'room' && links.length) {
    return refusal(room.id, text, 'links go with a message, not a room command', 'send the command on its own, then the links');
  }

  if (p.type === 'room') {
    if (p.verb === 'help') {
      /* [basic] the Basic room's own commands PLUS the agent's (the registry), each one line */
      return isBasic()
        ? { status: 'applied', entries: [], client: { action: 'help', data: basicRoomCommands(), agent: agentCommands() } }
        : { status: 'applied', entries: [], client: { action: 'help', data: ROOM_COMMANDS } };
    }
    if (p.verb === 'wake') {
      return wakeCommand(room, p, text, actor, deps);
    }
    if (p.verb === 'deliver') {
      return deliverCommand(room, p, text, actor, deps, opts.confirm ?? null);
    }
    /* [room brief] Owner 2026-10-05: a bare /brief SHOWS it, to any member. */
    if (p.verb === 'brief' && p.args.show === true) {
      return room.brief
        ? { status: 'applied', entries: [], client: { action: 'brief', data: { brief: room.brief, by: room.brief_by, at: room.brief_at } } }
        : refusal(room.id, text, 'this room has no brief yet', '/brief <markdown> sets one');
    }
    /* COMMAND AUTHORITY (§2.2, W4): room commands from the user, except
       that the CURRENT lead may hand the lead over and invite (bind-only). */
    const denied = authorityRefusal(room, actor, [p.verb]);
    if (denied) {
      return refusal(room.id, text, denied, 'post it without a / for the lead to raise, or ask the user');
    }
    if (p.verb === 'floor-take' || p.verb === 'floor-skip' || p.verb === 'set-turn') {
      return floorCommand(room, p, text);
    }
    if (p.verb === 'set-store') {
      return storeCommand(room, p, text, actor);
    }
    if (p.verb === 'seat-restart' || p.verb === 'seat-restart-all' || p.verb === 'seat-restart-stop') {
      return restartCommand(room, p, text, actor, deps);
    }
    /* §4.3: /add (it binds the project's live pane, or makes a startable seat)
       and a /replace that names a pane are the user's. */
    if ((p.verb === 'add' || (p.verb === 'replace' && p.args.paneid !== undefined)) && seatBindHumanOnly(actor, deps)) {
      return refusal(room.id, text, HUMAN_ONLY, 'post it without a / and ask the user');
    }
    if (p.verb === 'remove' || p.verb === 'archive' || p.verb === 'dissolve') {
      sweepConfirms();
      const token = opts.confirm ?? null;
      if (token !== null) {
        const c = confirms.get(token);
        if (!c || c.roomId !== room.id || c.text !== text || c.actorKey !== actorKey(actor)) {
          throw new FieldError(400, 'that confirm token is unknown, expired, or for another command — send the command again', 'confirm');
        }
        confirms.delete(token);
      } else if (p.args.confirm !== true) {
        /* Refuse what would be refused anyway BEFORE asking — a confirm that
           then fails is a dialog that lied. */
        if (p.verb === 'remove' && room.lead_seat === (p.target as SeatRef).seatId) {
          return refusal(room.id, text, 'hand the lead over first', `/set lead @<handle>, then /remove @${(p.target as SeatRef).handle}`);
        }
        if (p.verb === 'archive' && room.state === 'archived') {
          return refusal(room.id, text, 'the room is already archived', null);
        }
        if (p.verb === 'dissolve' && room.parent_id === null) {
          return refusal(room.id, text, 'this is a main room, not a workgroup', 'run /dissolve inside a workgroup');
        }
        const t = randomUUID();
        confirms.set(t, { roomId: room.id, text, actorKey: actorKey(actor), expires: Date.now() + CONFIRM_TTL_MS });
        return {
          status: 'confirm',
          entries: [],
          confirm: { token: t, prompt: confirmPrompt(room, p) },
        };
      }
    }
    try {
      const leaving: RoomSeat[] =
        p.verb === 'archive' ? table.listSeats(room.id) : p.verb === 'remove' ? [table.getSeat((p.target as SeatRef).seatId)].filter((x): x is RoomSeat => !!x) : [];
      const entries = execRoom(room, p, text, actor);
      if (leaving.length) {
        /* the command door is synchronous: the outcome lands as a room fact a moment later */
        void releaseWorktrees(room.id, leaving, deps);
      }
      return { status: 'applied', entries };
    } catch (e) {
      if (e instanceof RoomError || e instanceof FieldError) {
        // A valid request that could not be applied: 200, nothing written.
        return refusal(room.id, text, e.message, null);
      }
      throw e;
    }
  }

  /* CHAT or a CARRIED command: written, then delivered to each addressed
     seat's occupant PANE. The liveness of each recipient is decided BEFORE the
     write, so the words and their delivery report land in ONE transaction; the
     push to the pane happens after the commit. */
  const to = p.to;
  const recipients = recipientsOf(room.id, to, actor);
  const carriedTarget =
    p.type === 'carried' ? (to === 'room' ? 'room' : (seats.find((s) => s.id === (to as string[])[0])?.handle ?? null)) : null;
  const reply = original ? { reply: replyRefFor(original, userHandle) } : null;
  const addr: { target: string | null; toUser: string | null; meta: { to_user?: true; reply_inherited?: true }; noLead?: true } | null =
    p.type !== 'chat'
      ? null
      : inherited
        ? { target: userHandle, toUser: userHandle, meta: { to_user: true as const, ...(explicit ? {} : { reply_inherited: true as const }) } } // as if it said @user
        : userAddressed(addrText, parsed, seats, userHandle, toSeat);
  const meta: Record<string, unknown> = { ...(reply ?? {}), ...(links.length ? { links } : {}), ...(addr?.meta ?? {}) };
  if (p.type === 'chat' && actor !== 'user') {
    const toPerson = !!(addr!.toUser || addr!.meta.to_user || addr!.target === 'room' || (reply?.reply.user && addr!.target === null)); // a reply to the person's line that names someone else is a forward, not to the person
    chatterGate(room, actor, text, toPerson, !!opts.ref || links.length > 0, opts.confirm ?? null);
  }
  /* AN AGENT LINE THAT NAMES NOBODY IS TO THE PERSON (Owner [ref], toolkit [ref]): code and
     quotes are already stripped by the parser, so what is left is no @seat, no @user, no @room.
     Delivery is unchanged (it still reaches the lead by default); only the flag is added, so the
     page and the Workbench show it under "To me". Set AFTER the chatter gate on purpose: it must
     not exempt such a line from the agent-to-agent chatter budget. */
  if (p.type === 'chat' && actor !== 'user' && !inherited && !toSeat && !toRoomLine && (!explicit || explicit.author === 'user') && parsed.type === 'chat' && (parsed.leadDefault === true || (Array.isArray(parsed.to) && parsed.to.length === 0 && !parsed.toUser)) && addr && !addr.meta.to_user) {
    meta.to_user = true;
  }
  /* REPLY TURNS [reply turns]: which thread this line joins, and for a seat's post
     whether it may post NOW (a held post throws 409 `held`; nothing is written). */
  const turn = p.type === 'chat' && replyTurns.mode() === 'enforce' ? turnPlan(room, actor, original, namedOf(toSeat, to, p), to === 'room') : null;
  if (turn && turn.thread !== null) {
    meta.thread = turn.thread; // the opener carries none: its thread id is its own id
  }
  const words: LineInput =
    p.type === 'carried'
      ? { kind: 'command', body: text, target: carriedTarget, ...(Object.keys(meta).length ? { meta } : {}) }
      : {
          kind: 'chat',
          body: text,
          target: addr!.target,
          ...(addr!.toUser ? { toUser: addr!.toUser } : {}),
          ...(addr!.noLead ? { noLead: true } : {}),
          ...(typeof opts.ref === 'string' ? { ref: opts.ref } : {}),
          ...(Object.keys(meta).length ? { meta } : {}),
        };
  const named = p.type === 'chat' ? namedOf(toSeat, to, p) : to === 'room' ? [] : Array.isArray(to) ? to : [to];
  try {
    const out = sendWords(room, words, recipients, actor, deps, {
      carried: p.type === 'carried',
      envBody: p.type === 'carried' ? `Please run: ${text}` : text,
      named,
    });
    if (turn && out.entries[0]) {
      turnWritten(room, actor, out.entries[0].id, text, turn, to === 'room', userHandle);
    }
    /* NO ADDRESSEE [nudge] (Owner [ref]): an agent's line that reached no one - it named no seat and not the person, and had no author
       to answer (a reply to a room line) - is not left to go dead in silence: the sender is told, in the answer and by the fabric. */
    if (p.type === 'chat' && actor !== 'user' && out.entries[0] && (toRoomLine || (recipients.length === 0 && !addr?.toUser && !addr?.meta.to_user && to !== 'room'))) {
      const note = noAddresseeNotice(room, actor, out.entries[0].id, toRoomLine);
      if (note) {
        out.notice = note;
      }
    }
    /* NAMED BUT NOT ADDRESSED [item 2]: a reply is addressed by its leading @ list only, so a seat named after prose, or after a
       leading @owner, is text and gets nothing. The sender is told which, in the answer and (live seat) by the fabric. */
    if (p.type === 'chat' && actor !== 'user' && explicit && out.entries[0]) {
      const dropped = droppedAddresses(text, ctx.seats, { userHandle, family: ctx.family })
        .map((id) => seats.find((x) => x.id === id)?.handle)
        .filter((h): h is string => !!h && h !== table.getSeat(actor.seatId)?.handle);
      if (dropped.length) {
        const note = droppedNamesNotice(room, actor, out.entries[0].id, dropped);
        out.notice = out.notice ? `${out.notice} ${note}` : note;
      }
    }
    return out;
  } catch (e) {
    if (e instanceof RoomError && e.field === 'target') {
      return refusal(room.id, text, e.message, null);
    }
    throw e;
  }
}

/* ---------------------------------------------------- the no-addressee nudge ---- */
const lastNudge = new Map<string, number>(); // seat id -> ms
/** Tell a seat its line #N reached no one, and how to fix it: the text goes back in the post's answer and, for a live seat, as a
 *  fabric notice signed as the room. At most one fabric notice per seat per 20 s, so a seat that keeps forgetting is not flooded;
 *  the in-answer notice is always returned. */
function noAddresseeNotice(room: Room, actor: Exclude<RoomActor, 'user'>, lineId: number, replyToRoomLine: boolean): string {
  const why = replyToRoomLine ? 'it replies to a room line (a floor or status fact, which has no author to answer)' : 'nobody was addressed';
  const text = `Your line #${lineId} reached no one: it names no seat and not the person, and ${why}. Add the @ name at the START of the line: send a new line, or reply to #${lineId} with the name first (for example "@user ..." for the person, or "@<seat> ..." for a seat). A name later in the text does not count in a reply.`;
  const seat = table.getSeat(actor.seatId);
  const now = Date.now();
  if (seat && seat.occupant_kind === 'pane' && seat.occupant && now - (lastNudge.get(seat.id) ?? 0) > 20_000) {
    lastNudge.set(seat.id, now);
    void roomFabric.noticeSeat(room, seat, String(seat.occupant), text);
  }
  return text;
}

/** Tell a seat which of the seats it named in a reply were not addressed. Same delivery rules as `noAddresseeNotice`: always in the
 *  post's answer; by the fabric to a live seat at most once per 20 s. */
function droppedNamesNotice(room: Room, actor: Exclude<RoomActor, 'user'>, lineId: number, handles: string[]): string {
  const names = handles.map((h) => `@${h}`).join(', ');
  const text = `Your reply #${lineId} did not reach ${names}: a reply is addressed by its LEADING @ names only, and a name after prose or after a leading @user is just text. Put every @ name you want to reach at the START of the line (for example "@user ${names} ..."), or send a new line.`;
  const seat = table.getSeat(actor.seatId);
  const now = Date.now();
  if (seat && seat.occupant_kind === 'pane' && seat.occupant && now - (lastNudge.get(seat.id) ?? 0) > 20_000) {
    lastNudge.set(seat.id, now);
    void roomFabric.noticeSeat(room, seat, String(seat.occupant), text);
  }
  return text;
}


/* ------------------------------------------------------------ reply turns ---- */
/* REPLY TURNS AND THREADS [reply turns] (the design notes; the rules are
 * the pure engine/reply-turns.ts). Off unless HARBOR_WB_REPLY_TURNS=enforce, and
 * inert in Basic. Here: the table and pane facts the state machine needs, and
 * applying what it decides (a room fact + a turn line typed to the seat). */

/** A room's own turn time (`/set turn <minutes>`), kept as one engine setting: { roomId: ms }. */
function roomTurnMs(roomId: string): number | null {
  const m = table.getEngineSetting('roomTurnMs') as Record<string, unknown> | null;
  const v = m?.[roomId];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** `/floor take`, `/floor skip @seat` and `/set turn <minutes|default>`: the person's floor controls. The
 *  authority check ran before this (user only); a skip is the sweep's own path with the reason "the user". */
function floorCommand(room: Room, p: Extract<ParseResult, { type: 'room' }>, text: string): LineResponse {
  if (replyTurns.mode() !== 'enforce') {
    return refusal(room.id, text, 'reply turns are off here, so there is no floor to take', null);
  }
  if (p.verb === 'set-turn') {
    const minutes = p.args.minutes as number | null;
    const m = { ...((table.getEngineSetting('roomTurnMs') as Record<string, number> | null) ?? {}) };
    if (minutes === null) {
      delete m[room.id];
    } else {
      m[room.id] = minutes * 60_000;
    }
    table.setEngineSetting('roomTurnMs', m);
    const body = minutes === null ? 'turn time for this room: default' : `turn time for this room: ${minutes} min`;
    const entries = table.appendLine(room.id, { kind: 'fact', body, meta: { turnTime: { minutes } } } as any, { actor: 'user' }).result;
    return { status: 'applied', entries };
  }
  const r =
    p.verb === 'floor-take'
      ? replyTurns.turns.takeFloor(room.id, turnsCtx())
      : replyTurns.turns.skipSeat(room.id, (p.target as SeatRef).seatId, turnsCtx());
  if (!r.skipped) {
    return refusal(room.id, text, p.verb === 'floor-take' ? 'nobody holds the floor in this room' : `@${(p.target as SeatRef).handle} holds no turn here`, null);
  }
  applyTurnEffects(r.effects);
  return { status: 'applied', entries: [] };
}

function turnsCtx(): replyTurns.TurnsCtx {
  return {
    now: Date.now(),
    isLive: (seatId) => {
      const s = table.getSeat(seatId);
      return !!s && s.left_at === null && s.occupant_kind === 'pane' && isLive(s.occupant);
    },
    handle: (seatId) => table.getSeat(seatId)?.handle ?? seatId,
    turnMsFor: (roomId) => roomTurnMs(roomId),
    blockedReason: (seatId) => {
      const s = table.getSeat(seatId);
      return s && s.occupant_kind === 'pane' && s.occupant ? (activity.blockedOf(s.occupant)?.reason ?? null) : null;
    },
    lastActive: (seatId) => {
      const s = table.getSeat(seatId);
      return s && s.occupant_kind === 'pane' && s.occupant ? (activity.lastActiveAt(s.occupant) ?? null) : null;
    },
  };
}

/** A stored line's thread (reply-turns.ts threadOfMeta: meta.thread, else the thread a turn fact is about,
 *  else its own id). */
function threadOfEntry(e: RoomLineEntry): number {
  return replyTurns.threadOfMeta(e.meta, e.id);
}

let turnsLog: (line: string) => void = () => {};

/** Write the room fact for each effect and hand the turn line to a new floor-
 *  holder: the room door (pane envelope; typed only where a room line is typed)
 *  AND the fabric, signed as the room, which is what reaches a seat with a live
 *  channel (room-fabric turnLine). Never throws: a turn that cannot be announced
 *  must not lose a post. */
function applyTurnEffects(effects: replyTurns.TurnEffect[]): void {
  for (const e of effects) {
    try {
      const room = table.getRoom(e.roomId);
      if (!room || room.state !== 'open') {
        continue;
      }
      const handle = (id: string): string => table.getSeat(id)?.handle ?? id;
      /* `closed` (toolkit [ref]): the thread's queue emptied. A hidden fact for clients
         (briefing-table's line skips it; the Workbench folds closed floor lines on it). */
      const meta =
        e.type === 'closed'
          ? { turn: { thread: e.thread, kind: 'closed' }, hidden: true }
          : { turn: { thread: e.thread, seat: e.seat, lines: e.sources, kind: e.type === 'floor' ? 'floor' : e.why } };
      const fact = table.appendLine(room.id, { kind: 'fact', body: replyTurns.factText(e, handle), meta } as any, { actor: 'user' }).result[0];
      if (e.type === 'floor' && fact) {
        const seat = table.getSeat(e.seat);
        if (seat && seat.left_at === null && seat.occupant_kind === 'pane' && isLive(seat.occupant)) {
          const line = replyTurns.turnLineText(e); // carries the grant: the seat's two copies only, never the fact, never a log
          deliverToSeat(room, seat, fact, line);
          roomFabric.turnLine(room, fact, seat, line);
        }
      }
    } catch (err) {
      turnsLog(`reply turns: could not announce a ${e.type} in ${e.roomId}: ${(err as Error)?.message ?? err}`);
    }
  }
}

/** Before a chat line is written: its thread, and for a seat's post the hold. */
function turnPlan(room: Room, actor: RoomActor, original: RoomLineEntry | null, named: string[], toRoom: boolean): { thread: number | null; refs: string[] } {
  const author = actor === 'user' ? 'user' : actor.seatId;
  const refs = named.filter((id) => id !== author);
  const parentThread = original ? threadOfEntry(original) : null;
  const thread = replyTurns.turns.threadFor({ roomId: room.id, author, parentThread, references: refs, toRoom });
  if (actor !== 'user') {
    const d = replyTurns.turns.decidePost(actor.seatId, thread, turnsCtx());
    applyTurnEffects(d.effects);
    if (d.held) {
      const who = d.behind ? `@${d.behind}` : 'another seat';
      const why = d.answered
        ? replyTurns.answeredText(d.answered)
        : d.stale
          ? 'newer lines landed in this thread since the one you are answering. Do not retry; your turn line follows with them.'
          : `${who} has the floor in this thread. Do not retry; wait for your turn line.`;
      throw new AgentError(409, 'held', `NOT POSTED: ${why}`, {
        status: 'held',
        thread: d.thread,
        ...(d.behind ? { behind: `@${d.behind}` } : {}),
        ...(d.answered ? { answered: d.answered.map((l) => ({ id: l.id, who: l.who, excerpt: l.excerpt })) } : {}),
      });
    }
  }
  return { thread, refs };
}

/** After a chat line is written: places for the seats it references; a seat's
 *  post resolves its own place. */
function turnWritten(room: Room, actor: RoomActor, id: number, text: string, turn: { thread: number | null; refs: string[] }, toRoom: boolean, userHandle: string): void {
  try {
    const author = actor === 'user' ? 'user' : actor.seatId;
    const who = actor === 'user' ? `@${userHandle}` : `@${table.getSeat(actor.seatId)?.handle ?? '?'}`;
    applyTurnEffects(replyTurns.turns.onLine({ id, roomId: room.id, author, who, body: text, references: turn.refs, toRoom }, turn.thread, turnsCtx()));
  } catch (err) {
    turnsLog(`reply turns: line #${id} not registered: ${(err as Error)?.message ?? err}`);
  }
}

/** POST /api/rooms/:id/lines/:line/claim {from, grant?, pass?} (both doors). The
 *  seat comes from the credential's pane, never the body. */
function claimTurn(room: Room, lineRaw: string, actor: RoomActor, b: Record<string, unknown>): Record<string, unknown> {
  if (replyTurns.mode() !== 'enforce') {
    throw new AgentError(409, 'no_turns', 'reply turns are off in this engine: post as usual');
  }
  if (actor === 'user') {
    throw new AgentError(409, 'no_turns', 'a claim is a seat\'s: send from:{paneid}');
  }
  const id = Number(lineRaw);
  let entry: RoomLineEntry | null = null;
  try {
    entry = Number.isInteger(id) && id > 0 ? replyEntry(room, id) : null;
  } catch {
    entry = null;
  }
  if (!entry) {
    throw new AgentError(409, 'no_turns', `#${lineRaw} is not a line of this room`);
  }
  const grant = typeof b.grant === 'string' && b.grant ? b.grant : null;
  const r = replyTurns.turns.claim(actor.seatId, room.id, threadOfEntry(entry), { grant, pass: b.pass === true }, turnsCtx());
  applyTurnEffects(r.effects);
  if (!r.ok) {
    throw new AgentError(409, r.error, r.message);
  }
  const { effects: _effects, ...rest } = r;
  return { ...rest, ...('behind' in rest && rest.behind ? { behind: `@${rest.behind}` } : {}) };
}

/** `my_turns` for a seat (enforce mode only; absent otherwise). */
function myTurnsOf(seat: RoomSeat): Array<Record<string, unknown>> {
  return replyTurns.turns.myTurns(seat.id, turnsCtx()).map((t) => ({ ...t, ...(t.behind ? { behind: `@${t.behind}` } : {}) }));
}

/* ------------------------------------------------------------- concierge ---- */
/** The Concierge's room view (the design notes P0 read scope): every open
 *  room with its family, roster, lead, brief, apps, the person's unread count and
 *  held lines per seat. No line content, no drafts, no credentials. */
export async function conciergeRooms(projector: () => Promise<(row: any) => any>): Promise<Array<Record<string, unknown>>> {
  const project = await projector();
  const unread = table.unreadByRoom(pictureOwner(null).key);
  return table
    .listRooms()
    .filter((r) => r.state === 'open')
    .map((room) => {
      const seats = table.listSeats(room.id).map((s) => {
        const d = deriveSeat(s, project, room);
        const occ = d.occupant as { id?: string; state?: string; activity?: string; held?: roomTyper.Held; title?: string } | null;
        return {
          handle: s.handle,
          lead: room.lead_seat === s.id,
          status: d.status,
          vendor: d.vendor ?? null,
          occupant: occ ? { paneid: occ.id ?? null, state: occ.state ?? null, activity: occ.activity ?? null, title: occ.title ?? null } : null,
          held: occ?.held ? { depth: occ.held.depth, reason: occ.held.reason, since: occ.held.since } : null,
        };
      });
      return {
        id: room.id,
        name: room.name,
        family: familyView(room),
        lead: seats.find((x) => x.lead)?.handle ?? null,
        brief: room.brief ?? null,
        apps: table.listRoomApps(room.id).map((a) => ({ slug: a.slug })),
        unread: unread[room.id] ?? 0,
        seats,
      };
    });
}

/** The engine's sweep (index.ts, every few seconds): lapses, skips, floors. */
export function sweepReplyTurns(log: (line: string) => void): void {
  turnsLog = log;
  if (replyTurns.mode() !== 'enforce') {
    return;
  }
  applyTurnEffects(replyTurns.turns.sweep(turnsCtx()));
}

/**
 * CHATTER RULES at the line door [chatter p2] (Owner 2026-10-06: firm rules the
 * ENGINE enforces, not instructions an agent may ignore). Agent seats only; the
 * person is never held. Throws (4xx, AgentError) to refuse; returns to pass.
 *   1. ACK-ONLY: an acknowledgement is not a room line (422 ack_only); it is
 *      fabric_ack, which costs nobody a turn. An attachment or link is content.
 *   2. LEAD ECHO: the room's lead re-telling the person what another seat told
 *      them in the last 15 minutes (echo similarity) is held (409 lead_echo,
 *      naming the earlier line). The lead may resend with the answer's confirm
 *      token; a used confirm is counted.
 * Each refusal and confirm is a chatter_events row the report counts.
 */
function chatterGate(room: Room, actor: { seatId: string }, text: string, toPerson: boolean, carries: boolean, confirm: string | null): void {
  const seat = table.getSeat(actor.seatId);
  const comms = agentComms();
  const note = (kind: 'ack_only' | 'lead_echo' | 'lead_echo_confirmed' | 'watch_ack_only' | 'watch_lead_echo', ref: string | null): void => {
    try {
      table.recordChatterEvent({
        ts: Date.now(),
        kind,
        paneid: seat?.occupant_kind === 'pane' ? (seat.occupant ?? null) : null,
        slug: seat?.handle ?? actor.seatId,
        from_slug: null,
        env_id: ref,
      });
    } catch {
      /* a report row lost is better than a line lost */
    }
  };
  /* [agent comms] each rule: 'off' not evaluated; 'watch' recorded, the line passes; 'enforce' refuses */
  if (comms.ackOnly !== 'off' && !carries && chatter.isAckOnly(text)) {
    if (comms.ackOnly === 'watch') {
      note('watch_ack_only', null);
    } else {
      note('ack_only', null);
      throw new AgentError(422, 'ack_only', chatter.ackOnlyMessage());
    }
  }
  if (comms.leadEcho === 'off' || !toPerson || table.getRoom(room.id)?.lead_seat !== actor.seatId) {
    return;
  }
  if (comms.leadEcho === 'watch') {
    const seen = chatter.echoOf(text, table.recentToPersonLines(room.id, Date.now() - chatter.ECHO_WINDOW_MS, actor.seatId));
    if (seen) {
      note('watch_lead_echo', String(seen.id));
    }
    return;
  }
  sweepConfirms();
  if (confirm !== null) {
    const c = confirms.get(confirm);
    if (c && c.kind === 'echo' && c.roomId === room.id && c.text === text && c.actorKey === actorKey(actor)) {
      confirms.delete(confirm);
      note('lead_echo_confirmed', null);
      return;
    }
  }
  const earlier = chatter.echoOf(text, table.recentToPersonLines(room.id, Date.now() - chatter.ECHO_WINDOW_MS, actor.seatId));
  if (!earlier) {
    return;
  }
  note('lead_echo', String(earlier.id));
  const token = randomUUID();
  confirms.set(token, { kind: 'echo', roomId: room.id, text, actorKey: actorKey(actor), expires: Date.now() + ECHO_CONFIRM_TTL_MS });
  throw new AgentError(
    409,
    'lead_echo',
    `held: this repeats what @${earlier.author} already told the person in line ${earlier.id}; they have it. ` +
      `If yours adds something they need, post only that; to post this anyway, send it again with confirm: "${token}".`,
    { line: earlier.id, confirm: token },
  );
}

/* ---- REFERENCES [scratch seen] (UI 5870). The syntax the composer inserts:
     [asset: <file name>]          a file of THIS room's assets, by its stored name
     [note: <id>]                  a room note by its 12-hex id; anything after the id
                                   (e.g. "[note: <note-id> · @owner, 8m ago]") is a label
   An agent cannot open a room asset or note from the words alone, so its copy gets one
   line per reference: the asset's agent-share URL and path, the note's text (flattened,
   cut to NOTE_REF_MAX). At most REFS_MAX. ---- */
const REFS_MAX = 10;
const NOTE_REF_MAX = 800;
export function referencesIn(text: string): { assets: string[]; notes: string[] } {
  const out = { assets: [] as string[], notes: [] as string[] };
  for (const [tag, list] of [['[asset: ', out.assets], ['[note: ', out.notes]] as const) {
    let at = text.indexOf(tag);
    while (at >= 0 && list.length < REFS_MAX) {
      const end = text.indexOf(']', at + tag.length);
      if (end < 0) break;
      const inner = text.slice(at + tag.length, end).trim();
      const value = tag === '[note: ' ? inner.split(' ')[0] : inner;
      if (value && !list.includes(value)) list.push(value);
      at = text.indexOf(tag, end);
    }
  }
  return out;
}
/** Compact refs (`asset_<12hex>`, `note_<12hex>`, `line_<n>`; [ref]) anywhere in a line, at most REFS_MAX, in order, unique. */
export function compactRefsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])(?:(?:asset|note)_[0-9a-f]{12}|line_[0-9]{1,12})(?![A-Za-z0-9_])/g)) {
    if (!out.includes(m[0]) && out.length < REFS_MAX) {
      out.push(m[0]);
    }
  }
  return out;
}
function referencesFor(room: Room, text: string): string {
  const r = referencesIn(text);
  const compact = compactRefsIn(text);
  if (!r.assets.length && !r.notes.length && !compact.length) return '';
  const NL = String.fromCharCode(10);
  const lines: string[] = [];
  const folder = table.roomAssetFolder(room.id);
  for (const name of r.assets) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes(String.fromCharCode(92))) continue;
    const path = `${folder}/${name}`;
    const url = share.shareConfigured() ? `${share.refUrl(path)} ` : ''; // no store set up: the path alone, never a throw while delivering a line
    lines.push(`[asset: ${name}] ${url}(agent-share path ${path})`);
  }
  for (const id of r.notes) {
    const n = NOTE_ID.test(id) ? table.familyRoomIds(room.id).map((rid) => table.getRoomNote(rid, id)).find(Boolean) : undefined;
    if (!n) {
      lines.push(`[note: ${id}] (no such note in this room)`);
      continue;
    }
    const flat = n.text.split(NL).map((l) => l.trim()).filter(Boolean).join(' / ');
    lines.push(`[note: ${id}] ${flat.length > NOTE_REF_MAX ? `${flat.slice(0, NOTE_REF_MAX - 1)}…` : flat}`);
  }
  /* COMPACT refs: the ROW check shared with the index and the resolver (engine/refs.ts), so the name no longer decides which room's file is meant. Delivery is synchronous, so the
     bytes are not stat'ed here; the resolver and the index do that. A missing or foreign ref says so, never a silent stub. */
  const scope = new Set(table.familyRoomIds(room.id));
  for (const ref of compact) {
    const row = refsMod.refRow(ref, scope);
    if (row.state === 'missing') {
      lines.push(`[${ref}] (no such item in this room)`);
    } else if (row.state === 'refused') {
      lines.push(`[${ref}] (not in this room's family: refused)`);
    } else if (row.kind === 'asset') {
      const path = row.rec.path;
      const url = share.shareConfigured() ? `${share.refUrl(path)} ` : '';
      lines.push(`[${ref}] ${row.rec.name} ${url}(agent-share path ${path})`);
    } else if (row.kind === 'note') {
      const flat = row.note.text.split(NL).map((l) => l.trim()).filter(Boolean).join(' / ');
      lines.push(`[${ref}] ${flat.length > NOTE_REF_MAX ? `${flat.slice(0, NOTE_REF_MAX - 1)}…` : flat}`);
    } else {
      lines.push(`[${ref}] (line ${ref.slice(5)} of room ${row.roomId})`);
    }
  }
  return lines.length ? `${NL}References:${NL}${lines.join(NL)}` : '';
}

const QUOTE_RULE = '(To mention a seat without pinging it, put its handle in backticks.)';
const PASSING_NOTE = '(You are named inside a sentence: if it asks something of you, answer; otherwise no reply is owed.)';

/** Who a chat line names: whether it names anyone, and which seats only inside a sentence. */
function namingOf(room: Room, text: string): { any: boolean; inPassing: Set<string> } {
  const ctx = parseContext(room);
  const opts = { family: ctx.family };
  return { any: namesAnyone(text, ctx.all, opts), inPassing: new Set(namedInPassing(text, ctx.all, opts)) };
}

/**
 * Write one line entry — chat or a carried command — plus a delivery report
 * for each recipient that is not live, in ONE transaction; then push it to
 * each recipient's pane and fan it out to the room's fabric thread. The line
 * door (postLine) and the assemble opening message (§4.2 `conventions`) share
 * it, so the opening message is delivered exactly like any other user line.
 */
function sendWords(
  room: Room,
  words: LineInput,
  recipients: RoomSeat[],
  actor: RoomActor,
  deps: RoomRouteDeps,
  opts: { carried: boolean; envBody: string; named: string[]; fabricBody?: string; trailer?: string },
): LineResponse {
  const reports: LineInput[] = [];
  for (const s of recipients) {
    if (switchHoldOf(s)) {
      /* [assistant switch] held in the switch's journal: never a wake, never "offline" */
      reports.push({
        kind: 'delivery',
        asRoom: true,
        target: s.handle,
        body: `held for @${s.handle}: its assistant is being switched; the line goes to whichever assistant holds the seat next`,
        meta: { paneid: null, delivered: false, reason: 'switching', seat: s.id },
      });
      continue;
    }
    const live = s.occupant_kind === 'pane' && isLive(s.occupant);
    if (opts.carried) {
      reports.push({
        kind: 'delivery',
        asRoom: true,
        target: s.handle,
        body: live ? `delivered to @${s.handle}` : notLiveBody(s, actor, deps),
        meta: { paneid: live ? s.occupant : null, delivered: live, ...(live ? {} : notLiveMeta(s)) },
      });
    } else if (!live) {
      reports.push({
        kind: 'delivery',
        asRoom: true,
        target: s.handle,
        body: notLiveBody(s, actor, deps),
        meta: { paneid: null, delivered: false, ...notLiveMeta(s) },
      });
    }
  }
  /* A ROOM SHOWS EVERY LINE WRITTEN IN IT, PLUS EVERY LINE DELIVERED TO A SEAT IN
     IT (Owner 2026-10-04, KB design-notes-id §10.4). The line is ONE row in the
     room it was written in (the user is transient: the room they typed in; an
     agent: its own seat's room); recipients that sit in another room of the
     family get it shown THERE too (incoming), and members of the author's room
     who were not addressed do not get it at all. `xlocal` = how many recipients
     sat in the author's own room, so 0 reads as outgoing-only there. */
  const away = new Map<string, string[]>();
  for (const s of recipients) {
    if (s.room_id !== room.id) {
      (away.get(s.room_id) ?? away.set(s.room_id, []).get(s.room_id)!).push(s.handle);
    }
  }
  const crossed: LineInput = away.size
    ? {
        ...words,
        xposts: [...away].map(([room_id, handles]) => ({ room_id, handles })),
        meta: {
          ...(words.meta ?? {}),
          xlocal: recipients.filter((s) => s.room_id === room.id).length + (words.meta?.to_user ? 1 : 0),
        },
      }
    : words;
  const written = table.appendLine(room.id, [crossed, ...reports], { actor }).entries;
  const entry = written[0];
  /* The user answering in chat has seen the voice reply: clear voice "waiting"
     (room-voice §7), which otherwise clears only by voice. */
  if (actor === 'user') roomVoice.setWaiting(room.id, false);
  /* A REPLY (engine/room-reply.ts): both agent copies — the typed one and the
     fabric channel's — start with the same prefix line, framed once here. */
  const reply = replyOf(words.meta ?? null);
  /* LINKS (engine/tool-links.ts): one trailing line on both copies, after the
     words — framed once here, like the reply prefix. */
  const links = linksOf(words.meta ?? null);
  const envBody = withTrailer(withLinks(withReply(opts.envBody, reply), links), opts.trailer);
  const fabricBase = reply || links.length ? withLinks(withReply(opts.fabricBody ?? words.body ?? '', reply), links) : opts.fabricBody;
  /* A TRAILER (a via-app line's data block, ticket): last on both copies,
     after the links — framed once here, like the reply prefix and the links. */
  const fabricBody = opts.trailer ? withTrailer(fabricBase ?? words.body ?? '', opts.trailer) : fabricBase;
  /* REFERENCES [scratch seen] (UI 5870): `[asset: <name>]` / `[note: <id> …]` in the
     line are resolved for the AGENT copies (typed and fabric), never the stored line. */
  const refs = referencesFor(room, words.body ?? '');
  /* [passing ping] A line that @-names anyone carries the quoting rule on both agent copies
     (so no agent has to remember it), and a seat named only inside a sentence is told its
     copy owes no reply. Chat lines only; a line naming nobody gets neither (no extra tokens). */
  const names = words.kind === 'chat' ? namingOf(room, words.body ?? '') : null;
  const withRule = (b: string | undefined): string | undefined => (names?.any && b !== undefined ? `${b}\n${QUOTE_RULE}` : b);
  const agentBody0 = withRule(refs ? `${envBody}${refs}` : envBody) as string;
  const agentFabric = withRule(refs ? `${fabricBody ?? words.body ?? ''}${refs}` : fabricBody);
  const passingBody = `${agentBody0}\n${PASSING_NOTE}`;
  const bodyFor = (s: RoomSeat): string => (names?.inPassing.has(s.id) ? passingBody : agentBody0);
  const deliveries = recipients.map((s) => deliverToSeat(room, s, entry, bodyFor(s)));
  /* [agent rest] a level-1 resting recipient is being woken (restingNote): its copy is
     delivered once it is back, never dropped. */
  recipients.forEach((s, i) => {
    const d = deliveries[i];
    if (!d.delivered && !d.queued) {
      afterWake.get(s.id)?.push({ room, entry, body: bodyFor(s) });
    }
  });
  /* F4 (room-fabric.ts): the durable copy on the room's fabric thread, IN
     ADDITION to the delivery above — fire-and-forget, a no-op with the flag
     off or the fabric down. A seat the line @-named gets it as an 'ask'. */
  roomFabric.fanOut(room, entry, recipients, names ? opts.named.filter((id) => !names.inPassing.has(id)) : opts.named, agentFabric);
  const reached = deliveries.filter((d) => d.paneid !== null && (d.delivered || d.queued)).length;
  const typedN = deliveries.filter((d) => d.typed === 'injected').length;
  const heldN = deliveries.filter((d) => d.typed === 'queued').length;
  deps.log(
    `room ${room.id}: ${entry.kind} #${entry.id} by ${entry.author} → ${reached}/${recipients.length} pane(s)` +
      ` typed ${typedN} held ${heldN}`,
  );
  return {
    status: reached ? 'delivered' : 'posted',
    entries: written.map((e) => {
      const { xposts, ...plain } = e;
      const xp = xposts?.length ? table.xpostView(e, room.id) : null;
      return xp ? { ...withReads(plain), xpost: xp } : withReads(plain);
    }),
    deliveries,
  };
}

/** The delivery report of a recipient that is not live. A RESTING (dehydrated)
 *  seat adds what the sender should do about it (idle-rest wake rules or the
 *  offline notice); anything else keeps the plain wording. */
function notLiveBody(s: RoomSeat, actor: RoomActor, deps: RoomRouteDeps): string {
  const base = `${NOT_LIVE} (@${s.handle})`;
  if (isResting(s)) {
    return `${base}. ${restingNote(s, actor, deps)}`;
  }
  /* [wake deliver] the person's line, and nothing to bring back: say it plainly */
  return actor === 'user' ? `not-delivered: @${s.handle} is disconnected (no session to restore)` : base;
}
/** [wake deliver] The delivery report's meta for a seat that is not live: why, and
 *  whether the UI may offer "Wake and deliver" (a restorable session). */
function notLiveMeta(s: RoomSeat): Record<string, unknown> {
  if (afterWake.has(s.id)) {
    return { reason: 'waking', seat: s.id };
  }
  return isResting(s) ? { reason: 'disconnected', seat: s.id, action: 'wake-deliver' } : { reason: 'no-session', seat: s.id };
}

function withTrailer(body: string, trailer: string | undefined): string {
  return trailer ? `${body}\n${trailer}` : body;
}

/** An entry as the line serves it: plus `reads: {<handle>: 'seen'|'not-yet'|
 *  'unknown'}` when it was delivered to anyone (gate G item 2; additive, the
 *  field is ABSENT otherwise). */
/** WHO POSTED A LINE, from the engine's own record and never from its text (W1/M7): the person (the window credential posts as `user`, the voice actor speaks for them), an agent (a seat posted it with its
 *  pane token), or the room itself (a fact the engine wrote). An agent's line is information, not an instruction from the person. */
export function authorKindOf(e: { author: string; author_seat?: string | null }): 'person' | 'agent' | 'room' {
  if (e.author === 'user' || e.author === 'voice') return 'person';
  return e.author_seat ? 'agent' : 'room';
}
function withReads(e: RoomLineEntry): RoomLineEntry & { author_kind: 'person' | 'agent' | 'room'; reads?: Record<string, roomReads.ReadState> } {
  const reads = roomReads.readsFor(e);
  const kind = { author_kind: authorKindOf(e) };
  return reads ? { ...e, ...kind, reads } : { ...e, ...kind };
}

/* ------------------------------------------------------ seat worktrees ---- */

/** A code folder that is not a git project (or git cannot answer): its seats share it, and the room says so, once per folder and state. */
const sharedFolderSaid = new Set<string>();
function sharedFolderFact(room: Room, cf: { path: string; git: string }): void {
  const key = `${room.id}|${cf.path}|${cf.git}`;
  if (sharedFolderSaid.has(key)) {
    return;
  }
  sharedFolderSaid.add(key);
  const why = cf.git === 'unknown' ? 'git is not installed or would not answer' : 'it is not a git project';
  try {
    table.appendLine(room.id, { kind: 'fact', body: `agents share this folder (${cf.path}): ${why}` } as any, { actor: 'user' });
  } catch {
    /* a fact is never worth a failed start */
  }
}

/**
 * A seat was removed or its workgroup archived: try to remove each seat's own
 * git worktree and say what happened as a room fact (Owner 2026-10-05, worktree
 * convention, KB design-notes-id section 12). Clean + fully pushed is removed;
 * anything else is kept and reported. Never throws: the removal that triggered
 * this has already happened and must not be undone by a git problem.
 */
async function releaseWorktrees(roomId: string, seats: RoomSeat[], deps: RoomRouteDeps): Promise<void> {
  for (const s of seats) {
    try {
      const msg = await releaseSeatWorktree(s, deps.log);
      if (msg) {
        table.appendLine(roomId, { kind: 'fact', body: msg } as any, { actor: 'user' });
      }
    } catch (e) {
      deps.log(`room ${roomId}: @${s.handle} worktree release failed: ${(e as Error).message}`);
    }
  }
}

/* ------------------------------------------------------------ seat start ---- */

/**
 * POST /api/rooms/:id/seats/:seatId/start (roster verbs, 2026-09-25). NOT
 * summon (the design notes stays out): a human — or the room's lead — asking
 * for the seat's OWN recipe to be started. Authority is exactly /add's.
 *
 * Persistent seat with a dehydrated occupant of its recipe → REHYDRATE that
 * pane (the attach restores it with --resume). Otherwise a FRESH pane (the
 * launch route's `fresh:true`: a new handle, never the project's primary pane,
 * which may be live elsewhere or belong to another seat). `fresh:true` in the
 * body forces the second on a persistent seat. The launch itself is
 * launchRecipe — the SAME path POST /api/recipes/:id/launch runs, spawn permit
 * included; the seat is bound inside it, before placement, in one store
 * transaction (history 'replaced' when an occupant is replaced; fact
 * "@<handle> started by <actor>").
 *
 * PER-START CHOICES (2026-09-28, the + sheet's START FROM A PROJECT row):
 * `model` / `effort` beat the recipe's for THIS launch only (never written to
 * the recipe) and ride to launchRecipe verbatim; `resumeSessionId` starts the
 * seat on a PAST conversation instead of a fresh one, through the launch
 * route's picker-resume door with exactly the body the manager's Resume picker
 * sends (`{resumeSessionId}`), so the same pane rules apply (a pane already
 * banking that uuid is reused; a live primary is never written over).
 */
/* FOLDER TRUST (E3), local mode: a Claude seat on THIS machine is about to launch in a folder; if the person has not turned it off, mark it
   trusted in their .claude.json (folder-trust.ts) so the "No, exit" default cannot end the pane. Written right before the launch and read
   back; the room says so only after the read-back, and a failure is a fact, never a blocked start (the CLI-prompt detector is the net). */
const FOLDER_TRUST_KEY = 'folderTrust.auto';
function folderTrustOn(): boolean {
  return process.env.HARBOR_WB_FOLDER_TRUST !== '0' && table.getEngineSetting(FOLDER_TRUST_KEY) !== false;
}
function preTrustFolder(room: Room, seat: RoomSeat, recipe: Recipe, wt: { project: string; name: string } | null, log: (line: string) => void): void {
  try {
    const hosted = process.env.HARBOR_WB_HOSTED === '1';
    if (!(isLocalMode(process.env) || hosted) || recipe.vendor !== 'claude-code' || !folderTrustOn()) {
      return;
    }
    const target = loadTargets().find((t) => t.id === recipe.target);
    if (!target || target.kind !== 'local' || !isSelfHosted(target)) {
      return; // another machine's disk is not ours to write
    }
    const dir = wt ? worktreePath(wt.project, wt.name) : recipe.projectDir;
    if (!dir) {
      return;
    }
    /* HOSTED (security review H3): a folder is trusted only if the person put it on the trust list (settings-routes); the default is no trust, and Claude asks for itself. */
    if (hosted && !isFolderTrusted(dir)) {
      return;
    }
    const r = trustFolder(dir, realTrustIo, claudeJsonPath());
    if (r.state === 'trusted' && !r.changed) {
      return; // already trusted: nothing written, nothing to say
    }
    const body =
      r.state === 'trusted'
        ? `@${seat.handle}'s folder is trusted (${dir})`
        : `@${seat.handle}'s folder could not be trusted automatically (${r.reason}); Claude may ask`;
    table.appendLine(room.id, { kind: 'fact', body } as any, { actor: 'user' });
    log(`folder trust: @${seat.handle} ${r.state} ${dir}`);
  } catch (e) {
    log(`folder trust failed for @${seat.handle}: ${(e as Error).message}`); // never blocks a start
  }
}

async function startSeat(
  room: Room,
  seat: RoomSeat,
  b: Record<string, any>,
  deps: RoomRouteDeps,
  /** A wake the ENGINE decided under the idle-rest settings (wakeSeat): the
   *  authority was already checked against those settings, so the HTTP door's
   *  `from` / human-only checks do not apply. */
  decided?: RoomActor,
): Promise<Record<string, unknown>> {
  const actor = decided ?? httpActor(room, b.from, ['add'], deps);
  if (!decided) {
    requireSeatBinder(actor, deps);
  }
  if (b.target !== undefined && b.target !== null && b.target !== 'tab' && b.target !== 'window') {
    throw new FieldError(400, "target is 'tab' or 'window'", 'target');
  }
  if (b.surface !== undefined && b.surface !== null && typeof b.surface !== 'string') {
    throw new FieldError(400, 'surface is a string (the launch route\'s, e.g. "browser")', 'surface');
  }
  if (b.fresh !== undefined && b.fresh !== null && typeof b.fresh !== 'boolean') {
    throw new FieldError(400, 'fresh is a boolean', 'fresh');
  }
  if (b.model !== undefined && b.model !== null && b.model !== '' && (typeof b.model !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(b.model))) {
    throw new FieldError(400, 'model is a model name (letters, digits, . _ -)', 'model');
  }
  const resumeId = b.resumeSessionId;
  if (resumeId !== undefined && resumeId !== null && (typeof resumeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resumeId))) {
    throw new FieldError(400, 'resumeSessionId is a session uuid', 'resumeSessionId');
  }
  if (resumeId && b.fresh === true) {
    throw new FieldError(400, 'fresh and resumeSessionId are exclusive: a resume is not a new session', 'fresh');
  }
  if (room.state !== 'open') {
    throw new FieldError(409, 'the room is archived — /reopen it first', 'state');
  }
  const memory = memoryVerdict();
  if (memory?.level === 'refuse') {
    throw new FieldError(409, memory.text, 'memory'); // every start door (start, wake, restart, assemble) ends here
  }
  if (seat.policy === 'dispatched' || seat.policy === 'pool') {
    throw new FieldError(409, `a ${seat.policy} seat is filled by dispatch, which is not built yet`, 'policy');
  }
  const recipe = seat.recipe_id ? table.getRecipe(seat.recipe_id) : undefined;
  if (!recipe) {
    throw new FieldError(409, `@${seat.handle} has no project to start`, 'recipe_id');
  }
  /* THE PROGRAM MUST EXIST (fb30s): a local seat is a shell with the vendor line TYPED into it, so a missing `claude` used to show up only as a bare shell prompt. Local mode,
     this machine's own shell only. Nothing is started and the seat stays startable. "Not found" is all this says; the prompt detector remains the backstop. */
  if (isLocalMode(process.env)) {
    const prog = programFor(recipe.vendor);
    const tgt = prog ? loadTargets().find((t) => t.id === recipe.target) : undefined;
    if (prog && tgt && tgt.kind === 'local' && isSelfHosted(tgt) && !tgt.sshClient && !resolveProgram(prog)) {
      throw new FieldError(409, `${vendorDisplayName(recipe.vendor)} isn't installed`, 'vendor', { code: 'vendor-missing', vendor: recipe.vendor });
    }
  }
  if (b.effort !== undefined && b.effort !== null && b.effort !== '' && !isEffortFor(recipe.vendor, b.effort)) {
    throw new FieldError(400, `effort is one of ${effortsFor(recipe.vendor).join(', ')}`, 'effort');
  }
  if (switchHoldOf(seat) && !switchRestoring.has(seat.id)) {
    throw new FieldError(409, `@${seat.handle}'s assistant is being switched; it starts again on its own when the switch ends`, 'seat');
  }
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const row = paneid ? table.get(paneid) : undefined;
  if (row?.state === 'live') {
    throw new FieldError(409, `@${seat.handle} already has a live occupant — open it`, 'seat');
  }
  if (paneid && (!row || row.state === 'dehydrated') && spawnPermits.pending(paneid)) {
    throw new FieldError(409, `@${seat.handle} is already starting — open it`, 'seat');
  }
  if (!deps.launch) {
    throw new Error('seat start: no launcher wired');
  }
  const rehydrate =
    !resumeId && b.fresh !== true && seat.policy === 'persistent' && row?.state === 'dehydrated' && paneOfRecipe(paneid, recipe.id);
  const launchBody: Record<string, unknown> = {
    ...(b.target === 'tab' ? { target: 'tab' } : {}),
    ...(typeof b.surface === 'string' ? { surface: b.surface } : {}),
    ...(resumeId
      ? { resumeSessionId: resumeId }
      : rehydrate
        ? (paneid !== `recipe:${recipe.id}` ? { pane: paneid } : {})
        : { fresh: true }),
    ...(typeof b.model === 'string' && b.model ? { model: b.model } : {}),
    ...(isEffortFor(recipe.vendor, b.effort) ? { effort: b.effort } : {}),
  };
  const mode: 'rehydrate' | 'fresh' = rehydrate || resumeId ? 'rehydrate' : 'fresh';
  /* A FRESH start of a second same-project code seat runs in its own worktree
     (Owner 2026-10-05, worktree convention, KB design-notes-id section 12). A
     rehydrate or a picked past conversation keeps the cwd its transcript was
     written in: the pane's own binding stands. Null = the recipe's dir. */
  const cf = mode === 'fresh' ? await codeFolderView(room.id).catch(() => null) : null;
  const wt = mode === 'fresh' ? await prepareSeatWorktree(recipe, seat, deps.log, cf && cf.git === 'repo' ? { dir: cf.path, family: familySlug(cf.owner) } : null) : null;
  if (cf && cf.git !== 'repo' && CODE_VENDORS.includes(recipe.vendor)) {
    sharedFolderFact(room, cf);
  }
  preTrustFolder(room, seat, recipe, wt, deps.log); // E3: written right before the launch, read back, never blocks it
  let bound: { result: RoomSeat; entries: RoomLineEntry[] } | null = null;
  const answer = await deps
    .launch(recipe.id, launchBody, (launched) => {
      if (wt) {
        table.setSessionWorktree({ paneid: launched, project: wt.project, name: wt.name, branch: wt.branch });
      }
      bound = table.startSeat(room.id, seat.id, launched, { actor, mode });
    })
    .catch((e: { status?: unknown; message?: string }) => {
      /* A launch refused before anything was placed (S0 guard 7's early
         check: 409 with the refusal text) is the caller's answer, not our defect. */
      throw typeof e?.status === 'number' ? new FieldError(e.status, e.message ?? 'refused', 'seat') : e;
    });
  const done = bound as { result: RoomSeat; entries: RoomLineEntry[] } | null;
  if (!done) {
    throw new Error('seat start: the launch never named a pane'); // our defect, never a caller's
  }
  deps.log(`room ${room.id}: @${seat.handle} started (${resumeId ? `resume ${resumeId.slice(0, 8)}` : mode}) → ${answer.paneid} [${answer.placement}]`);
  seatWelcome.welcomeSeat(room, done.result, deps.log); // room welcome, Owner 2026-10-05
  const project = await deps.projector();
  return { ...answer, seat: deriveSeat(done.result, project, table.getRoom(room.id)), entries: done.entries };
}

/** LOCAL MODE Start: spawn the pane the seat was just bound to, in-process, so the app's /term (reattach-only) can join it.
 *  The pane stays parked (alive in the broker, no viewer) exactly like a headless seat start. A spawn that fails is answered
 *  with the plain reason (the broker down, an unknown target, the program missing), never a silent 200 with no pane. */
async function spawnStartedPane(room: Room, seat: RoomSeat, paneid: string, deps: RoomRouteDeps): Promise<void> {
  const drive = await driveToReady(paneid, seat.recipe_id ?? '', {
    socketUrl: deps.socketUrl ?? (() => ''),
    socketToken: deps.socketToken ?? (() => ''),
    needsYou: () => null,
    ready: () => true,
    log: deps.log,
    open: deps.openSelf,
    spawnOnly: true,
  }).catch((e: Error) => ({ ok: false as const, reason: 'spawn-failed' as const, detail: e.message }));
  deps.log(`room ${room.id}: @${seat.handle} start: engine spawn ${drive.ok ? 'ok' : drive.reason}${drive.ok ? '' : ` (${drive.detail ?? ''})`}`);
  if (!drive.ok) {
    throw new FieldError(502, `@${seat.handle} could not start: ${drive.detail || drive.reason}`, 'seat');
  }
}

/* ------------------------------------------------------------ idle rest ---- */
/*
 * IDLE REST AND WAKE (Owner 2026-10-04, item 6; engine rules
 * in engine/idle-rest.ts). Settings are SYSTEM-wide (engine_settings), all off
 * by default. Three doors here:
 *   - idleRestSweep: a periodic sweep (index.ts, every 5 min) that dehydrates
 *     idle seats through disconnectOne, the SAME end-for-cycle the room's
 *     Disconnect uses (the conversation is kept; Restore / a wake brings it
 *     back with the profile's model and effort, as any restore does);
 *   - wakeSeat: a line or `/wake` that the settings allow restores a resting
 *     seat through startSeat, headless (no window opens), like a seat reload;
 *   - the offline notice: what the sender of a line is told when the seat it
 *     addressed is resting and was not woken (sendWords).
 */
export function idleRestSettings(): IdleRestSettings {
  return idleRestFrom(table.getEngineSetting('idleRest'));
}

/** When each pane's current run of detected background work was first seen. A
 *  verdict of "none" or "cannot tell" ends the run (so the cap restarts per run). */
const backgroundSeen = new Map<string, number>();
function noteBackground(paneid: string, now: number): { work: BackgroundWork; since: number } | null {
  const w = vscreen.reading(paneid)?.background ?? null;
  if (!isBusyBackground(w)) {
    backgroundSeen.delete(paneid);
    return null;
  }
  let since = backgroundSeen.get(paneid);
  if (since === undefined) {
    since = now;
    backgroundSeen.set(paneid, since);
  }
  return { work: w as BackgroundWork, since };
}

/** Engine boot time: a seat whose pane has said nothing since boot is idle
 *  since boot, never since "forever" (the activity clock is in memory). */
const BOOT_AT = Date.now();

/** A seat's quiet time, or null when it is working, blocked on the user, has a
 *  draft or an ask pending, is not live, or is not a persistent resumable seat. */
function seatIdleMs(seat: RoomSeat, now: number): { live: boolean; idleMs: number | null } {
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const row = paneid ? table.get(paneid) : undefined;
  if (!paneid || !row || row.state !== 'live') {
    return { live: false, idleMs: null };
  }
  if (seat.policy !== 'persistent' || !isResumableVendor(row.vendor) || spawnPermits.pending(paneid)) {
    return { live: true, idleMs: null };
  }
  if (activity.get(paneid) !== 'idle' || activity.isBusy(paneid) || activity.hasDraft(paneid) || activity.blockedOf(paneid)) {
    return { live: true, idleMs: null };
  }
  return { live: true, idleMs: Math.max(0, now - (activity.lastOutputAt(paneid) ?? BOOT_AT)) };
}

/**
 * One sweep: rest every seat the settings say has been idle long enough.
 * Returns the seats rested (for the log and the tests). Never throws: a failed
 * end is logged and the next sweep tries again.
 */
export async function idleRestSweep(
  endForCycle: NonNullable<RoomRouteDeps['endForCycle']>,
  log: (line: string) => void,
  now: number = Date.now(),
): Promise<Array<{ room: string; handle: string; kind: string; idleMs: number }>> {
  const s = idleRestSettings();
  const rested: Array<{ room: string; handle: string; kind: string; idleMs: number }> = [];
  if (s.memberHours === null && s.leadHours === null) {
    return rested;
  }
  const deps = { endForCycle, log } as unknown as RoomRouteDeps;
  const open = table.listRooms({ state: 'open' });
  const asRest = (seat: RoomSeat, room: Room): RestSeat => ({ id: seat.id, handle: seat.handle, isLead: room.lead_seat === seat.id, ...seatIdleMs(seat, now) });
  for (const room of open) {
    try {
      const seats = table.listSeats(room.id);
      const mine = seats.map((x) => asRest(x, room));
      /* A main room's lead also outlasts its workgroups' seats. */
      const kids = room.parent_id === null ? open.filter((r) => r.parent_id === room.id) : [];
      const others = kids.flatMap((k) => table.listSeats(k.id).map((x) => asRest(x, k)));
      for (const pick of restPlan(mine, s, others)) {
        const seat = seats.find((x) => x.id === pick.seatId)!;
        const r = await disconnectOne(room, seat, deps);
        if (r.result !== 'disconnected') {
          log(`room ${room.id}: @${seat.handle} idle rest: not rested (${String(r.result)} ${String(r.reason ?? r.error ?? '')})`);
          continue;
        }
        clearUserDisconnect(seat);
        log(`room ${room.id}: @${seat.handle} idle rest: ${pick.kind} idle ${spanWords(pick.idleMs)} >= ${spanWords(pick.limitMs)}`);
        rested.push({ room: room.id, handle: seat.handle, kind: pick.kind, idleMs: pick.idleMs });
        try {
          table.appendLine(room.id, { kind: 'fact', body: restFact(seat.handle, pick.idleMs) } as any, { actor: 'user' });
        } catch (e) {
          log(`room ${room.id}: @${seat.handle} idle rest: fact not written: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      log(`room ${room.id}: idle rest sweep failed: ${(e as Error).message}`);
    }
  }
  return rested;
}

/* ------------------------------------------------- level 1: rest ---- */
/*
 * AGENT REST, LEVEL 1 [agent rest] (Owner 2026-10-07, room interface): two
 * global idle levels for ALL agents, nothing per room. Level 1 "Rest" parks ANY live
 * resumable agent pane (a seat, a lead, or an agent in no room) that has been
 * exactly 'idle' for restMinutes, through the same end-for-cycle as Disconnect
 * (filed dehydrated, restorable). It is MARKED (engine_settings agentRest.rested)
 * so it wakes on ANY addressed message: a room line to it from the person or any
 * seat (restingNote), or a fabric DM to its slug (index.ts fabricSendAs). Level 2
 * (memberHours / leadHours, idleRestSweep above) is unchanged.
 */
const RESTED_KEY = 'agentRest.rested';
type RestedMark = { ts: number; slug: string | null };
function restedMarks(): Record<string, RestedMark> {
  const v = table.getEngineSetting(RESTED_KEY);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, RestedMark>) : {};
}
function setRestedMark(paneid: string, mark: RestedMark | null): void {
  const all = restedMarks();
  if (mark) {
    all[paneid] = mark;
  } else if (paneid in all) {
    delete all[paneid];
  } else {
    return;
  }
  table.setEngineSetting(RESTED_KEY, all);
}
function restEvent(kind: 'agent_rested' | 'agent_woken', paneid: string, slug: string | null): void {
  try {
    table.recordChatterEvent({ ts: Date.now(), kind, paneid, slug, from_slug: null, env_id: null });
  } catch {
    /* a report row lost is better than a wake lost */
  }
}
/** Is this pane parked by level 1 (and still parked)? */
export function isRestedLevel1(paneid: string | null | undefined): boolean {
  return !!paneid && !!restedMarks()[paneid] && table.get(paneid)?.state === 'dehydrated';
}
/** The level-1 resting pane a fabric slug names (agent or minted slug), or null. */
export function restedPaneForSlug(slug: string): string | null {
  const marks = restedMarks();
  const row = (table.list() as any[]).find((r) => (r.agent === slug || r.fabric_slug === slug) && marks[r.paneid]);
  return row && isRestedLevel1(row.paneid) ? (row.paneid as string) : null;
}
/** It is back (or was brought back by hand): clear the mark, count the wake. */
export function noteWoken(paneid: string, slug: string | null): void {
  clearUserDisconnect(paneid);
  if (restedMarks()[paneid]) {
    setRestedMark(paneid, null);
    restEvent('agent_woken', paneid, slug);
  }
}

/** A fabric DM to `slug`: if it names a level-1 resting pane, restore it first (the
 *  restore route's own path, injected) and say whether it is back. Never throws. */
export async function wakeRestedForDm(
  slug: string,
  restore: (slug: string) => Promise<{ ok: boolean; paneid?: string; reason?: string }>,
  log: (line: string) => void,
): Promise<boolean> {
  const rested = restedPaneForSlug(slug);
  if (!rested) {
    return false;
  }
  try {
    const a = await restore(slug);
    log(`agent rest: ${slug} was resting: ${a.ok ? `woken (${a.paneid ?? rested})` : `wake failed (${a.reason ?? 'unknown'})`}`);
    if (a.ok) {
      noteWoken(rested, slug);
    }
    return a.ok;
  } catch (e) {
    log(`agent rest: ${slug} was resting: wake failed (${(e as Error).message})`);
    return false;
  }
}

/** One level-1 sweep. Returns the panes rested. Never throws. */
export async function agentRestSweep(
  endForCycle: NonNullable<RoomRouteDeps['endForCycle']>,
  log: (line: string) => void,
  now: number = Date.now(),
): Promise<Array<{ paneid: string; slug: string | null; room: string | null; handle: string | null }>> {
  const out: Array<{ paneid: string; slug: string | null; room: string | null; handle: string | null }> = [];
  try {
    /* a mark whose pane is no longer parked (restored by hand, ended) is dropped */
    for (const [paneid, mark] of Object.entries(restedMarks())) {
      if (table.get(paneid)?.state !== 'dehydrated') {
        noteWoken(paneid, mark.slug); // brought back another way (Restore, the fabric's restore)
      }
    }
    for (const paneid of Object.keys(userDisconnects())) {
      if (table.get(paneid)?.state !== 'dehydrated') {
        clearUserDisconnect(paneid); // it is back (or gone): the person's switch-off no longer applies
      }
    }
    const s = idleRestSettings();
    if (!s.restEnabled) {
      return out;
    }
    const seatOf = new Map<string, { seat: RoomSeat; room: Room }>();
    for (const room of table.listRooms({ state: 'open' })) {
      for (const seat of table.listSeats(room.id)) {
        if (seat.occupant_kind === 'pane' && seat.occupant) {
          seatOf.set(String(seat.occupant), { seat, room });
        }
      }
    }
    for (const row of table.list() as any[]) {
      const paneid = String(row.paneid);
      if (row.state !== 'live' || !row.recipe_id || spawnPermits.pending(paneid)) {
        continue;
      }
      const at = seatOf.get(paneid);
      if (at && at.seat.policy !== 'persistent') {
        continue; // a non-persistent seat ends with its job; it is never parked
      }
      const q = roomTyper.queued(paneid);
      const bg = s.backgroundGuard ? noteBackground(paneid, now) : null;
      const facts = {
        state: activity.get(paneid),
        resumable: isResumableVendor(row.vendor),
        draft: activity.hasDraft(paneid),
        held: q.typed + q.fabric,
        blocked: !!activity.blockedOf(paneid) || activity.isBusy(paneid),
        lastActiveAt: activity.lastActiveAt(paneid) ?? null,
        backgroundGuard: s.backgroundGuard,
        backgroundWork: bg?.work ?? null,
        backgroundSince: bg?.since ?? null,
      };
      if (!mayRest(facts, s.restMinutes, now, BOOT_AT)) {
        continue;
      }
      const who = at ? `@${at.seat.handle} (room ${at.room.id})` : (row.agent ?? paneid);
      try {
        const r = await endForCycle(paneid);
        if (!r.ended) {
          log(`agent rest: ${who} ${paneid} not rested (state ${String(r.state)})`);
          continue;
        }
      } catch (e) {
        log(`agent rest: ${who} ${paneid} not rested: ${(e as Error).message}`);
        continue;
      }
      const slug = (row.agent as string | null) ?? null;
      clearUserDisconnect(paneid);
      setRestedMark(paneid, { ts: now, slug });
      restEvent('agent_rested', paneid, slug);
      log(`agent rest: ${who} ${paneid} idle >= ${s.restMinutes} min: resting (no cost)`);
      if (at) {
        try {
          table.appendLine(at.room.id, { kind: 'fact', body: restedFact(at.seat.handle) } as any, { actor: 'user' });
        } catch (e) {
          log(`agent rest: ${who} fact not written: ${(e as Error).message}`);
        }
      }
      out.push({ paneid, slug, room: at?.room.id ?? null, handle: at?.seat.handle ?? null });
    }
  } catch (e) {
    log(`agent rest sweep failed: ${(e as Error).message}`);
  }
  return out;
}

/* WAITING AT A CLI PROMPT: one room fact each time a seat's pane shows a first-run prompt (or an unrecognised dialog past the deadline).
   Said once per entry (cli-prompt.ts PromptAnnouncer), never per repaint, and never for "cannot tell yet". A pane that is gone is forgotten. */
const promptAnnouncer = new PromptAnnouncer();
const promptWatching = new Set<string>();
/** E1: a seat whose pane was launched with the bt tools but never connected to them says so in the room, ONCE ("@x has no room tools: <why>"). */
export function toolsSweep(log: (line: string) => void): number {
  let said = 0;
  try {
    for (const room of table.listRooms({ state: 'open' })) {
      for (const seat of table.listSeats(room.id)) {
        const paneid = seat.occupant_kind === 'pane' && seat.occupant ? String(seat.occupant) : null;
        if (!paneid || table.get(paneid)?.state !== 'live' || !btTools.shouldSayNone(paneid)) {
          continue;
        }
        table.appendLine(room.id, { kind: 'fact', body: `@${seat.handle} has no room tools: ${btTools.state(paneid).reason ?? 'unknown'}` } as any, { actor: 'user' });
        said++;
      }
    }
  } catch (e) {
    log(`room tools sweep failed: ${(e as Error).message}`);
  }
  return said;
}

export function cliPromptSweep(log: (line: string) => void): number {
  let said = 0;
  try {
    const seen = new Set<string>();
    for (const room of table.listRooms({ state: 'open' })) {
      for (const seat of table.listSeats(room.id)) {
        const paneid = seat.occupant_kind === 'pane' && seat.occupant ? String(seat.occupant) : null;
        if (!paneid || table.get(paneid)?.state !== 'live') {
          continue;
        }
        seen.add(paneid);
        const c = vscreen.cliPromptOf(paneid);
        /* a bare shell is its own sentence ("no agent is running in its terminal"); an agent that IS waiting keeps "waiting at a CLI prompt" */
        const isShell = c?.prompt === 'shell';
        const words = promptAnnouncer.update(paneid, isShell ? 'no agent running' : c ? cliPromptWords(c.prompt, c.reason) : null);
        if (words) {
          table.appendLine(room.id, { kind: 'fact', body: isShell ? shellFactText(seat.handle) : `@${seat.handle} is waiting at a CLI prompt: ${words}` } as any, { actor: 'user' });
          said++;
        }
      }
    }
    for (const gone of [...promptWatching].filter((p) => !seen.has(p))) {
      promptAnnouncer.forget(gone);
      promptWatching.delete(gone);
    }
    for (const p of seen) {
      promptWatching.add(p);
    }
  } catch (e) {
    log(`cli prompt sweep failed: ${(e as Error).message}`);
  }
  return said;
}

/* A seat the PERSON disconnected (Owner 2026-10-12, room interface): an agent's line to it
   must not wake it. The mark is the pane id, kept in engine_settings like the level-1 rested
   marks; an idle rest of the same pane (it was live in between) replaces it. The person's own
   line still wakes it (restingNote). */
const USER_DISC_KEY = 'seatDisconnect.byUser';
function userDisconnects(): Record<string, number> {
  const v = table.getEngineSetting(USER_DISC_KEY);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
}
function paneOfSeat(seat: RoomSeat): string | null {
  return seat.occupant_kind === 'pane' ? seat.occupant : null;
}
function markUserDisconnect(seat: RoomSeat): void {
  const paneid = paneOfSeat(seat);
  if (paneid) {
    table.setEngineSetting(USER_DISC_KEY, { ...userDisconnects(), [paneid]: Date.now() });
  }
}
function clearUserDisconnect(seatOrPane: RoomSeat | string): void {
  const paneid = typeof seatOrPane === 'string' ? seatOrPane : paneOfSeat(seatOrPane);
  const all = userDisconnects();
  if (paneid && paneid in all) {
    delete all[paneid];
    table.setEngineSetting(USER_DISC_KEY, all);
  }
}
function isUserDisconnected(seat: RoomSeat): boolean {
  const paneid = paneOfSeat(seat);
  return !!paneid && paneid in userDisconnects() && table.get(paneid)?.state === 'dehydrated';
}

/** Lines written while a level-1 resting seat was being woken: delivered once it is up. */
const afterWake = new Map<string, Array<{ room: Room; entry: RoomLineEntry; body: string }>>();

function isResting(seat: RoomSeat): boolean {
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  return !!paneid && table.get(paneid)?.state === 'dehydrated';
}

function wakeActorOf(actor: RoomActor): WakeActor {
  if (actor === 'user') {
    return { seatId: null, roomId: null, isLead: false };
  }
  const s = table.getSeat(actor.seatId);
  const r = s ? table.getRoom(s.room_id) : undefined;
  return { seatId: actor.seatId, roomId: s?.room_id ?? null, isLead: !!r && r.lead_seat === actor.seatId };
}

const waking = new Set<string>();

/* The start half of the room deps (launch, socket, ready...), set once by index.ts so a
   door that does not carry them (the pane-token door: an agent's room_post) can still
   wake a resting seat [agent rest]. */
let startDeps: Partial<RoomRouteDeps> = {};
const appLog = (line: string): void => (startDeps.log ?? ((l: string) => console.log(l)))(line);
export function setStartDeps(d: Partial<RoomRouteDeps>): void {
  startDeps = d;
}

/** The Concierge act (engine/concierge-act.ts): reload a seat the PERSON approved by sign-off, through the SAME reloadSeat the window button uses, so every guard stands (a seat
 *  that is mid-turn is refused, never forced; a dispatched or non-resumable one too). No welcome is sent: the engine never speaks as the person on its own. */
export function reloadSeatForPerson(room: Room, seat: RoomSeat): Promise<Record<string, unknown>> {
  return reloadSeat(room, seat, { welcome: { mode: 'none' } }, { ...startDeps, human: true } as RoomRouteDeps);
}

/** [basic] New site (server/basic.ts): start a seat the PERSON just asked for through
 *  that route (the route checked the person), with the same launch every start uses. */
export function startSeatForPerson(room: Room, seat: RoomSeat, deps: Partial<RoomRouteDeps>): Promise<Record<string, unknown>> {
  return startSeat(room, seat, { target: 'tab', surface: 'browser' }, { ...startDeps, ...deps } as RoomRouteDeps, 'user');
}


/* -------------------------------------------------------- assistant switch ---- */
/*
 * BASIC "SWITCH ASSISTANT" (the design notes §3 items 1-4, 7). Seat-level, a person's call:
 *   GET  .../seats/:seatId/switch                 the wizard's data (current vendor + effective model/effort, the two presets)
 *   POST .../seats/:seatId/switch {to, note?}      write the intent, answer early, run in the background
 *   GET  .../seats/:seatId/switch/:opId            plain-word progress (+ the raw state); readable after the seat is replaced
 *   POST .../seats/:seatId/switch/:opId/continue   proceed on the saved summary alone (context not confirmed)
 *   POST .../seats/:seatId/switch/:opId/cancel     only while reversible: ends the launched target, brings the old one back
 * One active switch per room; the SAME seat's second request joins it; another seat's is refused (409).
 */

/** Seats whose OLD assistant the switch is bringing back: startSeat lets exactly these through its guard. */
const switchRestoring = new Set<string>();

/** The active switch that owns this seat's input, or null. Before the swap: the old seat. After it (releasing the
 *  held lines): the new seat, so a line written meanwhile queues BEHIND them, never ahead. */
function switchHoldOf(seat: RoomSeat): SwitchRow | null {
  const op = table.activeSwitchForRoom(seat.room_id);
  if (!op) return null;
  if (op.from_seat_id === seat.id) return op;
  if (op.state === 'lead-committed' && seat.occupant_kind === 'pane' && seat.occupant === op.target_paneid) return op;
  return null;
}

/** Bring the old seat's assistant back (restoreOld): a no-op when it never stopped; otherwise the seat's own Start,
 *  headless, driven past startup. The restored pane keeps its paneid. */
async function restoreSeatForSwitch(op: SwitchRow, deps: RoomRouteDeps): Promise<{ ok: boolean; paneid: string | null; unchanged?: boolean; message?: string }> {
  const room = table.getRoom(op.room_id);
  const seat = op.from_seat_id ? table.getSeat(op.from_seat_id) : undefined;
  if (!room || !seat || seat.left_at) {
    return { ok: false, paneid: null, message: 'the seat is no longer in the room' };
  }
  const was = op.from_paneid;
  if (was && table.get(was)?.state === 'live') {
    return { ok: true, paneid: was, unchanged: true };
  }
  /* The pane RAN (its row is dehydrated), so a launch permit still pending for it is the leftover of its first spawn
     (spawn-permits: a first attach spawns without consuming it, for up to 2 minutes), not a start in flight; left there
     it makes startSeat answer "already starting" and the old assistant could not come back. */
  if (was && table.get(was)?.state === 'dehydrated') {
    spawnPermits.take(was);
  }
  switchRestoring.add(seat.id);
  try {
    const r = await startSeat(room, seat, { target: 'tab', surface: 'browser' }, deps, 'user');
    const paneid = String(r.paneid);
    if (!deps.socketUrl || !deps.socketToken || !deps.needsYou || !deps.ready) {
      return { ok: true, paneid };
    }
    const drive = await driveToReady(paneid, seat.recipe_id ?? '', { socketUrl: deps.socketUrl, socketToken: deps.socketToken, needsYou: deps.needsYou, ready: deps.ready, log: deps.log, open: deps.openSelf });
    if (!drive.ok && (drive.reason === 'exited' || drive.reason === 'spawn-failed')) {
      return { ok: false, paneid, message: `the previous assistant did not come back (${drive.reason})` };
    }
    return { ok: true, paneid };
  } catch (e) {
    return { ok: false, paneid: null, message: (e as Error).message };
  } finally {
    switchRestoring.delete(seat.id);
  }
}

function switchOps(doorDeps: Partial<RoomRouteDeps>): switchHost.RoomSwitchOps {
  const deps = { ...startDeps, ...doorDeps } as RoomRouteDeps;
  return {
    log: (l) => deps.log(l),
    launch: async (recipeId, body, onPane) => {
      if (!deps.launch) throw new Error('this engine door cannot launch');
      return { paneid: (await deps.launch(recipeId, body, onPane)).paneid };
    },
    endForCycle: (p) => (deps.endForCycle ? deps.endForCycle(p) : Promise.resolve({ ended: false, state: null })),
    closeWindow: (p) => (deps.closeWindow ? deps.closeWindow(p) : Promise.resolve(null)),
    drive: (p, recipeId) =>
      deps.socketUrl && deps.socketToken && deps.needsYou && deps.ready
        ? driveToReady(p, recipeId, { socketUrl: deps.socketUrl, socketToken: deps.socketToken, needsYou: deps.needsYou, ready: deps.ready, log: deps.log, open: deps.openSelf })
        : Promise.resolve({ ok: false as const, reason: 'spawn-failed' as const, detail: 'this engine door cannot drive a pane' }),
    paneStopped: (p) => (deps.paneStopped ? deps.paneStopped(p) : null),
    vendorReady: (v, recipeId) => (deps.vendorReady ? deps.vendorReady(v, recipeId) : Promise.resolve({ ok: true as const, warn: 'no sign-in check on this engine door' })),
    localPane: (p) => deps.localPane?.(p) ?? false,
    restoreSeat: (op) => restoreSeatForSwitch(op, deps),
  };
}

const brandOf = (vendor: string): string => (vendor === 'codex-cli' ? 'Codex' : vendor === 'claude-code' ? 'Claude' : vendor || 'unknown');

function switchView(op: SwitchRow): Record<string, unknown> {
  return {
    opId: op.op_id,
    seat: op.from_seat_id,
    state: op.state,
    revision: op.revision,
    ...switchHost.progressWords(op),
    error: op.error,
    recovery: op.recovery ?? null,
    held: table.heldSwitchLines(op.op_id).length,
    from: { vendor: op.from_vendor, brand: brandOf(op.from_vendor), paneid: op.from_paneid },
    to: { vendor: op.to_vendor, brand: brandOf(op.to_vendor), model: op.to_model, effort: op.to_effort, recipe: op.to_recipe_id, paneid: op.target_paneid ?? op.launched_paneid ?? null },
    updatedAt: op.updated_at,
  };
}

/** GET .../switch: what the wizard shows. "Current" is the seat's LIVE occupant's vendor (spec §3 item 8). */
function switchWizard(room: Room, seat: RoomSeat): Record<string, unknown> {
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const row = paneid ? table.get(paneid) : undefined;
  const recipe = seat.recipe_id ? table.getRecipe(seat.recipe_id) : undefined;
  const live = row?.state === 'live';
  const vendor = live ? row!.vendor : (recipe?.vendor ?? null);
  const prof = recipe ? resolveLaunchProfile(live ? (row as any) : undefined, recipe) : { model: null, effort: null };
  const cur = presetOfVendor(vendor);
  const active = table.activeSwitchForRoom(room.id);
  return {
    seat: seat.id,
    handle: seat.handle,
    live,
    current: { vendor, brand: vendor ? brandOf(vendor) : null, model: prof.model ?? 'default', effort: prof.effort ?? 'default', switchable: cur !== null },
    choices: (['claude', 'codex'] as SwitchTo[]).map((to) => {
      const p = PRESETS[to];
      const same = cur === to;
      return { to, brand: p.brand, vendor: p.vendor, model: p.model, effort: p.effort, label: p.label, disabled: same || !live || cur === null, why: same ? `You're already using ${p.brand}` : !live ? `@${seat.handle} is stopped — Start it first` : cur === null ? 'this assistant cannot be switched' : null };
    }),
    active: active ? switchView(active) : null,
    recent: table.switchesForRoom(room.id, 5).filter((o) => o.from_seat_id === seat.id).map(switchView),
  };
}

async function requestSwitch(room: Room, seat: RoomSeat, b: Record<string, any>, principal: Principal | null, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  requireHuman(deps, 'switching an assistant');
  if (b.to !== 'claude' && b.to !== 'codex') {
    throw new FieldError(400, "to is 'claude' or 'codex'", 'to');
  }
  if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 2000)) {
    throw new FieldError(400, 'note is text (2000 characters at most)', 'note');
  }
  const to = b.to as SwitchTo;
  const preset = PRESETS[to];
  const joinable = (op: SwitchRow): Record<string, unknown> => {
    if (op.from_seat_id !== seat.id) {
      throw new FieldError(409, 'switch already in progress in this room', 'seat');
    }
    if (op.to_vendor !== preset.vendor) {
      throw new FieldError(409, `a switch to ${brandOf(op.to_vendor)} is already in progress for @${seat.handle}`, 'to');
    }
    switchHost.startRunner(op.op_id, switchOps(deps));
    return { ok: true, joined: true, ...switchView(op) };
  };
  const active = table.activeSwitchForRoom(room.id);
  if (active) {
    return joinable(active);
  }
  if (room.state !== 'open') {
    throw new FieldError(409, 'the room is archived — /reopen it first', 'state');
  }
  if (seat.policy === 'dispatched' || seat.policy === 'pool') {
    throw new FieldError(409, `a ${seat.policy} seat is filled by dispatch; it has no assistant to switch`, 'policy');
  }
  /* RECHECK THE LIVE VENDOR AT CONFIRM: the choice the wizard showed may be stale */
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  const row = paneid ? table.get(paneid) : undefined;
  if (!paneid || !row || row.state !== 'live') {
    throw new FieldError(409, `@${seat.handle} is not running — Start it first, then switch`, 'seat');
  }
  const cur = presetOfVendor(row.vendor);
  if (!cur) {
    throw new FieldError(409, `@${seat.handle}'s assistant (${row.vendor || 'unknown'}) cannot be switched`, 'seat');
  }
  if (cur === to) {
    throw new FieldError(409, `You're already using ${preset.brand}`, 'to');
  }
  if (table.roomsForPane(paneid).filter((h) => h.room.state === 'open').length > 1) {
    throw new FieldError(409, `@${seat.handle}'s assistant sits in more than one room; a switch is per room`, 'seat');
  }
  const source = seat.recipe_id ? table.getRecipe(seat.recipe_id) : undefined;
  if (!source) {
    throw new FieldError(409, `@${seat.handle} has no project to switch`, 'recipe_id');
  }
  const tgt = switchTarget(source, to, (id) => table.getRecipe(id));
  if (tgt.create) {
    const { created_at: _c, updated_at: _u, last_launched_at: _l, ...rest } = tgt.create;
    table.upsertRecipe(rest);
    deps.log(`room ${room.id}: @${seat.handle} switch: created the ${preset.brand} sibling recipe ${tgt.recipeId}`);
  }
  const c = table.createSwitch({
    op_id: `sw${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    room_id: room.id,
    instance_id: engineNode(),
    account_id: pictureOwner(principal).key,
    project_id: room.id,
    from_recipe_id: source.id,
    from_paneid: paneid,
    from_seat_id: seat.id,
    from_vendor: row.vendor,
    to_recipe_id: tgt.recipeId,
    to_vendor: preset.vendor,
    to_model: tgt.launch.model,
    to_effort: tgt.launch.effort,
    note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
    expected_lead_seat: room.lead_seat ?? null,
  });
  if (c.joined) {
    return joinable(c.row); // a racing request created it first
  }
  deps.log(`room ${room.id}: @${seat.handle} switch ${c.row.op_id}: ${brandOf(row.vendor)} -> ${preset.brand} (${tgt.recipeId})`);
  switchHost.startRunner(c.row.op_id, switchOps(deps));
  return { ok: true, joined: false, ...switchView(c.row) };
}

function switchOpOf(room: Room, seat: RoomSeat, opId: string): SwitchRow {
  const op = table.getSwitch(opId);
  /* validated against the SAVED seat identity: readable after the seat is replaced */
  if (!op || op.room_id !== room.id || op.from_seat_id !== seat.id) {
    throw new FieldError(404, 'no such switch for this seat', 'opId');
  }
  return op;
}

function continueSwitch(room: Room, seat: RoomSeat, opId: string, deps: RoomRouteDeps): Record<string, unknown> {
  requireHuman(deps, 'continuing a switch');
  const op = switchOpOf(room, seat, opId);
  if (op.state !== 'context-delivered') {
    throw new FieldError(409, 'there is nothing to continue: the switch is not waiting on the handover', 'state');
  }
  switchHost.startRunner(op.op_id, switchOps(deps), { accept: true });
  return { ok: true, ...switchView(op) };
}

function cancelSwitch(room: Room, seat: RoomSeat, opId: string, deps: RoomRouteDeps): Record<string, unknown> {
  requireHuman(deps, 'cancelling a switch');
  const op = switchOpOf(room, seat, opId);
  if (!switchHost.isReversible(op.state)) {
    throw new FieldError(409, op.state === 'lead-committed' || op.state === 'done' ? `${brandOf(op.to_vendor)} already has the room; a switch cannot be undone once it has moved` : 'this switch has already finished', 'state');
  }
  switchHost.startRunner(op.op_id, switchOps(deps), { cancel: true });
  return { ok: true, cancelling: true, ...switchView(op) };
}

/** Boot (after bootReady) and the periodic sweep: drive every unfinished switch again. Never throws. */
export function resumeSwitches(log: (line: string) => void): number {
  try {
    const n = switchHost.resumeAll(switchOps({ log }));
    if (n) log(`switch: resumed ${n} unfinished switch(es)`);
    return n;
  } catch (e) {
    log(`switch: resume failed: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * Restore a resting seat, headless, and note it in its room. Fire-and-forget:
 * a line must not wait for a launch. A failure is a fact in the seat's room,
 * never an unhandled rejection (it would be engine-fatal).
 */
function wakeSeat(seat: RoomSeat, actor: RoomActor, doorDeps: RoomRouteDeps, extraBody: Record<string, unknown> = {}): Promise<void> {
  if (waking.has(seat.id)) {
    return Promise.resolve();
  }
  if (switchHoldOf(seat)) {
    return Promise.resolve(); // [assistant switch] a seat being switched is never woken; its lines are in the journal
  }
  const deps = { ...startDeps, ...doorDeps } as RoomRouteDeps;
  waking.add(seat.id);
  const fact = (roomId: string, body: string) => {
    try {
      table.appendLine(roomId, { kind: 'fact', body } as any, { actor: 'user' });
    } catch (e) {
      deps.log(`room ${roomId}: wake fact not written: ${(e as Error).message}`);
    }
  };
  return (async () => {
    const room = table.getRoom(seat.room_id);
    try {
      if (!room || !deps.socketUrl || !deps.socketToken || !deps.needsYou || !deps.ready) {
        throw new Error('this door cannot start a pane');
      }
      const oldPane = seat.occupant_kind === 'pane' ? String(seat.occupant ?? '') : '';
      const r = await startSeat(room, seat, { target: 'tab', surface: 'browser', ...extraBody }, deps, actor);
      const paneid = String(r.paneid);
      if (oldPane) {
        noteWoken(oldPane, table.get(paneid)?.agent ?? null);
      }
      const recipeId = seat.recipe_id ?? '';
      const drive = await driveToReady(paneid, recipeId, {
        socketUrl: deps.socketUrl,
        socketToken: deps.socketToken,
        needsYou: deps.needsYou,
        ready: deps.ready,
        log: deps.log,
      });
      deps.log(`room ${room.id}: @${seat.handle} wake: ${drive.ok ? 'ready' : drive.reason}`);
      void roomFabric.noticeOnReconnect(room, seat, paneid);
      if (!drive.ok && drive.reason !== 'timeout') {
        fact(room.id, `@${seat.handle} was woken but did not come up (${drive.reason})`);
      }
      /* [agent rest] the line(s) that woke it: into the typer now (its startup gate
         holds them until the REPL is ready, so a slow start delays, never drops) */
      const pending = afterWake.get(seat.id) ?? [];
      afterWake.delete(seat.id);
      const fresh = table.getSeat(seat.id) ?? seat;
      for (const it of pending) {
        roomReads.delivered(it.room.id, it.entry.id, fresh.id, fresh.handle, paneid); // waking -> delivered [wake deliver]
        deliverToSeat(it.room, fresh, it.entry, it.body);
      }
      if (pending.length) {
        deps.log(`room ${room.id}: @${seat.handle} wake: ${pending.length} waiting line(s) delivered`);
      }
    } catch (e) {
      deps.log(`room ${seat.room_id}: @${seat.handle} wake failed: ${(e as Error).message}`);
      fact(seat.room_id, `@${seat.handle} could not be woken (${(e as Error).message})`);
      /* [wake deliver] each held line says it was not delivered, with the way to retry */
      for (const it of afterWake.get(seat.id) ?? []) {
        roomReads.delivered(it.room.id, it.entry.id, seat.id, seat.handle, null, 'wake-failed');
        try {
          table.appendLine(it.room.id, {
            kind: 'delivery',
            asRoom: true,
            target: seat.handle,
            body: `not-delivered: @${seat.handle} is disconnected (the wake failed: ${(e as Error).message})`,
            meta: { paneid: null, delivered: false, reason: 'wake-failed', seat: seat.id, line: it.entry.id, action: 'wake-deliver' },
          } as any, { actor: 'user' });
        } catch {
          /* the log line above still says it */
        }
      }
    } finally {
      afterWake.delete(seat.id);
      waking.delete(seat.id);
    }
  })();
}

/**
 * POST .../seats/:seatId/wake-deliver {lineId} [wake deliver] — the UI's "Wake and
 * deliver" on an undelivered line. A person's window only. Live seat: delivered now.
 * Restorable (dehydrated): woken, and the line is delivered once it is up ('waking').
 * Anything else: 409, nothing to bring back.
 */
async function wakeDeliver(room: Room, seat: RoomSeat, b: Record<string, unknown>, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  requireHuman(deps, 'waking an agent to deliver a line');
  const id = typeof b.lineId === 'number' ? b.lineId : Number.NaN;
  const entry = Number.isInteger(id) ? table.getLineEntry(id) : undefined;
  if (!entry || (entry.room_id !== room.id && table.xpostView(entry, room.id)?.direction !== 'in')) {
    throw new FieldError(400, 'lineId is a line of this room', 'lineId');
  }
  const meta = typeof entry.meta === 'string' ? JSON.parse(entry.meta || 'null') : entry.meta;
  const body = withLinks(withReply(entry.body ?? '', replyOf(meta ?? null)), linksOf(meta ?? null));
  const at = table.getRoom(entry.room_id) ?? room;
  const full = body + referencesFor(at, entry.body ?? '');
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  if (switchHoldOf(seat)) {
    return { ok: true, state: 'held', delivery: deliverToSeat(at, seat, entry, full) };
  }
  if (paneid && isLive(paneid)) {
    roomReads.delivered(at.id, entry.id, seat.id, seat.handle, paneid);
    const d = deliverToSeat(at, seat, entry, full);
    return { ok: true, state: 'delivered', delivery: d };
  }
  if (!isResting(seat)) {
    throw new FieldError(409, `@${seat.handle} has no session to restore — start it from its seat`, 'seat');
  }
  const pending = afterWake.get(seat.id) ?? [];
  afterWake.set(seat.id, pending);
  if (!pending.some((p) => p.entry.id === entry.id)) {
    pending.push({ room: at, entry, body: full });
  }
  roomReads.waking(at.id, entry.id, seat.id, seat.handle);
  wakeSeat(seat, 'user', deps);
  return { ok: true, state: 'waking' };
}

/** GET .../guide [room guide]: the room's guide as markdown (and refresh its file). */
function sendGuide(res: ServerResponse, room: Room): void {
  roomGuide.writeGuide(room.id);
  const body = Buffer.from(roomGuide.guideText(room), 'utf8');
  res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

/** `/wake @handle` (Owner 2026-10-04, item 6): the user, or the
 *  room's active lead when Settings says leads may wake members. The smallest
 *  agent-callable wake: a room command, authorized like the lead-held verbs. */
/* ==== THE FILE STORE'S ADDRESS (`/set store`) ==== A person-only room command that keeps the store address in the engine's
 * settings, for an install where the environment file is not the person's to edit. The environment variable still wins. */
setStoredBase(() => {
  const v = table.getEngineSetting('fileStoreUrl');
  return typeof v === 'string' && v ? v : null;
});
function storeCommand(room: Room, p: Extract<ParseResult, { type: 'room' }>, text: string, actor: RoomActor): LineResponse {
  if (filesRoot()) {
    /* LOCAL MODE: the store IS the person's files folder; an address here would be saved and then silently ignored, so say so instead. */
    return refusal(room.id, text, "this room's files are kept in your own files folder, so there is no file store address to set", null);
  }
  const address = p.args.address as string | null;
  let shown: string | null = null;
  if (address === null) {
    table.setEngineSetting('fileStoreUrl', null);
  } else {
    const parsed = parseShareAddress(address);
    if (!parsed.ok) {
      return refusal(room.id, text, `that address ${parsed.error}`, '/set store http://host:8215');
    }
    table.setEngineSetting('fileStoreUrl', parsed.base);
    shown = parsed.base;
  }
  const envWins = shareSource() === 'env' ? ' (the environment variable HARBOR_WB_AGENT_SHARE_URL still wins)' : '';
  const body = shown === null ? `the room file store address was cleared${envWins}` : `the room file store is now ${shown}${envWins}`;
  const entries = table.appendLine(room.id, { kind: 'fact', body } as any, { actor }).result;
  return { status: 'applied', entries };
}
/* ==== /FILE STORE ==== */

/* ==== LEAD RESTART OF A SEAT (Owner [ref], [ref]; design [ref]) ====
 * `/seat restart @x`, `/seat restart all`, `/seat restart stop`. The rules are the pure engine/seat-restart.ts; this is the
 * wiring: the facts about the seat, the launch (wakeSeat: the engine starts the pane itself, with the asker as the
 * decided actor), one-at-a-time for `all`, and the per-seat and hourly memory of what was restarted. */
const lastRestart = new Map<string, number>(); // seat id -> ms
const leadRestartsByRoom = new Map<string, number[]>(); // room id -> ms of each restart a lead caused
const restartQueues = new Map<string, { stop: boolean }>(); // room id -> the running `all`
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function seatSettings(): seatRestart.SeatRestartSettings {
  return seatRestart.seatRestartFrom(table.getEngineSetting('seatRestart'));
}
/* MEMORY BUDGET, local mode (item 3). The app supervisor MEASURES and posts the numbers (POST /api/local/memory); the engine DECIDES:
   at 70% it sleeps the least-recently-active idle seat (memorySleepSweep), at 85% it refuses a new start with the numbers (startSeat,
   /seat restart). Memory that cannot be measured, or a report gone stale, is "unknown": said so on GET /api/local/memory and never a
   silent refusal. Not local mode: nothing here applies (the /proc/meminfo guard on /seat restart is unchanged). */
const memorySource = new MemorySource();
export function reportMemory(body: unknown, now = Date.now()): memoryBudget.MemoryVerdict | null {
  const f = parseReport(body);
  if (!f) {
    return null;
  }
  memorySource.report(f, now);
  return memoryBudget.assess(f);
}
/** The verdict now, or null outside local mode. */
export function memoryVerdict(now = Date.now()): memoryBudget.MemoryVerdict | null {
  return isLocalMode(process.env) ? memoryBudget.assess(memorySource.current(now)) : null;
}
let lastMemorySleep = 0;
/** Over the sleep line: put ONE idle seat to sleep (the idle-rest rules, however briefly it has been quiet), at most one per 20 s so the
 *  next report can show what that freed. It is marked rested, so any addressed message wakes it, and the wake waits for room. */
export async function memorySleepSweep(
  endForCycle: (paneid: string) => Promise<{ ended: boolean; state?: unknown }>,
  log: (line: string) => void,
  now = Date.now(),
): Promise<string | null> {
  const v = memoryVerdict(now);
  if (!v || (v.level !== 'sleep' && v.level !== 'refuse') || now - lastMemorySleep < 20_000) {
    return null;
  }
  try {
    const seatOf = new Map<string, { seat: RoomSeat; room: Room }>();
    for (const room of table.listRooms({ state: 'open' })) {
      for (const seat of table.listSeats(room.id)) {
        if (seat.occupant_kind === 'pane' && seat.occupant) {
          seatOf.set(String(seat.occupant), { seat, room });
        }
      }
    }
    const rows = (table.list() as any[]).filter((r) => r.state === 'live' && r.recipe_id && !spawnPermits.pending(String(r.paneid)));
    const cand = rows.map((row) => {
      const paneid = String(row.paneid);
      const q = roomTyper.queued(paneid);
      const facts = {
        state: activity.get(paneid),
        resumable: isResumableVendor(row.vendor),
        draft: activity.hasDraft(paneid),
        held: q.typed + q.fabric,
        blocked: !!activity.blockedOf(paneid) || activity.isBusy(paneid),
        lastActiveAt: activity.lastActiveAt(paneid) ?? null,
        backgroundGuard: false,
        backgroundWork: null,
        backgroundSince: null,
      };
      const at = seatOf.get(paneid);
      const restable = mayRest(facts, 0, now, BOOT_AT) && !(at && at.seat.policy !== 'persistent');
      return { id: paneid, idleMs: now - (facts.lastActiveAt ?? BOOT_AT), neverRest: !restable, row, at };
    });
    const pick = memoryBudget.pickToSleep(cand);
    if (!pick) {
      return null;
    }
    const c = cand.find((x) => x.id === pick)!;
    const r = await endForCycle(pick);
    lastMemorySleep = now;
    if (!r.ended) {
      log(`memory: ${pick} not put to sleep (state ${String(r.state)})`);
      return null;
    }
    const slug = (c.row.agent as string | null) ?? null;
    clearUserDisconnect(pick);
    setRestedMark(pick, { ts: now, slug });
    restEvent('agent_rested', pick, slug);
    log(`memory: ${v.text}: ${c.at ? `@${c.at.seat.handle}` : (slug ?? pick)} put to sleep`);
    if (c.at) {
      table.appendLine(c.at.room.id, { kind: 'fact', body: `@${c.at.seat.handle} is sleeping to free memory (${v.numbers}); any message wakes it` } as any, { actor: 'user' });
    }
    return pick;
  } catch (e) {
    log(`memory sleep sweep failed: ${(e as Error).message}`);
    return null;
  }
}

function readMeminfo(): seatRestart.MemInfo | null {
  try {
    return seatRestart.parseMeminfo(readFileSync(process.env.HARBOR_WB_MEMINFO || '/proc/meminfo', 'utf8'));
  } catch {
    return null; // not Linux, or unreadable: the guard does not apply
  }
}
function seatPaneState(seat: RoomSeat): seatRestart.SeatPaneState {
  const paneid = seat.occupant_kind === 'pane' ? seat.occupant : null;
  if (!paneid) {
    return 'none';
  }
  const st = table.get(paneid)?.state;
  return st === 'live' || st === 'dehydrated' || st === 'killed' ? st : st ? 'other' : 'none';
}
/** A seat that has never been started: no pane now and no former occupant. An evicted or replaced seat also reads `none` but has a history row, so a crash-looping seat cannot pass as a first start. */
function neverStarted(seat: RoomSeat): boolean {
  return seatPaneState(seat) === 'none' && table.listSeatHistory(seat.id).length === 0;
}
function restartFacts(room: Room, target: RoomSeat, actor: RoomActor): seatRestart.RestartFacts {
  /* WHO LEADS WHAT comes from the room-lead pointer over the target's whole family (seat-restart.ts leadAuthority) */
  const auth =
    actor === 'user'
      ? { byLead: false, targetIsLead: room.lead_seat === target.id }
      : seatRestart.leadAuthority({
          actorSeatId: actor.seatId,
          targetSeatId: target.id,
          targetRoomId: target.room_id,
          family: table.familyRoomIds(room.id).map((id) => table.getRoom(id)).filter((r): r is Room => !!r).map((r) => ({ id: r.id, parent_id: r.parent_id, lead_seat: r.lead_seat })),
        });
  return {
    byUser: actor === 'user',
    byLeadOfRoom: auth.byLead,
    targetIsLead: auth.targetIsLead,
    targetHandle: target.handle,
    targetState: seatPaneState(target),
    switching: !!switchHoldOf(target),
    lastRestartAt: lastRestart.get(target.id) ?? null,
    firstStart: neverStarted(target),
    memoryRefusal: ((v) => (v ? (v.level === 'refuse' ? v.text : null) : undefined))(memoryVerdict()), // local mode: the budget replaces the /proc guard
    now: Date.now(),
    settings: seatSettings(),
    mem: readMeminfo(),
  };
}
/** Start one seat under the asker's authority; resolves when it is up (or has failed, as a fact). */
function restartOne(room: Room, target: RoomSeat, actor: RoomActor, deps: RoomRouteDeps): Promise<void> {
  const row = target.occupant_kind === 'pane' && target.occupant ? table.get(target.occupant) : undefined;
  const recipe = target.recipe_id ? table.getRecipe(target.recipe_id) : undefined;
  const state = seatPaneState(target);
  const how = state === 'dehydrated' ? { resumes: true, body: {} } : (() => { const m = seatRestart.restartMode(recipe?.vendor ?? row?.vendor ?? null, row?.session_id ?? null); return 'resumeSessionId' in m ? { resumes: true, body: m } : { resumes: false, body: {} }; })();
  const first = neverStarted(target); // a first start counts toward neither the gap nor the hourly cap (the memory guard is its limit)
  if (!first) {
    lastRestart.set(target.id, Date.now());
  }
  if (actor !== 'user' && !first) {
    const hits = (leadRestartsByRoom.get(room.id) ?? []).filter((t) => Date.now() - t < 3_600_000);
    hits.push(Date.now());
    leadRestartsByRoom.set(room.id, hits);
  }
  const by = actor === 'user' ? 'the user' : `@${table.getSeat(actor.seatId)?.handle ?? '?'}`;
  table.appendLine(room.id, { kind: 'fact', body: seatRestart.restartedFact(target.handle, by, how.resumes ? 'resume' : 'fresh') } as any, { actor });
  return wakeSeat(target, actor, deps, how.body);
}
function restartCommand(room: Room, p: Extract<ParseResult, { type: 'room' }>, text: string, actor: RoomActor, deps: RoomRouteDeps): LineResponse {
  if (p.verb === 'seat-restart-stop') {
    const q = restartQueues.get(room.id);
    if (!q) {
      return refusal(room.id, text, 'no /seat restart all is running here', null);
    }
    q.stop = true;
    const entries = table.appendLine(room.id, { kind: 'fact', body: 'the seat restart queue was stopped' } as any, { actor }).result;
    return { status: 'applied', entries };
  }
  if (p.verb === 'seat-restart') {
    const target = table.getSeat((p.target as SeatRef).seatId);
    if (!target || !table.familyRoomIds(room.id).includes(target.room_id)) {
      return refusal(room.id, text, 'no such seat in this room or its family', null);
    }
    const d = seatRestart.decideRestart(restartFacts(room, target, actor));
    if (!d.ok) {
      return refusal(room.id, text, d.error, null);
    }
    if (actor !== 'user' && !neverStarted(target) && (leadRestartsByRoom.get(room.id) ?? []).filter((t) => Date.now() - t < 3_600_000).length >= seatRestart.RESTART_HOURLY_CAP) {
      return refusal(room.id, text, `${seatRestart.RESTART_HOURLY_CAP} restarts in the last hour; the user can restart more`, null);
    }
    void restartOne(room, target, actor, deps);
    return { status: 'applied', entries: [] };
  }
  /* all: the room's seats that can be restarted now, one at a time */
  if (restartQueues.has(room.id)) {
    return refusal(room.id, text, 'a /seat restart all is already running here (/seat restart stop ends it)', null);
  }
  const mine = actor === 'user' ? null : actor.seatId;
  const todo = table.listSeats(room.id).filter((s) => s.id !== mine && seatRestart.decideRestart(restartFacts(room, s, actor)).ok);
  if (!todo.length) {
    return refusal(room.id, text, 'no seat here can be restarted right now (they are live, or too recent, or the machine is short of memory)', null);
  }
  const queue = { stop: false };
  restartQueues.set(room.id, queue);
  const gap = Number(process.env.HARBOR_WB_RESTART_ALL_GAP_MS) || seatRestart.RESTART_ALL_GAP_MS;
  const by = actor === 'user' ? 'the user' : `@${table.getSeat(actor.seatId)?.handle ?? '?'}`;
  const entries = table.appendLine(room.id, { kind: 'fact', body: `restarting ${todo.length} seat${todo.length === 1 ? '' : 's'} one at a time, ${Math.round(gap / 1000)} s apart (asked by ${by}): ${todo.map((s) => `@${s.handle}`).join(', ')}. /seat restart stop ends it` } as any, { actor }).result;
  void (async () => {
    try {
      for (let i = 0; i < todo.length && !queue.stop; i++) {
        const seat = table.getSeat(todo[i].id);
        if (!seat) {
          continue;
        }
        const d = seatRestart.decideRestart(restartFacts(room, seat, actor)); // re-asked each time: memory and state move
        if (!d.ok) {
          table.appendLine(room.id, { kind: 'fact', body: `@${seat.handle} was not restarted: ${d.error}` } as any, { actor });
        } else if (actor !== 'user' && !neverStarted(seat) && (leadRestartsByRoom.get(room.id) ?? []).filter((t) => Date.now() - t < 3_600_000).length >= seatRestart.RESTART_HOURLY_CAP) {
          table.appendLine(room.id, { kind: 'fact', body: `the restart queue stopped: ${seatRestart.RESTART_HOURLY_CAP} restarts in the last hour` } as any, { actor });
          break;
        } else {
          await restartOne(room, seat, actor, deps);
        }
        if (i < todo.length - 1 && !queue.stop) {
          await sleepMs(gap);
        }
      }
    } catch (e) {
      deps.log(`room ${room.id}: seat restart queue failed: ${(e as Error).message}`);
    } finally {
      restartQueues.delete(room.id);
    }
  })();
  return { status: 'applied', entries };
}
/* ==== /LEAD RESTART ==== */

function wakeCommand(room: Room, p: Extract<ParseResult, { type: 'room' }>, text: string, actor: RoomActor, deps: RoomRouteDeps): LineResponse {
  const target = table.getSeat((p.target as SeatRef).seatId);
  if (!target || target.room_id !== room.id) {
    return refusal(room.id, text, 'no such seat in this room', null);
  }
  const isLead = room.lead_seat === target.id;
  const allowed = actor === 'user' || mayWake(idleRestSettings(), wakeActorOf(actor), { roomId: room.id, isLead });
  if (!allowed) {
    return refusal(room.id, text, 'waking a resting seat is the user\'s; the room lead may wake members when "Leads can wake members" is on in Settings', 'ask the lead, or the user');
  }
  if (!isResting(target)) {
    return refusal(room.id, text, `@${target.handle} is not resting`, null);
  }
  wakeSeat(target, actor, deps);
  const by = actor === 'user' ? 'the user' : `@${table.getSeat(actor.seatId)?.handle ?? '?'}`;
  const entries = table.appendLine(room.id, { kind: 'fact', body: `@${target.handle} is waking (asked by ${by})` } as any, { actor }).result;
  return { status: 'applied', entries };
}

/* Holds `/deliver` leaves to the seat's window, in the refusal's words. */
const DELIVER_IN_WINDOW: Readonly<Record<string, string>> = {
  startup: 'a question may be up in its window',
  'needs-you': 'its window shows a prompt only you can answer',
  'no-claude': "claude isn't running in it",
};

/** `/deliver @handle` (Owner 2026-10-11, room line [ref]): the window's "Deliver N" from
 *  the room. THE USER'S ONLY: it types into a member's input box on a person's word
 *  that the box is clear, the same claim POST /api/panes/:id/deliver-held takes from a
 *  window cookie. `actor === 'user'` is a human credential (authorFor), and every agent
 *  door posts as a seat, so no agent reaches it. From the room the person cannot see
 *  that box, so a draft the key count lost track of (`unknown`) is cleared at once, a
 *  draft the engine COUNTED (typed characters never sent; the line goes in stuck to
 *  them) is ASKED first, and a hold only the window can show (a startup or blocking
 *  prompt, claude not running) is sent to the window. */
function deliverCommand(room: Room, p: Extract<ParseResult, { type: 'room' }>, text: string, actor: RoomActor, deps: RoomRouteDeps, confirm: string | null): LineResponse {
  const target = table.getSeat((p.target as SeatRef).seatId);
  if (!target || target.room_id !== room.id) {
    return refusal(room.id, text, 'no such seat in this room', null);
  }
  if (actor !== 'user') {
    return refusal(room.id, text, "delivering held lines is the user's: it types into a member's input box on a person's word that the box is empty", 'ask the user');
  }
  const paneid = target.occupant_kind === 'pane' ? target.occupant : null;
  if (!paneid || !isLive(paneid)) {
    return refusal(room.id, text, `@${target.handle} has no live session to type into`, null);
  }
  const held = roomTyper.heldFor(paneid);
  if (!held) {
    return refusal(room.id, text, `@${target.handle} has nothing held`, null);
  }
  const inWindow = DELIVER_IN_WINDOW[held.reason];
  if (inWindow) {
    return refusal(room.id, text, `@${target.handle}'s lines are held because ${inWindow}`, 'open its window');
  }
  if (activity.draftState(paneid) !== 'draft') {
    return refusal(room.id, text, `@${target.handle}'s held lines are not waiting on a draft (${held.reason}): they type on their own when it is free`, null);
  }
  if (activity.draftView(paneid).certain) {
    /* Typed text never sent: the held line would be submitted stuck to it. Said first,
       then done on the person's word, by the confirm step /remove uses (the room's
       Confirm button, or a typed `/deliver @x confirm`). */
    sweepConfirms();
    if (confirm !== null) {
      const c = confirms.get(confirm);
      if (!c || c.roomId !== room.id || c.text !== text || c.actorKey !== actorKey(actor)) {
        throw new FieldError(400, 'that confirm token is unknown, expired, or for another command — send the command again', 'confirm');
      }
      confirms.delete(confirm);
    } else if (p.args.confirm !== true) {
      const t = randomUUID();
      confirms.set(t, { roomId: room.id, text, actorKey: actorKey(actor), expires: Date.now() + CONFIRM_TTL_MS });
      return {
        status: 'confirm',
        entries: [],
        confirm: { token: t, prompt: `@${target.handle}'s input box has typed text that was never sent. Send anyway? Your held message goes in stuck to that text.` },
      };
    }
  }
  const d = roomTyper.deliverHeld(paneid);
  if (!d.ok) {
    deps.log(`room ${room.id}: /deliver @${target.handle} refused (${d.reason}${d.reason === 'startup' ? `: ${d.prompt}` : ''})`);
    return d.reason === 'no-claude'
      ? refusal(room.id, text, `claude is not running in @${target.handle}'s terminal: a typed line would run in its shell`, 'start claude in its window, or Restore')
      : refusal(room.id, text, `@${target.handle}'s window may be showing a prompt (${d.prompt})`, 'answer it in its window, then press Deliver there');
  }
  const left = roomTyper.heldFor(paneid);
  const typed = held.depth - (left?.depth ?? 0);
  deps.log(`room ${room.id}: /deliver @${target.handle} by the user: ${d.overrode.join('+') || 'nothing'} waived on a person's word → ${d.result} (${typed} typed, ${left?.depth ?? 0} left)`);
  const lines = (n: number): string => `${n} held line${n === 1 ? '' : 's'}`;
  const body =
    d.result === 'injected'
      ? `the user said @${target.handle}'s input box is empty: ${lines(typed)} typed${left ? `, ${left.depth} more follow` : ''}`
      : `the user said @${target.handle}'s input box is empty: its ${lines(held.depth)} type when it is free (now ${d.result.replace('held:', '')})`;
  /* meta.deliver marks it as a record of a person's override, for a renderer that keeps such lines for troubleshooting */
  const entries = table.appendLine(room.id, { kind: 'fact', body, meta: { deliver: { seat: target.id, typed, left: left?.depth ?? 0 } } } as any, { actor }).result;
  return { status: 'applied', entries };
}

/** What the delivery report says about a RESTING recipient of a line: wake it
 *  when the settings let this author, else tell the sender it is offline. */
function restingNote(seat: RoomSeat, actor: RoomActor, deps: RoomRouteDeps): string {
  /* the person switched it off: only the person's own line brings it back; tell the sender who did it */
  if (isUserDisconnected(seat)) {
    if (actor !== 'user') {
      return `@${seat.handle} was disconnected by the user, so it was not woken. Ask the user (@user) if you need it back.`;
    }
    if (agentComms().personWakeScope === 'auto') {
      return `@${seat.handle} was disconnected by you, so it was not woken (Settings · Agent comms wakes only agents the system rested). Use its Wake button to bring it back.`;
    }
  }
  /* [agent rest] level 1: ANY addressed line wakes it (the person's too), and the line
     itself is delivered once it is back (afterWake, filled by sendWords) */
  if (isRestedLevel1(seat.occupant_kind === 'pane' ? seat.occupant : null)) {
    if (!afterWake.has(seat.id)) {
      afterWake.set(seat.id, []);
    }
    wakeSeat(seat, actor, deps);
    return `@${seat.handle} was resting — waking it; this line is delivered when it is up`;
  }
  /* [wake deliver] the PERSON's line to a disconnected (restorable) seat: wake it and
     deliver the line once it is up. Agents keep the level-2 wake rules below. */
  if (actor === 'user' && agentComms().personWakes) {
    if (!afterWake.has(seat.id)) {
      afterWake.set(seat.id, []);
    }
    wakeSeat(seat, actor, deps);
    return `@${seat.handle} is disconnected — waking it; this line is delivered when it is up`;
  }
  const s = idleRestSettings();
  const room = table.getRoom(seat.room_id);
  const isLead = !!room && room.lead_seat === seat.id;
  if (mayWake(s, wakeActorOf(actor), { roomId: seat.room_id, isLead })) {
    wakeSeat(seat, actor, deps);
    return `@${seat.handle} was resting — waking it`;
  }
  const lead = room?.lead_seat ? table.getSeat(room.lead_seat) : undefined;
  return offlineNotice({ handle: seat.handle, isLead, leadHandle: isLead ? null : (lead?.handle ?? null), leadLive: !!lead && !isResting(lead) && lead.occupant_kind === 'pane' && isLive(lead.occupant) });
}

/* ------------------------------------------------- create a workgroup ---- */

const WG_PICK_MAX = 20;

/**
 * POST /api/rooms/:id/workgroups (Owner 2026-10-04, item 3: the
 * + sheet's Workgroups tab and the room row's "Add new workgroup"). ONE call
 * that forms a workgroup under the MAIN room `:id`:
 *   {name, alias?, color?, move: [seatId…], start: [{recipe_id, handle?}…],
 *    lead: {move: seatId} | {start: recipe_id}}
 * PHASE 1, ALL OR NOTHING (one store transaction): create the room, set its
 * color, MOVE the chosen seats (the step-A move: same handle, same session),
 * ADD a seat per project to start, name the lead. Any refusal rolls the whole
 * phase back, so a clash leaves nothing behind; the answer names the step.
 * PHASE 2, per agent (a launch cannot be rolled back): START each new seat
 * fresh. A failed start does not undo the workgroup: it is reported in words,
 * and the seat stays never-started with its own Start. A person's call, so a
 * window credential only. New instances launch as today (worktrees are a later
 * step).
 */
async function createWorkgroup(room: Room, b: Record<string, any>, deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  requireHuman(deps, 'creating a workgroup');
  if (room.parent_id !== null) {
    throw new FieldError(409, `"${room.name}" is itself a workgroup; workgroups are made under the main room`, 'room');
  }
  if (typeof b.name !== 'string') {
    throw new FieldError(400, 'name is a string', 'name');
  }
  if (b.alias !== undefined && b.alias !== null && typeof b.alias !== 'string') {
    throw new FieldError(400, 'alias is a string', 'alias');
  }
  const move: string[] = b.move === undefined || b.move === null ? [] : b.move;
  const start: Array<{ recipe_id: string; handle?: string | null }> = b.start === undefined || b.start === null ? [] : b.start;
  if (!Array.isArray(move) || move.some((x) => typeof x !== 'string') || new Set(move).size !== move.length || move.length > WG_PICK_MAX) {
    throw new FieldError(400, `move is a list of up to ${WG_PICK_MAX} seat ids, each once`, 'move');
  }
  if (
    !Array.isArray(start) || start.length > WG_PICK_MAX ||
    start.some((x) => !x || typeof x !== 'object' || typeof x.recipe_id !== 'string' || (x.handle !== undefined && x.handle !== null && typeof x.handle !== 'string')) ||
    new Set(start.map((x) => x.recipe_id)).size !== start.length
  ) {
    throw new FieldError(400, `start is a list of up to ${WG_PICK_MAX} {recipe_id, handle?}, each project once`, 'start');
  }
  if (!move.length && !start.length) {
    throw new FieldError(400, 'a workgroup needs at least one agent: move one or start one', 'move');
  }
  const L = b.lead;
  const leadMove = L && typeof L === 'object' && typeof L.move === 'string' ? (L.move as string) : null;
  const leadStart = L && typeof L === 'object' && typeof L.start === 'string' ? (L.start as string) : null;
  if ((leadMove === null) === (leadStart === null) || (leadMove !== null && !move.includes(leadMove)) || (leadStart !== null && !start.some((x) => x.recipe_id === leadStart))) {
    throw new FieldError(400, 'lead is {move: <a seat you are moving>} or {start: <a project you are starting>}', 'lead');
  }
  const step = <T,>(what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof RoomError) {
        throw new RoomError(e.status, `${what}: ${e.message}`, e.field);
      }
      throw e;
    }
  };
  const made = table.roomBatch((tx) => {
    const wg = step('creating the workgroup', () => tx.createRoom({ name: b.name, parent_id: room.id, alias: b.alias || undefined }, { actor: 'user' }).result);
    if (b.color !== undefined && b.color !== null) {
      step('setting the color', () => tx.setRoomSettings(wg.id, { color: b.color }));
    }
    const moved = move.map((id) => {
      const handle = table.getSeat(id)?.handle ?? id;
      return step(`moving @${handle}`, () => tx.moveSeat(room.id, id, wg.id, { actor: 'user' }).result);
    });
    const added = start.map((x) => {
      const label = x.handle ? `@${x.handle}` : table.getRecipe(x.recipe_id)?.name ?? 'an agent';
      return step(`adding ${label}`, () =>
        tx.addSeat(wg.id, { recipe_id: x.recipe_id, ...(x.handle ? { handle: x.handle } : {}), autoLead: false }, { actor: 'user' }).result);
    });
    const lead = leadMove !== null ? moved[move.indexOf(leadMove)] : added[start.findIndex((x) => x.recipe_id === leadStart)];
    step(`making @${lead.handle} the lead`, () => tx.updateRoom(wg.id, { lead_seat: lead.id }, { actor: 'user' }));
    return { wg, moved, added, lead };
  });
  const { wg, moved, added, lead } = made.value;
  for (const m of moved) seatWelcome.welcomeSeat(wg, m, deps.log); // moved seats learn the workgroup's name (the new ones are welcomed by their start)
  deps.log(`room ${room.id}: workgroup "${wg.name}" (${wg.id}) made: moved ${moved.length}, adding ${added.length}, lead @${lead.handle}`);
  /* PHASE 2: start the new seats, one at a time; each failure is reported, none hides */
  const started: Array<Record<string, unknown>> = [];
  const problems: string[] = [];
  for (const seat of added) {
    const fresh = table.getRoom(wg.id)!;
    try {
      /* headless, like every other room start (no window on the desktop): Owner 2026-10-05,
         creating a workgroup popped a native window for its new agent */
      const ans = await startSeat(fresh, seat, { fresh: true, target: 'tab', surface: 'browser' }, deps);
      started.push({ handle: seat.handle, seat: seat.id, ok: true, paneid: ans.paneid, url: ans.url });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      problems.push(`starting @${seat.handle} failed: ${msg} (it is in the workgroup, not started: use its Start)`);
      started.push({ handle: seat.handle, seat: seat.id, ok: false, error: msg });
      deps.log(`room ${wg.id}: @${seat.handle} start failed after create: ${msg}`);
    }
  }
  return {
    ok: problems.length === 0,
    partial: problems.length > 0,
    problems,
    room: designView(table.getRoom(wg.id)!).room,
    lead: lead.handle,
    moved: moved.map((m) => ({ seat: m.id, handle: m.handle })),
    started,
  };
}

/* ----------------------------------------------------------- seatability ---- */

/** Why a pane can or cannot take a seat (assemble-room §4.1). ONE vocabulary:
 *  GET /api/sessions/readiness and POST /api/rooms/assemble both call
 *  `seatability`, so the modal's reasons and the verb's refusals cannot drift. */
export type SeatReason =
  | 'shell'
  | 'no-recipe'
  | 'in-room'
  | 'not-restorable'
  | 'session-open-elsewhere'
  | 'room-archived'
  | 'restorable-later'
  | 'needs-you';

export interface Seatability {
  eligible: boolean;
  /** null when eligible. */
  reason: SeatReason | null;
  /** `session-open-elsewhere`: the live pane that holds the conversation. */
  openIn?: string;
}

/**
 * Can this pane take a seat in `room` (null = a new room), for a caller with
 * this credential? First refusal wins, in this order: nothing to seat
 * (`not-restorable` for no row), a plain shell, no saved project, an archived
 * room, already in the room; then a LIVE pane is eligible. A dehydrated one
 * (the table's own state word — a named-resume pane has no banked uuid by
 * design) needs a resumable vendor, a `recipe:<rid>[#…]` paneid of its own
 * recipe (§4.3), no other live row on its conversation, a HUMAN caller
 * (`needs-you` when a lead is assembling) and the `seatRestorable` switch
 * (`restorable-later` while it is off). Killed or corrupted rows are
 * `not-restorable`.
 *
 * What only a SEAT knows — its policy — is `requireSeatablePane`'s (§4.3,
 * assemble only): readiness has no seat yet, so it answers from this alone.
 */
export function seatability(pane: SessionRow | undefined, room: Room | null, credential: { human: boolean }): Seatability {
  const no = (reason: SeatReason, extra: Partial<Seatability> = {}): Seatability => ({ eligible: false, reason, ...extra });
  if (!pane) {
    return no('not-restorable');
  }
  if (pane.vendor === 'cli-manager' && !pane.agent) {
    return no('shell');
  }
  if (!pane.recipe_id || !table.getRecipe(pane.recipe_id)) {
    return no('no-recipe');
  }
  if (room && room.state !== 'open') {
    return no('room-archived');
  }
  if (room && table.listSeats(room.id).some((s) => s.occupant_kind === 'pane' && s.occupant === pane.paneid)) {
    return no('in-room');
  }
  if (pane.state === 'live') {
    return { eligible: true, reason: null };
  }
  if (pane.state !== 'dehydrated' || !isResumableVendor(pane.vendor)) {
    return no('not-restorable');
  }
  /* §4.3: a restorable occupant is a `recipe:<rid>[#…]` pane of its own
     recipe (the seat's, in assemble), the only kind the seat's Restore and the
     launch route can address. Seat-independent, so readiness says it too and
     the modal never offers a row the verb would refuse. */
  if (!paneOfRecipe(pane.paneid, pane.recipe_id)) {
    return no('not-restorable');
  }
  const other = pane.session_id
    ? table.list().find((r) => r.state === 'live' && r.paneid !== pane.paneid && r.session_id === pane.session_id)
    : undefined;
  if (other) {
    return no('session-open-elsewhere', { openIn: other.paneid });
  }
  if (!credential.human) {
    return no('needs-you');
  }
  if (!runtimeFlag('seatRestorable')) {
    return no('restorable-later');
  }
  return { eligible: true, reason: null };
}

/**
 * §4.3: may this pane take THIS seat? Used only by assemble (requireLivePane
 * keeps serving carried commands and PATCH seat, unchanged). A live pane is
 * `seatability`'s answer. A dehydrated one additionally needs what only the
 * seat knows: the seat policy is `persistent` (a fresh seat would start a
 * blank conversation, not restore this one). `seatability` has already
 * required the rest of §4.3 — a resumable vendor, a `recipe:<rid>[#…]` pane
 * of the seat's recipe (assemble seats a pane under its own recipe, so this
 * one is seat-independent and readiness shares it), no other live row
 * banking the session_id, a human credential and the `seatRestorable`
 * switch (off by default) — so the seat derives `rehydrate` (Restore).
 * Returns the verdict rather than throwing: assemble answers per row.
 */
export function requireSeatablePane(
  pane: SessionRow | undefined,
  room: Room | null,
  credential: { human: boolean },
  seat: { policy: 'persistent' | 'fresh' },
): Seatability {
  const v = seatability(pane, room, credential);
  if (!v.eligible || pane!.state === 'live') {
    return v;
  }
  if (seat.policy !== 'persistent') {
    return { eligible: false, reason: 'not-restorable' };
  }
  return v;
}

/* -------------------------------------------------------------- assemble ---- */

const ASSEMBLE_KEY_TTL_MS = 10 * 60_000;
const ASSEMBLE_SEATS_MAX = 50;

/* The idempotency key map (§4.2): in memory, 10 min, COMMITTED 200s only. A
   dry run never reads or writes it and a 409 does not use a key up, so the
   modal's skip-retry and a retry after a network drop both reuse its key. An
   engine restart forgets it (the accepted gap: a visible, archivable room). */
const assembled = new Map<string, { at: number; hash: string; body: Record<string, unknown> }>();

export type AssembleRefusal = SeatReason | 'handle-taken' | 'key-reused';
export type AssembleResult =
  | { paneid: string; outcome: 'seated' | 'already' | 'would-seat'; seatId: string; handle: string; autoSuffixed: boolean }
  | { paneid: string; outcome: 'refused'; reason: AssembleRefusal };

interface AssembleSeatIn {
  occupant: string;
  handle: string | null;
  policy: 'persistent' | 'fresh';
}

/** The body, validated field by field (400 naming the field). */
function assembleInput(b: Record<string, any>) {
  if (b.dryRun !== undefined && b.dryRun !== null && typeof b.dryRun !== 'boolean') {
    throw new FieldError(400, 'dryRun is a boolean', 'dryRun');
  }
  const dryRun = b.dryRun === true;
  const r = b.room;
  const byId = r && typeof r === 'object' && !Array.isArray(r) && typeof r.id === 'string' && r.id && r.name === undefined;
  const byName = r && typeof r === 'object' && !Array.isArray(r) && typeof r.name === 'string' && r.id === undefined;
  if (!byId && !byName) {
    throw new FieldError(400, 'room is {id} (an existing room) or {name} (a new one)', 'room');
  }
  /* A DRY RUN NEVER REFUSES ON A NAME: the modal dry-runs before one is typed
     (it sends 'Unnamed room'), names are not unique, and the rolled-back room
     leaves no trace — so an unusable one is simply stood in for. The real
     call refuses an empty or over-long name: 400 field room. */
  const nameOk = byName && !!r.name.trim() && r.name.trim().length <= 200;
  if (byName && !nameOk && !dryRun) {
    throw new FieldError(400, 'a room name is 1-200 characters', 'room');
  }
  const key = b.key;
  if (!dryRun && (typeof key !== 'string' || !key || key.length > 64)) {
    throw new FieldError(400, 'key is the modal\'s idempotency key (1-64 chars)', 'key');
  }
  if (!Array.isArray(b.seats) || !b.seats.length || b.seats.length > ASSEMBLE_SEATS_MAX) {
    throw new FieldError(400, `seats is a list of 1-${ASSEMBLE_SEATS_MAX} {occupant, handle?, policy?}`, 'seats');
  }
  const seats: AssembleSeatIn[] = b.seats.map((s: any) => {
    if (!s || typeof s !== 'object' || typeof s.occupant !== 'string' || !s.occupant.trim()) {
      throw new FieldError(400, 'every seat names its occupant paneid', 'seats');
    }
    if (s.handle !== undefined && s.handle !== null && typeof s.handle !== 'string') {
      throw new FieldError(400, 'a seat handle is a string', 'seats');
    }
    if (s.policy !== undefined && s.policy !== null && s.policy !== 'persistent' && s.policy !== 'fresh') {
      throw new FieldError(400, "a seat policy is 'persistent' or 'fresh'", 'seats');
    }
    return { occupant: s.occupant, handle: s.handle ? s.handle : null, policy: s.policy ?? 'persistent' };
  });
  if (new Set(seats.map((s) => s.occupant)).size !== seats.length) {
    throw new FieldError(400, 'a pane is named twice', 'seats');
  }
  const lead = b.lead === undefined || b.lead === null ? null : b.lead;
  if (lead !== null) {
    const ls = seats.find((s) => s.occupant === lead);
    if (typeof lead !== 'string' || !ls) {
      throw new FieldError(400, 'lead is the paneid of a seat in this call', 'lead');
    }
    if (ls.policy !== 'persistent') {
      throw new FieldError(400, 'the lead must be a persistent seat', 'lead');
    }
  }
  const c = b.conventions;
  if (c !== undefined && c !== null && typeof c !== 'string') {
    throw new FieldError(400, 'conventions is text', 'conventions');
  }
  if (typeof c === 'string' && c.length > LINE_BODY_MAX) {
    throw new FieldError(400, `conventions is over ${LINE_BODY_MAX} characters`, 'conventions');
  }
  const conventions = typeof c === 'string' && c.trim() ? c : null;
  /* `from` is a paneid (the spec's form) or the other room routes' object. */
  const from = b.from === undefined || b.from === null ? undefined : typeof b.from === 'string' ? { paneid: b.from } : b.from;
  const room: { id: string | null; name: string | null } = byId
    ? { id: r.id as string, name: null }
    : { id: null, name: nameOk ? (r.name as string).trim() : 'Unnamed room' };
  return { dryRun, key: key as string, room, seats, lead: lead as string | null, conventions, from };
}

/**
 * POST /api/rooms/assemble (assemble-room §4.2): seat several panes in one
 * room — a new one (`room:{name}`) or an existing one (`room:{id}`) — as ONE
 * store transaction. `dryRun` runs the SAME transaction and rolls it back, so
 * its derived handles are the real call's by construction. Any refused row →
 * nothing written, 409 with a result per row. `conventions` is posted after
 * the commit through the line's own send path.
 */
async function assemble(b: Record<string, any>, deps: RoomRouteDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const inp = assembleInput(b);
  /* The one await, FIRST: from the key check to the key write everything is
     synchronous, so two copies of one request (a retry racing its original)
     cannot both pass the key check and both commit. */
  const project = await deps.projector();
  const now = Date.now();
  for (const [k, v] of assembled) {
    if (now - v.at > ASSEMBLE_KEY_TTL_MS) {
      assembled.delete(k);
    }
  }
  const hash = JSON.stringify([inp.room, inp.seats, inp.lead, inp.conventions, inp.from ?? null]);
  if (!inp.dryRun) {
    const hit = assembled.get(inp.key);
    if (hit) {
      return hit.hash === hash
        ? { status: 200, body: { ...hit.body, replayed: true } }
        : {
            status: 409,
            body: {
              error: 'that key already committed a different request',
              field: 'key',
              results: inp.seats.map((s) => ({ paneid: s.occupant, outcome: 'refused', reason: 'key-reused' })),
            },
          };
    }
  }

  /* AUTHORITY: the user, or the CURRENT lead of an existing room via `from`.
     An omitted `from` must be a person (a cookie) — an agent cannot assemble
     as "the user" (D11) — so the modal pays nothing and a bearer gets 403. */
  const existing = inp.room.id !== null ? (table.getRoom(inp.room.id) ?? null) : null;
  if (inp.room.id !== null && !existing) {
    throw new FieldError(404, 'no such room', 'room');
  }
  let actor: RoomActor = 'user';
  if (inp.from === undefined) {
    if (!deps.human) {
      throw new FieldError(403, 'assembling as the user needs a person: send it from a window (cookie), or name the lead in from', 'from');
    }
  } else {
    if (!existing) {
      throw new FieldError(403, 'a new room is assembled by the user', 'from');
    }
    /* Not httpActor: that logs the acting seat at once, and a dry run must
       leave no trace. The committed log line below names the seat. */
    actor = authorFor(existing.id, inp.from, deps);
    const refusal = authorityRefusal(existing, actor, inp.lead ? ['add', 'set-lead'] : ['add']);
    if (refusal) {
      throw new FieldError(403, refusal, 'from');
    }
    requireSeatBinder(actor, deps); // it binds every listed pane (§4.3)
  }

  const human = deps.human === true;
  const rows = inp.seats.map((s) => {
    const row = table.get(s.occupant);
    return { s, row, v: requireSeatablePane(row, existing, { human }, s) };
  });

  const out = table.roomBatch((tx) => {
    const entries: RoomLineEntry[] = [];
    let room: Room;
    if (existing) {
      room = existing;
    } else {
      const created = tx.createRoom({ name: inp.room.name! }, { actor });
      room = created.result;
      entries.push(...created.entries);
    }
    const results: AssembleResult[] = new Array(rows.length);
    const seatOf = new Map<string, string>();
    /* REQUEST ORDER — a seat's position is its tab order, and it follows the
       list the user saw (review 2 f6). A handle a row TYPED beats one another
       row would DERIVE (review #6): derived rows treat the call's typed
       handles as taken and step aside to their placeholder (`echo2`, name me).
       The store's first-persistent-seat rule is switched off (autoLead:false)
       and the lead is named once, below. The dry run binds the same list the
       same way, so its handles are the real call's. */
    const typedHandles: string[] = [];
    for (const { s } of rows) {
      if (s.handle) {
        try {
          typedHandles.push(normalizeHandle(s.handle));
        } catch {
          /* a reserved or empty handle is refused on its own row */
        }
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const { s, row, v } = rows[i];
      if (v.reason === 'in-room') {
        const seat = table.listSeats(room.id).find((x) => x.occupant_kind === 'pane' && x.occupant === s.occupant)!;
        results[i] = { paneid: s.occupant, outcome: 'already', seatId: seat.id, handle: seat.handle, autoSuffixed: seat.handle_named === 0 };
        seatOf.set(s.occupant, seat.id);
        continue;
      }
      if (!v.eligible) {
        results[i] = { paneid: s.occupant, outcome: 'refused', reason: v.reason! };
        continue;
      }
      try {
        const added = tx.addSeat(
          room.id,
          {
            recipe_id: row!.recipe_id,
            handle: s.handle,
            policy: s.policy,
            occupant: s.occupant,
            autoLead: false,
            ...(s.handle ? {} : { avoid: typedHandles }),
          },
          { actor },
        );
        entries.push(...added.entries);
        const seat = added.result;
        results[i] = { paneid: s.occupant, outcome: 'seated', seatId: seat.id, handle: seat.handle, autoSuffixed: seat.handle_named === 0 };
        seatOf.set(s.occupant, seat.id);
      } catch (e) {
        if (e instanceof RoomError && e.field === 'handle') {
          results[i] = { paneid: s.occupant, outcome: 'refused', reason: 'handle-taken' };
          continue;
        }
        throw e;
      }
    }
    /* THE LEAD, named once: the one asked for; else, in a room with none, the
       first persistent row seated in REQUEST order (the store's rule 3, applied
       to the list the user saw); else the current lead is kept. */
    const firstPersistent = rows.findIndex((r, i) => r.s.policy === 'persistent' && results[i]?.outcome === 'seated');
    const leadSeat =
      (inp.lead !== null ? seatOf.get(inp.lead) : undefined) ??
      (room.lead_seat === null && firstPersistent >= 0 ? seatOf.get(rows[firstPersistent].s.occupant) : undefined);
    if (leadSeat && leadSeat !== room.lead_seat) {
      try {
        entries.push(...tx.updateRoom(room.id, { lead_seat: leadSeat }, { actor }).entries);
      } catch (e) {
        if (e instanceof RoomError) {
          throw new FieldError(e.status, e.message, 'lead');
        }
        throw e;
      }
    }
    room = table.getRoom(room.id)!;
    const refused = results.some((r) => r.outcome === 'refused');
    const commit = !inp.dryRun && !refused;
    for (const r of results) {
      if (r.outcome === 'seated' && !commit) {
        (r as { outcome: string }).outcome = 'would-seat';
      }
    }
    const lead = room.lead_seat ? table.getSeat(room.lead_seat) : undefined;
    const value = {
      room: !commit && !existing ? { ...room, id: null } : room,
      seats: table.listSeats(room.id).map((seat) => deriveSeat(seat, project, room)),
      entries,
      results,
      lead: lead ? { seatId: lead.id, handle: lead.handle, paneid: lead.occupant } : null,
      roomId: room.id,
      refused,
    };
    if (!commit) {
      throw new Rollback(value);
    }
    return value;
  });

  const { roomId, refused, ...view } = out.value;
  /* Nothing was written on either path below, so neither carries line
     entries (their ids were rolled back and will be reused). */
  if (refused) {
    const n = view.results.filter((r) => r.outcome === 'refused').length;
    return {
      status: 409,
      body: {
        error: `${n} of ${view.results.length} can't be seated — nothing was written`,
        field: 'seats',
        results: view.results,
        lead: view.lead,
        ...(inp.dryRun ? { dryRun: true } : {}),
      },
    };
  }
  if (!out.committed) {
    return { status: 200, body: { ...view, entries: [], dryRun: true, replayed: false } };
  }
  deps.log(
    `room ${roomId}: assembled ${view.results.filter((r) => r.outcome === 'seated').length} seat(s)` +
      ` (${view.results.filter((r) => r.outcome === 'already').length} already) by ${actor === 'user' ? 'user' : actor.seatId}`,
  );
  {
    /* room welcome, Owner 2026-10-05: each newly seated pane is told where to answer */
    const wroom = table.getRoom(roomId);
    for (const r of view.results) {
      const seat = r.outcome === 'seated' ? table.getSeat((r as { seatId: string }).seatId) : undefined;
      if (wroom && seat) seatWelcome.welcomeSeat(wroom, seat, deps.log);
    }
  }
  /* THE OPENING MESSAGE, after the commit, through the line's own send path.
     A new room addresses @room; an existing room only the NEW seats — the
     incumbents already got the arrival fact (§3.3). */
  let entries = view.entries;
  if (inp.conventions !== null) {
    const room = table.getRoom(roomId)!;
    const fresh = new Set(view.results.filter((r) => r.outcome === 'seated').map((r) => (r as { seatId: string }).seatId));
    const recipients = existing ? recipientsOf(roomId, 'room', actor).filter((s) => fresh.has(s.id)) : recipientsOf(roomId, 'room', actor);
    if (recipients.length) {
      const one = existing && recipients.length === 1 ? recipients[0].handle : 'room';
      const words: LineInput = {
        kind: 'chat',
        body: inp.conventions,
        target: one,
        ...(existing && recipients.length > 1 ? { meta: { to: recipients.map((s) => s.handle) } } : {}),
      };
      const sent = sendWords(room, words, recipients, actor, deps, { carried: false, envBody: inp.conventions, named: [] });
      entries = [...entries, ...sent.entries];
    }
  }
  const body = { ...view, entries, replayed: false };
  assembled.set(inp.key, { at: Date.now(), hash, body });
  return { status: 200, body };
}

/* ------------------------------------------------------------------ diag ---- */

async function diag(deps: RoomRouteDeps): Promise<Record<string, unknown>> {
  sweepConfirms();
  const project = await deps.projector();
  return {
    rooms: table.listRooms().map((room) => ({
      id: room.id,
      state: room.state,
      lead_seat: room.lead_seat,
      idle_ms: room.idle_ms,
      seats: table.listSeats(room.id).map((s) => {
        const d = deriveSeat(s, project, room);
        return {
          id: s.id,
          handle: s.handle,
          policy: s.policy,
          occupant_kind: s.occupant_kind,
          occupant: s.occupant,
          status: d.status,
          sessionState: (d.occupant as { state?: string } | null)?.state ?? null,
          held: (d.occupant as { held?: roomTyper.Held } | null)?.held ?? null,
        };
      }),
      lineCounts: table.lineCounts(room.id),
    })),
    refusedCommands: [...refusedCommands],
    pendingConfirms: confirms.size,
    subscribers: subscriberCount(),
    /* W3-interim: per-pane typed-injection queue depth + last result. Counts only. */
    typing: roomTyper.diag(),
    /* Gate G item 2: read-state records held in memory. Counts only. */
    reads: roomReads.diag(),
  };
}

/* ---------------------------------------------------- the pane-token door ---- */
/*
 * briefing-table-mcp §4.1: what a PANE TOKEN may reach, and nothing else.
 * Default deny: handleAgent answers only the routes below and returns false
 * for everything else, which index.ts answers 403 `not_for_pane_token`.
 *
 *   GET  /api/rooms              filtered to the pane's seated rooms
 *   GET  /api/rooms/:id          seated rooms only
 *   GET  /api/rooms/:id/line     seated rooms only
 *   POST /api/rooms/:id/line     as its seat; a body `from` must be the pane
 *   GET|POST /api/rooms/:id/assets   seated; an upload is its seat's
 *
 * Seated = an ACTIVE seat in an OPEN room. A room that does not exist and a
 * room the pane is not seated in get the SAME bytes (`not_seated` + the
 * pane's own rooms), so a token cannot probe which rooms exist.
 */

/** The pane's active seats in open rooms: every room a pane token reaches. */
export function seatedRooms(paneid: string): Array<{ room: Room; seat: RoomSeat }> {
  return table.roomsForPane(paneid).filter((h) => h.room.state === 'open');
}

/** The one `not_seated` answer. It names nothing about the room asked for —
 *  only the caller's own rooms — which is what makes it byte-identical for a
 *  room that does not exist and one the caller holds no seat in. */
export function notSeated(paneid: string): Record<string, unknown> {
  return {
    ok: false,
    error: 'not_seated',
    message: 'you hold no seat in that room',
    rooms: seatedRooms(paneid).map((h) => ({ id: h.room.id, name: h.room.name })),
  };
}

/** §2.1's `room` argument (for `bt`): an id or a name, resolved ONLY among
 *  the caller's seats; omitted = the one seated room. */
export function resolveSeatedRoom(
  paneid: string,
  ref?: string | null,
): { ok: true; room: Room; seat: RoomSeat } | { ok: false; body: Record<string, unknown> } {
  const held = seatedRooms(paneid);
  let hits = held;
  if (ref !== undefined && ref !== null && ref !== '') {
    const byId = held.filter((h) => h.room.id === ref);
    /* an id PREFIX of 8+ chars also names a room, but only among the rooms THIS pane holds a seat in (the doorbell ring prints the id's first 8 characters and an agent copies them);
       a prefix that fits two of its rooms matches neither, so it can never pick the wrong one */
    const byPrefix = ref.length >= 8 ? held.filter((h) => h.room.id.startsWith(ref.toLowerCase())) : [];
    hits = byId.length ? byId : held.filter((h) => h.room.name.toLowerCase() === ref.toLowerCase());
    if (!hits.length && byPrefix.length === 1) hits = byPrefix;
  }
  if (hits.length === 1) {
    return { ok: true, room: hits[0].room, seat: hits[0].seat };
  }
  if (hits.length === 0) {
    return { ok: false, body: notSeated(paneid) };
  }
  return {
    ok: false,
    body: {
      ok: false,
      error: 'ambiguous_room',
      message: 'you hold seats in several rooms: name one',
      rooms: hits.map((h) => ({ id: h.room.id, name: h.room.name })),
    },
  };
}

/** The seat a pane-token request acts as in `room`. A `from` that names any
 *  other pane is refused, never silently replaced (§4.1). */
function agentSeatActor(room: Room, from: unknown, paneid: string): RoomActor {
  if (from !== undefined && from !== null && !paneTokens.isOwnPane(from, paneid)) {
    throw new AgentError(403, 'from_mismatch', 'a pane token speaks as its own pane; from names another', { field: 'from' });
  }
  const held = seatedRooms(paneid).find((h) => h.room.id === room.id);
  if (!held) {
    throw new AgentError(403, 'not_seated', 'you hold no seat in that room', { rooms: notSeated(paneid).rooms });
  }
  return { seatId: held.seat.id };
}

/** GET /api/rooms/:id's answer (both doors). */
async function roomDetail(room: Room, deps: RoomRouteDeps, userKey?: string): Promise<Record<string, unknown>> {
  const project = await deps.projector();
  const view = deps.agent ? agentRoomView(room, project) : roomView(room, project, userKey);
  const lead = view.seats.find((s) => s.id === room.lead_seat) ?? null;
  return { ...view, lead, code_folder: await codeFolderView(room.id) }; // step C: the family's code folder, or null
}

/**
 * [digest] room_read's "only what is addressed to me" (Owner 2026-10-07, #5): a chat /
 * command / attachment / voice line written by someone else, not to `@room`, whose stored
 * target is this seat (named first, or the lead by default) OR that @-names it anywhere
 * outside code (a line naming several seats stores only the first as its target).
 */
export function addressedTo(e: RoomLineEntry, seat: { id: string; handle: string }): boolean {
  if (!['chat', 'command', 'attachment', 'voice'].includes(e.kind) || e.author_seat === seat.id || e.target === 'room') {
    return false;
  }
  if (e.target_seat === seat.id) {
    return true;
  }
  /* [address only] a line reaches every seat it @-names ANYWHERE outside code (room-commands
     parse), but stores only the first as its target: look for this seat's @handle in the prose */
  const h = seat.handle.toLowerCase();
  return withoutCode(e.body ?? '')
    .split(' ')
    .some((w) => addressOf(w.replace(/^[(\[{"']+/, '')) === h);
}

/** The seat `for` / `for_pane` names in this room, or null when neither is given. */
function forSeat(room: Room, q: URLSearchParams, own: RoomSeat | null): RoomSeat | null {
  const forPane = q.get('for_pane');
  const f = q.get('for');
  if (!f && !forPane) {
    return null;
  }
  if (forPane) {
    const held = seatedRooms(forPane).find((h) => h.room.id === room.id);
    if (!held) {
      throw new RoomError(400, 'for_pane holds no seat in this room', 'for_pane');
    }
    return held.seat;
  }
  if (f === 'me') {
    if (!own) {
      throw new RoomError(400, 'for=me needs a pane token (or pass for_pane=<paneid>)', 'for');
    }
    return own;
  }
  const seat = table.listSeats(room.id).find((s) => s.id === f || s.handle.toLowerCase() === String(f).toLowerCase());
  if (!seat) {
    throw new RoomError(400, 'for names no seat in this room', 'for');
  }
  return seat;
}

const FOR_SCAN_MAX = 20_000;
/** Page through the line keeping only lines addressed to `seat`: forward from `since`, or
 *  the newest `limit` (before `before`). Scans at most FOR_SCAN_MAX rows; `next_since` is
 *  where a forward scan stopped, so a capped read with nothing found still moves on. */
function listAddressed(room: Room, seat: RoomSeat, q: URLSearchParams): { entries: RoomLineEntry[]; next_since?: number; truncated?: true } {
  const since = num(q.get('since'));
  const lim = num(q.get('limit')) ?? 100;
  if (!Number.isInteger(lim) || lim < 1 || lim > 1000) {
    throw new RoomError(400, 'limit is 1-1000', 'limit');
  }
  const kind = q.get('kind');
  const out: RoomLineEntry[] = [];
  let scanned = 0;
  if (since !== null) {
    let cursor = since;
    for (;;) {
      const page = table.listLine(room.id, { since: cursor, kind, limit: 1000 });
      for (const e of page) {
        cursor = e.id;
        if (addressedTo(e, seat)) {
          out.push(e);
          if (out.length >= lim) {
            return { entries: out, next_since: cursor };
          }
        }
      }
      scanned += page.length;
      if (page.length < 1000) {
        return { entries: out };
      }
      if (scanned >= FOR_SCAN_MAX) {
        return { entries: out, next_since: cursor, truncated: true };
      }
    }
  }
  let before = num(q.get('before'));
  for (;;) {
    const page = table.listLine(room.id, { before, kind, limit: 1000 });
    for (let i = page.length - 1; i >= 0; i--) {
      if (addressedTo(page[i], seat)) {
        out.push(page[i]);
        if (out.length >= lim) {
          return { entries: out.reverse() };
        }
      }
    }
    scanned += page.length;
    if (page.length < 1000 || scanned >= FOR_SCAN_MAX) {
      return { entries: out.reverse(), ...(page.length >= 1000 ? { truncated: true as const } : {}) };
    }
    before = page[0].id;
  }
}

/** GET /api/rooms/:id/line's answer (both doors). `own` = the pane-token door's seat. */
async function readLine(req: IncomingMessage, room: Room, own: RoomSeat | null = null, principal: Principal | null = null): Promise<Record<string, unknown>> {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  const seat = forSeat(room, q, own);
  if (seat) {
    const got = listAddressed(room, seat, q);
    if (own && own.id === seat.id) roomReads.markPulled(room.id, got.entries.map((e) => e.id), seat.id); // the agent pulled its own lines: that is the read
    await roomFabric.refreshReads(room);
    const xp = table.xpostViews(got.entries, room.id);
    return {
      entries: got.entries.map((e) => (xp.has(e.id) ? { ...withReads(e), xpost: xp.get(e.id) } : withReads(e))),
      for: seat.handle,
      ...(got.next_since !== undefined ? { next_since: got.next_since } : {}),
      ...(got.truncated ? { truncated: true } : {}),
    };
  }
  const page = {
    since: num(q.get('since')),
    before: num(q.get('before')),
    kind: q.get('kind'),
    seat: q.get('seat'),
    limit: num(q.get('limit')),
  };
  /* ?to=me: the TO-ME page is cut AFTER the rule (web/to-me.mjs, the same module the page filters with), so older lines to the person are reached however many
     agent-to-agent lines lie between; with `limit`/`before`/`since` as usual. A page shorter than `limit` = no more to the person in that direction. */
  const toMe = q.get('to') === 'me';
  if (q.get('to') !== null && q.get('to') !== '' && !toMe) {
    throw new RoomError(400, 'to is "me"', 'to');
  }
  const handle = userHandleOf(pictureOwner(principal)).toLowerCase();
  const entries = toMe
    ? table.listLineWhere(room.id, page, (e) => !isHiddenFact(e) && isToMe(toMeFlags(e), e.kind === 'fact' && factIsToMe({ toUser: false, mentions: mentionsIn(e.body) }, handle)))
    : table.listLine(room.id, page);
  await roomFabric.refreshReads(room); // F4: the fabric's ack ladder, upgrade-only, cached 5 s
  /* WORKGROUPS: a line that was cross-posted says how it reads HERE (xpost) */
  const xp = table.xpostViews(entries, room.id);
  return { entries: entries.map((e) => (xp.has(e.id) ? { ...withReads(e), xpost: xp.get(e.id) } : withReads(e))) };
}

/**
 * A /api/rooms* request on a PANE TOKEN (index.ts resolved it; `paneid` is
 * the token's pane). True when answered; false = not on the allow-list.
 */
export async function handleAgent(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  paneid: string,
  deps: RoomRouteDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const agentDeps: RoomRouteDeps = { ...deps, human: false, agent: { paneid } };
  if (route === '/api/rooms') {
    if (method !== 'GET') {
      return false;
    }
    try {
      /* the pane's seated rooms PLUS the rest of their families, so room_post's
         client can resolve a family room by name to escalate into it (post-only:
         every other route still answers not_seated) [family escalate] Owner 2026-10-05 */
      const mine = new Set(seatedRooms(paneid).flatMap((h) => table.familyRoomIds(h.room.id)));
      const project = await deps.projector();
      sendJson(res, 200, table.listRooms().filter((r) => mine.has(r.id)).map((r) => agentRoomView(r, project)));
    } catch (e) {
      agentFail(res, e, deps, `GET ${route}`);
    }
    return true;
  }
  if (!route.startsWith('/api/rooms/')) {
    return false;
  }
  const parts = route.slice('/api/rooms/'.length).split('/').map(safeDecode);
  const sub = parts.slice(1);
  const read = method === 'GET';
  const allowed =
    (sub.length === 0 && read) ||
    (sub.length === 1 && (sub[0] === 'line' || sub[0] === 'assets') && (read || method === 'POST')) ||
    (sub.length === 1 && sub[0] === 'guide' && read) || // [room guide]
    (sub.length === 3 && sub[0] === 'lines' && sub[2] === 'claim' && method === 'POST') || // [reply turns]
    (sub[0] === 'tasks' && agentMayCall(method, sub.slice(1))); // Tasks: per ROUTE, the person-only verbs excluded
  if (!allowed) {
    return false;
  }
  try {
    const held = seatedRooms(paneid).find((h) => h.room.id === parts[0]);
    if (!held && sub.length === 1 && sub[0] === 'line' && method === 'POST') {
      await escalateLine(req, res, paneid, parts[0], agentDeps);
      return true;
    }
    if (!held) {
      sendJson(res, 403, notSeated(paneid));
      return true;
    }
    const room = held.room;
    if (sub.length === 0) {
      const detail = await roomDetail(room, agentDeps);
      sendJson(res, 200, replyTurns.mode() === 'enforce' ? { ...detail, my_turns: myTurnsOf(held.seat) } : detail); // [reply turns]
      return true;
    }
    if (sub[0] === 'tasks') {
      if (await handleTasks(tasksCtx(agentDeps), req, res, room, sub, { human: false, seat: held.seat, paneid })) {
        return true;
      }
    }
    if (sub[0] === 'lines') {
      const b = await readObject(req);
      sendJson(res, 200, claimTurn(room, sub[1], agentSeatActor(room, b.from, paneid), b)); // [reply turns]
      return true;
    }
    if (sub[0] === 'guide' && sub.length === 1 && method === 'GET') {
      sendGuide(res, room); // [room guide] a seated pane reads its room's guide
      return true;
    }
    if (sub[0] === 'assets') {
      if (!(await handleAssets(req, res, room, sub, agentDeps))) {
        sendJson(res, 404, { error: 'no such rooms route', field: 'route' });
      }
      return true;
    }
    if (read) {
      sendJson(res, 200, await readLine(req, room, held.seat)); // for=me reads as this seat
      return true;
    }
    const b = await readObject(req);
    const input = lineInput(b);
    const actor = agentSeatActor(room, b.from, paneid);
    const links = lineLinks(room, b.links);
    const rate = paneTokens.takeRoomPost(paneid);
    if (!rate.ok) {
      throw new AgentError(429, 'rate_limited', `at most ${paneTokens.ROOM_POST_PER_MIN} room posts a minute`, { retry_after: rate.retryAfter });
    }
    sendJson(res, 200, postLineAs(room, actor, input.text, { ref: input.ref, confirm: input.confirm, replyTo: input.replyTo, links }, agentDeps));
    return true;
  } catch (e) {
    agentFail(res, e, deps, `${method} ${route}`);
    return true;
  }
}

/**
 * POST .../line to a room the pane holds NO seat in [family escalate] (Owner
 * 2026-10-05: a workgroup lead must be able to raise something in the root
 * room). Allowed ONLY for an open room of the pane's own FAMILY (by id or by
 * name). The line is authored by the pane's own seat, written in ITS room and
 * cross-posted into the named room by the ordinary family rules; with no
 * @address leading, it is addressed to the named room's lead. Anything else is
 * the same refusal for a room that does not exist and one of another family,
 * now saying what IS allowed. Human-only rules and the room_post rate are the
 * ordinary door's, unchanged.
 */
async function escalateLine(req: IncomingMessage, res: ServerResponse, paneid: string, ref: string, deps: RoomRouteDeps): Promise<void> {
  const mine = seatedRooms(paneid);
  const fam = new Map<string, Room>();
  for (const h of mine) {
    for (const id of table.familyRoomIds(h.room.id)) {
      const r = table.getRoom(id);
      if (r && r.state === 'open') {
        fam.set(id, r);
      }
    }
  }
  const named = fam.get(ref) ?? [...fam.values()].find((r) => r.name.toLowerCase() === ref.toLowerCase());
  const author = named ? mine.find((h) => table.familyRoomIds(h.room.id).includes(named.id)) : undefined;
  if (!named || !author) {
    const names = [...fam.values()].map((r) => `"${r.name}"`);
    if (fam.size <= mine.length) {
      sendJson(res, 403, notSeated(paneid)); // a family of its own seats alone: nothing to escalate to, the plain answer
      return;
    }
    sendJson(res, 403, {
      ...notSeated(paneid),
      message:
        'you hold no seat in that room. You can post to your own room, or escalate: start the line with @lead, a handle of any seat in your room family, or a room alias' +
        (names.length ? `, or name one of the family's rooms (${names.join(', ')})` : '') +
        '. A room outside your family is not reachable.',
    });
    return;
  }
  const b = await readObject(req);
  const input = lineInput(b);
  const actor = agentSeatActor(author.room, b.from, paneid);
  const links = lineLinks(author.room, b.links);
  const lead = named.lead_seat ? table.getSeat(named.lead_seat) : undefined;
  if (named.id !== author.room.id && !lead && leadingAddress(input.text) === null) {
    throw new AgentError(409, 'no_lead', `"${named.name}" has no lead to address: start the line with @<handle> of a seat there`);
  }
  const rate = paneTokens.takeRoomPost(paneid);
  if (!rate.ok) {
    throw new AgentError(429, 'rate_limited', `at most ${paneTokens.ROOM_POST_PER_MIN} room posts a minute`, { retry_after: rate.retryAfter });
  }
  sendJson(res, 200, postLineAs(author.room, actor, input.text, {
    ref: input.ref, confirm: input.confirm, replyTo: input.replyTo, links,
    ...(named.id !== author.room.id && lead ? { escalateTo: lead } : {}),
  }, deps));
}

/** `fail` for the pane-token door (review P2-3): a request error answers as
 *  always; anything else is OUR defect and answers a bare 500 — its message
 *  is logged, never sent, since it can name paths, rows or another pane. */
function agentFail(res: ServerResponse, e: unknown, deps: RoomRouteDeps, what: string): void {
  if (e instanceof AgentError || e instanceof RoomError || e instanceof FieldError) {
    fail(res, e);
    return;
  }
  deps.log(`pane token ${what}: handler threw: ${(e as Error)?.stack ?? String(e)}`);
  sendJson(res, 500, { ok: false, error: 'internal_error' });
}

/* ---------------------------------------------------------------- routes ---- */

/**
 * A panel frame requested with a FRAME TOKEN and no other credential
 * (panel-proxy.ts). index.ts calls this AHEAD of the auth gate, only when the
 * request is not otherwise authenticated. Answers ONLY a `/frame/t/<token>/…`
 * path — anything else returns false and meets the gate as before, so a token
 * can never open another route. A token that is not ours or has expired is a
 * 401 page ("reload the room"). Never logs the token.
 */
export function frameByToken(req: IncomingMessage, res: ServerResponse, route: string, log: (l: string) => void): boolean {
  const fp = route.startsWith('/api/rooms/') ? parseFramePath(route) : null;
  if (!fp || fp.token === null) {
    return false;
  }
  const check = checkFrameToken(fp.token, fp.roomId, fp.panelId);
  if (check !== 'ok') {
    tokenRefused(res, check);
    return true;
  }
  const panel = table.getPanel(fp.panelId);
  if (!panel || panel.room_id !== fp.roomId) {
    sendJson(res, 404, { error: 'no such panel in this room', field: 'panel' });
    return true;
  }
  proxyFrame(req, res, panel, fp.tail, log, fp.prefix);
  return true;
}

function num(v: string | null): number | null {
  return v === null || v === '' ? null : Number(v);
}

/**
 * Handle a rooms route. Returns true when the request was answered.
 * `principal` is the identity principal (null in legacy mode). It is taken so
 * that, once identity mode can show a human principal, an approval can count
 * as proof (§0.1 Q5); Phase 1 records authorship from `from` only.
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  principal: Principal | null,
  deps: RoomRouteDeps,
): Promise<boolean> {
  if (
    route !== '/api/rooms' &&
    !route.startsWith('/api/rooms/') &&
    route !== '/api/diag/rooms' &&
    route !== '/api/apps' &&
    !route.startsWith('/api/apps/')
  ) {
    return false;
  }
  const method = req.method ?? 'GET';
  try {
    /* THE TOOL REGISTRY (the design notes §4.4, S4 engine half)
       [rooms/apps-engine]: /api/apps* is not room-scoped, but shares the
       room's human-credential rule and the same table/RoomError vocabulary,
       so it lives here rather than a separate module. Registration and
       approval are human-only (§4.4: "A tool is registered by a human");
       the catalog itself (GET /api/apps) is any authenticated read, like a
       room list. */
    if (route === '/api/apps') {
      if (method === 'GET') {
        /* every app the engine knows [ticket]: the registry (each with its
           `state` and `actions`), and — for a PERSON, since browsing the
           tools folder is human-only — a held app's pending change and the
           folders not registered yet (`candidates`, state
           'unregistered-candidate'). A bearer gets {apps} as before. */
        const list = await apps.catalog();
        if (!deps.human) {
          sendJson(res, 200, { apps: list });
          return true;
        }
        for (const a of list) {
          a.pending = a.state === 'needs-approval' ? (() => { try { return apps.appDiff(a.slug); } catch { return null; } })() : null;
        }
        const c = apps.listCandidates();
        sendJson(res, 200, {
          apps: list,
          tools_dir: c.tools_dir,
          candidates: c.candidates.map((x) => ({ ...x, state: 'unregistered-candidate', rooms: [] })),
        });
        return true;
      }
      if (method === 'POST') {
        requireHuman(deps, 'registering an app');
        const b = await readObject(req);
        if (typeof b.root !== 'string' || !b.root) {
          throw new FieldError(400, 'root is the candidate\'s folder path', 'root');
        }
        const expected = expectedSha(b);
        const registeredBy = pictureOwner(principal).key;
        let row;
        try {
          row = apps.registerApp(b.root, registeredBy, expected);
        } catch (e) {
          if (e instanceof apps.AppChangedError) {
            sendJson(res, 409, { error: 'changed', sha256: e.sha256 });
            return true;
          }
          throw e;
        }
        /* Look the entry up by the slug the registry stored, never by
           re-splitting the caller's path (a Windows root has backslashes). */
        sendJson(res, 200, { app: await apps.getCatalogEntry(row.slug) });
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (route === '/api/apps/monitor') {
      /* the tool manager's global setting [tool-manager]: anyone signed in reads it; only a person's window writes it */
      if (method === 'GET') {
        sendJson(res, 200, toolManager.monitorSettings());
        return true;
      }
      if (method === 'PATCH') {
        requireHuman(deps, 'the tool monitor period');
        sendJson(res, 200, toolManager.setMonitorSettings(await readObject(req)));
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (route === '/api/apps/candidates') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      requireHuman(deps, 'browsing app candidates');
      sendJson(res, 200, apps.listCandidates());
      return true;
    }
    {
      /* WHAT CHANGED, for the Approve dialog (the design system: "Approve is not blind") */
      const m = /^\/api\/apps\/([^/]+)\/diff$/.exec(route);
      if (m) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return true;
        }
        requireHuman(deps, 'reviewing an app change');
        sendJson(res, 200, apps.appDiff(safeDecode(m[1])));
        return true;
      }
    }
    {
      /* SETTINGS → APPS [ticket]: register a candidate (or an unregistered
         app) by slug, and unregister. Human-only, like approve. */
      const m = /^\/api\/apps\/([^/]+)\/(register|unregister)$/.exec(route);
      if (m) {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return true;
        }
        const slug = safeDecode(m[1]);
        const who = pictureOwner(principal).key;
        if (m[2] === 'register') {
          requireHuman(deps, 'registering an app');
          const expected = expectedSha(await readObject(req));
          let row;
          try {
            row = apps.registerBySlug(slug, who, expected);
          } catch (e) {
            if (e instanceof apps.AppChangedError) {
              sendJson(res, 409, { error: 'changed', sha256: e.sha256 });
              return true;
            }
            throw e;
          }
          deps.log(`apps: ${row.slug} registered by ${who}`);
          sendJson(res, 200, { app: await apps.getCatalogEntry(row.slug) });
          return true;
        }
        requireHuman(deps, 'unregistering an app');
        const ub = await readObject(req);
        if (ub.superseded_by !== undefined && ub.superseded_by !== null && typeof ub.superseded_by !== 'string') {
          throw new FieldError(400, 'superseded_by is an app slug', 'superseded_by');
        }
        apps.unregisterApp(slug, who, typeof ub.superseded_by === 'string' && ub.superseded_by ? ub.superseded_by : null); // [app supersede] Owner 2026-10-05
        sendJson(res, 200, { app: await apps.getCatalogEntry(slug) });
        return true;
      }
    }
    {
      /* THE TOOL MANAGER [tool-manager]: any signed-in caller (a seat's bearer too) may ask the engine to start/stop/restart a
         registered tool and read its manage status; only a PERSON pins the lifecycle scripts the engine is allowed to run. */
      const m = /^\/api\/apps\/([^/]+)\/(start|stop|restart|manage|pin-scripts)$/.exec(route);
      if (m) {
        const slug = safeDecode(m[1]);
        const who = pictureOwner(principal).key;
        if (m[2] === 'manage') {
          if (method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
          }
          sendJson(res, 200, await toolManager.statusOf(slug));
          return true;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return true;
        }
        const b = await readObject(req);
        if (m[2] === 'pin-scripts') {
          requireHuman(deps, 'pinning a tool\'s start/stop scripts');
          sendJson(res, 200, toolManager.pinScripts(slug, who));
          return true;
        }
        if (b.reason !== undefined && b.reason !== null && (typeof b.reason !== 'string' || b.reason.length > 200)) {
          throw new FieldError(400, 'reason is a short sentence (at most 200 characters)', 'reason');
        }
        const out = await toolManager.manage(slug, m[2] as toolManager.Verb, who, typeof b.reason === 'string' && b.reason ? b.reason : null);
        sendJson(res, out.ok ? 200 : 502, out);
        return true;
      }
    }
    {
      const m = /^\/api\/apps\/([^/]+)\/approve$/.exec(route);
      if (m) {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return true;
        }
        const slug = safeDecode(m[1]);
        requireHuman(deps, 'approving an app');
        const expected = expectedSha(await readObject(req));
        try {
          apps.approveApp(slug, expected);
        } catch (e) {
          if (e instanceof apps.AppChangedError) {
            sendJson(res, 409, { error: 'changed', sha256: e.sha256 });
            return true;
          }
          throw e;
        }
        sendJson(res, 200, { app: await apps.getCatalogEntry(slug) });
        return true;
      }
    }
    if (route.startsWith('/api/apps/') || route === '/api/apps') {
      sendJson(res, 404, { error: 'no such apps route', field: 'route' });
      return true;
    }
    if (route === '/api/diag/rooms') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      sendJson(res, 200, await diag(deps));
      return true;
    }
    if (route === '/api/rooms/commands') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      sendJson(res, 200, { commands: ROOM_COMMANDS, notInBuild: NOT_IN_BUILD, lineKinds: LINE_KINDS });
      return true;
    }
    /* ROOM TEMPLATES (engine/room-template.ts): create a NEW room from a document, in one transaction. The person's act (a window), never an agent's. */
    if (route === '/api/rooms/from-template') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      requireHuman(deps, 'creating a room from a template');
      const b = await readObject(req);
      if (b.doc === undefined) throw new FieldError(400, 'send the template as `doc`', 'doc');
      try {
        sendJson(res, 201, roomTemplate.createFromTemplate(b.doc, { idempotencyKey: typeof b.idempotencyKey === 'string' ? b.idempotencyKey : null }));
      } catch (e) {
        if (e instanceof roomTemplate.TemplateError) {
          throw new FieldError(e.code === 'recipe_conflict' ? 409 : 400, e.message, e.field ?? 'doc', { code: e.code, ...e.extra });
        }
        throw e;
      }
      return true;
    }
    if (route === '/api/rooms/assemble') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      const r = await assemble(await readObject(req), deps);
      sendJson(res, r.status, r.body);
      return true;
    }
    if (route === '/api/rooms/idle-rest') {
      /* SYSTEM-wide idle-rest settings (Owner 2026-10-04,
         item 6). Anyone signed in reads; only a person's window writes. */
      if (method === 'GET') {
        sendJson(res, 200, idleRestSettings());
        return true;
      }
      if (method === 'PATCH') {
        requireHuman(deps, 'the idle-rest settings');
        let patch;
        try {
          patch = validIdleRestPatch(await readObject(req));
        } catch (e) {
          throw e instanceof IdleRestError ? new FieldError(400, e.message, e.field) : e;
        }
        const next = { ...idleRestSettings(), ...patch };
        table.setEngineSetting('idleRest', next);
        deps.log(`idle rest settings now ${JSON.stringify(next)}`);
        sendJson(res, 200, next);
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (route === '/api/rooms/file-store' && method === 'GET') {
      /* Whether the room file store is set up and where its address comes from (env | setting | none). Never fetches it. */
      let base: string | null = null;
      try {
        base = shareBaseNow();
      } catch {
        base = null;
      }
      sendJson(res, 200, { configured: base !== null, source: shareSource(), base });
      return true;
    }
    if (route === '/api/rooms/seat-restart') {
      /* Whether a room lead may restart its members (`/seat restart`). Anyone signed in reads; only a person's window writes. */
      if (method === 'GET') {
        sendJson(res, 200, seatSettings());
        return true;
      }
      if (method === 'PATCH') {
        requireHuman(deps, 'the seat-restart setting');
        let patch;
        try {
          patch = seatRestart.validSeatRestartPatch(await readObject(req));
        } catch (e) {
          throw e instanceof seatRestart.SeatRestartError ? new FieldError(400, e.message, e.field) : e;
        }
        const next = { ...seatSettings(), ...patch };
        table.setEngineSetting('seatRestart', next);
        deps.log(`seat restart settings now ${JSON.stringify(next)}`);
        sendJson(res, 200, next);
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (route === '/api/rooms/me/unread' && method === 'GET') {
      /* CROSS-FAMILY UNREAD [cross unread] (Owner 2026-10-06): every open room, this person's unread (what each room's default view
         shows, origin room only) and the newest counted line. A person's credential only, like PUT .../seen. */
      requireHuman(deps, 'your unread counts');
      const key = pictureOwner(principal).key;
      /* [concierge] its own field, never a pseudo-room: replies since this person last looked */
      const cg = await conciergeEngine.unreadFor(key);
      sendJson(res, 200, { rooms: table.unreadDetail(key), ...(cg ? { concierge: { ...cg, signoffs_pending: conciergeSignoff.list('pending', 100).length } } : {}) });
      return true;
    }
    if (route === '/api/rooms/me') {
      /* ROOM AUTHORSHIP v2: YOUR picture beside your lines, in every room.
         Per user: the identity account, else the shared-token user. Anyone
         signed in reads it; only a person's own window (cookie) writes it. */
      const who = pictureOwner(principal);
      const key = who.key;
      const picture = (): string | null => table.getUserPicture(key) ?? (key !== 'user' ? table.getUserPicture('user') : null);
      if (method === 'GET') {
        /* ==== BUBBLE DISPLAY [rooms/bubbles]: bubbleTransparency + bubbleBlur ride along ==== */
        sendJson(res, 200, { name: who.name, picture: picture(), hiddenRooms: table.getHiddenRooms(key), handle: userHandleOf(who), ...table.getBubbleDisplay(key), enterSubmits: table.getEnterSubmits(key), voice: table.getUserVoice(key), palette: table.getUserPalette(key), tones: table.getUserTones(key), roomColors: table.getUserRoomColors(key), wash: table.getWash(key), color: table.getUserColor(key) });
        return true;
      }
      if (method === 'PATCH') {
        requireHuman(deps, 'your picture, @name, hidden rooms, bubble display and voice settings');
        const b = await readObject(req);
        if (b.picture === undefined && b.hiddenRooms === undefined && b.handle === undefined && b.bubbleTransparency === undefined && b.bubbleBlur === undefined && b.enterSubmits === undefined && b.voice === undefined && b.palette === undefined && b.tones === undefined && b.roomColors === undefined && b.wash === undefined && b.color === undefined) {
          throw new FieldError(
            400,
            'a PATCH carries picture (a data: URL, or null), hiddenRooms (an array of room ids), handle (your @name, or null for the default), bubbleTransparency (0-60), bubbleBlur (0-16), enterSubmits (true/false) voice (your voice settings, per key), palette ({key, mode, custom?} or null) tones ({app: cobalt|green|orchid|violet|orange, or null}) roomColors ({roomId: swatch 0-11, or null}) wash ({dark:{spot,edge}, light:{spot,edge}} or null) and/or color (your own #rrggbb, or null)',
            'picture',
          );
        }
        /* All-or-nothing: hiddenRooms, the @name and the bubble display are
           checked BEFORE the picture is written, and the picture validates
           before it writes. */
        const hidden = b.hiddenRooms !== undefined ? table.checkHiddenRooms(b.hiddenRooms) : null;
        if (b.handle !== undefined) {
          table.checkUserHandle(b.handle);
        }
        /* BUBBLE DISPLAY [rooms/bubbles] */
        if (b.bubbleTransparency !== undefined) {
          table.checkBubbleValue('bubbleTransparency', b.bubbleTransparency);
        }
        if (b.bubbleBlur !== undefined) {
          table.checkBubbleValue('bubbleBlur', b.bubbleBlur);
        }
        if (b.enterSubmits !== undefined) {
          table.checkEnterSubmits(b.enterSubmits);
        }
        if (b.voice !== undefined) {
          table.checkUserVoice(b.voice); // room-voice v3.6: 400 names voice.<key>
        }
        /* GLOBAL COLOR PALETTE + TITLE-BAR TONES (hub V2): 400 names palette.<field> / tones.<app> */
        if (b.palette !== undefined) {
          table.checkUserPalette(key, b.palette);
        }
        if (b.tones !== undefined) {
          table.checkUserTones(b.tones);
        }
        if (b.roomColors !== undefined) {
          table.checkUserRoomColors(b.roomColors);
        }
        /* LINE WASH, SPOT | EDGE [hub-v2]: clamped to the track, 400 names wash.<mode>.<key> */
        const washPatch = b.wash !== undefined ? table.checkWash(b.wash) : undefined;
        /* YOUR COLOR (Owner [ref]): checked with the rest, before anything is written */
        if (b.color !== undefined) {
          table.checkUserColor(b.color);
        }
        const pic = b.picture !== undefined ? table.setUserPicture(key, b.picture) : picture();
        const hiddenRooms = hidden !== null ? table.setHiddenRooms(key, hidden) : table.getHiddenRooms(key);
        if (b.handle !== undefined) {
          table.setUserHandle(key, b.handle);
        }
        /* BUBBLE DISPLAY [rooms/bubbles] */
        const bubbles =
          b.bubbleTransparency !== undefined || b.bubbleBlur !== undefined
            ? table.setBubbleDisplay(key, { bubbleTransparency: b.bubbleTransparency, bubbleBlur: b.bubbleBlur })
            : table.getBubbleDisplay(key);
        const enterSubmits = b.enterSubmits !== undefined ? table.setEnterSubmits(key, b.enterSubmits) : table.getEnterSubmits(key);
        /* VOICE GLOBALS (room-voice v3.6): the voice service hears every connected room's new state. */
        const voice = b.voice !== undefined ? table.setUserVoice(key, b.voice) : { voice: table.getUserVoice(key), changed: false };
        if (voice.changed) {
          roomVoice.globalsChanged();
        }
        const palette = b.palette !== undefined ? table.setUserPalette(key, b.palette) : table.getUserPalette(key);
        const tones = b.tones !== undefined ? table.setUserTones(key, b.tones) : table.getUserTones(key);
        const roomColors = b.roomColors !== undefined ? table.setUserRoomColors(key, b.roomColors) : table.getUserRoomColors(key);
        const wash = washPatch !== undefined ? table.setWash(key, washPatch, b.wash) : table.getWash(key);
        const color = b.color !== undefined ? table.setUserColor(key, b.color) : table.getUserColor(key);
        sendJson(res, 200, { name: who.name, picture: pic, hiddenRooms, handle: userHandleOf(who), ...bubbles, enterSubmits, voice: voice.voice, palette, tones, roomColors, wash, color });
        /* ==== /BUBBLE DISPLAY ==== */
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (route === '/api/rooms') {
      if (method === 'GET') {
        const project = await deps.projector();
        const who = pictureOwner(principal).key;
        /* THE PERSON'S BADGE (workgroups, Owner 2026-10-04): lines newer than the
           last one you saw in each room, own or cross-posted in. Per person, so
           it rides the list the page already polls. */
        const unread = deps.human ? table.unreadCounts(who) : null;
        const last = table.lastLines(); // the Workbench card's last line [room last]
        const views = table.listRooms().map((room) => {
          const v0 = roomView(room, project, who);
          const v = last.has(room.id) ? { ...v0, last: last.get(room.id) } : v0;
          return unread ? withUnread(v, room.id, unread) : v;
        });
        sendJsonCached(req, res, 200, wantsArtRef(req) ? views.map(withArtRef) : views, ROOM_CACHE); // ETag + gzip [perf/poll-traffic]
        return true;
      }
      if (method === 'POST') {
        const b = await readObject(req);
        const actor = creatorFor(b.from, deps);
        /* THE CODE FOLDER (step C): a person's choice at creation. It is CHECKED before the room exists, so a refused folder leaves no empty room behind. */
        const cf = b.code_folder;
        if (cf !== undefined && cf !== null) {
          if (!deps.human) throw new FieldError(403, 'the code folder is the person\'s to choose', 'code_folder');
          if (b.parent_id) throw new FieldError(400, 'a workgroup uses its main room\'s code folder', 'code_folder');
          const chk = await checkCodeFolder(cf as Record<string, unknown>);
          if (!chk.ok) {
            sendJson(res, chk.status, { error: chk.reason, field: chk.field ?? 'code_folder', ...(chk.code ? { code: chk.code } : {}) });
            return true;
          }
        }
        const out = table.createRoom({ name: b.name, parent_id: b.parent_id, alias: b.alias }, { actor });
        deps.log(`room created: "${out.result.name}" (${out.result.id}) by ${out.result.created_by}`);
        if (cf !== undefined && cf !== null) {
          const set = await setCodeFolder(out.result.id, cf as Record<string, unknown>);
          if (!set.ok) {
            sendJson(res, set.status, { error: set.reason, field: set.field ?? 'code_folder', room_id: out.result.id, ...(set.code ? { code: set.code } : {}) });
            return true;
          }
          sendJson(res, 200, { ...(table.getRoom(out.result.id) ?? out.result), code_folder: set.codeFolder });
          return true;
        }
        sendJson(res, 200, out.result);
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }

    const parts = route.slice('/api/rooms/'.length).split('/').map(safeDecode);
    const room = requireRoom(parts[0]);
    const sub = parts.slice(1);

    if (sub.length === 0) {
      if (method === 'GET') {
        const who = pictureOwner(principal);
        let detail = await roomDetail(room, deps, who.key);
        /* DRAFT STAMP [ticket]: THIS person's draft updated_at, so a page sees
           another device's save in one poll. Added here, per caller, never in
           roomDetail/roomView (the room.state push and the agent door share those);
           the ETag is of the whole body, so a 304 can only match this caller's value. */
        /* [reply turns] the bearer + from door names its pane: ?for_pane=<paneid> */
        const turnPane = new URL(req.url ?? '/', 'http://x').searchParams.get('for_pane');
        if (turnPane && replyTurns.mode() === 'enforce') {
          const mine = seatedRooms(turnPane).find((h) => h.room.id === room.id);
          if (mine) {
            detail = { ...detail, my_turns: myTurnsOf(mine.seat) };
          }
        }
        if (deps.human) {
          detail.draftUpdatedAt = table.getRoomDraft(who.key, room.id).updatedAt;
          detail = withUnread(detail as { family: FamilyView }, room.id, table.unreadCounts(who.key)) as typeof detail;
        }
        sendJsonCached(req, res, 200, wantsArtRef(req) ? withArtRef(detail) : detail, ROOM_CACHE); // ETag + gzip [perf/poll-traffic]
        return true;
      }
      if (method === 'PATCH') {
        const b = await readObject(req);
        const patch: { name?: string; lead_seat?: string | null; mode?: string | null } = {};
        for (const k of ['name', 'lead_seat', 'mode'] as const) {
          if (b[k] !== undefined) {
            patch[k] = b[k];
          }
        }
        const verbs: RoomVerb[] = [
          ...(patch.name !== undefined ? (['rename-room'] as const) : []),
          ...(patch.lead_seat !== undefined ? (['set-lead'] as const) : []),
          ...(patch.mode !== undefined ? (['mode'] as const) : []),
        ];
        /* [room brief] Owner 2026-10-05: the brief is text or null (clear); the lead or the person. */
        if (b.brief !== undefined) {
          verbs.push('brief');
        }
        const actor = httpActor(room, b.from, verbs, deps);
        const out = Object.keys(patch).length || b.brief === undefined ? table.updateRoom(room.id, patch, { actor }) : null;
        const briefOut = b.brief !== undefined ? table.setRoomBrief(room.id, b.brief as string | null, { actor }) : null;
        sendJson(res, 200, { room: (briefOut ?? out)!.result, entries: [...(out?.entries ?? []), ...(briefOut?.entries ?? [])] });
        return true;
      }
    } else if (sub.length === 1 && sub[0] === 'settings' && method === 'PATCH') {
      /* ROOM SETTINGS (room round 3): colour + default feed + voice (room-voice
         §10.1). A person's view of the room, so a person's credential only;
         the store validates. */
      requireHuman(deps, 'room settings');
      const b = await readObject(req);
      /* ROOM CHARACTER [rooms/character]: the store checks the key's SHAPE;
         that it names real art is checked here, where the library and the
         pinned presets are reachable. A key that resolves to nothing is a 400,
         never a room wearing a hole. */
      if (typeof b.art === 'string') {
        let shaped = false;
        try {
          validArtKey(b.art);
          shaped = true;
        } catch (e) {
          if (!(e instanceof RoomArtError)) {
            throw e;
          }
        }
        if (shaped && !resolveArt(b.art, () => table.listLogos())) {
          throw new RoomError(400, `art: no art "${b.art.slice(0, 64)}" in the library or the presets`, 'art');
        }
      }
      const out = table.setRoomSettings(room.id, {
        color: b.color, feed_default: b.feed_default, voice: b.voice,
        art: b.art, art_tile: b.art_tile, wash_at: b.wash_at, bubble_glass: b.bubble_glass, pal: b.pal, pal_mode: b.pal_mode, design_follow: b.design_follow,
      });
      if (b.voice !== undefined) {
        roomVoice.settingsChanged(room.id); // the voice service never caches room settings (room-voice §9.3)
      }
      sendJson(res, 200, designView(out.result)); // {room, inherited}: a workgroup's answer carries its main room's design
      return true;
    } else if (sub.length === 1 && sub[0] === 'voice' && method === 'POST') {
      /* The voice panel's buttons (room-voice §9.3): the host calls this with
         the human's cookie; an agent's bearer never mutes or hangs up. */
      requireHuman(deps, 'voice mute / voice ID / open mic / disconnect');
      const b = await readObject(req);
      const out = roomVoice.humanAction(room.id, b.action, pictureOwner(principal).key);
      sendJson(res, out.status, out.body);
      return true;
    } else if (sub.length === 2 && sub[0] === 'voice' && sub[1] === 'stats' && method === 'GET') {
      /* Room voice stats (room-voice §10.3): a report source, no UI. */
      const out = roomVoice.stats(room.id, new URL(req.url ?? '', 'http://x').searchParams.get('days'));
      sendJson(res, out.status, out.body);
      return true;
    } else if (sub.length === 1 && sub[0] === 'draft') {
      /* ROOM DRAFT (Owner 2026-09-28): the composer's unsent text, per PERSON
         per ROOM, so it survives an F5, a move from PC to phone and an outage.
         A person's unsent words: read AND written on a window's credential
         only — an agent's bearer never sees them. Never logged. */
      requireHuman(deps, 'your draft');
      const who = pictureOwner(principal);
      /* THE REPLY TARGET rides the draft (room-reply-v1): `reply_to` on PUT
         (absent = unchanged, null = none, an id = an entry of this room);
         GET/PUT answer it plus `reply`, the quote as a send would capture it
         now (null when that entry is gone), so the chip survives a refresh. */
      const withQuote = (d: ReturnType<typeof table.getRoomDraft>) => {
        let reply: ReplyRef | null = null;
        const e = d.replyTo !== null ? table.getLineEntry(d.replyTo) : undefined;
        if (e && e.room_id === room.id) {
          reply = replyRefFor(e, userHandleOf(who));
        }
        return { text: d.text, updatedAt: d.updatedAt, reply_to: reply ? d.replyTo : null, reply };
      };
      if (method === 'GET') {
        sendJson(res, 200, withQuote(table.getRoomDraft(who.key, room.id)));
        return true;
      }
      if (method === 'PUT') {
        const b = await readObject(req);
        const replyTo = b.reply_to === undefined ? undefined : replyEntry(room, replyToField(b))?.id ?? null;
        sendJson(res, 200, withQuote(table.setRoomDraft(who.key, room.id, b.text, replyTo)));
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    } else if (sub.length === 1 && sub[0] === 'seen' && method === 'PUT') {
      /* THE PERSON'S READ CURSOR (workgroups): "I have seen this room up to line
         N" — sent when the page opens the room and as it reads on. Monotonic. */
      requireHuman(deps, 'your read cursor');
      const b = await readObject(req);
      sendJson(res, 200, { last_seen_line_id: table.markRoomSeen(pictureOwner(principal).key, room.id, b.last_seen_line_id) });
      return true;
    } else if (sub.length === 1 && sub[0] === 'disconnect' && method === 'POST') {
      sendJson(res, 200, await disconnectRoom(room, deps));
      return true;
    } else if (sub.length === 1 && sub[0] === 'reconnect' && method === 'POST') {
      sendJson(res, 200, await reconnectRoom(room, await readObject(req), deps));
      return true;
    } else if (sub.length === 1 && sub[0] === 'dissolve' && method === 'POST') {
      /* DISSOLVE A WORKGROUP (Owner [ref]): every seat, the lead included, returns to
         the main room (the move path: same seat, handle, session, pane); the empty
         group is closed, not deleted. The person's call, so a window credential. */
      requireHuman(deps, 'dissolving a workgroup');
      const out = table.dissolveWorkgroup(room.id, { actor: 'user' });
      for (const s of out.result.moved) {
        seatWelcome.welcomeSeat(out.result.parent, s, deps.log); // a move re-sends with the new room name
      }
      sendJson(res, 200, {
        moved: out.result.moved.map((s) => ({ seat: s.id, handle: s.handle })),
        parent: out.result.parent.id,
        parent_name: out.result.parent.name,
        parent_has_lead: out.result.parentHasLead,
        closed: true,
        entries: out.entries,
      });
      return true;
    } else if (sub.length === 1 && sub[0] === 'archive' && method === 'POST') {
      const actor = httpActor(room, (await readObject(req)).from, ['archive'], deps);
      const seats = table.listSeats(room.id);
      const out = table.archiveRoom(room.id, { actor });
      await releaseWorktrees(room.id, seats, deps);
      sendJson(res, 200, { state: out.result.state, entries: out.entries });
      return true;
    } else if (sub.length === 1 && sub[0] === 'reopen' && method === 'POST') {
      const actor = httpActor(room, (await readObject(req)).from, ['reopen'], deps);
      const out = table.reopenRoom(room.id, { actor });
      sendJson(res, 200, { state: out.result.state, entries: out.entries });
      return true;
    } else if (sub[0] === 'search' && sub.length === 1 && method === 'GET') {
      /* SEARCH [search] Owner 2026-10-06 (the design system BUILD-HANDOFF §1.K): newest first, every word,
         each hit with about two lines around the match as parts (the page bolds the hits). */
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const words = searchTerms(q.get('q') ?? '');
      const limit = num(q.get('limit')) ?? 50;
      const hits = table.searchLines(room.id, words, limit);
      const xp = table.xpostViews(hits, room.id);
      sendJson(res, 200, {
        q: words.join(' '),
        results: hits.map((e) => ({
          id: e.id,
          ts: e.ts,
          kind: e.kind,
          author: e.author,
          author_seat: e.author_seat,
          target: e.target,
          room_id: e.room_id,
          ...(xp.has(e.id) ? { xpost: xp.get(e.id) } : {}),
          snippet: searchSnippet(e.body ?? '', words),
        })),
      });
      return true;
    } else if (sub[0] === 'lines' && sub.length === 3 && sub[2] === 'claim' && method === 'POST') {
      /* [reply turns] a seat claims or passes its turn, or acknowledges its grant */
      const b = await readObject(req);
      sendJson(res, 200, claimTurn(room, sub[1], authorFor(room.id, b.from, deps), b));
      return true;
    } else if (sub[0] === 'line' && sub.length === 1) {
      if (method === 'GET') {
        sendJsonCached(req, res, 200, await readLine(req, room, null, principal)); // ETag + gzip [perf/poll-traffic]
        return true;
      }
      if (method === 'POST') {
        const b = await readObject(req);
        if (b.attachments !== undefined && b.attachments !== null) {
          sendJson(res, 200, await postAttachmentLine(room, b, principal, deps));
          return true;
        }
        const out = postLine(room, b, deps, userHandleOf(pictureOwner(principal)));
        /* A person's line that went through clears their draft in this room,
           so a sent message never comes back on the next load. A refusal or a
           confirm keeps it: the composer still holds that text. So does
           `keep_draft: true`: a command a control on the page issued (the held
           notice's Deliver), not the composer, whose text is still the person's. */
        if ((b.from === undefined || b.from === null) && deps.human && out.status !== 'refused' && out.status !== 'confirm' && b.keep_draft !== true) {
          table.setRoomDraft(pictureOwner(principal).key, room.id, '', null); // the text AND the reply target
        }
        sendJson(res, 200, out);
        return true;
      }
    } else if (sub[0] === 'panels') {
      /* Room panels (tool-residents §2.6) [ticket]. The URL allow-list and
         what the room page must do with a panel: engine/panel-url.ts. */
      if (sub.length === 3 && sub[2] === 'action') {
        /* PANEL ACTIONS [ticket]: a button in an app's panel triggers one of
           that app's own declared actions (apps.runPanelAction). A person's
           click only: a window cookie, from the room page itself (JSON, and
           never Origin: null — a sandboxed panel frame posting here directly
           sends exactly that). One log line per action. */
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return true;
        }
        requireHuman(deps, 'a panel action');
        if (!sameOriginJson(req)) {
          throw new FieldError(403, 'a panel action is sent by the room page (same-origin JSON)', 'origin');
        }
        const panel = table.getPanel(sub[1]);
        if (!panel || !panelInFamily(panel, room)) {
          throw new FieldError(404, 'no such panel in this room', 'panel');
        }
        const b = await readObject(req);
        const out = await apps.runPanelAction(room.id, panel, b);
        /* POSTS TO ROOM [ticket]: at most ONE line, only for a succeeded call
           of a verb the pinned tool.json declares postsToRoom (out.post) */
        const posted = out.post && out.slug ? postPanelLine(room, out.slug, out.post, userHandleOf(pictureOwner(principal)), deps) : {};
        const shownParams = isPlainParams(b.params) ? JSON.stringify(b.params).slice(0, 300) : '-';
        deps.log(
          `panel action: ${pictureOwner(principal).key} room ${room.id} app ${out.slug ?? '-'} panel ${panel.id} ` +
            `action ${typeof b.name === 'string' ? b.name.slice(0, 64) : '-'} params ${shownParams} -> ${out.status}` +
            (out.upstream !== undefined ? ` (app ${out.upstream})` : '') +
            (posted.entries?.length ? ` line #${posted.entries[0].id}` : posted.warning ? ' line not posted' : ''),
        );
        sendJson(res, out.status, {
          ...out.body,
          ...(posted.entries?.length ? { line: { id: posted.entries[0].id }, entries: posted.entries } : {}),
          ...(posted.warning ? { warning: posted.warning } : {}),
        });
        return true;
      }
      const fp = sub.length >= 3 && sub[2] === 'frame' ? parseFramePath(route) : null;
      if (fp) {
        /* The view proxy (panel-proxy.ts), for a caller that passed the normal
           gate; a `t/<token>` segment is stripped, not needed. The RAW tail
           goes upstream still percent-encoded. */
        const panel = table.getPanel(sub[1]);
        if (!panel || !panelInFamily(panel, room)) {
          throw new FieldError(404, 'no such panel in this room', 'panel');
        }
        proxyFrame(req, res, panel, fp.tail, deps.log, fp.prefix);
        return true;
      }
      if (sub.length === 1 && method === 'GET') {
        sendJson(res, 200, { panels: table.listPanels(room.id).map(panelView) });
        return true;
      }
      if (sub.length === 1 && method === 'POST') {
        const b = await readObject(req);
        /* The voice tool is the ENGINE's (room-voice §9.1): the host trusts a
           `voice` panel's messages, so no caller may register one. */
        if (b.kind === 'voice') {
          throw new FieldError(400, 'the voice panel is registered by the engine', 'kind');
        }
        const actor = panelActor(room, b.from, deps, 'panel add');
        const out = table.addPanel(
          room.id,
          { kind: b.kind, title: b.title, url: b.url, seat_id: b.seat_id, icon: b.icon, order: b.order, scripts: b.scripts, uploads: b.uploads },
          { actor },
        );
        deps.log(`room ${room.id}: panel "${out.result.title}" (${out.result.id}) -> ${out.result.url}`);
        sendJson(res, 200, { panel: panelView(out.result), entries: out.entries });
        return true;
      }
      if (sub.length === 2 && (method === 'PATCH' || method === 'DELETE')) {
        const b = await readObject(req);
        if (method === 'PATCH') {
          for (const k of ['url', 'seat_id', 'kind', 'icon', 'scripts', 'uploads']) {
            if (b[k] !== undefined) {
              throw new FieldError(400, `${k} cannot be changed — remove the panel and register it again`, k);
            }
          }
          if (b.title === undefined && b.order === undefined) {
            throw new FieldError(400, 'a panel PATCH carries title and/or order', 'body');
          }
          const actor = panelActor(room, b.from, deps, 'panel update');
          const out = table.updatePanel(room.id, sub[1], { title: b.title, order: b.order }, { actor });
          sendJson(res, 200, { panel: panelView(out.result), entries: out.entries });
          return true;
        }
        const actor = panelActor(room, b.from, deps, 'panel remove');
        const out = table.removePanel(room.id, sub[1], { actor });
        sendJson(res, 200, { panel: panelView(out.result), entries: out.entries });
        return true;
      }
    } else if (sub[0] === 'apps') {
      /* ROOM APPS (the design notes §4.4, S4 engine half)
         [rooms/apps-engine]: membership is human-only, unlike a panel a seat
         can register on its own — an app in a room is a bigger decision than
         one view, so it takes a window cookie every time, `from` or not. */
      if (sub.length === 1 && method === 'GET') {
        sendJson(res, 200, { apps: table.listRoomApps(room.id) });
        return true;
      }
      if (sub.length === 1 && method === 'POST') {
        requireHuman(deps, 'adding an app to a room');
        const b = await readObject(req);
        const out = await apps.addAppToRoom(room.id, b.slug, { move: b.move === true, force: b.force === true });
        if (!out.ok) {
          sendJson(res, out.status, out.body);
          return true;
        }
        sendJson(res, 200, { app: out.app, moved_from: out.moved_from, bind: out.bind, entries: out.entries });
        return true;
      }
      if (sub.length === 2 && method === 'DELETE') {
        requireHuman(deps, 'removing an app from a room');
        sendJson(res, 200, apps.removeAppFromRoom(room.id, sub[1]));
        return true;
      }
    } else if (sub[0] === 'guide' && sub.length === 1 && method === 'GET') {
      sendGuide(res, room); // [room guide]
      return true;
    } else if (sub[0] === 'scratchpad' && sub.length === 2) {
      if (await handleScratchpad(req, res, room, sub, principal, deps)) {
        return true;
      }
    } else if (sub[0] === 'assets') {
      if (await handleAssets(req, res, room, sub, deps, principal)) {
        return true;
      }
    } else if (sub[0] === 'template' && sub.length === 1) {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      requireHuman(deps, 'exporting a room as a template');
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const teams = q.get('teams');
      const embed = (q.get('embed') ?? '').split(',').filter((x) => x === 'roles' || x === 'recipes') as Array<'roles' | 'recipes'>;
      try {
        sendJson(res, 200, roomTemplate.exportTemplate(room.id, { teams: teams ? teams.split(',').filter(Boolean) : null, embed }));
      } catch (e) {
        if (e instanceof roomTemplate.TemplateError) {
          throw new FieldError(400, e.message, e.field ?? 'room', { code: e.code });
        }
        throw e;
      }
      return true;
    } else if (sub[0] === 'code-folder' && sub.length <= 2) {
      /* THE ROOM CODE FOLDER (step C): read by anyone who can read the room; set or made-a-project only by a PERSON (a window credential) */
      if (sub.length === 1 && method === 'GET') {
        sendJson(res, 200, { codeFolder: await codeFolderView(room.id) });
        return true;
      }
      if (method !== 'GET') {
        if (!deps.human) {
          await drain(req);
        }
        requireHuman(deps, 'the room\'s code folder');
      }
      if (sub.length === 1 && method === 'PUT') {
        const b = await readObject(req);
        const r = await setCodeFolder(room.id, b);
        if (!r.ok) {
          sendJson(res, r.status, { error: r.reason, field: r.field ?? 'mode', ...(r.code ? { code: r.code } : {}) });
          return true;
        }
        sendJson(res, 200, { codeFolder: r.codeFolder });
        return true;
      }
      if (sub.length === 2 && sub[1] === 'init' && method === 'POST') {
        await drain(req);
        const cf = table.familyCodeFolder(room.id);
        if (!cf) throw new FieldError(409, 'this room has no code folder', 'code_folder');
        const made = await makeProject(cf.dir);
        if (!made.ok) {
          sendJson(res, made.reason === 'git is not installed' ? 409 : 500, { error: made.reason, field: 'code_folder', ...(made.reason === 'git is not installed' ? { code: 'no-git' } : {}) });
          return true;
        }
        sendJson(res, 200, { codeFolder: await codeFolderView(room.id, Date.now() + 60_000) });
        return true;
      }
    } else if (sub[0] === 'tasks') {
      /* TASKS: the person's door is a window credential; a seat uses its pane token (handleAgent) */
      if (!deps.human) {
        await drain(req);
      }
      requireHuman(deps, 'the tasks');
      if (await handleTasks(tasksCtx(deps), req, res, room, sub, { human: true })) {
        return true;
      }
    } else if (sub[0] === 'notes' && sub.length <= 4) {
      if (await handleNotes(req, res, room, sub, principal, deps)) {
        return true;
      }
    } else if (sub[0] === 'scratch' && sub.length <= 2) {
      if (await handleScratch(req, res, room, sub, principal, deps)) {
        return true;
      }
    } else if (sub.length === 1 && sub[0] === 'family-check' && method === 'GET') {
      /* LIVE NAME CHECK for the create-a-workgroup sheet (Owner 2026-10-04): is
         this alias / each of these handles free across the room's family? Any
         authenticated read; it writes nothing. */
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const alias = q.get('alias');
      sendJson(res, 200, {
        alias: alias === null ? null : table.checkFamilyName(room.id, 'alias', alias),
        handles: q.getAll('handle').slice(0, 50).map((h) => table.checkFamilyName(room.id, 'handle', h)),
      });
      return true;
    } else if (sub.length === 1 && sub[0] === 'workgroups' && method === 'POST') {
      sendJson(res, 200, await createWorkgroup(room, await readObject(req), deps));
      return true;
    } else if (sub[0] === 'seats') {
      if (sub.length === 1 && method === 'POST') {
        const b = await readObject(req);
        const actor = httpActor(room, b.from, ['add'], deps);
        if ((b.recipe_id !== undefined && b.recipe_id !== null) || (b.occupant !== undefined && b.occupant !== null)) {
          requireSeatBinder(actor, deps);
        }
        const occupant = b.occupant === undefined || b.occupant === null ? null : requireLivePane(b.occupant);
        /* PILOT SCOPE (hosted): only Claude and Codex can be a room seat (Codex reads its room-tool token through a helper; Gemini has no room tools or channel there and runs as a plain terminal), so an impossible seat is refused here, not just hidden in the page */
        if (process.env.HARBOR_WB_HOSTED === '1') {
          const rid = typeof b.recipe_id === 'string' ? b.recipe_id : null;
          const vendor = rid ? table.getRecipe(rid)?.vendor : occupant ? table.get(String(occupant))?.vendor : undefined;
          if (vendor && vendor !== 'claude-code' && vendor !== 'codex-cli') {
            throw new FieldError(400, `${PROGRAM_WORDS[vendor] ?? 'That program'} can't join a room yet. Open it from Terminals instead.`, rid ? 'recipe_id' : 'occupant', { code: 'seat-vendor-unsupported' });
          }
        }
        const out = table.addSeat(
          room.id,
          { project: b.project, recipe_id: b.recipe_id, handle: b.handle, policy: b.policy, pool_size: b.pool_size, occupant },
          { actor },
        );
        seatWelcome.welcomeSeat(room, out.result, deps.log); // room welcome, Owner 2026-10-05
        sendJson(res, 200, { seat: out.result, entries: out.entries });
        return true;
      }
      const seat = sub[1] !== undefined ? table.getSeat(sub[1]) : undefined;
      if (!seat || seat.room_id !== room.id) {
        throw new FieldError(404, 'no such seat in this room', 'seat');
      }
      if (sub.length === 3 && sub[2] === 'history' && method === 'GET') {
        sendJson(res, 200, { seat: seat.id, handle: seat.handle, history: table.listSeatHistory(seat.id) });
        return true;
      }
      if (sub.length === 3 && sub[2] === 'profile' && method === 'PATCH') {
        sendJson(res, 200, await setSeatProfile(room, seat, await readObject(req), deps));
        return true;
      }
      if (sub.length === 3 && sub[2] === 'move' && method === 'POST') {
        /* MOVE A SEAT to another room of the family (workgroups, Owner 2026-10-04):
           same handle, same session; the person's call, so a window credential. */
        requireHuman(deps, 'moving a seat between rooms');
        const b = await readObject(req);
        const out = table.moveSeat(room.id, seat.id, b.to_room, { actor: 'user' });
        const dest = table.getRoom(out.result.room_id);
        if (dest) seatWelcome.welcomeSeat(dest, out.result, deps.log); // a move re-sends with the new room name
        sendJson(res, 200, { seat: out.result, entries: out.entries });
        return true;
      }
      if (sub.length === 3 && sub[2] === 'start' && method === 'POST') {
        const vendorOf = (): string | undefined => (seat.recipe_id ? table.getRecipe(seat.recipe_id)?.vendor : undefined);
        let started: Awaited<ReturnType<typeof startSeat>>;
        try {
          started = await startSeat(room, seat, await readObject(req), deps);
        } catch (e) {
          /* the causes feed (local mode's cause.log): a refusal is one fixed code, never its text */
          if (e instanceof FieldError) {
            const x = e as FieldError & { extra?: Record<string, unknown> };
            causes.record({ kind: 'seat-start', code: causes.startRefusalCode({ code: x.extra?.code, field: x.field }), vendor: vendorOf(), handle: seat.handle, room: room.id });
          }
          throw e;
        }
        causes.record({ kind: 'seat-start', code: 'started', vendor: vendorOf(), handle: seat.handle, room: room.id });
        if (deps.engineSpawnsOnStart && deps.openSelf) {
          await spawnStartedPane(room, seat, String(started.paneid), deps);
        }
        sendJson(res, 200, started);
        return true;
      }
      if (sub.length === 4 && sub[2] === 'worktree' && sub[3] === 'clean' && method === 'POST') {
        requireHuman(deps, 'cleaning up a seat\'s worktree');
        const live = seat.occupant_kind === 'pane' && !!seat.occupant && table.get(seat.occupant)?.state === 'live';
        sendJson(res, 200, await cleanSeatWorktree(seat, live));
        return true;
      }
      if (sub.length === 3 && sub[2] === 'wake-deliver' && method === 'POST') {
        sendJson(res, 200, await wakeDeliver(room, seat, await readObject(req), deps));
        return true;
      }
      if (sub.length === 3 && sub[2] === 'disconnect' && method === 'POST') {
        sendJson(res, 200, await disconnectSeat(room, seat, deps));
        return true;
      }
      if (sub.length === 3 && sub[2] === 'reload' && method === 'GET') {
        sendJson(res, 200, reloadPreview(room, seat));
        return true;
      }
      if (sub.length === 3 && sub[2] === 'reload' && method === 'POST') {
        sendJson(res, 200, await reloadSeat(room, seat, await readObject(req), deps));
        return true;
      }
      if (sub.length === 3 && sub[2] === 'close-window' && method === 'POST') {
        sendJson(res, 200, await closeSeatWindow(room, seat, deps));
        return true;
      }
      if (sub[2] === 'switch') {
        if (sub.length === 3 && method === 'GET') {
          sendJson(res, 200, switchWizard(room, seat));
          return true;
        }
        if (sub.length === 3 && method === 'POST') {
          sendJson(res, 202, await requestSwitch(room, seat, await readObject(req), principal, deps));
          return true;
        }
        if (sub.length === 4 && method === 'GET') {
          sendJson(res, 200, switchView(switchOpOf(room, seat, sub[3])));
          return true;
        }
        if (sub.length === 5 && sub[4] === 'continue' && method === 'POST') {
          sendJson(res, 202, continueSwitch(room, seat, sub[3], deps));
          return true;
        }
        if (sub.length === 5 && sub[4] === 'cancel' && method === 'POST') {
          sendJson(res, 202, cancelSwitch(room, seat, sub[3], deps));
          return true;
        }
      }
      if (sub.length === 2 && method === 'PATCH') {
        const b = await readObject(req);
        const hasSeatPatch = b.handle !== undefined || b.policy !== undefined || b.pool_size !== undefined;
        if (b.occupant !== undefined) {
          /* Two verbs are two transactions; refusing the mix keeps a PATCH
             all-or-nothing instead of half-applied. */
          if (hasSeatPatch) {
            throw new FieldError(400, 'change the occupant in its own PATCH', 'occupant');
          }
          const actor = httpActor(room, b.from, ['replace'], deps);
          if (b.occupant !== null) {
            requireSeatBinder(actor, deps); // binding; emptying the seat stays the lead's
          }
          const occupant = b.occupant === null ? null : requireLivePane(b.occupant);
          const out = table.setOccupant(room.id, seat.id, occupant, { actor });
          seatWelcome.welcomeSeat(room, out.result, deps.log); // room welcome, Owner 2026-10-05
          sendJson(res, 200, { seat: out.result, entries: out.entries });
          return true;
        }
        const verbs: RoomVerb[] = [
          ...(b.handle !== undefined ? (['rename-seat'] as const) : []),
          ...(b.policy !== undefined || b.pool_size !== undefined ? (['set-policy'] as const) : []),
        ];
        const actor = httpActor(room, b.from, verbs, deps);
        const out = table.updateSeat(
          room.id,
          seat.id,
          {
            ...(b.handle !== undefined ? { handle: b.handle } : {}),
            ...(b.policy !== undefined ? { policy: b.policy } : {}),
            ...(b.pool_size !== undefined ? { pool_size: b.pool_size } : {}),
          },
          { actor },
        );
        sendJson(res, 200, { seat: out.result, entries: out.entries });
        return true;
      }
      if (sub.length === 2 && method === 'DELETE') {
        // The already-confirmed form: a chrome calls it after its own dialog.
        const actor = httpActor(room, (await readObject(req)).from, ['remove'], deps);
        const out = table.removeSeat(room.id, seat.id, { actor });
        await releaseWorktrees(room.id, [seat], deps);
        sendJson(res, 200, { seat: out.result, entries: out.entries });
        return true;
      }
    }
    sendJson(res, 404, { error: 'no such rooms route', field: 'route' });
    return true;
  } catch (e) {
    fail(res, e);
    return true;
  }
}

