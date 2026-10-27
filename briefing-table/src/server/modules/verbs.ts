/* The fixed Tasks verb map for module pages (ported from workbench-app src/module-tasks-verbs.js; the design notes revision 7, item 5; the
 * engine's verbs in KB design-notes-id §4, §8, §10). One grant, one method and one path under /api/rooms/:id per verb. build() checks the input
 * before anything reaches the engine: only the verb's own keys, the right types, the spec's bounds, never an author key, never a room (the room
 * comes from the caller's binding). claim and unclaim are not here (a person cannot claim), nor set-linked (the person's own Settings, not a
 * module's). The app's Vikunja-only room-summary verb is not ported: the engine has no Room Tasks panel. purge needs a host-minted approval
 * (approval.ts). Pure. test/modules-verbs.test.ts. */

export const READ = 'rooms.tasks.read';
export const WRITE = 'rooms.tasks.write';
export const DELETE = 'rooms.tasks.delete';
const ROOM = /^[A-Za-z0-9_-]{1,80}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const REFUSED_KEYS = new Set(['from', 'by', 'author', 'actor', 'handle', 'seat', 'user', 'sender', 'room', 'roomId']);
const LIST_STATUS = ['open', 'in-progress', 'blocked', 'done']; // what the engine's list accepts (tasks-routes.ts)
const STATUS = ['open', 'in-progress', 'blocked', 'done'];

type Input = Record<string, unknown>;
type Check = (x: unknown) => boolean;
type Grant = typeof READ | typeof WRITE | typeof DELETE;

const isInt = (x: unknown, lo: number, hi: number): boolean => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
const text = (x: unknown, max: number, { required = true }: { required?: boolean } = {}): boolean => typeof x === 'string' && x.length <= max && (!required || x.trim().length > 0);
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

// field checks: return true when the value is acceptable
const F = {
  tid: (x) => isInt(x, 1, Number.MAX_SAFE_INTEGER),
  group: (x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 64,
  listStatus: (x) => LIST_STATUS.includes(x as string),
  status: (x) => STATUS.includes(x as string),
  limit: (x) => isInt(x, 1, 200),
  hours: (x) => isInt(x, 1, 24),
  title: (x) => text(x, 200),
  body: (x) => typeof x === 'string' && bytes(x) <= 16 * 1024,
  priority: (x) => isInt(x, 0, 5),
  pct: (x) => isInt(x, 0, 100),
  note: (x) => text(x, 280, { required: false }),
  titles: (x) => Array.isArray(x) && x.length >= 1 && x.length <= 20 && x.every((t) => text(t, 200)),
  topicId: (x) => isInt(x, 1, Number.MAX_SAFE_INTEGER),
  topicOrNone: (x) => x === null || isInt(x, 1, Number.MAX_SAFE_INTEGER),
  name: (x) => text(x, 60),
  to: (x) => isInt(x, 0, 1000),
  seatHandle: (x) => typeof x === 'string' && HANDLE.test(x),
  askText: (x) => text(x, 280),
} satisfies Record<string, Check>;

export interface VerbSpec {
  grant: Grant;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: (input: Input) => string;
  query?: Record<string, Check>;
  body?: Record<string, Check>;
  ids?: string[];
  required?: string[];
  exactlyOne?: string[];
  approval?: boolean;
}

// spec: grant, method, path(input) under the room, query keys, body keys, required keys, field check names
const t = (i: Input): string => '/tasks/' + String(i.tid);
export const VERBS: Record<string, VerbSpec> = {
  list: { grant: READ, method: 'GET', path: () => '/tasks', query: { group: F.group, status: F.listStatus, limit: F.limit } },
  summary: { grant: READ, method: 'GET', path: () => '/tasks/summary' },
  timeline: { grant: READ, method: 'GET', path: () => '/tasks/timeline', query: { group: F.group, hours: F.hours } },
  topics: { grant: READ, method: 'GET', path: () => '/tasks/topics' },
  add: { grant: WRITE, method: 'POST', path: () => '/tasks', body: { title: F.title, body: F.body, group: F.group, priority: F.priority, parent: F.tid }, required: ['title'] },
  status: { grant: WRITE, method: 'POST', path: (i) => t(i) + '/status', ids: ['tid'], body: { status: F.status }, required: ['status'] },
  progress: { grant: WRITE, method: 'POST', path: (i) => t(i) + '/progress', ids: ['tid'], body: { pct: F.pct, note: F.note }, required: ['pct'] },
  assign: { grant: WRITE, method: 'POST', path: (i) => t(i) + '/assign', ids: ['tid'], body: { group: F.group, seat: F.seatHandle }, exactlyOne: ['group', 'seat'] },
  flag: { grant: WRITE, method: 'POST', path: (i) => t(i) + '/flag', ids: ['tid'] },
  unflag: { grant: WRITE, method: 'DELETE', path: (i) => t(i) + '/flag', ids: ['tid'] },
  priority: { grant: WRITE, method: 'POST', path: (i) => t(i) + '/priority', ids: ['tid'], body: { priority: F.priority }, required: ['priority'] },
  subtasks: { grant: WRITE, method: 'POST', path: (i) => t(i) + '/subtasks', ids: ['tid'], body: { titles: F.titles }, required: ['titles'] },
  pin: { grant: WRITE, method: 'POST', path: (i) => t(i) + '/pin', ids: ['tid'] },
  unpin: { grant: WRITE, method: 'DELETE', path: (i) => t(i) + '/pin', ids: ['tid'] },
  bug: { grant: WRITE, method: 'POST', path: (i) => t(i) + '/bug', ids: ['tid'] },
  unbug: { grant: WRITE, method: 'DELETE', path: (i) => t(i) + '/bug', ids: ['tid'] },
  'topic-add': { grant: WRITE, method: 'POST', path: () => '/tasks/topics', body: { name: F.name }, required: ['name'] },
  'topic-rename': { grant: WRITE, method: 'POST', path: (i) => '/tasks/topics/' + String(i.topicId) + '/rename', ids: ['topicId'], body: { name: F.name }, required: ['name'] },
  'topic-move': { grant: WRITE, method: 'POST', path: (i) => '/tasks/topics/' + String(i.topicId) + '/move', ids: ['topicId'], body: { to: F.to }, required: ['to'] },
  'topic-delete': { grant: WRITE, method: 'DELETE', path: (i) => '/tasks/topics/' + String(i.topicId), ids: ['topicId'] },
  'move-to-topic': { grant: WRITE, method: 'POST', path: (i) => t(i) + '/topic', ids: ['tid'], body: { topic: F.topicId }, required: ['topic'] },
  focus: { grant: WRITE, method: 'PUT', path: () => '/tasks/focus', body: { topic: F.topicOrNone }, required: ['topic'] },
  link: { grant: WRITE, method: 'POST', path: () => '/tasks/link' },
  unlink: { grant: WRITE, method: 'DELETE', path: () => '/tasks/link' },
  'ask-lead': { grant: WRITE, method: 'POST', path: () => '/tasks/ask-lead', body: { group: F.group, text: F.askText }, required: ['text'] },
  purge: { grant: DELETE, method: 'DELETE', path: (i) => t(i), ids: ['tid'], approval: true },
};

const ID_CHECKS: Record<string, Check> = { tid: F.tid, topicId: F.topicId };

export interface Refusal { ok: false; field: string; error: string }
export interface Built {
  ok: true;
  grant: Grant;
  method: VerbSpec['method'];
  path: string;
  body: Record<string, unknown> | null;
  needsApproval?: true;
  taskId?: number;
}
const refuse = (field: string, error: string): Refusal => ({ ok: false, field, error });

/** A module page's call → {ok:true, grant, method, path, body[, needsApproval, taskId]} or {ok:false, field, error}. */
export function build(verb: unknown, roomId: unknown, input: unknown): Built | Refusal {
  if (typeof verb !== 'string' || !Object.prototype.hasOwnProperty.call(VERBS, verb)) return refuse('verb', "That isn't a Tasks action.");
  const spec = VERBS[verb];
  if (typeof roomId !== 'string' || !ROOM.test(roomId)) return refuse('room', 'No room is shown.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('input', 'The input must be an object.');
  const inp = input as Input;
  const ids = spec.ids || [];
  const query = spec.query || {};
  const body = spec.body || {};
  for (const k of Object.keys(inp)) {
    if (REFUSED_KEYS.has(k) && !(verb === 'assign' && k === 'seat')) return refuse(k, 'The author and the room come from the app, not the input.');
    if (!ids.includes(k) && !(k in query) && !(k in body)) return refuse(k, 'Not an input of ' + verb + '.');
  }
  for (const k of ids) if (!ID_CHECKS[k](inp[k])) return refuse(k, k + ' must be a positive whole number.');
  for (const k of spec.required || []) if (!(k in inp)) return refuse(k, k + ' is required.');
  if (spec.exactlyOne && spec.exactlyOne.filter((k) => k in inp).length !== 1) return refuse(spec.exactlyOne[0], 'Give exactly one of ' + spec.exactlyOne.join(' or ') + '.');
  const out: Record<string, unknown> = {};
  for (const [k, ok] of Object.entries(body)) {
    if (!(k in inp)) continue;
    if (!ok(inp[k])) return refuse(k, k + ' is not valid.');
    out[k] = inp[k];
  }
  const qs: string[] = [];
  for (const [k, ok] of Object.entries(query)) {
    if (!(k in inp)) continue;
    if (!ok(inp[k])) return refuse(k, k + ' is not valid.');
    qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(inp[k])));
  }
  const path = '/api/rooms/' + encodeURIComponent(roomId) + spec.path(inp) + (qs.length ? '?' + qs.join('&') : '');
  const res: Built = { ok: true, grant: spec.grant, method: spec.method, path, body: spec.method === 'GET' || spec.method === 'DELETE' ? null : out }; // a POST or PUT always sends a JSON object, {} when it has no inputs
  if (spec.approval) Object.assign(res, { needsApproval: true, taskId: inp.tid });
  return res;
}
