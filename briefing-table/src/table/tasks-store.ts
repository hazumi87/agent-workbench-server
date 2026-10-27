/* TASKS, the rows (KB design-notes-id). Additive tables, created lazily like the room tables; every function takes the db so it runs inside
 * whatever transaction the caller holds (the route opens ONE per verb) and a test can hand it a scratch db. The rules (percentages, who may do
 * what, bounds) are tasks-rules.ts; the store trusts a validated input and enforces the invariants that need the rows: the stretch bookkeeping,
 * the family boundary, parent/child.
 *
 * FAMILY: `family_id` is the ROOT room's id (design review [ref]). `room_id` is the GROUP the task lives in (the main room or a workgroup). */
import type Database from 'better-sqlite3';
import {
  groupPct, roomPct, pastKeeping, validStatus, OPEN_MAX, TOPICS_MAX, TIMELINE_STRETCH_MAX, TIMELINE_SEGMENT_MAX, TIMELINE_NEEDS_MAX, TIMELINE_MARKS_MAX,
  TIMELINE_QUERY_STRETCHES, TIMELINE_QUERY_NEEDS, TIMELINE_QUERY_MARKS, type TaskStatus,
} from '../engine/tasks-rules.ts';

export interface TaskRow {
  id: number;
  family_id: string;
  room_id: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number;
  pct: number;
  claimed_seat: string | null;
  assigned_from_room: string | null;
  parent_id: number | null;
  topic_id: number | null;
  pinned: number;
  bug: number;
  flagged: number;
  created_at: number;
  updated_at: number;
  /** when the status last CHANGED (creation counts): the rail's activity line follows this, not updated_at, which a flag or a pin also moves. */
  status_at: number;
  done_at: number | null;
  /** 1 once a done task past its keeping time was trimmed to its title and dates (body, notes and stretches are gone). */
  trimmed: number;
}

export class TaskError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
  }
}

export function ensureTaskTables(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS task_groups (
      room_id   TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      linked    INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      family_id          TEXT NOT NULL,
      room_id            TEXT NOT NULL,
      title              TEXT NOT NULL,
      body               TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in-progress','blocked','done')),
      priority           INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 5),
      pct                INTEGER NOT NULL DEFAULT 0 CHECK(pct BETWEEN 0 AND 100),
      claimed_seat       TEXT,
      assigned_from_room TEXT,
      parent_id          INTEGER,
      topic_id           INTEGER,
      pinned             INTEGER NOT NULL DEFAULT 0,
      bug                INTEGER NOT NULL DEFAULT 0,
      flagged            INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      status_at          INTEGER NOT NULL DEFAULT 0,
      done_at            INTEGER,
      trimmed            INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_family ON tasks(family_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id, status);
    CREATE TABLE IF NOT EXISTS task_notes (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      at      INTEGER NOT NULL,
      pct     INTEGER,
      text    TEXT NOT NULL,
      by_seat TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id, at);
    CREATE TABLE IF NOT EXISTS task_stretches (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id  INTEGER NOT NULL,
      seat_id  TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_task_stretches_task ON task_stretches(task_id, end_at);
    CREATE TABLE IF NOT EXISTS task_needs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id  INTEGER NOT NULL,
      start_at INTEGER NOT NULL,
      end_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_task_needs_task ON task_needs(task_id, end_at);
    CREATE TABLE IF NOT EXISTS task_time (
      task_id  INTEGER NOT NULL,
      seat_id  TEXT NOT NULL,
      total_ms INTEGER NOT NULL,
      last_end INTEGER NOT NULL,
      PRIMARY KEY (task_id, seat_id)
    );
    CREATE TABLE IF NOT EXISTS task_topics (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      name    TEXT NOT NULL,
      ord     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS task_focus (
      room_id  TEXT PRIMARY KEY,
      topic_id INTEGER
    );
  `);
  /* additive: a tasks table made before status_at existed */
  const cols = new Set((d.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('status_at')) {
    d.exec(`ALTER TABLE tasks ADD COLUMN status_at INTEGER NOT NULL DEFAULT 0`);
    d.exec(`UPDATE tasks SET status_at=updated_at`);
  }
}

const rowOf = (d: Database.Database, id: number): TaskRow | undefined => d.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as TaskRow | undefined;

/** The task, inside this family, or a 404 that reads the same for "no such task" and "a task of another family" (a token can not probe). */
export function requireTask(d: Database.Database, familyId: string, id: number): TaskRow {
  const t = Number.isInteger(id) ? rowOf(d, id) : undefined;
  if (!t || t.family_id !== familyId) {
    throw new TaskError(404, 'no such task here', 'tid');
  }
  return t;
}

/** The group row, created on first use (linked by default). */
export function ensureGroup(d: Database.Database, familyId: string, roomId: string): { linked: boolean } {
  d.prepare(`INSERT OR IGNORE INTO task_groups (room_id, family_id, linked) VALUES (?, ?, 1)`).run(roomId, familyId);
  const g = d.prepare(`SELECT linked FROM task_groups WHERE room_id=?`).get(roomId) as { linked: number };
  return { linked: g.linked === 1 };
}

export function addTask(
  d: Database.Database,
  i: { familyId: string; roomId: string; title: string; body?: string; priority?: number; parentId?: number | null },
  now = Date.now(),
): TaskRow {
  ensureGroup(d, i.familyId, i.roomId);
  const open = (d.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE family_id=? AND status<>'done'`).get(i.familyId) as { n: number }).n;
  if (open >= OPEN_MAX) {
    throw new TaskError(409, `this room family already has ${OPEN_MAX} open tasks; finish or remove some before adding more`, 'tasks');
  }
  if (i.parentId !== undefined && i.parentId !== null) {
    const parent = requireTask(d, i.familyId, i.parentId);
    if (parent.parent_id !== null) {
      throw new TaskError(409, 'subtasks nest one level only', 'parent');
    }
  }
  const info = d
    .prepare(`INSERT INTO tasks (family_id, room_id, title, body, priority, parent_id, created_at, updated_at, status_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(i.familyId, i.roomId, i.title, i.body ?? '', i.priority ?? 0, i.parentId ?? null, now, now, now);
  return rowOf(d, Number(info.lastInsertRowid))!;
}

/* ------------------------------------------------------------- stretches ---- */

function openStretch(d: Database.Database, taskId: number): { id: number; seat_id: string } | undefined {
  return d.prepare(`SELECT id, seat_id FROM task_stretches WHERE task_id=? AND end_at IS NULL`).get(taskId) as { id: number; seat_id: string } | undefined;
}
function closeStretch(d: Database.Database, taskId: number, now: number): void {
  d.prepare(`UPDATE task_stretches SET end_at=? WHERE task_id=? AND end_at IS NULL`).run(now, taskId);
}
/** Bring the task's open stretch in line with its row: ONE open stretch exactly when it is in-progress with a claimer, for that claimer.
 *  Called after every change of status or claimer, so the rule lives in one place (agreed for v1: from status changes, not seat activity). */
function syncStretch(d: Database.Database, t: TaskRow, now: number): void {
  const open = openStretch(d, t.id);
  const wants = t.status === 'in-progress' && t.claimed_seat ? t.claimed_seat : null;
  if (open && open.seat_id === wants) {
    return;
  }
  if (open) {
    closeStretch(d, t.id, now);
  }
  if (wants) {
    d.prepare(`INSERT INTO task_stretches (task_id, seat_id, start_at) VALUES (?, ?, ?)`).run(t.id, wants, now);
  }
}

/** A task NEEDS the person while it is FLAGGED (and not done). A task that is only blocked does not: it may be waiting on another group. ONE open needs stretch exactly then; called after every flag or status
 *  change, so the timeline's "needs you" bands come from the same rule as the summary's count. */
function syncNeeds(d: Database.Database, t: TaskRow, now: number): void {
  const wants = t.status !== 'done' && t.flagged === 1;
  const open = d.prepare(`SELECT id FROM task_needs WHERE task_id=? AND end_at IS NULL`).get(t.id) as { id: number } | undefined;
  if (wants && !open) {
    d.prepare(`INSERT INTO task_needs (task_id, start_at) VALUES (?, ?)`).run(t.id, now);
  } else if (!wants && open) {
    d.prepare(`UPDATE task_needs SET end_at=? WHERE id=?`).run(now, open.id);
  }
}

function touch(d: Database.Database, id: number, now: number, set: string, ...args: unknown[]): TaskRow {
  d.prepare(`UPDATE tasks SET ${set}, updated_at=? WHERE id=?`).run(...args, now, id);
  return rowOf(d, id)!;
}

export function claim(d: Database.Database, familyId: string, id: number, seatId: string, now = Date.now()): TaskRow {
  const t = requireTask(d, familyId, id);
  if (t.status === 'done') {
    throw new TaskError(409, 'that task is done', 'status');
  }
  if (t.claimed_seat && t.claimed_seat !== seatId) {
    throw new TaskError(409, 'another seat has claimed that task', 'claimed_seat');
  }
  const u = touch(d, id, now, 'claimed_seat=?', seatId);
  syncStretch(d, u, now);
  return u;
}
export function unclaim(d: Database.Database, familyId: string, id: number, now = Date.now()): TaskRow {
  const t = requireTask(d, familyId, id);
  const u = touch(d, t.id, now, 'claimed_seat=NULL');
  syncStretch(d, u, now);
  return u;
}

export function setStatus(d: Database.Database, familyId: string, id: number, status: string, now = Date.now()): TaskRow {
  const t = requireTask(d, familyId, id);
  if (!validStatus(status)) {
    throw new TaskError(400, 'status is open, in-progress, blocked or done', 'status');
  }
  let u: TaskRow;
  if (status === 'done') {
    u = touch(d, t.id, now, 'status=?, status_at=?, done_at=?, pct=100', status, now, now);
  } else if (t.status === 'done') {
    /* REOPENED: done had set 100, which was never a lead's word. Back to the latest lead note's %, or 0 (builder-two [ref] ruling 7). */
    const last = d.prepare(`SELECT pct FROM task_notes WHERE task_id=? AND pct IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1`).get(t.id) as { pct: number } | undefined;
    u = touch(d, t.id, now, 'status=?, status_at=?, done_at=NULL, pct=?', status, now, last?.pct ?? 0);
  } else {
    u = touch(d, t.id, now, 'status=?, status_at=?, done_at=NULL', status, now);
  }
  syncStretch(d, u, now);
  syncNeeds(d, u, now);
  return u;
}

/** A seat left the room (or was removed): its open stretches close at that moment and the tasks it had claimed are unclaimed, still open for
 *  someone else. Returns how many tasks it released. Idempotent. Run inside the seat-removal transaction. */
export function releaseSeatTasks(d: Database.Database, seatId: string, now = Date.now()): number {
  const mine = d.prepare(`SELECT * FROM tasks WHERE claimed_seat=?`).all(seatId) as TaskRow[];
  for (const t of mine) {
    const u = touch(d, t.id, now, 'claimed_seat=NULL');
    syncStretch(d, u, now);
  }
  d.prepare(`UPDATE task_stretches SET end_at=? WHERE seat_id=? AND end_at IS NULL`).run(now, seatId);
  return mine.length;
}

export function setFlag(d: Database.Database, familyId: string, id: number, on: boolean, now = Date.now()): TaskRow {
  const u = touch(d, requireTask(d, familyId, id).id, now, 'flagged=?', on ? 1 : 0);
  syncNeeds(d, u, now);
  return u;
}
export function setPinned(d: Database.Database, familyId: string, id: number, on: boolean, now = Date.now()): TaskRow {
  return touch(d, requireTask(d, familyId, id).id, now, 'pinned=?', on ? 1 : 0);
}
export function setBug(d: Database.Database, familyId: string, id: number, on: boolean, now = Date.now()): TaskRow {
  return touch(d, requireTask(d, familyId, id).id, now, 'bug=?', on ? 1 : 0);
}
export function setPriority(d: Database.Database, familyId: string, id: number, priority: number, now = Date.now()): TaskRow {
  return touch(d, requireTask(d, familyId, id).id, now, 'priority=?', priority);
}

/** The lead sets a % and says why in one line; the note is what the timeline marks. */
export function progress(d: Database.Database, familyId: string, id: number, pct: number, note: string, bySeat: string | null, now = Date.now()): TaskRow {
  const t = requireTask(d, familyId, id);
  const u = touch(d, t.id, now, 'pct=?', pct);
  d.prepare(`INSERT INTO task_notes (task_id, at, pct, text, by_seat) VALUES (?, ?, ?, ?, ?)`).run(t.id, now, pct, note, bySeat);
  return u;
}

/** Move a task to another group of the SAME family; it is shown as "from <group>". */
export function assignToGroup(d: Database.Database, familyId: string, id: number, toRoomId: string, now = Date.now()): TaskRow {
  const t = requireTask(d, familyId, id);
  if (t.room_id === toRoomId) {
    return t;
  }
  ensureGroup(d, familyId, toRoomId);
  const u = touch(d, t.id, now, 'room_id=?, assigned_from_room=?, claimed_seat=NULL', toRoomId, t.room_id);
  syncStretch(d, u, now);
  return u;
}

export function setGroupLinked(d: Database.Database, familyId: string, roomId: string, linked: boolean): void {
  ensureGroup(d, familyId, roomId);
  d.prepare(`UPDATE task_groups SET linked=? WHERE room_id=?`).run(linked ? 1 : 0, roomId);
}

export function purge(d: Database.Database, familyId: string, id: number): void {
  const t = requireTask(d, familyId, id);
  const ids = [t.id, ...(d.prepare(`SELECT id FROM tasks WHERE parent_id=?`).all(t.id) as { id: number }[]).map((r) => r.id)];
  for (const x of ids) {
    d.prepare(`DELETE FROM task_stretches WHERE task_id=?`).run(x);
    d.prepare(`DELETE FROM task_notes WHERE task_id=?`).run(x);
    d.prepare(`DELETE FROM task_needs WHERE task_id=?`).run(x);
    d.prepare(`DELETE FROM task_time WHERE task_id=?`).run(x);
    d.prepare(`DELETE FROM tasks WHERE id=?`).run(x);
  }
}

/* ----------------------------------------------------------------- reads ---- */

/** Needs-you first (flagged), then pinned, then by % DESCENDING (most done first, so a limit never cuts the nearly-finished tasks off), then oldest. A done task is excluded unless asked. */
export function listTasks(
  d: Database.Database,
  familyId: string,
  q: { roomId?: string; status?: string; limit: number; includeDone?: boolean },
): TaskRow[] {
  const where = ['family_id=?'];
  const args: unknown[] = [familyId];
  if (q.roomId) {
    where.push('room_id=?');
    args.push(q.roomId);
  }
  if (q.status) {
    where.push('status=?');
    args.push(q.status);
  } else if (!q.includeDone) {
    where.push(`status<>'done'`);
  }
  return d
    .prepare(
      `SELECT * FROM tasks WHERE ${where.join(' AND ')}
       ORDER BY (CASE WHEN flagged=1 THEN 0 ELSE 1 END), pinned DESC, pct DESC, id ASC LIMIT ?`,
    )
    .all(...args, q.limit) as TaskRow[];
}

export interface GroupSummary {
  roomId: string;
  linked: boolean;
  pct: number | null;
  open: number;
  needsYou: number;
  focus: number | null;
  activity: string;
}
export interface Summary {
  room: { pct: number | null; open: number; needsYou: number; focus: number | null; linkedGroups: number; totalGroups: number };
  groups: GroupSummary[];
}

/** The rail card and the preview header (spec section 5). `rooms` = every group of the family (the main room and its workgroups). */
export function summary(d: Database.Database, familyId: string, rooms: readonly { id: string }[], now = Date.now()): Summary {
  const groups: GroupSummary[] = [];
  const forPct: { linked: boolean; tasks: { status: TaskStatus; pct: number }[] }[] = [];
  let open = 0;
  let needs = 0;
  for (const r of rooms) {
    const linked = ensureGroup(d, familyId, r.id).linked;
    const tasks = d.prepare(`SELECT status, pct, flagged, done_at FROM tasks WHERE room_id=? AND parent_id IS NULL`).all(r.id) as Pick<TaskRow, 'status' | 'pct' | 'flagged' | 'done_at'>[];
    /* a done task past its keeping time no longer counts: only its title and dates are left of it */
    const kept = tasks.filter((t) => !(t.status === 'done' && pastKeeping(t.done_at, now)));
    const openN = kept.filter((t) => t.status !== 'done').length;
    const needsN = kept.filter((t) => t.status !== 'done' && t.flagged === 1).length;
    const focus = (d.prepare(`SELECT topic_id FROM task_focus WHERE room_id=?`).get(r.id) as { topic_id: number | null } | undefined)?.topic_id ?? null;
    const note = d
      .prepare(`SELECT n.text AS text, n.pct AS pct, n.at AS at, t.title AS title FROM task_notes n JOIN tasks t ON t.id=n.task_id WHERE t.room_id=? ORDER BY n.at DESC, n.id DESC LIMIT 1`)
      .get(r.id) as { text: string; pct: number | null; at: number; title: string } | undefined;
    const change = d.prepare(`SELECT title, status, status_at FROM tasks WHERE room_id=? ORDER BY status_at DESC LIMIT 1`).get(r.id) as { title: string; status: string; status_at: number } | undefined;
    const activity = note && (!change || note.at >= change.status_at) ? note.text || `${note.title}: ${note.pct}%` : change ? `${change.title}: ${change.status}` : '';
    groups.push({ roomId: r.id, linked, pct: groupPct(kept), open: openN, needsYou: needsN, focus, activity });
    forPct.push({ linked, tasks: kept });
    open += openN;
    needs += needsN;
  }
  const linkedGroups = groups.filter((g) => g.linked).length;
  /* the room's focus is the MAIN room's (the family id is the main room's id), whichever order the groups arrive in */
  const roomFocus = (d.prepare(`SELECT topic_id FROM task_focus WHERE room_id=?`).get(familyId) as { topic_id: number | null } | undefined)?.topic_id ?? null;
  return { room: { pct: roomPct(forPct), open, needsYou: needs, focus: roomFocus, linkedGroups, totalGroups: groups.length }, groups };
}

/* ------------------------------------------------------- topics and focus ---- */

export interface TopicRow {
  id: number;
  room_id: string;
  name: string;
  ord: number;
}
const TOPIC_MAX = 80;

function requireTopic(d: Database.Database, roomId: string, id: number): TopicRow {
  const t = Number.isInteger(id) ? (d.prepare(`SELECT * FROM task_topics WHERE id=?`).get(id) as TopicRow | undefined) : undefined;
  if (!t || t.room_id !== roomId) {
    throw new TaskError(404, 'no such topic here', 'topic');
  }
  return t;
}
export function topicList(d: Database.Database, roomId: string): TopicRow[] {
  return d.prepare(`SELECT * FROM task_topics WHERE room_id=? ORDER BY ord, id`).all(roomId) as TopicRow[];
}
function cleanTopicName(v: unknown): string {
  const n = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!n || n.length > TOPIC_MAX) {
    throw new TaskError(400, `a topic name is 1 to ${TOPIC_MAX} characters`, 'name');
  }
  return n;
}
function topicNameFree(d: Database.Database, roomId: string, name: string, exceptId = 0): void {
  const clash = (d.prepare(`SELECT id FROM task_topics WHERE room_id=? AND lower(name)=lower(?) AND id<>?`).get(roomId, name, exceptId) as { id: number } | undefined);
  if (clash) {
    throw new TaskError(409, `there is already a topic called "${name}" here`, 'name');
  }
}
export function topicAdd(d: Database.Database, roomId: string, name: unknown): TopicRow {
  const n = cleanTopicName(name);
  topicNameFree(d, roomId, n);
  if (topicList(d, roomId).length >= TOPICS_MAX) {
    throw new TaskError(409, `a group has at most ${TOPICS_MAX} topics`, 'name');
  }
  const next = ((d.prepare(`SELECT MAX(ord) AS m FROM task_topics WHERE room_id=?`).get(roomId) as { m: number | null }).m ?? -1) + 1;
  const info = d.prepare(`INSERT INTO task_topics (room_id, name, ord) VALUES (?, ?, ?)`).run(roomId, n, next);
  return d.prepare(`SELECT * FROM task_topics WHERE id=?`).get(Number(info.lastInsertRowid)) as TopicRow;
}
export function topicRename(d: Database.Database, roomId: string, id: number, name: unknown): TopicRow {
  const t = requireTopic(d, roomId, id);
  const n = cleanTopicName(name);
  topicNameFree(d, roomId, n, t.id);
  d.prepare(`UPDATE task_topics SET name=? WHERE id=?`).run(n, t.id);
  return requireTopic(d, roomId, id);
}
/** Delete a topic: its tasks are un-filed (never deleted), and a focus that pointed at it is cleared. */
export function topicDelete(d: Database.Database, roomId: string, id: number): void {
  const t = requireTopic(d, roomId, id);
  d.prepare(`UPDATE tasks SET topic_id=NULL WHERE topic_id=?`).run(t.id);
  d.prepare(`UPDATE task_focus SET topic_id=NULL WHERE room_id=? AND topic_id=?`).run(roomId, t.id);
  d.prepare(`DELETE FROM task_topics WHERE id=?`).run(t.id);
}
/** Move a topic to a position (0 = first; past the end = last). The others keep their order. */
export function topicMove(d: Database.Database, roomId: string, id: number, to: number): TopicRow[] {
  const t = requireTopic(d, roomId, id);
  const others = topicList(d, roomId).filter((x) => x.id !== t.id);
  const at = Math.max(0, Math.min(others.length, Number.isFinite(to) ? Math.floor(to) : others.length));
  others.splice(at, 0, t);
  others.forEach((x, i) => d.prepare(`UPDATE task_topics SET ord=? WHERE id=?`).run(i, x.id));
  return topicList(d, roomId);
}
/** File a task under a topic of ITS OWN group (null = un-file). */
export function moveToTopic(d: Database.Database, familyId: string, taskId: number, topicId: number | null, now = Date.now()): TaskRow {
  const t = requireTask(d, familyId, taskId);
  if (topicId !== null) {
    requireTopic(d, t.room_id, topicId);
  }
  return touch(d, t.id, now, 'topic_id=?', topicId);
}
export function setFocus(d: Database.Database, roomId: string, topicId: number | null): void {
  if (topicId !== null) {
    requireTopic(d, roomId, topicId);
  }
  d.prepare(`INSERT INTO task_focus (room_id, topic_id) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET topic_id=excluded.topic_id`).run(roomId, topicId);
}

/* --------------------------------------------------------------- subtasks ---- */

const SUBTASKS_MAX = 20;
/** Each title becomes a child task in the parent's group. All or none: one bad title refuses the list and writes nothing. */
export function addSubtasks(d: Database.Database, i: { familyId: string; parentId: number; titles: unknown }, now = Date.now()): TaskRow[] {
  if (!Array.isArray(i.titles) || !i.titles.length || i.titles.length > SUBTASKS_MAX) {
    throw new TaskError(400, `subtasks is a list of 1 to ${SUBTASKS_MAX} titles`, 'titles');
  }
  const titles = i.titles.map((raw) => {
    const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (!t || t.length > 200) {
      throw new TaskError(400, 'every subtask needs a title of at most 200 characters', 'titles');
    }
    return t;
  });
  const parent = requireTask(d, i.familyId, i.parentId);
  if (parent.parent_id !== null) {
    throw new TaskError(409, 'subtasks nest one level only', 'parent');
  }
  return titles.map((title) => addTask(d, { familyId: i.familyId, roomId: parent.room_id, title, parentId: parent.id }, now));
}

/* --------------------------------------------------------------- timeline ---- */

export interface SeatTimelineInfo {
  handle: string;
  lead: boolean;
  state: string;
}
interface Seg {
  start: number;
  end: number;
  working: number;
}
export interface TimelineGroup {
  alias: string;
  roomId: string;
  linked: boolean;
  segments: Seg[];
  needs: { start: number; end: number | null }[];
  marks: number[];
  /** how many of the OLDEST entries each lane left out to stay under its cap; absent when nothing was dropped */
  dropped?: LaneDrops;
  /** the query limit was hit: older rows were not even read */
  truncated?: true;
  seats: {
    handle: string;
    lead: boolean;
    state: string;
    stretches: { taskId: number; title: string; start: number; end: number | null; kind: 'work' | 'needs' }[];
    /** how many of the OLDEST stretches were left out to keep the answer under the cap; absent when none were */
    dropped?: number;
  }[];
}
export interface LaneDrops {
  segments?: number;
  needs?: number;
  marks?: number;
}
export interface Timeline {
  from: number;
  to: number;
  now: number;
  room: { segments: Seg[]; needs: { start: number; end: number | null }[]; marks: number[]; dropped?: LaneDrops; truncated?: true };
  groups: TimelineGroup[];
}

/** Count the seats working at once: cut the intervals at every boundary and number the pieces. Open intervals run to `to`. */
function segmentsOf(intervals: readonly { seat: string; start: number; end: number | null }[], from: number, to: number): Seg[] {
  const clipped = intervals
    .map((i) => ({ seat: i.seat, start: Math.max(i.start, from), end: Math.min(i.end ?? to, to) }))
    .filter((i) => i.end > i.start);
  const cuts = [...new Set(clipped.flatMap((i) => [i.start, i.end]))].sort((a, b) => a - b);
  const out: Seg[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const working = new Set(clipped.filter((i) => i.start <= cuts[k] && i.end >= cuts[k + 1]).map((i) => i.seat)).size;
    if (working > 0) {
      const last = out[out.length - 1];
      if (last && last.end === cuts[k] && last.working === working) {
        last.end = cuts[k + 1]; // adjacent pieces with the same count are one segment
      } else {
        out.push({ start: cuts[k], end: cuts[k + 1], working });
      }
    }
  }
  return out;
}

/** Merge overlapping or touching bands into one. An open band (end null) runs on forever. */
function mergeBands(bands: readonly { start: number; end: number | null }[]): { start: number; end: number | null }[] {
  const sorted = [...bands].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number | null }[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && (last.end === null || b.start <= last.end)) {
      last.end = last.end === null || b.end === null ? null : Math.max(last.end, b.end);
    } else {
      out.push({ start: b.start, end: b.end });
    }
  }
  return out;
}

/** The timeline of a family over the last `hours` (spec section 6): per group, who worked on what and when, the times a task needed the person,
 *  and the times a lead set a %. Every stretch is CLIPPED to the window's start; a seat shows at most TIMELINE_STRETCH_MAX stretches (the oldest
 *  are dropped, and `dropped` says how many). `rooms` = the family's groups with their aliases; `seatInfo` resolves a seat id to its handle, lead
 *  flag and state. */
export function timeline(
  d: Database.Database,
  familyId: string,
  rooms: readonly { id: string; alias: string }[],
  hours: number,
  now: number,
  seatInfo: (seatId: string) => SeatTimelineInfo,
): Timeline {
  const from = now - hours * 3_600_000;
  const clipStart = (s: number): number => Math.max(s, from);
  const groups: TimelineGroup[] = [];
  const all: { seat: string; start: number; end: number | null }[] = [];
  const allNeeds: { start: number; end: number | null }[] = [];
  const allMarks: number[] = [];
  let anyTruncated = false;
  for (const r of rooms) {
    const linked = ensureGroup(d, familyId, r.id).linked;
    const st = d
      .prepare(
        `SELECT s.seat_id AS seat_id, s.start_at AS start_at, s.end_at AS end_at, t.id AS task_id, t.title AS title
           FROM task_stretches s JOIN tasks t ON t.id=s.task_id
          WHERE t.room_id=? AND s.start_at<? AND (s.end_at IS NULL OR s.end_at>?) ORDER BY s.start_at DESC, s.id DESC LIMIT ${TIMELINE_QUERY_STRETCHES}`,
      )
      .all(r.id, now, from) as { seat_id: string; start_at: number; end_at: number | null; task_id: number; title: string }[];
    const needs = d
      .prepare(
        `SELECT n.start_at AS start_at, n.end_at AS end_at, t.id AS task_id, t.title AS title, t.claimed_seat AS seat
           FROM task_needs n JOIN tasks t ON t.id=n.task_id
          WHERE t.room_id=? AND n.start_at<? AND (n.end_at IS NULL OR n.end_at>?) ORDER BY n.start_at DESC LIMIT ${TIMELINE_QUERY_NEEDS}`,
      )
      .all(r.id, now, from) as { start_at: number; end_at: number | null; task_id: number; title: string; seat: string | null }[];
    const marks = (
      d
        .prepare(`SELECT n.at AS at FROM task_notes n JOIN tasks t ON t.id=n.task_id WHERE t.room_id=? AND n.pct IS NOT NULL AND n.at>=? AND n.at<=? ORDER BY n.at DESC LIMIT ${TIMELINE_QUERY_MARKS}`)
        .all(r.id, from, now) as { at: number }[]
    )
      .map((m) => m.at)
      .reverse();
    const hitLimit = st.length >= TIMELINE_QUERY_STRETCHES || needs.length >= TIMELINE_QUERY_NEEDS || marks.length >= TIMELINE_QUERY_MARKS;
    st.reverse();
    needs.reverse();
    const bySeat = new Map<string, TimelineGroup['seats'][number]>();
    const seatOf = (seatId: string): TimelineGroup['seats'][number] => {
      let e = bySeat.get(seatId);
      if (!e) {
        const info = seatInfo(seatId);
        e = { handle: info.handle, lead: info.lead, state: info.state, stretches: [] };
        bySeat.set(seatId, e);
      }
      return e;
    };
    for (const s of st) {
      seatOf(s.seat_id).stretches.push({ taskId: s.task_id, title: s.title, start: clipStart(s.start_at), end: s.end_at, kind: 'work' });
    }
    /* a flagged task a seat has claimed is a "needs" stretch under that seat; an unclaimed one is only in the group's bands */
    for (const n of needs) {
      if (n.seat) {
        seatOf(n.seat).stretches.push({ taskId: n.task_id, title: n.title, start: clipStart(n.start_at), end: n.end_at, kind: 'needs' });
      }
    }
    for (const e of bySeat.values()) {
      e.stretches.sort((a, b) => a.start - b.start);
      if (e.stretches.length > TIMELINE_STRETCH_MAX) {
        e.dropped = e.stretches.length - TIMELINE_STRETCH_MAX;
        e.stretches = e.stretches.slice(e.dropped); // the OLDEST go
      }
    }
    const gNeeds = mergeBands(needs.map((n) => ({ start: clipStart(n.start_at), end: n.end_at })));
    const gSegs = segmentsOf(st.map((s) => ({ seat: s.seat_id, start: s.start_at, end: s.end_at })), from, now);
    const lane = capLanes(gSegs, gNeeds, marks);
    groups.push({
      alias: r.alias,
      roomId: r.id,
      linked,
      segments: lane.segments,
      needs: lane.needs,
      marks: lane.marks,
      ...(lane.dropped ? { dropped: lane.dropped } : {}),
      ...(hitLimit ? { truncated: true as const } : {}),
      seats: [...bySeat.values()],
    });
    if (linked) {
      all.push(...st.map((s) => ({ seat: s.seat_id, start: s.start_at, end: s.end_at })));
      allNeeds.push(...gNeeds);
      allMarks.push(...marks);
      anyTruncated = anyTruncated || hitLimit;
    }
  }
  const roomLane = capLanes(segmentsOf(all, from, now), mergeBands(allNeeds), allMarks.sort((a, b) => a - b));
  return {
    from,
    to: now,
    now,
    room: { segments: roomLane.segments, needs: roomLane.needs, marks: roomLane.marks, ...(roomLane.dropped ? { dropped: roomLane.dropped } : {}), ...(anyTruncated ? { truncated: true as const } : {}) },
    groups,
  };
}

/** Keep the NEWEST entries of each lane under its cap and say how many of the oldest were left out (absent when none were). */
function capLanes(segments: Seg[], needs: { start: number; end: number | null }[], marks: number[]) {
  const dropped: LaneDrops = {};
  const keep = <T>(a: T[], max: number, key: keyof LaneDrops): T[] => {
    if (a.length <= max) return a;
    dropped[key] = a.length - max;
    return a.slice(a.length - max);
  };
  const out = { segments: keep(segments, TIMELINE_SEGMENT_MAX, 'segments'), needs: keep(needs, TIMELINE_NEEDS_MAX, 'needs'), marks: keep(marks, TIMELINE_MARKS_MAX, 'marks') };
  return { ...out, dropped: Object.keys(dropped).length ? dropped : undefined };
}

/* -------------------------------------------------------------- retention ---- */

/** A done task past its keeping time keeps its title, group, status and dates only: the body, its claimer, flags and topic, its notes, its stretches
 *  and its needs rows go. Idempotent.
 *  Returns how many tasks it trimmed. Run on the engine's existing timer. */
export function sweepRetention(d: Database.Database, now = Date.now()): number {
  const rows = d
    .prepare(`SELECT id, done_at FROM tasks WHERE status='done' AND trimmed=0 AND done_at IS NOT NULL`)
    .all() as { id: number; done_at: number }[];
  let n = 0;
  for (const r of rows) {
    if (!pastKeeping(r.done_at, now)) {
      continue;
    }
    foldStretches(d, r.id, Number.MAX_SAFE_INTEGER);
    d.prepare(`DELETE FROM task_notes WHERE task_id=?`).run(r.id);
    d.prepare(`DELETE FROM task_stretches WHERE task_id=?`).run(r.id);
    d.prepare(`DELETE FROM task_needs WHERE task_id=?`).run(r.id);
    d.prepare(`UPDATE tasks SET body='', claimed_seat=NULL, flagged=0, pinned=0, bug=0, topic_id=NULL, trimmed=1 WHERE id=?`).run(r.id);
    n++;
  }
  return n;
}

/* ------------------------------------------------------ timeline trimming ---- */
/* Trends, not detail (Owner, Tasks Gantt by seat): the stretches and needs bands are for the last day only and may go stale. */

/** Stretches/bands closer together than this are one; a closed stretch shorter than this is noise. */
export const TIMELINE_MERGE_MS = 60_000;
/** The timeline's longest window: anything that ended before it is no longer drawable and is folded into the time-worked total. */
export const TIMELINE_KEEP_MS = 24 * 3_600_000;

/** Add the closed stretches of a task that ended before `before` into its per-seat total (task_time) and delete them. An open stretch is never touched. */
function foldStretches(d: Database.Database, taskId: number, before: number): void {
  const rows = d
    .prepare(`SELECT id, seat_id, start_at, end_at FROM task_stretches WHERE task_id=? AND end_at IS NOT NULL AND end_at<?`)
    .all(taskId, before) as { id: number; seat_id: string; start_at: number; end_at: number }[];
  for (const r of rows) {
    d.prepare(
      `INSERT INTO task_time (task_id, seat_id, total_ms, last_end) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, seat_id) DO UPDATE SET total_ms=total_ms+excluded.total_ms, last_end=MAX(last_end, excluded.last_end)`,
    ).run(taskId, r.seat_id, Math.max(0, r.end_at - r.start_at), r.end_at);
    d.prepare(`DELETE FROM task_stretches WHERE id=?`).run(r.id);
  }
}

/** Merge closed rows (sorted by start) whose gap is under TIMELINE_MERGE_MS into the earlier one. An open row (end_at NULL) is never merged into or out of. Returns the surviving count removed. */
function mergeClosed(d: Database.Database, table: 'task_stretches' | 'task_needs', rows: { id: number; start_at: number; end_at: number }[]): number {
  let removed = 0;
  let cur: { id: number; end_at: number } | null = null;
  for (const r of rows) {
    if (cur && r.start_at - cur.end_at < TIMELINE_MERGE_MS) {
      if (r.end_at > cur.end_at) {
        cur.end_at = r.end_at;
        d.prepare(`UPDATE ${table} SET end_at=? WHERE id=?`).run(cur.end_at, cur.id);
      }
      d.prepare(`DELETE FROM ${table} WHERE id=?`).run(r.id);
      removed++;
    } else {
      cur = { id: r.id, end_at: r.end_at };
    }
  }
  return removed;
}

/** The merge/drop half. Only SETTLED rows are looked at (a closed stretch that ended at least a minute ago: nothing can still merge into its tail), and only the
 *  task+seat pairs with a stretch that settled after `since` (0 = every pair). A closed stretch under a minute is kept while an open one of the same task+seat
 *  started within a minute of its end (the run is still going; the open one is never touched, and the short one is its start). Returns rows removed. */
export function mergeTimeline(d: Database.Database, now = Date.now(), since = 0): number {
  const cutoff = now - TIMELINE_MERGE_MS;
  let n = 0;
  d.transaction(() => {
    const pairs = d.prepare(`SELECT DISTINCT task_id, seat_id FROM task_stretches WHERE end_at IS NOT NULL AND end_at<=? AND end_at>?`).all(cutoff, since) as { task_id: number; seat_id: string }[];
    for (const p of pairs) {
      const rows = d
        .prepare(`SELECT id, start_at, end_at FROM task_stretches WHERE task_id=? AND seat_id=? AND end_at IS NOT NULL AND end_at<=? ORDER BY start_at, id`)
        .all(p.task_id, p.seat_id, cutoff) as { id: number; start_at: number; end_at: number }[];
      n += mergeClosed(d, 'task_stretches', rows);
      n += d
        .prepare(
          `DELETE FROM task_stretches WHERE task_id=? AND seat_id=? AND end_at IS NOT NULL AND end_at<=? AND end_at-start_at<?
             AND NOT EXISTS (SELECT 1 FROM task_stretches o WHERE o.task_id=task_stretches.task_id AND o.seat_id=task_stretches.seat_id AND o.end_at IS NULL
                             AND o.start_at>=task_stretches.end_at AND o.start_at-task_stretches.end_at<?)`,
        )
        .run(p.task_id, p.seat_id, cutoff, TIMELINE_MERGE_MS, TIMELINE_MERGE_MS).changes;
    }
    const tasks = d.prepare(`SELECT DISTINCT task_id FROM task_needs WHERE end_at IS NOT NULL AND end_at<=? AND end_at>?`).all(cutoff, since) as { task_id: number }[];
    for (const t of tasks) {
      const rows = d
        .prepare(`SELECT id, start_at, end_at FROM task_needs WHERE task_id=? AND end_at IS NOT NULL AND end_at<=? ORDER BY start_at, id`)
        .all(t.task_id, cutoff) as { id: number; start_at: number; end_at: number }[];
      n += mergeClosed(d, 'task_needs', rows);
    }
  })();
  return n;
}

let lastTickCutoff = 0;
/** The 60 s tick: merge/drop only what settled since the previous tick. Cheap when nothing closed. */
export function mergeTimelineTick(d: Database.Database, now = Date.now()): number {
  const n = mergeTimeline(d, now, lastTickCutoff);
  lastTickCutoff = now - TIMELINE_MERGE_MS;
  return n;
}

/** The 24 h half: stretches that ended more than 24 h ago fold into task_time and go; needs that ended more than 24 h ago go. Open rows are never touched. */
export function foldTimeline(d: Database.Database, now = Date.now()): number {
  let n = 0;
  d.transaction(() => {
    const before = now - TIMELINE_KEEP_MS;
    const old = d.prepare(`SELECT DISTINCT task_id FROM task_stretches WHERE end_at IS NOT NULL AND end_at<?`).all(before) as { task_id: number }[];
    for (const t of old) {
      const count = (): number => (d.prepare(`SELECT COUNT(*) AS c FROM task_stretches WHERE task_id=?`).get(t.task_id) as { c: number }).c;
      const had = count();
      foldStretches(d, t.task_id, before);
      n += had - count();
    }
    n += d.prepare(`DELETE FROM task_needs WHERE end_at IS NOT NULL AND end_at<?`).run(before).changes;
  })();
  return n;
}

/** The whole pass (the hourly retention timer; also catches up after a restart): merge/drop every pair, then fold. Idempotent. */
export function sweepTimeline(d: Database.Database, now = Date.now()): number {
  return mergeTimeline(d, now, 0) + foldTimeline(d, now);
}

/** Time worked on a task, per seat, from the folded (stale) stretches only. */
export function timeWorked(d: Database.Database, taskId: number): { seat_id: string; total_ms: number; last_end: number }[] {
  return d.prepare(`SELECT seat_id, total_ms, last_end FROM task_time WHERE task_id=? ORDER BY seat_id`).all(taskId) as { seat_id: string; total_ms: number; last_end: number }[];
}
