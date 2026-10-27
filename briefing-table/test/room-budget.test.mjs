/**
 * THE RAIL HEIGHT BUDGET [ticket] (web/room-cells.mjs allocateHeights): the
 * open app cells share the rail's visible height. Pass 1 guarantees each its
 * glance (or min(reqPx, 180)), floored at 96, scaled down in proportion when
 * even that does not fit; pass 2 WATER-FILLS what is left: the cells still
 * short of their reqPx in ascending order of what each lacks, each filled
 * whole while it lasts, the first it cannot cover getting the remainder.
 * Reads the SHIPPED code: allocateHeights is lifted from web/room-cells.mjs
 * (the page module imports /app-status.mjs by an absolute URL, so it cannot be
 * imported under node). Nothing listens, nothing spawns.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (got ${a}, want ${e})`);
  }
}
function ok(cond, msg, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (${JSON.stringify(detail)})`);
  }
}

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room-cells.mjs'), 'utf8').replace(/\r\n/g, '\n'); // CRLF on a Windows (autocrlf) checkout
const fn = src.indexOf('export function allocateHeights(');
const end = src.indexOf('\n}\n', fn) + 3;
const { allocateHeights } = new Function(`${src.slice(fn, end).replace(/^export /gm, '')}; return { allocateHeights };`)();
const sum = (a) => a.reduce((s, x) => s + x, 0);
const A = (avail, cells) => allocateHeights(avail, cells, 96, 180);

console.log('\n[plenty of space]');
eq(A(2000, [{ reqPx: 600 }, { reqPx: 300 }, { reqPx: 180 }]), [600, 300, 180], 'everyone gets their reqPx');
eq(A(2000, [{ reqPx: 900, glance: 400 }]), [900], 'glance does not cap a cell with room to spare');
eq(A(2000, []), [], 'no cells: nothing');

console.log('\n[tight: glance first]');
let h = A(700, [{ reqPx: 900, glance: 400 }, { reqPx: 300 }]);
ok(h[0] >= 400 && h[1] >= 180, 'pass 1 honours the glance (400) and the default (180) first', h);
eq(sum(h), 700, '...and pass 2 fills the rest exactly (no gap)');
ok(h[0] <= 900 && h[1] <= 300, '...never past either reqPx', h);
eq(h, [400, 300], '...the SMALLER need (120) is filled whole first; the tall one keeps its glance');
eq(A(800, [{ reqPx: 900, glance: 400 }, { reqPx: 300 }]), [500, 300], '...then the larger need takes what remains');
h = A(580, [{ reqPx: 900, glance: 400 }, { reqPx: 300 }]);
eq(h, [400, 180], 'exactly pass 1\'s total: glance + default, nothing more');

console.log('\n[very tight: proportional, floored at min]');
h = A(390, [{ reqPx: 900, glance: 400 }, { reqPx: 300 }]);
ok(sum(h) === 390 && h.every((x) => x >= 96), 'scaled to fit, none below 96', h);
ok(Math.abs(h[0] / h[1] - 400 / 180) < 0.05, '...in proportion to pass 1 (400 : 180)', h);
h = A(300, [{ reqPx: 900, glance: 600 }, { reqPx: 200 }]);
eq(h, [204, 96], 'the small one floors at 96; the big one takes the rest');
h = A(100, [{ reqPx: 900, glance: 400 }, { reqPx: 300 }, { reqPx: 180 }]);
eq(h, [96, 96, 96], 'less than the floors: everyone at 96 (the rail scrolls)');
eq(A(-50, [{ reqPx: 300 }]), [96], 'a negative budget (seats taller than the rail): the floor');

console.log('\n[unused space goes only to clipped cells]');
h = A(1000, [{ reqPx: 900 }, { reqPx: 180 }, { reqPx: 120 }]);
eq(h, [700, 180, 120], 'the only clipped cell gets all of it');
h = A(1000, [{ reqPx: 1200 }, { reqPx: 1200 }]);
eq(h, [820, 180], 'two equal needs: order breaks the tie, the first takes the remainder (never past its ask)');
eq(A(1000, [{ reqPx: 1200 }, { reqPx: 250 }, { reqPx: 400 }]), [350, 250, 400], 'three clipped: the needs of 70 and 220 are filled whole, the largest (1020) gets what is left (170)');

console.log('\n[a short cell stays short]');
eq(A(900, [{ reqPx: 200 }, { reqPx: 900, glance: 400 }]), [200, 700], 'a short app (200) next to a tall clipped one shows WHOLE (its 20px need is filled first); the tall takes the rest');
eq(A(900, [{ reqPx: 200, glance: 200 }, { reqPx: 900, glance: 400 }]), [200, 700], '...the same with glance = its whole ask');
eq(A(590, [{ reqPx: 200 }, { reqPx: 900, glance: 400 }]), [190, 400], 'too little for the small need: it gets the remainder (10), the tall keeps its glance');
eq(A(1100, [{ reqPx: 200 }, { reqPx: 900, glance: 400 }]), [200, 900], 'room for both asks: 200 and 900, the rest unused');
eq(A(900, [{ reqPx: 40 }]), [96], 'an ask under the floor gets the floor (96), no more');
eq(A(900, [{ reqPx: 150 }]), [150], 'a 150px ask gets 150, not the 180 default');

console.log('\n[glance edge cases]');
eq(A(2000, [{ reqPx: 300, glance: 500 }]), [300], 'a glance over reqPx never lifts a cell past reqPx');
eq(A(276, [{ reqPx: 900, glance: 20 }, { reqPx: 900 }]), [96, 180], 'a glance under the floor is floored to 96 in pass 1');
eq(A(1000, [{ reqPx: 500, glance: 0 }]), [500], 'glance 0 is a valid (floored) glance');

console.log('\n[integers, no stray gap]');
for (const avail of [333, 517, 701, 999]) {
  h = A(avail, [{ reqPx: 777, glance: 311 }, { reqPx: 555 }, { reqPx: 1234, glance: 250 }]);
  ok(h.every(Number.isInteger) && (sum(h) === avail || h.every((x, i) => x === [777, 555, 1234][i])), `avail ${avail}: integers that sum to it`, h);
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
