/* link-sweep — reconstruct URLs that a TUI HARD-wrapped across lines
 * (Owner 2026-08-09: OAuth URLs from tools arrive broken; claude's renderer
 * wraps long tokens with a real newline + indent, which no terminal-side
 * soft-wrap handling can undo — same in Windows Terminal).
 *
 * Input is LOGICAL lines: the caller must already have joined xterm's
 * soft-wrapped rows (buffer line.isWrapped) — this module only bridges the
 * HARD breaks, with a guard so prose after a line-final URL is not glued on.
 */

const URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

/** Does a continuation token look like URL innards rather than prose?
 *  Prose ("and", "then") is bare letters; URL fragments almost always carry
 *  structure chars or a dot-run ("nt.com&redirect_uri=…", "=C_4W…"). */
function looksLikeUrlContinuation(token) {
  if (!token) {
    return false;
  }
  if (/^https?:\/\//.test(token)) {
    return false; // a NEW url starting on the next line is not a continuation
  }
  return /[/=&%?#]/.test(token) || /\.[A-Za-z0-9]{2}/.test(token) || token.length > 25;
}

/** Extract http(s) URLs from logical lines, bridging hard wraps. Returns
 *  de-duplicated URLs in order of first appearance. */
export function extractUrls(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const re = /https?:\/\//g;
    let m;
    while ((m = re.exec(line))) {
      let url = '';
      let pos = m.index;
      let cur = line;
      let row = i;
      // consume URL chars, hopping to continuation lines when we run off the end
      for (;;) {
        while (pos < cur.length && URL_CHAR.test(cur[pos])) {
          url += cur[pos++];
        }
        if (pos < cur.length) {
          break; // stopped at a real non-URL char — URL ended here
        }
        // ran to end-of-line: candidate hard wrap — peek the next line
        const next = lines[row + 1];
        if (next === undefined) {
          break;
        }
        const cont = next.replace(/^[\s>│┃|]+/, '');
        const token = cont.split(/\s/, 1)[0];
        if (!looksLikeUrlContinuation(token)) {
          break;
        }
        row++;
        cur = cont;
        pos = 0;
      }
      if (row > i) {
        // tell the outer scan to skip lines we consumed as continuations
        i = row;
      }
      url = url.replace(/[).,;:'"”›»]+$/, ''); // trailing prose punctuation
      if (url.length >= 12 && !found.includes(url)) {
        found.push(url);
      }
    }
  }
  return found;
}
