/**
 * Workbench engine — dev server (Milestones 0–3).
 *
 * Serves the web renderer, exposes the component registry as real data, and —
 * new at M1 — bridges a component's CLI to the browser over WebSocket so a pane
 * can run a live local shell (the first component, proving the lifecycle).
 *
 * The zero-component-boot guarantee (decision 8) still holds: components are
 * DISCOVERED by scanning src/components/ for manifests. Core never names one;
 * delete every manifest and the engine still boots and serves a Workbench. The
 * WS spawn path is driven entirely by the discovered descriptor (decision 3) —
 * there is no hardcoded vendor anywhere in this file.
 */
import { engineWrite, writes as ptyWrites } from '../engine/pty-write.ts';
import '../engine/local-mode-stdout.ts'; // MUST stay first: local mode sends logs to stderr so stdout carries only the ready line
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { neverWritten } from '../engine/restore-fresh.ts';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { worktreePath, repairWorktree } from '../engine/worktrees.ts';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep, resolve, relative, isAbsolute } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { killCli, type CliDescriptor } from '../engine/cli-host.ts';
import * as brokerClient from '../engine/broker-client.ts';
import { createWorkers, envConfig as workersEnv, WorkerError } from '../engine/workers.ts';
import * as sessions from '../engine/sessions.ts';
import { reapHoldReason } from '../engine/reap-guard.ts';
import {
  inheritArtTreatment, artColor, chooseArtColor, type ArtRow,
} from '../engine/art-treatment.ts';
import {
  loadTargets,
  buildLaunch,
  isSelfHosted,
  remoteFsAccess,
  fsOptsFor,
  hostOfTarget,
  engineNode,
  type Target,
} from '../engine/launch.ts';
import { desktop, setEngineOrigin } from '../engine/desktop-actions.ts';
import * as claudeCode from '../engine/vendors/claude-code.ts';
import { vendorFor, isResumableVendor } from '../engine/vendors/index.ts';
import { loadBrands, checkBrandsAtStartup } from '../engine/brands.ts';
import * as activity from '../engine/activity.ts';
import { createInputGuard } from '../engine/input-guard.ts';

const inputGuard = createInputGuard(); // a stuck key's flood is dropped, never an Esc [input-guard]
import * as titles from '../engine/session-titles.ts';
import { normalizeProjectDir, checkProjectDir } from '../engine/project-dir.ts';
import * as widgetStatus from '../engine/widget-status.ts';
import * as adopt from '../engine/session-adopt.ts';
import * as clearedDetect from '../engine/session-cleared.ts';
import * as telemetry from '../engine/telemetry.ts';
import * as presence from '../engine/presence.ts';
import * as userPresenceRoutes from './user-presence-routes.ts'; // USER DEVICE PRESENCE [room [ref]]
import * as userPresence from '../engine/user-presence.ts';
import * as fabric from '../engine/fabric.ts';
import * as fabricSub from '../engine/fabric-subscriber.ts';
import * as fabricCheckin from '../engine/fabric-checkin.ts';
import { routeSlug } from '../engine/slug-route.ts';
import * as fabricRelay from '../engine/fabric-relay.ts';
import * as roomFabric from '../engine/room-fabric.ts';
import * as fabricHeld from '../engine/fabric-held.ts';
import * as fabricRestore from './fabric-restore.ts';
import * as channels from '../engine/channels.ts';
import * as paneTokens from '../engine/pane-tokens.ts';
import { resolveSlug, normalizeSlug, projectBasename, reconcileTerminalSlugs } from '../engine/agent-slug.ts';
import * as tailnet from '../engine/tailnet.ts';
import { endStateFor } from '../engine/end-state.ts';
import { readBody, sendJson, sendJsonCached, errStatus } from './http-util.ts';
import * as auth from './auth.ts';
import { browserOriginRefused, hostHeaderAllowed, localModeConfig, localPort, readyLine, supervisorOrigins } from '../engine/local-mode.ts';
import { enginePort, setBoundPort } from '../engine/local-guard.ts';
import { seedStarter, SeedError } from '../engine/starter-seed.ts';
import { gitStatus } from '../engine/code-folder.ts';
import { sweepRetention as sweepTaskRetention, sweepTimeline as sweepTaskTimeline, mergeTimelineTick as tickTaskTimeline } from '../table/tasks-store.ts';
import { claimDataDir, releaseDataDir } from '../engine/local-data.ts';
import { SEED_MARKER_NAME, seedFirstRecipe } from '../engine/seed-recipe.ts';
import { COPY_INTERVAL_MS, NoteCopier, retireCopy, writeCopy } from '../engine/note-copies.ts';
import { ensureDirInsideRoot, notesDirOnDisk } from '../engine/local-file-store.ts';
import { createExporter, handleHistoryRoute } from './history-routes.ts';
import { EXIT_MEMORY_CAP, memoryCapConfig, memoryCapFact, startMemoryCap } from '../engine/memory-cap.ts';
import * as identity from '../identity/auth.ts';
import * as identityRoutes from '../identity/routes.ts';
import * as voiceRoutes from './voice-routes.ts';
import * as rooms from './rooms.ts';
import * as term from './term.ts';
import { allowedOrigins } from '../engine/term-grants.ts';
import { probeVendor } from '../engine/switch/vendor-ready.ts';
import * as switchHost from '../engine/switch/host.ts';
import { selfPair } from './self-viewer.ts';
import * as roomGuide from './room-guide.ts';
import * as agentCmds from '../engine/agent-commands.ts';
import * as chatterRoutes from './chatter.ts';
import * as conciergeRoutes from './concierge.ts';
import { humanCredential } from './person.ts';
import * as settingsRoutes from './settings-routes.ts';
import * as roomFiles from './room-files.ts';
import { checkOrigin } from './origin-guard.ts';
import { safeServeType } from './safe-serve.ts';
import { cspProblem, scopeScriptSrc } from './csp-floor.ts';
import { createHost } from './modules/host.ts';
import { createPlugins } from './modules/plugins.ts';
import * as setupRoutes from './setup-routes.ts';
import { trustFolder, claudeJsonPath, realTrustIo } from '../engine/folder-trust.ts';
import { isFolderTrusted, trustKey } from './settings-routes.ts';
import { sanitizeSvg } from '../engine/svg-sanitize.ts';
import { setDefaultReader, effectiveAutoApprove, autoApproveSource, isAutoApproveSetting, readState } from '../engine/auto-approve.ts';
import * as conciergeAct from '../engine/concierge-act.ts';
import * as concierge from '../engine/concierge.ts';
import type * as conciergeRelay from '../engine/concierge-relay.ts';
import * as chatter from '../engine/chatter.ts';
import { agentComms } from '../engine/agent-comms.ts';
import { resolveArt } from '../engine/room-art.ts';
import * as projects from './projects.ts';
import * as libraryProxy from './library-proxy.ts';
import * as roomScratch from '../engine/room-scratch.ts';
import * as notesIndex from '../engine/notes-index.ts';
import * as roomApps from '../engine/apps.ts';
import * as toolManager from '../engine/tool-manager.ts';
import { readiness } from './readiness.ts';
import * as spawnPermits from '../engine/spawn-permits.ts';
import { soloPathFor } from './solo-path.ts';
import * as roomBus from '../engine/room-bus.ts';
import * as voice from '../engine/voice.ts';
import * as roomVoice from '../engine/room-voice.ts';
import { pictureOwner, voiceOwnerKey } from './picture-owner.ts';
import * as roomTyper from '../engine/room-typer.ts';
import * as startupGate from '../engine/startup-gate.ts';
import * as geminiGate from '../engine/gemini-gate.ts';
import * as promptBlock from '../engine/prompt-block.ts';
import * as spawnGuard from '../engine/spawn-guard.ts';
import * as mcpCalls from '../engine/mcp-calls.ts';
import * as causes from '../engine/causes.ts';
import * as btMcp from './bt-mcp.ts';
import * as btLaunch from '../engine/bt-launch.ts';
import * as btTools from '../engine/bt-tools.ts';
import * as seatWelcome from '../engine/seat-welcome.ts';
import * as vscreen from '../engine/vscreen.ts';
import { isWindows } from '../engine/platform.ts';
import * as runtimeFlags from '../engine/runtime-flags.ts';
import * as procClassifier from '../engine/proc-classifier.ts';
import { table, RECIPE_VENDORS, isRecipeVendor } from '../table/endpoint.ts';
import { handleAgentHook } from '../engine/agent-hook.ts';
import * as agentChat from '../engine/agent-chat.ts';
import * as basicRoutes from './basic.ts';
import * as agentShare from '../engine/agent-share.ts';
import { Readable } from 'node:stream';
import { ensureHooksFile } from '../engine/codex-hooks.ts';
import { parseVendorArgs } from '../engine/vendor-args.ts';
import { parseVendorFlags } from '../engine/vendor-flags.ts';
import * as connectorBridge from '../engine/connector-bridge.ts';
import * as usageMeter from '../engine/usage-meter.ts';
import { startupReady } from '../engine/pane-ready.ts'; // vendor-aware 'past startup' for the seat-reload drive
import { resolveLaunchProfile, isModelName, isEffortFor, effortsFor } from '../engine/effort.ts';
import { backfillProfiles } from '../engine/profile-backfill.ts';
import { instancePath } from '../engine/data-dir.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'web');
const COMPONENTS_ROOT = join(REPO_ROOT, 'src', 'components');

/* LOCAL MODE (src/engine/local-mode.ts): the desktop app's child engine. Refuse to start on any problem; the supervisor sees the exit. */
const LOCAL = localModeConfig(process.env);
if (LOCAL.enabled && LOCAL.problems.length > 0) {
  console.error(`local mode cannot start: ${LOCAL.problems.join('; ')}`);
  process.exit(78);
}
let historyExporter = null as ReturnType<typeof createExporter> | null; // set in local mode below
let historyFilesRoot = '';
if (LOCAL.enabled) {
  /* the data folder: writable, and ours alone (a stale lock from a crashed engine is taken over) */
  const dataDirPath = process.env.HARBOR_WB_DATA_DIR as string;
  const claimed = claimDataDir(dataDirPath);
  if (!claimed.ok) {
    console.error(`local mode cannot start: ${claimed.problem}`);
    process.exit(78);
  }
  process.on('exit', () => releaseDataDir(dataDirPath));
  /* FIRST-RUN SEED (src/engine/seed-recipe.ts): one default recipe so a room works with no setup; a marker keeps a deleted one deleted. */
  try {
    const marker = join(dataDirPath, SEED_MARKER_NAME);
    const outcome = seedFirstRecipe({
      platform: process.platform,
      markerExists: () => existsSync(marker),
      writeMarker: () => writeFileSync(marker, `${new Date().toISOString()}\n`),
      recipeCount: () => table.listRecipes().length,
      upsert: (r) => {
        table.upsertRecipe(r as never);
      },
    });
    console.error(`[wb] first-run recipe: ${outcome}`);
  } catch (e) {
    console.error(`[wb] first-run recipe could not be seeded (${(e as Error).message}); rooms still work, add a recipe by hand`);
  }
  if (process.env.HARBOR_WB_EXIT_ON_STDIN_CLOSE === '1') {
    /* opt-in: the supervisor holds our stdin open; if it dies or closes it, stop cleanly instead of running on as an orphan */
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('close', () => process.exit(0));
    process.stdin.resume();
  }
  /* NOTE COPIES (option A, lead ruling 15686): the database rows stay the truth; each note is also written, at most once per interval, as a
     read-only .md into the person's folder (src/engine/note-copies.ts). Pending copies are written when the engine stops. */
  const filesRoot = process.env.HARBOR_WB_FILES_DIR as string;
  const copyMs = Number(process.env.HARBOR_WB_NOTE_COPY_MS);
  const copier = new NoteCopier({
    intervalMs: Number.isFinite(copyMs) && copyMs >= 100 ? copyMs : COPY_INTERVAL_MS,
    setTimer: (fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref();
      return h;
    },
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    read: (roomId, id) => table.getRoomNote(roomId, id),
    dir: (roomId) => {
      try {
        return notesDirOnDisk(filesRoot, table.roomAssetFolder(roomId));
      } catch {
        return null;
      }
    },
    // the same inside-the-root check as uploads: a room folder that is a link out of the files folder gets nothing created at its target
    write: (dir, id, text) => writeCopy(dir, id, text, (d) => ensureDirInsideRoot(filesRoot, d)),
    retire: (dir, id) => retireCopy(dir, id, (d) => ensureDirInsideRoot(filesRoot, d)),
    onError: (m) => console.error(`[wb] ${m}`),
  });
  table.setNoteObserver((e) => (e.kind === 'save' ? copier.saved(e.roomId, e.id) : copier.removed(e.roomId, e.id)));
  process.on('exit', () => copier.flush());
  /* CHAT-HISTORY EXPORT (step 7, engine half): finished days as one file per room per day in the person's folder; a catch-up shortly after
     start, then about hourly while the engine runs (src/engine/history-export.ts). Export now and the toggle are /api/history-export. */
  historyExporter = createExporter(filesRoot, table as never, (m) => console.error(`[wb] ${m}`));
  historyFilesRoot = filesRoot;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => process.exit(0)); // a clean stop releases the lock
  }
}
const PORT = LOCAL.enabled ? localPort(process.env) : Number(process.env.HARBOR_WB_PORT ?? 7420);
const HOST = LOCAL.enabled ? '127.0.0.1' : (process.env.HARBOR_WB_HOST ?? '127.0.0.1');
/** The port actually bound (differs from PORT when PORT is 0). */
/* HOSTED needs STRICT identity: the shared bearer must never stand for a person on a server other people can reach. (HARBOR_WB_HOSTED_ALLOW_NONSTRICT=1 is for the test engines only.) */
if (auth.hostedProfile() && identity.mode() !== 'strict' && process.env.HARBOR_WB_HOSTED_ALLOW_NONSTRICT !== '1') {
  console.error('hosted profile cannot start: set HARBOR_WB_IDENTITY=strict (the shared bearer must not act as a person on a hosted server)');
  process.exit(78);
}
/* HOSTED keeps room files OUTSIDE the engine's private data dir: under R7 the agents read the files root, so a root inside the data dir would let them read the engine's database and secrets.
   HARBOR_WB_FILES_DIR must be set, and neither inside the data dir nor above it. (The group/setgid share that lets the agents read it is the deployer's step.) */
if (auth.hostedProfile()) {
  const fd = (process.env.HARBOR_WB_FILES_DIR ?? '').trim();
  const dd = resolve(instancePath());
  const rel = (from: string, to: string): string => relative(from, to);
  const inside = (outer: string, inner: string): boolean => {
    const r = rel(outer, inner);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  if (!fd) {
    console.error('hosted profile cannot start: set HARBOR_WB_FILES_DIR to a folder for the rooms\' files, OUTSIDE the engine data dir (the agents read it; they must not reach the engine\'s database)');
    process.exit(78);
  }
  if (inside(dd, resolve(fd)) || inside(resolve(fd), dd)) {
    console.error(`hosted profile cannot start: HARBOR_WB_FILES_DIR (${resolve(fd)}) is inside, or contains, the engine data dir (${dd}); use a separate folder`);
    process.exit(78);
  }
}
let boundPort = PORT;
const EXTRA_ORIGINS = supervisorOrigins(process.env);
/** Origins a local-mode request may name: the supervisor's list, plus, for the two paths the app's windows call with their own origin
 *  (terminal grants and /term; docs/specs term-grants, default app://workbench), that engine allow-list and nothing more. */
/** Origins the H5 guard accepts besides the engine's own: local mode names the supervisor's list for the two app paths; a NON-hosted server engine also accepts the desktop app's own origin(s) (the term-grants list,
 *  default app://workbench) as a client, as it always did; a hosted engine accepts only what the deployer lists in HARBOR_WB_ALLOWED_ORIGINS. */
function guardOrigins(pathname: string): string[] {
  if (LOCAL.enabled) return originsFor(pathname);
  return auth.hostedProfile() ? [] : allowedOrigins();
}
function originsFor(pathname: string): string[] {
  return pathname === '/api/terminal-grants' || pathname === '/term' ? [...EXTRA_ORIGINS, ...allowedOrigins()] : EXTRA_ORIGINS;
}
/* WHICH NODE THIS ENGINE IS ON (contract §1 / Stage 2 presence).
 *
 * The default is 'homebase' because that is where the engine lives as of the Stage-1
 * cutover; a VRPC-hosted engine sets HARBOR_WB_NODE=vrpc. Deliberately an env
 * var and not a hostname lookup: the service registry node SLUG is not derivable
 * from `os.hostname()` (the server answers `homeserver`), and the contract says
 * resolve, don't guess. This is the one place a guess is allowed, and it is
 * one string in a service manifest. `engineNode()` (launch.ts) is the single
 * source for that default — `isSelfHosted`/`remoteFsAccess` read the same
 * function, so there is never a second `|| 'homebase'` to drift out of sync. */
const ENGINE_NODE = engineNode();

/** Close-kills-it grace (CLI Manager phase): a solo window's socket dropping
 *  kills its session after this many ms — long enough that a reload's
 *  drop-and-reattach survives, short enough that a closed window means dead.
 *  Env override exists for the test harness. */
const SOLO_GRACE_MS = Number(process.env.HARBOR_WB_SOLO_GRACE_MS ?? 5000);

/* CLOSE-KILL RETIRED (Owner lost 4 sessions, 2026-08-09 07:29).
 *
 * The 2026-07-07 rule was "solo window close = kill after a 5s reload grace",
 * written when every window was its OWN Edge process — one window dying was
 * unambiguously a user decision. Under the window-host shell ALL windows live
 * in ONE process: when it died, four sockets dropped inside 26ms and the
 * grace killed four healthy broker-held sessions. The broker never blinked;
 * the ENGINE killed them. A viewer disappearing is NOT consent to destroy a
 * session — and the user now has an explicit End button plus the ✕ dialog, so
 * killing needs no implicit path at all.
 *
 * New policy: an unexplained socket drop DETACHES ONLY. Sessions fall back to
 * the global idle reaper (12h, config.json) and show in the manager's live
 * strip as "parked — no window" where End is one click. Explicit `kill` still
 * kills; `park` still pins. Set HARBOR_WB_CLOSE_KILL=1 to restore the old
 * behavior (tests use it to prove the retired path still works). */
const CLOSE_KILL = process.env.HARBOR_WB_CLOSE_KILL === '1';

/* SPAWN PERMITS — the rule and its history live in ../engine/spawn-permits.ts
 * (moved there 2026-09-25 so a room seat can read `pending`). The launch path
 * (`launchRecipe`) is the only granter; the attach below is the only taker. */
const grantSpawnPermit = spawnPermits.grant;
const takeSpawnPermit = spawnPermits.take;

/** Dev-UI flag from config.json (repo root) — same file as `reapMs`. When true,
 *  windows show developer-only controls (currently the soft-reload button, which
 *  reloads the app UI without dropping the resident CLI). Flip it off in
 *  config.json when done working on the app; back on to troubleshoot. Read at
 *  boot, exposed on /health. Env `HARBOR_WB_DEBUG_UI=1` forces it on. */
function configDebugUi(): boolean {
  if (process.env.HARBOR_WB_DEBUG_UI === '1') {
    return true;
  }
  try {
    return JSON.parse(readFileSync(instancePath('config.json'), 'utf8')).debugUi === true;
  } catch {
    return false;
  }
}
const DEBUG_UI = configDebugUi();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

interface ComponentManifest {
  id: string;
  title: string;
  class: string;
  fn: string;
  descriptor: CliDescriptor;
}

/** Debug transparency (CLAUDE.md principle 8): every request/spawn is observable. */
function log(...args: unknown[]): void {
  console.log(`[wb ${new Date().toISOString()}]`, ...args);
}

/**
 * Discover installed components by reading src/components/<id>/manifest.json.
 * With the directory empty this returns [] and core still boots. Core reads IN;
 * it never reaches OUT to a named component (Contract B, decision 8).
 */
async function loadComponents(): Promise<ComponentManifest[]> {
  let entries;
  try {
    entries = await readdir(COMPONENTS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ComponentManifest[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    try {
      const raw = await readFile(join(COMPONENTS_ROOT, e.name, 'manifest.json'), 'utf8');
      out.push(JSON.parse(raw) as ComponentManifest);
    } catch {
      /* a dir without a valid manifest is not a component — skip it */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** application-facing view of a component — the descriptor stays server-side. */
function publicComponent(m: ComponentManifest) {
  return { id: m.id, title: m.title, class: m.class, fn: m.fn };
}

/* What `src/identity/routes.ts` borrows from this file. Passed in rather than
 * imported the other way so the identity module has no dependency on the
 * engine — contract §0 expects it to lift out into a service, and a module that
 * reaches back into a 2800-line request handler does not lift. */
const IDENTITY_DEPS: identityRoutes.Deps = {
  readBody,
  sendJson,
  log,
  legacyLoginCookie: auth.loginCookie,
  legacyAuthorized: auth.authorized,
  throttled: auth.throttled,
  recordFailure: auth.recordFailure,
  clearFailures: auth.clearFailures,
  safeNext: auth.safeNext,
  webRoot: WEB_ROOT,
  exchangeOrigins: () => allowedOrigins(),
};
identity.setLogger((msg) => log(msg));
paneTokens.setLogger((msg) => log(msg));

/** Resolve a URL path to a file under WEB_ROOT, refusing traversal escapes. */
/** The window host finds "a shell window" by literal substring match on
 *  `/app/shell.html` (DockController.cs ShellBase) — that is how TEAR-OFF
 *  decides where new shells come from. Our copy lives at /shell.html, so we
 *  ALSO answer on their path. One alias here removes a cross-repo change from
 *  the flip's critical path, and it is safe because every asset our shell
 *  references is root-absolute, so the serving path does not affect resolution. */
/* THE OLD /icons.* URLS KEEP WORKING. The page became "Art" (Owner, 2026-09-21:
   "this is no longer icons and no longer harbor... it's briefing table art"),
   and renaming a route otherwise breaks every bookmark, every shell tab
   restored from sessionStorage, and the `data-aux` link in a manager page a
   window is still running. An alias costs one line; a 404 costs trust. */
const PATH_ALIASES: Record<string, string> = {
  '/app/shell.html': '/shell.html',
  '/icons.html': '/art.html',
  '/icons.js': '/art.js',
  '/icons.css': '/art.css',
};

/* ---- versioned asset URLs (Owner 2026-09-01) --------------------------------
 * `no-store` was not enough. Three times tonight a front-end fix did not reach
 * his phone until he CLOSED the tab and relaunched from the manager — "i had to
 * relaunch and not just refresh" — because Edge-on-iOS can answer a soft reload
 * from its own parsed module graph regardless of what the header says.
 *
 * A cache cannot serve a URL it has never seen, so give changed files a changed
 * URL: `/solo.js?v=<newest mtime under web/>`. The stamp is shared by every
 * asset, so one edit anywhere busts the whole set — which is what we want, since
 * these files import each other and a half-updated pair is worse than a stale
 * one. Rewriting is deliberately narrow: HTML script/link attributes and ES
 * module specifiers only, never an arbitrary string that happens to look like a
 * path, so an API URL inside the JS cannot be mangled.
 *
 * resolveWebPath already strips the query, so the stamp costs nothing on the way
 * back in. */
const VERSIONED = /\.(?:js|mjs|css)$/;

let stampValue = '0';
let stampAt = 0;

async function webStamp(): Promise<string> {
  if (Date.now() - stampAt < 3000) {
    return stampValue;
  }
  let newest = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (VERSIONED.test(ent.name) || ent.name.endsWith('.html')) {
        const st = await stat(full).catch(() => null);
        if (st && st.mtimeMs > newest) {
          newest = st.mtimeMs;
        }
      }
    }
  };
  await walk(WEB_ROOT);
  stampValue = String(Math.round(newest));
  stampAt = Date.now();
  return stampValue;
}

function versionAssets(text: string, ext: string, v: string): string {
  if (ext === '.html') {
    return text.replace(
      /\b(src|href)="(\/[^"?#]+\.(?:js|mjs|css))"/g,
      (_m, attr: string, path: string) => `${attr}="${path}?v=${v}"`,
    );
  }
  /* ES module specifiers only — `from '/x.mjs'` and `import('/x.mjs')` — never
     an arbitrary string that happens to look like a path, so an API URL inside
     the JS cannot be mangled. */
  return text
    .replace(
      /(\bfrom\s*)(['"])(\/[^'"?#]+\.(?:js|mjs))\2/g,
      (_m, kw: string, q: string, path: string) => `${kw}${q}${path}?v=${v}${q}`,
    )
    .replace(
      /(\bimport\(\s*)(['"])(\/[^'"?#]+\.(?:js|mjs))\2/g,
      (_m, kw: string, q: string, path: string) => `${kw}${q}${path}?v=${v}${q}`,
    );
}

const APP_ROOT = resolve(process.env.HARBOR_WB_APP_DIR?.trim() || join(REPO_ROOT, 'web-app'));
/* The app's CSP: the manifest the app ships (<app dir>/csp.json, {"header": "..."}) is the single source; this default (connect-src 'self' covers same-origin sockets) is used when there is none. */
async function loopbackDispatch(call: { method: string; path: string; body: Record<string, unknown> | null }, cookie: string): Promise<{ status: number; text: string }> {
  const base = `http://127.0.0.1:${boundPort ?? enginePort()}`;
  const r = await fetch(base + call.path, {
    method: call.method,
    headers: { cookie, origin: base, ...(call.body ? { 'content-type': 'application/json' } : {}) },
    body: call.body ? JSON.stringify(call.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, text: await r.text() };
}
const pluginStore = createPlugins({ root: instancePath('plugins'), getSetting: (k) => table.getEngineSetting(k), setSetting: (k, v) => table.setEngineSetting(k, v) });
if (process.env.HARBOR_WB_PLUGINS === '1') pluginStore.sweep(); // clear a crashed install's leftovers
const moduleHost = createHost({
  appRoot: APP_ROOT,
  plugins: pluginStore,
  getSetting: (k) => table.getEngineSetting(k),
  setSetting: (k, v) => table.setEngineSetting(k, v),
  dispatch: (call, cookie) => loopbackDispatch(call, cookie),
});
const APP_CSP_DEFAULT = "default-src 'self'; script-src 'self'; frame-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";
let cspWarned = '';
function appCsp(req: IncomingMessage): string {
  const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase() === 'https' ? 'https' : 'http';
  const origin = host ? `${proto}://${host}` : null;
  try {
    const h = JSON.parse(readFileSync(join(APP_ROOT, 'csp.json'), 'utf8')).header;
    if (typeof h === 'string' && h.trim() && !/[\r\n]/.test(h)) {
      const why = cspProblem(h.trim());
      if (!why) return scopeScriptSrc(h.trim(), origin);
      if (cspWarned !== why) {
        cspWarned = why;
        log(`/app: the shipped csp.json header is refused (${why}); using the default`);
      }
    }
  } catch {
    /* none shipped */
  }
  return scopeScriptSrc(APP_CSP_DEFAULT, origin);
}
async function serveApp(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let root: string;
  try {
    root = await realpath(APP_ROOT);
  } catch {
    return false; // no app built here: fall through to the normal 404
  }
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.replace(/^\/app\/?/, ''));
  } catch {
    return false;
  }
  if (rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return false;
  const wantsFile = extname(rel) !== '';
  let file = join(root, rel || 'index.html');
  try {
    file = await realpath(file);
    if (file !== root && !file.startsWith(root + sep)) return false; // a symlink out of the app dir
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    if (wantsFile) return false;
    file = join(root, 'index.html'); // client route
  }
  try {
    const body = await readFile(file);
    const ext = extname(file);
    const html = ext === '.html';
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': html ? 'no-store, must-revalidate' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': appCsp(req),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

function resolveWebPath(urlPath: string): string | null {
  const raw = urlPath.split('?')[0];
  const clean = decodeURIComponent(PATH_ALIASES[raw] ?? raw);
  const rel = normalize(clean).replace(/^(\.\.[/\\])+/, '');
  const full = join(WEB_ROOT, rel === sep || rel === '' ? 'index.html' : rel);
  if (!full.startsWith(WEB_ROOT)) {
    return null;
  }
  return full;
}

/**
 * ONE-TIME BACKFILL: stamp a `key` into logo prefs saved before the key existed.
 *
 * The shell resolves a tab's mark by KEY and never receives markup, so a pref
 * written before the modal learned to record one can never produce a tab icon —
 * it would need the user to re-pick the same logo on every project just to
 * write a field they cannot see. The match is an EXACT string compare against
 * the library and the pinned presets, which is sound precisely because those
 * prefs were created BY picking from those lists: identical bytes, or it was a
 * one-off paste that legitimately has no key and stays session-only.
 *
 * Idempotent — only ever fills a missing key, never rewrites one — so it is
 * harmless on every subsequent boot.
 */
/* The watermark treatment's vocabulary, from the design system window-chrome v21
   (hwb-watermark.css: `.wm-line-*` and `.wm-at-*`). Written out here rather
   than imported because the renderer's copy lives in web/logo-modal.mjs, which
   is a browser module — and because this is the VALIDATING copy: the engine
   must be able to refuse a value without a page telling it which are real.
   If the design system adds a style, both copies move together or the new one is stored
   and silently rendered as nothing. */
const WM_LINES = ['none', 'outline', 'blueprint', 'hatch', 'engrave', 'halftone'];
const WM_WASH_FROM = ['ul', 'ur', 'll', 'lr', 'c', 'll-mid'];

/**
 * The identity of a piece of art, if we have seen it before: `lib:<id>` for a
 * library set, or the bare preset name for one of the design system.
 */
function logoKeyFor(svg: string): string | null {
  let pinned: Record<string, string> = {};
  try {
    const m = /\{[\s\S]*\}/.exec(readFileSync(join(WEB_ROOT, 'vendor', 'aurora-logo-presets.js'), 'utf8'));
    if (m) {
      pinned = JSON.parse(m[0]);
    }
  } catch {
    /* pinned file unreadable — library matches alone are still worth doing */
  }
  const lib = (table.listLogos() as any[]).find((l) => l.svg === svg);
  if (lib) {
    return `lib:${lib.id}`;
  }
  return Object.keys(pinned).find((k) => pinned[k] === svg) ?? null;
}

/**
 * STAMP A KEY ON THE WAY IN. Applied at every point a logo pref is written, so
 * no route can store art whose identity we know without recording it.
 *
 * This exists because one did. The modal only writes a key when it can read one
 * off its picker, and re-opening an existing logo does not restore which
 * library entry the art came from — so editing a set and saving dropped the key
 * silently. The art stayed correct and the tab fell back to a HASH-ASSIGNED
 * stock preset, which is why it looked hardcoded: Owner's the design system Styleguide
 * recipe held the right 2.9 KB of art with `key: null` and rendered as
 * "styleguide" because that is where the hash landed.
 *
 * Boot backfill alone was not enough: it only runs at startup, so anything
 * saved afterwards stayed keyless until the next restart.
 */
function stampLogoKey(raw: string | null | undefined): string | null | undefined {
  if (typeof raw !== 'string' || !raw) {
    return raw;
  }
  try {
    const o = JSON.parse(raw);
    if (!o?.svg || o.key) {
      return raw; // nothing to identify, or already identified
    }
    const key = logoKeyFor(o.svg);
    return key ? JSON.stringify({ ...o, key }) : raw;
  } catch {
    return raw; // not our JSON — pass it through untouched
  }
}

/**
 * The slug `deriveSlug` used to produce before 2026-09-17 (`<basename>-cli`,
 * falling back to `<name>-cli`), reconstructed here ONLY as a fingerprint for
 * the boot backfill below — never used to derive anything new. It exists so
 * the backfill can recognise "this recipe's stored slug is the machine's own
 * old default" and reconcile it to the new bare-basename default, without
 * ever touching a slug a human typed by hand (see `backfillRecipeAgents`'s own
 * comment for why an exact match is the whole safety property).
 */
function oldDerivedSlugForm(r: { projectDir?: string | null; name?: string | null }): string | null {
  const base = r.projectDir ? projectBasename(r.projectDir) : null;
  const stem = normalizeSlug(base) ?? normalizeSlug(r.name ?? null);
  if (!stem) {
    return null;
  }
  return stem.endsWith('-cli') ? stem : normalizeSlug(`${stem}-cli`);
}

/**
 * SEED EACH ART'S COLOR FROM THE RECIPES ALREADY WEARING IT.
 *
 * Art-wins shipped with no art stating a color, which would have opened the
 * Icons page on a neutral swatch and asked Owner to pick every project's
 * identity again from memory ("they're all white and i'd have to re-choose
 * colors"). The colors were never lost — they are on the recipes — so this
 * moves them once, to the place that now owns them.
 *
 * IDEMPOTENT, and only ever FILLS: art that already states a color is left
 * alone, so a deliberate choice made here can never be undone by a later boot
 * reading a stale recipe row. Same shape as backfillLogoKeys and
 * normalizeStoredProjectDirs, for the same reason.
 */
function backfillArtColors(): void {
  const logos = table.listLogos() as any[];
  const recipes = table.listRecipes() as any[];
  let filled = 0;
  for (const art of logos) {
    let style: Record<string, unknown> = {};
    if (art.style) {
      try {
        style = JSON.parse(art.style);
      } catch {
        continue; // unparseable: leave it exactly as found rather than rewrite it
      }
    }
    if (typeof style.color === 'string') {
      continue; // already stated — never overwrite a deliberate choice
    }
    const wearers = recipes.filter((r) => {
      if (!r.logo) {
        return false;
      }
      try {
        return JSON.parse(r.logo)?.key === `lib:${art.id}`;
      } catch {
        return false;
      }
    });
    const color = chooseArtColor(wearers);
    if (!color) {
      continue; // nothing wears it, or nothing it wears has a usable color
    }
    table.setLogoStyle(art.id, JSON.stringify({ ...style, color }));
    filled += 1;
    log(`art color seeded: "${art.name}" -> ${color} (from ${wearers.length} recipe${wearers.length === 1 ? '' : 's'})`);
  }
  if (filled) {
    log(`art colors: seeded ${filled} from existing recipes`);
  }
}

function backfillLogoKeys(): void {
  const keyFor = logoKeyFor;

  let stamped = 0;
  let unmatched = 0;
  const stamp = (raw: string | null | undefined): string | null => {
    if (!raw) {
      return null;
    }
    let o: any;
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!o?.svg || o.key) {
      return null;
    }
    const key = keyFor(o.svg);
    if (!key) {
      unmatched++;
      return null;
    }
    stamped++;
    return JSON.stringify({ ...o, key });
  };

  for (const r of table.listRecipes() as any[]) {
    const next = stamp(r.logo);
    if (next) {
      table.upsertRecipe({ ...r, logo: next });
    }
  }
  for (const s of table.list() as any[]) {
    const next = stamp(s.logo);
    if (next) {
      table.setPrefs(s.paneid, { logo: next });
    }
  }
  if (stamped || unmatched) {
    log(`logo keys: stamped ${stamped}, ${unmatched} one-off paste(s) left session-only`);
  }
}

/* ---- logo preset superset (see the route below) ------------------------- */
let presetCache: { sig: string; body: string } | null = null;

/**
 * the design system pinned presets + everything in the logo library, keyed and
 * normalised, as one ESM module.
 *
 * KEYS ARE STABLE IDS, NOT NAMES: a library entry is `lib:<id>`, so renaming a
 * set is a label change and never orphans the panes wearing it. the design system own
 * keys stay bare (`harbor`, `music`, …) — they are the pin's vocabulary and the
 * shell's bundled fallback already speaks it.
 */
async function buildLogoPresetModule(): Promise<string> {
  const logos = table.listLogos();
  /* Signature over id+length: cheap, and changes on every add, delete or
     replace. Not a hash of the art — that would cost more than the work saved. */
  const sig = logos.map((l: any) => `${l.id}:${l.svg.length}`).join(',');
  if (presetCache?.sig === sig) {
    return presetCache.body;
  }
  const lab = await import('../engine/icon-lab.ts');
  const pinned = readFileSync(join(WEB_ROOT, 'vendor', 'aurora-logo-presets.js'), 'utf8');
  const out: Record<string, string> = {};
  const m = /\{[\s\S]*\}/.exec(pinned);
  if (m) {
    try {
      Object.assign(out, JSON.parse(m[0]));
    } catch {
      /* pinned file unreadable — the library alone is still better than nothing */
    }
  }
  for (const l of logos as any[]) {
    try {
      out[`lib:${l.id}`] = lab.normalizeForConsumers(l.svg);
    } catch {
      /* one bad entry must not empty the whole module */
    }
  }
  const body =
    '/* COMPOSED AT REQUEST TIME by the engine — the built-in presets plus the\n' +
    ' * user logo library, normalised (viewBox synthesised, fills -> currentColor).\n' +
    ' * This is NOT web/vendor/aurora-logo-presets.js: that file is the Contract-A\n' +
    ' * pin and is never modified. Library keys are `lib:<id>` — stable ids, so a\n' +
    ' * rename never orphans a pane. */\n' +
    `export const LOGO_PRESETS = ${JSON.stringify(out)};\n`;
  presetCache = { sig, body };
  return body;
}

/* ---- a logo pref without its SVG [perf/poll-traffic] ---------------------
 * `logo` is a JSON string {key?, svg, scale, mono, opacity, line?, ...}. The
 * slim form drops `svg` and keeps every other field (the manager reads the
 * treatment from it); `key` is the logo key or null (a one-off paste has
 * none). Memoised on the raw string: /api/table runs it for every row on every
 * poll, and a row's pref changes only on an edit. Unparseable = unchanged. */
const slimLogoMemo = new Map<string, { logo: string | null; key: string | null }>();
function slimLogo(raw: unknown): { logo: string | null; key: string | null } {
  if (typeof raw !== 'string' || !raw) {
    return { logo: (raw as string | null) ?? null, key: null };
  }
  const hit = slimLogoMemo.get(raw);
  if (hit) {
    return hit;
  }
  let out: { logo: string | null; key: string | null };
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const { svg: _svg, ...rest } = o as Record<string, unknown>;
      out = { logo: JSON.stringify(rest), key: typeof o.key === 'string' && o.key ? o.key : null };
    } else {
      out = { logo: raw, key: null };
    }
  } catch {
    out = { logo: raw, key: null };
  }
  if (slimLogoMemo.size > 1000) {
    slimLogoMemo.clear(); // bounded: stale prefs fall out on the next pass
  }
  slimLogoMemo.set(raw, out);
  return out;
}

/* ---- the per-row projection of the mapping table (workrooms T3, [ticket]) --
 * `/api/table` and the rooms routes both show a session row, and they must show
 * it IDENTICALLY — a second copy of this decoration is how a seat and the
 * manager would come to disagree about whether a session is live. Extracted
 * verbatim from the inline /api/table projection (pure refactor: /api/table's
 * JSON is byte-identical before and after). The context is read ONCE per
 * request, never per row: /api/table runs it on every manager poll. */
interface RowProjection {
  linkStatus: ReturnType<typeof brokerClient.statuses>;
  componentIds: Set<string>;
  artRows: () => ArtRow[];
}

async function projectionContext(): Promise<RowProjection> {
  const linkStatus = brokerClient.statuses();
  const componentIds = new Set((await loadComponents()).map((c) => c.id));
  /* Read ONCE for the whole projection, not per row: this runs on every
     manager poll and the library is the same list for all of them. */
  const artList = table.listLogos() as ArtRow[];
  return { linkStatus, componentIds, artRows: () => artList };
}

function cliPromptFields(paneid: string): { cliPrompt: string | null; cliPromptReason: string | null; cliPromptLink?: true } {
  const c = vscreen.cliPromptOf(paneid);
  /* the sign-in link itself is NEVER a table field (the table is polled by every page); this says whether GET /api/panes/:paneid/sign-in-link has one */
  return c ? { cliPrompt: c.prompt, cliPromptReason: c.reason, ...(vscreen.signInLinkOf(paneid) ? { cliPromptLink: true as const } : {}) } : { cliPrompt: 'unknown', cliPromptReason: 'no-screen' };
}

function projectRow(r: any, ctx: RowProjection): any {
  const { linkStatus, componentIds, artRows } = ctx;
  // A live row whose broker HOST is unreachable is 'disconnected' — the
  // session very likely still runs there (unreachable ≠ dead, vk [ref]);
  // it re-adopts when the host returns.
  const hostDown =
    r.state === 'live' && (linkStatus[brokerHostOfServer(r.server)] ?? 'down') !== 'up';
  return {
    ...r,
    /* ART WINS: a live row tints from the artwork's color, so a project's
       sessions read as one project however their recipes were saved. */
    color: artColor(r.logo, artRows) ?? r.color,
    /* THE BRAND JOIN KEY, UNCONDITIONALLY (§9). `vendor` is NOT NULL in the
       schema but a failed spawn has been seen writing '' (2026-08-24), and
       a surface joining on it needs a value it can look up, not a blank.
       `unknown` resolves to the `generic` mark. */
    vendor: r.vendor || 'unknown',
    /* ENDED VERDICT (v21): only when the process ended on its own and its
       code is known; absent otherwise (live, killed by us, or pre-column). */
    ...(r.state !== 'live' && typeof r.exit_code === 'number'
      ? { exit: r.exit_code === 0 ? 'ok' : 'fail' }
      : {}),
    activity:
      activity.get(r.paneid) ??
      (r.state === 'dehydrated' || hostDown ? 'disconnected' : null),
    /* [ticket] NEEDS YOU, with why: the screen shows a prompt only a human
       answers (login / permission / question). Absent when not blocked, so
       an unblocked row's JSON is unchanged. */
    ...(activity.blockedOf(r.paneid) ? { blocked: activity.blockedOf(r.paneid) } : {}),
    /* A FIRST-RUN CLI PROMPT (the design notes): live rows only. cliPrompt is a name (theme|login|apiKey|security|trust|mcp),
       'unknown' or null (= startup has cleared this launch). A reason always accompanies 'unknown': starting/no-screen/not-synced mean "cannot
       tell yet" and are NOT a claim that a prompt is up; only 'unmatched' says an unknown dialog has held the screen past the deadline. */
    ...(r.state === 'live' ? cliPromptFields(r.paneid) : {}),
    // attached = a window/viewer socket is currently bound; live+!attached =
    // PARKED (alive in the broker, no window) — the manager's live strip
    // uses this to label ghosts (M9 stopgap, 2026-08-08).
    // "attached" = SOMEONE is watching (any viewer), not "someone holds
    // the keyboard" — the manager's live strip is asking whether a window
    // is showing this session, which a read-only viewer also satisfies.
    attached: (sessions.get(r.paneid)?.viewers.size ?? 0) > 0,
    /* WINDOWS = viewers that are real windows / tabs (a solo page, a CLI
       Manager tab, a native window's page), i.e. every viewer except a room
       page's own framed view of a seat. The seat menu's Close window reads it:
       the room Owner is looking at is not "a window" to close. */
    windows: windowSockets(sessions.get(r.paneid)).length,
    /* FRAMES = viewers that are a room page's own framed view of the seat
       (any device). The seat menu's Close window is enabled by windows OR
       frames (Owner 2026-10-03, room line after [ref]). */
    frames: frameSockets(sessions.get(r.paneid)).length,
    controller: sessions.get(r.paneid)?.controllerLabel ?? null,
    /* WHAT this session is, not which project it lives in. The manager
       listed every row by its PROJECT name, so a project with several
       sessions showed the same label N times and "Open window" was a guess
       about which conversation you would land in. Served from cache and
       refreshed in the background below — never inline, because this route
       is polled every 2.5s and resolving a remote title is an ssh call. */
    title: titles.known(r.recipe_id, r.session_id),
    /* [ticket] the model/effort the session LAST answered with, read from its
       transcript tail on the title clock (live sessions: ~every 40s). */
    model: titles.modelOf(r.recipe_id, r.session_id)?.model ?? null,
    effort: titles.modelOf(r.recipe_id, r.session_id)?.effort ?? null,
    /* The agent's stored profile (what its NEXT launch runs on); null = none yet. */
    profile: table.profileOf(r),
    /* ms the engine saw this live pane /clear'ed in its CLI (a reconnect would resume the
       conversation from BEFORE it); null otherwise (Owner 2026-10-03, Alpha-runtime room). */
    cleared_at: r.cleared_at ?? null,
    /* A line the TOOL wrote about itself, rendered verbatim beside the
       state. The engine never interprets the text — see widget-status.ts. */
    widget: widgetFor(r.recipe_id),
    /* WHAT KIND OF THING IS THIS PANE — stated, not left to be inferred.
     *
     * Owner could not tell whether an unnamed pane was "originating on web,
     * subagents from agents, subprocesses from agents". The engine has
     * always known the answer and never said it, so every row looked alike:
     *
     *   project   — launched from a saved project (has a recipe_id)
     *   component — a pane of the workbench prototype at /index.html, which
     *               auto-attaches every component in src/components/
     *   adopted   — a PTY the broker was holding that no project claims;
     *               survives an engine restart with nothing to attribute it
     *               to (a project deleted while its session ran)
     *
     * Worth stating because it is the question underneath: a SUBAGENT never
     * appears here at all. Subagents run inside a claude process and leave
     * transcripts under `subagents/`; they never hold a PTY, so they can
     * never be one of these rows. Neither can a tool call. Everything in
     * this table is a terminal someone or something asked the engine for. */
    kind: r.recipe_id
      ? 'project'
      : componentIds.has(r.vendor)
        ? 'component'
        : 'adopted',
  };
}

/**
 * F1 (interim, until check-in ships) — the engine's own live row named by a
 * `POST /api/fabric/send` caller's `from`. NEVER a caller-supplied string:
 * `from` is `{paneid}` or `{session_id}`, resolved through the table exactly
 * as `rooms.ts`'s `authorFor`/`fromRow` do for a room line, and the row must
 * be LIVE and carry a non-empty `agent` slug — the fabric's join key (§1) — or
 * there is nothing honest to stamp `envelope.from` with.
 */
function resolveFabricSender(from: unknown): { ok: true; row: any } | { ok: false; reason: string } {
  if (!from || typeof from !== 'object' || Array.isArray(from)) {
    return { ok: false, reason: 'from is {paneid} or {session_id}' };
  }
  const f = from as Record<string, unknown>;
  let row: any | undefined;
  if (typeof f.paneid === 'string' && f.paneid) {
    row = table.get(f.paneid);
    if (!row) {
      return { ok: false, reason: 'no session in that pane' };
    }
  } else if (typeof f.session_id === 'string' && f.session_id) {
    row = table.list().find((r: any) => r.session_id === f.session_id && r.state === 'live');
    if (!row) {
      return { ok: false, reason: 'no live session with that session_id' };
    }
  } else {
    return { ok: false, reason: 'from is {paneid} or {session_id}' };
  }
  if (row.state !== 'live') {
    return { ok: false, reason: 'session is not live' };
  }
  if (!row.agent) {
    return { ok: false, reason: 'session has no agent slug' };
  }
  return { ok: true, row };
}

/** The send half of `POST /api/fabric/send`, once `row` (the sender) is
 *  decided: by `from` on the bearer door, by the token on the pane-token door
 *  (briefing-table-mcp §4.1). Answers every outcome; the caller catches. */
async function fabricSendAs(res: ServerResponse, row: any, b: any): Promise<void> {
  const logLine = (result: string) =>
    log(`fabric send ${row.paneid} ${row.agent} → ${String(b.to)} (${String(b.kind)}): ${result}`);
  const { enabled: fabricEnabled } = fabricSub.endpoint();
  if (!fabricEnabled) {
    logLine('disabled');
    sendJson(res, 503, { error: 'fabric-disabled' });
    return;
  }
  /* QUIET [chatter]: the person holds this agent, so an agent's DM to it is
     refused here, where the sender hears why. authorised_by: user does NOT pass:
     a sender can claim it (the lead's own relays carry it), so it would make the
     switch a suggestion. Only the person reaches a quiet agent. */
  const to = normalizeSlug(b.to);
  if (to) {
    const pane = fabricLivePaneFor(to);
    const quiet = quietSlugFor(to, pane);
    if (quiet) {
      noteChatter('quiet_refused', pane, quiet, row.agent, null);
      logLine(`refused: ${quiet} is quiet`);
      sendJson(res, 403, { ok: false, error: 'recipient_quiet', field: 'to', message: chatter.quietMessage(quiet) });
      return;
    }
  }
  /* DM BUDGET + REPEAT [chatter p2] (Owner 2026-10-06: one agent took 46 DMs in a day,
     14 in one hour, and senders re-sent near-identical ones). Every DM is a paid turn
     for its recipient, so the send door holds a sender to HARBOR_WB_DM_BUDGET_PER_HOUR
     (default 6) DMs per recipient per rolling hour, and refuses a body that repeats
     one it sent that recipient within the hour. Only the person is exempt; a reply
     the recipient asked for still counts (a sender can claim that, as with quiet). */
  const body = typeof b.body === 'string' ? b.body : '';
  const now = Date.now();
  /* [agent comms] per rule: 'off' not evaluated; 'watch' recorded as watch_<kind> and the DM
     goes out; 'enforce' refuses. The budget is the setting's dmPerHour. */
  const comms = agentComms();
  let woke = false;
  if (to && row.agent !== 'user') {
    const limit = comms.dmPerHour;
    const n = comms.dmBudget === 'off' ? 0 : table.countChatterEvents('dm_sent', row.agent, to, now - DM_WINDOW_MS);
    if (comms.dmBudget !== 'off' && n >= limit) {
      if (comms.dmBudget === 'watch') {
        noteChatter('watch_dm_budget', fabricLivePaneFor(to), to, row.agent, null);
        logLine(`watch: over the dm budget (${n}/${limit} this hour), sent anyway`);
      } else {
        noteChatter('dm_budget', fabricLivePaneFor(to), to, row.agent, null);
        logLine(`refused: dm budget (${n}/${limit} this hour)`);
        sendJson(res, 429, { ok: false, error: 'dm_budget', field: 'to', message: `${n} messages to ${to} this hour (limit ${limit}); combine what is left into one message later` });
        return;
      }
    }
    const again = comms.dmRepeat === 'off' ? null : chatter.repeatOf(body, recentDms(row.agent, to, now));
    if (again && comms.dmRepeat === 'watch') {
      noteChatter('watch_dm_repeat', fabricLivePaneFor(to), to, row.agent, again.id);
      logLine(`watch: repeats ${again.id ?? 'an earlier message'}, sent anyway`);
    } else if (again) {
      noteChatter('dm_repeat', fabricLivePaneFor(to), to, row.agent, again.id);
      logLine(`refused: repeats ${again.id ?? 'an earlier message'}`);
      sendJson(res, 409, {
        ok: false,
        error: 'dm_repeat',
        field: 'body',
        message: `repeats your message ${again.id ?? '(no id)'} of ${new Date(again.ts).toISOString()}`,
      });
      return;
    }
  }
  /* AGENT REST, level 1 [agent rest]: a DM to an agent the engine PARKED for being idle
     wakes it first (the restore route's own path: headless launch, wait for the REPL),
     so the sender never has to pass delivery:'restore'. A wake that fails is logged and
     the send goes on as before (the fabric answers not-live). */
  if (to) {
    woke = await rooms.wakeRestedForDm(to, (slug) => fabricRestore.restore(slug, null, fabricRestoreDeps()), logLine);
    if (woke) {
      fabricSub.refresh();
    }
  }
  /* The other listed fields, VERBATIM, undefined omitted — the fabric
     mints id/ts/ack/attention (contract §2: "assigned by the router, not
     the sender"), so this is not fabric.validate's inbound-envelope shape. */
  const envelopeOut: Record<string, unknown> = { from: row.agent };
  for (const f of ['to', 'kind', 'class', 'consequence', 'deadline', 'thread', 'body', 'ref', 'ttl', 'authorised_by']) {
    if (b[f] !== undefined) {
      envelopeOut[f] = b[f];
    }
  }
  /* CHECK-IN (contract §1.3): with the pane's checked-in instance the
     request carries `X-Fabric-Instance` and the FABRIC stamps `from` from
     the work slug it handed back — `envelopeOut.from` is then ignored
     there. Without one (not checked in yet, refused, fabric could not
     tell) the engine's stamp above stands, exactly as F1 shipped, and the
     log line says which path was taken. */
  let sent: fabricCheckin.SendResult;
  try {
    sent = await fabricCheckin.sendAs(row.paneid, envelopeOut);
  } catch {
    logLine('unreachable');
    sendJson(res, 502, { error: 'fabric-unreachable' });
    return;
  }
  /* [agent rest] just woken, and the fabric has not seen it live yet: leave it in its
     mailbox (hold), replayed the moment the pane subscribes */
  if (woke && sent.status === 409 && envelopeOut.delivery === undefined) {
    logLine('409 right after a wake: resent as hold');
    try {
      sent = await fabricCheckin.sendAs(row.paneid, { ...envelopeOut, delivery: 'hold' });
    } catch {
      logLine('unreachable');
      sendJson(res, 502, { error: 'fabric-unreachable' });
      return;
    }
  }
  logLine(sent.via === 'instance' ? String(sent.status) : `${sent.status} (no instance: stamped-from fallback)`);
  if (to && sent.status >= 200 && sent.status < 300) {
    const id = typeof (sent.body as any)?.id === 'string' ? (sent.body as any).id : null;
    noteChatter('dm_sent', fabricLivePaneFor(to), to, row.agent, id);
    rememberDm(row.agent, to, { ts: now, id, body });
    /* [steer] the pane now waits on an answer: the first envelope back on this thread (or on
       the ask's own id) is a control line for a queueing CLI (room-typer noteOwnAsk). */
    if (b.kind === 'ask') {
      const sentThread = (sent.body as any)?.thread;
      roomTyper.noteOwnAsk(row.paneid, [typeof b.thread === 'string' ? b.thread : null, id, typeof sentThread === 'string' ? sentThread : null]);
    }
  }
  sendJson(res, sent.status, sent.body);
}

/**
 * POST /api/recipes/:id/launch, as a function (2026-09-25, roster verbs
 * [ticket]): the route and a room seat's POST .../seats/:id/start are the SAME
 * launch, never a copy. `body` is the request body as read (null when it was
 * absent or unreadable = a plain launch, exactly as before the extraction).
 * `onPane` runs once the pane is decided and its spawn permit minted, and
 * before placement; a throw there aborts the launch with nothing opened.
 * Every outcome is a 200 answer {ok, paneid, url, path, placement}.
 */
/** A launch guard 7 refused before anything was stamped (409). */
class LaunchRefused extends Error {
  readonly status = 409;
  constructor(readonly collision: spawnGuard.Refusal) {
    super(collision.message);
  }
}
const NO_FOLDER_SENTENCE = 'This agent has no folder yet. Add it again with a folder.';
/** A launch body the engine will not guess about (400): an unknown effort. */
class LaunchBadRequest extends Error {
  readonly status = 400;
  constructor(message: string, readonly field: string) {
    super(message);
  }
}

async function launchRecipe(
  id: string,
  recipe: NonNullable<ReturnType<typeof table.getRecipe>>,
  body: unknown,
  onPane?: (paneid: string) => void,
  /** the identity account of the PERSON who asked (a session/device principal); absent for a bearer, a service or the engine: see OpenRequest.byUserId */
  byUserId?: string,
): Promise<{ ok: true; paneid: string; url: string; path: string; placement: string }> {
  // Optional body:
  //   {resume:true}            — reopen the pane's LAST recorded session
  //   {resumeSessionId:"<id>"} — reopen a SPECIFIC session (resume picker)
  //   {model:"opus"}           — per-launch model override (never mutates
  //                              the saved recipe). Beats the recipe's model
  //                              for THIS launch, fresh or resume, the way
  //                              the recipe's own model rides every path.
  //   {effort:"high"}          — per-launch `--effort` override, same rules;
  //                              an unknown level is a 400, never ignored.
  //   {target:"tab"}           — the caller is an EMBEDDED CLI Manager
  //                              asking to place this session as a tab in
  //                              its own window instead of a new OS window.
  //                              It is a REQUEST, not an instruction: the
  //                              engine still owns one-window-per-pty and
  //                              answers with `placement`.
  // Resume works by stamping the row dehydrated; the normal attach path
  // (locate-refresh + --resume) does the rest. Corrupted is never touched.
  /* HOSTED: an agent with no folder would start in whatever directory the broker happens to hold, which nobody chose (and trust is per real path). Refused here, before a pane or a permit exists. */
  if (process.env.HARBOR_WB_HOSTED === '1' && !(recipe.projectDir ?? '').trim()) {
    throw new LaunchBadRequest(NO_FOLDER_SENTENCE, 'projectDir');
  }
  let modelOverride: string | null = null;
  /* Checked BEFORE the lenient parse below: a typo in an effort is a caller's
     mistake to be told about, not a plain launch to fall back to. */
  const rawEffort = body && typeof body === 'object' ? (body as Record<string, unknown>).effort : undefined;
  if (rawEffort !== undefined && rawEffort !== null && rawEffort !== '' && !isEffortFor(recipe.vendor, rawEffort)) {
    throw new LaunchBadRequest(`unknown effort: ${JSON.stringify(rawEffort)} (one of ${effortsFor(recipe.vendor).join(', ')})`, 'effort');
  }
  const effortOverride: string | null = isEffortFor(recipe.vendor, rawEffort) ? rawEffort : null;
  let wantsTab = false;
  let wantsBrowserTab = false;
  /* `fresh:true` = "another session in this project", not "reopen the one
     it has". Without it a project is capped at a single session, because
     the paneid IS the project id — which is the dead end Owner hit: a
     severed project offered Restore and no way to start new work. */
  let wantsFresh = false;
  /* WHICH session of this project? A project can hold several panes (the
     `#suffix` handles), and the caller is the only one who knows which row
     its button belongs to. Without this every row of a multi-session
     project resolved to the project's FIRST pane, so "Open window" opened
     the same conversation whichever one you clicked — two live Briefing
     Table sessions, one reachable (Owner, 2026-09-02). */
  let explicitPane: string | null = null;
  /* The pane a picker resume RESOLVED to (see the resumeSessionId block):
     the transcript's own pane, or a freshly minted one when the primary is
     busy. Null when it is the primary, so that url keeps its historical
     form. */
  let pickerPane: string | null = null;
  /* S0 guard 7 EARLY (§4.4 item 7): a restore its attach would refuse is
     refused HERE, before any row is stamped or a window opened, so the
     manager shows the refusal in place (spawn-guard.early: no wait). */
  let refused: spawnGuard.Refusal | null = null;
  const earlyRefusal = (pane: string, sid: string): spawnGuard.Refusal | null => {
    const t = loadTargets().find((tt) => tt.id === recipe.target);
    return spawnGuard.early({ paneid: pane, ids: [sid], local: !!t && channels.ptyRunsHere(t) }, spawnGuardDeps);
  };
  try {
    const b = body as any; // null/non-object throws on the first read = plain launch, as before
    wantsTab = b.target === 'tab';
    /* `fresh` and the resume flags are mutually exclusive by definition — a
       new session is not a reopening of an old one. Honouring both would
       stamp the project's PRIMARY pane dehydrated and then open a DIFFERENT
       pane, leaving a restore promise nothing ever collects. */
    wantsFresh = b.fresh === true && b.resume !== true && !b.resumeSessionId;
    wantsBrowserTab = wantsTab && b.surface === 'browser';
    /* Validated against the TABLE, and against this recipe's own prefix, so
       a caller can neither invent a pane nor reach one belonging to another
       project. `fresh` and `pane` are mutually exclusive by definition — a
       new session is not one of the existing ones. */
    if (
      !wantsFresh &&
      typeof b.pane === 'string' &&
      b.pane.startsWith(`recipe:${id}#`) &&
      table.get(b.pane)
    ) {
      explicitPane = b.pane;
    }
    const paneid = explicitPane ?? `recipe:${id}`;
    const row = wantsFresh ? undefined : table.get(paneid);
    if (typeof b.model === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(b.model)) {
      modelOverride = b.model;
    }
    if (
      typeof b.resumeSessionId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.resumeSessionId)
    ) {
      /* WHICH PANE GETS THE PICKED SESSION. The picker names a TRANSCRIPT,
         not a pane, and this path used to answer "the project's primary
         pane" unconditionally — the 2026-09-02 bug ("every row of a
         multi-session project resolved to the project's FIRST pane") in
         the one door that fix did not reach. With the primary LIVE it did
         not even stop there: the upsert wrote the picked uuid and
         `dehydrated` OVER the live row, so the table then claimed the
         running pty was a different conversation, and the launch focused
         that window — "it grabs the active one" (Owner, 2026-09-18).
         Rules, in order:
           1. a pane of this project already banks the picked uuid —
              that IS the session's pane: live → open it (nothing is
              written); restorable → stamp it. Never mint a second pane
              for one transcript, or `--resume` runs twice on one file;
           2. the pane the caller named, or the primary, if it is NOT
              live — the historical behaviour;
           3. otherwise the primary is busy, so mint a fresh handle
              exactly as `fresh:true` does. A picker resume never writes
              over a live row. */
      const picked = b.resumeSessionId;
      const holder = table.sessionsForRecipe(id).find((x) => x.session_id === picked);
      const t = loadTargets().find((tt) => tt.id === recipe.target);
      if (holder && holder.state === 'live') {
        pickerPane = holder.paneid;
        log(`launch: "${recipe.name}" — picker resume of ${picked} is already live in ${holder.paneid}`);
      } else if (holder && holder.state !== 'corrupted' && (refused = earlyRefusal(holder.paneid, picked))) {
        log(`launch: "${recipe.name}" - picker resume of ${picked} refused (guard 7)`);
      } else if (holder && holder.state !== 'corrupted') {
        pickerPane = holder.paneid;
        table.setState(holder.paneid, 'dehydrated');
        log(`launch: "${recipe.name}" — picker resume of ${picked} (its own pane ${holder.paneid})`);
      } else if (!holder && row?.state !== 'corrupted' && (refused = earlyRefusal(row?.state === 'live' ? `recipe:${id}#new` : paneid, picked))) {
        log(`launch: "${recipe.name}" - picker resume of ${picked} refused (guard 7)`);
      } else if (!holder && row?.state !== 'live' && row?.state !== 'corrupted') {
        table.upsert({
          paneid,
          recipe_id: id,
          server: t?.kind === 'ssh' ? (t.sshAlias ?? t.id) : 'local',
          vendor: claudeCode.VENDOR,
          /* The RECIPE's slug, as spawn writes it — never the old row's,
             which predates any re-slug (and, for a terminal, the boot's
             identity-hygiene sweep: wr §2.9). */
          agent: recipe.agent ?? null,
          session_id: picked,
          state: 'dehydrated',
        });
        log(`launch: "${recipe.name}" — picker resume of ${picked}`);
      } else if (!holder && row?.state === 'live') {
        pickerPane = `recipe:${id}#${randomUUID().slice(0, 8)}`;
        table.upsert({
          paneid: pickerPane,
          recipe_id: id,
          server: t?.kind === 'ssh' ? (t.sshAlias ?? t.id) : 'local',
          vendor: claudeCode.VENDOR,
          agent: recipe.agent ?? null, // the recipe's, as above
          session_id: picked,
          state: 'dehydrated',
        });
        log(`launch: "${recipe.name}" — picker resume of ${picked} → new pane ${pickerPane} (${paneid} is live)`);
      } else {
        log(`launch: "${recipe.name}" — picker resume of ${picked} refused (${holder?.paneid ?? paneid} is corrupted)`);
      }
    } else if (
      b.resume === true &&
      row?.state === 'killed' &&
      row.session_id &&
      isResumableVendor(row.vendor)
    ) {
      refused = earlyRefusal(paneid, row.session_id);
      if (!refused) {
        table.setState(paneid, 'dehydrated');
        log(`launch: "${recipe.name}" — recently-closed resume of ${row.session_id}`);
      }
    }
  } catch {
    /* no/invalid body = plain launch */
  }
  /* ...and a plain Restore of a pane that is ALREADY restorable (the
     manager's Restore, a room seat's rehydrate, a room reconnect): the same
     check, nothing having been stamped. */
  if (!refused && !wantsFresh) {
    const lp = (pickerPane && pickerPane !== `recipe:${id}` ? pickerPane : null) ?? explicitPane ?? `recipe:${id}`;
    const r = table.get(lp);
    if (r?.state === 'dehydrated' && r.session_id && isResumableVendor(r.vendor)) {
      refused = earlyRefusal(lp, r.session_id);
    }
  }
  if (refused) {
    throw new LaunchRefused(refused);
  }
  // The window is the viewer; the spawn happens when it attaches (so a test
  // or script can drive the same path over WS without popping windows).
  /* TWO AUDIENCES, TWO FORMS — and they are not interchangeable.
   * `soloUrl` is what the DESKTOP opens, built by `desktop.soloUrlFor`:
   * the absolute-loopback form while the engine and the desktop share a
   * machine, the base a window agent registered once they do not (a server
   * engine's own 127.0.0.1 is not where the window appears). `soloPath` is
   * relative: a BROWSER resolves it against its own origin, which is the
   * only form that survives the trip to a laptop or an iPad (an absolute
   * 127.0.0.1 link would point at the client's own loopback) and the only
   * one that stays correct behind a Tailscale Serve hostname. Never send
   * the absolute form to a remote client. */
  /* A project's FIRST session keeps the historical paneid `recipe:<id>`;
     an additional one gets a suffixed handle. Keeping the first stable
     means existing rows, bookmarks and the window-dedupe URL all still
     match — only the SECOND session needs a new name. */
  const freshPane = wantsFresh ? `recipe:${id}#${randomUUID().slice(0, 8)}` : null;
  /* The pane this launch is FOR — newly minted, explicitly asked for, or
     the project's primary. It drives the url (and therefore the window
     dedupe, which compares panes rather than url text) and every answer. */
  const targetPane =
    freshPane ?? (pickerPane && pickerPane !== `recipe:${id}` ? pickerPane : null) ?? explicitPane;
  const soloPath = soloPathFor(id, targetPane, modelOverride, effortOverride);
  const soloUrl = desktop.soloUrlFor(soloPath);
  const launchPane = targetPane ?? `recipe:${id}`;
  /* A HUMAN ASKED. This is the only path that knows that, so it is the only
     one that may authorise creating a CLI — see spawnPermits. */
  grantSpawnPermit(targetPane ?? `recipe:${id}`);
  /* A room seat binds the pane HERE — after the pane is decided and the
     permit minted, BEFORE anything is placed on screen — so a refused bind
     (it throws) opens no window and no tab (roster verbs, 2026-09-25). */
  onPane?.(launchPane);

  /* ONE WINDOW PER PTY — the rule holds on BOTH placement paths.
   *
   * `target:"tab"` lets a per-window CLI Manager put a session in its own
   * window, but it does NOT let it decide that placement is safe. The
   * engine checks the live window inventory first: if this session is
   * already on screen anywhere, we focus THAT view and tell the caller
   * `placement:"focused"` — it must not add a tab. Only when nothing is
   * showing does the caller get `placement:"tab"` and the url to mount.
   * Every manager instance asks this same question, so N managers still
   * cannot produce two views of one pty. */
  if (wantsTab) {
    table.touchRecipeLaunched(id);
    /* A BROWSER surface cannot be served by the window host at all: its tabs
     * are not in the host's inventory and `focus` cannot reach them. So for
     * a browser we skip the showing-check and always grant local placement.
     *
     * This does NOT weaken one-window-per-pty — it acknowledges the rule's
     * scope. `desktop.focus` asks the VRPC's desktop what IT has open;
     * a tab in a browser on a laptop was never in that inventory and never
     * could be. Two views across two machines is the case the control lease
     * governs (one keyboard, explicit handoff), which is exactly the
     * "pause the VRPC when I pick up the laptop" model.
     *
     * The client declares its own surface. That is safe here because
     * placement is a UX decision, not a security one — the worst a wrong
     * declaration does is open a window in the wrong place. Auth is what
     * guards the shells, and it is checked separately. */
    if (wantsBrowserTab) {
      log(`launch: "${recipe.name}" → tab in the asking BROWSER`);
      return {
        ok: true, paneid: targetPane ?? `recipe:${id}`, url: soloUrl, path: soloPath, placement: 'tab',
      };
    }
    /* The DESKTOP answers "is this pane already on screen"; the engine
     * decides what that means. Loopback asks :8200 and derives panes from
     * the urls it reports; an agent matches the paneid it published in its
     * own inventory. Either way the rule is enforced here, once. */
    const showing = (await desktop.focus(launchPane, soloUrl)).ok;
    if (showing) {
      log(`launch: "${recipe.name}" — already on screen → focused (no tab added)`);
      return { ok: true, paneid: targetPane ?? `recipe:${id}`, url: soloUrl, path: soloPath, placement: 'focused' };
    }
    log(`launch: "${recipe.name}" → tab in the asking window`);
    return { ok: true, paneid: targetPane ?? `recipe:${id}`, url: soloUrl, path: soloPath, placement: 'tab' };
  }

  /* THE DESKTOP PLACES IT, and reports where.
   *
   * Loopback answers immediately — the window opens behind the response,
   * because a caller's HTTP reply must not wait on a protocol kick — so
   * `placement:'window'` is the engine's DECISION, not a report that a
   * window is painted. An agent answers when it has actually done it. A
   * mode with no desktop (or an agent mode with nobody registered) answers
   * `browser`, which is not an error: the url is in the reply and the
   * caller opens it, exactly as a phone does today (contract §5b). */
  const placed = await desktop.open({
    url: soloUrl,
    paneid: launchPane,
    title: recipe.name,
    placement: 'window',
    ...(byUserId ? { byUserId } : {}),
  });
  table.touchRecipeLaunched(id);
  log(
    `launch: "${recipe.name}" → ${placed.placement ?? 'window'} ${soloUrl}` +
      (placed.error ? ` (${placed.error})` : ''),
  );
  return {
    ok: true,
    paneid: launchPane,
    url: soloUrl,
    path: soloPath,
    placement: placed.placement ?? 'window',
  };
}

/** A person an AGENT cannot pass as (the Concierge sign-off routes, design review security read 2026-10-25): an identity session or device principal, with no Authorization header.
 *  The legacy cookie counts ONLY in local mode, where the token is per launch, never on disk and scrubbed from pane env. On a server it is derivable from the shared bearer, which
 *  agents can read, so it does not. `humanCredential` itself is NOT tightened here (engine-opened windows still get the legacy cookie from launch tickets). */
function unforgeablePerson(req: IncomingMessage, principal: identity.Principal | null): boolean {
  if (req.headers.authorization) {
    return false;
  }
  if (principal) {
    return principal.via === 'session' || principal.via === 'device';
  }
  return LOCAL.enabled && auth.authorized(req);
}

/** The identity account of the PERSON behind a request: an identity session or device principal with NO Authorization header. A bearer, an api token or a pane token is not one
 *  (undefined). This is what a window ticket is bound to; it is read at the request, passed down explicitly, and never carried by ambient context. */
function personUserId(req: IncomingMessage, principal: identity.Principal | null): string | undefined {
  return !req.headers.authorization && principal && (principal.via === 'session' || principal.via === 'device') ? principal.userId : undefined;
}

/* The `user` a pane token introspects as. The shared bearer introspects as
   `legacy` and the engine checks panes in to the fabric under it, so a pane's
   own token names the same person; the fabric's instance-ownership check
   (`instance-not-yours`) then agrees with the engine's check-ins. */
const PANE_TOKEN_USER = 'legacy';

/**
 * Every request that presented a PANE TOKEN (briefing-table-mcp §3.1, §4.1).
 * DEFAULT DENY: the routes below, and every other route is 403
 * `not_for_pane_token` — including /launch, /pty, /api/table, /account and
 * every human route. Nothing here consults the identity layer or the shared
 * bearer, and nothing below the global gate is reached from here.
 */
async function handlePaneToken(req: IncomingMessage, res: ServerResponse, route: string, r: paneTokens.Resolution): Promise<void> {
  /* Review P2-3: nothing on this path may throw out of the request handler —
     the server has no unhandledRejection handler, so it would end the engine. */
  await paneTokens.guarded(res, `${req.method ?? 'GET'} ${route}`, () => paneTokenRoute(req, res, route, r));
}

async function paneTokenRoute(req: IncomingMessage, res: ServerResponse, route: string, r: paneTokens.Resolution): Promise<void> {
  const method = req.method ?? 'GET';
  if (!r.ok) {
    log(`pane token REFUSED (${r.code}) ${method} ${route}`);
    sendJson(res, 401, { ok: false, error: r.code });
    return;
  }
  const a = r.principal;
  /* runtime P1-C (§5 ask 1): ONE token for both doors. The fabric learns the
     pane and the ONE project it may speak as, so its ENFORCE_FROM binds `from`
     without the shared bearer. `kind: 'pane'` is not a human kind there. */
  if (route === '/identity/introspect' && method === 'GET') {
    const row = table.get(a.paneid);
    log(`introspect: ok pane=${a.paneid} gen=${a.generation}`);
    sendJson(res, 200, {
      ok: true,
      principal: {
        user: PANE_TOKEN_USER,
        kind: 'pane',
        paneid: a.paneid,
        since: new Date(a.mintedAt).toISOString(),
        projects: row?.agent ? [row.agent] : [],
      },
      mode: identity.mode(),
    });
    return;
  }
  if (route === '/api/fabric/send' && method === 'POST') {
    try {
      const b = await readBody(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        sendJson(res, 400, { ok: false, error: 'the body is a JSON object', field: 'body' });
        return;
      }
      const refused = paneTokens.fabricSendRefusal(
        b,
        (from) => paneTokens.isOwnPane(from, a.paneid),
        (thread) => table.listRooms().some((room) => room.thread === thread),
      );
      if (refused) {
        log(`fabric send ${a.paneid}: REFUSED ${refused.error}`);
        const { status, ...body } = refused;
        sendJson(res, status ?? 403, { ok: false, ...body });
        return;
      }
      /* `from` is FORCED to the token's pane (§4.1): the same resolution the
         bearer door runs on a caller's `from`, run on the pane itself. */
      const sender = resolveFabricSender({ paneid: a.paneid });
      if (!sender.ok) {
        sendJson(res, 403, { error: 'from-unbound', field: 'from', reason: sender.reason });
        return;
      }
      await fabricSendAs(res, sender.row, b);
    } catch (err) {
      sendJson(res, errStatus(err), { error: (err as Error).message });
    }
    return;
  }
  /* PROJECT CHANNEL (the design notes): a hook or script running in a
     pane reads project activity and holds a project lock AS ITS OWN PANE. */
  if (await projects.handle(req, res, route, { log, human: false, principal: null, agent: { paneid: a.paneid } })) {
    return;
  }
  /* USER DEVICE PRESENCE [room [ref]]: a seat may READ where the person is; the write door refuses it (person_only) */
  if (await userPresenceRoutes.handle(req, res, route, { human: false, principal: null })) {
    return;
  }
  /* the asset picker's library reads [asset picker]: two fixed GETs, pane token or person */
  if (await libraryProxy.handle(req, res, route)) {
    return;
  }
  if (
    await rooms.handleAgent(req, res, route, a.paneid, {
      projector: async () => {
        const c = await projectionContext();
        return (row) => projectRow(row, c);
      },
      log,
    })
  ) {
    return;
  }
  /* [concierge] the read scope: THE concierge pane only (engine/concierge.ts isConciergePane) */
  if (
    await conciergeRoutes.handleScope(req, res, route, a.paneid, {
      sessions: conciergeSessions,
      rooms: () =>
        rooms.conciergeRooms(async () => {
          const c = await projectionContext();
          return (row) => projectRow(row, c);
        }),
      recipeSessions: async (id) => {
        const rec = table.getRecipe(id);
        return rec ? recipeSessionList(rec) : null;
      },
      relay: conciergeRelayDeps,
      act: conciergeActDeps,
      log,
    })
  ) {
    return;
  }
  log(`pane token ${a.paneid}: ${method} ${route} → not_for_pane_token`);
  sendJson(res, 403, { ok: false, error: 'not_for_pane_token', message: 'a pane token reaches its rooms and the fabric send, nothing else' });
}

/* What a room door needs to START a pane (seat start, reload, wake): shared by the
   person's door and, through rooms.setStartDeps, the pane-token door, so an agent's
   room_post can wake a resting seat too [agent rest]. */
const roomStartDeps: Partial<rooms.RoomRouteDeps> = {
  engineSpawnsOnStart: LOCAL.enabled,
  /* Seat start (roster verbs): the SAME launch as POST /api/recipes/:id/launch. */
  launch: async (recipeId, body, onPane) => {
    /* TEST-ONLY, inert unless set: HARBOR_WB_FAIL_LAUNCH_RECIPE names a
       recipe id this closure refuses for — the seat-reload rollback path
       (ticket) has no other way to force a real launchRecipe failure for
       a fresh/headless placement (nothing in that path awaits before
       returning, so there is no realistic refusal to provoke). */
    if (recipeId && recipeId === process.env.HARBOR_WB_FAIL_LAUNCH_RECIPE) {
      throw new Error('launch refused (HARBOR_WB_FAIL_LAUNCH_RECIPE, test-only)');
    }
    const recipe = table.getRecipe(recipeId);
    if (!recipe) throw new Error(`unknown recipe: ${recipeId}`);
    return launchRecipe(recipeId, recipe, body, onPane);
  },
  endForCycle,
  closeWindow: closeWindowsOf,
  /* Seat reload (ticket): the SAME socket/ready/needsYou shape
     handleFabricRestore already wires for fabric-restore.ts, so a seat
     reload's headless launch can attach itself as the viewer. */
  socketUrl: () => {
    const a = server.address();
    const port = a && typeof a === 'object' ? a.port : PORT;
    const host = a && typeof a === 'object' && a.address !== '0.0.0.0' && a.address !== '::' ? a.address : '127.0.0.1';
    return `ws://${host.includes(':') ? `[${host}]` : host}:${port}/pty`;
  },
  socketToken: () => auth.bearerToken(),
  needsYou: (p) => {
    const b2 = promptBlock.get(p);
    if (b2) {
      return b2.reason;
    }
    const k = startupGate.currentPrompt(p)?.kind;
    return k && HUMAN_STARTUP_PROMPTS.has(k) ? k : null;
  },
  ready: (p) =>
        startupReady({
          vendor: (table.get(p) as { vendor?: string | null } | undefined)?.vendor,
          gateArmed: !!startupGate.info(p),
          gateBlocked: startupGate.isBlocked(p),
          live: sessions.isLive(sessions.get(p)),
          state: activity.get(p),
          lastOutputAt: activity.lastOutputAt(p),
          dialogUp: activity.isDialogUp(p),
          now: Date.now(),
        }),
  /* [assistant switch] CONFIRMED stop (spec §3 item 1): this engine holds no live session for the pane, the
     table says it ended, AND the broker that held it answers. Anything less is unknown, never proof. */
  paneStopped: (p) => {
    if (switchHost.testControl().unreachable) return null; // TEST-ONLY (inert unless the control file is set)
    if (sessions.isLive(sessions.get(p))) return false;
    const row = table.get(p);
    if (!row || row.state === 'live') return null;
    return brokerClient.statuses()[brokerHostOfServer(row.server)] === 'up' ? true : null;
  },
  /* [assistant switch] the target vendor's own status command, in the target pane's shell on this host
     (interactive, like the pane's own); a session on another machine is "could not tell". */
  vendorReady: async (vendor, recipeId) => {
    const recipe = table.getRecipe(recipeId);
    const t = recipe ? loadTargets().find((x) => x.id === recipe.target) : undefined;
    const shell = t?.shell ?? 'bash';
    if (!recipe || !t || !channels.ptyRunsHere(t) || !/(^|\/)(bash|zsh|sh)$/.test(shell)) {
      return { ok: true, warn: 'could not check the sign-in from here; it will be checked as it starts' };
    }
    return probeVendor(vendor, recipe.projectDir || null, { shell, shellArgs: ['-ic'] });
  },
  /* [assistant switch] the engine attaches to its own headless pane in-process (self-viewer.ts): under strict
     accounts its socket dial with the shared bearer is refused, so a switch could never start its target. */
  openSelf: () => {
    const { server: s, client } = selfPair();
    wss.emit('connection', s, { socket: { remoteAddress: '127.0.0.1' }, headers: {}, url: '/pty' } as unknown as IncomingMessage);
    return client;
  },
  localPane: (p) => {
    const row = table.get(p);
    const t = row ? targetOfRow(row as { server: string; recipe_id: string | null }) : undefined;
    return !!t && channels.ptyRunsHere(t);
  },
};
rooms.setStartDeps(roomStartDeps);
/* the launch path reads the first-run auto-approve default through this hook (off until a person chooses) */
setDefaultReader(() => readState(table.getEngineSetting('autoApprove')).default);

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  /* M14: no page of this engine can be framed by another site. A response that sets its own CSP (e.g. /app) keeps its frame-ancestors 'self' there. */
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('content-security-policy', "frame-ancestors 'self'");
  /* LOCAL MODE: only the loopback name on our own port may talk to us (DNS rebinding), checked before anything else. */
  if (LOCAL.enabled && !hostHeaderAllowed(req.headers.host, boundPort)) {
    res.writeHead(421, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'host-not-allowed' }));
    return;
  }
  /* M1: a sandboxed module frame sends `Origin: null` on its script/style fetches. A GET/HEAD of a module page (and only that) may carry exactly that origin; every other path still refuses `null`. */
  /* A no-cors subresource of the sandboxed frame (a stylesheet, image, font) carries NO Origin and Sec-Fetch-Site: cross-site (its initiator is opaque): the same exemption, for the same paths and methods only. */
  const moduleUiNullOrigin = (req.method === 'GET' || req.method === 'HEAD') && (req.headers.origin === 'null' || req.headers.origin === undefined) && moduleHost.isUiPath((req.url ?? '/').split('?')[0]);
  if (LOCAL.enabled && !moduleUiNullOrigin && browserOriginRefused(req.headers, boundPort, originsFor((req.url ?? '/').split('?')[0]))) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'origin-not-allowed' }));
    return;
  }
  /* H5: an Origin that is not ours refuses a state-changing request in every mode; hosted also needs an Origin on cookie calls and JSON bodies (src/server/origin-guard.ts) */
  {
    const og = checkOrigin(req, { hosted: auth.hostedProfile(), boundPort, extraOrigins: guardOrigins((req.url ?? '/').split('?')[0]) });
    if (!og.ok) {
      sendJson(res, og.status ?? 403, { error: og.error ?? 'origin-not-allowed', ...(og.status === 421 ? {} : { field: 'origin' }) });
      return;
    }
  }
  await bootReady; // no route answers until reconcile+adoption complete (vk [ref])
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];
  const peer = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
  /* M1: a module page runs in an opaque-origin sandbox, so its script/style fetches carry NO cookie. Those GETs are the app's own shipped code (nothing secret lives under ui/); they are answered here,
     before the sign-in gate, with every other M1 check kept (module listed, on, path rules, realpath, and for a plugin its consent + pinned bytes). The Host guard above has already run. */
  if ((req.method === 'GET' || req.method === 'HEAD') && moduleHost.isUiPath(pathname) && moduleHost.serveUi(req, res, pathname)) {
    return;
  }

  /* ---- PANE TOKENS (briefing-table-mcp §3.1, S1), inert unless
   * HARBOR_WB_PANE_TOKENS=1. Resolved BEFORE identity and the gate, and
   * answered ENTIRELY by handlePaneToken — a pane token never becomes an
   * identity principal, never meets `identity.allowed`/`humanCredential`/
   * `auth.authorized`, and reaches only the §4.1 allow-list. An unknown
   * bearer (`token_invalid`) is not a pane token at all: it may be the shared
   * bearer or an api token, and meets the normal gate below. */
  /* ---- /mcp (E1): the engine-served room tools, MCP server `bt`. Its own credential check (a pane token, nothing else), so it is answered
   * BEFORE the generic pane-token branch: a bad token there must be an `isError` result after initialize, never a gate redirect. */
  if (pathname === '/mcp') {
    await paneTokens.guarded(res, `${req.method ?? 'GET'} /mcp`, () =>
      btMcp.handle(req, res, {
        projector: async () => {
          const c = await projectionContext();
          return (row) => projectRow(row, c);
        },
        log,
      }),
    );
    return;
  }

  if (paneTokens.enabled()) {
    /* P1-B: introspect's caller is the FABRIC (loopback, no x-forwarded-for),
       not the pane, so the advisory origin check does not apply there. */
    const agent = paneTokens.resolve(req, { checkOrigin: !(pathname === '/identity/introspect' && req.method === 'GET') });
    if (agent && !(agent.ok === false && agent.code === 'token_invalid')) {
      await handlePaneToken(req, res, pathname, agent);
      return;
    }
  }

  /* ---- THE RESTORE-SCOPED TOKEN (ticket) — the fabric's credential for
   * POST /api/fabric/restore and NOTHING else. The fabric runs as `service`
   * and must never hold the engine bearer, so it presents a token read from
   * HARBOR_WB_FABRIC_RESTORE_TOKEN_FILE (fabric-restore.ts). Answered HERE,
   * before identity and the gate, so it never becomes a principal: that one
   * route, or 401. Unset env / missing file = no such token exists. */
  if (fabricRestore.presentsRestoreToken(req, auth.bearerToken())) {
    if (pathname === '/api/fabric/restore' && req.method === 'POST') {
      await handleFabricRestore(req, res);
      return;
    }
    log(`restore token REFUSED on ${req.method ?? 'GET'} ${pathname} (valid for POST /api/fabric/restore only)`);
    sendJson(res, 401, { error: 'this token is valid for POST /api/fabric/restore only' });
    return;
  }

  /* ---- user identity (E13), inert unless HARBOR_WB_IDENTITY says otherwise --
   * Resolved ONCE per request so the gate below and the /account routes cannot
   * disagree about who is calling. Returns null in legacy mode without opening
   * the identity db at all. */
  const principal = identity.resolveIdentity(req);
  /* THE VOICE ACTOR'S SCOPE (the design notes §6.3): the voice service's named api token
   * reaches /api/voice/* and /health, nothing else. Checked here, BEFORE the
   * identity routes, so it cannot reach /account and mint itself a wider
   * token either. A 3B model is not a security boundary; this is. */
  if (identity.isVoiceActor(principal) && !identity.voiceScopeAllows(pathname)) {
    sendJson(res, 403, { error: identity.VOICE_SCOPE_REFUSAL });
    return;
  }
  /* L5, HOSTED: the node description and the logo presets file (which carries every uploaded logo) need a sign-in; /health below answers {status:"ok"} to the unauthenticated */
  if (auth.hostedProfile() && (pathname === '/api/node' || pathname === '/vendor/aurora-logo-presets.js') && !identity.allowed(principal, auth.authorized(req))) {
    sendJson(res, 401, { error: 'sign-in-required' });
    return;
  }
  /* `/identity/introspect` is called even when identity is `legacy` — the
   * message-fabric needs to validate a caller on a host that has not switched
   * identity on yet (contract §0/§2) — so it is let through the gate below
   * that otherwise short-circuits the whole of identityRoutes in that mode. */
  if (
    (pathname === '/identity/introspect' || pathname === '/api/node' || identityRoutes.enabled()) &&
    (await identityRoutes.handle(req, res, pathname, peer, principal, IDENTITY_DEPS))
  ) {
    return;
  }

  /* ---- login: the browser half of the one secret ---- */
  if (pathname === '/login') {
    if (req.method === 'POST') {
      if (auth.throttled(peer)) {
        res.writeHead(303, { location: '/login?slow' });
        res.end();
        return;
      }
      const body = await new Promise<string>((resolve) => {
        let acc = '';
        req.on('data', (c) => {
          acc += c;
          if (acc.length > 4096) {
            req.destroy(); // a token is short; anything bigger is not a login
          }
        });
        req.on('end', () => resolve(acc));
      });
      const submitted = new URLSearchParams(body).get('token') ?? '';
      const cookie = auth.loginCookie(submitted, auth.isSecureRequest(req));
      if (!cookie) {
        auth.recordFailure(peer);
        log(`login FAILED from ${peer}`);
        const back = new URLSearchParams(body).get('next');
        const keep = auth.safeNext(back);
        res.writeHead(303, {
          location: keep === '/' ? '/login?bad' : `/login?bad&next=${encodeURIComponent(keep)}`,
        });
        res.end();
        return;
      }
      auth.clearFailures(peer);
      log(`login ok from ${peer}`);
      /* Back to what they actually asked for. Without this a deep link (the
       * harbor tray's "Open CLI Manager" → /api/open-manager, any bookmarked
       * session) silently becomes "you are now at the home page", and the
       * action the user clicked is lost. */
      const next = new URLSearchParams(body).get('next');
      res.writeHead(303, { location: auth.safeNext(next), 'set-cookie': cookie });
      res.end();
      return;
    }
    const page = await readFile(join(WEB_ROOT, 'login.html')).catch(() => null);
    if (!page) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('login page missing');
      return;
    }
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store, must-revalidate' });
    res.end(page);
    return;
  }

  /* A window the ENGINE opened arrives carrying a one-time ticket, because the
   * window host's WebView2 has no cookie on first run. Exchange it for the
   * cookie and redirect to the SAME url without the ticket, so nothing durable
   * is left in the address bar or in history. Checked before the gate: this IS
   * the act of authenticating. */
  const ticket = auth.ticketIn(url);
  if (ticket) {
    /* Strip whenever a ticket is PRESENT, grant only when it REDEEMS.
     * Two separate concerns: an expired or already-burned ticket must still be
     * scrubbed from the address, or it lingers in the window host's tab record
     * (its GET /windows is unauthenticated) and in history.
     *
     * The strip is string surgery, NOT a URL round-trip. Re-serialising through
     * URLSearchParams is not byte-identical to what the client sent —
     * encodeURIComponent leaves !'()*-._~ unescaped and URLSearchParams
     * encodes space as '+' — so reparsing would corrupt a `?tabs=<encoded url>`
     * or a recipe id containing those characters. Recipe ids are not guaranteed
     * uuids either: the create route accepts a client-supplied id verbatim. */
    const granted = auth.redeemTicket(ticket);
    log(`ticket ${granted.ok ? 'redeemed' : 'REJECTED (stale/forged)'} → ${pathname}`);
    const headers: Record<string, string> = { location: auth.stripTicket(url) };
    if (granted.ok) {
      /* Where identity exists the window gets an IDENTITY session (a person an agent cannot forge); the legacy cookie only where identity is off, or when no account
         can be named for the window (then person-only actions stay refused in it, and the log says why). */
      const already = identity.enabled() ? identity.personByCookie(req) : null;
      const keep = !!already && (granted.userId === null || granted.userId === already.userId); // signed in here already, as the person the ticket names (or as nobody in particular)
      const session = identity.enabled() && !keep ? identity.sessionCookieForTicket(granted.userId, auth.isSecureRequest(req)) : null;
      if (identity.enabled() && !session && !keep) log(`ticket → ${pathname}: no account could be named for this window; legacy cookie, person-only actions refused in it`);
      if (!keep) headers['set-cookie'] = session ?? auth.ticketCookie(auth.isSecureRequest(req));
    }
    res.writeHead(303, headers);
    res.end();
    return;
  }

  /* ROOM PANEL FRAME TOKEN [ticket]: a sandboxed panel frame's own requests
     may not carry the cookie, so its URL carries a per-panel token. Checked
     only when the request is NOT otherwise authenticated, and answers only a
     `/frame/t/<token>/` path (rooms.frameByToken) — every other route still
     meets the gate below. */
  if (
    pathname.startsWith('/api/rooms/') &&
    !identity.allowed(principal, auth.authorized(req)) &&
    rooms.frameByToken(req, res, pathname, log)
  ) {
    return;
  }

  if (
    !auth.isPublicPath(pathname) &&
    !auth.isLocalHookDelivery(req, pathname) &&
    !identity.allowed(principal, auth.authorized(req))
  ) {
    auth.denyHttp(req, res);
    return;
  }

  /* FORCED CHANGE GATE. A temporary code is safe only because it cannot be
   * LIVED WITH, so while `must_change_password` stands, everything except the
   * change form, the account read and logout answers 403 — including the API,
   * so a window that is already open cannot keep working around it. */
  if (principal?.mustChangePassword && !identityRoutes.changeAllowed(pathname)) {
    sendJson(res, 403, { mustChangePassword: true, error: 'set a password first' });
    return;
  }

  /* LOCAL MODE: a graceful stop the app can ask for where there is no SIGTERM (Windows TerminateProcess skips Node's handlers). The token
     gate above already applies. 200, then exit(0) a moment later so the answer is written; the 'exit' handlers flush the note copies
     and release the data folder lock. The caller allows about 2 s before it ends the process by force. */
  if (LOCAL.enabled && pathname === '/api/local/shutdown' && req.method === 'POST') {
    if (req.headers.origin !== undefined) {
      res.writeHead(403, { 'content-type': 'application/json' }); // only the supervisor's own call, which sends no Origin
      res.end(JSON.stringify({ error: 'origin-not-allowed' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stopping: true }));
    log('local mode: shutdown requested over HTTP');
    setTimeout(() => process.exit(0), 50);
    return;
  }

  /* LOCAL MODE: the chat-history export (Settings > Chat history). */
  if (LOCAL.enabled && historyExporter && (pathname === '/api/history-export' || pathname.startsWith('/api/history-export/'))) {
    if (await handleHistoryRoute(req, res, pathname, historyExporter, table as never, historyFilesRoot)) {
      return;
    }
  }

  /* W3b terminal grants (src/server/term.ts): person cookie + Origin only; 404 while off. */
  if (pathname === '/api/terminal-grants') {
    await term.handleMint(req, res, principal, TERM_DEPS);
    return;
  }

  if (url === '/health' || url === '/api/health') {
    if (auth.hostedProfile() && !identity.allowed(principal, auth.authorized(req))) {
      res.writeHead(200, { 'content-type': MIME['.json'] });
      res.end('{"status":"ok"}');
      return;
    }
    const components = await loadComponents();
    res.writeHead(200, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify({ status: 'ok', milestone: 8, edition: process.env.HARBOR_WB_EDITION || 'full', reapMs: sessions.reapMs(), debugUi: DEBUG_UI, flags: runtimeFlags.all(), broker: brokerClient.available(), brokers: brokerClient.statuses(), components: components.map((c) => c.id) }));
    return;
  }

  // Open (or FOCUS) the CLI Manager in the window-host shell. Exists because
  // the shell's `+`/hub route is invisible on a single-tab window, so there
  // was no reliable way to reach the Manager once every window was a shell
  // window (Owner, 2026-08-10). Reachable from the harbor tray via open_url.
  if (url.split('?')[0] === '/api/open-manager') {
    void desktop.open({ url: desktop.soloUrlFor('/manager.html'), paneid: null, title: 'Workbench', placement: 'window' });
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Workbench</title>
<body style="font:14px system-ui;background:#0b1016;color:#e6e6e6;padding:28px">
Opening the Workbench in the window host… <span style="opacity:.6">you can close this tab.</span>
<script>setTimeout(()=>window.close(),1200)</script>`,
    );
    return;
  }

  if (url === '/api/components') {
    const components = await loadComponents();
    res.writeHead(200, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify({ components: components.map(publicComponent) }));
    return;
  }

  /* BRAND IDENTITY (contract §9). One identity mark per VENDOR, joined to a
     session by its `vendor` — which presence and every /api/table row already
     carry, so a surface holding a session already has everything it needs and
     no new field travels with a session.
     
     Served WHOLE and cached hard: it is a lookup table that changes when a
     brand is added, which is roughly never. Authenticated exactly like
     /api/table (it sits below the same gate) — not because the contents are
     secret, but because an unauthenticated route on this engine is a decision,
     and this one has no reason to be one.
     
     A vendor with no entry (including the literal "unknown" a row with no
     recorded vendor reports) resolves to `generic`, which is guaranteed present
     — see src/engine/brands.ts. */
  if (url === '/api/brands') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ brands: loadBrands() }));
    return;
  }

  /* HOSTED LIVE PANES (web-first pilot): the panes this server holds, as the web app needs them — no recipe internals, no paths beyond the folder. Any signed-in caller (read-only). */
  if (pathname === '/api/sessions' && req.method === 'GET') {
    const out = table.list().filter((r: any) => r.state === 'live' || r.state === 'dehydrated').map((r: any) => {
      const rec = r.recipe_id ? table.getRecipe(r.recipe_id) : null;
      const alive = r.state === 'live';
      return {
        paneid: r.paneid,
        name: r.title || r.friendlyName || rec?.name || r.paneid,
        folder: rec?.projectDir ?? null,
        recipeId: r.recipe_id ?? null,
        startedAt: r.started_at ?? null,
        alive,
        ...(alive ? {} : { endedAt: r.updated_at ?? null, exitCode: typeof r.exit_code === 'number' ? r.exit_code : null }),
      };
    });
    sendJson(res, 200, { sessions: out });
    return;
  }

  // The mapping table, exposed as an endpoint (Seam C2). Read-only over HTTP;
  // writes happen through the engine's component mechanics, not this route.
  if (pathname === '/api/table') {
    // Decorated with the in-memory activity state (vk [ref]): live panes get
    // their tracked state; dehydrated rows read `disconnected` (restorable but
    // nobody home); killed rows get no dot.
    const ctx = await projectionContext();
    const linkStatus = ctx.linkStatus;
    const rows = table.list().map((r: any) => projectRow(r, ctx));
    /* THE LOGO BY KEY [perf/poll-traffic]: a row's logo pref is the whole
       {key, svg, ...} object, and the SVG was ~85% of every 2.5 s poll (606 of
       712 KB on Owner's table: 17 distinct sets copied into 144 rows). Every
       reader of this route resolves the mark by KEY (manager markSvg), so rows
       carry `logo` WITHOUT `svg` plus a top-level `logoKey`. `?logo=full`
       answers the old shape for anything that still wants the markup. */
    const fullLogos = new URLSearchParams(url.split('?')[1] ?? '').get('logo') === 'full';
    for (const r of rows) {
      const slim = slimLogo(r.logo);
      r.logoKey = slim.key;
      if (!fullLogos) {
        r.logo = slim.logo;
      }
    }
    /* Kick a background title refresh for any project that has a session on
       screen whose name we do not know yet. Fire-and-forget by design: this
       response goes out with whatever is cached, and the NEXT poll (2.5s later)
       carries the answer. Blocking here would put an ssh round trip inside the
       manager's polling loop. */
    for (const r of rows) {
      if (r.state === 'killed' || !r.recipe_id) {
        continue;
      }
      const rec = table.getRecipe(r.recipe_id);
      if (!rec) {
        continue;
      }
      const t = loadTargets().find((tt) => tt.id === rec.target);
      /* Widget status is refreshed BEFORE the claude gate below. The first tool
         to publish one is the command bridge, which is runClaude=0 — gating it on
         the title conditions would have meant it never refreshed at all. */
      if (rec.statusPath) {
        const wacc = widgetAccess(t);
        if (wacc.reachable) {
          widgetStatus.refresh(rec.statusPath, wacc.sshAlias);
        }
      }
      if (!r.session_id || r.title || !rec.projectDir || !rec.runClaude) {
        continue;
      }
      /* SELF-HOSTED POLARITY (2026-09-17): a target whose data lives on THIS
         engine's own host must be read locally even when it is `kind:'ssh'`
         (homebase-resident) — see launch.ts's isSelfHosted. A foreign-broker
         target with no alias to reach it is left out entirely rather than
         guessed at as local (see remoteFsAccess); the periodic sweep below
         stays silent about it to avoid logging on every tick. */
      const access = remoteFsAccess(t);
      if (access.mode === 'unreachable') {
        continue;
      }
      titles.refresh(r.recipe_id, { projectDir: rec.projectDir, ...fsOptsFor(access) });
    }

    /* Re-point any live pane whose banked transcript has gone cold at the one
       it is actually in. Reads only what the title refresh above already
       fetched — no extra I/O — and never guesses (see session-adopt.ts). */
    runAdoptions();
    // `broker` is additive (vk [ref] Phase 2): a manager page reloaded against
    // an older engine simply won't see it and shows no broker banner.
    /* ETag + gzip [perf/poll-traffic]: an unchanged table answers 304 with no
       body; a changed one crosses gzip'd. */
    sendJsonCached(req, res, 200, {
      sessions: rows,
      // `available` = the LOCAL broker (manager banner); `hosts` = the whole
      // fleet's link statuses (additive, vk [ref]).
      broker: { available: brokerClient.available(), hosts: linkStatus },
    });
    return;
  }

  /* ---- CLI Manager API (2026-07-07 rescope): targets + recipes + launch ---- */
  const route = url.split('?')[0];

  if (route === '/api/targets') {
    sendJson(res, 200, { targets: loadTargets() });
    return;
  }

  /* ---- push a UI reload to open windows (Owner 2026-09-01) ------------------
   * Web-only changes serve fresh, but a window that is ALREADY open keeps the
   * JS it parsed — so every front-end fix has cost a round trip of "reload the
   * tab", and on a phone that is the slowest step in the loop. The window has a
   * ⟳ button; this is the same act, initiated from here.
   *
   * It reloads the PAGE, never the session: the pty lives in the broker, the
   * socket reconnects and replays, exactly as the button already does. Scoped
   * to one pane by default because reloading someone mid-keystroke is rude;
   * `all` is for a deploy. */
  if (route === '/api/reload-ui' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({} as Record<string, unknown>));
    const want = typeof b.paneid === 'string' ? b.paneid : null;
    let windows = 0;
    let panes = 0;
    for (const [paneid, resident] of sessions.entries()) {
      if (want && paneid !== want) {
        continue;
      }
      panes += 1;
      windows += resident.viewers.size;
      broadcast(resident, { type: 'pane.reload-ui', paneid });
    }
    sendJson(res, 200, { ok: true, panes, windows });
    return;
  }

  /* ---- viewport diagnostics (Owner 2026-09-01) ------------------------------
   * The clipping question could not be settled by reading code. The SAME page,
   * served by THIS engine, laid out correctly at 393px in a WebKit harness
   * while one of Owner's phone tabs cut the titlebar off and another did not.
   * Two causes produce an identical photograph and have opposite fixes: the
   * LAYOUT viewport being wider than the screen (a CSS containment failure) or
   * the VISUAL viewport being zoomed in over a correct layout (a gesture/zoom
   * failure). Only the window can tell them apart, so it reports what it
   * measured and we read it here.
   *
   * In-memory ring, no persistence, no correlation to a session's data — a
   * debugging aid with a short life, not a record. */
  if (route === '/api/diag/viewport' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      viewportReports.push({ at: Date.now(), ...b });
      while (viewportReports.length > 80) {
        viewportReports.shift();
      }
    } catch {
      /* a diagnostic must never be able to fail the page that sends it */
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (route === '/api/diag/viewport' && req.method === 'GET') {
    sendJson(res, 200, { reports: viewportReports });
    return;
  }

  /* WHAT THE WINDOW TOLD THE TAB CHROME (Owner, 2026-09-04). Two of his tabs
   * vanished with the sessions still live, and the question "did the engine ask
   * for that?" was unanswerable from either side: the shell's own log only
   * exists when DEBUG is on and is never persisted, and the engine cannot see a
   * postMessage the page makes. So the page reports what it emitted, and it
   * lands in the same transition log as everything else — the viewport-diag
   * pattern, for the same reason. */
  /* GIT (step C, E4): is it installed, and which version. The app reads it to dim "Needs git" on the code-folder choices and to show the install prompt. */
  if (route === '/api/git' && req.method === 'GET') {
    sendJson(res, 200, await gitStatus());
    return;
  }

  /* THE SIGN-IN LINK (OOBE wizard): the one-time URL a pane's login prompt printed, for "Copy" and "Open". It is credential-adjacent, so it is
     returned ONLY here, to the signed-in PERSON only (an agent or pane token gets 403), with no-store; it is never in the table, a room line or a log. */
  const signIn = /^\/api\/panes\/([^/]+)\/sign-in-link$/.exec(route);
  if (signIn && req.method === 'GET') {
    if (!humanCredential(req, principal)) {
      sendJson(res, 403, { error: 'person_only', message: 'only the signed-in person reads a sign-in link; an agent (or a pane token) does not' });
      return;
    }
    const link = vscreen.signInLinkOf(decodeURIComponent(signIn[1]));
    res.setHeader('cache-control', 'no-store');
    if (link) {
      sendJson(res, 200, { link });
    } else {
      sendJson(res, 404, { error: 'this pane is not showing a sign-in link', field: 'paneid' });
    }
    return;
  }

  /* STARTER ROOMS (row 7; the design notes). The app sends {template, version}; the engine builds the whole
     template in ONE transaction and answers the ids. Repeat or lost reply = 200 `already` with the same ids; first time = 201.
     Refusals carry a machine `code`: not_local (404), unknown_template, invalid (400), recipe_conflict (409). Nothing is started. */
  if (route === '/api/local/seed' && req.method === 'POST') {
    try {
      if (!LOCAL.enabled) {
        sendJson(res, 404, { error: 'starter rooms are seeded by the local engine only', code: 'not_local' });
        return;
      }
      const b = await readBody(req);
      const r = seedStarter(b.template, b.version);
      sendJson(res, r.status === 'created' ? 201 : 200, r);
    } catch (e) {
      if (e instanceof SeedError) {
        sendJson(res, e.code === 'recipe_conflict' ? 409 : 400, { error: e.message, code: e.code });
        return;
      }
      throw e;
    }
    return;
  }

  /* MEMORY (item 3). The app supervisor posts what it measured (job accounting + the PC's free memory); the engine decides. GET says
     what it currently concludes, including "unknown" when nothing fresh has been reported. Local mode only. */
  if (route === '/api/local/memory' && LOCAL.enabled) {
    if (req.method === 'GET') {
      sendJson(res, 200, rooms.memoryVerdict());
      return;
    }
    if (req.method === 'POST') {
      const v = rooms.reportMemory(await readBody(req));
      if (!v) {
        sendJson(res, 400, { error: 'a memory report is {usedBytes, freeBytes, jobCapBytes|null}, plain non-negative numbers', field: 'body' });
        return;
      }
      void rooms.memorySleepSweep(endForCycle, log);
      sendJson(res, 200, v);
      return;
    }
  }

  /* CAUSES (local mode): the fixed-code events the app's cause.log copies. Polled with ?since=<n>; engine/causes.ts. */
  if (route === '/api/local/causes' && LOCAL.enabled && req.method === 'GET') {
    sendJson(res, 200, causes.read(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('since') ?? '0')));
    return;
  }

  if (route === '/api/diag/chrome' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      if (typeof b.paneid === 'string' && typeof b.detail === 'string') {
        activity.onChrome(b.paneid, b.detail.slice(0, 120));
      }
    } catch {
      /* a diagnostic must never be able to fail the page that sends it */
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  /* WHAT THE ENGINE ASKED A DESKTOP TO DO, and what came back (Phase 2).
   *
   * Which mode is live, which window agents are connected and what they say
   * they have on screen, plus a bounded ring of the last actions. Same habit as
   * /api/diag/viewport and /api/diag/activity: when "the window did not open"
   * is equally consistent with no agent, a refused action and a timeout, read
   * the variables instead of theorising. */
  if (route === '/api/diag/desktop' && req.method === 'GET') {
    sendJson(res, 200, desktop.status());
    return;
  }

  /* ---- activity diagnostics (Owner 2026-09-01) ------------------------------
   * "kiosk shows an animated icon when it's idle." The ring is downstream
   * of one number — how long since this pane last saw pty data — and the ring
   * cannot show it. Same lesson as the viewport ring above: when the outside
   * view is consistent with every hypothesis, read the variables. */
  /* What the engine last said about each agent on the pulse plane. Same habit
   * as /api/diag/activity and /api/diag/viewport: when showcase is not drawing
   * an agent, "we never published", "we published the wrong node" and "NATS is
   * off" are three different answers that look identical from outside. */
  /* THE USAGE METER (ticket): the latest Claude / Codex plan usage the agent-usage probes published on
     NATS, validated and reduced to what the titlebar shows. Normal auth; read-only; no tokens in it. */
  if (route === '/api/usage' && req.method === 'GET') {
    sendJson(res, 200, usageMeter.snapshot());
    return;
  }

  /* ROOM FILES for the web UI (per-room folder on the server, sign-in only, never the agent-share) */
  if (await roomFiles.handle(req, res, route, { human: humanCredential(req, principal) })) return;

  /* MODULE HOST (web-first pilot): the catalog, per-module storage and enable switch (src/server/modules/host.ts) */
  if (route.startsWith('/api/modules/plugins') && (await pluginStore.handle(req, route, { human: humanCredential(req, principal), readBody: () => readBody(req), send: (st, b) => sendJson(res, st, b), modules: () => moduleHost.catalog().map(moduleHost.view) }))) return;
  if (route.startsWith('/api/modules') && (await moduleHost.handleApi(req, res, route, { human: humanCredential(req, principal), readBody: () => readBody(req), send: (st, b) => sendJson(res, st, b) }))) return;

  /* FIRST-RUN SETUP + agent install status + sign-in terminal recipes (src/server/setup-routes.ts) */
  if ((route === '/api/settings/setup' || route.startsWith('/api/agents/')) && (await setupRoutes.handle(req, res, route, { human: humanCredential(req, principal), dispatch: loopbackDispatch }))) return;

  /* SETTINGS for the web UI: auto-approve default, per-folder trust, the rooted folder picker */
  if (await settingsRoutes.handle(req, res, route, { human: humanCredential(req, principal), principal })) return;

  /* USER DEVICE PRESENCE [room [ref]]: the person's devices (POST = the person's page; GET = any authenticated reader) */
  if (await userPresenceRoutes.handle(req, res, route, { human: humanCredential(req, principal), principal })) return;

  /* T1: the record of what reached each pane's terminal and from where (src/engine/pty-write.ts). Person only; byte counts and hashes, the text itself only on a test engine. */
  if (route === '/api/diag/pty-writes' && req.method === 'GET') {
    if (!humanCredential(req, principal)) {
      sendJson(res, 403, { error: 'person_only' });
      return;
    }
    const q = new URL(req.url ?? '/', 'http://engine.local').searchParams;
    const origin = q.get('origin');
    sendJson(res, 200, { writes: ptyWrites({ paneid: q.get('paneid') ?? undefined, origin: (origin as never) ?? undefined, since: q.has('since') ? Number(q.get('since')) : undefined }) });
    return;
  }
  if (route === '/api/diag/presence' && req.method === 'GET') {
    sendJson(res, 200, { node: ENGINE_NODE, user: userPresence.query(pictureOwner(null).key, pictureOwner(null).name), ...presence.dump() });
    return;
  }

  /* What the engine's FABRIC SUBSCRIBER is doing. "the fabric is down", "we
     never subscribed to that slug", "the fabric rejected it" and "we delivered
     it and the ack failed" look identical from outside and need four different
     fixes — so the engine says which. Same habit as the three diags above it. */
  if (route === '/api/diag/fabric' && req.method === 'GET') {
    sendJson(res, 200, { ...fabricSub.dump(), checkin: fabricCheckin.dump(), relay: fabricRelay.dump() });
    return;
  }

  /* HARBOR_WB_CHANNELS: per-pane channel dialog outcome, cached presence and
     delivery-path counts (typed / channel / badge / typed-fallback). Counts only. */
  if (route === '/api/diag/channels' && req.method === 'GET') {
    sendJson(res, 200, channels.diag());
    return;
  }

  /* PTY SCREEN MODEL, P0 shadow (the design notes): per pane the sync
     state, size, reading (states + closed evidence codes), counts and timings,
     plus the bounded disagreement log. Never screen text. `?paneid=` filters. */
  if (route === '/api/diag/vscreen' && req.method === 'GET') {
    const paneid = new URL(url, 'http://x').searchParams.get('paneid') ?? undefined;
    sendJson(res, 200, vscreen.diag(paneid));
    return;
  }

  if (route === '/api/diag/activity' && req.method === 'GET') {
    const names = new Map(table.list().map((r: any) => [r.paneid, r.friendlyName]));
    sendJson(res, 200, {
      tuning: activity.tuning(),
      panes: activity.dump().map((p) => ({ ...p, name: names.get(p.paneid) ?? null })),
      reaper: { reapMs: sessions.reapMs(), ...sessions.reapState() },
    });
    return;
  }

  /* WHAT IT *WAS* DOING — the transition log, not the present tense.
   *
   * `/api/diag/activity` answers "streaming, now", which is useless against the
   * question actually being asked ("why did it spin while I was only typing",
   * "why did the coral ring not clear when I opened the tab"). By the time
   * anyone looks, the state has moved. This is the ordered record: every state
   * change with its cause, every hook, every lifecycle event, and every user
   * INPUT (byte counts only) so keystrokes can be lined up against the output
   * they may or may not have caused.
   *
   * `?paneid=` filters, `?minutes=` windows (default 15). */
  if (route === '/api/diag/activity/history' && req.method === 'GET') {
    const q = new URL(url, 'http://x').searchParams;
    const minutes = Math.min(Number(q.get('minutes')) || 15, 60);
    const paneid = q.get('paneid') ?? undefined;
    const names = new Map(table.list().map((r: any) => [r.paneid, r.friendlyName]));
    const events = activity.history({ paneid, sinceMs: minutes * 60_000 });
    sendJson(res, 200, {
      windowMinutes: minutes,
      tuning: activity.tuning(),
      count: events.length,
      events: events.map((e) => ({
        ...e,
        at: new Date(e.ts).toISOString(),
        name: names.get(e.paneid) ?? null,
      })),
    });
    return;
  }

  // URL offers (Owner 2026-08-09): an AGENT submits a URL it wants the USER to
  // open (OAuth flows, dashboards) — deterministic, replacing terminal-text
  // scraping. Correlation = the session's CLAUDE_CODE_SESSION_ID env var vs
  // the table's session_id (same lookup as the hook sink). The window shows
  // an offer bar; offers queue while no window is attached. The `offer-url`
  // skill teaches agents the curl. server-side agents reach this only after the
  // [ref] tailscale bind — until then their skill falls back to printing.
  /* ---- WORKERS: the group-jobs ENGINE PORT (the design notes, ticket) ------
   * Below the global gate on purpose: the shared bearer or an identity
   * principal, never the loopback exemption and not a pane token (a pane token
   * is default-deny, and a worker is a paid, unattended launch — the caller is
   * the group-jobs tool, not an agent pane). */
  if (route.startsWith('/api/fabric/') && route !== '/api/fabric/relay' && auth.hostedProfile()) {
    sendJson(res, 404, { error: 'the fabric is off on a hosted engine' });
    return;
  }
  if ((route === '/api/workers' || route.startsWith('/api/workers/')) && auth.hostedProfile()) {
    sendJson(res, 404, { error: 'headless workers are off on a hosted engine' });
    return;
  }
  if (route === '/api/workers' || route.startsWith('/api/workers/')) {
    const id = route.startsWith('/api/workers/') ? decodeURIComponent(route.slice('/api/workers/'.length)) : null;
    try {
      if (!id && req.method === 'POST') {
        const worker = await workers.launch(await readBody(req));
        sendJson(res, 201, { workerId: worker.id, worker });
      } else if (!id && req.method === 'GET') {
        const jobId = new URL(url, 'http://x').searchParams.get('jobId') ?? undefined;
        sendJson(res, 200, { workers: workers.list(jobId) });
      } else if (id && req.method === 'GET') {
        const w = workers.status(id);
        sendJson(res, w ? 200 : 404, w ? { worker: w } : { error: 'not-found' });
      } else if (id && req.method === 'DELETE') {
        const w = workers.stop(id);
        sendJson(res, w ? 200 : 404, w ? { worker: w } : { error: 'not-found' });
      } else {
        sendJson(res, 405, { error: 'method-not-allowed' });
      }
    } catch (err) {
      if (err instanceof WorkerError) {
        sendJson(res, err.status, err.body());
      } else {
        sendJson(res, errStatus(err), { error: (err as Error).message });
      }
    }
    return;
  }
  /* ---- HANDOFF: discrete labelled items, agent → the user's window ---------
   *
   * Owner, on a phone, 2026-09-04: "an agent just handed me a url, userid and
   * password. press and hold to select doesn't work all the time. dragging
   * selection does weird things when the cli moves inside the pty frame."
   *
   * Selecting text out of a terminal is the wrong primitive for structured
   * data. The link sweep SCRAPES the buffer and can only ever find URLs; this
   * is the opposite direction — the agent SAYS what it is handing over, as
   * labelled fields, and the window renders one copy button per field.
   *
   * SECRETS NEVER TOUCH DISK. Passwords come through here, so items live in
   * memory keyed by paneid, are never written to the table, never logged (not
   * even truncated), and die with the process. That is also why there is no
   * GET: the only way out is the pane's own socket, to a window already
   * attached to that pane.
   *
   * Correlation is the same as /api/url-offer and the hook sink — the session's
   * CLAUDE_CODE_SESSION_ID against the table's session_id — so an agent can
   * only ever reach ITS OWN window and never needs to know a paneid.
   */
  if (route === '/api/handoff' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const sid = typeof b.session_id === 'string' ? b.session_id : null;
      const rawItems = Array.isArray(b.items) ? b.items : [];
      const items: HandoffItem[] = [];
      for (const raw of rawItems.slice(0, 12)) {
        const label = typeof raw?.label === 'string' ? raw.label.trim().slice(0, 60) : '';
        const value = typeof raw?.value === 'string' ? raw.value : '';
        const kind = raw?.kind === 'url' || raw?.kind === 'secret' ? raw.kind : 'text';
        if (!label || !value || value.length > 4000) {
          continue;
        }
        if (kind === 'url' && !/^https?:\/\/\S+$/.test(value)) {
          continue; // a button labelled Open must not be able to run javascript:
        }
        items.push({ label, value, kind });
      }
      if (items.length === 0) {
        sendJson(res, 400, { error: 'items must be [{label, value, kind?}] — 1..12, value <= 4000 chars' });
        return;
      }
      const row = sid
        ? table.list().find((r: any) => r.session_id === sid && r.state === 'live')
        : null;
      if (!row) {
        // Unknown session: a no-op, never an agent-visible error — same
        // contract as /api/url-offer, so the skill's fallback branch is shared.
        sendJson(res, 200, { ok: true, matched: null });
        return;
      }
      const title = typeof b.title === 'string' ? b.title.trim().slice(0, 80) : '';
      const bundle: HandoffBundle = {
        id: randomUUID().slice(0, 8),
        title: title || 'Details from the agent',
        items,
        at: Date.now(),
      };
      const list = liveHandoffs(row.paneid);
      list.push(bundle);
      while (list.length > HANDOFF_MAX) {
        list.shift();
      }
      handoffs.set(row.paneid, list);
      const resident = sessions.get(row.paneid);
      if (resident) {
        broadcast(resident, { type: 'pane.handoff', paneid: row.paneid, bundles: list });
      }
      // The COUNT is loggable; the contents are not, and that is the whole rule.
      log(`handoff → ${row.paneid}: ${items.length} item(s) "${bundle.title}"`);
      sendJson(res, 200, { ok: true, matched: row.paneid, id: bundle.id, pending: list.length });
    } catch {
      sendJson(res, 200, { ok: true, matched: null });
    }
    return;
  }

  /* VOICE CHANNEL (ticket, the design notes) — all logic in voice-routes.ts / engine/voice.ts. */
  if (await voiceRoutes.handle(req, res, route, {
    readBody, sendJson, log,
    toPane: (p, m) => { const r = sessions.get(p); if (r) broadcast(r, m); return r?.viewers.size ?? 0; },
    /* Guard 9 for voice (assemble-room review #3): the same uncached read room-typer
       uses — THROUGH room-typer, so a hand-started claude arms its startup gate
       before startupHold is read (S0 guard 3). */
    claudeState: (p) => roomTyper.claudeStateFresh(p),
    /* S0 guard 3: a spoken line never lands on a startup prompt. */
    startupHold: (p) => (startupGate.isBlocked(p) ? { prompt: startupGate.currentPrompt(p)?.kind ?? null } : null),
    /* Room voice (room-voice §6.3): room routes answer the voice service's named token only. */
    voiceActor: identity.isVoiceActor(principal),
    human: humanCredential(req, principal),
    userKey: pictureOwner(principal).key, // room-voice v3.6: whose voice globals
  })) return;

  /* ---- INBOUND ENVELOPE (Stage 3, engine half) -----------------------------
   *
   * ONE route for what is today three (claude-hook / url-offer / handoff), and
   * the shape is the contract's, not ours: §2's envelope, verbatim, validated
   * field by field so an adapter written against the doc by another brand's
   * agent gets told exactly which field it got wrong.
   *
   * AUTHENTICATED LIKE /api/handoff, AND DELIBERATELY NOT EXEMPT ON LOOPBACK.
   * The hook sink's loopback exemption (auth.isLocalHookDelivery) is safe
   * because that endpoint is write-only and carries no content of its own —
   * though, corrected 2026-09-25, it is no longer only a dot: a Stop releases
   * a pane's held typed delivery, and UserPromptSubmit/Stop disarm its startup
   * gate (see auth.ts). This one DELIVERS CONTENT INTO the user's window — an unauthenticated
   * loopback caller could put any text in front of Owner wearing another agent's
   * name, which is a phishing surface. The 2026-09-04 rule stands: do not grow
   * the exemption.
   *
   * ADDRESSED BY SLUG, never by paneid. That is the whole point of E1: a sender
   * knows `kiosk-cli`, has no idea what a pane is, and must not need one.
   */
  if (route === '/api/fabric/inbound' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const v = fabric.validate(b);
      if (!v.ok) {
        sendJson(res, 400, { error: v.error, field: v.field });
        return;
      }
      /* THE SAME DELIVERY FUNCTION THE SUBSCRIBER USES (engine/fabric.ts). This
         route is the PUSH door and fabric-subscriber.ts is the PULL door; slug
         resolution, the pending queue, the flush and the log line are behind
         both, because two doors with their own copy of the rules is how this
         engine grew three ad-hoc sinks in the first place.
         BOTH failure shapes are a 404: "we know who you mean and nobody is
         there" and "@all is not ours to route" are the same answer to a sender,
         and a silent 200 is how offer-url went unnoticed for weeks. */
      const out = fabric.deliver(v.envelope);
      if (!out.ok) {
        sendJson(res, 404, { error: out.error });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        delivered: out.delivered,
        queued: out.queued,
        paneid: out.paneid,
        pending: out.pending,
      });
    } catch (err) {
      sendJson(res, errStatus(err), { error: (err as Error).message });
    }
    return;
  }

  /* ---- RESTORE FOR A MESSAGE (ticket) — the fabric's `delivery:'restore'`.
   * Same auth class as /api/fabric/inbound (the bearer, or the restore-scoped
   * token answered above the gate), and NOT loopback-exempt: it starts a
   * process. All logic in fabric-restore.ts. */
  if (route === '/api/fabric/restore' && req.method === 'POST') {
    await handleFabricRestore(req, res);
    return;
  }

  /* ---- OUTBOUND SEND (F1, interim, contract §2, engine-proxied) -----------
   *
   * `/api/fabric/inbound` above is how a message reaches THIS engine's own
   * pane; this is the other direction — a pane asking to SEND one, proxied
   * through the engine rather than dialling the fabric itself, because the
   * fabric's `checkin`/`bind` (which would hand identity back instead of
   * having it declared) do not exist yet. Interim until check-in ships.
   *
   * THE ENGINE STAMPS `from`, NEVER THE CALLER — same rule as rooms.ts's
   * `authorFor`/`fromRow` for a room line's author, arrived at independently
   * here for the same reason: a caller-supplied sender is a caller who could
   * wear another agent's name. `from` resolves to THIS engine's own live
   * session row (by paneid, or by session_id against the table — the same
   * correlation /api/handoff and /api/fabric/inbound already use) and the row
   * must be LIVE and carry a non-empty `agent` slug, the fabric's join key
   * (§1). Anything else is 403 `from-unbound`, never downgraded to some other
   * sender.
   *
   * AUTHENTICATED LIKE EVERY ROUTE BELOW THE GATE, DELIBERATELY NOT EXEMPT ON
   * LOOPBACK — the same 2026-09-04/2026-09-17 rule /api/fabric/inbound and
   * /api/rooms* state for themselves: this route can put words in the
   * fabric's mouth on a named agent's behalf, so a loopback caller must still
   * present the bearer.
   *
   * The engine's OWN bearer goes out on the wire (auth.bearerToken(), the
   * SAME token fabric-subscriber.ts presents — "no third credential", brief
   * §3) — never a caller-supplied one, and never logged.
   *
   * A FABRIC OUTAGE MUST NEVER BECOME AN ENGINE OUTAGE (fabric-subscriber.ts's
   * own rule, restated here for the push side): a disabled fabric is a 503; a
   * network error or timeout (~5s) is a 502; everything else the fabric
   * itself answers is passed through UNCHANGED — this route reinterprets
   * nothing the fabric said. Every branch is caught locally.
   */
  if (route === '/api/fabric/send' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const sender = resolveFabricSender(b.from);
      if (!sender.ok) {
        sendJson(res, 403, { error: 'from-unbound', field: 'from', reason: sender.reason });
        return;
      }
      await fabricSendAs(res, sender.row, b);
    } catch (err) {
      sendJson(res, errStatus(err), { error: (err as Error).message });
    }
    return;
  }

  /* ASSEMBLE ROOM readiness (the design notes §4.1): the Seat modal's
     candidate list and the roster's fast fields. Read-only; logic in readiness.ts. */
  if (route === '/api/sessions/readiness' && req.method === 'GET') {
    try {
      const q = new URL(url, 'http://x').searchParams;
      const raw = q.get('paneids');
      const r = await readiness(
        { paneids: raw === null ? null : raw.split(',').map((x) => x.trim()).filter(Boolean), roomId: q.get('room') || null },
        {
          projector: async () => { const c = await projectionContext(); return (row) => projectRow(row, c); },
          human: humanCredential(req, principal),
          targetOf: (row) => targetOfRow(row),
          claudeOwnsTerminal: (paneid) => {
            const o = paneClaudeOwner(paneid, true);
            return o === null ? null : procClassifier.isOwner(o);
          },
        },
      );
      sendJson(res, r.status, r.body);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  /* PROJECT CHANNEL (the design notes) — all logic in projects.ts. Below the auth and
     forced-change gates; NO loopback exemption (it is not the hook sink). */
  if (await projects.handle(req, res, route, { log, human: humanCredential(req, principal), principal })) return;
  if (await libraryProxy.handle(req, res, route)) return; // the asset picker's library reads [asset picker]

  /* WORKROOMS (ticket, the design notes §2) — all logic in rooms.ts. BELOW the auth and
     forced-change gates by design (§2.4, trap 12); no loopback exemption (trap 14). */
  if (await chatterRoutes.handle(req, res, route, { human: humanCredential(req, principal), log })) return;
  /* [concierge] settings, status, the seen cursor; the read scope is 403 here (pane token only) */
  if (await conciergeRoutes.handle(req, res, route, {
    human: humanCredential(req, principal),
    person: unforgeablePerson(req, principal),
    log,
    paneTokensOn: paneTokens.enabled(),
    recipe: (id) => table.getRecipe(id) as any,
    isLive: (paneid) => table.get(paneid)?.state === 'live', // the broker holds it: running, whether or not a window is attached
    userKey: pictureOwner(principal).key,
  })) return;
  /* [basic] /api/commands, New site, the room's site bar — ABOVE rooms.handle (basic.ts) */
  if (await basicRoutes.handle(req, res, route, {
    projector: async () => { const c = await projectionContext(); return (r) => projectRow(r, c); },
    human: humanCredential(req, principal),
    log,
    ...roomStartDeps,
  })) return;
  if (await rooms.handle(req, res, route, principal, {
    projector: async () => { const c = await projectionContext(); return (r) => projectRow(r, c); },
    log,
    human: humanCredential(req, principal),
    ...roomStartDeps,
  })) return;

  if (route === '/api/url-offer' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const url = typeof b.url === 'string' ? b.url.trim() : '';
      const sid = typeof b.session_id === 'string' ? b.session_id : null;
      if (!/^https?:\/\/\S{1,2000}$/.test(url)) {
        sendJson(res, 400, { error: 'url must be http(s) and sane-length' });
        return;
      }
      const row = sid ? table.list().find((r: any) => r.session_id === sid && r.state === 'live') : null;
      if (!row) {
        sendJson(res, 200, { ok: true, matched: null }); // unknown session — noop, never an agent-visible error
        return;
      }
      const list = urlOffers.get(row.paneid) ?? [];
      if (!list.includes(url)) {
        list.push(url);
        while (list.length > 10) {
          list.shift();
        }
      }
      urlOffers.set(row.paneid, list);
      const resident = sessions.get(row.paneid);
      if (resident) {
        broadcast(resident, { type: 'pane.url-offer', paneid: row.paneid, urls: [...list] });
      }
      sendJson(res, 200, { ok: true, matched: row.paneid, pending: list.length });
    } catch {
      sendJson(res, 200, { ok: true, matched: null });
    }
    return;
  }

  /* Agent hook sink (2026-10-03, Codex vendor): the vendor-neutral twin of the
     claude sink below, keyed by pane id (engine/agent-hook.ts). Hooks never see
     an error, same as claude's. */
  if (route === '/api/agent-hook' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const qs = new URL(req.url ?? '/', 'http://x').searchParams;
      const r = handleAgentHook({ vendor: qs.get('vendor'), paneid: qs.get('paneid') }, b, {
        get: (id) => table.get(id),
        adoptSessionId: (id, sid) => table.adoptSessionId(id, sid),
        activity,
        log,
        chat: {
          record: (id, role, text) => agentChat.recordHookTurn(id, role, text),
          gap: (id, ev) => agentChat.noteHookGap(id, ev),
        },
      });
      sendJson(res, 200, { ok: true, matched: r.matched });
    } catch {
      sendJson(res, 200, { ok: true, matched: null });
    }
    return;
  }

  // Claude hook sink (vk [ref]): user-level Notification/Stop/UserPromptSubmit hooks POST their
  // stdin JSON here. session_id (the transcript uuid) → paneid via the table;
  // unmatched sessions (hand-launched CLIs, other hosts) are fine — 200 + noop.
  if (route === '/api/claude-hook' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const sid = typeof b.session_id === 'string' ? b.session_id : null;
      const event = typeof b.hook_event_name === 'string' ? b.hook_event_name : '';
      /* A tool hook for a NON-MCP tool is answered before the table is read:
         the proposed hooks match mcp__.* only, but a wider matcher must not
         cost a table scan per Bash call (ticket). */
      if (mcpCalls.isIgnorableToolHook(event, b.tool_name)) {
        sendJson(res, 200, { ok: true, matched: null });
        return;
      }
      const row = sid ? table.list().find((r: any) => r.session_id === sid && r.state === 'live') : null;
      if (row) {
        /* ticket/1886: the prompt-block answer moves FIRST, so the activity
           update below settles on the right state (Stop/UserPromptSubmit
           clear a block; a non-idle Notification raises one). */
        promptBlock.onHook(row.paneid, event, typeof b.notification_type === 'string' ? b.notification_type : undefined);
        if (event === 'Notification') {
          /* Claude Code's idle nag (notification_type 'idle_prompt', ~60 s after
             a turn ends) is NOT a question: the REPL is idle at its composer.
             Treating it as one parked every quiet agent in 'waiting', and typed
             room delivery waits for 'idle', so room lines queued forever until
             something else made the agent take a turn (2026-09-26). Permission
             prompts and other notification types still mean "needs you".
             `auth_success` ("Claude Code login successful", CC 2.1.285) is
             the opposite of an ask: it CLEARS a login block (prompt-block). */
          if (b.notification_type !== 'idle_prompt' && b.notification_type !== 'auth_success') {
            activity.onQuestion(row.paneid);
          }
        } else if (event === 'UserPromptSubmit') {
          // v21 turn signal: busy runs from here to Stop (see activity.ts)
          activity.onTurnStart(row.paneid);
        } else if (event === 'Stop') {
          activity.onResponseDone(row.paneid);
        }
        /* S0 startup block: a turn hook (UserPromptSubmit / Stop) is positive
           evidence the REPL is past its startup prompts (startup-gate.ts).
           AFTER the activity update, so the retry it triggers sees the turn. */
        startupGate.onHook(row.paneid, event);
        /* MCP indicator (ticket): Pre/PostToolUse, PostToolUseFailure and
           PermissionDenied for mcp__ tools start/end a call; Stop and
           SubagentStop end the calls they strand. Reads ids and ONE boolean
           (tool_response.isError) - never tool input or output. */
        mcpCalls.onHook(row.paneid, b);
      }
      sendJson(res, 200, { ok: true, matched: row?.paneid ?? null });
    } catch {
      sendJson(res, 200, { ok: true, matched: null }); // hooks must never see errors
    }
    return;
  }

  /* DELIVER HELD (2026-09-25): a HUMAN at a window says "I have looked at this
   * pane's composer — it is clear". The draft guard counts keys and can lose
   * track (a cursor move, history recall), and a pane classified `draft` holds
   * its typed room lines and fabric envelopes until the next submit. This
   * clears the draft classification on the human's word and types the head of
   * the pane's queue now if every OTHER guard holds (live, claude-code, past
   * startup, idle, not busy); otherwise it answers why not (`held`).
   * COOKIE CREDENTIAL ONLY (humanCredential): the agent whose pane this is must
   * never be able to declare its own composer clear.
   *
   * GUARD 4 (assemble-room §4.4 item 4): it also releases the STARTUP block
   * ("nothing showing") — at once when no prompt is current, else 409
   * {prompt, promptAt}; a second call with {override: <that kind>} releases
   * it. It NEVER releases `no-claude` (guard 9: a line typed into bash runs
   * there) — 409 with that reason, read uncached like the write path. Every
   * 200 names what it overrode. (`restarting` joins no-claude with S2.) */
  const deliverHeldMatch = /^\/api\/panes\/([^/]+)\/deliver-held$/.exec(route);
  if (deliverHeldMatch && req.method === 'POST') {
    if (!humanCredential(req, principal)) {
      sendJson(res, 403, {
        error: 'human-only: a person asserts the composer is clear — send it from the window (cookie), not with a bearer',
        field: 'credential',
      });
      return;
    }
    let paneid = '';
    try {
      paneid = decodeURIComponent(deliverHeldMatch[1]);
    } catch {
      sendJson(res, 400, { error: 'paneid is not valid URI encoding', field: 'paneid' });
      return;
    }
    if (!sessions.isLive(sessions.get(paneid))) {
      sendJson(res, 404, { error: `no live pane ${paneid}`, field: 'paneid' });
      return;
    }
    let b: Record<string, unknown>;
    try {
      b = (await readBody(req)) ?? {};
    } catch (err) {
      sendJson(res, errStatus(err), { error: (err as Error).message, field: 'body' });
      return;
    }
    const override = b.override;
    if (override !== undefined && override !== null && typeof override !== 'string') {
      sendJson(res, 400, { error: 'override is the prompt kind a 409 named', field: 'override' });
      return;
    }
    const d = roomTyper.deliverHeld(paneid, override ?? null);
    if (!d.ok) {
      const error =
        d.reason === 'no-claude'
          ? d.detail === 'not-interactive'
            ? 'a claude is running here but not as its interactive session — a typed line would reach its shell; start claude itself (fg, or type claude), or Restore'
            : 'claude is not running in this pane — a typed line would run in its shell; start claude (fg, or type claude), or Restore'
          : override
            ? `the prompt the engine saw is ${d.prompt}, not ${override}`
            : d.prompt === 'unknown'
              ? 'this claude started where the engine could not watch its first screen — deliver only if the window shows its input box'
              : `a ${d.prompt} prompt was seen — deliver only if the window shows its input box`;
      log(`deliver-held ${paneid}: refused (${d.reason}${d.reason === 'startup' ? `: ${d.prompt}` : ''})`);
      sendJson(res, 409, { error, ...d, held: roomTyper.heldFor(paneid) });
      return;
    }
    log(`deliver-held ${paneid}: ${d.overrode.join('+') || 'nothing held'} waived on a human's word${d.prompt ? ` (over a ${d.prompt} prompt)` : ''} → ${d.result}`);
    sendJson(res, 200, { ok: true, paneid, result: d.result, held: roomTyper.heldFor(paneid), overrode: d.overrode, prompt: d.prompt });
    return;
  }

  /* AGENT CHAT [agent chat] (Owner 2026-10-05): a session's conversation as
     chat, an answer typed through the room typer, and the session's own
     Scratchpad. Engine half in engine/agent-chat.ts; the usual credential gate
     above applies (a person's cookie or the shared bearer; no pane-token writes).
       GET  /api/sessions/:paneid/chat?before=&after=&limit=
       POST /api/sessions/:paneid/chat {text, files?:[name]}
       GET|POST /api/sessions/:paneid/scratchpad   (POST = raw bytes, x-filename)
       GET  /api/sessions/:paneid/scratchpad/raw/<name> */
  const chatMatch = /^\/api\/sessions\/([^/]+)\/(chat|scratchpad|chat\/search)(?:\/raw\/([^/]+))?$/.exec(route);
  if (chatMatch) {
    let paneid: string;
    let rawName: string | undefined;
    try {
      paneid = decodeURIComponent(chatMatch[1]);
      rawName = chatMatch[3] === undefined ? undefined : decodeURIComponent(chatMatch[3]);
    } catch {
      sendJson(res, 400, { error: 'the path is not valid URI encoding', field: 'path' });
      return;
    }
    const reply = (r: agentChat.Result) => sendJson(res, r.status, r.body);
    try {
      const method = req.method ?? 'GET';
      if (chatMatch[2] === 'chat/search' && method === 'GET') {
        reply(await agentChat.chatSearch(paneid, new URL(req.url ?? '/', 'http://x').searchParams, chatDeps));
        return;
      }
      if (chatMatch[2] === 'chat' && method === 'GET') {
        const r = await agentChat.chatGet(paneid, new URL(req.url ?? '/', 'http://x').searchParams, chatDeps);
        /* [concierge] its replies are READ, never posted: wb: links are validated as the page is served */
        if (r.status === 200 && concierge.isConciergePane(paneid) && Array.isArray((r.body as any)?.items)) {
          (r.body as any).items = concierge.withLinks((r.body as any).items, conciergeLinkDeps);
        }
        reply(r);
        return;
      }
      if (chatMatch[2] === 'chat' && method === 'POST') {
        const body = (await readBody(req)) ?? {};
        if (body.via !== undefined && body.via !== null && (body.via !== 'voice' || !humanCredential(req, principal))) {
          sendJson(res, body.via === 'voice' ? 403 : 400, { error: body.via === 'voice' ? 'only a person speaks a line (via voice needs a window cookie)' : 'via is "voice" or absent', field: 'via' });
          return;
        }
        reply(await agentChat.chatSend(paneid, body, chatDeps));
        return;
      }
      if (chatMatch[2] === 'scratchpad' && rawName === undefined && method === 'GET') {
        reply(await agentChat.scratchList(paneid, chatDeps));
        return;
      }
      if (chatMatch[2] === 'scratchpad' && rawName === undefined && method === 'POST') {
        const hn = req.headers['x-filename'];
        const bytes = await rooms.readRaw(req); // same 25 MB cap, 413 with both numbers
        let name: string | null = null;
        if (typeof hn === 'string') {
          try {
            name = decodeURIComponent(hn);
          } catch {
            name = hn;
          }
        }
        reply(await agentChat.scratchUpload(paneid, name, String(req.headers['content-type'] ?? ''), bytes, chatDeps));
        return;
      }
      if (chatMatch[2] === 'scratchpad' && rawName !== undefined && (method === 'GET' || method === 'HEAD')) {
        const got = agentChat.scratchRawRef(paneid, rawName, chatDeps);
        if (!('ref' in got)) {
          reply(got);
          return;
        }
        let up: Response;
        try {
          up = await agentShare.fetchRaw(got.ref, method);
        } catch (e) {
          if (e instanceof agentShare.ShareNotConfigured) {
            sendJson(res, 503, { error: e.message, field: 'file-store' });
            return;
          }
          throw e;
        }
        if (up.status === 404) {
          sendJson(res, 404, { error: 'no such file in this Scratchpad', field: 'name' });
          return;
        }
        if (!up.ok) {
          sendJson(res, 502, { error: `agent-share answered ${up.status}`, field: 'agent-share' });
          return;
        }
        /* Same safety as the room assets raw route: uploaded HTML/SVG is served
           from the engine's origin, so it is sandboxed and never sniffed. */
        const served = safeServeType(up.headers.get('content-type') ?? agentShare.typeOf(rawName)); // M5
        const headers: Record<string, string> = {
          'content-type': served.type,
          'cache-control': 'private, max-age=60',
          'x-content-type-options': 'nosniff',
          'content-security-policy': 'sandbox',
          'referrer-policy': 'no-referrer',
          'content-disposition': `${served.attachment || /^attachment/i.test(up.headers.get('content-disposition') ?? '') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(rawName)}`,
        };
        const len = up.headers.get('content-length');
        if (len) {
          headers['content-length'] = len;
        }
        res.writeHead(200, headers);
        if (method === 'HEAD' || !up.body) {
          res.end();
          return;
        }
        const body = Readable.fromWeb(up.body as any);
        body.on('error', () => res.destroy());
        res.on('close', () => body.destroy());
        body.pipe(res);
        return;
      }
      sendJson(res, 405, { error: `${method} is not supported on ${route}` });
    } catch (e) {
      sendJson(res, errStatus(e), { error: (e as Error).message });
    }
    return;
  }

  // Peek a live session's recent output WITHOUT attaching (live-strip "Peek"):
  // identifies a windowless/ghost pane — forgotten shell vs server vs agent —
  // from the resident replay buffer. Read-only; the session never notices.
  if (route.startsWith('/api/sessions/') && route.endsWith('/peek') && req.method === 'GET') {
    const paneid = decodeURIComponent(route.slice('/api/sessions/'.length, -'/peek'.length));
    const resident = sessions.get(paneid);
    if (sessions.isLive(resident)) {
      const tail = sessions.replay(resident).slice(-8192);
      sendJson(res, 200, { ok: true, paneid, tail });
    } else {
      sendJson(res, 404, { error: `no live session for ${paneid}` });
    }
    return;
  }

  // End a live session from the manager (the live-strip ✕ — no window may
  // exist to do it from). Kill flows through the normal onExit teardown.
  if (route.startsWith('/api/sessions/') && route.endsWith('/end') && req.method === 'POST') {
    const paneid = decodeURIComponent(route.slice('/api/sessions/'.length, -'/end'.length));
    const resident = sessions.get(paneid);
    if (sessions.isLive(resident)) {
      resident.endReason = 'user'; // the user ended it: no exit verdict, never auto-resumes
      killCli(resident.cli);
      sendJson(res, 200, { ok: true, ended: paneid });
    } else {
      sendJson(res, 404, { error: `no live session for ${paneid}` });
    }
    return;
  }

  /* PATCH /api/sessions/:paneid/profile {model?, effort?} — set an agent's stored
     {model, effort} (Owner 2026-10-02, room line [ref]). '' clears to claude's
     own default; an absent key keeps its value (a row with no profile yet fills
     the other half from its recipe's current default). Takes effect on the NEXT
     launch / reconnect: a running claude is not changed. Person cookie only. */
  const profileMatch = /^\/api\/sessions\/([^/]+)\/profile$/.exec(route);
  if (profileMatch && req.method === 'PATCH') {
    if (!humanCredential(req, principal)) {
      sendJson(res, 403, { error: 'a person changes an agent\'s model and effort: send it from a window (cookie), not a bearer', field: 'credential' });
      return;
    }
    try {
      const paneid = decodeURIComponent(profileMatch[1]);
      const row = table.get(paneid);
      if (!row) {
        sendJson(res, 404, { error: `no session ${paneid}`, field: 'paneid' });
        return;
      }
      const b = await readBody(req);
      for (const k of ['model', 'effort'] as const) {
        if (b[k] !== undefined && b[k] !== null && b[k] !== '' && !(k === 'model' ? isModelName(b[k]) : isEffortFor(row.vendor, b[k]))) {
          sendJson(res, 400, k === 'model'
            ? { error: 'model is a model name (letters, digits, . _ -)', field: 'model' }
            : { error: `effort is one of ${effortsFor(row.vendor).join(', ')}`, field: 'effort', allowed: effortsFor(row.vendor) });
          return;
        }
      }
      const recipe = row.recipe_id ? table.getRecipe(row.recipe_id) : undefined;
      const cur = table.profileOf(row) ?? { model: recipe?.model ?? null, effort: recipe?.effort ?? null };
      const pick = (v: unknown, keep: string | null) => (v === undefined ? keep : v === null || v === '' ? null : String(v));
      table.setProfile(paneid, { model: pick(b.model, cur.model), effort: pick(b.effort, cur.effort) });
      const profile = table.profileOf(table.get(paneid));
      log(`profile ${paneid}: model=${profile?.model ?? 'default'} effort=${profile?.effort ?? 'default'} (applies on its next launch)`);
      sendJson(res, 200, { ok: true, paneid, profile });
    } catch (err) {
      sendJson(res, errStatus(err), { error: (err as Error).message });
    }
    return;
  }

  /* POST /api/sessions/:paneid/cleared/dismiss — the person says "I know" to the
     "cleared in its CLI" warning (Owner 2026-10-03). Person cookie only; the same /clear is not flagged again. */
  const clearedMatch = /^\/api\/sessions\/([^/]+)\/cleared\/dismiss$/.exec(route);
  if (clearedMatch && req.method === 'POST') {
    if (!humanCredential(req, principal)) {
      sendJson(res, 403, { error: 'a person dismisses this warning: send it from a window (cookie), not a bearer', field: 'credential' });
      return;
    }
    const paneid = decodeURIComponent(clearedMatch[1]);
    if (!table.get(paneid)) {
      sendJson(res, 404, { error: `no session ${paneid}`, field: 'paneid' });
      return;
    }
    table.dismissCleared(paneid);
    sendJson(res, 200, { ok: true, paneid, cleared_at: null });
    return;
  }

  // Dismiss the "restore interrupted sessions?" offer (manager banner).
  if (route === '/api/interrupted/dismiss' && req.method === 'POST') {
    const cleared = table.clearInterrupted();
    log(`interrupted-session offer dismissed (${cleared} stamp(s) cleared)`);
    sendJson(res, 200, { ok: true, cleared });
    return;
  }

  if (route === '/api/recipes' && req.method === 'GET') {
    /* ART WINS on the way out, not in the table. The manager tints its cards
       from this, so resolving here is what makes a project's VRPC and server
       recipes read as ONE project — while the stored column stays untouched for
       a rollback and for the Project migration to pick up. */
    const art = () => table.listLogos() as ArtRow[];
    sendJsonCached(req, res, 200, { // ETag + gzip [perf/poll-traffic]
      recipes: (table.listRecipes() as any[]).map((r) => {
        const fromArt = artColor(r.logo, art);
        return {
          ...r,
          color: fromArt ?? r.color,
          /* WHERE THE COLOR CAME FROM, so the form can say so instead of
             offering an edit that another surface would overwrite. A page
             cannot work this out for itself without fetching the whole logo
             library and re-deriving the rule — two copies of one decision,
             which is how the two status glyphs drifted apart in 2026-09-01. */
          colorFrom: fromArt ? 'art' : 'recipe',
          /* AUTO-APPROVE: what the recipe says and what it resolves to now (the default is off until the first-run choice) */
          autoApproveEffective: effectiveAutoApprove(r.autoApprove, readState(table.getEngineSetting('autoApprove')).default),
          autoApproveSource: autoApproveSource(r.autoApprove),
        };
      }),
    });
    return;
  }

  if (route === '/api/recipes' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      if (!b.name || typeof b.name !== 'string' || !b.target || typeof b.target !== 'string') {
        sendJson(res, 400, { error: 'name and target are required' });
        return;
      }
      /* REFUSE AN UNKNOWN VENDOR, NEVER COERCE ONE (contract v0.3 §1.1,
         finding #1). Until 2026-09-17 an unrecognised value fell through to
         `runClaude`, which is absent on a new recipe — so `vendor: "gemini"`
         (the almost-right spelling) saved as `claude-code` and spawned CLAUDE
         at you, with no error anywhere. A silent coercion between BRANDS is not
         a lenient default, it is a wrong answer: the recipe looks saved, the
         window opens, and the thing inside it is a different product.
         `undefined` is still fine — that is an older client that only knows
         `runClaude`, and the store derives the value for it. */
      if (b.vendor !== undefined && !isRecipeVendor(b.vendor)) {
        sendJson(res, 400, {
          error: `unknown vendor: ${JSON.stringify(b.vendor)}`,
          field: 'vendor',
          allowed: RECIPE_VENDORS,
        });
        return;
      }
      /* M6: the SVG inside a recipe's logo JSON goes through the same allow-list sanitizer as an uploaded logo (a refusal is a 400, never a silent pass) */
      let logoJsonClean: string | null = typeof b.logo === 'string' && b.logo ? b.logo : null;
      if (logoJsonClean) {
        try {
          const o = JSON.parse(logoJsonClean);
          if (o && typeof o.svg === 'string') {
            const cs = sanitizeSvg(o.svg);
            if (cs === null) {
              sendJson(res, 400, { error: 'that logo is not an SVG the engine will store', field: 'logo', code: 'svg-rejected' });
              return;
            }
            logoJsonClean = JSON.stringify({ ...o, svg: cs });
          }
        } catch {
          /* not our JSON: passed through untouched as before */
        }
      }
      /* AUTO-APPROVE (security review H1): follow | on | off. `on` needs a PERSON and the recorded first-run disclosure; absent keeps the stored value (new recipes: follow). */
      if (b.autoApprove !== undefined && !isAutoApproveSetting(b.autoApprove)) {
        sendJson(res, 400, { error: `unknown autoApprove: ${JSON.stringify(b.autoApprove)}`, field: 'autoApprove', allowed: ['follow', 'on', 'off'] });
        return;
      }
      if (b.autoApprove === 'on') {
        if (!humanCredential(req, principal)) {
          sendJson(res, 403, { error: 'person_only', field: 'autoApprove', message: 'only the signed-in person turns auto-approve on for a recipe' });
          return;
        }
        const st = readState(table.getEngineSetting('autoApprove'));
        if (st.disclosedAt === null && b.disclosed !== true) {
          sendJson(res, 400, { error: 'disclosure-required', field: 'autoApprove', message: 'show the auto-approve disclosure first and send disclosed: true' });
          return;
        }
        if (st.disclosedAt === null) {
          table.setEngineSetting('autoApprove', { ...st, disclosedAt: Date.now() });
        }
      }
      /* EFFORT: refused when unknown, the vendor rule (claude only WARNS and
         ignores an unknown --effort, so saving one would be a setting that
         silently does nothing). null / '' clear it; ABSENT keeps what is
         stored, because upsertRecipe is a full replace and a client that
         predates the field must not wipe it on every save. */
      const effortVendor: string = b.vendor
        ? (b.vendor as string)
        : b.runClaude === false || b.runClaude === 0
          ? 'cli-manager'
          : 'claude-code';
      if (b.effort !== undefined && b.effort !== null && b.effort !== '' && !isEffortFor(effortVendor, b.effort)) {
        sendJson(res, 400, {
          error: `unknown effort: ${JSON.stringify(b.effort)}`,
          field: 'effort',
          allowed: effortsFor(effortVendor),
        });
        return;
      }
      /* vendorArgs: strings only, one line each (engine/vendor-args.ts). ABSENT
         keeps what is stored (full-replace upsert, older clients); null / ''
         clear it. */
      const vArgs = parseVendorArgs(b.vendorArgs);
      if (!vArgs.ok) {
        sendJson(res, 400, { error: vArgs.error, field: 'vendorArgs' });
        return;
      }
      const rid = typeof b.id === 'string' && b.id ? b.id : randomUUID();
      /* VENDOR IS THE FIELD NOW (Stage 2); `runClaude` is what an older
         client sends and is accepted unchanged. The store derives whichever
         one was not sent, so this route never has to decide twice. An unknown
         value never reaches here — it was refused above. Hoisted because the
         slug below depends on it (wr §2.9: only a brand vendor derives one). */
      const recipeVendor: string = b.vendor
        ? (b.vendor as string)
        : b.runClaude === false || b.runClaude === 0
          ? 'cli-manager'
          : 'claude-code';
      /* vendorFlags: known checkbox ids only (engine/vendor-flags.ts); ABSENT keeps the stored
         set, null / [] clear it. */
      const vFlags = parseVendorFlags(b.vendorFlags, recipeVendor);
      if (!vFlags.ok) {
        sendJson(res, 400, { error: vFlags.error, field: 'vendorFlags' });
        return;
      }
      const recipe = table.upsertRecipe({
        id: rid,
        /* PRESERVE, don't default. upsertRecipe is a full replace and the
           manager form does not send this field, so defaulting to 0 here would
           silently clear the flag every time the user edited a name or colour. */
        closeOnCleanExit:
          typeof b.closeOnCleanExit === 'number'
            ? b.closeOnCleanExit
            : (table.getRecipe(rid)?.closeOnCleanExit ?? 0),
        statusPath:
          typeof b.statusPath === 'string' || b.statusPath === null
            ? b.statusPath
            : (table.getRecipe(rid)?.statusPath ?? null),
        name: b.name,
        target: b.target,
        /* AUTO-FIXED, not rejected. A trailing slash has exactly one correct
           answer, so asking the user about it would be theatre -- and leaving
           it cost Kiosk its name for days (2026-09-13). */
        projectDir: b.projectDir ? normalizeProjectDir(String(b.projectDir)) || null : null,
        vendor: recipeVendor,
        runClaude: b.runClaude === false || b.runClaude === 0 ? 0 : 1,
        /* THE SLUG (E1). Empty means DERIVE for a BRAND vendor, and NO
           identity for a bare shell (wr §2.9 — a terminal is not a member of
           anything; `/srv/code` deriving `code` named no project at all).
           A typed slug is kept for any vendor: that is the escape hatch for a
           tool that needs addressing. Normalised on the way in for the same
           reason projectDir is — there is exactly one right answer for
           "Briefing Table" and nothing for a user to decide about it. */
        agent: resolveSlug(b.agent, {
          projectDir: b.projectDir ? String(b.projectDir) : null,
          name: typeof b.name === 'string' ? b.name : null,
          vendor: recipeVendor,
        }),
        model: b.model || null,
        effort: b.effort === undefined ? (table.getRecipe(rid)?.effort ?? null) : b.effort || null,
        vendorArgs: b.vendorArgs === undefined ? (table.getRecipe(rid)?.vendorArgs ?? null) : vArgs.args,
        vendorFlags: b.vendorFlags === undefined ? (table.getRecipe(rid)?.vendorFlags ?? null) : vFlags.flags,
        /* 'auto' | 'never'; absent keeps the stored value (the store COALESCEs). */
        worktree: b.worktree === 'never' ? 'never' : b.worktree === 'auto' ? 'auto' : null,
        autoApprove: isAutoApproveSetting(b.autoApprove) ? b.autoApprove : null,
        resume: b.resume === true || b.resume === 1 ? 1 : 0,
        resumeName: b.resumeName || null,
        initCmd: typeof b.initCmd === 'string' && b.initCmd.trim() ? b.initCmd.trim() : null,
        color: b.color || null,
        fg: b.fg || null,
        bg: b.bg || null,
        watermark: b.watermark || null,
        fontSize: typeof b.fontSize === 'number' ? b.fontSize : null,
        /* stamped so the shell can resolve a mark — see stampLogoKey */
        logo: typeof b.logo === 'string' && b.logo ? (stampLogoKey(logoJsonClean!) as string) : null,
      });
      log(`recipe saved: "${recipe.name}" (${recipe.id}) target=${recipe.target}`);
      /* ...AND REACHES THE PROJECT'S OPEN WINDOWS. Name, colour, logo and text
         size are edited HERE now (v21 ruling moved them off the session bar),
         so a save that only changed the recipe would leave every live window
         wearing the old identity until it respawned - and would revert on
         reattach, because pane.ready serves the pane ROW. Persist to each row,
         then push; the same loop the window write-back uses. `logo: ''` is the
         clear sentinel (setPrefs COALESCE keeps a channel on null). */
      for (const sib of table.sessionsForRecipe(recipe.id)) {
        const sibPrefs = table.setPrefs(sib.paneid, {
          friendlyName: recipe.name,
          color: recipe.color ?? undefined,
          fontSize: recipe.fontSize ?? undefined,
          logo: recipe.logo ?? '',
        });
        const r = sessions.get(sib.paneid);
        if (r) {
          broadcast(r, { type: 'pane.prefs', paneid: sib.paneid, prefs: sibPrefs });
        }
      }
      /* VERIFY BY LOOKUP, and never refuse. A path can be legitimately absent --
         a repo about to be cloned, a host asleep -- so a missing dir is a WARNING
         returned beside the saved recipe, not a rejected save. The failure this
         guards against is silence: a wrong path produced an empty transcript
         listing and no error anywhere. */
      let dirWarning: string | undefined;
      if (recipe.projectDir) {
        const tgt = loadTargets().find((tt) => tt.id === recipe.target);
        /* SELF-HOSTED POLARITY (2026-09-17): the old ternary checked the LOCAL
           filesystem for anything that wasn't `kind:'ssh'` — which for a
           foreign-broker `kind:'local'` target (e.g. the server engine's own
           "local" target, broker vrpc) meant checking the server's disk for a
           path meant for the VRPC ("no such directory on this PC: C:/tmp").
           `remoteFsAccess` never lets that happen: unreachable means say so,
           not guess. */
        const access = remoteFsAccess(tgt);
        let check: Awaited<ReturnType<typeof checkProjectDir>>;
        if (access.mode === 'unreachable') {
          check = { exists: null, warning: access.reason };
          log(`recipe "${recipe.name}": ${access.reason}`);
        } else {
          check = await checkProjectDir(recipe.projectDir, fsOptsFor(access));
          if (check.exists === false) {
            log(`recipe "${recipe.name}": ${check.warning}`);
          }
        }
        dirWarning = check.warning;
      }
      sendJson(res, 200, { recipe, ...(dirWarning ? { warning: dirWarning } : {}) });
    } catch (err) {
      sendJson(res, errStatus(err), { error: (err as Error).message });
    }
    return;
  }

  /* ONE ART, BY KEY [perf/poll-traffic]: what a `?art=ref` room view leaves
     out (art_render.svg). {key, name, svg, style, hash}. The page asks with
     `?h=<hash>` from the view; when that is the current hash the answer can
     never change (a re-arted set gets a new hash, hence a new URL), so it is
     cached for a year. Any other ask is revalidated by ETag. 404 = the key
     names nothing (a deleted set, an unknown preset). */
  const artMatch = route.match(/^\/api\/art\/([^/]+)$/);
  if (artMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    let key = '';
    try {
      key = decodeURIComponent(artMatch[1]);
    } catch {
      /* bad escape: no such key */
    }
    const art = key ? resolveArt(key, () => table.listLogos()) : null;
    if (!art) {
      sendJson(res, 404, { error: 'no art by that key', field: 'key' });
      return;
    }
    const h = new URLSearchParams(url.split('?')[1] ?? '').get('h');
    sendJsonCached(req, res, 200, art, {
      etag: `"art-${art.hash}"`,
      cacheControl: h === art.hash ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    });
    return;
  }

  // Reusable SVG-logo library (named logos recallable from any window's picker).
  if (route === '/api/logos' && req.method === 'GET') {
    sendJson(res, 200, { logos: table.listLogos() });
    return;
  }
  if (route === '/api/logos' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      if (!b.svg || typeof b.svg !== 'string') {
        sendJson(res, 400, { error: 'svg is required' });
        return;
      }
      const cleanSvg = sanitizeSvg(b.svg);
      if (cleanSvg === null) {
        sendJson(res, 400, { error: 'that is not an SVG the engine will store', field: 'svg', code: 'svg-rejected' });
        return;
      }
      const logo = table.createLogo(typeof b.name === 'string' ? b.name : '', cleanSvg);
      log(`logo saved: "${logo.name}" (#${logo.id})`);
      sendJson(res, 200, { logo });
    } catch (err) {
      sendJson(res, errStatus(err), { error: (err as Error).message });
    }
    return;
  }
  const logoMatch = route.match(/^\/api\/logos\/(\d+)$/);
  /* Manage a set in place: rename it, swap its art (keeping one step of undo),
   * or revert that swap. Replacing rather than re-adding matters because panes
   * reference a set by KEY — `lib:<id>` — so iterating on a mark that windows
   * already wear must not mint a new identity. */
  if (logoMatch && req.method === 'PATCH') {
    try {
      const id = Number(logoMatch[1]);
      const b = await readBody(req);
      let out = null;
      if (b.revert === true) {
        out = table.revertLogo(id);
        if (!out) {
          sendJson(res, 409, { error: 'nothing to revert — this set has no previous art' });
          return;
        }
      }
      if (typeof b.svg === 'string' && b.svg.trim()) {
        const cleanSvg = sanitizeSvg(b.svg);
        if (cleanSvg === null) {
          sendJson(res, 400, { error: 'that is not an SVG the engine will store', field: 'svg', code: 'svg-rejected' });
          return;
        }
        b.svg = cleanSvg;
        const lab = await import('../engine/icon-lab.ts');
        /* Normalised on the way in, exactly like an import: viewBox, xmlns and
           currentColor are what make a mark usable in a 20px tab, and art that
           arrives without them is the reason the tabs were broken. */
        out = table.replaceLogoSvg(id, lab.normalizeForConsumers(b.svg));
      }
      if (typeof b.name === 'string' && b.name.trim()) {
        out = table.renameLogo(id, b.name);
      }
      /* The art's TREATMENT (Icons page). Validated here rather than trusted,
         because an unknown `line` would mint a class nobody styles and a wild
         scale would paint a mark the size of a wall — and the field reaches a
         pane through inheritance, so a bad write outlives the page that made
         it. Unknown values fall back to the default; unknown KEYS are dropped
         entirely, so this can never become a general-purpose blob. `null`
         clears it back to "this art has no opinion". */
      if (b.style === null) {
        out = table.setLogoStyle(id, null);
      } else if (b.style && typeof b.style === 'object') {
        const pc = (v: unknown, d: number): number =>
          (Number.isFinite(Number(v)) ? Math.min(100, Math.max(1, Math.round(Number(v)))) : d);
        const st = b.style as Record<string, unknown>;
        out = table.setLogoStyle(
          id,
          JSON.stringify({
            line: WM_LINES.includes(String(st.line)) ? String(st.line) : 'none',
            washFrom: WM_WASH_FROM.includes(String(st.washFrom)) ? String(st.washFrom) : 'll-mid',
            backlit: typeof st.backlit === 'boolean' ? st.backlit : true,
            scale: pc(st.scale, 80),
            opacity: pc(st.opacity, 10),
            /* THE TAB MARK'S OWN TREATMENT (the design notes 4). Separate
               block because the mark and the watermark fail in opposite
               directions, so their settings are never interchangeable. These
               are PRESENTATION ONLY - opacity and an optional fixed tint -
               because the design system ruled art is never thickened, simplified or
               auto-swapped below 24px. `tint: 'auto'` is today's rendering
               exactly (currentColor from the project hue), so a set nobody has
               tuned is byte-identical to before. A tint that is not a 6-digit
               hex falls back to auto rather than reaching a tab as a colour
               nothing can parse. */
            /* The project's color, and the reason the Icons page is where it is
               set: the art is the project's face, so the two belong together.
               A value that is not #rrggbb is DROPPED rather than stored, so a
               bad write can never repaint every pane using that art. */
            ...(typeof st.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(st.color)
              ? { color: st.color }
              : {}),
            mark: (() => {
              const m = (st.mark && typeof st.mark === 'object' ? st.mark : {}) as Record<string, unknown>;
              const op = Number.isFinite(Number(m.opacity))
                ? Math.min(100, Math.max(10, Math.round(Number(m.opacity))))
                : 100;
              const tint = typeof m.tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.tint)
                ? m.tint
                : 'auto';
              return { opacity: op, tint };
            })(),
          }),
        );
      }
      if (!out) {
        sendJson(res, 400, { error: 'nothing to do — send name, svg, style, or revert' });
        return;
      }
      log(`logo #${id} updated: "${out.name}" (${out.svg.length} bytes)`);
      sendJson(res, 200, { ok: true, logo: out });
    } catch (e) {
      sendJson(res, (e as any)?.status ?? 500, { error: String((e as Error)?.message ?? e) });
    }
    return;
  }
  if (logoMatch && req.method === 'DELETE') {
    table.deleteLogo(Number(logoMatch[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  /* Icon lab (2026-09-02): derive a 20px-legible tab mark from watermark art,
   * and race the ways of doing it rather than picking one blind.
   *
   * Source is ONE of: `logoId` (a library set), `svg` (paste), or `png`
   * (base64 — the master raster, which skips the lossy trace the art already
   * went through). A `png` source may ALSO carry `svg` as the control, which is
   * what makes "is our conversion better than the online one" answerable: same
   * master, two tracers, one table.
   *
   * Runs the whole ladder per request (~1.5s for 8 candidates). That is slow for
   * a route and completely fine: it is operated by a human looking at a grid,
   * not polled. */
  if (route === '/api/icon-lab/race' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const lab = await import('../engine/icon-lab.ts');
      let control: string | null = typeof b.svg === 'string' && b.svg ? b.svg : null;
      let master;
      if (typeof b.png === 'string' && b.png) {
        master = await lab.pngToBitmap(Buffer.from(b.png.replace(/^data:[^,]*,/, ''), 'base64'));
      } else {
        if (typeof b.logoId === 'number') {
          const row = table.listLogos().find((l: any) => l.id === b.logoId);
          if (!row) {
            sendJson(res, 404, { error: `unknown logo id: ${b.logoId}` });
            return;
          }
          control = row.svg;
        }
        if (!control) {
          sendJson(res, 400, { error: 'need one of: png, svg, logoId' });
          return;
        }
        /* 512 is the master raster for an SVG source: high enough that the
           ladder's own downscale is doing the simplification, not this step. */
        master = await lab.rasterizeSvg(control, 512);
      }
      const t0 = Date.now();
      const candidates = await lab.race(master, control);
      const ms = Date.now() - t0;
      log(`icon-lab: raced ${candidates.length} candidates in ${ms}ms`);
      /* Cache under the set slug so a page refresh mid-rating-pass restores the
         expanded grid instead of discarding the artwork the verdicts are about. */
      if (typeof b.setSlug === 'string' && b.setSlug) {
        table.putIconRace(b.setSlug, JSON.stringify({ candidates, ms }));
      }
      sendJson(res, 200, { ok: true, candidates, ms });
    } catch (e) {
      sendJson(res, (e as any)?.status ?? 500, { error: String((e as Error)?.message ?? e) });
    }
    return;
  }

  /* IMPORT — a master PNG becomes a stored set, in one step.
   *
   * This is the whole point of the lab, distilled: trace @512 then SVGO, no
   * simplification, no second asset (settled by 101 human verdicts — see
   * icon-lab.ts IMPORT_RECIPE). Accepts `svg` too, so an existing file can be
   * normalised through the same path rather than a second one. */
  if (route === '/api/icon-lab/import' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name) {
        sendJson(res, 400, { error: 'name is required' });
        return;
      }
      const lab = await import('../engine/icon-lab.ts');
      let master;
      if (typeof b.png === 'string' && b.png) {
        master = await lab.pngToBitmap(Buffer.from(b.png.replace(/^data:[^,]*,/, ''), 'base64'));
      } else if (typeof b.svg === 'string' && b.svg) {
        master = await lab.rasterizeSvg(b.svg, 512);
      } else {
        sendJson(res, 400, { error: 'need one of: png, svg' });
        return;
      }
      const out = await lab.importArtwork(master);
      const logo = table.createLogo(name, out.svg);
      log(`icon-lab: imported "${logo.name}" (#${logo.id}) — ${out.paths} path(s), ${out.bytes} bytes`);
      sendJson(res, 200, { ok: true, logo, paths: out.paths, bytes: out.bytes });
    } catch (e) {
      sendJson(res, (e as any)?.status ?? 500, { error: String((e as Error)?.message ?? e) });
    }
    return;
  }

  /* Cached races. The MANIFEST is deliberately separate from the payloads: all
   * the derived artwork together is hundreds of KB, and a page only needs the
   * sets that actually have a race — which on a phone over the tailnet is the
   * difference between a usable load and a stall. */
  if (route === '/api/icon-lab/races' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, races: table.listIconRaces() });
    return;
  }
  const raceMatch = route.match(/^\/api\/icon-lab\/races\/(.+)$/);
  if (raceMatch && req.method === 'GET') {
    const row = table.getIconRace(decodeURIComponent(raceMatch[1]));
    if (!row) {
      sendJson(res, 404, { error: 'no cached race for that set' });
      return;
    }
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(`{"ok":true,"created_at":${row.created_at},${row.payload.slice(1)}`);
    return;
  }

  /* Icon-lab RATINGS — Owner's eye, per (set, recipe). The computed score is a
   * proxy; this is the thing it is a proxy FOR. Collected across every set, it
   * answers the question the race actually exists to answer — which recipe wins
   * CONSISTENTLY — and says whether the score can be trusted on future art. */
  if (route === '/api/icon-lab/ratings' && req.method === 'GET') {
    const rows = table.listIconRatings();
    /* Aggregate here rather than in the page: the page shows one set at a time,
       and the whole point is the pattern ACROSS sets. */
    const byRecipe = new Map<string, { green: number; yellow: number; red: number; scoreSum: number }>();
    for (const r of rows) {
      const a = byRecipe.get(r.recipe_id) ?? { green: 0, yellow: 0, red: 0, scoreSum: 0 };
      if (r.verdict === 2) {
        a.green++;
      } else if (r.verdict === 1) {
        a.yellow++;
      } else {
        a.red++;
      }
      a.scoreSum += r.score;
      byRecipe.set(r.recipe_id, a);
    }
    const summary = [...byRecipe.entries()]
      .map(([recipe_id, a]) => {
        const n = a.green + a.yellow + a.red;
        return {
          recipe_id,
          rated: n,
          green: a.green,
          yellow: a.yellow,
          red: a.red,
          /* green=1, yellow=0.5, red=0 — a marginal is half a pass, which keeps
             a recipe that is never bad but never great from ranking as if it
             were either. */
          acceptance: n ? Math.round(((a.green + a.yellow * 0.5) / n) * 100) : 0,
          avgScore: n ? Math.round(a.scoreSum / n) : 0,
        };
      })
      .sort((x, y) => y.acceptance - x.acceptance || y.green - x.green);
    sendJson(res, 200, { ok: true, ratings: rows, summary, sets: new Set(rows.map((r) => r.set_slug)).size });
    return;
  }

  if (route === '/api/icon-lab/ratings' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      if (typeof b.setSlug !== 'string' || typeof b.recipeId !== 'string') {
        sendJson(res, 400, { error: 'setSlug and recipeId are required' });
        return;
      }
      /* verdict null = UNRATED, which is a DELETE, not a fourth value — "not
         looked at yet" must never read as "looked at and judged bad". */
      if (b.verdict === null || b.verdict === undefined) {
        table.clearIconRating(b.setSlug, b.recipeId);
        sendJson(res, 200, { ok: true, verdict: null });
        return;
      }
      const verdict = Number(b.verdict);
      if (![0, 1, 2].includes(verdict)) {
        sendJson(res, 400, { error: 'verdict must be 0 (red), 1 (yellow), 2 (green) or null' });
        return;
      }
      table.setIconRating({
        set_slug: b.setSlug,
        recipe_id: b.recipeId,
        verdict,
        score: Number(b.score) || 0,
        fidelity: Number(b.fidelity) || 0,
        mush: Number(b.mush) || 0,
      });
      sendJson(res, 200, { ok: true, verdict });
    } catch (e) {
      sendJson(res, (e as any)?.status ?? 500, { error: String((e as Error)?.message ?? e) });
    }
    return;
  }

  /* Same habit as /api/diag/viewport and /api/diag/activity: the tuning is
   * readable without the page, so a result can be reasoned about rather than
   * guessed at. */
  if (route === '/api/diag/icon-lab' && req.method === 'GET') {
    const lab = await import('../engine/icon-lab.ts');
    sendJson(res, 200, {
      ladder: lab.LADDER,
      tracer: 'contour-trace (in-tree, pure TS: marching squares + rounded corners; @neplex/vectorizer napi cannot read a Buffer on Node 24)',
      optimizer: 'svgo v4 (preset-default + removeDimensions; removeViewBox is NOT in v4 preset)',
      rasterizer: '@resvg/resvg-js',
      scoredAt: [20, 40],
    });
    return;
  }

  const recipeMatch = route.match(/^\/api\/recipes\/([^/]+)(\/launch|\/sessions)?$/);
  if (recipeMatch) {
    const id = decodeURIComponent(recipeMatch[1]);
    const recipe = table.getRecipe(id);
    if (!recipe) {
      sendJson(res, 404, { error: `unknown recipe: ${id}` });
      return;
    }
    if (recipeMatch[2] === '/sessions' && req.method === 'GET') {
      sendJson(res, 200, { sessions: await recipeSessionList(recipe) });
      return;
    }
    if (recipeMatch[2] === '/launch' && req.method === 'POST') {
      let b: unknown = null;
      try {
        b = await readBody(req);
      } catch {
        /* no/invalid body = plain launch */
      }
      try {
        sendJson(res, 200, await launchRecipe(id, recipe, b, undefined, personUserId(req, principal)));
      } catch (e) {
        if (e instanceof LaunchBadRequest) {
          sendJson(res, 400, { ok: false, error: e.message, field: e.field, allowed: effortsFor(recipe.vendor) });
          return;
        }
        if (!(e instanceof LaunchRefused)) {
          throw e;
        }
        const v = e.collision;
        sendJson(res, 409, { ok: false, error: v.message, collision: { owner: v.owner, pid: v.pid, openIn: v.openIn, lstart: v.lstart } });
      }
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { recipe });
      return;
    }
    if (req.method === 'DELETE') {
      /* A ROOM SEAT FILLS FROM THIS RECIPE (workrooms §1.7, [ticket]). Deleting
         it would leave an active seat whose fill source is gone, so it answers
         409 naming the seats; give the seat up (or re-point it) first. Seats in
         an ARCHIVED room do not count (store.activeSeatsForRecipe): they fill
         from nothing, and an archived lead seat could never be given up. */
      const seated = table.activeSeatsForRecipe(id);
      if (seated.length) {
        sendJson(res, 409, {
          error: `this project fills ${seated.length} room seat(s) (${seated.map((st) => '@' + st.handle).join(', ')}) — remove those seats first`,
          field: 'id',
        });
        return;
      }
      table.deleteRecipe(id);
      log(`recipe deleted: "${recipe.name}" (${id})`);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  /* THE ROOT IS THE MANAGER, not the workbench demo.
   *
   * `/` used to serve web/index.html — the M4 multi-pane workbench prototype,
   * whose whole job on load is to auto-attach EVERY discovered component. So
   * landing on the root spawned three bare shells (local-cmd, local-shell,
   * repo-shell) as a side effect.
   *
   * Three things all point at `/`: the login redirect (safeNext's default), the
   * harbor tray item, and the "Web CLI Manager" card on homeserver's dev hub.
   * So every sign-in from the patio, and every tap of that card, minted three
   * more panes — and because workbench.js keys them by a localStorage id, each
   * ORIGIN gets its own set, which is why the VRPC and the laptop each
   * contributed three (Owner, 2026-08-27: "so many unnamed panes that seem to
   * have nothing in them").
   *
   * The workbench track is DEFERRED, not deleted (CLAUDE.md): it stays served
   * at /index.html for whoever wants the prototype. It just is not what a
   * person asking for the CLI Manager should be handed. */
  /* LOGO PRESET SUPERSET — composed, not read off disk.
   *
   * The shell resolves a tab's mark by KEY out of this module, and it has only
   * ever received the design system pinned 8. Everything the user actually loads lives in
   * the `logos` table and was unreachable, so every project tab wore a stock
   * mark picked by hashing its session id.
   *
   * Served at the path the toolkit ALREADY fetches, so no rebuild is needed over
   * there. The pinned file on disk is never modified — Contract A is "pin, never
   * fork", and this composes at request time rather than editing the snapshot.
   * The response says so in its own header, so nobody reading it mistakes it for
   * the vendored file.
   *
   * Normalised on the way out (viewBox synthesised, fills → currentColor): the
   * legacy library art is missing at least one of those and would otherwise
   * render as a black crop in a 20px box. Memoised on a cheap signature so the
   * SVGO pass does not run per request. */
  if (pathname === '/vendor/aurora-logo-presets.js') {
    const body = await buildLogoPresetModule();
    res.writeHead(200, {
      'content-type': MIME['.js'],
      'cache-control': 'no-store, must-revalidate',
      'access-control-allow-origin': '*',
    });
    res.end(body);
    return;
  }

  /* THE WEB APP (web-first pilot): the built app under HARBOR_WB_APP_DIR (default <repo>/web-app), served at /app behind sign-in like every page. An extensionless path falls back to index.html (client routing).
     Its CSP is the app's own: scripts and styles from this origin only, sockets back to this origin, no frames but our own. */
  if (moduleHost.serveUi(req, res, pathname)) {
    return; // M1: a module's sandboxed pages (and a 404 for anything under /app/plugins)
  }
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    if (await serveApp(req, res, pathname)) {
      return;
    }
  }

  if (auth.hostedProfile() && (pathname === '/' || pathname === '/manager.html') && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(302, { location: '/app/', 'cache-control': 'no-store' }); // the hosted pilot's home is the web app; the old CLI Manager page is not part of it
    res.end();
    return;
  }
  const target = resolveWebPath(url === '/' ? '/manager.html' : url);
  if (!target) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    let body = await readFile(file);
    const ext = extname(file);
    if (ext === '.html' || ext === '.js' || ext === '.mjs') {
      body = Buffer.from(versionAssets(body.toString('utf8'), ext, await webStamp()), 'utf8');
    }
    /* A script or stylesheet asked for BY ITS VERSIONED URL (?v=<newest web/ mtime>, stamped into the page above) can never
     * change under that URL: a new build mints a new stamp and so a new URL. Those are cached for good, so moving between
     * tabs and opening another page re-downloads nothing. HTML and anything unversioned stay no-store (below). Text is
     * gzipped when the browser accepts it. */
    const immutableAsset = /[?&]v=\d+/.test(url) && (ext === '.js' || ext === '.mjs' || ext === '.css');
    const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && ['.html', '.js', '.mjs', '.css', '.svg', '.json'].includes(ext) && body.length > 1024;
    if (gz) {
      body = gzipSync(body);
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      /* no-STORE, not no-cache. `no-cache` means "revalidate before reuse", and
       * iOS Safari can reuse a soft-reloaded asset anyway — Owner had to CLOSE
       * the tab and reopen it from the manager to pick up a CSS change
       * (2026-09-01). These are small local files on a loopback server; the
       * cost of never storing them is nil, and a reload that silently shows
       * yesterday's UI costs an entire debugging session. */
      'cache-control': immutableAsset ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate',
      ...(gz ? { 'content-encoding': 'gzip' } : {}),
      vary: 'accept-encoding',
      // Vendored ASSETS are cross-origin-readable so the window-host shell can
      // import them directly (it currently proxies /vendor/aurora-logo-presets
      // server-side because we sent no ACAO — this lets it drop that). Static,
      // non-secret, loopback-only server; the API routes above are unaffected.
      ...(url.startsWith('/vendor/') || url.startsWith('/aurora/')
        ? { 'access-control-allow-origin': '*' }
        : {}),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

/** A request that throws (a malformed %-escape in the path or in a ticket is a URIError) is a 400 or a 500 for THAT request: the engine stays up. The whole handler is under this,
 *  so no route can end the process by throwing. */
function failRequest(req: IncomingMessage, res: ServerResponse, e: unknown): void {
  const bad = e instanceof URIError;
  log(`request ${req.method ?? '?'} ${(req.url ?? '').split('?')[0].slice(0, 120)} threw (${bad ? '400' : '500'}): ${(e as Error)?.message ?? e}`);
  try {
    if (!res.headersSent) {
      res.writeHead(bad ? 400 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: bad ? 'bad-request' : 'internal' }));
    } else {
      res.end();
    }
  } catch {
    /* the socket is gone */
  }
}
const server = createServer((req, res) => {
  handleRequest(req, res).catch((e) => failRequest(req, res, e));
});
/* Nothing that rejects without a catch may end the engine: log it and carry on (the one place that decides, not a per-route habit). */
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection (logged, engine stays up): ${(reason as Error)?.stack ?? reason}`);
});

/**
 * WS PTY bridge — MULTIPLEXED (the {send,on} adapter's engine side).
 *
 * ONE socket per browser tab, NOT one per pane. Every message carries a `paneid`
 * in its body, so a single socket drives many resident sessions AND — the reason
 * for the reshape — the engine can now INITIATE messages to a pane it chose to
 * create (`pane.requested`), which a per-pane socket could never carry. The
 * vocabulary is the closed renderer↔engine contract (docs/renderer-engine-
 * contract.md §1/§2): commands in are `attach|input|resize|kill|rename|setPrefs|
 * address`; events out are `pane.ready|pane.data|pane.exit|pane.reattached|
 * pane.prefs|pane.error` (+ `result` for command return values).
 *
 * A pane's session stays RESIDENT (src/engine/sessions.ts), keyed by paneid and
 * independent of any socket (decision 7). Reload drops the socket; the session
 * stays resident; the new socket REATTACHES (replaying the buffer). Only an
 * explicit kill, the process exiting, or the idle reaper ends it. Cross-engine-
 * restart survival is still deferred (Walk) — a local PTY dies with its engine.
 */
/* The WS handshake is a normal HTTP request, so the cookie rides it — which is
 * exactly why browsers authenticate by cookie and not by bearer (they cannot
 * set headers on a WebSocket at all). An unauthenticated upgrade is refused
 * here rather than inside the connection handler: no socket, no pane. */
/* TWO WS CHANNELS, ONE UPGRADE ROUTER.
 *
 * `ws` attaches its own `upgrade` listener when it is given a `server`, and
 * that listener ABORTS any request whose path does not match — so a second
 * WebSocketServer on the same http server would kill the first one's handshakes
 * (and vice versa, whichever ran first). Both are therefore `noServer` and this
 * router picks by path. Anything else is destroyed, which is what a bare
 * `server` with no ws attached would have done anyway. */
const wsAuth = (info: { req: IncomingMessage }, done: (ok: boolean, code?: number, msg?: string) => void): void => {
  /* H5: the same Origin guard as HTTP, before any credential is looked at */
  const og = checkOrigin(info.req, { upgrade: true, hosted: auth.hostedProfile(), boundPort, extraOrigins: guardOrigins((info.req.url ?? '/').split('?')[0]) });
  if (!og.ok) {
    log(`WS upgrade REFUSED (${og.error}) from ${info.req.socket.remoteAddress}`);
    done(false, og.status ?? 403, og.error ?? 'origin-not-allowed');
    return;
  }
  if (LOCAL.enabled && (!hostHeaderAllowed(info.req.headers.host, boundPort) || browserOriginRefused(info.req.headers, boundPort, originsFor((info.req.url ?? '').split('?')[0])))) {
    done(false, 403, 'host-not-allowed');
    return;
  }
  /* A pane token opens no socket (§4.1): /pty types into any pane. Checked
     first, so it never reaches the identity gate below. */
  const agent = paneTokens.enabled() ? paneTokens.resolve(info.req) : null;
  if (agent && !(agent.ok === false && agent.code === 'token_invalid')) {
    log(`WS upgrade REFUSED (pane token${agent.ok ? ` ${agent.principal.paneid}` : `: ${agent.code}`}) ${info.req.url ?? ''}`);
    done(false, agent.ok ? 403 : 401, agent.ok ? 'not_for_pane_token' : agent.code);
    return;
  }
  /* THE WINDOW AGENT'S CHANNEL takes its OWN credential and nothing else (M9): the shared bearer and an identity session are refused here, so no other agent on the host
   * can register as the window agent, replace it, or receive the tickets the engine mints for windows. a desktop host on the shared bearer registers uncredentialed unless HARBOR_WB_WINDOW_AGENT_STRICT=1. */
  if (new URL(info.req.url ?? '/', 'http://engine.local').pathname === '/window-agent') {
    if (auth.hostedProfile()) {
      log('WS upgrade REFUSED (window agent: the hosted profile has no desktop host)');
      done(false, 403, 'no-window-agent-when-hosted');
      return;
    }
    if (auth.isWindowAgentCredential(info.req)) {
      done(true);
      return;
    }
    if (!auth.windowAgentSharedBearerAllowed()) {
      log(`WS upgrade REFUSED (window agent: not the window-agent credential) from ${info.req.socket.remoteAddress}`);
      done(false, 401, 'Unauthorized');
      return;
    }
  }
  /* Same gate as HTTP, deliberately: in strict mode the shared bearer is
   * dead everywhere, and a socket that still honoured it would be a way in
   * that the front door had already closed. The window agent is held to the
   * identical gate — it is a machine client presenting the engine token, which
   * is exactly what the bearer half of this is for. */
  const principal = identity.resolveIdentity(info.req);
  /* The voice actor opens no socket: no WS path is under /api/voice/. */
  if (identity.isVoiceActor(principal)) {
    log(`WS upgrade REFUSED (voice credential) ${info.req.url ?? ''}`);
    done(false, 403, identity.VOICE_SCOPE_REFUSAL);
    return;
  }
  if (identity.allowed(principal, auth.authorized(info.req))) {
    done(true);
    return;
  }
  log(`WS upgrade REFUSED (unauthenticated) from ${info.req.socket.remoteAddress}`);
  done(false, 401, 'Unauthorized');
};
const wss = new WebSocketServer({ noServer: true, verifyClient: wsAuth });
/** The window agent's channel (contract §5b). SAME auth as /pty — it is the
 *  engine token, presented as a bearer by a machine client. */
const windowAgentWss = new WebSocketServer({ noServer: true, verifyClient: wsAuth });
windowAgentWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  desktop.attachAgent(ws, req.socket.remoteAddress ?? 'unknown', auth.isWindowAgentCredential(req));
});
/** The engine relay for VRPC channel panes (engine/fabric-relay.ts). SAME
 *  auth as /pty — the pane's MCP presents the engine bearer; NO loopback
 *  exemption (it delivers content into a pane). Third noServer instance on
 *  the one router below. */
const relayWss = new WebSocketServer({ noServer: true, verifyClient: wsAuth });
relayWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const paneid = new URL(req.url ?? '/', 'http://engine.local').searchParams.get('paneid') ?? '';
  fabricRelay.attach(ws, paneid);
});
/** W3b /term (src/server/term.ts): one pane per socket, behind a grant. A
 *  redeemed socket is handed to the /pty handler above through a filtering
 *  peer, so attach, replay and the control lease are /pty's own. Fourth
 *  noServer instance on the one router below. */
const TERM_DEPS: term.TermDeps = {
  log,
  ptyConnection: (peer, req) => wss.emit('connection', peer, req),
  releaseControl: (paneid, peer) => {
    const r = sessions.get(paneid);
    if (!sessions.isLive(r) || r.socket !== peer) {
      return false;
    }
    r.socket = null;
    r.controllerLabel = null;
    announceControl(r);
    return true;
  },
};
const termSocket = term.createTermSocket(TERM_DEPS);
server.on('upgrade', (req, socket, head) => {
  /* LOCAL MODE: every socket path, /term included (it has its own verify, which wsAuth does not cover), meets the Host and Origin gate first. */
  if (LOCAL.enabled && (!hostHeaderAllowed(req.headers.host, boundPort) || browserOriginRefused(req.headers, boundPort, originsFor((req.url ?? '').split('?')[0])))) {
    socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  /* H5: the Origin/Host guard on EVERY socket path (/term branches off here, before wsAuth, so the router is where it must run) */
  const og = checkOrigin(req, { upgrade: true, hosted: auth.hostedProfile(), boundPort, extraOrigins: guardOrigins((req.url ?? '/').split('?')[0]) });
  if (!og.ok) {
    log(`WS upgrade REFUSED (${og.error}) from ${req.socket.remoteAddress}`);
    socket.write(`HTTP/1.1 ${og.status ?? 403} ${og.status === 421 ? 'Misdirected Request' : 'Forbidden'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
    return;
  }
  const path = (req.url ?? '').split('?')[0];
  if (path === '/pty') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }
  if (path === '/term') {
    termSocket.handleUpgrade(req, socket, head);
    return;
  }
  if (path === '/api/fabric/relay') {
    relayWss.handleUpgrade(req, socket, head, (ws) => relayWss.emit('connection', ws, req));
    return;
  }
  if (path === '/window-agent') {
    windowAgentWss.handleUpgrade(req, socket, head, (ws) =>
      windowAgentWss.emit('connection', ws, req),
    );
    return;
  }
  socket.destroy();
});

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/* ROOM PUSH (workrooms §2.3, T5) [ticket]. A room page is NOT a pane: it rides
 * this same /pty socket (no second WebSocketServer — trap 3) and follows rooms
 * by `room.subscribe`, a FULL-SET replace. The room bus is the only emitter;
 * this is its one listener, and it sends ONLY to sockets subscribed to that
 * room — never to every socket, and never to a member's pane (the context-tax
 * rule, wr §2.5). Best effort: a push that fails is recovered by the page's
 * `GET .../line?since=` backfill after its next open. */
const roomSubs = new Map<WebSocket, Set<string>>();
rooms.setSubscriberCount(() => roomSubs.size);
/* [scratch seen] WHO each socket is, for pushes that are one person's (their
   Scratchpad counts): set at connection from a person's credential only; a
   bearer socket has none and never receives a personal push. */
const socketPerson = new WeakMap<WebSocket, string>();

async function roomStateMsg(roomId: string): Promise<Record<string, unknown> | null> {
  const c = await projectionContext();
  const snap = rooms.roomSnapshot(roomId, (r) => projectRow(r, c));
  return snap ? { type: 'room.state', roomId, ...snap } : null;
}

roomBus.on(roomBus.ANY_ROOM, (roomId, ev) => {
  const to = [...roomSubs].filter(([, set]) => set.has(roomId)).map(([ws]) => ws);
  if (!to.length) {
    return;
  }
  if (ev.type === 'room.line') {
    /* a cross-posted line says how it reads HERE (outgoing / incoming); the
       transient `xposts` list is the announce's, not the page's */
    const { xposts: _x, ...plain } = ev.entry;
    const xp = _x?.length || ev.entry.room_id !== roomId ? table.xpostView(ev.entry, roomId) : null;
    const msg = { type: 'room.line', roomId, entry: xp ? { ...plain, xpost: xp } : plain };
    to.forEach((ws) => send(ws, msg));
    return;
  }
  if (ev.type === 'room.read') {
    // Gate G item 2: one member's read state for one entry (room-reads.ts).
    const msg = { type: 'room.read', roomId, entryId: ev.entryId, handle: ev.handle, state: ev.state };
    to.forEach((ws) => send(ws, msg));
    return;
  }
  if (ev.type === 'room.scratchpad') {
    /* person set: their new counts, to their own windows only; person null: the
       room's assets / notes changed, every PERSON window re-reads its own counts */
    for (const ws of to) {
      const who = socketPerson.get(ws);
      if (!who || (ev.person !== null && ev.person !== who)) continue;
      send(ws, ev.person ? { type: 'room.scratchpad', roomId, counts: ev.counts } : { type: 'room.scratchpad', roomId, changed: true });
    }
    return;
  }
  if (ev.type === 'room.held' || ev.type === 'room.waiting') {
    /* one seat's held queue / badge set moved (room-typer, room-reads): the
       page patches that seat's row, no room.state snapshot needed */
    const { type, ...rest } = ev;
    const msg = { type, roomId, ...rest };
    to.forEach((ws) => send(ws, msg));
    return;
  }
  void roomStateMsg(roomId)
    .then((msg) => msg && to.forEach((ws) => send(ws, msg)))
    .catch((e) => log(`room.state push failed for ${roomId}: ${(e as Error)?.message ?? e}`));
});

/** Prefs payload shape for pane.ready / pane.prefs events (renderer paints these). */
function prefsOf(paneid: string) {
  const row = table.get(paneid);
  return {
    friendlyName: row?.friendlyName ?? null,
    /* ART WINS (Owner, 2026-09-21): where the artwork states a color, that IS
       the pane's color and the recipe's own is ignored on read. One place to
       change it; nothing to reconcile between a project's VRPC and server twins. */
    color: artColor(row?.logo ?? null, () => table.listLogos() as ArtRow[]) ?? row?.color ?? null,
    fg: row?.fg ?? null,
    bg: row?.bg ?? null,
    watermark: row?.watermark ?? null,
    project: row?.project ?? null,
    fontSize: row?.fontSize ?? null,
    logo: inheritArtTreatment(row?.logo ?? null, () => table.listLogos() as ArtRow[]),
  };
}

/**
 * Repair recipes whose projectDir was stored before it was normalised on write.
 *
 * Idempotent and silent when there is nothing to do, like backfillLogoKeys. It
 * exists because the encode fix made a malformed path HARMLESS but left it
 * malformed -- and the stored string is what a human reads in the form, what
 * gets copied into the next recipe, and what any future code that does not go
 * through encodeProjectDir would use. Fix the data, not just the reader.
 */
function normalizeStoredProjectDirs(): void {
  for (const rec of table.listRecipes() as any[]) {
    if (!rec.projectDir) {
      continue;
    }
    const clean = normalizeProjectDir(rec.projectDir);
    if (clean && clean !== rec.projectDir) {
      table.upsertRecipe({ ...rec, projectDir: clean });
      log(`recipe "${rec.name}": projectDir normalised "${rec.projectDir}" -> "${clean}"`);
    }
  }
}

/**
 * Re-point live panes whose banked transcript has gone cold (see
 * session-adopt.ts).
 *
 * FACTORED OUT because this used to live inside the /api/table handler alone,
 * which made a correctness pass depend on a manager being open. It reads only
 * what session-titles already fetched, so it is free to run wherever a refresh
 * lands.
 */
function runAdoptions(): void {
  /* A worktree pane writes its transcripts under the WORKTREE path, which the
     recipe-keyed listings never see, so any adoption or /clear verdict about it
     would be read from someone else's files. Skip them (Owner 2026-10-05,
     worktree convention, KB design-notes-id s12). */
  const inWorktree = (paneid: string) => !!table.getSessionWorktree(paneid);
  for (const a of adopt.planAdoptions(table.list() as any[])) {
    if (inWorktree(a.paneid)) continue;
    table.adoptSessionId(a.paneid, a.to);
    log(
      `session-id adopted: ${a.paneid} ${a.from ?? '(none)'} -> ${a.to}` +
        (a.title ? ` ("${a.title}")` : ''),
    );
  }
  /* AFTER adoption (which clears the flag when it moves the id): flag panes whose
     CLI was /clear'ed while the row still banks the old conversation
     (session-cleared.ts; Owner 2026-10-03). */
  for (const f of clearedDetect.planCleared(table.list() as any[])) {
    if (inWorktree(f.paneid)) continue;
    table.markCleared(f.paneid, f.to, Date.now());
    log(`cleared in its CLI: ${f.paneid} (banked session unchanged; new conversation ${f.to})`);
  }
}

/** The CONVERSATION's name for a pane (a /rename, else Claude's auto-title,
 *  else its last prompt) — derived, never stored, so it rides beside prefs
 *  rather than inside them. Null until the first refresh for that project
 *  lands; `pane.title` follows the moment it does. */
/** The brand join key for a pane (contract §9), for the window's v21 chrome
 *  (tab brand plate + session-bar brand watermark). Same rule as the /api/table
 *  row: never missing, never guessed — `unknown` resolves to `generic`. */
/* REPAINT AFTER RESTART [Owner 2026-10-06]: one column narrower, then back, so the CLI redraws its
   whole screen. Panes adopted without a known size wait in repaintOnFirstResize for the first
   window resize after the restart. Never fatal. */
const repaintOnFirstResize = new Set<string>();
function nudgeRepaint(sid: string, cols: number, rows: number): void {
  const r = sessions.get(sid);
  if (!r || !sessions.isLive(r) || cols < 20 || rows < 5) return;
  try {
    r.cli.pty.resize(cols - 1, rows);
    vscreen.resize(sid, cols - 1, rows);
  } catch {
    return;
  }
  setTimeout(() => {
    const r2 = sessions.get(sid);
    if (!r2 || !sessions.isLive(r2)) return;
    try {
      r2.cli.pty.resize(cols, rows);
      vscreen.resize(sid, cols, rows);
    } catch {
      /* gone between the two */
    }
  }, 400).unref?.();
}

function vendorOf(paneid: string): string {
  const row = table.get(paneid) as any;
  return row?.vendor || 'unknown';
}

/** Agent chat's view of the engine (engine/agent-chat.ts). */
/** Resume picker data: the project dir's interactive claude sessions with
 *  names (custom-title > ai-title) + last prompt + age. Local scan or one
 *  ssh round-trip; headless (sdk-cli) sessions excluded exactly. Shared by
 *  GET /api/recipes/:id/sessions and the Concierge's read scope. */
async function recipeSessionList(recipe: any): Promise<unknown[]> {
  if (!recipe.projectDir || !recipe.runClaude) {
    return [];
  }
  const t = loadTargets().find((tt) => tt.id === recipe.target);
  // SELF-HOSTED POLARITY (2026-09-17): see remoteFsAccess in launch.ts —
  // a self-hosted `kind:'ssh'` target (homebase-resident) reads local now
  // instead of ssh-ing to itself; a foreign-broker target with no alias
  // to reach it returns an honest empty list instead of guessing.
  const access = remoteFsAccess(t);
  if (access.mode === 'unreachable') {
    log(`sessions listing for recipe "${recipe.name}": ${access.reason}`);
    return [];
  }
  return claudeCode.listSessions({ projectDir: recipe.projectDir, ...fsOptsFor(access) });
}

/** The Concierge's session view (the design notes P0): live and parked
 *  rows, a safe subset of /api/table — what, where, doing what, held how deep.
 *  Never a prompt, a line, a draft, a credential or a path. */
async function conciergeSessions(): Promise<unknown[]> {
  const c = await projectionContext();
  return (table.list() as any[])
    .filter((r) => r.state === 'live' || r.state === 'dehydrated')
    .map((r) => {
      const p = projectRow(r, c);
      const rec = r.recipe_id ? (table.getRecipe(r.recipe_id) as any) : null;
      const held = roomTyper.heldFor(r.paneid);
      return {
        paneid: r.paneid,
        name: rec?.name ?? null,
        title: p.title ?? null,
        agent: r.agent ?? null,
        recipe: r.recipe_id ?? null,
        vendor: p.vendor,
        model: p.model ?? null,
        effort: p.effort ?? null,
        state: r.state,
        activity: p.activity ?? null,
        ...(p.blocked ? { blocked: p.blocked } : {}),
        attached: !!p.attached,
        held: held ? { depth: held.depth, reason: held.reason, since: held.since } : null,
        rooms: table.roomsForPane(r.paneid).map((h) => ({ room: h.room.id, name: h.room.name, seat: h.seat.handle, lead: h.room.lead_seat === h.seat.id })),
      };
    });
}

/** The Concierge's relay effects (the design notes P2): a proxy line in the seat's room, delivered
 *  by the room's own delivery (so the typer's draft/dialog/mid-turn guards and its queue still apply). */
const conciergeSeatRef = (room: { id: string; name: string }, seat: { id: string; handle: string; occupant_kind: string; occupant: string | null }): conciergeRelay.SeatRef => ({
  roomId: room.id,
  roomName: room.name,
  seatId: seat.id,
  handle: seat.handle,
  livePaneid: seat.occupant_kind === 'pane' && seat.occupant && table.get(seat.occupant)?.state === 'live' ? seat.occupant : null,
  paneid: seat.occupant_kind === 'pane' ? seat.occupant : null,
  resting: seat.occupant_kind === 'pane' && !!seat.occupant && table.get(seat.occupant)?.state === 'dehydrated',
});
const conciergeRelayDeps: conciergeRelay.RelayDeps = {
  allowed: (action) => concierge.settings().allowed[action] === true,
  seatsByHandle: (handle, roomId) =>
    table
      .listRooms({ state: 'open' })
      .filter((r) => !roomId || r.id === roomId)
      .flatMap((r) => table.listSeats(r.id).filter((s) => s.handle === handle).map((s) => conciergeSeatRef(r, s))),
  familyLeads: (roomId) => {
    const room = table.getRoom(roomId);
    if (!room || room.state !== 'open') {
      return null;
    }
    return {
      rooms: table
        .listFamily(roomId)
        .filter((r) => r.state === 'open')
        .map((r) => {
          const lead = r.lead_seat ? table.getSeat(r.lead_seat) : undefined;
          return { roomId: r.id, roomName: r.name, lead: lead && lead.left_at === null ? conciergeSeatRef(r, lead) : null };
        }),
    };
  },
  held: (paneid) => roomTyper.heldFor(paneid),
  relay: (seat, line, sent, meta) => {
    const room = table.getRoom(seat.roomId)!;
    const who = pictureOwner(null);
    const entry = table.appendProxyLine(seat.roomId, { target: seat.handle, body: line, meta: { ...meta, for: who.name ?? 'the user' } }).result[0];
    const target = table.getSeat(seat.seatId)!;
    const out = rooms.deliverToSeat(room, target, entry, sent);
    const wake = rooms.wakeForRelay(room, target, entry, sent, out); // a RESTING seat is woken as the person's own line would
    return { lineId: entry.id, delivered: out.delivered, queued: out.queued, ...(out.typed ? { typed: String(out.typed) } : {}), ...(wake ? { waking: wake.waking, note: wake.note } : {}) };
  },
  log: (line) => log(line),
};

/** The Concierge act's guards are the window buttons' own: the typer's deliver-held, the activity machine's draft state, and a fact in the room. */
const conciergeActDeps: conciergeAct.ActDeps = {
  seat: (seatId) => {
    const s = table.getSeat(seatId);
    return s ? { id: s.id, room_id: s.room_id, handle: s.handle, left_at: s.left_at, paneid: s.occupant_kind === 'pane' ? s.occupant : null } : undefined;
  },
  held: (paneid) => roomTyper.heldFor(paneid),
  hasDraft: (paneid) => activity.draftState(paneid) === 'draft',
  paneState: (paneid) => (table.get(paneid)?.state as string | undefined) ?? null,
  reload: async (seatId) => {
    const seat = table.getSeat(seatId);
    const room = seat ? table.getRoom(seat.room_id) : undefined;
    if (!seat || !room) throw new Error('the seat is gone');
    return rooms.reloadSeatForPerson(room, seat);
  },
  start: async (seatId) => {
    const seat = table.getSeat(seatId);
    const room = seat ? table.getRoom(seat.room_id) : undefined;
    if (!seat || !room) throw new Error('the seat is gone');
    return (await rooms.startSeatForPerson(room, seat, {})) as { paneid?: string };
  },
  deliverHeld: (paneid) => roomTyper.deliverHeld(paneid),
  fact: (roomId, body, meta) => {
    table.appendLine(roomId, { kind: 'fact', body, meta } as any, { actor: 'user' });
  },
  log: (line) => log(line),
};

/** wb: link lookups for the Concierge's chat (engine/concierge.ts resolveLink). */
const conciergeLinkDeps: concierge.LinkDeps = {
  room: (id) => table.getRoom(id) as any,
  lineInRoom: (roomId, line) => {
    const e = table.getLineEntry(line);
    return !!e && e.room_id === roomId;
  },
  pane: (paneid) => table.get(paneid) as any,
  soloPath: (recipeId, paneid) => soloPathFor(recipeId, paneid),
  roomHasApp: (roomId, slug) => table.listRoomApps(roomId).some((a) => a.slug === slug),
};

const chatDeps: agentChat.ChatDeps = {
  row: (paneid) => table.get(paneid) as any,
  isLive: (paneid) => sessions.isLive(sessions.get(paneid)),
  location: (row) => {
    const full = table.get(row.paneid) as any;
    const recipe = full?.recipe_id ? (table.getRecipe(full.recipe_id) as any) : null;
    const wt = table.getSessionWorktree(row.paneid);
    const cwd = (wt ? worktreePath(wt.project, wt.name) : null) ?? recipe?.projectDir;
    if (!cwd) {
      return null;
    }
    // Same polarity rules as titles/locate: local, an ssh alias, the window agent, or unreachable.
    return { cwd, access: remoteFsAccess(targetOfRow(full)) as agentChat.FsAccess };
  },
  typer: roomTyper,
  share: agentShare,
  noteChat: { claim: (paneid) => table.claimChatNote(paneid), release: (paneid) => table.releaseChatNote(paneid) },
  log: (line) => log(line),
};
/* [concierge] the badge reads the concierge's newest replies through the same chat reader */
concierge.setChatSource(async (paneid) => {
  const r = await agentChat.chatGet(paneid, new URLSearchParams({ limit: '50' }), chatDeps);
  return r.status === 200 ? (r.body as unknown as concierge.ChatTail) : null;
});

function titleOf(paneid: string): string | null {
  const row = table.get(paneid) as any;
  return titles.known(row?.recipe_id, row?.session_id);
}

/** Pending agent-submitted URL offers per pane (Owner 2026-08-09). In-memory
 *  like activity: offers are ephemeral prompts, not durable state. */
/** Last N window geometry reports (see /api/diag/viewport). */
const viewportReports: Record<string, unknown>[] = [];
/** HOW THE WIDGET'S STATUS FILE IS REACHABLE (2026-09-20).
 *
 *  This used to be the pre-polarity ternary `kind === 'ssh' ? alias : undefined`
 *  at four call sites, and CLAUDE.md flagged it on 2026-09-17 as the one place
 *  the self-hosted fix deliberately skipped. It bit: the Local command bridge's
 *  target is `homebase-resident` (`kind:'ssh'`), the engine now runs ON the server, so
 *  the refresh shelled `ssh homeserver` — the server trying to ssh to itself —
 *  while the file sat readable on its own disk. The sudo countdown vanished
 *  from the manager and the tab.
 *
 *  `agent` is deliberately NOT reachable here: the window agent's fs surface is
 *  the claude-projects root only (contract §5b-fs), and a tool's statusPath is
 *  an arbitrary path it chose. Unreachable means say so — never fall back to
 *  reading THIS host's disk at that path, which would serve another machine's
 *  file under the same name.
 *
 *  All four call sites go through this, because the cache key is
 *  `${sshAlias ?? 'local'}:${path}`: a refresh and a read that disagree about
 *  the alias write and read different keys, and the chip stays empty forever. */
function widgetAccess(t: Target | undefined): { reachable: boolean; sshAlias?: string } {
  const access = remoteFsAccess(t);
  if (access.mode === 'local') {
    return { reachable: true };
  }
  if (access.mode === 'ssh') {
    return { reachable: true, sshAlias: access.sshAlias };
  }
  return { reachable: false };
}

/** A tool's own status line for a recipe, or null. ONE definition, shared by
 *  the /api/table row and the per-pane push below — they diverged trivially
 *  before and a status that differs between the manager and the tab is worse
 *  than one that is missing from both. */
function widgetFor(recipeId: string | null | undefined): unknown {
  const rec = recipeId ? (table.getRecipe(recipeId) as any) : null;
  if (!rec?.statusPath) {
    return null;
  }
  const acc = widgetAccess(loadTargets().find((tt) => tt.id === rec.target));
  return acc.reachable ? widgetStatus.known(rec.statusPath, acc.sshAlias) : null;
}

/* PUSH THE TOOL'S STATUS TO ITS OWN WINDOW (the design system v20 `badge`).
 *
 * The manager has always shown this; a tab never could, so Owner could be
 * working in a session whose sudo credential had expired with nothing on
 * screen saying so. The window forwards it to the tab chrome verbatim — the
 * engine still never interprets the text, and `kind:'ok'` is published as-is
 * because the chrome is what decides it renders nothing.
 *
 * Diffed before sending: this fires on the widget poll's cadence and a tab that
 * rebuilt itself every 20s would flicker under the pointer for no new fact. */
const lastWidgetSent = new Map<string, string>();

function pushWidget(paneid: string, recipeId: string | null | undefined): void {
  const resident = sessions.get(paneid);
  if (!resident) {
    lastWidgetSent.delete(paneid);
    return;
  }
  /* WARM A COLD CACHE. `known()` reads only what a refresh has already put
     there, and the manager used to be the thing that warmed it as a side effect
     of /api/table — so a freshly launched session had nothing to show until
     somebody opened the manager. TTL-gated inside, so this is free when warm. */
  const rec = recipeId ? (table.getRecipe(recipeId) as any) : null;
  if (rec?.statusPath) {
    const acc = widgetAccess(loadTargets().find((tt) => tt.id === rec.target));
    if (acc.reachable) {
      widgetStatus.refresh(rec.statusPath, acc.sshAlias);
    }
  }
  const widget = widgetFor(recipeId) as any;
  /* The module's own fingerprint, which omits `fetchedAt` — see widget-status.
     Stringifying the whole value here would differ on every poll and push a tab
     rebuild every 20s for no new fact. */
  const fp = widgetStatus.fingerprint(widget ?? null);
  if (lastWidgetSent.get(paneid) === fp) {
    return;
  }
  /* NEVER ANNOUNCE "still nothing". Most panes have no tool status at all, and
     on a fresh spawn the cache is cold, so an unguarded push sends a null the
     instant the window opens and then the real value a moment later — a tab
     rebuilt twice to end up where it started. A first sighting of null is not
     news; null AFTER a value is (the tool stopped) and still goes out. */
  if (widget == null && !lastWidgetSent.has(paneid)) {
    lastWidgetSent.set(paneid, fp);
    return;
  }
  lastWidgetSent.set(paneid, fp);
  broadcast(resident, { type: 'pane.widget', paneid, widget });
}

const urlOffers = new Map<string, string[]>();

/** A field an agent hands the user. `secret` only changes how the WINDOW paints
 *  it (masked until revealed) — the engine treats all three identically and
 *  never inspects a value. */
interface HandoffItem {
  label: string;
  value: string;
  kind: 'url' | 'text' | 'secret';
}
interface HandoffBundle {
  id: string;
  title: string;
  items: HandoffItem[];
  at: number;
}
/* IN MEMORY, NEVER THE TABLE — see /api/handoff. Passwords come through here.
 * Bounded per pane; a bundle also ages out, because an agent that hands over a
 * one-time code should not leave it sitting in a badge tomorrow. */
const HANDOFF_MAX = 6;
/* A DAY, and the ceiling is the point (Owner, 2026-09-04): "this tool is for
 * info agents are sharing in chat and should be transient to that chat session
 * ... anything longer than that needs to be saved elsewhere." A value you still
 * need tomorrow is a value that belongs in the SOPS vault (secrets-sops) or on
 * the agent-share, not parked in a chat window. The ceiling is what keeps this
 * from quietly becoming a credential store. */
const HANDOFF_TTL_MS = Number(process.env.HARBOR_WB_HANDOFF_TTL_MS ?? 24 * 60 * 60 * 1000);
const handoffs = new Map<string, HandoffBundle[]>();

/** Drops expired bundles and returns what is still live for a pane. */
function liveHandoffs(paneid: string): HandoffBundle[] {
  const list = (handoffs.get(paneid) ?? []).filter((h) => Date.now() - h.at < HANDOFF_TTL_MS);
  if (list.length) {
    handoffs.set(paneid, list);
  } else {
    handoffs.delete(paneid);
  }
  return list;
}

/* REAP GUARD (W5, Owner 2026-09-24): a windowless pane in a persistent seat of
 * an open room, or streaming / waiting, is not reaped. The predicate lives in
 * reap-guard.ts; sessions.ts only ever sees a function (it never imports
 * rooms). Deferred reaps show in GET /api/diag/activity under `reaper`. */
sessions.setReapGuard(
  (paneid) => reapHoldReason(paneid, { activity: (p) => activity.get(p), seats: (p) => table.roomsForPane(p) }),
  log,
);

/* The draft guard's function-key rule is per vendor (activity.ts fnKey). */
activity.setVendorResolver((paneid) => table.get(paneid)?.vendor || null);

/* Activity change → the pane's viewer (pane.state event) + installation telemetry.
 * Fires only on CHANGE (the state machine dedupes), so NATS traffic is delta-
 * only per the installation convention. */
activity.setOnChange((paneid, state) => {
  const resident = sessions.get(paneid);
  if (resident) {
    broadcast(resident, { type: 'pane.state', paneid, state });
  }
  telemetry.publishPaneState({
    paneid,
    name: table.get(paneid)?.friendlyName ?? null,
    state,
  });
  /* SESSION PRESENCE (Stage 2 / E10) rides the SAME change, deliberately: the
     activity machine is already the one thing in the installation that knows whether
     a CLI is doing something, and giving presence its own detector would give
     the rings and the fabric two different opinions about the same pane. */
  publishPresence(paneid, state);
  /* W3-interim: idle is when a held room line may be typed (room-typer.ts). */
  roomTyper.onActivity(paneid, state);
});
roomTyper.setLog((line) => log(line));
promptBlock.setLog((line) => log(line));
runtimeFlags.setLog((line) => log(`flags: ${line}`)); // assemble-room §5.3: every switch transition, once
roomFabric.setLog((line) => log(line)); // F4: rooms on fabric threads
/* S0 startup block: a channel launch is not past startup until its
   dev-channels dialog is accepted (handed in, so startup-gate imports nothing
   from the channel stack). */
startupGate.setDialogProbe((paneid) => channels.dialogStateOf(paneid));
/* S0 guard 10: a channel envelope's confirm window (and so its typed
   fallback) waits until the pane is past startup — never a typed copy beside
   the pump's (handed in the same way). */
channels.setStartupProbe((paneid) => startupGate.isBlocked(paneid));
/* S0 guard 6d: the dialog watcher settles on the gate's normalised position
   counter and writes only while the gate's latest prompt is dev-channels. */
channels.setGateProbe((paneid) => startupGate.streamOf(paneid));
/* S0 guard 7: the spawn guard's view of the world, handed in (spawn-guard.ts
   imports none of it, so its tests need no table, broker or /proc). */
const spawnGuardDeps: spawnGuard.GuardDeps = {
  liveRows: () => table.list().filter((r) => r.state === 'live'),
  classify: (q) => procClassifier.classify(q),
  labelOf: (p) => {
    const r = table.get(p);
    return r?.agent ? `@${r.agent}` : (prefsOf(p).friendlyName ?? p);
  },
  mode: () => String(runtimeFlags.runtimeFlag('collisionGuard')),
  log: (line) => log(line),
};
/* S0 guard 9 (assemble-room §4.4, F21): does claude own this pane's terminal?
   Only a pane whose pty runs on THIS host can be read from /proc; anywhere
   else (and on EACCES) the answer is null — could not tell — and room-typer
   delivers as it always has. */
roomTyper.setClaudeProbe((paneid, cached) => paneClaudeOwner(paneid, cached));
/* pane.held: the pane's OWN typed-delivery hold, pushed to its viewers on every
   change (room-typer dedupes), because a solo window knows only its paneid
   (assemble-room §3.6 solo head). The same shape rides pane.ready as `held`. */
roomTyper.setHeldListener((paneid, held) => {
  const r = sessions.get(paneid);
  if (r) {
    broadcast(r, { type: 'pane.held', paneid, held });
  }
});
/* pane.mcp (ticket): the pane's MCP calls, start and end, to its viewers the
   same way; the in-flight starts ride pane.ready as `mcp`. Fed by the hook
   sink (engine/mcp-calls.ts); one sweep timer ends a call open > 30 min. */
mcpCalls.setEmitter((frame) => {
  const r = sessions.get(frame.paneid);
  if (r) {
    broadcast(r, frame);
  }
});
mcpCalls.setLog((line) => log(line));
mcpCalls.startSweep();

/* PTY SCREEN MODEL — P0 SHADOW (the design notes). Everything below
   only FEEDS the model; nothing reads it back except /api/diag/vscreen. Every
   vscreen entry point is fail-safe (it cannot throw into the pump, the boot
   adoption loop or the WS handler), and HARBOR_WB_VSCREEN / config.json
   `vscreen.mode` (default off) switches it live. */
vscreen.setDeps({
  log: (line) => log(line),
  linkOpen: (host) => brokerClient.linkFor(host)?.socketOpen() ?? false,
  replayOf: (paneid) => {
    const r = sessions.get(paneid);
    return r ? sessions.replay(r) : null;
  },
  saveSize: (paneid, cols, rows, at) => table.setSize(paneid, cols, rows, at),
  loadSize: (paneid) => {
    const row = table.get(paneid);
    return row
      ? { cols: row.cols ?? null, rows: row.rows ?? null, sizeAt: row.size_at ?? null, startedAt: row.started_at ?? null }
      : null;
  },
});
/* WORKERS (ticket): non-interactive group-job runs, spawned in the vendor
   account's broker. Never table rows, so never sessions (engine/workers.ts). */
const workers = createWorkers({
  ...workersEnv(),
  spawn: async (linkName, sid, desc) => {
    const link = brokerClient.linkFor(linkName);
    if (!link) {
      throw new Error(`no broker link '${linkName}' is configured on this engine`);
    }
    return (await link.spawn(sid, desc, { cols: 200, rows: 50 })).pty;
  },
  now: () => Date.now(),
  log: (m) => log(m),
});
brokerClient.onGap((e) => {
  if (e.phase === 'close') {
    vscreen.gap(e.host, 'close');
  } else {
    vscreen.gap(e.host, 'open', { [e.sid]: e.replay });
  }
});
roomTyper.onTyped((paneid) => vscreen.noteInject(paneid, 'room-typer'));
voice.onInjected((paneid) => vscreen.noteInject(paneid, 'voice'));
/* ROOM VOICE (the design notes, E1b): the room's clocks + the voice panel reconcile. */
roomVoice.start({
  deliver: rooms.deliverToSeat,
  seats: async (id) => { const c = await projectionContext(); return rooms.roomSnapshot(id, (r) => projectRow(r, c))?.seats ?? []; },
  userName: () => pictureOwner(null).name,
  ownerKey: voiceOwnerKey,
  log,
});

/** The screen model's host kind, from the BROKER LINK the pty runs on (a
 *  win32 broker is ConPTY). Never from the target: hostOfTarget answers whose
 *  DISK a target's data is on, a different question. */
function vscreenHostKind(linkHost: string): vscreen.HostKind {
  const link = brokerClient.linkFor(linkHost);
  const win32 = link?.isLocal ? isWindows : brokerClient.brokerPlatform(linkHost) === 'win32';
  return win32 ? 'conpty' : 'pty';
}

/* ============================================================================
 * MESSAGE FABRIC (Stage 3) — delivery is wired ONCE, here, and both doors use
 * it: `POST /api/fabric/inbound` (push) and engine/fabric-subscriber.ts (pull).
 * engine/fabric.ts must not know about the table, the resident registry or the
 * socket layer, so the three things it needs are handed to it.
 * ========================================================================== */
/** What a fabric address means (engine/slug-route.ts): a minted slug is one pane; a bare slug shared by several
 *  live panes is the recipe's primary pane when exactly one is, else AMBIGUOUS (refused, naming each pane). */
function fabricRouteFor(slug: string): ReturnType<typeof routeSlug> {
  return routeSlug(slug, {
    exact: fabricCheckin.paneForSlug(slug),
    rows: table.list() as any[],
    mintedOf: (paneid) => fabricCheckin.identityOf(paneid)?.slug ?? null,
  });
}
function fabricLivePaneFor(slug: string): string | null {
  const r = fabricRouteFor(slug);
  return r && 'pane' in r ? r.pane : null;
}
function fabricAmbiguousFor(slug: string): string[] | null {
  const r = fabricRouteFor(slug);
  return r && 'ambiguous' in r ? r.ambiguous : null;
}
/** CHATTER [chatter]: the quiet slug covering a recipient — the `to` as sent, or the
 *  agent / minted work slug of the live pane it resolves to — or null. */
function quietSlugFor(to: string, paneid: string | null): string | null {
  if (!agentComms().quietEnabled) {
    return null; // [agent comms] the master switch is off: marks are kept, ignored at both doors
  }
  const quiet = table.chatterQuiet();
  if (!quiet.length) {
    return null;
  }
  const row = paneid ? (table.get(paneid) as any) : undefined;
  return chatter.quietMatch(quiet, [to, row?.agent, row?.fabric_slug]);
}
/* The DM bodies the repeat rule compares against [chatter p2]: in memory only (the
   chatter_events table never holds a body), the last hour per (sender, recipient).
   Lost on restart, which forgets repeats, never budget (that counts dm_sent rows). */
const DM_WINDOW_MS = 60 * 60 * 1000;
const sentDms = new Map<string, Array<{ ts: number; id: string | null; body: string }>>();
function recentDms(from: string, to: string, now: number): Array<{ ts: number; id: string | null; body: string }> {
  const k = `${from} ${to}`;
  const kept = (sentDms.get(k) ?? []).filter((d) => d.ts > now - DM_WINDOW_MS);
  if (kept.length) sentDms.set(k, kept);
  else sentDms.delete(k);
  return kept;
}
function rememberDm(from: string, to: string, d: { ts: number; id: string | null; body: string }): void {
  sentDms.set(`${from} ${to}`, [...recentDms(from, to, d.ts), d]);
}
/** Never fatal: a report row lost is better than a delivery lost. */
function noteChatter(kind: Parameters<typeof table.recordChatterEvent>[0]['kind'], paneid: string | null, slug: string, from: string | null, envId: string | null): void {
  try {
    table.recordChatterEvent({ ts: Date.now(), kind, paneid, slug, from_slug: from, env_id: envId });
  } catch (e) {
    log(`chatter: could not record ${kind}: ${(e as Error).message}`);
  }
}
fabric.setDeliveryDeps({
  /* A MINTED work slug (check-in, contract 1.3) names exactly one pane, so it is asked first. A BARE slug held by
     several live panes (E11) used to go to the most recently updated one, silently; now the recipe's primary pane
     takes it when exactly one is, else the delivery is refused as AMBIGUOUS, naming each pane's minted slug
     (night order 2026-10-25, agreed application [ref]). */
  livePaneFor: fabricLivePaneFor,
  ambiguousFor: fabricAmbiguousFor,
  quietFor: (to, paneid) => quietSlugFor(to, paneid),
  noteChatter: (kind, paneid, slug, env) => noteChatter(kind, paneid, slug, env.from, env.id),
  toViewers: (paneid, messages) => {
    const resident = sessions.get(paneid);
    const viewers = resident?.viewers.size ?? 0;
    if (resident && viewers > 0) {
      broadcast(resident, { type: 'fabric.message', paneid, messages });
    }
    return viewers;
  },
  /* When the pane's current process went live — the spawn/restore upsert's
     stamp, which broker ADOPTION does not touch, so an engine restart never
     makes in-flight mail look held (fabric-held.ts). */
  startedAt: (paneid) => (table.get(paneid) as any)?.started_at ?? null,
  log,
});
fabricHeld.setLog(log);

/* Startup prompts only a human answers (startup-gate.ts PROMPTS): a restore
   that lands on one answers `needs-you`. dev-channels is the engine's own to
   accept; `menu` is too generic to name. */
const HUMAN_STARTUP_PROMPTS = new Set(['trust', 'old-session', 'resume-conversation', 'mcp-server', 'api-key', 'picker']);

/** POST /api/fabric/restore {slug, envelope_id?} — see fabric-restore.ts. */
async function handleFabricRestore(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const b = await readBody(req);
    const slug = normalizeSlug(b?.slug);
    if (!slug) {
      sendJson(res, 400, { error: 'slug is required (an agent slug)', field: 'slug' });
      return;
    }
    const envelopeId =
      typeof b.envelope_id === 'string' && b.envelope_id.trim() && b.envelope_id.length <= 120 ? b.envelope_id.trim() : null;
    const answer = await fabricRestore.restore(slug, envelopeId, fabricRestoreDeps());
    sendJson(res, 200, answer);
  } catch (err) {
    sendJson(res, errStatus(err), { error: (err as Error).message });
  }
}

/** fabric-restore.ts's deps: the restore route's, and the send door's level-1 wake [agent rest]. */
function fabricRestoreDeps(): Parameters<typeof fabricRestore.restore>[2] {
  return {
      rowForSlug: (sl) => (table.list() as any[]).find((r) => r.agent === sl || r.fabric_slug === sl),
      resumable: (v) => isResumableVendor(v),
      recipeExists: (id) => !!table.getRecipe(id),
      launch: async (id, body) => {
        const recipe = table.getRecipe(id);
        if (!recipe) {
          throw new Error(`unknown recipe: ${id}`);
        }
        return launchRecipe(id, recipe, body);
      },
      socketUrl: () => {
        const a = server.address();
        const port = a && typeof a === 'object' ? a.port : PORT;
        const host = a && typeof a === 'object' && a.address !== '0.0.0.0' && a.address !== '::' ? a.address : '127.0.0.1';
        return `ws://${host.includes(':') ? `[${host}]` : host}:${port}/pty`;
      },
      socketToken: () => auth.bearerToken(),
      isLive: (p) => sessions.isLive(sessions.get(p)),
      needsYou: (p) => {
        const b2 = promptBlock.get(p);
        if (b2) {
          return b2.reason;
        }
        const k = startupGate.currentPrompt(p)?.kind;
        return k && HUMAN_STARTUP_PROMPTS.has(k) ? k : null;
      },
      ready: (p) =>
        startupReady({
          vendor: (table.get(p) as { vendor?: string | null } | undefined)?.vendor,
          gateArmed: !!startupGate.info(p),
          gateBlocked: startupGate.isBlocked(p),
          live: sessions.isLive(sessions.get(p)),
          state: activity.get(p),
          lastOutputAt: activity.lastOutputAt(p),
          dialogUp: activity.isDialogUp(p),
          now: Date.now(),
        }),
      endBack: (p) => endForCycle(p),
      log,
  };
}

/** Every slug this engine currently HOSTS — the set it subscribes to on the
 *  fabric. Live rows only, any vendor: a dehydrated session has a durable
 *  mailbox and nothing to show a message on, and the fabric's sweeper is what
 *  decides what happens to it (brief §1.3). Recomputed on demand, never stored,
 *  for the same reason presence derives `node` at publish time. */
function hostedSlugs(): string[] {
  return [
    ...(table.list() as any[]).filter((r) => r.state === 'live' && r.agent).map((r) => r.agent as string),
    /* The work slugs check-in minted for live panes: a send made WITH the
       instance header is stamped `from: <project>-<hash>`, so that is where the
       reply lands, and the engine must be listening there too. */
    ...fabricCheckin.slugs(),
  ];
}

/**
 * One live pane's check-in facts (engine/fabric-checkin.ts), or null when it
 * has nothing to check in AS: not live, or no agent slug. `project` is the
 * bare agent slug — the registry node id by construction (agent-slug.ts
 * derives it from basename(projectDir)); the fabric refuses one that is not
 * a node, and that refusal is a named outcome, never a broken spawn.
 */
function checkinInfo(paneid: string): fabricCheckin.PaneInfo | null {
  const row = table.get(paneid) as any;
  if (!row || row.state !== 'live' || !row.agent) {
    return null;
  }
  const recipe = row.recipe_id ? (table.getRecipe(row.recipe_id) as any) : null;
  return {
    paneid,
    project: row.agent,
    vendor: row.vendor || 'unknown',
    node: nodeOfTarget(recipe?.target),
    name: row.friendlyName || recipe?.name || null,
    remembered: { slug: row.fabric_slug ?? null, instance: row.fabric_instance ?? null },
  };
}

/* ============================================================================
 * SESSION PRESENCE (Stage 2 / E10) — the engine publishes for every pane it
 * holds that carries a slug, whatever vendor. See engine/presence.ts.
 * ========================================================================== */

/**
 * The service registry NODE a target's work happens on.
 *
 * Precedence, and each rung is a different KIND of fact:
 *   1. `target.node` — pinned by hand in targets.json. The only rung that is
 *      authoritative, and the escape hatch for a registry slug that matches no
 *      hostname.
 *   2. a broker-RESIDENT target — the pty spawns in that broker, so the work is
 *      literally on that broker's host and the broker name IS a host slug.
 *   3. an ssh target — the work is at the FAR end of the alias, never here. The
 *      alias's first segment is the host (`homeserver-svc-ops` is the
 *      svc-ops account ON homeserver), which is an assumption about our own
 *      naming convention and precisely why rung 1 exists.
 *   4. a local target — this engine's own node.
 *
 * DERIVED, NEVER STORED. A target can be re-pointed in targets.json with no
 * restart, and a node baked into a session row at spawn would then be a lie
 * that outlives the edit.
 */
function nodeOfTarget(targetId: string | null | undefined): string {
  /* THE RUNGS MOVED TO launch.ts's `hostOfTarget` (2026-09-18) and this is now
     a lookup, not a second implementation. They were already written twice —
     here, and rungs 1-2 again inside `isSelfHosted` — and the window-agent fs
     path needed a THIRD reader ("whose disk is this target's?"). Two
     independent copies of a host-derivation rule is exactly the shape of the
     polarity bug 2026-09-17 fixed; three would have been a matter of time. */
  return hostOfTarget(targetId ? loadTargets().find((x) => x.id === targetId) : undefined);
}

/**
 * Publish one pane's presence, if it has a slug to publish under.
 *
 * A pane with no slug is SILENT, not anonymous: publishing under a paneid would
 * put an incarnation on a subject the contract reserves for a stable identity,
 * and showcase would draw a new agent every time a window was reopened.
 */
function publishPresence(paneid: string, activityState: string): void {
  const state = presence.presenceStateOf(activityState); // waiting-seen -> waiting (ticket)
  /* The hosted set may have just changed (attach, adopt, activity on a newly
     adopted row, end). Debounced and de-duped inside, so nudging on every
     presence publish costs one comparison and never a redundant frame. */
  fabricSub.refresh();
  const row = table.get(paneid) as any;
  if (!row?.agent) {
    return;
  }
  /* CHECK IN on the same moments presence fires (spawn/attach, adopt, reclaim,
     activity): de-duped inside, never awaited, never fatal — a fabric that is
     down or refuses leaves the pane exactly as it was before check-in existed. */
  void fabricCheckin.ensure(paneid);
  const recipe = row.recipe_id ? (table.getRecipe(row.recipe_id) as any) : null;
  presence.publish({
    slug: row.agent,
    /* ALWAYS PRESENT, NEVER GUESSED (§9 brand join key). A row with no vendor
       recorded used to read `cli-manager`, which is a CLAIM about the session's
       class; `unknown` says what is true, and the renderer resolves it to the
       `generic` mark rather than to the shell brand. */
    vendor: row.vendor || 'unknown',
    node: nodeOfTarget(recipe?.target),
    paneid,
    state,
    attached: (sessions.get(paneid)?.viewers.size ?? 0) > 0,
    ...(recipe?.projectDir ? { project: recipe.projectDir as string } : {}),
    ts: new Date().toISOString(),
  });
}

/** The pane's process is gone. Read the row BEFORE it is torn down. */
function publishPresenceEnded(paneid: string): void {
  /* The hosted set may have just changed (attach, adopt, activity on a newly
     adopted row, end). Debounced and de-duped inside, so nudging on every
     presence publish costs one comparison and never a redundant frame. */
  fabricSub.refresh();
  const row = table.get(paneid) as any;
  if (!row?.agent) {
    return;
  }
  const recipe = row.recipe_id ? (table.getRecipe(row.recipe_id) as any) : null;
  presence.end({
    slug: row.agent,
    vendor: row.vendor || 'unknown', // see publishPresence
    node: nodeOfTarget(recipe?.target),
    paneid,
    ...(recipe?.projectDir ? { project: recipe.projectDir as string } : {}),
    ts: new Date().toISOString(),
  });
}

/** The target a session's pty was spawned on: its row's `server` (the
 *  spawn-time fact, matched as brokerHostOfServer matches it), else its
 *  recipe's target. Undefined when neither names a known target. */
function targetOfRow(row: { server: string; recipe_id: string | null }): Target | undefined {
  const all = loadTargets();
  const bySrv = all.find((x) => (x.sshAlias ?? x.id) === row.server || x.id === row.server);
  const recipe = !bySrv && row.recipe_id ? (table.getRecipe(row.recipe_id) as any) : null;
  return bySrv ?? (recipe?.target ? all.find((x) => x.id === recipe.target) : undefined);
}

/** Guard 9's question for one pane: which claude owns its terminal / 'none' /
 *  'not-repl' / null (could not tell — the pane's pty is not on this host, or
 *  /proc is unreadable). */
/**
 * Room Disconnect ([ticket], assemble-room F1/F2): end one live pane with
 * EndReason 'cycle' (onExit files it dehydrated for a resumable vendor) and
 * wait up to 5 s for the exit to be filed. Then, when the pty runs on THIS
 * host, look for a claude still carrying the paneid or its conversation id.
 * An orphan is REPORTED, never killed (Owner decides); a stopped one (state T)
 * is named by its state. null = could not tell; absent = not checked here.
 */
async function endForCycle(
  paneid: string,
): Promise<{ ended: boolean; state: string | null; orphan?: { pid: number; state: string } | 'none' | null }> {
  const resident = sessions.get(paneid);
  if (!sessions.isLive(resident)) {
    return { ended: false, state: table.get(paneid)?.state ?? null };
  }
  const before = table.get(paneid);
  const ids = [before?.session_id].filter((x): x is string => typeof x === 'string' && x !== '');
  resident.endReason = 'cycle';
  killCli(resident.cli);
  for (let i = 0; i < 50 && table.get(paneid)?.state === 'live'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const state = table.get(paneid)?.state ?? null;
  if (state !== 'live') {
    table.markDisconnected(paneid); // a deliberate disconnect: a re-attaching view must not restore it
  }
  const t = before ? targetOfRow(before) : undefined;
  if (!t || !channels.ptyRunsHere(t)) {
    return { ended: state !== 'live', state };
  }
  let orphan: { pid: number; state: string } | 'none' | null = null;
  try {
    const c = procClassifier.classify({ paneid, ids, phase: 'ended' });
    if (c) {
      const hit = c.collisions.find((p) => p.state === 'T' || p.state === 't') ?? c.collisions[0];
      orphan = hit ? { pid: hit.pid, state: hit.state } : 'none';
    }
  } catch {
    orphan = null;
  }
  return { ended: state !== 'live', state, orphan };
}

/* Sockets that attached as a ROOM's own framed view of a seat (attach
   `roomFrame: true`). Weak: a socket that closes simply falls out. */
const roomFrameSockets = new WeakSet<object>();
/** A resident's viewers that are real windows / tabs (not room frames). */
function windowSockets(r: sessions.Resident | undefined): WebSocket[] {
  return r ? [...r.viewers].filter((v) => !roomFrameSockets.has(v)) : [];
}

/** A resident's viewers that are a room page's own framed view of the seat. */
function frameSockets(r: sessions.Resident | undefined): WebSocket[] {
  return r ? [...r.viewers].filter((v) => roomFrameSockets.has(v)) : [];
}

/**
 * The seat menu's Close window (rooms.ts closeSeatWindow, Owner 2026-09-28):
 * close every window showing this pane and KEEP the session.
 *   1. PARK first, the same pin the `park` message sets (reap 0 = never), so
 *      the socket closes that follow cannot arm the close-grace reaper; also
 *      when a room frame stays attached (its later detach must not either).
 *   2. Push pane.close-window to every WINDOW socket; every ROOM-FRAME socket
 *      gets pane.frame-closed instead (Owner 2026-10-03: the room page that
 *      frames the seat switches to the room chat, never a blank column; the
 *      frame stays attached until the page drops it): a solo page closes itself, a shell tab
 *      asks its shell to drop it, a page that cannot close says so and lets
 *      go of its socket.
 *   3. A native window agent holding the pane is asked to close it too
 *      ('park'); no agent / not held is simply `native: false`.
 * Then waits up to 2 s for the sockets to go, so the room's re-read after the
 * answer already shows the seat parked with no window.
 */
async function closeWindowsOf(paneid: string): Promise<{ browser: number; native: boolean }> {
  const resident = sessions.get(paneid);
  let browser = 0;
  if (resident) {
    const windows = windowSockets(resident);
    /* ALWAYS park, even while a room frame stays attached: when that frame
       later detaches (the room navigates away) it is the LAST viewer, and an
       unpinned session would then arm the close-grace reaper, breaking "the
       session keeps running". The pin only guards the reaper, so it is
       harmless while a frame still views it. */
    resident.reapOverrideMs = 0;
    const frames = resident.viewers.size - windows.length;
    log(`park paneid=${paneid} (close-window from a room, session pinned${frames ? `; ${frames} room frame(s) stay attached` : ''})`);
    browser = windows.length;
    for (const v of windows) {
      send(v, { type: 'pane.close-window', paneid });
    }
    for (const v of frameSockets(resident)) {
      send(v, { type: 'pane.frame-closed', paneid });
    }
  }
  let native = false;
  try {
    const held = (await desktop.inventory()).some((w) => w.tabs.some((t) => t.paneid === paneid));
    if (held) {
      const r = await desktop.close(paneid, 'park');
      native = r.ok;
    }
  } catch (err) {
    log(`close-window paneid=${paneid}: native close failed: ${(err as Error).message}`);
  }
  for (let i = 0; i < 20 && resident && windowSockets(resident).length > 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { browser, native };
}

function paneClaudeOwner(paneid: string, cached: boolean): procClassifier.ClaudeRead {
  const row = table.get(paneid);
  const t = row ? targetOfRow(row) : undefined;
  return t && channels.ptyRunsHere(t) ? procClassifier.claudeOwner(paneid, { cached }) : null;
}

/** Which broker holds a row's PTY, derived from its `server` column via the
 *  target list (no schema change): target.broker ?? 'local'. */
function brokerHostOfServer(server: string): string {
  const t = loadTargets().find((x) => (x.sshAlias ?? x.id) === server || x.id === server);
  return t?.broker ?? 'local';
}

interface IncomingMsg {
  type?: string;
  paneid?: string;
  component?: string;
  recipe?: string; // attach a saved-launch (CLI Manager) pane instead of a component
  data?: string;
  cols?: number;
  rows?: number;
  model?: string; // attach-time model override for a claude spawn (from ?model= on the solo URL)
  effort?: string; // attach-time --effort override, same rules (from ?effort=)
  friendlyName?: string; // park (hide-window verb) carries only paneid
  roomFrame?: boolean; // attach: this page is a room's own framed view of a seat (solo.js inroom / roomframe)
  color?: string;
  fg?: string;
  bg?: string;
  watermark?: string;
  project?: string;
  fontSize?: number; // terminal font size (px) — a per-pane pref channel
  logo?: string; // ghosted CLI logo as a JSON string ('' clears it) — a per-pane pref channel
  name?: string; // for `address`
  url?: string; // for `url-offer-dismiss` (absent = dismiss all)
  id?: string; // client correlation id for `result`; also `fabric-dismiss` (absent = dismiss all)
  how?: string; // `attention.ack`: what counted as attention (input | focus | pointer)
  spawn?: boolean; // attach: a human asked for a CLI here (Relaunch). A page load never sets it.
  /** Control lease (2026-08-19). Three intents, and the third one matters:
   *   · `control` (or absent) — take the keyboard, pausing whoever holds it.
   *     The default keeps every pre-lease client working unchanged.
   *   · `view` — watch only, never take.
   *   · `reclaim` — take it ONLY IF NOBODY HOLDS IT. This is what a RECONNECT
   *     must use. The engine releases control when a controller's socket drops,
   *     so a two-second network blip leaves the lease free and the returning
   *     client should simply pick it back up with no friction. But a laptop
   *     that hibernated for an hour may find the VRPC driving, and in that case
   *     it must NOT take it back — it attaches as a viewer and offers.
   *     Reconnecting with `control` (which is what a missing intent means) is
   *     how a woken browser silently stole a live session. */
  intent?: 'control' | 'view' | 'reclaim';
  label?: string;
  rooms?: unknown; // `room.subscribe`: the FULL set of room ids this socket follows (workrooms §2.3)
  reattachOnly?: boolean; // attach: join a LIVE session only, never spawn or resume (W3b /term; src/server/term.ts)
}

/* Boot gate (vk [ref]): the HTTP/WS server accepts connections BEFORE the
 * listen callback's reconcile+adoption pass finishes — a client spawning in
 * that gap would then be clobbered by adoption (seen in tests: adopted its
 * own fresh pane, nulling the socket). Every WS message waits for boot. */
let bootReadyResolve: () => void;
const bootReady = new Promise<void>((r) => {
  bootReadyResolve = r;
});

/** Wire a resident's pty→socket pump once (handlers close over the resident,
 *  not the socket, so a reattach keeps pumping to whatever socket is currently
 *  bound). Module-level so boot adoption (broker-held sessions) reuses it. */
function bindResident(resident: sessions.Resident, paneid: string): void {
  resident.onData = resident.cli.pty.onData((data) => {
    sessions.pushOutput(resident, data);
    activity.onData(paneid, data);
    /* The gate first: the dialog watcher settles on the gate's position
       counter (guard 6d), so the gate must have counted this chunk. */
    startupGate.onPtyData(paneid, data); // S0: detect-only; a no-op unless armed
    geminiGate.onPtyData(paneid, data); // ticket: gemini-cli's own gate; a no-op unless armed
    promptBlock.onPtyData(paneid, data); // ticket: "needs you" (login/permission/question); after geminiGate, which it reads; detect-only
    channels.onPtyData(paneid, data); // dialog auto-accept; a no-op unless armed
    broadcast(resident, { type: 'pane.data', paneid, data });
    vscreen.feed(paneid, data); // P0 shadow: enqueue only, never throws; last, after viewers
  });
  resident.onExit = resident.cli.pty.onExit(({ exitCode }) => {
    /* WHY it ended decides how it is filed.
     *
     * A session the user ENDED stays `killed` and must never come back on its
     * own. A session we REAPED for idleness is a different fact: nobody chose
     * it, the transcript is still on disk, and `dehydrated` is exactly the
     * state the attach path already knows how to resume. Filing both as
     * `killed` is what left Owner with five brand-new empty conversations after
     * a 12h timer fired overnight (2026-08-24).
     *
     * This mirrors the rule boot-reconcile has always used for stale rows —
     * claude-code is restorable, everything else is not. */
    spawnGuard.noteEnded(paneid); // S0 guard 7: the just-ended wait counts from here
    const endedRow = table.get(paneid);
    const endedSeat = table.seatOfPane(paneid);
    causes.record({ kind: 'seat-exit', code: causes.exitCodeOf(resident.endReason, exitCode), exit_code: resident.endReason ? null : exitCode, vendor: endedRow?.vendor, handle: endedSeat?.handle, room: endedSeat?.room_id }); // the causes feed
    const restorable = endStateFor(resident.endReason, endedRow?.vendor) === 'dehydrated';
    table.setState(paneid, restorable ? 'dehydrated' : 'killed');
    /* The ended verdict (ok|fail on /api/table): only a process that ended ON
       ITS OWN has one. A kill's exit code is the signal we sent, not the
       program's answer, so End / reap record null ("no verdict"). */
    table.setExitCode(paneid, resident.endReason ? null : typeof exitCode === 'number' ? exitCode : null);
    if (restorable) {
      log(`reaped ${paneid} filed DEHYDRATED (resumable) — reopening will restore it`);
    }
    /* BEFORE activity.drop and the table teardown: `ended` is published off the
       row, and the row still names the slug at this instant. */
    publishPresenceEnded(paneid);
    activity.drop(paneid);
    urlOffers.delete(paneid);
    handoffs.delete(paneid); // the session is over; its secrets go with it
    fabric.drop(paneid); // ...and so do its undelivered envelopes
    fabricSub.dropPane(paneid); // ...and the `seen` acks nobody is going to owe
    fabricCheckin.drop(paneid); // ...and its fabric instance (the row keeps the slug hint)
    paneTokens.revoke(paneid, 'ended'); // ...and its pane token: it lives exactly as long as this process
    btTools.drop(paneid); // ...and what we knew about its room tools
    btLaunch.removeFiles(paneid); // ...and its bt config and role file
    mcpCalls.endPane(paneid); // ...and its MCP calls: warn/interrupted, to the viewers still here
    // Linux bad-spawn divergence (platform, vk [ref]): a missing binary
    // forks fine and dies in the CHILD — exit≠0, no output, no `error`
    // event (Windows throws synchronously instead). Surface it as a launch
    // failure, not a mysterious instant exit.
    if (exitCode !== 0 && resident.bufferBytes === 0 && Date.now() - resident.spawnedAt < 3000) {
      broadcast(resident, {
        type: 'pane.error',
        paneid,
        message: `launch failed (exited ${exitCode} with no output — bad binary/cwd on the session's host?)`,
      });
    }
    broadcast(resident, { type: 'pane.exit', paneid, code: exitCode });
    sessions.remove(paneid);
    log(`exit ${resident.cli.id} code=${exitCode}`);
  });
}

/** Broadcast to EVERY viewer of a pane (controller included). Output is not
 *  private to whoever holds the keyboard — that is what makes a read-only
 *  viewer (an iPad following a run) possible. */
function broadcast(r: sessions.Resident, msg: Record<string, unknown>): void {
  for (const v of r.viewers) {
    send(v, msg);
  }
}

/** Tell every viewer who holds control and whether THEY are the one — the
 *  input for "you have control" vs "paused — <who> has it, [Resume]". */
function announceControl(r: sessions.Resident): void {
  /* `lastHolder` is who WAS driving when nobody is right now — the difference
     between "this session is free" and "your laptop was driving it and the
     engine restarted". Saying the second thing is the whole point: "no one is
     driving" was baffling to read about a session Owner had been using seconds
     earlier. */
  const lastHolder = r.controllerLabel ? null : (table.get(r.paneid)?.last_controller ?? null);
  for (const v of r.viewers) {
    send(v, {
      type: 'pane.control',
      paneid: r.paneid,
      holder: r.controllerLabel,
      lastHolder,
      controlling: v === r.socket,
    });
  }
}

/** Hand control of a pane to `ws`, pausing whoever had it.
 *
 *  THE RULE (Owner, 2026-08-19): exactly one machine drives a session at a time.
 *  Before this, a second attach did `existing.socket = ws` and the displaced
 *  viewer was never told — its screen froze while its keystrokes still reached
 *  the pty. Now the loser is explicitly paused and gets a Resume button, and
 *  taking control back is the same handshake in reverse. */
function grantControl(r: sessions.Resident, ws: WebSocket, label: string): void {
  const previous = r.socket;
  if (previous === ws) {
    r.controllerLabel = label;
    announceControl(r);
    return;
  }
  r.socket = ws;
  r.controllerLabel = label;
  table.setLastController(r.paneid, label); // survives an engine restart
  if (previous) {
    send(previous, { type: 'pane.control-lost', paneid: r.paneid, holder: label });
  }
  announceControl(r);
  log(`control paneid=${r.paneid} → ${label}${previous ? ' (paused the previous holder)' : ''}`);
}

/** Engine→client ws.ping cadence; a peer is terminated after two missed.
 *  Bounded above by setInterval's 32-bit limit: Node turns anything larger
 *  into a 1 ms interval, which would terminate every remote window within
 *  milliseconds. Out of range or not a number = the 30 s default. */
const WS_PING_ENV = Number(process.env.HARBOR_WB_WS_PING_MS);
const WS_PING_MS = WS_PING_ENV > 0 && WS_PING_ENV <= 2_147_483_647 ? WS_PING_ENV : 30_000;

wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
  /* Who this viewer IS, for the "paused — <who> has control" message. The
     client sends it on attach; absent, fall back to where it connected from,
     which at least distinguishes this machine from a remote one. */
  /* Behind Serve the socket is always loopback, so ask for the FORWARDED
     address — otherwise every remote viewer is labelled "this machine". */
  const remote = tailnet.clientAddress(req.socket.remoteAddress, req.headers) ?? '';
  /* WHERE it connected from, resolved to a tailnet hostname. This is the half a
     client cannot supply: two machines running the same OS both describe
     themselves as "Windows browser", so the self-description alone never
     answers "which machine has my keyboard". */
  const device = tailnet.deviceFor(remote) ?? `remote ${remote.replace('::ffff:', '')}`;
  let clientLabel = device;
  try {
    const p = identity.resolveIdentity(req);
    if (humanCredential(req, p)) {
      socketPerson.set(ws, pictureOwner(p).key);
    }
  } catch {
    /* no person: no personal pushes on this socket */
  }
  // paneids this socket is currently the viewer for. On close we detach each.
  const attached = new Set<string>();

  /* ENGINE-SIDE LIVENESS (2026-09-23, workrooms T5) — the other half of the window's JSON
   * ping/pong heartbeat (web/transport.mjs). That half lets a PAGE give up on a
   * stalled socket; nothing let the ENGINE give up on a stalled page, so a
   * window whose flow was blackholed (a sleeping laptop, a NAT rebind) stayed
   * `attached` and kept the control lease until the kernel's TCP timeout —
   * the manager said "windowed" about a dead window and a reclaim from the
   * real machine met a holder that was not there.
   *
   * Protocol-level ws.ping, which every browser answers on its own, so the
   * wire vocabulary the window speaks is unchanged. ANY inbound frame counts
   * as proof (the client's own rule). Two unanswered pings = dead:
   * terminate(), which fires the SAME 'close' handler a clean close does —
   * detach, release the lease, drop the room set. The pty stays resident. */
  let unanswered = 0;
  const alive = (): void => {
    unanswered = 0;
  };
  ws.on('pong', alive);
  ws.on('message', alive);
  const beat = setInterval(() => {
    if (unanswered >= 2) {
      log(`WS peer ${clientLabel} missed ${unanswered} pings — terminating (detach + lease release)`);
      ws.terminate();
      return;
    }
    unanswered++;
    try {
      ws.ping();
    } catch {
      /* closing; the close handler clears this interval */
    }
  }, WS_PING_MS);

  /** attach: view a pane — reattach to a resident session or spawn a new one. */
  async function handleAttach(
    paneid: string,
    componentId: string | undefined,
    recipeId: string | undefined,
    /** Per-launch {model, effort} from the window's url (the launch answer's
     *  path) — beat the recipe's for this spawn only, never written back. */
    overrides: { model?: unknown; effort?: unknown } = {},
    wantsControl = true,
    /** The client says a human deliberately asked for a CLI here (the window's
     *  own Relaunch button). A page LOAD never sets this — see spawnPermits. */
    explicitSpawn = false,
    /** W3b /term: the grant named a LIVE pane; if it ended meanwhile, refuse
     *  rather than spawn or resume one from a terminal grant. */
    reattachOnly = false,
  ): Promise<void> {
    /* A SOCKET THAT CLOSED WHILE THIS ATTACH WAITED (the guard 7 mutex behind
       another attach's spawn, the boot wait) must not become a viewer or a
       controller: its close handler has already run, and only walks what
       `attached` held then (S0 ride fix). Nothing is lost by returning here —
       no permit has been taken, no row touched; the reload that follows
       attaches with a live socket. */
    if (ws.readyState !== ws.OPEN) {
      log(`attach dropped paneid=${paneid}: its socket closed while it waited`);
      return;
    }
    const existing = sessions.get(paneid);

    if (sessions.isLive(existing)) {
      // REATTACH: a viewer returned to a session that outlived its old socket.
      existing.viewers.add(ws);
      if (wantsControl) {
        grantControl(existing, ws, clientLabel);
      } else {
        // A watch-only viewer must STILL be told the control state — otherwise
        // it cannot render "paused — <who> has control [Resume]" and would look
        // like a broken terminal that swallows keystrokes. Announcing to all
        // (not just this socket) also refreshes everyone's holder label.
        announceControl(existing);
      }
      sessions.cancelReap(existing);
      if (paneid.startsWith('recipe:')) {
        existing.reapOverrideMs = CLOSE_KILL ? SOLO_GRACE_MS : undefined; // see CLOSE-KILL RETIRED
      }
      attached.add(paneid);
      activity.onLive(paneid);
      publishPresence(paneid, activity.get(paneid) ?? 'idle'); // attached = true now
      send(ws, {
        type: 'pane.ready',
        paneid,
        sessionId: existing.cli.id,
        state: existing.cli.state,
        reattached: true,
        prefs: prefsOf(paneid),
        title: titleOf(paneid),
        vendor: vendorOf(paneid),
        activity: activity.get(paneid) ?? 'idle',
        held: roomTyper.heldFor(paneid), // same shape as pane.held; null = nothing waits
        mcp: mcpCalls.inFlight(paneid), // the pane.mcp starts still open (ticket)
      });
      send(ws, { type: 'pane.data', paneid, data: sessions.replay(existing) }); // rebuild screen
      send(ws, { type: 'pane.reattached', paneid });
      const pendingUrls = urlOffers.get(paneid);
      if (pendingUrls?.length) {
        send(ws, { type: 'pane.url-offer', paneid, urls: [...pendingUrls] });
      }
      /* A phone reload must not lose the password the agent just handed over —
         the badge is re-armed from the engine, exactly like the url offers. */
      const pendingHandoffs = liveHandoffs(paneid);
      if (pendingHandoffs.length) {
        send(ws, { type: 'pane.handoff', paneid, bundles: pendingHandoffs });
      }
      /* FLUSH THE INBOX. An envelope that arrived while nobody was attached has
         been sitting in memory waiting for exactly this moment — same re-arming
         as the url offers and the handoff badge above, for the same reason: a
         phone reload must not be how a message is lost. */
      const pendingFabric = fabric.pendingFor(paneid);
      if (pendingFabric.length) {
        send(ws, { type: 'fabric.message', paneid, messages: pendingFabric });
      }
      { const pv = voice.paneVoice(paneid); if (pv) send(ws, pv); } // voice (ticket): whole state on attach; null when HARBOR_WB_VOICE is off
      /* The window needs the tool's status to reach the tab chrome, and a
         reattach is the one moment it has none. Cleared first so the diff in
         pushWidget cannot suppress the send to a viewer that has never had it. */
      lastWidgetSent.delete(paneid);
      pushWidget(paneid, table.get(paneid)?.recipe_id ?? null);
      log(`reattach paneid=${paneid} → ${existing.cli.id}`);
      return;
    }
    if (reattachOnly) {
      send(ws, { type: 'pane.needs-launch', paneid, state: table.get(paneid)?.state ?? null, message: 'This session is not running.' });
      return;
    }

    /* SPAWN: first viewer for this pane, OR the prior session ended — and
       those are NOT the same thing, which is the whole point of the permit.
       A woken browser reloading a stale tab sends the identical attach, so
       without this the reload re-created an ENDED pane as an empty CLI and the
       manager gained a session that had never held a conversation.
       Refuse quietly; the table is left exactly as it was, so whatever the row
       says still says it, and the CLI Manager can still resume from there.

       THE TEST IS "WOULD THIS CREATE A SESSION WITH NO HISTORY", not "is this
       a spawn". Three cases must still go through untouched:
         · no row at all — this pane has never run, so nothing can be lost and
           a first open is exactly what it looks like;
         · a restorable row — `--resume` brings the conversation BACK, which is
           the outcome we want a reload to reach (Owner: "if it was snoozed
           return to snooze");
         · an explicit human act — the launch endpoint's permit, or the
           window's own Relaunch button.
       What is left is the case that lost his work: a pane with a history that
       cannot be resumed. */
    const priorRow = table.get(paneid);
    /* `dehydrated` IS the table's word for "this can come back", and it is the
       only test that belongs here. Deriving it instead (resumable vendor AND a
       banked uuid) refused the NAMED-RESUME panes, whose `session_id` is NULL
       by design because their id is unknowable — the row is dehydrated and the
       recipe's own `--resume "<name>"` restores it. `corrupted` is never
       resumed (Seam C2) and `killed` means ended, so both stay refused. */
    const restorable = priorRow?.state === 'dehydrated';
    /* A DELIBERATE DISCONNECT IS NOT A CRASH (Owner 2026-10-01). The restorable
       exception above exists so a reload after a crash or an engine restart
       brings the conversation back. A room Disconnect files the same
       `dehydrated` — so every view still showing that terminal (the room's
       framed view of the selected seat, an open tab) re-attached and restored
       it within seconds: "I see them exit and then immediately get logged back
       in". A row stamped `disconnected_at` comes back only by an explicit act:
       a launch permit (Restore / Start / reload) or the window's own Relaunch. */
    const userDisconnected = restorable && priorRow?.disconnected_at != null;
    if (!explicitSpawn && priorRow && (!restorable || userDisconnected) && !takeSpawnPermit(paneid)) {
      log(
        userDisconnected
          ? `attach REFUSED (disconnected by the user; needs Restore) paneid=${paneid}`
          : `attach REFUSED (would create an empty session) paneid=${paneid} row=${priorRow.state}`,
      );
      send(ws, {
        type: 'pane.needs-launch',
        paneid,
        state: priorRow.state,
        message: userDisconnected
          ? 'This session was disconnected. Restore it from its seat or the Workbench.'
          : 'This session is not running. Reopen it from the Workbench.',
        /* Nothing runs here, so nothing is in flight (ticket): a window that
           slept through the end missed endPane's end frames and must drop the
           chips it still shows. Same shape as pane.ready's `mcp`. */
        mcp: [],
      });
      return;
    }

    let descriptor: CliDescriptor;
    let vendor: string;
    /** THE STABLE LOGICAL IDENTITY of whatever runs in this pane (E1). Comes
     *  from the recipe; a bare component pane has none and stays silent. */
    let agentSlug: string | null = null;
    let server = 'local';
    let inject: string | undefined;
    let reapOverrideMs: number | undefined;
    let claudeSessionId: string | null = null; // vendor session fact (uuid), NOT the cli-N pty id
    /** The resume NAME this session launched with, remembered on its row so it
     *  never has to re-derive it from a project default that may have changed. */
    let resumeNameUsed: string | null = null;
    /* The profile to bank on the row once the spawn lands (null = it has one). */
    let profileToWrite: { model: string | null; effort: string | null } | null = null;
    let restored = false;
    let ackCwd: string | null = null; // local project dir to ACK the transcript in
    let brokerHost = 'local'; // which broker link holds the PTY (vk [ref])
    let channelOn = false; // this launch carries the dev-channels flag (S0 startup block)
    /** How this pane gets its pane token, if it gets one (pane-tokens.ts). */
    let tokenDelivery: paneTokens.Delivery = 'none';
    /** E1 (bt-launch.ts): this launch carries the bt room tools; a local codex pane also needs the token in its env. */
    let btPlanned = false;
    let btAlsoEnv = false;
    let btWhy = 'off';

    if (recipeId) {
      // Saved-launch pane (CLI Manager). The PTY is always local; a remote
      // target is a local `ssh -t <alias> ...` (identity rides the ssh alias).
      const recipe = table.getRecipe(recipeId);
      /* Both refusals are LOGGED as well as sent (2026-09-18). A Kiosk launch
         failed with "unknown target: homebase-svc-ops" and the engine's own log
         showed only a successful launch — the error existed in one browser tab
         and nowhere else, which is the "the news existed and the transport
         dropped it" shape again. */
      if (!recipe) {
        log(`attach REFUSED paneid=${paneid}: unknown recipe ${recipeId}`);
        send(ws, { type: 'pane.error', paneid, message: `unknown recipe: ${recipeId}` });
        return;
      }
      const target = loadTargets().find((t) => t.id === recipe.target);
      if (!target) {
        log(`attach REFUSED paneid=${paneid}: recipe "${recipe.name}" names unknown target "${recipe.target}" (targets.json)`);
        send(ws, { type: 'pane.error', paneid, message: `unknown target: ${recipe.target}` });
        return;
      }
      // CRASH RESTORE (ticket): a dehydrated claude row means the conversation
      // outlived a dead engine — reopen THAT session (`--resume <uuid>`) instead
      // of launching the recipe fresh. Consumer rule (Seam C2): a `corrupted`
      // row is never resumed; only `dehydrated` qualifies.
      const row = table.get(paneid);
      /* A SEAT'S OWN WORKTREE (Owner 2026-10-05, worktree convention, KB
         design-notes-id §12): this session's cwd is its worktree, not the
         recipe's project dir - for the spawn, the transcript locate and the
         ACK alike (transcripts are keyed by cwd). A worktree that has vanished
         is refused, never quietly replaced by the main checkout. */
      const wtRow = table.getSessionWorktree(paneid);
      const wtPath = wtRow ? worktreePath(wtRow.project, wtRow.name) : null; // stored relative; resolved against the root NOW
      if (wtRow && wtPath) {
        await repairWorktree(wtRow.project, wtRow.name); // a moved root: re-point its links
        if (!existsSync(wtPath)) {
          log(`attach REFUSED paneid=${paneid}: its worktree ${wtPath} is missing`);
          send(ws, { type: 'pane.error', paneid, message: `this seat's worktree is missing: ${wtPath}` });
          return;
        }
      }
      const cwdDir = wtPath ?? recipe.projectDir;
      let restoreId =
        row?.state === 'dehydrated' && isResumableVendor(row.vendor) && row.session_id
          ? row.session_id
          : null;
      /* LOCATE IS THE VENDOR'S, AND MOST VENDORS DO NOT HAVE ONE. An absent
         `locate` is the contract's way of saying "this brand cannot follow a
         lineage yet" (§5.1) — so we skip it rather than asking claude's
         implementation about another brand's files. */
      const locate = vendorFor(row?.vendor)?.locate;
      if (restoreId && cwdDir && locate) {
        // Locate-refresh (vk [ref]): resolve the CURRENT incarnation of the
        // banked lineage before resuming — normally the banked id itself, but
        // it tracks a fork if one ever happened. Null = nothing links (e.g.
        // transcript deleted); keep the banked id and let the resume fail
        // visibly in the pane rather than silently launching fresh.
        //
        // SELF-HOSTED POLARITY (2026-09-17): see remoteFsAccess in launch.ts —
        // a self-hosted `kind:'ssh'` target (homebase-resident) locates locally
        // instead of ssh-ing to itself.
        const access = remoteFsAccess(target);
        if (access.mode === 'unreachable') {
          log(`restore locate: ${access.reason} (paneid=${paneid}) — resuming banked id anyway`);
        } else {
          const located = await locate({
            banked: restoreId,
            projectDir: cwdDir as string,
            ...fsOptsFor(access),
          });
          if (located && located !== restoreId) {
            log(`restore locate: lineage moved ${restoreId} → ${located} (paneid=${paneid})`);
            restoreId = located;
          } else if (!located) {
            if (neverWritten({ access: access.mode, transcriptPath: vendorFor(row?.vendor)?.transcriptPath, cwd: cwdDir as string, sessionId: restoreId, exists: existsSync })) {
              /* banked at launch, never written (the launch ended at the trust prompt): there is nothing to resume */
              log(`restore locate: no transcript was ever written for ${restoreId} (paneid=${paneid}) — starting fresh`);
              restoreId = null;
            } else {
              log(`restore locate: no transcript links to ${restoreId} (paneid=${paneid}) — resuming banked id anyway`);
            }
          }
        }
      }
      /* HOW THIS SESSION RESUMES — resolved HERE, not inside buildInvocation.
       *
       * Precedence: uuid > name > fresh, and the state gate applies to BOTH
       * resume forms. It used to apply only to the uuid branch: the name branch
       * read `recipe.resume` unconditionally, so a session the user
       * deliberately ENDED came back on the next attach, and a SECOND session
       * in a named-resume project re-ran `--resume "<same name>"` — two
       * processes appending to one transcript.
       *
       * A session remembers its own resume name once it has one. A pane with NO
       * row yet inherits the project's default ONLY if it is the project's
       * PRIMARY pane: an additional session (`recipe:<id>#<short>`) is new work
       * by definition, never a second copy of the project's named conversation.
       */
      const isPrimaryPane = paneid === `recipe:${recipeId}`;
      let resumeName: string | null = null;
      /* `vendorFor` rather than `runClaude`: the named-resume flow is not a
         claude feature, it is what EVERY resumable brand without a mintable id
         restores through — for gemini-cli it is the only restore there is
         (`--resume latest`). Identical for the two vendors that predate the
         registry. */
      if (!restoreId && vendorFor(recipe.vendor)) {
        const remembered = row?.resume_name ?? null;
        const inherited = isPrimaryPane && recipe.resume ? (recipe.resumeName ?? '') : null;
        const candidate = remembered ?? inherited;
        /* `killed` means the user ended it and it must never auto-resume — the
         * same rule end-state.ts applies to the uuid path. A row that does not
         * exist yet is a first launch, which may inherit. */
        const stateAllows = !row || row.state === 'dehydrated' || row.state === 'live';
        resumeName = candidate !== null && stateAllows ? candidate : null;
        resumeNameUsed = resumeName;
      }

      /* S0 GUARD 7 (assemble-room §4.4 item 7): on a restore, refuse to start
         a second claude on a conversation one is still writing — synchronous
         from here to link.spawn but for the just-ended wait. Could not tell →
         proceed as today (spawn-guard.ts). */
      if (restoreId || resumeName !== null) {
        const verdict = await spawnGuard.check(
          { paneid, ids: [row?.session_id ?? '', restoreId ?? ''], local: channels.ptyRunsHere(target) },
          spawnGuardDeps,
          (pid) => send(ws, { type: 'pane.data', paneid, data: `\r\n\x1b[2m[waiting for the previous claude to stop (pid ${pid})]\x1b[0m\r\n` }),
        );
        if (!verdict.ok) {
          send(ws, { type: 'pane.error', paneid, message: verdict.message, collision: { owner: verdict.owner, pid: verdict.pid, openIn: verdict.openIn, lstart: verdict.lstart } });
          return;
        }
      }
      /* THE AGENT'S PROFILE TRAVELS WITH IT (Owner 2026-10-02, room line [ref]).
         A pane that already has a stored {model, effort} relaunches on THAT —
         restore, --resume, named resume, a room reconnect that sends no
         override — so a Disconnect/Reconnect never resets it to the project
         default, and a later change to the project default never moves an
         existing agent. The window url's override (the launch answer's path)
         applies only to a pane with no profile yet (a new mint, or a legacy
         row), and is then banked on the row below. Never written to the saved
         recipe. See resolveLaunchProfile for the precedence. */
      const prof = resolveLaunchProfile(row, recipe, overrides);
      if (prof.write) {
        profileToWrite = { model: prof.model, effort: prof.effort };
      }
      const effectiveRecipe = { ...recipe, projectDir: cwdDir, model: prof.model, effort: prof.effort };
      // paneid: R11 — the spawned CLI is told which pane it is (and its slug
      // and brand) through its environment. See launch.sessionEnv.
      /* HARBOR_WB_CHANNELS: a claude pane on this host gets the fabric channel
         (per-pane MCP config + launch flags) on fresh launch AND restore; null
         = launched exactly as before. */
      const channelConfig = channels.prepareLaunch({
        vendor: effectiveRecipe.vendor || (effectiveRecipe.runClaude ? 'claude-code' : 'cli-manager'),
        target,
        paneid,
        slug: (recipe as any).agent ?? null,
      });
      channelOn = channelConfig !== null;
      /* A target config the vendor refuses (targets.json codex.launcher / codex.args) THROWS from
         buildLaunch; answered here, never engine-fatal and never a silent bare-CLI launch. */
      let spec: ReturnType<typeof buildLaunch>;
      /* E1: the bt room tools (and the role file) ride the SAME buildLaunch line. Planned only for a pane that gets a token FILE: a seatable pane whose pty runs here. */
      const btVendor = effectiveRecipe.vendor || (effectiveRecipe.runClaude ? 'claude-code' : 'cli-manager');
      const btPlan = btLaunch.planBt({
        enabled: btMcp.enabled() && paneTokens.isSeatable(recipeId, btVendor, (recipe as any).agent ?? null),
        vendor: btVendor,
        runsHere: channels.ptyRunsHere(target) && isSelfHosted(target),
        port: enginePort(),
        paneid,
        tokenFile: paneTokens.tokenFileFor(paneid),
        tokenInEnv: paneTokens.deliveryFor(target) === 'env',
      });
      let btExtra: string | null = null;
      if (btPlan.on) {
        try {
          const w = btLaunch.writeBtConfig(btPlan, typeof channelConfig === 'string' ? { mergeInto: channelConfig } : {});
          btExtra = btPlan.vendor === 'claude-code' ? w.claudeArgs : w.codexArgs;
          /* a token-in-env pane (the pane's account is not the engine's) cannot read a role file in the engine's config dir, and the role text has newlines a direct argv cannot carry: no role file for it */
          if (btPlan.vendor === 'claude-code' && !btPlan.tokenInEnv) {
            const seated = table.roomsForPane(paneid).find((h) => h.room.state === 'open');
            const roleSource = btLaunch.roleSourceFor(effectiveRecipe.projectDir, !!wtPath); // INTERIM: only an agents/<role> folder, and only when the seat runs elsewhere (a worktree)
            const roleFile = btLaunch.writeRoleFile(paneid, { roleSource, seatContext: seated ? seatWelcome.seatContextText(seated.room, seated.seat) : '' });
            if (roleFile) btExtra = `${btExtra} ${btLaunch.claudeRoleArgs(roleFile)}`;
          }
          btPlanned = true;
          btAlsoEnv = btPlan.envToo;
        } catch (e) {
          btWhy = 'config-not-written';
          log(`bt tools ${paneid}: config not written (${(e as Error).message}); launching without them`);
          btLaunch.removeFiles(paneid);
        }
      } else {
        btWhy = btPlan.reason;
      }
      try {
        spec = buildLaunch(effectiveRecipe, target, restoreId, resumeName, {
          paneid,
          channelConfig,
          worktree: wtPath ? { path: wtPath, base: join(dirname(wtPath), '_base') } : null,
          extraArgs: btPlanned ? btExtra : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`launch REFUSED for recipe "${recipeId}": ${message}`);
        send(ws, { type: 'pane.error', paneid, message: `launch refused: ${message}` });
        return;
      }
      /* H3 (any profile): a Claude launch in a folder the person put on the trust list starts with that folder pre-accepted (nothing is typed); any other folder shows Claude's own question. Only where this engine can
         write the account's ~/.claude.json (a self-hosted local target); in a split-account setup the person answers the dialog in the terminal. */
      if (effectiveRecipe.vendor === 'claude-code' && effectiveRecipe.projectDir && isFolderTrusted(effectiveRecipe.projectDir) && isSelfHosted(target) && target.kind === 'local') {
        try {
          const tr = trustFolder(trustKey(effectiveRecipe.projectDir), realTrustIo, claudeJsonPath());
          log(`folder trust ${paneid}: ${tr.state}`);
        } catch (e) {
          log(`folder trust ${paneid} failed: ${(e as Error).message}`);
        }
      }
      /* CODEX HOOKS FILE (2026-10-03): the pane's rings and its session id both
         come from hooks the engine writes into the project's .codex/ BEFORE the
         launch (the vendor passes --dangerously-bypass-hook-trust, sound only
         because we wrote the file). Only where this engine can write the
         project dir: a self-hosted, non-ssh target. Never fails the launch. */
      if (effectiveRecipe.vendor === 'codex-cli' && process.env.HARBOR_WB_HOSTED === '1') {
        log(`codex hooks ${paneid}: hosted — no hooks file is written into the user's repo (no rings)`);
      } else if (effectiveRecipe.vendor === 'codex-cli') {
        if (!effectiveRecipe.projectDir) {
          log(`codex hooks ${paneid}: no projectDir — launching without hooks (no rings)`);
        } else if (!isSelfHosted(target) || target.kind !== 'local') {
          log(`codex hooks ${paneid}: target ${target.id} is not on this host's disk — launching without hooks (no rings)`);
        } else {
          const h = ensureHooksFile(effectiveRecipe.projectDir, enginePort());
          if (h.status !== 'unchanged') {
            log(`codex hooks ${paneid}: ${h.status}${h.status === 'skipped' ? ` (${h.reason})` : ''} ${h.path}`);
          }
        }
      }
      descriptor = spec.descriptor;
      inject = spec.inject;
      server = spec.server;
      vendor = spec.vendor;
      claudeSessionId = spec.claudeSessionId;
      brokerHost = spec.brokerHost;
      restored = !!restoreId;
      agentSlug = (recipe as any).agent ?? null;
      /* §3.2: every SEATABLE pane gets a token, whatever its vendor — not only
         claude, not only channel panes. ssh panes get none (§3.3). */
      if (paneTokens.isSeatable(recipeId, vendor, agentSlug)) {
        tokenDelivery = paneTokens.deliveryFor(target);
      }
      /* ACK reads `transcriptPath`, which only ever looks at THIS engine's own
         disk (see claude-code.ts) — so it is only meaningful for a SELF-HOSTED
         target, not merely `kind:'local'`. A self-hosted `kind:'ssh'` target
         (homebase-resident) now gets the ACK it was silently skipping; a
         foreign-broker `kind:'local'` target (another polarity spot) stops
         polling for a transcript on the wrong host's disk. */
      if (isSelfHosted(target) && recipe.runClaude && cwdDir) {
        ackCwd = cwdDir;
      }
      reapOverrideMs = CLOSE_KILL ? SOLO_GRACE_MS : undefined; // see CLOSE-KILL RETIRED
      // Recipe theme → pane prefs, so the table row + pane.ready carry it.
      table.setPrefs(paneid, {
        friendlyName: recipe.name,
        color: recipe.color ?? undefined,
        fg: recipe.fg ?? undefined,
        bg: recipe.bg ?? undefined,
        watermark: recipe.watermark ?? undefined,
        project: recipe.projectDir ?? undefined,
        fontSize: recipe.fontSize ?? undefined,
        logo: recipe.logo ?? undefined,
      });
    } else {
      const components = await loadComponents();
      const manifest = components.find((c) => c.id === componentId);
      if (!manifest) {
        send(ws, { type: 'pane.error', paneid, message: `unknown component: ${componentId}` });
        return;
      }
      descriptor = manifest.descriptor;
      vendor = manifest.id;
    }

    /* GENERATION (§3.2): this spawn — fresh or a dehydrated -> live restore —
       is the pane's next process. Adoption never passes here, so an adopted
       pane keeps its generation and its token. Minted BEFORE the spawn (the
       token rides the spawn env), revoked again if the spawn fails. */
    const generation = (table.get(paneid)?.generation ?? 0) + 1;
    const minted = paneTokens.enabled() && tokenDelivery !== 'none' ? paneTokens.mint(paneid, generation, tokenDelivery, { alsoEnv: btAlsoEnv }) : null;
    if (minted) {
      descriptor = paneTokens.withToken(descriptor, minted.env);
    }
    // A failed spawn (bad binary, missing exe, permission) must NOT propagate:
    // this runs inside an async WS message handler, so an uncaught throw becomes
    // an unhandledRejection and takes the WHOLE engine down — killing every other
    // live pane, not just this one. Catch it, tell the client, keep serving.
    let session;
    try {
      // The PTY lives in a BROKER, never this process (vk [ref]) — routed per
      // target (vk [ref]: 'local' = VRPC loopback broker; a remote host name =
      // that host's broker over the tailnet). Throws loudly when the link
      // can't be ensured/reached (no silent fallback).
      const link = brokerClient.linkFor(brokerHost);
      if (!link) {
        throw new Error(`no broker configured for host '${brokerHost}' (config.json brokers)`);
      }
      /* S0 guard 7 (ii): this conversation is being resumed by this pane —
         set synchronously before the spawn, cleared on failure or 10 s later. */
      const unmark = restored && claudeSessionId ? spawnGuard.markResuming(paneid, [claudeSessionId]) : () => {};
      try {
        session = await link.spawn(paneid, descriptor, { cols: 80, rows: 24 });
      } catch (e) {
        unmark();
        throw e;
      }
      if (link.isLocal) {
        brokerClient.noteAvailability(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (minted) {
        // Only THIS spawn's token (review P2-2): a concurrent spawn that won
        // has superseded it and holds the pane's live token and file.
        paneTokens.revokeMinted(paneid, minted.hash, 'spawn-failed');
      }
      btLaunch.removeFiles(paneid);
      log(`spawn FAILED for ${recipeId ? `recipe "${recipeId}"` : `component "${vendor}"`} (${descriptor.binary}): ${message}`);
      send(ws, { type: 'pane.error', paneid, message: `launch failed (${descriptor.binary}): ${message}` });
      return;
    }
    if (btPlanned && minted) btTools.plan(paneid);
    else btTools.notPlanned(paneid, btPlanned ? 'no-token' : btWhy);
    log(
      `spawn ${session.id} for ${recipeId ? `recipe "${recipeId}"` : `component "${vendor}"`} (${descriptor.binary}) paneid=${paneid}` +
        (claudeSessionId ? ` claude=${claudeSessionId}${restored ? ' (RESTORED)' : ''}` : ''),
    );
    table.upsert({
      paneid,
      // WHICH PROJECT, as data. Until now this lived only as a substring of the
      // paneid, which is precisely what capped a project at one session.
      recipe_id: recipeId ?? null,
      // ...and HOW IT RESUMES, so the session remembers rather than re-deriving
      // it from a project default that may have changed since.
      resume_name: resumeNameUsed,
      server,
      vendor,
      /* THE EMPTY COLUMN, FINALLY CARRYING SOMETHING (Stage 2 / E1, and what
         the 2026-08-03 correction asked for). The session uuid in `session_id`
         is an INCARNATION that rotates on resume, compaction and reclaim; the
         slug does not, so it is the only key anything outside this engine may
         address a session by. Written on every upsert, so a recipe renamed or
         re-slugged takes effect on its next spawn. */
      agent: agentSlug,
      // claude-code panes bank the VENDOR session uuid (what --resume needs) —
      // NULL when it's unknowable (named-resume flow), never the pty id, which
      // would masquerade as resumable. Other vendors keep the pty id as before.
      /* A VENDOR-BACKED pane banks its VENDOR session id — which may be null
         when the brand cannot be told one (gemini has no `--session-id`), and
         null is the honest answer. A class-2 pane keeps the pty id as before.
         Never the pty id for a vendor pane: it would masquerade as resumable. */
      session_id: vendorFor(vendor) ? claudeSessionId : session.id,
      state: 'live',
      generation,
    });
    if (profileToWrite) {
      table.setProfile(paneid, profileToWrite);
    }
    if (ackCwd && claudeSessionId) {
      // ACK handshake (local, fire-and-forget): the transcript file appearing
      // proves claude really started under our session id. Log-only in Crawl.
      const ackId = claudeSessionId;
      void claudeCode.ackTranscript(ackCwd, ackId).then((acked) => {
        log(
          acked
            ? `ack claude=${ackId} (transcript present)`
            : `ack TIMEOUT claude=${ackId} — no transcript at ${claudeCode.transcriptPath(ackCwd, ackId)} (claude may not have started)`,
        );
      });
    }
    /* The socket may have closed DURING the spawn's awaits (locate, the
       just-ended wait, the broker spawn). The human asked for this session, so
       it is kept — PARKED, with no socket, exactly like an adopted resident:
       never a dead viewer, never a ghost control lease (S0 ride fix). */
    const gone = ws.readyState !== ws.OPEN;
    const resident = sessions.add(paneid, session, gone ? (null as never) : ws);
    resident.reapOverrideMs = gone ? 0 : reapOverrideMs;
    if (gone) {
      resident.adopted = false; // spawned here: its draft is known (empty)
      log(`spawn paneid=${paneid} parked: its window closed while the spawn ran (open it from the manager)`);
    }
    /* S0 STARTUP BLOCK (the design notes §4.4, F12): every claude spawn —
       fresh or restore — may sit on a startup prompt or a bare shell that reads
       as idle. Armed BEFORE the pty is bound and before onLive, so no typed
       delivery can slip in ahead of it (startup-gate.ts). */
    if (vendor === 'claude-code') {
      startupGate.arm(paneid, { channel: channelOn });
    } else if (vendor === 'gemini-cli') {
      // ticket B4: gemini-cli's own screen-based gate — see gemini-gate.ts's header.
      geminiGate.arm(paneid);
    }
    promptBlock.arm(paneid, vendor); // ticket: claude-code / gemini-cli / codex-cli (its startup screens); a no-op for others
    /* P0 screen model: a fresh pty at the size just spawned (80x24), in sync
       from byte 0. AFTER the upsert above, so its size stamp is not older than
       the row's started_at; BEFORE the pump is bound. */
    vscreen.create(paneid, { origin: 'spawn', link: brokerHost, hostKind: vscreenHostKind(brokerHost), vendor, cols: 80, rows: 24 });
    bindResident(resident, paneid);
    if (!gone) {
      attached.add(paneid);
    }
    activity.onLive(paneid);
    publishPresence(paneid, activity.get(paneid) ?? 'idle');
    // A freshly spawned pane's first viewer holds the keyboard unless it asked
    // to watch only.
    const fresh = gone ? undefined : sessions.get(paneid);
    if (fresh) {
      fresh.viewers.add(ws);
      if (wantsControl) {
        grantControl(fresh, ws, clientLabel);
      } else {
        announceControl(fresh);
      }
    }
    if (inject) {
      // Type the claude command INTO the visible shell (debug transparency —
      // Owner sees exactly what ran). ConPTY buffers typed-ahead input, so the
      // shell picks it up when its prompt is ready.
      const cmd = inject;
      setTimeout(() => {
        try {
          engineWrite(paneid, session.pty, `${cmd}\r`, 'launch');
        } catch {
          /* pty already gone */
        }
      }, 400);
    }
    send(ws, {
      type: 'pane.ready',
      paneid,
      sessionId: session.id,
      state: session.state,
      restored, // crash restore: this spawn is `claude --resume <stored uuid>`
      prefs: prefsOf(paneid),
      title: titleOf(paneid),
      vendor: vendorOf(paneid),
      activity: activity.get(paneid) ?? 'idle',
      held: roomTyper.heldFor(paneid), // same shape as pane.held; null = nothing waits
      mcp: mcpCalls.inFlight(paneid), // the pane.mcp starts still open (ticket)
    });
    /* A FRESH SPAWN NEEDS THIS TOO, not just the reattach above. The first cut
       pushed only on reattach, so a newly launched session showed nothing on
       its tab until the 20s widget poll came round — the one moment you are
       most likely to be looking at it. */
    lastWidgetSent.delete(paneid);
    pushWidget(paneid, recipeId ?? null);
  }

  ws.on('message', async (raw) => {
    await bootReady; // arrival order is preserved; a no-op once boot completes
    let msg: IncomingMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /* LIVENESS, and it needs no paneid (2026-09-21).
     *
     * A WebSocket whose TCP flow is BLACKHOLED never fires `onclose`: the
     * browser keeps `readyState === OPEN`, the page believes it is connected,
     * and every keystroke is send()-ed into a stalled flow where the kernel
     * buffers it. Owner lost about five minutes to exactly that — the pane
     * looked normal, other tabs were fine (their own flows were healthy), and
     * when the path recovered TCP delivered the whole backlog IN ORDER, so
     * everything he had typed arrived at once: "anyany wrod back?fjfj...".
     *
     * Silence cannot be evidence on its own — an idle session legitimately
     * sends nothing for minutes — so the client asks and this answers. A reply
     * that stops arriving is what lets the page give up on a socket that will
     * never close itself, surface `disconnected`, and QUEUE input instead of
     * writing it into a void.
     *
     * Answered before any pane resolution: liveness is about the socket, not
     * about a session, and a ping must work even for a socket that holds none. */
    if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }

    // `address` needs no paneid — it RESOLVES a name to one.
    /* ATTENTION (2026-09-04). A human is engaged with this pane — typing,
       clicking, or arriving on it after being away. The engine had no attention
       input at all before this: `waiting` ended only on output or the Stop hook,
       and Owner could alt-tab to a flashing window, click it, and watch it keep
       flashing. Per-pane on purpose: a window holds many tabs and only the one
       you land on has been seen. See activity.ack for the two-level rule. */
    if (msg.type === 'attention.ack' && typeof msg.paneid === 'string') {
      activity.ack(msg.paneid, typeof msg.how === 'string' ? msg.how.slice(0, 24) : 'focus');
      /* The same arrival acks every fabric envelope this pane has been shown
         since the last time a human was here (`seen`, contract §2's ladder).
         `answered`/`resolved` are never inferred from a glance — see
         fabric-subscriber.onPaneAttention. */
      fabricSub.onPaneAttention(msg.paneid);
      return;
    }

    if (msg.type === 'address' && typeof msg.name === 'string') {
      const paneid = table.resolveName(msg.name) ?? null;
      send(ws, { type: 'result', id: msg.id, command: 'address', name: msg.name, paneid });
      return;
    }

    /* ROOM SUBSCRIBE (workrooms §2.3): no paneid — a room page is not a pane.
       FULL-SET REPLACE, so the page's re-send on every open is idempotent.
       Unknown room ids are dropped, and the echo says which were kept. Only
       NEWLY followed rooms get a snapshot; the page backfills the line itself. */
    if (msg.type === 'room.subscribe') {
      if (ws.readyState !== ws.OPEN) {
        return; // closed while boot was pending: its close cleanup already ran
      }
      const want = Array.isArray(msg.rooms) ? msg.rooms.filter((id): id is string => typeof id === 'string') : [];
      const next = new Set(want.filter((id) => table.getRoom(id)));
      const prev = roomSubs.get(ws) ?? new Set<string>();
      if (next.size) {
        roomSubs.set(ws, next);
      } else {
        roomSubs.delete(ws);
      }
      send(ws, { type: 'room.subscribed', rooms: [...next] });
      for (const id of next) {
        if (!prev.has(id)) {
          const snap = await roomStateMsg(id);
          if (snap && roomSubs.get(ws)?.has(id)) {
            send(ws, snap);
          }
        }
      }
      return;
    }

    const paneid = msg.paneid;
    if (!paneid) {
      return; // every other command is pane-scoped
    }

    if (msg.type === 'attach') {
      if (msg.roomFrame === true) {
        roomFrameSockets.add(ws); // a room's own view of a seat: not a window (closeWindowsOf)
      }
      if (typeof msg.label === 'string' && msg.label.trim()) {
        clientLabel = `${msg.label.trim().slice(0, 40)} · ${device}`;
      }
      /* `reclaim` resolves against the CURRENT holder, not the client's memory of
         it — the client cannot know whether anyone took over while it was away. */
      /* Read INSIDE the guard 7 mutex (below): an attach that waited for
         another's spawn must judge the holder that spawn left, not the empty
         pane it saw on arrival. */
      const wantsControlNow = (): boolean => {
        const existingCtl = sessions.get(paneid)?.socket ?? null;
        /* RECLAIM = "take it back if it is still mine to take".
         *
         * Free-because-nobody-is-there and free-because-the-engine-restarted look
         * identical in memory, and treating them the same is what handed Owner's
         * session to whichever client reconnected first. So a reclaim also has to
         * match the REMEMBERED driver: after a restart the session goes back to
         * the machine that was using it, and everyone else is offered it instead
         * of silently winning a race. A session nobody has ever driven has no
         * remembered driver, so a first reclaim is always granted. */
        const lastDriver = table.get(paneid)?.last_controller ?? null;
        return msg.intent === 'view'
          ? false
          : msg.intent === 'reclaim'
            ? existingCtl === ws || (existingCtl === null && (!lastDriver || lastDriver === clientLabel))
            : true;
      };
      /* S0 guard 7 MUTEX: one attach per paneid at a time — a second attach
         while a spawn is in flight waits for it, then runs from the top and
         reattaches to what it spawned (F11: never two claudes for one pane). */
      await spawnGuard.serialize(paneid, () => handleAttach(paneid, msg.component, msg.recipe, { model: msg.model, effort: msg.effort }, wantsControlNow(), msg.spawn === true, msg.reattachOnly === true));
      return;
    }

    /* The Resume button. `intent:'view'` attaches watch-only; this is how a
       viewer later asks for the keyboard, pausing whoever holds it. */
    if (msg.type === 'takeControl') {
      const r = sessions.get(paneid);
      if (!sessions.isLive(r) || !r.viewers.has(ws)) {
        return;
      }
      if (typeof msg.label === 'string' && msg.label.trim()) {
        clientLabel = `${msg.label.trim().slice(0, 40)} · ${device}`;
      }
      grantControl(r, ws, clientLabel);
      send(ws, { type: 'result', id: msg.id, command: 'takeControl', paneid });
      return;
    }

    // setPrefs / rename can target a pane with no live session (name it on create).
    if (msg.type === 'setPrefs' || msg.type === 'rename') {
      const prefs =
        msg.type === 'rename'
          ? { friendlyName: msg.friendlyName ?? null }
          : {
              friendlyName: msg.friendlyName ?? undefined,
              color: msg.color ?? undefined,
              fg: msg.fg ?? undefined,
              bg: msg.bg ?? undefined,
              watermark: msg.watermark ?? undefined,
              project: msg.project ?? undefined,
              fontSize: typeof msg.fontSize === 'number' ? msg.fontSize : undefined,
              /* Stamped HERE, where prefs is built, so the session row gets a
                 key too — stamping only the recipe write-back below would
                 leave the pane itself keyless until the next launch. */
              logo: typeof msg.logo === 'string' ? (stampLogoKey(msg.logo) as string) : undefined, // '' clears
            };
      const merged = table.setPrefs(paneid, prefs);
      /* Auto-save: a rename/recolor made ON a recipe-backed window writes back
       * into its PROJECT, so every session of that project — and the next
       * launch — carries the new identity. That is the coherent reading of the
       * project model: identity belongs to the bucket, so editing it anywhere
       * edits the bucket.
       *
       * STRIP THE `#` SUFFIX. `recipe:<uuid>#45a7f886` sliced naively yields
       * `<uuid>#45a7f886`, which matches no recipe row, so updateRecipeTheme
       * updated ZERO rows — silently. The write-back therefore already behaved
       * differently for a project's second session than its first. */
      const ownerRecipeId = paneid.startsWith('recipe:')
        ? paneid.slice('recipe:'.length).split('#')[0]
        : null;
      if (ownerRecipeId) {
        table.updateRecipeTheme(ownerRecipeId, {
          name: prefs.friendlyName ?? undefined,
          color: 'color' in prefs ? (prefs.color ?? undefined) : undefined,
          fg: 'fg' in prefs ? (prefs.fg ?? undefined) : undefined,
          bg: 'bg' in prefs ? (prefs.bg ?? undefined) : undefined,
          watermark: 'watermark' in prefs ? (prefs.watermark ?? undefined) : undefined,
          fontSize: 'fontSize' in prefs ? (prefs.fontSize ?? undefined) : undefined,
          logo: 'logo' in prefs ? (prefs.logo ?? undefined) : undefined,
        });
        /* ...and reach the project's OTHER sessions. Without this the write-back
         * only closed half the loop: the recipe changed, so the NEXT launch
         * carried the new identity, while every already-open sibling window kept
         * the old one until it respawned. With one session per project that was
         * invisible; with several it is the first thing you notice.
         *
         * PERSIST, then push. A pane.prefs push alone repaints the window now and
         * silently reverts on the next reattach, because pane.ready serves the
         * pane ROW (prefsOf) — the row is the source of truth, so it has to be
         * written too. */
        for (const sib of table.sessionsForRecipe(ownerRecipeId)) {
          if (sib.paneid === paneid) {
            continue;
          }
          const sibPrefs = table.setPrefs(sib.paneid, prefs);
          const r = sessions.get(sib.paneid);
          if (r) {
            broadcast(r, { type: 'pane.prefs', paneid: sib.paneid, prefs: sibPrefs });
          }
        }
      }
      send(ws, { type: 'pane.prefs', paneid, prefs: merged });
      send(ws, { type: 'result', id: msg.id, command: msg.type, paneid });
      return;
    }

    // The rest act on a live resident's PTY.
    const resident = sessions.get(paneid);
    if (!sessions.isLive(resident)) {
      return;
    }
    /* ENFORCEMENT LIVES HERE, not in the renderer. A paused viewer's UI stops
       sending, but a stale tab, a queued outbox or a hand-rolled client would
       still write — so the engine refuses anything that touches the pty from a
       socket that does not hold control. */
    const writesToPty = msg.type === 'input' || msg.type === 'resize' || msg.type === 'kill';
    if (writesToPty && resident.socket !== ws) {
      send(ws, {
        type: 'pane.control-denied',
        paneid,
        command: msg.type,
        holder: resident.controllerLabel,
      });
      return;
    }
    /* [connector] A connector-owned pane has ONE writer: raw terminal input is refused, never
       forwarded (a second turn writer could steer the connector's active turn). */
    if (msg.type === 'input' && connectorBridge.isOwned(paneid)) {
      send(ws, { type: 'pane.error', paneid, message: 'input refused: this session is driven by the Codex connector' });
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      const guard = inputGuard.check(paneid, msg.data, Date.now());
      if (guard.notice) {
        send(ws, { type: 'pane.error', paneid, message: 'Input paused: a key looks stuck. Other keys (Esc, Ctrl+C) still work.' });
      }
      if (guard.drop) {
        return;
      }
      /* Byte COUNT only, never the keystrokes — this is the record that shows
         whether typing is being mistaken for model output, not a keylogger. */
      const typed = activity.onInput(paneid, msg.data); // counts + a draft CLASSIFICATION only (ticket)
      if (typed) {
        /* `seen` on the transition, not per key — and only for TYPING: a
           terminal's reply to a replayed query is not a human reading the
           envelope (same rule as activity.onInput's ack) [ticket]. */
        fabricSub.onPaneAttention(paneid);
      }
      engineWrite(paneid, resident.cli.pty, msg.data, 'person');
      vscreen.onInput(paneid); // P0 shadow: schedules re-comparisons only
      if (typed) {
        /* Typing (not a focus or mouse report) is a human with eyes on the
           pane: it lifts the S0 startup block (startup-gate.ts) — AFTER the
           keystroke is in the pty, and the retry it triggers waits a settle. */
        startupGate.onHumanInput(paneid);
        channels.onHumanInput(paneid); // guard 6c: a human answering the dialog cancels the engine's Enter
      }
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try {
        resident.cli.pty.resize(msg.cols, msg.rows);
        /* P0 screen model: mirror (and persist) only what was actually sent —
           vscreen asks whether the pane's broker link was open. */
        vscreen.resize(paneid, msg.cols, msg.rows);
        if (repaintOnFirstResize.delete(paneid)) {
          const c = msg.cols;
          const rr = msg.rows;
          setTimeout(() => nudgeRepaint(paneid, c, rr), 500).unref?.();
        }
      } catch {
        /* ignore resize on a dead pty */
      }
    } else if (msg.type === 'kill') {
      resident.endReason = 'user'; // same fact as the manager's End (see onExit)
      killCli(resident.cli); // → onExit fires → table killed + resident removed
    } else if (msg.type === 'handoff-dismiss') {
      /* The user is done with it. `id` drops one bundle, absent drops them all.
         Dismissing is the only way to clear early — copying must NOT, because a
         password you copied once is a password you may need to paste twice. */
      const rest = liveHandoffs(paneid).filter((h) => (msg.id ? h.id !== msg.id : false));
      if (rest.length) {
        handoffs.set(paneid, rest);
      } else {
        handoffs.delete(paneid);
      }
      send(ws, { type: 'pane.handoff', paneid, bundles: rest });
    } else if (msg.type === 'fabric-dismiss') {
      /* The ONE command added beside the one event (mirrors handoff-dismiss).
         Dismiss is the human saying "I have read this" — it clears the BADGE.
         Nothing here demotes, expires or re-raises anything: the loudness
         ladder in the design notes is not built, and this must not
         be mistaken for it. */
      const rest = fabric.dismiss(paneid, typeof msg.id === 'string' ? msg.id : undefined);
      broadcast(sessions.get(paneid) ?? { viewers: new Set([ws]) } as any, {
        type: 'fabric.message',
        paneid,
        messages: rest,
      });
    } else if (msg.type === 'url-offer-dismiss') {
      // Dismiss ONE offered url (msg.url) or ALL (no url). Engine list is
      // authoritative; the bar repaints from the echoed event.
      const list = (urlOffers.get(paneid) ?? []).filter((u) => msg.url && u !== msg.url);
      if (list.length > 0) {
        urlOffers.set(paneid, list);
      } else {
        urlOffers.delete(paneid);
      }
      send(ws, { type: 'pane.url-offer', paneid, urls: list });
    } else if (msg.type === 'park') {
      // HIDE verb (Owner, 2026-08-06): close the WINDOW, keep the CLI. Pin the
      // resident (reap 0 = never) so the socket close that follows doesn't
      // trigger the solo close=kill grace; the broker keeps the PTY alive and
      // the manager's "Open window" reattaches. Reattach restores the normal
      // grace (see the REATTACH branch), so a later plain close kills again.
      resident.reapOverrideMs = 0;
      log(`park paneid=${paneid} (window closing, session pinned)`);
    }
  });

  ws.on('close', () => {
    clearInterval(beat);
    roomSubs.delete(ws); // a room subscription never outlives its socket
    // dismiss ≠ kill (decision 7): the socket left, each resident stays resident.
    for (const paneid of attached) {
      const resident = sessions.get(paneid);
      if (!resident) {
        continue;
      }
      resident.viewers.delete(ws);
      if (resident.socket === ws) {
        // Control is RELEASED, not inherited: a remaining viewer must ask for
        // it (Resume) rather than silently acquiring a keyboard it never
        // requested. Announce so their UI can offer the button.
        resident.socket = null;
        resident.controllerLabel = null;
        announceControl(resident);
      }
      if (resident.viewers.size === 0) {
        // PARKED (contract §3's `attached | parked`): the session is alive and
        // nobody is watching. Republished because `attached` is part of
        // presence, not a property of the state word.
        publishPresence(paneid, activity.get(paneid) ?? 'idle');
        sessions.scheduleReap(resident, (r) => {
          // Not the user's decision — record that before the exit handler runs,
          // so a resumable conversation is filed as restorable, not ended.
          r.endReason = 'reaped';
          killCli(r.cli);
          log(`reaped idle resident paneid=${r.paneid}`);
        });
        log(
          `detach paneid=${paneid} (resident kept${CLOSE_KILL ? ', close-kill grace armed' : ' — session survives; End it from the manager'})`,
        );
      }
    }
  });
});

server.listen(PORT, HOST, async () => {
  const bound = server.address();
  boundPort = typeof bound === 'object' && bound ? bound.port : PORT;
  setBoundPort(boundPort);
  setEngineOrigin(HOST, boundPort); // solo URLs carry the REAL port (a local engine binds 0)
  if (LOCAL.enabled && historyExporter) {
    const delayMs = Number(process.env.HARBOR_WB_HISTORY_EXPORT_DELAY_MS) >= 0 && process.env.HARBOR_WB_HISTORY_EXPORT_DELAY_MS ? Number(process.env.HARBOR_WB_HISTORY_EXPORT_DELAY_MS) : 5000;
    const everyMs = Number(process.env.HARBOR_WB_HISTORY_EXPORT_MS) >= 1000 ? Number(process.env.HARBOR_WB_HISTORY_EXPORT_MS) : 3_600_000;
    const run = (): void => {
      void historyExporter?.catchUp();
    };
    setTimeout(run, delayMs).unref();
    setInterval(run, everyMs).unref();
  }
  const capCfg = LOCAL.enabled ? memoryCapConfig(process.env) : null;
  if (capCfg) {
    /* the polite half of the memory cap: over the ceiling, say so in every open room and exit 75 so the supervisor restarts us at once */
    startMemoryCap(capCfg, {
      rss: () => process.memoryUsage().rss,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
      onExceed: (rss, ceiling) => {
        log(`MEMORY CAP: rss ${rss} over ${ceiling}: exiting ${EXIT_MEMORY_CAP} for an immediate restart`);
        try {
          for (const r of table.listRooms({ state: 'open' })) {
            table.appendLine(r.id, { kind: 'fact', body: memoryCapFact(rss, ceiling), meta: { memoryCap: { rss, ceiling } } } as any, { actor: 'user' });
          }
        } catch (e) {
          log(`memory cap: could not write the room line (${(e as Error).message}); exiting anyway`);
        }
        process.exit(EXIT_MEMORY_CAP);
      },
    });
  }
  if (LOCAL.enabled) {
    /* The supervisor's readiness signal: ONE bounded line, only once boot (reconcile + adoption) is complete. */
    void bootReady.then(() => {
      process.stdout.write(`${readyLine(boundPort)}\n`);
    });
  }
  projects.start(log); // project-channel mirror refresh timer + main-watch notify sweep (both unref'd)
  const components = await loadComponents();
  // Names for the control-lease messages ("laptop has control"). Best-effort:
  // no tailscale → the lease still works, it just says the raw address.
  void tailnet.refresh().then((n) => {
    if (n) {
      log(`tailnet: ${n} device addresses resolved for control-lease labels`);
    }
  });
  // Brokers may still HOLD sessions from the previous engine run — those rows
  // are NOT stale. Per-link (vk [ref] fleet): ensure the LOCAL broker (task
  // trigger), probe remotes (their host's supervisor owns them), collect live
  // sids per reachable link, exclude them AND every live row whose broker is
  // UNREACHABLE (unreachable ≠ dead) from the stale-live reconcile, then
  // ADOPT reachable sessions as detached residents (replay seeded).
  const exclusions: string[] = [];
  const heldByLink: Array<[ReturnType<typeof brokerClient.allLinks>[number], string[]]> = [];
  for (const link of brokerClient.allLinks()) {
    const up = await link.ensure();
    if (link.isLocal) {
      brokerClient.noteAvailability(up);
      if (!up) {
        log('LOCAL PTY-BROKER UNAVAILABLE — local spawns will refuse (no silent fallback). Check the harbor-pty-broker task / broker.log.');
      }
    } else if (!up) {
      log(`remote broker '${link.host}' unreachable (${link.status()}) — its live rows are preserved, not reconciled (unreachable ≠ dead)`);
    }
    if (up) {
      const sids = await link.listLive();
      heldByLink.push([link, sids]);
      exclusions.push(...sids);
    } else {
      // Every live row that BELONGS to this unreachable broker is unknown, not
      // stale — exclude it from reconcile so it is never killed/dehydrated by
      // a network condition.
      for (const row of table.list() as Array<{ paneid: string; state: string; server: string }>) {
        if (row.state === 'live' && brokerHostOfServer(row.server) === link.host) {
          exclusions.push(row.paneid);
        }
      }
    }
  }
  const reconciled = table.reconcileStaleLive(exclusions);
  if (reconciled.dehydrated > 0 || reconciled.killed > 0) {
    log(
      `reconciled stale live session(s): ${reconciled.dehydrated} → dehydrated (resumable vendor, restorable), ${reconciled.killed} → killed`,
    );
  }
  /* Pane tokens of every process that did not survive (§3.2): a broker-held
     pane stays live above, keeps its generation, and keeps its token. */
  const revokedPanes = paneTokens.reconcile();
  if (revokedPanes > 0) {
    log(`pane tokens: revoked for ${revokedPanes} pane(s) whose process is gone`);
  }
  /* BRAND TABLE CHECK (§9). Logged, never fatal: two brands 12° apart is a
     cosmetic fault that nobody would otherwise file, and refusing to boot over
     one would trade it for an outage. */
  for (const problem of checkBrandsAtStartup()) {
    log(`brands.json: ${problem}`);
  }
  /* Adopt what a broker holds, as detached residents. Runs at boot for every
     reachable link and again whenever a remote link comes back (recovery sweep
     below) — the VRPC rebooting after this engine did must not strand its
     parked sessions until the next engine restart. */
  /* REPAINT AFTER RESTART (Owner 2026-10-06): an adopted pane's screen exists only as raw replay
     bytes, which cannot rebuild a full-screen TUI, so every window showed it jumbled and the
     screen model read it "seeded", i.e. unknown. A resize makes the CLI itself redraw the whole
     screen: one column narrower, then back, once per adopted pane, a second apart. Only when the
     pane's size is known; a pty that is gone is skipped. Never fatal. */
  const repaintAfterAdopt = (sid: string, i: number): void => {
    const row = table.get(sid) as { cols?: number | null; rows?: number | null } | undefined;
    const cols = row?.cols ?? 0;
    const rows = row?.rows ?? 0;
    if (cols < 20 || rows < 5) {
      /* No remembered size (the screen model was off, or nothing ever resized it): the first
         window that reconnects and sends its size does the nudge instead (resize handler). */
      repaintOnFirstResize.add(sid);
      return;
    }
    setTimeout(() => nudgeRepaint(sid, cols, rows), 3000 + i * 1000).unref?.();
  };
  const adoptHeld = async (link: ReturnType<typeof brokerClient.allLinks>[number], sids: string[]): Promise<number> => {
    let adopted = 0;
    for (const sid of sids) {
      if (!table.get(sid) || sessions.get(sid)) {
        continue; // no table row (probe/dev leftovers) or already resident — leave it
      }
      const got = await link.adopt(sid);
      if (!got) {
        continue;
      }
      const resident = sessions.add(sid, got.session, null as never);
      resident.socket = null;
      sessions.pushOutput(resident, got.replay);
      /* P0 screen model: the persisted size (or sizeless), seeded from the
         broker's tail — `seeded` until a full redraw. Fail-safe: nothing here
         can break this loop. */
      const adoptedVendor = table.get(sid)?.vendor || 'unknown';
      vscreen.create(sid, { origin: 'adopt', link: link.host, hostKind: vscreenHostKind(link.host), vendor: adoptedVendor });
      vscreen.seed(sid, got.replay);
      /* S0 guard 1: a claude this engine did not watch start may be sitting on
         a startup dialog the restart left up — arm its startup gate from the
         replay tail (it may block and name; it clears only when the tail ends
         on a REPL footer drawn after its last prompt text). Before bindResident, so the
         first live byte meets the seeded gate. */
      if (adoptedVendor === 'claude-code') {
        startupGate.adopt(sid, got.replay);
      } else if (adoptedVendor === 'gemini-cli') {
        // ticket: seed gemini-gate from the replay tail, same idea as vscreen.seed
        // above — a redraw somewhere in the tail already says whether it's idle,
        // busy or on a dialog, instead of holding until the next live byte.
        geminiGate.arm(sid);
        geminiGate.onPtyData(sid, got.replay);
      }
      /* ticket: a pane that sat on a /login or permission prompt through the
         restart says "needs you" now, not at its next byte. */
      promptBlock.seed(sid, adoptedVendor, got.replay);
      // Adopted sessions are PINNED (never viewer-reaped): a broker-held session
      // at engine boot is either a window about to reconnect or a PARKED session
      // (hide verb) — and a park must survive engine restarts (2026-08-08 fix).
      // Close=kill returns on reattach (REATTACH branch restores the grace).
      resident.reapOverrideMs = 0;
      bindResident(resident, sid);
      activity.onLive(sid);
      /* What this engine held for the pane before the restart: its untyped
         lines and whether its box held a draft (night test 2026-10-06). */
      roomTyper.restorePane(sid);
      repaintAfterAdopt(sid, adopted);
      adopted++;
    }
    if (adopted > 0) {
      log(`adopted ${adopted} live session(s) from broker '${link.host}' — engine restart cost them nothing`);
    }
    return adopted;
  };
  for (const [link, sids] of heldByLink) {
    await adoptHeld(link, sids);
  }
  brokerClient.startRecoverySweep(async (link, sids) => {
    await adoptHeld(link, sids);
  });
  roomTyper.sweepPersisted((paneid) => table.get(paneid)?.state === 'live');
  backfillLogoKeys();
  backfillArtColors();
  normalizeStoredProjectDirs();
  /* Siblings that share one color get distinct ones, once [workgroup design] Owner 2026-10-05. */
  try {
    for (const c of table.dedupeWorkgroupColors()) {
      log(`rooms: workgroup "${c.name}" (${c.id}) shared ${c.from} with a sibling: re-picked ${c.to}`);
    }
  } catch (e) {
    log(`rooms: workgroup color sweep failed: ${(e as Error)?.message ?? e}`);
  }
  /* A recipe naming a target this engine does not know cannot launch, and until
     someone tries, nothing says so. The 2026-09 cutover rewrote targets.json and
     dropped `homebase-svc-ops`; five recipes sat broken for a day and surfaced
     only when Owner tried Kiosk. Warn at boot — never rewrite: which target a
     recipe SHOULD use is a human's call. */
  {
    const known = new Set(loadTargets().map((t) => t.id));
    for (const r of table.listRecipes()) {
      if (!known.has(r.target)) {
        log(`WARNING recipe "${r.name}" names unknown target "${r.target}" — it cannot launch until targets.json has it`);
      }
    }
  }
  /* Every recipe that predates Stage 2 gets its derived slug, once. Same shape
     as the two above: idempotent, silent when there is nothing to do, and it
     fixes the DATA rather than teaching every reader to derive on the fly —
     the stored slug is what an agent addresses and what the next system copies.
     `oldDerivedSlugForm` is the PRE-2026-09-17 default (`<basename>-cli`) — kept
     only so this backfill can tell "this is the machine's own old default" from
     "a human typed this", and reconcile the former to the new bare-basename
     default (measured against the live fabric: registry node ids and relay
     slugs carry no role suffix) without ever touching the latter. */
  for (const done of table.backfillRecipeAgents(
    (r) => resolveSlug(null, { projectDir: r.projectDir, name: r.name, vendor: r.vendor }),
    (r) => oldDerivedSlugForm(r),
  )) {
    if (done.renamedFrom) {
      log(`recipe "${done.name}": agent slug renamed "${done.renamedFrom}" -> "${done.agent}" (registry node id, no role suffix)`);
    } else {
      log(`recipe "${done.name}": agent slug derived "${done.agent}"`);
    }
  }
  /* IDENTITY HYGIENE (wr §2.9): a bare shell carries no slug. The backfill
     above only ever FILLS an empty slug, so a terminal that already derived one
     from its folder (`/srv/code` -> `code`, claimed by two unrelated
     terminals on two hosts) would keep it forever. Clear exactly the folder-
     derived ones; a typed or name-derived slug (Local command bridge) stays.
     Idempotent: a second boot finds nothing. Live sessions keep the old slug
     on their row until they respawn — spawn writes the recipe's. */
  for (const done of reconcileTerminalSlugs(table.listRecipes(), (id) => table.setRecipeAgent(id, null))) {
    log(`recipe "${done.name}": agent slug "${done.cleared}" cleared — a terminal carries no identity (wr §2.9)`);
  }
  /* ONE-OFF profile backfill for the agents already seated in open rooms (Owner
     2026-10-03; see engine/profile-backfill.ts). Runs once per boot, a few
     seconds after start, in the background: it reads transcripts (maybe over
     ssh), so it must never hold boot, and a failure is logged, never thrown.
     Idempotent: a filled row is no longer a target. */
  setTimeout(() => {
    void backfillProfiles({
      targets: () => table.profileBackfillTargets(),
      list: async (recipeId) => {
        const rec = table.getRecipe(recipeId) as any;
        if (!rec?.projectDir) {
          return { error: 'recipe or project folder is gone' };
        }
        const access = remoteFsAccess(loadTargets().find((tt) => tt.id === rec.target));
        if (access.mode === 'unreachable') {
          return { error: `host unreachable for target "${rec.target}"` };
        }
        try {
          return { rows: await claudeCode.listSessions({ projectDir: rec.projectDir, ...fsOptsFor(access), limit: 200 }) };
        } catch (e) {
          return { error: `transcripts unreadable: ${(e as Error)?.message ?? e}` };
        }
      },
      setIfUnset: (paneid, p) => table.setProfileIfUnset(paneid, p),
      log,
    }).catch((e) => log(`profile backfill failed: ${(e as Error)?.message ?? e}`));
  }, 5_000).unref?.();
  /* Room composer attachments [ticket]: abandoned drafts' files are swept
     now and hourly (engine/room-scratch.ts). */
  roomScratch.startSweep(log);
  /* Room notes [ticket]: dirty, idle notes are indexed every 15 s. */
  notesIndex.startSweep(log);
  /* ...and every note's keywords are re-ranked once (tf x idf), in small batches. */
  notesIndex.rerankAll(log);
  /* Room apps [rooms/apps-engine]: backfill any pre-apps panel ONCE, at boot
     (never on the loop — a panel does not make an app a member, §4.4), then
     fill in a since-started app's panel now and every 30s. Fire-and-forget —
     a slow/held app must never delay boot, and a failure must never become an
     unhandledRejection (engine-fatal) [rooms/apps-sec P1-e]. */
  roomApps.setLog((line) => log(`apps: ${line}`));
  try {
    roomApps.bootBackfill();
  } catch (e) {
    log(`apps: boot backfill failed: ${(e as Error)?.message ?? e}`);
  }
  roomApps.reconcile().catch((e) => log(`apps: reconcile failed: ${(e as Error)?.message ?? e}`));
  roomApps.startReconcileLoop();
  toolManager.setLog((line) => log(`tool-manager: ${line}`));
  toolManager.startLoop();
  /* ROOM GUIDES [room guide]: written for every open room now, refreshed on change */
  try {
    /* Basic edition: the guide lists the typed commands agents act on (the registry), not room verbs */
    roomGuide.setCommandsSource(() =>
      agentCmds.isBasic()
        ? agentCmds.agentCommands().map((c) => ({
            usage: `/${c.name}`,
            does: c.explain + (c.confirm || c.always ? ' Typed: explain, then ask before acting.' : ''),
          }))
        : null,
    );
    roomGuide.startGuides(log);
  } catch (e) {
    log(`room guides: start failed: ${(e as Error)?.message ?? e}`);
  }
  /* IDLE REST (Owner 2026-10-04, item 6): every 5 min, dehydrate seats
     idle past the system settings (all off by default; a no-op then). Never throws. */
  const idleRestMs = Number(process.env.HARBOR_WB_IDLE_REST_SWEEP_MS) || 5 * 60_000;
  setInterval(() => {
    rooms.idleRestSweep(endForCycle, log).catch((e) => log(`idle rest sweep failed: ${(e as Error)?.message ?? e}`));
  }, idleRestMs).unref();
  /* AGENT REST level 1 [agent rest]: every minute (restMinutes is minutes); off by default. */
  const agentRestMs = Number(process.env.HARBOR_WB_AGENT_REST_SWEEP_MS) || 60_000;
  setInterval(() => {
    rooms.agentRestSweep(endForCycle, log).catch((e) => log(`agent rest sweep failed: ${(e as Error)?.message ?? e}`));
  }, agentRestMs).unref();
  /* TASKS RETENTION: a done task keeps everything for 7 days, then only its title and dates (tasks-store.sweepRetention). Hourly, and once soon after boot. */
  const tasksSweep = (): void => {
    try {
      const n = table.withRoomDb((d) => sweepTaskRetention(d));
      const t = table.withRoomDb((d) => sweepTaskTimeline(d));
      if (t > 0) {
        log(`tasks timeline: ${t} stretch/needs row(s) merged, dropped or folded into time worked`);
      }
      if (n > 0) {
        log(`tasks retention: ${n} done task(s) trimmed to title and dates`);
      }
    } catch (e) {
      log(`tasks retention failed: ${(e as Error).message}`);
    }
  };
  /* TASKS TIMELINE (trends, not detail): every minute, merge/drop the stretches that settled since the last tick; the hourly sweep above does the whole pass and the 24 h fold. */
  setInterval(() => {
    try {
      table.withRoomDb((d) => tickTaskTimeline(d));
    } catch (e) {
      log(`tasks timeline tick failed: ${(e as Error).message}`);
    }
  }, Number(process.env.HARBOR_WB_TASKS_TICK_MS) || 60_000).unref();
  setTimeout(tasksSweep, 60_000).unref();
  setInterval(tasksSweep, Number(process.env.HARBOR_WB_TASKS_SWEEP_MS) || 3_600_000).unref();
  /* WAITING AT A CLI PROMPT: a room fact when a seat's pane sits at a first-run prompt (the design notes). */
  setInterval(() => {
    rooms.cliPromptSweep(log);
    rooms.toolsSweep(log); // E1: "@x has no room tools", once per pane
  }, Number(process.env.HARBOR_WB_CLI_PROMPT_SWEEP_MS) || 5_000).unref();
  /* REPLY TURNS [reply turns]: lapses after the window, skips after the turn time, the next floor.
     A no-op unless HARBOR_WB_REPLY_TURNS=enforce. */
  /* [assistant switch] drive every unfinished switch again (an unconfirmed fence, a handover still being read, a
     release still retrying). Starts nothing that is already running. */
  setInterval(() => rooms.resumeSwitches(log), Number(process.env.HARBOR_WB_SWITCH_SWEEP_MS) || 30_000).unref();
  const turnsSweepMs = Number(process.env.HARBOR_WB_TURN_SWEEP_MS) || 5_000;
  setInterval(() => {
    try {
      rooms.sweepReplyTurns(log);
    } catch (e) {
      log(`reply turns sweep failed: ${(e as Error)?.message ?? e}`);
    }
  }, turnsSweepMs).unref();
  /* Keep every live tool's status line warm on the ENGINE's clock, not on the
     viewer's. See widget-status.ts startAutoRefresh. */
  usageMeter.start(); // subscribe to the agent-usage probes' readings (silent when NATS is off)
  widgetStatus.startAutoRefresh(() => {
    const out: Array<{ path: string; sshAlias?: string }> = [];
    for (const row of table.list() as any[]) {
      if (row.state !== 'live' || !row.recipe_id) {
        continue;
      }
      const rec = table.getRecipe(row.recipe_id) as any;
      if (!rec?.statusPath) {
        continue;
      }
      const acc = widgetAccess(loadTargets().find((tt) => tt.id === rec.target));
      if (!acc.reachable) {
        continue;
      }
      out.push({ path: rec.statusPath, sshAlias: acc.sshAlias });
    }
    return out;
  });
  /* Same clock, same set, same reason — a LIVE session's name moves under us
     (a /rename, Claude's auto-title landing, the last-prompt fallback advancing)
     and until now the only thing that ever fetched it was a manager poll that
     gave up as soon as it had ANY answer. See session-titles.ts startAutoRefresh. */
  titles.startAutoRefresh(() => {
    const out: Array<{ recipeId: string; projectDir: string; sshAlias?: string }> = [];
    const seen = new Set<string>();
    for (const row of table.list() as any[]) {
      if (row.state !== 'live' || !row.recipe_id) {
        continue;
      }
      const rec = table.getRecipe(row.recipe_id) as any;
      if (!rec?.projectDir || !rec.runClaude) {
        continue;
      }
      /* A worktree seat's transcripts are under the WORKTREE's folder: list it under its own cache key so its
         title and model/effort resolve (the recipe's folder never contains them). Same host access as the
         recipe's target. */
      const wtRow = table.getSessionWorktree(row.paneid);
      if (wtRow) {
        const wtKey = titles.worktreeKey(row.recipe_id, wtRow.name);
        if (!seen.has(wtKey)) {
          seen.add(wtKey);
          const wt = loadTargets().find((tt) => tt.id === rec.target);
          const wtAccess = remoteFsAccess(wt);
          if (wtAccess.mode !== 'unreachable') {
            out.push({ recipeId: wtKey, projectDir: worktreePath(wtRow.project, wtRow.name), ...fsOptsFor(wtAccess) });
          }
        }
      }
      if (seen.has(row.recipe_id)) {
        continue;
      }
      seen.add(row.recipe_id);
      const t = loadTargets().find((tt) => tt.id === rec.target);
      /* SELF-HOSTED POLARITY (2026-09-17): see remoteFsAccess in launch.ts. A
         foreign-broker target with no alias is left OUT of the supply — never
         pass sshAlias:undefined for it, which titles.refresh would read as
         "check local" and land on the wrong host's disk. Silent (no log): this
         tick runs every 20s and the dir-check at recipe save already told
         the user once. */
      const access = remoteFsAccess(t);
      if (access.mode === 'unreachable') {
        continue;
      }
      out.push({ recipeId: row.recipe_id, projectDir: rec.projectDir, ...fsOptsFor(access) });
    }
    return out;
  });
  /* PUSH THE NEW NAME TO THE WINDOW SHOWING IT. The manager re-reads /api/table
     every 2.5s and picks the change up for free; a solo window never polls, so
     without this its tab would keep the name it was opened with for the life of
     the session. Only panes of the project that actually changed. */
  titles.setOnChange((recipeId) => {
    /* ADOPT FIRST, then announce. A fresh listing is exactly what adoption
       needs, and a pane that just moved to a different transcript has a
       different name by definition — announcing before re-pointing would push
       the name of the conversation it has left. */
    runAdoptions();
    for (const row of table.list() as any[]) {
      if (row.state !== 'live' || row.recipe_id !== recipeId) {
        continue;
      }
      const resident = sessions.get(row.paneid);
      if (resident) {
        broadcast(resident, {
          type: 'pane.title',
          paneid: row.paneid,
          title: titles.known(recipeId, row.session_id),
        });
      }
    }
  });
  /* PUSH WHEN IT CHANGES, not on a clock. Driven by the refresh itself, so a
     renewal reaches the tab as soon as the engine learns it rather than up to a
     poll later — and a tab is never rebuilt on a tick that carried no news. */
  widgetStatus.setOnChange((path) => {
    for (const row of table.list() as any[]) {
      if (row.state !== 'live' || !row.recipe_id) {
        continue;
      }
      const r = table.getRecipe(row.recipe_id) as any;
      if (r?.statusPath === path) {
        pushWidget(row.paneid, row.recipe_id);
      }
    }
  });
  /* THE FABRIC SUBSCRIBER STARTS AFTER ADOPTION, not before it: the first
     `subscribe` frame should carry the sessions this engine just took back, not
     an empty set followed by a correction. Off by env on a host where the
     fabric is not ours to subscribe from; absent-and-retrying otherwise. */
  fabricSub.start({ token: auth.bearerToken(), liveSlugs: hostedSlugs });
  /* Check-in (contract §1.3) after adoption, for the same reason: the first
     sweep checks in every pane this engine just took back, offering the slug
     each row remembers so it RECLAIMS rather than mints. */
  fabricCheckin.start({
    token: auth.bearerToken(),
    deps: {
      info: checkinInfo,
      liveInfos: () =>
        (table.list() as any[])
          .filter((r) => r.state === 'live' && r.agent)
          .map((r) => checkinInfo(r.paneid))
          .filter((i): i is fabricCheckin.PaneInfo => i !== null),
      persist: (paneid, slug, instance) => table.setFabricIdentity(paneid, slug, instance),
      onChange: () => fabricSub.refresh(),
      log,
    },
  });
  channels.init({ token: auth.bearerToken(), log: (l) => log(`channels: ${l}`) });
  fabricRelay.start({
    token: auth.bearerToken(),
    deps: {
      isLive: (paneid) => (table.get(paneid) as any)?.state === 'live',
      log,
    },
  });
  sessions.onRemove((paneid) => fabricRelay.closePane(paneid));
  bootReadyResolve();
  /* [assistant switch] resume each unfinished switch from its journal, fire-and-forget (spec §3 item 4) */
  setTimeout(() => rooms.resumeSwitches(log), 0);
  const rm = sessions.reapMs();
  log(`reap: ${rm <= 0 ? 'never (pinned)' : `${rm}ms (${(rm / 3_600_000).toFixed(1)}h)`}`);
  log(`switches: ${JSON.stringify(runtimeFlags.all())} (config.json, re-read live)`);
  log(`Workbench engine listening — Milestone 8 (PTY-broker: sessions survive engine/harbor restarts)`);
  log(`  open:       http://${HOST}:${PORT}/`);
  log(`  manager:    http://${HOST}:${PORT}/manager.html`);
  log(`  health:     http://${HOST}:${PORT}/health`);
  log(`  components: ${components.length === 0 ? '(none — zero-component boot)' : components.map((c) => c.id).join(', ')}`);
});
