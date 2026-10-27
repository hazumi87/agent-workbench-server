// [chat scroll] source slices: the agent chat keeps the room line's scrolling rules.
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const js = rd('agent-chat.mjs');
const css = rd('agent-chat.css');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
ok(/let pinned = true;/.test(js) && /const atBottom = \(\) => scroller\.scrollHeight - scroller\.scrollTop - scroller\.clientHeight < 40;/.test(js), 'pinned state, the room line\'s 40px "at the bottom"');
ok(/pinned = true; \/\/ switching to Chat always lands on the newest message[\s\S]*?toBottom\(\);/.test(js), '(1) opening / switching back to Chat lands on the newest message');
ok(/new ResizeObserver\(\(\) => \{\s*if \(pinned && visible && scroller\.clientHeight > 0 && !atBottom\(\)\)/.test(js), '(1) a view that loaded while HIDDEN (a background tab) stays on the newest once it has a size');
ok(/else if \(follow\) \{\s*pinned = true;\s*hideNewer\(\);\s*toBottom\(\);/.test(js) && /follow = stick === true \|\| Date\.now\(\) < stickUntil \|\| \(stick !== 'older' && \(pinned \|\|/.test(js), '(2) new messages keep it pinned only while pinned (or your own send)');
ok(/scroller\.scrollTop = keepTop; \/\/ scrolled up: never jump/.test(js) && /if \(added > 0\) \{\s*showNewer\(added\);/.test(js) && /newCount > 1 \? 'New messages' : 'New message'/.test(js), '(3) scrolled up: no jump, and the "New message(s)" pill shows with its count');
ok(/id="acNewer" hidden><span class="nw">New messages<\/span><b class="nc">1<\/b>/.test(js) && /newer\.addEventListener\('click'/.test(js) && /\.ac \.ac-newer \{\s*position: sticky; bottom: 8px;/.test(css), '(3) the pill is stuck to the scroller\'s bottom; a tap goes to the newest');
ok(/scroller\.scrollTop = scroller\.scrollHeight - keepFrom;/.test(js), '(4) loading older keeps your place');
ok(/paint\(false, Math\.max\(0, items\.size - had\)\)/.test(js), 'the poll tells paint how many lines arrived');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
