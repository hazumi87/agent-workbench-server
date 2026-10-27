/**
 * The Concierge, P0 + P1 engine half (the design notes): settings (strict
 * PATCH, lenient read, every action OFF), THE pane (the active recipe's primary
 * pane, never a fresh pane of it, never in Basic), the off switch, wb: links
 * resolved as the chat is served, the unread badge, both route doors, and the
 * voice flag riding the chat frame. No server, no pty. The real pane-token door
 * is driven in concierge-routes.test.mjs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-concierge-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
delete process.env.HARBOR_WB_EDITION;

const cg = await import('../src/engine/concierge.ts');
const routes = await import('../src/server/concierge.ts');
const chat = await import('../src/engine/agent-chat.ts');
const typer = await import('../src/engine/room-typer.ts');
const { table } = await import('../src/table/endpoint.ts');

let checks = 0;
let failed = 0;
const ok = (c: unknown, m: string) => {
  checks++;
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failed++;
};
const section = (s: string) => console.log(`\n[${s}]`);
const throwsField = (fn: () => unknown, field: string, m: string) => {
  try {
    fn();
    ok(false, `${m} (did not throw)`);
  } catch (e) {
    ok(e instanceof cg.ConciergeError && e.field === field, `${m} (${(e as Error).message})`);
  }
};

const recipes = new Set(['rec-cg', 'rec-cx', 'rec-other']);
const exists = (id: string) => recipes.has(id);

section('settings: name and @ name');
{
  const d = cg.settings();
  ok(d.displayName === null && d.handle === null, 'default: no display name, no @ name');
  const p = cg.validPatch({ displayName: '  Olivia  ', handle: ' @Olivia ' }, exists);
  ok(p.displayName === 'Olivia' && p.handle === 'olivia', 'the name is trimmed; the @ name loses its @ and is lowercased');
  ok(cg.validPatch({ displayName: '', handle: '' }, exists).handle === null, 'empty clears both');
  throwsField(() => cg.validPatch({ handle: 'o' }, exists), 'handle', 'a one-letter @ name is refused');
  throwsField(() => cg.validPatch({ handle: '9lives' }, exists), 'handle', 'an @ name starts with a letter');
  throwsField(() => cg.validPatch({ handle: 'user' }, exists), 'handle', 'a reserved word is refused');
  throwsField(() => cg.validPatch({ handle: 'platform' }, exists, (h) => h === 'platform'), 'handle', 'a seat name is refused');
  throwsField(() => cg.validPatch({ displayName: 'x'.repeat(41) }, exists), 'displayName', 'a long name is refused');
  throwsField(() => cg.validPatch({ displayName: 'a\u0007b' }, exists), 'displayName', 'a control character is refused');
  const s2 = cg.setSettings(p);
  ok(s2.displayName === 'Olivia' && s2.handle === 'olivia' && cg.settings().handle === 'olivia', 'saved and read back');
  ok(cg.settingsFrom({ handle: 'BAD NAME', displayName: 7 }).handle === null, 'the reader drops a bad stored value');
  cg.setSettings({ displayName: null, handle: null });
}

section('settings: defaults, strict PATCH, lenient read');
{
  const s = cg.settings();
  ok(s.enabled === false && s.primary === null && s.fallback === null && s.active === 'primary', 'default: off, no recipes, primary active');
  ok(cg.ACTIONS.every((a) => s.allowed[a] === false), 'every allowed action defaults OFF');
  throwsField(() => cg.validPatch({ nope: 1 }, exists), 'nope', 'an unknown key is refused');
  throwsField(() => cg.validPatch({ enabled: 'yes' }, exists), 'enabled', 'enabled must be a boolean');
  throwsField(() => cg.validPatch({ primary: 'ghost' }, exists), 'primary', 'an unknown recipe is refused');
  throwsField(() => cg.validPatch({ allowed: { inject: 'on' } }, exists), 'allowed.inject', 'an action switch must be a boolean');
  throwsField(() => cg.validPatch({ allowed: { launchMissiles: true } }, exists), 'allowed.launchMissiles', 'an unknown action is refused');
  throwsField(() => cg.setSettings({ primary: 'rec-cg', fallback: 'rec-cg' }), 'fallback', 'the fallback must differ from the primary');
  throwsField(() => cg.setSettings({ active: 'fallback' }), 'active', 'there is no fallback to make active');
  ok(cg.settingsFrom({ enabled: 'x', allowed: { inject: 1 }, active: 'weird' }).enabled === false, 'the reader is lenient: bad fields fall back');
}

section('THE pane: the active recipe\'s primary pane, while enabled');
{
  cg.setSettings({ primary: 'rec-cg', fallback: 'rec-cx' });
  ok(cg.conciergePane() === null, 'disabled: there is no concierge pane');
  cg.setSettings({ enabled: true });
  ok(cg.conciergePane() === 'recipe:rec-cg', 'enabled: the primary recipe\'s primary pane');
  ok(cg.isConciergePane('recipe:rec-cg'), 'that pane is the concierge');
  ok(!cg.isConciergePane('recipe:rec-cg#1a2b3c4d'), 'a fresh pane of the SAME recipe never is');
  ok(!cg.isConciergePane('recipe:rec-other'), 'another recipe\'s pane is not');
  cg.setSettings({ active: 'fallback' });
  ok(cg.conciergePane() === 'recipe:rec-cx' && !cg.isConciergePane('recipe:rec-cg'), 'the manual toggle moves the concierge to the fallback at once');
  cg.setSettings({ active: 'primary' });
  process.env.HARBOR_WB_EDITION = 'basic';
  ok(cg.conciergePane() === null, 'Basic: never a concierge');
  delete process.env.HARBOR_WB_EDITION;
}

section('wb: links, resolved as the chat is served');
{
  const deps: typeof cg extends never ? never : Parameters<typeof cg.resolveLink>[1] = {
    room: (id) => (id === 'R1' ? { id: 'R1', name: 'Alpha', state: 'open' } : id === 'R2' ? { id: 'R2', name: 'Old', state: 'archived' } : undefined),
    lineInRoom: (roomId, line) => roomId === 'R1' && line === 12,
    pane: (p) => (p === 'recipe:a#1' ? { recipe_id: 'a', state: 'live' } : p === 'recipe:gone' ? { recipe_id: 'g', state: 'killed' } : undefined),
    soloPath: (r, p) => `/solo.html?recipe=${r}&pane=${encodeURIComponent(p)}`,
    roomHasApp: (roomId, slug) => roomId === 'R1' && slug === 'notes',
  };
  const text = 'Try wb:room/R1#line-12, then wb:pane/recipe:a#1 and wb:app/R1/notes. Also wb:manager; old: wb:room/R2 and wb:room/R1#line-99.';
  const hrefs = cg.linksIn(text);
  ok(hrefs.join(' ') === 'wb:room/R1#line-12 wb:pane/recipe:a#1 wb:app/R1/notes wb:manager wb:room/R2 wb:room/R1#line-99', 'every link found once, trailing punctuation dropped');
  const r = hrefs.map((h) => cg.resolveLink(h, deps));
  ok(r[0].ok && r[0].url === '/room.html?room=R1#line-12' && r[0].room === 'R1', 'a room line opens the room at that line');
  ok(r[1].ok && r[1].url === '/solo.html?recipe=a&pane=recipe%3Aa%231', 'a pane opens its solo page');
  ok(r[2].ok && r[2].url === '/room.html?room=R1', 'an app opens its room');
  ok(r[3].ok && r[3].url === '/manager.html', 'wb:manager opens the Workbench');
  ok(!r[4].ok && r[4].note === 'that room is not open', 'an archived room is a dead link with a note');
  ok(!r[5].ok && /#99/.test(r[5].note ?? ''), 'a line not in that room is dead');
  ok(!cg.resolveLink('wb:pane/recipe:gone', deps).ok, 'an ended session is dead');
  const items = cg.withLinks([{ role: 'user', text: 'wb:manager' }, { role: 'agent', text: 'see wb:manager' }, { role: 'agent', text: 'none' }], deps);
  ok(!('links' in items[0]) && (items[1] as any).links?.length === 1 && !('links' in items[2]), 'only agent replies carrying links are annotated');
}

section('the badge: replies since the person last looked');
{
  cg.resetCache();
  cg.setChatSource(async () => ({ items: [{ id: 'a1', role: 'agent', ts: 100 }, { id: 'u1', role: 'user', ts: 150 }, { id: 'a2', role: 'agent', ts: 200 }] }));
  let u = await cg.unreadFor('owner', 1_000);
  ok(u?.unread === 2 && u.newestId === 'a2', 'two agent replies, none seen');
  cg.markSeen('owner', 100);
  cg.resetCache();
  u = await cg.unreadFor('owner', 2_000);
  ok(u?.unread === 1, 'after seeing the first: one');
  cg.markSeen('owner', 50);
  ok(cg.seenOf('owner') === 100, 'the cursor never moves backwards');
  cg.setSettings({ enabled: false });
  ok((await cg.unreadFor('owner')) === null, 'off: no concierge field at all');
  cg.setSettings({ enabled: true });
}

/* ---- route doors, with fake req/res ---- */
function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': 'application/json' };
  return r;
}
function res(): any {
  const out: any = { status: 0, body: null };
  out.writeHead = (s: number) => ((out.status = s), out);
  out.setHeader = () => {};
  out.end = (b?: string) => {
    try {
      out.body = b ? JSON.parse(b) : null;
    } catch {
      out.body = b;
    }
  };
  return out;
}
const deps = (o: Partial<Parameters<typeof routes.handle>[3]> = {}) => ({
  human: true,
  log: () => {},
  paneTokensOn: true,
  recipe: (id: string) => (recipes.has(id) ? { id, name: id.toUpperCase(), vendor: id === 'rec-cx' ? 'codex-cli' : 'claude-code' } : undefined),
  isLive: (p: string) => p === 'recipe:rec-cg',
  userKey: 'owner',
  ...o,
});
async function call(method: string, url: string, body?: unknown, o: Partial<Parameters<typeof routes.handle>[3]> = {}) {
  const r = res();
  const handled = await routes.handle(req(method, url, body), r, url.split('?')[0], deps(o));
  return { handled, status: r.status, body: r.body };
}

section('the person\'s door');
{
  let r = await call('GET', '/api/concierge');
  ok(r.status === 200 && r.body.pane === 'recipe:rec-cg' && r.body.live === true && r.body.active?.vendor === 'claude-code', 'status: the active recipe, its pane, live');
  ok(r.body.prerequisite?.paneTokens === true && !r.body.prerequisite.message, 'pane tokens on: no prerequisite note');
  r = await call('GET', '/api/concierge', undefined, { paneTokensOn: false });
  ok(r.body.prerequisite?.paneTokens === false && /pane tokens/.test(r.body.prerequisite.message), 'pane tokens off: status SAYS the prerequisite is disabled');
  r = await call('PATCH', '/api/concierge', { enabled: false }, { human: false });
  ok(r.status === 403, 'a bearer cannot change Concierge settings');
  r = await call('PATCH', '/api/concierge', { allowed: { inject: 'x' } });
  ok(r.status === 400 && r.body.field === 'allowed.inject', 'a bad PATCH: 400 naming the field');
  r = await call('PATCH', '/api/concierge', { allowed: { message: true } });
  ok(r.status === 200 && r.body.settings.allowed.message === true && r.body.settings.allowed.inject === false, 'a person changes one switch; the rest stay off');
  for (const scope of ['/api/concierge/sessions', '/api/concierge/rooms', '/api/concierge/recipes/rec-cg/sessions']) {
    r = await call('GET', scope);
    ok(r.status === 403 && r.body.error === 'concierge_scope', `${scope} on the person/bearer door: 403, never the shared bearer`);
  }
  r = await call('POST', '/api/concierge/seen', { ts: 300 }, { human: false });
  ok(r.status === 403, 'only the person marks it read');
  r = await call('POST', '/api/concierge/seen', { ts: 300 });
  ok(r.status === 200 && cg.seenOf('owner') === 300, 'the person marks it read');
  r = await call('GET', '/api/rooms');
  ok(r.handled === false, 'other routes are not touched');
  process.env.HARBOR_WB_EDITION = 'basic';
  r = await call('GET', '/api/concierge');
  ok(r.status === 404, 'Basic: no Concierge (404)');
  delete process.env.HARBOR_WB_EDITION;
}

section('the pane-token door: THE pane only, reads only');
{
  const sd = {
    sessions: async () => [{ paneid: 'recipe:rec-cg' }],
    rooms: async () => [{ id: 'R1' }],
    recipeSessions: async (id: string) => (id === 'rec-cg' ? [{ id: 's1' }] : null),
    log: () => {},
  };
  const scope = async (method: string, url: string, paneid: string) => {
    const r = res();
    const handled = await routes.handleScope(req(method, url), r, url, paneid, sd);
    return { handled, status: r.status, body: r.body };
  };
  let r = await scope('GET', '/api/concierge/rooms', 'recipe:rec-cg');
  ok(r.status === 200 && r.body.rooms[0].id === 'R1', 'the concierge pane reads the rooms');
  r = await scope('GET', '/api/concierge/sessions', 'recipe:rec-cg');
  ok(r.status === 200 && r.body.sessions.length === 1, 'and the sessions');
  r = await scope('GET', '/api/concierge/recipes/rec-cg/sessions', 'recipe:rec-cg');
  ok(r.status === 200 && r.body.sessions[0].id === 's1', 'and a project\'s session listing');
  r = await scope('GET', '/api/concierge/recipes/ghost/sessions', 'recipe:rec-cg');
  ok(r.status === 404, 'an unknown recipe: 404');
  r = await scope('GET', '/api/concierge/rooms', 'recipe:rec-cg#9f8e7d6c');
  ok(r.status === 403 && r.body.error === 'not_concierge', 'a fresh pane of the same recipe: 403');
  r = await scope('GET', '/api/concierge/rooms', 'recipe:rec-other');
  ok(r.status === 403, 'another pane: 403');
  r = await scope('POST', '/api/concierge/rooms', 'recipe:rec-cg');
  ok(r.status === 403, 'the scope only reads');
  r = await scope('GET', '/api/rooms', 'recipe:rec-cg');
  ok(r.handled === false, 'other pane-token routes are left to their own door');
  cg.setSettings({ enabled: false });
  r = await scope('GET', '/api/concierge/rooms', 'recipe:rec-cg');
  ok(r.status === 403, 'the off switch revokes the scope on the very next request');
  cg.setSettings({ enabled: true });
}

section('voice: the frame carries it through the transcript');
{
  ok(typer.frameChat('hi there') === '[chat ' + String.fromCharCode(0xb7) + ' @user] hi there', 'a typed line is unchanged');
  const spoken = typer.frameChat('what is running?', 'voice');
  ok(spoken === '[chat ' + String.fromCharCode(0xb7) + ' @user ' + String.fromCharCode(0xb7) + ' voice] what is running?', 'a spoken line carries "voice" in its frame');
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: spoken }, timestamp: '2026-10-11T00:00:00Z', uuid: 'u1' });
  const item = chat.parseClaudeLine(line, 0)[0];
  ok(item?.text === 'what is running?' && item.meta?.via === 'voice', 'the reader strips the frame and sets meta.via = voice');
  const plain = chat.parseClaudeLine(JSON.stringify({ type: 'user', message: { role: 'user', content: typer.frameChat('typed') }, timestamp: '2026-10-11T00:00:00Z', uuid: 'u2' }), 0)[0];
  ok(plain?.text === 'typed' && !plain.meta, 'a typed line has no meta');
  chat.recordHookTurn('p-codex', 'user', spoken);
  const page = chat.pageCodex('p-codex', { limit: 10 });
  ok(page.items[0]?.text === 'what is running?' && page.items[0].meta?.via === 'voice', 'a Codex hook turn keeps the voice flag too');
  const sent: Array<[string, string, unknown]> = [];
  const sdeps: any = {
    row: () => ({ paneid: 'p1', vendor: 'claude-code', recipe_id: null, agent: 'x' }),
    isLive: () => true,
    typer: { enqueueChat: (p: string, t: string, via?: unknown) => (sent.push([p, t, via]), 'injected') },
    log: () => {},
  };
  await chat.chatSend('p1', { text: 'hello', via: 'voice' }, sdeps);
  await chat.chatSend('p1', { text: 'typed' }, sdeps);
  ok(sent[0][2] === 'voice' && sent[1][2] === undefined, 'chatSend passes via voice to the typer, and nothing for a typed line');
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* the store may still hold the db */
}
void table;
console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
