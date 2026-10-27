/**
 * APP SUPERSESSION [app supersede] Owner 2026-10-05: Image Studio / Model Studio
 * are retired in favor of Asset Studio, which answers the same refs. Stored
 * room-line links naming the old slug keep working after it is unregistered:
 * `tool_registry.superseded_by` (person-cookie unregister only), resolved at
 * READ time by ONE function (apps.supersededTarget; the page's effectiveTool),
 * and a new post naming the old slug is stored under the successor.
 * A temp table + tools dir; the fabric is a stub. Run with tsx.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { P, assertFree } from './_scratch.mjs';

const FABRIC_PORT = P(295);
await assertFree(FABRIC_PORT, 'app-supersede.test.ts');

const dir = mkdtempSync(join(tmpdir(), 'wb-supersede-'));
const toolsDir = join(dir, 'tools');
mkdirSync(toolsDir, { recursive: true });
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_TOOLS_DIR = toolsDir;
process.env.HARBOR_WB_FABRIC_URL = `http://127.0.0.1:${FABRIC_PORT}`;
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '1';
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '0';
process.env.HARBOR_WB_NODE = 'homebase';
delete process.env.HARBOR_WB_ROOM_TYPE;
delete process.env.HARBOR_WB_CHANNELS;

const sends: Array<Record<string, any>> = [];
const http = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/presence') {
      return json(200, { channel: false });
    }
    if (url.pathname === '/threads' && req.method === 'POST') {
      return json(200, { thread: 't-sup' });
    }
    if (url.pathname === '/send' && req.method === 'POST') {
      try {
        sends.push(JSON.parse(raw));
      } catch {
        /* not json */
      }
      return json(200, { id: `env-${sends.length}` });
    }
    return json(404, { error: 'not-here' });
  });
});
await new Promise<void>((r) => http.listen(FABRIC_PORT, '127.0.0.1', () => r()));

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const apps = await import('../src/engine/apps.ts');
const links = await import('../src/engine/tool-links.ts');
const proxy = await import('../src/server/panel-proxy.ts');
const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const { pictureOwner } = await import('../src/server/picture-owner.ts');

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T, good: (v: T) => boolean, ms = 3000): Promise<T> {
  const t0 = Date.now();
  let v = fn();
  while (!good(v) && Date.now() - t0 < ms) {
    await sleep(20);
    v = fn();
  }
  return v;
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
async function call(method: string, url: string, body?: unknown, human = false): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, url, body), resp(out), url.split('?')[0], null, deps(human));
  return out;
}
async function asPane(paneid: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handleAgent(req(method, url, body), resp(out), url.split('?')[0], paneid, deps(false));
  return out;
}
const meta = (e: any) => (typeof e?.meta === 'string' ? JSON.parse(e.meta) : e?.meta);

const NL = String.fromCharCode(10);
const webSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room-tool-links.mjs'), 'utf8').split(String.fromCharCode(13) + NL).join(NL);
const etStart = webSrc.indexOf('export function effectiveTool(');
const effectiveTool = new Function(`${webSrc.slice(etStart + 7, webSrc.indexOf(NL + '}', etStart) + 2)}; return effectiveTool;`)() as (t: string, c: Map<string, any>) => string;

function writeTool(slug: string, name: string): void {
  const root = join(toolsDir, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tool.json'), JSON.stringify({
    contract: 'tool/draft-0', name, slug, version: '0.1.0', description: name, access: 'shared',
    endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
    panels: [{ title: name, icon: 'image', view: 'GET /rooms/:roomId/view' }],
    links: { 'review/:n': { label: 'Review item', view: 'GET /rooms/:roomId/review/:n' }, 'watch/:job': { label: 'Watch', view: 'GET /rooms/:roomId/watch/:job' }, '@meta': 'GET /rooms/:roomId/links' },
  }, null, 2));
}
const throwsMsg = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

try {
  for (const [s, n] of [['image-studio', 'Image Studio'], ['model-studio', 'Model Studio'], ['asset-studio', 'Asset Studio'], ['held-app', 'Held App']]) {
    writeTool(s, n);
    apps.registerApp(join(toolsDir, s), 'user');
  }
  const R = table.createRoom({ name: 'Sup room' }, { actor: 'user' }).result;
  table.upsertRecipe({
    id: 'rec-a', name: 'auriga', target: 'local', projectDir: '/x/auriga', vendor: 'claude-code', agent: 'auriga', model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
  table.upsert({ paneid: 'recipe:rec-a', recipe_id: 'rec-a', server: 'local', vendor: 'claude-code', agent: 'auriga', session_id: null, state: 'live', generation: 1 } as never);
  sessions.add('recipe:rec-a', { state: 'live', pty: { write: () => {} } } as never, null as never);
  activity.onLive('recipe:rec-a');
  const sa = table.addSeat(R.id, { recipe_id: 'rec-a', occupant: 'recipe:rec-a' }, { actor: 'user' }).result;
  table.updateRoom(R.id, { lead_seat: sa.id }, { actor: 'user' });
  const R2 = table.createRoom({ name: 'Sup room 2' }, { actor: 'user' }).result;
  const LINE = `/api/rooms/${R.id}/line`;
  const unreg = (slug: string, body: unknown, human = true) => call('POST', `/api/apps/${slug}/unregister`, body, human);
  for (const s of ['image-studio', 'asset-studio']) {
    ok((await apps.addAppToRoom(R.id, s, {})).ok, `setup: ${s} in room 1`);
  }
  ok((await apps.addAppToRoom(R2.id, 'image-studio', {})).ok, 'setup: image-studio in room 2 (asset-studio is not)');

  console.log('[unregister with superseded_by]');
  let r = await unreg('image-studio', { superseded_by: 'asset-studio' }, false);
  eq(r.status, 403, 'a bearer (agent) cannot set it: 403');
  eq(table.getToolRegistry('image-studio')?.unregistered_at, null, '...and nothing moved');
  eq((await unreg('image-studio', { superseded_by: 'nope' })).status, 400, 'an unknown target: 400');
  eq((await unreg('image-studio', { superseded_by: 'image-studio' })).status, 400, 'itself: 400');
  eq((await unreg('image-studio', { superseded_by: 5 })).status, 400, 'not a slug: 400');
  table.holdTool('held-app');
  eq((await unreg('image-studio', { superseded_by: 'held-app' })).status, 400, 'a held target: 400');
  eq(table.getToolRegistry('image-studio')?.unregistered_at, null, 'refusals unregistered nothing');
  /* a held successor, kept for the link test below: model-studio -> asset-studio first */
  r = await unreg('image-studio', { superseded_by: 'asset-studio' });
  eq([r.status, table.getToolRegistry('image-studio')?.superseded_by], [200, 'asset-studio'], 'a person: 200, superseded_by stored');
  eq(r.body?.app?.superseded_by, { slug: 'asset-studio', name: 'Asset Studio' }, 'the app listing says replaced by Asset Studio');
  eq((await unreg('model-studio', { superseded_by: 'image-studio' })).status, 400, 'a target that is itself out: 400');
  eq((await unreg('asset-studio', { superseded_by: 'model-studio' })).status, 400, 'an app that is already a replacement cannot be replaced (no chain, no A->B->A)');
  eq(table.getToolRegistry('asset-studio')?.unregistered_at, null, '...and asset-studio stays registered');
  eq((await unreg('model-studio', {})).status, 200, 'a plain unregister still works');
  eq(table.getToolRegistry('model-studio')?.superseded_by, null, '...and sets nothing');

  console.log('[an old stored link resolves through the successor]');
  const L = apps.resolveLink(R.id, 'image-studio', 'review/3', null);
  eq([L.tool, L.ref, L.view_path], ['asset-studio', 'review/3', 'review/3'], 'server: the successor, the stored ref and view_path');
  eq(apps.resolveLink(R.id, 'image-studio', 'watch/job-9', null).view_path, 'watch/job-9', 'watch/<job> too');
  ok(/Asset Studio is not in this room/.test(throwsMsg(() => apps.resolveLink(R2.id, 'image-studio', 'review/3', null))), 'successor not in the room: "not in this room"');
  eq(apps.supersededTarget('image-studio')?.slug, 'asset-studio', 'the one resolver');
  eq(apps.supersededTarget('model-studio'), null, 'no successor: null');

  /* the page: catalog entries as GET /api/apps gives them */
  const catalog = new Map((await apps.catalog()).map((a) => [a.slug, a as any]));
  eq(effectiveTool('image-studio', catalog), 'asset-studio', 'page: the old slug resolves to the successor (panel / name / refs go by it)');
  eq(effectiveTool('asset-studio', catalog), 'asset-studio', 'page: a live app is itself');
  eq(effectiveTool('model-studio', catalog), 'model-studio', 'page: no successor: unchanged, refused as today');
  eq(effectiveTool('image-studio', new Map([['image-studio', catalog.get('image-studio')]])), 'image-studio', 'page: successor missing from the catalog: refused as today');
  const heldCat = new Map(catalog);
  heldCat.set('asset-studio', { ...catalog.get('asset-studio'), status: 'held' });
  eq(effectiveTool('image-studio', heldCat), 'image-studio', 'page: an unapproved successor refuses');
  const copy = /^#line-([0-9]+)~([a-z0-9-]+):(.+)$/.exec('#line-12~image-studio:review/3');
  eq(effectiveTool(copy![2], catalog), 'asset-studio', 'a copied link (#line-<id>~image-studio:review/3) resolves through the same function');

  console.log('[a new post is rewritten]');
  const w = await call('POST', LINE, { text: 'look', links: [{ tool: 'image-studio', ref: 'review/4' }] }, true);
  eq(w.status, 200, 'post naming the old slug: 200');
    eq(meta(w.body.entries[0])?.links?.map((l: any) => [l.tool, l.ref, l.view_path]), [['asset-studio', 'review/4', 'review/4']], 'stored under asset-studio, no dead-slug line');
  const w2 = await call('POST', `/api/rooms/${R2.id}/line`, { text: 'look', links: [{ tool: 'image-studio', ref: 'review/4' }] }, true);
  eq([w2.status, w2.body?.field], [400, 'links[0]'], 'in a room without the successor: refused');

  console.log('[an unapproved or held successor refuses; re-register clears]');
  table.holdTool('asset-studio');
  eq(apps.supersededTarget('image-studio'), null, 'held successor: no resolution');
  ok(/not registered/.test(throwsMsg(() => apps.resolveLink(R.id, 'image-studio', 'review/3', null))), 'the old link refuses as today');
  table.reregisterTool('asset-studio'); // keeps held=1 on its own; approve again below
  apps.approveApp('asset-studio');
  ok(!!apps.supersededTarget('image-studio'), 'approved again: resolves');
  table.unregisterTool('asset-studio', 'user');
  eq(apps.supersededTarget('image-studio'), null, 'an unregistered successor refuses');
  apps.registerBySlug('asset-studio', 'user');
  apps.registerBySlug('image-studio', 'user');
  eq(table.getToolRegistry('image-studio')?.superseded_by, null, 're-registering the old app clears superseded_by');
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error)?.stack ?? e}`);
} finally {
  http.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows: the store still holds the db (EPERM) */
  }
}

console.log(`${NL}PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
