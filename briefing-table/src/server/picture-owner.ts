/* ============================================================================
 * WHOSE picture a room window is asking about (GET/PATCH /api/rooms/me).
 * Split out of rooms.ts so the identity mapping has a test of its own
 * (vrpc1, 2026-09-28): it decides which account a window writes to.
 * ========================================================================== */

import type { Principal } from '../identity/auth.ts';
import * as identityAuth from '../identity/auth.ts';
import { listAccounts, listApiTokens } from '../identity/store.ts';

/* WHOSE picture (the design system FIX-1, 2026-09-27: the fallback read "Y" from the
   word "you"). An identity principal is the person. A window the engine
   opened carries the LEGACY cookie, which names nobody; with identity on and
   exactly ONE active admin account, that account is the person, so the
   picture and the initial follow him whichever way he signed in. Otherwise
   the shared-token user, with no name (the page draws a person icon). */
export function pictureOwner(principal: Principal | null): { key: string; name: string | null } {
  if (principal) {
    return { key: principal.userId, name: principal.username };
  }
  if (identityAuth.enabled()) {
    try {
      const admins = listAccounts().filter((a) => a.is_admin && !a.disabled_at);
      if (admins.length === 1) {
        return { key: admins[0].id, name: admins[0].username };
      }
    } catch {
      /* identity db unreadable: fall through to the shared-token user */
    }
  }
  return { key: 'user', name: null };
}

/** A person key back to {key, name} [scratch seen]: the account's username when
 *  identity is on and the key is an account id; the shared-token user otherwise. */
export function personOf(key: string): { key: string; name: string | null } {
  if (key !== 'user' && identityAuth.enabled()) {
    try {
      const a = listAccounts().find((x) => x.id === key);
      if (a) {
        return { key, name: a.username };
      }
    } catch {
      /* identity db unreadable: no name */
    }
  }
  return key === 'user' ? pictureOwner(null) : { key, name: null };
}

/* WHOSE voice globals (room-voice v3.6) a connection follows when no request
   names a person, and whom the one-time migration seeds: the account that
   owns the voice-svc api token, else the only active account, else the
   key GET /api/rooms/me answers for a window with no principal. */
export function voiceOwnerKey(): string {
  if (identityAuth.enabled()) {
    try {
      const active = listAccounts().filter((a) => !a.disabled_at);
      const name = identityAuth.voiceTokenName();
      const owner = active.find((a) => listApiTokens(a.id).some((t) => t.label === name && !t.revoked_at));
      if (owner || active.length === 1) {
        return (owner ?? active[0]).id;
      }
    } catch {
      /* identity db unreadable: as /api/rooms/me */
    }
  }
  return pictureOwner(null).key;
}
