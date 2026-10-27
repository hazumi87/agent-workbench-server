/* ============================================================================
 * REPLY TO A LINE (the design system room-reply-v1, Owner 2026-09-28).
 *
 * A person or an agent answers ONE entry of the room line: POST .../line
 * carries `reply_to: <entry id>` (an entry of THIS room, else 400). The entry
 * written stores `meta.reply` = the ReplyRef below, captured AT SEND TIME, so
 * the quote a reader sees is what the writer saw even if the original is later
 * out of reach. No nesting: a reply to a reply quotes only its parent.
 *
 * THE EXCERPT keeps list numbers ("1." / "2)") and joins list items with " · "
 * so "go with 2)" visibly lands on the list it answers; whitespace collapses;
 * <= EXCERPT_MAX chars. The same excerpt feeds the page's chip, the sent
 * line's quote header, and the prefix agents get.
 *
 * THE PREFIX (one function, both delivery paths: the typed copy room-typer
 * frames and the channel copy room-fabric sends) is its own first line:
 *   ↩ re #812 @author                   (a fact: ↩ re #812 fact)
 * The line number is the reference; the excerpt is NOT sent to agents (they hold
 * the line, Owner [ref]). The typed path flattens the newline to a space (a typed
 * newline would submit early).
 *
 * web/room-reply.mjs carries a copy of excerptOf for the chip it draws before
 * the server answers; test/room-reply.test.ts holds the two to one output.
 * ========================================================================== */

import type { RoomLineEntry } from '../table/store.ts';

export const EXCERPT_MAX = 160;

export interface ReplyRef {
  /** the original entry's id */
  id: number;
  /** its kind (chat, command, attachment, voice, fact, delivery) */
  kind: string;
  /** who wrote it: a seat's @handle, the user's @name, `voice`, or null for
   *  the room itself (a fact / delivery) */
  handle: string | null;
  /** the author seat at the time (the page tones the handle by it) */
  seat: string | null;
  /** true when the person wrote it (the page says "your line") */
  user?: true;
  excerpt: string;
  /** a voice line's quote carries a mic glyph */
  voice?: true;
  /** the first image the original carried (its stored name in the room's
   *  assets; the page builds the raw route itself): a 22px thumb */
  thumb?: string;
}

/* "1." "12)" — a numbered item; "-" "*" "+" and the bullet dot — a plain one */
const NUMBERED = /^\d{1,3}[.)]\s+/;
const BULLET = new RegExp('^[-*+' + String.fromCharCode(0x2022) + ']\\s+');
const ELLIPSIS = String.fromCharCode(0x2026);
const SEP = ' ' + String.fromCharCode(0xb7) + ' ';

/** One line of text for a quote: list numbers kept, items joined with " · ",
 *  whitespace collapsed, capped at `max` (an ellipsis when cut). */
export function excerptOf(text: string | null | undefined, max = EXCERPT_MAX): string {
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

interface Attached {
  name?: unknown;
  type?: unknown;
  raw?: unknown;
}
function attachmentsOf(meta: Record<string, unknown> | null): Attached[] {
  const a = meta?.attachments;
  return Array.isArray(a) ? a.filter((x): x is Attached => !!x && typeof x === 'object') : [];
}
export function metaOf(e: Pick<RoomLineEntry, 'meta'>): Record<string, unknown> | null {
  try {
    const m = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
    return m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The quote of `e`, captured now. `userHandle` is the person's @name (an
 * entry the user wrote carries author 'user'); `seatHandle` names a seat as
 * it is NOW, falling back to the author the entry stored.
 */
export function replyRef(
  e: RoomLineEntry,
  names: { userHandle: string; seatHandle: (seatId: string) => string | null },
): ReplyRef {
  const meta = metaOf(e);
  const files = attachmentsOf(meta);
  const byRoom = e.author === 'room' && !e.author_seat;
  const byUser = e.author === 'user' && !e.author_seat;
  const handle = byRoom ? null : byUser ? names.userHandle : e.author_seat ? (names.seatHandle(e.author_seat) ?? e.author) : e.author;
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
    ...(byUser ? { user: true as const } : {}),
    excerpt,
    ...(e.kind === 'voice' ? { voice: true as const } : {}),
    ...(img ? { thumb: img.name as string } : {}),
  };
}

/** A stored `meta.reply`, when it is one (the page and the delivery read it). */
export function replyOf(meta: Record<string, unknown> | null | undefined): ReplyRef | null {
  const r = meta?.reply as ReplyRef | undefined;
  return r && typeof r === 'object' && Number.isInteger(r.id) && typeof r.excerpt === 'string' ? r : null;
}

const RETURN_ARROW = String.fromCharCode(0x21a9);

/** `↩ re #812 @author` — or `fact` for the room's own line. The LINE NUMBER is the reference: an agent already holds the
 *  line (or can read it by number), so the quoted excerpt is not repeated in what it is sent (Owner [ref]). The excerpt
 *  stays in `meta.reply` for the page's chip and the quote header a person sees. */
export function replyPrefix(r: ReplyRef): string {
  const who = r.handle === null ? 'fact' : `@${r.handle}`;
  return `${RETURN_ARROW} re #${r.id} ${who}`;
}

/**
 * THE ONE PLACE a delivered body is framed as a reply: the prefix on its own
 * first line, then the body. `reply` null = the body unchanged.
 */
export function withReply(body: string, reply: ReplyRef | null): string {
  return reply ? `${replyPrefix(reply)}\n${body}` : body;
}
