/**
 * The engine-owned bare mirror (the design notes): clone once, fetch
 * --prune at most every 90 s, read recent default-branch commits (with the
 * Session: trailer) and recently-updated branches' files vs the default
 * branch. Against a LOCAL temp origin: no network. The 90 s window is driven
 * by an injected clock.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'wb-proj-mirror-'));
process.env.HARBOR_WB_MIRRORS = join(tmp, 'mirrors');
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

const BASE_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@x', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@x',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const g = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync('git', args, { cwd, env: { ...BASE_ENV, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitFile = (dir: string, file: string, msg: string, env: Record<string, string> = {}) => {
  writeFileSync(join(dir, file), `${msg}${String.fromCharCode(10)}`);
  g(dir, ['add', file]);
  g(dir, ['commit', '--quiet', '-m', msg], env);
};

let t = Date.now();
mirror.setClock(() => t);

try {
  const origin = join(tmp, 'origin.git');
  g(tmp, ['init', '--quiet', '--bare', '-b', 'main', origin]);
  const work = join(tmp, 'work');
  g(tmp, ['clone', '--quiet', origin, work]);
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  commitFile(work, 'old.txt', 'ancient history', { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
  commitFile(work, 'a.txt', `add a${String.fromCharCode(10, 10)}Session: vrpc1`);
  commitFile(work, 'b.txt', 'add b');
  g(work, ['push', '--quiet', 'origin', 'HEAD:main']);
  g(work, ['checkout', '--quiet', '-b', 'feature/y']);
  commitFile(work, 'shared.txt', 'feature touches shared');
  commitFile(work, 'c.txt', 'feature adds c');
  g(work, ['push', '--quiet', 'origin', 'feature/y']);
  g(work, ['checkout', '--quiet', 'main']);
  const workRefsBefore = g(work, ['for-each-ref']);

  console.log('first read clones the mirror');
  const r1 = await mirror.originReport('demo', origin, { hours: 24 });
  same([r1.status, r1.default_branch], ['ok', 'main'], 'status ok, default branch main');
  same(r1.commits.map((c) => c.subject), ['add b', 'add a'], 'default-branch commits in the window, newest first (the 3-day-old one is outside)');
  same(r1.commits.map((c) => c.session), [null, 'vrpc1'], 'the Session: trailer, null when absent');
  same(r1.commits[1].files, ['a.txt'], 'files per commit');
  ok(/^[0-9a-f]{40}$/.test(r1.commits[0].sha) && r1.commits[0].author === 'Ada', 'sha and author');
  same(r1.branches.map((b) => [b.name, b.files]), [['feature/y', ['c.txt', 'shared.txt']]], "another branch's files vs main (main...branch)");
  const mpath = mirror.mirrorPath('demo');
  ok(existsSync(mpath) && g(mpath, ['rev-parse', '--is-bare-repository']) === 'true', `a bare mirror at ${mpath}`);
  same(g(work, ['for-each-ref']), workRefsBefore, 'the working checkout was not touched');
  const r72 = await mirror.originReport('demo', origin, { hours: 96 });
  ok(r72.commits.length === 3, 'a wider window reaches the old commit');

  console.log('fetch at most every 90 s');
  commitFile(work, 'd.txt', 'add d');
  g(work, ['push', '--quiet', 'origin', 'HEAD:main']);
  g(work, ['push', '--quiet', 'origin', '--delete', 'feature/y']);
  t += 10_000;
  const r2 = await mirror.originReport('demo', origin, { hours: 24 });
  ok(!r2.commits.some((c) => c.subject === 'add d'), '10 s later: no fetch, the new commit is not seen yet');
  t += mirror.FETCH_MIN_MS;
  const r3 = await mirror.originReport('demo', origin, { hours: 24 });
  ok(r3.commits[0]?.subject === 'add d', 'past 90 s: fetched, the new commit is first');
  same(r3.branches, [], 'fetch --prune dropped the deleted branch');
  ok(r3.status === 'ok' && r3.fetched_at === new Date(t).toISOString(), 'fetched_at is the refresh time');

  console.log('branch files: contained branches skipped, a merge read per commit (vrpc1 deploy/r17)');
  const NL2 = String.fromCharCode(10, 10);
  g(work, ['checkout', '--quiet', '-b', 'p1', 'main']);
  commitFile(work, 'p1.txt', 'p1');
  g(work, ['checkout', '--quiet', '-b', 'p2', 'main']);
  commitFile(work, 'p2.txt', 'p2');
  g(work, ['checkout', '--quiet', 'main']);
  g(work, ['merge', '--quiet', '--no-ff', '--no-edit', 'p1']);
  g(work, ['merge', '--quiet', '--no-ff', '--no-edit', 'p2']);
  commitFile(work, 'q.txt', `with a pane${NL2}Session: bt pane=recipe:x-1#5e81947e`);
  /* deploy/r17's shape: a merge of two commits main already has, made
     separately from main's own merges. Two merge bases. */
  g(work, ['checkout', '--quiet', '-b', 'stale-merge', 'p2']);
  g(work, ['merge', '--quiet', '--no-ff', '--no-edit', 'p1']);
  g(work, ['checkout', '--quiet', '-b', 'live-feat', 'main']);
  commitFile(work, 'live.txt', 'live');
  g(work, ['checkout', '--quiet', 'main']);
  g(work, ['push', '--quiet', 'origin', 'main', 'p1', 'p2', 'stale-merge', 'live-feat']);
  ok(g(work, ['diff', '--name-only', 'main...stale-merge']) !== '', 'setup: the old three-dot diff DOES report a file for the stale merge (the bug)');
  t += mirror.FETCH_MIN_MS;
  const r5 = await mirror.originReport('demo', origin, { hours: 24 });
  const names = r5.branches.map((b) => b.name);
  ok(!names.includes('p1') && !names.includes('p2'), `branches main already contains are not listed (${names.join(', ')})`);
  same(r5.branches.find((b) => b.name === 'stale-merge')?.files, [], 'a clean merge of commits main has: no files of its own');
  same(r5.branches.find((b) => b.name === 'live-feat')?.files, ['live.txt'], "a real branch: its own commit's files");
  same([r5.commits[0]?.session, r5.commits[0]?.pane], ['bt pane=recipe:x-1#5e81947e', 'recipe:x-1#5e81947e'], 'the trailer and the pane in it');
  ok(r5.commits.some((c) => c.subject === 'add a' && c.pane === null), 'a slug-only trailer has no pane');
  same(mirror.parseSession('bt pane=recipe:a#b'), { slug: 'bt', pane: 'recipe:a#b' }, 'parseSession: slug and pane');
  same(mirror.parseSession('pane=recipe:a'), { slug: null, pane: 'recipe:a' }, 'parseSession: pane only');
  same(mirror.parseSession('vrpc1'), { slug: 'vrpc1', pane: null }, 'parseSession: slug only (the old form)');
  same(mirror.parseSession(null), { slug: null, pane: null }, 'parseSession: nothing');

  console.log('failures are statuses, never throws');
  const bad = await mirror.originReport('missing', join(tmp, 'no-such-origin.git'), { hours: 24 });
  ok(bad.status === 'unavailable' && /clone failed/.test(bad.reason ?? ''), `an unreachable origin: unavailable (${bad.reason})`);
  ok(!existsSync(mirror.mirrorPath('missing')), 'a failed clone leaves no half-mirror behind');
  let threw = false;
  try {
    mirror.mirrorPath('../escape');
  } catch {
    threw = true;
  }
  ok(threw, 'a non-slug never becomes a path');
  // The origin disappears after the mirror exists: serve the old data, stale.
  rmSync(origin, { recursive: true, force: true });
  t += mirror.FETCH_MIN_MS;
  const r4 = await mirror.originReport('demo', origin, { hours: 24 });
  ok(r4.status === 'stale' && /fetch failed/.test(r4.reason ?? ''), `origin gone: stale (${r4.reason})`);
  ok(r4.commits[0]?.subject === 'with a pane', 'stale still serves what the mirror holds');
} finally {
  mirror.reset();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
