/* REPLY PREFILL CASES (toolkit [ref]): every case in
 * test/fixtures/reply-prefill-cases.json against the SHIPPED rule
 * (web/room-reply-all.mjs). The same file is the Workbench's self-test.
 * Pure: no engine, no port. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replyAllHandles, replyAllPrefix } from '../web/room-reply-all.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'reply-prefill-cases.json'), 'utf8'));
let passed = 0;
let failed = 0;
for (const c of fx.cases) {
  const got = replyAllPrefix(replyAllHandles({ body: c.body, author: c.author, seats: fx.seats, leadHandle: fx.lead, me: fx.me }));
  if (got === c.prefix) {
    passed++;
    console.log(`  ok ${c.name} -> ${JSON.stringify(got)}`);
  } else {
    failed++;
    console.log(`  FAIL ${c.name} -> ${JSON.stringify(got)}, want ${JSON.stringify(c.prefix)}`);
  }
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
