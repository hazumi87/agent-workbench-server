/**
 * SCRATCHPAD SEEN-STATE [scratch seen] (Owner 2026-10-07, UI 5857/5866; the hub handoff's
 * Scratchpad: "Assets ● 3 new of 43", "Notes ● 1 new of 6"; opening an item marks it seen).
 *
 *   - the BASELINE: the first read of a person's counts sets it; everything older is seen;
 *   - items added AFTER it are new (an asset on agent-share, a note by someone else);
 *   - a person's OWN note and upload are never new to them (and are new to the other);
 *   - lists carry `seen` per item for a person; a bearer gets no `seen`;
 *   - POST .../scratchpad/seen marks, idempotent; counts drop; a room-bus push carries
 *     that person's counts; an addition pushes `changed` for everyone to re-read;
 *   - a bearer: 403 on counts and on seen; bad bodies: 400.
 *
 * SAFETY: a temp table set BEFORE any import; a stub agent-share on P(423). Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { P, assertFree } from './_scratch.mjs';

const SHARE_PORT = P(423);
await assertFree(SHARE_PORT, 'scratch-seen.test.ts');
const dir = mkdtempSync(join(tmpdir(), 'wb-scratch-seen-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_SEAT_WELCOME = '0';
process.env.HARBOR_WB_AGENT_SHARE_URL = `http://127.0.0.1:${SHARE_PORT}`;
process.env.HARBOR_WB_NODE = 'homebase';

/* ---- the stub agent-share: folder -> files {name, mtime (unix s)} ---- */
const shareFs = new Map<string, Array<{ name: string; mtime: number }>>();
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && u.pathname === '/api/list') {
    const d = u.searchParams.get('dir') ?? '';
    const files = shareFs.get(d);
    if (!files) return json(404, { error: 'no such dir' });
    return json(200, { entries: files.map((f) => ({ name: f.name, path: `${d}/${f.name}`, type: 'file', size: 3, mtime: f.mtime, url: null })) });
  }
  if (req.method === 'POST' && u.pathname === '/api/upload') {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const d = u.searchParams.get('dir') ?? '';
      const text = Buffer.concat(chunks).toString('latin1');
      const at = text.indexOf('filename="') + 'filename="'.length;
      const name = text.slice(at, text.indexOf('"', at));
      const files = shareFs.get(d) ?? [];
      shareFs.set(d, files);
      files.push({ name, mtime: Date.now() / 1000 });
      json(200, { ok: true, saved: [`${d}/${name}`] });
    });
    return;
  }
  json(404, { error: 'not here' });
});
await new Promise<void>((r) => stub.listen(SHARE_PORT, '127.0.0.1', () => r()));

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const roomBus = await import('../src/engine/room-bus.ts');

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
const person = (id: string, name: string) => ({ userId: id, username: name, isAdmin: true, mustChangePassword: false, via: 'session', sessionId: 's', evidence: null, credentialCreatedAt: null }) as any;
const OWNER = person('u-owner', 'owner');
const ZAH = person('u-zah', 'zahkutya');
/** A route call as a person (their window) or, with who = null, as a bearer. */
async function call(method: string, url: string, who: any | null, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, url, body, who ? headers : { authorization: 'Bearer t', ...headers }), resp(out), url.split('?')[0], who, {
    projector: async () => (x: any) => x,
    log: () => {},
    human: !!who,
  } as any);
  return out;
}

try {
  const R = table.createRoom({ name: 'Studio' }, { actor: 'user' }).result;
  const folder = table.roomAssetFolder(R.id);
  const old = Date.now() / 1000 - 3600;
  shareFs.set(folder, [{ name: 'old-1.png', mtime: old }, { name: 'old-2.png', mtime: old }]);
  table.createRoomNote(R.id, 'u-zah', 'an old note from before anyone looked');
  const pushes: any[] = [];
  roomBus.on(R.id, (_room, ev) => pushes.push(ev));
  const C = `/api/rooms/${R.id}/scratchpad/counts`;
  const SEEN = `/api/rooms/${R.id}/scratchpad/seen`;

  console.log('\n[baseline: an old room starts at 0 new]');
  let c = await call('GET', C, OWNER);
  eq(c.status, 200, 'counts answer a person');
  eq(c.body, { assets: { new: 0, total: 2 }, notes: { new: 0, total: 1 } }, 'everything before the first read is seen');
  eq((await call('GET', C, ZAH)).body, { assets: { new: 0, total: 2 }, notes: { new: 0, total: 1 } }, "the other person's baseline, the same");

  console.log('\n[added after the baseline: new; your own: never new]');
  await sleep(5);
  shareFs.get(folder)!.push({ name: 'fresh.png', mtime: Date.now() / 1000 + 1 });
  const nz = await call('POST', `/api/rooms/${R.id}/notes`, ZAH, { text: 'zahkutya wrote this after the baseline' });
  eq(nz.status, 200, 'a person creates a note');
  const noteId = nz.body.note.id;
  ok(pushes.some((p) => p.type === 'room.scratchpad' && p.person === null), 'an addition pushes "changed" (person null) for every window to re-read');
  const up = await call('POST', `/api/rooms/${R.id}/assets`, OWNER, Buffer.from('png'), { 'x-filename': 'mine.png' });
  eq(up.status, 200, "owner uploads an asset from his window");
  c = await call('GET', C, OWNER);
  eq(c.body, { assets: { new: 1, total: 4 }, notes: { new: 1, total: 2 } }, "owner: the share's fresh file and zahkutya's note are new; his own upload is not");
  eq((await call('GET', C, ZAH)).body, { assets: { new: 2, total: 4 }, notes: { new: 0, total: 2 } }, "zahkutya: owner's upload and the fresh file are new; her own note is not");

  console.log('\n[lists carry `seen` for a person; a bearer gets none]');
  const la = await call('GET', `/api/rooms/${R.id}/assets`, OWNER);
  eq(la.body.assets.map((a: any) => [a.name, a.seen]).sort(), [['fresh.png', false], ['mine.png', true], ['old-1.png', true], ['old-2.png', true]], 'assets: seen per item');
  const ln = await call('GET', `/api/rooms/${R.id}/notes`, OWNER);
  eq(ln.body.notes.find((n: any) => n.id === noteId)?.seen, false, "notes: zahkutya's note is unseen for owner");
  const lb = await call('GET', `/api/rooms/${R.id}/assets`, null);
  ok(lb.status === 200 && lb.body.assets.every((a: any) => !('seen' in a)), 'a bearer: the list, with no `seen`');

  console.log('\n[mark seen: counts drop, idempotent, pushed to that person]');
  pushes.length = 0;
  const m1 = await call('POST', SEEN, OWNER, { kind: 'note', ids: [noteId] });
  eq([m1.status, m1.body.marked, m1.body.counts.notes], [200, 1, { new: 0, total: 2 }], 'marked one; notes new 0');
  const push = pushes.find((p) => p.type === 'room.scratchpad');
  ok(push && push.person === 'u-owner' && push.counts?.notes?.new === 0, "a push with owner's counts, for owner's windows only");
  pushes.length = 0;
  const m2 = await call('POST', SEEN, OWNER, { kind: 'note', ids: [noteId] });
  eq([m2.status, m2.body.marked], [200, 0], 'again: marked 0 (idempotent)');
  ok(!pushes.some((p) => p.type === 'room.scratchpad'), '...and no push for nothing');
  const fresh = `${folder}/fresh.png`;
  eq((await call('POST', SEEN, OWNER, { kind: 'asset', ids: [fresh] })).body.counts.assets, { new: 0, total: 4 }, 'opening the fresh asset: assets new 0');
  eq((await call('GET', C, ZAH)).body.assets.new, 2, "zahkutya's counts are hers alone");

  console.log('\n[a bearer, and bad bodies]');
  eq((await call('GET', C, null)).status, 403, 'counts: 403 for a bearer');
  eq((await call('POST', SEEN, null, { kind: 'note', ids: [noteId] })).status, 403, 'seen: 403 for a bearer');
  eq((await call('POST', SEEN, OWNER, { kind: 'file', ids: ['x'] })).body?.field, 'kind', "kind is 'asset' or 'note'");
  eq((await call('POST', SEEN, OWNER, { kind: 'note', ids: [] })).body?.field, 'ids', 'ids: at least one');

  console.log('\n[agent-share down: assets null, never a false 0]');
  shareFs.delete(folder);
  stub.close();
  await sleep(50);
  const down = await call('GET', C, OWNER);
  eq([down.status, down.body.assets, down.body.notes.total], [200, null, 2], 'assets null; notes still counted');
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error).stack}`);
} finally {
  stub.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM); the temp dir is left behind */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
