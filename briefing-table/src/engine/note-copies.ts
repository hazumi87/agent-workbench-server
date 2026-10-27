/* NOTE COPIES [lead ruling 15686, option A]: in local mode a room's notes are rows in the engine's database (the truth: search, revisions,
 * sent-copies), and each is ALSO written as a read-only `.md` file into the person's folder, `rooms/<name>-<id8>/notes/`, so notes are
 * visible and backed up there. The copy never flows back: nothing reads it.
 *
 * The folder may sync through OneDrive, so writes are rationed: a note's copy is written AT MOST ONCE PER INTERVAL (30 s) no matter how
 * many saves arrive (the first save starts a timer; the write at the end of it reads the LATEST text), never per keystroke, and every
 * pending copy is written when the engine stops. Each copy starts with a line saying it is a read-only copy and where to edit, and
 * carries the read-only attribute, so an editor warns before saving.
 *
 * File name: `<title-slug>-<noteId>.md`, found again by its id suffix, so a retitled note REPLACES its own copy instead of leaving a
 * second one. A removed note's copy is moved to `notes/_deleted/`, never deleted. */
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COPY_INTERVAL_MS = 30_000;
export const COPY_HEADER = '> Read-only copy. Edit this note in Agent Workbench; changes made to this file are not saved back.';

/** The note's title: its first non-empty line without markdown marks, at most 60 characters. */
export function noteTitle(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.replace(/^[\s>#*\-+\d.)]+/, '').replace(/[*_`]+/g, '').trim();
    if (t) {
      return t.length > 60 ? `${t.slice(0, 57).trimEnd()}...` : t;
    }
  }
  return 'Untitled note';
}

export function titleSlug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'note';
}

export const copyFileName = (id: string, text: string): string => `${titleSlug(noteTitle(text))}-${id}.md`;
export const copyBody = (text: string): string => `${COPY_HEADER}\n\n${text}${text.endsWith('\n') ? '' : '\n'}`;

function copiesOf(dir: string, id: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(`-${id}.md`));
  } catch {
    return [];
  }
}

function unlockThenRemove(p: string): void {
  try {
    chmodSync(p, 0o666); // Windows: a read-only file cannot be replaced or removed until the attribute is cleared
  } catch {
    /* already gone */
  }
  rmSync(p, { force: true });
}

/** Write (or replace) the note's copy in `dir`. Whole file or nothing; read-only; a retitled note's old copy is removed. */
export function writeCopy(dir: string, id: string, text: string, ensure: (dir: string) => void = (d) => mkdirSync(d, { recursive: true })): string {
  ensure(dir);
  const name = copyFileName(id, text);
  const target = join(dir, name);
  const tmp = join(dir, `.${name}.part-${process.pid}`);
  writeFileSync(tmp, copyBody(text), { flag: 'w', mode: 0o444 });
  if (existsSync(target)) {
    try {
      chmodSync(target, 0o666);
    } catch {
      /* fall through; the rename reports a real problem */
    }
  }
  renameSync(tmp, target);
  try {
    chmodSync(target, 0o444);
  } catch {
    /* the attribute is a courtesy; the header line still says read-only */
  }
  for (const old of copiesOf(dir, id)) {
    if (old !== name) {
      unlockThenRemove(join(dir, old)); // our own earlier copy under the previous title
    }
  }
  return name;
}

/** A removed note's copy goes to `<dir>/_deleted/`, never deleted. */
export function retireCopy(dir: string, id: string, ensure: (dir: string) => void = (d) => mkdirSync(d, { recursive: true })): void {
  const olds = copiesOf(dir, id);
  if (olds.length === 0) {
    return;
  }
  const gone = join(dir, '_deleted');
  ensure(gone);
  for (const old of olds) {
    let to = join(gone, old);
    for (let i = 1; existsSync(to); i++) {
      to = join(gone, `${old.replace(/\.md$/, '')}-${i}.md`);
    }
    renameSync(join(dir, old), to);
  }
}

export interface CopierDeps {
  intervalMs: number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  /** The note's CURRENT text, or undefined when it is gone. */
  read: (roomId: string, id: string) => { text: string } | undefined;
  /** The notes folder on disk for a room, or null when there is no files folder. */
  dir: (roomId: string) => string | null;
  write: (dir: string, id: string, text: string) => unknown;
  retire: (dir: string, id: string) => unknown;
  onError: (msg: string) => void;
}

/** Rations the copies. `saved` after every save, `removed` when a note is deleted, `flush` when the engine stops. */
export class NoteCopier {
  private timers = new Map<string, { roomId: string; handle: unknown }>();
  private readonly d: CopierDeps; // plain field + assignment: erasable TypeScript only (Node's own type stripping loads this file)
  constructor(d: CopierDeps) {
    this.d = d;
  }

  saved(roomId: string, id: string): void {
    if (this.timers.has(id)) {
      return; // a write is already scheduled; it will read the latest text
    }
    const handle = this.d.setTimer(() => this.fire(id), this.d.intervalMs);
    this.timers.set(id, { roomId, handle });
  }

  removed(roomId: string, id: string): void {
    const t = this.timers.get(id);
    if (t) {
      this.d.clearTimer(t.handle);
      this.timers.delete(id);
    }
    const dir = this.d.dir(roomId);
    if (dir) {
      try {
        this.d.retire(dir, id);
      } catch (e) {
        this.d.onError(`note copy ${id}: could not retire (${(e as Error).message})`);
      }
    }
  }

  /** Write every pending copy now (the engine is stopping). */
  flush(): void {
    for (const [id, t] of [...this.timers]) {
      this.d.clearTimer(t.handle);
      this.timers.delete(id);
      this.write(t.roomId, id);
    }
  }

  pending(): number {
    return this.timers.size;
  }

  private fire(id: string): void {
    const t = this.timers.get(id);
    this.timers.delete(id);
    if (t) {
      this.write(t.roomId, id);
    }
  }

  private write(roomId: string, id: string): void {
    const dir = this.d.dir(roomId);
    const note = this.d.read(roomId, id);
    if (!dir || !note) {
      return;
    }
    try {
      this.d.write(dir, id, note.text);
    } catch (e) {
      this.d.onError(`note copy ${id}: could not write (${(e as Error).message})`);
    }
  }
}
