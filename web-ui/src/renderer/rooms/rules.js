// Two rules the Workbench shares with briefing-table's page, so both clients agree (0.19.0):
//  - the reply prefill (C8, the owner ; a reviewer ): briefing-table's web/room-reply-all.mjs
//    replyAllHandles + replyAllPrefix, copied as is, gated as web/room-reply.mjs prefixFor does;
//  - the person's "To me" (C10, ROOMS-API rev 3 §4.10, the owner ): a quote never counts.
//  - 0.22.2, what a line ADDRESSES: text in code or quotes is never a
//    reference, so it never addresses, colors or prefills: briefing-table's quotedRanges (web/room-quotes.mjs).
// All run against the a reviewer's case files in test/ (test/fixtures/*-cases.json, briefing-table branches
// rooms/to-me-quote and rooms/address-rules), which briefing-table's own tests also run.

const MENTION_RE = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g;
const ROOMWIDE = new Set(['room', 'all']);
export const LEADING = /^@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/;

/* QUOTED TEXT is a quotation, not an address: a straight double quote opens only at the start or after
 * whitespace or ( [ {, so 5" pipe is not a quote; it closes at the first double quote followed by the end,
 * whitespace or . , ; : ! ? ) ] }; curly quotes open at U+201C and close at the next U+201D; a span is at most
 * 400 characters and never crosses a newline; an unmatched quote is left alone; apostrophes never count. */
const QUOTE_MAX = 400;
const OPENERS = new Set([' ', '\t', '\n', '\r', '(', '[', '{']);
const CLOSERS = new Set([' ', '\t', '\n', '\r', '.', ',', ';', ':', '!', '?', ')', ']', '}']);

/** [start, end) of every quoted span, quotes included. */
export function quotedRanges(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    let close = -1;
    if (c === '\u201c') {
      for (let j = i + 1; j < s.length && j - i <= QUOTE_MAX && s[j] !== '\n'; j++) {
        if (s[j] === '\u201d') {
          close = j;
          break;
        }
      }
    } else if (c === '"' && (i === 0 || OPENERS.has(s[i - 1]))) {
      for (let j = i + 1; j < s.length && j - i <= QUOTE_MAX && s[j] !== '\n'; j++) {
        if (s[j] === '"' && (j + 1 === s.length || CLOSERS.has(s[j + 1]))) {
          close = j;
          break;
        }
      }
    }
    if (close > i) {
      out.push([i, close + 1]);
      i = close + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** [start, end) of code: fenced blocks (```…```) and `inline` spans. */
export function codeRanges(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  const fence = /```[\s\S]*?(?:```|$)/g;
  let m;
  while ((m = fence.exec(s))) {
    out.push([m.index, m.index + m[0].length]);
    if (!m[0].length) {
      fence.lastIndex++;
    }
  }
  const inFence = (at) => out.some(([a, b]) => at >= a && at < b);
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(s))) {
    if (!inFence(m.index)) {
      out.push([m.index, m.index + m[0].length]);
    }
  }
  return out;
}

/** The spans of a line that never reference anyone: code first, then quotes in what code leaves. */
export function quietRanges(text) {
  const s = String(text == null ? '' : text);
  const code = codeRanges(s);
  const inCode = (at) => code.some(([a, b]) => at >= a && at < b);
  return code.concat(quotedRanges(s).filter(([a]) => !inCode(a)));
}

export const inRanges = (ranges, at) => ranges.some(([a, b]) => at >= a && at < b);

/** The @handles a line addresses, lowercased, in order: every mention outside code and quotes. */
export function mentionsOf(text) {
  const s = String(text == null ? '' : text);
  const quiet = quietRanges(s);
  const out = [];
  for (const m of s.matchAll(MENTION_RE)) {
    if (!inRanges(quiet, m.index)) {
      out.push(m[1].toLowerCase());
    }
  }
  return out;
}

/** The line's author first, then every @-mention in the body, in order: lowercased, de-duplicated, @lead
 *  resolved, the person and non-seats dropped; @room/@all only when nothing else remains. */
export function replyAllHandles({ body, author, seats, leadHandle, me }) {
  const seatSet = new Set((seats || []).map((h) => String(h).toLowerCase()));
  const mine = new Set(['user']);
  if (me) {
    mine.add(String(me).toLowerCase());
  }
  const out = [];
  let roomwide = null;
  const add = (raw) => {
    let h = String(raw).toLowerCase();
    if (h === 'lead' && leadHandle) {
      h = String(leadHandle).toLowerCase();
    }
    if (ROOMWIDE.has(h) && !seatSet.has(h)) {
      roomwide = roomwide || h;
    } else if (!mine.has(h) && seatSet.has(h) && !out.includes(h)) {
      out.push(h);
    }
  };
  if (author) {
    add(author);
  }
  // 0.22.3 (a reviewer , briefing-table <commit>): names inside quotes or code are not filled in
  for (const m of withoutCodeAndQuotes(body).matchAll(MENTION_RE)) {
    add(m[1]);
  }
  return out.length || !roomwide ? out : ['room'];
}

/** The text with fenced and inline code, then quoted spans, blanked out: what Reply all reads (copied as is from
 *  briefing-table web/room-reply-all.mjs, <commit>; held to test/fixtures/reply-prefill-cases.json). */
export function withoutCodeAndQuotes(text) {
  const t = String(text == null ? '' : text);
  const noCode = t
    .split('```')
    .filter((_, i) => i % 2 === 0)
    .join(' ')
    .split('`')
    .filter((_, i) => i % 2 === 0)
    .join(' ');
  const spans = quotedRanges(noCode);
  let out = '';
  let at = 0;
  for (const [a, b] of spans) {
    out += noCode.slice(at, a) + ' ';
    at = b;
  }
  return out + noCode.slice(at);
}

export function replyAllPrefix(handles) {
  return handles.length ? handles.map((h) => '@' + h).join(' ') + ' ' : '';
}

/** What a reply to line `e` fills in, or '' (no prefill for a voice line or a room fact). `ctx`: { seats:
 *  [handles], leadHandle, me, handleOfSeat(seatId) }. */
export function prefillFor(e, ctx) {
  if (!e || e.kind === 'voice' || (!e.author_seat && e.author === 'room') || e.kind === 'fact') {
    return '';
  }
  const author = e.author === 'user' ? null : (e.author_seat && ctx.handleOfSeat && ctx.handleOfSeat(e.author_seat)) || e.author || null;
  const handles = replyAllHandles({ body: e.body, author, seats: ctx.seats, leadHandle: ctx.leadHandle, me: ctx.me });
  return handles.every((h) => (LEADING.exec('@' + h) || [])[0] === '@' + h) ? replyAllPrefix(handles) : '';
}

/** "To me" (§4.10): I wrote it (or voice / concierge did); a voice line; a tool line I started;
 *  to @room; meta.to_user; an older line addressed to a handle with no seat (not room or lead); the lead's
 *  own line with no address. A quote of my line never counts. */
export function isToMe(e, me) {
  const m = (e && e.meta) || {};
  // Facts do not inherit the broad chat categories (room-wide, author, or tool).
  // Only their own human address counts; reply context is deliberately ignored.
  if (e.kind === 'fact') {
    const mine = new Set(['user']);
    if (me) mine.add(String(me).toLowerCase());
    return m.to_user === true ||
      (!e.target_seat && mine.has(String(e.target || '').toLowerCase())) ||
      mentionsOf(e.body).some(handle => mine.has(handle));
  }
  if (e.kind === 'voice') {
    return true;
  }
  if (typeof m.tool === 'string') {
    return m.for === 'user';
  }
  return (
    e.author === 'user' ||
    e.author === 'voice' ||
    e.author === 'concierge' ||
    e.target === 'room' ||
    m.to_user === true ||
    (!!e.target && !e.target_seat && e.target !== 'room' && e.target !== 'lead') ||
    (!e.target && !!e.author_seat && e.author_seat === e.target_seat)
  );
}

/** Between agents: a seat wrote it to a different seat, not to @room and not to me. */
export function isBetweenAgents(e) {
  const m = (e && e.meta) || {};
  return !!e.author_seat && e.author !== 'user' && e.target !== 'room' && m.to_user !== true && !(!!e.target && !e.target_seat && e.target !== 'room' && e.target !== 'lead') && !!e.target_seat && e.target_seat !== e.author_seat;
}
