/* IS THE VENDOR'S PROGRAM INSTALLED. A local seat is a plain shell with the vendor line TYPED into it, so a missing `claude` used to surface only as a bare shell prompt
 * (fb30s). This resolves the program the way a shell would, BEFORE the seat starts: PATH (absolute entries only; PATHEXT on Windows), then the usual install places for a
 * program installed since the app's environment was captured. PURE: platform, env and the file check are passed in. It answers "found" or "not found"; it cannot prove the
 * typed line will then run (the prompt detector stays the backstop). */
import { existsSync } from 'node:fs';

const PROGRAMS: Record<string, { program: string; name: string }> = {
  'claude-code': { program: 'claude', name: 'Claude Code' },
  'codex-cli': { program: 'codex', name: 'Codex' },
  'gemini-cli': { program: 'gemini', name: 'Gemini CLI' },
};
/** The program a vendor runs, or null for a shell and any vendor that runs nothing of its own. */
export function programFor(vendor: string | null | undefined): string | null {
  return (vendor && PROGRAMS[vendor]?.program) || null;
}
export function vendorDisplayName(vendor: string): string {
  return PROGRAMS[vendor]?.name ?? vendor;
}

export interface ResolveOpts {
  platform?: string;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
}

export function resolveProgram(program: string, o: ResolveOpts = {}): string | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const abs = (d: string): boolean => (win ? /^[A-Za-z]:[\\/]/.test(d) || d.startsWith('\\\\') : d.startsWith('/'));
  const join = (d: string, f: string): string => `${d.replace(/[\\/]+$/, '')}${sep}${f}`;
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && abs(d));
  const home = win ? env.USERPROFILE : env.HOME;
  const extra: string[] = [];
  if (home && abs(home)) {
    extra.push(join(home, '.local/bin'.split('/').join(sep)), join(home, '.claude/local'.split('/').join(sep)));
    if (!win) {
      extra.push(join(home, '.npm-global/bin'));
    }
  }
  if (win && env.APPDATA && abs(env.APPDATA)) {
    extra.push(join(env.APPDATA, 'npm'));
  }
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const d of [...dirs, ...extra]) {
    for (const e of exts) {
      const p = join(d, `${program}${e}`);
      if (exists(p)) {
        return p;
      }
    }
  }
  return null;
}
