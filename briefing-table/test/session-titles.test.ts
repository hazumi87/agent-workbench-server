/* session-titles: a live session's NAME MOVES, and the cache has to follow it.
 *
 * THE REGRESSION THIS GUARDS (Owner, 2026-09-13): "the names of the chats aren't
 * updating again". The only caller of `refresh` was gated on the row having no
 * title yet, so the first fetch after boot won and the name froze there for the
 * life of the engine. Rows read `/login` and `/agent-message` for days — the last
 * prompt of a session that had since been renamed, with the /rename already
 * sitting in the transcript the engine had simply stopped reading.
 *
 * So the assertion that matters is the SECOND fetch: refresh, rename on disk,
 * refresh again, and the new name must come through. The TTL is the only thing
 * allowed to delay it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'wb-titles-'));
process.env.HARBOR_WB_CLAUDE_PROJECTS = root;
process.env.HARBOR_WB_TITLE_TTL_MS = '500'; // long enough to assert it GATES, short enough to step over

const claudeCode = await import('../src/engine/vendors/claude-code.ts');
const titles = await import('../src/engine/session-titles.ts');
const { normalizeProjectDir } = await import('../src/engine/project-dir.ts');

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  cond ? pass++ : fail++;
};

const PROJECT = 'C:\work\fixture';
const SESSION = '11111111-2222-3333-4444-555555555555';
const dir = join(root, claudeCode.encodeProjectDir(PROJECT));
mkdirSync(dir, { recursive: true });

/** Write the transcript the way claude does: the LAST occurrence wins. */
function transcript(lines: Array<Record<string, unknown>>) {
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}
/** Long enough for a fire-and-forget fetch to land; far short of the TTL. */
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const pastTtl = () => settle(600);
const refresh = () => titles.refresh('R', { projectDir: PROJECT });

console.log('\n[session-titles: the first fetch]');
transcript([{ type: 'user', lastPrompt: '/agent-message' }]);
refresh();
await settle();
ok(titles.known('R', SESSION) === '/agent-message', 'falls back to the last prompt when untitled',
  String(titles.known('R', SESSION)));

console.log('\n[session-titles: a /rename REACHES a name we already had]');
transcript([{ type: 'user', lastPrompt: '/agent-message' }, { customTitle: 'Audio-captions' }]);
await pastTtl();
refresh();
await settle();
ok(titles.known('R', SESSION) === 'Audio-captions',
  'the renamed title replaces the frozen one', String(titles.known('R', SESSION)));

console.log('\n[session-titles: the change is ANNOUNCED, not left to be polled]');
let announced: string[] = [];
titles.setOnChange((rid) => announced.push(rid));
transcript([{ customTitle: 'briefing-table on ui-toolkit' }]);
await pastTtl();
refresh();
await settle();
ok(announced.includes('R'), 'onChange fired for the project that moved', JSON.stringify(announced));
ok(titles.known('R', SESSION) === 'briefing-table on ui-toolkit', 'and the new name is served',
  String(titles.known('R', SESSION)));

console.log('\n[session-titles: an unchanged fetch announces NOTHING]');
announced = [];
await pastTtl();
refresh();
await settle();
ok(announced.length === 0, 'a tick that carried no news wakes nobody', JSON.stringify(announced));

console.log('\n[session-titles: the TTL still gates the I/O]');
transcript([{ customTitle: 'too soon to see' }]);
refresh(); // immediately — inside the TTL
await settle();
ok(titles.known('R', SESSION) === 'briefing-table on ui-toolkit',
  'a refresh inside the TTL does not re-read the disk', String(titles.known('R', SESSION)));

console.log('\n[session-titles: the ENGINE\'s own clock, with nobody polling]');
/* THE ACTUAL DEFECT. `refresh` always worked when called; what froze the names
   was that the only caller gave up as soon as it had an answer, so a session's
   name last moved when a manager happened to be open and the title happened to
   be unknown. This asserts the replacement: a live pane's name follows the
   transcript with NO ONE calling refresh and NO ONE polling. */
transcript([{ customTitle: 'renamed while nobody was looking' }]);
const timer = titles.startAutoRefresh(
  () => [{ recipeId: 'R', projectDir: PROJECT }],
  60,
);
await settle(900); // a few ticks, spanning the TTL
clearInterval(timer);
ok(titles.known('R', SESSION) === 'renamed while nobody was looking',
  'the name followed the transcript unprompted', String(titles.known('R', SESSION)));

/* A DEAD PROJECT NEVER COSTS A ROUND TRIP — the supply is the gate, and on a
   server project each tick would otherwise be an ssh call for a session nobody is
   typing in. */
let asked = 0;
const timer2 = titles.startAutoRefresh(() => {
  asked++;
  return [];
}, 40);
await settle(200);
clearInterval(timer2);
ok(asked >= 2, 'the sweep keeps asking who is live', `${asked} ticks`);

console.log('\n[session-titles: a hand-typed projectDir with a trailing slash]');
/* Claude encodes the process CWD, which never carries a trailing separator.
   A recipe's projectDir is typed by a human: `/srv/code/kiosk/` encoded
   to `-srv-code-kiosk-`, a directory that does not exist, so the pane ran
   for days with no name — and its restore path was reading the same empty dir.
   Found on the server 2026-09-13 while verifying the cache fix. */
ok(
  claudeCode.encodeProjectDir('/srv/code/kiosk/') ===
    claudeCode.encodeProjectDir('/srv/code/kiosk'),
  'a trailing slash encodes to the same dir as without one',
  claudeCode.encodeProjectDir('/srv/code/kiosk/'),
);
ok(
  claudeCode.encodeProjectDir('C:\\code\\briefing-table\\') ===
    'C--code-briefing-table',
  'a trailing backslash too (the same recipe field on Windows)',
  claudeCode.encodeProjectDir('C:\\code\\briefing-table\\'),
);
ok(
  claudeCode.encodeProjectDir('/') === '-',
  'root is left alone — it has no name to lose',
  claudeCode.encodeProjectDir('/'),
);

console.log('\n[project-dir: normalise what has exactly one right answer]');
/* A trailing separator is not a matter of taste -- claude names its transcript
   dir after the process CWD, which never carries one. These are auto-fixed on
   write precisely so the warning channel stays for things a human must decide. */
ok(
  normalizeProjectDir('/srv/code/kiosk/') === '/srv/code/kiosk',
  'the trailing slash that cost Kiosk its name',
  normalizeProjectDir('/srv/code/kiosk/'),
);
ok(
  normalizeProjectDir('/srv/code/kiosk') === '/srv/code/kiosk',
  'an already-clean path is left exactly alone',
  normalizeProjectDir('/srv/code/kiosk'),
);
ok(
  normalizeProjectDir('C:\\code\\briefing-table\\') === 'C:\\code\\briefing-table',
  'a trailing backslash too',
  normalizeProjectDir('C:\\code\\briefing-table\\'),
);
ok(
  normalizeProjectDir('  /srv/code/auriga  ') === '/srv/code/auriga',
  'surrounding whitespace from a paste',
  normalizeProjectDir('  /srv/code/auriga  '),
);
ok(
  normalizeProjectDir('/srv///code/auriga') === '/srv/code/auriga',
  'doubled separators collapse',
  normalizeProjectDir('/srv///code/auriga'),
);
ok(
  normalizeProjectDir('/srv/code/auriga///') === '/srv/code/auriga',
  'several trailing separators',
  normalizeProjectDir('/srv/code/auriga///'),
);
ok(
  normalizeProjectDir('/') === '/',
  'root keeps its separator -- it IS the path',
  normalizeProjectDir('/'),
);
ok(
  normalizeProjectDir('C:\\') === 'C:\\',
  'a Windows drive root keeps its separator too',
  normalizeProjectDir('C:\\'),
);
ok(
  normalizeProjectDir('\\\\nas\\share\\') === '\\\\nas\\share',
  'a UNC path keeps its leading pair',
  normalizeProjectDir('\\\\nas\\share\\'),
);
/* THE POINT OF ALL OF THE ABOVE: the normalised path and the raw one must
   encode to the SAME transcript dir, which is what broke. */
ok(
  claudeCode.encodeProjectDir(normalizeProjectDir('/srv/code/kiosk/')) ===
    '-srv-code-kiosk',
  'the normalised path encodes to the dir claude actually made',
  claudeCode.encodeProjectDir(normalizeProjectDir('/srv/code/kiosk/')),
);

rmSync(root, { recursive: true, force: true });
console.log(`\n${'='.repeat(40)}\nPASS ${pass}  FAIL ${fail}`);
if (fail) {
  process.exit(1);
}

console.log('\n[session-titles: a WORKTREE seat resolves through its own folder, never merged into the recipe listing]');
{
  const WT_PROJECT = '/srv/worktrees/fixture/fixture';
  const WT_SESSION = '99999999-8888-7777-6666-555555555555';
  const wtDir = join(root, claudeCode.encodeProjectDir(WT_PROJECT));
  mkdirSync(wtDir, { recursive: true });
  writeFileSync(
    join(wtDir, `${WT_SESSION}.jsonl`),
    [
      JSON.stringify({ customTitle: 'Worktree chat' }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5' } }),
    ].join('\n'),
  );
  let notified: string[] = [];
  titles.setOnChange((rid) => notified.push(rid));
  ok(titles.known('R2', WT_SESSION) === null && titles.modelOf('R2', WT_SESSION) === null, 'before the worktree folder is listed: nothing known');
  titles.refresh(titles.worktreeKey('R2', 'wg'), { projectDir: WT_PROJECT });
  await settle();
  ok(titles.known('R2', WT_SESSION) === 'Worktree chat', 'the title resolves by session id', String(titles.known('R2', WT_SESSION)));
  ok(titles.modelOf('R2', WT_SESSION)?.model === 'sonnet', 'and so does the MODEL the seats window shows (claude-sonnet-5-5 -> sonnet)', JSON.stringify(titles.modelOf('R2', WT_SESSION)));
  ok(notified.includes('R2') && !notified.some((k) => k.includes('@wt:')), 'listeners hear the RECIPE id, not the cache key', JSON.stringify(notified));
  ok(titles.rows('R2').length === 0, 'rows() (adoption + /clear verdicts) never sees the worktree listing');
  ok(titles.known('R', WT_SESSION) === null, "another recipe's lookup does not pick it up");
  titles.forget('R2');
  ok(titles.known('R2', WT_SESSION) === null, 'forget() drops the worktree entries with the recipe');
}

console.log('all green');
