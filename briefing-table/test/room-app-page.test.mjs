/* APP FULL PAGE, the pure half [ticket]: what an app may declare and ask
 * ({panel:'page'} / {panel:'open-page'}), the gate, the address of
 * /room-app.html, its query validation and the title rule.
 *
 *   node test/room-app-page.test.mjs
 *
 * web/room-app-dialog.mjs is pure, so it runs here AS SHIPPED. The cell's
 * control, the phone rule and the page's answers are proved in a browser by
 * test/room-app-page.probe.mjs. No backslash typed here (String.fromCharCode).
 */
import {
  cleanPageDecl, cleanPageRequest, askGate, pageTabUrl, parsePageQuery, pageDocTitle, pageUrl, pageTitle, PAGE_UNAVAILABLE,
} from '../web/room-app-dialog.mjs';

let passed = 0;
let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${msg}`);
  } else {
    failed += 1;
    console.log(` FAIL  ${msg}${detail !== undefined ? `  (${JSON.stringify(detail)})` : ''}`);
  }
};
const BS = String.fromCharCode(92);
const BASE = 'https://h.example/room.html?room=r1';
const FRAME = '/api/rooms/r1/panels/p1/frame/t/abc.1/';

/* ---- {panel:'page'}: declare / withdraw ---- */
ok(JSON.stringify(cleanPageDecl({ enabled: true }, FRAME, BASE)) === '{"enabled":true,"path":"","title":"Full view"}', 'declare with nothing: root view, "Full view"');
ok(JSON.stringify(cleanPageDecl({ enabled: true, path: 'full', title: '  Review   it ' }, FRAME, BASE)) === '{"enabled":true,"path":"full","title":"Review it"}', 'declare path + title (folded, trimmed)');
ok(cleanPageDecl({ enabled: false }, FRAME, BASE)?.enabled === false, 'enabled:false withdraws');
ok(cleanPageDecl({ enabled: 'yes' }, FRAME, BASE) === null && cleanPageDecl({}, FRAME, BASE) === null && cleanPageDecl(null, FRAME, BASE) === null, 'anything but a boolean enabled is ignored');
for (const p of ['/x', '//evil/x', '../x', 'a/../b', 'https://evil/x', `a${BS}b`, '%2e%2e/x', '?q=1', 'a b']) {
  ok(cleanPageDecl({ enabled: true, path: p }, FRAME, BASE) === null, `declare with a bad path is ignored: ${JSON.stringify(p)}`);
}
ok(cleanPageDecl({ enabled: true, title: 5 }, FRAME, BASE) === null, 'declare with a non-string title is ignored');
ok(cleanPageDecl({ enabled: true, title: 'x'.repeat(90) }, FRAME, BASE).title.length === 40, 'a title is capped at 40');
ok(pageTitle(undefined) === '' && pageTitle(' ') === '' && pageTitle(null) === null, 'pageTitle: none = empty, non-string = null');

/* ---- {panel:'open-page'} ---- */
const decl = { path: 'full', title: 'Review' };
ok(JSON.stringify(cleanPageRequest({}, FRAME, BASE, decl)) === '{"ok":true,"path":"full","title":"Review"}', 'no path/title: the declared ones');
ok(JSON.stringify(cleanPageRequest({}, FRAME, BASE, null)) === '{"ok":true,"path":"","title":"Full view"}', 'no declaration either: root view, "Full view"');
ok(JSON.stringify(cleanPageRequest({ path: 'items/7', title: 'Item 7' }, FRAME, BASE, decl)) === '{"ok":true,"path":"items/7","title":"Item 7"}', 'its own place and title');
ok(cleanPageRequest({ path: 'items/7' }, FRAME, BASE, decl).title === 'Full view', 'a new place without a title does not borrow the declared title');
ok(cleanPageRequest({ path: '' }, FRAME, BASE, decl).path === '', "path '' = the root view even when a path was declared");
ok(cleanPageRequest({ path: '../p2/' }, FRAME, BASE, decl).error === 'bad path', "'..' -> 'bad path'");
ok(cleanPageRequest({ path: '/api/rooms/r1' }, FRAME, BASE, decl).error === 'bad path', 'an absolute path -> bad path');
ok(cleanPageRequest({ path: 'a', title: 4 }, FRAME, BASE, decl).error === 'bad title', "a non-string title -> 'bad title'");
ok(cleanPageRequest(null, FRAME, BASE, decl).error === 'bad request', 'not an object -> bad request');

/* ---- the gate ---- */
ok(askGate(false, 10000, 0, 'enabled') === 'needs a click', 'no click');
ok(askGate(undefined, 10000, 0, 'enabled') === 'needs a click', 'no userActivation API counts as no click');
ok(askGate(true, 10100, 10000, 'enabled') === 'too fast', 'inside 500 ms');
ok(askGate(true, 10500, 10000, 'enabled') === null, 'at 500 ms');
ok(askGate(true, 10600, 0, 'held') === 'needs-approval', 'a held app');
ok(askGate(true, 10600, 0, 'unregistered') === 'not-registered', 'an unregistered app');
ok(askGate(false, 10100, 10000, 'held') === 'needs a click', 'the click is judged first');

/* ---- the address and its query ---- */
const u = pageTabUrl('r1', 'p1', 'items/7?x=1&y=2', 'A & B');
ok(u.startsWith('/room-app.html?room=r1&panel=p1&'), 'page url shape', u);
const back = parsePageQuery(u.slice(u.indexOf('?')));
ok(back.ok && back.path === 'items/7?x=1&y=2' && back.title === 'A & B', 'path and title round-trip through the encoding', back);
ok(pageTabUrl('r1', 'p1', '', '') === '/room-app.html?room=r1&panel=p1', 'no path/title: only the ids');
ok(parsePageQuery('?room=r1&panel=p1').title === 'Full view', 'query without a title: Full view');
for (const q of ['', '?room=r1', '?panel=p1', '?room=a/b&panel=p1', '?room=r1&panel=..', '?room=r1&panel=p1&path=../x', '?room=r1&panel=p1&path=//evil', `?room=r1&panel=p1&path=a${BS}b`, '?room=r1&panel=p1&path=https://evil/x', `?room=${'x'.repeat(65)}&panel=p1`]) {
  ok(parsePageQuery(q).ok === false, `refused: ${q.slice(0, 50)}`);
}
ok(pageUrl(FRAME, '', BASE) === FRAME, "pageUrl '' = the frame itself");
ok(pageUrl(FRAME, 'full', BASE) === `${FRAME}full`, 'pageUrl: frame dir + path');
ok(pageUrl(FRAME, '../p2/', BASE) === null, 'pageUrl refuses an escape');

/* ---- the title rule ---- */
const t = pageDocTitle('Review', 'Image Studio', 'Alpha-Platform Apps');
ok(t === 'Review | Image Studio | Alpha-Platform Apps', 'view | app | room', t);
ok(!t.startsWith('Alpha-Platform Apps'), 'never starts with the room name');

/* ---- room-only messages are answered ---- */
ok(PAGE_UNAVAILABLE.dialog[0] === 'dialog-result' && PAGE_UNAVAILABLE.note[0] === 'note' && PAGE_UNAVAILABLE.dialog[1] === 'not available in a full page', 'dialog and note asks have documented refusals');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
