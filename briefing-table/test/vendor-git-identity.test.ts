/**
 * COMMIT IDENTITY for non-Claude code seats [vendor git identity] Owner
 * 2026-10-05 (option a): a codex-cli / gemini-cli seat launches with
 * GIT_AUTHOR_* / GIT_COMMITTER_* = "<account> (<Brand>)" / "<account>@homeserver.local".
 * A claude seat carries none; an account that cannot be known carries none.
 */
import { buildLaunch, type Target } from '../src/engine/launch.ts';
import type { Recipe } from '../src/table/store.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}

function recipe(over: Partial<Recipe>): Recipe {
  return {
    id: 'r1',
    name: 'Test',
    target: 'local',
    projectDir: '/srv/code/thing',
    vendor: 'cli-manager',
    agent: 'thing-cli',
    runClaude: 0,
    model: null,
    resume: 0,
    resumeName: null,
    initCmd: null,
    closeOnCleanExit: 0,
    statusPath: null,
    color: null,
    fg: null,
    bg: null,
    watermark: null,
    fontSize: null,
    logo: null,
    created_at: 0,
    updated_at: 0,
    last_launched_at: null,
    ...over,
  } as Recipe;
}
const KEYS = ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL'];
const git = (env: Record<string, string> | undefined) => KEYS.map((k) => env?.[k]);
const CHATGPT: Target = { id: 'homebase-chat-ops', label: 'chatgpt', kind: 'local', broker: 'chatgpt', node: 'homebase' };
const GEMINI: Target = { id: 'homebase-gem-ops', label: 'gemini', kind: 'local', broker: 'gemini', node: 'homebase' };
const GEMINI_SSH: Target = { id: 'homebase-gemini', label: 'g', kind: 'ssh', sshAlias: 'homeserver-gem-ops', broker: 'vrpc', sshClient: true };
const CLAUDE: Target = { id: 'homebase-svc-ops', label: 'c', kind: 'ssh', sshAlias: 'homeserver-svc-ops', broker: 'homebase' };
const NONE: Target = { id: 'local', label: 'VRPC', kind: 'local', broker: 'vrpc' };
const ID = { paneid: 'recipe:abc#1' };

console.log('[codex seat]');
const cx = buildLaunch(recipe({ vendor: 'codex-cli', agent: 'x' }), CHATGPT, null, null, ID);
eq(JSON.stringify(git(cx.descriptor.env)), JSON.stringify(['chat-ops (Codex)', 'chat-ops (Codex)', 'noreply@example.com', 'noreply@example.com']), 'the four vars, account (Codex)');
console.log('[gemini seat]');
const gm = buildLaunch(recipe({ vendor: 'gemini-cli', agent: 'x' }), GEMINI, null, null, ID);
eq(JSON.stringify(git(gm.descriptor.env)), JSON.stringify(['gem-ops (Gemini)', 'gem-ops (Gemini)', 'noreply@example.com', 'noreply@example.com']), 'the four vars, account (Gemini)');
const gs = buildLaunch(recipe({ vendor: 'gemini-cli', agent: 'x' }), GEMINI_SSH, null, null, ID);
ok(gs.descriptor.args![2].includes("GIT_AUTHOR_NAME='gem-ops (Gemini)'") && gs.descriptor.args![2].includes("GIT_COMMITTER_EMAIL='noreply@example.com'"), 'an ssh launch exports them on the command line (account read off the alias)');
console.log('[claude seat]');
eq(git(buildLaunch(recipe({ vendor: 'claude-code', runClaude: 1 }), CLAUDE, null, null, ID).descriptor.env).filter((v) => v !== undefined).length, 0, 'a claude seat carries none');
console.log('[unknown account]');
eq(git(buildLaunch(recipe({ vendor: 'codex-cli' }), NONE, null, null, ID).descriptor.env).filter((v) => v !== undefined).length, 0, 'an unknown account carries none (never guessed)');
const pinned = buildLaunch(recipe({ vendor: 'codex-cli' }), { ...NONE, account: 'cdx-ops' }, null, null, ID);
eq(pinned.descriptor.env?.GIT_AUTHOR_NAME, 'cdx-ops (Codex)', 'an explicit account pin is honored');

console.log(`${String.fromCharCode(10)}PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
