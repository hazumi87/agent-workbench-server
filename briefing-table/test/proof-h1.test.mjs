/** H1/R4: every default launch path keeps vendor approvals; explicit ON is observable. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { register } from 'tsx/esm/api';
import { proof, recipe, root, unitDir } from './_hosting-proof.mjs';
process.env.HARBOR_WB_HOSTED = '1';
process.env.HARBOR_WB_MODE = '';
const bin = join(unitDir, 'vendor-bin'); mkdirSync(bin);
for (const name of ['codex', 'claude', 'gemini']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
process.env.PATH = bin + delimiter + process.env.PATH;
console.log('PROFILE H1 HARBOR_WB_HOSTED=1 (builders only, vendor sentinels never executed)');
const loader = register({ namespace: 'hosting-proof-h1' });
const load = path => loader.import(path, import.meta.url);
const gemini = await load('../src/engine/vendors/gemini-cli.ts');
const { buildLaunch } = await load('../src/engine/launch.ts');
const workers = await load('../src/engine/workers.ts');
const policy = existsSync(join(root, 'src/engine/auto-approve.ts')) ? await load('../src/engine/auto-approve.ts') : null;
const target = { id: 'local', label: 'Proof', kind: 'local', shell: '/bin/sh' };
function unsafe(value) {
  const s = JSON.stringify(value).replace(/[\\"']/g, '');
  return /\byolo\b|--yes\b|--dangerously-(?:skip-permissions|bypass-approvals-and-sandbox)\b|--full-auto\b|approval_policy\s*=\s*never|--permission-mode[\s,]+bypassPermissions/.test(s);
}
await proof('H1', async check => {
  policy?.setDefaultReader(() => 'off');
  for (const vendor of ['gemini-cli', 'codex-cli', 'claude-code']) {
    for (const [setting, fields] of [
      ['absent', {}], ['follow', { autoApprove: 'follow' }], ['off', { autoApprove: 'off' }],
      ['invalid boolean', { autoApprove: true }], ['invalid uppercase', { autoApprove: 'ON' }], ['legacy empty', { autoApprove: '' }],
    ]) {
      const autoApprove = setting;
      const launch = buildLaunch(recipe({ vendor, runClaude: vendor === 'claude-code' ? 1 : 0, projectDir: unitDir, ...fields }), target);
      check(!!launch?.descriptor?.binary && Array.isArray(launch.descriptor.args), `${vendor}/${autoApprove}: complete launch exists`);
      check(!unsafe(launch), `${vendor}/${autoApprove}: default-off complete launch keeps approvals`);
    }
  }
  for (const options of [{}, { resumeName: 'latest' }, { resumeSessionId: '11111111-1111-4111-8111-111111111111' }]) {
    const invocation = gemini.buildInvocation(recipe({ autoApprove: 'follow' }), { remote: false, autoApprove: 'off', ...options });
    check(!!invocation?.cmd && !unsafe(invocation), 'Gemini fresh/resume invocation keeps approvals when effective value is off');
  }
  // Only Gemini currently supports a product auto-approve mode. For the other
  // vendors, ON must still construct a real launch without inventing a flag.
  for (const vendor of ['gemini-cli', 'codex-cli', 'claude-code']) {
    const explicitOn = buildLaunch(recipe({ vendor, runClaude: vendor === 'claude-code' ? 1 : 0, autoApprove: 'on', projectDir: unitDir }), target);
    check(!!explicitOn?.descriptor?.binary && Array.isArray(explicitOn.descriptor.args), `${vendor}/on: complete invocation positive control`);
    check(vendor === 'gemini-cli' ? unsafe(explicitOn) && JSON.stringify(explicitOn).includes('yolo') : !unsafe(explicitOn),
      `${vendor}/on: supported approval-mode contract (Gemini only)`);
  }
  // Independent matcher controls: negative launch assertions must detect each
  // bypass spelling even for a vendor with no implemented product ON mode.
  for (const args of [['--approval-mode', 'yolo'], ['--dangerously-bypass-approvals-and-sandbox'],
    ['--full-auto'], ['-c', 'approval_policy="never"'], ['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions']]) {
    check(unsafe({ descriptor: { binary: '/proof/inert', args } }), `unsafe matcher rejects known bypass argv ${JSON.stringify(args)}`);
  }
  policy?.setDefaultReader(() => 'on');
  const followsOn = buildLaunch(recipe({ autoApprove: 'follow', projectDir: unitDir }), target);
  check(JSON.stringify(followsOn).includes('yolo'), 'Gemini follow inherits the chosen global ON default');
  const recipeOff = buildLaunch(recipe({ autoApprove: 'off', projectDir: unitDir }), target);
  check(!unsafe(recipeOff), 'recipe OFF overrides a global ON default');
  const absentOn = buildLaunch(recipe({ projectDir: unitDir }), target);
  check(unsafe(absentOn), 'absent recipe field follows explicitly chosen global ON (positive control)');
  for (const autoApprove of [true, 'ON']) {
    check(!unsafe(buildLaunch(recipe({ autoApprove, projectDir: unitDir }), target)), 'invalid setting never silently enables approvals even under global ON');
  }
  policy?.setDefaultReader(() => 'off');
  for (const vendor of ['gemini-cli', 'claude-code']) {
    const spec = { vendor, model: 'proof-model', cwd: unitDir, prompt: 'inert proof text', params: {},
      autoApprove: 'follow', jobId: 'proof-only', budget: { maxSeconds: 1, maxUsd: 1, maxTurns: 1 } };
    const argv = workers.vendorArgv(spec, '/proof/vendor-not-executed');
    const descriptor = workers.buildDescriptor(spec, 'proof-worker', '/proof/prompt-not-read',
      { 'gemini-cli': '/proof/gemini-not-executed', 'claude-code': '/proof/claude-not-executed' });
    check(!unsafe(argv), `${vendor}: default worker argv keeps approvals`);
    check(!unsafe(descriptor), `${vendor}: complete default worker descriptor keeps approvals`);
  }
});
await loader.unregister();
