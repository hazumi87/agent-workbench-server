/**
 * DRAG-TO-REORDER logic of the composer tray (Owner 2026-10-04, room): the pure helpers of
 * web/room-attach.mjs. Where a held tile lands, which tiles slide aside, the renumbering a move
 * implies, a no-op drop and a cancel (a cancel never calls moveItem: the order is untouched).
 * The pointer/DOM half is checked in a real browser by the builder's harness; the engine half
 * (PUT .../scratch/order) is in room-attach.test.mjs.
 */
import { sortTarget, shiftOf, moveItem } from '../web/room-attach.mjs';

let passed = 0;
let failed = 0;
const eq = (a, b, msg) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x === y) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg} (got ${x}, want ${y})`);
  }
};

// four 64px tiles, 8px gap: centers 32, 104, 176, 248
const centers = [32, 104, 176, 248];
eq(sortTarget(centers, 0, 32), 0, 'not moved: stays at its own slot');
eq(sortTarget(centers, 0, 104 + 1), 1, 'dragged past the next tile center: one slot right');
eq(sortTarget(centers, 0, 400), 3, 'dragged past the end: the last slot');
eq(sortTarget(centers, 3, -50), 0, 'dragged before the start: the first slot');
eq(sortTarget(centers, 2, 104 - 1), 1, 'left, just under the previous center: slot 1');
eq(sortTarget(centers, 2, 176), 2, 'back over its own place: no move');

eq([0, 1, 2, 3].map((j) => shiftOf(j, 0, 2)), [0, -1, -1, 0], 'moving 0 -> 2: tiles 1,2 slide left');
eq([0, 1, 2, 3].map((j) => shiftOf(j, 3, 1)), [0, 1, 1, 0], 'moving 3 -> 1: tiles 1,2 slide right');
eq([0, 1, 2, 3].map((j) => shiftOf(j, 2, 2)), [0, 0, 0, 0], 'over its own slot: nothing slides');

eq(moveItem(['n', 'a', 'b'], 0, 2), ['a', 'b', 'n'], 'notes doc dragged to the end: renumbered 1,2,3 = a,b,n');
eq(moveItem(['a', 'b', 'n'], 2, 0), ['n', 'a', 'b'], 'notes doc added last, dragged first');
eq(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c'], 'a drop on its own slot: the same order');
eq(moveItem(['a', 'b'], 5, 0), ['a', 'b'], 'a bad index changes nothing');
const src = ['a', 'b', 'c'];
moveItem(src, 0, 2);
eq(src, ['a', 'b', 'c'], 'the input is never mutated (a cancel leaves the order alone)');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
