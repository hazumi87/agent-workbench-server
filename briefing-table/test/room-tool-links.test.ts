/**
 * LINE LINKS INTO A TOOL VIEW [rooms/tool-links], engine half.
 *
 *   - tool.json `links` validation (engine/tool-links.ts parseLinks): the
 *     candidate list names every malformed pattern / label / view / "@meta",
 *     registration refuses it; the catalog exposes `links` (pattern -> label)
 *     and `links_meta` (the batch endpoint, frame-relative);
 *   - POST .../line `links: [{tool, ref, label?}]` on EVERY post path (the
 *     window, bearer + from, a tool line, the pane token, the attachment
 *     send): 400 field 'links[i]' for an unknown tool, a tool not in this
 *     room, a held tool, a bad ref, a bad label; 400 'links' for > 8 or not a
 *     list; nothing written or moved when refused;
 *   - meta.links = [{tool, ref, label, view_path, panel_id}]; view_path passes
 *     the page's OWN cleanPath (lifted from web/room-cells.mjs) and, through
 *     the page's viewUrl + the frame proxy's upstreamFor, reaches exactly the
 *     declared view on the app;
 *   - the delivered text: one trailing `[links: …]` line on the typed copy and
 *     the fabric channel copy; GET .../line returns meta.links as stored.
 *
 * SAFETY: a temp table + tools dir set BEFORE any import; the fabric is a
 * stub on P(218); nothing spawns, no app runs (a link never needs the app
 * up). Run with tsx.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { P, assertFree } from './_scratch.mjs';

const FABRIC_PORT = P(218);
await assertFree(FABRIC_PORT, 'room-tool-links.test.ts');

const dir = mkdtempSync(join(tmpdir(), 'wb-tool-links-'));
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
// A file already moved into the store needs a store address to build its link (no default address any more);
// nothing here talks to it (no upload, no fetch).
process.env.HARBOR_WB_AGENT_SHARE_URL = 'http://127.0.0.1:9';
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
      return json(200, { thread: 't-links' });
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

/* The page's cleanPath + viewUrl, lifted from the SHIPPED web/room-cells.mjs. */
const cellsSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room-cells.mjs'), 'utf8').replace(/\r\n/g, '\n'); // CRLF on a Windows (autocrlf) checkout
const cpSrc = cellsSrc.slice(cellsSrc.indexOf('function cleanPath(p) {'), cellsSrc.indexOf('/** frameUrl + a clean path'));
/* viewUrl alone: from its declaration to the first top-level closing brace, so
   a helper added after it (cellTone's `export`, ticket) can't leak into the slice. */
const vuStart = cellsSrc.indexOf('function viewUrl(frameUrl, path) {');
const vuSrc = cellsSrc.slice(vuStart, cellsSrc.indexOf(String.fromCharCode(10) + '}', vuStart) + 2);
const pageCleanPath = new Function(`${cpSrc}; return cleanPath;`)() as (p: unknown) => string | null;
const pageViewUrl = new Function('location', `${vuSrc}; return viewUrl;`)({ href: 'https://host.example/room.html?id=x' }) as (f: string, p: string) => string;

function writeTool(slug: string, parsed: Record<string, unknown>): string {
  const root = join(toolsDir, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tool.json'), JSON.stringify(parsed, null, 2));
  return root;
}
const tool = (slug: string, name: string, linksDecl: unknown) => ({
  contract: 'tool/draft-0',
  name,
  slug,
  version: '0.1.0',
  description: `${name} description`,
  access: 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  panels: [{ title: name, icon: 'image', view: 'GET /rooms/:roomId/view' }],
  ...(linksDecl === undefined ? {} : { links: linksDecl }),
});
const GOOD_LINKS = {
  'review/:n': { label: 'Review item', view: 'GET /rooms/:roomId/review/:n' },
  'set/:s/item/:n': { label: 'Set item', view: 'GET /rooms/:roomId/sets/:s?item=:n' },
  '@meta': 'GET /rooms/:roomId/links',
};

try {
  console.log('\n[unit: patterns, refs, labels, the delivery line]');
  const views = ['GET /rooms/:roomId/view'];
  const parsed = links.parseLinks(GOOD_LINKS, views);
  eq(parsed.problems, [], 'the good declaration has no problems');
  eq(parsed.specs.map((s) => s.pattern), ['review/:n', 'set/:s/item/:n'], '"@meta" is not a pattern');
  eq(parsed.meta, 'links', '"@meta" resolves frame-relative: links');
  const m1 = links.matchRef(parsed.specs, 'review/2');
  eq([m1?.spec.pattern, m1?.values], ['review/:n', { n: '2' }], 'review/2 matches review/:n with n=2');
  eq(links.matchRef(parsed.specs, 'set/spring-24/item/7')?.values, { s: 'spring-24', n: '7' }, 'two params resolve');
  for (const bad of ['review', 'review/2/x', 'review/UP', 'review/a_b', 'review/', 'reviews/2', `review/${'a'.repeat(65)}`, '', 7]) {
    eq(links.matchRef(parsed.specs, bad), null, `ref ${JSON.stringify(bad)} matches nothing`);
  }
  const r2 = links.resolveView(m1!.spec, 'R1', m1!.values, views);
  eq(r2?.view_path, 'review/2', 'view_path is relative to the panel folder');
  const q = links.resolveView(links.matchRef(parsed.specs, 'set/a/item/3')!.spec, 'R1', { s: 'a', n: '3' }, views);
  eq(q?.view_path, 'sets/a?item=3', 'a query survives in view_path');
  eq(links.cleanLabel('  #2 her shoes '), '#2 her shoes', 'a label is trimmed');
  eq([links.cleanLabel(''), links.cleanLabel('x'.repeat(81)), links.cleanLabel('a\nb'), links.cleanLabel(3)], [null, null, null, null], 'empty / >80 / multi-line / not a string: refused');
  const L = [
    { tool: 'studio', ref: 'review/2', label: '#2 her shoes', view_path: 'review/2', panel_id: null },
    { tool: 'studio', ref: 'review/3', label: 'say "hi"', view_path: 'review/3', panel_id: null },
  ];
  eq(links.linksLine(L), '[links: studio review/2 "#2 her shoes", studio review/3 "say \'hi\'"]', 'the compact line; an inner " becomes \'');
  eq(links.withLinks('look', L.slice(0, 1)), 'look\n[links: studio review/2 "#2 her shoes"]', 'withLinks: a trailing line');
  eq(links.withLinks('look', []), 'look', 'no links: the body unchanged');
  for (const p of ['review/2', 'sets/a?item=3', '../x', '/abs', 'http://x', 'a/%2e%2e/b', 'x'.repeat(201), '']) {
    eq(links.cleanPath(p), pageCleanPath(p), `cleanPath agrees with the page's: ${JSON.stringify(p.slice(0, 20))}`);
  }

  console.log('\n[tool.json links validation: candidates, registration, the catalog]');
  const rootS = writeTool('studio', tool('studio', 'Image Studio', GOOD_LINKS));
  writeTool('other', tool('other', 'Other', GOOD_LINKS));
  const rootH = writeTool('heldtool', tool('heldtool', 'Held Tool', GOOD_LINKS));
  writeTool('plain', tool('plain', 'Plain', undefined));
  writeTool('badlinks', tool('badlinks', 'Bad', {
    'Review/:n': { label: 'x', view: 'GET /rooms/:roomId/review/:n' },
    'a/:roomId': { label: 'x', view: 'GET /rooms/:roomId/a' },
    'b/:x': { label: '', view: 'GET /rooms/:roomId/b/:x' },
    'c/:x': { label: 'ok', view: 'GET /elsewhere/:x' },
    'd/:x': { label: 'ok', view: 'GET /rooms/:roomId/../d/:x' },
    'e/:x': { label: 'ok', view: 'GET /rooms/:roomId/e/:y' },
    'f/:x': { label: 'ok', view: 'POST /rooms/:roomId/f/:x' },
    'g/:x/:x': { label: 'ok', view: 'GET /rooms/:roomId/g/:x' },
    '@meta': 'GET /other/links',
  }));
  writeTool('notobject', tool('notobject', 'Not an object', ['review/:n']));
  const cand = apps.listCandidates().candidates;
  const bad = cand.find((c) => c.slug === 'badlinks');
  eq(bad?.ok, false, 'badlinks: not ok');
  const probs = (bad?.problems ?? []).join(' | ');
  for (const [what, re] of [
    ['an upper-case literal', /link "Review\/:n": the pattern segment "Review"/],
    [':roomId as a param', /link "a\/:roomId": the pattern :roomId is the room/],
    ['an empty label', /link "b\/:x": label/],
    ['a view outside the panel folder', /link "c\/:x": view must be a sub-path/],
    ['a .. segment', /link "d\/:x": view the path may not contain a '\.' or '\.\.'/],
    ['an unknown :name', /link "e\/:x": view names :y/],
    ['not GET', /link "f\/:x": view "POST/],
    ['a repeated param', /link "g\/:x\/:x": the pattern repeats :x/],
    ['@meta outside the panel folder', /links "@meta": must be a sub-path/],
  ] as const) {
    ok(re.test(probs), `candidates name ${what}`);
  }
  eq(cand.find((c) => c.slug === 'notobject')?.problems, ['links must be an object: {"<pattern>": {label, view}}'], 'links as a list: a problem');
  eq(cand.find((c) => c.slug === 'studio')?.ok, true, 'studio: a valid candidate');
  eq(cand.find((c) => c.slug === 'plain')?.ok, true, 'no links at all: valid');
  let threw = '';
  try {
    apps.registerApp(join(toolsDir, 'badlinks'), 'user');
  } catch (e) {
    threw = `${(e as any).status}:${(e as Error).message}`;
  }
  ok(/^400:tool\.json is invalid: .*link/.test(threw), `registration refuses malformed links (${threw.slice(0, 60)}...)`);
  for (const s of ['studio', 'other', 'heldtool', 'plain']) {
    apps.registerApp(join(toolsDir, s), 'user');
  }
  const cat = await apps.catalog();
  const cs = cat.find((a) => a.slug === 'studio');
  eq(cs?.links, { 'review/:n': 'Review item', 'set/:s/item/:n': 'Set item' }, 'catalog: links (pattern -> label)');
  eq(cs?.links_meta, 'links', 'catalog: links_meta (frame-relative)');
  eq([cat.find((a) => a.slug === 'plain')?.links, cat.find((a) => a.slug === 'plain')?.links_meta], [{}, null], 'no links: {} and null');

  /* ---- a room with @the design system (the lead, a fake pty) and @buddy ---- */
  const writes: Record<string, string[]> = {};
  for (const [id, agent] of [['rec-a', 'auriga'], ['rec-b', 'buddy']]) {
    table.upsertRecipe({
      id, name: agent, target: 'local', projectDir: `/x/${agent}`, vendor: 'claude-code', agent, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
    const pane = `recipe:${id}`;
    table.upsert({ paneid: pane, recipe_id: id, server: 'local', vendor: 'claude-code', agent, session_id: null, state: 'live', generation: 1 } as never);
    writes[pane] = [];
    sessions.add(pane, { state: 'live', pty: { write: (d: string) => writes[pane].push(d) } } as never, null as never);
    activity.onLive(pane);
  }
  activity.setOnChange((p, s) => typer.onActivity(p, s));
  const A = 'recipe:rec-a';
  const B = 'recipe:rec-b';
  const R = table.createRoom({ name: 'Links room' }, { actor: 'user' }).result;
  const sa = table.addSeat(R.id, { recipe_id: 'rec-a', occupant: A }, { actor: 'user' }).result;
  table.addSeat(R.id, { recipe_id: 'rec-b', occupant: B }, { actor: 'user' });
  if (!table.getRoom(R.id)?.lead_seat) {
    table.updateRoom(R.id, { lead_seat: sa.id }, { actor: 'user' });
  }
  for (const s of ['studio', 'heldtool', 'plain']) {
    const add = await apps.addAppToRoom(R.id, s, {});
    eq(add.ok, true, `${s} added to the room (down: no panel yet)`);
  }
  const LINE = `/api/rooms/${R.id}/line`;
  const nLines = () => table.listLine(R.id).length;

  console.log('\n[validation: 400 links[i] / links, nothing written]');
  const before = nLines();
  const cases: Array<[string, unknown, string, RegExp]> = [
    ['not a list', { tool: 'studio', ref: 'review/2' }, 'links', /list/],
    ['> 8', Array.from({ length: 9 }, (_, i) => ({ tool: 'studio', ref: `review/${i}` })), 'links', /at most 8/],
    ['not an object', ['studio review/2'], 'links[0]', /tool, ref/],
    ['an unknown tool', [{ tool: 'nope', ref: 'review/2' }], 'links[0]', /no app "nope"/],
    ['a bad slug', [{ tool: 'Studio!', ref: 'review/2' }], 'links[0]', /slug/],
    ['a tool not in this room', [{ tool: 'studio', ref: 'review/2' }, { tool: 'other', ref: 'review/2' }], 'links[1]', /Other is not in this room/],
    ['no ref', [{ tool: 'studio' }], 'links[0]', /ref is required/],
    ['a bad ref', [{ tool: 'studio', ref: 'review/2/3' }], 'links[0]', /matches none of Image Studio's links \(review\/:n, set\/:s\/item\/:n\)/],
    ['a tool with no links', [{ tool: 'plain', ref: 'review/2' }], 'links[0]', /declares none/],
    ['a label over 80', [{ tool: 'studio', ref: 'review/2', label: 'x'.repeat(81) }], 'links[0]', /label/],
    ['a multi-line label', [{ tool: 'studio', ref: 'review/2', label: 'a\nb' }], 'links[0]', /label/],
    ['a label that is not text', [{ tool: 'studio', ref: 'review/2', label: 5 }], 'links[0]', /label/],
  ];
  for (const [what, l, field, re] of cases) {
    const r = await call('POST', LINE, { text: 'see this', links: l }, true);
    ok(r.status === 400 && r.body?.field === field && re.test(r.body?.error ?? ''), `${what}: 400 ${field} (${r.status} ${r.body?.field} ${r.body?.error})`);
  }
  eq(nLines(), before, 'nothing refused was written');

  console.log('\n[the window: meta.links, view_path, panel_id]');
  const w1 = await call('POST', LINE, { text: 'take a look', links: [{ tool: 'studio', ref: 'review/2', label: '#2 her shoes' }, { tool: 'studio', ref: 'set/a/item/3' }] }, true);
  eq(w1.status, 200, '200');
  const E1 = w1.body.entries[0];
  eq(meta(E1)?.links, [
    { tool: 'studio', ref: 'review/2', label: '#2 her shoes', view_path: 'review/2', panel_id: null },
    { tool: 'studio', ref: 'set/a/item/3', label: 'Set item', view_path: 'sets/a?item=3', panel_id: null },
  ], 'meta.links as resolved: the label (or the pattern\'s), view_path, panel_id null (no panel yet)');
  await until(() => writes[A].length, (n) => n >= 1);
  ok(writes[A][0]?.replace(/ reply_to \d+;/, ';').endsWith('take a look [links: studio review/2 "#2 her shoes", studio set/a/item/3 "Set item"]' + typer.USER_REPLY_HINT), `TYPED path: the links line, its newline flattened (${JSON.stringify(writes[A][0])})`);
  const s1 = await until(() => sends.find((s) => s.ref === `room:${R.id}/line:${E1.id}`), (v) => !!v);
  eq(s1?.body, 'take a look\n[links: studio review/2 "#2 her shoes", studio set/a/item/3 "Set item"]', 'CHANNEL path: the links line trails the words');
  activity.onTurnStart(A);
  activity.onResponseDone(A);
  writes[A].length = 0;

  /* the app's panel lands (it started): panel_id follows, and the path the
     page builds reaches exactly the declared view on the app */
  const panelUrl = `http://127.0.0.1:45999/rooms/${R.id}/view`;
  table.fillRoomAppPanels(R.id, 'studio', [{ title: 'Image Studio', icon: 'image', url: panelUrl, scripts: true, uploads: false }]);
  const pid = table.listPanels(R.id).find((p) => p.app_slug === 'studio')?.id;
  ok(!!pid, 'setup: studio has a panel in the room');
  const w2 = await call('POST', LINE, { text: '@buddy check', links: [{ tool: 'studio', ref: 'set/spring-24/item/7' }] }, true);
  const L2 = meta(w2.body.entries[0])?.links?.[0];
  eq(L2?.panel_id, pid, 'panel_id: the app\'s panel in this room');
  eq(pageCleanPath(L2?.view_path), L2?.view_path, "view_path passes the page's cleanPath");
  const frame = proxy.frameUrlFor(R.id, pid!);
  const viewed = pageViewUrl(frame, L2.view_path);
  ok(viewed.startsWith(frame), `the page's viewUrl stays under the frame (${viewed.slice(-30)})`);
  const fp = proxy.parseFramePath(viewed.split('?')[0]);
  const up = proxy.upstreamFor(panelUrl, fp!.tail, '?' + viewed.split('?')[1]);
  eq(up?.href, `http://127.0.0.1:45999/rooms/${R.id}/sets/spring-24?item=7`, 'through the frame proxy: exactly the declared view');
  await until(() => writes[B].length, (n) => n >= 1);
  activity.onTurnStart(B);
  activity.onResponseDone(B);

  console.log('\n[bearer + from, a carried command, a tool line, a room command]');
  const f1 = await call('POST', LINE, { text: 'for review', from: { paneid: B }, links: [{ tool: 'studio', ref: 'review/4' }] });
  eq([f1.status, meta(f1.body.entries[0])?.links?.[0]?.ref], [200, 'review/4'], 'bearer + from: stored');
  const f2 = await call('POST', LINE, { text: 'x', from: { paneid: B }, links: [{ tool: 'other', ref: 'review/4' }] });
  eq(`${f2.status}/${f2.body?.field}`, '400/links[0]', 'bearer + from: validated');
  const t1 = await call('POST', LINE, { text: '4 drafts ready', from: { paneid: B }, tool: { slug: 'studio', for: 'user' }, links: [{ tool: 'studio', ref: 'review/5', label: 'Draft 5' }] });
  eq(meta(t1.body.entries[0])?.links?.[0], { tool: 'studio', ref: 'review/5', label: 'Draft 5', view_path: 'review/5', panel_id: pid }, 'a tool line: meta.links beside meta.tool');
  eq(meta(t1.body.entries[0])?.tool, 'studio', '...meta.tool kept');
  const t2 = await call('POST', LINE, { text: 'x', from: { paneid: B }, tool: { slug: 'studio', for: 'user' }, links: [{ tool: 'studio', ref: 'nope' }] });
  eq(`${t2.status}/${t2.body?.field}`, '400/links[0]', 'a tool line: validated');
  const c1 = await call('POST', LINE, { text: '/archive', links: [{ tool: 'studio', ref: 'review/2' }] }, true);
  eq([c1.status, c1.body?.status], [200, 'refused'], 'a room command with links: refused (links go with a message)');
  eq(table.getRoom(R.id)?.state, 'open', '...and nothing happened');

  console.log('\n[the pane token]');
  const p1 = await asPane(B, 'POST', LINE, { text: 'from my pane', links: [{ tool: 'studio', ref: 'review/6' }] });
  eq([p1.status, meta(p1.body.entries?.[0])?.links?.[0]?.view_path], [200, 'review/6'], 'the pane token: stored');
  const p2 = await asPane(B, 'POST', LINE, { text: 'x', links: [{ tool: 'studio', ref: 'review/Z' }] });
  eq(`${p2.status}/${p2.body?.field}`, '400/links[0]', 'the pane token: validated');

  console.log('\n[the attachment send]');
  const who = pictureOwner(null);
  table.addRoomScratch({ id: 'scr-1', userKey: who.key, roomId: R.id, name: 'shot.png', type: 'image/png', size: 3 }, 20);
  table.setRoomScratchMoved('scr-1', `rooms/${R.id}/shot.png`);
  const a0 = await call('POST', LINE, { text: 'x', attachments: ['scr-1'], links: [{ tool: 'heldtool', ref: 'nope' }] }, true);
  eq(`${a0.status}/${a0.body?.field}`, '400/links[0]', 'the attachment send: validated before any file moves');
  ok(!!table.getRoomScratch(who.key, R.id, 'scr-1'), '...the draft file is still there');
  const a1 = await call('POST', LINE, { text: 'with a file', attachments: ['scr-1'], links: [{ tool: 'studio', ref: 'review/8' }] }, true);
  eq(a1.status, 200, 'the attachment send: 200');
  const AE = a1.body.entries[0];
  eq([meta(AE)?.attachments?.length, meta(AE)?.links?.[0]?.ref], [1, 'review/8'], 'meta carries the files AND the links');
  const typedA = () => writes[A].find((w) => w.includes('with a file')) ?? '';
  for (let i = 0; i < 20 && !typedA(); i++) {
    activity.onTurnStart(A); // earlier lines to the lead were held behind its turn
    activity.onResponseDone(A);
    await sleep(50);
  }
  ok(typedA().replace(/ reply_to \d+;/, ';').endsWith('[links: studio review/8 "Review item"]' + typer.USER_REPLY_HINT), `the attachment copy ends with the links line (${JSON.stringify(typedA().slice(-50))})`);
  activity.onTurnStart(A);
  activity.onResponseDone(A);

  console.log('\n[held]');
  writeFileSync(join(rootH, 'tool.json'), JSON.stringify({ ...tool('heldtool', 'Held Tool', GOOD_LINKS), version: '0.2.0' }, null, 2));
  const h1 = await call('POST', LINE, { text: 'x', links: [{ tool: 'heldtool', ref: 'review/2' }] }, true);
  ok(h1.status === 400 && h1.body?.field === 'links[0]' && /held/.test(h1.body?.error), `a held app: 400 links[0] (${h1.body?.error})`);

  console.log('\n[GET .../line returns meta.links as stored]');
  const g = await call('GET', LINE);
  const got = g.body.entries.find((e: any) => e.id === E1.id);
  eq(meta(got)?.links, meta(E1)?.links, 'the line read: meta.links unchanged');
  await apps.removeAppFromRoom(R.id, 'studio');
  const g2 = await call('GET', LINE);
  eq(meta(g2.body.entries.find((e: any) => e.id === E1.id))?.links?.length, 2, 'the app left: the stored links stay (the page disables them)');
  void rootS;
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

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
