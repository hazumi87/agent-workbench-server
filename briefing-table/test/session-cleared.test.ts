/* session-cleared: detecting a /clear in a seated agent's CLI (Owner 2026-10-03,
 *). Pure coordination + the store lifecycle.
 * The interesting assertions are the REFUSALS: a wrong badge is noise, so every
 * ambiguous shape is asserted to flag nothing. The HTTP/payload half is in
 * seat-reload.test.mjs. SAFETY: temp db via HARBOR_WB_TABLE; run with tsx. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'wb-cleared-'));
const DB = join(dir, 't.db');
process.env.HARBOR_WB_TABLE = DB;

let pass = 0;
let fail = 0;
const ok = (c: boolean, l: string, d?: string) => {
  console.log(`${c ? '  ✓' : '  ✗'} ${l}${d ? `  (${d})` : ''}`);
  c ? pass++ : fail++;
};

const { planCleared } = await import('../src/engine/session-cleared.ts');
const store = await import('../src/table/store.ts');

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const S = '11111111-1111-1111-1111-111111111111';
const T = '22222222-2222-2222-2222-222222222222';
const T2 = '33333333-3333-3333-3333-333333333333';
let LISTINGS: any[] = [];
const L = (id: string, ageMin: number, firstCommand: string | null = null) => ({
  sessionId: id, title: null, lastPrompt: null, firstCommand, mtimeMs: NOW - ageMin * MIN, sizeBytes: 1, branch: null, model: null, effort: null,
});
let SPOKE: (p: string) => number | undefined = () => NOW - 2 * MIN;
const plan = (rows: any[]) => planCleared(rows, () => LISTINGS, SPOKE);
const pane = (paneid: string, session_id: string | null, over: any = {}) => ({ paneid, recipe_id: 'R', session_id, state: 'live', vendor: 'claude-code', ...over });

console.log('\n[planCleared: positive case]');
LISTINGS = [L(S, 30), L(T, 2, '/clear')];
let out = plan([pane('p1', S)]);
ok(out.length === 1 && out[0].paneid === 'p1' && out[0].to === T, 'a /clear transcript newer than the banked one, written while the pane spoke: flagged');

console.log('\n[planCleared: refusals (never a guess)]');
ok(plan([pane('p1', S, { cleared_at: 5 })]).length === 0, 'already flagged: left alone');
LISTINGS = [L(S, 30), L(T, 2, null)];
ok(plan([pane('p1', S)]).length === 0, 'a new transcript that does NOT open with /clear: no flag (that is adoption\'s case)');
LISTINGS = [L(S, 30), L(T, 2, '/clear')];
SPOKE = () => undefined;
ok(plan([pane('p1', S)]).length === 0, 'no record of the pane\'s output: no evidence, no flag');
SPOKE = () => NOW - 120 * MIN;
ok(plan([pane('p1', S)]).length === 0, 'the pane was silent when the file was written (another writer in the dir): no flag');
SPOKE = () => NOW - 2 * MIN;
LISTINGS = [L(S, 30), L(T, 40, '/clear')];
ok(plan([pane('p1', S)]).length === 0, 'a /clear transcript OLDER than the banked file: no flag');
LISTINGS = [L(T, 2, '/clear')];
ok(plan([pane('p1', S)]).length === 0, 'the banked file is not in the listing: cannot compare, no flag');
LISTINGS = [L(S, 30), L(T, 2, '/clear')];
ok(plan([pane('p1', S), pane('p2', T, { state: 'dehydrated' })]).length === 0, 'a transcript another pane (even dehydrated) banks is not a candidate');
LISTINGS = [L(S, 30), L(T, 2, '/clear'), L(T2, 2, '/clear')];
ok(plan([pane('p1', S)]).length === 0, 'two plausible /clear transcripts: ambiguous, no flag');
LISTINGS = [L(S, 30), L(T, 2, '/clear')];
ok(plan([pane('p1', S), pane('p2', S)]).length === 0, 'two panes both wanting the same transcript: neither flagged');
ok(plan([pane('p1', S, { vendor: 'cli-manager' })]).length === 0, 'a non-claude pane is ignored');
ok(plan([pane('p1', S, { cleared_to: T })]).length === 0, 'the /clear the person already dismissed is not flagged again');
ok(plan([pane('p1', S, { cleared_to: T2 })]).length === 1, '...but a different (second) /clear is');

console.log('\n[store lifecycle]');
const old = new Database(DB);
old.exec(`CREATE TABLE sessions (paneid TEXT PRIMARY KEY, server TEXT NOT NULL, vendor TEXT NOT NULL, agent TEXT, session_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('live','dehydrated','killed','corrupted')), updated_at INTEGER NOT NULL);
  INSERT INTO sessions VALUES ('recipe:legacy','local','claude-code','legacy','${S}','live',1);`);
old.close();
const row = (p: string) => store.get(p) as any;
ok(row('recipe:legacy').cleared_at === null && row('recipe:legacy').cleared_to === null, 'additive migration: an old row gains NULL columns');
store.markCleared('recipe:legacy', T, 1234);
ok(row('recipe:legacy').cleared_at === 1234 && row('recipe:legacy').cleared_to === T, 'markCleared sets the flag');
store.markCleared('recipe:legacy', T2, 9999);
ok(row('recipe:legacy').cleared_at === 1234, 'a second mark does not overwrite the first');
store.dismissCleared('recipe:legacy');
ok(row('recipe:legacy').cleared_at === null && row('recipe:legacy').cleared_to === T, 'dismiss clears the flag and remembers which /clear');
store.markCleared('recipe:legacy', T, 5);
store.adoptSessionId('recipe:legacy', T);
ok(row('recipe:legacy').cleared_at === null && row('recipe:legacy').session_id === T, 'adoption onto the new conversation clears the flag');
store.markCleared('recipe:legacy', T2, 6);
ok(row('recipe:legacy').cleared_at === 6, 'flagged again (a new /clear)');
store.upsert({ paneid: 'recipe:legacy', server: 'local', vendor: 'claude-code', agent: 'legacy', session_id: 'fresh', state: 'live', recipe_id: 'R' });
ok(row('recipe:legacy').cleared_at === null && row('recipe:legacy').cleared_to === null, 'a fresh live spawn (mint / reload) clears flag and memory');

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* Windows: the store's own handle still holds the db open (EPERM); the temp dir is left behind */
}
console.log(`\nPASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
