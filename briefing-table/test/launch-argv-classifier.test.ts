/**
 * The REAL argv the engine builds, run through the engine's OWN argv classifier (proc-classifier interactive()). The 2026-10-27 real-seat run found that
 * `--allowedTools t1 t2 t3` (space separated) makes t2 and t3 bare words: interactive() said false, claudeOwner() said "not-repl", and every ring was held for ever. The suite was
 * green because its fake claudes never carried a multi-tool --allowedTools. This test builds each argv shape from the launch code itself, so a variadic flag written the same way
 * again fails here.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-argvcls-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local' }] });
writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 0\n');
chmodSync(join(dir, 'claude'), 0o755);
writeFileSync(join(dir, 'codex'), '#!/bin/sh\nexit 0\n');
chmodSync(join(dir, 'codex'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { buildLaunch, loadTargets } = await import('../src/engine/launch.ts');
const { splitCommandLine } = await import('../src/engine/argv.ts');
const { interactive } = await import('../src/engine/proc-classifier.ts');
const bl = await import('../src/engine/bt-launch.ts');
const { TOOL_NAMES } = await import('../src/server/bt-mcp.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };

const target: any = loadTargets().find((t) => t.id === 'local');
const recipe = (vendor: string): any => ({ id: 'c1', name: 'c1', target: 'local', projectDir: join(dir, 'proj'), vendor, agent: 'c1', runClaude: vendor === 'claude-code' ? 1 : 0, model: 'opus', resume: 0, resumeName: null,
  initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null, effort: null, vendorArgs: null, vendorFlags: null, worktree: null });
const base = { enabled: true, vendor: 'claude-code', runsHere: true, port: 51234, paneid: 'recipe:c1', tokenFile: join(dir, 'mcp', 'c1.token'), dir: join(dir, 'mcp') };
const RESUME = '11111111-2222-3333-4444-555555555555';

/** the classifier's verdict on a typed line (the part from `claude`) */
const typedVerdict = (line: string | undefined): boolean => {
  const argv = splitCommandLine(line ?? '');
  return !!argv && argv[0] === 'claude' && interactive(argv);
};
/** and on a hosted direct-spawn descriptor */
const directVerdict = (spec: { descriptor: { binary: string; args?: string[] } }): boolean => interactive([spec.descriptor.binary, ...(spec.descriptor.args ?? [])]);

console.log('[negative control: the old space-separated shape is NOT the REPL to the classifier]');
ok(interactive(['claude', '--allowedTools', 'mcp__bt__a', 'mcp__bt__b']) === false, 'space-separated --allowedTools: classifier says not-repl (this is the bug)');
ok(interactive(['claude', '--allowedTools', 'mcp__bt__a,mcp__bt__b']) === true, 'one comma-joined value: the REPL');

console.log('\n[typed lines (local, non-hosted)]');
ok(typedVerdict(buildLaunch(recipe('claude-code'), target, null, null, { paneid: 'recipe:c1' }).inject), 'claude, no bt');
ok(typedVerdict(buildLaunch(recipe('claude-code'), target, RESUME, null, { paneid: 'recipe:c1' }).inject), 'claude, restore (--resume)');
const file = bl.writeBtConfig(bl.planBt({ ...base }) as any);
ok(/--allowedTools mcp__bt__\S+,mcp__bt__\S+/.test(file.claudeArgs) && !/--allowedTools \S+ mcp__bt__/.test(file.claudeArgs), 'bt file mode: ONE comma-joined tools value');
ok(typedVerdict(buildLaunch(recipe('claude-code'), target, null, null, { paneid: 'recipe:c1', extraArgs: file.claudeArgs }).inject), 'claude + bt (file config)');
const withRole = `${file.claudeArgs} ${bl.claudeRoleArgs(join(dir, 'mcp', 'c1.role.md'))}`;
ok(typedVerdict(buildLaunch(recipe('claude-code'), target, null, null, { paneid: 'recipe:c1', extraArgs: withRole }).inject), 'claude + bt + role file (--append-system-prompt-file)');
const envMode = bl.writeBtConfig(bl.planBt({ ...base, tokenInEnv: true }) as any);
ok(typedVerdict(buildLaunch(recipe('claude-code'), target, null, null, { paneid: 'recipe:c1', extraArgs: envMode.claudeArgs }).inject), 'claude + bt (inline config, token in env)');
// the channel pane: bt merged INTO the channel config, its tools continue the channel's --allowedTools value
mkdirSync(join(dir, 'mcp'), { recursive: true });
writeFileSync(join(dir, 'mcp', 'chan.json'), JSON.stringify({ mcpServers: { fabric: { type: 'stdio', command: 'x' } } }));
const merged = bl.writeBtConfig(bl.planBt({ ...base }) as any, { mergeInto: join(dir, 'mcp', 'chan.json') });
const chanLine = buildLaunch(recipe('claude-code'), target, null, null, { paneid: 'recipe:c1', channelConfig: join(dir, 'mcp', 'chan.json'), extraArgs: `${merged.claudeArgs} ${bl.claudeRoleArgs(join(dir, 'mcp', 'c1.role.md'))}` }).inject;
ok(typedVerdict(chanLine), 'claude + channel + bt merged + role file');
ok(/--allowedTools mcp__fabric,mcp__bt__\S+/.test(chanLine ?? '') && (chanLine!.match(/--allowedTools/g) ?? []).length === 1, '...the channel pane has ONE --allowedTools whose value is one comma-joined word');

console.log('\n[hosted direct spawn (argv, no shell)]');
process.env.HARBOR_WB_HOSTED = '1';
try {
  ok(directVerdict(buildLaunch(recipe('claude-code'), target, null, null, { paneid: 'recipe:c1' }) as any), 'hosted claude, no bt');
  ok(directVerdict(buildLaunch(recipe('claude-code'), target, RESUME, null, { paneid: 'recipe:c1' }) as any), 'hosted claude, restore');
  ok(directVerdict(buildLaunch(recipe('claude-code'), target, null, null, { paneid: 'recipe:c1', extraArgs: file.claudeArgs }) as any), 'hosted claude + bt (file config)');
  ok(directVerdict(buildLaunch(recipe('claude-code'), target, null, null, { paneid: 'recipe:c1', extraArgs: envMode.claudeArgs }) as any), 'hosted claude + bt (inline config, token in env)');
  ok(directVerdict(buildLaunch(recipe('claude-code'), target, RESUME, null, { paneid: 'recipe:c1', extraArgs: envMode.claudeArgs }) as any), 'hosted claude + bt, restore');
  const cx = buildLaunch(recipe('codex-cli'), target, null, null, { paneid: 'recipe:c1', extraArgs: bl.writeBtConfig(bl.planBt({ ...base, vendor: 'codex-cli' }) as any).codexArgs }) as any;
  const cxArgs: string[] = cx.descriptor.args ?? [];
  ok(!cxArgs.includes('--allowedTools') && cxArgs.filter((a) => a === '-c').length >= 3, 'hosted codex: no variadic --allowedTools; its bt config rides -c pairs');
  const cxValues = cxArgs.filter((a, i) => cxArgs[i - 1] === '-c');
  ok(cxValues.length >= 3 && cxValues.every((a) => /^[a-z_.]+=/.test(a)), 'hosted codex bt argv is clean -c key=value pairs (each -c has exactly one value)');
} finally {
  delete process.env.HARBOR_WB_HOSTED;
}

console.log('\n[no other variadic flag is emitted by the launch code]');
const VARIADIC = ['--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--add-dir', '--mcp-config', '--betas', '--plugin-dir'];
const lines = [
  buildLaunch(recipe('claude-code'), target, null, null, { paneid: 'recipe:c1', extraArgs: withRole }).inject,
  chanLine,
] as string[];
for (const l of lines) {
  const argv = splitCommandLine(l) ?? [];
  const bad: string[] = [];
  argv.forEach((a, i) => { if (VARIADIC.includes(a) && argv[i + 2] !== undefined && !argv[i + 2].startsWith('-')) bad.push(`${a} has a second bare word "${argv[i + 2]}"`); });
  ok(bad.length === 0, `every variadic flag in the line has exactly one value word${bad.length ? ': ' + bad.join('; ') : ''}`);
}
ok(TOOL_NAMES.length >= 5, 'the tools list is non-trivial (the test is not vacuous)');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);

