/* ============================================================================
 * BROKER CLIENT (vk [ref] Phase 2; multi-host routing vk [ref]) — the
 * engine's half of the broker seam, one LINK per broker host.
 *
 * FLEET MODEL: one engine, N brokers — every host that runs terminals holds
 * its own sessions (vrpc = local loopback broker; remote target = operator-managed systemd
 * on its tailscale bind; laptop later). The network between engine and a
 * remote broker is only a viewing/control pipe: UNREACHABLE ≠ DEAD.
 *
 * Protocol types come from the pty-broker PACKAGE (git-pinned npm dep — the
 * broker split to its platform-owned repo 2026-08-08); the engine still OWNS
 * the protocol spec. PROTOCOL_VERSION is checked against /health before use —
 * a mismatch refuses the link LOUDLY (never weird behavior).
 *
 * ENSURE-OR-REFUSE (local link only): if the local broker is down the engine
 * triggers the `harbor-pty-broker` scheduled task (Task Scheduler spawns it
 * OUTSIDE harbor's Job Object — the engine must never spawn it directly),
 * self-creates the task if missing, and if it STILL can't reach it, spawns
 * FAIL LOUDLY. Remote brokers are never ensured from here — their host's
 * supervisor (platform systemd) owns that; down = refuse with a clear error.
 *
 * AUTH (remote links): bearer via Authorization header. A current broker
 * refuses a bad bearer at the HTTP upgrade (401); an older one ACCEPTS the
 * upgrade and then closes 4401 — socket-open must never be read as
 * authenticated (platform's warning). Either way the link parks as
 * 'unauthorized' (slow retry, loud log) instead of reconnect-spamming a wrong
 * credential, and every close drains pending requests with the reason.
 * ========================================================================== */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { IDisposable } from 'node-pty';
import type { CliDescriptor, CliSession } from './cli-host.ts';
import { isWindows } from './platform.ts';
import { instancePath } from './data-dir.ts';
import { brokerAutostartEnabled } from './local-mode.ts';
import {
  BROKER_DEFAULT_PORT,
  PROTOCOL_VERSION,
  type BrokerEvent,
} from 'pty-broker/src/protocol.ts';

const LOCAL_PORT = Number(process.env.HARBOR_WB_BROKER_PORT) || BROKER_DEFAULT_PORT;

/** The env sent with a spawn. The broker starts a pane from ITS OWN environment plus this, so in local mode the broker's bearer
 *  (PTY_BROKER_TOKEN) and the engine's would reach every agent shell; blank values here override them. Other modes: unchanged. */
export function brokerSpawnEnv(
  descEnv: Record<string, string> | undefined,
  mode: string | undefined = process.env.HARBOR_WB_MODE,
  ours: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  const base = descEnv && Object.keys(descEnv).length ? descEnv : undefined;
  if ((mode ?? '').trim().toLowerCase() !== 'local') {
    return base;
  }
  const blank: Record<string, string> = { PTY_BROKER_TOKEN: '', HARBOR_WB_BROKER_TOKEN: '', HARBOR_WB_BROKER_TOKEN_FILE: '', HARBOR_WB_TOKEN: '', HARBOR_WB_TOKEN_FILE: '' };
  /* any variable of OURS that carries one of the secrets under another name is blanked too (the broker may hold the same name) */
  const secrets = [ours.HARBOR_WB_TOKEN, ours.HARBOR_WB_BROKER_TOKEN, ours.PTY_BROKER_TOKEN].filter((v): v is string => typeof v === 'string' && v.length >= 8);
  for (const [k, v] of Object.entries(ours)) {
    if (typeof v === 'string' && secrets.includes(v)) {
      blank[k] = '';
    }
  }
  return { ...(base ?? {}), ...blank };
}

/** '0' disables the scheduled-task trigger (tests boot their own scratch broker). */
const AUTOSTART = brokerAutostartEnabled(process.env); // always off in local mode: the app supervises the broker
const TASK_NAME = 'harbor-pty-broker';
const LAUNCHER = 'C:\\code\\pty-broker\\scripts\\broker-hidden-launch.vbs';

function log(msg: string): void {
  console.log(`[engine→broker] ${msg}`);
}

export type LinkStatus = 'up' | 'down' | 'unauthorized' | 'version-mismatch';

interface RemoteBrokerConfig {
  url: string; // ws://host:port  (the /broker path + http health derive from it)
  token?: string; // inline (tests); prefer tokenFile for real hosts
  /** Absolute path to a one-line bearer file (sealed-delivered by the broker's
   *  owner). Read FRESH at every ws connect — a rotation needs only the file
   *  replaced, no engine restart. */
  tokenFile?: string;
  /** OS of the broker's host — decides descriptor binaries spawned THERE (e.g.
   *  `ssh.exe` on Windows, where node-pty does no PATH/.exe search). Default
   *  linux; the engine's own host is never described here. */
  platform?: 'win32' | 'linux';
}

/** runtime of a configured remote broker host ('linux' when unset/unknown). */
export function brokerPlatform(host: string): 'win32' | 'linux' {
  const cfg = remoteConfigs()[host];
  return cfg?.platform === 'win32' ? 'win32' : 'linux';
}

/** Remote brokers: env HARBOR_WB_BROKERS (JSON, tests) > config.json `brokers`
 *  (gitignored runtime config — where the sealed-delivered homebase token lives). */
function remoteConfigs(): Record<string, RemoteBrokerConfig> {
  const envRaw = process.env.HARBOR_WB_BROKERS;
  if (envRaw) {
    try {
      return JSON.parse(envRaw);
    } catch {
      log('HARBOR_WB_BROKERS env is not valid JSON — ignoring');
    }
  }
  try {
    const cfg = JSON.parse(readFileSync(instancePath('config.json'), 'utf8'));
    return cfg.brokers && typeof cfg.brokers === 'object' ? cfg.brokers : {};
  } catch {
    return {};
  }
}

function ps(script: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20_000, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` }),
    );
  });
}

/* ------------------------------------------------------------- gap taps -- */

/* STREAM GAPS (the design notes §3.3). While a link's socket is down,
 * every byte its ptys emit is lost to the engine — the broker keeps them, the
 * engine never sees them. The screen model must know, or a pane it believes is
 * in sync silently is not. `close` fires when an open socket closes; `open`
 * fires once per re-attached session with the broker's own replay tail, which
 * the re-attach below already receives and used to discard. Both are emitted
 * SYNCHRONOUSLY from the socket handlers, so `open` reaches the listener before
 * any `data` event that follows the `attached` one. Observers only: a throw
 * never reaches the link. */
export type GapEvent =
  | { host: string; phase: 'close' }
  | { host: string; phase: 'open'; sid: string; replay: string };
const gapTaps: Array<(e: GapEvent) => void> = [];
export function onGap(fn: (e: GapEvent) => void): void {
  gapTaps.push(fn);
}
function emitGap(e: GapEvent): void {
  for (const fn of gapTaps) {
    try {
      fn(e);
    } catch {
      /* an observer must never break the link */
    }
  }
}

/* ------------------------------------------------------------------ link -- */

interface Wrapped {
  sid: string;
  session: CliSession;
  dataCbs: Set<(data: string) => void>;
  exitCbs: Set<(e: { exitCode: number }) => void>;
  exited: boolean;
  /** An attach was sent by the socket-open re-attach loop (not by adopt), so
   *  its `attached` answer is a gap's end and carries that gap's replay. */
  reattaching?: boolean;
}

export interface BrokerLink {
  readonly host: string;
  readonly isLocal: boolean;
  status(): LinkStatus;
  /** Is the socket open right now? A command sent while it is not is dropped
   *  silently (sendCmd), so this is what "was that resize delivered" can ask. */
  socketOpen(): boolean;
  /** Probe /health (+ protocolVersion gate). Local link may trigger the task. */
  ensure(): Promise<boolean>;
  spawn(sid: string, desc: CliDescriptor, size: { cols: number; rows: number }): Promise<CliSession>;
  adopt(sid: string): Promise<{ session: CliSession; replay: string } | null>;
  listLive(): Promise<string[]>;
}

function makeLink(
  host: string,
  wsUrl: string,
  opts: { isLocal: boolean; token?: string; tokenFile?: string },
): BrokerLink {
  const httpBase = wsUrl.replace(/^ws/, 'http').replace(/\/broker\/?$/, '');
  const brokerWs = wsUrl.endsWith('/broker') ? wsUrl : `${wsUrl.replace(/\/$/, '')}/broker`;

  let status: LinkStatus = 'down';
  let ws: WebSocket | null = null;
  let wsOpen = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const wrapped = new Map<string, Wrapped>();
  type Pending = { pred: (m: BrokerEvent) => boolean; resolve: (m: BrokerEvent) => void; reject: (e: Error) => void };
  const pending: Pending[] = [];

  async function probe(): Promise<boolean> {
    try {
      const r = await fetch(`${httpBase}/health`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) {
        status = 'down';
        return false;
      }
      const h = (await r.json()) as { protocolVersion?: number };
      // Legacy broker (pre-split, no version field) IS protocol v1 — the wire
      // vocabulary is identical. Refusing it would strand its held sessions
      // until someone restarts the broker (which kills them) — exactly what
      // "engine ships backward-compatible first" exists to prevent. Only an
      // EXPLICIT different version refuses.
      if (h.protocolVersion !== undefined && h.protocolVersion !== PROTOCOL_VERSION) {
        if (status !== 'version-mismatch') {
          log(`REFUSING broker '${host}': protocolVersion ${h.protocolVersion} != expected ${PROTOCOL_VERSION}`);
        }
        status = 'version-mismatch';
        return false;
      }
      if (status !== 'unauthorized') {
        status = 'up';
      }
      return status === 'up';
    } catch {
      status = 'down';
      return false;
    }
  }

  async function ensure(): Promise<boolean> {
    if (await probe()) {
      return true;
    }
    if (!opts.isLocal || !AUTOSTART || status === 'version-mismatch') {
      return false;
    }
    if (!isWindows) {
      // The scheduled-task dance below is a Windows mechanism (harbor-pty-broker
      // logon task). On any other host, ensuring the local broker is that host's
      // own supervisor's job (systemd on the server) — never the engine's; refuse
      // quietly rather than shell out to a binary that doesn't exist there.
      log('local broker is a systemd concern on this host; not ensuring');
      return false;
    }
    log('local broker down — triggering scheduled task');
    let run = await ps(`Start-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`);
    if (!run.ok) {
      log('task missing — self-creating (Register-ScheduledTask, per-user)');
      const create = await ps(
        `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${LAUNCHER}"'; ` +
          `$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; ` +
          `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero); ` +
          `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Settings $s -ErrorAction Stop`,
      );
      if (!create.ok) {
        log(`task create FAILED: ${create.out.slice(0, 300)}`);
        return false;
      }
      run = await ps(`Start-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`);
      if (!run.ok) {
        log(`task run FAILED: ${run.out.slice(0, 300)}`);
        return false;
      }
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await probe()) {
        log('local broker up');
        return true;
      }
    }
    log('local broker did not come up after task trigger');
    return false;
  }

  function sendCmd(cmd: unknown): void {
    if (ws && wsOpen) {
      ws.send(JSON.stringify(cmd));
    }
  }

  function awaitEvent(pred: (m: BrokerEvent) => boolean, timeoutMs = 10_000): Promise<BrokerEvent> {
    return new Promise((resolve, reject) => {
      const entry: Pending = { pred, resolve: null as never, reject };
      const t = setTimeout(() => {
        const i = pending.indexOf(entry);
        if (i >= 0) {
          pending.splice(i, 1);
        }
        reject(new Error(`broker '${host}' did not answer`));
      }, timeoutMs);
      entry.resolve = (m: BrokerEvent) => {
        clearTimeout(t);
        resolve(m);
      };
      pending.push(entry);
    });
  }

  function handleEvent(m: BrokerEvent): void {
    if (m.type === 'attached') {
      const w = wrapped.get(m.sid);
      if (w?.reattaching) {
        w.reattaching = false;
        if (m.alive) {
          emitGap({ host, phase: 'open', sid: m.sid, replay: m.replay });
        }
      }
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].pred(m)) {
        pending.splice(i, 1)[0].resolve(m);
      }
    }
    if (m.type === 'data') {
      const w = wrapped.get(m.sid);
      if (w) {
        for (const cb of w.dataCbs) {
          cb(m.data);
        }
      }
    } else if (m.type === 'exit') {
      const w = wrapped.get(m.sid);
      if (w && !w.exited) {
        w.exited = true;
        w.session.state = 'killed';
        wrapped.delete(m.sid);
        for (const cb of w.exitCbs) {
          cb({ exitCode: m.code });
        }
      }
    }
  }

  /** Bearer for THIS connect — tokenFile is read fresh on every attempt so a
   *  rotation is just a file replacement (no engine restart needed). */
  function currentToken(): string | undefined {
    if (opts.token) {
      return opts.token;
    }
    if (opts.tokenFile) {
      try {
        return readFileSync(opts.tokenFile, 'utf8').trim() || undefined;
      } catch {
        return undefined; // missing/unreadable — caller logs via tokenMissing()
      }
    }
    return undefined;
  }
  function tokenMissing(): boolean {
    return !!opts.tokenFile && currentToken() === undefined;
  }

  function connect(): void {
    const token = currentToken();
    ws = new WebSocket(brokerWs, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    /* A current broker refuses a bad or missing bearer at the HTTP upgrade (401), before any socket exists; an older one accepted the
       upgrade and closed 4401. Both mean the same thing here: the token is wrong. */
    let upgradeRefused = false;
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      upgradeRefused = res.statusCode === 401;
      ws?.terminate();
    });
    ws.on('open', () => {
      wsOpen = true;
      // Re-attach every tracked session so data pumps resume. A sid the broker
      // no longer knows (broker restarted → its PTYs died) synthesizes an exit.
      for (const w of [...wrapped.values()]) {
        w.reattaching = true;
        sendCmd({ type: 'attach', sid: w.sid });
        awaitEvent((m) => (m.type === 'attached' || m.type === 'error') && (m as { sid?: string }).sid === w.sid)
          .then((m) => {
            if (m.type === 'error' || (m.type === 'attached' && !m.alive)) {
              handleEvent({ type: 'exit', sid: w.sid, code: -1 });
            }
          })
          .catch(() => {});
      }
    });
    ws.on('message', (raw) => {
      try {
        handleEvent(JSON.parse(raw.toString()));
      } catch {
        /* ignore */
      }
    });
    ws.on('close', (closeCode) => {
      const code = upgradeRefused ? 4401 : closeCode;
      const wasOpen = wsOpen;
      wsOpen = false;
      if (wasOpen) {
        emitGap({ host, phase: 'close' });
      }
      // Drain pending with the close code — an "open then 4401-close" must
      // surface as unauthorized, never as a silent timeout (socket-open is
      // NOT authenticated; the broker rejects AFTER the upgrade).
      const err = new Error(
        code === 4401
          ? `broker '${host}' rejected the token (4401 unauthorized)`
          : `broker '${host}' connection closed (${code})`,
      );
      for (const p of pending.splice(0)) {
        p.reject(err);
      }
      if (code === 4401) {
        status = 'unauthorized';
        log(`broker '${host}' UNAUTHORIZED — check the configured token (slow retry)`);
        setTimeout(() => {
          if (status === 'unauthorized') {
            status = 'down'; // allow a fresh probe/attempt later
          }
        }, 60_000).unref();
        return; // no fast reconnect with a bad credential
      }
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (wrapped.size > 0 || opts.isLocal) {
            connect(); // keep pumps alive; idle remote links reconnect lazily
          }
        }, 2000);
        reconnectTimer.unref();
      }
    });
    ws.on('error', () => {});
  }

  async function ensureSocket(): Promise<void> {
    if (tokenMissing()) {
      // Configured for a token file that isn't there yet (sealed delivery
      // pending) — don't dial and eat a guaranteed 4401; fail with the real
      // reason instead.
      throw new Error(`broker '${host}' token file not readable yet (${opts.tokenFile}) — sealed delivery pending?`);
    }
    if (status === 'unauthorized') {
      throw new Error(`broker '${host}' rejected the token (4401 unauthorized)`);
    }
    if (wsOpen) {
      return;
    }
    if (!ws || ws.readyState === ws.CLOSED) {
      connect();
    }
    for (let i = 0; i < 40 && !wsOpen; i++) {
      if ((status as LinkStatus) === 'unauthorized') {
        throw new Error(`broker '${host}' rejected the token (4401 unauthorized)`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!wsOpen) {
      throw new Error(`broker '${host}' socket not open`);
    }
  }

  function makeWrapper(sid: string, pid: number): Wrapped {
    const w: Wrapped = {
      sid,
      dataCbs: new Set(),
      exitCbs: new Set(),
      exited: false,
      session: null as unknown as CliSession,
    };
    const pty = {
      pid,
      onData(cb: (data: string) => void): IDisposable {
        w.dataCbs.add(cb);
        return { dispose: () => w.dataCbs.delete(cb) };
      },
      onExit(cb: (e: { exitCode: number }) => void): IDisposable {
        w.exitCbs.add(cb);
        return { dispose: () => w.exitCbs.delete(cb) };
      },
      write(data: string): void {
        sendCmd({ type: 'input', sid, data });
      },
      resize(cols: number, rows: number): void {
        sendCmd({ type: 'resize', sid, cols, rows });
      },
      kill(): void {
        sendCmd({ type: 'kill', sid });
      },
    };
    w.session = { id: `bk:${host}:${sid}`, pty: pty as never, state: 'live' };
    wrapped.set(sid, w);
    return w;
  }

  return {
    host,
    isLocal: opts.isLocal,
    status: () => status,
    socketOpen: () => wsOpen,
    ensure,
    async spawn(sid, desc, size) {
      if (!(await ensure())) {
        throw new Error(
          opts.isLocal
            ? 'PTY-broker unavailable — sessions cannot be made restart-proof. Check the harbor-pty-broker scheduled task / broker.log.'
            : `broker '${host}' unreachable (${status}) — its host's supervisor owns it; sessions cannot spawn there right now.`,
        );
      }
      await ensureSocket();
      sendCmd({
        type: 'spawn',
        sid,
        binary: desc.binary,
        args: desc.args ?? [],
        cwd: desc.cwd ?? undefined,
        // R11: who this session is, layered on the broker's own clean env.
        env: brokerSpawnEnv(desc.env),
        cols: size.cols,
        rows: size.rows,
      });
      const m = await awaitEvent(
        (e) => (e.type === 'spawned' || e.type === 'error') && (e as { sid?: string }).sid === sid,
      );
      if (m.type === 'error') {
        throw new Error(m.message);
      }
      return makeWrapper(sid, (m as Extract<BrokerEvent, { type: 'spawned' }>).pid).session;
    },
    async adopt(sid) {
      try {
        await ensureSocket();
      } catch {
        return null;
      }
      sendCmd({ type: 'attach', sid });
      let m: BrokerEvent;
      try {
        m = await awaitEvent((e) => (e.type === 'attached' || e.type === 'error') && (e as { sid?: string }).sid === sid);
      } catch {
        return null;
      }
      if (m.type !== 'attached' || !m.alive) {
        return null;
      }
      const w = makeWrapper(sid, 0);
      return { session: w.session, replay: m.replay };
    },
    async listLive() {
      try {
        await ensureSocket();
      } catch {
        return [];
      }
      sendCmd({ type: 'list' });
      try {
        const m = (await awaitEvent((e) => e.type === 'list', 5000)) as Extract<BrokerEvent, { type: 'list' }>;
        return m.sessions.filter((s) => s.alive).map((s) => s.sid);
      } catch {
        return [];
      }
    },
  };
}

/* ------------------------------------------------------------- registry -- */

const links = new Map<string, BrokerLink>();

function initLinks(): void {
  if (links.size > 0) {
    return;
  }
  /* [hosted] HARBOR_WB_BROKER_TOKEN_FILE: the local broker's bearer. On a shared host
     (one broker per hosted user, each on its own loopback port) any local account can
     reach any port, so every per-instance broker runs with PTY_BROKER_TOKEN and its
     engine presents it. Unset = today (the server/VRPC local link sends no token). */
  const localTokenFile = process.env.HARBOR_WB_BROKER_TOKEN_FILE || undefined;
  /* LOCAL MODE hands the broker's bearer over in memory (HARBOR_WB_BROKER_TOKEN, per launch), never a file in the person's profile. */
  links.set('local', makeLink('local', `ws://127.0.0.1:${LOCAL_PORT}/broker`, { isLocal: true, token: process.env.HARBOR_WB_BROKER_TOKEN || undefined, tokenFile: localTokenFile }));
  for (const [host, cfg] of Object.entries(remoteConfigs())) {
    if (host === 'local' || !cfg?.url) {
      continue;
    }
    links.set(host, makeLink(host, cfg.url, { isLocal: false, token: cfg.token, tokenFile: cfg.tokenFile }));
  }
}

export function linkFor(host: string): BrokerLink | undefined {
  initLinks();
  return links.get(host);
}

export function allLinks(): BrokerLink[] {
  initLinks();
  return [...links.values()];
}

export function statuses(): Record<string, LinkStatus> {
  initLinks();
  return Object.fromEntries([...links.values()].map((l) => [l.host, l.status()]));
}

/* Back-compat surface for the local link (existing call sites). */
export function ensure(): Promise<boolean> {
  return linkFor('local')!.ensure();
}
export function spawn(
  sid: string,
  desc: CliDescriptor,
  size: { cols: number; rows: number },
): Promise<CliSession> {
  return linkFor('local')!.spawn(sid, desc, size);
}
/* REMOTE BROKERS COME AND GO ON THEIR OWN HOSTS' CLOCKS. A link that was down
 * when this engine booted (the VRPC still rebooting, a laptop asleep) stayed
 * `down` in statuses() until a spawn happened to ask for it, and whatever that
 * broker held was never adopted — the boot sweep is the only adopter. So the
 * manager read "vrpc: down" against a broker that had been up for an hour, and
 * an engine restarted while a host was away could never pick that host's parked
 * sessions back up (2026-09-17). This re-probes every non-local link on a slow
 * clock (one GET each) and hands a down→up transition to the caller, which owns
 * adoption. The local link is left alone: ensuring it has side effects
 * (schtasks on Windows, a log line elsewhere). */
export function startRecoverySweep(
  onUp: (link: BrokerLink, sids: string[]) => Promise<void>,
  intervalMs = 30_000,
): () => void {
  initLinks();
  const wasUp = new Map<string, boolean>();
  for (const l of allLinks()) {
    wasUp.set(l.host, l.status() === 'up');
  }
  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      for (const l of allLinks()) {
        if (l.isLocal) {
          continue;
        }
        const up = await l.ensure();
        const before = wasUp.get(l.host) ?? false;
        wasUp.set(l.host, up);
        if (up && !before) {
          log(`remote broker '${l.host}' reachable — adopting what it holds`);
          await onUp(l, await l.listLive());
        } else if (!up && before) {
          log(`remote broker '${l.host}' unreachable (${l.status()}) — its live rows are preserved, not reconciled (unreachable ≠ dead)`);
        }
      }
    } catch (err) {
      log(`broker recovery sweep: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

let lastAvailable = false;
export function noteAvailability(v: boolean): void {
  lastAvailable = v;
}
/* "Can this engine spawn ANYWHERE" — the manager's PTY-broker banner and the
 * /health `broker` flag. Not the LOCAL link alone: an engine whose own-host
 * broker is a named link (the server engine reaches its broker as `homebase` and its
 * loopback port is deliberately dead, 2026-09-17) would otherwise report
 * "unavailable" while every spawn works. Per-host truth is in statuses(). */
export function available(): boolean {
  initLinks();
  return lastAvailable || [...links.values()].some((l) => l.status() === 'up');
}
