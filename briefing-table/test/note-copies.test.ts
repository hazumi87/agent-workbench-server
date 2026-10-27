/** NOTE COPIES, pure rules (src/engine/note-copies.ts): names, the read-only header, the once-per-interval rationing, retitling, removal. */
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COPY_HEADER, COPY_INTERVAL_MS, NoteCopier, copyBody, copyFileName, noteTitle, retireCopy, titleSlug, writeCopy } from '../src/engine/note-copies.ts';

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

ok(COPY_INTERVAL_MS === 30000, 'a copy is written at most every 30 seconds');
ok(noteTitle('# Plan for Friday\nmore') === 'Plan for Friday' && noteTitle('\n\n- **Bold** item') === 'Bold item' && noteTitle('') === 'Untitled note', 'the title is the first real line without markdown marks');
ok(noteTitle('x'.repeat(100)).length <= 60, 'a long title is cut');
ok(titleSlug('Plan for Friday!') === 'plan-for-friday' && titleSlug('Café déjà vu') === 'cafe-deja-vu' && titleSlug('???') === 'note', 'the slug is plain ASCII, never empty');
ok(titleSlug('a'.repeat(100)).length <= 40, 'the slug is capped');
ok(copyFileName('abc123def456', '# Hi') === 'hi-abc123def456.md', 'the file name is <slug>-<noteId>.md');
ok(copyBody('hello').startsWith(`${COPY_HEADER}\n\n`) && copyBody('hello').endsWith('hello\n'), 'the first line says it is a read-only copy and where to edit');
ok(/Edit this note in Agent Workbench/.test(COPY_HEADER) && /not saved back/.test(COPY_HEADER), '...in plain words');

const tmp = mkdtempSync(join(tmpdir(), 'wb-notes-'));
try {
  const dir = join(tmp, 'notes');
  const name = writeCopy(dir, 'aaaaaaaaaaaa', '# First\nbody');
  ok(name === 'first-aaaaaaaaaaaa.md' && readFileSync(join(dir, name), 'utf8').includes('body'), 'writeCopy makes the folder and the file');
  ok((statSync(join(dir, name)).mode & 0o222) === 0, 'the file carries the read-only attribute');
  const again = writeCopy(dir, 'aaaaaaaaaaaa', '# First\nnew body');
  ok(again === name && readFileSync(join(dir, name), 'utf8').includes('new body'), 'a read-only copy can be replaced by the next save');
  const retitled = writeCopy(dir, 'aaaaaaaaaaaa', '# Second title\nx');
  ok(retitled === 'second-title-aaaaaaaaaaaa.md' && !existsSync(join(dir, name)), 'a retitled note REPLACES its copy instead of leaving a second one');
  ok(readdirSync(dir).filter((n) => n.endsWith('.md')).length === 1 && readdirSync(dir).every((n) => !n.includes('.part-')), 'one copy, and no temp file left');
  writeCopy(dir, 'bbbbbbbbbbbb', 'other');
  ok(readdirSync(dir).filter((n) => n.endsWith('.md')).length === 2, 'another note has its own copy');
  retireCopy(dir, 'aaaaaaaaaaaa');
  ok(!existsSync(join(dir, retitled)) && readdirSync(join(dir, '_deleted')).some((n) => n.includes('aaaaaaaaaaaa')), 'a removed note\'s copy moves to _deleted, it is not deleted');
  // the inside-the-root check is the caller's `ensure`: a refusing one stops the write and creates nothing
  let ensured: string[] = [];
  const refuse = (d: string): void => {
    ensured.push(d);
    throw new Error('outside the files folder');
  };
  let threw = false;
  try {
    writeCopy(join(tmp, 'outside', 'notes'), 'cccccccccccc', 'x', refuse);
  } catch {
    threw = true;
  }
  ok(threw && !existsSync(join(tmp, 'outside')) && ensured.length === 1, 'writeCopy asks the caller\'s check first and creates nothing when it refuses');
  ensured = [];
  writeCopy(dir, 'eeeeeeeeeeee', 'to retire');
  retireCopy(dir, 'eeeeeeeeeeee', (d) => ensured.push(d) && undefined);
  ok(ensured.some((d) => d.endsWith('_deleted')), 'retireCopy checks the _deleted folder too');
  retireCopy(dir, 'zzzzzzzzzzzz');
  ok(true, 'retiring a copy that does not exist is harmless');
  // editing the copy changes nothing the writer reads: the writer takes the text from its `read` dep, never from the file
  chmodSync(join(dir, 'other-bbbbbbbbbbbb.md'), 0o666);
  writeFileSync(join(dir, 'other-bbbbbbbbbbbb.md'), 'EDITED BY THE USER');

  /* the rationing, with a fake clock */
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const writes: Array<[string, string]> = [];
  const retired: string[] = [];
  const errs: string[] = [];
  let text = 'v0';
  let gone = false;
  const c = new NoteCopier({
    intervalMs: 30000,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    read: () => (gone ? undefined : { text }),
    dir: (roomId) => (roomId === 'nodir' ? null : join(tmp, roomId)),
    write: (d, id, t) => writes.push([id, t]),
    retire: (_d, id) => retired.push(id),
    onError: (m) => errs.push(m),
  });
  for (let i = 0; i < 200; i++) {
    text = `v${i}`;
    c.saved('r', 'n1');
  }
  ok(timers.length === 1 && timers[0].ms === 30000 && writes.length === 0 && c.pending() === 1, 'a burst of 200 saves schedules ONE write, 30 s out, and writes nothing yet');
  timers[0].fn();
  ok(writes.length === 1 && writes[0][1] === 'v199', 'the one write carries the LATEST text');
  ok(c.pending() === 0, '...and nothing is pending after it');
  c.saved('r', 'n1');
  ok(timers.length === 2 && writes.length === 1, 'the next save starts the next 30 s window');
  c.saved('r', 'n2');
  ok(timers.length === 3, 'another note has its own window');
  c.flush();
  ok(writes.length === 3 && c.pending() === 0 && timers.slice(1).every((t) => t.cleared), 'flush (the engine stopping) writes every pending copy and clears the timers');
  c.saved('r', 'n3');
  c.removed('r', 'n3');
  ok(timers[3].cleared && retired.includes('n3') && c.pending() === 0, 'removing a note cancels its pending write and retires its copy');
  c.saved('r', 'n4');
  gone = true;
  timers[4].fn();
  ok(writes.length === 3, 'a note that vanished before the write is simply skipped');
  gone = false;
  c.saved('nodir', 'n5');
  c.flush();
  ok(writes.length === 3, 'a room with no notes folder writes nothing');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
