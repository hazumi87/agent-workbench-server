/* THE SCRATCHPAD INDEX (row 10; the design notes): the room's notes and files in ONE paginated, newest-first list, each with its compact ref, an honest
 * `inEngine`, and its companions folded in. Read-only; it mints nothing (ids are minted at upload and by the open-time backfill). The file store is INJECTED (`FileIo`), so the same
 * code answers on the server (a share) and locally (a folder), and a test needs no disk.
 *
 * THREE OUTCOMES for "are the bytes there": true (a file of the stored size is in the store), false (the store answered and it is not), null (the store could not be reached:
 * could-not-tell, never "gone"). A companion (annotations, a flattened copy, an agent's annotations) is NEVER its own item when its picture exists in the room; a companion whose
 * picture is missing is shown as a plain file, never hidden. */
import { table } from '../table/endpoint.ts';
import type { RoomAssetRecord, RoomNote } from '../table/endpoint.ts';
import { refOf } from './ref-grammar.ts';

export interface FileIo {
  /** bytes present in a room's store folder: path -> size; null when the store cannot be reached */
  sizes(folder: string): Promise<Map<string, number> | null>;
  /** how a client locates a stored path (store-relative locally, a share URL on a server) */
  locator(path: string): string;
}

export class IndexError extends Error {
  readonly status = 400;
  constructor(message: string, readonly field: string) {
    super(message);
  }
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const PAGE_BYTES = 240 * 1024; // under the 256 KB reply cap (REQUEST_LIMITS.replyBytes)
export const PREVIEW_CHARS = 800;

export interface Companion {
  name: string;
  kind: 'annotations' | 'annotated';
  asset_id: string;
  size: number;
  by?: string;
}
export interface IndexItem {
  ref: string;
  id: string;
  room_id: string;
  kind: 'asset' | 'note';
  name: string;
  type: string;
  size: number;
  author: string;
  created_at: number;
  modified_at: number;
  version: string;
  inEngine: boolean | null;
  residency: 'local' | 'unknown';
  batch_id: string | null;
  path: string | null;
  companions: Companion[];
  preview?: string;
}

type AssetRec = RoomAssetRecord & { added_by_handle: string };

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const ANNOTATIONS = /^(.+)\.annotations\.svg$/;
const ANNOTATIONS_BY = new RegExp(`^(.+)\\.annotations\\.(${SLUG})\\.svg$`);
const ANNOTATED = /^(.+)\.annotated\.png$/;

/** If `name` is a companion's name: the picture's name and the companion's kind. Exact-name matching only. */
export function companionOf(name: string): { base: string; kind: Companion['kind']; by?: string } | null {
  let m = ANNOTATIONS_BY.exec(name);
  if (m) {
    return { base: m[1], kind: 'annotations', by: m[2] };
  }
  m = ANNOTATIONS.exec(name);
  if (m) {
    return { base: m[1], kind: 'annotations' };
  }
  m = ANNOTATED.exec(name);
  return m ? { base: m[1], kind: 'annotated' } : null;
}

function inEngineOf(rec: AssetRec, sizes: Map<string, number> | null): boolean | null {
  if (sizes === null) {
    return null;
  }
  return sizes.get(rec.path) === rec.size;
}

export function assetItem(rec: AssetRec, sizes: Map<string, number> | null, io: FileIo, companions: Companion[]): IndexItem {
  const here = inEngineOf(rec, sizes);
  return {
    ref: refOf('asset', rec.asset_id),
    id: rec.asset_id,
    room_id: rec.room_id,
    kind: 'asset',
    name: rec.name,
    type: rec.type,
    size: rec.size,
    author: rec.added_by_handle,
    created_at: rec.added_at,
    modified_at: rec.added_at,
    version: `${rec.size}:${rec.added_at}`,
    inEngine: here,
    residency: here === true ? 'local' : 'unknown',
    batch_id: rec.batch_id ?? null,
    path: io.locator(rec.path),
    companions,
  };
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function noteItem(n: RoomNote): IndexItem {
  const first = n.text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const seat = n.created_by ? table.getSeat(n.created_by) : undefined;
  return {
    ref: refOf('note', n.id),
    id: n.id,
    room_id: n.room_id,
    kind: 'note',
    name: first.length > 80 ? `${first.slice(0, 79)}…` : first,
    type: 'text/plain',
    size: Buffer.byteLength(n.text, 'utf8'),
    author: seat ? seat.handle : 'user',
    created_at: n.created_at,
    modified_at: n.updated_at,
    version: String(n.updated_at),
    inEngine: true,
    residency: 'local',
    batch_id: null,
    path: null,
    companions: [],
    preview: flat(n.text).slice(0, PREVIEW_CHARS),
  };
}

/** Every item of one room, unsorted, with companions folded in. */
async function roomItems(roomId: string, io: FileIo): Promise<IndexItem[]> {
  const folder = table.roomAssetFolder(roomId);
  const recs = table.listAssetRecords(roomId) as AssetRec[];
  const sizes = await io.sizes(folder).catch(() => null);
  const byName = new Map(recs.map((r) => [r.name, r]));
  const folded = new Map<string, Companion[]>(); // picture name -> companions
  const isCompanion = new Set<string>(); // paths that are a companion of an EXISTING picture
  for (const r of recs) {
    const c = companionOf(r.name);
    if (!c || c.base === r.name || !byName.has(c.base)) {
      continue; // not a companion, or its picture is missing: a plain file
    }
    isCompanion.add(r.path);
    const list = folded.get(c.base) ?? [];
    list.push({ name: r.name, kind: c.kind, asset_id: r.asset_id, size: r.size, ...(c.by ? { by: c.by } : {}) });
    folded.set(c.base, list);
  }
  const items: IndexItem[] = [];
  for (const r of recs) {
    if (!isCompanion.has(r.path)) {
      items.push(assetItem(r, sizes, io, (folded.get(r.name) ?? []).sort((a, b) => a.name.localeCompare(b.name))));
    }
  }
  for (const n of table.listAllRoomNotes(roomId, false)) {
    items.push(noteItem(n));
  }
  return items;
}

const keyOf = (i: IndexItem): string => `${i.kind}:${i.id}`;
const newer = (a: IndexItem, b: IndexItem): number => b.modified_at - a.modified_at || (keyOf(a) < keyOf(b) ? 1 : keyOf(a) > keyOf(b) ? -1 : 0);

function decodeCursor(c: string): { m: number; k: string } {
  if (c.length > 512) {
    throw new IndexError('cursor is an opaque value of at most 512 bytes', 'cursor');
  }
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (o && typeof o.m === 'number' && Number.isFinite(o.m) && typeof o.k === 'string' && o.k.length <= 64) {
      return { m: o.m, k: o.k };
    }
  } catch {
    /* falls through */
  }
  throw new IndexError('cursor is not one this index issued', 'cursor');
}
const encodeCursor = (i: IndexItem): string => Buffer.from(JSON.stringify({ m: i.modified_at, k: keyOf(i) })).toString('base64url');

export interface IndexPage {
  items: IndexItem[];
  next_cursor: string | null;
  total: number;
}

/** One bounded page. Scope is the ROOM by default; `family` adds the room's whole family. The cursor is a position (modified_at, key), so a note added after page one cannot shift page two. */
export async function indexPage(
  roomId: string,
  opts: { scope?: 'room' | 'family'; limit?: number; cursor?: string | null; maxBytes?: number },
  io: FileIo,
): Promise<IndexPage> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(opts.limit) || DEFAULT_LIMIT)));
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rooms = opts.scope === 'family' ? table.familyRoomIds(roomId) : [roomId];
  const all = (await Promise.all(rooms.map((r) => roomItems(r, io)))).flat().sort(newer);
  const rest = after ? all.filter((i) => i.modified_at < after.m || (i.modified_at === after.m && keyOf(i) < after.k)) : all;
  const budget = opts.maxBytes ?? PAGE_BYTES;
  const items: IndexItem[] = [];
  let bytes = 0;
  for (const it of rest.slice(0, limit)) {
    const n = JSON.stringify(it).length + 1;
    if (items.length > 0 && bytes + n > budget) {
      break; // end the page early with a cursor rather than cut an item or exceed the reply cap
    }
    items.push(it);
    bytes += n;
  }
  return { items, next_cursor: items.length < rest.length ? encodeCursor(items[items.length - 1]) : null, total: all.length };
}
