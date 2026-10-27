/**
 * GIT ON WINDOWS (E4): where git is found, and how it is run. PURE: the platform, the environment and the file-system check are passed in, so
 * the Windows rules are tested here on Linux. What this cannot prove is a real Windows run (the resolver finding a real git.exe, the real
 * process starting): that waits for a Windows machine.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGit, gitCommand, GIT_NOT_INSTALLED, _setGitPath } from '../src/engine/git-resolver.ts';
process.env.HARBOR_WB_TABLE = join(mkdtempSync(join(tmpdir(), 'wb-git-resolver-')), 'scratch.db');
const { ensureWorktree } = await import('../src/engine/worktrees.ts');
const { git: mirrorGit } = await import('../src/engine/project-mirror.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const has = (...paths: string[]) => (p: string): boolean => paths.includes(p);

console.log('\n[where git is]');
ok(resolveGit({ platform: 'linux', env: {}, exists: has() }) === 'git', 'not Windows: plain `git`, found by the OS as before');
ok(resolveGit({ platform: 'darwin', env: {}, exists: has() }) === 'git', 'macOS the same');
const onPath = 'C:\\Tools\\Git\\cmd\\git.exe';
ok(resolveGit({ platform: 'win32', env: { PATH: 'C:\\Windows;C:\\Tools\\Git\\cmd' }, exists: has(onPath) }) === onPath, 'Windows: git.exe found on PATH (the engine\'s own PATH)');
ok(resolveGit({ platform: 'win32', env: { Path: 'C:\\Windows;C:\\Tools\\Git\\cmd' }, exists: has(onPath) }) === onPath, 'Windows spells the variable `Path`; either is read');
const pf = 'C:\\Program Files\\Git\\cmd\\git.exe';
ok(resolveGit({ platform: 'win32', env: { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, exists: has(pf) }) === pf, 'not on PATH (installed while the engine was running): the standard Program Files location');
const pf86 = 'C:\\Program Files (x86)\\Git\\cmd\\git.exe';
ok(resolveGit({ platform: 'win32', env: { PATH: '', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, exists: has(pf86) }) === pf86, 'the 32-bit Program Files location');
const local = 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe';
ok(resolveGit({ platform: 'win32', env: { PATH: '', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, exists: has(local) }) === local, 'a per-user install under LocalAppData');
ok(resolveGit({ platform: 'win32', env: { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, exists: has() }) === null, 'git is not installed anywhere: null, never a guess');
ok(resolveGit({ platform: 'win32', env: { PATH: '"C:\\Tools\\Git\\cmd"' }, exists: has(onPath) }) === onPath, 'a quoted PATH entry is unquoted');
ok(resolveGit({ platform: 'win32', env: { PATH: 'C:\\A;C:\\Tools\\Git\\cmd', ProgramFiles: 'C:\\Program Files' }, exists: has(onPath, pf) }) === onPath, 'PATH wins over the standard locations (the person\'s own choice)');

console.log('\n[the Windows trap: only an ABSOLUTE git.exe is ever run]');
ok(resolveGit({ platform: 'win32', env: { PATH: '.;;..\\bin;bin' }, exists: () => true }) === null, 'a relative or empty PATH entry is never searched: a git.exe in a seat\'s worktree must not run in place of the real one');
ok(resolveGit({ platform: 'win32', env: { PATH: '.;C:\\Tools\\Git\\cmd' }, exists: has(onPath, '.\\git.exe') }) === onPath, 'with a relative entry first, the absolute one still wins');
ok(resolveGit({ platform: 'win32', env: { PATH: '\\\\server\\share\\git\\cmd' }, exists: has('\\\\server\\share\\git\\cmd\\git.exe') }) === '\\\\server\\share\\git\\cmd\\git.exe', 'a UNC path is absolute');
const abs = resolveGit({ platform: 'win32', env: { PATH: 'C:\\Tools\\Git\\cmd', ProgramFiles: 'C:\\Program Files' }, exists: has(onPath) });
ok(!!abs && /^([A-Za-z]:\\|\\\\)/.test(abs), 'whatever is found is an absolute path');
ok(resolveGit({ platform: 'win32', env: { PATH: '', ProgramFiles: 'relative\\pf' }, exists: () => true }) === null, 'a relative Program Files value is not trusted either');

console.log('\n[how it is run]');
const posix = gitCommand('linux', 'git', ['status', '--short']);
ok(posix.file === 'sh' && posix.args[0] === '-c' && /umask 002; exec git "\$@"/.test(posix.args[1]) && posix.args.slice(-2).join(' ') === 'status --short', 'not Windows: unchanged, under umask 002 through sh (group-writable files)');
const win = gitCommand('win32', onPath, ['worktree', 'add', 'C:\\x y\\wt', '-b', 'wg/a']);
ok(win.file === onPath && JSON.stringify(win.args) === JSON.stringify(['worktree', 'add', 'C:\\x y\\wt', '-b', 'wg/a']), 'Windows: git.exe directly, the arguments untouched, NO `sh`');
ok(!JSON.stringify(win).includes('umask') && win.file !== 'sh', 'and no umask (it means nothing there)');
ok(GIT_NOT_INSTALLED === 'git is not installed', 'the typed line is exactly "git is not installed"');
console.log('\n[no git at all: the typed line, at every caller, never a thrown error]');
_setGitPath(null);
const wt = await ensureWorktree({ projectDir: '/tmp/some-project', name: 'agent-a' });
ok(!wt.ok && (wt as { reason: string }).reason === 'git is not installed', 'a worktree request says "git is not installed" (the seat then starts in its folder, as it does for any worktree refusal)');
const mg = await mirrorGit(['status']);
ok(!mg.ok && mg.error === 'git is not installed', 'the project mirror says the same');
_setGitPath(undefined);
const real = await mirrorGit(['--version']);
ok(real.ok && /git version/.test(real.stdout), 'and with the seam released the real git runs again');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
