// [workbench order] the Show-all agent order: ROOT, then its own seats, then each GROUP, lead first then handle.
import { seatIndex, seatLabel, orderSeated } from '../web/workbench-order.mjs';
let passed = 0; let failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`, d ?? ''); } };
const room = (id, name, parent = null, extra = {}) => ({ id, name, state: 'open', parent_id: parent, lead_seat: null, ...extra });
const seat = (id, handle, pane, extra = {}) => ({ id, handle, left_at: null, occupant: { id: pane }, ...extra });
const rooms = [
  { room: room('B', 'Beta Root'), seats: [seat('b1', 'zed', 'pB-zed'), seat('b2', 'amy', 'pB-amy')] },
  { room: room('B1', 'Studio', 'B', { lead_seat: 'g2' }), seats: [seat('g1', 'aaa', 'pB1-aaa'), seat('g2', 'zzz-lead', 'pB1-lead')] },
  { room: room('A', 'Alpha Root', null, { lead_seat: 'a2' }), seats: [seat('a1', 'bob', 'pA-bob'), seat('a2', 'wes', 'pA-wes'), seat('a3', 'dup', 'pDup')] },
  { room: room('A2', 'Zeta Group', 'A'), seats: [seat('x1', 'dup', 'pA2-dup'), seat('x2', 'dup', 'pDup')] },
  { room: room('A1', 'Apps Group', 'A'), seats: [seat('y1', 'cat', 'pA1-cat'), seat('y2', 'gone', 'pA1-gone', { left_at: 5 })] },
  { room: room('C', 'Closed Root', null, { state: 'closed' }), seats: [seat('c1', 'cc', 'pC-cc')] },
];
const rows = ['pB-zed', 'pB-amy', 'pB1-aaa', 'pB1-lead', 'pA-bob', 'pA-wes', 'pDup', 'pA2-dup', 'pA1-cat', 'pA1-gone', 'pC-cc', 'pLoose'].map((paneid) => ({ paneid }));
const out = orderSeated(rows, rooms).map((x) => x.row.paneid);
ok(out.join() === 'pA-wes,pA-bob,pDup,pA1-cat,pA2-dup,pB-amy,pB-zed,pB1-lead,pB1-aaa', 'root name order; a root\'s own seats (lead first, then handle) before its groups (name order); lead first in a group', out);
ok(!out.includes('pLoose') && !out.includes('pC-cc') && !out.includes('pA1-gone'), 'unseated, closed-room and left seats are not ordered (the caller keeps them where they are)');
const idx = seatIndex(rooms);
ok(idx.get('pDup').groupName === null && seatLabel(idx.get('pDup')) === 'Alpha Root · @dup', 'a pane seated in a root AND a group answers the root', seatLabel(idx.get('pDup')));
ok(seatLabel(idx.get('pA1-cat')) === 'Alpha Root › Apps Group · @cat' && seatLabel(idx.get('pB-amy')) === 'Beta Root · @amy', 'label: "Root › Group · @handle" / "Root · @handle"');
ok(seatLabel(idx.get('pA2-dup')) === 'Alpha Root › Zeta Group · @dup' && seatLabel(idx.get('pB1-aaa')) === 'Beta Root › Studio · @aaa', 'the same handle in two families keeps each family\'s own root');
const tie = orderSeated([{ paneid: 'p2' }, { paneid: 'p1' }], [{ room: room('R', 'R'), seats: [seat('s1', 'same', 'p2'), seat('s2', 'same', 'p1')] }]).map((x) => x.row.paneid);
ok(tie.join() === 'p1,p2', 'ties by handle fall to pane id (stable)', tie);
const orphan = seatIndex([{ room: room('G', 'Orphan', 'GONE'), seats: [seat('s', 'h', 'p')] }]).get('p');
ok(orphan && seatLabel(orphan) === 'Orphan · @h', 'a group whose root is not listed stands as its own root');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
