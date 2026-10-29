/*
 * Run-state rules shared by the app (app/server.mjs) and the scripts
 * (scripts/lib/tool.mjs), so the two can never disagree about which processes
 * are this app, how the last run ended, or what the status line says.
 * Zero dependencies (node >= 20). Linux: instances are found through /proc.
 */
import fs from 'node:fs';
import path from 'node:path';

/* Write-then-rename so a reader (the engine polls widget.json) never sees half a file. */
export function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj) + '\n');
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every live node process running `appMain`, except `exceptPid`. Null when the
 * process table cannot be read (then nobody can tell). This is the ONE "is it
 * ours" rule: the pid file only records which instance start.sh launched.
 * - Only node processes count: an editor or `cat` with the file open is not an instance.
 * - A relative script path is resolved against that process's cwd, and symlinks
 *   are resolved, so a hand-launched `node app/server.mjs` is found too.
 */
export function instancesOf(appMain, exceptPid = null) {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  const base = path.basename(appMain);
  const pids = [];
  for (const d of entries) {
    if (!/^\d+$/.test(d) || Number(d) === exceptPid) {
      continue;
    }
    let argv;
    try {
      argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0'); // empty for a zombie: not running
    } catch {
      continue;
    }
    if (!/^node(js)?$/.test(path.basename(argv[0] || ''))) {
      continue;
    }
    const hit = argv.slice(1).some((a) => {
      if (path.basename(a) !== base) {
        return false;
      }
      try {
        const abs = path.isAbsolute(a) ? a : path.resolve(fs.readlinkSync(`/proc/${d}/cwd`), a);
        return abs === appMain || fs.realpathSync(abs) === appMain;
      } catch {
        return false;
      }
    });
    if (hit) {
      pids.push(Number(d));
    }
  }
  return pids;
}

/* How the last run ended — the taxonomy's `exit` verb: deliberate (clean) or a fault.
   Written by the app on a clean exit, and by start.sh/stop.sh (clear-stale) when a
   run left its files behind. */
export function recordExit(file, kind, pid, why) {
  writeJson(file, { kind, pid, why, at: new Date().toISOString() });
}

/** The status line for a pulse result — the ONE copy of the text. */
export function widgetLine(s) {
  if (s.state === 'up') {
    return s.configured === false
      ? { kind: 'warn', text: `app up · port ${s.port} · ${s.reason || 'engine offline'}` }
      : { kind: 'ok', text: `app up · port ${s.port} · engine ready` };
  }
  if (s.state === 'down') {
    return s.lastExit === 'fault'
      ? { kind: 'warn', text: `app down · last exit was not clean (pid ${s.pid ?? '?'})` }
      : { kind: 'cold', text: 'app stopped' };
  }
  return { kind: 'warn', text: `app: could not tell — ${s.reason}` };
}

/* The WidgetStatus file the briefing-table engine renders verbatim
   (src/engine/widget-status.ts): {kind: ok|warn|cold, text <= 120, ts (epoch s), expiresAt}.
   expiresAt stays null: the manager renders any value as a countdown. */
export function writeWidget(file, s) {
  const { kind, text } = widgetLine(s);
  writeJson(file, { kind, text: text.slice(0, 120), ts: Math.floor(Date.now() / 1000), expiresAt: null });
}
