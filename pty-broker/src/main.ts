/* PTY broker: holds interactive terminal sessions across engine reconnects.
 * The engine supplies session operations; the broker owns PTYs, replay buffers,
 * resize/input delivery and exit tombstones. Authentication is enforced before
 * accepting a WebSocket connection. Run it as the agent account on loopback.
 * Protocol changes require matching engine support and independent review.
 */
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { checkStartup, checkUpgrade, MAX_PAYLOAD } from './auth.ts';
import {
  type BrokerCommand,
  BROKER_DEFAULT_PORT,
  PROTOCOL_VERSION,
  REPLAY_CAP,
  TOMBSTONE_MS,
} from './protocol.ts';

/* Env (PTY_BROKER_* preferred; HARBOR_WB_BROKER_PORT kept as a legacy alias
 * for the original VRPC deployment): */
const PORT =
  Number(process.env.PTY_BROKER_PORT) ||
  Number(process.env.HARBOR_WB_BROKER_PORT) ||
  BROKER_DEFAULT_PORT;
/** Bind address. Loopback by default (same-host engine); a cross-host broker
 *  (on another host) binds its private-network address — never a public interface. */
const HOST = process.env.PTY_BROKER_HOST || '127.0.0.1';
/** Bearer for every ws client, sent in the Authorization header only (a
 *  query-string token is not accepted). REQUIRED: the broker refuses to start
 *  without one unless PTY_BROKER_ALLOW_NO_AUTH=1 on a loopback bind. /health
 *  stays open — status-only, no session data beyond counts. */
const TOKEN = process.env.PTY_BROKER_TOKEN || '';
const ALLOW_NO_AUTH = process.env.PTY_BROKER_ALLOW_NO_AUTH === '1';
/** How long an exited sid keeps its buffer + exit code before being forgotten.
 *  TEST-ONLY override: the stale-tombstone regression (2026-08-09) has to watch
 *  a deadline elapse, and the 10-minute production value makes that untestable
 *  in CI. Never set this in a real deployment — a short tombstone means a
 *  briefly-detached engine loses the exit code it came back to read. */
const TOMBSTONE = Number(process.env.PTY_BROKER_TOMBSTONE_MS) || TOMBSTONE_MS;
const startedAt = Date.now();

function log(msg: string): void {
  console.log(`[broker] ${new Date().toISOString()} ${msg}`);
}

interface Held {
  sid: string;
  pty: IPty | null; // null once exited
  pid: number;
  buffer: string;
  client: WebSocket | null; // at most ONE attached viewer (engine socket)
  alive: boolean;
  exitCode: number | null;
  createdAt: number;
  tombstoneTimer?: NodeJS.Timeout;
}

const held = new Map<string, Held>();

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function pushBuffer(h: Held, data: string): void {
  h.buffer += data;
  if (h.buffer.length > REPLAY_CAP) {
    h.buffer = h.buffer.slice(h.buffer.length - REPLAY_CAP);
  }
}

function listSessions() {
  return [...held.values()].map((h) => ({
    sid: h.sid,
    pid: h.pid,
    alive: h.alive,
    exitCode: h.exitCode,
    createdAt: h.createdAt,
    attached: h.client !== null,
  }));
}

function handleSpawn(ws: WebSocket, cmd: Extract<BrokerCommand, { type: 'spawn' }>): void {
  if (held.get(cmd.sid)?.alive) {
    send(ws, { type: 'error', sid: cmd.sid, message: `sid already live: ${cmd.sid}` });
    return;
  }
  // Env: broker's own env (clean logon env, never harbor's) + client overrides.
  // CLAUDE_CODE_CHILD_SESSION stripped as defense-in-depth: a leaked marker
  // silently disables transcript saving and breaks crash restore (engine
  // strips it too, but dev/test clients may not).
  const env = { ...process.env, ...(cmd.env ?? {}) } as Record<string, string>;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  let pty: IPty;
  try {
    pty = ptySpawn(cmd.binary, cmd.args ?? [], {
      name: 'xterm-color',
      cols: cmd.cols,
      rows: cmd.rows,
      cwd: cmd.cwd ?? process.env.USERPROFILE ?? process.cwd(),
      env,
    });
  } catch (err) {
    // node-pty throws synchronously on a bad binary (e.g. `ssh` vs `ssh.exe`).
    // Never let a bad spawn take the broker down — it holds everyone's shells.
    send(ws, { type: 'error', sid: cmd.sid, message: `spawn failed: ${(err as Error).message}` });
    return;
  }
  const h: Held = {
    sid: cmd.sid,
    pty,
    pid: pty.pid,
    buffer: '',
    client: ws,
    alive: true,
    exitCode: null,
    createdAt: Date.now(),
  };
  // Disarm the PREVIOUS incarnation's tombstone before overwriting the entry.
  // The timer deletes by sid, and sids are stable across relaunches (the engine
  // uses paneid = `recipe:<id>`), so a recipe relaunched inside TOMBSTONE_MS
  // would have the dead run's timer delete the LIVE entry — leaving an orphan
  // pty that is alive but unroutable: no input, no output, no reattach.
  // A stale tombstone timer must never delete a replacement session.
  const prev = held.get(cmd.sid);
  if (prev?.tombstoneTimer) {
    clearTimeout(prev.tombstoneTimer);
    prev.tombstoneTimer = undefined;
  }
  held.set(cmd.sid, h);
  pty.onData((data) => {
    pushBuffer(h, data);
    if (h.client) {
      send(h.client, { type: 'data', sid: h.sid, data });
    }
  });
  pty.onExit(({ exitCode }) => {
    h.alive = false;
    h.exitCode = exitCode;
    h.pty = null;
    if (h.client) {
      send(h.client, { type: 'exit', sid: h.sid, code: exitCode });
    }
    // Tombstone: keep buffer + code around briefly so a detached engine can
    // still learn the outcome on reattach, then forget the sid entirely.
    h.tombstoneTimer = setTimeout(() => held.delete(h.sid), TOMBSTONE);
    h.tombstoneTimer.unref();
    log(`exit sid=${h.sid} code=${exitCode} (${held.size} held)`);
  });
  send(ws, { type: 'spawned', sid: cmd.sid, pid: pty.pid });
  log(`spawn sid=${cmd.sid} pid=${pty.pid} ${cmd.binary} (${held.size} held)`);
}

function handleMessage(ws: WebSocket, cmd: BrokerCommand): void {
  switch (cmd.type) {
    case 'spawn':
      handleSpawn(ws, cmd);
      return;
    case 'attach': {
      const h = held.get(cmd.sid);
      if (!h) {
        send(ws, { type: 'error', sid: cmd.sid, message: `unknown sid: ${cmd.sid}` });
        return;
      }
      h.client = ws; // new viewer takes over (mirrors the engine's reattach)
      send(ws, {
        type: 'attached',
        sid: h.sid,
        replay: h.buffer,
        alive: h.alive,
        ...(h.exitCode !== null ? { exitCode: h.exitCode } : {}),
      });
      return;
    }
    case 'detach': {
      const h = held.get(cmd.sid);
      if (h && h.client === ws) {
        h.client = null;
      }
      return;
    }
    case 'input':
      held.get(cmd.sid)?.pty?.write(cmd.data);
      return;
    case 'resize': {
      const h = held.get(cmd.sid);
      if (h?.pty && cmd.cols > 0 && cmd.rows > 0) {
        try {
          h.pty.resize(cmd.cols, cmd.rows);
        } catch {
          /* resizing a dying pty throws — harmless */
        }
      }
      return;
    }
    case 'kill': {
      const h = held.get(cmd.sid);
      if (h?.pty) {
        try {
          h.pty.kill();
        } catch {
          /* already gone */
        }
      }
      return;
    }
    case 'list':
      send(ws, { type: 'list', sessions: listSessions() });
      return;
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        role: 'pty-broker',
        protocolVersion: PROTOCOL_VERSION, // engine checks at connect; mismatch fails LOUDLY
        pid: process.pid,
        sessions: listSessions().length,
        live: listSessions().filter((s) => s.alive).length,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server,
  path: '/broker',
  maxPayload: MAX_PAYLOAD,
  // Judged at the HTTP upgrade, so an unauthenticated caller never gets a socket.
  verifyClient: (info, done) => {
    const v = checkUpgrade(info.req.headers, TOKEN);
    if (!v.ok) {
      log(`rejected ws upgrade (${v.code})`);
      done(false, v.code, v.message);
      return;
    }
    done(true);
  },
});
wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw) => {
    let cmd: BrokerCommand;
    try {
      cmd = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // A throw inside a ws message handler is process-fatal (the engine learned
    // this the hard way, 2026-07-07) — and this process holds every shell.
    try {
      handleMessage(ws, cmd);
    } catch (err) {
      send(ws, { type: 'error', message: (err as Error).message });
    }
  });
  ws.on('close', () => {
    // The engine died/restarted: sessions just lose their viewer and keep
    // running. That IS the product.
    for (const h of held.values()) {
      if (h.client === ws) {
        h.client = null;
      }
    }
  });
  ws.on('error', () => {});
});

process.on('uncaughtException', (err) => {
  // Last-resort guard: log and keep holding sessions. A broker exit kills
  // every terminal it holds — prefer a degraded broker over that.
  log(`UNCAUGHT: ${err.stack ?? err.message}`);
});

const startup = checkStartup(TOKEN, HOST, ALLOW_NO_AUTH);
if (!startup.ok) {
  log(`FATAL: ${startup.reason}`);
  process.exit(1);
}
if (startup.warn) {
  log(`WARNING: ${startup.warn}`);
}

server.listen(PORT, HOST, () => {
  log(`pty-broker up on http://${HOST}:${PORT} (ws /broker, health /health)`);
});
