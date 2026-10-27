/** [review-v2] W1: real typer guards with fake resident PTYs; never room bodies. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProofRing } from './fixtures/proof-room-ring.mjs';
const dir = mkdtempSync(join(tmpdir(), 'wb-doorbell-guards-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_DELIVERY = 'doorbell';
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '180';
process.env.HARBOR_WB_TYPE_ENTER_MS = '25';
process.env.HARBOR_WB_VOICE_ENTER_MS = '20';
process.env.HARBOR_WB_TYPE_SUBMIT_CHECK_MS = '10000';
delete process.env.HARBOR_WB_ROOM_TYPE;
const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const startup = await import('../src/engine/startup-gate.ts');
const gemini = await import('../src/engine/gemini-gate.ts');
const { table } = await import('../src/table/endpoint.ts');
import type { ClaudeRead } from '../src/engine/proc-classifier.ts';
let passed = 0, failed = 0, serial = 0, line = 100;
const ok = (c: unknown, m: string, d?: unknown): void => {
  if (c) { passed++; console.log(`  ok ${m}`); }
  else { failed++; console.log(`  X  ${m}${d === undefined ? '' : ` (${JSON.stringify(d)})`}`); }
};
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const owners = new Map<string, ClaudeRead>();
typer.setClaudeProbe(p => owners.get(p) ?? null);
typer.setLog(() => {});
activity.setOnChange((p, s) => typer.onActivity(p, s));
const ROOM = 'dddddddd-0000-4000-8000-0000000000d1';
const BODY = 'BODY-ONLY-7f3a $(id) `id` ; &&';
const ring = { test: (text: string): boolean => isProofRing(text, { room: ROOM }) };
const chunk = (name: string): string => JSON.parse(readFileSync(new URL(`./fixtures/gemini-gate/${name}.json`, import.meta.url), 'utf8')).chunk;
type Pane = { id: string; vendor: string; writes: string[] };
function fakePane(vendor: string, label: string): Pane {
  const id = `recipe:doorbell-guards-${label}#${++serial}`;
  table.upsert({ paneid: id, recipe_id: null, server: 'local', vendor, agent: null, session_id: null, state: 'live' });
  const writes: string[] = [];
  sessions.add(id, { state: 'live', pty: { write: (d: string) => writes.push(d) } } as never, null as never);
  activity.onLive(id);
  if (vendor === 'claude-code') {
    owners.set(id, { pid: serial + 10000, starttime: serial, startedAt: Date.now() - 60000, leader: false });
    startup.arm(id, { channel: false });
    startup.onHook(id, 'Stop');
  }
  if (vendor === 'gemini-cli') { gemini.arm(id); gemini.onPtyData(id, chunk('idle')); }
  return { id, vendor, writes };
}
function enqueue(p: Pane): number {
  const n = ++line;
  typer.enqueue(p.id, ROOM, n, `Hostile ${BODY}`, n % 2 ? 'user' : 'peer', BODY);
  return n;
}
function clean(p: Pane): void {
  typer.onPaneEnded(p.id); sessions.remove(p.id); activity.drop(p.id);
  startup.drop(p.id); gemini.drop(p.id); owners.delete(p.id);
}
function safe(p: Pane, label: string): void {
  ok(p.writes.every(w => !w.includes('BODY-ONLY') && !w.includes('$(id)') && !w.includes('`id`') && !w.includes('; &&')), `${label}: no body/name bytes`, p.writes);
  // Only the exact vendor paste envelope and separate submit key
  // are transport. Never strip arbitrary controls or accept a body-containing paste.
  const approvedWrite = (w: string): boolean => {
    if (p.vendor !== 'codex-cli') return ring.test(w) || w === '\r';
    if (w === '\t') return true;
    return w.startsWith('\x1b[200~') && w.endsWith('\x1b[201~') && ring.test(w.slice(6, -6));
  };
  ok(p.writes.every(approvedWrite), `${label}: only whitelist ring and exact vendor transport`, p.writes);
}
async function delivered(p: Pane, n: number, label: string): Promise<void> {
  await sleep(260);
  ok(p.writes.some(w => isProofRing(p.vendor === 'codex-cli' && w.startsWith('\x1b[200~') && w.endsWith('\x1b[201~') ? w.slice(6, -6) : w, { room: ROOM, latest: n })), `${label}: correlated ring delivered`, p.writes);
  ok(p.writes.some(w => w === '\r' || w === '\t'), `${label}: separate submit write observed`, p.writes);
  safe(p, label);
}
for (const vendor of ['claude-code', 'codex-cli', 'gemini-cli']) {
  console.log(`\n[${vendor}: positive control, draft, question/permission]`);
  let p = fakePane(vendor, 'positive');
  await delivered(p, enqueue(p), `${vendor} positive`); clean(p);
  p = fakePane(vendor, 'draft');
  activity.onInput(p.id, 'unfinished personal draft');
  const n = enqueue(p);
  await sleep(60);
  ok(p.writes.length === 0 && typer.heldFor(p.id)?.reason === 'draft', `${vendor}: draft holds`, p.writes);
  activity.clearDraft(p.id); typer.onActivity(p.id, 'idle');
  await sleep(220);
  await delivered(p, n, `${vendor} draft cleared`); clean(p);
  p = fakePane(vendor, 'permission');
  if (vendor === 'gemini-cli') gemini.onPtyData(p.id, chunk('dialog-proceed'));
  else activity.onQuestion(p.id);
  const q = enqueue(p);
  await sleep(60);
  ok(p.writes.length === 0 && typer.heldFor(p.id) !== null, `${vendor}: permission/question holds`, p.writes);
  if (vendor === 'gemini-cli') gemini.onPtyData(p.id, chunk('idle'));
  else activity.onResponseDone(p.id);
  typer.onActivity(p.id, 'idle');
  await delivered(p, q, `${vendor} permission resolved`); clean(p);
}
for (const vendor of ['claude-code', 'gemini-cli']) {
  console.log(`\n[${vendor}: startup, settling, awaiting-idle]`);
  let p = fakePane(vendor, 'startup');
  if (vendor === 'claude-code') startup.arm(p.id, { channel: false });
  else gemini.arm(p.id);
  const n = enqueue(p);
  await sleep(60);
  ok(p.writes.length === 0 && typer.heldFor(p.id)?.reason === 'startup', `${vendor}: startup holds`, p.writes);
  if (vendor === 'claude-code') startup.onHook(p.id, 'Stop');
  else gemini.onPtyData(p.id, chunk('idle'));
  typer.onActivity(p.id, 'idle');
  await delivered(p, n, `${vendor} startup cleared`); clean(p);
  p = fakePane(vendor, 'settling');
  activity.onData(p.id, 'small screen repaint');
  const s = enqueue(p);
  ok(p.writes.length === 0 && typer.heldFor(p.id)?.reason === 'settling', `${vendor}: fresh output holds settling`, p.writes);
  await sleep(240);
  await delivered(p, s, `${vendor} settled`); clean(p);
  p = fakePane(vendor, 'awaiting');
  activity.noteHook(p.id);
  await delivered(p, enqueue(p), `${vendor} first ring`);
  const before = p.writes.length;
  const a = enqueue(p);
  await sleep(80);
  ok(p.writes.length === before && typer.heldFor(p.id)?.reason === 'awaiting-idle', `${vendor}: second ring awaits turn completion`, p.writes);
  activity.onTurnStart(p.id); activity.onResponseDone(p.id);
  typer.onActivity(p.id, 'idle');
  await delivered(p, a, `${vendor} next turn`); clean(p);
}
console.log('\n[Codex: one queued ring; a turn start alone does not release]');
{
  const p = fakePane('codex-cli', 'one-queued');
  activity.noteHook(p.id); activity.onTurnStart(p.id); activity.onData(p.id, 'x'.repeat(800));
  await delivered(p, enqueue(p), 'Codex running first ring');
  const before = p.writes.length;
  enqueue(p); const last = enqueue(p);
  activity.onTurnStart(p.id); typer.onActivity(p.id, 'streaming');
  await sleep(80);
  ok(p.writes.length === before && typer.heldFor(p.id)?.reason === 'one-queued', 'Codex: one queued holds through turn start', p.writes);
  activity.onResponseDone(p.id);
  await delivered(p, last, 'Codex completed turn coalesces ring');
  ok(p.writes.some(w => w.includes('2 new lines, latest')), 'Codex: held lines coalesce'); clean(p);
}
console.log('\n[Claude classifier: none, not-repl and could-not-tell all hold]');
for (const classification of ['none', 'not-repl', null] as const) {
  const p = fakePane('claude-code', `classifier-${classification}`);
  owners.set(p.id, classification);
  enqueue(p); await sleep(80);
  ok(p.writes.length === 0 && typer.heldFor(p.id) !== null, `classifier ${classification}: no ring without proven owner`, p.writes);
  safe(p, `classifier ${classification}`); clean(p);
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
