/**
 * THE BOOT SWEEP — what a stale `live` row becomes, and whose rule decides it.
 *
 * At startup the engine owns zero sessions, so every row still marked `live` is
 * a lie from a previous run. What it becomes is the single most expensive
 * one-line decision in the table: `dehydrated` offers a Restore that reopens a
 * conversation, `killed` is refused by the attach path's auto-resume forever.
 *
 * This existed as TWO copies of one rule — the SQL here said
 * `vendor='claude-code'` in so many words, while `end-state.ts` asked the
 * claude module — and the contract recorded the pair as the hazard waiting for
 * whoever added vendor #2 (§1.1: "Both must learn the new value, or a stale row
 * reconciles to `killed` and a restorable conversation is lost"). The list now
 * comes from the vendor modules' own `resumable` flags. These assertions are
 * what makes that true rather than intended.
 *
 * SAFETY: a temp db via HARBOR_WB_TABLE, set BEFORE the store is imported (it
 * reads the path at module load). The real data/mapping.db is never opened.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-reconcile-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');

const store = await import('../src/table/store.ts');
const { resumableVendors, isResumableVendor } = await import('../src/engine/vendors/index.ts');

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed += 1;
    console.log(`  ✓ ${msg} (${String(actual)})`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}
function ok(cond: unknown, msg: string): void {
  eq(!!cond, true, msg);
}

/** Put a row in the table as a live session of `vendor`. */
function live(paneid: string, vendor: string): void {
  store.upsert({
    paneid,
    recipe_id: null,
    server: 'local',
    vendor,
    agent: `${paneid}-agent`,
    session_id: `sid-${paneid}`,
    state: 'live',
  });
}
const stateOf = (paneid: string): string | undefined => (store.get(paneid) as { state?: string } | undefined)?.state;

console.log('\n[a stale live row is filed by its VENDOR, not by a literal]');
live('p-claude', 'claude-code');
live('p-gemini', 'gemini-cli');
live('p-shell', 'cli-manager');
live('p-codex', 'codex-cli');
live('p-ollama', 'ollama');
live('p-blank', '');

const first = store.reconcileStaleLive();
eq(stateOf('p-claude'), 'dehydrated', 'claude-code: the conversation is on disk, so it can come back');
eq(stateOf('p-gemini'), 'dehydrated', 'gemini-cli: VENDOR #2 dehydrates too — the SQL learned it for free');
eq(stateOf('p-shell'), 'killed', 'cli-manager: a bare shell died with its engine');
eq(stateOf('p-codex'), 'dehydrated', 'codex-cli: VENDOR #3 dehydrates too (its conversation resumes by id)');
eq(
  stateOf('p-ollama'),
  'killed',
  'ollama: an accepted VALUE with no module is class 2, and a Restore button would not work',
);
eq(stateOf('p-blank'), 'killed', 'a row with no vendor recorded is not faked as restorable');
eq(first.dehydrated, 3, 'three rows dehydrated');
eq(first.killed, 3, 'three rows killed');

console.log('\n[the SQL and the code answer the same question]');
for (const v of ['claude-code', 'gemini-cli', 'cli-manager', 'codex-cli', 'ollama', '']) {
  live(`rt-${v || 'blank'}`, v);
}
store.reconcileStaleLive();
for (const v of ['claude-code', 'gemini-cli', 'cli-manager', 'codex-cli', 'ollama', '']) {
  eq(
    stateOf(`rt-${v || 'blank'}`),
    isResumableVendor(v) ? 'dehydrated' : 'killed',
    `"${v || '(blank)'}": the sweep agrees with isResumableVendor`,
  );
}
ok(
  resumableVendors().length >= 2,
  'and the list the sweep uses is not empty (an empty one would kill everything, silently)',
);

console.log('\n[a row the BROKER still holds is not stale at all]');
live('p-held', 'claude-code');
live('p-gone', 'claude-code');
const second = store.reconcileStaleLive(['p-held']);
eq(stateOf('p-held'), 'live', 'an excluded pane keeps its state — it outlived the engine and gets adopted');
eq(stateOf('p-gone'), 'dehydrated', 'its neighbour is still swept');
eq(second.dehydrated, 1, 'only the unheld row was counted');

console.log('\n[every swept row is stamped interrupted, for the restore offer]');
live('p-int', 'cli-manager');
store.reconcileStaleLive();
eq((store.get('p-int') as { interrupted?: number }).interrupted, 1, 'stamped BEFORE the state flipped');
eq(
  typeof (store.get('p-int') as { interrupted_at?: number }).interrupted_at,
  'number',
  'and DATED - an undateable stamp is one that can never expire',
);

console.log('\n[ONE BATCH PER BOOT, NEVER ACCUMULATED - the 2026-09-17 defect]');
/* Owner hit a restore offer listing day-old dead sessions: nothing ever expired
   a stamp, so eight restarts in a day left eight boots' worth of rows stamped.
   A boot that sweeps something now OWNS the offer outright. */
const stampOf = (paneid: string): { interrupted?: number; interrupted_at?: number } =>
  store.get(paneid) as { interrupted?: number; interrupted_at?: number };
live('b1-a', 'claude-code');
live('b1-b', 'claude-code');
store.reconcileStaleLive();
const batch1 = stampOf('b1-a').interrupted_at!;
eq(stampOf('b1-a').interrupted_at, stampOf('b1-b').interrupted_at, 'every row of ONE boot shares ONE timestamp');

live('b2-a', 'claude-code');
store.reconcileStaleLive();
eq(stampOf('b2-a').interrupted, 1, 'the next boot stamps what IT lost');
eq(stampOf('b1-a').interrupted, 0, 'and the previous batch is CLEARED, not added to');
eq(stampOf('b1-a').interrupted_at, null, '...date and all, so nothing reads as a batch any more');
ok(stampOf('b2-a').interrupted_at! >= batch1, 'the surviving batch is the newer one');

console.log('\n[an EMPTY sweep is not news, and must not destroy the last real news]');
/* Restart the engine twice in a row and the second boot finds nothing live -
   the first already swept it. Clearing unconditionally there would delete an
   offer the user has not seen yet. Age is the manager's cut instead. */
const before = stampOf('b2-a').interrupted_at;
store.reconcileStaleLive();
eq(stampOf('b2-a').interrupted, 1, 'a boot with nothing to sweep leaves the standing offer alone');
eq(stampOf('b2-a').interrupted_at, before, '...unchanged, so its AGE keeps running');

console.log('\n[a spawn consumes the stamp AND its date - the session is back]');
live('b2-a', 'claude-code');
eq(stampOf('b2-a').interrupted, 0, 'flag cleared');
eq(stampOf('b2-a').interrupted_at, null, 'date cleared - a dated row with the flag off still reads as a batch');

console.log('\n[dismiss clears the pair]');
live('dis-a', 'claude-code');
store.reconcileStaleLive();
eq(stampOf('dis-a').interrupted, 1, 'stamped');
store.clearInterrupted();
eq(stampOf('dis-a').interrupted, 0, 'dismissed');
eq(stampOf('dis-a').interrupted_at, null, '...date too');

console.log('\n[a row the broker HOLDS is not stamped - nothing was lost]');
live('held-a', 'claude-code');
live('lost-a', 'claude-code');
store.reconcileStaleLive(['held-a']);
eq(stampOf('held-a').interrupted, 0, 'the adopted pane is not in the batch');
eq(stampOf('lost-a').interrupted, 1, 'its neighbour is');


console.log('\n[recipe slug backfill: fill the empty, reconcile the machine\'s OLD default, leave a human\'s typing alone]');
/* Deliberately decoupled from src/engine/agent-slug.ts — the store does not
   know how a slug is made (both derivers are passed IN, same as production),
   so this exercises the mechanism generically: a bare "new" rule and an "old"
   rule that used to suffix a role, standing in for the real 2026-09-17 change. */
const deriveNew = (r: { projectDir: string | null }): string | null =>
  r.projectDir ? r.projectDir.split('/').pop()! : null;
const deriveOld = (r: { projectDir: string | null }): string | null => {
  const base = deriveNew(r);
  return base ? `${base}-cli` : null;
};
function mkRecipe(id: string, projectDir: string, agent: string | null): void {
  store.upsertRecipe({
    id,
    name: id,
    target: 'local',
    projectDir,
    agent,
    model: null,
    resume: 0,
    resumeName: null,
    initCmd: null,
    closeOnCleanExit: 0,
    statusPath: null,
    color: null,
    fg: null,
    bg: null,
    watermark: null,
    fontSize: null,
    logo: null,
  });
}
mkRecipe('r-empty', '/srv/code/empty', null);
mkRecipe('r-old-default', '/srv/code/olddef', 'olddef-cli');
mkRecipe('r-human', '/srv/code/human', 'totally-different-name');
mkRecipe('r-already-new', '/srv/code/already', 'already');
mkRecipe('r-coincidence', '/srv/code/coincidence', 'coincidence-cli-typed-by-hand');

const backfilled = store.backfillRecipeAgents(deriveNew, deriveOld);
const byId = new Map(backfilled.map((d) => [d.id, d]));

eq(store.getRecipe('r-empty')!.agent, 'empty', 'an empty slug is filled with the NEW default');
ok(byId.has('r-empty') && !byId.get('r-empty')!.renamedFrom, '...recorded as derived, not a rename');

eq(store.getRecipe('r-old-default')!.agent, 'olddef', 'a slug matching the OLD default is reconciled to the new one');
eq(byId.get('r-old-default')!.renamedFrom, 'olddef-cli', '...and the rename records what it moved FROM');

eq(store.getRecipe('r-human')!.agent, 'totally-different-name', 'a slug that matches neither derivation is a human\'s choice — untouched');
ok(!byId.has('r-human'), '...and not reported as backfilled at all');

eq(store.getRecipe('r-already-new')!.agent, 'already', 'a slug already equal to the new default is left as-is');
ok(!byId.has('r-already-new'), '...(it does not match the OLD form, so it was never a rename candidate)');

eq(
  store.getRecipe('r-coincidence')!.agent,
  'coincidence-cli-typed-by-hand',
  'a slug that happens to start with the old default is NOT an exact match — left alone, per the safety rule',
);
ok(!byId.has('r-coincidence'), '...indistinguishable from a deliberate choice, and treated as one');

/* Idempotent: running it again touches nothing, because every slug now equals
   its own new default. */
const second2 = store.backfillRecipeAgents(deriveNew, deriveOld);
eq(second2.length, 0, 'a second pass is silent — nothing left to reconcile');

/* wasOldDefault is OPTIONAL: omitting it keeps the pre-existing behaviour
   (fill empties only, never touch a populated slug), which is what every
   OTHER caller of this function relies on. */
mkRecipe('r-legacy-caller', '/srv/code/legacy', 'legacy-cli');
const legacyCall = store.backfillRecipeAgents(deriveNew);
ok(
  !legacyCall.some((d) => d.id === 'r-legacy-caller'),
  'without a wasOldDefault deriver, a populated slug is never reconciled',
);

/* The store holds the handle for the life of the process (there is no close
   verb, by design — one opener, Seam C2), so Windows refuses to unlink the file
   while we are still running. Best-effort: the OS temp dir is the right place
   to leave a few KB, and FAILING THE RUN over cleanup would be the tail wagging
   the dog. */
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* held open by better-sqlite3 until exit */
}

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
