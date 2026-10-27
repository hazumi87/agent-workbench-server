/**
 * FOLDER TRUST (E3), the file side: write projects["<folder>"].hasTrustDialogAccepted into the user's .claude.json right before a launch, READ IT
 * BACK, and report one of three outcomes (trusted / could-not-write / could-not-verify). The pure merge is hosted-trust.ts (test/hosted-trust.test.ts).
 * Injected io, so nothing here touches a real home folder.
 */
import { trustFolder, trustKeysFor, claudeJsonPath, type TrustIo } from '../src/engine/folder-trust.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function memIo(initial: string | null, o: { dropWrites?: boolean; throwOnWrite?: boolean; throwOnRead?: boolean; corruptAfterWrite?: boolean } = {}): TrustIo & { text: string | null; writes: number } {
  const io = {
    text: initial,
    writes: 0,
    read: (_p: string) => {
      if (o.throwOnRead) throw new Error('EACCES: read');
      return io.text;
    },
    write: (_p: string, t: string) => {
      if (o.throwOnWrite) throw new Error('EACCES: write');
      io.writes++;
      if (!o.dropWrites) io.text = o.corruptAfterWrite ? '{ not json' : t;
    },
  };
  return io;
}
const projects = (io: { text: string | null }): Record<string, { hasTrustDialogAccepted?: boolean }> => JSON.parse(io.text ?? '{}').projects ?? {};

console.log('\n[where the file is, and which keys]');
ok(claudeJsonPath({}, '/home/u') === '/home/u/.claude.json', 'the default is ~/.claude.json');
ok(claudeJsonPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u') === '/cfg/.claude.json', 'CLAUDE_CONFIG_DIR moves it');
ok(JSON.stringify(trustKeysFor('/home/u/agents/lead/', 'linux')) === '["/home/u/agents/lead"]', 'a trailing separator is not part of the key');
const win = trustKeysFor('C:\\Users\\u\\agents\\lead', 'win32');
ok(win.length === 2 && win.includes('C:\\Users\\u\\agents\\lead') && win.includes('C:/Users/u/agents/lead'), 'on Windows both spellings are written until a capture settles which Claude uses (unverified)');

console.log('\n[a trusted folder: written, read back]');
const a = memIo(JSON.stringify({ theme: 'dark', projects: { '/other': { hasTrustDialogAccepted: true, allowedTools: ['x'] } } }));
const ra = trustFolder('/home/u/agents/lead', a, '/home/u/.claude.json', 'linux');
ok(ra.state === 'trusted' && ra.changed === true, 'trusted, changed');
ok(projects(a)['/home/u/agents/lead']?.hasTrustDialogAccepted === true, 'the key is there');
ok(JSON.parse(a.text!).theme === 'dark' && projects(a)['/other']?.hasTrustDialogAccepted === true && JSON.stringify(projects(a)['/other']).includes('allowedTools'), 'every other key and project survives untouched');
const rb = trustFolder('/home/u/agents/lead', a, '/home/u/.claude.json', 'linux');
ok(rb.state === 'trusted' && rb.changed === false && a.writes === 1, 'a second time: already trusted, NOT rewritten (the write is as narrow as it can be)');
const c = memIo(null);
ok(trustFolder('/x', c, '/p', 'linux').state === 'trusted' && JSON.parse(c.text!).projects['/x'].hasTrustDialogAccepted === true, 'no file yet: it is created with just this');

console.log('\n[three outcomes, never two]');
const bad = memIo('{ not json');
const rbad = trustFolder('/x', bad, '/p', 'linux');
ok(rbad.state === 'could-not-write' && /JSON/.test(rbad.reason) && bad.text === '{ not json' && bad.writes === 0, 'an unparseable file is left ALONE and reported');
ok(trustFolder('/x', memIo('[]'), '/p', 'linux').state === 'could-not-write', 'a file that is not an object is refused');
const rw = trustFolder('/x', memIo('{}', { throwOnWrite: true }), '/p', 'linux');
ok(rw.state === 'could-not-write' && /EACCES/.test(rw.reason), 'a write that throws: could-not-write, with the reason');
ok(trustFolder('/x', memIo('{}', { throwOnRead: true }), '/p', 'linux').state === 'could-not-write', 'a read that throws: could-not-write');
const dropped = memIo('{}', { dropWrites: true });
const rd = trustFolder('/x', dropped, '/p', 'linux');
ok(rd.state === 'could-not-verify' && /read back/i.test(rd.reason), 'a write that did not stick (or was lost to a concurrent writer): could-not-verify, never "trusted"');
ok(trustFolder('/x', memIo('{}', { corruptAfterWrite: true }), '/p', 'linux').state === 'could-not-verify', 'a file that no longer parses after the write: could-not-verify');
ok(trustFolder('', memIo('{}'), '/p', 'linux').state === 'could-not-write' && trustFolder('relative/dir', memIo('{}'), '/p', 'linux').state === 'could-not-write', 'an empty or relative folder is refused: the key must be the exact absolute path');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
