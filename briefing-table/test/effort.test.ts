/**
 * `claude --effort <level>` on a recipe, and per-launch {model, effort}
 * overrides (2026-09-28). Pure: the vocabulary, the command line the
 * claude-code vendor builds, the override precedence, and that a non-claude
 * vendor never carries the flag. The HTTP half (validation 400s, the url that
 * carries an override to the attach, a room seat's start) is
 * recipe-effort-routes.test.mjs.
 *
 * Run with tsx.
 */
import { RECIPE_EFFORTS, isRecipeEffort, applyLaunchOverrides } from '../src/engine/effort.ts';
import * as claudeCode from '../src/engine/vendors/claude-code.ts';
import * as gemini from '../src/engine/vendors/gemini-cli.ts';
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
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${msg} (got ${a}${a === b ? '' : `, wanted ${b}`})`);
}

function recipe(over: Partial<Recipe>): Recipe {
  return {
    id: 'r1', name: 'Test', target: 'local', projectDir: '/tmp/proj', vendor: 'claude-code', agent: 'test',
    runClaude: 1, model: null, effort: null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0,
    statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    created_at: 0, updated_at: 0, last_launched_at: null,
    ...over,
  } as Recipe;
}
/** The flags of a command line, the session id masked (it is minted). */
const flags = (cmd: string | undefined): string => (cmd ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>');

console.log('\n[the vocabulary]');
eq([...RECIPE_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], 'six levels, in order (claude 2.1.284: five in --help + ultracode)');
ok(RECIPE_EFFORTS.every((e) => isRecipeEffort(e)), 'every listed level is valid');
for (const bad of ['', 'HIGH', 'extreme', 'ultra', ' high', 'high; rm -rf /', null, undefined, 3, {}]) {
  ok(!isRecipeEffort(bad), `refused: ${JSON.stringify(bad)}`);
}

console.log('\n[claude-code command line, without effort]');
const plain = claudeCode.buildInvocation(recipe({ model: 'opus' }), { remote: false });
eq(flags(plain?.cmd), 'claude --model opus --session-id <uuid>', 'fresh, no effort: no --effort flag');
eq(flags(claudeCode.buildInvocation(recipe({}), { remote: false })?.cmd), 'claude --session-id <uuid>', 'no model, no effort: bare');

console.log('\n[claude-code command line, with effort — every path, next to --model]');
const r = recipe({ model: 'opus', effort: 'high' });
eq(flags(claudeCode.buildInvocation(r, { remote: false })?.cmd), 'claude --model opus --effort high --session-id <uuid>', 'fresh launch');
eq(claudeCode.buildInvocation(r, { remote: false, resumeSessionId: 'abc' })?.cmd, 'claude --model opus --effort high --resume abc', 'crash restore / picker resume (uuid)');
eq(claudeCode.buildInvocation(r, { remote: false, resumeName: 'plan' })?.cmd, 'claude --model opus --effort high --resume "plan"', 'named resume (local)');
eq(claudeCode.buildInvocation(r, { remote: true, resumeName: 'plan' })?.cmd, "claude --model opus --effort high --resume 'plan'", 'named resume (remote)');
eq(claudeCode.buildInvocation(r, { remote: false, resumeName: '' })?.cmd, 'claude --model opus --effort high --resume', 'the interactive picker');
eq(flags(claudeCode.buildInvocation(recipe({ effort: 'ultracode' }), { remote: false })?.cmd), 'claude --effort ultracode --session-id <uuid>', 'effort with no model; ultracode passes');
eq(flags(claudeCode.buildInvocation(recipe({ effort: 'bogus' }), { remote: false })?.cmd), 'claude --session-id <uuid>', 'an unknown stored value never reaches the command line');
eq(claudeCode.buildInvocation(recipe({ runClaude: 0, vendor: 'cli-manager', effort: 'high' }), { remote: false }), null, 'a recipe that does not run claude: no invocation at all');

console.log('\n[non-claude vendors ignore it]');
const g = gemini.buildInvocation(recipe({ vendor: 'gemini-cli', runClaude: 0, model: 'pro', effort: 'max' }), { remote: false });
ok(g && !g.cmd.includes('--effort') && !g.cmd.includes('max'), `gemini-cli: no --effort (${g?.cmd})`);

console.log('\n[per-launch overrides beat the recipe, for that launch only]');
const saved = recipe({ model: 'sonnet', effort: 'low' });
const both = applyLaunchOverrides(saved, { model: 'opus', effort: 'max' });
eq([both.model, both.effort], ['opus', 'max'], 'both overridden');
eq([saved.model, saved.effort], ['sonnet', 'low'], 'the saved recipe object is untouched (a copy is returned)');
eq(flags(claudeCode.buildInvocation(both, { remote: false })?.cmd), 'claude --model opus --effort max --session-id <uuid>', 'the command line carries the overrides');
eq(claudeCode.buildInvocation(both, { remote: false, resumeSessionId: 'abc' })?.cmd, 'claude --model opus --effort max --resume abc', '...on a resume too');
const effOnly = applyLaunchOverrides(saved, { effort: 'xhigh' });
eq([effOnly.model, effOnly.effort], ['sonnet', 'xhigh'], 'effort only: the recipe keeps its model');
const modelOnly = applyLaunchOverrides(saved, { model: 'fable' });
eq([modelOnly.model, modelOnly.effort], ['fable', 'low'], 'model only: the recipe keeps its effort');
ok(applyLaunchOverrides(saved, {}) === saved, 'no overrides: the recipe itself');
const junk = applyLaunchOverrides(saved, { model: 'op us; rm', effort: 'extreme' });
eq([junk.model, junk.effort], ['sonnet', 'low'], 'malformed overrides are ignored, never a way to clear or inject');
const blank = applyLaunchOverrides(saved, { model: '', effort: '' });
eq([blank.model, blank.effort], ['sonnet', 'low'], 'empty overrides = the recipe default');
const onDefault = applyLaunchOverrides(recipe({}), { effort: 'medium' });
eq(flags(claudeCode.buildInvocation(onDefault, { remote: false })?.cmd), 'claude --effort medium --session-id <uuid>', 'an override on a recipe with no effort adds the flag');

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
