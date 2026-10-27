/**
 * WHICH PANE A FABRIC ADDRESS MEANS (src/engine/slug-route.ts; night order 2026-10-25, coordination [ref] item 2). The pure
 * rule, then fabric.deliver wired to it: a bare slug shared by several live panes goes to the recipe's primary pane when
 * exactly one is, else it is refused as ambiguous, naming each pane's minted slug; nothing is picked silently.
 * Run with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'wb-slug-route-'));
process.env.HARBOR_WB_TABLE = join(tmp, 'mapping.db');
delete process.env.HARBOR_WB_CHANNELS;

const { routeSlug } = await import('../src/engine/slug-route.ts');
const fabric = await import('../src/engine/fabric.ts');

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string, got?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`);
  }
}
const row = (paneid: string, agent: string | null, state = 'live', recipe = 'R1') => ({ paneid, recipe_id: recipe, agent, state });
const minted: Record<string, string> = { 'recipe:R1#a': 'builder-one-aaaa1111', 'recipe:R1#b': 'builder-one-bbbb2222' };
const mintedOf = (p: string) => minted[p] ?? null;

console.log('\n[the rule]');
ok(JSON.stringify(routeSlug('x', { exact: 'recipe:E#1', rows: [], mintedOf })) === '{"pane":"recipe:E#1"}', 'a minted slug (the exact match) wins and is never ambiguous');
ok(routeSlug('builder-one', { exact: null, rows: [], mintedOf }) === null, 'nobody holds the slug: null');
ok(routeSlug('builder-one', { exact: null, rows: [row('recipe:R1#a', 'builder-one', 'dehydrated')], mintedOf }) === null, 'a pane that is not live does not count');
ok(JSON.stringify(routeSlug('builder-one', { exact: null, rows: [row('recipe:R1#a', 'builder-one'), row('recipe:Z#a', 'other')], mintedOf })) === '{"pane":"recipe:R1#a"}', 'one live pane holds it: that pane (other agents ignored)');
{
  const r = routeSlug('builder-one', { exact: null, rows: [row('recipe:R1#a', 'builder-one'), row('recipe:R1', 'builder-one'), row('recipe:R1#b', 'builder-one')], mintedOf });
  ok(JSON.stringify(r) === '{"pane":"recipe:R1"}', 'several live panes and exactly one is the recipe primary: the primary', r);
}
{
  const r = routeSlug('builder-one', { exact: null, rows: [row('recipe:R1#a', 'builder-one'), row('recipe:R1#b', 'builder-one')], mintedOf });
  ok(r !== null && 'ambiguous' in r && r.ambiguous.join(',') === 'builder-one-aaaa1111,builder-one-bbbb2222', 'several live panes, no primary: AMBIGUOUS, naming each pane\'s minted slug, in table order', r);
}
{
  const r = routeSlug('builder-one', { exact: null, rows: [row('recipe:R1#a', 'builder-one'), row('recipe:R1#zz', 'builder-one')], mintedOf });
  ok(r !== null && 'ambiguous' in r && r.ambiguous[1] === 'recipe:R1#zz', 'a pane that has not checked in is named by its paneid');
}
{
  const r = routeSlug('builder-one', { exact: null, rows: [row('recipe:R1', 'builder-one', 'live', 'R1'), row('recipe:R2', 'builder-one', 'live', 'R2')], mintedOf });
  ok(r !== null && 'ambiguous' in r, 'two primaries (two recipes share a slug): still ambiguous, never a guess');
}
ok(routeSlug('builder-one', { exact: null, rows: [{ paneid: 'p', recipe_id: null, agent: 'builder-one', state: 'live' }, { paneid: 'q', recipe_id: null, agent: 'builder-one', state: 'live' }], mintedOf }) !== null, 'rows with no recipe are never "primary"');

console.log('\n[fabric.deliver]');
{
  const lines: string[] = [];
  const env = (to: string) => ({ id: `e-${to}`, ts: '2026-10-25T12:00:00Z', from: 'someone', to, kind: 'msg', class: 'coordination', attention: 'notice', body: 'b' });
  fabric.setDeliveryDeps({
    livePaneFor: (slug) => (slug === 'solo' ? 'recipe:S' : slug === 'builder-one-aaaa1111' ? 'recipe:R1#a' : null),
    ambiguousFor: (slug) => (slug === 'builder-one' ? ['builder-one-aaaa1111', 'builder-one-bbbb2222'] : null),
    toViewers: () => 0,
    log: (l) => lines.push(l),
  });
  const amb = fabric.deliver(env('builder-one') as never);
  ok(amb.ok === false && /^ambiguous: 'builder-one' is the address of 2 live sessions; send to one of: builder-one-aaaa1111, builder-one-bbbb2222$/.test((amb as { error: string }).error), 'a bare slug held by two panes is refused, naming them', amb);
  const one = fabric.deliver(env('builder-one-aaaa1111') as never);
  ok(one.ok === true && (one as { paneid: string }).paneid === 'recipe:R1#a', 'the minted slug the sender was told to use is delivered to that pane', one);
  const solo = fabric.deliver(env('solo') as never);
  ok(solo.ok === true, 'a slug with one pane is delivered as before');
  const none = fabric.deliver(env('nobody') as never);
  ok(none.ok === false && /no live session/.test((none as { error: string }).error), 'an unknown slug still says "no live session"');
  fabric.setDeliveryDeps({ livePaneFor: () => 'recipe:Q', toViewers: () => 0, log: () => {} });
  ok(fabric.deliver(env('anything') as never).ok === true, 'deps without ambiguousFor behave exactly as before');
  fabric.setDeliveryDeps(null);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
