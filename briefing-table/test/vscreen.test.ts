/**
 * PTY SCREEN MODEL, P0 SHADOW (src/engine/vscreen.ts; the design notes).
 *
 *  - boot: the module loads under tsx with the default-import shape, and the
 *    xterm parse guard installs on the exact-pinned 6.0.0;
 *  - fixtures: captured claude-code 2.1.282 byte streams (probe runs, synthetic
 *    text only) replayed through the model, the reading asserted at every mark;
 *  - the redraw state machine in PARSE ORDER: claude's reset shape at N = rows
 *    (and not at N != rows), ESC[2J / ?1049h only when an absolute CUP follows
 *    before any print or relative move, ESC[3J never, RIS, per-buffer sync,
 *    markers inside a seed never count, all of it split across chunks down to
 *    single characters;
 *  - size persistence across a relaunch (leading + trailing edge, the
 *    size_at < started_at rule, sizeless on a closed link, sizeless recovery);
 *  - gaps, the provisional window, the height-increase demote;
 *  - fail-safety: every entry point with throwing deps and garbage inputs, a
 *    parser throw on xterm's own timer, the breaker;
 *  - the headless terminal's onData / onBinary are never bound;
 *  - privacy: no planted string in diag, log entries or log lines, and every
 *    evidence value is in the closed union;
 *  - combineDraft (the §5 table) and the shadow log end to end;
 *  - flag off / shadow change NO consumer behaviour (room-typer types into a
 *    screen draft exactly as before; only a log line differs);
 *  - config.json mtime switches the mode live.
 *
 * SAFETY: temp db via HARBOR_WB_TABLE before any import; no broker, no pty, no
 * port. Run with tsx.
 */
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xh from '@xterm/headless';

const dir = mkdtempSync(join(tmpdir(), 'wb-vscreen-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ACT_ECHO_MS = '100';
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '300';
process.env.HARBOR_WB_VSCREEN_SETTLE_MS = '300'; // the screen model's own settle (default 3 s since 2026-10-06)
process.env.HARBOR_WB_VOICE_ENTER_MS = '10';
process.env.HARBOR_WB_VSCREEN = 'shadow';
delete process.env.HARBOR_WB_ROOM_TYPE;

/* ONDATA / ONBINARY ARE NEVER BOUND. Count every access to the public getters
   BEFORE any terminal exists; the model must never touch them. */
const { Terminal } = xh;
const proto = Terminal.prototype as unknown as Record<string, unknown>;
let onDataTouched = 0;
for (const name of ['onData', 'onBinary']) {
  const desc = Object.getOwnPropertyDescriptor(proto, name);
  if (!desc?.get) {
    throw new Error(`xterm changed: ${name} is not a prototype getter`);
  }
  Object.defineProperty(proto, name, {
    configurable: true,
    get(this: unknown) {
      onDataTouched++;
      return desc.get!.call(this);
    },
  });
}

let uncaught = 0;
process.on('uncaughtException', (e) => {
  uncaught++;
  console.log(`  ✗ uncaughtException: ${(e as Error).message}`);
});

const vs = await import('../src/engine/vscreen.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const typer = await import('../src/engine/room-typer.ts');
const { table } = await import('../src/table/endpoint.ts');

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
const ok = (cond: boolean, msg: string): void => eq(cond, true, msg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ESC = String.fromCharCode(27);

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'vscreen', 'cc-2.1.282-pty');
interface Ev {
  t: number;
  dir: 'out' | 'in' | 'resize';
  data?: string;
}
interface Mark {
  t: number;
  expect: { composer: string; surface: string; evidence?: string };
  note?: string;
}
const load = (name: string): { events: Ev[]; marks: Mark[]; cols: number; rows: number } => {
  const events = readFileSync(join(FIX, `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Ev);
  const m = JSON.parse(readFileSync(join(FIX, `${name}.marks.json`), 'utf8'));
  return { events, marks: m.marks, cols: m.cols, rows: m.rows };
};

/* Every log line the model emits, for the privacy assertions. */
const lines: string[] = [];
let linkUp = true;
let replayFor: Record<string, string> = {};
const saved: Array<[string, number | null, number | null]> = [];
vs.setDeps({
  log: (l) => lines.push(l),
  linkOpen: () => linkUp,
  replayOf: (id) => replayFor[id] ?? null,
  saveSize: (id, c, r, at) => {
    saved.push([id, c, r]);
    table.setSize(id, c, r, at);
  },
  loadSize: (id) => {
    const row = table.get(id);
    return row ? { cols: row.cols ?? null, rows: row.rows ?? null, sizeAt: row.size_at ?? null, startedAt: row.started_at ?? null } : null;
  },
});
const row = (id: string, vendor = 'claude-code') =>
  table.upsert({ paneid: id, recipe_id: null, server: 'local', vendor, agent: null, session_id: null, state: 'live' });
const spawn = (id: string, cols = 140, rows = 50, vendor = 'claude-code', hostKind: 'pty' | 'conpty' = 'pty') => {
  row(id, vendor);
  vs.create(id, { origin: 'spawn', link: 'homebase', hostKind, vendor, cols, rows });
};
/* As index.ts wires it: the engine typing opens an inject window. */
typer.onTyped((id) => vs.noteInject(id, 'room-typer'));
const reading = (id: string) => vs.reading(id)!;
const paneDiag = (id: string) => (vs.diag(id).panes as Record<string, any>)[id];
const logOf = (kind: string, id?: string) => ((vs.diag(id).log as Record<string, any[]>)[kind] ?? []);

/** Feed events up to `until`. With `withInput`, `in` events go through the
 *  input guard as the WS handler does, and after each one the replay waits
 *  out the echo + settle windows (real time is compressed otherwise, and every
 *  comparison would be skipped as "echo not settled"). */
async function replay(id: string, events: Ev[], from: number, until: number, withInput = false): Promise<void> {
  let typed = false;
  for (const e of events) {
    if (e.t < from || e.t >= until) {
      continue;
    }
    if (e.dir === 'out') {
      vs.feed(id, e.data!);
    } else if (e.dir === 'in' && withInput) {
      await vs._settle(id);
      if (typed) {
        await sleep(360);
      }
      activity.onInput(id, e.data!);
      vs.onInput(id);
      typed = true;
    }
  }
  await vs._settle(id);
  if (typed) {
    await sleep(360);
  }
}

/* ========================================================================== */
console.log('\n[boot: import shape + parse guard]');
{
  eq(typeof vs.create, 'function', 'vscreen.ts loads under tsx (default-import shape)');
  spawn('boot');
  eq(vs.diag().parseGuard, true, 'the xterm parse guard installs on the pinned 6.0.0');
  eq(vs.currentMode(), 'shadow', 'HARBOR_WB_VSCREEN=shadow is honoured');
  vs.dispose('boot');
}

/* ========================================================================== */
console.log('\n[fixtures: readings at every mark, spawn origin]');
for (const name of ['r5-startup', 'r1-trust', 'r6-draft']) {
  const f = load(name);
  const id = `fx-${name}`;
  spawn(id, f.cols, f.rows);
  let from = -Infinity;
  for (const m of f.marks) {
    await replay(id, f.events, from, m.t);
    from = m.t;
    const r = reading(id);
    eq(`${r.composer}/${r.surface}/${r.evidence}`, `${m.expect.composer}/${m.expect.surface}/${m.expect.evidence}`, `${name} @${m.t} ${m.note ?? ''}`);
  }
  eq(paneDiag(id).sync, 'synced', `${name}: a spawned pane is synced from byte 0`);
  vs.dispose(id);
}

/* ========================================================================== */
console.log('\n[adopt: seeded until a full redraw, then the same readings]');
{
  const f = load('r6-draft');
  const id = 'fx-adopt';
  row(id);
  table.setSize(id, 140, 50, Date.now() + 5);
  vs.create(id, { origin: 'adopt', link: 'homebase', hostKind: 'pty', vendor: 'claude-code' });
  eq(paneDiag(id).sync, 'seeded', 'adopted with a persisted size: seeded');
  let from = -Infinity;
  const beforeReset = f.marks.filter((m) => m.t < 1790340487);
  for (const m of beforeReset) {
    await replay(id, f.events, from, m.t);
    from = m.t;
    eq(`${reading(id).composer}/${reading(id).evidence}`, 'unknown/sync.seeded', `adopted @${m.t}: unknown until a redraw (${m.note})`);
  }
  await replay(id, f.events, from, Infinity);
  eq(paneDiag(id).sync, 'synced', "claude's reset shape (ESC[H, 50 x ESC[2K ESC[1B, ESC[H) promotes it");
  eq(paneDiag(id).syncCause, 'cc.reset', 'cause recorded');
  ok(typeof paneDiag(id).recoveryMs === 'number', 'natural recovery time recorded');
  eq(logOf('sync', id).at(-1)?.cause, 'cc.reset', 'a `sync` log entry carries the cause');
  vs.dispose(id);
}

/* ========================================================================== */
console.log('\n[redraw state machine, parse order, across chunk splits]');
{
  const f = load('r6-draft');
  const out = f.events.filter((e) => e.dir === 'out').map((e) => e.data!).join('');
  const resetAt = out.indexOf(`${ESC}[H${ESC}[2K${ESC}[1B`);
  ok(resetAt > 0, 'the r6 stream holds the reset shape');
  /* Seed with a tail cut MID-SEQUENCE, then feed the rest in 1-7 char chunks. */
  const cut = out.indexOf(`${ESC}[`, 20000) + 2; // lands inside a CSI
  for (const [label, sizes] of [
    ['single characters', [1]],
    ['odd chunks', [1, 2, 3, 5, 7]],
  ] as const) {
    const id = `split-${sizes.length}`;
    row(id);
    table.setSize(id, 140, 50, Date.now() + 5);
    vs.create(id, { origin: 'adopt', link: 'homebase', hostKind: 'pty', vendor: 'claude-code' });
    vs.seed(id, out.slice(0, cut));
    const rest = out.slice(cut);
    let i = 0;
    let k = 0;
    while (i < rest.length) {
      const n = sizes[k++ % sizes.length];
      vs.feed(id, rest.slice(i, i + n));
      i += n;
    }
    await vs._settle(id);
    eq(paneDiag(id).sync, 'synced', `seed cut mid-sequence, rest in ${label}: the reset is still seen`);
    eq(reading(id).composer === 'unknown' || reading(id).composer === 'clean', true, `${label}: reading is sane after /exit`);
    vs.dispose(id);
  }
}
{
  const fresh = async (id: string, rows = 10) => {
    row(id);
    table.setSize(id, 40, rows, Date.now() + 5);
    vs.create(id, { origin: 'adopt', link: 'homebase', hostKind: 'pty', vendor: 'claude-code' });
    vs.seed(id, 'old screen text\r\n');
    await vs._settle(id);
  };
  const shape = (n: number) => `${ESC}[H${`${ESC}[2K${ESC}[1B`.repeat(n)}${ESC}[H`;
  const cases: Array<[string, string, string]> = [
    ['reset shape at N = rows', shape(10), 'synced'],
    ['reset shape at N != rows', shape(9), 'seeded'],
    ['reset shape at N > rows', shape(12), 'seeded'],
    ['ESC[2J then ESC[H', `${ESC}[2J${ESC}[H`, 'synced'],
    ['ESC[2J then ESC[5;1H (any absolute CUP)', `${ESC}[2J${ESC}[5;1Hx`, 'synced'],
    ['ESC[2J, a PRINT, then ESC[H', `${ESC}[2Jhello${ESC}[H`, 'seeded'],
    ['ESC[2J, a relative move, then ESC[H', `${ESC}[2J${ESC}[3A${ESC}[H`, 'seeded'],
    ['ESC[2J, CHA (column-only), then ESC[H', `${ESC}[2J${ESC}[5G${ESC}[H`, 'seeded'],
    ['ESC[3J then ESC[H (scrollback erase is not a marker)', `${ESC}[3J${ESC}[H`, 'seeded'],
    ['ESC[J then ESC[H (partial erase)', `${ESC}[J${ESC}[H`, 'seeded'],
    ['RIS', `${ESC}c`, 'synced'],
    ['ESC[2J with no CUP after it', `${ESC}[2J`, 'seeded'],
  ];
  for (const [label, bytes, want] of cases) {
    const id = `sm-${label}`;
    await fresh(id);
    for (const ch of bytes) {
      vs.feed(id, ch); // one character at a time: parse order, not a post-parse view
    }
    await vs._settle(id);
    eq(paneDiag(id).buffers.normal, want, label);
    vs.dispose(id);
  }
  /* Per-buffer sync + ?1049. */
  {
    const id = 'sm-alt';
    await fresh(id);
    vs.feed(id, `${ESC}[?1049h${ESC}[H`);
    await vs._settle(id);
    eq(paneDiag(id).buffers.alternate, 'synced', '?1049h + ESC[H: the ALTERNATE buffer is synced');
    eq(paneDiag(id).buffers.normal, 'seeded', '...the normal buffer is not');
    eq(reading(id).evidence, 'cc.altscreen', 'the alternate screen reads unknown (fullscreen renderer)');
    vs.feed(id, `${ESC}[?1049l`);
    await vs._settle(id);
    eq(reading(id).sync, 'seeded', '?1049l back to a never-synced normal buffer: seeded (demoted)');
    vs.dispose(id);
    const id2 = 'sm-alt-print';
    await fresh(id2);
    vs.feed(id2, `${ESC}[?1049hx${ESC}[H`);
    await vs._settle(id2);
    eq(paneDiag(id2).buffers.alternate, 'seeded', '?1049h, a print, then ESC[H: not a marker');
    vs.dispose(id2);
  }
  /* A marker INSIDE the seed never promotes. */
  {
    const id = 'sm-seed-marker';
    row(id);
    table.setSize(id, 40, 10, Date.now() + 5);
    vs.create(id, { origin: 'adopt', link: 'homebase', hostKind: 'pty', vendor: 'claude-code' });
    vs.seed(id, `junk${ESC}c${ESC}[2J${ESC}[H${shape(10)}more`);
    await vs._settle(id);
    eq(paneDiag(id).sync, 'seeded', 'RIS / 2J+CUP / the reset shape inside a SEED do not count');
    vs.dispose(id);
  }
}

/* ========================================================================== */
console.log('\n[gaps: close demotes at once, pre-gap markers do not count, open re-seeds]');
{
  const id = 'gap-1';
  spawn(id, 40, 10);
  vs.feed(id, `${ESC}[H${`${ESC}[2K${ESC}[1B`.repeat(10)}`); // a reset shape, still queued...
  vs.gap('homebase', 'close'); // ...when the link drops
  vs.feed(id, `${ESC}[H`); // closes the shape — but its opening half was parsed across the gap
  eq(paneDiag(id).sync, 'seeded', 'link close: seeded immediately');
  await vs._settle(id);
  eq(paneDiag(id).sync, 'seeded', 'a marker in bytes queued before the gap does not promote');
  eq(logOf('gap', id).at(-1)?.phase, 'close', 'gap close logged');
  vs.gap('other-link', 'close');
  vs.gap('homebase', 'open', { [id]: `${ESC}[2Jtail` });
  await vs._settle(id);
  eq(paneDiag(id).sync, 'seeded', 'link open: reset + re-seed from the replay, still seeded');
  vs.feed(id, `${ESC}c`);
  await vs._settle(id);
  eq(paneDiag(id).sync, 'synced', 'a live marker after the re-seed promotes');
  vs.dispose(id);
}

/* ========================================================================== */
console.log('\n[size persistence across relaunch]');
{
  const id = 'size-1';
  saved.length = 0;
  spawn(id, 80, 24);
  let r = table.get(id)!;
  eq(`${r.cols}x${r.rows}`, '80x24', 'spawn writes 80x24 at once (leading edge)');
  ok((r.size_at ?? 0) >= (r.started_at ?? Infinity), 'size_at >= started_at');
  vs.resize(id, 120, 40);
  eq(`${table.get(id)!.cols}x${table.get(id)!.rows}`, '80x24', 'a resize inside the same second waits (at most 1 write/s)');
  vs.resize(id, 130, 45);
  await sleep(1100);
  eq(`${table.get(id)!.cols}x${table.get(id)!.rows}`, '130x45', 'the trailing edge writes the LAST size');
  eq(saved.filter((s) => s[0] === id).length, 2, 'two writes for three sizes');
  await sleep(1050);
  vs.resize(id, 100, 30);
  eq(`${table.get(id)!.cols}x${table.get(id)!.rows}`, '100x30', 'after a quiet second, the leading edge writes at once');
  /* RELAUNCH into the SAME paneid: upsert's ON CONFLICT keeps the old size. */
  await sleep(5);
  row(id);
  r = table.get(id)!;
  eq(`${r.cols}x${r.rows}`, '100x30', 'the relaunch upsert leaves the old size (why spawn writes its own)');
  ok((r.size_at ?? 0) < (r.started_at ?? 0), '...stamped before the new started_at');
  vs.create(id, { origin: 'adopt', link: 'homebase', hostKind: 'pty', vendor: 'claude-code' });
  eq(paneDiag(id).sync, 'sizeless', 'adopting a row whose size predates started_at: sizeless');
  eq(reading(id).evidence, 'sync.sizeless', 'reads unknown (sync.sizeless)');
  vs.create(id, { origin: 'spawn', link: 'homebase', hostKind: 'pty', vendor: 'claude-code', cols: 80, rows: 24 });
  r = table.get(id)!;
  eq(`${r.cols}x${r.rows}`, '80x24', 'the relaunch spawn writes 80x24 again');
  vs.create(id, { origin: 'adopt', link: 'homebase', hostKind: 'pty', vendor: 'claude-code' });
  eq(`${paneDiag(id).sync} ${paneDiag(id).cols}x${paneDiag(id).rows}`, 'seeded 80x24', 'so an engine restart adopts it at 80x24');
  /* A resize sent while the link is closed was DROPPED by sendCmd: sizeless. */
  linkUp = false;
  vs.resize(id, 90, 30);
  eq(paneDiag(id).sync, 'sizeless', 'resize while the link is closed: sizeless');
  eq(logOf('sizeless', id).length > 0, true, 'logged');
  await sleep(1100);
  eq(table.get(id)!.cols, null, 'sizeless is persisted (null) so a restart does not trust the old size');
  linkUp = true;
  replayFor[id] = `${ESC}[2Jsomething`;
  vs.resize(id, 90, 30);
  await vs._settle(id);
  eq(`${paneDiag(id).sync} ${paneDiag(id).cols}x${paneDiag(id).rows}`, 'seeded 90x30', 'the first size on an open link: reset + re-seed, seeded');
  vs.dispose(id);
}

/* ========================================================================== */
console.log('\n[provisional window + height-increase demote]');
{
  const f = load('r6-draft');
  const id = 'prov-1';
  spawn(id, f.cols, f.rows);
  await replay(id, f.events, -Infinity, 1790340480);
  eq(reading(id).composer, 'clean', 'a settled bare box');
  vs.resize(id, 140, 60);
  await vs._settle(id);
  eq(reading(id).evidence, 'resize.provisional', 'after a resize: provisional (unknown)');
  await sleep(1100);
  eq(reading(id).evidence, 'cc.composer.blank', 'after 1s of quiet: read again (height increase kept the anchor)');
  eq(paneDiag(id).sync, 'synced', '...and stays synced');
  vs.resize(id, 140, 70);
  vs.feed(id, `${ESC}[H${'x'.repeat(140 * 60)}`); // overwrites the box: anchor lost
  await sleep(1300);
  eq(paneDiag(id).sync, 'seeded', 'height increase that LOSES the anchor: demoted to seeded');
  eq(logOf('resize-demote', id).length, 1, 'resize-demote logged');
  vs.resize(id, 100, 70);
  await vs._settle(id);
  eq(reading(id).evidence, 'sync.seeded', 'a seeded pane reads seeded, not provisional');
  vs.feed(id, `${ESC}[H${`${ESC}[2K${ESC}[1B`.repeat(70)}${ESC}[H`);
  await vs._settle(id);
  eq(paneDiag(id).sync, 'synced', 'the reset at the NEW rows promotes and ends the window');
  eq(paneDiag(id).provisional, false, 'a redraw marker ends the provisional window');
  vs.dispose(id);
}

/* ========================================================================== */
console.log('\n[combineDraft: the §5 table]');
{
  const base = {
    screen: { composer: 'clean' as const, sync: 'synced' as const, pending: false, provisional: false, parsedAt: 1000, boxChangedAt: 1000 },
    input: { state: 'clean' as const, certain: false, uncertain: false },
    lastInputAt: null as number | null,
    lastGrowAt: null as number | null,
    now: 5000,
    echoMs: 300,
    settleMs: 1500,
    authority: ['draft'] as Array<'draft' | 'draft-certain'>,
  };
  const c = (o: Record<string, unknown>) => vs.combineDraft({ ...base, ...o } as never);
  eq(c({ screen: { ...base.screen, composer: 'draft' } }).row, 1, 'row 1: fresh screen draft wins');
  eq(c({ screen: { ...base.screen, composer: 'draft' }, input: { state: 'unobserved', certain: false, uncertain: false } }).result, 'draft', 'row 1 on an unobserved pane holds (the box is visible)');
  eq(c({}).row, 2, 'row 2: fresh clean + input clean');
  eq(c({ input: { state: 'unobserved', certain: false, uncertain: false } }).row, 2, 'row 2: fresh clean + unobserved');
  const esc = { input: { state: 'draft', certain: false, uncertain: true }, lastInputAt: 3000 };
  eq(c(esc).row, 3, 'row 3: an uncertain draft (Esc/Tab/↑) is lowered by a fresh clean screen');
  const certain = { input: { state: 'draft', certain: true, uncertain: false }, lastInputAt: 3000, lastGrowAt: 3000 };
  eq(c({ ...certain, screen: { ...base.screen, boxChangedAt: 3500, parsedAt: 3500 } }).row, 5, 'a CERTAIN draft is never lowered without draft-certain (never zero len > 0)');
  eq(c({ ...certain, screen: { ...base.screen, boxChangedAt: 3500, parsedAt: 3500 }, authority: ['draft', 'draft-certain'] }).row, 4, 'row 4 only under draft-certain');
  eq(c({ ...certain, screen: { ...base.screen, boxChangedAt: 2000, parsedAt: 3500 }, authority: ['draft', 'draft-certain'] }).row, 5, 'boxMoved false (echo not repainted the box): never lowered');
  eq(c({ input: { state: 'unobserved', certain: false, uncertain: false }, screen: { ...base.screen, sync: 'seeded' } }).row, 6, 'row 6: unobserved stays unobserved');
  /* Freshness. */
  eq(c({ ...esc, now: 3200, screen: { ...base.screen, parsedAt: 3100 } }).fresh, false, 'inside ECHO_MS: not fresh');
  eq(c({ ...esc, now: 3400, screen: { ...base.screen, parsedAt: 3100 } }).fresh, true, 'type-then-echo: fresh after ECHO_MS once a parse followed the input');
  eq(c({ ...esc, now: 3400, screen: { ...base.screen, parsedAt: 2900 } }).fresh, false, 'a stalled echo (no parse since the key): not fresh before settleMs');
  eq(c({ ...esc, now: 4600, screen: { ...base.screen, parsedAt: 2900 } }).row, 3, 'Esc on an empty box (no output at all): lowered once settleMs has passed');
  eq(c({ ...certain, now: 4600, screen: { ...base.screen, parsedAt: 2900, boxChangedAt: 2900 } }).row, 5, 'a stalled echo can never lower a certain draft');
  eq(c({ screen: { ...base.screen, pending: true } }).fresh, false, 'pending: not fresh');
  eq(c({ screen: { ...base.screen, provisional: true } }).fresh, false, 'provisional: not fresh');
}

/* ========================================================================== */
console.log('\n[shadow log end to end]');
{
  const f = load('r6-draft');
  /* Esc on an empty box: the input guard goes `unknown` (a false hold), the
     screen stays clean. The P1 target: logged, row 3, inputCertain false. */
  const id = 'shadow-esc';
  spawn(id, f.cols, f.rows);
  activity.onLive(id);
  await replay(id, f.events, -Infinity, 1790340428.0); // placeholder
  eq(reading(id).composer, 'clean', 'placeholder box');
  activity.onInput(id, ESC);
  vs.onInput(id);
  eq(activity.draftState(id), 'draft', 'the input guard holds on a bare Esc (today’s false hold)');
  await sleep(450);
  const e = logOf('screen-clean/input-draft', id).at(-1);
  eq(e?.inputCertain, false, 'screen-clean/input-draft logged, UNCERTAIN class');
  eq(e?.row, 3, '...with the row P1 would apply (3)');
  eq(e?.p1, 'clean', '...and what P1 would have said');
  eq(e?.boxMoved, true, '...boxMoved (no content keystroke since the last submit)');
  eq(activity.draftState(id), 'draft', 'and NOTHING was written back: the guard still says draft');
  vs.dispose(id);
  activity.drop(id);
}
{
  /* The protective case: a draft on screen that the input guard never saw. */
  const f = load('r6-draft');
  const id = 'shadow-planted';
  spawn(id, f.cols, f.rows);
  await replay(id, f.events, -Infinity, 1790340445.0); // draft typed, NOT through the guard
  const e = logOf('screen-draft/input-clean', id).at(-1);
  eq(e?.input, 'unobserved', 'screen-draft/input-clean logged (input unobserved)');
  eq(e?.row, 1, '...P1 row 1 would hold');
  vs.dispose(id);
}
{
  /* The full r6 session with its REAL keystrokes through the guard: every
     comparison agrees or is a coverage gap — no disagreement. */
  const f = load('r6-draft');
  const id = 'shadow-real';
  spawn(id, f.cols, f.rows);
  activity.onLive(id);
  await replay(id, f.events, -Infinity, Infinity, true);
  await sleep(450);
  const d = paneDiag(id);
  eq(d.counts.evals['screen-draft/input-clean'] ?? 0, 0, 'real keystrokes: no screen-draft/input-clean');
  eq(d.counts.evals['screen-clean/input-draft'] ?? 0, 0, 'real keystrokes: no screen-clean/input-draft');
  ok((d.counts.evals.agree ?? 0) > 0, 'screen and guard agree');
  vs.dispose(id);
  activity.drop(id);
}
{
  /* engine-inject: the engine's own typing is tagged, never a disagreement. */
  const f = load('r6-draft');
  const id = 'shadow-inject';
  spawn(id, f.cols, f.rows);
  await replay(id, f.events, -Infinity, 1790340428.0); // clean placeholder
  vs.noteInject(id, 'room-typer');
  await replay(id, f.events, 1790340428.0, 1790340445.0); // text appears in the box
  eq(logOf('engine-inject', id).length > 0, true, 'readings inside the inject window are engine-inject');
  eq(logOf('screen-draft/input-clean', id).length, 0, '...not screen-draft/input-clean');
  eq(logOf('typed-into-draft', id).length, 0, 'typed into a CLEAN box: no typed-into-draft');
  await sleep(450);
  vs.noteInject(id, 'room-typer'); // now the box shows the draft (the Enter was "swallowed")
  eq(logOf('typed-into-draft', id).length, 1, 'typed while a fresh screen showed a draft: logged');
  ok(lines.some((l) => l.includes(id) && l.includes('typed a line while the screen showed a draft')), '...with one text-free log line');
  vs.dispose(id);
}

/* ========================================================================== */
console.log('\n[P0 changes NO consumer behaviour: room-typer types into a screen draft]');
for (const m of ['off', 'shadow']) {
  process.env.HARBOR_WB_VSCREEN = m;
  vs._refreshMode();
  const f = load('r6-draft');
  const id = `consumer-${m}`;
  const writes: string[] = [];
  row(id);
  sessions.add(id, { state: 'live', pty: { write: (d: string) => writes.push(d), resize: () => writes.push('RESIZE') } } as never, null as never);
  vs.create(id, { origin: 'spawn', link: 'homebase', hostKind: 'pty', vendor: 'claude-code', cols: f.cols, rows: f.rows });
  activity.onLive(id);
  await replay(id, f.events, -Infinity, 1790340445.0); // the screen shows a draft
  eq(typer.enqueue(id, 'r1', 1, 'Room', 'user', 'hello'), 'injected', `${m}: the room line is typed (P0 never holds on the screen)`);
  await sleep(40);
  eq(writes.join('|'), '[room Room · @user · #1] hello (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)|\r', `${m}: exactly the typer's own writes reach the pty — nothing from the model`);
  eq(activity.draftState(id), 'unobserved', `${m}: the input guard is untouched`);
  eq(vs._terminal(id) === null, m === 'off', `${m}: ${m === 'off' ? 'no terminal at all' : 'a terminal exists'}`);
  if (m === 'shadow') {
    eq(logOf('typed-into-draft', id).length, 1, 'shadow: the typed-into-draft entry is the ONLY difference');
  } else {
    eq(paneDiag(id).sync, 'off', 'off: the pane reads off');
  }
  sessions.remove(id);
  eq(vs.reading(id), null, `${m}: sessions.onRemove disposes the record`);
  activity.drop(id);
  typer.reset();
}
process.env.HARBOR_WB_VSCREEN = 'off';
vs._refreshMode();
{
  saved.length = 0;
  const before = lines.length;
  const id = 'off-quiet';
  spawn(id);
  vs.feed(id, `${ESC}[2Jhello`);
  vs.resize(id, 100, 30);
  vs.gap('homebase', 'close');
  vs.onInput(id);
  vs.noteInject(id, 'room-typer');
  await sleep(50);
  eq(saved.length, 0, 'off: no size is persisted');
  eq(lines.length, before, 'off: nothing is logged');
  eq(vs._terminal(id), null, 'off: no terminal');
  vs.dispose(id);
}
process.env.HARBOR_WB_VSCREEN = 'shadow';
vs._refreshMode();

/* ========================================================================== */
console.log('\n[mode: config.json mtime re-read, env wins, only `shadow` enables]');
{
  const cfg = join(dir, 'config.json');
  vs._setConfigPath(cfg);
  delete process.env.HARBOR_WB_VSCREEN;
  eq(vs._refreshMode(), 'off', 'no env, no config: default off');
  const id = 'live-switch';
  row(id);
  vs.create(id, { origin: 'spawn', link: 'homebase', hostKind: 'pty', vendor: 'claude-code', cols: 40, rows: 10 });
  replayFor[id] = `${ESC}[2Jx`;
  writeFileSync(cfg, JSON.stringify({ vscreen: { mode: 'shadow' } }));
  utimesSync(cfg, new Date(), new Date(Date.now() + 2000));
  eq(vs._refreshMode(), 'shadow', 'config.json vscreen.mode=shadow switches it on, no restart');
  ok(vs._terminal(id) !== null, 'an existing pane gets a terminal live...');
  eq(paneDiag(id).sync, 'seeded', '...seeded from the replay (not trusted as synced)');
  writeFileSync(cfg, '{ "vscreen": { "mode": ');
  utimesSync(cfg, new Date(), new Date(Date.now() + 4000));
  eq(vs._refreshMode(), 'shadow', 'a half-written config.json keeps the last good mode (no flap)');
  writeFileSync(cfg, JSON.stringify({ vscreen: { mode: 'off' } }));
  utimesSync(cfg, new Date(), new Date(Date.now() + 6000));
  eq(vs._refreshMode(), 'off', 'and back off live (the kill switch)');
  eq(vs._terminal(id), null, 'the terminal is dropped');
  process.env.HARBOR_WB_VSCREEN = 'on';
  eq(vs._refreshMode(), 'off', 'env HARBOR_WB_VSCREEN=on is NOT a P0 value: off');
  process.env.HARBOR_WB_VSCREEN = 'shadow';
  eq(vs._refreshMode(), 'shadow', 'env wins over config');
  vs.dispose(id);
}

/* ========================================================================== */
console.log('\n[vendor + host kind]');
{
  spawn('gen-1', 80, 24, 'cli-manager');
  eq(vs._terminal('gen-1'), null, 'a generic vendor gets no terminal (nothing to classify in P0)');
  eq(reading('gen-1').evidence, 'generic', 'and always reads unknown (generic)');
  spawn('cp-1', 80, 24, 'claude-code', 'conpty');
  eq(paneDiag('cp-1').signature.verified, false, 'claude-code on ConPTY: shadow signature, UNVERIFIED');
  vs.dispose('gen-1');
  vs.dispose('cp-1');
}

/* ========================================================================== */
console.log('\n[fail-safety: throwing deps, garbage inputs, parser throws, breaker]');
{
  const boom = () => {
    throw new Error('boom');
  };
  vs.setDeps({ log: boom, linkOpen: boom, replayOf: boom, saveSize: boom, loadSize: boom });
  let threw = 0;
  const tryIt = (fn: () => unknown) => {
    try {
      fn();
    } catch {
      threw++;
    }
  };
  tryIt(() => vs.create('fs-1', { origin: 'adopt', link: 'homebase', hostKind: 'pty', vendor: 'claude-code' }));
  tryIt(() => vs.create('fs-2', { origin: 'spawn', link: 'homebase', hostKind: 'pty', vendor: 'claude-code' }));
  tryIt(() => vs.seed('fs-2', 'x'));
  tryIt(() => vs.feed('fs-2', `${ESC}[2Jx`));
  tryIt(() => vs.resize('fs-2', 100, 40));
  tryIt(() => vs.gap('homebase', 'close'));
  tryIt(() => vs.gap('homebase', 'open', { 'fs-2': 'x' }));
  tryIt(() => vs.onInput('fs-2'));
  tryIt(() => vs.noteInject('fs-2', 'voice'));
  tryIt(() => vs.reading('fs-2'));
  tryIt(() => vs.diag());
  tryIt(() => vs.dispose('fs-2'));
  tryIt(() => vs.feed('nope', 'x'));
  tryIt(() => vs.feed(undefined as never, undefined as never));
  tryIt(() => vs.create(undefined as never, undefined as never));
  tryIt(() => vs.create('fs-3', { origin: 'spawn', link: 'homebase', hostKind: 'pty', vendor: 'claude-code' }));
  tryIt(() => vs.feed('fs-3', undefined as never));
  tryIt(() => vs.feed('fs-3', 42 as never));
  tryIt(() => vs.resize('fs-3', Number.NaN, -1));
  tryIt(() => vs.seed('fs-3', null as never));
  eq(threw, 0, 'no entry point throws, whatever the deps or inputs do');
  await sleep(50);
  vs.dispose('fs-1');
  vs.dispose('fs-3');
  vs.setDeps({
    log: (l) => lines.push(l),
    linkOpen: () => linkUp,
    replayOf: (id) => replayFor[id] ?? null,
    saveSize: (id, c, r, at) => table.setSize(id, c, r, at),
    loadSize: () => null,
  });
}
{
  /* A throw INSIDE xterm's parse (its own setTimeout): contained, pane off. */
  spawn('fs-parse', 40, 10);
  const term = vs._terminal('fs-parse')!;
  term.parser.registerCsiHandler({ final: 'z' }, () => {
    throw new Error('parser blew up');
  });
  vs.feed('fs-parse', `ab${ESC}[5zcd`);
  await sleep(60);
  vs.feed('fs-parse', 'more');
  eq(paneDiag('fs-parse').off, 'parse-error', 'a parser throw sends the pane off (parse-error)');
  eq(reading('fs-parse').evidence, 'sync.off', 'and it reads unknown');
  eq(uncaught, 0, 'no uncaughtException reached the process');
  vs.dispose('fs-parse');
}
{
  spawn('fs-rss', 80, 24);
  vs.resize('fs-rss', 2000, 1000);
  eq(paneDiag('fs-rss').off, 'budget-rss', 'a size far over budget trips the breaker (off, not an allocation)');
  vs.dispose('fs-rss');
  spawn('fs-lag', 80, 24);
  vs.feed('fs-lag', 'x');
  const until = Date.now() + LAG_BLOCK_MS();
  while (Date.now() < until) {
    /* block the loop: the queued parse cannot run */
  }
  vs.feed('fs-lag', 'y');
  eq(paneDiag('fs-lag').off, 'budget-lag', 'parsing > 2s behind the stream trips the breaker');
  vs.dispose('fs-lag');
}
function LAG_BLOCK_MS(): number {
  return 2100;
}

/* ========================================================================== */
console.log('\n[the headless terminal never writes: onData / onBinary never bound]');
{
  spawn('q-1', 80, 24);
  vs.feed('q-1', `${ESC}[c${ESC}[>c${ESC}[6n${ESC}[5n${ESC}]10;?\x07${ESC}[?1004h${ESC}[I${ESC}[?996n`);
  await vs._settle('q-1');
  eq(onDataTouched, 0, 'after DA / DSR / CPR / OSC / focus queries (and every test above): onData/onBinary never touched');
  const src = readFileSync(join(HERE, '..', 'src', 'engine', 'vscreen.ts'), 'utf8');
  eq(/\.(onData|onBinary)\s*\(/.test(src), false, 'vscreen.ts binds neither (source check)');
  /* The hazard is real: bound, the same queries DO produce replies. */
  const probe = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies: string[] = [];
  probe.onData((d) => replies.push(d));
  onDataTouched = 0;
  await new Promise<void>((r) => probe.write(`${ESC}[c${ESC}[6n`, () => r()));
  ok(replies.length > 0, 'sanity: a bound terminal answers those queries (what would be typed into the box)');
  probe.dispose();
  vs.dispose('q-1');
}

/* ========================================================================== */
console.log('\n[privacy: no text anywhere, closed evidence union]');
{
  const f = load('r6-draft');
  const id = 'priv-1';
  spawn(id, f.cols, f.rows);
  activity.onLive(id);
  await replay(id, f.events, -Infinity, Infinity, true);
  vs.noteInject(id, 'voice');
  await sleep(450);
  const blob = JSON.stringify(vs.diag()) + JSON.stringify(vs.diag(id)) + lines.join('\n');
  for (const planted of ['draft text not submitted', 'draft text', 'MANGO', 'log an error', 'Probe', 'Crunched', 'chan-probe', 'homeserver', 'Try "']) {
    eq(blob.includes(planted), false, `"${planted}" appears in no diag field, log entry or log line`);
  }
  const allowed = new Set<string>(vs.EVIDENCE);
  const seen = new Set<string>();
  const walk = (o: unknown, key = ''): void => {
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        walk(v, k);
      }
    } else if (key === 'evidence' && typeof o === 'string') {
      seen.add(o);
    }
  };
  walk(vs.diag());
  ok(seen.size > 0, 'evidence values were emitted');
  eq([...seen].every((e) => allowed.has(e)), true, `every evidence value is in the closed union (${[...seen].join(', ')})`);
  const byEv = (vs.diag().totals as any).unknownByEvidence as Record<string, number>;
  eq(Object.keys(byEv).every((k) => allowed.has(k)), true, 'evidence-keyed counts use the closed union too');
  vs.dispose(id);
  activity.drop(id);
}

/* ========================================================================== */
console.log('\n[bounded log: 200 per kind]');
{
  linkUp = false;
  for (let i = 0; i < 210; i++) {
    const id = `b-${i}`;
    spawn(id, 20, 5, 'cli-manager');
    vs.resize(id, 30, 6);
    vs.dispose(id);
  }
  linkUp = true;
  eq(logOf('sizeless').length, 200, 'a kind keeps at most 200 entries');
  ok(logOf('gap').length <= 200, 'other kinds are bounded separately');
}

vs._reset();
eq(uncaught, 0, 'no uncaughtException for the whole suite');
/* Windows refuses to unlink scratch.db while the in-process store holds it. */
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* held open by better-sqlite3 until exit */
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
