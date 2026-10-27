// A frame's Tasks request, admitted in the app page before it goes to main (the design notes revision 7,
// item 4, C2, C3). The envelope is exactly {id, verb, input}; the C3 budgets are mirrored here so a flood is
// refused early (main holds the same buckets and is the authority); the frame link's binding must be current;
// the verb's grant must be held; purge first asks the person in the host's own dialog, then main mints a
// single-use approval the call carries. Main's reply maps to the frame's shapes, and a reply that arrives after
// the binding went stale is `revoked`. No imports: loaded by tests and by the renderer alike.

export const REQUEST_LIMITS = Object.freeze({
  inflightPerFrame: 8, requestBytes: 16 * 1024,
  moduleRate: 20, moduleBurst: 40, moduleBytesPerSec: 256 * 1024,
  appRate: 60, appBurst: 120, appBytesPerSec: 1024 * 1024,
  replyBytes: 256 * 1024,
});

// The grant of each verb in main's fixed map (src/module-tasks-verbs.js; a test keeps them equal).
const READS = ['list', 'summary', 'timeline', 'topics', 'room-summary']; // room-summary: revision 11, through the panel proxy
const WRITES = ['add', 'status', 'progress', 'assign', 'flag', 'unflag', 'priority', 'subtasks', 'pin', 'unpin', 'bug', 'unbug',
  'topic-add', 'topic-rename', 'topic-move', 'topic-delete', 'move-to-topic', 'focus', 'link', 'unlink', 'ask-lead'];
export function grantOf(verb) {
  if (typeof verb !== 'string') return null;
  if (READS.includes(verb)) return 'rooms.tasks.read';
  if (WRITES.includes(verb)) return 'rooms.tasks.write';
  return verb === 'purge' ? 'rooms.tasks.delete' : null;
}

/**
 * the design's delete confirmation (Client ). facts: {title, subtasks, truncated} read from the engine, or
 * null. → {title, quoted, lines}: the quoted task title on its own line (the dialog clamps it to two lines),
 * then "It will be deleted…", the subtask sentence when there are subtasks (or when the count may be cut
 * off), and "This can't be undone." last. An unreadable task gets one sentence and no quoted line.
 */
export function deleteDialog(facts) {
  const title = 'Delete this task?';
  if (!facts || typeof facts.title !== 'string' || !facts.title) {
    // "This can't be undone." is always its own last line (the design, Fix D)
    return { title, quoted: null, lines: ['This task will be deleted for everyone in this room. Any subtasks will be deleted too.', "This can't be undone."] };
  }
  const lines = ['It will be deleted for everyone in this room.'];
  const n = facts.subtasks;
  if (Number.isInteger(n) && n > 0) lines.push(n === 1 ? 'Its 1 subtask will be deleted too.' : 'Its ' + n + ' subtasks will be deleted too.');
  else if (facts.truncated || !Number.isInteger(n)) lines.push('Any subtasks will be deleted too.');
  lines.push("This can't be undone.");
  return { title, quoted: '\u201c' + facts.title + '\u201d', lines };
}

const ENVELOPE_KEYS = ['id', 'input', 'verb'];
// a plain object from any realm: no prototype, or a prototype that is itself a root (some realm's
// Object.prototype); class instances and Object.create(other) are not plain
const isPlain = (o) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const p = Object.getPrototypeOf(o);
  return p === null || Object.getPrototypeOf(p) === null;
};
// UTF-8 bytes of the JSON, with what every realm has (a lone surrogate throws: refused as too big)
const bytesOf = (v) => {
  try { return encodeURIComponent(JSON.stringify(v)).replace(/%[0-9A-F]{2}/g, 'x').length; } catch { return Infinity; }
};

function bucket(rate, capacity, now) {
  let level = capacity;
  let at = now();
  return {
    has(n) { const t = now(); level = Math.min(capacity, level + ((t - at) / 1000) * rate); at = t; return level >= n; },
    take(n) { level -= n; },
  };
}

/**
 * deps: target(binding) → {moduleId, gen, roomId} | null · current(binding) → bool · hasGrant(binding, grant) → bool · call(a) → main's reply · approve(a) → {ok, approval}
 * · confirm(spec, signal) → Promise<bool> (the host's dialog; the signal aborts it) · now (tests).
 * handle(binding, owner, msg, reply) answers the frame through reply(...) exactly once (or never, for a
 * message without a usable id).
 */
export function createToolRequests(deps) {
  const now = deps.now || (() => Date.now()); // the hooks are read when used
  const inflight = new Map(); // owner -> count
  const confirming = new Map(); // owner -> AbortController of its open delete dialog (cancel() aborts it)
  const mods = new Map();
  const app = { count: bucket(REQUEST_LIMITS.appRate, REQUEST_LIMITS.appBurst, now), bytes: bucket(REQUEST_LIMITS.appBytesPerSec, REQUEST_LIMITS.appBytesPerSec, now) };
  const mod = (id) => {
    if (!mods.has(id)) mods.set(id, { count: bucket(REQUEST_LIMITS.moduleRate, REQUEST_LIMITS.moduleBurst, now), bytes: bucket(REQUEST_LIMITS.moduleBytesPerSec, REQUEST_LIMITS.moduleBytesPerSec, now) });
    return mods.get(id);
  };
  const refused = (id, status, error, field) => ({ id, ok: false, kind: 'refused', status, error, field: field ?? null });

  function fromMain(id, r) {
    if (!r || typeof r !== 'object') return { id, ok: false, kind: 'transport' };
    if (r.ok === true) return { id, ok: true, body: r.body === undefined ? null : r.body };
    if (r.kind === 'refused') return refused(id, Number.isInteger(r.status) ? r.status : 400, typeof r.error === 'string' ? r.error : 'The room refused that.', typeof r.field === 'string' ? r.field : null);
    if (r.kind === 'slow') return { id, ok: false, kind: 'slow' };
    if (r.code === 'account-changed') return { id, ok: false, kind: 'revoked' };
    return { id, ok: false, kind: 'transport' };
  }

  // The task's title and subtask count, read from the engine through the same admitted path (open tasks,
  // then done ones); null when it cannot be found. The page never supplies them.
  async function readTask(t, owner, tid) {
    const rows = [];
    let truncated = false;
    for (const input of [{ limit: 200 }, { status: 'done', limit: 200 }]) {
      let r = null;
      try { r = await deps.call({ moduleId: t.moduleId, gen: t.gen, owner, roomId: t.roomId, verb: 'list', input }); } catch { r = null; }
      const tasks = r && r.ok === true && r.body && Array.isArray(r.body.tasks) ? r.body.tasks : [];
      if (tasks.length >= 200) truncated = true;
      rows.push(...tasks); // both reads always: a task's subtasks may be open or done
    }
    const task = rows.find((x) => x && x.id === tid);
    if (!task || typeof task.title !== 'string') return null;
    return { title: task.title, subtasks: rows.filter((x) => x && x.parent_id === tid).length, truncated };
  }

  async function run(binding, owner, msg) {
    const { id, verb, input } = msg;
    const grant = grantOf(verb);
    if (!grant) return refused(id, 400, "That isn't a Tasks action.", 'verb');
    const t = deps.target(binding); // the host's view of the opaque binding: {moduleId, gen, roomId}
    if (!t || !deps.current(binding)) return { id, ok: false, kind: 'revoked' };
    if (!deps.hasGrant(binding, grant)) return refused(id, 403, "This tool isn't allowed to do that.", 'verb');
    const a = { moduleId: t.moduleId, gen: t.gen, owner, roomId: t.roomId, verb, input };
    if (grant === 'rooms.tasks.delete') {
      if (confirming.has(owner)) return { id, ok: false, kind: 'slow' };
      const ac = new AbortController();
      confirming.set(owner, ac);
      // still the same view, still allowed: checked after every await (a builder, Client )
      const still = () => !ac.signal.aborted && deps.current(binding) && deps.hasGrant(binding, grant);
      // the controller stays registered through the approval AND the dispatch, so cancel(owner) can stop the delete
      // until the purge call itself goes out; it is released only when the whole operation ends
      try {
        let yes = false;
        try {
          const facts = deps.hasGrant(binding, 'rooms.tasks.read') ? await readTask(t, owner, input.tid) : null;
          if (!still()) return { id, ok: false, kind: 'revoked' }; // never open an old room's dialog
          yes = (await deps.confirm(deleteDialog(facts), ac.signal)) === true;
        } catch { yes = false; }
        if (!still()) return { id, ok: false, kind: 'revoked' };
        if (!yes) return refused(id, 403, 'You cancelled the delete.', null);
        const ok = await Promise.resolve().then(() => deps.approve({ ...a })).catch(() => null);
        if (!still()) return { id, ok: false, kind: 'revoked' }; // a stale or revoked approval never reaches the engine
        if (!ok || ok.ok !== true || typeof ok.approval !== 'string') return refused(id, 403, "The app couldn't confirm that delete.", null);
        a.approval = ok.approval;
        return await dispatch(binding, a, id, still);
      } finally {
        if (confirming.get(owner) === ac) confirming.delete(owner);
      }
    }
    return dispatch(binding, a, id, () => true);
  }

  // the one call to main; for purge, `still` is read again right before it goes out
  async function dispatch(binding, a, id, still) {
    if (!still()) return { id, ok: false, kind: 'revoked' };
    let r;
    try { r = await deps.call(a); } catch { r = null; }
    if (!deps.current(binding)) return { id, ok: false, kind: 'revoked' }; // a late reply for a view that is gone
    return fromMain(id, r);
  }

  return {
    /** The frame link for owner ended (revoked, closed, a room switch): an open delete dialog closes and answers no. */
    cancel(owner) {
      const ac = confirming.get(owner);
      if (ac) ac.abort();
    },
    handle(binding, owner, msg, reply) {
      if (!msg || typeof msg !== 'object' || !Number.isSafeInteger(msg.id) || msg.id < 1) return; // nothing to answer to
      const id = msg.id;
      const keys = Object.keys(msg).sort();
      if (!isPlain(msg) || keys.length !== 3 || keys.some((k, i) => k !== ENVELOPE_KEYS[i]) || typeof msg.verb !== 'string' || !isPlain(msg.input)) {
        reply(refused(id, 400, 'Not a Tasks request.', 'input'));
        return;
      }
      const n = bytesOf(msg);
      const t = deps.target(binding);
      const m = mod(String(t ? t.moduleId : ''));
      const busy = inflight.get(owner) || 0;
      if (n > REQUEST_LIMITS.requestBytes || busy >= REQUEST_LIMITS.inflightPerFrame || !m.count.has(1) || !app.count.has(1) || !m.bytes.has(n) || !app.bytes.has(n)) {
        reply({ id, ok: false, kind: 'slow' });
        return;
      }
      m.count.take(1); app.count.take(1); m.bytes.take(n); app.bytes.take(n);
      inflight.set(owner, busy + 1);
      run(binding, owner, msg).then(reply, () => reply({ id, ok: false, kind: 'transport' })).finally(() => {
        const left = (inflight.get(owner) || 1) - 1;
        if (left > 0) inflight.set(owner, left); else inflight.delete(owner);
      });
    },
  };
}
