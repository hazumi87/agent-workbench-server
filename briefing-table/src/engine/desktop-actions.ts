/* ============================================================================
 * DESKTOP ACTIONS — the one seam between the engine and an OS desktop.
 *
 * Phase 2 of the migration plan; the engine half of the
 * "window agent" contract (the design notes §5b,
 * D3 = PULL, Owner 2026-09-15).
 *
 * The engine decides WHICH pane should be on screen and WHERE (one window per
 * pty). It must never decide HOW a particular desktop opens a window — that is
 * the host's business (Edge app-mode, a protocol handler, a frameless shell)
 * and, once the engine runs on the server, it is on a machine the engine cannot
 * reach at all. So every desktop act goes through ONE interface with a
 * per-deployment implementation:
 *
 *   loopback (DEFAULT) — today's PUSH path, unchanged in effect: POST to the
 *     ui-toolkit control API on 127.0.0.1:8200, focus-if-showing, the
 *     `harbor-window-host://serve` protocol kick, Edge `--app=` as the last
 *     resort. Only correct while the engine and the desktop share a machine.
 *   agent — the PULL path: a window agent on the desktop dials IN to
 *     `/window-agent`, registers, and executes `window.open|focus|close` on the
 *     engine's behalf. Nothing on the desktop is tailnet-exposed and the engine
 *     never reaches into it. This is the shape the laptop needs too.
 *   none — there is no desktop. Every launch answers `placement:'browser'`
 *     with the URL, exactly what a phone gets today. The honest answer on a
 *     headless server before any agent exists.
 *
 * Selected by `HARBOR_WB_DESKTOP`; `loopback` unless it says otherwise, so the
 * rollback from anything here is one env var (contract §5b).
 *
 * WHAT IS NOT HERE: which pane a launch is for, and whether a second view of
 * one pty is allowed. Those are engine decisions and stay in the launch route;
 * this module only reports what is on screen and does as it is told.
 * ========================================================================== */
import { spawn as spawnProc } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { mintTicket } from '../server/auth.ts';
import * as agentFs from './agent-fs.ts';

export type DesktopMode = 'loopback' | 'agent' | 'none';
/** Where a session ended up (or should end up). `browser` = "not my desktop —
 *  open it yourself", which is what a phone, a laptop browser, and an
 *  agent-mode engine with no agent registered all get. */
export type Placement = 'tab' | 'focused' | 'window' | 'browser';

export interface OpenRequest {
  /** The URL the DESKTOP should open — always built by `soloUrlFor`. */
  url: string;
  /** The pane this window is for; null for a chrome page (the CLI Manager). */
  paneid: string | null;
  title?: string | null;
  /** What the engine wants: today always `window`. */
  placement: Placement;
  /** Contract §5b passthrough — the agent may need the engine's base to build
   *  a shell wrapper, and a logo key to dress the window before it paints. */
  base?: string;
  logoKey?: string;
  /** The identity account of the PERSON who asked for this window (an identity session or device), or absent: a ticket for it becomes that person's session only then. A
   *  bearer, a service or the engine itself leaves it absent, and the ticket gets the legacy cookie (not a person). Never inferred. */
  byUserId?: string;
}

export interface ActionResult {
  ok: boolean;
  placement?: Placement;
  error?: string;
}

/** The common shape both implementations reduce their view of the desktop to.
 *  Loopback derives `paneid` from the url (the only identity a :8200 window
 *  carries); an agent reports paneids directly, which is why agent-mode dedupe
 *  never has to parse a url at all. */
export interface InventoryWindow {
  id: string;
  tabs: Array<{ paneid: string | null; url?: string; title?: string; state?: string }>;
}

export interface AgentInfo {
  host: string;
  agent: string;
  capabilities: string[];
  version: string | null;
  base: string | null;
  connectedAt: string;
  lastInventoryAt: string | null;
  lastPresenceAt: string | null;
  presence: unknown;
  windows: InventoryWindow[];
}

export interface DesktopStatus {
  mode: DesktopMode;
  agents: AgentInfo[];
  lastActions: Array<Record<string, unknown>>;
}

export interface DesktopActions {
  readonly mode: DesktopMode;
  /** The absolute URL for a page of OURS, in the form the DESKTOP should open
   *  it. Loopback and `none` answer the historical absolute-loopback form; an
   *  agent-mode engine answers the base the agent registered, because a server
   *  engine's `127.0.0.1` means the agent's own machine, not the engine's. */
  soloUrlFor(pathAndQuery: string): string;
  open(req: OpenRequest): Promise<ActionResult>;
  /** Is this pane already on screen? If so, focus that view and return
   *  `{ok:true, placement:'focused'}`; the caller must then NOT place it again.
   *  `url` is a loopback-only hint (its :8200 focus call names the tab by url);
   *  the wire contract for an agent is paneid-only. */
  focus(paneid: string, url?: string): Promise<ActionResult>;
  close(paneid: string, mode: 'park' | 'end'): Promise<ActionResult>;
  inventory(): Promise<InventoryWindow[]>;
  status(): DesktopStatus;
  /** Adopt a freshly-upgraded `/window-agent` socket (agent mode only). */
  /** `credentialed`: the socket presented the window agent's OWN credential (not the shared bearer). Only a credentialed agent can replace a credentialed one or be handed a person's ticket. */
  attachAgent(ws: WebSocket, remote: string, credentialed?: boolean): void;
  /**
   * Is an agent registered for this HOST advertising this CAPABILITY?
   *
   * By host, never "the desktop". `pick()` answers "where should a window
   * open", which is a question about the user; this one answers "whose disk is
   * that", which is a question about a target. They are the same machine today
   * and will stop being one the first time the laptop connects, so conflating
   * them would have read the laptop's transcripts for a VRPC-resident session.
   */
  hasCapableAgent(host: string, capability: string): boolean;
  /**
   * Send one request frame to a named host's agent and resolve with its REPLY
   * FRAME, verbatim. The engine's generic request/response plumbing: `req`
   * correlation and the timeout are handled here, the frame's meaning is the
   * caller's. Rejects on timeout, on a dead socket, and when no agent holds
   * the host — three failures a caller must be able to tell apart.
   */
  requestAgent(host: string, msg: Record<string, unknown>, timeoutMs?: number): Promise<any>;
}

function log(msg: string): void {
  console.log(`[engine→desktop] ${msg}`);
}

/* ---- shared bits ---------------------------------------------------------- */

let ENGINE_ORIGIN = `http://${process.env.HARBOR_WB_HOST ?? '127.0.0.1'}:${process.env.HARBOR_WB_PORT ?? 7420}`;
/** The engine's real origin once it is listening. A local engine binds port 0 (the OS picks), so the env port is NOT where it is: every
 *  solo URL the engine hands out (`launch` answers `url`) must carry the bound port. Called from the listen callback. */
export function setEngineOrigin(host: string, port: number): void {
  ENGINE_ORIGIN = `http://${host}:${port}`;
}

/** Attach a one-time auth ticket to a URL we are handing to a WINDOW HOST.
 *
 *  The host loads it in a WebView2 that may have no cookie yet, so without this
 *  an engine-opened window lands on the login page (which is exactly what every
 *  local window did after the auth gate shipped). Only URLs on OUR origin get
 *  one — a ticket is useless to the window host's own :8200 pages and must not
 *  be sprayed at other origins. */
function withTicket(u: string, origins: string[], byUserId?: string): string {
  if (!origins.some((o) => o && u.startsWith(o))) {
    return u;
  }
  return `${u}${u.includes('?') ? '&' : '?'}ticket=${mintTicket(byUserId ?? null)}`;
}

/**
 * Which PANE is this solo url for?
 *
 * A project's first session is `?recipe=<id>` (paneid `recipe:<id>`); any
 * additional one carries an explicit `?pane=`. Deriving the pane rather than
 * comparing url strings is what keeps two sessions of ONE project apart —
 * substring matching cannot, because the second session's url CONTAINS the
 * first's verbatim:
 *
 *   A = /solo.html?recipe=X
 *   B = /solo.html?recipe=X&pane=recipe%3AX%23abc      B.includes(A) === true
 *
 * so launching the primary session would have focused the SECOND session's
 * window — the right project, the wrong conversation.
 */
export function paneOfSoloUrl(u: string): string | null {
  try {
    const q = new URL(u, 'http://x').searchParams;
    const explicit = q.get('pane');
    if (explicit) {
      return explicit;
    }
    const recipe = q.get('recipe');
    return recipe ? `recipe:${recipe}` : null;
  } catch {
    return null;
  }
}

/** Every solo url a window has on screen — its own, plus any it wraps as tabs. */
function urlsOnScreen(w: { url?: string; tabs?: Array<{ url?: string }> }): string[] {
  const out: string[] = [];
  for (const t of w.tabs ?? []) {
    if (t.url) {
      out.push(t.url);
    }
  }
  const own = typeof w.url === 'string' ? w.url : '';
  if (own) {
    out.push(own);
    // A shell wrapper carries the page url encoded in ?tabs=
    try {
      /* searchParams.get() ALREADY decoded once — decoding again is not
         harmless here: a pane handle contains `#`, which survives as %23
         through one decode but becomes a URL FRAGMENT on the second, silently
         truncating `recipe:X#abc` back to `recipe:X` and collapsing a second
         session into the first. Split only. */
      const tabs = new URL(own, 'http://x').searchParams.get('tabs');
      if (tabs) {
        for (const part of tabs.split(',')) {
          if (part) {
            out.push(part);
          }
        }
      }
    } catch {
      /* not a parseable wrapper — its own url is already in the list */
    }
  }
  return out;
}

/** Bounded record of what the engine asked a desktop to do, and what came back.
 *  Same habit as /api/diag/activity and /api/diag/viewport: when the outside
 *  view is consistent with every hypothesis, read the variables. */
const lastActions: Array<Record<string, unknown>> = [];
function record(entry: Record<string, unknown>): void {
  lastActions.push({ at: new Date().toISOString(), ...entry });
  while (lastActions.length > 60) {
    lastActions.shift();
  }
}

/* ---- loopback: today's push path, moved here unchanged in effect ---------- */

/**
 * PREFERRED SHELL (adoption slice (a), KB design-notes-id): the
 * harbor-window-host frameless shell — POST /windows on its :8200 control API
 * with the page wrapped in a tabbed shell URL. The engine NEVER spawns the host
 * exe as a child (it would die with the engine); if :8200 is down it fires the
 * `harbor-window-host://serve` protocol URL (handled OUTSIDE our process tree)
 * and waits briefly. FALLBACK stays Edge app-mode — a window must always open,
 * whatever state the host is in.
 */
const WINDOW_HOST = process.env.HARBOR_WB_WINDOW_HOST ?? 'http://127.0.0.1:8200';

/** P3 shell migration (KB `design-notes-id`, step 2). The tabbed cli-manager
 *  shell is OUR policy, not the window host's — it now also lives in this repo
 *  at `web/shell.html` and serves from our own origin. This flag picks which
 *  copy wraps a new window; the host's `POST /windows` body is identical either
 *  way (same API, same `?tabs=` convention), so the switch is one string.
 *
 *  STEP 4 FLIPPED 2026-08-22 (Owner's go): the engine's own shell is the
 *  default. `HARBOR_WB_SHELL=host` is the instant rollback — the toolkit's
 *  :8200 copy keeps serving, byte-stable under their §5 freeze, until we send
 *  the step-5 deletion signal after a clean soak.
 *
 *  Step-3 trap (their §4, worth keeping in code): a shell opened with NO `?tabs=`
 *  auto-opens the CLI Manager, and two shells each holding a hub tab breaks the
 *  exactly-one-Manager invariant and makes `hub:summon` nondeterministic. Every
 *  URL we build here carries an explicit `?tabs=`, so this path is safe by
 *  construction — hand-opened spare shells are the ones to keep honest. */
const SHELL_SOURCE = process.env.HARBOR_WB_SHELL === 'host' ? 'host' : 'engine';

/** Wrap a page URL in the tabbed shell, from whichever copy is selected. */
function shellUrl(pageUrl: string, byUserId?: string): string {
  /* /app/shell.html on BOTH sides deliberately: the window host recognises a
   * shell window by that literal path (DockController.ShellBase), which is what
   * TEAR-OFF uses to decide where new shells come from. Serving our copy at the
   * same path keeps tear-off working after the flip with no toolkit change. */
  const base =
    SHELL_SOURCE === 'engine' ? `${ENGINE_ORIGIN}/app/shell.html` : `${WINDOW_HOST}/app/shell.html`;
  return withTicket(`${base}?tabs=${encodeURIComponent(pageUrl)}`, [ENGINE_ORIGIN], byUserId);
}

async function shellUp(): Promise<boolean> {
  try {
    const r = await fetch(`${WINDOW_HOST}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

class LoopbackDesktop implements DesktopActions {
  readonly mode: DesktopMode = 'loopback';

  soloUrlFor(pathAndQuery: string): string {
    return `${ENGINE_ORIGIN}${pathAndQuery}`;
  }

  /* NEVER POP A WINDOW under HARBOR_WB_NO_WINDOW=1. The guard lives here rather
   * than at each call site because it exists to stop THIS implementation
   * spawning `cmd.exe`/Edge on a test machine — `agent` and `none` spawn
   * nothing local, so it is inert for them by construction. */
  private suppressed(): boolean {
    return process.env.HARBOR_WB_NO_WINDOW === '1' || (process.env.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local';
  }

  /* Consulting the window inventory is a READ, so NO_WINDOW (which means
   * "never pop a window") does not by itself forbid it — but a test rig must
   * never reach the REAL host on :8200. So: consult when a window host is
   * explicitly configured (tests point this at a fake), or when we are not in
   * no-window mode at all (production). */
  private mayConsult(): boolean {
    return !!process.env.HARBOR_WB_WINDOW_HOST || !this.suppressed();
  }

  /** Is this pane already on screen? Returns the window id holding it, else
   *  null. (Owner 2026-08-10: "Open window" opened a SECOND window onto the same
   *  broker session — two views, one pty. Focus beats duplicate.) */
  private async windowShowing(paneid: string): Promise<string | null> {
    try {
      const res = await fetch(`${WINDOW_HOST}/windows`, { signal: AbortSignal.timeout(1200) });
      if (!res.ok) {
        return null;
      }
      const wins = (await res.json()) as Array<{ id: string; url?: string; tabs?: Array<{ url?: string }> }>;
      /* Compare PANES, not url strings. The three shapes a session can wear on
         screen (a tab in a shell, wrapped in ?tabs=, or a window's own url) are
         all collected by urlsOnScreen and then reduced to the pane they drive,
         so the match is on identity rather than on text that can nest. */
      for (const w of wins) {
        const panes = urlsOnScreen(w).map(paneOfSoloUrl);
        if (panes.includes(paneid)) {
          return w.id;
        }
      }
    } catch {
      /* host down / not answering — caller falls through to opening */
    }
    return null;
  }

  async inventory(): Promise<InventoryWindow[]> {
    try {
      const res = await fetch(`${WINDOW_HOST}/windows`, { signal: AbortSignal.timeout(1200) });
      if (!res.ok) {
        return [];
      }
      const wins = (await res.json()) as Array<{ id: string; url?: string; tabs?: Array<{ url?: string }> }>;
      return wins.map((w) => ({
        id: w.id,
        tabs: urlsOnScreen(w).map((u) => ({ paneid: paneOfSoloUrl(u), url: u })),
      }));
    } catch {
      return [];
    }
  }

  async focus(paneid: string, url?: string): Promise<ActionResult> {
    /* ONE WINDOW PER PTY — the established rule (Owner, 2026-08-10 and
     * reaffirmed 2026-08-18). A manager embedded in a window does not get to
     * decide where a session lands: it asks the engine, and the engine either
     * focuses the existing view or hands back permission to place a new one.
     * N managers therefore cannot race into N views of one pty. */
    if (!this.mayConsult() || !(await shellUp())) {
      return { ok: false };
    }
    const existing = await this.windowShowing(paneid);
    if (!existing) {
      return { ok: false };
    }
    try {
      const res = await fetch(`${WINDOW_HOST}/windows/${existing}/focus`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: url }),
      });
      record({ action: 'focus', paneid, ok: res.ok, via: 'loopback', window: existing });
      return res.ok ? { ok: true, placement: 'focused' } : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  async open(req: OpenRequest): Promise<ActionResult> {
    if (this.suppressed()) {
      return { ok: true, placement: req.placement };
    }
    record({ action: 'open', paneid: req.paneid, placement: req.placement, via: 'loopback' });
    /* FIRE AND FORGET, deliberately: the caller's HTTP answer must not wait on
     * a protocol kick that can take four seconds. `placement` is what the
     * engine DECIDED, not a report that a window is painted. */
    void (async () => {
      let up = await shellUp();
      if (up) {
        // ALREADY OPEN → focus that window (and its tab) instead of duplicating.
        const existing = req.paneid ? await this.windowShowing(req.paneid) : null;
        if (existing) {
          try {
            await fetch(`${WINDOW_HOST}/windows/${existing}/focus`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tab: req.url }),
            });
            return;
          } catch {
            /* focus failed — fall through and open */
          }
        }
      }
      if (!up) {
        // Protocol launch escapes our Job Object (explorer's registry handler
        // spawns it); idempotent on the host side (health-checks first).
        const kick = spawnProc('cmd.exe', ['/c', 'start', '', 'harbor-window-host://serve'], {
          detached: true,
          stdio: 'ignore',
        });
        kick.unref();
        for (let i = 0; i < 8 && !up; i++) {
          await new Promise((r) => setTimeout(r, 500));
          up = await shellUp();
        }
      }
      if (up) {
        try {
          const res = await fetch(`${WINDOW_HOST}/windows`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: shellUrl(req.url, req.byUserId) }),
          });
          if (res.ok) {
            return;
          }
        } catch {
          /* fall through to Edge */
        }
      }
      const child = spawnProc(
        'cmd.exe',
        ['/c', 'start', '', 'msedge', `--app=${withTicket(req.url, [ENGINE_ORIGIN], req.byUserId)}`],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
    })();
    return { ok: true, placement: req.placement };
  }

  async close(paneid: string, mode: 'park' | 'end'): Promise<ActionResult> {
    /* The :8200 control API has no close verb the engine has ever used — a
     * window is closed by the human or by the shell's own tab chrome. Answering
     * honestly beats inventing a call the toolkit may not answer. */
    record({ action: 'close', paneid, mode, ok: false, via: 'loopback', error: 'unsupported' });
    return { ok: false, error: 'unsupported' };
  }

  status(): DesktopStatus {
    return { mode: this.mode, agents: [], lastActions: [...lastActions] };
  }

  /* NO AGENT DIALS INTO THIS MODE, so there is nothing to ask. Answering
   * `false` here is what keeps `remoteFsAccess` honest: a loopback or headless
   * engine falls straight back to ssh-or-unreachable, exactly as before. */
  hasCapableAgent(): boolean {
    return false;
  }
  async requestAgent(): Promise<any> {
    throw new Error('engine is not in agent mode');
  }

  attachAgent(ws: WebSocket): void {
    /* Not this mode's channel. Refusing loudly beats a socket that registers
     * and is then never sent anything. */
    ws.close(4400, 'engine is not in agent mode');
  }
}

/* ---- none: there is no desktop -------------------------------------------- */

class NoDesktop implements DesktopActions {
  readonly mode: DesktopMode = 'none';

  soloUrlFor(pathAndQuery: string): string {
    return `${ENGINE_ORIGIN}${pathAndQuery}`;
  }
  async open(req: OpenRequest): Promise<ActionResult> {
    record({ action: 'open', paneid: req.paneid, placement: 'browser', via: 'none' });
    return { ok: true, placement: 'browser' };
  }
  async focus(): Promise<ActionResult> {
    return { ok: false };
  }
  async close(): Promise<ActionResult> {
    return { ok: false, error: 'no-desktop' };
  }
  async inventory(): Promise<InventoryWindow[]> {
    return [];
  }
  status(): DesktopStatus {
    return { mode: this.mode, agents: [], lastActions: [...lastActions] };
  }
  /* NO AGENT DIALS INTO THIS MODE, so there is nothing to ask. Answering
   * `false` here is what keeps `remoteFsAccess` honest: a loopback or headless
   * engine falls straight back to ssh-or-unreachable, exactly as before. */
  hasCapableAgent(): boolean {
    return false;
  }
  async requestAgent(): Promise<any> {
    throw new Error('engine is not in agent mode');
  }

  attachAgent(ws: WebSocket): void {
    ws.close(4400, 'engine is not in agent mode');
  }
}

/* ---- agent: the PULL path (contract §5b) ---------------------------------- */

const AGENT_TIMEOUT_MS = Number(process.env.HARBOR_WB_AGENT_TIMEOUT_MS ?? 5000);

interface AgentConn {
  ws: WebSocket;
  host: string;
  agent: string;
  capabilities: string[];
  version: string | null;
  base: string | null;
  connectedAt: number;
  lastInventoryAt: number | null;
  lastPresenceAt: number | null;
  presence: unknown;
  windows: InventoryWindow[];
  credentialed: boolean;
}

class AgentDesktop implements DesktopActions {
  readonly mode: DesktopMode = 'agent';
  /** ONE AGENT PER HOST (contract §5b). A re-register replaces the old socket:
   *  an agent that crashed and came back must not leave a dead twin that the
   *  engine then picks and waits five seconds on. */
  private agents = new Map<string, AgentConn>();
  private pending = new Map<string, (r: ActionResult) => void>();
  /** GENERIC request/response, beside the `window.*` one rather than replacing
   *  it. `window.result` is a STABLE frame with a fixed three-field shape
   *  (`ok`/`placement`/`error`) that the whole placement path is typed on;
   *  `fs.result` carries entries, bytes and matches. One map resolving both
   *  would have meant either widening ActionResult until it meant nothing, or
   *  parsing an fs reply through a placement lens. Same `req` namespace, so a
   *  reply can only ever land in the map that is waiting for it. */
  private rawPending = new Map<string, (msg: any) => void>();

  soloUrlFor(pathAndQuery: string): string {
    /* The engine's `127.0.0.1` is the ENGINE's machine. Once the engine is on
     * the server that is not where the window opens, so the agent tells us at
     * registration which address IT should use and we build against that. With
     * no agent (or one that registered no base) the loopback form is still the
     * right answer — it is what the browser fallback hands back, and a browser
     * on this machine resolves it correctly. */
    const base = this.pick()?.base;
    return base ? `${base.replace(/\/$/, '')}${pathAndQuery}` : `${ENGINE_ORIGIN}${pathAndQuery}`;
  }

  /** WHICH desktop? `HARBOR_WB_DESKTOP_HOST` names one explicitly; otherwise
   *  the most recently registered agent wins. Crawl assumption: there is one
   *  desktop (the VRPC today, a laptop later) — when two are routinely
   *  connected this needs a real answer from Owner, not a heuristic. */
  private pick(): AgentConn | null {
    const want = process.env.HARBOR_WB_DESKTOP_HOST;
    if (want) {
      return this.agents.get(want) ?? null;
    }
    let best: AgentConn | null = null;
    for (const a of this.agents.values()) {
      if (!best || a.connectedAt >= best.connectedAt) {
        best = a;
      }
    }
    return best;
  }

  /** The agent whose inventory holds this pane — agent-mode dedupe, on the
   *  paneid rather than on url text (the agent reports paneids directly). */
  private holderOf(paneid: string): AgentConn | null {
    for (const a of this.agents.values()) {
      for (const w of a.windows) {
        if (w.tabs.some((t) => t.paneid === paneid)) {
          return a;
        }
      }
    }
    return null;
  }

  private ask(a: AgentConn, msg: Record<string, unknown>): Promise<ActionResult> {
    const req = randomUUID().slice(0, 8);
    return new Promise<ActionResult>((resolve) => {
      const done = (r: ActionResult) => {
        if (this.pending.delete(req)) {
          clearTimeout(timer);
          resolve(r);
        }
      };
      /* A DESKTOP THAT NEVER ANSWERS MUST NOT HANG A LAUNCH. Five seconds is
       * already far past "a window appeared"; past it the engine answers the
       * caller honestly and the user still has the URL. */
      const timer = setTimeout(() => {
        done({ ok: false, error: 'agent-timeout' });
      }, AGENT_TIMEOUT_MS);
      this.pending.set(req, done);
      try {
        a.ws.send(JSON.stringify({ ...msg, req }));
      } catch (e) {
        done({ ok: false, error: `send failed: ${(e as Error).message}` });
      }
    });
  }

  async open(req: OpenRequest): Promise<ActionResult> {
    const a = this.pick();
    if (!a) {
      /* NO AGENT IS NOT AN ERROR (contract §5b). It is exactly the phone case:
       * the engine hands back the URL and the caller opens it itself. */
      record({ action: 'open', paneid: req.paneid, placement: 'browser', via: 'agent', error: 'no-agent' });
      return { ok: true, placement: 'browser' };
    }
    /* a PERSON's ticket goes only to an agent that holds the window agent's credential; any other gets a plain (non-person) ticket */
    if (req.byUserId && !a.credentialed) log(`window agent ${a.agent}@${a.host} is not credentialed: opening without a person ticket`);
    const url = withTicket(req.url, [ENGINE_ORIGIN, a.base ?? ''], a.credentialed ? req.byUserId : undefined);
    const r = await this.ask(a, {
      type: 'window.open',
      url,
      paneid: req.paneid,
      title: req.title ?? null,
      placement: req.placement,
      base: req.base ?? a.base ?? null,
      logoKey: req.logoKey ?? null,
    });
    record({
      action: 'open',
      paneid: req.paneid,
      placement: r.placement ?? req.placement,
      ok: r.ok,
      via: a.host,
      error: r.error,
    });
    if (!r.ok) {
      /* The desktop refused or went silent — the session still exists and the
       * caller still has the url, so degrade to the browser answer rather than
       * failing the launch. */
      return { ok: true, placement: 'browser', error: r.error };
    }
    return { ok: true, placement: r.placement ?? req.placement };
  }

  async focus(paneid: string): Promise<ActionResult> {
    const a = this.holderOf(paneid);
    if (!a) {
      return { ok: false };
    }
    const r = await this.ask(a, { type: 'window.focus', paneid });
    record({ action: 'focus', paneid, ok: r.ok, via: a.host, error: r.error });
    return r.ok ? { ok: true, placement: 'focused' } : { ok: false, error: r.error };
  }

  async close(paneid: string, mode: 'park' | 'end'): Promise<ActionResult> {
    const a = this.holderOf(paneid) ?? this.pick();
    if (!a) {
      return { ok: false, error: 'no-agent' };
    }
    const r = await this.ask(a, { type: 'window.close', paneid, mode });
    record({ action: 'close', paneid, mode, ok: r.ok, via: a.host, error: r.error });
    return r;
  }

  async inventory(): Promise<InventoryWindow[]> {
    const out: InventoryWindow[] = [];
    for (const a of this.agents.values()) {
      out.push(...a.windows);
    }
    return out;
  }

  status(): DesktopStatus {
    return {
      mode: this.mode,
      agents: [...this.agents.values()].map((a) => ({
        host: a.host,
        agent: a.agent,
        capabilities: a.capabilities,
        version: a.version,
        base: a.base,
        connectedAt: new Date(a.connectedAt).toISOString(),
        lastInventoryAt: a.lastInventoryAt ? new Date(a.lastInventoryAt).toISOString() : null,
        lastPresenceAt: a.lastPresenceAt ? new Date(a.lastPresenceAt).toISOString() : null,
        presence: a.presence,
        windows: a.windows,
      })),
      lastActions: [...lastActions],
    };
  }

  hasCapableAgent(host: string, capability: string): boolean {
    const a = this.agents.get(host);
    return !!a && a.ws.readyState === a.ws.OPEN && a.capabilities.includes(capability);
  }

  requestAgent(host: string, msg: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    const a = this.agents.get(host);
    if (!a) {
      return Promise.reject(new Error(`no window agent registered for host "${host}"`));
    }
    const req = randomUUID().slice(0, 8);
    return new Promise<any>((resolve, reject) => {
      const settle = (fn: () => void) => {
        if (this.rawPending.delete(req)) {
          clearTimeout(timer);
          fn();
        }
      };
      /* A DESKTOP THAT NEVER ANSWERS MUST NOT HANG A REQUEST — the same rule
       * `ask()` follows for windows, with a longer ceiling because reading a
       * multi-megabyte transcript over a tailnet is not "did a window appear".
       * A REJECTION, not an empty answer: the callers' whole contract is that
       * "could not find out" and "there is nothing there" are different
       * outcomes (project-dir.ts's three-outcome rule). */
      const timer = setTimeout(() => {
        settle(() => reject(new Error(`agent-timeout (${host} did not answer ${msg.type})`)));
      }, timeoutMs ?? AGENT_TIMEOUT_MS);
      this.rawPending.set(req, (reply) => settle(() => resolve(reply)));
      try {
        a.ws.send(JSON.stringify({ ...msg, req }));
      } catch (e) {
        settle(() => reject(new Error(`send failed: ${(e as Error).message}`)));
      }
    });
  }

  attachAgent(ws: WebSocket, remote: string, credentialed = false): void {
    let self: AgentConn | null = null;
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg?.type === 'register') {
        const host = typeof msg.host === 'string' && msg.host ? msg.host : remote;
        const prev = this.agents.get(host);
        if (prev && prev.ws !== ws && prev.credentialed && !credentialed) {
          /* a registration made with the window agent's credential is not replaced by a caller without it */
          log(`window agent registration for "${host}" REFUSED: held by a credentialed agent, caller is not`);
          try {
            ws.close(4403, 'registration held by a credentialed window agent');
          } catch {
            /* already gone */
          }
          return;
        }
        if (prev && prev.ws !== ws) {
          log(`window agent re-registered for "${host}" — dropping the previous socket`);
          try {
            prev.ws.close(4409, 'replaced by a newer agent');
          } catch {
            /* already gone */
          }
        }
        self = {
          ws,
          host,
          agent: typeof msg.agent === 'string' ? msg.agent : 'unknown',
          capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.map(String) : [],
          version: typeof msg.version === 'string' ? msg.version : null,
          base: typeof msg.base === 'string' && msg.base ? msg.base : null,
          connectedAt: Date.now(),
          lastInventoryAt: null,
          lastPresenceAt: null,
          presence: null,
          windows: [],
          credentialed,
        };
        this.agents.set(host, self);
        log(
          `window agent registered: ${self.agent}@${host} caps=[${self.capabilities.join(',')}] base=${self.base ?? '(none)'}`,
        );
        try {
          ws.send(JSON.stringify({ type: 'registered', host, engine: ENGINE_ORIGIN }));
        } catch {
          /* the register ack is a courtesy, not a gate */
        }
        return;
      }
      if (msg?.type === 'window.result' && typeof msg.req === 'string') {
        const done = this.pending.get(msg.req);
        if (done) {
          done({ ok: msg.ok === true, placement: msg.placement, error: msg.error });
        }
        return;
      }
      /* GENERIC REPLIES. Matched on `req` being one WE are waiting for, not on
         the type alone: an agent that answers a req twice, or answers one that
         already timed out, changes nothing (`rawPending.delete` is the guard),
         and a frame nobody asked for is ignored rather than dispatched. */
      if (typeof msg?.req === 'string' && this.rawPending.has(msg.req)) {
        this.rawPending.get(msg.req)!(msg);
        return;
      }
      if (msg?.type === 'window.inventory' && self) {
        self.windows = Array.isArray(msg.windows)
          ? msg.windows.map((w: any) => ({
              id: String(w?.id ?? ''),
              tabs: Array.isArray(w?.tabs)
                ? w.tabs.map((t: any) => ({
                    paneid: typeof t?.paneid === 'string' ? t.paneid : null,
                    url: typeof t?.url === 'string' ? t.url : undefined,
                    title: typeof t?.title === 'string' ? t.title : undefined,
                    state: typeof t?.state === 'string' ? t.state : undefined,
                  }))
                : [],
            }))
          : [];
        self.lastInventoryAt = Date.now();
        return;
      }
      if (msg?.type === 'presence' && self) {
        /* STORED, NOT ACTED ON (Crawl scope, the design notes):
         * record where the user is; routing on it is a later decision. */
        self.presence = { focused: msg.focused ?? null, input_ts: msg.input_ts ?? null };
        self.lastPresenceAt = Date.now();
        return;
      }
    });
    ws.on('close', () => {
      if (self && this.agents.get(self.host) === self) {
        this.agents.delete(self.host);
        log(`window agent gone: ${self.agent}@${self.host}`);
      }
    });
    ws.on('error', () => {
      /* close fires next; nothing to do here but not crash the engine */
    });
  }
}

/* ---- selection ------------------------------------------------------------ */

export function chooseMode(env: NodeJS.ProcessEnv = process.env): DesktopMode {
  /* LOCAL MODE: the app owns every window. The engine never opens one (no msedge, no `cmd /c start`, no window-host kick, no :8200 probe),
     whatever HARBOR_WB_DESKTOP says: a missing or wrong variable must never be able to pop a browser on a person's PC. */
  if ((env.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local') {
    return 'none';
  }
  const raw = (env.HARBOR_WB_DESKTOP ?? '').trim().toLowerCase();
  if (raw === 'agent' || raw === 'none') {
    return raw;
  }
  /* DEFAULT IS TODAY'S BEHAVIOUR, always. An unrecognised value falls here on
   * purpose: a typo must not silently disable every window on the desk. */
  return 'loopback';
}

export function makeDesktopActions(mode: DesktopMode = chooseMode()): DesktopActions {
  if (mode === 'agent') {
    return new AgentDesktop();
  }
  if (mode === 'none') {
    return new NoDesktop();
  }
  return new LoopbackDesktop();
}

/** The engine's one desktop. Chosen at boot from `HARBOR_WB_DESKTOP`. */
export const desktop: DesktopActions = makeDesktopActions();

/* AGENT-FS SELF-WIRING. `agent-fs.ts` deliberately does not import this module
 * (see its header: `server/auth.ts` mints a token file at import, which a unit
 * test asking one question about a target must not trigger), so the wiring runs
 * in the direction that is already heavy. Anything that loads a desktop gets a
 * working file reader with no step anyone can forget; anything that does not
 * gets `hasFsAgent() === false`, which is precisely the old behaviour. */
agentFs.setTransport({
  has: (host, capability) => desktop.hasCapableAgent(host, capability),
  request: (host, msg, timeoutMs) => desktop.requestAgent(host, msg, timeoutMs),
});
