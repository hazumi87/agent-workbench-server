/**
 * Timeline trimming (Owner, Tasks Gantt by seat: trends, not detail): flapping stretches merge, sub-minute stretches go, stretches older than 24 h fold into
 * a per-task per-seat total, an open stretch is never touched. src/table/tasks-store.ts sweepTimeline. A scratch in-memory db.
 */
import Database from 'better-sqlite3';
import { ensureTaskTables, addTask, sweepTimeline, mergeTimelineTick, mergeTimeline, foldTimeline, sweepRetention, timeWorked, purge, setStatus } from '../src/table/tasks-store.ts';

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };
const d = new Database(':memory:');
ensureTaskTables(d);
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const NOW = 100 * H;
const task = (title: string) => addTask(d, { familyId: 'main', roomId: 'g', title }, NOW - 50 * H).id;
const stretch = (t: number, seat: string, start: number, end: number | null) => d.prepare(`INSERT INTO task_stretches (task_id, seat_id, start_at, end_at) VALUES (?,?,?,?)`).run(t, seat, start, end);
const need = (t: number, start: number, end: number | null) => d.prepare(`INSERT INTO task_needs (task_id, start_at, end_at) VALUES (?,?,?)`).run(t, start, end);
const rows = (t: number, seat?: string) => d.prepare(`SELECT start_at, end_at FROM task_stretches WHERE task_id=? ${seat ? 'AND seat_id=?' : ''} ORDER BY start_at`).all(...(seat ? [t, seat] : [t])) as { start_at: number; end_at: number | null }[];

console.log('\n[a flapping task: 10 toggles in 2 minutes leaves one stretch]');
const f = task('flap');
for (let i = 0; i < 10; i++) stretch(f, 'seat-a', NOW - 10 * MIN + i * 12 * S, NOW - 10 * MIN + i * 12 * S + 8 * S);
sweepTimeline(d, NOW);
const fr = rows(f);
ok(fr.length === 1 && fr[0].start_at === NOW - 10 * MIN && fr[0].end_at === NOW - 10 * MIN + 9 * 12 * S + 8 * S, 'merged into one stretch spanning the whole run');
ok(fr[0].end_at! - fr[0].start_at >= MIN, '...which is over a minute, so it survives');
ok(sweepTimeline(d, NOW) === 0, 'idempotent');

console.log('\n[a 30 s stretch is dropped; a gap of a minute or more is not merged]');
const g = task('short');
stretch(g, 'seat-a', NOW - 30 * MIN, NOW - 30 * MIN + 30 * S);
stretch(g, 'seat-b', NOW - 20 * MIN, NOW - 15 * MIN);
stretch(g, 'seat-b', NOW - 15 * MIN + MIN, NOW - 10 * MIN); // exactly 60 s gap: apart
sweepTimeline(d, NOW);
ok(rows(g, 'seat-a').length === 0, 'the 30 s stretch is gone');
ok(rows(g, 'seat-b').length === 2, 'a 60 s gap keeps two stretches');
ok(timeWorked(d, g).length === 0, 'a dropped short stretch adds nothing to time worked');

console.log('\n[a 25 h old stretch folds into the total and is gone]');
const o = task('old');
stretch(o, 'seat-a', NOW - 26 * H, NOW - 25 * H);
stretch(o, 'seat-a', NOW - 25 * H + 10 * MIN, NOW - 24 * H - 10 * MIN); // ended just over 24 h ago
stretch(o, 'seat-a', NOW - 2 * H, NOW - H); // recent: stays
sweepTimeline(d, NOW);
ok(rows(o).length === 1 && rows(o)[0].start_at === NOW - 2 * H, 'only the recent stretch remains');
const tw = timeWorked(d, o);
ok(tw.length === 1 && tw[0].seat_id === 'seat-a' && tw[0].total_ms === H + 40 * MIN, 'the old ones are summed per seat (1 h + 40 min)');
ok(tw[0].last_end === NOW - 24 * H - 10 * MIN, 'last_end is the latest folded end');
stretch(o, 'seat-a', NOW - 30 * H, NOW - 29 * H);
sweepTimeline(d, NOW);
ok(timeWorked(d, o)[0].total_ms === 2 * H + 40 * MIN, 'a later fold adds to the same row');

console.log('\n[an open stretch is never touched]');
const p = task('open');
stretch(p, 'seat-a', NOW - 40 * H, null); // open for 40 h
stretch(p, 'seat-a', NOW - 90 * S, NOW - 60 * S); // closed 30 s, would be dropped
need(p, NOW - 40 * H, null);
sweepTimeline(d, NOW);
ok(rows(p).length === 1 && rows(p)[0].end_at === null && rows(p)[0].start_at === NOW - 40 * H, 'the open stretch is untouched (an OPEN task folds too, but never its open stretch)');
ok((d.prepare(`SELECT COUNT(*) AS c FROM task_needs WHERE task_id=? AND end_at IS NULL`).get(p) as { c: number }).c === 1, 'an open needs band is untouched');
ok(timeWorked(d, p).length === 0, 'nothing folded for it');

console.log('\n[needs bands: merged under a minute apart, deleted after 24 h]');
const n = task('needs');
need(n, NOW - 10 * MIN, NOW - 9 * MIN);
need(n, NOW - 9 * MIN + 20 * S, NOW - 8 * MIN);
need(n, NOW - 30 * H, NOW - 29 * H);
sweepTimeline(d, NOW);
const nr = d.prepare(`SELECT start_at, end_at FROM task_needs WHERE task_id=? ORDER BY start_at`).all(n) as { start_at: number; end_at: number }[];
ok(nr.length === 1 && nr[0].start_at === NOW - 10 * MIN && nr[0].end_at === NOW - 8 * MIN, 'two bands 20 s apart are one; the 30 h old band is gone');

console.log('\n[retention folds before it deletes; purge removes the totals]');
const r = task('done');
stretch(r, 'seat-a', NOW - 10 * H, NOW - 9 * H);
setStatus(d, 'main', r, 'done', NOW - 9 * H);
sweepRetention(d, NOW + 8 * 24 * H);
ok(rows(r).length === 0 && timeWorked(d, r)[0]?.total_ms === H, 'a trimmed done task keeps its time-worked total');
purge(d, 'main', r);
ok(timeWorked(d, r).length === 0, 'purge removes the total with the task');

console.log('\n[the 60 s tick: a flap merges within a minute, only settled rows, only pairs that closed since the last tick]');
{
  const T0 = 500 * H;
  const q = task('tick');
  for (let i = 0; i < 10; i++) stretch(q, 'seat-t', T0 + i * 12 * S, T0 + i * 12 * S + 8 * S); // ends at T0 + 116 s
  const lastEnd = T0 + 9 * 12 * S + 8 * S;
  mergeTimelineTick(d, lastEnd + 30 * S); // the run only just ended: nothing settled enough to touch
  ok(rows(q).length >= 2, 'a run that ended 30 s ago is left alone (the tail is not settled)');
  mergeTimelineTick(d, lastEnd + MIN + 5 * S);
  ok(rows(q).length === 1, 'one tick after it settled: ONE stretch');
  const before = mergeTimelineTick(d, lastEnd + 2 * MIN + 10 * S);
  ok(before === 0 && rows(q).length === 1, 'a tick with nothing new closed does nothing');

  const w = task('tick-open');
  stretch(w, 'seat-w', T0, T0 + 20 * S); // short...
  stretch(w, 'seat-w', T0 + 40 * S, null); // ...but the run is still going (open, 20 s later)
  mergeTimeline(d, T0 + 5 * MIN, 0);
  ok(rows(w).length === 2, 'a short stretch followed within a minute by an OPEN one is kept (it is the start of the run); the open one is untouched');
  d.prepare(`UPDATE task_stretches SET end_at=? WHERE task_id=? AND end_at IS NULL`).run(T0 + 90 * S, w);
  mergeTimeline(d, T0 + 5 * MIN, 0);
  ok(rows(w).length === 1 && rows(w)[0].start_at === T0 && rows(w)[0].end_at === T0 + 90 * S, 'once it closes, the two merge into one stretch');

  const x = task('tick-fold');
  stretch(x, 'seat-x', T0 - 30 * H, T0 - 29 * H);
  mergeTimeline(d, T0, 0);
  ok(rows(x).length === 1 && timeWorked(d, x).length === 0, 'the merge/drop half does NOT fold');
  foldTimeline(d, T0);
  ok(rows(x).length === 0 && timeWorked(d, x)[0]?.total_ms === H, 'the 24 h half does');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
