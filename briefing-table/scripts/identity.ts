/**
 * Account administration for the engine (E13). Hand-run, never a route.
 *
 *   npx tsx scripts/identity.ts bootstrap --username owner
 *   npx tsx scripts/identity.ts temp-password --username owner [--ttl 24]
 *   npx tsx scripts/identity.ts revoke-devices --username owner
 *   npx tsx scripts/identity.ts list
 *
 * A CLI RATHER THAN A FIRST-RUN WEB SCREEN, and kiosk's reasoning carries
 * over unchanged: a first-run screen is an unauthenticated account-creation
 * endpoint whose "provably closed after the first account" proof is exactly the
 * thing that goes wrong. Seeding in a migration would put a hash in git.
 *
 * THE CODE IS PRINTED TO STDOUT AND NOWHERE ELSE. Not to the engine log, not to
 * a file, not through the log() helper. It is read once off the terminal and
 * typed in. (If it is being handed over in a CLI-Manager session, the `handoff`
 * skill is the right way to deliver it — a copyable field, not a line of
 * terminal text that wraps.)
 *
 * This runs OUTSIDE the engine process and opens the same `data/identity.db`.
 * SQLite in WAL mode handles that concurrency; there is no need to stop the
 * service to mint an account.
 */
import * as store from '../src/identity/store.ts';
import { hashPassword } from '../src/identity/auth.ts';
import { generateTempPassword, DEFAULT_TEMP_TTL_HOURS } from '../src/identity/password-policy.ts';

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[i + 1];
}

function die(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

const USAGE =
  'usage:\n' +
  '  identity.ts bootstrap --username <u>\n' +
  '  identity.ts temp-password --username <u> [--ttl <hours>]\n' +
  '  identity.ts revoke-devices --username <u>\n' +
  '  identity.ts list\n';

function requireUsername(): string {
  const u = (flag('username') ?? '').trim().toLowerCase();
  if (!u) {
    die(USAGE, 2);
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(u)) {
    die('username: 2-32 chars, lowercase letters/digits/._- and must start alphanumeric');
  }
  return u;
}

/** Everything a freshly-issued temp code has to say, in one block. The expiry
 *  is printed because it is the whole safety argument for a short code. */
function announce(username: string, code: string, expiresAt: number): void {
  process.stdout.write(
    '\ntemporary password issued\n' +
      `  username  ${username}\n` +
      `  password  ${code}\n` +
      `  expires   ${new Date(expiresAt).toISOString()}\n\n` +
      'Shown once, stored only as an argon2id hash. It is DEAD at the expiry above,\n' +
      'and every route except "change password" is refused until it is exchanged for\n' +
      'a real one. Sign in at /login and you will land on the change form.\n\n',
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd === 'bootstrap') {
    const username = requireUsername();
    const existing = store.countAccounts();
    if (existing > 0) {
      die(
        `refusing: ${existing} account(s) already exist in ${store.identityDbPath()}.\n` +
          'This mints the FIRST one only. To reset a password on an existing account:\n' +
          `  npx tsx scripts/identity.ts temp-password --username ${username}\n`,
      );
    }
    const code = generateTempPassword();
    const expiresAt = Date.now() + DEFAULT_TEMP_TTL_HOURS * 60 * 60 * 1000;
    store.createAccount({
      username,
      passwordHash: await hashPassword(code),
      mustChange: true,
      passwordExpiresAt: expiresAt,
      isAdmin: true,
    });
    process.stdout.write(`\ndatabase  ${store.identityDbPath()}\n`);
    announce(username, code, expiresAt);
    process.stdout.write(
      'The engine still runs in HARBOR_WB_IDENTITY=legacy until that env var is set to\n' +
        '"both" (accept either this account or the shared engine.token) or "strict".\n\n',
    );
    return;
  }

  if (cmd === 'temp-password') {
    const username = requireUsername();
    const account = store.accountByUsername(username);
    if (!account) {
      die(`no account "${username}" in ${store.identityDbPath()}`);
    }
    const hours = Number(flag('ttl') ?? DEFAULT_TEMP_TTL_HOURS);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 14) {
      die('--ttl: hours, > 0 and <= 336');
    }
    const code = generateTempPassword();
    const expiresAt = Date.now() + hours * 60 * 60 * 1000;
    store.setPassword(account.id, await hashPassword(code), {
      mustChange: true,
      passwordExpiresAt: expiresAt,
    });
    /* setPassword moved password_changed_at, which is the session-invalidation
     * epoch — every existing browser session is already dead. Devices are NOT:
     * a reset is normally "I forgot it", not "someone has my laptop". Use
     * revoke-devices for the second case. */
    announce(username, code, expiresAt);
    process.stdout.write(
      'Every existing browser session for this account is now invalid.\n' +
        'Remembered devices are NOT revoked — run revoke-devices if the machine is lost.\n\n',
    );
    return;
  }

  if (cmd === 'revoke-devices') {
    const username = requireUsername();
    const account = store.accountByUsername(username);
    if (!account) {
      die(`no account "${username}"`);
    }
    const n = store.revokeDevicesForUser(account.id);
    process.stdout.write(`revoked ${n} remembered device(s) for ${username}\n`);
    return;
  }

  if (cmd === 'list') {
    process.stdout.write(`database  ${store.identityDbPath()}\n`);
    const accounts = store.listAccounts();
    if (accounts.length === 0) {
      process.stdout.write('no accounts — run: identity.ts bootstrap --username <u>\n');
      return;
    }
    for (const a of accounts) {
      const bits = [
        a.username.padEnd(16),
        a.is_admin === 1 ? 'admin' : 'user ',
        a.must_change_password === 1 ? 'MUST-CHANGE' : 'ok         ',
        a.password_expires_at ? `expires ${new Date(a.password_expires_at).toISOString()}` : '',
        `${store.listDevices(a.id).filter((d) => d.revoked_at === null).length} device(s)`,
        `${store.listApiTokens(a.id).filter((t) => t.revoked_at === null).length} token(s)`,
      ];
      process.stdout.write(`${bits.join('  ')}\n`);
    }
    return;
  }

  die(USAGE, 2);
}

main().catch((err) => {
  die(`failed: ${(err as Error).message}`);
});
