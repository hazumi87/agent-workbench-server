/** CHAT-HISTORY EXPORT, pure rules and the runner (src/engine/history-export.ts), with a fake clock and fake storage. The PC's time zone is
 *  America/Los_Angeles here so the DST day (25 hours) and the UTC offset are exercised. */
process.env.TZ = 'America/Los_Angeles';
import { HistoryExporter, dayBounds, dayOf, finishedDays, fileNameOf, isHistory, nextDay, nowFileNameOf, renderDay, utcOffsetOf, type ExportDeps, type LineRow } from '../src/engine/history-export.ts';

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
const at = (iso: string): number => new Date(iso).getTime(); // local time, e.g. '2026-10-20T14:30:00'

ok(dayOf(at('2026-10-20T23:59:59')) === '2026-10-20' && dayOf(at('2026-10-21T00:00:00')) === '2026-10-21', 'a day is the PC\'s local calendar day');
ok(nextDay('2026-10-31') === '2026-11-01' && nextDay('2026-12-31') === '2027-01-01' && nextDay('2028-02-28') === '2028-02-29', 'nextDay crosses month, year and leap day');
{
  const [a, b] = dayBounds('2026-11-01');
  ok((b - a) / 3600000 === 25, 'the day the clocks go back is 25 hours long');
  const [c, d] = dayBounds('2026-03-08');
  ok((d - c) / 3600000 === 23, 'the day they go forward is 23 hours');
  ok(dayOf(b - 1) === '2026-11-01' && dayOf(b) === '2026-11-02', '...and its end is the next local midnight');
}
ok(utcOffsetOf('2026-10-31') === '-07:00' && utcOffsetOf('2026-11-01') === '-08:00', 'the header offset follows daylight saving (-07:00, then -08:00)');
ok(fileNameOf('2026-10-20') === '2026-10-20.jsonl' && /^2026-10-20-now-143005\.jsonl$/.test(nowFileNameOf(at('2026-10-20T14:30:05'))), 'automatic and Export now files have different names');

const NOW = at('2026-10-24T09:00:00');
ok(finishedDays(null, null, NOW).length === 0, 'a room with no lines has no days');
ok(finishedDays(null, at('2026-10-24T01:00:00'), NOW).length === 0, 'a first line from TODAY gives no finished day (today is never exported automatically)');
ok(finishedDays(null, at('2026-10-21T10:00:00'), NOW).join() === '2026-10-21,2026-10-22,2026-10-23', 'first run: every day from the first line up to yesterday');
ok(finishedDays('2026-10-17', at('2026-09-01T10:00:00'), NOW).join() === '2026-10-18,2026-10-19,2026-10-20,2026-10-21,2026-10-22,2026-10-23', 'off for a week: the days after the marker, up to yesterday');
ok(finishedDays('2026-10-23', at('2026-09-01T10:00:00'), NOW).length === 0, 'the marker at yesterday means nothing to do');

const line = (id: number, ts: number, o: Partial<LineRow> = {}): LineRow => ({ id, ts, kind: 'chat', author: 'user', target: null, thread: null, body: `line ${id}`, ref: null, meta: null, ...o });
ok(isHistory(line(1, 0)) && !isHistory(line(1, 0, { kind: 'delivery' })) && !isHistory(line(1, 0, { kind: 'fact', meta: '{"hidden":true}' })) && isHistory(line(1, 0, { kind: 'fact', meta: '{"turn":{}}' })), 'chat and visible facts are history; delivery receipts and hidden bookkeeping are not');
{
  const text = renderDay({ id: 'r1', name: 'Design' }, '2026-10-20', [line(1, at('2026-10-20T10:00:00'), { meta: '{"to_user":true}' }), line(2, at('2026-10-20T10:01:00'), { body: 'two\nlines' })], NOW);
  const rows = text.trim().split('\n').map((l) => JSON.parse(l));
  ok(rows.length === 3 && rows[0].schema === 1 && rows[0].day === '2026-10-20' && rows[0].utcOffset === '-07:00' && rows[0].room.id === 'r1' && rows[0].lines === 2, 'line 1 is a header: schema, room, day, UTC offset, line count');
  ok(rows[1].id === 1 && rows[1].meta.to_user === true && rows[2].body === 'two\nlines', 'then one JSON object per entry, bodies intact, meta parsed');
  ok(text.endsWith('\n') && text.split('\n').filter(Boolean).length === 3, 'one entry per line, even for a body with a newline');
}

/* the runner */
interface Fake {
  deps: ExportDeps;
  files: Map<string, string>;
  markers: Map<string, string>;
  yields: { n: number };
  errors: string[];
  state: { enabled: boolean; now: number; failOn: string | null };
}
function fake(lines: Record<string, LineRow[]>, rooms = [{ id: 'r1', name: 'Design' }], seedMarkers: Record<string, string> = {}): Fake {
  const files = new Map<string, string>();
  const markers = new Map<string, string>(Object.entries(seedMarkers));
  const yields = { n: 0 };
  const errors: string[] = [];
  const state = { enabled: true, now: NOW, failOn: null as string | null };
  const deps: ExportDeps = {
    now: () => state.now,
    rooms: () => rooms,
    firstTs: (id) => (lines[id]?.length ? Math.min(...lines[id].map((l) => l.ts)) : null),
    lines: (id, from, to) => (lines[id] ?? []).filter((l) => l.ts >= from && l.ts < to),
    write: (id, name, content) => {
      if (state.failOn === `${id}/${name}`) {
        throw new Error('disk full');
      }
      const k = `${id}/${name}`;
      if (files.has(k)) {
        return 'exists';
      }
      files.set(k, content);
      return 'written';
    },
    getMarker: (id) => markers.get(id) ?? null,
    setMarker: (id, day) => markers.set(id, day),
    enabled: () => state.enabled,
    yieldNow: async () => {
      yields.n++;
    },
    onError: (m) => errors.push(m),
  };
  return { deps, files, markers, yields, errors, state };
}

{
  const f = fake({ r1: [line(1, at('2026-10-20T10:00:00')), line(2, at('2026-10-20T11:00:00')), line(3, at('2026-10-22T09:00:00')), line(4, at('2026-10-23T23:59:00')), line(5, at('2026-10-24T08:00:00'))] });
  const x = new HistoryExporter(f.deps);
  const st = await x.catchUp();
  ok([...f.files.keys()].sort().join() === 'r1/2026-10-20.jsonl,r1/2026-10-22.jsonl,r1/2026-10-23.jsonl', 'the catch-up writes a file for each finished day that has lines (21st has none: no file)');
  ok(f.markers.get('r1') === '2026-10-23', 'and the marker moves to yesterday (empty days included)');
  ok(!([...f.files.values()].some((t) => t.includes('"id":5'))), 'today\'s line is not in any file');
  ok(st.written === 3 && st.total === 4 && st.done === 4 && !st.running && st.lastError === null, 'status: 4 days looked at, 3 files written');
  ok(f.yields.n === 4, 'the runner yielded between days (4)');
  f.files.clear();
  const again = await x.catchUp();
  ok(f.files.size === 0 && again.written === 0, 'a second run writes nothing (the marker holds)');
}
{
  const f = fake({ r1: [line(1, at('2026-10-20T10:00:00'))] }, undefined, { r1: '2026-10-19' });
  f.files.set('r1/2026-10-20.jsonl', 'SOMEONE ELSE WROTE THIS');
  await new HistoryExporter(f.deps).catchUp();
  ok(f.files.get('r1/2026-10-20.jsonl') === 'SOMEONE ELSE WROTE THIS' && f.markers.get('r1') === '2026-10-23', 'an existing file is NEVER rewritten, and the marker still moves on');
}
{
  const f = fake({ r1: [line(1, at('2026-10-20T10:00:00')), line(2, at('2026-10-22T10:00:00'))], r2: [line(3, at('2026-10-22T10:00:00'))] }, [{ id: 'r1', name: 'A' }, { id: 'r2', name: 'B' }]);
  f.state.failOn = 'r1/2026-10-22.jsonl';
  const st = await new HistoryExporter(f.deps).catchUp();
  ok(f.files.has('r1/2026-10-20.jsonl') && !f.files.has('r1/2026-10-22.jsonl') && f.files.has('r2/2026-10-22.jsonl'), 'a failed write stops that room at that day; the other room goes on');
  ok(f.markers.get('r1') === '2026-10-21' && st.lastError?.includes('disk full') === true && f.errors.length === 1, 'the marker stays before the failed day, and the error is reported');
  f.state.failOn = null;
  await new HistoryExporter(f.deps).catchUp();
  ok(f.files.has('r1/2026-10-22.jsonl') && f.markers.get('r1') === '2026-10-23', 'the next run retries the failed day');
}
{
  const f = fake({ r1: [line(1, at('2026-10-20T10:00:00'))] });
  f.state.enabled = false;
  const st = await new HistoryExporter(f.deps).catchUp();
  ok(f.files.size === 0 && st.enabled === false, 'with the setting off nothing is written');
}
{
  const f = fake({ r1: [line(1, at('2026-10-10T10:00:00')), line(2, at('2026-10-11T10:00:00')), line(3, at('2026-10-12T10:00:00'))] });
  let x!: HistoryExporter;
  f.deps.yieldNow = async () => {
    x.cancel();
  };
  x = new HistoryExporter(f.deps);
  const st = await x.catchUp();
  ok(f.files.size === 1 && f.markers.get('r1') === '2026-10-10' && !st.running, 'cancel stops after the current day; the marker keeps what was done');
}
{
  const f = fake({ r1: [line(1, at('2026-10-24T08:00:00')), line(2, at('2026-10-24T08:30:00'), { kind: 'delivery' }), line(3, at('2026-10-23T20:00:00'))] }, [{ id: 'r1', name: 'Design' }, { id: 'r2', name: 'Empty' }]);
  const x = new HistoryExporter(f.deps);
  const out = x.exportNow();
  ok(out.length === 1 && out[0].roomId === 'r1' && out[0].lines === 1 && /^2026-10-24-now-090000\.jsonl$/.test(out[0].name), 'Export now saves today so far under its own name (receipts left out, empty rooms skipped)');
  const rows = [...f.files.values()][0].trim().split('\n').map((l) => JSON.parse(l));
  ok(rows[0].partial === true && rows[0].day === '2026-10-24', 'its header says it is partial');
  f.state.now = NOW + 60000;
  x.exportNow('r1');
  ok(f.files.size === 2, 'each Export now makes a new file, never replacing the last');
  await x.catchUp();
  ok([...f.files.keys()].some((k) => k === 'r1/2026-10-23.jsonl') && [...f.files.keys()].filter((k) => k.includes('-now-')).length === 2, 'the automatic export and the manual ones do not collide');
}
{
  const f = fake({ r1: [line(1, at('2026-10-24T08:00:00'))] });
  const x = new HistoryExporter(f.deps);
  const a = x.exportNow();
  const b = x.exportNow(); // same second
  ok(a[0].name !== b[0].name && f.files.size === 2 && /-now-090000-1\.jsonl$/.test(b[0].name), 'two Export-now presses in the same second make two files and report both truthfully');
}
{
  const f = fake({ r1: [line(1, at('2026-10-10T10:00:00')), line(2, at('2026-10-11T10:00:00')), line(3, at('2026-10-12T10:00:00'))] });
  f.deps.yieldNow = async () => {
    f.state.enabled = false; // the person flips the toggle off while the run is going
  };
  const st = await new HistoryExporter(f.deps).catchUp();
  ok(f.files.size === 1 && f.markers.get('r1') === '2026-10-10' && !st.running, 'switching the toggle off stops a catch-up that is already running (after the day just finished)');
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
