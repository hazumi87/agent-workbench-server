// Addresses in a terminal (web build, P04): an http or https address on the screen is a link that opens in a new tab with nothing of ours attached.
// xterm's own link provider API (no addon): a logical line is the screen line plus the lines it wraps onto, so a long address broken across rows is still one link.
import { safeUrl } from './rooms/line.js';

const URL_RE = /https?:\/\/[^\s<>"`]+/g;

/** The links on screen row y (1-based) of buffer `buf`: [{range, text}]. Pure over the buffer's getLine/translateToString. */
export function linksOnRow(buf, y, cols) {
  let top = y;
  while (top > 1) { const l = buf.getLine(top - 2); const cur = buf.getLine(top - 1); if (cur && cur.isWrapped && l) top -= 1; else break; }
  const rows = [];
  for (let r = top; ; r++) {
    const l = buf.getLine(r - 1);
    if (!l || (r > top && !l.isWrapped)) break;
    rows.push(l.translateToString(false, 0, cols));
  }
  const text = rows.join('');
  const out = [];
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    const raw = m[0].replace(/\s+$/, '');
    const u = safeUrl(raw);
    if (!u) continue;
    const a = m.index, b = m.index + u.text.length - 1;
    const range = { start: { x: (a % cols) + 1, y: top + Math.floor(a / cols) }, end: { x: (b % cols) + 1, y: top + Math.floor(b / cols) } };
    if (range.end.y < y || range.start.y > y) continue;
    out.push({ range, text: u.href });
  }
  return out;
}

/** Make addresses in `term` clickable (web only). Opening is a new tab with noopener and no referrer. */
export function linkTerminal(term, win = globalThis.window) {
  if (!term || typeof term.registerLinkProvider !== 'function') return null;
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      try {
        const found = linksOnRow(term.buffer.active, y, term.cols);
        callback(found.length ? found.map((f) => ({ range: f.range, text: f.text, decorations: { underline: true, pointerCursor: true }, activate: (_e, t) => { const u = safeUrl(t); if (u) win.open(u.href, '_blank', 'noopener,noreferrer'); } })) : undefined);
      } catch { callback(undefined); }
    },
  });
}
