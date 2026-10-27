/**
 * APPS BELONG TO THE ROOM FAMILY [family apps] (Owner 2026-10-05, room line):
 * a main room and its workgroups show the SAME app cells. Panels resolve by
 * FAMILY HEAD. Covers: a workgroup lists the head's panels; an add from a
 * workgroup lands on the head; a link posted for a family app validates in a
 * workgroup; an exclusive app's move within a family is a no-op; an app in a
 * non-family room is unaffected; the boot migration adopts a workgroup's own
 * apps (additive, idempotent, a duplicate is left in place but unread).
 *
 * SAFETY: a temp table + tools dir set BEFORE any import; no server, no app
 * runs (panels are drawn through table.addRoomApp with a spec). Run with tsx.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'wb-family-apps-'));
const toolsDir = join(dir, 'tools');
mkdirSync(toolsDir, { recursive: true });
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_TOOLS_DIR = toolsDir;
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_NODE = 'homebase';

const { table } = await import('../src/table/endpoint.ts');
const store = await import('../src/table/store.ts');
const apps = await import('../src/engine/apps.ts');

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
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? msg : `${msg} (got ${a}, want ${b})`);
}

function writeTool(slug: string, access: string): void {
  const root = join(toolsDir, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'tool.json'),
    JSON.stringify({
      contract: 'tool/draft-0',
      name: slug,
      slug,
      version: '0.1.0',
      description: `${slug} d`,
      access,
      endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
      panels: [{ title: slug, icon: 'image', view: 'GET /rooms/:roomId/view' }],
      links: { 'review/:n': { label: 'Review', view: 'GET /rooms/:roomId/review/:n' } },
    }),
  );
}
const spec = (slug: string, roomId: string) => ({ title: slug, icon: 'image', url: `http://127.0.0.1:9999/rooms/${roomId}/view`, scripts: false, uploads: false });
const U = { actor: 'user' as const };

try {
  for (const [s, a] of [['studio', 'shared'], ['solo', 'exclusive'], ['wgapp', 'shared']] as const) {
    writeTool(s, a);
    apps.registerApp(join(toolsDir, s), 'user');
  }
  const H = table.createRoom({ name: 'Main' }, U).result;
  const W = table.createRoom({ name: 'Group', parent_id: H.id, alias: 'grp' }, U).result;
  const W2 = table.createRoom({ name: 'Group two', parent_id: H.id, alias: 'grp2' }, U).result;
  const X = table.createRoom({ name: 'Other' }, U).result;

  console.log('\n[a workgroup lists the head\'s panels; an add from a workgroup lands on the head]');
  eq(table.familyHeadId(W.id), H.id, 'familyHeadId: a workgroup resolves to its parent');
  eq(table.familyHeadId(H.id), H.id, 'familyHeadId: a main room is its own head');
  const add = table.addRoomApp(W.id, 'studio', [spec('studio', H.id)], U);
  eq(add.result.room_id, H.id, 'added from the workgroup: the membership is the head\'s');
  eq(table.listRoomApps(H.id).map((a) => a.slug), ['studio'], 'the head holds it');
  eq(table.listRoomApps(W.id).map((a) => a.slug), ['studio'], 'the workgroup lists the same app');
  eq(table.listRoomApps(W2.id).map((a) => a.slug), ['studio'], 'a sibling workgroup too');
  const hp = table.listPanels(H.id).map((p) => p.id);
  eq(hp.length, 1, 'one panel');
  eq(table.listPanels(W.id).map((p) => p.id), hp, 'the workgroup lists the head\'s panel (same id)');
  eq(table.listPanels(W.id)[0].room_id, H.id, 'the panel row lives on the head');
  eq(table.listPanels(X.id), [], 'a non-family room sees none of it');

  console.log('\n[a link posted in a workgroup validates; a panel is reachable from the workgroup]');
  const link = apps.resolveLink(W.id, 'studio', 'review/2', null);
  eq([link.tool, link.view_path, link.panel_id], ['studio', 'review/2', hp[0]], 'resolveLink in a workgroup: the head\'s panel carries it');
  let threw = '';
  try {
    apps.resolveLink(X.id, 'studio', 'review/2', null);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(/not in this room/.test(threw), 'a non-family room still refuses (not in this room)');
  const ren = table.updatePanel(W.id, hp[0], { title: 'Renamed' }, U);
  eq(ren.result.title, 'Renamed', 'a workgroup may retitle the family\'s panel');
  eq(table.getPanel(hp[0])?.room_id, H.id, '...and it is still the head\'s');

  console.log('\n[removal is family-wide]');
  const rm = table.removeRoomApp(W.id, 'studio', U);
  eq(rm.result.panel_ids, hp, 'removed from the workgroup');
  eq([table.listRoomApps(H.id).length, table.listPanels(H.id).length, table.listPanels(W2.id).length], [0, 0, 0], 'gone from the head and every workgroup');

  console.log('\n[an exclusive app\'s move within a family is a no-op]');
  const a1 = await apps.addAppToRoom(H.id, 'solo', {});
  eq(a1.ok, true, 'exclusive app added to the head');
  const a2 = await apps.addAppToRoom(W.id, 'solo', {});
  eq(a2.ok, true, 'add from the workgroup: no "held elsewhere"');
  eq(a2.ok && a2.moved_from, null, 'nothing moved');
  eq(table.roomsForApp('solo').map((r) => r.id), [H.id], 'still one holder: the family head');
  eq(table.familyRoomIds(H.id).slice().sort(), [H.id, W.id, W2.id].sort(), 'familyRoomIds: the head and every workgroup');
  eq((await apps.catalog()).find((a) => a.slug === 'solo')?.rooms[0].ids.slice().sort(), [H.id, W.id, W2.id].sort(), 'the catalog reports the holder\'s whole family');
  table.fillRoomAppPanels(H.id, 'solo', [spec('solo', H.id)]);
  const pidBefore = table.listPanels(W.id).map((p) => p.id);
  const placed = table.placeRoomApp(W.id, 'solo', [spec('solo', H.id)], { exclusive: true, from: H.id });
  eq(placed.conflict, null, 'placeRoomApp from the head to its own workgroup: no conflict');
  eq(placed.results.length, 1, '...and no remove step (no-op move)');
  eq(table.listPanels(W.id).map((p) => p.id), pidBefore, '...the panel is untouched (same id)');
  const a3 = await apps.addAppToRoom(X.id, 'solo', {});
  eq(a3.ok === false && a3.status, 409, 'a room OUTSIDE the family is still told it is held elsewhere');

  console.log('\n[an app added in a non-family room is unaffected]');
  table.addRoomApp(X.id, 'studio', [spec('studio', X.id)], U);
  eq(table.listRoomApps(X.id).map((a) => a.slug), ['studio'], 'the other room holds it');
  eq(table.listRoomApps(H.id).map((a) => a.slug), ['solo'], 'the family does not');
  eq(table.listPanels(X.id)[0].room_id, X.id, 'its panel stays on its own room');

  console.log('\n[the boot migration adopts, additively and idempotently]');
  const raw = new Database(process.env.HARBOR_WB_TABLE!);
  raw.prepare(`INSERT INTO room_apps (room_id, slug, added_by, added_at) VALUES (?, 'wgapp', 'user', 1)`).run(W.id);
  raw.prepare(
    `INSERT INTO room_panels (id, room_id, kind, title, url, seat_id, icon, scripts, uploads, position, created_by, created_at, app_slug)
     VALUES ('legacy-p', ?, 'app', 'wgapp', ?, NULL, 'image', 0, 0, 0, 'user', 1, 'wgapp')`,
  ).run(W.id, `http://127.0.0.1:9999/rooms/${W.id}/view`);
  // a DUPLICATE: the head already holds 'solo', the workgroup has its own copy
  raw.prepare(`INSERT INTO room_apps (room_id, slug, added_by, added_at) VALUES (?, 'solo', 'user', 1)`).run(W2.id);
  raw.prepare(
    `INSERT INTO room_panels (id, room_id, kind, title, url, seat_id, icon, scripts, uploads, position, created_by, created_at, app_slug)
     VALUES ('dup-p', ?, 'app', 'solo', ?, NULL, 'image', 0, 0, 0, 'user', 1, 'solo')`,
  ).run(W2.id, `http://127.0.0.1:9999/rooms/${W2.id}/view`);
  const m1 = store.adoptWorkgroupApps(raw);
  eq(m1.adopted, [{ room_id: W.id, slug: 'wgapp' }], 'the workgroup\'s own app is adopted');
  eq(m1.duplicates, [{ room_id: W2.id, slug: 'solo' }], 'the duplicate is reported');
  eq(table.listRoomApps(H.id).map((a) => a.slug).sort(), ['solo', 'wgapp'], 'the head now holds the adopted app');
  ok(table.listPanels(W.id).some((p) => p.id === 'legacy-p'), 'its panel is listed through the workgroup');
  eq(table.getPanel('legacy-p')?.room_id, H.id, '...and lives on the head');
  eq(table.listPanels(W2.id).some((p) => p.id === 'dup-p'), false, 'the duplicate stays unread');
  eq((raw.prepare(`SELECT COUNT(*) AS n FROM room_panels WHERE id='dup-p'`).get() as { n: number }).n, 1, '...but is not deleted');
  eq((raw.prepare(`SELECT COUNT(*) AS n FROM room_apps WHERE room_id=? AND slug='solo'`).get(W2.id) as { n: number }).n, 1, '...nor its membership row');
  const m2 = store.adoptWorkgroupApps(raw);
  eq(m2.adopted, [], 'second run adopts nothing (idempotent)');
  eq(table.listRoomApps(H.id).map((a) => a.slug).sort(), ['solo', 'wgapp'], 'and changes nothing');
  raw.close();
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error)?.stack ?? e}`);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the store still holds the db */
  }
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
