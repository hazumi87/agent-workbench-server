/* HIDDEN FACTS ON THE ROOM PAGE (Owner [ref], toolkit [ref]): addEntries draws nothing
 * for a fact marked hidden (the floor's "closed" fact), on a GET, a re-GET or a room.line
 * push alike, so it can never reach any filter. A SOURCE-LEVEL check: it reads web/room.js
 * and runs the skip guard on the shapes the engine writes. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room.js'), 'utf8');
let passed = 0;
let failed = 0;
const ok = (c, m) => (c ? (passed++, console.log(`  ok ${m}`)) : (failed++, console.log(`  FAIL ${m}`)));

const body = src.slice(src.indexOf('function addEntries(list) {'), src.indexOf('function addEntries(list) {') + 2500);
ok(body.includes("e.kind === 'fact' && (lineMeta(e)?.hidden === true"), 'addEntries carries the hidden-fact guard');
ok(/lineMeta\(e\)\?\.hidden === true/.test(body), '...it checks meta.hidden === true');
ok(/turn\?\.kind === 'closed'/.test(body), "...and still the floor's closed fact by shape (an engine from before `hidden`)");
const lineMeta = (e) => (typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta);
const skipped = (e) => e.kind === 'fact' && (lineMeta(e)?.hidden === true || lineMeta(e)?.turn?.kind === 'closed');
ok(skipped({ kind: 'fact', meta: '{"turn":{"thread":1,"kind":"closed"},"hidden":true}' }), 'the closed fact as the engine stores it (meta as a string) is skipped');
ok(skipped({ kind: 'fact', meta: { hidden: true } }), 'any fact marked hidden is skipped');
ok(!skipped({ kind: 'fact', meta: '{"turn":{"thread":1,"seat":"s","lines":[2],"kind":"floor"}}' }), 'a floor fact is still drawn');
ok(!skipped({ kind: 'chat', meta: '{"hidden":true}' }), 'a chat line is never skipped by this guard');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
