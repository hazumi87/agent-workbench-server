/**
 * HELD LINES AND DRAFTS SURVIVE AN ENGINE RESTART (night test 2026-10-06).
 * The typer's queue and the draft parse lived only in memory: a restart dropped
 * every held line (already acked `delivered`, so the fabric replay skipped it)
 * and forgot every draft (so the next line was typed onto it). Two processes
 * share one temp table: phase A holds lines and exits like a SIGKILL; phase B
 * adopts the same pane and restores. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const phase = process.env.TYPER_RESTART_PHASE;
const P = 'recipe:restart#1'; // held behind a draft
const Q = 'recipe:restart#2'; // held behind a busy turn, box clean

if (!phase) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-typer-restart-'));
  const env = { ...process.env, HARBOR_WB_TABLE: join(dir, 'scratch.db'), HARBOR_WB_ROOM_TYPE_SETTLE_MS: '100', HARBOR_WB_VOICE_ENTER_MS: '10' };
  delete (env as Record<string, string | undefined>).HARBOR_WB_ROOM_TYPE;
  const self = fileURLToPath(import.meta.url);
  let failed = 0;
  for (const ph of ['A', 'B']) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', self], { env: { ...env, TYPER_RESTART_PHASE: ph }, encoding: 'utf8' });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.status !== 0) failed++;
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: EPERM */ }
  console.log(`\nPASS ${2 - failed} FAIL ${failed} (phases)`);
  process.exit(failed ? 1 : 0);
}

const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const { table } = await import('../src/table/endpoint.ts');
let passed = 0;
let failed = 0;
const eq = (a: unknown, b: unknown, msg: string): void => {
  if (Object.is(a, b)) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.log(`  ✗ ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
activity.setOnChange((p, s) => typer.onActivity(p, s));
typer.setLog(() => {});
function pane(paneid: string, vendor = 'claude-code'): string[] {
  if (!table.get(paneid)) table.upsert({ paneid, recipe_id: null, server: 'local', vendor, agent: null, session_id: null, state: 'live' } as never);
  const writes: string[] = [];
  sessions.add(paneid, { state: 'live', pty: { write: (d: string) => writes.push(d) } } as never, null as never);
  activity.onLive(paneid);
  return writes;
}

if (phase === 'A') {
  console.log('\n[phase A: hold, then die]');
  const w = pane(P);
  activity.onInput(P, 'half a thought'); // a human's unsent draft
  eq(typer.enqueue(P, 'r1', 1, 'Alpha', 'user', 'one'), 'queued', 'a draft holds the first line');
  eq(typer.enqueue(P, 'r1', 2, 'Alpha', 'user', 'two'), 'queued', '...and the second');
  const wq = pane(Q);
  eq(typer.enqueue(Q, 'r1', 3, 'Alpha', 'user', 'three'), 'injected', 'a clean idle box takes the first line');
  activity.onTurnStart(Q);
  eq(typer.enqueue(Q, 'r1', 4, 'Alpha', 'user', 'four'), 'queued', 'the next waits for that turn (awaiting idle)');
  await sleep(50);
  eq(w.length, 0, 'nothing typed onto the draft');
  eq(table.getTyperState(P)?.draft, 1, 'the draft flag is on disk');
  eq(JSON.parse(table.getTyperState(P)?.items ?? '[]').length, 2, 'both held lines are on disk');
  process.exit(failed ? 1 : 0); // no cleanup: like a SIGKILL
}

if (phase === 'B') {
  console.log('\n[phase B: a new engine adopts the same panes]');
  typer.sweepPersisted((id) => table.get(id)?.state === 'live');
  const w = pane(P);
  eq(typer.restorePane(P), 2, 'two lines restored for the draft pane');
  await sleep(250);
  eq(w.length, 0, 'still held: the box was last seen holding a draft');
  eq(activity.draftState(P), 'draft', 'the draft is back (unknown)');
  activity.onInput(P, '\r'); // the human submits their text...
  await sleep(300);
  eq(w.length, 0, 'the clear box alone does not release it: that submit started a turn');
  activity.onTurnStart(P);
  activity.onResponseDone(P); // ...whose turn then ends
  await sleep(400);
  eq(w[0]?.includes('one'), true, 'once the box is clear AND the turn is over, the first held line is typed');
  const wq = pane(Q);
  eq(typer.restorePane(Q), 1, 'the busy pane gets its line back');
  await sleep(400);
  eq(wq.length, 0, '...but not typed at once: the turn it was in is invisible after a restart');
  activity.onTurnStart(Q);
  activity.onResponseDone(Q); // that turn ends: a real idle transition
  await sleep(400);
  eq(wq[0]?.includes('four'), true, '...typed once the pane goes idle (its box was clean)');
  eq(typer.restorePane(Q), 0, 'restoring twice changes nothing');
  table.upsert({ paneid: 'recipe:gone#1', recipe_id: null, server: 'local', vendor: 'claude-code', agent: null, session_id: null, state: 'killed' } as never);
  table.setTyperItems('recipe:gone#1', JSON.stringify([{ roomId: 'r', entryId: 9, text: 'x' }]));
  typer.sweepPersisted((id) => table.get(id)?.state === 'live');
  eq(table.getTyperState('recipe:gone#1'), undefined, 'a dead pane\'s persisted lines are swept at boot');
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}
