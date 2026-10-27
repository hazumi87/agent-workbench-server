/**
 * AN AGENT'S {model, effort} PROFILE TRAVELS WITH IT (Owner 2026-10-02, room
 * line 3245). Pure + store: the additive migration, the mint snapshot, the
 * relaunch precedence (stored beats url override beats recipe), and that a
 * recipe default changed AFTER the mint cannot change the relaunch command
 * line — including the room-reconnect shape (a relaunch that sends no
 * override). The HTTP half (PATCH route) is recipe-effort-routes.test.mjs.
 *
 * SAFETY: temp db via HARBOR_WB_TABLE, set before the store is imported. Run
 * with tsx.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'wb-profile-'));
const DB = join(dir, 'legacy.db');
process.env.HARBOR_WB_TABLE = DB;

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (got ${a}, wanted ${b})`);
  }
}

// A db written by an engine that predates the columns.
const old = new Database(DB);
old.exec(`CREATE TABLE sessions (paneid TEXT PRIMARY KEY, server TEXT NOT NULL, vendor TEXT NOT NULL, agent TEXT, session_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('live','dehydrated','killed','corrupted')), updated_at INTEGER NOT NULL);
  INSERT INTO sessions VALUES ('recipe:legacy','local','claude-code','legacy','11111111-1111-1111-1111-111111111111','dehydrated',1);`);
old.close();

const store = await import('../src/table/store.ts');
const { resolveLaunchProfile } = await import('../src/engine/effort.ts');
const claudeCode = await import('../src/engine/vendors/claude-code.ts');
const flags = (cmd: string | undefined): string => (cmd ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>');
const recipe = (over: Record<string, unknown>) =>
  ({ id: 'r1', name: 'T', target: 'local', projectDir: '/tmp/p', vendor: 'claude-code', agent: 't', runClaude: 1, model: null, effort: null, resume: 0, resumeName: null, ...over }) as any;

console.log('\n[migration: additive, idempotent, legacy rows read as "no profile"]');
const legacy = store.get('recipe:legacy') as any;
eq([legacy.profile_model, legacy.profile_effort], [null, null], 'an old row gains NULL profile columns');
eq(store.profileOf(legacy), null, '...and reads as no profile');
eq(store.get('recipe:legacy')?.session_id, '11111111-1111-1111-1111-111111111111', 'existing data untouched');

console.log('\n[mint snapshot]');
store.upsert({ paneid: 'recipe:a', server: 'local', vendor: 'claude-code', agent: 'a', session_id: 'u1', state: 'live', recipe_id: 'r1' });
eq(store.profileOf(store.get('recipe:a')), null, 'an upsert alone writes no profile');
const minted = resolveLaunchProfile(store.get('recipe:a'), recipe({ model: 'sonnet', effort: 'low' }), { effort: 'max' });
eq(minted, { model: 'sonnet', effort: 'max', write: true }, 'no profile: override beats recipe, and it is to be written');
store.setProfile('recipe:a', minted);
eq(store.profileOf(store.get('recipe:a')), { model: 'sonnet', effort: 'max' }, 'banked on the row');
store.setProfile('recipe:a', { model: null, effort: null });
eq(store.profileOf(store.get('recipe:a')), { model: null, effort: null }, "a snapshotted default reads {null,null}, not 'no profile'");
store.setProfile('recipe:a', { model: 'sonnet', effort: 'max' });
store.upsert({ paneid: 'recipe:a', server: 'local', vendor: 'claude-code', agent: 'a', session_id: 'u1', state: 'dehydrated', recipe_id: 'r1' });
eq(store.profileOf(store.get('recipe:a')), { model: 'sonnet', effort: 'max' }, 'a re-upsert (re-attach / adopt) never overwrites the profile');

console.log('\n[precedence]');
const cur = recipe({ model: 'opus', effort: 'high' }); // the project default CHANGED after the mint
const stored = resolveLaunchProfile(store.get('recipe:a'), cur, { model: 'fable', effort: 'low' });
eq(stored, { model: 'sonnet', effort: 'max', write: false }, 'stored beats a url override AND the changed recipe default');
const reconnect = resolveLaunchProfile(store.get('recipe:a'), cur, {});
const runRecipe = { ...cur, model: reconnect.model, effort: reconnect.effort };
eq(
  claudeCode.buildInvocation(runRecipe, { remote: false, resumeSessionId: 'u1' })?.cmd,
  'claude --model sonnet --effort max --resume u1',
  'room reconnect (no override) relaunches on the stored profile, not the changed default',
);
eq(flags(claudeCode.buildInvocation({ ...cur, ...resolveLaunchProfile(undefined, cur, {}) }, { remote: false })?.cmd), 'claude --model opus --effort high --session-id <uuid>', 'a brand-new mint takes the recipe current default');
const lg = resolveLaunchProfile(store.get('recipe:legacy'), cur, { effort: 'medium' });
eq(lg, { model: 'opus', effort: 'medium', write: true }, 'legacy row: url override beats the recipe and is written');
eq(resolveLaunchProfile(store.get('recipe:legacy'), cur, {}), { model: 'opus', effort: 'high', write: true }, 'legacy row, no override: today\'s recipe default, snapshotted');
store.setProfile('recipe:a', { model: 'sonnet', effort: 'max' });
store.setState('recipe:a', 'killed');
eq(resolveLaunchProfile(store.get('recipe:a'), cur, {}), { model: 'opus', effort: 'high', write: true }, 'an ENDED (killed) pane restarts as a fresh mint');
store.setProfile('recipe:a', { model: null, effort: null });
store.setState('recipe:a', 'dehydrated');
eq(resolveLaunchProfile(store.get('recipe:a'), cur, { model: 'fable' }), { model: null, effort: null, write: false }, "a stored 'default' stays default (not reset to the recipe)");

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* Windows: the store's own handle still holds the db open (EPERM); the temp dir is left behind */
}
console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
