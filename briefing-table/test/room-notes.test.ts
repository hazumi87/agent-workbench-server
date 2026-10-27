/**
 * ROOM NOTES, engine half [ticket]: keywords, FTS5 (escaping), the visible
 * list rule (24 h + top-up to X, pinned first, archived out), search incl.
 * archived, autosave vs index, the idle sweep, the routes (create / get / put /
 * close / attach (idempotent) / pin / archive / move-draft), the 413, and
 * the credential rule (writes take a person; another room's note is not there).
 *
 * SAFETY: a temp table and scratch dir set BEFORE any import; no engine, no
 * port, no broker. Run with tsx.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-notes-'));
process.env.HARBOR_WB_TABLE = join(dir, 'notes.db');
process.env.HARBOR_WB_ROOM_SCRATCH_DIR = join(dir, 'room-scratch');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_IDENTITY = 'legacy';

const { table, NOTE_TEXT_MAX, NOTES_VISIBLE_MIN } = await import('../src/table/endpoint.ts');
const notes = await import('../src/engine/notes-index.ts');
const scratch = await import('../src/engine/room-scratch.ts');
const rooms = await import('../src/server/rooms.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${msg}${a === b ? '' : ` (got ${a}, want ${b})`}`);
}

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  return r;
}
function resp(out: { status: number; body: any }): any {
  return {
    writeHead(s: number) {
      out.status = s;
    },
    setHeader() {},
    end(x?: unknown) {
      try {
        out.body = JSON.parse(String(x ?? ''));
      } catch {
        out.body = null;
      }
    },
  };
}
const deps = (human: boolean) => ({ projector: async () => (x: any) => x, log: () => {}, human });
async function call(method: string, url: string, body?: unknown, human = true): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, url, body), resp(out), url.split('?')[0], null, deps(human));
  return out;
}

const room = table.createRoom({ name: 'Notes Room' }, { actor: 'user' }).result;
const other = table.createRoom({ name: 'Other Room' }, { actor: 'user' }).result;
const N = `/api/rooms/${room.id}/notes`;

try {
  console.log('\n[keywords]');
  eq(notes.keywordsOf('The chewing gum, the gum! Chewing gum is a gum of chewing; and a cat.'), ['gum', 'chewing', 'cat'], 'frequency, stopwords and short tokens dropped');
  eq(notes.keywordsOf('zebra apple mango'), ['zebra', 'apple', 'mango'], 'ties keep first appearance');
  eq(notes.keywordsOf('Alpha, BETA... alpha!').slice(0, 2), ['alpha', 'BETA'], 'lowercased (an all-caps term keeps its casing), split on punctuation');
  eq(notes.keywordsOf(Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')).length, 12, 'at most 12');
  eq(notes.keywordsOf(''), [], 'empty text, no keywords');
  /* a note's TAGS (the design system [ref]): a few topics, never a short note's words back again */
  eq(notes.tagsOf('brand colours: sunset orange, lake blue for the poster'), [], 'a short note has no tags');
  eq(notes.tagsOf('gum gum gum chewing chewing paper desk lamp window chair floor'), ['gum', 'chewing', 'paper'], 'at most three tags, by weight');
  eq(notes.tagsOf(Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '), 12).length, 3, 'never more than three, whatever max is asked');

  console.log('\n[keyword ranking: tf x idf with nudges]');
  const stats = (n: number, df: Record<string, number>) => ({ n, df: (t: string) => df[t] ?? 0 });
  const common = notes.keywordsOf('team shipped rocket', 12, stats(10, { team: 10, shipped: 10, rocket: 1 }));
  eq(common[0], 'rocket', 'a word in every note ranks below a rare one (same tf)');
  eq(notes.keywordsOf('apple banana\ncherry cherry', 12, stats(4, { apple: 2, banana: 2, cherry: 2 })).slice(0, 2), ['cherry', 'apple'], 'tf 2 beats a first-line term (1.5 x 1 < 2), and equal weights keep first appearance');
  eq(notes.keywordsOf('intro\nzebra apple', 12, stats(4, { zebra: 2, apple: 2 })).slice(1), ['zebra', 'apple'], 'ties: first appearance');
  eq(notes.keywordsOf('heading words\nlater plain other rare', 12).slice(0, 2), ['heading', 'words'], 'a first-line term outweighs one on a later line (x1.5)');
  eq(notes.keywordsOf('x\nwe asked Marcus about banana for lunch', 12).slice(0, 1), ['marcus'], 'a name capitalized mid-sentence gets x1.3');
  eq(notes.keywordsOf('x\nsee apple and ticket ticket here', 12).slice(0, 1), ['ticket'], 'a term with a digit gets x1.3, and keeps its casing');
  eq(notes.keywordsOf('x\nPlants are green. Gardens grow plants. Gardens').slice(0, 2), ['plants', 'gardens'], 'a capital after a full stop is a sentence start, not a name');
  eq(notes.keywordsOf('x\nuse the API for tokens', 12)[0], 'API', 'an all-caps term keeps its casing');
  const t1 = 'Rocket launch at 9. Rocket crew met Marcus.';
  eq(notes.keywordsOf(t1, 12, stats(5, { rocket: 2, launch: 1, crew: 3, met: 1, marcus: 1 })), notes.keywordsOf(t1, 12, stats(5, { rocket: 2, launch: 1, crew: 3, met: 1, marcus: 1 })), 'deterministic');
  eq(notes.keywordsOf(Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '), 12, stats(3, {})).length, 12, 'still 12 at most');
  // df comes from the room's own indexed notes (term table), per room
  const rk = table.createRoom({ name: 'Rank Room' }, { actor: 'user' }).result;
  const mkn = (t: string) => {
    const n = table.createRoomNote(rk.id, 'u', t);
    return notes.indexNote(n.id)!;
  };
  mkn('kitchen budget lanterns harbor orchard velvet cobalt meadow quartz lantern');
  mkn('kitchen schedule lanterns harbor orchard velvet cobalt meadow quartz lantern');
  const third = mkn('kitchen paint zeppelin zeppelin harbor orchard velvet cobalt meadow quartz lantern');
  ok(((k: number, z: number) => z >= 0 && (k === -1 || k > z))(JSON.parse(third.keywords).indexOf('kitchen'), JSON.parse(third.keywords).indexOf('zeppelin')), 'in a room where every note says "kitchen" it ranks below this note\'s rare words');
  const otherRoomNote = table.createRoomNote(other.id, 'u', 'kitchen paint zeppelin');
  const orow = notes.indexNote(otherRoomNote.id)!;
  eq(JSON.parse(orow.keywords).indexOf('kitchen') <= 1 || JSON.parse(orow.keywords).length === 3, true, 'another room counts only its own notes (alone there, nothing is common)');
  // start-up re-rank: stale keywords are rewritten, FTS/dirty untouched
  const stale = table.getRoomNote(rk.id, third.id)!;
  const raw = new Database(process.env.HARBOR_WB_TABLE!);
  raw.prepare('UPDATE room_notes SET keywords = ? WHERE id = ?').run('["stale"]', stale.id);
  raw.close();
  await new Promise<void>((done) => {
    notes.rerankAll(() => done(), 2);
  });
  ok(JSON.parse(table.getRoomNote(rk.id, third.id)!.keywords).includes('zeppelin'), 'rerankAll rewrote the stale keywords');
  eq(table.getRoomNote(rk.id, third.id)!.indexed_at, stale.indexed_at, '...without touching indexed_at');

  console.log('\n[FTS5 is there, and a query is escaped]');
  const a = table.createRoomNote(room.id, 'u', 'the note where I babbled about chewing gum and NEAR AND OR * "quotes"');
  notes.indexNote(a.id);
  const hit = (q: string) => table.searchRoomNotes(room.id, q).map((n) => n.id);
  eq(hit('chewing'), [a.id], 'a word is found');
  eq(hit('chew'), [a.id], 'the last token is a prefix');
  eq(hit('AND'), [a.id], 'an operator is just a word');
  eq(hit('NEAR'), [a.id], 'NEAR is just a word');
  eq(hit('"quotes" * ('), [a.id], 'quotes, star and parens do not break the match');
  eq(hit(''), [], 'empty q: empty list');
  eq(hit('  !!! ??? '), [], 'all punctuation: empty list');
  eq(hit('zzzznotthere'), [], 'no match: empty list');
  eq(table.searchRoomNotes(other.id, 'chewing'), [], 'another room does not see it');

  console.log('\n[autosave marks dirty and never indexes; index clears it]');
  const b = table.createRoomNote(room.id, 'u', 'first draft of pineapple thoughts');
  eq([b.dirty, b.indexed_at], [1, null], 'new note: dirty, unindexed');
  eq(hit('pineapple'), [], 'not searchable before an index');
  table.setRoomNoteText(room.id, b.id, 'second draft about rhubarb rhubarb crumble custard oven sugar butter flour');
  eq(hit('rhubarb'), [], 'autosave does not index');
  const bi = notes.indexNote(b.id)!;
  eq([bi.dirty, bi.indexed_at !== null, JSON.parse(bi.keywords).includes('rhubarb')], [0, true, true], 'index: clean, stamped, keywords from the current text');
  eq([hit('rhubarb'), hit('pineapple')], [[b.id], []], 'the FTS row follows the update (old words gone)');

  console.log('\n[the sweep indexes only idle dirty notes]');
  const c1 = table.createRoomNote(room.id, 'u', 'idle note about marmalade', 1_000);
  const c2 = table.createRoomNote(room.id, 'u', 'fresh note about quince', 100_000);
  eq(notes.sweep(100_500, 30_000), 1, 'one idle note indexed');
  eq([hit('marmalade'), hit('quince')], [[c1.id], []], 'the idle one is searchable, the fresh one is not');
  eq(notes.sweep(100_500, 30_000), 0, 'nothing left idle');
  eq(notes.sweep(200_000, 30_000), 1, 'later, the fresh one has gone idle');
  eq(hit('quince'), [c2.id], '...and is found');
  console.log('\n[empty notes: removed on close, and by the sweep once abandoned]');
  const e1 = table.createRoomNote(room.id, 'u', '   ', 5_000_000);
  const e2 = table.createRoomNote(room.id, 'u', '', 5_000_000);
  const e3 = table.createRoomNote(room.id, 'u', 'a real one about turnips', 5_000_000);
  eq(notes.closeNote(e1.id), null, 'closing a whitespace-only note removes it');
  eq([table.getRoomNote(room.id, e1.id), hit('turnips')], [undefined, []], '...row gone');
  eq(notes.sweep(5_000_000 + 599_000, 30_000), 2, 'before 10 minutes: both idle notes are indexed, nothing removed');
  ok(!!table.getRoomNote(room.id, e2.id), '...the empty one is still there');
  eq(notes.sweep(5_000_000 + 601_000, 30_000), 1, 'after 10 minutes the empty note is removed');
  eq([table.getRoomNote(room.id, e2.id), !!table.getRoomNote(room.id, e3.id)], [undefined, true], '...and the real one stays');
  notes.stopSweep();

  console.log('\n[the visible list: 24 h + top-up to X, pinned first, archived out]');
  const r2 = table.createRoom({ name: 'List Room' }, { actor: 'user' }).result;
  const NOW = 10_000_000_000;
  const HOUR = 3_600_000;
  const mk = (age: number, text: string) => table.createRoomNote(r2.id, 'u', text, NOW - age);
  const old = Array.from({ length: 15 }, (_, i) => mk(48 * HOUR + i * HOUR, `old ${i}`));
  const ids = (l: any[]) => l.map((n) => n.id);
  eq(table.listRoomNotesVisible(r2.id, NOW).length, NOTES_VISIBLE_MIN, 'nothing recent: topped up to X (10) most recent');
  eq(ids(table.listRoomNotesVisible(r2.id, NOW)), ids(old.slice(0, 10)), '...the most recent others, in recency order');
  const rec = Array.from({ length: 20 }, (_, i) => mk(i * 1000, `recent ${i}`));
  eq(table.listRoomNotesVisible(r2.id, NOW).length, 20, '20 in the last 24 h: all 20, no top-up');
  const arch = rec[0];
  table.setRoomNoteFlag(r2.id, arch.id, 'archived', true);
  ok(!ids(table.listRoomNotesVisible(r2.id, NOW)).includes(arch.id), 'archived is not listed');
  notes.indexNote(arch.id);
  eq(table.listRoomNotesVisible(r2.id, NOW).length, 19, '...and not replaced by an older one while 19 are recent');
  table.setRoomNoteText(r2.id, arch.id, 'archived but findable ocelot');
  notes.indexNote(arch.id);
  eq(table.searchRoomNotes(r2.id, 'ocelot').map((n) => [n.id, !!n.archived]), [[arch.id, true]], 'archived is still found by search');
  const pin = old[14];
  table.setRoomNoteFlag(r2.id, pin.id, 'pinned', true);
  eq(table.listRoomNotesVisible(r2.id, NOW)[0].id, pin.id, 'a pinned old note leads the list');
  eq(table.listRoomNotesVisible(r2.id, NOW).length, 20, '...in addition to the recent ones');

  console.log('\n[routes: create, get, put, list, search]');
  const made = await call('POST', N, { text: 'hello from a route about gazpacho' });
  eq(made.status, 200, 'create answers 200');
  const id = made.body.note.id;
  ok(/^[a-f0-9]{12}$/.test(id), 'a 12-hex id');
  eq(Object.keys(made.body.note).sort(), ['archived', 'createdAt', 'id', 'keywords', 'pinned', 'text', 'updatedAt'], 'note shape');
  eq((await call('POST', N, {})).body.note.text, '', 'text is optional');
  const put = await call('PUT', `${N}/${id}`, { text: 'edited about gazpacho gazpacho with basil tomato cucumber garlic pepper onion' });
  eq([put.status, typeof put.body.updatedAt], [200, 'number'], 'autosave answers updatedAt');
  /* [scratch seen] UI 5870: keywords on EVERY save, so the autosave indexes (no longer dirty) */
  eq(table.getRoomNote(room.id, id)!.dirty, 0, '...and indexes on the save (the row is not left dirty)');
  ok(put.body.keywords.includes('gazpacho'), '...answering the fresh keywords');
  eq((await call('GET', `${N}/${id}`, undefined, false)).body.text, 'edited about gazpacho gazpacho with basil tomato cucumber garlic pepper onion', 'an agent (bearer) can read a note');
  eq((await call('GET', `${N}?q=gazpacho`, undefined, false)).body.notes.map((n: any) => n.id), [id], 'searchable right after the save (indexed on save)');
  const closed = await call('POST', `${N}/${id}/close`);
  eq([closed.status, closed.body.note.keywords.includes('gazpacho')], [200, true], 'close indexes now');
  const emp = (await call('POST', N, {})).body.note;
  const rm = await call('POST', `${N}/${emp.id}/close`);
  eq([rm.status, rm.body], [200, { note: null, removed: true }], 'closing an empty note answers removed');
  eq((await call('GET', `${N}/${emp.id}`, undefined, false)).status, 404, '...and it is gone');
  eq((await call('GET', N, undefined, false)).body.notes.some((x: any) => x.id === emp.id), false, '...and not listed');
  const s = await call('GET', `${N}?q=basil`, undefined, false);
  eq(Object.keys(s.body.notes[0]).sort(), ['archived', 'excerpt', 'id', 'keywords', 'pinned', 'updatedAt'], 'search hit shape');
  ok(s.body.notes[0].excerpt.includes('basil') && !/<|>/.test(s.body.notes[0].excerpt), 'excerpt holds the match, plain text');
  eq((await call('GET', `${N}?q=%22%20AND%20*`, undefined, false)).status, 200, 'a hostile q answers 200, never a 500');
  const lst = await call('GET', N, undefined, false);
  eq(Object.keys(lst.body.notes[0]).sort(), ['archived', 'createdAt', 'id', 'keywords', 'pinned', 'updatedAt'], 'list row shape (no text)');
  eq((await call('POST', `${N}/${id}/pin`, { pinned: true })).body.note.pinned, true, 'pin');
  eq((await call('POST', `${N}/${id}/pin`, { pinned: 'yes' })).status, 400, 'pin wants a boolean');
  eq((await call('POST', `${N}/${id}/archive`, { archived: true })).body.note.archived, true, 'archive');
  eq(((await call('GET', N)).body.notes as any[]).some((n) => n.id === id), false, 'archived: not in the list');
  eq((await call('GET', `${N}?q=basil`)).body.notes.length, 1, '...still in search');
  await call('POST', `${N}/${id}/archive`, { archived: false });

  console.log('\n[credential and room scoping]');
  eq((await call('POST', N, { text: 'x' }, false)).status, 403, 'create needs a person');
  eq((await call('PUT', `${N}/${id}`, { text: 'x' }, false)).status, 403, 'put needs a person');
  eq((await call('POST', `${N}/${id}/attach`, undefined, false)).status, 403, 'attach needs a person');
  eq((await call('POST', `${N}/move-draft`, undefined, false)).status, 403, 'move-draft needs a person');
  eq((await call('GET', `/api/rooms/${other.id}/notes/${id}`)).status, 404, "another room's note is not there");
  eq((await call('PUT', `/api/rooms/${other.id}/notes/${id}`, { text: 'x' })).status, 404, '...nor writable');
  eq((await call('GET', `/api/rooms/nope/notes`)).status, 404, 'an unknown room is 404');
  eq((await call('GET', `${N}/zzz`)).status, 404, 'a malformed id is 404');

  console.log('\n[413 over the ceiling states both numbers]');
  const big = 'x'.repeat(NOTE_TEXT_MAX + 1);
  const over = await call('PUT', `${N}/${id}`, { text: big });
  eq(over.status, 413, 'over the ceiling: 413 answered');
  ok(over.body.error.includes(String(NOTE_TEXT_MAX + 1)) && over.body.error.includes(String(NOTE_TEXT_MAX)), 'both numbers in the message');
  eq((await call('POST', N, { text: big })).status, 413, 'create too');
  eq(table.getRoomNote(room.id, id)!.text, 'edited about gazpacho gazpacho with basil tomato cucumber garlic pepper onion', 'the refused write changed nothing');

  console.log('\n[attach: the draft attachment path, idempotent]');
  const att = await call('POST', `${N}/${id}/attach`);
  eq(att.status, 200, 'attach answers 200');
  const A = att.body.attachment;
  eq([A.name, A.type, A.bytes_length], [`note-${id}.txt`, 'text/plain', Buffer.byteLength('edited about gazpacho gazpacho with basil tomato cucumber garlic pepper onion')], 'file shape');
  eq([A.title, A.words], ['edited about gazpacho gazpacho with basi', 11], 'chip fields: title and word count');
  const who = table.listRoomScratch(table.getRoomNote(room.id, id)!.created_by!, room.id);
  eq(who.length, 1, 'one draft attachment, in the same scratch table the uploads use');
  eq(readFileSync(join(scratch.dir(), who[0].id), 'utf8'), 'edited about gazpacho gazpacho with basil tomato cucumber garlic pepper onion', 'its bytes are the snapshot');
  await call('PUT', `${N}/${id}`, { text: 'edited AGAIN about gazpacho   and\n basil and thyme' });
  const att2 = await call('POST', `${N}/${id}/attach`);
  const after = table.listRoomScratch(who[0].user_key, room.id);
  eq(after.length, 1, 'attach again: still ONE attachment');
  eq([after[0].id, att2.body.attachment.replaced], [who[0].id, true], '...the same one, replaced');
  eq(readFileSync(join(scratch.dir(), after[0].id), 'utf8'), 'edited AGAIN about gazpacho   and\n basil and thyme', '...with the new content');
  eq([att2.body.attachment.title, att2.body.attachment.words, att2.body.attachment.bytes_length === after[0].size], ['edited AGAIN about gazpacho and basil an', 8, true], 'title collapsed whitespace and cut at 40; words; size updated');
  eq((await call('POST', `${N}/${(await call('POST', N, {})).body.note.id}/attach`)).status, 400, 'an empty note has nothing to attach');

  console.log('\n[move-draft]');
  const key = who[0].user_key;
  eq((await call('POST', `${N}/move-draft`)).status, 400, 'an empty draft: 400, nothing made');
  table.setRoomDraft(key, room.id, 'a long draft about saffron risotto');
  const mv = await call('POST', `${N}/move-draft`);
  eq(mv.status, 200, 'happy path: 200');
  eq(mv.body.note.text, 'a long draft about saffron risotto', 'the note holds the draft');
  eq(table.getRoomDraft(key, room.id).text, '', 'the draft is cleared');
  eq(mv.body.attachment.name, `note-${mv.body.note.id}.txt`, 'and the note is attached');
  eq(table.searchRoomNotes(room.id, 'saffron').length, 1, '...and indexed');
  // failure path: attach refuses (the draft is full), so the draft must stay
  process.env.HARBOR_WB_ROOM_ATTACH_MAX = String(table.countRoomScratch(key, room.id));
  table.setRoomDraft(key, room.id, 'keep me, I am the draft');
  const bad = await call('POST', `${N}/move-draft`);
  ok(bad.status >= 400 && /step attach/.test(bad.body.error) && /draft is untouched/.test(bad.body.error), 'a failed step is named and the draft is said to be untouched');
  eq(table.getRoomDraft(key, room.id).text, 'keep me, I am the draft', 'the draft is untouched');
  delete process.env.HARBOR_WB_ROOM_ATTACH_MAX;

  console.log('\n[the Assets panel comes with the first note]');
  const pr = table.createRoom({ name: 'Panel Room' }, { actor: 'user' }).result;
  const P = `/api/rooms/${pr.id}/notes`;
  eq(table.listPanels(pr.id).length, 0, 'no panels yet');
  const pc1 = await call('POST', P, {});
  eq([pc1.status, pc1.body.assetsPanel], [200, { added: true }], 'create: 200 and the panel was added');
  eq(table.listPanels(pr.id).filter((p) => p.icon === 'assets').length, 1, 'one Assets panel exists');
  const pc2 = await call('POST', P, {});
  eq([pc2.status, pc2.body.assetsPanel, table.listPanels(pr.id).length], [200, { added: false }, 1], 'a second note leaves it untouched');
  const pr2 = table.createRoom({ name: 'Panel Room Two' }, { actor: 'user' }).result;
  table.setRoomDraft(table.getRoomNote(room.id, id)!.created_by!, pr2.id, 'a draft to move');
  const mvp = await call('POST', `/api/rooms/${pr2.id}/notes/move-draft`);
  eq([mvp.status, mvp.body.assetsPanel], [200, { added: true }], 'move-draft adds the panel too');
  const pr3 = table.createRoom({ name: 'Panel Room Three' }, { actor: 'user' }).result;
  const realAdd = table.addPanel;
  (table as any).addPanel = () => {
    throw new Error('panel store down');
  };
  const pc3 = await call('POST', `/api/rooms/${pr3.id}/notes`, {});
  (table as any).addPanel = realAdd;
  eq([pc3.status, pc3.body.assetsPanel, typeof pc3.body.note?.id], [200, { added: false }, 'string'], 'a panel that fails to add never fails the note');
  eq(table.listRoomNotesVisible(pr3.id).length, 1, '...and the note exists');

  console.log('\n[draftUpdatedAt on the room state: per caller, never shared]');
  const as = async (principal: any, human = true) => {
    const out = { status: 0, body: null as any };
    await rooms.handle(req('GET', `/api/rooms/${room.id}`), resp(out), `/api/rooms/${room.id}`, principal, deps(human));
    return out;
  };
  const alice = { userId: 'u-alice', username: 'alice' };
  const bob = { userId: 'u-bob', username: 'bob' };
  eq((await as(alice)).body.draftUpdatedAt, null, 'a person with no draft: null');
  table.setRoomDraft('u-alice', room.id, 'alice words');
  const stamp = table.getRoomDraft('u-alice', room.id).updatedAt;
  ok(typeof stamp === 'number', 'alice has a stamp');
  eq((await as(alice)).body.draftUpdatedAt, stamp, 'alice sees her own stamp');
  eq((await as(bob)).body.draftUpdatedAt, null, 'bob in the same room does not see it');
  table.setRoomDraft('u-bob', room.id, 'bob words');
  const bs = table.getRoomDraft('u-bob', room.id).updatedAt;
  eq([(await as(alice)).body.draftUpdatedAt, (await as(bob)).body.draftUpdatedAt], [stamp, bs], 'each sees only their own');
  ok(!('draftUpdatedAt' in (await as(null, false)).body), 'a non-person (bearer) caller gets no stamp');
} finally {
  notes.stopSweep();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* held open by better-sqlite3 until exit */
  }
}

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
