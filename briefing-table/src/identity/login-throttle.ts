/* THE LOGIN THROTTLE behind Serve (Add a server, design review [ref] condition 4; the decision is logged as an ASSUMPTION for Owner).
 *
 * THE PROBLEM. server/auth.ts's throttle keys on the SOCKET address. Behind Tailscale Serve every remote caller is 127.0.0.1, so ALL remote callers share one bucket:
 * it stops brute force, but anyone on the tailnet can lock the login out for everyone with ten bad guesses.
 *
 * THE DEFAULT (the safest one, all tunable by env, counts in memory, reset on restart; a window is 5 minutes):
 *   1. per CLIENT: the tailnet node key when the request carries evidence (serve-xff or peer), else the socket address. 10 failures.
 *   2. per ACCOUNT NAME (lower-cased; also for a name that does not exist, so the throttle cannot tell which names are real). 20 failures. A device cannot be locked
 *      out by someone else's guessing, because (1) fires first for the guesser; (2) exists for a guesser who ROTATES devices.
 *   3. GLOBAL cap: 60 failures across everyone. The last resort against a distributed guess; it can lock everyone out for the rest of a window, which is the price of a
 *      limit that cannot be walked around. A SUCCESSFUL sign-in clears only that client's and that account's counters, never the global one.
 * A throttled attempt is answered exactly like a wrong password ("Too many attempts"), never "this account exists".
 * The evidence behind Serve is FORGEABLE by anything that can reach the loopback port (tailnet-evidence.ts): a forger can dodge (1) by varying the header, which is what
 * (2) and (3) are for. That is why the key is a node key and not a trust decision. */
import type { IncomingMessage } from 'node:http';
import { evidenceFor } from './tailnet-evidence.ts';

const WINDOW_MS = (): number => (Number(process.env.HARBOR_WB_LOGIN_WINDOW_MS) > 0 ? Number(process.env.HARBOR_WB_LOGIN_WINDOW_MS) : 5 * 60_000);
const num = (name: string, dflt: number): number => (Number(process.env[name]) > 0 ? Number(process.env[name]) : dflt);
export const limits = (): { client: number; account: number; global: number } => ({
  client: num('HARBOR_WB_LOGIN_MAX_CLIENT', 10),
  account: num('HARBOR_WB_LOGIN_MAX_ACCOUNT', 20),
  global: num('HARBOR_WB_LOGIN_MAX_GLOBAL', 60),
});

interface Bucket { n: number; until: number }
const buckets = new Map<string, Bucket>();
const MAX_KEYS = 5000; // a flood of made-up names must not grow this without bound

export function _reset(): void {
  buckets.clear();
}

function live(key: string, now: number): Bucket | null {
  const b = buckets.get(key);
  if (!b) return null;
  if (now >= b.until) {
    buckets.delete(key);
    return null;
  }
  return b;
}

function bump(key: string, now: number): void {
  const b = live(key, now);
  if (b) {
    b.n += 1;
    return;
  }
  if (buckets.size >= MAX_KEYS) {
    for (const [k, v] of buckets) if (now >= v.until) buckets.delete(k);
    if (buckets.size >= MAX_KEYS) return; // full of live entries: the global bucket still counts
  }
  buckets.set(key, { n: 1, until: now + WINDOW_MS() });
}

/** The client key: the node key when the request proves one, else the socket address. */
export function clientKey(req: IncomingMessage): string {
  const seen = evidenceFor(req);
  if (seen.key) return `node:${seen.key}`;
  return `addr:${(req.socket.remoteAddress ?? '').replace('::ffff:', '') || 'unknown'}`;
}

const acct = (name: string): string => `acct:${name.trim().toLowerCase().slice(0, 64)}`;

export type Blocked = 'client' | 'account' | 'global' | null;

/** Is this attempt refused before the password is even looked at? `username` is optional (a passkey sign-in names nobody yet). */
export function blocked(req: IncomingMessage, username: string | null, now = Date.now()): Blocked {
  const l = limits();
  if ((live('global', now)?.n ?? 0) >= l.global) return 'global';
  if ((live(clientKey(req), now)?.n ?? 0) >= l.client) return 'client';
  if (username && (live(acct(username), now)?.n ?? 0) >= l.account) return 'account';
  return null;
}

export function recordFailure(req: IncomingMessage, username: string | null, now = Date.now()): void {
  bump('global', now);
  bump(clientKey(req), now);
  if (username) bump(acct(username), now);
}

/** A successful sign-in clears THIS client's and THIS account's counters (the global one only ages out). */
export function recordSuccess(req: IncomingMessage, username: string | null): void {
  buckets.delete(clientKey(req));
  if (username) buckets.delete(acct(username));
}
