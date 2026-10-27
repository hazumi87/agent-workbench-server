/* ============================================================================
 * ENGINE RELAY FOR VRPC CHANNEL PANES — `WS /api/fabric/relay?paneid=<id>`
 * Implements the relay protocol for remote MCP channel clients.
 *
 * WHY A RELAY. The fabric listens on the server's loopback only. A claude pane on
 * the server runs fabric-mcp in channel mode and dials it directly; a claude pane
 * on the VRPC cannot. So its fabric-mcp dials THIS route instead (over Serve,
 * tailnet-only, the engine bearer), and the engine opens the pane's fabric
 * subscription on its behalf, AS the pane's instance (the engine already owns
 * the pane's check-in, fabric-checkin.ts). No new fabric surface.
 *
 * ONE FABRIC SOCKET PER RELAY SOCKET, never the shared multi-slug subscriber.
 * That pairing is what keeps `/presence?paneid=` honest: the fabric counts
 * sockets per instance and reports the pane's channel live while one is open,
 * so "live" ⇔ "the VRPC client is connected right now". Either side closing
 * closes the other: relay closes → fabric socket closes (the pane falls back
 * to typing); fabric closes → relay closes 1011 and the client reconnects.
 *
 * FRAMES.
 *   client → engine  {type:'hello', caps:['channel'], ack:'emit'|'none'}  first
 *                    {type:'ack', id, level}  → POST /ack, X-Fabric-Instance
 *                    anything else → {type:'error', error:'unknown frame'},
 *                    never a close
 *   engine → client  every fabric frame VERBATIM; `ready` gains {slug, instance}
 * CLOSE CODES. 4404 'no-pane' (not a live pane of this engine; the client
 * retries), 1011 (fabric closed / could not be reached / no instance; retry).
 * 401 is answered at the HTTP upgrade by the router's verifyClient — the
 * relay has NO loopback exemption (it delivers content into a pane).
 *
 * RECEIPT. A relayed channel pane runs with FABRIC_CHANNEL_ACK=emit, so its
 * `delivered` ack arrives here as a frame. `waitAck` lets channels.routeFabric
 * use that as the receipt for a pane whose transcript is on another host's
 * disk — without it every VRPC channel message would ALSO be typed.
 *
 * COUNTS ONLY in logs and diag, never message content.
 * ========================================================================== */

import { WebSocket } from 'ws';
import * as fabricSub from './fabric-subscriber.ts';
import * as fabricCheckin from './fabric-checkin.ts';

export interface RelayDeps {
  /** Is this paneid a LIVE pane row of this engine? */
  isLive(paneid: string): boolean;
  log(line: string): void;
}

interface Relay {
  paneid: string;
  client: WebSocket;
  upstream: WebSocket | null;
  instance: string | null;
  slug: string | null;
  helloSeen: boolean;
  ackMode: 'emit' | 'none' | null;
  since: number;
  toClient: number;
  fromClient: number;
  acks: number;
  alive: boolean;
  closed: boolean;
}

const relays = new Set<Relay>();
let deps: RelayDeps | null = null;
let token = '';
let pingTimer: ReturnType<typeof setInterval> | null = null;
const counters = { opened: 0, refusedNoPane: 0, upstreamFailed: 0, acksForwarded: 0, ackFailures: 0, unknownFrames: 0 };

/** Recent relayed `delivered` acks (id → at), and receipt waiters (id → cbs).
 *  The ack can land BEFORE routeFabric starts waiting (the pane's MCP and the
 *  engine's shared subscriber get the envelope at the same moment). */
const RECENT_MS = 60_000;
const recentAcks = new Map<string, number>();
const waiters = new Map<string, Array<(ok: boolean) => void>>();

const PING_MS = Number(process.env.HARBOR_WB_FABRIC_RELAY_PING_MS) || 30_000;
const LEVELS = new Set(['delivered', 'seen', 'answered', 'resolved']);

function log(line: string): void {
  deps?.log(`fabric-relay: ${line}`);
}

function sendTo(ws: WebSocket | null, frame: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }
}

function closeBoth(r: Relay, code: number, reason: string): void {
  if (r.closed) {
    return;
  }
  r.closed = true;
  relays.delete(r);
  try {
    r.upstream?.close();
  } catch {
    /* already gone */
  }
  try {
    if (r.client.readyState === WebSocket.OPEN || r.client.readyState === WebSocket.CONNECTING) {
      r.client.close(code, reason);
    }
  } catch {
    /* already gone */
  }
  log(`${r.paneid}: closed (${code} ${reason}) — ${r.toClient} out, ${r.fromClient} in, ${r.acks} acks`);
}

function noteAck(id: string): void {
  const now = Date.now();
  recentAcks.set(id, now);
  for (const [k, at] of recentAcks) {
    if (now - at < RECENT_MS) {
      break; // insertion-ordered: the rest are newer
    }
    recentAcks.delete(k);
  }
  const ws = waiters.get(id);
  if (ws) {
    waiters.delete(id);
    for (const cb of ws) cb(true);
  }
}

/** Is a relay socket (with an open fabric subscription) carrying this pane? */
export function hasRelay(paneid: string): boolean {
  for (const r of relays) {
    if (r.paneid === paneid && r.upstream?.readyState === WebSocket.OPEN) {
      return true;
    }
  }
  return false;
}

/** Resolves true once the pane's relayed MCP acks `delivered` for `id`
 *  (or already did, within the last minute), false after `ms`. */
export function waitAck(id: string, ms: number): Promise<boolean> {
  if (recentAcks.has(id)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const cb = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      const list = waiters.get(id)?.filter((f) => f !== cb) ?? [];
      if (list.length) waiters.set(id, list);
      else waiters.delete(id);
      resolve(false);
    }, ms);
    timer.unref?.();
    waiters.set(id, [...(waiters.get(id) ?? []), cb]);
  });
}

/* --------------------------------------------------------------------------
 * CONNECTION — called by the server's one upgrade router after verifyClient.
 * ------------------------------------------------------------------------ */
export function attach(client: WebSocket, paneid: string): void {
  const r: Relay = {
    paneid,
    client,
    upstream: null,
    instance: null,
    slug: null,
    helloSeen: false,
    ackMode: null,
    since: Date.now(),
    toClient: 0,
    fromClient: 0,
    acks: 0,
    alive: true,
    closed: false,
  };
  let live = false;
  try {
    live = !!paneid && !!deps?.isLive(paneid);
  } catch {
    live = false;
  }
  if (!live) {
    counters.refusedNoPane++;
    client.close(4404, 'no-pane');
    return;
  }
  counters.opened++;
  relays.add(r);
  log(`${paneid}: relay open`);
  client.on('pong', () => {
    r.alive = true;
  });
  client.on('close', () => closeBoth(r, 1000, 'client closed'));
  client.on('error', () => closeBoth(r, 1011, 'client error'));
  client.on('message', (raw) => {
    /* An async throw in a ws handler is engine-fatal (CLAUDE.md trap): every
       path is caught here. */
    onClientFrame(r, String(raw)).catch((e) => log(`${paneid}: frame handler threw: ${(e as Error).message}`));
  });
}

async function onClientFrame(r: Relay, raw: string): Promise<void> {
  r.fromClient++;
  let f: any;
  try {
    f = JSON.parse(raw);
  } catch {
    f = null;
  }
  if (f && f.type === 'hello') {
    const caps = Array.isArray(f.caps) ? f.caps.filter((c: unknown) => typeof c === 'string') : [];
    r.ackMode = f.ack === 'emit' ? 'emit' : 'none';
    const first = !r.helloSeen;
    r.helloSeen = true;
    await fabricCheckin.ensure(r.paneid);
    if (caps.includes('channel')) {
      await fabricCheckin.declareCaps(r.paneid, ['channel']);
    }
    if (first && !r.closed) {
      openUpstream(r);
    }
    return;
  }
  if (f && f.type === 'ack') {
    if (typeof f.id !== 'string' || !f.id || !LEVELS.has(f.level)) {
      sendTo(r.client, { type: 'error', error: 'ack needs {id, level: delivered|seen|answered|resolved}' });
      return;
    }
    if (!r.instance) {
      sendTo(r.client, { type: 'error', error: 'not ready: send hello and wait for ready', id: f.id });
      return;
    }
    r.acks++;
    if (f.level === 'delivered') {
      noteAck(f.id);
    }
    try {
      const a = await fabricCheckin.request('POST', '/ack', { id: f.id, level: f.level }, r.instance, 3_000);
      if (a.status < 400 || a.status === 409) {
        counters.acksForwarded++; // 409 = already further up the ladder: benign
      } else {
        counters.ackFailures++;
        sendTo(r.client, { type: 'error', error: `ack refused (HTTP ${a.status})`, id: f.id });
      }
    } catch (e) {
      counters.ackFailures++;
      sendTo(r.client, { type: 'error', error: `ack failed: ${(e as Error).message}`, id: f.id });
    }
    return;
  }
  counters.unknownFrames++;
  sendTo(r.client, { type: 'error', error: 'unknown frame' });
}

function openUpstream(r: Relay): void {
  const { url, enabled } = fabricSub.endpoint();
  const id = fabricCheckin.identityOf(r.paneid);
  const project = fabricCheckin.projectOf(r.paneid);
  if (!enabled || !id) {
    counters.upstreamFailed++;
    closeBoth(r, 1011, enabled ? 'no-instance' : 'fabric-off');
    return;
  }
  r.instance = id.instance;
  r.slug = id.slug;
  const up = new WebSocket(`${url.replace(/^http/, 'ws')}/subscribe?instance=${encodeURIComponent(id.instance)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  r.upstream = up;
  up.on('unexpected-response', (_req, res) => {
    counters.upstreamFailed++;
    closeBoth(r, 1011, `fabric upgrade ${res.statusCode}`);
  });
  up.on('error', (e) => {
    counters.upstreamFailed++;
    closeBoth(r, 1011, `fabric error: ${e.message}`);
  });
  up.on('close', () => closeBoth(r, 1011, 'fabric closed'));
  up.on('message', (raw) => {
    const text = String(raw);
    let f: any = null;
    try {
      f = JSON.parse(text);
    } catch {
      /* forwarded verbatim below */
    }
    if (f && f.type === 'ready') {
      r.toClient++;
      sendTo(r.client, { ...f, slug: r.slug, instance: r.instance });
      const slugs = [...new Set([r.slug, project].filter(Boolean))];
      sendTo(up, { type: 'subscribe', slugs });
      return;
    }
    r.toClient++;
    sendTo(r.client, text);
  });
}

/** The pane ended: its relay has nothing left to carry. */
export function closePane(paneid: string): void {
  for (const r of [...relays]) {
    if (r.paneid === paneid) {
      closeBoth(r, 4404, 'no-pane');
    }
  }
}

export function start(opts: { token: string; deps: RelayDeps }): void {
  token = opts.token;
  deps = opts.deps;
  if (!pingTimer) {
    /* A VRPC client that vanished without a close would keep the pane's
       channel "live" and its mail untyped. Ping; no pong by the next round
       → terminate (which closes the fabric socket too). */
    pingTimer = setInterval(() => {
      for (const r of [...relays]) {
        try {
          if (!r.alive) {
            r.client.terminate();
            closeBoth(r, 1011, 'no pong');
            continue;
          }
          r.alive = false;
          r.client.ping();
        } catch {
          /* a throw in a timer is engine-fatal */
        }
      }
    }, PING_MS);
    pingTimer.unref?.();
  }
}

/** Relay sockets per pane, for /api/diag/fabric. Counts only. */
export function dump(): Record<string, unknown> {
  const panes: Record<string, unknown[]> = {};
  for (const r of relays) {
    (panes[r.paneid] ??= []).push({
      since: new Date(r.since).toISOString(),
      hello: r.helloSeen,
      ack: r.ackMode,
      upstreamOpen: r.upstream?.readyState === WebSocket.OPEN,
      slug: r.slug,
      instance: r.instance,
      toClient: r.toClient,
      fromClient: r.fromClient,
      acks: r.acks,
    });
  }
  return {
    sockets: relays.size,
    panes: Object.fromEntries(Object.entries(panes).map(([k, v]) => [k, { sockets: v.length, relays: v }])),
    counters: { ...counters },
  };
}
