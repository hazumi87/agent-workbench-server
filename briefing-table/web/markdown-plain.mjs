/* MARKDOWN, WITHOUT THE LIBRARIES [line markdown]: two pure helpers every surface can import without pulling the renderer in.
 *   hasMarkup(text)  does the text carry anything Markdown would change? (a line with none takes the plain path unchanged)
 *   stripMarks(text) the text with its marks taken out, for the places that stay plain: event lines, a reply quote's excerpt, search results, a room card's last line. */

/** Does this text carry anything Markdown would change? Cheap and generous: a false positive only costs one render. */
export function hasMarkup(text) {
  const s = String(text ?? '');
  if (s.length < 2) {
    return false;
  }
  return /(\*\*|__|~~|`|\*[^\s*][^*\n]*\*|(?:^|\s)_[^\s_][^_\n]*_(?:\s|$)|^\s{0,3}#{1,6}\s|^\s{0,3}>\s?|^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s|^\s{0,3}(?:---+|\*\*\*+|___+)\s*$|\[[^\]\n]+\]\([^)\s]+\)|\|[^\n]*\|)/m.test(s);
}

/** Take the Markdown marks out of a text for the places that stay plain (event lines, a quote's excerpt, search results, a card's last line). */
export function stripMarks(text, { trim = true } = {}) {
  let s = String(text ?? '');
  s = s.replace(/^\s{0,3}(```|~~~)[^\n]*$/gm, ''); // fence lines
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images -> their text
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '$1'); // links -> their text
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // headings
  s = s.replace(/^\s{0,3}>\s?/gm, ''); // quotes
  s = s.replace(/^\s{0,3}([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/gm, '• '); // list markers
  s = s.replace(/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/gm, '');
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/(^|[\s(])\*([^\s*][^*\n]*?)\*(?=$|[\s).,;:!?])/g, '$1$2').replace(/(^|[\s(])_([^\s_][^_\n]*?)_(?=$|[\s).,;:!?])/g, '$1$2');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/\n{3,}/g, '\n\n');
  return trim ? s.trim() : s;
}

