/**
 * Switch assistant, the pure and near-pure parts (the design notes §3 items 2, 4, 6, 8; §4):
 * the presets and the sibling recipe, the sign-in probe's three outcomes (also run for real against fake binaries in a
 * throwaway HOME), Codex's exact-folder trust override on the sibling, the "is it ready" mapping, the Claude transcript
 * evidence, and the plain words a person reads (never a state name; "is back" only after the restore succeeded).
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const T = mkdtempSync(join(tmpdir(), 'wb-switch-sib-'));
process.env.HARBOR_WB_TABLE = join(T, 'm.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_CLAUDE_PROJECTS = join(T, 'projects');

const { PRESETS, presetOfVendor, baseIdOf, siblingId, switchTarget } = await import('../src/engine/switch/sibling.ts');
const { readStatus, probeVendor } = await import('../src/engine/switch/vendor-ready.ts');
const { notReady, progressWords, claudeTranscriptHas, isReversible } = await import('../src/engine/switch/host.ts');
const codex = await import('../src/engine/vendors/codex-cli.ts');
const { transcriptPath } = await import('../src/engine/vendors/claude-code.ts');
type Recipe = import('../src/table/store.ts').Recipe;
type SwitchRow = import('../src/table/store.ts').SwitchRow;

let failed = 0;
let checks = 0;
const ok = (c: unknown, m: string) => { checks++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);

const recipe = (over: Partial<Recipe>): Recipe => ({
  id: 'hosted-builder', name: 'Builder', target: 'local', projectDir: '/home/p/dev/code/hello', vendor: 'claude-code', agent: 'hello',
  runClaude: 1, model: 'opus', effort: 'high', vendorArgs: null, vendorFlags: null, worktree: 'auto', resume: 0, resumeName: null, initCmd: null,
  closeOnCleanExit: 0, statusPath: null, color: '#123456', fg: null, bg: null, watermark: null, fontSize: null, logo: '{"key":"hello"}',
  created_at: 1, updated_at: 1, last_launched_at: 5, ...over,
} as Recipe);

console.log('presets: exactly two, no free text');
eq(Object.keys(PRESETS), ['claude', 'codex'], 'Claude and Codex only');
eq([PRESETS.claude.vendor, PRESETS.claude.model, PRESETS.claude.effort], ['claude-code', 'sonnet', 'medium'], 'Claude: sonnet, medium');
eq([PRESETS.codex.vendor, PRESETS.codex.model, PRESETS.codex.effort], ['codex-cli', 'gpt-6.1-sol', 'medium'], 'Codex: gpt-6.1-sol, medium');
eq([presetOfVendor('claude-code'), presetOfVendor('codex-cli'), presetOfVendor('gemini-cli'), presetOfVendor('')], ['claude', 'codex', null, null], 'the current preset is read from the live vendor; anything else cannot switch');

console.log('the sibling recipe');
{
  const src = recipe({});
  const store = new Map<string, Recipe>([[src.id, src]]);
  const t = switchTarget(src, 'codex', (id) => store.get(id));
  ok(t.recipeId === 'hosted-builder--codex' && /^[A-Za-z0-9_.-]+$/.test(t.recipeId), 'deterministic id <source>--codex, inside the pane-id alphabet');
  const c = t.create!;
  ok(!!c, 'created on the first switch');
  eq([c.projectDir, c.agent, c.logo, c.color], [src.projectDir, src.agent, src.logo, src.color], 'same folder, the SAME agent slug, the source\'s logo and colour');
  eq([c.vendor, c.runClaude, c.model, c.effort, c.worktree], ['codex-cli', 0, 'gpt-6.1-sol', 'medium', 'never'], 'the target vendor with the preset, worktree never');
  ok(c.name !== 'Builder' && c.name === 'Builder (Codex)', 'its name is never exactly "Builder" (Basic resolves the Builder recipe by name)');
  ok(src.vendor === 'claude-code' && src.model === 'opus', 'the source recipe is not edited');
  store.set(c.id, c);
  const again = switchTarget(src, 'codex', (id) => store.get(id));
  ok(again.create === null && again.recipeId === c.id, 'a second switch reuses it (idempotent)');
  const back = switchTarget(c, 'claude', (id) => store.get(id));
  ok(back.recipeId === 'hosted-builder' && back.create === null, 'switching BACK targets the ORIGINAL recipe: never a third');
  eq(back.launch, { model: 'sonnet', effort: 'medium' }, 'with the preset as per-launch overrides (the original keeps its own model and effort)');
  eq([baseIdOf('x--codex'), baseIdOf('x--claude'), baseIdOf('x'), siblingId('x--codex', 'claude')], ['x', 'x', 'x', 'x--claude'], 'base and sibling ids');
  const codexFirst = recipe({ id: 'cx', vendor: 'codex-cli', runClaude: 0 });
  const t2 = switchTarget(codexFirst, 'claude', () => undefined);
  ok(t2.recipeId === 'cx--claude' && t2.create?.vendor === 'claude-code' && t2.create?.runClaude === 1, 'a Codex-first project gets a Claude sibling the same way');
}

console.log('the sibling inherits Codex\'s exact-folder trust override (an integration through the real buildInvocation)');
{
  const src = recipe({ projectDir: '/home/p/dev/code/hello world' });
  const sib = switchTarget(src, 'codex', () => undefined).create!;
  const inv = codex.buildInvocation(sib, { remote: false });
  ok(!!inv && inv.cmd.includes(`projects."/home/p/dev/code/hello world".trust_level="trusted"`), 'the launch carries projects."<that exact folder>".trust_level="trusted"');
  ok(!!inv && /--model gpt-6\.1-sol/.test(inv.cmd) && inv.cmd.includes('model_reasoning_effort="medium"'), 'and the preset model and effort');
}

console.log('sign-in, three outcomes (the status command\'s exit and words)');
eq(readStatus('codex-cli', 0, 'Logged in using ChatGPT'), { ok: true }, 'logged in = ok');
const out = readStatus('codex-cli', 1, 'Not logged in');
ok(!out.ok && out.reason === 'login-needed', 'logged out = login-needed (a hard stop before anything changes)');
const unk = readStatus('claude-code', 2, 'error: unknown command "auth"');
ok(unk.ok && !!unk.warn, 'an answer it does not recognise = could not tell: proceed with a warning, never "logged in"');
const ni = readStatus('codex-cli', 127, '');
ok(!ni.ok && ni.reason === 'not-installed', 'exit 127 = not installed in that environment');
ok(readStatus('codex-cli', 0, 'Logged in').ok && !readStatus('codex-cli', 0, 'Logged in').warn, 'exit 0 + "logged in" is the only confirmed yes');

console.log('the probe really runs, in an interactive shell whose PATH comes from its own rc file (not the engine\'s)');
{
  const home = join(T, 'home');
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, '.bashrc'), `export PATH="${bin}:$PATH"\n`);
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nif [ -e "$HOME/out" ]; then echo "Not logged in"; exit 1; fi\necho "Logged in using ChatGPT"\n');
  chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nsleep 5\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  const a = await probeVendor('codex-cli', home, { shell: 'bash', shellArgs: ['-ic'], env });
  ok(a.ok && !('warn' in a && a.warn), `logged in, found on the rc-file PATH (${JSON.stringify(a)})`);
  writeFileSync(join(home, 'out'), '1');
  const b = await probeVendor('codex-cli', home, { shell: 'bash', shellArgs: ['-ic'], env });
  ok(!b.ok && b.reason === 'login-needed', 'logged out');
  const c = await probeVendor('claude-code', home, { shell: 'bash', shellArgs: ['-ic'], env, timeoutMs: 600 });
  ok(c.ok && !!c.warn && /in time/.test(c.warn ?? ''), 'a status command that hangs = could not tell (bounded)');
  const d = await probeVendor('codex-cli', home, { shell: 'bash', shellArgs: ['-c'], env: { HOME: join(T, 'nobody'), PATH: '/usr/bin:/bin' } });
  ok(!d.ok && d.reason === 'not-installed', 'absent from that environment = not installed');
}

console.log('a target that did not reach ready: words for the wizard');
eq(notReady('codex-cli', { reason: 'needs-you', detail: 'login' }).reason, 'login-needed', 'a login screen = login-needed');
eq(notReady('codex-cli', { reason: 'needs-you', detail: 'permission' }).reason, 'trust-needed', 'the trust dialog = trust-needed');
ok(/Nothing was answered for you/.test(notReady('codex-cli', { reason: 'needs-you', detail: 'trust' }).message), 'and it says nothing was answered automatically');
eq(notReady('claude-code', { reason: 'exited', detail: 'exit code 1' }).reason, 'target-not-ready', 'anything else = did not finish starting');

console.log('Claude\'s transcript as evidence the handover was taken (read-only, user lines only)');
{
  const dir = '/home/p/dev/code/hello';
  const sid = '11111111-2222-4333-8444-555555555555';
  const p = transcriptPath(dir, sid);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, `${JSON.stringify({ type: 'assistant', message: { content: 'Handover swX: noted' } })}\n${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n{"type":"user","message":{"content":"Handover swY: yo`);
  ok(!claudeTranscriptHas(dir, sid, 'Handover swX:'), 'an assistant line quoting it is not evidence');
  ok(!claudeTranscriptHas(dir, sid, 'Handover swY:'), 'a torn last line is not evidence');
  writeFileSync(p, `\n${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Handover swZ: your previous assistant…' } })}\n`, { flag: 'a' });
  ok(claudeTranscriptHas(dir, sid, 'Handover swZ:'), 'a user line holding it is');
  ok(!claudeTranscriptHas(dir, 'no-such-session', 'Handover swZ:'), 'no transcript, no evidence');
}

console.log('plain words: never a state name; "is back" only once the restore succeeded');
{
  const row = (over: Partial<SwitchRow>): SwitchRow => ({ op_id: 'sw1', room_id: 'r', from_vendor: 'claude-code', to_vendor: 'codex-cli', to_model: 'gpt-6.1-sol', to_effort: 'medium', state: 'intent', error: null, recovery: null, revision: 1 } as unknown as SwitchRow);
  const states = ['intent', 'packet-saved', 'fenced', 'target-identified', 'banked', 'context-delivered', 'context-accepted', 'lead-committed', 'done', 'cancelled', 'failed-before-transfer', 'failed-after-transfer'];
  const all = states.map((s) => progressWords({ ...row({}), state: s } as SwitchRow).words);
  ok(all.every((w) => !states.some((s) => s.includes('-') && w.includes(s))), 'no word is a state name');
  eq([all[0], all[2], all[3]], ['Saving where you are…', 'Starting Codex…', 'Handing over…'], 'Saving where you are… / Starting Codex… / Handing over…');
  eq(progressWords({ ...row({}), state: 'done' } as SwitchRow).words, 'Codex is ready', 'Codex is ready');
  const pending = progressWords({ ...row({}), state: 'failed-before-transfer', error: 'trust-needed: Codex is asking', recovery: 'pending' } as SwitchRow).words;
  ok(/Recovery pending/.test(pending) && !/is back/.test(pending), `restore not done: "recovery pending", never "is back" ("${pending}")`);
  const restored = progressWords({ ...row({}), state: 'failed-before-transfer', error: 'trust-needed: Codex is asking', recovery: 'restored' } as SwitchRow).words;
  ok(/Codex is asking\. Claude \(your previous assistant\) is back\./.test(restored), `restored: "${restored}"`);
  const waiting = progressWords({ ...row({}), state: 'context-delivered' } as SwitchRow);
  ok(waiting.canContinue && waiting.canCancel, 'an unconfirmed handover offers Continue anyway and Cancel');
  ok(!progressWords({ ...row({}), state: 'lead-committed' } as SwitchRow).canCancel && !isReversible('lead-committed') && isReversible('context-accepted'), 'after the transfer there is no Cancel');
}

console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
