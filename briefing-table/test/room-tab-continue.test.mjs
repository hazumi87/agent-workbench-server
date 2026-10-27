/* TAB TO CONTINUE (Owner 2026-10-03, room line [ref]): the suggestion picker (pure)
   and the source contract that Tab inserts only into an empty box. */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
// the module imports '/room-reply-all.mjs' (a page URL): rewrite it for node
const src = readFileSync(join(web, 'room-tab-continue.mjs'), 'utf8')
  .replace("'/room-reply-all.mjs'", JSON.stringify(pathToFileURL(join(web, 'room-reply-all.mjs')).href));
const { tabSuggestion: t } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const u = (id, body, kind = 'chat') => ({ id, author: 'user', author_seat: null, kind, body });
const meta = (e) => e.meta ?? null;
const a = (id, author, body, m) => ({ id, author, author_seat: 's-' + author, kind: 'chat', body, meta: m });
const base = { meta, handleOf: (id) => String(id).slice(2), seats: ['auriga', 'operator', 'lead-a'], leadHandle: 'lead-a', me: 'owner' };
eq('leading run', t({ ...base, entries: [u(1, '@auriga hi')] }), '@auriga ');
eq('two handles', t({ ...base, entries: [u(1, '@auriga @operator go')] }), '@auriga @operator ');
eq('newest of mine wins, order-independent', t({ ...base, entries: [u(5, '@operator x'), u(2, '@auriga y')] }), '@operator ');
eq('an agent line is not mine', t({ ...base, entries: [u(1, '@auriga a'), { id: 9, author: 'operator', author_seat: 's1', kind: 'chat', body: '@x' }] }), '@auriga ');
eq('mentions fallback', t({ ...base, entries: [u(1, 'thanks @auriga and @operator')] }), '@auriga @operator ');
eq('none', t({ ...base, entries: [u(1, 'plain words')] }), '');
eq('no entries', t({ ...base, entries: [] }), '');
eq('non-seat dropped', t({ ...base, entries: [u(1, '@nobody hi')] }), '');
eq('@all becomes @room', t({ ...base, entries: [u(1, '@all heads up')] }), '@room ');
eq('@lead resolves', t({ ...base, entries: [u(1, '@lead hi')] }), '@lead-a ');
eq('a command is not a chat line', t({ ...base, entries: [u(1, '/help @auriga', 'command')] }), '');
/* (b) who last replied to me */
eq('b: a seat reply to me, newer than my line', t({ ...base, entries: [u(1, '@auriga hi'), a(2, 'operator', 'done, cc @auriga', { reply: { user: true } })] }), '@operator @auriga ');
eq('b: older than my line loses', t({ ...base, entries: [a(1, 'operator', 'yes', { to_user: true }), u(2, '@auriga hi')] }), '@auriga ');
eq('b: @user mention counts, @owner too', t({ ...base, entries: [a(1, 'auriga', 'ping @user')] }), '@auriga ');
eq('b: @owner (my name) counts', t({ ...base, entries: [a(1, 'auriga', 'hey @owner')] }), '@auriga ');
eq('b: a seat line not to me is ignored', t({ ...base, entries: [u(1, '@auriga hi'), a(2, 'operator', 'chatter')] }), '@auriga ');
eq('b: alone, no line of mine', t({ ...base, entries: [a(3, 'operator', 'x', { to_user: true })] }), '@operator ');
eq('b: newest of several wins', t({ ...base, entries: [a(3, 'operator', 'x', { to_user: true }), a(5, 'auriga', 'y', { to_user: true })] }), '@auriga ');
const js = readFileSync(join(web, 'room.js'), 'utf8');
const tab = js.slice(js.indexOf("ev.key === 'Tab' && !ev.shiftKey"), js.indexOf('Enter on a handle that is ALREADY'));
eq('Tab inserts only when empty, unmodified, no menu', /input\.value === ''/.test(tab) && /!open/.test(tab) && /!ev\.ctrlKey/.test(tab), true);
eq('never on a phone and not under a reply chip', /phoneInput\(\)/.test(js.slice(js.indexOf('function currentTabSuggestion'), js.indexOf('function paintTabHint'))) && /\$\('reply'\)\.hidden/.test(js), true);
eq('the hint rides the placeholder, no overlay', /setAttribute\('placeholder'/.test(js) && !/inputGhost/.test(js), true);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
