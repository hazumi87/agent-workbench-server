/**
 * Runs the connector's portable extractor spec (test/vendor-spec/history-extract.spec.mjs, node:test, pinned with
 * scripts/vendor/history-extract.mjs, connector b6741b2) and reports it in the runner's `PASS n FAIL m` form: the
 * spec's own node:test/TAP output carries no such line, so the runner counted it as "NO SUMMARY".
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath, ['--test', join('test', 'vendor-spec', 'history-extract.spec.mjs')], { cwd: root, encoding: 'utf8' });
const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? NaN);
const pass = n('pass');
const fail = n('fail');
if (!Number.isFinite(pass) || !Number.isFinite(fail)) {
  console.log('could not read node:test totals:\n' + r.stdout.slice(-800) + r.stderr.slice(-400));
  console.log('PASS 0 FAIL 1');
  process.exit(1);
}
if (fail || r.status !== 0) console.log(r.stdout.slice(-1500));
console.log(`PASS ${pass} FAIL ${fail}`);
process.exit(fail || r.status !== 0 ? 1 : 0);
