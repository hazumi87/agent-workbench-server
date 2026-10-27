/* ============================================================================
 * ROOM APPS — the tool registry + room membership (the design notes
 * §4.4, S4 engine half) [rooms/apps-engine]. What THIS module owns:
 *
 *   - the CATALOG: a human-registered tool.json, re-hashed on every read (a
 *     mismatch holds it — the app cannot be added or moved until a human
 *     approves the new file), with its live status (running/down/unknown/held)
 *     via a 2s-timeout GET .../health, cached ~5s;
 *   - CANDIDATES: subfolders of HARBOR_WB_TOOLS_DIR with a tool.json that
 *     aren't registered yet — a pick list for a human, never a scan that
 *     registers anything on its own (§4.4: "There is no engine scan");
 *   - MEMBERSHIP: putting an app in a room (or moving an exclusive one, with
 *     its bind handshake) and taking it out, with the panel(s) that follow.
 *
 * This module never executes a tool script (§4.4: "The engine never executes
 * tool scripts") — only `lifecycle.bind.http`, an HTTP call to the app's OWN
 * process, on loopback, with the engine's own bearer — and only after
 * verifyEndpoint (app-endpoint.ts) has confirmed the listener is that process,
 * under our uid [rooms/apps-sec P0]. tool.json is read once per action
 * (readPinned) so a hash check and the fields acted on come from the same
 * bytes [P1-a/b].
 * ========================================================================== */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { table, RoomError, PANELS_MAX, type RoomLineEntry, type AppPanelSpec, type ToolRegistryRow } from '../table/endpoint.ts';
import { checkPanelUrl } from './panel-url.ts';
import { verifyEndpoint, isDirectChild, type EndpointCheck } from './app-endpoint.ts';
import * as auth from '../server/auth.ts';
import { LINKS_MAX, parseLinks, panelViewsOf, panelPath, matchRef, resolveView, dirOf, type StoredLink } from './tool-links.ts';
import { dataDir, instancePath } from './data-dir.ts';

const DEFAULT_TOOLS_DIR = './tools';
function toolsDir(): string {
  return process.env.HARBOR_WB_TOOLS_DIR || (dataDir() ? instancePath('tools') : DEFAULT_TOOLS_DIR);
}

const SUPPORTED_CONTRACT = 'tool/draft-0';
const HEALTH_TIMEOUT_MS = 2000;
const BIND_TIMEOUT_MS = 10_000;
/** The bind answer is a few fields; read at most this much of it and drop the
 *  rest, so an app can't make the engine buffer an endless body. */
const BIND_BODY_MAX = 64 * 1024;
const STATUS_TTL_MS = 5000;

let log: (line: string) => void = (line) => console.log(`[apps] ${line}`);
/** The engine hands its own logger in at boot. */
export function setLog(fn: (line: string) => void): void {
  log = fn;
}

/** Hash the BYTES, not a decoded string: two files that decode alike must not
 *  share a pin. (Identical to the old utf8-string hash for any valid UTF-8.) */
function sha256(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

/* --------------------------------------------------------------- tool.json ---- */

interface ToolFile {
  sha256: string;
  /** undefined when the bytes are not JSON */
  parsed: any;
  parseOk: boolean;
}

/** ONE read of tool.json: the hash and the parse come from the same bytes. */
function readToolFile(root: string): ToolFile | null {
  let raw: Buffer;
  try {
    raw = readFileSync(join(root, 'tool.json'));
  } catch {
    return null;
  }
  try {
    return { sha256: sha256(raw), parsed: JSON.parse(raw.toString('utf8')), parseOk: true };
  } catch {
    return { sha256: sha256(raw), parsed: undefined, parseOk: false };
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A registered tool's file, checked against its pin [rooms/apps-sec P1-a/b].
 *  THE one way an action path reads tool.json: bytes read once, hashed, and
 *  on a mismatch (or an unreadable file, or a root that has become a symlink,
 *  or a root whose realpath is not the pinned one) the tool is held and nothing from the file may be acted on. `display` on
 *  the held side is the CURRENT file, for the catalog to show what approve
 *  would pin — never pass it to anything that binds, draws or decides. */
type Pinned =
  | { held: false; parsed: any; sha256: string }
  | { held: true; blocked: 'held' | 'unregistered'; sha256: string | null; display: any };

function readPinned(reg: ToolRegistryRow): Pinned {
  const file = isSymlink(reg.root) ? null : readToolFile(reg.root);
  /* UNREGISTERED [ticket] blocks exactly like held (nothing from the file is
     acted on) but is a human's choice, not a mismatch: never held here — a
     file that changed meanwhile is caught when it is registered again. */
  if (reg.unregistered_at) {
    return { held: true, blocked: 'unregistered', sha256: file?.sha256 ?? null, display: file?.parsed ?? {} };
  }
  if (reg.held) {
    return { held: true, blocked: 'held', sha256: file?.sha256 ?? null, display: file?.parsed ?? {} };
  }
  const why = pinMismatch(reg, file);
  if (why || !file) {
    if (table.holdTool(reg.slug)) {
      log(`${reg.slug}: ${why} — held until a human approves it`);
    }
    return { held: true, blocked: 'held', sha256: file?.sha256 ?? null, display: file?.parsed ?? {} };
  }
  return { held: false, parsed: file.parsed, sha256: file.sha256 };
}

/** Why this file no longer matches the pin (null = it does). The ROOT is
 *  pinned too: an identical tool.json reached through a swapped parent (a
 *  symlink anywhere above the root) is a different tool — its app/ and
 *  scripts/ are not what the human approved. */
function pinMismatch(reg: ToolRegistryRow, file: ToolFile | null): string | null {
  if (!file || !file.parseOk || file.sha256 !== reg.tool_sha256) {
    return 'tool.json no longer matches its pin';
  }
  const real = realpathOrNull(reg.root);
  return real === null || real !== reg.root_realpath
    ? `the tool root now resolves to ${real ?? '(nothing)'}, not the pinned ${reg.root_realpath ?? '(unpinned)'}`
    : null;
}

/** tool.json problems a human should see before registering. Never throws —
 *  an unreadable/unparseable file is itself a "problem", not an exception. */
function toolProblems(file: ToolFile | null, folderSlug: string): string[] {
  const problems: string[] = [];
  if (!file || !file.parseOk) {
    return ['cannot read or parse tool.json'];
  }
  const p = file.parsed;
  if (typeof p !== 'object' || p === null) {
    return ['tool.json is not a JSON object'];
  }
  if (p.contract !== SUPPORTED_CONTRACT) {
    problems.push(`unknown contract ${JSON.stringify(p.contract ?? null)} (only "${SUPPORTED_CONTRACT}" is accepted)`);
  }
  if (p.slug !== folderSlug) {
    problems.push(`slug "${p.slug}" does not match folder name "${folderSlug}"`);
  }
  if (typeof p.name !== 'string' || !p.name.trim()) {
    problems.push('missing name');
  }
  if (typeof p?.endpoint?.discover !== 'string' || !p.endpoint.discover.trim()) {
    problems.push('missing endpoint.discover');
  }
  const panels = Array.isArray(p.panels) ? p.panels : [];
  for (const panel of panels) {
    const view = typeof panel?.view === 'string' ? panel.view : '';
    if (!view.startsWith('GET /') || !view.includes(':roomId')) {
      problems.push(`panel "${panel?.title ?? '?'}" view ${JSON.stringify(view)} must start with "GET /" and contain ":roomId"`);
    }
  }
  /* line links into a tool view [rooms/tool-links]: engine/tool-links.ts */
  problems.push(...parseLinks(p.links, panelViewsOf(p)).problems);
  /* panel actions [ticket]: a bad `"panel": true` verb is refused here, so a
     human never approves a file whose allow-list the route would ignore */
  problems.push(...panelActionsOf(p).problems);
  return problems;
}

/* ------------------------------------------------------- panel actions ---- */

/** One verb an app's own panel may trigger (tool.json `"panel": true`). */
export interface PanelActionSpec {
  name: string;
  method: string;
  /** the call.http path, split on '/': a literal, or ':<param>' */
  segments: string[];
  /** the path params the CALLER fills — every one except roomId */
  params: string[];
  /** the keys of the verb's declared `input` (a JSON body carries only
   *  these), or null: the verb declares none and the call has no body */
  input: string[] | null;
  /** `"postsToRoom"` [ticket]: a successful call may post ONE line to the
   *  room, as the person who clicked (the app's `roomLine` answer); null =
   *  it may not. `true` reads as {to:'lead', data:false} [ticket]. */
  postsToRoom: PostsToRoom | null;
}

/** How a postsToRoom verb's line may be addressed and what it may carry
 *  [ticket]: `to` 'lead' = un-addressed (the room types it to the lead, as
 *  in ticket); 'requester' = the app may name, in `roomLine.to`, the seat
 *  that asked for the work (engine-checked: rooms.ts requesterSeat); `data` =
 *  it may attach a small JSON object for agents (`roomLine.data`). */
export interface PostsToRoom {
  to: 'lead' | 'requester';
  data: boolean;
}

const POSTS_TO_ROOM_SHAPE = 'true, false, or {"to": "lead" | "requester", "data"?: true | false}';

/** tool.json `postsToRoom` -> the setting, or why it is refused [ticket]. */
function postsToRoomOf(raw: unknown): { ok: true; value: PostsToRoom | null } | { ok: false; why: string } {
  if (raw === undefined || raw === false) {
    return { ok: true, value: null };
  }
  if (raw === true) {
    return { ok: true, value: { to: 'lead', data: false } };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, why: `"postsToRoom" is ${POSTS_TO_ROOM_SHAPE}` };
  }
  const extra = Object.keys(raw).find((k) => k !== 'to' && k !== 'data');
  if (extra !== undefined) {
    return { ok: false, why: `"postsToRoom" takes only "to" and "data" (not "${extra.slice(0, 40)}"): ${POSTS_TO_ROOM_SHAPE}` };
  }
  if (raw.to !== 'lead' && raw.to !== 'requester') {
    return { ok: false, why: `"postsToRoom".to is "lead" or "requester": ${POSTS_TO_ROOM_SHAPE}` };
  }
  if (raw.data !== undefined && typeof raw.data !== 'boolean') {
    return { ok: false, why: `"postsToRoom".data is true or false: ${POSTS_TO_ROOM_SHAPE}` };
  }
  return { ok: true, value: { to: raw.to, data: raw.data === true } };
}

const ACTION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Who-did-it and which-room fields a panel may never supply (the §4.4
 *  app_call rule), compared NORMALISED (lowercase, no _ or -), so `Flagged_By`
 *  and `room-id` count. A verb that DECLARES one in its input is refused at
 *  register/approve; the runtime drop in runPanelAction is the backstop.
 *  When a verb needs the actor (Tasks claim), the ENGINE will fill it from the
 *  person's credential — not built yet. */
const ACTOR_KEYS = new Set(['from', 'by', 'flaggedby', 'author', 'authorname', 'actor', 'handle', 'seat', 'roomid', 'user', 'sender']);
const isActorKey = (k: string): boolean => ACTOR_KEYS.has(k.toLowerCase().replace(/[_-]/g, ''));
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
const ACTION_HTTP_RE = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;
const ACTION_LITERAL_RE = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
const ACTION_PARAM_RE = /^:([A-Za-z][A-Za-z0-9_]{0,31})$/;

/**
 * The verbs a panel may trigger, from ONE parse of tool.json (the pinned one,
 * at the route; the file being registered/approved, in toolProblems). A verb
 * qualifies only when it says `"panel": true`, its class is read or mutate,
 * and its `call.http` is `<METHOD> /path` whose segments are plain literals or
 * `:param`s, `:roomId` among them (an action acts on the room its panel is in).
 * Anything else marked `panel` is a problem, never silently dropped.
 */
export function panelActionsOf(parsed: any): { actions: Map<string, PanelActionSpec>; problems: string[] } {
  const actions = new Map<string, PanelActionSpec>();
  const problems: string[] = [];
  for (const v of Array.isArray(parsed?.verbs) ? parsed.verbs : []) {
    if (v?.panel === undefined || v.panel === false) {
      if (v?.postsToRoom !== undefined && v.postsToRoom !== false) {
        problems.push(`verb "${typeof v?.name === 'string' ? v.name : '?'}" declares postsToRoom: only a "panel": true verb can post to the room`);
      }
      continue;
    }
    const name = typeof v?.name === 'string' ? v.name : '?';
    const bad = (why: string) => problems.push(`verb "${name}" is marked panel: ${why}`);
    if (v.panel !== true) {
      bad('"panel" is true or false');
      continue;
    }
    if (!ACTION_NAME_RE.test(name)) {
      bad('its name must match [A-Za-z0-9_-]{1,64}');
      continue;
    }
    if (v.class !== 'read' && v.class !== 'mutate') {
      bad('only a read or mutate verb can be triggered from a panel');
      continue;
    }
    const m = typeof v?.call?.http === 'string' ? ACTION_HTTP_RE.exec(v.call.http.trim()) : null;
    if (!m) {
      bad('it needs call.http "<GET|POST|PUT|PATCH|DELETE> /path"');
      continue;
    }
    if (m[1] !== 'GET' && v.class !== 'mutate') {
      bad(`a ${m[1]} verb changes things: its class must be mutate`);
      continue;
    }
    if (v.input !== undefined && !isPlainObject(v.input)) {
      bad('"input" is an object naming the fields it takes');
      continue;
    }
    const inputKeys = isPlainObject(v.input) ? Object.keys(v.input) : null;
    if (m[1] === 'GET' && inputKeys) {
      bad('a GET verb cannot declare input (a panel action sends a body only with it)');
      continue;
    }
    const actorKey = inputKeys?.find(isActorKey);
    if (actorKey !== undefined) {
      bad(`its input declares "${actorKey}", a who-did-it / room field a panel may not supply (the engine fills those)`);
      continue;
    }
    const segments = m[2].split('/').slice(1);
    const names = segments.map((s) => ACTION_PARAM_RE.exec(s)?.[1] ?? null);
    if (segments.some((s, i) => names[i] === null && !ACTION_LITERAL_RE.test(s))) {
      bad('its path segments must be plain literals or :params');
      continue;
    }
    const params = names.filter((n): n is string => n !== null);
    if (!params.includes('roomId') || new Set(params).size !== params.length) {
      bad('its path must contain :roomId, and no :param twice');
      continue;
    }
    if (actions.has(name)) {
      bad('two verbs share the name');
      continue;
    }
    /* POSTS TO ROOM [ticket]: the person's submit is the consent to the line,
       so only a verb that CHANGES something (mutate, not GET) may carry it.
       The object form [ticket] is part of the pinned file like the boolean:
       changing it holds the app until a person approves again. */
    const posts = postsToRoomOf(v.postsToRoom);
    if (!posts.ok) {
      bad(posts.why);
      continue;
    }
    if (posts.value && m[1] === 'GET') {
      bad('postsToRoom needs a mutate verb (not GET): a line is posted on a submit');
      continue;
    }
    actions.set(name, { name, method: m[1], segments, params: params.filter((p) => p !== 'roomId'), input: inputKeys, postsToRoom: posts.value });
  }
  return { actions, problems };
}

export interface Candidate {
  slug: string;
  root: string;
  name: string;
  contract: string;
  description: string;
  ok: boolean;
  problems: string[];
  /** sha256 of tool.json as listed — send it back as `expected_sha256`. */
  sha256: string | null;
}

/** Subfolders of HARBOR_WB_TOOLS_DIR with a tool.json that aren't registered
 *  yet — a pick list for a human. Lists an invalid one too (so its problems
 *  are visible), it just can't be registered (400 at registration). A
 *  symlinked folder is not a directory entry here, so never listed. */
export function listCandidates(): { tools_dir: string; candidates: Candidate[] } {
  const dir = toolsDir();
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { tools_dir: dir, candidates: [] };
  }
  const registered = new Set(table.listToolRegistry().map((r) => r.slug));
  const out: Candidate[] = [];
  for (const slug of entries) {
    if (registered.has(slug)) {
      continue;
    }
    const root = join(dir, slug);
    if (!existsSync(join(root, 'tool.json'))) {
      continue;
    }
    const file = readToolFile(root);
    const problems = toolProblems(file, slug);
    out.push({
      slug,
      root,
      name: typeof file?.parsed?.name === 'string' ? file.parsed.name : slug,
      contract: typeof file?.parsed?.contract === 'string' ? file.parsed.contract : 'unknown',
      description: typeof file?.parsed?.description === 'string' ? file.parsed.description : '',
      ok: problems.length === 0,
      problems,
      sha256: file?.sha256 ?? null,
    });
  }
  return { tools_dir: dir, candidates: out };
}

/** The file changed since the human looked at it: `expected_sha256` (the hash
 *  the UI showed) no longer matches the bytes on disk. The route answers
 *  409 {error:'changed', sha256} so the UI can re-show and re-ask. */
export class AppChangedError extends Error {
  constructor(readonly sha256: string | null) {
    super('tool.json changed since it was shown');
  }
}

function checkExpected(file: ToolFile, expected: string | undefined): void {
  if (expected !== undefined && file.sha256 !== expected) {
    throw new AppChangedError(file.sha256);
  }
}

/** A human's pick from the candidate list, by root. Refuses a root outside
 *  HARBOR_WB_TOOLS_DIR (the candidate list's own scope), a symlinked root, a
 *  file that changed since the human saw it (`expectedSha`), and an invalid
 *  tool.json (400, naming every problem). */
export function registerApp(root: string, registeredBy: string, expectedSha?: string): ToolRegistryRow {
  const dir = toolsDir();
  if (!isDirectChild(dir, root)) {
    throw new RoomError(400, `root must be a direct subfolder of ${dir}`, 'root');
  }
  const slug = basename(resolve(root));
  const canonical = join(dir, slug);
  if (isSymlink(canonical)) {
    throw new RoomError(400, 'root must be a real folder, not a symlink', 'root');
  }
  const file = readToolFile(canonical);
  if (file) {
    checkExpected(file, expectedSha);
  }
  const problems = toolProblems(file, slug);
  if (problems.length) {
    throw new RoomError(400, `tool.json is invalid: ${problems.join('; ')}`, 'root');
  }
  const existing = table.getToolRegistry(slug);
  if (existing?.unregistered_at) {
    return reregister(existing);
  }
  const row = table.registerTool({
    slug,
    root: canonical,
    name: file!.parsed.name,
    contract: file!.parsed.contract,
    tool_sha256: file!.sha256,
    registered_by: registeredBy,
    root_realpath: realpathSync(canonical),
    tool_json: JSON.stringify(file!.parsed), // the pin's content: what a later Approve is compared against
  });
  /* Backfill NOW (§4.4 amendment), not just at boot: a panel registered
     directly before this app existed in the catalog (register-panel.sh, the
     pre-apps path) must not sit orphaned until the next restart. Only for a
     VERIFIED running app, from the same parse the pin was taken from. */
  backfillFor(row, file!.parsed);
  if (table.roomsForApp(row.slug).length) {
    table.appNotice(row.slug, 'registered'); // rooms that already showed its panel
  }
  return row;
}

/** REGISTER AGAIN [ticket]: an unregistered app goes back in the catalog
 *  on its OLD pin — never a silent re-pin of whatever is on disk now. A file
 *  that changed while it was out is then held (readPinned) and waits for a
 *  human's Approve like any other change: re-register = register + approve. */
function reregister(reg: ToolRegistryRow): ToolRegistryRow {
  /* decided BEFORE the write, so the rooms get ONE true line: "registered;
     its actions now work", or "registered and waiting for your approval" */
  const why = reg.held ? null : pinMismatch(reg, isSymlink(reg.root) ? null : readToolFile(reg.root));
  const row = table.reregisterTool(reg.slug, why !== null)!;
  log(`${reg.slug}: registered again${row.held ? ` — held until a human approves it${why ? ` (${why})` : ''}` : ''}`);
  return row;
}

/** POST /api/apps/:slug/register [ticket]: register a candidate (or an
 *  unregistered app) by its slug — the folder HARBOR_WB_TOOLS_DIR/<slug>. */
export function registerBySlug(slug: string, registeredBy: string, expectedSha?: string): ToolRegistryRow {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(slug) || slug === '.' || slug === '..') {
    throw new RoomError(404, 'no such app', 'slug');
  }
  const reg = table.getToolRegistry(slug);
  if (reg && !reg.unregistered_at) {
    throw new RoomError(409, `"${slug}" is already registered`, 'slug');
  }
  if (reg) {
    return reregister(reg);
  }
  const root = join(toolsDir(), slug);
  if (!existsSync(join(root, 'tool.json'))) {
    throw new RoomError(404, 'no such app', 'slug');
  }
  return registerApp(root, registeredBy, expectedSha);
}

/** POST /api/apps/:slug/unregister [ticket]: a human takes an app out of
 *  the catalog. Its room_apps rows, panels and data STAY (it keeps its place
 *  in each rail); its actions are blocked — the held path — until it is
 *  registered again. Idempotent. */
export function unregisterApp(slug: string, by: string, supersededBy: string | null = null): ToolRegistryRow {
  const reg = table.getToolRegistry(slug);
  if (!reg) {
    throw new RoomError(404, 'no such app', 'slug');
  }
  if (supersededBy !== null) {
    /* [app supersede] Owner 2026-10-05: ONE hop. The replacement is a different,
       registered, approved app that is itself not replaced, and this app is not
       already some other app's replacement: no chain, no A->B->A. */
    const to = table.getToolRegistry(supersededBy);
    if (supersededBy === slug) {
      throw new RoomError(400, 'an app cannot replace itself', 'superseded_by');
    }
    if (!to || to.unregistered_at || to.held) {
      throw new RoomError(400, `"${supersededBy}" is not a registered, approved app`, 'superseded_by');
    }
    if (to.superseded_by || table.listToolRegistry().some((r) => r.superseded_by === slug)) {
      throw new RoomError(400, 'supersession is one hop: no chains', 'superseded_by');
    }
  }
  if (table.unregisterTool(slug, by, supersededBy)) {
    log(`${slug}: unregistered by ${by} — its actions are blocked; it stays in ${table.roomsForApp(slug).length} room(s)`);
  }
  return table.getToolRegistry(slug)!;
}

/** [app supersede] Owner 2026-10-05: the app that answers `slug`'s refs now, or
 *  null. ONE resolver for a stored link's tool: `slug` is unregistered and names
 *  a successor that is registered and approved (not held, not itself out). */
export function supersededTarget(slug: string): ToolRegistryRow | null {
  const reg = table.getToolRegistry(slug);
  if (!reg || !reg.unregistered_at || !reg.superseded_by) {
    return null;
  }
  const to = table.getToolRegistry(reg.superseded_by);
  return to && !to.unregistered_at && !to.held ? to : null;
}

/** What an app's panel may do now [ticket]: the host tells the panel. */
export type AppActions = 'enabled' | 'held' | 'unregistered';
export function appActions(reg: ToolRegistryRow | undefined | null): AppActions {
  return !reg || reg.unregistered_at ? 'unregistered' : reg.held ? 'held' : 'enabled';
}
/** The registration state Settings → Apps shows [ticket]. */
export type AppState = 'registered' | 'needs-approval' | 'unregistered-candidate';
function appState(a: AppActions): AppState {
  return a === 'enabled' ? 'registered' : a === 'held' ? 'needs-approval' : 'unregistered-candidate';
}

/** A human approves the CURRENT file on disk: re-pin its hash, clear `held`.
 *  Still refuses an invalid file (a held app whose tool.json now also fails
 *  contract/shape must not be silently un-held), a symlinked root, and a file
 *  that is not the one the human was shown (`expectedSha`). */
export function approveApp(slug: string, expectedSha?: string): ToolRegistryRow {
  const reg = table.getToolRegistry(slug);
  if (!reg) {
    throw new RoomError(404, 'no such app', 'slug');
  }
  if (reg.unregistered_at) {
    throw new RoomError(409, `"${slug}" is not registered: register it again first`, 'slug');
  }
  if (isSymlink(reg.root)) {
    throw new RoomError(400, 'the tool root has become a symlink', 'root');
  }
  const file = readToolFile(reg.root);
  if (file) {
    checkExpected(file, expectedSha);
  }
  const problems = toolProblems(file, slug);
  if (problems.length) {
    throw new RoomError(400, `tool.json is invalid: ${problems.join('; ')}`, 'root');
  }
  const real = realpathOrNull(reg.root);
  if (!real) {
    throw new RoomError(400, 'the tool root cannot be resolved', 'root');
  }
  return table.approveTool(slug, file!.sha256, real, JSON.stringify(file!.parsed))!;
}

/* ---------------------------------------------------------------- diff ---- */

type Verb = { name: string; class: string };
export interface ToolDiff {
  verbs: { added: Verb[]; removed: Verb[]; changed: Array<{ name: string; from: string; to: string }> };
  panels: { added: string[]; removed: string[] };
  /** verbs the app's panel may trigger (`"panel": true`) [ticket]; changed =
   *  same name, a different method or path */
  actions: { added: string[]; removed: string[]; changed: string[] };
  /** panel actions that may post a line to the room on the person's submit
   *  (`"postsToRoom"`) [ticket]: added = newly may, removed = no longer;
   *  [ticket] how = the setting of each ADDED one, changed = still posts but
   *  its `to` / `data` moved (from -> to) */
  posts: {
    added: string[];
    removed: string[];
    how: Record<string, PostsToRoom>;
    changed: Array<{ name: string; from: PostsToRoom; to: PostsToRoom }>;
  };
  /** tool.json `host_capabilities` [asset picker]: host features its panels
   *  may ask for (HOST_CAPABILITIES); added = newly declared, removed = dropped */
  host: { added: string[]; removed: string[] };
  access: { from: string; to: string } | null;
  jobs: { from: boolean; to: boolean } | null;
  needs: Array<{ key: string; from: unknown; to: unknown }>;
  /** other top-level keys whose value changed (version, description, lifecycle …) */
  other: string[];
}

/** The host features a panel may ask for through its action port, declared in
 *  tool.json `host_capabilities` (an array of names) [asset picker, Owner
 *  2026-10-05]. Only names the host knows are kept, so an unknown word is
 *  ignored, never fatal. 'pick' = {panel:'pick'}, the host asset picker. It is
 *  part of the PINNED tool.json, so adding one holds the app until a person
 *  approves it, and the diff names it. */
export const HOST_CAPABILITIES = ['pick'] as const;
export function hostCapabilitiesOf(p: any): string[] {
  const v = Array.isArray(p?.host_capabilities) ? p.host_capabilities : [];
  return HOST_CAPABILITIES.filter((c) => v.includes(c));
}
/** The capabilities of the PINNED tool.json (what a person approved) for a
 *  registered app; [] when there is no pinned copy. */
export function pinnedHostCapabilities(reg: ToolRegistryRow | undefined | null): string[] {
  if (!reg?.tool_json) {
    return [];
  }
  try {
    return hostCapabilitiesOf(JSON.parse(reg.tool_json));
  } catch {
    return [];
  }
}

function verbsOf(p: any): Verb[] {
  return (Array.isArray(p?.verbs) ? p.verbs : [])
    .filter((v: any) => v && typeof v.name === 'string')
    .map((v: any) => ({ name: v.name, class: typeof v.class === 'string' ? v.class : 'unknown' }));
}
function panelTitles(p: any): string[] {
  return panelSummaries(p).map((x) => x.title || '(untitled)');
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What changed between two parsed tool.json objects, in the terms a human
 *  approves: verbs (a mutate verb is the one that matters), panels, access,
 *  jobs, needs; anything else by key name only. */
export function toolDiff(from: any, to: any): ToolDiff {
  const fv = verbsOf(from);
  const tv = verbsOf(to);
  const fp = panelTitles(from);
  const tp = panelTitles(to);
  const fa = from?.access === 'exclusive' ? 'exclusive' : 'shared';
  const ta = to?.access === 'exclusive' ? 'exclusive' : 'shared';
  const fj = from?.jobs === true;
  const tj = to?.jobs === true;
  const fn = from?.needs && typeof from.needs === 'object' ? from.needs : {};
  const tn = to?.needs && typeof to.needs === 'object' ? to.needs : {};
  const needs: ToolDiff['needs'] = [];
  for (const key of [...new Set([...Object.keys(fn), ...Object.keys(tn)])]) {
    if (!same(fn[key], tn[key])) {
      needs.push({ key, from: fn[key] ?? null, to: tn[key] ?? null });
    }
  }
  const fx = panelActionsOf(from).actions;
  const tx = panelActionsOf(to).actions;
  const shape = (a: PanelActionSpec) => `${a.method} /${a.segments.join('/')}|${JSON.stringify(a.input)}`;
  const covered = new Set(['verbs', 'panels', 'access', 'jobs', 'needs', 'host_capabilities']);
  const fh = hostCapabilitiesOf(from);
  const th = hostCapabilitiesOf(to);
  const other = [...new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})])]
    .filter((k) => !covered.has(k) && !same(from?.[k], to?.[k]));
  return {
    verbs: {
      added: tv.filter((v) => !fv.some((x) => x.name === v.name)),
      removed: fv.filter((v) => !tv.some((x) => x.name === v.name)),
      changed: tv.flatMap((v) => {
        const was = fv.find((x) => x.name === v.name);
        return was && was.class !== v.class ? [{ name: v.name, from: was.class, to: v.class }] : [];
      }),
    },
    panels: { added: tp.filter((t) => !fp.includes(t)), removed: fp.filter((t) => !tp.includes(t)) },
    actions: {
      added: [...tx.keys()].filter((n) => !fx.has(n)),
      removed: [...fx.keys()].filter((n) => !tx.has(n)),
      changed: [...tx.values()].filter((a) => fx.has(a.name) && shape(fx.get(a.name)!) !== shape(a)).map((a) => a.name),
    },
    posts: {
      added: [...tx.values()].filter((a) => a.postsToRoom && !fx.get(a.name)?.postsToRoom).map((a) => a.name),
      removed: [...fx.values()].filter((a) => a.postsToRoom && !tx.get(a.name)?.postsToRoom).map((a) => a.name),
      how: Object.fromEntries([...tx.values()].filter((a) => a.postsToRoom && !fx.get(a.name)?.postsToRoom).map((a) => [a.name, a.postsToRoom!])),
      changed: [...tx.values()].flatMap((a) => {
        const was = fx.get(a.name)?.postsToRoom;
        return a.postsToRoom && was && !same(was, a.postsToRoom) ? [{ name: a.name, from: was, to: a.postsToRoom }] : [];
      }),
    },
    host: { added: th.filter((c) => !fh.includes(c)), removed: fh.filter((c) => !th.includes(c)) },
    access: fa !== ta ? { from: fa, to: ta } : null,
    jobs: fj !== tj ? { from: fj, to: tj } : null,
    needs,
    other,
  };
}

/** GET /api/apps/:slug/diff: the PINNED tool.json against the file on disk.
 *  diff null = nothing to compare against (pinned before the engine kept a
 *  copy, or the file cannot be read/parsed). */
export function appDiff(slug: string): { slug: string; name: string; held: boolean; pinned_at: number; sha256: string | null; diff: ToolDiff | null; reason?: string } {
  const reg = table.getToolRegistry(slug);
  if (!reg) {
    throw new RoomError(404, 'no such app', 'slug');
  }
  const file = readToolFile(reg.root);
  /* sha256 = the file this diff describes: Approve sends it back as
     expected_sha256, so what is pinned is exactly what the human was shown */
  const base = { slug, name: reg.name, held: reg.held, pinned_at: reg.pinned_at ?? reg.registered_at, sha256: file?.sha256 ?? null };
  if (!file || !file.parseOk) {
    return { ...base, diff: null, reason: 'unreadable' };
  }
  if (!reg.tool_json) {
    return { ...base, diff: null, reason: 'no-pinned-copy' };
  }
  let pinned: any;
  try {
    pinned = JSON.parse(reg.tool_json);
  } catch {
    return { ...base, diff: null, reason: 'no-pinned-copy' };
  }
  return { ...base, diff: toolDiff(pinned, file.parsed) };
}

/** Is this app held (tool.json changed, awaiting a human's Approve)? */
export function isHeld(slug: string | null | undefined): boolean {
  return !!slug && !!table.getToolRegistry(slug)?.held;
}

/** The pinned tool.json of a registered, not-held app, for the tool manager [tool-manager]: the same bytes-once read every
 *  action path uses. `blocked` says why nothing from the file may be acted on. */
export function pinnedTool(slug: string): { ok: true; reg: ToolRegistryRow; parsed: any } | { ok: false; reason: 'no-such-app' | 'held' | 'unregistered' } {
  const reg = table.getToolRegistry(slug);
  if (!reg) {
    return { ok: false, reason: 'no-such-app' };
  }
  const pin = readPinned(reg);
  return pin.held ? { ok: false, reason: pin.blocked } : { ok: true, reg, parsed: pin.parsed };
}

/* --------------------------------------------------------------- status ---- */

/** status/app.json as the app wrote it. `port`/`pid` are NOT trusted here —
 *  verifyEndpoint (app-endpoint.ts) decides whether they mean anything. */
interface AppJson {
  port: unknown;
  pid: unknown;
}
function readAppJson(root: string): AppJson | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'status', 'app.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? { port: parsed.port, pid: parsed.pid } : null;
  } catch {
    return null;
  }
}

/** The app's endpoint, verified [rooms/apps-sec P0]: null = not running (no
 *  status/app.json); otherwise verifyEndpoint's answer. Nothing carries the
 *  bearer, and no panel is built, unless this says ok. */
function endpointOf(root: string): EndpointCheck | null {
  const info = readAppJson(root);
  return info ? verifyEndpoint(root, info) : null;
}

const unverifiedNoted = new Map<string, string>();
function noteUnverified(slug: string, reason: string): void {
  if (unverifiedNoted.get(slug) !== reason) {
    unverifiedNoted.set(slug, reason);
    log(`${slug}: endpoint unverified (${reason}) — no bearer, no new panel`);
  }
}

function isConnRefused(e: unknown): boolean {
  const err = e as { code?: string; cause?: unknown; errors?: unknown[] } | null;
  if (!err) {
    return false;
  }
  if (err.code === 'ECONNREFUSED') {
    return true;
  }
  if (err.cause) {
    return isConnRefused(err.cause);
  }
  if (Array.isArray(err.errors)) {
    return err.errors.some(isConnRefused);
  }
  return false;
}

type LiveStatus = 'running' | 'down' | 'unknown';

const statusCache = new Map<string, { at: number; port: number; status: LiveStatus }>();

/** GET .../health within 2s: any answer at all is 'running' (§4.4 status is
 *  about reachability, not correctness); a refused connection is 'down'; a
 *  timeout or any other network error is 'unknown' — three outcomes, never
 *  two, so a slow/loaded app is never reported as dead. Cached ~5s per
 *  (slug, port) so the sheet doesn't hammer every app on every open. Carries
 *  no credential. */
async function probeStatus(slug: string, port: number): Promise<LiveStatus> {
  const cached = statusCache.get(slug);
  if (cached && cached.port === port && Date.now() - cached.at < STATUS_TTL_MS) {
    return cached.status;
  }
  let status: LiveStatus;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'manual', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    void res.body?.cancel().catch(() => {});
    status = 'running';
  } catch (e) {
    status = isConnRefused(e) ? 'down' : 'unknown';
  }
  statusCache.set(slug, { at: Date.now(), port, status });
  return status;
}

/* ------------------------------------------------------------- catalog ---- */

export interface CatalogApp {
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  access: 'shared' | 'exclusive';
  panels: Array<{ title: string; icon: string | null }>;
  status: 'running' | 'down' | 'unknown' | 'held' | 'unregistered';
  /** registration state [ticket]: registered | needs-approval (held) |
   *  unregistered-candidate (a human unregistered it; it may still be in rooms) */
  state: AppState;
  /** what its panels may do [ticket]: enabled | held | unregistered */
  actions: AppActions;
  /** a held app's pending change (GET /api/apps/:slug/diff's answer), for
   *  Settings → Apps; null otherwise. Only on GET /api/apps for a person. */
  pending?: ReturnType<typeof appDiff> | null;
  /** Why status is what it is, when that is not self-evident (an unverified
   *  endpoint). null otherwise. For a human; never parse it. */
  reason: string | null;
  /** tool.json `"jobs": true` — the app runs jobs that can outlive a move
   *  (the Move dialog's running-job line is shown only then) */
  jobs: boolean;
  /** tool.json declares an HTTP bind handshake (`lifecycle.bind.http`). With
   *  `access: 'exclusive'` it decides whether a DOWN app can be added: the
   *  add calls the bind, and a bind to an app that is not running is a 502
   *  (bind-failed), so the sheet disables Add/Move until it runs. A shared app,
   *  or an exclusive one with no HTTP bind, is added while down (its panel
   *  fills in once it runs). */
  bind: boolean;
  /** tool.json `move_notes`: what a Move does to THIS app's data, in its own
   *  words (plain text, at most 4, each <= 140 chars; bad entries dropped) */
  move_notes: string[];
  port: number | null;
  rooms: Array<{ id: string; name: string }>;
  registered_at: number;
  /** sha256 of tool.json on disk now — for a held app, the hash `approve`
   *  would pin; send it back as `expected_sha256`. null = unreadable. */
  sha256: string | null;
  /** tool.json `links` [rooms/tool-links]: pattern -> label, the well-formed
   *  ones only (a line's `links[].ref` must match one). {} = none. */
  links: Record<string, string>;
  /** tool.json `links["@meta"]`: the batch endpoint as a path RELATIVE to the
   *  app panel's frame (the page GETs frameUrl + this + ?refs=…), or null. */
  links_meta: string | null;
  /** the app that replaced this unregistered one [app supersede]: slug + name, null = none */
  superseded_by: { slug: string; name: string } | null;
}

const MOVE_NOTES_MAX = 4;
const MOVE_NOTE_CHARS = 140;
/** Validate tool.json `move_notes`: an array of plain one-line strings. A bad
 *  entry (not a string, empty, over 140 chars, a control character) is
 *  IGNORED, never fatal; at most the first 4 good ones are kept. */
export function moveNotes(v: unknown): string[] {
  if (!Array.isArray(v)) {
    return [];
  }
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= MOVE_NOTE_CHARS && !/[\u0000-\u001f\u007f]/.test(x))
    .slice(0, MOVE_NOTES_MAX);
}

function panelSummaries(parsed: any): Array<{ title: string; icon: string | null }> {
  const panels = Array.isArray(parsed?.panels) ? parsed.panels : [];
  return panels.map((p: any) => ({
    title: typeof p?.title === 'string' ? p.title : '',
    icon: typeof p?.icon === 'string' ? p.icon : null,
  }));
}

/** One catalog entry: readPinned (a mismatch holds it — never auto-cleared,
 *  only `approve` clears `held`), then live status from a VERIFIED endpoint
 *  only. A stopped app (no listener) is 'down'; any other verification
 *  failure is 'unknown' with a reason, and is never probed. */
async function catalogEntry(reg: ToolRegistryRow): Promise<CatalogApp> {
  const pin = readPinned(reg);
  const parsed = (pin.held ? pin.display : pin.parsed) ?? {};
  const info = readAppJson(reg.root);
  let status: CatalogApp['status'];
  let reason: string | null = null;
  if (pin.held) {
    status = pin.blocked;
  } else if (!info) {
    status = 'down';
  } else {
    const ep = verifyEndpoint(reg.root, info);
    if (ep.ok) {
      status = await probeStatus(reg.slug, ep.port);
    } else if (ep.reason === 'no-listener') {
      status = 'down';
    } else {
      status = 'unknown';
      reason = `endpoint unverified: ${ep.reason}`;
    }
  }
  const panels = panelSummaries(parsed);
  const links = parseLinks(parsed.links, panelViewsOf(parsed));
  return {
    slug: reg.slug,
    name: typeof parsed.name === 'string' ? parsed.name : reg.name,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    icon: panels[0]?.icon ?? null,
    access: parsed.access === 'exclusive' ? 'exclusive' : 'shared',
    panels,
    status,
    state: appState(pin.held ? pin.blocked : 'enabled'),
    actions: pin.held ? pin.blocked : 'enabled',
    reason,
    jobs: parsed.jobs === true,
    bind: bindHttpPath(parsed) !== null,
    move_notes: moveNotes(parsed.move_notes),
    port: typeof info?.port === 'number' ? info.port : null,
    rooms: table.roomsForApp(reg.slug).map((r) => ({ ...r, ids: table.familyRoomIds(r.id) })), // ids: the head + its workgroups [family apps]
    registered_at: reg.registered_at,
    sha256: pin.sha256,
    links: Object.fromEntries(links.specs.map((sp) => [sp.pattern, sp.label])),
    links_meta: links.meta,
    superseded_by: reg.superseded_by ? { slug: reg.superseded_by, name: table.getToolRegistry(reg.superseded_by)?.name ?? reg.superseded_by } : null,
  };
}

export async function getCatalogEntry(slug: string): Promise<CatalogApp | undefined> {
  const reg = table.getToolRegistry(slug);
  return reg ? catalogEntry(reg) : undefined;
}

/** GET /api/apps. Reconciles first (fill in any panel a since-started app
 *  didn't have yet), so a caller never has to ask twice. A reconcile failure
 *  is logged and never fails the read. */
export async function catalog(): Promise<CatalogApp[]> {
  await reconcile().catch((e) => log(`reconcile failed: ${(e as Error)?.message ?? e}`));
  return Promise.all(table.listToolRegistry().map(catalogEntry));
}

/* ------------------------------------------------------------- links ---- */

/** Why a line link cannot be written, for the 400's message (the route adds
 *  field 'links[i]'). */
export class LinkError extends Error {}

/**
 * Resolve one line link [rooms/tool-links] against the PINNED tool.json:
 * the app is registered, a member of THIS room, not held, and `ref` matches
 * one of its declared patterns. Answers what meta.links stores — the label
 * (the caller's, else the pattern's), the view's path relative to the app
 * panel's frame (`view_path`, what {panel:'preview', view:{path}} takes), and
 * the room's panel of that app whose frame reaches it (null: none here yet).
 */
export function resolveLink(roomId: string, tool: string, ref: string, label: string | null): StoredLink {
  /* a superseded slug is answered by its successor, at post time too: no new
     dead-slug line is ever stored [app supersede] Owner 2026-10-05 */
  tool = supersededTarget(tool)?.slug ?? tool;
  const reg = table.getToolRegistry(tool);
  if (!reg) {
    throw new LinkError(`no app "${tool}" is registered`);
  }
  if (!table.listRoomApps(roomId).some((a) => a.slug === tool)) {
    throw new LinkError(`${reg.name} is not in this room`);
  }
  const pin = readPinned(reg);
  if (pin.held) {
    throw new LinkError(pin.blocked === 'unregistered'
      ? `${reg.name} is not registered: a person must register it again`
      : `${reg.name} is held: its tool.json changed and a person must approve it`);
  }
  const views = panelViewsOf(pin.parsed);
  const { specs } = parseLinks(pin.parsed?.links, views);
  const hit = matchRef(specs, ref);
  if (!hit) {
    const known = specs.map((sp) => sp.pattern).join(', ');
    throw new LinkError(`ref ${JSON.stringify(ref)} matches none of ${reg.name}'s links${known ? ` (${known})` : ' (it declares none)'}`);
  }
  /* the family's apps live on its head room, and so do their frame URLs
     [family apps] */
  const head = table.familyHeadId(roomId);
  const target = resolveView(hit.spec, head, hit.values, views);
  if (!target) {
    throw new LinkError(`${reg.name}'s view for ${JSON.stringify(ref)} is not under its panel`); // parseLinks refused this shape; defensive
  }
  /* the panel whose frame maps view_path: its registered url's folder is the
     folder view_path was computed against */
  const dir = dirOf(panelPath(target.panelView, head));
  const panel = table
    .listPanels(roomId)
    .filter((p) => p.app_slug === tool)
    .find((p) => {
      try {
        return dirOf(new URL(p.url).pathname) === dir;
      } catch {
        return false;
      }
    });
  return { tool, ref, label: label ?? hit.spec.label, view_path: target.view_path, panel_id: panel?.id ?? null };
}

/* --------------------------------------------------------- panel specs ---- */

/** Every declared panel view, with `:roomId` filled in for one room. Run
 *  through the SAME allow-list a directly-registered panel uses — loopback
 *  always passes, this is defence in depth against a malformed view. The port
 *  must come from a verified endpoint. */
function panelSpecsFor(parsed: any, port: number, roomId: string): AppPanelSpec[] {
  const panels = Array.isArray(parsed?.panels) ? parsed.panels : [];
  const out: AppPanelSpec[] = [];
  for (const p of panels) {
    const view = typeof p?.view === 'string' ? p.view : '';
    if (!view.startsWith('GET /') || !view.includes(':roomId')) {
      continue; // caught at registration; defensive here
    }
    const path = view.slice(4).split(':roomId').join(encodeURIComponent(roomId));
    const checked = checkPanelUrl(`http://127.0.0.1:${port}${path}`);
    if (!checked.ok) {
      continue;
    }
    out.push({
      title: typeof p?.title === 'string' && p.title.trim() ? p.title : (typeof parsed?.name === 'string' ? parsed.name : 'App'),
      icon: typeof p?.icon === 'string' ? p.icon : null,
      url: checked.url,
      scripts: p?.scripts === true,
      uploads: p?.uploads === true,
    });
  }
  return out;
}

/** For backfill: the pinned spec an EXISTING panel's url is, for the room
 *  the panel is IN, on the app's own (verified) port — or null. Exact URL
 *  equality against the view filled in with THAT room's id, so a panel in
 *  room A showing room B's view is never adopted [P1-d]; the spec is what
 *  adoption overwrites the panel's title/icon/flags from. */
function specMatcher(parsed: any, port: number): (url: string, roomId: string) => AppPanelSpec | null {
  return (url: string, roomId: string) => panelSpecsFor(parsed, port, roomId).find((spec) => spec.url === url) ?? null;
}

/** Backfill one registered app (registration + boot ONLY — never the loop):
 *  only from a verified endpoint, only panels no newer than the registration,
 *  only a panel whose view names its own room. */
function backfillFor(reg: ToolRegistryRow, parsed: any): void {
  const ep = endpointOf(reg.root);
  if (!ep) {
    return;
  }
  if (!ep.ok) {
    noteUnverified(reg.slug, ep.reason);
    return;
  }
  const rooms = table.backfillAppPanels(reg.slug, specMatcher(parsed, ep.port), reg.registered_at, 'engine');
  if (rooms.length) {
    log(`${reg.slug}: backfilled pre-existing panels in ${rooms.length} room(s)`);
  }
}

/** Boot backfill: every registered, un-held app, once. Never throws. */
export function bootBackfill(): void {
  for (const reg of table.listToolRegistry()) {
    try {
      if (reg.held || reg.unregistered_at) {
        continue;
      }
      const pin = readPinned(reg);
      if (!pin.held) {
        backfillFor(reg, pin.parsed);
      }
    } catch (e) {
      log(`${reg.slug}: boot backfill failed: ${(e as Error)?.message ?? e}`);
    }
  }
}

/** A room's app panels that point at some OTHER port than the app's verified
 *  one (the app restarted on a new port). Left in place — they are the
 *  room's, and a human removes them — but said once. */
const stalePortNoted = new Set<string>();
function noteStalePanels(slug: string, roomId: string, port: number): void {
  for (const p of table.listPanels(roomId)) {
    if (p.app_slug !== slug) {
      continue;
    }
    let old: number;
    try {
      old = Number(new URL(p.url).port);
    } catch {
      continue;
    }
    const key = `${slug}|${roomId}|${old}|${port}`;
    if (old !== port && !stalePortNoted.has(key)) {
      stalePortNoted.add(key);
      log(`${slug}: panel ${p.id} in room ${roomId} still points at :${old}, the app now answers on :${port} — left in place`);
    }
  }
}

/** Fill-in (every 30s / on a catalog read): for each pinned, verified, running
 *  app, make sure every room ALREADY holding it has its panel(s) — a
 *  since-started app. Never creates membership (fill-only store path), never
 *  backfills, never builds a panel from an unverified port. One app failing
 *  never stops the others. */
export async function reconcile(): Promise<void> {
  for (const reg of table.listToolRegistry()) {
    try {
      await reconcileOne(reg);
    } catch (e) {
      log(`${reg.slug}: reconcile failed: ${(e as Error)?.message ?? e}`);
    }
  }
}

async function reconcileOne(reg: ToolRegistryRow): Promise<void> {
  if (reg.held || reg.unregistered_at) {
    return;
  }
  const pin = readPinned(reg);
  if (pin.held) {
    return;
  }
  const ep = endpointOf(reg.root);
  if (!ep) {
    return;
  }
  if (!ep.ok) {
    noteUnverified(reg.slug, ep.reason);
    return;
  }
  unverifiedNoted.delete(reg.slug);
  if ((await probeStatus(reg.slug, ep.port)) !== 'running') {
    return;
  }
  for (const room of table.roomsForApp(reg.slug)) {
    noteStalePanels(reg.slug, room.id, ep.port);
    const specs = panelSpecsFor(pin.parsed, ep.port, room.id);
    if (!specs.length) {
      continue;
    }
    try {
      table.fillRoomAppPanels(room.id, reg.slug, specs);
    } catch {
      /* e.g. the room is at its panel cap — best-effort, never fatal */
    }
  }
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
export function startReconcileLoop(intervalMs = 30_000): void {
  if (reconcileTimer) {
    return;
  }
  reconcileTimer = setInterval(() => {
    try {
      reconcile().catch((e) => log(`reconcile failed: ${(e as Error)?.message ?? e}`));
    } catch (e) {
      log(`reconcile tick failed: ${(e as Error)?.message ?? e}`);
    }
  }, intervalMs);
  reconcileTimer.unref?.();
}
export function stopReconcileLoop(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

/* ----------------------------------------------------------------- bind ---- */

type BindResult =
  | { outcome: 'not-supported' }
  | { outcome: 'ok'; bound?: boolean; released?: boolean; unchanged?: boolean }
  | { outcome: 'refused'; reason: 'no-seat' | 'job-running'; jobs?: Array<{ room_id: string; job_id: string }> }
  | { outcome: 'network-error' };

/** `lifecycle.bind` as an OBJECT with an `.http` key only — a plain string
 *  (script-only, e.g. today's image-studio scripts/bind.sh) or no bind field
 *  at all means 'not-supported'; the script is never run (§4.4: the engine
 *  never executes tool scripts). Read from the PINNED parse only. */
function bindHttpPath(parsed: any): string | null {
  const bind = parsed?.lifecycle?.bind;
  return bind && typeof bind === 'object' && typeof bind.http === 'string' ? bind.http : null;
}

/** At most BIND_BODY_MAX bytes of a response body; the rest is cancelled. */
async function readBounded(res: Response): Promise<string> {
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < BIND_BODY_MAX) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      n += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, BIND_BODY_MAX).toString('utf8');
}

async function readJsonBounded(res: Response): Promise<any> {
  try {
    return JSON.parse(await readBounded(res));
  } catch {
    return {};
  }
}

/** The bind call. Carries the engine's bearer, so `port` MUST come from a
 *  verified endpoint (the caller's job, and the only caller does it). */
async function callBind(bindHttp: string, port: number, roomId: string, force: boolean): Promise<BindResult> {
  const m = /^POST\s+(\/\S*)$/.exec(bindHttp.trim());
  const path = m ? m[1] : '/bind';
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.bearerToken()}` },
      body: JSON.stringify({ room_id: roomId, ...(force ? { force: true } : {}) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(BIND_TIMEOUT_MS),
    });
    if (res.status === 409) {
      const body = await readJsonBounded(res);
      if (body?.reason === 'no-seat' || body?.reason === 'job-running') {
        return { outcome: 'refused', reason: body.reason, jobs: Array.isArray(body.jobs) ? body.jobs : undefined };
      }
      return { outcome: 'network-error' }; // an unrecognised 409 is not a shape we can trust
    }
    if (res.status === 401 || !res.ok) {
      void res.body?.cancel().catch(() => {});
      return { outcome: 'network-error' };
    }
    const body = await readJsonBounded(res);
    if (body?.unchanged === true) {
      return { outcome: 'ok', unchanged: true };
    }
    return { outcome: 'ok', bound: body?.bound, released: body?.released };
  } catch {
    return { outcome: 'network-error' };
  }
}

/* ------------------------------------------------------------ membership ---- */

export type AddAppOutcome =
  | {
      ok: true;
      app: { slug: string; panel_ids: string[] };
      moved_from: { id: string; name: string } | null;
      bind: 'called' | 'failed' | 'not-supported' | null;
      entries: RoomLineEntry[];
    }
  | { ok: false; status: 404; body: { error: string; field: string } }
  | { ok: false; status: 409; body: { error: 'held' | 'not-registered' } }
  | { ok: false; status: 409; body: { error: 'exclusive'; heldBy: { id: string; name: string } } }
  | { ok: false; status: 409; body: { error: 'bind-refused'; reason: 'no-seat' | 'job-running'; jobs?: Array<{ room_id: string; job_id: string }> } }
  | {
      ok: false;
      status: 502;
      body: { error: 'bind-failed'; reason?: 'endpoint-unverified' | 'endpoint-unverified-platform'; detail?: string };
    };

/**
 * POST /api/rooms/:id/apps {slug, move?, force?}. Membership is human-only
 * (the route enforces it); the actor recorded is always 'user'.
 *
 * Sequencing (Owner/coordinator 2026-09-28, supersedes the original "add then
 * bind" order): for an app whose tool.json declares an HTTP bind, the bind
 * call happens BEFORE any membership write — a refused bind (no-seat /
 * job-running, unless `force`) moves nothing.
 *
 * tool.json is read ONCE (readPinned) and that one parse decides access, bind
 * and panels [P1-a]; the endpoint is verified before the bearer is sent or a
 * panel is built [P0].
 */
export async function addAppToRoom(
  roomId: string,
  slug: unknown,
  opts: { move?: boolean; force?: boolean },
): Promise<AddAppOutcome> {
  if (typeof slug !== 'string' || !slug) {
    return { ok: false, status: 404, body: { error: 'no such app', field: 'slug' } };
  }
  const reg = table.getToolRegistry(slug);
  if (!reg) {
    return { ok: false, status: 404, body: { error: 'no such app', field: 'slug' } };
  }
  const pin = readPinned(reg);
  if (pin.held) {
    return { ok: false, status: 409, body: { error: pin.blocked === 'unregistered' ? 'not-registered' : 'held' } };
  }
  const parsed = pin.parsed;
  const access = parsed?.access === 'exclusive' ? 'exclusive' : 'shared';
  // Exclusive apps compare FAMILIES: a main room and its workgroup are one place [family apps].
  const head = table.familyHeadId(roomId);
  const elsewhere = table.roomsForApp(slug).filter((r) => r.id !== head);
  if (access === 'exclusive' && elsewhere.length && !opts.move) {
    return { ok: false, status: 409, body: { error: 'exclusive', heldBy: elsewhere[0] } };
  }
  const ep = endpointOf(reg.root);
  if (ep && !ep.ok) {
    noteUnverified(slug, ep.reason);
  }
  /* The panels this add would draw, and the room's panel cap, are settled
     BEFORE the bind call: a full room must refuse while the app is still
     where it was, not after it has bound here [rooms/apps-sec]. */
  const specs = ep?.ok ? panelSpecsFor(parsed, ep.port, head) : [];
  if (table.appPanelsWouldExceedCap(roomId, specs.map((sp) => sp.url))) {
    throw new RoomError(409, `a room holds at most ${PANELS_MAX} panels`, 'panel');
  }

  let bind: 'called' | 'failed' | 'not-supported' | null = null;
  if (access === 'exclusive') {
    const bindHttp = bindHttpPath(parsed);
    if (!bindHttp) {
      /* No handshake to confirm the placement with — a plain-string (script-
         only) or absent lifecycle.bind — so this exclusive app is exactly as
         tolerant of being down as a shared one: the row is created, no
         panel, reconcile fills it in once it's running. */
      bind = 'not-supported';
    } else if (!ep) {
      /* A DECLARED handshake this app cannot answer because it isn't even
         running is a 502 like any other unreachable bind — never a silent
         "we'll wire the panel up later" once there's a call to make. */
      return { ok: false, status: 502, body: { error: 'bind-failed' } };
    } else if (!ep.ok) {
      /* Unverified: the bearer is never sent [P0]. */
      return {
        ok: false,
        status: 502,
        body: {
          error: 'bind-failed',
          reason: ep.reason === 'platform' ? 'endpoint-unverified-platform' : 'endpoint-unverified',
          detail: ep.reason,
        },
      };
    } else {
      const result = await callBind(bindHttp, ep.port, head, opts.force === true);
      if (result.outcome === 'refused') {
        if (result.reason === 'job-running' && opts.force) {
          bind = 'called';
        } else {
          return { ok: false, status: 409, body: { error: 'bind-refused', reason: result.reason, jobs: result.jobs } };
        }
      } else if (result.outcome === 'network-error') {
        return { ok: false, status: 502, body: { error: 'bind-failed' } };
      } else {
        bind = 'called';
      }
    }
  }

  /* Re-check + move-out + add in ONE transaction. The bind call awaited, so
     another add may have placed this exclusive app elsewhere meanwhile; the
     loser of that race gets 409 exclusive and writes nothing. Any throw
     (an archived room, the cap after all) rolls the move-out back too. */
  const movedFrom = access === 'exclusive' && elsewhere.length ? elsewhere[0] : null;
  const placed = table.placeRoomApp(roomId, slug, specs, { exclusive: access === 'exclusive', from: movedFrom?.id ?? null });
  if (placed.conflict) {
    if (bind === 'called') {
      log(
        `${slug}: bound to room ${roomId} but lost the placement race to room ${placed.conflict.id} — ` +
          'the app may now consider itself bound here; membership stays with the winner',
      );
    }
    return { ok: false, status: 409, body: { error: 'exclusive', heldBy: placed.conflict } };
  }
  const out = placed.results[placed.results.length - 1];
  return {
    ok: true,
    app: { slug: out.result.slug, panel_ids: out.result.panel_ids },
    moved_from: movedFrom,
    bind,
    entries: out.entries,
  };
}

export function removeAppFromRoom(roomId: string, slug: string): { removed: { slug: string; panel_ids: string[] }; entries: RoomLineEntry[] } {
  const out = table.removeRoomApp(roomId, slug, { actor: 'user' });
  return { removed: { slug: out.result.slug, panel_ids: out.result.panel_ids }, entries: out.entries };
}

/* ------------------------------------------------------- panel actions ---- */

const ACTION_VALUE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTION_BODY_MAX = 8 * 1024;
const ACTION_STRING_MAX = 2000;
const ACTION_TIMEOUT_MS = 10_000;

export interface PanelActionOutcome {
  status: number;
  body: Record<string, unknown>;
  /** the app's own status, when the call reached it */
  upstream?: number;
  slug?: string;
  /** [ticket] set only when the call succeeded (2xx) AND the PINNED verb
   *  declares `"postsToRoom": true`: what the app answered as `roomLine`
   *  (checked by roomLineOf), for the route to post as the person */
  post?: { appName: string; verb: string; roomLine: unknown; to: PostsToRoom['to']; data: boolean };
}

/* -------------------------------------------------------- posts to room ---- */

export const ROOM_LINE_TEXT_MAX = 1000;

/** Plain text: CR/CRLF -> LF; every other C0/C1 control (ESC included, so no
 *  terminal sequence survives) dropped; tabs and newlines kept; trimmed. */
function plainText(s: string): string {
  let out = '';
  for (const ch of s.replace(/\r\n?/g, '\n')) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || (c >= 32 && c !== 127 && !(c >= 0x80 && c <= 0x9f))) {
      out += ch;
    }
  }
  return out.trim();
}

export type RoomLineCheck =
  | { ok: true; text: string; links: Array<{ ref: string; label: string | null }> }
  | { ok: false; warning: string };

/**
 * The `roomLine` a postsToRoom verb's app answered [ticket]:
 * `{text, links?: [{label?, path}]}`. null = the app sent none (nothing to
 * post, no warning). A bad shape is a WARNING, never an error: the person's
 * action already succeeded upstream and must not be reported as failed.
 * text: a string, <= ROOM_LINE_TEXT_MAX characters as sent (never truncated),
 * non-empty once plain. links: <= LINKS_MAX, each `path` (alias `ref`) a ref
 * into THIS app's declared `links` — resolved by the route (resolveLink, the
 * tool line links' own rules), `label` checked there too.
 */
export function roomLineOf(raw: unknown): RoomLineCheck | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isPlainObject(raw)) {
    return { ok: false, warning: 'roomLine is {text, links?}: nothing was posted' };
  }
  if (typeof raw.text !== 'string') {
    return { ok: false, warning: 'roomLine.text is a string: nothing was posted' };
  }
  if (raw.text.length > ROOM_LINE_TEXT_MAX) {
    return { ok: false, warning: `roomLine.text is ${raw.text.length} characters (max ${ROOM_LINE_TEXT_MAX}): nothing was posted` };
  }
  const text = plainText(raw.text);
  if (!text) {
    return { ok: false, warning: 'roomLine.text is empty: nothing was posted' };
  }
  const links: Array<{ ref: string; label: string | null }> = [];
  if (raw.links !== undefined && raw.links !== null) {
    if (!Array.isArray(raw.links) || raw.links.length > LINKS_MAX) {
      return { ok: false, warning: `roomLine.links is a list of at most ${LINKS_MAX} {label?, path}: nothing was posted` };
    }
    for (const [i, l] of raw.links.entries()) {
      const ref = isPlainObject(l) ? (l.path ?? l.ref) : undefined;
      if (typeof ref !== 'string' || !ref || (l.label !== undefined && l.label !== null && typeof l.label !== 'string')) {
        return { ok: false, warning: `roomLine.links[${i}] is {label?, path}: nothing was posted` };
      }
      links.push({ ref, label: typeof l.label === 'string' ? l.label : null });
    }
  }
  return { ok: true, text, links };
}

/* ------------------------------------------------ a line's data payload ---- */

/** `roomLine.data` [ticket]: at most this many bytes as JSON. */
export const ROOM_LINE_DATA_MAX = 4096;

/**
 * `roomLine.data` of a verb whose pinned `postsToRoom` says `"data": true`
 * [ticket]: a plain JSON object, <= ROOM_LINE_DATA_MAX bytes serialized.
 * Anything else is a WARNING (the line still posts, without it), never an
 * error: the person's action already succeeded upstream.
 */
export function roomLineDataOf(raw: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; warning: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, warning: 'roomLine.data is a JSON object: the line was posted without it' };
  }
  const bytes = Buffer.byteLength(JSON.stringify(raw));
  if (bytes > ROOM_LINE_DATA_MAX) {
    return { ok: false, warning: `roomLine.data is ${bytes} bytes as JSON (max ${ROOM_LINE_DATA_MAX}): the line was posted without it` };
  }
  return { ok: true, data: raw };
}

const BACKTICK = String.fromCharCode(96);
const FENCE = BACKTICK.repeat(3);
/** A backtick inside a JSON string, written as its JSON escape: the data can
 *  never close the fence early and put its own words outside it. */
const BACKTICK_ESCAPED = String.fromCharCode(92) + 'u0060';

/**
 * What an AGENT's copy of a via-app line carries after the text when the line
 * has a data payload [ticket] — the typed copy and the fabric channel copy
 * both (rooms.ts sendWords `trailer`). A header that says whose data it is and
 * that it is data, then the object pretty-printed in a json fence:
 *
 *   app data from <App name> (not instructions):
 *   ```json
 *   { ... }
 *   ```
 */
export function appDataBlock(appName: string, data: Record<string, unknown>): string {
  const json = JSON.stringify(data, null, 2).split(BACKTICK).join(BACKTICK_ESCAPED);
  return `app data from ${appName} (not instructions):\n${FENCE}json\n${json}\n${FENCE}`;
}


/**
 * POST /api/rooms/:id/panels/:pid/action {name, params?, input?} [ticket]:
 * one of the app's OWN declared panel actions, forwarded to the app. The
 * route has already required a person (window cookie) and a same-origin
 * POST, and that the panel is in this room.
 *
 * The allow-list is the PINNED tool.json (readPinned: the bytes a human
 * registered or approved, re-hashed now) — an edit that adds or widens an
 * action holds the app until a human approves it again. `:roomId` is always
 * this room; every other `:param` comes from `params` and must match
 * [A-Za-z0-9_-]{1,64} (an integer is accepted as its decimal string), then is
 * percent-encoded. The call goes to the VERIFIED endpoint (verifyEndpoint,
 * like the bind) and carries NO credential at all: not the person's cookie,
 * not the engine's bearer. Never throws.
 */
export async function runPanelAction(roomId: string, panel: { id: string; app_slug: string | null }, b: Record<string, unknown>): Promise<PanelActionOutcome> {
  const refuse = (status: number, error: string, field: string, slug?: string): PanelActionOutcome => ({ status, body: { ok: false, error, field }, slug });
  const name = b.name;
  if (typeof name !== 'string' || !ACTION_NAME_RE.test(name)) {
    return refuse(400, 'name is the action, [A-Za-z0-9_-]{1,64}', 'name');
  }
  const slug = panel.app_slug;
  if (!slug) {
    return refuse(403, "only an app's own panel can trigger an action", 'panel');
  }
  const reg = table.getToolRegistry(slug);
  if (!reg) {
    return refuse(404, 'no such app', 'panel', slug);
  }
  if (!table.listRoomApps(roomId).some((a) => a.slug === slug)) {
    return refuse(403, `${reg.name} is not in this room`, 'panel', slug);
  }
  const pin = readPinned(reg);
  if (pin.held) {
    /* the host words these for the panel [ticket]: held -> 'needs-approval',
       not-registered -> 'not-registered' */
    return pin.blocked === 'unregistered'
      ? { status: 409, body: { ok: false, error: 'not-registered', app_status: 'unregistered', field: 'panel' }, slug }
      : { status: 409, body: { ok: false, error: 'held', app_status: 'held', field: 'panel' }, slug };
  }
  const spec = panelActionsOf(pin.parsed).actions.get(name);
  if (!spec) {
    return refuse(403, `${reg.name} does not let its panel trigger "${name}"`, 'name', slug);
  }

  const params = b.params === undefined || b.params === null ? {} : b.params;
  if (!isPlainObject(params)) {
    return refuse(400, 'params is an object', 'params', slug);
  }
  const values = new Map<string, string>();
  for (const [k, v] of Object.entries(params)) {
    if (k === 'roomId') {
      return refuse(400, 'roomId is always this room', 'params.roomId', slug);
    }
    if (!spec.params.includes(k)) {
      return refuse(400, `"${name}" takes no param ${JSON.stringify(k)}`, `params.${k}`, slug);
    }
    const s = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
    if (typeof s !== 'string' || !ACTION_VALUE_RE.test(s)) {
      return refuse(400, `params.${k} must match [A-Za-z0-9_-]{1,64}`, `params.${k}`, slug);
    }
    values.set(k, s);
  }
  const missing = spec.params.find((p) => !values.has(p));
  if (missing) {
    return refuse(400, `"${name}" needs params.${missing}`, `params.${missing}`, slug);
  }

  let body: string | undefined;
  if (spec.input) {
    const raw = b.input === undefined || b.input === null ? {} : b.input;
    if (!isPlainObject(raw)) {
      return refuse(400, 'input is an object', 'input', slug);
    }
    const kept: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!spec.input.includes(k) || isActorKey(k)) {
        continue; // only what the verb declares; never who did it
      }
      if (typeof v === 'string') {
        if (v.length > ACTION_STRING_MAX) {
          return refuse(413, `input.${k} is ${v.length} characters (max ${ACTION_STRING_MAX})`, `input.${k}`, slug);
        }
      } else if (typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) {
        return refuse(400, `input.${k} must be a string, number or boolean`, `input.${k}`, slug);
      }
      kept[k] = v;
    }
    body = JSON.stringify(kept);
    if (Buffer.byteLength(body) > ACTION_BODY_MAX) {
      return refuse(413, `input is ${Buffer.byteLength(body)} bytes (max ${ACTION_BODY_MAX})`, 'input', slug);
    }
  } else if (b.input !== undefined && b.input !== null) {
    return refuse(400, `"${name}" takes no input`, 'input', slug);
  }

  const ep = endpointOf(reg.root);
  if (!ep) {
    return refuse(503, `${reg.name} is not running`, 'panel', slug);
  }
  if (!ep.ok) {
    noteUnverified(slug, ep.reason);
    return { status: 502, body: { ok: false, error: 'endpoint-unverified', detail: ep.reason, field: 'panel' }, slug };
  }
  const path =
    '/' +
    spec.segments
      .map((s) => {
        const p = ACTION_PARAM_RE.exec(s)?.[1];
        return p === undefined ? s : encodeURIComponent(p === 'roomId' ? table.familyHeadId(roomId) : values.get(p)!);
      })
      .join('/');
  const checked = checkPanelUrl(`http://127.0.0.1:${ep.port}${path}`);
  if (!checked.ok) {
    return refuse(403, checked.error, 'panel', slug); // loopback always passes; defensive
  }
  try {
    const res = await fetch(checked.url, {
      method: spec.method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
    const text = await readBounded(res);
    let result: unknown = null;
    try {
      result = JSON.parse(text);
    } catch {
      /* not JSON: the status still says it */
    }
    const up = res.status;
    if (up >= 200 && up < 300) {
      const post = spec.postsToRoom
        ? { appName: reg.name, verb: name, roomLine: isPlainObject(result) ? result.roomLine : undefined, to: spec.postsToRoom.to, data: spec.postsToRoom.data }
        : undefined;
      return { status: 200, body: { ok: true, status: up, result }, upstream: up, slug, ...(post ? { post } : {}) };
    }
    const said = isPlainObject(result) && typeof result.error === 'string' ? result.error.slice(0, 300) : `${reg.name} answered ${up}`;
    /* The app's 4xx/5xx is passed through — except 401/407, which the room
       page would read as ITS login lapsing — and a redirect or 1xx is 502. */
    const status = up >= 400 && up < 600 && up !== 401 && up !== 407 ? up : 502;
    return { status, body: { ok: false, status: up, error: said, result }, upstream: up, slug };
  } catch (e) {
    const timeout = (e as Error)?.name === 'TimeoutError';
    return {
      status: timeout ? 504 : 502,
      body: timeout
        ? { ok: false, error: `${reg.name} did not answer in ${ACTION_TIMEOUT_MS / 1000} s`, outcome: 'could_not_tell' }
        : { ok: false, error: `${reg.name} could not be reached` },
      slug,
    };
  }
}
