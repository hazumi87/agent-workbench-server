/**
 * ROOM RECONNECT × THE S0 GUARDS (assemble-room F1/F2 + §4.4, S0 ride fix)
 * [ticket]. A room reconnect restores its seats ONE AFTER ANOTHER through
 * the seat-start path (launchRecipe, then the window's attach), so the guards
 * run per seat in sequence. This walks three server channel seats just
 * disconnected (EndReason 'cycle') through that sequence with the real
 * modules — spawn-guard + proc-classifier on a fake /proc root, the startup
 * gate, the channel DialogWatcher and the activity input classifier:
 *   @a  its previous claude is still exiting → the launch door lets it
 *       through, the attach waits for it, then restores;
 *   @b  a STOPPED orphan carries its paneid but runs ANOTHER conversation
 *       (the live N1 shape) → restores, no wait (guard 7 (iii) fix);
 *   @c  a stopped orphan names ITS conversation → refused at the launch door
 *       (the reconnect reports it) and at the attach, text (3);
 *   guard 6: each restored channel seat's window answers claude's DA1 query
 *       and the engine still accepts each dev-channels dialog — one Enter per
 *       seat, none cancelled by the reply;
 *   guard 1: an engine restart right after, adopting both: @a's replay ends
 *       on a permission dialog left blinking (held), @b's on its footer (clear).
 *
 * SAFETY: temp db, temp dirs and a fake proc root; the fabric URL is ''. No
 * engine, no broker, no ports. Linux only (the fake root is /proc-shaped).
 * Run with tsx.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-reconnect-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_CLAUDE_PROJECTS = join(dir, 'projects');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_NODE = 'homebase';
process.env.HARBOR_WB_CHANNEL_DIALOG_MS = '400';
const fakeMcp = join(dir, 'server.js');
writeFileSync(fakeMcp, '// fake fabric-mcp\n');
process.env.HARBOR_WB_FABRIC_MCP = fakeMcp;
process.env.HARBOR_WB_CHANNELS = '1';

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
  console.log(`  - SKIPPED on ${process.platform}: the proc fixture is /proc-shaped and channels are server-local`);
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  process.exit(0);
}

const sg = await import('../src/engine/spawn-guard.ts');
const pc = await import('../src/engine/proc-classifier.ts');
const gate = await import('../src/engine/startup-gate.ts');
const ch = await import('../src/engine/channels.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
type Target = import('../src/engine/launch.ts').Target;

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nucResident: Target = { id: 'homebase-resident', label: 'x', kind: 'ssh', sshAlias: 'homeserver-svc-ops', broker: 'homebase' };

const A = 'recipe:ra';
const B = 'recipe:rb';
const C = 'recipe:rc';
const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const ID = { [A]: uuid(1), [B]: uuid(2), [C]: uuid(3) } as Record<string, string>;
const OTHER_CONV = uuid(9);

/* ---- a fake /proc: uptime dates every process long before the End ---- */
const proc = join(dir, 'proc');
mkdirSync(proc);
writeFileSync(join(proc, 'uptime'), '100000.00 1.00\n');
writeFileSync(join(proc, 'stat'), `cpu 1 2 3 4\nbtime ${Math.floor(Date.now() / 1000) - 100000}\n`);
function claude(pid: number, argv: string[], pane: string, state: string): void {
  const d = join(proc, String(pid));
  mkdirSync(d);
  writeFileSync(join(d, 'comm'), 'claude\n');
  writeFileSync(join(d, 'cmdline'), argv.join(NUL) + NUL);
  writeFileSync(join(d, 'environ'), `HOME=/x${NUL}HARBOR_WB_PANEID=${pane}${NUL}`);
  const f = [state, 1, pid, pid, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, 100, 0, 0];
  writeFileSync(join(d, 'stat'), `${pid} (claude) ${f.join(' ')}\n`);
  mkdirSync(join(d, 'fd'));
  symlinkSync('pipe:[1]', join(d, 'fd', '0'));
  symlinkSync('pipe:[1]', join(d, 'fd', '1'));
}
claude(501, ['claude', '--model', 'opus', '--resume', ID[A]], A, 'S'); // @a's previous claude, still exiting
claude(502, ['claude', '--model', 'opus', '--session-id', OTHER_CONV], B, 'T'); // N1 on another conversation
claude(503, ['claude', '--resume', ID[C]], 'recipe:gone', 'T'); // an orphan on @c's conversation

/* ---- the guard's world: a virtual clock the wait advances ---- */
let t = Date.now();
const logs: string[] = [];
const deps = {
  liveRows: () => [] as Array<{ paneid: string; session_id: string | null }>,
  classify: (q: import('../src/engine/proc-classifier.ts').ClassifyQuery) => pc.classify(q, proc),
  labelOf: (p: string) => `@${p.slice(-1)}`,
  mode: () => 'enforce',
  log: (l: string) => logs.push(l),
  now: () => t,
  sleep: async (ms: number) => {
    t += ms;
    if (t - disconnectedAt > 3_000) {
      rmSync(join(proc, '501'), { recursive: true, force: true }); // @a's previous claude exits 3 s in
    }
  },
};

/* ---- the disconnect: every seat ended (cycle) a moment ago ---- */
const disconnectedAt = t - 1_000;
for (const p of [A, B, C]) sg.noteEnded(p, disconnectedAt);

console.log('\n[reconnect, seat by seat: guard 7 at the launch door, then at the attach]');
const restored: string[] = [];
for (const p of [A, B, C]) {
  const inp = { paneid: p, ids: [ID[p]], local: true };
  const atDoor = sg.early(inp, deps);
  if (atDoor) {
    eq(p, C, `${p}: refused at the launch door (the reconnect reports it not-restorable)`);
    eq(atDoor.owner, 3, `${p}: ...an orphan on its conversation: text (3)`);
    eq(atDoor.message.includes('TZ=UTC ps -o lstart= -p 503'), true, `${p}: ...with a ps check that matches in any shell`);
  }
  const waited: number[] = [];
  const t0 = t;
  const v = await sg.check(inp, deps, (pid) => waited.push(pid));
  if (p === A) {
    eq(atDoor, null, '@a: the launch door lets an ordinary End → Restore through (the attach waits)');
    eq(`${v.ok}/${waited.join(',')}`, 'true/501', '@a: the attach waited for its previous claude, then restored');
    eq(t - disconnectedAt > 3_000 && t - t0 < sg.WAIT_MS, true, '@a: ...for as long as it took to exit, no longer');
  } else if (p === B) {
    eq(atDoor, null, '@b: a stopped orphan on ANOTHER conversation does not refuse at the door');
    eq(`${v.ok}/${waited.length}`, 'true/0', '@b: ...nor at the attach, and nothing waits for it');
  } else {
    eq(v.ok, false, '@c: the attach refuses too (a seat Restore that bypassed the door)');
  }
  if (v.ok) {
    restored.push(p);
    sg.markResuming(p, [ID[p]], t);
  }
}
eq(restored.join(','), `${A},${B}`, 'two of three seats restored, in order');

console.log('\n[guard 6: each restored channel seat accepts its dev-channels dialog despite the window\'s DA1 reply]');
const WARN = `${ESC}[3G${ESC}[1mWARNING:${ESC}[12GLoading${ESC}[20Gdevelopment${ESC}[32Gchannels${ESC}[22m\r\r\n`;
const REST = `${ESC}[3G--dangerously-load-development-channels is for local\r\n  1. I am using this for local development\r\n  2. Exit\r\n Enter to confirm ${String.fromCharCode(0xb7)} Esc to cancel`;
const FOOTER = `\r\n  ${String.fromCharCode(0x23f5, 0x23f5)} auto mode on ${ESC}[2m(shift+tab to cycle)${ESC}[22m`;
gate.setDialogProbe((p) => ch.dialogStateOf(p));
ch.setGateProbe((p) => gate.streamOf(p));
const writes: Record<string, string[]> = {};
for (const p of restored) {
  writes[p] = [];
  ch.prepareLaunch({ vendor: 'claude-code', target: nucResident, paneid: p, slug: p.slice(-1) });
  sessions.add(p, { state: 'live', pty: { write: (d: string) => writes[p].push(d) } } as never, null as never);
  gate.arm(p, { channel: true });
  const out = (d: string) => {
    gate.onPtyData(p, d);
    ch.onPtyData(p, d);
  };
  out(`${ESC}[>0q${ESC}[c`); // claude's startup queries
  out(WARN + REST);
  await sleep(30);
  /* The window's xterm answers — index.ts forwards it as input and asks
     whether it was typing before telling the gate or the watcher. */
  if (activity.onInput(p, `${ESC}[?1;2c`)) {
    gate.onHumanInput(p);
    ch.onHumanInput(p);
  }
  await sleep(700);
  eq(writes[p].join('|'), '\r', `${p}: exactly one Enter — the DA1 reply did not cancel the accept`);
  eq(ch.dialogStateOf(p), 'accepted', `${p}: dialog accepted`);
  out(`${ESC}[2J Claude Code v2.1.283 ${'resumed conversation, earlier turns redrawn. '.repeat(6)}${FOOTER}`);
  eq(gate.isBlocked(p), false, `${p}: past startup once its footer draws`);
}

console.log('\n[guard 1: an engine restart right after the reconnect adopts both seats]');
{
  const BULLET = String.fromCharCode(0x23fa);
  let blink = '';
  for (let i = 0; i < 3000; i++) {
    blink += `${ESC}[?25l${ESC}[7A${ESC}[1G${BULLET}${ESC}[7B${ESC}[?25h${ESC}[?25l${ESC}[7A${ESC}[1G ${ESC}[7B${ESC}[?25h`;
  }
  const PERM = ` Do you want to proceed?\r\n 1. Yes\r\n 2. No\r\n Esc to cancel ${String.fromCharCode(0xb7)} Tab to amend`;
  const turn = ' the model worked on the seat task.'.repeat(40);
  gate.adopt(A, WARN + REST + turn + FOOTER + turn + PERM + blink);
  eq(gate.isBlocked(A), true, '@a: its replay ends on a permission dialog blinking for an hour → held (a room line cannot answer it)');
  gate.adopt(B, WARN + REST + turn + FOOTER);
  eq(gate.isBlocked(B), false, '@b: its replay ends on the footer after the (accepted) dev-channels dialog → clear');
}

rmSync(dir, { recursive: true, force: true });
sg.reset();
ch.reset();
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
