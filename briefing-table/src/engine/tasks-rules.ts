/* TASKS, the rules (KB design-notes-id, builder-two's design; Owner [ref]: Tasks is core and lives inside the engine). PURE: no db, no clock, no
 * I/O. The store (store.ts) holds the rows and the routes (rooms.ts) carry the verbs; THIS file decides the arithmetic and the permissions, so
 * both can be tested without an engine and the two doors (the person's and the agent's) cannot disagree.
 *
 * One list per room FAMILY, keyed on the ROOT room's id (design review [ref]: a workgroup must not get its own task list by accident); each group
 * (workgroup) keeps its own tasks inside it. */

export const TASK_STATUSES = ['open', 'in-progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TITLE_MAX = 200;
export const BODY_MAX = 16 * 1024;
export const NOTE_MAX = 280;
export const PRIORITY_MAX = 5;
export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 200;
export const HOURS_DEFAULT = 8;
export const HOURS_MAX = 24;
/** A done task keeps everything for this long after `done_at`, then only its title and dates. */
export const DONE_KEEP_MS = 7 * 24 * 3_600_000;
/** At most this many topics in a group, open (not done) tasks in a family, and stretches per seat in one timeline answer. */
export const TOPICS_MAX = 50;
export const OPEN_MAX = 2000;
export const TIMELINE_STRETCH_MAX = 200;
/** The other timeline lanes are bounded too (builder-two round 2): at most this many per lane, the newest kept, with a count of what was left out. */
export const TIMELINE_SEGMENT_MAX = 500;
export const TIMELINE_NEEDS_MAX = 200;
export const TIMELINE_MARKS_MAX = 200;
/** How many rows the timeline reads from each table for one group, newest first: a flood cannot make one request read every row. */
export const TIMELINE_QUERY_STRETCHES = 4000;
export const TIMELINE_QUERY_NEEDS = 1000;
export const TIMELINE_QUERY_MARKS = 1000;
/** The per-pane write limit an agent shares between task writes and room posts. The number lives in pane-tokens.ts (ROOM_POST_PER_MIN); this copy is only
 *  for the message and is asserted equal in test/tasks-routes.test.ts. */
export const WRITES_PER_MIN = 20;

/** Input keys that try to NAME the author. The author always comes from the caller (pane token -> seat, or the window cookie); these are refused. */
export const SPOOF_KEYS = ['from', 'by', 'author', 'actor', 'handle', 'seat', 'user', 'sender'] as const;

export function validStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}

/** The first spoofing key present in a request body, or null. */
export function spoofedKey(body: unknown, allow: readonly string[] = []): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const keys = Object.keys(body as Record<string, unknown>).map((k) => k.toLowerCase());
  return SPOOF_KEYS.find((k) => keys.includes(k) && !allow.includes(k)) ?? null;
}

/** `limit` clamped to 1..200 (default 50). A non-number is the default. */
export function clampLimit(v: unknown): number {
  const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(LIMIT_MAX, Math.max(1, Math.floor(n))) : LIMIT_DEFAULT;
}
/** `hours` clamped to 1..24 (default 8). */
export function clampHours(v: unknown): number {
  const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(HOURS_MAX, Math.max(1, Math.floor(n))) : HOURS_DEFAULT;
}

export class TaskInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

export function validTitle(v: unknown): string {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!t) {
    throw new TaskInputError('title', 'a task needs a title');
  }
  if (t.length > TITLE_MAX) {
    throw new TaskInputError('title', `a title is at most ${TITLE_MAX} characters (this is ${t.length})`);
  }
  return t;
}
export function validBody(v: unknown): string {
  if (v === undefined || v === null) {
    return '';
  }
  if (typeof v !== 'string') {
    throw new TaskInputError('body', 'the body is text');
  }
  if (Buffer.byteLength(v, 'utf8') > BODY_MAX) {
    throw new TaskInputError('body', `a body is at most ${BODY_MAX / 1024} KB`);
  }
  return v;
}
export function validNote(v: unknown): string {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (t.length > NOTE_MAX) {
    throw new TaskInputError('note', `a note is at most ${NOTE_MAX} characters (this is ${t.length})`);
  }
  return t;
}
export function validPriority(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > PRIORITY_MAX) {
    throw new TaskInputError('priority', `priority is a whole number 0 to ${PRIORITY_MAX}`);
  }
  return v;
}
export function validPct(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) {
    throw new TaskInputError('pct', 'pct is a whole number 0 to 100');
  }
  return v;
}

/* ------------------------------------------------------------- percentages ---- */

export interface PctTask {
  status: TaskStatus;
  pct: number;
}
/** % of a group: the average pct of its tasks, a done task counting as 100. null = no tasks (there is nothing to average, which is not 0). */
export function groupPct(tasks: readonly PctTask[]): number | null {
  if (!tasks.length) {
    return null;
  }
  const sum = tasks.reduce((a, t) => a + (t.status === 'done' ? 100 : t.pct), 0);
  return Math.round(sum / tasks.length);
}
/** % of the room: the same rule over the tasks of LINKED groups only. null = no linked group has a task. */
export function roomPct(groups: readonly { linked: boolean; tasks: readonly PctTask[] }[]): number | null {
  return groupPct(groups.filter((g) => g.linked).flatMap((g) => g.tasks));
}

/* ------------------------------------------------------------- permissions ---- */

export type TaskVerb =
  | 'list' | 'summary' | 'timeline'
  | 'add' | 'claim' | 'unclaim' | 'flag' | 'unflag' | 'priority' | 'subtasks' | 'bug' | 'unbug' | 'ask-lead'
  | 'status'
  | 'assign' | 'progress' | 'pin' | 'unpin' | 'topics' | 'topic-add' | 'topic-rename' | 'topic-delete' | 'topic-move' | 'move-to-topic' | 'focus' | 'link' | 'unlink'
  | 'purge' | 'set-linked';

/** Who is asking. A person (the window cookie) or a seat (its pane token). `lead` = leads a room of this family (the group's, or the main room's).
 *  `leadsThisGroup` = the group the verb touches; `ownsTask` = the task is claimed by this seat. */
export interface TaskActor {
  kind: 'person' | 'seat';
  lead?: boolean;
  leadsThisGroup?: boolean;
  /** leads THIS group itself (not merely the main room, which leads every group): the only lead who links or unlinks it */
  leadsOwnGroup?: boolean;
  ownsTask?: boolean;
}

const READS: TaskVerb[] = ['list', 'summary', 'timeline'];
const ANY_SEAT: TaskVerb[] = ['add', 'claim', 'flag', 'unflag', 'priority', 'subtasks', 'bug', 'unbug', 'ask-lead'];
const LEAD: TaskVerb[] = ['assign', 'progress', 'pin', 'unpin', 'topics', 'topic-add', 'topic-rename', 'topic-delete', 'topic-move', 'move-to-topic', 'focus'];
const LEAD_OWN_GROUP: TaskVerb[] = ['link', 'unlink'];
const PERSON_ONLY: TaskVerb[] = ['purge', 'set-linked'];

/** null = allowed; otherwise the plain refusal. The person may do everything. A seat: any seat does READS and the "any seat" verbs; `status`
 *  only on a task it claimed, or as a lead; a lead does the lead verbs; link/unlink only for its own group; purge and set-linked never. */
export function taskRefusal(verb: TaskVerb, a: TaskActor): string | null {
  if (a.kind === 'person') {
    return null;
  }
  if (PERSON_ONLY.includes(verb)) {
    return 'that is the person\'s; ask them';
  }
  if (READS.includes(verb) || ANY_SEAT.includes(verb)) {
    return null;
  }
  if (verb === 'status') {
    /* the owner, or the lead of THIS task's group (the room lead leads every group); another group's lead does not */
    return a.ownsTask || (a.lead && a.leadsThisGroup) ? null : 'a seat sets the status of a task it has claimed; claim it first, or ask the group\'s lead';
  }
  if (verb === 'unclaim') {
    return a.ownsTask || (a.lead && a.leadsThisGroup) ? null : 'a seat releases only a task it has claimed; the group\'s lead can release any';
  }
  if (LEAD.includes(verb)) {
    /* a lead acts in ITS group; the room lead (who leads the main room) acts in all of them. Another group's lead does not. */
    return a.lead && a.leadsThisGroup ? null : 'that is the group lead\'s; ask the lead';
  }
  if (LEAD_OWN_GROUP.includes(verb)) {
    return a.lead && a.leadsOwnGroup ? null : 'only a group\'s own lead (or the person) links or unlinks it';
  }
  return 'unknown task verb';
}

/** A done task past its keeping time is trimmed to its title and dates. */
export function pastKeeping(doneAt: number | null, now: number): boolean {
  return doneAt !== null && now - doneAt > DONE_KEEP_MS;
}
