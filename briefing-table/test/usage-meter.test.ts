/**
 * The usage meter (ticket): reading validation, never-old-as-current, credits only when the plan is used
 * up, weekly-only Codex, server hardware, and the titlebar text. No NATS (HARBOR_WB_NATS_URL=''); messages are
 * fed straight to ingest(). Run with tsx.
 */
process.env.HARBOR_WB_NATS_URL = '';
const m = await import('../src/engine/usage-meter.ts');
const ui = await import('../web/usage-meter.mjs');

let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

const ok = (c: unknown, msg: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${msg}`); if (!c) failed++; };
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);

const NOW = Date.parse('2026-10-10T01:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const reading = (over: Record<string, unknown> = {}) => JSON.stringify({
  service: 'claude', status: 'ok', capturedAt: iso(2),
  windows: [{ label: '5-hour session', usedPct: 0, resetsAt: iso(-200) }, { label: 'Weekly', usedPct: 100, resetsAt: iso(-1000) }, { label: 'Weekly (Opus)', usedPct: 59 }],
  allowance: { state: 'exhausted', exhaustedWindows: ['Weekly'], usingCredits: true, blocked: false, summary: 'x' },
  ...over,
});
const SUB = 'telemetry.app.agent-usage.claude.reading';
const claude = () => m.viewOf('claude', NOW);

console.log('validation');
m.reset();
m.ingest(SUB, 'not json', NOW);
m.ingest(SUB, JSON.stringify({ status: 'ok' }), NOW);
m.ingest(SUB, reading({ status: 'weird' }), NOW);
m.ingest(SUB, reading({ windows: [{ label: 'x', usedPct: 150 }] }), NOW);
m.ingest(SUB, reading({ service: 'chatgpt' }), NOW);
m.ingest('telemetry.app.agent-usage.evil.reading', reading(), NOW);
m.ingest(SUB, 'x'.repeat(9000), NOW);
eq(m.snapshot(NOW).counters, { accepted: 0, dropped: 7 }, 'seven bad messages dropped and counted');
eq(claude().state, 'absent', 'nothing accepted: absent');

console.log('an ok reading');
m.reset();
m.ingest(SUB, reading(), NOW);
let v = claude();
eq([v.state, v.fiveHour, v.weekly, v.hasFiveHour, v.credits, v.ageMin], ['ok', 0, 100, true, 'using', 2], 'windows matched by LABEL (Weekly, not "Weekly (Opus)"); credits shown because the plan is used up');
m.ingest(SUB, reading({ capturedAt: iso(30) }), NOW); // an older replay
eq(claude().ageMin, 2, 'an older capture never replaces a newer one');

console.log('credits only when exhausted; the three answers');
m.reset();
m.ingest(SUB, reading({ allowance: { state: 'available', usingCredits: false, blocked: false } }), NOW);
eq(claude().credits, null, 'plan not used up: no credits line');
m.reset();
m.ingest(SUB, reading({ allowance: { state: 'exhausted', usingCredits: null, blocked: null } }), NOW);
eq(claude().credits, 'unknown', 'exhausted, nothing known: "credits unknown"');
m.reset();
m.ingest(SUB, reading({ allowance: { state: 'exhausted', usingCredits: false, blocked: true } }), NOW);
eq(claude().credits, 'blocked', 'exhausted and blocked: "blocked"');

console.log('never an old number as current');
m.reset();
m.ingest(SUB, reading({ capturedAt: iso(31) }), NOW);
v = claude();
eq([v.state, v.ageMin], ['stale', 31], 'older than 25 min: stale, with its age');
ok(/31m ago/.test(ui.describe(v).text) && ui.describe(v).cls === 'stale', 'the text carries the age and the dimmed class');
m.reset();
m.ingest(SUB, reading({ status: 'auth_required', windows: [{ label: 'Weekly', usedPct: 99 }], lastGood: { capturedAt: iso(90), windows: [{ label: 'Weekly', usedPct: 80 }] } }), NOW);
v = claude();
eq([v.state, v.weekly, v.windows.length], ['auth_required', null, 0], 'a non-ok reading carries NO windows, whatever it sent');
eq(ui.describe(v).text, 'Claude · login needed', 'auth_required says login needed');
m.reset();
m.ingest(SUB, reading({ status: 'error', lastGood: { capturedAt: iso(90), windows: [{ label: 'Weekly', usedPct: 80 }] } }), NOW);
ok(ui.describe(claude()).text === 'Claude —' && /Last good reading/.test(ui.describe(claude()).title), 'error: a dash, with the last good numbers only in the tooltip, timestamped');

console.log('Codex: weekly only, greyed until its first reading');
m.reset();
eq(ui.describe(m.viewOf('chatgpt', NOW)).cls, 'absent', 'no reading yet: greyed');
m.ingest('telemetry.app.agent-usage.chatgpt.reading', JSON.stringify({ service: 'chatgpt', status: 'ok', capturedAt: iso(1), windows: [{ label: 'Weekly', usedPct: 42 }], allowance: { state: 'available' } }), NOW);
v = m.viewOf('chatgpt', NOW);
eq(ui.describe(v).text, 'Codex wk 42%', 'only a weekly window: "Codex wk 42%", never "5h -"');

console.log('server hardware');
m.reset();
eq(m.hardwareView(NOW).state, 'absent', 'no telemetry yet: absent');
eq(ui.describeHardware(m.hardwareView(NOW)).cls, 'absent', 'and greyed');
m.ingest('telemetry.hardware.cpu', JSON.stringify({ usage_pct: 28.15, load_1m: 2.18, ts: NOW }), NOW);
m.ingest('telemetry.hardware.memory', JSON.stringify({ used_pct: 37.59, used_gb: 12.6, total_gb: 33.52, ts: NOW }), NOW);
m.ingest('telemetry.hardware.temperature', JSON.stringify({ cpu_c: 76, sensors: {}, ts: NOW }), NOW);
let h = ui.describeHardware(m.hardwareView(NOW));
eq(h.text, 'server cpu 28% · mem 12.6/33.5 GB · 76°C', 'cpu, memory used/total, temperature');
ok(/Free memory: 20\.9 GB/.test(h.title) && h.cls === 'ok', 'free memory is in the tooltip (the "can I afford another session" number)');
m.ingest('telemetry.hardware.memory', JSON.stringify({ used_pct: 91, used_gb: 30.5, total_gb: 33.52 }), NOW);
eq(ui.describeHardware(m.hardwareView(NOW)).cls, 'warn', 'memory at 91%: warns');
eq(ui.describeHardware(m.hardwareView(NOW + 31_000)).cls, 'stale', 'no update for 31 s: stale');
m.ingest('telemetry.hardware.gpu', JSON.stringify({ freq_actual_mhz: 650, freq_max_mhz: 1200, usage_pct: null }), NOW);
ok(/gpu 650 MHz/.test(ui.describeHardware(m.hardwareView(NOW)).text), 'an iGPU clock shows only when the publisher sends one');
m.ingest('telemetry.hardware.cpu', 'garbage', NOW);
ok(m.snapshot(NOW).counters.dropped >= 1, 'a garbled hardware message is dropped and counted');

ok(ui.describeHardware(null).href === ui.MONITOR_URL, 'the server line links to the full monitor page');

console.log('snapshot shape');
const snap = m.snapshot(NOW);
eq(snap.services.map((s) => s.service), ['claude', 'chatgpt'], 'both services, always');
ok('hardware' in snap && 'nats' in snap, 'hardware and nats flags present');
console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
