/* The Scratchpad header text. Pure, no imports, so a test can load it as it ships. The engine lists a WINDOW of notes (pinned + last 24 h, topped up to 10) and counts
 * ALL unarchived ones, so a bare "Notes · 18" can sit over ten cards with no way to the other eight. Until the paginated index (row 10) lands, whenever fewer notes are
 * shown than counted the header SAYS so ("Showing 10 of 18 notes"; singular only for a total of 1). Assets are never windowed. */
export function titleOf(kind, n, m, shown) {
  const k = kind === 'assets' ? 'Assets' : 'Notes';
  if (kind !== 'assets' && Number.isFinite(shown) && Number.isFinite(m) && shown < m) {
    return `${k} · ${n > 0 ? `${n} new · ` : ''}Showing ${shown} of ${m} note${m === 1 ? '' : 's'}`;
  }
  return n > 0 ? `${k} · ${n} new of ${m}` : `${k} · ${m}`;
}
