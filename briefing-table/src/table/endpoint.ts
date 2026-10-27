/**
 * Mapping-table ENDPOINT (Seam C2) — the single access surface for the table.
 *
 * Everything in the engine reaches the mapping table through `table` here, never
 * by opening the db file. Today it wraps the local SQLite store; the day the
 * table moves (e.g. to the server for laptop-pickup), this is the ONE place that
 * swaps a local call for a remote one — callers don't change. That indirection
 * is the whole point of decision 5 / Seam C2.
 *
 * Writer rule (decision 5): session FACTS (session_id, state) are written by the
 * per-component MECHANICS (#2). At M1/M2 with one vendor the WS handler is that
 * mechanics layer; when the #1/#2 split formalizes, the per-component module
 * becomes the writer. Harbor owns the record/schema (defined in ./store.ts).
 *
 * Consumer rule (decision 7): a `corrupted` session_id must NEVER be --resume'd.
 * Resume logic (a later milestone) reads state through this endpoint and refuses
 * a corrupted row.
 */
import * as store from './store.ts';
import * as roomBus from '../engine/room-bus.ts';
import type {
  SessionRow,
  SessionState,
  SessionPrefs,
  Recipe,
  RecipeVendor,
  LogoAsset,
  IconRating,
  Room,
  RoomSeat,
  RoomState,
  SeatPolicy,
  OccupantKind,
  LineKind,
  HistoryReason,
  SeatHistoryRow,
  RoomLineEntry,
  RoomActor,
  RoomActionOpts,
  RoomAction,
  LineInput,
  OccupantInput,
  RoomPanel,
  RoomNote,
  PanelInput,
  RoomAssetRecord,
  PaneTokenRow,
  PaneTokenOrigin,
  VoiceLineAuthor,
  VoiceConnection,
  VoiceEventRow,
  ToolRegistryRow,
  RoomAppRow,
  AppPanelSpec,
} from './store.ts';

export type { SessionRow, SessionState, SessionPrefs, Recipe, RecipeVendor, LogoAsset, IconRating, PaneTokenRow, PaneTokenOrigin };
export type {
  RoomNote,
  Room,
  RoomSeat,
  RoomState,
  SeatPolicy,
  OccupantKind,
  LineKind,
  HistoryReason,
  SeatHistoryRow,
  RoomLineEntry,
  RoomActor,
  RoomActionOpts,
  LineInput,
  OccupantInput,
  RoomPanel,
  PanelInput,
  RoomAssetRecord,
  VoiceLineAuthor,
  VoiceConnection,
  VoiceEventRow,
  ToolRegistryRow,
  RoomAppRow,
  AppPanelSpec,
};
/* Room vocabulary + the refusal type ride the endpoint too (Seam C2). */
export {
  RoomError,
  RESERVED_HANDLES,
  LINE_KINDS,
  SEAT_POLICIES,
  OCCUPANT_KINDS,
  ROOM_STATES,
  HISTORY_REASONS,
  LINE_BODY_MAX,
  DRAFT_BODY_MAX,
  NOTE_TEXT_MAX,
  NOTES_VISIBLE_MIN,
  normalizeHandle,
  PANEL_KINDS,
  PANELS_MAX,
  vidOf,
} from './store.ts';

/** What every mutating room verb returns: the result and the entries written. */
export interface RoomResult<T> {
  result: T;
  entries: RoomLineEntry[];
}

/**
 * Announce a committed room action on the bus, then hand back {result,
 * entries}. Called only with the RETURN value of a store verb, i.e. after its
 * transaction has committed — a refused verb throws before reaching here, so a
 * refusal is never broadcast.
 */
/* A seat's DERIVED status (live / parked / starting / dehydrated / ended) is a
   function of its occupant's session row, so a session write that moves that
   row is a seat change too: announce `room.state` for every room whose ACTIVE
   seat holds the pane (roster verbs, 2026-09-25 — without it a seat started
   from a room sat on `starting` in every pushed view until the next GET). Still
   this endpoint emitting, after the write — never a second emitter. */
function announceSeatsOf(paneid: string): void {
  for (const { room } of store.roomsForPane(paneid)) {
    roomBus.emit(room.id, { type: 'room.state' });
  }
}

/** An app's registration state moved [ticket]: every room holding it
 *  re-reads (its panels carry app_status). */
function announceAppRooms(slug: string): void {
  for (const r of store.roomsForApp(slug)) {
    for (const id of store.familyRoomIds(r.id)) {
      roomBus.emit(id, { type: 'room.state' }); // the head and its workgroups [family apps]
    }
  }
}
function announceAppNotice(slug: string, status: store.AppNotice): void {
  const done = new Set<string>();
  for (const a of store.appStatusNotice(slug, status)) {
    announce(a);
    done.add(a.roomId);
  }
  for (const r of store.roomsForApp(slug)) {
    for (const id of store.familyRoomIds(r.id)) {
      if (!done.has(id)) {
        roomBus.emit(id, { type: 'room.state' });
      }
    }
  }
}

function announce<T>(a: RoomAction<T>): RoomResult<T> {
  for (const entry of a.entries) {
    roomBus.emit(entry.room_id, { type: 'room.line', entry });
    /* a cross-posted line is ALSO news in every room it reached */
    for (const x of entry.xposts ?? []) {
      roomBus.emit(x, { type: 'room.line', entry });
    }
  }
  if (a.stateChanged) {
    roomBus.emit(a.roomId, { type: 'room.state' });
    for (const r of a.alsoStateFor ?? []) {
      roomBus.emit(r, { type: 'room.state' });
    }
  }
  return { result: a.result, entries: a.entries };
}
/* The vendor ENUM and its membership test ride the endpoint like every
   other table fact (Seam C2: this file is the sole access surface). The
   test is exported rather than left to each caller's `includes` so that
   "is this a legal vendor" has one answer — the refusal at the recipe
   route and the derivation inside the store are the same check. */
export { RECIPE_VENDORS, isRecipeVendor, RECIPE_EFFORTS, isRecipeEffort } from './store.ts';

/** Thrown from inside `table.roomBatch` to roll the whole batch back on
 *  purpose (a dry run, or a refused row) and hand `value` back to the caller. */
export class Rollback<T = unknown> extends Error {
  constructor(readonly value: T) {
    super('rollback');
  }
}

/** The room verbs a batch may run: the store's, UN-announced until commit. */
export interface RoomTx {
  createRoom(input: Parameters<typeof store.createRoom>[0], opts: RoomActionOpts): RoomResult<Room>;
  updateRoom(id: string, patch: Parameters<typeof store.updateRoom>[1], opts: RoomActionOpts): RoomResult<Room>;
  addSeat(roomId: string, input: Parameters<typeof store.addSeat>[1], opts: RoomActionOpts): RoomResult<RoomSeat>;
  moveSeat(roomId: string, seatId: string, toRoomId: string, opts: RoomActionOpts): RoomResult<RoomSeat>;
  setRoomSettings(id: string, patch: store.RoomSettingsPatch): RoomResult<Room>;
  setRoomBrief(id: string, brief: string | null, opts: RoomActionOpts): RoomResult<Room>;
  /** [assistant switch] remove + re-add + lead in ONE transaction (spec §3 item 1) */
  removeSeat(roomId: string, seatId: string, opts: Parameters<typeof store.removeSeat>[2]): RoomResult<RoomSeat>;
}

type NoteEvent = { kind: 'save' | 'remove'; roomId: string; id: string };
let noteObserver: ((e: NoteEvent) => void) | null = null;
function notify(e: NoteEvent): void {
  try {
    noteObserver?.(e);
  } catch {
    /* an observer must never fail a note write */
  }
}

export const table = {
  upsert(row: Parameters<typeof store.upsert>[0]): void {
    store.upsert(row);
    announceSeatsOf(row.paneid);
  },
  setState(paneid: string, state: SessionState): void {
    store.setState(paneid, state);
    announceSeatsOf(paneid);
  },
  /** Write per-pane presentation prefs (partial). Renderer paints; engine stores. */
  setPrefs(paneid: string, prefs: Partial<SessionPrefs>): SessionPrefs {
    return store.setPrefs(paneid, prefs);
  },
  /** Resolve a friendlyName -> paneid (the `address` lookup). */
  resolveName(friendlyName: string): string | undefined {
    return store.resolveName(friendlyName);
  },
  get(paneid: string): SessionRow | undefined {
    return store.get(paneid);
  },
  /** Record the process exit code (null when WE ended it). */
  setExitCode(paneid: string, code: number | null): void {
    store.setExitCode(paneid, code);
  },
  /** Remember the fabric check-in identity (a restart's remembered_slug hint). */
  setFabricIdentity(paneid: string, slug: string | null, instance: string | null): void {
    store.setFabricIdentity(paneid, slug, instance);
  },
  /** The pty size the screen model mirrored (the design notes §3.2). */
  setSize(paneid: string, cols: number | null, rows: number | null, at: number): void {
    store.setSize(paneid, cols, rows, at);
  },
  /** Remember who is driving (survives an engine restart). */
  setLastController(paneid: string, label: string | null): void {
    store.setLastController(paneid, label);
  },
  /** Sessions belonging to one project, newest first. The question the manager
   *  must ask once a project can hold more than one. */
  sessionsForRecipe(recipeId: string): SessionRow[] {
    return store.sessionsForRecipe(recipeId);
  },
  list(): SessionRow[] {
    return store.list();
  },
  /** A session's own git worktree (cwd override), bound by the seat start. */
  setSessionWorktree(w: store.SessionWorktree): void {
    store.setSessionWorktree(w);
  },
  getSessionWorktree(paneid: string): store.SessionWorktree | undefined {
    return store.getSessionWorktree(paneid);
  },
  dropSessionWorktrees(project: string, name: string): void {
    store.dropSessionWorktrees(project, name);
  },
  /** Room line search (store.searchLines). */
  searchLines(roomId: string, words: readonly string[], limit?: number): store.RoomLineEntry[] {
    return store.searchLines(roomId, words, limit);
  },
  /** The room typer's held queue + draft flag, persisted across restarts. */
  setTyperItems(paneid: string, items: string | null): void {
    store.setTyperItems(paneid, items);
  },
  setTyperDraft(paneid: string, draft: boolean): void {
    store.setTyperDraft(paneid, draft);
  },
  getTyperState(paneid: string): store.TyperStateRow | undefined {
    return store.getTyperState(paneid);
  },
  listTyperState(): store.TyperStateRow[] {
    return store.listTyperState();
  },
  dropTyperState(paneid: string): void {
    store.dropTyperState(paneid);
  },
  /* [switch] Basic "Switch assistant" journal (store.ts, ticket/2045) */
  getSwitch(opId: string): store.SwitchRow | undefined {
    return store.getSwitch(opId);
  },
  activeSwitchForRoom(roomId: string): store.SwitchRow | undefined {
    return store.activeSwitchForRoom(roomId);
  },
  createSwitch(row: Parameters<typeof store.createSwitch>[0]): ReturnType<typeof store.createSwitch> {
    return store.createSwitch(row);
  },
  advanceSwitch(opId: string, expectedRevision: number, to: store.SwitchState, patch?: store.SwitchPatch): store.SwitchRow | null {
    return store.advanceSwitch(opId, expectedRevision, to, patch);
  },
  listActiveSwitches(): store.SwitchRow[] {
    return store.listActiveSwitches();
  },
  holdSwitchLines(opId: string, paneid: string, items: store.HeldItem[]): store.HeldItem[] {
    return store.holdSwitchLines(opId, paneid, items);
  },
  appendSwitchLine(opId: string, item: store.HeldItem): void {
    store.appendSwitchLine(opId, item);
  },
  releaseSwitchLines(opId: string, paneid: string): store.HeldItem[] {
    return store.releaseSwitchLines(opId, paneid);
  },
  heldSwitchLines(opId: string): store.HeldItem[] {
    return store.heldSwitchLines(opId);
  },
  noteSwitchLaunch(opId: string, paneid: string | null): void {
    store.noteSwitchLaunch(opId, paneid);
  },
  setSwitchRecovery(opId: string, recovery: 'restored' | 'unchanged' | 'pending' | null): void {
    store.setSwitchRecovery(opId, recovery);
  },
  switchesForRoom(roomId: string, limit?: number): store.SwitchRow[] {
    return store.switchesForRoom(roomId, limit);
  },
  /* [connector] binding / outbox / dedup (store.ts, ticket/2031/2032) */
  getConnectorBinding(runtimeId: string): store.ConnectorBindingRow | undefined {
    return store.getConnectorBinding(runtimeId);
  },
  connectorBindingForPane(paneid: string): store.ConnectorBindingRow | undefined {
    return store.connectorBindingForPane(paneid);
  },
  createConnectorBinding(runtimeId: string, paneid: string | null): store.ConnectorBindingRow {
    return store.createConnectorBinding(runtimeId, paneid);
  },
  commitConnectorBinding(a: Parameters<typeof store.commitConnectorBinding>[0]): store.ConnectorBindingRow {
    return store.commitConnectorBinding(a);
  },
  markConnectorMaterialized(runtimeId: string, threadId: string): void {
    store.markConnectorMaterialized(runtimeId, threadId);
  },
  handoffConnectorBinding(a: Parameters<typeof store.handoffConnectorBinding>[0]): store.ConnectorBindingRow {
    return store.handoffConnectorBinding(a);
  },
  ackConnectorHandoff(runtimeId: string, incarnation: number): store.ConnectorBindingRow | undefined {
    return store.ackConnectorHandoff(runtimeId, incarnation);
  },
  readConnectorOutbox(runtimeId: string): { revision: number; record: string } | undefined {
    return store.readConnectorOutbox(runtimeId);
  },
  writeConnectorOutbox(runtimeId: string, record: string, revision: number, previousRevision: number | undefined): void {
    store.writeConnectorOutbox(runtimeId, record, revision, previousRevision);
  },
  recordConnectorSubmission(runtimeId: string, submissionId: string, contentSha: string): 'new' | 'duplicate' | 'conflict' {
    return store.recordConnectorSubmission(runtimeId, submissionId, contentSha);
  },
  setProfile(paneid: string, p: { model: string | null; effort: string | null }): void {
    store.setProfile(paneid, p);
  },

  profileBackfillTargets() {
    return store.profileBackfillTargets();
  },
  setProfileIfUnset(paneid: string, p: { model: string; effort: string }): boolean {
    return store.setProfileIfUnset(paneid, p);
  },

  profileOf(row: { profile_model?: string | null; profile_effort?: string | null } | undefined) {
    return store.profileOf(row);
  },

  markDisconnected(paneid: string): void {
    store.markDisconnected(paneid);
  },
  /** Reconcile stale `live` rows at engine startup (see store.reconcileStaleLive):
   *  claude-code → dehydrated (resumable), everything else → killed. Rows the
   *  PTY-broker still holds alive are excluded (adopted, not stale). */
  reconcileStaleLive(excludePaneids: string[] = []): { dehydrated: number; killed: number } {
    return store.reconcileStaleLive(excludePaneids);
  },
  /** Clear every `interrupted` stamp (the manager's restore-offer dismiss). */
  clearInterrupted(): number {
    return store.clearInterrupted();
  },

  /* ---- pane tokens (briefing-table-mcp §3.2) — engine/pane-tokens.ts only ---- */
  insertPaneToken(t: Parameters<typeof store.insertPaneToken>[0]): void {
    store.insertPaneToken(t);
  },
  paneTokenByHash(hash: string): PaneTokenRow | undefined {
    return store.paneTokenByHash(hash);
  },
  currentPaneToken(paneid: string): PaneTokenRow | undefined {
    return store.currentPaneToken(paneid);
  },
  revokePaneTokens(paneid: string, why: string): number {
    return store.revokePaneTokens(paneid, why);
  },
  revokePaneToken(hash: string, why: string): number {
    return store.revokePaneToken(hash, why);
  },
  reconcilePaneTokens(): string[] {
    return store.reconcilePaneTokens();
  },
  path(): string {
    return store.dbPath();
  },

  /* ---- recipes (CLI Manager phase) — saved launches, same access rule ---- */
  upsertRecipe(r: Parameters<typeof store.upsertRecipe>[0]): Recipe {
    return store.upsertRecipe(r);
  },
  updateRecipeTheme(id: string, patch: Parameters<typeof store.updateRecipeTheme>[1]): void {
    store.updateRecipeTheme(id, patch);
  },
  touchRecipeLaunched(id: string): void {
    store.touchRecipeLaunched(id);
  },
  getRecipe(id: string): Recipe | undefined {
    return store.getRecipe(id);
  },
  listRecipes(): Recipe[] {
    return store.listRecipes();
  },
  deleteRecipe(id: string): void {
    store.deleteRecipe(id);
  },
  /** Give slug-less recipes the derived default, once, at boot (E1), and
   *  reconcile any recipe still holding a prior rule's machine-generated
   *  default (`wasOldDefault`) to the current one. Both derivers are passed IN
   *  so the db layer never learns how identity is made. */
  backfillRecipeAgents(
    derive: Parameters<typeof store.backfillRecipeAgents>[0],
    wasOldDefault?: Parameters<typeof store.backfillRecipeAgents>[1],
  ) {
    return store.backfillRecipeAgents(derive, wasOldDefault);
  },
  dedupeWorkgroupColors() {
    return store.dedupeWorkgroupColors();
  },
  setRecipeAgent(id: string, agent: string | null): void {
    store.setRecipeAgent(id, agent);
  },

  /* ---- SVG logo library (reusable named logos) ---- */
  listLogos(): LogoAsset[] {
    return store.listLogos();
  },
  createLogo(name: string, svg: string): LogoAsset {
    return store.createLogo(name, svg);
  },
  deleteLogo(id: number): void {
    store.deleteLogo(id);
  },
  markCleared(paneid: string, to: string, at: number): void {
    store.markCleared(paneid, to, at);
  },

  dismissCleared(paneid: string): void {
    store.dismissCleared(paneid);
  },

  /* Re-point a live pane at the transcript it is actually in — see store. */
  adoptSessionId(paneid: string, sessionId: string): void {
    store.adoptSessionId(paneid, sessionId);
  },
  renameLogo(id: number, name: string): LogoAsset | null {
    return store.renameLogo(id, name);
  },
  replaceLogoSvg(id: number, svg: string): LogoAsset | null {
    return store.replaceLogoSvg(id, svg);
  },
  revertLogo(id: number): LogoAsset | null {
    return store.revertLogo(id);
  },
  /** The art's own treatment, as one opaque JSON string (the caller validates
   *  and serialises; null clears it). See store for why it lives on the art. */
  setLogoStyle(id: number, style: string | null): LogoAsset | null {
    return store.setLogoStyle(id, style);
  },

  /* ---- icon-lab ratings (the human verdict the computed score approximates) ---- */
  listIconRatings(): IconRating[] {
    return store.listIconRatings();
  },
  setIconRating(r: Omit<IconRating, 'rated_at'>): void {
    store.setIconRating(r);
  },
  clearIconRating(setSlug: string, recipeId: string): void {
    store.clearIconRating(setSlug, recipeId);
  },

  /* ---- icon-lab race cache (derived artwork; losing it costs 2s, never a verdict) ---- */
  listIconRaces(): { set_slug: string; created_at: number; bytes: number }[] {
    return store.listIconRaces();
  },
  getIconRace(setSlug: string) {
    return store.getIconRace(setSlug);
  },
  putIconRace(setSlug: string, payload: string): void {
    store.putIconRace(setSlug, payload);
  },

  /* ---- rooms ---- (workrooms Phase 1, the design notes §1.5)
   * Every mutating verb takes {actor, commandText?}, runs ONE transaction in the
   * store (state change + history + verbatim command + Room fact), and returns
   * {result, entries}. The bus hears about it only after the commit. A refusal
   * throws RoomError {status, message, field} and writes nothing. */
  createRoom(input: Parameters<typeof store.createRoom>[0], opts: RoomActionOpts): RoomResult<Room> {
    return announce(store.createRoom(input, opts));
  },
  getRoom(id: string): Room | undefined {
    return store.getRoom(id);
  },
  /* ---- workgroups (Owner 2026-10-04): a main room + its workgroups = a family ---- */
  listWorkgroups(roomId: string): Room[] {
    return store.listWorkgroups(roomId);
  },
  listFamily(roomId: string): Room[] {
    return store.listFamily(roomId);
  },
  checkFamilyName(roomId: string, kind: 'alias' | 'handle', typed: unknown): { value: string; free: boolean; reason: string | null } {
    return store.checkFamilyName(roomId, kind, typed);
  },
  familyContext(roomId: string): store.FamilyContext {
    return store.familyContext(roomId);
  },
  moveSeat(roomId: string, seatId: string, toRoomId: string, opts: RoomActionOpts): RoomResult<RoomSeat> {
    return announce(store.moveSeat(roomId, seatId, toRoomId, opts));
  },
  xpostView(entry: RoomLineEntry, viewRoomId: string): store.XpostView | null {
    return store.xpostView(entry, viewRoomId);
  },
  xpostViews(entries: RoomLineEntry[], viewRoomId: string): Map<number, store.XpostView> {
    return store.xpostViews(entries, viewRoomId);
  },
  /** Each room's newest chat/voice line (store.lastLines) [room last]. */
  lastLines(max?: number): Map<string, { author: string; text: string; ts: number }> {
    return store.lastLines(max);
  },
  unreadByRoom(userKey: string): Record<string, number> {
    return store.unreadByRoom(userKey);
  },
  unreadCounts(userKey: string): { unread: Record<string, number>; toMe: Record<string, number> } {
    return store.unreadCounts(userKey);
  },
  unreadDetail(userKey: string): store.RoomUnread[] {
    return store.unreadDetail(userKey);
  },
  markRoomSeen(userKey: string, roomId: string, lineId: unknown): number {
    return store.markRoomSeen(userKey, roomId, lineId);
  },
  /** F4: bind the room to its fabric thread, once (NULL -> id). No fact. */
  setRoomThread(id: string, thread: string): Room | undefined {
    return store.setRoomThread(id, thread);
  },
  /** Room round 3: colour + default feed. A view preference: no fact; a
   *  change announces room.state so every open window repaints. */
  setRoomSettings(id: string, patch: store.RoomSettingsPatch): RoomResult<Room> {
    return announce(store.setRoomSettings(id, patch));
  },
  /** Room authorship v2: a person's own picture, per user, never per room. */
  getUserPicture(userKey: string): string | null {
    return store.getUserPicture(userKey);
  },
  setUserPicture(userKey: string, picture: unknown): string | null {
    return store.setUserPicture(userKey, picture);
  },
  /** Hidden rooms (CLI Manager): per user, a view preference only. */
  getHiddenRooms(userKey: string): string[] {
    return store.getHiddenRooms(userKey);
  },
  checkHiddenRooms(ids: unknown): string[] {
    return store.checkHiddenRooms(ids);
  },
  setHiddenRooms(userKey: string, ids: unknown): string[] {
    return store.setHiddenRooms(userKey, ids);
  },
  /** Your @name: per user, every room (null stored = the default). */
  getUserHandle(userKey: string): string | null {
    return store.getUserHandle(userKey);
  },
  defaultUserHandle(name: string | null | undefined): string {
    return store.defaultUserHandle(name);
  },
  checkUserHandle(raw: unknown): string | null {
    return store.checkUserHandle(raw);
  },
  setUserHandle(userKey: string, raw: unknown): string | null {
    return store.setUserHandle(userKey, raw);
  },
  /** Bubble display [rooms/bubbles]: per user, every room. */
  getBubbleDisplay(userKey: string): store.BubbleDisplay {
    return store.getBubbleDisplay(userKey);
  },
  checkBubbleValue(field: 'bubbleTransparency' | 'bubbleBlur', raw: unknown): number {
    return store.checkBubbleValue(field, raw);
  },
  setBubbleDisplay(userKey: string, patch: { bubbleTransparency?: unknown; bubbleBlur?: unknown }): store.BubbleDisplay {
    return store.setBubbleDisplay(userKey, patch);
  },
  /** System-wide engine settings (idle rest, 2026-10-04): one JSON value per key. */
  getEngineSetting(key: string): unknown {
    return store.getEngineSetting(key);
  },
  setEngineSetting(key: string, value: unknown): void {
    store.setEngineSetting(key, value);
  },
  /** [basic] New site: the room <-> {slug, id, name, dir} lock (store.ts sites). */
  getSiteByRoom(roomId: string): store.SiteRow | undefined {
    return store.getSiteByRoom(roomId);
  },
  getSiteBySlug(slug: string): store.SiteRow | undefined {
    return store.getSiteBySlug(slug);
  },
  siteIdUsed(siteId: string): boolean {
    return store.siteIdUsed(siteId);
  },
  insertSite(r: Parameters<typeof store.insertSite>[0]): store.SiteRow {
    return store.insertSite(r);
  },
  retireSite(siteId: string): void {
    store.retireSite(siteId);
  },
  deleteSite(siteId: string): void {
    store.deleteSite(siteId);
  },
  /** Enter submits (Owner 2026-10-04): per user, every room; null = unset. */
  getEnterSubmits(userKey: string): boolean | null {
    return store.getEnterSubmits(userKey);
  },
  checkEnterSubmits(raw: unknown): boolean {
    return store.checkEnterSubmits(raw);
  },
  setEnterSubmits(userKey: string, raw: unknown): boolean {
    return store.setEnterSubmits(userKey, raw);
  },
  /** Global color palette + app title-bar tones (hub V2, Owner 2026-10-05): per user. */
  getUserPalette(userKey: string): ReturnType<typeof store.getUserPalette> {
    return store.getUserPalette(userKey);
  },
  checkUserPalette(userKey: string, raw: unknown): ReturnType<typeof store.checkUserPalette> {
    return store.checkUserPalette(userKey, raw);
  },
  setUserPalette(userKey: string, raw: unknown): ReturnType<typeof store.setUserPalette> {
    return store.setUserPalette(userKey, raw);
  },
  getUserColor(userKey: string): ReturnType<typeof store.getUserColor> {
    return store.getUserColor(userKey);
  },
  checkUserColor(raw: unknown): ReturnType<typeof store.checkUserColor> {
    return store.checkUserColor(raw);
  },
  setUserColor(userKey: string, raw: unknown): ReturnType<typeof store.setUserColor> {
    return store.setUserColor(userKey, raw);
  },
  getUserTones(userKey: string): ReturnType<typeof store.getUserTones> {
    return store.getUserTones(userKey);
  },
  seatOfPane(paneid: string): ReturnType<typeof store.seatOfPane> {
    return store.seatOfPane(paneid);
  },
  getUserRoomColors(userKey: string): ReturnType<typeof store.getUserRoomColors> {
    return store.getUserRoomColors(userKey);
  },
  checkUserRoomColors(raw: unknown): ReturnType<typeof store.checkUserRoomColors> {
    return store.checkUserRoomColors(raw);
  },
  setUserRoomColors(userKey: string, raw: unknown): ReturnType<typeof store.setUserRoomColors> {
    return store.setUserRoomColors(userKey, raw);
  },
  checkUserTones(raw: unknown): ReturnType<typeof store.checkUserTones> {
    return store.checkUserTones(raw);
  },
  setUserTones(userKey: string, raw: unknown): ReturnType<typeof store.setUserTones> {
    return store.setUserTones(userKey, raw);
  },
  /** Line wash, Spot | Edge [hub-v2]: per user, per mode. */
  getWash(userKey: string): store.WashPrefs {
    return store.getWash(userKey);
  },
  checkWash(raw: unknown): store.WashPrefs | null {
    return store.checkWash(raw);
  },
  setWash(userKey: string, patch: store.WashPrefs | null, raw: unknown): store.WashPrefs {
    return store.setWash(userKey, patch, raw);
  },
  /** Voice globals (room-voice§10.1, v3.6): per user, every room. */
  getUserVoice(userKey: string): ReturnType<typeof store.getUserVoice> {
    return store.getUserVoice(userKey);
  },
  checkUserVoice(raw: unknown): ReturnType<typeof store.checkUserVoice> {
    return store.checkUserVoice(raw);
  },
  /** A change is announced as room.state on every open room: each view
   *  carries the viewer's `voiceGlobal` and its connection's effective toggles. */
  setUserVoice(userKey: string, raw: unknown): ReturnType<typeof store.setUserVoice> {
    const out = store.setUserVoice(userKey, raw);
    if (out.changed) {
      for (const r of store.listRooms({ state: 'open' })) {
        roomBus.emit(r.id, { type: 'room.state' });
      }
    }
    return out;
  },
  migrateVoiceGlobals(ownerKey: string): ReturnType<typeof store.migrateVoiceGlobals> {
    return store.migrateVoiceGlobals(ownerKey);
  },
  /** Room drafts: a person's unsent composer text, per user per room. */
  getRoomDraft(userKey: string, roomId: string): store.RoomDraft {
    return store.getRoomDraft(userKey, roomId);
  },
  setRoomDraft(userKey: string, roomId: string, text: unknown, replyTo?: number | null): store.RoomDraft {
    return store.setRoomDraft(userKey, roomId, text, replyTo);
  },
  setRoomScratchNote(id: string, note: string): void {
    store.setRoomScratchNote(id, note);
  },
  setRoomScratchSize(id: string, size: number): void {
    store.setRoomScratchSize(id, size);
  },
  /* ---- room notes [ticket] ---- */
  exportLines(roomId: string, fromTs: number, toTs: number): store.RoomLineEntry[] {
    return store.exportLines(roomId, fromTs, toTs);
  },
  firstLineTs(roomId: string): number | null {
    return store.firstLineTs(roomId);
  },
  /** One observer of note saves and removals (the local-mode note copies). Never throws into a write. */
  setNoteObserver(fn: ((e: { kind: 'save' | 'remove'; roomId: string; id: string }) => void) | null): void {
    noteObserver = fn;
  },
  createRoomNote(roomId: string, createdBy: string | null, text?: unknown, now?: number): store.RoomNote {
    const n = store.createRoomNote(roomId, createdBy, text, now);
    notify({ kind: 'save', roomId, id: n.id });
    return n;
  },
  getRoomNote(roomId: string, id: string): store.RoomNote | undefined {
    return store.getRoomNote(roomId, id);
  },
  setRoomNoteText(roomId: string, id: string, text: unknown, now?: number): store.RoomNote | undefined {
    const n = store.setRoomNoteText(roomId, id, text, now);
    if (n) {
      notify({ kind: 'save', roomId, id });
    }
    return n;
  },
  setRoomNoteFlag(roomId: string, id: string, flag: 'pinned' | 'archived', on: boolean): store.RoomNote | undefined {
    return store.setRoomNoteFlag(roomId, id, flag, on);
  },
  listRoomNotesVisible(roomId: string, now?: number): store.RoomNote[] {
    return store.listRoomNotesVisible(roomId, now);
  },
  searchRoomNotes(roomId: string, q: string): ReturnType<typeof store.searchRoomNotes> {
    return store.searchRoomNotes(roomId, q);
  },
  indexRoomNote(id: string, ranker: store.NoteRanker, now?: number): store.RoomNote | undefined {
    return store.indexRoomNote(id, ranker, now);
  },
  fillRoomNoteTerms(id: string, termsOf: (text: string) => string[]): void {
    store.fillRoomNoteTerms(id, termsOf);
  },
  rerankRoomNote(id: string, ranker: store.NoteRanker): void {
    store.rerankRoomNote(id, ranker);
  },
  allRoomNoteIds(): string[] {
    return store.allRoomNoteIds();
  },
  createSentNote(roomId: string, input: Parameters<typeof store.createSentNote>[1], now?: number): store.SentNote {
    return store.createSentNote(roomId, input, now);
  },
  getSentNote(roomId: string, id: string): store.SentNote | undefined {
    return store.getSentNote(roomId, id);
  },
  claimSeatWelcome(seatId: string, paneid: string, roomId: string): boolean {
    return store.claimSeatWelcome(seatId, paneid, roomId);
  },
  releaseSeatWelcome(seatId: string, paneid: string, roomId: string): void {
    store.releaseSeatWelcome(seatId, paneid, roomId);
  },
  claimChatNote(paneid: string): boolean {
    return store.claimChatNote(paneid);
  },
  releaseChatNote(paneid: string): void {
    store.releaseChatNote(paneid);
  },
  setSentNoteEntry(id: string, entryId: number): void {
    store.setSentNoteEntry(id, entryId);
  },
  removeSentNote(id: string): void {
    store.removeSentNote(id);
  },
  removeRoomNote(id: string): void {
    const roomId = store.roomIdOfNote(id);
    store.removeRoomNote(id);
    if (roomId) {
      notify({ kind: 'remove', roomId, id });
    }
  },
  emptyRoomNoteIds(before: number): string[] {
    return store.emptyRoomNoteIds(before);
  },
  dirtyRoomNoteIds(idleBefore: number): string[] {
    return store.dirtyRoomNoteIds(idleBefore);
  },
  /* ---- the attachment scratchpad [ticket]: private per person per room ---- */
  setRoomScratchOrder(userKey: string, roomId: string, ids: string[]): string[] {
    return store.setRoomScratchOrder(userKey, roomId, ids);
  },
  listRoomScratch(userKey: string, roomId: string): store.RoomScratchFile[] {
    return store.listRoomScratch(userKey, roomId);
  },
  getRoomScratch(userKey: string, roomId: string, id: string): store.RoomScratchFile | undefined {
    return store.getRoomScratch(userKey, roomId, id);
  },
  addRoomScratch(input: Parameters<typeof store.addRoomScratch>[0], maxCount: number): store.RoomScratchFile {
    return store.addRoomScratch(input, maxCount);
  },
  getRoomScratchByUploadKey(userKey: string, roomId: string, uploadKey: string): store.RoomScratchFile | undefined {
    return store.getRoomScratchByUploadKey(userKey, roomId, uploadKey);
  },
  countRoomScratch(userKey: string, roomId: string): number {
    return store.countRoomScratch(userKey, roomId);
  },
  setRoomScratchMoved(id: string, path: string): void {
    store.setRoomScratchMoved(id, path);
  },
  deleteRoomScratch(id: string): boolean {
    return store.deleteRoomScratch(id);
  },
  abandonedRoomScratch(cutoff: number): store.RoomScratchFile[] {
    return store.abandonedRoomScratch(cutoff);
  },
  roomScratchIds(): Set<string> {
    return store.roomScratchIds();
  },
  listRooms(q: { state?: RoomState } = {}): Room[] {
    return store.listRooms(q);
  },
  updateRoom(id: string, patch: Parameters<typeof store.updateRoom>[1], opts: RoomActionOpts): RoomResult<Room> {
    return announce(store.updateRoom(id, patch, opts));
  },
  dissolveWorkgroup(id: string, opts: RoomActionOpts) {
    return announce(store.dissolveWorkgroup(id, opts));
  },
  archiveRoom(id: string, opts: RoomActionOpts): RoomResult<Room> {
    return announce(store.archiveRoom(id, opts));
  },
  setRoomBrief(id: string, brief: string | null, opts: RoomActionOpts): RoomResult<Room> {
    return announce(store.setRoomBrief(id, brief, opts)); // [room brief] Owner 2026-10-05
  },
  setRoomCodeFolder(id: string, input: Parameters<typeof store.setRoomCodeFolder>[1], opts: RoomActionOpts): RoomResult<Room> {
    return announce(store.setRoomCodeFolder(id, input, opts));
  },
  familyCodeFolder: (roomId: string) => store.familyCodeFolder(roomId),
  reopenRoom(id: string, opts: RoomActionOpts): RoomResult<Room> {
    return announce(store.reopenRoom(id, opts));
  },
  addSeat(roomId: string, input: Parameters<typeof store.addSeat>[1], opts: RoomActionOpts): RoomResult<RoomSeat> {
    return announce(store.addSeat(roomId, input, opts));
  },
  updateSeat(
    roomId: string,
    seatId: string,
    patch: Parameters<typeof store.updateSeat>[2],
    opts: RoomActionOpts,
  ): RoomResult<RoomSeat> {
    return announce(store.updateSeat(roomId, seatId, patch, opts));
  },
  removeSeat(roomId: string, seatId: string, opts: Parameters<typeof store.removeSeat>[2]): RoomResult<RoomSeat> {
    const out = announce(store.removeSeat(roomId, seatId, opts));
    /* a seat that leaves releases its tasks (tasks-store releaseSeatTasks): every window of the family re-reads them */
    for (const id of store.familyRoomIds(roomId)) {
      roomBus.emit(id, { type: 'room.tasks' });
    }
    return out;
  },
  setOccupant(
    roomId: string,
    seatId: string,
    occupant: OccupantInput,
    opts: Parameters<typeof store.setOccupant>[3],
  ): RoomResult<RoomSeat> {
    return announce(store.setOccupant(roomId, seatId, occupant, opts));
  },
  startSeat(roomId: string, seatId: string, paneid: string, opts: Parameters<typeof store.startSeat>[3]): RoomResult<RoomSeat> {
    return announce(store.startSeat(roomId, seatId, paneid, opts));
  },
  /**
   * Several room verbs as ONE store transaction (assemble, §4.2). `fn` gets
   * the verbs un-announced; reads inside it (getRoom, listSeats, …) see the
   * batch's own uncommitted writes. Only a batch that COMMITS is announced on
   * the bus, in order. `throw new Rollback(value)` inside `fn` rolls it all
   * back and returns `{value, committed: false}`; any other throw propagates
   * with nothing written and nothing announced.
   */
  roomBatch<T>(fn: (tx: RoomTx) => T): { value: T; committed: boolean } {
    const done: RoomAction<unknown>[] = [];
    const run = <R>(a: RoomAction<R>): RoomResult<R> => {
      done.push(a as RoomAction<unknown>);
      return { result: a.result, entries: a.entries };
    };
    const tx: RoomTx = {
      createRoom: (input, opts) => run(store.createRoom(input, opts)),
      updateRoom: (id, patch, opts) => run(store.updateRoom(id, patch, opts)),
      addSeat: (roomId, input, opts) => run(store.addSeat(roomId, input, opts)),
      moveSeat: (roomId, seatId, toRoomId, opts) => run(store.moveSeat(roomId, seatId, toRoomId, opts)),
      setRoomSettings: (id, patch) => run(store.setRoomSettings(id, patch)),
      setRoomBrief: (id, brief, opts) => run(store.setRoomBrief(id, brief, opts)),
      removeSeat: (roomId, seatId, opts) => run(store.removeSeat(roomId, seatId, opts)),
    };
    let value: T;
    try {
      value = store.roomBatch(() => fn(tx));
    } catch (e) {
      if (e instanceof Rollback) {
        return { value: e.value as T, committed: false };
      }
      throw e;
    }
    for (const a of done) {
      announce(a);
    }
    return { value, committed: true };
  },
  listSeats(roomId: string, q: { includeLeft?: boolean } = {}): RoomSeat[] {
    return store.listSeats(roomId, q);
  },
  /** Tasks: the verbs take the db (tasks-store.ts); this runs them inside ONE transaction. */
  withRoomDb: <T>(fn: (d: import('better-sqlite3').Database) => T): T => store.withRoomDb(fn),
  getStarterSeed: (template: string) => store.getStarterSeed(template),
  recordStarterSeed: (...a: Parameters<typeof store.recordStarterSeed>) => store.recordStarterSeed(...a),
  starterRecipeOwned: (id: string) => store.starterRecipeOwned(id),
  markStarterRecipe: (id: string) => store.markStarterRecipe(id),
  getSeat(seatId: string): RoomSeat | undefined {
    return store.getSeat(seatId);
  },
  listSeatHistory(seatId: string): SeatHistoryRow[] {
    return store.listSeatHistory(seatId);
  },
  appendLine(roomId: string, input: LineInput | LineInput[], opts: RoomActionOpts): RoomResult<RoomLineEntry[]> {
    return announce(store.appendLine(roomId, input, opts));
  },
  /** Concierge proxy line (concierge.md P2): author `concierge`, meta.proxy 'user'. Engine-internal. */
  appendProxyLine(roomId: string, input: Parameters<typeof store.appendProxyLine>[1]): RoomResult<RoomLineEntry[]> {
    return announce(store.appendProxyLine(roomId, input));
  },
  /** Room voice (room-voice §15): the ONLY writer of a `voice` line. Engine-
   *  internal — never wired to a caller's line POST, never parsed. */
  appendVoiceLine(roomId: string, input: Parameters<typeof store.appendVoiceLine>[1]): RoomResult<RoomLineEntry[]> {
    return announce(store.appendVoiceLine(roomId, input));
  },
  /* ---- room voice connections + ledger (room-voice §4, §10.3) [ticket]:
   * the policy is engine/room-voice.ts; announced like every room verb. ---- */
  voiceConnection(roomId: string): VoiceConnection | undefined {
    return store.getVoiceConnection(roomId);
  },
  listVoiceConnections(): VoiceConnection[] {
    return store.listVoiceConnections();
  },
  voiceRoomIds(): string[] {
    return store.voiceRoomIds();
  },
  connectVoice(roomId: string, device: string, panelUrl: string | null, userKey: string | null = null): RoomResult<VoiceConnection> {
    return announce(store.connectVoice(roomId, device, panelUrl, userKey));
  },
  disconnectVoice(roomId: string, reason: string): RoomResult<VoiceConnection | null> {
    return announce(store.disconnectVoice(roomId, reason));
  },
  setVoiceConnection(roomId: string, patch: Parameters<typeof store.setVoiceConnection>[1]): RoomResult<VoiceConnection | null> {
    return announce(store.setVoiceConnection(roomId, patch));
  },
  reconcileVoicePanel(roomId: string, panelUrl: string | null): RoomResult<boolean> {
    return announce(store.reconcileVoicePanel(roomId, panelUrl));
  },
  recordVoiceEvent(row: Parameters<typeof store.recordVoiceEvent>[0]): void {
    store.recordVoiceEvent(row);
  },
  listVoiceEvents(roomId: string, q: { open?: boolean } = {}): VoiceEventRow[] {
    return store.listVoiceEvents(roomId, q);
  },
  searchLine(roomId: string, q: string, limit: number): RoomLineEntry[] {
    return store.searchLine(roomId, q, limit);
  },
  lastLineBySeat(roomId: string): Record<string, number> {
    return store.lastLineBySeat(roomId);
  },
  /* E1c [ticket]: a seat's spoken reply is WRITTEN before the voice service is asked (its
   * vid is the replyId) and ANNOUNCED once, with its outcome, afterwards. */
  startVoiceLine(roomId: string, input: Parameters<typeof store.appendVoiceLine>[1]): RoomLineEntry {
    return store.appendVoiceLine(roomId, input).result[0];
  },
  finishVoiceLine(lineId: number, meta: Record<string, unknown>): RoomLineEntry | undefined {
    const entry = store.patchVoiceLineMeta(lineId, meta);
    if (entry) {
      roomBus.emit(entry.room_id, { type: 'room.line', entry });
    }
    return entry;
  },
  getVoiceEvent(vid: string): VoiceEventRow | undefined {
    return store.getVoiceEvent(vid);
  },
  lastVoiceEventForSeats(seatIds: string[]): VoiceEventRow | undefined {
    return store.lastVoiceEventForSeats(seatIds);
  },
  markVoiceReply(...a: Parameters<typeof store.markVoiceReply>): string[] {
    return store.markVoiceReply(...a);
  },
  voiceEventsDueNotice(roomId: string, since: number, dueBy: number): VoiceEventRow[] {
    return store.voiceEventsDueNotice(roomId, since, dueBy);
  },
  markVoiceNotice(vid: string, outcome: string, claim = false): boolean {
    return store.markVoiceNotice(vid, outcome, claim);
  },
  textReplyTimes(roomId: string, since: number): { ts: number; reply_ts: number | null }[] {
    return store.textReplyTimes(roomId, since);
  },
  listLine(roomId: string, q: Parameters<typeof store.listLine>[1] = {}): RoomLineEntry[] {
    return store.listLine(roomId, q);
  },
  listLineWhere(roomId: string, q: Parameters<typeof store.listLineWhere>[1], keep: (e: RoomLineEntry) => boolean): RoomLineEntry[] {
    return store.listLineWhere(roomId, q, keep);
  },

  getLineEntry(id: number): RoomLineEntry | undefined {
    return store.getLineEntry(id);
  },
  userLinesSinceSeat(roomId: string, seatId: string, since: number, limit?: number): Array<RoomLineEntry & { xhandles: string | null }> {
    return store.userLinesSinceSeat(roomId, seatId, since, limit);
  },
  lineCounts(roomId: string): Record<LineKind, number> {
    return store.lineCounts(roomId);
  },
  /** [ticket] the ts of the newest tool line `slug` posted for `seatId` here, or null. */
  lastToolLineFor(roomId: string, slug: string, seatId: string): number | null {
    return store.lastToolLineFor(roomId, slug, seatId);
  },
  seatByHandle(roomId: string, handle: string, q: { includeLeft?: boolean } = {}): RoomSeat | undefined {
    return store.seatByHandle(roomId, handle, q);
  },
  /** Which rooms hold this paneid (roster and placement). */
  roomsForPane(paneid: string, q: { includeLeft?: boolean } = {}): Array<{ room: Room; seat: RoomSeat }> {
    return store.roomsForPane(paneid, q);
  },
  /** Active seats filled from this recipe (the recipe-DELETE 409, §1.7). */
  activeSeatsForRecipe(recipeId: string): RoomSeat[] {
    return store.activeSeatsForRecipe(recipeId);
  },
  /* ---- room panels (tool-residents §2.6) [ticket]: announced like every
   * room verb — room.state after commit, room.line for the fact. ---- */
  /** The family head of a room (its parent, else itself): apps and their
   *  panels belong to the head, a workgroup shows them [family apps]. */
  familyRoomIds(roomId: string): string[] {
    return store.familyRoomIds(roomId);
  },
  familyHeadId(roomId: string): string {
    return store.familyHeadId(roomId);
  },
  listPanels(roomId: string): RoomPanel[] {
    return store.listPanels(roomId);
  },
  getPanel(id: string): RoomPanel | undefined {
    return store.getPanel(id);
  },
  addPanel(roomId: string, input: PanelInput, opts: RoomActionOpts): RoomResult<RoomPanel> {
    return announce(store.addPanel(roomId, input, opts));
  },
  updatePanel(roomId: string, panelId: string, patch: { title?: unknown; order?: unknown }, opts: RoomActionOpts): RoomResult<RoomPanel> {
    return announce(store.updatePanel(roomId, panelId, patch, opts));
  },
  removePanel(roomId: string, panelId: string, opts: RoomActionOpts): RoomResult<RoomPanel> {
    return announce(store.removePanel(roomId, panelId, opts));
  },
  /* ---- pane chat [agent chat]: hook-delivered turns (codex-cli) ---- */
  appendPaneChat(paneid: string, role: 'user' | 'agent', text: string, ts?: number): number | null {
    return store.appendPaneChat(paneid, role, text, ts);
  },
  listPaneChat(paneid: string, o: { before?: number; after?: number; limit: number }): { rows: store.PaneChatRow[]; more: boolean; latest: number | null } {
    return store.listPaneChat(paneid, o);
  },
  /* ---- chatter [chatter]: the report's rows, its events, the quiet list ---- */
  chatterSource(since: number): ReturnType<typeof store.chatterSource> {
    return store.chatterSource(since);
  },
  recordChatterEvent(e: store.ChatterEventRow): void {
    store.recordChatterEvent(e);
  },
  countChatterEvents(kind: store.ChatterEventRow['kind'], from: string, slug: string, since: number): number {
    return store.countChatterEvents(kind, from, slug, since);
  },
  recentToPersonLines(roomId: string, since: number, notSeat: string): ReturnType<typeof store.recentToPersonLines> {
    return store.recentToPersonLines(roomId, since, notSeat);
  },
  chatterQuiet(): string[] {
    return store.chatterQuiet();
  },
  setChatterQuiet(slug: string, quiet: boolean): string[] {
    return store.setChatterQuiet(slug, quiet);
  },
  /* ---- room assets (ticket): the folder mapping + the engine's upload
   * records; the fact is announced like every room verb. ---- */
  roomAssetFolder(roomId: string): string {
    return store.roomAssetFolder(roomId);
  },
  /* concierge sign-offs: the record only */
  signoffInsert(r: Parameters<typeof store.signoffInsert>[0]): void {
    store.signoffInsert(r);
  },
  signoffGet(id: string): store.SignoffRow | undefined {
    return store.signoffGet(id);
  },
  signoffList(state: store.SignoffRow['state'] | null, limit: number): store.SignoffRow[] {
    return store.signoffList(state, limit);
  },
  signoffMove(...a: Parameters<typeof store.signoffMove>): boolean {
    return store.signoffMove(...a);
  },
  signoffExpire(now: number): number {
    return store.signoffExpire(now);
  },
  signoffCancel(verbs: string[] | null): number {
    return store.signoffCancel(verbs);
  },
  signoffPendingCount(): number {
    return store.signoffPendingCount();
  },
  signoffPrune(olderThan: number): number {
    return store.signoffPrune(olderThan);
  },
  assetById(assetId: string): ReturnType<typeof store.assetById> {
    return store.assetById(assetId);
  },
  listAllRoomNotes(roomId: string, includeArchived = false): ReturnType<typeof store.listAllRoomNotes> {
    return store.listAllRoomNotes(roomId, includeArchived);
  },
  recordAsset(
    roomId: string,
    input: { path: string; name: string; size: number; type: string; url: string; batchId?: string | null },
    opts: RoomActionOpts,
    quiet = false,
    lineId: number | null = null,
  ): RoomResult<RoomAssetRecord & { added_by_handle: string }> {
    return announce(store.recordAsset(roomId, input, opts, quiet, lineId));
  },
  /* ---- scratchpad seen-state [scratch seen] ---- */
  scratchBaseline(person: string, roomId: string): number {
    return store.scratchBaseline(person, roomId);
  },
  scratchSeen(person: string, roomId: string, kind: store.ScratchKind): Set<string> {
    return store.scratchSeen(person, roomId, kind);
  },
  markScratchSeen(person: string, roomId: string, kind: store.ScratchKind, ids: readonly string[]): number {
    return store.markScratchSeen(person, roomId, kind, ids);
  },
  moveAssetRecord(oldPath: string, to: { path: string; room_id: string; name: string }): void {
    store.moveAssetRecord(oldPath, to);
  },
  removeAssetRecord(path: string): void {
    store.removeAssetRecord(path);
  },
  scratchNoteItems(roomId: string): Array<{ id: string; created_at: number }> {
    return store.scratchNoteItems(roomId);
  },
  listAssetRecords(roomId: string): Array<RoomAssetRecord & { added_by_handle: string }> {
    return store.listAssetRecords(roomId);
  },

  /* ---- tool registry + room apps (the design notes §4.4, S4 engine
   * half) [rooms/apps-engine]: registration/approval are human bookkeeping,
   * no room to announce on; membership is a room verb, announced like panels. */
  registerTool(input: Parameters<typeof store.registerTool>[0]): ToolRegistryRow {
    return store.registerTool(input);
  },
  getToolManage(slug: string): store.ToolManageRow | undefined {
    return store.getToolManage(slug);
  },
  setToolIntent(slug: string, intent: 'up' | 'down', bootId: string, by: string, reason: string | null): void {
    store.setToolIntent(slug, intent, bootId, by, reason);
  },
  setToolScripts(slug: string, sha: string, by: string): void {
    store.setToolScripts(slug, sha, by);
  },
  getToolRegistry(slug: string): ToolRegistryRow | undefined {
    return store.getToolRegistry(slug);
  },
  listToolRegistry(): ToolRegistryRow[] {
    return store.listToolRegistry();
  },
  /** Hold an app whose pin no longer matches. When THIS call changed it (not
   *  a repeat), every open room holding the app gets its one notice line
   *  [ticket]. true = it was just held. */
  holdTool(slug: string): boolean {
    const changed = store.holdTool(slug);
    if (changed) {
      announceAppNotice(slug, 'held');
    }
    return changed;
  },
  approveTool(slug: string, tool_sha256: string, root_realpath: string, tool_json: string | null = null): ToolRegistryRow | undefined {
    const wasHeld = store.getToolRegistry(slug)?.held === true;
    const row = store.approveTool(slug, tool_sha256, root_realpath, tool_json);
    if (row && wasHeld) {
      announceAppNotice(slug, 'approved'); // its actions work again: say so where it lives
    } else {
      announceAppRooms(slug);
    }
    return row;
  },
  /** Post an app's capability notice in every open room holding it [ticket]
   *  (a fresh registration whose backfill adopted panels in some rooms). */
  appNotice(slug: string, notice: store.AppNotice): void {
    announceAppNotice(slug, notice);
  },
  /** A human unregisters an app [ticket]: its room_apps rows and data stay,
   *  its actions are blocked; the rooms get their one notice. true = changed. */
  unregisterTool(slug: string, by: string, supersededBy: string | null = null): boolean {
    const changed = store.unregisterTool(slug, by, supersededBy);
    if (changed) {
      announceAppNotice(slug, 'unregistered');
    }
    return changed;
  },
  /** Register an unregistered app again, on its old pin. A row that is still
   *  held is a NEW state for its rooms (not registered -> needs approval), so
   *  it gets the held notice. */
  reregisterTool(slug: string, hold = false): ToolRegistryRow | undefined {
    const row = store.reregisterTool(slug, hold);
    if (row) {
      announceAppNotice(slug, row.held ? 'registered-held' : 'registered');
    }
    return row;
  },
  listRoomApps(roomId: string): RoomAppRow[] {
    return store.listRoomApps(roomId);
  },
  roomsForApp(slug: string): Array<{ id: string; name: string }> {
    return store.roomsForApp(slug);
  },
  /** Add (or, given the same slug+room again, reconcile — idempotent: fills
   *  in any panel the app didn't have yet, e.g. it was down and is now
   *  running) an app's membership. */
  addRoomApp(roomId: string, slug: string, panels: AppPanelSpec[], opts: RoomActionOpts): RoomResult<RoomAppRow> {
    return announce(store.addRoomApp(roomId, slug, panels, opts));
  },
  removeRoomApp(roomId: string, slug: string, opts: RoomActionOpts): RoomResult<RoomAppRow> {
    return announce(store.removeRoomApp(roomId, slug, opts));
  },
  /** Reconcile's fill-only path: panels for an EXISTING membership, never a
   *  new one [rooms/apps-sec P1-d]. */
  fillRoomAppPanels(roomId: string, slug: string, panels: AppPanelSpec[]): RoomResult<{ panel_ids: string[] }> {
    return announce(store.fillRoomAppPanels(roomId, slug, panels));
  },
  appPanelsWouldExceedCap(roomId: string, urls: string[]): boolean {
    return store.appPanelsWouldExceedCap(roomId, urls);
  },
  /** Exclusivity re-check + move-out + add, one transaction; announced only
   *  if it committed [rooms/apps-sec]. */
  placeRoomApp(
    roomId: string,
    slug: string,
    panels: AppPanelSpec[],
    opts: { exclusive: boolean; from: string | null },
  ): { conflict: { id: string; name: string } | null; results: RoomResult<RoomAppRow>[] } {
    const out = store.placeRoomApp(roomId, slug, panels, opts);
    return { conflict: out.conflict, results: out.actions.map((a) => announce(a)) };
  },
  backfillAppPanels(slug: string, specFor: (url: string, roomId: string) => AppPanelSpec | null, registeredAt: number, addedBy?: string): string[] {
    const rooms = store.backfillAppPanels(slug, specFor, registeredAt, addedBy);
    for (const roomId of rooms) {
      roomBus.emit(roomId, { type: 'room.state' });
    }
    return rooms;
  },
};
