/**
 * PHASE A LABELER [shape] (Owner 2026-10-07, room interface): engine/chatter.ts
 * shapeOf / shapeReport, report/watch only.
 *
 * FIRST MEASURED against 127 hand-labelled live room lines (2026-10-07; those lines were
 * the installation's own chat and are not shipped). test/fixtures/chatter-shape.json now holds 127
 * INVENTED lines of the same shapes; the numbers below are from the live set:
 *
 *   label    precision        recall
 *   action   1.00  (5/5)      0.45  (5/11)
 *   reply    0.88  (14/16)    0.64  (14/22)
 *   control  1.00  (10/10)    1.00  (10/10)
 *   ack      0.71  (10/14)    0.83  (10/12)
 *   status   0.83  (57/69)    0.97  (57/59)
 *   relay    0.70  (7/10)     0.70  (7/10)
 *   blast    1.00  (3/3)      1.00  (3/3)
 *   accuracy 0.83 (106/127)
 *
 * Where it is wrong: replies that do not open with yes/no/agreed read as status;
 * help asks without "please / can you" ("Trying: ...", "Small issue ...") read as
 * status; a person's instruction passed on ("Bug from Owner", "Owner's go: build ...")
 * reads as relay where the hand label said action; a lead re-telling a worker's
 * result without a relay phrase ("Astra's revised palm is ready") reads as status.
 * mustDeliver was NOT hand-labelled; it is unmeasured. The floors below pin today's
 * numbers so a change that makes the labeler worse fails here.
 * Run with tsx.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'wb-chatter-shape-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';

const chatter = await import('../src/engine/chatter.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => {
  if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); }
};
const eq = (a: unknown, b: unknown, m: string): void => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);
const shape = (body: string, target: string | null = 'x', author = 'a') => chatter.shapeOf({ body, author, target });

try {
  console.log('\n[labels]');
  eq(shape('Heads-up: the engine restarts in 3 minutes', null).label, 'blast', 'a heads-up is a blast');
  eq(shape('status please', 'room').label, 'blast', 'to @room is a blast');
  eq(shape('@op RUNNER CLEAR. Main b650908 adds a verb').label, 'control', 'runner state is control');
  eq(shape('@op Holding. No readings until you say so').label, 'control', 'holding is control');
  eq(shape('@op From Owner, in his words: "The palm has a large inflation."').label, 'relay', 'From Owner is a relay');
  eq(shape('@user Yes, that works and is harmless.').label, 'reply', 'yes ... is a reply');
  eq(shape('@op Ack. Noted the wrist overrides.').label, 'ack', 'Ack. is an ack');
  eq(shape('@op can you check the cuff fit?').label, 'action', 'a question is an action');
  eq(shape('@op The rerun passes the preservation check.').label, 'status', 'a report is status');

  console.log('\n[mustDeliver]');
  eq(shape('@op stop the run now').mustDeliver, true, 'control');
  eq(chatter.shapeOf({ body: 'look at this', author: 'user', target: 'x' }).mustDeliver, true, "the person's own line");
  eq(shape('@op From Owner, in his words: "halt"').mustDeliver, true, 'a relay of the person');
  eq(shape('@op could you export the hand').mustDeliver, true, 'a direct question');
  eq(shape('@op merged: main is c2b386f').mustDeliver, true, 'dependency done with a sha');
  eq(shape('@op delivered checkpoint 510').mustDeliver, true, 'dependency done with a checkpoint');
  eq(shape('@op the rerun looks fine overall').mustDeliver, false, 'a plain status is not must-deliver');
  eq(shape('@op Ack. Noted.').mustDeliver, false, 'an ack is not');

  console.log('\n[measured against 127 labelled rows: precision floors]');
  const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chatter-shape.json'), 'utf8'));
  eq(fx.rows.length, 127, '127 labelled rows');
  const pred: Record<string, number> = {};
  const tp: Record<string, number> = {};
  let right = 0;
  for (const r of fx.rows) {
    const got = chatter.shapeOf({ body: r.body, author: r.author, target: r.target }).label;
    pred[got] = (pred[got] ?? 0) + 1;
    if (got === r.label) {
      tp[got] = (tp[got] ?? 0) + 1;
      right++;
    }
  }
  const floors: Record<string, number> = { action: 1.0, reply: 0.87, control: 1.0, ack: 0.71, status: 0.82, relay: 0.7, blast: 1.0 };
  for (const l of chatter.SHAPE_LABELS) {
    const p = pred[l] ? (tp[l] ?? 0) / pred[l] : 0;
    ok(p >= floors[l], `${l} precision ${p.toFixed(2)} (${tp[l] ?? 0}/${pred[l] ?? 0}) >= ${floors[l]}`);
  }
  ok(right / fx.rows.length >= 0.83, `accuracy ${(right / fx.rows.length).toFixed(2)} >= 0.83`);

  console.log('\n[shapeReport: per room, seat and pair; an open ask makes the answer must-deliver]');
  const line = (id: number, author: string, body: string, target: string | null, room = 'r1') =>
    ({ id, room_id: room, room_name: room.toUpperCase(), ts: id, author, kind: 'chat', body, to_person: target === 'user' ? 1 : 0, target });
  const rep = chatter.shapeReport({
    lines: [
      line(1, 'lead', '@op can you check the cuff fit', 'op'),
      line(2, 'op', '@lead the cuff fit is within tolerance on both sides', 'lead'),
      line(3, 'op', '@lead the sleeve is also fine on the left', 'lead'),
      line(4, 'user', 'stop for today', null),
      line(5, 'op', '@lead Ack. Noted.', 'lead', 'r2'),
    ],
    xposts: [],
    fabricTurns: [{ paneid: 'p', slug: 'v3d', ts: 1, text: '[fabric · @lead-1 · ask · t:a · id:e1] can you rerun the bake?' }],
    events: [],
  });
  const pair = rep.pairs.find((p) => p.from === 'op' && p.to === 'lead')!;
  eq([pair.total, pair.status, pair.ack, pair.must_deliver], [3, 2, 1, 1], 'op -> lead: 3 lines, the first answer to the open ask must-deliver, the rest not');
  eq(rep.rooms.map((r) => [r.room_id, r.total]), [['r1', 3], ['r2', 1]], 'per room (the person is not counted as agent chatter)');
  eq([rep.dms.total, rep.dms.action, rep.dms.must_deliver], [1, 1, 1], 'a fabric DM frame is labelled too');
  ok(!rep.seats.some((s) => s.author === 'user'), 'no seat row for the person');
} catch (e) {
  failed++;
  console.log(`  X  threw: ${(e as Error).stack}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
