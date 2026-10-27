/** H2: repository hooks cannot borrow the engine's hook-trust exemption. No hook executes. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proof, recipe, scratchEngine } from './_hosting-proof.mjs';
import { WebSocket } from 'ws';
import { tsImport } from 'tsx/esm/api';
process.env.HARBOR_WB_HOSTED = '1';
console.log('PROFILE H2 HARBOR_WB_HOSTED=1 (invocation builder only)');
const { buildInvocation } = await tsImport('../src/engine/vendors/codex-cli.ts', import.meta.url);
const { mergeHooks } = await tsImport('../src/engine/codex-hooks.ts', import.meta.url);
await proof('H2', async check => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-proof-h2-'));
  mkdirSync(join(dir, '.codex'));
  try {
    // Real bypass-emitting builder control, explicitly OUTSIDE the hosted
    // product profile. No hook/vendor process executes in this diagnostic.
    const engineOnly = mergeHooks(null, 10630);
    writeFileSync(join(dir, '.codex/hooks.json'), JSON.stringify(engineOnly));
    try {
      process.env.HARBOR_WB_HOSTED = '';
      const localControl = buildInvocation(recipe({ vendor: 'codex-cli', projectDir: dir }), { remote: false });
      check(!!localControl?.cmd?.includes('--dangerously-bypass-hook-trust'), 'non-hosted engine-only hooks emit the literal bypass (matcher positive control only)');
    } finally { process.env.HARBOR_WB_HOSTED = '1'; }
    for (const hooks of [
      engineOnly,
      { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'printf foreign-hook' }] }] } },
      mergeHooks({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'printf foreign-hook' }] }] } }, 10630),
      { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'printf /api/agent-hook?; printf foreign-hook' }] }] } },
    ]) {
      writeFileSync(join(dir, '.codex/hooks.json'), JSON.stringify(hooks));
      const invocation = buildInvocation(recipe({ vendor: 'codex-cli', projectDir: dir }), { remote: false });
      check(!!invocation?.cmd, 'Codex invocation exists (positive control)');
      check(!invocation.cmd.includes('--dangerously-bypass-hook-trust'), 'hosted engine-only, foreign, mixed or forged-marker hooks retain vendor review');
      check(!/projects\.[\s\S]*trust_level\s*=\s*['"]*trusted/.test(invocation.cmd.replaceAll('\\', '')), 'hosted invocation has no forced project-trust override');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const engine = await scratchEngine(2000, { codexSentinel: true });
  try {
    for (const existing of [false, true]) {
      const project = join(engine.dir, existing ? 'existing-hooks-project' : 'no-hooks-project');
      mkdirSync(project);
      const hooksPath = join(project, '.codex/hooks.json');
      const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'printf foreign' }] }] } });
      if (existing) { mkdirSync(join(project, '.codex')); writeFileSync(hooksPath, original); }
      const id = existing ? 'h2-existing-proof' : 'h2-absent-proof';
      const saved = await engine.request('/api/recipes', { method: 'POST', value: recipe({ id, vendor: 'codex-cli', projectDir: project }) });
      check(saved.status === 200, 'real recipe API saves the isolated Codex launch (positive control)');
      if (saved.status !== 200) throw new Error('H2 recipe fixture was refused');
      const failure = await new Promise((resolve, reject) => {
        const ws = new WebSocket(engine.base.replace('http:', 'ws:') + '/pty', { headers: { cookie: engine.cookie, origin: engine.base } });
        const timer = setTimeout(() => { ws.close(); reject(new Error('H2 owned attach did not reach its broker refusal')); }, 10000);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', paneid: `recipe:${id}`, recipe: id, spawn: true })));
        ws.on('message', bytes => {
          let event; try { event = JSON.parse(bytes.toString()); } catch { return; }
          if (event.type === 'pane.error') { clearTimeout(timer); ws.close(); resolve(event.message); }
        });
        ws.on('error', error => { clearTimeout(timer); reject(error); });
      });
      // The broker is intentionally absent, so no vendor or shell can execute.
      // That refusal occurs AFTER the actual launch-preparation hook seam.
      check(typeof failure === 'string' && failure.startsWith('launch failed (' + join(engine.dir, 'vendor-bin/codex') + ')'), 'actual launch preparation reaches the dead-broker boundary without running Codex');
      check(existing ? readFileSync(hooksPath, 'utf8') === original : !existsSync(hooksPath),
        existing ? 'real hosted launch leaves foreign hook file byte-for-byte unchanged' : 'real hosted launch creates no repository hooks file');
    }
  } finally { await engine.close(); }
});
