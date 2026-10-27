/**
 * THE ROOM RULES RUN THE SAME ON A LOCAL ENGINE (lead order 15713, step 5): reply addressing and the "line reached no one" notice, floor
 * per thread and /floor, per-room turn time, /seat restart and its refusals, the fabric turn lines. The route suites that already prove these
 * on the server engine are re-run here with their ENGINE started in local mode (WB_TEST_LOCAL_MODE=1 makes test/_scratch.mjs childEnv add
 * HARBOR_WB_MODE=local, a data folder and a files folder to the spawn that sets a port and a token). Each must end `PASS n FAIL 0`.
 *
 * Not included on purpose: rooms-routes.test.mjs (it runs its engine with accounts, which local mode refuses). A seat surviving an engine
 * restart through the broker is local-mode-restart.test.mjs. One difference is by design: /set store is refused in local mode (the files
 * folder is the store); seat-restart-routes.test.mjs asserts that variant when WB_TEST_LOCAL_MODE is set.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from './_scratch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/* reply-turns-fabric runs here TURNED AROUND: in local mode it asserts the engine sends the stub fabric nothing (E6, src/engine/
 * local-guard.ts). In server mode the same file proves the send. */
const SUITES = ['reply-routing', 'reply-turns-routes', 'seat-restart-routes', 'reply-turns-fabric'];
let passed = 0;
let failed = 0;
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`  ok ${m}`);
  } else {
    failed++;
    console.log(`  FAIL ${m}`);
  }
};

/* the switch really changes the engine's environment, and only the engine's */
process.env.WB_TEST_LOCAL_MODE = '1';
const engineEnv = childEnv({ HARBOR_WB_PORT: '1234', HARBOR_WB_TOKEN: 't' });
const helperEnv = childEnv({ HARBOR_WB_TABLE: '/x' });
ok(engineEnv.HARBOR_WB_MODE === 'local' && !!engineEnv.HARBOR_WB_DATA_DIR && !!engineEnv.HARBOR_WB_FILES_DIR, 'with the switch, the engine spawn gets local mode, a data folder and a files folder');
ok(helperEnv.HARBOR_WB_MODE === undefined, '...and a helper spawn (no port, no token) is left alone');
const second = childEnv({ HARBOR_WB_PORT: '1235', HARBOR_WB_TOKEN: 't' });
ok(second.HARBOR_WB_DATA_DIR !== engineEnv.HARBOR_WB_DATA_DIR, 'every engine gets its own data folder (the lock would refuse a shared one)');
delete process.env.WB_TEST_LOCAL_MODE;
ok(childEnv({ HARBOR_WB_PORT: '1234', HARBOR_WB_TOKEN: 't' }).HARBOR_WB_MODE === undefined, 'without the switch nothing changes');

for (const name of SUITES) {
  const result = await new Promise((resolve) => {
    const p = spawn(process.execPath, [join(here, `${name}.test.mjs`)], { env: { ...process.env, WB_TEST_LOCAL_MODE: '1' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, out }));
  });
  const m = /PASS (\d+)\s+FAIL (\d+)/.exec(result.out);
  ok(result.code === 0 && m && Number(m[1]) > 0 && Number(m[2]) === 0, `${name}, engine in local mode: ${m ? `PASS ${m[1]} FAIL ${m[2]}` : 'no summary'}${result.code === 0 ? '' : ` (exit ${result.code})`}`);
  if (result.code !== 0) {
    console.log(result.out.split('\n').slice(-12).join('\n'));
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
