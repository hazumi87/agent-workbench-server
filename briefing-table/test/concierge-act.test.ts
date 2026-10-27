/**
 * CONCIERGE ACT (deliver-held first): consume first, frozen targets, the window's guards, one audit fact per room, skipped-not-substituted. Deps are fakes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-act-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';

const { table } = await import('../src/table/endpoint.ts');
const so = await import('../src/engine/concierge-signoff.ts');
const actMod = await import('../src/engine/concierge-act.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const fails = (fn: () => unknown, code: string, status: number, m: string): void => {
  try { fn(); ok(false, `${m} (accepted)`); } catch (e: any) { ok(e?.code === code && e?.status === status, `${m} (${e?.status} ${e?.code ?? e?.message})`); }
};
const afails = async (fn: () => Promise<unknown>, code: string, status: number, m: string): Promise<void> => {
  try { await fn(); ok(false, `${m} (accepted)`); } catch (e: any) { ok(e?.code === code && e?.status === status, `${m} (${e?.status} ${e?.code ?? e?.message})`); }
};
const ALL: any = { message: true, summaries: true, compactReload: true, inject: true, startRestore: true, dispatch: true };

const mkSeat = (room: any, h: string): any => {
  table.upsertRecipe({ id: `rec-${h}`, name: h, target: 'local', projectDir: `/x/${h}`, vendor: 'claude-code', agent: h, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
  table.upsert({ paneid: `recipe:rec-${h}`, recipe_id: `rec-${h}`, server: 'local', vendor: 'claude-code', agent: h, session_id: null, state: 'live', generation: 1 } as never);
  return table.addSeat(room.id, { recipe_id: `rec-${h}`, occupant: `recipe:rec-${h}`, handle: h } as never, { actor: 'user' }).result;
};
const R = table.createRoom({ name: 'Crew', alias: 'crew' }, { actor: 'user' }).result;
const R2 = table.createRoom({ name: 'Crew2', alias: 'crew2' }, { actor: 'user' }).result;
const alpha = mkSeat(R, 'alpha'); const bravo = mkSeat(R, 'bravo'); const charlie = mkSeat(R2, 'charlie'); const delta = mkSeat(R, 'delta');

// fakes: alpha has 2 held lines, bravo has a draft, charlie has 1 held, delta holds nothing
const heldBy: Record<string, number> = { 'recipe:rec-alpha': 2, 'recipe:rec-bravo': 1, 'recipe:rec-charlie': 1 };
const drafts = new Set(['recipe:rec-bravo']);
const delivered: string[] = [];
const states: Record<string, string> = {};
const started: string[] = [];
let startFails = '';
let reloadFails = '';
const reloaded: string[] = [];
const facts: Array<{ room: string; body: string; meta: any }> = [];
const gone = new Set<string>();
const deps: any = {
  seat: (id: string) => { const s = table.getSeat(id); return s && !gone.has(id) ? { id: s.id, room_id: s.room_id, handle: s.handle, left_at: s.left_at, paneid: s.occupant_kind === 'pane' ? s.occupant : null } : undefined; },
  held: (p: string) => (heldBy[p] ? { depth: heldBy[p] } : null),
  hasDraft: (p: string) => drafts.has(p),
  paneState: (p: string) => states[p] ?? null,
  reload: async (id: string) => { if (reloadFails) throw new Error(reloadFails); reloaded.push(id); return {}; },
  start: async (id: string) => { if (startFails) throw new Error(startFails); started.push(id); return { paneid: 'x' }; },
  deliverHeld: (p: string) => { delivered.push(p); return { ok: true, result: 'injected' }; },
  fact: (room: string, body: string, meta: any) => { facts.push({ room, body, meta }); },
  log() {},
};
const sign = (verb: string, targets: any[], T = 1_000_000): string => {
  const r = so.request({ verb, targets }, ALL, T);
  so.answer(r.id, 'approve', 'owner', 'tap', false, T + 1);
  return r.id;
};

console.log('\n[deliver-held through the window\'s guards]');
const id1 = sign('deliver-held', [{ room: R.id, handle: 'alpha' }, { room: R.id, handle: 'bravo' }, { room: R.id, handle: 'delta' }, { room: R2.id, handle: 'charlie' }]);
const out = await actMod.act(id1, 'deliver-held', deps, 1_000_100);
const by = Object.fromEntries(out.results.map((r: any) => [r.target, r]));
ok(out.ok && by.alpha.status === 'done' && by.charlie.status === 'done', 'a seat with held lines and a clear box is delivered');
ok(by.bravo.status === 'skipped' && /typed text/.test(by.bravo.note), 'a draft in the box is NEVER waived: skipped with the reason');
ok(by.delta.status === 'skipped' && /nothing is held/.test(by.delta.note), 'nothing held: skipped');
ok(JSON.stringify(delivered) === JSON.stringify(['recipe:rec-alpha', 'recipe:rec-charlie']), 'deliverHeld ran for exactly the two that qualified');
ok(facts.length === 2 && facts.some((f) => f.room === R.id && /delivered 2 held lines to @alpha/.test(f.body)) && facts.some((f) => f.room === R2.id), 'one audit fact per affected room, naming the sign-off');
ok(facts.every((f) => f.meta.concierge.signoff === id1 && f.meta.concierge.verb === 'deliver-held'), '...with meta.concierge.signoff');
ok(so.get(id1, 1_000_200)!.state === 'consumed' && (so.get(id1, 1_000_200)!.result as any).results.length === 4, 'the sign-off is consumed and carries the result');
await afails(async () => await actMod.act(id1, 'deliver-held', deps, 1_000_300), 'not_approved', 409, 'a second act on the same sign-off is refused (single use)');

console.log('\n[frozen targets: a seat that left is skipped, never substituted]');
delivered.length = 0; facts.length = 0;
const id2 = sign('deliver-held', [{ room: R.id, handle: 'alpha' }], 2_000_000);
gone.add(alpha.id);
const o2 = await actMod.act(id2, 'deliver-held', deps, 2_000_100);
ok(o2.results.length === 1 && o2.results[0].status === 'skipped' && /left or moved/.test(o2.results[0].note!) && !delivered.length && !facts.length, 'the gone seat is skipped with a note; nothing else was touched');
gone.clear();

console.log('\n[a failure inside a handler is a result, the record stays consumed]');
const id3 = sign('deliver-held', [{ room: R.id, handle: 'alpha' }], 3_000_000);
const o3 = await actMod.act(id3, 'deliver-held', { ...deps, deliverHeld: () => { throw new Error('typer exploded'); } }, 3_000_100);
ok(o3.results[0].status === 'failed' && /typer exploded/.test(o3.results[0].note!), 'a thrown error becomes a failed result');
ok(so.get(id3, 3_000_200)!.state === 'consumed', '...and the sign-off stays consumed');


console.log('\n[start and restore: the seat\'s own Start, only for the right state]');
states['recipe:rec-alpha'] = 'live'; states['recipe:rec-bravo'] = 'dehydrated'; states['recipe:rec-delta'] = 'killed';
const idS = sign('start', [{ room: R.id, handle: 'alpha' }, { room: R.id, handle: 'bravo' }, { room: R.id, handle: 'delta' }], 6_000_000);
const oS = await actMod.act(idS, 'start', deps, 6_000_100);
const bs = Object.fromEntries(oS.results.map((r: any) => [r.target, r]));
ok(bs.alpha.status === 'skipped' && /already running/.test(bs.alpha.note), 'start: a live seat is skipped');
ok(bs.bravo.status === 'skipped' && /restore/.test(bs.bravo.note), 'start: a resting session is a restore, skipped');
ok(bs.delta.status === 'done' && JSON.stringify(started) === JSON.stringify([delta.id]), 'start: a stopped seat is started through its own Start');
ok(facts.some((f) => /started @delta/.test(f.body)), '...with an audit fact');
started.length = 0;
const idR = sign('restore', [{ room: R.id, handle: 'alpha' }, { room: R.id, handle: 'bravo' }, { room: R.id, handle: 'delta' }], 7_000_000);
const oR = await actMod.act(idR, 'restore', deps, 7_000_100);
const br = Object.fromEntries(oR.results.map((r: any) => [r.target, r]));
ok(br.bravo.status === 'done' && br.alpha.status === 'skipped' && br.delta.status === 'skipped' && /no resting session/.test(br.delta.note), 'restore: only the resting one is restored');
startFails = 'memory is nearly full';
const idF = sign('restore', [{ room: R.id, handle: 'bravo' }], 8_000_000);
const oF = await actMod.act(idF, 'restore', deps, 8_000_100);
ok(oF.results[0].status === 'skipped' && /memory is nearly full/.test(oF.results[0].note!), 'the window\'s own refusal comes back as a skipped note, not a bypass');


console.log('\n[reload: the seat\'s own Reload, never forced]');
states['recipe:rec-alpha'] = 'live'; states['recipe:rec-bravo'] = 'dehydrated';
const idRl = sign('reload', [{ room: R.id, handle: 'alpha' }, { room: R.id, handle: 'bravo' }], 9_000_000);
const oRl = await actMod.act(idRl, 'reload', deps, 9_000_100);
const brl = Object.fromEntries(oRl.results.map((r: any) => [r.target, r]));
ok(brl.alpha.status === 'done' && JSON.stringify(reloaded) === JSON.stringify([alpha.id]), 'a live seat is reloaded');
ok(brl.bravo.status === 'skipped' && /no live session/.test(brl.bravo.note), 'a resting one is skipped');
reloadFails = 'alpha is mid-turn';
const idRl2 = sign('reload', [{ room: R.id, handle: 'alpha' }], 9_100_000);
const oRl2 = await actMod.act(idRl2, 'reload', deps, 9_100_100);
ok(oRl2.results[0].status === 'skipped' && /mid-turn/.test(oRl2.results[0].note!), 'the window\'s refusal (mid-turn) is a skipped note: never forced');

console.log('\n[refusals before anything is consumed]');
const id4 = sign('pull-in', [{ room: R.id, handle: 'alpha' }], 4_000_000);
await afails(async () => await actMod.act(id4, 'pull-in', deps, 4_000_100), 'verb_not_built', 501, 'an approved verb with no handler yet is 501');
ok(so.get(id4, 4_000_200)!.state === 'approved', '...and it is NOT consumed');
await afails(async () => await actMod.act(id4, 'deliver-held', deps, 4_000_100), 'wrong_verb', 409, 'a sign-off for another verb is refused');
const idP = so.request({ verb: 'deliver-held', targets: [{ room: R.id, handle: 'alpha' }] }, ALL, 5_000_000).id;
await afails(async () => await actMod.act(idP, 'deliver-held', deps, 5_000_100), 'not_approved', 409, 'an unanswered sign-off cannot act');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
