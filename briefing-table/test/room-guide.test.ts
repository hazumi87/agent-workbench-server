/**
 * ROOM GUIDE [room guide] (Owner 2026-10-07, room interface): server/room-guide.ts.
 *   - assembled at read time: name, lead, seats, the addressing rule (follows the
 *     unaddressedToLead switch), the agent tools, each app's tool.json description and
 *     its CLAUDE.md "For OTHER agents" section; the basic edition adds the /commands;
 *   - GET /api/rooms/:id/guide (a person, and a SEATED pane token; an unseated pane: no);
 *   - written to guides/<roomId>.md beside the table, refreshed on change;
 *   - the welcome and the reload appendix carry "Read this room's guide first: <path>";
 *   - an app added / removed or the lead handed over: ONE notice to each live agent seat.
 * SAFETY: a temp table set BEFORE any import; nothing spawns. Run with tsx.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-guide-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_SEAT_WELCOME = '0';
delete process.env.HARBOR_WB_EDITION;

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const guide = await import('../src/server/room-guide.ts');
const seatWelcome = await import('../src/engine/seat-welcome.ts');

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
const NL = String.fromCharCode(10);

function req(method: string, url: string): any {
  const r = Readable.from([]) as any;
  r.method = method;
  r.url = url;
  r.headers = {};
  return r;
}
async function get(url: string, pane?: string): Promise<{ status: number; text: string; type?: string }> {
  const out = { status: 0, text: '', type: undefined as string | undefined };
  const res = {
    writeHead(s: number, h?: any) {
      out.status = s;
      out.type = h?.['content-type'];
    },
    setHeader() {},
    end(x?: unknown) {
      out.text = String(x ?? '');
    },
  };
  const deps = { projector: async () => (x: any) => x, log: () => {}, human: !pane } as any;
  if (pane) {
    const handled = await rooms.handleAgent(req('GET', url), res as any, url, pane, deps);
    if (!handled) out.status = -1;
  } else {
    await rooms.handle(req('GET', url), res as any, url, null, deps);
  }
  return out;
}

try {
  /* an app with a description and a CLAUDE.md that has a "For OTHER agents" section */
  const appRoot = join(dir, 'tools', 'room-tasks');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(
    join(appRoot, 'CLAUDE.md'),
    ['# room-tasks', '', '## Build', 'internal notes', '', '## For OTHER agents — calling the app directly', '', 'POST /tasks {title} adds a task.', '', '## Later', 'not this'].join(NL),
  );
  const toolJson = { contract: 'tool/draft-0', slug: 'room-tasks', name: 'Room tasks', description: "A room's tasks as a panel." };
  table.registerTool({ slug: 'room-tasks', root: appRoot, name: 'Room tasks', contract: 'tool/draft-0', tool_sha256: 'x', registered_by: 'user', root_realpath: appRoot, tool_json: JSON.stringify(toolJson) });
  for (const a of ['boss', 'worker']) {
    table.upsertRecipe({
      id: `rec-${a}`, name: a, target: 'local', projectDir: `/x/${a}`, vendor: 'claude-code', agent: a, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
    table.upsert({ paneid: `recipe:rec-${a}`, recipe_id: `rec-${a}`, server: 'local', vendor: 'claude-code', agent: a, session_id: null, state: 'live', generation: 1 } as never);
  }
  const R = table.createRoom({ name: 'Asset Studio', alias: 'studio' }, { actor: 'user' }).result;
  const boss = table.addSeat(R.id, { recipe_id: 'rec-boss', occupant: 'recipe:rec-boss' }, { actor: 'user' }).result;
  const worker = table.addSeat(R.id, { recipe_id: 'rec-worker', occupant: 'recipe:rec-worker' }, { actor: 'user' }).result;
  if (table.getRoom(R.id)?.lead_seat !== boss.id) table.updateRoom(R.id, { lead_seat: boss.id }, { actor: 'user' });
  const notices: Array<{ paneid: string; text: string }> = [];
  guide.setNotify((paneid, text) => notices.push({ paneid, text }));
  guide.refreshRoom(R.id); // the baseline: no notice

  console.log('\n[the guide text]');
  let g = guide.guideText(R);
  ok(g.startsWith('# Room guide: Asset Studio'), 'titled with the room');
  ok(g.includes('Lead: @boss.') && g.includes('Seats: @boss, @worker.'), 'lead and seats');
  ok(g.includes('/seat restart @handle') && g.includes('`/help` lists every room command'), 'the guide tells the lead how to restart a seat that is not live');
  ok(g.includes('reaches ONLY the seats it @-names') && g.includes('A line that names nobody goes to the lead.'), 'the addressing rule, with the switch on');
  ok(g.includes('`room_read`') && g.includes('`for=me`') && g.includes('digest') && g.includes('[note: <id>]'), 'the agent tools and references');
  {
    const prevH = process.env.HARBOR_WB_HOSTED;
    process.env.HARBOR_WB_HOSTED = '1';
    const gh = guide.guideText(R);
    ok(!gh.includes('fabric_ack') && gh.includes('There is no acknowledge tool here'), 'HOSTED (no fabric): the guide names no tool the seat does not have (no fabric_ack)');
    if (prevH === undefined) delete process.env.HARBOR_WB_HOSTED; else process.env.HARBOR_WB_HOSTED = prevH;
    const prevF = process.env.HARBOR_WB_ROOM_FABRIC;
    process.env.HARBOR_WB_ROOM_FABRIC = '0';
    ok(!guide.guideText(R).includes('fabric_ack'), 'HARBOR_WB_ROOM_FABRIC=0: the same');
    process.env.HARBOR_WB_ROOM_FABRIC = '1';
    ok(guide.guideText(R).includes('`fabric_ack`'), 'with a fabric: the guide still names fabric_ack');
    if (prevF === undefined) delete process.env.HARBOR_WB_ROOM_FABRIC; else process.env.HARBOR_WB_ROOM_FABRIC = prevF;
  }
  ok(g.includes('## Apps in this room' + NL + NL + 'None.'), 'no apps yet');
  ok(!g.includes('## Typed commands'), 'no typed commands outside the basic edition');
  table.setEngineSetting('agentComms', { unaddressedToLead: false });
  ok(guide.guideText(R).includes('reaches no agent'), 'the switch off changes the rule');
  table.setEngineSetting('agentComms', null);
  eq(guide.forOtherAgents(readFileSync(join(appRoot, 'CLAUDE.md'), 'utf8')), 'POST /tasks {title} adds a task.', 'forOtherAgents: that section only');

  console.log('\n[@lead: in a workgroup it is the MAIN room\'s lead] Client [ref] and [ref]; night list item 4');
  ok(g.includes('`@room` reaches everyone in this room; `@lead` reaches the lead; `@user` (or the person\'s @name) reaches the person.'), 'a main room keeps the plain sentence, byte for byte');
  const WG = table.createRoom({ name: 'Studio Dev', parent_id: R.id, alias: 'studio-dev' }, { actor: 'user' }).result;
  const wg = guide.guideText(WG);
  ok(wg.includes('`@lead` reaches the lead of the MAIN room "Asset Studio", not this group\'s own lead (`@studio-dev` reaches that one)'), 'a workgroup says @lead is the MAIN room\'s lead and names its own alias');
  ok(!wg.includes('`@lead` reaches the lead;'), '...instead of the plain sentence');
  ok(wg.includes('`@room` reaches everyone in this room;') && wg.includes('`@user` (or the person\'s @name) reaches the person.'), '...with @room and @user unchanged');
  ok(!wg.includes('@boss') && !wg.includes('@worker'), 'it names no handle from the main room (the guide file is rewritten on THIS room\'s changes only, so one would go stale)');
  ok(guide.leadRule(null, 'Asset Studio').includes('its handle reaches that one'), 'a group with no alias says "its handle"');

  console.log('\n[an app added: its own words in the guide; one notice per live agent]');
  table.addRoomApp(R.id, 'room-tasks', [], { actor: 'user' });
  guide.refreshRoom(R.id);
  g = readFileSync(guide.guidePath(R.id), 'utf8');
  ok(g.includes("### Room tasks (`room-tasks`)") && g.includes("A room's tasks as a panel.") && g.includes('POST /tasks {title} adds a task.') && !g.includes('internal notes'), 'the file has the app: description + its For OTHER agents section, nothing else');
  eq(notices.map((n) => n.paneid).sort(), ['recipe:rec-boss', 'recipe:rec-worker'], 'one notice to each live agent seat');
  ok(notices[0].text.includes("The room's tools changed: app room-tasks added. Guide: ") && notices[0].text.includes(guide.guidePath(R.id)), 'the notice says what and where');
  notices.length = 0;
  guide.refreshRoom(R.id);
  eq(notices.length, 0, 'no change: no notice');
  table.updateRoom(R.id, { lead_seat: worker.id }, { actor: 'user' });
  guide.refreshRoom(R.id);
  ok(notices.length === 2 && notices[0].text.includes('the lead is now @worker'), 'the lead handed over: a notice');
  notices.length = 0;
  table.removeRoomApp(R.id, 'room-tasks', { actor: 'user' });
  guide.refreshRoom(R.id);
  ok(notices.length === 2 && notices[0].text.includes('app room-tasks removed'), 'the app removed: a notice');

  console.log('\n[the route: a person, a seated pane; markdown]');
  const p = await get(`/api/rooms/${R.id}/guide`);
  eq([p.status, p.type], [200, 'text/markdown; charset=utf-8'], 'a person: markdown');
  ok(p.text.startsWith('# Room guide: Asset Studio'), '...the guide');
  const seated = await get(`/api/rooms/${R.id}/guide`, 'recipe:rec-boss');
  eq(seated.status, 200, 'a seated pane token: 200');
  const stranger = await get(`/api/rooms/${R.id}/guide`, 'recipe:nobody');
  ok(stranger.status !== 200, `an unseated pane: refused (${stranger.status})`);

  console.log('\n[welcome and reload carry the guide line]');
  const line = guide.guideLine(R.id);
  ok(line === `Read this room's guide first: ${guide.guidePath(R.id)} (or GET /api/rooms/${encodeURIComponent(R.id)}/guide).`, 'the line');
  ok(seatWelcome.welcomeText(R, table.getSeat(boss.id)!).endsWith(line), 'the welcome ends with it');
  ok(seatWelcome.welcomeAppendix(R, table.getSeat(boss.id)!).endsWith(line), 'the reload appendix ends with it');
  ok(existsSync(guide.guidePath(R.id)), 'the file exists when the welcome points at it');

  console.log('\n[basic edition: the typed commands, from the registry hook when set]');
  process.env.HARBOR_WB_EDITION = 'basic';
  ok(guide.guideText(R).includes('## Typed commands') && guide.guideText(R).includes('`/help`'), 'the room commands by default');
  guide.setCommandsSource(() => [{ usage: '/site', does: 'open your site' }]);
  ok(guide.guideText(R).includes('`/site`: open your site') && !guide.guideText(R).includes('`/help`'), 'a registered list replaces them');
  guide.setCommandsSource(null);
  delete process.env.HARBOR_WB_EDITION;
} catch (e) {
  failed++;
  console.log(`  FAIL threw: ${(e as Error).stack}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
