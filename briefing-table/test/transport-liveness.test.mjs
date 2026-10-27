/* A SOCKET THAT STALLS MUST BE GIVEN UP ON.
 *
 * A blackholed TCP flow never fires `onclose`: readyState stays OPEN, send()
 * succeeds, nothing arrives. Owner lost five minutes to it — the pane looked
 * connected and every keystroke he typed appeared at once when the path
 * recovered. Silence alone is not evidence (an idle session sends nothing for
 * minutes), so the client pings and gives up when the ANSWERS stop.
 *
 * Unit level, with a fake WebSocket and fake timers: the real thing cannot be
 * made to stall on demand, which is exactly why this bug survived.
 */
import { createTransport } from '../web/transport.mjs';

let pass = 0;
let fail = 0;
const ok = (c, label, detail) => {
  console.log(`  ${c ? '✓' : '✗'} ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  c ? pass++ : fail++;
};

/* --- the fakes ---------------------------------------------------------- */
let now = 0;
const timers = [];
const realDate = Date.now;
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearInterval = globalThis.clearInterval;
Date.now = () => now;
globalThis.setInterval = (fn, ms) => { const t = { fn, ms, next: now + ms, kind: 'i' }; timers.push(t); return t; };
globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, next: now + ms, kind: 't' }; timers.push(t); return t; };
globalThis.clearInterval = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
const tick = (ms) => {
  const end = now + ms;
  while (true) {
    const due = timers.filter((t) => t.next <= end).sort((a, z) => a.next - z.next)[0];
    if (!due) break;
    now = due.next;
    if (due.kind === 'i') { due.next = now + due.ms; } else { timers.splice(timers.indexOf(due), 1); }
    due.fn();
  }
  now = end;
};

const sockets = [];
class FakeWS {
  static OPEN = 1;
  static CLOSED = 3;
  constructor() {
    this.readyState = FakeWS.OPEN;
    this.sent = [];
    this.closes = 0;
    sockets.push(this);
    queueMicrotask(() => this.onopen && this.onopen());
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closes += 1; this.readyState = FakeWS.CLOSED; if (this.onclose) this.onclose(); }
  deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}
globalThis.WebSocket = FakeWS;
globalThis.location = { protocol: 'http:', host: '127.0.0.1:7420' };

/* --- the test ------------------------------------------------------------ */
const t = createTransport();
await Promise.resolve();
const first = sockets[0];
ok(!!first, 'it opened a socket');
ok(t.status === 'open', 'and reports open once the socket is up', t.status);

console.log('\n[a healthy socket is pinged and left alone]');
tick(11_000);
ok(first.sent.some((m) => m.type === 'ping'), 'it pings');
first.deliver({ type: 'pong' });
tick(25_000);
first.deliver({ type: 'pong' });
tick(25_000);
ok(first.closes === 0, 'a socket that ANSWERS is never given up on', `${first.closes} closes`);
ok(t.status === 'open', '...and stays open');

console.log('\n[a stalled socket is given up on, and recovery is the normal path]');
const before = sockets.length;
tick(31_000); // pings go out, nothing comes back
ok(first.closes === 1, 'a socket that stops answering is CLOSED deliberately', `${first.closes}`);
ok(t.status === 'closed', '...so the page learns it is disconnected', t.status);
tick(1_100); // the existing 1s reconnect timer
await Promise.resolve();
ok(sockets.length === before + 1, '...and it reconnects through the ONE existing path', `${sockets.length} sockets`);

console.log('\n[input typed during the stall is not written into a void]');
const second = sockets[sockets.length - 1];
await Promise.resolve();
second.readyState = FakeWS.CLOSED; // mid-reconnect: not open yet
t.send({ type: 'input', paneid: 'p', data: 'hello' });
ok(second.sent.length === 0, 'it is NOT sent to a socket that is not open');
second.readyState = FakeWS.OPEN;
second.onopen();
ok(second.sent.some((m) => m.type === 'input' && m.data === 'hello'),
  '...it is queued and flushed on reconnect, in order');

console.log('\n[a pong is liveness only]');
let leaked = 0;
t.on('pong', () => { leaked += 1; });
second.deliver({ type: 'pong' });
ok(leaked === 0, 'nothing downstream ever sees a pong');

Date.now = realDate;
globalThis.setInterval = realSetInterval;
globalThis.setTimeout = realSetTimeout;
globalThis.clearInterval = realClearInterval;
console.log(`\nPASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
