/** Which room facts are "to me" on the web page (web/fact-mentions.mjs; lead [ref], aligned with the app's rules.js). */
import { mentionsIn, namesPerson, factIsToMe } from '../web/fact-mentions.mjs';
let passed = 0; let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };
ok(mentionsIn('@a restarted by @Owner (asked by @user)').join() === 'a,owner,user', 'names are read in lower case from the fact text');
ok(mentionsIn('see `@owner` here').length === 0, 'a name inside a code span does not count');
ok(mentionsIn('mail noreply@example.com').length === 0, 'an email is not a name');
ok(mentionsIn(null).length === 0 && mentionsIn(undefined).length === 0, 'empty is safe');
ok(namesPerson(['a', 'user'], null) === true && namesPerson(['a', 'owner'], 'Owner') === true && namesPerson(['a', 'owner'], null) === false, '@user always names the person; their handle does, case aside; with no handle only @user');
ok(factIsToMe({ toUser: '1', mentions: '' }, 'owner') === true, 'a fact the engine flagged to the person is in');
ok(factIsToMe({ toUser: '', mentions: 'a b' }, 'owner') === false, 'an ordinary fact (floor, seat added) is out');
ok(factIsToMe({ toUser: '', mentions: 'owner' }, 'owner') === true, 'a fact whose own text names the person is in');
ok(factIsToMe({ toUser: '', mentions: '' }, 'owner') === false, 'no flag, no name: out');
console.log(`PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
