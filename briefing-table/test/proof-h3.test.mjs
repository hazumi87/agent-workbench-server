/** H3: the actual room-seat start path must not pre-accept Claude folder trust. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { childEnv, P } from './_scratch.mjs';
import { Readable } from 'node:stream';
import { tsImport } from 'tsx/esm/api';
import { proof, recipe, unitDir, root } from './_hosting-proof.mjs';
const requestedProfile = process.env.WB_PROOF_H3_PROFILE ?? 'hosted';
if (!['hosted', 'legacy-local', 'both'].includes(requestedProfile)) throw new Error('H3 profile is hosted, legacy-local or both');
// Product modules can cache their mode at import time. Never switch profiles
// after importing them: each branch of 'both' gets a fresh Node process.
if (requestedProfile === 'both') {
  let passed = 0, failed = 0;
  try {
    for (const profile of ['legacy-local', 'hosted']) {
      console.log(`PROFILE H3 ${profile}: independent child process`);
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: root, env: childEnv({ WB_PROOF_H3_PROFILE: profile }), encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      });
      process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '');
      const summaries = [...(child.stdout ?? '').matchAll(/^PASS (\d+) FAIL (\d+)$/gm)];
      const summary = summaries.at(-1);
      if (!summary || Number(summary[1]) + Number(summary[2]) === 0) {
        console.error(`FAIL H3 ${profile}: child has no assertion summary`); failed++;
      } else {
        passed += Number(summary[1]); failed += Number(summary[2]);
        if (child.status !== 0 && Number(summary[2]) === 0) { console.error(`FAIL H3 ${profile}: nonzero child exit without failed summary`); failed++; }
      }
    }
  } finally { rmSync(unitDir, { recursive: true, force: true }); }
  console.log(`PASS ${passed} FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}

process.env.HARBOR_WB_MODE = requestedProfile === 'legacy-local' ? 'local' : '';
if (requestedProfile !== 'legacy-local') process.env.HARBOR_WB_HOSTED = '1';
delete process.env.HARBOR_WB_FOLDER_TRUST;
const bin = join(unitDir, 'bin'); mkdirSync(bin);
// Resolve-only sentinel. The injected launch boundary below must be reached
// without executing any vendor program, including this sentinel.
writeFileSync(join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), process.platform === 'win32' ? '@exit /b 97\r\n' : '#!/bin/sh\nexit 97\n', { mode: 0o755 });
process.env.PATH = bin + delimiter + process.env.PATH;
const { table } = await tsImport('../src/table/endpoint.ts', import.meta.url);
const rooms = await tsImport('../src/server/rooms.ts', import.meta.url);
await proof('H3', async check => {
  const project = join(unitDir, 'project'), config = process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(project); mkdirSync(config);
  const trust = join(config, '.claude.json');
  table.upsertRecipe(recipe({ id: 'trust-proof', vendor: 'claude-code', projectDir: project }));
  const room = table.createRoom({ name: 'Trust proof' }, { actor: 'user' }).result;
  const seat = table.addSeat(room.id, { recipe_id: 'trust-proof', handle: 'trust-proof' }, { actor: 'user' }).result;
  const path = `/api/rooms/${room.id}/seats/${seat.id}/start`;
  let launches = 0;
  const deps = { human: true, log() {}, projector: async () => row => row,
    launch: async () => { launches++; throw Object.assign(new Error('proof stops before vendor spawn'), { status: 409 }); } };
  async function start() {
    const req = Readable.from([Buffer.from('{}')]); req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
    let status, body;
    const res = { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } };
    const handled = await rooms.handle(req, res, path, null, deps);
    check(handled && status === 409 && body?.error?.includes('proof stops'), 'real seat-start handler reached the injected vendor launch boundary');
  }
  const original = JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: false } }, unrelated: 'preserve-me' });
  const profiles = [requestedProfile];
  for (const profile of profiles) {
    process.env.HARBOR_WB_MODE = profile === 'legacy-local' ? 'local' : '';
    if (profile === 'hosted') process.env.HARBOR_WB_HOSTED = '1'; else delete process.env.HARBOR_WB_HOSTED;
    console.log(`PROFILE H3 ${profile}: engine admission only, no vendor execution`);
    writeFileSync(trust, original);
    await start();
    check(readFileSync(trust, 'utf8') === original, `${profile}: default seat start leaves existing trust bytes unchanged`);
    rmSync(trust);
    await start();
    check(!existsSync(trust), `${profile}: default seat start does not create missing trust file`);
  }
  check(launches === profiles.length * 2, 'all cases exercise launch admission without running a model CLI');
  if (profiles.includes('hosted')) {
    const setupHome = join(unitDir, 'setup-home');
    const dirs = [join(setupHome, 'dev'), join(setupHome, 'dev/code/hello-world')];
    mkdirSync(dirs[1], { recursive: true });
    const applied = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/hosted-workbench.ts'),
      'proof-user', '--home', setupHome, '--port', String(P(2002)), '--broker-port', String(P(2003))], {
      cwd: root, env: childEnv({ HARBOR_WB_TOKEN: 'scratch-setup-proof-only', HARBOR_WB_HOSTED: '1',
        HARBOR_WB_FABRIC_URL: '', HARBOR_WB_NATS_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
        CLAUDE_CONFIG_DIR: join(setupHome, 'private-config'), CODEX_HOME: join(setupHome, 'private-codex') }),
      encoding: 'utf8', timeout: 30000,
    });
    // The setup CLI only provisions these private files/DBs; it starts no
    // service, opens no listener and runs no vendor. Never print its one-time
    // generated test-account password or broker token.
    check(applied.status === 0 && existsSync(join(setupHome, '.workbench', 'targets.json')), 'real hosted setup completed in owned scratch home (not dry-run)');
    const setupTrust = join(setupHome, '.claude.json');
    const saved = existsSync(setupTrust) ? JSON.parse(readFileSync(setupTrust, 'utf8')) : {};
    for (const folder of dirs) check(saved.projects?.[folder]?.hasTrustDialogAccepted !== true,
      'hosted setup does not pre-accept trust for its provisioned project folder');
  }
});
