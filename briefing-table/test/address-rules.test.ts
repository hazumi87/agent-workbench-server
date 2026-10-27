/**
 * ADDRESS RULES (Owner [ref]/[ref], toolkit [ref]): quoted text never addresses
 * (engine half: withoutCode / withoutQuotes), and @user becomes the person's real
 * handle on an agent's line (convertUserAlias). Runs every case in
 * test/fixtures/address-cases.json, which the Workbench reuses. Pure: no engine.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutCode, convertUserAlias, quotedRanges } from '../src/server/room-commands.ts';

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'address-cases.json'), 'utf8'));
const MENTION_RE = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g;
const mentions = (t: string): string[] => [...withoutCode(t).matchAll(MENTION_RE)].map((m) => m[1].toLowerCase());

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
}
for (const c of fx.mentions) {
  const got = mentions(c.text);
  ok(JSON.stringify(got) === JSON.stringify(c.mentions), `mentions: ${c.name} -> ${JSON.stringify(got)}`);
}
for (const c of fx.alias) {
  const got = convertUserAlias(c.text, c.handle);
  ok(got === c.out, `alias: ${c.name} -> ${JSON.stringify(got)}`);
}
/* limits the fixture does not spell out */
const long = `"${'x'.repeat(401)} @bee"`;
ok(quotedRanges(long).length === 0, 'a quote longer than 400 characters is not a quote');
ok(withoutCode('say "hi there" @bee') === 'say   @bee', 'a quoted span is replaced by one space');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
