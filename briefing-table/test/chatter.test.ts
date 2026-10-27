/**
 * CHATTER phase 1 [chatter] (Owner 2026-10-06): the report's math (engine/chatter.ts)
 * on a temp table, the routes (server/chatter.ts: GET report, PUT quiet human-only),
 * and the quiet backstop in fabric.deliver (not typed, counted, the person's word
 * still passes). No server, no pty. Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-chatter-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_FABRIC_BATCH_MS = '30';
process.env.HARBOR_WB_NODE = 'homebase';
delete process.env.HARBOR_WB_CHANNELS;

const chatter = await import('../src/engine/chatter.ts');
const { table } = await import('../src/table/endpoint.ts');
const routes = await import('../src/server/chatter.ts');
const fabric = await import('../src/engine/fabric.ts');
const held = await import('../src/engine/fabric-held.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => {
  if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); }
};
const eq = (a: unknown, b: unknown, m: string): void => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function req(method: string, url: string, body?: unknown): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = { 'content-type': 'application/json' };
  return r;
}
async function call(method: string, url: string, body?: unknown, human = true): Promise<{ status: number; body: any; handled: boolean }> {
  const out = { status: 0, body: null as any, handled: false };
  const r = {
    writeHead(s: number) { out.status = s; },
    setHeader() {},
    end(x?: unknown) { try { out.body = JSON.parse(String(x ?? '')); } catch { out.body = null; } },
  };
  out.handled = await routes.handle(req(method, url, body), r as any, url.split('?')[0], { human, log: () => {} });
  return out;
}

const MIN = 60 * 1000;
const line = (id: number, author: string, body: string, ts: number, to_person = false, room = 'r1') => ({ id, room_id: room, room_name: room.toUpperCase(), ts, author, kind: 'chat', body, to_person });

try {
  console.log('\n[words + similarity]');
  ok(chatter.words('@user The Runner is at STEP 172, ok').has('runner') && !chatter.words('@user hi').has('user'), 'words: lowercased, @mentions dropped');
  ok(chatter.similarity(chatter.words('one two'), chatter.words('one two')) === 0, 'too short to judge is 0, never a match');
  const a = chatter.words('run five paused at the required attempt fourteen step');
  ok(chatter.similarity(a, chatter.words('Astra says: run five paused at the required attempt fourteen step, look now')) === 1, 'a re-telling that contains the original scores 1');
  eq(chatter.fabricFrames('[fabric · @alpha-d5 · ask · t:bb · id:93df] From x [fabric · @lead · msg] y'), [{ from: 'alpha-d5', id: '93df' }, { from: 'lead', id: null }], 'every typed frame in a turn, with its id when it has one');

  console.log('\n[report: pure]');
  const T0 = 1_000_000_000;
  const src = {
    lines: [
      line(1, 'user', 'please render the hand', T0),
      line(2, 'worker', '@user the revised palm is ready for your look at the back view link', T0 + 1 * MIN, true),
      line(3, 'lead', '@user Astra: the revised palm is ready for your look, back view link here', T0 + 3 * MIN, true),
      line(4, 'lead', '@user status one', T0 + 4 * MIN, true),
      line(5, 'lead', '@user status two', T0 + 5 * MIN, true),
      line(6, 'lead', '@worker HOLD confirmed, runner idle on my side until you post clear', T0 + 10 * MIN),
      line(7, 'lead', '@worker HOLD confirmed, runner idle on my side until you post clear. Full verbs', T0 + 20 * MIN),
      line(8, 'worker', '@user the revised palm is ready for your look at the back view link', T0 + 30 * MIN, true, 'r2'),
      line(9, 'lead', '@user the revised palm is ready for your look at the back view link', T0 + 40 * MIN, true, 'r2'),
    ],
    xposts: Array.from({ length: 25 }, (_, i) => ({ line_id: 6, author: 'lead', ts: T0, room_id: `x${i}` })),
    fabricTurns: [{ paneid: 'p1', slug: 'video-to-3d', ts: T0, text: '[fabric · @lead-1 · ask · t:a · id:e1] hi' }],
    events: [
      ...Array.from({ length: 7 }, (_, i) => ({ ts: T0 + i * MIN, kind: 'fabric_dm', paneid: 'p1', slug: 'video-to-3d', from_slug: 'lead-1', env_id: `e${i}` })),
      { ts: T0, kind: 'fabric_dm', paneid: 'p2', slug: 'other', from_slug: 'lead-1', env_id: 'z' },
      { ts: T0, kind: 'quiet_refused', paneid: 'p1', slug: 'video-to-3d', from_slug: 'lead-1', env_id: null },
    ],
  };
  const r = chatter.report(src, { hours: 24, quiet: ['video-to-3d'] });
  const r1 = r.rooms.find((x: any) => x.room_id === 'r1')!;
  eq([r1.person_lines, r1.to_person, r1.ratio], [1, 4, 4], 'room: 1 line from the person, 4 to the person, ratio 4');
  const kinds = (k: string) => r.findings.filter((f: any) => f.kind === k);
  ok(kinds('to_person_ratio').some((f: any) => f.room.id === 'r1' && f.value === 4 && f.threshold === 3), 'ratio 4 > 3 is a finding');
  ok(kinds('to_person_ratio').some((f: any) => f.room.id === 'r2' && f.value === 2) === false, 'r2 (2 to the person, no person line) stays under');
  const echo = kinds('echo');
  eq(echo.map((f: any) => [f.room.id, f.seat, f.value]), [['r1', 'lead', 1], ['r2', 'lead', 1]], 'echo: the lead re-telling the worker, per room, within 15 min');
  ok(echo[0].examples[0].line === 3 && echo[0].examples[0].of === 2, '...naming the line and the line it echoes');
  const lead = r.seats.find((s: any) => s.author === 'lead')!;
  eq([lead.lines, lead.to_person, lead.xpost_copies, lead.repeats], [6, 4, 25, 1], 'seat: lines, to-person lines, cross-post copies, repeats');
  ok(kinds('repeat').some((f: any) => f.seat === 'lead' && (f.examples[0] as any).line === 7 && (f.examples[0] as any).of === 6), 'repeat: line 7 says line 6 again within the hour');
  ok(kinds('xpost').some((f: any) => f.seat === 'lead' && f.value === 25 && f.threshold === 20), 'cross-posts: 25 > 20 a day');
  ok(chatter.report(src, { hours: 48 }).findings.every((f: any) => f.kind !== 'xpost'), '...the cap scales with the window (25 < 40 over 48 h)');
  const p1 = r.panes.find((p: any) => p.paneid === 'p1')!;
  eq([p1.dms, p1.max_per_hour, p1.by_sender, p1.quiet_refused], [7, 7, { 'lead-1': 7 }, 1], 'pane: the typed frame e1 is the same envelope as event e1 (counted once)');
  ok(kinds('dm_rate').some((f: any) => f.pane.paneid === 'p1' && f.value === 7 && f.threshold === 6), 'dm rate: 7 in an hour > 6');
  ok(!kinds('dm_rate').some((f: any) => f.pane.paneid === 'p2'), 'one DM is not a finding');
  eq([r.refusals, r.quiet], [{ 'video-to-3d': 1 }, ['video-to-3d']], 'refusals and the quiet list ride the report');
  ok(chatter.report(src, { hours: 24, thresholds: { dmsPerHour: 10 } }).findings.every((f: any) => f.kind !== 'dm_rate'), 'thresholds can be overridden');

  console.log('\n[report: from the table]');
  const R = table.createRoom({ name: 'Studio', alias: 'studio' }, { actor: 'user' }).result;
  table.appendLine(R.id, { kind: 'chat', body: 'hello agents', target: 'room' } as any, { actor: 'user' });
  table.appendPaneChat('pc1', 'user', '[fabric · @lead-9 · ask · t:q · id:abc] do the thing');
  table.appendPaneChat('pc1', 'user', 'a plain prompt');
  table.recordChatterEvent({ ts: Date.now(), kind: 'fabric_dm', paneid: 'pc1', slug: 'codex', from_slug: 'lead-9', env_id: 'abc' });
  let g = await call('GET', '/api/chatter?hours=1');
  eq(g.status, 200, 'GET /api/chatter answers');
  const studio = g.body.rooms.find((x: any) => x.room_id === R.id);
  eq(studio?.person_lines, 1, 'the person line is counted from room_line');
  ok(g.body.shape && Array.isArray(g.body.shape.rooms) && Array.isArray(g.body.shape.pairs) && typeof g.body.shape.dms?.total === 'number', 'GET /api/chatter carries the shape section [shape]');
  const pc1 = g.body.panes.find((p: any) => p.paneid === 'pc1');
  eq([pc1?.dms, pc1?.by_sender], [1, { 'lead-9': 1 }], 'pane_chat frame + routing event of one envelope = one DM');
  eq((await call('GET', '/api/chatter?hours=abc')).status, 400, 'a bad window is a 400');
  ok(!(await call('GET', '/api/other')).handled, 'other routes fall through');

  console.log('\n[quiet switch: the route]');
  let q = await call('PUT', '/api/chatter/quiet', { slug: 'Video-to-3D', quiet: true }, false);
  eq(q.status, 403, 'a bearer cannot mark an agent quiet');
  q = await call('PUT', '/api/chatter/quiet', { slug: 'Video-to-3D', quiet: 'yes' });
  eq(q.status, 400, 'quiet is a boolean');
  q = await call('PUT', '/api/chatter/quiet', { slug: 'Video-to-3D', quiet: true });
  eq([q.status, q.body.slug, q.body.list], [200, 'video-to-3d', ['video-to-3d']], 'the person marks it quiet (slug normalised)');
  eq(table.chatterQuiet(), ['video-to-3d'], '...stored');
  eq(chatter.quietMatch(table.chatterQuiet(), ['video-to-3d-d306db5d', 'video-to-3d']), 'video-to-3d', 'a pane whose agent slug is quiet is covered under its minted slug too');
  eq(chatter.quietMessage('video-to-3d'), 'video-to-3d is quiet; the person holds it', 'the refusal names the slug');

  console.log('\n[quiet switch: fabric.deliver backstop]');
  const typed: string[] = [];
  const notes: string[] = [];
  held.setSink((_p, text) => { typed.push(text); return 'queued'; });
  fabric.setDeliveryDeps({
    livePaneFor: (slug) => (slug === 'video-to-3d' ? 'p-v' : null),
    toViewers: () => 0,
    startedAt: () => null,
    quietFor: (to) => chatter.quietMatch(table.chatterQuiet(), [to]),
    noteChatter: (kind, paneid, slug, env) => notes.push(`${kind}:${paneid}:${slug}:${env.from}`),
    log: () => {},
  });
  const env = (id: string, extra: Record<string, unknown> = {}) =>
    fabric.validate({ id, ts: '2026-10-06T10:00:00Z', from: 'lead-1', to: 'video-to-3d', kind: 'ask', class: 'info', attention: 'notice', thread: 't', body: 'b', ack: 'none', delivery: 'restore', ...extra });
  const v = env('q1');
  ok(v.ok, 'envelope validates');
  const d = fabric.deliver((v as any).envelope);
  ok(d.ok && (d as any).paneid === 'p-v', 'a DM to a quiet agent still reaches the badge');
  const byUser = env('q2', { authorised_by: 'user' });
  eq((byUser as any).envelope.authorised_by, 'user', 'authorised_by survives validation');
  fabric.deliver((byUser as any).envelope);
  fabric.deliver((env('q3', { from: 'user' }) as any).envelope);
  eq((env('q4', { authorised_by: 'boss' }) as any).envelope.authorised_by, undefined, 'an unknown authorised_by is dropped');
  table.setChatterQuiet('video-to-3d', false);
  fabric.deliver((env('q5') as any).envelope);
  await sleep(150);
  eq(notes, ['quiet_refused:p-v:video-to-3d:lead-1', 'quiet_refused:p-v:video-to-3d:lead-1', 'fabric_dm:p-v:video-to-3d:user', 'fabric_dm:p-v:video-to-3d:lead-1'], 'quiet: refused and counted, a claimed authorised_by too; from the person: passes; unquieted: passes');
  ok(!typed.join(' ').includes('id:q1') && !typed.join(' ').includes('id:q2') && typed.join(' ').includes('id:q3') && typed.join(' ').includes('id:q5'), 'the quiet DMs are never typed; the person\'s and the unquieted one are');
  held.setSink(null);
  held.reset();
  fabric.setDeliveryDeps(null);

  console.log('\n[phase 2: isAckOnly, tuned on sample lines]');
  const refuse = [
    'Ack.',
    'Received',
    '@helper-three Confirmed.',
    '@user Understood, thanks!',
    'Noted, will do.',
    'Got it.',
    'ok',
    'Thank you @helper-one, received.',
    'ack r15-round-77jse', // a test-round ack
    "@user Understood. I'm standing down on builds until the lead messages me.", // an ack + a 9-word status
  ];
  for (const t of refuse) ok(chatter.isAckOnly(t), `refused: ${JSON.stringify(t)}`);
  const pass = [
    // lines that open with an ack and carry a report
    'Ack. Noted the faster fill/padding routine, your reported 2e-7 maximum difference, and the fresh-stack rerun route for the earlier timeout.',
    '@helper-one Received build 41, taking the runner for the import step then export proofs. Will clear it before your smoke run.',
    '@helper-one Received build 42 and RUNNER YOURS. Taking runner now: the attachment pass with the same settings plus the closed variant, then both end views and the per-layer proof.',
    '@helper-two got it: Windows run on the release build starting now. Verdict on this same thread.', // a 15-token report: passes
    '@helper-one CLEAR. No operator batch is running or queued; no hold is needed.', // not an ack word first
    '@other-builder HOLD confirmed, runner idle on my side until you post clear.', // "confirmed" not first
    'okra is not ok', // a word that merely starts like one
    'Acknowledgement of the bug: the typer drops the hint on truncated lines; fix in 4a1b2c3.',
    'Seated, nothing read, ready for a brief.',
  ];
  for (const t of pass) ok(!chatter.isAckOnly(t), `passes: ${JSON.stringify(t.slice(0, 60))}`);
  ok(/fabric_ack/.test(chatter.ACK_ONLY_MESSAGE), 'the refusal names fabric_ack');
  {
    const prev = process.env.HARBOR_WB_HOSTED;
    process.env.HARBOR_WB_HOSTED = '1';
    ok(!/fabric_ack/.test(chatter.ackOnlyMessage()) && /Post only when you have news/.test(chatter.ackOnlyMessage()), 'hosted (no fabric): the refusal does not name a tool the seat lacks');
    if (prev === undefined) delete process.env.HARBOR_WB_HOSTED; else process.env.HARBOR_WB_HOSTED = prev;
    { const pf = process.env.HARBOR_WB_ROOM_FABRIC; process.env.HARBOR_WB_ROOM_FABRIC = '1'; ok(/fabric_ack/.test(chatter.ackOnlyMessage()), 'with a fabric: it still names fabric_ack'); if (pf === undefined) delete process.env.HARBOR_WB_ROOM_FABRIC; else process.env.HARBOR_WB_ROOM_FABRIC = pf; }
  }

  console.log('\n[phase 2: echoOf, repeatOf, budget]');
  const earlier = [
    { id: 10, body: '@user the revised palm is ready for your look at the back view link' },
    { id: 11, body: '@user something else entirely about the kilt strips and buckles' },
  ];
  eq(chatter.echoOf('@user Astra: the revised palm is ready for your look, back view link here', earlier)?.id, 10, 'echo: names the line it re-tells');
  eq(chatter.echoOf('@user status one', earlier), null, 'a short line never echoes');
  eq(chatter.repeatOf('please rebuild the hand mesh with the new cuff settings', [{ ts: 5, id: 'e1', body: 'Please rebuild the hand mesh with the new cuff settings tonight' }])?.id, 'e1', 'repeat: >= 0.8 of the same words');
  eq(chatter.repeatOf('please rebuild the hand mesh with the new cuff settings', [{ ts: 5, id: 'e1', body: 'the kilt strips need a second pass on the buckles first' }]), null, 'a different message is not a repeat');
  const saved = process.env.HARBOR_WB_DM_BUDGET_PER_HOUR;
  delete process.env.HARBOR_WB_DM_BUDGET_PER_HOUR;
  eq(chatter.dmBudgetPerHour(), 6, 'budget default 6');
  process.env.HARBOR_WB_DM_BUDGET_PER_HOUR = '3';
  eq(chatter.dmBudgetPerHour(), 3, 'budget from env');
  process.env.HARBOR_WB_DM_BUDGET_PER_HOUR = 'nope';
  eq(chatter.dmBudgetPerHour(), 6, 'a bad env value is the default');
  if (saved === undefined) delete process.env.HARBOR_WB_DM_BUDGET_PER_HOUR;
  else process.env.HARBOR_WB_DM_BUDGET_PER_HOUR = saved;

  console.log('\n[phase 2: the report counts every refusal kind]');
  const r2 = chatter.report(
    {
      lines: [],
      xposts: [],
      fabricTurns: [],
      events: [
        { ts: T0, kind: 'ack_only', paneid: 'p1', slug: 'operator', from_slug: null, env_id: null },
        { ts: T0, kind: 'ack_only', paneid: 'p1', slug: 'operator', from_slug: null, env_id: null },
        { ts: T0, kind: 'lead_echo', paneid: 'p2', slug: 'studio', from_slug: null, env_id: '5322' },
        { ts: T0, kind: 'lead_echo_confirmed', paneid: 'p2', slug: 'studio', from_slug: null, env_id: null },
        { ts: T0, kind: 'dm_budget', paneid: 'p3', slug: 'video-to-3d', from_slug: 'studio', env_id: null },
        { ts: T0, kind: 'dm_repeat', paneid: 'p3', slug: 'video-to-3d', from_slug: 'studio', env_id: 'e9' },
        { ts: T0, kind: 'dm_sent', paneid: 'p3', slug: 'video-to-3d', from_slug: 'studio', env_id: 'e8' },
      ],
    },
    { hours: 24 },
  );
  eq(r2.refused, { ack_only: { operator: 2 }, lead_echo: { studio: 1 }, dm_budget: { studio: 1 }, dm_repeat: { studio: 1 } }, 'refused: per kind, per who was refused');
  eq(r2.echo_confirms, 1, 'a used echo confirm is counted');
  eq(
    r2.findings.filter((f: any) => f.kind === 'refused').map((f: any) => [f.examples[0], f.seat, f.value]),
    [['ack_only', 'operator', 2], ['lead_echo', 'studio', 1], ['dm_budget', 'studio', 1], ['dm_repeat', 'studio', 1]],
    'each refusal is a finding',
  );
  ok(r2.findings.some((f: any) => f.kind === 'refused' && f.examples.includes('5322')), 'the echo finding names the earlier line');
  ok(r2.panes.length === 0, 'dm_sent (the send door) is not double-counted as a routed DM');
} catch (e) {
  failed++;
  console.log(`  X  threw: ${(e as Error).stack}`);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows: the store's own handle still holds the db open (EPERM); the temp dir is left behind */
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
