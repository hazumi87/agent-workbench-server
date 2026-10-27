// Tasks preview and window: pure renderers from the engine's rows (the design notes §4-§6) to
// HTML strings, after the design's design (the tasks-tool mockup).
// Titles, notes and handles come from agents: every value goes through esc(), and every number that
// lands in a style is clamped first, because this page can call write verbs as the person.

import { sortForList } from './core.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));
const pct = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
};
// a fraction 0..1 as a percent number with two decimals; the page applies it through CSSOM (revision 7, item 3)
const f2 = (x) => (Math.round(x * 10000) / 100).toFixed(2);

/** The by-% list. opts.limit caps the rows (the preview shows 8, the window more). */
export function renderList(tasks, opts = {}) {
  const limit = opts.limit ?? 50;
  const all = sortForList(tasks || []);
  if (!all.length) return '<p class="none">No open tasks yet.</p>'; // the design, Fix B
  const shown = all.slice(0, limit);
  const rows = shown.map((t) => {
    const p = pct(t.pct);
    const state = t.flagged
      ? `<div class="bar"><span class="needchip">Needs you</span></div>`
      : t.status === 'open' && p === 0
        ? `<div class="meta">Not started</div>`
        : `<div class="bar"><div class="track"><i data-w="${p}"></i></div><b>${p}%</b></div>`;
    const owner = t.claimed_by ? esc(t.claimed_by) : 'unclaimed';
    return (
      `<div class="row${t.flagged ? ' need' : ''}" data-tid="${Number.isInteger(t.id) ? t.id : 0}">` +
      `<div class="tt">${esc(t.title)}</div>` +
      `<div class="meta"><span class="gp">${esc(t.group && t.group.alias)}</span><span class="o">${owner}</span>` +
      `${t.from_group ? `<span class="o">from ${esc(t.from_group)}</span>` : ''}</div>` +
      state +
      `</div>`
    );
  });
  const more = all.length - shown.length;
  return rows.join('') + (more > 0 ? `<button class="more" data-a="more">Show ${more} more</button>` : '');
}

/** The header numbers for the room (group null) or one group. */
export function renderHeader(summary, group) {
  if (!summary || !summary.room) {
    return '';
  }
  const g = group ? (summary.groups || []).find((x) => x.alias === group) : null;
  const s = g || summary.room;
  const needs = Number(s.needsYou) || 0;
  const plan = g ? (g.linked ? 'on the room plan' : 'on its own plan') : `${Number(summary.room.linkedGroups) || 0} of ${Number(summary.room.totalGroups) || 0} ${(Number(summary.room.totalGroups) || 0) === 1 ? 'group' : 'groups'} on the room plan`;
  return (
    `<div class="sum">` +
    `<div><b>${Number(s.open) || 0}</b><small>open</small></div>` +
    `<div><b class="${needs ? 'err' : ''}">${needs}</b><small>need you</small></div>` +
    `<div><b class="f">${esc(s.focus || '–')}</b><small>focus</small></div>` + // never headless: the room card's dash
    `</div><div class="plan">${esc(plan)}</div>`
  );
}

function laneHtml(name, lane, from, to) {
  const t0 = Number(from);
  const t1 = Number(to);
  const span = t1 - t0;
  if (!lane || !(span > 0)) {
    return '';
  }
  const fr = (v) => Math.min(1, Math.max(0, (Number(v) - t0) / span));
  const end = (v) => (v === null || v === undefined ? t1 : v);
  const segs = (lane.segments || [])
    .map((s) => {
      const a = fr(s.start);
      const b = fr(end(s.end));
      const n = Math.min(8, Math.max(1, Math.floor(Number(s.working) || 1)));
      return b > a ? `<i class="d n${n}" data-l="${f2(a)}" data-w="${f2(b - a)}"></i>` : '';
    })
    .join('');
  const needs = (lane.needs || [])
    .map((s) => {
      const a = fr(s.start);
      const b = fr(end(s.end));
      return b > a ? `<i class="ns" data-l="${f2(a)}" data-w="${f2(b - a)}"></i>` : '';
    })
    .join('');
  const marks = (lane.marks || []).map((m) => `<i class="mk" data-l="${f2(fr(m))}"></i>`).join('');
  return `<div class="ln" data-lane="${esc(name)}"><div class="lh"><span class="n">${esc(name === 'room' ? 'Room' : name)}</span></div><div class="lane">${segs}${needs}</div><div class="marks">${marks}</div></div>`;
}

/** The timeline: for a group, its own lane; for the room, the room line then each linked group's. */
export function renderTimeline(timeline, group) {
  if (!timeline) {
    return '';
  }
  const { from, to } = timeline;
  const groups = timeline.groups || [];
  let html;
  let dropped = false;
  if (group) {
    const g = groups.find((x) => x.alias === group);
    html = g ? laneHtml(g.alias, g, from, to) : '';
    dropped = !!(g && (g.dropped || g.truncated));
  } else {
    html = laneHtml('room', timeline.room, from, to) + groups.filter((g) => g.linked).map((g) => laneHtml(g.alias, g, from, to)).join('');
    dropped = !!(timeline.room && (timeline.room.dropped || timeline.room.truncated)) || groups.some((g) => g.dropped || g.truncated);
  }
  return html + (dropped ? `<div class="note">Some older activity not shown.</div>` : '');
}

/**
 * Revision 11: the Room Tasks (Vikunja) view, read only, from room-tasks' summary.json (counts and topics; the
 * verb carries no task text by design): the room's open and done counts and its focus, then a row per topic
 * with its open and done counts, then the pinned tasks with no topic and the unpinned ones when there are any.
 */
export function renderRoomTasks(s) {
  const room = s && s.room ? s.room : {};
  if (!(Number(room.total) > 0)) {
    return `<p class="none">No Room Tasks yet.</p>`;
  }
  const head = `<div class="sum">` +
    `<div><b>${Number(room.open) || 0}</b><small>open</small></div>` +
    `<div><b>${Number(room.done) || 0}</b><small>done</small></div>` +
    `<div><b class="f">${esc(s.focus && s.focus.name ? s.focus.name : '–')}</b><small>focus</small></div>` +
    // the design : the server's name as main knows it, never the tool's internal name
    `</div><div class="plan">${typeof s.serverName === 'string' && s.serverName ? 'Room Tasks on ' + esc(s.serverName) : 'Room Tasks'}</div>`;
  const row = (name, c, focus, dim) => `<div class="row${dim ? ' dim' : ''}"><span class="tt">${esc(name)}${focus ? ' · focus' : ''}</span>` +
    `<div class="meta">${Number(c && c.open) || 0} open · ${Number(c && c.done) || 0} done</div></div>`;
  const rows = (Array.isArray(s.topics) ? s.topics : []).map((t) => row(t.name, t.counts, t.focus));
  if (s.loose && Number(s.loose.total) > 0) rows.push(row('Pinned, no topic', s.loose, false));
  if (s.unpinned && Number(s.unpinned.total) > 0) rows.push(row('Not pinned', s.unpinned, false, true)); // last, dimmer
  return head + `<div class="body">${rows.join('')}</div>`;
}

