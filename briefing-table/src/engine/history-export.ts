/* CHAT-HISTORY EXPORT [lead order 15713, master spec Section 1 / Part A5]: the engine's half of the backup. Local chat lives in the
 * engine's database (app data); this writes each FINISHED day of a room as one file into the person's own folder,
 * `rooms/<name>-<id8>/history/YYYY-MM-DD.jsonl`, so a lost PC loses at most the unfinished day and OneDrive only ever sees new whole files.
 *
 * RULES (all from the spec): a day is the PC's LOCAL day and the file header states its UTC offset; only FINISHED days are written
 * automatically (today is never touched); a marker per room says the last day dealt with; a catch-up writes every finished day since the
 * marker that has chat lines (off for a week = seven files on the next start); an existing file is NEVER rewritten; the first run works
 * through all earlier history one day at a time, yielding between days so the engine stays responsive; "Export now" saves today so far
 * under its own name, `YYYY-MM-DD-now-HHMMSS.jsonl`, which a later automatic export does not collide with.
 *
 * FORMAT: JSON Lines. Line 1 is a header object {schema, kind, room, day, utcOffset, ...}; every other line is one entry
 * {id, ts, kind, author, target, thread, body, ref, meta}. Plain text, one entry per line, re-importable by a later "Copy to server".
 * Hidden bookkeeping lines (meta.hidden) and delivery receipts are not history and are left out.
 *
 * Pure core + a runner with injected dependencies (clock, table reads, file writes, marker storage), so it is testable without an engine. */

export const HISTORY_SCHEMA = 1;
export const SKIP_KINDS = new Set(['delivery']);

export interface LineRow {
  id: number;
  ts: number;
  kind: string;
  author: string;
  target: string | null;
  thread: string | null;
  body: string | null;
  ref: string | null;
  meta: string | null;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** The PC's local calendar day of a timestamp, as YYYY-MM-DD. */
export function dayOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** [start, end) in ms of a local day (handles 23- and 25-hour days: the end is the next day's local midnight). */
export function dayBounds(day: string): [number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d + 1, 12).getTime());
}

/** The UTC offset in force at noon of a local day, as +HH:MM / -HH:MM. */
export function utcOffsetOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const off = -new Date(y, m - 1, d, 12).getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** The finished days to deal with: every day after the marker (or from the day of the first line when there is none) up to and
 *  including yesterday. Today is never in it. */
export function finishedDays(marker: string | null, firstTs: number | null, now: number): string[] {
  if (firstTs === null) {
    return [];
  }
  const today = dayOf(now);
  let day = marker ? nextDay(marker) : dayOf(firstTs);
  const out: string[] = [];
  for (let guard = 0; day < today && guard < 20000; guard++) {
    out.push(day);
    day = nextDay(day);
  }
  return out;
}

function entryOf(l: LineRow): Record<string, unknown> {
  let meta: unknown = null;
  if (l.meta) {
    try {
      meta = JSON.parse(l.meta);
    } catch {
      meta = l.meta;
    }
  }
  return { id: l.id, ts: l.ts, kind: l.kind, author: l.author, target: l.target, thread: l.thread, body: l.body, ref: l.ref, meta };
}

export function isHistory(l: LineRow): boolean {
  if (SKIP_KINDS.has(l.kind)) {
    return false;
  }
  if (l.meta) {
    try {
      return (JSON.parse(l.meta) as { hidden?: unknown })?.hidden !== true;
    } catch {
      return true;
    }
  }
  return true;
}

export function renderDay(room: { id: string; name: string }, day: string, lines: LineRow[], exportedAt: number, partial = false): string {
  const header = {
    schema: HISTORY_SCHEMA,
    kind: 'workbench-room-history',
    room: { id: room.id, name: room.name },
    day,
    utcOffset: utcOffsetOf(day),
    ...(partial ? { partial: true } : {}),
    exportedAt: new Date(exportedAt).toISOString(),
    lines: lines.length,
  };
  return `${[header, ...lines.map(entryOf)].map((o) => JSON.stringify(o)).join('\n')}\n`;
}

export const fileNameOf = (day: string): string => `${day}.jsonl`;
export function nowFileNameOf(ts: number): string {
  const d = new Date(ts);
  return `${dayOf(ts)}-now-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jsonl`;
}

export interface ExportRoom {
  id: string;
  name: string;
}

export interface ExportDeps {
  now: () => number;
  rooms: () => ExportRoom[];
  firstTs: (roomId: string) => number | null;
  lines: (roomId: string, fromTs: number, toTs: number) => LineRow[];
  /** Write a new file; 'exists' when one is already there (never rewritten). Throws on a real failure. */
  write: (roomId: string, name: string, content: string) => 'written' | 'exists';
  getMarker: (roomId: string) => string | null;
  setMarker: (roomId: string, day: string) => void;
  enabled: () => boolean;
  /** Let the engine breathe between days (setImmediate in production). */
  yieldNow: () => Promise<void>;
  onError: (msg: string) => void;
}

export interface ExportStatus {
  enabled: boolean;
  running: boolean;
  done: number;
  total: number;
  written: number;
  lastRunAt: number | null;
  lastError: string | null;
  cancelled: boolean;
}

/** Runs the catch-up and Export now. One run at a time. */
export class HistoryExporter {
  private s: ExportStatus = { enabled: true, running: false, done: 0, total: 0, written: 0, lastRunAt: null, lastError: null, cancelled: false };
  private readonly d: ExportDeps; // plain field + assignment: erasable TypeScript only
  constructor(d: ExportDeps) {
    this.d = d;
  }

  status(): ExportStatus {
    return { ...this.s, enabled: this.d.enabled() };
  }

  cancel(): void {
    if (this.s.running) {
      this.s.cancelled = true;
    }
  }

  /** The automatic export: every finished day since each room's marker. Safe to call as often as wanted. */
  async catchUp(): Promise<ExportStatus> {
    if (this.s.running || !this.d.enabled()) {
      return this.status();
    }
    this.s = { ...this.s, running: true, done: 0, total: 0, written: 0, lastError: null, cancelled: false };
    try {
      const now = this.d.now();
      const plan: Array<{ room: ExportRoom; days: string[] }> = [];
      for (const room of this.d.rooms()) {
        const days = finishedDays(this.d.getMarker(room.id), this.d.firstTs(room.id), now);
        if (days.length) {
          plan.push({ room, days });
        }
      }
      this.s.total = plan.reduce((n, p) => n + p.days.length, 0);
      for (const { room, days } of plan) {
        for (const day of days) {
          if (this.s.cancelled || !this.d.enabled()) {
            break; // cancelled, or the person switched the toggle off while it ran: stop after the day just finished
          }
          try {
            const [from, to] = dayBounds(day);
            const lines = this.d.lines(room.id, from, to).filter(isHistory);
            if (lines.length > 0) {
              const r = this.d.write(room.id, fileNameOf(day), renderDay(room, day, lines, now));
              if (r === 'written') {
                this.s.written++;
              }
            }
            this.d.setMarker(room.id, day); // only after the file exists (or the day was empty): a failure retries this day next time
          } catch (e) {
            this.s.lastError = `${room.name} ${day}: ${(e as Error).message}`;
            this.d.onError(`history export: ${this.s.lastError}`);
            break; // this room stops at the failed day; the others go on
          }
          this.s.done++;
          await this.d.yieldNow();
        }
      }
    } finally {
      this.s.running = false;
      this.s.lastRunAt = this.d.now();
    }
    return this.status();
  }

  /** "Export now": today's chat so far (or one room's), under a name the automatic export never uses. Answers the files written. */
  exportNow(roomId?: string): Array<{ roomId: string; name: string; lines: number }> {
    const now = this.d.now();
    const day = dayOf(now);
    const [from] = dayBounds(day);
    const out: Array<{ roomId: string; name: string; lines: number }> = [];
    for (const room of this.d.rooms()) {
      if (roomId && room.id !== roomId) {
        continue;
      }
      const lines = this.d.lines(room.id, from, now + 1).filter(isHistory);
      if (lines.length === 0) {
        continue;
      }
      /* two Export-now presses in the same second must not report a file that was not saved: take the next free name */
      const content = renderDay(room, day, lines, now, true);
      const base = nowFileNameOf(now).replace(/\.jsonl$/, '');
      let saved: string | null = null;
      for (let i = 0; i < 100 && saved === null; i++) {
        const name = i === 0 ? `${base}.jsonl` : `${base}-${i}.jsonl`;
        if (this.d.write(room.id, name, content) === 'written') {
          saved = name;
        }
      }
      if (saved === null) {
        throw new Error('could not find a free file name for Export now');
      }
      out.push({ roomId: room.id, name: saved, lines: lines.length });
    }
    return out;
  }
}
