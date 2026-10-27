/**
 * The stuck-key guard: a runaway of one tiny chunk is dropped, a person's input never is.
 */
import { createInputGuard, MAX_REPEATS, COOLDOWN_MS, WINDOW_MS } from '../src/engine/input-guard.ts';

let failed = 0;
let total = 0;
const ok = (c: unknown, m: string) => { total++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };

{
  const g = createInputGuard();
  let dropped = 0;
  for (let i = 0; i < 35; i++) dropped += g.check('p', 'y', i * 30).drop ? 1 : 0;
  ok(dropped === 0, 'a held key at ~33 per second is never dropped');
}
{
  const g = createInputGuard();
  let notices = 0;
  let dropped = 0;
  for (let i = 0; i < MAX_REPEATS + 500; i++) {
    const v = g.check('p', 'y', i); // 1 per ms: a runaway
    if (v.notice) notices++;
    if (v.drop) dropped++;
  }
  ok(notices === 1, 'a runaway is announced exactly once');
  ok(dropped === 500, 'every copy past the limit is dropped (' + dropped + ')');
  ok(!g.check('p', '\x1b', MAX_REPEATS + 600).drop, 'Esc passes straight through while the runaway is being dropped');
  ok(!g.check('p', 'y', MAX_REPEATS + 700).drop, 'and typing resumes normally after a different key');
}
{
  const g = createInputGuard();
  for (let i = 0; i < MAX_REPEATS + 5; i++) g.check('p', 'y', i);
  ok(g.check('p', 'y', MAX_REPEATS + 10 + COOLDOWN_MS + 1).drop === false, 'quiet for the cooldown clears the trip');
}
{
  const g = createInputGuard();
  let dropped = 0;
  for (let i = 0; i < 300; i++) dropped += g.check('p', 'x'.repeat(50), i).drop ? 1 : 0;
  ok(dropped === 0, 'a long chunk (a paste) is never counted');
}
{
  const g = createInputGuard();
  for (let i = 0; i < MAX_REPEATS + 5; i++) g.check('a', 'y', i);
  ok(!g.check('b', 'y', MAX_REPEATS + 6).drop, 'one pane tripping does not affect another');
  void WINDOW_MS;
}
console.log(`PASS ${total - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
