/**
 * [passing ping] namedInPassing: which seats a chat line names ONLY inside a sentence
 * (their copy says a reply is owed only if the sentence asks them something). Pure.
 */
process.env.HARBOR_WB_TABLE = '/nonexistent/never-opened.db';
const { namedInPassing, withoutCode } = await import('../src/server/room-commands.ts');

let failed = 0;
let checks = 0; // the runner (scripts/run-tests.mjs) needs a `PASS n FAIL m` summary line

function eq(actual: unknown, expected: unknown, msg: string): void {
  checks++;
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}${good ? '' : ` (got ${JSON.stringify(actual)})`}`);
  if (!good) failed++;
}
const seats = [
  { id: 'a', handle: 'alpha', is_lead: true },
  { id: 'b', handle: 'bravo' },
  { id: 'c', handle: 'charlie' },
];
const p = (t: string) => namedInPassing(t, seats, { userHandle: 'owner' });

eq(p('@alpha @bravo please look'), [], 'the leading run is asked');
eq(p('@alpha please sync with @bravo on this'), ['b'], 'a seat inside a sentence is in passing');
eq(p('@alpha do X. @bravo do Y.'), [], 'an @ that opens a sentence is asked');
eq(p('@alpha do X;\n@bravo do Y'), [], 'an @ that opens a line is asked');
eq(p('@alpha see `@bravo` for context'), [], 'a quoted handle names nobody');
eq(p('@alpha cc @bravo and @charlie'), ['b', 'c'], 'two in passing');
eq(p('@alpha ask @bravo. @bravo again'), [], 'asked anywhere wins over passing');
eq(p('@alpha thanks @user'), [], 'the user is not a seat');
eq(p('no names at all'), [], 'no names');
eq(withoutCode('x `@bravo` y'), 'x   y', 'withoutCode drops spans');
console.log(`PASS ${checks - failed} FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
