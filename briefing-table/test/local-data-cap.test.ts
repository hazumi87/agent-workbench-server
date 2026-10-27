/** LOCAL ENGINE piece 2, pure parts: the memory cap's rules (src/engine/memory-cap.ts) and the data folder claim (src/engine/local-data.ts). */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryCapConfig, startMemoryCap, memoryCapFact, outsideLimitMb, EXIT_MEMORY_CAP, DEFAULT_CEILING_MB } from '../src/engine/memory-cap.ts';
import { claimDataDir, releaseDataDir, LOCK_NAME } from '../src/engine/local-data.ts';

let passed = 0;
let failed = 0;
function ok(c: boolean, m: string): void {
  if (c) {
    passed++;
    console.log(`  ok ${m}`);
  } else {
    failed++;
    console.log(`  FAIL ${m}`);
  }
}

ok(EXIT_MEMORY_CAP === 75, 'the cap exits with 75');
ok(DEFAULT_CEILING_MB === 1024 && outsideLimitMb(DEFAULT_CEILING_MB) === 1536, 'the default ceiling is 1024 MB (measured) and the outside limit 1.5 times that, 1536 MB');
ok(memoryCapConfig({})?.ceilingBytes === 1024 * 1048576, 'and it is what an unconfigured engine uses');
ok(memoryCapConfig({})?.ceilingBytes === DEFAULT_CEILING_MB * 1024 * 1024, 'the default ceiling applies when nothing is set');
ok(memoryCapConfig({ HARBOR_WB_MEMORY_CEILING_MB: '0' }) === null, '0 turns the cap off');
ok(memoryCapConfig({ HARBOR_WB_MEMORY_CEILING_MB: '-5' }) === null && memoryCapConfig({ HARBOR_WB_MEMORY_CEILING_MB: 'abc' }) === null, 'a bad ceiling turns it off rather than guessing');
ok(memoryCapConfig({ HARBOR_WB_MEMORY_CEILING_MB: '512' })?.ceilingBytes === 512 * 1048576, 'a set ceiling is honoured');
ok(memoryCapConfig({})?.intervalMs === 30000, 'the default check interval is 30 s');
ok(memoryCapConfig({ HARBOR_WB_MEMORY_CHECK_MS: '200' })?.intervalMs === 200, 'a set interval is honoured');
ok(memoryCapConfig({ HARBOR_WB_MEMORY_CHECK_MS: '5' })?.intervalMs === 30000, 'an absurdly small interval falls back to the default');

{
  let tick: () => void = () => {};
  let cleared = false;
  let rss = 100;
  const calls: Array<[number, number]> = [];
  const stop = startMemoryCap({ ceilingBytes: 1000, intervalMs: 10 }, {
    rss: () => rss,
    setInterval: (fn) => {
      tick = fn;
      return 'h';
    },
    clearInterval: () => {
      cleared = true;
    },
    onExceed: (r, c) => calls.push([r, c]),
  });
  tick();
  ok(calls.length === 0, 'under the ceiling: nothing happens');
  rss = 1000;
  tick();
  ok(calls.length === 0, 'exactly at the ceiling is not over it');
  rss = 1001;
  tick();
  ok(calls.length === 1 && calls[0][0] === 1001 && calls[0][1] === 1000, 'over the ceiling: onExceed once, with both numbers');
  tick();
  tick();
  ok(calls.length === 1, '...and never twice');
  stop();
  ok(cleared, 'stop clears the timer');
}
ok(/restarting to free memory/.test(memoryCapFact(2048 * 1048576, 1536 * 1048576)) && /2048 MB/.test(memoryCapFact(2048 * 1048576, 1536 * 1048576)) && /1536 MB/.test(memoryCapFact(2048 * 1048576, 1536 * 1048576)), 'the room line says what happened and the numbers');

const tmp = mkdtempSync(join(tmpdir(), 'wb-local-data-'));
try {
  const deps = (pid: number, alive: number[] = []) => ({ pid, alive: (p: number) => alive.includes(p), now: () => 1 });
  const d1 = join(tmp, 'a', 'b');
  const r1 = claimDataDir(d1, deps(100));
  ok(r1.ok && !r1.tookOverStale && existsSync(join(d1, LOCK_NAME)), 'a missing folder is created and locked');
  ok(JSON.parse(readFileSync(join(d1, LOCK_NAME), 'utf8')).pid === 100, 'the lock holds our pid');
  const r2 = claimDataDir(d1, deps(200, [100]));
  ok(!r2.ok && /pid 100/.test((r2 as { problem: string }).problem), 'a second engine is refused while the first is alive');
  const r3 = claimDataDir(d1, deps(200, []));
  ok(r3.ok && r3.tookOverStale, 'a lock whose process is gone is taken over');
  ok(JSON.parse(readFileSync(join(d1, LOCK_NAME), 'utf8')).pid === 200, '...and now holds the new pid');
  releaseDataDir(d1, 100);
  ok(existsSync(join(d1, LOCK_NAME)), 'release never removes another engine\'s lock');
  releaseDataDir(d1, 200);
  ok(!existsSync(join(d1, LOCK_NAME)), 'release removes our own');
  writeFileSync(join(tmp, 'garbage'), 'x');
  const d2 = join(tmp, 'c');
  mkdirSync(d2);
  writeFileSync(join(d2, LOCK_NAME), 'not json');
  const r4 = claimDataDir(d2, deps(300));
  ok(r4.ok && r4.tookOverStale, 'an unreadable lock is treated as stale');
  const r5 = claimDataDir(join(tmp, 'garbage', 'sub'), deps(400));
  ok(!r5.ok && /not writable/.test((r5 as { problem: string }).problem), 'a path that cannot be a folder is refused with a plain message');
  const r6 = claimDataDir(d2, deps(300, [300]));
  ok(r6.ok, 'our own pid in the lock is never a conflict');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
