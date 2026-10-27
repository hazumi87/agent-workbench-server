/* broker-client-auth.test — a wrong bearer parks the link as 'unauthorized', whichever way the broker refuses it.
 *
 * pty-broker 16afa01 (H7) refuses a bad or missing bearer at the HTTP upgrade (401), before any socket exists. Older brokers
 * accepted the upgrade and closed 4401. The engine must read BOTH as "the token is wrong" (slow retry, loud log) and never as a
 * plain connection drop it should reconnect to every two seconds. Stand-in brokers speak each behaviour. */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from 'pty-broker/src/protocol.ts';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  if (cond) { pass++; } else { fail++; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function standIn(mode: 'upgrade-401' | 'close-4401') {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', protocolVersion: PROTOCOL_VERSION }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const bad = (h: Record<string, unknown>) => h.authorization !== 'Bearer the-right-token-0123456789';
  const wss = new WebSocketServer({
    server,
    path: '/broker',
    verifyClient: mode === 'upgrade-401' ? (info, done) => (bad(info.req.headers) ? done(false, 401, 'Unauthorized') : done(true)) : undefined,
  });
  wss.on('connection', (ws, req) => {
    if (mode === 'close-4401' && bad(req.headers)) {
      ws.close(4401, 'unauthorized');
    }
  });
  return new Promise<{ port: number }>((r) => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as { port: number }).port })));
}

const a = await standIn('upgrade-401');
const b = await standIn('close-4401');
process.env.HARBOR_WB_BROKER_PORT = '7499';
process.env.HARBOR_WB_BROKER_AUTOSTART = '0';
process.env.HARBOR_WB_BROKERS = JSON.stringify({
  modern: { url: `ws://127.0.0.1:${a.port}/broker`, token: 'a-wrong-token-0123456789' },
  legacy: { url: `ws://127.0.0.1:${b.port}/broker`, token: 'a-wrong-token-0123456789' },
  goodmodern: { url: `ws://127.0.0.1:${a.port}/broker`, token: 'the-right-token-0123456789' },
});
const bc = await import('../src/engine/broker-client.ts');

for (const host of ['modern', 'legacy']) {
  const link = bc.linkFor(host)!;
  ok((await link.ensure()) === true, `${host}: /health is open, so the probe passes`);
  await link.listLive(); // opens the socket with the wrong bearer
  await sleep(300);
  ok(bc.statuses()[host] === 'unauthorized', `${host}: a wrong bearer parks the link as unauthorized`, JSON.stringify(bc.statuses()));
}

const good = bc.linkFor('goodmodern')!;
ok((await good.ensure()) === true, 'goodmodern: probe passes');
await good.listLive().catch(() => []);
await sleep(300);
ok(bc.statuses().goodmodern === 'up' && good.socketOpen(), 'the right bearer connects and stays up', JSON.stringify(bc.statuses()));

console.log(`\nPASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
