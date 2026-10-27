/* AGENT CHAT, web half [agent chat] Owner 2026-10-05: the pure rules (agent-chat-core.mjs) and
 * source-slice checks on the window wiring (solo.js / shell.html / agent-chat.mjs). The browser
 * behavior is the Playwright harness; this keeps the contract from drifting. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const rd = (f) => readFileSync(join(W, f), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };

const C = await import(pathToFileURL(join(W, 'agent-chat-core.mjs')).href);

/* tabs per vendor */
ok(C.hasChatTabs('claude-code') && C.hasChatTabs('codex-cli') && C.hasChatTabs('gemini-cli'), 'the three agent CLIs get the tabs');
ok(!C.hasChatTabs('cli-manager') && !C.hasChatTabs('unknown') && !C.hasChatTabs(''), 'shells, the command bridge and unknown vendors get none');

/* the default view */

/* remembered per pane, guarded */
const store = new Map();
const ls = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
C.writeView('recipe:a', 'chat', ls);
C.writeView('recipe:b', 'cli', ls);
ok(C.readView('recipe:a', ls) === 'chat' && C.readView('recipe:b', ls) === 'cli' && C.readView('recipe:c', ls) === null, 'the choice is per pane');
ok(C.readView('x', { getItem() { throw new Error('blocked'); } }) === null, 'a throwing storage reads as no choice');
let threw = false;
try { C.writeView('x', 'chat', { setItem() { throw new Error('blocked'); } }); } catch { threw = true; }
ok(!threw, 'a throwing storage never throws out of writeView');

/* the pending bubble */
ok(C.pendingLabel('typed') === 'sent', 'typed reads "sent"');
ok(C.pendingLabel('held', { reason: 'draft' }) === 'held: draft in the CLI', 'held by a draft says so');
ok(C.pendingLabel('held', { reason: 'busy' }) === 'held: busy', 'held for another reason names it');
ok(C.pendingLabel('queued') === 'queued', 'queued reads "queued"');
ok(C.echoes({ role: 'user', text: 'fix the build please Attached: http://x/y' }, { text: 'fix the build please', files: [] }), 'the transcript echo (with the Attached line) matches');
ok(!C.echoes({ role: 'agent', text: 'fix the build please' }, { text: 'fix the build please', files: [] }), 'an agent line is never the echo');
ok(!C.echoes({ role: 'user', text: 'something else' }, { text: 'fix the build please', files: [] }), 'a different user line is not the echo');
ok(C.echoes({ role: 'user', text: 'Attached: http://x/a.png', files: [{ name: 'a.png', path: '' }] }, { text: '', files: ['a.png'] }), 'a files-only send is echoed by its Attached line');

/* rows */
const T = String.fromCharCode(215);
ok(C.toolLine({ tools: [{ name: 'Bash' }, { name: 'Bash' }, { name: 'Bash' }] }) === 'Ran 3 tools: Bash '.concat(T, '3'), 'three Bash = "Ran 3 tools: Bash x3"');
ok(C.toolLine({ tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Read' }] }) === `Ran 3 tools: Bash, Read ${T}2`, 'mixed tools count per name, in order of first use');
ok(C.toolLine({ tools: [{ name: 'Edit' }] }) === 'Ran 1 tool: Edit', 'one tool is singular');
const fence = '`'.repeat(3);
const runs = C.splitFences(`before ${fence}js\nconst a = 1;\n${fence} after`);
ok(runs.length === 3 && runs[1].code && runs[1].text === 'const a = 1;' && !runs[0].code, 'a fenced block becomes a code run (the language word dropped)');

/* the "Use Enter to send" setting */
const key = (o) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...o });

/* the view source */
const chat = rd('agent-chat.mjs');
const solo = rd('solo.js');
const shell = rd('shell.html');
ok(/\/api\/rooms\/me/.test(chat) && /enterSubmits/.test(chat), 'the Enter setting is read from /api/rooms/me');
ok(/x-filename/.test(chat) && /scratchpad`, \{\s*method: 'POST'/.test(chat) && /files: files\.length \? files : undefined/.test(chat), 'attachments upload to the Scratchpad and ride the send as files[]');
ok(/\/chat`, \{\s*method: 'POST'/.test(chat) && /after=\$\{encodeURIComponent\(latest\)\}/.test(chat) && /setInterval\(\(\) => void poll\(\), 2000\)/.test(chat), 'it posts to /chat and polls ?after=<latest> every 2 s');
ok(/isHidden\(\)/.test(chat), 'it does not poll while the page is hidden');
ok(/state === 'sending'|'sending'/.test(chat) && /pending\.splice/.test(chat), 'the pending bubble is dropped when the transcript echoes it');
ok(!/\.focus\(\)/.test(chat.replace(/if \(!COARSE\) \{\s*input\.focus\(\);/, '')), 'the box is never focused programmatically on touch');
ok(/class="ac-padbtn"|ac-padbtn/.test(chat) && /acPadUp/.test(chat), 'a Scratchpad button opens a list with upload');
ok(/font-size: 16px/.test(rd('agent-chat.css')), 'the message box is 16px (no iOS focus zoom)');
ok(/\.ac-padcol \{ flex: 0 0 370px; width: 370px/.test(rd('agent-chat.css')), 'the Scratchpad column is 370px on a PC');
ok(/\.ac-padcol \{ position: absolute; inset: 0/.test(rd('agent-chat.css')), 'and the whole screen on a phone');

/* the window: no reattach on a switch */
ok(/attachViewTabs\(sbarEl, viewTabsEl, bar\.view \|\| null\)/.test(shell) && /'view:' \+ ev\.detail\.view/.test(shell), 'the shell draws the tabs and forwards the click to the tab page');

/* the shared key rule (web/enter-pref.mjs), Owner 2026-10-05: same as the room */
const EP = await import(new URL('../web/enter-pref.mjs', import.meta.url).href);
const kk = (o) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...o });
ok(EP.enterAction(kk({}), true) === 'send' && EP.enterAction(kk({}), undefined) === 'send', 'Enter sends with the setting on (or unset)');
ok(EP.enterAction(kk({}), false) === 'native', 'Enter is a new line with the setting off');
ok(EP.enterAction(kk({ shiftKey: true }), true) === 'native' && EP.enterAction(kk({ ctrlKey: true }), true) === 'newline' && EP.enterAction(kk({ metaKey: true }), false) === 'newline', 'Shift/Ctrl/Cmd+Enter are a new line, whatever the setting');
ok(EP.enterAction(kk({}), true, true) === 'native', 'a phone Enter is a new line');
ok(EP.enterAction(kk({ isComposing: true }), true) === null, 'an IME composition never acts');
ok(/enterAction\(ev, enterSubmits, phoneInput\(\)\)/.test(rd('agent-chat.mjs')) && /enterAction\(ev, state\.me\?\.enterSubmits, phoneInput\(\)\)/.test(rd('room.js')), 'room and agent chat share the rule');
ok(/stickUntil = Date\.now\(\) \+ 8000/.test(rd('agent-chat.mjs')), 'after you send, the chat keeps your message in view');
/* Owner 2026-10-14: an agent outside a room has no Chat view in its own window: CLI only, no tabs */
ok(!/createChat|hasChatTabs|setView|checkSeated|initView|viewTabsState|VIEW_EVENT/.test(solo), 'solo.js carries no agent chat view');
ok(/view: null,/.test(solo), 'the bar model never carries the Chat | CLI tabs');
/* [chat sender] Owner 2026-10-06: agents' DMs typed into a Codex pane showed under his name */
const D = String.fromCharCode(183);
const fab = C.fromPeer({ role: 'user', text: `[fabric ${D} @other-builder-00000001 ${D} ask ${D} t:decafbad ${D} id:3e87] state check` });
ok(fab && fab.via === 'fabric' && fab.from === 'other-builder-00000001' && fab.kind === 'ask' && fab.body === 'state check', 'a typed fabric message is the sender\'s, body without the prefix');
const rl = C.fromPeer({ role: 'user', text: `[room Asset Studio ${D} @alpha-studio] hello` });
ok(rl && rl.via === 'room' && rl.from === 'alpha-studio' && rl.room === 'Asset Studio', 'a typed room line by an agent is that agent\'s, with its room');
ok(C.fromPeer({ role: 'user', text: `[room UI ${D} @user] mine` }) === null, 'a room line by @user stays yours');
const rlId = C.fromPeer({ role: 'user', text: `[room Asset Studio ${D} @alpha-studio ${D} #57] hello` });
ok(rlId && rlId.from === 'alpha-studio' && rlId.room === 'Asset Studio' && rlId.body === 'hello', '[reply route] the frame\'s line id is not part of the sender');
ok(C.fromPeer({ role: 'user', text: `[room UI ${D} @user ${D} #58] mine` }) === null, '...and a room line by @user with an id stays yours');
ok(C.fromPeer({ role: 'user', text: 'plain words' }) === null && C.fromPeer({ role: 'agent', text: `[fabric ${D} @x ${D} msg] y` }) === null, 'plain turns and agent turns are untouched');
ok(/const peer = fromPeer\(it\);/.test(rd('agent-chat.mjs')) && /ac-peer/.test(rd('agent-chat.css')), 'the view paints a peer row in its own style');
console.log(`PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
