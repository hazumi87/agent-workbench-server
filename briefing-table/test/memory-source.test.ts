/** Item 3 wiring, pure half: the engine keeps the supervisor's last memory report and calls it unknown when it is stale or malformed. */
import { MemorySource, parseReport, MEMORY_STALE_MS } from '../src/engine/memory-source.ts';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const GB = 1024 ** 3;

ok(parseReport({ usedBytes: 1 * GB, freeBytes: 8 * GB, jobCapBytes: 2 * GB })?.jobCapBytes === 2 * GB, 'a good report parses');
ok(parseReport({ usedBytes: 5, residentBytes: 3, freeBytes: 2 })?.residentBytes === 3, 'residentBytes is carried when given');
ok(parseReport({ usedBytes: 5, residentBytes: 'x', freeBytes: 2 }) === null, 'a bad residentBytes is refused');
ok(parseReport({ usedBytes: 1, freeBytes: 2 })?.jobCapBytes === null, 'no job cap is null (the PC alone sets the budget)');
for (const bad of [null, 'x', [], {}, { usedBytes: -1, freeBytes: 1 }, { usedBytes: 1, freeBytes: 'a' }, { usedBytes: 1, freeBytes: 1, jobCapBytes: 'x' }, { usedBytes: NaN, freeBytes: 1 }, { usedBytes: 1e18, freeBytes: 1 }]) {
  ok(parseReport(bad) === null, `a malformed report is refused: ${JSON.stringify(bad)}`);
}

const src = new MemorySource();
ok(src.current(1000) === null, 'before any report: unknown');
src.report({ usedBytes: 1, freeBytes: 2, jobCapBytes: null }, 1000);
ok(src.current(1000 + MEMORY_STALE_MS - 1)?.usedBytes === 1, 'a fresh report is used');
ok(src.current(1000 + MEMORY_STALE_MS + 1) === null, 'a stale report is unknown, never trusted: a supervisor that died must not leave the engine thinking there is room');
src.report({ usedBytes: 5, freeBytes: 2, jobCapBytes: null }, 5000);
ok(src.current(5001)?.usedBytes === 5, 'the latest report wins');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
