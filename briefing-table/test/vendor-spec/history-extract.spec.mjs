import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractHistory } from '../../scripts/vendor/history-extract.mjs';

const session = 'session-fixture', cwd = '/workspace/project';
async function fixture(t, vendor = 'codex-cli', raw) {
  const root = await mkdtemp(join(tmpdir(), 'history-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = vendor === 'claude-code' ? join(root, '-workspace-project') : join(root, '2026', '10', '10');
  await mkdir(dir, { recursive: true });
  const file = join(dir, vendor === 'claude-code' ? `${session}.jsonl` : `rollout-date-${session}.jsonl`);
  const text = raw ?? await readFile(new URL(`../fixtures/history/${vendor === 'claude-code' ? 'claude' : 'codex'}.jsonl`, import.meta.url), 'utf8');
  await writeFile(file, text);
  return { root, file, text, options: { vendor, session, cwd, root } };
}
const jl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const meta = { type: 'session_meta', payload: { id: session, cwd } };
const message = (n, role = 'user', text = `message ${n}`) => ({ type: 'response_item', timestamp: '2026-10-10T02:00:00Z',
  payload: { id: `m${n}`, type: 'message', role, content: [{ type: 'input_text', text }] } });

for (const vendor of ['codex-cli', 'claude-code']) {
  test(`history fallback: ${vendor}, no summary/model/tool output needed`, async t => {
    const f = await fixture(t, vendor); const out = await extractHistory(f.options);
    assert.equal(out.lastRequest, 'Please make the header green instead.');
    assert.deepEqual(out.filesTouched, ['src/home.js']);
    assert.equal(out.toolSummary.Bash, 1);
    assert.ok(out.unfinished.some(x => x.kind === 'tool-outcome-unknown' && x.tool === 'Bash'));
    assert.ok(out.unfinished.some(x => x.kind === 'plan'));
    const serialized = JSON.stringify(out);
    for (const hidden of ['PRIVATE', 'SECRET', 'sk-abcdefghijklmno', 'DUPLICATE EVENT']) assert.equal(serialized.includes(hidden), false);
    assert.equal(out.budget.usedBytes, Buffer.byteLength(serialized) + 1);
    assert.ok(out.budget.usedBytes <= 6000);
    assert.equal(await readFile(f.file, 'utf8'), f.text);
  });
}

test('exact session and cwd mismatch return empty context, never newest file', async t => {
  const f = await fixture(t);
  for (const patch of [{ session: 'different' }, { cwd: '/workspace/other' }]) {
    const out = await extractHistory({ ...f.options, file: f.file, ...patch });
    assert.equal(out.lastRequest, null); assert.deepEqual(out.messages, []);
    assert.ok(out.warnings.includes(patch.session ? 'session-mismatch' : 'cwd-mismatch'));
  }
});

test('duplicate exact Codex filenames are ambiguous; explicit scoped file resolves them', async t => {
  const f = await fixture(t); await writeFile(join(f.root, `${session}.jsonl`), f.text);
  assert.deepEqual((await extractHistory(f.options)).warnings, ['session-ambiguous']);
  assert.ok((await extractHistory({ ...f.options, file: f.file })).messages.length);
});

test('explicit symlink escape and missing source do not leak content', async t => {
  const f = await fixture(t); const other = await fixture(t);
  const link = join(f.root, 'link.jsonl'); await symlink(other.file, link);
  assert.deepEqual((await extractHistory({ ...f.options, file: link })).warnings, ['path-outside-root']);
  assert.deepEqual((await extractHistory({ ...f.options, session: 'absent' })).warnings, ['session-not-found']);
});

test('UTF-8 and all serialized metadata respect small output budgets', async t => {
  const rows = [meta, ...Array.from({ length: 25 }, (_, n) => message(n, n % 2 ? 'assistant' : 'user', `message ${n} ` + '🌿你好'.repeat(900)))];
  const f = await fixture(t, 'codex-cli', jl(rows));
  for (const maxBytes of [1024, 2000, 6000]) {
    const out = await extractHistory({ ...f.options, maxBytes });
    assert.ok(Buffer.byteLength(JSON.stringify(out)) + 1 <= maxBytes);
    assert.equal(out.budget.usedBytes, Buffer.byteLength(JSON.stringify(out)) + 1);
    assert.equal(JSON.stringify(out).includes('�'), false);
    assert.equal(out.source.truncated, true);
  }
});

test('bounded pages walk recognized messages without gaps, including assistant bursts', async t => {
  const f = await fixture(t, 'codex-cli', jl([meta, ...Array.from({ length: 25 }, (_, n) => message(n, n < 2 ? 'user' : 'assistant'))]));
  const seen = new Set(); let page;
  for (let i = 0; i < 30; i++) {
    const out = await extractHistory({ ...f.options, page });
    for (const m of out.messages) { assert.equal(seen.has(m.history.recordId), false); seen.add(m.history.recordId); }
    page = out.source.nextCursor; if (!page) break;
  }
  assert.equal(seen.size, 25);
});

test('cursor is bound to file snapshot and source scope', async t => {
  const f = await fixture(t, 'codex-cli', jl([meta, ...Array.from({ length: 8 }, (_, n) => message(n))]));
  const first = await extractHistory(f.options); assert.ok(first.source.nextCursor);
  assert.deepEqual((await extractHistory({ ...f.options, cwd: '/wrong', page: first.source.nextCursor })).warnings, ['cursor-stale']);
  await appendFile(f.file, jl([message(9)]));
  assert.deepEqual((await extractHistory({ ...f.options, page: first.source.nextCursor })).warnings, ['cursor-stale']);
});

test('torn/malformed lines are excluded and scan I/O stays bounded', async t => {
  const padding = JSON.stringify({ type: 'tool-noise', text: 'x'.repeat(3 * 1024 * 1024) }) + '\n';
  const f = await fixture(t, 'codex-cli', jl([meta]) + padding + 'bad json\n' + jl([message(1)]) + '{"partial":');
  const out = await extractHistory(f.options);
  assert.equal(out.lastRequest, 'message 1');
  assert.ok(out.source.bytesRead <= 2 * 1024 * 1024 + 256 * 1024);
  assert.ok(out.warnings.includes('malformed-record-skipped'));
  assert.ok(out.warnings.includes('partial-record-skipped'));
});

test('Claude follows the active parent chain and excludes abandoned branches', async t => {
  const row = (uuid, parentUuid, text) => ({ type: 'user', uuid, parentUuid, sessionId: session, cwd,
    message: { content: text } });
  const rows = [row('u1', null, 'root'), row('old', 'u1', 'ABANDONED'), row('u2', 'u1', 'chosen'),
    ...Array.from({ length: 7 }, (_, n) => row(`new${n}`, n ? `new${n - 1}` : 'u2', `chosen ${n}`))];
  const f = await fixture(t, 'claude-code', jl(rows)); let page; const text = [];
  for (let i = 0; i < 10; i++) {
    const out = await extractHistory({ ...f.options, page }); text.push(...out.messages.map(m => m.text));
    page = out.source.nextCursor; if (!page) break;
  }
  assert.equal(text.includes('ABANDONED'), false); assert.equal(text.length, 9);
});

test('no trusted identity metadata yields empty content', async t => {
  const f = await fixture(t, 'codex-cli', jl([message(1)]));
  const out = await extractHistory(f.options);
  assert.deepEqual(out.messages, []); assert.deepEqual(out.warnings, ['identity-unverified']);
});

test('CLI is standalone JSON with no stdout diagnostics', async t => {
  const f = await fixture(t);
  const stdout = execFileSync(process.execPath, ['scripts/vendor/history-extract.mjs', '--vendor', f.options.vendor,
    '--session', session, '--cwd', cwd, '--root', f.root, '--max-bytes', '6000'], { encoding: 'utf8' });
  const out = JSON.parse(stdout); assert.equal(out.version, 1); assert.ok(out.messages.length);
  assert.equal(Buffer.byteLength(stdout), out.budget.usedBytes);
});
