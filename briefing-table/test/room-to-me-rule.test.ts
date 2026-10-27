/**
 * THE PERSON'S "TO ME" RULE (Owner [ref], toolkit [ref]): a quote never counts.
 * An agent's reply to a line the person wrote is "to me" only through
 * meta.to_user (it names the person, or names nobody and the engine's reply
 * inheritance marked it); a reply addressed to another seat is between agents.
 *
 * Reads the SHIPPED page code (web/room.js matchesWho) and runs every case in
 * test/fixtures/to-me-cases.json, which is also what the Workbench reuses.
 * The line -> dataset step mirrors web/room.js (the li.dataset.* writes near
 * "addressed to THE USER"). Pure: no engine, no port.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'web', 'room.js'), 'utf8');
const body = src.slice(src.indexOf('function matchesWho(d, who) {'), src.indexOf('function whoLabel('));
const { factIsToMe, mentionsIn } = await import('../web/fact-mentions.mjs'); // the page imports it; the sandbox gets the shipped module
const { isToMe, toMeFlags, isHiddenFact } = await import('../web/to-me.mjs'); // the ONE rule: the page and the engine's GET .../line?to=me both read it
const matchesWho = new Function('state', 'factIsToMe', 'isToMe', `${body}; return matchesWho;`)({ seats: [] }, factIsToMe, isToMe) as (d: any, who: string) => boolean;
const { cases } = JSON.parse(readFileSync(join(here, 'fixtures', 'to-me-cases.json'), 'utf8'));

/** The page's per-line flags (web/room.js, where each entry's dataset is written). */
function dataset(e: any): Record<string, string> {
  const m = e.meta ?? {};
  return {
    kind: e.kind,
    author: e.author ?? '',
    authorSeat: e.author_seat ?? '',
    target: e.target ?? '',
    targetSeat: e.target_seat ?? '',
    toUser: toMeFlags(e).toUser ? '1' : '',
    replyUser: e.author_seat && m.reply?.user === true ? '1' : '',
    ...(e.kind === 'fact' ? { mentions: mentionsIn(e.body).join(' ') } : {}),
    ...(toMeFlags(e).tool ? { tool: toMeFlags(e).tool, for: toMeFlags(e).for } : {}),
  };
}

let passed = 0;
let failed = 0;
for (const c of cases) {
  const d = dataset(c.line);
  for (const [who, want] of [['me', c.me], ['agents', c.agents]] as const) {
    const got = matchesWho(d, who);
    if (got === want) {
      passed++;
      console.log(`  ok ${who}: ${c.name} -> ${got}`);
    } else {
      failed++;
      console.log(`  FAIL ${who}: ${c.name} -> ${got}, want ${want}`);
    }
  }
}
/* THE ENGINE'S FILTER AGREES: GET .../line?to=me evaluates isToMe(toMeFlags(entry)) with a fact's own mentions, and every case in the shared fixture gets the same answer as the page */
for (const c of cases) {
  const e = c.line;
  const engine = !isHiddenFact(e) && isToMe(toMeFlags(e), e.kind === 'fact' && factIsToMe({ toUser: false, mentions: mentionsIn(e.body) }, undefined));
  const page = matchesWho(dataset(e), 'me');
  if (engine === page && page === c.me) {
    passed++;
    console.log(`  ok engine == page: ${c.name} -> ${page}`);
  } else {
    failed++;
    console.log(`  FAIL engine ${engine} / page ${page}, want ${c.me}: ${c.name}`);
  }
}
/* the cross-post fold takes the same flag: no replyUser on the fold */
const foldLine = src.split('\n').find((l) => l.includes('foldIncoming(xp, {')) ?? '';
if (!foldLine.includes('replyUser')) {
  passed++;
  console.log('  ok the cross-post fold uses to_user only, not a quote');
} else {
  failed++;
  console.log('  FAIL the cross-post fold still counts a quote');
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
