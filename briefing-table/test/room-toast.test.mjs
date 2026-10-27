/* THE ROOM TOAST (the design system room-toast-v1, hub v2 2026-10-05): source-slice checks for web/room-toast.mjs/.css and the
   sites that now go through it. Behavior is exercised in a harness (scratchpad); this guards the contract. */
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok  ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };

const js = read('room-toast.mjs');
const css = read('room-toast.css');
console.log('[module]');
ok(/export function toast\(text, o = \{\}\)/.test(js), 'one entry point: toast(text, { action, kind, ms })');
ok(js.includes('const LIFE = 4000') && js.includes('const LIFE_LONG = 8000') && js.includes('const LEAVE_MS = 2500') && js.includes('const GAP = 6'), '4 s plain, 8 s with an action or an error, 2.5 s after the pointer leaves, 6px stack gap');
ok(js.includes("o.action || o.kind === 'error' ? LIFE_LONG : LIFE"), 'the life rule');
ok(js.includes("['.ph-hdr', '.rm-top']") && js.includes('r.bottom') && js.includes('headerBottom() + 8'), 'top = the header\'s measured bottom + 8px (never a hard-coded 56)');
ok(js.includes("first.o.action && !o.action") && js.includes('list.slice().forEach(remove)'), 'an action toast is never pushed out by a plain one; the pair never grows past two');
ok(js.includes("role', err ? 'alert' : 'status'") && js.includes("'bang'"), 'error: role=alert and the "!" disc');
ok(js.includes('< 0.03') && js.includes('neutral') , 'a neutral room (chroma < .03) gets the neutral class');
ok(js.includes("'pointerenter'") && js.includes("'focusin'") && js.includes("e.key === 'Escape'"), 'hover and focus pause; Esc dismisses');
ok(js.includes('dx > 60') && js.includes("e.pointerType === 'touch'"), 'a swipe right dismisses on a phone');
ok(js.includes('catch((e) => { toast('), 'an action that throws is shown, never swallowed');
console.log('[css]');
let depth = 0;
let bad = false;
for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) { depth += ch === '{' ? 1 : ch === '}' ? -1 : 0; if (depth < 0) bad = true; }
ok(depth === 0 && !bad, 'braces balance');
ok(css.includes('oklch(from var(--room-c) .30 clamp(.045, calc(c * .5), .07) calc(h + 180))') && css.includes('oklch(from var(--room-c) .46 clamp(.05, calc(c * .55), .09) calc(h + 180))'), 'the complementary wash and edge');
ok(css.includes('oklch(from var(--coral) .29 .07 h)') && css.includes('color-mix(in srgb, var(--coral) 60%, transparent)'), 'error: coral wash and 60% edge');
ok(css.includes('oklch(from var(--sky) .30 .05 h)'), 'neutral: sky wash');
ok(/max-width:\s*600px\)\s*\{[^}]*\.rm-toast\s*\{[^}]*left:\s*8px;\s*right:\s*8px[^}]*min-height:\s*48px/.test(css) && css.includes('min-height: 44px; min-width: 44px'), 'phone: 8px margins, 48px tall, 44px targets');
ok(/prefers-reduced-motion[\s\S]*opacity \.15s/.test(css), 'reduced motion: a 150 ms fade');
ok(read('room.html').includes('/room-toast.css'), 'room.html loads it');
console.log('[sites]');
const seat = read('room-seat-menu.mjs');
ok(!/rsm-toast|toastEl/.test(seat) && !/rsm-toast/.test(read('room.css')) && !/wg-toast/.test(read('room-workgroups.css')), 'the old ad-hoc toast and its CSS are gone');
ok(read('room-notes.mjs').includes("import('/room-toast.mjs')") && read('room-notes.mjs').includes("ms: err ? 5000 : 2200"), 'Notes goes through it and keeps its short life');
ok(read('room-tool-links.mjs').includes("roomToast(text, { ms: 1500 })"), 'tool links go through it');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
