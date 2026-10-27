/**
 * HOSTED WORKBENCH, one instance [hosted] (Owner 2026-10-07, KB design-notes-id).
 *
 *   npx tsx scripts/hosted-workbench.ts <user> --home <dir> --port <n> --broker-port <n> [--dry-run]
 *
 * Provisions ONE instance of the shared engine code for one hosted Linux user,
 * with the engine NOT running. runtime's `add-hosted-user` (remote-ops repo) creates
 * the user, limits, folders, CLAUDE.md, skills and nginx, then calls this LAST.
 * Idempotent: a second run changes nothing and says so. --dry-run prints every
 * step and writes nothing (it does not even open a database).
 *
 * What it makes, all under <home>/.workbench (the instance's HARBOR_WB_DATA_DIR):
 *   workbench.env        the engine's env (mode 600), read by deploy/hosted/workbench@.service
 *   pty-broker.env       the broker's env incl. its token (mode 600), read by pty-broker@.service
 *   secrets/broker.token the broker bearer the engine presents (HARBOR_WB_BROKER_TOKEN_FILE)
 *   targets.json         one target: this server, the instance's own (local) broker
 *   data/identity.db     the account <user>, admin, with a one-time temp code printed
 *                        to STDOUT ONLY (scripts/identity.ts's rule)
 *   data/mapping.db      two recipes (runtime: <home>/dev; Builder: <home>/dev/code/hello-world)
 *                        and two rooms ("My runtime" led by its coordinator seat, "Hello World"
 *                        with a builder seat)
 *
 * Run as root (platform's script), every file made is handed to the home's owner.
 */
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { withTrusted } from '../src/engine/hosted-trust.ts';

type Step = { what: string; state: 'created' | 'updated' | 'unchanged' | 'would create' | 'would update' | 'skipped' };

function die(msg: string, code = 2): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

const USAGE = 'usage: hosted-workbench.ts <user> --home <dir> --port <n> --broker-port <n> [--dry-run] [--trust-folder <abs dir>]...';

/** The user's own bin first (Claude Code installs to ~/.local/bin), then the system's: systemd
 *  user units start with a bare PATH, so the shells and agents the broker spawns need it set here. */
function userPath(home: string): string {
  return [join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
}

function args(argv: string[]): { user: string; home: string; port: number; brokerPort: number; dryRun: boolean; trustFolders: string[] } {
  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const user = (argv[0] ?? '').trim();
  if (!user || user.startsWith('--')) die(USAGE);
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(user)) die('user: a Linux user name (lowercase, starts with a letter, 2-32 chars)');
  const home = flag('home');
  if (!home) die(USAGE);
  const port = Number(flag('port'));
  const brokerPort = Number(flag('broker-port'));
  for (const [n, v] of [['--port', port], ['--broker-port', brokerPort]] as const) {
    if (!Number.isInteger(v) || v < 1024 || v > 65535) die(`${n}: a port, 1024-65535`);
  }
  if (port === brokerPort) die('--port and --broker-port must differ');
  /* H3: folder trust is OFF unless the deployer names a folder: --trust-folder <abs dir>, repeatable, one flag per folder */
  const trustFolders: string[] = [];
  argv.forEach((x, i) => {
    if (x === '--trust-folder') {
      const d = argv[i + 1] ?? '';
      if (!d.startsWith('/')) die('--trust-folder: an absolute folder');
      trustFolders.push(d);
    }
  });
  return { user, home: resolve(home), port, brokerPort, dryRun: argv.includes('--dry-run'), trustFolders };
}

/** KEY=value lines, in order. Values here never contain spaces or quotes. */
function envText(lines: Array<[string, string]>, header: string): string {
  return `# ${header}\n# Written by scripts/hosted-workbench.ts; re-run it to change ports.\n` + lines.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  const dataDir = join(a.home, '.workbench');
  const steps: Step[] = [];
  const say = (what: string, state: Step['state']) => {
    steps.push({ what, state });
    process.stdout.write(`  ${state.padEnd(12)} ${what}\n`);
  };
  process.stdout.write(`hosted workbench for ${a.user}${a.dryRun ? ' (dry run: nothing is written)' : ''}\n  data dir     ${dataDir}\n`);
  if (!existsSync(a.home)) {
    die(`home ${a.home} does not exist (platform's add-hosted-user makes it first)`);
  }
  for (const d of [join(a.home, 'dev'), join(a.home, 'dev', 'code', 'hello-world')]) {
    if (!existsSync(d)) process.stdout.write(`  note         ${d} does not exist yet (platform's script makes it); the recipe still points there\n`);
  }

  /* ---- folders + files ---- */
  const dir = (p: string) => {
    if (existsSync(p)) return say(p, 'unchanged');
    if (a.dryRun) return say(p, 'would create');
    mkdirSync(p, { recursive: true, mode: 0o700 });
    say(p, 'created');
  };
  const file = (p: string, text: string, mode: number) => {
    const had = existsSync(p);
    if (had && readFileSync(p, 'utf8') === text) return say(p, 'unchanged');
    if (a.dryRun) return say(p, had ? 'would update' : 'would create');
    writeFileSync(p, text, { mode });
    chmodSync(p, mode);
    say(p, had ? 'updated' : 'created');
  };
  dir(dataDir);
  dir(join(dataDir, 'data'));
  dir(join(dataDir, 'secrets'));

  const tokenFile = join(dataDir, 'secrets', 'broker.token');
  let token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  if (token) {
    say(tokenFile, 'unchanged');
  } else if (a.dryRun) {
    say(tokenFile, 'would create');
    token = '<new token>';
  } else {
    token = randomBytes(32).toString('hex');
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    say(tokenFile, 'created');
  }

  file(
    join(dataDir, 'workbench.env'),
    envText(
      [
        ['HARBOR_WB_DATA_DIR', dataDir],
        ['HARBOR_WB_HOST', '127.0.0.1'],
        ['HARBOR_WB_PORT', String(a.port)],
        ['HARBOR_WB_IDENTITY', 'strict'],
        ['HARBOR_WB_EDITION', 'basic'],
        ['HARBOR_WB_NODE', `hosted-${a.user}`],
        ['HARBOR_WB_DESKTOP', 'none'],
        ['HARBOR_WB_FABRIC_URL', 'off'],
        ['HARBOR_WB_NATS_URL', ''],
        ['HARBOR_WB_ROOM_FABRIC', '0'],
        ['HARBOR_WB_BROKER_PORT', String(a.brokerPort)],
        ['HARBOR_WB_BROKER_TOKEN_FILE', tokenFile],
        ['HARBOR_WB_BROKER_AUTOSTART', '0'],
        ['PATH', userPath(a.home)],
      ],
      `Workbench engine for ${a.user} (deploy/hosted/workbench@.service)`,
    ),
    0o600,
  );
  file(
    join(dataDir, 'pty-broker.env'),
    envText(
      [
        ['PTY_BROKER_HOST', '127.0.0.1'],
        ['PTY_BROKER_PORT', String(a.brokerPort)],
        ['PTY_BROKER_TOKEN', token],
        ['PATH', userPath(a.home)],
      ],
      `pty-broker for ${a.user} (deploy/hosted/pty-broker@.service)`,
    ),
    0o600,
  );
  /* H3 (security review): NO folder is pre-trusted by default. Claude asks, or the person trusts a folder in Settings. A deployer who wants a folder pre-accepted names it with --trust-folder
     (once per folder); the older blanket pre-trust of ~/dev (Owner 2026-10-10, room interface [ref]) is gone. */
  if (a.trustFolders.length) {
    const claudeJson = join(a.home, '.claude.json');
    const trustDirs = a.trustFolders;
    const had = existsSync(claudeJson);
    const r = withTrusted(had ? readFileSync(claudeJson, 'utf8') : null, trustDirs);
    if (!r.ok) {
      say(`${claudeJson} (not trusted: ${r.reason}; left alone)`, 'skipped');
    } else if (!r.changed) {
      say(`${claudeJson} (project folders trusted)`, 'unchanged');
    } else if (a.dryRun) {
      say(`${claudeJson} (trust the user's project folders)`, had ? 'would update' : 'would create');
    } else {
      writeFileSync(claudeJson, r.text, { mode: 0o600 });
      chmodSync(claudeJson, 0o600);
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        const { uid, gid } = statSync(a.home);
        chownSync(claudeJson, uid, gid);
      }
      say(`${claudeJson} (trust the user's project folders)`, had ? 'updated' : 'created');
    }
  }

  file(
    join(dataDir, 'targets.json'),
    JSON.stringify({ targets: [{ id: 'local', label: 'This server', kind: 'local', broker: 'local', shell: '/bin/bash', node: `hosted-${a.user}` }] }, null, 2) + '\n',
    0o600,
  );

  /* ---- the account, recipes and rooms: the store APIs, with this data dir ---- */
  const identityDb = join(dataDir, 'data', 'identity.db');
  const mappingDb = join(dataDir, 'data', 'mapping.db');
  const PLATFORM = { id: 'hosted-platform', name: 'Platform', agent: 'platform', dir: join(a.home, 'dev') };
  const BUILDER = { id: 'hosted-builder', name: 'Builder', agent: 'builder', dir: join(a.home, 'dev', 'code', 'hello-world') };
  const ROOMS = [
    { name: 'My Platform', recipe: PLATFORM },
    { name: 'Hello World', recipe: BUILDER },
  ];
  if (a.dryRun) {
    say(`account ${a.user} (admin, a one-time code on stdout) in ${identityDb}`, existsSync(identityDb) ? 'skipped' : 'would create');
    for (const r of [PLATFORM, BUILDER]) say(`recipe ${r.name} (claude-code, ${r.dir}) in ${mappingDb}`, existsSync(mappingDb) ? 'skipped' : 'would create');
    for (const r of ROOMS) say(`room "${r.name}" with a ${r.recipe.name} seat as lead`, existsSync(mappingDb) ? 'skipped' : 'would create');
    if (existsSync(mappingDb) || existsSync(identityDb)) {
      process.stdout.write('  (a database already exists: a real run checks its contents and changes only what is missing)\n');
    }
  } else {
    /* Every per-instance path resolves under this data dir (src/engine/data-dir.ts);
       set BEFORE the stores are imported, since they read it at module load. */
    process.env.HARBOR_WB_DATA_DIR = dataDir;
    delete process.env.HARBOR_WB_TABLE;
    delete process.env.HARBOR_WB_IDENTITY_DB;
    const istore = await import('../src/identity/store.ts');
    const existing = istore.accountByUsername(a.user);
    if (existing) {
      say(`account ${a.user}`, 'unchanged');
    } else if (istore.countAccounts() > 0) {
      say(`account ${a.user} (other accounts exist; use scripts/identity.ts)`, 'skipped');
    } else {
      const { hashPassword } = await import('../src/identity/auth.ts');
      const { generateTempPassword, DEFAULT_TEMP_TTL_HOURS } = await import('../src/identity/password-policy.ts');
      const code = generateTempPassword();
      const expiresAt = Date.now() + DEFAULT_TEMP_TTL_HOURS * 60 * 60 * 1000;
      istore.createAccount({ username: a.user, passwordHash: await hashPassword(code), mustChange: true, passwordExpiresAt: expiresAt, isAdmin: true });
      say(`account ${a.user} (admin)`, 'created');
      /* THE CODE GOES TO STDOUT AND NOWHERE ELSE (scripts/identity.ts). */
      process.stdout.write(
        `\n  temporary password for ${a.user}\n    password  ${code}\n    expires   ${new Date(expiresAt).toISOString()}\n` +
          '  Shown once. Sign in at /login and set a real password.\n\n',
      );
    }

    const { table } = await import('../src/table/endpoint.ts');
    for (const r of [PLATFORM, BUILDER]) {
      const have = table.getRecipe(r.id);
      if (have && have.projectDir === r.dir && have.vendor === 'claude-code') {
        say(`recipe ${r.name}`, 'unchanged');
        continue;
      }
      table.upsertRecipe({
        id: r.id, name: r.name, target: 'local', projectDir: r.dir, vendor: 'claude-code', agent: r.agent, model: null, effort: null,
        worktree: 'never', resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null,
        color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
      } as never);
      say(`recipe ${r.name} (claude-code, ${r.dir})`, have ? 'updated' : 'created');
    }
    for (const r of ROOMS) {
      let room = table.listRooms().find((x) => x.name === r.name);
      if (room) {
        say(`room "${r.name}"`, 'unchanged');
      } else {
        room = table.createRoom({ name: r.name }, { actor: 'user' }).result;
        say(`room "${r.name}"`, 'created');
      }
      let seat = table.listSeats(room.id).find((s) => s.recipe_id === r.recipe.id);
      if (seat) {
        say(`  seat @${seat.handle} (${r.recipe.name})`, 'unchanged');
      } else {
        seat = table.addSeat(room.id, { recipe_id: r.recipe.id, handle: r.recipe.agent }, { actor: 'user' }).result;
        say(`  seat @${seat.handle} (${r.recipe.name})`, 'created');
      }
      if (table.getRoom(room.id)?.lead_seat === seat.id) {
        say(`  lead @${seat.handle}`, 'unchanged');
      } else {
        table.updateRoom(room.id, { lead_seat: seat.id }, { actor: 'user' });
        say(`  lead @${seat.handle}`, 'created');
      }
    }

    /* Run as root: hand every file to the home's owner (the engine runs as that user). */
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const { uid, gid } = statSync(a.home);
      const walk = (p: string) => {
        chownSync(p, uid, gid);
        if (statSync(p).isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
      };
      walk(dataDir);
      process.stdout.write(`  owner        ${dataDir} -> uid ${uid}\n`);
    }
  }

  const changed = steps.filter((s) => s.state !== 'unchanged' && s.state !== 'skipped').length;
  process.stdout.write(
    a.dryRun
      ? `\ndry run: ${changed} step(s) would change something; nothing was written.\n`
      : changed
        ? `\ndone: ${changed} change(s).\n`
        : '\nnothing to do: this instance is already provisioned.\n',
  );
}

main().catch((e) => die(`hosted-workbench: ${(e as Error)?.stack ?? e}`, 1));
