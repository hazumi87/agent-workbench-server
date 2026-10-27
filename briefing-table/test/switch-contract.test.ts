/**
 * The engine's structural copy of the connector's Basic switch contract (rev 2) passes the connector's PORTABLE
 * fixtures: same vectors, same verdicts. If this fails after a re-copy, the two sides have drifted.
 */
import { readFileSync } from 'node:fs';
import { checkContextAcceptance, BASIC_SWITCH_CONTRACT_VERSION } from '../src/engine/switch/contract.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/basic-switch-context.json', import.meta.url), 'utf8'));
let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

let n = 0;
const ok = (c: unknown, m: string) => { checks++; n++; if (!c) { failed++; console.log(`  FAIL ${m}`); } };

ok(fixture.version === BASIC_SWITCH_CONTRACT_VERSION, `fixture version ${fixture.version} matches the contract copy (${BASIC_SWITCH_CONTRACT_VERSION})`);
for (const v of fixture.cases) {
  const r: any = checkContextAcceptance(v.expected ?? fixture.expected, v.evidence);
  ok(r.accepted === v.accepted, `${v.name}: accepted=${v.accepted}`);
  if (!v.accepted) ok(r.reason === v.reason, `${v.name}: reason=${v.reason} (got ${r.reason})`);
}
console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
