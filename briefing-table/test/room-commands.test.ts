/**
 * Room-command parser (the design notes §3, §6) [ticket] — fixture
 * driven. test/fixtures/room-commands.json is the table: one row per input and
 * its EXACT expected output. This suite adds only the coverage checks that
 * keep the table honest: every wr §2.5c verb has a row, both confirm forms
 * have rows, and so do @all, no-target unknown, carried unknown-with-target,
 * the two not-in-build verbs and the reserved handles.
 *
 * Pure: parse() touches no db, and its module imports only agent-slug and
 * room-vocab (asserted below from the source), so loading it loads no store.
 * A temp HARBOR_WB_TABLE is set before import anyway (trap 13), so a future
 * import regression still cannot reach data/mapping.db.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-commands-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_IDENTITY = 'legacy';

const { parse, ROOM_COMMANDS, NOT_IN_BUILD, editDistance, leadingAddress, isUserAddress, chatAddress, leadOnlyAddresses, droppedAddresses } = await import('../src/server/room-commands.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}

/** JSON with sorted keys, so deep equality ignores key order only. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val,
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'room-commands.json'), 'utf8')) as {
  seatSets: Record<string, Array<{ id: string; handle: string; is_lead: boolean }>>;
  cases: Array<{ note: string; input: string; seats: string; user?: string; unaddressedToLead?: boolean; expect: unknown }>;
};

console.log('\n[every fixture row parses to exactly its expected output]');
for (const c of fixture.cases) {
  const seats = fixture.seatSets[c.seats];
  if (!seats) {
    ok(false, `${c.note}: unknown seat set "${c.seats}"`);
    continue;
  }
  const got = parse(c.input, seats, { ...(c.user ? { userHandle: c.user } : {}), ...(c.unaddressedToLead === false ? { unaddressedToLead: false } : {}) });
  const same = canon(got) === canon(c.expect);
  ok(same, `${JSON.stringify(c.input)} — ${c.note}${same ? '' : `\n      expected ${canon(c.expect)}\n      got      ${canon(got)}`}`);
}

console.log('\n[the table covers what §6 says it must]');
const inputs = fixture.cases.map((c) => c.input.toLowerCase());
const has = (pred: (s: string) => boolean): boolean => inputs.some(pred);
// Every wr §2.5c verb.
for (const prefix of ['/set lead', '/set policy', '/rename room', '/rename @', '/add ', '/replace', '/remove', '/archive', '/reopen', '/seam', '/mode', '/voice', '/help']) {
  ok(has((s) => s.startsWith(prefix)), `a row for ${prefix.trim()}`);
}
// Every entry of the verb table (what /help and completion serve) is exercised.
for (const cmd of ROOM_COMMANDS) {
  ok(has((s) => s.startsWith(`/${cmd.word}`)), `verb table entry /${cmd.word} (${cmd.verb ?? cmd.class}) has a row`);
}
const expects = fixture.cases.map((c) => c.expect as Record<string, unknown>);
ok(expects.some((e) => e.verb === 'remove' && (e.args as { confirm?: boolean }).confirm === false), '/remove first form (confirm:false)');
ok(expects.some((e) => e.verb === 'remove' && (e.args as { confirm?: boolean }).confirm === true), '/remove typed confirm form');
ok(expects.some((e) => e.verb === 'archive' && (e.args as { confirm?: boolean }).confirm === false), '/archive first form');
ok(expects.some((e) => e.verb === 'archive' && (e.args as { confirm?: boolean }).confirm === true), '/archive typed confirm form');
ok(has((s) => /(^|\s)@all\b/.test(s)), 'an @all row');
ok(
  fixture.cases.some((c) => c.input.startsWith('/') && !c.input.includes('@') && (c.expect as { type: string }).type === 'refused' && /is not a room command/.test(String((c.expect as { error: string }).error))),
  'an unknown, no-target row refused with a suggestion',
);
ok(expects.some((e) => e.type === 'carried'), 'a carried unknown-with-target row');
ok(expects.filter((e) => e.error === NOT_IN_BUILD).length >= 2, '/seam and /voice answer not-in-build');
for (const h of ['room', 'lead', 'all', 'user']) {
  ok(has((s) => s.includes(`@${h}`)), `a row that uses the reserved handle @${h}`);
}

console.log('\n[a reply is addressed by its leading @ list only: leadOnlyAddresses (Owner [ref])]');
const AT = String.fromCharCode(0xff20);
ok(leadOnlyAddresses('@a @b do it') === '@a @b do it', 'a leading run is kept whole');
ok(leadOnlyAddresses('just text @a here') === `just text ${AT}a here`, 'no leading @: every @ is neutralised');
ok(leadOnlyAddresses('@a please, @b too') === `@a please, ${AT}b too`, 'the run ends at the first word that is not an address; later @s are neutralised');
ok(leadOnlyAddresses('  @a  hi @b') === `  @a  hi ${AT}b`, 'leading whitespace is kept');
ok(leadOnlyAddresses('') === '' && leadOnlyAddresses(null as unknown as string) === '', 'empty and null are safe');
const seatsAB = [{ id: 'sa', handle: 'a', is_lead: true }, { id: 'sb', handle: 'b' }] as never;
const via = (t: string) => { const r = parse(leadOnlyAddresses(t), seatsAB); return r.type === 'chat' ? String(r.to) : r.type; };
ok(via('@b please look') === 'sb' && via('done, @b please look') === 'sa', 'the parser delivers to a LEADING name; the same name in the middle of a reply is only text (the line falls to the default)');

console.log('\n[droppedAddresses: the seats a reply NAMED that its leading list did not address]');
const seatsABC = [{ id: 'sa', handle: 'a', is_lead: true }, { id: 'sb', handle: 'b' }, { id: 'sc', handle: 'c' }] as never;
const drop = (t: string) => droppedAddresses(t, seatsABC, { userHandle: 'owner' });
ok(JSON.stringify(drop('@b @c both of you')) === '[]', 'every name leads: nothing dropped');
ok(JSON.stringify(drop('done, @b please look')) === '["sb"]', 'a name in the middle of prose is dropped');
ok(JSON.stringify(drop('@owner ok.\n- @b do x\n- @c do y')) === '["sb","sc"]', 'after a leading @owner, the seats named lower down are dropped');
ok(JSON.stringify(drop('@b ok, and @c too')) === '["sc"]', 'only the ones after the leading run are dropped');
ok(JSON.stringify(drop('no names at all')) === '[]', 'no names: nothing dropped');
ok(JSON.stringify(drop('see `@b` in the code')) === '[]', 'a backticked name is not an address, so not dropped');
ok(JSON.stringify(drop('/help @b')) === '[]', 'a command is never a reply');

console.log('\n[/seat restart reaches a seat in the family (row 7)]');
const famMain = { inWorkgroup: false, headLead: null, seats: [{ id: 'sg', handle: 'grp-seat', is_lead: false }], aliases: [] } as never;
const rs = parse('/seat restart @grp-seat', seatsAB, { family: famMain });
ok(rs.type === 'room' && rs.verb === 'seat-restart' && (rs.target as { seatId: string }).seatId === 'sg', 'a workgroup seat resolves from the main room');
const rsNo = parse('/seat restart @grp-seat', seatsAB);
ok(rsNo.type === 'refused', 'with no family it is still "no such seat in this room"');

console.log('\n[the "/" list reads these rows: group and wording rules (auriga [ref])]');
const GROUPS = ['Floor', 'Seats', 'Room'];
const NOT_VERBS = new Set(['the', 'a', 'an', 'this', 'that', 'how', 'whether', 'what', 'which', 'one', 'your', 'its', 'it']);
for (const c of ROOM_COMMANDS) {
  const first = c.does.split(/\s+/)[0].toLowerCase();
  ok(
    GROUPS.includes(c.group) && c.does.length > 0 && c.does.length <= 60 && !/[.]$/.test(c.does) && /^[A-Z]/.test(c.does) && !NOT_VERBS.has(first),
    `${c.usage}: group ${c.group}, "${c.does}" (${c.does.length} chars: a verb first, sentence case, no final period, 60 or fewer)`,
  );
}
ok(new Set(ROOM_COMMANDS.map((c) => c.group)).size === 3, 'all three areas are used');

console.log('\n[helpers]');
ok(editDistance('remvoe', 'remove') === 1, 'an adjacent swap is one edit');
ok(editDistance('archiv', 'archive') === 1, 'a dropped letter is one edit');
ok(leadingAddress('@Auriga, hi') === 'auriga', 'leadingAddress lowercases and strips punctuation');
ok(leadingAddress('hi @auriga') === null, 'leadingAddress: a mid-sentence @ is not the address');
ok(leadingAddress('/remove @auriga') === null, 'leadingAddress: a command has no chat address');
ok(parse('/help', []).type === 'room', 'parse is pure: works with no seats');
const parserImports = [...readFileSync(join(here, '..', 'src', 'server', 'room-commands.ts'), 'utf8').matchAll(/^import[^;]*from '([^']+)'/gm)].map((m) => m[1]);
ok(
  parserImports.length > 0 && parserImports.every((m) => m === '../engine/agent-slug.ts' || m === '../engine/room-vocab.ts'),
  `parse is pure: the parser imports no store, endpoint or server module (${parserImports.join(', ')})`,
);
ok(canon(parse('  please review  ', fixture.seatSets.default)) === canon({ type: 'chat', to: 's-sketcher', leadDefault: true }), 'surrounding whitespace is ignored for parsing');

console.log('\n[to the user: isUserAddress + chatAddress, the one rule every post path stores by (2026-09-28)]');
{
  const d = fixture.seatSets.default;
  const us = fixture.seatSets.userseats;
  ok(isUserAddress('user', d, 'owner') && isUserAddress('owner', d, 'owner'), '@user and the user\'s @name both mean the user');
  ok(isUserAddress('user', d, null) && !isUserAddress('owner', d, null), 'with no @name known, only @user does');
  ok(!isUserAddress('user', us, 'owner') && !isUserAddress('owner', us, 'owner'), 'a seat with that handle wins');
  const at = (text: string, seats = d) => chatAddress(text, parse(text, seats, { userHandle: 'owner' }) as { toUser?: true }, seats, 'owner');
  ok(canon(at('@user hi')) === canon({ target: 'owner', toUser: 'owner', toUserMeta: true }), '"@user hi" is stored as target = the handle (normalised), no seat, to_user');
  ok(canon(at('@owner hi')) === canon({ target: 'owner', toUser: 'owner', toUserMeta: true }), '"@owner hi" the same');
  ok(canon(at('@owner @kiosk look')) === canon({ target: 'kiosk', toUser: null, toUserMeta: true }), 'the user + a seat: target is the seat, and to_user');
  ok(canon(at('@kiosk ask @user')) === canon({ target: 'kiosk', toUser: null, toUserMeta: true }), 'a seat, @user mid-text: target the seat, and to_user');
  ok(canon(at('over to @owner')) === canon({ target: null, toUser: null, toUserMeta: true }), 'unaddressed with @owner mid-text: no leading target (rooms.ts stores it with no seat), and to_user');
  ok(canon(at('just the lead')) === canon({ target: null, toUser: null, toUserMeta: false }), 'unaddressed, no mention: the lead default, not to_user');
  ok(canon(at('@user hi', us)) === canon({ target: 'user', toUser: null, toUserMeta: false }), 'a seat named user: an ordinary seat address');
}

console.log(`\n${'='.repeat(48)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
