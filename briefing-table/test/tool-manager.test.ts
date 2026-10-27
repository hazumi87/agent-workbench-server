/**
 * THE TOOL MANAGER [tool-manager]: pinned scripts gate every run, stop sticks until a reboot, the monitor restarts only a tool that is
 * CERTAINLY down, backoff ends in `failed`. A temp table + tools dir, a fake runner (no script really runs). Run with tsx.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'wb-toolmgr-'));
const toolsDir = join(dir, 'tools');
mkdirSync(toolsDir, { recursive: true });
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_TOOLS_DIR = toolsDir;
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_NODE = 'homebase';

const { table } = await import('../src/table/endpoint.ts');
const apps = await import('../src/engine/apps.ts');
const tm = await import('../src/engine/tool-manager.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
}
const eq = (a: unknown, b: unknown, msg: string): void => ok(JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b) ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const refused = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

tm.setLog(() => {});
apps.setLog(() => {});
const calls: string[] = [];
let exitCode = 0;
tm.setRunner(async (script) => {
  calls.push(script.split('/').slice(-2).join('/'));
  return { code: exitCode, out: exitCode ? 'boom' : 'started' };
});
let boot = 'boot-1';
tm.setBootId(() => boot);

function writeTool(slug: string, extra: Record<string, unknown> = {}): string {
  const root = join(toolsDir, slug);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const f of ['start.sh', 'stop.sh']) {
    writeFileSync(join(root, 'scripts', f), `#!/bin/bash\necho ${f}\n`);
    chmodSync(join(root, 'scripts', f), 0o755);
  }
  writeFileSync(join(root, 'tool.json'), JSON.stringify({
    contract: 'tool/draft-0', name: slug, slug, version: '0.1.0', description: slug, access: 'shared',
    lifecycle: { entry: 'scripts/start.sh', stop: 'scripts/stop.sh' },
    endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
    panels: [{ title: slug, icon: 'image', view: 'GET /rooms/:roomId/view' }],
    ...extra,
  }, null, 2));
  return root;
}

try {
  eq(tm.monitorSettings().intervalSec, 60, 'the monitor period defaults to 60 s');
  ok((await refused(async () => tm.setMonitorSettings({ intervalSec: 5 }))).includes('15 to 3600'), 'a period under 15 s is refused');
  ok((await refused(async () => tm.setMonitorSettings({ intervalSec: 'x' }))).includes('whole seconds'), 'a non-number period is refused');
  eq(tm.setMonitorSettings({ intervalSec: 120 }).intervalSec, 120, 'a valid period is saved');
  eq(tm.monitorSettings().intervalSec, 120, 'and read back');
  tm.setMonitorSettings({ intervalSec: 60 });
  const auto = writeTool('auto-tool', { autostart: true });
  writeTool('manual-tool');
  for (const s of ['auto-tool', 'manual-tool']) apps.registerApp(join(toolsDir, s), 'user');

  /* 1. nothing runs until a PERSON pins the scripts */
  ok((await refused(() => tm.manage('auto-tool', 'start', 'agent-a', null))).includes('scripts-unpinned'), 'start refused while scripts are unpinned');
  eq(calls.length, 0, 'no script ran');
  await tm.tick();
  eq(calls.length, 0, 'the monitor runs nothing for an unpinned tool either');
  ok((await refused(() => tm.manage('nope', 'start', 'a', null))).includes('no such app'), 'unknown app refused');

  /* 2. pinned: start runs the entry script and records intent */
  tm.pinScripts('auto-tool', 'user');
  tm.pinScripts('manual-tool', 'user');
  let r = await tm.manage('auto-tool', 'start', 'agent-a', 'because');
  ok(r.ok && r.intent === 'up', 'start runs and records intent up');
  eq(calls, ['scripts/start.sh'], 'it ran the pinned entry script');
  eq(table.getToolManage('auto-tool')?.intent_by, 'agent-a', 'who asked is recorded');

  /* 3. stop sticks: the monitor leaves a stopped autostart tool alone */
  calls.length = 0;
  r = await tm.manage('auto-tool', 'stop', 'agent-a', null);
  ok(r.ok && r.intent === 'down', 'stop records intent down');
  eq(calls, ['scripts/stop.sh'], 'it ran the stop script');
  calls.length = 0;
  await tm.tick(Date.now() + 1);
  eq(calls.length, 0, 'the monitor does not restart a deliberately stopped tool (autostart true)');

  /* 4. an engine restart (same boot) keeps it down; a reboot lets the manifest win */
  eq((await tm.statusOf('auto-tool')).intent, 'down', 'same boot id: still down');
  boot = 'boot-2';
  eq((await tm.statusOf('auto-tool')).intent, 'up', 'new boot id: autostart wins, it comes back');
  eq((await tm.statusOf('manual-tool')).intent, 'none', 'a tool with no autostart and no intent is left alone');

  /* 5. the monitor starts a certainly-down tool; leaves a non-autostart one */
  calls.length = 0;
  await tm.tick(Date.now() + 1);
  eq(calls, ['scripts/start.sh'], 'after a reboot the monitor starts the autostart tool (and only it)');

  /* 6. backoff, then failed */
  tm.resetForTest();
  exitCode = 1;
  calls.length = 0;
  let t = Date.now();
  for (let i = 0; i < 8; i++) {
    t += 6 * 60_000;
    await tm.tick(t);
  }
  eq(calls.length, 5, 'five failed starts, then it stops trying');
  ok((await tm.statusOf('auto-tool')).failed, 'it is marked failed');
  exitCode = 0;
  calls.length = 0;
  r = await tm.manage('auto-tool', 'start', 'agent-b', null);
  ok(r.ok && !(await tm.statusOf('auto-tool')).failed, 'a person/agent start clears failed');

  /* 7. never touch what cannot be told: running, or unknown */
  tm.resetForTest();
  calls.length = 0;
  const srv = createServer((q, s) => s.end('{"ok":true}'));
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
  const port = (srv.address() as { port: number }).port;
  mkdirSync(join(auto, 'status'), { recursive: true });
  const cwd0 = process.cwd();
  process.chdir(auto);
  writeFileSync(join(auto, 'status', 'app.json'), JSON.stringify({ port, pid: process.pid }));
  eq((await apps.getCatalogEntry('auto-tool'))?.status, 'running', '(fixture) the app reads as running');
  await tm.tick(Date.now() + 1);
  eq(calls.length, 0, 'a running tool is not restarted');
  writeFileSync(join(auto, 'status', 'app.json'), JSON.stringify({ port: 80, pid: process.pid }));
  eq((await apps.getCatalogEntry('auto-tool'))?.status, 'unknown', '(fixture) an unverifiable endpoint reads as unknown');
  await tm.tick(Date.now() + 1);
  eq(calls.length, 0, 'an unknown tool is not touched');
  process.chdir(cwd0);
  srv.close();

  /* 8. scripts changed after the pin: nothing runs, monitor included */
  writeFileSync(join(auto, 'scripts', 'start.sh'), '#!/bin/bash\necho tampered\n');
  ok((await refused(() => tm.manage('auto-tool', 'start', 'a', null))).includes('scripts-changed'), 'a changed script is refused');
  eq((await tm.statusOf('auto-tool')).scripts, 'changed', 'status says so');
  tm.resetForTest();
  calls.length = 0;
  await tm.tick(Date.now() + 10 * 60_000);
  eq(calls.length, 0, 'the monitor will not run a changed script');
  tm.pinScripts('auto-tool', 'user');
  ok((await tm.manage('auto-tool', 'start', 'a', null)).ok, 'a person re-pinning allows it again');

  /* 9. a symlinked script is refused */
  const root3 = writeTool('link-tool');
  rmSync(join(root3, 'scripts', 'start.sh'));
  symlinkSync(join(auto, 'scripts', 'stop.sh'), join(root3, 'scripts', 'start.sh'));
  apps.registerApp(root3, 'user');
  ok((await refused(async () => tm.pinScripts('link-tool', 'user'))).includes('not a plain file'), 'a symlinked lifecycle script cannot be pinned');

  /* 10. restart = stop then start; a stop that fails does not start */
  calls.length = 0;
  r = await tm.manage('manual-tool', 'restart', 'a', null);
  eq(calls, ['scripts/stop.sh', 'scripts/start.sh'], 'restart runs stop then start');
  calls.length = 0;
  exitCode = 1;
  r = await tm.manage('manual-tool', 'restart', 'a', null);
  ok(!r.ok && calls.length === 1, 'a failed stop does not go on to start');
  exitCode = 0;
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error)?.stack ?? e}`);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the store still holds the db */
  }
}

console.log(`${String.fromCharCode(10)}PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
