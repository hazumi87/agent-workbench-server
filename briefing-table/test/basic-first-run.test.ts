/**
 * DAY ONE ON BASIC. A scratch Basic instance, provisioned by the real
 * script, driven the way a person's browser drives it: sign in with the one-time password, start a seat from its room, attach its
 * terminal, post a line, answer the first-run dialogs. The fake `claude` reproduces the REAL first-run behaviour (trust dialog that
 * defaults to "No, exit", logged-out line), so a gap here is a gap a first-time user hits.
 *
 * Two kinds of check. `ok` is a fact about today's behaviour (a failure fails the suite). `gap` is a thing a first-time user NEEDS
 * and today's engine may not do: a miss prints `GAP` and is counted, but does not fail the suite; when someone fixes it the line
 * turns `ok` by itself. The summary lists every open gap, so the suite is a report as well as a regression guard.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
const { startScratchBasic } = await import('../scripts/basic-scratch-instance.ts');
type Scratch = Awaited<ReturnType<typeof startScratchBasic>>;
type Client = Awaited<ReturnType<Scratch['signIn']>>;

let failed = 0;
let checks = 0;
const gaps: string[] = [];
const ok = (c: unknown, m: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const gap = (c: unknown, m: string) => { checks++; if (c) console.log(`  ok ${m}`); else { gaps.push(m); console.log(`  GAP ${m}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, ms = 12000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(250); } return await f(); };
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

interface Pane { paneid: string; text(): string; send(data: string): void; /** end the process like the End button, then drop the socket */ end(): void; close(): void; }
function attach(inst: Scratch, c: Client, paneid: string, recipe: string): Promise<Pane> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/pty`, { headers: { cookie: c.cookie } });
    let text = '';
    ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === 'pane.data' || m.type === 'pane.replay') text += m.data ?? ''; } catch { /* ignore */ } });
    ws.on('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'attach', paneid, recipe, cols: 80, rows: 24 }));
      resolve({ paneid, text: () => text, send: (data) => ws.send(JSON.stringify({ type: 'input', paneid, data })), end: () => { try { ws.send(JSON.stringify({ type: 'kill', paneid })); } catch { /* gone */ } setTimeout(() => ws.close(), 300); }, close: () => ws.close() });
    });
  });
}
const rooms = async (c: Client) => (await c.get('/api/rooms')).body as any[];
const seatOf = async (c: Client, roomName: string) => (await rooms(c)).find((r) => r.room.name === roomName);
const setTrust = (inst: Scratch, dirs: string[]) =>
  writeFileSync(join(inst.home, '.claude.json'), JSON.stringify({ projects: Object.fromEntries(dirs.map((d) => [d, { hasTrustDialogAccepted: true }])) }));
const inputLog = (inst: Scratch): string[] => {
  const p = join(inst.home, '.fake-vendors', 'claude-input.log');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
};
async function startSeat(inst: Scratch, c: Client, roomName: string, recipe: string): Promise<{ pane: Pane; roomId: string; seatId: string }> {
  const r = await seatOf(c, roomName);
  const st = (await c.post(`/api/rooms/${r.room.id}/seats/${r.seats[0].id}/start`, {})).body as any;
  const pane = await attach(inst, c, st.paneid, recipe);
  return { pane, roomId: r.room.id, seatId: r.seats[0].id };
}
const line = async (c: Client, roomId: string, text: string) => (await c.post(`/api/rooms/${roomId}/line`, { text })).body as any;
const seatView = async (c: Client, roomName: string) => (await seatOf(c, roomName)).seats[0];

const inst = await startScratchBasic();
try {
  const c = await inst.signIn();
  const BUILDER = join(inst.home, 'dev', 'code', 'hello-world');
  const PLATFORM = join(inst.home, 'dev');

  console.log('sign-in');
  ok((await c.get('/api/table')).status === 200, 'the one-time password, the forced change and the cookie open the app');
  const list = await rooms(c);
  ok(list.map((r) => r.room.name).sort().join() === 'Hello World,My Platform', 'a new user starts with their two seeded rooms');
  ok(list.every((r) => r.seats[0].status === 'never-started'), 'and nothing is running yet');

  console.log('day one, folder NOT trusted: the first launch');
  setTrust(inst, []);
  const s1 = await startSeat(inst, c, 'Hello World', 'hosted-builder');
  ok(await until(() => /Quick safety check/.test(s1.pane.text()), 8000), 'the terminal shows the folder-trust dialog');
  ok(/> 2\. No, exit/.test(s1.pane.text()), 'whose default selection is "No, exit" (so Enter alone would quit)');
  const posted = await line(c, s1.roomId, '@builder hello there');
  ok(posted.deliveries?.[0]?.delivered === true || posted.deliveries?.[0]?.queued === true, 'a line to the seat is accepted (held, not lost)');
  await sleep(1500);
  let v = await seatView(c, 'Hello World');
  ok(v.occupant?.held?.reason === 'startup' && v.occupant?.held?.prompt === 'trust', 'the engine KNOWS it is waiting at the trust prompt and holds the line for it');
  gap(!!v.occupant?.blocked || !!v.waiting?.needsYou || v.occupant?.held?.hint, 'the room tells the person, in words, that the assistant is waiting for one answer (today it shows only a held-line badge)');
  s1.pane.send('yes' + CR);
  await sleep(1500);
  ok(/Quick safety check/.test(s1.pane.text()) && inputLog(inst).length === 1, 'typing the WORD "yes" is ignored by the dialog and arrives once: no flood, no exit');
  s1.pane.send(ESC + '[A');
  await sleep(500);
  s1.pane.send(CR);
  ok(await until(() => /fake-claude heard: .*hello there/.test(s1.pane.text()), 12000), 'arrow-up then Enter ("Yes, I trust this folder") releases the held line into the assistant');
  v = await seatView(c, 'Hello World');
  ok(!v.occupant?.held, 'and nothing is left held');
  s1.pane.end();
  await until(async () => (await seatView(c, 'Hello World')).status !== 'live', 8000);

  console.log('day one, answering with the digit "1" only (the advice given to a phone user)');
  setTrust(inst, []);
  // a second untrusted launch: the runtime room's seat (folder ~/dev)
  const s2 = await startSeat(inst, c, 'My Platform', 'hosted-platform');
  ok(await until(() => /Quick safety check/.test(s2.pane.text()), 8000), 'a second seat in an untrusted folder shows the same dialog');
  await line(c, s2.roomId, '@platform second hello');
  s2.pane.send('1');
  await sleep(6000);
  v = await seatView(c, 'My Platform');
  gap(/fake-claude heard: .*second hello/.test(s2.pane.text()) && !v.occupant?.held, 'answering with "1" alone also releases the held line (today the keystroke is taken for an unsent draft and the line stays held until Enter)');
  s2.pane.send(CR);
  ok(await until(() => /fake-claude heard: .*second hello/.test(s2.pane.text()), 12000), 'one more Enter releases it (so the manual workaround works)');
  s2.pane.end();
  await until(async () => (await seatView(c, 'My Platform')).status !== 'live', 8000);

  console.log('day one, Enter alone at the dialog (the default "No, exit")');
  // end both and relaunch builder untrusted, then press Enter only
  setTrust(inst, []);
  const s3 = await startSeat(inst, c, 'Hello World', 'hosted-builder');
  ok(await until(() => /Quick safety check/.test(s3.pane.text()), 8000), 'a relaunch of the builder seat is at the dialog again');
  s3.pane.send(CR);
  await sleep(3000);
  const posted3 = await line(c, s3.roomId, '@builder anyone there?');
  await sleep(2000);
  const v3 = await seatView(c, 'Hello World');
  ok(v3.occupant?.held?.reason === 'no-claude' || v3.status !== 'live', 'once the assistant has quit, the line is not typed into a bare shell: either held (no claude owns the terminal) or the seat has ended with its shell (claude ...; exit)');
  gap(v3.status !== 'live' && posted3.deliveries?.[0]?.delivered !== true, 'the room stops presenting the seat as live and does NOT report the line as delivered once its assistant has quit (today the seat still reads live and the line reads delivered/queued, with nobody to read it)');
  gap(/start|restart|relaunch/i.test(JSON.stringify(v3.occupant?.held ?? {}) + JSON.stringify(posted3.entries ?? [])), 'and it tells the person how to get the assistant back (a Start button or words)');
  s3.pane.end();
  await until(async () => (await seatView(c, 'Hello World')).status !== 'live', 8000);

  console.log('day one, folder ALREADY trusted (what the provisioning fix aims for)');
  setTrust(inst, [PLATFORM, BUILDER]);
  const s4 = await startSeat(inst, c, 'Hello World', 'hosted-builder');
  ok(await until(() => /fake\) in/.test(s4.pane.text()), 8000) && !/Quick safety check/.test(s4.pane.text()), 'the assistant starts straight into its prompt, with no dialog');
  await line(c, s4.roomId, '@builder trusted hello');
  ok(await until(() => /fake-claude heard: .*trusted hello/.test(s4.pane.text()), 12000), 'a line is delivered to it');
  s4.pane.close();
} finally {
  await inst.stop();
}

console.log('day one, NOT logged in');
const inst2 = await startScratchBasic({ needsLogin: true });
try {
  const c = await inst2.signIn();
  setTrust(inst2, [join(inst2.home, 'dev'), join(inst2.home, 'dev', 'code', 'hello-world')]);
  const s5 = await startSeat(inst2, c, 'Hello World', 'hosted-builder');
  ok(await until(() => /Not logged in/.test(s5.pane.text()), 8000), 'a logged-out assistant shows the real "Not logged in" line');
  await sleep(2500);
  const v = await seatView(c, 'Hello World');
  gap(v.occupant?.blocked?.reason === 'login', 'the room shows the seat as blocked on LOGIN (so the person is told to connect their account)');
  s5.pane.close();
} finally {
  await inst2.stop();
}

console.log(gaps.length ? `\nOPEN GAPS (${gaps.length}), each a thing a first-time user needs:\n${gaps.map((g, i) => `  ${i + 1}. ${g}`).join('\n')}\n` : '\nno open gaps\n');
console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
