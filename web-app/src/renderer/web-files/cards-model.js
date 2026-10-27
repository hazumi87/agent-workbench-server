// Adapted from the team scratch-cards handoff <commit>; browser files integration.
// The Scratchpad cards' model (the design notes C2; the design's workbench-scratchpad-cards-v1, frames A,
// D, J, K and L). Pure, no DOM: the age groups on the Pacific calendar (Today, Yesterday, This week = two to six
// days back, Earlier), the age words for a card and for a Detailed row, type and size labels, the author, the
// card line, newest-first grouping, the New cue from the person's seen marks, and Copy reference only for an
// engine ref that is in the engine. The items are main's projection (src/scratch-index.js). test/scratch-cards-model.test.mjs.

const TZ = 'America/Los_Angeles';
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' });
const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
const DATE_YEAR = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const REF = /^(line_\d{1,20}|note_[0-9a-f]{12}|asset_[0-9a-f]{12})$/; // the engine's three shapes, as main projects them
const ARCHIVES = new Set(['application/zip', 'application/x-zip-compressed', 'application/x-7z-compressed', 'application/x-tar', 'application/gzip', 'application/x-gzip', 'application/x-rar-compressed']);

export const GROUPS = Object.freeze([
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'earlier', label: 'Earlier' },
]);
export const VIEWS = Object.freeze(['compact', 'detailed']);
export const DEFAULT_VIEW = 'compact'; // new people start on Compact (lead ruling )

/** The person's stored choice, or Compact. */
export const readView = (v) => (VIEWS.includes(v) ? v : DEFAULT_VIEW);

const timeOf = (v) => { const t=typeof v==='number'?v:typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(t)&&Math.abs(t)<=8640000000000000?t:NaN; };
function parts(ms) {
  const p = {};
  for (const x of DAY.formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}
// whole Pacific calendar days since the epoch: DST changes the hour count of a day, never this
const dayIndex = (ms) => { const p = parts(ms); return Date.UTC(+p.year, +p.month - 1, +p.day) / 86_400_000; };

/** 'today' | 'yesterday' | 'week' | 'earlier' on the Pacific calendar; a time a little ahead is today. */
export function ageGroup(iso, now) {
  const t = timeOf(iso);
  if (!Number.isFinite(t)) return 'earlier';
  const d = dayIndex(now) - dayIndex(t);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d <= 6) return 'week';
  return 'earlier';
}

/** "12 minutes ago", "2 hours ago", "yesterday", "Tuesday", "18 Oct", "18 Oct 2025"; {short} for a Detailed row. */
export function ageText(iso, now, { short = false } = {}) {
  const t = timeOf(iso);
  if (!Number.isFinite(t)) return '';
  const diff = now - t;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return short ? min + ' min ago' : min === 1 ? '1 minute ago' : min + ' minutes ago';
  const d = dayIndex(now) - dayIndex(t);
  if (d <= 0) { const h = Math.floor(diff / 3_600_000); return h === 1 ? '1 hour ago' : h + ' hours ago'; }
  if (d === 1) return short ? 'Yesterday' : 'yesterday';
  if (d <= 6) return WEEKDAY.format(new Date(t));
  return parts(t).year === parts(now).year ? DATE.format(new Date(t)) : DATE_YEAR.format(new Date(t));
}

export function typeLabel(item) {
  if (item.kind === 'note') return 'Note';
  const t = typeof item.type === 'string' ? item.type.toLowerCase() : '';
  if (t.startsWith('image/')) return 'Image';
  if (ARCHIVES.has(t)) return 'Archive';
  if (t === 'application/pdf') return 'PDF';
  if (t.startsWith('text/')) return 'Text';
  return 'File';
}

const short1 = (v) => (v < 10 ? String(Number(v.toFixed(1))) : String(Math.round(v)));
export function sizeText(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return Math.round(n) + ' B';
  if (n < 1024 * 1024) { const kb = Math.round(n / 1024); if (kb < 1024) return kb + ' KB'; }
  if (n < 1024 ** 3) return short1(n / 1024 ** 2) + ' MB';
  return short1(n / 1024 ** 3) + ' GB';
}

/** you (You on a Detailed row) for the person, @handle for anyone else. */
export function authorText(author, me, { row = false } = {}) {
  if (typeof author !== 'string' || !author) return '';
  if (author === me) return row ? 'You' : 'you';
  return '@' + author;
}

/** A note's first line, or a file's type and size. */
export function cardLine(item) {
  if (item.kind === 'note') return typeof item.preview === 'string' ? item.preview.split(/\r?\n/)[0].trim() : '';
  return [typeLabel(item), sizeText(item.size)].filter(Boolean).join(' · ');
}

const whenOf = (item) => item.modified_at ?? item.created_at ?? null;

/** The four groups in order, newest first inside each (ties keep the index's order), empty groups left out. */
export function groupItems(items, now) {
  const by = new Map(GROUPS.map((g) => [g.key, []]));
  const order=it=>{const t=timeOf(whenOf(it));return Number.isFinite(t)?t:-Infinity;};
  const sorted = [...items].sort((a, b) => order(b)-order(a)||0);
  for (const it of sorted) by.get(ageGroup(whenOf(it), now)).push(it);
  return GROUPS.filter((g) => by.get(g.key).length).map((g) => ({ key: g.key, label: g.label, items: by.get(g.key) }));
}

/** New when someone else added or changed it since the person last looked (seenVersion(id) → the version they saw). */
export function isNew(item, me, seenVersion) {
  if (!copyable(item)||typeof item.id!=='string'||!item.id||typeof item.author!=='string'||!item.author||typeof me!=='string'||!me) return false;
  if (typeof item.version !== 'string' || !item.version) return false;
  if (item.author === me) return false;
  return seenVersion(item.id) !== item.version;
}

/** Copy reference: an engine ref of the three shapes, for an item whose bytes are in the engine. */
export const copyable = (item) => item.inEngine === true && typeof item.ref === 'string' && REF.test(item.ref);

export { whenOf };
