/**
 * Basic: the assistant's quit ends the shell (no bare shell for a typed word to run in); Full edition is unchanged.
 */
import { basicEndsWithAssistant } from '../src/engine/launch.ts';

let failed = 0;
let total = 0;
const ok = (c: unknown, m: string) => { total++; console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) failed++; };
const prev = process.env.HARBOR_WB_EDITION;

process.env.HARBOR_WB_EDITION = 'basic';
ok(basicEndsWithAssistant('claude --model sonnet') === 'claude --model sonnet; exit', 'basic: the shell exits when claude does');
ok(basicEndsWithAssistant(undefined) === undefined, 'basic: nothing to type stays nothing');
process.env.HARBOR_WB_EDITION = 'full';
ok(basicEndsWithAssistant('claude') === 'claude', 'full: the command is typed as before');
delete process.env.HARBOR_WB_EDITION;
ok(basicEndsWithAssistant('claude') === 'claude', 'unset edition is full');
if (prev === undefined) delete process.env.HARBOR_WB_EDITION; else process.env.HARBOR_WB_EDITION = prev;
console.log(`PASS ${total - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
