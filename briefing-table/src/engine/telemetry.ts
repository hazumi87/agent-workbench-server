/* ============================================================================
 * NATS TELEMETRY (vk [ref]) — fire-and-forget installation telemetry, per the
 * health-ping conventions: subject `telemetry.app.cli-manager.pane-state`,
 * delta-only (the activity module already only reports CHANGES), never throws
 * into the hot path, at-most-once.
 *
 * service: the installation NATS on the server (nats://homeserver:4222). Env:
 *   HARBOR_WB_NATS_URL  override the server; set to '' or 'off' to disable
 *                       (tests run disabled so they never touch the network).
 * Initial connect failures retry quietly every 60s; once connected the nats
 * client handles reconnects itself.
 * ========================================================================== */

import { connect, type NatsConnection, StringCodec } from 'nats';
import { networkServicesRefused } from './local-guard.ts';

const RAW_URL = process.env.HARBOR_WB_NATS_URL;
const URL = RAW_URL === undefined ? '' : RAW_URL;
/* read at call time: a local engine never dials NATS, whatever HARBOR_WB_NATS_URL says (E6, local-guard.ts) */
const isEnabled = (): boolean => !networkServicesRefused() && URL !== '' && URL !== 'off';
const SUBJECT = 'telemetry.app.cli-manager.pane-state';

const sc = StringCodec();
let nc: NatsConnection | null = null;
let connecting = false;

function ensureConnected(): void {
  if (!isEnabled() || nc || connecting) {
    return;
  }
  connecting = true;
  connect({ servers: URL, maxReconnectAttempts: -1, waitOnFirstConnect: false })
    .then((c) => {
      nc = c;
      connecting = false;
      attachSubscriptions();
      c.closed().then(() => {
        nc = null; // terminal close → allow a fresh connect on next publish
        for (const s of subscriptions) {
          s.attached = false; // a fresh connection must re-subscribe
        }
      });
    })
    .catch(() => {
      // NATS down/unreachable — telemetry is optional; retry lazily.
      setTimeout(() => {
        connecting = false;
      }, 60_000).unref();
    });
}

/* SUBSCRIPTIONS [usage meter]: the engine is mostly a publisher, but the usage meter READS the
 * agent-usage probes' readings. Same posture as publishing: optional, quiet when NATS is off or down,
 * (re)attached lazily on every (re)connect, never throws into the caller. The handler gets the raw
 * subject and body; validation is the caller's job (the bus has no auth and no retention). */
const subscriptions: Array<{ subject: string; handler: (subject: string, body: string) => void; attached: boolean }> = [];
function attachSubscriptions(): void {
  if (!nc) {
    return;
  }
  for (const s of subscriptions) {
    if (s.attached) {
      continue;
    }
    try {
      nc.subscribe(s.subject, {
        callback: (err, msg) => {
          if (err) {
            return;
          }
          try {
            s.handler(msg.subject, sc.decode(msg.data));
          } catch {
            // a bad message must not take the engine down
          }
        },
      });
      s.attached = true;
    } catch {
      // retried on the next connect
    }
  }
}
export function subscribe(subject: string, handler: (subject: string, body: string) => void): void {
  subscriptions.push({ subject, handler, attached: false });
  if (!isEnabled()) {
    return;
  }
  try {
    ensureConnected();
    attachSubscriptions();
  } catch {
    // optional
  }
}

/* TEST SEAM. Nothing in the engine may reach past this module to NATS, so a
 * test that wants to see what WOULD go on the wire replaces the wire. It is
 * not a feature flag: `HARBOR_WB_NATS_URL=''` already disables publishing, and
 * a disabled publisher is indistinguishable from a working one from the
 * engine's side — which is the whole reason presence needed an observer here
 * rather than an assertion against a live broker. */
let publisher: ((subject: string, body: string) => void) | null = null;
export function setPublisher(fn: ((subject: string, body: string) => void) | null): void {
  publisher = fn;
}

/** Is the real transport configured? (Reported by /api/diag/presence so
 *  "published" and "would have published" are never confused.) */
export function enabled(): boolean {
  return isEnabled() || (publisher !== null && !networkServicesRefused());
}

/**
 * Fire-and-forget publish of one JSON payload on one subject.
 *
 * The pulse plane's rules apply to everything that goes through here (contract
 * §6, plan §1b): not durable, not addressed, not acknowledged, <= 1 KB, never a
 * message BODY. Anything needing delivery guarantees belongs on the message
 * fabric, which is a different process on purpose.
 */
export function publishJson(subject: string, payload: unknown): void {
  if (networkServicesRefused()) {
    return;
  }
  const body = JSON.stringify(payload);
  if (publisher) {
    publisher(subject, body);
    return;
  }
  if (!isEnabled()) {
    return;
  }
  try {
    ensureConnected();
    nc?.publish(subject, sc.encode(body));
  } catch {
    // never let telemetry break the engine
  }
}

export function publishPaneState(payload: {
  paneid: string;
  name: string | null;
  state: string;
}): void {
  publishJson(SUBJECT, { ...payload, ts: new Date().toISOString() });
}
