/* broker-available.test — `available()` means "this engine can spawn SOMEWHERE".
 *
 * 2026-09-17: the server engine reaches its own host's broker as the named link
 * `homebase` and its LOCAL link points at a dead port by design. `available()` used
 * to report the local link alone, so the CLI Manager showed "PTY-broker
 * unavailable — new sessions are blocked" on an engine whose every spawn
 * worked. Guard: a dead local link + one reachable named link = available. */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from 'pty-broker/src/protocol.ts';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  if (cond) { pass++; } else { fail++; }
};

// A stand-in broker: answers /health with the protocol version and nothing else.
const stub = createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', protocolVersion: PROTOCOL_VERSION, held: 0 }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
const port = (stub.address() as { port: number }).port;

process.env.HARBOR_WB_BROKER_PORT = '7499'; // dead local link, as on the server
process.env.HARBOR_WB_BROKERS = JSON.stringify({ homebase: { url: `ws://127.0.0.1:${port}/broker` } });
process.env.HARBOR_WB_BROKER_AUTOSTART = '0';

const brokerClient = await import('../src/engine/broker-client.ts');

ok(brokerClient.available() === false, 'nothing probed yet: not available');
ok((await brokerClient.linkFor('local')!.ensure()) === false, 'local link (dead port) is down');
ok(brokerClient.available() === false, 'local down, remote unprobed: still not available');
ok((await brokerClient.linkFor('homebase')!.ensure()) === true, 'named link reaches the stub broker');
ok(brokerClient.available() === true, 'one reachable named link => available (banner must not show)');
const st = brokerClient.statuses();
ok(st.local === 'down' && st.homebase === 'up', 'per-host truth stays in statuses()', JSON.stringify(st));


/* RECOVERY SWEEP: a remote link that goes down and comes back is re-probed on a
   clock, and its held sessions are handed to the adopter on the down->up edge.
   The stub answers the broker's `list` so listLive() has something to return. */
const wss = new WebSocketServer({ server: stub, path: '/broker' });
wss.on('connection', (sock) => {
  sock.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'list') {
      sock.send(JSON.stringify({ type: 'list', sessions: [{ sid: 'held-1', alive: true }, { sid: 'dead-1', alive: false }] }));
    }
  });
});
const adopted: Array<[string, string[]]> = [];
const stop = brokerClient.startRecoverySweep(async (link, sids) => { adopted.push([link.host, sids]); }, 150);
await new Promise((r) => setTimeout(r, 400));
ok(adopted.length === 0, 'an already-up link is not re-adopted by the sweep');
// Take the stub away: the sweep must notice without anyone spawning.
for (const c of wss.clients) { c.terminate(); }
wss.close();
stub.closeAllConnections();
await new Promise<void>((r) => stub.close(() => r()));
await new Promise((r) => setTimeout(r, 700));
ok(brokerClient.statuses().homebase === 'down', 'sweep marks a vanished remote link down', brokerClient.statuses().homebase);
ok(brokerClient.available() === false, 'no link up => not available again');
// Bring it back on the SAME port: down->up must adopt what it holds.
const stub2 = createServer((req, res) => {
  if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', protocolVersion: PROTOCOL_VERSION, held: 1 })); return; }
  res.statusCode = 404; res.end();
});
const wss2 = new WebSocketServer({ server: stub2, path: '/broker' });
wss2.on('connection', (sock) => {
  sock.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'list') {
      sock.send(JSON.stringify({ type: 'list', sessions: [{ sid: 'held-1', alive: true }, { sid: 'dead-1', alive: false }] }));
    }
  });
});
await new Promise<void>((r) => stub2.listen(port, '127.0.0.1', r));
await new Promise((r) => setTimeout(r, 900));
ok(brokerClient.statuses().homebase === 'up', 'sweep marks the returned link up', brokerClient.statuses().homebase);
ok(adopted.length === 1 && adopted[0][0] === 'homebase', 'down->up handed the link to the adopter once', JSON.stringify(adopted));
ok(JSON.stringify(adopted[0]?.[1]) === JSON.stringify(['held-1']), 'adopter received only the ALIVE sids', JSON.stringify(adopted[0]?.[1]));
stop();
for (const c of wss2.clients) { c.terminate(); }
wss2.close();
stub2.closeAllConnections();
await new Promise<void>((r) => stub2.close(() => r()));

console.log(`\nbroker-available: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
