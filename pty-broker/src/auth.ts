/* ============================================================================
 * BROKER AUTH — the one gate in front of every shell this process holds.
 * Kept out of main.ts so the decisions are small enough to read and test.
 *
 *  - A token is REQUIRED. A broker without one refuses to start, unless the
 *    operator opts out with PTY_BROKER_ALLOW_NO_AUTH=1 AND binds loopback.
 *  - The token travels ONLY in the Authorization header. A query-string token
 *    lands in proxy and access logs, so `?token=` is not accepted.
 *  - A request carrying an Origin header is a browser page, never the engine
 *    (node clients send none). Reject it so a web page cannot drive the
 *    broker from the user's own browser (cross-site WebSocket hijacking).
 *  - The compare is constant-time.
 * ========================================================================== */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Shortest token the broker will start with. */
export const MIN_TOKEN_LENGTH = 16;

/** Largest single websocket message accepted. Input and resize commands are
 *  tiny; the default (100 MiB) lets any caller make the broker buffer that. */
export const MAX_PAYLOAD = 1024 * 1024;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export type StartupVerdict = { ok: true; warn?: string } | { ok: false; reason: string };

/** Decide whether the broker may start with this token, host and opt-out. */
export function checkStartup(token: string, host: string, allowNoAuth: boolean): StartupVerdict {
  if (token) {
    if (token.length < MIN_TOKEN_LENGTH) {
      return { ok: false, reason: `PTY_BROKER_TOKEN is too short (need at least ${MIN_TOKEN_LENGTH} characters)` };
    }
    return { ok: true };
  }
  if (!allowNoAuth) {
    return {
      ok: false,
      reason: 'PTY_BROKER_TOKEN is not set. The broker holds live shells and will not start without a token.',
    };
  }
  if (!LOOPBACK.has(host)) {
    return { ok: false, reason: `PTY_BROKER_ALLOW_NO_AUTH is only honoured on a loopback bind (host is ${host})` };
  }
  return { ok: true, warn: 'running WITHOUT authentication (PTY_BROKER_ALLOW_NO_AUTH=1, loopback only)' };
}

/** Constant-time string equality: hash both sides so length never leaks. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface UpgradeVerdict {
  ok: boolean;
  code?: number;
  message?: string;
}

/** Judge a websocket upgrade request. `token` is '' only in the opt-out mode. */
export function checkUpgrade(
  headers: { origin?: string | string[]; authorization?: string | string[] },
  token: string,
): UpgradeVerdict {
  if (headers.origin !== undefined) {
    return { ok: false, code: 403, message: 'Forbidden' };
  }
  if (!token) {
    return { ok: true };
  }
  const auth = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  if (typeof auth !== 'string' || !safeEqual(auth, `Bearer ${token}`)) {
    return { ok: false, code: 401, message: 'Unauthorized' };
  }
  return { ok: true };
}
