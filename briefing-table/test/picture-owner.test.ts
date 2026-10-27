/* pictureOwner (src/server/picture-owner.ts): which account a room window's
 * picture belongs to. vrpc1 2026-09-28: sole active admin -> resolves; two
 * admins or none -> does not; a principal -> itself; legacy mode -> the
 * shared-token user. A temp identity db is set before any import.
 * voiceOwnerKey (room-voice v3.6): the voice-svc token's account, else
 * the only active account, else pictureOwner(null). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-picture-owner-'));
process.env.HARBOR_WB_IDENTITY_DB = join(dir, 'identity.db');
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
const { pictureOwner, voiceOwnerKey } = await import('../src/server/picture-owner.ts');
const store = await import('../src/identity/store.ts');

let pass = 0;
let fail = 0;
function eq(a: unknown, b: unknown, msg: string): void {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok' : 'FAIL'}  ${msg}${ok ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);
}
const USER = { key: 'user', name: null };
const acct = (username: string, isAdmin: boolean) =>
  store.createAccount({ username, passwordHash: 'x', mustChange: false, passwordExpiresAt: null, isAdmin });

try {
  process.env.HARBOR_WB_IDENTITY = 'legacy';
  eq(pictureOwner(null), USER, 'legacy mode: the shared-token user, no name');
  eq(voiceOwnerKey(), 'user', 'voiceOwnerKey, legacy mode: the shared-token user');
  process.env.HARBOR_WB_IDENTITY = 'both';
  eq(pictureOwner(null), USER, 'identity on, no accounts: does not resolve');
  acct('guest', false);
  eq(pictureOwner(null), USER, 'identity on, only a non-admin: does not resolve');
  eq(voiceOwnerKey(), store.listAccounts()[0].id, 'voiceOwnerKey: the ONLY active account (admin or not)');
  const owner = acct('owner', true);
  eq(pictureOwner(null), { key: owner.id, name: 'owner' }, 'identity on, ONE active admin: the legacy window is that account');
  process.env.HARBOR_WB_IDENTITY = 'strict';
  eq(pictureOwner(null), { key: owner.id, name: 'owner' }, '...strict mode too');
  process.env.HARBOR_WB_IDENTITY = 'both';
  const p = { userId: 'u-42', username: 'someone' } as never;
  eq(pictureOwner(p), { key: 'u-42', name: 'someone' }, 'a signed-in principal is always itself');
  acct('admin2', true);
  eq(pictureOwner(null), USER, 'TWO admins: does not resolve (never guesses between people)');
  eq(voiceOwnerKey(), 'user', 'voiceOwnerKey, three accounts and no voice token: as /api/rooms/me (the shared-token user)');
  const guest = store.listAccounts().find((x) => x.username === 'guest')!;
  store.createApiToken(guest.id, store.mintToken(), 'voice-svc');
  eq(voiceOwnerKey(), guest.id, "voiceOwnerKey: the voice-svc token's account wins");
  store.revokeApiToken(store.listApiTokens(guest.id)[0].id, guest.id);
  eq(voiceOwnerKey(), 'user', '...a revoked token does not count');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM) */ }
}
console.log(`\nPASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
