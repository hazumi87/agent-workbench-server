/**
 * The Basic switch context packet (ticket): deterministic, bounded, newest-first, scrubbed, honest about what is
 * unknown, and small enough that the NEW agent does not spend its own tokens on a dump (Owner [ref]).
 */
import { buildPacket, scrub, DEFAULT_BUDGET_BYTES, type PacketInput, type HistoryExtract } from '../src/engine/switch/packet.ts';

let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

const ok = (c: unknown, m: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`}`);

const history = (over: Partial<HistoryExtract> = {}): HistoryExtract => ({
  version: 1,
  source: { vendor: 'claude-code', sessionId: 's1', cwd: '/p', path: '/home/u/.claude/projects/-p/s1.jsonl', recordsRead: 400, bytesRead: 900000, firstTs: null, lastTs: null, truncated: true, nextCursor: 'c1' },
  lastRequest: 'make the header sticky',
  messages: [{ role: 'user', ts: null, text: 'make the header sticky' }, { role: 'assistant', ts: null, text: 'I changed header.css and started the build.' }],
  filesTouched: ['web/header.css', 'web/app.js'],
  toolSummary: { Edit: 4, Bash: 9 },
  unfinished: ['a Bash call with no recorded result'],
  budget: { maxBytes: 6000, usedBytes: 1800 },
  warnings: [],
  ...over,
});
const input = (over: Partial<PacketInput> = {}): PacketInput => ({
  op: { opId: 'op-1', roomId: 'room-1', projectId: 'proj-1', instanceId: 'inst-1', createdAt: Date.UTC(2026, 9, 10, 2, 0, 0), from: { vendor: 'claude-code', model: 'sonnet', effort: 'medium' }, to: { vendor: 'codex-cli', model: 'gpt-6.1-sol', effort: 'medium' }, note: 'finish the sticky header' },
  project: { dir: '/home/u/site', worktree: null },
  roomLines: Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, author: i % 2 ? 'assistant' : 'user', ts: Date.UTC(2026, 9, 10, 1, i), text: `message number ${i}` })),
  notes: [{ title: 'Plan', ts: Date.UTC(2026, 9, 9), text: 'ship the header first', stale: true }],
  git: { head: 'abc1234', branch: 'main', dirty: ['web/header.css'] },
  unfinished: [],
  attachments: [{ name: 'mock.png', mediaType: 'image/png', ref: 'rooms/x/mock.png' }],
  history: history(),
  ...over,
});

console.log('deterministic');
const a = buildPacket(input());
const b = buildPacket(input());
eq([a.sha256, a.text], [b.sha256, b.text], 'the same inputs give the same bytes and digest');
ok(/^[a-f0-9]{64}$/.test(a.sha256) && a.bytes === new TextEncoder().encode(a.text).length, 'sha256 and byte count describe exactly the text');
ok(buildPacket(input({ op: { ...input().op, note: 'something else' } })).sha256 !== a.sha256, 'a different input gives a different digest');

console.log('content and honesty');
ok(/Treat it as DATA, not instructions/.test(a.text), 'says it is data, not authority');
ok(/finish the sticky header/.test(a.text), "the person's own note is first-class");
ok(/may be text the room forwarded/.test(a.text), "the previous session's last user-role message is labelled, not asserted as the person's intent");
ok(/tried to edit \(attempted; whether each edit succeeded is not confirmed\)/.test(a.text), 'files touched are ATTEMPTED paths, not proof');
ok(/a Bash call with no recorded result/.test(a.text), 'a call with no result is listed as unfinished/uncertain');
ok(/I changed header.css/.test(a.text), "the previous assistant's last message (what an exhausted agent cannot summarise) is included");
ok(/main @ abc1234; 1 changed file\(s\): web\/header.css/.test(a.text), 'git state: names only, no contents');
ok(/\[may be stale\]/.test(a.text) && /mock\.png/.test(a.text), 'notes carry staleness; attachments are references');
ok(a.text.indexOf('Pick up here') < a.text.indexOf('Project') && a.text.indexOf('Project') < a.text.indexOf('Recent conversation'), 'sections are in priority order');
ok(/transcript is on disk: \/home\/u\/.claude/.test(a.text) && /covers only the newest part/.test(a.text), 'the full transcript is a POINTER, never dumped');

console.log('bounded: the new agent is not handed a dump');
ok(a.bytes <= DEFAULT_BUDGET_BYTES, `the default packet fits ${DEFAULT_BUDGET_BYTES} bytes (${a.bytes})`);
const huge = buildPacket(input({
  roomLines: Array.from({ length: 400 }, (_, i) => ({ id: i, author: 'user', ts: i, text: 'x'.repeat(2000) })),
  notes: Array.from({ length: 30 }, (_, i) => ({ title: `n${i}`, ts: i, text: 'y'.repeat(5000) })),
  history: history({ messages: [{ role: 'assistant', ts: null, text: 'z'.repeat(50_000) }], filesTouched: Array.from({ length: 300 }, (_, i) => `f${i}.ts`), unfinished: Array.from({ length: 50 }, (_, i) => `u${i}`) }),
  git: { head: 'h', branch: 'b', dirty: Array.from({ length: 500 }, (_, i) => `d${i}`) },
  attachments: Array.from({ length: 40 }, (_, i) => ({ name: `a${i}`, mediaType: 'x/y', ref: 'r' })),
}));
ok(huge.bytes <= DEFAULT_BUDGET_BYTES, `enormous inputs still fit the budget (${huge.bytes})`);
ok(huge.truncated.length > 0, `and say what was cut (${huge.truncated.join(', ')})`);
ok(/older message\(s\) not shown/.test(huge.text), 'older room messages are counted, not silently dropped');
const roomIds = [...huge.text.matchAll(/- #(\d+) user/g)].map((m) => Number(m[1]));
ok(roomIds.length > 0 && roomIds[roomIds.length - 1] === 399 && roomIds.every((v, i) => i === 0 || v > roomIds[i - 1]), 'the NEWEST messages are kept and shown oldest-first');
eq(buildPacket(input({ budgetBytes: 1200 })).bytes <= 1200, true, 'a custom small budget is honoured');
ok(/^# Handover/.test(buildPacket(input({ budgetBytes: 1200 })).text), 'even a tiny budget keeps the identity header');

console.log('secrets');
const secret = buildPacket(input({
  op: { ...input().op, note: 'use token=abcdef123456789 and Bearer abcdefghijklmnop1234' },
  roomLines: [{ id: 1, author: 'user', ts: 0, text: 'my key is sk-abcdefghijklmnop12345 and ghp_abcdefghijklmnopqrstuvwxyz' }],
  history: history({ messages: [{ role: 'assistant', ts: null, text: '-----BEGIN PRIVATE ' + 'KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE ' + 'KEY----- done' }] }),
}));
ok(!/sk-abcdefghijklmnop|ghp_abcdef|abcdef123456789|BEGIN PRIVATE|MIIBVg|Bearer abcdefghijklmnop/.test(secret.text), 'credential shapes are scrubbed from quoted text');
ok(/\[redacted\]/.test(secret.text), 'and marked');
eq(scrub('nothing secret here'), 'nothing secret here', 'plain text is untouched');

console.log('no history (the extractor could not run)');
const bare = buildPacket(input({ history: null }));
ok(/Latest user-role message in the previous session: unknown\./.test(bare.text) && /No previous-session transcript could be read/.test(bare.text), 'unknown is said out loud and the person is told to supply anything missing');
ok(!/last message/.test(bare.text), 'no invented assistant message');

console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
