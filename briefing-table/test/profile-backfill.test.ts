/**
 * ONE-OFF room-agent profile backfill (Owner 2026-10-03; engine/profile-backfill.ts).
 * Real store (temp db via HARBOR_WB_TABLE) + real listSessions over a fixture
 * transcript tree (HARBOR_WB_CLAUDE_PROJECTS). Covers: fill from the transcript,
 * skip-unreadable (row stays NULL, one log line), never-overwrite, rows that are
 * not seated in an OPEN room untouched, and idempotence. Run with tsx.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-pbf-'));
process.env.HARBOR_WB_TABLE = join(dir, 't.db');
const root = join(dir, 'projects');
process.env.HARBOR_WB_CLAUDE_PROJECTS = root;

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg} (got ${a}, wanted ${b})`);
  }
}

const store = await import('../src/table/store.ts');
const claudeCode = await import('../src/engine/vendors/claude-code.ts');
const { backfillProfiles, profileFromTranscript } = await import('../src/engine/profile-backfill.ts');

const PROJECT = '/srv/code/pbf-project';
const tdir = join(root, claudeCode.encodeProjectDir(PROJECT));
mkdirSync(tdir, { recursive: true });
const transcript = (sid: string, model: string | null, effort: string | null): void => {
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sid })];
  if (model) {
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [] }, perTurnEffort: effort, sessionId: sid }));
  }
  writeFileSync(join(tdir, `${sid}.jsonl`), lines.join('\n') + '\n');
};
const S = (n: number): string => `0000000${n}-0000-0000-0000-000000000000`;
transcript(S(1), 'claude-opus-5-5', 'xhigh'); // fill: family alias + known effort
transcript(S(2), 'claude-sonnet-5', 'bogus'); // fill: unknown effort -> ''
transcript(S(3), null, null); // no model -> skip
transcript(S(5), 'claude-haiku-4-5', 'low'); // seated in an ARCHIVED room only
transcript(S(6), 'claude-opus-5-5', 'high'); // not seated at all
transcript(S(7), 'claude-opus-5-5', 'max'); // already has a profile

const mk = (paneid: string, sid: string | null, extra: Partial<{ state: string; vendor: string; recipe_id: string | null }> = {}): void => {
  store.upsert({ paneid, server: 'local', vendor: extra.vendor ?? 'claude-code', agent: paneid, session_id: sid, state: (extra.state ?? 'live') as any, recipe_id: extra.recipe_id === undefined ? 'r1' : extra.recipe_id });
};
mk('p1', S(1));
mk('p2', S(2), { state: 'dehydrated' });
mk('p3', S(3));
mk('p4', S(4)); // transcript file missing
mk('p5', S(5));
mk('p6', S(6));
mk('p7', S(7));
mk('p8', S(1), { state: 'killed' }); // ended: not a target
mk('p9', S(1), { vendor: 'cli-manager' }); // not claude
store.setProfile('p7', { model: 'sonnet', effort: 'low' });

store.profileBackfillTargets(); // lazily creates the room tables
const Database = (await import('better-sqlite3')).default;
const db = new Database(process.env.HARBOR_WB_TABLE!);
db.exec(`INSERT INTO rooms (id,name,state,created_by,created_at,updated_at,last_active_at) VALUES ('ro','Open','open','t',1,1,1),('ra','Old','archived','t',1,1,1)`);
let pos = 0;
for (const [room, pane] of [['ro', 'p1'], ['ro', 'p2'], ['ro', 'p3'], ['ro', 'p4'], ['ra', 'p5'], ['ro', 'p7'], ['ro', 'p8'], ['ro', 'p9']]) {
  db.prepare(`INSERT INTO room_seats (id,room_id,handle,occupant_kind,occupant,position,added_by,added_at) VALUES (?,?,?,?,?,?,?,1)`).run(`s-${pane}`, room, `h${pos}`, 'pane', pane, pos++, 't');
}
db.close();

console.log('\n[targets]');
eq(store.profileBackfillTargets().map((t) => t.paneid).sort(), ['p1', 'p2', 'p3', 'p4'], 'only unprofiled claude-code occupants of OPEN rooms, live or dehydrated');

console.log('\n[profileFromTranscript]');
eq(profileFromTranscript({ model: 'claude-opus-5-5', effort: 'xhigh' }), { model: 'opus', effort: 'xhigh' }, 'full id -> family alias');
eq(profileFromTranscript({ model: 'claude-x-9', effort: null }), { model: 'claude-x-9', effort: '' }, 'unknown family kept as id, no effort -> ""');
eq(profileFromTranscript({ model: null, effort: 'high' }), null, 'no model -> nothing');

const lines: string[] = [];
const deps = (): Parameters<typeof backfillProfiles>[0] => ({
  targets: () => store.profileBackfillTargets(),
  list: async () => ({ rows: await claudeCode.listSessions({ projectDir: PROJECT, limit: 200 }) }),
  setIfUnset: (p, v) => store.setProfileIfUnset(p, v),
  log: (l) => lines.push(l),
});

console.log('\n[run]');
const res = await backfillProfiles(deps());
eq(res, { filled: 2, skipped: 2 }, '2 filled, 2 skipped');
eq(store.profileOf(store.get('p1')), { model: 'opus', effort: 'xhigh' }, 'p1 filled from the transcript');
eq(store.profileOf(store.get('p2')), { model: 'sonnet', effort: null }, 'p2 filled, unknown effort stored as default');
eq(store.profileOf(store.get('p3')), null, 'p3 (no model) stays NULL');
eq(store.profileOf(store.get('p4')), null, 'p4 (no transcript) stays NULL');
eq(lines.filter((l) => l.includes('skipped p3') || l.includes('skipped p4')).length, 2, 'one log line per skipped seat');
eq(lines.includes('profile backfill: 2 filled, 2 skipped'), true, 'summary line');
eq(store.profileOf(store.get('p5')), null, 'archived-room seat untouched');
eq(store.profileOf(store.get('p6')), null, 'unseated row untouched');
eq(store.profileOf(store.get('p7')), { model: 'sonnet', effort: 'low' }, 'existing profile never overwritten');
eq(store.profileOf(store.get('p8')), null, 'killed row untouched');
eq(store.profileOf(store.get('p9')), null, 'non-claude row untouched');

console.log('\n[idempotent + never overwrite]');
lines.length = 0;
const again = await backfillProfiles({ ...deps(), targets: () => store.profileBackfillTargets().filter((t) => ['p1', 'p2'].includes(t.paneid)) });
eq(again, { filled: 0, skipped: 0 }, 'filled rows are no longer targets');
const forced = await backfillProfiles({ ...deps(), targets: () => [{ paneid: 'p7', recipe_id: 'r1', session_id: S(7) }] });
eq(forced, { filled: 0, skipped: 1 }, 'a stale target list cannot overwrite a profile set meanwhile');
eq(store.profileOf(store.get('p7')), { model: 'sonnet', effort: 'low' }, 'p7 still its own profile');

console.log('\n[unreadable host]');
const bad = await backfillProfiles({ ...deps(), list: async () => ({ error: 'host unreachable' }) });
eq(bad.filled, 0, 'unreadable -> nothing filled');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
