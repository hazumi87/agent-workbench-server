/**
 * MODULE UI PATHS (src/server/modules/ui-paths.ts; ported from workbench-app test/module-ui-paths.test.mjs): the request-path rules for a module's
 * ui folder, /app/<modules|plugins>/<id>/ui/<rest>. A path becomes {id, rel, type} only when every check passes; the file is served only when its
 * realpath sits inside the module's ui folder (case-insensitive with a trailing separator on Windows). Pure: no http, no fs.
 */
import { isDeepStrictEqual } from 'node:util';
import { parseUiPath, inside, foldId, caseCollisions } from '../src/server/modules/ui-paths.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}
const M = (rest: string): ReturnType<typeof parseUiPath> => parseUiPath('modules', '/app/modules/tasks/' + rest);
const HTML = 'text/html; charset=utf-8';

console.log('\n[a plain module page parses to its id, ui-relative path and exact type]');
same(M('ui/preview.html'), { id: 'tasks', rel: 'ui/preview.html', type: HTML }, 'tasks/ui/preview.html');
same(parseUiPath('modules', '/app/modules/usage/ui/widget.js')?.type, 'text/javascript; charset=utf-8', '.js');
same(parseUiPath('modules', '/app/modules/usage/ui/widget.css')?.type, 'text/css; charset=utf-8', '.css');
same(parseUiPath('modules', '/app/modules/usage/ui/icons/ring.svg')?.type, 'image/svg+xml', '.svg in a subfolder');
same(parseUiPath('modules', '/app/modules/usage/ui/fonts/a.woff2')?.type, 'font/woff2', '.woff2');
same(parseUiPath('modules', '/app/modules/usage/ui/icons/ring.svg')?.rel, 'ui/icons/ring.svg', 'rel keeps the subfolder');

console.log('\n[the prefix is a parameter; a bundled id under plugins/ is still just parsed (the route decides)]');
same(parseUiPath('plugins', '/app/plugins/tasks/ui/preview.html'), { id: 'tasks', rel: 'ui/preview.html', type: HTML }, 'plugins prefix');
same(parseUiPath('plugins', '/app/plugins/usage/ui/widget.js'), { id: 'usage', rel: 'ui/widget.js', type: 'text/javascript; charset=utf-8' }, 'a bundled id under plugins/ parses');
ok(parseUiPath('plugins', '/app/modules/tasks/ui/preview.html') === null, 'the plugins prefix does not read a modules path');
ok(parseUiPath('modules', '/app/plugins/tasks/ui/preview.html') === null, 'the modules prefix does not read a plugins path');
ok(parseUiPath('other' as 'modules', '/app/other/tasks/ui/preview.html') === null, 'any other prefix is refused');

console.log('\n[refused: not the app path, ids that are not a module id, credentials, ports, paths outside ui/]');
for (const u of [
  '', '/', '/app/modules', '/app/modules/', '/app/modules//ui/a.html', 'app/modules/tasks/ui/a.html', '//app/modules/tasks/ui/a.html', '/app/module/tasks/ui/a.html',
  '/APP/modules/tasks/ui/a.html', '/app/Modules/tasks/ui/a.html', '/x/app/modules/tasks/ui/a.html', 'file:///ui/preview.html', 'http://tasks/ui/a.html', 'wbmod://tasks/ui/a.html',
  '/app/modules/Tasks/ui/a.html', // an upper-case id never matches; the route folds first if it wants to
  '/app/modules/1tasks/ui/a.html', '/app/modules/ta_sks/ui/a.html', '/app/modules/' + 'a'.repeat(42) + '/ui/a.html',
  '/app/modules/u:p@tasks/ui/a.html', '/app/modules/tasks:80/ui/a.html', '/app/modules/%74asks/ui/a.html', '/app/modules/../ui/a.html', '/app/modules/./ui/a.html',
  '/app/modules/tasks', '/app/modules/tasks/', '/app/modules/tasks/ui/', '/app/modules/tasks/ui', '/app/modules/tasks/index.js', '/app/modules/tasks/module.json', '/app/modules/tasks/uix/a.html',
  '/app/modules/tasks/ui/a.html?surface=window', '/app/modules/tasks/ui/a.html#x',
]) ok(parseUiPath('modules', u) === null, 'refused ' + JSON.stringify(u));
ok(parseUiPath('modules', 'x'.repeat(2049)) === null && parseUiPath('modules', 5 as unknown as string) === null, 'a path over 2048 characters, or not a string');

console.log('\n[refused: every path shape on the Windows list]');
for (const rest of [
  'ui/../index.js', 'ui/./a.html', 'ui//a.html', 'ui/a/../../b.html',
  'ui/%2e%2e/index.js', 'ui/%2E%2E/index.js', 'ui/%2fa.html', 'ui/%2Fa.html', 'ui/a%5cb.html', 'ui/a%5Cb.html', 'ui/%252e%252e/a.html', 'ui/a%00.html',
  'ui/a\\b.html', 'ui\\a.html',
  'ui/a.html:stream', 'ui/a.html::$DATA',
  'ui/PROGRA~1/a.html', 'ui/ABCDEF~2.HTM',
  'ui/a.html.', 'ui/a.html ', 'ui/dir./a.html', 'ui/dir /a.html', 'ui/a.html%20', 'ui/a.html%2e',
  'ui/con.html', 'ui/CON', 'ui/nul.js', 'ui/aux/a.html', 'ui/prn.css', 'ui/com1.js', 'ui/COM9.html', 'ui/lpt1.css', 'ui/Lpt9/a.js',
  'ui/a.htm', 'ui/a.json', 'ui/a.mjs', 'ui/a', 'ui/.env', 'ui/a.HTML',
]) {
  ok(M(rest) === null, 'modules ' + rest);
  ok(parseUiPath('plugins', '/app/plugins/tasks/' + rest) === null, 'plugins ' + rest);
}

console.log('\n[parseUiPath: dot segments, encoded dots and separators, backslash, device names, a trailing dot, a wrong extension, not under ui/]');
ok(M('ui/..') === null && M('ui/.') === null && M('ui/a/./b.html') === null && M('ui/a/../b.html') === null, 'dot segments');
ok(M('ui/%2e/a.html') === null && M('ui/a/%2E%2e/b.html') === null && M('ui/.%2e/a.html') === null, '%2e in any case');
ok(M('ui/a%2fb.html') === null && M('ui/a%2Fb.html') === null && M('ui/a%5cb.html') === null && M('ui/a%5Cb.html') === null, '%2f and %5c in any case');
ok(M('ui/a\\..\\b.html') === null && M('ui/a\\b.html') === null, 'a backslash');
ok(M('ui/con') === null && M('ui/CON.html') === null && M('ui/nul/a.css') === null && M('ui/COM1.js') === null && M('ui/lpt0.svg') === null && M('ui/sub/aux.html') === null, 'device names, anywhere in the path');
ok(M('ui/con1.html') !== null && M('ui/console.html') !== null && M('ui/com10.html') !== null, 'a name that only STARTS like a device is fine (con1, console, com10)');
ok(M('ui/a.html.') === null && M('ui/sub./a.html') === null && M('ui/a.css ') === null, 'a trailing dot or space');
ok(M('ui/a.txt') === null && M('ui/a.php') === null && M('ui/a.png') === null && M('ui/a.html.js.map') === null && M('ui/Makefile') === null, 'a wrong or missing extension');
ok(M('ui/a.JS') === null && M('ui/a.Css') === null, 'the extension is exact and lower case');
ok(M('index.html') === null && M('uix/a.html') === null && M('UI/a.html') === null && M('x/ui/a.html') === null && M('a.html') === null, 'not under ui/');
ok(M('ui') === null && M('ui/') === null, 'the folder itself is not a file');

console.log('\n[a percent sign that is not one of the refused encodings is decoded once]');
same(M('ui/a%20b.html'), { id: 'tasks', rel: 'ui/a b.html', type: HTML }, 'a%20b decodes to a space');
ok(M('ui/a%zz.html') === null, 'a malformed escape is refused');
ok(M('ui/a%25b.html') === null, '%25 (a double-encoding step) is refused');

console.log('\n[containment: the realpath must be inside the ui folder, with a trailing separator]');
ok(inside('/m/tasks/ui', '/m/tasks/ui/preview.html', 'linux') === true, 'a file inside');
ok(inside('/m/tasks/ui', '/m/tasks/ui', 'linux') === false, 'the folder itself is not inside');
ok(inside('/m/tasks/ui', '/m/tasks/uix/preview.html', 'linux') === false, 'a sibling with the same prefix');
ok(inside('/m/tasks/ui', '/m/tasks/index.js', 'linux') === false, 'a file outside');
ok(inside('/m/tasks/ui', '/m/tasks/UI/preview.html', 'linux') === false, 'case counts on Linux');
ok(inside('C:\\m\\tasks\\ui', 'c:\\M\\Tasks\\UI\\preview.html', 'win32') === true, 'and not on Windows');
ok(inside('C:\\m\\tasks\\ui', 'C:\\m\\tasks\\uix\\a.html', 'win32') === false, 'a Windows sibling with the same prefix');
ok(inside('C:\\m\\tasks\\ui\\', 'C:\\m\\tasks\\ui\\a.html', 'win32') === true, 'a root given with its separator');
ok(inside('/m/tasks/ui/', '/m/tasks/ui/a.html', 'linux') === true, 'a POSIX root given with its separator');

console.log('\n[module ids are matched case-folded; two catalog ids that differ only by case are a collision]');
ok(foldId('Tasks') === 'tasks', 'foldId lower-cases');
same(caseCollisions(['tasks', 'usage', 'Tasks', 'voice', 'USAGE']), ['Tasks', 'USAGE'], 'the later spelling is the collision');
same(caseCollisions(['tasks', 'usage']), [], 'no collision');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
