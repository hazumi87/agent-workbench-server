/**
 * Where the switch packet's facts come from (ticket): git by names only, room lines + notes from the table, the vendored
 * extractor run under a hard timeout and strictly validated, and the packet file written where the target can read it
 * without polluting the user's repository.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.HARBOR_WB_TABLE = join(mkdtempSync(join(tmpdir(), 'wb-swsrc-')), 'm.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';

const { table } = await import('../src/table/endpoint.ts');
const S = await import('../src/engine/switch/packet-sources.ts');

let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

const ok = (c: unknown, m: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);
const tmp = mkdtempSync(join(tmpdir(), 'wb-swsrc-w-'));

console.log('git: names only');
{
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(repo, 'a.txt'), 'two SECRET-CONTENT');
  writeFileSync(join(repo, 'b.txt'), 'new');
  const g = await S.gatherGit(repo);
  ok(!!g && /^[0-9a-f]{7,}$/.test(g.head ?? '') && g.branch === 'main', 'head and branch');
  eq([...(g?.dirty ?? [])].sort(), ['a.txt', 'b.txt'], 'changed files by name (modified and untracked)');
  ok(!JSON.stringify(g).includes('SECRET-CONTENT'), 'never file contents');
  eq(await S.gatherGit(join(tmp, 'no-such-dir')), null, 'not a repository: null, never a throw');
}

console.log('room lines and notes come from the local table');
{
  const R = table.createRoom({ name: 'Packet room' }, { actor: 'user' }).result;
  table.appendLine(R.id, { kind: 'chat', body: 'first message', target: null, noLead: true } as any, { actor: 'user' });
  table.appendLine(R.id, { kind: 'fact', body: 'a fact line' } as any, { actor: 'user' });
  table.appendLine(R.id, { kind: 'chat', body: 'second message', target: null, noLead: true } as any, { actor: 'user' });
  const lines = S.gatherRoomLines(R.id);
  eq(lines.map((l) => l.text), ['first message', 'second message'], 'chat lines only, oldest first, facts skipped');
  ok(S.gatherNotes(R.id, Date.now()).length === 0, 'no notes: an empty list, not an error');
  ok(Array.isArray(S.gatherNotes('no-such-room', Date.now())), 'an unknown room cannot throw');
}

console.log('the extractor is untrusted: strict validation, hard timeout, any failure is null');
{
  const good = { version: 1, source: { vendor: 'claude-code', sessionId: 's', cwd: '/p', path: '/t/s.jsonl', recordsRead: 3, bytesRead: 90, firstTs: null, lastTs: null, truncated: false, nextCursor: null }, lastRequest: 'do it', messages: [{ role: 'user', ts: null, text: 'hi' }, { role: 'system', text: 'dropped' }], filesTouched: ['a.ts'], toolSummary: { Edit: 2 }, unfinished: [], budget: { maxBytes: 6000, usedBytes: 100 }, warnings: [] };
  const v = S.validateExtract(good);
  ok(!!v && v.messages.length === 1 && v.filesTouched[0] === 'a.ts', 'a well-formed extract passes, an unknown role is dropped');
  eq(S.validateExtract({ ...good, version: 2 }), null, 'a wrong version is refused');
  eq(S.validateExtract({ ...good, source: null }), null, 'no source is refused');
  eq(S.validateExtract('nope'), null, 'not an object is refused');
  const huge = S.validateExtract({ ...good, messages: Array.from({ length: 50 }, () => ({ role: 'user', text: 'x'.repeat(99999) })), filesTouched: Array.from({ length: 500 }, (_, i) => `f${i}`) });
  ok(!!huge && huge.messages.length <= 8 && huge.messages.every((m) => m.text.length <= 4000) && huge.filesTouched.length <= 30, 'oversized fields are cut down, not trusted');

  const script = join(tmp, 'extract-ok.mjs');
  writeFileSync(script, `process.stdout.write(JSON.stringify(${JSON.stringify(good)}))`);
  const r = await S.runExtractor({ script, vendor: 'claude-code', sessionId: 's', cwd: '/p' });
  ok(!!r && r.source.sessionId === 's', 'a working script is run as a child process and its JSON validated');
  const bad = join(tmp, 'extract-bad.mjs');
  writeFileSync(bad, 'process.stdout.write("not json")');
  eq(await S.runExtractor({ script: bad, vendor: 'claude-code', sessionId: 's', cwd: '/p' }), null, 'garbage output: null');
  eq(await S.runExtractor({ script: join(tmp, 'missing.mjs'), vendor: 'claude-code', sessionId: 's', cwd: '/p' }), null, 'no script yet: null (the packet is built without history)');
  const hang = join(tmp, 'extract-hang.mjs');
  writeFileSync(hang, 'setInterval(() => {}, 1000)');
  const t0 = Date.now();
  eq(await S.runExtractor({ script: hang, vendor: 'claude-code', sessionId: 's', cwd: '/p', timeoutMs: 600 }), null, 'a hung script is killed at the deadline: null');
  ok(Date.now() - t0 < 3000, 'and the deadline is honoured');
}

console.log('the VENDORED extractor: pinned, and its real output passes the engine\'s validation');
{
  const { createHash } = await import('node:crypto');
  const script = join(process.cwd(), 'scripts', 'vendor', 'history-extract.mjs');
  const digest = createHash('sha256').update(readFileSync(script)).digest('hex');
  eq(digest, '24b26a8be8fb9c7ffdb477b3def12cc9bbca6a9de36fca24d5429cd978e120cc', 'scripts/vendor/history-extract.mjs matches the pinned digest (connector b6741b2); re-pin deliberately');
  for (const [vendor, dirName, fileName, fixture] of [['claude-code', '-workspace-project', 'session-fixture.jsonl', 'claude.jsonl'], ['codex-cli', '2026/10/10', 'rollout-date-session-fixture.jsonl', 'codex.jsonl']] as const) {
    const root = join(tmp, `root-${vendor}`);
    mkdirSync(join(root, dirName), { recursive: true });
    writeFileSync(join(root, dirName, fileName), readFileSync(join('test', 'fixtures', 'history', fixture)));
    const h = await S.runExtractor({ script, vendor, sessionId: 'session-fixture', cwd: '/workspace/project', root });
    ok(!!h && h.source.vendor === vendor && h.source.sessionId === 'session-fixture' && h.messages.length > 0, `${vendor}: a real run through runExtractor validates and carries messages`);
    ok(!!h && h.lastRequest === 'Please make the header green instead.' && h.filesTouched.includes('src/home.js'), `${vendor}: last request and attempted files come through`);
  }
  const miss = await S.runExtractor({ script, vendor: 'codex-cli', sessionId: 'no-such-session', cwd: '/workspace/project', root: join(tmp, 'root-codex-cli') });
  ok(miss === null || (miss.messages.length === 0 && miss.warnings.length > 0), 'a session that does not exist yields nothing plus a warning, never a guess at the newest file');
}

console.log('the packet file');
{
  const proj = join(tmp, 'proj');
  mkdirSync(join(proj, '.git', 'info'), { recursive: true });
  const text = '# Handover\nbody\n';
  const f = S.savePacketFile(proj, 'op/../x', text);
  ok(f.path.startsWith(join(proj, '.workbench', 'handover')) && !f.path.includes('..'), 'inside the project folder, under .workbench/handover, the operation id sanitised');
  eq(readFileSync(f.path, 'utf8'), text, 'the exact bytes');
  ok(/^[a-f0-9]{64}$/.test(f.sha256), 'with its digest');
  ok(/\.workbench\//.test(readFileSync(join(proj, '.git', 'info', 'exclude'), 'utf8')), 'kept out of git through .git/info/exclude');
  S.savePacketFile(proj, 'op2', text);
  eq((readFileSync(join(proj, '.git', 'info', 'exclude'), 'utf8').match(/\.workbench\//g) ?? []).length, 1, 'idempotent: the exclude line is written once');
  const plain = join(tmp, 'not-a-repo');
  mkdirSync(plain);
  ok(existsSync(S.savePacketFile(plain, 'op3', text).path), 'a folder that is not a repository still gets the file');
}

console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
