/* THE HANDBOOK (bt `handbook(topic)`): product docs an agent can read about the product it works in. Read-only and bounded.
 *  - The topics are the FILES in docs/handbook/ (name `topic.md`, topic = [a-z][a-z0-9-]{0,40}); the list is read from the directory, and the topic an agent sends is only
 *    COMPARED to that list. It is never joined onto a path, so no argument can name a file outside the folder (nor a symlink: only regular files are listed).
 *  - No secrets live here by rule (they are docs shipped in the repo); no write path exists. A file is cut at MAX_BYTES with a note. */
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BYTES = 64 * 1024;
const TOPIC = /^[a-z][a-z0-9-]{0,40}$/;
const here = dirname(fileURLToPath(import.meta.url));

/** The deployer's OFF switch: HARBOR_WB_HANDBOOK=0 removes the tool from the bt tool list (a stale call answers handbook_disabled), for every profile. */
export const handbookOn = (): boolean => process.env.HARBOR_WB_HANDBOOK !== '0';

/** The folder, read per call (a test points HARBOR_WB_HANDBOOK_DIR at a scratch folder). THE FOLDER IS THE DEPLOYER'S: it ships inside the engine install tree (owned by the deployer, not writable by any agent account, R7), and HARBOR_WB_HANDBOOK_DIR is an engine env var only a deployer sets. Nothing here can write. */
export const handbookDir = (): string => process.env.HARBOR_WB_HANDBOOK_DIR || join(here, '..', '..', 'docs', 'handbook');

export interface Topic {
  topic: string;
  title: string;
}

/** Up to `max` bytes of a REGULAR file, opened without following a link (O_NOFOLLOW) and checked on the open descriptor, so a file swapped for a symlink between listing and reading is
 *  refused rather than followed. Reads at most `max` bytes. null = not a regular file / unreadable. */
function readHead(file: string, max: number): { buf: Buffer; size: number } | null {
  let fd = -1;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(max, st.size));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: buf.subarray(0, got), size: st.size };
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** The topics, sorted: regular files `topic.md` only. A missing folder is an empty handbook, never an error. */
export function topics(dir = handbookDir()): Topic[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Topic[] = [];
  for (const n of names.sort()) {
    const m = /^(.+)\.md$/.exec(n);
    if (!m || !TOPIC.test(m[1])) continue;
    const head = readHead(join(dir, n), 400);
    if (!head) continue; // a link, a directory or unreadable: not listed
    const h1 = /^#\s+(.+)$/m.exec(head.buf.toString('utf8'));
    out.push({ topic: m[1], title: (h1 ? h1[1] : m[1]).trim().slice(0, 80) });
  }
  return out;
}

/** One topic's text, or null when the argument is not one of the listed topics. The argument is compared, never used as a path. */
export function read(topic: unknown, dir = handbookDir()): { topic: string; text: string; truncated?: true } | null {
  if (typeof topic !== 'string' || !TOPIC.test(topic)) return null;
  const hit = topics(dir).find((t) => t.topic === topic);
  if (!hit) return null;
  const got = readHead(join(dir, `${hit.topic}.md`), MAX_BYTES);
  if (!got) return null;
  if (got.size > MAX_BYTES) return { topic: hit.topic, text: `${got.buf.toString('utf8')}\n\n[cut: the rest of this topic is not shown]`, truncated: true };
  return { topic: hit.topic, text: got.buf.toString('utf8') };
}
