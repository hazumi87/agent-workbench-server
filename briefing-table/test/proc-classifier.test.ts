/**
 * /proc CLASSIFIER (src/engine/proc-classifier.ts; the design notes §4.1,
 * §4.4 item 9, §8) [ticket].
 *
 * Every case runs against a FAKE proc root built in a temp dir — never real
 * processes. Covers the §8 list: a descendant `claude -p` → background; a
 * non-descendant paneid claude → collision; flag pairs naming the id →
 * collision, a prompt quoting it → not; exact paneid match; state T →
 * suspended; after End: recorded pid + starttime, an interactive paneid claude
 * → collision, any other paneid process → leftover; EACCES → null. And guard
 * 9's `ownsTerminal`: a T claude, a stopped claude with bash in the
 * foreground, a claude with its own foreground child.
 *
 * Linux only: off Linux the classifier answers "could not tell" by design, so
 * there the suite asserts exactly that and SKIPS the fixture cases.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pc = await import('../src/engine/proc-classifier.ts');

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
if (process.platform !== 'linux') {
  console.log(`\n[${process.platform}: every read is "could not tell"]`);
  eq(pc.classify({ paneid: 'p', ids: [], phase: 'live' }), null, 'classify → null');
  eq(pc.claudeOwnsTerminal('p', { cached: false }), null, 'claudeOwnsTerminal → null (guard 9 delivers as today)');
  eq(pc.ownsTerminal(1), null, 'ownsTerminal → null');
  console.log('  - SKIPPED off Linux: the fixture cases need a /proc-shaped root and process uids');
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}

const same = (actual: unknown, expected: unknown, msg: string) => eq(JSON.stringify(actual), JSON.stringify(expected), msg);
const pids = (xs: Array<{ pid: number }> | undefined) => JSON.stringify((xs ?? []).map((x) => x.pid).sort((a, b) => a - b));

const dirs: string[] = [];
interface P {
  pid: number;
  comm: string;
  argv?: string[];
  pane?: string | null;
  state?: string;
  ppid?: number;
  pgrp?: number;
  tpgid?: number;
  start?: number;
  /** Session id (default: the pgrp) and controlling tty_nr (default 34816). */
  sid?: number;
  tty?: number;
  /** Where fd 0 / fd 1 point (default: the process's own pty, /dev/pts/N). */
  fd0?: string;
  fd1?: string;
}
/** A fake proc root: <pid>/{comm,cmdline,environ,stat}. */
function root(procs: P[]): string {
  const r = mkdtempSync(join(tmpdir(), 'wb-proc-'));
  dirs.push(r);
  mkdirSync(join(r, 'self')); // non-numeric entries are ignored
  for (const p of procs) {
    const d = join(r, String(p.pid));
    mkdirSync(d);
    writeFileSync(join(d, 'comm'), `${p.comm}\n`);
    writeFileSync(join(d, 'cmdline'), (p.argv ?? [p.comm]).join('\0') + '\0');
    writeFileSync(join(d, 'environ'), ['HOME=/home/x', ...(p.pane ? [`HARBOR_WB_PANEID=${p.pane}`] : []), 'TERM=xterm'].join('\0') + '\0');
    const pgrp = p.pgrp ?? p.pid;
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime prio nice threads itreal starttime …
    const f = [p.state ?? 'S', p.ppid ?? 1, pgrp, p.sid ?? pgrp, p.tty ?? 34816, p.tpgid ?? pgrp, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, p.start ?? p.pid * 10, 0, 0];
    writeFileSync(join(d, 'stat'), `${p.pid} (${p.comm}) ${f.join(' ')}\n`);
    mkdirSync(join(d, 'fd'));
    const own = pc.ptsPath(p.tty ?? 34816) ?? 'pipe:[1]';
    symlinkSync(p.fd0 ?? own, join(d, 'fd', '0'));
    symlinkSync(p.fd1 ?? own, join(d, 'fd', '1'));
  }
  return r;
}

const PANE = 'recipe:0000aaaa-0001';
const PANE_S = `${PANE}#4f7a4516`;
const ID = '83cf5d1a-0000-4000-8000-000000000001';
const LOCATED = '83cf5d1a-0000-4000-8000-000000000002';

console.log('\n[before End: the live claude, its background, collisions]');
{
  /* bash 100 → claude 101 (the pane's, owns the tty, pgrp 101 = tpgid)
       → claude -p 102 (a descendant) → sleep 103 ; node MCP 104 under 101.
     claude 200: same paneid, NOT a descendant (an orphan, ppid 1).
     claude 300: another pane, but its argv names our id as a flag pair.
     claude 400: another pane, a PROMPT that quotes our id.
     claude 500: paneid `recipe:X#s` — must not match `recipe:X`. */
  const r = root([
    { pid: 100, comm: 'bash', pane: PANE, pgrp: 100, tpgid: 101 },
    { pid: 101, comm: 'claude', argv: ['claude', '--resume', ID], pane: PANE, ppid: 100, pgrp: 101, tpgid: 101 },
    { pid: 102, comm: 'claude', argv: ['claude', '-p', 'summarise'], pane: PANE, ppid: 101, pgrp: 101 },
    { pid: 103, comm: 'sleep', argv: ['sleep', '30'], pane: PANE, ppid: 102, pgrp: 101 },
    { pid: 104, comm: 'node', argv: ['node', 'server.js'], pane: PANE, ppid: 101, pgrp: 101 },
    { pid: 200, comm: 'claude', argv: ['claude', '--session-id', 'other'], pane: PANE, ppid: 1, pgrp: 200, tpgid: -1 },
    { pid: 300, comm: 'claude', argv: ['claude', '-r', ID], pane: 'recipe:elsewhere', ppid: 1 },
    { pid: 400, comm: 'claude', argv: ['claude', `please look at --resume ${ID} for me`], pane: 'recipe:elsewhere2', ppid: 1 },
    { pid: 500, comm: 'claude', argv: ['claude'], pane: PANE_S, ppid: 1, tpgid: 500 },
  ]);
  const c = pc.classify({ paneid: PANE, ids: [ID], phase: 'live' }, r);
  eq(pids(c?.claude), '[101]', 'the live claude is the one that owns the terminal');
  eq(c?.claude[0]?.ownsTerminal, true, '...and says so');
  eq(pids(c?.background), '[102,103,104]', 'descendants (claude -p, sleep, node MCP) are background');
  eq(pids(c?.collisions), '[200,300]', 'a non-descendant paneid claude and a flag pair naming the id are collisions');
  eq(c?.collisions.some((x) => x.pid === 400), false, 'a prompt that merely QUOTES the id is not a collision');
  eq(c?.collisions.some((x) => x.pid === 500), false, 'recipe:X#s never matches recipe:X');
  eq(pids(c?.suspended), '[]', 'nothing stopped');
  eq(pids(c?.leftovers), '[]', 'no leftovers before End');
  const cs = pc.classify({ paneid: PANE_S, ids: [], phase: 'live' }, r);
  eq(pids(cs?.claude), '[500]', 'and recipe:X#s finds its own claude only');
  eq(pids(cs?.collisions), '[]', '...with no collision from recipe:X');
}

console.log('\n[before End: a stopped claude reports suspended]');
{
  /* The F2 orphan shape: state T, ppid 1, tpgid -1 — and the pane's own claude exited. */
  const r = root([
    { pid: 10, comm: 'bash', pane: PANE, pgrp: 10, tpgid: 10 },
    { pid: 11, comm: 'claude', argv: ['claude', '--session-id', ID], pane: PANE, state: 'T', ppid: 1, pgrp: 11, tpgid: -1 },
  ]);
  const c = pc.classify({ paneid: PANE, ids: [ID], phase: 'live' }, r);
  eq(pids(c?.claude), '[]', 'no live claude (the only one is stopped)');
  eq(pids(c?.suspended), '[11]', 'state T → suspended, not a plain collision');
  eq(pids(c?.collisions), '[]', '...and not listed twice');
}

console.log('\n[after End / at restore]');
{
  const r = root([
    { pid: 20, comm: 'claude', argv: ['claude', '--resume', ID], pane: 'recipe:other', ppid: 1, start: 777 }, // recorded pid+starttime
    { pid: 21, comm: 'claude', argv: ['claude', '--resume', LOCATED], pane: 'recipe:other2', ppid: 1 }, // names the LOCATED id
    { pid: 22, comm: 'claude', argv: ['claude'], pane: PANE, ppid: 1 }, // interactive, this paneid
    { pid: 23, comm: 'claude', argv: ['claude', '--print', 'x'], pane: PANE, ppid: 1 }, // non-interactive: a leftover
    { pid: 24, comm: 'sleep', argv: ['sleep', '5'], pane: PANE, ppid: 1 }, // any comm: a leftover
    { pid: 25, comm: 'claude', argv: ['claude'], pane: PANE_S, ppid: 1 }, // not ours
    { pid: 26, comm: 'bash', pane: null, ppid: 1 },
  ]);
  const c = pc.classify({ paneid: PANE, ids: [ID, LOCATED], phase: 'ended', recorded: { pid: 20, starttime: 777 } }, r);
  eq(pids(c?.collisions), '[20,21,22]', 'recorded pid+starttime, a flag pair on the located id, an interactive paneid claude');
  eq(c?.collisions.map((x) => x.match).join(','), 'id,id,pane', 'match kinds: recorded and flag pair = id; a paneid claude naming no uuid = pane');
  eq(pids(c?.leftovers), '[23,24]', 'any other process carrying the paneid is a leftover (named, warns only)');
  eq(pids(c?.claude), '[]', 'no "live claude" after End');
  {
    // S0 ride fix, guard 7 (iii): a STOPPED orphan on this pane that names ANOTHER conversation
    const r2 = root([
      { pid: 40, comm: 'claude', argv: ['claude', '--model', 'opus', '--session-id', '83cf5d1a-0000-4000-8000-000000000000'], pane: PANE, ppid: 1, state: 'T' },
      { pid: 41, comm: 'claude', argv: ['claude', '--resume', 'my-name'], pane: PANE, ppid: 1 },
    ]);
    const c3 = pc.classify({ paneid: PANE, ids: [ID], phase: 'ended' }, r2);
    eq(c3?.collisions.map((x) => `${x.pid}:${x.match}`).join(','), '40:pane-other,41:pane', 'a paneid claude naming another uuid = pane-other; a resume NAME is no uuid = pane');
    const c4 = pc.classify({ paneid: PANE, ids: [], phase: 'ended' }, r2);
    eq(c4?.collisions.find((x) => x.pid === 40)?.match, 'pane-other', 'a named restore (no ids): the uuid is still another conversation');
    eq(pc.namesOtherId(['claude', '--resume', ID], [ID]), false, 'namesOtherId: the restored id itself is not another');
  }
  const moved = pc.classify({ paneid: PANE, ids: [], phase: 'ended', recorded: { pid: 20, starttime: 778 } }, r);
  eq(moved?.collisions.some((x) => x.pid === 20), false, 'a reused pid with a different starttime is not the recorded claude');
  // Guard 7: a collider's start, for the just-ended wait and the refusal text.
  const noClock = c?.collisions.find((x) => x.pid === 20);
  eq(noClock?.lstart, null, 'no /proc/stat btime: lstart null (the refusal says so, it does not guess)');
  eq(noClock?.startedAt, null, 'no /proc/uptime: startedAt null');
  const BTIME = 1_790_000_000;
  writeFileSync(join(r, 'stat'), `cpu  1 2 3 4\nbtime ${BTIME}\nprocesses 9\n`);
  writeFileSync(join(r, 'uptime'), '1000.50 4000.00\n');
  const t0 = Date.now();
  const c2 = pc.classify({ paneid: PANE, ids: [ID, LOCATED], phase: 'ended', recorded: { pid: 20, starttime: 777 } }, r);
  const hit = c2?.collisions.find((x) => x.pid === 20);
  eq(hit?.lstart, pc.lstartOf(BTIME + 7), 'lstart = btime + starttime/100 (whole seconds), as ps computes it');
  eq(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 1-3][0-9] [0-2][0-9]:[0-5][0-9]:[0-5][0-9] [0-9]{4}$/.test(hit?.lstart ?? ''), true, '...in ps\'s ctime shape');
  const want = t0 - 1000.5 * 1000 + 7770;
  eq(Math.abs((hit?.startedAt ?? 0) - want) < 1000, true, 'startedAt = boot (now - uptime) + starttime x 10 ms');
}
{
  const d = Date.UTC(2026, 8, 5, 14, 3, 12);
  eq(pc.lstartOf(Math.floor(d / 1000)), 'Sat Sep  5 14:03:12 2026', 'lstartOf: ctime\'s 24 chars, day of month space-padded, in UTC (TZ=UTC ps)');
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles'; // an agent shell's zone: the value must not move with it
  eq(pc.lstartOf(Math.floor(d / 1000)), 'Sat Sep  5 14:03:12 2026', 'lstartOf does not depend on the process TZ');
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
}

console.log('\n[guard 9: ownsTerminal]');
{
  const r = root([
    // a T claude
    { pid: 30, comm: 'claude', argv: ['claude'], pane: 'recipe:t', state: 'T', pgrp: 30, tpgid: 30 },
    // a stopped claude, bash in the foreground (tpgid = bash's pgrp)
    { pid: 40, comm: 'bash', pane: 'recipe:bg', pgrp: 40, tpgid: 40 },
    { pid: 41, comm: 'claude', argv: ['claude'], pane: 'recipe:bg', ppid: 40, pgrp: 41, tpgid: 40 },
    // claude with its own foreground child in a new group
    { pid: 50, comm: 'bash', pane: 'recipe:fg', pgrp: 50, tpgid: 52 },
    { pid: 51, comm: 'claude', argv: ['claude'], pane: 'recipe:fg', ppid: 50, pgrp: 51, tpgid: 52 },
    { pid: 52, comm: 'vim', argv: ['vim'], pane: 'recipe:fg', ppid: 51, pgrp: 52, tpgid: 52 },
    // a healthy claude
    { pid: 60, comm: 'claude', argv: ['claude'], pane: 'recipe:ok', pgrp: 60, tpgid: 60 },
    // only a print-mode claude in this pane
    { pid: 70, comm: 'claude', argv: ['claude', '-p', 'x'], pane: 'recipe:print', pgrp: 70, tpgid: 70 },
  ]);
  eq(pc.ownsTerminal(30, r), false, 'a T claude does not own the terminal');
  eq(pc.ownsTerminal(41, r), false, 'bash in the foreground (tpgid ≠ its pgrp): no');
  eq(pc.ownsTerminal(51, r), true, 'its own foreground child (a group descended from it): yes');
  eq(pc.ownsTerminal(60, r), true, 'tpgid = pgrp: yes');
  pc.resetCache();
  eq(pc.claudeOwnsTerminal('recipe:t', { cached: false, root: r }), false, 'pane with a T claude → held');
  eq(pc.claudeOwnsTerminal('recipe:bg', { cached: false, root: r }), false, 'pane where bash owns the tty → held');
  eq(pc.claudeOwnsTerminal('recipe:fg', { cached: false, root: r }), true, 'pane whose claude runs a foreground child → delivers');
  eq(pc.claudeOwnsTerminal('recipe:ok', { cached: false, root: r }), true, 'healthy pane → delivers');
  eq(pc.claudeOwnsTerminal('recipe:print', { cached: false, root: r }), false, 'a print-mode claude is not the interactive one');
  eq(pc.claudeOwnsTerminal('recipe:none', { cached: false, root: r }), false, 'no claude at all → false (the caller decides the pane is local)');
  const ru = root([
    { pid: 110, comm: 'bash', pane: 'recipe:up', pgrp: 110, tpgid: 111 },
    { pid: 111, comm: 'claude', argv: ['claude', 'update'], pane: 'recipe:up', ppid: 110, pgrp: 111, tpgid: 111 },
    { pid: 120, comm: 'bash', pane: 'recipe:mcp', pgrp: 120, tpgid: 121 },
    { pid: 121, comm: 'claude', argv: ['claude', 'mcp', 'list'], pane: 'recipe:mcp', ppid: 120, pgrp: 121, tpgid: 121 },
  ]);
  eq(pc.claudeOwnsTerminal('recipe:up', { cached: false, root: ru }), false, 'P0 review: `claude update` in the foreground over bash → held (a typed line would wait for bash)');
  eq(pc.claudeOwnsTerminal('recipe:mcp', { cached: false, root: ru }), false, '`claude mcp list` in the foreground → held');
  eq(pc.claudeOwner('recipe:up', { cached: false, root: ru }), 'not-repl', 'review 2 P2: a claude owns the pty but is not its REPL → \'not-repl\' (the hold can say so)');
  eq(pc.claudeOwner('recipe:none', { cached: false, root: ru }), 'none', 'no claude at all → \'none\'');

  console.log('\n[findings #1/#9: ownership is pinned to the PANE\'S tty]');
{
  /* The pane: broker (no paneid) → bash 100, session leader on tty A, in the
     foreground; its claude 101 is stopped. Elsewhere a claude with the SAME
     paneid owns ANOTHER tty — under `script` (which carries the paneid), in a
     tmux window (tmux server carries it), or `tmux new claude` itself. */
  const A = 34816;
  const B = 34830;
  const shapes: Array<[string, P[]]> = [
    ['script -qc claude', [
      { pid: 250, comm: 'script', argv: ['script', '-qc', 'claude'], pane: 'P1', ppid: 100, pgrp: 250, sid: 100, tty: A },
      { pid: 300, comm: 'claude', argv: ['claude'], pane: 'P1', ppid: 250, pgrp: 300, sid: 300, tty: B, tpgid: 300 },
    ]],
    ['a tmux window', [
      { pid: 400, comm: 'tmux: server', argv: ['tmux'], pane: 'P1', ppid: 1, pgrp: 400, sid: 400, tty: 0, tpgid: -1 },
      { pid: 410, comm: 'bash', pane: 'P1', ppid: 400, pgrp: 410, sid: 410, tty: B, tpgid: 411 },
      { pid: 411, comm: 'claude', argv: ['claude'], pane: 'P1', ppid: 410, pgrp: 411, sid: 410, tty: B, tpgid: 411 },
    ]],
    ['tmux new claude', [
      { pid: 400, comm: 'tmux: server', argv: ['tmux'], pane: 'P1', ppid: 1, pgrp: 400, sid: 400, tty: 0, tpgid: -1 },
      { pid: 420, comm: 'claude', argv: ['claude'], pane: 'P1', ppid: 400, pgrp: 420, sid: 420, tty: B, tpgid: 420 },
    ]],
  ];
  const pane: P[] = [
    { pid: 99, comm: 'node', argv: ['node', 'broker'], pane: null, pgrp: 99, sid: 99, tty: 0, tpgid: -1 },
    { pid: 100, comm: 'bash', pane: 'P1', ppid: 99, pgrp: 100, sid: 100, tty: A, tpgid: 100 },
    { pid: 101, comm: 'claude', argv: ['claude'], pane: 'P1', ppid: 100, pgrp: 101, sid: 100, tty: A, tpgid: 100, state: 'T' },
  ];
  for (const [label, extra] of shapes) {
    const r = root([...pane, ...extra]);
    eq(pc.claudeOwnsTerminal('P1', { cached: false, root: r }), false, `${label}: a same-paneid claude owning ANOTHER tty does not unlock the pane (bash has it)`);
  }
  const healthy = root([
    { pid: 99, comm: 'node', argv: ['node', 'broker'], pane: null, pgrp: 99, sid: 99, tty: 0, tpgid: -1 },
    { pid: 100, comm: 'bash', pane: 'P1', ppid: 99, pgrp: 100, sid: 100, tty: A, tpgid: 101 },
    { pid: 101, comm: 'claude', argv: ['claude', '--resume', ID], pane: 'P1', ppid: 100, pgrp: 101, sid: 100, tty: A, tpgid: 101 },
    ...shapes[1][1],
  ]);
  eq(pc.claudeOwnsTerminal('P1', { cached: false, root: healthy }), true, 'the pane\'s own claude on the pane\'s tty: true (a tmux claude elsewhere changes nothing)');
  same(pc.claudeOwner('P1', { cached: false, root: healthy }), { pid: 101, starttime: 1010, startedAt: null, leader: false }, 'claudeOwner names the owning claude: pid + starttime (finding #2); no /proc/uptime → startedAt null; bash\'s child → not a leader');
  writeFileSync(join(healthy, 'uptime'), '100.00 50.00\n'); // booted 100 s ago
  const own = pc.claudeOwner('P1', { cached: false, root: healthy }) as { startedAt: number };
  const want = Date.now() - 100_000 + 1010 * 10; // starttime 1010 ticks at USER_HZ 100 = 10.1 s after boot
  eq(Math.abs(own.startedAt - want) < 100, true, `review 2 P1-B: startedAt = boot (now - uptime) + starttime/100 s (off by ${own.startedAt - want} ms)`);
  eq(pc.claudeOwner('P1', { cached: false, root: root(pane) }), 'none', '...\'none\' when none owns the pane\'s tty');
  const execd = root([
    { pid: 99, comm: 'node', argv: ['node', 'broker'], pane: null, pgrp: 99, sid: 99, tty: 0, tpgid: -1 },
    { pid: 130, comm: 'claude', argv: ['claude'], pane: 'P2', ppid: 99, pgrp: 130, sid: 130, tty: A, tpgid: 130 },
  ]);
  eq(pc.claudeOwnsTerminal('P2', { cached: false, root: execd }), true, '`exec claude`: the claude IS the root shell');
  eq((pc.claudeOwner('P2', { cached: false, root: execd }) as { leader: boolean }).leader, true, 'review 4: ...and says so — leader (sid === pid): its start time is the shell\'s');
  const twoRoots = root([
    { pid: 99, comm: 'node', argv: ['node', 'broker'], pane: null, pgrp: 99, sid: 99, tty: 0, tpgid: -1 },
    { pid: 140, comm: 'bash', pane: 'P3', ppid: 99, pgrp: 140, sid: 140, tty: A, tpgid: 141 },
    { pid: 141, comm: 'claude', argv: ['claude'], pane: 'P3', ppid: 140, pgrp: 141, sid: 140, tty: A, tpgid: 141 },
    { pid: 150, comm: 'bash', pane: 'P3', ppid: 1, pgrp: 150, sid: 150, tty: B, tpgid: 150 },
  ]);
  eq(pc.claudeOwnsTerminal('P3', { cached: false, root: twoRoots }), false, 'roots on two ttys: the pane\'s terminal cannot be named → false (hold), never null');
  const noRoot = root([
    { pid: 160, comm: 'claude', argv: ['claude'], pane: 'P4', ppid: 1, pgrp: 160, sid: 5, tty: A, tpgid: 160 },
  ]);
  eq(pc.claudeOwnsTerminal('P4', { cached: false, root: noRoot }), false, 'paneid carriers but no root shell → false (hold), never null');
}

console.log('\n[review 2 P2: every value-taking option in `claude --help` (2.1.283) keeps a hand relaunch the REPL]');
for (const argv of [
  ['claude', '--append-system-prompt', 'be terse'],
  ['claude', '--effort', 'high'],
  ['claude', '-n', 'planning'],
  ['claude', '--name', 'foo'],
  ['claude', '--agent', 'reviewer'],
  ['claude', '--fallback-model', 'sonnet'],
  ['claude', '-d', 'api'],
  ['claude', '-d', 'update'],
  ['claude', '--debug'],
  ['claude', '--system-prompt', 'x'],
  ['claude', '--tools', 'Bash'],
  ['claude', '--disallowedTools', 'Bash'],
  ['claude', '--plugin-dir', './p'],
  ['claude', '-w', 'feat'],
  ['claude', '--worktree', 'feat'],
  ['claude', '--remote-control', 'box'],
  ['claude', '--settings', '{}', '--add-dir', '/x'],
  ['claude', '-cn', 'x'],
  ['claude', '-nx'],
]) {
  eq(pc.interactive(argv), true, `${JSON.stringify(argv)} → the REPL`);
}
console.log('\n[review 3: value flags from claude\'s own argv scanner (r1t sets), not --help]');
for (const argv of [
  ['claude', '--rc', 'laptop'],
  ['claude', '--remote', 'box'],
  ['claude', '--project', 'x'],
  ['claude', '--append-system-prompt-file', 'notes.md'],
  ['claude', '--system-prompt-file', 'p.md'],
  ['claude', '--channels', 'server:x'],
  ['claude', '--thinking', 'high'],
  ['claude', '--max-thinking-tokens', '8000'],
  ['claude', '--advisor', 'opus'],
  ['claude', '--plugin-dir-no-mcp', './p'],
  ['claude', '-m', 'opus'],
  ['claude', '-cm', 'opus'],
  ['claude', '--append-system-prompt', '-be terse'],
  ['claude', '--resume', '--mcp-config', '/x.json'],
  ['claude', '-r', '-'],
]) {
  eq(pc.interactive(argv), true, `${JSON.stringify(argv)} → the REPL`);
}
eq(pc.interactive(['claude', '--rc']), true, '`--rc` with no value (optional) → the REPL');
eq(pc.interactive(['claude', '--resume', 'update']), true, 'an optional value takes a bare word (claude and commander read `update` as the resume term)');
eq(pc.interactive(['claude', '--mcp-config', 'a.json', 'b.json']), false, 'a variadic\'s second value → held (one value here; the safe direction)');

console.log('\n[review 3: claude\'s own non-interactive predicate (_hn), --bg, and flag=value forms]');
for (const argv of [
  ['claude', '--init-only'],
  ['claude', '--sdk-url=ws://127.0.0.1:1/x'],
  ['claude', '--sdk-url', 'ws://x'],
  ['claude', '--sdk-url-anything'],
  ['claude', '--bg'],
  ['claude', '--background'],
  ['claude', '--bg', '--resume', 'abc'],
  ['claude', '--print=x'],
  ['claude', '--init-only=1'],
  ['claude', '--model', 'opus', '--help=1'],
]) {
  eq(pc.interactive(argv), false, `${JSON.stringify(argv)} → not the REPL`);
}
eq(pc.interactive(['claude', '--model=opus']), true, '`--model=opus` (a value inline) is still the REPL');

eq(pc.interactive(['claude', '--tools', 'Bash', 'Edit']), false, 'a variadic flag\'s SECOND value reads as a bare word → held (the safe direction)');
eq(pc.interactive(['claude', '--model', 'sonnet', 'update']), false, '`--model sonnet update` is the update subcommand');

console.log('\n[review 2 P1-A: flags-only print mode — clusters and redirected stdio — never owns]');
{
  const A = 34816; // /dev/pts/0
  eq(pc.ptsPath(34821), '/dev/pts/5', 'tty_nr 34821 (136:5, live server) is /dev/pts/5');
  eq(pc.ptsPath(A), '/dev/pts/0', 'tty_nr 34816 is /dev/pts/0');
  eq(pc.ptsPath((136 << 8) | (300 & 0xff) | ((300 & ~0xff) << 12)), '/dev/pts/300', 'a minor past 255 decodes');
  eq(pc.ptsPath(0), null, 'no tty');
  eq(pc.ptsPath((4 << 8) | 1), null, 'a console tty is not a pty');
  const base: P[] = [
    { pid: 99, comm: 'node', argv: ['node', 'broker'], pane: null, pgrp: 99, sid: 99, tty: 0, tpgid: -1 },
    { pid: 100, comm: 'bash', pane: 'PR', ppid: 99, pgrp: 100, sid: 100, tty: A, tpgid: 120 },
  ];
  const shapes: Array<[string, P[]]> = [
    ['cat p | claude -cp', [
      { pid: 119, comm: 'cat', argv: ['cat', 'p'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120, fd0: '/home/x/p' },
      { pid: 120, comm: 'claude', argv: ['claude', '-cp'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120, fd0: 'pipe:[7]' },
    ]],
    ['claude -pc', [{ pid: 120, comm: 'claude', argv: ['claude', '-pc'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120 }]],
    ['cat p | claude --model opus | tee out', [
      { pid: 119, comm: 'cat', argv: ['cat', 'p'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120, fd0: '/home/x/p', fd1: 'pipe:[7]' },
      { pid: 120, comm: 'claude', argv: ['claude', '--model', 'opus'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120, fd0: 'pipe:[7]', fd1: 'pipe:[8]' },
      { pid: 121, comm: 'tee', argv: ['tee', 'out'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120, fd0: 'pipe:[8]' },
    ]],
    ['claude -c < f > out', [{ pid: 120, comm: 'claude', argv: ['claude', '-c'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120, fd0: '/home/x/f', fd1: '/home/x/out' }]],
    ['claude -c < f (stdout the tty)', [{ pid: 120, comm: 'claude', argv: ['claude', '-c'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120, fd0: '/home/x/f' }]],
    ['claude | tee out (stdin the tty)', [{ pid: 120, comm: 'claude', argv: ['claude'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120, fd1: 'pipe:[9]' }]],
    ['fds on ANOTHER pty', [{ pid: 120, comm: 'claude', argv: ['claude'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120, fd0: '/dev/pts/14', fd1: '/dev/pts/14' }]],
  ];
  for (const [label, extra] of shapes) {
    eq(pc.claudeOwnsTerminal('PR', { cached: false, root: root([...base, ...extra]) }), false, `${label}: held`);
  }
  eq(pc.claudeOwnsTerminal('PR', { cached: false, root: root([...base, { pid: 120, comm: 'claude', argv: ['claude', '-c'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120 }]) }), true, 'the same `claude -c` with stdin and stdout on the pane\'s pty: the REPL');
  const noFd = root([...base, { pid: 120, comm: 'claude', argv: ['claude'], pane: 'PR', ppid: 100, pgrp: 120, sid: 100, tty: A, tpgid: 120 }]);
  rmSync(join(noFd, '120', 'fd'), { recursive: true, force: true });
  eq(pc.claudeOwnsTerminal('PR', { cached: false, root: noFd }), false, 'an fd that cannot be read: held');
  for (const argv of [['claude', '-cp'], ['claude', '-pc'], ['claude', '-ch'], ['claude', '-cv'], ['claude', '-cV'], ['claude', '-'], ['claude', '-cr', ID, 'x']]) {
    eq(pc.interactive(argv), false, `${JSON.stringify(argv)} → not the REPL (cluster)`);
  }
  for (const argv of [['claude', `-r${ID}`], ['claude', '-cr', ID], ['claude', '-c', `-r${ID}`], ['claude', '-rhelp']]) {
    eq(pc.interactive(argv), true, `${JSON.stringify(argv)} → the REPL (a valued short keeps the rest as its value)`);
  }
}

console.log('\n[the 2 s cache serves reads; uncached re-reads]');
  const r2 = root([{ pid: 80, comm: 'claude', argv: ['claude'], pane: 'recipe:c', pgrp: 80, tpgid: 80 }]);
  pc.resetCache();
  eq(pc.claudeOwnsTerminal('recipe:c', { cached: true, root: r2 }), true, 'first read scans');
  rmSync(join(r2, '80'), { recursive: true, force: true }); // claude exits
  eq(pc.claudeOwnsTerminal('recipe:c', { cached: true, root: r2 }), true, 'a cached read inside 2 s still says yes');
  eq(pc.claudeOwnsTerminal('recipe:c', { cached: false, root: r2 }), false, 'the uncached read (guard 9) sees it is gone');
}

console.log('\n[one process never makes the scan unknown: EACCES is "not this pane"; only the root is null]');
{
  const isRoot = process.getuid?.() === 0;
  const r = root([
    { pid: 90, comm: 'claude', argv: ['claude'], pane: 'recipe:x', pgrp: 90, tpgid: 90 },
    { pid: 95, comm: 'claude', argv: ['claude'], pane: 'recipe:ok', pgrp: 95, tpgid: 95 },
  ]);
  chmodSync(join(r, '90', 'environ'), 0o000);
  if (isRoot) {
    console.log('  (running as root: EACCES cannot be produced — skipped)');
  } else {
    pc.resetCache();
    eq(pc.claudeOwnsTerminal('recipe:x', { cached: false, root: r }), false, 'an unreadable claude cannot be shown to be this pane\'s → false (hold)');
    eq(pc.claudeOwnsTerminal('recipe:ok', { cached: false, root: r }), true, '...and it does not blind the scan for any other pane');
    eq(pids(pc.classify({ paneid: 'recipe:x', ids: [], phase: 'live' }, r)?.claude), '[]', 'classify live: an answer, not null');
    eq(pc.classify({ paneid: 'recipe:x', ids: [], phase: 'ended' }, r) !== null, true, 'classify ended: an answer, not null');
    /* Non-dumpable own-uid processes (sshd session children, systemd --user,
       file-capability binaries) have a root-owned environ. */
    const r2 = root([
      { pid: 91, comm: 'sshd', argv: ['sshd: svc-ops@pts/3'], pane: null },
      { pid: 92, comm: 'ping', argv: ['ping', 'x'], pane: 'recipe:y' },
      { pid: 93, comm: 'sleep', argv: ['sleep', '9'], pane: 'recipe:y' },
    ]);
    chmodSync(join(r2, '91', 'environ'), 0o000);
    chmodSync(join(r2, '92', 'environ'), 0o000);
    eq(pids(pc.classify({ paneid: 'recipe:y', ids: [], phase: 'ended' }, r2)?.leftovers), '[93]', 'the leftover scan skips an unreadable environ');

    /* Finding #8: a live claude whose child is non-dumpable. */
    const r3 = root([
      { pid: 100, comm: 'claude', argv: ['claude'], pane: 'recipe:z', pgrp: 100, tpgid: 100 },
      { pid: 101, comm: 'git', argv: ['git', 'push'], pane: 'recipe:z', ppid: 100, pgrp: 100 },
      { pid: 102, comm: 'ping', argv: ['ping', 'x'], pane: 'recipe:z', ppid: 101, pgrp: 100 },
      { pid: 200, comm: 'claude', argv: ['claude', '--resume', 'X'], pane: 'recipe:q', ppid: 1 },
    ]);
    chmodSync(join(r3, '102', 'environ'), 0o000);
    const live = pc.classify({ paneid: 'recipe:z', ids: ['X'], phase: 'live' }, r3);
    eq(pids(live?.claude), '[100]', 'live phase with a non-dumpable descendant: still an answer');
    eq(pids(live?.background), '[101,102]', '...the unreadable child is plain background (no environ needed)');
    eq(pids(live?.collisions), '[200]', '...and the id-naming collision is not lost');
    chmodSync(join(r3, '102', 'environ'), 0o600);

    /* Finding #7: a ZOMBIE claude (state Z, root-owned environ) next to a
       healthy owning claude and a bash-foreground pane. */
    const r4 = root([
      { pid: 300, comm: 'claude', argv: ['claude'], pane: 'recipe:healthy', pgrp: 300, tpgid: 300 },
      { pid: 310, comm: 'bash', pane: 'recipe:bashfg', pgrp: 310, tpgid: 310 },
      { pid: 311, comm: 'claude', argv: ['claude'], pane: 'recipe:bashfg', ppid: 310, pgrp: 311, tpgid: 310, state: 'T' },
      { pid: 320, comm: 'claude', argv: ['claude', '--print', 'x'], pane: 'recipe:healthy', state: 'Z' },
      { pid: 330, comm: 'claude', argv: [], pane: 'recipe:bashfg', pgrp: 330, tpgid: 330, state: 'Z' },
    ]);
    chmodSync(join(r4, '320', 'environ'), 0o000);
    chmodSync(join(r4, '330', 'environ'), 0o000);
    pc.resetCache();
    eq(pc.claudeOwnsTerminal('recipe:healthy', { cached: false, root: r4 }), true, 'a zombie claude on the host: a healthy pane stays true (not null)');
    eq(pc.claudeOwnsTerminal('recipe:bashfg', { cached: false, root: r4 }), false, '...and a bash-foreground pane stays false (not null)');
    const ended = pc.classify({ paneid: 'recipe:bashfg', ids: [], phase: 'ended', recorded: { pid: 330, starttime: 3300 } }, r4);
    eq(ended?.collisions.some((x) => x.pid === 330), false, 'a zombie is not a claude: never a collision, even as the recorded pid');
    for (const pid of ['320', '330']) chmodSync(join(r4, pid, 'environ'), 0o600);
  }
  chmodSync(join(r, '90', 'environ'), 0o600);
  eq(pc.classify({ paneid: 'recipe:x', ids: [], phase: 'live' }, join(r, 'nope')), null, 'an unreadable proc root → null (the one whole-scan case)');
  pc.resetCache();
  eq(pc.claudeOwnsTerminal('recipe:x', { cached: false, root: join(r, 'nope') }), null, '...claudeOwnsTerminal too');
}

console.log('\n[argv helpers]');
eq(pc.namesId(['claude', '--resume', ID], [ID]), true, '--resume <id>');
eq(pc.namesId(['claude', '-r', ID], [ID]), true, '-r <id>');
eq(pc.namesId(['claude', '--session-id', ID], [ID]), true, '--session-id <id>');
eq(pc.namesId(['claude', `--resume=${ID}`], [ID]), false, 'not a pair');
eq(pc.namesId([ID, '--resume'], [ID]), false, 'the id as argv[0] is not a pair');
eq(pc.interactive(['claude', '--version']), false, '--version is not interactive');
eq(pc.interactive(['claude', '--resume', ID]), true, 'a resume is interactive');

console.log('\n[interactive() fails closed: a bare word is a subcommand or a prompt]');
for (const argv of [
  ['claude', 'update'],
  ['claude', 'mcp', 'list'],
  /* `--debug update` is NOT here any more: --debug takes an optional value,
     and commander reads `update` as its filter — the REPL (review 2 P2). */
  ['claude', '--debug', '--verbose', 'update'],
  ['claude', '-h'],
  ['claude', '--help'],
  ['claude', '-v'],
  ['claude', '-p', 'hi'],
  ['claude', 'doctor'],
  ['claude', 'fix the tests'],
  ['claude', '--model', 'opus', 'install'],
  [],
]) {
  eq(pc.interactive(argv), false, `${JSON.stringify(argv)} → not the REPL`);
}
/* Every shape buildInvocation + channelArgs produce (claude-code.ts,
   launch.ts), the two live channel argvs read off /proc on 2026-09-25, and
   what a person types to start it again. */
const MCP = '/srv/workbench/data/mcp/recipe_d97d7d7a-67a9-4956-b139-7a82f311e4c7-eb4dc794.json';
const CH = ['--mcp-config', MCP, '--dangerously-load-development-channels', 'server:fabric', '--allowedTools', 'mcp__fabric'];
for (const argv of [
  ['claude'],
  ['claude', '--model', 'opus'],
  ['claude', '--model', 'opus', '--session-id', ID],
  ['claude', '--model', 'opus', '--resume', ID],
  ['claude', '--resume', 'My named session'],
  ['claude', '--resume'],
  ['claude', '--resume', ...CH],
  ['claude', '--resume', ID, ...CH],
  ['claude', '--model', 'opus', '--session-id', ID, ...CH],
  ['claude', '-c'],
  ['claude', '-r', ID],
  ['claude', '--dangerously-skip-permissions'],
]) {
  eq(pc.interactive(argv), true, `${JSON.stringify(argv).slice(0, 90)} → the REPL`);
}
eq(pc.parseStat('7 (a) b) c) R 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0')?.starttime, 999, 'stat parses from the LAST ")"');

for (const d of dirs) {
  rmSync(d, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
