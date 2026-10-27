// [held notice] Owner 2026-10-11 ([ref] / [ref]), the design system room-held-notice-v1 [ticket]: source slices for the
// plate under a person's held message. What a browser proves is in test/room-held-notice.probe.mjs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const room = read('../web/room.js');
const css = read('../web/room.css');
const tokens = readFileSync(new URL('../web/vendor/aurora-tokens.css', import.meta.url));
const rooms = read('../src/server/rooms.ts');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
const slice = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

console.log('[when the plate is due]');
const due = slice(room, 'function heldNoticeDue', 'async function runCommand');
ok(room.includes('const HELD_NOTICE_MS = 5000;'), 'the wait is 5 seconds');
ok(due.includes("e.author !== 'user'"), "only the person's own message");
ok(due.includes("x[0] === 'held'") && due.includes("?.occupant?.held?.reason === 'draft'"), 'only a seat that HOLDS it for a draft');
ok(due.includes('HELD_NOTICE_MS - (Date.now() - e.ts)') && due.includes('repaintReads()'), 'a hold that is not old enough schedules the repaint that says it');

console.log('[the plate]');
const plate = slice(room, 'function heldNotice(handles)', 'function paintHeldNotice');
ok(plate.includes("n.className = 'rm-notice'") && plate.includes("n.setAttribute('role', 'status')"), 'div.rm-notice, role=status');
ok(plate.includes('has not received this.`') && plate.includes("' Its input box may hold unsent text.'"), "one seat: Auriga's sentence");
ok(plate.includes('have not received this.`') && plate.includes("' Their input boxes may hold unsent text.'"), 'two seats and "N agents": the plural copy');
ok(plate.includes("act.className = 'rm-notice-act'") && plate.includes("act.textContent = 'Deliver'"), 'one button: Deliver');
ok(plate.includes("act.textContent = 'Sending…'") && plate.includes('act.disabled = true'), 'pressed: Sending…, disabled');
ok(plate.includes('runCommand(`/deliver @${h}`)') && plate.includes("!== 'applied'"), 'Deliver runs /deliver per held seat and returns to held unless applied');
ok(!plate.includes('innerHTML'), 'built with nodes, no innerHTML');
const paint = slice(room, 'function paintHeldNotice', 'function paintReads');
ok(paint.includes('reads.before(n)'), 'placed under the bubble, above the read line');
ok(paint.includes('n.dataset.sig === sig'), 'an unchanged plate is kept (a pressed button stays pressed)');
const reads = slice(room, 'function paintReads(li, reads)', 'function repaintReads');
ok(reads.includes('heldNoticeDue(entryId, at)') && reads.includes('paintHeldNotice(li, noticed)') && reads.includes('paintHeldNotice(li, [])'), 'paintReads puts it and takes it away');
ok(reads.includes('JSON.stringify([at, noticed])'), 'becoming due repaints the line');
ok(reads.includes('mine = mine.filter(([h]) => !noticed.includes(h))'), 'those seats leave the quiet held group');

console.log('[a command from a control]');
const cmd = slice(room, 'async function runCommand', 'function heldNotice(handles)');
ok(cmd.includes('keep_draft: true'), 'it sends keep_draft: the composer draft is not cleared');
ok(!cmd.includes('input.value'), "it never touches the composer's text");
ok(cmd.includes("showReply('confirm'") && cmd.includes("settle('cancelled')") && cmd.includes('MutationObserver'), 'a confirm waits for the person; a strip taken by anything else is a Cancel');
ok(rooms.includes("out.status !== 'confirm' && b.keep_draft !== true"), 'the engine keeps the draft on keep_draft');

console.log("[Auriga's look, verbatim, on pinned tokens]");
const block = slice(css, '/* ==== IMPLEMENT: NOTICE PLATE (web/room.css)', '/* ==== /IMPLEMENT');
ok(block.length > 400, "Auriga's IMPLEMENT block is in room.css");
ok(block.includes('--_bg: var(--notice-bg);') && block.includes('color: var(--notice-ink);'), 'the plate and its text use the notice tokens');
ok(!block.includes('#'), 'no raw colour in the block');
ok(block.includes('@media (max-width: 600px) { .rm-notice-act { min-height: 40px; } }'), 'the 40px touch floor on a phone');
ok(!css.includes('rd-held-notice') && !room.includes('rd-held-notice'), 'the provisional look is gone');
const text = tokens.toString('utf8');
ok(text.includes('--notice-bg:#FBBF24;') && text.includes('--notice-ink:#0C1014;') && text.includes('--notice-bg-stop:#FF5C4D;'), 'the three notice tokens are in the vendored pin');
const marker = Buffer.from('   ============================================================================ */\n\n');
const at = tokens.indexOf(marker);
const header = tokens.subarray(0, at + marker.length).toString('utf8');
const body = tokens.subarray(at + marker.length);
const want = (header.split('Body sha256: ')[1] ?? '').slice(0, 64);
ok(header.includes('(tokens VERSION 36)'), 'the pin header names tokens VERSION 36');
ok(want.length === 64 && createHash('sha256').update(body).digest('hex') === want, 'the vendored body matches the sha256 its header states (a verbatim pin)');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
