/* TASKS, the routes (KB design-notes-id; Owner [ref]: Tasks is core, inside the engine). ONE handler for BOTH doors: the person's (window cookie)
 * and an agent's (its pane token, through rooms.handleAgent). The caller (rooms.ts) has already resolved WHO: a person, or the seat the pane holds
 * in THIS room (the same `not_seated` answer as every other agent route for a room it does not hold). Everything here is scoped to that room's
 * FAMILY, keyed on the ROOT room; a task of another family reads as "no such task".
 *
 * The author always comes from the caller: a body that tries to name one (from, by, author, ...) is refused. The rules (who may do what, bounds)
 * are engine/tasks-rules.ts; the rows are table/tasks-store.ts. Verb names are the ones E1 will expose, so the move to MCP tools is a transport swap. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Room, RoomSeat } from '../table/endpoint.ts';
import { table } from '../table/endpoint.ts';
import * as ts from '../table/tasks-store.ts';
import * as rules from '../engine/tasks-rules.ts';
import * as roomBus from '../engine/room-bus.ts';

export interface TasksCtx {
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  readObject(req: IncomingMessage): Promise<Record<string, any>>;
  /** build the engine's own FieldError (a 4xx that names its field); the caller's outer handler answers it */
  err(status: number, message: string, field: string): Error;
  seatState(seat: RoomSeat): string;
  /** post the line (already "@lead text") in `room`, as the asker */
  askLead(room: Room, actor: 'user' | { seatId: string }, text: string): void;
  /** the 429 in the room-post shape ({ok:false, error:'rate_limited', message, retry_after}) */
  rateLimited(message: string, retryAfter: number): Error;
  /** the per-PANE write limit an agent shares with room posts (pane-tokens takeRoomPost) */
  takeWrite(paneid: string): { ok: true } | { ok: false; retryAfter: number };
}
export type Who = { human: true } | { human: false; seat: RoomSeat; paneid: string };

const ASK_MAX = 2000;

/** Tasks is built into the LOCAL engine. The server engine (the server) keeps the Vikunja-backed Room Tasks until Owner decides whether it migrates, so
 *  there it is off unless HARBOR_WB_TASKS=1; HARBOR_WB_TASKS=0 turns it off locally. The env var wins in both directions. */
export function tasksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.HARBOR_WB_TASKS === '1') return true;
  if (env.HARBOR_WB_TASKS === '0') return false;
  if ((env.HARBOR_WB_HOSTED ?? '').trim() === '1') return true; // the hosted web build has Tasks built in
  return (env.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local';
}

export async function handleTasks(ctx: TasksCtx, req: IncomingMessage, res: ServerResponse, room: Room, sub: string[], who: Who): Promise<boolean> {
  if (sub[0] !== 'tasks' || !tasksEnabled()) {
    return false;
  }
  const method = req.method ?? 'GET';
  /* `sub` was already percent-decoded once by the caller; decoding again would turn a literal % into a 500 (and could double-decode) */
  const r = matchRoute(method, sub.slice(1));
  if (!r) {
    return false;
  }
  try {
    /* an agent's writes share ONE per-pane limit with its room posts (builder-two [ref] items 2 and 4); reads and the person are not limited */
    if (!who.human && (r.write || r.verb === 'ask-lead')) {
      const rate = ctx.takeWrite(who.paneid);
      if (!rate.ok) {
        throw ctx.rateLimited(`at most ${rules.WRITES_PER_MIN} writes a minute (room posts and task changes together)`, rate.retryAfter);
      }
    }
    const out = await run(ctx, req, room, who, r, new URL(req.url ?? '/', 'http://x').searchParams);
    if (r.write) {
      for (const id of table.familyRoomIds(room.id)) {
        roomBus.emit(id, { type: 'room.tasks' });
      }
    }
    ctx.sendJson(res, 200, out);
  } catch (e) {
    if (e instanceof ts.TaskError) {
      throw ctx.err(e.status, e.message, e.field ?? 'task');
    }
    if (e instanceof rules.TaskInputError) {
      throw ctx.err(400, e.message, e.field);
    }
    throw e;
  }
  return true;
}

/* ------------------------------------------------------------------ routing ---- */

export interface Route {
  verb: rules.TaskVerb;
  write: boolean;
  tid?: number;
  topic?: number;
  gid?: string;
}
const num = (s: string): number => (/^\d{1,12}$/.test(s) ? Number(s) : NaN);

/** The route a request matches, or null. Exported for the agent door's allow-list. */
export function matchRoute(method: string, p: string[]): Route | null {
  const R = (verb: rules.TaskVerb, write: boolean, extra: Partial<Route> = {}): Route => ({ verb, write, ...extra });
  const GET = method === 'GET';
  const POST = method === 'POST';
  const DEL = method === 'DELETE';
  const PUT = method === 'PUT';
  if (p.length === 0) {
    return GET ? R('list', false) : POST ? R('add', true) : null;
  }
  if (p.length === 1) {
    if (p[0] === 'summary' && GET) return R('summary', false);
    if (p[0] === 'timeline' && GET) return R('timeline', false);
    if (p[0] === 'focus' && PUT) return R('focus', true);
    if (p[0] === 'link') return POST ? R('link', true) : DEL ? R('unlink', true) : null;
    if (p[0] === 'ask-lead' && POST) return R('ask-lead', false);
    if (p[0] === 'topics') return GET ? R('topics', false) : POST ? R('topic-add', true) : null;
    return DEL && !Number.isNaN(num(p[0])) ? R('purge', true, { tid: num(p[0]) }) : null;
  }
  if (p[0] === 'topics') {
    const id = num(p[1]);
    if (Number.isNaN(id)) return null;
    if (p.length === 2 && DEL) return R('topic-delete', true, { topic: id });
    if (p.length === 3 && POST && p[2] === 'rename') return R('topic-rename', true, { topic: id });
    if (p.length === 3 && POST && p[2] === 'move') return R('topic-move', true, { topic: id });
    return null;
  }
  if (p[0] === 'groups' && p.length === 3 && p[2] === 'link' && PUT) {
    return R('set-linked', true, { gid: p[1] });
  }
  const tid = num(p[0]);
  if (Number.isNaN(tid) || p.length !== 2) return null;
  const v = p[1];
  const T = (verb: rules.TaskVerb): Route => R(verb, true, { tid });
  if (v === 'claim') return POST ? T('claim') : DEL ? T('unclaim') : null;
  if (v === 'flag') return POST ? T('flag') : DEL ? T('unflag') : null;
  if (v === 'pin') return POST ? T('pin') : DEL ? T('unpin') : null;
  if (v === 'bug') return POST ? T('bug') : DEL ? T('unbug') : null;
  if (!POST) return null;
  if (v === 'assign') return T('assign');
  if (v === 'status') return T('status');
  if (v === 'progress') return T('progress');
  if (v === 'priority') return T('priority');
  if (v === 'subtasks') return T('subtasks');
  if (v === 'topic') return T('move-to-topic');
  return null;
}

/* --------------------------------------------------------------------- run ---- */

async function run(ctx: TasksCtx, req: IncomingMessage, room: Room, who: Who, r: Route, q: URLSearchParams): Promise<unknown> {
  const familyIds = table.familyRoomIds(room.id);
  const familyId = familyIds[0];
  const rooms = familyIds.map((id) => table.getRoom(id)).filter((x): x is Room => !!x && x.state !== 'archived');
  const aliasOf = (id: string): string => {
    const x = rooms.find((y) => y.id === id) ?? table.getRoom(id);
    return x?.alias ?? (x?.parent_id ? x.name : 'main');
  };
  const groupByRef = (ref: unknown): Room => {
    if (typeof ref !== 'string' || !ref.trim()) throw ctx.err(400, 'group is a group alias or a room id', 'group');
    const s = ref.trim().toLowerCase();
    const g = rooms.find((x) => x.id === s || (x.alias ?? '').toLowerCase() === s || (x.parent_id === null && (s === 'main' || s === 'room')));
    if (!g) throw ctx.err(404, 'no such group here', 'group');
    return g;
  };
  const groupOf = (ref: unknown): Room => (ref === undefined || ref === null ? room : groupByRef(ref));
  const leadRooms = who.human ? [] : rooms.filter((x) => x.lead_seat === who.seat.id);
  const handleOf = (seatId: string | null): string | null => (seatId ? table.getSeat(seatId)?.handle ?? null : null);
  const view = (t: ts.TaskRow): Record<string, unknown> => ({
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status,
    priority: t.priority,
    pct: t.status === 'done' ? 100 : t.pct,
    group: { id: t.room_id, alias: aliasOf(t.room_id) },
    claimed_by: handleOf(t.claimed_seat),
    from_group: t.assigned_from_room ? aliasOf(t.assigned_from_room) : null,
    parent_id: t.parent_id,
    topic_id: t.topic_id,
    pinned: t.pinned === 1,
    bug: t.bug === 1,
    flagged: t.flagged === 1,
    needs_you: t.status !== 'done' && t.flagged === 1,
    created_at: t.created_at,
    updated_at: t.updated_at,
    done_at: t.done_at,
    trimmed: t.trimmed === 1,
  });
  const need = (verb: rules.TaskVerb, group: Room, task?: ts.TaskRow): void => {
    const actor: rules.TaskActor = who.human
      ? { kind: 'person' }
      : {
          kind: 'seat',
          lead: leadRooms.length > 0,
          // the lead of the group itself, or the lead of the MAIN room (it leads every group of the family)
          leadsThisGroup: leadRooms.some((x) => x.id === group.id || x.parent_id === null),
          // the lead of THIS group itself: the only seat that links or unlinks it (the room lead does not, for a group that is not its own)
          leadsOwnGroup: leadRooms.some((x) => x.id === group.id),
          ownsTask: !!task && task.claimed_seat === who.seat.id,
        };
    const no = rules.taskRefusal(verb, actor);
    if (no) throw ctx.err(403, no, 'verb');
  };
  const body = async (): Promise<Record<string, any>> => {
    const b = await ctx.readObject(req);
    /* `assign` names its TARGET with `seat`; that one key is allowed there and nowhere else */
    const spoof = rules.spoofedKey(b, r.verb === 'assign' ? ['seat'] : []);
    if (spoof) throw ctx.err(400, `"${spoof}" cannot be set: who did it comes from who is asking`, spoof);
    return b;
  };
  /* the verbs with no body of their own still refuse a banned author key if one is sent, and a body that is not JSON (or is too big) is the
     caller's error, never silently treated as empty. readObject answers {} for no body at all. */
  const optionalBody = body;
  const seatId = who.human ? null : who.seat.id;
  const taskIn = (d: any, group?: Room): ts.TaskRow => {
    const t = ts.requireTask(d, familyId, r.tid as number);
    if (group && t.room_id !== group.id) throw ctx.err(404, 'no such task here', 'tid');
    return t;
  };

  /* ---------------------------------------------------------------- reads ---- */
  if (r.verb === 'list') {
    need('list', room);
    const status = q.get('status');
    if (status && !rules.validStatus(status)) throw ctx.err(400, 'status is open, in-progress, blocked or done', 'status');
    const group = q.get('group') ? groupByRef(q.get('group')) : null;
    const limit = rules.clampLimit(q.get('limit') ?? undefined);
    const tasks = table.withRoomDb((d) => ts.listTasks(d, familyId, { roomId: group?.id, status: status ?? undefined, limit }));
    return { tasks: tasks.map(view), group: group ? aliasOf(group.id) : null, limit };
  }
  if (r.verb === 'summary') {
    need('summary', room);
    const s = table.withRoomDb((d) => ts.summary(d, familyId, rooms.map((x) => ({ id: x.id }))));
    return { room: s.room, groups: s.groups.map((g) => ({ roomId: g.roomId, alias: aliasOf(g.roomId), linked: g.linked, pct: g.pct, open: g.open, needsYou: g.needsYou, focus: g.focus, activity: g.activity })) };
  }
  if (r.verb === 'timeline') {
    need('timeline', room);
    const hours = rules.clampHours(q.get('hours') ?? undefined);
    const only = q.get('group') ? [groupByRef(q.get('group'))] : rooms;
    const tl = table.withRoomDb((d) =>
      ts.timeline(d, familyId, only.map((x) => ({ id: x.id, alias: aliasOf(x.id) })), hours, Date.now(), (sid) => {
        const seat = table.getSeat(sid);
        return { handle: seat?.handle ?? sid, lead: rooms.some((x) => x.lead_seat === sid), state: seat ? ctx.seatState(seat) : 'gone' };
      }),
    );
    return tl;
  }
  if (r.verb === 'topics') {
    need('topics', room);
    const g = groupOf(q.get('group') || undefined);
    return { group: aliasOf(g.id), topics: table.withRoomDb((d) => ts.topicList(d, g.id)) };
  }

  /* --------------------------------------------------------------- writes ---- */
  if (r.verb === 'add') {
    const b = await body();
    let g = groupOf(b.group);
    let parentId: number | null = null;
    if (b.parent !== undefined && b.parent !== null) {
      /* a subtask lives in its PARENT's group, the same as `subtasks` */
      parentId = Number(b.parent);
      const par = table.withRoomDb((d) => ts.requireTask(d, familyId, parentId as number));
      if (b.group !== undefined && b.group !== null && groupByRef(b.group).id !== par.room_id) {
        throw ctx.err(400, 'a subtask lives in its parent\'s group; leave `group` out', 'group');
      }
      g = rooms.find((x) => x.id === par.room_id) ?? groupByRef(par.room_id);
    }
    need('add', g);
    const title = rules.validTitle(b.title);
    const text = rules.validBody(b.body);
    const priority = b.priority === undefined ? 0 : rules.validPriority(b.priority);
    const t = table.withRoomDb((d) => ts.addTask(d, { familyId, roomId: g.id, title, body: text, priority, parentId }));
    return { task: view(t) };
  }
  if (r.verb === 'focus') {
    const b = await body();
    const g = groupOf(b.group);
    need('focus', g);
    const topic = b.topic === undefined || b.topic === null || b.topic === 'none' ? null : Number(b.topic);
    table.withRoomDb((d) => ts.setFocus(d, g.id, topic));
    return { group: aliasOf(g.id), focus: topic };
  }
  if (r.verb === 'link' || r.verb === 'unlink') {
    const b = await optionalBody();
    const g = groupOf(b.group);
    need(r.verb, g);
    table.withRoomDb((d) => ts.setGroupLinked(d, familyId, g.id, r.verb === 'link'));
    return { group: { id: g.id, alias: aliasOf(g.id), linked: r.verb === 'link' } };
  }
  if (r.verb === 'set-linked') {
    need('set-linked', room);
    const b = await body();
    if (typeof b.linked !== 'boolean') throw ctx.err(400, 'linked is true or false', 'linked');
    const g = groupByRef(r.gid);
    table.withRoomDb((d) => ts.setGroupLinked(d, familyId, g.id, b.linked));
    return { group: { id: g.id, alias: aliasOf(g.id), linked: b.linked } };
  }
  if (r.verb === 'ask-lead') {
    const b = await body();
    const g = groupOf(b.group);
    need('ask-lead', g);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text || text.length > ASK_MAX) throw ctx.err(400, `text is 1 to ${ASK_MAX} characters`, 'text');
    const lead = g.lead_seat ? table.getSeat(g.lead_seat) : undefined;
    if (!lead) throw ctx.err(409, `the ${aliasOf(g.id)} group has no lead yet`, 'group');
    if (!who.human && lead.id === who.seat.id) throw ctx.err(409, 'you are that group\'s lead', 'group');
    /* the line reaches ONLY the lead it names: it is posted with LEAD-ONLY addressing (rooms.ts postLineAs `leadOnly`: only the leading @ list
       addresses, the same rule a reply gets), so no other seat, no @user, no @room and no @all in the text can be taken as an address, and the text
       is saved exactly as written (an email address keeps its @). Posted where the asker sits (a handle is a direct address from anywhere in the family). */
    ctx.askLead(room, who.human ? 'user' : { seatId: who.seat.id }, `@${lead.handle} ${text}`);
    return { asked: lead.handle };
  }
  if (r.topic !== undefined || r.verb === 'topic-add') {
    const b = r.verb === 'topic-delete' ? {} : await body();
    const g = groupOf(b.group ?? (q.get('group') || undefined));
    need(r.verb, g);
    const out = table.withRoomDb((d) => {
      if (r.verb === 'topic-add') ts.topicAdd(d, g.id, b.name);
      else if (r.verb === 'topic-rename') ts.topicRename(d, g.id, r.topic as number, b.name);
      else if (r.verb === 'topic-delete') ts.topicDelete(d, g.id, r.topic as number);
      else if (r.verb === 'topic-move') ts.topicMove(d, g.id, r.topic as number, Number(b.to));
      return ts.topicList(d, g.id);
    });
    return { group: aliasOf(g.id), topics: out };
  }

  /* ----------------------------------------------------- verbs on one task ---- */
  const b = await optionalBody();
  return table.withRoomDb((d) => {
    const t0 = taskIn(d);
    const g0 = table.getRoom(t0.room_id) ?? room;
    /* a task in an ARCHIVED group is the person's alone: no lead verb, no claim, nothing from a seat */
    if (!who.human && g0.state === 'archived') throw ctx.err(403, 'that group is archived; only the person acts on its tasks', 'group');
    need(r.verb, g0, t0);
    switch (r.verb) {
      case 'purge':
        ts.purge(d, familyId, t0.id);
        return { purged: t0.id };
      case 'claim':
        if (!seatId) throw ctx.err(400, 'a person gives work out (assign); only a seat claims it', 'verb');
        return { task: view(ts.claim(d, familyId, t0.id, seatId)) };
      case 'unclaim':
        return { task: view(ts.unclaim(d, familyId, t0.id)) };
      case 'status': {
        return { task: view(ts.setStatus(d, familyId, t0.id, b.status)) };
      }
      case 'progress': {
        const pct = rules.validPct(b.pct);
        return { task: view(ts.progress(d, familyId, t0.id, pct, rules.validNote(b.note), seatId)) };
      }
      case 'flag':
      case 'unflag':
        return { task: view(ts.setFlag(d, familyId, t0.id, r.verb === 'flag')) };
      case 'pin':
      case 'unpin':
        return { task: view(ts.setPinned(d, familyId, t0.id, r.verb === 'pin')) };
      case 'bug':
      case 'unbug':
        return { task: view(ts.setBug(d, familyId, t0.id, r.verb === 'bug')) };
      case 'priority':
        return { task: view(ts.setPriority(d, familyId, t0.id, rules.validPriority(b.priority))) };
      case 'subtasks':
        return { parent: t0.id, tasks: ts.addSubtasks(d, { familyId, parentId: t0.id, titles: b.titles }).map(view) };
      case 'move-to-topic':
        return { task: view(ts.moveToTopic(d, familyId, t0.id, b.topic === null || b.topic === undefined ? null : Number(b.topic))) };
      case 'assign': {
        const hasGroup = b.group !== undefined && b.group !== null;
        const hasSeat = b.seat !== undefined && b.seat !== null;
        if (hasGroup === hasSeat) throw ctx.err(400, 'assign takes exactly one of `group` (an alias) or `seat` (a handle)', 'to');
        if (hasGroup) {
          return { task: view(ts.assignToGroup(d, familyId, t0.id, groupByRef(b.group).id)) };
        }
        const handle = String(b.seat).trim().replace(/^@/, '').toLowerCase();
        const matches = rooms.flatMap((x) => table.listSeats(x.id)).filter((x) => x.handle === handle);
        if (!matches.length) throw ctx.err(404, 'no such seat here', 'seat');
        if (new Set(matches.map((m) => m.room_id)).size > 1) throw ctx.err(409, `@${handle} is in more than one group; assign to a group instead`, 'seat');
        const target = matches[0];
        ts.assignToGroup(d, familyId, t0.id, target.room_id);
        ts.unclaim(d, familyId, t0.id); // the new owner replaces the old one (also within the same group); closes the old claimer's stretch
        /* handing work to a seat: if it was in progress it goes back to open, so the new owner starts it themselves and the timeline never
           shows work the seat did not do (builder-two [ref]) */
        if (t0.status === 'in-progress') ts.setStatus(d, familyId, t0.id, 'open');
        return { task: view(ts.claim(d, familyId, t0.id, target.id)) };
      }
      default:
        throw ctx.err(404, 'unknown tasks verb', 'verb');
    }
  });
}

/** The agent door's per-ROUTE allow-list (design review [ref]: §4.1 is a list of routes, not a door): every task route EXCEPT the person-only ones
 *  (purge, set-linked), which a pane token never reaches. */
export function agentMayCall(method: string, rest: string[]): boolean {
  if (!tasksEnabled()) return false;
  const r = matchRoute(method, rest);
  return !!r && r.verb !== 'purge' && r.verb !== 'set-linked';
}
