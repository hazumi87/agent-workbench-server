/**
 * Mapping-table store (Milestone 2) — the ONLY module that opens the SQLite file.
 *
 * Decision 5: SQLite on the VRPC beside the engine, vendor-agnostic key
 *   paneid -> server -> vendor -> agent -> session_id + state,
 * with `state` first-class: live | dehydrated | killed | corrupted.
 *
 * Seam C2: nothing outside this file opens the db by path. Everything reaches
 * the table through the endpoint (./endpoint.ts), so the table's LOCATION is a
 * config flip (HARBOR_WB_TABLE), not a rewrite — which is what defers the
 * multi-PC / table-on-server problem cheaply.
 */
import { likePattern, LIKE_ESCAPE } from '../engine/search-snippet.ts';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resumableVendors } from '../engine/vendors/index.ts';
import { normalizeSlug, isSlug, projectBasename } from '../engine/agent-slug.ts';
import { SEAT_POLICIES, RESERVED_HANDLES, type SeatPolicy } from '../engine/room-vocab.ts';
import { checkPanelUrl } from '../engine/panel-url.ts';
import { ensureTaskTables, releaseSeatTasks } from './tasks-store.ts';
import { isEffortFor } from '../engine/effort.ts';
import { isAutoApproveSetting, readSetting } from '../engine/auto-approve.ts';
import { parseVendorArgs, readStoredVendorArgs } from '../engine/vendor-args.ts';
import { parseVendorFlags, readStoredVendorFlags } from '../engine/vendor-flags.ts';
import { DEFAULT_PALETTE, PaletteError, validPalette, validTonesPatch, validRoomColorsPatch, ROOM_COLORS_MAX, type PalettePref, type TonePrefs, type RoomColorPrefs } from '../engine/palette-prefs.ts';
import { voiceDefaults, mergeVoice, validVoicePatch, layerOverrides, pickVoice, VOICE_GLOBAL_KEYS, VoiceSettingsError, type RoomVoiceOwn, type VoiceGlobals, type RoomVoiceOverrides } from '../engine/room-voice-settings.ts';
import { validArtKey, RoomArtError } from '../engine/room-art.ts';
import { pickRoomColor } from '../engine/room-color.ts';
import { instancePath } from '../engine/data-dir.ts';

const DB_PATH = process.env.HARBOR_WB_TABLE ?? instancePath('data', 'mapping.db');

export type SessionState = 'live' | 'dehydrated' | 'killed' | 'corrupted';

/**
 * Per-pane PRESENTATION preferences (the at-a-glance identity columns).
 * The engine STORES and SERVES these; the renderer PAINTS them — they never
 * touch a PTY (terminal bg/text/watermark are renderer chrome, not a node-pty
 * capability). `friendlyName` is also the handle `address` (name -> paneid)
 * resolves against. All nullable: a fresh pane has no prefs until the user sets
 * them. `color` is a token/hex the renderer maps to a theme; `watermark` is a
 * short label/asset id the renderer renders behind the surface.
 */
export interface SessionPrefs {
  friendlyName: string | null;
  color: string | null; // identity ACCENT (title-bar tint + stripe) — tells panes apart
  fg: string | null; // terminal default FOREGROUND (xterm theme.foreground)
  bg: string | null; // terminal BACKGROUND (xterm theme.background)
  watermark: string | null;
  project: string | null;
  fontSize: number | null; // terminal font size in px (xterm fontSize) — user matches their terminal
  logo: string | null; // ghosted CLI logo, JSON {svg,scale,mono,opacity} (the design system parity) — renderer parses
}

export interface SessionRow extends SessionPrefs {
  paneid: string;
  /** The label of whoever last held the keyboard, so an engine restart returns
   *  the session to them instead of to whoever reconnects fastest. */
  last_controller: string | null;
  /** The pty's exit code when the process ended ON ITS OWN; NULL while live,
   *  when never recorded, or when we killed it (a kill's code is ours, not the
   *  program's verdict). Cleared on respawn. */
  exit_code: number | null;
  /** How this session resumes BY NAME (`claude --resume "<name>"`), or null.
   *  A session fact, not a project one — see migratePrefColumns. */
  resume_name: string | null;
  /** The project (recipe) this session belongs to, or null for a pane that is
   *  not recipe-backed (a bare component pane). Read this instead of parsing
   *  the paneid — the paneid is a handle, not a description. */
  recipe_id: string | null;
  server: string;
  vendor: string;
  agent: string | null;
  session_id: string | null;
  state: SessionState;
  /** 1 = this session was OPEN when the engine died (stamped at boot
   *  reconcile) — as opposed to individually ended via ✕/close, which writes
   *  `killed` while the engine is alive and never gets the stamp. Cleared on
   *  the pane's next spawn or by an explicit dismiss. Drives the manager's
   *  Edge-style "restore interrupted sessions?" banner. */
  interrupted: number | null;
  /** When the stamp above was made — one value shared by every row of a single
   *  boot's sweep, so the manager can offer THE LATEST BATCH and date it.
   *  Null on a row stamped by an engine older than this column: unknown age,
   *  and the manager declines to offer what it cannot date. */
  interrupted_at: number | null;
  /** When the engine detected that this live pane's CLI was /clear'ed (a new
   *  conversation began in the same pane while the row still banks the old
   *  session_id), ms; null = not cleared / dismissed / reloaded. Owner 2026-10-03,
   *. */
  cleared_at?: number | null;
  /** The transcript uuid the detection saw (kept after a dismiss so the same
   *  /clear is not flagged again; a second /clear is a different uuid). */
  cleared_to?: string | null;
  /** When the USER deliberately disconnected this session (room Disconnect),
   *  ms; null otherwise. A dehydrated row carrying it is restored only by an
   *  explicit act (Restore / Start / a launch permit), never by a view that
   *  merely re-attaches (Owner 2026-10-01: disconnected agents came straight
   *  back). Cleared by the next spawn. */
  disconnected_at?: number | null;
  /** The fabric work slug / instance check-in last handed this pane — a hint
   *  for the next check-in, never a routing key (engine/fabric-checkin.ts). */
  fabric_slug?: string | null;
  fabric_instance?: string | null;
  /** When this pane's CURRENT process was spawned (ms) — stamped by the upsert
   *  a spawn writes (state 'live'), untouched by every other write. Null on a
   *  row that has not spawned since the column landed: unknown, never guessed
   *  from updated_at (which moves on every state change). Roster verbs,
   *  2026-09-25 — a room seat's `occupant.started_at`. */
  started_at?: number | null;
  /** The pty size the screen model last mirrored, and when (see setSize).
   *  Null = never known, or deliberately unknown (sizeless). */
  cols?: number | null;
  rows?: number | null;
  size_at?: number | null;
  /** Which PROCESS of this pane the row describes (briefing-table-mcp §3.2):
   *  +1 on every spawn and every dehydrated -> live restore, unchanged by an
   *  adoption after an engine restart (same process). A pane token is bound to
   *  (paneid, generation) because paneids are reused across relaunches. 0 on a
   *  row that has not spawned since the column landed. */
  generation?: number;
  /** The agent's {model, effort} PROFILE (Owner 2026-10-02): snapshotted when it
   *  is minted, then what every relaunch of this pane runs. null = no profile
   *  yet (a legacy row); '' = snapshotted as claude's own default. Named
   *  profile_* so the spread in /api/table never collides with the displayed
   *  `model`/`effort` (what the session last answered with). */
  profile_model?: string | null;
  profile_effort?: string | null;
  updated_at: number;
}

let db: Database.Database | null = null;

function open(): Database.Database {
  if (db) {
    return db;
  }
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      paneid     TEXT PRIMARY KEY,
      server     TEXT NOT NULL,
      vendor     TEXT NOT NULL,
      agent      TEXT,
      session_id TEXT,
      state      TEXT NOT NULL CHECK(state IN ('live','dehydrated','killed','corrupted')),
      updated_at INTEGER NOT NULL
    );
  `);
  migratePrefColumns(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      target           TEXT NOT NULL,
      projectDir       TEXT,
      runClaude        INTEGER NOT NULL DEFAULT 1,
      model            TEXT,
      resume           INTEGER NOT NULL DEFAULT 0,
      resumeName       TEXT,
      color            TEXT,
      fg               TEXT,
      bg               TEXT,
      watermark        TEXT,
      fontSize         INTEGER,
      logo             TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      last_launched_at INTEGER
    );
  `);
  migrateRecipeColumns(db);
  ensurePaneTokensTable(db);
  ensureSessionWorktreesTable(db);
  ensureTyperStateTable(db);
  ensureConnectorTables(db);
  ensureSwitchTable(db);
  normalizeCodexEfforts(db);
  return db;
}

/**
 * Codex efforts the current models refuse (Owner 2026-10-05; `codex debug models`: every listed
 * model takes low..max, none takes minimal/none, and ultra/persistent are not offered). Stored
 * values are mapped to the nearest supported level so a saved recipe or seat profile launches:
 * none|minimal -> low, ultra|persistent -> max. Idempotent; codex rows only.
 */
export function normalizeCodexEfforts(d: Database.Database): void {
  const map = `CASE WHEN {c} IN ('none','minimal') THEN 'low' WHEN {c} IN ('ultra','persistent') THEN 'max' ELSE {c} END`;
  const cols = (t: string) => new Set((d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));
  if (cols('recipes').has('effort') && cols('recipes').has('vendor')) {
    d.exec(`UPDATE recipes SET effort = ${map.replaceAll('{c}', 'effort')} WHERE vendor = 'codex-cli' AND effort IN ('none','minimal','ultra','persistent')`);
  }
  if (cols('sessions').has('profile_effort')) d.exec(`UPDATE sessions SET profile_effort = ${map.replaceAll('{c}', 'profile_effort')} WHERE vendor = 'codex-cli' AND profile_effort IN ('none','minimal','ultra','persistent')`);
}

/**
 * Additive migration: the M2 schema predates the presentation-preference
 * columns, so a db created before this version is missing them. SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so we read the existing columns and add only what's
 * missing. Idempotent — runs every open(), a no-op once the columns exist.
 */
function migratePrefColumns(database: Database.Database): void {
  const have = new Set(
    (database.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name),
  );
  const wanted = ['friendlyName', 'color', 'fg', 'bg', 'watermark', 'project', 'logo'];
  for (const col of wanted) {
    if (!have.has(col)) {
      database.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
    }
  }
  // fontSize is numeric (px), not text — added separately with INTEGER affinity.
  if (!have.has('fontSize')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN fontSize INTEGER`);
  }
  // interrupted: session-fact flag (see SessionRow), not a pref.
  if (!have.has('interrupted')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN interrupted INTEGER`);
  }
  /* WHEN the stamp was made. Without it a stamp is undateable, and an
     undateable stamp is what let the restore offer accumulate: eight engine
     restarts in a day stamped rows that were then killed by a broker rebind,
     nobody dismissed the banner, and the next morning the offer was a list of
     day-old dead sessions (Owner, 2026-09-17). One timestamp per boot batch —
     every row swept by one reconcile carries the same value, which is what
     makes "the latest batch" a thing the manager can ask for. */
  if (!have.has('interrupted_at')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN interrupted_at INTEGER`);
  }
  /* cleared_at / cleared_to — see SessionRow. Additive, no backfill. */
  if (!have.has('cleared_at')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN cleared_at INTEGER`);
  }
  if (!have.has('cleared_to')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN cleared_to TEXT`);
  }
  if (!have.has('disconnected_at')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN disconnected_at INTEGER`);
  }
  /* started_at — when the pane's current process spawned (see SessionRow).
     No backfill: nothing on disk records it, and updated_at is not it. */
  if (!have.has('started_at')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN started_at INTEGER`);
  }
  /* recipe_id — WHICH PROJECT this session belongs to, as data rather than as a
   * substring of the primary key.
   *
   * Until now the association was encoded in the paneid itself (`recipe:<id>`),
   * which is exactly what limits a project to ONE session: the paneid is the
   * primary key, so a second session has nowhere to live. Making the link an
   * ordinary column is the first half of decoupling them — the paneid can then
   * become an opaque handle and a project can hold N of them.
   *
   * NOT named `project`: that column already exists as a dormant pref channel
   * (a display label), and two things called project would be a trap. It
   * renames with the recipe->project reframe, together, deliberately.
   */
  if (!have.has('recipe_id')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN recipe_id TEXT`);
    // Backfill from the paneid prefix — every existing row IS its project's
    // first session, so the association is already there, just implicit.
    database.exec(
      `UPDATE sessions
          SET recipe_id = substr(paneid, length('recipe:') + 1)
        WHERE recipe_id IS NULL AND paneid LIKE 'recipe:%'`,
    );
  }
  /* resume_name — HOW THIS SESSION RESUMES, as a session fact.
   *
   * The recipe carries resume/resumeName, which is a SESSION choice recorded at
   * project level. That is the documented cause of example project banking
   * session_id NULL and vanishing from history — and it became a correctness
   * bug once a project could hold two sessions: `＋ New` on a named-resume
   * project re-ran `--resume "<same name>"`, i.e. a second process appending to
   * one transcript.
   *
   * NO BACKFILL, deliberately. The only row it would touch on this database is
   * Owner's LIVE example project session, which already has a session_id — stamping a
   * name onto it would assert something untrue about a running session, and the
   * source (recipes.resumeName) is mutable and unversioned, so a backfill
   * records TODAY's name against sessions that ran under an older one. Launch
   * writes it going forward; existing rows resolve exactly as they do now.
   */
  if (!have.has('resume_name')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN resume_name TEXT`);
  }
  /* last_controller — WHO WAS DRIVING, remembered across an engine restart.
   *
   * The control lease lives in memory, so a restart wipes it: every adopted
   * session comes back with no controller, and `reclaim` then grants to
   * whichever client reconnects FIRST. On 2026-08-31 that handed Owner's
   * Kiosk session to a VRPC window 383ms before his laptop reconnected,
   * while he was downstairs actively using it. Nothing stole it — the engine
   * had simply forgotten there was anything to steal.
   *
   * Storing the controller's LABEL (not a client id) is deliberate: the label
   * already exists, needs no client change, and separates the cases that
   * actually matter — a VRPC window from a laptop browser. Its limit is that
   * two tabs of the SAME browser on the same machine share a label, so either
   * may win. That is the one case where either answer is right. */
  if (!have.has('last_controller')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN last_controller TEXT`);
  }
  /* exit_code — the ended verdict (v21 chrome wears ok|fail on an ended tab).
     No backfill: rows that ended before this column existed have no known
     code, and `unknown` is the honest answer for them. */
  if (!have.has('exit_code')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN exit_code INTEGER`);
  }
  /* fabric_slug / fabric_instance — what the message fabric's /checkin last
     handed this pane (contract §1.3). A HINT ONLY: the live instance is held in
     memory (engine/fabric-checkin.ts) and this is what a restarted engine
     OFFERS as remembered_slug / instance_hint, so the pane reclaims the same
     work slug instead of becoming a stranger. Never read for routing. No
     backfill — a row that never checked in has nothing to remember. */
  if (!have.has('fabric_slug')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN fabric_slug TEXT`);
  }
  if (!have.has('fabric_instance')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN fabric_instance TEXT`);
  }
  /* cols / rows / size_at — the PTY's size as the screen model last mirrored
     it (the design notes §3.2). The engine never stored a size before:
     spawn is always 80x24 and a resize went straight through, so after a
     restart nothing knew how wide a pane's pty was, and a virtual screen at
     the wrong size is a wrong screen. Written only by setSize (never by
     upsert, whose ON CONFLICT leaves these alone — which is why a spawn writes
     its own 80x24 here, because paneids are reused across relaunches). A size
     stamped BEFORE the row's `started_at` belongs to an earlier process and is
     treated as no size at all. NULL cols/rows = sizeless on purpose. No
     backfill: nothing on disk records a size. */
  if (!have.has('cols')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN cols INTEGER`);
  }
  if (!have.has('rows')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN rows INTEGER`);
  }
  if (!have.has('size_at')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN size_at INTEGER`);
  }
  /* profile_model / profile_effort — see SessionRow. Additive, NULL for every
     existing row (= no profile yet: the first relaunch snapshots the recipe's
     current defaults, which is today's behavior). */
  if (!have.has('profile_model')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN profile_model TEXT`);
  }
  if (!have.has('profile_effort')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN profile_effort TEXT`);
  }
  /* generation — see SessionRow. Additive, 0 for every existing row: nothing
     on disk says how many times a pane has spawned, and a token minted after
     this lands is bound to the value its own spawn writes. */
  if (!have.has('generation')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`);
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_recipe ON sessions(recipe_id)`);
}

/** Additive migration for the recipes table (mirrors migratePrefColumns): a
 *  recipes table created before the font-size feature is missing that column. */
function migrateRecipeColumns(database: Database.Database): void {
  const have = new Set(
    (database.prepare(`PRAGMA table_info(recipes)`).all() as { name: string }[]).map((c) => c.name),
  );
  if (!have.has('fontSize')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN fontSize INTEGER`);
  }
  if (!have.has('logo')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN logo TEXT`);
  }
  // initCmd (2026-08-04, "Other CLIs"): a command line typed visibly into the
  // spawned shell for NON-claude recipes (e.g. an ssh + command bridge login).
  // Never credentials — interactive prompts happen in the pane.
  if (!have.has('initCmd')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN initCmd TEXT`);
  }
  /* closeOnCleanExit (2026-09-03): does a CLEAN exit end the session, or leave
   * a shell?
   *
   * The launcher appends `exec $SHELL -l` unconditionally, so quitting a tool
   * and the tool CRASHING look identical — both leave a live shell in a live
   * pane. For the command bridge that was actively misleading: press `q`, the
   * bridge is gone, the manager still says live. With this on, exit 0 closes
   * the pane and a non-zero code still keeps the shell, which is the whole
   * reason that after-exit shell exists (read the error, relaunch).
   *
   * Default OFF: turning it on globally would also close claude panes on
   * /exit, which is defensible but is a change to every pane's behaviour. */
  if (!have.has('closeOnCleanExit')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN closeOnCleanExit INTEGER NOT NULL DEFAULT 0`);
  }
  /* statusPath (2026-09-03): a file the TOOL publishes about itself, which the
   * manager renders verbatim. Data, not code — see src/engine/widget-status.ts
   * and the design notes. Keeping it here is what stops the engine
   * learning what any particular tool's state means. */
  if (!have.has('statusPath')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN statusPath TEXT`);
  }
  /* vendor (Stage 2, 2026-09-17): the session CLASS, promoted from the boolean
   * it was hiding inside. `runClaude` answered "does this start claude", which
   * is the same question as "which class is this" only while there are exactly
   * two classes and one of them is claude — i.e. only until vendor #2.
   *
   * Backfilled from runClaude in SQL because that mapping is total and needs no
   * judgement: 1 -> claude-code, 0 -> cli-manager. Both columns are written
   * from here on (vendor authoritative, runClaude mirrored) so rolling the
   * engine back does not lose a recipe's behaviour. */
  if (!have.has('vendor')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN vendor TEXT`);
    database.exec(
      `UPDATE recipes SET vendor = CASE WHEN runClaude = 1 THEN 'claude-code' ELSE 'cli-manager' END
        WHERE vendor IS NULL`,
    );
  }
  /* agent (E1): the relay slug. NO SQL BACKFILL — deriving `<basename>-cli`
   * needs path logic that belongs in one place (engine/agent-slug.ts) and must
   * behave identically for a Windows and a POSIX path, which SQLite string
   * functions cannot do without re-implementing the rule badly. The engine
   * fills existing rows once at boot (backfillRecipeAgents) instead. */
  if (!have.has('agent')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN agent TEXT`);
  }
  /* effort (2026-09-28): `claude --effort <level>`. Nullable, no backfill:
   * NULL is "Default", i.e. no flag at all, which is exactly what every
   * recipe written before this column did. */
  if (!have.has('effort')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN effort TEXT`);
  }
  /* vendorArgs (2026-10-03, Codex vendor): extra CLI arguments appended to the
   * vendor's invocation, a JSON array of strings (src/engine/vendor-args.ts).
   * Nullable, no backfill: NULL = none, which is what every recipe written
   * before this column did. */
  if (!have.has('vendorArgs')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN vendorArgs TEXT`);
  }
  /* vendorFlags (2026-10-09): ticked checkbox settings for the vendor's CLI, a JSON array of
   * flag ids (src/engine/vendor-flags.ts). Nullable, no backfill: NULL = none. */
  if (!have.has('vendorFlags')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN vendorFlags TEXT`);
  }
  /* worktree (Owner 2026-10-05, worktree convention, KB design-notes-id §12):
   * 'auto' (default) = a second same-project seat gets its own git worktree;
   * 'never' = a non-code seat opts out. Additive; every existing recipe is auto. */
  if (!have.has('worktree')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN worktree TEXT NOT NULL DEFAULT 'auto'`);
  }
  /* autoApprove (2026-10-26, security review H1): 'follow' | 'on' | 'off'. 'follow' = take the engine's first-run default (off until chosen). Additive; every existing recipe
   * is 'follow', so nothing changes for a recipe until a person chooses (src/engine/auto-approve.ts). */
  if (!have.has('autoApprove')) {
    database.exec(`ALTER TABLE recipes ADD COLUMN autoApprove TEXT NOT NULL DEFAULT 'follow'`);
  }
}

/**
 * Read-shape repair for one recipe row.
 *
 * `vendor` is the authority and `runClaude` is its mirror, so a row where they
 * ever diverge (an older engine wrote runClaude; a hand-edited db) is resolved
 * HERE, once, on the way out — not at each of the dozen places that read
 * `runClaude`. A row predating the column reads `null` and falls back to the
 * boolean, which is exactly what the backfill would have written.
 */
function hydrateRecipe<T extends { vendor?: string | null; runClaude?: number; vendorArgs?: unknown; vendorFlags?: unknown } | undefined>(r: T): T {
  if (!r) {
    return r;
  }
  const vendor: RecipeVendor = isRecipeVendor(r.vendor)
    ? r.vendor
    : r.runClaude
      ? 'claude-code'
      : 'cli-manager';
  // vendorArgs is stored as JSON text and served as the list it is.
  return { ...r, autoApprove: readSetting((r as { autoApprove?: unknown }).autoApprove), vendor, runClaude: vendor === 'claude-code' ? 1 : 0, vendorArgs: readStoredVendorArgs(r.vendorArgs), vendorFlags: readStoredVendorFlags(r.vendorFlags) };
}

/** Path the engine opened (for observability/logging only — not an access path). */
export function dbPath(): string {
  return DB_PATH;
}

/**
 * Insert or replace the SESSION-FACT columns for a pane (paneid is the key — one
 * session per pane). Deliberately does NOT touch the preference columns: a spawn
 * re-upserting the same paneid (e.g. after a kill+respawn into the same pane)
 * must preserve the friendlyName/color the user set. Prefs are written only via
 * setPrefs(). On first insert the pref columns default to NULL.
 */
export function upsert(
  row: Omit<
    SessionRow,
    | 'updated_at'
    | 'interrupted'
    | 'interrupted_at'
    | 'disconnected_at'
    | 'cleared_at'
    | 'cleared_to'
    | 'started_at'
    | 'recipe_id'
    | 'resume_name'
    | 'last_controller'
    | 'exit_code'
    | keyof SessionPrefs
    | 'generation'
    | 'profile_model'
    | 'profile_effort'
  >
    & { recipe_id?: string | null; resume_name?: string | null; generation?: number | null },
): void {
  // A spawn consumes the pane's `interrupted` stamp AND its date: the session
  // is back, so it is no longer a member of any interruption batch.
  open()
    .prepare(
      `INSERT INTO sessions (paneid, recipe_id, resume_name, server, vendor, agent, session_id, state, interrupted, interrupted_at, started_at, generation, updated_at)
       VALUES (@paneid, @recipe_id, @resume_name, @server, @vendor, @agent, @session_id, @state, 0, NULL,
               CASE WHEN @state='live' THEN @updated_at ELSE NULL END, COALESCE(@generation, 0), @updated_at)
       ON CONFLICT(paneid) DO UPDATE SET
         recipe_id=COALESCE(@recipe_id, recipe_id),
         generation=COALESCE(@generation, generation),
         resume_name=COALESCE(@resume_name, resume_name),
         server=@server, vendor=@vendor, agent=@agent,
         session_id=@session_id, state=@state, interrupted=0, interrupted_at=NULL, disconnected_at=NULL, exit_code=NULL,
         cleared_at=CASE WHEN @state='live' THEN NULL ELSE cleared_at END,
         cleared_to=CASE WHEN @state='live' THEN NULL ELSE cleared_to END,
         started_at=CASE WHEN @state='live' THEN @updated_at ELSE started_at END, updated_at=@updated_at`,
    )
    .run({ recipe_id: null, resume_name: null, generation: null, ...row, updated_at: Date.now() });
}

/** Store a pane's {model, effort} profile ('' / null = claude's own default).
 *  Callers validate; this only normalizes null to the '' "snapshotted" marker. */
export function setProfile(paneid: string, p: { model: string | null; effort: string | null }): void {
  open().prepare(`UPDATE sessions SET profile_model=?, profile_effort=? WHERE paneid=?`).run(p.model ?? '', p.effort ?? '', paneid);
}

/** ONE-OFF profile backfill (Owner 2026-10-03): the claude-code sessions that
 *  occupy a seat in an OPEN room, are live or dehydrated, and have NO profile
 *  yet (both columns NULL). Reads the room tables, so they are ensured first
 *  (they are created lazily). */
export function profileBackfillTargets(): Array<{ paneid: string; recipe_id: string | null; session_id: string | null }> {
  const d = open();
  ensureRoomTables(d);
  return d
    .prepare(
      `SELECT DISTINCT s.paneid, s.recipe_id, s.session_id FROM sessions s
         JOIN room_seats rs ON rs.occupant_kind='pane' AND rs.occupant=s.paneid AND rs.left_at IS NULL
         JOIN rooms r ON r.id = rs.room_id AND r.state='open'
        WHERE s.vendor='claude-code' AND s.state IN ('live','dehydrated')
          AND s.profile_model IS NULL AND s.profile_effort IS NULL`,
    )
    .all() as Array<{ paneid: string; recipe_id: string | null; session_id: string | null }>;
}

/** Write a profile ONLY while both columns are still NULL, in one statement, so
 *  a profile set by a launch or the PATCH route a moment ago is never
 *  overwritten. Returns whether it wrote. */
export function setProfileIfUnset(paneid: string, p: { model: string; effort: string }): boolean {
  return (
    open()
      .prepare(`UPDATE sessions SET profile_model=?, profile_effort=? WHERE paneid=? AND profile_model IS NULL AND profile_effort IS NULL`)
      .run(p.model, p.effort, paneid).changes > 0
  );
}

/** The row's profile for the wire: {model, effort} (null = default), or null
 *  when the row has none yet. */
export function profileOf(row: { profile_model?: string | null; profile_effort?: string | null } | undefined): { model: string | null; effort: string | null } | null {
  if (!row || row.profile_model == null || row.profile_effort == null) {
    return null;
  }
  return { model: row.profile_model || null, effort: row.profile_effort || null };
}

/** Stamp a deliberate user disconnect on a pane's row (see SessionRow.disconnected_at). */
export function markDisconnected(paneid: string): void {
  open().prepare(`UPDATE sessions SET disconnected_at=? WHERE paneid=?`).run(Date.now(), paneid);
}

/**
 * Every session belonging to a project, newest first.
 *
 * This is the accessor the manager needs once a project can hold more than one
 * session — `rowByPane.get('recipe:' + id)` answers "THE row for this recipe",
 * a question that only has an answer while the 1:1 holds. Reading the column
 * asks the right question instead, and returns the same single row today.
 */
export function sessionsForRecipe(recipeId: string): SessionRow[] {
  return open()
    .prepare(`SELECT * FROM sessions WHERE recipe_id = ? ORDER BY updated_at DESC`)
    .all(recipeId) as SessionRow[];
}

/** Record how a session's process ended (null = not a program verdict). */
export function setExitCode(paneid: string, code: number | null): void {
  open()
    .prepare(`UPDATE sessions SET exit_code=? WHERE paneid=?`)
    .run(code, paneid);
}

/** Remember the fabric identity check-in handed this pane (a restart's hint). */
export function setFabricIdentity(paneid: string, slug: string | null, instance: string | null): void {
  open()
    .prepare(`UPDATE sessions SET fabric_slug=?, fabric_instance=? WHERE paneid=?`)
    .run(slug, instance, paneid);
}

/** The pty size the screen model mirrored (null cols/rows = sizeless). Touches
 *  nothing else — not updated_at, which the manager reads as "last changed". */
export function setSize(paneid: string, cols: number | null, rows: number | null, at: number): void {
  open()
    .prepare(`UPDATE sessions SET cols=?, rows=?, size_at=? WHERE paneid=?`)
    .run(cols, rows, at, paneid);
}

/** Remember who is driving, so a restart can hand the session back to them. */
export function setLastController(paneid: string, label: string | null): void {
  open()
    .prepare(`UPDATE sessions SET last_controller=? WHERE paneid=?`)
    .run(label, paneid);
}

/** Transition a pane's session state (live -> killed/dehydrated/corrupted). */
export function setState(paneid: string, state: SessionState): void {
  open()
    .prepare(`UPDATE sessions SET state=?, updated_at=? WHERE paneid=?`)
    .run(state, Date.now(), paneid);
}

/**
 * Write presentation preferences for a pane. Partial: only the keys present in
 * `prefs` are written (COALESCE keeps the rest), so `setPrefs(id, {color})`
 * doesn't wipe a previously-set friendlyName. Upserts a bare row if the pane has
 * no session yet — a user can name/color a pane the instant it's created, before
 * any spawn fact exists. Returns the merged prefs as stored.
 */
export function setPrefs(paneid: string, prefs: Partial<SessionPrefs>): SessionPrefs {
  const existing = get(paneid);
  if (!existing) {
    // No session row yet — create a placeholder so prefs have somewhere to live.
    // server/vendor unknown until spawn; mark them so a later upsert overwrites.
    open()
      .prepare(
        `INSERT INTO sessions (paneid, recipe_id, server, vendor, agent, session_id, state, updated_at,
                               friendlyName, color, fg, bg, watermark, project, fontSize, logo)
         VALUES (@paneid, @recipe_id, '', '', NULL, NULL, 'killed', @updated_at,
                 @friendlyName, @color, @fg, @bg, @watermark, @project, @fontSize, @logo)`,
      )
      .run({
        paneid,
        /* A placeholder row still belongs to a project. Deriving it from the
           handle is safe HERE because this row has no spawn facts to read it
           from — and leaving it null produced orphan rows that no project could
           claim (seen live 2026-08-24 after a failed spawn: server='', vendor='',
           recipe_id=null). The `#` suffix is stripped so an additional session
           lands under the same project as the first. */
        recipe_id: paneid.startsWith('recipe:')
          ? paneid.slice('recipe:'.length).split('#')[0]
          : null,
        updated_at: Date.now(),
        friendlyName: prefs.friendlyName ?? null,
        color: prefs.color ?? null,
        fg: prefs.fg ?? null,
        bg: prefs.bg ?? null,
        watermark: prefs.watermark ?? null,
        project: prefs.project ?? null,
        fontSize: prefs.fontSize ?? null,
        logo: prefs.logo ?? null,
      });
  } else {
    open()
      .prepare(
        `UPDATE sessions SET
           friendlyName = COALESCE(@friendlyName, friendlyName),
           color        = COALESCE(@color, color),
           fg           = COALESCE(@fg, fg),
           bg           = COALESCE(@bg, bg),
           watermark    = COALESCE(@watermark, watermark),
           project      = COALESCE(@project, project),
           fontSize     = COALESCE(@fontSize, fontSize),
           logo         = COALESCE(@logo, logo),
           updated_at   = @updated_at
         WHERE paneid = @paneid`,
      )
      .run({
        paneid,
        updated_at: Date.now(),
        friendlyName: prefs.friendlyName ?? null,
        color: prefs.color ?? null,
        fg: prefs.fg ?? null,
        bg: prefs.bg ?? null,
        watermark: prefs.watermark ?? null,
        project: prefs.project ?? null,
        fontSize: prefs.fontSize ?? null,
        logo: prefs.logo ?? null,
      });
  }
  const row = get(paneid)!;
  return {
    friendlyName: row.friendlyName,
    color: row.color,
    fg: row.fg,
    bg: row.bg,
    watermark: row.watermark,
    project: row.project,
    fontSize: row.fontSize,
    logo: row.logo,
  };
}

/** Resolve a friendlyName to its paneid (the `address` lookup). Case-insensitive,
 *  most-recently-updated wins if names collide. Returns undefined if unknown. */
export function resolveName(friendlyName: string): string | undefined {
  const row = open()
    .prepare(
      `SELECT paneid FROM sessions
       WHERE friendlyName IS NOT NULL AND lower(friendlyName) = lower(?)
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(friendlyName) as { paneid: string } | undefined;
  return row?.paneid;
}

export function get(paneid: string): SessionRow | undefined {
  return open().prepare(`SELECT * FROM sessions WHERE paneid=?`).get(paneid) as
    | SessionRow
    | undefined;
}

export function list(): SessionRow[] {
  return open().prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`).all() as SessionRow[];
}

/* ============================================================================
 * RECIPES (CLI Manager phase, 2026-07-07 rescope) — saved launches.
 *
 * A recipe is what Owner calls a "session": a named, color-themed window with
 * its login characteristics (target/who, project folder, claude options). The
 * pane a recipe launches uses paneid `recipe:<id>`, so its table row (and the
 * prefs on it) is stable across relaunches. Same Seam-C2 rule: this file is
 * the only opener; everything reaches recipes through the endpoint.
 * ========================================================================== */

/* THE SESSION TAXONOMY, AS DATA (the design notes, Stage 2).
 *
 * `claude-code` = resumable, transcript-identified. `cli-manager` = a generic
 * shell/CLI whose only lifecycle fact is "the pty is alive". A third class
 * (script widget) is DEFINED and NOT BUILT; it is deliberately absent here, and
 * the rule for adding it is in the taxonomy doc: the class gets built when the
 * SECOND widget appears, not the first. Do not add a vendor to this list to
 * make one tool fit.
 *
 * A VALUE HERE IS A LABEL, NOT A PROMISE OF A MODULE (contract §1.1 step 2).
 * `gemini-cli` has one (`src/engine/vendors/gemini-cli.ts`); `codex-cli` and
 * `ollama` are accepted VALUES with no module yet, and a recipe carrying one
 * launches as a generic class-2 CLI from its own `initCmd`. That is deliberate:
 * the value buys a brand label, a slug and a colour today, and adding a module
 * later changes nothing about the rows already written.
 *
 * `cli-manager` stays the honest default for anything shell-shaped. Widening
 * this list is the FIRST of the three steps in contract §1.1 — the other two
 * (taxonomy class, and a §5 module + reconcile branch if it can resume) are not
 * optional once a value is here. */
export type RecipeVendor =
  | 'claude-code'
  | 'cli-manager'
  | 'gemini-cli'
  | 'codex-cli'
  | 'ollama';
export const RECIPE_VENDORS: RecipeVendor[] = [
  'claude-code',
  'cli-manager',
  'gemini-cli',
  'codex-cli',
  'ollama',
];

/* The effort vocabulary lives beside the other engine vocabularies; re-exported
   so the endpoint (and the server through it) reads it from one place. */
export { RECIPE_EFFORTS, isRecipeEffort, type RecipeEffort } from '../engine/effort.ts';

/** Is this an enum member? The ONE test every write path uses, so an unknown
 *  value is REFUSED at the edge (400) instead of silently becoming
 *  `claude-code` — which is what it did until 2026-09-17 and meant a typo in a
 *  vendor name spawned `claude` at you (contract §1.1, finding #1). */
export function isRecipeVendor(v: unknown): v is RecipeVendor {
  return typeof v === 'string' && (RECIPE_VENDORS as string[]).includes(v);
}

export interface Recipe {
  id: string;
  name: string;
  target: string; // Target.id from targets.json
  projectDir: string | null;
  /** WHICH CLASS of session this launches (Stage 2). AUTHORITATIVE; `runClaude`
   *  is derived from it on read and kept in sync on write so an older engine
   *  build reading the same file still behaves. */
  vendor: RecipeVendor;
  /** The stable logical identity of whatever runs here (contract §1, E1) —
   *  `<project>-<role>`, lowercase. Null only for a recipe with neither a
   *  project folder nor a usable name; see engine/agent-slug.ts. */
  agent: string | null;
  runClaude: number; // 0|1 (SQLite has no bool) — DERIVED from vendor, see hydrateRecipe
  model: string | null; // passed verbatim to `claude --model <value>`
  /** `claude --effort <value>` (one of RECIPE_EFFORTS); null = Default, no flag.
   *  Optional in the TYPE only so an object built before the column (a test
   *  fixture, an older caller) still reads as a recipe with no effort. */
  effort?: string | null;
  /** Extra arguments appended to the vendor's command line (Codex: sandbox,
   *  network, writable roots, approval policy). A list of strings; null = none.
   *  Optional in the TYPE only, like `effort`. See engine/vendor-args.ts. */
  vendorArgs?: string[] | null;
  /** Ticked checkbox settings for the vendor's CLI: flag ids (engine/vendor-flags.ts); null =
   *  none. Optional in the TYPE only, like `vendorArgs`. */
  vendorFlags?: string[] | null;
  /** 'auto' | 'never' - see migrateRecipeColumns. Optional in the TYPE so a
   *  caller that does not know the column leaves the stored value alone. */
  worktree?: 'auto' | 'never' | null;
  /** 'follow' | 'on' | 'off' (src/engine/auto-approve.ts). Optional in the TYPE so a caller that does not know it leaves the stored value alone; reads always carry it. */
  autoApprove?: 'follow' | 'on' | 'off' | null;
  resume: number; // 0|1
  resumeName: string | null; // named resume: `--resume "<name>"`; empty = picker
  initCmd: string | null; // Other-CLI init command, typed visibly into the shell (runClaude=0 only)
  closeOnCleanExit: number; // 0|1 — exit 0 ends the pane; non-zero still keeps a shell
  statusPath: string | null; // file the tool publishes {kind,text,ts} to; rendered verbatim
  color: string | null;
  fg: string | null;
  bg: string | null;
  watermark: string | null;
  fontSize: number | null; // terminal font size in px; null = renderer default
  logo: string | null; // ghosted CLI logo, JSON {svg,scale,mono,opacity}; null = none
  created_at: number;
  updated_at: number;
  last_launched_at: number | null;
}

/** Create or fully replace a recipe (the manager form always sends the whole
 *  thing). Keeps created_at / last_launched_at on update. */
export function upsertRecipe(
  r: Omit<Recipe, 'created_at' | 'updated_at' | 'last_launched_at' | 'vendor' | 'runClaude'>
    & { vendor?: RecipeVendor | string | null; runClaude?: number | boolean },
): Recipe {
  const now = Date.now();
  /* ONE AUTHORITY, WRITTEN TWICE. An old client (or an old row being re-saved)
     sends only `runClaude`; a Stage-2 client sends `vendor`. vendor wins when
     present, and the boolean is derived from it rather than trusted beside it,
     so the two can never disagree in the file. */
  const vendor: RecipeVendor = isRecipeVendor(r.vendor)
    ? r.vendor
    : r.runClaude
      ? 'claude-code'
      : 'cli-manager';
  open()
    .prepare(
      `INSERT INTO recipes (id, name, target, projectDir, vendor, agent, runClaude, model, effort, vendorArgs, vendorFlags, worktree, autoApprove, resume, resumeName, initCmd,
                            closeOnCleanExit, statusPath,
                            color, fg, bg, watermark, fontSize, logo, created_at, updated_at, last_launched_at)
       VALUES (@id, @name, @target, @projectDir, @vendor, @agent, @runClaude, @model, @effort, @vendorArgs, @vendorFlags, COALESCE(@worktree, 'auto'), COALESCE(@autoApprove, 'follow'), @resume, @resumeName, @initCmd,
               @closeOnCleanExit, @statusPath,
               @color, @fg, @bg, @watermark, @fontSize, @logo, @now, @now, NULL)
       ON CONFLICT(id) DO UPDATE SET
         name=@name, target=@target, projectDir=@projectDir, vendor=@vendor, agent=@agent, runClaude=@runClaude,
         model=@model, effort=@effort, vendorArgs=@vendorArgs, vendorFlags=@vendorFlags, worktree=COALESCE(@worktree, worktree), autoApprove=COALESCE(@autoApprove, autoApprove), resume=@resume, resumeName=@resumeName, initCmd=@initCmd,
         closeOnCleanExit=@closeOnCleanExit, statusPath=@statusPath,
         color=@color, fg=@fg, bg=@bg, watermark=@watermark, fontSize=@fontSize, logo=@logo, updated_at=@now`,
    )
    .run({
      ...r,
      vendor,
      runClaude: vendor === 'claude-code' ? 1 : 0,
      agent: r.agent ?? null,
      worktree: r.worktree === 'never' ? 'never' : r.worktree === 'auto' ? 'auto' : null,
      autoApprove: isAutoApproveSetting(r.autoApprove) ? r.autoApprove : null, // null = leave the stored value (an older caller)
      effort: isEffortFor(vendor, r.effort) ? r.effort : null,
      vendorArgs: (() => {
        const a = parseVendorArgs(r.vendorArgs);
        return a.ok && a.args ? JSON.stringify(a.args) : null;
      })(),
      vendorFlags: (() => {
        const f = parseVendorFlags(r.vendorFlags, vendor);
        return f.ok && f.flags ? JSON.stringify(f.flags) : null;
      })(),
      now,
    });
  return getRecipe(r.id)!;
}

/**
 * Give every recipe that has no slug the derived default, once, at boot.
 *
 * Idempotent and silent when there is nothing to do, exactly like
 * `normalizeStoredProjectDirs` and `backfillLogoKeys`. The engine passes the
 * deriver in rather than importing it: this file is the db layer and has no
 * business knowing how a project folder becomes an identity.
 *
 * NEVER OVERWRITES A HUMAN'S CHOICE. A slug the user typed by hand is the
 * identity other systems have started addressing; re-deriving it from a folder
 * that has since been renamed would silently move an agent's mailbox. The one
 * exception is `wasOldDefault`: a slug this same backfill machine-generated
 * under a rule that has since changed is not a human's choice, and leaving it
 * behind would mean every recipe from before the rule changed stays wrong
 * forever. `wasOldDefault`, when given, names exactly that prior derivation —
 * a recipe is only reconciled when its stored slug matches it EXACTLY, so a
 * slug a human happened to type that also matches the old rule is still left
 * alone (indistinguishable from a deliberate choice, and treated as one).
 */
export function backfillRecipeAgents(
  derive: (r: Recipe) => string | null,
  wasOldDefault?: (r: Recipe) => string | null,
): Array<{ id: string; name: string; agent: string; renamedFrom?: string }> {
  const done: Array<{ id: string; name: string; agent: string; renamedFrom?: string }> = [];
  for (const rec of listRecipes()) {
    if (!rec.agent) {
      const slug = derive(rec);
      if (!slug) {
        continue;
      }
      open().prepare(`UPDATE recipes SET agent=? WHERE id=?`).run(slug, rec.id);
      done.push({ id: rec.id, name: rec.name, agent: slug });
      continue;
    }
    if (!wasOldDefault) {
      continue;
    }
    const old = wasOldDefault(rec);
    if (!old || rec.agent !== old) {
      continue; // not the machine-generated form — could be a human's choice, leave it
    }
    const next = derive(rec);
    if (!next || next === rec.agent) {
      continue;
    }
    open().prepare(`UPDATE recipes SET agent=? WHERE id=?`).run(next, rec.id);
    done.push({ id: rec.id, name: rec.name, agent: next, renamedFrom: rec.agent });
  }
  return done;
}

/** Set (or clear) a recipe's slug without touching anything else. */
export function setRecipeAgent(id: string, agent: string | null): void {
  open().prepare(`UPDATE recipes SET agent=?, updated_at=? WHERE id=?`).run(agent, Date.now(), id);
}

/** Partial theme/name write-back from the solo window's inline editors, so a
 *  rename or recolor made ON the window auto-saves into the recipe. */
export function updateRecipeTheme(
  id: string,
  patch: Partial<Pick<Recipe, 'name' | 'color' | 'fg' | 'bg' | 'watermark' | 'fontSize' | 'logo'>>,
): void {
  open()
    .prepare(
      `UPDATE recipes SET
         name      = COALESCE(@name, name),
         color     = COALESCE(@color, color),
         fg        = COALESCE(@fg, fg),
         bg        = COALESCE(@bg, bg),
         watermark = COALESCE(@watermark, watermark),
         fontSize  = COALESCE(@fontSize, fontSize),
         logo      = COALESCE(@logo, logo),
         updated_at = @now
       WHERE id = @id`,
    )
    .run({
      id,
      now: Date.now(),
      name: patch.name ?? null,
      color: patch.color ?? null,
      fg: patch.fg ?? null,
      bg: patch.bg ?? null,
      watermark: patch.watermark ?? null,
      fontSize: patch.fontSize ?? null,
      logo: patch.logo ?? null,
    });
}

export function touchRecipeLaunched(id: string): void {
  open().prepare(`UPDATE recipes SET last_launched_at=? WHERE id=?`).run(Date.now(), id);
}

export function getRecipe(id: string): Recipe | undefined {
  return hydrateRecipe(open().prepare(`SELECT * FROM recipes WHERE id=?`).get(id) as Recipe | undefined);
}

export function listRecipes(): Recipe[] {
  return (open().prepare(`SELECT * FROM recipes ORDER BY name COLLATE NOCASE`).all() as Recipe[]).map(
    (r) => hydrateRecipe(r)!,
  );
}

export function deleteRecipe(id: string): void {
  open().prepare(`DELETE FROM recipes WHERE id=?`).run(id);
}

/* ============================================================================
 * SVG LOGO LIBRARY (CLI Manager phase) — named, reusable ghosted-logo SVGs.
 *
 * A logo saved here is recallable from ANY window's logo picker (vs a session-
 * only logo, which lives on the recipe). Names are unique the Windows way: a
 * collision gets " (2)", " (3)" appended (createLogo dedups). The `logos` table
 * is created lazily on first use so existing dbs migrate with zero ceremony.
 * ========================================================================== */

export interface LogoAsset {
  id: number;
  name: string;
  svg: string;
  /** The art this set had before the last replace, or null. One step back. */
  prev_svg: string | null;
  /**
   * The art's own TREATMENT, as one opaque JSON string, or null.
   *
   * `{line, washFrom, backlit, scale, opacity}` — exactly the v21 watermark
   * fields, minus the art itself. Opaque here ON PURPOSE, mirroring the
   * recipe's `logo` pref: the engine stores and serves it, the UIs are the
   * only things that parse it, so a new treatment field needs no migration.
   *
   * WHY IT LIVES ON THE ART. the design system hwb-watermark.css rules it in its own
   * header — "line style per logo, chosen in the engine's icon editor", while
   * "each recipe keeps its own scale / opacity". So line/wash/backlit are the
   * artwork's, and the scale/opacity stored here are the DEFAULTS a recipe
   * inherits when it picks this set and may then override. Nothing reads this
   * at render time: a recipe's own logo pref stays the single source for what
   * its pane paints, which is why this needed no migration of existing panes.
   *
   * NULL means "this art has no opinion", which is distinct from a stored
   * default — it is what lets LOGO_DEFAULTS stay the one fallback.
   */
  style: string | null;
  created_at: number;
}

function ensureLogosTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS logos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      svg        TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  /* prev_svg: ONE level of undo on a replace. Owner wants to swap art in and
     back out again if it does not look right, and a set is referenced by key —
     so replacing is the normal way to iterate on a mark that panes already
     wear. Deliberately one level, not history: the question being answered is
     "did that last change help", which needs exactly one step back. */
  const have = new Set(
    (database.prepare(`PRAGMA table_info(logos)`).all() as { name: string }[]).map((c) => c.name),
  );
  if (!have.has('prev_svg')) {
    database.exec(`ALTER TABLE logos ADD COLUMN prev_svg TEXT`);
  }
  /* style: additive and idempotent, like every other ALTER here — runs on
     every open, does nothing once the column exists. Existing sets read NULL,
     which is the correct answer for art nobody has styled yet. */
  if (!have.has('style')) {
    database.exec(`ALTER TABLE logos ADD COLUMN style TEXT`);
  }
}

export function listLogos(): LogoAsset[] {
  const db2 = open();
  ensureLogosTable(db2);
  return db2.prepare(`SELECT * FROM logos ORDER BY name COLLATE NOCASE`).all() as LogoAsset[];
}

/** Store a named SVG. Dedups the name the Windows-explorer way ("name (2)"),
 *  case-insensitive. Returns the stored asset (with the final, unique name). */
export function createLogo(name: string, svg: string): LogoAsset {
  const db2 = open();
  ensureLogosTable(db2);
  const base = (name || '').trim() || 'Untitled';
  const taken = new Set(
    (db2.prepare(`SELECT name FROM logos`).all() as { name: string }[]).map((r) => r.name.toLowerCase()),
  );
  let final = base;
  for (let n = 2; taken.has(final.toLowerCase()); n++) {
    final = `${base} (${n})`;
  }
  const info = db2
    .prepare(`INSERT INTO logos (name, svg, created_at) VALUES (?, ?, ?)`)
    .run(final, svg, Date.now());
  return db2.prepare(`SELECT * FROM logos WHERE id=?`).get(info.lastInsertRowid) as LogoAsset;
}

/** Store the art's treatment. The caller validates and serialises; this is the
 *  write. Passing null clears it back to "no opinion". */
export function setLogoStyle(id: number, style: string | null): LogoAsset | null {
  const db2 = open();
  ensureLogosTable(db2);
  db2.prepare(`UPDATE logos SET style=? WHERE id=?`).run(style, id);
  return (db2.prepare(`SELECT * FROM logos WHERE id=?`).get(id) as LogoAsset) ?? null;
}

export function deleteLogo(id: number): void {
  const db2 = open();
  ensureLogosTable(db2);
  db2.prepare(`DELETE FROM logos WHERE id=?`).run(id);
}

/** Rename. The KEY is `lib:<id>` and never the name, so this is purely a label
 *  change and cannot orphan a pane wearing this mark. */
/**
 * Re-point a live pane at the transcript it is ACTUALLY in.
 *
 * The banked id is the incarnation we launched or restored; an in-pane
 * `/resume` switches the running process to a DIFFERENT transcript without
 * telling anyone, leaving the row pointing at an abandoned one. Symptom: a
 * pane titled "/config" — the 5-line session Owner opened, typed one slash
 * command into, and resumed away from — while the window actually holds a
 * 74 MB conversation.
 *
 * Deliberately narrow: this only ever moves session_id, and only when the
 * caller has established the pane is live and the new id unambiguous. It does
 * not touch state, prefs, or anything a restore depends on beyond the id
 * itself — which is precisely the thing that was wrong.
 */
export function adoptSessionId(paneid: string, sessionId: string): void {
  const db2 = open();
  db2
    /* [connector] A pane a Codex connector binding owns never has its resume id moved by a hook or
       an adoption sweep: the connector's threadId is authoritative (ticket). */
    .prepare(
      `UPDATE sessions SET session_id=?, cleared_at=NULL, cleared_to=NULL, updated_at=? WHERE paneid=? AND state='live'
         AND paneid NOT IN (SELECT paneid FROM connector_binding WHERE paneid IS NOT NULL)`,
    )
    .run(sessionId, Date.now(), paneid); // moved onto the new conversation: a reconnect resumes IT, so no /clear warning
}

/** Flag a live pane as /clear'ed in its CLI (session-cleared.ts). */
export function markCleared(paneid: string, to: string, at: number): void {
  open().prepare(`UPDATE sessions SET cleared_at=?, cleared_to=? WHERE paneid=? AND state='live' AND cleared_at IS NULL`).run(at, to, paneid);
}

/** The person dismissed the warning: drop the flag, remember which /clear it was. */
export function dismissCleared(paneid: string): void {
  open().prepare(`UPDATE sessions SET cleared_at=NULL WHERE paneid=?`).run(paneid);
}

export function renameLogo(id: number, name: string): LogoAsset | null {
  const db2 = open();
  ensureLogosTable(db2);
  const clean = (name || '').trim();
  if (!clean) {
    return null;
  }
  db2.prepare(`UPDATE logos SET name=? WHERE id=?`).run(clean, id);
  return (db2.prepare(`SELECT * FROM logos WHERE id=?`).get(id) as LogoAsset) ?? null;
}

/** Swap in new art, keeping the old one step back for revert. */
export function replaceLogoSvg(id: number, svg: string): LogoAsset | null {
  const db2 = open();
  ensureLogosTable(db2);
  const cur = db2.prepare(`SELECT svg FROM logos WHERE id=?`).get(id) as { svg: string } | undefined;
  if (!cur) {
    return null;
  }
  db2.prepare(`UPDATE logos SET prev_svg=?, svg=? WHERE id=?`).run(cur.svg, svg, id);
  return (db2.prepare(`SELECT * FROM logos WHERE id=?`).get(id) as LogoAsset) ?? null;
}

/** Undo the last replace. SWAPS rather than discards, so revert is itself
 *  revertible — pressing it twice returns you to where you started, which is
 *  what someone comparing two versions actually does. */
export function revertLogo(id: number): LogoAsset | null {
  const db2 = open();
  ensureLogosTable(db2);
  const cur = db2.prepare(`SELECT svg, prev_svg FROM logos WHERE id=?`).get(id) as
    | { svg: string; prev_svg: string | null }
    | undefined;
  if (!cur?.prev_svg) {
    return null;
  }
  db2.prepare(`UPDATE logos SET svg=?, prev_svg=? WHERE id=?`).run(cur.prev_svg, cur.svg, id);
  return (db2.prepare(`SELECT * FROM logos WHERE id=?`).get(id) as LogoAsset) ?? null;
}

/* ============================================================================
 * ICON-LAB RATINGS (2026-09-02) — Owner's eye, recorded per (set, recipe).
 *
 * WHY THIS EXISTS AND THE COMPUTED SCORE DOES NOT REPLACE IT: the automatic
 * score is a PROXY for "does this read as the mark at 20px", and the first
 * version of it crowned a featureless blob because mush alone rewards having
 * no detail. A human verdict is the ground truth the proxy is trying to
 * approximate. Collecting it across every set turns the horse race into its
 * actual deliverable — WHICH RECIPE WINS CONSISTENTLY — and simultaneously
 * says whether the score is trustworthy enough to keep using on future art.
 *
 * Deliberately keyed by set SLUG and recipe ID, not by the SVG: the art will be
 * re-derived and re-optimised, and a verdict about "trace @64 · close 2 on
 * hearth" survives all of that. One row per pair; re-rating overwrites.
 * ========================================================================== */

export interface IconRating {
  set_slug: string;
  recipe_id: string;
  /** 2 = green (good at 20px), 1 = yellow (marginal), 0 = red (no).
   *  UNRATED is the ABSENCE of a row, not a fourth value — so "not yet looked
   *  at" can never be confused with "looked at and judged bad", which is the
   *  distinction the whole aggregate depends on. */
  verdict: number;
  /** The computed score at rating time — kept so proxy-vs-eye can be compared
   *  later without re-running the race (the ladder may have moved by then). */
  score: number;
  fidelity: number;
  mush: number;
  rated_at: number;
}

function ensureRatingsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS icon_ratings (
      set_slug  TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      verdict   INTEGER NOT NULL,
      score     INTEGER NOT NULL DEFAULT 0,
      fidelity  INTEGER NOT NULL DEFAULT 0,
      mush      INTEGER NOT NULL DEFAULT 0,
      rated_at  INTEGER NOT NULL,
      PRIMARY KEY (set_slug, recipe_id)
    );
  `);
}

export function listIconRatings(): IconRating[] {
  const db2 = open();
  ensureRatingsTable(db2);
  return db2
    .prepare(`SELECT * FROM icon_ratings ORDER BY set_slug, recipe_id`)
    .all() as IconRating[];
}

/** Upsert one verdict. Re-rating the same pair overwrites — a change of mind is
 *  a correction, never a second data point. */
export function setIconRating(r: Omit<IconRating, 'rated_at'>): void {
  const db2 = open();
  ensureRatingsTable(db2);
  db2
    .prepare(
      `INSERT INTO icon_ratings (set_slug, recipe_id, verdict, score, fidelity, mush, rated_at)
       VALUES (@set_slug, @recipe_id, @verdict, @score, @fidelity, @mush, @rated_at)
       ON CONFLICT(set_slug, recipe_id) DO UPDATE SET
         verdict=excluded.verdict, score=excluded.score,
         fidelity=excluded.fidelity, mush=excluded.mush, rated_at=excluded.rated_at`,
    )
    .run({ ...r, rated_at: Date.now() });
}

export function clearIconRating(setSlug: string, recipeId: string): void {
  const db2 = open();
  ensureRatingsTable(db2);
  db2.prepare(`DELETE FROM icon_ratings WHERE set_slug=? AND recipe_id=?`).run(setSlug, recipeId);
}

/* ============================================================================
 * ICON-LAB RACE CACHE — the generated candidates, kept.
 *
 * A race takes ~2s and produces the artwork the verdicts are ABOUT. Without
 * this, a page refresh mid-pass discards every derived mark and the ratings
 * still in the table suddenly refer to nothing on screen — you cannot see which
 * ones you already did, which is the one thing a long rating pass needs.
 *
 * Stored as the candidates JSON, one row per set, overwritten on re-race. The
 * payload is derived data: losing it costs 2s of recompute, never a verdict,
 * which is why it lives beside the ratings rather than inside them.
 * ========================================================================== */

export interface IconRace {
  set_slug: string;
  payload: string;
  created_at: number;
}

function ensureRacesTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS icon_races (
      set_slug   TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

/** Manifest only — which sets have a cached race, and how big. The payloads are
 *  hundreds of KB in total, so the page asks for them per set rather than
 *  dragging every derived mark through one response on load. */
export function listIconRaces(): { set_slug: string; created_at: number; bytes: number }[] {
  const db2 = open();
  ensureRacesTable(db2);
  return db2
    .prepare(`SELECT set_slug, created_at, length(payload) AS bytes FROM icon_races ORDER BY set_slug`)
    .all() as { set_slug: string; created_at: number; bytes: number }[];
}

export function getIconRace(setSlug: string): IconRace | null {
  const db2 = open();
  ensureRacesTable(db2);
  return (db2.prepare(`SELECT * FROM icon_races WHERE set_slug=?`).get(setSlug) as IconRace) ?? null;
}

export function putIconRace(setSlug: string, payload: string): void {
  const db2 = open();
  ensureRacesTable(db2);
  db2
    .prepare(
      `INSERT INTO icon_races (set_slug, payload, created_at) VALUES (?, ?, ?)
       ON CONFLICT(set_slug) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at`,
    )
    .run(setSlug, payload, Date.now());
}

/**
 * Startup reconciliation. The engine owns zero live sessions the instant it
 * boots, so any row still marked `live` is stale — its owning engine was killed
 * or crashed before the socket-close handler could record the end.
 *
 * Per-vendor branch (ticket): a resumable vendor's conversation lives on disk
 * (claude's transcript, gemini's ~/.gemini session store) and SURVIVES the
 * engine — so its stale `live` row reconciles to `dehydrated`, restorable via
 * that vendor's own resume invocation. Every other vendor is a bare local
 * process that died with the engine: the honest state is `killed`. A dehydrated
 * row with no session_id can't be id-restored, but a relaunch of its recipe
 * still restores it when the recipe carries its own named resume — so it
 * dehydrates too; the attach path decides.
 *
 * THE RULE IS NO LONGER WRITTEN HERE (contract §1.1, the hazard recorded for
 * whoever added vendor #2). This SQL used to hardcode `vendor='claude-code'`
 * while `end-state.ts` derived the same rule through the vendor module — one
 * rule, two copies, whose failure mode when they disagree is a restorable
 * conversation filed `killed` and never offered again. The list now comes from
 * `resumableVendors()`, i.e. from the modules' own `resumable` flags, so adding
 * a resumable vendor updates the boot sweep by construction.
 *
 * (The import direction is deliberate and safe: the vendor registry imports
 * nothing from here at RUNTIME — only `type Recipe`, which is erased — so this
 * is a one-way dependency on the rule, not a cycle.)
 */
export function reconcileStaleLive(
  /** Paneids the PTY-broker still holds ALIVE (vk [ref] Phase 2) — their rows
   *  are NOT stale: the session outlived the engine and will be adopted. */
  excludePaneids: string[] = [],
): { dehydrated: number; killed: number } {
  const db2 = open();
  const now = Date.now();
  const notHeld =
    excludePaneids.length > 0
      ? ` AND paneid NOT IN (${excludePaneids.map(() => '?').join(',')})`
      : '';
  /* THE STAMP IS A BATCH, AND THERE IS ONLY EVER ONE (Owner, 2026-09-17).
   *
   * Every row still `live` at boot was OPEN when the engine died (an
   * individually-ended pane wrote `killed` while the engine was alive), so it
   * is stamped BEFORE the state flips, for the manager's restore offer.
   *
   * What was missing was expiry. Nothing ever cleared a stamp except a respawn
   * of that exact pane or an explicit dismiss, so stamps ACCUMULATED across
   * every restart: eight deploys in a day left eight boots' worth of rows
   * stamped, the broker rebind then killed the ones on the old host, and the
   * next morning's banner offered a pile of day-old dead sessions while the
   * sessions Owner had actually lost from view were still LIVE (only their tabs
   * were gone) and so were never in the offer at all.
   *
   * One batch per boot, never accumulated. But ONLY IF THIS BOOT HAS ONE:
   * restart the engine twice in a row and the second boot finds nothing live
   * (the first boot already swept them), so clearing unconditionally would
   * delete an offer the user has not seen yet. An empty sweep is not news and
   * must not destroy the last real news. Age is then the manager's cut, which
   * is what `interrupted_at` is for.
   */
  const batch = (
    db2.prepare(`SELECT paneid FROM sessions WHERE state='live'${notHeld}`).all(...excludePaneids) as {
      paneid: string;
    }[]
  ).map((r) => r.paneid);
  if (batch.length > 0) {
    db2
      .prepare(`UPDATE sessions SET interrupted=0, interrupted_at=NULL WHERE interrupted=1 OR interrupted_at IS NOT NULL`)
      .run();
    db2
      .prepare(`UPDATE sessions SET interrupted=1, interrupted_at=? WHERE state='live'${notHeld}`)
      .run(now, ...excludePaneids);
  }
  /* Placeholders, never interpolated values: the list is ours today, but SQL
     built by string concatenation is a habit that outlives the file it was
     safe in. */
  const resumable = resumableVendors();
  const dehydrated = resumable.length
    ? db2
        .prepare(
          `UPDATE sessions SET state='dehydrated', updated_at=?
           WHERE state='live' AND vendor IN (${resumable.map(() => '?').join(',')})${notHeld}`,
        )
        .run(now, ...resumable, ...excludePaneids).changes
    : 0;
  const killed = db2
    .prepare(`UPDATE sessions SET state='killed', updated_at=? WHERE state='live'${notHeld}`)
    .run(now, ...excludePaneids).changes;
  return { dehydrated, killed };
}

/** Dismiss the "interrupted last session" offer: clear every stamp, and its
 *  date with it — a dated stamp with the flag off would still look like a batch
 *  to anything that reads the column rather than the pair. */
export function clearInterrupted(): number {
  return open()
    .prepare(`UPDATE sessions SET interrupted=0, interrupted_at=NULL WHERE interrupted=1 OR interrupted_at IS NOT NULL`)
    .run().changes;
}

/* ============================================================================
 * PANE TOKENS (the design notes §3.2, S1). An agent's credential,
 * bound to ONE process of one pane: (paneid, generation). Only sha256(token)
 * is stored; the token itself exists in the pane's delivery and nowhere else.
 * Revocation is a stamp, never a delete, so a refusal can say WHY.
 *
 * ADVISORY AT L0 (§3.2, R6): this file is writable by every agent on the box,
 * so binding and revocation hold against mistakes, not against a hostile
 * agent. "An agent can never mint a token" means never through an engine route.
 * ========================================================================== */

/* SESSION WORKTREES (Owner 2026-10-05, worktree convention, KB design-notes-id
 * section 12). The per-session cwd override. A SIDE table keyed by paneid rather
 * than a sessions column: the launch binds the pane to its worktree BEFORE any
 * sessions row exists (the row is first written by the attach), and the attach's
 * upsert must not be able to clobber it. The location is stored RELATIVE to the
 * worktree root as <project>/<name> (never an absolute path, so a moved root
 * does not strand it); worktrees.worktreePath() resolves it at use time. Rows
 * are dropped only when the worktree itself is removed. */
export interface SessionWorktree {
  paneid: string;
  project: string;
  name: string;
  branch: string;
}

function ensureSessionWorktreesTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_worktrees (
      paneid  TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      name    TEXT NOT NULL,
      branch  TEXT NOT NULL
    );
  `);
}

export function setSessionWorktree(w: SessionWorktree): void {
  open()
    .prepare(
      `INSERT INTO session_worktrees (paneid, project, name, branch) VALUES (@paneid, @project, @name, @branch)
       ON CONFLICT(paneid) DO UPDATE SET project=@project, name=@name, branch=@branch`,
    )
    .run(w);
}

export function getSessionWorktree(paneid: string): SessionWorktree | undefined {
  return open().prepare(`SELECT * FROM session_worktrees WHERE paneid=?`).get(paneid) as SessionWorktree | undefined;
}

/** Forget every pane bound to a worktree (it was removed). */
export function dropSessionWorktrees(project: string, name: string): void {
  open().prepare(`DELETE FROM session_worktrees WHERE project=? AND name=?`).run(project, name);
}

/* TYPER STATE (night test 2026-10-06). The room typer's per-pane queue of
 * lines not yet typed, and whether the pane's input box was last seen holding
 * a draft — both lived only in memory, so an engine restart DROPPED every held
 * line (the engine had already acked it `delivered`, so the fabric replay was
 * skipped as "already typed") and forgot every draft (so whatever arrived next
 * was typed onto it). A side table keyed by paneid, written through by the
 * typer, read back when the pane is adopted. `items` is opaque JSON the typer
 * owns; a row with no items and no draft is deleted. */
export interface TyperStateRow {
  paneid: string;
  items: string | null;
  draft: number;
  at: number;
}

function ensureTyperStateTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS typer_state (
      paneid TEXT PRIMARY KEY,
      items  TEXT,
      draft  INTEGER NOT NULL DEFAULT 0,
      at     INTEGER NOT NULL
    );
  `);
}

function tidyTyperState(paneid: string): void {
  open().prepare(`DELETE FROM typer_state WHERE paneid=? AND items IS NULL AND draft=0`).run(paneid);
}

export function setTyperItems(paneid: string, items: string | null): void {
  open()
    .prepare(
      `INSERT INTO typer_state (paneid, items, draft, at) VALUES (?, ?, 0, ?)
       ON CONFLICT(paneid) DO UPDATE SET items=excluded.items, at=excluded.at`,
    )
    .run(paneid, items, Date.now());
  tidyTyperState(paneid);
}

export function setTyperDraft(paneid: string, draft: boolean): void {
  open()
    .prepare(
      `INSERT INTO typer_state (paneid, items, draft, at) VALUES (?, NULL, ?, ?)
       ON CONFLICT(paneid) DO UPDATE SET draft=excluded.draft, at=excluded.at`,
    )
    .run(paneid, draft ? 1 : 0, Date.now());
  tidyTyperState(paneid);
}

export function getTyperState(paneid: string): TyperStateRow | undefined {
  return open().prepare(`SELECT * FROM typer_state WHERE paneid=?`).get(paneid) as TyperStateRow | undefined;
}

export function listTyperState(): TyperStateRow[] {
  return open().prepare(`SELECT * FROM typer_state`).all() as TyperStateRow[];
}

export function dropTyperState(paneid: string): void {
  open().prepare(`DELETE FROM typer_state WHERE paneid=?`).run(paneid);
}

/* ---- CODEX CONNECTOR: binding, outbox, submissions (ticket/2031/2032) -----------------
 * Additive and INERT until HARBOR_WB_CONNECTOR is set: nothing writes these tables on the
 * existing paths. Contract: the connector repo's the design notes and
 * the design notes; engine half in src/engine/connector-bridge.ts.
 *
 *  connector_binding  one row per STABLE runtime id (never derived from a pane). `incarnation`
 *                     is the connector's fence (NOT sessions.generation, which bumps on every
 *                     spawn); it moves only through handoffConnectorBinding. `paneid` is just
 *                     the current association. `handoff` = 'pending-connector' is the durable
 *                     handoff intent, replayed until the connector's snapshot acknowledges it.
 *  connector_outbox   the engine's durable delivery journal, one revisioned JSON row per runtime
 *                     (compare-and-set on revision), the typer_state precedent.
 *  connector_submission  canonical dedup: one row per (runtime, submission id) with the content
 *                     hash, so the same id with different content is refused, never re-sent. */
export interface ConnectorBindingRow {
  runtime_id: string;
  paneid: string | null;
  incarnation: number;
  revision: number;
  thread_id: string | null;
  codex_session_id: string | null;
  /** creation-pending | awaiting-persistence | bound | held */
  state: string;
  /** 1 once the connector reported correlated history (the thread can be resumed). */
  materialized: number;
  /** 'pending-connector' while a handoff is not yet acknowledged, else null. */
  handoff: string | null;
  created_at: number;
  updated_at: number;
}

function ensureConnectorTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS connector_binding (
      runtime_id       TEXT PRIMARY KEY,
      paneid           TEXT,
      incarnation      INTEGER NOT NULL,
      revision         INTEGER NOT NULL DEFAULT 0,
      thread_id        TEXT,
      codex_session_id TEXT,
      state            TEXT NOT NULL,
      materialized     INTEGER NOT NULL DEFAULT 0,
      handoff          TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS connector_binding_pane ON connector_binding(paneid) WHERE paneid IS NOT NULL;
    CREATE TABLE IF NOT EXISTS connector_outbox (
      runtime_id TEXT PRIMARY KEY,
      revision   INTEGER NOT NULL,
      record     TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_submission (
      runtime_id    TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      content_sha   TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (runtime_id, submission_id)
    );
  `);
}

export function getConnectorBinding(runtimeId: string): ConnectorBindingRow | undefined {
  return open().prepare(`SELECT * FROM connector_binding WHERE runtime_id=?`).get(runtimeId) as ConnectorBindingRow | undefined;
}

export function connectorBindingForPane(paneid: string): ConnectorBindingRow | undefined {
  return open().prepare(`SELECT * FROM connector_binding WHERE paneid=?`).get(paneid) as ConnectorBindingRow | undefined;
}

/** Create the binding for a stable runtime id: incarnation 1, no thread yet. Idempotent: an
 *  existing row is returned unchanged (never reset to creation-pending). */
export function createConnectorBinding(runtimeId: string, paneid: string | null): ConnectorBindingRow {
  const now = Date.now();
  open()
    .prepare(
      `INSERT INTO connector_binding (runtime_id, paneid, incarnation, revision, state, created_at, updated_at)
       VALUES (?, ?, 1, 0, 'creation-pending', ?, ?) ON CONFLICT(runtime_id) DO NOTHING`,
    )
    .run(runtimeId, paneid, now, now);
  return getConnectorBinding(runtimeId)!;
}

/** The persist-before-acknowledge transaction (contract step 4): record the connector's minted
 *  thread id on the binding AND in sessions.session_id, atomically. Replaying the same
 *  (runtime, incarnation, revision, thread) is a no-op; a DIFFERENT thread for a bound runtime,
 *  or a wrong incarnation, throws and writes nothing. */
export function commitConnectorBinding(a: {
  runtimeId: string;
  incarnation: number;
  revision: number;
  threadId: string;
  codexSessionId?: string | null;
}): ConnectorBindingRow {
  const d = open();
  return d.transaction(() => {
    const b = getConnectorBinding(a.runtimeId);
    if (!b) {
      throw new Error(`no connector binding for ${a.runtimeId}`);
    }
    if (b.incarnation !== a.incarnation) {
      throw new Error(`incarnation mismatch for ${a.runtimeId}: have ${b.incarnation}, got ${a.incarnation}`);
    }
    if (b.thread_id && b.thread_id !== a.threadId) {
      throw new Error(`runtime ${a.runtimeId} is already bound to a different thread`);
    }
    if (b.thread_id === a.threadId && b.revision === a.revision && b.state === 'bound') {
      return b; // replay
    }
    d.prepare(
      `UPDATE connector_binding SET thread_id=?, codex_session_id=COALESCE(?, codex_session_id), revision=?, state='bound', updated_at=? WHERE runtime_id=?`,
    ).run(a.threadId, a.codexSessionId ?? null, a.revision, Date.now(), a.runtimeId);
    if (b.paneid) {
      d.prepare(`UPDATE sessions SET session_id=?, updated_at=? WHERE paneid=?`).run(a.threadId, Date.now(), b.paneid);
    }
    return getConnectorBinding(a.runtimeId)!;
  })();
}

/** The connector reported correlated history for this thread: it can now be resumed. */
export function markConnectorMaterialized(runtimeId: string, threadId: string): void {
  open()
    .prepare(`UPDATE connector_binding SET materialized=1, updated_at=? WHERE runtime_id=? AND thread_id=?`)
    .run(Date.now(), runtimeId, threadId);
}

/** The engine half of an incarnation handoff, in ONE transaction: fence by moving N -> N+1,
 *  associate the new pane, keep the thread and the outbox row, and leave the durable intent
 *  `handoff='pending-connector'` for the connector call to replay until acknowledged. Replaying
 *  the same (from, to) while pending is a no-op; anything else throws. */
export function handoffConnectorBinding(a: { runtimeId: string; fromIncarnation: number; toIncarnation: number; paneid: string | null }): ConnectorBindingRow {
  const d = open();
  return d.transaction(() => {
    const b = getConnectorBinding(a.runtimeId);
    if (!b) {
      throw new Error(`no connector binding for ${a.runtimeId}`);
    }
    if (b.handoff === 'pending-connector' && b.incarnation === a.toIncarnation) {
      return b; // replay of the same intent
    }
    if (b.incarnation !== a.fromIncarnation || a.toIncarnation !== a.fromIncarnation + 1) {
      throw new Error(`handoff ${a.fromIncarnation}->${a.toIncarnation} does not follow incarnation ${b.incarnation}`);
    }
    if (!b.thread_id) {
      throw new Error(`runtime ${a.runtimeId} has no thread to hand off`);
    }
    d.prepare(`UPDATE connector_binding SET paneid=NULL WHERE paneid=? AND runtime_id<>?`).run(a.paneid, a.runtimeId);
    d.prepare(
      `UPDATE connector_binding SET incarnation=?, paneid=?, handoff='pending-connector', updated_at=? WHERE runtime_id=?`,
    ).run(a.toIncarnation, a.paneid, Date.now(), a.runtimeId);
    return getConnectorBinding(a.runtimeId)!;
  })();
}

/** The connector's snapshot reported the new incarnation: the intent is satisfied. */
export function ackConnectorHandoff(runtimeId: string, incarnation: number): ConnectorBindingRow | undefined {
  open()
    .prepare(`UPDATE connector_binding SET handoff=NULL, updated_at=? WHERE runtime_id=? AND incarnation=? AND handoff='pending-connector'`)
    .run(Date.now(), runtimeId, incarnation);
  return getConnectorBinding(runtimeId);
}

export function readConnectorOutbox(runtimeId: string): { revision: number; record: string } | undefined {
  return open().prepare(`SELECT revision, record FROM connector_outbox WHERE runtime_id=?`).get(runtimeId) as
    | { revision: number; record: string }
    | undefined;
}

/** Compare-and-set on revision. `previousRevision` undefined = "there is no row yet". A stale
 *  revision throws and writes nothing. */
export function writeConnectorOutbox(runtimeId: string, record: string, revision: number, previousRevision: number | undefined): void {
  const d = open();
  d.transaction(() => {
    const cur = readConnectorOutbox(runtimeId);
    if ((cur?.revision) !== previousRevision) {
      throw new Error(`connector outbox revision conflict for ${runtimeId}: stored ${cur?.revision ?? 'none'}, expected ${previousRevision ?? 'none'}`);
    }
    d.prepare(
      `INSERT INTO connector_outbox (runtime_id, revision, record, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(runtime_id) DO UPDATE SET revision=excluded.revision, record=excluded.record, updated_at=excluded.updated_at`,
    ).run(runtimeId, revision, record, Date.now());
  })();
}

/** Canonical dedup, scoped to the STABLE runtime so it survives incarnations. */
export function recordConnectorSubmission(runtimeId: string, submissionId: string, contentSha: string): 'new' | 'duplicate' | 'conflict' {
  const d = open();
  return d.transaction(() => {
    const cur = d.prepare(`SELECT content_sha FROM connector_submission WHERE runtime_id=? AND submission_id=?`).get(runtimeId, submissionId) as
      | { content_sha: string }
      | undefined;
    if (cur) {
      return cur.content_sha === contentSha ? ('duplicate' as const) : ('conflict' as const);
    }
    d.prepare(`INSERT INTO connector_submission (runtime_id, submission_id, content_sha, created_at) VALUES (?, ?, ?, ?)`).run(
      runtimeId,
      submissionId,
      contentSha,
      Date.now(),
    );
    return 'new' as const;
  })();
}

/* ---- BASIC "SWITCH ASSISTANT" JOURNAL (ticket / ticket) -------------------------------------
 * ONE durable row per switch operation, advanced only by compare-and-set on `revision`, so any crash is
 * recoverable WITHOUT the outgoing model: the runner re-reads the row and continues from `state`.
 * Contract: the connector repo's the design notes (engine orchestrates; the vendor adapter is
 * underneath). A duplicate request for a room that already has an ACTIVE operation joins it (partial unique
 * index), never starts a second one. Terminal states: done | cancelled | failed-before-transfer (the original
 * lead is intact) | failed-after-transfer (the target has the lead: needs a person). */
export const SWITCH_STATES = [
  'intent', 'packet-saved', 'fenced', 'target-identified', 'banked', 'context-delivered', 'context-accepted',
  'lead-committed', 'done', 'cancelled', 'failed-before-transfer', 'failed-after-transfer',
] as const;
export type SwitchState = (typeof SWITCH_STATES)[number];
export const SWITCH_TERMINAL: readonly SwitchState[] = ['done', 'cancelled', 'failed-before-transfer', 'failed-after-transfer'];

export interface SwitchRow {
  op_id: string;
  room_id: string;
  instance_id: string;
  account_id: string;
  project_id: string;
  from_recipe_id: string;
  from_paneid: string | null;
  from_seat_id: string | null;
  from_vendor: string;
  to_recipe_id: string;
  to_vendor: string;
  to_model: string | null;
  to_effort: string | null;
  note: string | null;
  state: SwitchState;
  revision: number;
  /** the lead seat the room had when the intent was written: the CAS guard for the transfer */
  expected_lead_seat: string | null;
  packet_path: string | null;
  packet_sha256: string | null;
  delivery_id: string | null;
  delivery_sha256: string | null;
  client_message_id: string | null;
  target_paneid: string | null;
  target_session_id: string | null;
  binding_revision: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  /** JSON array of typer items held for the seat during the switch (durable transfer, spec §3 item 4) */
  held_lines?: string | null;
  /** the pane launched for THIS operation, journaled the moment it exists (idempotency + cleanup) */
  launched_paneid?: string | null;
  /** after a failure before transfer: 'restored' once the old assistant is back, 'pending' otherwise */
  recovery?: string | null;
}

function ensureSwitchTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS assistant_switch (
      op_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      from_recipe_id TEXT NOT NULL,
      from_paneid TEXT,
      from_seat_id TEXT,
      from_vendor TEXT NOT NULL,
      to_recipe_id TEXT NOT NULL,
      to_vendor TEXT NOT NULL,
      to_model TEXT,
      to_effort TEXT,
      note TEXT,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      expected_lead_seat TEXT,
      packet_path TEXT,
      packet_sha256 TEXT,
      delivery_id TEXT,
      delivery_sha256 TEXT,
      client_message_id TEXT,
      target_paneid TEXT,
      target_session_id TEXT,
      binding_revision INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_switch_active_room ON assistant_switch(room_id)
      WHERE state NOT IN ('done','cancelled','failed-before-transfer','failed-after-transfer');
  `);
  /* additive (cloud-agent job 3): the durable held lines, the launched pane, the recovery word */
  const have = new Set((database.prepare(`PRAGMA table_info(assistant_switch)`).all() as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [['held_lines', 'TEXT'], ['launched_paneid', 'TEXT'], ['recovery', 'TEXT']] as const) {
    if (!have.has(col)) {
      database.exec(`ALTER TABLE assistant_switch ADD COLUMN ${col} ${type}`);
    }
  }
}

/* ---- HELD LINES, DURABLY (switch spec §3 item 4) -------------------------------------
 * A held line is a room-typer item (roomId, entryId, text + meta) carrying a STABLE id: a
 * room line's `<roomId>:<entryId>`, an envelope's `<roomId>:<msgId>`, else one minted when it
 * is first held (`heldId`). The typer's persisted queue (typer_state) and the journal are in
 * this ONE database, so each move below is ONE transaction: a crash before it changes
 * nothing, a crash after it finds the lines where the move put them. Dedupe is by id, so a
 * replayed move never doubles a line. */
export interface HeldItem {
  roomId: string;
  entryId: number;
  text: string;
  heldId?: string;
  [k: string]: unknown;
}

export function heldIdOf(it: HeldItem): string {
  if (typeof it.heldId === 'string' && it.heldId) return it.heldId;
  if (it.entryId > 0) return `${it.roomId}:${it.entryId}`;
  if (typeof it.msgId === 'string' && it.msgId) return `${it.roomId}:${it.msgId}`;
  return `${it.roomId}:${typeof it.ts === 'number' ? it.ts : 0}:${createHash('sha256').update(it.text).digest('hex').slice(0, 16)}`;
}

function parseItems(raw: string | null | undefined): HeldItem[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((it) => it && typeof it.roomId === 'string' && typeof it.entryId === 'number' && typeof it.text === 'string') : [];
  } catch {
    return [];
  }
}

function mergeById(base: HeldItem[], more: HeldItem[]): HeldItem[] {
  const ids = new Set(base.map(heldIdOf));
  const out = [...base];
  for (const it of more) {
    const id = heldIdOf(it);
    if (!ids.has(id)) {
      ids.add(id);
      out.push({ ...it, heldId: id });
    }
  }
  return out;
}

/** FENCE: the old pane's queued lines move into the journal and out of its typer_state, together. */
export function holdSwitchLines(opId: string, paneid: string, items: HeldItem[]): HeldItem[] {
  const d = open();
  return d.transaction(() => {
    const cur = getSwitch(opId);
    if (!cur) throw new Error(`no such switch operation: ${opId}`);
    const merged = mergeById(parseItems(cur.held_lines), items.map((it) => ({ ...it, heldId: heldIdOf(it) })));
    d.prepare(`UPDATE assistant_switch SET held_lines=?, updated_at=? WHERE op_id=?`).run(JSON.stringify(merged), Date.now(), opId);
    setTyperItems(paneid, null);
    return merged;
  })();
}

/** A line that arrived for the seat while it was being switched (never a wake). */
export function appendSwitchLine(opId: string, item: HeldItem): void {
  const d = open();
  d.transaction(() => {
    const cur = getSwitch(opId);
    if (!cur) return;
    const merged = mergeById(parseItems(cur.held_lines), [{ ...item, heldId: heldIdOf(item) }]);
    d.prepare(`UPDATE assistant_switch SET held_lines=?, updated_at=? WHERE op_id=?`).run(JSON.stringify(merged), Date.now(), opId);
  })();
}

/** RELEASE: the journal's held lines move into `paneid`'s typer_state (the new assistant, or the
 *  restored old one), deduplicated by id, and the journal is emptied, together. Returns what was
 *  ADDED, which the caller then hands to the in-memory typer. Idempotent: a replay adds nothing. */
export function releaseSwitchLines(opId: string, paneid: string): HeldItem[] {
  const d = open();
  return d.transaction(() => {
    const cur = getSwitch(opId);
    if (!cur) return [];
    const held = parseItems(cur.held_lines);
    if (!held.length) return [];
    const queued = parseItems(getTyperState(paneid)?.items ?? null);
    const merged = mergeById(queued, held);
    const added = merged.slice(queued.length);
    setTyperItems(paneid, merged.length ? JSON.stringify(merged) : null);
    d.prepare(`UPDATE assistant_switch SET held_lines='[]', updated_at=? WHERE op_id=?`).run(Date.now(), opId);
    return added;
  })();
}

export function heldSwitchLines(opId: string): HeldItem[] {
  return parseItems(getSwitch(opId)?.held_lines);
}

/** Journal the target pane the moment it is launched (no CAS: bookkeeping, not a transition). */
export function noteSwitchLaunch(opId: string, paneid: string | null): void {
  open().prepare(`UPDATE assistant_switch SET launched_paneid=?, updated_at=? WHERE op_id=?`).run(paneid, Date.now(), opId);
}

export function setSwitchRecovery(opId: string, recovery: 'restored' | 'unchanged' | 'pending' | null): void {
  open().prepare(`UPDATE assistant_switch SET recovery=?, updated_at=? WHERE op_id=?`).run(recovery, Date.now(), opId);
}

/** Every operation of a room, newest first (status stays readable after the seat is replaced). */
export function switchesForRoom(roomId: string, limit = 20): SwitchRow[] {
  return open().prepare(`SELECT * FROM assistant_switch WHERE room_id=? ORDER BY created_at DESC LIMIT ?`).all(roomId, limit) as SwitchRow[];
}

export function getSwitch(opId: string): SwitchRow | undefined {
  return open().prepare(`SELECT * FROM assistant_switch WHERE op_id=?`).get(opId) as SwitchRow | undefined;
}

export function activeSwitchForRoom(roomId: string): SwitchRow | undefined {
  return open()
    .prepare(`SELECT * FROM assistant_switch WHERE room_id=? AND state NOT IN ('done','cancelled','failed-before-transfer','failed-after-transfer')`)
    .get(roomId) as SwitchRow | undefined;
}

/** Persist the intent. A room with an ACTIVE operation joins it: the existing row is returned and `joined` is true. */
export function createSwitch(
  row: Omit<SwitchRow, 'state' | 'revision' | 'created_at' | 'updated_at' | 'packet_path' | 'packet_sha256' | 'delivery_id' | 'delivery_sha256' | 'client_message_id' | 'target_paneid' | 'target_session_id' | 'binding_revision' | 'error' | 'held_lines' | 'launched_paneid' | 'recovery'>,
): { row: SwitchRow; joined: boolean } {
  const d = open();
  return d.transaction(() => {
    const active = activeSwitchForRoom(row.room_id);
    if (active) {
      return { row: active, joined: true };
    }
    const now = Date.now();
    d.prepare(
      `INSERT INTO assistant_switch (op_id, room_id, instance_id, account_id, project_id, from_recipe_id, from_paneid, from_seat_id, from_vendor,
         to_recipe_id, to_vendor, to_model, to_effort, note, state, revision, expected_lead_seat, created_at, updated_at)
       VALUES (@op_id, @room_id, @instance_id, @account_id, @project_id, @from_recipe_id, @from_paneid, @from_seat_id, @from_vendor,
         @to_recipe_id, @to_vendor, @to_model, @to_effort, @note, 'intent', 0, @expected_lead_seat, @now, @now)`,
    ).run({ ...row, now });
    return { row: getSwitch(row.op_id)!, joined: false };
  })();
}

export type SwitchPatch = Partial<Pick<SwitchRow, 'from_paneid' | 'from_seat_id' | 'packet_path' | 'packet_sha256' | 'delivery_id' | 'delivery_sha256' | 'client_message_id' | 'target_paneid' | 'target_session_id' | 'binding_revision' | 'error'>> & { error?: string | null };

/** Move an operation to `to` and apply `patch`, ONLY if it is still at revision `expectedRevision` (and not terminal).
 *  Returns the new row, or null when someone else moved it first (the caller re-reads and continues from the truth). */
export function advanceSwitch(opId: string, expectedRevision: number, to: SwitchState, patch: SwitchPatch = {}): SwitchRow | null {
  const d = open();
  return d.transaction(() => {
    const cur = getSwitch(opId);
    if (!cur || cur.revision !== expectedRevision || SWITCH_TERMINAL.includes(cur.state)) {
      return null;
    }
    const cols = Object.keys(patch) as Array<keyof SwitchPatch>;
    const sets = cols.map((c) => `${c}=@${c}`).join(', ');
    d.prepare(`UPDATE assistant_switch SET state=@to, revision=revision+1, updated_at=@now${sets ? `, ${sets}` : ''} WHERE op_id=@op_id`).run({
      ...patch,
      to,
      now: Date.now(),
      op_id: opId,
    });
    return getSwitch(opId)!;
  })();
}

/** Operations that were running when the engine stopped: the boot sweep resumes each from its journaled state. */
export function listActiveSwitches(): SwitchRow[] {
  return open()
    .prepare(`SELECT * FROM assistant_switch WHERE state NOT IN ('done','cancelled','failed-before-transfer','failed-after-transfer') ORDER BY created_at`)
    .all() as SwitchRow[];
}

export type PaneTokenOrigin = 'local' | 'remote';

export interface PaneTokenRow {
  hash: string;
  paneid: string;
  generation: number;
  origin: PaneTokenOrigin;
  minted_at: number;
  revoked_at: number | null;
  revoked_why: string | null;
  /** the bt tool profile chosen at mint (engine/bt-profiles.ts); 'default' on rows from before the column */
  profile: string;
}

function ensurePaneTokensTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS pane_tokens (
      hash        TEXT PRIMARY KEY,
      paneid      TEXT NOT NULL,
      generation  INTEGER NOT NULL,
      origin      TEXT NOT NULL CHECK(origin IN ('local','remote')),
      minted_at   INTEGER NOT NULL,
      revoked_at  INTEGER,
      revoked_why TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pane_tokens_pane ON pane_tokens(paneid);
  `);
  const cols = new Set((database.prepare('PRAGMA table_info(pane_tokens)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has('profile')) {
    database.exec(`ALTER TABLE pane_tokens ADD COLUMN profile TEXT NOT NULL DEFAULT 'default'`);
  }
}

/** Record a minted token. Every EARLIER token for the pane is revoked
 *  (`superseded`) in the same transaction, so a pane never holds two. */
export function insertPaneToken(t: { hash: string; paneid: string; generation: number; origin: PaneTokenOrigin; profile?: string }): void {
  const d = open();
  const now = Date.now();
  d.transaction(() => {
    d.prepare(`UPDATE pane_tokens SET revoked_at=?, revoked_why='superseded' WHERE paneid=? AND revoked_at IS NULL`).run(now, t.paneid);
    d.prepare(
      `INSERT INTO pane_tokens (hash, paneid, generation, origin, minted_at, profile) VALUES (@hash, @paneid, @generation, @origin, @minted_at, @profile)`,
    ).run({ ...t, profile: t.profile ?? 'default', minted_at: now });
  })();
}

export function paneTokenByHash(hash: string): PaneTokenRow | undefined {
  return open().prepare(`SELECT * FROM pane_tokens WHERE hash=?`).get(hash) as PaneTokenRow | undefined;
}

/** The pane's unrevoked token row, if any (whoami's minted_at; never the token). */
export function currentPaneToken(paneid: string): PaneTokenRow | undefined {
  return open()
    .prepare(`SELECT * FROM pane_tokens WHERE paneid=? AND revoked_at IS NULL ORDER BY minted_at DESC LIMIT 1`)
    .get(paneid) as PaneTokenRow | undefined;
}

/** Revoke every live token of a pane. Returns how many were revoked. */
export function revokePaneTokens(paneid: string, why: string): number {
  return open()
    .prepare(`UPDATE pane_tokens SET revoked_at=?, revoked_why=? WHERE paneid=? AND revoked_at IS NULL`)
    .run(Date.now(), why, paneid).changes;
}

/** Revoke ONE token by its hash (a failed spawn's own mint). Returns 0 or 1. */
export function revokePaneToken(hash: string, why: string): number {
  return open()
    .prepare(`UPDATE pane_tokens SET revoked_at=?, revoked_why=? WHERE hash=? AND revoked_at IS NULL`)
    .run(Date.now(), why, hash).changes;
}

/** Boot reconcile: revoke every unrevoked token whose pane is not LIVE, or
 *  whose generation is not the row's (a process that is gone). Runs AFTER
 *  reconcileStaleLive, so a broker-held pane (kept live, adopted) keeps its
 *  token. Returns the panes touched, for the caller's file cleanup. */
export function reconcilePaneTokens(): string[] {
  const d = open();
  const stale = d
    .prepare(
      `SELECT DISTINCT t.paneid FROM pane_tokens t LEFT JOIN sessions s ON s.paneid = t.paneid
        WHERE t.revoked_at IS NULL AND (s.paneid IS NULL OR s.state <> 'live' OR s.generation <> t.generation)`,
    )
    .all() as { paneid: string }[];
  const now = Date.now();
  const revoke = d.prepare(
    `UPDATE pane_tokens SET revoked_at=?, revoked_why='reconcile'
      WHERE paneid=? AND revoked_at IS NULL`,
  );
  for (const r of stale) {
    revoke.run(now, r.paneid);
  }
  return stale.map((r) => r.paneid);
}

/* ============================================================================
 * WORKROOMS (Phase 1, the design notes §1) [ticket].
 *
 * Four tables: rooms, room_seats, room_seat_history, room_line. Created lazily
 * (the logos / icon_ratings / icon_races idiom), so an engine that never opens
 * a room never grows them, and a db from before this build migrates with zero
 * ceremony.
 *
 * THE SEAT IS THE MEMBERSHIP, the occupant is whatever fills it now (wr §2.7).
 * Seats are never deleted; history holds FORMER occupants only; the line is
 * append-only and verbatim (approvals are cited by entry id, wr §2.5).
 *
 * ONE ACTION PATH (§1.5). Every mutating verb takes {actor, commandText?} and,
 * inside ONE db.transaction, performs the state change, writes history where
 * relevant, writes the verbatim `command` entry when commandText is given, and
 * writes the resulting Room `fact`. The HTTP door and the typed-command door
 * call the same verb, so their facts are identical by construction. A refusal
 * throws RoomError INSIDE the transaction, which rolls every write back: a
 * refused command writes nothing.
 *
 * ENUMS ARE VALIDATED BY THEIR CHECK CONSTRAINTS, not by a second JS copy of
 * the list. A CHECK failure maps to a 400 naming the column (mapRoomDbError),
 * and — because it can fire after earlier writes in the same transaction — it
 * is also the fault injector the atomicity test uses.
 *
 * The store never broadcasts. It returns what it wrote; the endpoint emits on
 * the room bus AFTER the transaction has committed.
 * ========================================================================== */

export type RoomState = 'open' | 'archived';
export type OccupantKind = 'pane' | 'task' | 'pool' | 'none';
export type LineKind = 'chat' | 'fact' | 'delivery' | 'attachment' | 'command' | 'voice';
export type HistoryReason = 'replaced' | 'ended' | 'evicted';

export const ROOM_STATES: readonly RoomState[] = ['open', 'archived'];
export const OCCUPANT_KINDS: readonly OccupantKind[] = ['pane', 'task', 'pool', 'none'];
export const LINE_KINDS: readonly LineKind[] = ['chat', 'fact', 'delivery', 'attachment', 'command', 'voice'];
export const HISTORY_REASONS: readonly HistoryReason[] = ['replaced', 'ended', 'evicted'];
/** Room panels (§2.6): app-served web views, and the engine's own voice tool
 *  (the design notes §9, registered by the engine only). */
export type PanelKind = 'app' | 'voice';
export const PANEL_KINDS: readonly PanelKind[] = ['app', 'voice'];

/* SeatPolicy, SEAT_POLICIES and RESERVED_HANDLES are declared in
   src/engine/room-vocab.ts (no imports, so the command parser can share them
   without loading the store) and re-exported here. normalizeHandle below is
   what enforces RESERVED_HANDLES on every write. */
export { SEAT_POLICIES, RESERVED_HANDLES };
export type { SeatPolicy };

/** The line's body cap. Over it is REFUSED, never truncated: a truncated user
 *  message is a rewritten one, and approvals cite these words. */
export const LINE_BODY_MAX = 4000;
/** The draft's own cap (ticket, Owner: text over LINE_BODY_MAX kept getting
 *  split into several sends). Higher than LINE_BODY_MAX on purpose: an
 *  over-length draft still SAVES (it survives an F5 / device switch), it
 *  just cannot SEND until it is back under LINE_BODY_MAX — that refusal is
 *  the line endpoint's, unchanged. Over THIS cap is still refused, never
 *  truncated, same reason as the line body. */
export const DRAFT_BODY_MAX = 16000;
const ROOM_NAME_MAX = 200;
const LINE_PAGE_DEFAULT = 100;
const LINE_PAGE_MAX = 1000;

export interface Room {
  id: string;
  name: string;
  lead_seat: string | null;
  state: RoomState;
  mode: string | null;
  thread: string | null;
  doc_repo: string | null;
  /** 'user' or a SEAT id — never a handle (handles rename). */
  created_by: string;
  created_at: number;
  updated_at: number;
  /** The decay signal: bumped only by chat/command entries a human or member
   *  authored. Room facts never bump it. */
  last_active_at: number;
  archived_at: number | null;
  /** agent-share folder for this room's assets (`rooms/<slug>-<id8>`), set
   *  once at first use and never re-derived, so a rename keeps it [ticket].
   *  Null until something asks for it. */
  asset_folder: string | null;
  /** ROOM SETTINGS (room round 3): the room's identity colour, `#rrggbb`, or
   *  null = unset (the room tab inherits the lead seat's project colour). */
  color: string | null;
  /** The feed the room page opens on, and what its Reset returns to; null =
   *  unset (everything, everyone). Stored as JSON, parsed at read. */
  feed_default: RoomFeedDefault | null;
  /** ROOM VOICE SETTINGS (the design notes §10.1), ALWAYS fully populated:
   *  the row stores only the room's overrides (rooms.voice), merged over the
   *  defaults at read (src/engine/room-voice-settings.ts). v3.6: the room's
   *  four keys only; the rest are the person's globals (getUserVoice). */
  voice: RoomVoiceOwn;
  /** ROOM CHARACTER (the design system room-character v1.1) [rooms/character]: the
   *  room's art as a logo KEY (`lib:<id>` or a preset name, the key recipes
   *  store), or null = none. It is drawn exactly as a pane draws its art; its
   *  style is the ART's, and the room overrides only the colour. */
  art: string | null;
  /** TILED ART [hub-v2]: {id, blend, level, strength, zoom} or null (= the
   *  room's own art / watermark, today's paint). Validated in setRoomSettings. */
  art_tile: RoomArtTile | null;
  /** SPOT POSITION [hub-v2 sec 1.I]: where the line's wash spot sits, {x, y} in
   *  0-100 (percent of the pane), or null = none stored (the art's own origin
   *  stands, exactly as before). One position for both modes. */
  wash_at: { x: number; y: number } | null;
  /** BUBBLE GLASS [bubble glass] (Owner 2026-10-05): one magnitude, a percent 50-200,
   *  that scales both the PC and the phone bubble transparency; null = 100 (the
   *  defaults, nothing written). */
  bubble_glass: number | null;
  /** This room's own palette key, or null = follows the person's global one. */
  pal: string | null;
  /** 'dark' | 'light' with `pal`; null otherwise. */
  pal_mode: 'dark' | 'light' | null;
  /** FOLLOW THE ROOM [wg follow] (Owner 2026-10-07): a workgroup wears its main room's art,
   *  palette, wash and glass, with its own color; its own saved values are kept, unused.
   *  Default true; meaningless on a main room. */
  design_follow: boolean;
  /** WORKGROUPS (Owner 2026-10-04, KB design-notes-id): the MAIN room this
   *  workgroup belongs to, or null for a main room. One level only. A main
   *  room plus its workgroups is a FAMILY. */
  parent_id: string | null;
  /** The room's address (`@alias` reaches its lead from anywhere in the
   *  family), handle grammar, <= 32; null = none. */
  alias: string | null;
  /** ROOM BRIEF [room brief] (Owner 2026-10-05): the lead's markdown note on what
   *  goes in this room (and, in a main room, in each workgroup); null = none.
   *  `brief_by` is the author's handle at the time ('user' for the person). */
  brief: string | null;
  brief_by: string | null;
  brief_at: number | null;
  /** THE ROOM'S CODE FOLDER (step C; planning KB design-notes-id): where this room's code seats work, each in its own git worktree of it. Carried by the MAIN
   *  room of a family (a workgroup uses its family's). `code_mode` records how it was chosen: 'existing' (the person's folder) or 'new' (the engine made it). null =
   *  no code folder: the room's seats run in their own agent folders. */
  code_dir: string | null;
  code_mode: 'existing' | 'new' | null;
  /** Derived at read time, never stored. */
  idle_ms: number;
}

/* TILED ART [hub-v2] (the design system b0f8099 sec 1.F): the tile ids are the 20 files in
   web/assets/tiles (id = the file name without -512.webp, e.g. `animals-koi-busy-tint`). */
export const ROOM_ART_BLENDS = ['none', 'color', 'hue', 'saturation', 'luminosity', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'normal'] as const;
export interface RoomArtTile {
  id: string;
  blend: (typeof ROOM_ART_BLENDS)[number];
  level: number; // Art level, 10-100
  strength: number; // Wash strength, 0-100
  zoom: number; // Tile zoom, 50-200
}
/** The palette keys a room may carry (web/palette.mjs PALETTES, minus 'custom':
 *  a custom palette is the person's, not the room's). */
export const ROOM_PALETTES = [
  'aurora', 'neutral', 'greyscale', 'gold', 'pastel', 'caribbean', 'reef', 'lagoon', 'sky', 'ocean', 'glacier',
  'sunset', 'fall', 'spring', 'summer', 'winter', 'forest', 'midnight', 'rose', 'contrast',
] as const;
const TILE_ID = /^[a-z0-9]+(-[a-z0-9]+)*-(quiet|busy)-(tint|hue|colour)$/;

/** The line filter a room opens on: the SHOWN kinds, and who (''= everyone,
 *  'me', 'agents', or an active seat id of the room). That is the WIRE shape;
 *  the row stores the HIDDEN kinds instead (room-voice §10.2), so a kind added
 *  after a feed was saved comes back shown. */
export interface RoomFeedDefault {
  kinds: LineKind[];
  who: string;
}

export interface RoomSeat {
  id: string;
  room_id: string;
  handle: string;
  handle_named: number;
  project: string | null;
  recipe_id: string | null;
  policy: SeatPolicy;
  policy_set_by: string | null;
  policy_set_at: number | null;
  occupant_kind: OccupantKind;
  occupant: string | null;
  occupant_since: number | null;
  pool_size: number | null;
  /** A CACHE of sessions.agent for the occupant. Never read for routing. */
  slug: string | null;
  position: number;
  added_by: string;
  added_at: number;
  left_at: number | null;
  /** Derived at read time: is this the room's lead? */
  is_lead: boolean;
}

export interface SeatHistoryRow {
  id: number;
  seat_id: string;
  occupant_kind: OccupantKind;
  occupant: string | null;
  from_ts: number | null;
  to_ts: number;
  reason: HistoryReason;
  ref: string | null;
}

export interface RoomLineEntry {
  id: number;
  room_id: string;
  ts: number;
  kind: LineKind;
  author: string;
  author_seat: string | null;
  target: string | null;
  target_seat: string | null;
  thread: string | null;
  body: string | null;
  ref: string | null;
  /** Opaque JSON string; the engine stores it, UIs parse it. */
  meta: string | null;
  /** Not a column: the OTHER rooms this line was cross-posted into (set by
   *  appendLine on the returned entry so the endpoint can announce there). */
  xposts?: string[];
}

/** Who is acting. The engine never accepts a caller-supplied author: a route
 *  resolves `from` to a seat id (or leaves it 'user') and passes that here. */
export type RoomActor = 'user' | { seatId: string };

export interface RoomActionOpts {
  actor: RoomActor;
  /** The verbatim typed command, when the action came in through the line. */
  commandText?: string | null;
}

export interface RoomAction<T> {
  roomId: string;
  result: T;
  /** Every line entry written, in id order. */
  entries: RoomLineEntry[];
  /** A seat, lead, mode, name or state changed (the endpoint emits room.state). */
  stateChanged: boolean;
  /** Other rooms whose roster also changed (a seat move), announced too. */
  alsoStateFor?: string[];
}

/** A refusal with an HTTP status and the FIELD it is about (a 400 names the
 *  field). Thrown inside a transaction, it also rolls every write back. */
export class RoomError extends Error {
  readonly status: number;
  readonly field: string;
  constructor(status: number, error: string, field: string) {
    super(error);
    this.name = 'RoomError';
    this.status = status;
    this.field = field;
  }
}

const inList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(',');

/**
 * The four room tables, their indexes, and any additive column (§1, §1.7).
 * Idempotent: every statement is IF NOT EXISTS, and a future column is added
 * behind `have.has(col)` like the other ALTERs in this file.
 */
export function ensureRoomTables(database: Database.Database): void {
  ensureTaskTables(database); // Tasks (KB design-notes-id): additive, lazily created with the room tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      lead_seat      TEXT,
      state          TEXT NOT NULL DEFAULT 'open' CHECK(state IN (${inList(ROOM_STATES)})),
      mode           TEXT,
      thread         TEXT,
      doc_repo       TEXT,
      created_by     TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      archived_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS room_seats (
      id             TEXT PRIMARY KEY,
      room_id        TEXT NOT NULL,
      handle         TEXT NOT NULL,
      handle_named   INTEGER NOT NULL DEFAULT 0 CHECK(handle_named IN (0,1)),
      project        TEXT,
      recipe_id      TEXT,
      policy         TEXT NOT NULL DEFAULT 'persistent' CHECK(policy IN (${inList(SEAT_POLICIES)})),
      policy_set_by  TEXT,
      policy_set_at  INTEGER,
      occupant_kind  TEXT NOT NULL DEFAULT 'none' CHECK(occupant_kind IN (${inList(OCCUPANT_KINDS)})),
      occupant       TEXT,
      occupant_since INTEGER,
      pool_size      INTEGER,
      slug           TEXT,
      position       INTEGER NOT NULL,
      added_by       TEXT NOT NULL,
      added_at       INTEGER NOT NULL,
      left_at        INTEGER
    );
    CREATE TABLE IF NOT EXISTS room_seat_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      seat_id       TEXT NOT NULL,
      occupant_kind TEXT NOT NULL CHECK(occupant_kind IN (${inList(OCCUPANT_KINDS)})),
      occupant      TEXT,
      from_ts       INTEGER,
      to_ts         INTEGER NOT NULL,
      reason        TEXT NOT NULL CHECK(reason IN (${inList(HISTORY_REASONS)})),
      ref           TEXT
    );
    CREATE TABLE IF NOT EXISTS room_line (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id     TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      kind        TEXT NOT NULL CHECK(kind IN (${inList(LINE_KINDS)})),
      author      TEXT NOT NULL,
      author_seat TEXT,
      target      TEXT,
      target_seat TEXT,
      thread      TEXT,
      body        TEXT CHECK(body IS NULL OR length(body) <= ${LINE_BODY_MAX}),
      ref         TEXT,
      meta        TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_room_seats_handle ON room_seats(room_id, handle) WHERE left_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_room_line_room ON room_line(room_id, id);
    CREATE INDEX IF NOT EXISTS idx_room_line_kind ON room_line(room_id, kind, id);
    CREATE INDEX IF NOT EXISTS idx_room_line_author_seat ON room_line(room_id, author_seat, id);
    CREATE INDEX IF NOT EXISTS idx_room_line_target_seat ON room_line(room_id, target_seat, id);
    CREATE INDEX IF NOT EXISTS idx_room_seats_occupant ON room_seats(occupant_kind, occupant) WHERE left_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_room_seats_position ON room_seats(room_id, position);
    CREATE INDEX IF NOT EXISTS idx_room_seat_history_seat ON room_seat_history(seat_id, to_ts);
    /* STARTER SEEDS (the design notes): the marker that a template was seeded, written in the SAME transaction as
       the template, so a crash leaves all of it or none of it. Never removed by a delete or archive: that is what stops a retry or a
       newer template version from recreating something the person removed. starter_recipes = the recipe ids the seed created (ownership
       is this row, never a name). */
    CREATE TABLE IF NOT EXISTS starter_seeds (
      template TEXT PRIMARY KEY,
      version  INTEGER NOT NULL,
      room_id  TEXT NOT NULL,
      ids_json TEXT NOT NULL,
      at       INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS starter_recipes (
      recipe_id TEXT PRIMARY KEY,
      at        INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_panels (
      id          TEXT PRIMARY KEY,
      room_id     TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'app' CHECK(kind IN (${inList(PANEL_KINDS)})),
      title       TEXT NOT NULL,
      url         TEXT NOT NULL,
      seat_id     TEXT,
      icon        TEXT,
      scripts     INTEGER NOT NULL DEFAULT 0 CHECK(scripts IN (0,1)),
      uploads     INTEGER NOT NULL DEFAULT 0 CHECK(uploads IN (0,1)),
      position    INTEGER NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_room_panels_room ON room_panels(room_id, position);
  `);
  /* Additive columns land here, each behind have.has(col), exactly like
     migratePrefColumns. */
  const panelCols = new Set((database.prepare(`PRAGMA table_info(room_panels)`).all() as { name: string }[]).map((c) => c.name));
  if (!panelCols.has('scripts')) {
    database.exec(`ALTER TABLE room_panels ADD COLUMN scripts INTEGER NOT NULL DEFAULT 0 CHECK(scripts IN (0,1))`);
  }
  if (!panelCols.has('uploads')) {
    database.exec(`ALTER TABLE room_panels ADD COLUMN uploads INTEGER NOT NULL DEFAULT 0 CHECK(uploads IN (0,1))`);
  }
  /* Room apps (the design notes §4.4, S4 engine half) [rooms/apps-engine]:
     a panel an APP added is linked to it, so removing the app removes exactly
     its panels. NULL for a panel registered directly (the pre-apps path, and
     the voice panel). */
  if (!panelCols.has('app_slug')) {
    database.exec(`ALTER TABLE room_panels ADD COLUMN app_slug TEXT`);
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_room_panels_app ON room_panels(room_id, app_slug)`);
  const roomCols = new Set((database.prepare(`PRAGMA table_info(rooms)`).all() as { name: string }[]).map((c) => c.name));
  if (!roomCols.has('asset_folder')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN asset_folder TEXT`);
  }
  if (!roomCols.has('color')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN color TEXT`);
  }
  if (!roomCols.has('feed_default')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN feed_default TEXT`);
  }
  /* Room voice settings: the room's OVERRIDES only, JSON (room-voice §10.1). */
  if (!roomCols.has('voice')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN voice TEXT`);
  }
  /* ROOM CHARACTER [rooms/character]: the art key. Additive; a room with
     none reads exactly as before. */
  if (!roomCols.has('art')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN art TEXT`);
  }
  /* ROOM ART MODEL + PALETTE OVERRIDE [hub-v2] (Owner 2026-10-05): the tiled
     art choice (JSON), this room's own palette and its Dark/Light. Additive;
     a room with none reads exactly as before. */
  if (!roomCols.has('art_tile')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN art_tile TEXT`);
  }
  if (!roomCols.has('wash_at')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN wash_at TEXT`);
  }
  if (!roomCols.has('bubble_glass')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN bubble_glass INTEGER`);
  }
  if (!roomCols.has('pal')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN pal TEXT`);
  }
  if (!roomCols.has('design_follow')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN design_follow INTEGER NOT NULL DEFAULT 1`);
  }
  if (!roomCols.has('pal_mode')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN pal_mode TEXT`);
  }
  /* WORKGROUPS (Owner 2026-10-04): the parent link and the address. Additive;
     a room with neither reads exactly as before. */
  if (!roomCols.has('parent_id')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN parent_id TEXT`);
  }
  if (!roomCols.has('alias')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN alias TEXT`);
  }
  /* ROOM BRIEF [room brief] (Owner 2026-10-05). Additive; a room with none reads as before. */
  if (!roomCols.has('brief')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN brief TEXT`);
  }
  if (!roomCols.has('brief_by')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN brief_by TEXT`);
  }
  if (!roomCols.has('brief_at')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN brief_at INTEGER`);
  }
  /* THE ROOM CODE FOLDER (step C). Additive; a room with none reads as before. */
  if (!roomCols.has('code_dir')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN code_dir TEXT`);
  }
  if (!roomCols.has('code_mode')) {
    database.exec(`ALTER TABLE rooms ADD COLUMN code_mode TEXT`);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_rooms_parent ON rooms(parent_id);
    /* CROSS-POSTS: the OTHER rooms a line appears in. room_line stays single-room
       (its room_id is where it was WRITTEN); this adds "also delivered to a
       seat in room X", with the handles it reached there. */
    CREATE TABLE IF NOT EXISTS room_line_xpost (
      line_id INTEGER NOT NULL,
      room_id TEXT NOT NULL,
      handles TEXT NOT NULL,
      PRIMARY KEY (line_id, room_id)
    );
    CREATE INDEX IF NOT EXISTS idx_room_line_xpost_room ON room_line_xpost(room_id, line_id);
    /* THE PERSON'S READ CURSOR per room: the badge counts what is newer. */
    CREATE TABLE IF NOT EXISTS room_user_reads (
      user_key         TEXT NOT NULL,
      room_id          TEXT NOT NULL,
      last_seen_line_id INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      PRIMARY KEY (user_key, room_id)
    );
  `);
  widenKindCheck(database, 'room_line', LINE_KINDS);
  widenKindCheck(database, 'room_panels', PANEL_KINDS);
  migrateFeedDefaultsToHidden(database);
  ensureVoiceTables(database);
  ensureAppTables(database);
  adoptWorkgroupApps(database); // [family apps] additive, idempotent, never deletes
  /* CONCIERGE SIGN-OFFS (the design notes): the person's approval of ONE Concierge act, single use, bound to verb + frozen targets + args.
     Logic in engine/concierge-signoff.ts; this table is only the record. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS concierge_signoff (
      id          TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      state       TEXT NOT NULL CHECK(state IN ('pending','approved','cancelled','expired','consumed')),
      verb        TEXT NOT NULL,
      targets     TEXT NOT NULL,
      args        TEXT NOT NULL,
      args_hash   TEXT NOT NULL,
      text        TEXT NOT NULL,
      answered_at INTEGER,
      answered_by TEXT,
      via         TEXT,
      consumed_at INTEGER,
      result      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_concierge_signoff_state ON concierge_signoff(state, created_at);
  `);
  /* Room assets [ticket]: the ENGINE's record of what came in through it (who,
     when, exact size and type). The files themselves live on agent-share; a
     file an agent dropped there directly has no row, and that is honest. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS room_assets (
      path      TEXT PRIMARY KEY,
      room_id   TEXT NOT NULL,
      name      TEXT NOT NULL,
      size      INTEGER NOT NULL,
      type      TEXT NOT NULL,
      added_by  TEXT NOT NULL,
      added_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_room_assets_room ON room_assets(room_id, added_at);
  `);
  /* "CAME FROM" [scratch seen] (UI 5870): the room line that brought the asset in (the
     "X added NAME" fact, or the attachment message). NULL for older rows. */
  const assetCols = new Set((database.prepare(`PRAGMA table_info(room_assets)`).all() as { name: string }[]).map((c) => c.name));
  if (!assetCols.has('line_id')) {
    database.exec(`ALTER TABLE room_assets ADD COLUMN line_id INTEGER`);
  }
  /* SCRATCHPAD IDS (row 10; the design notes section 4): a stable 12-hex `asset_id` (the compact ref `asset_<id>`) and the upload's `batch_id`
     (a drop or paste that spans several POSTs). Additive. The id is minted at UPLOAD and by this ONE-TIME BACKFILL at open, never on a read (two concurrent reads
     would race on the UNIQUE index). */
  if (!assetCols.has('asset_id')) {
    database.exec(`ALTER TABLE room_assets ADD COLUMN asset_id TEXT`);
  }
  if (!assetCols.has('batch_id')) {
    database.exec(`ALTER TABLE room_assets ADD COLUMN batch_id TEXT`);
  }
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_room_assets_asset_id ON room_assets(asset_id) WHERE asset_id IS NOT NULL`);
  {
    const need = database.prepare(`SELECT path FROM room_assets WHERE asset_id IS NULL`).all() as Array<{ path: string }>;
    const set = database.prepare(`UPDATE room_assets SET asset_id=? WHERE path=? AND asset_id IS NULL`);
    for (const r of need) {
      for (let tries = 0; tries < 5; tries++) {
        try {
          set.run(randomBytes(6).toString('hex'), r.path);
          break;
        } catch {
          /* a UNIQUE collision on a random 48-bit id: draw again */
        }
      }
    }
  }
  /* Room authorship v2: YOUR picture beside your lines in every room. Per
     USER (the identity user id, or 'user' for the shared-token cookie), never
     per room. Here, not in identity.db: a picture is a view preference, not a
     credential, and it must work in legacy mode where identity.db is never
     opened. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS room_user_prefs (
      user_key   TEXT PRIMARY KEY,
      picture    TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  /* HIDDEN ROOMS (for the CLI Manager): the rooms this person folded out of
     their list, as a JSON array of room ids. A view preference like the
     picture: nothing else reads it, and hiding a room changes nothing about it. */
  const prefCols = new Set((database.prepare(`PRAGMA table_info(room_user_prefs)`).all() as { name: string }[]).map((c) => c.name));
  if (!prefCols.has('hidden_rooms')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN hidden_rooms TEXT`);
  }
  /* YOUR @NAME (Owner 2026-09-28: "let's give the user an @ name too ... the
     setting should be in settings for app wide"): per PERSON, every room. NULL
     = the default (the account name, normalised; the route derives it). */
  if (!prefCols.has('handle')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN handle TEXT`);
  }
  /* BUBBLE DISPLAY [rooms/bubbles] (Owner 2026-09-28): how transparent and how
     blurred YOUR room bubbles are, per PERSON, every room. NULL = 0 (today's
     opaque look). A view preference like the picture: nothing else reads it. */
  if (!prefCols.has('bubble_transparency')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN bubble_transparency INTEGER`);
  }
  if (!prefCols.has('bubble_blur')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN bubble_blur INTEGER`);
  }
  /* ENTER SUBMITS (Owner 2026-10-04,): does Enter send in
     the room composer? Per PERSON. NULL = unset = today's behavior (desktop
     Enter sends, phone Enter is a new line); 0 = Enter is a new line everywhere
     and only Send (or Ctrl/Cmd+Enter) sends; 1 = Enter sends. */
  if (!prefCols.has('enter_submits')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN enter_submits INTEGER`);
  }
  /* VOICE GLOBALS (room-voice §10.1, v3.6): the person's voice settings for
     every room, as JSON overrides (only what they changed). NULL = defaults. */
  if (!prefCols.has('voice')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN voice TEXT`);
  }
  /* GLOBAL COLOR PALETTE + APP TITLE-BAR TONES (hub V2, Owner 2026-10-05): per
     PERSON, JSON. NULL = the defaults (the design system dark; each app's own tone). */
  if (!prefCols.has('palette')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN palette TEXT`);
  }
  if (!prefCols.has('tones')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN tones TEXT`);
  }
  /* AUTO ROOM COLOURS: {roomId: swatch 0-11}, per PERSON, JSON. NULL = none assigned yet. */
  if (!prefCols.has('room_colors')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN room_colors TEXT`);
  }
  /* LINE WASH, SPOT | EDGE [hub-v2] (Owner 2026-10-05, the design system b0f8099 sec 1.G): the
     person's two lightnesses per mode, JSON {dark:{spot,edge}, light:{spot,edge}}.
     NULL = the defaults. Its own ALTER, separate from the palette columns. */
  if (!prefCols.has('wash')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN wash TEXT`);
  }
  /* YOUR COLOR (Owner [ref], toolkit [ref]): the person's own identity color,
     #rrggbb, for their name and bubbles. Not the palette (that is the app's
     theme). NULL = not chosen. */
  if (!prefCols.has('color')) {
    database.exec(`ALTER TABLE room_user_prefs ADD COLUMN color TEXT`);
  }
  /* ROOM DRAFTS (Owner 2026-09-28: "whatever is typed into the room chat
     should survive a refresh"): the unsent composer text, per PERSON per
     ROOM. A cleared draft keeps its row with text '' so its updated_at still
     says WHEN it was cleared (a window's older unsaved copy must lose to it). */
  database.exec(`
    CREATE TABLE IF NOT EXISTS room_drafts (
      user_key   TEXT NOT NULL,
      room_id    TEXT NOT NULL,
      text       TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_key, room_id)
    );
  `);
  /* THE REPLY TARGET (room-reply-v1, 2026-09-28): the line entry the draft
     answers, so the composer's quote chip survives a refresh with the text.
     Additive and idempotent; NULL = not a reply. */
  const draftCols = new Set((database.prepare(`PRAGMA table_info(room_drafts)`).all() as { name: string }[]).map((c) => c.name));
  if (!draftCols.has('reply_to')) {
    database.exec(`ALTER TABLE room_drafts ADD COLUMN reply_to INTEGER`);
  }
  /* ROOM COMPOSER ATTACHMENTS [ticket]: the files a person attached to an
     unsent message, per PERSON per ROOM (the text draft's twin). The bytes
     live on the server under the engine's data dir (engine/room-scratch.ts),
     never on agent-share, until the message is SENT. `moved_path` is set once
     a file reached the room's assets during a send that then failed later, so
     the retry reuses that ref instead of uploading a duplicate. */
  database.exec(`
    CREATE TABLE IF NOT EXISTS room_scratch (
      id          TEXT PRIMARY KEY,
      user_key    TEXT NOT NULL,
      room_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      moved_path  TEXT,
      upload_key  TEXT,
      pos         REAL
    );
    CREATE INDEX IF NOT EXISTS idx_room_scratch_owner ON room_scratch(user_key, room_id, created_at);
  `);
  /* NOTES [ticket]: a draft file made from a room note carries {title, words}
     (JSON) so the sent line can say "note", never a hash filename. Additive. */
  if (!(database.prepare('PRAGMA table_info(room_scratch)').all() as { name: string }[]).some((c) => c.name === 'note')) {
    database.exec('ALTER TABLE room_scratch ADD COLUMN note TEXT');
  }
  if (!(database.prepare('PRAGMA table_info(room_scratch)').all() as { name: string }[]).some((c) => c.name === 'companion_of')) {
    database.exec('ALTER TABLE room_scratch ADD COLUMN companion_of TEXT');
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_room_scratch_companion ON room_scratch(companion_of) WHERE companion_of IS NOT NULL');

  /* ROOM NOTES [ticket]: transient text documents kept IN a room (per ROOM,
     not per person; created_by only records who made one). No title: the id
     is a random hash. keywords = JSON array computed at index time; dirty = 1
     from an autosave until the next index (close / attach / idle sweep). The
     FTS table is standalone and holds only INDEXED text; archived notes stay
     in it (archive is cosmetic). */
  database.exec(`
    CREATE TABLE IF NOT EXISTS room_notes (
      id         TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL,
      created_by TEXT,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pinned     INTEGER NOT NULL DEFAULT 0,
      archived   INTEGER NOT NULL DEFAULT 0,
      keywords   TEXT NOT NULL DEFAULT '[]',
      indexed_at INTEGER,
      dirty      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_room_notes_room ON room_notes(room_id, updated_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS room_notes_fts USING fts5(text, note_id UNINDEXED, room_id UNINDEXED);
    /* The distinct terms of each indexed note: df for the keyword ranking is a
       count here (a room's note terms are small; the FTS index is per token
       position and cannot say "in how many of THIS room's notes"). */
    CREATE TABLE IF NOT EXISTS room_note_terms (
      room_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      term    TEXT NOT NULL,
      PRIMARY KEY (room_id, term, note_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_room_note_terms_note ON room_note_terms(note_id);
    /* A SENT note: the text a message carried, immutable (a later edit of the
       note never changes what the message said). Agents read it by id. */
    CREATE TABLE IF NOT EXISTS room_notes_sent (
      id         TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL,
      note_id    TEXT,
      entry_id   INTEGER,
      text       TEXT NOT NULL,
      title      TEXT NOT NULL,
      words      INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_room_notes_sent_room ON room_notes_sent(room_id, created_at);
    /* SEAT WELCOMES [room welcome, Owner 2026-10-05]: which (seat, pane, room) has
       been told how to answer, so a restart never repeats it; a move changes the
       room and so sends again. chat_notes: panes already given the direct-chat note. */
    CREATE TABLE IF NOT EXISTS seat_welcomes (
      seat_id TEXT NOT NULL,
      paneid  TEXT NOT NULL,
      room_id TEXT NOT NULL,
      at      INTEGER NOT NULL,
      PRIMARY KEY (seat_id, paneid, room_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS chat_notes (
      paneid TEXT PRIMARY KEY,
      at     INTEGER NOT NULL
    ) WITHOUT ROWID;
  `);
}

/**
 * A `kind` CHECK cannot be ALTERed, so a kind list that grew (room-voice
 * §10.2: `voice`) REBUILDS the table, the SQLite way, in ONE transaction:
 * create a copy from the table's own stored SQL with only the CHECK list
 * swapped (so columns added by ALTER keep their order and SELECT * lines up),
 * copy every row WITH its id, drop, rename, recreate its indexes and triggers,
 * and keep the AUTOINCREMENT high-water mark (a deleted top id is never
 * reissued, so a `vid` stays unique). Idempotent: a table whose SQL already
 * carries the exact list is left alone. No table REFERENCES these two and no
 * view or trigger names them (checked on the live db 2026-09-28), so the
 * rename needs neither foreign_keys off nor legacy_alter_table.
 */
/* Assumes ONE `CHECK(kind IN (...))` per table: the regex takes the first. */
const KIND_CHECK_RE = /CHECK\(kind IN \([^)]*\)\)/;
function widenKindCheck(database: Database.Database, table: string, kinds: readonly string[]): void {
  const want = `CHECK(kind IN (${inList(kinds)}))`;
  const row = database.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { sql: string } | undefined;
  if (!row || row.sql.includes(want) || !KIND_CHECK_RE.test(row.sql)) {
    return;
  }
  const tmp = `${table}__rebuild`;
  const createSql = row.sql.replace(/^CREATE TABLE\s+("?)\w+\1/, `CREATE TABLE ${tmp}`).replace(KIND_CHECK_RE, want);
  const extras = (
    database.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL`).all(table) as { sql: string }[]
  ).map((r) => r.sql);
  const hasSeq = !!database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`).get();
  database.transaction(() => {
    const seq = hasSeq ? (database.prepare(`SELECT seq FROM sqlite_sequence WHERE name=?`).get(table) as { seq: number } | undefined) : undefined;
    database.exec(createSql);
    database.exec(`INSERT INTO ${tmp} SELECT * FROM ${table}`);
    database.exec(`DROP TABLE ${table}`);
    database.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
    for (const sql of extras) {
      database.exec(sql);
    }
    if (seq) {
      const now = database.prepare(`SELECT seq FROM sqlite_sequence WHERE name=?`).get(table) as { seq: number } | undefined;
      if (!now) {
        database.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(table, seq.seq);
      } else if (now.seq < seq.seq) {
        database.prepare(`UPDATE sqlite_sequence SET seq=? WHERE name=?`).run(seq.seq, table);
      }
    }
  })();
}

/* The kinds a feed saved BEFORE the hidden-kinds switch could have shown: the
   list as it stood then, NOT LINE_KINDS. Against LINE_KINDS a kind born with
   the switch (`voice`) would be recorded as hidden in every saved feed. */
const FEED_KINDS_BEFORE_HIDDEN: readonly string[] = ['chat', 'fact', 'delivery', 'attachment', 'command'];

/** Saved feeds `{kinds, who}` (shown) → `{hidden, who}`, once. Idempotent: a
 *  row already carrying `hidden` is skipped; an unparseable one is left as is
 *  (it reads as unset, exactly as before). */
function migrateFeedDefaultsToHidden(database: Database.Database): void {
  const rows = database.prepare(`SELECT id, feed_default FROM rooms WHERE feed_default IS NOT NULL`).all() as { id: string; feed_default: string }[];
  const set = database.prepare(`UPDATE rooms SET feed_default=? WHERE id=?`);
  database.transaction(() => {
    for (const r of rows) {
      let v: { kinds?: unknown; hidden?: unknown; who?: unknown };
      try {
        v = JSON.parse(r.feed_default);
      } catch {
        continue;
      }
      if (!v || typeof v !== 'object' || Array.isArray(v.hidden) || !Array.isArray(v.kinds)) {
        continue;
      }
      const shown = new Set(v.kinds);
      set.run(JSON.stringify({ hidden: FEED_KINDS_BEFORE_HIDDEN.filter((k) => !shown.has(k)), who: typeof v.who === 'string' ? v.who : '' }), r.id);
    }
  })();
}

/** A person's hidden rooms: ids still naming a room (a stale id is dropped on
 *  read, never an error). */
export function getHiddenRooms(userKey: string): string[] {
  const row = rdb().prepare('SELECT hidden_rooms FROM room_user_prefs WHERE user_key = ?').get(userKey) as { hidden_rooms: string | null } | undefined;
  if (!row?.hidden_rooms) {
    return [];
  }
  let ids: unknown;
  try {
    ids = JSON.parse(row.hidden_rooms);
  } catch {
    return [];
  }
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!getRoom(id)) : [];
}

export const HIDDEN_ROOMS_MAX = 500;
/** Validate a hiddenRooms value WITHOUT writing: an array of existing room
 *  ids, deduped in order. Throws RoomError naming 'hiddenRooms'. */
export function checkHiddenRooms(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    throw new RoomError(400, 'hiddenRooms is an array of room ids', 'hiddenRooms');
  }
  const out = [...new Set(ids)];
  if (out.length > HIDDEN_ROOMS_MAX) {
    throw new RoomError(413, `hiddenRooms has ${out.length} rooms; the limit is ${HIDDEN_ROOMS_MAX}`, 'hiddenRooms');
  }
  for (const id of out) {
    if (typeof id !== 'string' || !getRoom(id)) {
      throw new RoomError(400, `hiddenRooms: ${JSON.stringify(id)} is not a room`, 'hiddenRooms');
    }
  }
  return out as string[];
}

/** Replace a person's hidden rooms (validated by checkHiddenRooms). */
export function setHiddenRooms(userKey: string, ids: unknown): string[] {
  const list = checkHiddenRooms(ids);
  rdb()
    .prepare(
      `INSERT INTO room_user_prefs (user_key, hidden_rooms, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET hidden_rooms = excluded.hidden_rooms, updated_at = excluded.updated_at`,
    )
    .run(userKey, JSON.stringify(list), Date.now());
  return list;
}

/** A person's STORED @name, or null (= the default the route derives). */
export function getUserHandle(userKey: string): string | null {
  const row = rdb().prepare('SELECT handle FROM room_user_prefs WHERE user_key = ?').get(userKey) as { handle: string | null } | undefined;
  return row?.handle ?? null;
}

/** The DEFAULT @name for an account name: lowercased and normalised to the
 *  handle grammar; 'me' when there is no name, or it normalises to nothing or
 *  to a reserved word (a default is never refused, so it must be legal). */
export function defaultUserHandle(name: string | null | undefined): string {
  const h = normalizeSlug(name ?? '');
  return h && isSlug(h) && !RESERVED_HANDLES.includes(h) ? h : 'me';
}

/** Validate a typed @name WITHOUT writing. One leading '@' and case are
 *  normalised (one right answer); anything else off the grammar is refused,
 *  never coerced. Refused: a reserved word, or the handle of any ACTIVE seat
 *  in any room (the line would not know who "@x" meant). null = the default.
 *  Throws RoomError naming 'handle'. */
export function checkUserHandle(raw: unknown): string | null {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new RoomError(400, 'handle is your @name (a string), or null for the default', 'handle');
  }
  const h = raw.trim().replace(/^@/, '').toLowerCase();
  if (!isSlug(h)) {
    throw new RoomError(400, 'an @name is lowercase letters, digits and single hyphens, up to 64', 'handle');
  }
  if (RESERVED_HANDLES.includes(h)) {
    throw new RoomError(400, `@${h} is reserved`, 'handle');
  }
  const seat = rdb()
    .prepare(
      `SELECT r.name AS room FROM room_seats s JOIN rooms r ON r.id = s.room_id
       WHERE s.handle = ? AND s.left_at IS NULL LIMIT 1`,
    )
    .get(h) as { room: string } | undefined;
  if (seat) {
    throw new RoomError(409, `@${h} is a seat in the room "${seat.room}"`, 'handle');
  }
  return h;
}

/** Set (validated by checkUserHandle) or clear (null) a person's @name. */
export function setUserHandle(userKey: string, raw: unknown): string | null {
  const h = checkUserHandle(raw);
  rdb()
    .prepare(
      `INSERT INTO room_user_prefs (user_key, handle, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at`,
    )
    .run(userKey, h, Date.now());
  return h;
}

/* ---- BUBBLE DISPLAY [rooms/bubbles]: per person, every room ---- */
export const BUBBLE_TRANSPARENCY_MAX = 60; // percent transparent
export const BUBBLE_BLUR_MAX = 16; // px
export interface BubbleDisplay {
  bubbleTransparency: number;
  bubbleBlur: number;
}

/** A person's bubble display; 0 / 0 (opaque, no blur) until set. */
export function getBubbleDisplay(userKey: string): BubbleDisplay {
  const row = rdb().prepare('SELECT bubble_transparency, bubble_blur FROM room_user_prefs WHERE user_key = ?').get(userKey) as
    | { bubble_transparency: number | null; bubble_blur: number | null }
    | undefined;
  return { bubbleTransparency: row?.bubble_transparency ?? 0, bubbleBlur: row?.bubble_blur ?? 0 };
}

/** Validate one bubble display value WITHOUT writing: an integer in 0..max.
 *  Refused, never clamped: a value off the slider is a caller bug to name.
 *  Throws RoomError naming the field. */
export function checkBubbleValue(field: 'bubbleTransparency' | 'bubbleBlur', raw: unknown): number {
  const max = field === 'bubbleTransparency' ? BUBBLE_TRANSPARENCY_MAX : BUBBLE_BLUR_MAX;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > max) {
    throw new RoomError(400, `${field} is a whole number from 0 to ${max}`, field);
  }
  return raw;
}

/** Set one or both (each validated first; nothing is written if either is bad). */
export function setBubbleDisplay(userKey: string, patch: { bubbleTransparency?: unknown; bubbleBlur?: unknown }): BubbleDisplay {
  const t = patch.bubbleTransparency !== undefined ? checkBubbleValue('bubbleTransparency', patch.bubbleTransparency) : null;
  const b = patch.bubbleBlur !== undefined ? checkBubbleValue('bubbleBlur', patch.bubbleBlur) : null;
  const now = Date.now();
  if (t !== null) {
    rdb()
      .prepare(
        `INSERT INTO room_user_prefs (user_key, bubble_transparency, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_key) DO UPDATE SET bubble_transparency = excluded.bubble_transparency, updated_at = excluded.updated_at`,
      )
      .run(userKey, t, now);
  }
  if (b !== null) {
    rdb()
      .prepare(
        `INSERT INTO room_user_prefs (user_key, bubble_blur, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_key) DO UPDATE SET bubble_blur = excluded.bubble_blur, updated_at = excluded.updated_at`,
      )
      .run(userKey, b, now);
  }
  return getBubbleDisplay(userKey);
}

/* ---- LINE WASH, SPOT | EDGE [hub-v2]: per person, per mode ---- */
/* The stops (the design system sec 1.G): L(p) = left + (right - left) * p over the track, and
   a handle will not go past its stop. dark: spot <= L .40, edge >= L .10;
   light: spot >= L .74 (no right stop; the design system sec 1.G dc48334, was .86). */
export const WASH_TRACK = {
  dark: { s: 0.3, e: 0.16, l: 0.46, r: 0.08, spotMax: 0.4, edgeMin: 0.1 },
  light: { s: 0.925, e: 0.975, l: 0.66, r: 1, spotMin: 0.74 },
} as const;
export interface WashSE {
  spot: number;
  edge: number;
}
export type WashPrefs = { dark: WashSE; light: WashSE };

/** The defaults: dark equals the shipped hwb-watermark.css (.30 / .16). */
export function defaultWash(): WashPrefs {
  return {
    dark: { spot: WASH_TRACK.dark.s, edge: WASH_TRACK.dark.e },
    light: { spot: WASH_TRACK.light.s, edge: WASH_TRACK.light.e },
  };
}

/** A person's stored wash over the defaults; a bad row reads as the defaults. */
export function getWash(userKey: string): WashPrefs {
  const out = defaultWash();
  const row = rdb().prepare('SELECT wash FROM room_user_prefs WHERE user_key = ?').get(userKey) as { wash: string | null } | undefined;
  try {
    const v = row?.wash ? JSON.parse(row.wash) : null;
    for (const m of ['dark', 'light'] as const) {
      const s = v?.[m]?.spot;
      const e = v?.[m]?.edge;
      if (typeof s === 'number' && typeof e === 'number' && Number.isFinite(s) && Number.isFinite(e)) {
        out[m] = { spot: s, edge: e };
      }
    }
  } catch {
    /* defaults */
  }
  return out;
}

/** Validate a wash patch: {dark?:{spot,edge}, light?:{spot,edge}} or null (back to
 *  the defaults). Numbers are CLAMPED to the track and its stop, and the handles
 *  cannot cross (edge is darker than, or equal to, spot in dark; the mirror in
 *  light): a value off the track means "as far as it goes", which we can honour.
 *  A non-number or an unknown key is a 400 naming `wash.<mode>.<key>`. */
export function checkWash(raw: unknown): WashPrefs | null {
  if (raw === null) {
    return null;
  }
  const bad = (why: string, field: string): never => {
    throw new RoomError(400, `${field}: ${why}`, field);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    bad('an object {dark?:{spot,edge}, light?:{spot,edge}} or null', 'wash');
  }
  const o = raw as Record<string, unknown>;
  const x = Object.keys(o).find((k) => k !== 'dark' && k !== 'light');
  if (x !== undefined) {
    bad('unknown mode (dark or light)', `wash.${x.slice(0, 40)}`);
  }
  const cur = defaultWash(); // the caller merges the result over the stored value
  for (const m of ['dark', 'light'] as const) {
    if (o[m] === undefined) {
      continue;
    }
    const v = o[m] as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      bad('an object {spot, edge}', `wash.${m}`);
    }
    const y = Object.keys(v as object).find((k) => k !== 'spot' && k !== 'edge');
    if (y !== undefined) {
      bad('unknown key', `wash.${m}.${y.slice(0, 40)}`);
    }
    const t = WASH_TRACK[m];
    const num = (k: 'spot' | 'edge'): number => {
      const n = (v as Record<string, unknown>)[k];
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        bad('a number (a lightness, 0 to 1)', `wash.${m}.${k}`);
      }
      return n as number;
    };
    const lo = Math.min(t.l, t.r);
    const hi = Math.max(t.l, t.r);
    let spot = Math.max(lo, Math.min(hi, num('spot')));
    let edge = Math.max(lo, Math.min(hi, num('edge')));
    if (m === 'dark') {
      spot = Math.min(spot, WASH_TRACK.dark.spotMax);
      edge = Math.max(edge, WASH_TRACK.dark.edgeMin);
      edge = Math.min(edge, spot); // dark: the edge is the darker end
    } else {
      spot = Math.max(spot, WASH_TRACK.light.spotMin);
      edge = Math.max(edge, spot); // light: the edge is the paler end
    }
    cur[m] = { spot: +spot.toFixed(3), edge: +edge.toFixed(3) };
  }
  return cur;
}

/** Store a validated patch: merged over what the person has, per mode. */
export function setWash(userKey: string, patch: WashPrefs | null, raw: unknown): WashPrefs {
  let next: WashPrefs | null = null;
  if (patch) {
    next = getWash(userKey);
    for (const m of ['dark', 'light'] as const) {
      if ((raw as Record<string, unknown>)[m] !== undefined) {
        next[m] = patch[m];
      }
    }
  }
  rdb()
    .prepare(
      `INSERT INTO room_user_prefs (user_key, wash, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET wash = excluded.wash, updated_at = excluded.updated_at`,
    )
    .run(userKey, next ? JSON.stringify(next) : null, Date.now());
  return getWash(userKey);
}

/* ---- ENTER SUBMITS (Owner 2026-10-04,): per person ---- */
/** true / false once chosen; null = never set (the composer keeps today's behavior). */
export function getEnterSubmits(userKey: string): boolean | null {
  const row = rdb().prepare('SELECT enter_submits FROM room_user_prefs WHERE user_key = ?').get(userKey) as { enter_submits: number | null } | undefined;
  return row?.enter_submits == null ? null : row.enter_submits === 1;
}

/** A boolean, else 400 naming the field (never coerced). */
export function checkEnterSubmits(raw: unknown): boolean {
  if (typeof raw !== 'boolean') {
    throw new RoomError(400, 'enterSubmits is true or false', 'enterSubmits');
  }
  return raw;
}

export function setEnterSubmits(userKey: string, raw: unknown): boolean {
  const v = checkEnterSubmits(raw);
  rdb()
    .prepare(
      `INSERT INTO room_user_prefs (user_key, enter_submits, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET enter_submits = excluded.enter_submits, updated_at = excluded.updated_at`,
    )
    .run(userKey, v ? 1 : 0, Date.now());
  return v;
}

/* ---- GLOBAL COLOR PALETTE + APP TITLE-BAR TONES (hub V2): per person ---- */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The person's palette; the design system dark until chosen. */
export function getUserPalette(userKey: string): PalettePref {
  const row = rdb().prepare('SELECT palette FROM room_user_prefs WHERE user_key = ?').get(userKey) as { palette: string | null } | undefined;
  return parseJson<PalettePref>(row?.palette, DEFAULT_PALETTE);
}

/** Validate a `palette` patch WITHOUT writing (null = back to the default).
 *  A patch without `custom` keeps the stored custom set (switching palettes
 *  must not lose the person's own colors); key 'custom' needs one. */
export function checkUserPalette(userKey: string, raw: unknown): PalettePref {
  try {
    if (raw === null) {
      return DEFAULT_PALETTE;
    }
    const v = validPalette(raw);
    if (!v.custom) {
      const old = getUserPalette(userKey).custom;
      if (old) {
        v.custom = old;
      } else if (v.key === 'custom') {
        throw new PaletteError('palette.custom is required when palette.key is custom', 'palette.custom');
      }
    }
    return v;
  } catch (e) {
    throw e instanceof PaletteError ? new RoomError(400, e.message, e.field) : e;
  }
}

export function setUserPalette(userKey: string, raw: unknown): PalettePref {
  const v = checkUserPalette(userKey, raw);
  const json = raw === null ? null : JSON.stringify(v);
  rdb()
    .prepare(
      `INSERT INTO room_user_prefs (user_key, palette, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET palette = excluded.palette, updated_at = excluded.updated_at`,
    )
    .run(userKey, json, Date.now());
  return getUserPalette(userKey);
}

/** The person's stored title-bar tones ({app: tone}); {} = every app default. */
export function getUserTones(userKey: string): TonePrefs {
  const row = rdb().prepare('SELECT tones FROM room_user_prefs WHERE user_key = ?').get(userKey) as { tones: string | null } | undefined;
  return parseJson<TonePrefs>(row?.tones, {});
}

export function checkUserTones(raw: unknown): Record<string, string | null> {
  try {
    return validTonesPatch(raw);
  } catch (e) {
    throw e instanceof PaletteError ? new RoomError(400, e.message, e.field) : e;
  }
}

/** Per-key merge; a null tone removes that app's override. */
export function setUserTones(userKey: string, raw: unknown): TonePrefs {
  const patch = checkUserTones(raw);
  const next: TonePrefs = { ...getUserTones(userKey) };
  for (const [app, tone] of Object.entries(patch)) {
    if (tone === null) {
      delete next[app];
    } else {
      next[app] = tone;
    }
  }
  rdb()
    .prepare(
      `INSERT INTO room_user_prefs (user_key, tones, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET tones = excluded.tones, updated_at = excluded.updated_at`,
    )
    .run(userKey, Object.keys(next).length ? JSON.stringify(next) : null, Date.now());
  return next;
}

/** The active seat a pane occupies, for the causes feed: {handle, room_id}, or undefined. */
export function seatOfPane(paneid: string): { handle: string; room_id: string } | undefined {
  return rdb().prepare(`SELECT handle, room_id FROM room_seats WHERE left_at IS NULL AND occupant_kind='pane' AND occupant=? ORDER BY id LIMIT 1`).get(paneid) as
    | { handle: string; room_id: string }
    | undefined;
}

/** The person's remembered auto room colours ({roomId: swatch index}); {} = none yet. */
export function getUserRoomColors(userKey: string): RoomColorPrefs {
  const row = rdb().prepare('SELECT room_colors FROM room_user_prefs WHERE user_key = ?').get(userKey) as { room_colors: string | null } | undefined;
  return parseJson<RoomColorPrefs>(row?.room_colors, {});
}

export function checkUserRoomColors(raw: unknown): Record<string, number | null> {
  try {
    return validRoomColorsPatch(raw);
  } catch (e) {
    throw e instanceof PaletteError ? new RoomError(400, e.message, e.field) : e;
  }
}

/** Per-key merge; null forgets a room. More than ROOM_COLORS_MAX rooms after the merge is a 400 and nothing is written. */
export function setUserRoomColors(userKey: string, raw: unknown): RoomColorPrefs {
  const patch = checkUserRoomColors(raw);
  const next: RoomColorPrefs = { ...getUserRoomColors(userKey) };
  for (const [room, v] of Object.entries(patch)) {
    if (v === null) {
      delete next[room];
    } else {
      next[room] = v;
    }
  }
  if (Object.keys(next).length > ROOM_COLORS_MAX) {
    throw new RoomError(400, `roomColors remembers at most ${ROOM_COLORS_MAX} rooms`, 'roomColors');
  }
  rdb()
    .prepare(
      `INSERT INTO room_user_prefs (user_key, room_colors, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET room_colors = excluded.room_colors, updated_at = excluded.updated_at`,
    )
    .run(userKey, Object.keys(next).length ? JSON.stringify(next) : null, Date.now());
  return next;
}

/* ---- YOUR COLOR (Owner [ref]): per person, every room ---- */
/** The person's own color, #rrggbb lower-case, or null when not chosen. */
export function getUserColor(userKey: string): string | null {
  const row = rdb().prepare('SELECT color FROM room_user_prefs WHERE user_key = ?').get(userKey) as { color: string | null } | undefined;
  return row?.color ?? null;
}

/** #rrggbb (any case, normalised to lower case) or null to clear; anything else is a 400 naming `color`. */
export function checkUserColor(raw: unknown): string | null {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw.trim())) {
    throw new RoomError(400, 'color is a #rrggbb hex color, or null to clear it', 'color');
  }
  return raw.trim().toLowerCase();
}

export function setUserColor(userKey: string, raw: unknown): string | null {
  const color = checkUserColor(raw);
  rdb()
    .prepare(
      `INSERT INTO room_user_prefs (user_key, color, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at`,
    )
    .run(userKey, color, Date.now());
  return color;
}

/* ---- VOICE GLOBALS (room-voice§10.1, v3.6): per person, every room ---- */
function userVoiceOverrides(d: Database.Database, userKey: string): RoomVoiceOverrides {
  const row = d.prepare('SELECT voice FROM room_user_prefs WHERE user_key = ?').get(userKey) as { voice: string | null } | undefined;
  return voiceOverrides(row?.voice);
}

/** A person's voice globals, fully populated (defaults < config < theirs). */
export function getUserVoice(userKey: string): VoiceGlobals {
  return pickVoice(mergeVoice(voiceDefaults(), userVoiceOverrides(rdb(), userKey)), 'global');
}

/** Validate a `voice` patch WITHOUT writing. Throws RoomError 400 naming
 *  `voice.<key>`. */
export function checkUserVoice(raw: unknown): RoomVoiceOverrides {
  try {
    return validVoicePatch(raw, 'global');
  } catch (e) {
    throw e instanceof VoiceSettingsError ? new RoomError(400, e.message, e.field) : e;
  }
}

/** Per-key merge into the person's stored overrides; `changed` = the stored
 *  set moved. */
export function setUserVoice(userKey: string, raw: unknown): { voice: VoiceGlobals; changed: boolean } {
  const set = checkUserVoice(raw);
  const d = rdb();
  const old = userVoiceOverrides(d, userKey);
  const next = layerOverrides(old, set);
  const json = Object.keys(next).length ? JSON.stringify(next) : null;
  const changed = json !== (Object.keys(old).length ? JSON.stringify(old) : null);
  if (changed) {
    d.prepare(
      `INSERT INTO room_user_prefs (user_key, voice, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET voice = excluded.voice, updated_at = excluded.updated_at`,
    ).run(userKey, json, Date.now());
  }
  return { voice: getUserVoice(userKey), changed };
}

/**
 * ONE-TIME MIGRATION (room-voice v3.6), idempotent, at boot after the ALTERs.
 * If NO person has stored voice globals yet, the owner's are seeded from the
 * global keys stored on the room named "Voice Interaction", else on the room
 * with the most recent voice connection. Then the global keys are stripped
 * from every room's stored rooms.voice (a room reads only its four now).
 * `enabled` is a room key too: it is neither copied nor stripped (a room
 * switched off must not switch voice off everywhere). Null = nothing to do.
 */
export function migrateVoiceGlobals(ownerKey: string): { seeded: { room: string; keys: RoomVoiceOverrides } | null; stripped: string[] } | null {
  const d = rdb();
  const only = VOICE_GLOBAL_KEYS.filter((k) => k !== 'enabled') as string[];
  return d.transaction(() => {
    let seeded: { room: string; keys: RoomVoiceOverrides } | null = null;
    if (!d.prepare('SELECT 1 FROM room_user_prefs WHERE voice IS NOT NULL LIMIT 1').get()) {
      const src = (d.prepare(`SELECT id, voice FROM rooms WHERE name = 'Voice Interaction' ORDER BY state = 'open' DESC, updated_at DESC LIMIT 1`).get() ??
        d.prepare(
          `SELECT r.id, r.voice FROM rooms r JOIN (
             SELECT room_id, opened_at AS ts FROM voice_connections
             UNION ALL SELECT room_id, utterance_ts AS ts FROM voice_events
           ) c ON c.room_id = r.id GROUP BY r.id ORDER BY MAX(c.ts) DESC LIMIT 1`,
        ).get()) as { id: string; voice: string | null } | undefined;
      const keys = Object.fromEntries(Object.entries(voiceOverrides(src?.voice)).filter(([k]) => only.includes(k))) as RoomVoiceOverrides;
      if (src && Object.keys(keys).length) {
        d.prepare(
          `INSERT INTO room_user_prefs (user_key, voice, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(user_key) DO UPDATE SET voice = excluded.voice, updated_at = excluded.updated_at`,
        ).run(ownerKey, JSON.stringify(keys), Date.now());
        seeded = { room: src.id, keys };
      }
    }
    const stripped: string[] = [];
    for (const r of d.prepare('SELECT id, voice FROM rooms WHERE voice IS NOT NULL').all() as { id: string; voice: string }[]) {
      const old = voiceOverrides(r.voice);
      const keep = Object.fromEntries(Object.entries(old).filter(([k]) => !only.includes(k)));
      if (Object.keys(keep).length !== Object.keys(old).length) {
        d.prepare('UPDATE rooms SET voice = ? WHERE id = ?').run(Object.keys(keep).length ? JSON.stringify(keep) : null, r.id);
        stripped.push(r.id);
      }
    }
    return seeded || stripped.length ? { seeded, stripped } : null;
  })();
}

export interface RoomDraft {
  text: string;
  /** When it was last written or cleared; null = never. */
  updatedAt: number | null;
  /** The line entry this draft replies to (room-reply-v1); null = none. */
  replyTo: number | null;
}

export function getRoomDraft(userKey: string, roomId: string): RoomDraft {
  const row = rdb().prepare('SELECT text, updated_at, reply_to FROM room_drafts WHERE user_key = ? AND room_id = ?').get(userKey, roomId) as
    | { text: string; updated_at: number; reply_to: number | null }
    | undefined;
  return row ? { text: row.text, updatedAt: row.updated_at, replyTo: row.reply_to ?? null } : { text: '', updatedAt: null, replyTo: null };
}

/** Write (or, with '', clear) a person's draft in a room. Capped at
 *  DRAFT_BODY_MAX (ticket) — higher than the line's own LINE_BODY_MAX, so a
 *  draft that is over the SEND limit still saves; it just cannot send until
 *  it is back under LINE_BODY_MAX (the line endpoint's own refusal). Over
 *  DRAFT_BODY_MAX is refused with both numbers (413), never truncated.
 *  Throws RoomError and writes nothing. `replyTo`: undefined keeps the
 *  stored reply target, null clears it, an id sets it (the caller has
 *  checked it is an entry of this room). */
export function setRoomDraft(userKey: string, roomId: string, text: unknown, replyTo?: number | null): RoomDraft {
  if (typeof text !== 'string') {
    throw new RoomError(400, "text is the draft (a string; '' clears it)", 'text');
  }
  if (text.length > DRAFT_BODY_MAX) {
    throw new RoomError(413, `the draft is ${text.length} characters; the draft limit is ${DRAFT_BODY_MAX} (a send is capped at ${LINE_BODY_MAX})`, 'text');
  }
  if (replyTo !== undefined && replyTo !== null && !Number.isInteger(replyTo)) {
    throw new RoomError(400, 'reply_to is a line entry id', 'reply_to');
  }
  const now = Date.now();
  const d = rdb();
  d.prepare(
    `INSERT INTO room_drafts (user_key, room_id, text, updated_at, reply_to) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_key, room_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at` +
      (replyTo === undefined ? '' : ', reply_to = excluded.reply_to'),
  ).run(userKey, roomId, text, now, replyTo ?? null);
  const kept = d.prepare('SELECT reply_to FROM room_drafts WHERE user_key = ? AND room_id = ?').get(userKey, roomId) as { reply_to: number | null };
  return { text, updatedAt: now, replyTo: kept.reply_to ?? null };
}

/* ---- the attachment scratchpad [ticket]: rows only; the bytes are
   engine/room-scratch.ts's. Every read is scoped to (person, room): a row is
   never found by id alone, so another person's file is simply not there. ---- */

export interface RoomScratchFile {
  id: string;
  user_key: string;
  room_id: string;
  name: string;
  type: string;
  size: number;
  created_at: number;
  moved_path: string | null;
  /** The page's random name for the upload (x-upload-key), or null. */
  upload_key: string | null;
  /** Where the person put it in the tray (x-upload-pos: the page's clock when
   *  it was picked). Uploads run at once and LAND in completion order, so
   *  arrival order is not the tray's order. Null = arrival order. */
  pos: number | null;
  /** JSON {title, words} when the file is a room note's snapshot, else null. */
  note: string | null;
  companion_of: string | null;
}

export function listRoomScratch(userKey: string, roomId: string): RoomScratchFile[] {
  return rdb()
    .prepare('SELECT * FROM room_scratch WHERE user_key = ? AND room_id = ? ORDER BY COALESCE(pos, created_at), created_at, rowid')
    .all(userKey, roomId) as RoomScratchFile[];
}

/** THE TRAY'S ORDER, set by hand (Owner 2026-10-04, room: drag a tile to reorder). `ids` is the new
 *  order of the files it names; they take, in that order, the SORT SLOTS those same files held
 *  (COALESCE(pos, created_at)), so a file not named (an upload that landed after the page last
 *  listed) keeps its place relative to them. Unknown ids are ignored; the same order again is a
 *  no-op. Slots are kept strictly increasing so equal keys cannot hide a move. Returns the draft's
 *  full order. */
export function setRoomScratchOrder(userKey: string, roomId: string, ids: string[]): string[] {
  const d = rdb();
  return d.transaction(() => {
    const rows = listRoomScratch(userKey, roomId);
    const named = [...new Set(ids)].filter((id) => rows.some((r) => r.id === id));
    const slots = named.map((id) => {
      const r = rows.find((x) => x.id === id) as RoomScratchFile;
      return r.pos ?? r.created_at;
    }).sort((a, b) => a - b);
    for (let i = 1; i < slots.length; i++) {
      slots[i] = Math.max(slots[i], slots[i - 1] + 0.001);
    }
    const up = d.prepare('UPDATE room_scratch SET pos = ? WHERE id = ? AND user_key = ? AND room_id = ?');
    named.forEach((id, i) => up.run(slots[i], id, userKey, roomId));
    return listRoomScratch(userKey, roomId).map((r) => r.id);
  })();
}

export function getRoomScratch(userKey: string, roomId: string, id: string): RoomScratchFile | undefined {
  return rdb().prepare('SELECT * FROM room_scratch WHERE id = ? AND user_key = ? AND room_id = ?').get(id, userKey, roomId) as
    | RoomScratchFile
    | undefined;
}

/** Add one row, refusing past `maxCount` files in this person's draft for this
 *  room (413 with both numbers; the count and the insert are one transaction). */
export function getRoomScratchByUploadKey(userKey: string, roomId: string, uploadKey: string): RoomScratchFile | undefined {
  return rdb().prepare('SELECT * FROM room_scratch WHERE upload_key = ? AND user_key = ? AND room_id = ?').get(uploadKey, userKey, roomId) as
    | RoomScratchFile
    | undefined;
}

export function addRoomScratch(
  input: { id: string; userKey: string; roomId: string; name: string; type: string; size: number; uploadKey?: string | null; pos?: number | null; companionOf?: string | null },
  maxCount: number,
): RoomScratchFile {
  const d = rdb();
  return d.transaction(() => {
    const n = (d.prepare('SELECT COUNT(*) AS n FROM room_scratch WHERE user_key = ? AND room_id = ? AND companion_of IS NULL').get(input.userKey, input.roomId) as { n: number }).n;
    if (!input.companionOf && n >= maxCount) {
      throw new RoomError(413, `the draft holds ${n} files; the limit is ${maxCount} per message`, 'count');
    }
    if (input.companionOf) {
      const parent = getRoomScratch(input.userKey, input.roomId, input.companionOf);
      if (!parent || parent.companion_of || !parent.type.startsWith('image/') || parent.moved_path || input.name !== `${parent.name}.annotations.svg`) {
        throw new RoomError(400, 'companion-invalid', 'companionOf');
      }
      if (listRoomScratch(input.userKey, input.roomId).some(f => f.companion_of === parent.id)) throw new RoomError(409, 'companion-exists', 'companionOf');
    }
    const now = Date.now();
    d.prepare('INSERT INTO room_scratch (id, user_key, room_id, name, type, size, created_at, upload_key, pos, companion_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      input.id,
      input.userKey,
      input.roomId,
      input.name,
      input.type,
      input.size,
      now,
      input.uploadKey ?? null,
      input.pos ?? null,
      input.companionOf ?? null,
    );
    return d.prepare('SELECT * FROM room_scratch WHERE id = ?').get(input.id) as RoomScratchFile;
  })();
}

export function countRoomScratch(userKey: string, roomId: string): number {
  return (rdb().prepare('SELECT COUNT(*) AS n FROM room_scratch WHERE user_key = ? AND room_id = ? AND companion_of IS NULL').get(userKey, roomId) as { n: number }).n;
}

export function setRoomScratchSize(id: string, size: number): void {
  rdb().prepare('UPDATE room_scratch SET size = ? WHERE id = ?').run(size, id);
}

export function setRoomScratchNote(id: string, note: string): void {
  rdb().prepare('UPDATE room_scratch SET note = ? WHERE id = ?').run(note, id);
}

export function setRoomScratchMoved(id: string, path: string): void {
  rdb().prepare('UPDATE room_scratch SET moved_path = ? WHERE id = ?').run(path, id);
}

export function deleteRoomScratch(id: string): boolean {
  return rdb().prepare('DELETE FROM room_scratch WHERE id = ?').run(id).changes > 0;
}

/** The ABANDONED scratchpads: every row of a (person, room) whose newest file
 *  was added before `cutoff`, plus every row of a room that no longer exists. */
export function abandonedRoomScratch(cutoff: number): RoomScratchFile[] {
  return rdb()
    .prepare(
      `SELECT s.* FROM room_scratch s
        WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = s.room_id)
           OR (SELECT MAX(t.created_at) FROM room_scratch t WHERE t.user_key = s.user_key AND t.room_id = s.room_id) < ?`,
    )
    .all(cutoff) as RoomScratchFile[];
}

/** Every scratch id held (the sweep's orphan-file check). */
export function roomScratchIds(): Set<string> {
  return new Set((rdb().prepare('SELECT id FROM room_scratch').all() as { id: string }[]).map((r) => r.id));
}

/** The stored picture's own cap (the page sends a <=256px square; the 2 MB
 *  limit is on the file a person picks, enforced where it is picked). */
export const USER_PICTURE_MAX_BYTES = 256 * 1024;
const PICTURE_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const PICTURE_MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a,
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

export function getUserPicture(userKey: string): string | null {
  const row = rdb().prepare('SELECT picture FROM room_user_prefs WHERE user_key = ?').get(userKey) as { picture: string | null } | undefined;
  return row?.picture ?? null;
}

/** Set (a data: URL of a PNG / JPEG / WebP whose bytes ARE that type) or
 *  clear (null) a user's picture. Never a URL: nothing here can make a
 *  window fetch from somewhere else. Throws RoomError and writes nothing. */
export function setUserPicture(userKey: string, picture: unknown): string | null {
  if (picture !== null) {
    const m = typeof picture === 'string' ? PICTURE_RE.exec(picture) : null;
    if (!m) {
      throw new RoomError(400, 'picture is a data:image/png|jpeg|webp;base64 URL, or null', 'picture');
    }
    if (m[2].length > Math.ceil(USER_PICTURE_MAX_BYTES / 3) * 4) {
      const bytes = Math.floor((m[2].length * 3) / 4);
      throw new RoomError(413, `picture is ${bytes} bytes; the limit is ${USER_PICTURE_MAX_BYTES}`, 'picture');
    }
    if (!PICTURE_MAGIC[m[1]](Buffer.from(m[2], 'base64'))) {
      throw new RoomError(400, `picture: the bytes are not a ${m[1]} image`, 'picture');
    }
  }
  rdb()
    .prepare(
      `INSERT INTO room_user_prefs (user_key, picture, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_key) DO UPDATE SET picture = excluded.picture, updated_at = excluded.updated_at`,
    )
    .run(userKey, picture, Date.now());
  return picture as string | null;
}

let roomTablesFor: Database.Database | null = null;
/** The db, with the room tables ensured once per handle (the 1000-entry burst
 *  would otherwise re-run a dozen CREATE ... IF NOT EXISTS per write). */
function rdb(): Database.Database {
  const d = open();
  if (roomTablesFor !== d) {
    ensureRoomTables(d);
    roomTablesFor = d;
  }
  return d;
}

/** A driver error, restated as a RoomError that names the field. */
function mapRoomDbError(e: unknown): unknown {
  if (e instanceof RoomError) {
    return e;
  }
  const err = e as { code?: string; message?: string };
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' && /room_seats\.handle/.test(err.message ?? '')) {
    return new RoomError(409, 'that handle is already taken in this room', 'handle');
  }
  if (err?.code === 'SQLITE_CONSTRAINT_CHECK') {
    /* "CHECK constraint failed: policy IN ('persistent',...)" — the first word
       of the expression is the column. `body` is what the API calls `text`. */
    const col = /CHECK constraint failed: (\w+)/.exec(err.message ?? '')?.[1] ?? 'value';
    const field = col === 'body' ? 'text' : col === 'occupant_kind' ? 'occupant' : col;
    return new RoomError(400, `${field}: value is not one this build accepts`, field);
  }
  return e;
}

type RoomRowRaw = Omit<Room, 'idle_ms' | 'feed_default' | 'voice' | 'art_tile' | 'wash_at' | 'bubble_glass' | 'design_follow'> & {
  bubble_glass: number | null;
  design_follow: number | null;
  art_tile: string | null;
  wash_at: string | null;
  feed_default: string | null;
  voice: string | null;
};
type SeatRowRaw = Omit<RoomSeat, 'is_lead'> & { is_lead: number | null };

function hydrateRoom(r: RoomRowRaw | undefined): Room | undefined {
  if (!r) {
    return undefined;
  }
  let feed: RoomFeedDefault | null = null;
  try {
    /* Stored as HIDDEN kinds; answered as the shown ones (the wire shape). */
    const v = r.feed_default ? (JSON.parse(r.feed_default) as { hidden: string[]; who: string }) : null;
    feed = v ? { kinds: LINE_KINDS.filter((k) => !v.hidden.includes(k)), who: v.who } : null;
  } catch {
    feed = null; // written only through setRoomSettings; a bad row reads as unset
  }
  return {
    ...r,
    color: r.color ?? null,
    feed_default: feed,
    art: r.art ?? null,
    art_tile: parseArtTile(r.art_tile),
    wash_at: parseWashAt(r.wash_at),
    bubble_glass: Number.isFinite(r.bubble_glass) ? (r.bubble_glass as number) : null,
    pal: r.pal ?? null,
    pal_mode: r.pal_mode === 'dark' || r.pal_mode === 'light' ? r.pal_mode : null,
    design_follow: r.design_follow !== 0,
    parent_id: r.parent_id ?? null,
    alias: r.alias ?? null,
    brief: r.brief ?? null,
    brief_by: r.brief_by ?? null,
    brief_at: Number.isFinite(r.brief_at) ? (r.brief_at as number) : null,
    voice: pickVoice(mergeVoice(voiceDefaults(), voiceOverrides(r.voice)), 'room'),
    idle_ms: Math.max(0, Date.now() - r.last_active_at),
  };
}

/** A stored tile choice; a bad row reads as none (written only through setRoomSettings). */
function parseArtTile(raw: string | null | undefined): RoomArtTile | null {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as RoomArtTile) : null;
  } catch {
    return null;
  }
}

/** A stored spot position; a bad row reads as none. */
function parseWashAt(raw: string | null | undefined): { x: number; y: number } | null {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
  } catch {
    return null;
  }
}

/** Validate a spot position: {x, y} numbers CLAMPED to 0-100 (off the square means
 *  "as far as it goes", which we can honour); a non-number or unknown key is a 400
 *  naming `wash_at.<key>`. */
function validWashAt(v: unknown): { x: number; y: number } {
  const bad = (why: string, key = 'wash_at'): never => {
    throw new RoomError(400, `${key}: ${why}`, key);
  };
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    bad('an object {x, y} or null');
  }
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => k !== 'x' && k !== 'y');
  if (extra !== undefined) {
    bad('unknown key', `wash_at.${extra.slice(0, 40)}`);
  }
  const n = (k: 'x' | 'y'): number => {
    const t = o[k];
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      bad('a number from 0 to 100', `wash_at.${k}`);
    }
    return Math.round(Math.max(0, Math.min(100, t as number)) * 10) / 10;
  };
  return { x: n('x'), y: n('y') };
}

/** Validate a tile choice: {id, blend, level, strength, zoom}, every key present,
 *  or a 400 naming `art_tile.<key>`. Refused, never clamped. */
function validArtTile(v: unknown): RoomArtTile {
  const bad = (why: string, key = 'art_tile'): never => {
    throw new RoomError(400, `art_tile: ${why}`, key);
  };
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    bad('an object {id, blend, level, strength, zoom} or null');
  }
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !['id', 'blend', 'level', 'strength', 'zoom'].includes(k));
  if (extra !== undefined) {
    bad(`unknown key "${extra.slice(0, 40)}"`, `art_tile.${extra.slice(0, 40)}`);
  }
  if (typeof o.id !== 'string' || o.id.length > 80 || !TILE_ID.test(o.id)) {
    bad('id is a tile id like animals-koi-busy-tint', 'art_tile.id');
  }
  if (typeof o.blend !== 'string' || !(ROOM_ART_BLENDS as readonly string[]).includes(o.blend)) {
    bad(`blend is one of ${ROOM_ART_BLENDS.join(' / ')}`, 'art_tile.blend');
  }
  const range = (k: 'level' | 'strength' | 'zoom', lo: number, hi: number): number => {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) {
      bad(`${k} is a number from ${lo} to ${hi}`, `art_tile.${k}`);
    }
    return Math.round(n as number);
  };
  return {
    id: o.id as string,
    blend: o.blend as RoomArtTile['blend'],
    level: range('level', 10, 100),
    strength: range('strength', 0, 100),
    zoom: range('zoom', 50, 200),
  };
}

/** The room's stored voice overrides; a bad row reads as none. */
function voiceOverrides(raw: string | null | undefined): RoomVoiceOverrides {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as RoomVoiceOverrides) : {};
  } catch {
    return {};
  }
}

function hydrateSeat(s: SeatRowRaw | undefined): RoomSeat | undefined {
  return s ? { ...s, is_lead: s.is_lead === 1 } : undefined;
}

/* Every seat read goes through this join, so `is_lead` is computed in one place
   and the lead sorts first AT READ TIME — positions are never rewritten. */
const SEAT_SELECT = `SELECT s.*, COALESCE(s.id = r.lead_seat, 0) AS is_lead
                       FROM room_seats s JOIN rooms r ON r.id = s.room_id`;

function roomRow(d: Database.Database, id: string): Room | undefined {
  return hydrateRoom(d.prepare(`SELECT * FROM rooms WHERE id=?`).get(id) as RoomRowRaw | undefined);
}

function seatRow(d: Database.Database, seatId: string): RoomSeat | undefined {
  return hydrateSeat(d.prepare(`${SEAT_SELECT} WHERE s.id=?`).get(seatId) as SeatRowRaw | undefined);
}

function requireRoom(d: Database.Database, id: string): Room {
  const room = typeof id === 'string' ? roomRow(d, id) : undefined;
  if (!room) {
    throw new RoomError(404, 'no such room', 'id');
  }
  return room;
}

/** Archive is stasis (wr §2.7b): nothing is added to a room in a box. */
function requireOpen(room: Room): void {
  if (room.state !== 'open') {
    throw new RoomError(409, 'the room is archived — /reopen it first', 'state');
  }
}

function requireSeat(d: Database.Database, roomId: string, seatId: string, field = 'seat'): RoomSeat {
  const seat = typeof seatId === 'string' ? seatRow(d, seatId) : undefined;
  if (!seat || seat.room_id !== roomId) {
    throw new RoomError(404, 'no such seat in this room', field);
  }
  if (seat.left_at !== null) {
    throw new RoomError(409, `@${seat.handle} gave up that seat`, field);
  }
  return seat;
}

function activeSeatRows(d: Database.Database, roomId: string): RoomSeat[] {
  return (
    d.prepare(`${SEAT_SELECT} WHERE s.room_id=? AND s.left_at IS NULL ORDER BY is_lead DESC, s.position`).all(roomId) as SeatRowRaw[]
  ).map((s) => hydrateSeat(s)!);
}

/* ------------------------------------------------------------ families ---- */
/* WORKGROUPS (Owner 2026-10-04, KB design-notes-id §10): a FAMILY is a main room
   plus its workgroups (one level of nesting). Seat handles and room aliases
   share ONE namespace across the family, so `@name` is never ambiguous. */

export const ROOM_ALIAS_MAX = 32;

/** The head (main) room id of a room's family. */
function headIdOf(room: { id: string; parent_id: string | null }): string {
  return room.parent_id ?? room.id;
}

/** Every room id of the family `roomId` belongs to: the main room first. */
function familyIds(d: Database.Database, roomId: string): string[] {
  const room = roomRow(d, roomId);
  if (!room) {
    return [roomId];
  }
  const head = headIdOf(room);
  const kids = (d.prepare(`SELECT id FROM rooms WHERE parent_id=? ORDER BY created_at, rowid`).all(head) as { id: string }[]).map((r) => r.id);
  return [head, ...kids];
}

/** Active seats of every room in the family. */
function familySeatRows(d: Database.Database, roomId: string): RoomSeat[] {
  const ids = familyIds(d, roomId);
  return (
    d
      .prepare(`${SEAT_SELECT} WHERE s.room_id IN (${ids.map(() => '?').join(',')}) AND s.left_at IS NULL ORDER BY is_lead DESC, s.position`)
      .all(...ids) as SeatRowRaw[]
  ).map((s) => hydrateSeat(s)!);
}

/** What `handle` would clash with in this family (an active seat in ANY room of
 *  it, or the alias of a non-archived room), or null. `exceptSeat` is the seat
 *  being renamed / moved. */
function handleClash(d: Database.Database, roomId: string, handle: string, exceptSeat: string | null): string | null {
  const seat = familySeatRows(d, roomId).find((s) => s.handle === handle && s.id !== exceptSeat);
  if (seat) {
    const where = seat.room_id === roomId ? 'this room' : `"${roomRow(d, seat.room_id)?.name ?? '?'}"`;
    return seat.room_id === roomId
      ? `@${handle} is already taken in this room`
      : `@${handle} is already taken in ${where} (a room and its workgroups share one set of names)`;
  }
  const ids = familyIds(d, roomId);
  const al = d
    .prepare(`SELECT name FROM rooms WHERE alias=? AND state<>'archived' AND id IN (${ids.map(() => '?').join(',')})`)
    .get(handle, ...ids) as { name: string } | undefined;
  return al ? `@${handle} is the address of "${al.name}" (a room's alias and a seat's handle cannot match)` : null;
}

/** A room alias as typed: normalised, then refused if reserved, too long, or
 *  already a name in the family. `roomId` null = a room not created yet
 *  (`parentId` names its family). */
function validAlias(d: Database.Database, typed: unknown, roomId: string | null, parentId: string | null): string {
  const a = normalizeSlug(typed);
  if (!a || !isSlug(a)) {
    throw new RoomError(400, 'an alias is lowercase letters, digits and single hyphens', 'alias');
  }
  if (a.length > ROOM_ALIAS_MAX) {
    throw new RoomError(400, `an alias is at most ${ROOM_ALIAS_MAX} characters`, 'alias');
  }
  if (RESERVED_HANDLES.includes(a)) {
    throw new RoomError(400, `@${a} is reserved`, 'alias');
  }
  const ids = roomId !== null ? familyIds(d, roomId) : parentId !== null ? familyIds(d, parentId) : [];
  if (ids.length) {
    const other = d
      .prepare(`SELECT name FROM rooms WHERE alias=? AND state<>'archived' AND id IS NOT ? AND id IN (${ids.map(() => '?').join(',')})`)
      .get(a, roomId, ...ids) as { name: string } | undefined;
    if (other) {
      throw new RoomError(409, `@${a} is already the address of "${other.name}"`, 'alias');
    }
    const seat = (d.prepare(`${SEAT_SELECT} WHERE s.room_id IN (${ids.map(() => '?').join(',')}) AND s.left_at IS NULL AND s.handle=?`).get(...ids, a) as SeatRowRaw | undefined);
    if (seat) {
      throw new RoomError(409, `@${a} is already a seat's handle in this family`, 'alias');
    }
  }
  return a;
}

/**
 * LIVE NAME CHECKS for the create-a-workgroup sheet (Owner 2026-10-04, note
 * eee9ca063154): would this alias (a new workgroup's address) or this handle (a
 * seat in the family) be free? Read-only; the answer carries the engine's own
 * words, so the sheet never decides a clash by itself. `value` is the
 * normalised form; `free` false always has a `reason`.
 */
export function checkFamilyName(roomId: string, kind: 'alias' | 'handle', typed: unknown): { value: string; free: boolean; reason: string | null } {
  const d = rdb();
  const room = requireRoom(d, roomId);
  const value = normalizeSlug(typed) ?? '';
  try {
    if (kind === 'alias') {
      return { value: validAlias(d, typed, null, headIdOf(room)), free: true, reason: null };
    }
    const h = normalizeHandle(typed);
    const clash = handleClash(d, roomId, h, null);
    return { value: h, free: !clash, reason: clash };
  } catch (e) {
    if (e instanceof RoomError) {
      return { value, free: false, reason: e.message };
    }
    throw e;
  }
}

/** The workgroups of a main room, oldest first (empty for a workgroup). */
export function listWorkgroups(roomId: string): Room[] {
  const d = rdb();
  return (d.prepare(`SELECT * FROM rooms WHERE parent_id=? ORDER BY created_at, rowid`).all(roomId) as RoomRowRaw[]).map((r) => hydrateRoom(r)!);
}

/** A room's family, main room first. */
export function listFamily(roomId: string): Room[] {
  const d = rdb();
  return familyIds(d, roomId).map((id) => roomRow(d, id)!).filter(Boolean);
}

/** The routing context for a room's family (rooms.ts → room-commands parse):
 *  every active seat of the OTHER rooms, each room's alias → its lead, and the
 *  head room's lead (what `@lead` means inside a workgroup). */
export interface FamilyContext {
  headLead: RoomSeat | null;
  inWorkgroup: boolean;
  seats: RoomSeat[];
  aliases: Array<{ alias: string; roomId: string; roomName: string; lead: RoomSeat | null }>;
}
export function familyContext(roomId: string): FamilyContext {
  const d = rdb();
  const room = requireRoom(d, roomId);
  const ids = familyIds(d, roomId);
  const rooms = ids.map((id) => roomRow(d, id)!);
  const head = rooms[0];
  return {
    inWorkgroup: room.parent_id !== null,
    headLead: head.lead_seat ? (seatRow(d, head.lead_seat) ?? null) : null,
    seats: familySeatRows(d, roomId).filter((s) => s.room_id !== roomId),
    aliases: rooms
      .filter((r) => r.alias && r.state !== 'archived')
      .map((r) => ({ alias: r.alias!, roomId: r.id, roomName: r.name, lead: r.lead_seat ? (seatRow(d, r.lead_seat) ?? null) : null })),
  };
}

/**
 * A handle a human TYPED: normalised the agent-slug way (one right answer, so
 * nothing to ask), then refused if nothing is left or it is reserved.
 */
export function normalizeHandle(typed: unknown): string {
  const h = normalizeSlug(typed);
  if (!h || !isSlug(h)) {
    throw new RoomError(400, 'a handle is lowercase letters, digits and single hyphens', 'handle');
  }
  if (RESERVED_HANDLES.includes(h)) {
    throw new RoomError(400, `@${h} is reserved`, 'handle');
  }
  return h;
}

/** The non-archived aliases of the family (a derived handle steps aside from them). */
function listFamilyAliases(d: Database.Database, roomId: string): string[] {
  const ids = familyIds(d, roomId);
  return (
    d.prepare(`SELECT alias FROM rooms WHERE alias IS NOT NULL AND state<>'archived' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) as {
      alias: string;
    }[]
  ).map((r) => r.alias);
}

/**
 * A DERIVED handle: the stem if it is free and not reserved, else the first
 * free placeholder `<stem>2`, `<stem>3` … (handle_named=0, so the roster can
 * nudge a rename). The stem is truncated BEFORE the suffix is appended, or
 * normalizeSlug's 64-char slice would cut the suffix off.
 */
function freeHandle(d: Database.Database, roomId: string, stem: string, avoid: readonly string[] = []): { handle: string; named: number } {
  const taken = new Set([
    ...familySeatRows(d, roomId).map((s) => s.handle),
    ...listFamilyAliases(d, roomId),
    ...avoid,
  ]);
  const usable = (h: string): boolean => isSlug(h) && !taken.has(h) && !RESERVED_HANDLES.includes(h);
  if (usable(stem)) {
    return { handle: stem, named: 1 };
  }
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const handle = stem.slice(0, 64 - suffix.length) + suffix;
    if (usable(handle)) {
      return { handle, named: 0 };
    }
  }
}

/** The line's author for an actor, checked against THIS room. A seat actor
 *  must hold an active seat here; the engine never downgrades it to 'user'. */
function authorOf(d: Database.Database, roomId: string | null, actor: RoomActor): { author: string; author_seat: string | null } {
  if (actor === 'user') {
    return { author: 'user', author_seat: null };
  }
  const seat = actor && typeof actor.seatId === 'string' ? seatRow(d, actor.seatId) : undefined;
  if (!seat || seat.left_at !== null || (roomId !== null && seat.room_id !== roomId)) {
    throw new RoomError(403, 'that author holds no seat in this room', 'from');
  }
  return { author: seat.handle, author_seat: seat.id };
}

function actorLabel(actor: RoomActor): string {
  return actor === 'user' ? 'user' : actor.seatId;
}

interface LineWrite {
  kind: string;
  author: string;
  author_seat: string | null;
  target: string | null;
  target_seat: string | null;
  body: string | null;
  ref?: string | null;
  meta?: Record<string, unknown> | null;
}

function writeLine(d: Database.Database, roomId: string, w: LineWrite): RoomLineEntry {
  if (w.body !== null && w.body !== undefined) {
    if (typeof w.body !== 'string') {
      throw new RoomError(400, 'text must be a string', 'text');
    }
    if (w.body.length > LINE_BODY_MAX) {
      throw new RoomError(400, `text is over ${LINE_BODY_MAX} characters`, 'text');
    }
  }
  const row = {
    room_id: roomId,
    ts: Date.now(),
    kind: w.kind,
    author: w.author,
    author_seat: w.author_seat,
    target: w.target,
    target_seat: w.target_seat,
    thread: null, // NULL on every Phase-1 row; the fabric fills it once `connect` exists
    body: w.body ?? null,
    ref: w.ref ?? null,
    meta: w.meta && Object.keys(w.meta).length ? JSON.stringify(w.meta) : null,
  };
  const info = d
    .prepare(
      `INSERT INTO room_line (room_id, ts, kind, author, author_seat, target, target_seat, thread, body, ref, meta)
       VALUES (@room_id, @ts, @kind, @author, @author_seat, @target, @target_seat, @thread, @body, @ref, @meta)`,
    )
    .run(row);
  /* THE DECAY SIGNAL moves only for words a person or a member wrote. Facts
     and status churn never make a dormant room look awake. A spoken line is
     words too, but not the voice agent's own (it holds no seat). */
  if ((w.kind === 'chat' || w.kind === 'command' || w.kind === 'voice') && w.author !== 'room' && w.author !== 'voice' && w.author !== 'concierge') {
    d.prepare(`UPDATE rooms SET last_active_at=? WHERE id=?`).run(row.ts, roomId);
  }
  return { id: Number(info.lastInsertRowid), ...row, kind: row.kind as LineKind };
}

/** A Room fact: author 'room', optionally about one seat (so a seat filter
 *  shows what happened to that seat), caused by `cause` when a command was. */
function writeFact(
  d: Database.Database,
  roomId: string,
  body: string,
  about: RoomSeat | null,
  cause: RoomLineEntry | null,
  meta: Record<string, unknown> = {},
): RoomLineEntry {
  return writeLine(d, roomId, {
    kind: 'fact',
    author: 'room',
    author_seat: null,
    target: about ? about.handle : null,
    target_seat: about ? about.id : null,
    body,
    meta: cause ? { cause: cause.id, ...meta } : meta,
  });
}

/** The verbatim `command` entry, when the action came in as typed text. A room
 *  command is addressed to the ENGINE, so its target is the seat it acts on
 *  (or none) — never the lead default that un-addressed chat takes. */
function writeCommand(
  d: Database.Database,
  roomId: string,
  opts: RoomActionOpts,
  about: RoomSeat | null,
): RoomLineEntry | null {
  if (opts.commandText === undefined || opts.commandText === null) {
    return null;
  }
  const who = authorOf(d, roomId, opts.actor);
  return writeLine(d, roomId, {
    kind: 'command',
    ...who,
    target: about ? about.handle : null,
    target_seat: about ? about.id : null,
    body: opts.commandText,
  });
}

/** Run one action in ONE transaction; map driver errors to RoomErrors. */
function roomAction<T>(fn: (d: Database.Database) => RoomAction<T>): RoomAction<T> {
  const d = rdb();
  try {
    return d.transaction(() => fn(d))();
  } catch (e) {
    throw mapRoomDbError(e);
  }
}

/**
 * SEVERAL room verbs in ONE transaction (assemble, the design notes §4.2).
 * Each verb called inside `fn` runs as a SAVEPOINT of this one (better-sqlite3
 * nests transactions), so a caller can catch one refused verb without undoing
 * the others; any throw out of `fn` rolls every verb back. The store still
 * never broadcasts: the endpoint announces only what committed.
 */
/** Run `fn` with the db inside ONE transaction (the Tasks verbs: each takes the db, see tasks-store.ts). */
export function withRoomDb<T>(fn: (d: Database.Database) => T): T {
  const d = rdb();
  return d.transaction(() => fn(d))();
}

export function roomBatch<T>(fn: () => T): T {
  return rdb().transaction(fn)();
}

/* ------------------------------------------------------------ starter seeds ---- */

export interface StarterSeedRow {
  template: string;
  version: number;
  room_id: string;
  ids: { groups: Record<string, string>; seats: Record<string, string> };
  at: number;
}
export function getStarterSeed(template: string): StarterSeedRow | undefined {
  const r = rdb().prepare(`SELECT * FROM starter_seeds WHERE template=?`).get(template) as { template: string; version: number; room_id: string; ids_json: string; at: number } | undefined;
  return r ? { template: r.template, version: r.version, room_id: r.room_id, ids: JSON.parse(r.ids_json), at: r.at } : undefined;
}
/** Run inside the seed's transaction. */
export function recordStarterSeed(template: string, version: number, roomId: string, ids: StarterSeedRow['ids']): void {
  rdb().prepare(`INSERT INTO starter_seeds (template, version, room_id, ids_json, at) VALUES (?, ?, ?, ?, ?)`).run(template, version, roomId, JSON.stringify(ids), Date.now());
}
export function starterRecipeOwned(recipeId: string): boolean {
  return !!rdb().prepare(`SELECT 1 FROM starter_recipes WHERE recipe_id=?`).get(recipeId);
}
export function markStarterRecipe(recipeId: string): void {
  rdb().prepare(`INSERT OR IGNORE INTO starter_recipes (recipe_id, at) VALUES (?, ?)`).run(recipeId, Date.now());
}

function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > ROOM_NAME_MAX) {
    throw new RoomError(400, `a room name is 1-${ROOM_NAME_MAX} characters`, 'name');
  }
  return n;
}

/* ---------------------------------------------------------------- rooms ---- */

export function createRoom(
  input: { name: string; parent_id?: string | null; alias?: string | null },
  opts: RoomActionOpts,
): RoomAction<Room> {
  return roomAction((d) => {
    const name = validName(input?.name);
    let createdBy = 'user';
    if (opts.actor !== 'user') {
      /* A pane creating a room is recorded by the seat it holds elsewhere (the
         route resolves which, §2.1); a new room has no seats of its own. */
      createdBy = authorOf(d, null, opts.actor).author_seat!;
    }
    /* A WORKGROUP (Owner 2026-10-04): a room under a MAIN room. One level only,
       the parent must be open, and the workgroup needs an address (derived from
       its name when none is typed — a workgroup nobody can address is a room). */
    const parentId = input?.parent_id !== undefined && input.parent_id !== null && input.parent_id !== '' ? input.parent_id : null;
    let parent: Room | null = null;
    if (parentId !== null) {
      parent = typeof parentId === 'string' ? (roomRow(d, parentId) ?? null) : null;
      if (!parent) {
        throw new RoomError(400, 'no such room to put the workgroup under', 'parent_id');
      }
      if (parent.parent_id !== null) {
        throw new RoomError(409, `"${parent.name}" is itself a workgroup; workgroups nest one level only`, 'parent_id');
      }
      requireOpen(parent);
    }
    const typedAlias = input?.alias !== undefined && input.alias !== null && input.alias !== '';
    let alias: string | null = null;
    if (typedAlias) {
      alias = validAlias(d, input.alias, null, parentId);
    } else if (parent) {
      const derived = (normalizeSlug(name) ?? '').slice(0, ROOM_ALIAS_MAX).replace(/-+$/, '');
      if (!derived) {
        throw new RoomError(400, 'a workgroup needs an alias', 'alias');
      }
      alias = validAlias(d, derived, null, parentId);
    }
    const now = Date.now();
    const id = randomUUID();
    d.prepare(
      `INSERT INTO rooms (id, name, lead_seat, state, created_by, created_at, updated_at, last_active_at, parent_id, alias)
       VALUES (?, ?, NULL, 'open', ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, createdBy, now, now, now, parentId, alias);
    /* AUTO COLOR [workgroup design] Owner 2026-10-05: a workgroup nobody colored gets a
       sample swatch no sibling and not its main room wears (a chosen color is set
       right after by the caller and simply replaces this one). */
    if (parent) {
      const used = [parent.color, ...(d.prepare(`SELECT color FROM rooms WHERE parent_id=? AND id<>?`).all(parent.id, id) as { color: string | null }[]).map((r) => r.color)];
      d.prepare(`UPDATE rooms SET color=? WHERE id=?`).run(pickRoomColor(used), id);
    }
    const entries: RoomLineEntry[] = [];
    if (opts.commandText !== undefined && opts.commandText !== null) {
      const who = authorOf(d, null, opts.actor);
      entries.push(writeLine(d, id, { kind: 'command', ...who, target: null, target_seat: null, body: opts.commandText }));
    }
    entries.push(
      writeFact(
        d,
        id,
        parent ? `workgroup "${name}" (@${alias}) was created under "${parent.name}"` : `room "${name}" was created`,
        null,
        entries[0] ?? null,
        { created_by: createdBy, ...(parent ? { parent_id: parent.id, alias } : {}) },
      ),
    );
    if (parent) {
      entries.push(writeFact(d, parent.id, `workgroup "${name}" (@${alias}) was created`, null, null, { workgroup: id, alias }));
    }
    return { roomId: id, result: roomRow(d, id)!, entries, stateChanged: true, ...(parent ? { alsoStateFor: [parent.id] } : {}) };
  });
}

/** BOOT SWEEP [workgroup design] Owner 2026-10-05 ("Both UI and application carried the same color"):
 *  siblings sharing the exact same color keep the earliest-created one's and the later
 *  ones are re-picked (distinct from the main room and every sibling). Idempotent: a
 *  second run finds no duplicates. Returns what changed so the caller can log each. */
export function dedupeWorkgroupColors(): { id: string; name: string; from: string; to: string }[] {
  const d = rdb();
  const out: { id: string; name: string; from: string; to: string }[] = [];
  const heads = d.prepare(`SELECT id, color FROM rooms WHERE parent_id IS NULL`).all() as { id: string; color: string | null }[];
  for (const h of heads) {
    const kids = d.prepare(`SELECT id, name, color FROM rooms WHERE parent_id=? ORDER BY created_at, rowid`).all(h.id) as { id: string; name: string; color: string | null }[];
    const seen = new Set<string>();
    for (const k of kids) {
      const c = k.color ? k.color.toLowerCase() : null;
      if (c && seen.has(c)) {
        const to = pickRoomColor([h.color, ...kids.map((x) => x.color)]);
        d.prepare(`UPDATE rooms SET color=? WHERE id=?`).run(to, k.id);
        k.color = to;
        out.push({ id: k.id, name: k.name, from: c, to });
        seen.add(to.toLowerCase());
      } else if (c) {
        seen.add(c);
      }
    }
  }
  return out;
}

export function getRoom(id: string): Room | undefined {
  return roomRow(rdb(), id);
}

/** Rooms, most recently active first. */
export function listRooms(q: { state?: RoomState } = {}): Room[] {
  const d = rdb();
  const rows = (
    q.state
      ? d.prepare(`SELECT * FROM rooms WHERE state=? ORDER BY last_active_at DESC, created_at DESC`).all(q.state)
      : d.prepare(`SELECT * FROM rooms ORDER BY last_active_at DESC, created_at DESC`).all()
  ) as RoomRowRaw[];
  return rows.map((r) => hydrateRoom(r)!);
}

/**
 * F4: bind a room to the fabric thread opened for it (engine/room-fabric.ts).
 * SET ONCE — only while `thread` is NULL, so two lines racing to open a thread
 * cannot both win; the loser reads back the winner's id. Not a room ACTION: it
 * writes no line entry and no fact (the thread is plumbing, not something a
 * member did). Returns the room as stored.
 */
export function setRoomThread(id: string, thread: string): Room | undefined {
  const d = rdb();
  d.prepare(`UPDATE rooms SET thread=? WHERE id=? AND thread IS NULL`).run(thread, id);
  return roomRow(d, id);
}

/**
 * ROOM SETTINGS (room round 3): the room colour and the default feed. A view
 * preference, not a room ACTION: no line entry, no fact, and allowed on an
 * archived room. The route is HUMAN-only (rooms.ts). A field that is absent is
 * left alone; null clears it. Validated here, the only writer:
 *   color         '#rrggbb' (stored lower-case) | null
 *   feed_default  {kinds: LINE_KINDS subset, who: '' | 'me' | 'agents' | an
 *                 active seat id of this room} | null — no other keys.
 *                 Stored as {hidden, who} (room-voice §10.2).
 *   voice         a PER-KEY merge (room-voice §10.1): an absent key is
 *                 unchanged, null is a value (character:null = the room
 *                 default); a bad key is a 400 naming `voice.<key>`.
 *   art           a logo key (`lib:<id>` | a preset name) | null. SHAPE is
 *                 checked here; that the art EXISTS is the route's check
 *                 (presets live in a web file) [rooms/character].
 */
export type RoomSettingsPatch = {
  color?: unknown;
  feed_default?: unknown;
  voice?: unknown;
  art?: unknown;
  art_tile?: unknown;
  wash_at?: unknown;
  bubble_glass?: unknown;
  pal?: unknown;
  pal_mode?: unknown;
  design_follow?: unknown;
};

export function setRoomSettings(id: string, patch: RoomSettingsPatch): RoomAction<Room> {
  return roomAction((d) => {
    const room = requireRoom(d, id);
    const p = patch ?? {};
    if (
      p.color === undefined && p.feed_default === undefined && p.voice === undefined &&
      p.art === undefined && p.art_tile === undefined && p.wash_at === undefined && p.bubble_glass === undefined && p.pal === undefined && p.pal_mode === undefined && p.design_follow === undefined
    ) {
      throw new RoomError(400, 'a settings PATCH carries color, feed_default, voice, art, art_tile, wash_at, bubble_glass, pal, pal_mode and/or design_follow', 'body');
    }
    if (p.design_follow !== undefined && typeof p.design_follow !== 'boolean') {
      throw new RoomError(400, 'design_follow is true or false', 'design_follow');
    }
    const follow = p.design_follow === undefined ? room.design_follow : (p.design_follow as boolean);
    let color = room.color;
    if (p.color !== undefined) {
      if (p.color !== null && (typeof p.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(p.color))) {
        throw new RoomError(400, 'color must be #rrggbb or null', 'color');
      }
      color = p.color === null ? null : p.color.toLowerCase();
    }
    let feed = room.feed_default;
    if (p.feed_default !== undefined) {
      feed = p.feed_default === null ? null : validFeedDefault(d, id, p.feed_default);
    }
    const storedVoice = (d.prepare(`SELECT voice FROM rooms WHERE id=?`).get(id) as { voice: string | null }).voice;
    let voiceJson = storedVoice;
    if (p.voice !== undefined) {
      let set: RoomVoiceOverrides;
      try {
        set = validVoicePatch(p.voice, 'room'); // v3.6: a global key is a 400 naming it
      } catch (e) {
        throw e instanceof VoiceSettingsError ? new RoomError(400, e.message, e.field) : e;
      }
      const next = layerOverrides(voiceOverrides(storedVoice), set);
      voiceJson = Object.keys(next).length ? JSON.stringify(next) : null;
    }
    /* ROOM CHARACTER [rooms/character] */
    let art = room.art;
    try {
      if (p.art !== undefined) {
        art = p.art === null ? null : validArtKey(p.art);
      }
    } catch (e) {
      throw e instanceof RoomArtError ? new RoomError(400, e.message, e.field) : e;
    }
    /* TILED ART + PALETTE OVERRIDE [hub-v2]. `pal: null` clears the override and
       its mode with it; a mode needs a palette. */
    const artTile = p.art_tile === undefined ? room.art_tile : p.art_tile === null ? null : validArtTile(p.art_tile);
    const washAt = p.wash_at === undefined ? room.wash_at : p.wash_at === null ? null : validWashAt(p.wash_at);
    /* BUBBLE GLASS: a number CLAMPS to 50-200 (off the slider means "as far as it goes");
       a non-number is a 400 naming bubble_glass. */
    let glass = room.bubble_glass;
    if (p.bubble_glass !== undefined) {
      if (p.bubble_glass === null) {
        glass = null;
      } else if (typeof p.bubble_glass !== 'number' || !Number.isFinite(p.bubble_glass)) {
        throw new RoomError(400, 'bubble_glass: a number from 50 to 200, or null', 'bubble_glass');
      } else {
        glass = Math.round(Math.max(50, Math.min(200, p.bubble_glass)));
      }
    }
    let pal = room.pal;
    let palMode = room.pal_mode;
    if (p.pal !== undefined) {
      if (p.pal !== null && (typeof p.pal !== 'string' || !(ROOM_PALETTES as readonly string[]).includes(p.pal))) {
        throw new RoomError(400, `pal is a palette key (${ROOM_PALETTES.join(' / ')}) or null`, 'pal');
      }
      pal = p.pal;
      if (pal === null) {
        palMode = null;
      } else if (palMode === null && p.pal_mode === undefined) {
        palMode = 'dark';
      }
    }
    if (p.pal_mode !== undefined) {
      if (p.pal_mode !== null && p.pal_mode !== 'dark' && p.pal_mode !== 'light') {
        throw new RoomError(400, 'pal_mode is dark, light or null', 'pal_mode');
      }
      if (p.pal_mode !== null && pal === null) {
        throw new RoomError(400, 'pal_mode needs a pal: this room has no palette of its own', 'pal_mode');
      }
      palMode = p.pal_mode;
    }
    const artTileJson = artTile ? JSON.stringify(artTile) : null;
    const feedJson = feed ? JSON.stringify({ hidden: LINE_KINDS.filter((k) => !feed!.kinds.includes(k)), who: feed.who }) : null;
    const changed =
      color !== room.color ||
      JSON.stringify(feed) !== JSON.stringify(room.feed_default) ||
      voiceJson !== storedVoice ||
      art !== room.art ||
      JSON.stringify(artTile) !== JSON.stringify(room.art_tile) ||
      JSON.stringify(washAt) !== JSON.stringify(room.wash_at) ||
      glass !== room.bubble_glass ||
      pal !== room.pal ||
      palMode !== room.pal_mode ||
      follow !== room.design_follow;
    if (!changed) {
      return { roomId: id, result: room, entries: [], stateChanged: false };
    }
    d.prepare(`UPDATE rooms SET color=?, feed_default=?, voice=?, art=?, art_tile=?, wash_at=?, bubble_glass=?, pal=?, pal_mode=?, design_follow=?, updated_at=? WHERE id=?`)
      .run(color, feedJson, voiceJson, art, artTileJson, washAt ? JSON.stringify(washAt) : null, glass, pal, palMode, follow ? 1 : 0, Date.now(), id);
    return { roomId: id, result: roomRow(d, id)!, entries: [], stateChanged: true };
  });
}

function validFeedDefault(d: Database.Database, roomId: string, v: unknown): RoomFeedDefault {
  const bad = (why: string): never => {
    throw new RoomError(400, `feed_default: ${why}`, 'feed_default');
  };
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    bad('an object {kinds, who} or null');
  }
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => k !== 'kinds' && k !== 'who');
  if (extra !== undefined) {
    bad(`unknown key "${extra.slice(0, 40)}"`);
  }
  if (!Array.isArray(o.kinds) || o.kinds.some((k) => typeof k !== 'string' || !(LINE_KINDS as readonly string[]).includes(k))) {
    bad(`kinds is a list of ${LINE_KINDS.join(' / ')}`);
  }
  const shown = new Set(o.kinds as string[]);
  const who = o.who === undefined ? '' : o.who;
  if (typeof who !== 'string') {
    bad('who is a string');
  }
  if (who !== '' && who !== 'me' && who !== 'agents') {
    requireSeat(d, roomId, who as string, 'feed_default');
  }
  return { kinds: LINE_KINDS.filter((k) => shown.has(k)), who: who as string };
}

/**
 * Rename, hand the lead over, set the mode. A field that is absent is left
 * alone; a patch that changes nothing writes nothing (idempotent PATCH).
 *
 * LEAD INVARIANTS (§1.6): the lead is always an active, PERSISTENT seat of this
 * room (rule 1), and it can be handed over but never cleared — the "no lead"
 * alternative of §0.1 Q3 is not built. Every change is a Room fact (rule 5):
 * it is the record of who was lead when an approval was given.
 */
export function updateRoom(
  id: string,
  patch: { name?: string; lead_seat?: string | null; mode?: string | null },
  opts: RoomActionOpts,
): RoomAction<Room> {
  return roomAction((d) => {
    const room = requireRoom(d, id);
    requireOpen(room);
    const p = patch ?? {};
    const name = p.name !== undefined ? validName(p.name) : room.name;
    let lead: RoomSeat | null = null;
    if (p.lead_seat !== undefined) {
      if (p.lead_seat === null) {
        throw new RoomError(400, 'the lead can be handed over, not removed', 'lead_seat');
      }
      lead = requireSeat(d, id, p.lead_seat, 'lead_seat');
      if (lead.policy !== 'persistent') {
        throw new RoomError(409, `@${lead.handle} forgets by design (${lead.policy}); the lead must be persistent`, 'lead_seat');
      }
    }
    let mode = room.mode;
    if (p.mode !== undefined) {
      const m = typeof p.mode === 'string' ? p.mode.trim() : '';
      if (p.mode !== null && typeof p.mode !== 'string') {
        throw new RoomError(400, 'mode must be a word or null', 'mode');
      }
      if (m.length > 64) {
        throw new RoomError(400, 'mode is at most 64 characters', 'mode');
      }
      mode = m && m !== 'off' ? m : null;
    }
    const nameChanged = name !== room.name;
    const leadChanged = lead !== null && lead.id !== room.lead_seat;
    const modeChanged = mode !== room.mode;
    if (!nameChanged && !leadChanged && !modeChanged) {
      return { roomId: id, result: room, entries: [], stateChanged: false };
    }
    d.prepare(`UPDATE rooms SET name=?, lead_seat=?, mode=?, updated_at=? WHERE id=?`).run(
      name,
      leadChanged ? lead!.id : room.lead_seat,
      mode,
      Date.now(),
      id,
    );
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, id, opts, leadChanged ? lead : null);
    if (cmd) {
      entries.push(cmd);
    }
    if (nameChanged) {
      entries.push(writeFact(d, id, `the room was renamed "${name}"`, null, cmd, { from: room.name, to: name }));
    }
    if (leadChanged) {
      const prev = room.lead_seat ? seatRow(d, room.lead_seat) : undefined;
      entries.push(
        writeFact(d, id, prev ? `@${lead!.handle} is now the lead (was @${prev.handle})` : `@${lead!.handle} is now the lead`, lead, cmd, {
          from: room.lead_seat,
          to: lead!.id,
        }),
      );
    }
    if (modeChanged) {
      entries.push(writeFact(d, id, mode ? `room mode: ${mode}` : 'room mode cleared', null, cmd, { from: room.mode, to: mode }));
    }
    return { roomId: id, result: roomRow(d, id)!, entries, stateChanged: true };
  });
}

/** ROOM BRIEF [room brief] (Owner 2026-10-05): set (markdown) or clear (null) this
 *  room's brief. One FACT line says it changed, never the content. An unchanged
 *  brief writes nothing. */
export const ROOM_BRIEF_MAX = 8000;
export function setRoomBrief(id: string, brief: string | null, opts: RoomActionOpts): RoomAction<Room> {
  return roomAction((d) => {
    const room = requireRoom(d, id);
    requireOpen(room);
    let text: string | null = null;
    if (brief !== null) {
      if (typeof brief !== 'string') {
        throw new RoomError(400, 'brief must be text or null', 'brief');
      }
      text = brief.trim() || null;
      if (text !== null && text.length > ROOM_BRIEF_MAX) {
        throw new RoomError(413, `brief is at most ${ROOM_BRIEF_MAX} characters (this is ${text.length})`, 'brief');
      }
    }
    if (text === room.brief) {
      return { roomId: id, result: room, entries: [], stateChanged: false };
    }
    const who = authorOf(d, id, opts.actor);
    const now = Date.now();
    d.prepare(`UPDATE rooms SET brief=?, brief_by=?, brief_at=?, updated_at=? WHERE id=?`).run(text, text === null ? null : who.author, text === null ? null : now, now, id);
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, id, opts, null);
    if (cmd) {
      entries.push(cmd);
    }
    const label = who.author === 'user' ? 'the user' : `@${who.author}`;
    entries.push(writeFact(d, id, text === null ? `${label} cleared the room brief` : `${label} updated the room brief`, null, cmd));
    return { roomId: id, result: roomRow(d, id)!, entries, stateChanged: true };
  });
}

/** The code folder of a room's FAMILY (the main room carries it; a workgroup uses its family's), or null. */
export function familyCodeFolder(roomId: string): { dir: string; mode: 'existing' | 'new'; roomId: string } | null {
  const d = rdb();
  const room = roomRow(d, roomId);
  if (!room) {
    return null;
  }
  const head = room.parent_id ? (roomRow(d, room.parent_id) ?? room) : room;
  return head.code_dir && head.code_mode ? { dir: head.code_dir, mode: head.code_mode, roomId: head.id } : null;
}

/** Set (or clear, mode 'none') the room's code folder. Only a MAIN room: workgroups use their family's. The path is stored as given (the caller, engine/code-folder.ts,
 *  has already checked it); a fact says what changed. */
export function setRoomCodeFolder(id: string, input: { mode: 'existing' | 'new' | 'none'; dir?: string | null }, opts: RoomActionOpts): RoomAction<Room> {
  return roomAction((d) => {
    const room = requireRoom(d, id);
    requireOpen(room);
    if (room.parent_id !== null) {
      throw new RoomError(409, 'a workgroup uses its main room\'s code folder; set it on the main room', 'mode');
    }
    const mode = input?.mode;
    if (mode !== 'existing' && mode !== 'new' && mode !== 'none') {
      throw new RoomError(400, "mode is 'existing', 'new' or 'none'", 'mode');
    }
    let dir: string | null = null;
    if (mode !== 'none') {
      dir = typeof input.dir === 'string' ? input.dir.trim() : '';
      if (!dir || dir.length > 1024 || dir.includes('\u0000')) {
        throw new RoomError(400, 'path is the code folder (at most 1024 characters)', 'path');
      }
    }
    const next = mode === 'none' ? null : (mode as 'existing' | 'new');
    if (dir === room.code_dir && next === room.code_mode) {
      return { roomId: id, result: room, entries: [], stateChanged: false };
    }
    const who = authorOf(d, id, opts.actor);
    d.prepare(`UPDATE rooms SET code_dir=?, code_mode=?, updated_at=? WHERE id=?`).run(dir, next, Date.now(), id);
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, id, opts, null);
    if (cmd) {
      entries.push(cmd);
    }
    const label = who.author === 'user' ? 'the user' : `@${who.author}`;
    entries.push(writeFact(d, id, dir === null ? `${label} removed the room's code folder` : `${label} set the room's code folder to ${dir}`, null, cmd));
    return { roomId: id, result: roomRow(d, id)!, entries, stateChanged: true };
  });
}

/** Stasis, by hand only — nothing archives on a timer (wr §2.7b). */
export function archiveRoom(id: string, opts: RoomActionOpts): RoomAction<Room> {
  return roomAction((d) => {
    const room = requireRoom(d, id);
    if (room.state === 'archived') {
      throw new RoomError(409, 'the room is already archived', 'state');
    }
    /* A main room cannot be boxed up while its workgroups are still open: they
       would be orphans nobody can reach. Archive them first (each on its own). */
    const live = listWorkgroups(id).filter((w) => w.state === 'open');
    if (live.length) {
      throw new RoomError(
        409,
        `archive its workgroups first: ${live.map((w) => `"${w.name}" (@${w.alias ?? '?'})`).join(', ')}`,
        'state',
      );
    }
    const now = Date.now();
    d.prepare(`UPDATE rooms SET state='archived', archived_at=?, updated_at=? WHERE id=?`).run(now, now, id);
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, id, opts, null);
    if (cmd) {
      entries.push(cmd);
    }
    entries.push(writeFact(d, id, 'the room was archived', null, cmd));
    return { roomId: id, result: roomRow(d, id)!, entries, stateChanged: true };
  });
}

/** Back out of the box. The state flag only in Phase 1 (§6). */
export function reopenRoom(id: string, opts: RoomActionOpts): RoomAction<Room> {
  return roomAction((d) => {
    const room = requireRoom(d, id);
    if (room.state === 'open') {
      throw new RoomError(409, 'the room is already open', 'state');
    }
    if (room.parent_id !== null && roomRow(d, room.parent_id)?.state === 'archived') {
      throw new RoomError(409, 'reopen its main room first', 'state');
    }
    if (room.alias !== null) {
      /* the alias was freed while it was archived; it may have been taken since */
      validAlias(d, room.alias, room.id, room.parent_id);
    }
    d.prepare(`UPDATE rooms SET state='open', archived_at=NULL, updated_at=? WHERE id=?`).run(Date.now(), id);
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, id, opts, null);
    if (cmd) {
      entries.push(cmd);
    }
    entries.push(writeFact(d, id, 'the room was reopened', null, cmd));
    return { roomId: id, result: roomRow(d, id)!, entries, stateChanged: true };
  });
}

/* ---------------------------------------------------------------- seats ---- */

export type OccupantInput = string | { kind: OccupantKind; id?: string | null; pool_size?: number | null } | null;

/** The recipe a paneid belongs to: the session row's column when there is
 *  one (the store's own rule — read the column, not the handle), else the
 *  `recipe:<id>#` prefix. */
function recipeOfPane(d: Database.Database, paneid: string): string | null {
  const row = d.prepare(`SELECT recipe_id FROM sessions WHERE paneid=?`).get(paneid) as { recipe_id: string | null } | undefined;
  if (row?.recipe_id) {
    return row.recipe_id;
  }
  return paneid.startsWith('recipe:') ? paneid.slice('recipe:'.length).split('#')[0] || null : null;
}

function normalizeOccupant(occ: OccupantInput): { kind: string; id: string | null; pool_size: number | null } {
  if (occ === null || occ === undefined) {
    return { kind: 'none', id: null, pool_size: null };
  }
  if (typeof occ === 'string') {
    if (!occ.trim()) {
      throw new RoomError(400, 'an occupant paneid cannot be empty', 'occupant');
    }
    return { kind: 'pane', id: occ, pool_size: null };
  }
  if (typeof occ !== 'object') {
    throw new RoomError(400, 'occupant is a paneid or {kind, id}', 'occupant');
  }
  const kind = occ.kind as string;
  const id = typeof occ.id === 'string' && occ.id.trim() ? occ.id : null;
  if ((kind === 'pane' || kind === 'task') && !id) {
    throw new RoomError(400, `a ${kind} occupant needs an id`, 'occupant');
  }
  let pool: number | null = null;
  if (kind === 'pool') {
    pool = occ.pool_size ?? null;
    if (pool !== null && (!Number.isInteger(pool) || pool < 1)) {
      throw new RoomError(400, 'pool_size is a positive integer', 'pool_size');
    }
  }
  // An unknown kind falls through to the CHECK, which names the column.
  return { kind, id: kind === 'pane' || kind === 'task' ? id : null, pool_size: pool };
}

/** One pane holds at most one active seat per room — it is what lets a
 *  `from:{paneid}` post resolve to exactly one author. */
function assertPaneFree(d: Database.Database, roomId: string, paneid: string, exceptSeat: string | null): void {
  const clash = d
    .prepare(
      `SELECT handle FROM room_seats WHERE room_id=? AND left_at IS NULL AND occupant_kind='pane' AND occupant=? AND id IS NOT ?`,
    )
    .get(roomId, paneid, exceptSeat) as { handle: string } | undefined;
  if (clash) {
    throw new RoomError(409, `that pane already holds @${clash.handle} in this room`, 'occupant');
  }
}

/** Fill a seat's occupant columns (and, for a pane, the recipe + slug caches). */
function writeOccupant(
  d: Database.Database,
  seat: { id: string; room_id: string; recipe_id: string | null },
  occ: { kind: string; id: string | null; pool_size: number | null },
  now: number,
): void {
  let recipeId = seat.recipe_id;
  let slug: string | null = null;
  if (occ.kind === 'pane' && occ.id) {
    assertPaneFree(d, seat.room_id, occ.id, seat.id);
    recipeId = recipeOfPane(d, occ.id) ?? recipeId;
    slug = (d.prepare(`SELECT agent FROM sessions WHERE paneid=?`).get(occ.id) as { agent: string | null } | undefined)?.agent ?? null;
  }
  d.prepare(
    `UPDATE room_seats SET occupant_kind=?, occupant=?, occupant_since=?, pool_size=?, recipe_id=?, slug=? WHERE id=?`,
  ).run(
    occ.kind,
    occ.id,
    occ.kind === 'none' ? null : now,
    occ.kind === 'pool' ? occ.pool_size : null,
    recipeId,
    slug,
    seat.id,
  );
}

const describeOccupant = (kind: string, id: string | null, pool: number | null): string =>
  kind === 'none' ? 'nobody' : kind === 'pool' ? `a pool of ${pool ?? '?'}` : `${kind} ${id}`;

/**
 * Add a seat. The handle is TYPED (normalised; reserved -> 400; taken -> 409)
 * or DERIVED from the project label (placeholder-suffixed on a collision). The
 * first persistent seat of a lead-less room becomes lead (§1.6 rule 3); a
 * transient first seat does NOT, because silently overriding a user's policy
 * decision is worse than a room that says "no lead".
 */
export function addSeat(
  roomId: string,
  input: {
    project?: string | null;
    recipe_id?: string | null;
    handle?: string | null;
    policy?: SeatPolicy | string | null;
    occupant?: OccupantInput;
    pool_size?: number | null;
    /** false = leave the lead to the caller (assemble binds a whole list and
     *  then names the lead itself, so rule 3 must not pick one mid-batch). */
    autoLead?: boolean;
    /** Handles a DERIVED handle must treat as taken: the ones other rows of
     *  the same call typed, so a derived row steps aside to its placeholder
     *  instead of taking a name the user chose (assemble, review 2 f6). */
    avoid?: readonly string[];
  },
  opts: RoomActionOpts,
): RoomAction<RoomSeat> {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    requireOpen(room);
    const inp = input ?? {};
    let recipeId: string | null = null;
    let project = typeof inp.project === 'string' && inp.project.trim() ? inp.project.trim() : null;
    if (inp.recipe_id !== undefined && inp.recipe_id !== null) {
      const recipe = typeof inp.recipe_id === 'string' ? getRecipe(inp.recipe_id) : undefined;
      if (!recipe) {
        throw new RoomError(400, 'no such recipe', 'recipe_id');
      }
      recipeId = recipe.id;
      project = project ?? (recipe.projectDir ? projectBasename(recipe.projectDir) : null) ?? recipe.name;
    }
    const typed = inp.handle !== undefined && inp.handle !== null && inp.handle !== '';
    if (!project && !typed) {
      throw new RoomError(400, 'a seat needs a project, a recipe_id or a handle', 'project');
    }
    let handle: string;
    let named: number;
    if (typed) {
      handle = normalizeHandle(inp.handle);
      named = 1;
      const clash = handleClash(d, roomId, handle, null);
      if (clash) {
        throw new RoomError(409, clash, 'handle');
      }
    } else {
      ({ handle, named } = freeHandle(d, roomId, normalizeSlug(project) ?? 'member', inp.avoid));
    }
    const explicitPolicy = inp.policy !== undefined && inp.policy !== null;
    const policy = explicitPolicy ? String(inp.policy) : 'persistent';
    const occ = normalizeOccupant(
      policy === 'pool' && (inp.occupant === undefined || inp.occupant === null) && inp.pool_size
        ? { kind: 'pool', pool_size: inp.pool_size }
        : (inp.occupant ?? null),
    );
    const now = Date.now();
    const pos = (d.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM room_seats WHERE room_id=?`).get(roomId) as { p: number }).p;
    const id = randomUUID();
    d.prepare(
      `INSERT INTO room_seats (id, room_id, handle, handle_named, project, recipe_id, policy, policy_set_by, policy_set_at,
                               occupant_kind, position, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?)`,
    ).run(
      id,
      roomId,
      handle,
      named,
      project,
      recipeId,
      policy,
      explicitPolicy ? actorLabel(opts.actor) : null,
      explicitPolicy ? now : null,
      pos,
      actorLabel(opts.actor),
      now,
    );
    // A first fill ('none' -> anything) writes NO history row (§1.3).
    if (occ.kind !== 'none') {
      writeOccupant(d, { id, room_id: roomId, recipe_id: recipeId }, occ, now);
    }
    const becomesLead = inp.autoLead !== false && room.lead_seat === null && policy === 'persistent';
    if (becomesLead) {
      d.prepare(`UPDATE rooms SET lead_seat=?, updated_at=? WHERE id=?`).run(id, now, roomId);
    }
    const seat = seatRow(d, id)!;
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, roomId, opts, seat);
    if (cmd) {
      entries.push(cmd);
    }
    entries.push(
      writeFact(d, roomId, `@${handle} was added to the room${policy !== 'persistent' ? ` (${policy}: forgets by design)` : ''}`, seat, cmd, {
        project,
        policy,
        occupant: occ.kind === 'none' ? null : { kind: occ.kind, id: occ.id },
      }),
    );
    if (becomesLead) {
      entries.push(writeFact(d, roomId, `@${handle} is now the lead`, seat, cmd, { from: null, to: id }));
    }
    return { roomId, result: seat, entries, stateChanged: true };
  });
}

/**
 * Rename a seat's handle and/or change its policy. The lead seat cannot leave
 * `persistent` (§1.6 rule 2). A policy change applies to the NEXT engagement —
 * it never touches the occupant (wr §2.7). A rename changes nothing but the
 * address: not the slug, not the session name, not the mailbox.
 */
export function updateSeat(
  roomId: string,
  seatId: string,
  patch: { handle?: string | null; policy?: SeatPolicy | string | null; pool_size?: number | null },
  opts: RoomActionOpts,
): RoomAction<RoomSeat> {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    requireOpen(room);
    const seat = requireSeat(d, roomId, seatId);
    const p = patch ?? {};
    const handle = p.handle !== undefined && p.handle !== null ? normalizeHandle(p.handle) : seat.handle;
    const policy = p.policy !== undefined && p.policy !== null ? String(p.policy) : seat.policy;
    if (seat.is_lead && policy !== 'persistent') {
      throw new RoomError(409, `@${seat.handle} is the lead, and the lead must be persistent — hand the lead over first`, 'policy');
    }
    let pool = seat.pool_size;
    if (p.pool_size !== undefined) {
      if (p.pool_size !== null && (!Number.isInteger(p.pool_size) || p.pool_size < 1)) {
        throw new RoomError(400, 'pool_size is a positive integer', 'pool_size');
      }
      pool = p.pool_size;
    }
    const handleChanged = handle !== seat.handle;
    if (handleChanged) {
      const clash = handleClash(d, roomId, handle, seat.id);
      if (clash) {
        throw new RoomError(409, clash, 'handle');
      }
    }
    const policyChanged = policy !== seat.policy;
    const poolChanged = pool !== seat.pool_size;
    if (!handleChanged && !policyChanged && !poolChanged) {
      return { roomId, result: seat, entries: [], stateChanged: false };
    }
    const now = Date.now();
    // The unique partial index is the backstop; mapRoomDbError turns it into 409 field:'handle'.
    d.prepare(
      `UPDATE room_seats SET handle=?, handle_named=?, policy=?, policy_set_by=?, policy_set_at=?, pool_size=? WHERE id=?`,
    ).run(
      handle,
      handleChanged ? 1 : seat.handle_named,
      policy,
      policyChanged ? actorLabel(opts.actor) : seat.policy_set_by,
      policyChanged ? now : seat.policy_set_at,
      pool,
      seatId,
    );
    const after = seatRow(d, seatId)!;
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, roomId, opts, seat); // the handle AS TYPED, before the rename
    if (cmd) {
      entries.push(cmd);
    }
    if (handleChanged) {
      entries.push(writeFact(d, roomId, `@${seat.handle} is now @${handle}`, after, cmd, { from: seat.handle, to: handle }));
    }
    if (policyChanged) {
      const note = policy === 'persistent' ? 'a colleague, resumed' : 'forgets by design';
      entries.push(
        writeFact(d, roomId, `@${handle} policy: ${policy} (${note}; applies to the next engagement)`, after, cmd, {
          from: seat.policy,
          to: policy,
        }),
      );
    }
    if (poolChanged && !policyChanged) {
      entries.push(writeFact(d, roomId, `@${handle} pool size: ${pool ?? 'unset'}`, after, cmd, { from: seat.pool_size, to: pool }));
    }
    return { roomId, result: after, entries, stateChanged: true };
  });
}

/** Retire the current occupant into history (former occupants only). */
function retireOccupant(d: Database.Database, seat: RoomSeat, reason: string, ref: string | null, now: number): SeatHistoryRow | null {
  if (seat.occupant_kind === 'none') {
    return null;
  }
  const info = d
    .prepare(
      `INSERT INTO room_seat_history (seat_id, occupant_kind, occupant, from_ts, to_ts, reason, ref) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(seat.id, seat.occupant_kind, seat.occupant, seat.occupant_since, now, reason, ref);
  return d.prepare(`SELECT * FROM room_seat_history WHERE id=?`).get(info.lastInsertRowid) as SeatHistoryRow;
}

/**
 * Give up a seat. NEVER deletes: sets left_at, closes the occupant into history
 * as `evicted`, empties the occupant, frees the handle (the unique index only
 * covers active seats). The lead seat is refused until the lead is handed
 * over (§1.6 rule 4, §0.1 Q3) — UNLESS `allowLeadRemoval` (seat reload,
 * ticket): the caller is about to re-add a seat of the same handle/policy
 * and hand the lead straight back (table.updateRoom lead_seat), so the room's
 * leadless window is internal to one orchestrated operation, never the public
 * remove verb's. `updateRoom`'s own `lead_seat: null` refusal ("the lead can
 * be handed over, not removed") stays in force for every OTHER caller.
 */
export function removeSeat(roomId: string, seatId: string, opts: RoomActionOpts & { allowLeadRemoval?: boolean }): RoomAction<RoomSeat> {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    const seat = requireSeat(d, roomId, seatId);
    if (seat.is_lead) {
      if (!opts.allowLeadRemoval) {
        throw new RoomError(409, 'hand the lead over first', 'seat');
      }
      d.prepare(`UPDATE rooms SET lead_seat=NULL, updated_at=? WHERE id=?`).run(Date.now(), room.id);
    }
    const now = Date.now();
    d.prepare(
      `UPDATE room_seats SET left_at=?, occupant_kind='none', occupant=NULL, occupant_since=NULL, pool_size=NULL WHERE id=?`,
    ).run(now, seatId);
    const hist = retireOccupant(d, seat, 'evicted', null, now);
    releaseSeatTasks(d, seatId, now); // Tasks: its open stretches close, the tasks it had claimed are unclaimed (still open for someone else)
    const after = seatRow(d, seatId)!;
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, roomId, opts, seat);
    if (cmd) {
      entries.push(cmd);
    }
    entries.push(
      writeFact(d, roomId, `@${seat.handle} left the room${hist ? ' (former occupant retained in history)' : ''}`, after, cmd, {
        history: hist ? hist.id : null,
      }),
    );
    return { roomId, result: after, entries, stateChanged: true };
  });
}

/**
 * Replace (or fill, or empty) a seat's occupant, keeping the seat. The current
 * occupant is RETIRED to history — from_ts = its occupant_since, to_ts = now —
 * never deleted, because extraction runs against it afterwards (wr §2.7). A
 * first fill writes no history row. For a pane, recipe_id is rewritten from the
 * pane and the slug cache from sessions.agent, in the same transaction.
 *
 * Order matters and is deliberate: the seat is updated BEFORE the history row
 * is written, so a failing history insert (a CHECK on `reason`) proves the
 * transaction rolls the seat back too.
 */
export function setOccupant(
  roomId: string,
  seatId: string,
  occupant: OccupantInput,
  opts: RoomActionOpts & { reason?: HistoryReason | string; ref?: string | null },
): RoomAction<RoomSeat> {
  return roomAction((d) => {
    requireRoom(d, roomId);
    const seat = requireSeat(d, roomId, seatId);
    const occ = normalizeOccupant(occupant);
    if (occ.kind === seat.occupant_kind && occ.id === seat.occupant && occ.pool_size === seat.pool_size) {
      return { roomId, result: seat, entries: [], stateChanged: false };
    }
    const now = Date.now();
    writeOccupant(d, seat, occ, now);
    const reason = opts.reason ?? (occ.kind === 'none' ? 'evicted' : 'replaced');
    const hist = retireOccupant(d, seat, reason, opts.ref ?? null, now);
    const after = seatRow(d, seatId)!;
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, roomId, opts, seat);
    if (cmd) {
      entries.push(cmd);
    }
    const next = describeOccupant(occ.kind, occ.id, occ.pool_size);
    const body = !hist
      ? `@${seat.handle} is now filled by ${next}`
      : occ.kind === 'none'
        ? `@${seat.handle} is empty (${reason}; former occupant retained in history)`
        : `@${seat.handle}: occupant ${reason}, now ${next} (former occupant retained in history)`;
    entries.push(
      writeFact(d, roomId, body, after, cmd, {
        from: seat.occupant_kind === 'none' ? null : { kind: seat.occupant_kind, id: seat.occupant },
        to: occ.kind === 'none' ? null : { kind: occ.kind, id: occ.id },
        reason: hist ? reason : null,
        history: hist ? hist.id : null,
      }),
    );
    return { roomId, result: after, entries, stateChanged: true };
  });
}

/**
 * A seat's OWN recipe was started for it (roster verbs, 2026-09-25): bind the
 * launched pane and say who asked, in ONE transaction. `paneid` equal to the
 * current occupant is a REHYDRATE (the same pane comes back) — nothing is
 * rebound and no history is written; anything else replaces the occupant
 * (history reason 'replaced', exactly as setOccupant) or fills an empty seat.
 * The fact is always "@<handle> started by <actor>". The room must be open:
 * archive is stasis (wr §2.7b). Liveness and policy are the ROUTE's checks —
 * the pane usually has no session row yet (the pty spawns when a viewer
 * attaches), so this never asks the table whether it is live.
 */
export function startSeat(
  roomId: string,
  seatId: string,
  paneid: string,
  opts: RoomActionOpts & { mode: 'rehydrate' | 'fresh' },
): RoomAction<RoomSeat> {
  return roomAction((d) => {
    requireOpen(requireRoom(d, roomId));
    const seat = requireSeat(d, roomId, seatId);
    if (typeof paneid !== 'string' || !paneid) {
      throw new RoomError(400, 'a started seat is bound to a paneid', 'paneid');
    }
    const by = authorOf(d, roomId, opts.actor);
    const now = Date.now();
    const same = seat.occupant_kind === 'pane' && seat.occupant === paneid;
    let hist: SeatHistoryRow | null = null;
    if (!same) {
      writeOccupant(d, seat, { kind: 'pane', id: paneid, pool_size: null }, now);
      hist = retireOccupant(d, seat, 'replaced', null, now);
    }
    const after = seatRow(d, seatId)!;
    const actor = by.author === 'user' ? 'user' : `@${by.author}`;
    const entries: RoomLineEntry[] = [
      writeFact(d, roomId, `@${seat.handle} started by ${actor}`, after, null, {
        paneid,
        mode: opts.mode,
        by: by.author_seat ?? 'user',
        from: same || seat.occupant_kind === 'none' ? null : { kind: seat.occupant_kind, id: seat.occupant },
        reason: hist ? 'replaced' : null,
        history: hist ? hist.id : null,
      }),
    ];
    return { roomId, result: after, entries, stateChanged: true };
  });
}

/** Seats, lead first then tab order. Active only unless includeLeft. */
export function listSeats(roomId: string, q: { includeLeft?: boolean } = {}): RoomSeat[] {
  const d = rdb();
  if (!q.includeLeft) {
    return activeSeatRows(d, roomId);
  }
  return (
    d.prepare(`${SEAT_SELECT} WHERE s.room_id=? ORDER BY is_lead DESC, s.left_at IS NOT NULL, s.position`).all(roomId) as SeatRowRaw[]
  ).map((s) => hydrateSeat(s)!);
}

export function getSeat(seatId: string): RoomSeat | undefined {
  return seatRow(rdb(), seatId);
}

/** Former occupants of a seat, oldest first. */
export function listSeatHistory(seatId: string): SeatHistoryRow[] {
  return rdb().prepare(`SELECT * FROM room_seat_history WHERE seat_id=? ORDER BY id`).all(seatId) as SeatHistoryRow[];
}

/** The active seat holding a handle (`@` optional, case-insensitive). With
 *  includeLeft, falls back to the most recently departed holder. */
export function seatByHandle(roomId: string, handle: string, q: { includeLeft?: boolean } = {}): RoomSeat | undefined {
  const h = typeof handle === 'string' ? handle.replace(/^@/, '').toLowerCase() : '';
  const d = rdb();
  const active = d.prepare(`${SEAT_SELECT} WHERE s.room_id=? AND s.handle=? AND s.left_at IS NULL`).get(roomId, h) as SeatRowRaw | undefined;
  if (active || !q.includeLeft) {
    return hydrateSeat(active);
  }
  return hydrateSeat(
    d.prepare(`${SEAT_SELECT} WHERE s.room_id=? AND s.handle=? ORDER BY s.left_at DESC LIMIT 1`).get(roomId, h) as SeatRowRaw | undefined,
  );
}

/** Which rooms hold this paneid, and in which seat (roster and placement). */
export function roomsForPane(paneid: string, q: { includeLeft?: boolean } = {}): Array<{ room: Room; seat: RoomSeat }> {
  const d = rdb();
  const seats = (
    d.prepare(`${SEAT_SELECT} WHERE s.occupant_kind='pane' AND s.occupant=?${q.includeLeft ? '' : ' AND s.left_at IS NULL'} ORDER BY s.added_at`).all(paneid) as SeatRowRaw[]
  ).map((s) => hydrateSeat(s)!);
  return seats.map((seat) => ({ room: roomRow(d, seat.room_id)!, seat }));
}

/**
 * Active seats whose fill source is this recipe (the recipe-DELETE 409).
 *
 * SEATS IN AN ARCHIVED ROOM DO NOT COUNT (2026-09-25). Archive is stasis
 * (wr §2.7b): nothing starts in a box, so nothing there is "filled from" the
 * recipe any more. Counting them pinned a recipe forever whenever the archived
 * room's only seat was its lead — the lead cannot be removed before a
 * hand-over and a box cannot be edited, so the 409 had no way out (observed:
 * the scratch "Probe room" and recipe 451bacb1). The archived seat keeps its
 * row and history untouched; its `recipe_id` is left DANGLING, which the read
 * side already handles (seatActions offers nothing for a missing recipe, the
 * vendor reads `unknown`). Reopening such a room shows that seat with no Start.
 */
export function activeSeatsForRecipe(recipeId: string): RoomSeat[] {
  return (
    rdb()
      .prepare(`${SEAT_SELECT} WHERE s.recipe_id=? AND s.left_at IS NULL AND r.state <> 'archived'`)
      .all(recipeId) as SeatRowRaw[]
  ).map((s) => hydrateSeat(s)!);
}

/* ----------------------------------------------------------------- line ---- */

export interface LineInput {
  kind: LineKind | string;
  body?: string | null;
  /** The typed address token (`the design system`, `@the design system`, `room`, `lead`), or null /
   *  absent for none. For chat, command and attachment, NONE means THE LEAD
   *  as of this write; a room with no lead refuses it. For fact and delivery,
   *  none means none. */
  target?: string | null;
  ref?: string | null;
  meta?: Record<string, unknown> | null;
  /** Write as the Room (an engine delivery report), not as the actor. */
  asRoom?: boolean;
  /** Addressed to THE USER (`@user` or their @name, led by it with no seat
   *  — rooms.ts userAddressed): stored as target = this handle (`user`
   *  already normalised to it; display only) with NO seat — never the lead
   *  default, never refused as an unknown seat. */
  toUser?: string | null;
  /** CROSS-POST (Owner 2026-10-04): the OTHER rooms this line also appears in
   *  (as incoming), with the handles it reached there. Written with the line,
   *  in the same transaction. */
  xposts?: Array<{ room_id: string; handles: string[] }>;
  /** [address only] Named nobody, and unaddressed lines do not go to the lead
   *  (Settings -> Agent comms): stored with no target and NO seat, never the lead. */
  noLead?: boolean;
}

/** Resolve a typed address token to {target, target_seat} at WRITE time. */
function resolveTarget(
  d: Database.Database,
  room: Room,
  token: string | null | undefined,
  leadDefault: boolean,
): { target: string | null; target_seat: string | null } {
  const noLead = (): RoomError => new RoomError(409, 'no lead yet — `/set lead @<handle>`', 'target');
  if (token === undefined || token === null || token === '') {
    if (!leadDefault) {
      return { target: null, target_seat: null };
    }
    if (!room.lead_seat) {
      throw noLead();
    }
    // "no @" is encoded exactly once: target NULL, target_seat = the lead now.
    return { target: null, target_seat: room.lead_seat };
  }
  if (typeof token !== 'string') {
    throw new RoomError(400, 'target is an address token', 'target');
  }
  const t = token.replace(/^@/, '').toLowerCase();
  if (t === 'room') {
    return { target: 'room', target_seat: null };
  }
  if (t === 'all') {
    throw new RoomError(400, '@all is not in this build — cross-room addressing needs the fabric; @room reaches this room', 'target');
  }
  if (t === 'user') {
    throw new RoomError(400, '@user is not an address on the room line', 'target');
  }
  if (t === 'lead') {
    /* `@lead` is the HEAD room's lead, always: in a workgroup that is the main
       room's lead, never the workgroup's own (Owner 2026-10-04). */
    const headId = room.parent_id ?? room.id;
    const lead = headId === room.id ? room.lead_seat : (roomRow(d, headId)?.lead_seat ?? null);
    if (!lead) {
      throw noLead();
    }
    return { target: 'lead', target_seat: lead };
  }
  /* A seat handle ANYWHERE in the family (this room first), else a room alias
     in the family -> that room's lead. Handles and aliases never collide. */
  const mine = d.prepare(`SELECT id, handle FROM room_seats WHERE room_id=? AND handle=? AND left_at IS NULL`).get(room.id, t) as
    | { id: string; handle: string }
    | undefined;
  const fam = familyIds(d, room.id);
  const seat =
    mine ??
    (d
      .prepare(`SELECT id, handle FROM room_seats WHERE handle=? AND left_at IS NULL AND room_id IN (${fam.map(() => '?').join(',')})`)
      .get(t, ...fam) as { id: string; handle: string } | undefined);
  if (seat) {
    return { target: seat.handle, target_seat: seat.id };
  }
  const aliased = d
    .prepare(`SELECT name, lead_seat FROM rooms WHERE alias=? AND state<>'archived' AND id IN (${fam.map(() => '?').join(',')})`)
    .get(t, ...fam) as { name: string; lead_seat: string | null } | undefined;
  if (aliased) {
    if (!aliased.lead_seat) {
      throw new RoomError(409, `"${aliased.name}" has no lead yet`, 'target');
    }
    return { target: t, target_seat: aliased.lead_seat };
  }
  throw new RoomError(400, `no seat @${t} in this room`, 'target');
}

/**
 * Append to the line: chat, a carried command plus its delivery report, an
 * attachment. One entry or a batch, ONE transaction. `commandText`, when given,
 * is written first as the verbatim `command` entry addressed like the first
 * input; every delivery / fact / attachment entry after a command or a chat in
 * the batch carries meta.cause = that entry's id (the words it reports on).
 *
 * The author is the ACTOR, never a caller-supplied field; `fact` is always
 * the Room's. There is deliberately no update or delete verb.
 */
export function appendLine(roomId: string, input: LineInput | LineInput[], opts: RoomActionOpts): RoomAction<RoomLineEntry[]> {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    requireOpen(room);
    const list = Array.isArray(input) ? [...input] : [input];
    if (opts.commandText !== undefined && opts.commandText !== null) {
      list.unshift({ kind: 'command', body: opts.commandText, target: list[0]?.target ?? null });
    }
    if (!list.length) {
      throw new RoomError(400, 'nothing to append', 'text');
    }
    const who = authorOf(d, roomId, opts.actor);
    const entries: RoomLineEntry[] = [];
    let cause: RoomLineEntry | null = null;
    for (const item of list) {
      const kind = String(item?.kind ?? '');
      if (kind === 'voice') {
        throw new RoomError(400, 'voice lines are written by the voice channel only', 'kind');
      }
      const words = kind === 'chat' || kind === 'command';
      if (words && (typeof item.body !== 'string' || !item.body.trim())) {
        throw new RoomError(400, 'text is required', 'text');
      }
      const addressed = words || kind === 'attachment';
      const tgt =
        typeof item.toUser === 'string' && item.toUser
          ? { target: item.toUser, target_seat: null }
          : resolveTarget(d, room, item.target, addressed && item.noLead !== true);
      const byRoom = kind === 'fact' || (kind === 'delivery' && item.asRoom === true);
      const meta = { ...(item.meta ?? {}) };
      if (cause && kind !== 'command' && kind !== 'chat' && meta.cause === undefined) {
        meta.cause = cause.id;
      }
      const entry = writeLine(d, roomId, {
        kind,
        ...(byRoom ? { author: 'room', author_seat: null } : who),
        ...tgt,
        body: item.body ?? null,
        ref: item.ref ?? null,
        meta,
      });
      if (kind === 'command' || kind === 'chat') {
        cause = entry;
      }
      if (item.xposts?.length) {
        /* A ROOM SHOWS EVERY LINE WRITTEN IN IT, PLUS EVERY LINE DELIVERED TO A
           SEAT IN IT. The line stays in the room it was written in; each other
           room it reached gets one row here. */
        const fam = new Set(familyIds(d, roomId));
        const ins = d.prepare(`INSERT OR REPLACE INTO room_line_xpost (line_id, room_id, handles) VALUES (?, ?, ?)`);
        for (const x of item.xposts) {
          if (x.room_id !== roomId && fam.has(x.room_id)) {
            ins.run(entry.id, x.room_id, JSON.stringify(x.handles));
          }
        }
        entry.xposts = item.xposts.filter((x) => x.room_id !== roomId && fam.has(x.room_id)).map((x) => x.room_id);
      }
      entries.push(entry);
    }
    return { roomId, result: entries, entries, stateChanged: false };
  });
}

/**
 * A PROXY line (the design notes P2): the Concierge relaying for the person.
 * Author is the reserved `concierge` (no seat, never a seat handle: RESERVED_HANDLES),
 * meta.proxy = 'user' always, never the person's own author ('user') — the line says
 * it is the Concierge's. It is a `chat` line addressed to ONE seat, ENGINE-INTERNAL
 * like the voice line (no HTTP input reaches it; its meta is the engine's own). The
 * unread filters exclude the author, so it never raises a badge or an alert.
 */
export function appendProxyLine(
  roomId: string,
  input: { target: string; body: string; meta?: Record<string, unknown> },
): RoomAction<RoomLineEntry[]> {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    requireOpen(room);
    if (typeof input.body !== 'string' || !input.body.trim()) {
      throw new RoomError(400, 'text is required', 'text');
    }
    const entry = writeLine(d, roomId, {
      kind: 'chat',
      author: 'concierge',
      author_seat: null,
      ...resolveTarget(d, room, input.target, false),
      body: input.body,
      meta: { ...(input.meta ?? {}), proxy: 'user' },
    });
    return { roomId, result: [entry], entries: [entry], stateChanged: false };
  });
}

/** The voice agent: a TOOL principal, never a seat (room-voice §6.1). */
export type VoiceLineAuthor = RoomActor | 'voice';

/** `vid` = 'v' + base36 of the line id (room-voice §10.3): short, sortable,
 *  and no new key space. */
export function vidOf(lineId: number): string {
  return `v${lineId.toString(36)}`;
}

/**
 * Append ONE `voice` line (room-voice §5, §7, §15) — the only writer of that
 * kind, and ENGINE-INTERNAL: no HTTP input reaches it, so its `meta` is the
 * engine's own (a caller's POST line still never sets meta). The body is DATA:
 * it never meets the room command parser, so a transcript starting with '/'
 * is stored as words, not run.
 *
 * Author per §15: `user` (dir in), a seat (dir out), or 'voice' (the voice
 * agent's own answer, author_seat null). `target` is a seat handle / `lead` /
 * `room` resolved at write time, or none. Every line's meta carries
 * `{via:'voice', dir, vid}`; `vid` is ALWAYS this line's own.
 */
export function appendVoiceLine(
  roomId: string,
  input: { author: VoiceLineAuthor; dir: 'in' | 'out'; body: string; target?: string | null; meta?: Record<string, unknown> },
): RoomAction<RoomLineEntry[]> {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    requireOpen(room);
    if (typeof input.body !== 'string' || !input.body.trim()) {
      throw new RoomError(400, 'text is required', 'text');
    }
    const who = input.author === 'voice' ? { author: 'voice', author_seat: null } : authorOf(d, roomId, input.author);
    const entry = writeLine(d, roomId, {
      kind: 'voice',
      ...who,
      ...resolveTarget(d, room, input.target, false),
      body: input.body,
      meta: { ...(input.meta ?? {}), via: 'voice', dir: input.dir },
    });
    const meta = { ...JSON.parse(entry.meta!), vid: vidOf(entry.id) }; // never a caller's: two lines cannot share a vid
    entry.meta = JSON.stringify(meta);
    d.prepare(`UPDATE room_line SET meta=? WHERE id=?`).run(entry.meta, entry.id);
    return { roomId, result: [entry], entries: [entry], stateChanged: false };
  });
}

/**
 * Read the line, oldest-to-newest in the page returned.
 *  - no cursor: the NEWEST `limit` entries;
 *  - since=<id>: page forward (id > since);
 *  - before=<id>: page back (id < before), the newest `limit` of those;
 *  - seat=<seat id>: author_seat OR target_seat, so a filter follows the SEAT
 *    across renames and occupants (wr §2.5e);
 *  - kind: one kind or several.
 */
export function listLine(
  roomId: string,
  q: { since?: number | null; before?: number | null; kind?: string | string[] | null; seat?: string | null; limit?: number | null } = {},
): RoomLineEntry[] {
  const d = rdb();
  /* a room shows every line written in it, plus every line cross-posted into it */
  const where = ['(room_id = ? OR id IN (SELECT line_id FROM room_line_xpost WHERE room_id = ?))'];
  const params: unknown[] = [roomId, roomId];
  const cursor = (v: unknown, field: string): number | null => {
    if (v === undefined || v === null || v === '') {
      return null;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new RoomError(400, `${field} is an entry id`, field);
    }
    return n;
  };
  const since = cursor(q.since, 'since');
  const before = cursor(q.before, 'before');
  let limit = LINE_PAGE_DEFAULT;
  if (q.limit !== undefined && q.limit !== null && (q.limit as unknown) !== '') {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LINE_PAGE_MAX) {
      throw new RoomError(400, `limit is 1-${LINE_PAGE_MAX}`, 'limit');
    }
  }
  if (since !== null) {
    where.push('id > ?');
    params.push(since);
  }
  if (before !== null) {
    where.push('id < ?');
    params.push(before);
  }
  if (q.kind !== undefined && q.kind !== null && q.kind !== '') {
    const kinds = (Array.isArray(q.kind) ? q.kind : String(q.kind).split(',')).map((k) => k.trim()).filter(Boolean);
    const bad = kinds.find((k) => !(LINE_KINDS as readonly string[]).includes(k));
    if (bad !== undefined || !kinds.length) {
      throw new RoomError(400, `kind is one of ${LINE_KINDS.join(', ')}`, 'kind');
    }
    where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  if (q.seat !== undefined && q.seat !== null && q.seat !== '') {
    where.push('(author_seat = ? OR target_seat = ?)');
    params.push(q.seat, q.seat);
  }
  const forward = since !== null;
  const rows = d
    .prepare(`SELECT * FROM room_line WHERE ${where.join(' AND ')} ORDER BY id ${forward ? 'ASC' : 'DESC'} LIMIT ?`)
    .all(...params, limit) as RoomLineEntry[];
  return forward ? rows : rows.reverse();
}

/** listLine with a KEEP rule applied BEFORE the page is cut (GET .../line?to=me): the page is `limit` lines that pass the rule, found by walking the room in id order in
 *  batches, so a rule that matches rarely still returns a full page from as far back as it takes. A page shorter than `limit` means the room is exhausted in that direction. */
export function listLineWhere(
  roomId: string,
  q: { since?: number | null; before?: number | null; kind?: string | string[] | null; seat?: string | null; limit?: number | null },
  keep: (e: RoomLineEntry) => boolean,
): RoomLineEntry[] {
  let limit = LINE_PAGE_DEFAULT;
  if (q.limit !== undefined && q.limit !== null && (q.limit as unknown) !== '') {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LINE_PAGE_MAX) {
      throw new RoomError(400, `limit is 1-${LINE_PAGE_MAX}`, 'limit');
    }
  }
  const forward = q.since !== undefined && q.since !== null && (q.since as unknown) !== '';
  const out: RoomLineEntry[] = [];
  let since = q.since;
  let before = q.before;
  for (;;) {
    const batch = listLine(roomId, { ...q, since, before, limit: LINE_PAGE_MAX });
    if (forward) {
      for (const e of batch) {
        if (keep(e)) {
          out.push(e);
          if (out.length === limit) return out;
        }
      }
      if (batch.length < LINE_PAGE_MAX) return out;
      since = batch[batch.length - 1].id;
    } else {
      for (let i = batch.length - 1; i >= 0; i--) {
        if (keep(batch[i])) {
          out.push(batch[i]);
          if (out.length === limit) return out.reverse();
        }
      }
      if (batch.length < LINE_PAGE_MAX) return out.reverse();
      before = batch[0].id;
    }
  }
}

/** THE HISTORY EXPORT's reads: the lines WRITTEN IN a room in [fromTs, toTs), oldest first, and when its first one was written. Hidden
 *  bookkeeping lines and delivery receipts are the caller's to drop. */
export function exportLines(roomId: string, fromTs: number, toTs: number): RoomLineEntry[] {
  return rdb()
    .prepare(`SELECT * FROM room_line WHERE room_id = ? AND ts >= ? AND ts < ? ORDER BY id ASC`)
    .all(roomId, fromTs, toTs) as RoomLineEntry[];
}
export function firstLineTs(roomId: string): number | null {
  const r = rdb().prepare('SELECT MIN(ts) AS t FROM room_line WHERE room_id = ?').get(roomId) as { t: number | null } | undefined;
  return r?.t ?? null;
}

/** SEARCH a room's line [search] Owner 2026-10-06: every line the room SHOWS (written in it or
 *  cross-posted into it) whose body holds EVERY word (case-insensitive LIKE, wildcards escaped),
 *  newest first. Words come from search-snippet.terms(); the snippet is cut by the caller. */
export function searchLines(roomId: string, words: readonly string[], limit = 50): RoomLineEntry[] {
  if (!words.length) return [];
  const d = rdb();
  const where = [
    '(room_id = ? OR id IN (SELECT line_id FROM room_line_xpost WHERE room_id = ?))',
    "kind IN ('chat','attachment','voice','fact')",
    'body IS NOT NULL',
  ];
  const params: unknown[] = [roomId, roomId];
  for (const w of words) {
    where.push(`body LIKE ? ESCAPE '${LIKE_ESCAPE}'`);
    params.push(likePattern(w));
  }
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  return d.prepare(`SELECT * FROM room_line WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params, n) as RoomLineEntry[];
}

/** THE LAST LINE of every room [room last] Owner 2026-10-07 (Workbench room cards): the newest chat or
 *  voice line written IN each room (not cross-posted copies), as {author, text, ts}, the text cut to
 *  `max` chars. One query for the whole list. */
export function lastLines(max = 160): Map<string, { author: string; text: string; ts: number }> {
  const rows = rdb()
    .prepare(
      `SELECT l.room_id, l.author, l.body, l.ts FROM room_line l
       JOIN (SELECT room_id, MAX(id) AS id FROM room_line WHERE kind IN ('chat','voice') AND body IS NOT NULL GROUP BY room_id) m ON m.id = l.id`,
    )
    .all() as Array<{ room_id: string; author: string; body: string; ts: number }>;
  const out = new Map<string, { author: string; text: string; ts: number }>();
  for (const r of rows) {
    const flat = String(r.body).split(String.fromCharCode(10)).join(' ').trim();
    out.set(r.room_id, { author: r.author, text: flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat, ts: r.ts });
  }
  return out;
}

/** How a cross-posted line reads in ONE room (Owner 2026-10-04, KB design-notes-id
 *  §10.4): `out` in the room it was written in, `in` in each room it reached,
 *  null when it was never cross-posted (or does not appear in `viewRoomId`).
 *  `local` (out only) = how many recipients sat in the author's own room: 0 means
 *  the line is OUTGOING ONLY there (nobody in that room got it). */
export interface XpostView {
  origin_room: string;
  origin_name: string;
  direction: 'in' | 'out';
  local: number;
  targets: Array<{ room: string; room_name: string; alias: string | null; handle: string }>;
}
function buildXpost(
  d: Database.Database,
  entry: RoomLineEntry,
  rows: { room_id: string; handles: string }[],
  viewRoomId: string,
): XpostView | null {
  if (!rows.length) {
    return null;
  }
  const direction = entry.room_id === viewRoomId ? 'out' : rows.some((r) => r.room_id === viewRoomId) ? 'in' : null;
  if (direction === null) {
    return null;
  }
  let local = 0;
  try {
    local = Number((entry.meta ? JSON.parse(entry.meta) : {}).xlocal ?? 0) || 0;
  } catch {
    local = 0;
  }
  const targets: XpostView['targets'] = [];
  for (const r of rows) {
    if (direction === 'in' && r.room_id !== viewRoomId) {
      continue;
    }
    const room = roomRow(d, r.room_id);
    for (const h of JSON.parse(r.handles) as string[]) {
      targets.push({ room: r.room_id, room_name: room?.name ?? '?', alias: room?.alias ?? null, handle: h });
    }
  }
  return { origin_room: entry.room_id, origin_name: roomRow(d, entry.room_id)?.name ?? '?', direction, local, targets };
}

export function xpostView(entry: RoomLineEntry, viewRoomId: string): XpostView | null {
  const d = rdb();
  return buildXpost(d, entry, d.prepare(`SELECT room_id, handles FROM room_line_xpost WHERE line_id=?`).all(entry.id) as { room_id: string; handles: string }[], viewRoomId);
}

/** The same for a page of entries in ONE query (the line poll's hot path):
 *  entry id -> view, only for entries that were cross-posted. */
export function xpostViews(entries: RoomLineEntry[], viewRoomId: string): Map<number, XpostView> {
  const out = new Map<number, XpostView>();
  if (!entries.length) {
    return out;
  }
  const d = rdb();
  const ids = entries.map((e) => e.id);
  const rows = d
    .prepare(`SELECT line_id, room_id, handles FROM room_line_xpost WHERE line_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { line_id: number; room_id: string; handles: string }[];
  const by = new Map<number, { room_id: string; handles: string }[]>();
  for (const r of rows) {
    (by.get(r.line_id) ?? by.set(r.line_id, []).get(r.line_id)!).push(r);
  }
  for (const e of entries) {
    const v = buildXpost(d, e, by.get(e.id) ?? [], viewRoomId);
    if (v) {
      out.set(e.id, v);
    }
  }
  return out;
}

/** The rooms this line was cross-posted INTO (for the bus announce). */
export function xpostRooms(lineId: number): string[] {
  return (rdb().prepare(`SELECT room_id FROM room_line_xpost WHERE line_id=?`).all(lineId) as { room_id: string }[]).map((r) => r.room_id);
}

/* ----------------------------------------------------- the person's badge ---- */
/* WORKGROUP BADGE (Owner 2026-10-04): per PERSON per ROOM, "lines newer than the
   last one you saw". What counts: words (chat, attachment, voice) from someone
   else — a seat or the voice agent — written in the room OR cross-posted into
   it. Your own lines, facts, delivery reports and commands never raise it. */
const UNREAD_KINDS = `'chat','attachment','voice'`;
/** What the "to me" view counts as addressed to the person (the badge's countToMe, and the chatter
 *  report's to-person count [chatter]): ONE predicate so the two cannot drift. */
const TO_ME_SQL = `(
          kind = 'voice' OR target = 'room'
          OR (json_valid(meta) AND (json_extract(meta, '$.to_user') = 1 OR (json_extract(meta, '$.reply.user') = 1 AND target IS NULL)))
          OR (target IS NULL AND author_seat IS NOT NULL AND author_seat = target_seat)
        )
        AND NOT (json_valid(meta) AND json_extract(meta, '$.tool') IS NOT NULL AND IFNULL(json_extract(meta, '$.for'), '') <> 'user')`;

/** The newest line id this room SHOWS (own or cross-posted in), 0 if none. */
function newestVisible(d: Database.Database, roomId: string): number {
  const r = d
    .prepare(
      `SELECT MAX(id) AS m FROM room_line
        WHERE room_id=? OR id IN (SELECT line_id FROM room_line_xpost WHERE room_id=?)`,
    )
    .get(roomId, roomId) as { m: number | null };
  return r.m ?? 0;
}

/** Unread counts for every room, for one person. A room this person has no
 *  cursor for yet is initialised to "now" (their first look is not a backlog). */
export function unreadByRoom(userKey: string): Record<string, number> {
  return unreadCounts(userKey).unread;
}

/** BOTH counts for every room in one read: `unread` (the room's feed rule, what the badge has always been) and `toMe`
 *  (always the lines addressed to the person: unread_to_me on the wire). */
export function unreadCounts(userKey: string): { unread: Record<string, number>; toMe: Record<string, number> } {
  const unread: Record<string, number> = {};
  const toMe: Record<string, number> = {};
  for (const [id, v] of unreadCore(userKey)) {
    unread[id] = v.n;
    toMe[id] = v.nMe;
  }
  return { unread, toMe };
}

/** CROSS-FAMILY UNREAD [cross unread] (Owner 2026-10-06): one person-scoped read over EVERY open room, for the alert that
 *  must not stop at the current room's family. Built on the same count as the badge (so it counts exactly what the room's
 *  default view shows, origin room only); `newestId` is the newest COUNTED line, so "View" can open the room that has
 *  the newest one. A room with nothing unread is listed too (unread 0, newestId null). */
export interface RoomUnread {
  roomId: string;
  name: string;
  familyHeadId: string;
  unread: number;
  newestId: number | null;
  /** always the lines addressed to the person (see unreadCounts), and the newest of them */
  unread_to_me: number;
  newest_to_me: number | null;
  color: string | null;
}
export function unreadDetail(userKey: string): RoomUnread[] {
  const d = rdb();
  const core = unreadCore(userKey);
  const rows = d.prepare(`SELECT id, name, parent_id, color FROM rooms WHERE state='open' ORDER BY created_at, rowid`).all() as {
    id: string;
    name: string;
    parent_id: string | null;
    color: string | null;
  }[];
  return rows.map((r) => {
    const v = core.get(r.id);
    return {
      roomId: r.id,
      name: r.name,
      familyHeadId: r.parent_id ?? r.id,
      unread: v?.n ?? 0,
      newestId: v && v.n > 0 ? v.m : null,
      unread_to_me: v?.nMe ?? 0,
      newest_to_me: v && v.nMe > 0 ? v.mMe : null,
      color: r.color,
    };
  });
}

/** The shared count: per room, how many counted lines are newer than the person's cursor, and the newest of them. */
function unreadCore(userKey: string): Map<string, { n: number; m: number | null; nMe: number; mMe: number | null }> {
  const d = rdb();
  const out = new Map<string, { n: number; m: number | null; nMe: number; mMe: number | null }>();
  const rooms = d.prepare(`SELECT id, parent_id, feed_default FROM rooms`).all() as { id: string; parent_id: string | null; feed_default: string | null }[];
  /* THE BADGE COUNTS WHAT THE ROOM SHOWS (Owner 2026-10-06: badges and "new in X" alerts
     for workgroups whose "to me" view then showed nothing — they counted agent-to-agent
     lines). The room's default feed `who` (its own, else the main room's, the same
     inheritance rooms.ts effectiveDesign applies): 'me' counts only what web/room.js
     matchesWho('me') shows (voice, @room, addressed to the person, a reply to their line,
     the lead's unaddressed line; a tool line only when the person started it); anything
     else counts as before. KEEP THE TWO IN STEP. */
  const whoOf = (raw: string | null): string | null => {
    if (!raw) return null;
    try {
      const w = (JSON.parse(raw) as { who?: unknown }).who;
      return typeof w === 'string' ? w : '';
    } catch {
      return null;
    }
  };
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const effectiveWho = (r: { parent_id: string | null; feed_default: string | null }): string | null => {
    const own = whoOf(r.feed_default);
    if (own !== null) return own;
    const main = r.parent_id ? byId.get(r.parent_id) : undefined;
    const mw = main ? whoOf(main.feed_default) : null;
    return mw !== null && ['', 'me', 'agents'].includes(mw) ? mw : null;
  };
  const cur = new Map(
    (d.prepare(`SELECT room_id, last_seen_line_id FROM room_user_reads WHERE user_key=?`).all(userKey) as { room_id: string; last_seen_line_id: number }[]).map((r) => [
      r.room_id,
      r.last_seen_line_id,
    ]),
  );
  /* ORIGIN ROOM ONLY (Owner 2026-10-06): a line cross-posted into other rooms of the
     family is SHOWN there, but badges and raises the "new in X" notice only in the room
     it was written in. Counting it everywhere meant visiting every room to clear one line. */
  const count = d.prepare(
    `SELECT COUNT(*) AS n, MAX(id) AS m FROM room_line
      WHERE id > ? AND kind IN (${UNREAD_KINDS}) AND author NOT IN ('user','room','concierge')
        AND room_id=?`,
  );
  const countToMe = d.prepare(
    `SELECT COUNT(*) AS n, MAX(id) AS m FROM room_line
      WHERE id > ? AND kind IN (${UNREAD_KINDS}) AND author NOT IN ('user','room','concierge')
        AND ${TO_ME_SQL}
        AND room_id=?`,
  );
  for (const r of rooms) {
    let c = cur.get(r.id);
    if (c === undefined) {
      c = newestVisible(d, r.id);
      d.prepare(`INSERT OR IGNORE INTO room_user_reads (user_key, room_id, last_seen_line_id, updated_at) VALUES (?, ?, ?, ?)`).run(userKey, r.id, c, Date.now());
    }
    /* TWO NUMBERS (Owner 2026-10-25, [ref]): `n`/`m` follow the room's feed rule, as before; `nMe`/`mMe` are ALWAYS the
       lines addressed to the person (TO_ME_SQL), whatever the room's view is set to, so a badge that means "for you" can
       be rebuilt after a relaunch. In a room whose feed is "me" the two are the same query. */
    const me = countToMe.get(c, r.id) as { n: number; m: number | null };
    const got = effectiveWho(r) === 'me' ? me : (count.get(c, r.id) as { n: number; m: number | null });
    out.set(r.id, { n: got.n, m: got.m, nMe: me.n, mMe: me.m });
  }
  return out;
}

/** The person has seen this room up to `lineId` (monotonic: never moves back). */
export function markRoomSeen(userKey: string, roomId: string, lineId: unknown): number {
  const d = rdb();
  requireRoom(d, roomId);
  const n = Number(lineId);
  if (!Number.isInteger(n) || n < 0) {
    throw new RoomError(400, 'last_seen_line_id is a line entry id', 'last_seen_line_id');
  }
  d.prepare(
    `INSERT INTO room_user_reads (user_key, room_id, last_seen_line_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_key, room_id) DO UPDATE SET last_seen_line_id = MAX(last_seen_line_id, excluded.last_seen_line_id), updated_at = excluded.updated_at`,
  ).run(userKey, roomId, n, Date.now());
  return (d.prepare(`SELECT last_seen_line_id AS v FROM room_user_reads WHERE user_key=? AND room_id=?`).get(userKey, roomId) as { v: number }).v;
}

/**
 * MOVE a seat to another room of its family (Owner 2026-10-04, §10.5): the seat
 * ROW moves — same id, handle, occupant, session — so its history, its pane
 * and every line it wrote keep working; it is not removed and re-added. The old
 * room keeps its lines plus a "moved to ..." fact; the new room says it arrived.
 * Refused for the lead (hand the lead over first) and across families.
 */
export function moveSeat(roomId: string, seatId: string, toRoomId: string, opts: RoomActionOpts): RoomAction<RoomSeat> {
  return roomAction((d) => {
    const from = requireRoom(d, roomId);
    requireOpen(from);
    const seat = requireSeat(d, roomId, seatId);
    const entries: RoomLineEntry[] = [];
    const after = moveSeatIn(d, from, seat, toRoomId, entries, { opts, dissolving: false });
    return { roomId, result: after, entries, stateChanged: true, alsoStateFor: [after.room_id] };
  });
}

/** The ONE move path (moveSeat and dissolveWorkgroup both run it). Inside a
 *  transaction. `dissolving` lets the group's LEAD move: its lead pointer is
 *  cleared first, so the seat arrives as an ordinary seat, and no per-seat
 *  command line is written (the dissolve writes one). */
function moveSeatIn(
  d: Database.Database,
  from: Room,
  seat: RoomSeat,
  toRoomId: string,
  entries: RoomLineEntry[],
  ctx: { opts: RoomActionOpts; dissolving: boolean },
): RoomSeat {
  const to = typeof toRoomId === 'string' ? roomRow(d, toRoomId) : undefined;
  if (!to) {
    throw new RoomError(404, 'no such room to move to', 'to_room');
  }
  if (to.id === from.id) {
    throw new RoomError(400, `@${seat.handle} is already in "${to.name}"`, 'to_room');
  }
  requireOpen(to);
  if (headIdOf(from) !== headIdOf(to)) {
    throw new RoomError(409, 'a seat moves within its family (a room and its workgroups) only', 'to_room');
  }
  if (seat.is_lead && !ctx.dissolving) {
    throw new RoomError(409, `@${seat.handle} is the lead of "${from.name}" — hand the lead over first`, 'seat');
  }
  if (seat.occupant_kind === 'pane' && seat.occupant) {
    assertPaneFree(d, to.id, seat.occupant, seat.id);
  }
  const now = Date.now();
  if (seat.is_lead) {
    d.prepare(`UPDATE rooms SET lead_seat=NULL WHERE id=?`).run(from.id);
  }
  const pos = (d.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM room_seats WHERE room_id=?`).get(to.id) as { p: number }).p;
  d.prepare(`UPDATE room_seats SET room_id=?, position=? WHERE id=?`).run(to.id, pos, seat.id);
  d.prepare(`UPDATE rooms SET updated_at=? WHERE id IN (?, ?)`).run(now, from.id, to.id);
  const after = seatRow(d, seat.id)!;
  const cmd = ctx.dissolving ? null : writeCommand(d, from.id, ctx.opts, seat);
  if (cmd) {
    entries.push(cmd);
  }
  const dest = to.parent_id === null ? `the main room "${to.name}"` : `the ${to.name} workgroup`;
  entries.push(writeFact(d, from.id, `@${seat.handle} moved to ${dest} · same name, same session`, after, cmd, { to_room: to.id, moved: true }));
  entries.push(writeFact(d, to.id, `@${seat.handle} moved here from ${from.name} · same name, same session`, after, null, { from_room: from.id, moved: true }));
  return after;
}

/**
 * DISSOLVE A WORKGROUP (Owner [ref]): every active seat, the lead included,
 * returns to the main room through the same move path (same seat row, handle,
 * session, pane, lines); the emptied group is then ARCHIVED (closed, readable,
 * not deleted). All-or-nothing: one transaction.
 *   - the group's lead arrives as an ordinary seat; the main room's own lead
 *     is untouched; a main room with NO lead stays leaderless (no auto-promote,
 *     and the fact says so);
 *   - refused: a main room, an archived room, a group with open child groups
 *     (the model nests one level, so a guard only), a parent that is not open,
 *     a pane already held in the parent (assertPaneFree).
 * What hangs off the group and stays WITH the closed group, readable there:
 * lines, xposts, notes (+terms/sent), scratch, panels and room_apps (the
 * group's own tools), assets, drafts, per-person reads and prefs, voice rows,
 * seat history, brief. A seat's own state travels with its row. Seats that
 * already left stay in the group as history. Authority is the caller's.
 */
export function dissolveWorkgroup(
  roomId: string,
  opts: RoomActionOpts,
): RoomAction<{ moved: RoomSeat[]; parent: Room; closed: Room; parentHasLead: boolean }> {
  return roomAction((d) => {
    const group = requireRoom(d, roomId);
    if (group.parent_id === null) {
      throw new RoomError(409, `"${group.name}" is a main room, not a workgroup — only a workgroup can be dissolved`, 'id');
    }
    requireOpen(group);
    /* the family ROOT (headIdOf, the rule moveSeat checks), never an intermediate group (Owner [ref]) */
    const parent = requireRoom(d, headIdOf(group));
    requireOpen(parent);
    const kids = listWorkgroups(group.id).filter((w) => w.state === 'open');
    if (kids.length) {
      throw new RoomError(409, `dissolve its workgroups first: ${kids.map((w) => `"${w.name}"`).join(', ')}`, 'id');
    }
    const seats = activeSeatRows(d, group.id); // lead first
    const entries: RoomLineEntry[] = [];
    const cmd = writeCommand(d, group.id, opts, null);
    if (cmd) {
      entries.push(cmd);
    }
    const moved: RoomSeat[] = [];
    for (const seat of seats) {
      moved.push(moveSeatIn(d, group, seat, parent.id, entries, { opts, dissolving: true }));
    }
    const now = Date.now();
    d.prepare(`UPDATE rooms SET state='archived', archived_at=?, updated_at=?, lead_seat=NULL WHERE id=?`).run(now, now, group.id);
    const parentNow = roomRow(d, parent.id)!;
    const parentHasLead = parentNow.lead_seat !== null;
    const names = moved.map((s) => `@${s.handle}`);
    const list = names.length === 0 ? 'no seats' : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const wasLead = seats.find((s) => s.is_lead);
    const leadNote = wasLead
      ? ` The group's lead (@${wasLead.handle}) is an ordinary seat here${parentHasLead ? '.' : ', and this room has no lead.'}`
      : '';
    entries.push(
      writeFact(d, parent.id, `Workgroup ${group.name} dissolved: ${list} returned to this room; its history is kept.${leadNote}`, null, cmd, {
        dissolved: group.id,
        seats: moved.map((s) => s.id),
        parent_has_lead: parentHasLead,
      }),
    );
    entries.push(writeFact(d, group.id, `dissolved into ${parent.name}`, null, cmd, { dissolved_into: parent.id }));
    return {
      roomId: group.id,
      result: { moved, parent: parentNow, closed: roomRow(d, group.id)!, parentHasLead },
      entries,
      stateChanged: true,
      alsoStateFor: [parent.id],
    };
  });
}

export function getLineEntry(id: number): RoomLineEntry | undefined {
  return rdb().prepare(`SELECT * FROM room_line WHERE id=?`).get(id) as RoomLineEntry | undefined;
}

/**
 * [reply route] The person's lines a seat may be answering: written by `user` in
 * `roomId` (or cross-posted into it, with the handles it reached there), at or after
 * `since`, and newer than the seat's own last line in that room. Newest first, at most
 * `limit`. Walks room_line by (room_id, id) and the xpost index backwards and stops
 * at the window, so a long room history is never scanned.
 */
export function userLinesSinceSeat(roomId: string, seatId: string, since: number, limit = 20): Array<RoomLineEntry & { xhandles: string | null }> {
  const d = rdb();
  const own = (d.prepare(`SELECT MAX(id) AS id FROM room_line WHERE room_id=? AND author_seat=?`).get(roomId, seatId) as { id: number | null }).id ?? 0;
  const out: Array<RoomLineEntry & { xhandles: string | null }> = [];
  const take = (rows: Iterable<unknown>): void => {
    let n = 0;
    for (const r of rows as Iterable<RoomLineEntry & { xhandles: string | null }>) {
      if (r.ts < since || n >= limit) {
        break;
      }
      if (r.author === 'user' && USER_REPLY_KINDS.has(r.kind)) {
        out.push(r);
        n++;
      }
    }
  };
  take(
    d
      .prepare(`SELECT *, NULL AS xhandles FROM room_line WHERE room_id=? AND id>? ORDER BY id DESC`)
      .iterate(roomId, own),
  );
  take(
    d
      .prepare(`SELECT l.*, x.handles AS xhandles FROM room_line_xpost x JOIN room_line l ON l.id=x.line_id WHERE x.room_id=? AND x.line_id>? ORDER BY x.line_id DESC`)
      .iterate(roomId, own),
  );
  return out.sort((a, b) => b.id - a.id).slice(0, limit);
}
/* the person's words: a chat line or an attachment; a carried /command is not a question */
const USER_REPLY_KINDS = new Set(['chat', 'attachment']);

/** Entries per kind, for the diag (§2.6). Every kind is present, zero or not. */
export function lineCounts(roomId: string): Record<LineKind, number> {
  const out = Object.fromEntries(LINE_KINDS.map((k) => [k, 0])) as Record<LineKind, number>;
  for (const r of rdb().prepare(`SELECT kind, COUNT(*) AS n FROM room_line WHERE room_id=? GROUP BY kind`).all(roomId) as {
    kind: LineKind;
    n: number;
  }[]) {
    out[r.kind] = r.n;
  }
  return out;
}

/**
 * When a tool last posted a TOOL LINE for a seat in a room (rooms.ts
 * postToolLine: a seat's line with meta {tool: <slug>, for: <seat id>}), as
 * its ts; null = never [ticket]. The evidence that seat REQUESTED work from
 * that app: a panel action's `roomLine.to` may name it only then (rooms.ts
 * requesterSeat). A via-app line (meta.via_app) is never evidence.
 */
export function lastToolLineFor(roomId: string, slug: string, seatId: string): number | null {
  const r = rdb()
    .prepare(
      `SELECT MAX(ts) AS ts FROM room_line WHERE room_id=? AND kind='chat' AND author_seat IS NOT NULL AND json_valid(meta)
         AND json_extract(meta, '$.tool')=? AND json_extract(meta, '$.for')=?`,
    )
    .get(roomId, slug, seatId) as { ts: number | null } | undefined;
  return r?.ts ?? null;
}

/* ---- ENGINE SETTINGS (Owner 2026-10-04, item 6): SYSTEM-wide
 * key/value, one JSON value per key. Not per person: the idle-rest periods and
 * wake toggles are one answer for the whole engine. The caller owns the shape
 * and validates; the store only keeps the text. ---- */
export function getEngineSetting(key: string): unknown {
  const row = rdb().prepare('SELECT value FROM engine_settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) {
    return null;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return null; // an unreadable value is "never set"
  }
}

export function setEngineSetting(key: string, value: unknown): void {
  rdb()
    .prepare('INSERT INTO engine_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), Date.now());
}

/* ================================================================== apps ====
 * TOOL REGISTRY + ROOM APPS (the design notes §4.4, S4 engine half)
 * [rooms/apps-engine]. Two tables:
 *
 *   tool_registry: slug -> root -> pinned tool.json sha256. Written ONLY by a
 *   human (the route's job, not the store's — the store trusts `registered_by`
 *   it is given). A hash mismatch on re-read sets `held`; only `approve`
 *   (a fresh pin) clears it.
 *
 *   room_apps: a human-only membership row, room_id+slug. Distinct from a
 *   panel's self-declared `tool` — a panel does not make an app a member, and
 *   removing the app removes exactly the panels it owns (room_panels.app_slug).
 *
 * Both tables are ENGINE bookkeeping, not room verbs: no seat/actor authority
 * check here (the route enforces human-only), but membership changes DO write
 * a Room fact and go through `roomAction`/`writeFact` like every other room
 * change, so they show up on the line and announce like panels do.
 * ========================================================================== */

function ensureAppTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS engine_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_registry (
      slug          TEXT PRIMARY KEY,
      root          TEXT NOT NULL,
      name          TEXT NOT NULL,
      contract      TEXT NOT NULL,
      tool_sha256   TEXT NOT NULL,
      registered_by TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      held          INTEGER NOT NULL DEFAULT 0 CHECK(held IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS room_apps (
      room_id  TEXT NOT NULL,
      slug     TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_room_apps_slug ON room_apps(slug);
    CREATE TABLE IF NOT EXISTS tool_manage (
      slug             TEXT PRIMARY KEY,
      intent           TEXT CHECK(intent IN ('up','down')),
      boot_id          TEXT,
      intent_by        TEXT,
      intent_reason    TEXT,
      intent_at        INTEGER,
      scripts_sha      TEXT,
      scripts_by       TEXT,
      scripts_at       INTEGER
    );
  `);
  /* Additive [rooms/apps-sec]: the tool root's realpath, pinned beside the
     hash. NULL (a row from before the column) never matches, so such a tool
     is held until a human approves it once — fail closed. */
  const toolCols = new Set((database.prepare(`PRAGMA table_info(tool_registry)`).all() as { name: string }[]).map((c) => c.name));
  if (!toolCols.has('root_realpath')) {
    database.exec(`ALTER TABLE tool_registry ADD COLUMN root_realpath TEXT`);
  }
  /* the PINNED tool.json content + when it was pinned (additive, idempotent):
     what Approve compares the file on disk against (GET /api/apps/:slug/diff).
     A tool registered before this column has none: its diff is null. */
  if (!toolCols.has('tool_json')) {
    database.exec(`ALTER TABLE tool_registry ADD COLUMN tool_json TEXT`);
  }
  if (!toolCols.has('pinned_at')) {
    database.exec(`ALTER TABLE tool_registry ADD COLUMN pinned_at INTEGER`);
  }
  /* UNREGISTER [ticket] (additive, idempotent): a human took the app out of
     the catalog. The row, its pin and every room_apps row STAY (the app keeps
     its place in each room's rail; nothing of its data is touched) — only its
     actions are blocked, exactly as a held app's are. NULL = registered.
     Register again clears it; the OLD pin is kept, so a file that changed in
     the meantime still has to be approved. */
  if (!toolCols.has('unregistered_at')) {
    database.exec(`ALTER TABLE tool_registry ADD COLUMN unregistered_at INTEGER`);
  }
  if (!toolCols.has('unregistered_by')) {
    database.exec(`ALTER TABLE tool_registry ADD COLUMN unregistered_by TEXT`);
  }
  /* APP SUPERSESSION [app supersede] Owner 2026-10-05 (additive, idempotent):
     the slug of the app that answers this unregistered app's refs. Set only by
     a person's unregister; cleared when it is registered again. */
  if (!toolCols.has('superseded_by')) {
    database.exec(`ALTER TABLE tool_registry ADD COLUMN superseded_by TEXT`);
  }
}

export interface ToolRegistryRow {
  slug: string;
  root: string;
  name: string;
  contract: string;
  tool_sha256: string;
  registered_by: string;
  registered_at: number;
  held: boolean;
  /** realpath(root) when it was registered / last approved; null = unpinned. */
  root_realpath: string | null;
  /** the tool.json text pinned at registration / the last approval; null =
   *  pinned before the engine kept a copy */
  tool_json: string | null;
  /** when the current pin was made (registration or approval); null = before
   *  the engine recorded it (read registered_at) */
  pinned_at: number | null;
  /** when a human unregistered it (Settings → Apps) [ticket]; null = registered */
  unregistered_at: number | null;
  unregistered_by: string | null;
  /** the app that replaced it [app supersede]; null = none */
  superseded_by: string | null;
}
type ToolRegistryRowRaw = Omit<ToolRegistryRow, 'held'> & { held: number };
function hydrateTool(r: ToolRegistryRowRaw | undefined): ToolRegistryRow | undefined {
  return r ? { ...r, held: r.held === 1 } : undefined;
}

/** Pin a new tool (a human registration). Refuses a slug already registered —
 *  re-registering an existing one is `approveTool` (it re-pins the hash). */
export function registerTool(input: {
  slug: string;
  root: string;
  name: string;
  contract: string;
  tool_sha256: string;
  registered_by: string;
  root_realpath: string;
  tool_json?: string | null;
}): ToolRegistryRow {
  const d = rdb();
  if (d.prepare(`SELECT 1 FROM tool_registry WHERE slug=?`).get(input.slug)) {
    throw new RoomError(409, `"${input.slug}" is already registered`, 'slug');
  }
  const registered_at = Date.now();
  d.prepare(
    `INSERT INTO tool_registry (slug, root, name, contract, tool_sha256, registered_by, registered_at, held, root_realpath, tool_json, pinned_at)
     VALUES (@slug, @root, @name, @contract, @tool_sha256, @registered_by, @registered_at, 0, @root_realpath, @tool_json, @registered_at)`,
  ).run({ ...input, tool_json: input.tool_json ?? null, registered_at });
  return hydrateTool(toolRow(d, input.slug))!;
}

function toolRow(d: Database.Database, slug: string): ToolRegistryRowRaw | undefined {
  return d.prepare(`SELECT * FROM tool_registry WHERE slug=?`).get(slug) as ToolRegistryRowRaw | undefined;
}

export function getToolRegistry(slug: string): ToolRegistryRow | undefined {
  return hydrateTool(toolRow(rdb(), slug));
}

export function listToolRegistry(): ToolRegistryRow[] {
  return (rdb().prepare(`SELECT * FROM tool_registry ORDER BY registered_at`).all() as ToolRegistryRowRaw[]).map((r) => hydrateTool(r)!);
}

/** A catalog re-read found the pinned hash no longer matches the file on disk.
 *  true = this call HELD it (it was not held a moment ago): the one moment a
 *  room notice is due [ticket]. A second reader racing the first gets false. */
export function holdTool(slug: string): boolean {
  return rdb().prepare(`UPDATE tool_registry SET held=1 WHERE slug=? AND held=0`).run(slug).changes > 0;
}

/* THE TOOL MANAGER'S STATE [tool-manager]: the live intent (what an agent last asked for, stamped with the kernel boot id so a
   reboot can be told from an engine restart) and the pinned lifecycle-script digests a human approved. */
export interface ToolManageRow {
  slug: string;
  intent: 'up' | 'down' | null;
  boot_id: string | null;
  intent_by: string | null;
  intent_reason: string | null;
  intent_at: number | null;
  scripts_sha: string | null;
  scripts_by: string | null;
  scripts_at: number | null;
}
export function getToolManage(slug: string): ToolManageRow | undefined {
  return rdb().prepare(`SELECT * FROM tool_manage WHERE slug=?`).get(slug) as ToolManageRow | undefined;
}
export function setToolIntent(slug: string, intent: 'up' | 'down', bootId: string, by: string, reason: string | null): void {
  rdb()
    .prepare(
      `INSERT INTO tool_manage (slug, intent, boot_id, intent_by, intent_reason, intent_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET intent=excluded.intent, boot_id=excluded.boot_id, intent_by=excluded.intent_by, intent_reason=excluded.intent_reason, intent_at=excluded.intent_at`,
    )
    .run(slug, intent, bootId, by, reason, Date.now());
}
export function setToolScripts(slug: string, sha: string, by: string): void {
  rdb()
    .prepare(
      `INSERT INTO tool_manage (slug, scripts_sha, scripts_by, scripts_at) VALUES (?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET scripts_sha=excluded.scripts_sha, scripts_by=excluded.scripts_by, scripts_at=excluded.scripts_at`,
    )
    .run(slug, sha, by, Date.now());
}

/** A human unregisters an app [ticket]. true = it was registered a moment
 *  ago (so a room notice is due); false = no such app, or already out. */
export function unregisterTool(slug: string, by: string, supersededBy: string | null = null): boolean {
  const d = rdb();
  const changed = d.prepare(`UPDATE tool_registry SET unregistered_at=?, unregistered_by=?, superseded_by=? WHERE slug=? AND unregistered_at IS NULL`).run(Date.now(), by, supersededBy, slug).changes > 0;
  if (!changed && supersededBy) {
    d.prepare(`UPDATE tool_registry SET superseded_by=? WHERE slug=?`).run(supersededBy, slug); // already out: the replacement can still be named
  }
  return changed;
}

/** A human registers an UNREGISTERED app again: back in the catalog, on its
 *  OLD pin (held stays what it was; a changed file is caught by the next
 *  read and held for approval). undefined = no such row. */
export function reregisterTool(slug: string, hold = false): ToolRegistryRow | undefined {
  const d = rdb();
  d.prepare(`UPDATE tool_registry SET unregistered_at=NULL, unregistered_by=NULL, superseded_by=NULL${hold ? ', held=1' : ''} WHERE slug=?`).run(slug);
  return hydrateTool(toolRow(d, slug));
}

/** What an app's capability change says on a room's line [ticket]. */
export type AppNotice = 'held' | 'unregistered' | 'approved' | 'registered' | 'registered-held';
const APP_NOTICE: Record<AppNotice, (name: string) => string> = {
  held: (n) => `${n} is waiting for your approval · Settings → Apps`,
  unregistered: (n) => `${n} is not registered · Settings → Apps`,
  approved: (n) => `${n} was approved; its actions now work`,
  registered: (n) => `${n} was registered; its actions now work`,
  'registered-held': (n) => `${n} was registered and is waiting for your approval · Settings → Apps`,
};
/** the panel-side status each notice leaves the app in (the fact's meta) */
const APP_NOTICE_STATUS: Record<AppNotice, 'held' | 'unregistered' | 'enabled'> = {
  held: 'held', unregistered: 'unregistered', approved: 'enabled', registered: 'enabled', 'registered-held': 'held',
};

/**
 * THE ROOM NOTICE [ticket]: an app's capability changed — it became held (its
 * pinned tool.json changed), was unregistered, approved or registered again —
 * so every OPEN room holding it gets ONE fact line saying so and, when a
 * person must act, where. The caller decides it is due (holdTool /
 * unregisterTool answered true, an approve of a HELD app, a re-register: a
 * CHANGE, never a repeat while the state persists). An archived room is
 * stasis (nothing is added to it). One action per room.
 */
export function appStatusNotice(slug: string, notice: AppNotice): RoomAction<null>[] {
  const reg = getToolRegistry(slug);
  if (!reg) {
    return [];
  }
  const body = APP_NOTICE[notice](reg.name);
  const status = APP_NOTICE_STATUS[notice];
  const out: RoomAction<null>[] = [];
  for (const r of roomsForApp(slug)) {
    try {
      out.push(roomAction((d) => {
        const room = requireRoom(d, r.id);
        if (room.state !== 'open') {
          return { roomId: r.id, result: null, entries: [], stateChanged: false };
        }
        const fact = writeFact(d, r.id, body, null, null, {
          app: slug,
          app_status: status,
          notice,
          ...(status === 'enabled' ? {} : { settings: '/settings.html#apps' }),
        });
        return { roomId: r.id, result: null, entries: [fact], stateChanged: true };
      }));
    } catch {
      /* one room failing never stops the others */
    }
  }
  return out;
}

/** A human approves the current file: re-pin its hash + the root's realpath
 *  (+ the file's content, for a later diff) and clear `held`. */
export function approveTool(slug: string, tool_sha256: string, root_realpath: string, tool_json: string | null = null): ToolRegistryRow | undefined {
  const d = rdb();
  if (!toolRow(d, slug)) {
    return undefined;
  }
  d.prepare(`UPDATE tool_registry SET tool_sha256=?, root_realpath=?, held=0, tool_json=?, pinned_at=? WHERE slug=?`).run(tool_sha256, root_realpath, tool_json, Date.now(), slug);
  return hydrateTool(toolRow(d, slug));
}

/** An app's name for a room line (the registry's; the slug, quoted, when
 *  it is not registered at all). */
function appName(d: Database.Database, slug: string): string {
  const r = d.prepare(`SELECT name FROM tool_registry WHERE slug=?`).get(slug) as { name: string } | undefined;
  return r?.name || `app "${slug}"`;
}

export interface RoomAppRow {
  room_id: string;
  slug: string;
  added_by: string;
  added_at: number;
  panel_ids: string[];
}

/* APPS BELONG TO THE ROOM FAMILY (Owner 2026-10-05, room line; [family apps]).
 * A workgroup shows its main room's app cells, and they do not change as you
 * move between the two. So every app/panel read and write below resolves the
 * room it is handed to its family HEAD (the parent when one is set, else the
 * room itself) — one rule here, so no caller can forget it. Facts and the
 * acting seat stay on the room the person was in. Voice and seat-registered
 * panels (no app_slug) stay per room. */
export function familyHeadId(roomId: string): string {
  return familyHeadOf(rdb(), roomId);
}
function familyHeadOf(d: Database.Database, roomId: string): string {
  const r = d.prepare(`SELECT parent_id FROM rooms WHERE id=?`).get(roomId) as { parent_id: string | null } | undefined;
  return r?.parent_id ?? roomId;
}

/** Boot migration [family apps]: a workgroup that kept its own apps before
 *  this rule has them ADOPTED into its head room (membership row + app panels
 *  moved, nothing deleted). An app the head already holds wins; the
 *  workgroup's copy is left in place but is never read (listPanels and
 *  listRoomApps resolve to the head) and is reported in `duplicates`.
 *  Idempotent: a moved row is no longer a workgroup's. */
export function adoptWorkgroupApps(d: Database.Database = rdb()): { adopted: Array<{ room_id: string; slug: string }>; duplicates: Array<{ room_id: string; slug: string }> } {
  const adopted: Array<{ room_id: string; slug: string }> = [];
  const duplicates: Array<{ room_id: string; slug: string }> = [];
  d.transaction(() => {
    const rows = d
      .prepare(`SELECT a.room_id, a.slug, r.parent_id AS head FROM room_apps a JOIN rooms r ON r.id = a.room_id WHERE r.parent_id IS NOT NULL ORDER BY a.added_at`)
      .all() as { room_id: string; slug: string; head: string }[];
    for (const row of rows) {
      if (d.prepare(`SELECT 1 FROM room_apps WHERE room_id=? AND slug=?`).get(row.head, row.slug)) {
        duplicates.push({ room_id: row.room_id, slug: row.slug });
        continue;
      }
      d.prepare(`UPDATE room_apps SET room_id=? WHERE room_id=? AND slug=?`).run(row.head, row.room_id, row.slug);
      const panels = d.prepare(`SELECT id FROM room_panels WHERE room_id=? AND app_slug=? ORDER BY position, created_at, id`).all(row.room_id, row.slug) as { id: string }[];
      for (const p of panels) {
        const next = ((d.prepare(`SELECT MAX(position) AS m FROM room_panels WHERE room_id=?`).get(row.head) as { m: number | null }).m ?? -1) + 1;
        d.prepare(`UPDATE room_panels SET room_id=?, position=? WHERE id=?`).run(row.head, next, p.id);
      }
      adopted.push({ room_id: row.room_id, slug: row.slug });
    }
  })();
  return { adopted, duplicates };
}

function panelIdsForApp(d: Database.Database, roomId: string, slug: string): string[] {
  return (d.prepare(`SELECT id FROM room_panels WHERE room_id=? AND app_slug=? ORDER BY position, created_at, id`).all(roomId, slug) as {
    id: string;
  }[]).map((r) => r.id);
}

/** Apps a room holds, in the order they were added. */
export function listRoomApps(roomId: string): RoomAppRow[] {
  const d = rdb();
  roomId = familyHeadOf(d, roomId);
  return (d.prepare(`SELECT room_id, slug, added_by, added_at FROM room_apps WHERE room_id=? ORDER BY added_at`).all(roomId) as Omit<
    RoomAppRow,
    'panel_ids'
  >[]).map((r) => ({ ...r, panel_ids: panelIdsForApp(d, roomId, r.slug) }));
}

/** The rooms holding this app slug (for the catalog's `rooms` field and the
 *  exclusive-conflict check). */
export function roomsForApp(slug: string): Array<{ id: string; name: string }> {
  /* one row per FAMILY (its head); a workgroup's own copy is never read [family apps] */
  return rdb()
    .prepare(`SELECT r.id, r.name FROM room_apps a JOIN rooms r ON r.id = a.room_id WHERE a.slug=? AND r.parent_id IS NULL ORDER BY a.added_at`)
    .all(slug) as Array<{ id: string; name: string }>;
}

/** Every room id of the family `roomId` is in (head first). */
export function familyRoomIds(roomId: string): string[] {
  return familyIds(rdb(), roomId);
}

/** A panel spec derived from the tool's catalog entry: what to draw if a
 *  matching panel doesn't already exist in the room. */
export interface AppPanelSpec {
  title: string;
  icon: string | null;
  url: string;
  scripts: boolean;
  uploads: boolean;
}

/** Adopt an existing same-URL panel (an app that self-registers, e.g. on
 *  bind, may already have created it) or insert a fresh one; either way the
 *  panel ends up carrying `app_slug`. Same rule for add, reconcile and
 *  backfill — never two panels for one app view.
 *
 *  ADOPTING TAKES THE PANEL OVER [rooms/apps-sec]: title, icon, scripts and
 *  uploads are overwritten from the PINNED spec and seat_id is cleared, so a
 *  seat that pre-registered the URL cannot choose the app panel's sandbox
 *  flags, and can no longer delete it (a seat may remove only its own
 *  panels) — which would have been a membership removal. */
function adoptAppPanel(d: Database.Database, panelId: string, slug: string, spec: AppPanelSpec): void {
  d.prepare(`UPDATE room_panels SET app_slug=?, title=?, icon=?, scripts=?, uploads=?, seat_id=NULL WHERE id=?`).run(
    slug,
    spec.title,
    spec.icon,
    spec.scripts ? 1 : 0,
    spec.uploads ? 1 : 0,
    panelId,
  );
}

function ensureAppPanel(d: Database.Database, roomId: string, slug: string, spec: AppPanelSpec, createdBy: string): string {
  const existing = d.prepare(`SELECT id FROM room_panels WHERE room_id=? AND url=?`).get(roomId, spec.url) as { id: string } | undefined;
  if (existing) {
    adoptAppPanel(d, existing.id, slug, spec);
    return existing.id;
  }
  const count = (d.prepare(`SELECT COUNT(*) AS n FROM room_panels WHERE room_id=?`).get(roomId) as { n: number }).n;
  if (count >= PANELS_MAX) {
    throw new RoomError(409, `a room holds at most ${PANELS_MAX} panels`, 'panel');
  }
  const id = randomUUID();
  const order = ((d.prepare(`SELECT MAX(position) AS m FROM room_panels WHERE room_id=?`).get(roomId) as { m: number | null }).m ?? -1) + 1;
  d.prepare(
    `INSERT INTO room_panels (id, room_id, kind, title, url, seat_id, icon, scripts, uploads, position, created_by, created_at, app_slug)
     VALUES (?, ?, 'app', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, roomId, spec.title, spec.url, spec.icon, spec.scripts ? 1 : 0, spec.uploads ? 1 : 0, order, createdBy, Date.now(), slug);
  return id;
}

/** Put an app in a room: the membership row plus (when `panels` is non-empty,
 *  i.e. the app is running and its view is known) its panel(s), adopting any
 *  the app already self-registered. Idempotent: already-a-member returns the
 *  current panel set and writes nothing. `panels` empty (the app is down)
 *  still creates the membership row with no panel — reconcile fills it in once
 *  the catalog sees the app running. */
export function addRoomApp(roomId: string, slug: string, panels: AppPanelSpec[], opts: RoomActionOpts): RoomAction<RoomAppRow> {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    requireOpen(room);
    const actedIn = roomId; // the fact and the acting seat stay where the person was
    roomId = headIdOf(room);
    const already = d.prepare(`SELECT added_by, added_at FROM room_apps WHERE room_id=? AND slug=?`).get(roomId, slug) as
      | { added_by: string; added_at: number }
      | undefined;
    let createdBy = 'user';
    if (opts.actor !== 'user') {
      createdBy = authorOf(d, actedIn, opts.actor).author_seat!;
    }
    if (already) {
      // Idempotent add: still reconcile panels (a since-started app), no new
      // fact — but a NEWLY filled-in panel is a real change a viewer must see.
      const before = new Set(panelIdsForApp(d, roomId, slug));
      for (const spec of panels) {
        ensureAppPanel(d, roomId, slug, spec, already.added_by);
      }
      const after = panelIdsForApp(d, roomId, slug);
      return {
        roomId: actedIn,
        result: { room_id: roomId, slug, added_by: already.added_by, added_at: already.added_at, panel_ids: after },
        entries: [],
        stateChanged: after.some((id) => !before.has(id)),
        alsoStateFor: familyIds(d, roomId),
      };
    }
    const added_at = Date.now();
    d.prepare(`INSERT INTO room_apps (room_id, slug, added_by, added_at) VALUES (?, ?, ?, ?)`).run(roomId, slug, createdBy, added_at);
    for (const spec of panels) {
      ensureAppPanel(d, roomId, slug, spec, createdBy);
    }
    const seat = opts.actor !== 'user' ? seatRow(d, opts.actor.seatId) ?? null : null;
    const fact = writeFact(d, actedIn, `${appName(d, slug)} was added to the room`, seat, null, { app: slug });
    return {
      roomId: actedIn,
      result: { room_id: roomId, slug, added_by: createdBy, added_at, panel_ids: panelIdsForApp(d, roomId, slug) },
      entries: [fact],
      stateChanged: true,
      alsoStateFor: familyIds(d, roomId),
    };
  });
}

/** Remove an app from a room: its membership row and every panel it owns
 *  here. Not-a-member is a no-op (0 panel_ids, no fact) so a retried Undo
 *  after a slow double-click can't 404. */
export function removeRoomApp(roomId: string, slug: string, opts: RoomActionOpts): RoomAction<RoomAppRow> {
  return roomAction((d) => {
    const actedIn = roomId;
    roomId = headIdOf(requireRoom(d, roomId));
    const row = d.prepare(`SELECT added_by, added_at FROM room_apps WHERE room_id=? AND slug=?`).get(roomId, slug) as
      | { added_by: string; added_at: number }
      | undefined;
    if (!row) {
      return { roomId: actedIn, result: { room_id: roomId, slug, added_by: '', added_at: 0, panel_ids: [] }, entries: [], stateChanged: false };
    }
    const panelIds = panelIdsForApp(d, roomId, slug);
    d.prepare(`DELETE FROM room_panels WHERE room_id=? AND app_slug=?`).run(roomId, slug);
    d.prepare(`DELETE FROM room_apps WHERE room_id=? AND slug=?`).run(roomId, slug);
    const seat = opts.actor !== 'user' ? seatRow(d, opts.actor.seatId) ?? null : null;
    const fact = writeFact(d, actedIn, `${appName(d, slug)} was removed from the room`, seat, null, { app: slug, panels: panelIds });
    return { roomId: actedIn, result: { room_id: roomId, slug, added_by: row.added_by, added_at: row.added_at, panel_ids: panelIds }, entries: [fact], stateChanged: true, alsoStateFor: familyIds(d, roomId) };
  });
}

/** Would drawing these app panels push the room over PANELS_MAX? A URL the
 *  room already shows is adopted, not added, so it costs nothing. Asked
 *  BEFORE an exclusive app's bind call, so a full room refuses without the
 *  app having moved [rooms/apps-sec]. */
export function appPanelsWouldExceedCap(roomId: string, urls: string[]): boolean {
  const d = rdb();
  roomId = familyHeadOf(d, roomId);
  const count = (d.prepare(`SELECT COUNT(*) AS n FROM room_panels WHERE room_id=?`).get(roomId) as { n: number }).n;
  const have = new Set((d.prepare(`SELECT url FROM room_panels WHERE room_id=?`).all(roomId) as { url: string }[]).map((r) => r.url));
  const fresh = new Set(urls.filter((u) => !have.has(u))).size;
  return fresh > 0 && count + fresh > PANELS_MAX;
}

/** Place an app in a room in ONE transaction [rooms/apps-sec]: re-check
 *  exclusivity (another room took it while the bind call was in flight),
 *  remove it from `from` (a move), add it here. Any throw (the panel cap, an
 *  archived room) rolls BOTH back, so a move never leaves the app in neither
 *  room. `conflict` names the room that won a race; nothing was written. */
export function placeRoomApp(
  roomId: string,
  slug: string,
  panels: AppPanelSpec[],
  opts: { exclusive: boolean; from: string | null },
): { conflict: { id: string; name: string } | null; actions: RoomAction<RoomAppRow>[] } {
  return rdb().transaction(() => {
    const head = familyHeadId(roomId);
    // Moving within one family is a no-op: the app is already the family's.
    const from = opts.from && familyHeadId(opts.from) !== head ? opts.from : null;
    if (opts.exclusive) {
      const other = roomsForApp(slug).find((r) => r.id !== head && r.id !== (opts.from ? familyHeadId(opts.from) : null));
      if (other) {
        return { conflict: other, actions: [] };
      }
    }
    const actions: RoomAction<RoomAppRow>[] = [];
    if (from) {
      actions.push(removeRoomApp(from, slug, { actor: 'user' }));
    }
    actions.push(addRoomApp(roomId, slug, panels, { actor: 'user' }));
    return { conflict: null, actions };
  })();
}

/** Reconcile's FILL-ONLY path [rooms/apps-sec P1-d]: draw the panel(s) of an
 *  app a room ALREADY holds (it was down when added, and is running now).
 *  Never inserts membership — if the room_apps row is gone (a human removed
 *  the app between reconcile's read and this write) it is a no-op, so a
 *  background loop can never put an app in a room. */
export function fillRoomAppPanels(roomId: string, slug: string, panels: AppPanelSpec[]): RoomAction<{ panel_ids: string[] }> {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    roomId = headIdOf(room);
    const member = d.prepare(`SELECT added_by FROM room_apps WHERE room_id=? AND slug=?`).get(roomId, slug) as { added_by: string } | undefined;
    if (!member || room.state !== 'open') {
      return { roomId, result: { panel_ids: [] }, entries: [], stateChanged: false };
    }
    const before = new Set(panelIdsForApp(d, roomId, slug));
    for (const spec of panels) {
      ensureAppPanel(d, roomId, slug, spec, member.added_by);
    }
    const after = panelIdsForApp(d, roomId, slug);
    return { roomId, result: { panel_ids: after }, entries: [], stateChanged: after.some((id) => !before.has(id)), alsoStateFor: familyIds(d, roomId) };
  });
}

/** Backfill (registration time + boot ONLY, the design notes §4.4
 *  amendment; never on the 30 s loop — §4.4 "a panel does not make an app a
 *  member", security P1-d): an existing panel a room registered directly
 *  (register-panel.sh, before app membership existed) gets `app_slug` set and a
 *  `room_apps` row when ALL of: it has no app yet, it was created no later than
 *  the app's registration (`registeredAt`), and its URL matches this app's own
 *  view FOR THAT ROOM (`matchesView(url, roomId)` — the :roomId segment must be
 *  this panel's own room, so a panel in room A pointing at room B's view is
 *  never adopted). `specFor` answers the pinned spec for exactly that URL in
 *  that room, or null; adoption overwrites the panel from it. Every room that already shows it, so an exclusive app
 *  registered in several rooms is reported as a conflict, not silently
 *  collapsed. Deletes nothing. Returns the rooms touched. */
export function backfillAppPanels(
  slug: string,
  specFor: (url: string, roomId: string) => AppPanelSpec | null,
  registeredAt: number,
  addedBy = 'engine',
): string[] {
  const d = rdb();
  const candidates = d
    .prepare(`SELECT id, room_id, url FROM room_panels WHERE app_slug IS NULL AND created_at <= ? AND room_id NOT IN (SELECT id FROM rooms WHERE parent_id IS NOT NULL)`)
    .all(registeredAt) as { id: string; room_id: string; url: string }[];
  const touched = new Set<string>();
  d.transaction(() => {
    for (const p of candidates) {
      const spec = specFor(p.url, p.room_id);
      if (!spec) {
        continue;
      }
      adoptAppPanel(d, p.id, slug, spec);
      const already = d.prepare(`SELECT 1 FROM room_apps WHERE room_id=? AND slug=?`).get(p.room_id, slug);
      if (!already) {
        d.prepare(`INSERT INTO room_apps (room_id, slug, added_by, added_at) VALUES (?, ?, ?, ?)`).run(p.room_id, slug, addedBy, Date.now());
      }
      touched.add(p.room_id);
    }
  })();
  return [...touched];
}

/* ================================================================ panels ====
 * ROOM PANELS (the design notes §2.6) [ticket]. A cell in the room's
 * left column that shows an APP's surface: an app-served web view the room
 * page draws in a sandboxed iframe (what the page must do: engine/panel-url.ts).
 * The engine owns WHICH panels a room has, their order and the member each one
 * hangs off; the renderer owns the layout.
 *
 * A panel is a VIEW, not a member: nothing to rehydrate, removing it ends
 * nothing. Same one-action-path rule as every room verb: the change, and the
 * Room fact that records it, in ONE transaction; the endpoint announces
 * room.state (+ room.line for the fact) after commit.
 *
 * AUTHORITY: a seat actor may register a panel only on ITSELF (seat_id is
 * forced to the actor's seat) and may retitle / reorder / remove only its own
 * panels. The user may do anything. Whether the request may act as 'user' at
 * all (a human credential) is the route's call.
 * ========================================================================== */

export interface RoomPanel {
  id: string;
  room_id: string;
  kind: PanelKind;
  title: string;
  url: string;
  /** The seat (member) this panel hangs off, or null for a room-level panel. */
  seat_id: string | null;
  /** Derived at read time: the handle of that seat while it is ACTIVE; null
   *  when there is no seat or it has left the room. */
  seat_handle: string | null;
  icon: string | null;
  /** The app's view needs script: the proxied frame's CSP sandbox then adds
   *  allow-scripts (never allow-same-origin). Set at registration only. */
  scripts: boolean;
  /** The host may forward this panel's drop/paste to POST .../assets with the
   *  human's cookie [ticket]. Without it a scripts:true panel could post a
   *  forged drop as Owner. Set at registration only. */
  uploads: boolean;
  /** Ascending; ties by created_at. */
  order: number;
  /** 'user' or a SEAT id. */
  created_by: string;
  created_at: number;
  /** The room_apps slug this panel belongs to, or null for a panel registered
   *  directly (the pre-apps path, and the voice panel). Removing the app
   *  removes exactly the panels carrying its slug. */
  app_slug: string | null;
}

const PANEL_TITLE_MAX = 120;
const PANEL_ICON_MAX = 64;
/** Per room. A cap, not a layout rule: a runaway resident must not fill Owner's column. */
export const PANELS_MAX = 24;
const PANEL_ORDER_LIMIT = 1_000_000;

const PANEL_SELECT = `SELECT p.id, p.room_id, p.kind, p.title, p.url, p.seat_id,
                             CASE WHEN s.left_at IS NULL THEN s.handle END AS seat_handle,
                             p.icon, p.scripts, p.uploads, p.position AS "order", p.created_by, p.created_at, p.app_slug
                        FROM room_panels p LEFT JOIN room_seats s ON s.id = p.seat_id`;

type PanelRowRaw = Omit<RoomPanel, 'scripts' | 'uploads'> & { scripts: number; uploads: number };
function hydratePanel(r: PanelRowRaw | undefined): RoomPanel | undefined {
  return r ? { ...r, scripts: r.scripts === 1, uploads: r.uploads === 1 } : undefined;
}

function panelRow(d: Database.Database, id: string): RoomPanel | undefined {
  return hydratePanel(d.prepare(`${PANEL_SELECT} WHERE p.id=?`).get(id) as PanelRowRaw | undefined);
}

function panelTitle(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > PANEL_TITLE_MAX) {
    throw new RoomError(400, `a panel title is 1-${PANEL_TITLE_MAX} characters`, 'title');
  }
  return t;
}

function panelOrder(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > PANEL_ORDER_LIMIT) {
    throw new RoomError(400, `order is an integer within ±${PANEL_ORDER_LIMIT}`, 'order');
  }
  return v;
}

/** An icon is a KEY (the design system vocabulary or a short glyph), never a URL or markup. */
function panelIcon(v: unknown): string | null {
  if (v === undefined || v === null || v === '') {
    return null;
  }
  if (typeof v !== 'string' || v.length > PANEL_ICON_MAX || /[:/<>"'\\]/.test(v)) {
    throw new RoomError(400, `icon is a key of at most ${PANEL_ICON_MAX} characters (no URL, no markup)`, 'icon');
  }
  return v;
}

/** The panel, in this room, that `actor` may change — or a 404 / 403. */
function requirePanelFor(d: Database.Database, roomId: string, panelId: string, actor: RoomActor): RoomPanel {
  const p = typeof panelId === 'string' ? panelRow(d, panelId) : undefined;
  // The family's app panels live on the head room [family apps].
  if (!p || (p.room_id !== roomId && !(p.app_slug && p.room_id === familyHeadOf(d, roomId)))) {
    throw new RoomError(404, 'no such panel in this room', 'panel');
  }
  if (actor !== 'user') {
    authorOf(d, roomId, actor); // the actor still holds a seat here
    if (p.seat_id !== actor.seatId) {
      throw new RoomError(403, 'a member may change only the panels that hang off its own seat', 'from');
    }
  }
  return p;
}

/** Panels of a room, in order. */
export function listPanels(roomId: string): RoomPanel[] {
  return rdb()
    .prepare(
      `${PANEL_SELECT} WHERE (p.room_id=@head AND (p.app_slug IS NOT NULL OR @head=@room))
                           OR (p.room_id=@room AND p.app_slug IS NULL)
       ORDER BY (p.room_id=@head) DESC, p.position, p.created_at, p.id`,
    )
    .all({ head: familyHeadOf(rdb(), roomId), room: roomId })
    .map((r) => hydratePanel(r as PanelRowRaw)!);
}

export function getPanel(id: string): RoomPanel | undefined {
  return panelRow(rdb(), id);
}

export interface PanelInput {
  kind?: unknown;
  title?: unknown;
  url?: unknown;
  seat_id?: unknown;
  icon?: unknown;
  order?: unknown;
  scripts?: unknown;
  uploads?: unknown;
}

/** Register a panel. Appends to the end unless `order` is given. */
export function addPanel(roomId: string, input: PanelInput, opts: RoomActionOpts): RoomAction<RoomPanel> {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    requireOpen(room);
    const kind = input.kind === undefined || input.kind === null ? 'app' : input.kind;
    if (!PANEL_KINDS.includes(kind as PanelKind)) {
      throw new RoomError(400, `kind is one of: ${PANEL_KINDS.join(', ')}`, 'kind');
    }
    const title = panelTitle(input.title);
    const checked = checkPanelUrl(input.url);
    if (!checked.ok) {
      throw new RoomError(400, checked.error, 'url');
    }
    const icon = panelIcon(input.icon);
    if (input.scripts !== undefined && input.scripts !== null && typeof input.scripts !== 'boolean') {
      throw new RoomError(400, 'scripts is true or false', 'scripts');
    }
    const scripts = input.scripts === true ? 1 : 0;
    if (input.uploads !== undefined && input.uploads !== null && typeof input.uploads !== 'boolean') {
      throw new RoomError(400, 'uploads is true or false', 'uploads');
    }
    const uploads = input.uploads === true ? 1 : 0;
    let seat: RoomSeat | null = null;
    let createdBy = 'user';
    if (opts.actor !== 'user') {
      createdBy = authorOf(d, roomId, opts.actor).author_seat!;
      if (input.seat_id !== undefined && input.seat_id !== null && input.seat_id !== createdBy) {
        throw new RoomError(403, 'a member registers panels on its own seat only', 'seat_id');
      }
      seat = requireSeat(d, roomId, createdBy, 'seat_id');
    } else if (input.seat_id !== undefined && input.seat_id !== null) {
      seat = requireSeat(d, roomId, input.seat_id as string, 'seat_id');
    }
    /* ONE PANEL PER VIEW URL: the
       apps flow adopts a seat's panel by url and clears its seat_id, so a
       resident that re-registered on every start no longer found its own
       panel and added a second one. Name the panel that is there. */
    const same = d.prepare(`SELECT id, title, app_slug FROM room_panels WHERE room_id=? AND url=?`).get(roomId, checked.url) as
      | { id: string; title: string; app_slug: string | null }
      | undefined;
    if (same) {
      throw new RoomError(
        409,
        `this view is already in the room as panel "${same.title}" (${same.id})${same.app_slug ? `, the ${same.app_slug} app's` : ''}`,
        'url',
      );
    }
    const count = (d.prepare(`SELECT COUNT(*) AS n FROM room_panels WHERE room_id=?`).get(roomId) as { n: number }).n;
    if (count >= PANELS_MAX) {
      throw new RoomError(409, `a room holds at most ${PANELS_MAX} panels`, 'panel');
    }
    const order =
      input.order === undefined || input.order === null
        ? ((d.prepare(`SELECT MAX(position) AS m FROM room_panels WHERE room_id=?`).get(roomId) as { m: number | null }).m ?? -1) + 1
        : panelOrder(input.order);
    const id = randomUUID();
    d.prepare(
      `INSERT INTO room_panels (id, room_id, kind, title, url, seat_id, icon, scripts, uploads, position, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, roomId, kind, title, checked.url, seat?.id ?? null, icon, scripts, uploads, order, createdBy, Date.now());
    const fact = writeFact(d, roomId, `panel "${title}" was added${seat ? ` to @${seat.handle}` : ''}`, seat, null, {
      panel: id,
      url: checked.url,
      scripts: scripts === 1,
      uploads: uploads === 1,
      by: createdBy,
    });
    return { roomId, result: panelRow(d, id)!, entries: [fact], stateChanged: true };
  });
}

/** Retitle and/or reorder a panel. A reorder alone writes no fact (layout,
 *  not an event); a retitle does. */
export function updatePanel(
  roomId: string,
  panelId: string,
  patch: { title?: unknown; order?: unknown },
  opts: RoomActionOpts,
): RoomAction<RoomPanel> {
  return roomAction((d) => {
    requireOpen(requireRoom(d, roomId));
    const p = requirePanelFor(d, roomId, panelId, opts.actor);
    const title = patch.title !== undefined ? panelTitle(patch.title) : p.title;
    const order = patch.order !== undefined ? panelOrder(patch.order) : p.order;
    if (title === p.title && order === p.order) {
      return { roomId, result: p, entries: [], stateChanged: false };
    }
    d.prepare(`UPDATE room_panels SET title=?, position=? WHERE id=?`).run(title, order, p.id);
    const entries: RoomLineEntry[] = [];
    if (title !== p.title) {
      const seat = p.seat_id ? seatRow(d, p.seat_id) ?? null : null;
      entries.push(writeFact(d, roomId, `panel "${p.title}" was renamed "${title}"`, seat, null, { panel: p.id, from: p.title, to: title }));
    }
    return { roomId, result: panelRow(d, p.id)!, entries, stateChanged: true, ...(p.app_slug ? { alsoStateFor: familyIds(d, roomId) } : {}) };
  });
}

/** Remove a panel. Allowed in an archived room too: a panel that must go (a
 *  bad URL) must never be stuck behind /reopen. If this was the app's LAST
 *  panel here, its `room_apps` row goes too — a panel-only delete of an app's
 *  one view must not leave a phantom membership row behind. */
export function removePanel(roomId: string, panelId: string, opts: RoomActionOpts): RoomAction<RoomPanel> {
  return roomAction((d) => {
    requireRoom(d, roomId);
    const p = requirePanelFor(d, roomId, panelId, opts.actor);
    d.prepare(`DELETE FROM room_panels WHERE id=?`).run(p.id);
    if (p.app_slug) {
      const remaining = (d.prepare(`SELECT COUNT(*) AS n FROM room_panels WHERE room_id=? AND app_slug=?`).get(p.room_id, p.app_slug) as {
        n: number;
      }).n;
      if (remaining === 0) {
        d.prepare(`DELETE FROM room_apps WHERE room_id=? AND slug=?`).run(p.room_id, p.app_slug);
      }
    }
    const seat = p.seat_id ? seatRow(d, p.seat_id) ?? null : null;
    const fact = writeFact(d, roomId, `panel "${p.title}" was removed`, seat, null, { panel: p.id, url: p.url });
    return { roomId, result: p, entries: [fact], stateChanged: true, ...(p.app_slug ? { alsoStateFor: familyIds(d, roomId) } : {}) };
  });
}

/* ============================================================ room voice ====
 * ROOM VOICE CONNECTIONS + THE LEDGER (the design notes §4, §9.1, §10.3)
 * [ticket]. The clocks and the policy are engine/room-voice.ts; this is only
 * the record.
 *
 * voice_connections: ONE row per connected room (a device holds at most one,
 * which room-voice.ts enforces). PERSISTED, so an engine restart keeps the
 * connection (§4); pane channels stay in memory (voice.ts).
 *
 * THE VOICE PANEL is the engine's own (§9.1): kind 'voice', seat_id NULL,
 * created_by 'engine' — at most ONE per room, present exactly while the room
 * is connected. Written here, never through addPanel, so no caller's actor
 * can register one (the public POST refuses the kind).
 *
 * voice_events: one row per voice message (vid = the utterance line's vid),
 * seeded on inbound and /said; the reply columns are E1c's.
 * ========================================================================== */

function ensureVoiceTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS voice_connections (
      room_id       TEXT PRIMARY KEY,
      device        TEXT NOT NULL,
      opened_at     INTEGER NOT NULL,
      muted         INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1)),
      waiting       INTEGER NOT NULL DEFAULT 0 CHECK(waiting IN (0,1)),
      last_activity INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_events (
      vid                 TEXT PRIMARY KEY,
      room_id             TEXT NOT NULL,
      line_id             INTEGER,
      utterance_id        TEXT,
      target_seat         TEXT,
      utterance_ts        INTEGER NOT NULL,
      delivered_rung      TEXT,
      delivered_ts        INTEGER,
      ack_ts              INTEGER,
      result_ts           INTEGER,
      connected_at_result INTEGER,
      spoken              INTEGER,
      reason              TEXT,
      over_cap            INTEGER,
      route_action        TEXT,
      route_confidence    REAL,
      resolved            TEXT,
      followup_to         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_voice_events_room ON voice_events(room_id, utterance_ts);
  `);
  /* E1c [ticket]: the no-ack notice, sent at most once per vid (a column, so
     a restart does not send it again). Additive, idempotent. room-voice v3.3:
     speaker_verified, whether the sid was on the allowlist. */
  const cols = new Set((database.prepare(`PRAGMA table_info(voice_events)`).all() as { name: string }[]).map((c) => c.name));
  for (const c of ['notice_ts INTEGER', 'notice_outcome TEXT', 'speaker_verified INTEGER']) {
    if (!cols.has(c.split(' ')[0])) {
      database.exec(`ALTER TABLE voice_events ADD COLUMN ${c}`);
    }
  }
  /* v3.6: the person who OPENED the connection, whose voice globals the seat
     reply path and the idle sweep follow. NULL (a row from before) = the owner. */
  if (!(database.prepare(`PRAGMA table_info(voice_connections)`).all() as { name: string }[]).some((c) => c.name === 'user_key')) {
    database.exec(`ALTER TABLE voice_connections ADD COLUMN user_key TEXT`);
  }
}

export interface VoiceConnection {
  room_id: string;
  device: string;
  opened_at: number;
  muted: boolean;
  waiting: boolean;
  last_activity: number;
  /** v3.6: who opened it (their voice globals apply); null = the owner. */
  user_key: string | null;
}
type VoiceConnRaw = Omit<VoiceConnection, 'muted' | 'waiting'> & { muted: number; waiting: number };

function voiceConnRow(d: Database.Database, roomId: string): VoiceConnection | undefined {
  const r = d.prepare(`SELECT * FROM voice_connections WHERE room_id=?`).get(roomId) as VoiceConnRaw | undefined;
  return r ? { ...r, muted: r.muted === 1, waiting: r.waiting === 1 } : undefined;
}

export function getVoiceConnection(roomId: string): VoiceConnection | undefined {
  return voiceConnRow(rdb(), roomId);
}

export function listVoiceConnections(): VoiceConnection[] {
  return (rdb().prepare(`SELECT room_id FROM voice_connections`).all() as { room_id: string }[]).map((r) => voiceConnRow(rdb(), r.room_id)!);
}

/** Rooms holding an engine voice panel or a connection: what a boot reconciles. */
export function voiceRoomIds(): string[] {
  return (
    rdb()
      .prepare(`SELECT room_id FROM voice_connections UNION SELECT room_id FROM room_panels WHERE kind='voice' AND seat_id IS NULL`)
      .all() as { room_id: string }[]
  ).map((r) => r.room_id);
}

/** Exactly one engine voice panel while connected, none otherwise. `url` null
 *  (not on the allow-list) = none; the host then draws its own buttons.
 *  Returns whether anything changed. Writes no fact: the connect/disconnect
 *  fact already says it. */
function syncVoicePanel(d: Database.Database, roomId: string, url: string | null): boolean {
  const ids = (d.prepare(`SELECT id, url FROM room_panels WHERE room_id=? AND kind='voice' AND seat_id IS NULL ORDER BY created_at, rowid`).all(roomId) as {
    id: string;
    url: string;
  }[]);
  const want = url && voiceConnRow(d, roomId) ? url : null;
  const keep = want ? ids[0] : undefined;
  let changed = false;
  for (const p of ids) {
    if (p !== keep) {
      d.prepare(`DELETE FROM room_panels WHERE id=?`).run(p.id);
      changed = true;
    }
  }
  if (keep && keep.url !== want) {
    d.prepare(`UPDATE room_panels SET url=? WHERE id=?`).run(want, keep.id);
    changed = true;
  }
  if (want && !keep && (d.prepare(`SELECT COUNT(*) AS n FROM room_panels WHERE room_id=?`).get(roomId) as { n: number }).n < PANELS_MAX) {
    const order = ((d.prepare(`SELECT MAX(position) AS m FROM room_panels WHERE room_id=?`).get(roomId) as { m: number | null }).m ?? -1) + 1;
    d.prepare(
      `INSERT INTO room_panels (id, room_id, kind, title, url, seat_id, icon, scripts, uploads, position, created_by, created_at)
       VALUES (?, ?, 'voice', 'Voice', ?, NULL, 'voice', 1, 0, ?, 'engine', ?)`,
    ).run(randomUUID(), roomId, want, order, Date.now());
    changed = true;
  }
  return changed;
}

/** Connect `device` to an OPEN room (replacing whatever held it; room-voice.ts
 *  closes the old holder first so it gets its own fact). Idempotent for the
 *  same device: no second fact, the panel re-checked. */
export function connectVoice(roomId: string, device: string, panelUrl: string | null, userKey: string | null = null): RoomAction<VoiceConnection> {
  return roomAction((d) => {
    requireOpen(requireRoom(d, roomId));
    const old = voiceConnRow(d, roomId);
    const entries: RoomLineEntry[] = [];
    if (!old || old.device !== device) {
      const now = Date.now();
      d.prepare(`INSERT OR REPLACE INTO voice_connections (room_id, device, opened_at, muted, waiting, last_activity) VALUES (?, ?, ?, 0, 0, ?)`).run(
        roomId,
        device,
        now,
        now,
      );
      entries.push(writeFact(d, roomId, `voice connected · ${device}`, null, null, { voice: 'connected', device }));
    }
    d.prepare(`UPDATE voice_connections SET user_key=? WHERE room_id=?`).run(userKey, roomId);
    const panel = syncVoicePanel(d, roomId, panelUrl);
    return { roomId, result: voiceConnRow(d, roomId)!, entries, stateChanged: entries.length > 0 || panel };
  });
}

/** Disconnect a room (archived rooms too: a connection must always be able to
 *  end). Null result = it was not connected (nothing written). */
export function disconnectVoice(roomId: string, reason: string): RoomAction<VoiceConnection | null> {
  return roomAction((d) => {
    requireRoom(d, roomId);
    const old = voiceConnRow(d, roomId);
    if (!old) {
      return { roomId, result: null, entries: [], stateChanged: syncVoicePanel(d, roomId, null) };
    }
    d.prepare(`DELETE FROM voice_connections WHERE room_id=?`).run(roomId);
    syncVoicePanel(d, roomId, null);
    const fact = writeFact(d, roomId, `voice disconnected (${reason})`, null, null, { voice: 'disconnected', device: old.device, reason });
    return { roomId, result: old, entries: [fact], stateChanged: true };
  });
}

/** Mute / waiting / the activity clock. room.state is announced only when a
 *  flag the room view shows changed. Null = not connected. */
export function setVoiceConnection(roomId: string, patch: { muted?: boolean; waiting?: boolean; touch?: boolean }): RoomAction<VoiceConnection | null> {
  return roomAction((d) => {
    const old = voiceConnRow(d, roomId);
    if (!old) {
      return { roomId, result: null, entries: [], stateChanged: false };
    }
    const muted = patch.muted ?? old.muted;
    const waiting = patch.waiting ?? old.waiting;
    d.prepare(`UPDATE voice_connections SET muted=?, waiting=?, last_activity=? WHERE room_id=?`).run(
      muted ? 1 : 0,
      waiting ? 1 : 0,
      patch.touch ? Date.now() : old.last_activity,
      roomId,
    );
    return { roomId, result: voiceConnRow(d, roomId)!, entries: [], stateChanged: muted !== old.muted || waiting !== old.waiting };
  });
}

/** Boot: the voice panel matches the connection (one, or none). */
export function reconcileVoicePanel(roomId: string, panelUrl: string | null): RoomAction<boolean> {
  return roomAction((d) => {
    const changed = !!roomRow(d, roomId) && syncVoicePanel(d, roomId, panelUrl);
    return { roomId, result: changed, entries: [], stateChanged: changed };
  });
}

export interface VoiceEventRow {
  vid: string;
  room_id: string;
  line_id: number | null;
  utterance_id: string | null;
  target_seat: string | null;
  utterance_ts: number;
  delivered_rung: string | null;
  delivered_ts: number | null;
  ack_ts: number | null;
  result_ts: number | null;
  connected_at_result: number | null;
  spoken: number | null;
  reason: string | null;
  over_cap: number | null;
  route_action: string | null;
  route_confidence: number | null;
  resolved: string | null;
  followup_to: string | null;
  notice_ts: number | null;
  notice_outcome: string | null;
  /** room-voice v3.3: 1 when the sid was on the allowlist (null before). */
  speaker_verified: number | null;
}
const VOICE_EVENT_COLS = [
  'vid', 'room_id', 'line_id', 'utterance_id', 'target_seat', 'utterance_ts', 'delivered_rung', 'delivered_ts', 'ack_ts', 'result_ts',
  'connected_at_result', 'spoken', 'reason', 'over_cap', 'route_action', 'route_confidence', 'resolved', 'followup_to',
  'notice_ts', 'notice_outcome', 'speaker_verified',
] as const;

/** Seed a ledger row. A vid already recorded is left as it is. */
export function recordVoiceEvent(row: Partial<VoiceEventRow> & { vid: string; room_id: string; utterance_ts: number }): void {
  const vals = VOICE_EVENT_COLS.map((c) => (row as Record<string, unknown>)[c] ?? null);
  rdb()
    .prepare(`INSERT OR IGNORE INTO voice_events (${VOICE_EVENT_COLS.join(', ')}) VALUES (${VOICE_EVENT_COLS.map(() => '?').join(', ')})`)
    .run(...vals);
}

export function listVoiceEvents(roomId: string, q: { open?: boolean } = {}): VoiceEventRow[] {
  return rdb()
    .prepare(`SELECT * FROM voice_events WHERE room_id=?${q.open ? ' AND result_ts IS NULL' : ''} ORDER BY utterance_ts, vid`)
    .all(roomId) as VoiceEventRow[];
}

/** The line, newest first, whose body holds `q` (case-insensitive; empty q =
 *  the newest). The voice agent's chat search (room-voice §6.2). */
export function searchLine(roomId: string, q: string, limit: number): RoomLineEntry[] {
  return rdb()
    .prepare(`SELECT * FROM room_line WHERE room_id=? AND body IS NOT NULL AND instr(lower(body), lower(?)) > 0 ORDER BY id DESC LIMIT ?`)
    .all(roomId, q, limit) as RoomLineEntry[];
}

/** Each seat's newest line as author: seat id → ts. */
export function lastLineBySeat(roomId: string): Record<string, number> {
  const rows = rdb().prepare(`SELECT author_seat, MAX(ts) AS ts FROM room_line WHERE room_id=? AND author_seat IS NOT NULL GROUP BY author_seat`).all(roomId) as {
    author_seat: string;
    ts: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.author_seat, r.ts]));
}

/* ---- E1c [ticket]: replies, notices and stats reads on the ledger -------- */
export function getVoiceEvent(vid: string): VoiceEventRow | undefined {
  return rdb().prepare(`SELECT * FROM voice_events WHERE vid=?`).get(vid) as VoiceEventRow | undefined;
}

/** The newest voice message sent to any of these seats (only inbound rows
 *  carry a target seat): which room a reply with no `re` answers. */
export function lastVoiceEventForSeats(seatIds: string[]): VoiceEventRow | undefined {
  if (!seatIds.length) {
    return undefined;
  }
  return rdb()
    .prepare(`SELECT * FROM voice_events WHERE target_seat IN (${seatIds.map(() => '?').join(', ')}) ORDER BY utterance_ts DESC, rowid DESC LIMIT 1`)
    .get(...seatIds) as VoiceEventRow | undefined;
}

/** A seat replied (room-voice §7): the named rows in this room, or with none
 *  named the seat's newest OPEN row. The first ack and the first result win;
 *  a reply proves delivery, so a queued row gets its delivered_ts. Returns the
 *  vids it touched. */
export function markVoiceReply(
  roomId: string,
  seatId: string,
  vids: string[],
  kind: string,
  out: { spoken: boolean; reason: string | null; overCap: boolean; connected: boolean },
): string[] {
  const d = rdb();
  const now = Date.now();
  const rows = (
    vids.length
      ? d.prepare(`SELECT vid FROM voice_events WHERE room_id=? AND vid IN (${vids.map(() => '?').join(', ')})`).all(roomId, ...vids)
      : d.prepare(`SELECT vid FROM voice_events WHERE room_id=? AND target_seat=? AND result_ts IS NULL ORDER BY utterance_ts DESC, rowid DESC LIMIT 1`).all(roomId, seatId)
  ) as { vid: string }[];
  d.transaction(() => {
    for (const { vid } of rows) {
      d.prepare(`UPDATE voice_events SET delivered_ts=COALESCE(delivered_ts, ?), delivered_rung=COALESCE(delivered_rung, 'reply') WHERE vid=?`).run(now, vid);
      if (kind === 'ack') {
        d.prepare(`UPDATE voice_events SET ack_ts=COALESCE(ack_ts, ?) WHERE vid=?`).run(now, vid);
      } else if (kind === 'result' || kind === 'question') {
        d.prepare(`UPDATE voice_events SET result_ts=?, connected_at_result=?, spoken=?, reason=?, over_cap=? WHERE vid=? AND result_ts IS NULL`).run(
          now,
          out.connected ? 1 : 0,
          out.spoken ? 1 : 0,
          out.reason,
          out.overCap ? 1 : 0,
          vid,
        );
      }
    }
  })();
  return rows.map((r) => r.vid);
}

/** Messages in a room past the no-ack deadline: sent to a seat since `since`,
 *  delivered (or uttered, if never delivered) at or before `dueBy`, with no
 *  ack, no result and no notice yet. */
export function voiceEventsDueNotice(roomId: string, since: number, dueBy: number): VoiceEventRow[] {
  return rdb()
    .prepare(
      `SELECT * FROM voice_events WHERE room_id=? AND target_seat IS NOT NULL AND ack_ts IS NULL AND result_ts IS NULL AND notice_ts IS NULL
         AND utterance_ts >= ? AND COALESCE(delivered_ts, utterance_ts) <= ? ORDER BY utterance_ts`,
    )
    .all(roomId, since, dueBy) as VoiceEventRow[];
}

/** Record a notice's outcome. `claim` takes an un-noticed row only (true when
 *  it did), so two sweeps can never send the same notice. */
export function markVoiceNotice(vid: string, outcome: string, claim = false): boolean {
  const sql = `UPDATE voice_events SET notice_ts=COALESCE(notice_ts, ?), notice_outcome=? WHERE vid=?${claim ? ' AND notice_ts IS NULL' : ''}`;
  return rdb().prepare(sql).run(Date.now(), outcome, vid).changes > 0;
}

/** Merge keys into a voice line's meta (a reply's outcome, known only after
 *  the voice service answers). Returns the updated entry. */
export function patchVoiceLineMeta(lineId: number, patch: Record<string, unknown>): RoomLineEntry | undefined {
  const d = rdb();
  const e = d.prepare(`SELECT * FROM room_line WHERE id=? AND kind='voice'`).get(lineId) as RoomLineEntry | undefined;
  if (!e) {
    return undefined;
  }
  e.meta = JSON.stringify({ ...JSON.parse(e.meta ?? '{}'), ...patch });
  d.prepare(`UPDATE room_line SET meta=? WHERE id=?`).run(e.meta, lineId);
  return e;
}

/** Text reply times (stats): each chat line addressed to a seat, and the
 *  first later line that seat authored (null = none yet). */
export function textReplyTimes(roomId: string, since: number): { ts: number; reply_ts: number | null }[] {
  return rdb()
    .prepare(
      `SELECT l.ts AS ts, (SELECT MIN(r.ts) FROM room_line r WHERE r.room_id=l.room_id AND r.author_seat=l.target_seat AND r.id>l.id) AS reply_ts
         FROM room_line l WHERE l.room_id=? AND l.kind='chat' AND l.ts>=? AND l.target_seat IS NOT NULL
         AND (l.author_seat IS NULL OR l.author_seat<>l.target_seat)`,
    )
    .all(roomId, since) as { ts: number; reply_ts: number | null }[];
}

/* ------------------------------------------------------------ room assets ---- */
/* Room thin app #2 (ticket). The engine is the authority for which
   agent-share folder a room's assets live in; the bytes are agent-share's. */

export interface RoomAssetRecord {
  /** agent-share ref, `rooms/<slug>-<id8>/<name>`: the key. */
  path: string;
  room_id: string;
  /** As STORED (agent-share turns a collision into name-1). */
  name: string;
  size: number;
  type: string;
  /** 'user' or a SEAT id — never a handle (handles rename). */
  added_by: string;
  added_at: number;
  /** The room line it came from [scratch seen]; null for rows older than the column. */
  line_id?: number | null;
  /** The compact ref id (12 hex), stable across a rename or move. */
  asset_id: string;
  /** The upload's batch (an x-batch header), or null: a file with none is its own batch. */
  batch_id: string | null;
}

/** The folder for a room's assets, derived ONCE (`rooms/<slug(name)>-<first 8
 *  of id>`: names collide, ids do not) and stored, so a rename keeps it. */
export function roomAssetFolder(roomId: string): string {
  return roomAction((d) => {
    const room = requireRoom(d, roomId);
    if (process.env.HARBOR_WB_HOSTED === '1' && room.asset_folder && room.asset_folder !== `rooms/${room.id}/assets`) {
      /* HOSTED: one mapping (<root>/rooms/<room id>/assets), so a legacy value is replaced - unless its folder already holds files, which stay reachable where they are (nothing is moved or deleted here) */
      const base = (process.env.HARBOR_WB_FILES_DIR ?? '').trim();
      let populated = false;
      try {
        populated = !!base && readdirSync(join(base, room.asset_folder)).length > 0;
      } catch {
        /* no such folder */
      }
      if (!populated) {
        d.prepare(`UPDATE rooms SET asset_folder=? WHERE id=?`).run(`rooms/${room.id}/assets`, room.id);
        return { roomId, result: roomRow(d, room.id)!.asset_folder!, entries: [], stateChanged: false };
      }
    }
    if (room.asset_folder) {
      return { roomId, result: room.asset_folder, entries: [], stateChanged: false };
    }
    /* the slug is capped (40) so the whole path of a file in the person's folder stays well under Windows' 260 characters */
    /* HOSTED: the room's assets ARE the web files tree, <root>/rooms/<room id>/assets (room-files.ts), so a message picture and the Files panel's Assets are one file */
    const folder = process.env.HARBOR_WB_HOSTED === '1' ? `rooms/${room.id}/assets` : `rooms/${(normalizeSlug(room.name) ?? 'room').slice(0, 40).replace(/-+$/, '')}-${room.id.replace(/-/g, '').slice(0, 8)}`;
    d.prepare(`UPDATE rooms SET asset_folder=? WHERE id=? AND asset_folder IS NULL`).run(folder, room.id);
    return { roomId, result: roomRow(d, room.id)!.asset_folder!, entries: [], stateChanged: false };
  }).result;
}

/** Record an asset that came in through the engine, and put ONE Room fact on
 *  the line ("<who> added <name>"). The upload already happened: a refusal
 *  here (room archived, author left) leaves the file on the share unrecorded,
 *  which lists exactly like a file an agent dropped directly. */
export function recordAsset(
  roomId: string,
  input: { path: string; name: string; size: number; type: string; url: string; batchId?: string | null },
  opts: RoomActionOpts,
  quiet = false,
  /** [scratch seen] the line it came with (an attachment's message); a non-quiet
   *  record uses the "added" fact it writes. */
  lineId: number | null = null,
): RoomAction<RoomAssetRecord & { added_by_handle: string }> {
  return roomAction((d) => {
    requireOpen(requireRoom(d, roomId));
    const who = authorOf(d, roomId, opts.actor);
    const addedBy = who.author_seat ?? 'user';
    const now = Date.now();
    const batchId = typeof input.batchId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.batchId) ? input.batchId : null;
    /* an upsert, NOT INSERT OR REPLACE: a re-record of the same path keeps its asset_id (its ref must not change) */
    d.prepare(
      `INSERT INTO room_assets (path, room_id, name, size, type, added_by, added_at, line_id, asset_id, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET room_id=excluded.room_id, name=excluded.name, size=excluded.size, type=excluded.type, added_by=excluded.added_by,
         added_at=excluded.added_at, line_id=excluded.line_id, batch_id=excluded.batch_id, asset_id=COALESCE(room_assets.asset_id, excluded.asset_id)`,
    ).run(input.path, roomId, input.name, input.size, input.type, addedBy, now, lineId, randomBytes(6).toString('hex'), batchId);
    const assetId = (d.prepare(`SELECT asset_id FROM room_assets WHERE path=?`).get(input.path) as { asset_id: string }).asset_id;
    const rec: RoomAssetRecord = { path: input.path, room_id: roomId, name: input.name, size: input.size, type: input.type, added_by: addedBy, added_at: now, line_id: lineId, asset_id: assetId, batch_id: batchId };
    if (quiet) {
      /* an ATTACHMENT (ticket): the message that carries it is the record on
         the line, so no "added" fact beside it */
      return { roomId, result: { ...rec, added_by_handle: who.author }, entries: [], stateChanged: false };
    }
    const seat = who.author_seat ? seatRow(d, who.author_seat) ?? null : null;
    const fact = writeFact(d, roomId, `${seat ? `@${seat.handle}` : 'user'} added ${input.name}`, seat, null, {
      asset: input.path,
      name: input.name,
      url: input.url,
      size: input.size,
      type: input.type,
      by: addedBy,
    });
    d.prepare(`UPDATE room_assets SET line_id=? WHERE path=?`).run(fact.id, input.path);
    return { roomId, result: { ...rec, line_id: fact.id, added_by_handle: who.author }, entries: [fact], stateChanged: false };
  });
}

/** The engine's upload records for a room, with the adder's CURRENT handle
 *  ('user' for the user; a seat that has left keeps its last handle). */
/** [scratch seen] An asset moved or renamed on the share: its record (if any) and every
 *  person's seen mark follow it to the new path / room. */
export function moveAssetRecord(oldPath: string, to: { path: string; room_id: string; name: string }): void {
  const d = rdb();
  scratchSeenDbOf(d);
  d.transaction(() => {
    d.prepare(`UPDATE room_assets SET path=?, room_id=?, name=? WHERE path=?`).run(to.path, to.room_id, to.name, oldPath);
    d.prepare(`UPDATE OR IGNORE room_scratch_seen SET item=?, room_id=? WHERE kind='asset' AND item=?`).run(to.path, to.room_id, oldPath);
  })();
}
/** [scratch seen] An asset removed from the room: its record goes (seen marks are harmless). */
export function removeAssetRecord(path: string): void {
  rdb().prepare(`DELETE FROM room_assets WHERE path=?`).run(path);
}

/** One asset by its compact-ref id (12 hex), or undefined for an unknown or malformed id. The caller decides whether the asker may see its room. */
export function assetById(assetId: string): (RoomAssetRecord & { added_by_handle: string }) | undefined {
  if (!/^[0-9a-f]{12}$/.test(assetId)) {
    return undefined;
  }
  return rdb()
    .prepare(
      `SELECT a.*, CASE WHEN a.added_by = 'user' THEN 'user' ELSE COALESCE(s.handle, a.added_by) END AS added_by_handle
         FROM room_assets a LEFT JOIN room_seats s ON s.id = a.added_by WHERE a.asset_id=?`,
    )
    .get(assetId) as (RoomAssetRecord & { added_by_handle: string }) | undefined;
}

/** EVERY note of a room (archived too when asked), newest change first: the index pages over it. */
export function listAllRoomNotes(roomId: string, includeArchived = false): RoomNote[] {
  return rdb()
    .prepare(`SELECT * FROM room_notes WHERE room_id = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY updated_at DESC, rowid DESC`)
    .all(roomId) as RoomNote[];
}

export function listAssetRecords(roomId: string): Array<RoomAssetRecord & { added_by_handle: string }> {
  return rdb()
    .prepare(
      `SELECT a.*, CASE WHEN a.added_by = 'user' THEN 'user' ELSE COALESCE(s.handle, a.added_by) END AS added_by_handle
         FROM room_assets a LEFT JOIN room_seats s ON s.id = a.added_by
        WHERE a.room_id=? ORDER BY a.added_at DESC`,
    )
    .all(roomId) as Array<RoomAssetRecord & { added_by_handle: string }>;
}


/* ---- PANE CHAT [agent chat] (Owner 2026-10-05): the turns a vendor's HOOKS
   delivered, for a brand whose transcript the engine cannot read (codex-cli:
   its rollout files live in another account's home). Additive, idempotent,
   capped per pane. Text is stored (that is the point) but never logged. ---- */
export const PANE_CHAT_CAP = 2000;
export interface PaneChatRow {
  paneid: string;
  seq: number;
  role: 'user' | 'agent';
  text: string;
  ts: number;
}
function paneChatDb(): Database.Database {
  const d = open();
  d.exec(`
    CREATE TABLE IF NOT EXISTS pane_chat (
      seq    INTEGER PRIMARY KEY AUTOINCREMENT,
      paneid TEXT NOT NULL,
      role   TEXT NOT NULL,
      text   TEXT NOT NULL,
      ts     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pane_chat_pane ON pane_chat(paneid, seq);
  `);
  return d;
}
/** Append one turn; an agent turn identical to the pane's last agent turn is a
 *  repeat of the same Stop and is skipped. Returns the new seq, or null. */
export function appendPaneChat(paneid: string, role: 'user' | 'agent', text: string, ts: number = Date.now()): number | null {
  const d = paneChatDb();
  if (role === 'agent') {
    const last = d.prepare(`SELECT text FROM pane_chat WHERE paneid=? AND role='agent' ORDER BY seq DESC LIMIT 1`).get(paneid) as { text: string } | undefined;
    if (last && last.text === text) {
      return null;
    }
  }
  const r = d.prepare(`INSERT INTO pane_chat (paneid, role, text, ts) VALUES (?, ?, ?, ?)`).run(paneid, role, text, ts);
  const seq = Number(r.lastInsertRowid);
  const n = (d.prepare(`SELECT COUNT(*) AS n FROM pane_chat WHERE paneid=?`).get(paneid) as { n: number }).n;
  if (n > PANE_CHAT_CAP) {
    d.prepare(`DELETE FROM pane_chat WHERE seq IN (SELECT seq FROM pane_chat WHERE paneid=? ORDER BY seq ASC LIMIT ?)`).run(paneid, n - PANE_CHAT_CAP);
  }
  return seq;
}
/** Turns oldest-first. `before`/`after` are seqs; with neither, the newest `limit`. */
export function listPaneChat(paneid: string, o: { before?: number; after?: number; limit: number }): { rows: PaneChatRow[]; more: boolean; latest: number | null } {
  const d = paneChatDb();
  const latest = (d.prepare(`SELECT MAX(seq) AS m FROM pane_chat WHERE paneid=?`).get(paneid) as { m: number | null }).m;
  if (o.after !== undefined) {
    const rows = d.prepare(`SELECT * FROM pane_chat WHERE paneid=? AND seq>? ORDER BY seq ASC LIMIT ?`).all(paneid, o.after, o.limit) as PaneChatRow[];
    return { rows, more: false, latest };
  }
  const back = d
    .prepare(`SELECT * FROM pane_chat WHERE paneid=? AND seq<? ORDER BY seq DESC LIMIT ?`)
    .all(paneid, o.before ?? Number.MAX_SAFE_INTEGER, o.limit + 1) as PaneChatRow[];
  const more = back.length > o.limit;
  return { rows: back.slice(0, o.limit).reverse(), more, latest };
}

/* ---- CHATTER [chatter] (Owner 2026-10-06): the raw rows the chatter report reads
   (engine/chatter.ts does the math), the events no other table records (a fabric
   DM routed into a pane, a send refused because its recipient is quiet), and the
   person's quiet list. Events hold slugs and envelope ids only, never a body. ---- */
export interface ChatterEventRow {
  ts: number;
  /** phase 2 adds: dm_sent (an accepted DM at the send door: from_slug -> slug), the
   *  refusals (ack_only, lead_echo, dm_budget, dm_repeat) and lead_echo_confirmed. */
  kind:
    | 'fabric_dm'
    | 'quiet_refused'
    | 'dm_sent'
    | 'ack_only'
    | 'lead_echo'
    | 'lead_echo_confirmed'
    | 'dm_budget'
    | 'dm_repeat'
    /* [agent comms] a rule in 'watch' mode: it WOULD have refused; the line or DM went through */
    | 'watch_ack_only'
    | 'watch_lead_echo'
    | 'watch_dm_budget'
    | 'watch_dm_repeat'
    /* [agent rest] level 1: a pane parked, and woken */
    | 'agent_rested'
    | 'agent_woken';
  paneid: string | null;
  slug: string | null;
  from_slug: string | null;
  env_id: string | null;
}
function chatterDb(): Database.Database {
  const d = rdb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS chatter_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      kind      TEXT NOT NULL,
      paneid    TEXT,
      slug      TEXT,
      from_slug TEXT,
      env_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chatter_events_ts ON chatter_events(ts);
  `);
  return d;
}
export function recordChatterEvent(e: ChatterEventRow): void {
  chatterDb()
    .prepare(`INSERT INTO chatter_events (ts, kind, paneid, slug, from_slug, env_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(e.ts, e.kind, e.paneid, e.slug, e.from_slug, e.env_id);
}
/** Everything the report needs since `since` (ms). Line bodies stay in the engine. */
export function chatterSource(since: number): {
  lines: Array<{ id: number; room_id: string; room_name: string; ts: number; author: string; kind: string; body: string; to_person: number; target: string | null }>;
  xposts: Array<{ line_id: number; author: string; ts: number; room_id: string }>;
  fabricTurns: Array<{ paneid: string; slug: string | null; ts: number; text: string }>;
  events: Array<ChatterEventRow>;
} {
  const d = chatterDb();
  paneChatDb();
  const lines = d
    .prepare(
      `SELECT l.id, l.room_id, IFNULL(r.name, l.room_id) AS room_name, l.ts, l.author, l.kind, IFNULL(l.body, '') AS body, l.target,
              (l.author NOT IN ('user','room','concierge') AND ${TO_ME_SQL}) AS to_person
         FROM room_line l LEFT JOIN rooms r ON r.id = l.room_id
        WHERE l.ts >= ? AND l.kind IN (${UNREAD_KINDS}) ORDER BY l.id`,
    )
    .all(since) as any[];
  const xposts = d
    .prepare(`SELECT x.line_id, l.author, l.ts, x.room_id FROM room_line_xpost x JOIN room_line l ON l.id = x.line_id WHERE l.ts >= ?`)
    .all(since) as any[];
  const fabricTurns = d
    .prepare(
      `SELECT c.paneid, s.agent AS slug, c.ts, c.text FROM pane_chat c LEFT JOIN sessions s ON s.paneid = c.paneid
        WHERE c.ts >= ? AND c.role = 'user' AND instr(c.text, '[fabric · @') > 0 ORDER BY c.ts`,
    )
    .all(since) as any[];
  const events = d.prepare(`SELECT ts, kind, paneid, slug, from_slug, env_id FROM chatter_events WHERE ts >= ? ORDER BY ts`).all(since) as ChatterEventRow[];
  return { lines, xposts, fabricTurns, events };
}
/** How many `kind` events `from` -> `slug` since `since` (the DM budget's count). */
export function countChatterEvents(kind: ChatterEventRow['kind'], from: string, slug: string, since: number): number {
  return (
    chatterDb().prepare(`SELECT COUNT(*) AS n FROM chatter_events WHERE kind = ? AND from_slug = ? AND slug = ? AND ts >= ?`).get(kind, from, slug, since) as { n: number }
  ).n;
}
/** Lines addressed to the person (TO_ME_SQL) in one room since `since`, by any agent seat
 *  but `notSeat`: what a lead's line to the person may be echoing [chatter p2]. */
export function recentToPersonLines(roomId: string, since: number, notSeat: string): Array<{ id: number; author: string; ts: number; body: string }> {
  return rdb()
    .prepare(
      `SELECT id, author, ts, IFNULL(body, '') AS body FROM room_line
        WHERE room_id = ? AND ts >= ? AND kind IN (${UNREAD_KINDS}) AND author NOT IN ('user','room','concierge')
          AND IFNULL(author_seat, '') <> ? AND ${TO_ME_SQL} ORDER BY id`,
    )
    .all(roomId, since, notSeat) as any[];
}
const QUIET_KEY = 'chatter.quiet';
/** The slugs the person has marked quiet (agent slugs or minted work slugs), sorted. */
export function chatterQuiet(): string[] {
  const v = getEngineSetting(QUIET_KEY);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').sort() : [];
}
export function setChatterQuiet(slug: string, quiet: boolean): string[] {
  const set = new Set(chatterQuiet());
  if (quiet) {
    set.add(slug);
  } else {
    set.delete(slug);
  }
  const out = [...set].sort();
  setEngineSetting(QUIET_KEY, out);
  return out;
}

/* ---- ROOM NOTES [ticket]: rows + the full-text index. Keywords are computed
   by engine/notes-index.ts and handed in; nothing here logs note text. ---- */

/** A note's text ceiling (characters). "No length limit" in practice: over it
 *  is refused with both numbers (413), never truncated. Below the 2 MB request
 *  body cap on purpose, so this refusal (with its numbers) is the one a person
 *  sees for a plain-text paste. */
export const NOTE_TEXT_MAX = 1_000_000;
/** The visible list: notes from the last 24 h, topped up to X (not a setting yet). */
export const NOTES_VISIBLE_MIN = 10;
export const NOTES_RECENT_MS = 24 * 60 * 60 * 1000;
export const NOTES_SEARCH_LIMIT = 50;

export interface RoomNote {
  id: string;
  room_id: string;
  created_by: string | null;
  text: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  archived: number;
  keywords: string;
  indexed_at: number | null;
  dirty: number;
}

function noteTextOk(text: unknown): string {
  if (typeof text !== 'string') {
    throw new RoomError(400, 'text is the note (a string)', 'text');
  }
  if (text.length > NOTE_TEXT_MAX) {
    throw new RoomError(413, `the note is ${text.length} characters; the note limit is ${NOTE_TEXT_MAX}`, 'text');
  }
  return text;
}

export function createRoomNote(roomId: string, createdBy: string | null, text: unknown = '', now = Date.now()): RoomNote {
  const t = noteTextOk(text);
  const id = randomBytes(6).toString('hex');
  rdb()
    .prepare('INSERT INTO room_notes (id, room_id, created_by, text, created_at, updated_at, dirty) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(id, roomId, createdBy, t, now, now);
  return getRoomNote(roomId, id)!;
}

/** Found only within its room: another room's id is simply not there. */
export function getRoomNote(roomId: string, id: string): RoomNote | undefined {
  return rdb().prepare('SELECT * FROM room_notes WHERE id = ? AND room_id = ?').get(id, roomId) as RoomNote | undefined;
}

/** Autosave: text, updated_at, dirty = 1. Never indexes. Last write wins. */
export function setRoomNoteText(roomId: string, id: string, text: unknown, now = Date.now()): RoomNote | undefined {
  const t = noteTextOk(text);
  const r = rdb().prepare('UPDATE room_notes SET text = ?, updated_at = ?, dirty = 1 WHERE id = ? AND room_id = ?').run(t, now, id, roomId);
  return r.changes ? getRoomNote(roomId, id) : undefined;
}

export function setRoomNoteFlag(roomId: string, id: string, flag: 'pinned' | 'archived', on: boolean): RoomNote | undefined {
  const col = flag === 'pinned' ? 'pinned' : 'archived'; // never interpolate caller text
  const r = rdb().prepare(`UPDATE room_notes SET ${col} = ? WHERE id = ? AND room_id = ?`).run(on ? 1 : 0, id, roomId);
  return r.changes ? getRoomNote(roomId, id) : undefined;
}

/** The list the Assets panel shows (D8): pinned first, then every non-archived
 *  note updated in the last 24 h, topped up with the most recent others to
 *  NOTES_VISIBLE_MIN (pinned count toward it). 20 recent = all 20. */
/* ---- SCRATCHPAD SEEN-STATE [scratch seen] (Owner 2026-10-07, UI 5857/5866): per PERSON
   (the room badges' key), per room, per kind ('asset' | 'note'), which items that person
   has seen; and a per (person, room) BASELINE, set the first time their counts are read:
   anything created before it counts as seen, so an old room does not light up on day one.
   A person's own uploads and notes are marked seen when they make them (rooms.ts). ---- */
export type ScratchKind = 'asset' | 'note';
function scratchSeenDb(): Database.Database {
  return scratchSeenDbOf(rdb());
}
function scratchSeenDbOf(d: Database.Database): Database.Database {
  d.exec(`
    CREATE TABLE IF NOT EXISTS room_scratch_seen (
      person  TEXT NOT NULL,
      room_id TEXT NOT NULL,
      kind    TEXT NOT NULL,
      item    TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (person, room_id, kind, item)
    );
    CREATE TABLE IF NOT EXISTS room_scratch_baseline (
      person  TEXT NOT NULL,
      room_id TEXT NOT NULL,
      at      INTEGER NOT NULL,
      PRIMARY KEY (person, room_id)
    );
  `);
  return d;
}
/** The (person, room) baseline: set now if absent, then read. */
export function scratchBaseline(person: string, roomId: string, now = Date.now()): number {
  const d = scratchSeenDb();
  d.prepare(`INSERT OR IGNORE INTO room_scratch_baseline (person, room_id, at) VALUES (?, ?, ?)`).run(person, roomId, now);
  return (d.prepare(`SELECT at FROM room_scratch_baseline WHERE person=? AND room_id=?`).get(person, roomId) as { at: number }).at;
}
/** The items of `kind` this person has marked seen in this room. */
export function scratchSeen(person: string, roomId: string, kind: ScratchKind): Set<string> {
  const rows = scratchSeenDb().prepare(`SELECT item FROM room_scratch_seen WHERE person=? AND room_id=? AND kind=?`).all(person, roomId, kind) as Array<{ item: string }>;
  return new Set(rows.map((r) => r.item));
}
/** Mark items seen (idempotent). Returns how many were NEWLY marked. */
export function markScratchSeen(person: string, roomId: string, kind: ScratchKind, ids: readonly string[], now = Date.now()): number {
  const d = scratchSeenDb();
  const ins = d.prepare(`INSERT OR IGNORE INTO room_scratch_seen (person, room_id, kind, item, seen_at) VALUES (?, ?, ?, ?, ?)`);
  let n = 0;
  d.transaction(() => {
    for (const id of ids) {
      n += ins.run(person, roomId, kind, id, now).changes;
    }
  })();
  return n;
}
/** Every non-archived note of a room, id and creation time (the Scratchpad's total). */
export function scratchNoteItems(roomId: string): Array<{ id: string; created_at: number }> {
  return rdb().prepare(`SELECT id, created_at FROM room_notes WHERE room_id=? AND archived=0`).all(roomId) as Array<{ id: string; created_at: number }>;
}

export function listRoomNotesVisible(roomId: string, now = Date.now()): RoomNote[] {
  const all = rdb()
    .prepare('SELECT * FROM room_notes WHERE room_id = ? AND archived = 0 ORDER BY updated_at DESC, rowid DESC')
    .all(roomId) as RoomNote[];
  const pinned = all.filter((n) => n.pinned);
  const rest = all.filter((n) => !n.pinned);
  const recent = rest.filter((n) => n.updated_at > now - NOTES_RECENT_MS);
  const top = Math.max(recent.length, NOTES_VISIBLE_MIN - pinned.length);
  return [...pinned, ...rest.slice(0, Math.max(0, top))];
}

/** A safe FTS5 MATCH for free text: every token quoted (so AND / NEAR / * / "
 *  are just words), the last one a prefix so a search-as-you-type finds it.
 *  null = nothing searchable. */
export function ftsQuery(q: string): string | null {
  const toks = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12);
  if (!toks.length) {
    return null;
  }
  return toks.map((t, i) => `"${t}"${i === toks.length - 1 ? '*' : ''}`).join(' ');
}

export function searchRoomNotes(roomId: string, q: string): Array<RoomNote & { rank: number }> {
  const m = ftsQuery(q);
  if (!m) {
    return [];
  }
  return rdb()
    .prepare(
      `SELECT n.*, f.rank AS rank FROM room_notes_fts f JOIN room_notes n ON n.id = f.note_id
       WHERE room_notes_fts MATCH ? AND f.room_id = ? AND n.room_id = ?
       ORDER BY f.rank, n.updated_at DESC LIMIT ?`,
    )
    .all(m, roomId, roomId, NOTES_SEARCH_LIMIT) as Array<RoomNote & { rank: number }>;
}

/** What the keyword ranker may know of the note's room. */
export interface NoteRanker {
  keywords: (text: string, max: number | undefined, stats: { n: number; df: (term: string) => number }) => string[];
  terms: (text: string) => string[];
}

/** Replace a note's term rows, then rank its keywords against the room's counts. */
function rankNote(d: Database.Database, n: RoomNote, r: NoteRanker): string {
  const terms = r.terms(n.text);
  d.prepare('DELETE FROM room_note_terms WHERE note_id = ?').run(n.id);
  const ins = d.prepare('INSERT OR IGNORE INTO room_note_terms (room_id, term, note_id) VALUES (?, ?, ?)');
  for (const t of terms) {
    ins.run(n.room_id, t, n.id);
  }
  const total = (d.prepare('SELECT COUNT(DISTINCT note_id) AS c FROM room_note_terms WHERE room_id = ?').get(n.room_id) as { c: number }).c;
  const cnt = d.prepare('SELECT COUNT(*) AS c FROM room_note_terms WHERE room_id = ? AND term = ?');
  const df = (t: string): number => (cnt.get(n.room_id, t) as { c: number }).c;
  return JSON.stringify(r.keywords(n.text, undefined, { n: total, df }));
}

/** Index one note NOW from its current text: keywords + the FTS row +
 *  indexed_at, dirty = 0. Synchronous, so the text read and written are one. */
export function indexRoomNote(id: string, ranker: NoteRanker, now = Date.now()): RoomNote | undefined {
  const d = rdb();
  return d.transaction(() => {
    const n = d.prepare('SELECT * FROM room_notes WHERE id = ?').get(id) as RoomNote | undefined;
    if (!n) {
      return undefined;
    }
    d.prepare('DELETE FROM room_notes_fts WHERE note_id = ?').run(id);
    d.prepare('INSERT INTO room_notes_fts (text, note_id, room_id) VALUES (?, ?, ?)').run(n.text, id, n.room_id);
    d.prepare('UPDATE room_notes SET keywords = ?, indexed_at = ?, dirty = 0 WHERE id = ?').run(rankNote(d, n, ranker), now, id);
    return d.prepare('SELECT * FROM room_notes WHERE id = ?').get(id) as RoomNote;
  })();
}

/** Start-up re-rank, pass 1: a note with no term rows yet gets them. */
export function fillRoomNoteTerms(id: string, termsOf: (text: string) => string[]): void {
  const d = rdb();
  d.transaction(() => {
    const n = d.prepare('SELECT * FROM room_notes WHERE id = ?').get(id) as RoomNote | undefined;
    if (!n || d.prepare('SELECT 1 FROM room_note_terms WHERE note_id = ? LIMIT 1').get(id)) {
      return;
    }
    const ins = d.prepare('INSERT OR IGNORE INTO room_note_terms (room_id, term, note_id) VALUES (?, ?, ?)');
    for (const t of termsOf(n.text)) {
      ins.run(n.room_id, t, id);
    }
  })();
}

/** Start-up re-rank, pass 2: keywords only; the FTS row, indexed_at and dirty are untouched. */
export function rerankRoomNote(id: string, ranker: NoteRanker): void {
  const d = rdb();
  d.transaction(() => {
    const n = d.prepare('SELECT * FROM room_notes WHERE id = ?').get(id) as RoomNote | undefined;
    if (n && n.indexed_at !== null) {
      d.prepare('UPDATE room_notes SET keywords = ? WHERE id = ?').run(rankNote(d, n, ranker), id);
    }
  })();
}

export function allRoomNoteIds(): string[] {
  return (rdb().prepare('SELECT id FROM room_notes ORDER BY created_at, rowid').all() as { id: string }[]).map((r) => r.id);
}

/** Remove a note and its FTS row (an empty note on close; the only delete there is). */
/** The room a note belongs to (for the note-copy observer, which only gets an id on removal). */
export function roomIdOfNote(id: string): string | undefined {
  return (rdb().prepare('SELECT room_id FROM room_notes WHERE id = ?').get(id) as { room_id: string } | undefined)?.room_id;
}

export function removeRoomNote(id: string): void {
  const d = rdb();
  d.transaction(() => {
    d.prepare('DELETE FROM room_notes_fts WHERE note_id = ?').run(id);
    d.prepare('DELETE FROM room_note_terms WHERE note_id = ?').run(id);
    d.prepare('DELETE FROM room_notes WHERE id = ?').run(id);
  })();
}

export interface SentNote {
  id: string;
  room_id: string;
  note_id: string | null;
  entry_id: number | null;
  text: string;
  title: string;
  words: number;
  created_at: number;
  created_by: string | null;
}

/** Snapshot the text a message carries. Immutable from here on. */
export function createSentNote(roomId: string, input: { noteId: string | null; text: string; title: string; words: number; createdBy: string | null }, now = Date.now()): SentNote {
  const id = randomBytes(6).toString('hex');
  rdb()
    .prepare('INSERT INTO room_notes_sent (id, room_id, note_id, text, title, words, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, roomId, input.noteId, input.text, input.title, input.words, now, input.createdBy);
  return getSentNote(roomId, id)!;
}

/** Found only within its room. */
export function getSentNote(roomId: string, id: string): SentNote | undefined {
  return rdb().prepare('SELECT * FROM room_notes_sent WHERE id = ? AND room_id = ?').get(id, roomId) as SentNote | undefined;
}

/** The line entry it went out with, once that exists. */
export function setSentNoteEntry(id: string, entryId: number): void {
  rdb().prepare('UPDATE room_notes_sent SET entry_id = ? WHERE id = ?').run(entryId, id);
}

/** Claim a welcome for (seat, pane, room): true = newly claimed (send it). */
export function claimSeatWelcome(seatId: string, paneid: string, roomId: string, now = Date.now()): boolean {
  return rdb().prepare('INSERT OR IGNORE INTO seat_welcomes (seat_id, paneid, room_id, at) VALUES (?, ?, ?, ?)').run(seatId, paneid, roomId, now).changes > 0;
}

/** Give a claim back (the line could not be delivered), so the next bind tries again. */
export function releaseSeatWelcome(seatId: string, paneid: string, roomId: string): void {
  rdb().prepare('DELETE FROM seat_welcomes WHERE seat_id = ? AND paneid = ? AND room_id = ?').run(seatId, paneid, roomId);
}

/** Claim the direct-chat note for a pane: true = this is its first chat message. */
export function claimChatNote(paneid: string, now = Date.now()): boolean {
  return rdb().prepare('INSERT OR IGNORE INTO chat_notes (paneid, at) VALUES (?, ?)').run(paneid, now).changes > 0;
}

export function releaseChatNote(paneid: string): void {
  rdb().prepare('DELETE FROM chat_notes WHERE paneid = ?').run(paneid);
}

/** A snapshot whose message never went out. */
export function removeSentNote(id: string): void {
  rdb().prepare('DELETE FROM room_notes_sent WHERE id = ?').run(id);
}

/** Ids of empty (whitespace-only) notes last touched before `before`: an abandoned "New note". */
export function emptyRoomNoteIds(before: number): string[] {
  return (rdb().prepare("SELECT id FROM room_notes WHERE trim(text, ' ' || char(9) || char(10) || char(13)) = '' AND updated_at < ?").all(before) as { id: string }[]).map((r) => r.id);
}

/** Notes edited but not indexed, idle since before `idleBefore` (the sweep). */
export function dirtyRoomNoteIds(idleBefore: number): string[] {
  return (rdb().prepare('SELECT id FROM room_notes WHERE dirty = 1 AND updated_at < ?').all(idleBefore) as { id: string }[]).map((r) => r.id);
}

/* ================================================================= sites ====
 * [basic] NEW SITE (blueprint design-notes-id "Sharing a site"): one project =
 * one room, one folder, two addresses. The row LOCKS a room to its {slug, id,
 * name, dir}. A `retired` row keeps its id so it is never handed out again; only
 * `ready` rows answer by slug or room.
 */
export interface SiteRow {
  room_id: string;
  slug: string;
  site_id: string;
  name: string;
  dir: string;
  recipe_id: string | null;
  state: 'ready' | 'retired';
  created_at: number;
}
let sitesFor: Database.Database | null = null;
function sdb(): Database.Database {
  const d = open();
  if (sitesFor !== d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS sites (
        room_id    TEXT NOT NULL,
        slug       TEXT NOT NULL,
        site_id    TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        dir        TEXT NOT NULL,
        recipe_id  TEXT,
        state      TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','retired')),
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_slug_ready ON sites(slug) WHERE state = 'ready';
      CREATE INDEX IF NOT EXISTS idx_sites_room ON sites(room_id);
    `);
    sitesFor = d;
  }
  return d;
}
export function getSiteByRoom(roomId: string): SiteRow | undefined {
  return sdb().prepare(`SELECT * FROM sites WHERE room_id = ? AND state = 'ready'`).get(roomId) as SiteRow | undefined;
}
export function getSiteBySlug(slug: string): SiteRow | undefined {
  return sdb().prepare(`SELECT * FROM sites WHERE slug = ? AND state = 'ready'`).get(slug) as SiteRow | undefined;
}
/** Has this public id EVER been used (any state)? */
export function siteIdUsed(siteId: string): boolean {
  return !!sdb().prepare(`SELECT 1 FROM sites WHERE site_id = ?`).get(siteId);
}
export function insertSite(r: Omit<SiteRow, 'state' | 'created_at'>): SiteRow {
  const row: SiteRow = { ...r, state: 'ready', created_at: Date.now() };
  sdb()
    .prepare(`INSERT INTO sites (room_id, slug, site_id, name, dir, recipe_id, state, created_at) VALUES (@room_id, @slug, @site_id, @name, @dir, @recipe_id, @state, @created_at)`)
    .run(row);
  return row;
}
/** A creation rolled back before it finished: the row goes. Its id stays in the
 *  folder's .site.json, so a retry adopting that folder is the same project. */
export function deleteSite(siteId: string): void {
  sdb().prepare(`DELETE FROM sites WHERE site_id = ?`).run(siteId);
}
/** A finished site whose room was archived on purpose: its id is kept, never reissued. */
export function retireSite(siteId: string): void {
  sdb().prepare(`UPDATE sites SET state = 'retired' WHERE site_id = ?`).run(siteId);
}


/* ---- CONCIERGE SIGN-OFFS: the record only (rules in engine/concierge-signoff.ts) ---- */
export interface SignoffRow {
  id: string;
  created_at: number;
  expires_at: number;
  state: 'pending' | 'approved' | 'cancelled' | 'expired' | 'consumed';
  verb: string;
  targets: string;
  args: string;
  args_hash: string;
  text: string;
  answered_at: number | null;
  answered_by: string | null;
  via: string | null;
  consumed_at: number | null;
  result: string | null;
}
export function signoffInsert(r: Pick<SignoffRow, 'id' | 'created_at' | 'expires_at' | 'verb' | 'targets' | 'args' | 'args_hash' | 'text'>): void {
  open()
    .prepare(`INSERT INTO concierge_signoff (id, created_at, expires_at, state, verb, targets, args, args_hash, text) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
    .run(r.id, r.created_at, r.expires_at, r.verb, r.targets, r.args, r.args_hash, r.text);
}
export function signoffGet(id: string): SignoffRow | undefined {
  return open().prepare(`SELECT * FROM concierge_signoff WHERE id = ?`).get(id) as SignoffRow | undefined;
}
export function signoffList(state: SignoffRow['state'] | null, limit: number): SignoffRow[] {
  return (state
    ? open().prepare(`SELECT * FROM concierge_signoff WHERE state = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(state, limit)
    : open().prepare(`SELECT * FROM concierge_signoff ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit)) as SignoffRow[];
}
/** Move a record from one of `from` to `to` in ONE statement; true when it moved (so two racing answers or acts cannot both win). */
export function signoffMove(id: string, from: SignoffRow['state'][], to: SignoffRow['state'], set: Partial<Pick<SignoffRow, 'answered_at' | 'answered_by' | 'via' | 'consumed_at' | 'result'>> = {}, notAfter?: number): boolean {
  const cols = Object.keys(set) as (keyof typeof set)[];
  const sql = `UPDATE concierge_signoff SET state = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ? AND state IN (${from.map(() => '?').join(',')})${notAfter === undefined ? '' : ' AND expires_at > ?'}`;
  const args: unknown[] = [to, ...cols.map((c) => set[c] ?? null), id, ...from, ...(notAfter === undefined ? [] : [notAfter])];
  return open().prepare(sql).run(...args).changes === 1;
}
/** Sweep: every pending/approved record past its expiry becomes expired. Returns how many. */
export function signoffExpire(now: number): number {
  return open().prepare(`UPDATE concierge_signoff SET state = 'expired' WHERE state IN ('pending','approved') AND expires_at <= ?`).run(now).changes;
}
/** Cancel pending/approved records of these verbs (null = all). Returns how many. */
export function signoffCancel(verbs: string[] | null): number {
  if (verbs && !verbs.length) {
    return 0;
  }
  return open()
    .prepare(`UPDATE concierge_signoff SET state = 'cancelled' WHERE state IN ('pending','approved')${verbs ? ` AND verb IN (${verbs.map(() => '?').join(',')})` : ''}`)
    .run(...(verbs ?? [])).changes;
}
export function signoffPendingCount(): number {
  return (open().prepare(`SELECT COUNT(*) AS n FROM concierge_signoff WHERE state = 'pending'`).get() as { n: number }).n;
}
/** Answered records older than the retention are deleted (the audit facts and concierge_log stay). */
export function signoffPrune(olderThan: number): number {
  return open().prepare(`DELETE FROM concierge_signoff WHERE state <> 'pending' AND COALESCE(answered_at, expires_at) < ?`).run(olderThan).changes;
}
