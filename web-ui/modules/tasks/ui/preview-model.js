// Tasks preview and window: the model behind the page (the design's design, styleguide/mockups/
// workbench-tasks-tool). It reads through the bridge's call(verb, input) only: the summary, plus the
// by-% list or the timeline for the chosen group. rooms.tasks refreshes it, throttled. A refused read
// shows the engine's own words and keeps the last good data; a revoked bridge (the preview was closed)
// stops quietly. No DOM: html() returns the markup, built by views.js (everything escaped there).

import { renderHeader, renderList, renderTimeline, renderRoomTasks, esc } from './views.js';
import { renderExpanded } from './expanded.js';

const LIST_LIMIT = 50;
const TIMELINE_HOURS = 8;

/** "Last 8 hours · stretches of work, start to end", from the timeline's own from and to, in half hours (her mockup's words). */
function timelineCaption(t) {
  if (!t || !Number.isFinite(t.from) || !Number.isFinite(t.to) || t.to <= t.from) return '';
  const halves = Math.max(1, Math.round((t.to - t.from) / 1800e3));
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1 ? '½' : '';
  const span = halves === 2 ? 'hour' : halves === 1 ? '½ hour' : `${whole || ''}${half} hours`;
  return `<p class="rf">Last ${span} · stretches of work, start to end</p>`;
}

// expanded: the web's page over the room's area (the design's Tasks §4): its own header, three views (By seat too), the
// timeline always read (the header's quiet count) and the list for the % on each stretch
export function createPreviewModel({ call, group = null, now = () => Date.now(), minGapMs = 2000, source = null, expanded = false } = {}) {
  let doCall = call;
  const st = { view: 'list', group: group || null, summary: null, tasks: [], timeline: null, error: null, closed: false, roomTasks: null };
  const roomTasks = source === 'room-tasks'; // revision 11: the read-only Room Tasks (Vikunja) view
  let lastRead = -Infinity;
  let pending = false;

  function fail(e) {
    if (e && e.kind === 'revoked') {
      st.closed = true; // the app closed this view: stop, and say nothing
      return;
    }
    st.error = e && e.kind === 'refused' && e.message ? String(e.message) : "Couldn't load tasks. Try again in a moment."; // the design, Fix A
  }

  async function load() {
    if (st.closed) return;
    lastRead = now();
    pending = false;
    const g = st.group ? { group: st.group } : {};
    if (roomTasks) {
      try {
        const r = await doCall('room-summary', {});
        if (!r || r.ok !== true) throw Object.assign(new Error('unavailable'), { kind: 'transport' });
        st.roomTasks = r;
        st.error = null;
      } catch (e) {
        if (e && e.kind === 'revoked') st.closed = true;
        else st.error = "Couldn't load Room Tasks. Try again in a moment.";
      }
      return;
    }
    try {
      if (expanded) {
        const wantList = st.view !== 'timeline';
        const [summary, timeline, list] = await Promise.all([doCall('summary', {}), doCall('timeline', { ...g, hours: TIMELINE_HOURS }), wantList ? doCall('list', { ...g, limit: LIST_LIMIT }) : null]);
        st.summary = summary;
        st.timeline = timeline;
        if (wantList) st.tasks = (list && Array.isArray(list.tasks)) ? list.tasks : [];
      } else if (st.view === 'timeline') {
        const [summary, timeline] = await Promise.all([doCall('summary', {}), doCall('timeline', { ...g, hours: TIMELINE_HOURS })]);
        st.summary = summary;
        st.timeline = timeline;
      } else {
        const [summary, list] = await Promise.all([doCall('summary', {}), doCall('list', { ...g, limit: LIST_LIMIT })]);
        st.summary = summary;
        st.tasks = (list && Array.isArray(list.tasks)) ? list.tasks : [];
      }
      st.error = null;
    } catch (e) {
      fail(e);
    }
  }

  return {
    load,
    state: () => ({ ...st }),
    /** Swap the transport (tests; a re-handover after the host reconnects the frame). */
    useCall(fn) {
      doCall = fn;
    },
    async setView(v) {
      st.view = v === 'timeline' || (expanded && v === 'seats') ? v : 'list';
      await load();
    },
    async setGroup(g) {
      st.group = g || null;
      await load();
    },
    /** rooms.tasks from the host: re-read now, or once the gap has passed (flush). */
    async changed() {
      if (st.closed) return;
      if (now() - lastRead >= minGapMs) await load();
      else pending = true;
    },
    /** The scheduled re-read: true when it read (the page repaints then), false when nothing was due. */
    async flush() {
      if (!pending || st.closed || now() - lastRead < minGapMs) return false;
      await load();
      return true;
    },
    /** opts.window: the window surface, which adds the timeline's caption under the lanes. */
    html(opts = {}) {
      if (roomTasks) {
        const error = st.error ? `<p class="err" role="alert">${esc(st.error)}</p>` : '';
        return error + (st.roomTasks ? renderRoomTasks(st.roomTasks) : '');
      }
      const groups = (st.summary && Array.isArray(st.summary.groups)) ? st.summary.groups : [];
      const chip = (alias, label) =>
        `<button class="chip" type="button" data-group="${esc(alias || '')}" aria-pressed="${(st.group || '') === (alias || '') ? 'true' : 'false'}">${esc(label)}</button>`;
      const chips = `<div class="chips">${chip(null, 'All')}${groups.map((g) => chip(g.alias, g.alias)).join('')}</div>`;
      if (expanded) return renderExpanded(st, { now: now(), hourFmt: opts.hourFmt });
      const view = st.view;
      const views = `<div class="seg" role="group" aria-label="View">` +
        `<button type="button" data-view="list" aria-pressed="${view === 'list'}">By % done</button>` +
        `<button type="button" data-view="timeline" aria-pressed="${view === 'timeline'}">Timeline</button></div>`;
      // an empty list says "No open tasks yet." only after a load that worked; with an error nobody knows
      const body = view === 'timeline' ? renderTimeline(st.timeline, st.group) : st.error && !st.tasks.length ? '' : renderList(st.tasks, { limit: 8 });
      const error = st.error ? `<p class="err" role="alert">${esc(st.error)}</p>` : '';
      const caption = opts.window && view === 'timeline' ? timelineCaption(st.timeline) : '';
      return views + chips + renderHeader(st.summary, st.group) + error + `<div class="body">${body}</div>` + caption;
    },
  };
}
