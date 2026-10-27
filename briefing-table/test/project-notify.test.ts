/**
 * "Tell the other sessions" (the design notes): main-moved + shared-
 * checkout-commit notices, delivered over the channel only (never typed).
 *
 * Pure logic (rate gate, recipient exclusion, pusher resolution, who/body
 * formatting) against fakes; notifySharedCommit end-to-end against a fake
 * Wiring (no git needed — it never touches the mirror); sweepOnce's
 * main-moved detection against REAL temp git repos (no network), the same
 * pattern project-mirror.test.ts and project-activity.test.ts use.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityDeps, ActivityRecipe, ActivityRow } from '../src/engine/project-activity.ts';

const tmp = mkdtempSync(join(tmpdir(), 'wb-proj-notify-'));
process.env.HARBOR_WB_MIRRORS = join(tmp, 'mirrors');
const notify = await import('../src/engine/project-notify.ts');
const mirror = await import('../src/engine/project-mirror.ts');

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}
function same(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? msg : `${msg}\n      got      ${a}\n      expected ${b}`);
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@x', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@x',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitFile = (dir: string, file: string, msg: string) => {
  writeFileSync(join(dir, file), `${msg}${String.fromCharCode(10)}`);
  g(dir, 'add', file);
  g(dir, 'commit', '--quiet', '-m', msg);
};

try {
  /* --------------------------------------------------------- rate gate --- */
  console.log('rateGate: caps at RATE_MAX/hour, coalesces suppressed into the next send');
  notify.reset();
  let t = 1_700_000_000_000;
  const key = 'demo:p1';
  const sends: boolean[] = [];
  for (let i = 0; i < 8; i++) {
    const r = notify.rateGate(key, t);
    sends.push(r.send);
    if (r.send) {
      ok(r.extra === 0, `send #${i + 1}: extra reported is 0 while under cap`);
    }
  }
  same(sends, [true, true, true, true, true, true, false, false], '6 sends allowed, the 7th and 8th suppressed (RATE_MAX=6)');
  t += 61 * 60_000; // past the rolling hour
  const afterWindow = notify.rateGate(key, t);
  same(afterWindow, { send: true, extra: 2 }, 'a new window sends again and reports the 2 suppressed in between');
  const secondInNewWindow = notify.rateGate(key, t);
  same(secondInNewWindow, { send: true, extra: 0 }, 'the next send in the same window reports no leftover extra');
  ok(notify.rateGate('other:p1', t).send, 'a different key has its own independent window');

  /* --------------------------------------------------- recipient exclusion --- */
  console.log('recipientsExcluding');
  const live = [
    { paneid: 'A', slug: 'demo' },
    { paneid: 'B', slug: 'demo' },
    { paneid: 'C', slug: 'demo-2' },
  ];
  same(notify.recipientsExcluding(live, { paneid: 'A' }).map((s) => s.paneid), ['B', 'C'], 'excludes the exact pane');
  same(notify.recipientsExcluding(live, { slug: 'demo' }).map((s) => s.paneid), ['C'], 'no pane known: excludes by slug');
  same(notify.recipientsExcluding(live, {}).map((s) => s.paneid), ['A', 'B', 'C'], 'neither known: excludes nobody (could-not-tell != exclude)');

  /* -------------------------------------------------------- commonestPane --- */
  console.log('commonestPane: majority pane, else majority slug, else could-not-tell');
  same(
    notify.commonestPane([{ pane: 'A', slug: null }, { pane: 'A', slug: null }, { pane: 'B', slug: null }]),
    { paneid: 'A', slug: null },
    'the pane naming most of the moved commits',
  );
  same(notify.commonestPane([{ pane: null, slug: 'vrpc1' }, { pane: null, slug: 'vrpc1' }]), { paneid: null, slug: 'vrpc1' }, 'no pane in any trailer: falls back to the commonest slug');
  same(notify.commonestPane([{ pane: null, slug: null }]), { paneid: null, slug: null }, 'nothing in any trailer: could not tell');

  /* -------------------------------------------------------------- whoOf --- */
  console.log('whoOf');
  const seats = new Map([['A', [{ handle: 'bt', room: 'Workrooms build' }]]]);
  same(notify.whoOf('A', null, seats), '@bt (Workrooms build)', 'a seated pane reads as @handle (room)');
  same(notify.whoOf('B', 'vrpc1', seats), '@vrpc1', 'an unseated pane with a known slug reads as @slug');
  same(notify.whoOf('B', null, seats), 'B', 'an unseated pane with no slug reads as the raw paneid');
  same(notify.whoOf(null, 'vrpc1', seats), '@vrpc1', 'no pane at all: the slug');
  same(notify.whoOf(null, null, seats), 'unknown', 'nothing at all: unknown');

  /* --------------------------------------------------------- body text --- */
  console.log('notice body formatting');
  const mmBody = notify.mainMovedBody({
    slug: 'briefing-table', fromSha: 'abc1234ffff', toSha: 'def5678ffff', who: '@bt (Workrooms build)',
    firstSubject: 'Fix the thing', moreCommits: 2, files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], filesTotal: 4,
  });
  same(
    mmBody,
    "briefing-table main moved abc1234 → def5678 by @bt (Workrooms build): Fix the thing (+2 more). Files: a.ts, b.ts, c.ts (+1). Pull before you merge.",
    'main-moved body matches the documented shape',
  );
  const mmBodyNoFiles = notify.mainMovedBody({ slug: 'x', fromSha: '1111111', toSha: '2222222', who: 'unknown', firstSubject: 'one', moreCommits: 0, files: [], filesTotal: 0 });
  same(mmBodyNoFiles, 'x main moved 1111111 → 2222222 by unknown: one. Pull before you merge.', 'no files, no "(+N more)": still one clean sentence');
  same(notify.sharedCommitBody('@bt', 'main', 'WIP'), "@bt has an unpushed commit on the shared checkout's main: WIP", 'shared-commit body matches the documented shape');
  same(notify.sharedCommitBody('@bt', '', 'WIP'), "@bt has an unpushed commit on the shared checkout's main: WIP", 'an empty branch falls back to "main"');

  /* -------------------------------------------------------------- dedupe --- */
  console.log('alreadyNotified / markNotified: one notice per commit sha');
  ok(!notify.alreadyNotified('demo', 'sha1'), 'unseen sha: not notified yet');
  notify.markNotified('demo', 'sha1');
  ok(notify.alreadyNotified('demo', 'sha1'), 'seen sha: notified');
  ok(!notify.alreadyNotified('other', 'sha1'), 'the same sha in a different project is a different key');

  /* ---------------------------------------------------- notifySharedCommit --- */
  console.log('notifySharedCommit: excludes the committer, dedupes by sha, never types (channel-live only)');
  notify.reset();
  function fakeActivity(rows: ActivityRow[], recipes: Record<string, ActivityRecipe>): ActivityDeps {
    return {
      sessions: () => rows,
      recipe: (id) => recipes[id] ?? null,
      nodeOf: () => 'homebase',
      isLocal: () => true,
      openRooms: () => [],
      seats: () => [],
      branchOf: async () => ({ branch: null, branch_status: 'unknown', branch_reason: 'not used in this test' }),
    };
  }
  const rows1: ActivityRow[] = [
    { paneid: 'pane-committer', recipe_id: 'r1', vendor: 'claude-code', agent: 'sc-demo', state: 'live' },
    { paneid: 'pane-other', recipe_id: 'r1', vendor: 'claude-code', agent: 'sc-demo', state: 'live' },
    { paneid: 'pane-elsewhere', recipe_id: 'r2', vendor: 'claude-code', agent: 'other-project', state: 'live' },
  ];
  const recipes1: Record<string, ActivityRecipe> = {
    r1: { id: 'r1', name: 'Demo', agent: 'sc-demo', projectDir: null, target: 't' },
    r2: { id: 'r2', name: 'Other', agent: 'other-project', projectDir: null, target: 't' },
  };
  const sent1: Array<Record<string, unknown>> = [];
  const wiring1 = {
    activity: fakeActivity(rows1, recipes1),
    recipes: () => Object.values(recipes1),
    send: {
      toSlug: (paneid: string) => `${paneid}:wslug`,
      channelLive: async () => true,
      send: async (envelope: Record<string, unknown>) => {
        sent1.push(envelope);
        return { ok: true, status: 200 };
      },
      log: () => {},
    },
  };
  const r1 = await notify.notifySharedCommit('sc-demo', 'pane-committer', { subject: 'WIP: half a fix', sha: 'sha-aaa', branch: 'main' }, wiring1);
  same(r1, { notified: 1 }, 'notified only the OTHER live session of the SAME project (not the committer, not another project)');
  same(sent1.map((s) => s.to), ['pane-other:wslug'], 'addressed by the recipient pane\'s own checked-in slug (toSlug), not the shared agent slug');
  ok(sent1[0].kind === 'notice' && sent1[0].class === 'info', 'kind notice / class info');
  ok((sent1[0].body as string).includes("has an unpushed commit on the shared checkout's main"), 'body names the shared-checkout commit');

  const r1again = await notify.notifySharedCommit('sc-demo', 'pane-committer', { subject: 'WIP: half a fix', sha: 'sha-aaa', branch: 'main' }, wiring1);
  same(r1again, { notified: 0 }, 'the same sha again: deduped, nobody notified twice');

  console.log('notifySharedCommit: a pane with no live channel never gets the envelope, and nothing is ever typed');
  const sent2: Array<Record<string, unknown>> = [];
  const wiring2 = {
    activity: fakeActivity(
      [
        { paneid: 'committer', recipe_id: 'r1', vendor: 'claude-code', agent: 'sc-demo2', state: 'live' },
        { paneid: 'quiet-pane', recipe_id: 'r1', vendor: 'claude-code', agent: 'sc-demo2', state: 'live' },
      ],
      { r1: { id: 'r1', name: 'Demo2', agent: 'sc-demo2', projectDir: null, target: 't' } },
    ),
    recipes: () => [{ id: 'r1', name: 'Demo2', agent: 'sc-demo2', projectDir: null, target: 't' }],
    send: {
      toSlug: (_p: string, fallback: string | null) => fallback,
      channelLive: async () => false, // nobody has a live channel
      send: async (envelope: Record<string, unknown>) => {
        sent2.push(envelope);
        return { ok: true, status: 200 };
      },
      log: () => {},
    },
  };
  const r2 = await notify.notifySharedCommit('sc-demo2', 'committer', { subject: 'x', sha: 'sha-bbb', branch: 'main' }, wiring2);
  same(r2, { notified: 0 }, 'nobody has a live channel: not delivered (never a typed fallback — send() proves it was not even attempted)');
  same(sent2, [], 'send() was never called: the channel-live gate ran first');

  /* -------------------------------------------------------------- sweepOnce (main moved) --- */
  console.log('sweepOnce: detects origin main moving, excludes the pusher by pane, respects the rate cap');
  notify.reset();
  let clock = Date.now();
  mirror.setClock(() => clock);
  const origin = join(tmp, 'origin.git');
  g(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  // The checkout's basename doubles as a project key (projectBasename,
  // project-activity.ts projectKeys) — name it to MATCH the slug so this
  // fixture exercises exactly one project, not two.
  const work = join(tmp, 'mm-demo');
  g(tmp, 'clone', '--quiet', origin, work);
  commitFile(work, 'root.txt', 'root');
  g(work, 'push', '--quiet', 'origin', 'HEAD:main');

  const rowsMain: ActivityRow[] = [
    { paneid: 'pusher-pane', recipe_id: 'rec', vendor: 'claude-code', agent: 'mm-demo', state: 'live' },
    { paneid: 'other-pane', recipe_id: 'rec', vendor: 'claude-code', agent: 'mm-demo', state: 'live' },
  ];
  const recipesMain: Record<string, ActivityRecipe> = {
    rec: { id: 'rec', name: 'MM Demo', agent: 'mm-demo', projectDir: work, target: 't' },
  };
  const sentMain: Array<{ to: string; body: string }> = [];
  const wiringMain = {
    activity: fakeActivity(rowsMain, recipesMain),
    recipes: () => Object.values(recipesMain),
    send: {
      toSlug: (paneid: string) => `${paneid}:wslug`,
      channelLive: async () => true,
      send: async (envelope: Record<string, unknown>) => {
        sentMain.push({ to: envelope.to as string, body: envelope.body as string });
        return { ok: true, status: 200 };
      },
      log: () => {},
    },
  };

  await notify.sweepOnce(wiringMain);
  same(sentMain, [], 'first sweep only primes the known sha — no notice for pre-existing history');

  commitFile(work, 'a.txt', `add a${String.fromCharCode(10, 10)}Session: mm-demo pane=pusher-pane`);
  g(work, 'push', '--quiet', 'origin', 'HEAD:main');
  clock += mirror.FETCH_MIN_MS; // past the mirror's 90 s fetch window
  await notify.sweepOnce(wiringMain);
  same(sentMain.map((s) => s.to), ['other-pane:wslug'], 'only the OTHER live session was notified — the pusher (named by the trailer) was excluded');
  ok(sentMain[0].body.includes('main moved') && sentMain[0].body.includes('add a') && sentMain[0].body.includes('Pull before you merge'), `notice body: ${sentMain[0].body}`);

  sentMain.length = 0;
  await notify.sweepOnce(wiringMain);
  same(sentMain, [], 'a sweep with nothing new sends nothing (one notice per move)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
