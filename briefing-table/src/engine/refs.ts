/* refState: does a compact ref point at something the asker may see? WRITTEN ONCE and called by BOTH the index (inEngine) and the resolver, so a list and a line delivery cannot
 * disagree (the design notes section 3, design review's correction: "found" = the row AND the bytes, the SAME check as the index). The asker's scope is the set of
 * room ids of their family; the engine never trusts a client's claim of it. */
import { table } from '../table/endpoint.ts';
import { parseRef, refOf } from './ref-grammar.ts';
import type { RefKind } from './ref-grammar.ts';
import { assetItem, noteItem, type FileIo, type IndexItem } from './scratch-index.ts';

export { parseRef, refOf } from './ref-grammar.ts';
export type { RefKind, ParsedRef } from './ref-grammar.ts';

export type RefState =
  | { state: 'found'; ref: string; kind: RefKind; item: IndexItem | { ref: string; kind: 'line'; id: string; room_id: string } }
  | { state: 'missing'; ref: string }
  | { state: 'refused'; ref: string; reason: 'outside-family' }
  | { state: 'unknown'; ref: string; reason: 'store-unreachable' };

/** The ROW half of the check, synchronous: does the ref name something in the asker's scope? Line delivery (sync) uses this alone; refState adds the bytes. */
export type RefRow =
  | { state: 'found'; kind: 'asset'; rec: NonNullable<ReturnType<typeof table.assetById>> }
  | { state: 'found'; kind: 'note'; note: NonNullable<ReturnType<typeof table.getRoomNote>> }
  | { state: 'found'; kind: 'line'; roomId: string }
  | { state: 'missing' }
  | { state: 'refused'; reason: 'outside-family' };

export function refRow(ref: string, scope: ReadonlySet<string>): RefRow {
  const p = parseRef(ref);
  if (!p) {
    return { state: 'missing' };
  }
  if (p.kind === 'asset') {
    const rec = table.assetById(p.id);
    if (!rec) {
      return { state: 'missing' };
    }
    return scope.has(rec.room_id) ? { state: 'found', kind: 'asset', rec } : { state: 'refused', reason: 'outside-family' };
  }
  if (p.kind === 'note') {
    for (const rid of scope) {
      const note = table.getRoomNote(rid, p.id);
      if (note) {
        return { state: 'found', kind: 'note', note };
      }
    }
    for (const r of table.listRooms({})) {
      if (!scope.has(r.id) && table.getRoomNote(r.id, p.id)) {
        return { state: 'refused', reason: 'outside-family' };
      }
    }
    return { state: 'missing' };
  }
  const entry = table.getLineEntry(Number(p.id));
  if (!entry) {
    return { state: 'missing' };
  }
  return scope.has(entry.room_id) ? { state: 'found', kind: 'line', roomId: entry.room_id } : { state: 'refused', reason: 'outside-family' };
}

export async function refState(ref: string, scope: ReadonlySet<string>, io: FileIo): Promise<RefState> {
  const row = refRow(ref, scope);
  if (row.state === 'missing') {
    return { state: 'missing', ref };
  }
  if (row.state === 'refused') {
    return { state: 'refused', ref, reason: row.reason };
  }
  if (row.kind === 'asset') {
    const sizes = await io.sizes(table.roomAssetFolder(row.rec.room_id)).catch(() => null);
    if (sizes === null) {
      return { state: 'unknown', ref, reason: 'store-unreachable' };
    }
    if (sizes.get(row.rec.path) !== row.rec.size) {
      return { state: 'missing', ref };
    }
    return { state: 'found', ref, kind: 'asset', item: assetItem(row.rec, sizes, io, []) };
  }
  if (row.kind === 'note') {
    return { state: 'found', ref, kind: 'note', item: noteItem(row.note) };
  }
  const id = String(parseRef(ref)!.id);
  return { state: 'found', ref: refOf('line', id), kind: 'line', item: { ref: refOf('line', id), kind: 'line', id, room_id: row.roomId } };
}
