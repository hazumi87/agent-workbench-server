/**
 * SCRATCHPAD ITEMS [scratch seen] (UI 5870, accepted 5872), engine half:
 *   2. notes list `summary=1`: + excerpt, author (@name), total; the default shape unchanged
 *   3. note keywords on every save (PUT), not only on close
 *   4. thumbnails: GET .../assets/thumb/<name>?w=, images only, width clamped to a step,
 *      cached on disk beside the table; a non-image answers 404 {icon}
 *   5. "came from": the asset record keeps the room line id; the list returns `lineId`
 *   6. rename / move (family only) / remove: a person's window only, scope re-checked,
 *      `room.scratchpad changed` pushed
 *   7. references: `[asset: <name>]` and `[note: <id> …]` resolved in the AGENT copy
 *      (typed), never in the stored line
 *
 * SAFETY: a temp table set BEFORE any import; a stub agent-share on P(424). Run with tsx.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { P, assertFree } from './_scratch.mjs';

const SHARE_PORT = P(424);
await assertFree(SHARE_PORT, 'scratch-items.test.ts');
const dir = mkdtempSync(join(tmpdir(), 'wb-scratch-items-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_SEAT_WELCOME = '0';
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '0';
process.env.HARBOR_WB_AGENT_SHARE_URL = `http://127.0.0.1:${SHARE_PORT}`;
process.env.HARBOR_WB_NODE = 'homebase';
delete process.env.HARBOR_WB_CHANNELS;
delete process.env.HARBOR_WB_ROOM_TYPE;

const sharp = (await import('sharp')).default;
const PNG = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();

/* ---- the stub agent-share: ref -> bytes ---- */
const files = new Map<string, Buffer>();
const fetches: string[] = [];
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'GET' && u.pathname === '/api/list') {
      const d = u.searchParams.get('dir') ?? '';
      const entries = [...files.keys()].filter((k) => k.slice(0, k.lastIndexOf('/')) === d).map((k) => ({ name: k.slice(k.lastIndexOf('/') + 1), path: k, type: 'file', size: files.get(k)!.length, mtime: 1, url: null }));
      return json(entries.length ? 200 : 404, entries.length ? { entries } : { error: 'no such dir' });
    }
    if (req.method === 'POST' && u.pathname === '/api/upload') {
      const d = u.searchParams.get('dir') ?? '';
      const body = Buffer.concat(chunks);
      const text = body.toString('latin1');
      const at = text.indexOf('filename="') + 'filename="'.length;
      let name = text.slice(at, text.indexOf('"', at));
      if (files.has(`${d}/${name}`)) name = `1-${name}`;
      void text;
      const start = body.indexOf(Buffer.from([13, 10, 13, 10])) + 4;
      const end = body.lastIndexOf(Buffer.from([13, 10, 45, 45]));
      files.set(`${d}/${name}`, body.subarray(start, end));
      return json(200, { ok: true, saved: [`${d}/${name}`] });
    }
    if (req.method === 'POST' && u.pathname === '/api/move') {
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const bytes = files.get(b.from);
      if (!bytes) return json(404, { error: 'from is not a file' });
      const name = b.from.slice(b.from.lastIndexOf('/') + 1);
      let dest = `${b.to_dir}/${name}`;
      if (files.has(dest)) dest = `${b.to_dir}/1-${name}`;
      files.delete(b.from);
      files.set(dest, bytes);
      return json(200, { ok: true, path: dest });
    }
    if (u.pathname.startsWith('/raw/')) {
      const ref = decodeURIComponent(u.pathname.slice(5));
      const bytes = files.get(ref);
      if (!bytes) {
        res.writeHead(404);
        return res.end();
      }
      if (req.method === 'GET') fetches.push(ref);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.length), 'last-modified': 'Tue, 07 Oct 2026 10:00:00 GMT' });
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    }
    json(404, { error: 'not here' });
  });
});
await new Promise<void>((r) => stub.listen(SHARE_PORT, '127.0.0.1', () => r()));

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const roomBus = await import('../src/engine/room-bus.ts');
const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
}
const eq = (a: unknown, b: unknown, m: string): void => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): any {
  const raw = Buffer.isBuffer(body) ? body : body === undefined ? null : Buffer.from(JSON.stringify(body));
  const r = Readable.from(raw ? [raw] : []) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': Buffer.isBuffer(body) ? 'image/png' : 'application/json', ...headers };
  return r;
}
function resp(out: { status: number; body: any; raw?: Buffer; headers?: any }): any {
  return {
    writeHead(s: number, h?: any) {
      out.status = s;
      out.headers = h;
    },
    setHeader() {},
    end(x?: unknown) {
      out.raw = Buffer.isBuffer(x) ? x : Buffer.from(String(x ?? ''));
      try {
        out.body = JSON.parse(String(x ?? ''));
      } catch {
        out.body = null;
      }
    },
  };
}
const OWNER = { userId: 'u-owner', username: 'owner', isAdmin: true, mustChangePassword: false, via: 'session', sessionId: 's', evidence: null, credentialCreatedAt: null } as any;
async function call(method: string, url: string, who: any | null, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw?: Buffer; headers?: any }> {
  const out = { status: 0, body: null as any } as { status: number; body: any; raw?: Buffer; headers?: any };
  await rooms.handle(req(method, url, body, who ? headers : { authorization: 'Bearer t', ...headers }), resp(out), url.split('?')[0], who, {
    projector: async () => (x: any) => x,
    log: () => {},
    human: !!who,
  } as any);
  return out;
}

try {
  const R = table.createRoom({ name: 'Studio', alias: 'studio' }, { actor: 'user' }).result;
  const WG = table.createRoom({ name: 'Blender', parent_id: R.id, alias: 'blender' }, { actor: 'user' }).result;
  const OTHER = table.createRoom({ name: 'Elsewhere' }, { actor: 'user' }).result;
  const folder = table.roomAssetFolder(R.id);
  const pushes: any[] = [];
  roomBus.on(roomBus.ANY_ROOM, (roomId, ev) => pushes.push({ roomId, ...ev }));
  const A = `/api/rooms/${R.id}/assets`;

  console.log('\n[5 came from: the record keeps the line id; the list returns lineId]');
  const up = await call('POST', A, OWNER, PNG, { 'x-filename': 'red.png' });
  eq(up.status, 200, 'uploaded');
  const factId = up.body.entries?.[0]?.id;
  ok(typeof factId === 'number', 'the upload wrote its "added" fact');
  files.set(`${folder}/dropped.txt`, Buffer.from('hello'));
  const list = await call('GET', A, OWNER);
  const red = list.body.assets.find((a: any) => a.name === 'red.png');
  const dropped = list.body.assets.find((a: any) => a.name === 'dropped.txt');
  eq([red?.lineId, dropped?.lineId], [factId, null], 'lineId: the fact for an upload; null for a file with no record');

  console.log('\n[4 thumbnails: images only, clamped width, cached on disk]');
  let t = await call('GET', `${A}/thumb/red.png?w=200`, OWNER);
  eq([t.status, t.headers?.['content-type']], [200, 'image/webp'], 'a webp thumbnail');
  const meta = await sharp(t.raw!).metadata();
  eq(meta.width, 256, 'w=200 rounds up to the 256 step');
  const cacheDir = join(dir, 'thumbs');
  ok(existsSync(cacheDir) && readdirSync(cacheDir).length > 0, 'cached beside the table (the data dir)');
  const before = fetches.length;
  t = await call('GET', `${A}/thumb/red.png?w=200`, null);
  eq([t.status, fetches.length], [200, before], 'again (any credential): served from the cache, no new fetch');
  eq((await sharp((await call('GET', `${A}/thumb/red.png?w=9999`, OWNER)).raw!).metadata()).width, 512, 'w=9999 clamps to 512');
  eq((await sharp((await call('GET', `${A}/thumb/red.png?w=1`, OWNER)).raw!).metadata()).width, 64, 'w=1 clamps to 64');
  t = await call('GET', `${A}/thumb/dropped.txt`, OWNER);
  eq([t.status, t.body?.icon], [404, 'text'], 'a non-image: 404 with an icon kind');
  eq((await call('GET', `${A}/thumb/nope.png`, OWNER)).status, 404, 'a missing image: 404');
  eq((await call('GET', `${A}/thumb/..`, OWNER)).status, 400, 'a path is refused');

  console.log('\n[6 rename / move / remove: a person only, scope checked, pushed]');
  eq((await call('PATCH', `${A}/item/red.png`, null, { name: 'x.png' })).status, 403, 'a bearer cannot rename');
  eq((await call('DELETE', `${A}/item/red.png`, null)).status, 403, 'a bearer cannot remove');
  pushes.length = 0;
  let r = await call('PATCH', `${A}/item/red.png`, OWNER, { name: 'crimson.png' });
  eq([r.status, r.body?.op, r.body?.path], [200, 'rename', `${folder}/crimson.png`], 'renamed');
  ok(files.has(`${folder}/crimson.png`) && !files.has(`${folder}/red.png`), 'the share has the new name; the old one moved aside');
  eq(table.listAssetRecords(R.id).find((x) => x.name === 'crimson.png')?.line_id, factId, 'the record (and its came-from) followed');
  ok(pushes.some((p) => p.type === 'room.scratchpad' && p.person === null && p.roomId === R.id), 'room.scratchpad changed pushed');
  eq((await call('PATCH', `${A}/item/crimson.png`, OWNER, { room: OTHER.id })).body?.field, 'room', 'a room outside the family is refused');
  r = await call('PATCH', `${A}/item/crimson.png`, OWNER, { room: WG.id });
  eq([r.status, r.body?.op, r.body?.room], [200, 'move', WG.id], 'moved to the workgroup');
  const wgFolder = table.roomAssetFolder(WG.id);
  ok(files.has(`${wgFolder}/crimson.png`) && table.listAssetRecords(WG.id).some((x) => x.name === 'crimson.png'), 'the file and its record are in the workgroup now');
  eq((await call('PATCH', `${A}/item/crimson.png`, OWNER, { name: 'y.png' })).status, 404, 'no longer in this room: 404');
  r = await call('DELETE', `/api/rooms/${WG.id}/assets/item/crimson.png`, OWNER);
  eq([r.status, r.body?.op], [200, 'remove'], 'removed');
  ok(!files.has(`${wgFolder}/crimson.png`) && [...files.keys()].some((k) => k.startsWith('rooms/_removed/')), 'moved into rooms/_removed (recoverable), never deleted');
  eq(table.listAssetRecords(WG.id).length, 0, 'its record is gone');

  console.log('\n[2 + 3 notes: summary=1, keywords on every save]');
  table.setUserHandle('u-owner', 'owner'); // the @name a person set (identity is off in this test)
  const nn = await call('POST', `/api/rooms/${R.id}/notes`, OWNER, { text: 'Hand rig checklist' });
  const id = nn.body.note.id;
  const put = await call('PUT', `/api/rooms/${R.id}/notes/${id}`, OWNER, { text: 'Hand rig checklist\nwrist flex wrist flex cuff\nthird line\nfourth line hidden' });
  ok(put.status === 200 && put.body.keywords.includes('wrist'), `keywords right after the save, not only on close (got ${JSON.stringify(put.body.keywords)})`);
  const plain = await call('GET', `/api/rooms/${R.id}/notes`, OWNER);
  ok(!('total' in plain.body) && !('excerpt' in plain.body.notes[0]), 'the default shape is unchanged');
  const sum = await call('GET', `/api/rooms/${R.id}/notes?summary=1`, OWNER);
  const row = sum.body.notes.find((n: any) => n.id === id);
  eq([sum.body.total, row?.author, row?.excerpt], [1, 'owner', 'Hand rig checklist\nwrist flex wrist flex cuff\nthird line'], 'summary: total, author @name, the first three lines');

  console.log('\n[7 references: resolved in the agent copy, not the stored line]');
  table.upsertRecipe({
    id: 'rec-op', name: 'op', target: 'local', projectDir: '/x/op', vendor: 'claude-code', agent: 'op', model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
  table.upsert({ paneid: 'recipe:rec-op', recipe_id: 'rec-op', server: 'local', vendor: 'claude-code', agent: 'op', session_id: null, state: 'live', generation: 1 } as never);
  const typed: string[] = [];
  sessions.add('recipe:rec-op', { state: 'live', pty: { write: (d: string) => typed.push(d) } } as never, null as never);
  activity.onLive('recipe:rec-op');
  activity.setOnChange((p, st) => typer.onActivity(p, st));
  table.addSeat(R.id, { recipe_id: 'rec-op', occupant: 'recipe:rec-op' }, { actor: 'user' });
  files.set(`${folder}/plan.png`, PNG);
  const text = `@op look at [asset: plan.png] and [note: ${id} · @owner, 8m ago] then [note: 000000000000]`;
  const line = await call('POST', `/api/rooms/${R.id}/line`, OWNER, { text });
  eq(line.status, 200, 'posted');
  eq(line.body.entries[0].body, text, 'the stored line is unchanged');
  await sleep(300);
  const got = typed.join('');
  ok(got.includes(`References:`) && got.includes(`${folder}/plan.png`) && got.includes('/raw/'), 'the typed copy carries the asset URL and path');
  ok(got.includes(`[note: ${id}] Hand rig checklist / wrist flex`), "the typed copy carries the note's text");
  ok(got.includes('[note: 000000000000] (no such note in this room)'), 'an unknown note says so');
  eq(rooms.referencesIn('a [asset: x.png] b [note: abc123abc123 label] c [asset: x.png]'), { assets: ['x.png'], notes: ['abc123abc123'] }, 'referencesIn: each once, the note id before any label');
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error).stack}`);
} finally {
  stub.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM); the temp dir is left behind */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
