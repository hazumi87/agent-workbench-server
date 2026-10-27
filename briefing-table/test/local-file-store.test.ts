/** THE FOLDER-BACKED FILE STORE (src/engine/local-file-store.ts + the local branch of agent-share.ts): a room's assets in the person's own folder. */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badSegment, ensureDirInsideRoot, fileOnDisk, folderOnDisk, listFolder, MAX_PATH_CHARS, moveRef, openRef, putFile, RefError, mimeOf } from '../src/engine/local-file-store.ts';
import * as share from '../src/engine/agent-share.ts';

let passed = 0;
let failed = 0;
function ok(c: boolean, m: string): void {
  if (c) {
    passed++;
    console.log(`  ok ${m}`);
  } else {
    failed++;
    console.log(`  FAIL ${m}`);
  }
}
/* Directory links: a JUNCTION on Windows (no privilege needed, and it is what a OneDrive or user-made link there actually is), a symlink
   elsewhere. File symlinks need a privilege a standard Windows user does not have: when it is refused (EPERM) that case is SKIPPED, said
   so in the output, and the junction cases still run. */
const dirLink = (target: string, path: string): void => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
let skipped = 0;
function fileSymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EACCES') {
      skipped++;
      console.log('  SKIPPED a file symlink case: this user may not create file symlinks (Windows: needs Developer Mode); the junction cases cover the folder links');
      return false;
    }
    throw e;
  }
}
const throws = (fn: () => unknown, status?: number): boolean => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof RefError && (status === undefined || e.status === status);
  }
};

const tmp = mkdtempSync(join(tmpdir(), 'wb-files-'));
const root = join(tmp, 'agent-workbench');
mkdirSync(root);
const room = 'rooms/design-1a2b3c4d';
try {
  ok(folderOnDisk(root, room) === join(root, 'rooms', 'design-1a2b3c4d', 'assets'), 'a room folder keeps its assets in assets/ on disk (the Documents layout)');
  ok(folderOnDisk(root, 'rooms/_removed') === join(root, 'rooms', '_removed'), 'rooms/_removed is flat');
  ok(fileOnDisk(root, `${room}/a.png`) === join(root, 'rooms', 'design-1a2b3c4d', 'assets', 'a.png'), 'a ref maps to the file inside assets/');
  for (const bad of ['', '/etc/passwd', 'C:/x', '../x', 'rooms/../../x', 'rooms//x', 'rooms/a\\b', 'rooms/\0x', './x', 'a/./b']) {
    ok(throws(() => folderOnDisk(root, bad)), `refused as a folder: ${JSON.stringify(bad)}`);
  }
  ok(throws(() => fileOnDisk(root, 'onlyname')), 'a ref needs a folder and a name');

  ok(listFolder(root, room).length === 0, 'a folder that does not exist yet lists empty');
  const r1 = putFile(root, room, 'pic.png', Buffer.from('one'));
  ok(r1 === `${room}/pic.png` && existsSync(join(root, 'rooms', 'design-1a2b3c4d', 'assets', 'pic.png')), 'upload makes the folder and answers the ref');
  const r2 = putFile(root, room, 'pic.png', Buffer.from('two'));
  const r3 = putFile(root, room, 'pic.png', Buffer.from('three'));
  ok(r2 === `${room}/pic-1.png` && r3 === `${room}/pic-2.png`, 'an upload NEVER overwrites: name-1.ext, name-2.ext');
  ok(readFileSync(fileOnDisk(root, r1), 'utf8') === 'one', '...and the first file is untouched');
  ok(readdirSync(join(root, 'rooms', 'design-1a2b3c4d', 'assets')).every((n) => !n.includes('.part-')), 'no half-written temp file is left behind');
  ok(throws(() => putFile(root, room, '../evil.txt', Buffer.from('x'))), 'a name with a path in it is refused');
  ok(throws(() => putFile(root, room, 'a\\b.txt', Buffer.from('x'))), 'a backslash name is refused');
  ok(!existsSync(join(root, 'evil.txt')) && !existsSync(join(tmp, 'evil.txt')), 'nothing was written outside the folder');

  utimesSync(fileOnDisk(root, r1), 1000, 1000);
  utimesSync(fileOnDisk(root, r3), 3000, 3000);
  utimesSync(fileOnDisk(root, r2), 2000, 2000);
  const listed = listFolder(root, room);
  ok(listed.map((e) => e.name).join() === 'pic-2.png,pic-1.png,pic.png', 'a listing is newest first');
  ok(listed[0].mtime === 3000 && listed[0].size === 5 && listed[0].path === r3, 'with mtime in unix seconds, the size and the ref');
  mkdirSync(join(root, 'rooms', 'design-1a2b3c4d', 'assets', 'sub'));
  ok(listFolder(root, room).length === 3, 'sub-folders are not assets');

  const f = openRef(root, r1);
  ok(f.size === 3 && f.type === 'image/png', 'openRef answers size and content type');
  ok(throws(() => openRef(root, `${room}/missing.png`), 404), 'a missing file is 404');
  ok(throws(() => openRef(root, `${room}/sub`), 404), 'a folder is not a file');

  const outside = join(tmp, 'secret.txt');
  writeFileSync(outside, 'secret');
  if (fileSymlink(outside, join(root, 'rooms', 'design-1a2b3c4d', 'assets', 'link.txt'))) {
    ok(throws(() => openRef(root, `${room}/link.txt`), 404), 'a symlink pointing outside the root is not served');
    ok(listFolder(root, room).every((e) => e.name !== 'link.txt'), '...and is not listed');
  }

  const mv = moveRef(root, r1, 'rooms/_removed');
  ok(mv === 'rooms/_removed/design-1a2b3c4d--pic.png' && existsSync(join(root, 'rooms', '_removed', 'design-1a2b3c4d--pic.png')) && !existsSync(fileOnDisk(root, r1)), 'a move puts the file in the other folder (removal is a move, never a delete)');
  putFile(root, 'rooms/_removed', 'design-1a2b3c4d--pic-1.png', Buffer.from('already here'));
  const mv2 = moveRef(root, r2, 'rooms/_removed');
  ok(mv2 === 'rooms/_removed/design-1a2b3c4d--pic-1-1.png' && readFileSync(fileOnDisk(root, 'rooms/_removed/design-1a2b3c4d--pic-1.png'), 'utf8') === 'already here', 'a move never overwrites either');
  ok(throws(() => moveRef(root, `${room}/nothing.png`, 'rooms/_removed'), 404), 'moving a missing file is 404');
  ok(mimeOf('x.unknown') === 'application/octet-stream' && mimeOf('N.MD').startsWith('text/markdown'), 'content types come from the extension');

  /* ---- review fixes (builder-one, lead ruling 15693) ---- */
  // 1. check before creating: a folder inside the root that points elsewhere must not get directories created at its target
  const elsewhere = join(tmp, 'elsewhere');
  mkdirSync(elsewhere);
  mkdirSync(join(root, 'rooms'), { recursive: true });
  dirLink(elsewhere, join(root, 'rooms', 'evil-aaaaaaaa'));
  ok(throws(() => putFile(root, 'rooms/evil-aaaaaaaa', 'x.txt', Buffer.from('x'))), 'an upload into a folder that is a symlink out of the root is refused');
  ok(readdirSync(elsewhere).length === 0, '...and NOTHING was created at the symlink target (no assets/ folder, no file)');
  ok(throws(() => moveRef(root, r3, 'rooms/evil-aaaaaaaa')), 'a move into it is refused too');
  ok(readdirSync(elsewhere).length === 0, '...with nothing created there either');
  ok(existsSync(fileOnDisk(root, r3)), '...and the source file is still where it was');
  // 2. Windows names, in every segment and in upload names
  for (const bad of ['CON', 'con.txt', 'Nul', 'AUX.md', 'COM1', 'lpt9.png', 'a:b', 'a.txt:stream', 'name.', 'name ', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\u0001b']) {
    ok(badSegment(bad), `refused as a name: ${JSON.stringify(bad)}`);
    ok(throws(() => putFile(root, room, bad, Buffer.from('x'))), `...and as an upload name`);
  }
  for (const good of ['console.txt', 'COM10', 'communication.png', 'a.b.c', 'résumé.pdf', 'file (1).jpg', '.hidden']) {
    ok(!badSegment(good), `allowed: ${JSON.stringify(good)}`);
  }
  ok(throws(() => folderOnDisk(root, 'rooms/NUL')) && throws(() => fileOnDisk(root, 'rooms/x/a:b')), 'the same rule applies to every segment of a ref');
  // 3. never overwrite, for real: a name taken in between is skipped, not replaced
  const base = putFile(root, room, 'race.txt', Buffer.from('mine'));
  writeFileSync(join(root, 'rooms', 'design-1a2b3c4d', 'assets', 'race-1.txt'), 'made by a sync tool');
  const next = putFile(root, room, 'race.txt', Buffer.from('second'));
  ok(next === `${room}/race-2.txt` && readFileSync(fileOnDisk(root, `${room}/race-1.txt`), 'utf8') === 'made by a sync tool' && readFileSync(fileOnDisk(root, base), 'utf8') === 'mine', 'a file that appeared at the next name is never replaced');
  // 4. listings skip temp and lock files
  writeFileSync(join(root, 'rooms', 'design-1a2b3c4d', 'assets', '.upload.part-1'), 'half');
  writeFileSync(join(root, 'rooms', 'design-1a2b3c4d', 'assets', '~$lock.docx'), 'lock');
  ok(listFolder(root, room).every((e) => !e.name.startsWith('.') && !e.name.startsWith('~$')), 'a listing skips dot files and ~$ lock files');
  // 5. path length
  ok(MAX_PATH_CHARS === 240, 'the path limit is 240 characters');
  ok(throws(() => putFile(root, room, `${'n'.repeat(200)}.txt`, Buffer.from('x'))), 'an over-long name is refused with a clear error, not a 500');
  // 6. a removed file keeps its origin
  const keep = putFile(root, room, 'origin.png', Buffer.from('o'));
  const removed = moveRef(root, keep, 'rooms/_removed');
  ok(removed === 'rooms/_removed/design-1a2b3c4d--origin.png', `under _removed the file's name carries its room (${removed})`);
  const between = moveRef(root, putFile(root, room, 'plain.txt', Buffer.from('p')), 'rooms/other-bbbbbbbb');
  ok(between === 'rooms/other-bbbbbbbb/plain.txt', 'a move between rooms keeps the plain name');
  ok(moveRef(root, between, 'rooms/_removed') === 'rooms/_removed/other-bbbbbbbb--plain.txt', 'and removal records the room it came from last');

  // recheck notes (lead ruling 15724)
  for (const hidden of ['.env', '~$report.docx', '.part']) {
    ok(throws(() => putFile(root, room, hidden, Buffer.from('x')), 400), `an upload named ${JSON.stringify(hidden)} is a clear 400 (it would vanish from the assets list)`);
  }
  ok(badSegment('CONIN$') && badSegment('conout$') && !badSegment('conin$x'), 'CONIN$ and CONOUT$ are refused as names');
  let longestOk = 0;
  let removedOk = true;
  for (let n = 120; n <= 235; n += 5) {
    const nm = `${'n'.repeat(n)}.txt`;
    let ref: string | null = null;
    try {
      ref = putFile(root, room, nm, Buffer.from('x'));
    } catch (e) {
      if (!(e instanceof RefError)) throw e;
    }
    if (ref) {
      longestOk = n;
      try {
        moveRef(root, ref, 'rooms/_removed');
      } catch {
        removedOk = false;
      }
    }
  }
  ok(longestOk > 0 && removedOk, `every name the upload accepts can also be removed (longest accepted: ${longestOk} characters + .txt)`);
  // note copies and the inside-the-root check
  const notesRoomLink = join(root, 'rooms', 'linked-cccccccc');
  const notesTarget = join(tmp, 'notes-target');
  mkdirSync(notesTarget);
  dirLink(notesTarget, notesRoomLink);
  ok(throws(() => ensureDirInsideRoot(root, join(notesRoomLink, 'notes'))), 'a notes folder under a room folder that is a link out of the root is refused');
  ok(readdirSync(notesTarget).length === 0, '...and nothing is created at the link target');
  ensureDirInsideRoot(root, join(root, 'rooms', 'fine-dddddddd', 'notes'));
  ok(existsSync(join(root, 'rooms', 'fine-dddddddd', 'notes')), 'a normal notes folder is made');

  /* through the share client's own functions (what the routes call) */
  process.env.HARBOR_WB_FILES_DIR = root;
  ok(share.shareConfigured() && share.shareSource() === 'folder', 'the share client says a folder store is configured');
  const up = await share.upload(room, 'doc.txt', 'text/plain', Buffer.from('hello'));
  ok(up.ok && up.path === `${room}/doc.txt`, 'share.upload goes to the folder');
  const ls = await share.list(room);
  ok(ls.some((e) => e.name === 'doc.txt' && e.kind === 'text' && e.size === 5), 'share.list reads it back, with its kind');
  const got = await share.fetchRaw(`${room}/doc.txt`, 'GET');
  ok(got.status === 200 && (await got.text()) === 'hello' && got.headers.get('content-type')?.startsWith('text/plain') === true && got.headers.get('content-length') === '5', 'share.fetchRaw streams it with type and length');
  const head = await share.fetchRaw(`${room}/doc.txt`, 'HEAD');
  ok(head.status === 200 && head.headers.get('content-length') === '5', 'HEAD answers the headers');
  ok((await share.fetchRaw(`${room}/gone.txt`, 'GET')).status === 404, 'a missing ref is 404, not an error');
  ok((await share.fetchRaw('../../etc/passwd', 'GET')).status === 400, 'a traversal ref is refused (400)');
  const mvd = await share.move(`${room}/doc.txt`, share.REMOVED_DIR);
  ok(mvd.ok && mvd.path === 'rooms/_removed/design-1a2b3c4d--doc.txt', 'share.move to the removed folder keeps the room in the name');
  const badUp = await share.upload('../up', 'x.txt', 'text/plain', Buffer.from('x'));
  ok(!badUp.ok && badUp.status === 400, 'an upload into a traversal folder is a 400, not a write');
  ok(share.refUrl(`${room}/pic-2.png`).startsWith('file:///') && share.refUrl(`${room}/pic-2.png`).endsWith('/assets/pic-2.png'), 'the agent-facing URL of a ref is the file itself');
} catch (e) {
  failed++;
  console.log(`  FAIL harness: ${(e as Error).stack}`);
} finally {
  delete process.env.HARBOR_WB_FILES_DIR;
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}${skipped ? ` (${skipped} case skipped: file symlinks not allowed for this user)` : ''}`);
process.exit(failed ? 1 : 0);
