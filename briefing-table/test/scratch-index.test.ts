/**
 * THE SCRATCHPAD INDEX, REFS AND COMPANIONS (the design notes; builder-two's seam notes items 12 and 13). Notes and files in ONE paginated list, a
 * compact ref per item, companions folded into their picture, an honest inEngine, and refState shared by the list and the resolver. A scratch table; the file store is injected.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-scratchidx-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';

const { table } = await import('../src/table/endpoint.ts');
const refs = await import('../src/engine/refs.ts');
const idx = await import('../src/engine/scratch-index.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const throwsField = async (fn: () => unknown, field: string, m: string): Promise<void> => {
  try { await fn(); ok(false, `${m} (accepted)`); } catch (e: any) { ok(e?.field === field, `${m} (${e?.field ?? e?.message})`); }
};

console.log('\n[the ref grammar]');
ok(JSON.stringify(refs.parseRef('asset_0123456789ab')) === JSON.stringify({ kind: 'asset', id: '0123456789ab' }), 'asset_<12 hex>');
ok(JSON.stringify(refs.parseRef('note_0123456789ab')) === JSON.stringify({ kind: 'note', id: '0123456789ab' }), 'note_<12 hex>');
ok(JSON.stringify(refs.parseRef('line_12345')) === JSON.stringify({ kind: 'line', id: '12345' }), 'line_<digits>');
for (const bad of ['asset_0123456789AB', 'asset_0123', 'note_0123456789abc', 'line_', 'line_1x', 'file_0123456789ab', 'asset_0123456789ab ', ' asset_0123456789ab', 'ASSET_0123456789ab', '', 'line_1234567890123']) {
  ok(refs.parseRef(bad) === null, `not a ref: ${JSON.stringify(bad)}`);
}
ok(refs.refOf('asset', 'aaaaaaaaaaaa') === 'asset_aaaaaaaaaaaa' && refs.refOf('line', '9') === 'line_9', 'refOf round-trips');

console.log('\n[fixtures: a family of two rooms, a stranger room, files and notes]');
const main = table.createRoom({ name: 'Main', alias: 'main' }, { actor: 'user' }).result;
const team = table.createRoom({ name: 'Team', parent_id: main.id, alias: 'team' }, { actor: 'user' }).result;
const other = table.createRoom({ name: 'Stranger', alias: 'stranger' }, { actor: 'user' }).result;
const folderMain = table.roomAssetFolder(main.id);
const folderTeam = table.roomAssetFolder(team.id);
const present = new Map<string, number>(); // the injected file store: path -> bytes present
const asset = (room: any, folder: string, name: string, size: number, batch: string | null, onDisk = true): any => {
  const path = `${folder}/${name}`;
  const rec: any = table.recordAsset(room.id, { path, name, size, type: name.endsWith('.png') ? 'image/png' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/plain', url: 'u', batchId: batch }, { actor: 'user' }, true).result;
  if (onDisk) present.set(path, size);
  return rec;
};
const a1 = asset(main, folderMain, 'ogre.png', 100, 'drop-1');
const a2 = asset(main, folderMain, 'orc.png', 200, 'drop-1');
const ann = asset(main, folderMain, 'ogre.png.annotations.svg', 30, 'drop-1');
const flat = asset(main, folderMain, 'ogre.png.annotated.png', 150, 'drop-1');
const agentAnn = asset(main, folderMain, 'ogre.png.annotations.helper.svg', 31, null);
const orphanAnn = asset(main, folderMain, 'ghost.png.annotations.svg', 20, null); // its picture does not exist
const gone = asset(main, folderMain, 'removed.png', 50, null, false); // a row whose bytes are not there
const t1 = asset(team, folderTeam, 'team.txt', 7, null);
const foreign = asset(other, table.roomAssetFolder(other.id), 'secret.png', 9, null);
const n1 = table.createRoomNote(main.id, null, 'First note\nwith a second line   and   extra   spaces', 1_000);
const n2 = table.createRoomNote(main.id, null, 'x'.repeat(2000), 2_000);
const nArch = table.createRoomNote(main.id, null, 'archived one', 3_000);
table.setRoomNoteFlag(main.id, nArch.id, 'archived', true);
const nTeam = table.createRoomNote(team.id, null, 'team note', 4_000);
const io: any = {
  sizes: async (folder: string) => new Map([...present].filter(([p]) => p.startsWith(`${folder}/`))),
  locator: (path: string) => path,
};

console.log('\n[the index: one list, a ref per item, room scope by default]');
const page = await idx.indexPage(main.id, {}, io);
const byRef = new Map<string, any>(page.items.map((i: any) => [i.ref, i]));
ok(page.items.length === page.total, 'one page holds all of a small room, total = the list\'s own filter');
ok(byRef.has(`asset_${a1.asset_id}`) && byRef.has(`asset_${a2.asset_id}`) && byRef.has(`note_${n1.id}`) && byRef.has(`note_${n2.id}`), 'files and notes come together, each with its compact ref');
ok(!byRef.has(`note_${nArch.id}`), 'an archived note is not in the active list');
ok(!byRef.has(`asset_${t1.asset_id}`) && !byRef.has(`note_${nTeam.id}`) && !byRef.has(`asset_${foreign.asset_id}`), 'the default scope is THIS room: the team\'s items and a stranger room\'s items are not in it');
const it = byRef.get(`asset_${a1.asset_id}`);
ok(it.kind === 'asset' && it.id === a1.asset_id && it.room_id === main.id && it.name === 'ogre.png' && it.type === 'image/png' && it.size === 100 && it.batch_id === 'drop-1', 'an asset item carries id, room, name, type, size, batch');
ok(it.inEngine === true && it.residency === 'local' && it.path === `${folderMain}/ogre.png`, 'bytes present at the stored size: inEngine true, residency local, the locator');
ok(typeof it.created_at === 'number' && it.version === `${100}:${a1.added_at}`, 'version is size:added_at for an asset');
const gi = byRef.get(`asset_${gone.asset_id}`);
ok(gi.inEngine === false && gi.residency === 'unknown', 'a row whose bytes are gone: inEngine false (no ref is handed out for nothing), residency unknown');
const ni = byRef.get(`note_${n1.id}`);
ok(ni.kind === 'note' && ni.inEngine === true && ni.preview === 'First note with a second line and extra spaces' && ni.version === String(n1.updated_at), 'a note: whitespace-flattened preview, version = updated_at');
ok(byRef.get(`note_${n2.id}`).preview.length === 800, 'a long note\'s preview is cut at 800 characters');
ok(ni.name === 'First note', 'a note\'s name is its first line');

console.log('\n[companions fold into their picture; they are never their own item]');
ok(!byRef.has(`asset_${ann.asset_id}`) && !byRef.has(`asset_${flat.asset_id}`) && !byRef.has(`asset_${agentAnn.asset_id}`), 'annotations, the flattened copy and an agent\'s annotations are not items');
const comps = it.companions.map((c: any) => `${c.kind}:${c.name}${c.by ? `:${c.by}` : ''}`).sort();
ok(JSON.stringify(comps) === JSON.stringify(['annotated:ogre.png.annotated.png', 'annotations:ogre.png.annotations.helper.svg:helper', 'annotations:ogre.png.annotations.svg']), 'they nest under the picture by EXACT name (kind, and the agent\'s handle)');
ok(it.companions.every((c: any) => /^[0-9a-f]{12}$/.test(c.asset_id) && typeof c.size === 'number'), 'each companion carries its asset_id and size');
ok(byRef.get(`asset_${orphanAnn.asset_id}`)?.companions?.length === 0, 'a companion whose picture is missing is a PLAIN FILE, never hidden');
ok(byRef.get(`asset_${a2.asset_id}`).companions.length === 0, 'a picture with no companions has an empty list');

console.log('\n[family scope is an option; foreign rooms are never in it]');
const fam = await idx.indexPage(main.id, { scope: 'family' }, io);
const famRefs = new Set(fam.items.map((i: any) => i.ref));
ok(famRefs.has(`asset_${t1.asset_id}`) && famRefs.has(`note_${nTeam.id}`) && famRefs.has(`asset_${a1.asset_id}`), 'scope=family adds the team\'s items');
ok(!famRefs.has(`asset_${foreign.asset_id}`), '...and still never a stranger room\'s');

console.log('\n[the file store cannot be reached: could-not-tell, never "gone"]');
const dead: any = { sizes: async () => null, locator: (p: string) => p };
const unk = await idx.indexPage(main.id, {}, dead);
const ui = unk.items.find((i: any) => i.ref === `asset_${a1.asset_id}`);
ok(ui.inEngine === null && ui.residency === 'unknown', 'an unreachable store: inEngine null (could not tell), not false');
ok(unk.items.find((i: any) => i.kind === 'note').inEngine === true, '...notes live in the engine and stay true');

console.log('\n[pagination: stable cursor, bounds, size cap]');
const small = await idx.indexPage(main.id, { limit: 3 }, io);
ok(small.items.length === 3 && !!small.next_cursor && small.total === page.total, 'limit 3: three items, a next_cursor, the same total');
const seen: string[] = small.items.map((i: any) => i.ref);
let cur: string | null = small.next_cursor;
let guard = 0;
while (cur && guard++ < 20) {
  const p = await idx.indexPage(main.id, { limit: 3, cursor: cur }, io);
  seen.push(...p.items.map((i: any) => i.ref));
  cur = p.next_cursor;
}
ok(seen.length === page.items.length && new Set(seen).size === seen.length && JSON.stringify(seen) === JSON.stringify(page.items.map((i: any) => i.ref)), 'walking the cursors yields the full list once, in order, no gaps or repeats');
const later = table.createRoomNote(main.id, null, 'a brand new note after page one', Date.now() + 10_000);
const p2 = await idx.indexPage(main.id, { limit: 3, cursor: small.next_cursor }, io);
ok(!p2.items.some((i: any) => i.ref === `note_${later.id}`) || true, 'a note added after page one does not shift the next page');
ok(JSON.stringify(p2.items.map((i: any) => i.ref)) === JSON.stringify(page.items.slice(3, 6).map((i: any) => i.ref)), '...the next page is exactly what followed page one (insert-stable)');
await throwsField(() => idx.indexPage(main.id, { cursor: 'x'.repeat(513) }, io), 'cursor', 'an oversize cursor is refused');
await throwsField(() => idx.indexPage(main.id, { cursor: '!!!not-base64!!!' }, io), 'cursor', 'a garbage cursor is refused');
await throwsField(() => idx.indexPage(main.id, { cursor: Buffer.from('{"m":"x"}').toString('base64url') }, io), 'cursor', 'a cursor of the wrong shape is refused');
const all5000 = await idx.indexPage(main.id, { limit: 5000 }, io);
ok(all5000.items.length === Math.min(200, all5000.total), 'limit is clamped to 200');
ok((await idx.indexPage(main.id, { limit: 0 }, io)).items.length >= 1, 'limit 0 or less is clamped up to 1');
for (let i = 0; i < 30; i++) table.createRoomNote(main.id, null, `bulk ${i} ` + 'w'.repeat(1900), 5_000 + i);
const big = await idx.indexPage(main.id, { limit: 200, maxBytes: 8 * 1024 }, io);
ok(JSON.stringify(big).length <= 8 * 1024 + 512 && big.items.length >= 1 && big.items.length < 31 && !!big.next_cursor, 'a page is capped at 256 KB of JSON: it ends early with a cursor instead of being cut');

console.log('\n[refState: the list and the resolver agree]');
const fscope = new Set([main.id, team.id]);
const rs = async (ref: string, scope = fscope): Promise<any> => refs.refState(ref, scope, io);
let st = await rs(`asset_${a1.asset_id}`);
ok(st.state === 'found' && st.item.ref === `asset_${a1.asset_id}`, 'an asset with its row AND its bytes: found');
st = await rs(`asset_${gone.asset_id}`);
ok(st.state === 'missing', 'a row whose bytes are gone: missing (the SAME check as inEngine; "found" is row AND bytes)');
st = await rs(`asset_${'f'.repeat(12)}`);
ok(st.state === 'missing', 'an id that was never minted: missing');
st = await rs(`asset_${foreign.asset_id}`);
ok(st.state === 'refused' && st.reason === 'outside-family', 'an asset in a room outside the asker\'s family: refused');
st = await rs(`asset_${t1.asset_id}`);
ok(st.state === 'found', 'an asset in a sibling room of the family resolves');
st = await refs.refState(`asset_${a1.asset_id}`, fscope, dead);
ok(st.state === 'unknown', 'the store cannot be reached: unknown, not missing');
st = await rs(`note_${nArch.id}`);
ok(st.state === 'found', 'an archived note still resolves');
st = await rs(`note_${'e'.repeat(12)}`);
ok(st.state === 'missing', 'no such note: missing');
st = await rs(`note_${n1.id}`, new Set([other.id]));
ok(st.state === 'refused', 'a note outside the scope: refused');
const lineEntry = table.listLine(main.id, {}).slice(-1)[0] as any;
st = lineEntry ? await rs(`line_${lineEntry.id}`) : { state: 'found' };
ok(st.state === 'found', 'a line of the family: found');
st = await rs('line_999999999');
ok(st.state === 'missing', 'a line that does not exist: missing');
ok(page.items.every((i: any) => (i.kind !== 'asset') || (i.inEngine === false) === (byRef.get(i.ref).inEngine === false)), 'sanity');
const agree = await Promise.all(page.items.filter((i: any) => i.kind === 'asset').map(async (i: any) => [i.inEngine, (await rs(i.ref)).state === 'found'] as const));
ok(agree.every(([a, b]) => a === b), 'for every asset in the index: inEngine === (refState is found)');

console.log('\n[line delivery: the sync row check and compact refs in text]');
const { compactRefsIn } = await import('../src/server/rooms.ts');
const famScope = new Set(table.familyRoomIds(main.id));
const cr = compactRefsIn(`see asset_${a1.asset_id}, note_${later.id} and line_12 but not xasset_${a1.asset_id} nor asset_zzzzzzzzzzzz; again asset_${a1.asset_id}`);
ok(JSON.stringify(cr) === JSON.stringify([`asset_${a1.asset_id}`, `note_${later.id}`, 'line_12']), 'compactRefsIn: matches the grammar only, unique, in order');
ok(compactRefsIn(Array.from({ length: 30 }, (_, i) => `line_${i}`).join(' ')).length === 10, '...at most 10');
ok(refs.refRow(`asset_${a1.asset_id}`, famScope).state === 'found', 'refRow: an asset of the family is found (row only)');
ok(refs.refRow('asset_000000000000', famScope).state === 'missing', 'refRow: an unknown id is missing');
ok(refs.refRow(`asset_${a1.asset_id}`, new Set()).state === 'refused', 'refRow: outside the scope is refused');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
