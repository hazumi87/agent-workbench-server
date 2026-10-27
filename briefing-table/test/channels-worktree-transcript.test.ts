/**
 * THE CHANNEL RECEIPT IS READ FROM THE WORKTREE'S TRANSCRIPT (night test
 * 2026-10-06). A seat-worktree pane runs claude in the worktree, so the
 * `queue-operation/enqueue` record confirming a channel delivery is under the
 * WORKTREE's encoded project dir. Reading the project's dir found nothing, and
 * every fabric message was typed a second time 10 s later. Temp table, no server.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-chan-wt-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_CLAUDE_PROJECTS = join(dir, 'projects');
process.env.HARBOR_WB_WORKTREE_ROOT = join(dir, 'wt');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';

const { table } = await import('../src/table/endpoint.ts');
const channels = await import('../src/engine/channels.ts');
const claudeCode = await import('../src/engine/vendors/claude-code.ts');
const { worktreePath } = await import('../src/engine/worktrees.ts');

let passed = 0;
let failed = 0;
const eq = (a: unknown, b: unknown, msg: string): void => {
  if (a === b) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
};

try {
  const row = (id: string) => {
    table.upsertRecipe({
      id, name: id, target: 'local', projectDir: '/x/proj', vendor: 'claude-code', agent: id, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
    table.upsert({ paneid: `recipe:${id}`, recipe_id: id, server: 'local', vendor: 'claude-code', agent: id, session_id: `sid-${id}`, state: 'live', generation: 1 } as never);
    table.setPrefs(`recipe:${id}`, { project: '/x/proj' } as never);
  };
  row('plain');
  row('wt');
  table.setSessionWorktree({ paneid: 'recipe:wt', project: 'proj', name: 'proj-dev', branch: 'wg/proj-dev' } as never);
  eq(channels.transcriptFor('recipe:plain'), claudeCode.transcriptPath('/x/proj', 'sid-plain'), 'a plain pane: the project dir');
  eq(channels.transcriptFor('recipe:wt'), claudeCode.transcriptPath(worktreePath('proj', 'proj-dev'), 'sid-wt'), 'a seat-worktree pane: the WORKTREE dir');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: EPERM */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
