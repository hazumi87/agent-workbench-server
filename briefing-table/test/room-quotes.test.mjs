/* The page's quote rule (web/room-reply-all.mjs) against test/fixtures/address-cases.json:
 * the same 'mentions' cases the engine passes. Code (fenced and inline) is removed first,
 * as the page's own mention painting and the engine both do. Pure. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quotedRanges, inQuote } from '../web/room-reply-all.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'address-cases.json'), 'utf8'));
const MENTION_RE = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g;
const BT = String.fromCharCode(96);
const noCode = (t) => t.split(BT.repeat(3)).filter((_, i) => i % 2 === 0).join(' ').split(BT).filter((_, i) => i % 2 === 0).join(' ');
const mentions = (t) => {
  const prose = noCode(t);
  const q = quotedRanges(prose);
  return [...prose.matchAll(MENTION_RE)].filter((m) => !inQuote(q, m.index)).map((m) => m[1].toLowerCase());
};
let passed = 0;
let failed = 0;
for (const c of fx.mentions) {
  const got = mentions(c.text);
  if (JSON.stringify(got) === JSON.stringify(c.mentions)) {
    passed++;
    console.log(`  ok ${c.name} -> ${JSON.stringify(got)}`);
  } else {
    failed++;
    console.log(`  FAIL ${c.name} -> ${JSON.stringify(got)}, want ${JSON.stringify(c.mentions)}`);
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
