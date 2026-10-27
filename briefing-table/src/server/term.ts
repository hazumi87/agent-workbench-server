/**
 * W3b TERMINAL ATTACH (room application [ref]/[ref]): POST /api/terminal-grants
 * and WS /term. Spec: W3b-ATTACH-GRANT draft 2 (security review R1-R7).
 *
 * The Workbench may show ONE seat's terminal, never "any pane" the way /pty
 * can. A socket here is bound to the one paneid its grant named, speaks a
 * small subset of the /pty vocabulary, and closes the moment the seat, the
 * pane or the person's sign-in stops matching what the grant was minted for.
 *
 * NOT A SECOND TERMINAL ENGINE. After redemption the socket is handed to the
 * EXISTING /pty connection handler through a filtering peer (TermPeer): /pty
 * does the attach, the replay, the control lease, the input guard and the
 * detach exactly as it does for a window. This file only decides what may
 * pass in each direction. The WebSocketServer is `noServer` and routed by
 * index.ts's one upgrade router (a second `{server, path}` instance would kill
 * /pty's handshakes, 2026-09-15).
 *
 * Off unless HARBOR_WB_TERM_GRANTS=1 [R7]. Never logs a grant or any input.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { readBody, sendJson } from './http-util.ts';
import { table } from '../table/endpoint.ts';
import * as sessions from '../engine/sessions.ts';
import * as roomBus from '../engine/room-bus.ts';
import * as identity from '../identity/auth.ts';
import * as auth from './auth.ts';
import { isLocalMode } from '../engine/local-mode.ts';
import * as idStore from '../identity/store.ts';
import {
  createGrantStore,
  createInputRate,
  entitlement,
  id8,
  lifetimeVerdict,
  originAllowed,
  FIRST_FRAME_MS,
  FRAME_MAX_BYTES,
  SOCKETS_PER_PERSON,
  TICK_MS,
  type Grant,
  type Lookups,
} from '../engine/term-grants.ts';

/* LOCAL MODE has the grants ON by default: the app's page holds only a 30-second single-use grant and never the cookie or the token. */
export const enabled = (): boolean => process.env.HARBOR_WB_TERM_GRANTS === '1' || isLocalMode(process.env);

export interface TermDeps {
  log(line: string): void;
  /** Hand a peer to the /pty connection handler (wss.emit('connection', …)). */
  ptyConnection(peer: WebSocket, req: IncomingMessage): void;
  /** Drop the lease if `peer` holds it and announce; false when it did not. */
  releaseControl(paneid: string, peer: WebSocket): boolean;
}

const lookups: Lookups = {
  room: (id) => table.getRoom(id),
  seats: (roomId) => table.listSeats(roomId),
  paneState: (paneid) => table.get(paneid)?.state,
};

const store = createGrantStore();
/** Redeemed sockets: per person (the cap of 4) and per pane (one controller). */
const byPerson = new Map<string, Set<TermPeer>>();
const byPane = new Map<string, Set<TermPeer>>();

/** application-chosen text (a frame type, a paneid, a seat) made safe for one log line:
 *  letters, digits and . _ : # - only, capped. Never a raw client string in a log. */
const logSafe = (t: unknown, max = 24): string => String(t).replace(/[^A-Za-z0-9._:#-]/g, '?').slice(0, max);

/** A person: a session or device cookie, no Authorization header, a row id. */
function personOf(req: IncomingMessage, p: identity.Principal | null): identity.Principal | null {
  if (req.headers.authorization) {
    return null; // a bearer, an API token or a pane token is never a person, in any mode
  }
  if (!p || (p.via !== 'session' && p.via !== 'device') || !p.credentialId) {
    return localPerson(req);
  }
  return p;
}

/** LOCAL MODE has no accounts. The ONE person is whoever holds the valid window cookie (`wb_auth`, from POST /login with the launch token),
 *  with no Authorization header. A fixed id and credential id, so a grant minted under it is refused under anything else. Null outside
 *  local mode, so a server-mode engine behaves exactly as before. */
const LOCAL_PERSON: identity.Principal = {
  userId: 'local-user',
  username: 'you',
  isAdmin: false,
  mustChangePassword: false,
  via: 'device',
  sessionId: null,
  evidence: null,
  credentialCreatedAt: null,
  credentialId: 'local-window-cookie',
  credentialName: 'this computer',
};
function localPerson(req: IncomingMessage): identity.Principal | null {
  if (!isLocalMode(process.env) || req.headers.authorization || !auth.authorized(req)) {
    return null;
  }
  return LOCAL_PERSON;
}

/** [R7] until pane owners land, one person only. Legacy has no accounts db. */
const personAccounts = (): number => (identity.enabled() ? idStore.countAccounts() : 1);

/** Is the pane's lease held by one of OUR sockets other than `except`? */
function termHoldsLease(paneid: string, except?: TermPeer): boolean {
  const holder = sessions.get(paneid)?.socket;
  return [...(byPane.get(paneid) ?? [])].some((p) => p !== except && p === (holder as unknown));
}

function track<K>(m: Map<K, Set<TermPeer>>, k: K, p: TermPeer, add: boolean): void {
  const set = m.get(k) ?? new Set<TermPeer>();
  if (add) {
    set.add(p);
    m.set(k, set);
  } else if (set.delete(p) && set.size === 0) {
    m.delete(k);
  }
}

/* ---- POST /api/terminal-grants ------------------------------------------ */

export async function handleMint(req: IncomingMessage, res: ServerResponse, principal: identity.Principal | null, deps: TermDeps): Promise<void> {
  if (!enabled()) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const person = personOf(req, principal);
  const refuse = (status: number, field: string, error: string, reason: string, extra = ''): void => {
    deps.log(`term-grant refused person=${person?.userId ?? '-'}${extra} reason=${reason}`);
    sendJson(res, status, { error, field });
  };
  if (!person) {
    refuse(403, 'credential', 'a terminal grant needs a person signed in with a cookie (no bearer, api token or pane token)', 'credential');
    return;
  }
  if (!originAllowed(req.headers)) {
    refuse(403, 'origin', 'the Origin header is missing or not allowed', 'origin');
    return;
  }
  if (personAccounts() > 1) {
    refuse(403, 'accounts', 'terminal grants are off while more than one person account exists (pane owners first)', 'accounts');
    return;
  }
  if (!store.allowMint(person.userId)) {
    refuse(429, 'rate', 'too many terminal grants; wait a minute', 'rate');
    return;
  }
  let b: Record<string, unknown>;
  try {
    const body = await readBody(req);
    b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    refuse(status, 'body', (e as Error).message, 'body');
    return;
  }
  for (const f of ['paneid', 'room', 'seat'] as const) {
    if (typeof b[f] !== 'string' || !b[f]) {
      refuse(400, f, `${f} is required`, `bad-${f}`);
      return;
    }
  }
  if (b.intent !== 'view' && b.intent !== 'control') {
    refuse(400, 'intent', "intent is 'view' or 'control'", 'bad-intent');
    return;
  }
  const paneid = b.paneid as string;
  const roomId = b.room as string;
  const intent = b.intent;
  const ent = entitlement({ roomId, seat: b.seat as string, paneid }, lookups);
  const at = ` pane=${logSafe(paneid, 80)} room=${logSafe(id8(roomId), 8)} seat=${ent.ok ? ent.handle : logSafe(b.seat, 40)} intent=${intent}`;
  if (!ent.ok) {
    refuse(ent.status, ent.field, ent.error, ent.reason, at);
    return;
  }
  if ((byPerson.get(person.userId)?.size ?? 0) >= SOCKETS_PER_PERSON) {
    refuse(429, 'sockets', `you already hold ${SOCKETS_PER_PERSON} open terminals`, 'sockets', at);
    return;
  }
  if (intent === 'control' && termHoldsLease(paneid)) {
    refuse(429, 'paneid', 'another Workbench terminal already controls this pane', 'control-held', at);
    return;
  }
  const grant = store.mint({ personId: person.userId, credentialId: person.credentialId!, paneid, intent, roomId, seatId: ent.seatId });
  deps.log(`term-grant minted person=${person.userId}${at}`);
  sendJson(res, 200, { grant, expires_in: 30, socket: '/term', paneid, intent });
}

/* ---- WS /term ------------------------------------------------------------ */

/** The socket as the /pty handler sees it: what it sends is filtered to the
 *  bound pane, what it receives is only what this file chose to forward. */
class TermPeer extends EventEmitter {
  readonly OPEN = 1;
  constructor(
    private readonly real: WebSocket,
    private readonly out: (raw: string) => void,
  ) {
    super();
  }
  get readyState(): number {
    return this.real.readyState;
  }
  send(raw: string): void {
    this.out(raw);
  }
  ping(): void {
    this.real.ping();
  }
  terminate(): void {
    this.real.terminate();
  }
  close(code?: number, reason?: string): void {
    this.real.close(code, reason);
  }
}

const upgradePerson = new WeakMap<IncomingMessage, identity.Principal>();

/** [R1] the person cookie, the allow-listed Origin, and TLS through Serve. */
function verify(info: { req: IncomingMessage }, done: (ok: boolean, code?: number, msg?: string) => void, log: (l: string) => void): void {
  const req = info.req;
  const no = (code: number, reason: string): void => {
    log(`term-grant refused upgrade reason=${reason}`);
    done(false, code, reason);
  };
  if (!enabled()) {
    return no(404, 'off');
  }
  let p: identity.Principal | null = null;
  try {
    p = personOf(req, identity.resolveIdentity(req));
  } catch {
    p = null; // could not tell: no socket
  }
  if (!p || p.mustChangePassword) {
    return no(401, 'credential');
  }
  if (!originAllowed(req.headers)) {
    return no(403, 'origin');
  }
  if (!isLocalMode(process.env) && !identity.isSecureRequest(req)) {
    return no(403, 'tls'); // local mode is a loopback socket on this PC: there is no TLS to demand
  }
  upgradePerson.set(req, p);
  done(true);
}

export function createTermSocket(deps: TermDeps) {
  /* maxPayload above the 64 KB cap so an oversized frame meets OUR 4429, not ws's 1009. */
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: FRAME_MAX_BYTES * 4,
    verifyClient: (info, done) => verify(info, done, deps.log),
  });
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    try {
      connection(ws, req, upgradePerson.get(req)!, deps);
    } catch (e) {
      deps.log(`term-grant closed reason=error ${(e as Error).message}`);
      ws.close(1011, 'error');
    }
  });
  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
  };
}

function connection(ws: WebSocket, req: IncomingMessage, person: identity.Principal, deps: TermDeps): void {
  let g: Grant | null = null;
  let handle = '-';
  let peer: TermPeer | null = null;
  let controlling = false;
  let bytesIn = 0;
  let closing = false;
  const openedAt = Date.now();
  let lastActivity = openedAt;
  const inputOk = createInputRate();
  const tag = (): string =>
    `person=${person.userId}` + (g ? ` pane=${g.paneid} room=${id8(g.roomId)} seat=${handle} intent=${g.intent}` : '');

  const shut = (code: number, reason: string): void => {
    if (closing) {
      return;
    }
    closing = true;
    deps.log(`term-grant closed ${tag()} reason=${reason} bytes_in=${bytesIn}`);
    ws.close(code, reason);
  };
  const refuse = (code: number, reason: string): void => {
    deps.log(`term-grant refused ${tag()} reason=${reason}`);
    shut(code, reason);
  };
  const fact = (body: string): void => {
    try {
      table.appendLine(g!.roomId, { kind: 'fact', body } as any, { actor: 'user' });
    } catch (e) {
      deps.log(`term-grant room line not posted ${tag()}: ${(e as Error).message}`);
    }
  };
  const recheck = (): boolean => {
    const ent = entitlement({ roomId: g!.roomId, seat: g!.seatId, paneid: g!.paneid }, lookups);
    return ent.ok;
  };

  const firstFrame = setTimeout(() => refuse(4401, 'no-grant'), FIRST_FRAME_MS);
  const onRoom = (_roomId: string, ev: roomBus.RoomBusEvent): void => {
    /* Deferred: a pane's own exit also changes its room, inside the same
       synchronous exit handler that then sends pane.exit; let that land first. */
    if (ev.type === 'room.state') {
      setImmediate(() => {
        if (!closing && !recheck()) {
          shut(4403, 'seat-changed');
        }
      });
    }
  };
  /* Lifetime [R3] and the sign-in it was opened under (a password change, a
     sign-out, a revoked row): re-read the cookie, no event to hook. */
  const tick = setInterval(() => {
    const why = lifetimeVerdict({ openedAt, lastActivity }, Date.now());
    if (why) {
      shut(4408, why);
      return;
    }
    if (personAccounts() > 1) {
      shut(4403, 'accounts'); // [R7] a second account appeared while this socket was open
      return;
    }
    let now: identity.Principal | null = null;
    try {
      now = identity.resolveIdentity(req) ?? localPerson(req);
    } catch {
      now = null;
    }
    if (!now || now.userId !== person.userId || now.credentialId !== person.credentialId) {
      shut(4403, 'session-invalidated');
    }
  }, TICK_MS);

  /** engine → client: the bound pane's pane.* events and pong, nothing else. */
  const outbound = (raw: string): void => {
    let m: { type?: string; paneid?: string; controlling?: boolean };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type !== 'pong' && !(m.paneid === g?.paneid && m.type?.startsWith('pane.'))) {
      return;
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(raw);
    }
    if (m.type === 'pane.data') {
      lastActivity = Date.now();
    } else if (m.type === 'pane.control') {
      if (m.controlling && !controlling) {
        fact(`${person.username} took control of @${handle}'s terminal.`);
        deps.log(`term-grant control-taken ${tag()}`);
      }
      controlling = !!m.controlling;
    } else if (m.type === 'pane.control-lost') {
      controlling = false;
    } else if (m.type === 'pane.exit') {
      shut(1000, 'pane-exit');
    } else if (m.type === 'pane.needs-launch') {
      shut(4403, 'not-live');
    }
  };
  const forward = (msg: Record<string, unknown>): void => {
    peer!.emit('message', Buffer.from(JSON.stringify(msg)));
  };

  const redeem = (msg: { type?: unknown; grant?: unknown }): void => {
    clearTimeout(firstFrame);
    if (msg.type !== 'grant') {
      return refuse(4401, 'first-frame-not-grant');
    }
    g = store.redeem(msg.grant); // atomic: gone now, whatever follows
    if (!g) {
      return refuse(4401, 'grant-unknown-or-expired');
    }
    handle = lookups.seats(g.roomId).find((s) => s.id === g!.seatId)?.handle ?? g.seatId; // for the log lines
    if (g.personId !== person.userId || g.credentialId !== person.credentialId) {
      return refuse(4403, 'wrong-person');
    }
    const ent = entitlement({ roomId: g.roomId, seat: g.seatId, paneid: g.paneid }, lookups);
    if (!ent.ok) {
      return refuse(4403, ent.reason);
    }
    if (personAccounts() > 1) {
      return refuse(4403, 'accounts'); // [R7] re-checked at redeem, not only at mint
    }
    if ((byPerson.get(person.userId)?.size ?? 0) >= SOCKETS_PER_PERSON) {
      return refuse(4429, 'sockets');
    }
    deps.log(`term-grant redeemed ${tag()}`);
    peer = new TermPeer(ws, outbound);
    track(byPerson, person.userId, peer, true);
    track(byPane, g.paneid, peer, true);
    roomBus.on(g.roomId, onRoom);
    deps.ptyConnection(peer as unknown as WebSocket, req);
    /* control = `reclaim`: take the keyboard only if nobody holds it. */
    forward({ type: 'attach', paneid: g.paneid, intent: g.intent === 'control' ? 'reclaim' : 'view', label: person.username, reattachOnly: true });
  };

  const onFrame = (raw: Buffer): void => {
    if (closing) {
      return;
    }
    if (raw.length > FRAME_MAX_BYTES) {
      return refuse(4429, 'frame-too-big');
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return refuse(g ? 4400 : 4401, 'not-json');
    }
    if (!msg || typeof msg !== 'object') {
      return refuse(g ? 4400 : 4401, 'not-an-object');
    }
    if (!g) {
      return redeem(msg);
    }
    const paneid = g.paneid;
    if (msg.type === 'ping') {
      return forward({ type: 'ping' });
    }
    if (msg.paneid !== paneid) {
      return refuse(4400, `frame-${logSafe(msg.type)}-wrong-pane`);
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      if (!inputOk()) {
        return refuse(4429, 'input-rate');
      }
      /* [R4] enforced here, not trusted to /pty alone: only the lease holder types. */
      if (sessions.get(paneid)?.socket !== (peer as unknown)) {
        deps.log(`term-grant refused ${tag()} reason=input-without-control`);
        ws.send(JSON.stringify({ type: 'pane.control-denied', paneid, command: 'input', holder: sessions.get(paneid)?.controllerLabel ?? null }));
        return;
      }
      bytesIn += Buffer.byteLength(msg.data);
      lastActivity = Date.now();
      return forward({ type: 'input', paneid, data: msg.data });
    }
    if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      return forward({ type: 'resize', paneid, cols: msg.cols, rows: msg.rows });
    }
    if (msg.type === 'takeControl') {
      if (termHoldsLease(paneid, peer!)) {
        deps.log(`term-grant refused ${tag()} reason=control-held`);
        ws.send(JSON.stringify({ type: 'pane.control-denied', paneid, command: 'takeControl', holder: sessions.get(paneid)?.controllerLabel ?? null }));
        return;
      }
      return forward({ type: 'takeControl', paneid, label: person.username });
    }
    if (msg.type === 'releaseControl') {
      if (deps.releaseControl(paneid, peer as unknown as WebSocket)) {
        fact(`${person.username} stopped controlling @${handle}'s terminal.`);
        deps.log(`term-grant control-released ${tag()}`);
      }
      return;
    }
    refuse(4400, `frame-${logSafe(msg.type)}`);
  };

  ws.on('message', (raw: Buffer) => {
    try {
      onFrame(raw);
    } catch (e) {
      deps.log(`term-grant frame failed ${tag()}: ${(e as Error).message}`);
      shut(1011, 'error');
    }
  });
  ws.on('pong', () => peer?.emit('pong'));
  ws.on('error', () => {
    /* the close that follows does the cleanup */
  });
  ws.on('close', () => {
    clearTimeout(firstFrame);
    clearInterval(tick);
    if (!closing) {
      closing = true;
      deps.log(`term-grant closed ${tag()} reason=client bytes_in=${bytesIn}`);
    }
    if (g && peer) {
      roomBus.off(g.roomId, onRoom);
      track(byPerson, person.userId, peer, false);
      track(byPane, g.paneid, peer, false);
      peer.emit('close'); // /pty's own close handler: detach, release the lease
    }
  });
}
