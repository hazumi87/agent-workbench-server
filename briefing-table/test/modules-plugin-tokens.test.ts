/**
 * PLUGIN TOKENS (src/server/modules/plugin-tokens.ts; ported from the token cases of workbench-app test/plugin-install-main.test.mjs; the Electron glue
 * cases of that file are not ported): one-time tokens between the checked zip and the install. Redeemed once, expiring, bounded. Pure.
 */
import { createTokens } from '../src/server/modules/plugin-tokens.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}

console.log('\n[a token is redeemed once, expires, and holds its value untouched]');
{
  let t = 0;
  const store = createTokens<{ id: string }>({ now: () => t, ttlMs: 1000 });
  const value = { id: 'x' };
  const a = store.put(value);
  ok(/^[0-9a-f]{32}$/.test(a), 'a 32-character hex token');
  ok(store.take(a) === value, 'the very value comes back');
  ok(store.take(a) === null, 'once only');
  const b = store.put(value);
  t = 1001;
  ok(store.take(b) === null, 'expired');
  const c = store.put(value);
  t = 2001;
  ok(store.take(c) === value, 'good right up to the ttl');
  for (const bad of [undefined, null, 7, '', 'x'.repeat(32), {}]) ok(store.take(bad) === null, 'a malformed token ' + JSON.stringify(bad));
}

console.log('\n[the store keeps a bounded number of tokens, the oldest dropped first]');
{
  const store = createTokens<number>({ now: () => 0, ttlMs: 1000, max: 2 });
  const a = store.put(1), b = store.put(2), c = store.put(3);
  ok(store.take(a) === null, 'the oldest is dropped');
  ok(store.take(b) === 2, 'the second stands');
  ok(store.take(c) === 3, 'the newest stands');
}

console.log('\n[the default bound is 8, and two tokens are never alike]');
{
  const store = createTokens<number>({ now: () => 0 });
  const toks = Array.from({ length: 9 }, (_, i) => store.put(i));
  ok(new Set(toks).size === 9, 'nine different tokens');
  ok(store.take(toks[0]) === null && store.take(toks[1]) === 1, 'the ninth pushed the first out');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
