/**
 * Room welcome + direct-chat note (Owner 2026-10-05, [room welcome]): every agent
 * seat that gets a live pane is told once where to answer (room_post), typed
 * fact-free through the typer (never a room line); the first direct-chat
 * message to a pane carries a one-sentence note the other way. In-process, a
 * temp table, a stub typer and launcher: nothing listens, nothing spawns.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-seatwelcome-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';

const { table } = await import('../src/table/endpoint.ts');
const rooms = await import('../src/server/rooms.ts');
const welcome = await import('../src/engine/seat-welcome.ts');
const chat = await import('../src/engine/agent-chat.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  X  ${msg}`);
  }
}
const eq = (a: unknown, b: unknown, msg: string): void => ok(Object.is(a, b), `${msg} (got ${JSON.stringify(a)})`);

const typed: Array<[string, string]> = [];
welcome.setTyper((paneid, text) => {
  typed.push([paneid, text]);
  return 'queued';
});

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  return r;
}
let n = 0;
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const r = {
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
  /* the launcher binds the seat, then the pane exists live (what the real launch does) */
  const launch = async (recipeId: string, _b: Record<string, unknown>, onPane: (p: string) => void) => {
    const paneid = `pane-${recipeId}-${++n}`;
    table.upsert({ paneid, recipe_id: recipeId, server: 'local', vendor: 'claude-code', agent: recipeId, session_id: null, state: 'live', generation: 1 } as never);
    onPane(paneid);
    return { ok: true as const, paneid, url: `/p/${paneid}`, path: `/p/${paneid}`, placement: 'tab' };
  };
  await rooms.handle(req(method, url, body), r as any, url.split('?')[0], null, { projector: async () => (x: any) => x, log: () => {}, human: true, launch });
  return out;
}
function recipe(id: string, name: string, vendor = 'claude-code'): void {
  table.upsertRecipe({
    id, name, target: 'local', projectDir: `/x/${name}`, vendor, agent: name, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
  } as never);
}

try {
  recipe('lead', 'boss');
  recipe('m1', 'bee');
  recipe('tool', 'widget', 'cli-manager');
  const M = table.createRoom({ name: 'Main', alias: 'main' }, { actor: 'user' }).result;
  const boss = table.addSeat(M.id, { recipe_id: 'lead', handle: 'boss' }, { actor: 'user' }).result;
  const bee = table.addSeat(M.id, { recipe_id: 'm1', handle: 'bee' }, { actor: 'user' }).result;
  const widget = table.addSeat(M.id, { recipe_id: 'tool', handle: 'widget' }, { actor: 'user' }).result;
  const linesBefore = table.listLine(M.id).length;

  console.log('\n[a fresh start welcomes once]');
  let r = await call('POST', `/api/rooms/${M.id}/seats/${bee.id}/start`, { fresh: true, target: 'tab', surface: 'browser' });
  eq(r.status, 200, 'start answers 200');
  eq(typed.length, 1, 'one welcome typed');
  const beePane = typed[0][0];
  eq(beePane, r.body.paneid, '...into the started pane');
  const text = typed[0][1];
  ok(text.startsWith('You are @bee in "Main"; the lead is @boss. Room lines reach you here.'), 'wording: member, room name, lead named');
  ok(text.includes('room_post') && text.includes('ToolSearch "select:mcp__fabric__room_post,mcp__fabric__room_read,mcp__fabric__fabric_ack"') && text.includes('A reply only in your terminal is not seen.') && text.endsWith(`(or GET /api/rooms/${encodeURIComponent(M.id)}/guide).`), 'carries the room_post instruction and the ToolSearch line, then the room guide line [room guide]');
  ok(!text.includes('(you)'), 'a member is not told it is the lead');
  eq(welcome.welcomeSeat(table.getRoom(M.id)!, table.getSeat(bee.id)!), 'already', 'a second start/bind of the same pane does not repeat it');
  eq(typed.length, 1, '...nothing more typed');
  const bound = table.getSeat(bee.id)!;
  eq(table.get(beePane)?.state, 'live', 'the pane is live');
  eq(bound.occupant, beePane, '...and seated');
  eq(table.listLine(M.id).length >= linesBefore, true, 'room lines only grow by the room facts');
  ok(!table.listLine(M.id).some((l: any) => String(l.body ?? '').includes('room_post')), 'the welcome is NOT in the room line anyone sees');

  console.log('\n[the lead wording]');
  r = await call('POST', `/api/rooms/${M.id}/seats/${boss.id}/start`, { fresh: true, target: 'tab', surface: 'browser' });
  const leadLine = typed[1][1];
  ok(leadLine.startsWith('You are @boss in "Main"; the lead is @boss (you).'), 'the lead is told "(you)"');

  console.log('\n[a non-agent vendor gets none]');
  r = await call('POST', `/api/rooms/${M.id}/seats/${widget.id}/start`, { fresh: true, target: 'tab', surface: 'browser' }); // the stub launcher's pane is claude-code
  const wp = table.getSeat(widget.id)!.occupant as string;
  const before = typed.length;
  table.upsert({ paneid: wp, recipe_id: 'tool', server: 'local', vendor: 'cli-manager', agent: 'widget', session_id: null, state: 'live', generation: 1 } as never);
  eq(welcome.welcomeSeat(table.getRoom(M.id)!, table.getSeat(widget.id)!), 'skipped', 'a cli-manager (non-agent) resident is skipped (the pane re-labelled as a tool)');
  eq(typed.length, before, '...nothing typed');

  console.log('\n[a move re-sends with the new room name; a workgroup names its parent]');
  r = await call('POST', `/api/rooms/${M.id}/workgroups`, { name: 'Ops', alias: 'ops', move: [bee.id], lead: { move: bee.id } });
  eq(r.status, 200, 'workgroup created');
  const moved = typed.at(-1)!;
  eq(moved[0], beePane, 'the moved seat is welcomed again');
  ok(moved[1].startsWith('You are @bee in "Ops", a workgroup of "Main"; the lead is @bee (you).'), 'new room name, parent named, now the lead');
  const wg = r.body.room;

  console.log('\n[a new agent started by workgroup create]');
  recipe('n1', 'newone');
  const count = typed.length;
  r = await call('POST', `/api/rooms/${M.id}/workgroups`, { name: 'Two', alias: 'two', start: [{ recipe_id: 'n1', handle: 'newone' }], lead: { start: 'n1' } });
  eq(r.status, 200, 'created');
  eq(typed.length, count + 1, 'its start path delivers one welcome');
  ok(typed.at(-1)![1].includes('in "Two", a workgroup of "Main"'), '...naming the workgroup and its parent');

  console.log('\n[a reload gets one combined line]');
  const prev = table.getSeat(bee.id)!;
  const pv = await call('GET', `/api/rooms/${wg.id}/seats/${prev.id}/reload`);
  const rtext: string = pv.body?.welcome?.text ?? '';
  ok(rtext.includes('reloaded in a fresh session') && rtext.includes('Room lines reach you here') && rtext.includes('room_post'), 'the reload welcome carries the instruction');
  eq(rtext.split('Room lines reach you here').length - 1, 1, '...once, in one line');
  welcome.markWelcomed(table.getRoom(wg.id)!, table.getSeat(prev.id)!);
  const c2 = typed.length;
  eq(welcome.welcomeSeat(table.getRoom(wg.id)!, table.getSeat(prev.id)!), 'already', 'a seat the reload line covered is not welcomed twice');
  eq(typed.length, c2, '...nothing extra typed');

  console.log('\n[direct chat: the first message carries the note, later ones do not]');
  const sent: string[] = [];
  const deps: any = {
    row: (p: string) => (p === 'chatty' ? { paneid: p, vendor: 'codex-cli', agent: 'cx', state: 'live' } : undefined),
    isLive: () => true,
    location: () => null,
    typer: { enqueueChat: (_p: string, t: string) => (sent.push(t), 'injected'), heldFor: () => null },
    share: {},
    noteChat: { claim: (p: string) => table.claimChatNote(p), release: (p: string) => table.releaseChatNote(p) },
    log: () => {},
  };
  await chat.chatSend('chatty', { text: 'hi' }, deps);
  await chat.chatSend('chatty', { text: 'again' }, deps);
  eq(sent[0], 'hi' + chat.CHAT_NOTE, 'first message: note appended');
  ok(chat.CHAT_NOTE.includes('do not use room_post or Fabric'), '...saying not to use room_post or Fabric');
  eq(sent[1], 'again', 'second message: nothing appended');
  eq(table.claimChatNote('chatty'), false, 'remembered in the table (survives a restart)');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the store still holds the db */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
