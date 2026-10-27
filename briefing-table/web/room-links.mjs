/* LINKS IN ROOM LINES (Owner 2026-09-28): an http(s) URL in a line's body is a
 * link that opens in a NEW window through openExternal (the native host's
 * system browser, the shell's relay, or a plain new window).
 *
 * Built from TEXT NODES only: message text never reaches innerHTML. A scanner,
 * not a regex, so there is no escape to get wrong:
 *   - a URL starts at http:// or https:// that is not glued to a word;
 *   - it runs to whitespace, < > " or a backtick (`https://x` in agent prose);
 *   - trailing . , ; : ! ? " ' stay OUTSIDE the link, and so does a ) or ]
 *     without a matching opener inside the URL (a Wikipedia "_(bar)" keeps
 *     its paren; "(see https://x)" does not swallow the reader's paren);
 *   - at most LINK_SHOW_MAX characters are shown, with an ellipsis; the full
 *     URL is the title.
 * A plain click opens the link and nothing else: the line's own handlers
 * (select, menu, reply, swipe) never see it.
 */
import { externalHref, openExternal } from '/open-external.mjs';

export const LINK_SHOW_MAX = 80;
const ELLIPSIS = String.fromCharCode(0x2026);
const TRAIL = '.,;:!?"' + String.fromCharCode(39);
const STOP = '<>"`';
const PAIRS = { ')': '(', ']': '[' };
const ALNUM = /[A-Za-z0-9]/;

const isStop = (c) => c.trim() === '' || STOP.includes(c);

function count(s, c) {
  let n = 0;
  for (const x of s) {
    if (x === c) {
      n++;
    }
  }
  return n;
}

/** Drop trailing punctuation that belongs to the sentence, not the URL. */
function trimTrail(text, start, end) {
  while (end > start) {
    const c = text[end - 1];
    if (TRAIL.includes(c)) {
      end--;
    } else if (PAIRS[c]) {
      const s = text.slice(start, end);
      if (count(s, c) > count(s, PAIRS[c])) {
        end--; // a closer with no opener in the URL: the reader's
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return end;
}

/** The URL spans in `text`: [{start, end}] in order. Pure. */
export function findUrls(text) {
  const s = String(text ?? '');
  const lower = s.toLowerCase();
  const out = [];
  let from = 0;
  for (;;) {
    const a = lower.indexOf('http', from);
    if (a < 0) {
      break;
    }
    const rest = lower.startsWith('https://', a) ? a + 8 : lower.startsWith('http://', a) ? a + 7 : -1;
    if (rest < 0 || (a > 0 && ALNUM.test(s[a - 1]))) {
      from = a + 4;
      continue;
    }
    let end = rest;
    while (end < s.length && !isStop(s[end])) {
      end++;
    }
    end = trimTrail(s, a, end);
    if (end > rest && externalHref(s.slice(a, end))) {
      out.push({ start: a, end });
    }
    from = Math.max(end, rest);
  }
  return out;
}

/** What the link shows: the URL, cut to LINK_SHOW_MAX with an ellipsis. */
export function linkLabel(url) {
  return url.length > LINK_SHOW_MAX ? url.slice(0, LINK_SHOW_MAX - 1) + ELLIPSIS : url;
}

function linkEl(url) {
  const a = document.createElement('a');
  a.className = 'rl-link';
  a.href = externalHref(url);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = url;
  a.textContent = linkLabel(url);
  const open = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openExternal(a.href);
  };
  a.addEventListener('click', open);
  a.addEventListener('auxclick', (ev) => {
    if (ev.button === 1) {
      open(ev); // a middle click: the same new window, never an in-host navigation
    }
  });
  return a;
}

const plain = (t) => [document.createTextNode(t)];

/**
 * `text` as nodes: every URL an <a>, every other run through `rest(run)`
 * (room.js passes its @mention toning; plain text by default).
 */
export function linkNodes(text, rest = plain) {
  const s = String(text ?? '');
  const out = [];
  let at = 0;
  for (const { start, end } of findUrls(s)) {
    if (start > at) {
      out.push(...rest(s.slice(at, start)));
    }
    out.push(linkEl(s.slice(start, end)));
    at = end;
  }
  if (at < s.length) {
    out.push(...rest(s.slice(at)));
  }
  return out;
}
