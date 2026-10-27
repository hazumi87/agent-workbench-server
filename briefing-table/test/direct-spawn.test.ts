/**
 * HOSTED DIRECT SPAWN (security review M8): the CLI starts as binary + argv, absolute path, no typed line, no shell; lines that need a shell and shell-only recipes are refused. Pure: no engine, no port.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.HARBOR_WB_TOKEN = 'test-token-do-not-ship';
const { splitCommandLine, resolveBinary } = await import('../src/engine/argv.ts');
const { buildLaunch } = await import('../src/engine/launch.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

console.log('[splitCommandLine]');
ok(JSON.stringify(splitCommandLine(`claude --model opus --resume "my name"`)) === JSON.stringify(['claude', '--model', 'opus', '--resume', 'my name']), 'words and double quotes');
ok(JSON.stringify(splitCommandLine(`gemini --resume 'a b'`)) === JSON.stringify(['gemini', '--resume', 'a b']), 'single quotes');
for (const bad of ['claude; rm -rf x', 'claude && id', 'claude | cat', 'claude `id`', 'claude $(id)', 'claude "$HOME"', 'claude > f', 'claude "unbalanced', 'claude a\nb', 'claude ~', 'claude *', '']) {
  ok(splitCommandLine(bad) === null, `needs a shell, refused: ${JSON.stringify(bad)}`);
}
ok(resolveBinary('sh') !== null && resolveBinary('sh')!.startsWith('/'), 'a bare name resolves to an absolute path');
ok(resolveBinary('definitely-not-installed-xyz') === null && resolveBinary('../sh') === null, 'missing or relative-with-slash: null');

console.log('\n[hosted buildLaunch]');
process.env.HARBOR_WB_HOSTED = '1';
const t = { id: 'local', kind: 'local', broker: 'local', shell: undefined } as never;
const base = { id: 'r', name: 'n', target: 'local', projectDir: '/tmp', agent: 'n', vendor: 'cli-manager', runClaude: 0, model: null, resume: 0, resumeName: null, autoApprove: 'follow' };
const tryLaunch = (r: object, tt: never = t): { spec?: ReturnType<typeof buildLaunch>; code?: string } => {
  try { return { spec: buildLaunch({ ...base, ...r } as never, tt, null, null, { paneid: 'recipe:x#1' }) }; } catch (e) { return { code: (e as { code?: string }).code ?? String(e) }; }
};
const sh = tryLaunch({ initCmd: 'sh -c "exit 0"' });
ok(sh.spec && sh.spec.descriptor.binary.startsWith('/') && sh.spec.descriptor.binary.endsWith('/sh') && sh.spec.descriptor.args!.join('|') === '-c|exit 0' && sh.spec.inject === undefined, 'initCmd: absolute binary + argv, nothing typed');
ok(tryLaunch({}).code === 'no-cli', 'a bare shell recipe: refused (no shell fallback)');
ok(tryLaunch({ initCmd: 'sh; id' }).code === 'needs-shell', 'a line that needs a shell: refused');
ok(tryLaunch({ initCmd: 'nope-not-installed-xyz' }).code === 'not-found', 'a CLI that is not installed: not-found');
ok(tryLaunch({ initCmd: 'sh' }, { id: 'homebase', kind: 'ssh', sshAlias: 'x', broker: 'local' } as never).code === 'ssh-refused', 'an ssh target: refused');
{
  /* the sign-in recipe (setup-routes: vendor cli-manager, initCmd 'codex login') direct-spawns as argv: no shell, nothing typed */
  const dir = mkdtempSync(join(tmpdir(), 'wb-fakebin-'));
  writeFileSync(join(dir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  const si = tryLaunch({ id: 'signin-codex-cli', name: 'Sign in to Codex', vendor: 'cli-manager', runClaude: 0, initCmd: 'codex login' });
  ok(si.spec?.descriptor.binary === join(dir, 'codex') && JSON.stringify(si.spec?.descriptor.args) === JSON.stringify(['login']) && si.spec?.inject === undefined, 'sign-in recipe: binary codex (absolute), args [login], nothing typed, no shell');
  process.env.PATH = oldPath;
}
process.env.HARBOR_WB_PANE_ENGINE_URL = 'http://10.0.0.5:9000/';
ok(tryLaunch({ initCmd: 'sh' }).spec?.descriptor.env?.HARBOR_WB_ENGINE_URL === 'http://10.0.0.5:9000', 'hosted pane gets HARBOR_WB_ENGINE_URL from HARBOR_WB_PANE_ENGINE_URL');
delete process.env.HARBOR_WB_PANE_ENGINE_URL;
{
  const { ShareNotConfigured } = await import('../src/engine/agent-share.ts');
  process.env.HARBOR_WB_HOSTED = '1';
  ok(new ShareNotConfigured().message === 'file-store-missing', 'hosted: a missing file store is a fixed code, no variable name or operator text');
  {
    const { DirectSpawnError } = await import('../src/engine/argv.ts');
    let err: unknown = null;
    try { buildLaunch({ id: 'nf', name: 'nf', target: 'local', projectDir: '', vendor: 'claude-code', runClaude: 1, agent: 'nf' } as never, { id: 'local', label: 'Local', kind: 'local' } as never, null, null, { paneid: 'recipe:nf' }); } catch (e) { err = e; }
    ok(err instanceof DirectSpawnError && (err as { code: string }).code === 'no-folder' && (err as Error).message === 'This agent has no folder yet. Add it again with a folder.', 'hosted: a recipe with no folder is refused with the plain sentence, never started in whatever directory the broker holds');
  }
  const { shareFieldError } = await import('../src/server/rooms.ts');
  const sfe = shareFieldError(new ShareNotConfigured()) as unknown as { status: number; message: string; extra: { code?: string } };
  ok(sfe.status === 503 && sfe.extra.code === 'file-store-missing' && /File storage isn't set up/.test(sfe.message) && !/file-store-missing|HARBOR_WB|agent-share/.test(sfe.message), 'hosted: the room answer is one plain sentence (503) with the code beside it, no variable name');
  delete process.env.HARBOR_WB_HOSTED;
  ok(/HARBOR_WB_AGENT_SHARE_URL/.test(new ShareNotConfigured().message), 'not hosted: the operator sentence is unchanged');
  process.env.HARBOR_WB_HOSTED = '1';
}
delete process.env.HARBOR_WB_HOSTED;
const plain = tryLaunch({ initCmd: 'sh' });
ok(plain.spec && plain.spec.inject === 'sh', 'NOT hosted: the old typed-line launch is unchanged');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
