// Tasks expanded (the web; the owner's go 2026-10-26, the design's Tasks §4 "On the web"): the page fills the room's area and
// draws its own header ("← Tasks" and the summary line), the three views (By % done | Timeline | By seat), the group
// chips with their open counts and plan icons, and for the two time views an hour axis with a "now" line and the legend.
// Pure: HTML strings from the engine's rows; every value from an agent goes through esc(); every position lands in
// data-l / data-w (percent numbers the page clamps and applies through CSSOM: the page's CSP has no inline styles).

import { esc, renderList } from './views.js';
import { seatGroups, quietWords, quietCount } from './seats.js';

const f2 = (x) => (Math.round(Math.min(1, Math.max(0, x)) * 10000) / 100).toFixed(2);
const LABEL_MIN = 0.09; // a stretch is labelled only when it is 9% of the axis or wider (the design's rule)
const LABEL_MIN_PHONE = 0.3; // on a phone only from 30% (the design's walk): the row's header already names the current task
const sm = (w) => (w < LABEL_MIN_PHONE ? ' sm' : ''); // preview.css hides an .sm label at phone width

// small inline icons (the page has no icon font); currentColor, aria-hidden
const svg = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="${d}"/></svg>`;
const I = {
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
  timeline: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H5V5h14v14zM7 7h7v2H7zm3 4h7v2h-7zm-3 4h6v2H7z',
  seats: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
  unlink: 'M17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1 0 1.43-.98 2.63-2.31 2.98l1.46 1.46C20.88 15.61 22 13.95 22 12c0-2.76-2.24-5-5-5zm-1 4h-2.19l2 2H16v-2zM2 4.27l3.11 3.11A4.991 4.991 0 0 0 2 12c0 2.76 2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1 0-1.59 1.21-2.9 2.76-3.07L8.73 11H8v2h2.73L13 15.27V17h1.73l4.01 4L20 19.74 3.27 3 2 4.27z',
  clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
};

/** "7 PM" … in the viewer's own clock, every whole hour inside the window (at most 13 labels). */
function hourTicks(from, to, hourFmt) {
  const out = [];
  const step = to - from > 12 * 3600e3 ? 2 : 1;
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  let t = d.getTime() + 3600e3;
  while (t < to && out.length < 13) {
    if (new Date(t).getHours() % step === 0) out.push({ at: t, label: hourFmt(t) });
    t += 3600e3;
  }
  return out;
}
const defaultHour = (t) => { const h = new Date(t).getHours(); return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); };

function axisHtml(from, to, hourFmt) {
  const span = to - from;
  const ticks = hourTicks(from, to, hourFmt).filter((k) => (to - k.at) / span > 0.07).map((k, i, all) => `<span class="tk${(all.length - 1 - i) % 2 ? ' odd' : ''}${(to - k.at) / span < 0.2 ? ' nearnow' : ''}" data-l="${f2((k.at - from) / span)}">${esc(k.label)}</span>`).join('');
  return `<div class="axis"><div class="lbl"></div><div class="ticks">${ticks}<span class="tk now" data-l="100.00">now</span></div></div>`;
}

const legend = () =>
  `<div class="legend"><span><i class="lg w"></i>working</span><span><i class="lg n"></i>needs you</span><span><i class="lg m"></i>lead set %</span><span><i class="lg q"></i>quiet</span></div>`;

/** The seat's dot: working, waiting on you, quiet (an empty ring), left (dotted), idle. */
function dot(r) {
  const cls = r.left ? 's-left' : r.waiting ? 's-wait' : r.working ? 's-on' : r.quietMs !== null ? 's-quiet' : 's-idle';
  return `<i class="dot ${cls}" aria-hidden="true"></i>`;
}

/** One seat's lane: work stretches (labelled "title · 65%" when wide enough), needs-you stretches, the hatched quiet stretch. */
function seatLane(r, from, to, pctOf) {
  const span = to - from;
  const fr = (v) => (Number(v) - from) / span;
  const end = (v) => (v === null || v === undefined ? to : v);
  const parts = [];
  for (const s of r.stretches) {
    const a = Math.max(0, fr(s.start));
    const b = Math.min(1, fr(end(s.end)));
    if (!(b > a)) continue;
    if (s.kind === 'needs') {
      const label = b - a >= LABEL_MIN ? '<span class="t">Waiting on you</span>' : '';
      parts.push(`<i class="st n${sm(b - a)}" data-l="${f2(a)}" data-w="${f2(b - a)}" title="${esc(s.title)} · waiting on you">${label}</i>`);
    } else {
      const p = pctOf(s.taskId);
      const text = s.title + (p !== null ? ' · ' + p + '%' : '');
      parts.push(`<i class="st w${sm(b - a)}" data-l="${f2(a)}" data-w="${f2(b - a)}" title="${esc(text)}">${b - a >= LABEL_MIN ? `<span class="t">${esc(text)}</span>` : ''}</i>`);
    }
  }
  if (r.quietFrom !== null) {
    const a = Math.max(0, fr(r.quietFrom));
    if (1 > a) parts.push(`<i class="st q" data-l="${f2(a)}" data-w="${f2(1 - a)}" title="${esc(quietWords(r.quietMs))}"></i>`);
  }
  return `<div class="lane">${parts.join('')}</div>`;
}

const marksHtml = (marks, from, to) =>
  marks.length ? `<div class="marks">${marks.map((m) => `<i class="mk" data-l="${f2((m - from) / (to - from))}"></i>`).join('')}</div>` : '';

/** By seat: one block per group, one row per seat under it (the lead first, a seat that left last and greyed). */
function renderBySeat(timeline, group, now, pctOf, hourFmt) {
  const from = Number(timeline.from);
  const to = Number(timeline.to);
  if (!(to > from)) return '';
  const sg = seatGroups(timeline, { group, now });
  if (!sg.groups.some((g) => g.rows.length)) {
    // the design's words: how the view fills (v1: stretches come from status changes), with the window's real length
    const hours = Math.max(1, Math.round((to - from) / 3600e3));
    return `<p class="none">No work in the last ${hours} ${hours === 1 ? 'hour' : 'hours'}. A seat's work shows here when it moves a task to in progress.</p>`;
  }
  const blocks = sg.groups.map((g) => {
    const head = `<div class="gh"><i class="dot grp" aria-hidden="true"></i><b>${esc(g.alias)}</b>${svg(g.linked ? I.link : I.unlink, 'i plan')}<span class="cnt">${g.rows.length} ${g.rows.length === 1 ? 'seat' : 'seats'}</span></div>`;
    const rows = g.rows.map((r) => {
      const tag = r.left ? '<span class="tag">left</span>' : r.lead ? '<span class="tag">lead</span>' : '';
      const quiet = r.quietMs !== null ? `<span class="quiet">${svg(I.clock)}${esc(quietWords(r.quietMs))}</span>` : '';
      const last = [...r.stretches].reverse().find((s) => s.kind === 'work');
      const cur = last ? `<span class="cur">${esc(last.title)}</span>` : '';
      const marks = r.lead ? marksHtml(g.marks, from, to) : '';
      return `<div class="sr${r.left ? ' left' : ''}${r.quietMs !== null ? ' is-quiet' : ''}" data-seat="${esc(r.handle)}">` +
        `<div class="who">${dot(r)}<span class="h">${esc(r.handle)}</span>${tag}${quiet}${cur}</div>` +
        `<div class="lt">${seatLane(r, from, to, pctOf)}${marks}</div></div>`;
    }).join('');
    return `<section class="grp">${head}${rows}</section>`;
  }).join('');
  return axisHtml(from, to, hourFmt) + `<div class="plot">${blocks}<i class="nowline" aria-hidden="true"></i></div>` + legend();
}

/** One lane of the Timeline (the room line or a group): working depth, needs-you, the lead's marks. */
function groupLane(lane, from, to) {
  const span = to - from;
  const fr = (v) => (Number(v) - from) / span;
  const end = (v) => (v === null || v === undefined ? to : v);
  const segs = (lane.segments || []).map((s) => {
    const a = Math.max(0, fr(s.start)); const b = Math.min(1, fr(end(s.end)));
    const n = Math.min(4, Math.max(1, Math.floor(Number(s.working) || 1)));
    return b > a ? `<i class="d n${n}" data-l="${f2(a)}" data-w="${f2(b - a)}"></i>` : '';
  }).join('');
  const needs = (lane.needs || []).map((s) => {
    const a = Math.max(0, fr(s.start)); const b = Math.min(1, fr(end(s.end)));
    return b > a ? `<i class="ns" data-l="${f2(a)}" data-w="${f2(b - a)}"></i>` : '';
  }).join('');
  return `<div class="lane gl">${segs}${needs}</div>` + marksHtml(lane.marks || [], from, to);
}

/** Timeline: the room line, then one lane per group with "2 working · 1 quiet" at its right. */
function renderTimelineX(timeline, summary, group, now, hourFmt) {
  const from = Number(timeline.from);
  const to = Number(timeline.to);
  if (!(to > from)) return '';
  const sg = seatGroups(timeline, { group, now });
  const counts = (g) => [g.working ? g.working + ' working' : '', g.quiet ? g.quiet + ' quiet' : ''].filter(Boolean).join(' · ');
  const all = Array.isArray(timeline.groups) ? timeline.groups : [];
  let blocks = '';
  if (!group) {
    const r = summary && summary.room ? summary.room : {};
    const linked = `${Number(r.linkedGroups) || 0} of ${Number(r.totalGroups) || 0} ${(Number(r.totalGroups) || 0) === 1 ? 'group' : 'groups'} linked`;
    blocks += `<section class="lanebox room"><div class="gh"><b>Room</b><span class="cnt">${esc(linked)}</span></div>${groupLane(timeline.room || {}, from, to)}</section>`;
  }
  for (const g of sg.groups) {
    const raw = all.find((x) => x && x.alias === g.alias) || {};
    blocks += `<section class="lanebox"><div class="gh"><i class="dot grp" aria-hidden="true"></i><b>${esc(g.alias)}</b>${svg(g.linked ? I.link : I.unlink, 'i plan')}` +
      `<span class="cnt">${g.rows.length} ${g.rows.length === 1 ? 'seat' : 'seats'}</span><span class="right">${esc(counts(g))}</span></div>${groupLane(raw, from, to)}</section>`;
  }
  return axisHtml(from, to, hourFmt) + `<div class="plot">${blocks}<i class="nowline" aria-hidden="true"></i></div>` + legend();
}

/**
 * The whole expanded page. st: the model's state {view, group, summary, tasks, timeline, error}; now: ms;
 * hourFmt: optional (t) => "7 PM" (tests pin it).
 */
export function renderExpanded(st, { now, hourFmt = defaultHour, back = false } = {}) {
  const s = st.summary && st.summary.room ? st.summary.room : null;
  const sg = st.timeline ? seatGroups(st.timeline, { group: st.group, now }) : { groups: [], quiet: 0 };
  const gsum = st.group && st.summary ? (st.summary.groups || []).find((g) => g.alias === st.group) : null;
  const base = gsum || s;
  const needs = base ? Number(base.needsYou) || 0 : 0;
  const sub = base ? [`${Number(base.open) || 0} open`, `${needs} ${needs === 1 ? 'needs' : 'need'} you`, quietCount(sg.quiet)].filter(Boolean).join(' · ') : '';
  // the full page is a tab (its own close) or, on a phone, sits under the host's "Back to the room" bar: no back arrow here
  const backBtn = back ? `<button type="button" class="ib back" data-a="back" aria-label="Back to the room" title="Back to the room">${svg(I.back)}</button>` : '';
  const head = `<header class="xh${back ? '' : ' noback'}">${backBtn}` +
    `<div class="xt"><h1>Tasks</h1><p class="sub">${esc(sub)}</p></div>` +
    `<div class="seg" role="group" aria-label="View">` +
    [['list', 'By % done', I.list], ['timeline', 'Timeline', I.timeline], ['seats', 'By seat', I.seats]]
      .map(([v, label, d]) => `<button type="button" data-view="${v}" aria-pressed="${st.view === v}">${svg(d)}<span>${label}</span></button>`).join('') +
    `</div></header>`;
  const groups = st.summary && Array.isArray(st.summary.groups) ? st.summary.groups : [];
  const chip = (alias, label, count, linked) =>
    `<button class="chip" type="button" data-group="${esc(alias || '')}" aria-pressed="${(st.group || '') === (alias || '') ? 'true' : 'false'}">` +
    `<span>${esc(label)}</span>${linked === null ? '' : svg(linked ? I.link : I.unlink, 'i plan')}<span class="n">${Number(count) || 0}</span></button>`;
  const chips = `<div class="chips">${chip(null, 'All', s ? s.open : 0, null)}${groups.map((g) => chip(g.alias, g.alias, g.open, !!g.linked)).join('')}</div>`;
  const error = st.error ? `<p class="err" role="alert">${esc(st.error)}</p>` : '';
  const pctById = new Map((st.tasks || []).filter((t) => Number.isInteger(t.id)).map((t) => [t.id, Number.isFinite(Number(t.pct)) ? Math.round(Number(t.pct)) : null]));
  const pctOf = (id) => (pctById.has(id) ? pctById.get(id) : null);
  let body = '';
  if (st.view === 'seats') body = st.timeline ? renderBySeat(st.timeline, st.group, now, pctOf, hourFmt) : '';
  else if (st.view === 'timeline') body = st.timeline ? renderTimelineX(st.timeline, st.summary, st.group, now, hourFmt) : '';
  else body = st.error && !(st.tasks || []).length ? '' : renderList(st.tasks, { limit: 50 });
  return head + chips + error + `<div class="xbody view-${esc(st.view)}">${body}</div>`;
}
