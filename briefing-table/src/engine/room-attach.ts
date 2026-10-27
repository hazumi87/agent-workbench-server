/* ============================================================================
 * ROOM COMPOSER ATTACHMENTS [ticket] — the pure parts: what an agent is told
 * about a sent file, and which room panel is "the Assets panel".
 *
 * An agent never gets bytes and never a path a person had to paste: it gets
 * the message text plus ONE line per file — name, type, size and the SAME
 * reference room-assets' "Copy reference" produces (agent-share's absolute
 * raw URL for the asset, share.refUrl). The human sees thumbnails instead.
 * ========================================================================== */

export interface SentAttachment {
  /** As stored in the room's assets (agent-share renames a collision to name-1). */
  name: string;
  /** agent-share ref, `rooms/<slug>-<id8>/<name>`. Absent on a note that stayed in the database. */
  path?: string;
  /** The reference: agent-share's raw URL for `path` (room-assets' "Copy reference"). Absent with `path`. */
  url?: string;
  /** The engine's own route to the bytes, for the room page (never shown as text). */
  raw: string;
  type: string;
  size: number;
  /** `note` when the file is a room note's snapshot (the line shows a note, not a file). */
  kind?: 'note';
  /** A note's first ~40 characters, whitespace collapsed. */
  title?: string;
  words?: number;
  /** A note that stayed in the database (room_notes_sent): read it by this id, there is no file. */
  sent_id?: string;
}

/** The ONE place that says how an agent reads a sent note: the fabric MCP verb
 *  `room_note` first (any agent with the fabric tools), then the script and
 *  the route for agents without it. `base` is HARBOR_WB_PUBLIC_URL when the
 *  engine is told how it is reached from outside. */
export function noteReadHint(roomId: string, sentId: string, base: string | null = publicBase()): string {
  const path = `/api/rooms/${encodeURIComponent(roomId)}/notes/sent/${sentId}`;
  return `read: fabric room_note id=${sentId}, or scripts/room-note.sh ${roomId} ${sentId} (briefing-table), or GET ${base ? base + path : path}`;
}

function publicBase(): string | null {
  const b = (process.env.HARBOR_WB_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return b || null;
}

/** The page's and the agents' route to a sent note's text (the raw one is text/plain). */
export function sentNoteRawPath(roomId: string, sentId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/notes/sent/${sentId}/raw`;
}

/** 312 KB, 1.2 MB, 840 B — the size a person reads. */
export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '?';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The body an AGENT receives: the text, then the reference block. An
 *  attachments-only message is the block alone. */
export function agentBody(text: string, files: SentAttachment[], roomId = ''): string {
  if (!files.length) {
    return text;
  }
  const inDb = (f: SentAttachment): boolean => !!f.sent_id;
  const head = files.every(inDb) ? `attachments (${files.length}):` : `attachments (${files.length}, in room assets):`;
  /* ticket (Owner 2026-10-02): with 2+ files each line leads with its number `[n] `, the same 1..N the
     human sees on the tiles (message order); one file keeps the plain dash. */
  const lead = (i: number): string => (files.length >= 2 ? `[${i + 1}] ` : '- ');
  const lines = files.map((f, i) =>
    inDb(f)
      ? `${lead(i)}note: "${f.title ?? ''}" · ${(f.words ?? 0).toLocaleString('en-US')} words · ${noteReadHint(roomId, f.sent_id!)}`
      : `${lead(i)}${f.kind === 'note' ? `note: "${f.title ?? ''}"` : f.name} · ${f.type} · ${fmtSize(f.size)} · ${f.url}`,
  );
  return [...(text ? [text] : []), head, ...lines].join('\n');
}

/** Is this room panel an Assets panel — registered on ANY seat, or as the
 *  user? room-assets registers it with icon `assets` and title "Assets"
 *  (tools/room-assets register-panel); a panel pointing at room-assets' own
 *  view of this room counts whatever it is called. The view PATH alone is not
 *  enough: sibling apps serve the same /rooms/<id>/view on their own ports. */
export function isAssetsPanel(p: { icon?: string | null; title?: string | null; url?: string | null }, roomId?: string): boolean {
  if (p.icon === 'assets' || (p.title ?? '').trim().toLowerCase() === 'assets') {
    return true;
  }
  if (!roomId || typeof p.url !== 'string') {
    return false;
  }
  try {
    const u = new URL(p.url);
    const want = new URL(assetsPanelUrl(roomId));
    return u.host === want.host && u.pathname.replace(/\/+$/, '') === want.pathname;
  } catch {
    return false;
  }
}

/** Where room-assets serves a room's panel view (its fixed port on the server). */
export function assetsPanelUrl(roomId: string): string {
  const base = (process.env.HARBOR_WB_ROOM_ASSETS_URL || 'http://127.0.0.1:8206').replace(/\/+$/, '');
  return `${base}/rooms/${encodeURIComponent(roomId)}/view`;
}
