/**
 * MODULE MANIFEST (src/server/modules/manifest.ts; ported from workbench-app test/module-manifest.test.mjs): acceptance check 1 of
 * the design notes §6 as unit tests: the tool manifest checks over fixture manifests in test/fixtures/modules, one valid and one per
 * failure. Pure.
 */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkToolManifest, checkActions, storageNameOk, type ToolPart } from '../src/server/modules/manifest.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'modules');
const manifest = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIX, name, 'module.json'), 'utf8'));
const reasonOf = (r: { ok: boolean; reason?: string }): string => (r.ok ? '' : String(r.reason));
const toolOf = (man: unknown): ToolPart => {
  const r = checkToolManifest(man);
  if (!r.ok) throw new Error('fixture refused: ' + r.reason);
  return r.tool;
};
const actionsOf = (r: ReturnType<typeof checkActions>): Array<{ contexts: string[]; timeoutMs: number }> => (r.ok ? r.actions : []);

console.log('\n[Concierge is an explicit tool context and unknown contexts remain refused]');
{
  const base = { ...manifest('valid'), contexts: ['concierge'], permissions: ['concierge.slot'] };
  ok(checkToolManifest(base).ok === true, 'concierge is accepted');
  ok(/not one of/.test(reasonOf(checkToolManifest({ ...base, contexts: ['unknown-concierge'] }))), 'unknown-concierge is refused');
}

console.log('\n[wildcard actions never acquire the Concierge context]');
{
  const tool = toolOf({ ...manifest('valid'), contexts: ['*'] });
  const action = { name: 'render', output: { kind: 'text' } };
  ok(actionsOf(checkActions({ actions: [action] }, tool))[0].contexts.includes('concierge') === false, 'the expanded list leaves concierge out');
  ok(/subset/.test(reasonOf(checkActions({ actions: [{ ...action, contexts: ['concierge'] }] }, tool))), 'an action may not claim it');
}

console.log('\n[a valid tool manifest passes, with its tool part normalized]');
{
  const r = checkToolManifest(manifest('valid'));
  ok(r.ok === true, 'valid passes');
  const tool = r.ok ? r.tool : null;
  same(tool, { provides: ['fixture.card'], role: 'viewer', accepts: ['text', 'image/*'], contexts: ['dashboard', 'agent'], actions: 'actions.json', style: 'tool.css', extends: null, exposes: ['toolbar'] }, 'the tool part');
  const a = checkActions(JSON.parse(readFileSync(join(FIX, 'valid', 'actions.json'), 'utf8')), tool!);
  ok(a.ok === true, 'its actions.json passes');
  ok(a.ok && a.actions.length === 1, 'one action');
  same(a.ok ? a.actions[0] : null, { name: 'render', title: 'Make a card', provides: 'fixture.card', input: { text: { type: 'string', title: 'Text', maxLength: 200 } }, output: { kind: 'image/svg+xml' }, contexts: ['dashboard', 'agent'], timeoutMs: 10000 }, 'the action, normalized');
}

console.log('\n[each failing fixture is skipped with its reason]');
for (const [name, want] of [
  ['missing-provides', /provides is required/],
  ['bad-id', /bad id "hellocard"/],
  ['service-set', /service is reserved/],
  ['dotdot-actions', /actions must be a path to actions.json inside the module/],
  ['bad-role', /role "editor" is not one of tasks, viewer/],
  ['bad-context', /context "sidebar" is not one of/],
] as const) {
  const r = checkToolManifest(manifest(name));
  ok(r.ok === false && want.test(r.reason), name + ': skipped with its reason');
}

console.log('\n[the smaller rules: a duplicate provides, too many, a bad accepts, a bad extends, a style with a scheme]');
{
  const base = manifest('valid');
  ok(/twice/.test(reasonOf(checkToolManifest({ ...base, provides: ['a.b', 'a.b'] }))), 'a duplicate provides');
  ok(/1 to 8/.test(reasonOf(checkToolManifest({ ...base, provides: Array.from({ length: 9 }, (_, i) => 'a.b' + i) }))), 'nine provides');
  ok(/accepts must list/.test(reasonOf(checkToolManifest({ ...base, accepts: ['image'] }))), 'a bad accepts');
  ok(/extends must be/.test(reasonOf(checkToolManifest({ ...base, extends: { tool: 'viewer.image', points: ['sidebar'] } }))), 'a bad extends');
  ok(/style must be a path/.test(reasonOf(checkToolManifest({ ...base, style: 'file:x.css' }))), 'a style with a scheme');
  ok(/contexts is required/.test(reasonOf(checkToolManifest({ ...base, contexts: [] }))), 'no contexts');
  ok(/class must be "tool"/.test(reasonOf(checkToolManifest({ ...base, class: 'workrooms' }))), 'the wrong class');
  ok(/class must be "tool"/.test(reasonOf(checkToolManifest(null))) && /class must be "tool"/.test(reasonOf(checkToolManifest([]))), 'not an object');
  const e = checkToolManifest({ ...base, extends: { tool: 'viewer.image', points: ['toolbar', 'overlay'] }, exposes: ['on-send'] });
  same(e.ok ? [e.tool.extends, e.tool.exposes] : null, [{ tool: 'viewer.image', points: ['toolbar', 'overlay'] }, ['on-send']], 'a good extends and exposes pass through');
  ok(/extends must be/.test(reasonOf(checkToolManifest({ ...base, extends: { tool: 'viewer.image', points: ['toolbar'], more: 1 } }))), 'an extends with an extra key');
  ok(/exposes must list/.test(reasonOf(checkToolManifest({ ...base, exposes: ['sidebar'] }))), 'a bad exposes');
}

console.log('\n[actions.json: names, provides, input dialect, P3 output kinds, contexts subset, timeout]');
{
  const tool = toolOf(manifest('valid'));
  const run = (actions: unknown[]) => checkActions({ actions }, tool);
  ok(/1 to 32/.test(reasonOf(run([]))), 'no actions');
  ok(/needs a name/.test(reasonOf(run([{ name: 'Render', output: { kind: 'text' } }]))), 'a name with a capital');
  ok(/listed twice/.test(reasonOf(run([{ name: 'a', output: { kind: 'text' } }, { name: 'a', output: { kind: 'text' } }]))), 'a name twice');
  ok(/does not list/.test(reasonOf(run([{ name: 'a', provides: 'other.id', output: { kind: 'text' } }]))), 'a provides the manifest does not list');
  ok(/input must be fields/.test(reasonOf(run([{ name: 'a', input: { n: { type: 'date' } }, output: { kind: 'text' } }]))), 'an input of a bad type');
  ok(/output.kind must be text, image\/svg\+xml/.test(reasonOf(run([{ name: 'a', output: { kind: 'image/png' } }]))), 'an output kind outside P3');
  ok(/subset of the manifest/.test(reasonOf(run([{ name: 'a', output: { kind: 'text' }, contexts: ['workroom'] }]))), 'a context outside the manifest');
  ok(/timeoutMs/.test(reasonOf(run([{ name: 'a', output: { kind: 'text' }, timeoutMs: 999999 }]))), 'a timeout over 120 s');
  ok(/timeoutMs/.test(reasonOf(run([{ name: 'a', output: { kind: 'text' }, timeoutMs: '5' }]))), 'a timeout that is not a number');
  ok(/1 to 32/.test(reasonOf(checkActions(null, tool))) && /1 to 32/.test(reasonOf(checkActions({ actions: 'x' }, tool))), 'actions.json that is not { actions: [...] }');
  const r = run([{ name: 'a', output: { kind: 'text' }, timeoutMs: 5000 }]);
  ok(r.ok === true, 'a good action passes');
  same(actionsOf(r)[0].contexts, ['dashboard', 'agent'], 'absent contexts = the manifest\'s');
  ok(actionsOf(r)[0].timeoutMs === 5000, 'its own timeout');
  ok(actionsOf(run([{ name: 'b', output: { kind: 'text' } }]))[0].timeoutMs === 10000, 'the default timeout is 10 s');
}

console.log('\n[storage names stay inside the module folder]');
ok(storageNameOk('count') === true, 'a plain name');
ok(storageNameOk('cards/last.svg') === false, 'a path');
ok(storageNameOk('../x') === false, 'a parent path');
ok(storageNameOk('..') === false, 'dot dot');
ok(storageNameOk('.hidden') === false, 'a leading dot');
ok(storageNameOk('a'.repeat(82)) === false, 'over 81 characters');
ok(storageNameOk(5) === false, 'not text');

console.log('\n["*" never implies "agent": an action may not claim agent under a star manifest (§1.1)]');
{
  const r = checkToolManifest({ ...manifest('valid'), contexts: ['*'] });
  ok(r.ok === true, 'a star manifest passes');
  same(r.ok ? r.tool.contexts : null, ['*'], 'its contexts stay as written');
  const tool = r.ok ? r.tool : toolOf(manifest('valid'));
  const a = checkActions({ actions: [{ name: 'render', title: 'Make a card', provides: 'fixture.card', output: { kind: 'image/svg+xml' }, contexts: ['agent'] }] }, tool);
  ok(a.ok === false, 'agent is refused');
  const b = checkActions({ actions: [{ name: 'render', title: 'Make a card', provides: 'fixture.card', output: { kind: 'image/svg+xml' }, contexts: ['dashboard'] }] }, tool);
  ok(b.ok === true, 'dashboard is fine');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
