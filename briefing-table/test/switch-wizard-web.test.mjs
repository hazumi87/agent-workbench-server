// [basic switch] source slices: the seat menu's "Switch assistant…" wizard (the design notes §3 item 8).
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const m = rd('room-seat-menu.mjs');
const room = rd('room.js');
const css = rd('room.css');
let passed = 0;
let failed = 0;
function ok(c, msg) {
  if (c) { passed++; console.log(`  + ${msg}`); } else { failed++; console.log(`  X ${msg}`); }
}
const card = m.slice(m.indexOf('function confirmSwitch('), m.indexOf('return { decorate, statusFor, holding, openMenu };'));
const items = m.slice(m.indexOf('function items(seat)'), m.indexOf('function closeMenu('));

ok(/o\.canSwitch\?\.\(\) \? \[\{ a: 'switch', label: 'Switch assistant…'/.test(items), 'the menu item exists only where the page says it may (o.canSwitch)');
ok(/off: !live \|\| !seat\.recipe_id/.test(items.slice(items.indexOf("a: 'switch'"))) && /Stopped: Start it first, then switch/.test(items), 'a stopped seat greys it with "Start it first"');
ok(/canSwitch: \(\) => isBasic\(\)/.test(room), 'room.js offers it in Basic only');
ok(/it\.a === 'switch'\) \{/.test(m) || /\|\| it\.a === 'switch'\)/.test(m), 'choosing it keeps the hold and hands over to the card');
ok(/call\(base\)/.test(card) && /const base = `\/api\/rooms\/\$\{encodeURIComponent\(o\.roomId\)\}\/seats\/\$\{encodeURIComponent\(seat\.id\)\}\/switch`/.test(card), 'the card reads GET .../seats/:seatId/switch first');
ok(/`Now: \$\{cur\.brand \?\? 'unknown'\}`/.test(card) && /`Model \$\{cur\.model \?\? 'default'\} · effort \$\{cur\.effort \?\? 'default'\}`/.test(card), 'it shows the LIVE assistant with its model and effort, "default" when unknown');
ok(/is configured but stopped/.test(card) && /Start the seat first, then switch\./.test(card), 'no live occupant: configured/stopped, pointing to Start');
ok(/b\.disabled = !!ch\.disabled;/.test(card) && /ch\.disabled \? ch\.why/.test(card), 'the current vendor\'s choice is disabled with the engine\'s words ("You\'re already using …")');
ok(/b\.setAttribute\('role', 'radio'\)/.test(card) && /yes\.disabled = false;/.test(card), 'one confirm, enabled only once a choice is made');
ok(/call\(base, \{ to: pick \}\)/.test(card) && /progress\(r\.body\.opId\)/.test(card), 'confirm POSTs {to} and follows the operation it answers (a retry joins the running one)');
ok(/w\.active && w\.active\.seat === seat\.id && !w\.active\.done/.test(card), 'a switch already running for this seat opens straight into its progress');
ok(/setInterval\(\(\) => void poll\(\), 1500\)/.test(card) && /line\.textContent = v\.words/.test(card), 'progress is the engine\'s plain words, polled');
ok(/stop\.hidden = !v\.canCancel;/.test(card) && /go\.hidden = !v\.canContinue;/.test(card), 'Cancel only while reversible; Continue anyway only when the handover is unconfirmed');
ok(/\/cancel`, \{\}\)/.test(card) && /\/continue`, \{\}\)/.test(card), 'they call .../cancel and .../continue');
ok(/shut\.addEventListener\('click', \(\) => close\(true\)\)/.test(card) && !/close\(true\);\s*void call\([^)]*cancel/.test(card), 'Close only hides the card, it never cancels the switch');
ok(/catch \(e2\)/.test(card), 'every call is caught locally (an await in a click handler never throws into the void)');
ok(/\.rsm-swchoice \{[^}]*min-height: 44px;/.test(css) && /\.rsm-switch \.ft \.rsm-btn \{ min-height: 44px; \}/.test(css), 'phone-sized: 44px targets');
ok(/\.rsm-swchoice \{[^}]*width: 100%;/.test(css) && /\.rsm-dsub \{[^}]*overflow-wrap: anywhere;/.test(css), 'no sideways scroll: full-width choices, long words wrap');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
