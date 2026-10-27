// [approval ask] Owner 2026-10-12 ([ref] / [ref]): an agent's `APPROVAL:` line gets Approve / Cancel under it.
// Pure parts run for real; the page wiring is checked on source, as test/room-held-notice-web.test.mjs does.
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const room = read('../web/room.js');
const reply = read('../web/room-reply.mjs');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
const slice = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

// the module imports '/room-reply.mjs' (a page path): serve it from disk for this test
const mod = read('../web/room-approval.mjs').replace("'/room-reply.mjs'", `'${new URL('../web/room-reply.mjs', import.meta.url).href.replace('room-reply.mjs', 'room-reply-stub.mjs')}'`);
const stub = "export const replyOfEntry = (e) => { try { const m = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta; return m?.reply ?? null; } catch { return null; } };";
const dataUrl = (src) => `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
const stubUrl = dataUrl(stub);
const { approvalAsk, approvalAnswered } = await import(dataUrl(mod.replace(/'file:[^']*room-reply-stub\.mjs'/, `'${stubUrl}'`)));

console.log('[what is an ask]');
const seatLine = (body, extra = {}) => ({ id: 10, kind: 'chat', author: 'homehub', author_seat: 's1', body, ...extra });
ok(approvalAsk(seatLine('APPROVAL: push 3 commits to main')) === 'push 3 commits to main', 'a seat line "APPROVAL: x" is an ask for x');
ok(approvalAsk(seatLine('@user APPROVAL: restart the app')) === 'restart the app', 'after a leading @address too');
ok(approvalAsk(seatLine('approval: lower case')) === 'lower case', 'case does not matter');
ok(approvalAsk(seatLine('I need your approval to push')) === null, 'prose is not an ask');
ok(approvalAsk(seatLine('APPROVAL:')) === null, 'an empty ask is not one');
ok(approvalAsk({ id: 1, kind: 'chat', author: 'user', body: 'APPROVAL: x' }) === null, "the person's own line is never an ask");
ok(approvalAsk(seatLine('APPROVAL: x', { kind: 'fact' })) === null, 'a fact is never an ask');
ok(approvalAsk(seatLine('APPROVAL: x', { author_seat: null })) === null, 'a line with no seat behind it is never an ask');

console.log('[answered]');
const reply1 = { id: 11, author: 'user', meta: { reply: { id: 10, excerpt: 'APPROVAL: x' } } };
ok(approvalAnswered([reply1], 10) === true, "the person's reply to the line answers it");
ok(approvalAnswered([{ ...reply1, author: 'homehub' }], 10) === false, "a seat's reply does not");
ok(approvalAnswered([{ ...reply1, meta: { reply: { id: 99, excerpt: 'x' } } }], 10) === false, "a reply to another line does not");
ok(approvalAnswered([{ ...reply1, meta: JSON.stringify(reply1.meta) }], 10) === true, 'a stored (string) meta counts');
ok(approvalAnswered([], 10) === false, 'no reply: still open');

console.log('[the page]');
const paint = slice(room, 'function paintApproval(li, e)', 'function repaintApprovals');
ok(paint.includes("runCommand('Approved.', undefined, e.id)"), 'Approve posts "Approved." as a reply to the line');
ok(paint.includes('replyUi?.start(e)'), 'Cancel opens the composer replying to the line');
ok(paint.includes('reads.before(plate)'), 'the plate sits under the bubble, above the read line');
ok(slice(room, 'async function runCommand', 'if (b.status') .includes('reply_to: replyTo') || room.includes('...(replyTo ? { reply_to: replyTo } : {})'), 'runCommand can carry reply_to (and still keeps the draft)');
ok(room.includes('repaintApprovals(); // [approval ask]'), 'new lines re-check every open plate');
ok(reply.includes('start: startReply'), 'the reply module lets the page start a reply');
ok(room.includes("replyUi?.start(e)") && !room.includes('approvalPlate(') === false, 'plate is built by the module');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
