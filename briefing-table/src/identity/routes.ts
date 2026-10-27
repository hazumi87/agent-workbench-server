/**
 * The HTTP surface of user identity (E13). Everything here is inert unless
 * `HARBOR_WB_IDENTITY` is `both` or `strict` — see ./auth.ts for the switch.
 *
 * It is a separate file from `src/server/index.ts` for one reason worth stating:
 * contract §0 wants ONE identity honoured by several surfaces, so the whole of
 * `src/identity/` has to be liftable into a service without unpicking it from a
 * 2800-line request handler. index.ts calls exactly two functions from here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as identity from './auth.ts';
import * as passkeys from './passkey.ts';
import * as realmRoutes from './realm-routes.ts';
import * as store from './store.ts';
import { POLICY_SUMMARY } from './password-policy.ts';
import { evidenceFor } from './tailnet-evidence.ts';
import * as handback from './handback.ts';
import * as loginThrottle from './login-throttle.ts';

export interface Deps {
  readBody(req: IncomingMessage): Promise<any>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  log(...args: unknown[]): void;
  /** The shared-secret login, so `both` mode can still accept a bare token
   *  through the same form. Returns a Set-Cookie or null. */
  legacyLoginCookie(submitted: string, secure: boolean): string | null;
  /** `src/server/auth.ts`'s `authorized(req)` — the shared-bearer/cookie yes-no
   *  check, with no user attached. `/identity/introspect` falls back to it in
   *  `legacy`/`both` mode, same as `identity.allowed()` does, so the fabric
   *  works on a host that has not switched identity on yet. */
  legacyAuthorized(req: IncomingMessage): boolean;
  throttled(ip: string): boolean;
  recordFailure(ip: string): void;
  clearFailures(ip: string): void;
  safeNext(next: string | null | undefined): string;
  webRoot: string;
  /** Exact Origins POST /auth/realm/exchange accepts (R6a) — the W3b list. */
  exchangeOrigins(): string[];
}

function realmDeps(deps: Deps): realmRoutes.RealmDeps {
  return {
    sendJson: deps.sendJson,
    readBody: deps.readBody,
    log: (msg) => deps.log(msg),
    safeNext: deps.safeNext,
    labelFor,
    exchangeOrigins: deps.exchangeOrigins,
  };
}

export const enabled = identity.enabled;

/**
 * Paths that answer NORMALLY while `must_change_password` is set.
 *
 * Everything else 403s with `{mustChangePassword:true}` — that is the forced
 * change gate, and it is what makes a short temp code safe: the credential
 * cannot be LIVED WITH, only exchanged. The list is deliberately tiny and
 * includes the page itself, because a gate that blocks the form it redirects
 * you to is a locked door with the key inside.
 */
const CHANGE_ALLOWED = new Set([
  '/login',
  '/logout',
  '/account',
  '/account/password',
  '/account.html',
]);

export function changeAllowed(pathname: string): boolean {
  return CHANGE_ALLOWED.has(pathname);
}

/**
 * Reject a cross-site POST. `SameSite=Lax` already stops the cookie travelling
 * on a genuine cross-site POST, so this is the second layer, not the only one.
 *
 * HOSTNAME ONLY, never host — kiosk's first version compared ports and
 * refused real sign-ins, because a browser omits :443 from Host while a proxy
 * may still present a ported Origin. The port never carried security here:
 * cross-site means a different HOSTNAME.
 */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true; // non-browser client; auth still applies
  }
  const host = req.headers.host;
  if (!host) {
    return false;
  }
  try {
    const from = new URL(origin).hostname.toLowerCase();
    const here = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return from === here;
  } catch {
    return false; // includes the literal "null" opaque origin — we embed nowhere
  }
}

function wantsJson(req: IncomingMessage): boolean {
  return String(req.headers['content-type'] ?? '').includes('application/json');
}

/** A form POST and a fetch POST are both legitimate here: the login page is a
 *  plain form (so it works with no JS), the account page uses fetch. */
async function body(req: IncomingMessage, deps: Deps): Promise<Record<string, unknown>> {
  if (wantsJson(req)) {
    return (await deps.readBody(req)) as Record<string, unknown>;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) {
      break; // a login form is short; anything bigger is not one
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/** How a session/device is labelled in the account list. Prefers the tailnet
 *  peer's own label (e.g. "GPU-HOST · windows" — see tailnet-evidence.ts),
 *  which is available whenever `evidenceFor` resolved something, including
 *  behind Serve with `HARBOR_WB_BEHIND_SERVE=1`. The user-agent family is only
 *  a FALLBACK for when neither source resolved anything — a browser can only
 *  describe itself ("Windows browser"), which is useless once two machines
 *  run the same OS. */
function labelFor(req: IncomingMessage): string {
  const seen = evidenceFor(req);
  if (seen.label) {
    return seen.label;
  }
  const ua = String(req.headers['user-agent'] ?? '');
  let os = 'Unknown device';
  if (/Windows/i.test(ua)) {
    os = 'Windows';
  } else if (/iPhone|iPad|iOS/i.test(ua)) {
    os = 'iPhone';
  } else if (/Android/i.test(ua)) {
    os = 'Android';
  } else if (/Mac OS X/i.test(ua)) {
    os = 'Mac';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
  }
  const peer = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
  const node = peer && peer !== '127.0.0.1' && peer !== '::1' ? peer : null;
  return node ? `${os} · ${node}` : os;
}

/** One line describing WHO called, for the log — falls back to the bare peer
 *  address (today's exact format) only when NO evidence resolved at all, so a
 *  request with no Serve identity behind it reads exactly as it always has.
 *
 * `kind !== 'none'` and `label === null` are DIFFERENT things and must not
 * collapse to the same line: the first is "we resolved an address but not a
 * friendly name for it" (e.g. a tailnet peer this engine's table doesn't
 * know), and still deserves the address and the evidence kind in the log —
 * silently falling back to the bare peer here would print "127.0.0.1" for a
 * real forwarded address just because it had no hostname, which defeats the
 * entire point of asking. */
function describeCaller(req: IncomingMessage, peer: string): string {
  const seen = evidenceFor(req);
  if (seen.kind === 'none') {
    return peer;
  }
  const addr = seen.ip ?? peer;
  const bits: string[] = [seen.kind];
  if (seen.userLogin) {
    bits.push(`user ${seen.userLogin}`);
  }
  return seen.label ? `${seen.label} (${addr}, ${bits.join(', ')})` : `${addr} (${bits.join(', ')})`;
}

/**
 * Handle an identity route. Returns true if the request was consumed.
 *
 * The principal is resolved by index.ts once per request and passed in, so
 * there is exactly one resolution per request and the gate and the routes can
 * never disagree about who is calling.
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  peer: string,
  principal: identity.Principal | null,
  deps: Deps,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  /* `/identity/introspect` answers in EVERY mode, including `legacy` — it is
   * the one route ahead of the `enabled()` gate below. The message-fabric
   * service (a separate Node process on the server, per the homelab contract §0)
   * calls this to validate a caller's bearer without ever opening
   * identity.db itself; that has to work on a host that has not switched
   * identity on yet, same as the fabric's own auth already tolerates the
   * shared bearer during the transition (contract §2). */
  if (pathname === '/identity/introspect' && method === 'GET') {
    return introspect(req, res, principal, deps);
  }

  /* ADD A SERVER: `/api/node` answers in EVERY mode (a client probes before it knows what the server runs); the hand-back routes only when identity is on. They sit
   * ahead of the page routes because /handback/start must reach /login and back, and exchange / revoke / node are the named unauthenticated exceptions. */
  if (await handback.handle(req, res, pathname, principal, deps)) {
    return true;
  }

  if (!identity.enabled()) {
    return false;
  }
  const secure = identity.isSecureRequest(req);

  /* R6a realm sign-in: /auth/realm/start, /callback, /exchange. 404 unless
   * HARBOR_WB_REALM_ISSUER is set. Unauthenticated by definition, like the
   * passkey sign-in; what they mint is an ordinary engine session. */
  if (pathname.startsWith('/auth/realm/')) {
    return realmRoutes.handleAuth(req, res, pathname, principal, realmDeps(deps));
  }

  if (pathname === '/login' && method === 'GET') {
    const page = await readFile(join(deps.webRoot, 'login.html'), 'utf8').catch(() => null);
    if (!page) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('login page missing');
      return true;
    }
    /* ONE substitution, and the placeholder is the fallback: the shipped file
     * literally contains `__IDENTITY_MODE__`, which the page reads as "not
     * identity" — so in legacy mode index.ts serves the file untouched and the
     * page is exactly today's token form. No second endpoint, no mode probe,
     * nothing for an unauthenticated caller to ask. */
    const html = page
      .replace('__IDENTITY_MODE__', identity.mode())
      .replace('__POLICY_SUMMARY__', POLICY_SUMMARY)
      .replace('__REALM_SIGNIN__', realmRoutes.signInOffered() ? 'on' : 'off');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(html);
    return true;
  }

  if (pathname === '/login' && method === 'POST') {
    if (!originOk(req)) {
      deps.sendJson(res, 403, { error: 'cross-site request refused' });
      return true;
    }
    /* The shared-token form (no username) keeps the old per-address throttle; the account form uses the node-key / account / global throttle (login-throttle.ts). */
    if (loginThrottle.blocked(req, null)) {
      return loginFailed(req, res, deps, {}, 'Too many attempts. Wait a few minutes.', 'slow');
    }
    const form = await body(req, deps);
    const username = String(form.username ?? '').trim();
    if (username && loginThrottle.blocked(req, username)) {
      deps.log(`login THROTTLED (${loginThrottle.blocked(req, username)}) for ${username} from ${describeCaller(req, peer)}`);
      return loginFailed(req, res, deps, form, 'Too many attempts. Wait a few minutes.', 'slow');
    }

    if (!username) {
      /* No username: this is the SHARED-TOKEN form. Accepted in `both` (the
       * transition state) and refused in `strict`. Handled here rather than
       * falling through because the body has already been consumed. */
      if (identity.mode() !== 'both') {
        return loginFailed(req, res, deps, form, 'Sign in with your username and password.', 'bad');
      }
      if (deps.throttled(peer)) {
        return loginFailed(req, res, deps, form, 'Too many attempts. Wait a few minutes.', 'slow');
      }
      const cookie = deps.legacyLoginCookie(String(form.token ?? ''), secure);
      if (!cookie) {
        deps.recordFailure(peer);
        deps.log(`login FAILED (legacy token) from ${describeCaller(req, peer)}`);
        return loginFailed(req, res, deps, form, 'That token was not accepted.', 'bad');
      }
      deps.clearFailures(peer);
      deps.log(`login ok (legacy token) from ${describeCaller(req, peer)}`);
      return loginOk(req, res, [cookie], deps.safeNext(typeof form.next === 'string' ? form.next : null));
    }

    const result = await identity.login(username, String(form.password ?? ''), {
      label: labelFor(req),
      /* Four spellings of yes, because two different clients post here: a
       * plain HTML checkbox sends the string `on` (and sends NOTHING when
       * unticked), while a JSON caller sends a boolean. Comparing only against
       * strings silently dropped every JSON `true` — the flag parsed as false
       * and the device was never remembered, with no error anywhere. */
      remember:
        form.remember === true ||
        form.remember === 'on' ||
        form.remember === 'true' ||
        form.remember === '1',
      req,
    });
    if (!result.ok || !result.principal || !result.sessionToken) {
      loginThrottle.recordFailure(req, username);
      deps.log(`login FAILED for ${username} from ${describeCaller(req, peer)}`);
      return loginFailed(req, res, deps, form, 'That username or password was not accepted.', 'bad');
    }
    loginThrottle.recordSuccess(req, username);
    deps.log(
      `login ok ${username} from ${describeCaller(req, peer)}${result.deviceToken ? ' (device remembered)' : ''}`,
    );
    const cookies = [identity.sessionCookie(result.sessionToken, secure)];
    if (result.deviceToken) {
      cookies.push(identity.deviceCookie(result.deviceToken, secure));
    }
    /* A forced change beats the caller's destination. Anything else would land
     * them on a page that 403s, which reads as a broken login. */
    const next = result.principal.mustChangePassword
      ? '/account.html?change=1'
      : deps.safeNext(typeof form.next === 'string' ? form.next : null);
    return loginOk(req, res, cookies, next, result.principal);
  }

  /* --- passkey sign-in (E15) ---------------------------------------------
   * Unauthenticated by definition: this IS the act of authenticating. Both
   * routes sit above the `/account` block for that reason, and both go
   * through the same origin check and the same failure throttle as the
   * password form — a passkey is phishing-resistant, not rate-limit-proof. */

  if (pathname === '/login/passkey/options' && method === 'POST') {
    if (!originOk(req)) {
      deps.sendJson(res, 403, { error: 'cross-site request refused' });
      return true;
    }
    /* A remembered device narrows the prompt to the passkeys enrolled ON IT,
     * which is what makes the reboot case one Hello prompt instead of an
     * account chooser. Nothing is leaked by it: holding a live device cookie
     * already authenticates you outright, so the credential ids it returns
     * are not a secret from this caller. */
    const jar = identity.cookiesOf(req);
    const deviceToken = jar[identity.DEVICE_COOKIE];
    let allow: store.PasskeyRow[] = [];
    if (deviceToken) {
      const device = store.deviceByToken(deviceToken);
      if (device && device.revoked_at === null) {
        allow = store.passkeysForDevice(device.id);
      }
    }
    const options = await passkeys.authenticationOptions(req, allow);
    if (!options.ok) {
      deps.sendJson(res, 400, { error: options.reason });
      return true;
    }
    deps.sendJson(res, 200, { ticket: options.ticket, options: options.options });
    return true;
  }

  if (pathname === '/login/passkey' && method === 'POST') {
    if (!originOk(req)) {
      deps.sendJson(res, 403, { error: 'cross-site request refused' });
      return true;
    }
    if (loginThrottle.blocked(req, null)) {
      deps.sendJson(res, 401, { error: 'Too many attempts. Wait a few minutes.' });
      return true;
    }
    const form = await body(req, deps);
    const asserted = await passkeys.assert(form.ticket, form.response);
    if (!asserted.ok) {
      loginThrottle.recordFailure(req, null);
      deps.log(`login FAILED (passkey) from ${describeCaller(req, peer)}`);
      deps.sendJson(res, 401, { error: asserted.reason });
      return true;
    }
    /* A PASSKEY SIGN-IN IS A FULL PASSWORD-PROOF EQUIVALENT (contract §0), so
     * it mints the same session and may mint a remembered device on the same
     * terms. Anything weaker would make the stronger credential the one that
     * buys you less, which is how a security feature ends up unused. */
    const result = identity.loginWithPasskey(asserted.account, {
      label: labelFor(req),
      remember:
        form.remember === true ||
        form.remember === 'on' ||
        form.remember === 'true' ||
        form.remember === '1',
      req,
    });
    if (!result.ok || !result.principal || !result.sessionToken) {
      loginThrottle.recordFailure(req, null);
      deps.log(`login FAILED (passkey, account refused) for ${asserted.account.username}`);
      deps.sendJson(res, 401, { error: 'That passkey was not accepted.' });
      return true;
    }
    loginThrottle.recordSuccess(req, asserted.account.username);
    deps.log(
      `login ok ${asserted.account.username} via passkey from ${describeCaller(req, peer)}` +
        `${result.deviceToken ? ' (device remembered)' : ''}`,
    );
    const cookies = [identity.sessionCookie(result.sessionToken, secure)];
    if (result.deviceToken) {
      cookies.push(identity.deviceCookie(result.deviceToken, secure));
    }
    /* Same precedence as the password path: a forced change beats the caller's
     * destination. A passkey does not exempt anyone from it — the flag is
     * about the PASSWORD, which is still the fallback credential. */
    const next = result.principal.mustChangePassword
      ? '/account.html?change=1'
      : deps.safeNext(typeof form.next === 'string' ? form.next : null);
    return loginOk(req, res, cookies, next, result.principal);
  }

  if (pathname === '/logout' && method === 'POST') {
    if (!originOk(req)) {
      deps.sendJson(res, 403, { error: 'cross-site request refused' });
      return true;
    }
    if (principal?.sessionId) {
      store.revokeSession(principal.sessionId);
    }
    /* The DEVICE cookie is cleared but the row is NOT revoked: "sign out" and
     * "forget this device" are different intentions, and destroying the trust
     * record on a routine logout would make "remember me" useless. Forgetting
     * is an explicit button on the account page. */
    const cookies = [
      identity.clearCookie(identity.SESSION_COOKIE, secure),
      identity.clearCookie(identity.DEVICE_COOKIE, secure),
    ];
    if (wantsJson(req)) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    res.writeHead(303, { location: '/login', 'set-cookie': cookies });
    res.end();
    return true;
  }

  /* --- everything below needs a principal --- */
  if (pathname === '/account' || pathname.startsWith('/account/')) {
    if (!principal) {
      deps.sendJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    /* THE FORCED-CHANGE GATE, applied HERE as well as in index.ts.
     *
     * index.ts checks it AFTER this handler has already answered, so an
     * `/account/*` route has never been subject to it — which meant a
     * temporary code could mint a permanent api_token, exactly the thing
     * "short is only safe because it cannot be lived with" forbids. Found
     * while wiring enrolment (2026-09-15); a passkey enrolled with a temp
     * code would have been the same hole with a longer life. The allow-list
     * is the same one, so `/account` and `/account/password` — the way out —
     * answer exactly as they always have. */
    if (principal.mustChangePassword && !changeAllowed(pathname)) {
      deps.sendJson(res, 403, { mustChangePassword: true, error: 'set a password first' });
      return true;
    }

    if (pathname === '/account' && method === 'GET') {
      deps.sendJson(res, 200, {
        username: principal.username,
        isAdmin: principal.isAdmin,
        mustChangePassword: principal.mustChangePassword,
        via: principal.via,
        evidence: principal.evidence,
        policy: POLICY_SUMMARY,
        devices: store.listDevices(principal.userId).map(publicDevice),
        tokens: store.listApiTokens(principal.userId).map(publicToken),
        passkeys: store.listPasskeys(principal.userId).map(publicPasskey),
        realm: realmRoutes.accountView(principal.userId),
      });
      return true;
    }

    if (!originOk(req)) {
      deps.sendJson(res, 403, { error: 'cross-site request refused' });
      return true;
    }

    /* R6a: link / unlink this account's realm identity. After the principal
     * check, the forced-change gate and the origin check above. */
    if (await realmRoutes.handleAccount(req, res, pathname, principal, realmDeps(deps))) {
      return true;
    }

    if (pathname === '/account/password' && method === 'POST') {
      const form = await body(req, deps);
      const result = await identity.changePassword(
        principal,
        String(form.current ?? ''),
        String(form.next ?? ''),
        labelFor(req),
      );
      if (!result.ok || !result.sessionToken) {
        deps.sendJson(res, 400, { error: result.reason ?? 'Password not changed.' });
        return true;
      }
      deps.log(`password changed for ${principal.username}; other sessions revoked`);
      res.writeHead(200, {
        'content-type': 'application/json',
        // Re-issued in the SAME response: the epoch just killed every session
        // including the one that asked, so without this the user is logged out
        // by their own successful password change.
        'set-cookie': identity.sessionCookie(result.sessionToken, secure),
      });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    const deviceRevoke = /^\/account\/device\/([^/]+)\/revoke$/.exec(pathname);
    if (deviceRevoke && method === 'POST') {
      const ok = store.revokeDevice(decodeURIComponent(deviceRevoke[1]), principal.userId);
      deps.log(`device revoke ${ok ? 'ok' : 'MISS'} for ${principal.username}`);
      deps.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no such device' });
      return true;
    }

    if (pathname === '/account/token' && method === 'POST') {
      const form = await body(req, deps);
      const token = store.mintToken();
      const row = store.createApiToken(principal.userId, token, String(form.label ?? '').trim() || null);
      deps.log(`api token minted for ${principal.username} (${row.label ?? 'unlabelled'})`);
      // Shown ONCE. Only the hash is stored, so there is no path that can ever
      // show it again — which is the property that makes a leak recoverable.
      deps.sendJson(res, 200, { ...publicToken(row), token });
      return true;
    }

    const tokenRevoke = /^\/account\/token\/([^/]+)\/revoke$/.exec(pathname);
    if (tokenRevoke && method === 'POST') {
      const ok = store.revokeApiToken(decodeURIComponent(tokenRevoke[1]), principal.userId);
      deps.log(`api token revoke ${ok ? 'ok' : 'MISS'} for ${principal.username}`);
      deps.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no such token' });
      return true;
    }

    /* --- passkey enrolment (E15) ---------------------------------------
     * A PASSWORD-BACKED SIGN-IN IS THE PREREQUISITE and the gate above is
     * half of why: you cannot enrol a passkey while a temporary code stands.
     * The other half is that `principal` may be a device cookie or a bearer
     * here, which is weaker than a password proof — acceptable because
     * enrolment still requires the AUTHENTICATOR's own user verification
     * (PIN/biometric) on the machine doing it, so an unattended laptop cannot
     * silently grow a credential. */

    if (pathname === '/account/passkey/options' && method === 'POST') {
      const account = store.accountById(principal.userId);
      if (!account) {
        deps.sendJson(res, 404, { error: 'no such account' });
        return true;
      }
      const options = await passkeys.registrationOptions(req, account);
      if (!options.ok) {
        deps.sendJson(res, 400, { error: options.reason });
        return true;
      }
      deps.sendJson(res, 200, { ticket: options.ticket, options: options.options });
      return true;
    }

    if (pathname === '/account/passkey/register' && method === 'POST') {
      const account = store.accountById(principal.userId);
      if (!account) {
        deps.sendJson(res, 404, { error: 'no such account' });
        return true;
      }
      const form = await body(req, deps);
      const registered = await passkeys.register(account, form.ticket, form.response, {
        deviceId: deviceIdFor(req, principal.userId),
        label: String(form.label ?? '').trim() || labelFor(req),
      });
      if (!registered.ok) {
        deps.log(`passkey enrolment REFUSED for ${principal.username}: ${registered.reason}`);
        deps.sendJson(res, 400, { error: registered.reason });
        return true;
      }
      deps.log(
        `passkey enrolled for ${principal.username} (${registered.passkey.label ?? 'unlabelled'})` +
          ` from ${describeCaller(req, peer)}`,
      );
      deps.sendJson(res, 200, publicPasskey(registered.passkey));
      return true;
    }

    const passkeyRevoke = /^\/account\/passkey\/([^/]+)\/revoke$/.exec(pathname);
    if (passkeyRevoke && method === 'POST') {
      const ok = store.revokePasskey(decodeURIComponent(passkeyRevoke[1]), principal.userId);
      deps.log(`passkey revoke ${ok ? 'ok' : 'MISS'} for ${principal.username}`);
      deps.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no such passkey' });
      return true;
    }

    deps.sendJson(res, 404, { error: 'no such account route' });
    return true;
  }

  return false;
}

/**
 * `GET /identity/introspect` — token introspection for the message-fabric
 * (platform, Node, server :8204 per the homelab contract). It answers WHO the
 * request's OWN credential belongs to; it takes no other credential and
 * offers no lookup by a token the caller supplies, so a fabric process never
 * has to hold anything stronger than the bearer it was itself handed.
 *
 * Never logs or echoes the token/bearer/cookie value — only the resolved
 * username and `via`, same discipline as every other log line in this file.
 */
async function introspect(
  req: IncomingMessage,
  res: ServerResponse,
  principal: identity.Principal | null,
  deps: Deps,
): Promise<true> {
  const mode = identity.mode();

  if (principal) {
    /* SAME HOLE THE 2026-09-15 GATE CLOSED, applied here explicitly: a
     * principal under a forced password change is a temporary code, and
     * introspect vouching for it would let the fabric treat a code that
     * "cannot be lived with" as a settled identity. Checked before the 200,
     * not folded into `allowed()` — this route has no `changeAllowed` page to
     * exempt, it only ever answers about the caller itself. */
    if (principal.mustChangePassword) {
      deps.log(`introspect: 403 user=${principal.username}`);
      deps.sendJson(res, 403, { ok: false, error: 'password-change-required' });
      return true;
    }
    deps.log(`introspect: ok user=${principal.username} kind=${principal.via}`);
    deps.sendJson(res, 200, {
      ok: true,
      principal: {
        user: principal.username,
        kind: principal.via,
        since: principal.credentialCreatedAt !== null ? new Date(principal.credentialCreatedAt).toISOString() : null,
        /* Which projects this principal may speak (and later check in) as —
         * the fabric's sender binding.
         * A human may drive any project, so "*" until tokens carry a scope. */
        projects: ['*'],
      },
      mode,
    });
    return true;
  }

  /* No identity principal — either identity is off (`legacy`), or it is on
   * but this caller presented no api_token/session/device of its own. Either
   * way, fall back to the shared bearer exactly as `identity.allowed()` does
   * for every other route: accepted in `legacy`/`both`, dead in `strict`. A
   * shared secret names no user, so it introspects as a fixed pseudo-account
   * rather than 200-ing with nothing in `principal` — a caller should never
   * have to special-case "ok but empty". */
  if (mode !== 'strict' && deps.legacyAuthorized(req)) {
    deps.log('introspect: ok user=legacy kind=shared-bearer');
    deps.sendJson(res, 200, {
      ok: true,
      principal: { user: 'legacy', kind: 'shared-bearer', since: null, projects: ['*'] },
      mode,
    });
    return true;
  }

  deps.log('introspect: 401');
  deps.sendJson(res, 401, { ok: false, error: 'unauthenticated' });
  return true;
}

function publicDevice(d: store.DeviceRow) {
  return {
    id: d.id,
    label: d.label,
    tailnetNode: d.tailnet_node,
    tailnetIp: d.tailnet_ip,
    lastEvidence: d.last_evidence,
    createdAt: d.created_at,
    lastUsedAt: d.last_used_at,
    revokedAt: d.revoked_at,
  };
}

/** The remembered-device row this browser is carrying, when it is one of THIS
 *  user's and still live. Provenance only — a passkey enrolled from a device
 *  outlives that device's revocation on purpose (contract §0: they are
 *  separate credentials), so this can never refuse an enrolment, only fail to
 *  annotate it. */
function deviceIdFor(req: IncomingMessage, userId: string): string | null {
  const token = identity.cookiesOf(req)[identity.DEVICE_COOKIE];
  if (!token) {
    return null;
  }
  const row = store.deviceByToken(token);
  if (!row || row.revoked_at !== null || row.user_id !== userId) {
    return null;
  }
  return row.id;
}

/** The credential id is NOT published. It is not a secret — the browser holds
 *  it — but it is the lookup key for the sign-in route, and an account page
 *  has no use for it. `id` (our own row id) is what revoke takes. */
function publicPasskey(p: store.PasskeyRow) {
  return {
    id: p.id,
    label: p.label,
    deviceId: p.device_id,
    transports: passkeys.parseTransports(p.transports),
    aaguid: p.aaguid,
    createdAt: p.created_at,
    lastUsedAt: p.last_used_at,
    revokedAt: p.revoked_at,
  };
}

function publicToken(t: store.TokenRow) {
  return {
    id: t.id,
    label: t.label,
    createdAt: t.created_at,
    lastUsedAt: t.last_used_at,
    revokedAt: t.revoked_at,
  };
}

function loginOk(
  req: IncomingMessage,
  res: ServerResponse,
  cookies: string[],
  next: string,
  principal?: identity.Principal,
): true {
  if (wantsJson(req)) {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies });
    res.end(
      JSON.stringify({
        ok: true,
        next,
        mustChangePassword: principal?.mustChangePassword ?? false,
      }),
    );
    return true;
  }
  res.writeHead(303, { location: next, 'set-cookie': cookies });
  res.end();
  return true;
}

/** Same silence for every failure mode — wrong password, unknown user, expired
 *  temp code, disabled account. Distinguishing them tells a caller which
 *  accounts exist and which have an outstanding code. */
function loginFailed(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps,
  form: Record<string, unknown>,
  message: string,
  flag: 'bad' | 'slow',
): true {
  if (wantsJson(req)) {
    deps.sendJson(res, 401, { error: message });
    return true;
  }
  const keep = deps.safeNext(typeof form.next === 'string' ? form.next : null);
  const q = keep === '/' ? `/login?${flag}` : `/login?${flag}&next=${encodeURIComponent(keep)}`;
  res.writeHead(303, { location: q });
  res.end();
  return true;
}
