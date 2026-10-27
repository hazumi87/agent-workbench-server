/* session-adopt: the rule that re-points a live pane at the transcript it is
 * actually in.
 *
 * The interesting assertions are the REFUSALS. Adopting wrongly is far worse
 * than not adopting: a wrong title is cosmetic, but a wrong session_id points a
 * RESTORE at someone else's conversation. So every ambiguous shape is asserted
 * to do nothing.
 */
import { planAdoptions } from '../src/engine/session-adopt.ts';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  cond ? pass++ : fail++;
};

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** The injected listing lookup — no ssh, no module cache. */
let LOOKUP: (rid: string) => any[] = () => [];
function seed(recipeId: string, rows: Array<{ id: string; ageMin: number; title?: string }>) {
  LOOKUP = (rid: string) =>
    rid === recipeId
      ? rows.map((r) => ({
          sessionId: r.id,
          title: r.title ?? null,
          lastPrompt: null,
          firstCommand: null,
          mtimeMs: NOW - r.ageMin * MIN,
          sizeBytes: 1000,
          branch: null,
        }))
      : [];
}
/* When each pane last emitted content. The default coincides with the "real
   case" candidate (8 min ago) so the established cases read as before; the
   2026-09-18 cases override it. */
let LAST_OUTPUT: (paneid: string) => number | undefined = () => NOW - 8 * MIN;
const plan = (panes: any[]) => planAdoptions(panes, NOW, LOOKUP as any, LAST_OUTPUT);

const pane = (paneid: string, session_id: string | null, recipe_id = 'R') => ({
  paneid,
  recipe_id,
  session_id,
  state: 'live',
  vendor: 'claude-code',
});

console.log('\n[the real case: banked cold, one unclaimed hot candidate]');
seed('R', [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 8, title: 'HOMEHUB Latency (Fable)' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000002', ageMin: 20, title: 'Spotify registration' },
  { id: 'cccccccc-0000-4000-8000-000000000003', ageMin: 68, title: null },
]);
{
  const planned = plan([
    pane('p:stale', 'cccccccc-0000-4000-8000-000000000003'),
    pane('p:healthy', 'bbbbbbbb-0000-4000-8000-000000000002'),
  ]);
  ok(planned.length === 1, 'exactly one adoption planned', `${planned.length}`);
  ok(planned[0]?.paneid === 'p:stale', 'the STALE pane is the one moved', planned[0]?.paneid);
  ok(
    planned[0]?.to === 'aaaaaaaa-0000-4000-8000-000000000001',
    'it adopts the hot UNCLAIMED transcript',
    planned[0]?.to,
  );
  ok(planned[0]?.title === 'HOMEHUB Latency (Fable)', 'the new title comes with it', planned[0]?.title ?? '');
}

console.log('\n[refusals — each of these must do NOTHING]');
{
  // The healthy pane alone: its banked file is hot, so there is nothing to fix.
  ok(plan([pane('p:healthy', 'bbbbbbbb-0000-4000-8000-000000000002')]).length === 0, 'a pane whose banked transcript is warm is left alone');
}
{
  /* TWO unclaimed hot candidates. This is the shape that must never be guessed:
     picking either could point a restore at the wrong conversation. */
  seed('R', [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 5 },
    { id: 'dddddddd-0000-4000-8000-000000000004', ageMin: 6 },
    { id: 'cccccccc-0000-4000-8000-000000000003', ageMin: 68 },
  ]);
  ok(plan([pane('p:stale', 'cccccccc-0000-4000-8000-000000000003')]).length === 0, 'two plausible candidates -> refuses to guess');
}
{
  // Nothing warm: the project has simply been idle. Leave it.
  seed('R', [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 240 },
    { id: 'cccccccc-0000-4000-8000-000000000003', ageMin: 300 },
  ]);
  ok(plan([pane('p:stale', 'cccccccc-0000-4000-8000-000000000003')]).length === 0, 'no hot transcript -> nothing adopted');
}
{
  /* The candidate is hot but ANOTHER live pane is banked on it. A claimed file
     is evidence of a healthy pane, not an available candidate — this is the
     case an earlier "only when one live pane" gate got wrong. */
  seed('R', [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 5 },
    { id: 'cccccccc-0000-4000-8000-000000000003', ageMin: 68 },
  ]);
  ok(
    plan([
      pane('p:stale', 'cccccccc-0000-4000-8000-000000000003'),
      pane('p:other', 'aaaaaaaa-0000-4000-8000-000000000001'),
    ]).length === 0,
    'the only hot transcript is claimed -> refuses',
  );
}
{
  // Non-claude panes and broker ids are not lineages we can reason about.
  seed('R', [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 5 }]);
  const shell = { ...pane('p:shell', 'bk:local:recipe:x'), vendor: 'cli-manager' };
  const brokerId = pane('p:broker', 'bk:local:recipe:y');
  ok(plan([shell]).length === 0, 'non-claude vendor is never touched');
  ok(plan([brokerId]).length === 0, 'a non-uuid banked id is never touched');
}
{
  // A dead pane is not a candidate for anything.
  seed('R', [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 5 }]);
  const dead = { ...pane('p:dead', 'cccccccc-0000-4000-8000-000000000003'), state: 'killed' };
  ok(plan([dead]).length === 0, 'a killed pane is never adopted into');
}
{
  /* TWO stale panes that both conclude they are in the SAME transcript. At most
     one can be right and nothing here can say which, so neither moves —
     awarding it to whichever was iterated first would be a coin flip pointed at
     someone's restore. */
  seed('R', [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 5 },
    { id: 'cccccccc-0000-4000-8000-000000000003', ageMin: 90 },
    { id: 'eeeeeeee-0000-4000-8000-000000000005', ageMin: 95 },
  ]);
  ok(
    plan([
      pane('p:stale1', 'cccccccc-0000-4000-8000-000000000003'),
      pane('p:stale2', 'eeeeeeee-0000-4000-8000-000000000005'),
    ]).length === 0,
    'a contested transcript goes to nobody',
  );
}
{
  /* IDLE IS NOT STALE. The banked file is quiet but only slightly older than
     the newest one — that is a pane nobody has typed in, not a pane that moved.
     This is the case that made two panes chase one transcript on the first run. */
  seed('R', [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 8 },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', ageMin: 20 },
  ]);
  ok(
    plan([pane('p:idle', 'bbbbbbbb-0000-4000-8000-000000000002')]).length === 0,
    'merely idle (no clear lead) -> left alone',
  );
}
{
  // Nothing fetched for this project yet — wait for the next poll.
  LOOKUP = () => [];
  ok(
    plan([pane('p:stale', 'cccccccc-0000-4000-8000-000000000003')]).length === 0,
    'no listing cached yet -> waits rather than acting blind',
  );
}

console.log('\n[2026-09-18: a hotter file is not evidence — the pane must have been writing it]');
{
  /* OWNER'S CASE. A parked pane, silent for two hours, in a project dir where a
     claude OUTSIDE the manager (a terminal session) is writing its transcript
     every minute. Hottest file, unclaimed, never cold — the old rule handed it
     to the parked pane on every sweep. */
  seed('R', [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 1, title: 'terminal session' },
    { id: 'cccccccc-0000-4000-8000-000000000003', ageMin: 120, title: 'Orchestrator test' },
  ]);
  LAST_OUTPUT = () => NOW - 120 * MIN;
  ok(
    plan([pane('p:parked', 'cccccccc-0000-4000-8000-000000000003')]).length === 0,
    'a pane silent while the hot file was written is NOT in it -> refuses',
  );
  LAST_OUTPUT = () => undefined;
  ok(
    plan([pane('p:mute', 'cccccccc-0000-4000-8000-000000000003')]).length === 0,
    'a pane with no output record at all -> no evidence, no move',
  );
  /* The same shape, but the pane WAS talking when the file was last written:
     that is an in-pane /resume, the case adoption exists for. */
  LAST_OUTPUT = () => NOW - 1 * MIN + 5_000;
  const moved = plan([pane('p:resumed', 'cccccccc-0000-4000-8000-000000000003')]);
  ok(moved.length === 1 && moved[0].to === 'aaaaaaaa-0000-4000-8000-000000000001',
    'a pane that spoke as the file was written -> adopts it', `${moved.length}`);
}
{
  /* A DEHYDRATED pane already banks the hot transcript: that conversation has
     a pane of its own to come back on. Giving it to a live pane as well would
     give one transcript two panes. */
  seed('R', [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', ageMin: 1 },
    { id: 'cccccccc-0000-4000-8000-000000000003', ageMin: 120 },
  ]);
  LAST_OUTPUT = () => NOW - 1 * MIN;
  const parked = { ...pane('p:parked', 'aaaaaaaa-0000-4000-8000-000000000001'), state: 'dehydrated' };
  ok(
    plan([pane('p:live', 'cccccccc-0000-4000-8000-000000000003'), parked]).length === 0,
    'a transcript a dehydrated pane banks is claimed -> refuses',
  );
  const dead = { ...parked, state: 'killed' };
  ok(
    plan([pane('p:live', 'cccccccc-0000-4000-8000-000000000003'), dead]).length === 1,
    'a killed row is history, not a claim -> adopts',
  );
}
LAST_OUTPUT = () => NOW - 8 * MIN;

console.log(`\n${'='.repeat(40)}\nPASS ${pass}  FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
