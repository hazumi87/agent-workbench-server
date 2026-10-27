/**
 * THE ROOM CODE FOLDER (step C; planning KB design-notes-id; src/engine/code-folder.ts, table/store.ts setRoomCodeFolder): inspect a folder (three outcomes for
 * "is it a git project": yes / no / could not tell because git is missing), make a new project (git init + a first commit under a fallback identity when the
 * person has none), set a room's code folder (existing / new / none) and refuse what cannot work (no git, a missing folder, a workgroup), and the git override.
 * Real git in temp folders; a scratch table; nothing listens.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'wb-code-folder-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
/* a home with NO git identity, so the fallback identity is what the first commit needs */
const home = join(dir, 'home');
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
delete process.env.GIT_AUTHOR_NAME;
delete process.env.GIT_COMMITTER_NAME;
delete process.env.GIT_AUTHOR_EMAIL;
delete process.env.GIT_COMMITTER_EMAIL;

const { table } = await import('../src/table/endpoint.ts');
const cf = await import('../src/engine/code-folder.ts');
const gr = await import('../src/engine/git-resolver.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env } }).trim();

console.log('\n[the git override and the status the app reads]');
ok(gr.resolveGit({ platform: 'linux', env: { HARBOR_WB_GIT: 'none' } }) === null, 'HARBOR_WB_GIT=none: git is "not installed" (also how a test or a person switches it off)');
ok(gr.resolveGit({ platform: 'linux', env: { HARBOR_WB_GIT: '/opt/mygit/bin/git' }, exists: (p) => p === '/opt/mygit/bin/git' }) === '/opt/mygit/bin/git', 'an absolute path in HARBOR_WB_GIT wins');
ok(gr.resolveGit({ platform: 'linux', env: { HARBOR_WB_GIT: '/opt/mygit/bin/git' }, exists: () => false }) === null, '...but a path that does not exist is not a git (never a guess)');
ok(gr.resolveGit({ platform: 'linux', env: { HARBOR_WB_GIT: 'relative/git' }, exists: () => true }) === null, 'a relative override is refused (the Windows current-directory trap, everywhere)');
ok(gr.resolveGit({ platform: 'linux', env: {} }) === 'git', 'unset: unchanged');
const st = await cf.gitStatus();
ok(st.found === true && /^git version/.test(st.version ?? ''), 'gitStatus on this machine: found, with its version', st);
gr._setGitPath(null);
const none = await cf.gitStatus();
ok(none.found === false && none.version === null && none.message === 'git is not installed', 'with no git: {found:false} and the typed line "git is not installed"', none);
gr._setGitPath(undefined);

console.log('\n[inspecting a folder: yes / no / could not tell]');
const plain = join(dir, 'plain');
mkdirSync(plain);
const i1 = await cf.inspectFolder(plain);
ok(i1.exists && i1.isDir && i1.git === 'not-repo', 'an ordinary folder: exists, not a git project');
const i2 = await cf.inspectFolder(join(dir, 'nope'));
ok(!i2.exists && i2.git === 'unknown', 'a folder that does not exist: exists false');
const f = join(dir, 'a-file');
writeFileSync(f, 'x');
ok((await cf.inspectFolder(f)).isDir === false, 'a file is not a folder');
gr._setGitPath(null);
ok((await cf.inspectFolder(plain)).git === 'unknown', 'with no git it CANNOT TELL: "unknown", never "not a repo" (three outcomes)');
gr._setGitPath(undefined);

console.log('\n[making a new project: git init, a first commit under a fallback identity]');
const proj = join(dir, 'code', 'my-project');
const made = await cf.makeProject(proj);
ok(made.ok === true && existsSync(join(proj, '.git')), 'the folder is created (with its parents) and is a git project');
ok(git(proj, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main', 'on a branch called main');
ok(git(proj, 'log', '--format=%an <%ae>', '-1') === 'Workbench <workbench@localhost>', 'its first commit exists under the fallback identity (the person has none configured)');
ok(!existsSync(join(home, '.gitconfig')) || !/Workbench/.test(readFileSync(join(home, '.gitconfig'), 'utf8')), '...the fallback identity is used for that one commit only, never saved to a config');
const again = await cf.makeProject(proj);
ok(again.ok === true && git(proj, 'rev-list', '--count', 'HEAD') === '1', 'making a project of an existing one changes nothing (still one commit)');
mkdirSync(join(dir, 'full'));
writeFileSync(join(dir, 'full', 'keep.txt'), 'mine');
const full = await cf.makeProject(join(dir, 'full'));
ok(full.ok === true && readFileSync(join(dir, 'full', 'keep.txt'), 'utf8') === 'mine' && git(join(dir, 'full'), 'rev-list', '--count', 'HEAD') === '1', 'a folder with files becomes a project with its files untouched (the first commit is empty)');
git(proj, 'config', 'user.name', 'Owner');
git(proj, 'config', 'user.email', 'noreply@example.com');
const withId = join(dir, 'with-identity');
execFileSync('git', ['config', '--global', 'user.name', 'Owner'], { env: { ...process.env } });
execFileSync('git', ['config', '--global', 'user.email', 'noreply@example.com'], { env: { ...process.env } });
await cf.makeProject(withId);
ok(git(withId, 'log', '--format=%an', '-1') === 'Owner', 'when the person HAS an identity, the first commit is theirs, not the fallback');
execFileSync('git', ['config', '--global', '--unset', 'user.name'], { env: { ...process.env } });
execFileSync('git', ['config', '--global', '--unset', 'user.email'], { env: { ...process.env } });
gr._setGitPath(null);
const noGit = await cf.makeProject(join(dir, 'never'));
ok(noGit.ok === false && noGit.reason === 'git is not installed' && !existsSync(join(dir, 'never')), 'with no git: refused with the typed line, and nothing was created');
gr._setGitPath(undefined);

console.log('\n[setting a room\'s code folder]');
const main = table.createRoom({ name: 'Code room' }, { actor: 'user' }).result;
const wg = table.createRoom({ name: 'Sub', parent_id: main.id, alias: 'sub' }, { actor: 'user' }).result;
const repo = join(dir, 'existing-repo');
await cf.makeProject(repo);
const s1 = await cf.setCodeFolder(main.id, { mode: 'existing', path: repo });
ok(s1.ok === true && s1.codeFolder?.mode === 'existing' && s1.codeFolder?.path === repo && s1.codeFolder?.git === 'repo', 'an existing git folder: set, and says it is a project');
ok(table.getRoom(main.id)!.code_dir === repo && table.getRoom(main.id)!.code_mode === 'existing', 'stored on the main room');
ok(table.familyCodeFolder(wg.id)?.dir === repo && table.familyCodeFolder(main.id)?.dir === repo, 'a workgroup reads its FAMILY\'s folder');
const s2 = await cf.setCodeFolder(wg.id, { mode: 'existing', path: repo });
ok(s2.ok === false && s2.status === 409 && /main room/.test(s2.reason), 'a workgroup can not set its own (409, says to use the main room)');
const s3 = await cf.setCodeFolder(main.id, { mode: 'existing', path: join(dir, 'missing') });
ok(s3.ok === false && s3.status === 400 && s3.field === 'path', 'a folder that does not exist: 400 naming the path');
ok(table.getRoom(main.id)!.code_dir === repo, '...and the stored folder did not change');
const s4 = await cf.setCodeFolder(main.id, { mode: 'existing', path: f });
ok(s4.ok === false && s4.status === 400, 'a file is not a code folder');
const s5 = await cf.setCodeFolder(main.id, { mode: 'existing', path: plain });
ok(s5.ok === true && s5.codeFolder?.git === 'not-repo', 'an existing NON-git folder is accepted and reported "not-repo" (it is not redirected; the room will say so)');
const s6 = await cf.setCodeFolder(main.id, { mode: 'new', path: join(dir, 'code', 'fresh-one') });
ok(s6.ok === true && s6.codeFolder?.mode === 'new' && s6.codeFolder?.git === 'repo' && existsSync(join(dir, 'code', 'fresh-one', '.git')), 'a NEW folder: created and made a git project');
const s7 = await cf.setCodeFolder(main.id, { mode: 'new', path: plain });
ok(s7.ok === true && s7.codeFolder?.mode === 'new' && s7.codeFolder?.git === 'repo', 'a new folder over an EXISTING EMPTY folder is fine (it becomes the project)');
mkdirSync(join(dir, 'busy'));
writeFileSync(join(dir, 'busy', 'x.txt'), 'x');
const s8 = await cf.setCodeFolder(main.id, { mode: 'new', path: join(dir, 'busy') });
ok(s8.ok === false && s8.status === 409 && /not empty/.test(s8.reason), '"new" over a folder that has files in it is refused (use "existing" for that)');
const s9 = await cf.setCodeFolder(main.id, { mode: 'none' });
ok(s9.ok === true && s9.codeFolder === null && table.getRoom(main.id)!.code_dir === null, 'none clears it');
const s10 = await cf.setCodeFolder(main.id, { mode: 'sideways' as never, path: repo });
ok(s10.ok === false && s10.status === 400 && s10.field === 'mode', 'an unknown mode is a 400');
gr._setGitPath(null);
const s11 = await cf.setCodeFolder(main.id, { mode: 'existing', path: repo });
ok(s11.ok === false && s11.status === 409 && s11.reason === 'git is not installed' && s11.code === 'no-git', 'with no git, a code folder can not be set: 409 "git is not installed" (the app dims the choice)');
const s12 = await cf.setCodeFolder(main.id, { mode: 'none' });
ok(s12.ok === true, '...but "no folder" still can');
gr._setGitPath(undefined);

console.log('\n[checking a folder before a room exists (creating a room with a code folder must not leave an empty room behind)]');
const chk1 = await cf.checkCodeFolder({ mode: 'existing', path: repo });
ok(chk1.ok === true && chk1.mode === 'existing' && chk1.dir === repo, 'a good existing folder checks out');
const chk2 = await cf.checkCodeFolder({ mode: 'existing', path: join(dir, 'does-not-exist') });
ok(chk2.ok === false && chk2.status === 400 && chk2.field === 'path', 'a missing folder is refused BEFORE anything is created');
const roomsBefore = table.listRooms({}).length;
const chk3 = await cf.checkCodeFolder({ mode: 'new', path: join(dir, 'busy') });
ok(chk3.ok === false && chk3.status === 409 && table.listRooms({}).length === roomsBefore, '"new" over a folder with files: refused, and checking creates nothing');
ok(!existsSync(join(dir, 'code', 'never-created')) && (await cf.checkCodeFolder({ mode: 'new', path: join(dir, 'code', 'never-created') })).ok === true && !existsSync(join(dir, 'code', 'never-created')), 'checking a "new" folder does NOT create it (only setting does)');
ok((await cf.checkCodeFolder({ mode: 'none' })).ok === true, 'none always checks out');
gr._setGitPath(null);
ok((await cf.checkCodeFolder({ mode: 'new', path: join(dir, 'x') })).code === 'no-git', 'no git: the typed refusal, before a room is made');
gr._setGitPath(undefined);

console.log('\n[one level only, and the answer the app reads]');
await cf.setCodeFolder(main.id, { mode: 'existing', path: repo });
const view = await cf.codeFolderView(wg.id);
ok(view?.path === repo && view.mode === 'existing' && view.git === 'repo' && view.owner === main.id, 'the view for a workgroup is its family\'s, and says whose it is');
ok((await cf.codeFolderView(table.createRoom({ name: 'Other' }, { actor: 'user' }).result.id)) === null, 'a room with none: null');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
