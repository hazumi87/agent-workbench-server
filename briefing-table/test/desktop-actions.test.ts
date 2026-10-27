/* desktop-actions.test — Phase 2, the engine half of the window-agent seam
 * (the design notes §5b; D3 = PULL).
 *
 * What this guards is the SELECTION and the two answers a desktop-less engine
 * has to give, because both are failure modes that are invisible until someone
 * is stranded:
 *
 *  - The DEFAULT must be `loopback` for any value of `HARBOR_WB_DESKTOP`,
 *    including a typo. "Rollback is one env var" (contract §5b) only holds if
 *    the env var can never silently disable every window on the desk.
 *  - `none`, and `agent` with nobody registered, must answer
 *    `placement:'browser'` with `ok:true` — NOT an error. A server engine before
 *    any agent exists is the phone case, and a phone has always been handed the
 *    url and told to open it itself.
 *
 * Deliberately NOT here: anything that would touch :8200 or spawn a window.
 * The loopback implementation is exercised end-to-end by engine.test.mjs
 * against a FAKE window host; this file only asks it which url it builds.
 */
process.env.HARBOR_WB_TOKEN = 'test-token-do-not-ship'; // never mint/write secrets/engine.token
process.env.HARBOR_WB_WINDOW_AGENT_TOKEN = 'test-window-agent-token'; // never mint/write secrets/window-agent.token
process.env.HARBOR_WB_HOST = '127.0.0.1';
process.env.HARBOR_WB_PORT = '7420';

const { chooseMode, makeDesktopActions } = await import('../src/engine/desktop-actions.ts');
const { redeemTicket, isWindowAgentCredential, windowAgentSharedBearerAllowed, hostedProfile } = await import('../src/server/auth.ts');

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  cond ? pass++ : fail++;
};
const eq = (actual: unknown, expected: unknown, label: string) =>
  ok(actual === expected, label, `got ${JSON.stringify(actual)}`);

console.log('\n[mode selection: the default is today, whatever the env says]');
eq(chooseMode({}), 'loopback', 'unset → loopback');
eq(chooseMode({ HARBOR_WB_DESKTOP: 'loopback' }), 'loopback', 'loopback → loopback');
eq(chooseMode({ HARBOR_WB_DESKTOP: 'agent' }), 'agent', 'agent → agent');
eq(chooseMode({ HARBOR_WB_DESKTOP: 'none' }), 'none', 'none → none');
eq(chooseMode({ HARBOR_WB_DESKTOP: ' AGENT ' }), 'agent', 'trimmed + case-folded');
/* A TYPO MUST NOT STRAND THE DESK. Falling back to the mode that opens windows
   is the only safe reading of an unrecognised value. */
eq(chooseMode({ HARBOR_WB_DESKTOP: 'agnet' }), 'loopback', 'an unrecognised value falls back to loopback');

console.log('\n[the interface each mode hands back]');
eq(makeDesktopActions('loopback').mode, 'loopback', 'loopback impl');
eq(makeDesktopActions('agent').mode, 'agent', 'agent impl');
eq(makeDesktopActions('none').mode, 'none', 'none impl');

console.log('\n[none: there is no desktop — every launch is a browser launch]');
const none = makeDesktopActions('none');
const noneOpen = await none.open({ url: 'http://127.0.0.1:7420/solo.html?recipe=x', paneid: 'recipe:x', placement: 'window' });
ok(noneOpen.ok === true, 'open is NOT an error', JSON.stringify(noneOpen));
eq(noneOpen.placement, 'browser', 'open answers browser');
ok((await none.focus('recipe:x')).ok === false, 'nothing to focus');
ok((await none.inventory()).length === 0, 'empty inventory');
eq(none.soloUrlFor('/solo.html?recipe=x'), 'http://127.0.0.1:7420/solo.html?recipe=x', 'soloUrlFor is the engine origin');
eq(none.status().mode, 'none', 'status reports the mode');
ok(Array.isArray(none.status().lastActions), 'status carries the action ring');

console.log('\n[agent, nobody registered: the same answer, not an error]');
const agent = makeDesktopActions('agent');
const agentOpen = await agent.open({ url: 'http://127.0.0.1:7420/solo.html?recipe=y', paneid: 'recipe:y', placement: 'window' });
ok(agentOpen.ok === true, 'open with no agent is NOT an error', JSON.stringify(agentOpen));
eq(agentOpen.placement, 'browser', 'open answers browser');
ok((await agent.focus('recipe:y')).ok === false, 'focus finds no holder');
eq((await agent.close('recipe:y', 'end')).error, 'no-agent', 'close says why it could not');
/* With no agent there is no registered base, so the loopback form is still the
   right answer — it is what the browser fallback hands back. */
eq(agent.soloUrlFor('/solo.html?recipe=y'), 'http://127.0.0.1:7420/solo.html?recipe=y', 'soloUrlFor falls back to the engine origin');
eq(agent.status().agents.length, 0, 'no agents listed');

console.log('\n[a window agent that dials the wrong mode is refused, loudly]');
for (const mode of ['loopback', 'none'] as const) {
  let closedWith: number | null = null;
  const fakeWs = { close: (code: number) => { closedWith = code; }, on: () => {} };
  makeDesktopActions(mode).attachAgent(fakeWs as never, 'test');
  eq(closedWith, 4400, `${mode} closes a /window-agent socket rather than leaving it hanging`);
}


console.log('\n[M9: the window agent has its OWN credential; a registration is not replaced by a caller without it; a person ticket goes only to a credentialed agent]');
const hdr = (v?: string) => ({ headers: v ? { authorization: v } : {} }) as never;
ok(isWindowAgentCredential(hdr('Bearer test-window-agent-token')), 'the dedicated token is the window-agent credential');
ok(!isWindowAgentCredential(hdr('Bearer test-token-do-not-ship')), 'the shared engine bearer is NOT');
ok(!isWindowAgentCredential(hdr()) && !isWindowAgentCredential(hdr('Bearer nope')), 'nothing, or a wrong token, is not');
ok(windowAgentSharedBearerAllowed({}) && !windowAgentSharedBearerAllowed({ HARBOR_WB_WINDOW_AGENT_STRICT: '1' }) && !windowAgentSharedBearerAllowed({ HARBOR_WB_HOSTED: '1' }), 'the shared bearer registers an uncredentialed agent by default; strict or hosted refuses it');
ok(!hostedProfile({}) && hostedProfile({ HARBOR_WB_HOSTED: '1' }), 'the hosted profile is HARBOR_WB_HOSTED=1');

function fakeAgent() {
  const handlers: Record<string, (raw: Buffer) => void> = {};
  const sent: any[] = [];
  const w = { closedWith: null as number | null, sent, handlers, on: (ev: string, fn: (raw: Buffer) => void) => { handlers[ev] = fn; }, send: (d: string) => { sent.push(JSON.parse(d)); }, close: (c: number) => { w.closedWith = c; } };
  return w;
}
const feed = (w: ReturnType<typeof fakeAgent>, msg: unknown) => w.handlers.message(Buffer.from(JSON.stringify(msg)));
const desk = makeDesktopActions('agent');
const good = fakeAgent();
desk.attachAgent(good as never, 'vrpc-host', true);
feed(good, { type: 'register', host: 'win', agent: 'real-agent', capabilities: ['window'], base: 'http://win:1' });
eq(desk.status().agents.length, 1, 'the credentialed agent registered');
const intruder = fakeAgent();
desk.attachAgent(intruder as never, 'other', false);
feed(intruder, { type: 'register', host: 'win', agent: 'intruder', capabilities: ['window'], base: 'http://evil:1' });
eq(intruder.closedWith, 4403, 'a caller WITHOUT the credential cannot replace the registration (closed 4403)');
eq((desk.status().agents[0] as { agent: string }).agent, 'real-agent', '...and the real agent is still the registered one');
eq(good.closedWith, null, '...whose socket was not dropped');
const again = fakeAgent();
desk.attachAgent(again as never, 'vrpc-host', true);
feed(again, { type: 'register', host: 'win', agent: 'real-agent-2', capabilities: ['window'], base: 'http://win:1' });
eq(good.closedWith, 4409, 'the credentialed agent reconnecting DOES replace its own old socket');

async function openAs(w: ReturnType<typeof fakeAgent>, byUserId?: string): Promise<string> {
  const p = desk.open({ url: 'http://win:1/solo.html?recipe=x', paneid: 'recipe:x', placement: 'window', byUserId });
  await new Promise((r) => setTimeout(r, 20));
  const frame = w.sent.find((m) => m.type === 'window.open');
  w.handlers.message(Buffer.from(JSON.stringify({ type: 'window.result', req: frame.req, ok: true, placement: 'window' })));
  await p;
  w.sent.length = 0;
  return new URL(frame.url).searchParams.get('ticket') ?? '';
}
eq(redeemTicket(await openAs(again, 'person-1')).userId, 'person-1', 'a person ticket goes to a CREDENTIALED agent');
const desk2 = makeDesktopActions('agent');
const plain = fakeAgent();
desk2.attachAgent(plain as never, 'x', false);
feed(plain, { type: 'register', host: 'win2', agent: 'shared-bearer-agent', capabilities: ['window'], base: 'http://win2:1' });
const p2 = desk2.open({ url: 'http://win2:1/solo.html?recipe=x', paneid: 'recipe:x', placement: 'window', byUserId: 'person-1' });
await new Promise((r) => setTimeout(r, 20));
const fr = plain.sent.find((m) => m.type === 'window.open');
plain.handlers.message(Buffer.from(JSON.stringify({ type: 'window.result', req: fr.req, ok: true, placement: 'window' })));
await p2;
eq(redeemTicket(new URL(fr.url).searchParams.get('ticket') ?? '').userId, null, 'an UNCREDENTIALED agent gets a ticket naming nobody, never the person');

console.log(`\nPASS ${pass}  FAIL ${fail}`);
if (fail > 0) {
  process.exit(1);
}
