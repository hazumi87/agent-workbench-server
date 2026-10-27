/* REPLY ALL (Owner 2026-10-03, room): replying to a line addresses its author
 * AND every seat the line @-mentioned, EXCEPT a name inside a quotation or code (Owner [ref],
 * toolkit [ref]: a quoted or backticked name is not a reference). Pure, no DOM, so the test can hold it.
 *
 * Handles come out lowercase-deduped, author first then mention order. Dropped:
 * the person themself (@user or their @name), the room-wide @room / @all
 * (unless that was the only addressee: then the reply is "@room", since the
 * room refuses @all, which is installation-wide fabric addressing),
 * and anything that is not a seat of this room. @lead resolves to the lead
 * seat's own handle (the line goes to the same seat either way). */

/* the page's own mention shape (room.js MENTION_RE) */
const MENTION_RE = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g;
const ROOMWIDE = new Set(['room', 'all']);

/**
 * @param {object} o
 *   body: the replied-to line's text; author: its author's seat handle or null;
 *   seats: the room's seat handles; leadHandle: the lead seat's handle | null;
 *   me: the person's own @name | null
 * @returns {string[]} the handles to address, in order
 */
export function replyAllHandles({ body, author, seats, leadHandle, me }) {
  const seatSet = new Set((seats ?? []).map((h) => String(h).toLowerCase()));
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
      roomwide ??= h;
    } else if (!mine.has(h) && seatSet.has(h) && !out.includes(h)) {
      out.push(h);
    }
  };
  if (author) {
    add(author);
  }
  for (const m of withoutCodeAndQuotes(body).matchAll(MENTION_RE)) {
    add(m[1]);
  }
  return out.length || !roomwide ? out : ['room'];
}

/** "@a @b " (with the trailing space), or '' when nobody. */
export function replyAllPrefix(handles) {
  return handles.length ? `${handles.map((h) => `@${h}`).join(' ')} ` : '';
}

/* QUOTED TEXT (lives here so the page has ONE pure module with no imports to version) is a quotation, not an address (Owner [ref], toolkit [ref]).
 * The page's copy of src/server/room-commands.ts quotedRanges/withoutQuotes; both are
 * held to test/fixtures/address-cases.json. Rules: a straight double quote opens only at
 * the start or after whitespace or ( [ {, so 5" pipe is not a quote; it closes at the
 * first double quote followed by the end, whitespace or . , ; : ! ? ) ] }; curly quotes
 * open at U+201C and close at the next U+201D; a span is at most 400 characters and never
 * crosses a newline; an unmatched quote is left alone; apostrophes never count. */
export const QUOTE_MAX = 400;
const NL = String.fromCharCode(10);
const WS = [' ', String.fromCharCode(9), NL, String.fromCharCode(13)];
const OPENERS = new Set([...WS, '(', '[', '{']);
const CLOSERS = new Set([...WS, '.', ',', ';', ':', '!', '?', ')', ']', '}']);
const STRAIGHT = String.fromCharCode(34);
const LEFT_CURLY = String.fromCharCode(0x201c);
const RIGHT_CURLY = String.fromCharCode(0x201d);

/** [start, end) of every quoted span, quotes included. */
export function quotedRanges(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    let close = -1;
    if (c === LEFT_CURLY) {
      for (let j = i + 1; j < n && j - i <= QUOTE_MAX && text[j] !== NL; j++) {
        if (text[j] === RIGHT_CURLY) {
          close = j;
          break;
        }
      }
    } else if (c === STRAIGHT && (i === 0 || OPENERS.has(text[i - 1]))) {
      for (let j = i + 1; j < n && j - i <= QUOTE_MAX && text[j] !== NL; j++) {
        if (text[j] === STRAIGHT && (j + 1 === n || CLOSERS.has(text[j + 1]))) {
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

const BT = String.fromCharCode(96);
/** The text with code (fenced blocks, then inline spans, paired as the engine's withoutCode reads
 *  them) and quoted spans removed: what is left is where a name can be a reference. Each removed
 *  span becomes one space. */
export function withoutCodeAndQuotes(text) {
  const t = String(text ?? '');
  const noCode = t
    .split(BT.repeat(3))
    .filter((_, i) => i % 2 === 0)
    .join(' ')
    .split(BT)
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

/** Is index `at` inside a quoted span of `text`? (`ranges` = quotedRanges(text), computed once.) */
export function inQuote(ranges, at) {
  return ranges.some(([a, b]) => at >= a && at < b);
}
