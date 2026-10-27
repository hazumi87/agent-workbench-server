/**
 * REPLY TO A LINE (the design system room-reply-v1) + THE SEAT BADGE'S MEANING
 * (Owner 2026-09-28), engine half.
 *
 *   - excerptOf: list numbers kept, items joined " · ", whitespace collapsed,
 *     160 chars; the page's copy (web/room-quote.mjs) gives the same output;
 *   - reply_to on POST .../line: an entry of THIS room, else 400 reply_to (the
 *     window, the bearer + from, the pane-token door, and the attachment send);
 *     meta.reply = the quote captured at send time;
 *   - routing: an un-addressed reply to a seat's line goes to that seat (not
 *     the lead); an explicit @address wins; a reply to your own line or a fact
 *     follows normal routing (the lead);
 *   - the delivery prefix, ONE function, on BOTH paths: the typed copy (a fake
 *     resident's pty writes) and the fabric channel copy (a stub fabric's
 *     /send), for a seat's line and for a fact;
 *   - the draft carries the reply target (GET/PUT .../draft) and a send clears it;
 *   - the seat badge: `waiting` counts queued/held + injected-awaiting-turn,
 *     and NOT a line handed to the pane's fabric channel (whose per-line read
 *     state stays not-yet).
 *
 * SAFETY: a temp table set BEFORE any import; the fabric is a stub on
 * P(180); nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { P, assertFree } from './_scratch.mjs';

const FABRIC_PORT = P(180);
await assertFree(FABRIC_PORT, 'room-reply.test.ts');

const dir = mkdtempSync(join(tmpdir(), 'wb-room-reply-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = `http://127.0.0.1:${FABRIC_PORT}`;
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '1';
process.env.HARBOR_WB_CHANNELS = '1'; // room lines from agents ride a live channel
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '0';
process.env.HARBOR_WB_VOICE_ENTER_MS = '5';
process.env.HARBOR_WB_NODE = 'homebase';
delete process.env.HARBOR_WB_ROOM_TYPE;

/* ---- the stub fabric: presence says which pane holds a channel; /send is recorded ---- */
const sends: Array<Record<string, any>> = [];
let channelPane = '';
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
      return json(200, { channel: url.searchParams.get('paneid') === channelPane });
    }
    if (url.pathname === '/threads' && req.method === 'POST') {
      return json(200, { thread: 't-reply' });
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
const reply = await import('../src/engine/room-reply.ts');
const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const channels = await import('../src/engine/channels.ts');
const quote = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room-quote.mjs')).href);

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
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
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

const DOT = String.fromCharCode(0xb7);
const ARROW = String.fromCharCode(0x21a9);
const ELL = String.fromCharCode(0x2026);

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
/** A route call; `human` = a window credential (the user posts with no from). */
async function call(method: string, url: string, body?: unknown, human = false): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handle(req(method, url, body), resp(out), url.split('?')[0], null, deps(human));
  return out;
}
/** The pane-token door, as that pane. */
async function asPane(paneid: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  await rooms.handleAgent(req(method, url, body), resp(out), url.split('?')[0], paneid, deps(false));
  return out;
}
const meta = (e: any) => (typeof e?.meta === 'string' ? JSON.parse(e.meta) : e?.meta);

try {
  console.log('\n[excerptOf: list numbers kept, one line, 160 chars]');
  const LIST = 'And for the rail itself:\n1. 272 fixed\n2. resizable\n3. collapsible';
  const WANT = `And for the rail itself: 1. 272 fixed ${DOT} 2. resizable ${DOT} 3. collapsible`;
  eq(reply.excerptOf(LIST), WANT, 'numbered "1." items keep their numbers, joined with " · "');
  eq(reply.excerptOf('Pick one:\n1) tabs\n2) a rail'), `Pick one: 1) tabs ${DOT} 2) a rail`, '"2)" numbers too');
  eq(reply.excerptOf('  lots   of\n\n   space\there '), 'lots of space here', 'whitespace collapses; blank lines drop');
  eq(reply.excerptOf('Options:\n- one\n- two'), `Options: one ${DOT} two`, 'plain bullets lose the dash, keep the join');
  const long = reply.excerptOf('x'.repeat(400));
  eq(long.length, 160, 'capped at 160 characters');
  eq(long.endsWith(ELL), true, '...ending in an ellipsis when cut');
  for (const t of [LIST, 'Pick one:\n1) tabs\n2) a rail', 'x'.repeat(400), '## Head\n> quoted\n* star', '']) {
    eq(quote.excerptOf(t), reply.excerptOf(t), `the page's copy agrees: ${JSON.stringify(t.slice(0, 24))}`);
  }

  console.log('\n[replyRef: voice, files, the room]');
  const names = { userHandle: 'owner', seatHandle: (id: string) => (id === 'S1' ? 'auriga' : null) };
  const base = { room_id: 'r', ts: 0, target: null, target_seat: null, thread: null, ref: null };
  const v = reply.replyRef({ ...base, id: 5, kind: 'voice', author: 'auriga', author_seat: 'S1', body: 'I can build either', meta: null } as never, names);
  eq(`${v.voice}|${v.handle}|${v.excerpt}`, 'true|auriga|I can build either', 'a voice original: voice flag + its transcript');
  const f = reply.replyRef({
    ...base, id: 6, kind: 'attachment', author: 'user', author_seat: null, body: null,
    meta: JSON.stringify({ attachments: [{ name: 'a.pdf', type: 'application/pdf' }, { name: 'shot.png', type: 'image/png' }] }),
  } as never, names);
  eq(`${f.user}|${f.handle}|${f.thumb}|${f.excerpt}`, 'true|owner|shot.png|2 files: a.pdf, shot.png', 'files only: the names, and the first image as the thumb (a name, never a URL)');
  const fa = reply.replyRef({ ...base, id: 7, kind: 'fact', author: 'room', author_seat: null, body: 'x joined', meta: null } as never, names);
  eq(`${fa.handle}|${fa.seat}`, 'null|null', 'a fact: no author');
  eq(JSON.stringify(quote.quoteOf({ ...base, id: 6, kind: 'attachment', author: 'user', author_seat: null, body: null,
    meta: JSON.stringify({ attachments: [{ name: 'a.pdf', type: 'application/pdf' }, { name: 'shot.png', type: 'image/png' }] }) }, names)),
  JSON.stringify(f), "the page's quoteOf builds the same quote");

  /* ---- a room: @the design system (the lead), @buddy, @chan (its pane holds a fabric channel) ---- */
  const writes: Record<string, string[]> = {};
  for (const [id, agent] of [['rec-a', 'auriga'], ['rec-b', 'buddy'], ['rec-c', 'chan']]) {
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
  const C = 'recipe:rec-c';
  channelPane = C;
  for (const p of [A, B, C]) {
    await channels.channelLive(p); // prime the presence cache the typing decision reads
  }
  const R = table.createRoom({ name: 'Reply room' }, { actor: 'user' }).result;
  const sa = table.addSeat(R.id, { recipe_id: 'rec-a', occupant: A }, { actor: 'user' }).result;
  const sb = table.addSeat(R.id, { recipe_id: 'rec-b', occupant: B }, { actor: 'user' }).result;
  const sc = table.addSeat(R.id, { recipe_id: 'rec-c', occupant: C }, { actor: 'user' }).result;
  if (!table.getRoom(R.id)?.lead_seat) {
    table.updateRoom(R.id, { lead_seat: sa.id }, { actor: 'user' });
  }
  eq(table.getRoom(R.id)?.lead_seat, sa.id, 'setup: @auriga leads');
  const Other = table.createRoom({ name: 'Elsewhere' }, { actor: 'user' }).result;
  const otherFact = table.appendLine(Other.id, { kind: 'fact', body: 'another room' }, { actor: 'user' }).entries[0];
  const LINE = `/api/rooms/${R.id}/line`;

  console.log('\n[the original: @buddy posts a numbered list]');
  const orig = await call('POST', LINE, { text: LIST, from: { paneid: B } });
  eq(orig.status, 200, 'posted');
  const O = orig.body.entries[0];
  await until(() => writes[A].length, (n) => n >= 2); // typed into the lead's pane
  activity.onTurnStart(A);
  activity.onResponseDone(A); // the lead's turn ends: idle again
  writes[A].length = 0;
  sends.length = 0;

  console.log('\n[reply_to validation]');
  const bad = await call('POST', LINE, { text: 'x', reply_to: 'abc' }, true);
  eq(`${bad.status}/${bad.body?.field}`, '400/reply_to', 'a non-integer reply_to is 400 reply_to');
  const nope = await call('POST', LINE, { text: 'x', reply_to: 999999 }, true);
  eq(`${nope.status}/${nope.body?.field}`, '400/reply_to', 'an id that is no entry is 400 reply_to');
  const cross = await call('POST', LINE, { text: 'x', reply_to: otherFact.id }, true);
  eq(`${cross.status}/${cross.body?.field}`, '400/reply_to', "another room's entry is 400 reply_to");
  const crossAtt = await call('POST', LINE, { text: 'x', attachments: ['nope'], reply_to: otherFact.id }, true);
  eq(`${crossAtt.status}/${crossAtt.body?.field}`, '400/reply_to', '...on the attachment send too, before any file moves');
  const toolR = await call('POST', LINE, { text: 'done', from: { paneid: B }, tool: { slug: 'image-studio', for: 'user' }, reply_to: O.id });
  eq(`${toolR.status}/${toolR.body?.field}`, '400/reply_to', 'a tool line refuses reply_to');
  eq(table.listLine(R.id).filter((e) => e.body === 'x').length, 0, 'nothing refused was written');

  console.log('\n[the user replies to @buddy\'s line, un-addressed]');
  const r1 = await call('POST', LINE, { text: 'go with 2)', reply_to: O.id }, true);
  eq(r1.status, 200, '200');
  const E1 = r1.body.entries[0];
  const q1 = meta(E1)?.reply;
  eq(q1?.id, O.id, 'meta.reply.id is the original');
  eq(q1?.handle, 'buddy', 'meta.reply.handle @buddy');
  eq(q1?.seat, sb.id, "meta.reply.seat is the author's seat");
  eq(q1?.excerpt, WANT, 'meta.reply.excerpt captured with the list numbers');
  eq(E1.target_seat, sb.id, 'ROUTING: an un-addressed reply to a seat goes to THAT seat, not the lead');
  eq(E1.target, 'buddy', '...and says so (target @buddy)');
  eq(r1.body.deliveries.map((d: any) => d.handle).join(','), 'buddy', '...delivered to @buddy only');
  const PREFIX1 = `${ARROW} re #${O.id} @buddy`;
  eq(reply.replyPrefix(q1), PREFIX1, 'the prefix: ↩ re #id @author (the line number is the reference; no excerpt is sent to agents)');
  ok(!reply.replyPrefix(q1).includes(WANT) && q1.excerpt === WANT, '...the excerpt stays in meta.reply for the page, and is not in the prefix');
  await until(() => writes[B].length, (n) => n >= 1);
  eq(writes[B][0], `[room Reply room ${DOT} @user ${DOT} #9] ${PREFIX1} go with 2) (reply in the room: room_post reply_to 9; if you act on this through someone else, tell @user in a line of your own)`, 'TYPED path: the prefix leads the typed line (its newline flattened)');
  const s1 = await until(() => sends.find((s) => s.ref === `room:${R.id}/line:${E1.id}`), (v) => !!v);
  eq(s1?.body, `${PREFIX1}\ngo with 2)`, 'CHANNEL path: the fabric copy starts with the prefix on its own first line');
  eq(s1?.kind, 'ask', '...and @buddy gets it as an ask (the reply addressed it)');
  activity.onTurnStart(B);
  activity.onResponseDone(B);
  writes[B].length = 0;

  console.log('\n[an explicit @address wins]');
  const r2 = await call('POST', LINE, { text: '@auriga see what buddy said', reply_to: O.id }, true);
  const E2 = r2.body.entries[0];
  eq(E2.target_seat, sa.id, 'a leading @auriga routes to @auriga');
  eq(r2.body.deliveries.map((d: any) => d.handle).join(','), 'auriga', '...and the author is NOT added');
  eq(meta(E2)?.reply?.id, O.id, '...still a reply (meta.reply)');
  activity.onTurnStart(A);
  activity.onResponseDone(A);

  console.log('\n[a reply to your own line, and to a fact: normal routing (the lead)]');
  const r3 = await call('POST', LINE, { text: 'and one more thing', reply_to: E1.id }, true);
  const E3 = r3.body.entries[0];
  eq(E3.target_seat, sa.id, 'a reply to your own line goes to the lead');
  eq(meta(E3)?.reply?.user, true, '...the quote knows it was yours');
  activity.onTurnStart(A);
  activity.onResponseDone(A);
  const fact = table.appendLine(R.id, { kind: 'fact', body: 'Lock released: live (web only, no restart).' }, { actor: 'user' }).entries[0];
  writes[A].length = 0;
  sends.length = 0;
  const r4 = await call('POST', LINE, { text: 'good', reply_to: fact.id }, true);
  const E4 = r4.body.entries[0];
  eq(E4.target_seat, sa.id, 'a reply to a fact goes to the lead');
  eq(meta(E4)?.reply?.handle, null, "...the fact's quote has no author");
  const PREFIX4 = `${ARROW} re #${fact.id} fact`;
  await until(() => writes[A].length, (n) => n >= 1);
  eq(writes[A][0], `[room Reply room ${DOT} @user ${DOT} #13] ${PREFIX4} good${typer.USER_REPLY_HINT.replace('room_post', 'room_post reply_to 13')}`, 'TYPED path: the fact prefix (lead rules are off by default [agent comms])');
  const s4 = await until(() => sends.find((s) => s.ref === `room:${R.id}/line:${E4.id}`), (v) => !!v);
  eq(s4?.body, `${PREFIX4}\ngood`, 'CHANNEL path: the fact prefix');
  activity.onTurnStart(A);
  activity.onResponseDone(A);

  console.log('\n[agents reply too: the bearer + from, and the pane-token door]');
  const r5 = await call('POST', LINE, { text: 'the list matches what I built', from: { paneid: A }, reply_to: O.id });
  eq(r5.status, 200, 'bearer + from: 200');
  eq(meta(r5.body.entries[0])?.reply?.id, O.id, '...meta.reply');
  eq(r5.body.entries[0].target_seat, sb.id, '...an agent\'s un-addressed reply goes to the author seat too');
  const r6 = await asPane(C, 'POST', LINE, { text: 'me too', reply_to: O.id });
  eq(r6.status, 200, 'pane-token door: 200');
  eq(meta(r6.body?.entries?.[0])?.reply?.excerpt, WANT, '...meta.reply');
  const r7 = await asPane(C, 'POST', LINE, { text: 'x', reply_to: otherFact.id });
  eq(r7.status, 400, "pane-token door: another room's entry is 400");
  const r8 = await call('POST', LINE, { text: 'self', from: { paneid: B }, reply_to: O.id });
  eq(r8.body.entries[0].target_seat, sa.id, 'an agent replying to its OWN line follows normal routing (the lead)');
  for (const p of [A, B]) {
    activity.onTurnStart(p);
    activity.onResponseDone(p);
  }

  console.log('\n[the draft carries the reply target]');
  const D = `/api/rooms/${R.id}/draft`;
  const d0 = await call('PUT', D, { text: 'half', reply_to: O.id }, true);
  eq(`${d0.status}/${d0.body?.reply_to}`, `200/${O.id}`, 'PUT {text, reply_to}');
  const d1 = await call('GET', D, undefined, true);
  eq(d1.body?.reply?.excerpt, WANT, 'GET answers the quote (so the chip survives a refresh)');
  const d2 = await call('PUT', D, { text: 'half a thought' }, true);
  eq(d2.body?.reply_to, O.id, 'a PUT without reply_to keeps it');
  const d3 = await call('PUT', D, { text: 'x', reply_to: otherFact.id }, true);
  eq(`${d3.status}/${d3.body?.field}`, '400/reply_to', "another room's entry is 400");
  eq((await call('GET', D, undefined, true)).body?.text, 'half a thought', '...and nothing changed');
  await call('POST', LINE, { text: 'sent it', reply_to: O.id }, true);
  const d4 = await call('GET', D, undefined, true);
  eq(`${d4.body?.text}|${d4.body?.reply_to}`, '|null', 'a send clears the text AND the reply target');
  await call('PUT', D, { text: '', reply_to: O.id }, true);
  const d5 = await call('PUT', D, { text: '', reply_to: null }, true);
  eq(d5.body?.reply, null, 'reply_to null clears it');
  activity.onTurnStart(B);
  activity.onResponseDone(B);

  console.log('\n[the seat badge counts only lines REALLY waiting]');
  const seatOf = async (id: string) => (await call('GET', `/api/rooms/${R.id}`)).body.seats.find((s: any) => s.id === id);
  const readsOf = async (id: number) => (await call('GET', `${LINE}?since=${id - 1}&limit=1`)).body.entries[0]?.reads ?? {};
  await until(() => typer.heldFor(A), (h) => h === null); // the design system queue empty
  await channels.channelLive(C); // the presence cache lives 5 s: fresh for this decision
  const c1 = await call('POST', LINE, { text: '@chan over the channel', from: { paneid: B } });
  eq(c1.body.deliveries[0]?.typed, 'channel', "an agent's line to @chan rides its fabric channel");
  eq((await readsOf(c1.body.entries[0].id)).chan, 'not-yet', "...the per-line marker still says not yet (no evidence)");
  eq((await seatOf(sc.id)).waiting?.count, 0, '...but @chan\'s badge does NOT count it');
  const i1 = await call('POST', LINE, { text: '@auriga first', from: { paneid: B } });
  eq(i1.body.deliveries[0]?.typed, 'injected', 'a line to idle @auriga is typed in at once');
  const i2 = await call('POST', LINE, { text: '@auriga second', from: { paneid: B } });
  eq(i2.body.deliveries[0]?.typed, 'queued', 'the next is held (awaiting the idle)');
  const w = (await seatOf(sa.id)).waiting;
  eq(w?.count, 2, "@auriga's badge: 2 (one typed in awaiting its turn, one held)");
  eq(JSON.stringify(w?.ids), JSON.stringify([i1.body.entries[0].id, i2.body.entries[0].id]), '...ids, oldest first');
  activity.onTurnStart(A); // the typed line started a turn: seen
  await sleep(20);
  const w2 = (await seatOf(sa.id)).waiting;
  eq(w2?.count, 1, 'the turn starts: the typed line is seen, the held one still waits');
  activity.onResponseDone(A); // idle: the held one is typed in
  await sleep(40);
  eq((await seatOf(sa.id)).waiting?.count, 1, '...typed in, it still waits for its own turn');
  activity.onTurnStart(A);
  await sleep(20);
  eq((await seatOf(sa.id)).waiting?.count, 0, '...and once that turn starts, nothing waits');
  eq((await seatOf(sc.id)).waiting?.count, 0, "@chan's badge is still 0");

  console.log('\n[pushes: room.held + room.waiting move the moment the queue does (a draft held, then cleared)]');
  const bus = await import('../src/engine/room-bus.ts');
  const evs: any[] = [];
  bus.on(R.id, (_r, ev) => {
    if (ev.type === 'room.held' || ev.type === 'room.waiting') evs.push(ev);
  });
  activity.onResponseDone(A); // idle, nothing held
  await sleep(40);
  evs.length = 0;
  activity.onInput(A, 'half a tho'); // a draft in @the design system composer
  const h1 = await call('POST', LINE, { text: '@auriga while you type', from: { paneid: B } });
  eq(h1.body.deliveries[0]?.typed, 'queued', 'a line to a pane with a draft is held');
  const heldEv = evs.find((e) => e.type === 'room.held' && e.seatId === sa.id);
  eq(`${heldEv?.held?.reason}/${heldEv?.held?.depth}`, 'draft/1', 'room.held pushed at once: {reason draft, depth 1} for @auriga\'s seat');
  const waitEv = evs.filter((e) => e.type === 'room.waiting' && e.seatId === sa.id).pop();
  eq(waitEv?.waiting?.count, 1, 'room.waiting pushed at once: @auriga\'s badge 1');
  evs.length = 0;
  activity.onInput(A, 'ught' + String.fromCharCode(13)); // he submits: the draft is clean
  activity.onTurnStart(A);
  activity.onResponseDone(A); // idle: the held line types in
  const cleared = await until(() => evs.find((e) => e.type === 'room.held' && e.seatId === sa.id && e.held === null), (v) => !!v, 2000);
  ok(!!cleared, 'room.held {held: null} pushed when the held line is typed in');
  ok(writes[A].some((w) => /@auriga while you type \(To mention a seat without pinging it, put its handle in backticks\.\) \(reply in the room: room_post reply_to \d+\)$/.test(w)), '...(it was typed into the pane)');
  activity.onTurnStart(A); // its turn starts: seen
  const w0 = await until(() => evs.filter((e) => e.type === 'room.waiting' && e.seatId === sa.id).pop(), (v) => v?.waiting?.count === 0, 2000);
  eq(w0?.waiting?.count, 0, 'room.waiting {count 0} pushed when its turn starts');
  activity.onResponseDone(A);
  evs.length = 0;
  const c2 = await call('POST', LINE, { text: '@chan more channel', from: { paneid: B } });
  eq(c2.body.deliveries[0]?.typed, 'channel', 'a channel line...');
  eq(evs.filter((e) => e.type === 'room.waiting' && e.seatId === sc.id).length, 0, '...pushes no room.waiting (it never joins the badge set)');
} catch (e) {
  ok(false, `threw: ${(e as Error).stack ?? e}`);
} finally {
  http.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM), same as room-typer/room-batch */ }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
