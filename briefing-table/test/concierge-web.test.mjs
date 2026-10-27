/**
 * The Concierge icon's pure rules (web/concierge-core.mjs) and the wiring every
 * surface depends on, read from the files (the design notes P1): when the
 * icon shows, what it says, how a wb: chip opens (a shell tab on a desktop, the
 * same tab on a phone), the four surfaces, Basic hiding, and the chat view's
 * voice mark and link chips. No browser.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const rd = (f) => readFileSync(join(W, f), 'utf8');
const C = await import(pathToFileURL(join(W, 'concierge-core.mjs')).href);

let checks = 0;
let failed = 0;
const ok = (c, m) => {
  checks++;
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failed++;
};

const st = (o = {}) => ({ settings: { enabled: true, active: 'primary' }, active: { id: 'rec-cg', name: 'Concierge', vendor: 'claude-code' }, prerequisite: { paneTokens: true }, ...o });

console.log('\n[when the icon shows and what it says]');
ok(!C.shown(null), 'no status (Basic 404, or the engine away): no icon');
ok(!C.shown(st({ settings: { enabled: false } })), 'off: no icon');
ok(!C.shown(st({ active: null })), 'no active recipe: no icon');
ok(C.shown(st()), 'on with a recipe: the icon');
ok(C.iconTitle(st(), 0) === 'Concierge (Concierge)', 'quiet: names the active recipe');
ok(C.iconTitle(st(), 3) === 'Concierge: 3 new replies' && C.iconTitle(st(), 1) === 'Concierge: 1 new reply', 'replies waiting: counts them');
ok(/pane tokens are off/.test(C.iconTitle(st({ prerequisite: { paneTokens: false } }), 2)), 'pane tokens off: the icon SAYS the prerequisite is disabled');

console.log('\n[how a wb: chip opens]');
ok(C.linkAction({ embedded: true, phone: false }) === 'shell-tab', 'inside the shell on a desktop: a new shell tab');
ok(C.linkAction({ embedded: true, phone: true }) === 'shell-tab', 'inside the shell (an iPad): a new shell tab');
ok(C.linkAction({ embedded: false, phone: true }) === 'navigate', 'a phone: this tab navigates');
ok(C.linkAction({ embedded: false, phone: false }) === 'window', 'a bare desktop page: a browser tab');
const m = C.openTabMessage({ url: '/room.html?room=R1#line-4', label: 'Alpha #4', room: 'R1' });
ok(m.hwbOpenTab.url === '/room.html?room=R1#line-4' && m.hwbOpenTab.sessionId === 'room:R1', "a room link reuses the shell's one-tab-per-room id");
ok(!('sessionId' in C.openTabMessage({ url: '/manager.html', label: 'Workbench' }).hwbOpenTab), 'a non-room link carries no session id');

console.log('\n[the surfaces]');
const room = rd('room.js');
ok(/\$\('gearBtn'\)\.before\(m\.conciergeButton\('rm-cg'\)\)/.test(room), 'room header: beside the settings button');
ok(/cgModule\.conciergeButton\('cell-hadd'\)/.test(room), "phone: the Agents sheet's top row (the phone header is full)");
ok(/a: '__concierge'/.test(room) && /m\.openConcierge\(\)/.test(room), 'the waiting-rooms View menu gets a Concierge row that opens the fly-out');
ok(/getElementById\('mgrFindRow'\)\?\.append\(m\.conciergeButton\('mgr-cg', \{ always: true \}\)/.test(rd('manager.js')), 'Workbench: in the find row, right of the search field, muted when off');
const solo = rd('solo.js');
ok(/conciergeButton\('sb-ib sb-cg'\)/.test(solo) && /els\.sbar\.append\(cgBtn\)/.test(solo), 'solo head: re-attached after every bar render');
const shell = rd('shell.html');
ok(/label: 'Concierge'/.test(shell) && /cgShown \?/.test(shell), "shell: a status-menu item, offered only when the Concierge is on");
ok(!/concierge/i.test(rd('aurora/window-chrome/hwb-chrome.js')), 'the pinned design-system chrome bundle is untouched');
ok(/'concierge'\]\)/.test(rd('settings.mjs')) && /BASIC_HIDES = new Set\(\[[^\]]*'concierge'/.test(rd('settings.mjs')), 'Settings: a Concierge group, hidden in Basic');
ok(/\[data-edition="basic"\] \.cg-btn \{ display: none; \}/.test(rd('concierge.css')), 'Basic: the icon is hidden by the edition attribute');

console.log('\n[the chat view: voice mark and link chips]');
const chat = rd('agent-chat.mjs');
ok(/it\.meta\?\.via === 'voice'/.test(chat) && /aria-label', 'voice'/.test(chat), 'a spoken line shows the mic glyph labelled "voice"');
ok(/if \(l\.ok\)/.test(chat) && /ac-wb-dead/.test(chat), 'a live link is a chip; a dead one is text with its note');
const css = rd('concierge.css');
ok(/@media \(max-width: 600px\)[\s\S]*\.cg-btn, \.cg-x \{ width: 44px; height: 44px; \}/.test(css), 'phone: 44px targets');
ok(/\.cg-sheet\.is-phone \{[^}]*width: 100%/.test(css), 'phone: a full-width bottom sheet');

console.log('\n[P2: a proxy line in the room]');
const roomJs = rd('room.js');
ok(/function byConcierge\(e\) \{\s*return e\.author === 'concierge' && !e\.author_seat;/.test(roomJs), "a proxy line is author `concierge` with no seat");
ok(/Concierge \(for \$\{meta\?\.for/.test(roomJs), 'its name reads "Concierge (for <person>)", never "you"');
ok(/f\.author === 'concierge'/.test(rd('to-me.mjs')), 'it shows in the "to me" view (the one rule, web/to-me.mjs)');

console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
