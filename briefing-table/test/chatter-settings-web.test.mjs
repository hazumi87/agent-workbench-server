/* AGENTS · CHATTER settings, web half [chatter] Owner 2026-10-06: the pure helpers of
 * web/settings-chatter.mjs and its place in the Settings menu. No DOM. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const M = await import(pathToFileURL(join(W, 'settings-chatter.mjs')).href);
let passed = 0;
let failed = 0;
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`  ok ${m}`);
  } else {
    failed++;
    console.log(`  X  ${m}`);
  }
};

ok(M.findingLine({ kind: 'to_person_ratio', room: { name: 'Asset Studio' }, value: 3.06, threshold: 3 }) === 'Asset Studio: 3.06 lines to you per line from you (limit 3)', 'a room ratio reads as words');
ok(M.findingLine({ kind: 'echo', room: { name: 'Asset Studio' }, seat: 'alpha-studio', value: 5, threshold: 0 }).startsWith('Asset Studio · @alpha-studio: 5 lead re-tellings'), 'a seat finding names the room and the seat');
ok(M.findingLine({ kind: 'dm_rate', pane: 'p1', value: 14, threshold: 6 }).includes('14 direct messages in one hour'), 'a pane finding');
ok(M.findingLine({ kind: 'new_kind', seat: 's', value: 1, threshold: 0 }).includes('1 new_kind'), 'an unknown kind still reads');
ok(JSON.stringify(M.quietCandidates({ quiet: ['a'], panes: [{ slug: 'a' }, { slug: 'video-to-3d' }, { slug: 'video-to-3d' }, {}] })) === '["video-to-3d"]', 'candidates: agents that got DMs, not already quiet, once each');
ok(JSON.stringify(M.quietCandidates(null)) === '[]', 'no report: no candidates');
const settings = readFileSync(join(W, 'settings.mjs'), 'utf8');
ok(settings.includes("{ id: 'chatter', title: 'Agents · chatter', module: '/settings-chatter.mjs', export: 'mountChatterSettings'"), 'the Settings menu mounts it');
const src = readFileSync(join(W, 'settings-chatter.mjs'), 'utf8');
ok(src.includes("call('PUT', '/api/chatter/quiet', { slug, quiet })") && src.includes("call('GET', '/api/chatter?hours=24')"), 'reads the report, writes the quiet switch');
ok(JSON.stringify(M.shapeRows({ shape: { rooms: [{ room_id: 'r1', name: 'Asset Studio', action: 2, status: 5, must_deliver: 3, total: 7 }] } })) === JSON.stringify([{ name: 'Asset Studio', counts: [2, 0, 0, 0, 5, 0, 0], mustDeliver: 3, total: 7 }]), '[shape] a room row: counts per label in column order, must-deliver');
ok(JSON.stringify(M.shapeRows(null)) === '[]' && M.SHAPE_COLS.join() === 'action,reply,control,ack,status,relay,blast', '[shape] no report: no rows; the seven labels');
ok(src.includes('Message shape, last 24 hours') && /\.chs-shape \{ overflow-x: auto/.test(readFileSync(join(W, 'settings-chatter.css'), 'utf8')), '[shape] the table is drawn and scrolls sideways on its own on a phone');
console.log(`PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
