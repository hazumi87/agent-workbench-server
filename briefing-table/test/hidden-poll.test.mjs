/**
 * A hidden tab polls slowly instead of not at all [ticket]: the room page is
 * the only source of the shell's room ring, so while hidden it still runs
 * fetchRoom (and nothing else) at most once per HIDDEN_POLL_MS. The manager
 * does the same with pollLive. Visible behavior is unchanged.
 *
 * Unit-level: slices the SHIPPED source of poll() / the manager's interval and
 * runs it against stubs and a fake clock. No engine, no ports.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, 'web', f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}`);
  }
}

/** The text from `start` to the first `end` after it. */
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  if (i < 0 || j < 0) {
    throw new Error(`cannot slice ${start}`);
  }
  return src.slice(i, j);
}

const clock = { now: 1_000_000 };
const fakeDate = { now: () => clock.now };

console.log('\n[room.js poll()]');
{
  const src = read('room.js');
  ok(/const HIDDEN_POLL_MS = 15000;/.test(src), 'HIDDEN_POLL_MS is 15 s');
  const body = slice(src, 'let pollCount = 0;', '/* ---------------------------------------------------------------- boot');
  const make = new Function(
    'isHidden', 'navigator', 'Date', 'HIDDEN_POLL_MS', 'fetchRoom', 'backfill', 'refreshReads', 'state', 'onDraftStamp', 'syncDraft', 'DRAFT_TICK_MS', 'tickDeviceReport',
    `${body}; return poll;`,
  );
  const calls = { fetchRoom: 0, backfill: 0, refreshReads: 0 };
  const hidden = { v: true };
  const nav = { onLine: true };
  const state = { push: 'down', entries: new Map() };
  const poll = make(
    () => hidden.v, nav, fakeDate, 15000,
    async () => { calls.fetchRoom++; },
    async () => { calls.backfill++; },
    async () => { calls.refreshReads++; },
    state,
    () => true, // a visible tick with a stamped room answer reads no draft by tick
    () => {}, 8000,
    () => {}, // the device report rides this poll (web/device-report.mjs); nothing to assert here
  );
  const reset = () => { calls.fetchRoom = 0; calls.backfill = 0; calls.refreshReads = 0; };

  await poll();
  ok(calls.fetchRoom === 1 && calls.backfill === 0 && calls.refreshReads === 0, 'hidden tick: fetchRoom only, no backfill or reads');
  clock.now += 2500;
  await poll();
  clock.now += 2500;
  await poll();
  ok(calls.fetchRoom === 1, 'hidden ticks within 15 s: still one fetch');
  clock.now += 15000;
  await poll();
  ok(calls.fetchRoom === 2 && calls.backfill === 0, 'hidden, 15 s later: a second fetch');
  nav.onLine = false;
  clock.now += 60000;
  await poll();
  ok(calls.fetchRoom === 2, 'hidden and offline: no fetch');
  nav.onLine = true;

  reset();
  hidden.v = false;
  await poll();
  ok(calls.fetchRoom === 1 && calls.backfill === 1, 'visible tick: fetchRoom and backfill, as before');
  await poll();
  ok(calls.fetchRoom === 2, 'visible ticks are not throttled');
  state.push = 'live';
  reset();
  await poll();
  ok(calls.fetchRoom === 1 && calls.backfill === 0, 'visible with push live: fetchRoom only, as before');

  hidden.v = true;
  clock.now += 15000;
  const threw = await poll().then(() => false, () => true);
  ok(!threw, 'a hidden tick never throws');
  const failing = make(() => true, nav, fakeDate, 15000, async () => { throw new Error('boom'); }, async () => {}, async () => {}, state, () => true, () => {}, 8000, () => {});
  clock.now += 15000;
  ok(await failing().then(() => true, () => false), 'a failing hidden fetchRoom is swallowed');
}

console.log('\n[manager.js interval]');
{
  const src = read('manager.js');
  ok(/const HIDDEN_POLL_MS = 15000;/.test(src), 'HIDDEN_POLL_MS is 15 s');
  const body = slice(src, 'const HIDDEN_POLL_MS', '}, 2500);') + '}, 2500);';
  let tick = null;
  const make = new Function('isHidden', 'navigator', 'Date', 'pollLive', 'setInterval', 'tickDeviceReport', body);
  let polls = 0;
  const hidden = { v: true };
  const nav = { onLine: true };
  make(() => hidden.v, nav, fakeDate, async () => { polls++; }, (fn) => { tick = fn; }, () => {}); // the device report rides this interval (web/device-report.mjs)
  clock.now += 100000;
  tick();
  ok(polls === 1, 'hidden tick: one pollLive');
  clock.now += 2500;
  tick();
  clock.now += 2500;
  tick();
  ok(polls === 1, 'hidden ticks within 15 s: still one');
  clock.now += 15000;
  tick();
  ok(polls === 2, 'hidden, 15 s later: a second');
  nav.onLine = false;
  clock.now += 60000;
  tick();
  ok(polls === 2, 'hidden and offline: none');
  nav.onLine = true;
  hidden.v = false;
  tick();
  tick();
  ok(polls === 4, 'visible ticks: every tick polls, as before');
}

console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
