/**
 * SPAWN GUARD (src/engine/spawn-guard.ts; the design notes §4.4 item 7,
 * §8 "Choke point") [ticket].
 *
 * Pure units with injected dependencies — no table, no broker, no /proc:
 *   - the mutex: two concurrent attaches run one after the other (the second
 *     re-enters from the top), a throw releases it;
 *   - it refuses on a collision and proceeds on `null` (could not tell), and
 *     never asks the classifier about a pane that is not on this host;
 *   - an orphan naming the OLD id while locate returned the new one → refused;
 *   - a cross-pane live row → refused; an id in resumingIds (another pane) →
 *     refused, this pane's own → not, an expired or cleared one → not;
 *   - a just-ended S-state collider that exits at +3 s → one wait, no refusal;
 *     a `T` collider → immediate refusal, no wait;
 *   - each of the three refusal texts is selected by who owns the pid;
 *   - collisionGuard `warn` logs and proceeds, with no wait;
 *   - a check that throws proceeds (could not tell).
 * The engine wiring (two concurrent attaches → exactly one spawn) is in
 * test/voice.test.mjs's real scratch-broker harness.
 *
 * Run with tsx.
 */
const sg = await import('../src/engine/spawn-guard.ts');
type Classification = import('../src/engine/proc-classifier.ts').Classification;
type ProcHit = import('../src/engine/proc-classifier.ts').ProcHit;

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PANE = 'recipe:r1#a';
const OTHER = 'recipe:r1#b';
const OLD = '11111111-0000-4000-8000-000000000001';
const NEW = '11111111-0000-4000-8000-000000000002';

const hit = (pid: number, over: Partial<ProcHit> = {}): ProcHit => ({
  pid,
  comm: 'claude',
  state: 'S',
  starttime: pid * 10,
  paneid: null,
  startedAt: 1_000,
  lstart: 'Fri Sep 25 14:03:12 2026',
  ...over,
});
const cls = (collisions: ProcHit[]): Classification => ({ claude: [], collisions, suspended: [], background: [], leftovers: [] });

/** A fake world: a clock that sleep() advances, a classifier answering from
 *  `procs` (filtered by the ids it was asked about, as the real one does). */
function world(opts: { live?: Array<{ paneid: string; session_id: string | null }>; mode?: string } = {}) {
  let t = 100_000;
  const logs: string[] = [];
  const asked: Array<{ ids: string[] }> = [];
  const w = {
    procs: [] as Array<ProcHit & { names?: string[] }>,
    classifyNull: false,
    classifyThrows: false,
    live: opts.live ?? [],
    mode: opts.mode ?? 'enforce',
    exitAt: null as number | null, // the collider disappears at this clock time
    logs,
    asked,
    now: () => t,
    advance: (ms: number) => (t += ms),
    deps: null as unknown as import('../src/engine/spawn-guard.ts').GuardDeps,
  };
  w.deps = {
    liveRows: () => w.live,
    classify: (q) => {
      asked.push({ ids: q.ids });
      if (w.classifyThrows) throw new Error('proc exploded');
      if (w.classifyNull) return null;
      const alive = w.procs.filter(() => w.exitAt === null || t < w.exitAt);
      return cls(alive.filter((p) => p.paneid === q.paneid || (p.names ?? []).some((n) => q.ids.includes(n))));
    },
    labelOf: (p) => (p === PANE ? '@alpha' : p === OTHER ? 'Alpha 2' : p),
    mode: () => w.mode,
    log: (l) => logs.push(l),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return w;
}
const inp = (over: Partial<import('../src/engine/spawn-guard.ts').CheckInput> = {}) => ({ paneid: PANE, ids: [OLD, NEW], local: true, ...over });

console.log('\n[mutex: one attach per paneid at a time]');
{
  sg.reset();
  const order: string[] = [];
  const a = sg.serialize(PANE, async () => {
    order.push('a:start');
    await sleep(60);
    order.push('a:end');
    return 'A';
  });
  const b = sg.serialize(PANE, async () => {
    order.push('b:start');
    return 'B';
  });
  const c = sg.serialize(OTHER, async () => {
    order.push('other');
    return 'C';
  });
  eq((await Promise.all([a, b, c])).join(','), 'A,B,C', 'each caller gets its own result');
  eq(order.join(' '), 'a:start other a:end b:start', 'the second attach for the pane waits for the first (another pane does not)');
  const boom = sg.serialize(PANE, async () => {
    throw new Error('spawn failed');
  });
  let threw = false;
  await boom.catch(() => (threw = true));
  eq(threw, true, 'a throw reaches its caller');
  eq(await sg.serialize(PANE, async () => 'after'), 'after', '...and releases the mutex');
  const three: string[] = [];
  await Promise.all([1, 2, 3].map((n) => sg.serialize(PANE, async () => { three.push(`s${n}`); await sleep(10); three.push(`e${n}`); })));
  eq(three.join(' '), 's1 e1 s2 e2 s3 e3', 'three concurrent attaches run strictly one after another, in arrival order');
}

console.log('\n[check: nothing collides, could not tell, not this host]');
{
  sg.reset();
  const w = world();
  eq((await sg.check(inp(), w.deps)).ok, true, 'no collider → proceed');
  eq(JSON.stringify(w.asked[0]?.ids), JSON.stringify([OLD, NEW]), 'the classifier is asked about the banked AND the located id');
  w.classifyNull = true;
  w.procs.push(hit(900, { names: [OLD] }));
  eq((await sg.check(inp(), w.deps)).ok, true, 'classifier null (could not tell) → proceed as today');
  w.classifyNull = false;
  const n = w.asked.length;
  eq((await sg.check(inp({ local: false }), w.deps)).ok, true, 'a pane not on this host → proceed, the classifier is not asked');
  eq(w.asked.length, n, '...(never asked)');
  w.classifyThrows = true;
  eq((await sg.check(inp(), w.deps)).ok, true, 'a check that throws → proceed (could not tell), logged');
  eq(w.logs.some((l) => l.includes('check threw')), true, '...logged');
}

console.log('\n[check: an orphan naming the OLD id while locate returned the new one]');
{
  sg.reset();
  const w = world();
  w.procs.push(hit(901, { names: [OLD], paneid: null }));
  const v = await sg.check(inp(), w.deps);
  eq(v.ok, false, 'refused');
  eq(!v.ok && v.owner, 3, '...as an orphan (owner 3)');
  eq(!v.ok && v.pid, 901, '...naming its pid');
}

console.log('\n[check (i): another live row banks the conversation]');
{
  sg.reset();
  const w = world({ live: [{ paneid: OTHER, session_id: NEW }, { paneid: PANE, session_id: OLD }] });
  const v = await sg.check(inp(), w.deps);
  eq(!v.ok && v.owner, 2, 'a cross-pane live row → refused (owner 2)');
  eq(!v.ok && v.openIn, OTHER, '...naming the pane');
  eq(!v.ok && v.message, 'Pane Alpha 2 is running this conversation: End it first.', 'refusal text (2)');
  const w2 = world({ live: [{ paneid: PANE, session_id: NEW }] });
  eq((await sg.check(inp(), w2.deps)).ok, true, 'this pane\'s own row is not a collider');
}

console.log('\n[check (ii): resumingIds]');
{
  sg.reset();
  const w = world();
  const unmark = sg.markResuming(OTHER, [NEW], w.now());
  const v = await sg.check(inp(), w.deps);
  eq(!v.ok && v.owner, 2, 'an id another pane is resuming right now → refused');
  eq(!v.ok && v.openIn, OTHER, '...naming that pane');
  unmark();
  eq((await sg.check(inp(), w.deps)).ok, true, 'cleared on spawn failure → proceeds');
  sg.markResuming(OTHER, [NEW], w.now());
  w.advance(sg.RESUMING_MS + 1);
  eq((await sg.check(inp(), w.deps)).ok, true, '10 s later it has expired → proceeds');
  sg.markResuming(PANE, [NEW], w.now());
  eq((await sg.check(inp(), w.deps)).ok, true, 'this pane\'s own resume is not a collider (its attaches are serialized)');
}

console.log('\n[just-ended wait: an S collider that exits at +3 s → one spawn, no refusal]');
{
  sg.reset();
  const w = world();
  sg.noteEnded(PANE, w.now() - 2_000); // End 2 s ago
  w.procs.push(hit(902, { paneid: PANE, state: 'S', startedAt: w.now() - 60_000 }));
  w.exitAt = w.now() + 3_000;
  const waited: number[] = [];
  const t0 = w.now();
  const v = await sg.check(inp(), w.deps, (pid) => waited.push(pid));
  eq(v.ok, true, 'no refusal');
  eq(waited.join(','), '902', 'the pane was told it is waiting for pid 902');
  eq(w.now() - t0 >= 3_000 && w.now() - t0 < 4_000, true, '...and the wait ended when it exited (~3 s), not at 10 s');
}
{
  sg.reset();
  const w = world();
  sg.noteEnded(PANE, w.now() - 2_000);
  w.procs.push(hit(903, { paneid: PANE, state: 'R', startedAt: w.now() - 60_000 }));
  const waited: number[] = [];
  const t0 = w.now();
  const v = await sg.check(inp(), w.deps, (pid) => waited.push(pid));
  eq(waited.length, 1, 'an R collider that never exits: waited once');
  eq(w.now() - t0 >= sg.WAIT_MS && w.now() - t0 < sg.WAIT_MS + 1_000, true, '...up to 10 s');
  eq(!v.ok && v.owner, 1, '...then re-checked once and refused: this pane\'s previous claude (owner 1)');
  eq(!v.ok && v.message, "@alpha's previous claude (pid 903) is still stopping: try again in a few seconds.", 'refusal text (1)');
}
{
  sg.reset();
  const w = world();
  sg.noteEnded(PANE, w.now() - 2_000);
  w.procs.push(hit(904, { paneid: PANE, state: 'T', startedAt: w.now() - 60_000 }));
  const waited: number[] = [];
  const t0 = w.now();
  const v = await sg.check(inp(), w.deps, (pid) => waited.push(pid));
  eq(`${v.ok}/${waited.length}/${w.now() - t0}`, 'false/0/0', 'a T collider → immediate refusal, no wait');
}
{
  sg.reset();
  const w = world();
  sg.noteEnded(PANE, w.now() - 2_000);
  w.procs.push(hit(905, { paneid: PANE, state: 'S', startedAt: w.now() }));
  const waited: number[] = [];
  const v = await sg.check(inp(), w.deps, (pid) => waited.push(pid));
  eq(`${v.ok}/${waited.length}`, 'false/0', 'a collider that started AFTER the End is not the previous claude: no wait, refused');
  sg.reset();
  const w2 = world();
  sg.noteEnded(PANE, w2.now() - 25_000); // End 25 s ago
  w2.procs.push(hit(906, { paneid: PANE, state: 'S', startedAt: w2.now() - 60_000 }));
  const waited2: number[] = [];
  const v2 = await sg.check(inp(), w2.deps, (pid) => waited2.push(pid));
  eq(`${v2.ok}/${waited2.length}`, 'false/0', 'End over 20 s ago: no wait, refused');
  eq(!v2.ok && v2.owner, 1, '...End under 60 s ago: text (1), still stopping');
  sg.reset();
  const w3 = world();
  sg.noteEnded(PANE, w3.now() - 2_000);
  w3.procs.push(hit(907, { paneid: PANE, startedAt: w3.now() - 60_000 }), hit(908, { names: [NEW], startedAt: w3.now() - 60_000 }));
  const waited3: number[] = [];
  eq(`${(await sg.check(inp(), w3.deps, (pid) => waited3.push(pid))).ok}/${waited3.length}`, 'false/0', 'two colliders: not the "only collider" case — refused, no wait');
}

console.log('\n[refusal text by who owns the pid]');
{
  sg.reset();
  const w = world({ live: [{ paneid: OTHER, session_id: 'x' }] });
  w.procs.push(hit(910, { names: [NEW], paneid: OTHER }));
  const v = await sg.check(inp(), w.deps);
  eq(!v.ok && v.owner, 2, 'the collider carries another LIVE pane\'s paneid → (2)');
  eq(!v.ok && v.message, 'Pane Alpha 2 is running this conversation: End it first.', 'text (2)');
  sg.reset();
  const w3 = world();
  w3.procs.push(hit(911, { names: [OLD], paneid: 'recipe:gone' }));
  const v3 = await sg.check(inp(), w3.deps);
  eq(!v3.ok && v3.owner, 3, 'no End on record, the pid is nobody live\'s → orphan (3)');
  eq(
    !v3.ok && v3.message,
    'Another claude (pid 911, started Fri Sep 25 14:03:12 2026 UTC) is still running this conversation. Nothing is lost by waiting. To stop it, check that `TZ=UTC ps -o lstart= -p 911` shows Fri Sep 25 14:03:12 2026, then `kill -CONT 911; kill 911` (a stopped process ignores a plain kill until it is continued).',
    'text (3), with a zone-explicit ps check (matches in any shell) and the kill -CONT',
  );
  eq(!v3.ok && v3.lstart, 'Fri Sep 25 14:03:12 2026', '...and lstart rides the verdict (the window can render it)');
  sg.reset();
  const w4 = world();
  w4.procs.push(hit(912, { names: [OLD], lstart: null }));
  const v4 = await sg.check(inp(), w4.deps);
  eq(!v4.ok && v4.message.includes('(pid 912)') && v4.message.includes('check with `ps -o lstart= -p 912`'), true, 'text (3) without a start time says so instead of guessing');
  sg.reset();
  const w5 = world();
  sg.noteEnded(PANE, w5.now() - 90_000);
  w5.procs.push(hit(913, { paneid: PANE }));
  eq((await sg.check(inp(), w5.deps)).ok === false && (await sg.check(inp(), w5.deps) as { owner: number }).owner, 3, 'this pane\'s paneid, but End 90 s ago → orphan (3)');
}

console.log('\n[S0 ride fix: collisions are about the CONVERSATION, not the pane]');
{
  // The live N1 shape: a STOPPED orphan carrying this paneid, running another conversation.
  sg.reset();
  const w = world();
  w.procs.push(hit(930, { paneid: PANE, state: 'T', match: 'pane-other', startedAt: w.now() - 86_400_000 }));
  const waited: number[] = [];
  const v = await sg.check(inp(), w.deps, (pid) => waited.push(pid));
  eq(`${v.ok}/${waited.length}`, 'true/0', 'a stopped paneid orphan on ANOTHER conversation does not block a restore (no wait)');
  sg.noteEnded(PANE, w.now() - 2_000);
  eq((await sg.check(inp(), w.deps)).ok, true, '...not even right after an End');
  // ...beside a real collider it changes nothing about the refusal.
  w.procs.push(hit(931, { names: [OLD], paneid: 'recipe:gone', match: 'id' }));
  const v2 = await sg.check(inp(), w.deps);
  eq(!v2.ok && v2.pid, 931, 'with an id collider beside it, the refusal names the id collider');
}
{
  // This pane's previous claude still EXITING, naming a conversation the row no longer banks (re-banked).
  sg.reset();
  const w = world();
  sg.noteEnded(PANE, w.now() - 2_000);
  w.exitAt = w.now() + 1_500;
  w.procs.push(hit(932, { paneid: PANE, state: 'S', match: 'pane-other', startedAt: w.now() - 60_000 }));
  const waited: number[] = [];
  const v = await sg.check(inp(), w.deps, (pid) => waited.push(pid));
  eq(`${v.ok}/${waited.join(',')}`, 'true/932', 'a pane-other claude still exiting after the End: waited for, then proceeds');
  sg.reset();
  const w2 = world();
  sg.noteEnded(PANE, w2.now() - 2_000);
  w2.procs.push(hit(933, { paneid: PANE, state: 'S', match: 'pane-other', startedAt: w2.now() - 60_000 }));
  eq((await sg.check(inp(), w2.deps)).ok, true, '...and one that never exits still never refuses (not this conversation)');
}
{
  // Refusal (1) only for what plausibly is this pane's previous claude.
  sg.reset();
  const w = world();
  sg.noteEnded(PANE, w.now() - 2_000);
  w.procs.push(hit(934, { paneid: PANE, state: 'T', startedAt: w.now() - 60_000, match: 'id', names: [OLD] }));
  const v = await sg.check(inp(), w.deps);
  eq(!v.ok && v.owner, 3, 'a STOPPED collider right after an End: text (3) with kill -CONT, never "try again"');
  eq(!v.ok && v.message.includes(', stopped)'), true, '...and it says the process is stopped');
  sg.reset();
  const w2 = world();
  sg.noteEnded(PANE, w2.now() - 2_000);
  w2.procs.push(hit(935, { names: [NEW], paneid: null, state: 'S', startedAt: w2.now() - 60_000, match: 'id' }));
  const v2 = await sg.check(inp(), w2.deps);
  eq(!v2.ok && v2.owner, 3, 'a collider that is not this pane\'s (no paneid) is not "@x\'s previous claude"');
  sg.reset();
  const w3 = world();
  sg.noteEnded(PANE, w3.now() - 2_000);
  w3.procs.push(hit(936, { paneid: PANE, state: 'S', startedAt: w3.now() + 1, match: 'pane' }));
  const v3 = await sg.check(inp(), w3.deps);
  eq(!v3.ok && v3.owner, 3, 'a claude started after the End is not the previous claude: (3)');
  eq(
    !v3.ok && v3.message.startsWith('Another claude from this pane (pid 936, started Fri Sep 25 14:03:12 2026 UTC) is still running and may be writing this conversation.'),
    true,
    'a paneid-only hit says so — never "is still running this conversation"',
  );
}

console.log('\n[early (the launch door): synchronous, never waits, never refuses what the attach would wait for]');
{
  sg.reset();
  const w = world();
  sg.noteEnded(PANE, w.now() - 2_000);
  w.procs.push(hit(940, { paneid: PANE, state: 'S', startedAt: w.now() - 60_000, match: 'id', names: [OLD] }));
  eq(sg.early(inp(), w.deps), null, 'a previous claude still exiting after an ordinary End: no refusal (the attach waits for it)');
  w.procs[0].state = 'T';
  eq(sg.early(inp(), w.deps)?.owner, 3, 'a stopped one: refused at once, text (3)');
  const w2 = world({ live: [{ paneid: OTHER, session_id: NEW }] });
  eq(sg.early(inp(), w2.deps)?.owner, 2, '(i) another live row banks it: refused, text (2)');
  const w3 = world({ live: [{ paneid: OTHER, session_id: NEW }], mode: 'warn' });
  eq(sg.early(inp(), w3.deps), null, 'warn mode: never refuses at the launch door');
  w.classifyThrows = true;
  eq(sg.early(inp(), w.deps), null, 'a check that throws: could not tell → proceed');
}

console.log('\n[collisionGuard warn: logs and proceeds, no wait]');
{
  sg.reset();
  const w = world({ mode: 'warn' });
  sg.noteEnded(PANE, w.now() - 2_000);
  w.procs.push(hit(920, { paneid: PANE, startedAt: w.now() - 60_000 }));
  const waited: number[] = [];
  const t0 = w.now();
  eq((await sg.check(inp(), w.deps, (pid) => waited.push(pid))).ok, true, 'warn: a collision proceeds');
  eq(`${waited.length}/${w.now() - t0}`, '0/0', 'warn: no wait');
  eq(w.logs.some((l) => l.includes('WOULD REFUSE')), true, 'warn: logged as WOULD REFUSE');
  const w2 = world({ mode: 'warn', live: [{ paneid: OTHER, session_id: NEW }] });
  eq((await sg.check(inp(), w2.deps)).ok, true, 'warn: a cross-pane row proceeds too');
}

sg.reset();
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
