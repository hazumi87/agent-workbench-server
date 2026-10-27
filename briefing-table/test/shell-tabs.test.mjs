/**
 * THE TAB SET'S RULES — the half of the F5 fix that does not need a browser.
 *
 * web/shell-tabs.mjs is pure on purpose (no DOM, storage passed in) precisely
 * so these can be asserted here, in `npm test`, instead of only through a live
 * probe. The probe (test/shell-tabs.probe.mjs) proves the WIRING; this proves
 * the RULES — which set comes back, what is refused, and what a reload key is.
 */
import {
  TAB_SET_KEY, serializeTabSet, parseTabSet, readTabSet, writeTabSet, clearTabSet,
  planInitialTabs, isReloadKey, TAB_SET_MAX,
  paneidFromTabUrl, routeBundleEvent, BUNDLE_EVENTS, BAR_EVENTS, barActionFor,
} from '../web/shell-tabs.mjs';

let passed = 0;
let failed = 0;
function eq(actual, expected, msg) {
  if (Object.is(actual, expected)) {
    passed += 1;
    console.log(`  ✓ ${msg} (${String(actual)})`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

/** A stand-in for sessionStorage, plus a mode where every call throws — which
 *  is a real state (private window, blocked site data) and must cost a
 *  fallback, never an exception. */
function fakeStorage() {
  const map = new Map();
  return {
    throws: false,
    getItem(k) { if (this.throws) { throw new Error('denied'); } return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (this.throws) { throw new Error('denied'); } map.set(k, String(v)); },
    removeItem(k) { if (this.throws) { throw new Error('denied'); } map.delete(k); },
    size() { return map.size; },
  };
}

const tab = (id, url, extra = {}) => ({
  id, url, title: `T-${id}`, state: 'idle', sessionId: null, base: null, logoKey: null,
  iframe: { nodeName: 'IFRAME' }, closing: null, ...extra,
});

console.log('\n[a set round-trips, minus the things that cannot survive a reload]');
const tabs = [tab('t1', '/manager.html'), tab('t2', '/solo.html?recipe=a'), tab('t3', '/solo.html?recipe=b')];
const wire = JSON.parse(JSON.stringify(serializeTabSet(tabs, 't2')));
eq(wire.tabs.length, 3, 'every tab is written');
eq(wire.activeIndex, 1, 'the ACTIVE tab is written as an INDEX, not as an id');
ok(!('iframe' in wire.tabs[0]), 'the live DOM node is not written');
ok(!('id' in wire.tabs[0]), 'nor the per-load id — it means nothing to the next load');
const back = parseTabSet(wire);
eq(back.tabs.length, 3, 'and it parses back whole');
eq(back.tabs[2].url, '/solo.html?recipe=b', 'in order');
eq(back.activeIndex, 1, 'with the active tab intact');

console.log('\n[identity rides along, so a restored tab is not a stranger]');
const ident = parseTabSet(serializeTabSet([tab('t1', '/solo.html?recipe=x', {
  title: 'Platform Opus', state: 'waiting', sessionId: 'recipe:x', base: '#2b6cb0', logoKey: 'table',
})], 't1'));
eq(ident.tabs[0].title, 'Platform Opus', 'title');
eq(ident.tabs[0].state, 'waiting', 'state');
eq(ident.tabs[0].sessionId, 'recipe:x', 'sessionId');
eq(ident.tabs[0].base, '#2b6cb0', 'base colour');
eq(ident.tabs[0].logoKey, 'table', 'logo key');

console.log('\n[NULL for anything it does not fully understand — a fallback beats half a window]');
eq(parseTabSet(null), null, 'nothing');
eq(parseTabSet('not json'), null, 'not json');
eq(parseTabSet('{"v":1}'), null, 'no tabs array');
eq(parseTabSet({ v: 99, tabs: [{ url: '/a' }] }), null, 'a version this build does not know');
eq(parseTabSet({ v: 1, tabs: [] }), null, 'an EMPTY set — restoring nothing is not a restore');
eq(parseTabSet({ v: 1, tabs: [{ title: 'no url' }] }), null, 'a tab with no url is not a tab');
const clamped = parseTabSet({ v: 1, activeIndex: 7, tabs: [{ url: '/a' }, { url: '/b' }] });
eq(clamped.activeIndex, 0, 'an out-of-range activeIndex clamps to the first tab');
const negative = parseTabSet({ v: 1, activeIndex: -3, tabs: [{ url: '/a' }] });
eq(negative.activeIndex, 0, '...and so does a negative one');
const many = parseTabSet({ v: 1, tabs: Array.from({ length: 200 }, (_, i) => ({ url: `/t${i}` })) });
eq(many.tabs.length, TAB_SET_MAX, 'the set is bounded — an unbounded write is a quota error waiting');

console.log('\n[storage that refuses must cost a fallback, never an exception]');
const st = fakeStorage();
writeTabSet(st, tabs, 't2');
eq(readTabSet(st).tabs.length, 3, 'a working storage round-trips through the wrappers');
st.throws = true;
eq(readTabSet(st), null, 'a throwing read returns null');
eq(writeTabSet(st, tabs, 't1'), null, 'a throwing write returns null');
clearTabSet(st);
ok(true, 'and a throwing clear is silent');
st.throws = false;
writeTabSet(st, [], null);
eq(st.size(), 0, 'writing an EMPTY set REMOVES the key rather than storing a lie');

console.log('\n[the URL is a MEMBER of the set, not the whole of it — this IS the fix]');
const HREF = 'http://x/app/shell.html?tabs=%2Fmanager.html';
const set3 = parseTabSet(serializeTabSet(tabs, 't3', HREF));
const restored = planInitialTabs(set3, ['/manager.html'], HREF);
eq(restored.source, 'session', 'a window with a set written down restores THAT');
eq(restored.tabs.length, 3, '...all three tabs, not the one the shell URL carries');
eq(restored.activeIndex, 2, '...on the tab that was active');

const cold = planInitialTabs(null, ['/solo.html?recipe=a', '/manager.html'], 'http://x/app/shell.html?tabs=…');
eq(cold.source, 'url', 'a NEW window (a tear-off) has no set and falls back to its URL');
eq(cold.tabs.length, 2, '...opening exactly what the URL named');
eq(cold.tabs[0].url, '/solo.html?recipe=a', '...in order');

console.log('\n[RELOAD vs NAVIGATION — the stored href is what tells them apart]');
/* A RELOAD is the same URL as the one the set was written under. Its tabs were
   already dealt with; re-adding them resurrects a tab the user CLOSED, which is
   the same defect wearing the opposite sign. */
const closedOne = parseTabSet(serializeTabSet([tabs[0], tabs[2]], 't1', HREF));
const afterClose = planInitialTabs(closedOne, ['/manager.html', '/solo.html?recipe=a'], HREF);
eq(afterClose.tabs.length, 2, 'a tab CLOSED before the reload does NOT come back');
ok(!afterClose.tabs.some((t) => t.url === '/solo.html?recipe=a'), '...even though the shell URL still names it');

/* A NAVIGATION is a different URL: the host is telling this window to show
   something, and that must not be silently dropped. */
const NEW_HREF = `${HREF}%2Cnew`;
const navigated = planInitialTabs(set3, ['/solo.html?recipe=NEW'], NEW_HREF);
eq(navigated.source, 'session+url', 'a DIFFERENT url is the host navigating this window');
eq(navigated.tabs.length, 4, '...so a URL tab the set does not contain is appended, never dropped');
eq(navigated.tabs[3].url, '/solo.html?recipe=NEW', '...at the end');
eq(navigated.activeIndex, 2, '...without stealing the active tab');

const dupe = planInitialTabs(set3, ['/solo.html?recipe=b'], NEW_HREF);
eq(dupe.tabs.length, 3, 'a URL tab ALREADY in the set is not added twice');

/* A set written by a build that did not record an href cannot claim to be a
   reload, so it takes the safe branch: keep the set, add what the URL names. */
const noHref = planInitialTabs({ tabs: [{ url: '/a' }], activeIndex: 0, href: null }, ['/b'], HREF);
eq(noHref.tabs.length, 2, 'a set with no recorded href falls back to appending — never to dropping');

const emptyBoth = planInitialTabs(null, [], HREF);
eq(emptyBoth.tabs.length, 0, 'nothing either way is nothing — the shell opens its own Manager');

console.log('\n[what counts as "reload this page"]');
ok(isReloadKey({ key: 'F5' }), 'F5');
ok(isReloadKey({ key: 'r', ctrlKey: true }), 'Ctrl+R');
ok(isReloadKey({ key: 'R', ctrlKey: true }), '...whatever the shift state did to the key name');
ok(isReloadKey({ key: 'r', metaKey: true }), 'Cmd+R');
ok(isReloadKey({ key: 'r', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+R — a hard reload is still a reload');
ok(isReloadKey({ key: 'F5', ctrlKey: true }), 'Ctrl+F5');
ok(!isReloadKey({ key: 'r' }), 'a bare r is TYPING — the most important negative in this list');
ok(!isReloadKey({ key: 'R', shiftKey: true }), 'and so is a capital R');
ok(!isReloadKey({ key: 'F5', altKey: true }), 'Alt+anything is an OS accelerator, not ours');
ok(!isReloadKey({ key: 'F4', ctrlKey: true }), 'another function key');
ok(!isReloadKey(null), 'and nothing at all does not throw');

console.log('\n[the key is distinctive — same-origin iframes share this namespace]');
ok(TAB_SET_KEY.startsWith('hwb.shell.'), `only the shell writes hwb.shell.* (${TAB_SET_KEY})`);

console.log('\n[which pane a tab holds - mirrors solo.js paneid resolution]');
eq(paneidFromTabUrl('http://h:7420/solo.html?recipe=abc'), 'recipe:abc', 'first session of a project');
eq(paneidFromTabUrl('/solo.html?recipe=abc&pane=p-2'), 'p-2', 'an explicit ?pane= wins');
eq(paneidFromTabUrl('/manager.html'), null, 'the Manager is not a session');
eq(paneidFromTabUrl('/solo.html'), null, 'a session page with no identity is not endable');

console.log('\n[v21 bundle events route to the existing verbs]');
const calls = [];
const handlers = {
  closeView: (id, reason) => calls.push(`close:${id}:${reason}`),
  endSession: (id) => calls.push(`end:${id}`),
  refresh: (id) => calls.push(`refresh:${id}`),
};
eq(routeBundleEvent('hwb:close-view', { id: 't2', reason: 'user' }, handlers), 'close-view', 'close-view');
eq(routeBundleEvent('hwb:end-session', { id: 't3' }, handlers), 'end-session', 'end-session');
eq(routeBundleEvent('hwb:refresh', { id: 't4' }, handlers), 'refresh', 'refresh');
eq(calls.join(','), 'close:t2:user,end:t3,refresh:t4', 'each reached its handler with the tab id');
eq(routeBundleEvent('hwb:refresh', {}, handlers), null, 'an event without an id is ignored');
eq(routeBundleEvent('hwb:unknown', { id: 't1' }, handlers), null, 'an unknown event is ignored');
eq(calls.length, 3, 'and neither called anything');
eq(BUNDLE_EVENTS.length, 3, 'the shell listens for exactly the three wiring-list events');

console.log('\n[v21 session-bar icons forward to the tab page]');
eq(barActionFor('hwb:messages'), 'messages', 'messages icon -> openFabric in the page');
eq(barActionFor('hwb:handoff'), 'handoff', 'handoff icon -> openHandoff in the page');
eq(barActionFor('hwb:links'), 'links', 'links icon -> openLinks in the page');
eq(barActionFor('hwb:refresh'), null, 'a tab event is not a bar action');
eq(BAR_EVENTS.length, 3, 'exactly the three icons the bundle draws');

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
