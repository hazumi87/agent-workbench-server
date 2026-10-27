/**
 * Identity store (E13) — the ONLY module that opens `data/identity.db`.
 *
 * Same convention as `src/table/store.ts` (Seam C2): sole file-opener, WAL,
 * idempotent migrations, location behind one env var. It is a SEPARATE FILE
 * from the mapping table on purpose and the reason is not tidiness:
 *   · the mapping table is disposable — a corrupted `mapping.db` costs you the
 *     pane list, and the 2026-06-09 reconcile already treats its rows as
 *     untrustworthy after a crash. Credentials are not disposable.
 *   · the two move at different speeds and, per the migration plan, may not end
 *     up on the same HOST: contract §0 wants one identity honoured by several
 *     surfaces, so this file is the thing a future identity SERVICE lifts out
 *     whole. Entangling it with sessions/recipes would make that a rewrite.
 *
 * WHAT IS HASHED WITH WHAT, and do not "make it consistent":
 *   · passwords  → argon2id (see ./auth.ts). Low entropy, must be expensive.
 *   · every other token here → plain SHA-256. A 256-bit CSPRNG token has
 *     nothing to guess, so a slow KDF buys no security and would add ~100ms to
 *     EVERY authenticated request. (Kiosk's auth.ts carries the same warning
 *     for the same reason.)
 */
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { instancePath } from '../engine/data-dir.ts';

const DB_PATH = process.env.HARBOR_WB_IDENTITY_DB ?? instancePath('data', 'identity.db');

/** 30 days (contract §0). Long enough that a laptop abroad is not re-typing a
 *  password weekly, short enough that an abandoned browser lapses. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 180 days. A remembered DEVICE is meant to outlive sessions — that is the
 *  whole affordance ("do not ask me on this laptop again"). It is revocable
 *  from the account page, which is what keeps the long life honest. */
export const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export interface Account {
  id: string;
  username: string;
  password_hash: string;
  must_change_password: number;
  password_expires_at: number | null;
  password_changed_at: number;
  is_admin: number;
  disabled_at: number | null;
  created_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  label: string | null;
  last_seen_at: number | null;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  token_hash: string;
  label: string | null;
  tailnet_node: string | null;
  tailnet_ip: string | null;
  /** The device's stable node key (see tailnet-evidence.ts). Null on rows from before the column. */
  tailnet_key: string | null;
  /** What the LAST successful use could prove about where it came from:
   *  'peer' (unforgeable socket address), 'serve-xff' (Serve's forwarded
   *  address, evidence-only — see tailnet-evidence.ts), or 'none' (neither
   *  was available). Not in the E13 sketch; added because §4's rule —
   *  "record evidence:'none' on the row's last use" — is unimplementable
   *  without somewhere to put it, and because a device that has NEVER once
   *  shown evidence is exactly what an audit of this table wants to surface. */
  last_evidence: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/**
 * A WebAuthn platform credential (E15). NOTHING HERE IS HASHED, and that is
 * the point rather than an omission: a passkey row holds a PUBLIC key and a
 * public credential id. There is no secret in this table — the private half
 * lives in the TPM / Secure Enclave of the machine that made it and cannot be
 * exported. That is what makes it stronger than the password it stands in for,
 * and it is why a stolen copy of identity.db yields no way to sign in.
 */
export interface PasskeyRow {
  id: string;
  user_id: string;
  /** The remembered-device row this was enrolled from, when there was one.
   *  NULLABLE and deliberately weak: revoking the device does NOT revoke the
   *  passkey (they are separate credentials, contract §0), so this is a
   *  provenance note the account page can show, never an authorization edge. */
  device_id: string | null;
  /** base64url, as the browser reports it. UNIQUE — one row per credential,
   *  which is also what makes the sign-in lookup a primary-key-shaped read. */
  credential_id: string;
  /** base64url of the COSE public key bytes the authenticator attested. */
  public_key: string;
  /** The authenticator's own use count. Clone detection: a value that does not
   *  advance is a replay. Many platform authenticators pin it at 0 forever,
   *  which is legal and means "I do not implement this". */
  counter: number;
  /** JSON array as a string (`["internal","hybrid"]`), or null. Stored as one
   *  opaque pref exactly like `logo` on the recipe table — only the UI and the
   *  library parse it. */
  transports: string | null;
  aaguid: string | null;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

let db: Database.Database | null = null;

function open(): Database.Database {
  if (db) {
    return db;
  }
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_account (
      id                   TEXT PRIMARY KEY,
      username             TEXT NOT NULL UNIQUE,
      password_hash        TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      password_expires_at  INTEGER,
      password_changed_at  INTEGER NOT NULL,
      is_admin             INTEGER NOT NULL DEFAULT 0,
      disabled_at          INTEGER,
      created_at           INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      revoked_at   INTEGER,
      label        TEXT,
      last_seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS device (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      token_hash    TEXT NOT NULL UNIQUE,
      label         TEXT,
      tailnet_node  TEXT,
      tailnet_ip    TEXT,
      last_evidence TEXT,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER,
      revoked_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS api_token (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      label        TEXT,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS passkey (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      device_id     TEXT REFERENCES device(id),
      credential_id TEXT NOT NULL UNIQUE,
      public_key    TEXT NOT NULL,
      counter       INTEGER NOT NULL DEFAULT 0,
      transports    TEXT,
      aaguid        TEXT,
      label         TEXT,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER,
      revoked_at    INTEGER
    );
    -- ADD A SERVER: a one-time hand-back code (the design notes section 13). Stored HASHED; bound to the PKCE challenge, the account and the tailnet
    -- evidence that asked. The device row is created at exchange (its token cannot be recovered from a hash).
    CREATE TABLE IF NOT EXISTS handback_code (
      id          TEXT PRIMARY KEY,
      code_hash   TEXT NOT NULL UNIQUE,
      user_id     TEXT NOT NULL,
      challenge   TEXT NOT NULL,
      node        TEXT,
      node_key    TEXT,
      node_ip     TEXT,
      label       TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      used_at     INTEGER
    );
    -- R6a: a realm identity (issuer + stable sub) linked to ONE engine account.
    -- Written only by the link flow (both identities proven in one sitting);
    -- never by username or email.
    CREATE TABLE IF NOT EXISTS realm_link (
      issuer    TEXT NOT NULL,
      sub       TEXT NOT NULL,
      user_id   TEXT NOT NULL UNIQUE,
      linked_at INTEGER NOT NULL,
      PRIMARY KEY (issuer, sub)
    );
  `);
  /* ADD A SERVER: the device binds to the node KEY (additive, nullable: an older row keeps today's behaviour). */
  const deviceCols = new Set((db.prepare('PRAGMA table_info(device)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!deviceCols.has('tailnet_key')) {
    db.exec('ALTER TABLE device ADD COLUMN tailnet_key TEXT');
  }
  return db;
}

/** Where the file lives, for the CLI to print. Does NOT open it. */
export function identityDbPath(): string {
  return DB_PATH;
}

/** Hash for anything that is already high-entropy. See the header. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 256 bits of CSPRNG, url-safe so it can live in a cookie unescaped. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/* --- accounts -------------------------------------------------------------- */

export function countAccounts(): number {
  const row = open().prepare('SELECT COUNT(*) AS n FROM user_account').get() as { n: number };
  return row.n;
}

export function listAccounts(): Account[] {
  return open().prepare('SELECT * FROM user_account ORDER BY created_at').all() as Account[];
}

export function accountByUsername(username: string): Account | null {
  return (open()
    .prepare('SELECT * FROM user_account WHERE username = ?')
    .get(username.trim().toLowerCase()) as Account | undefined) ?? null;
}

export function accountById(id: string): Account | null {
  return (open().prepare('SELECT * FROM user_account WHERE id = ?').get(id) as Account | undefined) ?? null;
}

export function createAccount(opts: {
  username: string;
  passwordHash: string;
  mustChange: boolean;
  passwordExpiresAt: number | null;
  isAdmin: boolean;
}): Account {
  const now = Date.now();
  const id = randomUUID();
  open()
    .prepare(
      `INSERT INTO user_account
        (id, username, password_hash, must_change_password, password_expires_at,
         password_changed_at, is_admin, disabled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      opts.username.trim().toLowerCase(),
      opts.passwordHash,
      opts.mustChange ? 1 : 0,
      opts.passwordExpiresAt,
      now,
      opts.isAdmin ? 1 : 0,
      now,
    );
  return accountById(id)!;
}

/**
 * Set a password.
 *
 * `password_changed_at` IS THE SESSION-INVALIDATION EPOCH — every session
 * created before it is dead, without deleting a row (see resolveSession). That
 * is what makes "change my password and sign out everywhere" work at all, so it
 * is stamped here rather than by the caller: a caller that forgets is an
 * authorization hole, not a cosmetic bug.
 */
export function setPassword(
  userId: string,
  passwordHash: string,
  opts: { mustChange: boolean; passwordExpiresAt: number | null },
): void {
  open()
    .prepare(
      `UPDATE user_account
          SET password_hash = ?, must_change_password = ?, password_expires_at = ?,
              password_changed_at = ?
        WHERE id = ?`,
    )
    .run(passwordHash, opts.mustChange ? 1 : 0, opts.passwordExpiresAt, Date.now(), userId);
}

/* --- sessions -------------------------------------------------------------- */

/** `ttlMs` is the ABSOLUTE life (nothing extends it); realm-born sessions
 *  pass 8 h (R6a), every other caller the 30-day default. */
export function createSession(userId: string, token: string, label: string | null, ttlMs: number = SESSION_TTL_MS): SessionRow {
  const now = Date.now();
  const id = randomUUID();
  open()
    .prepare(
      `INSERT INTO session (id, user_id, token_hash, created_at, expires_at, revoked_at, label, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(id, userId, hashToken(token), now, now + ttlMs, label);
  return open().prepare('SELECT * FROM session WHERE id = ?').get(id) as SessionRow;
}

export function sessionByToken(token: string): SessionRow | null {
  return (open()
    .prepare('SELECT * FROM session WHERE token_hash = ?')
    .get(hashToken(token)) as SessionRow | undefined) ?? null;
}

export function touchSession(id: string): void {
  open().prepare('UPDATE session SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
}

export function revokeSession(id: string): void {
  open().prepare('UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
}

/** Every session for this user EXCEPT the one named — what a password change
 *  does in addition to bumping the epoch, so the browser doing the changing is
 *  not logged out of itself. */
export function revokeOtherSessions(userId: string, keepId: string | null): void {
  open()
    .prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
    .run(Date.now(), userId, keepId ?? '');
}

/* --- devices --------------------------------------------------------------- */

export function createDevice(opts: {
  userId: string;
  token: string;
  label: string | null;
  tailnetNode: string | null;
  tailnetIp: string | null;
  tailnetKey?: string | null;
}): DeviceRow {
  const id = randomUUID();
  open()
    .prepare(
      `INSERT INTO device
        (id, user_id, token_hash, label, tailnet_node, tailnet_ip, tailnet_key, last_evidence, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
    )
    .run(id, opts.userId, hashToken(opts.token), opts.label, opts.tailnetNode, opts.tailnetIp, opts.tailnetKey ?? null, Date.now());
  return open().prepare('SELECT * FROM device WHERE id = ?').get(id) as DeviceRow;
}

export function deviceByToken(token: string): DeviceRow | null {
  return (open()
    .prepare('SELECT * FROM device WHERE token_hash = ?')
    .get(hashToken(token)) as DeviceRow | undefined) ?? null;
}

export function touchDevice(id: string, evidence: string): void {
  open().prepare('UPDATE device SET last_used_at = ?, last_evidence = ? WHERE id = ?').run(Date.now(), evidence, id);
}

export function listDevices(userId: string): DeviceRow[] {
  return open()
    .prepare('SELECT * FROM device WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as DeviceRow[];
}

export function revokeDevice(id: string, userId: string): boolean {
  const info = open()
    .prepare('UPDATE device SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), id, userId);
  return info.changes > 0;
}

export function revokeDevicesForUser(userId: string): number {
  return open()
    .prepare('UPDATE device SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), userId).changes;
}

/* --- hand-back codes (Add a server) ---------------------------------------- */

export interface HandbackRow {
  id: string;
  user_id: string;
  challenge: string;
  node: string | null;
  node_key: string | null;
  node_ip: string | null;
  label: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export function createHandbackCode(opts: {
  code: string;
  userId: string;
  challenge: string;
  node: string | null;
  nodeKey: string | null;
  nodeIp: string | null;
  label: string | null;
  ttlMs: number;
}): void {
  const now = Date.now();
  open()
    .prepare(
      `INSERT INTO handback_code (id, code_hash, user_id, challenge, node, node_key, node_ip, label, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(randomUUID(), hashToken(opts.code), opts.userId, opts.challenge, opts.node, opts.nodeKey, opts.nodeIp, opts.label, now, now + opts.ttlMs);
  /* housekeeping: a spent or lapsed code is gone after a day */
  open().prepare('DELETE FROM handback_code WHERE expires_at < ?').run(now - 86_400_000);
}

/** Burn a code: returns its row ONLY if it existed, was unused and unexpired, and marks it used in the same transaction. A code that exists but fails any later check
 *  (verifier, evidence) is still burned here, so a guessed or stolen code gets exactly one try. Null for unknown, used or expired. */
export function takeHandbackCode(code: string, now = Date.now()): HandbackRow | null {
  const d = open();
  const run = d.transaction((): HandbackRow | null => {
    const row = d.prepare('SELECT * FROM handback_code WHERE code_hash = ?').get(hashToken(code)) as HandbackRow | undefined;
    if (!row || row.used_at !== null || row.expires_at <= now) {
      return null;
    }
    d.prepare('UPDATE handback_code SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, row.id);
    return row;
  });
  return run();
}

/* --- api tokens ------------------------------------------------------------ */

export function createApiToken(userId: string, token: string, label: string | null): TokenRow {
  const id = randomUUID();
  open()
    .prepare(
      `INSERT INTO api_token (id, user_id, token_hash, label, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(id, userId, hashToken(token), label, Date.now());
  return open().prepare('SELECT * FROM api_token WHERE id = ?').get(id) as TokenRow;
}

export function apiTokenByToken(token: string): TokenRow | null {
  return (open()
    .prepare('SELECT * FROM api_token WHERE token_hash = ?')
    .get(hashToken(token)) as TokenRow | undefined) ?? null;
}

/** Deliberately throttled to once a minute. A machine client presents its
 *  bearer on EVERY request, and a write per request turns a read path into a
 *  write path on a WAL db for a field nobody reads to the second. */
const TOUCH_EVERY_MS = 60 * 1000;
export function touchApiToken(row: TokenRow): void {
  if (row.last_used_at !== null && Date.now() - row.last_used_at < TOUCH_EVERY_MS) {
    return;
  }
  open().prepare('UPDATE api_token SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
}

export function listApiTokens(userId: string): TokenRow[] {
  return open()
    .prepare('SELECT * FROM api_token WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as TokenRow[];
}

export function revokeApiToken(id: string, userId: string): boolean {
  const info = open()
    .prepare('UPDATE api_token SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), id, userId);
  return info.changes > 0;
}

/* --- passkeys (E15) -------------------------------------------------------- */

export function createPasskey(opts: {
  userId: string;
  deviceId: string | null;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[] | null;
  aaguid: string | null;
  label: string | null;
}): PasskeyRow {
  const id = randomUUID();
  open()
    .prepare(
      `INSERT INTO passkey
        (id, user_id, device_id, credential_id, public_key, counter, transports,
         aaguid, label, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      id,
      opts.userId,
      opts.deviceId,
      opts.credentialId,
      opts.publicKey,
      opts.counter,
      opts.transports && opts.transports.length > 0 ? JSON.stringify(opts.transports) : null,
      opts.aaguid,
      opts.label,
      Date.now(),
    );
  return open().prepare('SELECT * FROM passkey WHERE id = ?').get(id) as PasskeyRow;
}

/** The sign-in lookup: a browser hands back a credential id and NOTHING else
 *  that names a user, which is the whole of the discoverable-credential flow —
 *  this row is what turns the assertion into an account. */
export function passkeyByCredentialId(credentialId: string): PasskeyRow | null {
  return (open()
    .prepare('SELECT * FROM passkey WHERE credential_id = ?')
    .get(credentialId) as PasskeyRow | undefined) ?? null;
}

export function listPasskeys(userId: string): PasskeyRow[] {
  return open()
    .prepare('SELECT * FROM passkey WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as PasskeyRow[];
}

/** Live passkeys enrolled from one remembered device — what narrows
 *  `allowCredentials` when the browser arrives carrying a device cookie. */
export function passkeysForDevice(deviceId: string): PasskeyRow[] {
  return open()
    .prepare('SELECT * FROM passkey WHERE device_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
    .all(deviceId) as PasskeyRow[];
}

/** Advance the clone-detection counter and stamp the use. Written on EVERY
 *  successful assertion (unlike `touchApiToken`'s throttle) — a sign-in is
 *  rare, and the counter is the security value, not a nicety. */
export function touchPasskey(id: string, counter: number): void {
  open().prepare('UPDATE passkey SET last_used_at = ?, counter = ? WHERE id = ?').run(Date.now(), counter, id);
}

export function revokePasskey(id: string, userId: string): boolean {
  const info = open()
    .prepare('UPDATE passkey SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), id, userId);
  return info.changes > 0;
}

/* --- realm links (R6a) ------------------------------------------------------ */

export interface RealmLinkRow {
  issuer: string;
  sub: string;
  user_id: string;
  linked_at: number;
}

export function realmLinkBySub(issuer: string, sub: string): RealmLinkRow | null {
  return (open()
    .prepare('SELECT * FROM realm_link WHERE issuer = ? AND sub = ?')
    .get(issuer, sub) as RealmLinkRow | undefined) ?? null;
}

export function realmLinkForUser(userId: string): RealmLinkRow | null {
  return (open().prepare('SELECT * FROM realm_link WHERE user_id = ?').get(userId) as RealmLinkRow | undefined) ?? null;
}

/** False when either side is already linked (UNIQUE on both). */
export function createRealmLink(issuer: string, sub: string, userId: string): boolean {
  const info = open()
    .prepare('INSERT OR IGNORE INTO realm_link (issuer, sub, user_id, linked_at) VALUES (?, ?, ?, ?)')
    .run(issuer, sub, userId, Date.now());
  return info.changes > 0;
}

export function deleteRealmLink(userId: string): boolean {
  return open().prepare('DELETE FROM realm_link WHERE user_id = ?').run(userId).changes > 0;
}

/** Tests only: drop the handle so a fresh path can be opened in-process. */
export function closeForTests(): void {
  db?.close();
  db = null;
}
