/**
 * A restore whose conversation was never written starts fresh (Owner 2026-10-13, Kiosk: the launch ended at the folder
 * trust prompt, the banked id had no transcript, and Restore kept answering "No session found").
 * Run with tsx.
 */
import { neverWritten } from '../src/engine/restore-fresh.ts';
import { transcriptPath } from '../src/engine/vendors/claude-code.ts';
import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}
const base = { transcriptPath, cwd: '/srv/worktrees/kiosk/kiosk', sessionId: 'b9f72d1f-d697-4daf-9f7c-bc052dbaf243' };

ok(neverWritten({ ...base, access: 'local', exists: () => false }) === true, 'local disk, the exact transcript is absent: start fresh');
ok(neverWritten({ ...base, access: 'local', exists: () => true }) === false, 'local disk, the transcript is there: resume it');
ok(neverWritten({ ...base, access: 'ssh', exists: () => false }) === false, 'an ssh read that found nothing may be unreachable: keep the banked id');
ok(neverWritten({ ...base, access: 'agent', exists: () => false }) === false, 'an agent read that found nothing may be unreachable: keep the banked id');
ok(neverWritten({ ...base, access: 'unreachable', exists: () => false }) === false, 'unreachable: keep the banked id');
ok(neverWritten({ ...base, access: 'local', transcriptPath: undefined, exists: () => false }) === false, 'a vendor with no local transcript path: keep the banked id');
ok(neverWritten({ ...base, access: 'local', cwd: null, exists: () => false }) === false, 'no project dir: cannot tell, keep the banked id');
ok(neverWritten({ ...base, access: 'local', exists: () => { throw new Error('EIO'); } }) === false, 'a read that throws is "could not tell": keep the banked id');
const p = transcriptPath(base.cwd, base.sessionId);
ok(p.endsWith('/-srv-worktrees-kiosk-kiosk/b9f72d1f-d697-4daf-9f7c-bc052dbaf243.jsonl'), `the path asked about is the one claude resumes (${p.split('/').slice(-2).join('/')})`);

const src = readFileSync(new URL('../src/server/index.ts', import.meta.url), 'utf8');
ok(src.includes('neverWritten({ access: access.mode'), 'the restore path asks it only after locate found nothing, with the access mode');
ok(src.includes('restoreId = null;') && src.includes('starting fresh'), 'and a never-written answer clears the banked id so the launch is fresh');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
