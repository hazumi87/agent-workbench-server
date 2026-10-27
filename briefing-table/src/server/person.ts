/* WHO COUNTS AS A PERSON for person-only routes (seat restart, requireHuman paths, settings PATCH, ...).
 *
 * The legacy `wb_auth` cookie is sha256("wb-cookie:" + the shared bearer): anyone who can read the bearer (every agent on the box can: secrets/engine.token) can compute it. So where
 * identity exists (modes `both` and `strict`) it is NOT a person; a person is an identity SESSION or DEVICE principal. Where identity is off (mode `legacy`, local mode) the shared
 * credential is the only one there is, and local mode's token is per launch, never on disk and scrubbed from pane env, so the legacy cookie keeps counting there.
 * An Authorization header is never a person (agents hold the bearer; assemble-room F18). */
import type { IncomingMessage } from 'node:http';
import * as auth from './auth.ts';
import * as identity from '../identity/auth.ts';

export function humanCredential(req: IncomingMessage, principal: identity.Principal | null): boolean {
  if (req.headers.authorization) {
    return false;
  }
  if (principal) {
    return principal.via === 'session' || principal.via === 'device';
  }
  if (identity.enabled()) {
    return false; // a legacy cookie with no identity behind it is forgeable from the bearer
  }
  return auth.authorized(req);
}
