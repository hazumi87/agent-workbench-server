/* ============================================================================
 * THE ATTACHMENT SCRATCHPAD'S BYTES [ticket]. Room composer attachments are
 * held here, per person per room, from the moment they are attached until the
 * message is SENT (then they move to the room's assets on agent-share) or the
 * person removes them, or the TTL sweep finds the draft abandoned.
 *
 * WHERE: on the server, under the engine's own data dir (beside mapping.db), in
 * one flat folder of files named by a random id. NEVER agent-share: the share
 * is open on the tailnet with no auth, and an unsent attachment is private to
 * the person who attached it. `HARBOR_WB_ROOM_SCRATCH_DIR` moves it (tests).
 *
 * The ROWS (who, which room, name, type, size) are the table's
 * (store.ts room_scratch, through the endpoint); this module only moves bytes
 * and sweeps. Nothing here ever logs a file's contents, and names only by id.
 * ========================================================================== */

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { table } from '../table/endpoint.ts';

/** Files per message (per draft). Past it the upload ANSWERS 413 with both numbers. */
export function maxCount(): number {
  const n = Number(process.env.HARBOR_WB_ROOM_ATTACH_MAX);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

/** A draft untouched this long is abandoned (default 7 days). */
export function ttlMs(): number {
  const n = Number(process.env.HARBOR_WB_ROOM_SCRATCH_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 7 * 24 * 60 * 60 * 1000;
}

export function dir(): string {
  return process.env.HARBOR_WB_ROOM_SCRATCH_DIR || join(dirname(table.path()), 'room-scratch');
}

const ID_RE = /^[a-f0-9]{32}$/;

/** A fresh, unguessable file id. */
export function newId(): string {
  return randomBytes(16).toString('hex');
}

function fileOf(id: string): string {
  if (!ID_RE.test(id)) {
    throw new Error('not a scratch id');
  }
  return join(realpathSync(dir()), id);
}

export function write(id: string, bytes: Buffer): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const fd = openSync(fileOf(id), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

/** The bytes, or null when the file is gone. */
export function read(id: string): Buffer | null {
  try {
    const fd = openSync(fileOf(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) return null;
      return readFileSync(fd);
    } finally { closeSync(fd); }
  } catch {
    return null;
  }
}

/** Authoritative strong revision: never inferred from a size or timestamp. */
export function etag(bytes: Buffer): string { return `"${createHash('sha256').update(bytes).digest('hex')}"`; }

/** The final ETag check, byte swap and row commit are synchronous: another
 * request cannot pass between them. Paths are private random ids, never names.
 * A failed row commit restores the old payload, without following planted links. */
export function replace(id: string, bytes: Buffer, expected: string, commit: () => void): boolean {
  const old = read(id);
  if (!old || etag(old) !== expected) return false;
  const target = fileOf(id), suffix = randomBytes(16).toString('hex');
  const next = `${target}.replace-${suffix}`, backup = `${target}.rollback-${suffix}`;
  let keepBackup = false;
  try {
    writeFileSync(next, bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(backup, old, { flag: 'wx', mode: 0o600 });
    renameSync(next, target);
    try { commit(); } catch (error) {
      try { renameSync(backup, target); } catch { keepBackup = true; throw new Error('scratch rollback unconfirmed'); }
      throw error;
    }
    return true;
  } finally {
    for (const file of [next, ...(keepBackup ? [] : [backup])]) try { unlinkSync(file); } catch { /* absent staged file */ }
  }
}

export function remove(id: string): void {
  try {
    unlinkSync(fileOf(id));
  } catch {
    /* already gone */
  }
}

/** A file on disk with no row is a crash between the write and the insert;
 *  it is swept once it is older than this (never one being written now). */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Remove every abandoned draft's files and rows, and any file on disk with no
 * row. Returns the counts. Never throws.
 */
export function sweep(now = Date.now()): { rows: number; orphans: number } {
  let rows = 0;
  let orphans = 0;
  try {
    for (const r of table.abandonedRoomScratch(now - ttlMs())) {
      table.deleteRoomScratch(r.id);
      remove(r.id);
      rows++;
    }
    let names: string[] = [];
    try {
      names = readdirSync(dir());
    } catch {
      names = []; // no folder yet: nothing was ever attached
    }
    if (names.length) {
      const held = table.roomScratchIds();
      for (const n of names) {
        if (!ID_RE.test(n) || held.has(n)) {
          continue;
        }
        try {
          if (now - statSync(join(dir(), n)).mtimeMs > ORPHAN_GRACE_MS) {
            unlinkSync(join(dir(), n));
            orphans++;
          }
        } catch {
          /* raced with a delete */
        }
      }
    }
  } catch {
    /* the table is unreadable right now: the next tick tries again */
  }
  return { rows, orphans };
}

let timer: NodeJS.Timeout | null = null;

/** Sweep now and hourly (the timer never holds the process open). */
export function startSweep(log: (line: string) => void): void {
  if (timer) {
    return;
  }
  const tick = (): void => {
    const out = sweep();
    if (out.rows || out.orphans) {
      log(`room attachments: swept ${out.rows} abandoned draft file(s), ${out.orphans} orphan file(s)`);
    }
  };
  tick();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
}
