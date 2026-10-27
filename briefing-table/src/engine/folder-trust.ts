/* FOLDER TRUST (E3): pre-answer Claude's "Is this a project you created or one you trust?" prompt for a folder a seat is about to launch in, by
 * writing projects["<exact folder>"].hasTrustDialogAccepted = true into the user's .claude.json. The prompt defaults to "No, exit", which ends
 * the pane, so a starter seat that hits it is stranded.
 *
 * NARROW: the write happens immediately before a launch, only when the key is not already true, touches nothing else (the merge is
 * hosted-trust.ts's, which preserves every other key and project and refuses an unparseable file), and is READ BACK before anyone says the
 * folder is trusted. Three outcomes, never two: trusted / could-not-write / could-not-verify. ACCEPTED LIMIT (design review [ref]): a running
 * Claude also rewrites this file, so a whole-file write can clobber its concurrent write; the read-back catches only OUR lost update. The
 * CLI-prompt detector (cli-prompt.ts) is the safety net behind this: a pane that still shows the trust prompt is reported, not hidden.
 * UNVERIFIED: the key's exact spelling on Windows (backslash or slash). Until a Windows capture settles it, both are written. */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, win32, posix } from 'node:path';
import { homedir } from 'node:os';
import { withTrusted } from './hosted-trust.ts';

export interface TrustIo {
  /** the file's text, or null when it does not exist; throws on any other failure */
  read(path: string): string | null;
  write(path: string, text: string): void;
}

export type TrustOutcome =
  | { state: 'trusted'; changed: boolean; path: string }
  | { state: 'could-not-write'; reason: string }
  | { state: 'could-not-verify'; reason: string };

export function claudeJsonPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const cfg = env.CLAUDE_CONFIG_DIR?.trim();
  return cfg ? join(cfg, '.claude.json') : join(home, '.claude.json');
}

/** The exact key(s) to write for a folder: the absolute path without a trailing separator. On Windows both spellings (see UNVERIFIED above). */
export function trustKeysFor(dir: string, platform: string = process.platform): string[] {
  const trim = (p: string): string => (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p) ? p.replace(/[\\/]+$/, '') : p);
  const d = trim(dir);
  if (platform === 'win32') {
    return [...new Set([d, d.replace(/\\/g, '/')])];
  }
  return [d];
}

export function trustFolder(dir: string, io: TrustIo, path: string, platform: string = process.platform): TrustOutcome {
  const abs = platform === 'win32' ? win32.isAbsolute(dir) : posix.isAbsolute(dir);
  if (!dir || !abs) {
    return { state: 'could-not-write', reason: 'the folder is not an absolute path' };
  }
  const keys = trustKeysFor(dir, platform);
  let current: string | null;
  try {
    current = io.read(path);
  } catch (e) {
    return { state: 'could-not-write', reason: `could not read ${path}: ${(e as Error).message}` };
  }
  const merged = withTrusted(current, keys);
  if (!merged.ok) {
    return { state: 'could-not-write', reason: `${path} is ${merged.reason}; left alone` };
  }
  if (merged.changed) {
    try {
      io.write(path, merged.text);
    } catch (e) {
      return { state: 'could-not-write', reason: `could not write ${path}: ${(e as Error).message}` };
    }
  }
  /* READ BACK: only a file we just read and see the key in counts as trusted */
  let after: string | null;
  try {
    after = io.read(path);
  } catch (e) {
    return { state: 'could-not-verify', reason: `could not read ${path} back: ${(e as Error).message}` };
  }
  const check = withTrusted(after, keys);
  if (!check.ok || check.changed) {
    return { state: 'could-not-verify', reason: `read back ${path} and the folder is not marked trusted (the write did not stick, or another program rewrote the file)` };
  }
  return { state: 'trusted', changed: merged.changed, path };
}

/** The real file system: an ATOMIC write (a temp file beside it, then rename) so a crash never leaves a half-written .claude.json. */
export const realTrustIo: TrustIo = {
  read(path) {
    if (!existsSync(path)) {
      return null;
    }
    return readFileSync(path, 'utf8');
  },
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.wb-tmp`;
    let mode = 0o600;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      /* new file */
    }
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, path);
  },
};
