/**
 * ROOM READ STATE IS AGENT-SIDE: a human at the pane never makes a room line
 * `seen` (the design notes §2.7) [ticket].
 *
 * The live bug (2026-09-25): two room lines to @the design system read `the design system:'seen'`
 * while their typed copies were still held behind a draft in that pane. The
 * chain: F4 sends each line's fabric copy to the seat's agent → the engine's
 * subscriber receives it → a human typing in the pane → the subscriber acked
 * EVERY envelope it had delivered there `seen` → a line GET merged that rung
 * back as read state.
 *
 * Asserted here, through the REAL subscriber against a stub fabric socket:
 *   - both an ordinary envelope and a room copy are acked `delivered`;
 *   - on human input only the ORDINARY envelope is acked `seen` (the badge is
 *     that human's); the room copy never is, and never waits on the list;
 *   - the read record for the held line stays `not-yet` through the typing;
 *     the agent's own `seen` ack on the ladder still upgrades it (fabric-ack).
 *
 * SAFETY: temp db via HARBOR_WB_TABLE before any import; the stub fabric is
 * P(81) (never :8204), assertFree'd; no engine, no broker, no pty. Run with tsx.
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { P, assertFree } from './_scratch.mjs';

const FABRIC_PORT: number = P(81); // the stub fabric — port table in test/_scratch.mjs
const dir = mkdtempSync(join(tmpdir(), 'wb-fabric-seen-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_FABRIC_URL = `http://127.0.0.1:${FABRIC_PORT}`;
process.env.HARBOR_WB_FABRIC_DEBOUNCE_MS = '20';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '50';
process.env.HARBOR_WB_VOICE_ENTER_MS = '5';
delete process.env.HARBOR_WB_CHANNELS;
delete process.env.HARBOR_WB_ROOM_TYPE;

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T, done: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  let v = fn();
  while (!done(v) && Date.now() < end) {
    await sleep(25);
    v = fn();
  }
  return v;
}

await assertFree(FABRIC_PORT, 'fabric-seen.test');

/* ---- stub fabric: WS /subscribe (ready / subscribed / message) + POST /ack ---- */
const acks: Array<{ id: string; level: string }> = [];
const subscribes: string[][] = [];
const sockets: import('ws').WebSocket[] = [];
const http = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/ack') {
      const b = JSON.parse(raw || '{}');
      acks.push({ id: b.id, level: b.level });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
});
const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/subscribe')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.push(ws);
    ws.on('message', (data) => {
      const f = JSON.parse(String(data));
      if (f.type === 'subscribe') {
        subscribes.push(f.slugs);
        ws.send(JSON.stringify({ type: 'subscribed', slugs: f.slugs }));
      }
    });
    ws.send(JSON.stringify({ type: 'ready', protocolVersion: 1, slugs: [] }));
  });
});
await new Promise<void>((r) => http.listen(FABRIC_PORT, '127.0.0.1', () => r()));
const push = (envelope: Record<string, unknown>) => {
  for (const ws of sockets) ws.send(JSON.stringify({ type: 'message', envelope }));
};

const fabric = await import('../src/engine/fabric.ts');
const sub = await import('../src/engine/fabric-subscriber.ts');
const reads = await import('../src/engine/room-reads.ts');
const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const { table } = await import('../src/table/endpoint.ts');

const PANE = 'recipe:auriga#1';
table.upsert({ paneid: PANE, recipe_id: null, server: 'local', vendor: 'claude-code', agent: 'auriga', session_id: null, state: 'live' });
const writes: string[] = [];
sessions.add(PANE, { state: 'live', pty: { write: (d: string) => writes.push(d) } } as never, null as never);
activity.onLive(PANE);
fabric.setDeliveryDeps({ livePaneFor: (slug) => (slug === 'auriga' ? PANE : null), toViewers: () => 1, log: () => {} });

console.log('\n[isRoomCopy — the ref rule, one place]');
eq(fabric.isRoomCopy({ ref: 'room:r1/line:7' }), true, 'ref room:<id>/line:<n> is a room copy');
eq(fabric.isRoomCopy({ ref: 'kb:abc' }), false, 'another ref is not');
eq(fabric.isRoomCopy({}), false, 'no ref is not');

console.log('\n[a human typing: the room copy is never acked seen]');
sub.start({ token: 'fabric-seen-token', liveSlugs: () => ['auriga'] });
await until(() => subscribes.length, (n) => n > 0);
eq(JSON.stringify(subscribes[0]), '["auriga"]', 'the subscriber subscribed the hosted slug');

// A human is mid-draft in @the design system pane: the typed copies will be HELD.
activity.onInput(PANE, 'half a thought');
reads.open('R1', 7, 'seat-auriga', 'auriga', PANE);
eq(typer.enqueue(PANE, 'R1', 7, 'Room', 'user', 'hello auriga'), 'queued', 'the room line is held behind the draft');
reads.noteFabric('R1', 7, 'seat-auriga', 'auriga'); // room-fabric sent its copy to the agent's slug

const ts = new Date().toISOString();
const base = { ts, from: 'user', to: 'auriga', thread: 't-room', class: 'coordination', attention: 'notice', ack: 'none' };
push({ ...base, id: 'env-room-7', kind: 'notice', body: 'hello auriga', ref: 'room:R1/line:7' });
push({ ...base, id: 'env-plain-1', kind: 'msg', class: 'info', thread: 't-other', body: 'ping' });
const delivered = await until(() => acks.filter((a) => a.level === 'delivered'), (l) => l.length >= 2);
eq(delivered.some((a) => a.id === 'env-room-7'), true, 'the room copy is acked delivered (the ladder still climbs that far)');
eq(delivered.some((a) => a.id === 'env-plain-1'), true, 'the ordinary envelope is acked delivered');
eq(sub.dump().awaitingSeenAck, 1, 'only the ORDINARY envelope waits for a human seen-ack');

activity.onInput(PANE, ' more');
sub.onPaneAttention(PANE); // exactly what the WS input handler calls
await until(() => acks.filter((a) => a.level === 'seen'), (l) => l.length >= 1);
await sleep(150); // room for a wrong second ack to land
const seen = acks.filter((a) => a.level === 'seen');
eq(seen.some((a) => a.id === 'env-plain-1'), true, 'the ordinary envelope: acked seen (its badge is that human\'s)');
eq(seen.some((a) => a.id === 'env-room-7'), false, 'the ROOM COPY: never acked seen on a human\'s behalf');
eq(seen.length, 1, 'exactly one seen ack');

console.log('\n[read state follows only the agent]');
const pd = (typer.diag().panes as Record<string, { lastResult: string }>)[PANE];
eq(pd.lastResult, 'held:draft', 'the typed copy is still held behind the draft');
const ladder = (ack: string) => [{ to: 'auriga', ref: 'room:R1/line:7', ack }];
const rs = () => reads.readsFor({ id: 7, room_id: 'R1', ts: 0, kind: 'chat', author: 'user', author_seat: null, target: null, target_seat: null, thread: null, body: null, ref: null, meta: null } as never) as Record<string, string>;
eq(reads.mergeFabricAcks('R1', ladder('delivered')), 0, 'the ladder as the fabric now holds it (delivered) moves nothing');
eq(rs().auriga, 'not-yet', 'held behind a draft + a human typing: not-yet, NOT seen');
eq(reads.mergeFabricAcks('R1', ladder('seen')), 1, 'the AGENT acking its own copy seen (fabric_ack) still upgrades');
eq(rs().auriga, 'seen', '...to seen');

sub.stop();
for (const ws of sockets) ws.terminate();
await new Promise<void>((r) => http.close(() => r()));
typer.reset();
reads.reset();
/* Windows refuses to unlink scratch.db while the in-process store holds it. */
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* held open by better-sqlite3 until exit */
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
