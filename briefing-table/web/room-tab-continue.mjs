/* TAB TO CONTINUE (Owner 2026-10-03, room line [ref]): an EMPTY composer coaches
 * "Tab -> @a @b" in its placeholder and Tab fills it. Pure, no DOM, so the
 * test can hold it. The suggestion is whichever is NEWER of
 *  (a) the person's own last line: its leading @run, else the room seats it
 *      mentioned, or
 *  (b) the newest line by a SEAT addressed to the person (to_user, a reply to
 *      their line, or an @user / @their-name mention): that author plus,
 *      reply-all style, the other seats it mentioned. */
import { replyAllHandles, replyAllPrefix } from '/room-reply-all.mjs';

/* the leading run of @handles (the page's own mention shape) */
const LEADING_RUN = /^\s*((?:@[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?=\s|$)\s*)+)/;
const MENTION_RE = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g;

/**
 * @param {object} o
 *   entries: the room's loaded entries (any order); seats: the room's seat
 *   handles; leadHandle: the lead seat's handle | null; me: the person's @name;
 *   meta: (entry) => its meta object | null; handleOf: (seatId) => handle | null
 * @returns {string} "@a @b " (trailing space) or '' when nothing qualifies
 */
export function tabSuggestion({ entries, seats, leadHandle, me, meta = () => null, handleOf = () => null }) {
  const mine = String(me ?? '').toLowerCase();
  let own = null;
  let theirs = null;
  for (const e of entries ?? []) {
    if (e.kind !== 'chat') {
      continue;
    }
    if (e.author === 'user' && !e.author_seat) {
      if (!own || e.id > own.id) {
        own = e;
      }
    } else if (e.author_seat && (!theirs || e.id > theirs.id)) {
      const m = meta(e);
      const said = [...String(e.body ?? '').matchAll(MENTION_RE)].some((x) => x[1].toLowerCase() === 'user' || (mine && x[1].toLowerCase() === mine));
      if (m?.to_user === true || (m?.reply?.user === true && !e.target) || said) {
        theirs = e;
      }
    }
  }
  const pick = !own ? theirs : !theirs ? own : theirs.id > own.id ? theirs : own;
  if (!pick) {
    return '';
  }
  const body = String(pick.body ?? '');
  const ctx = { seats, leadHandle, me };
  if (pick === theirs) {
    const author = handleOf(pick.author_seat) ?? pick.author;
    return replyAllPrefix(replyAllHandles({ ...ctx, body, author: typeof author === 'string' ? author : null }));
  }
  const run = LEADING_RUN.exec(body)?.[1];
  const fromRun = run ? replyAllHandles({ ...ctx, body: run, author: null }) : [];
  return replyAllPrefix(fromRun.length ? fromRun : replyAllHandles({ ...ctx, body, author: null }));
}
