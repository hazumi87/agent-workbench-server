/* THE QUOTE'S TEXT (the design system room-reply-v1): pure, no DOM, so the engine's test
 * can hold it to src/engine/room-reply.ts excerptOf (the same output for the
 * same text). The page draws the composer chip from this before the server's
 * own capture answers; the sent line always shows the engine's.
 *
 * List numbers are KEPT ("1." / "2)") and list items join with " · ", so
 * "go with 2)" visibly lands on the list it answers; whitespace collapses;
 * at most EXCERPT_MAX characters, an ellipsis when cut. */

export const EXCERPT_MAX = 160;

const NUMBERED = /^\d{1,3}[.)]\s+/;
const BULLET = new RegExp('^[-*+' + String.fromCharCode(0x2022) + ']\\s+');
const ELLIPSIS = String.fromCharCode(0x2026);
const SEP = ' ' + String.fromCharCode(0xb7) + ' ';

export function excerptOf(text, max = EXCERPT_MAX) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/^>\s*/, ''))
    .filter(Boolean);
  let out = '';
  let prevItem = false;
  for (const raw of lines) {
    const numbered = NUMBERED.test(raw);
    const bullet = !numbered && BULLET.test(raw);
    const item = numbered || bullet;
    const l = bullet ? raw.replace(BULLET, '') : raw;
    out += out ? (item && prevItem ? SEP : ' ') + l : l;
    prevItem = item;
  }
  if (out.length > max) {
    out = out.slice(0, Math.max(0, max - 1)).trimEnd() + ELLIPSIS;
  }
  return out;
}

/** The quote of a line entry as the page holds it — the same shape the
 *  engine stores in meta.reply (room-reply.ts replyRef), minus nothing the
 *  chip needs. `userHandle` names the person; `seatHandle(id)` a seat now. */
export function quoteOf(e, { userHandle, seatHandle }) {
  let meta = null;
  try {
    meta = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
  } catch {
    meta = null;
  }
  const files = Array.isArray(meta?.attachments) ? meta.attachments.filter((f) => f && typeof f === 'object') : [];
  const byRoom = e.author === 'room' && !e.author_seat;
  const byUser = e.author === 'user' && !e.author_seat;
  const handle = byRoom ? null : byUser ? userHandle : e.author_seat ? (seatHandle(e.author_seat) ?? e.author) : e.author;
  let excerpt = excerptOf(e.body);
  if (!excerpt && files.length) {
    const list = files.map((f) => String(f.name ?? 'file')).join(', ');
    excerpt = excerptOf(`${files.length === 1 ? 'a file' : `${files.length} files`}: ${list}`);
  }
  if (!excerpt && e.kind === 'voice') {
    excerpt = 'voice';
  }
  const img = files.find((f) => typeof f.type === 'string' && f.type.startsWith('image/') && typeof f.name === 'string' && !!f.name && !f.name.includes('/'));
  return {
    id: e.id,
    kind: e.kind,
    handle,
    seat: e.author_seat ?? null,
    ...(byUser ? { user: true } : {}),
    excerpt,
    ...(e.kind === 'voice' ? { voice: true } : {}),
    ...(img ? { thumb: img.name } : {}),
  };
}
