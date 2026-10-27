/**
 * BASIC EDITION, engine half [basic] (Owner 2026-10-08, room interface; blueprint KB
 * design-notes-id, platform KB design-notes-id):
 *   - typed-command pass-through: a Basic room line from the user whose `/word` is not
 *     a Basic room command goes to the room's agent verbatim + the typed marker; the
 *     full edition still refuses it; /help and /? list room + agent commands;
 *   - the agent chat appends the same marker (Basic only);
 *   - the command registry (built-in v1 list, a file override, a bad file);
 *   - GET /api/commands; POST /api/projects/new-site with stub commands (success,
 *     retry = the same site, a failing command creates nothing, rollback + adopt,
 *     person-only, Basic-only); GET /api/rooms/:id/site (text and JSON status, a
 *     room that is not a site).
 *
 * SAFETY: temp table / data dir / sites dir set BEFORE any import; the "commands"
 * are node stubs written into the temp dir; nothing listens, nothing real spawns.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-basic-'));
const SITES = join(dir, 'code');
mkdirSync(SITES);
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_DATA_DIR = join(dir, 'data');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '0';
process.env.HARBOR_WB_VOICE_ENTER_MS = '5';
process.env.HARBOR_WB_SITES_DIR = SITES;
process.env.HARBOR_WB_EDITION = 'basic';
delete process.env.HARBOR_WB_ROOM_TYPE;
delete process.env.HARBOR_WB_COMMANDS_FILE;

/* ---- stub commands: `site new <name>` and `site status`, the remote-ops shapes ---- */
const NL = String.fromCharCode(10);
const stubNew = join(dir, 'stub-new.mjs');
writeFileSync(
  stubNew,
  [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    'const name = process.argv[2] ?? "";',
    "if (name.includes('FAIL')) { process.stderr.write('site: boom'); process.exit(3); }",
    "const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
    "mkdirSync(slug + '/www', { recursive: true });",
    "writeFileSync(slug + '/www/index.html', '<h1>' + name + '</h1>');",
    "const id = ('s' + slug.replace(/-/g, '') + 'zzzzzzzzzzzzzz').slice(0, 14);",
    "writeFileSync(slug + '/.site.json', JSON.stringify({ name, slug, id, public: false, published_at: null }));",
    "console.log('new project folder: ' + process.cwd() + '/' + slug);",
  ].join(NL),
);
const stubStatus = join(dir, 'stub-status.mjs');
writeFileSync(
  stubStatus,
  [
    "import { readFileSync } from 'node:fs';",
    "const m = JSON.parse(readFileSync('.site.json', 'utf8'));",
    "const prev = 'https://host.example.ts.net/preview/zack/' + m.slug + '/';",
    "if (process.env.STUB_STATUS_JSON) { console.log(JSON.stringify({ slug: m.slug, id: m.id, preview: prev, public: true, public_url: 'https://example.com/p/' + m.id + '/', published_at: '2026-10-08T01:02:03Z', unsaved: false })); process.exit(0); }",
    "console.log('project: ' + m.name + '  (slug ' + m.slug + ')');",
    "console.log('preview (private, tailnet only): ' + prev);",
    "if (process.env.STUB_PUBLIC) { console.log('PUBLIC: yes, since 2026-10-08T01:02:03Z'); console.log('public link: https://example.com/p/' + m.id + '/'); } else { console.log('PUBLIC: no (only you can see it, over Tailscale)'); }",
    "if (process.env.STUB_DIRTY) console.log('unsaved changes: yes (run /save before publishing)');",
  ].join(NL),
);
process.env.HARBOR_WB_NEWSITE_CMD = `${process.execPath} ${stubNew} {name}`;
process.env.HARBOR_WB_SITE_STATUS_CMD = `${process.execPath} ${stubStatus}`;

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const basic = await import('../src/server/basic.ts');
const rc = await import('../src/server/room-commands.ts');
const ac = await import('../src/engine/agent-commands.ts');
const sites = await import('../src/engine/sites.ts');
const agentChat = await import('../src/engine/agent-chat.ts');
const sessions = await import('../src/engine/sessions.ts');
const activity = await import('../src/engine/activity.ts');
const typer = await import('../src/engine/room-typer.ts');

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
const same = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': 'application/json' };
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
const logs: string[] = [];
let launched: string[] = [];
const launch = async (recipeId: string, _b: Record<string, unknown>, onPane: (p: string) => void) => {
  const paneid = `recipe:${recipeId}`;
  table.upsert({ paneid, recipe_id: recipeId, server: 'local', vendor: 'claude-code', agent: null, session_id: null, state: 'live' } as never);
  onPane(paneid);
  launched.push(paneid);
  return { ok: true as const, paneid, url: '/x', path: '/x', placement: 'tab' };
};
const deps = (human: boolean) => ({ projector: async () => (x: any) => x, log: (l: string) => logs.push(l), human, launch });
async function bcall(method: string, url: string, body?: unknown, human = true): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const handled = await basic.handle(req(method, url, body), resp(out), url.split('?')[0], deps(human) as never);
  return handled ? out : { status: -1, body: null };
}
async function rcall(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, url, body), resp(out), url.split('?')[0], null, deps(true) as never);
  return out;
}

try {
  console.log('\n[parse: Basic typed commands vs room commands]');
  const seats = [
    { id: 'S1', handle: 'builder', is_lead: true },
    { id: 'S2', handle: 'helper' },
  ];
  const P = (t: string, basicOn = true) => rc.parse(t, seats, { basic: basicOn });
  same(P('/publish'), { type: 'typed', text: '/publish', word: 'publish', to: ['S1'] }, '/publish goes to the lead, verbatim');
  same((P('/save first draft @helper') as any).to, ['S2'], 'an @-named seat gets it instead');
  same(P('/rename Space Game').type, 'typed', '/rename <name> is the agent\'s (rename the project)');
  same(P('/rename room Space').type, 'room', '/rename room <name> stays the room\'s');
  same(P('/add three').type, 'typed', '/add is the agent\'s in Basic');
  same(P('/set lead @helper').type, 'typed', 'multi-seat room verbs are not Basic room commands');
  same([P('/help').type, (P('/help') as any).verb, (P('/?') as any).verb], ['room', 'help', 'help'], '/help and /? are the room\'s help');
  same(P('/archive').type, 'room', '/archive stays a room command');
  same(P('/publish', false).type, 'refused', 'full edition: an unknown /word is still refused');
  same((P('/?', false) as any).verb, 'help', '/? is help in the full edition too');
  same(rc.parse('/publish', [{ id: 'S9', handle: 'solo' }], { basic: true }), { type: 'typed', text: '/publish', word: 'publish', to: ['S9'] }, 'no lead: the only seat');
  same(rc.parse('/publish', [], { basic: true }).type, 'refused', 'no seat at all: refused, said plainly');

  console.log('\n[the registry and the marker]');
  same(ac.agentCommands().map((c) => c.name).slice(0, 4), ['commands', 'preview', 'status', 'changes'], 'built-in v1 list');
  ok(ac.agentCommands().find((c) => c.name === 'undo')?.always === true, '/undo always confirms');
  same([ac.typedMarker('publish'), ac.typedMarker('status'), ac.typedMarker('nonsense')], [ac.TYPED_MARKER_CONFIRM, ac.TYPED_MARKER_PLAIN, ac.TYPED_MARKER_CONFIRM], 'confirm / plain / unknown = confirm');
  ok(ac.TYPED_MARKER_CONFIRM.startsWith(ac.TYPED_MARKER_PREFIX) && ac.TYPED_MARKER_PLAIN.startsWith(ac.TYPED_MARKER_PREFIX), 'both markers start with the agreed prefix');
  const cf = join(dir, 'commands.json');
  writeFileSync(cf, JSON.stringify({ commands: [{ name: '/deploy', explain: 'ship it', confirm: true }, { name: 'peek', explain: 'look', confirm: false }, { name: 'BAD NAME', explain: 'x' }] }));
  process.env.HARBOR_WB_COMMANDS_FILE = cf;
  same(ac.agentCommands().map((c) => c.name), ['deploy', 'peek'], 'a registry file replaces the list (slash optional, bad rows dropped)');
  writeFileSync(cf, '{ not json');
  same(ac.agentCommands().length, ac.DEFAULT_AGENT_COMMANDS.length, 'an unreadable file falls back to the built-in list');
  delete process.env.HARBOR_WB_COMMANDS_FILE;
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'commands.json'), JSON.stringify([{ name: 'publish', explain: 'from the data dir', confirm: true }]));
  same(ac.agentCommands().map((c) => c.explain), ['from the data dir'], '<data dir>/commands.json is read when present');
  rmSync(join(dir, 'data', 'commands.json'));

  console.log('\n[GET /api/commands]');
  let r = await bcall('GET', '/api/commands');
  same([r.status, r.body?.edition, r.body?.passThrough, r.body?.marker?.prefix], [200, 'basic', true, '(typed command:'], 'edition, pass-through, the marker');
  same(r.body?.room?.map((c: any) => c.name), ['/rename', '/wake', '/deliver', '/archive', '/reopen', '/help', '/?'], 'Basic room commands only');
  ok(r.body?.agent?.some((c: any) => c.name === '/publish' && c.confirm === true && c.explain.startsWith("You're asking")), 'agent commands with their plain line');

  console.log('\n[a Basic room: /publish reaches the agent verbatim, marked; /help lists both]');
  activity.setOnChange((p, s) => typer.onActivity(p, s));
  table.upsertRecipe({ id: 'rec-b', name: 'b', target: 'local', projectDir: '/x/b', vendor: 'claude-code', agent: 'b', model: null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
  const PB = 'recipe:rec-b';
  table.upsert({ paneid: PB, recipe_id: 'rec-b', server: 'local', vendor: 'claude-code', agent: 'b', session_id: null, state: 'live' } as never);
  const writes: string[] = [];
  sessions.add(PB, { state: 'live', pty: { write: (d: string) => writes.push(d) } } as never, null as never);
  activity.onLive(PB);
  const R = table.createRoom({ name: 'Hello' }, { actor: 'user' }).result;
  table.addSeat(R.id, { recipe_id: 'rec-b', occupant: PB } as never, { actor: 'user' });
  const LINE = `/api/rooms/${R.id}/line`;
  r = await rcall('POST', LINE, { text: '/publish' });
  same(r.status, 200, 'posted, not refused');
  const wrote = table.listLine(R.id, { kind: 'chat' }).at(-1);
  same([wrote?.body, wrote?.author], ['/publish', 'user'], 'the line is the user\'s, verbatim');
  for (let i = 0; i < 50 && !writes.some((w) => w.includes('/publish')); i++) await sleep(20);
  ok(writes.some((w) => w.includes('/publish ' + ac.TYPED_MARKER_CONFIRM)), 'the agent gets /publish + the typed marker');
  r = await rcall('POST', LINE, { text: '/?' });
  same([r.body?.client?.action, Array.isArray(r.body?.client?.agent), r.body?.client?.data?.some((c: any) => c.word === 'set')], ['help', true, false], '/? answers room (Basic) + agent commands');

  console.log('\n[the agent chat: Basic appends the marker]');
  const sent: string[] = [];
  const chatDeps = {
    row: () => ({ paneid: PB, vendor: 'claude-code', state: 'live' }) as never,
    isLive: () => true,
    location: () => null,
    typer: { enqueueChat: (_p: string, t: string) => (sent.push(t), 'injected' as const), heldFor: () => null },
    share: {} as never,
    log: () => {},
  };
  await agentChat.chatSend(PB, { text: '/status' }, chatDeps as never);
  await agentChat.chatSend(PB, { text: 'is it live?' }, chatDeps as never);
  same(sent, ['/status ' + ac.TYPED_MARKER_PLAIN, 'is it live?'], 'a typed /status is marked (no-confirm); plain words are not');
  process.env.HARBOR_WB_EDITION = 'full';
  await agentChat.chatSend(PB, { text: '/status' }, chatDeps as never);
  same(sent.at(-1), '/status', 'full edition: unchanged');
  process.env.HARBOR_WB_EDITION = 'basic';

  console.log('\n[New site]');
  table.upsertRecipe({ id: 'rec-builder', name: 'Builder', target: 'local', projectDir: null, vendor: 'claude-code', agent: 'builder', model: 'opus', resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: '#336699', fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
  r = await bcall('POST', '/api/projects/new-site', { name: 'Space Game' });
  same([r.status, r.body?.ok, r.body?.existed, r.body?.site?.slug, r.body?.site?.id], [200, true, false, 'space-game', 'sspacegamezzzz'], 'created: slug + the id the command minted');
  same(r.body?.site?.dir, join(SITES, 'space-game'), 'the folder');
  ok(existsSync(join(SITES, 'space-game', '.site.json')), 'the command made it (the engine did not)');
  same([r.body?.started, r.body?.previewUrl], [true, 'https://host.example.ts.net/preview/zack/space-game/'], 'its agent started; the preview link');
  const roomId = r.body?.room?.id;
  const rec = table.getRecipe(`site-${r.body?.site?.id}`);
  same([rec?.projectDir, rec?.model, rec?.name], [join(SITES, 'space-game'), 'opus', 'Space Game'], 'a Builder clone in the new folder');
  same(table.listSeats(roomId).map((s) => s.recipe_id), [rec?.id], 'one builder seat');
  const firstLine = table.listLine(roomId, { kind: 'chat' }).at(-1);
  ok(firstLine?.author === 'user' && firstLine.body?.includes(join(SITES, 'space-game')) && firstLine.body.includes('preview/zack/space-game') && firstLine.body.includes('Public: not yet'), 'the first message: name, folder, preview, public status');
  same(table.getSiteByRoom(roomId)?.slug, 'space-game', 'the room is locked to its site');
  const nRooms = table.listRooms().length;
  r = await bcall('POST', '/api/projects/new-site', { name: 'Space  Game' });
  same([r.status, r.body?.existed, r.body?.room?.id, table.listRooms().length], [200, true, roomId, nRooms], 'a retry answers the same site, makes nothing');

  r = await bcall('POST', '/api/projects/new-site', { name: 'FAIL here' });
  same([r.status, r.body?.field, r.body?.detail, table.listRooms().length], [502, 'command', 'site: boom', nRooms], 'a failing command: a clear error, no room');

  const realAdd = table.addSeat;
  (table as any).addSeat = () => {
    throw new Error('seat refused');
  };
  r = await bcall('POST', '/api/projects/new-site', { name: 'Rolled' });
  (table as any).addSeat = realAdd;
  const rolled = table.listRooms().find((x) => x.name === 'Rolled');
  same([r.status, r.body?.field, rolled?.state, table.getSiteBySlug('rolled'), table.getRecipe('site-srolledzzzzzzzz')], [409, 'room', 'archived', undefined, undefined], 'a failure after the command: room archived, recipe + row gone');
  r = await bcall('POST', '/api/projects/new-site', { name: 'Rolled' });
  same([r.status, r.body?.site?.id], [200, 'srolledzzzzzzz'], 'a retry adopts the folder it left (same project, same id)');

  r = await bcall('POST', '/api/projects/new-site', { name: 'Other' }, false);
  same(r.status, 403, 'person only');
  r = await bcall('POST', '/api/projects/new-site', { name: '' });
  same([r.status, r.body?.field], [400, 'name'], 'a name is required');
  process.env.HARBOR_WB_EDITION = 'full';
  r = await bcall('POST', '/api/projects/new-site', { name: 'Other' });
  same(r.status, 404, 'Basic only');
  process.env.HARBOR_WB_EDITION = 'basic';

  console.log('\n[GET /api/rooms/:id/site]');
  r = await bcall('GET', `/api/rooms/${roomId}/site`);
  same(
    [r.status, r.body?.slug, r.body?.id, r.body?.previewUrl, r.body?.publicUrl, r.body?.published, r.body?.lastPublishedAt, r.body?.changedSinceSave],
    [200, 'space-game', 'sspacegamezzzz', 'https://host.example.ts.net/preview/zack/space-game/', null, false, null, false],
    'the remote-ops text: private, no changes',
  );
  process.env.STUB_PUBLIC = '1';
  process.env.STUB_DIRTY = '1';
  r = await bcall('GET', `/api/rooms/${roomId}/site`);
  same([r.body?.published, r.body?.publicUrl, r.body?.lastPublishedAt, r.body?.changedSinceSave], [true, 'https://example.com/p/sspacegamezzzz/', '2026-10-08T01:02:03Z', true], 'public + unsaved changes');
  delete process.env.STUB_PUBLIC;
  delete process.env.STUB_DIRTY;
  process.env.STUB_STATUS_JSON = '1';
  r = await bcall('GET', `/api/rooms/${roomId}/site`);
  same([r.body?.previewUrl, r.body?.publicUrl, r.body?.published, r.body?.changedSinceSave], ['https://host.example.ts.net/preview/zack/space-game/', 'https://example.com/p/sspacegamezzzz/', true, false], 'a JSON status is read too');
  delete process.env.STUB_STATUS_JSON;
  r = await bcall('GET', `/api/rooms/${R.id}/site`);
  same(r.body, { slug: null, id: null, previewUrl: null, publicUrl: null, published: null, lastPublishedAt: null, changedSinceSave: null }, 'not a site room: every field null');
  r = await bcall('GET', '/api/rooms/nope/site');
  same(r.status, 404, 'no such room');

  console.log('\n[sites helpers]');
  same(sites.slugify('  Hello, World!  '), 'hello-world', 'slugify = remote-ops');
  same(sites.argvOf('site new {name} --at {dir}', { name: 'Two words; $(rm)', slug: 's', id: 'i', dir: '/d' }), ['site', 'new', 'Two words; $(rm)', '--at', '/d'], 'a placeholder is ONE argument, never a shell');
  ok(/^[a-z2-7]{14}$/.test(sites.newSiteId()), 'an id: 14 base32 chars');
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* held open */
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
