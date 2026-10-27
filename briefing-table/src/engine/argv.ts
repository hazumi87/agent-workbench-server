/* DIRECT SPAWN (security review M8, hosted pilot): the CLI is started as binary + argv by the broker, never typed into a shell and never followed by one. Vendors still build a command LINE;
 * this turns that line into argv and refuses anything a shell would have interpreted, so the line cannot smuggle a second command (L6). No expansion of any kind happens here. */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Split a command line into argv: bare words, 'single' and "double" quotes (no escapes, no expansion). null = the line needs a shell (metacharacter, expansion, unbalanced quote). */
export function splitCommandLine(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: "'" | '"' | null = null;
  for (const ch of line) {
    if (q) {
      if (ch === q) q = null;
      else if (q === '"' && (ch === '$' || ch === '`' || ch === '\\')) return null;
      else if (ch === '\n' || ch === '\0') return null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else if (/[;&|<>()`$\\\n\0*?[\]{}~#!]/.test(ch)) {
      return null;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (q) return null;
  if (has) out.push(cur);
  return out.length ? out : null;
}

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The absolute path of a command, resolved NOW (the PATH reason the ssh path needed `-lic`): an absolute name must exist; a bare name is searched on PATH, then the usual per-user install dirs. null = not found. */
export function resolveBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(name)) return isExecutable(name) ? name : null;
  if (name.includes('/')) return null;
  const home = env.HOME || homedir();
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.npm-global', 'bin'), join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin'];
  for (const d of dirs) {
    const p = join(d, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

export class DirectSpawnError extends Error {
  code: 'needs-shell' | 'not-found' | 'no-cli' | 'ssh-refused' | 'no-folder';
  constructor(code: 'needs-shell' | 'not-found' | 'no-cli' | 'ssh-refused' | 'no-folder', message: string) {
    super(message);
    this.code = code;
  }
}

/** A command line -> {binary (absolute), args}, or a DirectSpawnError saying why not. */
export function directArgv(line: string, env: NodeJS.ProcessEnv = process.env): { binary: string; args: string[] } {
  const argv = splitCommandLine(line);
  if (!argv) throw new DirectSpawnError('needs-shell', 'this launch line needs a shell, and the hosted engine does not start one');
  const binary = resolveBinary(argv[0], env);
  if (!binary) throw new DirectSpawnError('not-found', `${argv[0]} is not installed on this server`);
  return { binary, args: argv.slice(1) };
}

/** L6: a recipe-supplied MODEL as it may appear on a command line typed into any shell: only plain characters survive (dropped, not quoted, so no quoting dialect can be fooled). */
export function plainArg(s: string): string {
  return s.replace(/[^A-Za-z0-9_.:@/+=,\-[\]]/g, '');
}

/** L6: a resume NAME the caller wraps in double quotes: everything either shell expands or ends a double-quoted string inside (dollar, backtick, backslash, quotes, !, control characters) is dropped; letters of any language and spaces stay. */
export function quotedName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[$`\\"'!\u0000-\u001f\u007f]/g, '').trim();
}
