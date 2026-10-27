/**
 * The scratch Basic instance runner (ticket): it boots the hosted Workbench exactly as provisioned, with fake vendors, and
 * leaves nothing behind. Slots 500/501 of the shared scratch table (7930/7931 at offset 0).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// a canary the child env scrub must remove: a parent HARBOR_WB_* / PTY_BROKER_* key must never reach the instance
process.env.HARBOR_WB_CANARY = 'leaked-from-the-parent';
process.env.PTY_BROKER_TOKEN = 'parent-token-must-not-leak';
const { startScratchBasic, SCRATCH_ENGINE_SLOT } = await import('../scripts/basic-scratch-instance.ts');

let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

const ok = (c: unknown, m: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);
const free = (port: number) => new Promise<boolean>((res) => { const s = createServer(); s.once('error', () => res(false)); s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => res(true))); });
const repoSnapshot = (root: string): string => {
  const out: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { if (d === root && (n === 'node_modules' || n === '.git')) continue; const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else out.push(`${p} ${st.mtimeMs} ${st.size}`); } };
  walk(root);
  return out.join('\n');
};

const before = repoSnapshot(process.cwd());
const inst = await startScratchBasic();
try {
  console.log('it boots as Basic');
  const h: any = await fetch(`${inst.base}/health`).then((r) => r.json());
  eq(h.edition, 'basic', '/health reports the Basic edition');
  eq(h.brokers?.local, 'up', 'its own local broker link is up');
  eq(Object.keys(h.brokers ?? {}), ['local'], 'and it is the ONLY broker (no harbor, VRPC or server link)');
  const gate = await fetch(`${inst.base}/api/table`, { redirect: 'manual' });
  ok([401, 302, 303].includes(gate.status), `strict accounts: no credential, no table (${gate.status})`);
  ok(inst.tempPassword.length >= 8, 'the account\'s one-time password came back from the provisioning script');
  eq([inst.env.HARBOR_WB_IDENTITY, inst.env.HARBOR_WB_EDITION, inst.env.HARBOR_WB_DESKTOP, inst.env.HARBOR_WB_FABRIC_URL, inst.env.HARBOR_WB_ROOM_FABRIC], ['strict', 'basic', 'none', 'off', '0'], 'identity strict, edition basic, no desktop, no fabric');
  eq(JSON.parse(readFileSync(join(inst.dataDir, 'targets.json'), 'utf8')).targets[0].shell, '/bin/bash', 'the local target pins /bin/bash (the hosted Linux shell fix)');

  console.log('it is isolated');
  const penv = readFileSync(`/proc/${inst.enginePid}/environ`, 'utf8').split('\0');
  ok(!penv.some((l) => l.startsWith('HARBOR_WB_CANARY=') || l.startsWith('PTY_BROKER_TOKEN=parent')), 'no HARBOR_WB_* / PTY_BROKER_* key leaked in from the caller');
  ok(penv.includes(`HARBOR_WB_DATA_DIR=${inst.dataDir}`) && penv.includes('HARBOR_WB_NATS_URL='), 'it runs on its own data dir with NATS pinned off');
  ok(inst.port !== 7420 && inst.port !== 8201 && inst.brokerPort !== 7430, `ports ${inst.port}/${inst.brokerPort} are scratch ports, never a live one`);
  ok(existsSync(join(inst.dataDir, 'data', 'mapping.db')) && existsSync(join(inst.dataDir, 'secrets', 'engine.token')), 'its table and engine token are under the instance data dir');

  console.log('fake vendors');
  const claude = spawnSync(join(inst.home, '.local', 'bin', 'claude'), ['--version'], { encoding: 'utf8' });
  const codex = spawnSync(join(inst.home, '.local', 'bin', 'codex'), ['--help'], { encoding: 'utf8' });
  ok(/fake/.test(claude.stdout) && /--dangerously-bypass-hook-trust/.test(codex.stdout), 'fake claude and codex are first on the instance\'s PATH, no model or login needed');
  const envPath = readFileSync(join(inst.dataDir, 'workbench.env'), 'utf8').split('\n').find((l) => l.startsWith('PATH='));
  ok(!!envPath && envPath.startsWith(`PATH=${join(inst.home, '.local', 'bin')}:`), 'the instance PATH puts ~/.local/bin first');
} finally {
  await inst.stop();
}

console.log('teardown');
ok(!existsSync(inst.home), 'the temp home is gone');
ok((await free(inst.port)) && (await free(inst.brokerPort)), 'both ports are free again');
eq(repoSnapshot(process.cwd()), before, 'the repo tree is byte-for-byte untouched (mtime and size of every file)');
ok(SCRATCH_ENGINE_SLOT === 500, 'slots are registered in the shared scratch table');

console.log('the reaper clears a LEAKED instance (and only that)');
{
  const { reapScratchBasic } = await import('../scripts/basic-scratch-reap.ts');
  const leaked = await startScratchBasic(); // never stopped by us: the reaper must find it
  const dry = reapScratchBasic({ dryRun: true });
  ok(dry.processes.some((p) => p.pid === leaked.enginePid) && dry.processes.every((p) => !p.killed), '--dry-run names the leaked engine and kills nothing');
  ok(existsSync(leaked.home), '...and keeps its home');
  const spared = reapScratchBasic({ minAgeSec: 3600 });
  ok(spared.processes.length === 0 && existsSync(leaked.home), 'a young instance is spared by --min-age-sec');
  const real = reapScratchBasic({ exceptPids: [process.pid] });
  ok(real.processes.some((p) => p.pid === leaked.enginePid && p.killed), 'the leaked engine is killed');
  for (let i = 0; i < 30 && existsSync(leaked.home); i++) await new Promise((r) => setTimeout(r, 100));
  ok(!existsSync(leaked.home) && (await free(leaked.port)) && (await free(leaked.brokerPort)), 'its home is removed and both ports are free');
  // our own child lingers as a zombie until reaped: a zombie is dead for this purpose
  let alive = true;
  try { process.kill(leaked.enginePid, 0); } catch { alive = false; }
  if (alive) { try { alive = !/^State:\s+Z/m.test(readFileSync(`/proc/${leaked.enginePid}/status`, 'utf8')); } catch { alive = false; } }
  ok(!alive, 'the process is gone');
  ok(reapScratchBasic({ dryRun: true }).processes.length === 0, 'a second sweep finds nothing');
}

console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
