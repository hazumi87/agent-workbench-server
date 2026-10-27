/**
 * CHATTER REGULATION, phase 1 [chatter] (Owner 2026-10-06): agents were spending
 * turns on chatter — a lead re-telling the person what a worker had just told
 * him, runner hand-offs cross-posted into a sibling room, a Codex pane typed
 * 38 fabric DMs in a day (each one a paid turn). Measure, compare to a
 * threshold, list what crossed it with examples, so a rule can later be judged
 * by the same numbers.
 *
 * PURE: rows in (table.chatterSource), report out. No table, no clock, no log.
 * The quiet switch's matching rule lives here too, for the same reason.
 */

export interface ChatterLine {
  id: number;
  room_id: string;
  room_name: string;
  ts: number;
  author: string;
  kind: string;
  body: string;
  /** The badge's own "to me" predicate (store TO_ME_SQL), 1/0. */
  to_person: number | boolean;
  /** The stored address (a handle, 'room', 'lead', the person's handle) or null [shape]. */
  target?: string | null;
}
export interface ChatterSource {
  lines: ChatterLine[];
  xposts: Array<{ line_id: number; author: string; ts: number; room_id: string }>;
  /** pane_chat user turns that carry a typed fabric frame (hook-delivered panes). */
  fabricTurns: Array<{ paneid: string; slug: string | null; ts: number; text: string }>;
  events: Array<{ ts: number; kind: string; paneid: string | null; slug: string | null; from_slug: string | null; env_id: string | null }>;
}
export interface Thresholds {
  /** to-person lines per person line, per room. */
  toPersonRatio: number;
  /** fabric DMs into one pane in any 60-minute window, all senders. */
  dmsPerHour: number;
  /** echo pairs per (room, seat). 0 = any pair is a finding. */
  echoes: number;
  /** cross-post copies per seat per 24 h (scaled to the window). */
  xpostsPerDay: number;
  /** same-author repeats per (room, seat). */
  repeats: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { toPersonRatio: 3, dmsPerHour: 6, echoes: 0, xpostsPerDay: 20, repeats: 0 };

/** How close two lines must be (overlap of their word sets, over the smaller set). */
export const ECHO_SIMILARITY = 0.6;
export const REPEAT_SIMILARITY = 0.8;
export const ECHO_WINDOW_MS = 15 * 60 * 1000;
export const REPEAT_WINDOW_MS = 60 * 60 * 1000;
/** A line with fewer distinct words than this is never compared ("ok", "on it"). */
const MIN_WORDS = 5;
const HOUR = 60 * 60 * 1000;

export interface Finding {
  kind: 'to_person_ratio' | 'dm_rate' | 'echo' | 'repeat' | 'xpost' | 'refused' | 'watched';
  room?: { id: string; name: string };
  seat?: string;
  pane?: { paneid: string; slug: string | null };
  value: number;
  threshold: number;
  examples: unknown[];
}

/** Lowercased distinct words of 3+ letters/digits, @mentions dropped. */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/@[a-z0-9_-]+/g, ' ').split(/[^a-z0-9]+/)) {
    if (w.length >= 3) {
      out.add(w);
    }
  }
  return out;
}

/** |a ∩ b| / min(|a|, |b|); 0 when either side is too short to judge. */
export function similarity(a: Set<string>, b: Set<string>): number {
  const small = a.size <= b.size ? a : b;
  const big = small === a ? b : a;
  if (small.size < MIN_WORDS) {
    return 0;
  }
  let n = 0;
  for (const w of small) {
    if (big.has(w)) {
      n++;
    }
  }
  return n / small.size;
}

const FABRIC_FRAME = /\[fabric · @([^ ·\]]+) · [^\]]*?(?: · id:([^ \]]+))?\]/g;

/** Every typed fabric frame in one pane_chat turn (a held batch carries several). */
export function fabricFrames(text: string): Array<{ from: string; id: string | null }> {
  return [...text.matchAll(FABRIC_FRAME)].map((m) => ({ from: m[1], id: m[2] ?? null }));
}

const snip = (s: string): string => (s.length > 100 ? s.slice(0, 97) + '…' : s);

/** The most events inside any `width`-ms window (ts sorted ascending). */
function maxInWindow(ts: number[], width: number): number {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < ts.length; hi++) {
    while (ts[hi] - ts[lo] >= width) {
      lo++;
    }
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

export function report(src: ChatterSource, o: { hours: number; thresholds?: Partial<Thresholds>; quiet?: string[] }) {
  const th: Thresholds = { ...DEFAULT_THRESHOLDS, ...(o.thresholds ?? {}) };
  const findings: Finding[] = [];
  const lines = [...src.lines].sort((a, b) => a.id - b.id);
  const isAgent = (a: string): boolean => a !== 'user' && a !== 'room' && a !== 'concierge';

  /* ---- per room: the person's lines vs lines addressed to the person ---- */
  const rooms = new Map<string, { room_id: string; name: string; person_lines: number; to_person: number; ratio: number; to_ids: number[] }>();
  for (const l of lines) {
    const r = rooms.get(l.room_id) ?? { room_id: l.room_id, name: l.room_name, person_lines: 0, to_person: 0, ratio: 0, to_ids: [] };
    rooms.set(l.room_id, r);
    if (l.author === 'user') {
      r.person_lines++;
    } else if (l.to_person) {
      r.to_person++;
      r.to_ids.push(l.id);
    }
  }
  for (const r of rooms.values()) {
    /* No line from the person at all counts as one, so a room he never spoke in is still measured. */
    r.ratio = Math.round((r.to_person / Math.max(1, r.person_lines)) * 100) / 100;
    if (r.ratio > th.toPersonRatio) {
      findings.push({ kind: 'to_person_ratio', room: { id: r.room_id, name: r.name }, value: r.ratio, threshold: th.toPersonRatio, examples: r.to_ids.slice(-5) });
    }
  }

  /* ---- per seat author: lines, to-person lines, cross-post copies, echoes, repeats ---- */
  const seats = new Map<string, { author: string; lines: number; to_person: number; xpost_copies: number; echoes: number; repeats: number }>();
  const seat = (a: string) => {
    let s = seats.get(a);
    if (!s) {
      s = { author: a, lines: 0, to_person: 0, xpost_copies: 0, echoes: 0, repeats: 0 };
      seats.set(a, s);
    }
    return s;
  };
  const bag = new Map<number, Set<string>>();
  for (const l of lines) {
    if (!isAgent(l.author)) {
      continue;
    }
    const s = seat(l.author);
    s.lines++;
    if (l.to_person) {
      s.to_person++;
    }
    bag.set(l.id, words(l.body));
  }
  for (const x of src.xposts) {
    if (isAgent(x.author)) {
      seat(x.author).xpost_copies++;
    }
  }
  const xLimit = Math.round(th.xpostsPerDay * (o.hours / 24) * 100) / 100;
  for (const s of seats.values()) {
    if (s.xpost_copies > xLimit) {
      findings.push({
        kind: 'xpost',
        seat: s.author,
        value: s.xpost_copies,
        threshold: xLimit,
        examples: src.xposts.filter((x) => x.author === s.author).slice(-5).map((x) => x.line_id),
      });
    }
  }
  /* ECHO: a line that says again what a DIFFERENT seat told the person in the same room
     shortly before (the lead re-telling a worker's report). REPEAT: a seat saying
     again what it already said in that room within the hour. Each line counts once. */
  const echoes = new Map<string, { room: ChatterLine; seat: string; pairs: unknown[] }>();
  const repeats = new Map<string, { room: ChatterLine; seat: string; pairs: unknown[] }>();
  const note = (m: typeof echoes, l: ChatterLine, of: ChatterLine, sim: number) => {
    const k = `${l.room_id} ${l.author}`;
    const e = m.get(k) ?? { room: l, seat: l.author, pairs: [] };
    m.set(k, e);
    e.pairs.push({ line: l.id, of: of.id, of_author: of.author, similarity: Math.round(sim * 100) / 100, text: snip(l.body) });
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const lw = bag.get(l.id);
    if (!lw) {
      continue;
    }
    let echoed = false;
    let repeated = false;
    for (let j = i - 1; j >= 0 && !(echoed && repeated); j--) {
      const m = lines[j];
      const gap = l.ts - m.ts;
      if (gap > REPEAT_WINDOW_MS) {
        break;
      }
      if (m.room_id !== l.room_id || !isAgent(m.author)) {
        continue;
      }
      const mw = bag.get(m.id)!;
      if (!echoed && m.author !== l.author && m.to_person && gap <= ECHO_WINDOW_MS) {
        const sim = similarity(lw, mw);
        if (sim >= ECHO_SIMILARITY) {
          note(echoes, l, m, sim);
          echoed = true;
        }
      }
      if (!repeated && m.author === l.author) {
        const sim = similarity(lw, mw);
        if (sim >= REPEAT_SIMILARITY) {
          note(repeats, l, m, sim);
          repeated = true;
        }
      }
    }
  }
  for (const [m, kind, limit] of [
    [echoes, 'echo', th.echoes],
    [repeats, 'repeat', th.repeats],
  ] as const) {
    for (const e of m.values()) {
      const s = seat(e.seat);
      if (kind === 'echo') {
        s.echoes += e.pairs.length;
      } else {
        s.repeats += e.pairs.length;
      }
      if (e.pairs.length > limit) {
        findings.push({ kind, room: { id: e.room.room_id, name: e.room.room_name }, seat: e.seat, value: e.pairs.length, threshold: limit, examples: e.pairs.slice(-5) });
      }
    }
  }

  /* ---- per recipient pane: fabric DMs routed in (each one a turn), by sender ----
     Two sources, one envelope counted once: the engine's own routing events, and
     the typed frames a hook-delivered pane (Codex) recorded before those existed. */
  const panes = new Map<string, { paneid: string; slug: string | null; ts: number[]; by_sender: Record<string, number>; seen: Set<string>; quiet_refused: number }>();
  const pane = (paneid: string, slug: string | null) => {
    let p = panes.get(paneid);
    if (!p) {
      p = { paneid, slug, ts: [], by_sender: {}, seen: new Set(), quiet_refused: 0 };
      panes.set(paneid, p);
    }
    p.slug = p.slug ?? slug;
    return p;
  };
  const dm = (paneid: string, slug: string | null, from: string, ts: number, id: string | null) => {
    const p = pane(paneid, slug);
    if (id) {
      if (p.seen.has(id)) {
        return;
      }
      p.seen.add(id);
    }
    p.ts.push(ts);
    p.by_sender[from] = (p.by_sender[from] ?? 0) + 1;
  };
  const refusals: Record<string, number> = {};
  /* phase 2: per refusal kind, per who was refused (the DM sender, or the room seat). */
  const refused: Record<string, Record<string, number>> = {};
  const refusedRefs: Record<string, string[]> = {};
  /* [agent comms] a rule in 'watch': what it WOULD have stopped, kept apart from what it did */
  const watched: Record<string, Record<string, number>> = {};
  const watchedRefs: Record<string, string[]> = {};
  let echoConfirms = 0;
  const rest = { rested: 0, woken: 0 };
  for (const e of src.events) {
    const watch = e.kind.startsWith('watch_');
    const kind = watch ? e.kind.slice('watch_'.length) : e.kind;
    if ((REFUSAL_KINDS as readonly string[]).includes(kind)) {
      const who = e.from_slug ?? e.slug ?? 'unknown';
      const byWho = ((watch ? watched : refused)[kind] ??= {});
      byWho[who] = (byWho[who] ?? 0) + 1;
      if (e.env_id) {
        ((watch ? watchedRefs : refusedRefs)[`${kind} ${who}`] ??= []).push(e.env_id);
      }
      continue;
    }
    if (e.kind === 'agent_rested' || e.kind === 'agent_woken') {
      rest[e.kind === 'agent_rested' ? 'rested' : 'woken']++; // [agent rest] level 1
      continue;
    }
    if (e.kind === 'lead_echo_confirmed') {
      echoConfirms++;
      continue;
    }
    if (e.kind === 'fabric_dm' && e.paneid) {
      dm(e.paneid, e.slug, e.from_slug ?? 'unknown', e.ts, e.env_id);
    } else if (e.kind === 'quiet_refused') {
      refusals[e.slug ?? 'unknown'] = (refusals[e.slug ?? 'unknown'] ?? 0) + 1;
      if (e.paneid) {
        pane(e.paneid, e.slug).quiet_refused++;
      }
    }
  }
  for (const t of src.fabricTurns) {
    for (const f of fabricFrames(t.text)) {
      dm(t.paneid, t.slug, f.from, t.ts, f.id);
    }
  }
  const paneOut = [...panes.values()].map((p) => {
    const ts = p.ts.sort((a, b) => a - b);
    const max = maxInWindow(ts, HOUR);
    if (max > th.dmsPerHour) {
      findings.push({
        kind: 'dm_rate',
        pane: { paneid: p.paneid, slug: p.slug },
        value: max,
        threshold: th.dmsPerHour,
        examples: Object.entries(p.by_sender).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([from, n]) => `@${from} ×${n}`),
      });
    }
    return { paneid: p.paneid, slug: p.slug, dms: ts.length, max_per_hour: max, by_sender: p.by_sender, quiet_refused: p.quiet_refused };
  });

  for (const [kind, byWho] of Object.entries(refused)) {
    for (const [who, n] of Object.entries(byWho)) {
      findings.push({ kind: 'refused', seat: who, value: n, threshold: 0, examples: [kind, ...(refusedRefs[`${kind} ${who}`] ?? []).slice(-5)] });
    }
  }
  for (const [kind, byWho] of Object.entries(watched)) {
    for (const [who, n] of Object.entries(byWho)) {
      findings.push({ kind: 'watched', seat: who, value: n, threshold: 0, examples: [kind, ...(watchedRefs[`${kind} ${who}`] ?? []).slice(-5)] });
    }
  }

  return {
    hours: o.hours,
    thresholds: th,
    quiet: o.quiet ?? [],
    refusals,
    shape: shapeReport(src),
    refused,
    watched,
    echo_confirms: echoConfirms,
    rest,
    rooms: [...rooms.values()].map(({ to_ids: _ids, ...r }) => r).sort((a, b) => b.to_person - a.to_person),
    seats: [...seats.values()].sort((a, b) => b.lines - a.lines),
    panes: paneOut.sort((a, b) => b.dms - a.dms),
    findings,
  };
}

/**
 * The QUIET SWITCH's match: which quiet slug (if any) covers a recipient named by
 * any of `names` — the `to` as sent, the live pane's agent slug, its minted
 * work slug. Marking `video-to-3d` quiet covers every session of that agent;
 * marking a minted slug covers that one session.
 */
export function quietMatch(quiet: readonly string[], names: ReadonlyArray<string | null | undefined>): string | null {
  for (const n of names) {
    if (n && quiet.includes(n)) {
      return n;
    }
  }
  return null;
}

/** The sender's answer when the recipient is quiet. */
export function quietMessage(slug: string): string {
  return `${slug} is quiet; the person holds it`;
}

/* ---- phase 2 [chatter p2] (Owner 2026-10-06): rules the ENGINE enforces ---- */

/** The refusal kinds the doors record (chatter_events.kind) and the report counts. */
export const REFUSAL_KINDS = ['ack_only', 'lead_echo', 'dm_budget', 'dm_repeat'] as const;
export type RefusalKind = (typeof REFUSAL_KINDS)[number];

/* An ACKNOWLEDGEMENT: the line opens with one of these and says little else. A
   line that opens "Ack." and then carries real news (a commit, a hold, a number)
   is a report and passes; measured on the operator's real lines (2026-10-06). */
const ACK_PHRASES = [['got', 'it'], ['thank', 'you'], ['will', 'do'], ['ack'], ['acked'], ["ack'd"], ['acknowledged'], ['received'], ['noted'], ['confirmed'], ['understood'], ['thanks'], ['ok'], ['okay'], ['roger']];
const ACK_WORDS = new Set(['ack', 'acked', "ack'd", 'acknowledged', 'received', 'noted', 'confirmed', 'understood', 'thanks', 'ok', 'okay', 'roger']);
/** Fewer words than this besides the acknowledgement = an ack-only line. */
export const ACK_MAX_OTHER_WORDS = 12;
const CURLY_APOSTROPHE = String.fromCharCode(0x2019);

/** True when `text` (an agent's room line) is only an acknowledgement. */
export function isAckOnly(text: string): boolean {
  const toks = text
    .toLowerCase()
    .split(CURLY_APOSTROPHE)
    .join("'")
    .replace(/@[a-z0-9_.-]+/g, ' ')
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
  const lead = ACK_PHRASES.find((p) => p.every((w, i) => toks[i] === w));
  if (!lead) {
    return false;
  }
  return toks.slice(lead.length).filter((t) => !ACK_WORDS.has(t)).length < ACK_MAX_OTHER_WORDS;
}

export const ACK_ONLY_MESSAGE =
  'an acknowledgement is not a room line: use fabric_ack (it costs nobody a turn). If you have news, lead with the news.';
/** Where the seat has no fabric tools (a HOSTED engine, or HARBOR_WB_ROOM_FABRIC=0) fabric_ack does not exist for it: guides and refusals must not name a tool the seat does not have. */
export const fabricToolsHere = (): boolean => process.env.HARBOR_WB_HOSTED !== '1' && process.env.HARBOR_WB_ROOM_FABRIC !== '0';
export const ACK_ONLY_MESSAGE_NO_FABRIC = 'an acknowledgement is not a room line: do not post a bare "ok" or "got it". Post only when you have news, an answer or a question.';
export const ackOnlyMessage = (): string => (fabricToolsHere() ? ACK_ONLY_MESSAGE : ACK_ONLY_MESSAGE_NO_FABRIC);

/** The most recent earlier line (to the person, by another seat) this one echoes, or null. */
export function echoOf<T extends { id: number; body: string }>(text: string, earlier: readonly T[]): T | null {
  const w = words(text);
  let best: T | null = null;
  for (const e of earlier) {
    if (similarity(w, words(e.body)) >= ECHO_SIMILARITY && (!best || e.id > best.id)) {
      best = e;
    }
  }
  return best;
}

/** DM budget: one sender to one recipient, per rolling hour. */
export function dmBudgetPerHour(): number {
  const n = Number(process.env.HARBOR_WB_DM_BUDGET_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 6;
}

/** The earlier DM (same sender, same recipient, last hour) this body repeats, or null. */
export function repeatOf<T extends { body: string; ts: number }>(body: string, earlier: readonly T[]): T | null {
  const w = words(body);
  let best: T | null = null;
  for (const e of earlier) {
    if (similarity(w, words(e.body)) >= REPEAT_SIMILARITY && (!best || e.ts > best.ts)) {
      best = e;
    }
  }
  return best;
}

/* ---- PHASE A LABELER [shape] (Owner 2026-10-07, room interface): what KIND of
   message each agent room line and fabric DM is, report/watch only. Seven labels:
     action   asks the recipient to do something (a request, a question, a help ask)
     reply    answers the recipient (yes / no / agreed / short answer ...)
     control  stop, hold, pause, cancel, resume, runner hold/clear
     ack      a receipt ("Ack.", "Received", "Read the full ...")
     status   reports progress or a result (the default)
     relay    carries someone else's words or work ("From Owner, in his words", "I passed ...")
     blast    to everyone (@room, a "Heads-up")
   plus mustDeliver: control; the person's own words or a relay of them; a direct
   question; a reply on a thread where the recipient had an open ask (report-level:
   see shapeReport); a dependency done with an id (done / merged / delivered ... plus a
   sha, checkpoint, line or library id). Written WITHOUT backslashes: phrases are
   matched against the space-joined lowercase word list. Measured against 127 hand
   labels in test/fixtures/chatter-shape.json (test/chatter-shape.test.ts). ---- */

export const SHAPE_LABELS = ['action', 'reply', 'control', 'ack', 'status', 'relay', 'blast'] as const;
export type ShapeLabel = (typeof SHAPE_LABELS)[number];

export interface ShapeInput {
  body: string;
  author: string;
  /** The stored target: a seat handle, 'room', the person's handle, or null. */
  target: string | null;
  /** The recipient had an open ask to this author (shapeReport decides). */
  recipientAsked?: boolean;
}

/** " word word word " (lowercase, @mentions dropped, apostrophes kept), for phrase tests. */
function wordLine(text: string, max = Infinity): string {
  const w = text
    .toLowerCase()
    .split(CURLY_APOSTROPHE)
    .join("'")
    .replace(/@[a-z0-9_.-]+/g, ' ')
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .slice(0, max);
  return ` ${w.join(' ')} `;
}
const any = (line: string, phrases: readonly string[]): boolean => phrases.some((p) => line.includes(` ${p} `));
const opens = (line: string, phrases: readonly string[]): boolean => phrases.some((p) => line.startsWith(` ${p} `));

const CONTROL_OPEN = ['stop', 'halt', 'hold', 'holding', 'pause', 'cancel', 'clear', 'runner clear', 'runner hold', 'stand down', 'resume'];
const CONTROL_HEAD = ['runner clear', 'runner hold', 'runner idle', 'runner is idle', 'hold confirmed', 'no runner', 'stand down', 'stop now', 'halt the', 'cancel the', 'pause the'];
const RELAY_HEAD = ['from owner', 'in his words', 'in your words', 'relayed', 'relaying', "i've passed", 'i passed', 'passed to', "i've routed", 'i told', 'from the video to 3d agent', 'from astra', "owner's go"];
const REPLY_OPEN = ['yes', 'no', 'right', 'agreed', 'correct', 'exactly', 'short answer', 'straight answer', 'good call', 'none of those', 'understood'];
const ACK_OPEN = ['ack', 'acked', "ack'd", 'acknowledged', 'received', 'noted', 'got it', 'thanks', 'thank you', 'read the full', 'read full', 'confirmed'];
const ASK = ['please', 'can you', 'could you', 'would you', 'will you', 'trying to', 'bug from', 'windows run'];
const DONE = ['done', 'complete', 'completed', 'delivered', 'merged', 'pushed', 'landed', 'live', 'shipped', 'deployed', 'ready', 'passed'];
const PERSON = ['from owner', 'in his words', "owner's go", 'owner asked', 'owner directed', "owner's request"];

/** A sha (7+ hex with a digit and a letter), a checkpoint / line number, or a uuid. */
function hasId(text: string): boolean {
  const t = text.toLowerCase();
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(t)) return true;
  if (/(checkpoint|cp|line|main|sha) ?[0-9a-f]{3,}/.test(t)) return true;
  return (t.match(/[0-9a-f]{7,40}/g) ?? []).some((h) => /[0-9]/.test(h) && /[a-f]/.test(h));
}

/** One message's label and whether it must be delivered (report/watch only). */
export function shapeOf(m: ShapeInput): { label: ShapeLabel; mustDeliver: boolean } {
  const body = m.body ?? '';
  const head = wordLine(body, 14);
  const full = wordLine(body);
  const trimmed = body.trim();
  let label: ShapeLabel;
  if (m.target === 'room' || opens(head, ['heads up'])) label = 'blast';
  else if (opens(head, CONTROL_OPEN) || any(head, CONTROL_HEAD)) label = 'control';
  else if (any(head, RELAY_HEAD)) label = 'relay';
  else if (opens(head, REPLY_OPEN)) label = 'reply';
  else if (opens(head, ACK_OPEN) || isAckOnly(body)) label = 'ack';
  else if (trimmed.endsWith('?') || any(head, ASK)) label = 'action';
  else label = 'status';
  const question = trimmed.endsWith('?') || any(full, ['can you', 'could you', 'please']);
  const mustDeliver =
    label === 'control' ||
    m.author === 'user' ||
    any(full, PERSON) ||
    (question && label !== 'ack') ||
    m.recipientAsked === true ||
    (any(full, DONE) && hasId(body));
  return { label, mustDeliver };
}

type Counts = Record<ShapeLabel, number> & { must_deliver: number; total: number };
const zero = (): Counts => ({ action: 0, reply: 0, control: 0, ack: 0, status: 0, relay: 0, blast: 0, must_deliver: 0, total: 0 });

/**
 * The SHAPE section of the report: per room, per seat (author), per pair
 * (author -> target), and fabric DMs. "Recipient had an open ask" is approximated
 * per pair: the last line B sent A was labelled `action` (or ended in '?') and A has
 * not written to B since; A's next line to B then counts as must-deliver.
 */
export function shapeReport(src: ChatterSource): {
  rooms: Array<{ room_id: string; name: string } & Counts>;
  seats: Array<{ author: string } & Counts>;
  pairs: Array<{ from: string; to: string } & Counts>;
  dms: Counts;
} {
  const rooms = new Map<string, { room_id: string; name: string } & Counts>();
  const seats = new Map<string, { author: string } & Counts>();
  const pairs = new Map<string, { from: string; to: string } & Counts>();
  const dms = zero();
  const openAsk = new Set<string>(); // "B A": B asked A, not yet answered
  const add = (c: Counts, s: { label: ShapeLabel; mustDeliver: boolean }) => {
    c[s.label]++;
    c.total++;
    if (s.mustDeliver) c.must_deliver++;
  };
  for (const l of [...src.lines].sort((a, b) => a.id - b.id)) {
    if (l.author === 'room' || l.kind === 'voice') continue;
    const to = l.target ?? (l.to_person ? 'user' : 'lead');
    const asked = openAsk.has(`${to} ${l.author}`);
    const s = shapeOf({ body: l.body, author: l.author, target: l.target ?? null, recipientAsked: asked });
    openAsk.delete(`${to} ${l.author}`);
    if (s.label === 'action') openAsk.add(`${l.author} ${to}`);
    if (l.author === 'user') continue; // the person's own lines are not agent chatter; they only open asks
    const r = rooms.get(l.room_id) ?? { room_id: l.room_id, name: l.room_name, ...zero() };
    rooms.set(l.room_id, r);
    add(r, s);
    const st = seats.get(l.author) ?? { author: l.author, ...zero() };
    seats.set(l.author, st);
    add(st, s);
    const k = `${l.author} ${to}`;
    const p = pairs.get(k) ?? { from: l.author, to, ...zero() };
    pairs.set(k, p);
    add(p, s);
  }
  for (const t of src.fabricTurns) {
    for (const part of t.text.split('[fabric · @').slice(1)) {
      const from = part.slice(0, part.indexOf(' ')) || 'unknown';
      const body = part.slice(part.indexOf(']') + 1).trim();
      const s = shapeOf({ body, author: from, target: t.slug });
      add(dms, s);
    }
  }
  const byTotal = <T extends Counts>(m: Map<string, T>) => [...m.values()].sort((a, b) => b.total - a.total);
  return { rooms: byTotal(rooms), seats: byTotal(seats), pairs: byTotal(pairs), dms };
}
