/* REPLY ALL (Owner 2026-10-03): the handle extraction + the prefix. Pure. */
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { replyAllHandles: r, replyAllPrefix: p } = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room-reply-all.mjs')).href
);
let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const seats = ['lead-a', 'builder', 'qa'];
const base = { seats, leadHandle: 'lead-a', me: 'owner' };
eq('author + mentions, in order', r({ ...base, author: 'builder', body: 'hey @qa and @lead-a' }), ['builder', 'qa', 'lead-a']);
eq('case-insensitive dedupe', r({ ...base, author: 'Builder', body: '@BUILDER @Qa @qa' }), ['builder', 'qa']);
eq('drops me and @user', r({ ...base, author: 'qa', body: '@owner @user @builder' }), ['qa', 'builder']);
eq('drops a non-seat', r({ ...base, author: 'qa', body: '@nobody @builder' }), ['qa', 'builder']);
eq('drops @all / @room beside others', r({ ...base, author: 'qa', body: '@all @room' }), ['qa']);
eq('@all alone is answered @room (the room refuses @all)', r({ ...base, author: null, body: 'ping @all' }), ['room']);
eq('my own line: the handles it referenced', r({ ...base, author: null, body: '@builder please, cc @qa' }), ['builder', 'qa']);
eq('my own line, nobody addressed', r({ ...base, author: null, body: 'plain' }), []);
eq('@lead resolves to the lead seat', r({ ...base, author: 'qa', body: '@lead' }), ['qa', 'lead-a']);
eq('an email is not a mention', r({ ...base, author: null, body: 'noreply@example.com' }), []);
eq('prefix', p(['a', 'b']), '@a @b ');
eq('empty prefix', p([]), '');
/* PHONE ZONING (Owner 2026-10-03): the source holds the contract (the real
   behavior is probed on a touch-emulated page; unit tests slice the source). */
import { readFileSync } from 'node:fs';
const web = (f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', f), 'utf8');
const css = web('room-reply.css');
eq('css: text selectable on touch', /\.entry-body \*[^}]*user-select: text/.test(css), true);
eq('css: row and gutter not selectable on touch', /\.rm-scroll, \.entry\.rp-line \{[^}]*user-select: none[^}]*touch-callout: none/.test(css), true);
eq('menu opener skips touch on the body', /!ev\.target\.closest\('\.entry-body'\)/.test(web('room-reply.mjs')), true);
console.log(`PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
