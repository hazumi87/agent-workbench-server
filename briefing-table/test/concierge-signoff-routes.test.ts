/**
 * CONCIERGE SIGN-OFF ROUTES, in process (no engine, no ports): the person's door and the Concierge pane's door, driven with fake requests.
 * Only a person answers; a cookie-less credential, a token or the bearer is 403 needs_a_person; a cross-site Origin is refused; the Concierge can request and read, never answer.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-signoff-routes-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';

const { table } = await import('../src/table/endpoint.ts');
const routes = await import('../src/server/concierge.ts');
const concierge = await import('../src/engine/concierge.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

const call = async (fn: 'handle' | 'handleScope', method: string, url: string, body: unknown, opts: { human?: boolean; person?: boolean; origin?: string; paneid?: string } = {}): Promise<{ status: number; json: any }> => {
  const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { host: 'wb.local:8201', 'content-type': 'application/json', ...(opts.origin ? { origin: opts.origin } : {}) };
  let status = 0;
  let text = '';
  const res: any = { writeHead: (s: number) => { status = s; }, setHeader() {}, end: (t: string) => { text = t; } };
  const route = url.split('?')[0];
  const deps: any = { human: !!opts.human, person: opts.person ?? !!opts.human, log() {}, paneTokensOn: true, recipe: (id: string) => table.getRecipe(id), isLive: () => true, userKey: 'owner' };
  if (fn === 'handle') await routes.handle(req, res, route, deps);
  else await routes.handleScope(req, res, route, opts.paneid ?? '', { sessions: async () => [], rooms: async () => [], recipeSessions: async () => [], relay: {} as any, act: { seat: (sid: string) => { const x = table.getSeat(sid); return x ? { id: x.id, room_id: x.room_id, handle: x.handle, left_at: x.left_at, paneid: x.occupant } : undefined; }, held: () => ({ depth: 1 }), hasDraft: () => false, deliverHeld: () => ({ ok: true, result: 'injected' }), fact: () => {}, log() {} } as any, log() {} });
  return { status, json: text ? JSON.parse(text) : null };
};

// a Concierge recipe, enabled, with the reload verb allowed
const rec = (id: string, name: string) => table.upsertRecipe({ id, name, target: 'local', projectDir: `/x/${name}`, vendor: 'claude-code', agent: name, model: null, resume: 0, resumeName: null,
  initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
rec('cg', 'concierge'); rec('rec-alpha', 'alpha');
table.upsert({ paneid: 'recipe:rec-alpha', recipe_id: 'rec-alpha', server: 'local', vendor: 'claude-code', agent: 'alpha', session_id: null, state: 'live', generation: 1 } as never);
concierge.setSettings({ enabled: true, primary: 'cg', allowed: { reload: false, compactReload: true, inject: false } as never });
concierge.resetCache();
const R = table.createRoom({ name: 'Crew', alias: 'crew' }, { actor: 'user' }).result;
table.addSeat(R.id, { recipe_id: 'rec-alpha', occupant: 'recipe:rec-alpha', handle: 'alpha' } as never, { actor: 'user' });
const CG = 'recipe:cg';

console.log('\n[the Concierge pane requests and reads]');
const mk = await call('handleScope', 'POST', '/api/concierge/signoffs', { verb: 'reload', targets: [{ room: R.id, handle: 'alpha' }] }, { paneid: CG });
ok(mk.status === 201 && mk.json.state === 'pending' && mk.json.text === 'Reload 1 seat: @alpha', 'POST creates a pending record with the engine words');
const id = mk.json.id;
ok((await call('handleScope', 'GET', `/api/concierge/signoffs/${id}`, undefined, { paneid: CG })).json.id === id, 'the Concierge reads its record');
ok((await call('handleScope', 'POST', '/api/concierge/signoffs', { verb: 'inject', targets: [{ room: R.id, handle: 'alpha' }], args: { text: 'x' } }, { paneid: CG })).json.error === 'action_off', 'a verb the person has not allowed: 403 action_off');
ok((await call('handleScope', 'POST', '/api/concierge/signoffs', { verb: 'reload', targets: [{ room: R.id, handle: 'alpha' }] }, { paneid: 'recipe:rec-alpha' })).json.error === 'not_concierge', 'any other pane: 403 not_concierge');
ok((await call('handleScope', 'POST', `/api/concierge/signoffs/${id}/answer`, { answer: 'approve' }, { paneid: CG })).json.error === 'not_for_pane_token', 'the Concierge pane cannot answer its own request');
ok(table.signoffGet(id)!.state === 'pending', '...and the record is untouched');

console.log('\n[the person: list and answer]');
ok((await call('handle', 'GET', '/api/concierge/signoffs', undefined, { human: false })).json.error === 'needs_a_person', 'no window credential (token, bearer): 403 needs_a_person');
ok((await call('handle', 'POST', `/api/concierge/signoffs/${id}/answer`, { answer: 'approve' }, { human: false })).json.error === 'needs_a_person', '...and cannot answer');
ok(table.signoffGet(id)!.state === 'pending', '...the record is still pending');
const lst = await call('handle', 'GET', '/api/concierge/signoffs', undefined, { human: true });
ok(lst.status === 200 && lst.json.signoffs.length === 1 && lst.json.signoffs[0].id === id, 'a window lists the pending cards');
ok((await call('handle', 'POST', `/api/concierge/signoffs/${id}/answer`, { answer: 'approve' }, { human: true, origin: 'https://evil.example' })).status === 403, 'a cross-site Origin is refused');
ok(table.signoffGet(id)!.state === 'pending', '...nothing recorded');
const yes = await call('handle', 'POST', `/api/concierge/signoffs/${id}/answer`, { answer: 'approve' }, { human: true, origin: 'http://wb.local:8201' });
ok(yes.status === 200 && yes.json.state === 'approved' && yes.json.answered_by === 'owner', 'a same-origin window approves; the person is recorded');
ok((await call('handle', 'POST', `/api/concierge/signoffs/${id}/answer`, { answer: 'cancel' }, { human: true })).status === 409, 'a second answer: 409');

console.log('\n[switching a verb off cancels its pending records]');
const mk2 = await call('handleScope', 'POST', '/api/concierge/signoffs', { verb: 'compact', targets: [{ room: R.id, handle: 'alpha' }] }, { paneid: CG });
ok(mk2.status === 201, 'a compact request is pending');
const patch = await call('handle', 'PATCH', '/api/concierge', { allowed: { compactReload: false } }, { human: true });
ok(patch.status === 200 && table.signoffGet(mk2.json.id)!.state === 'cancelled' && table.signoffGet(id)!.state === 'cancelled', 'PATCH settings with the switch off cancels pending AND approved records of that verb');


console.log('\n[act: the Concierge pane runs an approved sign-off, once]');
const mk3 = await call('handleScope', 'POST', '/api/concierge/signoffs', { verb: 'deliver-held', targets: [{ room: R.id, handle: 'alpha' }] }, { paneid: CG });
ok(mk3.status === 403 && mk3.json.error === 'action_off', 'deliver-held needs the message switch (off here)');
concierge.setSettings({ allowed: { message: true } as never });
concierge.resetCache();
const mk4 = await call('handleScope', 'POST', '/api/concierge/signoffs', { verb: 'deliver-held', targets: [{ room: R.id, handle: 'alpha' }] }, { paneid: CG });
ok((await call('handleScope', 'POST', '/api/concierge/act', { verb: 'deliver-held', signoff: mk4.json.id }, { paneid: CG })).json.error === 'not_approved', 'act before the person approves: 409 not_approved');
await call('handle', 'POST', `/api/concierge/signoffs/${mk4.json.id}/answer`, { answer: 'approve' }, { human: true });
ok((await call('handleScope', 'POST', '/api/concierge/act', { verb: 'deliver-held', signoff: mk4.json.id }, { paneid: 'recipe:rec-alpha' })).json.error === 'not_concierge', 'another pane cannot act');
const done = await call('handleScope', 'POST', '/api/concierge/act', { verb: 'deliver-held', signoff: mk4.json.id }, { paneid: CG });
ok(done.status === 200 && done.json.ok && done.json.results[0].status === 'done', 'after approval the act runs');
ok((await call('handleScope', 'POST', '/api/concierge/act', { verb: 'deliver-held', signoff: mk4.json.id }, { paneid: CG })).status === 409, 'a second act on it: 409');
ok((await call('handleScope', 'POST', '/api/concierge/act', { verb: 'deliver-held' }, { paneid: CG })).json.error === 'bad_request', 'a body without a sign-off id: 400');

console.log('\n[a forgeable "human" is not a person: the legacy cookie on a server]');
const mk5 = await call('handleScope', 'POST', '/api/concierge/signoffs', { verb: 'deliver-held', targets: [{ room: R.id, handle: 'alpha' }] }, { paneid: CG });
const forged = await call('handle', 'POST', `/api/concierge/signoffs/${mk5.json.id}/answer`, { answer: 'approve' }, { human: true, person: false });
ok(forged.status === 403 && forged.json.error === 'needs_a_person' && table.signoffGet(mk5.json.id)!.state === 'pending', 'human (legacy cookie) without an unforgeable person: 403, nothing recorded');
ok((await call('handle', 'GET', '/api/concierge/signoffs', undefined, { human: true, person: false })).status === 403, '...and it cannot list the cards either');
const voice = await call('handle', 'POST', `/api/concierge/signoffs/${mk5.json.id}/answer`, { answer: 'approve', via: 'voice' }, { human: true });
ok(voice.status === 403 && voice.json.error === 'voice_not_proven' && table.signoffGet(mk5.json.id)!.state === 'pending', 'via voice is refused (no per-verb voice assurance exists yet): 403, nothing recorded');
ok((await call('handle', 'POST', `/api/concierge/signoffs/${mk5.json.id}/answer`, { answer: 'approve', via: 'tap' }, { human: true })).json.state === 'approved', 'a tap by a real person still works');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
