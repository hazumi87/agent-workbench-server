/* APP DIALOG path + request validation, the room page's half [ticket].
 *
 *   node test/room-app-dialog.test.mjs
 *
 * web/room-app-dialog.mjs is pure (no DOM, no imports), so it runs here AS
 * SHIPPED. What it must hold: a dialog frames the panel's OWN app, under the
 * panel's frame directory, through the same proxy + token; never another
 * app, the engine, or another origin. No backslash typed in this file: it is
 * built with String.fromCharCode(92).
 */
import { dialogPath, dialogUrl, cleanDialog } from '../web/room-app-dialog.mjs';

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
const BASE = 'https://host.example.ts.net:8444/room.html?room=r1';
const FRAME = '/api/rooms/r1/panels/p1/frame/t/abc123.999/';
const DIR = '/api/rooms/r1/panels/p1/frame/t/abc123.999/';

/* ---- accepted: relative paths under the panel's directory ---- */
for (const p of ['review/2', 'form.html', 'items/42/edit?tab=a#top', 'a/b/c', 'x.y', '...', 'a..b', 'rate?x=../y']) {
  ok(dialogPath(p) === p, `accepted: ${JSON.stringify(p)}`, dialogPath(p));
}
ok(dialogUrl(FRAME, 'review/2', BASE) === `${DIR}review/2`, 'dialogUrl: frame dir + path', dialogUrl(FRAME, 'review/2', BASE));
ok(dialogUrl(FRAME, 'items/42/edit?tab=a#top', BASE) === `${DIR}items/42/edit?tab=a#top`, 'dialogUrl keeps the query and hash');
ok(dialogUrl('/api/rooms/r1/panels/p1/frame/t/tok/view', 'dlg', BASE) === '/api/rooms/r1/panels/p1/frame/t/tok/dlg', "a frameUrl naming a file: the path is under that file's directory");

/* ---- refused ---- */
const BAD = [
  ['', 'empty'],
  ['x'.repeat(201), 'over 200 characters'],
  ['https://evil.example/x', 'an absolute URL'],
  ['http:x', 'a scheme without slashes'],
  ['javascript:alert(1)', 'javascript:'],
  ['data:text/html,x', 'data:'],
  ['//evil.example/x', 'protocol-relative'],
  ['/api/rooms/r1', 'an absolute path (the engine)'],
  ['/api/rooms/r1/panels/p2/frame/t/tok/', "an absolute path (another panel's frame)"],
  ['../p2/frame/', "'..' first"],
  ['a/../../x', "'..' inside"],
  ['a/..', "'..' last"],
  ['./x', "'.' segment"],
  ['a/./b', "'.' inside"],
  ['%2e%2e/x', "'%2e%2e'"],
  ['%2E%2E/x', "'%2E%2E'"],
  ['.%2E/x', "'.%2E'"],
  ['%2e./x', "'%2e.'"],
  ['%2e/x', "'%2e' (an encoded '.')"],
  ['a%2f..%2fb', "an encoded '/' in a segment"],
  ['a%2F..%2Fx', "an encoded '/' (upper case)"],
  [`a${BS}b`, 'a backslash'],
  [`${BS}${BS}evil.example${BS}x`, 'a UNC-ish backslash path'],
  ['a%5cb', "an encoded backslash"],
  ['a%zz', 'a malformed escape'],
  ['a b', 'a space'],
  ['a' + String.fromCharCode(10) + 'b', 'a newline'],
  ['a' + String.fromCharCode(9) + 'b', 'a tab'],
  ['?x=1', 'only a query'],
  ['#top', 'only a hash'],
];
for (const [p, why] of BAD) {
  ok(dialogPath(p) === null, `refused: ${why}`, dialogPath(p));
  ok(dialogUrl(FRAME, p, BASE) === null, `dialogUrl refuses: ${why}`);
}
for (const p of [null, undefined, 42, {}, ['a']]) {
  ok(dialogPath(p) === null, `refused: a non-string ${JSON.stringify(p) ?? 'undefined'}`);
}
ok(dialogUrl(42, 'a', BASE) === null, 'dialogUrl: a non-string frameUrl is refused');

/* ---- the whole request ---- */
let r = cleanDialog({ panel: 'dialog', path: 'form.html' }, FRAME, BASE);
ok(r.ok && r.size === 'md' && r.title === '' && r.url === `${DIR}form.html` && r.path === 'form.html', 'defaults: size md, no title', r);
r = cleanDialog({ panel: 'dialog', path: 'form.html', title: '  Rate ' + String.fromCharCode(10) + ' shoes  ', size: 'lg' }, FRAME, BASE);
ok(r.ok && r.size === 'lg' && r.title === 'Rate shoes', 'title folded + trimmed; size lg', r);
r = cleanDialog({ path: 'f', title: 'y'.repeat(200) }, FRAME, BASE);
ok(r.ok && r.title.length === 80, 'title capped at 80', r.title?.length);
ok(cleanDialog({ path: 'f', size: 'xl' }, FRAME, BASE).error === 'bad size', "size 'xl' is refused");
ok(cleanDialog({ path: 'f', size: 3 }, FRAME, BASE).error === 'bad size', 'a numeric size is refused');
ok(cleanDialog({ path: 'f', title: 5 }, FRAME, BASE).error === 'bad title', 'a non-string title is refused');
ok(cleanDialog({ path: '../x' }, FRAME, BASE).error === 'bad path', "'../x' answers 'bad path'");
ok(cleanDialog({ path: 'https://x/' }, FRAME, BASE).error === 'bad path', "an absolute URL answers 'bad path'");
ok(cleanDialog({}, FRAME, BASE).error === 'bad path', "no path answers 'bad path'");
ok(cleanDialog(null, FRAME, BASE).error === 'bad request', "no object answers 'bad request'");

console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
